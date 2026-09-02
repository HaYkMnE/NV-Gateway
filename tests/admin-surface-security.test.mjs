// Admin-surface security audit tests (tier 1-5 of the local admin HTTP API).
// All behavioral: the REAL in-process handler (createAdminRequestHandler) over a
// real loopback socket on an ephemeral port. No NVIDIA calls anywhere:
// NGC_CATALOG_SYNC_DISABLE_WARM stops the catalog self-warm at import time, and
// the validate path is never exercised against a real network (no key added
// here is real; 'nvapi-*' strings below are deliberately fake).
//
// RED-first proofs (each fails against the pre-fix admin-api.mjs on the stated
// line and passes after):
//   * mask test   — admin-api.mjs `k.key.substring(0, 8) + '...' + substring(len-4)`
//                   reveals the WHOLE key when length <= 12 (windows tile/overlap);
//                   13-15 chars leave only 1-3 hidden (brute-forceable), so the
//                   partial mask requires >= 4 hidden chars (length >= 16).
//   * origin test — no Origin check existed before classification/auth; a
//                   browser-driven request with a valid token was processed.
//   * sanitize-then-bound helper — did not exist; bound-first order leaves a
//                   truncated runtime secret the regex rules can no longer match.
// Guard tests (GREEN before and after) pin behaviors that must not regress.

process.env.NGC_CATALOG_SYNC_DISABLE_WARM = "1";

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-admin-surface-'));
process.env.GATEWAY_STATE_PATH = path.join(tempRoot, 'gateway-state.json');
process.env.GATEWAY_LOG_PATH = path.join(tempRoot, 'gateway.jsonl');

const ADMIN_TOKEN = 'audit-admin-token-01';
const UUID_A = '550e8400-e29b-41d4-a716-446655440000';
const UUID_B = '6fa459ea-ee8a-3ca4-894e-db77e160355e';
const UUID_C = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

let adminApi;
let rotation;

test.before(async () => {
  adminApi = await import(`${pathToFileURL(path.join(root, 'src/gateway/admin-api.mjs')).href}?audit=${Date.now()}`);
  rotation = await import(pathToFileURL(path.join(root, 'src/gateway/rotation.mjs')).href);
  rotation.setPersistenceAdapter(() => {});
});

