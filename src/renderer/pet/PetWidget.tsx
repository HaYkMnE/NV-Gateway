import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Volume2,
  VolumeX,
  Sparkles,
  Shuffle,
  Zap,
  Terminal as TerminalIcon,
  Heart,
  Crown,
} from 'lucide-react';
import {
  createPetEngine,
  type PetActivity,
  type PetCharacter,
  type PetEngine,
  type VipActivity,
} from './petEngine';
import {
  createPetAudioEngine,
  type PetAudioEngine,
} from './audioEngine';
import './pet.css';

export interface PetWidgetProps {
  /** Opens the main donation modal dialog. */
  onOpenDonation?: () => void;
  /** Optional container class overrides. */
  className?: string;
}

const STORAGE_VIP_KEY = 'nv_pet_vip';
const STORAGE_MUTED_KEY = 'nv_pet_muted';

function isVipStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_VIP_KEY) === 'true';
  } catch {
    return false;
  }
}

function isMutedStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_MUTED_KEY) === 'true';
  } catch {
    return false;
  }
}

function setMutedStored(val: boolean): void {
  try {
    localStorage.setItem(STORAGE_MUTED_KEY, String(val));
  } catch {
    /* ignore */
  }
}

/* ==========================================================================
   MASCOT SVG CHARACTER RENDERER (Clean modular components)
   ========================================================================== */

interface CharacterSvgProps {
  activity: string;
  isVip: boolean;
  onPetClick: () => void;
}

