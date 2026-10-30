/**
 * Model discovery service for NVIDIA NIM API.
 *
 * Fetches available models from the upstream NVIDIA API and caches them
 * locally with a configurable TTL (default 24h). Models listed in
 * GATEWAY_DISABLED_MODELS are filtered out before caching.
 *
 * Environment variables:
 * - GATEWAY_MODEL_CACHE_TTL_MS — cache TTL in ms (default: 86400000 = 24h)
 * - GATEWAY_DISABLED_MODELS — comma-separated list of model IDs to exclude
 *
 * @module model-discovery
 */

import https from "node:https";
import { createBoundedBuffer } from "./bounded-buffer.mjs";

// B3: the model list is a non-stream body and must be bounded (AGENTS.md
// "No Unbounded Memory Buffers"). 4 MiB matches the existing llm-stats-ranking.mjs
// precedent for a catalog-style JSON fetch; the response is normally ~100 KB.
const MAX_MODELS_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Upstream NVIDIA API hostname. */
const NVIDIA_API_HOST = "integrate.api.nvidia.com";

/** Upstream path for model listing. */
const NVIDIA_MODELS_PATH = "/v1/models";

/** Default cache TTL in milliseconds (24 hours). */
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Default fallback models used when upstream is unreachable / slow on cold start. */
const DEFAULT_FALLBACK_MODELS = Object.freeze([
    { id: "deepseek-ai/deepseek-v4-flash", object: "model", owned_by: "deepseek-ai" },
    { id: "deepseek-ai/deepseek-v4.1-flash", object: "model", owned_by: "deepseek-ai" },
    { id: "stepfun-ai/step-3.7-flash", object: "model", owned_by: "stepfun-ai" },
    { id: "meta/llama-4-maverick-17b-128e-instruct", object: "model", owned_by: "meta" },
    { id: "qwen/qwen3.5-397b-a17b", object: "model", owned_by: "qwen" },
    { id: "z-ai/glm-5.2", object: "model", owned_by: "z-ai" },
    { id: "z-ai/glm-5.3", object: "model", owned_by: "z-ai" },
    { id: "minimaxai/minimax-m3", object: "model", owned_by: "minimaxai" },
    { id: "meta/llama-3.1-8b-instruct", object: "model", owned_by: "meta" },
    { id: "meta/llama-3.1-70b-instruct", object: "model", owned_by: "meta" },
    { id: "meta/llama-3.3-70b-instruct", object: "model", owned_by: "meta" },
    { id: "deepseek-ai/deepseek-r1", object: "model", owned_by: "deepseek-ai" },
    { id: "nvidia/llama-3.1-nemotron-70b-instruct", object: "model", owned_by: "nvidia" },
    { id: "mistralai/mistral-large-2-instruct", object: "model", owned_by: "mistralai" }
]);

/** @type {{ models: object[], fetchedAt: number } | null} */
let cache = null;

/** @type {Promise<object[]> | null} */
let fetchInFlight = null;

/** Resolved cache TTL in ms from env or default. */
let cacheTtlMs = Number.parseInt(process.env.GATEWAY_MODEL_CACHE_TTL_MS || "", 10);
if (!Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0) {
    cacheTtlMs = DEFAULT_CACHE_TTL_MS;
}

/**
 * Parse the GATEWAY_DISABLED_MODELS environment variable.
 *
 * @returns {Set<string>} Set of disabled model IDs (empty if unset).
 */
function parseDisabledModels() {
    const raw = process.env.GATEWAY_DISABLED_MODELS;
    if (!raw) return new Set();
    return new Set(
        raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
    );
}

/**
 * Get fallback models filtered by disabled models.
 *
 * @returns {object[]}
 */
export function getFallbackModels() {
    const disabled = parseDisabledModels();
    return DEFAULT_FALLBACK_MODELS.filter((m) => !disabled.has(m.id));
}

/**
 * Fetch available models directly from the NVIDIA API.
 *
 * Uses node:https so no extra runtime dependencies are introduced.
 * The upstream is expected to return `{ data: [...] }`.
 *
 * @returns {Promise<object[]>} Array of model objects (may be empty).
 * @throws {Error} If the upstream returns a non-2xx status or the
 *  response body cannot be parsed.
 */
