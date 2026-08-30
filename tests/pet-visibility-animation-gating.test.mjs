// IDLE-CPU FIX — the pet's animation drivers must STOP while the window
// cannot be seen (hidden to tray / minimised), and must resume exactly where
// they stopped when it can be seen again.
//
// WHY THESE TESTS LOOK LIKE THIS. There is no jsdom and no
// @testing-library/react in node_modules, so the component cannot be
// rendered. What IS testable — and what carries the defect — is the pure
// visibility predicate, the gate transition helper, and the canvas
// renderer's rAF bookkeeping. All three are exercised against injected fakes
// (a fake document, fake drivers, a fake rAF clock), matching the DI style
// the rest of the suite uses (see pet-audio-window-gating.test.mjs).
// Rendering fidelity in the shipped app is NOT verified by these tests.
//
// MEASURED DEFECT being pinned down. The renderer burns ~90-117% of one CPU
// core while the app is completely idle (per-process attribution: renderer
// 36.38 CPU-seconds over 40 s, GPU process 0.39%). The cause is the pet's
// requestAnimationFrame loop, which is started UNCONDITIONALLY the moment
// the hacker character mounts (`renderer.start()` in the canvas-lifecycle
// effect) and is never tied to page visibility; the CSS animation layer
// (~86 infinite animations) is never tied to anything at all. Chromium's own
// hidden-page rAF throttling is the only thing standing between this loop
// and the user's task manager — a heuristic, not a guarantee.
//
// THE PRODUCT DECISION these tests encode: the gate keys on
// document.visibilityState ALONE. A visible-but-UNFOCUSED window keeps
// animating — pixels do not interrupt anyone, and a pet that freezes while
// the user is looking at it (side window, second monitor) reads as a crashed
// app. Focus gates SOUND (windowAudible, pinned by
// pet-audio-window-gating.test.mjs); visibility gates PIXELS.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

/** Fake rAF clock: records armed/cancelled callbacks, fires them on demand. */
function makeRafClock() {
  let seq = 0;
  const armed = new Map(); // id -> callback
  return {
    requestAnimationFrame(cb) {
      const id = ++seq;
      armed.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) {
      armed.delete(id);
    },
    /** Fire the oldest armed callback (real rAF consumes the id on fire). */
    fireOne(timestamp) {
      const next = armed.keys().next();
      if (next.done) return false;
      const id = next.value;
      const cb = armed.get(id);
      armed.delete(id);
      cb(timestamp);
      return true;
    },
    outstanding() {
      return armed.size;
    }
  };
}

/** A canvas + 2D context good enough for PixelHackerRenderer (all no-ops). */
function makeFakeCanvas() {
  const ctx = new Proxy(
    {},
    {
      get: () => () => undefined,
      set: () => true
    }
  );
  return {
    width: 0,
    height: 0,
    getContext: (kind) => (kind === '2d' ? ctx : null)
  };
}

/**
 * Compile + load PetWidget.tsx in a fresh realm with stubbed imports and an
 * injected rAF clock. Effects never run (useEffect is a no-op stub), so only
 * module-level code and explicitly invoked exports execute.
 */
