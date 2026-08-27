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
let LOCAL_TOKEN;\r
let ADMIN_TOKEN;\r
const CORS_ALLOWLIST = parseCorsAllowlist(process.env.GATEWAY_CORS_ALLOWLIST);\r
const { firstByteTimeoutMs, idleTimeoutMs, maxStreamDurationMs } = resolveGatewayTimeouts();\r
// Retried failover attempts (attempt > 1 after a 429/5xx) use a shorter\r
// first-byte window so a hung / slow-to-429 upstream cannot stall each key\r
// switch for the full 5-min fresh default. min() keeps it <= firstByte AND\r
// <= DEFAULT_RETRY_FIRST_BYTE_TIMEOUT_MS (env-overridable). The first attempt\r
// keeps the full fresh-request window so a legitimately slow NVIDIA response\r
// is still tolerated on a fresh request.\r
const retryFirstByteTimeoutMs = resolveRetryFirstByteTimeoutMs(firstByteTimeoutMs);\r
let isReady = false;\r
const ipcChallenge = crypto.randomBytes(32).toString("base64url");\r
const directGlmProbeScheduler = createDirectGlmProbeScheduler({\r
    probe: () => runDirectGlmProbe({\r
        envValue: process.env.NV_GATEWAY_DIRECT_GLM_PROBE,\r
        keyRecords: getKeys(),\r
        logger: (outcome) => info("direct_glm_probe", outcome)\r
    }),\r
    logger: (outcome) => info("direct_glm_probe", outcome)\r
});\r
if (typeof process.send === "function") {\r
process.on("message", (message) => {\r
    if (message?.type === "state:init") {\r
        if (message.challenge !== ipcChallenge) return;\r
        initializeState(message.state);\r
        LOCAL_TOKEN = message.state?.credentials?.gatewayToken;\r
        ADMIN_TOKEN = message.state?.credentials?.adminToken;\r
        // Model limits ride the SAME bound channel inside `state` as a\r
        // numbers-only Record<string,{context,output}> attached by the main\r
        // process (no secrets, no paths — sanitized on both sides). Injected\r
        // entries win over file/env resolution (which is absent when packaged).\r
        setModelLimits(message.state?.modelLimits);\r
        setRuntimeSecrets([LOCAL_TOKEN, ADMIN_TOKEN]);\r
        if (shouldScheduleDirectGlmProbe({\r
            message,\r
            expectedChallenge: ipcChallenge,\r
            envValue: process.env.NV_GATEWAY_DIRECT_GLM_PROBE\r
        })) directGlmProbeScheduler.schedule(true);\r
    }\r
});\r
process.send({ type: "ready", challenge: ipcChallenge });\r
}\r
\r
const MAX_BUFFERED_RESPONSE_BYTES = resolveMaxBufferedResponseBytes();\r
\r
// Background model refresh every 24 hours\r
const modelsRefreshInterval = setInterval(() => {\r
    refreshModels().catch(err => warn("Background model refresh failed", { error: err.message }));\r
}, 24 * 60 * 60 * 1000);\r
modelsRefreshInterval.unref();\r
\r
function proxyRequestWithFailover(req, res, bodyBuffer, isStream, onKeyIdChange, opts = {}) {\r
    return new Promise((resolve) => {\r
        let attempt = 0;\r
        const activeCount = getKeys().filter((k) => k.status === "active").length;\r
        const maxAttempts = resolveMaxFailoverAttempts(process.env, activeCount);\r
\r
        const tryNext = () => {\r
            if (attempt >= maxAttempts) {\r
                error("All failover attempts exhausted", { attempts: attempt });\r
                if (!res.headersSent) {\r
                    const retryAfter = String(getSoonestActiveCooldownRemainingSeconds());\r
                    if (opts.responseMode === "anthropic") {\r
                        res.writeHead(502, { "Content-Type": "application/json", "Retry-After": retryAfter });\r
                        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "All failover attempts exhausted" } }));\r
                    } else {\r
                        res.writeHead(502, capResponseHeaders({ "Content-Type": "application/json", "Retry-After": retryAfter }));\r
                        res.end(JSON.stringify({ error: "All failover attempts exhausted" }));\r
                    }\r
                }\r
                resolve({ success: false });\r
                return;\r
            }\r
\r
            const key = getNextKey();\r
            if (!key) {\r
                warn("No available keys to service request");\r
                if (!res.headersSent) {\r
                    const retryAfter = String(getSoonestActiveCooldownRemainingSeconds());\r
                    if (opts.responseMode === "anthropic") {\r
                        res.writeHead(503, { "Content-Type": "application/json", "Retry-After": retryAfter });\r
                        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "All API keys exhausted" } }));\r
                    } else {\r
                        res.writeHead(503, capResponseHeaders({ "Content-Type": "application/json", "Retry-After": retryAfter }));\r
                        res.end(JSON.stringify({ error: "All API keys exhausted" }));\r
                    }\r
                }\r
                resolve({ success: false });\r
                return;\r
            }\r
\r
            attempt++;\r
            if (onKeyIdChange) onKeyIdChange(key.id);\r
\r
            proxyRequest(req, res, key, bodyBuffer, isStream, (result) => {\r
                if (result.success || !result.retryable) {\r
                    resolve(result);\r
                } else {\r
                    warn("Retrying with different key", {\r
                        attempt,\r
                        maxAttempts,\r
                        reason: result.reason\r
                    });\r
                    tryNext();\r
                }\r
            }, attempt > 1 ? { ...opts, firstByteTimeoutMs: retryFirstByteTimeoutMs } : opts);\r
        };\r
