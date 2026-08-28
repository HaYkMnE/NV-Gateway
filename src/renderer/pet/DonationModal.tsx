import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import QRCode from 'qrcode';
import { petAudio } from './audioEngine';
import './donation-modal.css';

export interface DonationModalProps {
  open: boolean;
  onClose: () => void;
  onAscension?: () => void;
}

type TabKey = 'crypto' | 'world';

interface DonationRow {
  id: string;
  label: string;
  value: string;
  display?: string;
  qr?: string;
  url?: string;
}

const TABS: ReadonlyArray<{ key: TabKey }> = [
  { key: 'crypto' },
  { key: 'world' },
];

const BTC_ADDRESS = 'bc1qmle5479683zdggfd0d3qfzm08dcff3dd8zufw5';
const EVM_ADDRESS = '0xEf3Ab19B35d770293107c1e54d8a6d5f1c6d00bA';
const SOL_ADDRESS = '2r7bD3n3yoRPCPg1bjDaJ7nxcE7oMwJy5cRVu5XsrZgG';
const TRON_ADDRESS = 'TPoeenevUvRwcTfXmCFweGVSbH37hiZpmr';
const TON_ADDRESS = 'UQCirhEjqFkjA8CAQcypCkFOBSOUooNKBTVHgiBikDRUhBGZ';

function truncateAddress(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

const PANEL_ROWS: Record<TabKey, ReadonlyArray<DonationRow>> = {
  crypto: [
    {
      id: 'btc',
      label: 'Bitcoin — BTC',
      value: BTC_ADDRESS,
      display: truncateAddress(BTC_ADDRESS),
      qr: `bitcoin:${BTC_ADDRESS}`,
    },
    {
      id: 'eth',
      label: 'Ethereum — ETH / USDT (ERC-20)',
      value: EVM_ADDRESS,
      display: truncateAddress(EVM_ADDRESS),
      qr: `ethereum:${EVM_ADDRESS}@1`,
    },
    {
      id: 'bsc',
      label: 'BNB Smart Chain — BNB / USDT (BEP-20)',
      value: EVM_ADDRESS,
      display: truncateAddress(EVM_ADDRESS),
      qr: `ethereum:${EVM_ADDRESS}@56`,
    },
    {
      id: 'sol',
      label: 'Solana — SOL / USDT',
      value: SOL_ADDRESS,
      display: truncateAddress(SOL_ADDRESS),
      qr: `solana:${SOL_ADDRESS}`,
    },
    {
      id: 'tron',
      label: 'Tron — USDT (TRC-20)',
      value: TRON_ADDRESS,
      display: truncateAddress(TRON_ADDRESS),
      qr: TRON_ADDRESS,
    },
    {
      id: 'ton',
      label: 'TON — TON',
      value: TON_ADDRESS,
      display: truncateAddress(TON_ADDRESS),
      qr: `ton://transfer/${TON_ADDRESS}`,
    },
  ],
  world: [
    {
      id: 'kofi',
      label: 'Ko-fi',
      value: 'https://ko-fi.com/haykmne',
      display: 'ko-fi.com/haykmne',
      url: 'https://ko-fi.com/haykmne',
      qr: 'https://ko-fi.com/haykmne',
    },
    {
      id: 'patreon',
      label: 'Patreon',
      value: 'https://www.patreon.com/c/HaYkMnE',
      display: 'patreon.com/c/HaYkMnE',
      url: 'https://www.patreon.com/c/HaYkMnE',
      qr: 'https://www.patreon.com/c/HaYkMnE',
    },
    {
      id: 'tribute',
      label: 'Tribute (Telegram)',
      value: 'https://t.me/tribute/app?startapp=ep_7qt3bDGDd36LHQg4oAifvcqXhzifEM9RF0TMtb54EZbJQOdZX0',
      display: 't.me/tribute/app?startapp=…',
      url: 'https://t.me/tribute/app?startapp=ep_7qt3bDGDd36LHQg4oAifvcqXhzifEM9RF0TMtb54EZbJQOdZX0',
      qr: 'https://t.me/tribute/app?startapp=ep_7qt3bDGDd36LHQg4oAifvcqXhzifEM9RF0TMtb54EZbJQOdZX0',
    },
  ],
};

function copyViaExecCommand(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch {}
  ta.remove();
}

function copyText(text: string): void {
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => copyViaExecCommand(text));
  } else {
    copyViaExecCommand(text);
  }
}

