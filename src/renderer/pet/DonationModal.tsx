import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import QRCode from 'qrcode';
import { petAudio } from './audioEngine';
import './donation-modal.css';

/**
 * DonationModal — cyberpunk "SUPPORT NV-GATEWAY" modal.
 *
 * Visual design ported from nvgateway-donation-mockups/interactive-showcase.html:
 *   - Dark CRT theme (#0A0D0B / #141A16 border / #33FF00 green / #FFD028 VIP gold / #FF3366 panic red).
 *   - Tier selector (SUPPORTER $5 / ADVOCATE $15 / SYNDICATE $50 / SPONSOR custom)
 *     with auto-toggling currency (Crypto USDT/BTC/ETH vs Fiat card/PayPal mock).
 *   - Live QR code rendered to HTML canvas via `qrcode` package (SVG-free,
 *     works without external asset fetches, safe under tight CSP).
 *   - "Ascend to Syndicate Patron" instant VIP unlock button (persists to
 *     localStorage nv_pet_vip, emits petAudio ascension ritual sfx, fires
 *     onAscension callback to activate VIP state in PetWidget without reload).
 */

export interface DonationModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Fired when the user clicks "Ascend to Syndicate Patron" or confirms a
   * donation. The host should notify PetWidget so it can update VIP state
   * immediately.
   */
  onAscension?: () => void;
}

type CurrencyMode = 'crypto' | 'fiat';
type CryptoChain = 'usdt-trc20' | 'btc' | 'eth';

interface DonationTier {
  id: string;
  nameKey: string;
  usdAmount: number;
  amountLabel: string;
  taglineKey: string;
  perksKey: string;
  vip: boolean;
}

const TIERS: readonly DonationTier[] = [
  {
    id: 'supporter',
    nameKey: 'pet_tier_supporter',
    usdAmount: 5,
    amountLabel: '$5',
    taglineKey: 'pet_tier_supporter_tag',
    perksKey: 'pet_tier_supporter_perks',
    vip: false,
  },
  {
    id: 'advocate',
    nameKey: 'pet_tier_advocate',
    usdAmount: 15,
    amountLabel: '$15',
    taglineKey: 'pet_tier_advocate_tag',
    perksKey: 'pet_tier_advocate_perks',
    vip: false,
  },
  {
    id: 'syndicate',
    nameKey: 'pet_tier_syndicate',
    usdAmount: 50,
    amountLabel: '$50',
    taglineKey: 'pet_tier_syndicate_tag',
    perksKey: 'pet_tier_syndicate_perks',
    vip: true,
  },
  {
    id: 'custom',
    nameKey: 'pet_tier_custom',
    usdAmount: 0,
    amountLabel: 'Custom',
    taglineKey: 'pet_tier_custom_tag',
    perksKey: 'pet_tier_custom_perks',
    vip: false,
  },
];

/**
 * Public donation destination addresses (safe static donation targets).
 * TRON USDT (TRC-20) / BTC Native SegWit / EVM ETH.
 */
const CRYPTO_ADDRESSES: Record<CryptoChain, { label: string; address: string; uriPrefix: string }> = {
  'usdt-trc20': {
    label: 'USDT (TRC-20 / TRON)',
    address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    uriPrefix: '',
  },
  btc: {
    label: 'Bitcoin (BTC)',
    address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    uriPrefix: 'bitcoin:',
  },
  eth: {
    label: 'Ethereum (ETH / ERC-20)',
    address: '0x71C8A33190C6b62D71eb352136d8d9B7f8C733c7',
    uriPrefix: 'ethereum:',
  },
};

const VIP_STORAGE_KEY = 'nv_pet_vip';