\r
        tryNext();\r
    });\r
}\r
\r
const MAX_SSE_FRAME_CHARS = 64 * 1024;\r
\r
function safeSseField(value) {\r
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;\r
    if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)) return value;\r
    return undefined;\r
}\r
\r
function safeModelId(value) {\r
    return typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value) ? value : undefined;\r
}\r
\r
function safeStatusCode(value) {\r
    const numericValue = typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : value;\r
    return Number.isInteger(numericValue) && numericValue >= 100 && numericValue <= 599 ? numericValue : undefined;\r
}\r
\r
// Build an Anthropic-shaped error envelope for an upstream OpenAI error\r
// response (non-2xx). Maps the OpenAI status to an Anthropic error type and\r
// extracts the upstream message string from a best-effort parse of the body.\r
// Used only on the anthropic facade path so the error shape always matches\r
// Anthropic's error envelope (security constraint §6e#3).\r
function buildAnthropicUpstreamError(statusCode, upstreamBody) {\r
    let errorType = "api_error";\r
    if (statusCode === 401 || statusCode === 403) errorType = "authentication_error";\r
    else if (statusCode === 404) errorType = "not_found_error";\r
    else if (statusCode === 429) errorType = "rate_limit_error";\r
    else if (statusCode === 413 || statusCode === 400 || statusCode === 422) errorType = "invalid_request_error";\r
    else if (statusCode === 503 || statusCode === 529) errorType = "overloaded_error";\r
\r
    let message = `Upstream returned status ${statusCode}`;\r
    if (upstreamBody) {\r
        try {\r
            const parsed = JSON.parse(upstreamBody);\r
            const candidate = parsed?.error?.message || parsed?.message;\r
            if (typeof candidate === "string" && candidate.trim()) message = candidate;\r
        } catch {\r
            if (typeof upstreamBody === "string" && upstreamBody.trim()) {\r
                message = upstreamBody.slice(0, 1000);\r
            }\r
        }\r
    }\r
    return { type: "error", error: { type: errorType, message } };\r
}\r
\r
function createSseObserver(onErrorEvent) {\r
    const decoder = new StringDecoder("utf8");\r
    let pending = "";\r
    let discardingOversizedFrame = false;\r
    let sawDone = false;\r
\r
    const inspectFrame = (frame) => {\r
        const lines = frame.split(/\r?\n/);\r
        const eventIsError = lines.some((line) => /^event:\s*error\s*$/i.test(line));\r
        const data = lines\r
            .filter((line) => line.startsWith("data:"))\r
            .map((line) => line.slice(5).replace(/^ /, ""))\r
            .join("\n");\r
\r
        if (data.trim() === "[DONE]") {\r
            sawDone = true;\r
            return;\r
        }\r
\r
        let parsed;\r
        try {\r
            parsed = JSON.parse(data);\r
        } catch {\r
            // Non-JSON SSE data is valid and must remain opaque to the gateway.\r
        }\r
\r
        if (eventIsError || (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed)) {\r
            const upstreamError = parsed && typeof parsed.error === "object" && parsed.error !== null\r
                ? parsed.error\r
                : {};\r
            onErrorEvent({\r
                upstreamCode: safeSseField(upstreamError.code),\r
                upstreamType: safeSseField(upstreamError.type),\r
                upstreamStatusCode: safeStatusCode(upstreamError.status_code ?? upstreamError.status)\r
            });\r
        }\r
    };\r
\r
    const consume = (text) => {\r
        let remaining = text;\r
\r
        while (remaining.length > 0) {\r
            if (discardingOversizedFrame) {\r
                const separator = /\r?\n\r?\n|\r\r/.exec(remaining);\r
                if (!separator) return;\r
                remaining = remaining.slice(separator.index + separator[0].length);\r
                discardingOversizedFrame = false;\r
                continue;\r
            }\r
\r
            const available = MAX_SSE_FRAME_CHARS - pending.length;\r
            if (available === 0) {\r
                pending = "";\r
                discardingOversizedFrame = true;\r
                continue;\r
            }\r
\r
            pending += remaining.slice(0, available);\r
            remaining = remaining.slice(available);\r
\r
            while (pending.length > 0) {\r
                const separator = /\r?\n\r?\n|\r\r/.exec(pending);\r
                if (!separator) {\r
                    break;\r
                }\r
\r
                const frame = pending.slice(0, separator.index);\r
                pending = pending.slice(separator.index + separator[0].length);\r
                inspectFrame(frame);\r
            }\r
\r
            if (pending.length === MAX_SSE_FRAME_CHARS) {\r
                pending = "";\r
                discardingOversizedFrame = true;\r
            }\r
        }\r
    };\r
\r
    return {\r
        observe(chunk) {\r
            consume(decoder.write(chunk));\r
        },\r
        end() {\r
            consume(decoder.end());\r
        },\r
        get sawDone() {\r
            return sawDone;\r
        }\r
    };\r
}\r
\r
function checkFirstChunkForSseError(chunk) {\r
    if (!chunk) return false;\r
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");\r
    const trimmed = text.trim();\r
    if (!trimmed) return false;\r
\r
    const lines = text.split(/\r?\n/);\r
    if (lines.some((line) => /^event:\s*error\s*$/i.test(line))) {\r
        return true;\r
    }\r
\r
    const dataLines = lines\r
        .filter((line) => line.startsWith("data:"))\r
        .map((line) => line.slice(5).trim());\r
    const data = dataLines.join("\n").trim();\r
\r
    if (data && data !== "[DONE]") {\r
        try {\r
            const parsed = JSON.parse(data);\r
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {\r
                if ("error" in parsed) return true;\r
                if (parsed.code === 500 || parsed.code === "500" || parsed.type === "internal_server_error") return true;\r
                if (typeof parsed.type === "string" && parsed.type.toLowerCase().includes("error")) return true;\r
            }\r
        } catch {\r
        }\r
    }\r
\r
    try {\r
        const parsed = JSON.parse(trimmed);\r
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {\r
            if ("error" in parsed) return true;\r
            if (parsed.code === 500 || parsed.code === "500" || parsed.type === "internal_server_error") return true;\r
            if (typeof parsed.type === "string" && parsed.type.toLowerCase().includes("error")) return true;\r
        }\r
    } catch {\r
    }\r
\r
    return false;\r
}\r
\r
function proxyRequest(req, res, targetKey, bodyBuffer, isStream, onResult, opts = {}) {\r
    const isAnthropic = opts.responseMode === "anthropic";\r
    const requestId = isAnthropic ? opts.requestId : undefined;\r
    const requestedModel = isAnthropic ? opts.model : undefined;\r
\r
    const options = {\r
        hostname: NVIDIA_API,\r
        port: 443,\r
        // The Anthropic facade must forward to the OpenAI Chat Completions upstream\r
        // (translated body), never to /v1/messages upstream (which NVIDIA does not\r
        // expose). The passthrough chat path keeps the original client URL.\r
        path: isAnthropic ? "/v1/chat/completions" : req.url,\r
        // Method stays POST in both modes; Anthropic clients send POST /v1/messages.\r
        method: req.method,\r
        agent: false,  // disable connection pooling to prevent stale socket reuse\r
        headers: {\r
            ...req.headers,\r
            "host": NVIDIA_API,\r
            "authorization": "Bearer " + targetKey.key,\r
            "HTTP-Referer": "https://opencode.ai/",\r
            "X-Title": "opencode",\r
            "X-BILLING-INVOKE-ORIGIN": "OpenCode"\r
        }\r
    };\r
\r
    // Strip hop-by-hop and problematic headers that should not be forwarded.\r
    sanitizeProxyHeaders(options.headers);\r
    if (bodyBuffer) {\r
        delete options.headers["transfer-encoding"];\r
        options.headers["content-length"] = String(Buffer.byteLength(bodyBuffer));\r
    }\r
    // Anthropic facade security: never forward Anthropic ingress credentials\r
    // (x-api-key / anthropic-version) upstream. The gateway injects the selected\r
    // NVIDIA upstream Bearer key (above). This also matches constraint §6e#2.\r
    if (isAnthropic) {\r
        delete options.headers["x-api-key"];\r
        delete options.headers["anthropic-version"];\r
        delete options.headers["anthropic-beta"];\r
    }\r
\r
    let firstByteReceived = false;\r
    let intentionalUpstreamAbort = false;\r
    let activeUpstreamResponse = null;\r
    let terminalOutcome = null;\r
    let keyOutcomeAccounted = false;\r
\r
    const recordOutcome = (outcome) => {\r
        if (terminalOutcome) return false;\r
        terminalOutcome = outcome;\r
        info("request_outcome", { id: targetKey.id, outcome });\r
        return true;\r
    };\r
\r
    const accountOutcome = (outcome, tokens = 0) => {\r
        if (keyOutcomeAccounted) return;\r
        keyOutcomeAccounted = true;\r
        if (outcome === "completed") {\r
            markKeyUsedAndDebounceSave(targetKey.id, { success: true, tokens });\r
        } else if (outcome === "upstream_sse_error" || outcome === "upstream_stream_error" || outcome === "incomplete_stream") {\r
            markKeyUsedAndDebounceSave(targetKey.id, { success: false });\r
        }\r
    };\r
\r
    const finishOutcome = (outcome, tokens = 0) => {\r
        if (recordOutcome(outcome)) accountOutcome(outcome, tokens);\r
    };\r
\r
    const upstreamTimeouts = createUpstreamSocketTimeouts({\r
        firstByteTimeoutMs: opts.firstByteTimeoutMs ?? firstByteTimeoutMs,\r
        idleTimeoutMs,\r
        onTimeout: () => {\r
            if (!firstByteReceived) {\r
                intentionalUpstreamAbort = true;\r
                upstreamReq.destroy();\r
                warn("Upstream first-byte timeout", { id: targetKey.id });\r
                handleKeyError(targetKey.id, 504, "First byte timeout", null);\r
                keyOutcomeAccounted = true;\r
                finishOutcome("first_byte_timeout");\r
                if (onResult) {\r
                    onResult({ success: false, retryable: true, statusCode: 504, reason: "timeout" });\r
                } else if (!res.headersSent) {\r
                    if (isAnthropic) {\r
                        res.writeHead(504, { "Content-Type": "application/json" });\r
                        res.end(JSON.stringify({ type: "error", error: { type: "request_timeout", message: "Gateway timeout" } }));\r
                    } else {\r
                        res.writeHead(504);\r
                        res.end(JSON.stringify({ error: "Gateway timeout" }));\r
                    }\r
                } else {\r
                    res.destroy(new Error("Gateway timeout"));\r
                }\r
            } else {\r
                warn("Upstream socket idle timeout", { id: targetKey.id });\r
                intentionalUpstreamAbort = true;\r
                upstreamReq.destroy();\r
                activeUpstreamResponse?.destroy();\r
                finishOutcome("idle_timeout");\r
                res.destroy(new Error("Upstream socket idle timeout"));\r
            }\r
        }\r
    });\r
\r
    const upstreamReq = https.request(options, (upstreamRes) => {\r
        firstByteReceived = true;\r
        upstreamTimeouts.markFirstByteReceived();\r
        activeUpstreamResponse = upstreamRes;\r
\r
        const statusCode = upstreamRes.statusCode;\r
        const rawContentType = upstreamRes.headers["content-type"];\r
        const contentTypeValue = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;\r
        const normalizedContentType = typeof contentTypeValue === "string"\r
            ? contentTypeValue.split(";", 1)[0].trim().toLowerCase()\r
            : undefined;\r
        const contentType = normalizedContentType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalizedContentType)\r
            ? normalizedContentType.slice(0, 128)\r
            : undefined;\r
        info("Upstream response started", {\r
            id: targetKey.id,\r
            upstreamStatus: statusCode,\r
            stream: isStream,\r
            contentType\r
        });\r
\r
        const retryAfter = parseRetryAfter(upstreamRes.headers["retry-after"]);\r
\r
        if (!isSuccessfulStatus(statusCode)) {\r
            const errorCollector = createBoundedBuffer(MAX_BUFFERED_RESPONSE_BYTES);\r
            let responseClosed = false;\r
            let settled = false;\r
            const settle = (result) => {\r
                if (settled) return false;\r
                settled = true;\r
                onResult?.(result);\r
                return true;\r
            };\r
            const closeInterruptedResponse = (streamError) => {\r
                if (responseClosed) return;\r
                responseClosed = true;\r
                error("Upstream non-2xx response stream error", { id: targetKey.id, statusCode });\r
                finishOutcome("upstream_stream_error");\r
                if (!res.headersSent) {\r
                    if (isAnthropic) {\r
                        res.writeHead(statusCode, { "Content-Type": "application/json" });\r
                        res.flushHeaders();\r
                    } else {\r
                        res.writeHead(statusCode, capResponseHeaders(upstreamRes.headers));\r
                        res.flushHeaders();\r
                    }\r
                }\r
                res.destroy(streamError);\r
            };\r
            upstreamRes.on("data", chunk => {\r
                if (!errorCollector.push(chunk)) {\r
                    intentionalUpstreamAbort = true;\r
                    responseClosed = true;\r
                    settle({ success: false, retryable: false, statusCode: 502, reason: "response_too_large" });\r
                    if (!res.headersSent) {\r
                        if (isAnthropic) {\r
                            res.writeHead(502, { "Content-Type": "application/json" });\r
                            res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream response too large" } }));\r
                        } else {\r
                            res.writeHead(502, { "Content-Type": "application/json" });\r
                            res.end(JSON.stringify({ error: "Upstream response too large" }));\r
                        }\r
                    }\r
                    upstreamRes.destroy();\r
                }\r
            });\r
            upstreamRes.on("error", closeInterruptedResponse);\r
            upstreamRes.on("aborted", () => closeInterruptedResponse(new Error("Upstream response aborted")));\r
            upstreamRes.on("end", () => {\r
                if (responseClosed) return;\r
                responseClosed = true;\r
                const errorBody = errorCollector.toBuffer().toString("utf8");\r
                let model;\r
                let upstreamCode;\r
                let upstreamType;\r
                let upstreamStatusCode;\r
\r
                try {\r
                    model = safeModelId(JSON.parse(bodyBuffer.toString("utf8")).model);\r
                } catch {\r
                }\r
\r
                try {\r
                    const parsedError = JSON.parse(errorBody).error;\r
                    upstreamCode = safeSseField(parsedError?.code);\r
                    upstreamType = safeSseField(parsedError?.type);\r
                    upstreamStatusCode = safeStatusCode(parsedError?.status_code ?? parsedError?.status);\r
                } catch {\r
                }\r
\r
                warn("Upstream non-2xx response", { statusCode, model, upstreamCode, upstreamType, upstreamStatusCode });\r
                handleKeyError(targetKey.id, statusCode, errorBody, retryAfter);\r
                keyOutcomeAccounted = true;\r
                finishOutcome("upstream_http_error");\r
\r
                if (onResult && classifyUpstreamResponse(statusCode, upstreamRes.headers).retryable && !res.headersSent) {\r
                    settle({ success: false, retryable: true, statusCode, reason: "http_" + statusCode });\r
                    return;\r
                }\r
\r
                if (isAnthropic && !res.headersSent) {\r
                    const anthropicError = buildAnthropicUpstreamError(statusCode, errorBody);\r
                    res.writeHead(statusCode, { "Content-Type": "application/json" });\r
                    res.end(JSON.stringify(anthropicError));\r
                    settle({ success: false, retryable: false, statusCode });\r
                    return;\r
                }\r
\r
                res.writeHead(statusCode, capResponseHeaders(upstreamRes.headers));\r
                res.end(errorBody);\r
                settle({ success: false, retryable: false, statusCode });\r
            });\r
            return;\r
        }\r
\r
        let completionTokens = 0;\r
\r
        if (isStream) {\r
            let streamClosed = false;\r
            let sseErrorObserved = false;\r
            let firstChunkHandled = false;\r
\r
            const sseObserver = createSseObserver((details) => {\r
                if (sseErrorObserved) return;\r
                sseErrorObserved = true;\r
                warn("Upstream SSE error event", {\r
                    id: targetKey.id,\r
                    upstreamStatus: statusCode,\r
                    ...details\r
                });\r
            });\r
            const maxStreamTimer = setTimeout(() => {\r
                if (!streamClosed) {\r
                    streamClosed = true;\r
                    intentionalUpstreamAbort = true;\r
                    upstreamReq.destroy(new Error("Max stream duration exceeded"));\r
                    activeUpstreamResponse?.destroy();\r
                    finishOutcome("max_stream_duration");\r
                    res.destroy(new Error("Max stream duration exceeded"));\r
                }\r
            }, maxStreamDurationMs);\r
\r
            if (isAnthropic) {\r
                // Anthropic streaming facade: translate the upstream OpenAI SSE\r
                // stream into Anthropic named events via the adapter generator.\r
                // The gateway speaks Anthropic SSE to the client; the upstream\r
                // stays OpenAI Chat Completions.\r
                const upstreamQueue = [];\r
                let resolveUpstream = null;\r
                let upstreamDone = false;\r
                let streamInitialized = false;\r
\r
                const upstreamIterable = {\r
                    async *[Symbol.asyncIterator]() {\r
                        while (true) {\r
                            if (upstreamQueue.length > 0) { yield upstreamQueue.shift(); continue; }\r
                            if (upstreamDone) return;\r
                            await new Promise((resolve) => { resolveUpstream = resolve; });\r
                            resolveUpstream = null;\r
                            if (upstreamQueue.length > 0) { yield upstreamQueue.shift(); continue; }\r
                            if (upstreamDone) return;\r
                        }\r
                    }\r
                };\r
\r
                let finalizeAnthropicStream = null;\r
                const startAnthropicStream = () => {\r
                    if (streamInitialized) return;\r
                    streamInitialized = true;\r
                    res.writeHead(200, {\r
                        "Content-Type": "text/event-stream",\r
                        "Cache-Control": "no-cache",\r
                        "Connection": "keep-alive"\r
                    });\r
                    // Failover MUST be released here (before any upstream byte is\r
                    // flushed) so a future retry cannot replay the request after\r
                    // the stream has started — security constraint §6e#1.\r
                    if (onResult) onResult({ success: true });\r
\r
                    finalizeAnthropicStream = (async () => {\r
                        try {\r
                            for await (const ev of translateAnthropicSseStream(upstreamIterable, requestId, requestedModel)) {\r
                                if (streamClosed || res.writableEnded) break;\r
                                res.write(ev);\r
                            }\r
                        } catch (e) {\r
                            error("Anthropic SSE translation error", { id: targetKey.id, error: e.message });\r
                        }\r
                    })();\r
                };\r
\r
                upstreamRes.on("data", (chunk) => {\r
                    if (streamClosed) return;\r
                    if (!firstChunkHandled) {\r
                        firstChunkHandled = true;\r
                        if (!res.headersSent && checkFirstChunkForSseError(chunk)) {\r
                            streamClosed = true;\r
                            clearTimeout(maxStreamTimer);\r
                            intentionalUpstreamAbort = true;\r
                            upstreamReq.destroy();\r
                            activeUpstreamResponse?.destroy();\r
                            handleKeyError(targetKey.id, 500, "Upstream SSE Error", null);\r
                            keyOutcomeAccounted = true;\r
                            finishOutcome("upstream_sse_error");\r
                            if (onResult) {\r
                                onResult({ success: false, retryable: true, statusCode: 500, reason: "upstream_sse_error" });\r
                            }\r
                            return;\r
                        }\r
                        startAnthropicStream();\r
                    }\r
\r
                    sseObserver.observe(chunk);\r
                    upstreamQueue.push(chunk.toString("utf8"));\r
                    if (resolveUpstream) { const r = resolveUpstream; resolveUpstream = null; r(); }\r
                });\r
\r
                upstreamRes.on("error", (err) => {\r
                    if (streamClosed) return;\r
                    streamClosed = true;\r
                    clearTimeout(maxStreamTimer);\r
                    intentionalUpstreamAbort = true;\r
                    error("Upstream response stream error", { id: targetKey.id, upstreamStatus: statusCode });\r
                    finishOutcome("upstream_stream_error");\r
                    if (!res.headersSent && !firstChunkHandled) {\r
                        handleKeyError(targetKey.id, 502, err.message, null);\r
                        keyOutcomeAccounted = true;\r
                        if (onResult) {\r
                            onResult({ success: false, retryable: true, statusCode: 502, reason: "upstream_stream_error" });\r
                            return;\r
                        }\r
                    }\r
                    res.destroy(err);\r
                });\r
                upstreamRes.on("aborted", () => {\r
                    if (streamClosed) return;\r
                    streamClosed = true;\r
                    clearTimeout(maxStreamTimer);\r
                    intentionalUpstreamAbort = true;\r
                    finishOutcome("upstream_stream_error");\r
                    if (!res.headersSent && !firstChunkHandled) {\r
                        handleKeyError(targetKey.id, 502, "Upstream response aborted", null);\r
                        keyOutcomeAccounted = true;\r
                        if (onResult) {\r
                            onResult({ success: false, retryable: true, statusCode: 502, reason: "upstream_stream_error" });\r
                            return;\r
                        }\r
                    }\r
                    res.destroy(new Error("Upstream response aborted"));\r
                });\r
                res.on("error", () => {\r
                    if (streamClosed) return;\r
                    streamClosed = true;\r
                    clearTimeout(maxStreamTimer);\r
                    intentionalUpstreamAbort = true;\r
                    finishOutcome("client_aborted");\r
                    upstreamRes.destroy();\r
                });\r
                res.on("close", () => {\r
                    if (streamClosed || res.writableEnded) return;\r
                    streamClosed = true;\r
                    clearTimeout(maxStreamTimer);\r
                    intentionalUpstreamAbort = true;\r
                    finishOutcome("client_aborted");\r
                    upstreamReq.destroy();\r
                    upstreamRes.destroy();\r
                });\r
                upstreamRes.on("end", async () => {\r
                    if (streamClosed) return;\r
                    if (!firstChunkHandled) {\r
                        firstChunkHandled = true;\r
                        streamClosed = true;\r
                        clearTimeout(maxStreamTimer);\r
                        finishOutcome("incomplete_stream");\r
                        if (!res.headersSent && onResult) {\r
                            onResult({ success: false, retryable: true, statusCode: 502, reason: "incomplete_stream" });\r
                            return;\r
                        }\r
                    }\r
                    upstreamDone = true;\r
                    if (resolveUpstream) { const r = resolveUpstream; resolveUpstream = null; r(); }\r
                    if (finalizeAnthropicStream) await finalizeAnthropicStream;\r
                    if (streamClosed) return;\r
                    streamClosed = true;\r
                    clearTimeout(maxStreamTimer);\r
                    sseObserver.end();\r
                    if (sseErrorObserved) {\r
                        finishOutcome("upstream_sse_error");\r
                    } else if (sseObserver.sawDone) {\r
                        finishOutcome("completed");\r
                    } else {\r
                        finishOutcome("incomplete_stream");\r
                    }\r
                    if (!res.writableEnded) res.end();\r
                });\r
                return;\r
            }\r
\r
            upstreamRes.on("data", (chunk) => {\r
                if (streamClosed) return;\r
                if (!firstChunkHandled) {\r
                    firstChunkHandled = true;\r
                    if (!res.headersSent && checkFirstChunkForSseError(chunk)) {\r
                        streamClosed = true;\r
                        clearTimeout(maxStreamTimer);\r
                        intentionalUpstreamAbort = true;\r
                        upstreamReq.destroy();\r
                        activeUpstreamResponse?.destroy();\r
                        handleKeyError(targetKey.id, 500, "Upstream SSE Error", null);\r
                        keyOutcomeAccounted = true;\r
                        finishOutcome("upstream_sse_error");\r
                        if (onResult) {\r
                            onResult({ success: false, retryable: true, statusCode: 500, reason: "upstream_sse_error" });\r
                        }\r
                        return;\r
                    }\r
                    res.writeHead(statusCode, capResponseHeaders(upstreamRes.headers));\r
                    if (onResult) onResult({ success: true });\r
                }\r
                sseObserver.observe(chunk);\r
                res.write(chunk);\r
            });\r
            upstreamRes.on("error", (err) => {\r
                if (streamClosed) return;\r
                streamClosed = true;\r
                clearTimeout(maxStreamTimer);\r
                error("Upstream response stream error", { id: targetKey.id, upstreamStatus: statusCode });\r
                finishOutcome("upstream_stream_error");\r
                if (!res.headersSent && !firstChunkHandled) {\r
                    handleKeyError(targetKey.id, 502, err.message, null);\r
                    keyOutcomeAccounted = true;\r
                    if (onResult) {\r
                        onResult({ success: false, retryable: true, statusCode: 502, reason: "upstream_stream_error" });\r
                        return;\r
                    }\r
                }\r
                res.destroy(err);\r
            });\r
            upstreamRes.on("aborted", () => {\r
                if (streamClosed) return;\r
                streamClosed = true;\r
                clearTimeout(maxStreamTimer);\r
                finishOutcome("upstream_stream_error");\r
                if (!res.headersSent && !firstChunkHandled) {\r
                    handleKeyError(targetKey.id, 502, "Upstream response aborted", null);\r
                    keyOutcomeAccounted = true;\r
                    if (onResult) {\r
                        onResult({ success: false, retryable: true, statusCode: 502, reason: "upstream_stream_error" });\r
                        return;\r
                    }\r
                }\r
                res.destroy(new Error("Upstream response aborted"));\r
            });\r
            res.on("error", () => {\r
                if (streamClosed) return;\r
                streamClosed = true;\r
                clearTimeout(maxStreamTimer);\r
                intentionalUpstreamAbort = true;\r
                finishOutcome("client_aborted");\r
                upstreamRes.destroy();\r
            });\r
            res.on("close", () => {\r
                if (streamClosed || res.writableEnded) return;\r
                streamClosed = true;\r
                clearTimeout(maxStreamTimer);\r
                intentionalUpstreamAbort = true;\r
                finishOutcome("client_aborted");\r
                upstreamReq.destroy();\r
                upstreamRes.destroy();\r
            });\r
            upstreamRes.on("end", () => {\r
                if (streamClosed) return;\r
                if (!firstChunkHandled) {\r
                    firstChunkHandled = true;\r
                    streamClosed = true;\r
                    clearTimeout(maxStreamTimer);\r
                    finishOutcome("incomplete_stream");\r
                    if (!res.headersSent && onResult) {\r
                        onResult({ success: false, retryable: true, statusCode: 502, reason: "incomplete_stream" });\r
                        return;\r
                    }\r
                }\r
                streamClosed = true;\r
                clearTimeout(maxStreamTimer);\r
                sseObserver.end();\r
                if (sseErrorObserved) {\r
                    finishOutcome("upstream_sse_error");\r
                } else if (sseObserver.sawDone) {\r
                    finishOutcome("completed");\r
                } else {\r
                    finishOutcome("incomplete_stream");\r
                }\r
                if (!res.writableEnded) res.end();\r
            });\r
        } else {\r
            if (isAnthropic) {\r
                // Anthropic non-streaming facade: buffer the upstream OpenAI\r
                // JSON response fully, translate it to the Anthropic Messages\r
                // shape, and send the single Anthropic JSON body to the client.\r
                if (statusCode === 204) {\r
                    upstreamRes.resume();\r
                    res.writeHead(500, { "Content-Type": "application/json" });\r
                    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream returned no content" } }));\r
                    finishOutcome("upstream_stream_error");\r
                    if (onResult) onResult({ success: false, retryable: false, statusCode: 500 });\r
                    return;\r
                }\r
                // Release the failover key BEFORE any byte is flushed to the\r
                // client so a future retry can never replay the request after\r
                // the stream starts — security constraint §6e#1.\r
                if (onResult) onResult({ success: true });\r
                const responseCollector = createBoundedBuffer(MAX_BUFFERED_RESPONSE_BYTES);\r
                let buffered = true;\r
                upstreamRes.on("error", (err) => {\r
                    if (!res.headersSent) {\r
                        res.writeHead(502, { "Content-Type": "application/json" });\r
                        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Bad Gateway" } }));\r
                    } else {\r
                        res.destroy(err);\r
                    }\r
                    finishOutcome("upstream_stream_error");\r
                });\r
                upstreamRes.on("data", (chunk) => {\r
                    if (buffered && !responseCollector.push(chunk)) buffered = false;\r
                });\r
                upstreamRes.on("end", () => {\r
                    if (!buffered) {\r
                        if (!res.headersSent) {\r
                            res.writeHead(502, { "Content-Type": "application/json" });\r
                            res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream response too large" } }));\r
                        }\r
                        finishOutcome("upstream_stream_error");\r
                        return;\r
                    }\r
                    const rawOpenaiResponse = responseCollector.toBuffer().toString("utf8");\r
                    let anthropicResponse;\r
                    let completionTokens = 0;\r
                    try {\r
                        const openaiParsed = JSON.parse(rawOpenaiResponse);\r
                        anthropicResponse = translateAnthropicResponse(openaiParsed);\r
                        if (anthropicResponse.usage && typeof anthropicResponse.usage.output_tokens === "number") {\r
                            completionTokens = anthropicResponse.usage.output_tokens;\r
                        }\r
                    } catch (e) {\r
                        error("Anthropic translation error", { id: targetKey.id, error: e.message, stack: e.stack });\r
                        if (!res.headersSent) {\r
                            res.writeHead(502, { "Content-Type": "application/json" });\r
                            res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Failed to translate upstream response" } }));\r
                        }\r
                        finishOutcome("upstream_stream_error");\r
                        return;\r
                    }\r
                    const body = JSON.stringify(anthropicResponse);\r
                    if (!res.headersSent) {\r
                        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });\r
                    }\r
                    res.end(body);\r
                    finishOutcome("completed", completionTokens);\r
                });\r
                return;\r
            }\r
            if (statusCode === 204) {\r
                upstreamRes.resume();\r
                res.writeHead(204, capResponseHeaders(upstreamRes.headers));\r
                res.end();\r
                finishOutcome("completed", 0);\r
                if (onResult) onResult({ success: true });\r
                return;\r
            }\r
            res.writeHead(statusCode, capResponseHeaders(upstreamRes.headers));\r
            if (onResult) onResult({ success: true });\r
            const responseCollector = createBoundedBuffer(MAX_BUFFERED_RESPONSE_BYTES);\r
            let collectingUsage = true;\r
            res.on("error", () => {});\r
            upstreamRes.on("error", (err) => {\r
                if (!res.headersSent) res.writeHead(502);\r
                if (!res.writableEnded) res.end();\r
                finishOutcome("upstream_stream_error");\r
            });\r
            upstreamRes.on("data", chunk => {\r
                if (collectingUsage && !responseCollector.push(chunk)) collectingUsage = false;\r
                res.write(chunk);\r
            });\r
            upstreamRes.on("end", () => {\r
                res.end();\r
                try {\r
                    if (!collectingUsage) throw new Error("usage collection overflow");\r
                    const parsed = JSON.parse(responseCollector.toBuffer().toString("utf8"));\r
                    if (parsed.usage && parsed.usage.total_tokens) {\r
                        completionTokens = parsed.usage.total_tokens;\r
                    }\r
                } catch (e) {\r
                }\r
                finishOutcome("completed", completionTokens);\r
            });\r
        }\r
    });\r
