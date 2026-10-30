// PET-SPEC 2026-10-26 §1.1 (ALIVE / CALM / HIDDEN), §3 (click joy), §5.2
// (ambient gate, window restart) and §7 (no pending pet timers when hidden).
// The pure helpers exported by PetWidget.tsx are run for real; the React wiring
// that feeds them is pinned at source level (no jsdom in this repo).
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

function loadWidget() {
  const compiled = typescript.transpileModule(SRC, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, jsx: typescript.JsxEmit.React },
  }).outputText;
  const stubs = {
    react: {}, 'react-i18next': {}, '@tanstack/react-query': {}, 'react-router-dom': {}, 'lucide-react': {},
    '../lib/api': {}, '../lib/modal-context': {}, './tips': {}, './pet.css': {}, './audioEngine': { petAudio: {} }, './petEngine': {},
  };
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    module: mod, exports: mod.exports, console, performance, Math, Number,
    window: { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
    require: (id) => { if (id in stubs) return stubs[id]; throw new Error(`unexpected require: ${id}`); },
  }, { filename: 'src/renderer/pet/PetWidget.tsx' });
  return mod.exports;
}

const W = loadWidget();
const body = (start, end) => SRC.slice(SRC.indexOf(start), SRC.indexOf(end, SRC.indexOf(start)));

function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimer: (fn, ms) => { const id = ++seq; pending.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { pending.delete(id); },
    pending,
    fireAll() { for (const [id, t] of [...pending]) { pending.delete(id); t.fn(); } },
  };
}

function recorder(name, log) {
  return { start: () => log.push(`${name}.start`), pause: () => log.push(`${name}.pause`), resume: (ms) => log.push(`${name}.resume:${ms ?? 0}`), stop: () => log.push(`${name}.stop`) };
}

// ---------------------------------------------------------------------------
// §1.1 focus / blur -> rest timer
// ---------------------------------------------------------------------------

test('applyAttention: focus -> rest.focus(), blur -> rest.blur(), hidden -> nothing', () => {
  const log = [];
  const rest = { focus: () => log.push('focus'), blur: () => log.push('blur') };
  W.applyAttention(true, true, rest);
  W.applyAttention(false, true, rest);
  W.applyAttention(false, false, rest);
  W.applyAttention(true, false, rest);
  W.applyAttention(true, true, null);
  assert.deepEqual(log, ['focus', 'blur']);
});

