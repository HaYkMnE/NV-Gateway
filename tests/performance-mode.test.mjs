import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPerformanceModeResolver, readPerModelFailoverAttempts, readPerModelPerformanceMode, readPerModelRateLimitAttempts } from '../src/gateway/performance-mode.mjs';

// The per-model failover cache is module-global and keyed by configPath on its
// fast path, so a transient FS error on config B must never be answered with
// records that were cached while reading a different config A. Keeping
// last-known data is only safe when it is last-known FOR THE SAME PATH —
// otherwise one operator's (or test's) levers silently steer another config.
test('per-model failover cache does not leak across config paths on transient FS error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nv-perf-mode-${process.pid}-`));
  const configA = path.join(dir, 'config-a.json');
  // Path B is never created: statSync(configB) throws (simulated transient error).
  const configB = path.join(dir, 'config-b.json');

  fs.writeFileSync(configA, JSON.stringify({
    perModelSettings: {
      'VendorA/Model-X': { maxFailoverAttempts: 5 }
    }
  }));

  // Prime the module-level cache via config A (case-insensitive key stored).
  assert.equal(readPerModelFailoverAttempts('vendora/model-x', configA), 5);

  // A read against the never-existing config B must report "no override"
  // (null), not plagiarise config A's records just because its stat failed.
  assert.equal(readPerModelFailoverAttempts('vendora/model-x', configB), null);

  // Same-path transient error DOES still serve last-known records for that path.
  fs.rmSync(configA);
  assert.equal(readPerModelFailoverAttempts('vendora/model-x', configA), 5);
});

// ─── Per-model performanceMode (request-time) ────────────────────────────────
//
// Contract: config.perModelSettings[modelId].performanceMode applies to a model
// id matched the SAME way every other perModelSettings knob in this gateway is
// matched — case-insensitively (both the config keys and the requested id are
// lowercased, mirroring readPerModelFailoverAttempts). Prefix/family ids must
// NOT inherit it; invalid values fall back to the global performanceMode;
// explicit GATEWAY_* env knobs keep their highest priority per knob.

test('the BOM stripper uses the escaped form and the source embeds no literal BOM', () => {
  // A literal U+FEFF inside a regex is invisible in editors/diffs — the escaped
  // form is the reviewable spelling. The module source must be free of it.
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src/gateway/performance-mode.mjs'), 'utf8');
  assert.equal(source.includes(String.fromCodePoint(0xFEFF)), false, 'a literal U+FEFF must never be embedded in the module source');
  assert.equal(/readFileSync\(configPath/.test(source), true, 'readSelectedMode still reads config.json');
});

test('readPerModelPerformanceMode matches the sibling-knob convention: case-insensitive, exact id only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-' + process.pid + '-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    performanceMode: 'day',
    perModelSettings: {
      'Vendor/MODEL': { performanceMode: 'night' },
      'Other/Model': { performanceMode: 'day' },
      'idlike/model-CASE': { performanceMode: 'night' },
      'broken/model': { performanceMode: 'turbo' }
    }
  }));

  // Case-insensitive both directions — matches the sibling perModelSettings convention.
  assert.equal(readPerModelPerformanceMode('vendor/model', configPath), 'night', 'config key case is normalized');
  assert.equal(readPerModelPerformanceMode('VENDOR/MODEL', configPath), 'night', 'request case is normalized');
  assert.equal(readPerModelPerformanceMode('Vendor/Model', configPath), 'night', 'mixed case hits the same record');
  // Exact id only — no prefix/family bleed.
  assert.equal(readPerModelPerformanceMode('vendor/model-x', configPath), null, 'prefix must NOT inherit');
  assert.equal(readPerModelPerformanceMode('vendor', configPath), null, 'vendor alone is not a match');
  assert.equal(readPerModelPerformanceMode('idlike/model-case', configPath), 'night', 'normalization is bidirectional');
  // Invalid value -> global fallback (null).
  assert.equal(readPerModelPerformanceMode('broken/model', configPath), null, 'invalid mode -> fallback');
  // Defensive: absence/blank/other-shaped entries are not overrides.
  assert.equal(readPerModelPerformanceMode('nonexistent/model', configPath), null);
  assert.equal(readPerModelPerformanceMode('', configPath), null);
  assert.equal(readPerModelPerformanceMode(undefined, configPath), null);
  assert.equal(readPerModelPerformanceMode(null, configPath), null);
});

