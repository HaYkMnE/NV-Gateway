// Wave 6B "pet advisor": registry logic, persistence store and the target-page
// focus helper in src/renderer/pet/tips.ts. The module is transpiled and run in
// a bare vm context (no jsdom in this repo); `react` is a tiny fake whose
// useSyncExternalStore reads the snapshot and whose useMemo memoizes by deps
// with Object.is, i.e. the exact contract React relies on.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIPS = 'src/renderer/pet/tips.ts';

function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function loadTips(storage = createStorage()) {
  const compiled = typescript.transpileModule(fs.readFileSync(path.join(root, TIPS), 'utf8'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
  });
  const memo = { deps: null, value: undefined, computed: 0 };
  const react = {
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useMemo: (factory, deps) => {
      if (memo.deps && deps.length === memo.deps.length && deps.every((d, i) => Object.is(d, memo.deps[i]))) return memo.value;
      memo.deps = deps;
      memo.computed += 1;
      memo.value = factory();
      return memo.value;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, {
    module,
    exports: module.exports,
    window: { localStorage: storage },
    require: (id) => {
      if (id === 'react') return react;
      throw new Error(`unexpected require: ${id}`);
    },
  }, { filename: TIPS });
  return { lib: module.exports, storage, memo };
}

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const fresh = () => ({ enabled: true, dismissed: [], lastShownAt: {} });
const quota = (ms) => ({ status: 'quota-exceeded', backoffUntil: NOW + ms });
const base = { route: '/models', gatewayState: 'running' };

test('J threshold: keys-exhausted needs every key quota-exceeded and the soonest retry >= 30 min away', () => {
  const { lib } = loadTips();
  assert.equal(lib.selectTip({ ...base, keys: [quota(29 * MIN)] }, fresh(), NOW), null, '29 min -> no tip');
  const tip = lib.selectTip({ ...base, keys: [quota(30 * MIN)] }, fresh(), NOW);
  assert.equal(tip?.tip.id, 'keys-exhausted', '30 min -> tip');
  assert.equal(tip.tip.route, '/dashboard');
  assert.equal(tip.tip.targetId, 'dash-add-key');
  assert.equal(tip.occurrenceId, `keys-exhausted:${NOW}`);
  assert.equal(tip.stampAt, NOW, 'a new occurrence asks to be stamped as lastShownAt');
  assert.equal(lib.selectTip({ ...base, keys: [quota(2 * HOUR), quota(29 * MIN)] }, fresh(), NOW), null,
    'the SOONEST retry decides');
});

test('keys-exhausted: zero keys, mixed statuses, not running or unknown data -> no tip', () => {
  const { lib } = loadTips();
  assert.equal(lib.selectTip({ ...base, keys: [] }, fresh(), NOW), null, 'zero keys');
  assert.equal(lib.selectTip({ ...base, keys: undefined }, fresh(), NOW), null, 'keys unknown');
  assert.equal(lib.selectTip({ ...base, keys: [quota(HOUR), { status: 'active', backoffUntil: 0 }] }, fresh(), NOW), null, 'mixed');
  assert.equal(lib.selectTip({ ...base, keys: [quota(HOUR), { status: 'disabled', backoffUntil: 0 }] }, fresh(), NOW), null, 'mixed disabled');
  assert.equal(lib.selectTip({ ...base, gatewayState: 'stopped', keys: [quota(HOUR)] }, fresh(), NOW), null, 'not running');
  assert.equal(lib.selectTip({ ...base, keys: [{ status: 'quota-exceeded', backoffUntil: 'x' }] }, fresh(), NOW), null, 'bad backoff');
});

test('J re-arm: a dismissed keys occurrence stays hidden for 24 h after it was shown, then a new one fires', () => {
  const { lib } = loadTips();
  const keys = [quota(HOUR)];
  const shownAt = NOW - (24 * HOUR - 1);
  const dismissedState = { enabled: true, dismissed: [`keys-exhausted:${shownAt}`], lastShownAt: { 'keys-exhausted': shownAt } };
  assert.equal(lib.selectTip({ ...base, keys }, dismissedState, NOW), null, '24 h minus 1 ms -> still hidden');

  const openState = { enabled: true, dismissed: [], lastShownAt: { 'keys-exhausted': shownAt } };
  const open = lib.selectTip({ ...base, keys }, openState, NOW);
  assert.equal(open?.occurrenceId, `keys-exhausted:${shownAt}`, 'an undismissed occurrence keeps its id');
  assert.equal(open.stampAt, undefined, 'and is not re-stamped');

  const rearmAt = shownAt + 24 * HOUR;
  const rearmed = lib.selectTip({ ...base, keys: [{ status: 'quota-exceeded', backoffUntil: rearmAt + HOUR }] }, dismissedState, rearmAt);
  assert.equal(rearmed?.occurrenceId, `keys-exhausted:${rearmAt}`, 'exactly 24 h -> a NEW occurrence');
  assert.equal(rearmed.stampAt, rearmAt);
});

test('update-available: one occurrence per version, hidden on /settings', () => {
  const { lib } = loadTips();
  const update = { state: 'available', version: '1.2.3', percent: null };
  const tip = lib.selectTip({ ...base, update }, fresh(), NOW);
  assert.equal(tip?.tip.id, 'update-available');
  assert.equal(tip.tip.route, '/settings');
  assert.equal(tip.tip.targetId, 'setting-updates');
  assert.equal(tip.occurrenceId, 'update-available:1.2.3');
  assert.equal(tip.vars?.v, '1.2.3');
  const dismissed = { enabled: true, dismissed: ['update-available:1.2.3'], lastShownAt: {} };
  assert.equal(lib.selectTip({ ...base, update }, dismissed, NOW), null, 'the dismissed version stays dismissed');
  assert.equal(lib.selectTip({ ...base, update: { ...update, version: '1.2.4' } }, dismissed, NOW)?.occurrenceId,
    'update-available:1.2.4', 'a new version is a new occurrence');
  assert.equal(lib.selectTip({ ...base, route: '/settings', update }, fresh(), NOW), null, 'hidden on its target route');
  assert.equal(lib.selectTip({ ...base, update: { ...update, state: 'downloading' } }, fresh(), NOW), null);
});

test('priority, route rule and tips-off', () => {
  const { lib } = loadTips();
  const both = { ...base, keys: [quota(HOUR)], update: { state: 'available', version: '2.0.0', percent: null } };
  assert.equal(lib.selectTip(both, fresh(), NOW)?.tip.id, 'keys-exhausted', 'keys-exhausted wins');
  assert.equal(lib.selectTip({ ...both, route: '/dashboard' }, fresh(), NOW)?.tip.id, 'update-available',
    'keys tip hidden on /dashboard, so the other tip may show');
  const keysDismissed = { enabled: true, dismissed: [`keys-exhausted:${NOW}`], lastShownAt: { 'keys-exhausted': NOW } };
  assert.equal(lib.selectTip(both, keysDismissed, NOW)?.tip.id, 'update-available');
  assert.equal(lib.selectTip(both, { ...fresh(), enabled: false }, NOW), null, 'tips off -> nothing');
});

test('store: getSnapshot returns the raw string, parse is memoized, writes notify subscribers', () => {
  const storage = createStorage({ nv_pet_tips: JSON.stringify({ enabled: false, dismissed: ['a'], lastShownAt: {} }) });
  const { lib, memo } = loadTips(storage);
  assert.equal(lib.TIPS_STORAGE_KEY, 'nv_pet_tips');
  const s1 = lib.getTipsSnapshot();
  const s2 = lib.getTipsSnapshot();
  assert.equal(typeof s1, 'string', 'the snapshot is the raw stored string');
  assert.ok(Object.is(s1, s2), 'the same stored value yields an Object.is-equal snapshot (no render loop)');

  const a = lib.usePetTips();
  const b = lib.usePetTips();
  assert.ok(Object.is(a, b), 'the same raw string yields the same parsed object');
  assert.equal(memo.computed, 1);
  assert.equal(a.enabled, false);

  let calls = 0;
  const unsubscribe = lib.subscribeTips(() => { calls += 1; });
  lib.setTipsEnabled(true);
  assert.equal(calls, 1, 'a write notifies subscribers directly (storage does not fire in-document)');
  assert.equal(JSON.parse(storage.map.get('nv_pet_tips')).enabled, true);
  lib.dismissTipOccurrence('update-available:9');
  lib.markTipShown('keys-exhausted', 123);
  const parsed = JSON.parse(storage.map.get('nv_pet_tips'));
  assert.ok(parsed.dismissed.includes('update-available:9'));
  assert.equal(parsed.lastShownAt['keys-exhausted'], 123);
  assert.equal(calls, 3);
  lib.markTipShown('keys-exhausted', 123);
  assert.equal(calls, 3, 'an unchanged stamp does not write or notify');
  lib.clearTipsState();
  assert.equal(storage.map.has('nv_pet_tips'), false, 'reset removes nv_pet_tips');
  assert.equal(calls, 4);
  unsubscribe();
  lib.setTipsEnabled(false);
  assert.equal(calls, 4, 'unsubscribed listeners are not called');
});

test('store: defaults and hostile stored values', () => {
  const { lib } = loadTips();
  const d = lib.parseTipsState(null);
  assert.equal(d.enabled, true, 'tips are on by default');
  assert.equal(d.dismissed.length, 0);
  assert.equal(lib.parseTipsState('{nope').enabled, true);
  const hostile = lib.parseTipsState(JSON.stringify({ enabled: 'no', dismissed: [1, 'x'], lastShownAt: { a: 'z', b: 5 } }));
  assert.equal(hostile.enabled, true, 'only an explicit false turns tips off');
  assert.deepEqual([...hostile.dismissed], ['x']);
  assert.deepEqual({ ...hostile.lastShownAt }, { b: 5 });
});

test('store: a failing localStorage write does not notify (no stamp/re-render loop)', () => {
  const storage = createStorage();
  storage.setItem = () => { throw new Error('quota'); };
  const { lib } = loadTips(storage);
  let calls = 0;
  lib.subscribeTips(() => { calls += 1; });
  lib.markTipShown('keys-exhausted', 1);
  assert.equal(calls, 0);
});

test('card focus restore: only when focus was in the card AND has fallen to body', () => {
  const { lib } = loadTips();
  const body = { tag: 'body' };
  const make = () => { const log = []; return { log, el: { focus: () => log.push('focus') } }; };

  // Card unmounted/remounted by itself (keys recovered, update installed,
  // new occurrence) while X / the action held focus -> pet button.
  const btn = make();
  assert.equal(lib.restoreCardFocus(true, { activeElement: body, body }, btn.el), true);
  assert.deepEqual(btn.log, ['focus']);
  const nullActive = make();
  assert.equal(lib.restoreCardFocus(true, { activeElement: null, body }, nullActive.el), true, 'null activeElement counts as lost');

  // The action navigated and the target page already focused its <h2>: never steal it.
  const h2 = { tag: 'h2' };
  const nav = make();
  assert.equal(lib.restoreCardFocus(true, { activeElement: h2, body }, nav.el), false);
  assert.equal(nav.log.length, 0);

  // Tips-off from the Settings switch: focus was never in the card, so it stays on the switch.
  const toggle = { id: 'setting-tips' };
  const off = make();
  assert.equal(lib.restoreCardFocus(false, { activeElement: toggle, body }, off.el), false);
  assert.equal(lib.restoreCardFocus(false, { activeElement: body, body }, off.el), false, 'not in card -> never moved');
  assert.equal(off.log.length, 0);
  assert.equal(lib.restoreCardFocus(true, { activeElement: body, body }, null), false, 'no pet button -> no-op');
});

test('focus fallback: the target is focused only if it exists and is enabled', () => {
  const { lib } = loadTips();
  const make = (disabled) => {
    const log = [];
    return { log, el: { disabled, focus: (o) => log.push(['focus', o?.preventScroll]), scrollIntoView: (o) => log.push(['scroll', o?.block]) } };
  };
  const ok = make(false);
  assert.equal(lib.focusPendingSetting('dash-add-key', (id) => (id === 'dash-add-key' ? ok.el : null)), 'target');
  assert.deepEqual(ok.log, [['focus', true], ['scroll', 'nearest']]);

  const off = make(true);
  assert.equal(lib.focusPendingSetting('dash-add-key', () => off.el), 'heading', 'disabled target -> heading keeps focus');
  assert.equal(off.log.length, 0);
  assert.equal(lib.focusPendingSetting('missing', () => null), 'heading', 'absent target -> heading');
  assert.equal(lib.focusPendingSetting(undefined, () => ok.el), 'heading', 'no pending id -> heading');
  assert.equal(lib.focusPendingSetting(42, () => ok.el), 'heading');
});
