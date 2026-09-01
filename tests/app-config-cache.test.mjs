import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const builtPath = path.join(root, 'build', 'src', 'main', 'gateway-runtime.js');

// ───────────────────────────────────────────────────────────────────────────
// DEFECT: config.json was re-read from disk on EVERY runtime-state request.
//
// readAppConfig() is a synchronous fs.readFileSync + JSON.parse. It sat inside
// the `get-runtime-state` IPC handler (src/main/index.ts), which the renderer
// polls, and inside currentLanguage(), which updateTray() calls. A single
// upstream defect once amplified 5,000 download ticks into 5,000 synchronous
// config reads and 5.3 s of blocked main thread (commit fea558f).
//
// REQUIRED BEHAVIOUR: read-only hot paths serve a cached parse. Disk is touched
// once, then only after the config actually changes.
//
// EVERY ASSERTION HERE IS BEHAVIOURAL. This file does not read source text: it
// loads the REAL BUILT module and counts ACTUAL fs.readFileSync calls against
// the config path. A textual guard would pass for code that misbehaves at
// runtime, and every textual guard in this repo has eventually been evaded.
// ───────────────────────────────────────────────────────────────────────────

/** Count real disk reads of one specific file, whoever performs them. */
function countReadsOf(targetPath) {
  const real = fs.readFileSync;
  const state = { count: 0 };
  fs.readFileSync = function (file, ...rest) {
    if (typeof file === 'string' && path.resolve(file) === path.resolve(targetPath)) state.count += 1;
    return real.call(this, file, ...rest);
  };
  state.restore = () => { fs.readFileSync = real; };
  return state;
}

function scratchConfig(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvg-config-cache-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(contents, null, 2), 'utf8');
  return { dir, configPath };
}

const baseConfig = {
  version: 1,
  gatewayPort: 41100,
  language: 'en',
  setupComplete: true,
  performanceMode: 'day',
  modelLimits: { '*': { maxTokens: 4096 } }
};

// The built module is produced by `tsc --project tsconfig.node.json`. Say so
// plainly rather than failing opaquely if it is absent.
const built = fs.existsSync(builtPath) ? require(builtPath) : null;

test('the built app-config module exposes a cached reader and an invalidator', () => {
  assert.ok(built, `the built module is missing: ${builtPath}`);
  assert.equal(typeof built.readAppConfig, 'function', 'the fresh reader must still exist');
  assert.equal(typeof built.readAppConfigCached, 'function',
    'a cached reader must exist for read-only hot paths (get-runtime-state, currentLanguage), '
    + 'so a polled channel stops doing a synchronous readFileSync per request');
  assert.equal(typeof built.invalidateAppConfigCache, 'function',
    'an explicit invalidator must exist so writers can drop the cached parse');
});

