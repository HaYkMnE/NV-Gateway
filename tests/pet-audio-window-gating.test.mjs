// П7 — the pet must be SILENT whenever the window is not actually active
// (hidden to tray, minimised, or merely unfocused).
//
// WHY THESE TESTS LOOK LIKE THIS. There is no jsdom and no
// @testing-library/react in node_modules, so the component cannot be rendered
// and real Web Audio cannot be driven. What IS testable, and what actually
// carries the defect, is the audio engine's ambient scheduler plus the pure
// window-state predicate. Both are exercised here against injected fakes (an
// injected clock and an injected audibility gate), matching the DI style the
// rest of the suite already uses for platform/executor/Electron surfaces.
// Audible behaviour in the shipped app is NOT verified by these tests.
//
// MEASURED GAP being pinned down. Gating today is TRANSITION-ONLY: PetWidget
// stops the ambient cadence from petEngine's onAttentionLost hook. Nothing ever
// consults the CURRENT window state, so any hide that does not deliver an
// observed blur/visibilitychange to the renderer leaves the 45–90 s ambient
// timer armed and the pet keeps talking into the tray. `hasFocus` appears
// nowhere in src/. These tests fail before the fix for exactly that reason.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

/** Deterministic timer scheduler so the 45–90 s cadence is testable. */
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
    /** Run every timer due within `ms`, in due order. */
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
    pending() {
      return timers.size;
    },
    now() {
      return now;
    }
  };
}

/**
 * Compile + run audioEngine.ts in a fresh realm with NO AudioContext, so no
 * real audio hardware is touched. Every sound-producing method is replaced by
 * a spy, which is the level the ambient scheduler decides at.
 */
function loadAudioEngine() {
  const compiled = typescript.transpileModule(read('src/renderer/pet/audioEngine.ts'), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020
    }
  });
  const clock = makeClock();
  const moduleObj = { exports: {} };
  const context = {
    console,
    exports: moduleObj.exports,
    module: moduleObj,
    setTimeout: (fn, delay) => clock.setTimeout(fn, delay),
    clearTimeout: (id) => clock.clearTimeout(id)
    // AudioContext intentionally absent: init() must no-op.
  };
  vm.runInNewContext(compiled.outputText, context, {
    filename: 'src/renderer/pet/audioEngine.ts'
  });

  const petAudio = moduleObj.exports.petAudio;
  assert.ok(petAudio, 'audioEngine must export petAudio');

  // Spy over every method the ambient mix can reach.
  const played = [];
  const AMBIENT_SFX = [
    'playOrganicSnoring',
    'playSadTiredSigh',
    'playOrganicYawn',
    'playHackerCodeFrenzy',
    'playHackerFlowchart',
    'playMugTableTap',
    'playMascotNanoCoffee',
    'playStomachRumbling',
    'playRealisticCoinDrop',
    'playActionCheer',
    'playChime',
    'playMascotSensorPolish',
    'playMascotModelJuggler'
  ];
  for (const key of AMBIENT_SFX) {
    assert.equal(typeof petAudio[key], 'function', `expected petAudio.${key} to exist`);
    petAudio[key] = () => {
      played.push(key);
      return 0;
    };
  }

  return { petAudio, clock, played };
}

/** Fake window/document for the pure audibility predicate. */
function fakeWindow({ visibility, focused }) {
  return {
    document: {
      visibilityState: visibility,
      hasFocus: () => focused
    }
  };
}

/** Load PetWidget's exported pure helpers without rendering React. */
function loadWidgetHelpers() {
  const compiled = typescript.transpileModule(read('src/renderer/pet/PetWidget.tsx'), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
      jsx: typescript.JsxEmit.React
    }
  });
  const moduleObj = { exports: {} };
  const stubs = {
    react: {
      useCallback: (fn) => fn,
      useEffect: () => {},
      useRef: (v) => ({ current: v }),
      useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
      createElement: () => null
    },
    'react-i18next': { useTranslation: () => ({ t: (k) => k }) },
    './pet.css': {},
    './audioEngine': { petAudio: {} },
    './petEngine': { createPetEngine: () => ({}) }
  };
  const context = {
    console,
    exports: moduleObj.exports,
    module: moduleObj,
    window: { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } },
    require: (id) => {
      if (id in stubs) return stubs[id];
      throw new Error(`unexpected require: ${id}`);
    }
  };
  vm.runInNewContext(compiled.outputText, context, {
    filename: 'src/renderer/pet/PetWidget.tsx'
  });
  return moduleObj.exports;
}

