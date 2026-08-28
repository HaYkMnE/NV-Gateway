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
  onOpenDonation?: () => void;
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

  // Activity switch: re-render character animation, play matching SFX once,
  // show themed thought cloud, re-sync VIP flag (it may have flipped while
  // the donation modal was open).
  //
  // Identity-stable by construction: reads `t` through tRef so this callback
  // never changes identity when the translator instance does.
  const handleActivityChange = useCallback(
    (next: AnyActivity): void => {
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
      setThought(pickThought(next, tRef.current));
      if (thoughtTimerRef.current !== null) window.clearTimeout(thoughtTimerRef.current);
      thoughtTimerRef.current = window.setTimeout(() => {
        setThought(null);
        thoughtTimerRef.current = null;
      }, 2600);
    },
    [syncVipFromStorage],
  );

  // CAUGHT IN THE ACT! — fired by the engine when focus returns after away.
  const handleCue = useCallback((): void => {
    setCueShown(true);
    setCrossfading(true);
    if (cueTimerRef.current !== null) window.clearTimeout(cueTimerRef.current);
    if (fadeTimerRef.current !== null) window.clearTimeout(fadeTimerRef.current);
    cueTimerRef.current = window.setTimeout(() => {
      setCueShown(false);
      cueTimerRef.current = null;
    }, 2800);
    fadeTimerRef.current = window.setTimeout(() => {
      setCrossfading(false);
      fadeTimerRef.current = null;
    }, 600);
  }, []);

  // Engine + audio wiring (mount once).
  useEffect(() => {
    const engine = createPetEngine({
      isVip: () => vipRef.current,
      onActivityChange: handleActivityChange,
      onCue: handleCue,
    });
    engineRef.current = engine;

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
    const stopAmbient = (): void => {
      petAudio.stopAmbient();
    };
    const startAmbient = (): void => {
      if (!soundRef.current) return;
      petAudio.scheduleAmbient(() => engineRef.current?.getActivity() ?? 'idle');
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
          {character === 'mascot' ? (\n            <div className=\"mascot-viewport\">\n            <svg className=\"mascot-svg\" viewBox=\"0 0 130 120\" aria-hidden=\"true\">\n              <defs>\n                <linearGradient id=\"chassisGrad\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\">\n                  <stop offset=\"0%\" stopColor=\"#1E2833\" />\n                  <stop offset=\"100%\" stopColor=\"#10161C\" />\n                </linearGradient>\n                <linearGradient id=\"headGrad\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\">\n                  <stop offset=\"0%\" stopColor=\"#1B242E\" />\n                  <stop offset=\"100%\" stopColor=\"#0E141A\" />\n                </linearGradient>\n                <linearGradient id=\"visorGrad\" x1=\"0%\" y1=\"0%\" x2=\"0%\" y2=\"100%\">\n                  <stop offset=\"0%\" stopColor=\"#050A0E\" />\n                  <stop offset=\"100%\" stopColor=\"#020508\" />\n                </linearGradient>\n                <linearGradient id=\"plasmaGrad\" x1=\"0%\" y1=\"0%\" x2=\"0%\" y2=\"100%\">\n                  <stop offset=\"0%\" stopColor=\"#FFFFFF\" />\n                  <stop offset=\"25%\" stopColor=\"#00F0FF\" />\n                  <stop offset=\"85%\" stopColor=\"#33FF00\" />\n                  <stop offset=\"100%\" stopColor=\"transparent\" />\n                </linearGradient>\n                <linearGradient id=\"goldGrad\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\">\n                  <stop offset=\"0%\" stopColor=\"#FFF070\" />\n                  <stop offset=\"60%\" stopColor=\"#FFD028\" />\n                  <stop offset=\"100%\" stopColor=\"#B8800A\" />\n                </linearGradient>\n                <linearGradient id=\"goldVisorGrad\" x1=\"0%\" y1=\"0%\" x2=\"0%\" y2=\"100%\">\n                  <stop offset=\"0%\" stopColor=\"#FFF59D\" />\n                  <stop offset=\"35%\" stopColor=\"#FFD700\" />\n                  <stop offset=\"70%\" stopColor=\"#FFB000\" />\n                  <stop offset=\"100%\" stopColor=\"#D48800\" />\n                </linearGradient>\n                <radialGradient id=\"reactorGoldGlow\" cx=\"50%\" cy=\"50%\" r=\"50%\">\n                  <stop offset=\"0%\" stopColor=\"#FFF59D\" stopOpacity=\"1\" />\n                  <stop offset=\"45%\" stopColor=\"#FFB000\" stopOpacity=\"0.85\" />\n                  <stop offset=\"100%\" stopColor=\"#FF8F00\" stopOpacity=\"0\" />\n                </radialGradient>\n              </defs>\n\n              {/* SKELETAL RIG ROOT */}\n              <g className=\"m-root-rig\">\n                {/* 1. JET THRUSTER NOZZLE & INDEPENDENT DUAL PLASMA FLAMES */}\n                <g className=\"m-thruster-rig\">\n                  <rect x=\"42\" y=\"96\" width=\"14\" height=\"8\" rx=\"3\" fill=\"#18222B\" stroke=\"#2D3E4E\" strokeWidth=\"1.2\" />\n                  <rect x=\"74\" y=\"96\" width=\"14\" height=\"8\" rx=\"3\" fill=\"#18222B\" stroke=\"#2D3E4E\" strokeWidth=\"1.2\" />\n                  <g className=\"m-plasma-flame m-flame-left\">\n                    <polygon points=\"43,103 55,103 49,118\" fill=\"url(#plasmaGrad)\" />\n                    <polygon className=\"m-flame-core\" points=\"46,103 52,103 49,113\" fill=\"#FFFFFF\" />\n                  </g>\n                  <g className=\"m-plasma-flame m-flame-right\">\n                    <polygon points=\"75,103 87,103 81,118\" fill=\"url(#plasmaGrad)\" />\n                    <polygon className=\"m-flame-core\" points=\"78,103 84,103 81,113\" fill=\"#FFFFFF\" />\n                  </g>\n                  <circle\n                    className=\"m-thrust-spark spark-1\"\n                    cx=\"49\"\n                    cy=\"106\"\n                    r=\"1.5\"\n                    fill=\"#33FF00\"\n                    style={{ '--sx': '-4px' } as React.CSSProperties}\n                  />\n                  <circle\n                    className=\"m-thrust-spark spark-2\"\n                    cx=\"81\"\n                    cy=\"107\"\n                    r=\"1.5\"\n                    fill=\"#00F0FF\"\n                    style={{ '--sx': '5px' } as React.CSSProperties}\n                  />\n                  <circle\n                    className=\"m-thrust-spark spark-3\"\n                    cx=\"65\"\n                    cy=\"108\"\n                    r=\"1.2\"\n                    fill=\"#FFFFFF\"\n                    style={{ '--sx': '-1px' } as React.CSSProperties}\n                  />\n                </g>\n\n                {/* 2. MAIN TORSO / CHASSIS POD */}\n                <g className=\"m-torso-chassis\">\n                  <rect x=\"36\" y=\"68\" width=\"58\" height=\"32\" rx=\"14\" fill=\"url(#chassisGrad)\" stroke=\"#324458\" strokeWidth=\"1.5\" />\n                  <line x1=\"42\" y1=\"78\" x2=\"88\" y2=\"78\" stroke=\"#162029\" strokeWidth=\"1.2\" />\n                  <circle cx=\"42\" cy=\"74\" r=\"1.2\" fill=\"#3B4E60\" />\n                  <circle cx=\"88\" cy=\"74\" r=\"1.2\" fill=\"#3B4E60\" />\n                  <circle cx=\"42\" cy=\"92\" r=\"1.2\" fill=\"#3B4E60\" />\n                  <circle cx=\"88\" cy=\"92\" r=\"1.2\" fill=\"#3B4E60\" />\n\n                  {/* Center Power Turbine Reactor Core */}\n                  <circle cx=\"65\" cy=\"84\" r=\"9\" fill=\"#070D12\" stroke=\"#00F0FF\" strokeWidth=\"1.4\" />\n                  <circle cx=\"65\" cy=\"84\" r=\"6\" fill=\"#0E1C26\" />\n                  <g className=\"m-rotor-spin\">\n                    <line x1=\"65\" y1=\"78\" x2=\"65\" y2=\"90\" stroke=\"#33FF00\" strokeWidth=\"1.4\" strokeLinecap=\"round\" />\n                    <line x1=\"59\" y1=\"84\" x2=\"71\" y2=\"84\" stroke=\"#33FF00\" strokeWidth=\"1.4\" strokeLinecap=\"round\" />\n                    <line x1=\"61\" y1=\"80\" x2=\"69\" y2=\"88\" stroke=\"#00F0FF\" strokeWidth=\"1.2\" strokeLinecap=\"round\" />\n                    <line x1=\"61\" y1=\"88\" x2=\"69\" y2=\"80\" stroke=\"#00F0FF\" strokeWidth=\"1.2\" strokeLinecap=\"round\" />\n                  </g>\n                  <circle cx=\"65\" cy=\"84\" r=\"2.2\" fill=\"#FFFFFF\" />\n\n                  {/* Quantum Golden Reactor Core Overlay (Permanent VIP) */}\n                  <g className=\"m-vip-reactor-glow\">\n                    <circle cx=\"65\" cy=\"84\" r=\"11\" fill=\"url(#reactorGoldGlow)\" />\n                    <circle cx=\"65\" cy=\"84\" r=\"8.5\" fill=\"#1C1402\" stroke=\"#FFD028\" strokeWidth=\"1.6\" />\n                    <g className=\"m-rotor-spin\">\n                      <line x1=\"65\" y1=\"77\" x2=\"65\" y2=\"91\" stroke=\"#FFE57F\" strokeWidth=\"1.6\" strokeLinecap=\"round\" />\n                      <line x1=\"58\" y1=\"84\" x2=\"72\" y2=\"84\" stroke=\"#FFE57F\" strokeWidth=\"1.6\" strokeLinecap=\"round\" />\n                      <line x1=\"60\" y1=\"79\" x2=\"70\" y2=\"89\" stroke=\"#FFB000\" strokeWidth=\"1.4\" strokeLinecap=\"round\" />\n                      <line x1=\"60\" y1=\"89\" x2=\"70\" y2=\"79\" stroke=\"#FFB000\" strokeWidth=\"1.4\" strokeLinecap=\"round\" />\n                    </g>\n                    <circle cx=\"65\" cy=\"84\" r=\"2.8\" fill=\"#FFFFFF\" />\n                    <circle\n                      className=\"m-vip-ember ember-1\"\n                      cx=\"63\"\n                      cy=\"80\"\n                      r=\"1.4\"\n                      fill=\"#FFD028\"\n                      style={{ '--ex': '-5px' } as React.CSSProperties}\n                    />\n                    <circle\n                      className=\"m-vip-ember ember-2\"\n                      cx=\"67\"\n                      cy=\"81\"\n                      r=\"1.3\"\n                      fill=\"#FFB000\"\n                      style={{ '--ex': '6px' } as React.CSSProperties}\n                    />\n                    <circle\n                      className=\"m-vip-ember ember-3\"\n                      cx=\"65\"\n                      cy=\"78\"\n                      r=\"1.1\"\n                      fill=\"#FFE57F\"\n                      style={{ '--ex': '1px' } as React.CSSProperties}\n                    />\n                  </g>\n                </g>\n\n                {/* 3. ARTICULATED SPRING NECK JOINT */}\n                <g className=\"m-neck-bellow\">\n                  <rect x=\"55\" y=\"58\" width=\"20\" height=\"4\" rx=\"2\" fill=\"#243240\" stroke=\"#3B4D5E\" strokeWidth=\"1\" />\n                  <rect x=\"57\" y=\"61\" width=\"16\" height=\"3\" rx=\"1.5\" fill=\"#151E26\" />\n                  <rect x=\"55\" y=\"63\" width=\"20\" height=\"4\" rx=\"2\" fill=\"#243240\" stroke=\"#3B4D5E\" strokeWidth=\"1\" />\n                </g>\n\n                {/* 4. HEAD ASSEMBLY WITH INDEPENDENT ROTATION/TILT */}\n                <g className=\"m-head-rig\">\n                  <rect x=\"25\" y=\"18\" width=\"80\" height=\"46\" rx=\"18\" fill=\"url(#headGrad)\" stroke=\"#33FF00\" strokeWidth=\"1.8\" />\n                  <rect x=\"18\" y=\"32\" width=\"8\" height=\"18\" rx=\"4\" fill=\"#1A242E\" stroke=\"#2E4050\" strokeWidth=\"1.4\" />\n                  <rect x=\"104\" y=\"32\" width=\"8\" height=\"18\" rx=\"4\" fill=\"#1A242E\" stroke=\"#2E4050\" strokeWidth=\"1.4\" />\n                  <line x1=\"22\" y1=\"36\" x2=\"22\" y2=\"46\" stroke=\"#33FF00\" strokeWidth=\"1.2\" />\n                  <line x1=\"108\" y1=\"36\" x2=\"108\" y2=\"46\" stroke=\"#33FF00\" strokeWidth=\"1.2\" />\n\n                  {/* Top Flexible Antenna Stalk & Sensor Dome */}\n                  <line x1=\"65\" y1=\"18\" x2=\"65\" y2=\"7\" stroke=\"#33FF00\" strokeWidth=\"2\" strokeLinecap=\"round\" />\n                  <circle className=\"m-antenna-orb\" cx=\"65\" cy=\"6\" r=\"4.5\" fill=\"#33FF00\" />\n                  <circle cx=\"65\" cy=\"6\" r=\"2\" fill=\"#FFFFFF\" />\n\n                  {/* Floating 3D Holographic Syndicate Crown/Halo (Permanent VIP) */}\n                  <g className=\"m-vip-crown-halo\">\n                    <ellipse\n                      className=\"m-vip-halo-ring\"\n                      cx=\"65\"\n                      cy=\"4\"\n                      rx=\"24\"\n                      ry=\"6\"\n                      fill=\"none\"\n                      stroke=\"url(#goldGrad)\"\n                      strokeWidth=\"2\"\n                      strokeDasharray=\"8 3\"\n                    />\n                    <polygon\n                      points=\"46,11 50,2 56,7 65,-4 74,7 80,2 84,11 65,8\"\n                      fill=\"url(#goldGrad)\"\n                      stroke=\"#FFF9C4\"\n                      strokeWidth=\"1.2\"\n                    />\n                    <polygon points=\"65,0 67,4 65,7 63,4\" fill=\"#FFFFFF\" />\n                    <circle cx=\"50\" cy=\"3\" r=\"1\" fill=\"#FFFFFF\" />\n                    <circle cx=\"80\" cy=\"3\" r=\"1\" fill=\"#FFFFFF\" />\n                  </g>\n\n                  {/* Glossy Digital Visor Screen */}\n                  <rect\n                    className=\"m-visor-screen\"\n                    x=\"32\"\n                    y=\"24\"\n                    width=\"66\"\n                    height=\"34\"\n                    rx=\"12\"\n                    fill=\"url(#visorGrad)\"\n                    stroke=\"#223648\"\n                    strokeWidth=\"1.5\"\n                  />\n                  <path d=\"M36 28 Q65 24 94 28\" stroke=\"rgba(255, 255, 255, 0.15)\" strokeWidth=\"1\" fill=\"none\" />\n\n                  {/* High-Density Matrix LED Eyes */}\n                  <g className=\"m-eyes-container\">\n                    <g className=\"m-blink-loop\">\n                      <g className=\"m-pupil-track\">\n                        <rect x=\"40\" y=\"31\" width=\"17\" height=\"18\" rx=\"6\" fill=\"#09141B\" stroke=\"#1D3342\" strokeWidth=\"1\" />\n                        <rect x=\"44\" y=\"34\" width=\"8\" height=\"11\" rx=\"2.5\" fill=\"#33FF00\" />\n                        <rect x=\"45\" y=\"35\" width=\"3\" height=\"4\" rx=\"1\" fill=\"#FFFFFF\" />\n                        <rect x=\"73\" y=\"31\" width=\"17\" height=\"18\" rx=\"6\" fill=\"#09141B\" stroke=\"#1D3342\" strokeWidth=\"1\" />\n                        <rect x=\"78\" y=\"34\" width=\"8\" height=\"11\" rx=\"2.5\" fill=\"#33FF00\" />\n                        <rect x=\"79\" y=\"35\" width=\"3\" height=\"4\" rx=\"1\" fill=\"#FFFFFF\" />\n                      </g>\n                    </g>\n                    {/* Visor Mouth Audio Grille */}\n                    <line x1=\"56\" y1=\"52\" x2=\"74\" y2=\"52\" stroke=\"#00F0FF\" strokeWidth=\"1.8\" strokeLinecap=\"round\" />\n                  </g>\n\n                  {/* Golden Cyber Polarized Shades Rig (Permanent VIP) */}\n                  <g className=\"m-vip-shades-rig\">\n                    <polygon points=\"35,30 63,30 60,46 39,46\" fill=\"url(#goldVisorGrad)\" stroke=\"#FFF59D\" strokeWidth=\"1.2\" />\n                    <polygon points=\"67,30 95,30 91,46 71,46\" fill=\"url(#goldVisorGrad)\" stroke=\"#FFF59D\" strokeWidth=\"1.2\" />\n                    <line x1=\"61\" y1=\"33\" x2=\"69\" y2=\"33\" stroke=\"#FFD028\" strokeWidth=\"2.5\" />\n                    <line x1=\"33\" y1=\"30\" x2=\"97\" y2=\"30\" stroke=\"#FFF59D\" strokeWidth=\"1.4\" />\n                    <g className=\"m-shades-glint\">\n                      <line x1=\"44\" y1=\"28\" x2=\"52\" y2=\"48\" stroke=\"#FFFFFF\" strokeWidth=\"2.5\" strokeLinecap=\"round\" opacity=\"0.9\" />\n                      <line x1=\"76\" y1=\"28\" x2=\"84\" y2=\"48\" stroke=\"#FFFFFF\" strokeWidth=\"2.5\" strokeLinecap=\"round\" opacity=\"0.9\" />\n                    </g>\n                  </g>\n                </g>\n\n                {/* VIP 4 : MATRIX HYPER-HACK PROPS (before arms so claws type on top) */}\n                <g className=\"m-vip-hack-scene\">\n                  <g className=\"m-holo-kb-ring\">\n                    <path d=\"M24 88 Q65 104 106 88\" fill=\"none\" stroke=\"#FFD028\" strokeWidth=\"4\" strokeLinecap=\"round\" opacity=\"0.85\" />\n                    <path d=\"M26 87 Q65 102 104 87\" fill=\"none\" stroke=\"#FFFFFF\" strokeWidth=\"1\" strokeDasharray=\"4 2\" />\n                  </g>\n                  <text className=\"m-hex-stream-1\" x=\"28\" y=\"78\" fontFamily=\"'JetBrains Mono', monospace\" fontSize=\"6.5\" fontWeight=\"bold\" fill=\"#FFD028\">0xVIP</text>\n                  <text className=\"m-hex-stream-2\" x=\"52\" y=\"74\" fontFamily=\"'JetBrains Mono', monospace\" fontSize=\"6.5\" fontWeight=\"bold\" fill=\"#FFE57F\">0xARCH</text>\n                  <text className=\"m-hex-stream-3\" x=\"82\" y=\"76\" fontFamily=\"'JetBrains Mono', monospace\" fontSize=\"6.5\" fontWeight=\"bold\" fill=\"#FFB000\">100TB</text>\n                </g>\n\n                {/* 5. MULTI-JOINTED LEFT ARM RIG */}\n                <g className=\"m-arm-left-rig\">\n                  <circle cx=\"26\" cy=\"72\" r=\"4.5\" fill=\"#1C2731\" stroke=\"#33FF00\" strokeWidth=\"1.2\" />\n                  <line x1=\"26\" y1=\"72\" x2=\"18\" y2=\"84\" stroke=\"#2C3D4D\" strokeWidth=\"3\" strokeLinecap=\"round\" />\n                  <circle cx=\"18\" cy=\"84\" r=\"3.5\" fill=\"#141E26\" stroke=\"#00F0FF\" strokeWidth=\"1\" />\n                  <line x1=\"18\" y1=\"84\" x2=\"16\" y2=\"94\" stroke=\"#3A4F63\" strokeWidth=\"2.5\" strokeLinecap=\"round\" />\n                  <g className=\"m-claw-l\">\n                    <path d=\"M13 94 L11 100 M16 95 L16 102 M19 94 L21 100\" stroke=\"#33FF00\" strokeWidth=\"1.5\" strokeLinecap=\"round\" />\n                  </g>\n                </g>\n\n                {/* 6. MULTI-JOINTED RIGHT ARM RIG WITH NESTED IN-HAND PROPS */}\n                <g className=\"m-arm-right-rig\">\n                  <circle cx=\"104\" cy=\"72\" r=\"4.5\" fill=\"#1C2731\" stroke=\"#33FF00\" strokeWidth=\"1.2\" />\n                  <line x1=\"104\" y1=\"72\" x2=\"112\" y2=\"84\" stroke=\"#2C3D4D\" strokeWidth=\"3\" strokeLinecap=\"round\" />\n                  <circle cx=\"112\" cy=\"84\" r=\"3.5\" fill=\"#141E26\" stroke=\"#00F0FF\" strokeWidth=\"1\" />\n                  <line x1=\"112\" y1=\"84\" x2=\"114\" y2=\"94\" stroke=\"#3A4F63\" strokeWidth=\"2.5\" strokeLinecap=\"round\" />\n                  <g className=\"m-claw-r\">\n                    <path d=\"M111 94 L109 100 M114 95 L114 102 M117 94 L119 100\" stroke=\"#33FF00\" strokeWidth=\"1.5\" strokeLinecap=\"round\" />\n\n                    {/* IN-HAND PROP 1: BLASTER CANNON (Bug Hunter) */}\n                    <g className=\"m-cannon-prop\">\n                      <rect x=\"108\" y=\"93\" width=\"14\" height=\"7\" rx=\"2\" fill=\"#1E2B38\" stroke=\"#00F0FF\" strokeWidth=\"1.2\" />\n                      <rect x=\"120\" y=\"94\" width=\"4\" height=\"5\" rx=\"1\" fill=\"#33FF00\" />\n                      <line className=\"m-laser-strike\" x1=\"124\" y1=\"96\" x2=\"108\" y2=\"28\" />\n                    </g>\n\n                    {/* IN-HAND PROP 2: MICROFIBER CLOTH (Sensor Polish) */}\n                    <g className=\"m-polish-cloth\">\n                      <rect x=\"109\" y=\"94\" width=\"10\" height=\"10\" rx=\"3\" fill=\"#00F0FF\" stroke=\"#FFFFFF\" strokeWidth=\"1\" opacity=\"0.9\" />\n                    </g>\n\n                    {/* IN-HAND PROP 3: NANO ESPRESSO CUP (Nano Coffee) */}\n                    <g className=\"m-coffee-cup\">\n                      <rect x=\"108\" y=\"93\" width=\"12\" height=\"14\" rx=\"3\" fill=\"#243340\" stroke=\"#33FF00\" strokeWidth=\"1.2\" />\n                      <path d=\"M120 96 Q124 100 120 104\" fill=\"none\" stroke=\"#33FF00\" strokeWidth=\"1.2\" />\n                      <g className=\"m-coffee-steam\">\n                        <path d=\"M110 90 Q114 86 118 90 M111 85 Q114 81 117 85\" fill=\"none\" stroke=\"#00F0FF\" strokeWidth=\"1\" strokeLinecap=\"round\" />\n                      </g>\n                    </g>\n\n                    {/* IN-HAND PROP 4: GOLDEN TOAST MUG (VIP Toast) */}\n                    <g className=\"m-toast-mug\">\n                      <rect x=\"108\" y=\"92\" width=\"13\" height=\"15\" rx=\"3\" fill=\"#2E2406\" stroke=\"#FFD028\" strokeWidth=\"1.4\" />\n                      <rect x=\"110\" y=\"94\" width=\"9\" height=\"4\" rx=\"1\" fill=\"#FFD028\" />\n                      <path d=\"M121 95 Q126 99 121 104\" fill=\"none\" stroke=\"#FFD028\" strokeWidth=\"1.4\" />\n                      <g className=\"m-gold-steam\">\n                        <path d=\"M110 88 Q114 83 118 88 M111 82 Q115 77 119 82\" fill=\"none\" stroke=\"#FFE57F\" strokeWidth=\"1.4\" strokeLinecap=\"round\" />\n                      </g>\n                    </g>\n                  </g>\n                </g>\n\n                {/* ACTIVITY 1 : BUG HUNTER (Reticle + Evading Cyber Bug) */}\n                <g className=\"m-bug-group\">\n                  <g className=\"m-target-reticle\">\n                    <circle cx=\"106\" cy=\"26\" r=\"10\" fill=\"none\" stroke=\"#FF2E63\" strokeWidth=\"1\" strokeDasharray=\"3 2\" />\n                  </g>\n                  <g className=\"m-target-bug\">\n                    <ellipse cx=\"106\" cy=\"26\" rx=\"4\" ry=\"3\" fill=\"#FF2E63\" />\n                    <circle cx=\"104\" cy=\"25\" r=\"1\" fill=\"#FFFFFF\" />\n                    <circle cx=\"108\" cy=\"25\" r=\"1\" fill=\"#FFFFFF\" />\n                    <ellipse className=\"m-bug-wing-l\" cx=\"103\" cy=\"22\" rx=\"3.5\" ry=\"1.5\" fill=\"rgba(0, 240, 255, 0.7)\" />\n                    <ellipse className=\"m-bug-wing-r\" cx=\"109\" cy=\"22\" rx=\"3.5\" ry=\"1.5\" fill=\"rgba(0, 240, 255, 0.7)\" />\n                    <polygon points=\"106,20 108,24 112,26 108,28 106,32 104,28 100,26 104,24\" fill=\"#FFD028\" opacity=\"0.85\" />\n                  </g>\n                </g>\n\n                {/* ACTIVITY 2 : LOW BATTERY HUD */}\n                <g className=\"m-low-batt-hud\">\n                  <rect x=\"52\" y=\"32\" width=\"26\" height=\"15\" rx=\"3\" fill=\"#0A0406\" stroke=\"#FF2E63\" strokeWidth=\"1.5\" />\n                  <rect x=\"78\" y=\"36\" width=\"2\" height=\"7\" rx=\"1\" fill=\"#FF2E63\" />\n                  <rect x=\"55\" y=\"35\" width=\"6\" height=\"9\" rx=\"1\" fill=\"#FF2E63\" />\n                  <text x=\"65\" y=\"44\" fontFamily=\"'JetBrains Mono', monospace\" fontSize=\"8\" fontWeight=\"bold\" fill=\"#FF2E63\" textAnchor=\"middle\">!</text>\n                </g>\n\n                {/* ACTIVITY 3 : TURBINE GENERATOR FX */}\n                <g className=\"m-turbine-fx\">\n                  <path className=\"m-plasma-arc\" d=\"M30 76 Q45 84 60 84 M100 76 Q85 84 70 84\" fill=\"none\" stroke=\"#00F0FF\" strokeWidth=\"2\" />\n                  <circle cx=\"65\" cy=\"84\" r=\"13\" fill=\"none\" stroke=\"#33FF00\" strokeWidth=\"1\" strokeDasharray=\"3 2\" />\n                </g>\n\n                {/* ACTIVITY 4 : SENSOR POLISH GLINT */}\n                <g className=\"m-polish-fx\">\n                  <polygon className=\"m-polish-glint\" points=\"48,34 51,40 57,43 51,46 48,52 45,46 39,43 45,40\" fill=\"#FFFFFF\" />\n                </g>\n\n                {/* ACTIVITY 5 : MODEL JUGGLER CUBES */}\n                <g className=\"m-juggler-fx\">\n                  <g className=\"j-cube-1\">\n                    <rect x=\"-6\" y=\"-6\" width=\"12\" height=\"12\" rx=\"3\" fill=\"#00F0FF\" stroke=\"#FFFFFF\" strokeWidth=\"0.8\" />\n                    <text x=\"0\" y=\"3\" fontFamily=\"'JetBrains Mono', monospace\" fontSize=\"6\" fontWeight=\"bold\" fill=\"#05141C\" textAnchor=\"middle\">70B</text>\n                  </g>\n                  <g className=\"j-cube-2\">\n                    <rect x=\"-6\" y=\"-6\" width=\"12\" height=\"12\" rx=\"3\" fill=\"#33FF00\" stroke=\"#FFFFFF\" strokeWidth=\"0.8\" />\n                    <text x=\"0\" y=\"3\" fontFamily=\"'JetBrains Mono', monospace\" fontSize=\"6\" fontWeight=\"bold\" fill=\"#051405\" textAnchor=\"middle\">8B</text>\n                  </g>\n                  <g className=\"j-cube-3\">\n                    <rect x=\"-6\" y=\"-6\" width=\"12\" height=\"12\" rx=\"3\" fill=\"#FFD028\" stroke=\"#FFFFFF\" strokeWidth=\"0.8\" />\n                    <text x=\"0\" y=\"3\" fontFamily=\"'JetBrains Mono', monospace\" fontSize=\"5\" fontWeight=\"bold\" fill=\"#1C1405\" textAnchor=\"middle\">MoE</text>\n                  </g>\n                </g>\n\n                {/* ACTIVITY 6 : NANO COFFEE flag anchor */}\n                <g className=\"m-coffee-fx\" />\n\n                {/* ACTIVITY 7 : POWER NAP (Sleepy eyes + sinusoidal Zzz) */}\n                <g className=\"m-nap-fx\">\n                  <path d=\"M42 42 Q48 46 54 42\" fill=\"none\" stroke=\"#33FF00\" strokeWidth=\"2.5\" strokeLinecap=\"round\" />\n                  <path d=\"M76 42 Q82 46 88 42\" fill=\"none\" stroke=\"#33FF00\" strokeWidth=\"2.5\" strokeLinecap=\"round\" />\n                  <text className=\"nap-zzz-1\" x=\"0\" y=\"0\" fontFamily=\"'JetBrains Mono', monospace\" fontSize=\"10\" fontWeight=\"bold\" fill=\"#33FF00\">Z</text>\n                  <text className=\"nap-zzz-2\" x=\"0\" y=\"0\" fontFamily=\"'JetBrains Mono', monospace\" fontSize=\"8\" fontWeight=\"bold\" fill=\"#00F0FF\">z</text>\n                  <text className=\"nap-zzz-3\" x=\"0\" y=\"0\" fontFamily=\"'JetBrains Mono', monospace\" fontSize=\"7\" fill=\"#33FF00\">z</text>\n                </g>\n\n                {/* VIP EXCLUSIVE SCENE PROPS */}\n                <g className=\"m-vip-salute-scene\">\n                  <line x1=\"88\" y1=\"60\" x2=\"120\" y2=\"52\" stroke=\"#FFD028\" strokeWidth=\"1.5\" strokeDasharray=\"3 2\" opacity=\"0.8\" />\n                </g>\n                <g className=\"m-vip-toast-scene\" />\n                <g className=\"m-vip-wink-scene\">\n                  <polygon className=\"m-wink-lens-flare\" points=\"44,28 46,34 52,36 46,38 44,44 42,38 36,36 42,34\" fill=\"#FFFFFF\" />\n                </g>\n                <g className=\"m-vip-meditation-scene\">\n                  <g className=\"m-quantum-matrix-ring\">\n                    <ellipse className=\"q-ring-outer\" cx=\"65\" cy=\"65\" rx=\"58\" ry=\"18\" fill=\"none\" stroke=\"#FFD028\" strokeWidth=\"1.8\" strokeDasharray=\"8 4\" />\n                    <ellipse className=\"q-ring-inner\" cx=\"65\" cy=\"65\" rx=\"46\" ry=\"14\" fill=\"none\" stroke=\"#FFE57F\" strokeWidth=\"1\" strokeDasharray=\"4 3\" />\n                    <g className=\"m-quantum-node-1\">\n                      <circle cx=\"7\" cy=\"65\" r=\"3\" fill=\"#FFD028\" />\n                      <polygon points=\"7,62 9,65 7,68 5,65\" fill=\"#FFFFFF\" />\n                    </g>\n                    <g className=\"m-quantum-node-2\">\n                      <circle cx=\"123\" cy=\"65\" r=\"3\" fill=\"#FFD028\" />\n                      <polygon points=\"123,62 125,65 123,68 121,65\" fill=\"#FFFFFF\" />\n                    </g>\n                  </g>\n                </g>\n\n                {/* EASTER EGG : DATA-DISK TOSS */}\n                <g className=\"m-vip-disk-scene\">\n                  <g className=\"m-tossed-disk\">\n                    <ellipse cx=\"65\" cy=\"40\" rx=\"14\" ry=\"7\" fill=\"url(#goldGrad)\" stroke=\"#FFFFFF\" strokeWidth=\"1\" />\n                    <ellipse cx=\"65\" cy=\"40\" rx=\"6\" ry=\"3\" fill=\"#1A1202\" stroke=\"#FFE57F\" strokeWidth=\"0.8\" />\n                    <text x=\"65\" y=\"42\" fontFamily=\"'JetBrains Mono', monospace\" fontSize=\"4\" fontWeight=\"bold\" fill=\"#FFE57F\" textAnchor=\"middle\">100TB</text>\n                  </g>\n                </g>\n              </g>\n            </svg>\n            </div>\n          ) : (\n            <div className=\"hacker-viewport\">\n              <div className=\"crt-casing\">\n                <div className=\"crt-screen\">\n                  <div className=\"crt-term-line\">\n                    <span className=\"crt-term-prompt\">&gt;</span>\n                    <span className=\"crt-type-text\">nv-gateway --serve</span>\n                    <span className=\"crt-cursor\" />\n                  </div>\n                  <div className=\"hacker-stage\">\n                    <canvas ref={canvasRef} width={160} height={152} />\n                  </div>\n                </div>\n                <div className=\"crt-brand\">\n                  <span>TRM-80 · DEV PET</span>\n                  <span className=\"crt-led\" />\n                </div>\n              </div>\n\n              {/* Dev tip jar row */}\n              <div className=\"jar-box\">\n                <svg className=\"jar-svg px\" viewBox=\"0 0 34 42\" shapeRendering=\"crispEdges\" aria-hidden=\"true\">\n                  <rect x=\"7\" y=\"3\" width=\"4\" height=\"2\" fill=\"#2C3A48\" />\n                  <rect x=\"23\" y=\"3\" width=\"4\" height=\"2\" fill=\"#2C3A48\" />\n                  <path\n                    d=\"M10 5 h14 v2 h2 v2 h2 v26 h-2 v2 h-2 v2 h-14 v-2 h-2 v-2 h-2 v-26 h2 v-2 h2 z\"\n                    fill=\"rgba(0, 240, 255, 0.05)\"\n                    stroke=\"#3A4B5C\"\n                    strokeWidth=\"1\"\n                  />\n                  <rect x=\"9\" y=\"11\" width=\"2\" height=\"10\" fill=\"rgba(220, 229, 237, 0.08)\" />\n                  <g fill=\"#FFD028\">\n                    <rect x=\"11\" y=\"34\" width=\"10\" height=\"3\" />\n                    <rect x=\"15\" y=\"31\" width=\"10\" height=\"3\" />\n                    <rect x=\"10\" y=\"28\" width=\"10\" height=\"3\" />\n                  </g>\n                  <g className=\"h-coin-drop-loop\" fill=\"#FFD028\">\n                    <rect x=\"12\" y=\"0\" width=\"10\" height=\"3\" />\n                  </g>\n                </svg>\n                <div>\n                  <div className=\"jar-title\">{t('pet_jar_title')}</div>\n                  <div className=\"jar-subtitle\">{t('pet_jar_subtitle')}</div>\n                </div>\n              </div>\n            </div>\n          )}\n\n          <div className=\"context-cta\">\n            <span className=\"cta-text\">{t('pet_cta_main')}</span>\n          </div>\n          <div className=\"cta-subtext\">{t('pet_cta_sub')}</div>\n        </button>\n      </div>\n    </div>\n  );\n}\n\n// ==========================================\n// PIXEL HACKER CANVAS 2D RENDERER\n// Ported from interactive-showcase.html class PixelHackerEngine (#hackerCanvas).\n// Backing store 160x152; displayed 80x76 via CSS pixelated scaling.\n// The DOM/state-global coupling of the mockup is replaced by an explicit\n// setMode() API driven by the pet engine's activity changes. Audio coupling\n// lives in PetWidget / petAudio, NOT here.\n// ==========================================\n\ninterface MatrixColumn {\n  x: number;\n  y: number;\n  speed: number;\n  chars: string[];\n}\n\ninterface SmokePuff {\n  x: number;\n  y: number;\n  vy: number;\n  vx: number;\n  size: number;\n  alpha: number;\n  color: string;\n}\n\ninterface ConfettiPiece {\n  x: number;\n  y: number;\n  vx: number;\n  vy: number;\n  size: number;\n  color: string;\n  rot: number;\n  rotSpeed: number;\n}\n\ninterface SnoreGlyph {\n  x: number;\n  y: number;\n  vx: number;\n  vy: number;\n  size: number;\n  alpha: number;\n}\n\ninterface KatanaSpark {\n  x: number;\n  y: number;\n  vx: number;\n  vy: number;\n  color: string;\n  size: number;\n  alpha: number;\n}\n\ninterface SteamPuff {\n  x: number;\n  y: number;\n  vy: number;\n  alpha: number;\n}\n\ninterface VipEmber {\n  x: number;\n  y: number;\n  vy: number;\n  size: number;\n  alpha: number;\n}\n\nclass PixelHackerRenderer {\n  private readonly ctx: CanvasRenderingContext2D;\n  private readonly width = 160;\n  private readonly height = 152;\n  private rafId = 0;\n\n  private lastTime = performance.now();\n  private stateTimer = 0;\n  private mode = 'idle';\n  private prevMode = '';\n\n  private smokePuffs: SmokePuff[] = [];\n  private confetti: ConfettiPiece[] = [];\n  private snores: SnoreGlyph[] = [];\n  private katanaSparks: KatanaSpark[] = [];\n  private steamParticles: SteamPuff[] = [];\n  private vipEmbers: VipEmber[] = [];\n  private matrixColumns: MatrixColumn[] = [];\n\n  private disk = { x: 80, y: 80, vy: -6, rot: 0, active: false };\n\n  private constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {\n    this.ctx = ctx;\n    this.ctx.imageSmoothingEnabled = false;\n    canvas.width = this.width;\n    canvas.height = this.height;\n\n    // Initialize 10 matrix rain columns\n    for (let c = 0; c < 10; c++) {\n      this.matrixColumns.push({\n        x: 8 + c * 16,\n        y: Math.random() * this.height,\n        speed: 18 + Math.random() * 32,\n        chars: ['0', '1', '>', '#', '*', 'x', '7', 'F', '$', ';'],\n      });\n    }\n\n    this.initConfetti();\n  }\n\n  /** Factory — returns null when a 2D context is unavailable. */\n  static create(canvas: HTMLCanvasElement): PixelHackerRenderer | null {\n    const ctx = canvas.getContext('2d');\n    return ctx ? new PixelHackerRenderer(canvas, ctx) : null;\n  }\n\n  start(): void {\n    if (this.rafId === 0) {\n      this.lastTime = performance.now();\n      this.rafId = requestAnimationFrame(this.loop);\n    }\n  }\n\n  destroy(): void {\n    if (this.rafId !== 0) {\n      cancelAnimationFrame(this.rafId);\n      this.rafId = 0;\n    }\n  }\n\n  setMode(mode: string): void {\n    this.mode = mode;\n  }\n\n  private initConfetti(): void {\n    this.confetti = [];\n    const colors = ['#FFD028', '#00F0FF', '#33FF00', '#FF2E63', '#FFFFFF', '#B55FE6'];\n    for (let i = 0; i < 26; i++) {\n      this.confetti.push({\n        x: Math.random() * this.width,\n        y: Math.random() * this.height,\n        vy: 24 + Math.random() * 40,\n        vx: (Math.random() - 0.5) * 16,\n        size: 2 + (i % 3) * 2,\n        color: colors[i % colors.length],\n        rot: Math.random() * Math.PI * 2,\n        rotSpeed: (Math.random() - 0.5) * 5,\n      });\n    }\n  }\n\n  private resetModeState(mode: string): void {\n    this.stateTimer = 0;\n    this.smokePuffs = [];\n    this.snores = [];\n    this.katanaSparks = [];\n    this.steamParticles = [];\n\n    if (mode === 'disk-toss') {\n      this.disk = { x: 80, y: 92, vy: -5.5, rot: 0, active: true };\n    } else if (mode === 'zero-errors' || mode === 'celebration') {\n      this.initConfetti();\n    }\n  }\n\n  // Draw utilities\n  private drawPixel(x: number, y: number, color: string, size = 1): void {\n    this.ctx.fillStyle = color;\n    this.ctx.fillRect(Math.floor(x), Math.floor(y), size, size);\n  }\n\n  private drawRect(x: number, y: number, w: number, h: number, color: string): void {\n    this.ctx.fillStyle = color;\n    this.ctx.fillRect(Math.floor(x), Math.floor(y), Math.floor(w), Math.floor(h));\n  }\n\n  private drawPixelText(text: string, x: number, y: number, color: string, size = 8): void {\n    this.ctx.fillStyle = color;\n    this.ctx.font = `bold ${size}px 'JetBrains Mono', monospace`;\n    this.ctx.fillText(text, Math.floor(x), Math.floor(y));\n  }\n\n  private readonly loop = (timestamp: number): void => {\n    const dt = Math.min((timestamp - this.lastTime) / 1000, 0.1);\n    this.lastTime = timestamp;\n\n    if (this.mode !== this.prevMode) {\n      this.resetModeState(this.mode);\n      this.prevMode = this.mode;\n    }\n\n    this.stateTimer += dt;\n    this.render(timestamp / 1000, dt);\n\n    this.rafId = requestAnimationFrame(this.loop);\n  };\n\n  private render(time: number, dt: number): void {\n    const isVip =\n      this.mode.startsWith('vip-') || this.mode === 'patron' || this.mode === 'disk-toss';\n    const mode = this.mode;\n\n    // 1. Clear screen & ambient phosphor backing\n    this.ctx.clearRect(0, 0, this.width, this.height);\n\n    if (mode === 'zero-errors' || mode === 'celebration') {\n      const glowAlpha = 0.18 + Math.sin(this.stateTimer * 6) * 0.08;\n      this.ctx.fillStyle = `rgba(0, 255, 102, ${glowAlpha})`;\n      this.ctx.fillRect(0, 0, this.width, this.height);\n    } else if (isVip) {\n      this.ctx.fillStyle = 'rgba(255, 208, 40, 0.05)';\n      this.ctx.fillRect(0, 0, this.width, this.height);\n    }\n\n    // 2. Matrix digital rain background\n    this.renderMatrixRain(dt, isVip);\n\n    // 3. Chair backdrop\n    this.renderChair(time, isVip, mode);\n\n    // 4. Character parameters\n    let jumpY = 0;\n    if (mode === 'zero-errors' || mode === 'celebration') {\n      jumpY = -Math.abs(Math.sin(this.stateTimer * 6)) * 14;\n    } else if (mode === 'vip-quantum-meditation') {\n      jumpY = Math.sin(time * 2.5) * 9 - 4;\n    }\n\n    let headBobY = Math.sin(time * 2.8) * 1.5;\n    if (mode === 'code-frenzy' || mode === 'vip-hyper-hack') {\n      headBobY = Math.sin(time * 24) * 2.2;\n    } else if (mode === 'terminal-nap') {\n      headBobY = 32; // slumped onto keyboard\n    } else if (mode === 'empty-mug' && (this.stateTimer % 4.8) > 1.2 && (this.stateTimer % 4.8) < 3.2) {\n      headBobY = -3; // head tilted back to drink\n    }\n\n    // 5. Hacker body & hood\n    this.renderHackerTorso(jumpY, isVip);\n    this.renderHackerHead(jumpY, headBobY, isVip, mode, time);\n\n    // 6. Desk & mechanical keyboard\n    this.renderDeskAndKeyboard(time, isVip, mode);\n\n    // 7. Hands & mode-specific action layers\n    this.renderActionLayer(jumpY, isVip, mode, time, dt);\n\n    // 8. Foreground particles\n    this.renderForegroundParticles(dt, mode, isVip);\n  }\n\n  private renderMatrixRain(dt: number, isVip: boolean): void {\n    for (let i = 0; i < this.matrixColumns.length; i++) {\n      const col = this.matrixColumns[i];\n      col.y += col.speed * dt;\n      if (col.y > this.height + 40) {\n        col.y = -20 - Math.random() * 30;\n        col.speed = 18 + Math.random() * 32;\n      }\n\n      // Streaming glyphs per column\n      const charCount = 4;\n      for (let g = 0; g < charCount; g++) {\n        const py = col.y - g * 8;\n        if (py >= 0 && py < this.height - 30) {\n          const ch = col.chars[(Math.floor(col.y * 0.1) + g) % col.chars.length];\n          const isLead = g === 0;\n          if (isVip) {\n            this.ctx.fillStyle = isLead ? '#FFF9C4' : g === 1 ? '#FFD028' : 'rgba(255, 208, 40, 0.3)';\n          } else {\n            this.ctx.fillStyle = isLead ? '#E8FFE8' : g === 1 ? '#33FF00' : 'rgba(51, 255, 0, 0.25)';\n          }\n          this.ctx.font = \"bold 6px 'JetBrains Mono', monospace\";\n          this.ctx.fillText(ch, col.x, py);\n        }\n      }\n    }\n  }\n\n  private renderChair(time: number, isVip: boolean, mode: string): void {\n    let chairSway = 0;\n    if (mode === 'celebration') {\n      chairSway = Math.sin(time * 8) * 2;\n    }\n\n    const cx = 44 + chairSway;\n    const cy = 30;\n    const cw = 72;\n    const ch = 76;\n\n    const frameColor = isVip ? '#2A2005' : '#0B1A0B';\n    const innerColor = isVip ? '#1A1302' : '#040C04';\n    const ribColor = isVip ? '#FFD028' : '#143814';\n\n    this.drawRect(cx, cy, cw, ch, frameColor);\n    this.drawRect(cx + 4, cy + 4, cw - 8, ch - 8, innerColor);\n\n    // Ribbing & gold accent piping\n    this.drawRect(cx + 6, cy + 18, cw - 12, 2, ribColor);\n    this.drawRect(cx + 6, cy + 36, cw - 12, 2, ribColor);\n    this.drawRect(cx + 6, cy + 54, cw - 12, 2, ribColor);\n\n    if (isVip) {\n      this.drawRect(cx, cy, cw, 2, '#FFD028');\n      this.drawRect(cx + cw / 2 - 8, cy - 2, 16, 2, '#FFE57F');\n    }\n  }\n\n  private renderDeskAndKeyboard(time: number, isVip: boolean, mode: string): void {\n    const deskEdgeColor = isVip ? '#8C6B14' : '#188000';\n    const deskBodyColor = isVip ? '#3A2A04' : '#0A3C00';\n    const deskShadeColor = isVip ? '#1F1602' : '#041800';\n\n    this.drawRect(0, 120, this.width, 4, deskEdgeColor);\n    this.drawRect(0, 124, this.width, 28, deskBodyColor);\n    this.drawRect(0, 146, this.width, 6, deskShadeColor);\n\n    const kbColor = isVip ? '#281C02' : '#0A2E00';\n    const kbBorder = isVip ? '#FFD028' : '#146E00';\n    this.drawRect(18, 122, 124, 16, kbColor);\n    this.drawRect(18, 122, 124, 1, kbBorder);\n\n    // 8 keycap clusters\n    const keyPositions = [26, 40, 54, 68, 82, 96, 110, 124];\n    const typingLeft = Math.sin(time * 8) > 0;\n\n    for (let k = 0; k < keyPositions.length; k++) {\n      const kx = keyPositions[k];\n      let isLit = false;\n\n      if (mode === 'code-frenzy' || mode === 'vip-hyper-hack') {\n        isLit = Math.random() < 0.4;\n      } else if (mode === 'terminal-nap') {\n        isLit = k >= 3 && k <= 5;\n      } else if (mode === 'idle') {\n        isLit = (typingLeft && (k === 1 || k === 2)) || (!typingLeft && (k === 5 || k === 6));\n      }\n\n      if (isLit) {\n        const litColor = isVip ? '#FFE57F' : '#00FF66';\n        this.drawRect(kx, 125, 10, 8, litColor);\n        this.drawPixel(kx + 2, 126, '#FFFFFF', 2);\n      } else {\n        const baseKey = isVip ? '#181001' : '#041A00';\n        this.drawRect(kx, 125, 10, 8, baseKey);\n      }\n    }\n  }\n\n  private renderHackerTorso(jumpY: number, isVip: boolean): void {\n    const bx = 32;\n    const by = 74 + jumpY;\n    const bw = 96;\n    const bh = 48;\n\n    const robeHighlight = isVip ? '#FFD028' : '#33FF00';\n    const robeMain = isVip ? '#3D2E04' : '#20B800';\n    const robeShadow = isVip ? '#241B03' : '#146E00';\n    const robeDeep = isVip ? '#120D01' : '#083C00';\n\n    // Shoulders\n    this.drawRect(bx + 4, by, bw - 8, 14, robeMain);\n    this.drawRect(bx + 4, by, bw - 8, 2, robeHighlight);\n\n    // Torso body\n    this.drawRect(bx, by + 14, bw, bh - 14, robeMain);\n    this.drawRect(bx + 12, by + 14, bw - 24, bh - 14, robeShadow);\n    this.drawRect(bx + 28, by + 20, bw - 56, bh - 20, robeDeep);\n\n    // Robe fold details & VIP circuit traces\n    if (isVip) {\n      this.drawRect(bx + 36, by + 18, 2, 22, '#FFD028');\n      this.drawRect(bx + bw - 38, by + 18, 2, 22, '#FFD028');\n      this.drawPixel(bx + bw / 2 - 1, by + 28, '#FFE57F', 3);\n    } else {\n      this.drawRect(bx + 40, by + 18, 2, 22, '#33FF00');\n      this.drawRect(bx + bw - 42, by + 18, 2, 22, '#33FF00');\n    }\n  }\n\n  private renderHackerHead(\n    jumpY: number,\n    headBobY: number,\n    isVip: boolean,\n    mode: string,\n    time: number,\n  ): void {\n    const hx = 52;\n    const hy = 22 + jumpY + headBobY;\n    const hw = 56;\n    const hh = 52;\n\n    const hoodHighlight = isVip ? '#FFE57F' : '#33FF00';\n    const hoodMain = isVip ? '#3D2E04' : '#20B800';\n    const hoodShadow = isVip ? '#1F1702' : '#146E00';\n    const shadowVoid = '#010801';\n\n    // Outer hood crown & arch\n    this.drawRect(hx + 8, hy, hw - 16, 6, hoodMain);\n    this.drawRect(hx + 8, hy, hw - 16, 2, hoodHighlight);\n    this.drawRect(hx + 4, hy + 6, hw - 8, 8, hoodMain);\n    this.drawRect(hx, hy + 14, hw, hh - 14, hoodMain);\n    this.drawRect(hx, hy + 14, 4, hh - 14, hoodHighlight);\n    this.drawRect(hx + hw - 4, hy + 14, 4, hh - 14, hoodHighlight);\n\n    // Inner cowl shadow opening\n    this.drawRect(hx + 8, hy + 16, hw - 16, hh - 22, hoodShadow);\n    this.drawRect(hx + 12, hy + 20, hw - 24, hh - 28, shadowVoid);\n\n    // Visor expressions / eyes\n    if (mode === 'terminal-nap') {\n      // Resting slits\n      this.drawRect(hx + 18, hy + 30, 8, 2, '#146E00');\n      this.drawRect(hx + 30, hy + 30, 8, 2, '#146E00');\n    } else if (isVip && mode !== 'zero-errors' && mode !== 'celebration') {\n      // Golden sunglasses with active ruby laser sweep\n      this.drawRect(hx + 14, hy + 24, 12, 10, '#FFD028');\n      this.drawRect(hx + 30, hy + 24, 12, 10, '#FFD028');\n      this.drawRect(hx + 24, hy + 26, 8, 3, '#FFD028');\n      this.drawRect(hx + 16, hy + 26, 8, 6, '#3A2A04');\n      this.drawRect(hx + 32, hy + 26, 8, 6, '#3A2A04');\n\n      const laserOffset = (Math.sin(time * 4) + 1) * 0.5 * 24;\n      const lx = hx + 15 + laserOffset;\n      this.drawRect(lx, hy + 26, 4, 6, '#FF2E63');\n      this.drawPixel(lx + 1, hy + 27, '#FFA0B8', 2);\n    } else if (mode === 'intent') {\n      // Exclamation mark visor ! !\n      this.drawRect(hx + 18, hy + 22, 4, 10, '#FFD028');\n      this.drawRect(hx + 18, hy + 34, 4, 3, '#FFD028');\n      this.drawRect(hx + 34, hy + 22, 4, 10, '#FFD028');\n      this.drawRect(hx + 34, hy + 34, 4, 3, '#FFD028');\n    } else if (mode === 'zero-errors' || mode === 'celebration') {\n      // Joyful arch ^ ^\n      const eyeCol = '#00FF66';\n      this.drawRect(hx + 16, hy + 28, 3, 4, eyeCol);\n      this.drawRect(hx + 19, hy + 24, 4, 4, eyeCol);\n      this.drawRect(hx + 23, hy + 28, 3, 4, eyeCol);\n      this.drawRect(hx + 30, hy + 28, 3, 4, eyeCol);\n      this.drawRect(hx + 33, hy + 24, 4, 4, eyeCol);\n      this.drawRect(hx + 37, hy + 28, 3, 4, eyeCol);\n    } else if (mode === 'bug-slayer') {\n      // Angled blade glare \\ /\n      this.drawRect(hx + 16, hy + 24, 4, 4, '#00F0FF');\n      this.drawRect(hx + 20, hy + 28, 4, 4, '#00F0FF');\n      this.drawRect(hx + 32, hy + 28, 4, 4, '#FF2E63');\n      this.drawRect(hx + 36, hy + 24, 4, 4, '#FF2E63');\n    } else if (mode === 'empty-mug' && this.stateTimer % 4.8 > 2.0) {\n      // Droopy sad eyes - -\n      this.drawRect(hx + 16, hy + 29, 8, 3, '#00F0FF');\n      this.drawRect(hx + 32, hy + 29, 8, 3, '#00F0FF');\n      this.drawPixel(hx + 18, hy + 34, '#00F0FF', 3);\n    } else {\n      // Default blinking eyes\n      const isBlink = time % 3.0 < 0.12;\n      const eyeH = isBlink ? 2 : 6;\n      const eyeY = isBlink ? hy + 28 : hy + 26;\n\n      this.drawRect(hx + 16, eyeY, 8, eyeH, '#E8FFE8');\n      this.drawRect(hx + 32, eyeY, 8, eyeH, '#E8FFE8');\n      if (!isBlink) {\n        this.drawRect(hx + 18, eyeY + 2, 4, 2, '#33FF00');\n        this.drawRect(hx + 34, eyeY + 2, 4, 2, '#33FF00');\n      }\n    }\n\n    // 8-bit golden crown in VIP mode\n    if (isVip) {\n      const cx = hx + 10;\n      const cy = hy - 14;\n      this.drawRect(cx, cy + 8, 36, 4, '#FFD028');\n      this.drawRect(cx + 2, cy + 2, 6, 6, '#FFD028');\n      this.drawRect(cx + 15, cy - 2, 6, 10, '#FFD028');\n      this.drawRect(cx + 28, cy + 2, 6, 6, '#FFD028');\n      this.drawPixel(cx + 16, cy, '#FFFFFF', 3);\n    }\n  }\n\n  private renderActionLayer(\n    jumpY: number,\n    isVip: boolean,\n    mode: string,\n    time: number,\n    dt: number,\n  ): void {\n    const gloveColor = isVip ? '#FFE57F' : '#33FF00';\n    const gloveShadow = isVip ? '#C99A0E' : '#20B800';\n\n    if (mode === 'code-frenzy' || mode === 'vip-hyper-hack') {\n      // CODE FRENZY: 60fps typing & smoke puffs\n      const f1 = Math.floor(time * 28) % 3;\n      const f2 = Math.floor(time * 28 + 1) % 3;\n\n      const lx = 32 + f1 * 14;\n      const ly = 114 + (f1 === 0 ? 6 : 0);\n      const rx = 96 + f2 * 14;\n      const ry = 114 + (f2 === 0 ? 6 : 0);\n\n      // Motion ghosting trails\n      this.drawRect(lx - 2, ly - 2, 16, 10, 'rgba(51, 255, 0, 0.35)');\n      this.drawRect(rx - 2, ry - 2, 16, 10, 'rgba(51, 255, 0, 0.35)');\n\n      // Hands\n      this.drawRect(lx, ly, 14, 8, gloveColor);\n      this.drawRect(rx, ry, 14, 8, gloveColor);\n\n      // Spawn smoke puffs from keys\n      if (Math.random() < 0.35) {\n        this.smokePuffs.push({\n          x: (Math.random() < 0.5 ? lx : rx) + 4,\n          y: 122,\n          vy: -35 - Math.random() * 25,\n          vx: (Math.random() - 0.5) * 12,\n          size: 3,\n          alpha: 1.0,\n          color: Math.random() < 0.5 ? '#8899A6' : '#78E678',\n        });\n      }\n\n      for (let s = this.smokePuffs.length - 1; s >= 0; s--) {\n        const p = this.smokePuffs[s];\n        p.x += p.vx * dt;\n        p.y += p.vy * dt;\n        p.size += 6 * dt;\n        p.alpha -= 1.8 * dt;\n\n        if (p.alpha <= 0) {\n          this.smokePuffs.splice(s, 1);\n          continue;\n        }\n\n        this.ctx.fillStyle = p.color;\n        this.ctx.globalAlpha = Math.max(0, p.alpha);\n        this.ctx.fillRect(Math.floor(p.x), Math.floor(p.y), Math.floor(p.size), Math.floor(p.size));\n        this.ctx.globalAlpha = 1.0;\n      }\n    } else if (mode === 'zero-errors' || mode === 'celebration') {\n      // ZERO ERRORS: double fist pump \\o/\n      const fistY = 48 + jumpY + Math.sin(time * 12) * 4;\n      this.drawRect(22, 68 + jumpY, 14, 28, gloveShadow);\n      this.drawRect(18, fistY, 16, 16, gloveColor);\n      this.drawPixel(22, fistY + 4, '#FFFFFF', 4);\n\n      this.drawRect(124, 68 + jumpY, 14, 28, gloveShadow);\n      this.drawRect(126, fistY, 16, 16, gloveColor);\n      this.drawPixel(130, fistY + 4, '#FFFFFF', 4);\n    } else if (mode === 'empty-mug') {\n      // EMPTY MUG: 180° cup invert & tear drop\n      const cycleTime = this.stateTimer % 4.8;\n\n      if (cycleTime < 1.2) {\n        // Holding mug on desk\n        this.drawRect(118, 110, 16, 16, '#DCE5ED');\n        this.drawRect(134, 114, 4, 8, '#8899A6');\n        this.drawRect(110, 116, 12, 8, gloveColor);\n      } else if (cycleTime < 3.2) {\n        // Mug turned completely upside down over face\n        this.drawRect(102, 60, 18, 18, '#DCE5ED');\n        this.drawRect(102, 74, 18, 4, '#33FF00'); // robe arm\n        this.drawRect(98, 64, 4, 10, '#8899A6'); // handle\n\n        const tearProgress = (cycleTime - 1.2) / 2.0;\n        const dropY = 78 + tearProgress * 44;\n        if (dropY < 122) {\n          this.drawRect(110, dropY, 4, 6, '#00F0FF');\n          this.drawPixel(111, dropY + 1, '#FFFFFF', 2);\n        } else {\n          this.drawRect(106, 122, 12, 2, '#00F0FF');\n        }\n      } else {\n        // Despair slump\n        this.drawRect(118, 120, 16, 10, '#DCE5ED');\n        this.drawRect(100, 122, 14, 8, gloveColor);\n      }\n    } else if (mode === 'bug-slayer') {\n      // BUG SLAYER: neon katana slash & split bug\n      const cycleTime = this.stateTimer % 3.6;\n\n      if (cycleTime < 1.2) {\n        // Bug crawling on desk\n        const bx = 120 + Math.sin(time * 12) * 6;\n        const by = 90;\n        this.drawRect(bx, by, 14, 12, '#FF2E63');\n        this.drawPixel(bx + 2, by - 4, '#FF2E63', 3);\n        this.drawPixel(bx + 8, by - 4, '#FF2E63', 3);\n        this.drawPixel(bx - 2, by + 3, '#0B1A0B', 2);\n        this.drawPixel(bx + 14, by + 3, '#0B1A0B', 2);\n        this.drawPixel(bx - 2, by + 9, '#0B1A0B', 2);\n        this.drawPixel(bx + 14, by + 9, '#0B1A0B', 2);\n\n        // Katana sheathed / ready\n        this.drawRect(36, 104, 20, 4, '#00F0FF');\n      } else if (cycleTime < 1.8) {\n        // SWOOSH slash arc!\n        this.ctx.strokeStyle = '#00F0FF';\n        this.ctx.lineWidth = 4;\n        this.ctx.beginPath();\n        this.ctx.arc(80, 80, 50, -0.4, 0.9);\n        this.ctx.stroke();\n\n        this.ctx.strokeStyle = '#FFFFFF';\n        this.ctx.lineWidth = 2;\n        this.ctx.beginPath();\n        this.ctx.arc(80, 80, 50, -0.2, 0.7);\n        this.ctx.stroke();\n\n        this.drawRect(110, 54, 34, 4, '#00F0FF');\n        this.drawRect(102, 54, 8, 6, gloveColor);\n\n        // Spawn katana explosion sparks once per slash\n        if (this.katanaSparks.length === 0) {\n          for (let sp = 0; sp < 16; sp++) {\n            const angle = Math.random() * Math.PI * 2;\n            const speed = 35 + Math.random() * 55;\n            this.katanaSparks.push({\n              x: 126,\n              y: 90,\n              vx: Math.cos(angle) * speed,\n              vy: Math.sin(angle) * speed - 15,\n              color: sp % 2 === 0 ? '#FF2E63' : '#00F0FF',\n              size: 2 + Math.floor(Math.random() * 3),\n              alpha: 1.0,\n            });\n          }\n        }\n      } else {\n        // Sliced bug halves flying apart\n        const t2 = cycleTime - 1.8;\n        const topX = 126 + t2 * 18;\n        const topY = 90 - t2 * 22;\n        const botX = 126 - t2 * 8;\n        const botY = 90 + t2 * 14;\n\n        if (topY > 20) this.drawRect(topX, topY, 14, 6, '#FF2E63');\n        if (botY < 124) this.drawRect(botX, botY, 14, 6, '#FF2E63');\n\n        for (let sp = this.katanaSparks.length - 1; sp >= 0; sp--) {\n          const p = this.katanaSparks[sp];\n          p.x += p.vx * dt;\n          p.y += p.vy * dt;\n          p.vy += 120 * dt; // gravity\n          p.alpha -= 1.4 * dt;\n\n          if (p.alpha <= 0 || p.y > 124) {\n            this.katanaSparks.splice(sp, 1);\n            continue;\n          }\n\n          this.ctx.fillStyle = p.color;\n          this.ctx.globalAlpha = Math.max(0, p.alpha);\n          this.ctx.fillRect(Math.floor(p.x), Math.floor(p.y), p.size, p.size);\n          this.ctx.globalAlpha = 1.0;\n        }\n      }\n    } else if (mode === 'coin-drop') {\n      // COIN DROP: gravity bounce & tip jar\n      const cycleTime = this.stateTimer % 3.6;\n\n      // Glass tip jar on right desk edge\n      this.drawRect(122, 98, 26, 24, 'rgba(0, 240, 255, 0.15)');\n      this.drawRect(122, 98, 26, 2, '#00F0FF');\n      this.drawRect(122, 120, 26, 2, '#00F0FF');\n      this.drawRect(122, 98, 2, 24, '#00F0FF');\n      this.drawRect(146, 98, 2, 24, '#00F0FF');\n      // Gold coins in jar bottom\n      this.drawRect(126, 114, 18, 6, '#FFD028');\n\n      if (cycleTime < 0.8) {\n        // Arm raised holding gold coin\n        this.drawRect(132, 70, 14, 10, gloveColor);\n        this.drawRect(134, 60, 10, 8, '#FFD028');\n        this.drawPixel(136, 62, '#FFFFFF', 3);\n      } else {\n        // Coin falling with gravity\n        const tDrop = cycleTime - 0.8;\n        let cy = 60 + 0.5 * 180 * tDrop * tDrop;\n        if (cy > 114) {\n          cy = 114 - Math.abs(Math.sin((cy - 114) * 0.5)) * 6; // bounce\n        }\n        this.drawRect(130, cy, 10, 6, '#FFD028');\n        this.drawPixel(132, cy + 1, '#FFFFFF', 2);\n      }\n    } else if (mode === 'flowchart') {\n      // FLOWCHART: neural nodes & data packets\n      this.ctx.strokeStyle = '#33FF00';\n      this.ctx.lineWidth = 2;\n      this.ctx.beginPath();\n      this.ctx.moveTo(112, 114);\n      this.ctx.lineTo(84, 40);\n      this.ctx.stroke();\n\n      const nCol = '#00F0FF';\n      this.drawRect(20, 32, 24, 16, 'rgba(0, 240, 255, 0.2)');\n      this.drawRect(20, 32, 24, 2, nCol);\n      this.drawPixelText('IN', 26, 44, nCol, 8);\n\n      this.drawRect(70, 22, 28, 16, 'rgba(0, 240, 255, 0.35)');\n      this.drawRect(70, 22, 28, 2, nCol);\n      this.drawPixelText('70B', 74, 34, '#FFFFFF', 8);\n\n      this.drawRect(124, 32, 26, 16, 'rgba(0, 240, 255, 0.2)');\n      this.drawRect(124, 32, 26, 2, nCol);\n      this.drawPixelText('OUT', 128, 44, nCol, 8);\n\n      this.ctx.strokeStyle = '#33FF00';\n      this.ctx.lineWidth = 1.5;\n      this.ctx.beginPath();\n      this.ctx.moveTo(44, 40);\n      this.ctx.lineTo(70, 30);\n      this.ctx.lineTo(98, 30);\n      this.ctx.lineTo(124, 40);\n      this.ctx.stroke();\n\n      // Moving data packets along the circuit path\n      const packetPos = (time * 1.5) % 2.0;\n      let px: number;\n      let py: number;\n      if (packetPos < 1.0) {\n        px = 44 + packetPos * 26;\n        py = 40 - packetPos * 10;\n      } else {\n        const p2 = packetPos - 1.0;\n        px = 98 + p2 * 26;\n        py = 30 + p2 * 10;\n      }\n      this.drawRect(px - 2, py - 2, 5, 5, '#FFFFFF');\n    } else if (mode === 'terminal-nap') {\n      // TERMINAL NAP: snore ZZZ glyphs\n      if (Math.random() < 0.04 && this.snores.length < 5) {\n        this.snores.push({\n          x: 94,\n          y: 70,\n          vx: 12 + Math.random() * 8,\n          vy: -20 - Math.random() * 10,\n          size: 8,\n          alpha: 1.0,\n        });\n      }\n\n      for (let z = this.snores.length - 1; z >= 0; z--) {\n        const sn = this.snores[z];\n        sn.x += Math.sin(time * 4) * 0.6;\n        sn.y += sn.vy * dt;\n        sn.alpha -= 0.6 * dt;\n\n        if (sn.alpha <= 0) {\n          this.snores.splice(z, 1);\n          continue;\n        }\n\n        this.ctx.fillStyle = `rgba(51, 255, 0, ${sn.alpha})`;\n        this.ctx.font = \"bold 9px 'JetBrains Mono', monospace\";\n        this.ctx.fillText('Z', Math.floor(sn.x), Math.floor(sn.y));\n      }\n    } else if (mode === 'intent') {\n      // INTENT: waving cyber arm o/\n      const waveAngle = Math.sin(time * 14) * 8;\n      this.drawRect(120, 72, 14, 26, gloveShadow);\n      this.drawRect(126 + waveAngle, 50, 16, 16, gloveColor);\n      this.drawPixel(130 + waveAngle, 54, '#FFFFFF', 4);\n    } else if (mode === 'vip-syndicate-salute') {\n      // VIP 1: syndicate salute\n      this.drawRect(114, 60, 14, 28, gloveShadow);\n      this.drawRect(98, 44, 18, 12, '#FFD028');\n      this.drawPixel(102, 46, '#FFFFFF', 4);\n    } else if (mode === 'vip-espresso-toast') {\n      // VIP 2: toast to architect\n      this.drawRect(114, 70, 16, 24, gloveShadow);\n      this.drawRect(118, 52, 18, 18, '#FFD028');\n      this.drawRect(134, 56, 4, 10, '#FFE57F');\n\n      // Golden steam spirals\n      if (Math.random() < 0.2) {\n        this.steamParticles.push({\n          x: 124 + Math.random() * 8,\n          y: 48,\n          vy: -22 - Math.random() * 15,\n          alpha: 1.0,\n        });\n      }\n      for (let s = this.steamParticles.length - 1; s >= 0; s--) {\n        const st = this.steamParticles[s];\n        st.y += st.vy * dt;\n        st.x += Math.sin(st.y * 0.1) * 0.8;\n        st.alpha -= 1.2 * dt;\n        if (st.alpha <= 0) {\n          this.steamParticles.splice(s, 1);\n          continue;\n        }\n        this.drawRect(st.x, st.y, 3, 3, `rgba(255, 208, 40, ${st.alpha})`);\n      }\n    } else if (mode === 'vip-fourth-wall-wink') {\n      // VIP 3: 4th-wall wink & lens flare\n      this.drawRect(104, 54, 14, 14, '#FFD028'); // hand adjusting shades\n      const flarePulse = Math.abs(Math.sin(time * 3));\n      if (flarePulse > 0.6) {\n        const fx = 70;\n        const fy = 50;\n        this.drawRect(fx - 6, fy, 13, 2, '#FFFFFF');\n        this.drawRect(fx, fy - 6, 2, 13, '#FFFFFF');\n        this.drawPixel(fx, fy, '#FFF9C4', 3);\n      }\n    } else if (mode === 'vip-quantum-meditation') {\n      // VIP 5: zero-g hover (body lift handled via jumpY; add orbiting spark)\n      const orbAngle = time * 2.2;\n      const ox = 80 + Math.cos(orbAngle) * 46;\n      const oy = 74 + Math.sin(orbAngle) * 12;\n      this.drawRect(ox, oy, 4, 4, '#FFD028');\n      this.drawPixel(ox + 1, oy + 1, '#FFF9C4', 2);\n    } else if (mode === 'disk-toss') {\n      // EASTER EGG: 100TB data disk toss\n      this.disk.rot += 12 * dt;\n      const arcTime = this.stateTimer % 3.0;\n      const dy = 90 - Math.sin((arcTime * Math.PI) / 3.0) * 60;\n      const dw = Math.abs(Math.cos(this.disk.rot)) * 16 + 4;\n\n      this.drawRect(80 - dw / 2, dy, dw, 16, '#FFD028');\n      this.drawRect(80 - dw / 4, dy + 2, dw / 2, 12, '#FFFFFF');\n    } else {\n      // DEFAULT IDLE: rhythmic alternating typing\n      const typingLeft = Math.sin(time * 8) > 0;\n      const ly = typingLeft ? 122 : 116;\n      const ry = typingLeft ? 116 : 122;\n\n      this.drawRect(38, 100, 10, 16, gloveShadow);\n      this.drawRect(36, ly, 14, 8, gloveColor);\n\n      this.drawRect(112, 100, 10, 16, gloveShadow);\n      this.drawRect(110, ry, 14, 8, gloveColor);\n    }\n  }\n\n  private renderForegroundParticles(dt: number, mode: string, isVip: boolean): void {\n    if (mode === 'zero-errors' || mode === 'celebration') {\n      for (let i = 0; i < this.confetti.length; i++) {\n        const p = this.confetti[i];\n        p.y += p.vy * dt;\n        p.x += (p.vx + Math.sin(p.y * 0.08) * 12) * dt;\n        p.rot += p.rotSpeed * dt;\n\n        if (p.y > this.height) {\n          p.y = -10;\n          p.x = Math.random() * this.width;\n        }\n\n        this.ctx.save();\n        this.ctx.translate(Math.floor(p.x), Math.floor(p.y));\n        this.ctx.rotate(p.rot);\n        this.ctx.fillStyle = p.color;\n        this.ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);\n        this.ctx.restore();\n      }\n    }\n\n    if (isVip && Math.random() < 0.15 && this.vipEmbers.length < 12) {\n      this.vipEmbers.push({\n        x: Math.random() * this.width,\n        y: this.height - 10,\n        vy: -20 - Math.random() * 20,\n        size: 2,\n        alpha: 1.0,\n      });\n    }\n\n    for (let e = this.vipEmbers.length - 1; e >= 0; e--) {\n      const em = this.vipEmbers[e];\n      em.y += em.vy * dt;\n      em.alpha -= 0.8 * dt;\n      if (em.alpha <= 0 || em.y < 0) {\n        this.vipEmbers.splice(e, 1);\n        continue;\n      }\n      this.drawRect(em.x, em.y, em.size, em.size, `rgba(255, 208, 40, ${em.alpha})`);\n    }\n  }\n}\n