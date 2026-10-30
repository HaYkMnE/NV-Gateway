// PET-SPEC 2026-10-26 §4.1 (one speaking channel), §4.2 (random-tip cadence),
// §4.4 (reading time, hover pause, actions) and §2.3 (celebration caption).
// The pure exports of PetWidget.tsx run for real against tips.ts; the React
// wiring is pinned at source level (no jsdom in this repo).
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

/** Virtual clock + timers: advance(ms) fires due timers in time order. */
function clock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  const c = {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    timers,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
  };
  return c;
}

function channel() {
  const c = clock();
  const log = [];
  let visible = 0;
  let maxVisible = 0;
  let shownRandom = 0;
  const ch = W.createSpeakingChannel({
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    show: (item) => { visible += 1; maxVisible = Math.max(maxVisible, visible); log.push(`show:${item.kind}@${c.now()}`); if (item.kind === 'random') shownRandom += 1; },
    // The widget host: a pre-empted random tip goes back to the pool (not counted).
    hide: (item, reason) => { visible -= 1; log.push(`hide:${item.kind}:${reason}@${c.now()}`); if (item.kind === 'random' && reason === 'preempt') shownRandom -= 1; },
    drop: (item) => log.push(`drop:${item.kind}`),
  });
  return { c, ch, log, max: () => maxVisible, shownRandom: () => shownRandom };
}

test('§4.1 never two items at once; queued items follow after the 600 ms gap in priority order', () => {
  const { c, ch, log, max } = channel();
  ch.request({ kind: 'cue', durationMs: W.CUE_MS });
  ch.request({ kind: 'thought', durationMs: W.THOUGHT_MS });
  ch.request({ kind: 'random', durationMs: 12_000 });
  assert.deepEqual([...ch.queued().map((i) => i.kind)], ['random', 'thought']);
  c.advance(60_000);
  assert.equal(max(), 1, 'at most one visible item');
  assert.deepEqual(log.filter((l) => l.startsWith('show')), ['show:cue@0', `show:random@${3_500 + 600}`, `show:thought@${3_500 + 600 + 12_000 + 600}`]);
  assert.equal(W.SPEAK_QUEUE_MAX, 2);
});

test('§4.1 an event tip pre-empts a random tip, which is not counted; the event waits for a running cue', () => {
  const a = channel();
  a.ch.request({ kind: 'random', durationMs: 12_000 });
  assert.equal(a.shownRandom(), 1);
  a.ch.request({ kind: 'event', durationMs: null });
  assert.equal(a.ch.current().kind, 'event');
  assert.equal(a.shownRandom(), 0, 'pre-empted random tip is not counted as shown');
  assert.ok(a.log.includes('hide:random:preempt@0'));
  a.c.advance(600_000);
  assert.equal(a.ch.current().kind, 'event', 'event tips stay until end()');
  a.ch.end('event');
  assert.equal(a.ch.current(), null);

  const b = channel();
  b.ch.request({ kind: 'cue', durationMs: W.CUE_MS });
  b.ch.request({ kind: 'event', durationMs: null });
  assert.equal(b.ch.current().kind, 'cue', 'event waits for the cue');
  b.c.advance(W.CUE_MS + W.SPEAK_GAP_MS);
  assert.equal(b.ch.current().kind, 'event', 'no deadlock: the event follows the cue');
  assert.equal(b.max(), 1);
});

test('§4.1 a queued random tip expires after 60 s; clear() drops everything and leaves no timer', () => {
  const { c, ch, log } = channel();
  ch.request({ kind: 'event', durationMs: null });
  ch.request({ kind: 'random', durationMs: 12_000 });
  c.advance(W.RANDOM_TIP_QUEUE_WAIT_MS + 1);
  ch.end('event');
  c.advance(W.SPEAK_GAP_MS);
  assert.ok(log.includes('drop:random'));
  assert.equal(ch.current(), null);
  ch.request({ kind: 'thought', durationMs: W.THOUGHT_MS });
  ch.request({ kind: 'random', durationMs: 12_000 });
  ch.clear();
  assert.equal(ch.current(), null);
  assert.equal(ch.queued().length, 0);
  assert.equal(c.timers.size, 0, 'no pending timer after clear (hide / unmount)');
});