// ---------------------------------------------------------------------------
// 1. THE REPORTED DEFECT: hidden to tray, transition never observed
// ---------------------------------------------------------------------------

test('hidden to tray with no observed blur: the ambient cadence must go silent', () => {
  const { petAudio, clock, played } = loadAudioEngine();

  petAudio.setEnabled(true);

  // Window is active: cadence is legitimately armed.
  let audible = true;
  petAudio.setAudibleGate(() => audible);
  petAudio.scheduleAmbient(() => 'idle');

  clock.advance(120_000);
  assert.ok(played.length > 0, 'sanity: an active window must still make sound');

  // Now the window is hidden to the tray. Deliberately deliver NO blur and NO
  // visibilitychange — that missed transition is the reported defect.
  played.length = 0;
  audible = false;

  clock.advance(10 * 60_000); // ten minutes in the tray
  assert.deepEqual(played, [], 'pet must be silent while hidden to the tray');
});

// ---------------------------------------------------------------------------
// 2. VISIBLE BUT UNFOCUSED — visibilityState alone cannot catch this
// ---------------------------------------------------------------------------

test('visible but unfocused window is silent, and the predicate distinguishes all three states', () => {
  const { windowAudible } = loadWidgetHelpers();
  assert.equal(typeof windowAudible, 'function', 'PetWidget must export windowAudible');

  // Case 1: on screen, user working elsewhere.
  assert.equal(windowAudible(fakeWindow({ visibility: 'visible', focused: false })), false);
  // Case 2: minimised.
  assert.equal(windowAudible(fakeWindow({ visibility: 'hidden', focused: false })), false);
  // Case 3: hidden to tray — whichever way visibilityState reports, unfocused.
  assert.equal(windowAudible(fakeWindow({ visibility: 'visible', focused: false })), false);
  assert.equal(windowAudible(fakeWindow({ visibility: 'hidden', focused: false })), false);
  // Active.
  assert.equal(windowAudible(fakeWindow({ visibility: 'visible', focused: true })), true);
});

// ---------------------------------------------------------------------------
// 3. NO THUNDERING RESUME
// ---------------------------------------------------------------------------

test('regaining focus after a long silence replays no backlog and stays rate-bounded', () => {
  const { petAudio, clock, played } = loadAudioEngine();

  petAudio.setEnabled(true);
  let audible = false;
  petAudio.setAudibleGate(() => audible);
  petAudio.scheduleAmbient(() => 'idle');

  // Half an hour inaudible: ~20-40 cadence ticks come due and are skipped.
  clock.advance(30 * 60_000);
  assert.deepEqual(played, [], 'nothing may accumulate while inaudible');
  assert.ok(clock.pending() <= 1, 'only one ambient timer may ever be armed');

  // The instant audibility returns, at most the single already-due tick may
  // fire. A queue-and-replay implementation would dump ~20-40 here.
  audible = true;
  clock.advance(1);
  assert.ok(played.length <= 1, `backlog replayed on resume: ${played.length} sounds at once`);

  // And the cadence stays bounded afterwards: at 45 s minimum spacing, ten
  // audible minutes can hold at most 14 sounds.
  played.length = 0;
  clock.advance(10 * 60_000);
  assert.ok(played.length <= 14, `cadence ran hot after resume: ${played.length} sounds in 10 min`);
  assert.ok(played.length >= 1, 'sound must actually resume once audible again');
  assert.ok(clock.pending() <= 1, 'exactly one ambient timer may remain armed');
});

// ---------------------------------------------------------------------------
// 4. IDEMPOTENT ACROSS REPEATED CYCLES
// ---------------------------------------------------------------------------

test('repeated hide/show cycles never stack ambient timers', () => {
  const { petAudio, clock } = loadAudioEngine();

  petAudio.setEnabled(true);
  let audible = true;
  petAudio.setAudibleGate(() => audible);

  for (let i = 0; i < 12; i++) {
    audible = false;
    petAudio.stopAmbient();
    petAudio.silenceNow();
    clock.advance(1_000);
    audible = true;
    petAudio.scheduleAmbient(() => 'idle');
    clock.advance(1_000);
    assert.ok(clock.pending() <= 1, `cycle ${i}: ${clock.pending()} timers armed, expected <= 1`);
  }
});

// ---------------------------------------------------------------------------
// 5. NO STUCK AUDIO — live nodes stopped and released, not merely muted
// ---------------------------------------------------------------------------

