// PET-SPEC-2026-10-26 §5 (sound): ambient cadence 60–90 s, ambient as loud as
// activity sounds, ambient-only gate, explicit activity -> cue table with no
// back-to-back (cue, variant) repeat. Driven against a fake clock and a mock
// AudioContext; audible output in the shipped app is NOT verified here.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/renderer/pet/audioEngine.ts'), 'utf8');
const compiled = typescript.transpileModule(source, {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }
}).outputText;

function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, delay) {
      const id = ++seq;
      timers.set(id, { fn, at: now + (Number(delay) || 0) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let pick = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (pick === null || timer.at < timers.get(pick).at)) pick = id;
        }
        if (pick === null) break;
        const timer = timers.get(pick);
        timers.delete(pick);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
    now: () => now
  };
}

class Param {
  constructor(v = 0) { this.value = v; this.events = []; }
  setValueAtTime(v, t) { this.events.push({ v, t }); this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
  cancelScheduledValues() {}
}
class Node {
  connect(d) { return d; }
  disconnect() {}
}
class Gain extends Node { constructor() { super(); this.gain = new Param(1); } }
class Source extends Node {
  constructor() { super(); this.frequency = new Param(440); }
  start() {}
  stop() {}
}
class Filter extends Node { constructor() { super(); this.frequency = new Param(1000); this.Q = new Param(1); } }
class Compressor extends Node {
  constructor() {
    super();
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) this[k] = new Param(0);
  }
}
class Ctx {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.sampleRate = 8000;
    this.destination = new Node();
    this.gains = [];
  }
  createGain() { const g = new Gain(); this.gains.push(g); return g; }
  createOscillator() { return new Source(); }
  createBufferSource() { return new Source(); }
  createBiquadFilter() { return new Filter(); }
  createWaveShaper() { return new Node(); }
  createDynamicsCompressor() { return new Compressor(); }
  createAnalyser() { return new Node(); }
  createBuffer(c, l) { const d = new Float32Array(l); return { getChannelData: () => d }; }
  resume() { return Promise.resolve(); }
}

function load({ persona = 'mascot' } = {}) {
  const clock = makeClock();
  const ctx = new Ctx();
  const moduleObj = { exports: {} };
  vm.runInNewContext(compiled, {
    console,
    Math,
    exports: moduleObj.exports,
    module: moduleObj,
    AudioContext: function () { return ctx; },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    sessionStorage: { getItem: (k) => (k === 'nv_pet_character' ? persona : null) }
  });
  const mod = moduleObj.exports;
  const petAudio = mod.petAudio;

  // Record every ambient fire time and every (cue, variant) actually played.
  const fires = [];
  const played = [];
  const originalFire = petAudio.fireAmbientSound.bind(petAudio);
  petAudio.fireAmbientSound = () => {
    fires.push(clock.now());
    originalFire();
  };
  const cues = new Set(Object.values(mod.AMBIENT_ACTIVITY_CUES).flat());
  for (const key of cues) {
    const original = petAudio[key].bind(petAudio);
    petAudio[key] = (variant) => {
      const v = original(variant);
      played.push({ key, v, ambient: petAudio.isAmbientContext });
      return v;
    };
  }
  return { mod, petAudio, clock, ctx, fires, played };
}

test('constants follow PET-SPEC §5.1/§5.2/§9.1', () => {
  const { mod } = load();
  assert.equal(mod.AMBIENT_GAIN_SCALE, 1.0);
  assert.equal(mod.AMBIENT_MIN_MS, 60_000);
  assert.equal(mod.AMBIENT_MAX_MS, 90_000);
  assert.match(source, /masterGain\.gain\.setValueAtTime\(0\.52, ctx\.currentTime\)/, 'master gain stays 0.52');
});

test('every ambient interval lies within [60000, 90000] ms', () => {
  const { petAudio, clock, fires } = load();
  petAudio.setEnabled(true);
  petAudio.scheduleAmbient(() => 'bug-hunter');
  clock.advance(4 * 60 * 60_000); // 4 h -> ~190 intervals
  assert.ok(fires.length >= 150, `expected many fires, got ${fires.length}`);
  let prev = 0;
  for (const at of fires) {
    const gap = at - prev;
    assert.ok(gap >= 60_000 && gap <= 90_000, `gap ${gap} ms outside [60000, 90000]`);
    prev = at;
  }
});

test('ambient voice gain equals the activity voice gain for the same cue (scale 1.0)', () => {
  const { petAudio, clock, ctx, played } = load();
  petAudio.setEnabled(true);
  petAudio.scheduleAmbient(() => 'bug-hunter');
  const before = ctx.gains.length;
  clock.advance(90_000);
  assert.equal(played.length, 1);
  assert.equal(played[0].ambient, true);
  const ambientVoiceGain = ctx.gains[before].gain.events[0].v;

  petAudio.stopAmbient();
  const before2 = ctx.gains.length;
  petAudio.playMascotBugHunter(0); // activity (non-ambient) path
  const activityVoiceGain = ctx.gains[before2].gain.events[0].v;
  assert.ok(activityVoiceGain > 0);
  assert.equal(ambientVoiceGain, activityVoiceGain, 'ambient must be as loud as the activity sound');
});

