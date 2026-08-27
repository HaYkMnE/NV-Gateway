/**
 * NV-GATEWAY - Procedural WebAudio Synthesis Engine
 * 
 * Zero external audio samples. Everything synthesized mathematically via Web Audio API.
 * Includes retro 8-bit sound effects, Cyberpunk UI feedback, ambient hums,
 * keyboard click synthesis, coin chimes, and purring drone effects.
 */

class AudioEngine {
  private ctx: AudioContext | null = null;
  private isMuted: boolean = false;
  private masterGain: GainNode | null = null;
  private purrOsc: OscillatorNode | null = null;
  private purrGain: GainNode | null = null;
  private ambientGain: GainNode | null = null;

  constructor() {
    // Load mute state from localStorage if available
    try {
      const storedMute = localStorage.getItem('nv_pet_sound_muted');
      this.isMuted = storedMute === 'true';
    } catch {
      this.isMuted = false;
    }
  }

  private initContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : 0.4, this.ctx.currentTime);
        this.masterGain.connect(this.ctx.destination);
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  public toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    try {
      localStorage.setItem('nv_pet_sound_muted', String(this.isMuted));
    } catch {}

    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.isMuted ? 0 : 0.4, this.ctx.currentTime, 0.05);
    }
    return this.isMuted;
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  /**
   * Sound: Keyboard Mechanical Switch Click (Cherry MX Blue style)
   */
  public playKeyClick(): void {
    if (this.isMuted) return;
    const ctx = this.initContext();
    if (!ctx || !this.masterGain) return;

    const t = ctx.currentTime;
    // High frequency transient click
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1200 + Math.random() * 800, t);
    osc.frequency.exponentialRampToValueAtTime(100, t + 0.03);

    filter.type = 'highpass';
    filter.frequency.setValueAtTime(800, t);

    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.025);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    osc.start(t);
    osc.stop(t + 0.03);

    // Subtle low bottom-out thump
    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(140 + Math.random() * 40, t + 0.005);
    subOsc.frequency.exponentialRampToValueAtTime(40, t + 0.04);
    subGain.gain.setValueAtTime(0.2, t + 0.005);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

    subOsc.connect(subGain);
    subGain.connect(this.masterGain);

    subOsc.start(t + 0.005);
    subOsc.stop(t + 0.045);
  }

  /**
   * Sound: Laser / Blade Bug Slash
   */
  public playBugSlash(): void {
    if (this.isMuted) return;
    const ctx = this.initContext();
    if (!ctx || !this.masterGain) return;

    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(1800, t);
    osc.frequency.exponentialRampToValueAtTime(80, t + 0.15);

    gain.gain.setValueAtTime(0.3, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(t);
    osc.stop(t + 0.16);
  }

  /**
   * Sound: Dev Tip Jar Coin Drop (Dual bell chime)
   */
  public playCoinDrop(): void {
    if (this.isMuted) return;
    const ctx = this.initContext();
    if (!ctx || !this.masterGain) return;

    const t = ctx.currentTime;

    [987.77, 1318.51, 1975.53].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + idx * 0.08);

      gain.gain.setValueAtTime(0.25, t + idx * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.08 + 0.4);

      osc.connect(gain);
      gain.connect(this.masterGain!);

      osc.start(t + idx * 0.08);
      osc.stop(t + idx * 0.08 + 0.45);
    });
  }

  /**
   * Sound: Cyber Coffee Slurp / Power Injection
   */
  public playCoffeeSip(): void {
    if (this.isMuted) return;
    const ctx = this.initContext();
    if (!ctx || !this.masterGain) return;

    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(900, t + 0.25);

    gain.gain.setValueAtTime(0.1, t);
    gain.gain.linearRampToValueAtTime(0.2, t + 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(t);
    osc.stop(t + 0.32);
  }

  /**
   * Sound: Cute Cyber Purr / Sleep Cycle (starts/stops continuous oscillator)
   */
  public startPurr(): void {
    if (this.isMuted || this.purrOsc) return;
    const ctx = this.initContext();
    if (!ctx || !this.masterGain) return;

    const t = ctx.currentTime;
    this.purrOsc = ctx.createOscillator();
    this.purrGain = ctx.createGain();

    this.purrOsc.type = 'sine';
    this.purrOsc.frequency.setValueAtTime(45, t);

    // LFO to modulate purr amplitude rhythmically
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(2.2, t); // 2.2 Hz breathing cycle
    lfoGain.gain.setValueAtTime(0.08, t);

    lfo.connect(lfoGain);
    lfoGain.connect(this.purrGain.gain);

    this.purrGain.gain.setValueAtTime(0.05, t);
    this.purrOsc.connect(this.purrGain);
    this.purrGain.connect(this.masterGain);

    lfo.start(t);
    this.purrOsc.start(t);
  }

  public stopPurr(): void {
    if (this.purrOsc) {
      try {
        this.purrOsc.stop();
        this.purrOsc.disconnect();
      } catch {}
      this.purrOsc = null;
    }
  }

  /**
   * Sound: Hologram Level-Up / VIP Salute Fanfare
   */
  public playLevelUp(): void {
    if (this.isMuted) return;
    const ctx = this.initContext();
    if (!ctx || !this.masterGain) return;

    const t = ctx.currentTime;
    const notes = [440, 554.37, 659.25, 880, 1108.73, 1318.51];

    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t + idx * 0.06);

      gain.gain.setValueAtTime(0.2, t + idx * 0.06);
      gain.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.06 + 0.35);

      osc.connect(gain);
      gain.connect(this.masterGain!);

      osc.start(t + idx * 0.06);
      osc.stop(t + idx * 0.06 + 0.4);
    });
  }

  /**
   * Sound: Subtle hover glitch chirp
   */
  public playHoverChirp(): void {
    if (this.isMuted) return;
    const ctx = this.initContext();
    if (!ctx || !this.masterGain) return;

    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(2400, t);
    osc.frequency.exponentialRampToValueAtTime(3200, t + 0.04);

    gain.gain.setValueAtTime(0.04, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(t);
    osc.stop(t + 0.045);
  }
}

export const audioEngine = new AudioEngine();