test('the engine attention hooks drive the focus flag and the rest timer (single listener path)', () => {
  assert.match(SRC, /const markAttention = \(now: boolean\): void => \{\s*focusedRef\.current = now;\s*setFocused\(now\);\s*applyAttention\(now, windowAnimatable\(document\), restRef\.current\);\s*\};/);
  assert.match(SRC, /onAttentionLost: \(\) => \{ stopAmbient\(\); markAttention\(false\); \}/);
  assert.match(SRC, /onAttentionGained: \(\) => \{ markAttention\(windowFocused\(document\)\); startAmbient\(\);/);
  assert.match(SRC, /createPetRestTimer\(\{ onChange: setRestLevel, initialFocused: windowFocused\(document\) \}\)/);
  assert.equal(W.windowFocused({ hasFocus: () => true }), true);
  assert.equal(W.windowFocused({ hasFocus: () => false }), false);
  assert.equal(W.windowFocused({}), true, 'no hasFocus degrades to focused');
});

// ---------------------------------------------------------------------------
// §1.1/§1.2/§1.3 the dwell and micro timers run only while visible + focused
// ---------------------------------------------------------------------------

test('petAlive: visible AND focused AND no modal AND no joy', () => {
  const base = { visible: true, focused: true, modalOpen: false, joy: false };
  assert.equal(W.petAlive(base), true);
  assert.equal(W.petAlive({ ...base, focused: false }), false);
  assert.equal(W.petAlive({ ...base, visible: false }), false);
  assert.equal(W.petAlive({ ...base, modalOpen: true }), false);
  assert.equal(W.petAlive({ ...base, joy: true }), false);
});

test('applyPetLifeGate: ALIVE resumes, CALM pauses, HIDDEN stops both timers', () => {
  const log = [];
  const timer = recorder('timer', log);
  const micro = recorder('micro', log);
  const gate = (s) => W.applyPetLifeGate({ visible: s.visible, alive: W.petAlive(s), resumeMinMs: s.min }, timer, micro);
  gate({ visible: true, focused: true, modalOpen: false, joy: false, min: 3000 });
  assert.deepEqual(log.splice(0), ['timer.resume:3000', 'micro.resume:0'], 'visible + focused: both run');
  gate({ visible: true, focused: false, modalOpen: false, joy: false });
  assert.deepEqual(log.splice(0), ['timer.pause', 'micro.pause'], 'unfocused: both pause');
  gate({ visible: true, focused: true, modalOpen: true, joy: false });
  assert.deepEqual(log.splice(0), ['timer.pause', 'micro.pause'], 'modal: both pause');
  gate({ visible: false, focused: true, modalOpen: false, joy: false });
  assert.deepEqual(log.splice(0), ['timer.stop', 'micro.stop'], 'hidden: both stop');
  W.applyPetLifeGate({ visible: true, alive: true }, null, null); // no timers yet: no throw
});

test('the life gate effect re-runs on visibility and ALIVE changes', () => {
  assert.match(SRC, /const alive = petAlive\(\{ visible: pageVisible, focused, modalOpen: activeModal !== null, joy: joy !== null \}\);/);
  assert.match(SRC, /applyPetLifeGate\(\{ visible: pageVisible, alive, resumeMinMs: resumeMinRef\.current \}, activityTimerRef\.current, microRef\.current\);/);
  assert.match(SRC, /\}, \[pageVisible, alive\]\);/);
  assert.match(body('// ALIVE life (spec §1.2, §1.3)', '// Click joy (spec §3)'), /timer\.stop\(\);\s*micro\.stop\(\);/, 'unmount stops both');
});

// ---------------------------------------------------------------------------
// §3 click joy
// ---------------------------------------------------------------------------

function makeJoy({ reduced = false, canOpen = true } = {}) {
  const t = fakeTimers();
  const log = [];
  const joy = W.createClickJoy({
    open: (...args) => log.push(`open:${args.length}`),
    reducedMotion: () => reduced,
    canOpen: () => canOpen,
    onStart: () => log.push('start'),
    onEnd: () => log.push('end'),
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
  });
  return { joy, t, log };
}

test('joy: the modal opens only after 700 ms, with no arguments', () => {
  assert.equal(W.CLICK_JOY_MS, 700);
  const { joy, t, log } = makeJoy();
  assert.equal(joy.click(), true);
  assert.deepEqual(log, ['start'], 'no modal at click time');
  assert.equal(t.pending.size, 1);
  assert.equal([...t.pending.values()][0].ms, 700);
  t.fireAll();
  assert.deepEqual(log, ['start', 'end', 'open:0']);
  assert.equal(joy.pending(), false);
});

test('joy: 300 ms with reduced motion (§3.4)', () => {
  assert.equal(W.CLICK_JOY_REDUCED_MS, 300);
  const { joy, t } = makeJoy({ reduced: true });
  joy.click();
  assert.equal([...t.pending.values()][0].ms, 300);
});

test('joy: repeated clicks during the joy give one timer and a single modal', () => {
  const { joy, t, log } = makeJoy();
  assert.equal(joy.click(), true);
  for (let i = 0; i < 4; i++) assert.equal(joy.click(), false, 'ignored while pending');
  assert.equal(t.pending.size, 1);
  t.fireAll();
  assert.equal(log.filter((x) => x.startsWith('open')).length, 1);
  assert.equal(joy.click(), true, 'a new click after the joy starts a new one');
});

test('joy: hidden during the joy cancels it and never opens the modal', () => {
  const { joy, t, log } = makeJoy();
  joy.click();
  joy.cancel();
  assert.equal(t.pending.size, 0, 'timer cleared');
  assert.deepEqual(log, ['start', 'end']);
  t.fireAll();
  assert.deepEqual(log, ['start', 'end'], 'nothing opens later');
  joy.cancel(); // idempotent
  assert.deepEqual(log, ['start', 'end']);

  const hidden = makeJoy({ canOpen: false });
  hidden.joy.click();
  hidden.t.fireAll();
  assert.deepEqual(hidden.log, ['start', 'end'], 'canOpen false (hidden): no modal');
});