test('readPerModelPerformanceMode returns null without a config or without the setting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-no-' + process.pid + '-'));
  assert.equal(readPerModelPerformanceMode('any/model', path.join(dir, 'absent.json')), null, 'a missing file yields null');
  const bare = path.join(dir, 'bare.json');
  fs.writeFileSync(bare, JSON.stringify({ performanceMode: 'night' }));
  assert.equal(readPerModelPerformanceMode('any/model', bare), null, 'no perModelSettings -> no override');
  const empty = path.join(dir, 'empty.json');
  fs.writeFileSync(empty, JSON.stringify({ performanceMode: 'day', perModelSettings: {} }));
  assert.equal(readPerModelPerformanceMode('any/model', empty), null, 'empty dict -> no override');
});

test('resolver applies per-model performanceMode exactly: same id (case-insensitive) gets it; prefix does not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-res-' + process.pid + '-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    performanceMode: 'day',
    perModelSettings: {
      'Moonshotai/KimI-K2': { performanceMode: 'night' }
    }
  }));
  const resolver = createPerformanceModeResolver({ configPath });

  const exactLower = resolver.resolve('moonshotai/kimi-k2');
  assert.equal(exactLower.selected, 'day');
  assert.equal(exactLower.effective, 'night', 'case-insensitive exact id -> per-model night');
  assert.equal(exactLower.firstByteTimeoutMs, 120_000, 'night profile applies');

  const nearMatch = resolver.resolve('moonshotai/kimi-k2-extra');
  assert.equal(nearMatch.effective, 'day', 'prefix extension must NOT inherit the per-model mode');
  assert.equal(nearMatch.firstByteTimeoutMs, 300_000, 'global day applies');

  const unrelated = resolver.resolve('openai/gpt-4');
  assert.equal(unrelated.effective, 'day');

  const globalModelless = resolver.resolve();
  assert.equal(globalModelless.effective, 'day', 'no model id -> global mode');
});

test('per-model performanceMode falls back to global when invalid or unset; env knob beats both', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-env-' + process.pid + '-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    performanceMode: 'night',
    perModelSettings: {
      'bad/model': { performanceMode: 'turbo' },
      'no-key/model': {},
      'day/model': { performanceMode: 'day' }
    }
  }));

  const resolver = createPerformanceModeResolver({ configPath });
  assert.equal(resolver.resolve('bad/model').effective, 'night', 'invalid mode falls back to global night');
  assert.equal(resolver.resolve('no-key/model').effective, 'night', 'missing performanceMode falls back to global');
  assert.equal(resolver.resolve('day/model').effective, 'day', 'valid per-model override applies');

  // Explicit env knob beats per-model AND global.
  const envForced = createPerformanceModeResolver({
    configPath,
    env: { GATEWAY_FIRST_BYTE_TIMEOUT_MS: '45000' }
  });
  assert.equal(envForced.resolve('day/model').firstByteTimeoutMs, 45_000, 'env knob overrides per-model day profile');
  assert.equal(envForced.resolve('unconfigured/model').firstByteTimeoutMs, 45_000, 'env knob overrides global night');
});