const MascotCharacter = memo(function MascotCharacter({
  activity,
  isVip,
  onPetClick,
}: CharacterSvgProps) {
  // Activity-driven visual parameters
  const isSleeping = activity === 'power-nap' || activity === 'quantum-meditation';
  const isJuggling = activity === 'model-juggler';
  const isTurbine = activity === 'turbine-generator';
  const isScanning = activity === 'bug-hunter' || activity === 'sensor-polish';
  const isCoffee = activity === 'nano-coffee' || activity === 'espresso-toast';
  const isLowBat = activity === 'low-battery';
  const isSalute = activity === 'syndicate-salute';
  const isWink = activity === 'fourth-wall-wink';

  return (
    <div
      onClick={onPetClick}
      className={`nv-pet-svg-container ${activity === 'power-nap' ? '' : 'act-float'}`}
      title="Click to interact with your AI Pet"
    >
      <svg
        viewBox="0 0 100 100"
        className="nv-pet-svg"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="nvPetBodyGrad" x1="0" y1="0" x2="0" y2="100%">
            <stop offset="0%" stopColor={isVip ? '#243A26' : '#141E16'} />
            <stop offset="100%" stopColor={isVip ? '#0D1A10' : '#090D0A'} />
          </linearGradient>
          <linearGradient id="nvPetVisorGrad" x1="0" y1="0" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#040805" />
            <stop offset="100%" stopColor="#0A140C" />
          </linearGradient>
          <filter id="nvPetGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Floating Shadow */}
        <ellipse
          cx="50"
          cy="92"
          rx={isSleeping ? '28' : '22'}
          ry="4"
          fill="rgba(0,0,0,0.5)"
        />

        {/* Juggling Orbs Effect */}
        {isJuggling && (
          <g>
            <circle cx="30" cy="30" r="4" fill="#59FF00" filter="url(#nvPetGlow)" className="act-juggle-left" />
            <circle cx="70" cy="30" r="4" fill="#00FFD1" filter="url(#nvPetGlow)" className="act-juggle-right" />
            <circle cx="50" cy="18" r="3.5" fill="#FFB020" filter="url(#nvPetGlow)" />
          </g>
        )}

        {/* Coffee Cup Accessory */}
        {isCoffee && (
          <g transform="translate(62, 58)">
            <rect x="0" y="0" width="10" height="12" rx="2" fill="#1A261C" stroke="#59FF00" strokeWidth="1" />
            <path d="M10 3 H13 V8 H10" stroke="#59FF00" strokeWidth="1" fill="none" />
            <path d="M3 -3 Q5 -6 3 -9" stroke="#00FFD1" strokeWidth="1" fill="none" className="act-steam" />
          </g>
        )}

        {/* Robot Main Outer Chassis / Head */}
        <rect
          x="24"
          y="28"
          width="52"
          height="48"
          rx="16"
          fill="url(#nvPetBodyGrad)"
          stroke={isVip ? '#59FF00' : isLowBat ? '#FFB020' : '#2A3C2E'}
          strokeWidth={isVip ? '2' : '1.5'}
        />

        {/* Antenna / Sensor Horns */}
        <path d="M36 28 L30 18" stroke="#59FF00" strokeWidth="2" strokeLinecap="round" />
        <circle cx="30" cy="18" r="2.5" fill="#59FF00" filter="url(#nvPetGlow)" />
        <path d="M64 28 L70 18" stroke="#59FF00" strokeWidth="2" strokeLinecap="round" />
        <circle cx="70" cy="18" r="2.5" fill="#59FF00" filter="url(#nvPetGlow)" />

        {/* Turbine Chest Generator */}
        {isTurbine ? (
          <g transform="translate(50, 62)">
            <circle cx="0" cy="0" r="7" fill="#050805" stroke="#59FF00" strokeWidth="1.5" />
            <g className="act-spin">
              <path d="M0 -6 L0 6 M-6 0 L6 0" stroke="#00FFD1" strokeWidth="1.5" />
            </g>
          </g>
        ) : (
          /* Subtle NVIDIA emblem on chest */
          <g transform="translate(50, 64) scale(0.6)">
            <path
              d="M-6 0 C-6 -4, 6 -4, 6 0 C6 4, -6 4, -6 0"
              fill="none"
              stroke={isVip ? '#59FF00' : '#3A523E'}
              strokeWidth="1.5"
            />
          </g>
        )}

        {/* Visor Screen Face */}
        <rect
          x="30"
          y="36"
          width="40"
          height="22"
          rx="8"
          fill="url(#nvPetVisorGrad)"
          stroke="#1E2E21"
          strokeWidth="1"
        />

        {/* Scanner Laser Sweep */}
        {isScanning && (
          <line
            x1="32"
            y1="47"
            x2="68"
            y2="47"
            stroke="#59FF00"
            strokeWidth="1.5"
            filter="url(#nvPetGlow)"
            className="act-scan"
          />
        )}

        {/* Eyes Display */}
        {isSleeping ? (
          /* Sleeping Eyes (curved lines) */
          <g stroke="#00FFD1" strokeWidth="2" strokeLinecap="round">
            <path d="M37 48 Q42 52 47 48" />
            <path d="M53 48 Q58 52 63 48" />
            <text x="68" y="32" fill="#00FFD1" fontSize="9" fontFamily="monospace">z</text>
            <text x="74" y="24" fill="#00FFD1" fontSize="11" fontFamily="monospace">Z</text>
          </g>
        ) : isLowBat ? (
          /* Low Battery Eyes (amber minus lines) */
          <g stroke="#FFB020" strokeWidth="2.5" strokeLinecap="round" filter="url(#nvPetGlow)">
            <line x1="37" y1="47" x2="45" y2="47" />
            <line x1="55" y1="47" x2="63" y2="47" />
          </g>
        ) : isWink ? (
          /* Wink Eyes */
          <g filter="url(#nvPetGlow)">
            <circle cx="41" cy="47" r="3.5" fill="#59FF00" />
            <path d="M54 47 Q59 42 64 47" stroke="#59FF00" strokeWidth="2.5" strokeLinecap="round" />
          </g>
        ) : (
          /* Normal Glowing Visor Eyes (with auto-blink) */
          <g className="act-blink" filter="url(#nvPetGlow)">
            <circle cx="41" cy="47" r="3.5" fill={isVip ? '#00FFD1' : '#59FF00'} />
            <circle cx="59" cy="47" r="3.5" fill={isVip ? '#00FFD1' : '#59FF00'} />
          </g>
        )}

        {/* Salute Arm Gesture */}
        {isSalute && (
          <path
            d="M74 54 L84 40 L72 38"
            stroke="#59FF00"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            filter="url(#nvPetGlow)"
          />
        )}

        {/* VIP Golden Crown Accessory */}
        {isVip && (
          <g transform="translate(50, 23) scale(0.8)">
            <polygon
              points="-10,4 -6,-5 0,0 6,-5 10,4"
              fill="#59FF00"
              stroke="#00FFD1"
              strokeWidth="1"
              filter="url(#nvPetGlow)"
            />
          </g>
        )}
      </svg>
    </div>
  );
});

