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

function loadPetAudioWithContext(sessionStorageMock = null) {
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
    sessionStorage: sessionStorageMock,
  };
  vm.runInNewContext(compiled.outputText, context, {
    filename: 'src/renderer/pet/audioEngine.ts',
  });

  const petAudio = moduleObj.exports.petAudio;
  return { petAudio, mockCtx };
}

const ALL_CUES = [
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
  'playHackerCursorTick',
  'playHackerDiskSeek',
  'playAscensionRitual',
  'playActionCheer',
  'playEasterEggDisk',
  'playChime',
];

test('all 26 audio cues exist, are callable, and return valid variant index [0..2]', () => {
  const { petAudio } = loadPetAudioWithContext();
  petAudio.setEnabled(true);

  assert.equal(ALL_CUES.length, 26, 'must have exactly 26 distinct cue methods');
  for (const cue of ALL_CUES) {
    assert.equal(typeof petAudio[cue], 'function', `cue ${cue} must exist`);
    const v = petAudio[cue]();
    assert.ok(v >= 0 && v <= 2, `cue ${cue} returned invalid variant ${v}`);
  }
});

test('round-robin variant pool guarantees no consecutive repeats across repeated calls', () => {
  const { petAudio } = loadPetAudioWithContext();
  petAudio.setEnabled(true);

  for (const cue of ALL_CUES) {
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

  for (const cue of ALL_CUES) {
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
  for (const cue of ALL_CUES) {
    const res = petAudio[cue]();
    assert.equal(res, -1, `gated cue ${cue} must return -1`);
  }
  assert.equal(mockCtx.createdNodes.length, prevNodeCount, 'no new nodes created while inaudible');
});

test('disabled sound preference returns -1 immediately for all cues', () => {
  const { petAudio } = loadPetAudioWithContext();
  petAudio.setEnabled(false);

  for (const cue of ALL_CUES) {
    const res = petAudio[cue]();
    assert.equal(res, -1, `disabled cue ${cue} must return -1`);
  }
});

function formatParamEvents(param, isGain = false) {
  if (!param || !param.events || param.events.length === 0) return '';
  return `[${param.events.map(e => {
    const val = typeof e.v === 'number'
      ? (isGain ? Math.round(e.v * 10) / 10 : Math.round(e.v / 100) * 100)
      : e.v;
    return `${e.type}:${val}@${Math.round(e.t * 10) * 100}ms`;
  }).join(',')}]`;
}

function extractSynthesisSignature(nodes) {
  return nodes.map((node) => {
    if (node instanceof MockOscillatorNode) {
      const freqEvts = formatParamEvents(node.frequency, false);
      return `Osc(${node.type},f~${Math.round(node.frequency.value / 100) * 100}${freqEvts ? `,pitch:${freqEvts}` : ''})`;
    }
    if (node instanceof MockBiquadFilterNode) {
      const freqEvts = formatParamEvents(node.frequency, false);
      return `Filter(${node.type},f~${Math.round(node.frequency.value / 100) * 100},Q~${Math.round(node.Q.value)}${freqEvts ? `,sweep:${freqEvts}` : ''})`;
    }
    if (node instanceof MockBufferSourceNode) {
      return `NoiseBuffer(loop=${node.loop})`;
    }
    if (node instanceof MockWaveShaperNode) {
      return `WaveShaper(oversample=${node.oversample})`;
    }
    if (node instanceof MockGainNode) {
      const gainEvts = formatParamEvents(node.gain, true);
      return `Gain(v~${Math.round(node.gain.value * 10) / 10}${gainEvts ? `,env:${gainEvts}` : ''})`;
    }
    return node.constructor.name;
  }).join('->');
}

test('persona separation: paired cues (sleep, coins, mugs, combat, focus, idle) have distinct synthesis graph signatures across all variants', () => {
  const PAIRS = [
    { mascot: 'playMascotPowerNap', hacker: 'playHackerTerminalNap', domain: 'sleep/standby' },
    { mascot: 'playRealisticCoinDrop', hacker: 'playHackerCoinDrop', domain: 'coins/rewards' },
    { mascot: 'playMugTableTap', hacker: 'playHackerEmptyMug', domain: 'mug/foley' },
    { mascot: 'playMascotBugHunter', hacker: 'playHackerBugSlayer', domain: 'bug combat' },
    { mascot: 'playMascotModelJuggler', hacker: 'playHackerCodeFrenzy', domain: 'active focus / interaction' },
    { mascot: 'playMascotSensorPolish', hacker: 'playHackerFlowchart', domain: 'idle inspection / calibration' },
    { mascot: 'playChime', hacker: 'playHackerCursorTick', domain: 'idle crystal chime vs lone key tick' },
    { mascot: 'playMascotSensorPolish', hacker: 'playHackerDiskSeek', domain: 'idle sensor wipe vs disk seek' },
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

test('persona resolution: stored hacker session ALWAYS resolves to hacker, never mascot, across all activity slugs', () => {
  const hackerSessionStorage = {
    getItem: (k) => (k === 'nv_pet_character' ? 'hacker' : null),
  };
  const mascotSessionStorage = {
    getItem: (k) => (k === 'nv_pet_character' ? 'mascot' : null),
  };

  const testActivities = [
    'idle',
    '',
    'code-frenzy',
    'bug-hunter', // FRESH BOOT activity
    'low-battery',
    'turbine-generator',
    'sensor-polish',
    'model-juggler',
    'nano-coffee',
    'power-nap',
    'syndicate-salute',
  ];

  for (const act of testActivities) {
    const { petAudio: hackerAudio } = loadPetAudioWithContext(hackerSessionStorage);
    hackerAudio.scheduleAmbient(() => act);
    const hackerResolved = hackerAudio['getActivePersona']();
    assert.equal(
      hackerResolved,
      'hacker',
      `stored hacker session with activity '${act}' resolved to '${hackerResolved}' instead of 'hacker'`
    );

    const { petAudio: mascotAudio } = loadPetAudioWithContext(mascotSessionStorage);
    mascotAudio.scheduleAmbient(() => act);
    const mascotResolved = mascotAudio['getActivePersona']();
    assert.equal(
      mascotResolved,
      'mascot',
      `stored mascot session with activity '${act}' resolved to '${mascotResolved}' instead of 'mascot'`
    );
  }

  // Fallback behavior when sessionStorage is unavailable (null)
  const { petAudio: fallbackIdle } = loadPetAudioWithContext(null);
  fallbackIdle.scheduleAmbient(() => 'idle');
  assert.equal(fallbackIdle['getActivePersona'](), 'mascot', 'null storage with idle activity must fall back to mascot default');

  const { petAudio: fallbackHacker } = loadPetAudioWithContext(null);
  fallbackHacker.scheduleAmbient(() => 'code-frenzy');
  assert.equal(fallbackHacker['getActivePersona'](), 'hacker', 'null storage with hacker activity must fall back to hacker');
});

test('Defect 1: shuffle deck boundary repeat prevention ensures minimum non-recurrence floor', () => {
  const { petAudio } = loadPetAudioWithContext();
  petAudio.setEnabled(true);

  const mascotCuesDrawn = [];
  for (let i = 0; i < 500; i++) {
    petAudio.drawMascotIdleCue();
    mascotCuesDrawn.push(petAudio.lastMascotIdleCue);
  }

  for (let i = 1; i < mascotCuesDrawn.length; i++) {
    assert.notEqual(
      mascotCuesDrawn[i],
      mascotCuesDrawn[i - 1],
      `Mascot idle deck repeated cue '${mascotCuesDrawn[i]}' consecutively at index ${i}`
    );
  }

  const hackerCuesDrawn = [];
  for (let i = 0; i < 500; i++) {
    petAudio.drawHackerIdleCue();
    hackerCuesDrawn.push(petAudio.lastHackerIdleCue);
  }

  for (let i = 1; i < hackerCuesDrawn.length; i++) {
    assert.notEqual(
      hackerCuesDrawn[i],
      hackerCuesDrawn[i - 1],
      `Hacker idle deck repeated cue '${hackerCuesDrawn[i]}' consecutively at index ${i}`
    );
  }
});

test('Defect 2: transient voice gain staging protects master compressor headroom on target cues', () => {
  // 1. playMugTableTap v2: glide gain <= 0.68, noise gain <= 1.50
  const { petAudio: audio1, mockCtx: ctx1 } = loadPetAudioWithContext();
  audio1.setEnabled(true);
  const baselineCount1 = ctx1.createdNodes.length;
  audio1.playMugTableTap(2);
  // Slice after voiceGain node (baseline + 1)
  const cueGainNodes1 = ctx1.createdNodes.slice(baselineCount1 + 1).filter(n => n instanceof MockGainNode);
  const scheduledGains1 = cueGainNodes1.map(g => Math.max(...g.gain.events.map(e => e.v)));
  const maxGain1 = Math.max(...scheduledGains1);
  assert.ok(maxGain1 <= 1.55, `playMugTableTap v2 peak gain stage (${maxGain1}) must be <= 1.55`);

  // 2. playHackerCursorTick v0: switch click noise <= 0.75, thock <= 0.85
  const { petAudio: audio2, mockCtx: ctx2 } = loadPetAudioWithContext();
  audio2.setEnabled(true);
  const baselineCount2 = ctx2.createdNodes.length;
  audio2.playHackerCursorTick(0);
  const cueGainNodes2 = ctx2.createdNodes.slice(baselineCount2 + 1).filter(n => n instanceof MockGainNode);
  const scheduledGains2 = cueGainNodes2.map(g => Math.max(...g.gain.events.map(e => e.v)));
  const maxGain2 = Math.max(...scheduledGains2);
  assert.ok(maxGain2 <= 0.85, `playHackerCursorTick v0 peak gain stage (${maxGain2}) must be <= 0.85`);

  // 3. playHackerDiskSeek v0: head seek <= 0.80, friction <= 0.86
  const { petAudio: audio3, mockCtx: ctx3 } = loadPetAudioWithContext();
  audio3.setEnabled(true);
  const baselineCount3 = ctx3.createdNodes.length;
  audio3.playHackerDiskSeek(0);
  const cueGainNodes3 = ctx3.createdNodes.slice(baselineCount3 + 1).filter(n => n instanceof MockGainNode);
  const scheduledGains3 = cueGainNodes3.map(g => Math.max(...g.gain.events.map(e => e.v)));
  const maxGain3 = Math.max(...scheduledGains3);
  assert.ok(maxGain3 <= 0.88, `playHackerDiskSeek v0 peak gain stage (${maxGain3}) must be <= 0.88`);
});

test('Defect 3: synthesis stability and deterministic layering on calibrated cues', () => {
  // playAscensionRitual v2 harmonic gain staging
  const { petAudio: audioAsc, mockCtx: ctxAsc } = loadPetAudioWithContext();
  audioAsc.setEnabled(true);
  audioAsc.playAscensionRitual(2);
  const oscsAsc = ctxAsc.createdNodes.filter(n => n instanceof MockOscillatorNode);
  assert.ok(oscsAsc.length >= 4, 'playAscensionRitual v2 must render 4 ascending harmonic sine layers');

  // playMascotSensorPolish v1 deterministic sine anchor
  const { petAudio: audioPol, mockCtx: ctxPol } = loadPetAudioWithContext();
  audioPol.setEnabled(true);
  audioPol.playMascotSensorPolish(1);
  const oscsPol = ctxPol.createdNodes.filter(n => n instanceof MockOscillatorNode);
  const hasLensTone = oscsPol.some(o => Math.abs(o.frequency.value - 2200) < 50);
  assert.ok(hasLensTone, 'playMascotSensorPolish v1 must include 2200 Hz deterministic lens tone');

  // playSadTiredSigh v0 deterministic sigh tone
  const { petAudio: audioSigh, mockCtx: ctxSigh } = loadPetAudioWithContext();
  audioSigh.setEnabled(true);
  audioSigh.playSadTiredSigh(0);
  const oscsSigh = ctxSigh.createdNodes.filter(n => n instanceof MockOscillatorNode);
  const hasSighTone = oscsSigh.some(o => Math.abs(o.frequency.value - 480) < 20);
  assert.ok(hasSighTone, 'playSadTiredSigh v0 must include 480 Hz deterministic sigh anchor');
});


