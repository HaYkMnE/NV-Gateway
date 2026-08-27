// TEMPORARY direct-limit diagnostic: disabled by default; remove after GLM calibration completes.
const ORIGIN = "https://integrate.api.nvidia.com/v1";
const HOST = "integrate.api.nvidia.com";
const MODEL = "z-ai/glm-5.2";
const MODELS_PATH = "/v1/models";
const CHAT_PATH = "/v1/chat/completions";
const MODELS_ENDPOINT = "/models";
const CHAT_ENDPOINT = "/chat/completions";
const LONG_PROMPT_REPETITIONS = 230000;
export const DIRECT_GLM_PROBE_TIMEOUT_MS = 300000;
const MAX_TIMEOUT_MS = DIRECT_GLM_PROBE_TIMEOUT_MS;
export const DIRECT_GLM_PROBE_MAX_SUCCESS_BYTES = 512 * 1024;
const DEFAULT_MAX_SUCCESS_BYTES = DIRECT_GLM_PROBE_MAX_SUCCESS_BYTES;
const DEFAULT_CLEANUP_TIMEOUT_MS = 1000;

export function normalizeMaxSuccessBytes(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= DIRECT_GLM_PROBE_MAX_SUCCESS_BYTES
        ? value
        : DEFAULT_MAX_SUCCESS_BYTES;
}

function normalizeCleanupTimeout(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= DIRECT_GLM_PROBE_TIMEOUT_MS
        ? value
        : DEFAULT_CLEANUP_TIMEOUT_MS;
}

export function isDirectGlmProbeEnabled(value) {
    return value === "1";
}

export function shouldScheduleDirectGlmProbe({ message, expectedChallenge, envValue } = {}) {
    if (!message || message.type !== "state:init" || message.challenge !== expectedChallenge) return false;
    if (!isDirectGlmProbeEnabled(envValue)) return false;
    const credentials = message.state?.credentials;
    return typeof credentials?.gatewayToken === "string" && credentials.gatewayToken.length > 0
        && typeof credentials?.adminToken === "string" && credentials.adminToken.length > 0;
}

export function snapshotKeyRecords(records) {
    if (!Array.isArray(records)) return Object.freeze([]);
    return Object.freeze(records.map((record) => Object.freeze({
        key: typeof record?.key === "string" ? record.key : "",
        status: typeof record?.status === "string" ? record.status : "",
        backoffUntil: Number.isSafeInteger(record?.backoffUntil) ? record.backoffUntil : 0,
        usage: Object.freeze({
            success: Number.isSafeInteger(record?.usage?.success) ? record.usage.success : 0,
            fail: Number.isSafeInteger(record?.usage?.fail) ? record.usage.fail : 0,
            tokens: Number.isSafeInteger(record?.usage?.tokens) ? record.usage.tokens : 0,
            lastUsed: Number.isSafeInteger(record?.usage?.lastUsed) ? record.usage.lastUsed : 0
        })
    })));
}

function selectEligibleKey(records, now) {
    return records.find((record) => record.status === "active" && record.backoffUntil <= now && record.key.length > 0);
}

function safeNumber(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeOutcome({ step, status, durationMs, result, modelListed, usage }) {
    const outcome = {
        step,
        model: MODEL,
        host: HOST,
        path: step === "catalog" ? MODELS_PATH : CHAT_PATH,
        duration_ms: Math.max(0, Math.round(durationMs)),
        result
    };
    if (Number.isInteger(status) && status >= 100 && status <= 599) outcome.status = status;
    if (typeof modelListed === "boolean") outcome.model_listed = modelListed;
    const promptTokens = safeNumber(usage?.prompt_tokens);
    const completionTokens = safeNumber(usage?.completion_tokens);
    if (promptTokens !== undefined) outcome.prompt_tokens = promptTokens;
    if (completionTokens !== undefined) outcome.completion_tokens = completionTokens;
    return Object.freeze(outcome);
}

function getStatus(response) {
    return Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : undefined;
}

function cancelResponse(response) {
    try {
        const cancellation = response?.body?.cancel?.();
        if (cancellation && typeof cancellation.catch === "function") cancellation.catch(() => {});
    } catch {
        // Diagnostic cleanup must not affect the gateway.
    }
}

async function cancelReaderBounded(reader, cleanupTimeoutMs, controller, setTimeoutImpl, clearTimeoutImpl) {
    let timeout;
    try {
        let cancellation;
        try {
            cancellation = Promise.resolve(reader.cancel());
        } catch {
            return;
        }
        cancellation.catch(() => {});
        const settled = new Promise((resolve) => {
            timeout = setTimeoutImpl(() => {
                controller.abort();
                resolve();
            }, cleanupTimeoutMs);
        });
        try {
            await Promise.race([cancellation, settled]);
        } catch {
            controller.abort();
        }
    } catch {
        // Cleanup failures are deliberately opaque to this diagnostic.
    } finally {
        if (timeout !== undefined) clearTimeoutImpl(timeout);
    }
}

async function readBoundedJson(response, maxBytes, project, cleanupTimeoutMs, controller, setTimeoutImpl, clearTimeoutImpl) {
    const body = response?.body;
    if (!body || typeof body.getReader !== "function") return undefined;
    let reader;
    let chunks = [];
    let total = 0;
    let complete = false;
    let needsCancellation = false;
    try {
        reader = body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                complete = true;
                break;
            }
            if (!(value instanceof Uint8Array) || total + value.byteLength > maxBytes) {
                needsCancellation = true;
                return undefined;
            }
            total += value.byteLength;
            chunks.push(value);
        }
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
        }
        let text;
        try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(merged);
            const parsed = JSON.parse(text);
            return project(parsed);
        } catch {
            needsCancellation = true;
            return undefined;
        } finally {
            text = undefined;
        }
    } catch {
        needsCancellation = true;
        return undefined;
    } finally {
        chunks = [];
        if (reader && (needsCancellation || !complete)) {
            await cancelReaderBounded(reader, cleanupTimeoutMs, controller, setTimeoutImpl, clearTimeoutImpl);
        }
        try { reader?.releaseLock(); } catch {}
    }
}

