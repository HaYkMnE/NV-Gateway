// @ts-check
/**
 * Tests for the Models-panel gateway backend (Phase 1 of 3).
 *
 * Covers two sub-tasks:
 *   A. Real enforcement of `disabledModels` read from the gateway config
 *      (config.json `disabledModels: string[]`), NOT the separate
 *      GATEWAY_DISABLED_MODELS env-var filter inside model-discovery.mjs.
 *      - GET /v1/models drops disabled ids after enrichment.
 *      - POST /v1/chat/completions with a disabled model -> 404 OpenAI error,
 *        NO upstream call.
 *      - POST /v1/messages with a disabled model -> 404 Anthropic envelope,
 *        NO upstream call.
 *      - Defensive: missing disabledModels -> treated as [] (no filter/crash).
 *      - Per-request freshness: disabling a model takes effect on the NEXT
 *        request (config re-read), without restarting the gateway.
 *   B. Per-key accessibleModels persistence.
 *      - Key record carries accessibleModels (default [] for existing keys).
 *      - Populate via validate-on-add (POST /admin/keys) AND validate-update
 *        (POST /admin/validate on an existing stored key).
 *      - GET /admin/keys includes accessibleModels per key.
 *      - GET /admin/models returns the FULL enriched catalog (NOT filtered by
 *        disabledModels) with an `enabled` flag (disabled model present with
 *        enabled:false).
 *
 * Harness follows the project convention from tests/model-enrichment.test.mjs:
 * a programmable fake local upstream (http.createServer) redirected via
 * tests/local-upstream-preload.cjs (https.request -> local HTTP), with the real
 * gateway spawned as a child from source (src/gateway/server.mjs). No real
 * network and no real API keys are used. Synthetic credentials only.
 */
