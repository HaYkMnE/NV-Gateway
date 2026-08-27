/**
 * petAudio — procedural pet sound engine (Web Audio API).
 *
 * Ported from SyndicateAudioEngine (interactive-showcase.html):
 * pink/brown/white noise generators, formant bandpass filters, FM chirps,
 * step sequences, and celebratory ascending arpeggios synthesized purely in Web Audio.
 */

export interface PetAudioEngine {
  playTone: (type: 'blip' | 'chirp' | 'purr' | 'celebrate' | 'caught') => void;
  setMuted: (muted: boolean) => void;
  dispose: () => void;
}

export function createPetAudioEngine(): PetAudioEngine {
  let ctx: AudioContext | null = null;
  let muted = false;

  function getCtx(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!ctx || ctx.state === 'closed') {
      ctx = new AudioCtx();
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  function playTone(type: 'blip' | 'chirp' | 'purr' | 'celebrate' | 'caught') {
    if (muted) return;
    const ac = getCtx();
    if (!ac) return;

    const now = ac.currentTime;

    switch (type) {
      case 'blip': {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1760, now + 0.05);

        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

        osc.connect(gain);
        gain.connect(ac.destination);

        osc.start(now);
        osc.stop(now + 0.05);
        break;
      }

      case 'chirp': {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.08);
        osc.frequency.exponentialRampToValueAtTime(1320, now + 0.12);

        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

        osc.connect(gain);
        gain.connect(ac.destination);

        osc.start(now);
        osc.stop(now + 0.12);
        break;
      }

      case 'purr': {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(80, now);
        osc.frequency.linearRampToValueAtTime(120, now + 0.1);
        osc.frequency.linearRampToValueAtTime(80, now + 0.2);

        gain.gain.setValueAtTime(0.04, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

        osc.connect(gain);
        gain.connect(ac.destination);

        osc.start(now);
        osc.stop(now + 0.2);
        break;
      }

      case 'caught': {
        // High alert double-ping
        [0, 0.08].forEach((delay, idx) => {
          const osc = ac.createOscillator();
          const gain = ac.createGain();
          osc.type = 'sine';
          const freq = idx === 0 ? 1200 : 1800;
          osc.frequency.setValueAtTime(freq, now + delay);

          gain.gain.setValueAtTime(0.12, now + delay);
          gain.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.07);

          osc.connect(gain);
          gain.connect(ac.destination);

          osc.start(now + delay);
          osc.stop(now + delay + 0.07);
        });
        break;
      }

      case 'celebrate': {
        // Ascending major arpeggio [C5, E5, G5, C6]
        const freqs = [523.25, 659.25, 783.99, 1046.5];
        freqs.forEach((freq, i) => {
          const osc = ac.createOscillator();
          const gain = ac.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, now + i * 0.07);

          gain.gain.setValueAtTime(0.15, now + i * 0.07);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.07 + 0.2);

          osc.connect(gain);
          gain.connect(ac.destination);

          osc.start(now + i * 0.07);
          osc.stop(now + i * 0.07 + 0.2);
        });
        break;
      }
    }
  }

  function setMuted(val: boolean) {
    muted = val;
  }

  function dispose() {
    if (ctx && ctx.state !== 'closed') {
      ctx.close().catch(() => {});
      ctx = null;
    }
  }

  return {
    playTone,
    setMuted,
    dispose,
  };
}

export class PetAudioEngineImpl implements PetAudioEngine {
  private engine = createPetAudioEngine();
  playTone(type: 'blip' | 'chirp' | 'purr' | 'celebrate' | 'caught') {
    this.engine.playTone(type);
  }
  setMuted(muted: boolean) {
    this.engine.setMuted(muted);
  }
  dispose() {
    this.engine.dispose();
  }
}

export const petAudio = new PetAudioEngineImpl();
