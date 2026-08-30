/**
 * Tests for pet audio engine identity, cue routing, variant round-robin,
 * persona separation, and audibility gate integrity across all 24 sound methods.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

class MockAudioParam {
  constructor(val = 0) {
    this.value = val;
    this.events = [];
  }
  setValueAtTime(v, t) { this.events.push({ type: 'set', v, t }); this.value = v; }
  linearRampToValueAtTime(v, t) { this.events.push({ type: 'linear', v, t }); this.value = v; }
  exponentialRampToValueAtTime(v, t) { this.events.push({ type: 'exp', v, t }); this.value = v; }
  cancelScheduledValues(t) { this.events = this.events.filter(e => e.t < t); }
}

class MockAudioNode {
  constructor() {
    this.connections = [];
  }
  connect(dest) {
    this.connections.push(dest);
    return dest;
  }
  disconnect() {
    this.connections = [];
  }
}

class MockGainNode extends MockAudioNode {
  constructor() {
    super();
    this.gain = new MockAudioParam(1.0);
  }
}

class MockOscillatorNode extends MockAudioNode {
  constructor() {
    super();
    this.frequency = new MockAudioParam(440);
    this.type = 'sine';
    this.started = false;
    this.stopped = false;
  }
  start(t) { this.started = true; }
  stop(t) { this.stopped = true; }
}

class MockBiquadFilterNode extends MockAudioNode {
  constructor() {
    super();
    this.frequency = new MockAudioParam(1000);
    this.Q = new MockAudioParam(1.0);
    this.type = 'lowpass';
  }
}

class MockBufferSourceNode extends MockAudioNode {
  constructor() {
    super();
    this.buffer = null;
    this.loop = false;
    this.started = false;
    this.stopped = false;
  }
  start(t) { this.started = true; }
  stop(t) { this.stopped = true; }
}

class MockWaveShaperNode extends MockAudioNode {
  constructor() {
    super();
    this.curve = null;
    this.oversample = 'none';
  }
}

class MockDynamicsCompressorNode extends MockAudioNode {
  constructor() {
    super();
    this.threshold = new MockAudioParam(-2.0);
    this.knee = new MockAudioParam(6.0);
    this.ratio = new MockAudioParam(4.0);
    this.attack = new MockAudioParam(0.003);
    this.release = new MockAudioParam(0.05);
  }
}

class MockAnalyserNode extends MockAudioNode {
  constructor() {
    super();
    this.fftSize = 2048;
    this.smoothingTimeConstant = 0.82;
  }
}

class MockAudioBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = new Float32Array(length);
  }
  getChannelData() { return this.data; }
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0.1;
    this.state = 'running';
    this.sampleRate = 44100;
    this.destination = new MockAudioNode();
    this.createdNodes = [];
  }
  createGain() {
    const n = new MockGainNode();
    this.createdNodes.push(n);
    return n;
  }
  createOscillator() {
    const n = new MockOscillatorNode();
    this.createdNodes.push(n);
    return n;
  }
  createBiquadFilter() {
    const n = new MockBiquadFilterNode();
    this.createdNodes.push(n);
    return n;
  }
  createBufferSource() {
    const n = new MockBufferSourceNode();
    this.createdNodes.push(n);
    return n;
  }
  createWaveShaper() {
    const n = new MockWaveShaperNode();
    this.createdNodes.push(n);
    return n;
  }
  createDynamicsCompressor() {
    const n = new MockDynamicsCompressorNode();
    this.createdNodes.push(n);
    return n;
  }
  createAnalyser() {
    const n = new MockAnalyserNode();
    this.createdNodes.push(n);
    return n;
  }
  createBuffer(c, l, r) { return new MockAudioBuffer(c, l, r); }
  resume() { this.state = 'running'; return Promise.resolve(); }
}

function loadPetAudioWithContext() {
  const compiled = typescript.transpileModule(read('src/renderer/pet/audioEngine.ts'), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
    },
  });
  const moduleObj = { exports: {} };
  const mockCtx = new MockAudioContext();
  const context = {
    console,
    exports: moduleObj.exports,
    module: moduleObj,
    AudioContext: function () { return mockCtx; },
    setTimeout: (fn, ms) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
  };
  vm.runInNewContext(compiled.outputText, context, {
    filename: 'src/renderer/pet/audioEngine.ts',
  });

  const petAudio = moduleObj.exports.petAudio;
  return { petAudio, mockCtx };
}

const ALL_24_CUES = [
  'playOrganicSnoring',
  'playMascotPowerNap',
  'playHackerTerminalNap',
  'playStomachRumbling',
  'playOrganicYawn',
  'playSadTiredSigh',
  'playHackerCodeFrenzy',
  'playMascotModelJuggler',
  'playRealisticCoinDrop',
  'playHackerCoinDrop',
  'playMugTableTap',
  'playHackerEmptyMug',
  'playMascotBugHunter',
  'playHackerBugSlayer',
  'playMascotLowBattery',
  'playMascotTurbine',
  'playMascotSensorPolish',
  'playMascotNanoCoffee',
  'playHackerZeroErrors',
  'playHackerFlowchart',
  'playAscensionRitual',
  'playActionCheer',
  'playEasterEggDisk',
  'playChime',
];

test('all 24 audio cues exist, are callable, and return valid variant index [0..2]', () => {
  const { petAudio } = loadPetAudioWithContext();
  petAudio.setEnabled(true);

  assert.equal(ALL_24_CUES.length, 24, 'must have exactly 24 distinct cue methods');
  for (const cue of ALL_24_CUES) {
    assert.equal(typeof petAudio[cue], 'function', `cue ${cue} must exist`);
    const v = petAudio[cue]();
    assert.ok(v >= 0 && v <= 2, `cue ${cue} returned invalid variant ${v}`);
  }
});

test('round-robin variant pool guarantees no consecutive repeats across repeated calls', () => {
  const { petAudio } = loadPetAudioWithContext();
  petAudio.setEnabled(true);

  for (const cue of ALL_24_CUES) {
    let last = -1;
    for (let i = 0; i < 20; i++) {
      const chosen = petAudio[cue]();
      assert.notEqual(chosen, last, `cue ${cue} repeated variant ${chosen} consecutively on turn ${i}`);
      last = chosen;
    }
  }
});

test('explicit variant index 0, 1, 2 is strictly respected and out-of-bounds values are clamped', () => {
  const { petAudio } = loadPetAudioWithContext();
  petAudio.setEnabled(true);

  for (const cue of ALL_24_CUES) {
    assert.equal(petAudio[cue](0), 0, `${cue}(0) must return 0`);
    assert.equal(petAudio[cue](1), 1, `${cue}(1) must return 1`);
    assert.equal(petAudio[cue](2), 2, `${cue}(2) must return 2`);
    assert.equal(petAudio[cue](5), 2, `${cue}(5) must clamp to 2`);
    assert.equal(petAudio[cue](-3), 0, `${cue}(-3) must clamp to 0`);
  }
});

test('audibility gate rejection returns -1 and creates no active audio voice nodes', () => {
  const { petAudio, mockCtx } = loadPetAudioWithContext();
  petAudio.setEnabled(true);
  petAudio.setAudibleGate(() => false);

  const prevNodeCount = mockCtx.createdNodes.length;
  for (const cue of ALL_24_CUES) {
    const res = petAudio[cue]();
    assert.equal(res, -1, `gated cue ${cue} must return -1`);
  }
  assert.equal(mockCtx.createdNodes.length, prevNodeCount, 'no new nodes created while inaudible');
});

test('disabled sound preference returns -1 immediately for all 24 cues', () => {
  const { petAudio } = loadPetAudioWithContext();
  petAudio.setEnabled(false);

  for (const cue of ALL_24_CUES) {
    const res = petAudio[cue]();
    assert.equal(res, -1, `disabled cue ${cue} must return -1`);
  }
});

test('persona separation: Cyber Mascot and Pixel Hacker produce distinct sleep sound graphs', () => {
  const source = read('src/renderer/pet/audioEngine.ts');
  // Mascot Power Nap and Hacker Terminal Nap must not share identical snore implementation
  assert.match(source, /playMascotPowerNap/, 'must implement playMascotPowerNap');
  assert.match(source, /playHackerTerminalNap/, 'must implement playHackerTerminalNap');
  // Neither can contain biological uvular/throat rasp comments or 38Hz uvular flutter
  assert.doesNotMatch(source, /uvular flutter/i, 'biological uvular flutter must be eliminated');
  assert.doesNotMatch(source, /visceral gurgle/i, 'biological stomach gurgle must be eliminated');
  assert.doesNotMatch(source, /jaw click/i, 'biological jaw click must be eliminated');
  assert.doesNotMatch(source, /throat gulp/i, 'biological throat gulp must be eliminated');
});

test('persona separation: Realistic Coin Drop and Hacker Coin Drop have distinct timbres', () => {
  const { petAudio, mockCtx } = loadPetAudioWithContext();
  petAudio.setEnabled(true);

  // Hacker coin drop uses discrete retro chimes, not high-frequency piercing glass jar sines
  const source = read('src/renderer/pet/audioEngine.ts');
  const hackerCoin = source.slice(source.indexOf('playHackerCoinDrop('));
  const body = hackerCoin.slice(0, hackerCoin.indexOf('\n  }'));
  assert.doesNotMatch(body, /this\.coinDrop\('playHackerCoinDrop'/i, 'playHackerCoinDrop must have its own dedicated hacker implementation');
});