/* ==========================================================================
   HACKER PIXEL ART CHARACTER RENDERER (Clean modular components)
   ========================================================================== */

const HackerCharacter = memo(function HackerCharacter({
  activity,
  isVip,
  onPetClick,
}: CharacterSvgProps) {
  const isTyping = activity === 'code-frenzy' || activity === 'hyper-hack';
  const isSleeping = activity === 'terminal-nap' || activity === 'quantum-meditation';
  const isCoffee = activity === 'empty-mug' || activity === 'espresso-toast';
  const isVictory = activity === 'zero-errors' || activity === 'bug-slayer';

  return (
    <div
      onClick={onPetClick}
      className={`nv-pet-svg-container ${isTyping ? 'act-hacker-type' : 'act-float'}`}
      title="Click to interact with Cyber Hacker"
    >
      <svg
        viewBox="0 0 100 100"
        className="nv-pet-svg"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        shapeRendering="crispEdges"
      >
        <defs>
          <filter id="hackerPixelGlow">
            <feDropShadow dx="0" dy="0" stdDeviation="1.5" floodColor="#59FF00" floodOpacity="0.6" />
          </filter>
        </defs>

        {/* Shadow */}
        <rect x="25" y="88" width="50" height="4" fill="rgba(0,0,0,0.5)" />

        {/* Hoodie / Body Matrix */}
        <rect x="30" y="36" width="40" height="46" fill="#121814" stroke="#1E2B20" strokeWidth="2" />
        <rect x="34" y="40" width="32" height="38" fill="#18221B" />

        {/* Cyberpunk Hood Rim */}
        <path
          d="M28 36 L50 20 L72 36 L68 44 L50 32 L32 44 Z"
          fill="#1C281F"
          stroke={isVip ? '#59FF00' : '#2A3E2F'}
          strokeWidth="1"
        />

        {/* Face Void (Shadowed interior) */}
        <rect x="36" y="34" width="28" height="24" rx="2" fill="#060A07" />

        {/* Pixel Eyes / Cyber VR Visor */}
        {isSleeping ? (
          <g fill="#00FFD1">
            <rect x="40" y="44" width="6" height="2" />
            <rect x="54" y="44" width="6" height="2" />
          </g>
        ) : (
          <g fill={isVip ? '#00FFD1' : '#59FF00'} filter="url(#hackerPixelGlow)">
            {/* Visor Bar / Matrix Eyes */}
            <rect x="38" y="42" width="9" height="4" />
            <rect x="53" y="42" width="9" height="4" />
            <rect x="40" y="44" width="2" height="2" fill="#000" />
            <rect x="55" y="44" width="2" height="2" fill="#000" />
          </g>
        )}

        {/* Terminal Matrix Rain Laptop Deck */}
        <g transform="translate(25, 66)">
          {/* Laptop Base */}
          <rect x="0" y="8" width="50" height="6" rx="1" fill="#18221B" stroke="#59FF00" strokeWidth="1" />
          {/* Laptop Screen */}
          <rect x="6" y="-12" width="38" height="20" rx="1" fill="#050906" stroke="#2B3E2F" strokeWidth="1" />
          {/* Green Code lines on screen */}
          <rect x="9" y="-9" width="16" height="2" fill="#59FF00" />
          <rect x="9" y="-5" width="24" height="2" fill="#00FFD1" />
          <rect x="9" y="-1" width="12" height="2" fill="#59FF00" />
          <rect x="9" y="3" width="20" height="2" fill="#3D5C43" />
        </g>

        {/* Coffee Mug Accessory */}
        {isCoffee && (
          <g transform="translate(76, 68)">
            <rect x="0" y="0" width="8" height="10" fill="#243328" stroke="#59FF00" strokeWidth="1" />
            <rect x="8" y="2" width="3" height="5" stroke="#59FF00" strokeWidth="1" fill="none" />
          </g>
        )}

        {/* Victory Trophy / Bug Slay */}
        {isVictory && (
          <g transform="translate(74, 30)">
            <circle cx="6" cy="6" r="6" fill="#FFB020" filter="url(#hackerPixelGlow)" />
            <text x="3" y="9" fill="#000" fontSize="9" fontWeight="bold">0</text>
          </g>
        )}
      </svg>
    </div>
  );
});

