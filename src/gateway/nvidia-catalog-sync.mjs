// @ts-check
/**
 * Phase 5: NVIDIA NGC catalog metadata sync for the V2 Models panel.
 *
 * Fetches rich per-model metadata (publisher, category labels, popularity,
 * last-updated, downloadable flags) from NVIDIA NGC's public catalog JSON API
 * (https://api.ngc.nvidia.com/v2/...). Results are cached 24h (configurable via
 * NGC_CATALOG_SYNC_TTL_MS) and exposed to admin-api.mjs GET /admin/models to
 * enrich the existing 5-field response with additive, backwards-compatible
 * fields (provider, publisher, category, labels, popularity, lastUpdated,
 * logoUrl, downloadable, freeEndpoint, shortDescription).
 *
 * Auth: NONE. NGC catalog endpoints are unauthenticated (verified by research:
 * search returns 131 records via HTTP 200, ~175KB JSON, no Authorization
 * header; details return 94KB+ per record with publisher + labels + attributes
 * such as lastMonthApiInvocationCount / lastMonthDownloadCount).
 *
 * Defensive pattern (mirrors model-limits.mjs:155-185): on ANY error (network,
 * parse, partial), refreshCatalog returns the stale cache OR an empty Map —
 * it NEVER throws, so a catalog outage never crashes a /admin/models request.
 *
 * The module self-warms at top-level via setTimeout(refreshCatalog, 0) unless
 * process.env.NGC_CATALOG_SYNC_DISABLE_WARM === '1'. Tests set the sentinel to
 * avoid the background warm interfering with mocked fetcher behavior; production
 * leaves it unset so the gateway's initial readiness pre-fills the cache and
 * the first /admin/models request does not block on a fresh catalog fetch.
 *
 * Environment variables:
 * - NGC_CATALOG_SYNC_TTL_MS — cache TTL in ms (default: 86400000 = 24h)
 * - NGC_CATALOG_SYNC_DISABLE_WARM — set to '1' in tests to skip the top-level warm
 *
 * @module nvidia-catalog-sync
 */

import https from "node:https";

/** NGC catalog API hostname (unauthenticated). */
const NGC_API_HOST = "api.ngc.nvidia.com";

/** CUDA build.nvidia.com organization id (research-verified: 131 catalog records). */
const NGC_ORG_ID = "qc69jvmznzxy";

/** Default cache TTL in milliseconds (24 hours — matches model-discovery.mjs). */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Resolved cache TTL in ms from env or default. */
let cacheTtlMs = Number.parseInt(process.env.NGC_CATALOG_SYNC_TTL_MS || "", 10);
if (!Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0) {
    cacheTtlMs = DEFAULT_TTL_MS;
}

/** Default HTTP timeout per NGC fetch (30s — matches model-discovery.mjs). */
const DEFAULT_FETCH_TIMEOUT_MS = 30000;

/** Concurrency limit for the per-record detail fetches (research guidance). */
const DETAIL_CONCURRENCY = 6;

/**
 * Build the catalog SEARCH path with a URL-encoded JSON query body.
 * @returns {string}
 */
function buildSearchPath() {
    const body = JSON.stringify({
        query: "*",
        pageSize: 200,
        page: 0
    });
    return `/v2/search/catalog/resources/ENDPOINT?q=${encodeURIComponent(body)}`;
}

/** Detail endpoint path prefix (the slug is appended + encoded per-resource). */
const DETAIL_PATH_PREFIX = `/v2/endpoints/${NGC_ORG_ID}/`;

/**
 * @typedef {Object} ModelMetadata
 * @property {string} id            OpenAI-compatible id: `${publisher}/${displayName}`
 *                                  (matches the ids returned by integrate.api.nvidia.com/v1/models
 *                                  for publisher-qualified models).
 * @property {string} slug          NGC internal artifact.name (slug).
 * @property {string} publisher     Raw publisher slug (e.g. "nvidia", "z-ai").
 * @property {string} shortDescription  Single-line description.
 * @property {string[]} labels      NGC labels / tags array (e.g. ["Agent","Frontier"]).
 * @property {number} popularity   lastMonthApiInvocationCount as int (0 if missing).
 * @property {string} lastUpdated   ISO timestamp (artifact.updatedDate).
 * @property {string} logoUrl       NGC logo URL (NOT hot-link usable cross-origin;
 *                                   frontend uses bundled SVG instead).
 * @property {boolean} downloadable canGuestDownload boolean (typically true).
 * @property {boolean} freeEndpoint isPublic boolean (typically true).
 */