test('gate closed (boolean) = no ambient timer and silence; other sounds unaffected', () => {
  const { petAudio, clock, fires, played } = load();
  petAudio.setEnabled(true);
  petAudio.scheduleAmbient(() => 'code-frenzy');
  petAudio.setAmbientGate(false);
  clock.advance(30 * 60_000);
  assert.deepEqual(fires, []);
  assert.deepEqual(played, []);
  // Re-registering the cadence while closed must not sneak a timer in.
  petAudio.scheduleAmbient(() => 'code-frenzy');
  clock.advance(30 * 60_000);
  assert.deepEqual(fires, []);
  // The ambient gate is ambient-only: direct sounds still play.
  assert.ok(petAudio.playChime() >= 0, 'non-ambient sound must not be blocked by the ambient gate');
});

test('gate closed (predicate) = silence on every tick; recovery resumes the cadence', () => {
  const { petAudio, clock, played } = load();
  petAudio.setEnabled(true);
  let open = false;
  petAudio.setAmbientGate(() => open);
  petAudio.scheduleAmbient(() => 'flowchart');
  clock.advance(30 * 60_000);
  assert.deepEqual(played, []);
  petAudio.setAmbientGate(() => { throw new Error('boom'); });
  assert.doesNotThrow(() => clock.advance(10 * 60_000));
  assert.deepEqual(played, [], 'a throwing ambient gate resolves to silence');
  petAudio.setAmbientGate(() => open);
  open = true;
  clock.advance(90_000);
  assert.ok(played.length >= 1);
});

test('reopening the gate schedules the next ambient 60–90 s later, never immediately', () => {
  for (let run = 0; run < 50; run++) {
    const { petAudio, clock, fires } = load();
    petAudio.setEnabled(true);
    petAudio.scheduleAmbient(() => 'empty-mug');
    clock.advance(Math.floor(Math.random() * 200_000));
    petAudio.setAmbientGate(false);
    clock.advance(Math.floor(Math.random() * 600_000));
    const firesBefore = fires.length;
    const reopenedAt = clock.now();
    petAudio.setAmbientGate(true);
    clock.advance(59_999);
    assert.equal(fires.length, firesBefore, 'no ambient within 60 s of reopening');
    clock.advance(30_001);
    assert.equal(fires.length, firesBefore + 1, 'exactly one ambient by 90 s after reopening');
    assert.ok(fires.at(-1) - reopenedAt >= 60_000);
    // Re-opening an already open gate does not restart or double the timer.
    petAudio.setAmbientGate(true);
    clock.advance(59_999);
    assert.ok(fires.length <= firesBefore + 2);
  }
});

test('activity -> cue table: every ambient cue belongs to the activity (§5.3)', () => {
  const { mod, petAudio, clock, played } = load();
  petAudio.setEnabled(true);
  for (const [activity, cues] of Object.entries(mod.AMBIENT_ACTIVITY_CUES)) {
    played.length = 0;
    petAudio.scheduleAmbient(() => activity);
    clock.advance(40 * 90_000);
    assert.ok(played.length >= 20, `${activity}: ${played.length} ambients`);
    for (const p of played) {
      assert.ok(cues.includes(p.key), `${activity} played ${p.key}, allowed ${cues.join(', ')}`);
    }
    if (cues.length > 1) {
      assert.ok(played.some((p) => p.key === cues[0]) && played.some((p) => p.key === cues[1]), `${activity}: both cues must occur`);
    }
  }
  assert.deepEqual([...mod.AMBIENT_ACTIVITY_CUES['bug-hunter']], ['playMascotBugHunter'], 'bug-hunter never maps to the mug tap');
});

test('no back-to-back (cue, variant) repeat, single- and two-cue activities', () => {
  for (const activity of ['bug-hunter', 'low-battery', 'code-frenzy', 'terminal-nap', 'syndicate-salute']) {
    const { petAudio, clock, played } = load();
    petAudio.setEnabled(true);
    petAudio.scheduleAmbient(() => activity);
    clock.advance(300 * 90_000);
    assert.ok(played.length >= 250);
    for (let i = 1; i < played.length; i++) {
      const a = played[i - 1];
      const b = played[i];
      assert.ok(b.v >= 0 && b.v <= 2);
      assert.ok(!(a.key === b.key && a.v === b.v), `${activity}: ${b.key}#${b.v} repeated at ${i}`);
    }
  }
});

test('idle activity keeps the persona shuffle deck with no consecutive cue repeat', () => {
  for (const persona of ['mascot', 'hacker']) {
    const { petAudio, clock } = load({ persona });
    petAudio.setEnabled(true);
    const seen = [];
    const field = persona === 'hacker' ? 'lastHackerIdleCue' : 'lastMascotIdleCue';
    const original = petAudio.fireAmbientSound;
    petAudio.fireAmbientSound = () => {
      original();
      seen.push(petAudio[field]);
    };
    petAudio.scheduleAmbient(() => 'idle');
    clock.advance(200 * 90_000);
    assert.ok(seen.length >= 150);
    for (let i = 1; i < seen.length; i++) {
      assert.notEqual(seen[i], seen[i - 1], `${persona} idle repeated ${seen[i]} at ${i}`);
    }
  }
});
