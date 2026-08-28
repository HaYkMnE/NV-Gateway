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

export const VIP_STORAGE_KEY = 'nv_pet_vip';
export const VIP_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;
const SOUND_STORAGE_KEY = 'nv_pet_sound';

export function readVipFlag(): boolean {
  try {
    const raw = window.localStorage.getItem(VIP_STORAGE_KEY);
    if (raw === null) return false;
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
    if (elapsed >= 0 && elapsed < VIP_EXPIRATION_MS) return true;
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
  } catch {}
}

interface ThoughtVariant {
  emoji: string;
  text: string;
}

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

const VIP_ACTIVITY_IDS: ReadonlySet<string> = new Set<VipActivity>([
  'syndicate-salute',
  'espresso-toast',
  'fourth-wall-wink',
  'hyper-hack',
  'quantum-meditation',
]);

function hackerModeOf(activity: AnyActivity): string {
  return VIP_ACTIVITY_IDS.has(activity) ? `vip-${activity}` : activity;
}

export interface PetWidgetProps {
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

  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const syncVipFromStorage = useCallback((): void => {
    const vip = readVipFlag();
    vipRef.current = vip;
    setIsVip(vip);
  }, []);

  const handleActivityChange = useCallback(
    (next: AnyActivity): void => {
      setActivity(next);
      syncVipFromStorage();
      try {
        ACTIVITY_SFX[next]?.();
      } catch {}
      setThought(pickThought(next, tRef.current));
      if (thoughtTimerRef.current !== null) window.clearTimeout(thoughtTimerRef.current);
      thoughtTimerRef.current = window.setTimeout(() => {
        setThought(null);
        thoughtTimerRef.current = null;
      }, 2600);
    },
    [syncVipFromStorage],
  );

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