function QrGlyph({ size }: { size: number }): React.JSX.Element {
  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 44 44"
      aria-hidden="true"
      className="block h-full w-full"
      style={{ maxWidth: size, maxHeight: size }}
    >
      <rect x="2" y="2" width="40" height="40" rx="4" fill="#ECEFF2" />
      <rect
        x="2"
        y="2"
        width="40"
        height="40"
        rx="4"
        fill="none"
        stroke="#324458"
        strokeWidth="1.5"
        strokeDasharray="4 3"
      />
      <g fill="#14181D">
        <rect x="7" y="7" width="9" height="9" />
        <rect x="28" y="7" width="9" height="9" />
        <rect x="7" y="28" width="9" height="9" />
        <rect x="20" y="20" width="4" height="4" />
        <rect x="29" y="29" width="5" height="5" />
        <rect x="35" y="21" width="3" height="3" />
        <rect x="21" y="31" width="3" height="3" />
        <rect x="27" y="20" width="2" height="2" />
        <rect x="31" y="24" width="2" height="2" />
      </g>
      <g fill="#ECEFF2">
        <rect x="10" y="10" width="3" height="3" />
        <rect x="31" y="10" width="3" height="3" />
        <rect x="10" y="31" width="3" height="3" />
      </g>
    </svg>
  );
}

interface ParsedQrSvg {
  viewBox: string;
  paths: ReadonlyArray<{ d: string; fill?: string; stroke?: string }>;
}

function parseQrSvg(markup: string): ParsedQrSvg | null {
  const viewBoxMatch = /<svg\b[^>]*\bviewBox="([^"]+)"/.exec(markup);
  if (viewBoxMatch === null) return null;
  const paths: Array<{ d: string; fill?: string; stroke?: string }> = [];
  const pathRe = /<path\b[^>]*>/g;
  let pathTag: RegExpExecArray | null;
  while ((pathTag = pathRe.exec(markup)) !== null) {
    const dMatch = /\bd="([^"]+)"/.exec(pathTag[0]);
    const fillMatch = /\bfill="(#[0-9A-Fa-f]{3,8})"/.exec(pathTag[0]);
    const strokeMatch = /\bstroke="(#[0-9A-Fa-f]{3,8})"/.exec(pathTag[0]);
    if (dMatch === null) return null;
    paths.push({ d: dMatch[1], fill: fillMatch?.[1], stroke: strokeMatch?.[1] });
  }
  if (paths.length === 0) return null;
  return { viewBox: viewBoxMatch[1], paths };
}

function CryptoQr({ payload, size }: { payload: string; size: number }): React.JSX.Element {
  const [qr, setQr] = useState<ParsedQrSvg | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(payload, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: size,
      color: { dark: '#14181D', light: '#ECEFF2' },
    })
      .then((markup) => {
        if (!cancelled) setQr(parseQrSvg(markup));
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [payload, size]);

  if (qr === null) {
    return <QrGlyph size={size} />;
  }
  return (
    <span
      className="block leading-none w-full h-full"
      style={{ maxWidth: size, maxHeight: size }}
      data-qr-payload={payload}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={qr.viewBox}
        width="100%"
        height="100%"
        aria-hidden="true"
        className="block h-full w-full"
      >
        {qr.paths.map((p, i) => (
          <path
            key={i}
            fill={p.fill ?? 'none'}
            stroke={p.stroke}
            strokeWidth={p.stroke !== undefined ? 1 : undefined}
            d={p.d}
          />
        ))}
      </svg>
    </span>
  );
}

function QrCorner({ pos }: { pos: 'tl' | 'tr' | 'bl' | 'br' }): React.JSX.Element {
  const cls: Record<typeof pos, string> = {
    tl: 'top-0 left-0 border-t-2 border-l-2',
    tr: 'top-0 right-0 border-t-2 border-r-2',
    bl: 'bottom-0 left-0 border-b-2 border-l-2',
    br: 'bottom-0 right-0 border-b-2 border-r-2',
  };
  return (
    <div aria-hidden="true" className={`absolute h-4 w-4 border-warning pointer-events-none ${cls[pos]}`} />
  );
}