// Phase 5: opt out of the nvidia-catalog-sync top-level background warm so the
// in-process admin-api import below (test 11) does NOT fire a real NGC fetch
// against the test process. Out-of-process gateway child tests still go through
// the local-upstream preload redirect (https -> local HTTP), where NGC paths
// miss and the catalog refresh returns an empty Map defensively anyway.
process.env.NGC_CATALOG_SYNC_DISABLE_WARM = "1";

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localUpstreamPreloadPath = path.join(projectRoot, 'tests', 'local-upstream-preload.cjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-models-panel-${process.pid}-`));

// Deterministic modelLimits (mirrors config/config.example.json values). Defined
// inline so the test is self-contained and never depends on the on-disk
// example config's encoding (which carries a BOM the gateway strips via
// model-limits.mjs, but a direct JSON.parse here would reject).
const MODEL_LIMITS = {
  '*': { output: 4096, context: 131072 },
  'z-ai/glm-5.2': { output: 131072, context: 202752 },
  'meta/llama-4-maverick-17b-128e-instruct': { output: 4096, context: 128000 },
  'stepfun-ai/step-3.7-flash': { output: 16384, context: 256000 },
  'deepseek-ai/deepseek-v4-pro': { output: 393216, context: 1048576 },
  'deepseek-ai/deepseek-v4-flash': { output: 393216, context: 1048576 },
  'deepseek/deepseek-v4-pro': { output: 393216, context: 1048576 },
  'qwen/qwen3.5-397b-a17b': { output: 8192, context: 262144 },
  'minimaxai/minimax-m3': { output: 16384, context: 1000000 }
};
const TEST_GATEWAY_TOKEN = 'test-gateway-token-not-a-credential';
const TEST_ADMIN_TOKEN = 'test-admin-token-not-a-credential';

// Catalog returned by the fake upstream for GET /v1/models. Includes a model we
// disable in some tests (deepseek-ai/deepseek-v4-pro) plus known families.
const UPSTREAM_MODELS = [
  { id: 'z-ai/glm-5.2', object: 'model', owned_by: 'z-ai' },
  { id: 'meta/llama-4-maverick-17b-128e-instruct', object: 'model', owned_by: 'meta' },
  { id: 'deepseek-ai/deepseek-v4-pro', object: 'model', owned_by: 'deepseek-ai' }
];
const UPSTREAM_MODELS_BODY = JSON.stringify({ object: 'list', data: UPSTREAM_MODELS });

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// Test 1: GET /v1/models filters out disabled model ids (disabled absent,
// enabled present) while still enriching the survivors.
// ───────────────────────────────────────────────────────────────────────────
test('GET /v1/models filters out disabled model ids and keeps enabled ones', async () => {
  const harness = await startModelsPanelGateway({
    upstreamModelsBody: UPSTREAM_MODELS_BODY,
    disabledModels: ['deepseek-ai/deepseek-v4-pro']
  });
  try {
    const result = await requestGateway(harness.gatewayPort, '/v1/models');
    assert.equal(result.statusCode, 200);
    const parsed = JSON.parse(result.body);
    const ids = parsed.data.map((m) => m.id);
    assert.ok(!ids.includes('deepseek-ai/deepseek-v4-pro'), 'disabled model must be absent from /v1/models');
    assert.ok(ids.includes('z-ai/glm-5.2'), 'enabled model must be present');
    assert.ok(ids.includes('meta/llama-4-maverick-17b-128e-instruct'), 'enabled model must be present');
    assert.equal(ids.length, 2, 'exactly one disabled model filtered out of three');
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Test 2: POST /v1/chat/completions with a disabled model -> 404 + OpenAI
// error body, and the fake upstream chat handler is NOT invoked (fail fast
// before any key rotation / upstream call).
// ───────────────────────────────────────────────────────────────────────────
test('POST /v1/chat/completions with a disabled model returns 404 OpenAI error and makes NO upstream call', async () => {
  const harness = await startModelsPanelGateway({
    upstreamModelsBody: UPSTREAM_MODELS_BODY,
    disabledModels: ['deepseek-ai/deepseek-v4-pro']
  });
  try {
    const body = JSON.stringify({ model: 'deepseek-ai/deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] });
    const result = await requestGateway(harness.gatewayPort, '/v1/chat/completions', 'POST', body);
    assert.equal(result.statusCode, 404);
    const parsed = JSON.parse(result.body);
    assert.deepEqual(parsed, {
      error: {
        message: 'model not found: deepseek-ai/deepseek-v4-pro',
        type: 'invalid_request_error',
        code: 'model_not_found'
      }
    });
    assert.equal(harness.upstreamChatHits, 0, 'no upstream chat call must be made for a disabled model');
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Test 3: POST /v1/messages with a disabled model -> 404 + Anthropic error
// envelope, and no upstream call.
// ───────────────────────────────────────────────────────────────────────────
test('POST /v1/messages with a disabled model returns 404 Anthropic envelope and makes NO upstream call', async () => {
  const harness = await startModelsPanelGateway({
    upstreamModelsBody: UPSTREAM_MODELS_BODY,
    disabledModels: ['z-ai/glm-5.2']
  });
  try {
    const body = JSON.stringify({
      model: 'z-ai/glm-5.2',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }]
    });
    const result = await requestGateway(harness.gatewayPort, '/v1/messages', 'POST', body);
    assert.equal(result.statusCode, 404);
    const parsed = JSON.parse(result.body);
    assert.deepEqual(parsed, {
      type: 'error',
      error: { type: 'not_found_error', message: 'model: z-ai/glm-5.2 not found' }
    });
    assert.equal(harness.upstreamChatHits, 0, 'no upstream chat call must be made for a disabled model');
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Test 4: Re-validating an EXISTING stored key (POST /admin/validate) updates
// that key record's accessibleModels in memory, and GET /admin/keys surfaces it.
// Exercises the validate-update path.
// ───────────────────────────────────────────────────────────────────────────
test('POST /admin/validate on an existing stored key persists accessibleModels onto that key', async () => {
  // Seed the child with a known key so we can re-validate it.
  const seedKey = 'seed-valid-key-notreal';
  const harness = await startModelsPanelGateway({
    upstreamModelsBody: UPSTREAM_MODELS_BODY,
    disabledModels: [],
    seedKeys: [seedKey]
  });
  try {
    const validateRes = await requestAdmin(harness.adminPort, '/admin/validate', 'POST', JSON.stringify({ key: seedKey }));
    assert.equal(validateRes.statusCode, 200);
    const vParsed = JSON.parse(validateRes.body);
    assert.equal(vParsed.valid, true);
    assert.ok(Array.isArray(vParsed.accessibleModels) && vParsed.accessibleModels.length === 3);

    const keysRes = await requestAdmin(harness.adminPort, '/admin/keys');
    assert.equal(keysRes.statusCode, 200);
    const keysParsed = JSON.parse(keysRes.body);
    const seed = keysParsed.keys.find((k) => k.key.includes(seedKey.slice(0, 4)) && k.key.endsWith(seedKey.slice(-4)));
    assert.ok(seed, 'seed key must be present in /admin/keys');
    assert.ok(Array.isArray(seed.accessibleModels), 'accessibleModels must be present on the key record');
    assert.deepEqual(
      [...seed.accessibleModels].sort(),
      ['z-ai/glm-5.2', 'meta/llama-4-maverick-17b-128e-instruct', 'deepseek-ai/deepseek-v4-pro'].sort(),
      'validate-update must persist the upstream catalog onto the stored key'
    );
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Test 5: GET /admin/models returns the FULL enriched catalog (NOT filtered by
// disabledModels) with each model annotated by an `enabled` flag. A disabled
// model is present with enabled:false; an enabled model with enabled:true.
// ───────────────────────────────────────────────────────────────────────────
test('GET /admin/models returns the full catalog with an enabled flag (disabled present as enabled:false)', async () => {
  const harness = await startModelsPanelGateway({
    upstreamModelsBody: UPSTREAM_MODELS_BODY,
    disabledModels: ['deepseek-ai/deepseek-v4-pro']
  });
  try {
    const result = await requestAdmin(harness.adminPort, '/admin/models');
    assert.equal(result.statusCode, 200);
    const parsed = JSON.parse(result.body);
    assert.ok(Array.isArray(parsed.data), '/admin/models must return a data array');
    const byId = new Map(parsed.data.map((m) => [m.id, m]));

    // Disabled model is PRESENT (not filtered out) with enabled:false.
    const disabled = byId.get('deepseek-ai/deepseek-v4-pro');
    assert.ok(disabled, 'disabled model must be present in /admin/models (UI needs it to re-enable)');
    assert.equal(disabled.enabled, false);
    assert.equal(typeof disabled.context_length, 'number');
    assert.equal(typeof disabled.max_completion_tokens, 'number');
    assert.ok(disabled.capabilities && typeof disabled.capabilities === 'object');

    // Enabled model present with enabled:true.
    const enabled = byId.get('z-ai/glm-5.2');
    assert.ok(enabled, 'enabled model must be present in /admin/models');
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.capabilities.reasoning.supported, true);

    // The full set is returned (3), not the /v1/models filtered set (2).
    assert.equal(parsed.data.length, 3, '/admin/models returns the FULL catalog, not the disabled-filtered one');
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Test 6: Adding a NEW key via POST /admin/keys triggers validate-on-add,
// populating accessibleModels; GET /admin/keys includes accessibleModels per
// key (the added key carries the upstream catalog; pre-existing keys default
// to []).
// ───────────────────────────────────────────────────────────────────────────
test('POST /admin/keys triggers validate-on-add and GET /admin/keys includes accessibleModels per key', async () => {
  const harness = await startModelsPanelGateway({
    upstreamModelsBody: UPSTREAM_MODELS_BODY,
    disabledModels: [],
    seedKeys: ['seed-presupplied-key-notreal']
  });
  try {
    const newKey = 'added-key-populates-notreal';
    const addRes = await requestAdmin(harness.adminPort, '/admin/keys', 'POST', JSON.stringify({ key: newKey }));
    assert.equal(addRes.statusCode, 201);

    // F2: validate-on-add is fire-and-forget — the 201 returns immediately and
    // accessibleModels populates in the background. Poll /admin/keys until the
    // added key's accessibleModels is populated (the fake upstream responds
    // instantly, so this resolves within a few ms).
    const keyMatch = (k) => k.key.includes(newKey.slice(0, 4)) && k.key.endsWith(newKey.slice(-4));
    const added = await waitFor(async () => {
      const res = await requestAdmin(harness.adminPort, '/admin/keys');
      const parsed = JSON.parse(res.body);
      const k = parsed.keys.find(keyMatch);
      return k && Array.isArray(k.accessibleModels) && k.accessibleModels.length > 0 ? k : null;
    }, 2000);
    assert.ok(added, 'added key must be present with populated accessibleModels');
    assert.ok(Array.isArray(added.accessibleModels), 'added key must have accessibleModels');
    assert.deepEqual(
      [...added.accessibleModels].sort(),
      ['z-ai/glm-5.2', 'meta/llama-4-maverick-17b-128e-instruct', 'deepseek-ai/deepseek-v4-pro'].sort(),
      'validate-on-add must populate accessibleModels from the upstream catalog'
    );

    // Pre-existing seed key (never re-validated) defaults to [].
    const keysRes = await requestAdmin(harness.adminPort, '/admin/keys');
    const keysParsed = JSON.parse(keysRes.body);
    assert.ok(keysParsed.keys.length >= 2, 'seed + added keys present');
    const seed = keysParsed.keys.find((k) => k.key.includes('seed-presupplied-key-notreal'.slice(0, 4)));
    assert.ok(seed, 'seed key must be present');
    assert.deepEqual(seed.accessibleModels, [], 'un-validated existing key defaults accessibleModels to []');
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Test 7: Defensive — a config with NO `disabledModels` field is treated as
// []: /v1/models returns the full upstream set, no crash, no filtering. And a
// chat request to a model is NOT blocked (proceeds to the upstream).
// ───────────────────────────────────────────────────────────────────────────
test('config without disabledModels is treated as [] (no filter, no crash, no block)', async () => {
  const harness = await startModelsPanelGateway({
    upstreamModelsBody: UPSTREAM_MODELS_BODY,
    disabledModels: undefined // write a config with NO disabledModels field
  });
  try {
    const modelsRes = await requestGateway(harness.gatewayPort, '/v1/models');
    assert.equal(modelsRes.statusCode, 200);
    const ids = JSON.parse(modelsRes.body).data.map((m) => m.id);
    assert.equal(ids.length, 3, 'no disabledModels -> entire upstream catalog returned');
    assert.ok(ids.includes('deepseek-ai/deepseek-v4-pro'), 'nothing filtered when disabledModels missing');

    // A chat request for any model proceeds to the upstream (not blocked).
    const body = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: false });
    const chatRes = await requestGateway(harness.gatewayPort, '/v1/chat/completions', 'POST', body);
    assert.equal(chatRes.statusCode, 200, 'chat to a model proceeds when disabledModels is absent');
    assert.ok(harness.upstreamChatHits >= 1, 'upstream chat handler was invoked (no block)');
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Test 8 (edge): disabling a model takes effect on the NEXT request — the
// gateway re-reads config per request, so a config edit (no restart) is picked
// up. The block happens at REQUEST START; an already-streaming response is not
// unwound (documented semantics, exercised here via discrete sequential
// requests, not mid-stream).
// ───────────────────────────────────────────────────────────────────────────
test('disabling a model mid-run is picked up on the next request (per-request config read, no restart)', async () => {
  // Start with NO disabled models.
  const harness = await startModelsPanelGateway({
    upstreamModelsBody: UPSTREAM_MODELS_BODY,
    disabledModels: undefined,
    rewriteConfig: true // expose the config path so we can rewrite it mid-run
  });
  try {
    const targetModel = 'deepseek-ai/deepseek-v4-pro';

    // Request 1: model is enabled -> proceeds to upstream.
    const body = JSON.stringify({ model: targetModel, messages: [{ role: 'user', content: 'hi' }], stream: false });
    const first = await requestGateway(harness.gatewayPort, '/v1/chat/completions', 'POST', body);
    assert.equal(first.statusCode, 200, 'first request: model not yet disabled -> proceeds');
    const hitsBefore = harness.upstreamChatHits;
    assert.ok(hitsBefore >= 1, 'first request reached the upstream');

    // Rewrite the config to DISABLE the model (new file content => size change
    // => the gateway's mtime+size-keyed cache re-reads on the next request).
    harness.setDisabledModels([targetModel]);

    // Request 2: SAME model is now disabled -> 404, NO new upstream call.
    const second = await requestGateway(harness.gatewayPort, '/v1/chat/completions', 'POST', body);
    assert.equal(second.statusCode, 404);
    const parsed = JSON.parse(second.body);
    assert.equal(parsed.error.code, 'model_not_found');
    assert.equal(harness.upstreamChatHits, hitsBefore, 'second request must NOT have reached the upstream (blocked at request start)');

    // /v1/models now reflects the freshly-disabled model too (per-request read).
    const modelsRes = await requestGateway(harness.gatewayPort, '/v1/models');
    const ids = JSON.parse(modelsRes.body).data.map((m) => m.id);
    assert.ok(!ids.includes(targetModel), '/v1/models reflects the config edit without a restart');
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Test 9 (F1): case-insensitive disabled-model matching. Config carries an
// uppercase/mixed-case entry ("DEEPSEEK-AI/Deepseek-v4-pro") while the catalog
// and requests use canonical lowercase ("deepseek-ai/deepseek-v4-pro"). An
// operator typo must NOT silently defeat the disable.
// ───────────────────────────────────────────────────────────────────────────
test('F1: disabled-model matching is case-insensitive (config uppercase, request lowercase still blocked)', async () => {
  const harness = await startModelsPanelGateway({
    upstreamModelsBody: UPSTREAM_MODELS_BODY,
    disabledModels: ['DEEPSEEK-AI/Deepseek-v4-pro'] // uppercase/mixed config typo
  });
  try {
    // /v1/models filters the model out despite the case mismatch.
    const modelsRes = await requestGateway(harness.gatewayPort, '/v1/models');
    assert.equal(modelsRes.statusCode, 200);
    const ids = JSON.parse(modelsRes.body).data.map((m) => m.id);
    assert.ok(!ids.includes('deepseek-ai/deepseek-v4-pro'),
      'a case-mismatched disabled config entry must still filter the model from /v1/models');

    // chat with the canonical lowercase id → 404 (blocked).
    const chatBody = JSON.stringify({ model: 'deepseek-ai/deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] });
    const chatRes = await requestGateway(harness.gatewayPort, '/v1/chat/completions', 'POST', chatBody);
    assert.equal(chatRes.statusCode, 404);
    assert.equal(JSON.parse(chatRes.body).error.code, 'model_not_found');

    // /admin/models shows the model present with enabled:false.
    const adminRes = await requestAdmin(harness.adminPort, '/admin/models');
    assert.equal(adminRes.statusCode, 200);
    const byId = new Map(JSON.parse(adminRes.body).data.map((m) => [m.id, m]));
    assert.equal(byId.get('deepseek-ai/deepseek-v4-pro').enabled, false,
      '/admin/models reflects the case-normalized disabled flag');
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Test 10 (F1 symmetry): config lowercase, request uppercase — still blocked.
// Confirms the lowercase normalization is symmetric (both sides normalized).
// ───────────────────────────────────────────────────────────────────────────
test('F1: case-insensitive disabled-model matching (config lowercase, request uppercase still blocked)', async () => {
  const harness = await startModelsPanelGateway({
    upstreamModelsBody: UPSTREAM_MODELS_BODY,
    disabledModels: ['z-ai/glm-5.2'] // lowercase config
  });
  try {
    // chat with an UPPERCASE model id → still 404, no upstream call.
    const chatBody = JSON.stringify({ model: 'Z-AI/GLM-5.2', messages: [{ role: 'user', content: 'hi' }] });
    const chatRes = await requestGateway(harness.gatewayPort, '/v1/chat/completions', 'POST', chatBody);
    assert.equal(chatRes.statusCode, 404);
    assert.equal(harness.upstreamChatHits, 0, 'no upstream call for a case-variant of a disabled model');

    // /v1/messages (Anthropic) with an uppercase model id → also 404.
    const msgBody = JSON.stringify({ model: 'Z-AI/GLM-5.2', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    const msgRes = await requestGateway(harness.gatewayPort, '/v1/messages', 'POST', msgBody);
    assert.equal(msgRes.statusCode, 404);
    assert.equal(JSON.parse(msgRes.body).error.type, 'not_found_error');
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Test 11 (F2): POST /admin/keys returns 201 WITHOUT waiting for a slow
// validate (fire-and-forget accessibleModels). validate() does a real HTTPS GET
// capped at 10s (validation.mjs) while the production admin-client has a 5s
// socket timeout; the fix makes the add non-blocking. This in-process test
// injects a 300ms-timer validate via the overrides.validateKey hook (which the
// add-key handler already reads) and asserts the 201 returns in <100ms, AND
// that accessibleModels populates in the background after ~400ms.
// ───────────────────────────────────────────────────────────────────────────
test('F2: POST /admin/keys returns 201 without waiting for a slow validate (fire-and-forget accessibleModels)', async () => {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'f2-add-'));
  process.env.GATEWAY_LOG_PATH = path.join(dir, 'g.jsonl');

  // In-process imports: rotation + admin-api + logger. admin-api is cache-busted
  // (query string); its INTERNAL `./rotation.mjs` import resolves to the canonical
  // (no-query) URL, so importing rotation WITHOUT a query string gets the SAME
  // module instance admin-api uses (ESM deduplication by URL). Same for logger.
  const rotation = await import(pathToFileURL(path.join(projectRoot, 'src/gateway/rotation.mjs')).href);
  const adminApi = await import(`${pathToFileURL(path.join(projectRoot, 'src/gateway/admin-api.mjs')).href}?f2=${Date.now()}`);

  rotation.setPersistenceAdapter(() => {});
  rotation.initializeState({ keys: [] });

  const slowValidate = () => new Promise((resolve) => setTimeout(() => resolve({ valid: true, accessibleModels: ['x-model'] }), 300));
  const handler = adminApi.createAdminRequestHandler({ validateKey: slowValidate, adminToken: TEST_ADMIN_TOKEN });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const t0 = Date.now();
    const res = await requestAdmin(port, '/admin/keys', 'POST', JSON.stringify({ key: 'f2-slow-validate-key-notreal' }));
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 201, 'add must succeed immediately');
    assert.ok(elapsed < 100, `add must return without waiting for the 300ms validate (took ${elapsed}ms)`);

    // accessibleModels populates in the background after the slow validate resolves (~300ms).
    const added = await waitFor(
      () => rotation.getKeys().find((k) => Array.isArray(k.accessibleModels) && k.accessibleModels.length > 0),
      1000
    );
    assert.ok(added, 'accessibleModels must eventually populate after the slow validate resolves');
    assert.deepEqual(added.accessibleModels, ['x-model']);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rotation.closeStateWatcher();
    const logger = await import(pathToFileURL(path.join(projectRoot, 'src/gateway/logger.mjs')).href);
    logger.closeLogger?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 2: POST /admin/models/refresh — admin-only re-discovery on the ADMIN
// port (port+1). The main process talks to the gateway via HTTP on the admin
// port ONLY (the admin server forwards only /admin/*, so the main-port
// /v1/models/refresh is unreachable from port+1); refresh therefore lives under
// /admin/. Proves: admin-token gated (401), GET rejected (405, route known), and
// it ACTUALLY re-discovers — after swapping the upstream catalog, the cached
// /admin/models keeps serving the old catalog until refresh forces a refetch.
// ───────────────────────────────────────────────────────────────────────────
test('POST /admin/models/refresh forces re-discovery on the admin port and is admin-token gated', async () => {
  const catalogA = UPSTREAM_MODELS_BODY;
  const catalogB = JSON.stringify({ object: 'list', data: [
    { id: 'z-ai/glm-5.2', object: 'model', owned_by: 'z-ai' },
    { id: 'qwen/qwen3.5-397b-a17b', object: 'model', owned_by: 'qwen' }
  ] });
  const harness = await startModelsPanelGateway({ upstreamModelsBody: catalogA, disabledModels: [] });
  try {
    const admin = harness.adminPort;

    // GET is not registered (405, not 404) — proves the route is classified.
    const getRes = await requestAdmin(admin, '/admin/models/refresh', 'GET');
    assert.equal(getRes.statusCode, 405, 'GET /admin/models/refresh must be 405 (only POST registered)');

    // Unauthenticated refresh is rejected before any upstream call.
    const unauthRes = await httpRequest(admin, '/admin/models/refresh', 'POST', '', {});
    assert.equal(unauthRes.statusCode, 401, 'POST /admin/models/refresh without a token must 401');

    // Cache warm with catalog A (the lazily-fetching /admin/models does the fetch).
    const firstRes = await requestAdmin(admin, '/admin/models');
    assert.equal(firstRes.statusCode, 200);
    const firstIds = JSON.parse(firstRes.body).data.map((m) => m.id).sort();
    assert.deepEqual(firstIds, ['deepseek-ai/deepseek-v4-pro', 'meta/llama-4-maverick-17b-128e-instruct', 'z-ai/glm-5.2']);

    // Swap the upstream catalog. Cached /admin/models must still serve A (stale).
    harness.setUpstreamModelsBody(catalogB);
    const staleRes = await requestAdmin(admin, '/admin/models');
    const staleIds = JSON.parse(staleRes.body).data.map((m) => m.id).sort();
    assert.deepEqual(staleIds, firstIds, 'cached /admin/models must still serve A after the upstream swap');

    // Refresh forces a fresh fetch -> B. Returns { data, cached: false } with B's ids.
    const refreshRes = await requestAdmin(admin, '/admin/models/refresh', 'POST', '');
    assert.equal(refreshRes.statusCode, 200, 'refresh must succeed');
    const refreshParsed = JSON.parse(refreshRes.body);
    assert.equal(refreshParsed.cached, false, 'refresh must report cached:false');
    const refreshIds = refreshParsed.data.map((m) => m.id).sort();
    assert.deepEqual(refreshIds, ['qwen/qwen3.5-397b-a17b', 'z-ai/glm-5.2'], 'refresh must return the freshly fetched catalog B');

    // After refresh, /admin/models serves the enriched B (proves the cache updated).
    const afterRes = await requestAdmin(admin, '/admin/models');
    const afterIds = JSON.parse(afterRes.body).data.map((m) => m.id).sort();
    assert.deepEqual(afterIds, ['qwen/qwen3.5-397b-a17b', 'z-ai/glm-5.2'], '/admin/models must reflect the refreshed catalog B');
    const glm = JSON.parse(afterRes.body).data.find((m) => m.id === 'z-ai/glm-5.2');
    assert.equal(typeof glm.context_length, 'number', 'enrichment still applies post-refresh');
    assert.ok(glm.capabilities && typeof glm.capabilities === 'object');
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 5 backend review (MAJOR #2): hermetic POST /admin/catalog/sync tests.
// Mirrors the POST /admin/models/refresh test functionally but runs the admin
// handler IN-PROCESS (no spawned gateway child) so tests can intercept NGC
// HTTPS via the catalog module's __setFetcherForTests__ seam (the same seam
// tests/nvidia-catalog-sync.test.mjs uses).
//
// Module-instance invariant: the canonical `nvidia-catalog-sync.mjs` import URL
// (no query) is SHARED between (a) the test process via the top-level
// `catalogSync` import below and (b) any freshly-imported admin-api cache-buster
// instance — ESM dedupes transitive relative imports to the canonical URL, so
// `__setFetcherForTests__` set here affects the admin handler's refreshCatalog.
// ───────────────────────────────────────────────────────────────────────────

const catalogSyncUrl = pathToFileURL(path.join(projectRoot, 'src/gateway/nvidia-catalog-sync.mjs')).href;
const catalogSync = await import(catalogSyncUrl);

/**
 * Build a small NGC search response (mirrors tests/nvidia-catalog-sync.test.mjs::searchBody).
 * @param {Array<{ name: string; publisher?: string; displayName: string; labels?: string[] }>} items
 */
function catalogSearchBody(items) {
  return {
    resultTotal: items.length,
    resources: items.map((it) => ({
      artifact: {
        name: it.name,
        publisher: it.publisher || 'z-ai',
        displayName: it.displayName,
        labels: it.labels || []
      }
    }))
  };
}

/** Build a minimal NGC detail response (only the fields recordToMetadata reads). */
function catalogDetailBody(spec) {
  return {
    artifact: {
      name: spec.name,
      publisher: spec.publisher || 'z-ai',
      displayName: spec.displayName,
      shortDescription: spec.shortDescription || '',
      labels: spec.labels || [],
      attributes: [
        { key: 'AVAILABLE', value: 'true' },
        { key: 'lastMonthApiInvocationCount', value: String(spec.invocations ?? 0) }
      ],
      logo: 'https://assets.ngc.nvidia.com/products/api-catalog/images/' + spec.name + '.jpg',
      isPublic: true,
      canGuestDownload: true,
      updatedDate: spec.updatedDate || '2026-08-01T00:00:00Z'
    }
  };
}

/** Mock fetcher serving BOTH search + detail endpoints for a single canned model. */
function happyCatalogFetcher() {
  return async (urlPath) => {
    if (urlPath.startsWith('/v2/search/catalog/resources/ENDPOINT')) {
      return catalogSearchBody([
        { name: 'z-ai/glm-5.2', publisher: 'z-ai', displayName: 'glm-5.2', labels: ['Reasoning'] }
      ]);
    }
    if (urlPath.startsWith('/v2/endpoints/qc69jvmznzxy/')) {
      return catalogDetailBody({
        name: 'z-ai/glm-5.2',
        publisher: 'z-ai',
        displayName: 'glm-5.2',
        shortDescription: 'GLM 5.2 chat model',
        labels: ['Reasoning'],
        invocations: 12345
      });
    }
    throw new Error(`happy fetcher: unexpected URL ${urlPath}`);
  };
}

/** Mock fetcher that simulates NGC being unreachable — every call throws. */
function failingCatalogFetcher() {
  return async () => {
    throw new Error('simulated NGC outage (ECONNREFUSED)');
  };
}

/**
 * Boot an in-process admin HTTP server (no spawned gateway child) backed by a
 * freshly-imported admin-api module instance. The admin-api instance shares the
 * canonical `nvidia-catalog-sync.mjs` instance the tests control via
 * __setFetcherForTests__ (per the ESM-dedup invariant above).
 */
async function startCatalogSyncAdminServer() {
  const dir = fs.mkdtempSync(path.join(tempRoot, `catalog-sync-${Date.now()}-`));
  process.env.GATEWAY_LOG_PATH = path.join(dir, 'g.jsonl');
  const rotation = await import(pathToFileURL(path.join(projectRoot, 'src/gateway/rotation.mjs')).href);
  const adminApi = await import(
    `${pathToFileURL(path.join(projectRoot, 'src/gateway/admin-api.mjs')).href}?sync=${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  rotation.setPersistenceAdapter(() => {});
  rotation.initializeState({ keys: [] });
  const handler = adminApi.createAdminRequestHandler({ adminToken: TEST_ADMIN_TOKEN });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    rotation,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      rotation.closeStateWatcher();
      const logger = await import(pathToFileURL(path.join(projectRoot, 'src/gateway/logger.mjs')).href);
      logger.closeLogger?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 5 Fix Test 1: 401 unauthorized — POST without the admin token MUST be
// rejected before the sync handler runs (mirrors the unauth assertion in the
// POST /admin/models/refresh test).
// ───────────────────────────────────────────────────────────────────────────
test('Phase 5 POST /admin/catalog/sync rejects unauthenticated requests with 401', async () => {
  catalogSync.resetCatalogCache();
  catalogSync.__setFetcherForTests__(happyCatalogFetcher());
  const harness = await startCatalogSyncAdminServer();
  try {
    // No Authorization header → admin-token denial takes precedence over the sync.
    const res = await httpRequest(harness.port, '/admin/catalog/sync', 'POST', '', {});
    assert.equal(res.statusCode, 401, 'POST without the admin token must 401');
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'Unauthorized', '401 body must carry the Unauthorized error');
  } finally {
    await harness.close();
    catalogSync.__restoreFetcherForTests__();
    catalogSync.resetCatalogCache();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 5 Fix Test 2: 405 method-not-allowed — GET /admin/catalog/sync is a
// classified route (only POST is registered for it) → 405 from the static-route
// guard (admin-api.mjs classifyAdminRequest pathHasAnyAdminMethod).
// ───────────────────────────────────────────────────────────────────────────
test('Phase 5 GET /admin/catalog/sync is 405 (only POST is registered for the route)', async () => {
  catalogSync.resetCatalogCache();
  catalogSync.__setFetcherForTests__(happyCatalogFetcher());
  const harness = await startCatalogSyncAdminServer();
  try {
    const res = await requestAdmin(harness.port, '/admin/catalog/sync', 'GET');
    assert.equal(res.statusCode, 405, 'GET on a POST-only route must 405 (route classified, method wrong)');
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'Method Not Allowed');
  } finally {
    await harness.close();
    catalogSync.__restoreFetcherForTests__();
    catalogSync.resetCatalogCache();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 5 Fix Test 3: 200 happy path — mock NGC returns a small catalog;
// POST → { data: { size }, cached: false, fetchedAt }. Cache state reflects
// the advance: getCatalogCacheInfo().fetchedAt jumps null → now.
// ───────────────────────────────────────────────────────────────────────────
test('Phase 5 POST /admin/catalog/sync returns 200 + cached:false on a happy NGC fetch (timestamp advances null → now)', async () => {
  catalogSync.resetCatalogCache();
  catalogSync.__setFetcherForTests__(happyCatalogFetcher());
  const harness = await startCatalogSyncAdminServer();
  try {
    const before = catalogSync.getCatalogCacheInfo();
    assert.equal(before.fetchedAt, null, 'precondition: cold cache fetchedAt must be null');

    const res = await requestAdmin(harness.port, '/admin/catalog/sync', 'POST', '');
    assert.equal(res.statusCode, 200, 'a successful sync must return 200');
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.cached, false, 'a successful sync reports cached:false');
    assert.ok(parsed.data && typeof parsed.data.size === 'number' && parsed.data.size > 0,
      'happy-path sync must populate data.size with the model count');
    assert.ok(typeof parsed.fetchedAt === 'string' && parsed.fetchedAt.length > 0,
      'a successful sync must expose a fetchedAt ISO string');

    // Verify the cache ACTUALLY advanced (null → now) by reading the module
    // state directly. GET /admin/models would route through a SEPARATE
    // model-discovery cache (which would need its own local-upstream mock to
    // be hermetic); the getCatalogCacheInfo() probe is the cleaner hermetic
    // confirmation the catalog cache was refreshed.
    const after = catalogSync.getCatalogCacheInfo();
    assert.ok(after.fetchedAt !== null && after.fetchedAt > 0, 'cache fetchedAt must advance after the sync');
    assert.notEqual(after.fetchedAt, before.fetchedAt, 'fetchedAt must DIFFER post-sync (null → now)');
    assert.ok(after.size > 0, 'cache size must be > 0 after the successful populate');
    // The timestamp ISO in the response body must round-trip to the canonical
    // cache fetchedAt epoch ms — proves the handler serialized the module state,
    // not a stringified-else value.
    assert.equal(new Date(parsed.fetchedAt).getTime(), after.fetchedAt,
      'the response fetchedAt ISO must round-trip to the module-level fetchedAt epoch ms');
  } finally {
    await harness.close();
    catalogSync.__restoreFetcherForTests__();
    catalogSync.resetCatalogCache();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 5 Fix Test 4: 503 with a PRIOR cache — pre-populate the cache with a
// happy fetch, then swap to a failing fetcher; POST → 503 + cached:true and
// the cache state is UNCHANGED (fetchedAt did not advance; stale map kept).
// ───────────────────────────────────────────────────────────────────────────
test('Phase 5 POST /admin/catalog/sync returns 503 + cached:true when NGC fails AFTER a prior warm cache (stale cache preserved, no advance)', async () => {
  catalogSync.resetCatalogCache();

  // 1) Pre-populate the cache with a successful refresh.
  catalogSync.__setFetcherForTests__(happyCatalogFetcher());
  await catalogSync.refreshCatalog();
  const before = catalogSync.getCatalogCacheInfo();
  assert.ok(before.fetchedAt !== null && before.fetchedAt > 0, 'precondition: cache must have a fetchedAt');
  assert.ok(before.size > 0, 'precondition: cache must have entries');

  // 2) Swap to a failing fetcher (simulated NGC outage) and trigger the
  //    admin-endpoint sync — it MUST surface 503 (NOT 200) because the
  //    comparison getCatalogCacheInfo() before-vs-after fetchedAt is UNCHANGED.
  catalogSync.__setFetcherForTests__(failingCatalogFetcher());
  const harness = await startCatalogSyncAdminServer();
  try {
    const res = await requestAdmin(harness.port, '/admin/catalog/sync', 'POST', '');
    assert.equal(res.statusCode, 503, 'a sync that fails to advance the cache MUST surface 503 (not 200)');
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.cached, true, 'failed-sync body must report cached:true');
    assert.equal(parsed.error, 'Sync failed: NGC unreachable, stale cache served');
    assert.equal(parsed.size, before.size, '503 body must echo the (stale) cache size so clients degrade gracefully');
    assert.ok(typeof parsed.fetchedAt === 'string' && parsed.fetchedAt.length > 0,
      '503 body must include a fetchedAt ISO so clients can show the stale timestamp');
    assert.equal(new Date(parsed.fetchedAt).getTime(), before.fetchedAt,
      '503 body fetchedAt ISO must match the PRE-SYNC (stale) cache timestamp');

    // Cache MUST NOT advance on a failed sync — the cache global stays at the
    // prior warm value because refreshCatalog's catch returned stale.byId.
    const after = catalogSync.getCatalogCacheInfo();
    assert.equal(after.fetchedAt, before.fetchedAt, 'the cache MUST NOT advance on a failed sync');
    assert.equal(after.size, before.size, 'the stale cache size MUST be preserved');
  } finally {
    await harness.close();
    catalogSync.__restoreFetcherForTests__();
    catalogSync.resetCatalogCache();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 5 Fix Test 5: 503 cold-start failure — the FIRST-EVER fetch when NGC
// is unreachable MUST also be a 503 (fetchedAt stays null, size stays 0). This
// is the critical edge case the timestamp-comparison handles: null === null →
// the sync did NOT advance, so we surface it rather than claim 200 ("lying").
// ───────────────────────────────────────────────────────────────────────────
test('Phase 5 POST /admin/catalog/sync returns 503 on a COLD-START NGC failure (fetchedAt stays null, size stays 0)', async () => {
  catalogSync.resetCatalogCache();
  catalogSync.__setFetcherForTests__(failingCatalogFetcher());
  const harness = await startCatalogSyncAdminServer();
  try {
    const before = catalogSync.getCatalogCacheInfo();
    assert.equal(before.fetchedAt, null, 'precondition: cold cache fetchedAt must be null');
    assert.equal(before.size, 0, 'precondition: cold cache must be empty');

    const res = await requestAdmin(harness.port, '/admin/catalog/sync', 'POST', '');
    assert.equal(res.statusCode, 503, 'cold-start NGC failure must surface 503 (NOT 200 → would be lying)');
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.cached, true, 'cold-start failure must still report cached:true');
    assert.equal(parsed.error, 'Sync failed: NGC unreachable, stale cache served');
    assert.equal(parsed.size, 0, 'cold-start failure body size must be 0 (no records fetched)');
    assert.equal(parsed.fetchedAt, null,
      'cold-start failure body fetchedAt must be null (no timestamp to ISO-convert)');

    const after = catalogSync.getCatalogCacheInfo();
    assert.equal(after.fetchedAt, null, 'the cache MUST remain cold on a failed first fetch (no fetchedAt set)');
    assert.equal(after.size, 0, 'size MUST remain 0 on a failed first fetch');
  } finally {
    await harness.close();
    catalogSync.__restoreFetcherForTests__();
    catalogSync.resetCatalogCache();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Harness — mirrors tests/model-enrichment.test.mjs conventions, extended with
// an admin port + a writable temp config + upstream chat-hit tracking.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Spin up a fake upstream (GET /v1/models + POST /v1/chat/completions) plus a
 * real gateway child pointed at a temp config carrying `disabledModels`.
 *
 * @param {{ upstreamModelsBody: string, disabledModels?: string[] | undefined, seedKeys?: string[], rewriteConfig?: boolean }} opts
 * @returns {Promise<{ gatewayPort: number, adminPort: number, upstreamChatHits: number, setDisabledModels: (ids: string[]) => void, close: () => Promise<void> }>}
 */
async function startModelsPanelGateway({ upstreamModelsBody, disabledModels, seedKeys, rewriteConfig }) {
  const upstreamChatHits = { count: 0 };
  // Mutable upstream catalog so the Phase-2 POST /admin/models/refresh test can
  // prove re-discovery by swapping the catalog between cache-warm and refresh.
  let currentModelsBody = upstreamModelsBody;

  const upstream = await createLocalUpstream((req, res) => {
    if (req.url === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'identity' });
      res.end(currentModelsBody);
    } else if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      upstreamChatHits.count += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });

  let child;
  let gatewayPort;
  let configPath;
  let statePath;
  let logPath;
  let ready = false;

  for (let startAttempt = 0; startAttempt < 3 && !ready; startAttempt++) {
    gatewayPort = await freeGatewayPort();
    const gatewayDir = path.join(tempRoot, `gateway-${gatewayPort}-${startAttempt}`);
    statePath = path.join(gatewayDir, 'keys.json');
    logPath = path.join(gatewayDir, 'gateway.jsonl');
    configPath = path.join(gatewayDir, 'config.json');
    fs.mkdirSync(gatewayDir, { recursive: true });

    // Temp config: deterministic inline modelLimits (enrichment parity with the
    // shipped example config) plus disabledModels (omitted entirely when
    // `disabledModels` is undefined — exercises the defensive [] path).
    const tempConfig = { modelLimits: MODEL_LIMITS };
    if (disabledModels !== undefined) tempConfig.disabledModels = disabledModels;
    fs.writeFileSync(configPath, JSON.stringify(tempConfig));

    const seed = (seedKeys && seedKeys.length > 0 ? seedKeys : ['local-test-key-notreal']).map((key, i) => ({
      id: `seed-${i}`,
      key,
      status: 'active',
      backoffUntil: 0,
      usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }
    }));
    fs.writeFileSync(statePath, JSON.stringify({ keys: seed }));

    child = spawn(process.execPath, [
      '--require', localUpstreamPreloadPath,
      path.join(projectRoot, 'src', 'gateway', 'server.mjs')
    ], {
      env: {
        ...process.env,
        PORT: String(gatewayPort),
        GATEWAY_LOG_PATH: logPath,
        GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstream.address().port),
        GATEWAY_CONFIG_PATH: configPath,
        GATEWAY_FIRST_BYTE_TIMEOUT_MS: '300000',
        GATEWAY_IDLE_TIMEOUT_MS: '300000'
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true
    });

    child.once('message', (message) => {
      if (message?.type === 'ready') {
        child.send({
          type: 'state:init',
          challenge: message.challenge,
          state: {
            keys: JSON.parse(fs.readFileSync(statePath, 'utf8')).keys,
            credentials: { gatewayToken: TEST_GATEWAY_TOKEN, adminToken: TEST_ADMIN_TOKEN }
          }
        });
      }
    });
    child.on('message', (message) => {
      if (message?.type === 'state:persist') fs.writeFileSync(statePath, JSON.stringify(message.state));
    });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        if (await getHealth(gatewayPort) === 200) { ready = true; break; }
      } catch {
        // child may still be starting
      }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!ready) {
      await stopGateway(child);
    }
  }

  if (!ready) {
    await closeServer(upstream);
    throw new Error(`Gateway did not become healthy on port ${gatewayPort}.`);
  }

  return {
    gatewayPort,
    adminPort: gatewayPort + 1,
    get upstreamChatHits() { return upstreamChatHits.count; },
    setDisabledModels(ids) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg.disabledModels = ids;
      fs.writeFileSync(configPath, JSON.stringify(cfg));
    },
    setUpstreamModelsBody(body) { currentModelsBody = body; },
    close: async () => {
      await stopGateway(child);
      await closeServer(upstream);
    }
  };
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((conn) => { conn.resume(); });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

async function freeGatewayPort() {
  const probe = await listen(0);
  const port = probe.address().port;
  await close(probe);
  if (port >= 65534) return freeGatewayPort();
  const adminProbe = await listen(port + 1).catch(() => null);
  if (!adminProbe) return freeGatewayPort();
  await close(adminProbe);
  return port;
}

function getHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/health' }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.setTimeout(2_000, () => request.destroy(new Error('Health request timed out.')));
  });
}

function requestGateway(port, requestPath, method = 'GET', body = '', headers = {}, timeoutMs = 10_000) {
  return httpRequest(port, requestPath, method, body, { authorization: `Bearer ${TEST_GATEWAY_TOKEN}`, ...headers }, timeoutMs);
}

function requestAdmin(port, requestPath, method = 'GET', body = '', headers = {}, timeoutMs = 10_000) {
  return httpRequest(port, requestPath, method, body, { authorization: `Bearer ${TEST_ADMIN_TOKEN}`, ...headers }, timeoutMs);
}

function httpRequest(port, requestPath, method, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (body) {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['content-length'] = Buffer.byteLength(body);
    }
    const request = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers: requestHeaders }, (response) => {
      const chunks = [];
      const deadline = setTimeout(() => response.destroy(new Error('Gateway request timed out.')), timeoutMs);
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        clearTimeout(deadline);
        resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() });
      });
      response.once('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

function createLocalUpstream(handler) {
  return new Promise((resolve, reject) => {
    const upstream = http.createServer(handler);
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', () => resolve(upstream));
  });
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function stopGateway(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill();
  });
}

// Poll a predicate until it returns truthy or the timeout elapses. Used by the
// F2 non-blocking test to wait for the background validate to populate
// accessibleModels without a fixed sleep. Supports both sync and async
// predicates (await is a no-op on non-Promise values).
async function waitFor(predicate, timeoutMs, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}