test('unchanged metadata reuses parsed config while every lookup rechecks metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-stat-' + process.pid + '-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    performanceMode: 'night',
    perModelSettings: {
      'test/model': { performanceMode: 'day', maxFailoverAttempts: 4, rateLimitMaxAttempts: 2 }
    }
  }));

  let statCalls = 0;
  let readCalls = 0;
  const originalStatSync = fs.statSync;
  const originalReadFileSync = fs.readFileSync;
  fs.statSync = function(...args) {
    statCalls++;
    return originalStatSync.apply(this, args);
  };
  fs.readFileSync = function(...args) {
    if (args[0] === configPath) readCalls++;
    return originalReadFileSync.apply(this, args);
  };

  try {
    const resolver = createPerformanceModeResolver({ configPath });
    resolver.resolve('test/model');
    readPerModelFailoverAttempts('test/model', configPath);
    readPerModelRateLimitAttempts('test/model', configPath);

    // resolve() performs three config lookups (selected mode, per-model
    // performanceMode, per-model firstByteTimeoutMs) and the two explicit
    // readers add one each — five lookups, five stats, ONE parse.
    assert.equal(statCalls, 5, 'each config lookup must recheck metadata so synchronous rewrites are visible');
    assert.equal(readCalls, 1, 'unchanged metadata must reuse the parsed config');
  } finally {
    fs.statSync = originalStatSync;
    fs.readFileSync = originalReadFileSync;
  }
});

test('same-turn equal-size day to night rewrite is visible immediately and keeps all night knobs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-rewrite-' + process.pid + '-'));
  const configPath = path.join(dir, 'config.json');
  const dayJson = '{"performanceMode":"day"}  ';
  const nightJson = '{"performanceMode":"night"}';
  assert.equal(Buffer.byteLength(dayJson), Buffer.byteLength(nightJson), 'the rewrite fixture must keep file size unchanged');
  fs.writeFileSync(configPath, dayJson, 'utf8');
  fs.utimesSync(configPath, new Date(1_000), new Date(1_000));
  const resolver = createPerformanceModeResolver({ configPath, env: {} });
  assert.equal(resolver.resolve().effective, 'day');

  fs.writeFileSync(configPath, nightJson, 'utf8');
  fs.utimesSync(configPath, new Date(2_000), new Date(2_000));
  const night = resolver.resolve();
  assert.deepEqual(night, {
    selected: 'night',
    effective: 'night',
    firstByteTimeoutMs: 120_000,
    idleTimeoutMs: 120_000,
    maxStreamDurationMs: 600_000,
    maxFailoverAttempts: 2
  });
});

// ─── Auto-mode calibration: hysteresis + sustained evidence ──────────────────
//
// Live-log evidence (2026-09-09..19, 8123 outcomes) for the OLD single-sample
// rules: 107 logged transitions, 38 gaps under 5 min — the GLOBAL mode flapped
// because promote demanded 16/20 completed AND 0 first-byte timeouts (near
// impossible while ONE dead model keeps timing out), while demote fired on a
// single 2-timeout evaluation. The new contract: a candidate must be backed by
// AUTO_SWITCH_CONFIRMATIONS consecutive evaluations AND a materially longer
// dwell. Replaying the same real stream: 112 transitions / 39 sub-5-minute gaps
// (old) vs 92 / 0 (new).

function writeAutoConfig(dir) {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ performanceMode: 'auto' }), 'utf8');
  return configPath;
}

const DAY_PROFILE = { firstByteTimeoutMs: 300_000, idleTimeoutMs: 300_000, maxStreamDurationMs: 1_800_000, maxFailoverAttempts: 3 };
const NIGHT_PROFILE = { firstByteTimeoutMs: 120_000, idleTimeoutMs: 120_000, maxStreamDurationMs: 600_000, maxFailoverAttempts: 2 };

