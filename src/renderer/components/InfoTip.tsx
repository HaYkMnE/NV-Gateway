import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';

/**
 * Settings info-tooltip (wave 6C, design-lead spec §4).
 *
 * - A 24x24 icon button, described by an ALWAYS-rendered role="tooltip" box
 *   that is toggled with `hidden` (accname 1.2 still uses a hidden element as
 *   the description, so the text is announced on focus).
 * - Opens on focus or hover; a click toggles; the absolutely positioned box
 *   sits under a 4px padding bridge INSIDE the hover wrapper, so moving the
 *   pointer onto it keeps it open; blur or leaving the wrapper closes it.
 * - Escape is handled on the button (stopPropagation). While it is open from
 *   HOVER only, a document keydown listener lets Escape dismiss it without
 *   focus (added/removed in an effect, the Layout.tsx menu pattern).
 * - No radius, shadow or animation; forced-colors keeps a CanvasText border
 *   and the icon uses currentColor.
 */
export type InfoTipSource = 'focus' | 'hover' | 'click' | null;
export type InfoTipEvent = 'focus' | 'hover' | 'click' | 'blur' | 'leave' | 'escape';

/** Pure open/close transition: the source is what opened the tip (null = closed). */
export function nextInfoTip(source: InfoTipSource, event: InfoTipEvent): InfoTipSource {
  switch (event) {
    case 'focus':
    case 'hover':
      return source ?? event;
    case 'click':
      return source === 'click' ? null : 'click';
    default:
      return null;
  }
}

export interface InfoTipProps {
  /** Visible name of the setting; the button is labelled "More about {name}". */
  name: string;
  /** Which edge of the anchor the box aligns to (logical). */
  side?: 'start' | 'end';
  children: ReactNode;
}

export function InfoTip({ name, side = 'start', children }: InfoTipProps) {
  const { t } = useTranslation();
  const id = useId();
  const [source, setSource] = useState<InfoTipSource>(null);
  const open = source !== null;

  useEffect(() => {
    if (source !== 'hover') return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSource(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [source]);

  return (
    <div
      className="relative inline-flex"
      onPointerEnter={(event) => { if (event.pointerType !== 'touch') setSource((s) => nextInfoTip(s, 'hover')); }}
      onPointerLeave={(event) => { if (event.pointerType !== 'touch') setSource((s) => nextInfoTip(s, 'leave')); }}
    >
      <button
        type="button"
        aria-describedby={id}
        aria-label={t('infotip_label', { name })}
        className="inline-flex h-6 w-6 items-center justify-center text-textMuted hover:text-accent-neon"
        onFocus={() => setSource((s) => nextInfoTip(s, 'focus'))}
        onBlur={() => setSource((s) => nextInfoTip(s, 'blur'))}
        onClick={() => setSource((s) => nextInfoTip(s, 'click'))}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation();
            setSource(null);
          }
        }}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      <div className={`absolute top-full ${side === 'end' ? 'end-0' : 'start-0'} z-10 pt-1`}>
        <div id={id} role="tooltip" hidden={!open} className="w-max [max-inline-size:min(280px,calc(100vw_-_2rem))] bg-bg border border-border text-textMain text-[13px] leading-[19px] px-3 py-2 forced-colors:border-[color:CanvasText]">
          {children}
        </div>
      </div>
    </div>
  );
}
