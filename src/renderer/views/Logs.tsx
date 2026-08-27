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
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
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
    } catch (error: unknown) {\n      announce(t('errors_failed', { message: error instanceof Error ? error.message : String(error) }));\n    } finally {\n      setSending(false);\n    }\n  }, [t, announce]);\n\n  const handleSendErrorsClose = useCallback(() => {\n    setSendErrorsOpen(false);\n  }, []);\n\n  if (unavailable) {\n    return (\n      <div role=\"alert\" className=\"p-4 sm:p-6 h-full flex flex-col min-w-0 items-center justify-center text-center\">\n        <AlertTriangle aria-hidden size={40} className=\"text-warning mb-4\" />\n        <p className=\"text-lg\">{t('gateway_stopped')}</p>\n      </div>\n    );\n  }\n\n  return (\n    <div className=\"p-4 sm:p-6 h-full flex flex-col min-w-0\">\n      <header className=\"flex flex-wrap items-start justify-between gap-3 mb-4\">\n        <h2 className=\"text-2xl font-bold\">{t('logs')}</h2>\n        <div className=\"flex flex-wrap gap-2\">\n          <button onClick={() => setPaused(!paused)} className=\"border border-border px-3 py-2\">\n            {t(paused ? 'resume' : 'pause')}\n          </button>\n          <label className=\"flex items-center gap-2 border border-border px-3\">\n            <input type=\"checkbox\" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />\n            {t('auto_scroll')}\n          </label>\n          <button onClick={() => void copy()} className=\"border border-border px-3 py-2\">\n            {t('copy_logs')}\n          </button>\n          <button onClick={() => void handleSendErrorsClick()} className=\"border border-border px-3 py-2\">\n            {t('errors_sendButton')}\n          </button>\n          <button onClick={openFeedback} className=\"border border-border px-3 py-2\">\n            <Lightbulb aria-hidden size={16} className=\"inline mr-1\" />\n            {t('feedback_title')}\n          </button>\n        </div>\n      </header>\n\n      {!autoScroll && (\n        <button onClick={resumeFollowing} className=\"self-start mb-2 text-accent-neon\">\n          {t('resume')}\n        </button>\n      )}\n      <div className=\"text-xs text-textMuted mb-2\">\n        {feedback || (query.dataUpdatedAt ? `${t('last_refresh')} ${new Date(query.dataUpdatedAt).toLocaleTimeString()}` : '')}\n      </div>\n      <p className=\"sr-only\" aria-live=\"polite\">{feedback}</p>\n\n      {state === 'loading' && <div role=\"status\">{t('loading')}</div>}\n      {state === 'error' && (\n        <div role=\"alert\" className=\"border border-error p-4\">\n          {t('logs_error')} <span className=\"break-all\">{safeError(query.error, t('unknown_error'))}</span>\n          <button onClick={() => void query.refetch()} className=\"ml-3 text-nvidia\">\n            {t('retry')}\n          </button>\n        </div>\n      )}\n      {state === 'stale' && (\n        <div role=\"status\" className=\"mb-2 text-textMuted\">\n          {t('stale')}\n        </div>\n      )}\n      {state === 'empty' && <div className=\"flex-1 grid place-items-center border border-border\">{t('empty_logs')}</div>}\n\n      {(state === 'success' || state === 'stale') && (\n        <ol\n          ref={terminal}\n          onScroll={trackScroll}\n          role=\"log\"\n          aria-live={autoScroll ? 'polite' : 'off'}\n          aria-label={t('logs')}\n          className=\"flex-1 bg-bg border border-border p-4 text-sm font-mono overflow-y-auto min-w-0\"\n        >\n          {logs.map((log, index) => (\n            <li\n              aria-label={`${String(log.level ?? 'log')}: ${formatLog(log)}`}\n              key={log.id ? String(log.id) : `${log.timestamp ?? log.time ?? ''}-${index}-${log.message ?? ''}`}\n              className={`py-1 whitespace-pre-wrap break-words ${levelClass(log.level)}`}\n            >\n              {formatLog(log)}\n            </li>\n          ))}\n        </ol>\n      )}\n\n      {sendErrorsOpen && (\n        <SendErrorsDialog\n          count={errorCount}\n          preview={errorPreview}\n          previewLoading={errorPreviewLoading}\n          sending={sending}\n          onClose={handleSendErrorsClose}\n          onConfirm={handleSendConfirm}\n        />\n      )}\n    </div>\n  );\n}\n\ninterface SendErrorsDialogProps {\n  count: number;\n  preview: ErrorEntry[] | null;\n  previewLoading: boolean;\n  sending: boolean;\n  onClose: () => void;\n  onConfirm: () => void;\n}\n\nfunction SendErrorsDialog({ count, preview, previewLoading, sending, onClose, onConfirm }: SendErrorsDialogProps) {\n  const { t } = useTranslation();\n\n  return (\n    <div className=\"fixed inset-0 z-50 bg-black/60 grid place-items-center p-4\" onMouseDown={onClose}>\n      <div\n        role=\"dialog\"\n        aria-modal=\"true\"\n        aria-label={t('errors_confirmTitle')}\n        onMouseDown={(e) => e.stopPropagation()}\n        className=\"bg-bg border border-border p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto\"\n      >\n        <div className=\"flex items-center justify-between mb-4\">\n          <h2 className=\"text-xl font-bold flex items-center gap-2\">\n            <Send aria-hidden size={20} />\n            {t('errors_confirmTitle')}\n          </h2>\n          <button onClick={onClose} aria-label={t('close_menu')} className=\"p-1 text-textMuted hover:text-accent-neon\">\n            <X aria-hidden size={20} />\n          </button>\n        </div>\n\n        <p className=\"text-sm text-textMuted mb-4\">\n          {t('errors_sendSubtext', { count })}\n        </p>\n        <p className=\"text-sm mb-4\">{t('errors_confirmBody', { count })}</p>\n\n        <div className=\"border border-border bg-surface p-3 mb-6 max-h-64 overflow-y-auto\">\n          {previewLoading ? (\n            <div role=\"status\" className=\"text-sm text-textMuted\">\n              {t('loading')}\n            </div>\n          ) : preview && preview.length > 0 ? (\n            <ul className=\"grid gap-2 text-xs font-mono\">\n              {preview.slice(0, 50).map((entry, idx) => (\n                <li key={idx} className=\"border-b border-border pb-1 break-words\">\n                  <span className=\"text-textMuted\">{entry.timestamp}</span>{' '}\n                  <span className=\"text-warning\">[{entry.type}]</span>{' '}\n                  <span className=\"text-textMain\">{entry.message}</span>\n                </li>\n              ))}\n            </ul>\n          ) : (\n            <div className=\"text-sm text-textMuted\">{t('errors_noErrors')}</div>\n          )}\n        </div>\n\n        <div className=\"flex justify-end gap-3\">\n          <button onClick={onClose} disabled={sending} className=\"border border-border px-4 py-2 text-textMuted disabled:opacity-50\">\n            {t('errors_cancel')}\n          </button>\n          <button\n            onClick={onConfirm}\n            disabled={sending}\n            className=\"bg-nvidia text-bg px-4 py-2 disabled:opacity-50\"\n          >\n            {t('errors_send')}\n          </button>\n        </div>\n      </div>\n    </div>\n  );\n}\n\nfunction formatLog(log: Log): string {\n  return [\n    log.timestamp ?? log.time,\n    log.level && `[${String(log.level).toUpperCase()}]`,\n    log.method,\n    log.path,\n    log.status,\n    log.duration !== undefined && `${log.duration}ms`,\n    log.outcome,\n    log.model,\n    log.message,\n  ]\n    .filter((value) => value !== undefined && value !== '')\n    .map(String)\n    .join(' ');\n}\n\nfunction levelClass(level?: string) {\n  const value = level?.toLowerCase();\n  return value === 'error'\n    ? 'text-error'\n    : value === 'warn' || value === 'warning'\n    ? 'text-warning'\n    : value === 'info'\n    ? 'text-nvidia'\n    : 'text-textMuted';\n}\n