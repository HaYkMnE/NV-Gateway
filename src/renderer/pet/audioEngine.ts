/**
 * petAudio — procedural pet sound engine (Web Audio API).
 *
 * Cyberpunk HUD audio architecture for NV-Gateway:
 * - Two distinct character sonic identities: "Cyber Mascot" (Kinetic Drone) and "Pixel Hacker" (TRM-80 Terminal).
 * - Multi-stage procedural sound synthesis: pink/brown/white noise generators, resonant biquad filters,
 *   FM chirps, harmonic overtones, tanh saturation, and calibrated master chain.
 * - Zero external assets or audio files; 100% procedural Web Audio math.
 *
 * Every play* method takes an optional variant index 0|1|2; when omitted the
 * Shuffle Round-Robin pool picks a variant with NO consecutive repeats.
 * Each method returns the variant that was chosen (-1 if audio is disabled,
 * the window is not currently audible, or the AudioContext is unavailable).
 *
 * AUDIBILITY GATE (see setAudibleGate). Sound must only exist while the window
 * is genuinely active. That is enforced by POLLING a caller-supplied predicate
 * at the moment sound would be produced, not by reacting to blur/hide events:
 * the reported defect was precisely that a hide whose transition never reached
 * the renderer left the ambient cadence armed and the pet audible in the tray.
 * A polled gate cannot be defeated by a missed event.
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
  private saturationCurve: Float32Array<ArrayBuffer> | null = null;

  private enabled = false;
  private activeVoices: ActiveVoice[] = [];
  private readonly variantHistory = new Map<SfxKey, number>();

  /**
   * Window-audibility predicate. Default `true` keeps standalone/legacy use
   * (and any caller that never installs a gate) behaving exactly as before.
   */
  private audibleGate: () => boolean = () => true;

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

      // 2. High-frequency smoothing (14 kHz warm lowpass filter)
      const masterFilter = ctx.createBiquadFilter();
      masterFilter.type = 'lowpass';
      masterFilter.frequency.setValueAtTime(14_000, ctx.currentTime);
      masterFilter.Q.setValueAtTime(0.707, ctx.currentTime);

      // 3. Fast peak limiter (prevents clipping on multi-transients)
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.setValueAtTime(-3.0, ctx.currentTime);
      limiter.knee.setValueAtTime(6.0, ctx.currentTime);
      limiter.ratio.setValueAtTime(4.0, ctx.currentTime);
      limiter.attack.setValueAtTime(0.003, ctx.currentTime);
      limiter.release.setValueAtTime(0.05, ctx.currentTime);

      // 4. Calibrated master volume
      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(0.52, ctx.currentTime);

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
      this.saturationCurve = this.makeSaturationCurve();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  /**
   * User-gesture audio unlock. Chromium autoplay policy starts an
   * AudioContext in the `suspended` state until a resume() is issued from
   * inside a real user-gesture handler. Safe to call repeatedly.
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
        this.masterGain.gain.setValueAtTime(0.52, this.ctx.currentTime);
      }
    } else {
      // Mute path: kill any ringing voices, duck the master bus and stop the ambient cadence.
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

  /**
   * Install the window-audibility predicate. Composes WITH {@link setEnabled}
   * (the user's `nv_pet_sound` preference) rather than replacing it: sound
   * requires enabled AND audible, and neither can override the other.
   */
  setAudibleGate(gate: () => boolean): void {
    this.audibleGate = gate;
  }

  /**
   * Evaluate the audibility gate. A throwing gate resolves to SILENCE and is swallowed.
   */
  private canPlayNow(): boolean {
    try {
      return this.audibleGate() !== false;
    } catch {
      return false;
    }
  }

  /**
   * Go silent immediately: stop and RELEASE every live voice and stop the ambient cadence.
   */
  silenceNow(): void {
    this.stealVoices(3);
    this.stopAmbient();
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

  /** Brown noise: 1/f² slope via leaky integrator. */
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

  private makeSaturationCurve(): Float32Array<ArrayBuffer> {
    const n = 4096;
    const curve = new Float32Array(n);
    const k = 2.4;
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
  private jitter(amount = 0.04): number {
    return 1 + (Math.random() * 2 - 1) * amount;
  }

  private schedAt(time: number): number {
    return Math.max(this.ctx ? this.ctx.currentTime : 0, time);
  }

  /**
   * Steal all live voices with a fast linear fade so rapid re-triggers never pop.
   */
  private stealVoices(fadeMs = 4): void {
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

  /**
   * Single voice-creation choke point: EVERY play* method funnels through here.
   */
  private createVoice(options: VoiceOptions = {}): VoiceHandle | null {
    if (!this.enabled) return null;
    if (!this.canPlayNow()) return null;
    this.init();
    if (!this.ctx || !this.masterBus) return null;
    const t = this.ctx.currentTime;

    if (options.stealVoices !== false) {
      this.stealVoices(options.fadeMs ?? 4);
    }

    const voiceGain = this.ctx.createGain();
    voiceGain.gain.setValueAtTime(options.volume ?? 1.0, t);
    voiceGain.connect(this.masterBus);

    const voice: ActiveVoice = { gainNode: voiceGain, nodes: [] };
    this.activeVoices.push(voice);

    const duration = options.duration ?? 1.6;
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
      if (this.canPlayNow()) {
        this.fireAmbientSound();
      }
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
      // Idle mix: subtle, discrete ambient life signs (never loud or jarring)
      const roll = Math.random();
      if (roll < 0.35) this.playChime();
      else if (roll < 0.7) this.playMascotSensorPolish();
      else this.playMascotModelJuggler();
    }
  }

  // ------------------------------------------------------------------
  // 1. SLEEP & STANDBY CUES (Clean Cyber Robotic & Terminal Modes)
  // ------------------------------------------------------------------

  playOrganicSnoring(variantIndex?: number): number {
    return this.playMascotPowerNap(variantIndex);
  }

  /**
   * Cyber Mascot Power Nap: soft standby reactor hum, melodic sleep beacons, cooling vents.
   */
  playMascotPowerNap(variantIndex?: number): number {
    const vIdx = this.pickVariant('playMascotPowerNap', variantIndex);
    const v = this.createVoice({ duration: 1.8, volume: 0.65 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.02);

    if (vIdx === 0) {
      // Standby Power Hum: warm 55 Hz sub-sine + soft 0.4 Hz breathing lowpass filter sweep
      const hum = this.ctx!.createOscillator();
      const hg = this.ctx!.createGain();
      const f = this.ctx!.createBiquadFilter();
      hum.type = 'sine';
      hum.frequency.setValueAtTime(55 * pMod, t);
      f.type = 'lowpass';
      f.frequency.setValueAtTime(140, t);
      f.frequency.exponentialRampToValueAtTime(280, t + 0.6);
      f.frequency.exponentialRampToValueAtTime(120, t + 1.4);
      hg.gain.setValueAtTime(0.0001, t);
      hg.gain.linearRampToValueAtTime(0.42, t + 0.4);
      hg.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
      hum.connect(f); f.connect(hg); hg.connect(out);
      hum.start(t); hum.stop(t + 1.55);
      voice.nodes.push(hum);
    } else if (vIdx === 1) {
      // Gentle Sleep Beacon Chime: E5 -> B5 pure sines with soft envelope
      const notes = [{ f: 659.25, dt: 0, dur: 0.5 }, { f: 493.88, dt: 0.28, dur: 0.7 }];
      notes.forEach((n) => {
        const tn = t + n.dt;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(n.f * pMod, tn);
        g.gain.setValueAtTime(0.0001, tn);
        g.gain.linearRampToValueAtTime(0.35, tn + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, tn + n.dur);
        osc.connect(g); g.connect(out);
        osc.start(tn); osc.stop(tn + n.dur + 0.02);
        voice.nodes.push(osc);
      });
    } else {
      // Low-Noise Standby Vent: brown noise filtered at 160 Hz
      const vent = this.getBrown();
      if (vent) {
        const vf = this.ctx!.createBiquadFilter();
        const vg = this.ctx!.createGain();
        vf.type = 'lowpass';
        vf.frequency.setValueAtTime(180 * pMod, t);
        vg.gain.setValueAtTime(0.0001, t);
        vg.gain.linearRampToValueAtTime(0.38, t + 0.35);
        vg.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
        vent.connect(vf); vf.connect(vg); vg.connect(out);
        vent.start(t); vent.stop(t + 1.25);
        voice.nodes.push(vent);
      }
    }
    return vIdx;
  }

  /**
   * Pixel Hacker Terminal Nap: CRT flyback coil hum, terminal cursor tick, quiet fan whir.
   */
  playHackerTerminalNap(variantIndex?: number): number {
    const vIdx = this.pickVariant('playHackerTerminalNap', variantIndex);
    const v = this.createVoice({ duration: 1.4, volume: 0.6 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.02);

    if (vIdx === 0) {
      // CRT Flyback Coil & Transformer Hum: 60 Hz + 120 Hz soft pulse
      const hum = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      const f = this.ctx!.createBiquadFilter();
      hum.type = 'triangle';
      hum.frequency.setValueAtTime(60.0 * pMod, t);
      f.type = 'lowpass';
      f.frequency.setValueAtTime(220, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.36, t + 0.25);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      hum.connect(f); f.connect(g); g.connect(out);
      hum.start(t); hum.stop(t + 1.15);
      voice.nodes.push(hum);
    } else if (vIdx === 1) {
      // Terminal Cursor Sleep Tick: 2 soft, muted clock ticks (380 Hz)
      [0, 0.45].forEach((dt) => {
        const tt = t + dt;
        const tick = this.ctx!.createOscillator();
        const tg = this.ctx!.createGain();
        tick.type = 'sine';
        tick.frequency.setValueAtTime(380 * pMod, tt);
        tg.gain.setValueAtTime(0.0001, tt);
        tg.gain.linearRampToValueAtTime(0.3, tt + 0.004);
        tg.gain.exponentialRampToValueAtTime(0.0001, tt + 0.04);
        tick.connect(tg); tg.connect(out);
        tick.start(tt); tick.stop(tt + 0.045);
        voice.nodes.push(tick);
      });
    } else {
      // Quiet Computer Fan: pink noise through 220 Hz lowpass
      const fan = this.getPink();
      if (fan) {
        const ff = this.ctx!.createBiquadFilter();
        const fg = this.ctx!.createGain();
        ff.type = 'lowpass';
        ff.frequency.setValueAtTime(220 * pMod, t);
        fg.gain.setValueAtTime(0.0001, t);
        fg.gain.linearRampToValueAtTime(0.32, t + 0.3);
        fg.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
        fan.connect(ff); ff.connect(fg); fg.connect(out);
        fan.start(t); fan.stop(t + 1.05);
        voice.nodes.push(fan);
      }
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 2. POWER & DATA RE-INDEXING (Cybernetic Reactor / Cache Stream)
  // ------------------------------------------------------------------

  playStomachRumbling(variantIndex?: number): number {
    const vIdx = this.pickVariant('playStomachRumbling', variantIndex);
    const v = this.createVoice({ duration: 1.0, volume: 0.7 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.03);

    if (vIdx === 0) {
      // Sub-Bass Magnetic Flux: 48 Hz triangle with gentle 6 Hz FM modulation
      const drone = this.ctx!.createOscillator();
      const lfo = this.ctx!.createOscillator();
      const lfoG = this.ctx!.createGain();
      const dg = this.ctx!.createGain();
      const df = this.ctx!.createBiquadFilter();

      drone.type = 'triangle';
      drone.frequency.setValueAtTime(48 * pMod, t);
      lfo.frequency.setValueAtTime(6.0, t);
      lfoG.gain.setValueAtTime(8 * pMod, t);
      lfo.connect(drone.frequency);

      df.type = 'lowpass';
      df.frequency.setValueAtTime(180, t);
      dg.gain.setValueAtTime(0.0001, t);
      dg.gain.linearRampToValueAtTime(0.48, t + 0.15);
      dg.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);

      drone.connect(df); df.connect(dg); dg.connect(out);
      lfo.start(t); drone.start(t);
      lfo.stop(t + 0.9); drone.stop(t + 0.9);
      voice.nodes.push(lfo, drone);
    } else if (vIdx === 1) {
      // Data Packet Stream: 4 soft crystalline micro-pings
      const freqs = [640, 820, 960, 1120];
      freqs.forEach((f0, i) => {
        const tp = t + i * 0.08;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f0 * pMod, tp);
        g.gain.setValueAtTime(0.0001, tp);
        g.gain.linearRampToValueAtTime(0.38, tp + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, tp + 0.06);
        osc.connect(g); g.connect(out);
        osc.start(tp); osc.stop(tp + 0.065);
        voice.nodes.push(osc);
      });
    } else {
      // Power Cell Trickle Charge: ascending resonant sweep 80 Hz -> 220 Hz
      const sweep = this.ctx!.createOscillator();
      const sg = this.ctx!.createGain();
      const sf = this.ctx!.createBiquadFilter();
      sweep.type = 'triangle';
      sweep.frequency.setValueAtTime(80 * pMod, t);
      sweep.frequency.exponentialRampToValueAtTime(220 * pMod, t + 0.5);
      sf.type = 'lowpass';
      sf.frequency.setValueAtTime(350, t);
      sg.gain.setValueAtTime(0.0001, t);
      sg.gain.linearRampToValueAtTime(0.44, t + 0.08);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      sweep.connect(sf); sf.connect(sg); sg.connect(out);
      sweep.start(t); sweep.stop(t + 0.65);
      voice.nodes.push(sweep);
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 3. SYSTEM CALIBRATION (Diagnostic Harmonic Glide / Chord Swell)
  // ------------------------------------------------------------------

  playOrganicYawn(variantIndex?: number): number {
    const vIdx = this.pickVariant('playOrganicYawn', variantIndex);
    const v = this.createVoice({ duration: 1.2, volume: 0.7 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.03);

    if (vIdx === 0) {
      // Smooth Frequency Glide: 320 Hz -> 580 Hz -> 240 Hz with gentle 6 Hz vibrato
      const osc = this.ctx!.createOscillator();
      const vib = this.ctx!.createOscillator();
      const vibG = this.ctx!.createGain();
      const g = this.ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(320 * pMod, t);
      osc.frequency.exponentialRampToValueAtTime(580 * pMod, t + 0.35);
      osc.frequency.exponentialRampToValueAtTime(240 * pMod, t + 0.95);
      vib.frequency.setValueAtTime(6.0, t);
      vibG.gain.setValueAtTime(14 * pMod, t);
      vib.connect(osc.frequency);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.48, t + 0.25);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
      osc.connect(g); g.connect(out);
      vib.start(t); osc.start(t);
      vib.stop(t + 1.05); osc.stop(t + 1.05);
      voice.nodes.push(vib, osc);
    } else if (vIdx === 1) {
      // Warm Analog Chord Swell: A Major (440, 554, 659 Hz) soft envelope
      const chord = [440.0, 554.37, 659.25];
      chord.forEach((freq) => {
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        const f = this.ctx!.createBiquadFilter();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq * pMod, t);
        f.type = 'lowpass';
        f.frequency.setValueAtTime(900, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.35 / chord.length, t + 0.2);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
        osc.connect(f); f.connect(g); g.connect(out);
        osc.start(t); osc.stop(t + 0.9);
        voice.nodes.push(osc);
      });
    } else {
      // Servo Stretch & Release: 120 Hz -> 320 Hz -> 90 Hz triangle with lowpass
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      const f = this.ctx!.createBiquadFilter();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(120 * pMod, t);
      osc.frequency.exponentialRampToValueAtTime(320 * pMod, t + 0.3);
      osc.frequency.exponentialRampToValueAtTime(90 * pMod, t + 0.8);
      f.type = 'lowpass';
      f.frequency.setValueAtTime(450, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.45, t + 0.18);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
      osc.connect(f); f.connect(g); g.connect(out);
      osc.start(t); osc.stop(t + 0.9);
      voice.nodes.push(osc);
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 4. LOW-POWER STANDBY (Pneumatic Depressurize / Power Down)
  // ------------------------------------------------------------------

  playSadTiredSigh(variantIndex?: number): number {
    const vIdx = this.pickVariant('playSadTiredSigh', variantIndex);
    const v = this.createVoice({ duration: 1.0, volume: 0.65 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.03);

    if (vIdx === 0) {
      // Gentle Pneumatic Release: soft pink noise bandpassed at 450 Hz
      const noise = this.getPink();
      if (noise) {
        const f = this.ctx!.createBiquadFilter();
        const g = this.ctx!.createGain();
        f.type = 'bandpass';
        f.frequency.setValueAtTime(450 * pMod, t);
        f.Q.value = 2.0;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.4, t + 0.12);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
        noise.connect(f); f.connect(g); g.connect(out);
        noise.start(t); noise.stop(t + 0.7);
        voice.nodes.push(noise);
      }
    } else if (vIdx === 1) {
      // Descending Dual-Chime: 880 Hz -> 659 Hz soft sines
      const chimes = [{ f: 880, dt: 0 }, { f: 659.25, dt: 0.16 }];
      chimes.forEach((c) => {
        const tc = t + c.dt;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(c.f * pMod, tc);
        g.gain.setValueAtTime(0.0001, tc);
        g.gain.linearRampToValueAtTime(0.36, tc + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, tc + 0.45);
        osc.connect(g); g.connect(out);
        osc.start(tc); osc.stop(tc + 0.5);
        voice.nodes.push(osc);
      });
    } else {
      // Power-Save Sleep Tone: 220 Hz -> 110 Hz sine with gentle lowpass
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      const f = this.ctx!.createBiquadFilter();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(220 * pMod, t);
      osc.frequency.exponentialRampToValueAtTime(110 * pMod, t + 0.5);
      f.type = 'lowpass';
      f.frequency.setValueAtTime(320, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.42, t + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      osc.connect(f); f.connect(g); g.connect(out);
      osc.start(t); osc.stop(t + 0.65);
      voice.nodes.push(osc);
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 5. MECHANICAL KEYBOARD (Lubed Linear / Tactile Thock)
  // ------------------------------------------------------------------

  playHackerCodeFrenzy(variantIndex?: number): number {
    const vIdx = this.pickVariant('playHackerCodeFrenzy', variantIndex);
    const v = this.createVoice({ duration: 0.75, volume: 0.75 });
    if (!v) return -1;
    const { out, t, voice } = v;

    const keystroke = (tk: number, thudF: number, isSpace: boolean): void => {
      tk = this.schedAt(tk);
      const kJit = this.jitter(0.05);

      // Layer 1: Tactile Switch Click (crisp micro-noise transient)
      const noise = this.getPink();
      if (noise) {
        const sf = this.ctx!.createBiquadFilter();
        const sg = this.ctx!.createGain();
        sf.type = 'bandpass';
        sf.frequency.setValueAtTime(2400 * kJit, tk);
        sf.Q.value = 3.0;
        sg.gain.setValueAtTime(0.0001, tk);
        sg.gain.linearRampToValueAtTime(isSpace ? 0.5 : 0.42, tk + 0.002);
        sg.gain.exponentialRampToValueAtTime(0.0001, tk + (isSpace ? 0.015 : 0.008));
        noise.connect(sf); sf.connect(sg); sg.connect(out);
        noise.start(tk); noise.stop(tk + 0.02);
        voice.nodes.push(noise);
      }

      // Layer 2: Housing Thock (solid bottom-out resonance, no harsh metallic ringing)
      const thud = this.ctx!.createOscillator();
      const tg = this.ctx!.createGain();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(thudF * kJit, tk);
      thud.frequency.exponentialRampToValueAtTime(thudF * 0.4 * kJit, tk + (isSpace ? 0.045 : 0.022));
      tg.gain.setValueAtTime(0.0001, tk);
      tg.gain.linearRampToValueAtTime(isSpace ? 0.6 : 0.48, tk + 0.003);
      tg.gain.exponentialRampToValueAtTime(0.0001, tk + (isSpace ? 0.055 : 0.028));
      thud.connect(tg); tg.connect(out);
      thud.start(tk); thud.stop(tk + 0.06);
      voice.nodes.push(thud);
    };

    if (vIdx === 0) {
      // Rapid typing burst: 6 rhythmic keystrokes
      [0, 0.038, 0.076, 0.118, 0.156, 0.198].forEach((d) => {
        keystroke(t + d + (Math.random() - 0.5) * 0.003, 140, false);
      });
    } else if (vIdx === 1) {
      // Spacebar impact + double tap
      keystroke(t, 140, false);
      keystroke(t + 0.06, 140, false);
      keystroke(t + 0.14, 95, true);
    } else {
      // Code rhythm: 4 staggered keystrokes
      [0, 0.065, 0.14, 0.22].forEach((d, i) => {
        keystroke(t + d, i === 3 ? 100 : 135, i === 3);
      });
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 6. MASCOT ROBOT EXPRESSIONS (Harmonic Drone Chirps)
  // ------------------------------------------------------------------

  playMascotModelJuggler(variantIndex?: number): number {
    const vIdx = this.pickVariant('playMascotModelJuggler', variantIndex);
    const v = this.createVoice({ duration: 0.65, volume: 0.75 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.02);

    if (vIdx === 0) {
      // Inquisitive Question: G5 -> B5 -> E6 with smooth vibrato
      const notes = [
        { f: 783.99, dt: 0, dur: 0.07 },
        { f: 987.77, dt: 0.08, dur: 0.07 },
        { f: 1318.51, dt: 0.16, dur: 0.24 },
      ];
      notes.forEach((n, idx) => {
        const tn = t + n.dt;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(n.f * pMod, tn);
        if (idx === 2) {
          const vib = this.ctx!.createOscillator();
          const vibG = this.ctx!.createGain();
          vib.frequency.setValueAtTime(7.0, tn);
          vibG.gain.setValueAtTime(18.0 * pMod, tn);
          vib.connect(osc.frequency);
          vib.start(tn); vib.stop(tn + n.dur);
          voice.nodes.push(vib);
        }
        g.gain.setValueAtTime(0.0001, tn);
        g.gain.linearRampToValueAtTime(0.48, tn + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, tn + n.dur);
        osc.connect(g); g.connect(out);
        osc.start(tn); osc.stop(tn + n.dur + 0.01);
        voice.nodes.push(osc);
      });
    } else if (vIdx === 1) {
      // Victory Trill: 4-tone ascending melody
      const melody = [
        { f: 1046.5, dt: 0, dur: 0.06 },
        { f: 1318.51, dt: 0.07, dur: 0.06 },
        { f: 1567.98, dt: 0.14, dur: 0.06 },
        { f: 2093.0, dt: 0.21, dur: 0.26 },
      ];
      melody.forEach((m) => {
        const tm = t + m.dt;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(m.f * pMod, tm);
        g.gain.setValueAtTime(0.0001, tm);
        g.gain.linearRampToValueAtTime(0.45, tm + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, tm + m.dur);
        osc.connect(g); g.connect(out);
        osc.start(tm); osc.stop(tm + m.dur + 0.01);
        voice.nodes.push(osc);
      });
    } else {
      // Dual-Tone Synth Blip: 523 Hz & 784 Hz cheerful bounce
      [523.25, 783.99].forEach((f0, i) => {
        const tb = t + i * 0.07;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f0 * pMod, tb);
        g.gain.setValueAtTime(0.0001, tb);
        g.gain.linearRampToValueAtTime(0.5, tb + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, tb + 0.16);
        osc.connect(g); g.connect(out);
        osc.start(tb); osc.stop(tb + 0.18);
        voice.nodes.push(osc);
      });
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 7. COIN / REWARD DROPS (Mascot Nano-Credits vs Hacker Arcade Tokens)
  // ------------------------------------------------------------------

  playRealisticCoinDrop(variantIndex?: number): number {
    const vIdx = this.pickVariant('playRealisticCoinDrop', variantIndex);
    const v = this.createVoice({ duration: 0.7, volume: 0.75 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.02);

    // Mascot Nano-Credit: clean metallic chimes at 1.8 kHz, 2.6 kHz, 3.5 kHz
    const freqs = vIdx === 0 ? [1800, 2600, 3500] : vIdx === 1 ? [2093, 2637, 3136] : [1568, 2093, 2793];
    freqs.forEach((freq, i) => {
      const tc = t + i * 0.065;
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * pMod, tc);
      g.gain.setValueAtTime(0.0001, tc);
      g.gain.linearRampToValueAtTime(0.48 / freqs.length, tc + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, tc + 0.35);
      osc.connect(g); g.connect(out);
      osc.start(tc); osc.stop(tc + 0.38);
      voice.nodes.push(osc);
    });
    return vIdx;
  }

  playHackerCoinDrop(variantIndex?: number): number {
    const vIdx = this.pickVariant('playHackerCoinDrop', variantIndex);
    const v = this.createVoice({ duration: 0.5, volume: 0.75 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.01);

    // Pixel Hacker Arcade Coin: Classic 8-bit jump arpeggio (B5 -> E6)
    if (vIdx === 0) {
      const notes = [{ f: 987.77, dt: 0, dur: 0.08 }, { f: 1318.51, dt: 0.08, dur: 0.28 }];
      notes.forEach((n) => {
        const tn = t + n.dt;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(n.f * pMod, tn);
        g.gain.setValueAtTime(0.0001, tn);
        g.gain.linearRampToValueAtTime(0.42, tn + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, tn + n.dur);
        osc.connect(g); g.connect(out);
        osc.start(tn); osc.stop(tn + n.dur + 0.01);
        voice.nodes.push(osc);
      });
    } else if (vIdx === 1) {
      // 3-tone arcade bonus chime
      const notes = [
        { f: 1046.5, dt: 0, dur: 0.05 },
        { f: 1318.51, dt: 0.055, dur: 0.05 },
        { f: 2093.0, dt: 0.11, dur: 0.25 },
      ];
      notes.forEach((n) => {
        const tn = t + n.dt;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(n.f * pMod, tn);
        g.gain.setValueAtTime(0.0001, tn);
        g.gain.linearRampToValueAtTime(0.48, tn + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, tn + n.dur);
        osc.connect(g); g.connect(out);
        osc.start(tn); osc.stop(tn + n.dur + 0.01);
        voice.nodes.push(osc);
      });
    } else {
      // Arcade token drop click + ding
      const tick = this.ctx!.createOscillator();
      const tg = this.ctx!.createGain();
      tick.type = 'square';
      tick.frequency.setValueAtTime(1400 * pMod, t);
      tg.gain.setValueAtTime(0.45, t);
      tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
      tick.connect(tg); tg.connect(out);
      tick.start(t); tick.stop(t + 0.015);
      voice.nodes.push(tick);

      const chime = this.ctx!.createOscillator();
      const cg = this.ctx!.createGain();
      chime.type = 'triangle';
      chime.frequency.setValueAtTime(1567.98 * pMod, t + 0.012);
      cg.gain.setValueAtTime(0.0001, t + 0.012);
      cg.gain.linearRampToValueAtTime(0.5, t + 0.016);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      chime.connect(cg); cg.connect(out);
      chime.start(t + 0.012); chime.stop(t + 0.35);
      voice.nodes.push(chime);
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 8. TACTILE DESK & MUG TAP (Subtle Physical Foley)
  // ------------------------------------------------------------------

  playMugTableTap(variantIndex?: number): number {
    return this.mugTap('playMugTableTap', variantIndex);
  }

  playHackerEmptyMug(variantIndex?: number): number {
    return this.mugTap('playHackerEmptyMug', variantIndex);
  }

  private mugTap(key: SfxKey, variant?: number): number {
    const vIdx = this.pickVariant(key, variant);
    const v = this.createVoice({ duration: 0.45, volume: 0.65 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.04);

    if (vIdx === 0) {
      // Ceramic Placement: soft thud (90 Hz) + gentle ceramic ping (1200 Hz)
      const thud = this.ctx!.createOscillator();
      const tg = this.ctx!.createGain();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(90 * pMod, t);
      thud.frequency.exponentialRampToValueAtTime(45 * pMod, t + 0.06);
      tg.gain.setValueAtTime(0.0001, t);
      tg.gain.linearRampToValueAtTime(0.52, t + 0.003);
      tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      thud.connect(tg); tg.connect(out);
      thud.start(t); thud.stop(t + 0.08);
      voice.nodes.push(thud);

      const ping = this.ctx!.createOscillator();
      const pg = this.ctx!.createGain();
      ping.type = 'triangle';
      ping.frequency.setValueAtTime(1200 * pMod, t);
      pg.gain.setValueAtTime(0.0001, t);
      pg.gain.linearRampToValueAtTime(0.35, t + 0.002);
      pg.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      ping.connect(pg); pg.connect(out);
      ping.start(t); ping.stop(t + 0.1);
      voice.nodes.push(ping);
    } else if (vIdx === 1) {
      // Soft Desk Tap
      const tap = this.ctx!.createOscillator();
      const tg = this.ctx!.createGain();
      tap.type = 'sine';
      tap.frequency.setValueAtTime(140 * pMod, t);
      tap.frequency.exponentialRampToValueAtTime(50 * pMod, t + 0.04);
      tg.gain.setValueAtTime(0.0001, t);
      tg.gain.linearRampToValueAtTime(0.48, t + 0.002);
      tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      tap.connect(tg); tg.connect(out);
      tap.start(t); tap.stop(t + 0.06);
      voice.nodes.push(tap);
    } else {
      // Mug Slide & Stop
      const noise = this.getPink();
      if (noise) {
        const f = this.ctx!.createBiquadFilter();
        const g = this.ctx!.createGain();
        f.type = 'bandpass';
        f.frequency.setValueAtTime(800 * pMod, t);
        f.Q.value = 2.5;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.35, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
        noise.connect(f); f.connect(g); g.connect(out);
        noise.start(t); noise.stop(t + 0.14);
        voice.nodes.push(noise);
      }
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 9. BUG COMBAT (Mascot Plasma Blaster vs Hacker Cyber Katana)
  // ------------------------------------------------------------------

  playMascotBugHunter(variantIndex?: number): number {
    const vIdx = this.pickVariant('playMascotBugHunter', variantIndex);
    const v = this.createVoice({ duration: 0.5, volume: 0.75 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.04);

    const fireLaser = (delay: number, f0: number, f1: number, dur: number): void => {
      const t0 = t + delay;
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      const f = this.ctx!.createBiquadFilter();
      const shaper = this.getSaturation();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0 * pMod, t0);
      osc.frequency.exponentialRampToValueAtTime(f1 * pMod, t0 + dur);
      f.type = 'lowpass';
      f.frequency.setValueAtTime(3200, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.48, t0 + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      if (shaper) {
        osc.connect(shaper);
        shaper.connect(f);
      } else {
        osc.connect(f);
      }
      f.connect(g);
      g.connect(out);
      osc.start(t0);
      osc.stop(t0 + dur + 0.01);
      voice.nodes.push(osc);
    };

    if (vIdx === 0) {
      // 3-Pulse Rapid Plasma Blaster
      fireLaser(0, 1800, 320, 0.035);
      fireLaser(0.045, 2200, 300, 0.035);
      fireLaser(0.09, 2600, 280, 0.045);
    } else if (vIdx === 1) {
      // Electromagnetic Laser Stunner
      fireLaser(0, 2400, 400, 0.06);
    } else {
      // Plasma Orb Burst
      const kick = this.ctx!.createOscillator();
      const kg = this.ctx!.createGain();
      kick.type = 'sine';
      kick.frequency.setValueAtTime(110 * pMod, t);
      kick.frequency.exponentialRampToValueAtTime(45 * pMod, t + 0.06);
      kg.gain.setValueAtTime(0.0001, t);
      kg.gain.linearRampToValueAtTime(0.55, t + 0.002);
      kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      kick.connect(kg); kg.connect(out);
      kick.start(t); kick.stop(t + 0.08);
      voice.nodes.push(kick);
      fireLaser(0.02, 2800, 500, 0.08);
    }
    return vIdx;
  }

  playHackerBugSlayer(variantIndex?: number): number {
    const vIdx = this.pickVariant('playHackerBugSlayer', variantIndex);
    const v = this.createVoice({ duration: 0.55, volume: 0.75 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.04);

    if (vIdx === 0) {
      // Digital Cyber-Katana Slice: filtered whoosh + resonant ring (2.2 kHz)
      const noise = this.getPink();
      if (noise) {
        const f = this.ctx!.createBiquadFilter();
        const g = this.ctx!.createGain();
        f.type = 'bandpass';
        f.frequency.setValueAtTime(1200 * pMod, t);
        f.frequency.exponentialRampToValueAtTime(2800 * pMod, t + 0.06);
        f.frequency.exponentialRampToValueAtTime(800 * pMod, t + 0.14);
        f.Q.value = 3.0;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.5, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
        noise.connect(f); f.connect(g); g.connect(out);
        noise.start(t); noise.stop(t + 0.16);
        voice.nodes.push(noise);
      }

      const ring = this.ctx!.createOscillator();
      const rg = this.ctx!.createGain();
      ring.type = 'sine';
      ring.frequency.setValueAtTime(2200 * pMod, t + 0.03);
      rg.gain.setValueAtTime(0.0001, t + 0.03);
      rg.gain.linearRampToValueAtTime(0.42, t + 0.036);
      rg.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      ring.connect(rg); rg.connect(out);
      ring.start(t + 0.03); ring.stop(t + 0.3);
      voice.nodes.push(ring);
    } else if (vIdx === 1) {
      // Binary Cleave Strike: punch + metallic strike
      const punch = this.ctx!.createOscillator();
      const pg = this.ctx!.createGain();
      punch.type = 'sine';
      punch.frequency.setValueAtTime(160 * pMod, t);
      punch.frequency.exponentialRampToValueAtTime(50 * pMod, t + 0.06);
      pg.gain.setValueAtTime(0.55, t);
      pg.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      punch.connect(pg); pg.connect(out);
      punch.start(t); punch.stop(t + 0.09);
      voice.nodes.push(punch);

      const clang = this.ctx!.createOscillator();
      const cg = this.ctx!.createGain();
      clang.type = 'triangle';
      clang.frequency.setValueAtTime(1450 * pMod, t + 0.01);
      cg.gain.setValueAtTime(0.0001, t + 0.01);
      cg.gain.linearRampToValueAtTime(0.48, t + 0.015);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      clang.connect(cg); cg.connect(out);
      clang.start(t + 0.01); clang.stop(t + 0.25);
      voice.nodes.push(clang);
    } else {
      // Dual Pixel Cross Slash
      [0, 0.08].forEach((d, i) => {
        const td = t + d;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime((1800 + i * 600) * pMod, td);
        osc.frequency.exponentialRampToValueAtTime(400 * pMod, td + 0.06);
        g.gain.setValueAtTime(0.0001, td);
        g.gain.linearRampToValueAtTime(0.42, td + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, td + 0.08);
        osc.connect(g); g.connect(out);
        osc.start(td); osc.stop(td + 0.09);
        voice.nodes.push(osc);
      });
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 10. SYSTEM STATUS & POWER (Low Battery / Turbine Generator)
  // ------------------------------------------------------------------

  playMascotLowBattery(variantIndex?: number): number {
    const vIdx = this.pickVariant('playMascotLowBattery', variantIndex);
    const v = this.createVoice({ duration: 0.9, volume: 0.7 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.03);

    if (vIdx === 0) {
      // Powerdown Deceleration: 600 Hz -> 60 Hz smooth sweep with relay click
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(600 * pMod, t);
      osc.frequency.exponentialRampToValueAtTime(60 * pMod, t + 0.65);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      osc.connect(g); g.connect(out);
      osc.start(t); osc.stop(t + 0.72);
      voice.nodes.push(osc);
    } else if (vIdx === 1) {
      // Low Battery Pulse: 2 soft, discreet pulses (880 Hz -> 587 Hz)
      const beeps = [{ f: 880, dt: 0 }, { f: 587.33, dt: 0.14 }];
      beeps.forEach((b) => {
        const tb = t + b.dt;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(b.f * pMod, tb);
        g.gain.setValueAtTime(0.0001, tb);
        g.gain.linearRampToValueAtTime(0.42, tb + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, tb + 0.1);
        osc.connect(g); g.connect(out);
        osc.start(tb); osc.stop(tb + 0.12);
        voice.nodes.push(osc);
      });
    } else {
      // Power Relay Standby Click
      const click = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      click.type = 'square';
      click.frequency.setValueAtTime(320 * pMod, t);
      g.gain.setValueAtTime(0.45, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
      click.connect(g); g.connect(out);
      click.start(t); click.stop(t + 0.025);
      voice.nodes.push(click);
    }
    return vIdx;
  }

  playMascotTurbine(variantIndex?: number): number {
    const vIdx = this.pickVariant('playMascotTurbine', variantIndex);
    const v = this.createVoice({ duration: 0.85, volume: 0.7 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.03);

    if (vIdx === 0) {
      // Jet / Reactor Spool-Up: 120 Hz -> 480 Hz warm filtered saw
      const spool = this.ctx!.createOscillator();
      const f = this.ctx!.createBiquadFilter();
      const g = this.ctx!.createGain();
      spool.type = 'sawtooth';
      spool.frequency.setValueAtTime(120 * pMod, t);
      spool.frequency.exponentialRampToValueAtTime(480 * pMod, t + 0.5);
      f.type = 'lowpass';
      f.frequency.setValueAtTime(600, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.48, t + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
      spool.connect(f); f.connect(g); g.connect(out);
      spool.start(t); spool.stop(t + 0.7);
      voice.nodes.push(spool);
    } else if (vIdx === 1) {
      // Plasma Flux Core: 60 Hz hum with smooth resonance
      const hum = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      hum.type = 'sine';
      hum.frequency.setValueAtTime(60.0 * pMod, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      hum.connect(g); g.connect(out);
      hum.start(t); hum.stop(t + 0.75);
      voice.nodes.push(hum);
    } else {
      // Pulsing Reactor Heartbeat: 2 soft bass pulses (70 Hz)
      [0, 0.22].forEach((dp) => {
        const tp = t + dp;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(70 * pMod, tp);
        g.gain.setValueAtTime(0.0001, tp);
        g.gain.linearRampToValueAtTime(0.52, tp + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, tp + 0.18);
        osc.connect(g); g.connect(out);
        osc.start(tp); osc.stop(tp + 0.2);
        voice.nodes.push(osc);
      });
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 11. SENSOR POLISH & NANO COFFEE (Micro-Precision Foley)
  // ------------------------------------------------------------------

  playMascotSensorPolish(variantIndex?: number): number {
    const vIdx = this.pickVariant('playMascotSensorPolish', variantIndex);
    const v = this.createVoice({ duration: 0.6, volume: 0.7 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.03);

    if (vIdx === 0) {
      // Micro-Servo Calibration & Lens Ding: 300 Hz -> 500 Hz servo + 2.2 kHz crystal chime
      const servo = this.ctx!.createOscillator();
      const sg = this.ctx!.createGain();
      servo.type = 'triangle';
      servo.frequency.setValueAtTime(300 * pMod, t);
      servo.frequency.exponentialRampToValueAtTime(500 * pMod, t + 0.08);
      sg.gain.setValueAtTime(0.0001, t);
      sg.gain.linearRampToValueAtTime(0.42, t + 0.015);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      servo.connect(sg); sg.connect(out);
      servo.start(t); servo.stop(t + 0.12);
      voice.nodes.push(servo);

      const tDing = t + 0.1;
      const ding = this.ctx!.createOscillator();
      const dg = this.ctx!.createGain();
      ding.type = 'sine';
      ding.frequency.setValueAtTime(2200 * pMod, tDing);
      dg.gain.setValueAtTime(0.0001, tDing);
      dg.gain.linearRampToValueAtTime(0.48, tDing + 0.003);
      dg.gain.exponentialRampToValueAtTime(0.0001, tDing + 0.35);
      ding.connect(dg); dg.connect(out);
      ding.start(tDing); ding.stop(tDing + 0.38);
      voice.nodes.push(ding);
    } else if (vIdx === 1) {
      // Microfiber Friction Wipe: 2 soft filtered pink noise sweeps
      [0, 0.12].forEach((dw) => {
        const tw = t + dw;
        const noise = this.getPink();
        if (noise) {
          const f = this.ctx!.createBiquadFilter();
          const g = this.ctx!.createGain();
          f.type = 'bandpass';
          f.frequency.setValueAtTime(2800 * pMod, tw);
          f.Q.value = 2.5;
          g.gain.setValueAtTime(0.0001, tw);
          g.gain.linearRampToValueAtTime(0.4, tw + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, tw + 0.08);
          noise.connect(f); f.connect(g); g.connect(out);
          noise.start(tw); noise.stop(tw + 0.09);
          voice.nodes.push(noise);
        }
      });
    } else {
      // Optical Lens Focus Pulse: 440 Hz -> 880 Hz clean harmonic
      const pulse = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      pulse.type = 'sine';
      pulse.frequency.setValueAtTime(440 * pMod, t);
      pulse.frequency.exponentialRampToValueAtTime(880 * pMod, t + 0.08);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.46, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      pulse.connect(g); g.connect(out);
      pulse.start(t); pulse.stop(t + 0.28);
      voice.nodes.push(pulse);
    }
    return vIdx;
  }

  playMascotNanoCoffee(variantIndex?: number): number {
    const vIdx = this.pickVariant('playMascotNanoCoffee', variantIndex);
    const v = this.createVoice({ duration: 0.7, volume: 0.7 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.03);

    if (vIdx === 0) {
      // Steam & 3 Droplet Pings: pink noise steam + 3 liquid drops
      const steam = this.getPink();
      if (steam) {
        const f = this.ctx!.createBiquadFilter();
        const g = this.ctx!.createGain();
        f.type = 'bandpass';
        f.frequency.setValueAtTime(3200 * pMod, t);
        f.Q.value = 2.5;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.38, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        steam.connect(f); f.connect(g); g.connect(out);
        steam.start(t); steam.stop(t + 0.25);
        voice.nodes.push(steam);
      }

      const drops = [{ dt: 0.18, f: 820 }, { dt: 0.28, f: 1080 }, { dt: 0.38, f: 1320 }];
      drops.forEach((d) => {
        const td = t + d.dt;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(d.f * pMod, td);
        osc.frequency.exponentialRampToValueAtTime(d.f * 1.5 * pMod, td + 0.02);
        g.gain.setValueAtTime(0.0001, td);
        g.gain.linearRampToValueAtTime(0.45, td + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, td + 0.04);
        osc.connect(g); g.connect(out);
        osc.start(td); osc.stop(td + 0.05);
        voice.nodes.push(osc);
      });
    } else if (vIdx === 1) {
      // Cup Clink & Warm Glow Chime
      const clink = this.ctx!.createOscillator();
      const cg = this.ctx!.createGain();
      clink.type = 'triangle';
      clink.frequency.setValueAtTime(1450 * pMod, t);
      cg.gain.setValueAtTime(0.0001, t);
      cg.gain.linearRampToValueAtTime(0.48, t + 0.003);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      clink.connect(cg); cg.connect(out);
      clink.start(t); clink.stop(t + 0.15);
      voice.nodes.push(clink);

      const chime = this.ctx!.createOscillator();
      const chg = this.ctx!.createGain();
      chime.type = 'sine';
      chime.frequency.setValueAtTime(880 * pMod, t + 0.05);
      chg.gain.setValueAtTime(0.0001, t + 0.05);
      chg.gain.linearRampToValueAtTime(0.42, t + 0.06);
      chg.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      chime.connect(chg); chg.connect(out);
      chime.start(t + 0.05); chime.stop(t + 0.42);
      voice.nodes.push(chime);
    } else {
      // Espresso Drip Swirl
      const drip = this.ctx!.createOscillator();
      const dg = this.ctx!.createGain();
      drip.type = 'sine';
      drip.frequency.setValueAtTime(950 * pMod, t);
      drip.frequency.exponentialRampToValueAtTime(1600 * pMod, t + 0.035);
      dg.gain.setValueAtTime(0.46, t);
      dg.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      drip.connect(dg); dg.connect(out);
      drip.start(t); drip.stop(t + 0.06);
      voice.nodes.push(drip);
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 12. DATA, FLOWCHART & VICTORY (Zero Errors / Flowchart / Fanfare)
  // ------------------------------------------------------------------

  playHackerZeroErrors(variantIndex?: number): number {
    const vIdx = this.pickVariant('playHackerZeroErrors', variantIndex);
    const v = this.createVoice({ duration: 0.8, volume: 0.75 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.01);

    if (vIdx === 0) {
      // 8-Bit NES Victory Fanfare: C5 -> E5 -> G5 -> C6
      const melody = [
        { f: 523.25, dt: 0, dur: 0.07 },
        { f: 659.25, dt: 0.075, dur: 0.07 },
        { f: 783.99, dt: 0.15, dur: 0.07 },
        { f: 1046.5, dt: 0.225, dur: 0.35 },
      ];
      melody.forEach((m) => {
        const tm = t + m.dt;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(m.f * pMod, tm);
        g.gain.setValueAtTime(0.0001, tm);
        g.gain.linearRampToValueAtTime(0.48, tm + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, tm + m.dur);
        osc.connect(g); g.connect(out);
        osc.start(tm); osc.stop(tm + m.dur + 0.01);
        voice.nodes.push(osc);
      });
    } else if (vIdx === 1) {
      // Cyberpunk Synthwave Major Stab: F# Major (370, 466, 554 Hz)
      const chord = [369.99, 466.16, 554.37];
      chord.forEach((freq) => {
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        const f = this.ctx!.createBiquadFilter();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq * pMod, t);
        f.type = 'lowpass';
        f.frequency.setValueAtTime(1200, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.38 / chord.length, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
        osc.connect(f); f.connect(g); g.connect(out);
        osc.start(t); osc.stop(t + 0.6);
        voice.nodes.push(osc);
      });
    } else {
      // Level-Up Sparkle Cascade: E5 -> G#5 -> B5 -> E6
      const arpeggio = [
        { f: 659.25, dt: 0 },
        { f: 830.61, dt: 0.05 },
        { f: 987.77, dt: 0.1 },
        { f: 1318.51, dt: 0.15 },
      ];
      arpeggio.forEach((n, idx) => {
        const tn = t + n.dt;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(n.f * pMod, tn);
        const dur = idx === arpeggio.length - 1 ? 0.35 : 0.08;
        g.gain.setValueAtTime(0.0001, tn);
        g.gain.linearRampToValueAtTime(0.45, tn + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, tn + dur);
        osc.connect(g); g.connect(out);
        osc.start(tn); osc.stop(tn + dur + 0.01);
        voice.nodes.push(osc);
      });
    }
    return vIdx;
  }

  playHackerFlowchart(variantIndex?: number): number {
    const vIdx = this.pickVariant('playHackerFlowchart', variantIndex);
    const v = this.createVoice({ duration: 0.45, volume: 0.7 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.03);

    if (vIdx === 0) {
      // Discrete Relay Ticks: 3 micro-ticks
      [1200, 1600, 2000].forEach((freq, i) => {
        const tc = t + i * 0.065;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq * pMod, tc);
        g.gain.setValueAtTime(0.0001, tc);
        g.gain.linearRampToValueAtTime(0.45, tc + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, tc + 0.025);
        osc.connect(g); g.connect(out);
        osc.start(tc); osc.stop(tc + 0.03);
        voice.nodes.push(osc);
      });
    } else if (vIdx === 1) {
      // Data Stream Routing: 4-step rapid clock pulses
      [1800, 2200, 2600, 3200].forEach((freq, i) => {
        const tp = t + i * 0.025;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq * pMod, tp);
        g.gain.setValueAtTime(0.0001, tp);
        g.gain.linearRampToValueAtTime(0.42, tp + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, tp + 0.02);
        osc.connect(g); g.connect(out);
        osc.start(tp); osc.stop(tp + 0.025);
        voice.nodes.push(osc);
      });
    } else {
      // Logic Gate Toggle: 440 Hz -> 880 Hz flip-flop
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440.0 * pMod, t);
      osc.frequency.setValueAtTime(880.0 * pMod, t + 0.035);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.48, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(g); g.connect(out);
      osc.start(t); osc.stop(t + 0.2);
      voice.nodes.push(osc);
    }
    return vIdx;
  }

  // ------------------------------------------------------------------
  // 13. ASCENSION, CHEER, EASTER EGG & UNIVERSAL CHIME
  // ------------------------------------------------------------------

  playAscensionRitual(variantIndex?: number): number {
    const vIdx = this.pickVariant('playAscensionRitual', variantIndex);
    const v = this.createVoice({ duration: 2.2, volume: 0.75 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.01);

    if (vIdx === 0) {
      // Celestial Quantum Chord: Sub-bass anchor + F# Major Pad (370, 466, 554, 740 Hz)
      const sub = this.ctx!.createOscillator();
      const subG = this.ctx!.createGain();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(55 * pMod, t);
      subG.gain.setValueAtTime(0.0001, t);
      subG.gain.linearRampToValueAtTime(0.48, t + 0.08);
      subG.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
      sub.connect(subG); subG.connect(out);
      sub.start(t); sub.stop(t + 1.25);
      voice.nodes.push(sub);

      const chord = [369.99, 466.16, 554.37, 739.99];
      chord.forEach((freq, idx) => {
        const tn = t + idx * 0.06;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq * pMod, tn);
        g.gain.setValueAtTime(0.0001, tn);
        g.gain.linearRampToValueAtTime(0.38 / chord.length, tn + 0.08);
        g.gain.exponentialRampToValueAtTime(0.0001, tn + 1.4);
        osc.connect(g); g.connect(out);
        osc.start(tn); osc.stop(tn + 1.45);
        voice.nodes.push(osc);
      });
    } else if (vIdx === 1) {
      // Singularity Sweep: 80 Hz -> 40 Hz sub-glide + rising harmonic
      const sweep = this.ctx!.createOscillator();
      const sg = this.ctx!.createGain();
      sweep.type = 'triangle';
      sweep.frequency.setValueAtTime(80 * pMod, t);
      sweep.frequency.exponentialRampToValueAtTime(40 * pMod, t + 1.1);
      sg.gain.setValueAtTime(0.0001, t);
      sg.gain.linearRampToValueAtTime(0.5, t + 0.08);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + 1.15);
      sweep.connect(sg); sg.connect(out);
      sweep.start(t); sweep.stop(t + 1.2);
      voice.nodes.push(sweep);
    } else {
      // Grand Architect Brass Fanfare: F# Major chord progression
      const freqs = [369.99, 466.16, 554.37, 739.99];
      freqs.forEach((f0) => {
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        const f = this.ctx!.createBiquadFilter();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(f0 * pMod, t);
        f.type = 'lowpass';
        f.frequency.setValueAtTime(1400, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.36 / freqs.length, t + 0.04);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
        osc.connect(f); f.connect(g); g.connect(out);
        osc.start(t); osc.stop(t + 0.95);
        voice.nodes.push(osc);
      });
    }
    return vIdx;
  }

  playActionCheer(variantIndex?: number): number {
    const vIdx = this.pickVariant('playActionCheer', variantIndex);
    const v = this.createVoice({ duration: 0.6, volume: 0.75 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.02);

    if (vIdx === 0) {
      // Dual Bell Chime: 1760 Hz & 2637 Hz pure sines
      [1760.0, 2637.0].forEach((freq, i) => {
        const tc = t + i * 0.05;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq * pMod, tc);
        g.gain.setValueAtTime(0.0001, tc);
        g.gain.linearRampToValueAtTime(0.48, tc + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, tc + 0.35);
        osc.connect(g); g.connect(out);
        osc.start(tc); osc.stop(tc + 0.38);
        voice.nodes.push(osc);
      });
    } else if (vIdx === 1) {
      // Golden Coin Chime: C7 / E7 / G7
      [2093.0, 2637.02, 3135.96].forEach((freq, i) => {
        const tc = t + i * 0.065;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq * pMod, tc);
        g.gain.setValueAtTime(0.0001, tc);
        g.gain.linearRampToValueAtTime(0.45, tc + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, tc + 0.28);
        osc.connect(g); g.connect(out);
        osc.start(tc); osc.stop(tc + 0.3);
        voice.nodes.push(osc);
      });
    } else {
      // Joyful Reward Fanfare: C6-E6-G6-C7
      const notes = [
        { f: 1046.5, dt: 0, dur: 0.05 },
        { f: 1318.51, dt: 0.055, dur: 0.05 },
        { f: 1567.98, dt: 0.11, dur: 0.05 },
        { f: 2093.0, dt: 0.165, dur: 0.3 },
      ];
      notes.forEach((m) => {
        const tm = t + m.dt;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(m.f * pMod, tm);
        g.gain.setValueAtTime(0.0001, tm);
        g.gain.linearRampToValueAtTime(0.48, tm + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, tm + m.dur);
        osc.connect(g); g.connect(out);
        osc.start(tm); osc.stop(tm + m.dur + 0.01);
        voice.nodes.push(osc);
      });
    }
    return vIdx;
  }

  playEasterEggDisk(variantIndex?: number): number {
    const vIdx = this.pickVariant('playEasterEggDisk', variantIndex);
    const v = this.createVoice({ duration: 0.7, volume: 0.75 });
    if (!v) return -1;
    const { out, t, voice } = v;
    const pMod = this.jitter(0.03);

    if (vIdx === 0) {
      // Holo-Disk Shimmer Toss: 600 Hz -> 1400 Hz -> 700 Hz filtered sweep
      const osc = this.ctx!.createOscillator();
      const f = this.ctx!.createBiquadFilter();
      const g = this.ctx!.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(600 * pMod, t);
      osc.frequency.exponentialRampToValueAtTime(1400 * pMod, t + 0.2);
      osc.frequency.exponentialRampToValueAtTime(700 * pMod, t + 0.5);
      f.type = 'lowpass';
      f.frequency.setValueAtTime(2000, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.48, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      osc.connect(f); f.connect(g); g.connect(out);
      osc.start(t); osc.stop(t + 0.58);
      voice.nodes.push(osc);
    } else if (vIdx === 1) {
      // Magnetic Rail Discharge: 2400 Hz -> 400 Hz
      const rail = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      rail.type = 'sine';
      rail.frequency.setValueAtTime(2400 * pMod, t);
      rail.frequency.exponentialRampToValueAtTime(400 * pMod, t + 0.3);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      rail.connect(g); g.connect(out);
      rail.start(t); rail.stop(t + 0.48);
      voice.nodes.push(rail);
    } else {
      // Harmonic Ring: G6 / D7 / G7 sines
      const ringFreqs = [1568.0, 2349.3, 3136.0];
      ringFreqs.forEach((freq) => {
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq * pMod, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.45 / ringFreqs.length, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        osc.connect(g); g.connect(out);
        osc.start(t); osc.stop(t + 0.52);
        voice.nodes.push(osc);
      });
    }
    return vIdx;
  }

  playChime(variantIndex?: number): number {
    const vIdx = this.pickVariant('playChime', variantIndex);
    const v = this.createVoice({ duration: 0.55, volume: 0.7 });
    if (!v) return -1;
    const { out, t, voice } = v;

    if (vIdx === 0) {
      // Crystal Ping: pure 1760 Hz with soft attack and decay
      const osc = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1760.0 * this.jitter(0.01), t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.48, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      osc.connect(g); g.connect(out);
      osc.start(t); osc.stop(t + 0.42);
      voice.nodes.push(osc);
    } else if (vIdx === 1) {
      // Warm Double Marimba Bell: A5 -> C#6 (880 Hz -> 1108 Hz)
      [
        { f: 880.0, dt: 0, dur: 0.2 },
        { f: 1108.73, dt: 0.08, dur: 0.32 },
      ].forEach((n) => {
        const tn = t + n.dt;
        const osc = this.ctx!.createOscillator();
        const g = this.ctx!.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(n.f * this.jitter(0.01), tn);
        g.gain.setValueAtTime(0.0001, tn);
        g.gain.linearRampToValueAtTime(0.46, tn + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, tn + n.dur);
        osc.connect(g); g.connect(out);
        osc.start(tn); osc.stop(tn + n.dur + 0.02);
        voice.nodes.push(osc);
      });
    } else {
      // Soft Synth Acknowledge: F Major chord (349, 440, 523 Hz)
      const chord = [349.23, 440.0, 523.25];
      chord.forEach((f0) => {
        const osc = this.ctx!.createOscillator();
        const f = this.ctx!.createBiquadFilter();
        const g = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(f0, t);
        f.type = 'lowpass';
        f.frequency.setValueAtTime(800, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.42 / chord.length, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        osc.connect(f); f.connect(g); g.connect(out);
        osc.start(t); osc.stop(t + 0.38);
        voice.nodes.push(osc);
      });
    }
    return vIdx;
  }
}

export const petAudio = new PetAudioEngine();
