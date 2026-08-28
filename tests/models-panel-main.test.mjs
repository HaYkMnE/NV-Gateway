// @ts-check
/**
 * Phase 2 main-process tests for the Models panel.
 *
 * Part A — 4 IPC handlers (src/main/models-ipc.ts → registered in index.ts):
 *   1. get-models maps GET /admin/models -> ModelConfig[]
 *   2. get-models gateway-down -> unavailable ENVELOPE (preload invokeAdmin
 *      reconstructs error.name bridge-safe for GATEWAY_NOT_RUNNING)
 *   3. refresh-models calls POST /admin/models/refresh then GET /admin/models
 *   4. update-model-settings writes mode into perModelSettings (config.json)
 *   5. update-model-settings enabled:false/true toggles disabledModels (lowercased)
 *   6. toggle-model round-trips into/out of disabledModels
 *   7. atomic write: writeAppConfig throwing leaves config.json unchanged
 *
 * Part B — durable accessibleModels (state-ownership.ts + rotation.mjs):
 *   8. 6-field projection (incl accessibleModels) accepted; mergeChildKeyProjection
 *      persists it; a simulated restart (normalize) restores it; 5-field legacy
 *      still accepted; malformed/foreign-field 6-field rejected.
 *
 * The harness follows tests/admin-ipc.test.mjs / final-migration.test.mjs: import
 * compiled main modules from build/src/main/*.js, fake the admin `dispatch` (which
 * fakes requestAdmin over the admin port), and use a temp config.json + the real
 * readAppConfig/writeAppConfig from build. The durable round-trip (test 8) drives
 * the real rotation.mjs saveState() + the real isChildKeyProjection/merge.
 *
 * Part C (surfacing accessibleModels to the renderer via /admin/keys) needs NO
 * new main-side code: admin-api.mjs /admin/keys spreads the key record, which
 * already carries accessibleModels (asserted by models-panel-gateway.test.mjs
 * tests 4 & 5). Those existing tests double as the Part C regression guard.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-models-main-'));
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

// Rotation tests need a log path; share a temp dir per rotation-touching test.
function makeRotationDir() {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'rot-'));
  process.env.GATEWAY_LOG_PATH = path.join(dir, 'gateway.jsonl');
  return dir;
}

const UUID = '550e8400-e29b-41d4-a716-446655440000';
function keyRecord5(key = 'fake-nvidia-key-notreal', id = UUID) {
  return { id, key, status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 } };
}

function baselineConfig(overrides = {}) {
  return {
    version: 1,
    gatewayPort: 12000,
    language: 'en',
    setupComplete: true,
    performanceMode: 'day',
    modelLimits: {
      '*': { context: 131072, output: 4096 },
      'z-ai/glm-5.2': { context: 202752, output: 131072 }
    },
    perModelSettings: {
      'stepfun-ai/step-3.7-flash': { enabled: true, performanceMode: 'day' }
    },
    disabledModels: ['deepseek-ai/deepseek-v4-pro'],
    ...overrides
  };
}

function newConfigFile(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'cfg-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(baselineConfig(overrides), null, 2));
  return configPath;
}

function readRaw(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// Build the handlers under test with a fake admin dispatch + real readAppConfig
// /writeAppConfig (gateway-runtime) over a temp config.
async function makeHandlers(configPath, dispatch, protect = () => {}) {
  const { createModelsHandlers } = await import(built('models-ipc.js'));
  const { writeAppConfig } = await import(built('gateway-runtime.js'));
  return createModelsHandlers({
    dispatch,
    getConfigPath: () => configPath,
    writeAppConfig,
    protectFile: protect
  });
}

// ---------------------------------------------------------------------------
// Part A.1: get-models mapping
// ---------------------------------------------------------------------------
test('get-models maps /admin/models -> ModelConfig[] (enabled from endpoint, mode from perModelSettings, name=id, deprecated=false)', async () => {
  const configPath = newConfigFile({
    perModelSettings: {
      'stepfun-ai/step-3.7-flash': { enabled: true, performanceMode: 'day' },
      'z-ai/glm-5.2': { enabled: true, performanceMode: 'night' }
    },
    disabledModels: ['deepseek-ai/deepseek-v4-pro']
  });
  const catalog = {
    data: [
      { id: 'z-ai/glm-5.2', context_length: 202752, max_completion_tokens: 131072, capabilities: { tools: true }, enabled: true },
      { id: 'meta/llama-4-maverick-17b-128e-instruct', context_length: 128000, max_completion_tokens: 4096, capabilities: {}, enabled: true },
      { id: 'deepseek-ai/deepseek-v4-pro', context_length: 1048576, max_completion_tokens: 393216, capabilities: {}, enabled: false }
    ]
  };
  const dispatch = async () => catalog;
  const handlers = await makeHandlers(configPath, dispatch);

  const result = await handlers.getModels();

  assert.ok(Array.isArray(result.models));
  assert.equal(result.models.length, 3);

  const byId = new Map(result.models.map((m) => [m.id, m]));
  const glm = byId.get('z-ai/glm-5.2');
  assert.equal(glm.name, 'z-ai/glm-5.2', 'name must equal id (no display-name source today)');
  assert.equal(glm.enabled, true, 'enabled mirrors the endpoint flag');
  assert.equal(glm.mode, 'night', 'mode comes from perModelSettings[id].performanceMode');
  assert.equal(glm.deprecated, false, 'deprecated defaults to false (no reliable source)');

  const llama = byId.get('meta/llama-4-maverick-17b-128e-instruct');
  assert.equal(llama.mode, 'auto', 'model with no perModelSettings entry falls back to auto');
  assert.equal(llama.enabled, true);

  const disabled = byId.get('deepseek-ai/deepseek-v4-pro');
  assert.equal(disabled.enabled, false, 'endpoint reports the disabled model with enabled:false');
  assert.equal(disabled.mode, 'auto');
});

// ---------------------------------------------------------------------------
// Part A.2: get-models gateway-down -> unavailable ENVELOPE (preload invokeAdmin
// reconstructs error.name in the renderer for bridge-safe fidelity)
// ---------------------------------------------------------------------------
test('get-models returns the GATEWAY_NOT_RUNNING envelope (not a throw) so the preload can reconstruct error.name bridge-safe', async () => {
  const configPath = newConfigFile();
  const envelope = { ok: false, error: { code: 'GATEWAY_NOT_RUNNING', message: 'Gateway is not running.' } };
  const dispatch = async () => envelope;
  const handlers = await makeHandlers(configPath, dispatch);

  const result = await handlers.getModels();
  assert.ok(result && typeof result === 'object', 'result must be a resolved object, not a thrown error');
  assert.equal(result.ok, false, 'envelope shape: ok=false');
  assert.equal(result.error?.code, 'GATEWAY_NOT_RUNNING', 'envelope shape: error.code preserved (preload reconstructs .name from this)');
  assert.equal(result.error?.message, 'Gateway is not running.', 'envelope shape: error.message preserved (preload surfaces as error.message)');
});

test('get-models falls back to config/default models gracefully when admin dispatch throws a timeout', async () => {
  const configPath = newConfigFile({
    perModelSettings: {
      'z-ai/glm-5.2': { enabled: true, performanceMode: 'night' }
    },
    disabledModels: ['deepseek-ai/deepseek-v4-flash']
  });
  const dispatch = async () => {
    throw new Error('Admin operation timed out.');
  };
  const handlers = await makeHandlers(configPath, dispatch);

  const result = await handlers.getModels();
  assert.ok(result && typeof result === 'object', 'result must resolve, not throw');
  assert.ok(Array.isArray(result.models), 'models array must be returned');
  assert.ok(result.models.length > 0, 'fallback models must be non-empty');
  const glm = result.models.find((m) => m.id === 'z-ai/glm-5.2');
  assert.ok(glm, 'z-ai/glm-5.2 should be present in fallback list');
  assert.equal(glm.mode, 'night', 'perModelSettings should be respected in fallback list');
  const disabled = result.models.find((m) => m.id === 'deepseek-ai/deepseek-v4-flash');
  assert.ok(disabled, 'deepseek-ai/deepseek-v4-flash should be present');
  assert.equal(disabled.enabled, false, 'disabledModels should be respected in fallback list');
});

// ---------------------------------------------------------------------------
// Part A.3: refresh-models calls POST refresh then GET /admin/models
// ---------------------------------------------------------------------------
test('refresh-models triggers POST /admin/models/refresh then re-fetches GET /admin/models and maps the result', async () => {
  const configPath = newConfigFile({ disabledModels: [] });
  const calls = [];
  const dispatch = async (request) => {
    calls.push({ method: request.method, path: request.path });
    if (request.method === 'POST' && request.path === '/admin/models/refresh') {
      return { data: [{ id: 'z-ai/glm-5.2' }, { id: 'qwen/qwen3.5-397b-a17b' }], cached: false };
    }
    if (request.method === 'GET' && request.path === '/admin/models') {
      return {
        data: [
          { id: 'z-ai/glm-5.2', context_length: 202752, max_completion_tokens: 131072, capabilities: {}, enabled: true },
          { id: 'qwen/qwen3.5-397b-a17b', context_length: 262144, max_completion_tokens: 8192, capabilities: {}, enabled: true }
        ]
      };
    }
    throw new Error(`unexpected dispatch ${request.method} ${request.path}`);
  };
  const handlers = await makeHandlers(configPath, dispatch);

  const result = await handlers.refreshModels();

  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ['POST /admin/models/refresh', 'GET /admin/models'],
    'refresh-models must POST the refresh trigger before re-fetching the enriched catalog'
  );
  assert.deepEqual(
    result.models.map((m) => ({ id: m.id, enabled: m.enabled, mode: m.mode })),
    [
      { id: 'z-ai/glm-5.2', enabled: true, mode: 'auto' },
      { id: 'qwen/qwen3.5-397b-a17b', enabled: true, mode: 'auto' }
    ],
    'refresh-models must map the re-fetched /admin/models (enriched + enabled flags) to ModelConfig[]'
  );
});

test('refresh-models surfaces gateway-down (on the refresh call) as the GATEWAY_NOT_RUNNING envelope (not a throw)', async () => {
  const configPath = newConfigFile();
  const dispatch = async (request) => {
    if (request.method === 'POST' && request.path === '/admin/models/refresh') {
      return { ok: false, error: { code: 'GATEWAY_NOT_RUNNING', message: 'Gateway is not running.' } };
    }
    throw new Error('must not reach /admin/models while gateway is down');
  };
  const handlers = await makeHandlers(configPath, dispatch);

  const result = await handlers.refreshModels();
  assert.ok(result && typeof result === 'object', 'result must be a resolved object, not a thrown error');
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'GATEWAY_NOT_RUNNING', 'envelope (from the POST dispatch) preserved for preload .name reconstruction');
  assert.equal(result.error?.message, 'Gateway is not running.');
});

test('refresh-models returns the GATEWAY_NOT_RUNNING envelope when the POST refresh succeeds but the GET /admin/models reports gateway-down', async () => {
  const configPath = newConfigFile({ disabledModels: [] });
  const dispatch = async (request) => {
    if (request.method === 'POST' && request.path === '/admin/models/refresh') {
      return { data: [{ id: 'z-ai/glm-5.2' }], cached: false };
    }
    if (request.method === 'GET' && request.path === '/admin/models') {
      return { ok: false, error: { code: 'GATEWAY_NOT_RUNNING', message: 'Gateway is not running.' } };
    }
    throw new Error(`unexpected dispatch ${request.method} ${request.path}`);
  };
  const handlers = await makeHandlers(configPath, dispatch);

  const result = await handlers.refreshModels();
  assert.ok(result && typeof result === 'object', 'must resolve the envelope, not throw');
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'GATEWAY_NOT_RUNNING',
    'the GET-path envelope return (after a successful POST refresh) must be preserved for the preload invokeAdmin .name reconstruction');
  assert.equal(result.error?.message, 'Gateway is not running.');
});

test('refresh-models treats a POST refresh timeout as NON-FATAL: swallows it and still proceeds to GET /admin/models (server-side cache updates async; GET returns it)', async () => {
  const configPath = newConfigFile({ disabledModels: [] });
  const calls = [];
  const dispatch = async (request) => {
    calls.push(`${request.method} ${request.path}`);
    if (request.method === 'POST' && request.path === '/admin/models/refresh') {
      // Simulate the admin-client.ts:7 5s socket timeout surfacing as a thrown
      // Error while the gateway's 30s refreshModels() keeps running server-side.
      throw new Error('Admin operation timed out.');
    }
    if (request.method === 'GET' && request.path === '/admin/models') {
      return {
        data: [
          { id: 'z-ai/glm-5.2', context_length: 202752, max_completion_tokens: 131072, capabilities: {}, enabled: true },
          { id: 'qwen/qwen3.5-397b-a17b', context_length: 262144, max_completion_tokens: 8192, capabilities: {}, enabled: true }
        ]
      };
    }
    throw new Error(`unexpected dispatch ${request.method} ${request.path}`);
  };
  const handlers = await makeHandlers(configPath, dispatch);

  // Must NOT propagate the POST timeout — it proceeds to GET and returns models.
  const result = await handlers.refreshModels();

  assert.deepEqual(
    calls,
    ['POST /admin/models/refresh', 'GET /admin/models'],
    'refresh-models must still issue the GET after the POST refresh timed out'
  );
  assert.ok(Array.isArray(result.models) && result.models.length === 2,
    'must return the re-fetched catalog (not throw) when the POST refresh times out');
  assert.equal(result.models[0].id, 'z-ai/glm-5.2');
  assert.equal(result.models[0].enabled, true);
  assert.equal(result.models[0].mode, 'auto');
});

test('refresh-models falls back to config/default models gracefully when both POST and GET dispatch throw a timeout', async () => {
  const configPath = newConfigFile({
    perModelSettings: {
      'z-ai/glm-5.2': { enabled: true, performanceMode: 'night' }
    }
  });
  const dispatch = async () => {
    throw new Error('Admin operation timed out.');
  };
  const handlers = await makeHandlers(configPath, dispatch);

  const result = await handlers.refreshModels();
  assert.ok(result && typeof result === 'object', 'result must resolve, not throw');
  assert.ok(Array.isArray(result.models), 'models array must be returned');
  assert.ok(result.models.length > 0, 'fallback models must be non-empty');
  const glm = result.models.find((m) => m.id === 'z-ai/glm-5.2');
  assert.ok(glm, 'z-ai/glm-5.2 should be present in fallback list');
  assert.equal(glm.mode, 'night', 'perModelSettings should be respected in fallback list');
});

// ---------------------------------------------------------------------------
// Part A.4: update-model-settings persisting mode into perModelSettings
// ---------------------------------------------------------------------------
test('update-model-settings writes mode into perModelSettings[id].performanceMode in config.json and preserves modelLimits', async () => {
  const configPath = newConfigFile({ disabledModels: [] });
  const handlers = await makeHandlers(configPath, async () => ({}));

  const returned = await handlers.updateModelSettings('z-ai/glm-5.2', { mode: 'night' });

  assert.deepEqual(returned, { id: 'z-ai/glm-5.2', name: 'z-ai/glm-5.2', enabled: true, mode: 'night', deprecated: false });

  const onDisk = readRaw(configPath);
  assert.equal(onDisk.perModelSettings['z-ai/glm-5.2'].performanceMode, 'night', 'mode persisted on the per-model entry');
  assert.ok(onDisk.perModelSettings['z-ai/glm-5.2'].enabled, 'a newly created entry gets a sensible enabled default');
  // Unrelated config is untouched (the writer is a partial-merger preserving raw fields).
  assert.deepEqual(onDisk.modelLimits, baselineConfig().modelLimits, 'modelLimits must be preserved by the atomic partial write');
  assert.deepEqual(onDisk.disabledModels, [], 'disabledModels must be unchanged when only mode is supplied');
  assert.equal(onDisk.performanceMode, 'day', 'global performanceMode must be unchanged');
});

test('update-model-settings lowercases the perModelSettings key on WRITE so a mixed-case id round-trips with the lowercased endpoint id (no silent mode revert to auto)', async () => {
  const configPath = newConfigFile({ disabledModels: [] });
  const handlers = await makeHandlers(configPath, async () => ({}));

  // Renderer sends a MIXED-CASE id (e.g. typed by the user); the model id at the
  // endpoint is lowercase `z-ai/glm-5.2`. If perModelSettings were keyed on the
  // original-case id, the later mapModelCatalog read (by the lowercase endpoint
  // id) would fail to find the entry and silently revert mode to 'auto'.
  const returned = await handlers.updateModelSettings('Z-AI/GLM-5.2', { mode: 'night' });
  assert.equal(returned.mode, 'night', 'deriveModelConfig must read the lowercased key and report the mode');
  assert.equal(returned.id, 'Z-AI/GLM-5.2', 'returned id preserves the original case passed in');

  const onDisk = readRaw(configPath);
  assert.equal(onDisk.perModelSettings['z-ai/glm-5.2'].performanceMode, 'night',
    'perModelSettings MUST be keyed on the lowercased id (symmetric with disabledModels)');
  assert.ok(!('Z-AI/GLM-5.2' in onDisk.perModelSettings),
    'no original-case key must linger under perModelSettings');

  // READ round-trip via get-models: the endpoint reports the lowercased id;
  // mapModelCatalog reads perModelSettings[id.toLowerCase()] and must find the
  // persisted 'night' mode (not silently revert to 'auto').
  const catalog = {
    data: [
      { id: 'z-ai/glm-5.2', context_length: 202752, max_completion_tokens: 131072, capabilities: {}, enabled: true }
    ]
  };
  const readHandlers = await makeHandlers(configPath, async () => catalog);
  const result = await readHandlers.getModels();

  assert.ok(result.models.length === 1);
  const glm = result.models[0];
  assert.equal(glm.id, 'z-ai/glm-5.2');
  assert.equal(glm.mode, 'night', 'get-models must read the lowercased perModelSettings key (no silent revert to auto)');
});

// ---------------------------------------------------------------------------
// Part A.5: update-model-settings enabled flag toggles disabledModels (lowercased)
// ---------------------------------------------------------------------------
test('update-model-settings enabled:false adds the lowercased id to disabledModels; enabled:true removes it', async () => {
  const configPath = newConfigFile({ disabledModels: ['deepseek-ai/deepseek-v4-pro'] });
  const handlers = await makeHandlers(configPath, async () => ({}));

  const off = await handlers.updateModelSettings('Z-AI/GLM-5.2', { enabled: false });
  assert.equal(off.enabled, false, 'returned ModelConfig reports disabled');
  assert.ok(
    readRaw(configPath).disabledModels.includes('z-ai/glm-5.2'),
    'disabledModels must contain the lowercased id (matches the gateway case-insensitive read)'
  );
  assert.ok(
    readRaw(configPath).disabledModels.includes('deepseek-ai/deepseek-v4-pro'),
    'pre-existing disabled entries must be preserved'
  );

  const on = await handlers.updateModelSettings('Z-AI/GLM-5.2', { enabled: true });
  assert.equal(on.enabled, true, 'returned ModelConfig reports enabled after re-enabling');
  assert.ok(
    !readRaw(configPath).disabledModels.includes('z-ai/glm-5.2'),
    're-enabling must remove the lowercased id from disabledModels'
  );
  assert.ok(
    readRaw(configPath).disabledModels.includes('deepseek-ai/deepseek-v4-pro'),
    'other disabled entries must be untouched by the re-enable'
  );
});

// ---------------------------------------------------------------------------
// Part A.6: toggle-model round-trip
// ---------------------------------------------------------------------------
test('toggle-model(id,false) then toggle-model(id,true) round-trips the id into and out of disabledModels', async () => {
  const configPath = newConfigFile({ disabledModels: [] });
  const handlers = await makeHandlers(configPath, async () => ({}));

  const off = await handlers.toggleModel('z-ai/glm-5.2', false);
  assert.equal(off.enabled, false);
  assert.deepEqual(readRaw(configPath).disabledModels, ['z-ai/glm-5.2']);

  const on = await handlers.toggleModel('z-ai/glm-5.2', true);
  assert.equal(on.enabled, true);
  assert.deepEqual(readRaw(configPath).disabledModels, [], 'round-trip must leave disabledModels empty');
});

// ---------------------------------------------------------------------------
// Part A.7: atomic write — a writeAppConfig failure leaves config.json unchanged
// ---------------------------------------------------------------------------
test('update-model-settings leaves config.json unchanged when writeAppConfig throws mid-write (atomic)', async () => {
  const configPath = newConfigFile();
  const original = fs.readFileSync(configPath);
  // Inject an ACL/protect failure on the .tmp path: writeAppConfig writes the
  // temp, calls protect(tmp), then renames. Failing at protect(tmp) — before
  // rename — must leave the original config.json untouched.
  const throwingProtect = (filePath) => {
    if (filePath === `${configPath}.tmp`) throw new Error('injected-acl-failure');
  };
  const handlers = await makeHandlers(configPath, async () => ({}), throwingProtect);

  await assert.rejects(
    () => handlers.updateModelSettings('z-ai/glm-5.2', { mode: 'night' }),
    (err) => err instanceof Error && err.message === 'injected-acl-failure',
    'the injected protect failure must propagate'
  );

  assert.deepEqual(fs.readFileSync(configPath), original, 'config.json must be byte-identical after a failed atomic write');
  // Clean up the leftover .tmp artifact (the writer cannot, since it threw).
  fs.rmSync(`${configPath}.tmp`, { force: true });
});

test('update-model-settings rejects an invalid mode and an invalid enabled flag without touching config.json', async () => {
  const configPath = newConfigFile();
  const original = fs.readFileSync(configPath);
  const handlers = await makeHandlers(configPath, async () => ({}));

  await assert.rejects(() => handlers.updateModelSettings('z-ai/glm-5.2', { mode: 'turbo' }), /Invalid performance mode/);
  await assert.rejects(() => handlers.updateModelSettings('z-ai/glm-5.2', { enabled: 'yes' }), /Invalid enabled flag/);
  await assert.rejects(() => handlers.updateModelSettings('', { mode: 'night' }), /Invalid model id/);

  assert.deepEqual(fs.readFileSync(configPath), original, 'validation failures must not write');
});

// ---------------------------------------------------------------------------
// Part A.8: bulk-toggle-models handler
// ---------------------------------------------------------------------------
test('bulk-toggle-models(false) sets disabledModels to all known model IDs and returns updated catalog with enabled:false', async () => {
  const configPath = newConfigFile({
    perModelSettings: {
      'stepfun-ai/step-3.7-flash': { enabled: true, performanceMode: 'day' }
    },
    disabledModels: []
  });
  const catalog = {
    data: [
      { id: 'z-ai/glm-5.2', context_length: 202752, max_completion_tokens: 131072, capabilities: {}, enabled: true },
      { id: 'meta/llama-4-maverick-17b-128e-instruct', context_length: 128000, max_completion_tokens: 4096, capabilities: {}, enabled: true }
    ]
  };
  const handlers = await makeHandlers(configPath, async () => catalog);

  // Prime catalog
  await handlers.getModels();

  const result = await handlers.bulkToggleModels(false);
  assert.ok(Array.isArray(result));
  assert.ok(result.length >= 2);
  for (const model of result) {
    assert.equal(model.enabled, false, `model ${model.id} must be disabled`);
  }

  const onDisk = readRaw(configPath);
  assert.ok(Array.isArray(onDisk.disabledModels));
  assert.ok(onDisk.disabledModels.includes('z-ai/glm-5.2'));
  assert.ok(onDisk.disabledModels.includes('meta/llama-4-maverick-17b-128e-instruct'));
  assert.ok(onDisk.disabledModels.includes('stepfun-ai/step-3.7-flash'));
  assert.equal(onDisk.perModelSettings['stepfun-ai/step-3.7-flash'].enabled, false);
});

test('bulk-toggle-models(true) clears disabledModels to only EOL 410 models and returns updated catalog', async () => {
  const configPath = newConfigFile({
    perModelSettings: {
      'stepfun-ai/step-3.7-flash': { enabled: false, performanceMode: 'day' }
    },
    disabledModels: ['stepfun-ai/step-3.7-flash', 'z-ai/glm-5.2', 'meta/llama-4-maverick-17b-128e-instruct']
  });
  const catalog = {
    data: [
      { id: 'z-ai/glm-5.2', context_length: 202752, max_completion_tokens: 131072, capabilities: {}, enabled: false },
      { id: 'deepseek-ai/deepseek-v4-pro', context_length: 1048576, max_completion_tokens: 393216, capabilities: {}, enabled: false }
    ]
  };
  const handlers = await makeHandlers(configPath, async () => catalog);

  // Prime catalog
  await handlers.getModels();

  const result = await handlers.bulkToggleModels(true);
  assert.ok(Array.isArray(result));
  const glm = result.find((m) => m.id === 'z-ai/glm-5.2');
  const eol = result.find((m) => m.id === 'deepseek-ai/deepseek-v4-pro');
  assert.ok(glm);
  assert.equal(glm.enabled, true, 'non-EOL model must be enabled');
  assert.ok(eol);
  assert.equal(eol.enabled, false, 'EOL 410 model must remain disabled');

  const onDisk = readRaw(configPath);
  assert.deepEqual(
    onDisk.disabledModels,
    ['deepseek-ai/deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
    'disabledModels must contain only truly EOL models'
  );
  assert.equal(onDisk.perModelSettings['stepfun-ai/step-3.7-flash'].enabled, true);
});

test('bulk-toggle-models leaves config.json unchanged when writeAppConfig throws mid-write (atomic write)', async () => {
  const configPath = newConfigFile();
  const original = fs.readFileSync(configPath);
  const throwingProtect = (filePath) => {
    if (filePath === `${configPath}.tmp`) throw new Error('injected-acl-failure');
  };
  const handlers = await makeHandlers(configPath, async () => ({}), throwingProtect);

  await assert.rejects(
    () => handlers.bulkToggleModels(false),
    (err) => err instanceof Error && err.message === 'injected-acl-failure',
    'the injected protect failure must propagate'
  );

  assert.deepEqual(fs.readFileSync(configPath), original, 'config.json must be byte-identical after failed bulk-toggle write');
  fs.rmSync(`${configPath}.tmp`, { force: true });
});

test('bulk-toggle-models rejects non-boolean arguments without touching config.json', async () => {
  const configPath = newConfigFile();
  const original = fs.readFileSync(configPath);
  const handlers = await makeHandlers(configPath, async () => ({}));

  await assert.rejects(() => handlers.bulkToggleModels('yes'), /Invalid enabled flag/);
  await assert.rejects(() => handlers.bulkToggleModels(null), /Invalid enabled flag/);
  await assert.rejects(() => handlers.bulkToggleModels(1), /Invalid enabled flag/);

  assert.deepEqual(fs.readFileSync(configPath), original, 'config.json must be untouched after rejected call');
});

// ---------------------------------------------------------------------------
// Part B: durable accessibleModels (state-ownership + rotation)
// ---------------------------------------------------------------------------
test('isChildKeyProjection accepts a 6-field record with accessibleModels and still accepts a 5-field legacy record', async () => {
  const { isChildKeyProjection } = await import(built('state-ownership.js'));

  assert.equal(isChildKeyProjection({ keys: [keyRecord5()] }), true, '5-field legacy projection still accepted');
  assert.equal(
    isChildKeyProjection({ keys: [{ ...keyRecord5(), accessibleModels: ['z-ai/glm-5.2', 'meta/llama-4'] }] }),
    true,
    '6-field record adding accessibleModels: string[] is accepted'
  );
  assert.equal(
    isChildKeyProjection({ keys: [{ ...keyRecord5(), accessibleModels: [] }] }),
    true,
    '6-field record with an empty accessibleModels array is accepted'
  );
});

test('isChildKeyProjection rejects malformed 6-field records (foreign field, non-array, non-strings, wrong count)', async () => {
  const { isChildKeyProjection } = await import(built('state-ownership.js'));

  // 6 fields WITHOUT accessibleModels (an injected foreign field) must be rejected.
  assert.equal(isChildKeyProjection({ keys: [{ ...keyRecord5(), rogueField: true }] }), false, 'foreign 6th field rejected');
  // accessibleModels present but wrong type.
  assert.equal(isChildKeyProjection({ keys: [{ ...keyRecord5(), accessibleModels: 'not-an-array' }] }), false, 'non-array accessibleModels rejected');
  assert.equal(isChildKeyProjection({ keys: [{ ...keyRecord5(), accessibleModels: [1, 2] }] }), false, 'non-string entries rejected');
  // A 7-field record (accessibleModels + an extra field) rejected.
  assert.equal(isChildKeyProjection({ keys: [{ ...keyRecord5(), accessibleModels: ['m'], extra: 1 }] }), false, '7-field record rejected');
  // Root must still be exactly { keys }.
  assert.equal(isChildKeyProjection({ keys: [keyRecord5()], extra: 1 }), false, 'root with an extra field rejected');
});

test('mergeChildKeyProjection persists accessibleModels and preserves main-owned fields', async () => {
  const { mergeChildKeyProjection } = await import(built('state-ownership.js'));

  const root = { keys: [], credentials: { gatewayToken: 'tok', adminToken: 'at' }, legacyNvidiaMigration: { version: 1 } };
  const projection = { keys: [{ ...keyRecord5(), accessibleModels: ['z-ai/glm-5.2', 'qwen/qwen3.5'] }] };

  const merged = mergeChildKeyProjection(root, projection);

  assert.deepEqual(merged.credentials, root.credentials, 'main-owned credentials preserved');
  assert.deepEqual(merged.legacyNvidiaMigration, root.legacyNvidiaMigration, 'migration metadata preserved');
  assert.deepEqual(merged.keys[0].accessibleModels, ['z-ai/glm-5.2', 'qwen/qwen3.5'], 'accessibleModels persisted on the merged key');
  assert.deepEqual(merged.keys[0].usage, keyRecord5().usage, 'required fields preserved');
});

test('durable accessibleModels round-trip: saveState projects 6 fields -> main validates+merges -> restart normalize restores them', async () => {
  // --- gateway side (real rotation.mjs, run from source like rotation.test.mjs) ---
  const dir = makeRotationDir();
  const rotation = await import(pathToFileURL(path.join(root, 'src/gateway/rotation.mjs')).href);
  const logger = await import(pathToFileURL(path.join(root, 'src/gateway/logger.mjs')).href);
  rotation.setPersistenceAdapter(() => {}); // replaced below with a capture
  rotation.initializeState({ keys: [] });

  let persistedState = null;
  rotation.setPersistenceAdapter((state) => { persistedState = state; });
  // Seed the gateway with a key carrying an upstream-accessible catalog.
  rotation.initializeState({ keys: [{ ...keyRecord5(), accessibleModels: ['z-ai/glm-5.2', 'meta/llama-4'] }] });
  rotation.flushState(); // saveState() -> persistAdapter captures the 6-field projection

  // --- main side (real validator + merge) ---
  const { isChildKeyProjection, mergeChildKeyProjection } = await import(built('state-ownership.js'));
  assert.equal(isChildKeyProjection(persistedState), true, 'main must accept the 6-field projection Phase 2 produces');
  assert.ok(Array.isArray(persistedState.keys) && persistedState.keys[0].accessibleModels,
    'saveState must re-include accessibleModels in the projection (Phase 2 fixes the strip)');
  assert.deepEqual(persistedState.keys[0].accessibleModels, ['z-ai/glm-5.2', 'meta/llama-4']);

  const merged = mergeChildKeyProjection({ keys: [], credentials: { adminToken: 'a', gatewayToken: 'g' } }, persistedState);
  assert.deepEqual(merged.keys[0].accessibleModels, ['z-ai/glm-5.2', 'meta/llama-4']);

  // --- simulated restart: the gateway reads the persisted state and normalizes ---
  rotation.setPersistenceAdapter(() => {});
  rotation.initializeState(merged); // normalize() seeds accessibleModels from the persisted record
  const restored = rotation.getKeys()[0];
  assert.ok(restored && Array.isArray(restored.accessibleModels), 'a restarted child restores accessibleModels onto the key');
  assert.deepEqual(restored.accessibleModels, ['z-ai/glm-5.2', 'meta/llama-4'], 'restored catalog matches what was persisted');

  // --- legacy 5-field projection normalizes accessibleModels to [] (back-compat) ---
  rotation.initializeState({ keys: [keyRecord5()] });
  const legacy = rotation.getKeys()[0];
  assert.deepEqual(legacy.accessibleModels, [], 'a 5-field legacy record normalizes accessibleModels to []');

  rotation.closeStateWatcher();
  logger.closeLogger?.();
  fs.rmSync(dir, { recursive: true, force: true });
});
