import { getKeys, addKey, removeKey, setKeyStatus, reorderKeys, setKeyAccessibleModels } from './rotation.mjs';
import { sanitizeValidationResult, validateKey } from './validation.mjs';
import { redact } from '../shared/redaction.mjs';
import { getRecentLogs } from './logger.mjs';
import { isBearerAuthorized } from './security.mjs';
import { parseReorder, parseStatus, parseToken, parseUuid } from './admin-schema.mjs';
import { getModelLimits, getDisabledModels } from './model-limits.mjs';
import { getCapabilityMetadata } from './capability-registry.mjs';
import { mergeProbedReasoning } from './capability-probe.mjs';
import { getCachedModels, refreshModels } from './model-discovery.mjs';
import { getAllModelMetadata, refreshCatalog, getCatalogCacheInfo } from './nvidia-catalog-sync.mjs';

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        let settled = false;
        const fail = (error) => { if (!settled) { settled = true; reject(error); } };
        req.on('data', chunk => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > 1e6) return fail(Object.assign(new Error('Body too large'), { code: 'BODY_TOO_LARGE' }));
            chunks.push(buffer);
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            try {
                const body = Buffer.concat(chunks, bytes).toString('utf8');
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', fail);
        req.on('aborted', () => fail(new Error('Request aborted')));
    });
}

function sendBodyError(res, err) {
    return err?.code === 'BODY_TOO_LARGE'
        ? sendJson(res, 413, { error: 'Payload Too Large' })
        : sendJson(res, 400, { error: 'Invalid JSON' });
}

export function createAdminRequestHandler(overrides = {}) {
  return (req, res) => handleAdminRequest(req, res, overrides);
}

const STATIC_ADMIN_ROUTES = new Map([
    ['GET /admin/keys', 'keys'], ['POST /admin/keys', 'keys'],
    ['POST /admin/keys/reorder', 'reorder'], ['GET /admin/state', 'state'],
    ['POST /admin/validate', 'validate'], ['GET /admin/logs', 'logs'],
    ['GET /admin/models', 'models'],
    ['POST /admin/models/refresh', 'refresh'],
    ['POST /admin/catalog/sync', 'catalog-sync']
]);

export function classifyAdminRoute(method, pathname) {
    const name = STATIC_ADMIN_ROUTES.get(`${method} ${pathname}`);
    if (name) return { name, params: {} };
    if ([...STATIC_ADMIN_ROUTES.keys()].some((key) => key.endsWith(` ${pathname}`))) return null;
    const match = /^\/admin\/keys\/([^/]+)$/.exec(pathname);
    if (match && (method === 'DELETE' || method === 'PATCH')) return { name: 'key', params: { id: match[1] } };
    return null;
}

function pathHasAnyAdminMethod(pathname) {
    if ([...STATIC_ADMIN_ROUTES.keys()].some((key) => key.endsWith(` ${pathname}`))) return true;
    return /^\/admin\/keys\/[^/]+$/.test(pathname);
}

export function classifyAdminRequest(method, pathname) {
    const route = classifyAdminRoute(method, pathname);
    if (route) return { status: 200, route };
    if (pathHasAnyAdminMethod(pathname)) return { status: 405 };
    return { status: 404 };
}

export function classifyCanonicalAdminRequest(method, requestTarget) {
    if (typeof requestTarget !== 'string' || requestTarget.includes('?') || requestTarget.includes('#') || /%2f|%5c/i.test(requestTarget)) return { status: 404 };
    try {
        const decoded = decodeURIComponent(requestTarget);
        if (decoded !== requestTarget) return { status: 404 };
        return classifyAdminRequest(method, requestTarget);
    } catch { return { status: 404 }; }
}

// Mask a stored key for display. The first8/last4 windows overlap (or exactly
// tile) for keys of 12 chars or fewer, publishing the WHOLE key in the list
// response; short keys are therefore masked in full. Non-strings (a corrupt
// state record) are masked rather than thrown over.
function maskKeyMaterial(key) {
    if (typeof key !== 'string' || key.length === 0) return '[REDACTED]';
    if (key.length <= 12) return '***';
    return key.substring(0, 8) + '...' + key.substring(key.length - 4);
}

// Failure detail for the catch-all 500 bodies. Sanitize THEN bound: bounding
// first can truncate a secret mid-string so the redaction rules (exact runtime
// secrets, nvapi-/Bearer patterns) no longer match the fragment that survives.
export function sanitizeFailureDetail(err) {
    const raw = err && typeof err.message === 'string' ? err.message : String(err);
    return String(redact(raw)).slice(0, 256);
}