test('silenceNow stops and releases every live voice node', () => {
  const { petAudio } = loadAudioEngine();

  const stopped = [];
  const ramps = [];
  const makeParam = () => ({
    value: 1,
    cancelScheduledValues: () => {},
    setValueAtTime: () => {},
    linearRampToValueAtTime: (v) => ramps.push(v)
  });
  const fakeVoice = {
    gainNode: { gain: makeParam(), disconnect: () => {} },
    nodes: [
      { stop: () => stopped.push('osc-a') },
      { stop: () => stopped.push('osc-b') }
    ]
  };

  // Minimal context surface stealVoices needs.
  petAudio.ctx = { currentTime: 0 };
  petAudio.activeVoices = [fakeVoice];

  assert.equal(typeof petAudio.silenceNow, 'function', 'petAudio must expose silenceNow');
  petAudio.silenceNow();

  assert.deepEqual(stopped, ['osc-a', 'osc-b'], 'every scheduled source must be stopped');
  assert.equal(petAudio.activeVoices.length, 0, 'voice list must be released, not left holding nodes');
  assert.ok(ramps.length > 0, 'gain must be ramped down so the stop is pop-free');
});

test('going silent does not suspend the AudioContext (avoids a frozen clock + replay backlog)', () => {
  const source = read('src/renderer/pet/audioEngine.ts');
  assert.doesNotMatch(
    source,
    /\.suspend\(\)/,
    'suspend() freezes currentTime; every play* schedules against it, so resume would replay a backlog'
  );
});

// ---------------------------------------------------------------------------
// 6. FAILURE-SAFE
// ---------------------------------------------------------------------------

test('a throwing audibility gate stays silent for that tick and never escapes', () => {
  const { petAudio, clock, played } = loadAudioEngine();

  petAudio.setEnabled(true);
  let mode = 'throw';
  petAudio.setAudibleGate(() => {
    if (mode === 'throw') throw new Error('gate exploded');
    return true;
  });

  assert.doesNotThrow(() => {
    petAudio.scheduleAmbient(() => 'idle');
    clock.advance(10 * 60_000);
  }, 'a broken gate must never throw out of the scheduler');
  assert.deepEqual(played, [], 'a broken gate defaults to silence');

  // ...and must not be a permanent kill switch once the gate recovers.
  mode = 'ok';
  clock.advance(90_000);
  assert.ok(played.length >= 1, 'sound must resume once the gate recovers');
});

test('the audibility gate is enforced at the single voice-creation choke point', () => {
  // Statically asserted: createVoice() cannot be executed here without a real
  // AudioContext, but it is the one place every play* method funnels through,
  // so the gate belongs there as well as in the ambient tick.
  const source = read('src/renderer/pet/audioEngine.ts');
  const createVoice = source.slice(source.indexOf('private createVoice('));
  const body = createVoice.slice(0, createVoice.indexOf('\n  }'));
  assert.match(body, /canPlayNow\(\)/, 'createVoice must consult the audibility gate');
});

// ---------------------------------------------------------------------------
// 7. COMPOSES WITH THE EXISTING USER SOUND PREFERENCE
// ---------------------------------------------------------------------------

test('window gating composes with the nv_pet_sound preference instead of overriding it', () => {
  const { petAudio, clock, played } = loadAudioEngine();

  // User has muted the pet; window is fully active.
  petAudio.setEnabled(false);
  petAudio.setAudibleGate(() => true);
  petAudio.scheduleAmbient(() => 'idle');

  clock.advance(10 * 60_000);
  assert.deepEqual(played, [], 'an active window must not override an explicit mute');

  // And the preference alone is enough to bring sound back.
  petAudio.setEnabled(true);
  petAudio.scheduleAmbient(() => 'idle');
  clock.advance(90_000);
  assert.ok(played.length >= 1, 'unmuting while active must restore sound');
});

// ---------------------------------------------------------------------------
// 8. WIRING (static — cannot render the component)
// ---------------------------------------------------------------------------

test('PetWidget wires the window-state gate and hard-silences on attention loss', () => {
  const source = read('src/renderer/pet/PetWidget.tsx');

  assert.match(source, /setAudibleGate\(/, 'PetWidget must install the audibility gate');
  assert.match(source, /windowAudible\(/, 'the gate must be backed by the window-state predicate');
  assert.match(source, /silenceNow\(\)/, 'attention loss must hard-silence live voices');
  assert.match(source, /hasFocus\(\)/, 'gating must consult document.hasFocus(), not visibilityState alone');
});
