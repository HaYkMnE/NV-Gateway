import http from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import { handleAdminRequest } from "./admin-api.mjs";
import { getNextKey, getKeys, handleKeyError, markKeyUsedAndDebounceSave, initializeState, getSoonestActiveCooldownRemainingSeconds, getModelEligibleKeyCount, getRetryAfterSecondsForModel } from "./rotation.mjs";
import { info, warn, error, flushLogs } from "./logger.mjs";
import { sanitizeProxyHeaders, capResponseHeaders } from "./proxy-headers.mjs";
import { createUpstreamSocketTimeouts, resolveRetryFirstByteTimeoutMs } from "./upstream-timeouts.mjs";
import { getModelLimits, getDisabledModels, setModelLimits } from "./model-limits.mjs";
import { getCapabilityMetadata } from "./capability-registry.mjs";
import { classifyUpstreamResponse, isPoolWideCapableStatus, isSuccessfulStatus, parseRetryAfter, RATE_LIMIT_STATUS, resolveMaxFailoverAttempts, resolvePoolWideFailureStatus, resolveRateLimitMaxAttempts, shouldEarlyStopOnRateLimit } from "./failover-policy.mjs";
import { createBoundedBuffer, resolveMaxBufferedResponseBytes } from "./bounded-buffer.mjs";
import { flushState } from "./rotation.mjs";
import { classifyGatewayRoute, isAllowedOrigin, isBearerAuthorized, parseCorsAllowlist } from "./security.mjs";
import { translateAnthropicRequest, translateAnthropicResponse, translateAnthropicSseStream } from "./anthropic-adapter.mjs";
import { pathnameOnly, setRuntimeSecrets } from "../shared/redaction.mjs";
import crypto from "node:crypto";
import { getCachedModels, refreshModels } from "./model-discovery.mjs";
import { createDirectGlmProbeScheduler, runDirectGlmProbe, shouldScheduleDirectGlmProbe } from "./direct-glm-probe.mjs";
import { mergeProbedReasoning, scheduleCapabilityRefresh } from "./capability-probe.mjs";
import { createPerformanceModeResolver, readPerModelFailoverAttempts, readPerModelRateLimitAttempts } from "./performance-mode.mjs";

const NVIDIA_API = "integrate.api.nvidia.com";
let LOCAL_TOKEN;
let ADMIN_TOKEN;
const CORS_ALLOWLIST = parseCorsAllowlist(process.env.GATEWAY_CORS_ALLOWLIST);
// Upstream request timeouts are OWNED by the performance-mode resolver below:
// the selected profile (day/night/auto) supplies the base values and explicit
// GATEWAY_* env vars override them per knob inside resolve(). They are resolved
// PER REQUEST (see resolveRequestTimeouts) so an "auto" transition applies to
// the next request and cannot shift mid-request across failover attempts.
// (resolveGatewayTimeouts in upstream-timeouts.mjs is the env-only parser kept
// for its own unit tests; the runtime request path no longer consults it.)

// Performance-mode resolver (global day/night/auto profile + env overrides).
// Supplies the per-request upstream timeouts and the configured
// maxFailoverAttempts bound the failover loops honor; real request outcomes
// feed it via observe() (see recordOutcome) so "auto" can actually transition.
const performanceMode = createPerformanceModeResolver({
    // Log effective-profile transitions so an "auto" decision is auditable from
    // the gateway log (the payload carries the evidence window that drove it).
    onEffectiveChange: (state) => info("performance_mode_transition", state)
});

// Resolve THIS request's upstream timeout profile from the performance-mode
// resolver (profile base + GATEWAY_* env overrides, per knob). Called once per
// request by the failover loop so every attempt of one request uses the same
// budget; proxyRequest falls back to a fresh resolution only for a stand-alone
// caller that did not pass timeouts in opts.
// Retried failover attempts (attempt > 1 after a 429/5xx) use a shorter
// first-byte window so a hung / slow-to-429 upstream cannot stall each key
// switch for the full fresh-request budget. min() in
// resolveRetryFirstByteTimeoutMs keeps it <= firstByte AND <=
// GATEWAY_RETRY_FIRST_BYTE_TIMEOUT_MS (default 30s). The first attempt keeps
// the full fresh-request window so a legitimately slow NVIDIA response is still
// tolerated on a fresh request.
function resolveRequestTimeouts() {
    const profile = performanceMode.resolve();
    return {
        firstByteTimeoutMs: profile.firstByteTimeoutMs,
        idleTimeoutMs: profile.idleTimeoutMs,
        maxStreamDurationMs: profile.maxStreamDurationMs,
        retryFirstByteTimeoutMs: resolveRetryFirstByteTimeoutMs(profile.firstByteTimeoutMs)
    };
}
// In production the gateway child receives GATEWAY_CONFIG_PATH (config always
// exists via ensureGatewayRuntime); in tests/dev it is unset, so no configured
// bound is present and the failover loops fall back to covering the active pool.
const hasGatewayConfig = typeof process.env.GATEWAY_CONFIG_PATH === "string" && process.env.GATEWAY_CONFIG_PATH.length > 0;

// Resolve the configured failover-attempts bound for a model: per-model override
// (config.perModelSettings[model].maxFailoverAttempts) wins over the global
// performance profile. Returns undefined when no config is present (caller falls
// back to pool-derived coverage).
function resolveConfiguredMaxFailoverAttempts(modelId) {
    if (!hasGatewayConfig) return undefined;
    const perModel = readPerModelFailoverAttempts(modelId);
    if (perModel !== null) return perModel;
    return performanceMode.resolve().maxFailoverAttempts;
}

// Resolve the configured uniform-429 confirming-attempt bound for a model. Only a
// PER-MODEL config entry participates: the global performance profile deliberately
// has no rate-limit knob, because the ceiling on useful 429 retries is a property
// of how NVIDIA scopes the limit (per model), not of a day/night speed trade-off.
// Returns undefined when no config is present, leaving the default (2) in force.
function resolveConfiguredRateLimitMaxAttempts(modelId) {
    if (!hasGatewayConfig) return undefined;
    return readPerModelRateLimitAttempts(modelId) ?? undefined;
}

// Per-request tracking of the current-attempt inbound "close"/"aborted" handlers.
// Each failover attempt attaches a fresh pair to the SAME inbound request; without
// cleanup they accumulate (2 × maxAttempts) and trip MaxListenersExceededWarning,
// and each stale closure would also keep a dead upstream attempt alive. Only the
// latest attempt's pair stays attached.
const funnelAbortHandlers = new WeakMap();
let isReady = false;
const ipcChallenge = crypto.randomBytes(32).toString("base64url");
const directGlmProbeScheduler = createDirectGlmProbeScheduler({
    probe: () => runDirectGlmProbe({
        envValue: process.env.NV_GATEWAY_DIRECT_GLM_PROBE,
        keyRecords: getKeys(),
        logger: (outcome) => info("direct_glm_probe", outcome)
    }),
    logger: (outcome) => info("direct_glm_probe", outcome)
});
if (typeof process.send === "function") {
process.on("message", (message) => {
    if (message?.type === "state:init") {
        if (message.challenge !== ipcChallenge) return;
        initializeState(message.state);
        LOCAL_TOKEN = message.state?.credentials?.gatewayToken;
        ADMIN_TOKEN = message.state?.credentials?.adminToken;
        // Model limits ride the SAME bound channel inside `state` as a
        // numbers-only Record<string,{context,output}> attached by the main
        // process (no secrets, no paths — sanitized on both sides). Injected
        // entries win over file/env resolution (which is absent when packaged).
        setModelLimits(message.state?.modelLimits);
        setRuntimeSecrets([LOCAL_TOKEN, ADMIN_TOKEN]);
        if (shouldScheduleDirectGlmProbe({
            message,
            expectedChallenge: ipcChallenge,
            envValue: process.env.NV_GATEWAY_DIRECT_GLM_PROBE
        })) directGlmProbeScheduler.schedule(true);
    }
});
process.send({ type: "ready", challenge: ipcChallenge });
}

const MAX_BUFFERED_RESPONSE_BYTES = resolveMaxBufferedResponseBytes();

// Background model refresh every 24 hours
const modelsRefreshInterval = setInterval(() => {
    refreshModels().catch(err => warn("Background model refresh failed", { error: err.message }));
}, 24 * 60 * 60 * 1000);
modelsRefreshInterval.unref();

function poolWideFailureMessage(statusCode) {
    if (statusCode === 429) return "Upstream rate limit: every available key is currently rate-limited.";
    if (statusCode === 500) return "Upstream error: every available key returned an internal server error (500).";
    if (statusCode === 502) return "Upstream error: every available key returned a bad gateway (502).";
    if (statusCode === 503) return "Upstream error: every available key is unavailable (503).";
    if (statusCode === 504) return "Upstream error: every available key timed out (504).";
    return "Upstream returned HTTP " + statusCode + " for every available key.";
}

