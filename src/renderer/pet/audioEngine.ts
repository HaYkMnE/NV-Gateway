/**
 * petAudio — procedural pet sound engine (Web Audio API).
 *
 * Ported from SyndicateAudioEngine (interactive-showcase.html):
 * pink/brown/white noise generators, formant bandpass filters, FM chirps,
 * tanh saturation, Euler-style coin decay envelopes, calibrated master gain,
 * peak limiter and 3 ms pop-free voice stealing. Zero external assets/deps.
 *
 * Every play* method takes an optional variant index 0|1|2; when omitted the
 * Shuffle Round-Robin pool picks a variant with NO consecutive repeats.
 * Each method returns the variant that was chosen (-1 if audio is disabled
 * or the AudioContext is unavailable).
 */

type SfxKey =
  | 'playOrganicSnoring'
  | 'playStomachRumbling'
  | 'playOrganicYawn'
  | 'playSadTiredSigh'
  | 'playHackerCodeFrenzy'
  | 'playMascotModelJuggler'
  | 'playRealisticCoinDrop'
  | 'playMugTableTap'
  | 'playMascotBugHunter'
  | 'playHackerBugSlayer'
  | 'playMascotLowBattery'
  | 'playMascotTurbine'
  | 'playMascotSensorPolish'
  | 'playMascotNanoCoffee'
  | 'playMascotPowerNap'
  | 'playHackerZeroErrors'
  | 'playHackerEmptyMug'
  | 'playHackerCoinDrop'
  | 'playHackerFlowchart'
  | 'playHackerTerminalNap'
  | 'playAscensionRitual'
  | 'playActionCheer'
  | 'playEasterEggDisk'
  | 'playChime';

interface ActiveVoice {
  gainNode: GainNode;
  nodes: AudioScheduledSourceNode[];
}

interface VoiceHandle {
  out: GainNode;
  t: number;
  voice: ActiveVoice;
}

interface VoiceOptions {
  duration?: number;
  volume?: number;
  fadeMs?: number;
  stealVoices?: boolean;
}

/** Ambient cadence bounds (ms). */
const AMBIENT_MIN_MS = 45_000;
const AMBIENT_MAX_MS = 90_000;

class PetAudioEngine {
  private ctx: AudioContext | null = null;
  private masterBus: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;

  private pinkNoiseBuffer: AudioBuffer | null = null;
  private brownNoiseBuffer: AudioBuffer | null = null;
  private whiteNoiseBuffer: AudioBuffer | null = null;
  private saturationCurve: Float32Array<ArrayBuffer> | null = null;

  private enabled = false;
  private activeVoices: ActiveVoice[] = [];
  private readonly variantHistory = new Map<SfxKey, number>();

