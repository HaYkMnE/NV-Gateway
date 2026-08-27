import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type PetState,
  loadPetConfig,
  savePetConfig,
  pickRandomState,
} from './petEngine';
import { audioEngine } from './audioEngine';
import { DonationModal } from './DonationModal';
import './pet.css';

export const PetWidget: React.FC = () => {
  const { t } = useTranslation();
  const [config, setConfig] = useState(loadPetConfig);
  const [state, setState] = useState<PetState>(config.lastState || 'code_frenzy');
  const [thoughtIndex, setThoughtIndex] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const [isDonationOpen, setIsDonationOpen] = useState(false);
  const [soundMuted, setSoundMuted] = useState(audioEngine.getMuted());
  const [caughtAction, setCaughtAction] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Periodic State Transitions (every 18-35s)
  useEffect(() => {
    const timer = setInterval(() => {
      const nextState = pickRandomState(config.vipStatus);
      setState(nextState);
      setThoughtIndex(Math.floor(Math.random() * 3));

      // Trigger audio cue based on state
      if (nextState === 'code_frenzy' || nextState === 'hyper_hack') {
        audioEngine.playKeyClick();
      } else if (nextState === 'bug_hunter' || nextState === 'bug_slayer') {
        audioEngine.playBugSlash();
      } else if (nextState === 'nano_coffee' || nextState === 'espresso_toast') {
        audioEngine.playCoffeeSip();
      } else if (nextState === 'power_nap' || nextState === 'terminal_nap') {
        audioEngine.startPurr();
      } else {
        audioEngine.stopPurr();
      }
    }, 22000);

    return () => {
      clearInterval(timer);
      audioEngine.stopPurr();
    };
  }, [config.vipStatus]);

  // Matrix Hacker Canvas Renderer (Pixel screen mode)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    const chars = '01NVGATWY_<>{}/*+=#';
    const fontSize = 10;
    const columns = Math.floor(canvas.width / fontSize);
    const drops = Array(columns).fill(1);

    const draw = () => {
      ctx.fillStyle = 'rgba(7, 21, 10, 0.2)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = '#59FF00';
      ctx.font = `${fontSize}px monospace`;

      for (let i = 0; i < drops.length; i++) {
        const text = chars.charAt(Math.floor(Math.random() * chars.length));
        ctx.fillText(text, i * fontSize, drops[i] * fontSize);

        if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
          drops[i] = 0;
        }
        drops[i]++;
      }
      animId = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animId);
  }, []);

  const handlePetClick = () => {
    audioEngine.playKeyClick();
    setCaughtAction(true);
    setTimeout(() => setCaughtAction(false), 2000);
    setIsDonationOpen(true);
  };

  const handleSoundToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const isMuted = audioEngine.toggleMute();
    setSoundMuted(isMuted);
  };

  const handleDonationSuccess = () => {
    const nextConfig = {
      ...config,
      vipStatus: true,
      totalDonationsCount: config.totalDonationsCount + 1,
    };
    setConfig(nextConfig);
    savePetConfig(nextConfig);
    setState('syndicate_salute');
  };

  // Get current thought line
  const thoughtKey = `pet_thought_${state}_${thoughtIndex % 3}`;
  const defaultThought = '*purr...* Ready for inference!';
  const thoughtText = t(thoughtKey, defaultThought);

  return (
    <>
      <div
        className="pet-widget-container group relative flex items-center gap-3 p-2 bg-[#080d0a]/90 hover:bg-[#0c140f] border border-[#59FF00]/30 hover:border-[#59FF00]/70 rounded-xl transition-all duration-300 shadow-[0_0_20px_rgba(89,255,0,0.08)] cursor-pointer select-none"
        onClick={handlePetClick}
        onMouseEnter={() => {
          setIsHovered(true);
          audioEngine.playHoverChirp();
        }}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Animated Cyber Pet Canvas / Mascot Rig */}
        <div className="relative w-12 h-12 shrink-0 rounded-lg overflow-hidden border border-[#59FF00]/40 bg-black flex items-center justify-center">
          <canvas
            ref={canvasRef}
            width={48}
            height={48}
            className="pixel-matrix-screen absolute inset-0 w-full h-full opacity-60"
          />

          {/* SVG Mascot Rig Overlay */}
          <svg
            viewBox="0 0 36 36"
            className="relative z-10 w-9 h-9 animate-cyber-glow"
            fill="none"
          >
            {/* Left Ear */}
            <path
              d="M8 12 L13 5 L16 13 Z"
              fill="#59FF00"
              className="animate-ear-left"
            />
            {/* Right Ear */}
            <path
              d="M28 12 L23 5 L20 13 Z"
              fill="#59FF00"
              className="animate-ear-right"
            />
            {/* Head */}
            <rect
              x="8"
              y="11"
              width="20"
              height="16"
              rx="4"
              fill="#061208"
              stroke="#59FF00"
              strokeWidth="1.5"
            />
            {/* Eyes (Glowing Cyber Visor or Dual Dots) */}
            {state === 'power_nap' || state === 'terminal_nap' ? (
              <g stroke="#59FF00" strokeWidth="1.5" strokeLinecap="round">
                <line x1="11" y1="18" x2="15" y2="18" />
                <line x1="21" y1="18" x2="25" y2="18" />
              </g>
            ) : (
              <g className="animate-eye-blink">
                <circle cx="13" cy="18" r="2" fill="#59FF00" />
                <circle cx="23" cy="18" r="2" fill="#59FF00" />
                <circle cx="14" cy="17.5" r="0.6" fill="#FFFFFF" />
                <circle cx="24" cy="17.5" r="0.6" fill="#FFFFFF" />
              </g>
            )}
            {/* Cute Nose / Whiskers */}
            <polygon points="18,21 16.5,19.5 19.5,19.5" fill="#59FF00" />
            <line x1="9" y1="21" x2="14" y2="21" stroke="#59FF00" strokeWidth="0.8" />
            <line x1="22" y1="21" x2="27" y2="21" stroke="#59FF00" strokeWidth="0.8" />
          </svg>

          {/* Floating Steam for Coffee */}
          {(state === 'nano_coffee' || state === 'espresso_toast') && (
            <div className="absolute top-0 right-1 text-[10px] animate-coffee-steam">
              ☕
            </div>
          )}
        </div>

        {/* Dynamic Thought Bubble & Status */}
        <div className="flex flex-col justify-center min-w-0 pr-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold font-mono text-[#59FF00] tracking-wider uppercase truncate">
              {config.vipStatus
                ? t('pet_vip_badge_text', '[ SYNDICATE ARCHITECT ]')
                : t('pet_jar_title', 'DEV TIP JAR')}
            </span>
            {caughtAction && (
              <span className="text-[9px] font-mono px-1 py-0.2 bg-amber-400 text-black font-bold rounded animate-bounce">
                {t('pet_caught_cue', 'CAUGHT!')}
              </span>
            )}
          </div>
          <p className="text-[10px] font-mono text-neutral-300 truncate max-w-[170px] italic">
            {thoughtText}
          </p>
        </div>

        {/* Sound Toggle Button */}
        <button
          onClick={handleSoundToggle}
          className="p-1 rounded-md text-neutral-400 hover:text-[#59FF00] hover:bg-white/5 transition shrink-0 ml-auto"
          title={soundMuted ? t('pet_sound_off_tooltip', 'Sound: OFF') : t('pet_sound_on_tooltip', 'Sound: ON')}
          aria-label={soundMuted ? t('pet_sound_off_aria', 'Unmute audio') : t('pet_sound_on_aria', 'Mute audio')}
        >
          {soundMuted ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 5L6 9H2v6h4l5 4V5z" />
              <line x1="23" y1="9" x2="17" y2="15" />
              <line x1="17" y1="9" x2="23" y2="15" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
          )}
        </button>
      </div>

      {/* Interactive Modal */}
      <DonationModal
        isOpen={isDonationOpen}
        onClose={() => setIsDonationOpen(false)}
        onDonationComplete={handleDonationSuccess}
      />
    </>
  );
};
