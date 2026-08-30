/**
 * PetWidget — NV-GATEWAY // autonomous desktop pet widget (dual-character host).
 *
 * Visual layer ported from nvgateway-donation-mockups/interactive-showcase.html:
 *   - Cyber Mascot kinematic SVG rig (chassis / neck bellow / head / arm rigs,
 *     claw pivots 16px 94px & 114px 94px, split thruster flames m-flame-left/right,
 *     props nested inside the claws, permanent-VIP shades/crown/halo/reactor,
 *     quantum ring stroke-dash animations)
 *   - Pixel Hacker Canvas 2D engine (160x152 backing store displayed at 80x76,
 *     pixelated; matrix rain, chair/desk/keyboard, hooded sprite, all activity
 *     sequences, VIP gold variants)
 *   - Widget chrome: patron badge, one-click sound toggle (localStorage
 *     `nv_pet_sound`), CAUGHT-IN-THE-ACT cue badge, thought cloud.
 *
 * Logic layer comes from ./petEngine (createPetEngine state machine +
 * attachFocusListeners attention rules) and ./audioEngine (petAudio procedural
 * SFX + ambient cadence). All styles are co-located in an inline <style> block
 * scoped under `.nv-pet-wrap` (same pattern as DonationModal).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './pet.css';
import { petAudio } from './audioEngine';
import {
  createPetEngine,
  type PetActivity,
  type PetCharacter,
  type PetEngine,
  type VipActivity,
} from './petEngine';

type AnyActivity = PetActivity | VipActivity;

// ==========================================
// STORAGE
// ==========================================

export const VIP_STORAGE_KEY = 'nv_pet_vip';
export const VIP_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;
const SOUND_STORAGE_KEY = 'nv_pet_sound';

export function readVipFlag(): boolean {
  try {
    const raw = window.localStorage.getItem(VIP_STORAGE_KEY);
    if (raw === null) {
      return false;
    }
    // Support legacy '1' by migrating it to current timestamp
    if (raw === '1') {
      window.localStorage.setItem(VIP_STORAGE_KEY, Date.now().toString());
      return true;
    }
    const timestamp = Number(raw);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      window.localStorage.removeItem(VIP_STORAGE_KEY);
      return false;
    }
    const now = Date.now();
    const elapsed = now - timestamp;
    if (elapsed >= 0 && elapsed < VIP_EXPIRATION_MS) {
      return true;
    }
    window.localStorage.removeItem(VIP_STORAGE_KEY);
    return false;
  } catch {
    return false;
  }
}

function readSoundPreference(): boolean {
  try {
    return window.localStorage.getItem(SOUND_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function persistSoundPreference(on: boolean): void {
  try {
    window.localStorage.setItem(SOUND_STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable — pref simply won't persist */
  }
}

// ==========================================
// WINDOW AUDIBILITY (П7 — silence unless the window is genuinely active)
// ==========================================

/** The minimal window surface this predicate needs (keeps it unit-testable). */
export interface AudibilityWindow {
  document: {
    visibilityState?: string;
    hasFocus?: () => boolean;
  };
}

/**
 * Whether the window is active enough to make noise.
 *
 * WHY hasFocus() IS THE PRIMARY SIGNAL — measured, not assumed. Three states
 * must be told apart, and `visibilityState` alone cannot do it:
 *
 *   1. visible but UNFOCUSED (user working in another app):
 *      hasFocus() false, visibilityState stays "visible".
 *   2. MINIMISED: hasFocus() false, visibilityState "hidden".
 *   3. HIDDEN TO TRAY (the reported complaint — renderer keeps running):
 *      hasFocus() false; whether visibilityState flips to "hidden" is not
 *      something this code may rely on.
 *
 * Case 1 proves visibilityState is insufficient, and case 3 is the one the user
 * actually complained about, so hasFocus() carries the decision. visibilityState
 * is kept as a cheap additional veto, never as the sole signal.
 *
 * Degrades rather than going permanently mute: in an environment without
 * document.hasFocus, gating falls back to visibility alone instead of silencing
 * the pet forever.
 */
export function windowAudible(win: AudibilityWindow): boolean {
  const doc = win.document;
  if (doc.visibilityState !== undefined && doc.visibilityState !== 'visible') return false;
  if (typeof doc.hasFocus === 'function') return doc.hasFocus() === true;
  return true;
}

// ==========================================
// THOUGHT CLOUD CONTENT (per activity)
// Texts live in the i18n pet_* namespace (pet_thought_<slug>_<variant>,
// see src/renderer/i18n/resources.ts); only the emoji glyphs stay in-code.
// ==========================================

interface ThoughtVariant {
  emoji: string;
  text: string;
}

/** Emoji glyph per variant — parallel to the pet_thought_* keys below. */
const THOUGHT_EMOJI: Record<string, ReadonlyArray<string>> = {
  'power-nap': ['💤', '😴', '💤'],
  'terminal-nap': ['💤', '😴'],
  'low-battery': ['🪫', '⚡', '🔋', '🥱'],
  'empty-mug': ['☕', '☕', '🥺', '🥱'],
  'code-frenzy': ['⌨️', '🍕', '⚡', '🔥'],
  'bug-hunter': ['🎯', '⚡', '🗡️'],
  'bug-slayer': ['🎯', '⚡', '🗡️'],
  'coin-drop': ['🪙', '✨', '💖'],
  'nano-coffee': ['☕', '✨', '🚀'],
  'turbine-generator': ['🌀', '⚡'],
  'sensor-polish': ['✨', '🔍'],
  'model-juggler': ['💎', '✨'],
  'zero-errors': ['🏆', '🎉'],
  flowchart: ['📈', '📊'],
  'syndicate-salute': ['👑'],
  'espresso-toast': ['☕'],
  'fourth-wall-wink': ['🕶️'],
  'hyper-hack': ['⚡'],
  'quantum-meditation': ['🌌'],
};

/** Localized variant count per activity (pet_thought_<slug>_<0..n-1>). */
const THOUGHT_VARIANT_COUNTS: Record<string, number> = {
  'power-nap': 3,
  'terminal-nap': 2,
  'low-battery': 4,
  'empty-mug': 4,
  'code-frenzy': 4,
  'bug-hunter': 3,
  'bug-slayer': 3,
  'coin-drop': 3,
  'nano-coffee': 3,
  'turbine-generator': 2,
  'sensor-polish': 2,
  'model-juggler': 2,
  'zero-errors': 2,
  flowchart: 2,
  'syndicate-salute': 1,
  'espresso-toast': 1,
  'fourth-wall-wink': 1,
  'hyper-hack': 1,
  'quantum-meditation': 1,
};

function pickThought(activity: AnyActivity, t: (key: string) => string): ThoughtVariant | null {
  const emojis = THOUGHT_EMOJI[activity];
  const count = THOUGHT_VARIANT_COUNTS[activity] ?? 0;
  if (!emojis || count === 0) return null;
  const index = Math.floor(Math.random() * count);
  const slug = activity.replace(/-/g, '_');
  return {
    emoji: emojis[index % emojis.length],
    text: t(`pet_thought_${slug}_${index}`),
  };
}

// ==========================================
// ACTIVITY -> PROCEDURAL SFX (played ONCE per switch)
// ==========================================

const ACTIVITY_SFX: Record<string, () => number> = {
  'bug-hunter': () => petAudio.playMascotBugHunter(),
  'low-battery': () => petAudio.playMascotLowBattery(),
  'turbine-generator': () => petAudio.playMascotTurbine(),
  'sensor-polish': () => petAudio.playMascotSensorPolish(),
  'model-juggler': () => petAudio.playMascotModelJuggler(),
  'nano-coffee': () => petAudio.playMascotNanoCoffee(),
  'power-nap': () => petAudio.playMascotPowerNap(),
  'code-frenzy': () => petAudio.playHackerCodeFrenzy(),
  'zero-errors': () => petAudio.playHackerZeroErrors(),
  'empty-mug': () => petAudio.playHackerEmptyMug(),
  'bug-slayer': () => petAudio.playHackerBugSlayer(),
  'coin-drop': () => petAudio.playHackerCoinDrop(),
  flowchart: () => petAudio.playHackerFlowchart(),
  'terminal-nap': () => petAudio.playHackerTerminalNap(),
  'syndicate-salute': () => petAudio.playAscensionRitual(),
  'espresso-toast': () => petAudio.playMascotNanoCoffee(),
  'fourth-wall-wink': () => petAudio.playMascotSensorPolish(),
  'hyper-hack': () => petAudio.playHackerCodeFrenzy(),
  'quantum-meditation': () => petAudio.playAscensionRitual(),
};

// ==========================================
// HACKER CANVAS MODE MAPPING
// ==========================================

const VIP_ACTIVITY_IDS: ReadonlySet<string> = new Set<VipActivity>([
  'syndicate-salute',
  'espresso-toast',
  'fourth-wall-wink',
  'hyper-hack',
  'quantum-meditation',
]);

/** Map an engine activity id onto the canvas renderer's internal mode id. */
function hackerModeOf(activity: AnyActivity): string {
  return VIP_ACTIVITY_IDS.has(activity) ? `vip-${activity}` : activity;
}

// ==========================================
// COMPONENT
// ==========================================

export interface PetWidgetProps {
  /** Fired when the widget body (not the sound toggle) is clicked. */
  onOpenDonation: () => void;
}