export function fetchAvailableModels() {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: NVIDIA_API_HOST,
            port: 443,
            path: NVIDIA_MODELS_PATH,
            method: "GET",
            headers: {
                "Accept": "application/json",
                "User-Agent": "NV-Gateway/1.0.0"
            }
        };

        // Single settle guard: overflow, res/req error, timeout and end race; only the first wins.
        let settled = false;
        // resolve/reject are idempotent, so no guard is needed here; `settled` only
        // gates side effects (the overflow destroy and end-time parsing).
        const settle = (fn, value) => { settled = true; fn(value); };
        const req = https.get(options, (res) => {
            const collector = createBoundedBuffer(MAX_MODELS_RESPONSE_BYTES);
            res.on("error", (err) => settle(reject, err));
            // A mid-body reset fires only aborted/close on res (no error/end). After a
            // normal end the promise is already settled, so this reject is a no-op.
            res.on("close", () => settle(reject, new Error("NVIDIA models response closed before end")));
            res.on("data", (chunk) => {
                if (settled || collector.push(chunk)) return;
                const tooLarge = new Error("NVIDIA models response too large");
                settle(reject, tooLarge); // reject first, then tear down the socket
                req.destroy(tooLarge);
            });
            res.on("end", () => {
                if (settled) return;
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    settle(reject, new Error(`NVIDIA API returned ${res.statusCode}`));
                    return;
                }
                try {
                    const parsed = JSON.parse(collector.toBuffer().toString("utf8"));
                    const disabled = parseDisabledModels();
                    const models = (parsed.data || []).filter(m => !disabled.has(m.id));
                    settle(resolve, models);
                } catch (e) {
                    settle(reject, new Error(`Failed to parse NVIDIA models response: ${e.message}`));
                }
            });
        });
        req.on("error", (err) => settle(reject, err));
        req.setTimeout(10000, () => req.destroy(new Error("NVIDIA API timeout")));
    });
}

/**
 * Internal helper to run and deduplicate in-flight fetch.
 *
 * @returns {Promise<object[]>}
 */
function doFetch() {
    if (fetchInFlight) return fetchInFlight;
    const promise = (async () => {
        try {
            const models = await fetchAvailableModels();
            if (Array.isArray(models)) {
                cache = { models, fetchedAt: Date.now() };
            }
            return models;
        } catch (err) {
            if (cache) return cache.models;
            return getFallbackModels();
        }
    })().finally(() => {
        if (fetchInFlight === promise) {
            fetchInFlight = null;
        }
    });
    fetchInFlight = promise;
    return promise;
}

/**
 * Get cached models or fetch if cache is empty/expired.
 * Bounded timeout ensures caller never blocks/times out.
 *
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<object[]>} Array of model objects.
 */
export async function getCachedModels(options = {}) {
    const now = Date.now();
    if (cache && (now - cache.fetchedAt) < cacheTtlMs) {
        return cache.models;
    }
    if (cache) {
        // Stale cache exists: trigger background revalidation without blocking
        void doFetch().catch(() => {});
        return cache.models;
    }
    // Cold start: wait bounded time (default 2500ms) for initial fetch
    const timeoutMs = options.timeoutMs ?? 2500;
    // The timeout handle is DELIBERATELY retained so it can be cleared on BOTH
    // settle paths: without clearTimeout a fast success left a live 2.5s timer
    // per call (a timer leak that kept the event loop busy and fired a
    // pointless rejection later). Semantics are unchanged — the race still
    // rejects on timeout when doFetch() does not settle in time.
    let timer = null;
    try {
        const result = await Promise.race([
            doFetch(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Model discovery timeout")), timeoutMs); })
        ]);
        return result;
    } catch {
        return cache ? cache.models : getFallbackModels();
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Force a fresh fetch from upstream, updating the cache.
 * Bounded wait avoids hanging if upstream is slow.
 * In-flight promise deduplication via doFetch prevents duplicate upstream requests.
 *
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<object[]>} Array of freshly fetched model objects.
 */
export async function refreshModels(options = {}) {
    const timeoutMs = options.timeoutMs ?? 3000;
    // Clear the timeout handle on both settle paths (see getCachedModels for
    // the leak this fixes). Timeout behaviour itself is unchanged.
    let timer = null;
    try {
        const models = await Promise.race([
            doFetch(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Refresh timeout")), timeoutMs); })
        ]);
        return models;
    } catch {
        return cache ? cache.models : getFallbackModels();
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Clear the models cache. Useful for testing.
 */
export function resetCache() {
    cache = null;
    fetchInFlight = null;
}

/**
 * Get information about the current cache state.
 *
 * @returns {{ hasCache: boolean, ageMs: number | null, modelCount: number | null }}
 */
export function getCacheInfo() {
    if (!cache) return { hasCache: false, ageMs: null, modelCount: null };
    return {
        hasCache: true,
        ageMs: Date.now() - cache.fetchedAt,
        modelCount: cache.models.length
    };
}

// Fire-and-forget background warm so cold-start GET /admin/models and /v1/models/cached
// never block or time out waiting for upstream.
// Two opt-out paths keep tests hermetic:
//   * GATEWAY_MODEL_DISCOVERY_DISABLE_WARM=1 (or NGC_CATALOG_SYNC_DISABLE_WARM=1) — test opt-outs
//   * GATEWAY_TEST_LOCAL_UPSTREAM_PORT — test sentinel on spawned gateway child processes
if (process.env.GATEWAY_MODEL_DISCOVERY_DISABLE_WARM !== "1"
    && process.env.NGC_CATALOG_SYNC_DISABLE_WARM !== "1"
    && !process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT) {
    setTimeout(() => {
        getCachedModels().catch(() => {});
    }, 0);
}
