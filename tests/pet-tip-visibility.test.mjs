// PET-SPEC 2026-10-26 §4.1/§4.6 ("the card shows on return") and §7:
//  1. a random tip cleared by a hide, or closed unread (< 3 s, no dismiss/action),
//     is NOT counted, NOT stamped and is re-offered when the pet is ALIVE again;
//  2. the random-tip ALIVE clock also requires main's view of the window
//     (window-state bridge); without the bridge the document signals decide.
// Pure exports run for real; React and main/preload wiring are pinned at source
// level, the same way tests/clipboard-write-via-main.test.mjs pins its handler.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const SRC = read('src/renderer/pet/PetWidget.tsx');
const MAIN = read('src/main/index.ts');
const PRELOAD = read('src/preload/index.ts');
const storage = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };

function load(file, stubs, jsx) {
  const out = typescript.transpileModule(read(file), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, ...(jsx ? { jsx: typescript.JsxEmit.React } : {}) },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(out, {
    module: mod, exports: mod.exports, console, performance, Math, Number, window: storage,
    require: (id) => { if (id in stubs) return stubs[id]; throw new Error(`unexpected require: ${id}`); },
  }, { filename: file });
  return mod.exports;
}

const T = load('src/renderer/pet/tips.ts', { react: { useSyncExternalStore: (_s, g) => g(), useMemo: (f) => f() } });
const W = load('src/renderer/pet/PetWidget.tsx', {
  react: {}, 'react-i18next': {}, '@tanstack/react-query': {}, 'react-router-dom': {}, 'lucide-react': {},
  '../lib/api': {}, '../lib/modal-context': {}, './tips': T, './pet.css': {}, './audioEngine': { petAudio: {} }, './petEngine': {},
}, true);

function clock() {
  let t = 0; let seq = 0; const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); t = due[1].at; due[1].fn();
      }
      t = end;
    },
  };
}

/** Mirrors the widget's random-tip host (PetWidget speakHostRef show/hide) on the real helpers. */
function harness() {
  const c = clock();
  const s = { shown: 0, stamped: [], lastId: null, pending: null, roundsDone: 0, shownAt: 0, interacted: false };
  const channel = W.createSpeakingChannel({
    setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now,
    show: (item) => { if (item.kind === 'random') { s.shown += 1; s.shownAt = c.now(); s.interacted = false; } },
    hide: (item, reason) => {
      if (item.kind !== 'random') return;
      const interacted = s.interacted; s.interacted = false;
      if (W.shouldCountTipShown(reason, c.now() - s.shownAt, interacted)) { s.lastId = item.payload.id; s.stamped.push(item.payload.id); }
      else s.shown = Math.max(0, s.shown - 1);
      if (W.shouldReofferTip(reason, interacted)) { s.pending = item.payload; return; }
      s.roundsDone += 1;
    },
  });
  const tip = { id: 'tip-a' };
  return { c, s, channel, request: (payload = tip) => channel.request({ kind: 'random', durationMs: 12_000, payload }) };
}

test('shouldCountTipShown: preempt/clear never; dismiss/action always; else only after 3 s', () => {
  assert.equal(W.RANDOM_TIP_READ_MS, 3000);
  assert.equal(W.shouldCountTipShown('clear', 60_000, false), false, 'cleared by hide: not counted');
  assert.equal(W.shouldCountTipShown('preempt', 60_000, false), false);
  assert.equal(W.shouldCountTipShown('end', 500, true), true, 'dismissed/acted on counts at once');
  assert.equal(W.shouldCountTipShown('end', 2999, false), false, 'closed unread');
  assert.equal(W.shouldCountTipShown('timeout', 3000, false), true, 'seen >= 3 s counts');
  assert.equal(W.shouldReofferTip('clear', false), true);
  assert.equal(W.shouldReofferTip('timeout', false), false);
  assert.equal(W.shouldReofferTip('end', true), false);
});

test('a tip cleared by a hide within 3 s: not counted, not stamped, re-offered on return', () => {
  const h = harness();
  h.request();
  assert.equal(h.s.shown, 1);
  h.c.advance(1_500);
  h.channel.clear(); // the visibility handler on hide
  assert.equal(h.s.shown, 0, 'count given back');
  assert.deepEqual(h.s.stamped, [], 'no 24 h stamp');
  assert.equal(h.s.lastId, null, 'no back-to-back id');
  assert.equal(h.s.roundsDone, 0, 'the round stays open until the tip shows on return');
  assert.equal(h.s.pending?.id, 'tip-a', 'kept for return');
  // ALIVE again: the widget re-requests the pending tip; seen to its timeout it counts.
  h.request(h.s.pending); h.s.pending = null;
  h.c.advance(12_000);
  assert.equal(h.s.shown, 1);
  assert.deepEqual(h.s.stamped, ['tip-a']);
  assert.equal(h.s.roundsDone, 1);
});