export async function handleAdminRequest(req, res, overrides = {}) {
    // Cross-origin lockout. The ONLY legitimate admin caller is the Electron
    // main process over node:http (src/main/admin-client.ts), which NEVER sends
    // an Origin header. Every browser-driven request (fetch/XHR/form, including
    // `Origin: null`) carries one, so its presence is conclusive: deny with no
    // CORS headers emitted. This closes the remaining path a hostile web page
    // could otherwise use — a bearer-protected endpoint is only unreachable
    // from a browser while the token stays secret; with this check even a
    // leaked token cannot be driven cross-origin.
    if (typeof req.headers?.origin === 'string') return sendJson(res, 403, { error: 'Forbidden' });
    const classification = classifyCanonicalAdminRequest(req.method, req.url);
    if (classification.status !== 200) return sendJson(res, classification.status, { error: classification.status === 405 ? 'Method Not Allowed' : 'Not Found' });
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    const adminToken = overrides.adminToken ?? process.env.GATEWAY_ADMIN_TOKEN;
    if (!adminToken || !isBearerAuthorized(req.headers.authorization, adminToken)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return sendJson(res, 401, { error: 'Unauthorized' });
    }
    req.url = parsedUrl.pathname;
    const listKeys = overrides.listKeys ?? getKeys;
    if (req.method === 'GET' && req.url === '/admin/keys') {
        const safeKeys = listKeys().map(k => ({
            ...k,
            key: maskKeyMaterial(k.key)
        }));
        return sendJson(res, 200, { keys: safeKeys });
    }

    if (req.method === 'POST' && req.url === '/admin/keys') {
        try {
            const body = await parseBody(req);
            const token = parseToken(body.key);
            if (!token.ok) return sendJson(res, 422, { error: token.error });
            const added = addKey(token.value);
            if (!added) return sendJson(res, 409, { error: 'Key already exists' });
            // SUB-TASK B#2 (validate-on-add): re-use the SAME validation path the /admin/validate
            // route uses (admin-api.mjs `overrides.validateKey ?? validateKey`) to populate
            // accessibleModels on add, so the UI Models panel shows the key's accessible models
            // without a separate manual re-validate. F2: fire-and-forget — the validate does a real
            // HTTPS GET capped at 10s (validation.mjs) while the production admin-client has a 5s
            // socket timeout; awaiting it made "Add Key" time out when NVIDIA was slow even though
            // addKey() already persisted the key synchronously (leaving inconsistent retry→409
            // state). The 201 now returns immediately; accessibleModels populates in the background.
            const validate = overrides.validateKey ?? validateKey;
            Promise.resolve().then(() => validate(added.key))
                .then((r) => { if (r?.valid && Array.isArray(r.accessibleModels)) setKeyAccessibleModels(added.id, r.accessibleModels); })
                .catch(() => { /* validation failure must never block the add */ });
            return sendJson(res, 201, { id: added.id });
        } catch (err) {
            return sendBodyError(res, err);
        }
    }

    if (req.method === 'DELETE' && req.url.startsWith('/admin/keys/')) {
        const id = req.url.split('/')[3];
        const parsedId = parseUuid(id);
        if (!parsedId.ok) return sendJson(res, 422, { error: parsedId.error });
        const removed = removeKey(parsedId.value);
        if (removed) return sendJson(res, 200, { success: true });
        return sendJson(res, 404, { error: 'Key not found' });
    }

    if (req.method === 'PATCH' && req.url.startsWith('/admin/keys/')) {
        const id = req.url.split('/')[3];
        try {
            const body = await parseBody(req);
            const parsedId = parseUuid(id); const status = parseStatus(body.status);
            if (!parsedId.ok || !status.ok) return sendJson(res, 422, { error: parsedId.error ?? status.error });
            const updated = setKeyStatus(parsedId.value, status.value);
            if (updated) return sendJson(res, 200, { success: true });
            return sendJson(res, 404, { error: 'Key not found' });
        } catch (err) {
            return sendBodyError(res, err);
        }
    }
    
    if (req.method === 'POST' && req.url === '/admin/keys/reorder') {
        try {
            const body = await parseBody(req);
            const order = parseReorder(body.ids);
            if (!order.ok) return sendJson(res, 422, { error: order.error });
            reorderKeys(order.value);
            return sendJson(res, 200, { success: true });
        } catch (err) {
            return sendBodyError(res, err);
        }
    }

    if (req.method === 'GET' && req.url === '/admin/state') {
        const now = Date.now();
        const keys = getKeys();
        const state = {
            total: keys.length,
            active: keys.filter(k => k.status === 'active' && k.backoffUntil <= now).length,
            backingOff: keys.filter(k => k.status === 'active' && k.backoffUntil > now).length,
            disabled: keys.filter(k => k.status === 'disabled').length,
            quota: keys.filter(k => k.status === 'quota-exceeded').length
        };
        return sendJson(res, 200, state);
    }

    if (req.method === 'POST' && req.url === '/admin/validate') {
        try {
            const body = await parseBody(req);
            const token = parseToken(body.key);
            if (!token.ok) return sendJson(res, 422, { error: token.error });
            const validate = overrides.validateKey ?? validateKey;
            const result = await validate(token.value);
            // SUB-TASK B#2 (validate-update): when the validated token corresponds to an
            // already-stored key, persist the resulting accessibleModels onto that key record
            // (in-memory) so the UI Models panel refreshes on re-validation. The result returned
            // to the caller is unchanged (sanitizeAdminValidationResult), matching prior behavior
            // at admin-api.mjs:174. Only a valid + non-empty catalog is persisted.
            if (result?.valid && Array.isArray(result.accessibleModels) && result.accessibleModels.length > 0) {
                const stored = listKeys().find((k) => k.key === token.value);
                if (stored) setKeyAccessibleModels(stored.id, result.accessibleModels);
            }
            return sendJson(res, 200, sanitizeAdminValidationResult(result));
        } catch (err) {
            return sendBodyError(res, err);
        }
    }
    
    if (req.method === 'GET' && req.url === '/admin/logs') {
        return sendJson(res, 200, { logs: getRecentLogs() });
    }

    // GET /admin/models — the UI Models panel data source. Returns the FULL
    // enriched catalog (NOT filtered by disabledModels) with an `enabled` flag,
    // so the UI can SEE disabled models to re-enable them. Cold-start behavior
    // mirrors GET /v1/models/cached (server.mjs:1185): uses getCachedModels(),
    // which lazily fetches on first call and caches; a fetch failure returns a
    // 500. Enrichment reuses the SAME path as /v1/models (getModelLimits +
    // getCapabilityMetadata), joined with the config disabledModels for the
    // enabled flag.
    if (req.method === 'GET' && req.url === '/admin/models') {
        try {
            const models = await getCachedModels();
            // F1: getDisabledModels() returns lowercased ids; lowercase the model id
            // before the Set lookup so a case typo in config cannot defeat the flag.
            const disabledIds = new Set(getDisabledModels());
            // Phase 5: enrich each entry with NGC catalog metadata (provider,
            // category, popularity, etc.). getAllModelMetadata() is cached (24h
            // TTL); it lazily fetches the catalog on first call and NEVER throws
            // (defensive — mirrors model-limits.mjs:155-185). Returns a Map keyed
            // by the OpenAI-compatible id form. Entries with no NGC match fall
            // back to safe defaults (provider=null, popularity=0, labels=[]).
            const catalogMeta = await getAllModelMetadata();
            const data = models
                .filter((m) => m && typeof m === 'object' && !Array.isArray(m) && typeof m.id === 'string')
                .map((m) => {
                    const limits = getModelLimits(m.id);
                    const meta = catalogMeta && typeof catalogMeta.get === 'function'
                        ? catalogMeta.get(m.id)
                        : catalogMeta?.[m.id];
                    const labels = meta && Array.isArray(meta.labels) ? meta.labels : [];
                    // Parity with GET /v1/models (server.mjs): static family
                    // capabilities, then the LIVE-probed reasoning override when a
                    // cached probe result exists for this exact model id.
                    const capabilities = getCapabilityMetadata(m.id);
                    mergeProbedReasoning(capabilities, m.id);
                    return {
                        id: m.id,
                        context_length: limits.context,
                        max_completion_tokens: limits.output,
                        capabilities,
                        enabled: !disabledIds.has(m.id.toLowerCase()),
                        // Phase 5 enrichment (all optional, backwards-compatible):
                        // The 5 fields above are unchanged; the 10 below are ADDITIVE.
                        provider: meta?.publisher ?? null,
                        publisher: meta?.publisher ?? null,
                        shortDescription: meta?.shortDescription ?? '',
                        category: labels.length > 0 ? labels[0] : null,
                        labels,
                        popularity: meta && typeof meta.popularity === 'number' ? meta.popularity : 0,
                        lastUpdated: meta?.lastUpdated ?? null,
                        logoUrl: meta?.logoUrl ?? null,
                        downloadable: meta?.downloadable === true,
                        freeEndpoint: meta?.freeEndpoint === true
                    };
                });
            return sendJson(res, 200, { data });
        } catch (err) {
            return sendJson(res, 500, { error: 'Failed to retrieve models catalog' });
        }
    }

    // POST /admin/models/refresh — admin-only manual re-discovery trigger,
    // mirrored from the main-port POST /v1/models/refresh (server.mjs:1201).
    // Exposed on the ADMIN port so the main process can reach it over the
    // admin channel (port+1 + admin token) without a gateway module import —
    // the main process talks to the gateway via HTTP on the admin port ONLY
    // (the admin server (server.mjs:1414) only forwards /admin/* requests, so
    // /v1/models/refresh is unreachable from port+1). Returns the freshly
    // fetched RAW upstream catalog ({ data, cached: false }); the main process
    // re-fetches GET /admin/models for the enriched + `enabled` view it maps
    // to ModelConfig. NOTE: refreshModels() re-fetches NVIDIA (up to 30s
    // upstream); the admin-client (admin-client.ts) caps the socket at 5s, so
    // a slow upstream surfaces here as a timeout (handled by the caller).
    if (req.method === "POST" && req.url === '/admin/models/refresh') {
        try {
            const all = await refreshModels();
            return sendJson(res, 200, { data: all, cached: false });
        } catch (err) {
            return sendJson(res, 500, { error: 'Failed to refresh models' });
        }
    }

    // POST /admin/catalog/sync — admin-only manual NGC catalog re-sync trigger
    // (bypasses the 24h TTL of getAllModelMetadata). Powers the future "Sync
    // Catalog" button in the V2 Models panel. refreshCatalog is defensive (never
    // throws a search-level error), so the catch branch below is essentially
    // unreachable in practice; it is kept as a belt-and-suspenders guard for
    // parity with /admin/models/refresh above (500 + the actual error in body).
    //
    // FAILURE-SURFACING CONTRACT (Phase 5 backend review, MAJOR #1): a sync that
    // fails to ADVANCE the cache MUST surface a 5xx — returning 200 when NGC is
    // unreachable would be a lie. We snapshot getCatalogCacheInfo() BEFORE and
    // AFTER refreshCatalog() and compare fetchedAt:
    //   * ADVANCED (null → now, OR stale-t1 → fresh-t2) → 200 with the existing
    //     success body shape ({ data: { size } }, cached: false) plus a human-
    //     readable fetchedAt ISO so the UI can show "last synced at …".
    //   * UNCHANGED (null === null on a COLD-START failure, OR stale-t1 ===
    //     stale-t1 when refreshCatalog caught the search-level throw and returned
    //     the stale cache defensively — see nvidia-catalog-sync.mjs:339-346) →
    //     503 Service Unavailable. We still mirror size + cached:true in the body
    //     so clients can degrade gracefully (the cached catalog is still available
    //     for `/admin/models` reads; only the SYNC failed).
    if (req.method === "POST" && req.url === '/admin/catalog/sync') {
        try {
            const before = getCatalogCacheInfo();
            const fetchedAtBefore = before.fetchedAt;
            const sizeBefore = before.size;

            await refreshCatalog();

            const after = getCatalogCacheInfo();
            const fetchedAtAfter = after.fetchedAt;
            const sizeAfter = after.size;

            if (fetchedAtBefore !== fetchedAtAfter) {
                // Timestamp advanced → the NGC fetch succeeded. Mirrors the
                // existing success body ({ data: { size }, cached: false }) with
                // the additive fetchedAt ISO (backwards-compatible).
                return sendJson(res, 200, {
                    data: { size: sizeAfter },
                    cached: false,
                    fetchedAt: fetchedAtAfter !== null ? new Date(fetchedAtAfter).toISOString() : null
                });
            }

            // Timestamp UNCHANGED → NGC was unreachable (or threw during fetch);
            // refreshCatalog returned the stale cache (or an empty Map on a cold
            // start) WITHOUT poisoning the cache. Surfaces 503 so the operator
            // sees the failure; clients still get size + the (stale) fetchedAt.
            return sendJson(res, 503, {
                error: 'Sync failed: NGC unreachable, stale cache served',
                cached: true,
                fetchedAt: fetchedAtBefore !== null ? new Date(fetchedAtBefore).toISOString() : null,
                size: sizeBefore
            });
        } catch (err) {
            // refreshCatalog is defensive (never throws a search-level error), so
            // this branch is only reachable on a true unhandled runtime fault.
            // Surface the actual error message for parity with /admin/models/refresh.
            return sendJson(res, 500, { error: `Failed to sync catalog: ${sanitizeFailureDetail(err)}` });
        }
    }

    return sendJson(res, 404, { error: 'Not Found' });
}

function sanitizeAdminValidationResult(result) {
    const safe = sanitizeValidationResult(result);
    return redact(safe);
}
