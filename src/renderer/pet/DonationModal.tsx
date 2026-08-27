import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, ExternalLink, QrCode, Sparkles, X, HeartHandshake } from 'lucide-react';
import './donation-modal.css';

export interface DonationModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Called when VIP ascension is confirmed (VIP state persisted, pet engine
   * notified to switch to the VIP behavior suite + celebration overlay).
   */
  onAscension?: () => void;
}

interface CryptoTier {
  id: string;
  nameKey: string;
  taglineKey: string;
  amountLabel: string;
  symbol: string;
  network: string;
  address: string;
  accent: string;
  glow: string;
  qrSvg: string; // SVG path data for authentic visual QR representation
}

// Curated donation addresses (EVM, BTC, SOL, TRON USDT).
// Addresses are safe static public destination strings.
const CRYPTO_TIERS: CryptoTier[] = [
  {
    id: 'eth',
    nameKey: 'donation_tier_eth_name',
    taglineKey: 'donation_tier_eth_tag',
    amountLabel: '0.01+ ETH / ERC-20',
    symbol: 'ETH / USDT / USDC',
    network: 'Ethereum (ERC-20) · Arbitrum · Base · Optimism',
    address: '0x71C8A33190C6b62D71eb352136d8d9B7f8C733c7',
    accent: '#59FF00',
    glow: 'rgba(89, 255, 0, 0.4)',
    qrSvg: 'M4 4h6v6H4zm2 2h2v2H6zm8-2h6v6h-6zm2 2h2v2h-2zM4 14h6v6H4zm2 2h2v2H6zm10 0h2v2h-2zm-2-2h2v2h-2zm4 4h2v2h-2zm-2 2h2v2h-2zm-4-4h2v2h-2zm6-2h2v2h-2zm-4-2h2v2h-2zm2-2h2v2h-2zm-6 2h2v2h-2z',
  },
  {
    id: 'sol',
    nameKey: 'donation_tier_sol_name',
    taglineKey: 'donation_tier_sol_tag',
    amountLabel: '0.1+ SOL / SPL',
    symbol: 'SOL / USDC (Solana)',
    network: 'Solana Network',
    address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
    accent: '#00FFD1',
    glow: 'rgba(0, 255, 209, 0.4)',
    qrSvg: 'M4 4h6v6H4zm2 2h2v2H6zm8-2h6v6h-6zm2 2h2v2h-2zM4 14h6v6H4zm2 2h2v2H6zm8 2h2v2h-2zm4-4h2v2h-2zm-2 2h2v2h-2zm4 4h2v2h-2zm-6-2h2v2h-2zm4-6h2v2h-2zm-2 4h2v2h-2zm-4-4h2v2h-2z',
  },
  {
    id: 'btc',
    nameKey: 'donation_tier_btc_name',
    taglineKey: 'donation_tier_btc_tag',
    amountLabel: '0.0005+ BTC',
    symbol: 'BTC (Native SegWit)',
    network: 'Bitcoin Mainnet (bech32)',
    address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    accent: '#FFB020',
    glow: 'rgba(255, 176, 32, 0.4)',
    qrSvg: 'M4 4h6v6H4zm2 2h2v2H6zm8-2h6v6h-6zm2 2h2v2h-2zM4 14h6v6H4zm2 2h2v2H6zm8 0h4v2h-4zm2 2h2v2h-2zm2 2h2v2h-2zm-6-2h2v2h-2zm0 4h4v2h-4zm6-2h2v2h-2zm-4-6h2v2h-2z',
  },
  {
    id: 'usdt-tron',
    nameKey: 'donation_tier_tron_name',
    taglineKey: 'donation_tier_tron_tag',
    amountLabel: '10+ USDT (TRC-20)',
    symbol: 'USDT (TRC-20)',
    network: 'TRON Network (TRC-20 / zero dust)',
    address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    accent: '#FF0055',
    glow: 'rgba(255, 0, 85, 0.4)',
    qrSvg: 'M4 4h6v6H4zm2 2h2v2H6zm8-2h6v6h-6zm2 2h2v2h-2zM4 14h6v6H4zm2 2h2v2H6zm8 4h2v2h-2zm2-2h2v2h-2zm2 4h2v2h-2zm-4-4h2v2h-2zm6-2h2v2h-2zm-2-2h2v2h-2zm4 4h2v2h-2zm-6 2h2v2h-2z',
  },
];

