// Alive pet engine (internal pet design spec §1.1-1.3, §7, §9.1/9.2).
// Pure engine checks with fake timers, an injected clock and a seeded random.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/renderer/pet/petEngine.ts'), 'utf8');
const compiled = typescript.transpileModule(source, {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
}).outputText;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function loadEngine(character = 'mascot') {
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    module: mod, exports: mod.exports, console, Math, Date,
    sessionStorage: memoryStorage({ nv_pet_character: character }), localStorage: memoryStorage(),
  }, { filename: 'src/renderer/pet/petEngine.ts' });
  return mod.exports;
}

/** Deterministic fake timers sharing one clock. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
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

/** Seeded PRNG (mulberry32), [0,1). */
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

function fakeWindow() {
  const win = new Map();
  const doc = new Map();
  const queue = [];
  const w = {
    addEventListener: (t, f) => win.set(t, f),
    removeEventListener: (t) => win.delete(t),
    document: {
      visibilityState: 'visible',
      addEventListener: (t, f) => doc.set(t, f),
      removeEventListener: (t) => doc.delete(t),
    },
    setTimeout: (fn) => { queue.push(fn); return queue.length; },
    clearTimeout: () => { queue.length = 0; },
  };
  return {
    w,
    blur: () => win.get('blur')(),
    focus: () => { win.get('focus')(); const q = queue.splice(0); for (const fn of q) fn(); },
  };
}

// ---------------------------------------------------------------------------
// Constants (§9.1)
// ---------------------------------------------------------------------------

test('constants match spec §9.1', () => {
  const e = loadEngine();
  assert.equal(e.SWITCH_COOLDOWN_MS, 5000);
  assert.equal(e.MIN_AWAY_MS, 800);
  assert.equal(e.PET_REST_DELAY_MS, 60000);
  assert.equal(e.PET_DEEP_REST_DELAY_MS, 180000);
  assert.equal(e.ACTIVITY_DWELL_MIN_MS, 18000);
  assert.equal(e.ACTIVITY_DWELL_MAX_MS, 30000);
  assert.equal(e.MICRO_MIN_MS, 4000);
  assert.equal(e.MICRO_MAX_MS, 7000);
});

// ---------------------------------------------------------------------------
// Rest only while visible + unfocused (§1.1)
// ---------------------------------------------------------------------------

test('alive while focused: no rest after 10 min, even with wake/release events', () => {
  const { createPetRestTimer } = loadEngine();
  const clock = fakeClock();
  const changes = [];
  const rest = createPetRestTimer({ onChange: (l) => changes.push(l), setTimer: clock.set, clearTimer: clock.clear, initialFocused: true });
  rest.wake();
  assert.equal(clock.pending(), 0, 'focused: no rest timer armed');
  clock.advance(300000);
  rest.wake(); // activity switch while focused
  rest.hold();
  rest.release(); // pointer left while focused
  clock.advance(300000);
  assert.equal(rest.level(), 'awake');
  assert.deepEqual(changes, [], 'never left awake in 10 min focused');
});

test('unfocused (visible): rest at 60 s and deep at 180 s after the blur', () => {
  const { createPetRestTimer } = loadEngine();
  const clock = fakeClock();
  const rest = createPetRestTimer({ onChange: () => {}, setTimer: clock.set, clearTimer: clock.clear, initialFocused: true });
  rest.wake();
  clock.advance(5000);
  rest.blur();
  clock.advance(59999);
  assert.equal(rest.level(), 'awake');
  clock.advance(1);
  assert.equal(rest.level(), 'rest', 'rest 60 s after the blur');
  clock.advance(119999);
  assert.equal(rest.level(), 'rest');
  clock.advance(1);
  assert.equal(rest.level(), 'deep', 'deep 180 s after the blur');

  rest.focus();
  assert.equal(rest.level(), 'awake', 'focus wakes at once');
  assert.equal(clock.pending(), 0, 'focus clears the timers without arming');
  clock.advance(600000);
  assert.equal(rest.level(), 'awake');
});

