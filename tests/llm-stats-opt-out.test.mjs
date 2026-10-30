/**
 * LLM Stats ranking opt-out (owner, 29.09: "on by default, but it can be turned off").
 *
 * Contract under test:
 *   - config.json key `llmStatsEnabled` (boolean). Absent / non-boolean -> ENABLED
 *     (old configs keep today's behaviour). Only the literal `false` disables.
 *   - Main owns the write (writeAppConfig, atomic) and exposes it through the existing
 *     set-app-config / get-runtime-state IPC pair.
 *   - The gateway child re-reads config.json through the mtime/size-cached unified
 *     reader (performance-mode.mjs), so a toggle applies at RUNTIME with no restart,
 *     and on (re)start it applies before the first /admin/models (GATEWAY_CONFIG_PATH
 *     is already in the spawn env).
 *   - Disabled: ZERO calls to the fetcher (not even force / background refresh), an
 *     empty ranking (llmStatsRank omitted), and the local cache file left untouched.
 *
 * The fetcher is always the injectable fake: no test here can reach zeroeval.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const runtime = require(path.join(projectRoot, 'build', 'src', 'main', 'gateway-runtime.js'));
const appConfigIpc = require(path.join(projectRoot, 'build', 'src', 'main', 'app-config-ipc.js'));
const performanceMode = await import(pathToFileURL(path.join(projectRoot, 'src', 'gateway', 'performance-mode.mjs')).href);
const LLM_STATS_PATH = path.join(projectRoot, 'src', 'gateway', 'llm-stats-ranking.mjs');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-llmstats-optout-${process.pid}-`));
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

let seq = 0;
function configFile(content) {
  const file = path.join(tempRoot, `config-${seq++}.json`);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

const INDEX = { models: [{ model_id: 'glm-5.3', model_name: 'GLM 5.3', rank: 9, conservative: 52.71 }] };

let loadSeq = 0;
async function loadLlmStats() {
  return import(`${pathToFileURL(LLM_STATS_PATH).href}?optout=${Date.now()}-${++loadSeq}`);
}

/** Run `fn` with GATEWAY_CONFIG_PATH / GATEWAY_LLM_STATS_CACHE_PATH set, restoring both. */
async function withEnv(vars, fn) {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── main: storage ─────────────────────────────────────────────────────────

test('main: llmStatsEnabled defaults to TRUE when absent (old configs) or invalid', () => {
  assert.equal(runtime.readAppConfig(configFile({ version: 1, language: 'ru' })).llmStatsEnabled, true);
  assert.equal(runtime.readAppConfig(path.join(tempRoot, 'missing.json')).llmStatsEnabled, true);
  for (const invalid of ['"false"', '0', 'null', '{}', '[]']) {
    assert.equal(runtime.readAppConfig(configFile(`{"llmStatsEnabled":${invalid}}`)).llmStatsEnabled, true, invalid);
  }
  assert.equal(runtime.readAppConfig(configFile({ llmStatsEnabled: false })).llmStatsEnabled, false);
  assert.equal(runtime.readAppConfig(configFile({ llmStatsEnabled: true })).llmStatsEnabled, true);
});

test('main: writeAppConfig persists false/true atomically (round-trip) and keeps other fields', () => {
  const file = configFile({ version: 1, gatewayPort: 12000, language: 'ru', requestDeadlineMs: 90_000 });
  const saved = runtime.writeAppConfig(file, { llmStatsEnabled: false });
  assert.equal(saved.llmStatsEnabled, false);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.llmStatsEnabled, false);
  assert.equal(disk.language, 'ru');
  assert.equal(disk.requestDeadlineMs, 90_000);
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'atomic temp file must be renamed away');
  assert.equal(runtime.readAppConfig(file).llmStatsEnabled, false);
  runtime.invalidateAppConfigCache();
  assert.equal(runtime.readAppConfigCached(file).llmStatsEnabled, false, 'cached reader agrees');
  assert.equal(runtime.writeAppConfig(file, { llmStatsEnabled: true }).llmStatsEnabled, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).llmStatsEnabled, true);
  // An unrelated write keeps the user's choice.
  runtime.writeAppConfig(file, { llmStatsEnabled: false });
  runtime.writeAppConfig(file, { language: 'en' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).llmStatsEnabled, false);
  runtime.invalidateAppConfigCache();
});

