import http from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import { handleAdminRequest } from "./admin-api.mjs";
import { commitModelKeyAssignment, getCurrentEligibleKeyIds, getNextKey, getKeys, handleKeyError, markKeyUsedAndDebounceSave, initializeState, getSoonestActiveCooldownRemainingSeconds, getModelEligibleKeyCount, getRetryAfterSecondsForModel } from "./rotation.mjs";
import { log, info, warn, error, flushLogs } from "./logger.mjs";
import { buildUpstreamRequestHeaders, capResponseHeaders } from "./proxy-headers.mjs";
import { createUpstreamSocketTimeouts, resolveRequestDeadlineMs, resolveRetryFirstByteTimeoutMs } from "./upstream-timeouts.mjs";
import { getModelLimits, getDisabledModels, setModelLimits } from "./model-limits.mjs";
import { getCapabilityMetadata } from "./capability-registry.mjs";
import { classifyUpstreamResponse, isPoolWideCapableStatus, isSuccessfulStatus, parseRetryAfter, RATE_LIMIT_STATUS, resolveMaxFailoverAttempts, resolvePoolWideFailureStatus, resolveRateLimitMaxAttempts, shouldEarlyStopOnRateLimit } from "./failover-policy.mjs";
import { createBoundedBuffer, resolveMaxBufferedResponseBytes } from "./bounded-buffer.mjs";
import { flushState } from "./rotation.mjs";
import { GATEWAY_ROUTE_PATHS, classifyGatewayRoute, isAllowedOrigin, isBearerAuthorized, isGatewayRouteAuthorized, parseCorsAllowlist } from "./security.mjs";
import { AnthropicUpstreamSseError, isOpenAiSseItemMeaningful, sanitizeUpstreamErrorMessage, translateAnthropicRequest, translateAnthropicResponse, translateAnthropicSseStream } from "./anthropic-adapter.mjs";
import { ResponsesUpstreamSseError, newResponseId, translateChatCompletionToResponse, translateResponsesRequest, translateResponsesSseStream } from "./responses-adapter.mjs";
import { applyReasoningDefaults, usesReasoningDefaults } from "./reasoning-defaults.mjs";
import { pathnameOnly, setRuntimeSecrets } from "../shared/redaction.mjs";
import crypto from "node:crypto";
import { getCachedModels, refreshModels } from "./model-discovery.mjs";
import { createDirectGlmProbeScheduler, runDirectGlmProbe, shouldScheduleDirectGlmProbe } from "./direct-glm-probe.mjs";
import { mergeProbedReasoning, scheduleCapabilityRefresh } from "./capability-probe.mjs";
import { createPerformanceModeResolver, readConfiguredRequestDeadlineMs, readPerModelFailoverAttempts, readPerModelRateLimitAttempts } from "./performance-mode.mjs";
import { DEFAULT_FIRST_BYTE_TIMEOUT_MS } from "./upstream-timeouts.mjs";

const NVIDIA_API = "integrate.api.nvidia.com";

// Э3 (spec :41): connect-time INFRA failures - the upstream connection was never
// established, so the key said nothing. These errno values only occur before a
// socket connects; ECONNRESET / TLS / post-connect hang-ups are NOT listed and
// keep their key-scoped handling.
const INFRA_ERROR_REASONS = new Map([
    ["ENOTFOUND", "infra_dns"],
    ["EAI_AGAIN", "infra_dns"],
    ["ECONNREFUSED", "infra_refused"]
]);
// Returns { code, reason } for an infra error, else null. Reads err.code, then
// err.cause?.code. Only the errno is kept: the raw message/stack is never
// logged or forwarded for this class (sentinel rule).
function classifyInfraError(err) {
    for (const code of [err?.code, err?.cause?.code]) {
        if (typeof code === "string" && INFRA_ERROR_REASONS.has(code)) return { code, reason: INFRA_ERROR_REASONS.get(code) };
    }
    return null;
}
const isInfraReason = (reason) => reason === "infra_dns" || reason === "infra_refused";
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
// resolver (profile base + per-model firstByteTimeoutMs + GATEWAY_* env
// overrides, per knob). Called once per
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
function resolveRequestTimeouts(requestedModelId) {
    const profile = performanceMode.resolve(requestedModelId);
    return {
        firstByteTimeoutMs: profile.firstByteTimeoutMs,
        idleTimeoutMs: profile.idleTimeoutMs,
        maxStreamDurationMs: profile.maxStreamDurationMs,
        retryFirstByteTimeoutMs: resolveRetryFirstByteTimeoutMs(profile.firstByteTimeoutMs)
    };
}
// B2: the /v1/models fetch previously had NO bounded upstream timeout and NO
// abort on client disconnect (unlike the chat path's socket timeouts and
// funnel abort). It now reuses DEFAULT_FIRST_BYTE_TIMEOUT_MS from
// upstream-timeouts.mjs — the same JSDoc'd default (5 min) the chat path starts
// from — rather than inventing a new magic number. Deliberately NOT
// performanceMode.resolve()'s per-request value: that profile is per-request
// only via the chat failover loop's opts, while the timeout itself lives at the
// socket layer, so the models fetch is bounded by the shared default.
const MODELS_UPSTREAM_TIMEOUT_MS = DEFAULT_FIRST_BYTE_TIMEOUT_MS;
// F4: how long a request whose body is already KNOWN to be oversized may spend
// draining before we destroy the socket. This is NOT a normal client timeout —
// it only bounds a client that keeps sending after we answered 413 (or stalls
// mid-upload); a client that stops promptly finishes its upload well inside it.
// Chosen at 10s: Node's own server default first-byte window is 60s
// (server.headersTimeout) and the gateway's own upstream default is 5 min, so a
// slow-but-honest upload is not cut off, while a hostile never-finishing body
// cannot hold the socket for those 300s. Same unit/constant style as
// DURABLE_ACK_TIMEOUT_MS (5_000) in rotation.mjs.
const OVERSIZED_REQUEST_DRAIN_TIMEOUT_MS = 10_000;
// Tracks the drain-safety timer per inbound request so the normal data/end
// listeners can clear AND unschedule it (an extra WeakMap key is not a listener
// and holds nothing past the request's own lifetime).
const oversizedRequestTimers = new WeakMap();

// F4: arm a bounded safety timer for a request we are DRAINING after answering
// 413. We deliberately do NOT destroy the request just because the response
// finished (that race was the defect): the client must be allowed to finish
// sending and read the 413. The only thing this timer guards is a client that
// NEVER finishes — at which point destroying the socket is correct and no
// longer destructive to an honest client. `unref()` so the timer can never hold
// the event loop open (parity with the cacheWarmTimer/modelsRefreshInterval).
function armOversizedRequestSafetyTimer(req, res, responseMode) {
    if (oversizedRequestTimers.has(req)) return oversizedRequestTimers.get(req);
    const timer = setTimeout(() => {
        oversizedRequestTimers.delete(req);
        if (req.complete) return; // client finished sending; the socket is reusable
        warn("Oversized request drain timed out; destroying socket", {
            path: responseMode === "messages" ? "/v1/messages" : (responseMode === "responses" ? "/v1/responses" : "/v1/chat/completions"),
            timeoutMs: OVERSIZED_REQUEST_DRAIN_TIMEOUT_MS
        });
        req.destroy();
    }, OVERSIZED_REQUEST_DRAIN_TIMEOUT_MS);
    timer.unref();
    oversizedRequestTimers.set(req, timer);
    return timer;
}

function clearOversizedRequestSafetyTimer(req) {
    const timer = oversizedRequestTimers.get(req);
    if (!timer) return;
    clearTimeout(timer);
    oversizedRequestTimers.delete(req);
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
    return performanceMode.resolve(modelId).maxFailoverAttempts;
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

function poolWideFailureMessage(statusCode, partialCoverage = false, deadlineCut = false) {
    // §12.9.4: without a full answer from EVERY key of the circle, the real
    // status is kept (Р6) but no all-keys claim is made. The wording names the
    // real cause: a deadline cut, or keys that hung up / timed out / were unreachable.
    if (partialCoverage && deadlineCut) return "Upstream returned HTTP " + statusCode + "; not every key answered before the request deadline.";
    if (partialCoverage) return "Upstream returned HTTP " + statusCode + "; some keys could not be reached or did not answer.";
    if (statusCode === 429) return "Upstream rate limit: every available key is currently rate-limited.";
    if (statusCode === 500) return "Upstream error: every available key returned an internal server error (500).";
    if (statusCode === 502) return "Upstream error: every available key returned a bad gateway (502).";
    if (statusCode === 503) return "Upstream error: every available key is unavailable (503).";
    if (statusCode === 504) return "Upstream error: every available key timed out (504).";
    return "Upstream returned HTTP " + statusCode + " for every available key.";
}

// Owner 28.09 ("the client must see the truth"): plain-English kind of one
// failed attempt, built ONLY from the synthetic reason / real status code (never
// from upstream bodies, error messages or key ids).
function failedAttemptKind(result) {
    const reason = typeof result?.reason === "string" ? result.reason : "";
    if (reason.startsWith("http_") && Number.isInteger(result.statusCode)) return "returned HTTP " + result.statusCode;
    if (reason === "timeout" || reason === "idle_timeout") return "did not answer in time";
    if (reason === "request_deadline") return "was cut by the request deadline";
    if (reason === "socket_hang_up" || reason === "upstream_stream_error") return "dropped the connection";
    if (isInfraReason(reason)) return "could not be reached";
    if (reason === "incomplete_stream") return "ended the stream early";
    if (reason === "upstream_sse_error") return "sent a stream error";
    return "failed";
}

// "3 keys tried: 1 returned HTTP 500, 1 returned HTTP 429, 1 did not answer in time."
// Counts are per attempt; when a key was retried the attempt total is shown too.
function describeFailedAttempts(kinds, keysTried) {
    const counts = new Map();
    for (const kind of kinds) counts.set(kind, (counts.get(kind) || 0) + 1);
    const parts = [...counts].map(([kind, count]) => count + " " + kind);
    const head = keysTried + (keysTried === 1 ? " key" : " keys") + " tried"
        + (kinds.length !== keysTried ? " (" + kinds.length + (kinds.length === 1 ? " attempt)" : " attempts)") : "");
    return parts.length > 0 ? head + ": " + parts.join(", ") + "." : head + ".";
}

// Propagate a pool-wide upstream status (every attempted key returned the SAME
// retryable status) instead of a generic 502. For 429 we supply our own
// Retry-After (NVIDIA sends none) so clients can honor a sane backoff. Non-429
// statuses (e.g. 500 with a non-NVCF signature) are passed through as-is.
// CR9-001: one body writer for the gateway-generated failover exits, per
// response mode. Body only: callers have already done all failover and key
// accounting. Anthropic keeps its envelope and plain headers; chat keeps the
// historical `{ error: "<string>" }`; the Responses facade gets the OpenAI
// error object Codex parses (`error.code` on 429/503, `error.type`). Chat and
// Responses headers pass through capResponseHeaders exactly as before. `extra`
// (e.g. the 502 `detail`) is appended at the top level in every mode.
function writeFacadeError(res, mode, status, headers, message, extra = {}, anthropicType = "api_error") {
    if (mode === "anthropic") {
        res.writeHead(status, headers);
        res.end(JSON.stringify({ type: "error", error: { type: anthropicType, message }, ...extra }));
        return;
    }
    res.writeHead(status, capResponseHeaders(headers));
    if (mode === "responses") {
        const rateLimited = status === 429;
        res.end(JSON.stringify({
            error: {
                message,
                type: rateLimited ? "rate_limit_error" : "server_error",
                param: null,
                code: rateLimited ? "rate_limit_exceeded" : null
            },
            ...extra
        }));
        return;
    }
    res.end(JSON.stringify({ error: message, ...extra }));
}

// An upstream error body is THIRD-PARTY text echoed to the client. On the
// non-SSE paths it used to be forwarded unbounded and unscrubbed: MEASURED, a
// 1 MB upstream message produced a 1,000,083-byte client body, and `nvapi-...`
// plus `?token=...` reached the client verbatim on chat, /v1/messages AND
// /v1/responses. A CLEAN, bounded body still passes through BYTE-IDENTICALLY
// (clients and tests depend on the upstream envelope), so the rewrite triggers
// only on the two conditions below.
const MAX_ECHOED_UPSTREAM_ERROR_BYTES = 4 * 1024;

/** The upstream's own message string, or null when the body carries none. */
function upstreamErrorMessage(upstreamBody) {
    if (typeof upstreamBody !== "string" || upstreamBody.trim() === "") return null;
    let parsed;
    try {
        parsed = JSON.parse(upstreamBody);
    } catch {
        return upstreamBody.trim();
    }
    // Same precedence the Anthropic/Responses builders always used: the
    // OpenAI-shaped `error.message` first, then a string `error`, then a
    // top-level `message`.
    const candidates = [
        parsed?.error && typeof parsed.error === "object" ? parsed.error.message : undefined,
        typeof parsed?.error === "string" ? parsed.error : undefined,
        parsed?.message
    ];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
    return null;
}

/**
 * Does this upstream body need rebuilding before it reaches the client?
 * Two reasons only: it exceeds the echo bound, or scrubbing CHANGES the
 * message (a credential shape, a stack frame, a relative-url query). The
 * detector is the sanitizer itself: a clean message round-trips unchanged, so
 * the ordinary upstream envelope keeps its historical byte-identical
 * passthrough.
 *
 * Pass 3 (defect 3): the check is SHAPE-AGNOSTIC. MEASURED, a FastAPI
 * `{"detail": ...}`, a nested `{"error":{"detail":...}}` and a non-string
 * `error.message` matched none of the recognized message slots, so the chat
 * path declared the body clean and proxied `nvapi-...` plus `?token=...`
 * verbatim while /v1/messages and /v1/responses scrubbed the same input.
 */
// CRF-001: `sanitizeUpstreamErrorMessage` also collapses whitespace, so a clean
// multi-line message (Pydantic, FastAPI) always "changed". Compare against the
// whitespace-normalized original: only a real scrub (credential, stack frame,
// url query, length cap) counts.
function scrubChangesText(text) {
    return sanitizeUpstreamErrorMessage(text) !== text.replace(/\s+/g, " ").trim();
}

function upstreamErrorEchoNeedsRewrite(upstreamBody) {
    if (typeof upstreamBody !== "string") return false;
    if (Buffer.byteLength(upstreamBody, "utf8") > MAX_ECHOED_UPSTREAM_ERROR_BYTES) return true;
    let parsed;
    try { parsed = JSON.parse(upstreamBody); } catch { parsed = undefined; }
    if (parsed && typeof parsed === "object") {
        // A JSON body is judged by EVERY leaf (and every key), never by the
        // recognized message slot alone: a clean `error.message` next to
        // `error.detail: "nvapi-..."` or `api_key: "..."` used to short-circuit
        // here and reach the client verbatim.
        const state = { changed: false };
        scrubUpstreamErrorLeaves(parsed, state);
        return state.changed;
    }
    // Plain-text body: the text itself is the message.
    const message = upstreamErrorMessage(upstreamBody);
    return scrubChangesText(message !== null ? message : upstreamBody);
}

// Keys that NAME a credential. A value under one of them is a credential by
// construction, whatever its shape, so it is replaced wholesale. This is what
// catches `{"api_key":"abcdefgh"}` (short, no marker) that a text-level scrub
// cannot see. Ordinary error keys (`detail`, `msg`, `type`, `loc`) never match,
// so a clean FastAPI envelope keeps its exact wording.
const CREDENTIAL_LEAF_KEY = /^(?:authorization|proxy-authorization|x-api-key|api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|secret|client[-_]?secret|password|cookie|set-cookie|gatewaytoken|admintoken|localkey)$/i;

/**
 * Scrub every string leaf of a parsed upstream error body IN PLACE (returns a
 * new value; `state.changed` reports whether anything differed). Used for the
 * shapes the recognized-message extractor cannot name, so the upstream
 * envelope survives while the credential does not.
 */
// True when a KEY name itself carries a credential (nvapi-?, Bearer ?, a
// credential pair). Deliberately narrower than scrubChangesText: url query and
// stack-frame stripping are prose rules and must not rename ordinary keys.
function keyCarriesCredential(key) {
    if (typeof key !== "string" || key.length === 0) return false;
    if (/nvapi-[A-Za-z0-9_-]{4,}/i.test(key)) return true;
    if (/\bbearer\s+\S{6,}/i.test(key)) return true;
    const sanitized = sanitizeUpstreamErrorMessage(key);
    return /\[REDACTED\]/.test(sanitized) && !/\[REDACTED\]/.test(key);
}

function scrubUpstreamErrorLeaves(value, state) {
    if (typeof value === "string") {
        if (value.trim() === "") return value;
        // CRF-001: whitespace collapse alone is not a scrub; a clean multi-line
        // leaf keeps its exact text (newlines included).
        if (!scrubChangesText(value)) return value;
        state.changed = true;
        return sanitizeUpstreamErrorMessage(value);
    }
    if (Array.isArray(value)) return value.map((item) => scrubUpstreamErrorLeaves(item, state));
    if (value && typeof value === "object") {
        const result = {};
        let redactedKeys = 0;
        for (const [key, item] of Object.entries(value)) {
            // A credential-NAMED key is a credential whatever its value shape:
            // numbers, objects and arrays under `api_key`/`token` are replaced too.
            if (CREDENTIAL_LEAF_KEY.test(key) && item !== null && item !== undefined && item !== "") {
                state.changed = true;
                result[key] = "[REDACTED]";
                continue;
            }
            // A credential can be a KEY too (`{"detail":{"nvapi-...":1}}`): scrub
            // key names with the same text rule as values.
            // Only a key that actually CARRIES a credential is renamed. The general
            // text scrub also strips url query/fragments, which would rename a
            // harmless prose key like "is it /v1/chat?"; use the credential test.
            let safeKey = key;
            if (keyCarriesCredential(key)) {
                state.changed = true;
                redactedKeys += 1;
                safeKey = "[REDACTED_KEY_" + redactedKeys + "]";
            }
            result[safeKey] = scrubUpstreamErrorLeaves(item, state);
        }
        return result;
    }
    return value;
}

/** Bounded + scrubbed message text for a rewritten echo. */
function safeUpstreamErrorMessage(upstreamBody, statusCode) {
    const message = upstreamErrorMessage(upstreamBody);
    return message !== null ? sanitizeUpstreamErrorMessage(message) : "Upstream returned status " + statusCode;
}

// Responses facade, non-retryable upstream non-2xx: an OpenAI-shaped error
// (`error.message` string) passes through verbatim while it is clean and
// bounded; anything else (string `error`, plain text, empty, oversized or
// credential-bearing) is rebuilt as the OpenAI error object so Codex can parse
// it. Returns the body to write, or null to keep the passthrough.
function buildResponsesUpstreamError(statusCode, upstreamBody) {
    let parsed;
    try { parsed = JSON.parse(upstreamBody); } catch { parsed = undefined; }
    const openAiShaped = Boolean(parsed && typeof parsed === "object" && parsed.error && typeof parsed.error === "object"
        && typeof parsed.error.message === "string");
    if (openAiShaped && !upstreamErrorEchoNeedsRewrite(upstreamBody)) return null;
    const text = typeof upstreamBody === "string" ? upstreamBody.trim() : "";
    const message = text ? safeUpstreamErrorMessage(upstreamBody, statusCode) : "Upstream returned status " + statusCode;
    return JSON.stringify({ error: { message, type: statusCode < 500 ? "invalid_request_error" : "server_error", param: null, code: null } });
}

// Chat passthrough keeps the historical verbatim upstream body while it is
// clean and bounded; otherwise the message is scrubbed and re-wrapped in the
// chat error envelope (`{ error: "<string>" }`), exactly like every other
// gateway-generated chat error.
//
// Pass 3 (defect 3): a body whose message slot is unrecognized (`detail`,
// `error.detail`, non-string `error.message`) keeps ITS OWN envelope instead of
// being flattened -- every string leaf is scrubbed and credential-NAMED leaves
// are replaced wholesale -- so a clean FastAPI error still reads like the
// upstream wrote it while the secret cannot survive.
function chatUpstreamErrorEcho(upstreamBody, statusCode) {
    if (!upstreamErrorEchoNeedsRewrite(upstreamBody)) return upstreamBody;
    // CRF-001: a bounded JSON object keeps ITS OWN envelope (the OpenAI
    // `{error:{message,type,code,param}}` keeps `type`/`code`); only the
    // string leaves are scrubbed. Oversized or non-object bodies are flattened.
    if (Buffer.byteLength(upstreamBody, "utf8") <= MAX_ECHOED_UPSTREAM_ERROR_BYTES) {
        let parsed;
        try { parsed = JSON.parse(upstreamBody); } catch { parsed = undefined; }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return JSON.stringify(scrubUpstreamErrorLeaves(parsed, { changed: false }));
        }
    }
    return JSON.stringify({ error: safeUpstreamErrorMessage(upstreamBody, statusCode) });
}