test('§4.1/§9.1 the thought shows 13000 ms; §4.4 hover pauses, release keeps >= 4 s', () => {
  assert.equal(W.THOUGHT_MS, 13_000);
  const { c, ch, log } = channel();
  ch.request({ kind: 'thought', durationMs: W.THOUGHT_MS });
  c.advance(12_999);
  assert.equal(ch.current().kind, 'thought');
  c.advance(1);
  assert.ok(log.includes('hide:thought:timeout@13000'));

  ch.request({ kind: 'random', durationMs: 12_000 });
  c.advance(11_000);
  ch.hold(true);
  c.advance(120_000);
  assert.equal(ch.current().kind, 'random', 'paused while held');
  ch.hold(false);
  c.advance(3_999);
  assert.equal(ch.current().kind, 'random', 'at least 4 s left after release');
  c.advance(1);
  assert.equal(ch.current(), null);
  assert.equal(W.randomTipVisibleMs(30, 120), 13_000);
  assert.equal(W.randomTipVisibleMs(0, 0), 12_000);
  assert.equal(W.randomTipVisibleMs(400, 400), 25_000);
});

function scheduler(opts = {}) {
  const c = clock();
  const st = { fired: [], shown: 0, enabled: true, lastInput: null, ...opts };
  const s = W.createRandomTipScheduler({
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, random: () => 0.5,
    lastInputAt: () => st.lastInput, shownThisSession: () => st.shown, enabled: () => st.enabled,
    onDue: () => st.fired.push(s.aliveMs()),
  });
  return { c, s, st };
}

test('§4.2 scheduler: ALIVE time only, first at RANDOM_TIP_FIRST_MS, then 240-360 s', () => {
  const { c, s, st } = scheduler();
  c.advance(500_000); // not ALIVE yet: the clock does not run
  assert.equal(st.fired.length, 0);
  s.setAlive(true);
  c.advance(60_000);
  s.setAlive(false);
  c.advance(1_000_000);
  assert.equal(st.fired.length, 0, 'paused outside ALIVE');
  s.setAlive(true);
  c.advance(T.RANDOM_TIP_FIRST_MS - 60_000);
  assert.deepEqual(st.fired, [T.RANDOM_TIP_FIRST_MS]);
  s.roundDone();
  const gap = s.dueAliveMs() - T.RANDOM_TIP_FIRST_MS;
  assert.ok(gap >= T.RANDOM_TIP_MIN_MS && gap <= T.RANDOM_TIP_MAX_MS, `gap ${gap}`);
  assert.equal(T.RANDOM_TIP_MIN_MS, 240_000);
  assert.equal(T.RANDOM_TIP_MAX_MS, 360_000);
  c.advance(gap);
  assert.equal(st.fired.length, 2);
  s.stop();
  assert.equal(c.timers.size, 0);
});

test('§4.2 scheduler: defers within 20 s of input, caps at 8, off when the switch is off', () => {
  const a = scheduler();
  a.s.setAlive(true);
  a.st.lastInput = T.RANDOM_TIP_FIRST_MS - 5_000;
  a.c.advance(T.RANDOM_TIP_FIRST_MS);
  assert.equal(a.st.fired.length, 0, 'recent input defers the tip');
  a.c.advance(T.TIP_QUIET_AFTER_INPUT_MS);
  assert.equal(a.st.fired.length, 1, 'fires once input is 20 s old');

  const b = scheduler({ shown: T.RANDOM_TIPS_PER_SESSION });
  assert.equal(T.RANDOM_TIPS_PER_SESSION, 8);
  b.s.setAlive(true);
  b.c.advance(3_600_000);
  assert.equal(b.st.fired.length, 0, 'cap reached');

  const d = scheduler({ enabled: false });
  d.s.setAlive(true);
  d.c.advance(3_600_000);
  assert.equal(d.st.fired.length, 0, 'switch off: no random tips');
  d.st.enabled = true;
  d.s.refresh();
  assert.equal(d.st.fired.length, 1, 'switch on again resumes');
});