/** @type {{ byId: Map<string, ModelMetadata>, fetchedAt: number | null } | null} */
let cache = null;

/**
 * In-flight refresh promise — dedupes concurrent callers (and prevents a racing
 * cold-start fetch from spawning a SECOND refresh chain on the same process).
 */
let refreshInFlight = null;

/**
 * Pluggable HTTPS fetcher. Tests replace this via __setFetcherForTests__ to mock
 * network calls without touching node:https. Production uses the default
 * real-https implementation below.
 * @type {(urlPath: string, timeoutMs?: number) => Promise<unknown>}
 */
let fetcher = defaultFetchJson;

/**
 * Resolve the User-Agent sent to NGC. Prefers the published package version;
 * falls back to a static string. Mirrors the model-discovery.mjs convention.
 * @returns {string}
 */
function userAgent() {
    return `NV-Gateway/${process.env.npm_package_version || "1.0.0"}`;
}

/**
 * Promise-returning HTTPS GET that resolves to parsed JSON; rejects on non-2xx
 * status, network error, or timeout. Mirrors model-discovery.mjs:74-93.
 * @param {string} urlPath
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown>}
 */
function defaultFetchJson(urlPath, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: NGC_API_HOST,
            port: 443,
            path: urlPath,
            method: "GET",
            headers: {
                Accept: "application/json",
                "User-Agent": userAgent()
            }
        };
        const req = https.get(options, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`NGC API returned ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    reject(new Error(`Failed to parse NGC response: ${err.message}`));
                }
            });
        });
        req.on("error", reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error("NGC API timeout")));
    });
}

/**
 * Test-only hook used by tests/nvidia-catalog-sync.test.mjs to replace the HTTPS
 * fetcher with a mock returning canned JSON. Outside tests this is unused.
 * @param {(urlPath: string, timeoutMs?: number) => Promise<unknown>} impl
 */
export function __setFetcherForTests__(impl) {
    fetcher = impl;
}

/** @returns {(urlPath: string, timeoutMs?: number) => Promise<unknown>} */
export function __restoreFetcherForTests__() {
    fetcher = defaultFetchJson;
    return fetcher;
}

/**
 * Read-only accessor for the configured cache TTL (ms). Useful for diagnostic
 * checks + the env-override test (which sets NGC_CATALOG_SYNC_TTL_MS).
 * @returns {number}
 */
export function getCacheTtlMs() {
    return cacheTtlMs;
}

/**
 * Test-only hook to override the cache TTL on an EXISTING module instance. The
 * production code resolves TTL once at module load from the env (see above);
 * tests use this hook to exercise multiple TTL scenarios against ONE import.
 * @param {number} ms
 */
export function __setCacheTtlMsForTests__(ms) {
    cacheTtlMs = Number.isFinite(ms) && ms > 0 ? Number(ms) : DEFAULT_TTL_MS;
}

/**
 * Parse the NGC {key,value} attribute array into a flat record. Defensive: bad
 * shapes are skipped (never throws).
 * @param {unknown} arr
 * @returns {Record<string, string>}
 */
function parseAttributes(arr) {
    /** @type {Record<string, string>} */
    const attrs = {};
    if (Array.isArray(arr)) {
        for (const a of arr) {
            if (a && typeof a === "object" && typeof a.key === "string") {
                attrs[a.key] = typeof a.value === "string" ? a.value : String(a.value ?? "");
            }
        }
    } else if (arr && typeof arr === "object") {
        for (const [k, v] of Object.entries(arr)) {
            if (typeof k === "string") {
                attrs[k] = typeof v === "string" ? v : String(v ?? "");
            }
        }
    }
    return attrs;
}

/**
 * Parse an NGC int attribute (e.g. lastMonthApiInvocationCount, stored as a
 * stringified int) into a defensive number (0 if missing/unparseable).
 * @param {unknown} s
 * @returns {number}
 */
function parseIntSafe(s) {
    if (typeof s === "number") {
        return Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
    }
    const n = Number.parseInt(String(s ?? ""), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Normalize an NGC detail record (or the search-record fallback) into a
 * ModelMetadata instance. NEVER throws — bad shapes return null so the caller
 * can skip them. Note: an id (publisher-qualified form) MUST be computable.
 * @param {Record<string, any>} r
 * @returns {ModelMetadata | null}
 */
function recordToMetadata(r) {
    if (!r || typeof r !== "object") return null;
    const a = r.artifact || r;
    if (!a || typeof a !== "object") return null;

    let publisher = "";
    if (typeof a.publisher === "string" && a.publisher) {
        publisher = a.publisher;
    } else if (Array.isArray(a.labels)) {
        const pubItem = a.labels.find((item) => item && typeof item === "object" && item.key === "publisher");
        if (pubItem && Array.isArray(pubItem.values) && typeof pubItem.values[0] === "string" && pubItem.values[0]) {
            publisher = pubItem.values[0];
        }
    }

    const displayName = typeof a.displayName === "string" && a.displayName
        ? a.displayName
        : (typeof a.name === "string" ? a.name : "");
    const name = typeof a.name === "string" && a.name ? a.name : displayName;
    if (!displayName && !name) return null;

    let id = displayName;
    if (publisher) {
        if (displayName.toLowerCase().startsWith(`${publisher.toLowerCase()}/`)) {
            id = displayName;
        } else {
            id = `${publisher}/${displayName}`;
        }
    }

    const shortDescription = typeof a.shortDescription === "string" && a.shortDescription
        ? a.shortDescription
        : (typeof a.description === "string" && a.description ? a.description : "");

    /** @type {string[]} */
    const labels = [];
    if (Array.isArray(a.labels)) {
        for (const item of a.labels) {
            if (typeof item === "string" && item.trim()) {
                labels.push(item.trim());
            } else if (item && typeof item === "object") {
                if (item.key === "publisher") {
                    continue;
                }
                if (Array.isArray(item.values)) {
                    for (const v of item.values) {
                        if (typeof v === "string" && v.trim()) {
                            labels.push(v.trim());
                        }
                    }
                } else if (typeof item.value === "string" && item.value.trim()) {
                    labels.push(item.value.trim());
                }
            }
        }
    }

    const attrs = parseAttributes(a.attributes);
    const popRaw = attrs.lastMonthApiInvocationCount ||
        attrs.last_month_api_invocation_count ||
        attrs.weightPopular ||
        attrs.weight_popular ||
        a.weightPopular ||
        a.weight_popular ||
        a.lastMonthApiInvocationCount ||
        a.last_month_api_invocation_count ||
        0;
    const popularity = parseIntSafe(popRaw);

    const lastUpdated = typeof a.updatedDate === "string" && a.updatedDate
        ? a.updatedDate
        : (typeof a.dateModified === "string" && a.dateModified
            ? a.dateModified
            : (typeof a.dateCreated === "string" && a.dateCreated
                ? a.dateCreated
                : ""));

    const logoUrl = typeof a.logo === "string" && a.logo
        ? a.logo
        : (typeof a.logoUrl === "string" && a.logoUrl
            ? a.logoUrl
            : "");

    const downloadable = a.canGuestDownload === true || a.downloadable === true;
    const freeEndpoint = a.isPublic === true || a.freeEndpoint === true;

    return {
        id,
        slug: name,
        publisher,
        shortDescription,
        labels,
        popularity,
        lastUpdated,
        logoUrl,
        downloadable,
        freeEndpoint
    };
}

/**
 * Fetch a single record's detail JSON. Defensive: returns null on failure so a
 * single bad record does not abort the batch.
 * @param {string} slug
 * @param {string} [org]
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown>}
 */
async function fetchDetail(slug, org = NGC_ORG_ID, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
    try {
        const orgSegment = encodeURIComponent(org || NGC_ORG_ID);
        return await fetcher(`/v2/endpoints/${orgSegment}/${encodeURIComponent(slug)}`, timeoutMs);
    } catch {
        return null;
    }
}

/**
 * Process `items` with bounded concurrency by chunking into batches of `limit`
 * and awaiting Promise.allSettled per batch. Mirrors the spec's batch-chunk
 * guidance (no external p-limit dependency).
 * @template T
 * @param {Array<T>} items
 * @param {(item: T) => Promise<void>} worker
 * @param {number} [limit]
 */
async function forEachWithLimit(items, worker, limit = DETAIL_CONCURRENCY) {
    for (let i = 0; i < items.length; i += limit) {
        const batch = items.slice(i, Math.min(i + limit, items.length));
        await Promise.allSettled(batch.map(worker));
    }
}

/**
 * Defensive refresh — never throws. Fetches the search catalog then per-record
 * detail JSON (6 concurrent), populates the cache, and returns the Map. On ANY
 * error, returns the stale cache (or an empty Map on cold-start failures).
 *
 * In-flight dedup: concurrent callers await the SAME refresh promise instead of
 * spawning duplicate refresh chains (refreshInFlight is the memo).
 * @returns {Promise<Map<string, ModelMetadata>>}
 */
export async function refreshCatalog() {
    if (refreshInFlight) return refreshInFlight;
    const promise = (async () => {
        try {
            const search = await fetcher(buildSearchPath());
            /** @type {Array<Record<string, any>>} */
            let resources = [];
            if (search && typeof search === "object") {
                if (Array.isArray(search.resources)) {
                    resources = search.resources;
                } else if (Array.isArray(search.results)) {
                    for (const group of search.results) {
                        if (group && Array.isArray(group.resources)) {
                            resources.push(...group.resources);
                        }
                    }
                }
            }

            /** @type {ModelMetadata[]} */
            const metas = [];
            // Batched concurrent detail fetches (limit 6). Defensive per-record
            // (failures are dropped, never thrown).
            await forEachWithLimit(resources, async (r) => {
                if (!r || typeof r !== "object") return;
                const a = r.artifact || r;
                const slug = typeof a.name === "string" && a.name
                    ? a.name
                    : (typeof a.displayName === "string" && a.displayName ? a.displayName : "");
                if (!slug) return;
                const org = typeof a.orgName === "string" && a.orgName ? a.orgName : NGC_ORG_ID;
                const detail = await fetchDetail(slug, org, DEFAULT_FETCH_TIMEOUT_MS);
                let source = r;
                if (detail && typeof detail === "object") {
                    const rArtifact = r.artifact || r;
                    const dArtifact = detail.artifact || detail;
                    source = { ...rArtifact, ...dArtifact };
                }
                const meta = recordToMetadata(source);
                if (meta) metas.push(meta);
            });

            /** @type {Map<string, ModelMetadata>} */
            const byId = new Map();

            // 1. Primary keys first so no alias can overwrite a canonical model ID
            for (const m of metas) {
                if (!m.id) continue;
                byId.set(m.id, m);
            }

            // 2. Comprehensive ID Aliasing so any model ID format matched from /v1/models resolves cleanly:
            // - Primary key: ${publisher}/${displayName} (or displayName if publisher empty)
            // - Slug key: if name !== displayName, add ${publisher}/${name} and ${name}
            // - Bare key: if ID has /, add the part after /
            // - Normalized key: replace _ with . (and . with _)
            for (const m of metas) {
                if (!m.id) continue;
                /** @type {Set<string>} */
                const candidates = new Set();
                candidates.add(m.id);

                const pub = m.publisher;
                const slug = m.slug;

                if (slug) {
                    if (pub) {
                        candidates.add(`${pub}/${slug}`);
                    }
                    candidates.add(slug);
                }

                // Bare keys (after /)
                for (const key of Array.from(candidates)) {
                    const slashIdx = key.indexOf("/");
                    if (slashIdx >= 0) {
                        const bare = key.slice(slashIdx + 1);
                        if (bare) candidates.add(bare);
                    }
                }

                // Normalized keys (_ <-> .)
                for (const key of Array.from(candidates)) {
                    if (key.includes("_")) {
                        candidates.add(key.replace(/_/g, "."));
                    }
                    if (key.includes(".")) {
                        candidates.add(key.replace(/\./g, "_"));
                    }
                }

                // Also lowercased variants for case-insensitive lookup robustness
                for (const key of Array.from(candidates)) {
                    const lower = key.toLowerCase();
                    if (lower !== key) {
                        candidates.add(lower);
                        if (lower.includes("_")) {
                            candidates.add(lower.replace(/_/g, "."));
                        }
                        if (lower.includes(".")) {
                            candidates.add(lower.replace(/\./g, "_"));
                        }
                    }
                }

                for (const key of candidates) {
                    if (key && !byId.has(key)) {
                        byId.set(key, m);
                    }
                }
            }

            cache = { byId, fetchedAt: Date.now() };
            return cache.byId;
        } catch {
            // Defensive (mirrors model-limits.mjs philosophy): a search-level
            // failure returns the stale cache if present, otherwise an empty Map.
            // We never throw — preserve the prior cache and never poison it with
            // an error (later /admin/catalog/sync triggers re-read fresh).
            if (cache) return cache.byId;
            return new Map();
        }
    })().finally(() => {
        if (refreshInFlight === promise) refreshInFlight = null;
    });
    refreshInFlight = promise;
    return promise;
}

/**
 * Get cached catalog metadata or fetch if cache is empty/expired. In-flight
 * refreshes are reused (refreshCatalog dedup). Never throws. Bounded wait
 * ensures /admin/models never hangs on slow upstream.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<Map<string, ModelMetadata>>}
 */
export async function getAllModelMetadata(options = {}) {
    const now = Date.now();
    if (cache && cache.fetchedAt !== null && (now - cache.fetchedAt) < cacheTtlMs) {
        return cache.byId;
    }
    if (cache && cache.byId) {
        // Stale cache exists: trigger background refresh without blocking
        void refreshCatalog().catch(() => {});
        return cache.byId;
    }
    // Cold start: wait bounded time (default 2000ms) for catalog sync
    const timeoutMs = options.timeoutMs ?? 2000;
    try {
        const result = await Promise.race([
            refreshCatalog(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Catalog sync timeout")), timeoutMs))
        ]);
        return result;
    } catch {
        return cache ? cache.byId : new Map();
    }
}

/**
 * Synchronous read from the cache. Returns ModelMetadata | undefined. Never throws.
 * @param {string} id
 * @returns {ModelMetadata | undefined}
 */
export function getMetadataForModelId(id) {
    if (!cache || !cache.byId || typeof id !== "string") return undefined;
    return cache.byId.get(id);
}

/** Clear the catalog cache (and the in-flight dedup slot). Useful for tests. */
export function resetCatalogCache() {
    cache = null;
    refreshInFlight = null;
}

/** @returns {{ fetchedAt: number | null, size: number }} */
export function getCatalogCacheInfo() {
    return cache
        ? { fetchedAt: cache.fetchedAt, size: cache.byId.size }
        : { fetchedAt: null, size: 0 };
}

// Fire-and-forget background warm so the first GET /admin/models is fast.
// Two opt-out paths keep tests hermetic:
//   * NGC_CATALOG_SYNC_DISABLE_WARM=1 — explicit per-test opt-out (used by the
//     tests that import admin-api.mjs in the TEST PROCESS without spawning a
//     gateway child, e.g. production-security-wiring / security-hardening /
//     p0-regressions / models-panel-gateway test 11).
//   * GATEWAY_TEST_LOCAL_UPSTREAM_PORT — the conventional test sentinel set on
//     every gateway CHILD process spawned via tests/local-upstream-preload.cjs
//     (which redirects NGC's https.get back to a local fake upstream). Setting
//     this env gate keeps the warm from racing on the spawned child's first tick
//     and polluting the fake upstream's captured request log (which would break
//     failover / auth-content assertions).
// Production leaves BOTH unset — the gateway process pre-fills the cache during
// its initial readiness window, so the first user request is served from cache.
if (process.env.NGC_CATALOG_SYNC_DISABLE_WARM !== "1"
    && !process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT) {
    setTimeout(refreshCatalog, 0);
}