  // Autonomous ambient scheduler state
  private ambientTimer: ReturnType<typeof setTimeout> | null = null;
  private getActivityFn: (() => string) | null = null;

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /** Lazily build the AudioContext + master chain. Safe to call repeatedly. */
  init(): void {
    if (!this.ctx) {
      if (typeof AudioContext === 'undefined') return;
      const ctx = new AudioContext();

      // 1. Voice input bus
      const masterBus = ctx.createGain();
      masterBus.gain.setValueAtTime(1.0, ctx.currentTime);

      // 2. High-frequency smoothing (16 kHz relaxed lowpass)
      const masterFilter = ctx.createBiquadFilter();
      masterFilter.type = 'lowpass';
      masterFilter.frequency.setValueAtTime(16_000, ctx.currentTime);
      masterFilter.Q.setValueAtTime(0.707, ctx.currentTime);

      // 3. Fast peak limiter (prevents clipping on multi-transients)
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.setValueAtTime(-2.0, ctx.currentTime);
      limiter.knee.setValueAtTime(6.0, ctx.currentTime);
      limiter.ratio.setValueAtTime(4.0, ctx.currentTime);
      limiter.attack.setValueAtTime(0.003, ctx.currentTime);
      limiter.release.setValueAtTime(0.05, ctx.currentTime);

      // 4. Calibrated master volume
      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(0.58, ctx.currentTime);

      // 5. Analyser tap
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.82;

      // Graph: bus -> filter -> limiter -> gain -> analyser -> destination
      masterBus.connect(masterFilter);
      masterFilter.connect(limiter);
      limiter.connect(masterGain);
      masterGain.connect(analyser);
      analyser.connect(ctx.destination);

      this.ctx = ctx;
      this.masterBus = masterBus;
      this.masterGain = masterGain;
      this.analyserNode = analyser;

      this.pinkNoiseBuffer = this.makePinkNoiseBuffer();
      this.brownNoiseBuffer = this.makeBrownNoiseBuffer();
      this.whiteNoiseBuffer = this.makeWhiteNoiseBuffer();
      this.saturationCurve = this.makeSaturationCurve();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  /**
   * User-gesture audio unlock. Chromium autoplay policy starts an
   * AudioContext in the `suspended` state until a resume() is issued from
   * inside a real user-gesture handler. Wire this to a one-time (or every)
   * `pointerdown`/`keydown` listener so the pet's sounds actually start.
   * Safe to call repeatedly — no-ops once the context is running.
   */
  unlock(): void {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  /** Current AudioContext state ('no-ctx' before first init()). */
  contextState(): string {
    return this.ctx ? this.ctx.state : 'no-ctx';
  }

  /** Master-chain analyser tap (for QA / visualizers); null before init(). */
  getAnalyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) {
      this.init();
      if (this.masterGain && this.ctx) {
        this.masterGain.gain.setValueAtTime(0.58, this.ctx.currentTime);
      }
    } else {
      // Mute path: kill any ringing voices, duck the master bus and stop
      // the ambient cadence.
      this.stealVoices(3);
      if (this.masterGain && this.ctx) {
        this.masterGain.gain.setValueAtTime(0.0001, this.ctx.currentTime);
      }
      this.stopAmbient();
    }
  }

  isEnabled(): boolean {
    return this.enabled && this.ctx !== null;
  }

  // ------------------------------------------------------------------
  // Procedural noise / saturation tables
  // ------------------------------------------------------------------

  /** Pink noise: 1/f slope via Kellet 6-pole IIR. */
  private makePinkNoiseBuffer(): AudioBuffer | null {
    if (!this.ctx) return null;
    const sampleRate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, sampleRate * 3, sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    return buffer;
  }

  /** Brown noise: 1/f² slope via leaky integrator (random walk). */
  private makeBrownNoiseBuffer(): AudioBuffer | null {
    if (!this.ctx) return null;
    const sampleRate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, sampleRate * 3, sampleRate);
    const data = buffer.getChannelData(0);
    let lastOut = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      lastOut = (lastOut + 0.02 * white) / 1.02;
      data[i] = lastOut * 3.6;
    }
    return buffer;
  }

  private makeWhiteNoiseBuffer(): AudioBuffer | null {
    if (!this.ctx) return null;
    const sampleRate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, sampleRate * 3, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /** Non-linear plasma hyperbolic-tangent saturation table. */
  private makeSaturationCurve(): Float32Array<ArrayBuffer> {
    const n = 4096;
    const curve = new Float32Array(n);
    const k = 2.6;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = Math.tanh(k * x);
    }
    return curve;
  }

  private loopingNoise(buffer: AudioBuffer | null): AudioBufferSourceNode | null {
    if (!this.ctx || !buffer) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    return src;
  }

  private getPink(): AudioBufferSourceNode | null {
    if (!this.pinkNoiseBuffer && this.ctx) this.pinkNoiseBuffer = this.makePinkNoiseBuffer();
    return this.loopingNoise(this.pinkNoiseBuffer);
  }

  private getBrown(): AudioBufferSourceNode | null {
    if (!this.brownNoiseBuffer && this.ctx) this.brownNoiseBuffer = this.makeBrownNoiseBuffer();
    return this.loopingNoise(this.brownNoiseBuffer);
  }

  private getWhite(): AudioBufferSourceNode | null {
    if (!this.whiteNoiseBuffer && this.ctx) this.whiteNoiseBuffer = this.makeWhiteNoiseBuffer();
    return this.loopingNoise(this.whiteNoiseBuffer);
  }

  private getSaturation(): WaveShaperNode | null {
    if (!this.ctx) return null;
    if (!this.saturationCurve) this.saturationCurve = this.makeSaturationCurve();
    const shaper = this.ctx.createWaveShaper();
    shaper.curve = this.saturationCurve;
    shaper.oversample = '2x';
    return shaper;
  }

  // ------------------------------------------------------------------
  // Pop-free voice stealing & pitch jitter
  // ------------------------------------------------------------------

  /** Multiplicative pitch jitter around 1.0. */
  private jitter(amount = 0.065): number {
    return 1 + (Math.random() * 2 - 1) * amount;
  }

  /**
   * Clamp an absolute scheduling time so it never precedes the context clock.
   * A freshly created AudioContext reports currentTime === 0, so a computed
   * time like `t + 0 + (Math.random() - 0.5) * jitter` can come out slightly
   * NEGATIVE — and negative times make setValueAtTime()/start()/stop() throw
   * a RangeError (which, escaping into a React effect, unmounts the widget).
   */
  private schedAt(time: number): number {
    return Math.max(this.ctx ? this.ctx.currentTime : 0, time);
  }

  /**
   * Steal all live voices with a fast linear fade (default 3 ms) so rapid
   * re-triggers never pop.
   */
  private stealVoices(fadeMs = 3): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const fadeSec = Math.max(0.002, fadeMs / 1000);
    for (const voice of this.activeVoices) {
      try {
        voice.gainNode.gain.cancelScheduledValues(now);
        voice.gainNode.gain.setValueAtTime(voice.gainNode.gain.value, now);
        voice.gainNode.gain.linearRampToValueAtTime(0.0001, now + fadeSec);
        for (const node of voice.nodes) {
          try {
            node.stop(now + fadeSec + 0.004);
          } catch {
            /* already stopped */
          }
        }
      } catch {
        /* disconnected */
      }
    }
    this.activeVoices = [];
  }

  private createVoice(options: VoiceOptions = {}): VoiceHandle | null {
    if (!this.enabled) return null;
    this.init();
    if (!this.ctx || !this.masterBus) return null;
    const t = this.ctx.currentTime;

    if (options.stealVoices !== false) {
      this.stealVoices(options.fadeMs ?? 3);
    }

    const voiceGain = this.ctx.createGain();
    voiceGain.gain.setValueAtTime(options.volume ?? 1.0, t);
    voiceGain.connect(this.masterBus);

    const voice: ActiveVoice = { gainNode: voiceGain, nodes: [] };
    this.activeVoices.push(voice);

    const duration = options.duration ?? 1.8;
    setTimeout(() => {
      const idx = this.activeVoices.indexOf(voice);
      if (idx !== -1) {
        try {
          voiceGain.disconnect();
        } catch {
          /* already disconnected */
        }
        this.activeVoices.splice(idx, 1);
      }
    }, (duration + 0.15) * 1000);

    return { out: voiceGain, t, voice };
  }

  // ------------------------------------------------------------------
  // Shuffle Round-Robin variant pool (zero consecutive repeats)
  // ------------------------------------------------------------------

  private pickVariant(key: SfxKey, variant?: number): number {
    if (variant !== undefined) {
      const clamped = Math.min(2, Math.max(0, Math.floor(variant)));
      this.variantHistory.set(key, clamped);
      return clamped;
    }
    const last = this.variantHistory.get(key);
    const pool: number[] = [];
    for (let i = 0; i < 3; i++) {
      if (i !== last) pool.push(i);
    }
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    this.variantHistory.set(key, chosen);
    return chosen;
  }

  // ------------------------------------------------------------------
  // Autonomous ambient cadence (45–90 s, only while enabled)
  // ------------------------------------------------------------------

  /**
   * Fire a context-appropriate pet sound every 45–90 s while enabled.
   * `getCurrentActivity` returns an activity label such as
   * 'sleeping' | 'coding' | 'coffee' | 'celebrating' | 'idle' (free-form).
   * Call stopAmbient() on blur/mute.
   */
  scheduleAmbient(getCurrentActivity: () => string): void {
    this.getActivityFn = getCurrentActivity;
    this.stopAmbientTimer();
    if (!this.enabled) return;
    this.scheduleNextAmbient();
  }

  stopAmbient(): void {
    this.getActivityFn = null;
    this.stopAmbientTimer();
  }

  private stopAmbientTimer(): void {
    if (this.ambientTimer !== null) {
      clearTimeout(this.ambientTimer);
      this.ambientTimer = null;
    }
  }

  private scheduleNextAmbient(): void {
    if (!this.enabled) return;
    const delay = AMBIENT_MIN_MS + Math.random() * (AMBIENT_MAX_MS - AMBIENT_MIN_MS);
    this.ambientTimer = setTimeout(() => {
      this.ambientTimer = null;
      if (!this.enabled) return;
      this.fireAmbientSound();
      this.scheduleNextAmbient();
    }, delay);
  }

  private fireAmbientSound(): void {
    const activity = (this.getActivityFn?.() ?? 'idle').toLowerCase();
    if (activity.includes('sleep') || activity.includes('nap')) {
      const roll = Math.random();
      if (roll < 0.6) this.playOrganicSnoring();
      else if (roll < 0.8) this.playSadTiredSigh();
      else this.playOrganicYawn();
    } else if (activity.includes('code') || activity.includes('hack') || activity.includes('work')) {
      const roll = Math.random();
      if (roll < 0.4) this.playHackerCodeFrenzy();
      else if (roll < 0.7) this.playHackerFlowchart();
      else this.playMugTableTap();
    } else if (activity.includes('coffee') || activity.includes('eat') || activity.includes('hungry')) {
      const roll = Math.random();
      if (roll < 0.5) this.playMascotNanoCoffee();
      else this.playStomachRumbling();
    } else if (activity.includes('celebrat') || activity.includes('reward') || activity.includes('donat')) {
      const roll = Math.random();
      if (roll < 0.4) this.playRealisticCoinDrop();
      else if (roll < 0.7) this.playActionCheer();
      else this.playChime();
    } else {
      // Idle mix: mostly organic life signs, rare mascot chatter.
      const roll = Math.random();
      if (roll < 0.35) this.playStomachRumbling();
      else if (roll < 0.6) this.playOrganicYawn();
      else if (roll < 0.85) this.playMascotSensorPolish();
      else this.playMascotModelJuggler();
    }
  }

  // ------------------------------------------------------------------
  // 1. SNORING (V1 chest rattle / V2 whistle snore / V3 sleep breath)
  // ------------------------------------------------------------------

  playOrganicSnoring(variantIndex?: number): number {
    return this.snore('mascot', 'playOrganicSnoring', variantIndex);
  }

  playMascotPowerNap(variantIndex?: number): number {
    return this.snore('mascot', 'playMascotPowerNap', variantIndex);
  }

  playHackerTerminalNap(variantIndex?: number): number {
    return this.snore('hacker', 'playHackerTerminalNap', variantIndex);
  }

  private snore(character: 'mascot' | 'hacker', key: SfxKey, variant?: number): number {
    const vIdx = this.pickVariant(key, variant);
    const v = this.createVoice({ duration: 2.2 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.06);

    if (vIdx === 0) {
      // Deep Chest Rattle: inhale swell + 38 Hz uvular flutter + throat rasp + wheeze
      const inNoise = this.getPink();
      if (inNoise) {
        const f = this.ctx!.createBiquadFilter();
        const g = this.ctx!.createGain();
        f.type = 'bandpass';
        f.frequency.setValueAtTime(320 * pMod, t);
        f.frequency.exponentialRampToValueAtTime(680 * pMod, t + 0.38);
        f.Q.value = 2.8;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.42, t + 0.22);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
        inNoise.connect(f); f.connect(g); g.connect(out);
        inNoise.start(t); inNoise.stop(t + 0.42);
        voice.nodes.push(inNoise);
      }

      const tSnore = t + 0.35;
      const osc = this.ctx!.createOscillator();
      const lfo = this.ctx!.createOscillator();
      const lfoGain = this.ctx!.createGain();
      const sg = this.ctx!.createGain();

      osc.type = character === 'hacker' ? 'sawtooth' : 'triangle';
      const baseFreq = (character === 'hacker' ? 42 : 38) * pMod;
      osc.frequency.setValueAtTime(baseFreq, tSnore);
      osc.frequency.linearRampToValueAtTime(baseFreq * 0.85, tSnore + 0.75);
      lfo.frequency.setValueAtTime(18.0, tSnore);
      lfoGain.gain.setValueAtTime(25 * pMod, tSnore);
      lfo.connect(osc.frequency);

      // Resonant throat-rasp formants 520 Hz / 1350 Hz
      const f1 = this.ctx!.createBiquadFilter();
      const f2 = this.ctx!.createBiquadFilter();
      f1.type = 'bandpass'; f1.frequency.setValueAtTime(520 * pMod, tSnore); f1.Q.value = 4.5;
      f2.type = 'bandpass'; f2.frequency.setValueAtTime(1350 * pMod, tSnore); f2.Q.value = 5.0;
      sg.gain.setValueAtTime(0.0001, tSnore);
      sg.gain.linearRampToValueAtTime(0.62, tSnore + 0.12);
      sg.gain.exponentialRampToValueAtTime(0.0001, tSnore + 0.78);
      osc.connect(f1); osc.connect(f2); f1.connect(sg); f2.connect(sg); sg.connect(out);
      lfo.start(tSnore); osc.start(tSnore);
      lfo.stop(tSnore + 0.82); osc.stop(tSnore + 0.82);
      voice.nodes.push(lfo, osc);

      const rasp = this.getPink();
      if (rasp) {
        const rf = this.ctx!.createBiquadFilter();
        const rg = this.ctx!.createGain();
        rf.type = 'bandpass'; rf.frequency.setValueAtTime(880 * pMod, tSnore); rf.Q.value = 3.5;
        rg.gain.setValueAtTime(0.0001, tSnore);
        rg.gain.linearRampToValueAtTime(0.35, tSnore + 0.15);
        rg.gain.exponentialRampToValueAtTime(0.0001, tSnore + 0.7);
        rasp.connect(rf); rf.connect(rg); rg.connect(out);
        rasp.start(tSnore); rasp.stop(tSnore + 0.75);
        voice.nodes.push(rasp);
      }

      // Deep exhaling wheeze
      const tEx = t + 1.1;
      const ex = this.getBrown();
      if (ex) {
        const ef = this.ctx!.createBiquadFilter();
        const eg = this.ctx!.createGain();
        ef.type = 'lowpass';
        ef.frequency.setValueAtTime(160 * pMod, tEx);
        ef.frequency.exponentialRampToValueAtTime(45, tEx + 0.8);
        eg.gain.setValueAtTime(0.0001, tEx);
        eg.gain.linearRampToValueAtTime(0.5, tEx + 0.18);
        eg.gain.exponentialRampToValueAtTime(0.0001, tEx + 0.85);
        ex.connect(ef); ef.connect(eg); eg.connect(out);
        ex.start(tEx); ex.stop(tEx + 0.9);
        voice.nodes.push(ex);
      }
    } else if (vIdx === 1) {
      // Cartoon Whistle Snore: 1.4 kHz whistle inhale + flutter pop + puff
      const whistle = this.ctx!.createOscillator();
      const wg = this.ctx!.createGain();
      whistle.type = 'sine';
      whistle.frequency.setValueAtTime(1380 * pMod, t);
      whistle.frequency.exponentialRampToValueAtTime(1580 * pMod, t + 0.45);
      wg.gain.setValueAtTime(0.0001, t);
      wg.gain.linearRampToValueAtTime(0.48, t + 0.22);
      wg.gain.exponentialRampToValueAtTime(0.0001, t + 0.48);
      whistle.connect(wg); wg.connect(out);
      whistle.start(t); whistle.stop(t + 0.5);
      voice.nodes.push(whistle);

      const wAir = this.getPink();
      if (wAir) {
        const wf = this.ctx!.createBiquadFilter();
        const wag = this.ctx!.createGain();
        wf.type = 'bandpass'; wf.frequency.setValueAtTime(1450 * pMod, t); wf.Q.value = 6.0;
        wag.gain.setValueAtTime(0.0001, t);
        wag.gain.linearRampToValueAtTime(0.3, t + 0.22);
        wag.gain.exponentialRampToValueAtTime(0.0001, t + 0.48);
        wAir.connect(wf); wf.connect(wag); wag.connect(out);
        wAir.start(t); wAir.stop(t + 0.5);
        voice.nodes.push(wAir);
      }

      const tPop = t + 0.48;
      const pop = this.ctx!.createOscillator();
      const popLfo = this.ctx!.createOscillator();
      const popLfoG = this.ctx!.createGain();
      const pg = this.ctx!.createGain();
      const pf = this.ctx!.createBiquadFilter();
      pop.type = 'triangle';
      pop.frequency.setValueAtTime(95 * pMod, tPop);
      pop.frequency.exponentialRampToValueAtTime(40 * pMod, tPop + 0.35);
      popLfo.frequency.setValueAtTime(28.0, tPop);
      popLfoG.gain.setValueAtTime(20 * pMod, tPop);
      popLfo.connect(pop.frequency);
      pf.type = 'lowpass'; pf.frequency.setValueAtTime(450 * pMod, tPop);
      pg.gain.setValueAtTime(0.0001, tPop);
      pg.gain.linearRampToValueAtTime(0.6, tPop + 0.04);
      pg.gain.exponentialRampToValueAtTime(0.0001, tPop + 0.38);
      pop.connect(pf); pf.connect(pg); pg.connect(out);
      popLfo.start(tPop); pop.start(tPop);
      popLfo.stop(tPop + 0.4); pop.stop(tPop + 0.4);
      voice.nodes.push(popLfo, pop);

      const tPuff = t + 0.88;
      const puff = this.getPink();
      if (puff) {
        const puf = this.ctx!.createBiquadFilter();
        const pug = this.ctx!.createGain();
        puf.type = 'bandpass';
        puf.frequency.setValueAtTime(420 * pMod, tPuff);
        puf.frequency.exponentialRampToValueAtTime(140 * pMod, tPuff + 0.55);
        puf.Q.value = 2.2;
        pug.gain.setValueAtTime(0.0001, tPuff);
        pug.gain.linearRampToValueAtTime(0.42, tPuff + 0.12);
        pug.gain.exponentialRampToValueAtTime(0.0001, tPuff + 0.58);
        puff.connect(puf); puf.connect(pug); pug.connect(out);
        puff.start(tPuff); puff.stop(tPuff + 0.6);
        voice.nodes.push(puff);
      }
    } else {
      // Peaceful Sleep Breath: warm ocean-like brown-noise inhale/exhale
      const inB = this.getBrown();
      if (inB) {
        const f = this.ctx!.createBiquadFilter();
        const g = this.ctx!.createGain();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(160 * pMod, t);
        f.frequency.exponentialRampToValueAtTime(420 * pMod, t + 0.6);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.48, t + 0.35);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
        inB.connect(f); f.connect(g); g.connect(out);
        inB.start(t); inB.stop(t + 0.68);
        voice.nodes.push(inB);
      }
      const tEx = t + 0.75;
      const exB = this.getBrown();
      if (exB) {
        const f = this.ctx!.createBiquadFilter();
        const g = this.ctx!.createGain();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(420 * pMod, tEx);
        f.frequency.exponentialRampToValueAtTime(85 * pMod, tEx + 0.9);
        g.gain.setValueAtTime(0.0001, tEx);
        g.gain.linearRampToValueAtTime(0.44, tEx + 0.25);
        g.gain.exponentialRampToValueAtTime(0.0001, tEx + 0.95);
        exB.connect(f); f.connect(g); g.connect(out);
        exB.start(tEx); exB.stop(tEx + 1.0);
        voice.nodes.push(exB);
      }
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 2. STOMACH RUMBLING (V1 visceral gurgle / V2 bubble cascade / V3 whimper)
  // ------------------------------------------------------------------

  playStomachRumbling(variantIndex?: number): number {
    const vIdx = this.pickVariant('playStomachRumbling', variantIndex);
    const v = this.createVoice({ duration: 1.4 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.06);

    if (vIdx === 0) {
      // Deep Visceral Gurgle: 35 Hz FM rolling mud + gut resonance
      const drone = this.ctx!.createOscillator();
      const lfo1 = this.ctx!.createOscillator();
      const lfo2 = this.ctx!.createOscillator();
      const l1g = this.ctx!.createGain();
      const l2g = this.ctx!.createGain();
      const dg = this.ctx!.createGain();
      const df = this.ctx!.createBiquadFilter();

      drone.type = 'triangle';
      drone.frequency.setValueAtTime(35 * pMod, t);
      drone.frequency.exponentialRampToValueAtTime(52 * pMod, t + 0.45);
      drone.frequency.exponentialRampToValueAtTime(30 * pMod, t + 1.1);
      lfo1.frequency.setValueAtTime(8.5, t);
      l1g.gain.setValueAtTime(18 * pMod, t);
      lfo1.connect(drone.frequency);
      lfo2.frequency.setValueAtTime(13.2, t);
      l2g.gain.setValueAtTime(12 * pMod, t);
      lfo2.connect(drone.frequency);
      df.type = 'bandpass';
      df.frequency.setValueAtTime(80 * pMod, t);
      df.frequency.exponentialRampToValueAtTime(220 * pMod, t + 0.4);
      df.frequency.exponentialRampToValueAtTime(65 * pMod, t + 1.1);
      df.Q.value = 5.5;
      dg.gain.setValueAtTime(0.0001, t);
      dg.gain.linearRampToValueAtTime(0.68, t + 0.18);
      dg.gain.exponentialRampToValueAtTime(0.0001, t + 1.15);
      drone.connect(df); df.connect(dg); dg.connect(out);
      lfo1.start(t); lfo2.start(t); drone.start(t);
      lfo1.stop(t + 1.2); lfo2.stop(t + 1.2); drone.stop(t + 1.2);
      voice.nodes.push(lfo1, lfo2, drone);

      const brown = this.getBrown();
      if (brown) {
        const lp = this.ctx!.createBiquadFilter();
        const bg = this.ctx!.createGain();
        lp.type = 'lowpass'; lp.frequency.setValueAtTime(75 * pMod, t); lp.Q.value = 6.0;
        bg.gain.setValueAtTime(0.0001, t);
        bg.gain.linearRampToValueAtTime(0.6, t + 0.2);
        bg.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
        brown.connect(lp); lp.connect(bg); bg.connect(out);
        brown.start(t); brown.stop(t + 1.15);
        voice.nodes.push(brown);
      }
    } else if (vIdx === 1) {
      // Bubble Pop Cascade: 8 rapid distinct gas bubbles + fluid swirl
      const bubbleFreqs = [180, 320, 240, 420, 210, 360, 290, 510];
      const bubbleDelays = [0.03, 0.1, 0.17, 0.26, 0.36, 0.46, 0.56, 0.67];
      bubbleDelays.forEach((cd, i) => {
        const tb = this.schedAt(t + cd + (Math.random() - 0.5) * 0.015);
        const f0 = bubbleFreqs[i] * this.jitter(0.08);
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f0, tb);
        osc.frequency.exponentialRampToValueAtTime(f0 * 1.32, tb + 0.024);
        g.gain.setValueAtTime(0.001, tb);
        g.gain.linearRampToValueAtTime(0.56, tb + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, tb + 0.035);
        osc.connect(g); g.connect(out);
        osc.start(tb); osc.stop(tb + 0.04);
        voice.nodes.push(osc);
      });

      const n = this.getPink();
      if (n) {
        const bf = this.ctx!.createBiquadFilter();
        const bg = this.ctx!.createGain();
        bf.type = 'bandpass';
        bf.frequency.setValueAtTime(220 * pMod, t);
        bf.frequency.exponentialRampToValueAtTime(540 * pMod, t + 0.35);
        bf.frequency.exponentialRampToValueAtTime(180 * pMod, t + 0.75);
        bf.Q.value = 3.5;
        bg.gain.setValueAtTime(0.0001, t);
        bg.gain.linearRampToValueAtTime(0.42, t + 0.15);
        bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
        n.connect(bf); bf.connect(bg); bg.connect(out);
        n.start(t); n.stop(t + 0.85);
        voice.nodes.push(n);
      }
    } else {
      // Hungry Whimper: cavitation squeak (920->380 Hz + 22 Hz flutter) + vocal sigh
      const sqOsc = this.ctx!.createOscillator();
      const sqFlut = this.ctx!.createOscillator();
      const sqFlutG = this.ctx!.createGain();
      const sqG = this.ctx!.createGain();
      sqOsc.type = 'sine';
      sqOsc.frequency.setValueAtTime(920 * pMod, t);
      sqOsc.frequency.exponentialRampToValueAtTime(380 * pMod, t + 0.35);
      sqFlut.frequency.setValueAtTime(22.0, t);
      sqFlutG.gain.setValueAtTime(35 * pMod, t);
      sqFlut.connect(sqOsc.frequency);
      sqG.gain.setValueAtTime(0.001, t);
      sqG.gain.linearRampToValueAtTime(0.55, t + 0.04);
      sqG.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
      sqOsc.connect(sqG); sqG.connect(out);
      sqFlut.start(t); sqOsc.start(t);
      sqFlut.stop(t + 0.4); sqOsc.stop(t + 0.4);
      voice.nodes.push(sqFlut, sqOsc);

      const tSigh = t + 0.32;
      const sigh = this.ctx!.createOscillator();
      const sg = this.ctx!.createGain();
      const f1 = this.ctx!.createBiquadFilter();
      const f2 = this.ctx!.createBiquadFilter();
      sigh.type = 'triangle';
      sigh.frequency.setValueAtTime(180 * pMod, tSigh);
      sigh.frequency.exponentialRampToValueAtTime(80 * pMod, tSigh + 0.6);
      f1.type = 'bandpass'; f1.frequency.setValueAtTime(450 * pMod, tSigh); f1.Q.value = 3.5;
      f2.type = 'bandpass'; f2.frequency.setValueAtTime(980 * pMod, tSigh); f2.Q.value = 4.0;
      sg.gain.setValueAtTime(0.0001, tSigh);
      sg.gain.linearRampToValueAtTime(0.48, tSigh + 0.15);
      sg.gain.exponentialRampToValueAtTime(0.0001, tSigh + 0.65);
      sigh.connect(f1); sigh.connect(f2); f1.connect(sg); f2.connect(sg); sg.connect(out);
      sigh.start(tSigh); sigh.stop(tSigh + 0.7);
      voice.nodes.push(sigh);
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 3. ORGANIC YAWN (V1 stretched A->O->U / V2 sinking sigh / V3 gulp yawn)
  // ------------------------------------------------------------------

  playOrganicYawn(variantIndex?: number): number {
    const vIdx = this.pickVariant('playOrganicYawn', variantIndex);
    const v = this.createVoice({ duration: 1.6 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.05);

    if (vIdx === 0) {
      // Big Stretched Yawn: formant sweep + jaw click at peak
      const base = this.ctx!.createOscillator();
      const bg = this.ctx!.createGain();
      base.type = 'triangle';
      base.frequency.setValueAtTime(210 * pMod, t);
      base.frequency.exponentialRampToValueAtTime(295 * pMod, t + 0.42);
      base.frequency.exponentialRampToValueAtTime(85 * pMod, t + 1.35);
      const f1 = this.ctx!.createBiquadFilter();
      const f2 = this.ctx!.createBiquadFilter();
      f1.type = 'bandpass'; f1.Q.value = 3.8;
      f1.frequency.setValueAtTime(850 * pMod, t);
      f1.frequency.exponentialRampToValueAtTime(520 * pMod, t + 0.45);
      f1.frequency.exponentialRampToValueAtTime(300 * pMod, t + 1.35);
      f2.type = 'bandpass'; f2.Q.value = 4.0;
      f2.frequency.setValueAtTime(1350 * pMod, t);
      f2.frequency.exponentialRampToValueAtTime(920 * pMod, t + 0.45);
      f2.frequency.exponentialRampToValueAtTime(650 * pMod, t + 1.35);
      bg.gain.setValueAtTime(0.0001, t);
      bg.gain.linearRampToValueAtTime(0.55, t + 0.35);
      bg.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      base.connect(f1); base.connect(f2); f1.connect(bg); f2.connect(bg); bg.connect(out);
      base.start(t); base.stop(t + 1.42);
      voice.nodes.push(base);

      // Jaw joint click
      const click = this.getPink();
      if (click) {
        const tClick = t + 0.42;
        const cf = this.ctx!.createBiquadFilter();
        const cg = this.ctx!.createGain();
        cf.type = 'bandpass'; cf.frequency.setValueAtTime(3400 * pMod, tClick); cf.Q.value = 6.0;
        cg.gain.setValueAtTime(0.52, tClick);
        cg.gain.exponentialRampToValueAtTime(0.0001, tClick + 0.015);
        click.connect(cf); cf.connect(cg); cg.connect(out);
        click.start(tClick); click.stop(tClick + 0.02);
        voice.nodes.push(click);
      }

      // Satisfied breath release
      const noise = this.getPink();
      if (noise) {
        const nf = this.ctx!.createBiquadFilter();
        const ng = this.ctx!.createGain();
        nf.type = 'lowpass';
        nf.frequency.setValueAtTime(580 * pMod, t + 0.4);
        nf.frequency.exponentialRampToValueAtTime(140, t + 1.35);
        ng.gain.setValueAtTime(0.0001, t + 0.4);
        ng.gain.linearRampToValueAtTime(0.48, t + 0.7);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
        noise.connect(nf); nf.connect(ng); ng.connect(out);
        noise.start(t + 0.4); noise.stop(t + 1.45);
        voice.nodes.push(noise);
      }
    } else if (vIdx === 1) {
      // Tired Sinking Sigh: deep vocal sigh with 6 Hz tremor + breath layer
      const voc = this.ctx!.createOscillator();
      const trem = this.ctx!.createOscillator();
      const tremG = this.ctx!.createGain();
      const vg = this.ctx!.createGain();
      voc.type = 'triangle';
      voc.frequency.setValueAtTime(230 * pMod, t);
      voc.frequency.exponentialRampToValueAtTime(80 * pMod, t + 1.1);
      trem.frequency.setValueAtTime(6.2, t);
      tremG.gain.setValueAtTime(12 * pMod, t);
      trem.connect(voc.frequency);
      vg.gain.setValueAtTime(0.0001, t);
      vg.gain.linearRampToValueAtTime(0.5, t + 0.18);
      vg.gain.exponentialRampToValueAtTime(0.0001, t + 1.15);
      voc.connect(vg); vg.connect(out);
      trem.start(t); voc.start(t);
      trem.stop(t + 1.2); voc.stop(t + 1.2);
      voice.nodes.push(trem, voc);

      const breath = this.getPink();
      if (breath) {
        const bf = this.ctx!.createBiquadFilter();
        const bgn = this.ctx!.createGain();
        bf.type = 'bandpass';
        bf.frequency.setValueAtTime(480 * pMod, t + 0.08);
        bf.frequency.linearRampToValueAtTime(120 * pMod, t + 1.1);
        bf.Q.value = 2.2;
        bgn.gain.setValueAtTime(0.0001, t + 0.08);
        bgn.gain.linearRampToValueAtTime(0.46, t + 0.35);
        bgn.gain.exponentialRampToValueAtTime(0.0001, t + 1.15);
        breath.connect(bf); bf.connect(bgn); bgn.connect(out);
        breath.start(t + 0.08); breath.stop(t + 1.2);
        voice.nodes.push(breath);
      }
    } else {
      // Suppressed Gulp Yawn: muffled lowpassed vocal + nasal puff pop
      const voc = this.ctx!.createOscillator();
      const vg = this.ctx!.createGain();
      const vf = this.ctx!.createBiquadFilter();
      voc.type = 'triangle';
      voc.frequency.setValueAtTime(170 * pMod, t);
      voc.frequency.exponentialRampToValueAtTime(220 * pMod, t + 0.25);
      voc.frequency.exponentialRampToValueAtTime(110 * pMod, t + 0.55);
      vf.type = 'lowpass'; vf.frequency.setValueAtTime(320 * pMod, t);
      vg.gain.setValueAtTime(0.0001, t);
      vg.gain.linearRampToValueAtTime(0.52, t + 0.15);
      vg.gain.exponentialRampToValueAtTime(0.0001, t + 0.58);
      voc.connect(vf); vf.connect(vg); vg.connect(out);
      voc.start(t); voc.stop(t + 0.6);
      voice.nodes.push(voc);

      const tPuff = t + 0.55;
      const pop = this.ctx!.createOscillator();
      const pg = this.ctx!.createGain();
      pop.type = 'sine';
      pop.frequency.setValueAtTime(130 * pMod, tPuff);
      pop.frequency.exponentialRampToValueAtTime(60 * pMod, tPuff + 0.04);
      pg.gain.setValueAtTime(0.48, tPuff);
      pg.gain.exponentialRampToValueAtTime(0.0001, tPuff + 0.05);
      pop.connect(pg); pg.connect(out);
      pop.start(tPuff); pop.stop(tPuff + 0.06);
      voice.nodes.push(pop);

      const air = this.getPink();
      if (air) {
        const af = this.ctx!.createBiquadFilter();
        const ag = this.ctx!.createGain();
        af.type = 'bandpass'; af.frequency.setValueAtTime(360 * pMod, tPuff); af.Q.value = 2.0;
        ag.gain.setValueAtTime(0.0001, tPuff);
        ag.gain.linearRampToValueAtTime(0.38, tPuff + 0.04);
        ag.gain.exponentialRampToValueAtTime(0.0001, tPuff + 0.35);
        air.connect(af); af.connect(ag); ag.connect(out);
        air.start(tPuff); air.stop(tPuff + 0.38);
        voice.nodes.push(air);
      }
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 4. SAD TIRED SIGH (V1 vocal exhaustion / V2 aspirated whisper / V3 droop)
  // ------------------------------------------------------------------

  playSadTiredSigh(variantIndex?: number): number {
    const vIdx = this.pickVariant('playSadTiredSigh', variantIndex);
    const v = this.createVoice({ duration: 1.2 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.06);

    if (vIdx === 0) {
      // Vocal Exhaustion Sigh: huuuu-hhhh + 6 Hz tremor
      const voc = this.ctx!.createOscillator();
      const tremolo = this.ctx!.createOscillator();
      const tg = this.ctx!.createGain();
      const vg = this.ctx!.createGain();
      voc.type = 'triangle';
      voc.frequency.setValueAtTime(240 * pMod, t);
      voc.frequency.exponentialRampToValueAtTime(90 * pMod, t + 0.88);
      tremolo.frequency.setValueAtTime(6.0, t);
      tg.gain.setValueAtTime(10 * pMod, t);
      tremolo.connect(voc.frequency);
      vg.gain.setValueAtTime(0.0001, t);
      vg.gain.linearRampToValueAtTime(0.52, t + 0.14);
      vg.gain.exponentialRampToValueAtTime(0.0001, t + 0.92);
      voc.connect(vg); vg.connect(out);
      tremolo.start(t); voc.start(t);
      tremolo.stop(t + 0.95); voc.stop(t + 0.95);
      voice.nodes.push(tremolo, voc);

      const noise = this.getPink();
      if (noise) {
        const f = this.ctx!.createBiquadFilter();
        const ng = this.ctx!.createGain();
        f.type = 'bandpass';
        f.frequency.setValueAtTime(650 * pMod, t);
        f.frequency.linearRampToValueAtTime(220 * pMod, t + 0.88);
        f.Q.value = 2.4;
        ng.gain.setValueAtTime(0.0001, t);
        ng.gain.linearRampToValueAtTime(0.48, t + 0.18);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
        noise.connect(f); f.connect(ng); ng.connect(out);
        noise.start(t); noise.stop(t + 0.95);
        voice.nodes.push(noise);
      }
    } else if (vIdx === 1) {
      // Soft Aspirated Breath: dual-layer pink-noise whisper exhale
      const noise = this.getPink();
      if (noise) {
        const f1 = this.ctx!.createBiquadFilter();
        const f2 = this.ctx!.createBiquadFilter();
        const ng = this.ctx!.createGain();
        f1.type = 'bandpass';
        f1.frequency.setValueAtTime(720 * pMod, t);
        f1.frequency.exponentialRampToValueAtTime(180 * pMod, t + 0.95);
        f1.Q.value = 1.8;
        f2.type = 'lowpass';
        f2.frequency.setValueAtTime(1200 * pMod, t);
        f2.frequency.exponentialRampToValueAtTime(260 * pMod, t + 0.95);
        ng.gain.setValueAtTime(0.0001, t);
        ng.gain.linearRampToValueAtTime(0.55, t + 0.2);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
        noise.connect(f1); f1.connect(f2); f2.connect(ng); ng.connect(out);
        noise.start(t); noise.stop(t + 1.05);
        voice.nodes.push(noise);
      }
    } else {
      // Melancholy Vocal Droop: sub-harmonic droop + brown murmur
      const osc = this.ctx!.createOscillator();
      const og = this.ctx!.createGain();
      const of_ = this.ctx!.createBiquadFilter();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(180 * pMod, t);
      osc.frequency.exponentialRampToValueAtTime(65 * pMod, t + 0.85);
      of_.type = 'lowpass'; of_.frequency.setValueAtTime(320 * pMod, t);
      og.gain.setValueAtTime(0.0001, t);
      og.gain.linearRampToValueAtTime(0.54, t + 0.12);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      osc.connect(of_); of_.connect(og); og.connect(out);
      osc.start(t); osc.stop(t + 0.92);
      voice.nodes.push(osc);

      const brown = this.getBrown();
      if (brown) {
        const bf = this.ctx!.createBiquadFilter();
        const bg = this.ctx!.createGain();
        bf.type = 'lowpass'; bf.frequency.setValueAtTime(140 * pMod, t);
        bg.gain.setValueAtTime(0.0001, t);
        bg.gain.linearRampToValueAtTime(0.42, t + 0.18);
        bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
        brown.connect(bf); bf.connect(bg); bg.connect(out);
        brown.start(t); brown.stop(t + 0.92);
        voice.nodes.push(brown);
      }
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 5. HACKER CODE FRENZY (mechanical keyboard: blue / brown / spacebar)
  // ------------------------------------------------------------------

  playHackerCodeFrenzy(variantIndex?: number): number {
    const vIdx = this.pickVariant('playHackerCodeFrenzy', variantIndex);
    const v = this.createVoice({ duration: 0.85 });
    if (!v) return -1;
    const { out, t, voice } = v;

    const keystroke = (
      tk: number,
      snapFreq: number,
      snapQ: number,
      thudFreq: number,
      subFreq: number,
      pingFreq: number,
      isSpacebar: boolean,
    ): void => {
      // Fresh contexts clock at ~0ms: a zero-delay keystroke plus negative
      // random jitter below can yield tk < 0, and setValueAtTime()/start()
      // would throw RangeError. Clamp once — every layer schedules off tk.
      tk = this.schedAt(tk);
      const kJit = this.jitter(0.07);
      // Layer 1: plastic leaf click transient
      const noise = this.getPink();
      if (noise) {
        const sf = this.ctx!.createBiquadFilter();
        const sg = this.ctx!.createGain();
        sf.type = isSpacebar ? 'bandpass' : 'highpass';
        sf.frequency.setValueAtTime(snapFreq * kJit, tk);
        sf.Q.value = snapQ;
        sg.gain.setValueAtTime(isSpacebar ? 0.68 : 0.62, tk);
        sg.gain.exponentialRampToValueAtTime(0.0001, tk + (isSpacebar ? 0.022 : 0.008));
        noise.connect(sf); sf.connect(sg); sg.connect(out);
        noise.start(tk); noise.stop(tk + (isSpacebar ? 0.025 : 0.012));
        voice.nodes.push(noise);
      }
      // Layer 2: housing body thud / bottom-out impact
      const thud = this.ctx!.createOscillator();
      const tg = this.ctx!.createGain();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(thudFreq * kJit, tk);
      thud.frequency.exponentialRampToValueAtTime(subFreq * kJit, tk + (isSpacebar ? 0.065 : 0.024));
      tg.gain.setValueAtTime(isSpacebar ? 0.7 : 0.54, tk);
      tg.gain.exponentialRampToValueAtTime(0.0001, tk + (isSpacebar ? 0.075 : 0.028));
      thud.connect(tg); tg.connect(out);
      thud.start(tk); thud.stop(tk + (isSpacebar ? 0.08 : 0.035));
      voice.nodes.push(thud);
      // Layer 3: metallic spring ping resonance
      const spring = this.ctx!.createOscillator();
      const spg = this.ctx!.createGain();
      spring.type = 'sine';
      spring.frequency.setValueAtTime(pingFreq * kJit, tk + 0.002);
      spg.gain.setValueAtTime(0.001, tk + 0.002);
      spg.gain.linearRampToValueAtTime(isSpacebar ? 0.38 : 0.28, tk + 0.004);
      spg.gain.exponentialRampToValueAtTime(0.0001, tk + (isSpacebar ? 0.085 : 0.045));
      spring.connect(spg); spg.connect(out);
      spring.start(tk + 0.002); spring.stop(tk + (isSpacebar ? 0.09 : 0.05));
      voice.nodes.push(spring);
    };

    if (vIdx === 0) {
      // Clicky Cherry Blue Frenzy: 9 sharp transients
      [0, 0.03, 0.062, 0.095, 0.128, 0.16, 0.194, 0.228, 0.262].forEach((d) => {
        keystroke(t + d + (Math.random() - 0.5) * 0.004, 4200, 5.5, 480, 110, 6800, false);
      });
    } else if (vIdx === 1) {
      // Tactile Cherry Brown Rhythm: 4 heavy dampened clacks
      [0, 0.085, 0.19, 0.28].forEach((d) => {
        keystroke(t + d + (Math.random() - 0.5) * 0.004, 1800, 2.5, 340, 80, 3200, false);
      });
    } else {
      // Spacebar Smash: double tap + massive bottom-out + wire rattle
      keystroke(t, 4200, 5.5, 480, 110, 6800, false);
      keystroke(t + 0.065, 4100, 5.5, 470, 105, 6700, false);
      const tsp = t + 0.16;
      keystroke(tsp, 850, 3.5, 140, 42, 5200, true);
      const wire = this.ctx!.createOscillator();
      const wg = this.ctx!.createGain();
      wire.type = 'sine';
      wire.frequency.setValueAtTime(7100 * this.jitter(0.04), tsp + 0.003);
      wg.gain.setValueAtTime(0.001, tsp + 0.003);
      wg.gain.linearRampToValueAtTime(0.35, tsp + 0.006);
      wg.gain.exponentialRampToValueAtTime(0.0001, tsp + 0.075);
      wire.connect(wg); wg.connect(out);
      wire.start(tsp + 0.003); wire.stop(tsp + 0.08);
      voice.nodes.push(wire);
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 6. MASCOT MODEL JUGGLER (FM robot chirps: question / trill / grumble)
  // ------------------------------------------------------------------

  playMascotModelJuggler(variantIndex?: number): number {
    const vIdx = this.pickVariant('playMascotModelJuggler', variantIndex);
    const v = this.createVoice({ duration: 0.75 });
    if (!v) return -1;
    const { out, t, voice } = v;

    if (vIdx === 0) {
      // Inquisitive Question: rising 3-tone phrase with wide vibrato on top note
      const notes: ReadonlyArray<{ freq: number; delay: number; dur: number }> = [\n        { freq: 783.99, delay: 0, dur: 0.065 },\n        { freq: 987.77, delay: 0.075, dur: 0.065 },\n        { freq: 1318.51, delay: 0.155, dur: 0.28 },\n      ];
      notes.forEach((n, idx) => {
        const tn = t + n.delay;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = idx === 2 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(n.freq, tn);
        if (idx === 2) {
          osc.frequency.exponentialRampToValueAtTime(1480.0, tn + n.dur);
          const vib = this.ctx!.createOscillator();
          const vibG = this.ctx!.createGain();
          vib.frequency.setValueAtTime(8.5, tn);
          vibG.gain.setValueAtTime(50.0, tn);
          vib.connect(osc.frequency);
          vib.start(tn); vib.stop(tn + n.dur + 0.02);
          voice.nodes.push(vib);
        }
        g.gain.setValueAtTime(0.001, tn);
        g.gain.linearRampToValueAtTime(0.55, tn + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, tn + n.dur);
        osc.connect(g); g.connect(out);
        osc.start(tn); osc.stop(tn + n.dur + 0.02);
        voice.nodes.push(osc);
      });
    } else if (vIdx === 1) {
      // Happy Victory Trill: 4-note melody + bell overtones on the top C7
      const melody: ReadonlyArray<{ freq: number; delay: number; dur: number }> = [
        { freq: 1046.5, delay: 0, dur: 0.055 },
        { freq: 783.99, delay: 0.065, dur: 0.055 },
        { freq: 880.0, delay: 0.13, dur: 0.065 },
        { freq: 2093.0, delay: 0.205, dur: 0.26 },
      ];
      melody.forEach((m, idx) => {
        const tn = t + m.delay;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(m.freq, tn);
        g.gain.setValueAtTime(0.001, tn);
        g.gain.linearRampToValueAtTime(0.52, tn + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, tn + m.dur);
        osc.connect(g); g.connect(out);
        osc.start(tn); osc.stop(tn + m.dur + 0.02);
        voice.nodes.push(osc);

        if (idx === 3) {
          [m.freq * 2, m.freq * 3].forEach((hFreq, hIdx) => {
            const bell = this.ctx!.createOscillator();
            const bg = this.ctx!.createGain();
            bell.type = 'sine';
            bell.frequency.setValueAtTime(hFreq, tn);
            bg.gain.setValueAtTime(0.001, tn);
            bg.gain.linearRampToValueAtTime(hIdx === 0 ? 0.32 : 0.18, tn + 0.006);
            bg.gain.exponentialRampToValueAtTime(0.0001, tn + 0.28);
            bell.connect(bg); bg.connect(out);
            bell.start(tn); bell.stop(tn + 0.3);
            voice.nodes.push(bell);
          });
        }
      });
    } else {
      // Comical Grumble: low FM chatter with pitch micro-wobbles
      const grumbles: ReadonlyArray<{ delay: number; dur: number; f0: number; f1: number }> = [
        { delay: 0, dur: 0.13, f0: 190, f1: 155 },
        { delay: 0.15, dur: 0.22, f0: 175, f1: 120 },
      ];
      grumbles.forEach((gr) => {
        const tgr = t + gr.delay;
        const carrier = this.ctx!.createOscillator();
        const modulator = this.ctx!.createOscillator();
        const modG = this.ctx!.createGain();
        const outG = this.ctx!.createGain();
        const wobble = this.ctx!.createOscillator();
        const wobbleG = this.ctx!.createGain();

        carrier.type = 'triangle';
        carrier.frequency.setValueAtTime(gr.f0, tgr);
        carrier.frequency.exponentialRampToValueAtTime(gr.f1, tgr + gr.dur);
        modulator.type = 'sawtooth';
        modulator.frequency.setValueAtTime(46.0, tgr);
        modG.gain.setValueAtTime(240.0, tgr);
        modG.gain.exponentialRampToValueAtTime(40.0, tgr + gr.dur);
        modulator.connect(carrier.frequency);
        wobble.frequency.setValueAtTime(16.0, tgr);
        wobbleG.gain.setValueAtTime(25.0, tgr);
        wobble.connect(carrier.frequency);
        outG.gain.setValueAtTime(0.001, tgr);
        outG.gain.linearRampToValueAtTime(0.55, tgr + 0.015);
        outG.gain.exponentialRampToValueAtTime(0.0001, tgr + gr.dur);
        carrier.connect(outG); outG.connect(out);
        modulator.start(tgr); wobble.start(tgr); carrier.start(tgr);
        modulator.stop(tgr + gr.dur + 0.02);
        wobble.stop(tgr + gr.dur + 0.02);
        carrier.stop(tgr + gr.dur + 0.02);
        voice.nodes.push(modulator, wobble, carrier);
      });
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 7. REALISTIC COIN DROP (Euler-style exponential decay ping cascade)
  // ------------------------------------------------------------------

  playRealisticCoinDrop(variantIndex?: number): number {
    return this.coinDrop('playRealisticCoinDrop', variantIndex);
  }

  playHackerCoinDrop(variantIndex?: number): number {
    return this.coinDrop('playHackerCoinDrop', variantIndex);
  }

  private coinDrop(key: SfxKey, variant?: number): number {
    const vIdx = this.pickVariant(key, variant);
    const v = this.createVoice({ duration: 1.0 });
    if (!v) return -1;
    const { out, t, voice } = v;

    if (vIdx === 0) {
      // Glass Jar Resonance: glass modes 4.8/9.2 kHz + coin clink + rattles + cavity
      [4800, 9200].forEach((gFreq, gi) => {
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(gFreq * this.jitter(0.02), t);
        g.gain.setValueAtTime(0.001, t);
        g.gain.linearRampToValueAtTime(gi === 0 ? 0.6 : 0.35, t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        osc.connect(g); g.connect(out);
        osc.start(t); osc.stop(t + 0.55);
        voice.nodes.push(osc);
      });

      const coin = this.ctx!.createOscillator();
      const cg = this.ctx!.createGain();
      coin.type = 'triangle';
      coin.frequency.setValueAtTime(2800 * this.jitter(0.04), t);
      cg.gain.setValueAtTime(0.55, t);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      coin.connect(cg); cg.connect(out);
      coin.start(t); coin.stop(t + 0.09);
      voice.nodes.push(coin);

      // Decaying chatter rattle: vol = 0.40 * 0.70^n
      [0.055, 0.105, 0.145, 0.175].forEach((rd, ri) => {
        const tr = t + rd;
        const rOsc = this.ctx!.createOscillator();
        const rg = this.ctx!.createGain();
        rOsc.type = 'sine';
        rOsc.frequency.setValueAtTime((4800 + ri * 200) * this.jitter(0.03), tr);
        const rVol = 0.4 * Math.pow(0.7, ri + 1);
        rg.gain.setValueAtTime(0.001, tr);
        rg.gain.linearRampToValueAtTime(rVol, tr + 0.002);
        rg.gain.exponentialRampToValueAtTime(0.0001, tr + 0.06);
        rOsc.connect(rg); rg.connect(out);
        rOsc.start(tr); rOsc.stop(tr + 0.07);
        voice.nodes.push(rOsc);
      });

      const jarAir = this.ctx!.createOscillator();
      const jg = this.ctx!.createGain();
      jarAir.type = 'sine';
      jarAir.frequency.setValueAtTime(340 * this.jitter(0.04), t);
      jarAir.frequency.exponentialRampToValueAtTime(120, t + 0.18);
      jg.gain.setValueAtTime(0.48, t);
      jg.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      jarAir.connect(jg); jg.connect(out);
      jarAir.start(t); jarAir.stop(t + 0.22);
      voice.nodes.push(jarAir);
    } else if (vIdx === 1) {
      // Gold Pile Cascade: pile impacts (vol decays 0.85^i) + metal scrape
      const pileDelays = [0, 0.035, 0.075, 0.12, 0.175];
      const coinModes = [1900, 3400, 5800];
      pileDelays.forEach((pd, pi) => {
        const tp = t + pd;
        coinModes.forEach((mf, mi) => {
          const osc = this.ctx!.createOscillator();
          const g = this.ctx!.createGain();
          osc.type = mi === 0 ? 'triangle' : 'sine';
          osc.frequency.setValueAtTime(mf * this.jitter(0.06), tp);
          const vol = 0.54 * Math.pow(0.85, pi) * (mi === 0 ? 0.7 : 0.5);
          g.gain.setValueAtTime(0.001, tp);
          g.gain.linearRampToValueAtTime(vol, tp + 0.002);
          g.gain.exponentialRampToValueAtTime(0.0001, tp + 0.12);
          osc.connect(g); g.connect(out);
          osc.start(tp); osc.stop(tp + 0.14);
          voice.nodes.push(osc);
        });
      });

      const scrape = this.getPink();
      if (scrape) {
        const sf = this.ctx!.createBiquadFilter();
        const sg = this.ctx!.createGain();
        sf.type = 'bandpass'; sf.frequency.setValueAtTime(2600, t + 0.02); sf.Q.value = 4.5;
        sg.gain.setValueAtTime(0.001, t + 0.02);
        sg.gain.linearRampToValueAtTime(0.42, t + 0.06);
        sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
        scrape.connect(sf); sf.connect(sg); sg.connect(out);
        scrape.start(t + 0.02); scrape.stop(t + 0.3);
        voice.nodes.push(scrape);
      }
    } else {
      // Arcade Jackpot Chime: B5 -> E6 with spin shimmer + octave harmonic
      const b5 = this.ctx!.createOscillator();
      const b5g = this.ctx!.createGain();
      b5.type = 'sine';
      b5.frequency.setValueAtTime(987.77, t);
      b5g.gain.setValueAtTime(0.001, t);
      b5g.gain.linearRampToValueAtTime(0.55, t + 0.004);
      b5g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      b5.connect(b5g); b5g.connect(out);
      b5.start(t); b5.stop(t + 0.14);
      voice.nodes.push(b5);

      const te = t + 0.09;
      const e6 = this.ctx!.createOscillator();
      const e6g = this.ctx!.createGain();
      const trem = this.ctx!.createOscillator();
      const tremG = this.ctx!.createGain();
      e6.type = 'sine';
      e6.frequency.setValueAtTime(1318.51, te);
      trem.frequency.setValueAtTime(16.0, te);
      tremG.gain.setValueAtTime(0.2, te);
      trem.connect(tremG);
      e6g.gain.setValueAtTime(0.001, te);
      e6g.gain.linearRampToValueAtTime(0.6, te + 0.004);
      e6g.gain.exponentialRampToValueAtTime(0.0001, te + 0.45);
      e6.connect(e6g); e6g.connect(out);
      trem.start(te); e6.start(te);
      trem.stop(te + 0.48); e6.stop(te + 0.48);
      voice.nodes.push(trem, e6);

      const shim = this.ctx!.createOscillator();
      const shg = this.ctx!.createGain();
      shim.type = 'triangle';
      shim.frequency.setValueAtTime(2637.0, te);
      shg.gain.setValueAtTime(0.001, te);
      shg.gain.linearRampToValueAtTime(0.35, te + 0.004);
      shg.gain.exponentialRampToValueAtTime(0.0001, te + 0.5);
      shim.connect(shg); shg.connect(out);
      shim.start(te); shim.stop(te + 0.52);
      voice.nodes.push(shim);
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 8. MUG TABLE TAP (ceramic ping & thud / double knock / slide & stop)
  // ------------------------------------------------------------------

  playMugTableTap(variantIndex?: number): number {
    return this.mugTap('playMugTableTap', variantIndex);
  }

  playHackerEmptyMug(variantIndex?: number): number {
    return this.mugTap('playHackerEmptyMug', variantIndex);
  }

  private mugTap(key: SfxKey, variant?: number): number {
    const vIdx = this.pickVariant(key, variant);
    const v = this.createVoice({ duration: 0.65 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.05);

    if (vIdx === 0) {
      // Ceramic Ping & Wood Thud + rebound echo ping
      const ping = this.ctx!.createOscillator();
      const g1 = this.ctx!.createGain();
      ping.type = 'triangle';
      ping.frequency.setValueAtTime(1800 * pMod, t);
      ping.frequency.exponentialRampToValueAtTime(450 * pMod, t + 0.085);
      g1.gain.setValueAtTime(0.6, t);
      g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      ping.connect(g1); g1.connect(out);
      ping.start(t); ping.stop(t + 0.095);
      voice.nodes.push(ping);

      const knock = this.ctx!.createOscillator();
      const gk = this.ctx!.createGain();
      knock.type = 'sine';
      knock.frequency.setValueAtTime(160 * pMod, t + 0.015);
      knock.frequency.exponentialRampToValueAtTime(50 * pMod, t + 0.12);
      gk.gain.setValueAtTime(0.62, t + 0.015);
      gk.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      knock.connect(gk); gk.connect(out);
      knock.start(t + 0.015); knock.stop(t + 0.15);
      voice.nodes.push(knock);

      const ping2 = this.ctx!.createOscillator();
      const g2 = this.ctx!.createGain();
      ping2.type = 'sine';
      ping2.frequency.setValueAtTime(720 * pMod, t + 0.14);
      ping2.frequency.exponentialRampToValueAtTime(310 * pMod, t + 0.22);
      g2.gain.setValueAtTime(0.4, t + 0.14);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      ping2.connect(g2); g2.connect(out);
      ping2.start(t + 0.14); ping2.stop(t + 0.26);
      voice.nodes.push(ping2);
    } else if (vIdx === 1) {
      // Double Wood Knock + hollow cavity noise per hit
      [0, 0.12].forEach((kd, ki) => {
        const tk = t + kd;
        const wood = this.ctx!.createOscillator();
        const wg = this.ctx!.createGain();
        wood.type = 'sine';
        wood.frequency.setValueAtTime((220 - ki * 30) * pMod, tk);
        wood.frequency.exponentialRampToValueAtTime(75 * pMod, tk + 0.06);
        wg.gain.setValueAtTime(0.6, tk);
        wg.gain.exponentialRampToValueAtTime(0.0001, tk + 0.07);
        wood.connect(wg); wg.connect(out);
        wood.start(tk); wood.stop(tk + 0.08);
        voice.nodes.push(wood);

        const n = this.getPink();
        if (n) {
          const nf = this.ctx!.createBiquadFilter();
          const ng = this.ctx!.createGain();
          nf.type = 'bandpass'; nf.frequency.setValueAtTime(520 * pMod, tk); nf.Q.value = 4.0;
          ng.gain.setValueAtTime(0.45, tk);
          ng.gain.exponentialRampToValueAtTime(0.0001, tk + 0.04);
          n.connect(nf); nf.connect(ng); ng.connect(out);
          n.start(tk); n.stop(tk + 0.05);
          voice.nodes.push(n);
        }
      });
    } else {
      // Mug Slide & Desk Stop: friction scrape + solid clack/thud
      const scrape = this.getPink();
      if (scrape) {
        const sf = this.ctx!.createBiquadFilter();
        const sg = this.ctx!.createGain();
        sf.type = 'bandpass'; sf.frequency.setValueAtTime(950 * pMod, t); sf.Q.value = 3.0;
        sg.gain.setValueAtTime(0.0001, t);
        sg.gain.linearRampToValueAtTime(0.48, t + 0.05);
        sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        scrape.connect(sf); sf.connect(sg); sg.connect(out);
        scrape.start(t); scrape.stop(t + 0.15);
        voice.nodes.push(scrape);
      }
      const tStop = t + 0.14;
      const clack = this.ctx!.createOscillator();
      const cg = this.ctx!.createGain();
      clack.type = 'triangle';
      clack.frequency.setValueAtTime(2200 * pMod, tStop);
      clack.frequency.exponentialRampToValueAtTime(420 * pMod, tStop + 0.04);
      cg.gain.setValueAtTime(0.6, tStop);
      cg.gain.exponentialRampToValueAtTime(0.0001, tStop + 0.05);
      clack.connect(cg); cg.connect(out);
      clack.start(tStop); clack.stop(tStop + 0.06);
      voice.nodes.push(clack);

      const thud = this.ctx!.createOscillator();
      const tg = this.ctx!.createGain();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(180 * pMod, tStop);
      thud.frequency.exponentialRampToValueAtTime(55 * pMod, tStop + 0.08);
      tg.gain.setValueAtTime(0.58, tStop);
      tg.gain.exponentialRampToValueAtTime(0.0001, tStop + 0.09);
      thud.connect(tg); tg.connect(out);
      thud.start(tStop); thud.stop(tStop + 0.1);
      voice.nodes.push(thud);
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 9. MASCOT BUG HUNTER (saturated laser zaps: blaster / lightning / plasma)
  // ------------------------------------------------------------------

  playMascotBugHunter(variantIndex?: number): number {
    const vIdx = this.pickVariant('playMascotBugHunter', variantIndex);
    const v = this.createVoice({ duration: 0.7 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.06);

    const fireZap = (delay: number, fStart: number, fEnd: number, dur: number, vol = 0.55): void => {
      const t0 = t + delay;
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      const shaper = this.getSaturation();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(fStart * pMod, t0);
      osc.frequency.exponentialRampToValueAtTime(fEnd * pMod, t0 + dur);
      g.gain.setValueAtTime(0.001, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      if (shaper) {
        osc.connect(shaper); shaper.connect(g);
      } else {
        osc.connect(g);
      }
      g.connect(out);
      osc.start(t0); osc.stop(t0 + dur + 0.01);
      voice.nodes.push(osc);
    };

    if (vIdx === 0) {
      // Rapid Pulse Blaster: pew-pew-pew + micro bug sizzle
      fireZap(0, 3800, 380, 0.038, 0.52);
      fireZap(0.055, 4200, 360, 0.038, 0.54);
      fireZap(0.11, 4800, 320, 0.045, 0.58);

      const tSizzle = t + 0.16;
      const sizzle = this.getPink();
      if (sizzle) {
        const f = this.ctx!.createBiquadFilter();
        const g = this.ctx!.createGain();
        f.type = 'bandpass';
        f.frequency.setValueAtTime(3200 * pMod, tSizzle);
        f.frequency.exponentialRampToValueAtTime(1200 * pMod, tSizzle + 0.18);
        f.Q.value = 4.5;
        g.gain.setValueAtTime(0.001, tSizzle);
        g.gain.linearRampToValueAtTime(0.44, tSizzle + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, tSizzle + 0.22);
        sizzle.connect(f); f.connect(g); g.connect(out);
        sizzle.start(tSizzle); sizzle.stop(tSizzle + 0.24);
        voice.nodes.push(sizzle);
      }
    } else if (vIdx === 1) {
      // Lightning Bolt: highpass crack CRACK-bzzz
      const crack = this.getWhite();
      if (crack) {
        const hp = this.ctx!.createBiquadFilter();
        const cg = this.ctx!.createGain();
        hp.type = 'highpass'; hp.frequency.setValueAtTime(3600, t);
        cg.gain.setValueAtTime(0.7, t);
        cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
        crack.connect(hp); hp.connect(cg); cg.connect(out);
        crack.start(t); crack.stop(t + 0.03);
        voice.nodes.push(crack);
      }

      const tArc = t + 0.015;
      const arc = this.ctx!.createOscillator();
      const ag = this.ctx!.createGain();
      const shaper = this.getSaturation();
      arc.type = 'sawtooth';
      arc.frequency.setValueAtTime(180 * pMod, tArc);
      arc.frequency.exponentialRampToValueAtTime(90 * pMod, tArc + 0.22);
      ag.gain.setValueAtTime(0.001, tArc);
      ag.gain.linearRampToValueAtTime(0.62, tArc + 0.02);
      ag.gain.exponentialRampToValueAtTime(0.0001, tArc + 0.24);
      if (shaper) {
        arc.connect(shaper); shaper.connect(ag);
      } else {
        arc.connect(ag);
      }
      ag.connect(out);
      arc.start(tArc); arc.stop(tArc + 0.26);
      voice.nodes.push(arc);
    } else {
      // Heavy Plasma Cannon: sub-kick thud + rising charge + detonation blast
      const kick = this.ctx!.createOscillator();
      const kg = this.ctx!.createGain();
      kick.type = 'sine';
      kick.frequency.setValueAtTime(90 * pMod, t);
      kick.frequency.exponentialRampToValueAtTime(35 * pMod, t + 0.09);
      kg.gain.setValueAtTime(0.68, t);
      kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      kick.connect(kg); kg.connect(out);
      kick.start(t); kick.stop(t + 0.11);
      voice.nodes.push(kick);

      fireZap(0, 220, 4500, 0.07, 0.48);
      fireZap(0.07, 6500, 80, 0.16, 0.7);
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 10. HACKER BUG SLAYER (steel blade foley: slice / cleave / cross slash)
  // ------------------------------------------------------------------

  playHackerBugSlayer(variantIndex?: number): number {
    const vIdx = this.pickVariant('playHackerBugSlayer', variantIndex);
    const v = this.createVoice({ duration: 0.75 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.06);

    if (vIdx === 0) {
      // Razor Steel Slice: SHING-whoosh + steel ring 4.2/8.4 kHz
      const noise = this.getPink();
      if (noise) {
        const vf = this.ctx!.createBiquadFilter();
        const vg = this.ctx!.createGain();
        vf.type = 'bandpass';
        vf.frequency.setValueAtTime(900 * pMod, t);
        vf.frequency.exponentialRampToValueAtTime(3400 * pMod, t + 0.06);
        vf.frequency.exponentialRampToValueAtTime(700 * pMod, t + 0.14);
        vf.Q.value = 3.5;
        vg.gain.setValueAtTime(0.001, t);
        vg.gain.linearRampToValueAtTime(0.6, t + 0.05);
        vg.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
        noise.connect(vf); vf.connect(vg); vg.connect(out);
        noise.start(t); noise.stop(t + 0.16);
        voice.nodes.push(noise);
      }

      const steel = this.ctx!.createOscillator();
      const steelHarm = this.ctx!.createOscillator();
      const sg = this.ctx!.createGain();
      steel.type = 'sine';
      steel.frequency.setValueAtTime(4200 * pMod, t + 0.04);
      steelHarm.type = 'sine';
      steelHarm.frequency.setValueAtTime(8400 * pMod, t + 0.04);
      sg.gain.setValueAtTime(0.001, t + 0.04);
      sg.gain.linearRampToValueAtTime(0.55, t + 0.048);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      steel.connect(sg); steelHarm.connect(sg); sg.connect(out);
      steel.start(t + 0.04); steelHarm.start(t + 0.04);
      steel.stop(t + 0.38); steelHarm.stop(t + 0.38);
      voice.nodes.push(steel, steelHarm);
    } else if (vIdx === 1) {
      // Heavy Broadsword Cleave: WHOOSH then CLANG + body thud
      const noise = this.getPink();
      if (noise) {
        const wf = this.ctx!.createBiquadFilter();
        const wg = this.ctx!.createGain();
        wf.type = 'bandpass';
        wf.frequency.setValueAtTime(300 * pMod, t);
        wf.frequency.exponentialRampToValueAtTime(950 * pMod, t + 0.06);
        wf.Q.value = 2.0;
        wg.gain.setValueAtTime(0.001, t);
        wg.gain.linearRampToValueAtTime(0.62, t + 0.04);
        wg.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
        noise.connect(wf); wf.connect(wg); wg.connect(out);
        noise.start(t); noise.stop(t + 0.12);
        voice.nodes.push(noise);
      }

      const tClang = t + 0.06;
      [1450, 2900].forEach((freq, i) => {
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = i === 0 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freq * pMod, tClang);
        g.gain.setValueAtTime(0.001, tClang);
        g.gain.linearRampToValueAtTime(i === 0 ? 0.65 : 0.45, tClang + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, tClang + 0.42);
        osc.connect(g); g.connect(out);
        osc.start(tClang); osc.stop(tClang + 0.45);
        voice.nodes.push(osc);
      });

      const thud = this.ctx!.createOscillator();
      const tg = this.ctx!.createGain();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(140 * pMod, tClang);
      thud.frequency.exponentialRampToValueAtTime(45 * pMod, tClang + 0.08);
      tg.gain.setValueAtTime(0.6, tClang);
      tg.gain.exponentialRampToValueAtTime(0.0001, tClang + 0.1);
      thud.connect(tg); tg.connect(out);
      thud.start(tClang); thud.stop(tClang + 0.11);
      voice.nodes.push(thud);
    } else {
      // Dual-Strike Cross Slash: shk-shk + pixel shatter burst
      [
        { delay: 0, freq: 2800, dur: 0.08 },
        { delay: 0.11, freq: 4400, dur: 0.1 },
      ].forEach((s) => {
        const ts = t + s.delay;
        const n = this.getPink();
        if (n) {
          const sf = this.ctx!.createBiquadFilter();
          const sg = this.ctx!.createGain();
          sf.type = 'bandpass'; sf.frequency.setValueAtTime(s.freq * pMod, ts); sf.Q.value = 4.0;
          sg.gain.setValueAtTime(0.001, ts);
          sg.gain.linearRampToValueAtTime(0.56, ts + 0.02);
          sg.gain.exponentialRampToValueAtTime(0.0001, ts + s.dur);
          n.connect(sf); sf.connect(sg); sg.connect(out);
          n.start(ts); n.stop(ts + s.dur + 0.01);
          voice.nodes.push(n);
        }
      });

      const tPop = t + 0.2;
      const pop = this.ctx!.createOscillator();
      const pg = this.ctx!.createGain();
      pop.type = 'square';
      pop.frequency.setValueAtTime(580 * pMod, tPop);
      pop.frequency.exponentialRampToValueAtTime(80 * pMod, tPop + 0.12);
      pg.gain.setValueAtTime(0.55, tPop);
      pg.gain.exponentialRampToValueAtTime(0.0001, tPop + 0.14);
      pop.connect(pg); pg.connect(out);
      pop.start(tPop); pop.stop(tPop + 0.15);
      voice.nodes.push(pop);
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 11. LOW BATTERY (powerdown fall / alert beeps / engine sputter)
  // ------------------------------------------------------------------

  playMascotLowBattery(variantIndex?: number): number {
    const vIdx = this.pickVariant('playMascotLowBattery', variantIndex);
    const v = this.createVoice({ duration: 1.1 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.06);

    if (vIdx === 0) {
      // Powerdown Pitch Fall: 800->30 Hz with decelerating LFO + relay click
      const osc = this.ctx!.createOscillator();
      const lfo = this.ctx!.createOscillator();
      const lg = this.ctx!.createGain();
      const g = this.ctx!.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(800 * pMod, t);
      osc.frequency.exponentialRampToValueAtTime(30 * pMod, t + 0.85);
      lfo.frequency.setValueAtTime(16.0, t);
      lfo.frequency.linearRampToValueAtTime(2.0, t + 0.85);
      lg.gain.setValueAtTime(45 * pMod, t);
      lg.gain.linearRampToValueAtTime(6 * pMod, t + 0.85);
      lfo.connect(osc.frequency);
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.58, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.88);
      osc.connect(g); g.connect(out);
      lfo.start(t); osc.start(t);
      lfo.stop(t + 0.9); osc.stop(t + 0.9);
      voice.nodes.push(lfo, osc);

      const click = this.ctx!.createOscillator();
      const cg = this.ctx!.createGain();
      click.type = 'square';
      click.frequency.setValueAtTime(400 * pMod, t + 0.85);
      click.frequency.exponentialRampToValueAtTime(40 * pMod, t + 0.865);
      cg.gain.setValueAtTime(0.5, t + 0.85);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.87);
      click.connect(cg); cg.connect(out);
      click.start(t + 0.85); click.stop(t + 0.88);
      voice.nodes.push(click);
    } else if (vIdx === 1) {
      // Emergency Alert Beeps: 3 descending two-tone saw alarms + static burst
      const beeps: ReadonlyArray<{ f0: number; f1: number; delay: number; dur: number }> = [
        { f0: 1760.0, f1: 1174.66, delay: 0, dur: 0.075 },
        { f0: 1568.0, f1: 1046.5, delay: 0.115, dur: 0.075 },
        { f0: 1396.91, f1: 932.33, delay: 0.23, dur: 0.085 },
      ];
      beeps.forEach((b) => {
        const tb = t + b.delay;
        const osc = this.ctx!.createOscillator();
        const bg = this.ctx!.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(b.f0 * pMod, tb);
        osc.frequency.setValueAtTime(b.f1 * pMod, tb + b.dur * 0.5);
        bg.gain.setValueAtTime(0.001, tb);
        bg.gain.linearRampToValueAtTime(0.54, tb + 0.004);
        bg.gain.exponentialRampToValueAtTime(0.0001, tb + b.dur);
        osc.connect(bg); bg.connect(out);
        osc.start(tb); osc.stop(tb + b.dur + 0.01);
        voice.nodes.push(osc);
      });

      const tGlitch = t + 0.34;
      const noise = this.getPink();
      if (noise) {
        const gf = this.ctx!.createBiquadFilter();
        const gg = this.ctx!.createGain();
        gf.type = 'bandpass'; gf.frequency.setValueAtTime(2200 * pMod, tGlitch); gf.Q.value = 3.5;
        gg.gain.setValueAtTime(0.48, tGlitch);
        gg.gain.exponentialRampToValueAtTime(0.0001, tGlitch + 0.12);
        noise.connect(gf); gf.connect(gg); gg.connect(out);
        noise.start(tGlitch); noise.stop(tGlitch + 0.14);
        voice.nodes.push(noise);
      }
    } else {
      // Engine Sputter: dying chuffs + spark ticks + power-cut pop
      [0, 0.08, 0.18, 0.31, 0.46].forEach((cd, ci) => {
        const tc = this.schedAt(t + cd + (Math.random() - 0.5) * 0.01);
        const cOsc = this.ctx!.createOscillator();
        const cg = this.ctx!.createGain();
        cOsc.type = 'triangle';
        cOsc.frequency.setValueAtTime((110 - ci * 14) * pMod, tc);
        cOsc.frequency.exponentialRampToValueAtTime(45 * pMod, tc + 0.05);
        cg.gain.setValueAtTime(0.55, tc);
        cg.gain.exponentialRampToValueAtTime(0.0001, tc + 0.06);
        cOsc.connect(cg); cg.connect(out);
        cOsc.start(tc); cOsc.stop(tc + 0.07);
        voice.nodes.push(cOsc);

        const spark = this.getWhite();
        if (spark) {
          const sf = this.ctx!.createBiquadFilter();
          const sg = this.ctx!.createGain();
          sf.type = 'highpass'; sf.frequency.setValueAtTime(4500, tc);
          sg.gain.setValueAtTime(0.46, tc);
          sg.gain.exponentialRampToValueAtTime(0.0001, tc + 0.025);
          spark.connect(sf); sf.connect(sg); sg.connect(out);
          spark.start(tc); spark.stop(tc + 0.03);
          voice.nodes.push(spark);
        }
      });

      const tPop = t + 0.56;
      const pop = this.ctx!.createOscillator();
      const pg = this.ctx!.createGain();
      pop.type = 'sine';
      pop.frequency.setValueAtTime(120 * pMod, tPop);
      pop.frequency.exponentialRampToValueAtTime(35 * pMod, tPop + 0.03);
      pg.gain.setValueAtTime(0.5, tPop);
      pg.gain.exponentialRampToValueAtTime(0.0001, tPop + 0.04);
      pop.connect(pg); pg.connect(out);
      pop.start(tPop); pop.stop(tPop + 0.05);
      voice.nodes.push(pop);
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 12. TURBINE (jet spool-up / plasma arc hum / pulsing core heartbeat)
  // ------------------------------------------------------------------

  playMascotTurbine(variantIndex?: number): number {
    const vIdx = this.pickVariant('playMascotTurbine', variantIndex);
    const v = this.createVoice({ duration: 0.95 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.05);

    if (vIdx === 0) {
      // Jet Engine Spool-Up: 300 Hz -> 3.8 kHz saw + pink-noise jet roar
      const spool = this.ctx!.createOscillator();
      const sg = this.ctx!.createGain();
      spool.type = 'sawtooth';
      spool.frequency.setValueAtTime(300 * pMod, t);
      spool.frequency.exponentialRampToValueAtTime(3800 * pMod, t + 0.55);
      sg.gain.setValueAtTime(0.001, t);
      sg.gain.linearRampToValueAtTime(0.54, t + 0.08);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      spool.connect(sg); sg.connect(out);
      spool.start(t); spool.stop(t + 0.72);
      voice.nodes.push(spool);

      const roar = this.getPink();
      if (roar) {
        const rf = this.ctx!.createBiquadFilter();
        const rg = this.ctx!.createGain();
        rf.type = 'bandpass';
        rf.frequency.setValueAtTime(500 * pMod, t);
        rf.frequency.exponentialRampToValueAtTime(4200 * pMod, t + 0.55);
        rf.Q.value = 4.5;
        rg.gain.setValueAtTime(0.0001, t);
        rg.gain.linearRampToValueAtTime(0.52, t + 0.1);
        rg.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
        roar.connect(rf); rf.connect(rg); rg.connect(out);
        roar.start(t); roar.stop(t + 0.78);
        voice.nodes.push(roar);
      }
    } else if (vIdx === 1) {
      // Plasma Arc Transformer: 60/120 Hz hum + sputtering high-voltage arcs
      const hum1 = this.ctx!.createOscillator();
      const hum2 = this.ctx!.createOscillator();
      const hg = this.ctx!.createGain();
      hum1.type = 'sawtooth';
      hum1.frequency.setValueAtTime(60.0, t);
      hum2.type = 'sine';
      hum2.frequency.setValueAtTime(120.0, t);
      hg.gain.setValueAtTime(0.001, t);
      hg.gain.linearRampToValueAtTime(0.58, t + 0.05);
      hg.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
      hum1.connect(hg); hum2.connect(hg); hg.connect(out);
      hum1.start(t); hum2.start(t);
      hum1.stop(t + 0.78); hum2.stop(t + 0.78);
      voice.nodes.push(hum1, hum2);

      [0.06, 0.16, 0.28, 0.42].forEach((ad) => {
        const ta = t + ad;
        const arc = this.getWhite();
        if (arc) {
          const af = this.ctx!.createBiquadFilter();
          const ag = this.ctx!.createGain();
          const shaper = this.getSaturation();
          af.type = 'highpass'; af.frequency.setValueAtTime(4000, ta);
          ag.gain.setValueAtTime(0.55, ta);
          ag.gain.exponentialRampToValueAtTime(0.0001, ta + 0.045);
          if (shaper) {
            arc.connect(af); af.connect(shaper); shaper.connect(ag);
          } else {
            arc.connect(af); af.connect(ag);
          }
          ag.connect(out);
          arc.start(ta); arc.stop(ta + 0.05);
          voice.nodes.push(arc);
        }
      });
    } else {
      // Pulsing Core Heartbeat: detuned saw pulses through resonant lowpass
      [0, 0.22, 0.44].forEach((pd) => {
        const tp = t + pd;
        const o1 = this.ctx!.createOscillator();
        const o2 = this.ctx!.createOscillator();
        const filter = this.ctx!.createBiquadFilter();
        const pg = this.ctx!.createGain();
        o1.type = 'sawtooth';
        o1.frequency.setValueAtTime(54 * pMod, tp);
        o2.type = 'sawtooth';
        o2.frequency.setValueAtTime(57 * pMod, tp);
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(80 * pMod, tp);
        filter.frequency.exponentialRampToValueAtTime(650 * pMod, tp + 0.06);
        filter.frequency.exponentialRampToValueAtTime(90 * pMod, tp + 0.18);
        filter.Q.value = 6.0;
        pg.gain.setValueAtTime(0.001, tp);
        pg.gain.linearRampToValueAtTime(0.65, tp + 0.03);
        pg.gain.exponentialRampToValueAtTime(0.0001, tp + 0.2);
        o1.connect(filter); o2.connect(filter); filter.connect(pg); pg.connect(out);
        o1.start(tp); o2.start(tp);
        o1.stop(tp + 0.22); o2.stop(tp + 0.22);
        voice.nodes.push(o1, o2);
      });
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 13. SENSOR POLISH (squeegee FM squeak+ding / cloth wipes / laser calib)
  // ------------------------------------------------------------------

  playMascotSensorPolish(variantIndex?: number): number {
    const vIdx = this.pickVariant('playMascotSensorPolish', variantIndex);
    const v = this.createVoice({ duration: 0.7 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.04);

    if (vIdx === 0) {
      // Rubber Squeegee: FM squeak glide + crystal clean ding at t+0.22 s
      const squeak = this.ctx!.createOscillator();
      const sMod = this.ctx!.createOscillator();
      const sModG = this.ctx!.createGain();
      const sg = this.ctx!.createGain();
      squeak.type = 'sine';
      squeak.frequency.setValueAtTime(1100 * pMod, t);
      squeak.frequency.exponentialRampToValueAtTime(2600 * pMod, t + 0.08);
      squeak.frequency.exponentialRampToValueAtTime(1750 * pMod, t + 0.18);
      sMod.frequency.setValueAtTime(130, t);
      sModG.gain.setValueAtTime(320, t);
      sModG.gain.exponentialRampToValueAtTime(10, t + 0.18);
      sMod.connect(squeak.frequency);
      sg.gain.setValueAtTime(0.001, t);
      sg.gain.linearRampToValueAtTime(0.56, t + 0.02);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      squeak.connect(sg); sg.connect(out);
      sMod.start(t); squeak.start(t);
      sMod.stop(t + 0.22); squeak.stop(t + 0.22);
      voice.nodes.push(sMod, squeak);

      const tDing = t + 0.22;
      const ding = this.ctx!.createOscillator();
      const dg = this.ctx!.createGain();
      ding.type = 'sine';
      ding.frequency.setValueAtTime(3520.0 * pMod, tDing);
      dg.gain.setValueAtTime(0.001, tDing);
      dg.gain.linearRampToValueAtTime(0.55, tDing + 0.003);
      dg.gain.exponentialRampToValueAtTime(0.0001, tDing + 0.38);
      ding.connect(dg); dg.connect(out);
      ding.start(tDing); ding.stop(tDing + 0.4);
      voice.nodes.push(ding);

      const overtone = this.ctx!.createOscillator();
      const og = this.ctx!.createGain();
      overtone.type = 'sine';
      overtone.frequency.setValueAtTime(7040.0 * pMod, tDing);
      og.gain.setValueAtTime(0.001, tDing);
      og.gain.linearRampToValueAtTime(0.28, tDing + 0.003);
      og.gain.exponentialRampToValueAtTime(0.0001, tDing + 0.25);
      overtone.connect(og); og.connect(out);
      overtone.start(tDing); overtone.stop(tDing + 0.28);
      voice.nodes.push(overtone);
    } else if (vIdx === 1) {
      // Microfiber Cloth: 3 dry friction wipes shhk-shhk-shhk
      [0, 0.11, 0.23].forEach((wo) => {
        const tw = t + wo;
        const n = this.getPink();
        if (n) {
          const bp = this.ctx!.createBiquadFilter();
          const hp = this.ctx!.createBiquadFilter();
          const wg = this.ctx!.createGain();
          bp.type = 'bandpass'; bp.frequency.setValueAtTime(3600 * pMod, tw); bp.Q.value = 3.2;
          hp.type = 'highpass'; hp.frequency.setValueAtTime(2400 * pMod, tw);
          wg.gain.setValueAtTime(0.001, tw);
          wg.gain.linearRampToValueAtTime(0.52, tw + 0.02);
          wg.gain.exponentialRampToValueAtTime(0.0001, tw + 0.08);
          n.connect(bp); bp.connect(hp); hp.connect(wg); wg.connect(out);
          n.start(tw); n.stop(tw + 0.09);
          voice.nodes.push(n);
        }
      });
    } else {
      // Laser Calibration: stepper steps 400/520/640/800 Hz + sweep ping
      const stepFreqs = [400, 520, 640, 800];
      [0, 0.03, 0.06, 0.09].forEach((sd, si) => {
        const ts = t + sd;
        const osc = this.ctx!.createOscillator();
        const sg = this.ctx!.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(stepFreqs[si], ts);
        sg.gain.setValueAtTime(0.48, ts);
        sg.gain.exponentialRampToValueAtTime(0.0001, ts + 0.012);
        osc.connect(sg); sg.connect(out);
        osc.start(ts); osc.stop(ts + 0.015);
        voice.nodes.push(osc);
      });

      const tLaser = t + 0.13;
      const laser = this.ctx!.createOscillator();
      const lg = this.ctx!.createGain();
      laser.type = 'sine';
      laser.frequency.setValueAtTime(800 * pMod, tLaser);
      laser.frequency.exponentialRampToValueAtTime(4800 * pMod, tLaser + 0.12);
      lg.gain.setValueAtTime(0.001, tLaser);
      lg.gain.linearRampToValueAtTime(0.56, tLaser + 0.006);
      lg.gain.exponentialRampToValueAtTime(0.0001, tLaser + 0.35);
      laser.connect(lg); lg.connect(out);
      laser.start(tLaser); laser.stop(tLaser + 0.38);
      voice.nodes.push(laser);
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 14. NANO COFFEE (steam & drip / gulp & putdown / crema sizzle)
  // ------------------------------------------------------------------

  playMascotNanoCoffee(variantIndex?: number): number {
    const vIdx = this.pickVariant('playMascotNanoCoffee', variantIndex);
    const v = this.createVoice({ duration: 0.9 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.04);

    if (vIdx === 0) {
      // Steam & Drip: espresso hiss + 3 Minnaert-style liquid drops + cavity ring
      const steam = this.getPink();
      if (steam) {
        const bp = this.ctx!.createBiquadFilter();
        const hp = this.ctx!.createBiquadFilter();
        const sg = this.ctx!.createGain();
        bp.type = 'bandpass'; bp.frequency.setValueAtTime(3400 * pMod, t); bp.Q.value = 3.0;
        hp.type = 'highpass'; hp.frequency.setValueAtTime(5500 * pMod, t);
        sg.gain.setValueAtTime(0.0001, t);
        sg.gain.linearRampToValueAtTime(0.55, t + 0.04);
        sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
        steam.connect(bp); bp.connect(hp); hp.connect(sg); sg.connect(out);
        steam.start(t); steam.stop(t + 0.35);
        voice.nodes.push(steam);
      }

      const drops: ReadonlyArray<{ delay: number; f0: number; f1: number; dur: number; vol: number }> = [
        { delay: 0.28, f0: 820, f1: 1480, dur: 0.032, vol: 0.54 },
        { delay: 0.42, f0: 1080, f1: 1920, dur: 0.026, vol: 0.5 },
        { delay: 0.56, f0: 620, f1: 1180, dur: 0.042, vol: 0.58 },
      ];
      let lastDelay = 0;
      drops.forEach((d) => {
        const td = t + d.delay;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(d.f0 * pMod, td);
        osc.frequency.exponentialRampToValueAtTime(d.f1 * pMod, td + d.dur);
        g.gain.setValueAtTime(d.vol, td);
        g.gain.exponentialRampToValueAtTime(0.0001, td + d.dur + 0.004);
        osc.connect(g); g.connect(out);
        osc.start(td); osc.stop(td + d.dur + 0.01);
        voice.nodes.push(osc);
        lastDelay = d.delay;
      });

      // Cup liquid cavity ring after the final drop
      const tCav = t + lastDelay;
      const cav = this.ctx!.createOscillator();
      const cg = this.ctx!.createGain();
      cav.type = 'sine';
      cav.frequency.setValueAtTime(380 * pMod, tCav);
      cg.gain.setValueAtTime(0.35, tCav);
      cg.gain.exponentialRampToValueAtTime(0.0001, tCav + 0.08);
      cav.connect(cg); cg.connect(out);
      cav.start(tCav); cav.stop(tCav + 0.09);
      voice.nodes.push(cav);
    } else if (vIdx === 1) {
      // Gulp & Mug Putdown: suction sip -> throat gulp -> ahhh breath -> mug clack-thud
      const sip = this.getPink();
      if (sip) {
        const sf = this.ctx!.createBiquadFilter();
        const sgn = this.ctx!.createGain();
        sf.type = 'bandpass';
        sf.frequency.setValueAtTime(450 * pMod, t);
        sf.frequency.exponentialRampToValueAtTime(1450 * pMod, t + 0.26);
        sf.Q.value = 4.5;
        sgn.gain.setValueAtTime(0.0001, t);
        sgn.gain.linearRampToValueAtTime(0.52, t + 0.12);
        sgn.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
        sip.connect(sf); sf.connect(sgn); sgn.connect(out);
        sip.start(t); sip.stop(t + 0.3);
        voice.nodes.push(sip);
      }

      const tGulp = t + 0.26;
      const gulp = this.ctx!.createOscillator();
      const gg = this.ctx!.createGain();
      gulp.type = 'sine';
      gulp.frequency.setValueAtTime(240 * pMod, tGulp);
      gulp.frequency.exponentialRampToValueAtTime(85 * pMod, tGulp + 0.05);
      gg.gain.setValueAtTime(0.48, tGulp);
      gg.gain.exponentialRampToValueAtTime(0.0001, tGulp + 0.055);
      gulp.connect(gg); gg.connect(out);
      gulp.start(tGulp); gulp.stop(tGulp + 0.065);
      voice.nodes.push(gulp);

      const tAh = t + 0.3;
      const ah = this.getPink();
      if (ah) {
        const af = this.ctx!.createBiquadFilter();
        const ag = this.ctx!.createGain();
        af.type = 'lowpass'; af.frequency.setValueAtTime(580 * pMod, tAh);
        ag.gain.setValueAtTime(0.0001, tAh);
        ag.gain.linearRampToValueAtTime(0.32, tAh + 0.04);
        ag.gain.exponentialRampToValueAtTime(0.0001, tAh + 0.14);
        ah.connect(af); af.connect(ag); ag.connect(out);
        ah.start(tAh); ah.stop(tAh + 0.16);
        voice.nodes.push(ah);
      }

      const tMug = t + 0.46;
      const clk = this.getPink();
      if (clk) {
        const cf = this.ctx!.createBiquadFilter();
        const cgr = this.ctx!.createGain();
        cf.type = 'bandpass'; cf.frequency.setValueAtTime(2800 * pMod, tMug); cf.Q.value = 5.0;
        cgr.gain.setValueAtTime(0.6, tMug);
        cgr.gain.exponentialRampToValueAtTime(0.0001, tMug + 0.01);
        clk.connect(cf); cf.connect(cgr); cgr.connect(out);
        clk.start(tMug); clk.stop(tMug + 0.015);
        voice.nodes.push(clk);
      }

      const ring = this.ctx!.createOscillator();
      const rg = this.ctx!.createGain();
      ring.type = 'sine';
      ring.frequency.setValueAtTime(1820 * pMod, tMug);
      rg.gain.setValueAtTime(0.4, tMug);
      rg.gain.exponentialRampToValueAtTime(0.0001, tMug + 0.1);
      ring.connect(rg); rg.connect(out);
      ring.start(tMug); ring.stop(tMug + 0.12);
      voice.nodes.push(ring);

      const thud = this.ctx!.createOscillator();
      const tg = this.ctx!.createGain();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(160 * pMod, tMug);
      thud.frequency.exponentialRampToValueAtTime(52 * pMod, tMug + 0.07);
      tg.gain.setValueAtTime(0.65, tMug);
      tg.gain.exponentialRampToValueAtTime(0.0001, tMug + 0.08);
      thud.connect(tg); tg.connect(out);
      thud.start(tMug); thud.stop(tMug + 0.09);
      voice.nodes.push(thud);
    } else {
      // Frothing Crema: churning dual-bandpass sizzle with LFO wobble + micro pops
      const froth = this.getPink();
      if (froth) {
        const bp1 = this.ctx!.createBiquadFilter();
        const bp2 = this.ctx!.createBiquadFilter();
        const fg = this.ctx!.createGain();
        const lfo = this.ctx!.createOscillator();
        const lfoG = this.ctx!.createGain();
        bp1.type = 'bandpass'; bp1.frequency.setValueAtTime(2200 * pMod, t); bp1.Q.value = 3.2;
        bp2.type = 'bandpass'; bp2.frequency.setValueAtTime(4800 * pMod, t); bp2.Q.value = 4.2;
        lfo.frequency.setValueAtTime(34.0, t);
        lfoG.gain.setValueAtTime(400, t);
        lfo.connect(bp1.frequency);
        fg.gain.setValueAtTime(0.0001, t);
        fg.gain.linearRampToValueAtTime(0.54, t + 0.08);
        fg.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
        froth.connect(bp1); bp1.connect(bp2); bp2.connect(fg); fg.connect(out);
        lfo.start(t); froth.start(t);
        lfo.stop(t + 0.58); froth.stop(t + 0.58);
        voice.nodes.push(lfo, froth);
      }

      const popDelays = [0.07, 0.15, 0.23, 0.32, 0.42, 0.5];
      const popFreqs = [1600, 2400, 1850, 2900, 2100, 2700];
      popDelays.forEach((pd, pi) => {
        const tp = t + pd;
        const osc = this.ctx!.createOscillator();
        const pg = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(popFreqs[pi] * pMod, tp);
        osc.frequency.exponentialRampToValueAtTime(popFreqs[pi] * 1.35 * pMod, tp + 0.016);
        pg.gain.setValueAtTime(0.48, tp);
        pg.gain.exponentialRampToValueAtTime(0.0001, tp + 0.018);
        osc.connect(pg); pg.connect(out);
        osc.start(tp); osc.stop(tp + 0.025);
        voice.nodes.push(osc);
      });
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 16. ZERO ERRORS (NES fanfare / crowd cheer / level-up jingle)
  // ------------------------------------------------------------------

  playHackerZeroErrors(variantIndex?: number): number {
    const vIdx = this.pickVariant('playHackerZeroErrors', variantIndex);
    const v = this.createVoice({ duration: 0.9 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.02);

    if (vIdx === 0) {
      // NES 8-Bit Fanfare: C-E-G-C square arpeggio + vibrato on final note
      const melody: ReadonlyArray<{ freq: number; delay: number; dur: number }> = [
        { freq: 523.25, delay: 0, dur: 0.075 },
        { freq: 659.25, delay: 0.075, dur: 0.075 },
        { freq: 783.99, delay: 0.15, dur: 0.075 },
        { freq: 1046.5, delay: 0.225, dur: 0.4 },
      ];
      melody.forEach((m, idx) => {
        const tn = t + m.delay;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(m.freq * pMod, tn);
        if (idx === 3) {
          const vib = this.ctx!.createOscillator();
          const vibG = this.ctx!.createGain();
          vib.frequency.setValueAtTime(14.0, tn);
          vibG.gain.setValueAtTime(16.0, tn);
          vib.connect(osc.frequency);
          vib.start(tn); vib.stop(tn + m.dur);
          voice.nodes.push(vib);
        }
        g.gain.setValueAtTime(0.001, tn);
        g.gain.linearRampToValueAtTime(0.52, tn + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, tn + m.dur);
        osc.connect(g); g.connect(out);
        osc.start(tn); osc.stop(tn + m.dur + 0.01);
        voice.nodes.push(osc);
      });
    } else if (vIdx === 1) {
      // Synthesized Crowd Cheer: triple bandpass noise roar + celebratory whistle
      const cheer = this.getPink();
      if (cheer) {
        const bp1 = this.ctx!.createBiquadFilter();
        const bp2 = this.ctx!.createBiquadFilter();
        const bp3 = this.ctx!.createBiquadFilter();
        const cg = this.ctx!.createGain();
        bp1.type = 'bandpass'; bp1.frequency.setValueAtTime(800, t); bp1.Q.value = 2.5;
        bp2.type = 'bandpass'; bp2.frequency.setValueAtTime(1600, t); bp2.Q.value = 3.0;
        bp3.type = 'bandpass'; bp3.frequency.setValueAtTime(2800, t); bp3.Q.value = 3.5;
        cg.gain.setValueAtTime(0.0001, t);
        cg.gain.linearRampToValueAtTime(0.6, t + 0.2);
        cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
        cheer.connect(bp1); bp1.connect(bp2); bp2.connect(bp3); bp3.connect(cg); cg.connect(out);
        cheer.start(t); cheer.stop(t + 0.85);
        voice.nodes.push(cheer);
      }

      const whistle = this.ctx!.createOscillator();
      const wg = this.ctx!.createGain();
      whistle.type = 'sine';
      whistle.frequency.setValueAtTime(2200, t + 0.12);
      whistle.frequency.exponentialRampToValueAtTime(2800, t + 0.35);
      wg.gain.setValueAtTime(0.001, t + 0.12);
      wg.gain.linearRampToValueAtTime(0.42, t + 0.16);
      wg.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      whistle.connect(wg); wg.connect(out);
      whistle.start(t + 0.12); whistle.stop(t + 0.48);
      voice.nodes.push(whistle);
    } else {
      // Level-Up Jingle: sparkling star arpeggio cascade E5..B6
      const starNotes: ReadonlyArray<{ freq: number; delay: number }> = [
        { freq: 659.25, delay: 0 },
        { freq: 830.61, delay: 0.04 },
        { freq: 987.77, delay: 0.08 },
        { freq: 1318.51, delay: 0.12 },
        { freq: 1661.22, delay: 0.16 },
        { freq: 1975.53, delay: 0.2 },
      ];
      starNotes.forEach((n, idx) => {
        const tn = t + n.delay;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(n.freq, tn);
        const dur = idx === starNotes.length - 1 ? 0.38 : 0.1;
        g.gain.setValueAtTime(0.001, tn);
        g.gain.linearRampToValueAtTime(0.55, tn + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, tn + dur);
        osc.connect(g); g.connect(out);
        osc.start(tn); osc.stop(tn + dur + 0.02);
        voice.nodes.push(osc);
      });
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 19. HACKER FLOWCHART (relay clicks / matrix bus / logic toggle)
  // ------------------------------------------------------------------

  playHackerFlowchart(variantIndex?: number): number {
    const vIdx = this.pickVariant('playHackerFlowchart', variantIndex);
    const v = this.createVoice({ duration: 0.5 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.04);

    if (vIdx === 0) {
      // Digital Relay Clicks: 3 electromagnetic clicks
      [1200, 1600, 2000].forEach((freq, i) => {
        const tc = t + i * 0.075;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(freq * pMod, tc);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.35 * pMod, tc + 0.015);
        g.gain.setValueAtTime(0.55, tc);
        g.gain.exponentialRampToValueAtTime(0.0001, tc + 0.025);
        osc.connect(g); g.connect(out);
        osc.start(tc); osc.stop(tc + 0.03);
        voice.nodes.push(osc);
      });
    } else if (vIdx === 1) {
      // Matrix Bus Routing: 5-step rapid clock data stream
      [2400, 2800, 3200, 3800, 4500].forEach((freq, i) => {
        const tb = t + i * 0.025;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq * pMod, tb);
        g.gain.setValueAtTime(0.001, tb);
        g.gain.linearRampToValueAtTime(0.5, tb + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, tb + 0.02);
        osc.connect(g); g.connect(out);
        osc.start(tb); osc.stop(tb + 0.025);
        voice.nodes.push(osc);
      });
    } else {
      // Logic Gate Toggle: flip-flop octave chirp + transient tick
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440.0 * pMod, t);
      osc.frequency.setValueAtTime(880.0 * pMod, t + 0.04);
      osc.frequency.setValueAtTime(1760.0 * pMod, t + 0.08);
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.58, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(g); g.connect(out);
      osc.start(t); osc.stop(t + 0.25);
      voice.nodes.push(osc);

      const tick = this.ctx!.createOscillator();
      const tg = this.ctx!.createGain();
      tick.type = 'square';
      tick.frequency.setValueAtTime(3500 * pMod, t);
      tg.gain.setValueAtTime(0.45, t);
      tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
      tick.connect(tg); tg.connect(out);
      tick.start(t); tick.stop(t + 0.015);
      voice.nodes.push(tick);
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 21. ASCENSION RITUAL (quantum chord / infrasound sweep / grand fanfare)
  // ------------------------------------------------------------------

  playAscensionRitual(variantIndex?: number): number {
    const vIdx = this.pickVariant('playAscensionRitual', variantIndex);
    const v = this.createVoice({ duration: 2.4 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.01);

    if (vIdx === 0) {
      // F# Major Quantum Chord: sub-bass fall + crystal chord + shimmer bell
      const sub = this.ctx!.createOscillator();
      const subG = this.ctx!.createGain();
      const subF = this.ctx!.createBiquadFilter();
      sub.type = 'sawtooth';
      sub.frequency.setValueAtTime(80 * pMod, t);
      sub.frequency.exponentialRampToValueAtTime(32 * pMod, t + 0.95);
      subF.type = 'lowpass';
      subF.frequency.setValueAtTime(180, t);
      subF.frequency.exponentialRampToValueAtTime(45, t + 0.95);
      subG.gain.setValueAtTime(0.001, t);
      subG.gain.linearRampToValueAtTime(0.58, t + 0.04);
      subG.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
      sub.connect(subF); subF.connect(subG); subG.connect(out);
      sub.start(t); sub.stop(t + 1.0);
      voice.nodes.push(sub);

      const chordNotes: ReadonlyArray<{ freq: number; delay: number; dur: number }> = [
        { freq: 369.99, delay: 0.1, dur: 1.4 },
        { freq: 466.16, delay: 0.18, dur: 1.5 },
        { freq: 554.37, delay: 0.26, dur: 1.6 },
        { freq: 739.99, delay: 0.34, dur: 1.8 },
      ];
      chordNotes.forEach((note) => {
        const tn = t + note.delay;
        const o1 = this.ctx!.createOscillator();
        const o2 = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        o1.type = 'sine';
        o1.frequency.setValueAtTime(note.freq * pMod, tn);
        o2.type = 'triangle';
        o2.frequency.setValueAtTime(note.freq * 1.0025 * pMod, tn);
        g.gain.setValueAtTime(0.001, tn);
        g.gain.linearRampToValueAtTime(0.48, tn + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, tn + note.dur);
        o1.connect(g); o2.connect(g); g.connect(out);
        o1.start(tn); o2.start(tn);
        o1.stop(tn + note.dur + 0.05); o2.stop(tn + note.dur + 0.05);
        voice.nodes.push(o1, o2);
      });

      const shimmer = this.ctx!.createOscillator();
      const shG = this.ctx!.createGain();
      shimmer.type = 'sine';
      shimmer.frequency.setValueAtTime(2217.46 * pMod, t + 0.38);
      shG.gain.setValueAtTime(0.001, t + 0.38);
      shG.gain.linearRampToValueAtTime(0.42, t + 0.42);
      shG.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
      shimmer.connect(shG); shG.connect(out);
      shimmer.start(t + 0.38); shimmer.stop(t + 1.65);
      voice.nodes.push(shimmer);
    } else if (vIdx === 1) {
      // Singularity Infrasound Sweep: gravity sweep + celestial overtone rise
      const grav = this.ctx!.createOscillator();
      const gg = this.ctx!.createGain();
      const gf = this.ctx!.createBiquadFilter();
      grav.type = 'sawtooth';
      grav.frequency.setValueAtTime(120 * pMod, t);
      grav.frequency.exponentialRampToValueAtTime(28 * pMod, t + 1.4);
      gf.type = 'lowpass';
      gf.frequency.setValueAtTime(200, t);
      gf.frequency.exponentialRampToValueAtTime(40, t + 1.4);
      gg.gain.setValueAtTime(0.001, t);
      gg.gain.linearRampToValueAtTime(0.65, t + 0.08);
      gg.gain.exponentialRampToValueAtTime(0.0001, t + 1.45);
      grav.connect(gf); gf.connect(gg); gg.connect(out);
      grav.start(t); grav.stop(t + 1.5);
      voice.nodes.push(grav);

      const sweep = this.ctx!.createOscillator();
      const swg = this.ctx!.createGain();
      sweep.type = 'sine';
      sweep.frequency.setValueAtTime(1000 * pMod, t + 0.15);
      sweep.frequency.exponentialRampToValueAtTime(6000 * pMod, t + 1.1);
      swg.gain.setValueAtTime(0.001, t + 0.15);
      swg.gain.linearRampToValueAtTime(0.48, t + 0.35);
      swg.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
      sweep.connect(swg); swg.connect(out);
      sweep.start(t + 0.15); sweep.stop(t + 1.35);
      voice.nodes.push(sweep);
    } else {
      // Grand Architect Fanfare: majestic brass synth chords in F#
      const brassChords: ReadonlyArray<{ freqs: readonly number[]; delay: number; dur: number }> = [
        { freqs: [369.99, 466.16, 554.37], delay: 0, dur: 0.28 },
        { freqs: [493.88, 622.25, 739.99], delay: 0.26, dur: 0.28 },
        { freqs: [554.37, 698.46, 830.61], delay: 0.52, dur: 0.3 },
        { freqs: [739.99, 932.33, 1108.73], delay: 0.8, dur: 0.85 },
      ];
      brassChords.forEach((c) => {
        const tc = t + c.delay;
        c.freqs.forEach((f) => {
          const osc = this.ctx!.createOscillator();
          const g = this.ctx!.createGain();
          const bf = this.ctx!.createBiquadFilter();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(f * pMod, tc);
          bf.type = 'lowpass';
          bf.frequency.setValueAtTime(1800 * pMod, tc);
          bf.Q.value = 2.0;
          g.gain.setValueAtTime(0.001, tc);
          g.gain.linearRampToValueAtTime(0.42 / c.freqs.length, tc + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, tc + c.dur);
          osc.connect(bf); bf.connect(g); g.connect(out);
          osc.start(tc); osc.stop(tc + c.dur + 0.02);
          voice.nodes.push(osc);
        });
      });
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 22. ACTION CHEER (latch+bell / triple cash / jackpot confetti)
  // ------------------------------------------------------------------

  playActionCheer(variantIndex?: number): number {
    const vIdx = this.pickVariant('playActionCheer', variantIndex);
    const v = this.createVoice({ duration: 0.7 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.03);

    if (vIdx === 0) {
      // Spring Latch Snap + Brass Bell Chime stack
      const click = this.ctx!.createOscillator();
      const cg = this.ctx!.createGain();
      click.type = 'square';
      click.frequency.setValueAtTime(2800 * pMod, t);
      click.frequency.exponentialRampToValueAtTime(600 * pMod, t + 0.018);
      cg.gain.setValueAtTime(0.55, t);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
      click.connect(cg); cg.connect(out);
      click.start(t); click.stop(t + 0.03);
      voice.nodes.push(click);

      const tBell = t + 0.02;
      const bells: ReadonlyArray<{ freq: number; vol: number; type: OscillatorType; dur: number }> = [
        { freq: 1760.0 * pMod, vol: 0.58, type: 'sine', dur: 0.45 },
        { freq: 3520.0 * pMod, vol: 0.42, type: 'sine', dur: 0.35 },
        { freq: 2637.0 * pMod, vol: 0.3, type: 'triangle', dur: 0.4 },
      ];
      bells.forEach((b) => {
        const osc = this.ctx!.createOscillator();
        const bg = this.ctx!.createGain();
        osc.type = b.type;
        osc.frequency.setValueAtTime(b.freq, tBell);
        bg.gain.setValueAtTime(0.001, tBell);
        bg.gain.linearRampToValueAtTime(b.vol, tBell + 0.005);
        bg.gain.exponentialRampToValueAtTime(0.0001, tBell + b.dur);
        osc.connect(bg); bg.connect(out);
        osc.start(tBell); osc.stop(tBell + b.dur + 0.02);
        voice.nodes.push(osc);
      });
    } else if (vIdx === 1) {
      // Triple Cash Shimmer: C7 / E7 / G7 golden coin chimes
      [2093.0, 2637.02, 3135.96].forEach((freq, i) => {
        const tc = t + i * 0.075;
        const osc = this.ctx!.createOscillator();
        const cg = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq * pMod, tc);
        cg.gain.setValueAtTime(0.001, tc);
        cg.gain.linearRampToValueAtTime(0.55, tc + 0.003);
        cg.gain.exponentialRampToValueAtTime(0.0001, tc + 0.35);
        osc.connect(cg); cg.connect(out);
        osc.start(tc); osc.stop(tc + 0.38);
        voice.nodes.push(osc);
      });
    } else {
      // Jackpot Confetti Blip: joyful arcade melody C6-E6-G6-C7
      const jackpot: ReadonlyArray<{ f: number; delay: number; dur: number }> = [
        { f: 1046.5, delay: 0, dur: 0.06 },
        { f: 1318.51, delay: 0.065, dur: 0.06 },
        { f: 1567.98, delay: 0.13, dur: 0.06 },
        { f: 2093.0, delay: 0.195, dur: 0.35 },
      ];
      jackpot.forEach((m) => {
        const tm = t + m.delay;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(m.f * pMod, tm);
        g.gain.setValueAtTime(0.001, tm);
        g.gain.linearRampToValueAtTime(0.58, tm + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, tm + m.dur);
        osc.connect(g); g.connect(out);
        osc.start(tm); osc.stop(tm + m.dur + 0.02);
        voice.nodes.push(osc);
      });
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 23. EASTER EGG DISK (doppler whoosh / hyperspace decel / holo ring)
  // ------------------------------------------------------------------

  playEasterEggDisk(variantIndex?: number): number {
    const vIdx = this.pickVariant('playEasterEggDisk', variantIndex);
    const v = this.createVoice({ duration: 0.85 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.04);

    if (vIdx === 0) {
      // Spinning Doppler Whoosh: 500->1800->600 Hz saw + 24 Hz flutter LFO
      const osc = this.ctx!.createOscillator();
      const lfo = this.ctx!.createOscillator();
      const lg = this.ctx!.createGain();
      const g = this.ctx!.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(500 * pMod, t);
      osc.frequency.exponentialRampToValueAtTime(1800 * pMod, t + 0.25);
      osc.frequency.exponentialRampToValueAtTime(600 * pMod, t + 0.65);
      lfo.frequency.setValueAtTime(24.0, t);
      lg.gain.setValueAtTime(180 * pMod, t);
      lfo.connect(osc.frequency);
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.55, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      osc.connect(g); g.connect(out);
      lfo.start(t); osc.start(t);
      lfo.stop(t + 0.72); osc.stop(t + 0.72);
      voice.nodes.push(lfo, osc);
    } else if (vIdx === 1) {
      // Hyperspace Decel Throw: magnetic rail discharge 4 kHz -> 400 Hz
      const rail = this.ctx!.createOscillator();
      const rg = this.ctx!.createGain();
      rail.type = 'triangle';
      rail.frequency.setValueAtTime(4000 * pMod, t);
      rail.frequency.exponentialRampToValueAtTime(400 * pMod, t + 0.35);
      rg.gain.setValueAtTime(0.001, t);
      rg.gain.linearRampToValueAtTime(0.6, t + 0.02);
      rg.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      rail.connect(rg); rg.connect(out);
      rail.start(t); rail.stop(t + 0.58);
      voice.nodes.push(rail);
    } else {
      // Holo-Disk Shimmer Ring: harmonic ring G6 / D7 / G7
      const holoRing = [1568.0, 2349.3, 3136.0];
      holoRing.forEach((freq) => {
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq * pMod, t);
        g.gain.setValueAtTime(0.001, t);
        g.gain.linearRampToValueAtTime(0.5 / holoRing.length, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
        osc.connect(g); g.connect(out);
        osc.start(t); osc.stop(t + 0.7);
        voice.nodes.push(osc);
      });
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 24. UI CHIME (crystal ding / double marimba / warm synth ack)
  // ------------------------------------------------------------------

  playChime(variantIndex?: number): number {
    const vIdx = this.pickVariant('playChime', variantIndex);
    const v = this.createVoice({ duration: 0.6 });
    if (!v) return -1;
    const { out, t, voice } = v;

    if (vIdx === 0) {
      // Crystal Glass Ding: pure 2489 Hz ping
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(2489.02 * this.jitter(0.01), t);
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.56, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      osc.connect(g); g.connect(out);
      osc.start(t); osc.stop(t + 0.52);
      voice.nodes.push(osc);
    } else if (vIdx === 1) {
      // Soft Double Marimba Bell: warm wooden A5 -> C#6
      [
        { freq: 880.0, delay: 0, dur: 0.22 },
        { freq: 1108.73, delay: 0.09, dur: 0.35 },
      ].forEach((n) => {
        const tn = t + n.delay;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(n.freq, tn);
        g.gain.setValueAtTime(0.001, tn);
        g.gain.linearRampToValueAtTime(0.52, tn + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, tn + n.dur);
        osc.connect(g); g.connect(out);
        osc.start(tn); osc.stop(tn + n.dur + 0.02);
        voice.nodes.push(osc);
      });
    } else {
      // Warm Synth Acknowledge: lowpassed F major chord F4-A4-C5
      const chord = [349.23, 440.0, 523.25];
      chord.forEach((f) => {
        const osc = this.ctx!.createOscillator();
        const filter = this.ctx!.createBiquadFilter();
        const g = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(f, t);
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(900, t);
        g.gain.setValueAtTime(0.001, t);
        g.gain.linearRampToValueAtTime(0.48 / chord.length, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
        osc.connect(filter); filter.connect(g); g.connect(out);
        osc.start(t); osc.stop(t + 0.4);
        voice.nodes.push(osc);
      });
    }
    return vIdx;
  }
}

export const petAudio = new PetAudioEngine();