test('rest timer: a second blur does not restart the count; hidden (stop) is a full pause', () => {
  const { createPetRestTimer } = loadEngine();
  const clock = fakeClock();
  const rest = createPetRestTimer({ onChange: () => {}, setTimer: clock.set, clearTimer: clock.clear, initialFocused: true });
  rest.blur();
  clock.advance(30000);
  rest.blur(); // duplicate blur (blur + visibilitychange pair)
  clock.advance(30000);
  assert.equal(rest.level(), 'rest', 'counted from the first blur');

  rest.stop(); // hidden
  rest.blur(); // a blur arriving while hidden must not arm
  assert.equal(clock.pending(), 0);
  clock.advance(600000);
  assert.equal(rest.level(), 'awake');
  rest.wake(); // shown again, still unfocused
  clock.advance(60000);
  assert.equal(rest.level(), 'rest', 'shown unfocused: rest 60 s later');
});

test('rest timer: hover while unfocused holds; leaving arms 60 s; focus during hover keeps the hold', () => {
  const { createPetRestTimer } = loadEngine();
  const clock = fakeClock();
  const rest = createPetRestTimer({ onChange: () => {}, setTimer: clock.set, clearTimer: clock.clear, initialFocused: true });
  rest.blur();
  rest.hold();
  assert.equal(clock.pending(), 0);
  clock.advance(200000);
  assert.equal(rest.level(), 'awake');
  rest.release();
  clock.advance(60000);
  assert.equal(rest.level(), 'rest');
  rest.focus();
  rest.hold();
  rest.release();
  assert.equal(clock.pending(), 0, 'focused release does not arm');
});

// ---------------------------------------------------------------------------
// Shuffle bag (§1.2)
// ---------------------------------------------------------------------------

test('shuffle bag: no immediate repeat over 200 draws; every activity within each bag', () => {
  for (const character of ['mascot', 'hacker']) {
    const { createPetEngine } = loadEngine(character);
    const seen = [];
    const engine = createPetEngine({ isVip: () => false, onActivityChange: (a) => seen.push(a), onCue: () => {}, random: seeded(7) });
    let prev = engine.getActivity();
    for (let i = 0; i < 200; i++) {
      const next = engine.nextRandomActivity();
      assert.notEqual(next, prev, `${character}: repeat at draw ${i}`);
      prev = next;
    }
    // Draws come in bags of 7 (pool size): each bag holds all 7.
    for (let b = 0; b + 7 <= 196; b += 7) {
      assert.equal(new Set(seen.slice(b, b + 7)).size, 7, `${character}: bag at ${b} misses an activity`);
    }
  }
});

test('shuffle bag: VIP pool (5) rules unchanged, no repeat across bags or pool switches', () => {
  const { createPetEngine, VIP_ACTIVITIES, MASCOT_ACTIVITIES } = loadEngine('mascot');
  let vip = true;
  const seen = [];
  const engine = createPetEngine({ isVip: () => vip, onActivityChange: (a) => seen.push(a), onCue: () => {}, random: seeded(42) });
  let prev = engine.getActivity();
  for (let i = 0; i < 200; i++) {
    if (i === 100) vip = false;
    const next = engine.nextRandomActivity();
    assert.notEqual(next, prev);
    assert.ok((i < 100 ? VIP_ACTIVITIES : MASCOT_ACTIVITIES).includes(next), `draw ${i} from the right pool`);
    prev = next;
  }
  for (let b = 0; b + 5 <= 100; b += 5) assert.equal(new Set(seen.slice(b, b + 5)).size, 5);
});

test('shuffle bag: a forced setActivity is never drawn next', () => {
  const { createShuffleBag } = loadEngine();
  const bag = createShuffleBag(seeded(3));
  const pool = ['a', 'b', 'c'];
  for (let i = 0; i < 300; i++) {
    const avoid = pool[i % 3];
    assert.notEqual(bag.draw(pool, avoid), avoid);
  }
  assert.equal(bag.draw(['solo'], 'solo'), 'solo', 'a one-item pool returns its item');
});

// ---------------------------------------------------------------------------
// Activity dwell timer (§1.2)
// ---------------------------------------------------------------------------

