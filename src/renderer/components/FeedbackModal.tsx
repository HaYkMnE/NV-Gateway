import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

const TITLE_MAX = 100;
const DESCRIPTION_MAX = 2000;

interface FeedbackModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function FeedbackModal({ isOpen, onClose }: FeedbackModalProps) {
  const { t } = useTranslation();
  const [type, setType] = useState<'suggestion' | 'bug'>('suggestion');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [email, setEmail] = useState('');
  const [attachDiagnostic, setAttachDiagnostic] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Reset form when opening
  useEffect(() => {
    if (isOpen) {
      setType('suggestion');
      setTitle('');
      setDescription('');
      setEmail('');
      setAttachDiagnostic(true);
      setSubmitting(false);
      setToast(null);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;\n    const handler = (event: KeyboardEvent) => {\n      if (event.key === 'Escape') onClose();\n    };\n    document.addEventListener('keydown', handler);\n    return () => document.removeEventListener('keydown', handler);\n  }, [isOpen, onClose]);

  const showToast = useCallback((message: string) => {\n    setToast(message);\n    window.setTimeout(() => setToast(null), 4000);\n  }, []);

  const buildData = useCallback((): FeedbackData => ({\n    type,\n    title: title.trim(),\n    description: description.trim(),\n    email: email.trim() || undefined,\n    attachDiagnostic,\n  }), [type, title, description, email, attachDiagnostic]);

  const validate = useCallback((): boolean => {\n    if (!title.trim()) {\n      showToast(t('feedback_titleRequired'));\n      return false;\n    }\n    if (!description.trim()) {\n      showToast(t('feedback_descriptionRequired'));\n      return false;\n    }\n    return true;\n  }, [title, description, showToast, t]);

  const handleSend = useCallback(() => {\n    if (!validate()) return;\n    setSubmitting(true);\n    window.electronAPI.feedback\n      .save(buildData())\n      .then((result) => {\n        if (result.success) {\n          showToast(t('feedback_success'));\n          window.setTimeout(onClose, 1200);\n        } else {\n          showToast(t('feedback_failed', { message: result.message }));\n        }\n      })\n      .catch((error: unknown) => {\n        showToast(t('feedback_failed', { message: error instanceof Error ? error.message : String(error) }));\n      })\n      .finally(() => setSubmitting(false));\n  }, [validate, buildData, showToast, onClose, t]);

  const handleGithub = useCallback(() => {\n    if (!validate()) return;\n    window.electronAPI.feedback\n      .openGitHubIssue(buildData())\n      .catch((error: unknown) => {\n        showToast(t('feedback_failed', { message: error instanceof Error ? error.message : String(error) }));\n      });\n  }, [validate, buildData, showToast, t]);

  if (!isOpen) return null;

  return (\n    <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-4" onMouseDown={onClose}>\n      <div\n        ref={dialogRef}\n        role="dialog"\n        aria-modal="true"\n        aria-label={t('feedback_title')}\n        onMouseDown={(e) => e.stopPropagation()}\n        className="bg-bg border border-border p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto"\n      >\n        <div className="flex items-center justify-between mb-4">\n          <h2 className="text-xl font-bold">{t('feedback_title')}</h2>\n          <button\n            onClick={onClose}\n            aria-label={t('close_menu')}\n            className="p-1 text-textMuted hover:text-accent-neon"\n          >\n            <X aria-hidden size={20} />\n          </button>\n        </div>\n\n        {/* Type toggle */}\n        <div role="radiogroup" aria-label={t('feedback_title')} className="flex gap-2 mb-4">\n          <button\n            type="button"\n            role="radio"\n            aria-checked={type === 'suggestion'}\n            onClick={() => setType('suggestion')}\n            className={`flex-1 border px-4 py-3 text-sm transition-colors ${\n              type === 'suggestion'\n                ? 'border-nvidia bg-nvidia/10 text-nvidia'\n                : 'border-border text-textMuted hover:text-accent-neon'\n            }`}\n          >\n            {t('feedback_suggestion')}\n          </button>\n          <button\n            type="button"\n            role="radio"\n            aria-checked={type === 'bug'}\n            onClick={() => setType('bug')}\n            className={`flex-1 border px-4 py-3 text-sm transition-colors ${\n              type === 'bug'\n                ? 'border-nvidia bg-nvidia/10 text-nvidia'\n                : 'border-border text-textMuted hover:text-accent-neon'\n            }`}\n          >\n            {t('feedback_bug')}\n          </button>\n        </div>\n\n        {/* Title field */}\n        <div className="grid gap-2 mb-4">\n          <label htmlFor="feedback-title" className="text-sm text-textMuted">\n            {t('feedback_titleLabel')}\n          </label>\n          <input\n            id="feedback-title"\n            type="text"\n            value={title}\n            maxLength={TITLE_MAX}\n            onChange={(e) => setTitle(e.target.value)}\n            className="bg-surface border border-border p-3 text-textMain rounded-sm focus:outline-none focus:border-nvidia"\n          />\n        </div>\n\n        {/* Description field */}\n        <div className="grid gap-2 mb-4">\n          <label htmlFor="feedback-description" className="text-sm text-textMuted">\n            {t('feedback_descriptionLabel')}\n          </label>\n          <textarea\n            id="feedback-description"\n            value={description}\n            maxLength={DESCRIPTION_MAX}\n            onChange={(e) => setDescription(e.target.value)}\n            placeholder={t('feedback_descriptionPlaceholder')}\n            rows={5}\n            className="bg-surface border border-border p-3 text-textMain rounded-sm focus:outline-none focus:border-nvidia resize-y"\n          />\n          <span className="text-xs text-textMuted">\n            {t('feedback_charCount', { count: description.length, max: DESCRIPTION_MAX })}\n          </span>\n        </div>\n\n        {/* Email field */}\n        <div className="grid gap-2 mb-4">\n          <label htmlFor="feedback-email" className="text-sm text-textMuted">\n            {t('feedback_emailLabel')}\n          </label>\n          <input\n            id="feedback-email"\n            type="email"\n            value={email}\n            onChange={(e) => setEmail(e.target.value)}\n            placeholder="your@email.com"\n            className="bg-surface border border-border p-3 text-textMain rounded-sm focus:outline-none focus:border-nvidia"\n          />\n        </div>\n\n        {/* Attach diagnostic checkbox */}\n        <label className="flex items-center gap-2 mb-6 text-sm text-textMuted">\n          <input\n            type="checkbox"\n            checked={attachDiagnostic}\n            onChange={(e) => setAttachDiagnostic(e.target.checked)}\n          />\n          {t('feedback_attachDiagnostic')}\n        </label>\n\n        {/* Actions */}\n        <div className="flex flex-wrap gap-3 justify-end">\n          <button\n            onClick={handleGithub}\n            disabled={submitting}\n            className="border border-border px-4 py-2 text-textMain disabled:opacity-50"\n          >\n            {t('feedback_openGithub')}\n          </button>\n          <button\n            onClick={handleSend}\n            disabled={submitting}\n            className="bg-nvidia text-bg px-4 py-2 disabled:opacity-50"\n          >\n            {t('feedback_send')}\n          </button>\n        </div>\n\n        {/* Toast */}\n        {toast && (\n          <div role="status" className="mt-4 border border-border bg-surface p-3 text-sm break-words">\n            {toast}\n          </div>\n        )}\n      </div>\n    </div>\n  );\n}\n