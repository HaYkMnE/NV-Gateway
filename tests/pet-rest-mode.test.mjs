// Pet idle-CPU / show-freeze fixes (owner report 30.09 "after opening it freezes").
// Art-director decisions pinned here:
//   1. rest mode (.nv-pet-rest after 60 s, deep rest after 180 s, both counted only
//      while the window is visible but unfocused, spec 2026-10-26 §1.1) — only the
//      breathing root rig and the natural blink keep running;
//   2. .nv-pet-paused while any app modal is open;
//   4. prefers-reduced-motion shows a static pose;
//   5. no full-window backdrop blur in DonationModal;
//   6. attention-return work deferred off the visibilitychange task, noise
//      buffers built lazily on the first sound instead of in init().
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function transpile(relative) {
  return typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
  }).outputText;
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function loadEngine(globals = {}) {
  const mod = { exports: {} };
  vm.runInNewContext(transpile('src/renderer/pet/petEngine.ts'), {
    module: mod, exports: mod.exports, console, Math, Date,
    sessionStorage: memoryStorage(), localStorage: memoryStorage(),
    ...globals,
  }, { filename: 'src/renderer/pet/petEngine.ts' });
  return mod.exports;
}

/** Deterministic fake timers. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    set: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clear: (id) => { timers.delete(id); },
    pending: () => timers.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (next === null || t.at < next[1].at)) next = [id, t];
        if (next === null) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
function cssRules(css) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(stripComments(css))) !== null) {
    rules.push({ selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean), body: m[2] });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// 1. Rest timer (60 s rest, 180 s deep rest while unfocused, wake on hover/click/event)
// ---------------------------------------------------------------------------

test('rest timer: .nv-pet-rest level after 60 s, woken by hover/click/event, timer restarts', () => {
  const { createPetRestTimer, PET_REST_DELAY_MS } = loadEngine();
  assert.equal(PET_REST_DELAY_MS, 60000);
  const clock = fakeClock();
  const changes = [];
  const rest = createPetRestTimer({ onChange: (l) => changes.push(l), setTimer: clock.set, clearTimer: clock.clear });

  rest.wake(); // activity / event starts
  clock.advance(59999);
  assert.equal(rest.level(), 'awake');
  clock.advance(1);
  assert.equal(rest.level(), 'rest', 'rest 60 s after the activity started');

  rest.wake(); // hover / click / new engine event
  assert.equal(rest.level(), 'awake', 'waking removes rest immediately');
  clock.advance(59999);
  assert.equal(rest.level(), 'awake', 'the 60 s timer restarts from the wake');
  clock.advance(1);
  assert.equal(rest.level(), 'rest');
  assert.deepEqual(changes, ['rest', 'awake', 'rest']);
});

test('rest timer: deep rest 180 s after the last interaction; stop() clears every timer', () => {
  const { createPetRestTimer, PET_DEEP_REST_DELAY_MS } = loadEngine();
  assert.equal(PET_DEEP_REST_DELAY_MS, 180000);
  const clock = fakeClock();
  const rest = createPetRestTimer({ onChange: () => {}, setTimer: clock.set, clearTimer: clock.clear });

  rest.wake();
  clock.advance(30000);
  rest.wake(); // interaction at 30 s restarts the 180 s window
  clock.advance(179999);
  assert.equal(rest.level(), 'rest');
  clock.advance(1);
  assert.equal(rest.level(), 'deep', 'deep rest 180 s after the last interaction');
  rest.wake();
  assert.equal(rest.level(), 'awake');

  rest.stop(); // hide / unmount
  assert.equal(clock.pending(), 0, 'stop() leaves no timer armed');
  clock.advance(120000);
  assert.equal(rest.level(), 'awake');
});

test('rest timer: hold() keeps the pet awake while hovered; leaving restarts the 60 s timer', () => {
  const { createPetRestTimer } = loadEngine();
  const clock = fakeClock();
  const rest = createPetRestTimer({ onChange: () => {}, setTimer: clock.set, clearTimer: clock.clear });

  rest.wake();
  clock.advance(60000);
  assert.equal(rest.level(), 'rest');
  rest.hold(); // pointer enters
  assert.equal(rest.level(), 'awake', 'hover wakes immediately');
  assert.equal(clock.pending(), 0, 'no timer runs while hovered');
  clock.advance(200000);
  assert.equal(rest.level(), 'awake', 'never rests (nor deep-rests) while hovered');
  rest.wake(); // an engine event during hover
  assert.equal(clock.pending(), 0, 'an event during hover does not re-arm the held timers');

  rest.release(); // pointer leaves -> wake()
  clock.advance(59999);
  assert.equal(rest.level(), 'awake');
  clock.advance(1);
  assert.equal(rest.level(), 'rest', 'rest 60 s after the pointer left');
  rest.stop();
  assert.equal(clock.pending(), 0);
});

test('PetWidget wires rest classes and wakes on hover, click and every engine event', () => {
  const src = read('src/renderer/pet/PetWidget.tsx');
  assert.match(src, /\$\{restLevel === 'awake' \? '' : ' nv-pet-rest'\}\$\{restLevel === 'deep' \? ' nv-pet-rest-deep' : ''\}/);
  // PET-SPEC 2026-10-26 §3.1/§9.2: the click runs the joy first (onClick={startJoy}).
  assert.match(src, /className="widget-btn"\s*onClick=\{startJoy\}\s*onMouseEnter=\{holdPet\}\s*onMouseLeave=\{releasePet\}\s*onClickCapture=\{wakePet\}/,
    'hover holds, leave releases, click wakes');
  assert.match(src, /const holdPet = useCallback\(\(\): void => \{\s*hoverRef\.current\?\.enter\(\);\s*\}, \[\]\);/);
  assert.match(src, /const releasePet = useCallback\(\(\): void => \{\s*hoverRef\.current\?\.leave\(\);\s*\}, \[\]\);/);
  const body = (start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));
  assert.match(body('const handleActivityChange', 'const handleCue'), /restRef\.current\?\.wake\(\)/, 'activity switch wakes');
  assert.match(body('const handleCue', '// Rest timer (mount once)'), /restRef\.current\?\.wake\(\)/, 'cue wakes');
  assert.match(body('const onAscension', "window.addEventListener('nv-pet-ascension'"), /restRef\.current\?\.wake\(\)/, 'ascension wakes');
  assert.match(src, /if \(selected\?\.occurrenceId !== undefined\) restRef\.current\?\.wake\(\);/, 'a new tip card wakes (fade-in not frozen)');
  // §1.1/§9.2: the rest timer starts from the real focus state (focused = never rests).
  assert.match(src, /const rest = createPetRestTimer\(\{ onChange: setRestLevel, initialFocused: windowFocused\(document\) \}\);/);
  assert.match(src, /rest\.stop\(\); restRef\.current = null; \};/, 'timers cleared on unmount');
});

// Hover across hide/show (measured with a real CDP mouse): Chromium fires
// mouseleave on win.hide(), and after the show :hover stays false until the
// mouse moves. The tracker keeps the hold across the hide and waits for the
// first real pointer event (at most the 2 s probe) before deciding.
function makeHover() {
  const { createPetRestTimer, createPetHoverTracker, PET_HOVER_SHOW_PROBE_MS } = loadEngine();
  const clock = fakeClock();
  const rest = createPetRestTimer({ onChange: () => {}, setTimer: clock.set, clearTimer: clock.clear });
  const env = { hidden: false };
  const hover = createPetHoverTracker({ rest, isHidden: () => env.hidden, setTimer: clock.set, clearTimer: clock.clear });
  const hide = () => { env.hidden = true; hover.visibility(false); };
  const show = () => { env.hidden = false; hover.visibility(true); };
  rest.wake();
  return { clock, rest, hover, env, hide, show, PET_HOVER_SHOW_PROBE_MS };
}

test('hover tracker: a hide-induced mouseleave does not release (either event order)', () => {
  // Order 1: mouseleave first, visibilitychange(hidden) in the same task.
  let h = makeHover();
  h.hover.enter();
  h.hover.leave();
  h.hide();
  h.clock.advance(0);
  h.show();
  assert.equal(h.hover.awaitingPointer(), true, 'held across the hide (leave deferred, then cancelled by hidden)');
  h.clock.advance(800);
  h.hover.pointer(true); // the show-time pointermove lands on the pet
  h.clock.advance(10000);
  assert.equal(h.rest.level(), 'awake');

  // Order 2: already hidden when mouseleave arrives.
  h = makeHover();
  h.hover.enter();
  h.hide();
  h.hover.leave();
  h.clock.advance(0);
  h.show();
  assert.equal(h.hover.awaitingPointer(), true);
  h.clock.advance(800);
  h.hover.pointer(true);
  h.clock.advance(10000);
  assert.equal(h.rest.level(), 'awake');

  // Order 3 (measured with main-process win.hide()): mouseleave arrives in its
  // OWN task before visibilitychange, so a one-task defer already fired. The
  // leave must wait the grace window before it counts.
  const { PET_HIDE_LEAVE_GRACE_MS } = loadEngine();
  assert.equal(PET_HIDE_LEAVE_GRACE_MS, 500);
  h = makeHover();
  h.hover.enter();
  h.hover.leave();
  h.clock.advance(100); // several tasks later, still inside the grace window
  h.hide();
  h.clock.advance(1000);
  h.show();
  assert.equal(h.hover.awaitingPointer(), true, 'hide inside the grace window cancels the leave');
  h.clock.advance(800);
  h.hover.pointer(true);
  h.clock.advance(10000);
  assert.equal(h.rest.level(), 'awake');

  // A real leave while visible releases after the grace window -> rest 60 s after.
  h = makeHover();
  h.hover.enter();
  h.clock.advance(20000);
  h.hover.leave();
  h.clock.advance(PET_HIDE_LEAVE_GRACE_MS - 1);
  h.clock.advance(60000);
  assert.equal(h.rest.level(), 'awake', 'not released before the grace window ends');
  h.clock.advance(1);
  assert.equal(h.rest.level(), 'rest', 'rest 60 s after the grace-delayed release');
});

test('hover tracker: shown with no pointer event (cursor outside the window) -> released at 2 s, rest at 62 s', () => {
  const h = makeHover();
  assert.equal(h.PET_HOVER_SHOW_PROBE_MS, 2000);
  h.hover.enter();
  h.hover.leave();
  h.hide();
  h.show();
  h.clock.advance(1999);
  assert.equal(h.hover.awaitingPointer(), true, 'still probing just before 2 s');
  assert.equal(h.rest.level(), 'awake');
  h.clock.advance(1);
  assert.equal(h.hover.awaitingPointer(), false, 'no pointer event within 2 s: released');
  h.clock.advance(59999);
  assert.equal(h.rest.level(), 'awake');
  h.clock.advance(1);
  assert.equal(h.rest.level(), 'rest', 'rest 62 s after the show (2 s probe + 60 s), not 122 s');
  h.clock.advance(120000);
  assert.equal(h.rest.level(), 'deep', 'nothing keeps it awake afterwards (no stuck-awake path)');
});

test('hover tracker: the latest measured show-time event (762 ms) still decides inside the probe', () => {
  for (const [over, expected] of [[true, 'awake'], [false, 'rest']]) {
    const h = makeHover();
    h.hover.enter();
    h.hover.leave();
    h.hide();
    h.show();
    h.clock.advance(762);
    h.hover.pointer(over);
    h.clock.advance(60000);
    assert.equal(h.rest.level(), expected, `event at 762 ms ${over ? 'on' : 'off'} the button`);
  }
});

test('hover tracker: after show, a pointermove at 800 ms off the button releases; rest 60 s later', () => {
  const h = makeHover();
  h.hover.enter();
  h.hover.leave();
  h.hide();
  h.show();
  h.clock.advance(800);
  h.hover.pointer(false);
  assert.equal(h.hover.awaitingPointer(), false);
  h.clock.advance(59999);
  assert.equal(h.rest.level(), 'awake');
  h.clock.advance(1);
  assert.equal(h.rest.level(), 'rest');
  h.clock.advance(120000);
  assert.equal(h.rest.level(), 'deep', 'the cancelled cap does not re-wake later');
});

test('hover tracker: after show, a pointermove at 800 ms on the button keeps the hold until a real leave', () => {
  const h = makeHover();
  h.hover.enter();
  h.hover.leave();
  h.hide();
  h.show();
  h.clock.advance(800);
  h.hover.pointer(true);
  h.clock.advance(200000);
  assert.equal(h.rest.level(), 'awake', 'still hovered: held past 60 s / 180 s and past the probe');
  h.hover.leave(); // real leave
  h.clock.advance(500 + 59999);
  assert.equal(h.rest.level(), 'awake');
  h.clock.advance(1);
  assert.equal(h.rest.level(), 'rest', 'real leave releases after the 500 ms grace, rest 60 s later');
});

// Audit gap (live): shown with the cursor outside the window, the probe
// released at 2 s; at +3 s the window moved under the cursor so it sat on the
// pet. A trusted pointermove arrived on the button but NO mouseenter followed.
// Window pointermoves must keep being hit-tested until a real enter/leave.
function probeReleasedThenOn() {
  const h = makeHover();
  h.hover.enter();
  h.hover.leave();
  h.hide();
  h.show(); // cursor outside the window: no event
  h.clock.advance(2000); // probe releases
  assert.equal(h.hover.awaitingPointer(), false);
  assert.equal(h.hover.tracksPointer(), true, 'still hit-testing window pointermoves after the probe');
  h.clock.advance(1000); // +3 s: window moved under the cursor
  h.hover.pointer(true); // trusted pointermove on the button, no mouseenter
  return h;
}

test('re-hold: probe released, then a pointermove on the button holds again (no rest at 62 s or later)', () => {
  const h = probeReleasedThenOn();
  h.clock.advance(62000);
  assert.equal(h.rest.level(), 'awake', 'no rest 62 s after the re-hold');
  h.clock.advance(200000);
  assert.equal(h.rest.level(), 'awake', 'held while the cursor stays on the pet');
});

test('re-hold, then a pointermove off the button rests ~60 s later (500 ms grace, not postponed by more moves)', () => {
  const h = probeReleasedThenOn();
  h.clock.advance(4000);
  h.hover.pointer(false); // off the pet
  h.clock.advance(100);
  h.hover.pointer(false); // further moves off the pet must not push the release out
  h.clock.advance(200);
  h.hover.pointer(false);
  h.clock.advance(200 + 59999);
  assert.equal(h.rest.level(), 'awake');
  h.clock.advance(1);
  assert.equal(h.rest.level(), 'rest', 'rest 500 ms + 60 s after the first off-pet move');

  // Back on the pet inside the grace window cancels the pending release.
  const g = probeReleasedThenOn();
  g.hover.pointer(false);
  g.clock.advance(300);
  g.hover.pointer(true);
  g.clock.advance(30000);
  assert.equal(g.rest.level(), 'awake', 'moving back onto the pet within 500 ms keeps the hold');
});

test('re-hold, then a real mouseenter takes over: still held; mouseleave rests; tracking stops', () => {
  const h = probeReleasedThenOn();
  h.hover.enter(); // real (a pointer event already confirmed the position)
  assert.equal(h.hover.tracksPointer(), false, 'the normal enter/leave path owns the state now');
  h.clock.advance(30000);
  assert.equal(h.rest.level(), 'awake', 'still held after the real enter');
  h.hover.pointer(false); // not tracking: ignored (enter/leave own it)
  h.clock.advance(10000);
  assert.equal(h.rest.level(), 'awake');
  h.hover.leave();
  h.clock.advance(500 + 60000);
  assert.equal(h.rest.level(), 'rest', 'mouseleave rests');

  // A real mouseleave after a re-hold also takes over and releases.
  const g = probeReleasedThenOn();
  g.hover.leave();
  assert.equal(g.hover.tracksPointer(), false);
  g.clock.advance(500 + 60000);
  assert.equal(g.rest.level(), 'rest');
});

test('hover tracker: the synthetic mouseenter Chromium fires on show (no movement) stays probed', () => {
  // Measured with a real CDP mouse: show() re-hit-tests the last known pointer
  // position and fires mouseenter without any pointermove. That position may be
  // stale (cursor moved away while hidden), so it must not end the 2 s probe.
  let h = makeHover();
  h.hover.enter();
  h.hover.leave();
  h.hide();
  h.show();
  h.hover.enter(); // synthetic post-show mouseenter
  assert.equal(h.hover.tracksPointer(), true, 'an unconfirmed enter does not end the tracking');
  assert.equal(h.hover.awaitingPointer(), true, 'and does not lift the probe');
  h.clock.advance(1000);
  assert.equal(h.rest.level(), 'awake', 'held at 1 s');
  h.clock.advance(61000);
  assert.equal(h.rest.level(), 'rest', 'probe released at 2 s, rest 60 s later (never stuck awake)');

  // Not hovered at hide, stale mouseenter after show: probed too.
  h = makeHover();
  h.hide();
  h.show();
  h.hover.enter();
  h.clock.advance(2000 + 60000);
  assert.equal(h.rest.level(), 'rest', 'a stale enter after show cannot hold forever');

  // Once a real pointer event confirmed it, a later enter is a normal unbounded hold.
  h = makeHover();
  h.hide();
  h.show();
  h.hover.pointer(false);
  assert.equal(h.hover.expectsPointer(), false);
  h.hover.enter();
  h.clock.advance(120000);
  assert.equal(h.rest.level(), 'awake', 'confirmed hover holds until a real leave');
  h.hover.leave();
  h.clock.advance(500 + 60000);
  assert.equal(h.rest.level(), 'rest');
});

test('observed show event: the trusted pointermove at the real OS cursor decides the hold by hit-test', () => {
  const { pointerOverButton } = loadWidget();
  // Measured (main-process hide/show, f12/measure5-diag.txt): button rect
  // 20,326 209x237 in a 1008x703 viewport; the pointermove Chromium sent
  // 183 ms after 'visible' was trusted, at (631,494) — exactly the OS cursor
  // (screen 1087,683 minus content origin 456,189). Coordinates are truthful.
  const rect = { left: 20, top: 326, right: 229, bottom: 563 };
  assert.equal(pointerOverButton(631, 494, rect), false, 'the observed event: real cursor off the pet');
  assert.equal(pointerOverButton(125, 444, rect), true, 'cursor on the pet (button centre)');
  assert.equal(pointerOverButton(229, 444, rect), false, 'right edge is outside');
  assert.equal(pointerOverButton(-5, 444, rect), false, 'outside the window is off the pet (not ignored)');
  assert.equal(pointerOverButton(Number.NaN, 444, rect), null, 'unusable coordinates are ignored');
  assert.equal(pointerOverButton(125, 444, null), false, 'no button: off');

  // Replay the observed sequence: leave from the hide's mouseout, hidden
  // 184 ms later (inside the grace window), shown, pointermove 183 ms later.
  const replay = (x, y) => {
    const h = makeHover();
    h.hover.enter();
    h.hover.leave();
    h.clock.advance(184);
    h.hide();
    h.clock.advance(1218);
    h.show();
    h.clock.advance(183);
    const over = pointerOverButton(x, y, rect);
    if (over !== null) h.hover.pointer(over);
    return h;
  };
  let h = replay(631, 494);
  h.clock.advance(60000);
  assert.equal(h.rest.level(), 'rest', 'real cursor off the pet at show: normal 60 s rest');
  h = replay(125, 444);
  h.clock.advance(200000);
  assert.equal(h.rest.level(), 'awake', 'real cursor on the pet at show: held past 60 s / 180 s and past the probe');
  h = replay(Number.NaN, 0);
  h.clock.advance(2000 + 60000 - 183);
  assert.equal(h.rest.level(), 'rest', 'an unusable event leaves the 2 s probe in charge');
});

test('hover tracker: not hovered at show -> normal 60 s rest; dispose clears everything', () => {
  const h = makeHover();
  h.hide();
  h.show();
  assert.equal(h.hover.awaitingPointer(), false);
  h.clock.advance(60000);
  assert.equal(h.rest.level(), 'rest');

  const d = makeHover();
  d.hover.enter();
  d.hover.leave();
  d.hide();
  d.show();
  d.hover.dispose();
  d.rest.stop();
  assert.equal(d.clock.pending(), 0, 'dispose + stop leave no timer armed');
});

test('PetWidget wires the hover tracker: enter/leave, visibility, first window pointermove', () => {
  const src = read('src/renderer/pet/PetWidget.tsx');
  assert.match(src, /const hover = createPetHoverTracker\(\{ rest, isHidden: \(\) => !windowAnimatable\(document\) \}\);/);
  assert.match(src, /return \(\) => \{ hover\.dispose\(\); hoverRef\.current = null; rest\.stop\(\); restRef\.current = null; \};/);
  assert.match(src, /hoverRef\.current\?\.visibility\(animatable\);/);
  assert.match(src, /window\.addEventListener\('pointermove', onPointerMove, \{ passive: true \}\);/);
  assert.match(src, /return \(\) => window\.removeEventListener\('pointermove', onPointerMove\);/);
  assert.match(src, /const over = pointerOverButton\(event\.clientX, event\.clientY, widgetBtnRef\.current\?\.getBoundingClientRect\(\) \?\? null\);/);
  assert.match(src, /if \(over !== null\) hover\.pointer\(over\);/);
  assert.match(src, /if \(!hover\?\.tracksPointer\(\)\) return;/);
  assert.doesNotMatch(src, /applyRestVisibility/, 'the :hover-on-show heuristic is gone');
});

test('reduced motion follows a live matchMedia change and drives the gate mode', () => {
  const { subscribeReducedMotion, petAnimationMode } = loadWidget();
  const listeners = new Set();
  const mql = {
    matches: false,
    addEventListener: (type, fn) => { if (type === 'change') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'change') listeners.delete(fn); },
  };
  const queries = [];
  const win = { matchMedia: (q) => { queries.push(q); return mql; } };
  let reduce = null;
  const unsubscribe = subscribeReducedMotion(win, (v) => { reduce = v; });
  assert.deepEqual(queries, ['(prefers-reduced-motion: reduce)']);
  assert.equal(listeners.size, 1);
  const mode = () => petAnimationMode({ visible: true, modalOpen: false, reducedMotion: reduce, restLevel: 'awake' });
  assert.equal(reduce, false);
  assert.equal(mode(), 'run');

  mql.matches = true;
  for (const fn of listeners) fn();
  assert.equal(mode(), 'stop', 'OS switches reduced motion on -> canvas stops');
  mql.matches = false;
  for (const fn of listeners) fn();
  assert.equal(mode(), 'run', 'and back on when switched off');

  unsubscribe();
  assert.equal(listeners.size, 0, 'unmount removes the listener');
  assert.doesNotThrow(() => subscribeReducedMotion({}, () => {})(), 'no matchMedia: no-op');

  const src = read('src/renderer/pet/PetWidget.tsx');
  assert.match(src, /useEffect\(\(\) => subscribeReducedMotion\(window, setReducedMotion\), \[\]\);/);
  assert.doesNotMatch(src, /\.onchange\s*=/, 'addEventListener, not onchange');
});

// ---------------------------------------------------------------------------
// 2. CSS contract
// ---------------------------------------------------------------------------

test('pet.css: idle breathing lives on .mascot-svg (one layer), not .m-root-rig', () => {
  const css = read('src/renderer/pet/pet.css');
  const rules = cssRules(css);
  const svg = rules.find((r) => r.selectors.length === 1 && r.selectors[0] === '.nv-pet-wrap .mascot-svg');
  assert.ok(svg, 'missing .nv-pet-wrap .mascot-svg rule');
  // linear over the baked ease-in-out keyframes (pet-breathing-eased-keyframes.test.mjs).
  assert.match(svg.body, /animation: nv-pet-mascotHoverPhysics 3\.2s linear infinite;/);
  assert.match(svg.body, /transform-origin: 50% 54\.1667%;/);
  assert.match(svg.body, /will-change: transform;/);
  assert.match(svg.body, /transition: filter 0\.3s ease;/, 'no transform transition fighting the animation');
  assert.doesNotMatch(svg.body, /transition:[^;]*transform/);
  assert.match(svg.body, /width: 92%;\s*height: 92%;/, 'size rule intact');

  const rig = rules.find((r) => r.selectors.length === 1 && r.selectors[0] === '.nv-pet-wrap .m-root-rig');
  assert.ok(rig);
  assert.doesNotMatch(rig.body, /animation/, 'the root rig no longer breathes by default');

  // Keyframes in % of the SVG's own height (px / 120); used only by .mascot-svg.
  const kf = stripComments(css).match(/@keyframes nv-pet-mascotHoverPhysics \{([\s\S]*?)\n\}/);
  assert.ok(kf);
  assert.match(kf[1], /0%, 100% \{ transform: translateY\(0%\) rotate\(0deg\) scale\(1, 1\); \}/);
  assert.match(kf[1], /25% \{ transform: translateY\(-3\.3333%\) rotate\(-1\.5deg\) scale\(0\.98, 1\.02\); \}/);
  assert.match(kf[1], /50% \{ transform: translateY\(-0\.8333%\) rotate\(0\.5deg\) scale\(1, 1\); \}/);
  assert.match(kf[1], /75% \{ transform: translateY\(2\.5%\) rotate\(1\.2deg\) scale\(1\.02, 0\.98\); \}/);
  assert.doesNotMatch(kf[1], /px/);
  const users = rules.filter((r) => /nv-pet-mascotHoverPhysics/.test(r.body)).flatMap((r) => r.selectors);
  assert.deepEqual(users, ['.nv-pet-wrap .mascot-svg'], 'keyframes used by .mascot-svg only');
});

test('pet.css: every act-* .m-root-rig override silences the svg breathing', () => {
  const rules = cssRules(read('src/renderer/pet/pet.css'));
  const acts = new Set();
  for (const r of rules) for (const s of r.selectors) {
    const m = s.match(/^\.nv-pet-wrap\.act-([\w-]+) \.m-root-rig$/);
    if (m && /animation\s*:/.test(r.body)) acts.add(m[1]);
  }
  assert.deepEqual([...acts].sort(), ['fourth-wall-wink', 'low-battery', 'power-nap', 'quantum-meditation']);
  for (const act of acts) {
    assert.ok(rules.some((r) => r.selectors.includes(`.nv-pet-wrap.act-${act} .mascot-svg`) && /^\s*animation: none;\s*$/.test(r.body)),
      `missing .nv-pet-wrap.act-${act} .mascot-svg { animation: none; }`);
  }
});

test('pet.css: rest pauses everything except .mascot-svg and the blink', () => {
  const css = read('src/renderer/pet/pet.css');
  const rules = cssRules(css);
  // The steps() timing rule for rest is pinned in pet-breathing-eased-keyframes.test.mjs.
  const restRules = rules.filter((r) => r.selectors.some((s) => /\.nv-pet-rest(?!-)/.test(s))
    && !/^\s*animation-timing-function: steps\(6, jump-end\);\s*$/.test(r.body));
  assert.equal(restRules.length, 1, 'exactly one rest pause rule');
  const [rule] = restRules;
  assert.equal(rule.selectors[0], '.nv-pet-wrap.nv-pet-rest.nv-pet-rest.nv-pet-rest', '(0,4,0) shape like .nv-pet-paused');
  assert.equal(rule.selectors.length, 2);
  const m = rule.selectors[1].match(/^\.nv-pet-wrap\.nv-pet-rest\.nv-pet-rest\.nv-pet-rest \*((?::not\(\.[\w-]+\))+)$/);
  assert.ok(m, `unexpected descendant selector: ${rule.selectors[1]}`);
  const excluded = [...m[1].matchAll(/:not\(\.([\w-]+)\)/g)].map((x) => x[1]).sort();
  assert.deepEqual(excluded, ['m-blink-loop', 'mascot-svg'], 'only the breathing and the blink survive rest');
  assert.match(rule.body, /animation-play-state:\s*paused\s*!important/);
  assert.doesNotMatch(rule.body, /animation:\s*none/, 'pause, never remove (no jump on resume)');

  // The two survivors are the breathing and the blink.
  assert.ok(rules.some((r) => r.selectors.includes('.nv-pet-wrap .mascot-svg') && /nv-pet-mascotHoverPhysics 3\.2s/.test(r.body)));
  assert.ok(rules.some((r) => r.selectors.includes('.nv-pet-wrap .m-blink-loop') && /nv-pet-naturalBlink/.test(r.body)));
});

test('pet.css: deep rest also pauses the .mascot-svg breathing', () => {
  const rules = cssRules(read('src/renderer/pet/pet.css'));
  const deep = rules.filter((r) => r.selectors.some((s) => s.includes('nv-pet-rest-deep')));
  assert.equal(deep.length, 1);
  assert.deepEqual(deep[0].selectors, ['.nv-pet-wrap.nv-pet-rest-deep.nv-pet-rest-deep.nv-pet-rest-deep .mascot-svg']);
  assert.match(deep[0].body, /animation-play-state:\s*paused\s*!important/);
});

test('pet.css: prefers-reduced-motion reduces to the deep-rest level (only the blink runs)', () => {
  const css = stripComments(read('src/renderer/pet/pet.css'));
  // PET-SPEC 2026-10-26 §6.2 rewrote the block: the pause rule is now the FIRST
  // rule of a multi-rule @media block (then opacity-only cues: 200 ms fade, joy flash).
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{\s*([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].includes('.nv-pet-wrap'));
  assert.equal(blocks.length, 1, 'exactly one pet reduced-motion rule');
  const selectors = blocks[0][1].split(',').map((s) => s.trim());
  assert.deepEqual(selectors, [
    '.nv-pet-wrap.nv-pet-wrap.nv-pet-wrap.nv-pet-wrap',
    '.nv-pet-wrap.nv-pet-wrap.nv-pet-wrap.nv-pet-wrap *:not(.m-blink-loop)',
  ], 'excludes only the blink class');
  assert.equal(blocks[0][2].trim(), 'animation-play-state: paused !important;');
  // .m-blink-loop is the real carrier of the blink animation.
  assert.ok(cssRules(read('src/renderer/pet/pet.css')).some((r) =>
    r.selectors.includes('.nv-pet-wrap .m-blink-loop') && /animation: nv-pet-naturalBlink /.test(r.body)));
  assert.match(read('src/renderer/pet/PetWidget.tsx'), /<g className="m-blink-loop">/);
});

// ---------------------------------------------------------------------------
// 2b. Hacker canvas gate: run / throttle / stop
// ---------------------------------------------------------------------------

function loadWidget() {
  let seq = 0;
  const frames = new Map();
  const timeouts = new Map();
  const compiled = typescript.transpileModule(read('src/renderer/pet/PetWidget.tsx'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, jsx: typescript.JsxEmit.React },
  }).outputText;
  const stubs = {
    react: { useCallback: (f) => f, useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }), useState: (v) => [typeof v === 'function' ? v() : v, () => {}], createElement: () => null },
    'react-i18next': { useTranslation: () => ({ t: (k) => k }) },
    '@tanstack/react-query': { useQuery: () => ({}), useQueryClient: () => ({}) },
    'react-router-dom': { useLocation: () => ({ pathname: '/' }), useNavigate: () => () => {} },
    'lucide-react': { X: () => null },
    '../lib/api': { api: {}, queryKeys: {} },
    '../lib/modal-context': { useModal: () => ({ activeModal: null }) },
    './tips': {}, './pet.css': {}, './audioEngine': { petAudio: {} }, './petEngine': { createPetEngine: () => ({}) },
  };
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    module: mod, exports: mod.exports, console, performance, Math, Number,
    window: { localStorage: memoryStorage() },
    requestAnimationFrame: (cb) => { const id = ++seq; frames.set(id, cb); return id; },
    cancelAnimationFrame: (id) => { frames.delete(id); },
    setTimeout: (fn, ms) => { const id = ++seq; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timeouts.delete(id); },
    require: (id) => { if (id in stubs) return stubs[id]; throw new Error(`unexpected require: ${id}`); },
  }, { filename: 'src/renderer/pet/PetWidget.tsx' });
  const fireFrame = (ts) => { const [id, cb] = frames.entries().next().value; frames.delete(id); cb(ts); };
  const fireTimeout = () => { const [id, t] = timeouts.entries().next().value; timeouts.delete(id); t.fn(); };
  const canvas = { width: 0, height: 0, getContext: () => new Proxy({}, { get: () => () => undefined, set: () => true }) };
  return { ...mod.exports, frames, timeouts, fireFrame, fireTimeout, canvas };
}

// PET-SPEC 2026-10-26 §3.3/§7/§9.2: a modal or an unfocused window now THROTTLES
// (12 fps, CALM but alive) instead of stopping.
test('petAnimationMode: awake runs, rest/modal/unfocused throttle, deep/hidden/reduced-motion stop', () => {
  const { petAnimationMode, HACKER_REST_FPS } = loadWidget();
  assert.equal(HACKER_REST_FPS, 12);
  const base = { visible: true, modalOpen: false, reducedMotion: false, restLevel: 'awake' };
  assert.equal(petAnimationMode(base), 'run');
  assert.equal(petAnimationMode({ ...base, restLevel: 'rest' }), 'throttle');
  assert.equal(petAnimationMode({ ...base, restLevel: 'deep' }), 'stop');
  assert.equal(petAnimationMode({ ...base, modalOpen: true }), 'throttle');
  assert.equal(petAnimationMode({ ...base, visible: false }), 'stop');
  assert.equal(petAnimationMode({ ...base, reducedMotion: true }), 'stop');
  assert.equal(petAnimationMode({ ...base, restLevel: 'rest', modalOpen: true }), 'throttle');
  assert.equal(petAnimationMode({ ...base, focused: false }), 'throttle');
  assert.equal(petAnimationMode({ ...base, focused: true }), 'run');
});

test('applyPetAnimationGate maps each mode onto the canvas driver', () => {
  const { applyPetAnimationGate } = loadWidget();
  const calls = [];
  const driver = { start: () => calls.push('start'), stop: () => calls.push('stop'), setMaxFps: (n) => calls.push(`fps:${n}`) };
  applyPetAnimationGate('run', driver);
  applyPetAnimationGate('throttle', driver);
  applyPetAnimationGate('stop', driver);
  // §7/§9.1: ALIVE is capped at HACKER_ACTIVE_FPS = 30 (was null = full rAF).
  assert.deepEqual(calls, ['fps:30', 'start', 'fps:12', 'start', 'stop']);
});

test('PixelHackerRenderer.setMaxFps schedules the next frame through a timeout; destroy clears both handles', () => {
  const w = loadWidget();
  const r = w.PixelHackerRenderer.create(w.canvas);
  r.setMaxFps(12);
  r.start();
  assert.equal(w.frames.size, 1);
  w.fireFrame(1000);
  assert.equal(w.frames.size, 0, 'throttled: no rAF armed directly');
  assert.equal(w.timeouts.size, 1);
  assert.equal([...w.timeouts.values()][0].ms, 1000 / 12);
  r.start();
  assert.equal(w.frames.size + w.timeouts.size, 1, 'start() during the throttle gap never arms a second loop');
  w.fireTimeout();
  assert.equal(w.frames.size, 1, 'the timeout arms exactly one rAF');
  w.fireFrame(1083);
  assert.equal(w.timeouts.size, 1);
  r.destroy();
  assert.equal(w.frames.size + w.timeouts.size, 0, 'destroy clears the pending timeout');
  r.start();
  r.destroy();
  assert.equal(w.frames.size + w.timeouts.size, 0, 'destroy clears the armed rAF');

  r.setMaxFps(null);
  r.start();
  w.fireFrame(2000);
  assert.equal(w.frames.size, 1, 'unthrottled: back to direct rAF');
  assert.equal(w.timeouts.size, 0);
  r.destroy();
});

test('PetWidget re-runs the canvas gate on rest level, modal, visibility and reduced-motion changes', () => {
  const src = read('src/renderer/pet/PetWidget.tsx');
  // §1.1/§9.2: focus is a gate input too (CALM throttles).
  assert.match(src, /const mode = petAnimationMode\(\{ visible: pageVisible, modalOpen: activeModal !== null, focused, reducedMotion, restLevel \}\);/);
  assert.match(src, /\}, \[character, pageVisible, activeModal, focused, reducedMotion, restLevel\]\);/);
  assert.match(src, /setMaxFps: \(n\) => hackerRendererRef\.current\?\.setMaxFps\(n\)/);
  assert.match(src, /const \[reducedMotion, setReducedMotion\] = useState<boolean>\(prefersReducedMotion\);/);
  assert.match(src, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
});

// ---------------------------------------------------------------------------
// 3. Modal open => paused; typed onOpenDonation
// ---------------------------------------------------------------------------

// PET-SPEC 2026-10-26 §1.5/§3.3/§9.2: a modal no longer pauses the CSS layer
// (the pet stays CALM but alive behind it); only HIDDEN sets nv-pet-paused.
test('PetWidget is paused only while hidden, not while an app modal is open', () => {
  const src = read('src/renderer/pet/PetWidget.tsx');
  assert.match(src, /import \{ useModal, type ModalRequest \} from '\.\.\/lib\/modal-context';/);
  assert.match(src, /const \{ activeModal \} = useModal\(\);/);
  assert.doesNotMatch(src, /const pageAnimatable = pageVisible && activeModal === null;/);
  assert.match(src, /\$\{pageVisible \? '' : ' nv-pet-paused'\}/);
  assert.match(src, /onOpenDonation: \(request\?: ModalRequest\) => boolean;/);
});

test('DonationModal has no backdrop blur', () => {
  const src = read('src/renderer/pet/DonationModal.tsx');
  assert.doesNotMatch(src, /backdrop-blur/);
  assert.match(src, /className="fixed inset-0 z-50 flex items-center justify-center bg-black\/85 p-4 font-sans"/);
  assert.match(src, /className="fixed inset-0 z-\[60\] flex items-center justify-center bg-black\/90 p-4 font-sans"/);
});

// ---------------------------------------------------------------------------
// 4. Audio: noise buffers lazily on the first sound
// ---------------------------------------------------------------------------

function makeNode() {
  const store = {};
  return new Proxy(function node() {}, {
    get(_, key) {
      if (key in store) return store[key];
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === 'value') return 0;
      store[key] = makeNode();
      return store[key];
    },
    set(_, key, value) { store[key] = value; return true; },
    apply() { return makeNode(); },
  });
}

function loadAudio() {
  const SR = 48000;
  const buffers = [];
  const base = {
    currentTime: 0, sampleRate: SR, state: 'running', destination: makeNode(),
    resume: () => Promise.resolve(),
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      const buffer = { numberOfChannels: channels, length, sampleRate: rate, duration: length / rate, getChannelData: () => data };
      buffers.push(buffer);
      return buffer;
    },
  };
  const ctx = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => makeNode()) });
  const mod = { exports: {} };
  vm.runInNewContext(transpile('src/renderer/pet/audioEngine.ts'), {
    module: mod, exports: mod.exports, console,
    AudioContext: function AudioContext() { return ctx; },
    setTimeout: () => 0, clearTimeout: () => {},
  }, { filename: 'src/renderer/pet/audioEngine.ts' });
  const noise = () => buffers.filter((b) => b.length === SR * 3).length;
  return { petAudio: mod.exports.petAudio, noise };
}

test('audio: init() builds no noise buffers; the first sound builds both, once', () => {
  const { petAudio, noise } = loadAudio();
  petAudio.init();
  petAudio.setEnabled(true);
  assert.equal(petAudio.contextState(), 'running');
  assert.equal(noise(), 0, 'init() must not build the 3 s noise buffers');
  petAudio.playMascotBugHunter();
  assert.equal(noise(), 2, 'pink + brown built on the first sound');
  petAudio.playChime();
  assert.equal(noise(), 2, 'built once, reused');
});

// ---------------------------------------------------------------------------
// 5. Attention return deferred off the visibilitychange / focus task
// ---------------------------------------------------------------------------

function fakeWindow({ idle = true } = {}) {
  const win = new Map();
  const doc = new Map();
  let seq = 0;
  const queue = new Map();
  const w = {
    addEventListener: (t, f) => win.set(t, f),
    removeEventListener: (t) => win.delete(t),
    document: {
      visibilityState: 'visible',
      addEventListener: (t, f) => doc.set(t, f),
      removeEventListener: (t) => doc.delete(t),
    },
    setTimeout: (fn, ms) => { const id = ++seq; queue.set(id, { fn, kind: 'timeout', ms }); return id; },
    clearTimeout: (id) => { queue.delete(id); },
  };
  if (idle) {
    w.requestIdleCallback = (fn, opts) => { const id = ++seq; queue.set(id, { fn, kind: 'idle', timeout: opts?.timeout }); return id; };
    w.cancelIdleCallback = (id) => { queue.delete(id); };
  }
  return {
    w,
    queue,
    fire: (target, type) => (target === 'doc' ? doc : win).get(type)(),
    flush() { const items = [...queue.values()]; queue.clear(); for (const q of items) q.fn(); },
  };
}

test('visibilitychange/focus return is deferred to an idle callback (with timeout) and coalesced', () => {
  let now = 0;
  const FakeDate = { now: () => now };
  const { createPetEngine } = loadEngine({ Date: FakeDate });
  let cues = 0;
  let switches = 0;
  const engine = createPetEngine({ isVip: () => false, onActivityChange: () => { switches++; }, onCue: () => { cues++; } });
  const fw = fakeWindow();
  let gained = 0;
  engine.attachFocusListeners(fw.w, { onAttentionGained: () => { gained++; } });

  now = 100000;
  fw.w.document.visibilityState = 'hidden';
  fw.fire('doc', 'visibilitychange');
  now = 101000;
  fw.w.document.visibilityState = 'visible';
  const before = switches;
  fw.fire('doc', 'visibilitychange');
  fw.fire('win', 'focus');
  assert.equal(gained, 0, 'no attention work inside the visibilitychange task');
  assert.equal(cues, 0);
  assert.equal(switches, before, 'no activity switch (and so no SFX) inside the task');
  assert.equal(fw.queue.size, 1, 'focus + visibilitychange of one show coalesce');
  const [pending] = fw.queue.values();
  assert.equal(pending.kind, 'idle');
  assert.ok(pending.timeout > 0, 'idle callback has a timeout fallback');
  fw.flush();
  assert.equal(gained, 1);
  assert.equal(cues, 1, 'the cue still fires, only later');
  assert.equal(switches, before + 1);
});

test('deferred return: setTimeout(0) fallback, cancelled by blur and by the disposer', () => {
  const { createPetEngine } = loadEngine();
  const engine = createPetEngine({ isVip: () => false, onActivityChange: () => {}, onCue: () => {} });
  const fw = fakeWindow({ idle: false });
  let gained = 0;
  const detach = engine.attachFocusListeners(fw.w, { onAttentionGained: () => { gained++; } });

  fw.fire('win', 'focus');
  const [pending] = fw.queue.values();
  assert.equal(pending.kind, 'timeout');
  assert.equal(pending.ms, 0);
  fw.fire('win', 'blur');
  assert.equal(fw.queue.size, 0, 'a later blur cancels the pending return');
  fw.flush();
  assert.equal(gained, 0);

  fw.fire('win', 'focus');
  detach();
  assert.equal(fw.queue.size, 0, 'the disposer cancels the pending return');
});