// Propagate a pool-wide upstream status (every attempted key returned the SAME
// retryable status) instead of a generic 502. For 429 we supply our own
// Retry-After (NVIDIA sends none) so clients can honor a sane backoff. Non-429
// statuses (e.g. 500 with a non-NVCF signature) are passed through as-is.
function writePoolWideFailure(res, statusCode, responseMode, retryAfterSeconds) {
    const message = poolWideFailureMessage(statusCode);
    const headers = { "Content-Type": "application/json" };
    if (statusCode === 429) {
        const retryAfter = Math.max(1, Math.min(60, Math.ceil(Number(retryAfterSeconds) || 0)));
        headers["Retry-After"] = String(retryAfter);
    }
    if (responseMode === "anthropic") {
        const errorType = statusCode === 429 ? "rate_limit_error" : (statusCode >= 500 ? "overloaded_error" : "api_error");
        res.writeHead(statusCode, headers);
        res.end(JSON.stringify({ type: "error", error: { type: errorType, message } }));
        return;
    }
    res.writeHead(statusCode, capResponseHeaders(headers));
    res.end(JSON.stringify({ error: message }));
}

function proxyRequestWithFailover(req, res, bodyBuffer, isStream, onKeyIdChange, opts = {}) {
    return new Promise((resolve) => {
        let attempt = 0;
        const activeCount = getKeys().filter((k) => k.status === "active").length;
        const requestedModelId = typeof opts.model === "string" ? opts.model : undefined;
        const maxAttempts = resolveMaxFailoverAttempts(process.env, activeCount, resolveConfiguredMaxFailoverAttempts(requestedModelId));
        // Per-request upstream timeout profile (day/night/auto + GATEWAY_* env
        // overrides), resolved once so a mid-request "auto" transition can never
        // change the budget between failover attempts of THIS request.
        const requestTimeouts = resolveRequestTimeouts();
        // Status code seen on every retryable UPSTREAM HTTP failure, in order.
        // Used to detect a pool-wide failure (all keys returning the same real
        // upstream status) at the exhaustion point so the upstream status is
        // propagated instead of a generic 502. Gateway-side synthetic failures
        // (timeouts/socket errors/SSE errors) are excluded; individual/mixed
        // failures keep the existing behavior.
        const seenFailedStatuses = [];
        // Distinct keys already attempted, so pool-wide coverage is judged on real
        // key coverage rather than on the attempt counter (which may exceed or
        // undershoot the pool size depending on the configured bound).
        const attemptedKeyIds = new Set();

        // A pool-wide verdict requires: every recorded upstream failure carried the
        // SAME status, that status can describe the whole pool (not a per-key signal
        // such as 401/403 or an NVCF dispatch 404), and enough DISTINCT keys were
        // tried to cover the reachable portion of the pool (bounded by maxAttempts).
        // Returns null otherwise. See resolvePoolWideFailureStatus in failover-policy.mjs.
        const poolWideVerdict = () => resolvePoolWideFailureStatus(seenFailedStatuses, attemptedKeyIds.size, maxAttempts, activeCount);

        // Confirming attempts required before a UNIFORM 429 is answered honestly.
        // NVIDIA scopes a 429 to the MODEL, so every key answers the same way and
        // covering the pool cannot succeed — see the note in failover-policy.mjs.
        const rateLimitMaxAttempts = resolveRateLimitMaxAttempts(process.env, resolveConfiguredRateLimitMaxAttempts(requestedModelId));

        // Keys allowed for THIS model at the start of the request (globally
        // available and not cooling down for it). Captured once so the bound
        // reflects the pool the model started with, not the keys this very
        // request has since parked. undefined for model-less callers.
        const modelEligibleKeyCount = getModelEligibleKeyCount(requestedModelId);

        const tryNext = () => {
            // Two independent early-stop reasons, both requiring at least one attempt:
            //  - rateLimitStop: every upstream answer so far was 429 and enough keys
            //    have confirmed it. Fires REGARDLESS of pool coverage, which is the
            //    point: with 15 keys the coverage test would otherwise walk all 15.
            //  - coverageVerdict: the pre-existing rule — every attempted key returned
            //    the SAME pool-wide-capable status and the reachable pool is covered.
            //    Still the only early stop for 500/502/503/504/529.
            // Confirming attempts are bounded by the keys this MODEL may use, so
            // the verdict is never declared before its own eligible keys (sticky
            // key first) have answered. Model-less callers pass undefined and
            // keep the historical pool-wide rule.
            const rateLimitStop = attempt > 0 && shouldEarlyStopOnRateLimit(seenFailedStatuses, rateLimitMaxAttempts, modelEligibleKeyCount);
            const coverageVerdict = attempt > 0 ? poolWideVerdict() : null;
            if (attempt >= maxAttempts || coverageVerdict !== null || rateLimitStop) {
                // A uniform-429 stop IS a pool-wide verdict about this model, so the
                // honest 429 is emitted through the same writePoolWideFailure path
                // (consistent Retry-After and log shape) even though key coverage is
                // deliberately incomplete.
                const poolWideStatus = rateLimitStop ? RATE_LIMIT_STATUS : poolWideVerdict();
                error("All failover attempts exhausted", {
                    attempts: attempt,
                    poolWide: poolWideStatus !== null,
                    upstreamStatus: poolWideStatus,
                    // Distinguishes "stopped because the pool's answer is already
                    // established" from "ran out of the configured attempt budget".
                    earlyStop: (rateLimitStop || coverageVerdict !== null) && attempt < maxAttempts,
                    // Which rule ended the loop, so an honest 429 stays diagnosable.
                    earlyStopReason: rateLimitStop ? "uniform_rate_limit" : (coverageVerdict !== null && attempt < maxAttempts ? "pool_coverage" : undefined),
                    rateLimitMaxAttempts,
                    keysTried: attemptedKeyIds.size,
                    activeKeys: activeCount
                });
                if (!res.headersSent) {
                    if (poolWideStatus !== null) {
                        // Model-scoped Retry-After: for a model-wide 429 wave the honest
                        // wait is when THIS model's keys come back, not the pool's.
                        writePoolWideFailure(res, poolWideStatus, opts.responseMode, getRetryAfterSecondsForModel(requestedModelId));
                    } else {
                        const retryAfter = String(getRetryAfterSecondsForModel(requestedModelId));
                        if (opts.responseMode === "anthropic") {
                            res.writeHead(502, { "Content-Type": "application/json", "Retry-After": retryAfter });
                            res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "All failover attempts exhausted" } }));
                        } else {
                            res.writeHead(502, capResponseHeaders({ "Content-Type": "application/json", "Retry-After": retryAfter }));
                            res.end(JSON.stringify({ error: "All failover attempts exhausted" }));
                        }
                    }
                }
                resolve({ success: false });
                return;
            }

            // PER-MODEL selection: the model reuses its own sticky key, skips keys
            // cooling down for it, and prefers a key no other active model holds.
            const key = getNextKey(requestedModelId);
            if (!key) {
                warn("No available keys to service request");
                if (!res.headersSent) {
                    const retryAfter = String(getRetryAfterSecondsForModel(requestedModelId));
                    if (opts.responseMode === "anthropic") {
                        res.writeHead(503, { "Content-Type": "application/json", "Retry-After": retryAfter });
                        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "All API keys exhausted" } }));
                    } else {
                        res.writeHead(503, capResponseHeaders({ "Content-Type": "application/json", "Retry-After": retryAfter }));
                        res.end(JSON.stringify({ error: "All API keys exhausted" }));
                    }
                }
                resolve({ success: false });
                return;
            }

            attempt++;
            attemptedKeyIds.add(key.id);
            if (onKeyIdChange) onKeyIdChange(key.id);

            proxyRequest(req, res, key, bodyBuffer, isStream, (result) => {
                if (result.success || !result.retryable) {
                    resolve(result);
                } else {
                    // Only REAL upstream HTTP statuses (reason prefixed "http_")
                    // participate in pool-wide detection. Gateway-side synthetic
                    // failures — first-byte timeout (504), socket hang-up (502),
                    // SSE error (500) — are NOT an upstream decision and must not
                    // be mistaken for the pool having returned one status.
                    if (typeof result.reason === "string" && result.reason.startsWith("http_") && Number.isInteger(result.statusCode)) {
                        seenFailedStatuses.push(result.statusCode);
                    }
                    warn("Retrying with different key", {
                        attempt,
                        maxAttempts,
                        reason: result.reason
                    });
                    tryNext();
                }
            }, attempt > 1
                ? { ...opts, ...requestTimeouts, firstByteTimeoutMs: requestTimeouts.retryFirstByteTimeoutMs }
                : { ...opts, ...requestTimeouts });
        };

        tryNext();
    });
}

const MAX_SSE_FRAME_CHARS = 64 * 1024;

function safeSseField(value) {
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)) return value;
    return undefined;
}

function safeModelId(value) {
    return typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value) ? value : undefined;
}

