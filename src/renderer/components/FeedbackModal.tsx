import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useDialogFocus } from '../lib/use-dialog-focus';
import type { ModalRequest } from '../lib/modal-context';

const TITLE_MAX = 100;
const DESCRIPTION_MAX = 2000;
/** Auto-close delay after a plain "saved" confirmation. */
const CLOSE_MS = 1200;
/** Longer delay when the toast names the saved path, so it can be read. */
const PATH_TOAST_CLOSE_MS = 4000;

interface FeedbackModalProps {
  isOpen: boolean;
  session: ModalRequest | null;
  onClose: () => void;
}

export function FeedbackModal({ isOpen, session, onClose }: FeedbackModalProps) {
  const { t } = useTranslation();
  const [type, setType] = useState<'suggestion' | 'bug'>('suggestion');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [email, setEmail] = useState('');
  const [attachDiagnostic, setAttachDiagnostic] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const isOpenRef = useRef(isOpen);
  const sessionRef = useRef<ModalRequest | null>(session);
  const toastTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  isOpenRef.current = isOpen;
  sessionRef.current = session;

  const clearTimers = useCallback(() => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  // Focus-in-on-open, Tab trapping and focus-restore-on-close all live in the
  // ONE shared hook — the dialogRef is handed over, not used directly here.
  useDialogFocus(dialogRef, isOpen);

  useEffect(() => clearTimers, [clearTimers]);

  // A request identity is one logical Feedback session. It changes even when
  // the modal remains visibly open (for example, a native-menu reopen), so the
  // reset and timer cancellation must follow identity rather than only the
  // isOpen boolean.
  useEffect(() => {
    clearTimers();
    if (!isOpen || session === null) return;
    setType('suggestion');
    setTitle('');
    setDescription('');
    setEmail('');
    setAttachDiagnostic(true);
    setSubmitting(false);
    setToast(null);
  }, [isOpen, session, clearTimers]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const ownsCurrentSession = useCallback((ownedSession: ModalRequest | null): ownedSession is ModalRequest =>
    ownedSession !== null && isOpenRef.current && ownedSession === sessionRef.current, []);

  const showToast = useCallback((message: string, ownedSession = sessionRef.current) => {
    if (!ownsCurrentSession(ownedSession)) return;
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      if (ownsCurrentSession(ownedSession)) setToast(null);
    }, 4000);
  }, [ownsCurrentSession]);

  const buildData = useCallback((): FeedbackData => ({
    type,
    title: title.trim(),
    description: description.trim(),
    email: email.trim() || undefined,
    attachDiagnostic,
  }), [type, title, description, email, attachDiagnostic]);

  const validate = useCallback((): boolean => {
    if (!title.trim()) {
      showToast(t('feedback_titleRequired'));
      return false;
    }
    if (!description.trim()) {
      showToast(t('feedback_descriptionRequired'));
      return false;
    }
    return true;
  }, [title, description, showToast, t]);

  // Writes feedback.jsonl under userData via saveFeedback(). Nothing is
  // transmitted — automatic transmission was removed for privacy, so the button
  // this is wired to must name SAVING rather than sending.
  const handleSave = useCallback(() => {
    if (!validate()) return;
    const session = sessionRef.current;
    setSubmitting(true);
    window.electronAPI.feedback
      .save(buildData())
      .then((result) => {
        if (!ownsCurrentSession(session)) return;
        if (result.success) {
          // The whole point of this flow is that the user shares the file
          // themselves, which is impossible unless we say where it landed.
          // `path` is optional on FeedbackResult, so keep the plain confirmation
          // as the fallback rather than rendering "undefined".
          showToast(result.path ? t('feedback_savedTo', { path: result.path }) : t('feedback_success'), session);
          // A path the user cannot finish reading is not a disclosure: give the
          // longer message time on screen before the modal closes itself.
          if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
          closeTimerRef.current = window.setTimeout(() => {
            closeTimerRef.current = null;
            if (ownsCurrentSession(session)) onClose();
          }, result.path ? PATH_TOAST_CLOSE_MS : CLOSE_MS);
        } else {
          showToast(t('feedback_failed', { message: result.message }), session);
        }
      })
      .catch((error: unknown) => {
        if (!ownsCurrentSession(session)) return;
        showToast(t('feedback_failed', { message: error instanceof Error ? error.message : String(error) }), session);
      })
      .finally(() => {
        if (ownsCurrentSession(session)) setSubmitting(false);
      });
  }, [validate, buildData, ownsCurrentSession, showToast, onClose, t]);

  const handleGithub = useCallback(() => {
    if (!validate()) return;
    const session = sessionRef.current;
    window.electronAPI.feedback
      .openGitHubIssue(buildData())
      .catch((error: unknown) => {
        if (!ownsCurrentSession(session)) return;
        showToast(t('feedback_failed', { message: error instanceof Error ? error.message : String(error) }), session);
      });
  }, [validate, buildData, ownsCurrentSession, showToast, t]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-4" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={t('feedback_title')}
        onMouseDown={(e) => e.stopPropagation()}
        className="bg-bg border border-border p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">{t('feedback_title')}</h2>
          <button
            onClick={onClose}
            aria-label={t('feedback_closeDialog')}
            className="p-1 text-textMuted hover:text-accent-neon"
          >
            <X aria-hidden size={20} />
          </button>
        </div>

        {/* Type toggle */}
        <div role="radiogroup" aria-label={t('feedback_title')} className="flex gap-2 mb-4">
          <button
            type="button"
            role="radio"
            aria-checked={type === 'suggestion'}
            onClick={() => setType('suggestion')}
            className={`flex-1 border px-4 py-3 text-sm transition-colors ${
              type === 'suggestion'
                ? 'border-nvidia bg-nvidia/10 text-nvidia'
                : 'border-border text-textMuted hover:text-accent-neon'
            }`}
          >
            {t('feedback_suggestion')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={type === 'bug'}
            onClick={() => setType('bug')}
            className={`flex-1 border px-4 py-3 text-sm transition-colors ${
              type === 'bug'
                ? 'border-nvidia bg-nvidia/10 text-nvidia'
                : 'border-border text-textMuted hover:text-accent-neon'
            }`}
          >
            {t('feedback_bug')}
          </button>
        </div>

        {/* Title field */}
        <div className="grid gap-2 mb-4">
          <label htmlFor="feedback-title" className="text-sm text-textMuted">
            {t('feedback_titleLabel')}
          </label>
          <input
            id="feedback-title"
            type="text"
            value={title}
            maxLength={TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            className="bg-surface border border-border p-3 text-textMain rounded-sm focus:outline-none focus:border-nvidia"
          />
        </div>

        {/* Description field */}
        <div className="grid gap-2 mb-4">
          <label htmlFor="feedback-description" className="text-sm text-textMuted">
            {t('feedback_descriptionLabel')}
          </label>
          <textarea
            id="feedback-description"
            value={description}
            maxLength={DESCRIPTION_MAX}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('feedback_descriptionPlaceholder')}
            rows={5}
            className="bg-surface border border-border p-3 text-textMain rounded-sm focus:outline-none focus:border-nvidia resize-y"
          />
          <span className="text-xs text-textMuted">
            {t('feedback_charCount', { count: description.length, max: DESCRIPTION_MAX })}
          </span>
        </div>

        {/* Email field */}
        <div className="grid gap-2 mb-4">
          <label htmlFor="feedback-email" className="text-sm text-textMuted">
            {t('feedback_emailLabel')}
          </label>
          <input
            id="feedback-email"
            dir="ltr"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            className="bg-surface border border-border p-3 text-textMain rounded-sm focus:outline-none focus:border-nvidia"
          />
        </div>

        {/* Attach diagnostic checkbox */}
        <label className="flex items-center gap-2 mb-3 text-sm text-textMuted">
          <input
            type="checkbox"
            checked={attachDiagnostic}
            onChange={(e) => setAttachDiagnostic(e.target.checked)}
          />
          {t('feedback_attachDiagnostic')}
        </label>

        {/* Nothing here is transmitted. Saying so next to the action keeps the
            dialog honest: the report is a local file the user shares themselves.
            The id is referenced by the save button's aria-describedby, so the
            disclosure reaches a screen-reader user too — sighted-only honesty is
            not honesty. */}
        <p id="feedback-local-note" className="mb-6 text-xs text-textMuted">{t('feedback_localNote')}</p>

        {/* Actions */}
        <div className="flex flex-wrap gap-3 justify-end">
          <button
            onClick={handleGithub}
            disabled={submitting}
            className="border border-border px-4 py-2 text-textMain disabled:opacity-50"
          >
            {t('feedback_openGithub')}
          </button>
          <button
            onClick={handleSave}
            disabled={submitting}
            aria-describedby="feedback-local-note"
            className="bg-nvidia text-bg px-4 py-2 disabled:opacity-50"
          >
            {t('feedback_save')}
          </button>
        </div>

        {/* Toast */}
        {toast && (
          <div role="status" className="mt-4 border border-border bg-surface p-3 text-sm break-words">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
