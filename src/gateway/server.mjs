import http from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import { handleAdminRequest } from "./admin-api.mjs";
import { getNextKey, getKeys, handleKeyError, markKeyUsedAndDebounceSave, initializeState, getSoonestActiveCooldownRemainingSeconds } from "./rotation.mjs";
import { info, warn, error, flushLogs } from "./logger.mjs";
import { sanitizeProxyHeaders, capResponseHeaders } from "./proxy-headers.mjs";
import { createUpstreamSocketTimeouts, resolveGatewayTimeouts, resolveRetryFirstByteTimeoutMs } from "./upstream-timeouts.mjs";
import { getModelLimits, getDisabledModels, setModelLimits } from "./model-limits.mjs";
import { getCapabilityMetadata } from "./capability-registry.mjs";
import { classifyUpstreamResponse, isSuccessfulStatus, parseRetryAfter, resolveMaxFailoverAttempts } from "./failover-policy.mjs";
import { createBoundedBuffer, resolveMaxBufferedResponseBytes } from "./bounded-buffer.mjs";
import { flushState } from "./rotation.mjs";
import { classifyGatewayRoute, isAllowedOrigin, isBearerAuthorized, parseCorsAllowlist } from "./security.mjs";
import { translateAnthropicRequest, translateAnthropicResponse, translateAnthropicSseStream } from "./anthropic-adapter.mjs";
import { pathnameOnly, setRuntimeSecrets } from "../shared/redaction.mjs";
import crypto from "node:crypto";
import { getCachedModels, refreshModels } from "./model-discovery.mjs";
import { createDirectGlmProbeScheduler, runDirectGlmProbe, shouldScheduleDirectGlmProbe } from "./direct-glm-probe.mjs";
import { mergeProbedReasoning, scheduleCapabilityRefresh } from "./capability-probe.mjs";

const NVIDIA_API = "integrate.api.nvidia.com";
let LOCAL_TOKEN;
let ADMIN_TOKEN;
const CORS_ALLOWLIST = parseCorsAllowlist(process.env.GATEWAY_CORS_ALLOWLIST);
const { firstByteTimeoutMs, idleTimeoutMs, maxStreamDurationMs } = resolveGatewayTimeouts();
// Retried failover attempts (attempt > 1 after a 429/5xx) use a shorter
// first-byte window so a hung / slow-to-429 upstream cannot stall each key
// switch for the full 5-min fresh default. min() keeps it <= firstByte AND
// <= DEFAULT_RETRY_FIRST_BYTE_TIMEOUT_MS (env-overridable). The first attempt
// keeps the full fresh-request window so a legitimately slow NVIDIA response
// is still tolerated on a fresh request.
const retryFirstByteTimeoutMs = resolveRetryFirstByteTimeoutMs(firstByteTimeoutMs);
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