function safeStatusCode(value) {
    const numericValue = typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : value;
    return Number.isInteger(numericValue) && numericValue >= 100 && numericValue <= 599 ? numericValue : undefined;
}

// Build an Anthropic-shaped error envelope for an upstream OpenAI error
// response (non-2xx). Maps the OpenAI status to an Anthropic error type and
// extracts the upstream message string from a best-effort parse of the body.
// Used only on the anthropic facade path so the error shape always matches
// Anthropic's error envelope (security constraint §6e#3).
function buildAnthropicUpstreamError(statusCode, upstreamBody) {
    let errorType = "api_error";
    if (statusCode === 401 || statusCode === 403) errorType = "authentication_error";
    else if (statusCode === 404) errorType = "not_found_error";
    else if (statusCode === 429) errorType = "rate_limit_error";
    else if (statusCode === 413 || statusCode === 400 || statusCode === 422) errorType = "invalid_request_error";
    else if (statusCode === 503 || statusCode === 529) errorType = "overloaded_error";

    let message = `Upstream returned status ${statusCode}`;
    if (upstreamBody) {
        try {
            const parsed = JSON.parse(upstreamBody);
            const candidate = parsed?.error?.message || parsed?.message;
            if (typeof candidate === "string" && candidate.trim()) message = candidate;
        } catch {
            if (typeof upstreamBody === "string" && upstreamBody.trim()) {
                message = upstreamBody.slice(0, 1000);
            }
        }
    }
    return { type: "error", error: { type: errorType, message } };
}

function createSseObserver(onErrorEvent) {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let discardingOversizedFrame = false;
    let sawDone = false;

    const inspectFrame = (frame) => {
        const lines = frame.split(/\r?\n/);
        const eventIsError = lines.some((line) => /^event:\s*error\s*$/i.test(line));
        const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");

        if (data.trim() === "[DONE]") {
            sawDone = true;
            return;
        }

        let parsed;
        try {
            parsed = JSON.parse(data);
        } catch {
            // Non-JSON SSE data is valid and must remain opaque to the gateway.
        }

        if (eventIsError || (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed)) {
            const upstreamError = parsed && typeof parsed.error === "object" && parsed.error !== null
                ? parsed.error
                : {};
            onErrorEvent({
                upstreamCode: safeSseField(upstreamError.code),
                upstreamType: safeSseField(upstreamError.type),
                upstreamStatusCode: safeStatusCode(upstreamError.status_code ?? upstreamError.status)
            });
        }
    };

    const consume = (text) => {
        let remaining = text;

        while (remaining.length > 0) {
            if (discardingOversizedFrame) {
                const separator = /\r?\n\r?\n|\r\r/.exec(remaining);
                if (!separator) return;
                remaining = remaining.slice(separator.index + separator[0].length);
                discardingOversizedFrame = false;
                continue;
            }

            const available = MAX_SSE_FRAME_CHARS - pending.length;
            if (available === 0) {
                pending = "";
                discardingOversizedFrame = true;
                continue;
            }

            pending += remaining.slice(0, available);
            remaining = remaining.slice(available);

            while (pending.length > 0) {
                const separator = /\r?\n\r?\n|\r\r/.exec(pending);
                if (!separator) {
                    break;
                }

                const frame = pending.slice(0, separator.index);
                pending = pending.slice(separator.index + separator[0].length);
                inspectFrame(frame);
            }

            if (pending.length === MAX_SSE_FRAME_CHARS) {
                pending = "";
                discardingOversizedFrame = true;
            }
        }
    };

    return {
        observe(chunk) {
            consume(decoder.write(chunk));
        },
        end() {
            consume(decoder.end());
        },
        get sawDone() {
            return sawDone;
        }
    };
}

function checkFirstChunkForSseError(chunk) {
    if (!chunk) return false;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const trimmed = text.trim();
    if (!trimmed) return false;

    const lines = text.split(/\r?\n/);
    if (lines.some((line) => /^event:\s*error\s*$/i.test(line))) {
        return true;
    }

    const dataLines = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
    const data = dataLines.join("\n").trim();

    if (data && data !== "[DONE]") {
        try {
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                if ("error" in parsed) return true;
                if (parsed.code === 500 || parsed.code === "500" || parsed.type === "internal_server_error") return true;
                if (typeof parsed.type === "string" && parsed.type.toLowerCase().includes("error")) return true;
            }
        } catch {
        }
    }

    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            if ("error" in parsed) return true;
            if (parsed.code === 500 || parsed.code === "500" || parsed.type === "internal_server_error") return true;
            if (typeof parsed.type === "string" && parsed.type.toLowerCase().includes("error")) return true;
        }
    } catch {
    }

    return false;
}

// Detach the inbound "close"/"aborted" pair registered for the CURRENT attempt on
// this request, if any. Called when an attempt settles RETRYABLY (the failover loop
// is about to re-enter proxyRequest on the same `req`), so listeners never
// accumulate across attempts and no stale closure survives over a dead attempt.
// NOT called on success: on the passthrough path onResult({success:true}) fires
// BEFORE the body is piped, so the client-abort handler must stay attached for the
// whole streaming window.
function detachFunnelAbortHandlers(req) {
    const handlers = funnelAbortHandlers.get(req);
    if (!handlers) return false;
    req.removeListener("close", handlers.close);
    req.removeListener("aborted", handlers.aborted);
    funnelAbortHandlers.delete(req);
    return true;
}

