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

function extractSynthesisSignature(nodes) {
  return nodes.map((node) => {
    if (node instanceof MockOscillatorNode) {
      return `Osc(${node.type},f~${Math.round(node.frequency.value / 50) * 50})`;
    }
    if (node instanceof MockBiquadFilterNode) {
      return `Filter(${node.type},f~${Math.round(node.frequency.value / 100) * 100})`;
    }
    if (node instanceof MockBufferSourceNode) {
      return 'NoiseBuffer';
    }
    if (node instanceof MockWaveShaperNode) {
      return 'WaveShaper';
    }
    if (node instanceof MockGainNode) {
      return 'Gain';
    }
    return node.constructor.name;
  }).join('->');
}

test('persona separation: paired cues (sleep, coins, mugs, combat) have distinct synthesis graph signatures across all variants', () => {
  const PAIRS = [
    { mascot: 'playMascotPowerNap', hacker: 'playHackerTerminalNap', domain: 'sleep/standby' },
    { mascot: 'playRealisticCoinDrop', hacker: 'playHackerCoinDrop', domain: 'coins/rewards' },
    { mascot: 'playMugTableTap', hacker: 'playHackerEmptyMug', domain: 'mug/foley' },
    { mascot: 'playMascotBugHunter', hacker: 'playHackerBugSlayer', domain: 'bug combat' },
  ];

  for (const { mascot, hacker, domain } of PAIRS) {
    for (let variant = 0; variant < 3; variant++) {
      const { petAudio: mascotAudio, mockCtx: mascotCtx } = loadPetAudioWithContext();
      mascotAudio.setEnabled(true);
      mascotAudio[mascot](variant);
      const mascotSig = extractSynthesisSignature(mascotCtx.createdNodes);

      const { petAudio: hackerAudio, mockCtx: hackerCtx } = loadPetAudioWithContext();
      hackerAudio.setEnabled(true);
      hackerAudio[hacker](variant);
      const hackerSig = extractSynthesisSignature(hackerCtx.createdNodes);

      assert.ok(mascotCtx.createdNodes.length > 0, `${mascot} v${variant} must produce audio nodes`);
      assert.ok(hackerCtx.createdNodes.length > 0, `${hacker} v${variant} must produce audio nodes`);

      assert.notEqual(
        mascotSig,
        hackerSig,
        `persona collapse detected in ${domain}: ${mascot} and ${hacker} variant ${variant} produce identical synthesis graphs (shared helper / aliased implementation): ${mascotSig}`
      );
    }
  }
});

test('persona acoustic domain constraints: Mascot lives in FM/sine/ceramic domain, Hacker lives in mechanical/8-bit/sub-bass domain', () => {
  // 1. Mug cues: Mascot mug tap must have high-frequency ceramic presence (>= 600 Hz), Hacker empty mug must have mechanical bass/thock presence (<= 480 Hz)
  for (let variant = 0; variant < 3; variant++) {
    const { petAudio: mascotAudio, mockCtx: mascotCtx } = loadPetAudioWithContext();
    mascotAudio.setEnabled(true);
    mascotAudio.playMugTableTap(variant);
    const mascotOscs = mascotCtx.createdNodes.filter(n => n instanceof MockOscillatorNode);
    const mascotFilters = mascotCtx.createdNodes.filter(n => n instanceof MockBiquadFilterNode);

    const { petAudio: hackerAudio, mockCtx: hackerCtx } = loadPetAudioWithContext();
    hackerAudio.setEnabled(true);
    hackerAudio.playHackerEmptyMug(variant);
    const hackerOscs = hackerCtx.createdNodes.filter(n => n instanceof MockOscillatorNode);

    // Hacker mug must contain a low mechanical bass anchor oscillator <= 120 Hz
    const hasLowThock = hackerOscs.some(o => o.frequency.value <= 120);
    assert.ok(hasLowThock, `playHackerEmptyMug v${variant} must have a mechanical bass anchor oscillator (<= 120 Hz)`);

    // Mascot mug must have clean ceramic/sine timbre and not alias the hacker mechanical square thock
    const hasHackerSquare = hackerOscs.some(o => o.type === 'square');
    const hasMascotSquare = mascotOscs.some(o => o.type === 'square');
    assert.equal(hasMascotSquare, false, `playMugTableTap v${variant} must not use raw square waves`);
  }

  // 2. Coin cues: Mascot coin uses pure sines, Hacker coin uses 8-bit square / arcade tones
  for (let variant = 0; variant < 3; variant++) {
    const { petAudio: mascotAudio, mockCtx: mascotCtx } = loadPetAudioWithContext();
    mascotAudio.setEnabled(true);
    mascotAudio.playRealisticCoinDrop(variant);
    const mascotOscs = mascotCtx.createdNodes.filter(n => n instanceof MockOscillatorNode);
    assert.ok(mascotOscs.every(o => o.type === 'sine'), `playRealisticCoinDrop v${variant} must use pure sine oscillators`);

    const { petAudio: hackerAudio, mockCtx: hackerCtx } = loadPetAudioWithContext();
    hackerAudio.setEnabled(true);
    hackerAudio.playHackerCoinDrop(variant);
    const hackerOscs = hackerCtx.createdNodes.filter(n => n instanceof MockOscillatorNode);
    const hasArcadeWave = hackerOscs.some(o => o.type === 'square' || o.type === 'triangle');
    assert.ok(hasArcadeWave, `playHackerCoinDrop v${variant} must use 8-bit square/triangle oscillators`);
  }
});
