// audioEngine.ts: stolen voices must RELEASE their gain node, not merely fade it.
//
// THE DEFECT. stealVoices() ramps each live voice to silence and then clears
// activeVoices. The deferred cleanup createVoice() scheduled for that voice
// later finds index -1 in the now-empty array and skips — so nothing ever calls
// disconnect() on the stolen voice's gainNode. Every steal therefore leaves a
// dead gain node wired to masterBus for the lifetime of the app, and rapid
// re-triggers (the exact case stealVoices exists for) accumulate them.
//
// The engine is compiled and run in a VM with an injected timer queue and an
// injected context, matching tests/pet-audio-window-gating.test.mjs: no real
// audio hardware is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function loadAudioEngine() {
  const compiled = typescript.transpileModule(read('src/renderer/pet/audioEngine.ts'), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020
    }
  });
  const timers = [];
  const moduleObj = { exports: {} };
  const context = {
    console,
    exports: moduleObj.exports,
    module: moduleObj,
    setTimeout: (fn, delay) => {
      timers.push({ fn, delay });
      return timers.length;
    },
    clearTimeout: () => {}
    // AudioContext intentionally absent: init() must no-op.
  };
  vm.runInNewContext(compiled.outputText, context, {
    filename: 'src/renderer/pet/audioEngine.ts'
  });

  const petAudio = moduleObj.exports.petAudio;
  assert.ok(petAudio, 'audioEngine must export petAudio');
  return { petAudio, timers };
}

function fakeVoice({ disconnects, ramps, label }) {
  return {
    gainNode: {
      gain: {
        value: 1,
        cancelScheduledValues: () => {},
        setValueAtTime: () => {},
        linearRampToValueAtTime: (value) => ramps.push(value)
      },
      disconnect: () => disconnects.push(label)
    },
    nodes: [{ stop: () => {} }]
  };
}

test('a stolen voice disconnects its gain node after the fade, so repeated steals do not grow the graph', () => {
  const { petAudio, timers } = loadAudioEngine();
  const disconnects = [];
  const ramps = [];
  petAudio.ctx = { currentTime: 0 };
  petAudio.activeVoices = [
    fakeVoice({ disconnects, ramps, label: 'first' }),
    fakeVoice({ disconnects, ramps, label: 'second' })
  ];

  petAudio.stealVoices(4);

  assert.equal(petAudio.activeVoices.length, 0, 'stolen voices leave the active list');
  assert.ok(ramps.length > 0, 'the fade must still be applied (no audible change)');
  assert.deepEqual(disconnects, [], 'the fade must complete before the node is disconnected');
  assert.ok(timers.length >= 2, `each stolen voice must schedule a deferred release, got ${timers.length}`);
  for (const timer of timers) {
    assert.ok(timer.delay >= 8, `the release must wait for the fade+stop window, got ${timer.delay}ms`);
    timer.fn();
  }
  assert.deepEqual([...disconnects].sort(), ['first', 'second'], 'every stolen gain node must be disconnected');
});

test('the deferred release is guarded: an already-disconnected node must not throw', () => {
  const { petAudio, timers } = loadAudioEngine();
  const ramps = [];
  const voice = fakeVoice({ disconnects: [], ramps, label: 'unused' });
  voice.gainNode.disconnect = () => {
    throw new Error('InvalidAccessError: the node is already disconnected');
  };
  petAudio.ctx = { currentTime: 0 };
  petAudio.activeVoices = [voice];

  assert.doesNotThrow(() => petAudio.stealVoices(4));
  assert.ok(timers.length >= 1, 'a deferred release must be scheduled');
  for (const timer of timers) {
    assert.doesNotThrow(() => timer.fn(), 'the deferred release must swallow an already-disconnected node');
  }
  assert.equal(petAudio.activeVoices.length, 0, 'the voice list must still be released');
});