function proxyRequest(req, res, targetKey, bodyBuffer, isStream, onResult, opts = {}) {
    const isAnthropic = opts.responseMode === "anthropic";
    const requestId = isAnthropic ? opts.requestId : undefined;
    const requestedModel = isAnthropic ? opts.model : undefined;
    // Model id for PER-MODEL key accounting on every failure path below: a 429
    // must park only this (model, key) pair, never the key pool-wide. Set for
    // both response modes (unlike requestedModel, which is Anthropic-only).
    const affinityModelId = typeof opts.model === "string" && opts.model.length > 0 ? opts.model : undefined;
    // Wrap the caller's callback so a RETRYABLE settle also releases this attempt's
    // inbound abort listeners (see detachFunnelAbortHandlers). Shadowing keeps every
    // existing `onResult(...)` / `if (onResult)` call site unchanged, and stays
    // undefined when the caller passed nothing so those truthiness checks still work.
    const rawOnResult = onResult;
    onResult = typeof rawOnResult === "function"
        ? (result) => {
            if (result && result.success !== true && result.retryable === true) {
                detachFunnelAbortHandlers(req);
            }
            rawOnResult(result);
        }
        : rawOnResult;

    const options = {
        hostname: NVIDIA_API,
        port: 443,
        // The Anthropic facade must forward to the OpenAI Chat Completions upstream
        // (translated body), never to /v1/messages upstream (which NVIDIA does not
        // expose). The passthrough chat path keeps the original client URL.
        path: isAnthropic ? "/v1/chat/completions" : req.url,
        // Method stays POST in both modes; Anthropic clients send POST /v1/messages.
        method: req.method,
        agent: false,  // disable connection pooling to prevent stale socket reuse
        headers: {
            ...req.headers,
            "host": NVIDIA_API,
            "authorization": "Bearer " + targetKey.key,
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
            "X-BILLING-INVOKE-ORIGIN": "OpenCode"
        }
    };

    // Strip hop-by-hop and problematic headers that should not be forwarded.
    sanitizeProxyHeaders(options.headers);
    if (bodyBuffer) {
        delete options.headers["transfer-encoding"];
        options.headers["content-length"] = String(Buffer.byteLength(bodyBuffer));
    }
    // Anthropic facade security: never forward Anthropic ingress credentials
    // (x-api-key / anthropic-version) upstream. The gateway injects the selected
    // NVIDIA upstream Bearer key (above). This also matches constraint §6e#2.
    if (isAnthropic) {
        delete options.headers["x-api-key"];
        delete options.headers["anthropic-version"];
        delete options.headers["anthropic-beta"];
    }

    let firstByteReceived = false;
    let intentionalUpstreamAbort = false;
    let activeUpstreamResponse = null;
    let terminalOutcome = null;
    let keyOutcomeAccounted = false;

    const recordOutcome = (outcome) => {
        if (terminalOutcome) return false;
        terminalOutcome = outcome;
        // Feed the performance-mode "auto" evidence window with this real,
        // terminal upstream outcome (completed / first_byte_timeout / ...).
        performanceMode.observe(outcome);
        info("request_outcome", { id: targetKey.id, outcome });
        return true;
    };

    const accountOutcome = (outcome, tokens = 0) => {
        if (keyOutcomeAccounted) return;
        keyOutcomeAccounted = true;
        if (outcome === "completed") {
            markKeyUsedAndDebounceSave(targetKey.id, { success: true, tokens });
        } else if (outcome === "upstream_sse_error" || outcome === "upstream_stream_error" || outcome === "incomplete_stream") {
            markKeyUsedAndDebounceSave(targetKey.id, { success: false });
        }
    };

    const finishOutcome = (outcome, tokens = 0) => {
        if (recordOutcome(outcome)) accountOutcome(outcome, tokens);
    };

    // The failover loop passes the per-request timeouts in opts; only a
    // stand-alone caller would fall back to a fresh resolution here.
    const upstreamTimeouts = createUpstreamSocketTimeouts({
        firstByteTimeoutMs: opts.firstByteTimeoutMs ?? resolveRequestTimeouts().firstByteTimeoutMs,
        idleTimeoutMs: opts.idleTimeoutMs ?? resolveRequestTimeouts().idleTimeoutMs,
        onTimeout: () => {
            if (!firstByteReceived) {
                intentionalUpstreamAbort = true;
                upstreamReq.destroy();
                warn("Upstream first-byte timeout", { id: targetKey.id });
                handleKeyError(targetKey.id, 504, "First byte timeout", null, affinityModelId);
                keyOutcomeAccounted = true;
                finishOutcome("first_byte_timeout");
                if (onResult) {
                    onResult({ success: false, retryable: true, statusCode: 504, reason: "timeout" });
                } else if (!res.headersSent) {
                    if (isAnthropic) {
                        res.writeHead(504, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ type: "error", error: { type: "request_timeout", message: "Gateway timeout" } }));
                    } else {
                        res.writeHead(504);
                        res.end(JSON.stringify({ error: "Gateway timeout" }));
                    }
                } else {
                    res.destroy(new Error("Gateway timeout"));
                }
            } else {
                warn("Upstream socket idle timeout", { id: targetKey.id });
                intentionalUpstreamAbort = true;
                upstreamReq.destroy();
                activeUpstreamResponse?.destroy();
                finishOutcome("idle_timeout");
                res.destroy(new Error("Upstream socket idle timeout"));
            }
        }
    });

    const upstreamReq = https.request(options, (upstreamRes) => {
        firstByteReceived = true;
        upstreamTimeouts.markFirstByteReceived();
        activeUpstreamResponse = upstreamRes;

        const statusCode = upstreamRes.statusCode;
        const rawContentType = upstreamRes.headers["content-type"];
        const contentTypeValue = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
        const normalizedContentType = typeof contentTypeValue === "string"
            ? contentTypeValue.split(";", 1)[0].trim().toLowerCase()
            : undefined;
        const contentType = normalizedContentType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalizedContentType)
            ? normalizedContentType.slice(0, 128)
            : undefined;
        info("Upstream response started", {
            id: targetKey.id,
            upstreamStatus: statusCode,
            stream: isStream,
            contentType
        });

        const retryAfter = parseRetryAfter(upstreamRes.headers["retry-after"]);

        if (!isSuccessfulStatus(statusCode)) {
            const errorCollector = createBoundedBuffer(MAX_BUFFERED_RESPONSE_BYTES);
            let responseClosed = false;
            let settled = false;
            const settle = (result) => {
                if (settled) return false;
                settled = true;
                onResult?.(result);
                return true;
            };
            const closeInterruptedResponse = (streamError) => {
                if (responseClosed) return;
                responseClosed = true;
                error("Upstream non-2xx response stream error", { id: targetKey.id, statusCode });
                finishOutcome("upstream_stream_error");
                if (!res.headersSent) {
                    if (isAnthropic) {
                        res.writeHead(statusCode, { "Content-Type": "application/json" });
                        res.flushHeaders();
                    } else {
                        res.writeHead(statusCode, capResponseHeaders(upstreamRes.headers));
                        res.flushHeaders();
                    }
                }
                res.destroy(streamError);
            };
            upstreamRes.on("data", chunk => {
                if (!errorCollector.push(chunk)) {
                    intentionalUpstreamAbort = true;
                    responseClosed = true;
                    settle({ success: false, retryable: false, statusCode: 502, reason: "response_too_large" });
                    if (!res.headersSent) {
                        if (isAnthropic) {
                            res.writeHead(502, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream response too large" } }));
                        } else {
                            res.writeHead(502, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ error: "Upstream response too large" }));
                        }
                    }
                    upstreamRes.destroy();
                }
            });
            upstreamRes.on("error", closeInterruptedResponse);
            upstreamRes.on("aborted", () => closeInterruptedResponse(new Error("Upstream response aborted")));
            upstreamRes.on("end", () => {
                if (responseClosed) return;
                responseClosed = true;
                const errorBody = errorCollector.toBuffer().toString("utf8");
                let model;
                let upstreamCode;
                let upstreamType;
                let upstreamStatusCode;

                try {
                    model = safeModelId(JSON.parse(bodyBuffer.toString("utf8")).model);
                } catch {
                }

                try {
                    const parsedError = JSON.parse(errorBody).error;
                    upstreamCode = safeSseField(parsedError?.code);
                    upstreamType = safeSseField(parsedError?.type);
                    upstreamStatusCode = safeStatusCode(parsedError?.status_code ?? parsedError?.status);
                } catch {
                }

                warn("Upstream non-2xx response", { statusCode, model, upstreamCode, upstreamType, upstreamStatusCode });
                handleKeyError(targetKey.id, statusCode, errorBody, retryAfter, affinityModelId);
                keyOutcomeAccounted = true;
                finishOutcome("upstream_http_error");

                if (onResult && classifyUpstreamResponse(statusCode, upstreamRes.headers).retryable && !res.headersSent) {
                    settle({ success: false, retryable: true, statusCode, reason: "http_" + statusCode });
                    return;
                }

                if (isAnthropic && !res.headersSent) {
                    const anthropicError = buildAnthropicUpstreamError(statusCode, errorBody);
                    res.writeHead(statusCode, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(anthropicError));
                    settle({ success: false, retryable: false, statusCode });
                    return;
                }

                res.writeHead(statusCode, capResponseHeaders(upstreamRes.headers));
                res.end(errorBody);
                settle({ success: false, retryable: false, statusCode });
            });
            return;
        }

        let completionTokens = 0;

        if (isStream) {
            let streamClosed = false;
            let sseErrorObserved = false;
            let firstChunkHandled = false;

            const sseObserver = createSseObserver((details) => {
                if (sseErrorObserved) return;
                sseErrorObserved = true;
                warn("Upstream SSE error event", {
                    id: targetKey.id,
                    upstreamStatus: statusCode,
                    ...details
                });
            });
            const maxStreamTimer = setTimeout(() => {
                if (!streamClosed) {
                    streamClosed = true;
                    intentionalUpstreamAbort = true;
                    upstreamReq.destroy(new Error("Max stream duration exceeded"));
                    activeUpstreamResponse?.destroy();
                    finishOutcome("max_stream_duration");
                    res.destroy(new Error("Max stream duration exceeded"));
                }
            }, opts.maxStreamDurationMs ?? resolveRequestTimeouts().maxStreamDurationMs);

            if (isAnthropic) {
                // Anthropic streaming facade: translate the upstream OpenAI SSE
                // stream into Anthropic named events via the adapter generator.
                // The gateway speaks Anthropic SSE to the client; the upstream
                // stays OpenAI Chat Completions.
                const upstreamQueue = [];
                let resolveUpstream = null;
                let upstreamDone = false;
                let streamInitialized = false;

                const upstreamIterable = {
                    async *[Symbol.asyncIterator]() {
                        while (true) {
                            if (upstreamQueue.length > 0) { yield upstreamQueue.shift(); continue; }
                            if (upstreamDone) return;
                            await new Promise((resolve) => { resolveUpstream = resolve; });
                            resolveUpstream = null;
                            if (upstreamQueue.length > 0) { yield upstreamQueue.shift(); continue; }
                            if (upstreamDone) return;
                        }
                    }
                };

                let finalizeAnthropicStream = null;
                const startAnthropicStream = () => {
                    if (streamInitialized) return;
                    streamInitialized = true;
                    res.writeHead(200, {
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive"
                    });
                    // Failover MUST be released here (before any upstream byte is
                    // flushed) so a future retry cannot replay the request after
                    // the stream has started — security constraint §6e#1.
                    if (onResult) onResult({ success: true });

                    finalizeAnthropicStream = (async () => {
                        try {
                            for await (const ev of translateAnthropicSseStream(upstreamIterable, requestId, requestedModel)) {
                                if (streamClosed || res.writableEnded) break;
                                res.write(ev);
                            }
                        } catch (e) {
                            error("Anthropic SSE translation error", { id: targetKey.id, error: e.message });
                        }
                    })();
                };

                upstreamRes.on("data", (chunk) => {
                    if (streamClosed) return;
                    if (!firstChunkHandled) {
                        firstChunkHandled = true;
                        if (!res.headersSent && checkFirstChunkForSseError(chunk)) {
                            streamClosed = true;
                            clearTimeout(maxStreamTimer);
                            intentionalUpstreamAbort = true;
                            upstreamReq.destroy();
                            activeUpstreamResponse?.destroy();
                            handleKeyError(targetKey.id, 500, "Upstream SSE Error", null, affinityModelId);
                            keyOutcomeAccounted = true;
                            finishOutcome("upstream_sse_error");
                            if (onResult) {
                                onResult({ success: false, retryable: true, statusCode: 500, reason: "upstream_sse_error" });
                            }
                            return;
                        }
                        startAnthropicStream();
                    }

                    sseObserver.observe(chunk);
                    upstreamQueue.push(chunk.toString("utf8"));
                    if (resolveUpstream) { const r = resolveUpstream; resolveUpstream = null; r(); }
                });

                upstreamRes.on("error", (err) => {
                    if (streamClosed) return;
                    streamClosed = true;
                    clearTimeout(maxStreamTimer);
                    intentionalUpstreamAbort = true;
                    error("Upstream response stream error", { id: targetKey.id, upstreamStatus: statusCode });
                    finishOutcome("upstream_stream_error");
                    if (!res.headersSent && !firstChunkHandled) {
                        handleKeyError(targetKey.id, 502, err.message, null, affinityModelId);
                        keyOutcomeAccounted = true;
                        if (onResult) {
                            onResult({ success: false, retryable: true, statusCode: 502, reason: "upstream_stream_error" });
                            return;
                        }
                    }
                    res.destroy(err);
                });
                upstreamRes.on("aborted", () => {
                    if (streamClosed) return;
                    streamClosed = true;
                    clearTimeout(maxStreamTimer);
                    intentionalUpstreamAbort = true;
                    finishOutcome("upstream_stream_error");
                    if (!res.headersSent && !firstChunkHandled) {
                        handleKeyError(targetKey.id, 502, "Upstream response aborted", null, affinityModelId);
                        keyOutcomeAccounted = true;
                        if (onResult) {
                            onResult({ success: false, retryable: true, statusCode: 502, reason: "upstream_stream_error" });
                            return;
                        }
                    }
                    res.destroy(new Error("Upstream response aborted"));
                });
                res.on("error", () => {
                    if (streamClosed) return;
                    streamClosed = true;
                    clearTimeout(maxStreamTimer);
                    intentionalUpstreamAbort = true;
                    finishOutcome("client_aborted");
                    upstreamRes.destroy();
                });
                res.on("close", () => {
                    if (streamClosed || res.writableEnded) return;
                    streamClosed = true;
                    clearTimeout(maxStreamTimer);
                    intentionalUpstreamAbort = true;
                    finishOutcome("client_aborted");
                    upstreamReq.destroy();
                    upstreamRes.destroy();
                });
                upstreamRes.on("end", async () => {
                    if (streamClosed) return;
                    if (!firstChunkHandled) {
                        firstChunkHandled = true;
                        streamClosed = true;
                        clearTimeout(maxStreamTimer);
                        finishOutcome("incomplete_stream");
                        if (!res.headersSent && onResult) {
                            onResult({ success: false, retryable: true, statusCode: 502, reason: "incomplete_stream" });
                            return;
                        }
                    }
                    upstreamDone = true;
                    if (resolveUpstream) { const r = resolveUpstream; resolveUpstream = null; r(); }
                    if (finalizeAnthropicStream) await finalizeAnthropicStream;
                    if (streamClosed) return;
                    streamClosed = true;
                    clearTimeout(maxStreamTimer);
                    sseObserver.end();
                    if (sseErrorObserved) {
                        finishOutcome("upstream_sse_error");
                    } else if (sseObserver.sawDone) {
                        finishOutcome("completed");
                    } else {
                        finishOutcome("incomplete_stream");
                    }
                    if (!res.writableEnded) res.end();
                });
                return;
            }

            upstreamRes.on("data", (chunk) => {
                if (streamClosed) return;
                if (!firstChunkHandled) {
                    firstChunkHandled = true;
                    if (!res.headersSent && checkFirstChunkForSseError(chunk)) {
                        streamClosed = true;
                        clearTimeout(maxStreamTimer);
                        intentionalUpstreamAbort = true;
                        upstreamReq.destroy();
                        activeUpstreamResponse?.destroy();
                        handleKeyError(targetKey.id, 500, "Upstream SSE Error", null, affinityModelId);
                        keyOutcomeAccounted = true;
                        finishOutcome("upstream_sse_error");
                        if (onResult) {
                            onResult({ success: false, retryable: true, statusCode: 500, reason: "upstream_sse_error" });
                        }
                        return;
                    }
                    res.writeHead(statusCode, capResponseHeaders(upstreamRes.headers));
                    if (onResult) onResult({ success: true });
                }
                sseObserver.observe(chunk);
                res.write(chunk);
            });
            upstreamRes.on("error", (err) => {
                if (streamClosed) return;
                streamClosed = true;
                clearTimeout(maxStreamTimer);
                error("Upstream response stream error", { id: targetKey.id, upstreamStatus: statusCode });
                finishOutcome("upstream_stream_error");
                if (!res.headersSent && !firstChunkHandled) {
                    handleKeyError(targetKey.id, 502, err.message, null, affinityModelId);
                    keyOutcomeAccounted = true;
                    if (onResult) {
                        onResult({ success: false, retryable: true, statusCode: 502, reason: "upstream_stream_error" });
                        return;
                    }
                }
                res.destroy(err);
            });
            upstreamRes.on("aborted", () => {
                if (streamClosed) return;
                streamClosed = true;
                clearTimeout(maxStreamTimer);
                finishOutcome("upstream_stream_error");
                if (!res.headersSent && !firstChunkHandled) {
                    handleKeyError(targetKey.id, 502, "Upstream response aborted", null, affinityModelId);
                    keyOutcomeAccounted = true;
                    if (onResult) {
                        onResult({ success: false, retryable: true, statusCode: 502, reason: "upstream_stream_error" });
                        return;
                    }
                }
                res.destroy(new Error("Upstream response aborted"));
            });
            res.on("error", () => {
                if (streamClosed) return;
                streamClosed = true;
                clearTimeout(maxStreamTimer);
                intentionalUpstreamAbort = true;
                finishOutcome("client_aborted");
                upstreamRes.destroy();
            });
            res.on("close", () => {
                if (streamClosed || res.writableEnded) return;
                streamClosed = true;
                clearTimeout(maxStreamTimer);
                intentionalUpstreamAbort = true;
                finishOutcome("client_aborted");
                upstreamReq.destroy();
                upstreamRes.destroy();
            });
            upstreamRes.on("end", () => {
                if (streamClosed) return;
                if (!firstChunkHandled) {
                    firstChunkHandled = true;
                    streamClosed = true;
                    clearTimeout(maxStreamTimer);
                    finishOutcome("incomplete_stream");
                    if (!res.headersSent && onResult) {
                        onResult({ success: false, retryable: true, statusCode: 502, reason: "incomplete_stream" });
                        return;
                    }
                }
                streamClosed = true;
                clearTimeout(maxStreamTimer);
                sseObserver.end();
                if (sseErrorObserved) {
                    finishOutcome("upstream_sse_error");
                } else if (sseObserver.sawDone) {
                    finishOutcome("completed");
                } else {
                    finishOutcome("incomplete_stream");
                }
                if (!res.writableEnded) res.end();
            });
        } else {
            if (isAnthropic) {
                // Anthropic non-streaming facade: buffer the upstream OpenAI
                // JSON response fully, translate it to the Anthropic Messages
                // shape, and send the single Anthropic JSON body to the client.
                if (statusCode === 204) {
                    upstreamRes.resume();
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream returned no content" } }));
                    finishOutcome("upstream_stream_error");
                    if (onResult) onResult({ success: false, retryable: false, statusCode: 500 });
                    return;
                }
                // Release the failover key BEFORE any byte is flushed to the
                // client so a future retry can never replay the request after
                // the stream starts — security constraint §6e#1.
                if (onResult) onResult({ success: true });
                const responseCollector = createBoundedBuffer(MAX_BUFFERED_RESPONSE_BYTES);
                let buffered = true;
                upstreamRes.on("error", (err) => {
                    if (!res.headersSent) {
                        res.writeHead(502, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Bad Gateway" } }));
                    } else {
                        res.destroy(err);
                    }
                    finishOutcome("upstream_stream_error");
                });
                upstreamRes.on("data", (chunk) => {
                    if (buffered && !responseCollector.push(chunk)) buffered = false;
                });
                upstreamRes.on("end", () => {
                    if (!buffered) {
                        if (!res.headersSent) {
                            res.writeHead(502, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream response too large" } }));
                        }
                        finishOutcome("upstream_stream_error");
                        return;
                    }
                    const rawOpenaiResponse = responseCollector.toBuffer().toString("utf8");
                    let anthropicResponse;
                    let completionTokens = 0;
                    try {
                        const openaiParsed = JSON.parse(rawOpenaiResponse);
                        anthropicResponse = translateAnthropicResponse(openaiParsed);
                        if (anthropicResponse.usage && typeof anthropicResponse.usage.output_tokens === "number") {
                            completionTokens = anthropicResponse.usage.output_tokens;
                        }
                    } catch (e) {
                        error("Anthropic translation error", { id: targetKey.id, error: e.message, stack: e.stack });
                        if (!res.headersSent) {
                            res.writeHead(502, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Failed to translate upstream response" } }));
                        }
                        finishOutcome("upstream_stream_error");
                        return;
                    }
                    const body = JSON.stringify(anthropicResponse);
                    if (!res.headersSent) {
                        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
                    }
                    res.end(body);
                    finishOutcome("completed", completionTokens);
                });
                return;
            }
            if (statusCode === 204) {
                upstreamRes.resume();
                res.writeHead(204, capResponseHeaders(upstreamRes.headers));
                res.end();
                finishOutcome("completed", 0);
                if (onResult) onResult({ success: true });
                return;
            }
            res.writeHead(statusCode, capResponseHeaders(upstreamRes.headers));
            if (onResult) onResult({ success: true });
            const responseCollector = createBoundedBuffer(MAX_BUFFERED_RESPONSE_BYTES);
            let collectingUsage = true;
            res.on("error", () => {});
            upstreamRes.on("error", (err) => {
                if (!res.headersSent) res.writeHead(502);
                if (!res.writableEnded) res.end();
                finishOutcome("upstream_stream_error");
            });
            upstreamRes.on("data", chunk => {
                if (collectingUsage && !responseCollector.push(chunk)) collectingUsage = false;
                res.write(chunk);
            });
            upstreamRes.on("end", () => {
                res.end();
                try {
                    if (!collectingUsage) throw new Error("usage collection overflow");
                    const parsed = JSON.parse(responseCollector.toBuffer().toString("utf8"));
                    if (parsed.usage && parsed.usage.total_tokens) {
                        completionTokens = parsed.usage.total_tokens;
                    }
                } catch (e) {
                }
                finishOutcome("completed", completionTokens);
            });
        }
    });

    upstreamReq.on("socket", (socket) => {
        upstreamTimeouts.attach(socket);
    });

    upstreamReq.on("error", (err) => {
        if (intentionalUpstreamAbort) return;
        error("Upstream request error", { id: targetKey.id, error: err.message, stack: err.stack });
        if (!firstByteReceived) {
            handleKeyError(targetKey.id, 502, err.message, null, affinityModelId);
            keyOutcomeAccounted = true;
        }
        finishOutcome("upstream_stream_error");
        if (onResult && !firstByteReceived) {
            onResult({ success: false, retryable: true, statusCode: 502, reason: "socket_hang_up" });
        } else if (!res.headersSent) {
            if (isAnthropic) {
                res.writeHead(502, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Bad Gateway" } }));
            } else {
                res.writeHead(502);
                res.end(JSON.stringify({ error: "Bad Gateway" }));
            }
        } else {
            res.destroy(err);
        }
        if (onResult && firstByteReceived) onResult({ success: false, retryable: false });
    });

    if (bodyBuffer) {
        upstreamReq.write(bodyBuffer);
    }
    upstreamReq.end();

    // Attach the funnel "close"/"aborted" handlers for THIS attempt. A retryable
    // settle already detached the previous attempt's pair; the defensive detach
    // here also covers any path that re-entered without settling retryably. A
    // failover loop re-enters proxyRequest for each retry on the SAME `req`, so
    // without this every retry would add two more listeners (tripping
    // MaxListenersExceededWarning) and leave stale closures over dead attempts.
    detachFunnelAbortHandlers(req);
    const onClientClose = () => {
        // Only abort upstream if we've already started receiving the response.
        // Destroying upstreamReq during TLS handshake causes socket hang up
        // on the upstream side instead of letting it complete naturally.
        if (!res.writableEnded && firstByteReceived) {
            warn("Client disconnected during upstream transfer", { id: targetKey.id });
            intentionalUpstreamAbort = true;
            if (!terminalOutcome) finishOutcome("client_aborted");
            activeUpstreamResponse?.destroy();
            upstreamReq.destroy();
        }
    };
    const onClientAborted = () => {
        if (!res.writableEnded) {
            intentionalUpstreamAbort = true;
            finishOutcome("client_aborted");
            upstreamReq.destroy();
        }
    };
    req.on("close", onClientClose);
    req.on("aborted", onClientAborted);
    funnelAbortHandlers.set(req, { close: onClientClose, aborted: onClientAborted });
}

function handleModelsWithFailover(req, res, onKeyIdChange) {
    return new Promise((resolve) => {
        let attempt = 0;
        const activeCount = getKeys().filter((k) => k.status === "active").length;
        const maxAttempts = resolveMaxFailoverAttempts(process.env, activeCount, resolveConfiguredMaxFailoverAttempts(undefined));

        const tryNext = () => {
            if (attempt >= maxAttempts) {
                error("All models failover attempts exhausted", { attempts: attempt });
                if (!res.headersSent) {
                    const retryAfter = String(getSoonestActiveCooldownRemainingSeconds());
                    res.writeHead(502, capResponseHeaders({ "Content-Type": "application/json", "Retry-After": retryAfter }));
                    res.end(JSON.stringify({ error: "All failover attempts exhausted" }));
                }
                resolve({ success: false });
                return;
            }

            const key = getNextKey();
            if (!key) {
                warn("No available keys for models request");
                if (!res.headersSent) {
                    const retryAfter = String(getSoonestActiveCooldownRemainingSeconds());
                    res.writeHead(503, capResponseHeaders({ "Content-Type": "application/json", "Retry-After": retryAfter }));
                    res.end(JSON.stringify({ error: "All API keys exhausted" }));
                }
                resolve({ success: false });
                return;
            }

            attempt++;
            if (onKeyIdChange) onKeyIdChange(key.id);

            handleModelsRequest(req, res, key, (result) => {
                if (result.success || !result.retryable) {
                    resolve(result);
                } else {
                    warn("Retrying models with different key", {
                        attempt,
                        maxAttempts,
                        reason: result.reason
                    });
                    tryNext();
                }
            });
        };

        tryNext();
    });
}

function handleModelsRequest(req, res, targetKey, onResult) {
    const options = {
        hostname: NVIDIA_API,
        port: 443,
        path: "/v1/models",
        method: "GET",
        agent: false,  // disable connection pooling
        headers: {
            ...req.headers,
            "host": NVIDIA_API,
            "authorization": "Bearer " + targetKey.key,
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
            "X-BILLING-INVOKE-ORIGIN": "OpenCode"
        }
    };

    sanitizeProxyHeaders(options.headers);

    const upstreamReq = https.request(options, (upstreamRes) => {
        const responseCollector = createBoundedBuffer(MAX_BUFFERED_RESPONSE_BYTES);
        let settled = false;
        let overflowed = false;
        const settle = (result) => { if (!settled) { settled = true; onResult?.(result); } };
        upstreamRes.on("data", chunk => {
            if (settled) return;
            if (!responseCollector.push(chunk)) {
                overflowed = true;
                settle({ success: false, retryable: false, statusCode: 502, reason: "response_too_large" });
                if (!res.headersSent) { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Upstream response too large" })); }
                upstreamRes.destroy();
            }
        });
        upstreamRes.on("end", () => {
            if (settled || overflowed) return;
            const responseBody = responseCollector.toBuffer().toString("utf8");
            if (isSuccessfulStatus(upstreamRes.statusCode)) {
                if (upstreamRes.statusCode === 204) {
                    res.writeHead(204, capResponseHeaders(upstreamRes.headers));
                    res.end();
                    settle({ success: true });
                    return;
                }
                try {
                    const parsed = JSON.parse(responseBody);
                    if (parsed && Array.isArray(parsed.data)) {
                        const enrichedModelIds = [];
                        parsed.data.forEach(model => {
                            // Skip a malformed entry gracefully so a single bad
                            // upstream object never crashes the whole /v1/models
                            // response (robust enrichment). getCapabilityMetadata
                            // is itself null/undefined-safe, but model.id access
                            // and the property assignment below require an object.
                            if (!model || typeof model !== "object" || Array.isArray(model)) return;
                            const limits = getModelLimits(model.id);
                            model.context_length = limits.context;
                            model.max_completion_tokens = limits.output;
                            model.max_tokens = limits.context;
                            // Static family capabilities first, then override the
                            // reasoning block with a LIVE-probed result when one is
                            // cached (probed truth beats a static family guess; a
                            // missing/stale probe leaves the static value intact).
                            model.capabilities = getCapabilityMetadata(model.id);
                            mergeProbedReasoning(model.capabilities, model.id);
                            if (typeof model.id === "string") enrichedModelIds.push(model.id);
                        });
                        // SUB-TASK A#2: drop disabled model ids from the client-facing catalog
                        // (the OpenAI-compatible list clients pick from). Non-object / non-string-id
                        // entries pass through untouched (matches the malformed-entry contract in
                        // tests/model-enrichment.test.mjs). Only objects whose string id is in the
                        // operator-curated disabledModels are removed. F1: comparison is
                        // case-insensitive — getDisabledModels() returns lowercased ids, and the
                        // model id is lowercased before the Set lookup.
                        const disabledIds = getDisabledModels();
                        if (disabledIds.length > 0) {
                            const disabled = new Set(disabledIds);
                            parsed.data = parsed.data.filter(
                                (m) => !(m && typeof m === "object" && !Array.isArray(m) && typeof m.id === "string" && disabled.has(m.id.toLowerCase()))
                            );
                        }
                        // REAL reasoning-capability discovery: lazily refresh stale
                        // probed capability entries for the models just served.
                        // Fire-and-forget and non-blocking — this response was
                        // already built from cache/static; outcomes are logged to
                        // gateway.jsonl as capability_probe events. The scheduler is
                        // a no-op under the test upstream sentinel unless force-
                        // enabled, so hermetic harness tests never see probe traffic.
                        if (enrichedModelIds.length > 0) {
                            scheduleCapabilityRefresh(enrichedModelIds, {
                                logger: (outcome) => info("capability_probe", outcome),
                                keyProvider: () => getNextKey()?.key ?? null
                            });
                        }
                    }
                    const modifiedBody = JSON.stringify(parsed);
                    const responseHeaders = { ...upstreamRes.headers };
                    delete responseHeaders["transfer-encoding"];
                    res.writeHead(upstreamRes.statusCode, capResponseHeaders({
                        ...responseHeaders,
                        "content-length": Buffer.byteLength(modifiedBody)
                    }));
                    res.end(modifiedBody);
                    settle({ success: true });
                } catch (e) {
                    res.writeHead(upstreamRes.statusCode, capResponseHeaders(upstreamRes.headers));
                    res.end(responseBody);
                    settle({ success: true });
                }
            } else {
                const retryAfter = parseRetryAfter(upstreamRes.headers["retry-after"]);
                handleKeyError(targetKey.id, upstreamRes.statusCode, responseBody, retryAfter);
                if (onResult && classifyUpstreamResponse(upstreamRes.statusCode, upstreamRes.headers).retryable && !res.headersSent) {
                    settle({ success: false, retryable: true, statusCode: upstreamRes.statusCode, reason: "http_" + upstreamRes.statusCode });
                    return;
                }
                res.writeHead(upstreamRes.statusCode, capResponseHeaders(upstreamRes.headers));
                res.end(responseBody);
                settle({ success: false, retryable: false, statusCode: upstreamRes.statusCode });
            }
        });
        upstreamRes.on("error", (err) => {
            if (settled) return;
            settle({ success: false, retryable: false, statusCode: 502, reason: "response_error" });
            if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: "Bad Gateway" })); }
            else res.destroy(err);
        });
        upstreamRes.on("aborted", () => {
            if (settled) return;
            settle({ success: false, retryable: false, statusCode: 502, reason: "response_aborted" });
            if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: "Bad Gateway" })); }
        });
    });

    upstreamReq.on("error", (err) => {
        error("Upstream models request error", { error: err.message, stack: err.stack });
        if (onResult) {
            onResult({ success: false, retryable: true, statusCode: 502, reason: "socket_hang_up" });
        } else if (!res.headersSent) {
            res.writeHead(502);
            res.end(JSON.stringify({ error: "Bad Gateway" }));
        }
    });

    upstreamReq.end();
}