test('main: an unrelated write never materialises the default; an invalid value is rejected untouched', () => {
  const file = configFile({ version: 1, gatewayPort: 12000, language: 'en' });
  const saved = runtime.writeAppConfig(file, { language: 'ru' });
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), 'llmStatsEnabled'), false);
  assert.equal(saved.llmStatsEnabled, true, 'returned state carries the read-time default');
  const before = fs.readFileSync(file, 'utf8');
  for (const invalid of ['false', 0, 1, null, {}]) {
    assert.throws(() => runtime.writeAppConfig(file, { llmStatsEnabled: invalid }), /Invalid llmStatsEnabled/, String(invalid));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

// ─── main: IPC shape ───────────────────────────────────────────────────────

test('IPC set-app-config: llmStatsEnabled is allowlisted and boolean-validated before any write', () => {
  const writes = [];
  const save = appConfigIpc.createAppConfigUpdateHandler({
    getConfigPath: () => 'test-config.json',
    writeAppConfig: (_p, update) => { writes.push(update); return { llmStatsEnabled: update.llmStatsEnabled }; },
    protectFile: () => {},
    validateBoolean: (value) => { if (typeof value !== 'boolean') throw new Error('Invalid boolean'); }
  });
  for (const invalid of ['false', 0, null, {}]) {
    assert.throws(() => save({ llmStatsEnabled: invalid }), /Invalid boolean/, String(invalid));
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(save({ llmStatsEnabled: false }), { llmStatsEnabled: false });
  assert.deepEqual(save({ llmStatsEnabled: true }), { llmStatsEnabled: true });
  assert.deepEqual(writes, [{ llmStatsEnabled: false }, { llmStatsEnabled: true }]);
});

test('IPC get-runtime-state payload carries llmStatsEnabled (default true)', () => {
  runtime.invalidateAppConfigCache();
  assert.equal(runtime.readRuntimeAppConfigCached(configFile({ language: 'ru' }), {}).llmStatsEnabled, true);
  runtime.invalidateAppConfigCache();
  assert.equal(runtime.readRuntimeAppConfigCached(configFile({ llmStatsEnabled: false }), {}).llmStatsEnabled, false);
  runtime.invalidateAppConfigCache();
});

test('IPC type declarations carry llmStatsEnabled (index.ts, preload, global.d.ts, AppConfigUpdate)', () => {
  const src = (rel) => fs.readFileSync(path.join(projectRoot, ...rel.split('/')), 'utf8');
  const line = (text, needle) => text.split('\n').find((l) => l.includes(needle)) ?? '';
  assert.match(line(src('src/main/index.ts'), 'ipcMain.handle("set-app-config"'), /llmStatsEnabled\?: boolean/);
  assert.match(line(src('src/preload/index.ts'), 'setAppConfig:'), /llmStatsEnabled\?: boolean/);
  const globals = src('src/renderer/global.d.ts');
  assert.match(line(globals, 'setAppConfig:'), /llmStatsEnabled\?: boolean/);
  assert.match(line(globals, 'interface RuntimeState'), /llmStatsEnabled: boolean/);
  assert.match(src('src/main/app-config-ipc.ts'), /llmStatsEnabled\?: boolean;/);
});

// ─── gateway child: reader ─────────────────────────────────────────────────

test('gateway reader: absent/missing/invalid -> true, literal false -> false, re-read at runtime', () => {
  const read = performanceMode.readLlmStatsEnabled;
  assert.equal(typeof read, 'function');
  assert.equal(read(undefined), true);
  assert.equal(read(path.join(tempRoot, 'missing-child.json')), true);
  assert.equal(read(configFile('{not json')), true);
  assert.equal(read(configFile({})), true);
  assert.equal(read(configFile({ llmStatsEnabled: 'false' })), true);
  assert.equal(read(configFile({ llmStatsEnabled: false })), false);
  const file = configFile({ llmStatsEnabled: true });
  assert.equal(read(file), true);
  fs.writeFileSync(file, JSON.stringify({ llmStatsEnabled: false }));
  assert.equal(read(file), false, 'a toggle on disk must apply without a restart');
});

// ─── gateway child: no fetch when disabled ─────────────────────────────────

test('disabled: ZERO fetcher calls across several ranking calls (incl. force), empty ranking, cache file untouched', async () => {
  const configPath = configFile({ version: 1, llmStatsEnabled: false });
  const cachePath = path.join(tempRoot, `llm-cache-${seq++}.json`);
  const cacheBytes = JSON.stringify({ version: 1, fetched_at: 1, models: INDEX.models });
  fs.writeFileSync(cachePath, cacheBytes);
  const mtimeBefore = fs.statSync(cachePath).mtimeMs;
  await withEnv({ GATEWAY_CONFIG_PATH: configPath, GATEWAY_LLM_STATS_CACHE_PATH: cachePath }, async () => {
    const mod = await loadLlmStats();
    let calls = 0;
    mod.__setFetcherForTests__(async () => { calls += 1; return INDEX; });
    for (let i = 0; i < 4; i += 1) {
      const ranking = await mod.getCatalogRankingFromCache(['z-ai/glm-5.3']);
      assert.equal(ranking.size, 0, 'disabled -> no rank (llmStatsRank omitted)');
    }
    assert.equal(await mod.getRankingEntries({ force: true }), null, 'force must not bypass the opt-out');
    assert.equal((await mod.getCatalogRanking(['z-ai/glm-5.3'])).size, 0);
    await tick();
    assert.equal(calls, 0, 'the fetcher must never be called while disabled');
  });
  assert.equal(fs.readFileSync(cachePath, 'utf8'), cacheBytes, 'cache file left as is');
  assert.equal(fs.statSync(cachePath).mtimeMs, mtimeBefore);
});

test('disabled: getLlmStatsSnapshot (POST /admin/catalog/sync) reports unavailable and never reads the cache file', async () => {
  const configPath = configFile({ version: 1, llmStatsEnabled: false });
  const cachePath = path.join(tempRoot, `llm-cache-${seq++}.json`);
  fs.writeFileSync(cachePath, JSON.stringify({ version: 1, fetched_at: 1, models: INDEX.models }));
  // Spy on the shared node:fs object the module reads through; record every path read.
  const reads = [];
  const originalRead = fs.readFileSync;
  fs.readFileSync = function spy(file, ...rest) { reads.push(String(file)); return originalRead.call(this, file, ...rest); };
  try {
    await withEnv({ GATEWAY_CONFIG_PATH: configPath, GATEWAY_LLM_STATS_CACHE_PATH: cachePath }, async () => {
      const mod = await loadLlmStats(); // fresh instance: cache not loaded yet
      let calls = 0;
      mod.__setFetcherForTests__(async () => { calls += 1; return INDEX; });
      assert.deepEqual(mod.getLlmStatsSnapshot(), { available: false, fromCache: false, fetchedAt: null, count: 0 });
      assert.equal(reads.includes(cachePath), false, 'the cache file must not be read while disabled');
      // NON-VACUITY: once re-enabled, the same instance does read and report the cache.
      fs.writeFileSync(configPath, JSON.stringify({ version: 1, llmStatsEnabled: true, pad: 'x' }));
      const snapshot = mod.getLlmStatsSnapshot();
      assert.equal(reads.includes(cachePath), true, 'enabled: the cache file is read');
      assert.equal(snapshot.available, true);
      assert.equal(snapshot.fromCache, true);
      assert.equal(snapshot.count, 1);
      assert.equal(calls, 0, 'the snapshot never fetches');
    });
  } finally {
    fs.readFileSync = originalRead;
  }
});

test('enabled (key absent): one background refresh, then served from memory', async () => {
  const configPath = configFile({ version: 1 });
  const cachePath = path.join(tempRoot, `llm-cache-${seq++}.json`);
  await withEnv({ GATEWAY_CONFIG_PATH: configPath, GATEWAY_LLM_STATS_CACHE_PATH: cachePath }, async () => {
    const mod = await loadLlmStats();
    let calls = 0;
    mod.__setFetcherForTests__(async () => { calls += 1; return INDEX; });
    assert.equal((await mod.getCatalogRankingFromCache(['z-ai/glm-5.3'])).size, 0, 'cold: nothing loaded yet');
    await tick();
    assert.equal(calls, 1, 'exactly one refresh');
    assert.equal((await mod.getCatalogRankingFromCache(['z-ai/glm-5.3'])).get('z-ai/glm-5.3')?.rank, 9);
    await tick();
    assert.equal(calls, 1, 'fresh index -> no second fetch');
  });
});

test('runtime toggle: disabled -> enabled triggers a normal refresh; enabled -> disabled stops serving ranks', async () => {
  const configPath = configFile({ version: 1, llmStatsEnabled: false });
  const cachePath = path.join(tempRoot, `llm-cache-${seq++}.json`);
  await withEnv({ GATEWAY_CONFIG_PATH: configPath, GATEWAY_LLM_STATS_CACHE_PATH: cachePath }, async () => {
    const mod = await loadLlmStats();
    let calls = 0;
    mod.__setFetcherForTests__(async () => { calls += 1; return INDEX; });
    await mod.getCatalogRankingFromCache(['z-ai/glm-5.3']);
    await tick();
    assert.equal(calls, 0);

    runtime.writeAppConfig(configPath, { llmStatsEnabled: true }); // what set-app-config does
    await mod.getCatalogRankingFromCache(['z-ai/glm-5.3']);
    await tick();
    assert.equal(calls, 1, 're-enabled: the next /admin/models triggers a refresh');
    assert.equal((await mod.getCatalogRankingFromCache(['z-ai/glm-5.3'])).get('z-ai/glm-5.3')?.rank, 9);

    runtime.writeAppConfig(configPath, { llmStatsEnabled: false });
    assert.equal((await mod.getCatalogRankingFromCache(['z-ai/glm-5.3'])).size, 0, 'disabled again: rank omitted');
    await mod.getRankingEntries({ force: true });
    await tick();
    assert.equal(calls, 1, 'no further fetch after disabling');
  });
  runtime.invalidateAppConfigCache();
});