\r
    upstreamReq.on("socket", (socket) => {\r
        upstreamTimeouts.attach(socket);\r
    });\r
\r
    upstreamReq.on("error", (err) => {\r
        if (intentionalUpstreamAbort) return;\r
        error("Upstream request error", { id: targetKey.id, error: err.message, stack: err.stack });\r
        if (!firstByteReceived) {\r
            handleKeyError(targetKey.id, 502, err.message, null);\r
            keyOutcomeAccounted = true;\r
        }\r
        finishOutcome("upstream_stream_error");\r
        if (onResult && !firstByteReceived) {\r
            onResult({ success: false, retryable: true, statusCode: 502, reason: "socket_hang_up" });\r
        } else if (!res.headersSent) {\r
            if (isAnthropic) {\r
                res.writeHead(502, { "Content-Type": "application/json" });\r
                res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Bad Gateway" } }));\r
            } else {\r
                res.writeHead(502);\r
                res.end(JSON.stringify({ error: "Bad Gateway" }));\r
            }\r
        } else {\r
            res.destroy(err);\r
        }\r
        if (onResult && firstByteReceived) onResult({ success: false, retryable: false });\r
    });\r
\r
    if (bodyBuffer) {\r
        upstreamReq.write(bodyBuffer);\r
    }\r
    upstreamReq.end();\r