const server = http.createServer(async (req, res) => {
    const startTime = process.hrtime.bigint();
    let loggedKeyId = null;

    // Install request-logging hook before any response work
    const logRequest = () => {
        const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6; // ms
        info("request", {
            method: req.method,
            path: pathnameOnly(req.url),
            status: res.statusCode,
            duration_ms: Math.round(elapsed),
            keyIndex: loggedKeyId
        });
    };
    let logged = false;
    res.once("finish", () => { logRequest(); logged = true; });
    res.once("close", () => {
        if (logged) return;
        const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6;
        info("request", {
            method: req.method,
            path: pathnameOnly(req.url),
            status: res.statusCode || 0,
            duration_ms: Math.round(elapsed),
            keyIndex: loggedKeyId,
            aborted: true
        });
    });

    const requestUrl = new URL(req.url, "http://127.0.0.1");
    const origin = req.headers.origin;
    const allowedOrigin = origin && isAllowedOrigin(origin, CORS_ALLOWLIST);
    if (origin && !allowedOrigin) { res.writeHead(403); res.end(); return; }
    if (allowedOrigin) { res.setHeader("Access-Control-Allow-Origin", CORS_ALLOWLIST.find((candidate) => candidate === origin)); res.setHeader("Vary", "Origin"); }
    if (req.method === "OPTIONS") {
        const requestedMethod = req.headers["access-control-request-method"];
        if (!allowedOrigin || !classifyGatewayRoute(requestedMethod, requestUrl.pathname)) { res.writeHead(403); res.end(); return; }
        res.writeHead(204, { "Access-Control-Allow-Methods": requestedMethod, "Access-Control-Allow-Headers": "Authorization, Content-Type" }); res.end(); return;
    }

    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(isReady ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: isReady ? "ok" : "starting" }));
        return;
    }

    // Cached models endpoint (no upstream call)
    if (req.method === "GET" && requestUrl.pathname === "/v1/models/cached") {
        try {
            const models = await getCachedModels();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ data: models, cached: true }));
        } catch (err) {
            error("Failed to get cached models", { error: err.message });
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to retrieve cached models" }));
        }
        return;
    }

    // Manual refresh endpoint (admin only)
    if (req.method === "POST" && requestUrl.pathname === "/v1/models/refresh") {
        if (!ADMIN_TOKEN || !isBearerAuthorized(req.headers.authorization, ADMIN_TOKEN)) {
            res.writeHead(401, { "WWW-Authenticate": "Bearer" });
            res.end();
            return;
        }
        try {
            const all = await refreshModels();
            // SUB-TASK A#2: keep /v1/models/refresh consistent with /v1/models —
            // exclude operator-disabled models from the returned set. (The model-discovery
            // cache already filters the separate GATEWAY_DISABLED_MODELS env var; this is
            // the additional config.json disabledModels filter.) F1: case-insensitive —
            // getDisabledModels() returns lowercased ids; model id lowercased before lookup.
            const disabledIds = getDisabledModels();
            const data = disabledIds.length === 0
                ? all
                : all.filter((m) => !(m && typeof m === "object" && !Array.isArray(m) && typeof m.id === "string" && new Set(disabledIds).has(m.id.toLowerCase())));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ data, cached: false }));
        } catch (err) {
            error("Failed to refresh models", { error: err.message });
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to refresh models" }));
        }
        return;
    }

    if (requestUrl.pathname.startsWith("/v1/")) {
        const route = classifyGatewayRoute(req.method, requestUrl.pathname);
        if (!route || requestUrl.search) { res.writeHead(404); res.end(); return; }
        if (!LOCAL_TOKEN || !isBearerAuthorized(req.headers.authorization, LOCAL_TOKEN)) { res.writeHead(401, { "WWW-Authenticate": "Bearer" }); res.end(); return; }
    }
    if (req.method === "GET" && requestUrl.pathname === "/v1/models") {
        return handleModelsWithFailover(req, res, (newKeyId) => {
            loggedKeyId = newKeyId;
        });
    }

    if (req.method === "POST" && requestUrl.pathname === "/v1/chat/completions") {
        let bodyChunks = [];
        let bodyLength = 0;
        const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5MB

        req.on("data", chunk => {
            bodyLength += chunk.length;
            if (bodyLength > MAX_PAYLOAD_SIZE) {
                if (!res.headersSent) {
                    res.writeHead(413, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Payload Too Large" }));
                }
                req.destroy();
                return;
            }
            bodyChunks.push(chunk);
        });
        req.on("end", () => {
            if (bodyLength > MAX_PAYLOAD_SIZE) return;
            const bodyBuffer = Buffer.concat(bodyChunks);
            let isStream = false;
            let requestedModelId = undefined;

            if (req.headers["content-type"]?.includes("application/json") && bodyBuffer.length > 0) {
                let parsed;
                try {
                    parsed = JSON.parse(bodyBuffer.toString("utf8"));
                } catch {
                    // Malformed JSON must fail fast HERE, before any key is touched.
                    // Previously the unparseable body was swallowed and forwarded,
                    // after which NVIDIA answered `500 text/plain` (treated as a
                    // retryable failure) — burning every key in the pool into backoff.
                    // The parser message is deliberately NOT echoed: it reflects
                    // attacker-controlled bytes and adds no actionable detail.
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "invalid request body" }));
                    return;
                }
                if (parsed.stream === true) {
                    isStream = true;
                }
                // Capture requested model id for disabled-model check below.
                if (typeof parsed?.model === "string") requestedModelId = parsed.model;
            }

            // SUB-TASK A#3: fail fast — block a request for a disabled model BEFORE any key
            // rotation / upstream call (matches OpenAI unknown-model semantics). The check is at
            // request START; an already-streaming response is never unwound (documented edge).
            // F1: case-insensitive — getDisabledModels() returns lowercased ids.
            if (requestedModelId && getDisabledModels().includes(requestedModelId.toLowerCase())) {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: { message: "model not found: " + requestedModelId, type: "invalid_request_error", code: "model_not_found" } }));
                return;
            }

            proxyRequestWithFailover(req, res, bodyBuffer, isStream, (newKeyId) => {
                loggedKeyId = newKeyId;
            }, { model: requestedModelId });
        });

        req.on("error", (err) => {
            error("Client request error", { error: err.message, stack: err.stack });
            if (!res.headersSent) {
                res.writeHead(400);
                res.on("error", () => {}); res.end();
            }
        });
        return;
    }

    // ── Anthropic Messages API facade ──────────────────────────────────────
    // POST /v1/messages  →  translate to OpenAI Chat Completions, forward to
    // NVIDIA upstream via the shared failover spine, translate the OpenAI
    // response (JSON or SSE) back to Anthropic shape. All errors are returned
    // in Anthropic's error envelope. Auth uses the same LOCAL_TOKEN Bearer
    // gate as the OpenAI chat path (see classifyGatewayRoute: 'messages').
    if (req.method === "POST" && requestUrl.pathname === "/v1/messages") {
        let bodyChunks = [];
        let bodyLength = 0;
        const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5MB — same as chat

        const sendAnthropicError = (httpStatus, errorType, message) => {
            if (res.headersSent) return;
            res.writeHead(httpStatus, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ type: "error", error: { type: errorType, message } }));
        };

        req.on("data", chunk => {
            bodyLength += chunk.length;
            if (bodyLength > MAX_PAYLOAD_SIZE) {
                if (!res.headersSent) {
                    res.writeHead(413, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Payload Too Large" } }));
                }
                req.destroy();
                return;
            }
            bodyChunks.push(chunk);
        });
        req.on("end", () => {
            if (bodyLength > MAX_PAYLOAD_SIZE) return;
            const bodyBuffer = Buffer.concat(bodyChunks);

            // Malformed JSON fails fast HERE, before any key is touched — same
            // guarantee as the OpenAI chat path, expressed in Anthropic's error
            // envelope. The parser message is never echoed back.
            let anthropicBody;
            try {
                anthropicBody = JSON.parse(bodyBuffer.toString("utf8"));
            } catch {
                sendAnthropicError(400, "invalid_request_error", "invalid request body");
                return;
            }

            const { openaiBody, warnings, errors } = translateAnthropicRequest(anthropicBody);
            if (warnings.length > 0) {
                info("Anthropic facade translation warnings", { warnings });
            }
            if (errors.length > 0 || !openaiBody) {
                sendAnthropicError(400, "invalid_request_error", errors.join("; ") || "Invalid Anthropic request");
                return;
            }

            // SUB-TASK A#3: fail fast — block a request for a disabled model BEFORE
            // translation/proxy. Anthropic clients pass the model id through unchanged
            // (anthropic-adapter.mjs: openaiBody.model = body.model), so the raw
            // requested id is the one forwarded upstream and the one the disabled list keys on.
            // F1: case-insensitive — getDisabledModels() returns lowercased ids.
            const requestedModelId = typeof anthropicBody.model === "string"
                ? anthropicBody.model
                : (typeof openaiBody.model === "string" ? openaiBody.model : "");
            if (requestedModelId && getDisabledModels().includes(requestedModelId.toLowerCase())) {
                sendAnthropicError(404, "not_found_error", "model: " + requestedModelId + " not found");
                return;
            }

            const isStream = openaiBody.stream === true;
            // Re-serialize the translated OpenAI body so the upstream gets a
            // clean Chat Completions payload. Content-Length is derived from
            // this translated buffer, not the client's oversized Anthropic one.
            let translatedBuffer;
            try {
                translatedBuffer = Buffer.from(JSON.stringify(openaiBody), "utf8");
            } catch (e) {
                error("Anthropic facade serialization error", { error: e.message });
                sendAnthropicError(500, "api_error", "Failed to serialize translated request");
                return;
            }

            const requestId = "msg_" + crypto.randomUUID();
            const requestedModel = typeof anthropicBody.model === "string" ? anthropicBody.model : (openaiBody.model || "");
            const opts = { responseMode: "anthropic", requestId, model: requestedModel };
            // Replace req.url so any upstream-derived logs reference the
            // Chat Completions target rather than /v1/messages.
            req.url = "/v1/chat/completions";

            proxyRequestWithFailover(req, res, translatedBuffer, isStream, (newKeyId) => {
                loggedKeyId = newKeyId;
            }, opts);
        });

        req.on("error", (err) => {
            error("Client request error", { error: err.message, stack: err.stack });
            if (!res.headersSent) {
                sendAnthropicError(400, "invalid_request_error", "Client request error");
            }
        });
        return;
    }

    res.writeHead(404);
    res.on("error", () => {}); res.end();
});