function makeAuto(dirName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nv-perf-auto-${dirName}-${process.pid}-`));
  const configPath = writeAutoConfig(dir);
  let nowMs = 0;
  const transitions = [];
  const resolver = createPerformanceModeResolver({
    configPath,
    env: {},
    now: () => nowMs,
    onEffectiveChange: (state) => transitions.push(state)
  });
  return { dir, resolver, transitions, setNow: (t) => { nowMs = t; } };
}

test('auto: cold start stays day with less than MIN_SAMPLES outcomes', () => {
  const h = makeAuto('cold');
  try {
    assert.equal(h.resolver.resolve().effective, 'day', 'no evidence -> conservative day');
    for (let i = 0; i < 9; i++) h.resolver.observe('completed');
    assert.equal(h.resolver.resolve().effective, 'day', '9 samples (< MIN_SAMPLES=10) must not promote');
    assert.equal(h.transitions.length, 0);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('auto: a sustained healthy window promotes to night and STAYS night', () => {
  const h = makeAuto('stay-night');
  try {
    // A filled, clean window (20/20 completed, zero pressure).
    for (let i = 0; i < 20; i++) h.resolver.observe('completed');
    // The first window is evaluated by resolve(); it takes
    // AUTO_SWITCH_CONFIRMATIONS consecutive evaluations of DISTINCT windows
    // (a new outcome between them) to promote.
    assert.equal(h.resolver.resolve().effective, 'day', 'one clean evaluation must not flip on its own');
    h.resolver.observe('completed');
    assert.equal(h.resolver.resolve().effective, 'day', 'evaluation #2 must not flip either');
    h.resolver.observe('completed');
    assert.equal(h.resolver.resolve().effective, 'night', 'the confirmed #3 evaluation promotes to night');
    assert.deepEqual(h.transitions.map((t) => t.effective), ['night']);

    // A single noise blip is NOT a demote signal under the rebalanced bars.
    h.resolver.observe('first_byte_timeout');
    assert.equal(h.resolver.resolve().effective, 'night', '2/20 pressure (10%) is well below the demote bar');
    h.setNow(10_000_000);
    assert.equal(h.resolver.resolve().effective, 'night', 'still night with a clean-ish window and elapsed dwell');
    assert.equal(h.transitions.length, 1, 'no demote must be announced');
    void DAY_PROFILE; void NIGHT_PROFILE;
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('auto: a sustained slow window demotes to day and STAYS day', () => {
  const h = makeAuto('stay-day');
  try {
    for (let i = 0; i < 20; i++) h.resolver.observe('completed');
    h.resolver.resolve(); h.resolver.observe('completed');
    h.resolver.resolve(); h.resolver.observe('completed');
    assert.equal(h.resolver.resolve().effective, 'night', 'baseline reaches night');

    // Sustained pressure: 12/20 pressure (60%) > 0.4, and 6 first-byte timeouts
    // >= 4 — well past both demote bars. The dwell starts at the promote.
    for (let i = 0; i < 12; i++) h.resolver.observe('first_byte_timeout');
    h.setNow(600_000); // exactly MIN_DWELL_MS after the promote at t=0
    assert.equal(h.resolver.resolve().effective, 'night', 'demote needs CONFIRMATIONS consecutive evaluations too');
    h.resolver.observe('first_byte_timeout');
    assert.equal(h.resolver.resolve().effective, 'night', 'evaluation #2');
    h.resolver.observe('first_byte_timeout');
    assert.equal(h.resolver.resolve().effective, 'day', 'confirmed #3 demotes to day');
    assert.deepEqual(h.transitions.map((t) => t.effective), ['night', 'day']);

    // Even a now-clean window must not flip back within the dwell window.
    for (let i = 0; i < 20; i++) h.resolver.observe('completed');
    h.setNow(600_000 + 599_999);
    assert.equal(h.resolver.resolve().effective, 'day', '1ms before the dwell the mode must not move');
    h.setNow(600_000 + 600_000);
    h.resolver.observe('completed'); h.resolver.resolve();
    h.resolver.observe('completed');
    assert.equal(h.resolver.resolve().effective, 'night', 'after a FULL fresh dwell a sustained clean window may promote again');
    h.setNow(999_999_999);
    assert.equal(h.resolver.resolve().effective, 'night', 'and it then stays night');
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('auto: a noisy window (few timeouts, many successes) does not flap within the dwell', () => {
  const h = makeAuto('noisy');
  try {
    // Promote on a clean window, then inject exactly the kind of pollution that
    // used to hair-trigger the OLD 2-timeout demote.
    for (let i = 0; i < 20; i++) h.resolver.observe('completed');
    h.resolver.resolve(); h.resolver.observe('completed');
    h.resolver.resolve(); h.resolver.observe('completed');
    assert.equal(h.resolver.resolve().effective, 'night');
    const promotedAt = 0;

    // One timeout every 8 outcomes = 12.5% pressure and AT MOST 2 timeouts in
    // any 20-sample window: well below AUTO_DEMOTE_PRESSURE_RATIO (0.4) and
    // below AUTO_DEMOTE_FIRST_BYTE_TIMEOUTS (4). The old 2-timeout trigger would
    // have demanded a demote at every fourth evaluation; this must hold night.
    for (let i = 0; i < 40; i++) {
      h.resolver.observe(i % 8 === 0 ? 'first_byte_timeout' : 'completed');
      h.setNow(promotedAt + (i + 1) * 45_000); // a new evaluation every 45s
      assert.equal(h.resolver.resolve().effective, 'night', `noisy evaluation ${i} must not flap the mode`);
    }
    assert.equal(h.transitions.length, 1, 'the noisy window must produce NO extra transition');
    assert.equal(h.resolver.getState().firstByteTimeouts <= 3, true, 'the fixture must stay under the demote bar');
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('auto: a single triggering evaluation cannot switch before AUTO_SWITCH_CONFIRMATIONS', () => {
  const h = makeAuto('confirm');
  try {
    for (let i = 0; i < 20; i++) h.resolver.observe('completed');
    // Freshly STARTED evaluations (new outcome observed before each resolve), so
    // the confirmation streak advances by one per call — the real steady-state
    // call pattern (one outcome per request, one resolve per request).
    h.resolver.observe('completed'); // evaluation #1 against the clean window
    h.setNow(1_000_000);
    assert.equal(h.resolver.resolve().effective, 'day', 'evaluation #1 of a clean window: no switch yet');
    h.resolver.observe('completed'); // evaluation #2
    h.setNow(2_000_000);
    assert.equal(h.resolver.resolve().effective, 'day', 'evaluation #2: still no switch');
    h.resolver.observe('completed'); // evaluation #3
    h.setNow(3_000_000);
    assert.equal(h.resolver.resolve().effective, 'night', 'evaluation #3 confirms the switch');
    assert.equal(h.transitions.length, 1);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('auto: repeated resolve() over an UNCHANGED window counts as one confirmation, not many', () => {
  const h = makeAuto('no-inflate');
  try {
    for (let i = 0; i < 20; i++) h.resolver.observe('completed');
    // server.mjs resolves several times per request (start, fallbacks); none of
    // those extra calls is new evidence, so they must not advance the streak.
    for (let i = 0; i < 10; i++) {
      assert.equal(h.resolver.resolve().effective, 'day', `re-evaluation ${i + 1} of the same window must not switch`);
    }
    assert.equal(h.transitions.length, 0, 'no transition without new evidence');
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('auto: 3 distinct agreeing windows switch; a held-back switch commits once the dwell elapses', () => {
  const h = makeAuto('distinct-windows');
  try {
    for (let i = 0; i < 20; i++) h.resolver.observe('completed');
    assert.equal(h.resolver.resolve().effective, 'day', 'window #1');
    h.resolver.observe('completed');
    assert.equal(h.resolver.resolve().effective, 'day', 'window #2');
    h.resolver.observe('completed');
    assert.equal(h.resolver.resolve().effective, 'night', 'window #3 confirms the promote');

    for (let i = 0; i < 12; i++) h.resolver.observe('first_byte_timeout');
    h.setNow(599_999);
    assert.equal(h.resolver.resolve().effective, 'night', 'demote window #1, dwell pending');
    h.resolver.observe('first_byte_timeout');
    assert.equal(h.resolver.resolve().effective, 'night', 'demote window #2, dwell pending');
    h.resolver.observe('first_byte_timeout');
    assert.equal(h.resolver.resolve().effective, 'night', 'demote window #3 confirmed but held by the dwell');
    h.setNow(600_000);
    assert.equal(h.resolver.resolve().effective, 'day', 'the confirmed demote commits when the dwell elapses');
    assert.deepEqual(h.transitions.map((t) => t.effective), ['night', 'day']);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

// ─── Per-model firstByteTimeoutMs (request-time) ─────────────────────────────
//
// Contract: config.perModelSettings[modelId].firstByteTimeoutMs is the
// operator's per-model first-byte budget. It rides ON TOP of the selected
// profile (global mode, auto-effective mode, or a per-model performanceMode)
// and BELOW the explicit GATEWAY_FIRST_BYTE_TIMEOUT_MS env knob — precedence
// per knob: env > perModelSettings > profile. Matching follows the sibling
// perModelSettings convention (case-insensitive, exact id, no prefix bleed);
// invalid values fall back to the profile default. The gateway child reads
// the config stat/mtime/size-cached per request, so an operator's config edit
// takes effect for the NEXT request without an app restart.

test('per-model firstByteTimeoutMs applies to the exact id only; other models keep the profile default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-fbt-' + process.pid + '-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    performanceMode: 'day',
    perModelSettings: {
      'Z-AI/GLM-5.3': { firstByteTimeoutMs: 25_000 }
    }
  }));
  const resolver = createPerformanceModeResolver({ configPath, env: {} });

  // Exact id, case-insensitive both directions — the sibling-knob convention.
  const glm = resolver.resolve('z-ai/glm-5.3');
  assert.equal(glm.firstByteTimeoutMs, 25_000, 'config key case is normalized');
  assert.equal(resolver.resolve('Z-AI/GLM-5.3').firstByteTimeoutMs, 25_000, 'request case is normalized');
  // Only the first-byte knob is overridden; the rest stay profile-owned.
  assert.equal(glm.effective, 'day', 'a timeout knob must not change the mode');
  assert.equal(glm.idleTimeoutMs, 300_000, 'idle stays profile-owned');
  assert.equal(glm.maxStreamDurationMs, 1_800_000, 'stream stays profile-owned');
  assert.equal(glm.maxFailoverAttempts, 3, 'failover stays profile-owned');
  // Other/prefix ids and modelless resolution keep the day profile default.
  assert.equal(resolver.resolve('z-ai/glm-5.3-flash').firstByteTimeoutMs, 300_000, 'prefix must NOT inherit');
  assert.equal(resolver.resolve('other/model').firstByteTimeoutMs, 300_000, 'unconfigured model keeps the profile default');
  assert.equal(resolver.resolve().firstByteTimeoutMs, 300_000, 'modelless resolution keeps the global profile');
});

test('invalid per-model firstByteTimeoutMs values fall back to the profile default; a valid sibling entry still applies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-fbt-invalid-' + process.pid + '-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    performanceMode: 'night',
    perModelSettings: {
      'good/model': { firstByteTimeoutMs: 25_000 },
      'zero/model': { firstByteTimeoutMs: 0 },
      'neg/model': { firstByteTimeoutMs: -1 },
      'frac/model': { firstByteTimeoutMs: 1.5 },
      'str/model': { firstByteTimeoutMs: '25000' },
      'bool/model': { firstByteTimeoutMs: true },
      'null/model': { firstByteTimeoutMs: null },
      'empty/model': {}
    }
  }));
  const resolver = createPerformanceModeResolver({ configPath, env: {} });
  assert.equal(resolver.resolve('good/model').firstByteTimeoutMs, 25_000, 'a valid sibling entry applies');
  for (const id of ['zero/model', 'neg/model', 'frac/model', 'str/model', 'bool/model', 'null/model', 'empty/model']) {
    assert.equal(resolver.resolve(id).firstByteTimeoutMs, 120_000, `${id} must fall back to the night profile default`);
  }
});

test('an above-ceiling per-model firstByteTimeoutMs is rejected (profile default applies); the boundary is accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-fbt-max-' + process.pid + '-'));
  const configPath = path.join(dir, 'config.json');
  // The documented ceiling is MAX_UPSTREAM_TIMEOUT_MS (upstream-timeouts.mjs:4).
  const CEILING = 1_800_000;
  fs.writeFileSync(configPath, JSON.stringify({
    performanceMode: 'day',
    perModelSettings: {
      'over/model': { firstByteTimeoutMs: 1_800_001 },
      'huge/model': { firstByteTimeoutMs: 10 ** 12 },
      'at/max': { firstByteTimeoutMs: CEILING }
    }
  }));
  const resolver = createPerformanceModeResolver({ configPath, env: {} });

  assert.equal(resolver.resolve('over/model').firstByteTimeoutMs, 300_000,
    'one over the ceiling must be REJECTED, leaving the day profile default');
  assert.equal(resolver.resolve('huge/model').firstByteTimeoutMs, 300_000,
    'a huge value (10^12) must not be cached as an effectively infinite first-byte wait');
  assert.equal(resolver.resolve('at/max').firstByteTimeoutMs, CEILING,
    'the boundary value itself must be accepted');
});

test('precedence per knob: env GATEWAY_FIRST_BYTE_TIMEOUT_MS > perModelSettings > profile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-fbt-env-' + process.pid + '-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    performanceMode: 'day',
    perModelSettings: {
      'm': { firstByteTimeoutMs: 25_000 },
      'nightmode/model': { performanceMode: 'night', firstByteTimeoutMs: 25_000 }
    }
  }));

  const resolver = createPerformanceModeResolver({ configPath, env: {} });
  assert.equal(resolver.resolve('m').firstByteTimeoutMs, 25_000, 'per-model beats the day profile');
  const onNight = resolver.resolve('nightmode/model');
  assert.equal(onNight.effective, 'night', 'the per-model mode still selects the night profile');
  assert.equal(onNight.firstByteTimeoutMs, 25_000, 'the per-model timeout applies on top of the per-model night profile');
  assert.equal(onNight.idleTimeoutMs, 120_000, 'night profile idle is untouched');

  const envForced = createPerformanceModeResolver({
    configPath,
    env: { GATEWAY_FIRST_BYTE_TIMEOUT_MS: '45000' }
  });
  assert.equal(envForced.resolve('m').firstByteTimeoutMs, 45_000, 'the env knob beats the per-model value');
  assert.equal(envForced.resolve('nightmode/model').firstByteTimeoutMs, 45_000, 'the env knob beats per-model mode + per-model value');
  assert.equal(envForced.resolve('other/model').firstByteTimeoutMs, 45_000, 'the env knob beats the global profile');
});

test('a same-turn config rewrite of per-model firstByteTimeoutMs is visible on the next request', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-fbt-rewrite-' + process.pid + '-'));
  const configPath = path.join(dir, 'config.json');
  const writeAt = (contents, mtime) => {
    fs.writeFileSync(configPath, contents, 'utf8');
    fs.utimesSync(configPath, new Date(mtime), new Date(mtime));
  };
  writeAt(JSON.stringify({ performanceMode: 'day', perModelSettings: { 'm': {} } }), 1_000);
  const resolver = createPerformanceModeResolver({ configPath, env: {} });
  assert.equal(resolver.resolve('m').firstByteTimeoutMs, 300_000, 'before the edit the day profile applies');

  writeAt(JSON.stringify({ performanceMode: 'day', perModelSettings: { 'm': { firstByteTimeoutMs: 25_000 } } }), 2_000);
  assert.equal(resolver.resolve('m').firstByteTimeoutMs, 25_000, 'the added override must reach the next request without a restart');

  writeAt(JSON.stringify({ performanceMode: 'day', perModelSettings: { 'm': { firstByteTimeoutMs: 40_000 } } }), 3_000);
  assert.equal(resolver.resolve('m').firstByteTimeoutMs, 40_000, 'an edited override value must be picked up');

  writeAt(JSON.stringify({ performanceMode: 'day', perModelSettings: { 'm': {} } }), 4_000);
  assert.equal(resolver.resolve('m').firstByteTimeoutMs, 300_000, 'removing the override restores the profile default');
});