test('a steady stream of cached reads performs exactly one disk read', () => {
  const { dir, configPath } = scratchConfig(baseConfig);
  try {
    built.invalidateAppConfigCache();
    const reads = countReadsOf(configPath);
    try {
      for (let i = 0; i < 500; i += 1) built.readAppConfigCached(configPath);
    } finally { reads.restore(); }

    assert.equal(reads.count, 1,
      `500 cached reads performed ${reads.count} disk reads. The hot path is polled forever, so `
      + 'anything above 1 is a synchronous readFileSync per renderer request.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the cached value is the same data the fresh reader returns', () => {
  const { dir, configPath } = scratchConfig(baseConfig);
  try {
    built.invalidateAppConfigCache();
    assert.deepEqual(built.readAppConfigCached(configPath), built.readAppConfig(configPath),
      'the cache must not change the response shape or values of the runtime-state payload');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeAppConfig invalidates, so the next cached read sees the new value', () => {
  const { dir, configPath } = scratchConfig(baseConfig);
  try {
    built.invalidateAppConfigCache();
    assert.equal(built.readAppConfigCached(configPath).language, 'en', 'precondition');

    built.writeAppConfig(configPath, { language: 'ru' });

    assert.equal(built.readAppConfigCached(configPath).language, 'ru',
      'after writeAppConfig the cached reader still served the pre-write value. A stale cache '
      + 'here would make the Settings view show the language the user just changed away from.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeGatewayPort invalidates too, though it bypasses writeAppConfig', () => {
  // writeGatewayPort does its own readFileSync/writeFileSync (gateway-runtime.ts)
  // and never routes through writeAppConfig. A cache invalidated only in
  // writeAppConfig would keep serving the old port after every retry-gateway.
  const { dir, configPath } = scratchConfig(baseConfig);
  try {
    built.invalidateAppConfigCache();
    assert.equal(built.readAppConfigCached(configPath).gatewayPort, 41100, 'precondition');

    built.writeGatewayPort(configPath, 41500);

    assert.equal(built.readAppConfigCached(configPath).gatewayPort, 41500,
      'writeGatewayPort left a stale cached parse. Every config writer in this module must '
      + 'invalidate, otherwise the set of writers that must remember to do so grows silently.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the write merge base is never served from the cache', () => {
  // THE DATA-LOSS GUARD. writeAppConfig merges over readAppConfig(configPath).
  // If that merge base were the CACHE, then a config change made by a different
  // writer (or externally) would be overwritten by whatever the cache still
  // held -- a silent revert of fields the user had just set.
  const { dir, configPath } = scratchConfig(baseConfig);
  try {
    built.invalidateAppConfigCache();
    built.readAppConfigCached(configPath); // arm the cache with gatewayPort 41100

    // A writer that does not go through writeAppConfig changes the port...
    built.writeGatewayPort(configPath, 41777);
    // ...and now an unrelated writeAppConfig must PRESERVE it, not resurrect 41100.
    built.writeAppConfig(configPath, { language: 'zh' });

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(onDisk.gatewayPort, 41777,
      'writeAppConfig reverted the gateway port to a cached value. The merge base must be a '
      + 'fresh read; caching it silently discards concurrent changes.');
    assert.equal(onDisk.language, 'zh', 'the requested update must still land');
    assert.deepEqual(onDisk.modelLimits, baseConfig.modelLimits,
      'raw passthrough fields such as modelLimits must survive a merge');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the cache is keyed by path and never serves another file', () => {
  const first = scratchConfig({ ...baseConfig, language: 'en' });
  const second = scratchConfig({ ...baseConfig, language: 'fr' });
  try {
    built.invalidateAppConfigCache();
    assert.equal(built.readAppConfigCached(first.configPath).language, 'en');
    assert.equal(built.readAppConfigCached(second.configPath).language, 'fr',
      'a cache that ignores the config path would serve the first file\'s contents for the '
      + 'second path, which in a migration or a relocated userData dir is silent corruption');
    assert.equal(built.readAppConfigCached(first.configPath).language, 'en',
      'switching back must not be poisoned either');
  } finally {
    fs.rmSync(first.dir, { recursive: true, force: true });
    fs.rmSync(second.dir, { recursive: true, force: true });
  }
});

test('ACCEPTED TRADEOFF: an external edit is served stale until the app writes or restarts', () => {
  // Pinned as a TEST, not just a comment, so it can never be mistaken for a bug
  // and can never be "fixed" by putting the read back on the hot path. This is
  // the same class of tradeoff the auto-launch cache documents for an external
  // registry edit (tests/auto-launch-handle-leak.test.mjs).
  const { dir, configPath } = scratchConfig(baseConfig);
  try {
    built.invalidateAppConfigCache();
    assert.equal(built.readAppConfigCached(configPath).language, 'en', 'precondition');

    // Somebody edits config.json behind the app's back (an editor, a script).
    fs.writeFileSync(configPath, JSON.stringify({ ...baseConfig, language: 'hi' }, null, 2), 'utf8');

    assert.equal(built.readAppConfigCached(configPath).language, 'en',
      'documented staleness: the cached hot path keeps serving the last parse after an '
      + 'EXTERNAL edit. If this ever returns the new value the cache has been removed.');
    assert.equal(built.readAppConfig(configPath).language, 'hi',
      'the fresh reader must still see the truth, so writers and startup are never stale');

    // And the staleness is bounded: any app-side write ends it.
    built.writeAppConfig(configPath, { setupComplete: true });
    assert.equal(built.readAppConfigCached(configPath).language, 'hi',
      'the external value must be picked up once the app itself writes');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MEASUREMENT: the cached read is materially cheaper than the disk read', () => {
  const { dir, configPath } = scratchConfig(baseConfig);
  try {
    const iterations = 2000;

    built.invalidateAppConfigCache();
    const freshStart = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) built.readAppConfig(configPath);
    const freshMs = Number(process.hrtime.bigint() - freshStart) / 1e6;

    built.invalidateAppConfigCache();
    built.readAppConfigCached(configPath);
    const cachedStart = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) built.readAppConfigCached(configPath);
    const cachedMs = Number(process.hrtime.bigint() - cachedStart) / 1e6;

    console.log(`[measured] readAppConfig      ${(freshMs / iterations).toFixed(4)} ms/call (${freshMs.toFixed(1)} ms / ${iterations})`);
    console.log(`[measured] readAppConfigCached ${(cachedMs / iterations).toFixed(4)} ms/call (${cachedMs.toFixed(1)} ms / ${iterations})`);
    console.log(`[measured] speedup             ${(freshMs / Math.max(cachedMs, 1e-9)).toFixed(1)}x`);

    assert.ok(cachedMs * 5 < freshMs,
      `the cached path (${cachedMs.toFixed(1)} ms) must be far cheaper than the disk path `
      + `(${freshMs.toFixed(1)} ms) for ${iterations} reads; otherwise the cache is not doing its job`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
