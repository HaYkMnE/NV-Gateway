import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Lightbulb, Send, X } from 'lucide-react';
import { api, queryKeys } from '../lib/api';
import { classifyDataState, safeError } from '../lib/frontend-state';
import { classifyScrollEvent, createLogsQueryPolicy, isNearBottom, shouldCancelAutoScroll } from '../lib/frontend-behavior';
import { useGatewayLifecycle } from '../lib/gateway-lifecycle';
import { useModal } from '../lib/modal-context';

type Log = Record<string, unknown> & { level?: string; message?: string; timestamp?: string; time?: string };

export function Logs() {
  const { t } = useTranslation();
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [feedback, setFeedback] = useState('');
  const terminal = useRef<HTMLOListElement>(null);
  const programmaticScroll = useRef(false);
  const prevScrollTop = useRef(0);
  const programmaticTimer = useRef<number | undefined>(undefined);
  const lifecycle = useGatewayLifecycle();
  const { openFeedback } = useModal();
  const [sendErrorsOpen, setSendErrorsOpen] = useState(false);
  const [errorCount, setErrorCount] = useState<number>(0);
  const [errorPreview, setErrorPreview] = useState<ErrorEntry[] | null>(null);
  const [errorPreviewLoading, setErrorPreviewLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const unavailable = lifecycle.status?.state !== 'running';
  const logsPolicy = createLogsQueryPolicy(paused);
  const query = useQuery({
    queryKey: queryKeys.logs,
    queryFn: async () => {
      if (unavailable) {
        const err = new Error('Gateway is not running.');
        err.name = 'GATEWAY_NOT_RUNNING';
        throw err;
      }
      return api.logs();
    },
    refetchInterval: logsPolicy.refetchInterval,
    refetchOnWindowFocus: logsPolicy.refetchOnWindowFocus,
    refetchOnReconnect: logsPolicy.refetchOnReconnect,
    retry: logsPolicy.retry,
    enabled: !unavailable && !paused,
  });
  const logs = (query.data?.logs ?? []) as Log[];
  const state = classifyDataState({
    pending: query.isPending,
    error: query.isError,
    data: query.data?.logs,
    stale: query.isError && Boolean(query.data),
  });
  const lines = useMemo(() => logs.map(formatLog), [logs]);
  useEffect(
    () => {
      if (autoScroll) {
        const element = terminal.current;
        if (!element) return;
        programmaticScroll.current = true;
        element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
        if (programmaticTimer.current !== undefined)
          window.clearTimeout(programmaticTimer.current);
        programmaticTimer.current = window.setTimeout(() => {
          programmaticScroll.current = false;
          programmaticTimer.current = undefined;
        }, 600);
        return () => {
          if (programmaticTimer.current !== undefined) {
            window.clearTimeout(programmaticTimer.current);
            programmaticTimer.current = undefined;
          }
          programmaticScroll.current = false;
        };
      }
    },
    [lines, autoScroll]
  );
  const trackScroll = () => {
    const element = terminal.current;
    if (!element) return;
    const nextTop = element.scrollTop;
    const metrics = { scrollTop: nextTop, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
    const prevTop = prevScrollTop.current;
    prevScrollTop.current = nextTop;
    const classification = classifyScrollEvent(
      prevTop,
      nextTop,
      programmaticScroll.current,
      metrics.scrollHeight,
      metrics.clientHeight
    );
    if (classification === 'user-up') {
      programmaticScroll.current = false;
      if (programmaticTimer.current !== undefined) {
        window.clearTimeout(programmaticTimer.current);
        programmaticTimer.current = undefined;
      }
      setAutoScroll(false);
      return;
    }
    if (classification === 'settle') {
      if (isNearBottom(metrics)) {
        programmaticScroll.current = false;
        if (programmaticTimer.current !== undefined) {
          window.clearTimeout(programmaticTimer.current);
          programmaticTimer.current = undefined;
        }
      }
      return;
    }
    if (!programmaticScroll.current && shouldCancelAutoScroll({ ...metrics, programmatic: false }))
      setAutoScroll(false);
  };
  const resumeFollowing = () => {
    setAutoScroll(true);
    const element = terminal.current;
    element?.scrollTo({ top: element.scrollHeight });
  };
  const announce = (message: string) => {
    setFeedback('');
    window.setTimeout(() => setFeedback(message), 0);
  };
  // Copy goes through the main process: navigator.clipboard rejects with
  // NotAllowedError whenever this tray-resident window is not focused.
  const copy = async () => {
    try {
      await window.electronAPI.clipboard.writeText(lines.join('\n'));
      announce(t('copied'));
    } catch {
      announce(t('copy_failed'));
    }
  };

  // --- Error reporting ---
  const handleSendErrorsClick = useCallback(async () => {
    try {
      const count = await window.electronAPI.errorReport.getCount();
      if (count === 0) {
        announce(t('errors_noErrors'));
        return;
      }
      setErrorCount(count);
      setSendErrorsOpen(true);
      setErrorPreview(null);
      setErrorPreviewLoading(true);
      try {
        const preview = await window.electronAPI.errorReport.preview();
        setErrorPreview(preview);
      } catch {
        setErrorPreview(null);
      } finally {
        setErrorPreviewLoading(false);
      }
    } catch {
      announce(t('errors_failed', { message: t('unknown_error') }));
    }
  }, [t, announce]);

  const handleSendConfirm = useCallback(async () => {
    setSending(true);
    try {
      const result = await window.electronAPI.errorReport.send();
      if (result.success) {
        announce(t('errors_success', { count: result.count }));
        setSendErrorsOpen(false);
      } else {
        announce(t('errors_failed', { message: result.message }));
      }
    } catch (error: unknown) {
      announce(t('errors_failed', { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setSending(false);
    }
  }, [t, announce]);

  const handleSendErrorsClose = useCallback(() => {
    setSendErrorsOpen(false);
  }, []);

  if (unavailable) {
    return (
      <div role="alert" className="p-4 sm:p-6 h-full flex flex-col min-w-0 items-center justify-center text-center">
        <AlertTriangle aria-hidden size={40} className="text-warning mb-4" />
        <p className="text-lg">{t('gateway_stopped')}</p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 h-full flex flex-col min-w-0">
      <header className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <h2 className="text-2xl font-bold">{t('logs')}</h2>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setPaused(!paused)} className="border border-border px-3 py-2">
            {t(paused ? 'resume' : 'pause')}
          </button>
          <label className="flex items-center gap-2 border border-border px-3">
            <input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />
            {t('auto_scroll')}
          </label>
          <button onClick={() => void copy()} className="border border-border px-3 py-2">
            {t('copy_logs')}
          </button>
          <button onClick={() => void handleSendErrorsClick()} className="border border-border px-3 py-2">
            {t('errors_sendButton')}
          </button>
          <button onClick={openFeedback} className="border border-border px-3 py-2">
            <Lightbulb aria-hidden size={16} className="inline mr-1" />
            {t('feedback_title')}
          </button>
        </div>
      </header>

      {!autoScroll && (
        <button onClick={resumeFollowing} className="self-start mb-2 text-accent-neon">
          {t('resume')}
        </button>
      )}
      <div className="text-xs text-textMuted mb-2">
        {feedback || (query.dataUpdatedAt ? `${t('last_refresh')} ${new Date(query.dataUpdatedAt).toLocaleTimeString()}` : '')}
      </div>
      <p className="sr-only" aria-live="polite">{feedback}</p>

      {state === 'loading' && <div role="status">{t('loading')}</div>}
      {state === 'error' && (
        <div role="alert" className="border border-error p-4">
          {t('logs_error')} <span className="break-all">{safeError(query.error, t('unknown_error'))}</span>
          <button onClick={() => void query.refetch()} className="ml-3 text-nvidia">
            {t('retry')}
          </button>
        </div>
      )}
      {state === 'stale' && (
        <div role="status" className="mb-2 text-textMuted">
          {t('stale')}
        </div>
      )}
      {state === 'empty' && <div className="flex-1 grid place-items-center border border-border">{t('empty_logs')}</div>}

      {(state === 'success' || state === 'stale') && (
        <ol
          ref={terminal}
          onScroll={trackScroll}
          role="log"
          aria-live={autoScroll ? 'polite' : 'off'}
          aria-label={t('logs')}
          className="flex-1 bg-bg border border-border p-4 text-sm font-mono overflow-y-auto min-w-0"
        >
          {logs.map((log, index) => (
            <li
              aria-label={`${String(log.level ?? 'log')}: ${formatLog(log)}`}
              key={log.id ? String(log.id) : `${log.timestamp ?? log.time ?? ''}-${index}-${log.message ?? ''}`}
              className={`py-1 whitespace-pre-wrap break-words ${levelClass(log.level)}`}
            >
              {formatLog(log)}
            </li>
          ))}
        </ol>
      )}

      {sendErrorsOpen && (
        <SendErrorsDialog
          count={errorCount}
          preview={errorPreview}
          previewLoading={errorPreviewLoading}
          sending={sending}
          onClose={handleSendErrorsClose}
          onConfirm={handleSendConfirm}
        />
      )}
    </div>
  );
}

interface SendErrorsDialogProps {
  count: number;
  preview: ErrorEntry[] | null;
  previewLoading: boolean;
  sending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

function SendErrorsDialog({ count, preview, previewLoading, sending, onClose, onConfirm }: SendErrorsDialogProps) {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('errors_confirmTitle')}
        onMouseDown={(e) => e.stopPropagation()}
        className="bg-bg border border-border p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Send aria-hidden size={20} />
            {t('errors_confirmTitle')}
          </h2>
          <button onClick={onClose} aria-label={t('close_menu')} className="p-1 text-textMuted hover:text-accent-neon">
            <X aria-hidden size={20} />
          </button>
        </div>

        <p className="text-sm text-textMuted mb-4">
          {t('errors_sendSubtext', { count })}
        </p>
        <p className="text-sm mb-4">{t('errors_confirmBody', { count })}</p>

        <div className="border border-border bg-surface p-3 mb-6 max-h-64 overflow-y-auto">
          {previewLoading ? (
            <div role="status" className="text-sm text-textMuted">
              {t('loading')}
            </div>
          ) : preview && preview.length > 0 ? (
            <ul className="grid gap-2 text-xs font-mono">
              {preview.slice(0, 50).map((entry, idx) => (
                <li key={idx} className="border-b border-border pb-1 break-words">
                  <span className="text-textMuted">{entry.timestamp}</span>{' '}
                  <span className="text-warning">[{entry.type}]</span>{' '}
                  <span className="text-textMain">{entry.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-textMuted">{t('errors_noErrors')}</div>
          )}
        </div>

        <div className="flex justify-end gap-3">
          <button onClick={onClose} disabled={sending} className="border border-border px-4 py-2 text-textMuted disabled:opacity-50">
            {t('errors_cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={sending}
            className="bg-nvidia text-bg px-4 py-2 disabled:opacity-50"
          >
            {t('errors_send')}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatLog(log: Log): string {
  return [
    log.timestamp ?? log.time,
    log.level && `[${String(log.level).toUpperCase()}]`,
    log.method,
    log.path,
    log.status,
    log.duration !== undefined && `${log.duration}ms`,
    log.outcome,
    log.model,
    log.message,
  ]
    .filter((value) => value !== undefined && value !== '')
    .map(String)
    .join(' ');
}

function levelClass(level?: string) {
  const value = level?.toLowerCase();
  return value === 'error'
    ? 'text-error'
    : value === 'warn' || value === 'warning'
    ? 'text-warning'
    : value === 'info'
    ? 'text-nvidia'
    : 'text-textMuted';
}