// Fresh-fact context for the re-offer round (tips.ts RandomTipContext).
const ctx = (over = {}) => ({
  route: '/dashboard', gatewayState: 'running', enabledModelCount: 2, keyCount: 2, anyLegacyDisabled: false,
  autoLaunch: true, performanceMode: 'auto', requestDeadlineSource: 'config', requestDeadlineMs: 30_000,
  llmStatsEnabled: false, updateState: 'upToDate', aliveMsThisSession: 0, randomShownThisSession: 0, lastRandomTipId: null, ...over,
});
const state = (over = {}) => ({ enabled: true, never: [], lastShownAt: {}, dismissed: [], ...over });

test('re-offer: a pending tip that still qualifies is shown with FRESH vars', () => {
  const a = T.selectReofferTip('deadline', ctx({ requestDeadlineMs: 45_000 }), state(), 1e12, () => 0.99);
  assert.equal(a?.tip.id, 'deadline', 'the pending tip is preferred while it qualifies');
  assert.deepEqual({ ...a.vars }, { s: '45' }, 'vars come from the fresh facts, not the stored payload');
});

test('re-offer: a pending tip whose condition became false is replaced by a fresh select, or by nothing', () => {
  // auto-launch qualifies only while autoLaunch === false; the fresh facts say true.
  const fresh = T.selectReofferTip('auto-launch', ctx({ autoLaunch: true }), state(), 1e12, () => 0);
  assert.notEqual(fresh?.tip.id, 'auto-launch', 'not shown once its condition is false');
  assert.ok(fresh === null || typeof fresh.tip.id === 'string');
  // never / stamped within 24 h / on its own route: also not re-offered.
  assert.notEqual(T.selectReofferTip('deadline', ctx(), state({ never: ['deadline'] }), 1e12, () => 0)?.tip.id, 'deadline');
  assert.notEqual(T.selectReofferTip('deadline', ctx(), state({ lastShownAt: { deadline: 1e12 - 1000 } }), 1e12, () => 0)?.tip.id, 'deadline');
  assert.notEqual(T.selectReofferTip('deadline', ctx({ route: '/settings' }), state(), 1e12, () => 0)?.tip.id, 'deadline');
  // Nothing eligible at all -> null (no card).
  const bare = ctx({ gatewayState: 'stopped', enabledModelCount: null, keyCount: null, anyLegacyDisabled: null, autoLaunch: null,
    performanceMode: null, requestDeadlineSource: null, requestDeadlineMs: null, llmStatsEnabled: null, updateState: null });
  assert.equal(T.selectReofferTip('auto-launch', bare, state({ lastShownAt: { language: 1 } }), 1e12, () => 0), null);
  // Cap and switch are kept.
  assert.equal(T.selectReofferTip('deadline', ctx({ randomShownThisSession: 99 }), state(), 1e12), null);
  assert.equal(T.selectReofferTip('deadline', ctx(), state({ enabled: false }), 1e12), null);
});

test('a fetch resolving after hide shows nothing and is not counted (deferred to return)', () => {
  assert.equal(W.randomRoundOutcome(false, { tip: { id: 'x' } }), 'defer');
  assert.equal(W.randomRoundOutcome(false, null), 'defer');
  assert.equal(W.randomRoundOutcome(true, null), 'none');
  assert.equal(W.randomRoundOutcome(true, { tip: { id: 'x' } }), 'show');
  const body = SRC.slice(SRC.indexOf('offerRandomTipRef.current = async'), SRC.indexOf('// Random-tip cadence (mount once)'));
  const defer = /if \(outcome === 'defer'\) \{([\s\S]*?)\n\s*\}/.exec(body);
  assert.ok(defer, 'the widget defers on a hidden window');
  assert.match(defer[1], /pendingRandomTipRef\.current = \{ id: picked\?\.tip\.id \?\? pendingId \};\s*return;/);
  assert.doesNotMatch(defer[1], /request|randomShownRef|markTipShown|roundDone/, 'nothing shown, counted, stamped or closed');
  assert.ok(body.indexOf("randomRoundOutcome(tipAliveRef.current, picked)") < body.indexOf("channelRef.current?.request("), 'checked before the request');
});

test('a tip seen >= 3 s counts and is stamped (timeout and dismiss)', () => {
  const h = harness();
  h.request();
  h.c.advance(12_000);
  assert.equal(h.s.shown, 1);
  assert.deepEqual(h.s.stamped, ['tip-a']);
  const d = harness();
  d.request(); d.c.advance(800); d.s.interacted = true; d.channel.end('random');
  assert.equal(d.s.shown, 1, 'dismissed counts even before 3 s');
  assert.deepEqual(d.s.stamped, ['tip-a']);
});