\r
    req.on("close", () => {\r
        // Only abort upstream if we've already started receiving the response.\r
        // Destroying upstreamReq during TLS handshake causes socket hang up\r
        // on the upstream side instead of letting it complete naturally.\r
        if (!res.writableEnded && firstByteReceived) {\r
            warn("Client disconnected during upstream transfer", { id: targetKey.id });\r
            intentionalUpstreamAbort = true;\r
            if (!terminalOutcome) finishOutcome("client_aborted");\r
            activeUpstreamResponse?.destroy();\r
            upstreamReq.destroy();\r
        }\r
    });\r
\r
    req.on("aborted", () => {\r
        if (!res.writableEnded) {\r
            intentionalUpstreamAbort = true;\r
            finishOutcome("client_aborted");\r
            upstreamReq.destroy();\r
        }\r
    });\r
}\r
\r
function handleModelsWithFailover(req, res, onKeyIdChange) {\r
    return new Promise((resolve) => {\r
        let attempt = 0;\r
        const activeCount = getKeys().filter((k) => k.status === "active").length;\r
        const maxAttempts = resolveMaxFailoverAttempts(process.env, activeCount);\r
\r
        const tryNext = () => {\r
            if (attempt >= maxAttempts) {\r
                error("All models failover attempts exhausted", { attempts: attempt });\r
                if (!res.headersSent) {\r
                    const retryAfter = String(getSoonestActiveCooldownRemainingSeconds());\r
                    res.writeHead(502, capResponseHeaders({ "Content-Type": "application/json", "Retry-After": retryAfter }));\r
                    res.end(JSON.stringify({ error: "All failover attempts exhausted" }));\r
                }\r
                resolve({ success: false });\r
                return;\r
            }\r
\r
            const key = getNextKey();\r
            if (!key) {\r
                warn("No available keys for models request");\r
                if (!res.headersSent) {\r
                    const retryAfter = String(getSoonestActiveCooldownRemainingSeconds());\r
                    res.writeHead(503, capResponseHeaders({ "Content-Type": "application/json", "Retry-After": retryAfter }));\r
                    res.end(JSON.stringify({ error: "All API keys exhausted" }));\r
                }\r
                resolve({ success: false });\r
                return;\r
            }\r
\r
            attempt++;\r
            if (onKeyIdChange) onKeyIdChange(key.id);\r
\r
            handleModelsRequest(req, res, key, (result) => {\r
                if (result.success || !result.retryable) {\r
                    resolve(result);\r
                } else {\r
                    warn("Retrying models with different key", {\r
                        attempt,\r
                        maxAttempts,\r
                        reason: result.reason\r
                    });\r
                    tryNext();\r
                }\r
            });\r
        };\r
\r
        tryNext();\r
    });\r
}\r
\r
function handleModelsRequest(req, res, targetKey, onResult) {\r
    const options = {\r
        hostname: NVIDIA_API,\r
        port: 443,\r
        path: "/v1/models",\r
        method: "GET",\r
        agent: false,  // disable connection pooling\r
        headers: {\r
            ...req.headers,\r
            "host": NVIDIA_API,\r
            "authorization": "Bearer " + targetKey.key,\r
            "HTTP-Referer": "https://opencode.ai/",\r
            "X-Title": "opencode",\r
            "X-BILLING-INVOKE-ORIGIN": "OpenCode"\r
        }\r
    };\r
\r
    sanitizeProxyHeaders(options.headers);\r
\r
    const upstreamReq = https.request(options, (upstreamRes) => {\r
        const responseCollector = createBoundedBuffer(MAX_BUFFERED_RESPONSE_BYTES);\r
        let settled = false;\r
        let overflowed = false;\r
        const settle = (result) => { if (!settled) { settled = true; onResult?.(result); } };\r
        upstreamRes.on("data", chunk => {\r
            if (settled) return;\r
            if (!responseCollector.push(chunk)) {\r
                overflowed = true;\r
                settle({ success: false, retryable: false, statusCode: 502, reason: "response_too_large" });\r
                if (!res.headersSent) { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Upstream response too large" })); }\r
                upstreamRes.destroy();\r
            }\r
        });\r
        upstreamRes.on("end", () => {\r
            if (settled || overflowed) return;\r
            const responseBody = responseCollector.toBuffer().toString("utf8");\r
            if (isSuccessfulStatus(upstreamRes.statusCode)) {\r
                if (upstreamRes.statusCode === 204) {\r
                    res.writeHead(204, capResponseHeaders(upstreamRes.headers));\r
                    res.end();\r
                    settle({ success: true });\r
                    return;\r
                }\r
                try {\r
                    const parsed = JSON.parse(responseBody);\r
                    if (parsed && Array.isArray(parsed.data)) {\r
                        const enrichedModelIds = [];\r
                        parsed.data.forEach(model => {\r
                            // Skip a malformed entry gracefully so a single bad\r
                            // upstream object never crashes the whole /v1/models\r
                            // response (robust enrichment). getCapabilityMetadata\r
                            // is itself null/undefined-safe, but model.id access\r
                            // and the property assignment below require an object.\r
                            if (!model || typeof model !== \"object\" || Array.isArray(model)) return;\r
                            const limits = getModelLimits(model.id);\r
                            model.context_length = limits.context;\r
                            model.max_completion_tokens = limits.output;\r
                            model.max_tokens = limits.context;\r
                            // Static family capabilities first, then override the\r
                            // reasoning block with a LIVE-probed result when one is\r
                            // cached (probed truth beats a static family guess; a\r
                            // missing/stale probe leaves the static value intact).\r
                            model.capabilities = getCapabilityMetadata(model.id);\r
                            mergeProbedReasoning(model.capabilities, model.id);\r
                            if (typeof model.id === \"string\") enrichedModelIds.push(model.id);\r
                        });\r
                        // SUB-TASK A#2: drop disabled model ids from the client-facing catalog\r
                        // (the OpenAI-compatible list clients pick from). Non-object / non-string-id\r
                        // entries pass through untouched (matches the malformed-entry contract in\r
                        // tests/model-enrichment.test.mjs). Only objects whose string id is in the\r
                        // operator-curated disabledModels are removed. F1: comparison is\r
                        // case-insensitive — getDisabledModels() returns lowercased ids, and the\r
                        // model id is lowercased before the Set lookup.\r
                        const disabledIds = getDisabledModels();\r
                        if (disabledIds.length > 0) {\r
                            const disabled = new Set(disabledIds);\r
                            parsed.data = parsed.data.filter(\r
                                (m) => !(m && typeof m === \"object\" && !Array.isArray(m) && typeof m.id === \"string\" && disabled.has(m.id.toLowerCase()))\r
                            );\r
                        }\r
                        // REAL reasoning-capability discovery: lazily refresh stale\r
                        // probed capability entries for the models just served.\r
                        // Fire-and-forget and non-blocking — this response was\r
                        // already built from cache/static; outcomes are logged to\r
                        // gateway.jsonl as capability_probe events. The scheduler is\r
                        // a no-op under the test upstream sentinel unless force-\r
                        // enabled, so hermetic harness tests never see probe traffic.\r
                        if (enrichedModelIds.length > 0) {\r
                            scheduleCapabilityRefresh(enrichedModelIds, {\r
                                logger: (outcome) => info(\"capability_probe\", outcome),\r
                                keyProvider: () => getNextKey()?.key ?? null\r
                            });\r
                        }\r
                    }\r
                    const modifiedBody = JSON.stringify(parsed);\r
                    const responseHeaders = { ...upstreamRes.headers };\r
                    delete responseHeaders[\"transfer-encoding\"];\r
                    res.writeHead(upstreamRes.statusCode, capResponseHeaders({\r
                        ...responseHeaders,\r
                        \"content-length\": Buffer.byteLength(modifiedBody)\r
                    }));\r
                    res.end(modifiedBody);\r
                    settle({ success: true });\r
                } catch (e) {\r
                    res.writeHead(upstreamRes.statusCode, capResponseHeaders(upstreamRes.headers));\r
                    res.end(responseBody);\r
                    settle({ success: true });\r
                }\r
            } else {\r
                const retryAfter = parseRetryAfter(upstreamRes.headers[\"retry-after\"]);\r
                handleKeyError(targetKey.id, upstreamRes.statusCode, responseBody, retryAfter);\r
                if (onResult && classifyUpstreamResponse(upstreamRes.statusCode, upstreamRes.headers).retryable && !res.headersSent) {\r
                    settle({ success: false, retryable: true, statusCode: upstreamRes.statusCode, reason: \"http_\" + upstreamRes.statusCode });\r
                    return;\r
                }\r
                res.writeHead(upstreamRes.statusCode, capResponseHeaders(upstreamRes.headers));\r
                res.end(responseBody);\r
                settle({ success: false, retryable: false, statusCode: upstreamRes.statusCode });\r
            }\r
        });\r
        upstreamRes.on(\"error\", (err) => {\r
            if (settled) return;\r
            settle({ success: false, retryable: false, statusCode: 502, reason: \"response_error\" });\r
            if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: \"Bad Gateway\" })); }\r
            else res.destroy(err);\r
        });\r
        upstreamRes.on(\"aborted\", () => {\r
            if (settled) return;\r
            settle({ success: false, retryable: false, statusCode: 502, reason: \"response_aborted\" });\r
            if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: \"Bad Gateway\" })); }\r
        });\r
    });\r
\r
    upstreamReq.on(\"error\", (err) => {\r
        error(\"Upstream models request error\", { error: err.message, stack: err.stack });\r
        if (onResult) {\r
            onResult({ success: false, retryable: true, statusCode: 502, reason: \"socket_hang_up\" });\r
        } else if (!res.headersSent) {\r
            res.writeHead(502);\r
            res.end(JSON.stringify({ error: \"Bad Gateway\" }));\r
        }\r
    });\r
\r
    upstreamReq.end();\r
}\r
\r
const server = http.createServer(async (req, res) => {\r
    const startTime = process.hrtime.bigint();\r
    let loggedKeyId = null;\r
\r
    // Install request-logging hook before any response work\r
    const logRequest = () => {\r
        const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6; // ms\r
        info(\"request\", {\r
            method: req.method,\r
            path: pathnameOnly(req.url),\r
            status: res.statusCode,\r
            duration_ms: Math.round(elapsed),\r
            keyIndex: loggedKeyId\r
        });\r
    };\r
    let logged = false;\r
    res.once(\"finish\", () => { logRequest(); logged = true; });\r
    res.once(\"close\", () => {\r
        if (logged) return;\r
        const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6;\r
        info(\"request\", {\r
            method: req.method,\r
            path: pathnameOnly(req.url),\r
            status: res.statusCode || 0,\r
            duration_ms: Math.round(elapsed),\r
            keyIndex: loggedKeyId,\r
            aborted: true\r
        });\r
    });\r
\r
    const requestUrl = new URL(req.url, \"http://127.0.0.1\");\r
    const origin = req.headers.origin;\r
    const allowedOrigin = origin && isAllowedOrigin(origin, CORS_ALLOWLIST);\r
    if (origin && !allowedOrigin) { res.writeHead(403); res.end(); return; }\r
    if (allowedOrigin) { res.setHeader(\"Access-Control-Allow-Origin\", CORS_ALLOWLIST.find((candidate) => candidate === origin)); res.setHeader(\"Vary\", \"Origin\"); }\r
    if (req.method === \"OPTIONS\") {\r
        const requestedMethod = req.headers[\"access-control-request-method\"];\r
        if (!allowedOrigin || !classifyGatewayRoute(requestedMethod, requestUrl.pathname)) { res.writeHead(403); res.end(); return; }\r
        res.writeHead(204, { \"Access-Control-Allow-Methods\": requestedMethod, \"Access-Control-Allow-Headers\": \"Authorization, Content-Type\" }); res.end(); return;\r
    }\r
\r
    if (req.method === \"GET\" && req.url === \"/health\") {\r
        res.writeHead(isReady ? 200 : 503, { \"Content-Type\": \"application/json\" });\r
        res.end(JSON.stringify({ status: isReady ? \"ok\" : \"starting\" }));\r
        return;\r
    }\r
\r
    // Cached models endpoint (no upstream call)\r
    if (req.method === \"GET\" && requestUrl.pathname === \"/v1/models/cached\") {\r
        try {\r
            const models = await getCachedModels();\r
            res.writeHead(200, { \"Content-Type\": \"application/json\" });\r
            res.end(JSON.stringify({ data: models, cached: true }));\r
        } catch (err) {\r
            error(\"Failed to get cached models\", { error: err.message });\r
            res.writeHead(500, { \"Content-Type\": \"application/json\" });\r
            res.end(JSON.stringify({ error: \"Failed to retrieve cached models\" }));\r
        }\r
        return;\r
    }\r
\r
    // Manual refresh endpoint (admin only)\r
    if (req.method === \"POST\" && requestUrl.pathname === \"/v1/models/refresh\") {\r
        if (!ADMIN_TOKEN || !isBearerAuthorized(req.headers.authorization, ADMIN_TOKEN)) {\r
            res.writeHead(401, { \"WWW-Authenticate\": \"Bearer\" });\r
            res.end();\r
            return;\r
        }\r
        try {\r
            const all = await refreshModels();\r
            // SUB-TASK A#2: keep /v1/models/refresh consistent with /v1/models —\r
            // exclude operator-disabled models from the returned set. (The model-discovery\r
            // cache already filters the separate GATEWAY_DISABLED_MODELS env var; this is\r
            // the additional config.json disabledModels filter.) F1: case-insensitive —\r
            // getDisabledModels() returns lowercased ids; model id lowercased before lookup.\r
            const disabledIds = getDisabledModels();\r
            const data = disabledIds.length === 0\r
                ? all\r
                : all.filter((m) => !(m && typeof m === \"object\" && !Array.isArray(m) && typeof m.id === \"string\" && new Set(disabledIds).has(m.id.toLowerCase())));\r
            res.writeHead(200, { \"Content-Type\": \"application/json\" });\r
            res.end(JSON.stringify({ data, cached: false }));\r
        } catch (err) {\r
            error(\"Failed to refresh models\", { error: err.message });\r
            res.writeHead(500, { \"Content-Type\": \"application/json\" });\r
            res.end(JSON.stringify({ error: \"Failed to refresh models\" }));\r
        }\r
        return;\r
    }\r
\r
    if (requestUrl.pathname.startsWith(\"/v1/\")) {\r
        const route = classifyGatewayRoute(req.method, requestUrl.pathname);\r
        if (!route || requestUrl.search) { res.writeHead(404); res.end(); return; }\r
        if (!LOCAL_TOKEN || !isBearerAuthorized(req.headers.authorization, LOCAL_TOKEN)) { res.writeHead(401, { \"WWW-Authenticate\": \"Bearer\" }); res.end(); return; }\r
    }\r
    if (req.method === \"GET\" && requestUrl.pathname === \"/v1/models\") {\r
        return handleModelsWithFailover(req, res, (newKeyId) => {\r
            loggedKeyId = newKeyId;\r
        });\r
    }\r
\r
    if (req.method === \"POST\" && requestUrl.pathname === \"/v1/chat/completions\") {\r
        let bodyChunks = [];\r
        let bodyLength = 0;\r
        const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5MB\r
\r
        req.on(\"data\", chunk => {\r
            bodyLength += chunk.length;\r
            if (bodyLength > MAX_PAYLOAD_SIZE) {\r
                if (!res.headersSent) {\r
                    res.writeHead(413, { \"Content-Type\": \"application/json\" });\r
                    res.end(JSON.stringify({ error: \"Payload Too Large\" }));\r
                }\r
                req.destroy();\r
                return;\r
            }\r
            bodyChunks.push(chunk);\r
        });\r
        req.on(\"end\", () => {\r
            if (bodyLength > MAX_PAYLOAD_SIZE) return;\r
            let bodyBuffer = Buffer.concat(bodyChunks);\r
            let isStream = false;\r
            let requestedModelId = undefined;\r
\r
            if (req.headers[\"content-type\"]?.includes(\"application/json\") && bodyBuffer.length > 0) {\r
                try {\r
                    const parsed = JSON.parse(bodyBuffer.toString(\"utf8\"));\r
                    if (parsed.stream === true) {\r
                        isStream = true;\r
                    }\r
                    // Capture requested model id for disabled-model check below.\r
                    if (typeof parsed?.model === \"string\") requestedModelId = parsed.model;\r
                } catch (e) {\r
                }\r
            }\r
\r
            // SUB-TASK A#3: fail fast — block a request for a disabled model BEFORE any key\r
            // rotation / upstream call (matches OpenAI unknown-model semantics). The check is at\r
            // request START; an already-streaming response is never unwound (documented edge).\r
            // F1: case-insensitive — getDisabledModels() returns lowercased ids.\r
            if (requestedModelId && getDisabledModels().includes(requestedModelId.toLowerCase())) {\r
                res.writeHead(404, { \"Content-Type\": \"application/json\" });\r
                res.end(JSON.stringify({ error: { message: \"model not found: \" + requestedModelId, type: \"invalid_request_error\", code: \"model_not_found\" } }));\r
                return;\r
            }\r
\r
            proxyRequestWithFailover(req, res, bodyBuffer, isStream, (newKeyId) => {\r
                loggedKeyId = newKeyId;\r
            });\r
        });\r
\r
        req.on(\"error\", (err) => {\r
            error(\"Client request error\", { error: err.message, stack: err.stack });\r
            if (!res.headersSent) {\r
                res.writeHead(400);\r
                res.on(\"error\", () => {}); res.end();\r
            }\r
        });\r
        return;\r
    }\r
\r
    // ── Anthropic Messages API facade ──────────────────────────────────────\r
    // POST /v1/messages  →  translate to OpenAI Chat Completions, forward to\r
    // NVIDIA upstream via the shared failover spine, translate the OpenAI\r
    // response (JSON or SSE) back to Anthropic shape. All errors are returned\r
    // in Anthropic's error envelope. Auth uses the same LOCAL_TOKEN Bearer\r
    // gate as the OpenAI chat path (see classifyGatewayRoute: 'messages').\r
    if (req.method === \"POST\" && requestUrl.pathname === \"/v1/messages\") {\r
        let bodyChunks = [];\r
        let bodyLength = 0;\r
        const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5MB — same as chat\r
\r
        const sendAnthropicError = (httpStatus, errorType, message) => {\r
            if (res.headersSent) return;\r
            res.writeHead(httpStatus, { \"Content-Type\": \"application/json\" });\r
            res.end(JSON.stringify({ type: \"error\", error: { type: errorType, message } }));\r
        };\r
\r
        req.on(\"data\", chunk => {\r
            bodyLength += chunk.length;\r
            if (bodyLength > MAX_PAYLOAD_SIZE) {\r
                if (!res.headersSent) {\r
                    res.writeHead(413, { \"Content-Type\": \"application/json\" });\r
                    res.end(JSON.stringify({ type: \"error\", error: { type: \"invalid_request_error\", message: \"Payload Too Large\" } }));\r
                }\r
                req.destroy();\r
                return;\r
            }\r
            bodyChunks.push(chunk);\r
        });\r
        req.on(\"end\", () => {\r
            if (bodyLength > MAX_PAYLOAD_SIZE) return;\r
            const bodyBuffer = Buffer.concat(bodyChunks);\r
\r
            let anthropicBody;\r
            try {\r
                anthropicBody = JSON.parse(bodyBuffer.toString(\"utf8\"));\r
            } catch (e) {\r
                sendAnthropicError(400, \"invalid_request_error\", \"Invalid JSON body\");\r
                return;\r
            }\r
\r
            const { openaiBody, warnings, errors } = translateAnthropicRequest(anthropicBody);\r
            if (warnings.length > 0) {\r
                info(\"Anthropic facade translation warnings\", { warnings });\r
            }\r
            if (errors.length > 0 || !openaiBody) {\r
                sendAnthropicError(400, \"invalid_request_error\", errors.join(\"; \") || \"Invalid Anthropic request\");\r
                return;\r
            }\r
\r
            // SUB-TASK A#3: fail fast — block a request for a disabled model BEFORE\r
            // translation/proxy. Anthropic clients pass the model id through unchanged\r
            // (anthropic-adapter.mjs: openaiBody.model = body.model), so the raw\r
            // requested id is the one forwarded upstream and the one the disabled list keys on.\r
            // F1: case-insensitive — getDisabledModels() returns lowercased ids.\r
            const requestedModelId = typeof anthropicBody.model === \"string\"\r
                ? anthropicBody.model\r
                : (typeof openaiBody.model === \"string\" ? openaiBody.model : \"\");\r
            if (requestedModelId && getDisabledModels().includes(requestedModelId.toLowerCase())) {\r
                sendAnthropicError(404, \"not_found_error\", \"model: \" + requestedModelId + \" not found\");\r
                return;\r
            }\r
\r
            const isStream = openaiBody.stream === true;\r
            // Re-serialize the translated OpenAI body so the upstream gets a\r
            // clean Chat Completions payload. Content-Length is derived from\r
            // this translated buffer, not the client's oversized Anthropic one.\r
            let translatedBuffer;\r
            try {\r
                translatedBuffer = Buffer.from(JSON.stringify(openaiBody), \"utf8\");\r
            } catch (e) {\r
                error(\"Anthropic facade serialization error\", { error: e.message });\r
                sendAnthropicError(500, \"api_error\", \"Failed to serialize translated request\");\r
                return;\r
            }\r
\r
            const requestId = \"msg_\" + crypto.randomUUID();\r
            const requestedModel = typeof anthropicBody.model === \"string\" ? anthropicBody.model : (openaiBody.model || \"\");\r
            const opts = { responseMode: \"anthropic\", requestId, model: requestedModel };\r
            // Replace req.url so any upstream-derived logs reference the\r
            // Chat Completions target rather than /v1/messages.\r
            req.url = \"/v1/chat/completions\";\r
\r
            proxyRequestWithFailover(req, res, translatedBuffer, isStream, (newKeyId) => {\r
                loggedKeyId = newKeyId;\r
            }, opts);\r
        });\r
\r
        req.on(\"error\", (err) => {\r
            error(\"Client request error\", { error: err.message, stack: err.stack });\r
            if (!res.headersSent) {\r
                sendAnthropicError(400, \"invalid_request_error\", \"Client request error\");\r
            }\r
        });\r
        return;\r
    }\r
\r
    res.writeHead(404);\r
    res.on(\"error\", () => {}); res.end();\r
});\r
\r
const PORT = Number.parseInt(process.env.PORT || \"12004\", 10);\r
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65534) {\r
    throw new Error(\"PORT must be an integer between 1 and 65534.\");\r
}\r
\r
const ADMIN_PORT = parseInt(PORT, 10) + 1;\r
const adminServer = http.createServer((req, res) => {\r
    if (req.url.startsWith(\"/admin/\")) {\r
        // Parity with every other branch: swallow a late-write error on res so it\r
        // can never crash the process on future Node versions (defensive only).\r
        res.on(\"error\", () => {});\r
        return handleAdminRequest(req, res, { adminToken: ADMIN_TOKEN });\r
    }\r
    res.writeHead(404);\r
    res.on(\"error\", () => {}); res.end();\r
});\r
\r
function failStartup(serverName, err) {\r
    error(serverName + \" failed to start\", { port: serverName === \"Gateway\" ? PORT : ADMIN_PORT, error: err.message, stack: err.stack });\r
    console.error(\"[Gateway:E_STARTUP] Startup failed\");\r
    if (server.listening) server.close();\r
    if (adminServer.listening) adminServer.close();\r
    process.exitCode = 1;\r
    setTimeout(() => process.exit(1), 3000);\r
}\r
\r
server.on(\"error\", (err) => failStartup(\"Gateway\", err));\r
adminServer.on(\"error\", (err) => failStartup(\"Admin\", err));\r
\r
server.listen(PORT, \"127.0.0.1\", () => {\r
    info(\"Gateway started\", { port: PORT });\r
    console.log(\"GATEWAY_LISTENING\");\r
    adminServer.listen(ADMIN_PORT, \"127.0.0.1\", () => {\r
        isReady = Boolean(LOCAL_TOKEN && ADMIN_TOKEN);\r
        info(\"Admin API started\", { port: ADMIN_PORT });\r
        console.log(\"ADMIN_LISTENING\");\r
        if (typeof process.send === \"function\") {\r
            process.send({ type: \"ports:bound\", challenge: ipcChallenge, gatewayPort: PORT, adminPort: ADMIN_PORT });\r
        }\r
        // F3: best-effort background cache warm so the first /admin/models (and\r
        // /v1/models/cached) call does not pay the up-to-30s upstream fetch\r
        // latency, which exceeds the admin-client's 5s socket timeout. Delayed +\r
        // unref'd: the 2s delay ensures the warm never fires during the ~2s\r
        // lifecycle of test children (which would otherwise shift a queued\r
        // response off queue-based fake upstreams). In production the 2s delay is\r
        // negligible and fire-and-forget — a fetch failure is swallowed and\r
        // getCachedModels() retries lazily on the next request.\r
        const cacheWarmTimer = setTimeout(() => {\r
            refreshModels().catch(() => { /* cache warm is best-effort */ });\r
        }, 2000);\r
        cacheWarmTimer.unref();\r
    });\r
});\r
\r
process.on(\"message\", (message) => {\r
    if (message?.type === \"state:init\") isReady = Boolean(LOCAL_TOKEN && ADMIN_TOKEN && server.listening && adminServer.listening);\r
});\r
\r
function shutdown() {\r
    info(\"Gateway shutting down\", { graceful: true });\r
    // Flush remaining log buffer before exit\r
    flushState();\r
    flushLogs();\r
    server.close();\r
    adminServer.close();\r
}\r
\r
process.once(\"SIGTERM\", shutdown);\r
process.once(\"SIGINT\", shutdown);