export function PetWidget({ onOpenDonation }: PetWidgetProps): React.JSX.Element {
  const { t } = useTranslation();
  const [isVip, setIsVip] = useState<boolean>(readVipFlag);
  const [soundOn, setSoundOn] = useState<boolean>(readSoundPreference);
  const [character, setCharacter] = useState<PetCharacter>('mascot');
  const [activity, setActivity] = useState<AnyActivity>('bug-hunter');
  const [cueShown, setCueShown] = useState<boolean>(false);
  const [crossfading, setCrossfading] = useState<boolean>(false);
  const [thought, setThought] = useState<ThoughtVariant | null>(null);

  const vipRef = useRef<boolean>(isVip);
  const soundRef = useRef<boolean>(soundOn);
  const activityRef = useRef<AnyActivity>(activity);
  const engineRef = useRef<PetEngine | null>(null);
  const hackerRendererRef = useRef<PixelHackerRenderer | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cueTimerRef = useRef<number | null>(null);
  const fadeTimerRef = useRef<number | null>(null);
  const thoughtTimerRef = useRef<number | null>(null);

  // Keep a stable ref to `t`: react-i18next's translator identity can churn
  // between renders, and if it flowed into a callback used as an effect dep
  // it would tear down + re-mount the engine on every render (each re-mount
  // seeds another activity switch → machine-gunning). The engine must mount
  // exactly once per widget lifetime.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const syncVipFromStorage = useCallback((): void => {
    const vip = readVipFlag();
    vipRef.current = vip;
    setIsVip(vip);
  }, []);

  const showThought = useCallback((act: AnyActivity, durationMs = 6000): void => {
    if (thoughtTimerRef.current !== null) {
      window.clearTimeout(thoughtTimerRef.current);
      thoughtTimerRef.current = null;
    }
    const picked = pickThought(act, tRef.current);
    setThought(picked);
    if (picked !== null) {
      thoughtTimerRef.current = window.setTimeout(() => {
        setThought(null);
        thoughtTimerRef.current = null;
      }, durationMs);
    }
  }, []);

  // Activity switch: re-render character animation, play matching SFX once,
  // show themed thought cloud, re-sync VIP flag (it may have flipped while
  // the donation modal was open).
  //
  // Identity-stable by construction: reads `t` through tRef so this callback
  // never changes identity when the translator instance does.
  const handleActivityChange = useCallback(
    (next: AnyActivity): void => {
      activityRef.current = next;
      setActivity(next);
      syncVipFromStorage();
      // Audio must never take the widget down: the FIRST seeded activity
      // fires this synchronously inside the mount effect, and an uncaught
      // effect error makes React unmount the whole subtree. Losing an SFX
      // is cosmetic; losing the widget is not.
      try {
        ACTIVITY_SFX[next]?.();
      } catch {
        /* procedural SFX is best-effort — ignore engine failures */
      }
      // If a cue is currently active, cue handler will trigger thought cloud sequentially.
      if (cueTimerRef.current === null) {
        showThought(next, 6000);
      }
    },
    [showThought, syncVipFromStorage],
  );

  // CAUGHT IN THE ACT! — fired by the engine when focus returns after away.
  // Sequential display: cue shows for 3500ms first, followed by thought cloud for 6000ms.
  const handleCue = useCallback((): void => {
    if (cueTimerRef.current !== null) {
      window.clearTimeout(cueTimerRef.current);
      cueTimerRef.current = null;
    }
    if (thoughtTimerRef.current !== null) {
      window.clearTimeout(thoughtTimerRef.current);
      thoughtTimerRef.current = null;
    }
    if (fadeTimerRef.current !== null) {
      window.clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }

    // Never show thought simultaneously with cue
    setThought(null);
    setCueShown(true);
    setCrossfading(true);

    fadeTimerRef.current = window.setTimeout(() => {
      setCrossfading(false);
      fadeTimerRef.current = null;
    }, 600);

    cueTimerRef.current = window.setTimeout(() => {
      setCueShown(false);
      cueTimerRef.current = null;
      // Cue finished: sequentially trigger thought cloud for 6000ms
      showThought(activityRef.current, 6000);
    }, 3500);
  }, [showThought]);

  // Engine + audio wiring (mount once).
  useEffect(() => {
    const engine = createPetEngine({
      isVip: () => vipRef.current,
      onActivityChange: handleActivityChange,
      onCue: handleCue,
    });
    engineRef.current = engine;

    // П7 — install the window-audibility gate FIRST, before anything can make
    // a sound. Polled at every sound-production point, so a hide whose
    // blur/visibilitychange never reaches the renderer (the tray case) still
    // ends up silent. This COMPOSES with setEnabled below: the engine requires
    // enabled AND audible, so the user's mute preference is never overridden.
    petAudio.setAudibleGate(() => windowAudible(window));

    // Enable audio BEFORE the first seeded activity so its SFX is audible,
    // and register a user-gesture unlock: Chromium autoplay policy keeps the
    // AudioContext `suspended` until a resume() runs inside a real gesture.
    petAudio.setEnabled(soundRef.current);
    const unlockAudio = (): void => {
      petAudio.unlock();
    };
    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    window.addEventListener('keydown', unlockAudio, { passive: true });

    setCharacter(engine.pickSessionCharacter());
    engine.nextRandomActivity(); // seed a valid random act for this character

    // Single attention-listener path: the engine's attachFocusListeners owns
    // ALL blur/focus/visibilitychange wiring. Ambient audio gating rides the
    // same listeners via hooks (no duplicate listener set here).
    // Attention lost: hard-silence. silenceNow() stops AND RELEASES live
    // oscillator/gain nodes rather than ducking them — a muted graph with
    // running oscillators is a resource leak — and stops the cadence.
    //
    // Both hooks are wrapped: they run from window event listeners, and the
    // same reasoning as window-close-guard.ts applies — a failed sound must
    // never turn into a failed attention transition or take the widget down.
    const stopAmbient = (): void => {
      try {
        petAudio.silenceNow();
      } catch {
        /* audio teardown is best-effort — never break the pet's visuals */
      }
    };
    const startAmbient = (): void => {
      if (!soundRef.current) return;
      try {
        petAudio.scheduleAmbient(() => engineRef.current?.getActivity() ?? 'idle');
      } catch {
        /* re-arming the cadence is best-effort — visuals must survive */
      }
    };
    const detachFocus = engine.attachFocusListeners(window, {
      onAttentionLost: stopAmbient,
      onAttentionGained: startAmbient,
    });

    petAudio.scheduleAmbient(() => engineRef.current?.getActivity() ?? 'idle');

    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === VIP_STORAGE_KEY) syncVipFromStorage();
    };
    window.addEventListener('storage', onStorage);

    // Same-window ascension signal from DonationModal's onAscension (storage
    // events don't fire in the originating window): re-sync VIP flag, then
    // apply the engine's celebration affective overlay (+ hacker confetti).
    const onAscension = (): void => {
      syncVipFromStorage();
      if (readVipFlag()) {
        engineRef.current?.setAffective('celebration');
        hackerRendererRef.current?.setMode('celebration');
      }
    };
    window.addEventListener('nv-pet-ascension', onAscension);

    return () => {
      detachFocus();
      petAudio.stopAmbient();
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('nv-pet-ascension', onAscension);
      if (cueTimerRef.current !== null) window.clearTimeout(cueTimerRef.current);
      if (fadeTimerRef.current !== null) window.clearTimeout(fadeTimerRef.current);
      if (thoughtTimerRef.current !== null) window.clearTimeout(thoughtTimerRef.current);
      engineRef.current = null;
    };
  }, [handleActivityChange, handleCue, syncVipFromStorage]);

  // NOTE: ambient audio focus-gating is wired THROUGH the engine's
  // attachFocusListeners hooks above (single listener path). Do NOT attach a
  // second blur/focus/visibilitychange set here — duplicate wiring was the
  // historical source of fighting listeners and is now merged into one.

  // Hacker canvas renderer lifecycle (only mounted for the hacker character).
  useEffect(() => {
    if (character !== 'hacker') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = PixelHackerRenderer.create(canvas);
    if (!renderer) return;
    hackerRendererRef.current = renderer;
    renderer.start(); // begin the rAF loop (destroy() below cancels it)
    return () => {
      renderer.destroy();
      hackerRendererRef.current = null;
    };
  }, [character]);

  // Activity change -> switch rendered character animation/mode.
  useEffect(() => {
    if (character !== 'hacker') return;
    hackerRendererRef.current?.setMode(hackerModeOf(activity));
  }, [character, activity]);

  // One-click sound toggle (persists to localStorage, never triggers donation).
  const handleToggleSound = useCallback((event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    const next = !soundRef.current;
    soundRef.current = next;
    setSoundOn(next);
    persistSoundPreference(next);
    petAudio.setEnabled(next);
    if (next && engineRef.current) {
      const engine = engineRef.current;
      petAudio.scheduleAmbient(() => engine.getActivity());
    }
  }, []);

  const thoughtTheme = isVip ? 'theme-vip' : character === 'mascot' ? 'theme-mascot' : 'theme-hacker';

  return (
    <div
      className={`nv-pet-wrap${isVip ? ' vip-mode' : ''} act-${activity}${crossfading ? ' activity-crossfade' : ''}`}
    >


      {isVip && (
        <div className="vip-badge" title={t('pet_vip_badge_title')}>
          <span className="vip-badge-glyph">⚡</span>
          <span className="vip-badge-text">{t('pet_vip_badge_text')}</span>
          <span className="vip-badge-glow-dot" />
        </div>
      )}

      <div className="sidebar-widget-wrap">
        {/* ✦ CAUGHT IN THE ACT! attention-return visual cue */}
        <div className={`caught-in-act-cue${cueShown ? ' show' : ''}`} aria-live="polite">
          <span className="cue-sparkle">✦</span>
          <span className="cue-text">{t('pet_caught_cue')}</span>
          <span className="cue-sparkle">✦</span>
        </div>

        {/* Organic floating thought cloud */}
        <div
          className={`thought-cloud-container${thought !== null ? ' show' : ''} ${thoughtTheme}`}
          aria-live="polite"
        >
          <div className="thought-cloud-bubble">
            <span className="thought-emoji">{thought?.emoji ?? '💬'}</span>
            <span className="thought-text">{thought?.text ?? '...'}</span>
          </div>
          <div className="thought-trail">
            <div className="thought-dot thought-dot-1" />
            <div className="thought-dot thought-dot-2" />
          </div>
        </div>

        {/* 1-click neon sound toggle */}
        <button
          type="button"
          className={`widget-sound-toggle${soundOn ? '' : ' muted'}`}
          onClick={handleToggleSound}
          aria-label={soundOn ? t('pet_sound_on_aria') : t('pet_sound_off_aria')}
          title={soundOn ? t('pet_sound_on_tooltip') : t('pet_sound_off_tooltip')}
        >
          <span className="sound-toggle-indicator" />
          <svg className="sound-icon-on" viewBox="0 0 20 20" aria-hidden="true">
            <path
              d="M9 4L4 8H1v4h3l5 4V4z"
              strokeWidth="1.6"
              strokeLinejoin="round"
              fill="currentColor"
              fillOpacity="0.25"
            />
            <path d="M13 7.5a4 4 0 0 1 0 5" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M15.5 5a7.5 7.5 0 0 1 0 10" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <svg className="sound-icon-off" viewBox="0 0 20 20" aria-hidden="true">
            <path
              d="M9 4L4 8H1v4h3l5 4V4z"
              strokeWidth="1.6"
              strokeLinejoin="round"
              fill="currentColor"
              fillOpacity="0.25"
            />
            <line x1="2" y1="2" x2="18" y2="18" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>

        <button
          type="button"
          className="widget-btn"
          onClick={onOpenDonation}
          aria-label={t('pet_support_aria')}
        >
          {character === 'mascot' ? (
            <div className="mascot-viewport">
            <svg className="mascot-svg" viewBox="0 0 130 120" aria-hidden="true">
              <defs>
                <linearGradient id="chassisGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#1E2833" />
                  <stop offset="100%" stopColor="#10161C" />
                </linearGradient>
                <linearGradient id="headGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#1B242E" />
                  <stop offset="100%" stopColor="#0E141A" />
                </linearGradient>
                <linearGradient id="visorGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#050A0E" />
                  <stop offset="100%" stopColor="#020508" />
                </linearGradient>
                <linearGradient id="plasmaGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#FFFFFF" />
                  <stop offset="25%" stopColor="#00F0FF" />
                  <stop offset="85%" stopColor="#33FF00" />
                  <stop offset="100%" stopColor="transparent" />
                </linearGradient>
                <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#FFF070" />
                  <stop offset="60%" stopColor="#FFD028" />
                  <stop offset="100%" stopColor="#B8800A" />
                </linearGradient>
                <linearGradient id="goldVisorGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#FFF59D" />
                  <stop offset="35%" stopColor="#FFD700" />
                  <stop offset="70%" stopColor="#FFB000" />
                  <stop offset="100%" stopColor="#D48800" />
                </linearGradient>
                <radialGradient id="reactorGoldGlow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#FFF59D" stopOpacity="1" />
                  <stop offset="45%" stopColor="#FFB000" stopOpacity="0.85" />
                  <stop offset="100%" stopColor="#FF8F00" stopOpacity="0" />
                </radialGradient>
              </defs>

              {/* SKELETAL RIG ROOT */}
              <g className="m-root-rig">
                {/* 1. JET THRUSTER NOZZLE & INDEPENDENT DUAL PLASMA FLAMES */}
                <g className="m-thruster-rig">
                  <rect x="42" y="96" width="14" height="8" rx="3" fill="#18222B" stroke="#2D3E4E" strokeWidth="1.2" />
                  <rect x="74" y="96" width="14" height="8" rx="3" fill="#18222B" stroke="#2D3E4E" strokeWidth="1.2" />
                  <g className="m-plasma-flame m-flame-left">
                    <polygon points="43,103 55,103 49,118" fill="url(#plasmaGrad)" />
                    <polygon className="m-flame-core" points="46,103 52,103 49,113" fill="#FFFFFF" />
                  </g>
                  <g className="m-plasma-flame m-flame-right">
                    <polygon points="75,103 87,103 81,118" fill="url(#plasmaGrad)" />
                    <polygon className="m-flame-core" points="78,103 84,103 81,113" fill="#FFFFFF" />
                  </g>
                  <circle
                    className="m-thrust-spark spark-1"
                    cx="49"
                    cy="106"
                    r="1.5"
                    fill="#33FF00"
                    style={{ '--sx': '-4px' } as React.CSSProperties}
                  />
                  <circle
                    className="m-thrust-spark spark-2"
                    cx="81"
                    cy="107"
                    r="1.5"
                    fill="#00F0FF"
                    style={{ '--sx': '5px' } as React.CSSProperties}
                  />
                  <circle
                    className="m-thrust-spark spark-3"
                    cx="65"
                    cy="108"
                    r="1.2"
                    fill="#FFFFFF"
                    style={{ '--sx': '-1px' } as React.CSSProperties}
                  />
                </g>

                {/* 2. MAIN TORSO / CHASSIS POD */}
                <g className="m-torso-chassis">
                  <rect x="36" y="68" width="58" height="32" rx="14" fill="url(#chassisGrad)" stroke="#324458" strokeWidth="1.5" />
                  <line x1="42" y1="78" x2="88" y2="78" stroke="#162029" strokeWidth="1.2" />
                  <circle cx="42" cy="74" r="1.2" fill="#3B4E60" />
                  <circle cx="88" cy="74" r="1.2" fill="#3B4E60" />
                  <circle cx="42" cy="92" r="1.2" fill="#3B4E60" />
                  <circle cx="88" cy="92" r="1.2" fill="#3B4E60" />

                  {/* Center Power Turbine Reactor Core */}
                  <circle cx="65" cy="84" r="9" fill="#070D12" stroke="#00F0FF" strokeWidth="1.4" />
                  <circle cx="65" cy="84" r="6" fill="#0E1C26" />
                  <g className="m-rotor-spin">
                    <line x1="65" y1="78" x2="65" y2="90" stroke="#33FF00" strokeWidth="1.4" strokeLinecap="round" />
                    <line x1="59" y1="84" x2="71" y2="84" stroke="#33FF00" strokeWidth="1.4" strokeLinecap="round" />
                    <line x1="61" y1="80" x2="69" y2="88" stroke="#00F0FF" strokeWidth="1.2" strokeLinecap="round" />
                    <line x1="61" y1="88" x2="69" y2="80" stroke="#00F0FF" strokeWidth="1.2" strokeLinecap="round" />
                  </g>
                  <circle cx="65" cy="84" r="2.2" fill="#FFFFFF" />

                  {/* Quantum Golden Reactor Core Overlay (Permanent VIP) */}
                  <g className="m-vip-reactor-glow">
                    <circle cx="65" cy="84" r="11" fill="url(#reactorGoldGlow)" />
                    <circle cx="65" cy="84" r="8.5" fill="#1C1402" stroke="#FFD028" strokeWidth="1.6" />
                    <g className="m-rotor-spin">
                      <line x1="65" y1="77" x2="65" y2="91" stroke="#FFE57F" strokeWidth="1.6" strokeLinecap="round" />
                      <line x1="58" y1="84" x2="72" y2="84" stroke="#FFE57F" strokeWidth="1.6" strokeLinecap="round" />
                      <line x1="60" y1="79" x2="70" y2="89" stroke="#FFB000" strokeWidth="1.4" strokeLinecap="round" />
                      <line x1="60" y1="89" x2="70" y2="79" stroke="#FFB000" strokeWidth="1.4" strokeLinecap="round" />
                    </g>
                    <circle cx="65" cy="84" r="2.8" fill="#FFFFFF" />
                    <circle
                      className="m-vip-ember ember-1"
                      cx="63"
                      cy="80"
                      r="1.4"
                      fill="#FFD028"
                      style={{ '--ex': '-5px' } as React.CSSProperties}
                    />
                    <circle
                      className="m-vip-ember ember-2"
                      cx="67"
                      cy="81"
                      r="1.3"
                      fill="#FFB000"
                      style={{ '--ex': '6px' } as React.CSSProperties}
                    />
                    <circle
                      className="m-vip-ember ember-3"
                      cx="65"
                      cy="78"
                      r="1.1"
                      fill="#FFE57F"
                      style={{ '--ex': '1px' } as React.CSSProperties}
                    />
                  </g>
                </g>

                {/* 3. ARTICULATED SPRING NECK JOINT */}
                <g className="m-neck-bellow">
                  <rect x="55" y="58" width="20" height="4" rx="2" fill="#243240" stroke="#3B4D5E" strokeWidth="1" />
                  <rect x="57" y="61" width="16" height="3" rx="1.5" fill="#151E26" />
                  <rect x="55" y="63" width="20" height="4" rx="2" fill="#243240" stroke="#3B4D5E" strokeWidth="1" />
                </g>

                {/* 4. HEAD ASSEMBLY WITH INDEPENDENT ROTATION/TILT */}
                <g className="m-head-rig">
                  <rect x="25" y="18" width="80" height="46" rx="18" fill="url(#headGrad)" stroke="#33FF00" strokeWidth="1.8" />
                  <rect x="18" y="32" width="8" height="18" rx="4" fill="#1A242E" stroke="#2E4050" strokeWidth="1.4" />
                  <rect x="104" y="32" width="8" height="18" rx="4" fill="#1A242E" stroke="#2E4050" strokeWidth="1.4" />
                  <line x1="22" y1="36" x2="22" y2="46" stroke="#33FF00" strokeWidth="1.2" />
                  <line x1="108" y1="36" x2="108" y2="46" stroke="#33FF00" strokeWidth="1.2" />

                  {/* Top Flexible Antenna Stalk & Sensor Dome */}
                  <line x1="65" y1="18" x2="65" y2="7" stroke="#33FF00" strokeWidth="2" strokeLinecap="round" />
                  <circle className="m-antenna-orb" cx="65" cy="6" r="4.5" fill="#33FF00" />
                  <circle cx="65" cy="6" r="2" fill="#FFFFFF" />

                  {/* Floating 3D Holographic Syndicate Crown/Halo (Permanent VIP) */}
                  <g className="m-vip-crown-halo">
                    <ellipse
                      className="m-vip-halo-ring"
                      cx="65"
                      cy="4"
                      rx="24"
                      ry="6"
                      fill="none"
                      stroke="url(#goldGrad)"
                      strokeWidth="2"
                      strokeDasharray="8 3"
                    />
                    <polygon
                      points="46,11 50,2 56,7 65,-4 74,7 80,2 84,11 65,8"
                      fill="url(#goldGrad)"
                      stroke="#FFF9C4"
                      strokeWidth="1.2"
                    />
                    <polygon points="65,0 67,4 65,7 63,4" fill="#FFFFFF" />
                    <circle cx="50" cy="3" r="1" fill="#FFFFFF" />
                    <circle cx="80" cy="3" r="1" fill="#FFFFFF" />
                  </g>

                  {/* Glossy Digital Visor Screen */}
                  <rect
                    className="m-visor-screen"
                    x="32"
                    y="24"
                    width="66"
                    height="34"
                    rx="12"
                    fill="url(#visorGrad)"
                    stroke="#223648"
                    strokeWidth="1.5"
                  />
                  <path d="M36 28 Q65 24 94 28" stroke="rgba(255, 255, 255, 0.15)" strokeWidth="1" fill="none" />

                  {/* High-Density Matrix LED Eyes */}
                  <g className="m-eyes-container">
                    <g className="m-blink-loop">
                      <g className="m-pupil-track">
                        <rect x="40" y="31" width="17" height="18" rx="6" fill="#09141B" stroke="#1D3342" strokeWidth="1" />
                        <rect x="44" y="34" width="8" height="11" rx="2.5" fill="#33FF00" />
                        <rect x="45" y="35" width="3" height="4" rx="1" fill="#FFFFFF" />
                        <rect x="73" y="31" width="17" height="18" rx="6" fill="#09141B" stroke="#1D3342" strokeWidth="1" />
                        <rect x="78" y="34" width="8" height="11" rx="2.5" fill="#33FF00" />
                        <rect x="79" y="35" width="3" height="4" rx="1" fill="#FFFFFF" />
                      </g>
                    </g>
                    {/* Visor Mouth Audio Grille */}
                    <line x1="56" y1="52" x2="74" y2="52" stroke="#00F0FF" strokeWidth="1.8" strokeLinecap="round" />
                  </g>

                  {/* Golden Cyber Polarized Shades Rig (Permanent VIP) */}
                  <g className="m-vip-shades-rig">
                    <polygon points="35,30 63,30 60,46 39,46" fill="url(#goldVisorGrad)" stroke="#FFF59D" strokeWidth="1.2" />
                    <polygon points="67,30 95,30 91,46 71,46" fill="url(#goldVisorGrad)" stroke="#FFF59D" strokeWidth="1.2" />
                    <line x1="61" y1="33" x2="69" y2="33" stroke="#FFD028" strokeWidth="2.5" />
                    <line x1="33" y1="30" x2="97" y2="30" stroke="#FFF59D" strokeWidth="1.4" />
                    <g className="m-shades-glint">
                      <line x1="44" y1="28" x2="52" y2="48" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" opacity="0.9" />
                      <line x1="76" y1="28" x2="84" y2="48" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" opacity="0.9" />
                    </g>
                  </g>
                </g>

                {/* VIP 4 : MATRIX HYPER-HACK PROPS (before arms so claws type on top) */}
                <g className="m-vip-hack-scene">
                  <g className="m-holo-kb-ring">
                    <path d="M24 88 Q65 104 106 88" fill="none" stroke="#FFD028" strokeWidth="4" strokeLinecap="round" opacity="0.85" />
                    <path d="M26 87 Q65 102 104 87" fill="none" stroke="#FFFFFF" strokeWidth="1" strokeDasharray="4 2" />
                  </g>
                  <text className="m-hex-stream-1" x="28" y="78" fontFamily="'JetBrains Mono', monospace" fontSize="6.5" fontWeight="bold" fill="#FFD028">0xVIP</text>
                  <text className="m-hex-stream-2" x="52" y="74" fontFamily="'JetBrains Mono', monospace" fontSize="6.5" fontWeight="bold" fill="#FFE57F">0xARCH</text>
                  <text className="m-hex-stream-3" x="82" y="76" fontFamily="'JetBrains Mono', monospace" fontSize="6.5" fontWeight="bold" fill="#FFB000">100TB</text>
                </g>

                {/* 5. MULTI-JOINTED LEFT ARM RIG */}
                <g className="m-arm-left-rig">
                  <circle cx="26" cy="72" r="4.5" fill="#1C2731" stroke="#33FF00" strokeWidth="1.2" />
                  <line x1="26" y1="72" x2="18" y2="84" stroke="#2C3D4D" strokeWidth="3" strokeLinecap="round" />
                  <circle cx="18" cy="84" r="3.5" fill="#141E26" stroke="#00F0FF" strokeWidth="1" />
                  <line x1="18" y1="84" x2="16" y2="94" stroke="#3A4F63" strokeWidth="2.5" strokeLinecap="round" />
                  <g className="m-claw-l">
                    <path d="M13 94 L11 100 M16 95 L16 102 M19 94 L21 100" stroke="#33FF00" strokeWidth="1.5" strokeLinecap="round" />
                  </g>
                </g>

                {/* 6. MULTI-JOINTED RIGHT ARM RIG WITH NESTED IN-HAND PROPS */}
                <g className="m-arm-right-rig">
                  <circle cx="104" cy="72" r="4.5" fill="#1C2731" stroke="#33FF00" strokeWidth="1.2" />
                  <line x1="104" y1="72" x2="112" y2="84" stroke="#2C3D4D" strokeWidth="3" strokeLinecap="round" />
                  <circle cx="112" cy="84" r="3.5" fill="#141E26" stroke="#00F0FF" strokeWidth="1" />
                  <line x1="112" y1="84" x2="114" y2="94" stroke="#3A4F63" strokeWidth="2.5" strokeLinecap="round" />
                  <g className="m-claw-r">
                    <path d="M111 94 L109 100 M114 95 L114 102 M117 94 L119 100" stroke="#33FF00" strokeWidth="1.5" strokeLinecap="round" />

                    {/* IN-HAND PROP 1: BLASTER CANNON (Bug Hunter) */}
                    <g className="m-cannon-prop">
                      <rect x="108" y="93" width="14" height="7" rx="2" fill="#1E2B38" stroke="#00F0FF" strokeWidth="1.2" />
                      <rect x="120" y="94" width="4" height="5" rx="1" fill="#33FF00" />
                      <line className="m-laser-strike" x1="124" y1="96" x2="108" y2="28" />
                    </g>

                    {/* IN-HAND PROP 2: MICROFIBER CLOTH (Sensor Polish) */}
                    <g className="m-polish-cloth">
                      <rect x="109" y="94" width="10" height="10" rx="3" fill="#00F0FF" stroke="#FFFFFF" strokeWidth="1" opacity="0.9" />
                    </g>

                    {/* IN-HAND PROP 3: NANO ESPRESSO CUP (Nano Coffee) */}
                    <g className="m-coffee-cup">
                      <rect x="108" y="93" width="12" height="14" rx="3" fill="#243340" stroke="#33FF00" strokeWidth="1.2" />
                      <path d="M120 96 Q124 100 120 104" fill="none" stroke="#33FF00" strokeWidth="1.2" />
                      <g className="m-coffee-steam">
                        <path d="M110 90 Q114 86 118 90 M111 85 Q114 81 117 85" fill="none" stroke="#00F0FF" strokeWidth="1" strokeLinecap="round" />
                      </g>
                    </g>

                    {/* IN-HAND PROP 4: GOLDEN TOAST MUG (VIP Toast) */}
                    <g className="m-toast-mug">
                      <rect x="108" y="92" width="13" height="15" rx="3" fill="#2E2406" stroke="#FFD028" strokeWidth="1.4" />
                      <rect x="110" y="94" width="9" height="4" rx="1" fill="#FFD028" />
                      <path d="M121 95 Q126 99 121 104" fill="none" stroke="#FFD028" strokeWidth="1.4" />
                      <g className="m-gold-steam">
                        <path d="M110 88 Q114 83 118 88 M111 82 Q115 77 119 82" fill="none" stroke="#FFE57F" strokeWidth="1.4" strokeLinecap="round" />
                      </g>
                    </g>
                  </g>
                </g>

                {/* ACTIVITY 1 : BUG HUNTER (Reticle + Evading Cyber Bug) */}
                <g className="m-bug-group">
                  <g className="m-target-reticle">
                    <circle cx="106" cy="26" r="10" fill="none" stroke="#FF2E63" strokeWidth="1" strokeDasharray="3 2" />
                  </g>
                  <g className="m-target-bug">
                    <ellipse cx="106" cy="26" rx="4" ry="3" fill="#FF2E63" />
                    <circle cx="104" cy="25" r="1" fill="#FFFFFF" />
                    <circle cx="108" cy="25" r="1" fill="#FFFFFF" />
                    <ellipse className="m-bug-wing-l" cx="103" cy="22" rx="3.5" ry="1.5" fill="rgba(0, 240, 255, 0.7)" />
                    <ellipse className="m-bug-wing-r" cx="109" cy="22" rx="3.5" ry="1.5" fill="rgba(0, 240, 255, 0.7)" />
                    <polygon points="106,20 108,24 112,26 108,28 106,32 104,28 100,26 104,24" fill="#FFD028" opacity="0.85" />
                  </g>
                </g>

                {/* ACTIVITY 2 : LOW BATTERY HUD */}
                <g className="m-low-batt-hud">
                  <rect x="52" y="32" width="26" height="15" rx="3" fill="#0A0406" stroke="#FF2E63" strokeWidth="1.5" />
                  <rect x="78" y="36" width="2" height="7" rx="1" fill="#FF2E63" />
                  <rect x="55" y="35" width="6" height="9" rx="1" fill="#FF2E63" />
                  <text x="65" y="44" fontFamily="'JetBrains Mono', monospace" fontSize="8" fontWeight="bold" fill="#FF2E63" textAnchor="middle">!</text>
                </g>

                {/* ACTIVITY 3 : TURBINE GENERATOR FX */}
                <g className="m-turbine-fx">
                  <path className="m-plasma-arc" d="M30 76 Q45 84 60 84 M100 76 Q85 84 70 84" fill="none" stroke="#00F0FF" strokeWidth="2" />
                  <circle cx="65" cy="84" r="13" fill="none" stroke="#33FF00" strokeWidth="1" strokeDasharray="3 2" />
                </g>

                {/* ACTIVITY 4 : SENSOR POLISH GLINT */}
                <g className="m-polish-fx">
                  <polygon className="m-polish-glint" points="48,34 51,40 57,43 51,46 48,52 45,46 39,43 45,40" fill="#FFFFFF" />
                </g>

                {/* ACTIVITY 5 : MODEL JUGGLER CUBES */}
                <g className="m-juggler-fx">
                  <g className="j-cube-1">
                    <rect x="-6" y="-6" width="12" height="12" rx="3" fill="#00F0FF" stroke="#FFFFFF" strokeWidth="0.8" />
                    <text x="0" y="3" fontFamily="'JetBrains Mono', monospace" fontSize="6" fontWeight="bold" fill="#05141C" textAnchor="middle">70B</text>
                  </g>
                  <g className="j-cube-2">
                    <rect x="-6" y="-6" width="12" height="12" rx="3" fill="#33FF00" stroke="#FFFFFF" strokeWidth="0.8" />
                    <text x="0" y="3" fontFamily="'JetBrains Mono', monospace" fontSize="6" fontWeight="bold" fill="#051405" textAnchor="middle">8B</text>
                  </g>
                  <g className="j-cube-3">
                    <rect x="-6" y="-6" width="12" height="12" rx="3" fill="#FFD028" stroke="#FFFFFF" strokeWidth="0.8" />
                    <text x="0" y="3" fontFamily="'JetBrains Mono', monospace" fontSize="5" fontWeight="bold" fill="#1C1405" textAnchor="middle">MoE</text>
                  </g>
                </g>

                {/* ACTIVITY 6 : NANO COFFEE flag anchor */}
                <g className="m-coffee-fx" />

                {/* ACTIVITY 7 : POWER NAP (Sleepy eyes + sinusoidal Zzz) */}
                <g className="m-nap-fx">
                  <path d="M42 42 Q48 46 54 42" fill="none" stroke="#33FF00" strokeWidth="2.5" strokeLinecap="round" />
                  <path d="M76 42 Q82 46 88 42" fill="none" stroke="#33FF00" strokeWidth="2.5" strokeLinecap="round" />
                  <text className="nap-zzz-1" x="0" y="0" fontFamily="'JetBrains Mono', monospace" fontSize="10" fontWeight="bold" fill="#33FF00">Z</text>
                  <text className="nap-zzz-2" x="0" y="0" fontFamily="'JetBrains Mono', monospace" fontSize="8" fontWeight="bold" fill="#00F0FF">z</text>
                  <text className="nap-zzz-3" x="0" y="0" fontFamily="'JetBrains Mono', monospace" fontSize="7" fill="#33FF00">z</text>
                </g>

                {/* VIP EXCLUSIVE SCENE PROPS */}
                <g className="m-vip-salute-scene">
                  <line x1="88" y1="60" x2="120" y2="52" stroke="#FFD028" strokeWidth="1.5" strokeDasharray="3 2" opacity="0.8" />
                </g>
                <g className="m-vip-toast-scene" />
                <g className="m-vip-wink-scene">
                  <polygon className="m-wink-lens-flare" points="44,28 46,34 52,36 46,38 44,44 42,38 36,36 42,34" fill="#FFFFFF" />
                </g>
                <g className="m-vip-meditation-scene">
                  <g className="m-quantum-matrix-ring">
                    <ellipse className="q-ring-outer" cx="65" cy="65" rx="58" ry="18" fill="none" stroke="#FFD028" strokeWidth="1.8" strokeDasharray="8 4" />
                    <ellipse className="q-ring-inner" cx="65" cy="65" rx="46" ry="14" fill="none" stroke="#FFE57F" strokeWidth="1" strokeDasharray="4 3" />
                    <g className="m-quantum-node-1">
                      <circle cx="7" cy="65" r="3" fill="#FFD028" />
                      <polygon points="7,62 9,65 7,68 5,65" fill="#FFFFFF" />
                    </g>
                    <g className="m-quantum-node-2">
                      <circle cx="123" cy="65" r="3" fill="#FFD028" />
                      <polygon points="123,62 125,65 123,68 121,65" fill="#FFFFFF" />
                    </g>
                  </g>
                </g>

                {/* EASTER EGG : DATA-DISK TOSS */}
                <g className="m-vip-disk-scene">
                  <g className="m-tossed-disk">
                    <ellipse cx="65" cy="40" rx="14" ry="7" fill="url(#goldGrad)" stroke="#FFFFFF" strokeWidth="1" />
                    <ellipse cx="65" cy="40" rx="6" ry="3" fill="#1A1202" stroke="#FFE57F" strokeWidth="0.8" />
                    <text x="65" y="42" fontFamily="'JetBrains Mono', monospace" fontSize="4" fontWeight="bold" fill="#FFE57F" textAnchor="middle">100TB</text>
                  </g>
                </g>
              </g>
            </svg>
            </div>
          ) : (
            <div className="hacker-viewport">
              <div className="crt-casing">
                <div className="crt-screen">
                  <div className="crt-term-line">
                    <span className="crt-term-prompt">&gt;</span>
                    <span className="crt-type-text">nv-gateway --serve</span>
                    <span className="crt-cursor" />
                  </div>
                  <div className="hacker-stage">
                    <canvas ref={canvasRef} width={160} height={152} />
                  </div>
                </div>
                <div className="crt-brand">
                  <span>TRM-80 · DEV PET</span>
                  <span className="crt-led" />
                </div>
              </div>

              {/* Dev tip jar row */}
              <div className="jar-box">
                <svg className="jar-svg px" viewBox="0 0 34 42" shapeRendering="crispEdges" aria-hidden="true">
                  <rect x="7" y="3" width="4" height="2" fill="#2C3A48" />
                  <rect x="23" y="3" width="4" height="2" fill="#2C3A48" />
                  <path
                    d="M10 5 h14 v2 h2 v2 h2 v26 h-2 v2 h-2 v2 h-14 v-2 h-2 v-2 h-2 v-26 h2 v-2 h2 z"
                    fill="rgba(0, 240, 255, 0.05)"
                    stroke="#3A4B5C"
                    strokeWidth="1"
                  />
                  <rect x="9" y="11" width="2" height="10" fill="rgba(220, 229, 237, 0.08)" />
                  <g fill="#FFD028">
                    <rect x="11" y="34" width="10" height="3" />
                    <rect x="15" y="31" width="10" height="3" />
                    <rect x="10" y="28" width="10" height="3" />
                  </g>
                  <g className="h-coin-drop-loop" fill="#FFD028">
                    <rect x="12" y="0" width="10" height="3" />
                  </g>
                </svg>
                <div>
                  <div className="jar-title">{t('pet_jar_title')}</div>
                  <div className="jar-subtitle">{t('pet_jar_subtitle')}</div>
                </div>
              </div>
            </div>
          )}

          <div className="context-cta">
            <span className="cta-text">{t('pet_cta_main')}</span>
          </div>
          <div className="cta-subtext">{t('pet_cta_sub')}</div>
        </button>
      </div>
    </div>
  );
}