test('ALIVE gate: false when main says hidden/minimized even if the document says visible+focused', () => {
  assert.equal(W.tipClockAlive(true, true, W.mainWindowVisible({ visible: false, focused: true, minimized: false })), false);
  assert.equal(W.tipClockAlive(true, true, W.mainWindowVisible({ visible: true, focused: true, minimized: true })), false);
  assert.equal(W.tipClockAlive(true, true, W.mainWindowVisible({ visible: true, focused: true, minimized: false })), true);
  assert.equal(W.tipClockAlive(false, true, true), false);
  assert.equal(W.tipClockAlive(true, false, true), false);
});

test('bridge missing -> falls back to the document signals', () => {
  assert.equal(W.mainWindowVisible(undefined), true);
  assert.equal(W.mainWindowVisible(null), true, 'getWindowState() resolves null with no window');
  assert.equal(W.tipClockAlive(true, true, W.mainWindowVisible(undefined)), true);
  assert.match(SRC, /useState<boolean>\(true\);[^\n]*\n?/, 'mainVisible starts true');
  assert.match(SRC, /bridge\?\.onWindowState\?\.\(apply\)/, 'optional bridge: absent preload is not an error');
  assert.match(SRC, /bridge\?\.getWindowState\?\.\(\)\.then\(apply, \(\) => \{\}\)/);
  assert.match(SRC, /off\?\.\(\);/, 'the listener is unsubscribed on unmount');
});

test('widget wiring: the scheduler clock uses tipClockAlive and the pending tip gets a FRESH round before setAlive', () => {
  assert.match(SRC, /const tipAlive = tipClockAlive\(pageVisible, focused, mainVisible\);/);
  const effect = /const pending = pendingRandomTipRef\.current;([\s\S]*?)randomSchedRef\.current\?\.setAlive\(tipAlive\);/.exec(SRC);
  assert.ok(effect, 'the pending tip is handled before the scheduler resumes');
  assert.match(effect[1], /void offerRandomTipRef\.current\(pending\.id\);/, 'a fresh fetch + select, not the stored payload');
  assert.doesNotMatch(effect[1], /channelRef\.current\?\.request|payload: pending/, 'the stale payload is never shown');
  assert.match(SRC, /: selectReofferTip\(pendingId, ctx, tipsRef\.current, Date\.now\(\)\);/);
  assert.match(SRC, /if \(shouldCountTipShown\(reason, Date\.now\(\) - randomShownAtRef\.current, interacted\)\)/);
  assert.equal((SRC.match(/randomInteractedRef\.current = true/g) ?? []).length, 2, 'X/never/Escape (closeRandomTip) and the action mark interaction');
});

test('window-state IPC: send-only push channel, secured invoke, same guards as neighbours', () => {
  assert.match(MAIN, /export const WINDOW_STATE_CHANNEL = "window-state";/);
  assert.match(PRELOAD, /const WINDOW_STATE_CHANNEL = 'window-state'/, 'preload and main agree on the channel');
  // Push: explicit 3-field projection, no inbound edge on the push channel.
  assert.match(MAIN, /contents\.send\(WINDOW_STATE_CHANNEL, \{ visible: state\.visible, focused: state\.focused, minimized: state\.minimized \}\)/);
  assert.doesNotMatch(MAIN, /ipcMain\.(handle|on)\(\s*(WINDOW_STATE_CHANNEL|"window-state")/, 'the push channel has no inbound handler');
  for (const event of ['show', 'hide', 'minimize', 'restore', 'focus', 'blur', 'ready-to-show']) {
    assert.ok(MAIN.includes(`"${event}"`), `pushed on ${event}`);
  }
  // Invoke: wrapped exactly like clipboard:write-text (wrapIpcHandler + secure -> validateIpcSender).
  const registration = /ipcMain\.handle\("get-window-state",([^\n]*)/.exec(MAIN);
  assert.ok(registration, 'main registers get-window-state');
  assert.match(registration[1], /wrapIpcHandler\("get-window-state", secure\(/);
  // Preload: event dropped, unsubscribe returned, invoke only on the fixed channel.
  assert.match(PRELOAD, /const listener = \(_event: unknown, state: WindowState\) => callback\(state\);/);
  assert.match(PRELOAD, /return \(\) => \{ ipcRenderer\.removeListener\(WINDOW_STATE_CHANNEL, listener\); \};/);
  assert.match(PRELOAD, /getWindowState: \(\) => ipcRenderer\.invoke\('get-window-state'\)/);
  assert.match(read('src/renderer/global.d.ts'), /onWindowState\?: \(callback: \(state: WindowState\) => void\) => \(\) => void;/);
});