/* ==========================================================================
   MAIN PET WIDGET COMPONENT
   ========================================================================== */

export const PetWidget = memo(function PetWidget({
  onOpenDonation,
  className = '',
}: PetWidgetProps) {
  const { t, i18n } = useTranslation();
  const [character, setCharacter] = useState<PetCharacter>('mascot');
  const [activity, setActivity] = useState<string>('bug-hunter');
  const [isVip, setIsVip] = useState<boolean>(isVipStored);
  const [isMuted, setIsMuted] = useState<boolean>(isMutedStored);
  const [isAway, setIsAway] = useState<boolean>(false);
  const [speechText, setSpeechText] = useState<string | null>(null);
  const [cueActive, setCueActive] = useState<boolean>(false);
  const speechTimerRef = useRef<number | undefined>(undefined);
  const cueTimerRef = useRef<number | undefined>(undefined);

  // Audio engine reference
  const audioRef = useRef<PetAudioEngine | null>(null);

  // Initialize audio engine once
  useEffect(() => {
    const audio = createPetAudioEngine();
    audio.setMuted(isMutedStored());
    audioRef.current = audio;

    return () => {
      audio.dispose();
      audioRef.current = null;
    };
  }, []);

  // Sync mute state
  const handleToggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      setMutedStored(next);
      audioRef.current?.setMuted(next);
      if (!next) {
        audioRef.current?.playTone('blip');
      }
      return next;
    });
  }, []);

  // Show a speech bubble with auto-dismiss
  const triggerSpeech = useCallback((textKey: string, customFallback?: string) => {
    if (speechTimerRef.current !== undefined) {
      window.clearTimeout(speechTimerRef.current);
    }
    const localized = t(textKey, { defaultValue: customFallback || textKey });
    setSpeechText(localized);
    speechTimerRef.current = window.setTimeout(() => {
      setSpeechText(null);
      speechTimerRef.current = undefined;
    }, 4500);
  }, [t]);

  // Pet engine initialization
  const engineRef = useRef<PetEngine | null>(null);

  useEffect(() => {
    const engine = createPetEngine({
      isVip: () => isVipStored(),
      onActivityChange: (newAct) => {
        setActivity(newAct);
        audioRef.current?.playTone('chirp');
        // Announce activity dialogue
        triggerSpeech(`pet_act_${newAct.replace(/-/g, '_')}`);
      },
      onCue: () => {
        // "CAUGHT IN THE ACT!" cue event
        setCueActive(true);
        audioRef.current?.playTone('caught');
        triggerSpeech('pet_cue_caught', '✦ CAUGHT IN THE ACT!');
        if (cueTimerRef.current !== undefined) {
          window.clearTimeout(cueTimerRef.current);
        }
        cueTimerRef.current = window.setTimeout(() => {
          setCueActive(false);
          cueTimerRef.current = undefined;
        }, 3000);
      },
    });

    const activeChar = engine.pickSessionCharacter();
    setCharacter(activeChar);
    setActivity(engine.getActivity());
    engineRef.current = engine;

    // Attach visibility/focus listener
    const cleanupFocus = engine.attachFocusListeners(window, {
      onAttentionLost: () => setIsAway(true),
      onAttentionGained: () => setIsAway(false),
    });

    return () => {
      cleanupFocus();
      engineRef.current = null;
    };
  }, [triggerSpeech]);

  // Listen for VIP ascension events from DonationModal
  useEffect(() => {
    const handleAscension = () => {
      setIsVip(true);
      audioRef.current?.playTone('celebrate');
      triggerSpeech('pet_vip_ascended', '👑 SYNDICATE PATRON ASCENDED!');
      engineRef.current?.nextRandomActivity();
    };
    window.addEventListener('nv-pet-ascension', handleAscension);
    return () => window.removeEventListener('nv-pet-ascension', handleAscension);
  }, [triggerSpeech]);

  // Next activity button click
  const handleNextActivity = useCallback(() => {
    audioRef.current?.playTone('blip');
    engineRef.current?.nextRandomActivity();
  }, []);

  // Reroll character button click
  const handleRerollCharacter = useCallback(() => {
    audioRef.current?.playTone('chirp');
    engineRef.current?.resetSessionCharacter();
    const nextChar = engineRef.current?.pickSessionCharacter() ?? 'mascot';
    setCharacter(nextChar);
    triggerSpeech(
      nextChar === 'mascot' ? 'pet_char_mascot_greet' : 'pet_char_hacker_greet'
    );
  }, [triggerSpeech]);

  // Interactive click on the pet body
  const handlePetClick = useCallback(() => {
    audioRef.current?.playTone('purr');
    triggerSpeech('pet_click_reaction', '⚡ SYSTEM OPTIMAL · READY');
  }, [triggerSpeech]);

  // Format localized activity name label
  const activityLabel = useMemo(() => {
    return t(`pet_act_title_${activity.replace(/-/g, '_')}`, {
      defaultValue: activity.replace(/-/g, ' ').toUpperCase(),
    });
  }, [activity, t]);

  return (
    <div
      className={`nv-pet-wrap ${isVip ? 'is-vip' : ''} ${isAway ? 'is-away' : ''} ${className}`}
      aria-label="Desktop Mascot Widget"
    >
      {/* Top Cyber Header */}
      <div className="nv-pet-header">
        <div className="nv-pet-header-status">
          <span className="nv-pet-led" />
          <span className="font-bold text-[9px] text-textMain">
            {character === 'mascot' ? 'AI MASCOT' : 'PIXEL HACKER'}
          </span>
          {isVip && (
            <span className="flex items-center gap-1 text-[9px] text-accent-neon font-bold">
              <Crown size={10} /> VIP
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Sound Toggle */}
          <button
            type="button"
            onClick={handleToggleMute}
            className="p-1 text-textMuted hover:text-accent-neon transition-colors cursor-pointer"
            aria-label={isMuted ? t('unmute') : t('mute')}
            title={isMuted ? t('unmute') : t('mute')}
          >
            {isMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
          </button>
          {/* Character Switch */}
          <button
            type="button"
            onClick={handleRerollCharacter}
            className="p-1 text-textMuted hover:text-accent-neon transition-colors cursor-pointer"
            aria-label="Switch Mascot Character"
            title="Switch Character"
          >
            <Shuffle size={12} />
          </button>
        </div>
      </div>

      {/* Hologram Stage */}
      <div className="nv-pet-stage">
        {/* Glow Aura */}
        <div className="nv-pet-aura" />

        {/* Dialogue Bubble */}
        {speechText && (
          <div className="nv-pet-speech">
            {speechText}
            <div className="nv-pet-speech-tail" />
          </div>
        )}

        {/* Caught in the Act cue banner */}
        {cueActive && (
          <div className="nv-pet-cue-banner">
            ✦ CAUGHT IN THE ACT!
          </div>
        )}

        {/* Render Active Character */}
        {character === 'mascot' ? (
          <MascotCharacter
            activity={activity}
            isVip={isVip}
            onPetClick={handlePetClick}
          />
        ) : (
          <HackerCharacter
            activity={activity}
            isVip={isVip}
            onPetClick={handlePetClick}
          />
        )}
      </div>

      {/* Control Footer */}
      <div className="nv-pet-footer">
        <div className="nv-pet-act-name" title={activityLabel}>
          <span className="text-textMuted">ACT: </span>
          <span className="font-semibold text-textMain">{activityLabel}</span>
        </div>

        <div className="nv-pet-controls">
          {/* Cycle Action */}
          <button
            type="button"
            onClick={handleNextActivity}
            className="nv-pet-btn"
            aria-label="Next Action"
            title="Trigger Next Behavior"
          >
            <Zap size={12} />
          </button>

          {/* Support / Donate Action */}
          <button
            type="button"
            onClick={onOpenDonation}
            className="nv-pet-btn nv-pet-btn-donate"
            aria-label="Sponsor & Donate"
            title="Support Development · Unlock VIP"
          >
            <Heart size={11} className="fill-current" />
            <span>{isVip ? 'PATRON' : 'DONATE'}</span>
          </button>
        </div>
      </div>
    </div>
  );
});