function proxyRequestWithFailover(req, res, bodyBuffer, isStream, onKeyIdChange, opts = {}) {
    return new Promise((resolve) => {
        let attempt = 0;
        const activeCount = getKeys().filter((k) => k.status === "active").length;
        const maxAttempts = resolveMaxFailoverAttempts(process.env, activeCount);

        const tryNext = () => {
            if (attempt >= maxAttempts) {
                error("All failover attempts exhausted", { attempts: attempt });
                if (!res.headersSent) {
                    const retryAfter = String(getSoonestActiveCooldownRemainingSeconds());
                    if (opts.responseMode === "anthropic") {
                        res.writeHead(502, { "Content-Type": "application/json", "Retry-After": retryAfter });
                        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "All failover attempts exhausted" } }));
                    } else {
                        res.writeHead(502, capResponseHeaders({ "Content-Type": "application/json", "Retry-After": retryAfter }));
                        res.end(JSON.stringify({ error: "All failover attempts exhausted" }));
                    }
                }
                resolve({ success: false });
                return;
            }

            const key = getNextKey();
            if (!key) {
                warn("No available keys to service request");
                if (!res.headersSent) {
                    const retryAfter = String(getSoonestActiveCooldownRemainingSeconds());
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
            if (onKeyIdChange) onKeyIdChange(key.id);

            proxyRequest(req, res, key, bodyBuffer, isStream, (result) => {
                if (result.success || !result.retryable) {
                    resolve(result);
                } else {
                    warn("Retrying with different key", {
                        attempt,
                        maxAttempts,
                        reason: result.reason
                    });
                    tryNext();
                }
            }, attempt > 1 ? { ...opts, firstByteTimeoutMs: retryFirstByteTimeoutMs } : opts);
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

function proxyRequest(req, res, targetKey, bodyBuffer, isStream, onResult, opts = {}) {
    const isAnthropic = opts.responseMode === "anthropic";
    const requestId = isAnthropic ? opts.requestId : undefined;
    const requestedModel = isAnthropic ? opts.model : undefined;

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

    const upstreamTimeouts = createUpstreamSocketTimeouts({
        firstByteTimeoutMs: opts.firstByteTimeoutMs ?? firstByteTimeoutMs,
        idleTimeoutMs,
        onTimeout: () => {
            if (!firstByteReceived) {
                intentionalUpstreamAbort = true;
                upstreamReq.destroy();
                warn("Upstream first-byte timeout", { id: targetKey.id });
                handleKeyError(targetKey.id, 504, "First byte timeout", null);
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
                handleKeyError(targetKey.id, statusCode, errorBody, retryAfter);
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
            }, maxStreamDurationMs);

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
                            clearTimeout(maxStreamTimer);\n                            intentionalUpstreamAbort = true;\n                            upstreamReq.destroy();\n                            activeUpstreamResponse?.destroy();\n                            handleKeyError(targetKey.id, 500, \"Upstream SSE Error\", null);\n                            keyOutcomeAccounted = true;\n                            finishOutcome(\"upstream_sse_error\");\n                            if (onResult) {\n                                onResult({ success: false, retryable: true, statusCode: 500, reason: \"upstream_sse_error\" });\n                            }\n                            return;\n                        }\n                        startAnthropicStream();\n                    }\n\n                    sseObserver.observe(chunk);\n                    upstreamQueue.push(chunk.toString(\"utf8\"));\n                    if (resolveUpstream) { const r = resolveUpstream; resolveUpstream = null; r(); }\n                });\n\n                upstreamRes.on(\"error\", (err) => {\n                    if (streamClosed) return;\n                    streamClosed = true;\n                    clearTimeout(maxStreamTimer);\n                    intentionalUpstreamAbort = true;\n                    error(\"Upstream response stream error\", { id: targetKey.id, upstreamStatus: statusCode });\n                    finishOutcome(\"upstream_stream_error\");\n                    if (!res.headersSent && !firstChunkHandled) {\n                        handleKeyError(targetKey.id, 502, err.message, null);\n                        keyOutcomeAccounted = true;\n                        if (onResult) {\n                            onResult({ success: false, retryable: true, statusCode: 502, reason: \"upstream_stream_error\" });\n                            return;\n                        }\n                    }\n                    res.destroy(err);\n                });\n                upstreamRes.on(\"aborted\", () => {\n                    if (streamClosed) return;\n                    streamClosed = true;\n                    clearTimeout(maxStreamTimer);\n                    intentionalUpstreamAbort = true;\n                    finishOutcome(\"upstream_stream_error\");\n                    if (!res.headersSent && !firstChunkHandled) {\n                        handleKeyError(targetKey.id, 502, \"Upstream response aborted\", null);\n                        keyOutcomeAccounted = true;\n                        if (onResult) {\n                            onResult({ success: false, retryable: true, statusCode: 502, reason: \"upstream_stream_error\" });\n                            return;\n                        }\n                    }\n                    res.destroy(new Error(\"Upstream response aborted\"));\n                });\n                res.on(\"error\", () => {\n                    if (streamClosed) return;\n                    streamClosed = true;\n                    clearTimeout(maxStreamTimer);\n                    intentionalUpstreamAbort = true;\n                    finishOutcome(\"client_aborted\");\n                    upstreamRes.destroy();\n                });\n                res.on(\"close\", () => {\n                    if (streamClosed || res.writableEnded) return;\n                    streamClosed = true;\n                    clearTimeout(maxStreamTimer);\n                    intentionalUpstreamAbort = true;\n                    finishOutcome(\"client_aborted\");\n                    upstreamReq.destroy();\n                    upstreamRes.destroy();\n                });\n                upstreamRes.on(\"end\", async () => {\n                    if (streamClosed) return;\n                    if (!firstChunkHandled) {\n                        firstChunkHandled = true;\n                        streamClosed = true;\n                        clearTimeout(maxStreamTimer);\n                        finishOutcome(\"incomplete_stream\");\n                        if (!res.headersSent && onResult) {\n                            onResult({ success: false, retryable: true, statusCode: 502, reason: \"incomplete_stream\" });\n                            return;\n                        }\n                    }\n                    upstreamDone = true;\n                    if (resolveUpstream) { const r = resolveUpstream; resolveUpstream = null; r(); }\n                    if (finalizeAnthropicStream) await finalizeAnthropicStream;\n                    if (streamClosed) return;\n                    streamClosed = true;\n                    clearTimeout(maxStreamTimer);\n                    sseObserver.end();\n                    if (sseErrorObserved) {\n                        finishOutcome(\"upstream_sse_error\");\n                    } else if (sseObserver.sawDone) {\n                        finishOutcome(\"completed\");\n                    } else {\n                        finishOutcome(\"incomplete_stream\");\n                    }\n                    if (!res.writableEnded) res.end();\n                });\n                return;\n            }\n\n            upstreamRes.on(\"data\", (chunk) => {\n                if (streamClosed) return;\n                if (!firstChunkHandled) {\n                    firstChunkHandled = true;\n                    if (!res.headersSent && checkFirstChunkForSseError(chunk)) {\n                        streamClosed = true;\n                        clearTimeout(maxStreamTimer);\n                        intentionalUpstreamAbort = true;\n                        upstreamReq.destroy();\n                        activeUpstreamResponse?.destroy();\n                        handleKeyError(targetKey.id, 500, \"Upstream SSE Error\", null);\n                        keyOutcomeAccounted = true;\n                        finishOutcome(\"upstream_sse_error\");\n                        if (onResult) {\n                            onResult({ success: false, retryable: true, statusCode: 500, reason: \"upstream_sse_error\" });\n                        }\n                        return;\n                    }\n                    res.writeHead(statusCode, capResponseHeaders(upstreamRes.headers));\n                    if (onResult) onResult({ success: true });\n                }\n                sseObserver.observe(chunk);\n                res.write(chunk);\n            });\n            upstreamRes.on(\"error\", (err) => {\n                if (streamClosed) return;\n                streamClosed = true;\n                clearTimeout(maxStreamTimer);\n                error(\"Upstream response stream error\", { id: targetKey.id, upstreamStatus: statusCode });\n                finishOutcome(\"upstream_stream_error\");\n                if (!res.headersSent && !firstChunkHandled) {\n                    handleKeyError(targetKey.id, 502, err.message, null);\n                    keyOutcomeAccounted = true;\n                    if (onResult) {\n                        onResult({ success: false, retryable: true, statusCode: 502, reason: \"upstream_stream_error\" });\n                        return;\n                    }\n                }\n                res.destroy(err);\n            });\n            upstreamRes.on(\"aborted\", () => {\n                if (streamClosed) return;\n                streamClosed = true;\n                clearTimeout(maxStreamTimer);\n                finishOutcome(\"upstream_stream_error\");\n                if (!res.headersSent && !firstChunkHandled) {\n                    handleKeyError(targetKey.id, 502, \"Upstream response aborted\", null);\n                    keyOutcomeAccounted = true;\n                    if (onResult) {\n                        onResult({ success: false, retryable: true, statusCode: 502, reason: \"upstream_stream_error\" });\n                        return;\n                    }\n                }\n                res.destroy(new Error(\"Upstream response aborted\"));\n            });\n            res.on(\"error\", () => {\n                if (streamClosed) return;\n                streamClosed = true;\n                clearTimeout(maxStreamTimer);\n                intentionalUpstreamAbort = true;\n                finishOutcome(\"client_aborted\");\n                upstreamRes.destroy();\n            });\n            res.on(\"close\", () => {\n                if (streamClosed || res.writableEnded) return;\n                streamClosed = true;\n                clearTimeout(maxStreamTimer);\n                intentionalUpstreamAbort = true;\n                finishOutcome(\"client_aborted\");\n                upstreamReq.destroy();\n                upstreamRes.destroy();\n            });\n            upstreamRes.on(\"end\", () => {\n                if (streamClosed) return;\n                if (!firstChunkHandled) {\n                    firstChunkHandled = true;\n                    streamClosed = true;\n                    clearTimeout(maxStreamTimer);\n                    finishOutcome(\"incomplete_stream\");\n                    if (!res.headersSent && onResult) {\n                        onResult({ success: false, retryable: true, statusCode: 502, reason: \"incomplete_stream\" });\n                        return;\n                    }\n                }\n                streamClosed = true;\n                clearTimeout(maxStreamTimer);\n                sseObserver.end();\n                if (sseErrorObserved) {\n                    finishOutcome(\"upstream_sse_error\");\n                } else if (sseObserver.sawDone) {\n                    finishOutcome(\"completed\");\n                } else {\n                    finishOutcome(\"incomplete_stream\");\n                }\n                if (!res.writableEnded) res.end();\n            });\n        } else {\n            if (isAnthropic) {\n                // Anthropic non-streaming facade: buffer the upstream OpenAI\n                // JSON response fully, translate it to the Anthropic Messages\n                // shape, and send the single Anthropic JSON body to the client.\n                if (statusCode === 204) {\n                    upstreamRes.resume();\n                    res.writeHead(500, { \"Content-Type\": \"application/json\" });\n                    res.end(JSON.stringify({ type: \"error\", error: { type: \"api_error\", message: \"Upstream returned no content\" } }));\n                    finishOutcome(\"upstream_stream_error\");\n                    if (onResult) onResult({ success: false, retryable: false, statusCode: 500 });\n                    return;\n                }\n                // Release the failover key BEFORE any byte is flushed to the\n                // client so a future retry can never replay the request after\n                // the stream starts — security constraint §6e#1.\n                if (onResult) onResult({ success: true });\n                const responseCollector = createBoundedBuffer(MAX_BUFFERED_RESPONSE_BYTES);\n                let buffered = true;\n                upstreamRes.on(\"error\", (err) => {\n                    if (!res.headersSent) {\n                        res.writeHead(502, { \"Content-Type\": \"application/json\" });\n                        res.end(JSON.stringify({ type: \"error\", error: { type: \"api_error\", message: \"Bad Gateway\" } }));\n                    } else {\n                        res.destroy(err);\n                    }\n                    finishOutcome(\"upstream_stream_error\");\n                });\n                upstreamRes.on(\"data\", (chunk) => {\n                    if (buffered && !responseCollector.push(chunk)) buffered = false;\n                });\n                upstreamRes.on(\"end\", () => {\n                    if (!buffered) {\n                        if (!res.headersSent) {\n                            res.writeHead(502, { \"Content-Type\": \"application/json\" });\n                            res.end(JSON.stringify({ type: \"error\", error: { type: \"api_error\", message: \"Upstream response too large\" } }));\n                        }\n                        finishOutcome(\"upstream_stream_error\");\n                        return;\n                    }\n                    const rawOpenaiResponse = responseCollector.toBuffer().toString(\"utf8\");\n                    let anthropicResponse;\n                    let completionTokens = 0;\n                    try {\n                        const openaiParsed = JSON.parse(rawOpenaiResponse);\n                        anthropicResponse = translateAnthropicResponse(openaiParsed);\n                        if (anthropicResponse.usage && typeof anthropicResponse.usage.output_tokens === \"number\") {\n                            completionTokens = anthropicResponse.usage.output_tokens;\n                        }\n                    } catch (e) {\n                        error(\"Anthropic translation error\", { id: targetKey.id, error: e.message, stack: e.stack });\n                        if (!res.headersSent) {\n                            res.writeHead(502, { \"Content-Type\": \"application/json\" });\n                            res.end(JSON.stringify({ type: \"error\", error: { type: \"api_error\", message: \"Failed to translate upstream response\" } }));\n                        }\n                        finishOutcome(\"upstream_stream_error\");\n                        return;\n                    }\n                    const body = JSON.stringify(anthropicResponse);\n                    if (!res.headersSent) {\n                        res.writeHead(200, { \"Content-Type\": \"application/json\", \"Content-Length\": Buffer.byteLength(body) });\n                    }\n                    res.end(body);\n                    finishOutcome(\"completed\", completionTokens);\n                });\n                return;\n            }\n            if (statusCode === 204) {\n                upstreamRes.resume();\n                res.writeHead(204, capResponseHeaders(upstreamRes.headers));\n                res.end();\n                finishOutcome(\"completed\", 0);\n                if (onResult) onResult({ success: true });\n                return;\n            }\n            res.writeHead(statusCode, capResponseHeaders(upstreamRes.headers));\n            if (onResult) onResult({ success: true });\n            const responseCollector = createBoundedBuffer(MAX_BUFFERED_RESPONSE_BYTES);\n            let collectingUsage = true;\n            res.on(\"error\", () => {});\n            upstreamRes.on(\"error\", (err) => {\n                if (!res.headersSent) res.writeHead(502);\n                if (!res.writableEnded) res.end();\n                finishOutcome(\"upstream_stream_error\");\n            });\n            upstreamRes.on(\"data\", chunk => {\n                if (collectingUsage && !responseCollector.push(chunk)) collectingUsage = false;\n                res.write(chunk);\n            });\n            upstreamRes.on(\"end\", () => {\n                res.end();\n                try {\n                    if (!collectingUsage) throw new Error(\"usage collection overflow\");\n                    const parsed = JSON.parse(responseCollector.toBuffer().toString(\"utf8\"));\n                    if (parsed.usage && parsed.usage.total_tokens) {\n                        completionTokens = parsed.usage.total_tokens;\n                    }\n                } catch (e) {\n                }\n                finishOutcome(\"completed\", completionTokens);\n            });\n        }\n    });\n\n    upstreamReq.on(\"socket\", (socket) => {\n        upstreamTimeouts.attach(socket);\n    });\n\n    upstreamReq.on(\"error\", (err) => {\n        if (intentionalUpstreamAbort) return;\n        error(\"Upstream request error\", { id: targetKey.id, error: err.message, stack: err.stack });\n        if (!firstByteReceived) {\n            handleKeyError(targetKey.id, 502, err.message, null);\n            keyOutcomeAccounted = true;\n        }\n        finishOutcome(\"upstream_stream_error\");\n        if (onResult && !firstByteReceived) {\n            onResult({ success: false, retryable: true, statusCode: 502, reason: \"socket_hang_up\" });\n        } else if (!res.headersSent) {\n            if (isAnthropic) {\n                res.writeHead(502, { \"Content-Type\": \"application/json\" });\n                res.end(JSON.stringify({ type: \"error\", error: { type: \"api_error\", message: \"Bad Gateway\" } }));\n            } else {\n                res.writeHead(502);\n                res.end(JSON.stringify({ error: \"Bad Gateway\" }));\n            }\n        } else {\n            res.destroy(err);\n        }\n        if (onResult && firstByteReceived) onResult({ success: false, retryable: false });\n    });\n\n    if (bodyBuffer) {\n        upstreamReq.write(bodyBuffer);\n    }\n    upstreamReq.end();\n\n    req.on(\"close\", () => {\n        // Only abort upstream if we've already started receiving the response.\n        // Destroying upstreamReq during TLS handshake causes socket hang up\n        // on the upstream side instead of letting it complete naturally.\n        if (!res.writableEnded && firstByteReceived) {\n            warn(\"Client disconnected during upstream transfer\", { id: targetKey.id });\n            intentionalUpstreamAbort = true;\n            if (!terminalOutcome) finishOutcome(\"client_aborted\");\n            activeUpstreamResponse?.destroy();\n            upstreamReq.destroy();\n        }\n    });\n\n    req.on(\"aborted\", () => {\n        if (!res.writableEnded) {\n            intentionalUpstreamAbort = true;\n            finishOutcome(\"client_aborted\");\n            upstreamReq.destroy();\n        }\n    });\n}\n\nfunction handleModelsWithFailover(req, res, onKeyIdChange) {\n    return new Promise((resolve) => {\n        let attempt = 0;\n        const activeCount = getKeys().filter((k) => k.status === \"active\").length;\n        const maxAttempts = resolveMaxFailoverAttempts(process.env, activeCount);\n\n        const tryNext = () => {\n            if (attempt >= maxAttempts) {\n                error(\"All models failover attempts exhausted\", { attempts: attempt });\n                if (!res.headersSent) {\n                    const retryAfter = String(getSoonestActiveCooldownRemainingSeconds());\n                    res.writeHead(502, capResponseHeaders({ \"Content-Type\": \"application/json\", \"Retry-After\": retryAfter }));\n                    res.end(JSON.stringify({ error: \"All failover attempts exhausted\" }));\n                }\n                resolve({ success: false });\n                return;\n            }\n\n            const key = getNextKey();\n            if (!key) {\n                warn(\"No available keys for models request\");\n                if (!res.headersSent) {\n                    const retryAfter = String(getSoonestActiveCooldownRemainingSeconds());\n                    res.writeHead(503, capResponseHeaders({ \"Content-Type\": \"application/json\", \"Retry-After\": retryAfter }));\n                    res.end(JSON.stringify({ error: \"All API keys exhausted\" }));\n                }\n                resolve({ success: false });\n                return;\n            }\n\n            attempt++;\n            if (onKeyIdChange) onKeyIdChange(key.id);\n\n            handleModelsRequest(req, res, key, (result) => {\n                if (result.success || !result.retryable) {\n                    resolve(result);\n                } else {\n                    warn(\"Retrying models with different key\", {\n                        attempt,\n                        maxAttempts,\n                        reason: result.reason\n                    });\n                    tryNext();\n                }\n            });\n        };\n\n        tryNext();\n    });\n}\n\nfunction handleModelsRequest(req, res, targetKey, onResult) {\n    const options = {\n        hostname: NVIDIA_API,\n        port: 443,\n        path: \"/v1/models\",\n        method: \"GET\",\n        agent: false,  // disable connection pooling\n        headers: {\n            ...req.headers,\n            \"host\": NVIDIA_API,\n            \"authorization\": \"Bearer \" + targetKey.key,\n            \"HTTP-Referer\": \"https://opencode.ai/\",\n            \"X-Title\": \"opencode\",\n            \"X-BILLING-INVOKE-ORIGIN\": \"OpenCode\"\n        }\n    };\n\n    sanitizeProxyHeaders(options.headers);\n\n    const upstreamReq = https.request(options, (upstreamRes) => {\n        const responseCollector = createBoundedBuffer(MAX_BUFFERED_RESPONSE_BYTES);\n        let settled = false;\n        let overflowed = false;\n        const settle = (result) => { if (!settled) { settled = true; onResult?.(result); } };\n        upstreamRes.on(\"data\", chunk => {\n            if (settled) return;\n            if (!responseCollector.push(chunk)) {\n                overflowed = true;\n                settle({ success: false, retryable: false, statusCode: 502, reason: \"response_too_large\" });\n                if (!res.headersSent) { res.writeHead(502, { \"Content-Type\": \"application/json\" }); res.end(JSON.stringify({ error: \"Upstream response too large\" })); }\n                upstreamRes.destroy();\n            }\n        });\n        upstreamRes.on(\"end\", () => {\n            if (settled || overflowed) return;\n            const responseBody = responseCollector.toBuffer().toString(\"utf8\");\n            if (isSuccessfulStatus(upstreamRes.statusCode)) {\n                if (upstreamRes.statusCode === 204) {\n                    res.writeHead(204, capResponseHeaders(upstreamRes.headers));\n                    res.end();\n                    settle({ success: true });\n                    return;\n                }\n                try {\n                    const parsed = JSON.parse(responseBody);\n                    if (parsed && Array.isArray(parsed.data)) {\n                        const enrichedModelIds = [];\n                        parsed.data.forEach(model => {\n                            // Skip a malformed entry gracefully so a single bad\n                            // upstream object never crashes the whole /v1/models\n                            // response (robust enrichment). getCapabilityMetadata\n                            // is itself null/undefined-safe, but model.id access\n                            // and the property assignment below require an object.\n                            if (!model || typeof model !== \"object\" || Array.isArray(model)) return;\n                            const limits = getModelLimits(model.id);\n                            model.context_length = limits.context;\n                            model.max_completion_tokens = limits.output;\n                            model.max_tokens = limits.context;\n                            // Static family capabilities first, then override the\n                            // reasoning block with a LIVE-probed result when one is\n                            // cached (probed truth beats a static family guess; a\n                            // missing/stale probe leaves the static value intact).\n                            model.capabilities = getCapabilityMetadata(model.id);\n                            mergeProbedReasoning(model.capabilities, model.id);\n                            if (typeof model.id === \"string\") enrichedModelIds.push(model.id);\n                        });\n                        // SUB-TASK A#2: drop disabled model ids from the client-facing catalog\n                        // (the OpenAI-compatible list clients pick from). Non-object / non-string-id\n                        // entries pass through untouched (matches the malformed-entry contract in\n                        // tests/model-enrichment.test.mjs). Only objects whose string id is in the\n                        // operator-curated disabledModels are removed. F1: comparison is\n                        // case-insensitive — getDisabledModels() returns lowercased ids, and the\n                        // model id is lowercased before the Set lookup.\n                        const disabledIds = getDisabledModels();\n                        if (disabledIds.length > 0) {\n                            const disabled = new Set(disabledIds);\n                            parsed.data = parsed.data.filter(\n                                (m) => !(m && typeof m === \"object\" && !Array.isArray(m) && typeof m.id === \"string\" && disabled.has(m.id.toLowerCase()))\n                            );\n                        }\n                        // REAL reasoning-capability discovery: lazily refresh stale\n                        // probed capability entries for the models just served.\n                        // Fire-and-forget and non-blocking — this response was\n                        // already built from cache/static; outcomes are logged to\n                        // gateway.jsonl as capability_probe events. The scheduler is\n                        // a no-op under the test upstream sentinel unless force-\n                        // enabled, so hermetic harness tests never see probe traffic.\n                        if (enrichedModelIds.length > 0) {\n                            scheduleCapabilityRefresh(enrichedModelIds, {\n                                logger: (outcome) => info(\"capability_probe\", outcome),\n                                keyProvider: () => getNextKey()?.key ?? null\n                            });\n                        }\n                    }\n                    const modifiedBody = JSON.stringify(parsed);\n                    const responseHeaders = { ...upstreamRes.headers };\n                    delete responseHeaders[\"transfer-encoding\"];\n                    res.writeHead(upstreamRes.statusCode, capResponseHeaders({\n                        ...responseHeaders,\n                        \"content-length\": Buffer.byteLength(modifiedBody)\n                    }));\n                    res.end(modifiedBody);\n                    settle({ success: true });\n                } catch (e) {\n                    res.writeHead(upstreamRes.statusCode, capResponseHeaders(upstreamRes.headers));\n                    res.end(responseBody);\n                    settle({ success: true });\n                }\n                return;\n            }\n\n            warn(\"Upstream non-2xx response on models\", { statusCode: upstreamRes.statusCode });\n            handleKeyError(targetKey.id, upstreamRes.statusCode, responseBody, parseRetryAfter(upstreamRes.headers[\"retry-after\"]));\n\n            if (classifyUpstreamResponse(upstreamRes.statusCode, upstreamRes.headers).retryable && !res.headersSent) {\n                settle({ success: false, retryable: true, statusCode: upstreamRes.statusCode, reason: \"http_\" + upstreamRes.statusCode });\n                return;\n            }\n\n            res.writeHead(upstreamRes.statusCode, capResponseHeaders(upstreamRes.headers));\n            res.end(responseBody);\n            settle({ success: false, retryable: false, statusCode: upstreamRes.statusCode });\n        });\n\n        upstreamRes.on(\"error\", (err) => {\n            error(\"Upstream models response stream error\", { id: targetKey.id });\n            if (!res.headersSent) {\n                handleKeyError(targetKey.id, 502, err.message, null);\n                settle({ success: false, retryable: true, statusCode: 502, reason: \"upstream_stream_error\" });\n                return;\n            }\n            res.destroy(err);\n        });\n    });\n\n    upstreamReq.on(\"error\", (err) => {\n        error(\"Upstream models request error\", { id: targetKey.id, error: err.message, stack: err.stack });\n        handleKeyError(targetKey.id, 502, err.message, null);\n        if (!res.headersSent) {\n            onResult?.({ success: false, retryable: true, statusCode: 502, reason: \"socket_error\" });\n        } else {\n            res.destroy(err);\n        }\n    });\n\n    upstreamReq.end();\n}\n\nconst server = http.createServer(async (req, res) => {\n    const startTime = process.hrtime.bigint();\n    let loggedKeyId = null;\n\n    // Install request-logging hook before any response work\n    const logRequest = () => {\n        const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6; // ms\n        info(\"request\", {\n            method: req.method,\n            path: pathnameOnly(req.url),\n            status: res.statusCode,\n            duration_ms: Math.round(elapsed),\n            keyIndex: loggedKeyId\n        });\n    };\n    let logged = false;\n    res.once(\"finish\", () => { logRequest(); logged = true; });\n    res.once(\"close\", () => {\n        if (logged) return;\n        const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6;\n        info(\"request\", {\n            method: req.method,\n            path: pathnameOnly(req.url),\n            status: res.statusCode || 0,\n            duration_ms: Math.round(elapsed),\n            keyIndex: loggedKeyId,\n            aborted: true\n        });\n    });\n\n    const requestUrl = new URL(req.url, \"http://127.0.0.1\");\n    const origin = req.headers.origin;\n    const allowedOrigin = origin && isAllowedOrigin(origin, CORS_ALLOWLIST);\n    if (origin && !allowedOrigin) { res.writeHead(403); res.end(); return; }\n    if (allowedOrigin) { res.setHeader(\"Access-Control-Allow-Origin\", CORS_ALLOWLIST.find((candidate) => candidate === origin)); res.setHeader(\"Vary\", \"Origin\"); }\n    if (req.method === \"OPTIONS\") {\n        const requestedMethod = req.headers[\"access-control-request-method\"];\n        if (!allowedOrigin || !classifyGatewayRoute(requestedMethod, requestUrl.pathname)) { res.writeHead(403); res.end(); return; }\n        res.writeHead(204, { \"Access-Control-Allow-Methods\": requestedMethod, \"Access-Control-Allow-Headers\": \"Authorization, Content-Type\" }); res.end(); return;\n    }\n\n    if (req.method === \"GET\" && req.url === \"/health\") {\n        res.writeHead(isReady ? 200 : 503, { \"Content-Type\": \"application/json\" });\n        res.end(JSON.stringify({ status: isReady ? \"ok\" : \"starting\" }));\n        return;\n    }\n\n    // Cached models endpoint (no upstream call)\n    if (req.method === \"GET\" && requestUrl.pathname === \"/v1/models/cached\") {\n        try {\n            const models = await getCachedModels();\n            res.writeHead(200, { \"Content-Type\": \"application/json\" });\n            res.end(JSON.stringify({ data: models, cached: true }));\n        } catch (err) {\n            error(\"Failed to get cached models\", { error: err.message });\n            res.writeHead(500, { \"Content-Type\": \"application/json\" });\n            res.end(JSON.stringify({ error: \"Failed to retrieve cached models\" }));\n        }\n        return;\n    }\n\n    // Manual refresh endpoint (admin only)\n    if (req.method === \"POST\" && requestUrl.pathname === \"/v1/models/refresh\") {\n        if (!ADMIN_TOKEN || !isBearerAuthorized(req.headers.authorization, ADMIN_TOKEN)) {\n            res.writeHead(401, { \"WWW-Authenticate\": \"Bearer\" });\n            res.end();\n            return;\n        }\n        try {\n            const all = await refreshModels();\n            // SUB-TASK A#2: keep /v1/models/refresh consistent with /v1/models —\n            // exclude operator-disabled models from the returned set. (The model-discovery\n            // cache already filters the separate GATEWAY_DISABLED_MODELS env var; this is\n            // the additional config.json disabledModels filter.) F1: case-insensitive —\n            // getDisabledModels() returns lowercased ids; model id lowercased before lookup.\n            const disabledIds = getDisabledModels();\n            const data = disabledIds.length === 0\n                ? all\n                : all.filter((m) => !(m && typeof m === \"object\" && !Array.isArray(m) && typeof m.id === \"string\" && new Set(disabledIds).has(m.id.toLowerCase())));\n            res.writeHead(200, { \"Content-Type\": \"application/json\" });\n            res.end(JSON.stringify({ data, cached: false }));\n        } catch (err) {\n            error(\"Failed to refresh models\", { error: err.message });\n            res.writeHead(500, { \"Content-Type\": \"application/json\" });\n            res.end(JSON.stringify({ error: \"Failed to refresh models\" }));\n        }\n        return;\n    }\n\n    if (requestUrl.pathname.startsWith(\"/v1/\")) {\n        const route = classifyGatewayRoute(req.method, requestUrl.pathname);\n        if (!route || requestUrl.search) { res.writeHead(404); res.end(); return; }\n        if (!LOCAL_TOKEN || !isBearerAuthorized(req.headers.authorization, LOCAL_TOKEN)) { res.writeHead(401, { \"WWW-Authenticate\": \"Bearer\" }); res.end(); return; }\n    }\n    if (req.method === \"GET\" && requestUrl.pathname === \"/v1/models\") {\n        return handleModelsWithFailover(req, res, (newKeyId) => {\n            loggedKeyId = newKeyId;\n        });\n    }\n\n    if (req.method === \"POST\" && requestUrl.pathname === \"/v1/chat/completions\") {\n        let bodyChunks = [];\n        let bodyLength = 0;\n        const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5MB\n\n        req.on(\"data\", chunk => {\n            bodyLength += chunk.length;\n            if (bodyLength > MAX_PAYLOAD_SIZE) {\n                if (!res.headersSent) {\n                    res.writeHead(413, { \"Content-Type\": \"application/json\" });\n                    res.end(JSON.stringify({ error: \"Payload Too Large\" }));\n                }\n                req.destroy();\n                return;\n            }\n            bodyChunks.push(chunk);\n        });\n        req.on(\"end\", () => {\n            if (bodyLength > MAX_PAYLOAD_SIZE) return;\n            let bodyBuffer = Buffer.concat(bodyChunks);\n            let isStream = false;\n            let requestedModelId = undefined;\n\n            if (req.headers[\"content-type\"]?.includes(\"application/json\") && bodyBuffer.length > 0) {\n                try {\n                    const parsed = JSON.parse(bodyBuffer.toString(\"utf8\"));\n                    if (parsed.stream === true) {\n                        isStream = true;\n                    }\n                    // Capture requested model id for disabled-model check below.\n                    if (typeof parsed?.model === \"string\") requestedModelId = parsed.model;\n                } catch (e) {\n                }\n            }\n\n            // SUB-TASK A#3: fail fast — block a request for a disabled model BEFORE any key\n            // rotation / upstream call (matches OpenAI unknown-model semantics). The check is at\n            // request START; an already-streaming response is never unwound (documented edge).\n            // F1: case-insensitive — getDisabledModels() returns lowercased ids.\n            if (requestedModelId && getDisabledModels().includes(requestedModelId.toLowerCase())) {\n                res.writeHead(404, { \"Content-Type\": \"application/json\" });\n                res.end(JSON.stringify({ error: { message: \"model not found: \" + requestedModelId, type: \"invalid_request_error\", code: \"model_not_found\" } }));\n                return;\n            }\n\n            proxyRequestWithFailover(req, res, bodyBuffer, isStream, (newKeyId) => {\n                loggedKeyId = newKeyId;\n            });\n        });\n\n        req.on(\"error\", (err) => {\n            error(\"Client request error\", { error: err.message, stack: err.stack });\n            if (!res.headersSent) {\n                res.writeHead(400);\n                res.on(\"error\", () => {}); res.end();\n            }\n        });\n        return;\n    }\n\n    // ── Anthropic Messages API facade ──────────────────────────────────────\n    // POST /v1/messages  →  translate to OpenAI Chat Completions, forward to\n    // NVIDIA upstream via the shared failover spine, translate the OpenAI\n    // response (JSON or SSE) back to Anthropic shape. All errors are returned\n    // in Anthropic's error envelope. Auth uses the same LOCAL_TOKEN Bearer\n    // gate as the OpenAI chat path (see classifyGatewayRoute: 'messages').\n    if (req.method === \"POST\" && requestUrl.pathname === \"/v1/messages\") {\n        let bodyChunks = [];\n        let bodyLength = 0;\n        const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5MB — same as chat\n\n        const sendAnthropicError = (httpStatus, errorType, message) => {\n            if (res.headersSent) return;\n            res.writeHead(httpStatus, { \"Content-Type\": \"application/json\" });\n            res.end(JSON.stringify({ type: \"error\", error: { type: errorType, message } }));\n        };\n\n        req.on(\"data\", chunk => {\n            bodyLength += chunk.length;\n            if (bodyLength > MAX_PAYLOAD_SIZE) {\n                if (!res.headersSent) {\n                    res.writeHead(413, { \"Content-Type\": \"application/json\" });\n                    res.end(JSON.stringify({ type: \"error\", error: { type: \"invalid_request_error\", message: \"Payload Too Large\" } }));\n                }\n                req.destroy();\n                return;\n            }\n            bodyChunks.push(chunk);\n        });\n        req.on(\"end\", () => {\n            if (bodyLength > MAX_PAYLOAD_SIZE) return;\n            const bodyBuffer = Buffer.concat(bodyChunks);\n\n            let anthropicBody;\n            try {\n                anthropicBody = JSON.parse(bodyBuffer.toString(\"utf8\"));\n            } catch (e) {\n                sendAnthropicError(400, \"invalid_request_error\", \"Invalid JSON body\");\n                return;\n            }\n\n            const { openaiBody, warnings, errors } = translateAnthropicRequest(anthropicBody);\n            if (warnings.length > 0) {\n                info(\"Anthropic facade translation warnings\", { warnings });\n            }\n            if (errors.length > 0 || !openaiBody) {\n                sendAnthropicError(400, \"invalid_request_error\", errors.join(\"; \") || \"Invalid Anthropic request\");\n                return;\n            }\n\n            // SUB-TASK A#3: fail fast — block a request for a disabled model BEFORE\n            // translation/proxy. Anthropic clients pass the model id through unchanged\n            // (anthropic-adapter.mjs: openaiBody.model = body.model), so the raw\n            // requested id is the one forwarded upstream and the one the disabled list keys on.\n            // F1: case-insensitive — getDisabledModels() returns lowercased ids.\n            const requestedModelId = typeof anthropicBody.model === \"string\"\n                ? anthropicBody.model\n                : (typeof openaiBody.model === \"string\" ? openaiBody.model : \"\");\n            if (requestedModelId && getDisabledModels().includes(requestedModelId.toLowerCase())) {\n                sendAnthropicError(404, \"not_found_error\", \"model: \" + requestedModelId + \" not found\");\n                return;\n            }\n\n            const isStream = openaiBody.stream === true;\n            // Re-serialize the translated OpenAI body so the upstream gets a\n            // clean Chat Completions payload. Content-Length is derived from\n            // this translated buffer, not the client's oversized Anthropic one.\n            let translatedBuffer;\n            try {\n                translatedBuffer = Buffer.from(JSON.stringify(openaiBody), \"utf8\");\n            } catch (e) {\n                error(\"Anthropic facade serialization error\", { error: e.message });\n                sendAnthropicError(500, \"api_error\", \"Failed to serialize translated request\");\n                return;\n            }\n\n            const requestId = \"msg_\" + crypto.randomUUID();\n            const requestedModel = typeof anthropicBody.model === \"string\" ? anthropicBody.model : (openaiBody.model || \"\");\n            const opts = { responseMode: \"anthropic\", requestId, model: requestedModel };\n            // Replace req.url so any upstream-derived logs reference the\n            // Chat Completions target rather than /v1/messages.\n            req.url = \"/v1/chat/completions\";\n\n            proxyRequestWithFailover(req, res, translatedBuffer, isStream, (newKeyId) => {\n                loggedKeyId = newKeyId;\n            }, opts);\n        });\n\n        req.on(\"error\", (err) => {\n            error(\"Client request error\", { error: err.message, stack: err.stack });\n            if (!res.headersSent) {\n                sendAnthropicError(400, \"invalid_request_error\", \"Client request error\");\n            }\n        });\n        return;\n    }\n\n    res.writeHead(404);\n    res.on(\"error\", () => {}); res.end();\n});\n\nconst PORT = Number.parseInt(process.env.PORT || \"12004\", 10);\nif (!Number.isInteger(PORT) || PORT < 1 || PORT > 65534) {\n    throw new Error(\"PORT must be an integer between 1 and 65534.\");\n}\n\nconst ADMIN_PORT = parseInt(PORT, 10) + 1;\nconst adminServer = http.createServer((req, res) => {\n    if (req.url.startsWith(\"/admin/\")) {\n        // Parity with every other branch: swallow a late-write error on res so it\n        // can never crash the process on future Node versions (defensive only).\n        res.on(\"error\", () => {});\n        return handleAdminRequest(req, res, { adminToken: ADMIN_TOKEN });\n    }\n    res.writeHead(404);\n    res.on(\"error\", () => {}); res.end();\n});\n\nfunction failStartup(serverName, err) {\n    error(serverName + \" failed to start\", { port: serverName === \"Gateway\" ? PORT : ADMIN_PORT, error: err.message, stack: err.stack });\n    console.error(\"[Gateway:E_STARTUP] Startup failed\");\n    if (server.listening) server.close();\n    if (adminServer.listening) adminServer.close();\n    process.exitCode = 1;\n    setTimeout(() => process.exit(1), 3000);\n}\n\nserver.on(\"error\", (err) => failStartup(\"Gateway\", err));\nadminServer.on(\"error\", (err) => failStartup(\"Admin\", err));\n\nserver.listen(PORT, \"127.0.0.1\", () => {\n    info(\"Gateway started\", { port: PORT });\n    console.log(\"GATEWAY_LISTENING\");\n    adminServer.listen(ADMIN_PORT, \"127.0.0.1\", () => {\n        isReady = Boolean(LOCAL_TOKEN && ADMIN_TOKEN);\n        info(\"Admin API started\", { port: ADMIN_PORT });\n        console.log(\"ADMIN_LISTENING\");\n        if (typeof process.send === \"function\") {\n            process.send({ type: \"ports:bound\", challenge: ipcChallenge, gatewayPort: PORT, adminPort: ADMIN_PORT });\n        }\n        // F3: best-effort background cache warm so the first /admin/models (and\n        // /v1/models/cached) call does not pay the up-to-30s upstream fetch\n        // latency, which exceeds the admin-client's 5s socket timeout. Delayed +\n        // unref'd: the 2s delay ensures the warm never fires during the ~2s\n        // lifecycle of test children (which would otherwise shift a queued\n        // response off queue-based fake upstreams). In production the 2s delay is\n        // negligible and fire-and-forget — a fetch failure is swallowed and\n        // getCachedModels() retries lazily on the next request.\n        const cacheWarmTimer = setTimeout(() => {\n            refreshModels().catch(() => { /* cache warm is best-effort */ });\n        }, 2000);\n        cacheWarmTimer.unref();\n    });\n});\n\nprocess.on(\"message\", (message) => {\n    if (message?.type === \"state:init\") isReady = Boolean(LOCAL_TOKEN && ADMIN_TOKEN && server.listening && adminServer.listening);\n});\n\nfunction shutdown() {\n    info(\"Gateway shutting down\", { graceful: true });\n    // Flush remaining log buffer before exit\n    flushState();\n    flushLogs();\n    server.close();\n    adminServer.close();\n}\n\nprocess.once(\"SIGTERM\", shutdown);\nprocess.once(\"SIGINT\", shutdown);\n