test('activity timer: next activity every 18-30 s while alive; pause keeps the remainder', () => {
  const { createActivityTimer, createPetEngine } = loadEngine();
  const clock = fakeClock();
  const engine = createPetEngine({ isVip: () => false, onActivityChange: () => {}, onCue: () => {}, now: clock.now, random: seeded(11) });
  const switches = [];
  const timer = createActivityTimer({
    onDue: () => { engine.nextRandomActivity(); switches.push(clock.now()); },
    setTimer: clock.set, clearTimer: clock.clear, now: clock.now, random: seeded(5),
  });
  timer.start();
  clock.advance(300000); // 5 min focused
  assert.ok(switches.length >= 10 && switches.length <= 17, `AC1: ${switches.length} changes in 5 min`);
  let last = 0;
  for (const at of switches) {
    const gap = at - last;
    assert.ok(gap >= 18000 && gap <= 30000, `gap ${gap} ms`);
    last = at;
  }
  assert.equal(clock.pending(), 1, 'one setTimeout per timer kind');

  const left = timer.remainingMs();
  timer.pause(); // CALM
  assert.equal(clock.pending(), 0);
  clock.advance(100000);
  assert.equal(timer.remainingMs(), left, 'remaining time kept while paused');
  const n = switches.length;
  timer.resume();
  clock.advance(left - 1);
  assert.equal(switches.length, n);
  clock.advance(1);
  assert.equal(switches.length, n + 1, 'resumes with the kept remainder');

  timer.pause();
  timer.resume(3000); // modal closed with little time left: at least 3 s
  assert.ok(timer.remainingMs() >= 3000);
  timer.stop(); // hidden
  assert.equal(clock.pending(), 0);
  assert.equal(timer.remainingMs(), null);
});

test('focus return: 5 s cooldown and 800 ms flicker filter; switch restarts the dwell', () => {
  const { createPetEngine, createActivityTimer } = loadEngine();
  const clock = fakeClock();
  let cues = 0;
  const engine = createPetEngine({ isVip: () => false, onActivityChange: () => {}, onCue: () => { cues++; timer.start(); }, now: clock.now, random: seeded(9) });
  const timer = createActivityTimer({ onDue: () => engine.nextRandomActivity(), setTimer: clock.set, clearTimer: clock.clear, now: clock.now, random: seeded(1) });
  const fw = fakeWindow();
  engine.attachFocusListeners(fw.w);
  timer.start();

  clock.advance(10000);
  fw.blur();
  clock.advance(1000);
  let before = engine.getActivity();
  fw.focus(); // away 1 s, 11 s since start
  assert.equal(cues, 1, 'genuine return after >= 5 s: switch + cue');
  assert.notEqual(engine.getActivity(), before);
  const r = timer.remainingMs();
  assert.ok(r >= 18000 && r <= 30000, 'the focus-return switch restarts the dwell');

  clock.advance(2000);
  fw.blur();
  clock.advance(1000); // 3 s since the switch
  before = engine.getActivity();
  fw.focus();
  assert.equal(cues, 1, 'within 5 s of the last switch: no change');
  assert.equal(engine.getActivity(), before);

  clock.advance(5000);
  fw.blur();
  clock.advance(1000); // 9 s since the switch
  fw.focus();
  assert.equal(cues, 2, 'after 6+ s: change');

  clock.advance(10000);
  fw.blur();
  clock.advance(799); // flicker
  fw.focus();
  assert.equal(cues, 2, 'away < 800 ms: no change');
  fw.blur();
  clock.advance(800);
  fw.focus();
  assert.equal(cues, 3, 'away exactly 800 ms counts');
});

// ---------------------------------------------------------------------------
// Micro-actions (§1.3, §1.4)
// ---------------------------------------------------------------------------

