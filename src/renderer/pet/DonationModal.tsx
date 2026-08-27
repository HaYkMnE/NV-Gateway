import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { audioEngine } from './audioEngine';
import './donation-modal.css';

interface DonationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDonationComplete?: () => void;
}

interface CryptoAddress {
  coin: string;
  network: string;
  address: string;
  tag?: string;
  qrPayload: string;
  accent: string;
}

const cryptoList: CryptoAddress[] = [
  {
    coin: 'USDT (TRC-20)',
    network: 'TRON TRC20',
    address: 'TA4WvUvE6tV1z1m7Vn8P3a2mC1qE9xZ4w8',
    qrPayload: 'tron:TA4WvUvE6tV1z1m7Vn8P3a2mC1qE9xZ4w8',
    accent: '#00F0FF',
  },
  {
    coin: 'USDT (TON)',
    network: 'TON Network',
    address: 'EQBvW8m53GoU_9q2mC1qE9xZ4w8TA4WvUvE6tV1z1m7Vn8P3',
    qrPayload: 'ton://transfer/EQBvW8m53GoU_9q2mC1qE9xZ4w8TA4WvUvE6tV1z1m7Vn8P3',
    accent: '#0098EA',
  },
  {
    coin: 'TON (The Open Network)',
    network: 'TON Native',
    address: 'EQBvW8m53GoU_9q2mC1qE9xZ4w8TA4WvUvE6tV1z1m7Vn8P3',
    qrPayload: 'ton://transfer/EQBvW8m53GoU_9q2mC1qE9xZ4w8TA4WvUvE6tV1z1m7Vn8P3',
    accent: '#0098EA',
  },
  {
    coin: 'SOL (Solana)',
    network: 'Solana Native',
    address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    qrPayload: 'solana:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    accent: '#9945FF',
  },
  {
    coin: 'BTC (Bitcoin)',
    network: 'Bitcoin Native',
    address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    qrPayload: 'bitcoin:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    accent: '#F7931A',
  },
  {
    coin: 'ETH (Ethereum)',
    network: 'ERC-20 / EVM',
    address: '0x71C83a80F4F468757799f5d710e97669d031B326',
    qrPayload: 'ethereum:0x71C83a80F4F468757799f5d710e97669d031B326',
    accent: '#627EEA',
  },
];