  useEffect(() => {
    const engine = createPetEngine({
      isVip: () => vipRef.current,
      onActivityChange: handleActivityChange,
      onCue: handleCue,
    });
    engineRef.current = engine;

    petAudio.setEnabled(soundRef.current);
    const unlockAudio = (): void => {
      petAudio.unlock();
    };
    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    window.addEventListener('keydown', unlockAudio, { passive: true });

    setCharacter(engine.pickSessionCharacter());
    engine.nextRandomActivity();

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

  useEffect(() => {
    if (character !== 'hacker') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = PixelHackerRenderer.create(canvas);
    if (!renderer) return;
    hackerRendererRef.current = renderer;
    renderer.start();
    return () => {
      renderer.destroy();
      hackerRendererRef.current = null;
    };
  }, [character]);

  useEffect(() => {
    if (character !== 'hacker') return;
    hackerRendererRef.current?.setMode(hackerModeOf(activity));
  }, [character, activity]);

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
        <div className={`caught-in-act-cue${cueShown ? ' show' : ''}`} aria-live="polite">
          <span className="cue-sparkle">✦</span>
          <span className="cue-text">{t('pet_caught_cue')}</span>
          <span className="cue-sparkle">✦</span>
        </div>

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

              <g className="m-root-rig">
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

                <g className="m-torso-chassis">
                  <rect x="36" y="68" width="58" height="32" rx="14" fill="url(#chassisGrad)" stroke="#324458" strokeWidth="1.5" />
                  <line x1="42" y1="78" x2="88" y2="78" stroke="#162029" strokeWidth="1.2" />
                  <circle cx="42" cy="74" r="1.2" fill="#3B4E60" />
                  <circle cx="88" cy="74" r="1.2" fill="#3B4E60" />
                  <circle cx="42" cy="92" r="1.2" fill="#3B4E60" />
                  <circle cx="88" cy="92" r="1.2" fill="#3B4E60" />

                  <circle cx="65" cy="84" r="9" fill="#070D12" stroke="#00F0FF" strokeWidth="1.4" />
                  <circle cx="65" cy="84" r="6" fill="#0E1C26" />
                  <g className="m-rotor-spin">
                    <line x1="65" y1="78" x2="65" y2="90" stroke="#33FF00" strokeWidth="1.4" strokeLinecap="round" />
                    <line x1="59" y1="84" x2="71" y2="84" stroke="#33FF00" strokeWidth="1.4" strokeLinecap="round" />
                    <line x1="61" y1="80" x2="69" y2="88" stroke="#00F0FF" strokeWidth="1.2" strokeLinecap="round" />
                    <line x1="61" y1="88" x2="69" y2="80" stroke="#00F0FF" strokeWidth="1.2" strokeLinecap="round" />
                  </g>
                  <circle cx="65" cy="84" r="2.2" fill="#FFFFFF" />

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

                <g className="m-neck-bellow">
                  <rect x="55" y="58" width="20" height="4" rx="2" fill="#243240" stroke="#3B4D5E" strokeWidth="1" />
                  <rect x="57" y="61" width="16" height="3" rx="1.5" fill="#151E26" />
                  <rect x="55" y="63" width="20" height="4" rx="2" fill="#243240" stroke="#3B4D5E" strokeWidth="1" />
                </g>

                <g className="m-head-rig">
                  <rect x="25" y="18" width="80" height="46" rx="18" fill="url(#headGrad)" stroke="#33FF00" strokeWidth="1.8" />
                  <rect x="18" y="32" width="8" height="18" rx="4" fill="#1A242E" stroke="#2E4050" strokeWidth="1.4" />
                  <rect x="104" y="32" width="8" height="18" rx="4" fill="#1A242E" stroke="#2E4050" strokeWidth="1.4" />
                  <line x1="22" y1="36" x2="22" y2="46" stroke="#33FF00" strokeWidth="1.2" />
                  <line x1="108" y1="36" x2="108" y2="46" stroke="#33FF00" strokeWidth="1.2" />

                  <line x1="65" y1="18" x2="65" y2="7" stroke="#33FF00" strokeWidth="2" strokeLinecap="round" />
                  <circle className="m-antenna-orb" cx="65" cy="6" r="4.5" fill="#33FF00" />
                  <circle cx="65" cy="6" r="2" fill="#FFFFFF" />

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
                    <line x1="56" y1="52" x2="74" y2="52" stroke="#00F0FF" strokeWidth="1.8" strokeLinecap="round" />
                  </g>

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

                <g className="m-vip-hack-scene">
                  <g className="m-holo-kb-ring">
                    <path d="M24 88 Q65 104 106 88" fill="none" stroke="#FFD028" strokeWidth="4" strokeLinecap="round" opacity="0.85" />
                    <path d="M26 87 Q65 102 104 87" fill="none" stroke="#FFFFFF" strokeWidth="1" strokeDasharray="4 2" />
                  </g>
                  <text className="m-hex-stream-1" x="28" y="78" fontFamily="'JetBrains Mono', monospace" fontSize="6.5" fontWeight="bold" fill="#FFD028">0xVIP</text>
                  <text className="m-hex-stream-2" x="52" y="74" fontFamily="'JetBrains Mono', monospace" fontSize="6.5" fontWeight="bold" fill="#FFE57F">0xARCH</text>
                  <text className="m-hex-stream-3" x="82" y="76" fontFamily="'JetBrains Mono', monospace" fontSize="6.5" fontWeight="bold" fill="#FFB000">100TB</text>
                </g>

                <g className="m-arm-left-rig">
                  <circle cx="26" cy="72" r="4.5" fill="#1C2731" stroke="#33FF00" strokeWidth="1.2" />
                  <line x1="26" y1="72" x2="18" y2="84" stroke="#2C3D4D" strokeWidth="3" strokeLinecap="round" />
                  <circle cx="18" cy="84" r="3.5" fill="#141E26" stroke="#00F0FF" strokeWidth="1" />
                  <line x1="18" y1="84" x2="16" y2="94" stroke="#3A4F63" strokeWidth="2.5" strokeLinecap="round" />
                  <g className="m-claw-l">
                    <path d="M13 94 L11 100 M16 95 L16 102 M19 94 L21 100" stroke="#33FF00" strokeWidth="1.5" strokeLinecap="round" />
                  </g>
                </g>

                <g className="m-arm-right-rig">
                  <circle cx="104" cy="72" r="4.5" fill="#1C2731" stroke="#33FF00" strokeWidth="1.2" />
                  <line x1="104" y1="72" x2="112" y2="84" stroke="#2C3D4D" strokeWidth="3" strokeLinecap="round" />
                  <circle cx="112" cy="84" r="3.5" fill="#141E26" stroke="#00F0FF" strokeWidth="1" />
                  <line x1="112" y1="84" x2="114" y2="94" stroke="#3A4F63" strokeWidth="2.5" strokeLinecap="round" />
                  <g className="m-claw-r">
                    <path d="M111 94 L109 100 M114 95 L114 102 M117 94 L119 100" stroke="#33FF00" strokeWidth="1.5" strokeLinecap="round" />

                    <g className="m-cannon-prop">
                      <rect x="108" y="93" width="14" height="7" rx="2" fill="#1E2B38" stroke="#00F0FF" strokeWidth="1.2" />
                      <rect x="120" y="94" width="4" height="5" rx="1" fill="#33FF00" />
                      <line className="m-laser-strike" x1="124" y1="96" x2="108" y2="28" />
                    </g>

                    <g className="m-polish-cloth">
                      <rect x="109" y="94" width="10" height="10" rx="3" fill="#00F0FF" stroke="#FFFFFF" strokeWidth="1" opacity="0.9" />
                    </g>

                    <g className="m-coffee-cup">
                      <rect x="108" y="93" width="12" height="14" rx="3" fill="#243340" stroke="#33FF00" strokeWidth="1.2" />
                      <path d="M120 96 Q124 100 120 104" fill="none" stroke="#33FF00" strokeWidth="1.2" />
                      <g className="m-coffee-steam">
                        <path d="M110 90 Q114 86 118 90 M111 85 Q114 81 117 85" fill="none" stroke="#00F0FF" strokeWidth="1" strokeLinecap="round" />
                      </g>
                    </g>

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

                <g className="m-low-batt-hud">
                  <rect x="52" y="32" width="26" height="15" rx="3" fill="#0A0406" stroke="#FF2E63" strokeWidth="1.5" />
                  <rect x="78" y="36" width="2" height="7" rx="1" fill="#FF2E63" />
                  <rect x="55" y="35" width="6" height="9" rx="1" fill="#FF2E63" />
                  <text x="65" y="44" fontFamily="'JetBrains Mono', monospace" fontSize="8" fontWeight="bold" fill="#FF2E63" textAnchor="middle">!</text>
                </g>

                <g className="m-turbine-fx">
                  <path className="m-plasma-arc" d="M30 76 Q45 84 60 84 M100 76 Q85 84 70 84" fill="none" stroke="#00F0FF" strokeWidth="2" />
                  <circle cx="65" cy="84" r="13" fill="none" stroke="#33FF00" strokeWidth="1" strokeDasharray="3 2" />
                </g>

                <g className="m-polish-fx">
                  <polygon className="m-polish-glint" points="48,34 51,40 57,43 51,46 48,52 45,46 39,43 45,40" fill="#FFFFFF" />
                </g>

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

                <g className="m-coffee-fx" />

                <g className="m-nap-fx">
                  <path d="M42 42 Q48 46 54 42" fill="none" stroke="#33FF00" strokeWidth="2.5" strokeLinecap="round" />
                  <path d="M76 42 Q82 46 88 42" fill="none" stroke="#33FF00" strokeWidth="2.5" strokeLinecap="round" />
                  <text className="nap-zzz-1" x="0" y="0" fontFamily="'JetBrains Mono', monospace" fontSize="10" fontWeight="bold" fill="#33FF00">Z</text>
                  <text className="nap-zzz-2" x="0" y="0" fontFamily="'JetBrains Mono', monospace" fontSize="8" fontWeight="bold" fill="#00F0FF">z</text>
                  <text className="nap-zzz-3" x="0" y="0" fontFamily="'JetBrains Mono', monospace" fontSize="7" fill="#33FF00">z</text>
                </g>

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

    this.ctx.clearRect(0, 0, this.width, this.height);

    if (mode === 'zero-errors' || mode === 'celebration') {
      const glowAlpha = 0.18 + Math.sin(this.stateTimer * 6) * 0.08;
      this.ctx.fillStyle = `rgba(0, 255, 102, ${glowAlpha})`;
      this.ctx.fillRect(0, 0, this.width, this.height);
    } else if (isVip) {
      this.ctx.fillStyle = 'rgba(255, 208, 40, 0.05)';
      this.ctx.fillRect(0, 0, this.width, this.height);
    }

    this.renderMatrixRain(dt, isVip);
    this.renderChair(time, isVip, mode);

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
      headBobY = 32;
    } else if (mode === 'empty-mug' && (this.stateTimer % 4.8) > 1.2 && (this.stateTimer % 4.8) < 3.2) {
      headBobY = -3;
    }

    this.renderHackerTorso(jumpY, isVip);
    this.renderHackerHead(jumpY, headBobY, isVip, mode, time);
    this.renderDeskAndKeyboard(time, isVip, mode);
    this.renderActionLayer(jumpY, isVip, mode, time, dt);
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

      const charCount = 4;
      for (let j = 0; j < charCount; j++) {
        const charY = col.y - j * 10;
        if (charY >= 0 && charY <= this.height) {
          const char = col.chars[(j + Math.floor(col.y / 10)) % col.chars.length];
          const alpha = (1 - j / charCount) * 0.35;
          const color = isVip
            ? j === 0
              ? '#FFF59D'
              : `rgba(255, 208, 40, ${alpha})`
            : j === 0
              ? '#C8FFC8'
              : `rgba(51, 255, 0, ${alpha})`;
          this.drawPixelText(char, col.x, charY, color, 8);
        }
      }
    }
  }

  private renderChair(_time: number, isVip: boolean, _mode: string): void {
    const chairBack = isVip ? '#2E2204' : '#141A22';
    const chairHead = isVip ? '#3E300A' : '#1E2632';
    const chairMesh = isVip ? '#D4AF37' : '#00FFD1';

    this.drawRect(58, 44, 44, 38, chairBack);
    this.drawRect(64, 34, 32, 12, chairHead);
    this.drawRect(56, 48, 4, 30, chairHead);
    this.drawRect(100, 48, 4, 30, chairHead);

    for (let y = 48; y < 80; y += 4) {
      this.drawRect(62, y, 36, 1, `rgba(${isVip ? '255, 208, 40' : '0, 240, 255'}, 0.25)`);
    }
    this.drawRect(60, 44, 40, 2, chairMesh);
    this.drawRect(64, 34, 32, 2, chairMesh);
  }

  private renderHackerTorso(jumpY: number, isVip: boolean): void {
    const baseY = 72 + jumpY;
    const hoodieDark = isVip ? '#241A04' : '#0D1117';
    const hoodieFold = isVip ? '#3A2C08' : '#161B22';
    const hoodieTrim = isVip ? '#FFD028' : '#33FF00';

    this.drawRect(62, baseY, 36, 32, hoodieDark);
    this.drawRect(64, baseY + 4, 32, 26, hoodieFold);
    this.drawRect(78, baseY + 6, 4, 26, isVip ? '#503C0A' : '#21262D');
    this.drawRect(70, baseY + 2, 20, 2, hoodieTrim);

    this.drawRect(52, baseY + 4, 12, 26, hoodieDark);
    this.drawRect(96, baseY + 4, 12, 26, hoodieDark);
    this.drawRect(50, baseY + 18, 4, 14, hoodieFold);
    this.drawRect(106, baseY + 18, 4, 14, hoodieFold);
  }

  private renderHackerHead(
    jumpY: number,
    headBobY: number,
    isVip: boolean,
    mode: string,
    time: number,
  ): void {
    const baseY = 40 + jumpY + headBobY;
    const hoodColor = isVip ? '#2E2204' : '#12171F';
    const faceShadow = isVip ? '#0A0600' : '#020408';

    this.drawRect(60, baseY, 40, 34, hoodColor);
    this.drawRect(58, baseY + 4, 44, 26, hoodColor);
    this.drawRect(64, baseY - 4, 32, 6, hoodColor);

    const hoodTrim = isVip ? '#FFD028' : '#00F0FF';
    this.drawRect(64, baseY - 4, 32, 2, hoodTrim);
    this.drawRect(58, baseY + 4, 2, 26, hoodTrim);
    this.drawRect(100, baseY + 4, 2, 26, hoodTrim);

    this.drawRect(66, baseY + 6, 28, 22, faceShadow);
    this.drawRect(68, baseY + 8, 24, 18, '#000000');

    if (mode === 'terminal-nap') {
      const zColor = isVip ? '#FFD028' : '#33FF00';
      this.drawRect(70, baseY + 14, 8, 2, zColor);
      this.drawRect(82, baseY + 14, 8, 2, zColor);
      return;
    }

    if (isVip) {
      this.drawRect(66, baseY + 8, 28, 8, '#FFD028');
      this.drawRect(68, baseY + 10, 10, 5, '#1F1703');
      this.drawRect(82, baseY + 10, 10, 5, '#1F1703');
      const glintX = 68 + ((Math.sin(time * 3) + 1) * 10);
      this.drawRect(glintX, baseY + 9, 3, 6, '#FFFFFF');
      this.drawRect(64, baseY + 11, 4, 2, '#D4AF37');
      this.drawRect(92, baseY + 11, 4, 2, '#D4AF37');
      return;
    }

    const eyeGlow = '#33FF00';
    const pupilWhite = '#FFFFFF';
    const blink = Math.sin(time * 0.8) > 0.96;

    if (blink) {
      this.drawRect(70, baseY + 15, 7, 2, eyeGlow);
      this.drawRect(83, baseY + 15, 7, 2, eyeGlow);
    } else {
      this.drawRect(70, baseY + 13, 7, 5, eyeGlow);
      this.drawRect(83, baseY + 13, 7, 5, eyeGlow);
      const lookOffset = Math.floor(Math.sin(time * 1.6) * 2);
      this.drawRect(72 + lookOffset, baseY + 14, 3, 3, pupilWhite);
      this.drawRect(85 + lookOffset, baseY + 14, 3, 3, pupilWhite);
    }
  }

  private renderDeskAndKeyboard(time: number, isVip: boolean, mode: string): void {
    const deskTop = isVip ? '#3E300A' : '#1B242E';
    const deskLip = isVip ? '#241A04' : '#0F151C';
    const deskTrim = isVip ? '#D4AF37' : '#00F0FF';

    this.drawRect(24, 106, 112, 10, deskTop);
    this.drawRect(20, 116, 120, 36, deskLip);
    this.drawRect(24, 106, 112, 2, deskTrim);

    const kbBase = isVip ? '#1A1202' : '#0A0E13';
    const keyColor = isVip ? '#FFD028' : '#33FF00';
    this.drawRect(46, 100, 68, 12, kbBase);
    this.drawRect(46, 100, 68, 1, isVip ? '#8C6B14' : '#2A3A4C');

    const frenzy = mode === 'code-frenzy' || mode === 'vip-hyper-hack';
    for (let r = 0; r < 2; r++) {
      for (let k = 0; k < 9; k++) {
        const kx = 49 + k * 7;
        const ky = 102 + r * 5;
        const lit = frenzy && Math.sin(time * 30 + k * 1.5 + r * 3) > 0.15;
        this.drawRect(kx, ky, 5, 3, lit ? '#FFFFFF' : keyColor);
      }
    }
  }

  private renderActionLayer(
    jumpY: number,
    isVip: boolean,
    mode: string,
    time: number,
    dt: number,
  ): void {
    const handColor = isVip ? '#FFE57F' : '#33FF00';

    if (mode === 'code-frenzy' || mode === 'vip-hyper-hack') {
      const hL = Math.sin(time * 32) * 5;
      const hR = Math.cos(time * 32) * 5;
      this.drawRect(52, 94 + jumpY + hL, 10, 8, isVip ? '#241A04' : '#0D1117');
      this.drawRect(54, 98 + jumpY + hL, 6, 6, handColor);
      this.drawRect(98, 94 + jumpY + hR, 10, 8, isVip ? '#241A04' : '#0D1117');
      this.drawRect(100, 98 + jumpY + hR, 6, 6, handColor);

      if (Math.random() < 0.35) {
        this.smokePuffs.push({
          x: 48 + Math.random() * 64,
          y: 102,
          vy: -20 - Math.random() * 20,
          vx: (Math.random() - 0.5) * 10,
          size: 2,
          alpha: 0.9,
          color: isVip ? '#FFE57F' : '#00F0FF',
        });
      }
    } else if (mode === 'empty-mug') {
      this.drawRect(52, 98 + jumpY, 8, 6, handColor);
      this.drawRect(96, 92 + jumpY, 8, 6, handColor);
      this.drawRect(100, 84 + jumpY, 8, 12, '#3E4C5A');
      this.drawRect(102, 86 + jumpY, 4, 2, '#1E242C');
      this.drawRect(108, 88 + jumpY, 2, 6, '#3E4C5A');
    } else if (mode === 'bug-slayer') {
      const slash = (this.stateTimer * 4) % 2;
      this.drawRect(52, 98 + jumpY, 8, 6, handColor);
      this.drawRect(96, 90 + jumpY, 8, 6, handColor);

      const kx = 104;
      const ky = 72 + jumpY;
      this.drawRect(kx, ky, 3, 24, '#ECEFF2');
      this.drawRect(kx - 1, ky + 18, 5, 2, '#33FF00');
      this.drawRect(kx, ky + 20, 3, 6, '#1A242E');

      if (slash > 1.2) {
        this.drawRect(24, 60, 112, 2, '#00F0FF');
        for (let i = 0; i < 4; i++) {
          this.katanaSparks.push({
            x: 40 + Math.random() * 80,
            y: 60,
            vx: (Math.random() - 0.5) * 60,
            vy: -10 - Math.random() * 30,
            color: Math.random() > 0.5 ? '#33FF00' : '#00F0FF',
            size: 2,
            alpha: 1,
          });
        }
      }
    } else {
      this.drawRect(52, 98 + jumpY, 8, 6, handColor);
      this.drawRect(100, 98 + jumpY, 8, 6, handColor);
    }

    if (isVip && Math.random() < 0.25) {
      this.vipEmbers.push({
        x: 60 + Math.random() * 40,
        y: 60 + Math.random() * 40,
        vy: -12 - Math.random() * 18,
        size: 2,
        alpha: 0.9,
      });
    }

    for (let i = this.vipEmbers.length - 1; i >= 0; i--) {
      const e = this.vipEmbers[i];
      e.y += e.vy * dt;
      e.alpha -= dt * 0.6;
      if (e.alpha <= 0) {
        this.vipEmbers.splice(i, 1);
      } else {
        this.ctx.fillStyle = `rgba(255, 208, 40, ${e.alpha})`;
        this.ctx.fillRect(Math.floor(e.x), Math.floor(e.y), e.size, e.size);
      }
    }
  }

  private renderForegroundParticles(dt: number, mode: string, _isVip: boolean): void {
    if (mode === 'zero-errors' || mode === 'celebration') {
      for (let i = 0; i < this.confetti.length; i++) {
        const c = this.confetti[i];
        c.y += c.vy * dt;
        c.x += c.vx * dt;
        c.rot += c.rotSpeed * dt;
        if (c.y > this.height) {
          c.y = -8;
          c.x = Math.random() * this.width;
        }

        this.ctx.save();
        this.ctx.translate(c.x, c.y);
        this.ctx.rotate(c.rot);
        this.ctx.fillStyle = c.color;
        this.ctx.fillRect(-c.size / 2, -c.size / 2, c.size, c.size * 1.5);
        this.ctx.restore();
      }
    }

    for (let i = this.smokePuffs.length - 1; i >= 0; i--) {
      const p = this.smokePuffs[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.alpha -= dt * 1.4;
      if (p.alpha <= 0) {
        this.smokePuffs.splice(i, 1);
      } else {
        this.ctx.fillStyle = p.color;
        this.ctx.globalAlpha = p.alpha;
        this.ctx.fillRect(Math.floor(p.x), Math.floor(p.y), p.size, p.size);
        this.ctx.globalAlpha = 1;
      }
    }

    for (let i = this.katanaSparks.length - 1; i >= 0; i--) {
      const s = this.katanaSparks[i];
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.alpha -= dt * 2.2;
      if (s.alpha <= 0) {
        this.katanaSparks.splice(i, 1);
      } else {
        this.ctx.fillStyle = s.color;
        this.ctx.globalAlpha = s.alpha;
        this.ctx.fillRect(Math.floor(s.x), Math.floor(s.y), s.size, s.size);
        this.ctx.globalAlpha = 1;
      }
    }
  }
}