const STORAGE_VIP_KEY = 'nv_pet_vip';

export function DonationModal({ open, onClose, onAscension }: DonationModalProps) {
  const { t } = useTranslation();
  const [activeTier, setActiveTier] = useState<string>('eth');
  const [copied, setCopied] = useState<boolean>(false);
  const [ascended, setAscended] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_VIP_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [qrZoomed, setQrZoomed] = useState<boolean>(false);
  const titleId = useId();

  const tier = CRYPTO_TIERS.find((t) => t.id === activeTier) ?? CRYPTO_TIERS[0];

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (qrZoomed) setQrZoomed(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, qrZoomed, onClose]);

  // Copy address to clipboard
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(tier.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      /* ignore */
    }
  }, [tier.address]);

  // Unlock Syndicate Patron VIP status
  const handleAscend = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_VIP_KEY, 'true');
    } catch {
      /* ignore */
    }
    setAscended(true);
    onAscension?.();
  }, [onAscension]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-md overflow-y-auto animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="relative w-full max-w-2xl my-auto bg-[#0A0E0B] border border-[#1A2E1A] rounded-2xl shadow-[0_0_50px_rgba(89,255,0,0.15)] overflow-hidden text-textMain"
        style={{
          boxShadow: `0 0 60px ${tier.glow}, 0 20px 40px rgba(0,0,0,0.8)`,
        }}
      >
        {/* Top cyberpunk neon laser accent */}
        <div
          className="h-1 w-full transition-colors duration-500"
          style={{
            background: `linear-gradient(90deg, transparent, ${tier.accent}, transparent)`,
          }}
        />

        {/* Header */}
        <div className="flex items-start justify-between p-5 pb-3 border-b border-[#1A2E1A]/80">
          <div className="flex items-center gap-3">
            <div
              className="p-2.5 rounded-xl border flex items-center justify-center"
              style={{
                backgroundColor: `${tier.accent}15`,
                borderColor: `${tier.accent}40`,
                color: tier.accent,
              }}
            >
              <HeartHandshake size={22} className="animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id={titleId} className="text-lg font-bold tracking-tight text-textMain">
                  {t('donation_modal_title')}
                </h2>
                <span
                  className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full uppercase tracking-wider border"
                  style={{
                    backgroundColor: `${tier.accent}15`,
                    borderColor: `${tier.accent}50`,
                    color: tier.accent,
                  }}
                >
                  {t('donation_modal_badge')}
                </span>
              </div>
              <p className="text-xs text-textMuted mt-0.5">{t('donation_modal_subtitle')}</p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label={t('close_menu')}
            className="p-1.5 rounded-lg text-textMuted hover:text-textMain hover:bg-white/5 transition-colors cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-5">
          {/* VIP Perks Hero Banner */}
          <div className="relative p-4 rounded-xl bg-gradient-to-r from-[#0F1B12] via-[#0D2214] to-[#0A160E] border border-nvidia/30 overflow-hidden">
            <div className="flex items-start justify-between gap-3 relative z-10">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-bold text-accent-neon tracking-wide uppercase">
                  <Sparkles size={14} className="animate-spin text-accent-neon" style={{ animationDuration: '6s' }} />
                  <span>{t('donation_vip_banner_title')}</span>
                </div>
                <p className="text-xs text-[#A0B8A4] leading-relaxed max-w-md">
                  {t('donation_vip_banner_desc')}
                </p>
              </div>

              {!ascended ? (
                <button
                  type="button"
                  onClick={handleAscend}
                  className="px-3.5 py-2 rounded-xl text-xs font-bold bg-accent-neon text-bg hover:brightness-110 shadow-[0_0_15px_rgba(89,255,0,0.4)] transition-all cursor-pointer shrink-0 flex items-center gap-1.5"
                >
                  <Sparkles size={13} />
                  <span>{t('donation_claim_vip_btn')}</span>
                </button>
              ) : (
                <div className="px-3 py-1.5 rounded-xl text-[11px] font-mono font-bold bg-nvidia/20 border border-nvidia text-accent-neon shrink-0 flex items-center gap-1.5">
                  <Check size={13} />
                  <span>{t('donation_vip_active')}</span>
                </div>
              )}
            </div>
          </div>

          {/* Crypto Network Selector Tabs */}
          <div>
            <label className="block text-[11px] font-mono font-bold uppercase tracking-wider text-textMuted mb-2">
              {t('donation_select_network')}
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {CRYPTO_TIERS.map((item) => {
                const isActive = item.id === activeTier;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTier(item.id);
                      setCopied(false);
                    }}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer relative overflow-hidden ${
                      isActive
                        ? 'bg-surface border-opacity-100 shadow-md font-semibold'
                        : 'bg-surface/40 border-border/60 text-textMuted hover:text-textMain hover:border-border'
                    }`}
                    style={
                      isActive
                        ? {
                            borderColor: item.accent,
                            boxShadow: `0 0 16px ${item.glow}`,
                          }
                        : undefined
                    }
                  >
                    {isActive && (
                      <div
                        className="absolute top-0 left-0 right-0 h-0.5"
                        style={{ backgroundColor: item.accent }}
                      />
                    )}
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span
                        className="text-xs font-bold"
                        style={{ color: isActive ? item.accent : undefined }}
                      >
                        {item.symbol.split('/')[0].trim()}
                      </span>
                      {isActive && <Check size={12} style={{ color: item.accent }} />}
                    </div>
                    <div className="text-[10px] text-textMuted truncate font-mono">
                      {item.amountLabel}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Selected Tier Card & QR Code */}
          <div
            className="p-4 sm:p-5 rounded-2xl border bg-surface/70 backdrop-blur space-y-4 transition-all"
            style={{
              borderColor: `${tier.accent}50`,
            }}
          >
            {/* Header info */}
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-border/60">
              <div>
                <div className="text-xs font-bold text-textMain">{t(tier.nameKey)}</div>
                <div className="text-[11px] text-textMuted">{t(tier.taglineKey)}</div>
              </div>
              <span
                className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-md border"
                style={{
                  color: tier.accent,
                  borderColor: `${tier.accent}50`,
                  backgroundColor: `${tier.accent}10`,
                }}
              >
                {tier.network}
              </span>
            </div>

            {/* QR Code + Address Block */}
            <div className="flex flex-col sm:flex-row items-center gap-4">
              {/* Scalable High-contrast Cyber QR Visualizer */}
              <div
                onClick={() => setQrZoomed(true)}
                className="relative p-2.5 rounded-xl bg-white border-2 cursor-zoom-in group shrink-0 transition-transform hover:scale-105"
                style={{ borderColor: tier.accent }}
                title={t('donation_click_zoom_qr')}
              >
                {/* Visual SVG QR Matrix */}
                <svg
                  viewBox="0 0 24 24"
                  className="w-24 h-24 text-[#0A0E0B]"
                  fill="currentColor"
                >
                  {/* Outer corner positioning squares */}
                  <rect x="2" y="2" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <rect x="4" y="4" width="3" height="3" />
                  <rect x="15" y="2" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <rect x="17" y="4" width="3" height="3" />
                  <rect x="2" y="15" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <rect x="4" y="17" width="3" height="3" />
                  {/* Dynamic matrix payload path */}
                  <path d={tier.qrSvg} fill="currentColor" />
                  <circle cx="12" cy="12" r="1.5" fill={tier.accent} />
                </svg>

                {/* Cyberpunk Scan Line overlay */}
                <div className="absolute inset-x-2.5 h-0.5 bg-gradient-to-r from-transparent via-red-500 to-transparent nv-donation-laser pointer-events-none" />

                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center rounded-xl transition-opacity">
                  <QrCode size={20} className="text-white" />
                </div>
              </div>

              {/* Address input & Copy Action */}
              <div className="min-w-0 flex-1 w-full space-y-2">
                <div>
                  <label className="block text-[10px] font-mono uppercase tracking-wider text-textMuted mb-1">
                    {t('donation_destination_address')} ({tier.symbol})
                  </label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 p-2.5 rounded-xl bg-bg border border-border font-mono text-xs text-textMain break-all select-all focus:border-accent-neon outline-none">
                      {tier.address}
                    </code>
                    <button
                      type="button"
                      onClick={handleCopy}
                      className="px-3.5 py-2.5 rounded-xl text-xs font-bold border transition-all cursor-pointer shrink-0 flex items-center gap-1.5 animate-tactile-tick"
                      style={{
                        backgroundColor: copied ? `${tier.accent}20` : `${tier.accent}15`,
                        borderColor: copied ? tier.accent : `${tier.accent}50`,
                        color: tier.accent,
                      }}
                      aria-label={t('copy')}
                    >
                      {copied ? (
                        <>
                          <Check size={14} />
                          <span>{t('copied')}</span>
                        </>
                      ) : (
                        <>
                          <Copy size={14} />
                          <span>{t('copy')}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                <p className="text-[11px] text-textMuted leading-relaxed">
                  {t('donation_support_note')}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Footer info & GitHub repo link */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-5 pt-3 border-t border-[#1A2E1A]/80 bg-[#080B09] text-xs text-textMuted">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-accent-neon animate-pulse" />
            <span>{t('donation_transparency_note')}</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void window.electronAPI.openExternal(
                  'https://github.com/HaYkMnE/NV-Gateway'
                );
              }}
              className="inline-flex items-center gap-1 text-textMuted hover:text-accent-neon transition-colors cursor-pointer"
            >
              <span>{t('donation_github_sponsor')}</span>
              <ExternalLink size={12} />
            </button>
            <span className="opacity-40">·</span>
            <button
              type="button"
              onClick={onClose}
              className="text-textMuted hover:text-textMain transition-colors cursor-pointer"
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      </div>

      {/* QR Zoom Modal Backdrop */}
      {qrZoomed && (
        <div
          className="fixed inset-0 z-60 bg-black/90 flex items-center justify-center p-4 cursor-zoom-out animate-fade-in"
          onClick={() => setQrZoomed(false)}
        >
          <div
            className="p-6 bg-white rounded-3xl border-4 max-w-xs text-center space-y-3"
            style={{ borderColor: tier.accent }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-xs font-mono font-bold text-[#0A0E0B] uppercase">
              {tier.symbol} QR Matrix
            </div>
            <svg
              viewBox="0 0 24 24"
              className="w-56 h-56 text-[#0A0E0B] mx-auto"
              fill="currentColor"
            >
              <rect x="2" y="2" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <rect x="4" y="4" width="3" height="3" />
              <rect x="15" y="2" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <rect x="17" y="4" width="3" height="3" />
              <rect x="2" y="15" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <rect x="4" y="17" width="3" height="3" />
              <path d={tier.qrSvg} fill="currentColor" />
              <circle cx="12" cy="12" r="1.5" fill={tier.accent} />
            </svg>
            <div className="font-mono text-[10px] text-gray-700 break-all select-all">
              {tier.address}
            </div>
            <button
              type="button"
              onClick={() => setQrZoomed(false)}
              className="w-full py-2 bg-[#0A0E0B] text-white text-xs font-bold rounded-xl"
            >
              {t('close_menu')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