test('§4.2 buildRandomTipContext maps missing data to null, present data to facts', () => {
  const empty = W.buildRandomTipContext({ route: '/x', runtime: null, models: null, keys: null, update: null, aliveMs: 5, shown: 1, lastId: null });
  for (const k of ['gatewayState', 'enabledModelCount', 'keyCount', 'anyLegacyDisabled', 'autoLaunch', 'performanceMode', 'requestDeadlineSource', 'requestDeadlineMs', 'llmStatsEnabled', 'updateState', 'lastRandomTipId']) {
    assert.equal(empty[k], null, k);
  }
  assert.equal(empty.aliveMsThisSession, 5);
  const full = W.buildRandomTipContext({
    route: '/dashboard',
    runtime: { status: { state: 'running' }, autoLaunch: false, performanceMode: 'day', requestDeadlineSource: 'config', requestDeadlineMs: 300_000, llmStatsEnabled: true },
    models: { models: [{ enabled: true }, { enabled: false }] },
    keys: { keys: [{ legacyDisabled: true }] },
    update: { state: 'none' },
    aliveMs: 0, shown: 3, lastId: 'r01',
  });
  assert.equal(full.gatewayState, 'running');
  assert.equal(full.enabledModelCount, 1);
  assert.equal(full.keyCount, 1);
  assert.equal(full.anyLegacyDisabled, true);
  assert.equal(full.autoLaunch, false);
  assert.equal(full.updateState, 'none');
  assert.equal(full.randomShownThisSession, 3);
  assert.equal(full.lastRandomTipId, 'r01');
});

test('§4.4 random card: action navigates with focusSetting or opens Feedback; never persists; preempt not stamped', () => {
  const act = SRC.slice(SRC.indexOf('const actOnRandomTip'), SRC.indexOf('const neverRandomTip'));
  assert.match(act, /if \(tip\.action === 'feedback' \|\| tip\.route === null\) \{\s*openFeedback\(\);/);
  assert.match(act, /navigate\(tip\.route, \{ state: \{ focusSetting: tip\.targetId \} \}\)/);
  assert.match(SRC, /const neverRandomTip = \(current: ShownRandomTip\): void => \{\s*neverShowTip\(current\.tip\.id\);/);
  // Pin moved (tip-visibility fix): old `if (reason === 'preempt') ... else markTipShown` ->
  // shouldCountTipShown(reason, visibleMs, interacted); preempt/clear/unread give the count back.
  assert.match(SRC, /if \(shouldCountTipShown\(reason, Date\.now\(\) - randomShownAtRef\.current, interacted\)\) \{[\s\S]{0,120}markTipShown\(shown\.tip\.id, Date\.now\(\)\);\s*\} else \{\s*randomShownRef\.current = Math\.max\(0, randomShownRef\.current - 1\);/);
  assert.equal(W.shouldCountTipShown('preempt', 60_000, false), false, 'preempt is never stamped');
  assert.match(SRC, /className="advice-never" onClick=\{\(\) => neverRandomTip\(randomTip\)\}/);
  // tips.ts persists the id (parseTipsState keeps `never`).
  assert.deepEqual([...T.parseTipsState(JSON.stringify({ enabled: true, never: ['r07', 3] })).never], ['r07']);
});

test('§2.3 celebration caption: shown while the celebration runs, then the activity caption returns', () => {
  assert.match(SRC, /const \[celebrating, setCelebrating\] = useState<boolean>\(false\);/);
  assert.match(SRC, /createCelebration\(\{[\s\S]{0,600}onRunningChange/);
  assert.match(SRC, /: celebrating \? t\('pet_caption_celebration'\) : t\(captionKey\(activity, captionIndex\)\);/);
  assert.match(SRC, /joy !== null \? PartyPopper : celebrating \? Sparkles : CAPTION_ICONS\[activity\] \?\? Sparkles/);
});