function loadPetModule(raf) {
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
    performance,
    requestAnimationFrame: raf.requestAnimationFrame,
    cancelAnimationFrame: raf.cancelAnimationFrame,
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
// 1. THE PURE PREDICATE — visibility only, never focus
// ---------------------------------------------------------------------------

test('windowAnimatable: every genuinely invisible state stops the drawing', () => {
  const { windowAnimatable } = loadPetModule(makeRafClock());
  assert.equal(typeof windowAnimatable, 'function', 'PetWidget must export windowAnimatable');

  assert.equal(windowAnimatable({ visibilityState: 'visible' }), true, 'visible window animates');
  assert.equal(windowAnimatable({ visibilityState: 'hidden' }), false, 'hidden-to-tray / minimised stops');
  assert.equal(windowAnimatable({ visibilityState: 'prerender' }), false, 'prerender stops');
});

test('windowAnimatable degrades OPEN (never freezes a pet that might be watched)', () => {
  const { windowAnimatable } = loadPetModule(makeRafClock());
  assert.equal(
    windowAnimatable({}),
    true,
    'an environment without visibilityState must keep animating — a frozen-but-visible pet reads as a crash'
  );
  assert.equal(
    windowAnimatable(null),
    true,
    'a null document degrades open'
  );
  assert.equal(
    windowAnimatable(undefined),
    true,
    'an undefined document degrades open'
  );
  assert.equal(
    windowAnimatable({ get visibilityState() { throw new Error('getter fail'); } }),
    true,
    'a throwing visibilityState getter degrades open'
  );
});

// ---------------------------------------------------------------------------
// 2. THE GATE TRANSITION — every driver suspended/resumed together
// ---------------------------------------------------------------------------

test('applyPetAnimationGate suspends and resumes the canvas driver as one decision', () => {
  const { applyPetAnimationGate } = loadPetModule(makeRafClock());
  assert.equal(typeof applyPetAnimationGate, 'function', 'PetWidget must export applyPetAnimationGate');

  const calls = [];
  const driver = {
    start: () => calls.push('start'),
    stop: () => calls.push('stop')
  };

  applyPetAnimationGate(false, driver);
  assert.deepEqual(calls, ['stop'], 'hidden => the loop is cancelled, nothing is started');

  calls.length = 0;
  applyPetAnimationGate(true, driver);
  assert.deepEqual(calls, ['start'], 'visible => the loop is re-armed');
});

// ---------------------------------------------------------------------------
// 3. CANVAS RENDERER rAF BOOKKEEPING — idempotent, exactly one frame armed
// ---------------------------------------------------------------------------

test('PixelHackerRenderer.start/destroy are idempotent and arm at most one frame', () => {
  const raf = makeRafClock();
  const { PixelHackerRenderer } = loadPetModule(raf);
  assert.equal(typeof PixelHackerRenderer?.create, 'function', 'PetWidget must export PixelHackerRenderer');

  const renderer = PixelHackerRenderer.create(makeFakeCanvas());
  assert.ok(renderer, 'a 2D-capable canvas must yield a renderer');

  renderer.start();
  renderer.start();
  renderer.start();
  assert.equal(raf.outstanding(), 1, 'repeated start() must never stack armed frames');

  renderer.destroy();
  renderer.destroy();
  assert.equal(raf.outstanding(), 0, 'repeated destroy() must be a safe no-op after the first');
});

test('the loop re-arms exactly one frame per fired frame (no self-multiplying)', () => {
  const raf = makeRafClock();
  const { PixelHackerRenderer } = loadPetModule(raf);
  const renderer = PixelHackerRenderer.create(makeFakeCanvas());

  renderer.start();
  for (let i = 0; i < 120; i++) {
    assert.equal(raf.outstanding(), 1, `frame ${i}: exactly one callback may be armed`);
    raf.fireOne(1000 + i * 16.7);
  }
  assert.equal(raf.outstanding(), 1, 'a running loop holds exactly one armed frame');

  renderer.destroy();
  assert.equal(raf.outstanding(), 0, 'destroy leaves nothing armed');
});

// ---------------------------------------------------------------------------
// 4. CLEAN RESUME OVER MANY CYCLES — no burst, no double-start, no zombie
// ---------------------------------------------------------------------------

test('500 hide/show transitions never stack, never burst, never leave a zombie loop', () => {
  const raf = makeRafClock();
  const { PixelHackerRenderer, applyPetAnimationGate } = loadPetModule(raf);
  const renderer = PixelHackerRenderer.create(makeFakeCanvas());
  const driver = { start: () => renderer.start(), stop: () => renderer.destroy() };

  // Deterministic LCG so the sequence is reproducible.
  let seed = 0x2f6e2b1;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  let timestamp = 1_000;
  let visible = true;
  applyPetAnimationGate(true, driver); // mount, visible
  assert.equal(raf.outstanding(), 1, 'mounted visible: one frame armed');

  for (let i = 0; i < 500; i++) {
    const next = random() < 0.5;
    applyPetAnimationGate(next, driver); // includes same-state repeats (defensive calls)
    visible = next;
    if (visible) {
      assert.equal(raf.outstanding(), 1, `transition ${i}: visible must hold exactly one armed frame`);
      if (random() < 0.5) {
        raf.fireOne(timestamp);
        timestamp += 16.7;
        assert.equal(raf.outstanding(), 1, `transition ${i}: firing re-arms exactly one`);
      }
    } else {
      assert.equal(raf.outstanding(), 0, `transition ${i}: hidden must hold ZERO armed frames`);
    }
  }

  // A long hidden soak, then one resume: exactly one frame is armed. A
  // queue-and-replay implementation would show a backlog here.
  applyPetAnimationGate(false, driver);
  for (let i = 0; i < 50; i++) assert.equal(raf.fireOne(timestamp), false, 'hidden: nothing may fire');
  applyPetAnimationGate(true, driver);
  assert.equal(raf.outstanding(), 1, 'resume arms exactly one frame — no queued-frame burst');
  raf.fireOne(timestamp + 16.7);
  assert.equal(raf.outstanding(), 1, 'the resumed loop re-arms exactly one frame');

  applyPetAnimationGate(false, driver);
  assert.equal(raf.outstanding(), 0, 'final hide leaves nothing armed');
});

// ---------------------------------------------------------------------------
// 5. NO VISUAL JUMP ON RESUME — structural guarantees
// ---------------------------------------------------------------------------

test('resume cannot fast-forward: start() re-anchors the clock and the dt clamp survives', () => {
  const source = read('src/renderer/pet/PetWidget.tsx');

  // start() must reset lastTime, so the first resumed frame steps ~0s rather
  // than the full hidden duration.
  const startBody = source.slice(source.indexOf('start(): void {'), source.indexOf('destroy(): void {'));
  assert.match(startBody, /this\.lastTime = performance\.now\(\)/, 'start() must re-anchor lastTime');

  // The per-frame dt clamp caps any residual gap at 100 ms of simulation time,
  // so even a stale first timestamp cannot teleport the animation.
  assert.match(
    source,
    /Math\.min\(\(timestamp - this\.lastTime\) \/ 1000, 0\.1\)/,
    'the dt clamp (max 0.1s per frame) must survive'
  );

  // destroy() must cancel WITHOUT resetting simulation state — resuming
  // continues the same scene instead of restarting it.
  const destroyBody = source.slice(source.indexOf('destroy(): void {'), source.indexOf('setMode(mode: string)'));
  assert.match(destroyBody, /cancelAnimationFrame\(this\.rafId\)/, 'destroy() must cancel the armed frame');
  assert.doesNotMatch(destroyBody, /initConfetti|matrixColumns = \[\]/, 'destroy() must not reset animation state');
});

// ---------------------------------------------------------------------------
// 6. WIRING (static — cannot render the component)
// ---------------------------------------------------------------------------

test('the visibility gate is wired to visibilitychange with a matched teardown', () => {
  const source = read('src/renderer/pet/PetWidget.tsx');

  const adds = source.match(/document\.addEventListener\('visibilitychange'/g) ?? [];
  const removes = source.match(/document\.removeEventListener\('visibilitychange'/g) ?? [];
  assert.equal(adds.length, 1, 'exactly one visibilitychange listener may be attached by PetWidget');
  assert.equal(removes.length, 1, 'the listener must be removed on effect cleanup (no stacking across cycles)');

  assert.match(source, /windowAnimatable\(document\)/, 'the gate must consult the exported predicate');
  assert.match(source, /applyPetAnimationGate\(/, 'the gate must drive the single transition helper');
});

test('the canvas loop has no unconditional start() left — the gate owns every start', () => {
  const source = read('src/renderer/pet/PetWidget.tsx');

  assert.doesNotMatch(
    source,
    /\brenderer\.start\(\)/,
    'the canvas-lifecycle effect must not start the loop itself — a page loaded hidden would spin up drawing'
  );
  assert.match(source, /hackerRendererRef\.current\?\.start\(\)/, 'resume path must go through the renderer ref');
  assert.match(source, /hackerRendererRef\.current\?\.destroy\(\)/, 'suspend path must go through the renderer ref');
});

test('the CSS layer is paused via a phase-preserving class on the widget root', () => {
  const source = read('src/renderer/pet/PetWidget.tsx');
  const css = read('src/renderer/pet/pet.css');

  // React owns the class (never a manual classList hack another render could wipe).
  assert.match(source, /nv-pet-paused/, 'the widget root must carry the paused class');
  assert.match(
    source,
    /\$\{pageAnimatable \? '' : ' nv-pet-paused'\}/,
    'the paused class must be driven by the pageAnimatable state'
  );

  // The rule must pause (phase-preserving), not remove (phase-resetting),
  // and must be written at (0,4,0) to override the (0,3,0) !important
  // activity shorthands that reset animation-play-state to running.
  assert.match(
    css,
    /\.nv-pet-wrap\.nv-pet-paused\.nv-pet-paused\.nv-pet-paused/,
    'the pause rule needs (0,4,0) specificity to beat the !important activity shorthands'
  );
  assert.match(
    css,
    /animation-play-state:\s*paused\s*!important/,
    'animations must be PAUSED (phase preserved), not removed (phase reset => visible jump on resume)'
  );
});

// ---------------------------------------------------------------------------
// 7. INVARIANT — the audio gate is a sibling, untouched and first
// ---------------------------------------------------------------------------

test('the audio audibility gate is unchanged and still installs before any sound', () => {
  const source = read('src/renderer/pet/PetWidget.tsx');

  assert.match(
    source,
    /petAudio\.setAudibleGate\(\(\) => windowAudible\(window\)\)/,
    'the windowAudible gate must stay exactly as pinned by pet-audio-window-gating.test.mjs'
  );
  const gateAt = source.indexOf('petAudio.setAudibleGate(() => windowAudible(window))');
  const enableAt = source.indexOf('petAudio.setEnabled(soundRef.current)');
  assert.ok(gateAt > 0 && enableAt > 0, 'both audio wiring statements must exist');
  assert.ok(gateAt < enableAt, 'the audibility gate must install BEFORE audio is enabled');

  // The animation gate must not entangle itself with the audio gate: it
  // answers a different question (pixels vs sound) and must not call into
  // the audio engine at all.
  const visibilityEffect = source.slice(
    source.indexOf("document.addEventListener('visibilitychange'"),
    source.indexOf("document.removeEventListener('visibilitychange'")
  );
  assert.doesNotMatch(visibilityEffect, /petAudio/, 'the animation gate must never touch the audio engine');
});