export function DonationModal({ open, onClose, onAscension }: DonationModalProps) {
  const { t } = useTranslation();
  const [selectedTier, setSelectedTier] = useState<string>('syndicate');
  const [currency, setCurrency] = useState<CurrencyMode>('crypto');
  const [cryptoChain, setCryptoChain] = useState<CryptoChain>('usdt-trc20');
  const [customUsd, setCustomUsd] = useState<string>('25');
  const [copied, setCopied] = useState<boolean>(false);
  const [qrModalOpen, setQrModalOpen] = useState<boolean>(false);
  const [isVip, setIsVip] = useState<boolean>(() => {
    try {
      return localStorage.getItem(VIP_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (qrModalOpen) {
          setQrModalOpen(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, qrModalOpen, onClose]);

  // Current crypto address
  const activeCrypto = CRYPTO_ADDRESSES[cryptoChain];

  // Render inline QR code when crypto tab is active
  useEffect(() => {
    if (!open || currency !== 'crypto') return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const uri = activeCrypto.uriPrefix + activeCrypto.address;
    QRCode.toCanvas(canvas, uri, {
      width: 140,
      margin: 1,
      color: {
        dark: '#33FF00',
        light: '#0A0D0B',
      },
    }).catch(() => {
      /* ignore canvas errors */
    });
  }, [open, currency, activeCrypto]);

  // Render high-res zoomed QR code in sub-modal
  useEffect(() => {
    if (!qrModalOpen) return;
    const canvas = qrCanvasRef.current;
    if (!canvas) return;

    const uri = activeCrypto.uriPrefix + activeCrypto.address;
    QRCode.toCanvas(canvas, uri, {
      width: 260,
      margin: 2,
      color: {
        dark: '#33FF00',
        light: '#0A0D0B',
      },
    }).catch(() => {
      /* ignore canvas errors */
    });
  }, [qrModalOpen, activeCrypto]);

  // Copy address to clipboard
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(activeCrypto.address);
      setCopied(true);
      petAudio.playEasterEggDisk(0);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }, [activeCrypto.address]);

  // Ascend to VIP (persists VIP state, plays ascension ritual, fires callback)
  const handleAscend = useCallback(() => {
    try {
      localStorage.setItem(VIP_STORAGE_KEY, 'true');
    } catch {
      /* ignore */
    }
    setIsVip(true);
    petAudio.playAscensionRitual();
    onAscension?.();
  }, [onAscension]);

  if (!open) return null;

  const tier = TIERS.find((x) => x.id === selectedTier) ?? TIERS[2];

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('pet_donation_title')}
        className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm overflow-y-auto"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="relative w-full max-w-xl my-auto rounded-xl border border-[#1A261C] bg-[#0A0D0B] p-5 sm:p-6 shadow-[0_0_40px_rgba(51,255,0,0.15)] text-textMain">
          {/* Cyberpunk Top Accent Bar */}
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#33FF00] via-[#00FFD1] to-[#FFD028] rounded-t-xl" />

          {/* Header */}
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-bold text-accent-neon uppercase tracking-widest">
                  [ {t('pet_donation_kicker')} ]
                </span>
                {isVip && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#FFD028]/20 text-[#FFD028] border border-[#FFD028]/60">
                    👑 VIP PATRON
                  </span>
                )}
              </div>
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-textMain mt-1">
                {t('pet_donation_title')}
              </h2>
              <p className="text-xs text-textMuted mt-1 leading-relaxed">
                {t('pet_donation_subtitle')}
              </p>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-textMuted hover:text-accent-neon rounded-lg hover:bg-surface border border-transparent hover:border-border transition-colors cursor-pointer"
              aria-label={t('close_menu')}
            >
              <X size={18} />
            </button>
          </div>

          {/* Tier Selection Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
            {TIERS.map((tItem) => {
              const isSelected = selectedTier === tItem.id;
              return (
                <button
                  key={tItem.id}
                  type="button"
                  onClick={() => {
                    setSelectedTier(tItem.id);
                    petAudio.playEasterEggDisk(1);
                  }}
                  className={`p-3 rounded-lg border text-left transition-all cursor-pointer relative overflow-hidden ${
                    isSelected
                      ? tItem.vip
                        ? 'border-[#FFD028] bg-[#FFD028]/10 shadow-[0_0_15px_rgba(255,208,40,0.25)]'
                        : 'border-accent-neon bg-accent-neon/10 shadow-[0_0_15px_rgba(51,255,0,0.2)]'
                      : 'border-border/60 bg-surface/60 hover:border-border hover:bg-surface text-textMuted hover:text-textMain'
                  }`}
                >
                  {tItem.vip && (
                    <div className="text-[9px] font-mono font-bold text-[#FFD028] tracking-wider uppercase mb-1">
                      👑 VIP
                    </div>
                  )}
                  <div className="font-bold text-sm text-textMain">{t(tItem.nameKey)}</div>
                  <div
                    className={`font-mono text-xs font-semibold mt-0.5 ${
                      tItem.vip ? 'text-[#FFD028]' : 'text-accent-neon'
                    }`}
                  >
                    {tItem.id === 'custom' ? `$${customUsd}` : tItem.amountLabel}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Selected Tier Details Callout */}
          <div className="p-3.5 rounded-lg border border-border/80 bg-surface/50 mb-4 text-xs space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-bold text-textMain">{t(tier.nameKey)} Tier</span>
              {tier.vip && (
                <span className="font-mono text-[10px] text-[#FFD028] font-bold">
                  ★ UNLOCKS VIP MASCOT BEHAVIORS
                </span>
              )}
            </div>
            <p className="text-textMuted">{t(tier.taglineKey)}</p>
            <p className="text-textMuted/80 text-[11px] pt-1 border-t border-border/40 font-mono">
              {t(tier.perksKey)}
            </p>
          </div>

          {/* Currency Toggle (Crypto vs Fiat) */}
          <div className="flex items-center gap-2 mb-3">
            <button
              type="button"
              onClick={() => setCurrency('crypto')}
              className={`px-3 py-1.5 rounded text-xs font-semibold transition-all cursor-pointer ${
                currency === 'crypto'
                  ? 'bg-accent-neon text-bg font-bold shadow-[0_0_10px_rgba(51,255,0,0.3)]'
                  : 'bg-surface border border-border text-textMuted hover:text-textMain'
              }`}
            >
              ⚡ Crypto (USDT / BTC / ETH)
            </button>
            <button
              type="button"
              onClick={() => setCurrency('fiat')}
              className={`px-3 py-1.5 rounded text-xs font-semibold transition-all cursor-pointer ${
                currency === 'fiat'
                  ? 'bg-accent-neon text-bg font-bold shadow-[0_0_10px_rgba(51,255,0,0.3)]'
                  : 'bg-surface border border-border text-textMuted hover:text-textMain'
              }`}
            >
              💳 Card / PayPal (Direct)
            </button>
          </div>

          {/* Crypto Content Block */}
          {currency === 'crypto' ? (
            <div className="space-y-3 p-4 rounded-xl border border-border bg-bg/80">
              {/* Chain Selection Tabs */}
              <div className="flex flex-wrap gap-2">
                {(['usdt-trc20', 'btc', 'eth'] as const).map((chain) => (
                  <button
                    key={chain}
                    type="button"
                    onClick={() => setCryptoChain(chain)}
                    className={`px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer ${
                      cryptoChain === chain
                        ? 'border border-accent-neon text-accent-neon bg-accent-neon/10 font-bold'
                        : 'border border-border/80 text-textMuted hover:text-textMain bg-surface'
                    }`}
                  >
                    {CRYPTO_ADDRESSES[chain].label}
                  </button>
                ))}
              </div>

              {/* QR & Address View */}
              <div className="flex flex-col sm:flex-row items-center gap-4 pt-1">
                {/* QR Canvas */}
                <div
                  onClick={() => setQrModalOpen(true)}
                  className="p-2 rounded-lg border border-accent-neon/50 bg-[#0A0D0B] shrink-0 cursor-zoom-in group relative"
                  title="Click to Zoom QR"
                >
                  <canvas ref={canvasRef} className="w-[140px] h-[140px] block" />
                  <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center text-[10px] font-mono text-accent-neon font-bold transition-opacity rounded-lg">
                    🔍 ZOOM
                  </div>
                </div>

                {/* Address and Actions */}
                <div className="min-w-0 flex-1 space-y-2 w-full">
                  <div>
                    <label className="block text-[10px] font-mono uppercase tracking-wider text-textMuted mb-1">
                      {activeCrypto.label} {t('pet_donation_address')}
                    </label>
                    <code className="block p-2 rounded bg-surface border border-border font-mono text-xs text-textMain break-all select-all">
                      {activeCrypto.address}
                    </code>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void handleCopy()}
                      className="px-3 py-1.5 rounded text-xs font-semibold bg-accent-neon/15 hover:bg-accent-neon/25 text-accent-neon border border-accent-neon/50 transition-colors cursor-pointer flex items-center gap-1.5"
                    >
                      <span>{copied ? '✓ COPIED' : '📋 COPY ADDRESS'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setQrModalOpen(true)}
                      className="px-3 py-1.5 rounded text-xs font-semibold bg-surface hover:bg-border text-textMain border border-border transition-colors cursor-pointer"
                    >
                      🔍 EXPAND QR
                    </button>
                  </div>

                  <p className="text-[10px] text-textMuted leading-relaxed">
                    {t('pet_donation_crypto_note')}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            /* Fiat / Direct Links Content Block */
            <div className="space-y-3 p-4 rounded-xl border border-border bg-bg/80">
              <p className="text-xs text-textMuted leading-relaxed">
                {t('pet_donation_fiat_desc')}
              </p>

              <div className="grid sm:grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    void window.electronAPI.openExternal(
                      'https://github.com/sponsors/HaYkMnE'
                    );
                  }}
                  className="p-3 rounded-lg border border-border hover:border-accent-neon bg-surface hover:bg-accent-neon/10 text-left transition-all cursor-pointer"
                >
                  <div className="font-bold text-xs text-textMain">★ GitHub Sponsors</div>
                  <div className="text-[11px] text-textMuted mt-0.5">Recurring or one-time via card</div>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    void window.electronAPI.openExternal(
                      'https://github.com/HaYkMnE/NV-Gateway'
                    );
                  }}
                  className="p-3 rounded-lg border border-border hover:border-[#FFD028] bg-surface hover:bg-[#FFD028]/10 text-left transition-all cursor-pointer"
                >
                  <div className="font-bold text-xs text-textMain">⚡ Project Repository</div>
                  <div className="text-[11px] text-textMuted mt-0.5">Star & contribute on GitHub</div>
                </button>
              </div>
            </div>
          )}

          {/* Syndicate Ascension Button */}
          <div className="mt-5 pt-4 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="text-xs text-textMuted">
              {isVip ? (
                <span className="text-[#FFD028] font-bold">
                  👑 VIP Syndicate Patron Status Active
                </span>
              ) : (
                <span>Unlocked instant VIP perks on donation</span>
              )}
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto">
              {!isVip && (
                <button
                  type="button"
                  onClick={handleAscend}
                  className="w-full sm:w-auto px-4 py-2 rounded-lg text-xs font-bold bg-gradient-to-r from-[#FFD028] to-[#FF8C00] text-bg hover:brightness-110 shadow-[0_0_15px_rgba(255,208,40,0.4)] transition-all cursor-pointer flex items-center justify-center gap-1.5"
                >
                  <span>👑 ASCEND TO VIP PATRON</span>
                </button>
              )}

              <button
                type="button"
                onClick={onClose}
                className="w-full sm:w-auto px-4 py-2 rounded-lg text-xs font-medium border border-border hover:border-textMuted text-textMuted hover:text-textMain bg-surface transition-colors cursor-pointer"
              >
                {t('close_menu')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* High-res Zoomed QR Sub-modal */}
      {qrModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Zoomed QR Code"
          className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md"
          onClick={() => setQrModalOpen(false)}
        >
          <div
            className="p-6 rounded-2xl border-2 border-accent-neon bg-[#0A0D0B] shadow-[0_0_50px_rgba(51,255,0,0.3)] text-center space-y-4 max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-xs font-mono font-bold text-accent-neon uppercase tracking-wider">
              {activeCrypto.label}
            </div>

            <div className="p-3 bg-[#0A0D0B] rounded-xl border border-accent-neon/40 inline-block">
              <canvas ref={qrCanvasRef} className="w-[260px] h-[260px] block" />
            </div>

            <code className="block p-2 rounded bg-surface border border-border font-mono text-[11px] text-textMain break-all select-all">
              {activeCrypto.address}
            </code>

            <button
              type="button"
              onClick={() => setQrModalOpen(false)}
              className="w-full py-2 rounded-lg bg-accent-neon text-bg font-bold text-xs hover:brightness-110 cursor-pointer"
            >
              {t('close_menu')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