function extractUsage(payload) {
    const usage = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.usage : undefined;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
    return { prompt_tokens: safeNumber(usage.prompt_tokens), completion_tokens: safeNumber(usage.completion_tokens) };
}

function catalogListsModel(payload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) return undefined;
    return payload.data.some((item) => item && typeof item === "object" && item.id === MODEL);
}

function projectCatalog(payload) {
    const modelListed = catalogListsModel(payload);
    return modelListed === undefined ? undefined : { modelListed };
}

function projectUsage(payload) {
    return { usage: extractUsage(payload) };
}

function chatBody(content) {
    return JSON.stringify({ model: MODEL, stream: false, max_tokens: 1, messages: [{ role: "user", content }] });
}

export async function runDirectGlmProbe({
    envValue,
    keyRecords,
    fetchImpl = globalThis.fetch,
    logger = () => {},
    now = () => Date.now(),
    timeoutMs = MAX_TIMEOUT_MS,
    maxSuccessBytes = DEFAULT_MAX_SUCCESS_BYTES,
    cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
} = {}) {
    if (!isDirectGlmProbeEnabled(envValue)) return undefined;

    const startedAt = now();
    const boundedSuccessBytes = normalizeMaxSuccessBytes(maxSuccessBytes);
    const boundedCleanupTimeout = normalizeCleanupTimeout(cleanupTimeoutMs);
    const snapshot = snapshotKeyRecords(keyRecords);
    const key = selectEligibleKey(snapshot, startedAt);
    const emit = (outcome) => {
        try { logger(outcome); } catch {}
        return outcome;
    };
    if (!key) return emit(safeOutcome({ step: "selection", durationMs: now() - startedAt, result: "no_eligible_key" }));

    const controller = new AbortController();
    const boundedTimeout = Math.min(MAX_TIMEOUT_MS, Math.max(1, timeoutMs));
    const timeout = setTimeoutImpl(() => controller.abort(), boundedTimeout);
    const request = async (step, path, body, project) => {
        const endpoint = path === MODELS_PATH ? MODELS_ENDPOINT : CHAT_ENDPOINT;
        const response = await fetchImpl(`${ORIGIN}${endpoint}`, {
            method: body === undefined ? "GET" : "POST",
            headers: body === undefined ? { authorization: `Bearer ${key.key}` } : { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
            body,
            signal: controller.signal
        });
        const status = getStatus(response);
        if (status === undefined || status < 200 || status >= 300) {
            cancelResponse(response);
            return { status, payload: undefined, failed: true };
        }
        const projection = await readBoundedJson(response, boundedSuccessBytes, project, boundedCleanupTimeout, controller, setTimeoutImpl, clearTimeoutImpl);
        return { status, projection, failed: projection === undefined };
    };

    let longPrompt;
    let longBody;
    try {
        const catalog = await request("catalog", MODELS_PATH, undefined, projectCatalog);
        if (catalog.failed) return emit(safeOutcome({ step: "catalog", status: catalog.status, durationMs: now() - startedAt, result: "indeterminate" }));
        const modelListed = catalog.projection.modelListed;
        if (!modelListed) return emit(safeOutcome({ step: "catalog", status: catalog.status, durationMs: now() - startedAt, result: "model_not_listed", modelListed }));

        const sanity = await request("sanity", CHAT_PATH, chatBody("Reply with exactly OK."), projectUsage);
        if (sanity.failed) return emit(safeOutcome({ step: "sanity", status: sanity.status, durationMs: now() - startedAt, result: "indeterminate", modelListed }));

        longPrompt = " the".repeat(LONG_PROMPT_REPETITIONS);
        longBody = chatBody(longPrompt);
        const long = await request("long", CHAT_PATH, longBody, projectUsage);
        if (long.failed) return emit(safeOutcome({ step: "long", status: long.status, durationMs: now() - startedAt, result: "indeterminate", modelListed }));
        return emit(safeOutcome({ step: "long", status: long.status, durationMs: now() - startedAt, result: "success", modelListed, usage: long.projection.usage }));
    } catch {
        return emit(safeOutcome({ step: "internal", durationMs: now() - startedAt, result: "indeterminate" }));
    } finally {
        longBody = undefined;
        longPrompt = undefined;
        clearTimeoutImpl(timeout);
    }
}

export function createDirectGlmProbeScheduler({ probe, logger = () => {} } = {}) {
    let started = false;
    return Object.freeze({
        schedule(authenticated = false) {
            if (!authenticated) return undefined;
            if (started) return undefined;
            started = true;
            Promise.resolve().then(() => probe()).catch(() => {
                try { logger(safeOutcome({ step: "internal", durationMs: 0, result: "indeterminate" })); } catch {};
            });
            return undefined;
        }
    });
}