// Pass 3 (defect 1): when the body is REWRITTEN its length is no longer the
// upstream's. Forwarding the upstream `content-length` truncated every rewritten
// chat error at the old length (MEASURED: 94 B upstream -> 39 B + ECONNRESET;
// 5,443 B -> 314 B + abort). The framing headers are dropped so Node derives
// them from the bytes actually written; `capResponseHeaders` keeps its job.
function headersForRewrittenBody(headers) {
    const result = capResponseHeaders(headers);
    if (!result || typeof result !== "object") return result;
    for (const key of Object.keys(result)) {
        const lower = key.toLowerCase();
        if (lower === "content-length" || lower === "transfer-encoding") delete result[key];
    }
    return result;
}

function writePoolWideFailure(res, statusCode, responseMode, retryAfterSeconds, partialCoverage = false, deadlineCut = false) {
    const message = poolWideFailureMessage(statusCode, partialCoverage, deadlineCut);
    const headers = { "Content-Type": "application/json" };
    if (statusCode === 429) {
        const retryAfter = Math.max(1, Math.min(60, Math.ceil(Number(retryAfterSeconds) || 0)));
        headers["Retry-After"] = String(retryAfter);
    }
    const anthropicType = statusCode === 429 ? "rate_limit_error" : (statusCode >= 500 ? "overloaded_error" : "api_error");
    writeFacadeError(res, responseMode, statusCode, headers, message, {}, anthropicType);
}