const PORT = Number.parseInt(process.env.PORT || "12000", 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65534) {
    throw new Error("PORT must be an integer between 1 and 65534.");
}

const ADMIN_PORT = parseInt(PORT, 10) + 1;
const adminServer = http.createServer((req, res) => {
    if (req.url.startsWith("/admin/")) {
        // Parity with every other branch: swallow a late-write error on res so it
        // can never crash the process on future Node versions (defensive only).
        res.on("error", () => {});
        return handleAdminRequest(req, res, { adminToken: ADMIN_TOKEN });
    }
    res.writeHead(404);
    res.on("error", () => {}); res.end();
});

function failStartup(serverName, err) {
    error(serverName + " failed to start", { port: serverName === "Gateway" ? PORT : ADMIN_PORT, error: err.message, stack: err.stack });
    console.error("[Gateway:E_STARTUP] Startup failed");
    if (server.listening) server.close();
    if (adminServer.listening) adminServer.close();
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 3000);
}

server.on("error", (err) => failStartup("Gateway", err));
adminServer.on("error", (err) => failStartup("Admin", err));

server.listen(PORT, "127.0.0.1", () => {
    info("Gateway started", { port: PORT });
    console.log("GATEWAY_LISTENING");
    adminServer.listen(ADMIN_PORT, "127.0.0.1", () => {
        isReady = Boolean(LOCAL_TOKEN && ADMIN_TOKEN);
        info("Admin API started", { port: ADMIN_PORT });
        console.log("ADMIN_LISTENING");
        if (typeof process.send === "function") {
            process.send({ type: "ports:bound", challenge: ipcChallenge, gatewayPort: PORT, adminPort: ADMIN_PORT });
        }
        // F3: best-effort background cache warm so the first /admin/models (and
        // /v1/models/cached) call does not pay the up-to-30s upstream fetch
        // latency, which exceeds the admin-client's 5s socket timeout. Delayed +
        // unref'd: the 2s delay ensures the warm never fires during the ~2s
        // lifecycle of test children (which would otherwise shift a queued
        // response off queue-based fake upstreams). In production the 2s delay is
        // negligible and fire-and-forget — a fetch failure is swallowed and
        // getCachedModels() retries lazily on the next request.
        const cacheWarmTimer = setTimeout(() => {
            refreshModels().catch(() => { /* cache warm is best-effort */ });
        }, 2000);
        cacheWarmTimer.unref();
    });
});

