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

export async function handleAdminRequest(req, res, overrides = {}) {
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
            key: k.key.substring(0, 8) + '...' + k.key.substring(k.key.length - 4)
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
        } catch (err) {\n            return sendBodyError(res, err);\n        }\n    }\n\n    if (req.method === 'DELETE' && req.url.startsWith('/admin/keys/')) {\n        const id = req.url.split('/')[3];\n        const parsedId = parseUuid(id);\n        if (!parsedId.ok) return sendJson(res, 422, { error: parsedId.error });\n        const removed = removeKey(parsedId.value);\n        if (removed) return sendJson(res, 200, { success: true });\n        return sendJson(res, 404, { error: 'Key not found' });\n    }\n\n    if (req.method === 'PATCH' && req.url.startsWith('/admin/keys/')) {\n        const id = req.url.split('/')[3];\n        try {\n            const body = await parseBody(req);\n            const parsedId = parseUuid(id); const status = parseStatus(body.status);\n            if (!parsedId.ok || !status.ok) return sendJson(res, 422, { error: parsedId.error ?? status.error });\n            const updated = setKeyStatus(parsedId.value, status.value);\n            if (updated) return sendJson(res, 200, { success: true });\n            return sendJson(res, 404, { error: 'Key not found' });\n        } catch (err) {\n            return sendBodyError(res, err);\n        }\n    }\n    \n    if (req.method === 'POST' && req.url === '/admin/keys/reorder') {\n        try {\n            const body = await parseBody(req);\n            const order = parseReorder(body.ids);\n            if (!order.ok) return sendJson(res, 422, { error: order.error });\n            reorderKeys(order.value);\n            return sendJson(res, 200, { success: true });\n        } catch (err) {\n            return sendBodyError(res, err);\n        }\n    }\n\n    if (req.method === 'GET' && req.url === '/admin/state') {\n        const now = Date.now();\n        const keys = getKeys();\n        const state = {\n            total: keys.length,\n            active: keys.filter(k => k.status === 'active' && k.backoffUntil <= now).length,\n            backingOff: keys.filter(k => k.status === 'active' && k.backoffUntil > now).length,\n            disabled: keys.filter(k => k.status === 'disabled').length,\n            quota: keys.filter(k => k.status === 'quota-exceeded').length\n        };\n        return sendJson(res, 200, state);\n    }\n\n    if (req.method === 'POST' && req.url === '/admin/validate') {\n        try {\n            const body = await parseBody(req);\n            const token = parseToken(body.key);\n            if (!token.ok) return sendJson(res, 422, { error: token.error });\n            const validate = overrides.validateKey ?? validateKey;\n            const result = await validate(token.value);\n            // SUB-TASK B#2 (validate-update): when the validated token corresponds to an\n            // already-stored key, persist the resulting accessibleModels onto that key record\n            // (in-memory) so the UI Models panel refreshes on re-validation. The result returned\n            // to the caller is unchanged (sanitizeAdminValidationResult), matching prior behavior\n            // at admin-api.mjs:174. Only a valid + non-empty catalog is persisted.\n            if (result?.valid && Array.isArray(result.accessibleModels) && result.accessibleModels.length > 0) {\n                const stored = listKeys().find((k) => k.key === token.value);\n                if (stored) setKeyAccessibleModels(stored.id, result.accessibleModels);\n            }\n            return sendJson(res, 200, sanitizeAdminValidationResult(result));\n        } catch (err) {\n            return sendBodyError(res, err);\n        }\n    }\n    \n    if (req.method === 'GET' && req.url === '/admin/logs') {\n        return sendJson(res, 200, { logs: getRecentLogs() });\n    }\n\n    // GET /admin/models — the UI Models panel data source. Returns the FULL\n    // enriched catalog (NOT filtered by disabledModels) with an `enabled` flag,\n    // so the UI can SEE disabled models to re-enable them. Cold-start behavior\n    // mirrors GET /v1/models/cached (server.mjs:1185): uses getCachedModels(),\n    // which lazily fetches on first call and caches; a fetch failure returns a\n    // 500. Enrichment reuses the SAME path as /v1/models (getModelLimits +\n    // getCapabilityMetadata), joined with the config disabledModels for the\n    // enabled flag.\n    if (req.method === 'GET' && req.url === '/admin/models') {\n        try {\n            const models = await getCachedModels();\n            // F1: getDisabledModels() returns lowercased ids; lowercase the model id\n            // before the Set lookup so a case typo in config cannot defeat the flag.\n            const disabledIds = new Set(getDisabledModels());\n            // Phase 5: enrich each entry with NGC catalog metadata (provider,\n            // category, popularity, etc.). getAllModelMetadata() is cached (24h\n            // TTL); it lazily fetches the catalog on first call and NEVER throws\n            // (defensive — mirrors model-limits.mjs:155-185). Returns a Map keyed\n            // by the OpenAI-compatible id form. Entries with no NGC match fall\n            // back to safe defaults (provider=null, popularity=0, labels=[]).\n            const catalogMeta = await getAllModelMetadata();\n            const data = models\n                .filter((m) => m && typeof m === 'object' && !Array.isArray(m) && typeof m.id === 'string')\n                .map((m) => {\n                    const limits = getModelLimits(m.id);\n                    const meta = catalogMeta && typeof catalogMeta.get === 'function'\n                        ? catalogMeta.get(m.id)\n                        : catalogMeta?.[m.id];\n                    const labels = meta && Array.isArray(meta.labels) ? meta.labels : [];\n                    // Parity with GET /v1/models (server.mjs): static family\n                    // capabilities, then the LIVE-probed reasoning override when a\n                    // cached probe result exists for this exact model id.\n                    const capabilities = getCapabilityMetadata(m.id);\n                    mergeProbedReasoning(capabilities, m.id);\n                    return {\n                        id: m.id,\n                        context_length: limits.context,\n                        max_completion_tokens: limits.output,\n                        capabilities,\n                        enabled: !disabledIds.has(m.id.toLowerCase()),\n                        // Phase 5 enrichment (all optional, backwards-compatible):\n                        // The 5 fields above are unchanged; the 10 below are ADDITIVE.\n                        provider: meta?.publisher ?? null,\n                        publisher: meta?.publisher ?? null,\n                        shortDescription: meta?.shortDescription ?? '',\n                        category: labels.length > 0 ? labels[0] : null,\n                        labels,\n                        popularity: meta && typeof meta.popularity === 'number' ? meta.popularity : 0,\n                        lastUpdated: meta?.lastUpdated ?? null,\n                        logoUrl: meta?.logoUrl ?? null,\n                        downloadable: meta?.downloadable === true,\n                        freeEndpoint: meta?.freeEndpoint === true\n                    };\n                });\n            return sendJson(res, 200, { data });\n        } catch (err) {\n            return sendJson(res, 500, { error: 'Failed to retrieve models catalog' });\n        }\n    }\n\n    // POST /admin/models/refresh — admin-only manual re-discovery trigger,\n    // mirrored from the main-port POST /v1/models/refresh (server.mjs:1201).\n    // Exposed on the ADMIN port so the main process can reach it over the\n    // admin channel (port+1 + admin token) without a gateway module import —\n    // the main process talks to the gateway via HTTP on the admin port ONLY\n    // (the admin server (server.mjs:1414) only forwards /admin/* requests, so\n    // /v1/models/refresh is unreachable from port+1). Returns the freshly\n    // fetched RAW upstream catalog ({ data, cached: false }); the main process\n    // re-fetches GET /admin/models for the enriched + `enabled` view it maps\n    // to ModelConfig. NOTE: refreshModels() re-fetches NVIDIA (up to 30s\n    // upstream); the admin-client (admin-client.ts) caps the socket at 5s, so\n    // a slow upstream surfaces here as a timeout (handled by the caller).\n    if (req.method === \"POST\" && req.url === '/admin/models/refresh') {\n        try {\n            const all = await refreshModels();\n            return sendJson(res, 200, { data: all, cached: false });\n        } catch (err) {\n            return sendJson(res, 500, { error: 'Failed to refresh models' });\n        }\n    }\n\n    // POST /admin/catalog/sync — admin-only manual NGC catalog re-sync trigger\n    // (bypasses the 24h TTL of getAllModelMetadata). Powers the future \"Sync\n    // Catalog\" button in the V2 Models panel. refreshCatalog is defensive (never\n    // throws a search-level error), so the catch branch below is essentially\n    // unreachable in practice; it is kept as a belt-and-suspenders guard for\n    // parity with /admin/models/refresh above (500 + the actual error in body).\n    //\n    // FAILURE-SURFACING CONTRACT (Phase 5 backend review, MAJOR #1): a sync that\n    // fails to ADVANCE the cache MUST surface a 5xx — returning 200 when NGC is\n    // unreachable would be a lie. We snapshot getCatalogCacheInfo() BEFORE and\n    // AFTER refreshCatalog() and compare fetchedAt:\n    //   * ADVANCED (null → now, OR stale-t1 → fresh-t2) → 200 with the existing\n    //     success body shape ({ data: { size } }, cached: false) plus a human-\n    //     readable fetchedAt ISO so the UI can show \"last synced at …\".\n    //   * UNCHANGED (null === null on a COLD-START failure, OR stale-t1 ===\n    //     stale-t1 when refreshCatalog caught the search-level throw and returned\n    //     the stale cache defensively — see nvidia-catalog-sync.mjs:339-346) →\n    //     503 Service Unavailable. We still mirror size + cached:true in the body\n    //     so clients can degrade gracefully (the cached catalog is still available\n    //     for `/admin/models` reads; only the SYNC failed).\n    if (req.method === \"POST\" && req.url === '/admin/catalog/sync') {\n        try {\n            const before = getCatalogCacheInfo();\n            const fetchedAtBefore = before.fetchedAt;\n            const sizeBefore = before.size;\n\n            await refreshCatalog();\n\n            const after = getCatalogCacheInfo();\n            const fetchedAtAfter = after.fetchedAt;\n            const sizeAfter = after.size;\n\n            if (fetchedAtBefore !== fetchedAtAfter) {\n                // Timestamp advanced → the NGC fetch succeeded. Mirrors the\n                // existing success body ({ data: { size }, cached: false }) with\n                // the additive fetchedAt ISO (backwards-compatible).\n                return sendJson(res, 200, {\n                    data: { size: sizeAfter },\n                    cached: false,\n                    fetchedAt: fetchedAtAfter !== null ? new Date(fetchedAtAfter).toISOString() : null\n                });\n            }\n\n            // Timestamp UNCHANGED → NGC was unreachable (or threw during fetch);\n            // refreshCatalog returned the stale cache (or an empty Map on a cold\n            // start) WITHOUT poisoning the cache. Surfaces 503 so the operator\n            // sees the failure; clients still get size + the (stale) fetchedAt.\n            return sendJson(res, 503, {\n                error: 'Sync failed: NGC unreachable, stale cache served',\n                cached: true,\n                fetchedAt: fetchedAtBefore !== null ? new Date(fetchedAtBefore).toISOString() : null,\n                size: sizeBefore\n            });\n        } catch (err) {\n            // refreshCatalog is defensive (never throws a search-level error), so\n            // this branch is only reachable on a true unhandled runtime fault.\n            // Surface the actual error message for parity with /admin/models/refresh.\n            return sendJson(res, 500, { error: `Failed to sync catalog: ${err && err.message ? err.message : String(err)}` });\n        }\n    }\n\n    return sendJson(res, 404, { error: 'Not Found' });\n}\n\nfunction sanitizeAdminValidationResult(result) {\n    const safe = sanitizeValidationResult(result);\n    return redact(safe);\n}\n