export function DonationModal({ open, onClose, onAscension }: DonationModalProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabKey>('crypto');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [qrRow, setQrRow] = useState<DonationRow | null>(null);
  const [bubble, setBubble] = useState<string | null>(null);
  const bubbleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      setActiveTab('crypto');
      setCopiedId(null);
      setQrRow(null);
      setBubble(null);
    }
  }, [open]);

  useEffect(
    () => () => {
      if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (qrRow) setQrRow(null);
      else onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, qrRow, onClose]);

  const triggerAscension = useCallback((): void => {
    petAudio.playAscensionRitual();
    try {
      window.localStorage.setItem('nv_pet_vip', Date.now().toString());
    } catch {}
    setBubble(t('pet_thanks'));
    if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
    bubbleTimerRef.current = window.setTimeout(() => setBubble(null), 4000);
    onAscension?.();
  }, [onAscension, t]);

  const handleTabSwitch = useCallback((tab: TabKey): void => {
    setActiveTab(tab);
    petAudio.playActionCheer();
  }, []);

  const handleCopy = useCallback(
    (row: DonationRow): void => {
      copyText(row.value);
      setCopiedId(row.id);
      window.setTimeout(() => setCopiedId((current) => (current === row.id ? null : current)), 1000);
      triggerAscension();
    },
    [triggerAscension],
  );

  const openRowExternally = useCallback(
    (row: DonationRow): void => {
      void window.electronAPI?.openExternal(row.url ?? '');
      triggerAscension();
    },
    [triggerAscension],
  );

  const handleExternalLink = useCallback(
    (event_: React.MouseEvent<HTMLAnchorElement>, row: DonationRow): void => {
      event_.preventDefault();
      event_.stopPropagation();
      openRowExternally(row);
    },
    [openRowExternally],
  );

  if (!open) return null;

  const rows = PANEL_ROWS[activeTab];
  const activeTabLabel = t(`pet_tab_${activeTab}`);

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('pet_donation_title')}
        onMouseDown={onClose}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm font-sans"
      >
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="relative flex max-h-[90vh] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-accent-neon bg-bg shadow-glow-neon-strong p-6"
        >
          <div className="mb-3 flex items-start justify-between border-b border-border pb-3">
            <div>
              <h2 className="text-lg font-bold tracking-[2.5px] text-accent-neon drop-shadow-[0_0_12px_rgba(89,255,0,0.45)]">
                {t('pet_donation_title')}
              </h2>
              <p className="mt-1 font-mono text-[10px] tracking-wider text-textMuted">
                {t('pet_donation_tagline')}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('pet_donation_close_aria')}
              className="grid h-7 w-7 place-items-center rounded-md border border-border text-textMuted transition-colors hover:border-accent-neon hover:text-accent-neon"
            >
              <X aria-hidden size={14} />
            </button>
          </div>

          <div role="tablist" aria-label={t('pet_donation_tabs_aria')} className="mb-4 flex gap-1 border-b border-border">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.key}
                onClick={() => handleTabSwitch(tab.key)}
                className={`border-b-2 px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider transition-colors ${
                  activeTab === tab.key
                    ? 'border-accent-neon text-accent-neon'
                    : 'border-transparent text-textMuted hover:text-textMain'
                }`}
              >
                {t(`pet_tab_${tab.key}`)}
              </button>
            ))}
          </div>

          <div role="tabpanel" aria-label={activeTabLabel} className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto pr-1">
            {rows.map((row) => (
              <div
                key={row.id}
                onClick={
                  row.url !== undefined
                    ? () => openRowExternally(row)
                    : row.qr !== undefined
                      ? () => setQrRow(row)
                      : undefined
                }
                title={row.url !== undefined ? row.url : row.qr !== undefined ? t('pet_qr_scan_hint') : undefined}
                className={`grid grid-cols-[44px_1fr_auto] items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 transition-colors hover:border-accent-neon/40${
                  row.qr !== undefined ? ' cursor-pointer hover:bg-surface/70' : ''
                }`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setQrRow(row);
                  }}
                  aria-label={t('pet_qr_enlarge_aria', { label: row.label })}
                  title={t('pet_qr_scan_hint')}
                  className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-visible rounded-md border border-border-hard bg-[#E8ECEF] transition-transform hover:scale-110 hover:border-warning focus-visible:outline focus-visible:outline-2 focus-visible:outline-warning"
                >
                  {row.qr !== undefined ? <CryptoQr payload={row.qr} size={38} /> : <QrGlyph size={38} />}
                  <span className="absolute -bottom-1 -right-1 rounded-sm border border-warning bg-bg px-0.5 font-mono text-[6.5px] font-bold leading-none tracking-wide text-warning">
                    {t('pet_qr_scan_badge')}
                  </span>
                </button>

                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-textMain">{row.label}</span>
                  <span className="truncate font-mono text-xs text-textMuted" title={row.value}>
                    {row.display ?? row.value}
                  </span>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {row.url !== undefined && (
                    <a
                      href={row.url}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleExternalLink(e, row);
                      }}
                      className="rounded-md border border-border px-2 py-1 font-mono text-[11px] font-semibold text-textMain transition-colors hover:border-accent-neon hover:text-accent-neon"
                    >
                      {t('pet_open_link')}
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCopy(row);
                    }}
                    className={`min-w-[64px] rounded-md border px-2 py-1 font-mono text-[11px] font-semibold tracking-wide transition-colors ${
                      copiedId === row.id
                        ? 'border-success bg-success/10 text-success'
                        : 'border-border text-textMuted hover:border-accent-neon hover:text-accent-neon'
                    }`}
                  >
                    {copiedId === row.id ? t('pet_copied') : t('pet_copy')}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {bubble && (
            <div
              role="status"
              className="nv-donation-bubble pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 whitespace-nowrap rounded-full border border-accent-neon bg-bg px-4 py-1.5 font-mono text-xs font-bold tracking-widest text-accent-neon shadow-glow-neon"
            >
              {bubble}
            </div>
          )}
        </div>
      </div>

      {qrRow && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('pet_qr_overlay_aria', { label: qrRow.label })}
          onMouseDown={() => setQrRow(null)}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm font-sans"
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            className="flex w-full max-w-[min(92vw,480px)] max-h-[95vh] flex-col overflow-y-auto rounded-xl border border-warning/70 bg-bg p-4 shadow-[0_0_45px_rgba(250,204,21,0.25)]"
          >
            <div className="mb-2 flex items-start justify-between">
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-error" />
                <span className="font-mono text-[10px] font-bold tracking-wider text-warning">
                  {t('pet_qr_ready')}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setQrRow(null)}
                aria-label={t('pet_qr_close_aria')}
                className="grid h-7 w-7 place-items-center rounded-md border border-border text-textMuted transition-colors hover:border-warning hover:text-warning"
              >
                <X aria-hidden size={14} />
              </button>
            </div>

            <div className="mb-2 text-base font-bold tracking-wide text-textMain">{qrRow.label}</div>

            <div className="relative mx-auto mb-3 w-fit rounded-lg bg-[#ECEFF2] p-3">
              <QrCorner pos="tl" />
              <QrCorner pos="tr" />
              <QrCorner pos="bl" />
              <QrCorner pos="br" />
              <div
                className="relative"
                style={{ width: 'min(45vh, 380px)', height: 'min(45vh, 380px)' }}
                data-qr-big={qrRow.id}
              >
                {qrRow.qr !== undefined ? <CryptoQr payload={qrRow.qr} size={380} /> : <QrGlyph size={380} />}
                <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 nv-donation-laser">
                  <div className="h-[3px] w-full bg-error shadow-[0_0_12px_rgba(255,51,51,0.9)]" />
                </div>
              </div>
              <div className="mt-1.5 text-center font-mono text-[9px] tracking-widest text-[#6C8194]">
                {t('pet_qr_confirm_hint')}
              </div>
            </div>

            <div className="mx-auto mb-3 flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
              <span className="truncate font-mono text-xs text-textMuted" title={qrRow.value}>
                {qrRow.display ?? qrRow.value}
              </span>
              <button
                type="button"
                onClick={() => handleCopy(qrRow)}
                className={`ml-auto min-w-[64px] shrink-0 rounded-md border px-2 py-1 font-mono text-[11px] font-semibold tracking-wide transition-colors ${
                  copiedId === qrRow.id
                    ? 'border-success bg-success/10 text-success'
                    : 'border-border text-textMuted hover:border-warning hover:text-warning'
                }`}
              >
                {copiedId === qrRow.id ? t('pet_copied') : t('pet_copy')}
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                triggerAscension();
                setQrRow(null);
              }}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-warning px-4 py-2.5 font-mono text-xs font-bold tracking-wider text-black transition-opacity hover:opacity-90"
            >
              <span aria-hidden="true">⚡</span>
              <span>{t('pet_qr_confirm')}</span>
            </button>

            <div className="mt-2 text-center font-mono text-[9px] tracking-widest text-textMuted">
              {t('pet_vip_note')}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