export const DonationModal: React.FC<DonationModalProps> = ({
  isOpen,
  onClose,
  onDonationComplete,
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'crypto' | 'world' | 'rucis' | 'stars'>('crypto');
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [activeQr, setActiveQr] = useState<CryptoAddress | null>(null);
  const [isConfirmed, setIsConfirmed] = useState(false);

  if (!isOpen) return null;

  const copyToClipboard = (text: string) => {
    try {
      navigator.clipboard.writeText(text);
      setCopiedAddress(text);
      audioEngine.playCoinDrop();
      setTimeout(() => setCopiedAddress(null), 2500);
    } catch {}
  };

  const handleConfirm = () => {
    setIsConfirmed(true);
    audioEngine.playLevelUp();
    if (onDonationComplete) {
      onDonationComplete();
    }
    setTimeout(() => {
      setIsConfirmed(false);
      onClose();
    }, 2200);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-fadeIn"
      role="dialog"
      aria-modal="true"
      aria-labelledby="donation-modal-title"
    >
      <div className="relative w-full max-w-xl bg-[#0b0f12] border border-[#59FF00]/40 rounded-xl p-6 shadow-[0_0_50px_rgba(89,255,0,0.15)] flex flex-col max-h-[90vh]">
        {/* Top Header */}
        <div className="flex items-start justify-between pb-4 border-b border-[#59FF00]/20">
          <div className="flex items-center gap-3">
            <span className="text-2xl animate-bounce">☕</span>
            <div>
              <h2 id="donation-modal-title" className="text-lg font-bold text-[#59FF00] tracking-wider uppercase">
                {t('pet_donation_title', 'SUPPORT NV-GATEWAY')}
              </h2>
              <p className="text-xs text-neutral-400 font-mono">
                {t('pet_donation_tagline', '// choose a channel — every byte fuels community AI compute')}
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              audioEngine.playKeyClick();
              onClose();
            }}
            className="text-neutral-400 hover:text-white p-1 rounded-lg hover:bg-white/5 transition"
            aria-label={t('pet_donation_close_aria', 'Close donation modal')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Tab Selector */}
        <div className="flex items-center gap-2 pt-4 pb-2 border-b border-neutral-800" role="tablist" aria-label={t('pet_donation_tabs_aria', 'Donation channels')}>
          {(['crypto', 'world', 'rucis', 'stars'] as const).map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => {
                audioEngine.playKeyClick();
                setActiveTab(tab);
              }}
              className={`px-3 py-1.5 rounded text-xs font-mono font-semibold uppercase tracking-wider transition ${
                activeTab === tab
                  ? 'bg-[#59FF00]/20 text-[#59FF00] border border-[#59FF00]/50'
                  : 'text-neutral-400 hover:text-neutral-200 bg-white/5 border border-transparent'
              }`}
            >
              {tab === 'crypto' && t('pet_tab_crypto', 'Crypto')}
              {tab === 'world' && t('pet_tab_world', 'Support')}
              {tab === 'rucis' && t('pet_tab_rucis', 'RU-CIS')}
              {tab === 'stars' && t('pet_tab_stars', 'Telegram Stars')}
            </button>
          ))}
        </div>

        {/* Tab Body */}
        <div className="flex-1 overflow-y-auto py-4 space-y-3 donation-scrollbar">
          {activeTab === 'crypto' && (
            <div className="space-y-3">
              {cryptoList.map((item) => (
                <div
                  key={item.coin}
                  className="p-3 bg-neutral-900/80 border border-neutral-800 rounded-lg hover:border-[#59FF00]/40 transition group"
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: item.accent }}
                      />
                      <span className="font-bold text-xs text-neutral-200 font-mono">
                        {item.coin}
                      </span>
                      <span className="text-[10px] text-neutral-500 font-mono">
                        [{item.network}]
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          audioEngine.playKeyClick();
                          setActiveQr(item);
                        }}
                        className="text-[10px] font-mono text-neutral-400 hover:text-[#59FF00] px-2 py-0.5 rounded bg-white/5 border border-neutral-700 hover:border-[#59FF00]/50 transition"
                        title={t('pet_qr_scan_hint', 'Click to enlarge & scan')}
                        aria-label={t('pet_qr_enlarge_aria', { label: item.coin, defaultValue: `Enlarge QR code for ${item.coin}` })}
                      >
                        {t('pet_qr_scan_badge', 'SCAN')}
                      </button>
                      <button
                        onClick={() => copyToClipboard(item.address)}
                        className={`text-[10px] font-mono px-2 py-0.5 rounded transition ${
                          copiedAddress === item.address
                            ? 'bg-[#59FF00] text-black font-bold'
                            : 'bg-neutral-800 text-neutral-300 hover:text-white hover:bg-neutral-700'
                        }`}
                      >
                        {copiedAddress === item.address
                          ? t('pet_copied', 'COPIED')
                          : t('pet_copy', 'COPY')}
                      </button>
                    </div>
                  </div>
                  <div className="text-[11px] font-mono text-neutral-400 break-all select-all bg-black/40 p-1.5 rounded border border-neutral-800/80">
                    {item.address}
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'world' && (
            <div className="space-y-4 text-center py-4">
              <div className="p-4 bg-neutral-900 border border-neutral-800 rounded-lg text-left space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-sm text-neutral-200 font-mono">
                    Buy Me a Coffee / Ko-fi
                  </span>
                  <a
                    href="https://ko-fi.com"
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => audioEngine.playKeyClick()}
                    className="text-xs font-mono bg-[#59FF00]/20 text-[#59FF00] border border-[#59FF00]/40 px-3 py-1 rounded hover:bg-[#59FF00]/30 transition"
                  >
                    {t('pet_open_link', 'OPEN ↗')}
                  </a>
                </div>
                <p className="text-xs text-neutral-400">
                  Global cards, PayPal, Apple Pay, Google Pay support.
                </p>
              </div>

              <div className="p-4 bg-neutral-900 border border-neutral-800 rounded-lg text-left space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-sm text-neutral-200 font-mono">
                    GitHub Sponsors
                  </span>
                  <a
                    href="https://github.com/sponsors"
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => audioEngine.playKeyClick()}
                    className="text-xs font-mono bg-[#59FF00]/20 text-[#59FF00] border border-[#59FF00]/40 px-3 py-1 rounded hover:bg-[#59FF00]/30 transition"
                  >
                    {t('pet_open_link', 'OPEN ↗')}
                  </a>
                </div>
                <p className="text-xs text-neutral-400">
                  Direct GitHub sponsor badge & perpetual contributor hall of fame.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'rucis' && (
            <div className="space-y-3">
              <div className="p-4 bg-neutral-900 border border-neutral-800 rounded-lg space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-neutral-200 font-mono">
                    СБП / Т-Банк / Сбербанк (RU)
                  </span>
                  <button
                    onClick={() => copyToClipboard('+79990000000')}
                    className="text-xs font-mono bg-[#59FF00]/20 text-[#59FF00] border border-[#59FF00]/40 px-3 py-1 rounded hover:bg-[#59FF00]/30 transition"
                  >
                    {copiedAddress === '+79990000000'
                      ? t('pet_copied', 'COPIED')
                      : t('pet_copy', 'COPY')}
                  </button>
                </div>
                <div className="text-xs font-mono text-neutral-400 bg-black/40 p-2 rounded">
                  Номер для перевода СБП: +7 (999) 000-00-00 (любой банк РФ)
                </div>
              </div>

              <div className="p-4 bg-neutral-900 border border-neutral-800 rounded-lg space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-neutral-200 font-mono">
                    CloudTips / Boosty
                  </span>
                  <a
                    href="https://boosty.to"
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => audioEngine.playKeyClick()}
                    className="text-xs font-mono bg-[#59FF00]/20 text-[#59FF00] border border-[#59FF00]/40 px-3 py-1 rounded hover:bg-[#59FF00]/30 transition"
                  >
                    {t('pet_open_link', 'OPEN ↗')}
                  </a>
                </div>
                <p className="text-xs text-neutral-400">
                  Оплата картами МИР, СБП, ЮMoney, зарубежными картами СНГ.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'stars' && (
            <div className="p-6 bg-neutral-900 border border-neutral-800 rounded-lg text-center space-y-4">
              <span className="text-4xl animate-pulse inline-block">⭐</span>
              <h3 className="font-bold text-sm text-neutral-200 font-mono">
                Telegram Stars Bot
              </h3>
              <p className="text-xs text-neutral-400 max-w-sm mx-auto">
                Direct in-app Telegram Stars micro-donations directly supporting NV-Gateway community cluster.
              </p>
              <a
                href="https://t.me"
                target="_blank"
                rel="noreferrer"
                onClick={() => audioEngine.playKeyClick()}
                className="inline-block px-4 py-2 rounded bg-gradient-to-r from-amber-500 to-yellow-400 text-black font-bold font-mono text-xs hover:brightness-110 transition shadow-lg"
              >
                OPEN TELEGRAM STARS BOT ↗
              </a>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="pt-4 border-t border-[#59FF00]/20 flex items-center justify-between">
          <span className="text-[11px] font-mono text-[#59FF00]/70">
            {t('pet_vip_note', '// INSTANT VIP ACCESS ON CONFIRMATION')}
          </span>
          <button
            onClick={handleConfirm}
            disabled={isConfirmed}
            className={`px-4 py-2 rounded font-mono font-bold text-xs uppercase tracking-wider transition ${
              isConfirmed
                ? 'bg-[#59FF00] text-black shadow-[0_0_20px_#59FF00]'
                : 'bg-[#59FF00]/20 hover:bg-[#59FF00]/30 text-[#59FF00] border border-[#59FF00]/60'
            }`}
          >
            {isConfirmed
              ? t('pet_thanks', 'THANK YOU, FRIEND!')
              : t('pet_qr_confirm', 'I SCANNED / SENT DONATION')}
          </button>
        </div>

        {/* QR Code Fullscreen Overlay */}
        {activeQr && (
          <div
            className="donation-qr-overlay absolute inset-0 z-20 bg-black/95 rounded-xl p-6 flex flex-col items-center justify-center space-y-4"
            role="dialog"
            aria-modal="true"
            aria-label={t('pet_qr_overlay_aria', { label: activeQr.coin, defaultValue: `Scan QR code for ${activeQr.coin}` })}
          >
            <div className="flex items-center justify-between w-full">
              <span className="text-xs font-mono text-[#59FF00] font-bold">
                {activeQr.coin} [{activeQr.network}]
              </span>
              <button
                onClick={() => setActiveQr(null)}
                className="text-neutral-400 hover:text-white p-1"
                aria-label={t('pet_qr_close_aria', 'Close QR scan view')}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Generated clean SVG QR Representation */}
            <div className="p-4 bg-white rounded-lg shadow-[0_0_30px_rgba(255,255,255,0.2)]">
              <svg
                width="160"
                height="160"
                viewBox="0 0 33 33"
                className="donation-qr-canvas"
                shapeRendering="crispEdges"
              >
                {/* SVG mock QR pattern */}
                <rect width="33" height="33" fill="#ffffff" />
                <path
                  d="M0 0h7v7H0zM2 2h3v3H2zM26 0h7v7h-7zM28 2h3v3h-3zM0 26h7v7H0zM2 28h3v3H2zM10 2h2v2h-2zM14 2h4v2h-4zM20 2h2v2h-2zM10 6h4v2h-4zM16 6h2v2h-2zM2 10h2v4H2zM6 10h2v2H6zM10 10h4v2h-4zM16 10h2v4h-2zM20 10h4v2h-4zM26 10h2v2h-2zM30 10h2v4h-2zM2 16h4v2H2zM8 16h2v2H8zM12 16h6v2h-6zM20 16h2v2h-2zM24 16h4v2h-4zM2 20h2v4H2zM6 20h2v2H6zM10 20h2v2h-2zM14 20h4v2h-4zM20 20h2v4h-2zM24 20h2v2h-2zM28 20h4v2h-4zM10 24h4v2h-4zM16 24h2v2h-2zM24 24h2v4h-2zM28 24h2v2h-2zM10 28h2v4h-2zM14 28h4v2h-4zM20 28h2v2h-2zM28 28h4v4h-4z"
                  fill="#000000"
                />
              </svg>
            </div>

            <p className="text-[11px] font-mono text-neutral-400 text-center max-w-xs break-all select-all">
              {activeQr.address}
            </p>

            <div className="flex gap-2">
              <button
                onClick={() => copyToClipboard(activeQr.address)}
                className="px-3 py-1.5 bg-[#59FF00]/20 border border-[#59FF00]/50 text-[#59FF00] rounded font-mono text-xs hover:bg-[#59FF00]/30 transition"
              >
                {t('pet_copy', 'COPY')}
              </button>
              <button
                onClick={() => {
                  setActiveQr(null);
                  handleConfirm();
                }}
                className="px-3 py-1.5 bg-[#59FF00] text-black font-bold rounded font-mono text-xs hover:brightness-110 transition"
              >
                {t('pet_qr_confirm', 'I SCANNED / SENT DONATION')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
