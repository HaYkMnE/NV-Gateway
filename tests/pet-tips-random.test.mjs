// Spec 2026-10-26 §4.2-4.3 (part C): the 18 random tips, selectRandomTip and the
// pure scheduler helpers in src/renderer/pet/tips.ts. Same bare-vm loading as
// tests/pet-tips.test.mjs (only `react` may be required).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIPS = 'src/renderer/pet/tips.ts';

function loadTips() {
  const compiled = typescript.transpileModule(fs.readFileSync(path.join(root, TIPS), 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, {
    module,
    exports: module.exports,
    window: { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
    require: (id) => {
      if (id === 'react') return { useSyncExternalStore: (_s, g) => g(), useMemo: (f) => f() };
      throw new Error(`unexpected require: ${id}`);
    },
  }, { filename: TIPS });
  return module.exports;
}

const lib = loadTips();
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;

// Spec §4.7: existing + new ids.
const SPEC_IDS = new Set([
  'dash-add-key', 'request-deadline', 'setting-tips', 'setting-llm-stats', 'setting-updates', 'endpoint-gateway-token', 'endpoint-model-id',
  'setting-auto-launch', 'setting-performance-mode', 'setting-language', 'endpoint-url-anthropic', 'models-filter-free', 'models-sort', 'logs-pause',
]);

// mulberry32: deterministic [0, 1).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const state = (over = {}) => ({ enabled: true, dismissed: [], lastShownAt: {}, never: [], ...over });
// Every condition true (except S07 which needs >= 3 shown, set here).
const allTrue = (over = {}) => ({
  route: '/wizard', gatewayState: 'running', enabledModelCount: 0, keyCount: 1, anyLegacyDisabled: true,
  autoLaunch: false, performanceMode: 'day', requestDeadlineSource: 'config', requestDeadlineMs: 120_000,
  llmStatsEnabled: true, updateState: 'none', aliveMsThisSession: 31 * 60_000, randomShownThisSession: 3, lastRandomTipId: null, ...over,
});
const byId = (id) => lib.RANDOM_TIP_REGISTRY.find((t) => t.id === id);
const eligibleIds = (ctx, st = state(), now = NOW) => {
  // Enumerate which tips can be picked: draw many times.
  const seen = new Set();
  const rnd = seeded(7);
  for (let i = 0; i < 2000; i += 1) {
    const pick = lib.selectRandomTip(ctx, st, now, rnd);
    if (pick) seen.add(pick.tip.id);
  }
  return seen;
};

test('registry: 18 tips, 11 recommendations / 7 settings, unique ids, spec keys and target ids', () => {
  const reg = lib.RANDOM_TIP_REGISTRY;
  assert.equal(reg.length, 18);
  assert.equal(reg.filter((t) => t.kind === 'recommendation').length, 11);
  assert.equal(reg.filter((t) => t.kind === 'setting').length, 7);
  assert.equal(new Set(reg.map((t) => t.id)).size, 18, 'ids unique');
  assert.equal(new Set(reg.map((t) => t.code)).size, 18, 'codes unique');
  for (const t of reg) {
    assert.match(t.code, /^(r(0[1-9]|1[01])|s0[1-7])$/);
    assert.equal(t.titleKey, `tip_${t.code}_title`);
    assert.equal(t.bodyKey, `tip_${t.code}_body`);
    assert.equal(t.actionKey, `tip_${t.code}_action`);
    if (t.targetId !== null) assert.ok(SPEC_IDS.has(t.targetId), `${t.id} target ${t.targetId} is in spec §4.7`);
    assert.equal(t.kind === 'recommendation', t.code.startsWith('r'));
  }
  assert.equal(byId('no-models').weight, 3, 'R06 weight 3');
  assert.equal(byId('feedback').action, 'feedback');
  assert.equal(byId('feedback').route, null);
  assert.equal(lib.TIP_REGISTRY.length, 2, 'the 2 event tips stay a separate registry');
  assert.deepEqual([...lib.TIP_REGISTRY.map((t) => t.kind)], ['event', 'event']);
});

test('weighted pick: ~2:1 recommendation:setting over 3000 seeded draws', () => {
  const rnd = seeded(42);
  let rec = 0;
  let set = 0;
  for (let i = 0; i < 3000; i += 1) {
    const pick = lib.selectRandomTip(allTrue(), state(), NOW, rnd);
    assert.ok(pick);
    if (pick.tip.kind === 'recommendation') rec += 1; else set += 1;
  }
  const share = rec / 3000;
  assert.ok(share > 0.63 && share < 0.70, `recommendation share ${share}`);
  assert.equal(rec + set, 3000);
});

test('no back-to-back repeat; chosen kind empty -> the other kind; nothing -> null', () => {
  const rnd = seeded(3);
  let last = null;
  for (let i = 0; i < 500; i += 1) {
    const pick = lib.selectRandomTip(allTrue({ lastRandomTipId: last }), state(), NOW, rnd);
    assert.notEqual(pick.tip.id, last);
    last = pick.tip.id;
  }
  // Only settings eligible: never null, always a setting.
  const onlySettings = allTrue({ gatewayState: 'stopped', enabledModelCount: null, keyCount: 2, anyLegacyDisabled: false, llmStatsEnabled: true, aliveMsThisSession: 0 });
  const ids = eligibleIds({ ...onlySettings, llmStatsEnabled: false });
  assert.ok(ids.size > 0);
  for (const id of ids) assert.equal(byId(id).kind, 'setting');
  const none = allTrue({ gatewayState: 'stopped', enabledModelCount: null, keyCount: 2, anyLegacyDisabled: false, llmStatsEnabled: false,
    aliveMsThisSession: 0, autoLaunch: true, performanceMode: 'auto', requestDeadlineSource: 'env', updateState: 'available', randomShownThisSession: 0 });
  assert.equal(lib.selectRandomTip(none, state({ lastShownAt: { language: NOW - 2 * DAY } }), NOW, seeded(1)), null);
});

test('conditions (acceptance 16) and route rule', () => {
  assert.ok(!eligibleIds(allTrue({ autoLaunch: true })).has('auto-launch'), 'S01 hidden when launch-at-sign-in is on');
  const statsUnknown = eligibleIds(allTrue({ llmStatsEnabled: null }));
  assert.ok(!statsUnknown.has('top-sort') && !statsUnknown.has('llm-stats'), 'R08/S04 need llmStatsEnabled === true; null (not loaded) does not qualify');
  assert.ok(!eligibleIds(allTrue({ performanceMode: 'auto' })).has('performance-auto'), 'S02 hidden in Auto');
  assert.ok(!eligibleIds(allTrue({ keyCount: 2 })).has('second-key'), 'R04 only with exactly 1 key');
  assert.ok(eligibleIds(allTrue({ keyCount: 1 })).has('second-key'));
  assert.ok(!eligibleIds(allTrue({ enabledModelCount: 1 })).has('no-models'), 'R06 only with 0 enabled models');
  assert.ok(!eligibleIds(allTrue({ enabledModelCount: null })).has('no-models'), 'R06 needs models loaded');
  assert.ok(!eligibleIds(allTrue({ requestDeadlineSource: 'env' })).has('deadline'), 'S03 hidden when env sets the deadline');
  assert.ok(!eligibleIds(allTrue({ randomShownThisSession: 2 })).has('tips-switch'), 'S07 needs >= 3 shown');
  assert.ok(!eligibleIds(allTrue({ aliveMsThisSession: 29 * 60_000 })).has('feedback'), 'R11 needs 30 min ALIVE');
  assert.ok(!eligibleIds(allTrue(), state({ lastShownAt: { feedback: NOW - 6 * DAY } })).has('feedback'), 'R11 once per 7 days');
  assert.ok(!eligibleIds(allTrue(), state({ lastShownAt: { language: NOW - 30 * DAY } })).has('language'), 'S06 once ever');
  assert.ok(!eligibleIds(allTrue(), state({ lastShownAt: { 'gateway-token': NOW - DAY + 1 } })).has('gateway-token'), '24 h re-arm');
  assert.ok(eligibleIds(allTrue(), state({ lastShownAt: { 'gateway-token': NOW - DAY } })).has('gateway-token'));
  const onSettings = eligibleIds(allTrue({ route: '/settings' }));
  for (const id of onSettings) assert.notEqual(byId(id).route, '/settings', 'no tip on its own target route');
  const deadline = lib.selectRandomTip(allTrue({ requestDeadlineMs: 300_000, gatewayState: 'stopped', enabledModelCount: null, keyCount: 0,
    anyLegacyDisabled: false, llmStatsEnabled: false, aliveMsThisSession: 0, autoLaunch: true, performanceMode: 'auto', updateState: 'x', randomShownThisSession: 0 }),
  state({ lastShownAt: { language: 1 } }), NOW, seeded(9));
  assert.equal(deadline.tip.id, 'deadline');
  assert.equal(deadline.vars.s, '300');
});

test('never list, tips switch off, session cap 8', () => {
  const never = lib.RANDOM_TIP_REGISTRY.map((t) => t.id).filter((id) => id !== 'logs-pause');
  const ids = eligibleIds(allTrue(), state({ never }));
  assert.deepEqual([...ids], ['logs-pause'], 'never-listed tips are skipped');
  assert.equal(lib.selectRandomTip(allTrue(), state({ never: [...never, 'logs-pause'] }), NOW, seeded(1)), null);
  assert.equal(lib.selectRandomTip(allTrue(), state({ enabled: false }), NOW, seeded(1)), null, 'switch off -> no random tip');
  assert.equal(lib.selectTip({ route: '/models', update: { state: 'available', version: '9' } }, state({ enabled: false }), NOW), null,
    'switch off -> no event tip (unchanged)');
  assert.equal(lib.selectRandomTip(allTrue({ randomShownThisSession: 8 }), state(), NOW, seeded(1)), null, 'cap 8');
  assert.ok(lib.selectRandomTip(allTrue({ randomShownThisSession: 7 }), state(), NOW, seeded(1)));
  assert.deepEqual([...lib.parseTipsState(JSON.stringify({ never: ['a', 3] })).never], ['a']);
  assert.deepEqual([...lib.parseTipsState(null).never], []);
});

test('scheduler: delay in [240000, 360000], quiet window 20 s, gate', () => {
  assert.equal(lib.RANDOM_TIP_FIRST_MS, 90_000);
  const rnd = seeded(11);
  for (let i = 0; i < 5000; i += 1) {
    const d = lib.nextRandomTipDelayMs(rnd);
    assert.ok(d >= 240_000 && d <= 360_000, `delay ${d}`);
  }
  assert.equal(lib.nextRandomTipDelayMs(() => 0), 240_000);
  assert.equal(lib.nextRandomTipDelayMs(() => 0.999999999), 360_000);
  assert.equal(lib.nextRandomTipDelayMs(() => NaN), 240_000);

  assert.equal(lib.quietAdjustedTime(1000, null), 1000);
  assert.equal(lib.quietAdjustedTime(100_000, 90_000), 110_000, 'input 10 s before due -> wait to input + 20 s');
  assert.equal(lib.quietAdjustedTime(100_000, 70_000), 100_000, 'input 30 s before -> unchanged');

  const g = (o) => lib.randomTipGate({ now: 100_000, dueAt: 100_000, lastInputAt: null, shownThisSession: 0, enabled: true, ...o });
  assert.deepEqual({ ...g({}) }, { status: 'ready' });
  assert.deepEqual({ ...g({ now: 50_000 }) }, { status: 'wait', at: 100_000 });
  assert.deepEqual({ ...g({ lastInputAt: 99_000 }) }, { status: 'wait', at: 119_000 });
  assert.deepEqual({ ...g({ lastInputAt: 81_000 }) }, { status: 'wait', at: 105_000 }, 'quiet re-check >= 5 s apart');
  assert.deepEqual({ ...g({ lastInputAt: 80_000 }) }, { status: 'ready' }, 'exactly 20 s -> ready');
  assert.deepEqual({ ...g({ shownThisSession: 8 }) }, { status: 'off' });
  assert.deepEqual({ ...g({ enabled: false }) }, { status: 'off' });
});
