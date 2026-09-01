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
  //
  // THE SEQUENCE HERE IS LOAD-BEARING, and the obvious one does NOT work.
  // Arming the cache and then calling writeGatewayPort proves nothing: that
  // writer INVALIDATES, so a cached merge base would re-read from disk and be
  // correct by accident. MEASURED: with the merge base deliberately swapped to
  // readAppConfigCached in the built module, that sequence still wrote 41777 and
  // still passed. The change must therefore reach disk WITHOUT invalidating,
  // which is exactly what an external edit does. Same mutation, this sequence:
  // the port reverted to 41100.
  const { dir, configPath } = scratchConfig(baseConfig);
  try {
    built.invalidateAppConfigCache();
    built.readAppConfigCached(configPath); // arm the cache with gatewayPort 41100

    // The file changes behind the app's back, leaving the cache armed and stale.
    fs.writeFileSync(configPath, JSON.stringify({ ...baseConfig, gatewayPort: 41777 }, null, 2), 'utf8');

    // An unrelated writeAppConfig must PRESERVE that port, not resurrect 41100.
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

test('a bypassing writer still leaves the port intact through a later writeAppConfig', () => {
  // The original form of the guard above, kept because it is the real user story
  // (retry-gateway writes the port, then the user changes language). It passes
  // for two independent reasons, so it is NOT sufficient on its own -- see the
  // external-edit sequence above for the one that actually discriminates.
  const { dir, configPath } = scratchConfig(baseConfig);
  try {
    built.invalidateAppConfigCache();
    built.readAppConfigCached(configPath);
    built.writeGatewayPort(configPath, 41777);
    built.writeAppConfig(configPath, { language: 'zh' });
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(onDisk.gatewayPort, 41777, 'a retried port must survive a later config write');
    assert.equal(onDisk.language, 'zh', 'the requested update must still land');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('EVERY writer in the module invalidates, including the one that recreates the file', () => {
  // ensureGatewayRuntime is the THIRD writer of config.json in this module and
  // the easiest to miss, because it only writes when the file is ABSENT. If
  // config.json disappears while the app runs -- a cleanup script, a synced or
  // roamed userData directory, a user deleting it -- this rewrites DEFAULTS.
  // MEASURED before the fix: disk 12000, cached parse still 41100.
  const { dir, configPath } = scratchConfig(baseConfig);
  try {
    built.invalidateAppConfigCache();
    assert.equal(built.readAppConfigCached(configPath).gatewayPort, 41100, 'precondition');

    fs.rmSync(configPath, { force: true });
    built.ensureGatewayRuntime(dir);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(built.readAppConfigCached(configPath).gatewayPort, onDisk.gatewayPort,
      'ensureGatewayRuntime rewrote config.json with defaults and left the cache armed with the '
      + 'old parse. A writer that does not invalidate makes the set of writers that must remember '
      + 'to do so grow silently, which is the whole failure mode this cache has to avoid.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a writer whose ACL protector THROWS after the rename still invalidates', () => {
  // protect() runs AFTER fs.renameSync, so the new contents are already on disk
  // when it can fail. With the invalidation as a trailing statement it is simply
  // skipped, and the cache pins a value the file no longer contains for the rest
  // of the session. MEASURED before the fix, for BOTH writers:
  //   writeAppConfig   -> disk "ru",  cached "en"
  //   writeGatewayPort -> disk 41777, cached 41100
  // The production protector degrades rather than throws, so this is defence in
  // depth; the point is that correctness must not rest on that.
  for (const writer of ['writeAppConfig', 'writeGatewayPort']) {
    const { dir, configPath } = scratchConfig(baseConfig);
    try {
      built.invalidateAppConfigCache();
      built.readAppConfigCached(configPath); // arm

      const throwForConfig = (filePath) => {
        if (path.resolve(filePath) === path.resolve(configPath)) throw new Error('ACL denied');
      };
      assert.throws(() => {
        if (writer === 'writeAppConfig') built.writeAppConfig(configPath, { language: 'ru' }, throwForConfig);
        else built.writeGatewayPort(configPath, 41777, throwForConfig);
      }, /ACL denied/, `${writer} was expected to surface the protector failure`);

      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const cached = built.readAppConfigCached(configPath);
      assert.equal(cached.language, onDisk.language,
        `${writer}: the cached language (${cached.language}) disagrees with disk (${onDisk.language}) `
        + 'after the protector threw. Invalidation must be in a finally, not a trailing statement.');
      assert.equal(cached.gatewayPort, onDisk.gatewayPort,
        `${writer}: the cached port (${cached.gatewayPort}) disagrees with disk (${onDisk.gatewayPort}).`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('an UNREADABLE config is never cached, so defaults cannot outlive the failure', () => {
  // readAppConfig() returns defaults for a file it could not parse and gives the
  // caller no way to tell that apart from a file that really said port 12000.
  // Caching that is not staleness, it is FABRICATION that outlives its cause.
  // MEASURED before the fix, with a half-written config.json: the cached reader
  // pinned gatewayPort 12000 and setupComplete:false, and both stayed wrong
  // AFTER the file was repaired. setupComplete:false is what decides whether the
  // renderer shows the first-run setup wizard.
  const { dir, configPath } = scratchConfig(baseConfig);
  try {
    built.invalidateAppConfigCache();
    fs.writeFileSync(configPath, '{ "version": 1, "gatewayPort": 41100, "langu', 'utf8');

    const whileBroken = built.readAppConfigCached(configPath);
    assert.equal(whileBroken.gatewayPort, 12000, 'a broken file still yields defaults for this call');

    // The file becomes readable again. Nothing the app did, so nothing invalidated.
    fs.writeFileSync(configPath, JSON.stringify(baseConfig, null, 2), 'utf8');

    const after = built.readAppConfigCached(configPath);
    assert.equal(after.gatewayPort, 41100,
      'the cached reader kept serving DEFAULTS after config.json became readable again. A parse '
      + 'failure must not be cached: it is not the file\'s contents, it is the absence of them.');
    assert.equal(after.setupComplete, true,
      'setupComplete was pinned false by a transient read failure, which is what drives the '
      + 'first-run setup wizard');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a config.json holding a NON-OBJECT never throws out of either reader', () => {
  // JSON.parse('null') succeeds and returns null. The old reader assigned that
  // straight into its `config` local and then read config.performanceMode off it:
  // MEASURED, a config.json containing literal `null` threw "Cannot read
  // properties of null (reading 'performanceMode')" out of readAppConfig. That
  // reader is the merge base for every write and runs on the startup path, so the
  // throw was reachable from a truncated or externally mangled file.
  const { dir, configPath } = scratchConfig(baseConfig);
  try {
    for (const contents of ['null', '[1,2]', '5', '"str"', 'true']) {
      fs.writeFileSync(configPath, contents, 'utf8');
      built.invalidateAppConfigCache();
      const fresh = built.readAppConfig(configPath);
      assert.equal(fresh.gatewayPort, 12000, `readAppConfig must default for ${contents}`);
      assert.equal(fresh.language, 'en', `readAppConfig must default for ${contents}`);
      const cached = built.readAppConfigCached(configPath);
      assert.equal(cached.gatewayPort, 12000, `readAppConfigCached must default for ${contents}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the cached object is DEEPLY frozen, so no caller can poison a later read', () => {
  // The cached value is handed by reference to every caller. Freezing only the
  // top level and the perModelSettings MAP left the per-model ENTRIES writable.
  // MEASURED before the fix: one `entry.enabled = false` silently poisoned every
  // subsequent cached read while disk still said true.
  const { dir, configPath } = scratchConfig({
    ...baseConfig,
    perModelSettings: { 'z-ai/glm-5.2': { enabled: true, performanceMode: 'day', firstByteTimeoutMs: 300000 } }
  });
  try {
    built.invalidateAppConfigCache();
    const first = built.readAppConfigCached(configPath);
    const entry = first.perModelSettings['z-ai/glm-5.2'];
    assert.equal(entry.enabled, true, 'precondition');
    assert.ok(Object.isFrozen(entry),
      'per-model entries must be frozen: they are handed out by reference, so a mutation by any '
      + 'caller becomes the answer every later cached read gives');

    try { entry.enabled = false; } catch { /* strict mode throws; sloppy mode ignores */ }

    assert.equal(built.readAppConfigCached(configPath).perModelSettings['z-ai/glm-5.2'].enabled, true,
      'a caller mutated a nested entry of the cached config and poisoned every later read');
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