// ---------------------------------------------------------------------------
// §3.2/§7 hidden clears the joy and the swap timer
// ---------------------------------------------------------------------------

test('applyHiddenPetTimers: hidden cancels the joy and clears the swap timer; visible touches nothing', () => {
  const log = [];
  const host = { cancelJoy: () => log.push('joy'), clearSwap: () => log.push('swap') };
  W.applyHiddenPetTimers(true, host);
  assert.deepEqual(log, []);
  W.applyHiddenPetTimers(false, host);
  assert.deepEqual(log, ['joy', 'swap']);
});

test('the visibility handler wires applyHiddenPetTimers to the joy and swapTimerRef', () => {
  const vis = body('const applyVisibility = (): void => {', "document.addEventListener('visibilitychange'");
  assert.match(vis, /applyHiddenPetTimers\(animatable, \{/);
  assert.match(vis, /cancelJoy: \(\) => joyRef\.current\?\.cancel\(\),/);
  assert.match(vis, /if \(swapTimerRef\.current !== null\) window\.clearTimeout\(swapTimerRef\.current\);\s*swapTimerRef\.current = null;/);
});

test('welcome-back hop after a modal closes only when visible, focused and not reduced motion', () => {
  const base = { wasModal: true, modalOpen: false, visible: true, focused: true, reducedMotion: false };
  assert.equal(W.shouldWelcomeBack(base), true);
  assert.equal(W.shouldWelcomeBack({ ...base, focused: false }), false);
  assert.equal(W.shouldWelcomeBack({ ...base, visible: false }), false);
  assert.equal(W.shouldWelcomeBack({ ...base, reducedMotion: true }), false);
  assert.equal(W.shouldWelcomeBack({ ...base, wasModal: false }), false);
  assert.match(SRC, /focused: focusedRef\.current,\s*reducedMotion: reducedMotionRef\.current,\s*\}\)\) return;/);
});

// ---------------------------------------------------------------------------
// §5.2 ambient gate and window restart
// ---------------------------------------------------------------------------

test('ambientAllowed: only visible && focused, never with a modal, joy or celebration', () => {
  const base = { visible: true, focused: true, modalOpen: false, joy: false, celebrating: false };
  assert.equal(W.ambientAllowed(base), true);
  assert.equal(W.ambientAllowed({ ...base, focused: false }), false);
  assert.equal(W.ambientAllowed({ ...base, visible: false }), false);
  assert.equal(W.ambientAllowed({ ...base, modalOpen: true }), false);
  assert.equal(W.ambientAllowed({ ...base, joy: true }), false);
  assert.equal(W.ambientAllowed({ ...base, celebrating: true }), false);
  assert.match(SRC, /petAudio\.setAmbientGate\(\(\) => ambientAllowed\(\{\s*visible: windowAnimatable\(document\),\s*focused: focusedRef\.current,/);
});

test('restartAmbientWindow closes then reopens the gate, after every non-ambient sound', () => {
  const restart = body('const restartAmbientWindow = useCallback', '}, []);');
  assert.match(restart, /petAudio\.setAmbientGate\(false\);\s*petAudio\.setAmbientGate\(true\);/);
  // Focus-return switch SFX: restart right after ACTIVITY_SFX; a silent timer switch returns before it.
  const change = body('const handleActivityChange', 'const handleCue');
  const sfx = change.indexOf('ACTIVITY_SFX[next]?.()');
  const timerReturn = change.indexOf('if (timerSwitchRef.current)');
  assert.ok(timerReturn > 0 && timerReturn < sfx, 'timer switches return before the SFX');
  assert.ok(change.indexOf('restartAmbientWindow()', sfx) > sfx, 'restart after the activity SFX');
  // Joy chime.
  const onStart = body('onStart: () => {', 'onEnd: () => {');
  assert.ok(onStart.indexOf('restartAmbientWindow()') > onStart.indexOf('petAudio.playChime()'), 'restart after the joy chime');
});