function proxyRequestWithFailover(req, res, bodyBuffer, isStream, onKeyIdChange, opts = {}) {
    return new Promise((resolve) => {
        let attempt = 0;
        const activeCount = getKeys().filter((k) => k.status === "active").length;
        const requestedModelId = typeof opts.model === "string" ? opts.model : undefined;
        // Initial eligible coverage establishes the configured attempt floor.
        // Selection itself re-reads the current eligible IDs on every attempt,
        // so concurrent removal, activation, and cooldown expiry are respected.
        const modelEligibleKeyCount = getModelEligibleKeyCount(requestedModelId);
        // Zero-eligible (every key model-cooled) still means the ACTIVE pool is
        // covered floor — the request walks cooled keys (fast upstream confirms)
        // before any pool-wide verdict may answer.
        const coverageFloor = Number.isSafeInteger(modelEligibleKeyCount) && modelEligibleKeyCount > 0
            ? modelEligibleKeyCount
            : Math.max(1, activeCount);
        // OWNER RULE: the attempt budget must cover the keys this request may use
        // (the model's eligible set, else the whole active pool). A profile/env
        // cap BELOW that coverage is raised to it — rotation stays circular.
        const configuredMaxAttempts = resolveMaxFailoverAttempts(
            process.env,
            activeCount,
            resolveConfiguredMaxFailoverAttempts(requestedModelId),
            coverageFloor
        );
        // Per-request upstream timeout profile (day/night/auto + GATEWAY_* env
        // overrides), resolved once for THIS request's model — a per-model
        // performanceMode entry applies here — so a mid-request "auto"
        // transition can never change the budget between failover attempts of
        // THIS request.
        const requestTimeouts = resolveRequestTimeouts(requestedModelId);
        // TOTAL wall-clock deadline shared by EVERY failover attempt of THIS
        // request (absolute timestamp so all attempts see the same bound). Once it
        // passes, tryNext stops starting NEW pre-commit attempts and answers an
        // honest 504 while the client is still listening (only before commit;
        // a committed stream remains governed by its own idle/max duration). Resolved
        // once here: valid GATEWAY_REQUEST_DEADLINE_MS > app setting
        // config.json requestDeadlineMs (re-read per request) > 240s default.
        const requestDeadlineAt = Date.now() + resolveRequestDeadlineMs(process.env, readConfiguredRequestDeadlineMs());
        // §12.9.2: set once an attempt ends with the shared request_deadline cut.
        // Node timers may fire ~1ms BEFORE requestDeadlineAt, so the clock alone
        // could say "not yet" and start another ~1ms attempt; this flag makes the
        // cut final for the request (no further upstream attempts, one 504).
        let deadlineFired = false;
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
        // Keys attempted in the CURRENT circular pass. This resets only after
        // the request has tried the full eligible-key snapshot, so a larger
        // attempt budget starts another fair pass instead of letting the latest
        // sticky assignment monopolize every remaining retry.
        const cycleAttemptedKeyIds = new Set();
        const discoveredKeyIds = new Set();
        // Both sets are PER PASS: cleared together with cycleAttemptedKeyIds.
        // completedKeyIds (§12.9.2): keys of the current pass whose attempt ended
        // for its OWN reason (success, upstream status, idle, socket error, ...),
        // i.e. anything except the shared request_deadline cut. Drives the log
        // field `coverage`: false only when the circle was not finished.
        const completedKeyIds = new Set();
        // answeredKeyIds (§12.9.4): keys of the current pass that returned a real
        // success or a REAL full upstream HTTP status. Drives circleAnswered, the
        // only gate for a uniform / pool-wide verdict.
        const answeredKeyIds = new Set();
        // idleKeyIds (owner decision 1a, 27.09): keys of the current pass whose
        // attempt ended by a PRE-COMMIT socket idle or a first-byte timeout
        // (upstream silent before the answer started). A pass made only of such
        // keys ends the request with the neutral 503 instead of repeating keys
        // up to the attempt floor. Network/DNS errors are not included (Э3).
        const idleKeyIds = new Set();
        // REQUEST-level, never cleared: set once any attempt failed retryably for
        // a non-silent reason. Such a request keeps its pre-1a verdict (Э3 scope).
        let nonSilentSeen = false;
        // circleEverCompleted (§12.9.2): REQUEST-level, never cleared. Set when a
        // pass finishes with every key in completedKeyIds (checked before the
        // per-pass clear), so `coverage` stays true even if a later pass is cut.
        let circleEverCompleted = false;
        // REQUEST-level: one plain-English kind per failed retryable attempt (no key
        // ids, no upstream bodies). Feeds only the generic 502 `detail` field.
        const attemptKinds = [];
        // REQUEST-level (decision 2a): last per-pass outcome of every attempted
        // key, read only once that key has left the live pool (see tryNext).
        const removedKeyMarks = new Map();

        // A pool-wide verdict requires: every recorded upstream failure carried the
        // SAME status, that status can describe the whole pool (not a per-key signal
        // such as 401/403 or an NVCF dispatch 404), and enough DISTINCT keys were
        // tried to cover the reachable portion of the pool (bounded by maxAttempts).
        // Returns null otherwise. See resolvePoolWideFailureStatus in failover-policy.mjs.
        const poolWideVerdict = (coverage, attemptLimit) => resolvePoolWideFailureStatus(seenFailedStatuses, attemptedKeyIds.size, attemptLimit, coverage);

        // Confirming attempts required before a UNIFORM 429 is answered honestly.
        // NVIDIA scopes a 429 to the MODEL, so every key answers the same way and
        // covering the pool cannot succeed — see the note in failover-policy.mjs.
        const rateLimitMaxAttempts = resolveRateLimitMaxAttempts(process.env, resolveConfiguredRateLimitMaxAttempts(requestedModelId));

        const tryNext = () => {
            // A client that has gone away cannot receive a new attempt. In
            // particular, a timeout callback must never restart the loop after
            // the response has been closed by the client.
            if (res.destroyed || req.aborted || req.socket?.destroyed) {
                resolve({ success: false, retryable: false, reason: "client_aborted" });
                return;
            }
            const currentEligibleKeyIds = getCurrentEligibleKeyIds(requestedModelId);
            for (const id of currentEligibleKeyIds) discoveredKeyIds.add(id);
            const currentUnattemptedKeyIds = currentEligibleKeyIds.filter((id) => !cycleAttemptedKeyIds.has(id));
            // Decision 2a (cohort L): a key removed from the pool during this
            // request is never selected again, but its last outcome still counts
            // in every later pass's verdict (once, as one key of the circle). A
            // removed key that was never tried has no mark and simply drops out.
            // Verdict-only: rotation state/penalties are untouched.
            // Coverage counts key RECORDS (ids), not distinct secrets: a key string
            // removed and re-added mid-request gets a new UUID, so the old record's
            // mark still counts (owner rule 2a). A failed DELETE rolls back
            // (rotation.mjs mergeRollback) and can briefly re-expose the key; that
            // only shapes this verdict, never key accounting.
            const liveKeyIds = new Set(getKeys().map((candidate) => candidate.id));
            const removedMarkedKeyIds = [...removedKeyMarks.keys()].filter((id) => !liveKeyIds.has(id));
            for (const id of removedMarkedKeyIds) {
                const mark = removedKeyMarks.get(id);
                if (mark.completed) completedKeyIds.add(id);
                if (mark.answered) answeredKeyIds.add(id);
                if (mark.idle) idleKeyIds.add(id);
            }
            const currentPassIds = new Set([...cycleAttemptedKeyIds, ...currentEligibleKeyIds, ...removedMarkedKeyIds]);
            const passComplete = currentEligibleKeyIds.length > 0 && currentUnattemptedKeyIds.length === 0;
            // A newly added/activated/recovered key expands the bounded request
            // budget so it joins this pass before any reuse. Pool size is capped.
            const maxAttempts = Math.max(configuredMaxAttempts, discoveredKeyIds.size);
            // Two independent early-stop reasons, both requiring at least one attempt:
            //  - rateLimitStop: fires only after a full pass: every eligible key of the
            //    current pass was tried and every recorded upstream failure was 429
            //    (passComplete + shouldEarlyStopOnRateLimit distinct-key coverage).
            //  - coverageVerdict: the pre-existing rule — every attempted key returned
            //    the SAME pool-wide-capable status and the reachable pool is covered.
            //    Still the only early stop for 500/502/503/504/529.
            // Confirming attempts are bounded by the keys this MODEL may use, so
            // the verdict is never declared before its own eligible keys (sticky
            // key first) have answered. Model-less callers pass undefined and
            // keep the historical pool-wide rule.
            // The 429 stop requires REAL coverage: every key this request may use
            // has been attempted and answered 429 (owner rule — distinct keys and
            // the snapshot decide, not a small confirming count). When the model's
            // eligible snapshot is 0 (every key model-cooled by an earlier wave),
            // the verdict's coverage is the ACTIVE POOL — `coverageFloor` — so the
            // cooled keys are re-probed fast before any pool-wide answer goes out.
            const currentCoverage = currentPassIds.size;
            const rateLimitStop = attempt > 0 && passComplete && shouldEarlyStopOnRateLimit(
                seenFailedStatuses,
                rateLimitMaxAttempts,
                currentCoverage,
                [...attemptedKeyIds].filter((id) => currentPassIds.has(id)).length
            );
            const coverageVerdict = attempt > 0 && passComplete ? poolWideVerdict(currentCoverage, maxAttempts) : null;
            if (attempt === 0 && currentEligibleKeyIds.length === 0) {
                // Only-initial-check path: NO key was available on the FIRST
                // attempt — this is not a failover exhaustion (nothing was
                // tried), so the honest answer is the empty-pool 503, never a
                // 502 "All failover attempts exhausted" with attempts:0. The
                // 403/401-parked and admin-disabled cases land here too; the
                // bounded park windows are reclaimed on their own schedule and
                // a later request re-reads eligibility.
                warn("No API keys available on first attempt", {
                    attempts: attempt,
                    keysTried: attemptedKeyIds.size,
                    activeKeys: activeCount
                });
                if (!res.headersSent) {
                    const retryAfter = String(getRetryAfterSecondsForModel(requestedModelId));
                    writeFacadeError(res, opts.responseMode, 503, { "Content-Type": "application/json", "Retry-After": retryAfter }, "All API keys exhausted");
                }
                resolve({ success: false });
                return;
            }
            // TOTAL request deadline: once the shared wall-clock budget is spent,
            // stop starting NEW (pre-commit) attempts and answer honestly below,
            // rather than rotate keys into a client that has already given up. This
            // predicate NEVER runs on a committed stream — tryNext only runs before
            // a response is committed to the client.
            const deadlineExceeded = deadlineFired || Date.now() >= requestDeadlineAt;
            // Decision 1a: one distinct pass in which EVERY key went silent before
            // commit (idle or first-byte timeout) is final — no second pass, neutral 503 below. A deadline cut
            // (request_deadline) never lands in idleKeyIds, so Э1's 504 stays.
            const idleRound = attempt > 0 && passComplete && currentPassIds.size > 0 && [...currentPassIds].every((id) => idleKeyIds.has(id)) && !nonSilentSeen;
            if (currentEligibleKeyIds.length === 0 || attempt >= maxAttempts || coverageVerdict !== null || rateLimitStop || deadlineExceeded || idleRound) {
                // A uniform-429 stop IS a pool-wide verdict about this model, so the
                // honest 429 is emitted through the same writePoolWideFailure path
                // (consistent Retry-After and log shape). It fires only after a full
                // pass: every eligible key of the current pass was tried and every
                // recorded upstream failure was 429.
                const poolWideStatus = rateLimitStop ? RATE_LIMIT_STATUS : poolWideVerdict(currentCoverage, maxAttempts);
                // §12.9.4: a uniform / pool-wide claim needs a full answer from EVERY
                // key of the circle: only a real success or a real upstream HTTP status
                // counts (answeredKeyIds); synthetic/deadline-cut outcomes never do.
                const circleAnswered = currentPassIds.size > 0 && [...currentPassIds].every((id) => answeredKeyIds.has(id));
                // §12.9.2: the circle is finished when every key of the current pass
                // ended for its own reason (completedKeyIds); only a deadline cut
                // leaves it unfinished.
                const circleCompleted = currentPassIds.size > 0 && [...currentPassIds].every((id) => completedKeyIds.has(id));
                error("All failover attempts exhausted", {
                    attempts: attempt,
                    poolWide: poolWideStatus !== null && circleAnswered,
                    upstreamStatus: poolWideStatus,
                    // Distinguishes "stopped because the pool's answer is already
                    // established" from "ran out of the configured attempt budget".
                    earlyStop: (rateLimitStop || coverageVerdict !== null || deadlineExceeded || idleRound) && attempt < maxAttempts,
                    // Which rule ended the loop, so an honest 429 / deadline / idle round stays diagnosable.
                    earlyStopReason: rateLimitStop && circleAnswered ? "uniform_rate_limit" : (coverageVerdict !== null && circleAnswered && attempt < maxAttempts ? "pool_coverage" : (deadlineExceeded ? "request_deadline" : (idleRound ? "idle_round" : undefined))),
                    // Was the distinct key circle finished in THIS request (any
                    // earlier pass, or the current one), i.e. every key ended for
                    // its own reason, not cut by request_deadline? Not a pool-wide claim.
                    coverage: circleEverCompleted || circleCompleted,
                    rateLimitMaxAttempts,
                    keysTried: attemptedKeyIds.size,
                    activeKeys: activeCount
                });
                if (!res.headersSent) {
                    if (poolWideStatus !== null) {
                        // Model-scoped Retry-After: for a model-wide 429 wave the honest
                        // wait is when THIS model's keys come back, not the pool's.
                        // Р6: the real status is kept even when the circle was cut; only the
                        // all-keys wording is dropped (partialCoverage).
                        writePoolWideFailure(res, poolWideStatus, opts.responseMode, getRetryAfterSecondsForModel(requestedModelId), !circleAnswered, deadlineExceeded);
                    } else if (deadlineExceeded) {
                        // TOTAL request deadline hit before any key committed a response:
                        // answer an honest 504 (gateway timeout) NOW, while the client is
                        // still listening. Distinct STATUS and reason from the 502
                        // "attempts exhausted" path below so "ran out of time" is never
                        // confused with "ran out of keys".
                        const retryAfter = String(getRetryAfterSecondsForModel(requestedModelId));
                        writeFacadeError(res, opts.responseMode, 504, { "Content-Type": "application/json", "Retry-After": retryAfter },
                            "Gateway request deadline exceeded", {}, "request_timeout");
                    } else if (idleRound) {
                        // Decision 1a: every distinct key went silent before the answer
                        // started — a neutral 503 (no all-keys / rate-limit claim, no raw
                        // error detail), never the generic 502.
                        const retryAfter = String(getRetryAfterSecondsForModel(requestedModelId));
                        writeFacadeError(res, opts.responseMode, 503, { "Content-Type": "application/json", "Retry-After": retryAfter },
                            "Upstream temporarily unavailable");
                    } else {
                        // Retry-After is already the time until the soonest key is
                        // usable again (rotation.mjs getRetryAfterSecondsForModel, 1..20 s).
                        const retryAfter = String(getRetryAfterSecondsForModel(requestedModelId));
                        // Owner 28.09 ("the client must see the truth"): additive,
                        // key-free summary of what the keys actually did.
                        const detail = describeFailedAttempts(attemptKinds, attemptedKeyIds.size);
                        writeFacadeError(res, opts.responseMode, 502, { "Content-Type": "application/json", "Retry-After": retryAfter },
                            "All failover attempts exhausted", { detail });
                    }
                }
                resolve({ success: false });
                return;
            }

            if (passComplete) {
                // §12.9.2: remember a finished circle BEFORE the per-pass clear, so
                // a later pass cut by request_deadline cannot erase it.
                if (currentPassIds.size > 0 && [...currentPassIds].every((id) => completedKeyIds.has(id))) circleEverCompleted = true;
                cycleAttemptedKeyIds.clear();
                completedKeyIds.clear();
                answeredKeyIds.clear();
                idleKeyIds.clear();
                currentUnattemptedKeyIds.push(...currentEligibleKeyIds);
            }

            // PER-MODEL selection: the model reuses its own sticky key, skips keys
            // cooling down for it, and prefers a key no other active model holds.
            // Keep the first pass circular: a sticky assignment is honored on
            // attempt one, then every attempted key is excluded until the
            // request has covered its eligible-key snapshot. Only an explicitly
            // larger attempt budget can start a second pass and reuse keys.
            const unattemptedSet = new Set(currentUnattemptedKeyIds);
            const excludedKeyIds = new Set(getKeys().map((candidate) => candidate.id).filter((id) => !unattemptedSet.has(id)));
            const key = getNextKey(requestedModelId, { excludedKeyIds });
            if (!key) {
                warn("No available keys to service request");
                if (!res.headersSent) {
                    const retryAfter = String(getRetryAfterSecondsForModel(requestedModelId));
                    writeFacadeError(res, opts.responseMode, 503, { "Content-Type": "application/json", "Retry-After": retryAfter }, "All API keys exhausted");
                }
                resolve({ success: false });
                return;
            }

            attempt++;
            attemptedKeyIds.add(key.id);
            cycleAttemptedKeyIds.add(key.id);
            if (onKeyIdChange) onKeyIdChange(key.id);

            proxyRequest(req, res, key, bodyBuffer, isStream, (result) => {
                // §12.9.2: the attempt "completed" when it ended for its own reason,
                // i.e. anything but the shared request_deadline cut (log `coverage`).
                if (result?.reason !== "request_deadline") completedKeyIds.add(key.id);
                else deadlineFired = true;
                // §12.9.4: a key "answered" only with a real success or a REAL full
                // upstream HTTP status (same condition as seenFailedStatuses below).
                // Synthetic outcomes (socket hang-up, first-byte/idle timeout,
                // request_deadline) never count toward the uniform/pool-wide gate.
                const realHttpStatus = typeof result?.reason === "string" && result.reason.startsWith("http_") && Number.isInteger(result.statusCode);
                if (result?.success || realHttpStatus) answeredKeyIds.add(key.id);
                // Decision 1a: "silent before the answer starts" = the retryable
                // (pre-commit) idle outcome OR the first-byte timeout (reason
                // "timeout"). Stop condition only: key accounting is unchanged
                // (idle: no penalty; first-byte: its existing handleKeyError).
                // Э3: a connect-time infra failure (DNS / refused) is "silent" too:
                // the key never answered, so it joins the 1a round and never sets
                // nonSilentSeen.
                if (result?.retryable === true && (result.reason === "idle_timeout" || result.reason === "timeout" || isInfraReason(result.reason))) idleKeyIds.add(key.id);
                // Any other retryable failure (socket hang-up, stream error, real
                // HTTP status, ...) makes the request non-silent for good, so a
                // later pass that only holds the silent keys (the failed one backed
                // off) never becomes an idle round. Non-retryable results resolve
                // just below and never reach another pass.
                else if (result?.retryable === true && result.reason !== "request_deadline") nonSilentSeen = true;
                removedKeyMarks.set(key.id, { completed: completedKeyIds.has(key.id), answered: answeredKeyIds.has(key.id), idle: idleKeyIds.has(key.id) });
                if (result.success || !result.retryable) {
                    resolve(result);
                } else {
                    attemptKinds.push(failedAttemptKind(result));
                    // Only REAL upstream HTTP statuses (reason prefixed "http_")
                    // participate in pool-wide detection. Gateway-side synthetic
                    // failures — first-byte timeout (504), socket hang-up (502),
                    // SSE error (500) — are NOT an upstream decision and must not
                    // be mistaken for the pool having returned one status.
                    if (typeof result.reason === "string" && result.reason.startsWith("http_") && Number.isInteger(result.statusCode)) {
                        seenFailedStatuses.push(result.statusCode);
                    }
                    // A request_deadline cut is final (deadlineFired): tryNext goes
                    // straight to the exhaustion/504 branch, so no retry is logged.
                    if (!deadlineFired) {
                        warn("Retrying with different key", {
                            attempt,
                            maxAttempts,
                            reason: result.reason
                        });
                    }
                    tryNext();
                }
            }, (() => {
                // Clamp BOTH per-attempt socket windows by the budget LEFT on the
                // TOTAL request deadline. Clamping idle too is the non-obvious part:
                // without it a single attempt's full idle window would eat the whole
                // deadline from the inside and the pre-attempt check at the top of
                // tryNext could never fire in time. Floor at 1ms so a near-expired
                // budget still yields a positive, immediately-firing socket timeout —
                // never 0, which Node treats as "no timeout". maxStreamDurationMs is
                // deliberately left UNCLAMPED: it governs an already-committed stream,
                // which the deadline must not tear (owner rule).
                const remainingMs = Math.max(1, requestDeadlineAt - Date.now());
                const baseFirstByteMs = attempt > 1
                    ? requestTimeouts.retryFirstByteTimeoutMs
                    : requestTimeouts.firstByteTimeoutMs;
                return {
                    ...opts,
                    ...requestTimeouts,
                    requestDeadlineAt,
                    unclampedIdleTimeoutMs: requestTimeouts.idleTimeoutMs,
                    firstByteTimeoutMs: Math.min(baseFirstByteMs, remainingMs),
                    idleTimeoutMs: Math.min(requestTimeouts.idleTimeoutMs, remainingMs),
                    // §12.9.2: a window cut down to the deadline budget fires AT the
                    // deadline; Node may fire it ~1ms early by the clock, so the
                    // timeout handler trusts these flags, not Date.now() alone.
                    firstByteClampedByDeadline: remainingMs <= baseFirstByteMs,
                    idleClampedByDeadline: remainingMs <= requestTimeouts.idleTimeoutMs
                };
            })());
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

class BufferedAnthropicSemanticError extends Error {
    constructor(details = {}) {
        super("Upstream returned an error envelope with HTTP 200");
        this.name = "BufferedAnthropicSemanticError";
        this.upstreamCode = safeSseField(details.code);
        this.upstreamType = safeSseField(details.type);
        this.upstreamStatusCode = safeStatusCode(details.status_code ?? details.status);
    }
}

class BufferedAnthropicMalformedSuccessError extends Error {
    constructor() {
        super("Upstream returned a malformed completion with HTTP 200");
        this.name = "BufferedAnthropicMalformedSuccessError";
    }
}

function validateBufferedAnthropicCompletion(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new BufferedAnthropicMalformedSuccessError();
    }
    if (value.error !== undefined && value.error !== null) {
        const details = typeof value.error === "object" && !Array.isArray(value.error) ? value.error : {};
        throw new BufferedAnthropicSemanticError(details);
    }
    const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
    if (!choice || typeof choice !== "object" || Array.isArray(choice)
        || !choice.message || typeof choice.message !== "object" || Array.isArray(choice.message)) {
        throw new BufferedAnthropicMalformedSuccessError();
    }
    return value;
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
        // Same boundary as the chat/Responses echoes: the upstream chose this
        // text, so it is bounded and scrubbed before it reaches the client.
        // The upstream message is extracted first so a clean message survives
        // verbatim (sanitizeUpstreamErrorMessage is a no-op on clean text).
        const candidate = upstreamErrorMessage(upstreamBody);
        if (candidate !== null) message = sanitizeUpstreamErrorMessage(candidate);
    }
    return { type: "error", error: { type: errorType, message } };
}

const OPENAI_INCOMPLETE_STREAM_ERROR = `data: ${JSON.stringify({
    error: {
        message: "Upstream stream ended before completion",
        type: "upstream_stream_error",
        code: "incomplete_stream"
    }
})}\n\ndata: [DONE]\n\n`;

function createSseObserver(onErrorEvent) {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let discardingOversizedFrame = false;
    let sawDone = false;
    // Upstream `usage` seen on the stream (OpenAI `include_usage` final chunk and
    // every variant that carries token counters). LAST value wins: the final
    // chunk is the authoritative one. `undefined` = the upstream never reported
    // usage, so request_outcome.tokens stays null instead of a fabricated 0.
    let usageTotalTokens;

    const recordUsage = (usage) => {
        if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
        const total = usage.total_tokens;
        if (Number.isSafeInteger(total) && total >= 0) { usageTotalTokens = total; return; }
        // Variant: counters split into prompt/completion with no total.
        const prompt = usage.prompt_tokens;
        const completion = usage.completion_tokens;
        if (Number.isSafeInteger(prompt) && prompt >= 0 && Number.isSafeInteger(completion) && completion >= 0) {
            usageTotalTokens = prompt + completion;
        }
    };

    const inspectFrame = (frame) => {
        // WHATWG SSE: a line ends at CRLF, LF or CR (a frame may start with the
        // CR/LF of an extra blank line).
        const lines = frame.split(/\r\n|\r|\n/);
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

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) recordUsage(parsed.usage);

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
                const separator = /(?:\r\n|\n|\r(?!\n))(?:\r\n|\n|\r)/.exec(remaining);
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
                const separator = /(?:\r\n|\n|\r(?!\n))(?:\r\n|\n|\r)/.exec(pending);
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
        // Owner 28.09 (Fix 1): call ONLY at upstream EOF. A pending frame that is
        // exactly one unterminated `data: [DONE]` line (SDK parsers accept it at
        // EOF) is the normal end: sawDone is set and the missing terminator is
        // returned so the client gets a well-formed frame. Any other pending tail
        // (partial JSON, garbage) returns null and keeps today's behavior.
        flushUnterminatedDone() {
            consume(decoder.end());
            if (discardingOversizedFrame) return null;
            const line = pending.replace(/^[\r\n]+|[\r\n]+$/g, "");
            if (!/^data: ?\[DONE\]$/.test(line)) return null;
            const lineBreak = pending.slice(pending.indexOf(line) + line.length);
            pending = "";
            sawDone = true;
            // WHATWG line ends (CRLF / LF / CR): two of them (line end + blank
            // line) already terminate the frame; one is doubled in its own style
            // (CR + CR never merges into a CRLF); none gets the LF terminator.
            const lineEnds = (lineBreak.match(/\r\n|\r|\n/g) || []).length;
            if (lineEnds >= 2) return "";
            return lineEnds === 0 ? "\n\n" : lineBreak;
        },
        get sawDone() {
            return sawDone;
        },
        // Streamed usage captured from the SSE frames, or undefined when the
        // upstream never reported any (callers must keep tokens null then).
        get usageTotalTokens() {
            return usageTotalTokens;
        }
    };
}

function checkFirstChunkForSseError(chunk) {
    if (!chunk) return false;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const trimmed = text.trim();
    if (!trimmed) return false;

    const lines = text.split(/\r\n|\r|\n/);
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

// Bounded memory for the pre-commit hold: benign frames upstream sends before
// its first meaningful byte are buffered (never forwarded) until the commit
// decision, so a keepalive flood cannot grow the gateway's footprint without
// bound. On overflow the stream commits and the buffer is flushed, preserving
// byte fidelity.
const MAX_PRECOMMIT_HOLD_BYTES = 64 * 1024;

// Pre-commit SSE gate for the OpenAI pass-through route (2026-09-16 incident).
// Extracts complete frames incrementally — the same framing rules as
// createSseObserver: a frame is parsed only after its blank-line delimiter
// arrives, oversized frames are discarded through their delimiter — and
// classifies each frame in order:
//   - an SSE error frame (named event: error, an "error" envelope, or the
//     top-level code/type error shapes from checkFirstChunkForSseError) is a
//     typed PRE-COMMIT failure: the caller fails over to the next key;
//   - the first MEANINGFUL frame (isOpenAiSseItemMeaningful: content/role/
//     tool_call/finish-bearing) commits the stream;
//   - everything else — keepalive comments, empty data lines, no-op deltas,
//     usage-only frames, [DONE] — is BENIGN.
//
// Level-1 Round C (defect C1) refined the benign rule. A benign frame used to be
// held until a later frame decided the verdict, and an upstream that ended after
// benign frames was treated as "nothing meaningful was sent" and retried — which
// dropped the held bytes and, with a single key, answered 502 "All failover
// attempts exhausted". A benign-only body is REAL upstream output, not an empty
// stream. The contract is now:
//   * the hold exists only until the first COMPLETE frame exists, so a frame
//     split across chunks still gets classified before anything is forwarded
//     (this is what keeps the error-first failover honest);
//   * `verdict.error` -> failover, unchanged;
//   * `verdict.meaningful` -> commit, unchanged;
//   * `verdict.benign` -> the held bytes are RELEASED to the client (the caller
//     commits and proxies them). Holding benign bytes indefinitely is what made
//     the first client chunk never arrive, which in turn hung the client-abort
//     path (defect C2);
//   * a stream that ends with ZERO bytes ever received stays a retryable
//     `incomplete_stream` — that is the 2026-09-16 incident protection.
// `sawBytes` lets the end handler distinguish "we proxied a real (perhaps
// benign-only) body" from "upstream truly sent nothing". The first decisive
// frame in a chunk wins for `error`/`meaningful`; a same-chunk error frame is
// still reported as an error even when the chunk also starts with a benign one,
// so a benign prelude and an error in one TCP segment still fails over.
// Decision 5a (F2): map a char offset in the UTF-8-decoded `text` of `chunk`
// back to a byte offset in `chunk`. The offset always ends on a separator
// char (\r or \n). UTF-8 decoding (StringDecoder, replacement included) maps
// every ASCII byte to exactly that char in order and never yields \r/\n from
// non-ASCII bytes, so the N-th \r/\n char of `text` is the N-th 0x0D/0x0A
// byte of `chunk`. Returns undefined when the mapping cannot be established.
function byteOffsetAfterLineBreaks(chunk, endChars, text) {
    if (!Number.isInteger(endChars) || endChars < 1 || endChars > text.length) return undefined;
    const last = text.charCodeAt(endChars - 1);
    if (last !== 0x0a && last !== 0x0d) return undefined;
    let breaks = 0;
    for (let i = 0; i < endChars; i += 1) {
        const code = text.charCodeAt(i);
        if (code === 0x0a || code === 0x0d) breaks += 1;
    }
    for (let i = 0; i < chunk.length; i += 1) {
        if ((chunk[i] === 0x0a || chunk[i] === 0x0d) && --breaks === 0) return i + 1;
    }
    return undefined;
}

function createPrecommitSseGate() {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let discardingOversizedFrame = false;
    let sawDone = false;
    let sawFrame = false;

    const inspectFrame = (frame) => {
        // WHATWG SSE: a line ends at CRLF, LF or CR (a frame may start with the
        // CR/LF of an extra blank line).
        const lines = frame.split(/\r\n|\r|\n/);
        const eventIsError = lines.some((line) => /^event:\s*error\s*$/i.test(line));
        // Э4-H (plan :51): a frame NAMED `error` is an upstream error whatever
        // its data shape (JSON, non-JSON, empty) - checked before [DONE]/JSON/
        // benign, so it can never be released as a benign frame.
        if (eventIsError) return { error: true, meaningful: false };
        const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");

        if (data.trim() === "[DONE]") {
            sawDone = true;
            return { error: false, meaningful: false };
        }

        let parsed;
        try {
            parsed = JSON.parse(data);
        } catch {
            // Non-JSON SSE data stays opaque to the gateway: it is never an
            // error signal and never provably meaningful — a benign frame.
            return { error: false, meaningful: false };
        }

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            if ("error" in parsed
                || parsed.code === 500 || parsed.code === "500" || parsed.type === "internal_server_error"
                || (typeof parsed.type === "string" && parsed.type.toLowerCase().includes("error"))
                || eventIsError) {
                return { error: true, meaningful: false };
            }
            return { error: false, meaningful: isOpenAiSseItemMeaningful(parsed) };
        }
        return { error: false, meaningful: false };
    };

    const consume = (text, { continuePastError = false } = {}) => {
        const verdict = { error: false, meaningful: false, benign: false };
        let remaining = text;

        while (remaining.length > 0) {
            if (discardingOversizedFrame) {
                const separator = /(?:\r\n|\n|\r(?!\n))(?:\r\n|\n|\r)/.exec(remaining);
                if (!separator) return verdict;
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
                const separator = /(?:\r\n|\n|\r(?!\n))(?:\r\n|\n|\r)/.exec(pending);
                if (!separator) {
                    break;
                }

                const frame = pending.slice(0, separator.index);
                pending = pending.slice(separator.index + separator[0].length);
                const frameVerdict = inspectFrame(frame);
                sawFrame = true;
                if (frameVerdict.error) {
                    verdict.error = true;
                    // Pre-commit the FIRST decisive frame wins: an error must
                    // fail over before any later frame in the same chunk can
                    // claim the stream. Post-commit (Round D) the caller only
                    // asks "has meaningful content been forwarded", so an error
                    // frame must not mask a meaningful frame later in the same
                    // chunk.
                    if (!continuePastError) return verdict;
                    continue;
                }
                if (frameVerdict.meaningful) {
                    verdict.meaningful = true;
                    // Decision 5a (F2): chars of THIS call's `text` up to the end
                    // of the meaningful frame's separator. Everything still
                    // unconsumed (pending tail + remaining) is a suffix of
                    // `text`: an earlier call never left a complete separator
                    // in `pending`, so the separator ends inside `text`.
                    verdict.meaningfulEndChars = text.length - (pending.length + remaining.length);
                    return verdict;
                }
                // A complete benign frame is still RELEASED, but keep scanning
                // this chunk for an error frame first: a benign prelude and an
                // error delivered in the same TCP segment must still fail over.
                verdict.benign = true;
            }

            if (pending.length === MAX_SSE_FRAME_CHARS) {
                pending = "";
                discardingOversizedFrame = true;
            }
        }

        return verdict;
    };

    return {
        // Pre-commit (and released-prelude, Э4-H option b) classification: the
        // FIRST decisive frame wins, so an error short-circuits the chunk.
        observe(chunk) {
            const text = decoder.write(chunk);
            const verdict = consume(text);
            if (verdict.meaningful) {
                verdict.meaningfulEnd = byteOffsetAfterLineBreaks(chunk, verdict.meaningfulEndChars, text);
            }
            return verdict;
        },
        // Round D (defect D1): classification for a chunk arriving AFTER the
        // commit boundary. It shares this instance's decoder, pending carry and
        // frame cap, so a meaningful frame split across the commit boundary or
        // across two post-commit chunks is still recognized — a throwaway
        // per-chunk parser lost that carry. Errors never short-circuit here
        // (see consume): the only question left is whether the client has seen
        // meaningful content. `continuePastError: true` (Decision 5a, H1/H2):
        // once the attempt can no longer fail over, an error frame must not
        // hide a later meaningful frame in the same chunk.
        observePostCommit(chunk) {
            return consume(decoder.write(chunk), { continuePastError: true });
        },
        get sawDone() {
            return sawDone;
        },
        // True once at least one COMPLETE frame has been classified. The caller
        // uses it to tell a real (if benign) upstream body from an empty stream.
        get sawFrame() {
            return sawFrame;
        }
    };
}

// Round D (defect D1): the meaningful-frame detection for the POST-commit
// phase runs on the SAME persistent gate instance that classified the
// pre-commit phase — never on a throwaway parser rebuilt per chunk. A
// throwaway instance lost the frame carry at every chunk boundary, so a
// meaningful frame split across two post-commit TCP writes was never
// recognized: meaningfulContentForwarded stayed false and a later truncation
// omitted the synthetic incomplete_stream marker even though the client had
// received real content. The persistent instance keeps the same framing rules
// and the same bounded carry (MAX_SSE_FRAME_CHARS) for the whole response.

// Detach the inbound "close"/"error"/"aborted" handlers registered for the CURRENT
// attempt on this request, if any. Called when an attempt settles RETRYABLY (the
// failover loop is about to re-enter proxyRequest on the same `req`), so listeners
// never accumulate across attempts and no stale closure survives over a dead
// attempt, or when the response finishes or closes.
//
// B1: the streaming branches (Anthropic facade + OpenAI SSE pass-through) register
// their OWN `res` "error"/"close" handlers INSIDE proxyRequest — after this funnel
// pair — so they are recorded here as `streamResError`/`streamResClose` and removed
// by the same detach. Without that, every failover attempt added two more listeners
// to the SAME long-lived `res`: the old closures stayed registered and fired on a
// later close, acting on stale per-attempt state (MaxListenersExceededWarning past
// ~10 attempts). `resClose`/`resError` above cover the funnel handler registered on
// `res` by proxyRequest itself.
function detachFunnelAbortHandlers(req) {
    const handlers = funnelAbortHandlers.get(req);
    if (!handlers) return false;
    req.removeListener("close", handlers.close);
    req.removeListener("aborted", handlers.aborted);
    if (handlers.res) {
        if (handlers.resClose) handlers.res.removeListener("close", handlers.resClose);
        if (handlers.resError) handlers.res.removeListener("error", handlers.resError);
        if (handlers.streamResError) handlers.res.removeListener("error", handlers.streamResError);
        if (handlers.streamResClose) handlers.res.removeListener("close", handlers.streamResClose);
        // Defect 6 backpressure pair: a retryable settle must release it too,
        // otherwise each failover attempt leaves two more listeners on `res`.
        if (handlers.backpressure) handlers.backpressure.dispose();
        if (handlers.resFinishOrClose) {
            handlers.res.removeListener("finish", handlers.resFinishOrClose);
            handlers.res.removeListener("close", handlers.resFinishOrClose);
        }
    }
    funnelAbortHandlers.delete(req);
    return true;
}

function proxyRequest(req, res, targetKey, bodyBuffer, isStream, onResult, opts = {}) {
    const isAnthropic = opts.responseMode === "anthropic";
    // OpenAI Responses facade (/v1/responses): shares the translating stream /
    // buffered branches with the Anthropic facade; every error, failover and
    // key-accounting path is otherwise the OpenAI (chat) one.
    const isResponses = opts.responseMode === "responses";
    const isFacade = isAnthropic || isResponses;
    const requestId = isFacade ? opts.requestId : undefined;
    const requestedModel = isFacade ? opts.model : undefined;
    // Model id for PER-MODEL key accounting on every failure path below: a 429
    // must park only this (model, key) pair, never the key pool-wide. Set for
    // both response modes (unlike requestedModel, which is Anthropic-only).
    const affinityModelId = typeof opts.model === "string" && opts.model.length > 0 ? opts.model : undefined;
    // Wrap the caller's callback so a RETRYABLE settle also releases this attempt's
    // inbound abort listeners (see detachFunnelAbortHandlers). Shadowing keeps every
    // existing `onResult(...)` / `if (onResult)` call site unchanged, and stays
    // undefined when the caller passed nothing so those truthiness checks still work.
    const rawOnResult = onResult;
    let attemptSettled = false;
    onResult = typeof rawOnResult === "function"
        ? (result) => {
            if (attemptSettled) return;
            attemptSettled = true;
            if (result && result.success !== true && result.retryable === true) {
                detachFunnelAbortHandlers(req);
            }
            clearTimeout(requestDeadlineTimer);
            if (result?.success === true && res.headersSent) restoreCommittedIdleTimeout();
            rawOnResult(result);
        }
        : rawOnResult;

    const options = {
        hostname: NVIDIA_API,
        port: 443,
        // The Anthropic facade must forward to the OpenAI Chat Completions upstream
        // (translated body), never to /v1/messages upstream (which NVIDIA does not
        // expose). The passthrough chat path keeps the original client URL.
        path: isFacade ? "/v1/chat/completions" : req.url,
        // Method stays POST in both modes; Anthropic clients send POST /v1/messages.
        method: req.method,
        agent: false,  // disable connection pooling to prevent stale socket reuse
        headers: buildUpstreamRequestHeaders(req.headers, {
            authorization: "Bearer " + targetKey.key,
            contentLength: bodyBuffer ? Buffer.byteLength(bodyBuffer) : undefined
        })
    };

    let firstByteReceived = false;
    // Timing for the request_outcome row (GLM-5.3 "endless thinking" diagnosis:
    // how long until upstream answered vs. how long the attempt lasted).
    const attemptStartedAt = Date.now();
    let firstByteAt = 0;
    let intentionalUpstreamAbort = false;
    // §12.9.3: set ONLY by abortUpstream, i.e. whenever `res` is torn down: by the
    // client leaving OR by the gateway itself destroying `res`. Separate from
    // intentionalUpstreamAbort, which internal failure paths also set.
    let resTornDown = false;
    // Р1: set by the socket idle-timeout branch before it destroys upstream.
    // Idle already recorded `idle_timeout` and must never penalize the key, so
    // the Anthropic post-commit failure path must not call handleKeyError.
    let idleTornDown = false;
    // Set when the gateway destroys a committed `res` for an upstream body
    // break (failTruncatedBody); only silences the misleading client-gone log.
    let gatewayClosedRes = false;
    let activeUpstreamResponse = null;
    let terminalOutcome = null;
    let keyOutcomeAccounted = false;
    let deadlineAborted = false;
    let requestDeadlineTimer;
    let activeMaxStreamTimer;
    let wakeActiveStream = () => {};
    const restoreCommittedIdleTimeout = () => {
        clearTimeout(requestDeadlineTimer);
        upstreamReq.socket?.setTimeout(opts.unclampedIdleTimeoutMs ?? opts.idleTimeoutMs ?? resolveRequestTimeouts().idleTimeoutMs);
    };

    // Defect 6 (Level-1 W1): `res.write()` returning false means the client's
    // socket buffer is full. Ignoring it kept pulling from upstream, so a
    // stalled client made the gateway buffer the whole response in memory.
    // Pause the upstream until the client drains; "close" also resumes so a
    // departed client never leaves the upstream paused forever.
    let downstreamStalled = false;
    const resumeUpstreamAfterDrain = () => {
        res.removeListener("drain", resumeUpstreamAfterDrain);
        res.removeListener("close", resumeUpstreamAfterDrain);
        downstreamStalled = false;
        if (activeUpstreamResponse && !activeUpstreamResponse.destroyed) activeUpstreamResponse.resume();
    };
    // Defect 4 (pass 3): `res.write()` on a response whose socket is already
    // gone returns false and emits NOTHING ever again -- `close` has already
    // fired. Registering a `drain`/`close` pair on such a response leaks two
    // listeners that can never run, and (for the awaited variant below) leaves
    // the promise pending FOREVER: MEASURED unresolved for >1.5 s with
    // `res.destroyed === true`, which stalled `finalizeAnthropicStream` and the
    // whole stream teardown. A response that can never emit again must not be
    // waited on at all.
    const responseIsDead = () => res.destroyed === true || res.writableEnded === true;
    const writeToClient = (chunk) => {
        const flushed = res.write(chunk);
        if (flushed === false && !downstreamStalled && !responseIsDead()) {
            downstreamStalled = true;
            if (activeUpstreamResponse && !activeUpstreamResponse.destroyed) activeUpstreamResponse.pause();
            res.once("drain", resumeUpstreamAfterDrain);
            res.once("close", resumeUpstreamAfterDrain);
        }
        return flushed;
    };
    // Registered in funnelAbortHandlers so a retryable settle detaches the pair
    // (a failover loop re-enters proxyRequest on the SAME `res`).
    const disposeBackpressure = () => {
        res.removeListener("drain", resumeUpstreamAfterDrain);
        res.removeListener("close", resumeUpstreamAfterDrain);
        downstreamStalled = false;
    };
    // Facade streams write from an async translator loop, so they must also
    // WAIT for the drain instead of racing ahead of a stalled client.
    //
    // The winner of the drain/close race is detached in `settle`. Registering
    // both handlers and never removing the loser leaked one listener per
    // stalled write (MEASURED: 48 / 96 / 215 close listeners for 30 / 150 / 300
    // stalls; peak 87 in this repo's own probe), which also made
    // `disposeBackpressure` unable to cover them because it only knows the
    // OTHER pair. Both `once` registrations stay, because either event must
    // unblock the writer; only the SURVIVOR is cleaned up.
    //
    // Defect 4 (pass 3): if the response is ALREADY unusable when the write
    // fails, `close` has fired and will never fire again -- awaiting here left
    // the promise pending forever (MEASURED >1.5 s, `res.destroyed === true`),
    // so `finalizeAnthropicStream` never resolved. Bail out immediately.
    const writeToClientAwaitDrain = async (chunk) => {
        if (writeToClient(chunk) !== false) return;
        if (responseIsDead()) return;
        await new Promise((resolve) => {
            const settle = () => {
                res.removeListener("drain", settle);
                res.removeListener("close", settle);
                resolve();
            };
            res.once("drain", settle);
            res.once("close", settle);
            // A response that died between the check above and these
            // registrations can never emit; settle on the spot.
            if (responseIsDead()) settle();
        });
    };

    const recordOutcome = (outcome, tokens = 0) => {
        if (terminalOutcome) return false;
        terminalOutcome = outcome;
        // Feed the performance-mode "auto" evidence window with this real,
        // terminal upstream outcome (completed / first_byte_timeout / ...).
        performanceMode.observe(outcome);
        // `model` is the requested model id (sanitized, never a secret): it
        // lets an upstream_sse_error be attributed to the model the client
        // asked for, not just to the key that carried it (2026-09-16
        // incident diagnosis had to work backwards from key ids alone).
        const endedAt = Date.now();
        info("request_outcome", {
            id: targetKey.id, outcome, model: safeModelId(affinityModelId),
            // Numbers only: no prompt/body/header content ever enters this row.
            ttfbMs: firstByteAt > 0 ? firstByteAt - attemptStartedAt : null,
            elapsedMs: endedAt - attemptStartedAt,
            // null = unknown (no usage reported / not a completed turn); never an ambiguous 0.
            tokens: Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : null
        });
        return true;
    };

    const accountOutcome = (outcome, tokens = 0) => {
        if (keyOutcomeAccounted) return;
        keyOutcomeAccounted = true;
        if (outcome === "completed") {
            markKeyUsedAndDebounceSave(targetKey.id, { success: true, tokens });
            commitModelKeyAssignment(affinityModelId, targetKey.id);
        } else if (outcome === "upstream_sse_error" || outcome === "upstream_stream_error" || outcome === "incomplete_stream") {
            markKeyUsedAndDebounceSave(targetKey.id, { success: false });
        }
    };

    const finishOutcome = (outcome, tokens) => {
        if (recordOutcome(outcome, tokens)) accountOutcome(outcome, tokens);
    };

    // Plan L1 (обрывы): a committed stream broken by upstream must end for the
    // client as a TRANSPORT ABORT. http.ServerResponse corks writes until the
    // next tick, so destroy only after already-written bytes were flushed —
    // otherwise the client would lose the committed headers/frames.
    const abortCommittedResponse = (message) => {
        const go = () => { if (!res.destroyed) res.destroy(new Error(message)); };
        setImmediate(() => {
            const sock = res.socket;
            if (sock && !sock.destroyed && sock.writableLength > 0) {
                // Bounded: a client that stops reading must not pin the socket.
                const fallback = setTimeout(go, 2_000);
                fallback.unref?.();
                // An empty write's callback fires once everything queued
                // before it was flushed (drain only fires after a write()
                // returned false, so a small tail would wait the full 2 s).
                sock.write("", () => { clearTimeout(fallback); go(); });
                sock.once("close", () => { clearTimeout(fallback); go(); });
            } else {
                go();
            }
        });
    };

    // The failover loop passes the per-request timeouts in opts; only a
    // stand-alone caller would fall back to a fresh resolution here.
    const upstreamTimeouts = createUpstreamSocketTimeouts({
        firstByteTimeoutMs: opts.firstByteTimeoutMs ?? resolveRequestTimeouts().firstByteTimeoutMs,
        idleTimeoutMs: opts.idleTimeoutMs ?? resolveRequestTimeouts().idleTimeoutMs,
        onTimeout: () => {
            // onResult(success) marks a committed stream as no longer
            // retryable, but its idle timer still owns the active transport.
            if (deadlineAborted || (attemptSettled && (intentionalUpstreamAbort || !res.headersSent))) return;
            // The timer that fired: first-byte window before the first byte,
            // the (pre-commit, still clamped) idle window after it.
            const firedTimerClampedByDeadline = firstByteReceived
                ? opts.idleClampedByDeadline === true
                : opts.firstByteClampedByDeadline === true;
            if (!res.headersSent && Number.isFinite(opts.requestDeadlineAt)
                && (firedTimerClampedByDeadline || Date.now() >= opts.requestDeadlineAt)) {
                // A socket timer clamped to the shared deadline is NOT a
                // per-key failure: the deadline owns this attempt.
                deadlineAborted = true;
                intentionalUpstreamAbort = true;
                clearTimeout(activeMaxStreamTimer);
                finishOutcome("request_deadline");
                wakeActiveStream();
                upstreamReq.destroy();
                activeUpstreamResponse?.destroy();
                onResult?.({ success: false, retryable: true, statusCode: 504, reason: "request_deadline" });
                return;
            }
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
                const precommit = !res.headersSent && !res.writableEnded && !res.destroyed;
                if (precommit) deadlineAborted = true; // suppress intentional upstream error/aborted events
                clearTimeout(activeMaxStreamTimer);
                finishOutcome("idle_timeout");
                idleTornDown = true; // Р1: suppress post-commit handleKeyError on the async upstream close
                wakeActiveStream();
                upstreamReq.destroy();
                activeUpstreamResponse?.destroy();
                if (precommit && onResult) {
                    onResult({ success: false, retryable: true, statusCode: 504, reason: "idle_timeout" });
                } else {
                    // Benign OpenAI SSE bytes can commit HTTP 200 without
                    // notifying the outer loop. Settle it without retrying.
                    if (onResult) onResult({ success: false, retryable: false, reason: "idle_timeout" });
                    res.destroy(new Error("Upstream socket idle timeout"));
                }
            }
        }
    });

    const upstreamReq = https.request(options, (upstreamRes) => {
        firstByteReceived = true;
        firstByteAt = Date.now();
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
                if (deadlineAborted) return;
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
                        writeFacadeError(res, opts.responseMode, 502, { "Content-Type": "application/json" }, "Upstream response too large");
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

                if (isResponses && !res.headersSent) {
                    const responsesError = buildResponsesUpstreamError(statusCode, errorBody);
                    if (responsesError !== null) {
                        // Gateway-built body: no upstream headers are echoed.
                        res.writeHead(statusCode, { "Content-Type": "application/json" });
                        res.end(responsesError);
                        settle({ success: false, retryable: false, statusCode });
                        return;
                    }
                }

                // Chat passthrough: verbatim while clean and bounded, scrubbed
                // and re-wrapped otherwise (defect 2: this used to echo a 1 MB
                // credential-bearing body to the client verbatim).
                // Defect 1 (pass 3): the framing headers follow the body. A
                // rewrite keeps upstream's `content-length` otherwise, and the
                // client is truncated at the old length then reset.
                const chatEchoBody = chatUpstreamErrorEcho(errorBody, statusCode);
                res.writeHead(
                    statusCode,
                    chatEchoBody === errorBody
                        ? capResponseHeaders(upstreamRes.headers)
                        : headersForRewrittenBody(upstreamRes.headers)
                );
                res.end(chatEchoBody);
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
                    model: safeModelId(affinityModelId),
                    ...details
                });
            });
            const maxStreamTimer = setTimeout(() => {
                if (!streamClosed) {
                    streamClosed = true;
                    intentionalUpstreamAbort = true;
                    const precommit = !res.headersSent && !res.writableEnded && !res.destroyed;
                    if (precommit) deadlineAborted = true;
                    finishOutcome("max_stream_duration");
                    wakeActiveStream();
                    upstreamReq.destroy(new Error("Max stream duration exceeded"));
                    activeUpstreamResponse?.destroy();
                    if (precommit && onResult) onResult({ success: false, retryable: true, reason: "max_stream_duration" });
                    else {
                        if (onResult) onResult({ success: false, retryable: false, reason: "max_stream_duration" });
                        res.destroy(new Error("Max stream duration exceeded"));
                    }
                }
            }, opts.maxStreamDurationMs ?? resolveRequestTimeouts().maxStreamDurationMs);
            activeMaxStreamTimer = maxStreamTimer;

            // OpenAI pass-through counterpart of the facade's streamedTokens():
            // the `usage` frame the SSE observer saw, or undefined when the
            // upstream never reported any (request_outcome.tokens stays null).
            const observedStreamTokens = () => sseObserver.usageTotalTokens;

            if (isFacade) {
                // Anthropic streaming facade: translate the upstream OpenAI SSE
                // stream into Anthropic named events via the adapter generator.
                // The gateway speaks Anthropic SSE to the client; the upstream
                // stays OpenAI Chat Completions.
                const upstreamQueue = [];
                let resolveUpstream = null;
                let upstreamDone = false;
                let streamInitialized = false;
                let anthropicStreamCommitted = false;
                let anthropicIncompleteTailSeen = false;
                let heldAnthropicIncompleteStop = null;
                // Hoisted from startAnthropicStream (runs once) so the end
                // handlers can read the Responses translator's totalTokens.
                const translateOptions = { errorOnIncomplete: true };
                // Defect 4 (Level-1 W1): streamed turns recorded `tokens: null` in
                // 5,528 of 5,532 rows because this returned a hard 0 for every
                // non-Responses stream (0 never reaches the outcome row, which
                // keeps null, and markKeyUsedAndDebounceSave got a 0). Read the
                // usage the SSE observer actually saw: the Responses translator's
                // total first, then the upstream `usage` frame. Undefined when
                // neither reported any — callers then keep tokens null rather
                // than fabricating 0.
                const streamedTokens = () => (isResponses && Number.isSafeInteger(translateOptions.totalTokens)
                    ? translateOptions.totalTokens
                    : sseObserver.usageTotalTokens);

                const wakeUpstream = () => {
                    upstreamDone = true;
                    if (resolveUpstream) {
                        const r = resolveUpstream;
                        resolveUpstream = null;
                        r();
                    }
                };
                wakeActiveStream = wakeUpstream;

                const upstreamIterable = {
                    async *[Symbol.asyncIterator]() {
                        try {
                            while (true) {
                                if (upstreamQueue.length > 0) { yield upstreamQueue.shift(); continue; }
                                if (upstreamDone) return;
                                await new Promise((resolve) => { resolveUpstream = resolve; });
                                resolveUpstream = null;
                                if (upstreamQueue.length > 0) { yield upstreamQueue.shift(); continue; }
                                if (upstreamDone) return;
                            }
                        } finally {
                            resolveUpstream = null;
                        }
                    }
                };

                let finalizeAnthropicStream = null;
                let committedFailureFinishing = false;
                const failAnthropicBeforeCommit = (message) => {
                    if (deadlineAborted) return true;
                    if (anthropicStreamCommitted || streamClosed) return false;
                    streamClosed = true;
                    clearTimeout(maxStreamTimer);
                    handleKeyError(targetKey.id, 502, message, null, affinityModelId);
                    keyOutcomeAccounted = true;
                    finishOutcome("upstream_stream_error");
                    if (onResult) onResult({ success: false, retryable: true, statusCode: 502, reason: "upstream_stream_error" });
                    return true;
                };
                const startAnthropicStream = () => {
                    if (streamInitialized) return;
                    streamInitialized = true;

                    finalizeAnthropicStream = (async () => {
                        try {
                            // Same commit/failover contract for both facades: the
                            // translator yields nothing before meaningful upstream
                            // content and tags its synthetic incomplete tail.
                            const translated = isResponses
                                ? translateResponsesSseStream(upstreamIterable, { id: requestId, model: requestedModel, customToolNames: opts.customToolNames }, translateOptions)
                                : translateAnthropicSseStream(upstreamIterable, requestId, requestedModel, translateOptions);
                            const tailErrorPrefix = isResponses ? "event: response.failed" : "event: error";
                            for await (const ev of translated) {
                                if (streamClosed || deadlineAborted || res.writableEnded) break;
                                if (!anthropicStreamCommitted) {
                                    anthropicStreamCommitted = true;
                                    res.writeHead(200, {
                                        "Content-Type": "text/event-stream",
                                        "Cache-Control": "no-cache",
                                        "Connection": "keep-alive"
                                    });
                                    // Release failover immediately before the
                                    // first translated client byte, never merely
                                    // because an incomplete transport chunk arrived.
                                    if (onResult) onResult({ success: true });
                                }
                                // Hold the `message_stop` that follows the
                                // adapter's incomplete-tail error: the EOF
                                // owner decides (abort vs. legacy clean end).
                                if (anthropicIncompleteTailSeen && ev.startsWith("event: message_stop")) {
                                    heldAnthropicIncompleteStop = ev;
                                    continue;
                                }
                                // The adapter tags its own synthetic incomplete-tail
                                // error explicitly; an upstream error frame with the
                                // same text must not trigger the hold.
                                if (translateOptions.incompleteTail === true && ev.startsWith(tailErrorPrefix)) {
                                    anthropicIncompleteTailSeen = true;
                                }
                                await writeToClientAwaitDrain(ev);
                            }
                        } catch (e) {
                            // The idle/deadline owner deliberately destroyed
                            // this attempt. Its truncated queue must not turn
                            // into a second failure or penalize a healthy key.
                            if (deadlineAborted || streamClosed) return;
                            error("Anthropic SSE translation error", { id: targetKey.id, error: e.message });
                            if (!anthropicStreamCommitted) {
                                streamClosed = true;
                                clearTimeout(maxStreamTimer);
                                const semanticSseError = e instanceof AnthropicUpstreamSseError || e instanceof ResponsesUpstreamSseError;
                                const failureStatus = semanticSseError ? 500 : 502;
                                handleKeyError(targetKey.id, failureStatus, e.message, null, affinityModelId);
                                keyOutcomeAccounted = true;
                                finishOutcome(semanticSseError ? "upstream_sse_error" : "incomplete_stream");
                                if (onResult) onResult({
                                    success: false,
                                    retryable: true,
                                    statusCode: failureStatus,
                                    reason: semanticSseError ? "upstream_sse_error" : "incomplete_stream"
                                });
                            }
                        }
                    })();
                };

                const finishAnthropicAfterCommitFailure = (message) => {
                    if (!anthropicStreamCommitted || streamClosed) return false;
                    // §12.9.3: upstream aborted/close caused by the CLIENT leaving is
                    // not a key failure; abortUpstream already settled client_aborted.
                    // Gateway-initiated teardowns that go through abortUpstream (resTornDown)
                    // record their own outcome synchronously before the async close. The
                    // socket idle-timeout branch does NOT go through abortUpstream first:
                    // it records `idle_timeout` with no key penalty (Р1) and sets
                    // idleTornDown, so it must be short-circuited here as well.
                    if (resTornDown || idleTornDown) { clearTimeout(maxStreamTimer); wakeUpstream(); return true; }
                    if (committedFailureFinishing) return true;
                    committedFailureFinishing = true;
                    intentionalUpstreamAbort = true;
                    clearTimeout(maxStreamTimer);
                    const accountBreak = () => {
                        handleKeyError(targetKey.id, 502, message, null, affinityModelId);
                        keyOutcomeAccounted = true;
                        finishOutcome("upstream_stream_error");
                    };
                    // Decision 4a: without upstream [DONE] (or with an SSE error)
                    // this is a real break - account it synchronously as before.
                    // With [DONE] seen, the verdict needs the adapter's tail state,
                    // so accounting waits for the translation to drain below.
                    const doneSeenCleanly = sseObserver.sawDone && !sseErrorObserved;
                    if (!doneSeenCleanly) accountBreak();
                    wakeUpstream();
                    void (async () => {
                        if (finalizeAnthropicStream) await finalizeAnthropicStream;
                        if (streamClosed) return;
                        const completedNormally = doneSeenCleanly
                            && !anthropicIncompleteTailSeen && !heldAnthropicIncompleteStop;
                        if (doneSeenCleanly && !terminalOutcome) {
                            // Decision 4a: the answer arrived in full and only the
                            // socket teardown was unclean -> account exactly like the
                            // normal end handler (`completed`), no key penalty.
                            if (completedNormally) finishOutcome("completed", streamedTokens());
                            else accountBreak();
                        }
                        streamClosed = true;
                        // Plan L1 (обрывы): a post-commit upstream break (response
                        // error / aborted / premature close) ends as a transport
                        // abort. The adapter's `event: error` frame already written
                        // stays; the held `message_stop` is dropped; no clean EOF.
                        // Exception: the upstream stream had already COMPLETED
                        // ([DONE] seen, no SSE error, no incomplete tail, nothing
                        // held) and only the socket teardown was unclean -> the
                        // client already has the full message; keep the clean end.
                        heldAnthropicIncompleteStop = null;
                        if (completedNormally) {
                            if (!res.writableEnded && !res.destroyed) res.end();
                            return;
                        }
                        if (!res.writableEnded) abortCommittedResponse(message);
                    })();
                    return true;
                };

                upstreamRes.on("data", (chunk) => {
                    if (streamClosed) return;
                    if (!firstChunkHandled) {
                        firstChunkHandled = true;
                        startAnthropicStream();
                    }

                    sseObserver.observe(chunk);
                    upstreamQueue.push(chunk);
                    if (resolveUpstream) { const r = resolveUpstream; resolveUpstream = null; r(); }
                });

                upstreamRes.on("error", (err) => {
                    if (deadlineAborted) return;
                    const wasIntentionalAbort = intentionalUpstreamAbort;
                    intentionalUpstreamAbort = true;
                    if (!wasIntentionalAbort) {
                        error("Upstream response stream error", { id: targetKey.id, upstreamStatus: statusCode });
                    }
                    if (!wasIntentionalAbort && failAnthropicBeforeCommit(err.message)) { wakeUpstream(); return; }
                    if (finishAnthropicAfterCommitFailure(err.message)) return;
                    wakeUpstream();
                    if (streamClosed) return;
                    streamClosed = true;
                    clearTimeout(maxStreamTimer);
                    finishOutcome("upstream_stream_error");
                    res.destroy(err);
                });
                upstreamRes.on("aborted", () => {
                    if (deadlineAborted) return;
                    const wasIntentionalAbort = intentionalUpstreamAbort;
                    intentionalUpstreamAbort = true;
                    if (!wasIntentionalAbort && failAnthropicBeforeCommit("Upstream response aborted")) { wakeUpstream(); return; }
                    if (finishAnthropicAfterCommitFailure("Upstream response aborted")) return;
                    wakeUpstream();
                    if (streamClosed) return;
                    streamClosed = true;
                    clearTimeout(maxStreamTimer);
                    finishOutcome("upstream_stream_error");
                    res.destroy(new Error("Upstream response aborted"));
                });
                upstreamRes.on("close", () => {
                    if (deadlineAborted) return;
                    if (!upstreamRes.complete) {
                        if (!intentionalUpstreamAbort && failAnthropicBeforeCommit("Upstream response closed prematurely")) { wakeUpstream(); return; }
                        if (finishAnthropicAfterCommitFailure("Upstream response closed prematurely")) return;
                    }
                    wakeUpstream();
                });
                const onStreamResError = () => {
                    wakeUpstream();
                    if (streamClosed) return;
                    streamClosed = true;
                    clearTimeout(maxStreamTimer);
                    intentionalUpstreamAbort = true;
                    finishOutcome("client_aborted");
                    upstreamRes.destroy();
                };
                const onStreamResClose = () => {
                    wakeUpstream();
                    if (streamClosed || res.writableEnded) return;
                    streamClosed = true;
                    clearTimeout(maxStreamTimer);
                    intentionalUpstreamAbort = true;
                    finishOutcome("client_aborted");
                    upstreamReq.destroy();
                    upstreamRes.destroy();
                };
                res.on("error", onStreamResError);
                res.on("close", onStreamResClose);
                // B1: detach this attempt's `res` pair on a retryable settle so
                // repeated failover attempts never accumulate listeners on `res`.
                const streamHandlers = funnelAbortHandlers.get(req);
                if (streamHandlers) {
                    streamHandlers.streamResError = onStreamResError;
                    streamHandlers.streamResClose = onStreamResClose;
                }
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
                    wakeUpstream();
                    if (finalizeAnthropicStream) await finalizeAnthropicStream;
                    if (streamClosed) return;
                    streamClosed = true;
                    clearTimeout(maxStreamTimer);
                    // Fix 1: a lone unterminated `data: [DONE]` at EOF counts as
                    // [DONE] (the adapter already translated it to message_stop).
                    sseObserver.flushUnterminatedDone();
                    if (sseErrorObserved) {
                        handleKeyError(targetKey.id, 500, "Upstream SSE Error", null, affinityModelId);
                        keyOutcomeAccounted = true;
                        finishOutcome("upstream_sse_error");
                    } else if (sseObserver.sawDone) {
                        // Accounting unchanged by plan L1: upstream [DONE] counts
                        // as `completed` for the key even if the adapter tagged a
                        // post-commit break (e.g. malformed frame).
                        // Wire handling for a tagged tail follows the chain below.
                        finishOutcome("completed", streamedTokens());
                    } else {
                        handleKeyError(targetKey.id, 502, "Incomplete upstream SSE", null, affinityModelId);
                        keyOutcomeAccounted = true;
                        finishOutcome("incomplete_stream");
                        // Plan L1 (обрывы): committed then upstream EOF without
                        // finish -> the held `message_stop` is dropped and the
                        // client sees a transport abort (the `event: error`
                        // frame already written stays).
                        heldAnthropicIncompleteStop = null;
                        if (!res.writableEnded) {
                            abortCommittedResponse("Incomplete upstream SSE");
                            return;
                        }
                    }
                    if (anthropicIncompleteTailSeen) {
                        // Wire only (accounting above is unchanged): the adapter
                        // tagged a post-commit break and the client already got
                        // `event: error`; drop the held message_stop and abort the
                        // transport in every branch (sseError / [DONE]).
                        // streamClosed is set, so close handlers add nothing.
                        heldAnthropicIncompleteStop = null;
                        if (!res.writableEnded && !res.destroyed) {
                            abortCommittedResponse("Malformed upstream SSE");
                            return;
                        }
                    }
                    if (heldAnthropicIncompleteStop && !res.writableEnded) res.write(heldAnthropicIncompleteStop);
                    heldAnthropicIncompleteStop = null;
                    if (!res.writableEnded) res.end();
                });
                return;
            }

            // OpenAI pass-through route. 2026-09-16 incident: a 200 SSE
            // stream whose first frame is an SSE error must NOT count as
            // committed output; the commit boundary is the first MEANINGFUL
            // frame, and a benign frame is never a success on its own. Level-1
            // Round C (defect C1): benign frames are held only until they are
            // classified, then RELEASED to the client — holding them
            // indefinitely made the first client chunk never arrive and turned a
            // real benign-only body into a 502 failover. See the gate comment for
            // the full contract.
            const isSseResponse = contentType === "text/event-stream";
            let streamCommitted = false;
            // Round C: distinguishes "the client has already seen MEANINGFUL
            // content" (contract B — a truncation is reported with a synthetic
            // error frame) from "the client only saw benign bytes that were
            // released" (an honest byte-for-byte proxy — the body must not be
            // embellished, per the pre-existing contract of the
            // `records incomplete_stream ... without DONE` test).
            let meaningfulContentForwarded = false;
            // Decision 5a accounting guard (plan :43 — accounting unchanged): an
            // attempt committed from a RELEASED benign prelude keeps the key
            // accounting the pre-5a released path recorded. The old path never
            // committed there, so an SSE error seen before the commit did not
            // turn a [DONE] stream into upstream_sse_error, and EOF without
            // [DONE] was a plain incomplete_stream failure without backoff.
            let committedViaReleasedPrelude = false;
            const precommitHeldChunks = [];
            let precommitHeldBytes = 0;
            const precommitGate = createPrecommitSseGate();
            // Decision 5a: post-commit frame tracker for the committed OpenAI SSE
            // passthrough. Works on latin1 text (1:1 with bytes, so slices map
            // back to exact bytes; UTF-8 multibyte never forms \r/\n and JSON
            // validity is preserved). Until a non-JSON data frame is seen, chunks
            // are forwarded untouched (it only tracks frame boundaries). After
            // one is seen the stream is broken: complete frames are forwarded
            // except the upstream `[DONE]`, partial frames are held (bounded), and
            // the end handler aborts the transport.
            let malformedAfterCommit = false;
            let committedFrameCarry = "";
            const frameData = (frame) => frame.split(/\r\n|\r|\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).replace(/^ /, ""))
                .join("\n");
            const isMalformedFrame = (frame) => {
                // `event: error` frames stay the SSE observer's domain.
                if (/^event:\s*error\s*$/im.test(frame)) return false;
                const data = frameData(frame);
                if (data.trim() === "" || data.trim() === "[DONE]") return false;
                try { JSON.parse(data); return false; } catch { return true; }
            };
            // write=false: bytes already written verbatim elsewhere (held/committing
            // chunk); only the frame carry is tracked. Detection runs only once
            // the client has seen meaningful content (a benign-only prelude keeps
            // its opaque non-JSON contract).
            // F1: set when the carry overflowed MAX_SSE_FRAME_CHARS and was
            // dropped. The next frame to end is that oversized frame's tail — not
            // a frame of its own — so it is never classified (mirrors the gate's
            // discardingOversizedFrame). Its bytes still pass through untouched.
            let skipOversizedFrame = false;
            const forwardCommittedSse = (chunk, { write = true } = {}) => {
                if (!write) {
                    const parts = (committedFrameCarry + chunk.toString("latin1")).split(/(?:\r\n|\n|\r(?!\n))(?:\r\n|\n|\r)/);
                    if (parts.length > 1) skipOversizedFrame = false;
                    const tail = parts.at(-1);
                    if (tail.length > MAX_SSE_FRAME_CHARS) { committedFrameCarry = ""; skipOversizedFrame = true; }
                    else committedFrameCarry = tail;
                    return;
                }
                if (!meaningfulContentForwarded && !malformedAfterCommit) {
                    forwardCommittedSse(chunk, { write: false });
                    writeToClient(chunk);
                    return;
                }
                const text = chunk.toString("latin1");
                const combined = committedFrameCarry + text;
                const carryLength = malformedAfterCommit ? 0 : committedFrameCarry.length;
                let cursor = 0;
                let out = null; // null: forward the chunk untouched
                const separatorRe = /(?:\r\n|\n|\r(?!\n))(?:\r\n|\n|\r)/g;
                let match;
                while ((match = separatorRe.exec(combined)) !== null) {
                    const frameEnd = match.index + match[0].length;
                    const frame = combined.slice(cursor, match.index);
                    const oversizedTail = skipOversizedFrame;
                    skipOversizedFrame = false;
                    if (out !== null) {
                        if (frameData(frame).trim() !== "[DONE]") out += combined.slice(cursor, frameEnd);
                    } else if (malformedAfterCommit) {
                        // Degraded mode from an earlier chunk: carry was withheld.
                        out = frameData(frame).trim() === "[DONE]" ? "" : combined.slice(cursor, frameEnd);
                    } else if (!oversizedTail && isMalformedFrame(frame)) {
                        malformedAfterCommit = true;
                        // Everything up to the end of this frame goes out as before.
                        out = text.slice(0, Math.max(0, frameEnd - carryLength));
                    }
                    cursor = frameEnd;
                }
                committedFrameCarry = combined.slice(cursor);
                if (committedFrameCarry.length > MAX_SSE_FRAME_CHARS) { committedFrameCarry = ""; skipOversizedFrame = true; }
                if (out === null && malformedAfterCommit) out = "";
                if (out === null) writeToClient(chunk);
                else if (out.length > 0) writeToClient(Buffer.from(out, "latin1"));
            };
            const committedSseCompletedNormally = () => isSseResponse && streamCommitted
                && sseObserver.sawDone && !(sseErrorObserved && !committedViaReleasedPrelude) && !malformedAfterCommit;
            // Decision 4a: upstream error/aborted AFTER a normally completed
            // committed stream is not a break: account `completed` exactly like
            // the end handler and end the response cleanly.
            const finishCompletedBeforeTeardown = () => {
                sseObserver.end();
                if (!committedSseCompletedNormally()) return false;
                streamClosed = true;
                clearTimeout(maxStreamTimer);
                finishOutcome("completed", observedStreamTokens());
                if (!res.writableEnded && !res.destroyed) res.end();
                return true;
            };

            const commitHeldSseStream = (chunk, { notify = true, meaningfulEnd } = {}) => {
                streamCommitted = true;
                // Headers may already be on the wire when a benign prelude was
                // released early; only the first write may set them.
                if (!res.headersSent) res.writeHead(statusCode, capResponseHeaders(upstreamRes.headers));
                if (notify && onResult) onResult({ success: true });
                for (const held of precommitHeldChunks) { writeToClient(held); forwardCommittedSse(held, { write: false }); }
                precommitHeldChunks.length = 0;
                // Round D (defect D2): the held-byte counter must not survive the
                // commit — it is a pre-commit budget only. Leaving it set would
                // make a later (unrelated) hold path see a phantom overflow.
                precommitHeldBytes = 0;
                if (chunk === undefined) return;
                if (meaningfulEnd === undefined) { writeToClient(chunk); forwardCommittedSse(chunk, { write: false }); return; }
                // Decision 5a (F2): bytes up to the end of the first meaningful
                // frame go out verbatim (a non-JSON prelude before it is never
                // flagged); the rest of the committing chunk goes through the
                // post-commit tracker, already in the "content is out" state.
                const head = chunk.subarray(0, meaningfulEnd);
                writeToClient(head);
                forwardCommittedSse(head, { write: false });
                // `head` ends on the gate's frame boundary: the tracker starts clean.
                committedFrameCarry = "";
                skipOversizedFrame = false;
                if (meaningfulEnd < chunk.length) forwardCommittedSse(chunk.subarray(meaningfulEnd));
            };

            // Release held bytes to the client WITHOUT declaring the attempt a
            // success. A benign prelude must reach the client (the stream is
            // real), but the completion verdict — completed vs incomplete_stream,
            // and therefore the key accounting — is the end handler's to make.
            const releaseHeldSseStream = () => {
                if (!res.headersSent) res.writeHead(statusCode, capResponseHeaders(upstreamRes.headers));
                restoreCommittedIdleTimeout();
                for (const held of precommitHeldChunks) { writeToClient(held); forwardCommittedSse(held, { write: false }); }
                precommitHeldChunks.length = 0;
                // Round D (defect D2): the bytes are on the wire; the hold budget
                // is empty again and must say so.
                precommitHeldBytes = 0;
            };

            upstreamRes.on("data", (chunk) => {
                if (streamClosed) return;
                if (isSseResponse) {
                    if (!streamCommitted && res.headersSent) {
                        // Decision 5a (H1/H2): a benign prelude was RELEASED but
                        // nothing is committed yet. Classify with the pre-commit
                        // gate; the first meaningful frame commits through the
                        // same F2 split as the held path, so the post-commit
                        // tracker and the committed end-of-stream contract apply.
                        // Non-meaningful chunks pass through exactly as before.
                        sseObserver.observe(chunk);
                        // Э4-H (spec :64, plan :126): the first decisive frame wins.
                        // An upstream error (named `event: error` of any data shape,
                        // or an in-band `{"error":...}`) before any meaningful
                        // content is NOT forwarded: the released 200 is aborted
                        // (no clean EOF, no [DONE]) and the key is charged like the
                        // pre-commit upstream_sse_error. No failover after write
                        // (plan :29).
                        const released = precommitGate.observe(chunk);
                        if (released.error) {
                            streamClosed = true;
                            clearTimeout(maxStreamTimer);
                            intentionalUpstreamAbort = true;
                            upstreamReq.destroy();
                            activeUpstreamResponse?.destroy();
                            handleKeyError(targetKey.id, 500, "Upstream SSE Error", null, affinityModelId);
                            keyOutcomeAccounted = true;
                            finishOutcome("upstream_sse_error");
                            if (onResult) onResult({ success: false, retryable: false, reason: "upstream_sse_error" });
                            abortCommittedResponse("Upstream SSE error after benign release");
                            return;
                        }
                        if (released.meaningful) {
                            meaningfulContentForwarded = true;
                            committedViaReleasedPrelude = true;
                            commitHeldSseStream(chunk, { meaningfulEnd: released.meaningfulEnd });
                            return;
                        }
                        forwardCommittedSse(chunk);
                        return;
                    }
                    if (streamCommitted) {
                        sseObserver.observe(chunk);
                        // Post-commit: the persistent gate keeps classifying with
                        // its frame carry intact (defect D1), so a meaningful
                        // frame split across two post-commit chunks is still
                        // recognized and contract B stays honest on truncation.
                        if (precommitGate.observePostCommit(chunk).meaningful) meaningfulContentForwarded = true;
                        forwardCommittedSse(chunk);
                        return;
                    }
                    // Observe before classifying so the "Upstream SSE error
                    // event" diagnostic fires on the pre-commit path too,
                    // exactly like the Anthropic facade.
                    sseObserver.observe(chunk);
                    const verdict = precommitGate.observe(chunk);
                    if (verdict.error) {
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
                    if (verdict.meaningful) {
                        meaningfulContentForwarded = true;
                        commitHeldSseStream(chunk, { meaningfulEnd: verdict.meaningfulEnd });
                        return;
                    }
                    if (verdict.benign) {
                        // A complete benign frame: this is REAL upstream output
                        // (keepalive/comment/no-op/usage-only/[DONE]), not an
                        // empty stream. Release the bytes so the client observes
                        // a first chunk; the completion verdict (and with it the
                        // key accounting and any failover decision) stays with
                        // the end handler.
                        precommitHeldChunks.push(chunk);
                        precommitHeldBytes += chunk.length;
                        releaseHeldSseStream();
                        return;
                    }
                    // No complete frame yet: hold the partial bytes until the
                    // delimiter arrives, so a frame split across chunks is
                    // classified before anything reaches the client.
                    precommitHeldChunks.push(chunk);
                    precommitHeldBytes += chunk.length;
                    if (precommitHeldBytes > MAX_PRECOMMIT_HOLD_BYTES) {
                        // Bounded hold: an unclassifiable prelude commits
                        // instead of growing memory without bound.
                        commitHeldSseStream(undefined);
                    }
                    return;
                }
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
                writeToClient(chunk);
            });
            upstreamRes.on("error", (err) => {
                if (deadlineAborted || intentionalUpstreamAbort) return;
                if (streamClosed) return;
                if (finishCompletedBeforeTeardown()) return;
                streamClosed = true;
                clearTimeout(maxStreamTimer);
                error("Upstream response stream error", { id: targetKey.id, upstreamStatus: statusCode });
                finishOutcome("upstream_stream_error");
                // Pre-commit transport failure (nothing client-visible was
                // sent — held benign frames are dropped with the attempt):
                // retry on the next key. After the commit, contract B holds
                // and the response terminates honestly.
                if (!res.headersSent && !streamCommitted && !firstChunkHandled) {
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
                if (deadlineAborted || intentionalUpstreamAbort) return;
                if (streamClosed) return;
                if (finishCompletedBeforeTeardown()) return;
                streamClosed = true;
                clearTimeout(maxStreamTimer);
                finishOutcome("upstream_stream_error");
                if (!res.headersSent && !streamCommitted && !firstChunkHandled) {
                    handleKeyError(targetKey.id, 502, "Upstream response aborted", null, affinityModelId);
                    keyOutcomeAccounted = true;
                    if (onResult) {
                        onResult({ success: false, retryable: true, statusCode: 502, reason: "upstream_stream_error" });
                        return;
                    }
                }
                res.destroy(new Error("Upstream response aborted"));
            });
            const onStreamResError = () => {
                if (streamClosed) return;
                streamClosed = true;
                clearTimeout(maxStreamTimer);
                intentionalUpstreamAbort = true;
                finishOutcome("client_aborted");
                upstreamRes.destroy();
            };
            const onStreamResClose = () => {
                if (streamClosed || res.writableEnded) return;
                streamClosed = true;
                clearTimeout(maxStreamTimer);
                intentionalUpstreamAbort = true;
                finishOutcome("client_aborted");
                upstreamReq.destroy();
                upstreamRes.destroy();
            };
            res.on("error", onStreamResError);
            res.on("close", onStreamResClose);
            // B1: this attempt's `res` pair must be detached when the attempt
            // settles retryably, exactly like the funnel pair — otherwise each
            // failover attempt appends two more listeners to the SAME `res`.
            const streamHandlers = funnelAbortHandlers.get(req);
            if (streamHandlers) {
                streamHandlers.streamResError = onStreamResError;
                streamHandlers.streamResClose = onStreamResClose;
            }
            upstreamRes.on("end", () => {
                if (streamClosed) return;
                // An SSE attempt that never COMMITTED (no meaningful content, no
                // [DONE]) ends here. That covers three shapes:
                //   * zero bytes ever received — a genuinely empty 200 stream,
                //     which stays a retryable incomplete_stream (incident
                //     protection);
                //   * a benign prelude already RELEASED to the client (defect C1)
                //     — real bytes, so the response is proxied honestly and NOT
                //     retried;
                //   * complete benign frames held for release.
                // Fix 1 (owner 28.09): a lone unterminated `data: [DONE]` at EOF
                // is the normal end (sets sawDone); its missing terminator is
                // written below so the client gets `data: [DONE]\n\n`.
                const eofDoneTerminator = isSseResponse ? sseObserver.flushUnterminatedDone() : null;
                if (isSseResponse && !streamCommitted) {
                    // Pre-commit end on an SSE stream: nothing was committed.
                    if (!sseObserver.sawDone && !precommitGate.sawDone) {
                        if (res.headersSent || precommitGate.sawFrame) {
                            // Level-1 Round C (defect C1): upstream delivered a
                            // real body (a benign prelude already released to the
                            // client, or complete frames held for the release) but
                            // it carried no meaningful content and no [DONE]. That
                            // is an incomplete stream for the CLIENT, yet it is NOT
                            // a failover candidate: the bytes exist and dropping
                            // them burned a healthy key (with one key: a synthetic
                            // 502 "All failover attempts exhausted"). Proxy the
                            // bytes and report the incomplete outcome honestly —
                            // no retry, and no synthetic error frame on a body
                            // that never carried meaningful content.
                            commitHeldSseStream(undefined, { notify: false });
                            streamClosed = true;
                            clearTimeout(maxStreamTimer);
                            sseObserver.end();
                            finishOutcome("incomplete_stream");
                            // The client already owns the response; the failover
                            // loop must NOT retry it. `retryable: false` is the
                            // signal the loop reads — NOT `success: true`, which
                            // would misreport an incomplete stream as a success.
                            if (onResult) {
                                onResult({ success: false, retryable: false, statusCode: 200, reason: "incomplete_stream" });
                            }
                            // Round D (defect D1): a stream whose client-visible
                            // content was meaningful (recognized across chunk
                            // boundaries by the persistent post-commit detector)
                            // is truncated WITHOUT [DONE]; the client gets the
                            // synthetic truncation marker. A body that never
                            // carried meaningful content stays byte-for-byte (the
                            // pre-existing benign-release contract) — the marker
                            // is additive.
                            // Plan L1 (обрывы): meaningful content was forwarded ->
                            // transport abort (no marker/[DONE], no clean EOF).
                            // Decision 3a: a benign-only body without a real end is
                            // "not finished" for the client too — its bytes stay
                            // byte-for-byte, but the 200 ends as a transport abort,
                            // never a clean EOF. commitHeldSseStream above always
                            // put the headers on the wire. Accounting unchanged.
                            if (!res.writableEnded) abortCommittedResponse("Incomplete upstream SSE");
                            return;
                        }
                        // ZERO bytes ever received: a genuinely empty 200 SSE
                        // response — the 2026-09-16 incident protection. Nothing
                        // was sent to the client, so the failover loop may retry
                        // with the next key.
                        streamClosed = true;
                        clearTimeout(maxStreamTimer);
                        sseObserver.end();
                        finishOutcome("incomplete_stream");
                        if (onResult) {
                            onResult({ success: false, retryable: true, statusCode: 502, reason: "incomplete_stream" });
                            return;
                        }
                        // Standalone caller (no failover loop): terminate
                        // honestly with the same accounting as a committed
                        // incomplete stream.
                        handleKeyError(targetKey.id, 502, "Incomplete upstream SSE", null, affinityModelId);
                        keyOutcomeAccounted = true;
                        if (!res.writableEnded) res.write(OPENAI_INCOMPLETE_STREAM_ERROR);
                        if (!res.writableEnded) res.end();
                        return;
                    }
                    // [DONE] without meaningful content: a valid empty
                    // completion — commit at the end and flush the held
                    // benign frames byte-for-byte.
                    commitHeldSseStream(undefined);
                    if (eofDoneTerminator && !res.writableEnded) res.write(eofDoneTerminator);
                    streamClosed = true;
                    clearTimeout(maxStreamTimer);
                    sseObserver.end();
                    finishOutcome("completed", observedStreamTokens());
                    if (!res.writableEnded) res.end();
                    return;
                }
                // Legacy (non-SSE) pre-commit end: the response never produced
                // a transport chunk. SSE streams took one of the branches above.
                //
                // Round B B1 regression: this branch must be entered for EVERY
                // non-SSE body, whether or not a transport chunk was seen. A
                // `stream:true` request answered with a non-`text/event-stream`
                // 200 body (application/json, or a missing/mislabeled
                // content-type) is a perfectly valid completion: its bytes were
                // already proxied by the data handler with `onResult(success)`,
                // and `firstChunkHandled` is therefore true. Gating this branch
                // on `!firstChunkHandled` let control fall through to the SSE
                // tail below, where `sseObserver.sawDone` is necessarily false —
                // so a healthy key was punished with a synthetic
                // incomplete_stream 502, a failure accounting and a backoff,
                // and the client got SSE error bytes appended to its JSON body.
                // The SSE tail must only ever run for a real SSE response.
                if (!isSseResponse) {
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
                    // The body was proxied verbatim and the key was accounted a
                    // success by the data handler (or the empty-body retry above
                    // already returned). Terminate the proxied body — never the
                    // SSE tail, which would splice an error frame into JSON.
                    // The SSE observer is deliberately NOT fed a non-SSE body.
                    streamClosed = true;
                    clearTimeout(maxStreamTimer);
                    finishOutcome("completed");
                    if (!res.writableEnded) res.end();
                    return;
                }
                streamClosed = true;
                clearTimeout(maxStreamTimer);
                sseObserver.end();
                // Plan :43: the released-prelude path keeps the pre-5a accounting,
                // where SSE error frames never changed the outcome (any chunking).
                if (sseErrorObserved && !committedViaReleasedPrelude) {
                    finishOutcome("upstream_sse_error");
                } else if (sseObserver.sawDone) {
                    finishOutcome("completed", observedStreamTokens());
                    // Decision 5a (wire only; accounting above unchanged): a
                    // non-JSON frame after meaningful content broke the stream;
                    // the upstream [DONE] was withheld, so no clean EOF either.
                    if (malformedAfterCommit && !res.writableEnded) {
                        abortCommittedResponse("Malformed upstream SSE");
                        return;
                    }
                    // Fix 1: the unterminated [DONE] bytes were forwarded verbatim;
                    // complete the frame so the client sees a well-formed end.
                    if (eofDoneTerminator && !res.writableEnded) res.write(eofDoneTerminator);
                } else if (committedViaReleasedPrelude) {
                    // Pre-5a released path accounting: the uncommitted end
                    // branch recorded finishOutcome("incomplete_stream") only
                    // (one failure via accountOutcome, NO handleKeyError backoff).
                    // Wire stays the Plan L1 abort after meaningful content.
                    finishOutcome("incomplete_stream");
                    if (meaningfulContentForwarded && !res.writableEnded) {
                        abortCommittedResponse("Incomplete upstream SSE");
                        return;
                    }
                } else {
                    handleKeyError(targetKey.id, 502, "Incomplete upstream SSE", null, affinityModelId);
                    keyOutcomeAccounted = true;
                    finishOutcome("incomplete_stream");
                    // Round C: only a stream the client already saw MEANINGFUL
                    // content on is reported with a synthetic error frame. A
                    // benign-only body that was released is proxied verbatim —
                    // appending bytes to it would corrupt an honest proxy (the
                    // `records incomplete_stream ... without DONE` contract).
                    // Plan L1 (обрывы): after a MEANINGFUL commit the break must
                    // reach the client as a transport abort — no synthetic
                    // [DONE]/error JSON and no clean EOF. Key accounting stays
                    // the single handleKeyError above; the close handlers see
                    // streamClosed/terminalOutcome and do not count again.
                    if (meaningfulContentForwarded && !res.writableEnded) {
                        abortCommittedResponse("Incomplete upstream SSE");
                        return;
                    }
                }
                if (!res.writableEnded) res.end();
            });
        } else {
            if (isFacade) {
                // Anthropic / Responses non-streaming facade: buffer the upstream
                // OpenAI JSON response fully, translate it to the facade shape,
                // and send the single translated JSON body to the client.
                const facadeErrorBody = (message) => JSON.stringify(isResponses
                    ? { error: { message, type: "server_error", param: null, code: null } }
                    : { type: "error", error: { type: "api_error", message } });
                if (statusCode === 204) {
                    upstreamRes.resume();
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(facadeErrorBody("Upstream returned no content"));
                    finishOutcome("upstream_stream_error");
                    if (onResult) onResult({ success: false, retryable: false, statusCode: 500 });
                    return;
                }
                const responseCollector = createBoundedBuffer(MAX_BUFFERED_RESPONSE_BYTES);
                let buffered = true;
                let responseClosed = false;
                const failBufferedAnthropic = (reason, message) => {
                    if (deadlineAborted || intentionalUpstreamAbort) return;
                    if (responseClosed) return;
                    responseClosed = true;
                    handleKeyError(targetKey.id, 502, message, null, affinityModelId);
                    keyOutcomeAccounted = true;
                    finishOutcome("upstream_stream_error");
                    if (onResult) onResult({ success: false, retryable: true, statusCode: 502, reason });
                };
                upstreamRes.on("error", (err) => {
                    failBufferedAnthropic("upstream_stream_error", err.message);
                });
                upstreamRes.on("aborted", () => failBufferedAnthropic("upstream_stream_error", "Upstream response aborted"));
                upstreamRes.on("data", (chunk) => {
                    if (buffered && !responseCollector.push(chunk)) buffered = false;
                });
                upstreamRes.on("end", () => {
                    if (responseClosed) return;
                    if (!buffered) {
                        if (!res.headersSent) {
                            res.writeHead(502, { "Content-Type": "application/json" });
                            res.end(facadeErrorBody("Upstream response too large"));
                        }
                        finishOutcome("upstream_stream_error");
                        return;
                    }
                    const rawOpenaiResponse = responseCollector.toBuffer().toString("utf8");
                    let anthropicResponse;
                    let completionTokens = 0;
                    try {
                        const openaiParsed = validateBufferedAnthropicCompletion(JSON.parse(rawOpenaiResponse));
                        if (isResponses) {
                            anthropicResponse = translateChatCompletionToResponse(openaiParsed, { id: requestId, model: requestedModel, customToolNames: opts.customToolNames });
                            // Same token accounting as the buffered chat path:
                            // upstream usage.total_tokens.
                            if (openaiParsed.usage && openaiParsed.usage.total_tokens) completionTokens = openaiParsed.usage.total_tokens;
                        } else {
                            anthropicResponse = translateAnthropicResponse(openaiParsed);
                            if (anthropicResponse.usage && typeof anthropicResponse.usage.output_tokens === "number") {
                                completionTokens = anthropicResponse.usage.output_tokens;
                            }
                        }
                    } catch (e) {
                        if (e instanceof BufferedAnthropicSemanticError || e instanceof BufferedAnthropicMalformedSuccessError) {
                            const semantic = e instanceof BufferedAnthropicSemanticError;
                            warn("Buffered Anthropic semantic failure", {
                                id: targetKey.id,
                                failureKind: semantic ? "error_envelope" : "malformed_success",
                                upstreamCode: semantic ? e.upstreamCode : undefined,
                                upstreamType: semantic ? e.upstreamType : undefined,
                                upstreamStatusCode: semantic ? e.upstreamStatusCode : undefined
                            });
                            failBufferedAnthropic(
                                semantic ? "upstream_semantic_error" : "malformed_upstream_success",
                                semantic ? "Upstream returned a semantic error" : "Upstream returned a malformed completion"
                            );
                            return;
                        }
                        error("Anthropic translation error", { id: targetKey.id, error: e.message, stack: e.stack });
                        failBufferedAnthropic("invalid_upstream_response", "Failed to translate upstream response");
                        return;
                    }
                    const body = JSON.stringify(anthropicResponse);
                    if (!res.headersSent) {
                        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
                    }
                    res.end(body, () => {
                        finishOutcome("completed", completionTokens);
                        if (onResult) onResult({ success: true });
                    });
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
            // Settle-once for the body: `error`, a premature `close` and `end`
            // must never double-handle one response.
            let bodySettled = false;
            // A body cut mid-way after the 200 was committed must reach the
            // client as a TRANSPORT ABORT (Plan L1), never as res.end(): on a
            // chunked reply that writes the terminator and the truncated JSON
            // looks complete. Key accounting matches a committed stream break.
            const failTruncatedBody = () => {
                if (bodySettled) return;
                bodySettled = true;
                finishOutcome("upstream_stream_error");
                if (!res.headersSent) {
                    res.writeHead(502);
                    res.end(JSON.stringify({ error: "Bad Gateway" }));
                } else if (!res.writableEnded) {
                    // The gateway itself tears `res` down: onClientClose must not
                    // log this as a client disconnect.
                    gatewayClosedRes = true;
                    abortCommittedResponse("Upstream response body truncated");
                }
            };
            upstreamRes.on("error", () => {
                if (deadlineAborted || intentionalUpstreamAbort) return;
                failTruncatedBody();
            });
            // Backstop: a premature close with no `error` event is the same break.
            // After a complete `end` (bodySettled) this is a no-op; gateway-owned
            // teardowns (client abort / idle / deadline) already settled the attempt.
            upstreamRes.on("close", () => {
                if (bodySettled || deadlineAborted || intentionalUpstreamAbort || upstreamRes.complete) return;
                failTruncatedBody();
            });
            upstreamRes.on("data", chunk => {
                if (collectingUsage && !responseCollector.push(chunk)) collectingUsage = false;
                writeToClient(chunk);
            });
            upstreamRes.on("end", () => {
                if (bodySettled) return;
                bodySettled = true;
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
        if (intentionalUpstreamAbort || deadlineAborted) return;
        // Э3: a connect-time infra failure (DNS / refused) before any upstream byte
        // is not a key verdict: no handleKeyError, no usage.fail (the terminal
        // outcome is not a failure outcome in accountOutcome), retryable so the
        // loop moves to the next DISTINCT key. Only the errno is logged.
        const infra = !firstByteReceived && onResult ? classifyInfraError(err) : null;
        if (infra) {
            warn("Upstream infra error", { id: targetKey.id, code: infra.code });
            keyOutcomeAccounted = true;
            finishOutcome(infra.reason);
            onResult({ success: false, retryable: true, statusCode: 502, reason: infra.reason });
            return;
        }
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
                // Chat keeps its header-less 502 byte-for-byte; Responses gets the error object.
                writeFacadeError(res, opts.responseMode, 502, isResponses ? { "Content-Type": "application/json" } : {}, "Bad Gateway");
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
    if (onResult && Number.isFinite(opts.requestDeadlineAt) && !res.headersSent && !res.writableEnded) {
        requestDeadlineTimer = setTimeout(() => {
            if (attemptSettled || res.headersSent || res.writableEnded || res.destroyed) return;
            deadlineAborted = true;
            intentionalUpstreamAbort = true;
            finishOutcome("request_deadline");
            clearTimeout(activeMaxStreamTimer);
            wakeActiveStream();
            upstreamReq.destroy();
            activeUpstreamResponse?.destroy();
            onResult({ success: false, retryable: true, statusCode: 504, reason: "request_deadline" });
        }, Math.max(1, opts.requestDeadlineAt - Date.now()));
    }

    // Attach the funnel "close"/"aborted" handlers for THIS attempt. A retryable
    // settle already detached the previous attempt's pair; the defensive detach
    // here also covers any path that re-entered without settling retryably. A
    // failover loop re-enters proxyRequest for each retry on the SAME `req`, so
    // without this every retry would add two more listeners (tripping
    // MaxListenersExceededWarning) and leave stale closures over dead attempts.
    detachFunnelAbortHandlers(req);
    const abortUpstream = () => {
        if (!res.writableEnded) {
            clearTimeout(requestDeadlineTimer);
            clearTimeout(activeMaxStreamTimer);
            intentionalUpstreamAbort = true;
            resTornDown = true;
            if (!terminalOutcome) finishOutcome("client_aborted");
            wakeActiveStream();
            activeUpstreamResponse?.destroy();
            if (upstreamReq.socket && !upstreamReq.socket.destroyed) {
                upstreamReq.socket.destroy();
            }
            upstreamReq.destroy();
            upstreamReq.once("socket", (sock) => {
                sock.destroy();
            });
            if (!attemptSettled && onResult) onResult({ success: false, retryable: false, reason: "client_aborted" });
        }
    };
    const onClientClose = () => {
        if (!res.writableEnded && (req.aborted || req.socket?.destroyed || !req.complete || res.destroyed)) {
            if (!gatewayClosedRes) warn("Client disconnected during upstream transfer", { id: targetKey.id });
            abortUpstream();
        }
    };
    const onClientAborted = () => {
        abortUpstream();
    };
    const onResFinishOrClose = () => {
        detachFunnelAbortHandlers(req);
    };
    // A `res` "error" (aborted write) has no dedicated abort action beyond the
    // "close" that follows it, but it MUST be detachable or every failover attempt
    // leaves one more listener on the same long-lived `res` (see B1 above).
    const onResError = () => {};
    req.on("close", onClientClose);
    req.on("aborted", onClientAborted);
    res.on("close", onClientClose);
    res.on("error", onResError);
    res.once("finish", onResFinishOrClose);
    res.once("close", onResFinishOrClose);
    funnelAbortHandlers.set(req, {
        close: onClientClose,
        aborted: onClientAborted,
        res,
        resClose: onClientClose,
        resError: onResError,
        resFinishOrClose: onResFinishOrClose,
        backpressure: { dispose: disposeBackpressure }
    });
}

function handleModelsWithFailover(req, res, onKeyIdChange) {
    return new Promise((resolve) => {
        let attempt = 0;
        const activeCount = getKeys().filter((k) => k.status === "active").length;
        const maxAttempts = resolveMaxFailoverAttempts(process.env, activeCount, resolveConfiguredMaxFailoverAttempts(undefined));
        // Э3 / decision 1a: /v1/models runs under the SAME total request deadline
        // as chat (resolved once per request, identical precedence).
        const requestDeadlineAt = Date.now() + resolveRequestDeadlineMs(process.env, readConfiguredRequestDeadlineMs());
        let deadlineFired = false;
        // DISTINCT pass: keys tried in the current pass are excluded until every
        // eligible key was tried; only then may a new pass reuse keys.
        const passTriedKeyIds = new Set();
        // Keys of the current pass that failed with a connect-time infra error.
        const silentKeyIds = new Set();
        // REQUEST-level: any other retryable failure keeps the pre-Э3 verdict.
        let nonSilentSeen = false;

        // Set when the LAST attempt was a deadline-released 200 whose body hit the
        // socket timeout: running out of time there is not a deadline cut, so the
        // loop answers it as before Э3 (the attempt-budget 502), never the 504.
        let lastBodyStall = false;
        // REQUEST-level (owner 28.09): one plain-English kind per failed retryable
        // attempt and the distinct keys tried. Feed only the generic 502 `detail`.
        const modelsAttemptKinds = [];
        const modelsTriedKeyIds = new Set();

        const tryNext = () => {
            if (!deadlineFired && lastBodyStall && Date.now() >= requestDeadlineAt) {
                error("All models failover attempts exhausted", { attempts: attempt });
                if (!res.headersSent) {
                    const retryAfter = String(getSoonestActiveCooldownRemainingSeconds());
                    const detail = describeFailedAttempts(modelsAttemptKinds, modelsTriedKeyIds.size);
                    res.writeHead(502, capResponseHeaders({ "Content-Type": "application/json", "Retry-After": retryAfter }));
                    res.end(JSON.stringify({ error: "All failover attempts exhausted", detail }));
                }
                resolve({ success: false });
                return;
            }
            if (deadlineFired || Date.now() >= requestDeadlineAt) {
                error("All models failover attempts exhausted", { attempts: attempt, earlyStopReason: "request_deadline" });
                if (!res.headersSent) {
                    const retryAfter = String(getSoonestActiveCooldownRemainingSeconds());
                    res.writeHead(504, capResponseHeaders({ "Content-Type": "application/json", "Retry-After": retryAfter }));
                    res.end(JSON.stringify({ error: "Gateway request deadline exceeded" }));
                }
                resolve({ success: false });
                return;
            }
            const eligibleKeyIds = getCurrentEligibleKeyIds(undefined);
            const unattemptedKeyIds = eligibleKeyIds.filter((id) => !passTriedKeyIds.has(id));
            const passIds = new Set([...passTriedKeyIds, ...eligibleKeyIds]);
            const passComplete = attempt > 0 && eligibleKeyIds.length > 0 && unattemptedKeyIds.length === 0;
            // Decision 1a: one distinct pass in which every key failed with an
            // infra error -> neutral 503, never the generic 502.
            if (passComplete && !nonSilentSeen && passIds.size > 0 && [...passIds].every((id) => silentKeyIds.has(id))) {
                error("All models failover attempts exhausted", { attempts: attempt, earlyStopReason: "idle_round" });
                if (!res.headersSent) {
                    const retryAfter = String(getSoonestActiveCooldownRemainingSeconds());
                    res.writeHead(503, capResponseHeaders({ "Content-Type": "application/json", "Retry-After": retryAfter }));
                    res.end(JSON.stringify({ error: "Upstream temporarily unavailable" }));
                }
                resolve({ success: false });
                return;
            }
            if (passComplete) {
                passTriedKeyIds.clear();
                silentKeyIds.clear();
                unattemptedKeyIds.push(...eligibleKeyIds);
            }
            if (attempt >= maxAttempts) {
                error("All models failover attempts exhausted", { attempts: attempt });
                if (!res.headersSent) {
                    const retryAfter = String(getSoonestActiveCooldownRemainingSeconds());
                    // Owner 28.09: additive, key-free summary (same helper as chat).
                    const detail = describeFailedAttempts(modelsAttemptKinds, modelsTriedKeyIds.size);
                    res.writeHead(502, capResponseHeaders({ "Content-Type": "application/json", "Retry-After": retryAfter }));
                    res.end(JSON.stringify({ error: "All failover attempts exhausted", detail }));
                }
                resolve({ success: false });
                return;
            }

            const unattemptedSet = new Set(unattemptedKeyIds);
            const excludedKeyIds = new Set(getKeys().map((candidate) => candidate.id).filter((id) => !unattemptedSet.has(id)));
            const key = getNextKey(undefined, { excludedKeyIds });
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
            passTriedKeyIds.add(key.id);
            modelsTriedKeyIds.add(key.id);
            if (onKeyIdChange) onKeyIdChange(key.id);

            handleModelsRequest(req, res, key, (result) => {
                lastBodyStall = result?.bodyStall === true;
                if (result?.reason === "request_deadline") deadlineFired = true;
                else if (result?.retryable === true && isInfraReason(result.reason)) silentKeyIds.add(key.id);
                else if (result?.retryable === true) nonSilentSeen = true;
                if (result.success || !result.retryable) {
                    resolve(result);
                } else {
                    // Detach this attempt's inbound abort pair BEFORE re-entering:
                    // handleModelsRequest now attaches a fresh pair per attempt on
                    // the SAME `req`/`res` via the shared funnel map, so detaching
                    // here keeps that handler set bounded across retries and stops
                    // a stale closure from aborting a dead attempt's upstream
                    // request. Mirrors the retryable-settle detach in proxyRequest.
                    detachFunnelAbortHandlers(req);
                    modelsAttemptKinds.push(result.timedOut === true ? "did not answer in time" : failedAttemptKind(result));
                    // No retry follows when the deadline or the attempt budget
                    // already stops the loop: log the retry only when one happens.
                    const willStop = deadlineFired || Date.now() >= requestDeadlineAt || attempt >= maxAttempts;
                    if (!willStop) {
                        warn("Retrying models with different key", {
                            attempt,
                            maxAttempts,
                            reason: result.reason
                        });
                    }
                    tryNext();
                }
            }, { requestDeadlineAt });
        };

        tryNext();
    });
}

function handleModelsRequest(req, res, targetKey, rawOnResult, opts = {}) {
    let clientGone = false;
    // Э3: the shared request deadline cuts a pending attempt WITHOUT a key
    // penalty and hands the loop a final request_deadline (-> 504). Every settle
    // goes through this once-guard so a late upstream event cannot settle twice.
    let deadlineAborted = false;
    let deadlineTimer;
    let attemptSettled = false;
    // Set once the upstream sent response headers: an error after that point is
    // never a connect-time infra failure (mirrors chat's !firstByteReceived).
    let responseStarted = false;
    // Set when a 200 released the request deadline: a later socket timeout is a
    // stalled BODY, not a deadline cut (the loop answers it as before Э3).
    let deadlineReleased = false;
    // Set by the models socket timeout (upstreamReq.setTimeout below).
    let upstreamTimedOut = false;
    const onResult = typeof rawOnResult === "function"
        ? (result) => {
            if (attemptSettled) return;
            attemptSettled = true;
            clearTimeout(deadlineTimer);
            rawOnResult(result);
        }
        : undefined;
    const options = {
        hostname: NVIDIA_API,
        port: 443,
        path: "/v1/models",
        method: "GET",
        agent: false,  // disable connection pooling
        headers: buildUpstreamRequestHeaders(req.headers, {
            authorization: "Bearer " + targetKey.key
        })
    };

    const upstreamReq = https.request(options, (upstreamRes) => {
        responseStarted = true;
        // Deadline scope (Э1 rule, as chat): the request deadline covers the wait
        // for the upstream to START answering. A 200 is the answer being passed
        // through, so its body is then bounded only by the existing socket timeout
        // MODELS_UPSTREAM_TIMEOUT_MS (upstreamReq.setTimeout below; no new timer).
        // Any other status keeps the deadline: the retry loop may continue after it.
        if (upstreamRes.statusCode === 200) {
            clearTimeout(deadlineTimer);
            deadlineReleased = true;
        }
        const responseCollector = createBoundedBuffer(MAX_BUFFERED_RESPONSE_BYTES);
        let settled = false;
        let overflowed = false;
        const settle = (result) => { if (!settled) { settled = true; onResult?.(result); } };
        // Every `res` write below is skipped once the ATTEMPT was settled by
        // another path (deadline cut, request error): the loop owns `res` then.
        upstreamRes.on("data", chunk => {
            if (settled || attemptSettled) return;
            if (!responseCollector.push(chunk)) {
                overflowed = true;
                settle({ success: false, retryable: false, statusCode: 502, reason: "response_too_large" });
                if (!res.headersSent) { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Upstream response too large" })); }
                upstreamRes.destroy();
            }
        });
        upstreamRes.on("end", () => {
            if (settled || overflowed || attemptSettled) return;
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
            // deadlineAborted: the deadline already settled this attempt and the
            // loop answered 504 on `res`; the teardown of this response must not
            // destroy that finished 504.
            if (settled || deadlineAborted || attemptSettled) return;
            settle({ success: false, retryable: false, statusCode: 502, reason: "response_error" });
            if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: "Bad Gateway" })); }
            else res.destroy(err);
        });
        upstreamRes.on("aborted", () => {
            if (settled || deadlineAborted || attemptSettled) return;
            settle({ success: false, retryable: false, statusCode: 502, reason: "response_aborted" });
            if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: "Bad Gateway" })); }
        });
    });

    upstreamReq.on("error", (err) => {
        // Mirror the chat path's intentional-abort guard
        // (the `intentionalUpstreamAbort` guard in `failBufferedAnthropic`).
        // `clientGone` is set ONLY by `abortModelsUpstream` (below), which is
        // reached exclusively when the client has already disconnected and
        // calls `upstreamReq.destroy()` — Node then emits `"error"` on this
        // same request. Without this guard a merely-disconnected key was
        // parked via handleKeyError (a spurious 5xx backoff) and the attempt
        // settled `retryable: true`, so the failover loop re-entered on the
        // SAME dead `req`/`res` and the eventual res.writeHead(502) targeted a
        // dead socket. The TIMEOUT path (upstreamReq.setTimeout ... destroy)
        // does NOT set `clientGone`, so genuine timeout / upstream transport
        // errors still park the key and settle retryable exactly as before.
        if (clientGone || deadlineAborted) return;
        // Э3: connect-time infra failure (DNS / refused) -> no key penalty, only
        // the errno is logged, the loop moves to the next DISTINCT key.
        const infra = onResult && !responseStarted ? classifyInfraError(err) : null;
        if (infra) {
            warn("Upstream models infra error", { id: targetKey.id, code: infra.code });
            onResult({ success: false, retryable: true, statusCode: 502, reason: infra.reason });
            return;
        }
        error("Upstream models request error", { error: err.message, stack: err.stack });
        // F2: a transport-level failure (ECONNRESET / socket hang-up) is a
        // KEY-scoped verdict, exactly as in the chat path
        // (server.mjs:1764-1770: `handleKeyError(targetKey.id, 502, ...)`). The
        // models path used to settle `retryable: true` WITHOUT parking the key,
        // so getNextKey() could hand the failover loop the SAME broken key again
        // and the loop spun to maxAttempts making no progress. handleKeyError
        // applies the 5xx backoff (rotation.mjs:637-641) so the next attempt
        // selects a DIFFERENT key. A 502 with no modelId is a GLOBAL backoff,
        // identical to the chat path's call shape; retry/abort semantics are
        // otherwise unchanged.
        handleKeyError(targetKey.id, 502, err.message);
        if (onResult) {
            // bodyStall: the body of a deadline-released 200 hit the socket
            // timeout. Accounting above is unchanged (pre-Э3 502 penalty); the
            // flag only keeps the loop from answering the deadline body for it.
            onResult({ success: false, retryable: true, statusCode: 502, reason: "socket_hang_up", bodyStall: deadlineReleased, timedOut: upstreamTimedOut });
        } else if (!res.headersSent) {
            res.writeHead(502);
            res.end(JSON.stringify({ error: "Bad Gateway" }));
        }
    });

    // B2: bound the upstream models fetch so a hung upstream can never stall
    // /v1/models indefinitely. Mirrors the cap on the shared default.
    upstreamReq.setTimeout(MODELS_UPSTREAM_TIMEOUT_MS, () => {
        // Owner 28.09: lets the 502 `detail` say "did not answer in time"; the
        // settle reason and the key accounting below are unchanged.
        upstreamTimedOut = true;
        upstreamReq.destroy(new Error("Upstream models request timeout"));
    });

    // B2: abort the upstream models fetch when the client disconnects — the chat
    // path does the equivalent via the funnel abort pair. Without this an
    // abandoned /v1/models left the upstream request running (and buffering) for
    // a client that was already gone.
    //
    // Models failover re-enters this function on the SAME `req`/`res` (see
    // handleModelsWithFailover.tryNext), so the handlers are tracked in the SAME
    // per-request funnel map as the chat path and detached before each re-entry
    // and on a retryable settle. The funnel detach above removes the PREVIOUS
    // attempt's copy before this attempt attaches exactly one pair, so the live
    // handler set stays bounded across retries and only the current attempt's
    // `abortModelsUpstream` (closing over THIS `upstreamReq`) can fire.
    //
    // This round added BOTH the disconnect abort below and this funnel-based
    // inbound-listener tracking; the pre-fix models path had neither (it attached
    // no inbound `req`/`res` listeners at all).
    const abortModelsUpstream = () => {
        if (clientGone || res.writableEnded) return;
        clientGone = true;
        // The upstream error handler returns early for clientGone without
        // settling, so the deadline timer must be released here.
        clearTimeout(deadlineTimer);
        // Always the CURRENT attempt's request: each re-entry rebuilds this pair
        // and the funnel detach below removes the previous attempt's copy, so a
        // closure can never act on a dead attempt.
        upstreamReq.destroy();
    };
    const onClientClose = () => {
        if (!res.writableEnded && (req.aborted || req.socket?.destroyed || !req.complete || res.destroyed)) {
            abortModelsUpstream();
        }
    };
    // A normal `end()` fires `finish`/`close`; detach then so the completed
    // request leaves no live handler behind (same rule the chat funnel follows).
    const onModelsResFinishOrClose = () => {
        detachFunnelAbortHandlers(req);
    };
    const onModelsResError = () => {};
    // Defensive detach (covers a re-entry that did not settle retryably), then
    // attach exactly ONE live pair for this attempt and record it for the shared
    // detach. `close` is a no-op after a normal `end()`; the guard above keeps a
    // normal completion from tearing down an already-finished upstream.
    // `aborted` fires for an interrupted inbound request before the response ends.
    detachFunnelAbortHandlers(req);
    req.on("close", onClientClose);
    req.on("aborted", abortModelsUpstream);
    res.on("close", onClientClose);
    res.on("error", onModelsResError);
    res.once("finish", onModelsResFinishOrClose);
    res.once("close", onModelsResFinishOrClose);
    funnelAbortHandlers.set(req, {
        close: onClientClose,
        aborted: abortModelsUpstream,
        res,
        resClose: onClientClose,
        resError: onModelsResError,
        resFinishOrClose: onModelsResFinishOrClose
    });

    upstreamReq.end();
    if (onResult && Number.isFinite(opts.requestDeadlineAt) && !res.headersSent && !res.writableEnded) {
        deadlineTimer = setTimeout(() => {
            if (attemptSettled || res.headersSent || res.writableEnded || res.destroyed) return;
            deadlineAborted = true;
            upstreamReq.destroy();
            onResult({ success: false, retryable: true, statusCode: 504, reason: "request_deadline" });
        }, Math.max(1, opts.requestDeadlineAt - Date.now()));
    }
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

    // Defect 1 (2026-10-23 production crash, 2h14m downtime): `new URL(req.url,
    // base)` THROWS on a raw request target such as `//` or `http://[`. The
    // handler is async, so the throw became an unhandled rejection and killed
    // the child. An unparseable target is a CLIENT error: answer 400, log
    // nothing secret, and keep serving every other connection.
    let requestUrl;
    try {
        requestUrl = new URL(req.url, "http://127.0.0.1");
    } catch {
        if (!res.headersSent) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid request url" }));
        } else if (!res.destroyed) {
            res.destroy();
        }
        return;
    }
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

    // Cached models endpoint (no upstream call). Behind auth like /v1/models:
    // explicit LOCAL_TOKEN check in the /v1/models/refresh position, BEFORE
    // the generic gate (classifyGatewayRoute does not classify this path, so
    // the generic gate would 404 it before any handler below could run).
    if (req.method === "GET" && requestUrl.pathname === "/v1/models/cached") {
        if (!LOCAL_TOKEN || !isBearerAuthorized(req.headers.authorization, LOCAL_TOKEN)) {
            res.writeHead(401, { "WWW-Authenticate": "Bearer" });
            res.end();
            return;
        }
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

    if (requestUrl.pathname.startsWith("/v1/")) {
        // Route on the PATHNAME only: clients append query strings (Claude Code
        // always sends POST /v1/messages?beta=true) and some add one trailing
        // slash. The query never influences routing or auth.
        const route = classifyGatewayRoute(req.method, requestUrl.pathname);
        if (!route) { res.writeHead(404); res.end(); return; }
        if (!LOCAL_TOKEN || !isGatewayRouteAuthorized(route, req.headers, LOCAL_TOKEN)) { res.writeHead(401, { "WWW-Authenticate": "Bearer" }); res.end(); return; }
        // Canonicalize from the ROUTE, not the raw URL: the chat passthrough
        // forwards `req.url` upstream, so the client query / trailing slash is
        // dropped here and can never reach the upstream request path.
        const canonicalPath = GATEWAY_ROUTE_PATHS[route];
        req.url = canonicalPath;
        requestUrl = new URL(canonicalPath, "http://127.0.0.1");
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
                    // F4 (drain-based): write the 413 and DRAIN the rest of the
                    // incoming body. The previous fix destroyed `req` on
                    // `res`'s "finish" — but "finish" only means the RESPONSE
                    // was flushed, not that the CLIENT finished UPLOADING. The
                    // client is still mid-upload, so destroying the socket
                    // aborted its in-flight send and it saw ECONNRESET instead
                    // of reading the 413 (~50% of requests, measured). Draining
                    // lets the client finish sending and read the response.
                    res.writeHead(413, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Payload Too Large" }));
                }
                // SECURITY INTENT PRESERVED: we stop BUFFERING (nothing more is
                // pushed to bodyChunks) and discard every remaining chunk. The
                // body is drained, never accumulated. A client that never
                // finishes sending is bounded by the safety timer armed below.
                armOversizedRequestSafetyTimer(req, res, "chat");
                req.resume();
                return;
            }
            bodyChunks.push(chunk);
        });
        req.on("end", () => {
            if (bodyLength > MAX_PAYLOAD_SIZE) {
                // The oversized body finished draining: unschedule the safety
                // timer and return without touching the buffered (discarded)
                // chunks or any upstream key.
                clearOversizedRequestSafetyTimer(req);
                return;
            }
            let bodyBuffer = Buffer.concat(bodyChunks);
            let isStream = false;
            let requestedModelId = undefined;

            // Defect 3 (Level-1 W1): content-type is a HINT, never a gate. A
            // client that omits it — or labels a JSON body text/plain — still
            // gets the same JSON handling: the disabled-model 404 and the
            // reasoning defaults used to be silently skipped in that case.
            // Defect 2: a JSON body that is not an object (null / [] / "str")
            // is a client error, answered 400 HERE — before any key is touched
            // and before `parsed.stream` could throw and kill the child.
            if (bodyBuffer.length > 0) {
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
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                    // Same envelope and the same no-parser-detail rule as above.
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "invalid request body" }));
                    return;
                }
                if (parsed.stream === true) {
                    isStream = true;
                }
                // Capture requested model id for disabled-model check below.
                if (typeof parsed.model === "string") requestedModelId = parsed.model;
                // Defect 4 (pass 2): a streamed Chat Completions response carries
                // token counts ONLY when the request asks for them. The gateway
                // read a usage frame it never requested, so every real streamed
                // turn recorded `tokens: null` while the fakes (which volunteered
                // usage) kept the tests green. The client's own stream_options is
                // preserved; the flag is merged in, not replaced.
                //
                // Defect 6 (pass 3) DECISION: asking upstream costs the client one
                // extra `{"choices":[],"usage":{...}}` frame it did not request.
                // That frame is spec-mandated for a request carrying
                // `include_usage: true`, so it is kept -- dropping the flag would
                // re-break the measured accounting defect (tokens were null in
                // 5,528 of 5,532 streamed rows) for every client. The ONE case
                // where the client's contract must win is an EXPLICIT
                // `include_usage: false`: a strict client that opted out of the
                // frame gets no injection, and its turn honestly records
                // `tokens: null` rather than being handed a frame it refused.
                if (isStream) {
                    const existing = parsed.stream_options;
                    const optedOut = existing && typeof existing === "object" && !Array.isArray(existing)
                        && existing.include_usage === false;
                    if (!optedOut) {
                        const merged = existing && typeof existing === "object" && !Array.isArray(existing)
                            ? { ...existing, include_usage: true }
                            : { include_usage: true };
                        parsed.stream_options = merged;
                        bodyBuffer = Buffer.from(JSON.stringify(parsed), "utf8");
                    }
                }
                // GLM-5.3 and Kimi K3 only: upstream defaults to reasoning_effort=max (minutes of
                // thinking). Inject the gateway defaults; every other model is
                // forwarded byte-for-byte as before.
                if (usesReasoningDefaults(requestedModelId)) {
                    bodyBuffer = Buffer.from(JSON.stringify(applyReasoningDefaults(parsed)), "utf8");
                }
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
        // `close` always fires once the inbound request is done (drained, errored
        // or aborted), which is exactly when the drain-safety timer must go away.
        // WeakMap-held keys/lifetimes mean this clears AT MOST the one timer for
        // THIS request, so there is no cross-request state and no listener leak.
        req.on("close", () => clearOversizedRequestSafetyTimer(req));
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
                    // F4 (drain-based): flush the 413 then DRAIN the incoming
                    // body. Destroying `req` on the response's "finish" aborted
                    // the client's still-running upload and answered with
                    // ECONNRESET instead of the 413 (see the chat path above
                    // for the full rationale and the measured race).
                    res.writeHead(413, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Payload Too Large" } }));
                }
                armOversizedRequestSafetyTimer(req, res, "messages");
                req.resume();
                return;
            }
            bodyChunks.push(chunk);
        });
        req.on("end", () => {
            if (bodyLength > MAX_PAYLOAD_SIZE) {
                // Oversized body drained: unschedule the safety timer (no
                // buffer is concatenated and no upstream key is touched).
                clearOversizedRequestSafetyTimer(req);
                return;
            }
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

            applyReasoningDefaults(openaiBody);
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
        req.on("close", () => clearOversizedRequestSafetyTimer(req));
        return;
    }

    // ── OpenAI Responses API facade ────────────────────────────────────────
    // POST /v1/responses (Codex CLI `wire_api = "responses"`) → translate to
    // Chat Completions, forward through the SAME failover spine as chat (auth,
    // key rotation, 429/5xx failover, rate-limit and key-usage accounting), and
    // translate the reply (JSON or SSE) back to the Responses shape
    // (responses-adapter.mjs). Errors use the OpenAI `{ error: {...} }` envelope.
    if (req.method === "POST" && requestUrl.pathname === "/v1/responses") {
        let bodyChunks = [];
        let bodyLength = 0;
        const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5MB — same as chat

        const sendResponsesError = (httpStatus, errorType, message, param = null, code = null) => {
            if (res.headersSent) return;
            res.writeHead(httpStatus, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message, type: errorType, param, code } }));
        };

        req.on("data", chunk => {
            bodyLength += chunk.length;
            if (bodyLength > MAX_PAYLOAD_SIZE) {
                // F4 (drain-based): answer 413 and DRAIN the rest of the body
                // (see the chat path above for the rationale).
                sendResponsesError(413, "invalid_request_error", "Payload Too Large");
                armOversizedRequestSafetyTimer(req, res, "responses");
                req.resume();
                return;
            }
            bodyChunks.push(chunk);
        });
        req.on("end", () => {
            if (bodyLength > MAX_PAYLOAD_SIZE) {
                clearOversizedRequestSafetyTimer(req);
                return;
            }
            // Malformed JSON fails fast HERE, before any key is touched; the
            // parser message is never echoed back.
            let responsesBody;
            try {
                responsesBody = JSON.parse(Buffer.concat(bodyChunks).toString("utf8"));
            } catch {
                sendResponsesError(400, "invalid_request_error", "invalid request body");
                return;
            }

            const { chatBody, warnings, errors, ignored, unsupportedParam, customToolNames } = translateResponsesRequest(responsesBody);
            if (warnings.length > 0) log("debug", "Responses facade translation warnings", { warnings });
            if (ignored.length > 0) log("debug", "Responses facade ignored fields", { ignored });
            if (errors.length > 0 || !chatBody) {
                sendResponsesError(400, "invalid_request_error", errors.join("; ") || "Invalid Responses request",
                    unsupportedParam ?? null, unsupportedParam ? "unsupported_parameter" : null);
                return;
            }

            // SUB-TASK A#3: disabled models fail fast, exactly like chat.
            const requestedModelId = chatBody.model;
            if (getDisabledModels().includes(requestedModelId.toLowerCase())) {
                sendResponsesError(404, "invalid_request_error", "model not found: " + requestedModelId, "model", "model_not_found");
                return;
            }

            applyReasoningDefaults(chatBody);
            let translatedBuffer;
            try {
                translatedBuffer = Buffer.from(JSON.stringify(chatBody), "utf8");
            } catch (e) {
                error("Responses facade serialization error", { error: e.message });
                sendResponsesError(500, "server_error", "Failed to serialize translated request");
                return;
            }

            // customToolNames: freeform tools sent upstream as functions; their
            // tool_calls are translated back to custom_tool_call items.
            const opts = { responseMode: "responses", requestId: newResponseId(), model: requestedModelId, customToolNames };
            req.url = "/v1/chat/completions";

            proxyRequestWithFailover(req, res, translatedBuffer, chatBody.stream === true, (newKeyId) => {
                loggedKeyId = newKeyId;
            }, opts);
        });

        req.on("error", (err) => {
            error("Client request error", { error: err.message, stack: err.stack });
            sendResponsesError(400, "invalid_request_error", "Client request error");
        });
        req.on("close", () => clearOversizedRequestSafetyTimer(req));
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
    // Code only (e.g. EADDRINUSE): err.message may carry paths and stays in the log.
    // Console policy: literal-only console calls. Each known bind code maps to a fixed line.
    const code = err?.code;
    if (code === "EADDRINUSE") console.error("[Gateway:E_STARTUP] Startup failed (EADDRINUSE)");
    else if (code === "EACCES") console.error("[Gateway:E_STARTUP] Startup failed (EACCES)");
    else if (code === "EADDRNOTAVAIL") console.error("[Gateway:E_STARTUP] Startup failed (EADDRNOTAVAIL)");
    else console.error("[Gateway:E_STARTUP] Startup failed");
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

// Defect 5 (Level-1 W1): LAST-RESORT crash reporting. The child had no
// uncaughtException/unhandledRejection handler at all, so a single stray throw
// anywhere killed it with a bare non-zero exit and nothing in gateway.jsonl to
// explain the 2h14m outage (2026-10-23T15:33:38Z). This does NOT keep the
// process alive: a throw that reaches here means an invariant is broken, so the
// exit stays deliberately non-zero and the parent's bounded restart decides.
// Only the redacted message/stack is logged — never headers, bodies or keys.
let crashHandling = false;
function handleFatal(kind, reason) {
    if (crashHandling) return;
    crashHandling = true;
    try {
        error("Gateway fatal error", {
            kind,
            error: reason instanceof Error ? reason.message : String(reason),
            stack: reason instanceof Error ? reason.stack : undefined
        });
        flushLogs();
    } catch {
        // Logging must never mask the original crash.
    }
    process.exitCode = 1;
    // Give the synchronous flush its chance; exit explicitly and non-zero.
    setTimeout(() => process.exit(1), 100);
}

process.on("uncaughtException", (reason) => handleFatal("uncaught_exception", reason));
process.on("unhandledRejection", (reason) => handleFatal("unhandled_rejection", reason));
