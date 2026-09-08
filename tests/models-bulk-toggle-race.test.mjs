// @ts-check
/**
 * Race-condition regression: bulkToggleModels readAppConfig snapshot is taken
 * BEFORE the `await dispatch(GET /admin/models)` (up to the admin socket
 * timeout, seconds). A concurrent update-model-settings / toggle-model write
 * landing during that await was silently overwritten: bulkToggleModels built
 * perModelSettings/disabledModels from the STALE snapshot and writeAppConfig
 * ({...freshRead, ...staleUpdate}) let the stale full maps win.
 *
 * Fix: re-read readAppConfig(configPath) AFTER the dispatch await and base the
 * merge on that fresh read (handler API unchanged).
 *
 * Harness mirrors tests/models-panel-main.test.mjs: compiled main modules from
 * build/src/main/*.js, real readAppConfig/writeAppConfig, temp config.json, and
 * a faked admin `dispatch` — here, a manually-resolved deferred so the test
 * controls exactly when the catalog fetch completes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-bulk-race-'));
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function newConfigFile(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'cfg-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    gatewayPort: 12000,
    language: 'en',
    setupComplete: true,
    performanceMode: 'day',
    modelLimits: { '*': { context: 131072, output: 4096 } },
    perModelSettings: {
      'stepfun-ai/step-3.7-flash': { enabled: true, performanceMode: 'day' }
    },
    disabledModels: [],
    ...overrides
  }, null, 2));
  return configPath;
}

function readRaw(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

async function makeHandlers(configPath, dispatch) {
  const { createModelsHandlers } = await import(built('models-ipc.js'));
  const { writeAppConfig } = await import(built('gateway-runtime.js'));
  return createModelsHandlers({
    dispatch,
    getConfigPath: () => configPath,
    writeAppConfig,
    protectFile: () => {}
  });
}

test('bulk-toggle-models re-reads config after the admin dispatch await; an update-model-settings write landing mid-await survives', async () => {
  const configPath = newConfigFile();

  // Deferred dispatch: the catalog fetch stays pending until the test lets it.
  let resolveCatalog;
  let dispatchSeen = false;
  const catalogReady = new Promise((resolve) => { resolveCatalog = resolve; });
  const dispatch = async (request) => {
    if (request.method === 'GET' && request.path === '/admin/models') {
      dispatchSeen = true;
      await catalogReady;
      return {
        data: [
          { id: 'z-ai/glm-5.2', context_length: 202752, max_completion_tokens: 131072, capabilities: {}, enabled: true }
        ]
      };
    }
    throw new Error(`unexpected dispatch ${request.method} ${request.path}`);
  };

  const handlers = await makeHandlers(configPath, dispatch);

  // NOTE: catalog deliberately NOT primed (lastKnownCatalog === null) so
  // bulkToggleModels takes the awaiting dispatch path.
  const bulkPromise = handlers.bulkToggleModels(true);

  // Spin until bulkToggleModels is actually suspended on the dispatch await.
  for (let i = 0; i < 100 && !dispatchSeen; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(dispatchSeen, 'bulkToggleModels must be awaiting the admin dispatch');

  // Concurrent single-model write lands while bulk is awaiting — this is the
  // interleaving the stale snapshot used to clobber.
  await handlers.updateModelSettings('z-ai/glm-5.2', { mode: 'night' });
  assert.equal(readRaw(configPath).perModelSettings['z-ai/glm-5.2'].performanceMode, 'night',
    'the concurrent write is on disk before bulk resolves its fetch');

  resolveCatalog();
  await bulkPromise;

  const onDisk = readRaw(configPath);
  assert.equal(
    onDisk.perModelSettings['z-ai/glm-5.2']?.performanceMode,
    'night',
    'the mid-await update-model-settings entry must survive the bulk write (no stale-snapshot overwrite)'
  );
  // Bulk enable semantics still applied: the existing entry is force-enabled,
  // non-concurrent data still merged.
  assert.equal(onDisk.perModelSettings['stepfun-ai/step-3.7-flash'].enabled, true,
    'bulk enable semantics preserved for pre-existing entries');
  assert.deepEqual(onDisk.disabledModels,
    ['deepseek-ai/deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
    'bulk enable(true) still reduces disabledModels to the EOL list');
});