process.on("message", (message) => {
    if (message?.type === "state:init") isReady = Boolean(LOCAL_TOKEN && ADMIN_TOKEN && server.listening && adminServer.listening);
    // GRACEFUL STOP REQUEST from the parent. On Windows child.kill("SIGTERM")
    // is TerminateProcess: Node never runs our signal handlers, so shutdown()
    // — and with it the state flush — was silently skipped on every managed
    // stop. The parent therefore ASKS over this already-bound ipc channel
    // before falling back to signals. Carries no state and grants nothing, so
    // it needs no challenge (only the parent can write to this pipe); the
    // credential-bearing state:init path above keeps its challenge check.
    else if (message?.type === "shutdown") shutdown();
});

// Parent vanished (crash, or the channel was closed): flush anyway rather than
// waiting to be killed with unsaved state.
process.on("disconnect", shutdown);

let shuttingDown = false;
function shutdown() {
    // Idempotent: an ipc shutdown request, a disconnect and a delivered signal
    // can all arrive for the SAME stop (disconnecting below re-enters here).
    if (shuttingDown) return;
    shuttingDown = true;
    info("Gateway shutting down", { graceful: true });
    // Flush remaining log buffer before exit
    flushState();
    flushLogs();
    server.close();
    adminServer.close();
    // Nothing above releases the event loop: both listeners may still hold
    // keep-alive sockets and the ipc channel is itself a ref'd handle, so the
    // child would linger until the parent's SIGKILL. Release both so the exit
    // is prompt and the parent's short grace is enough — the flush is already
    // durable by this point, and anything destroyed here would have died at
    // SIGKILL moments later anyway.
    server.closeAllConnections?.();
    adminServer.closeAllConnections?.();
    try { if (process.connected) process.disconnect(); } catch {}
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