test.after(async () => {
  rotation.closeStateWatcher?.();
  const logger = await import(pathToFileURL(path.join(root, 'src/gateway/logger.mjs')).href);
  logger.closeLogger?.();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function request(port, requestPath, { method = 'GET', body, headers = {}, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...(auth ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {}), ...headers };
    for (const name of Object.keys(requestHeaders)) if (requestHeaders[name] === undefined) delete requestHeaders[name];
    if (body !== undefined) {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers: requestHeaders }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function startAdmin(overrides = {}) {
  const server = http.createServer(adminApi.createAdminRequestHandler({ adminToken: ADMIN_TOKEN, ...overrides }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server;
}

async function stopAdmin(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

// ─── FIX 1 (secret exposure): short-key masking overlap ──────────────────────

test('GET /admin/keys never tiles the whole key into the masked field (<=12 chars)', async () => {
  const record = (id, key) => ({ id, key, status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] });
  const six = 'K1SIXX';            // 6 chars  — pre-fix: shown twice, fully
  const eight = 'EIGHTCHR';         // 8 chars  — pre-fix: full key is the prefix run
  const twelve = 'TWELVECHAR12';    // 12 chars — pre-fix: windows exactly tile the key
  const server = await startAdmin({ listKeys: () => [record(UUID_A, six), record(UUID_B, eight), record(UUID_C, twelve)] });
  try {
    const res = await request(server.address().port, '/admin/keys');
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    const byId = new Map(parsed.keys.map((k) => [k.id, k.key]));

    for (const [id, key] of [[UUID_A, six], [UUID_B, eight], [UUID_C, twelve]]) {
      const masked = byId.get(id);
      assert.notEqual(masked, undefined);
      assert.equal(masked.includes(key), false, `full key must never appear in the mask (${key.length} chars)`);
      // No tiling: the response must not simultaneously give away the first 8
      // AND last 4 of a short key (their union IS the key at <= 12 chars).
      assert.equal(masked.startsWith(key.substring(0, 8)) && masked.endsWith(key.substring(key.length - 4)), false,
        `mask must not reveal first8+last4 of a ${key.length}-char key`);
      assert.equal(masked, '***', 'short keys are masked in full');
    }
    // And the raw body carries no short-key material at all.
    for (const key of [six, eight, twelve]) assert.equal(res.body.includes(key), false, `${key} leaked into body`);
  } finally { await stopAdmin(server); }
});

test('GET /admin/keys keeps the first8...last4 mask for real-length keys (no UI regression)', async () => {
  const longKey = 'nvapi-auditfakekey-00000000000000000000000000'; // 46 chars
  const lastFour = longKey.substring(longKey.length - 4);
  const record = { id: UUID_A, key: longKey, status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] };
  const server = await startAdmin({ listKeys: () => [record] });
  try {
    const res = await request(server.address().port, '/admin/keys');
    assert.equal(res.statusCode, 200);
    const masked = JSON.parse(res.body).keys[0].key;
    assert.equal(masked.startsWith(longKey.substring(0, 8)), true, 'long-key prefix preserved');
    assert.equal(masked.endsWith(lastFour), true, 'long-key suffix preserved');
    assert.equal(res.body.includes(longKey), false, 'full long key never appears');
  } finally { await stopAdmin(server); }
});

test('GET /admin/keys boundary: 13-15 char keys are masked in full (only 1-3 chars would stay hidden)', async () => {
  // Verifier hardening: the commit masked <=12 (the tiling bound). At 13-15 the
  // windows no longer tile but leave just 1-3 characters unknown — brute-forceable
  // against the upstream oracle if a masked list leaks. The mask must stay full
  // until >=4 characters remain hidden (length >= 16); the partial format is
  // unchanged at 16+ (UI compatibility for real nvapi- keys preserved).
  const record = (id, key) => ({ id, key, status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] });
  const k13 = 'M'.repeat(13); const k14 = 'N'.repeat(14); const k15 = 'O'.repeat(15); const k16 = 'P'.repeat(16);
  assert.equal(k13.length, 13); assert.equal(k14.length, 14); assert.equal(k15.length, 15); assert.equal(k16.length, 16);
  const server = await startAdmin({ listKeys: () => [record(UUID_A, k13), record(UUID_B, k14), record(UUID_C, k15), record('1b4e28ba-2fa1-11d2-883f-0016d3cca428', k16)] });
  try {
    const res = await request(server.address().port, '/admin/keys');
    assert.equal(res.statusCode, 200);
    const byId = new Map(JSON.parse(res.body).keys.map((k) => [k.id, k.key]));
    assert.equal(byId.get(UUID_A), '***', '13 chars: 1 hidden char is brute-forceable, mask in full');
    assert.equal(byId.get(UUID_B), '***', '14 chars: 2 hidden chars, mask in full');
    assert.equal(byId.get(UUID_C), '***', '15 chars: 3 hidden chars, mask in full');
    assert.equal(byId.get('1b4e28ba-2fa1-11d2-883f-0016d3cca428'), 'PPPPPPPP...PPPP', '16 chars: 4 hidden, first8...last4 resumes');
    for (const key of [k13, k14, k15, k16]) assert.equal(res.body.includes(key), false, `${key.length}-char key leaked into body`);
  } finally { await stopAdmin(server); }
});

// ─── FIX 2 (cross-origin): admin API must refuse browser-driven requests ─────

test('admin API rejects any request carrying an Origin header, even with a valid token', async () => {
  rotation.initializeState({ keys: [] });
  const server = await startAdmin();
  const port = server.address().port;
  try {
    const hostile = { origin: 'https://evil.example' };
    // A browser fetch/XHR/form post from a hostile page always carries Origin.
    const get = await request(port, '/admin/keys', { headers: hostile });
    assert.equal(get.statusCode, 403, `Origin GET must be 403, got ${get.statusCode}`);
    const post = await request(port, '/admin/keys', { method: 'POST', body: JSON.stringify({ key: 'origin-smuggled-key-notreal' }), headers: hostile });
    assert.equal(post.statusCode, 403, `Origin POST must be 403, got ${post.statusCode}`);
    assert.equal(post.headers['access-control-allow-origin'], undefined, 'no CORS grant may be emitted');
    assert.equal(rotation.getKeys().length, 0, 'rejected POST must not have added a key');
    const options = await request(port, '/admin/keys', { method: 'OPTIONS', headers: { ...hostile, 'access-control-request-method': 'POST' } });
    assert.equal(options.statusCode, 403, `preflight must fail closed, got ${options.statusCode}`);
    // "Origin: null" (sandboxed iframe / file://) is also a browser origin.
    const nullOrigin = await request(port, '/admin/keys', { headers: { origin: 'null' } });
    assert.equal(nullOrigin.statusCode, 403, `Origin:null must be 403, got ${nullOrigin.statusCode}`);

    // The legitimate caller (Electron main via node http — admin-client.ts)
    // NEVER sends Origin; it must keep working.
    const ok = await request(port, '/admin/keys');
    assert.equal(ok.statusCode, 200, 'headerless (node) caller is unaffected');
  } finally { await stopAdmin(server); }
});

// ─── FIX 3 (secret exposure): catalog-sync failure detail — sanitize THEN bound

test('catalog-sync failure detail redacts secrets before bounding (order-proof)', async () => {
  assert.equal(typeof adminApi.sanitizeFailureDetail, 'function', 'sanitizeFailureDetail must be exported');
  const { setRuntimeSecrets } = await import(pathToFileURL(path.join(root, 'src/shared/redaction.mjs')).href);
  try {
    // Case A: a runtime secret placed at offset 250. If the code bounds to 256
    // BEFORE redacting, the secret's surviving prefix is no longer an exact
    // runtime-secret match and leaks. redact-then-bound is the only safe order.
    const runtimeSecret = `ZZRUNTIME${'q'.repeat(40)}`;
    setRuntimeSecrets([runtimeSecret]);
    const ordered = adminApi.sanitizeFailureDetail(new Error(`${'E'.repeat(250)}${runtimeSecret}`));
    assert.equal(ordered.includes('ZZRUNTIME'), false, 'bound-then-redact would leak a truncated runtime secret');
    // Order-proof, not just content-proof: under the broken bound-FIRST order the
    // 256-cut keeps the secret's first 6 chars ("ZZRUNT") — a fragment that no
    // longer exact-matches the runtime secret and survives redaction. The
    // full-secret assertion above cannot see that fragment; only a PREFIX check
    // distinguishes redact-then-bound from bound-then-redact. (Verifier mutation
    // M3: with the assertion below absent, `redact(raw.slice(0,256))` stayed GREEN.)
    assert.equal(ordered.includes(runtimeSecret.substring(0, 6)), false,
      'no PREFIX of the runtime secret may survive — redact must run before bounding');
    assert.ok(ordered.length <= 256, `detail must be bounded to 256 (got ${ordered.length})`);

    // Case B: nvapi-/Bearer patterns in an upstream message are redacted.
    const ngc = adminApi.sanitizeFailureDetail(new Error('GET https://huggingface.co/x?token=bad failed: Bearer nvapi-fakeauditkey000000 refused'));
    assert.equal(ngc.includes('nvapi-fakeauditkey000000'), false, 'nvapi- material must be redacted');
    assert.equal(ngc.includes('token=bad'), false, 'URL query credentials must be stripped');
    assert.ok(ngc.length <= 256);

    // Case C: a giant message is bounded regardless of content.
    const huge = adminApi.sanitizeFailureDetail(new Error('X'.repeat(100_000)));
    assert.ok(huge.length <= 256, `unbounded detail (${huge.length}) must be capped`);
  } finally {
    setRuntimeSecrets([]);
  }
});

// ─── GUARDS (already-safe behaviors pinned as regression tests) ──────────────

test('route/auth matrix: unknown paths 404, wrong method 405, missing or wrong token 401', async () => {
  const server = await startAdmin();
  const port = server.address().port;
  try {
    // Deliberate design (production-security-wiring.test.mjs): the 404/405
    // boundary answers pre-auth; every functional route answers post-auth.
    const wrongTok = (p, opts = {}) => request(port, p, { ...opts, headers: { authorization: 'Bearer wrong-token' } });
    assert.equal((await wrongTok('/admin/keys')).statusCode, 401);
    // Classification precedes auth (tested design contract): a wrong-token
    // request to a VALID path with a WRONG method still hits the 405 boundary.
    assert.equal((await wrongTok('/admin/keys', { method: 'PUT' })).statusCode, 405);
    assert.equal((await wrongTok(`/admin/keys/${UUID_A}`, { method: 'DELETE' })).statusCode, 401);
    // No Authorization header at all:
    assert.equal((await request(port, '/admin/keys', { auth: false })).statusCode, 401);
    assert.equal((await request(port, '/admin/state', { auth: false })).statusCode, 401);
    // Pre-auth boundary (deliberate design contract): 404/405 with NO token.
    assert.equal((await request(port, '/admin/unknown', { auth: false })).statusCode, 404);
    assert.equal((await request(port, '/admin/keys', { method: 'PUT', auth: false })).statusCode, 405);
  } finally { await stopAdmin(server); }
});

test('schema gate: wrong-type status, unknown body fields ignored, __proto__ does not pollute', async () => {
  rotation.initializeState({ keys: [{ id: UUID_A, key: 'guard-seed-key-notreal', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 } }] });
  const server = await startAdmin();
  const port = server.address().port;
  try {
    const badStatus = await request(port, `/admin/keys/${UUID_A}`, { method: 'PATCH', body: JSON.stringify({ status: 'root' }) });
    assert.equal(badStatus.statusCode, 422, 'out-of-set status rejected');
    const wrongType = await request(port, `/admin/keys/${UUID_A}`, { method: 'PATCH', body: JSON.stringify({ status: 1 }) });
    assert.equal(wrongType.statusCode, 422, 'non-string status rejected');
    const proto = await request(port, '/admin/keys', { method: 'POST', body: '{"__proto__":{"polluted":"yes"},"key":"guard-proto-key-notreal"}' });
    assert.equal(proto.statusCode, 201);
    assert.equal({}.polluted, undefined, '__proto__ body field must not pollute Object.prototype');
    const extra = await request(port, `/admin/keys/${UUID_A}`, { method: 'PATCH', body: JSON.stringify({ status: 'disabled', key: 'override-attempt', id: UUID_B }) });
    assert.equal(extra.statusCode, 200);
    const stored = rotation.getKeys().find((k) => k.id === UUID_A);
    assert.equal(stored.status, 'disabled', 'intended field applied');
    assert.equal(stored.key, 'guard-seed-key-notreal', 'extra key field must not overwrite stored material');
  } finally { await stopAdmin(server); }
});

test('schema gate: reorder rejects duplicates, non-UUIDs and oversized lists', async () => {
  const server = await startAdmin();
  const port = server.address().port;
  try {
    const dup = await request(port, '/admin/keys/reorder', { method: 'POST', body: JSON.stringify({ ids: [UUID_A, UUID_A] }) });
    assert.equal(dup.statusCode, 422, 'duplicate ids rejected');
    const bad = await request(port, '/admin/keys/reorder', { method: 'POST', body: JSON.stringify({ ids: ['not-a-uuid'] }) });
    assert.equal(bad.statusCode, 422, 'non-UUID id rejected');
    const oversized = await request(port, '/admin/keys/reorder', { method: 'POST', body: JSON.stringify({ ids: Array.from({ length: 1001 }, (_, i) => UUID_A.slice(0, -1) + (i % 10)) }) });
    assert.equal(oversized.statusCode, 422, 'over-1000 id list rejected');
  } finally { await stopAdmin(server); }
});