test('micro scheduler: one micro every 4-7 s after the previous one ends; never twice in a row', () => {
  for (const character of ['mascot', 'hacker']) {
    const { createMicroScheduler, allowedMicros, MASCOT_STATIONS } = loadEngine(character);
    const clock = fakeClock();
    const activity = character === 'mascot' ? 'bug-hunter' : 'flowchart';
    const fired = [];
    const ends = [];
    const micro = createMicroScheduler({
      character: () => character, activity: () => activity,
      onMicro: (ev) => fired.push({ ...ev, at: clock.now() }),
      onMicroEnd: () => ends.push(clock.now()),
      setTimer: clock.set, clearTimer: clock.clear, now: clock.now, random: seeded(21),
    });
    micro.start();
    clock.advance(60000);
    assert.ok(fired.length >= 8, `${character}: AC4 at least 8 moves in 60 s (got ${fired.length})`);
    let prevEnd = 0;
    for (let i = 0; i < fired.length; i++) {
      const gap = fired[i].at - prevEnd;
      assert.ok(gap >= 4000 && gap <= 7000, `${character}: gap ${gap}`);
      assert.ok(allowedMicros(character, activity).includes(fired[i].id));
      if (i > 0) assert.notEqual(fired[i].id, fired[i - 1].id, `${character}: repeat at ${i}`);
      if (fired[i].id === 'drift') assert.ok(MASCOT_STATIONS.includes(fired[i].station));
      assert.equal(ends[i] - fired[i].at, fired[i].durationMs, 'beat lasts its duration');
      prevEnd = ends[i];
    }
    assert.ok(clock.pending() <= 1, 'one setTimeout at a time');
    micro.stop();
    assert.equal(clock.pending(), 0);
    assert.equal(micro.current(), null);
  }
});

test('micro scheduler: skipped right after a switch, near the next switch and while blocked', () => {
  const { createMicroScheduler } = loadEngine();
  const clock = fakeClock();
  const fired = [];
  let left = 20000;
  let blocked = false;
  const micro = createMicroScheduler({
    character: () => 'mascot', activity: () => 'power-nap',
    onMicro: (ev) => fired.push(ev.id),
    activityRemainingMs: () => left, isBlocked: () => blocked,
    setTimer: clock.set, clearTimer: clock.clear, now: clock.now, random: seeded(2),
  });
  micro.start();
  micro.notifyActivityChange();
  assert.equal(micro.station(), 0, 'station resets on activity change');
  left = 2000;
  clock.advance(7000);
  assert.equal(fired.length, 0, '< 3 s to the next switch: skipped');
  left = 20000;
  blocked = true;
  clock.advance(7000);
  assert.equal(fired.length, 0, 'JOY/HINT/CELEBRATION: skipped');
  blocked = false;
  clock.advance(7000);
  assert.equal(fired.length, 1);
  assert.ok(['drift', 'dip'].includes(fired[0]), 'power-nap allows only slow drift and dip');

  // 1.5 s quiet window after an activity change.
  const c2 = fakeClock();
  const f2 = [];
  const m2 = createMicroScheduler({
    character: () => 'mascot', activity: () => 'bug-hunter', onMicro: (ev) => f2.push(c2.now()),
    setTimer: c2.set, clearTimer: c2.clear, now: c2.now, random: () => 0, // gap = 4000
  });
  m2.start();
  c2.advance(3000);
  m2.notifyActivityChange(); // at 3 s; the micro is due at 4 s, inside the quiet window
  c2.advance(1000);
  assert.equal(f2.length, 0, 'within 1.5 s after a switch: skipped');
  c2.advance(4000);
  assert.equal(f2.length, 1);
});

test('micro tables: per-activity ids follow §1.4; drift slow in nap; flowchart doubles stretch/wave/roll', () => {
  const { allowedMicros, microDurationMs, microWeight, pickMicro } = loadEngine();
  assert.deepEqual([...allowedMicros('mascot', 'sensor-polish')], ['drift', 'hop', 'look-l', 'look-r', 'dip', 'peek']);
  assert.deepEqual([...allowedMicros('hacker', 'terminal-nap')], ['chair-sway']);
  assert.deepEqual([...allowedMicros('hacker', 'zero-errors')], ['look', 'chair-sway', 'roll']);
  assert.deepEqual([...allowedMicros('hacker', 'hyper-hack')], ['look', 'chair-sway', 'lean', 'chair-hop', 'roll']);
  assert.equal(allowedMicros('mascot', 'hyper-hack').length, 7);
  assert.equal(microDurationMs('mascot', 'power-nap', 'drift'), 2400);
  assert.equal(microDurationMs('mascot', 'bug-hunter', 'drift'), 1400);
  assert.equal(microWeight('hacker', 'flowchart', 'roll'), 4);
  assert.equal(microWeight('hacker', 'coin-drop', 'roll'), 2);
  assert.equal(pickMicro('hacker', 'terminal-nap', 'chair-sway', seeded(1)), 'chair-sway', 'single allowed micro may repeat');
});