// ==========================================
// PIXEL HACKER CANVAS 2D RENDERER
// Ported from interactive-showcase.html class PixelHackerEngine (#hackerCanvas).
// Backing store 160x152; displayed 80x76 via CSS pixelated scaling.
// The DOM/state-global coupling of the mockup is replaced by an explicit
// setMode() API driven by the pet engine's activity changes. Audio coupling
// lives in PetWidget / petAudio, NOT here.
// ==========================================

interface MatrixColumn {
  x: number;
  y: number;
  speed: number;
  chars: string[];
}

interface SmokePuff {
  x: number;
  y: number;
  vy: number;
  vx: number;
  size: number;
  alpha: number;
  color: string;
}

interface ConfettiPiece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rot: number;
  rotSpeed: number;
}

interface SnoreGlyph {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
}

interface KatanaSpark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  alpha: number;
}

interface SteamPuff {
  x: number;
  y: number;
  vy: number;
  alpha: number;
}

interface VipEmber {
  x: number;
  y: number;
  vy: number;
  size: number;
  alpha: number;
}

class PixelHackerRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly width = 160;
  private readonly height = 152;
  private rafId = 0;

  private lastTime = performance.now();
  private stateTimer = 0;
  private mode = 'idle';
  private prevMode = '';

  private smokePuffs: SmokePuff[] = [];
  private confetti: ConfettiPiece[] = [];
  private snores: SnoreGlyph[] = [];
  private katanaSparks: KatanaSpark[] = [];
  private steamParticles: SteamPuff[] = [];
  private vipEmbers: VipEmber[] = [];
  private matrixColumns: MatrixColumn[] = [];

  private disk = { x: 80, y: 80, vy: -6, rot: 0, active: false };

  private constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
    canvas.width = this.width;
    canvas.height = this.height;

    // Initialize 10 matrix rain columns
    for (let c = 0; c < 10; c++) {
      this.matrixColumns.push({
        x: 8 + c * 16,
        y: Math.random() * this.height,
        speed: 18 + Math.random() * 32,
        chars: ['0', '1', '>', '#', '*', 'x', '7', 'F', '$', ';'],
      });
    }

    this.initConfetti();
  }

  /** Factory — returns null when a 2D context is unavailable. */
  static create(canvas: HTMLCanvasElement): PixelHackerRenderer | null {
    const ctx = canvas.getContext('2d');
    return ctx ? new PixelHackerRenderer(canvas, ctx) : null;
  }

  start(): void {
    if (this.rafId === 0) {
      this.lastTime = performance.now();
      this.rafId = requestAnimationFrame(this.loop);
    }
  }

  destroy(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  setMode(mode: string): void {
    this.mode = mode;
  }

  private initConfetti(): void {
    this.confetti = [];
    const colors = ['#FFD028', '#00F0FF', '#33FF00', '#FF2E63', '#FFFFFF', '#B55FE6'];
    for (let i = 0; i < 26; i++) {
      this.confetti.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        vy: 24 + Math.random() * 40,
        vx: (Math.random() - 0.5) * 16,
        size: 2 + (i % 3) * 2,
        color: colors[i % colors.length],
        rot: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 5,
      });
    }
  }

  private resetModeState(mode: string): void {
    this.stateTimer = 0;
    this.smokePuffs = [];
    this.snores = [];
    this.katanaSparks = [];
    this.steamParticles = [];

    if (mode === 'disk-toss') {
      this.disk = { x: 80, y: 92, vy: -5.5, rot: 0, active: true };
    } else if (mode === 'zero-errors' || mode === 'celebration') {
      this.initConfetti();
    }
  }

  // Draw utilities
  private drawPixel(x: number, y: number, color: string, size = 1): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.floor(x), Math.floor(y), size, size);
  }

  private drawRect(x: number, y: number, w: number, h: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.floor(x), Math.floor(y), Math.floor(w), Math.floor(h));
  }

  private drawPixelText(text: string, x: number, y: number, color: string, size = 8): void {
    this.ctx.fillStyle = color;
    this.ctx.font = `bold ${size}px 'JetBrains Mono', monospace`;
    this.ctx.fillText(text, Math.floor(x), Math.floor(y));
  }

  private readonly loop = (timestamp: number): void => {
    const dt = Math.min((timestamp - this.lastTime) / 1000, 0.1);
    this.lastTime = timestamp;

    if (this.mode !== this.prevMode) {
      this.resetModeState(this.mode);
      this.prevMode = this.mode;
    }

    this.stateTimer += dt;
    this.render(timestamp / 1000, dt);

    this.rafId = requestAnimationFrame(this.loop);
  };

  private render(time: number, dt: number): void {
    const isVip =
      this.mode.startsWith('vip-') || this.mode === 'patron' || this.mode === 'disk-toss';
    const mode = this.mode;

    // 1. Clear screen & ambient phosphor backing
    this.ctx.clearRect(0, 0, this.width, this.height);

    if (mode === 'zero-errors' || mode === 'celebration') {
      const glowAlpha = 0.18 + Math.sin(this.stateTimer * 6) * 0.08;
      this.ctx.fillStyle = `rgba(0, 255, 102, ${glowAlpha})`;
      this.ctx.fillRect(0, 0, this.width, this.height);
    } else if (isVip) {
      this.ctx.fillStyle = 'rgba(255, 208, 40, 0.05)';
      this.ctx.fillRect(0, 0, this.width, this.height);
    }

    // 2. Matrix digital rain background
    this.renderMatrixRain(dt, isVip);

    // 3. Chair backdrop
    this.renderChair(time, isVip, mode);

    // 4. Character parameters
    let jumpY = 0;
    if (mode === 'zero-errors' || mode === 'celebration') {
      jumpY = -Math.abs(Math.sin(this.stateTimer * 6)) * 14;
    } else if (mode === 'vip-quantum-meditation') {
      jumpY = Math.sin(time * 2.5) * 9 - 4;
    }

    let headBobY = Math.sin(time * 2.8) * 1.5;
    if (mode === 'code-frenzy' || mode === 'vip-hyper-hack') {
      headBobY = Math.sin(time * 24) * 2.2;
    } else if (mode === 'terminal-nap') {
      headBobY = 32; // slumped onto keyboard
    } else if (mode === 'empty-mug' && (this.stateTimer % 4.8) > 1.2 && (this.stateTimer % 4.8) < 3.2) {
      headBobY = -3; // head tilted back to drink
    }

    // 5. Hacker body & hood
    this.renderHackerTorso(jumpY, isVip);
    this.renderHackerHead(jumpY, headBobY, isVip, mode, time);

    // 6. Desk & mechanical keyboard
    this.renderDeskAndKeyboard(time, isVip, mode);

    // 7. Hands & mode-specific action layers
    this.renderActionLayer(jumpY, isVip, mode, time, dt);

    // 8. Foreground particles
    this.renderForegroundParticles(dt, mode, isVip);
  }

  private renderMatrixRain(dt: number, isVip: boolean): void {
    for (let i = 0; i < this.matrixColumns.length; i++) {
      const col = this.matrixColumns[i];
      col.y += col.speed * dt;
      if (col.y > this.height + 40) {
        col.y = -20 - Math.random() * 30;
        col.speed = 18 + Math.random() * 32;
      }

      // Streaming glyphs per column
      const charCount = 4;
      for (let g = 0; g < charCount; g++) {
        const py = col.y - g * 8;
        if (py >= 0 && py < this.height - 30) {
          const ch = col.chars[(Math.floor(col.y * 0.1) + g) % col.chars.length];
          const isLead = g === 0;
          if (isVip) {
            this.ctx.fillStyle = isLead ? '#FFF9C4' : g === 1 ? '#FFD028' : 'rgba(255, 208, 40, 0.3)';
          } else {
            this.ctx.fillStyle = isLead ? '#E8FFE8' : g === 1 ? '#33FF00' : 'rgba(51, 255, 0, 0.25)';
          }
          this.ctx.font = "bold 6px 'JetBrains Mono', monospace";
          this.ctx.fillText(ch, col.x, py);
        }
      }
    }
  }

  private renderChair(time: number, isVip: boolean, mode: string): void {
    let chairSway = 0;
    if (mode === 'celebration') {
      chairSway = Math.sin(time * 8) * 2;
    }

    const cx = 44 + chairSway;
    const cy = 30;
    const cw = 72;
    const ch = 76;

    const frameColor = isVip ? '#2A2005' : '#0B1A0B';
    const innerColor = isVip ? '#1A1302' : '#040C04';
    const ribColor = isVip ? '#FFD028' : '#143814';

    this.drawRect(cx, cy, cw, ch, frameColor);
    this.drawRect(cx + 4, cy + 4, cw - 8, ch - 8, innerColor);

    // Ribbing & gold accent piping
    this.drawRect(cx + 6, cy + 18, cw - 12, 2, ribColor);
    this.drawRect(cx + 6, cy + 36, cw - 12, 2, ribColor);
    this.drawRect(cx + 6, cy + 54, cw - 12, 2, ribColor);

    if (isVip) {
      this.drawRect(cx, cy, cw, 2, '#FFD028');
      this.drawRect(cx + cw / 2 - 8, cy - 2, 16, 2, '#FFE57F');
    }
  }

  private renderDeskAndKeyboard(time: number, isVip: boolean, mode: string): void {
    const deskEdgeColor = isVip ? '#8C6B14' : '#188000';
    const deskBodyColor = isVip ? '#3A2A04' : '#0A3C00';
    const deskShadeColor = isVip ? '#1F1602' : '#041800';

    this.drawRect(0, 120, this.width, 4, deskEdgeColor);
    this.drawRect(0, 124, this.width, 28, deskBodyColor);
    this.drawRect(0, 146, this.width, 6, deskShadeColor);

    const kbColor = isVip ? '#281C02' : '#0A2E00';
    const kbBorder = isVip ? '#FFD028' : '#146E00';
    this.drawRect(18, 122, 124, 16, kbColor);
    this.drawRect(18, 122, 124, 1, kbBorder);

    // 8 keycap clusters
    const keyPositions = [26, 40, 54, 68, 82, 96, 110, 124];
    const typingLeft = Math.sin(time * 8) > 0;

    for (let k = 0; k < keyPositions.length; k++) {
      const kx = keyPositions[k];
      let isLit = false;

      if (mode === 'code-frenzy' || mode === 'vip-hyper-hack') {
        isLit = Math.random() < 0.4;
      } else if (mode === 'terminal-nap') {
        isLit = k >= 3 && k <= 5;
      } else if (mode === 'idle') {
        isLit = (typingLeft && (k === 1 || k === 2)) || (!typingLeft && (k === 5 || k === 6));
      }

      if (isLit) {
        const litColor = isVip ? '#FFE57F' : '#00FF66';
        this.drawRect(kx, 125, 10, 8, litColor);
        this.drawPixel(kx + 2, 126, '#FFFFFF', 2);
      } else {
        const baseKey = isVip ? '#181001' : '#041A00';
        this.drawRect(kx, 125, 10, 8, baseKey);
      }
    }
  }

  private renderHackerTorso(jumpY: number, isVip: boolean): void {
    const bx = 32;
    const by = 74 + jumpY;
    const bw = 96;
    const bh = 48;

    const robeHighlight = isVip ? '#FFD028' : '#33FF00';
    const robeMain = isVip ? '#3D2E04' : '#20B800';
    const robeShadow = isVip ? '#241B03' : '#146E00';
    const robeDeep = isVip ? '#120D01' : '#083C00';

    // Shoulders
    this.drawRect(bx + 4, by, bw - 8, 14, robeMain);
    this.drawRect(bx + 4, by, bw - 8, 2, robeHighlight);

    // Torso body
    this.drawRect(bx, by + 14, bw, bh - 14, robeMain);
    this.drawRect(bx + 12, by + 14, bw - 24, bh - 14, robeShadow);
    this.drawRect(bx + 28, by + 20, bw - 56, bh - 20, robeDeep);

    // Robe fold details & VIP circuit traces
    if (isVip) {
      this.drawRect(bx + 36, by + 18, 2, 22, '#FFD028');
      this.drawRect(bx + bw - 38, by + 18, 2, 22, '#FFD028');
      this.drawPixel(bx + bw / 2 - 1, by + 28, '#FFE57F', 3);
    } else {
      this.drawRect(bx + 40, by + 18, 2, 22, '#33FF00');
      this.drawRect(bx + bw - 42, by + 18, 2, 22, '#33FF00');
    }
  }

  private renderHackerHead(
    jumpY: number,
    headBobY: number,
    isVip: boolean,
    mode: string,
    time: number,
  ): void {
    const hx = 52;
    const hy = 22 + jumpY + headBobY;
    const hw = 56;
    const hh = 52;

    const hoodHighlight = isVip ? '#FFE57F' : '#33FF00';
    const hoodMain = isVip ? '#3D2E04' : '#20B800';
    const hoodShadow = isVip ? '#1F1702' : '#146E00';
    const shadowVoid = '#010801';

    // Outer hood crown & arch
    this.drawRect(hx + 8, hy, hw - 16, 6, hoodMain);
    this.drawRect(hx + 8, hy, hw - 16, 2, hoodHighlight);
    this.drawRect(hx + 4, hy + 6, hw - 8, 8, hoodMain);
    this.drawRect(hx, hy + 14, hw, hh - 14, hoodMain);
    this.drawRect(hx, hy + 14, 4, hh - 14, hoodHighlight);
    this.drawRect(hx + hw - 4, hy + 14, 4, hh - 14, hoodHighlight);

    // Inner cowl shadow opening
    this.drawRect(hx + 8, hy + 16, hw - 16, hh - 22, hoodShadow);
    this.drawRect(hx + 12, hy + 20, hw - 24, hh - 28, shadowVoid);

    // Visor expressions / eyes
    if (mode === 'terminal-nap') {
      // Resting slits
      this.drawRect(hx + 18, hy + 30, 8, 2, '#146E00');
      this.drawRect(hx + 30, hy + 30, 8, 2, '#146E00');
    } else if (isVip && mode !== 'zero-errors' && mode !== 'celebration') {
      // Golden sunglasses with active ruby laser sweep
      this.drawRect(hx + 14, hy + 24, 12, 10, '#FFD028');
      this.drawRect(hx + 30, hy + 24, 12, 10, '#FFD028');
      this.drawRect(hx + 24, hy + 26, 8, 3, '#FFD028');
      this.drawRect(hx + 16, hy + 26, 8, 6, '#3A2A04');
      this.drawRect(hx + 32, hy + 26, 8, 6, '#3A2A04');

      const laserOffset = (Math.sin(time * 4) + 1) * 0.5 * 24;
      const lx = hx + 15 + laserOffset;
      this.drawRect(lx, hy + 26, 4, 6, '#FF2E63');
      this.drawPixel(lx + 1, hy + 27, '#FFA0B8', 2);
    } else if (mode === 'intent') {
      // Exclamation mark visor ! !
      this.drawRect(hx + 18, hy + 22, 4, 10, '#FFD028');
      this.drawRect(hx + 18, hy + 34, 4, 3, '#FFD028');
      this.drawRect(hx + 34, hy + 22, 4, 10, '#FFD028');
      this.drawRect(hx + 34, hy + 34, 4, 3, '#FFD028');
    } else if (mode === 'zero-errors' || mode === 'celebration') {
      // Joyful arch ^ ^
      const eyeCol = '#00FF66';
      this.drawRect(hx + 16, hy + 28, 3, 4, eyeCol);
      this.drawRect(hx + 19, hy + 24, 4, 4, eyeCol);
      this.drawRect(hx + 23, hy + 28, 3, 4, eyeCol);
      this.drawRect(hx + 30, hy + 28, 3, 4, eyeCol);
      this.drawRect(hx + 33, hy + 24, 4, 4, eyeCol);
      this.drawRect(hx + 37, hy + 28, 3, 4, eyeCol);
    } else if (mode === 'bug-slayer') {
      // Angled blade glare \ /
      this.drawRect(hx + 16, hy + 24, 4, 4, '#00F0FF');
      this.drawRect(hx + 20, hy + 28, 4, 4, '#00F0FF');
      this.drawRect(hx + 32, hy + 28, 4, 4, '#FF2E63');
      this.drawRect(hx + 36, hy + 24, 4, 4, '#FF2E63');
    } else if (mode === 'empty-mug' && this.stateTimer % 4.8 > 2.0) {
      // Droopy sad eyes - -
      this.drawRect(hx + 16, hy + 29, 8, 3, '#00F0FF');
      this.drawRect(hx + 32, hy + 29, 8, 3, '#00F0FF');
      this.drawPixel(hx + 18, hy + 34, '#00F0FF', 3);
    } else {
      // Default blinking eyes
      const isBlink = time % 3.0 < 0.12;
      const eyeH = isBlink ? 2 : 6;
      const eyeY = isBlink ? hy + 28 : hy + 26;

      this.drawRect(hx + 16, eyeY, 8, eyeH, '#E8FFE8');
      this.drawRect(hx + 32, eyeY, 8, eyeH, '#E8FFE8');
      if (!isBlink) {
        this.drawRect(hx + 18, eyeY + 2, 4, 2, '#33FF00');
        this.drawRect(hx + 34, eyeY + 2, 4, 2, '#33FF00');
      }
    }

    // 8-bit golden crown in VIP mode
    if (isVip) {
      const cx = hx + 10;
      const cy = hy - 14;
      this.drawRect(cx, cy + 8, 36, 4, '#FFD028');
      this.drawRect(cx + 2, cy + 2, 6, 6, '#FFD028');
      this.drawRect(cx + 15, cy - 2, 6, 10, '#FFD028');
      this.drawRect(cx + 28, cy + 2, 6, 6, '#FFD028');
      this.drawPixel(cx + 16, cy, '#FFFFFF', 3);
    }
  }

  private renderActionLayer(
    jumpY: number,
    isVip: boolean,
    mode: string,
    time: number,
    dt: number,
  ): void {
    const gloveColor = isVip ? '#FFE57F' : '#33FF00';
    const gloveShadow = isVip ? '#C99A0E' : '#20B800';

    if (mode === 'code-frenzy' || mode === 'vip-hyper-hack') {
      // CODE FRENZY: 60fps typing & smoke puffs
      const f1 = Math.floor(time * 28) % 3;
      const f2 = Math.floor(time * 28 + 1) % 3;

      const lx = 32 + f1 * 14;
      const ly = 114 + (f1 === 0 ? 6 : 0);
      const rx = 96 + f2 * 14;
      const ry = 114 + (f2 === 0 ? 6 : 0);

      // Motion ghosting trails
      this.drawRect(lx - 2, ly - 2, 16, 10, 'rgba(51, 255, 0, 0.35)');
      this.drawRect(rx - 2, ry - 2, 16, 10, 'rgba(51, 255, 0, 0.35)');

      // Hands
      this.drawRect(lx, ly, 14, 8, gloveColor);
      this.drawRect(rx, ry, 14, 8, gloveColor);

      // Spawn smoke puffs from keys
      if (Math.random() < 0.35) {
        this.smokePuffs.push({
          x: (Math.random() < 0.5 ? lx : rx) + 4,
          y: 122,
          vy: -35 - Math.random() * 25,
          vx: (Math.random() - 0.5) * 12,
          size: 3,
          alpha: 1.0,
          color: Math.random() < 0.5 ? '#8899A6' : '#78E678',
        });
      }

      for (let s = this.smokePuffs.length - 1; s >= 0; s--) {
        const p = this.smokePuffs[s];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.size += 6 * dt;
        p.alpha -= 1.8 * dt;

        if (p.alpha <= 0) {
          this.smokePuffs.splice(s, 1);
          continue;
        }

        this.ctx.fillStyle = p.color;
        this.ctx.globalAlpha = Math.max(0, p.alpha);
        this.ctx.fillRect(Math.floor(p.x), Math.floor(p.y), Math.floor(p.size), Math.floor(p.size));
        this.ctx.globalAlpha = 1.0;
      }
    } else if (mode === 'zero-errors' || mode === 'celebration') {
      // ZERO ERRORS: double fist pump \o/
      const fistY = 48 + jumpY + Math.sin(time * 12) * 4;
      this.drawRect(22, 68 + jumpY, 14, 28, gloveShadow);
      this.drawRect(18, fistY, 16, 16, gloveColor);
      this.drawPixel(22, fistY + 4, '#FFFFFF', 4);

      this.drawRect(124, 68 + jumpY, 14, 28, gloveShadow);
      this.drawRect(126, fistY, 16, 16, gloveColor);
      this.drawPixel(130, fistY + 4, '#FFFFFF', 4);
    } else if (mode === 'empty-mug') {
      // EMPTY MUG: 180° cup invert & tear drop
      const cycleTime = this.stateTimer % 4.8;

      if (cycleTime < 1.2) {
        // Holding mug on desk
        this.drawRect(118, 110, 16, 16, '#DCE5ED');
        this.drawRect(134, 114, 4, 8, '#8899A6');
        this.drawRect(110, 116, 12, 8, gloveColor);
      } else if (cycleTime < 3.2) {
        // Mug turned completely upside down over face
        this.drawRect(102, 60, 18, 18, '#DCE5ED');
        this.drawRect(102, 74, 18, 4, '#33FF00'); // robe arm
        this.drawRect(98, 64, 4, 10, '#8899A6'); // handle

        const tearProgress = (cycleTime - 1.2) / 2.0;
        const dropY = 78 + tearProgress * 44;
        if (dropY < 122) {
          this.drawRect(110, dropY, 4, 6, '#00F0FF');
          this.drawPixel(111, dropY + 1, '#FFFFFF', 2);
        } else {
          this.drawRect(106, 122, 12, 2, '#00F0FF');
        }
      } else {
        // Despair slump
        this.drawRect(118, 120, 16, 10, '#DCE5ED');
        this.drawRect(100, 122, 14, 8, gloveColor);
      }
    } else if (mode === 'bug-slayer') {
      // BUG SLAYER: neon katana slash & split bug
      const cycleTime = this.stateTimer % 3.6;

      if (cycleTime < 1.2) {
        // Bug crawling on desk
        const bx = 120 + Math.sin(time * 12) * 6;
        const by = 90;
        this.drawRect(bx, by, 14, 12, '#FF2E63');
        this.drawPixel(bx + 2, by - 4, '#FF2E63', 3);
        this.drawPixel(bx + 8, by - 4, '#FF2E63', 3);
        this.drawPixel(bx - 2, by + 3, '#0B1A0B', 2);
        this.drawPixel(bx + 14, by + 3, '#0B1A0B', 2);
        this.drawPixel(bx - 2, by + 9, '#0B1A0B', 2);
        this.drawPixel(bx + 14, by + 9, '#0B1A0B', 2);

        // Katana sheathed / ready
        this.drawRect(36, 104, 20, 4, '#00F0FF');
      } else if (cycleTime < 1.8) {
        // SWOOSH slash arc!
        this.ctx.strokeStyle = '#00F0FF';
        this.ctx.lineWidth = 4;
        this.ctx.beginPath();
        this.ctx.arc(80, 80, 50, -0.4, 0.9);
        this.ctx.stroke();

        this.ctx.strokeStyle = '#FFFFFF';
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.arc(80, 80, 50, -0.2, 0.7);
        this.ctx.stroke();

        this.drawRect(110, 54, 34, 4, '#00F0FF');
        this.drawRect(102, 54, 8, 6, gloveColor);

        // Spawn katana explosion sparks once per slash
        if (this.katanaSparks.length === 0) {
          for (let sp = 0; sp < 16; sp++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 35 + Math.random() * 55;
            this.katanaSparks.push({
              x: 126,
              y: 90,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed - 15,
              color: sp % 2 === 0 ? '#FF2E63' : '#00F0FF',
              size: 2 + Math.floor(Math.random() * 3),
              alpha: 1.0,
            });
          }
        }
      } else {
        // Sliced bug halves flying apart
        const t2 = cycleTime - 1.8;
        const topX = 126 + t2 * 18;
        const topY = 90 - t2 * 22;
        const botX = 126 - t2 * 8;
        const botY = 90 + t2 * 14;

        if (topY > 20) this.drawRect(topX, topY, 14, 6, '#FF2E63');
        if (botY < 124) this.drawRect(botX, botY, 14, 6, '#FF2E63');

        for (let sp = this.katanaSparks.length - 1; sp >= 0; sp--) {
          const p = this.katanaSparks[sp];
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.vy += 120 * dt; // gravity
          p.alpha -= 1.4 * dt;

          if (p.alpha <= 0 || p.y > 124) {
            this.katanaSparks.splice(sp, 1);
            continue;
          }

          this.ctx.fillStyle = p.color;
          this.ctx.globalAlpha = Math.max(0, p.alpha);
          this.ctx.fillRect(Math.floor(p.x), Math.floor(p.y), p.size, p.size);
          this.ctx.globalAlpha = 1.0;
        }
      }
    } else if (mode === 'coin-drop') {
      // COIN DROP: gravity bounce & tip jar
      const cycleTime = this.stateTimer % 3.6;

      // Glass tip jar on right desk edge
      this.drawRect(122, 98, 26, 24, 'rgba(0, 240, 255, 0.15)');
      this.drawRect(122, 98, 26, 2, '#00F0FF');
      this.drawRect(122, 120, 26, 2, '#00F0FF');
      this.drawRect(122, 98, 2, 24, '#00F0FF');
      this.drawRect(146, 98, 2, 24, '#00F0FF');
      // Gold coins in jar bottom
      this.drawRect(126, 114, 18, 6, '#FFD028');

      if (cycleTime < 0.8) {
        // Arm raised holding gold coin
        this.drawRect(132, 70, 14, 10, gloveColor);
        this.drawRect(134, 60, 10, 8, '#FFD028');
        this.drawPixel(136, 62, '#FFFFFF', 3);
      } else {
        // Coin falling with gravity
        const tDrop = cycleTime - 0.8;
        let cy = 60 + 0.5 * 180 * tDrop * tDrop;
        if (cy > 114) {
          cy = 114 - Math.abs(Math.sin((cy - 114) * 0.5)) * 6; // bounce
        }
        this.drawRect(130, cy, 10, 6, '#FFD028');
        this.drawPixel(132, cy + 1, '#FFFFFF', 2);
      }
    } else if (mode === 'flowchart') {
      // FLOWCHART: neural nodes & data packets
      this.ctx.strokeStyle = '#33FF00';
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(112, 114);
      this.ctx.lineTo(84, 40);
      this.ctx.stroke();

      const nCol = '#00F0FF';
      this.drawRect(20, 32, 24, 16, 'rgba(0, 240, 255, 0.2)');
      this.drawRect(20, 32, 24, 2, nCol);
      this.drawPixelText('IN', 26, 44, nCol, 8);

      this.drawRect(70, 22, 28, 16, 'rgba(0, 240, 255, 0.35)');
      this.drawRect(70, 22, 28, 2, nCol);
      this.drawPixelText('70B', 74, 34, '#FFFFFF', 8);

      this.drawRect(124, 32, 26, 16, 'rgba(0, 240, 255, 0.2)');
      this.drawRect(124, 32, 26, 2, nCol);
      this.drawPixelText('OUT', 128, 44, nCol, 8);

      this.ctx.strokeStyle = '#33FF00';
      this.ctx.lineWidth = 1.5;
      this.ctx.beginPath();
      this.ctx.moveTo(44, 40);
      this.ctx.lineTo(70, 30);
      this.ctx.lineTo(98, 30);
      this.ctx.lineTo(124, 40);
      this.ctx.stroke();

      // Moving data packets along the circuit path
      const packetPos = (time * 1.5) % 2.0;
      let px: number;
      let py: number;
      if (packetPos < 1.0) {
        px = 44 + packetPos * 26;
        py = 40 - packetPos * 10;
      } else {
        const p2 = packetPos - 1.0;
        px = 98 + p2 * 26;
        py = 30 + p2 * 10;
      }
      this.drawRect(px - 2, py - 2, 5, 5, '#FFFFFF');
    } else if (mode === 'terminal-nap') {
      // TERMINAL NAP: snore ZZZ glyphs
      if (Math.random() < 0.04 && this.snores.length < 5) {
        this.snores.push({
          x: 94,
          y: 70,
          vx: 12 + Math.random() * 8,
          vy: -20 - Math.random() * 10,
          size: 8,
          alpha: 1.0,
        });
      }

      for (let z = this.snores.length - 1; z >= 0; z--) {
        const sn = this.snores[z];
        sn.x += Math.sin(time * 4) * 0.6;
        sn.y += sn.vy * dt;
        sn.alpha -= 0.6 * dt;

        if (sn.alpha <= 0) {
          this.snores.splice(z, 1);
          continue;
        }

        this.ctx.fillStyle = `rgba(51, 255, 0, ${sn.alpha})`;
        this.ctx.font = "bold 9px 'JetBrains Mono', monospace";
        this.ctx.fillText('Z', Math.floor(sn.x), Math.floor(sn.y));
      }
    } else if (mode === 'intent') {
      // INTENT: waving cyber arm o/
      const waveAngle = Math.sin(time * 14) * 8;
      this.drawRect(120, 72, 14, 26, gloveShadow);
      this.drawRect(126 + waveAngle, 50, 16, 16, gloveColor);
      this.drawPixel(130 + waveAngle, 54, '#FFFFFF', 4);
    } else if (mode === 'vip-syndicate-salute') {
      // VIP 1: syndicate salute
      this.drawRect(114, 60, 14, 28, gloveShadow);
      this.drawRect(98, 44, 18, 12, '#FFD028');
      this.drawPixel(102, 46, '#FFFFFF', 4);
    } else if (mode === 'vip-espresso-toast') {
      // VIP 2: toast to architect
      this.drawRect(114, 70, 16, 24, gloveShadow);
      this.drawRect(118, 52, 18, 18, '#FFD028');
      this.drawRect(134, 56, 4, 10, '#FFE57F');

      // Golden steam spirals
      if (Math.random() < 0.2) {
        this.steamParticles.push({
          x: 124 + Math.random() * 8,
          y: 48,
          vy: -22 - Math.random() * 15,
          alpha: 1.0,
        });
      }
      for (let s = this.steamParticles.length - 1; s >= 0; s--) {
        const st = this.steamParticles[s];
        st.y += st.vy * dt;
        st.x += Math.sin(st.y * 0.1) * 0.8;
        st.alpha -= 1.2 * dt;
        if (st.alpha <= 0) {
          this.steamParticles.splice(s, 1);
          continue;
        }
        this.drawRect(st.x, st.y, 3, 3, `rgba(255, 208, 40, ${st.alpha})`);
      }
    } else if (mode === 'vip-fourth-wall-wink') {
      // VIP 3: 4th-wall wink & lens flare
      this.drawRect(104, 54, 14, 14, '#FFD028'); // hand adjusting shades
      const flarePulse = Math.abs(Math.sin(time * 3));
      if (flarePulse > 0.6) {
        const fx = 70;
        const fy = 50;
        this.drawRect(fx - 6, fy, 13, 2, '#FFFFFF');
        this.drawRect(fx, fy - 6, 2, 13, '#FFFFFF');
        this.drawPixel(fx, fy, '#FFF9C4', 3);
      }
    } else if (mode === 'vip-quantum-meditation') {
      // VIP 5: zero-g hover (body lift handled via jumpY; add orbiting spark)
      const orbAngle = time * 2.2;
      const ox = 80 + Math.cos(orbAngle) * 46;
      const oy = 74 + Math.sin(orbAngle) * 12;
      this.drawRect(ox, oy, 4, 4, '#FFD028');
      this.drawPixel(ox + 1, oy + 1, '#FFF9C4', 2);
    } else if (mode === 'disk-toss') {
      // EASTER EGG: 100TB data disk toss
      this.disk.rot += 12 * dt;
      const arcTime = this.stateTimer % 3.0;
      const dy = 90 - Math.sin((arcTime * Math.PI) / 3.0) * 60;
      const dw = Math.abs(Math.cos(this.disk.rot)) * 16 + 4;

      this.drawRect(80 - dw / 2, dy, dw, 16, '#FFD028');
      this.drawRect(80 - dw / 4, dy + 2, dw / 2, 12, '#FFFFFF');
    } else {
      // DEFAULT IDLE: rhythmic alternating typing
      const typingLeft = Math.sin(time * 8) > 0;
      const ly = typingLeft ? 122 : 116;
      const ry = typingLeft ? 116 : 122;

      this.drawRect(38, 100, 10, 16, gloveShadow);
      this.drawRect(36, ly, 14, 8, gloveColor);

      this.drawRect(112, 100, 10, 16, gloveShadow);
      this.drawRect(110, ry, 14, 8, gloveColor);
    }
  }

  private renderForegroundParticles(dt: number, mode: string, isVip: boolean): void {
    if (mode === 'zero-errors' || mode === 'celebration') {
      for (let i = 0; i < this.confetti.length; i++) {
        const p = this.confetti[i];
        p.y += p.vy * dt;
        p.x += (p.vx + Math.sin(p.y * 0.08) * 12) * dt;
        p.rot += p.rotSpeed * dt;

        if (p.y > this.height) {
          p.y = -10;
          p.x = Math.random() * this.width;
        }

        this.ctx.save();
        this.ctx.translate(Math.floor(p.x), Math.floor(p.y));
        this.ctx.rotate(p.rot);
        this.ctx.fillStyle = p.color;
        this.ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        this.ctx.restore();
      }
    }

    if (isVip && Math.random() < 0.15 && this.vipEmbers.length < 12) {
      this.vipEmbers.push({
        x: Math.random() * this.width,
        y: this.height - 10,
        vy: -20 - Math.random() * 20,
        size: 2,
        alpha: 1.0,
      });
    }

    for (let e = this.vipEmbers.length - 1; e >= 0; e--) {
      const em = this.vipEmbers[e];
      em.y += em.vy * dt;
      em.alpha -= 0.8 * dt;
      if (em.alpha <= 0 || em.y < 0) {
        this.vipEmbers.splice(e, 1);
        continue;
      }
      this.drawRect(em.x, em.y, em.size, em.size, `rgba(255, 208, 40, ${em.alpha})`);
    }
  }
}
