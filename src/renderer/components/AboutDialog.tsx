import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AboutDialog({ isOpen, onClose }: AboutDialogProps) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch about info when opened
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setInfo(null);
    setError(null);
    window.electronAPI.about
      .getInfo()
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);\n    return () => document.removeEventListener('keydown', handler);\n  }, [isOpen, onClose]);\n\n  if (!isOpen) return null;\n\n  const openRepo = () => {\n    if (info?.repoUrl) void window.electronAPI.openExternal(info.repoUrl);\n  };\n\n  return (\n    <div className=\"fixed inset-0 z-50 bg-black/60 grid place-items-center p-4\" onMouseDown={onClose}>\n      <div\n        role=\"dialog\"\n        aria-modal=\"true\"\n        aria-label={t('about_title')}\n        onMouseDown={(e) => e.stopPropagation()}\n        className=\"bg-bg border border-border p-6 max-w-md w-full\"\n      >\n        <div className=\"flex items-center justify-between mb-4\">\n          <h2 className=\"text-xl font-bold\">{t('about_title')}</h2>\n          <button\n            onClick={onClose}\n            aria-label={t('close_menu')}\n            className=\"p-1 text-textMuted hover:text-accent-neon\"\n          >\n            <X aria-hidden size={20} />\n          </button>\n        </div>\n\n        {error && (\n          <div role=\"alert\" className=\"border border-error p-3 text-sm text-error mb-4 break-words\">\n            {error}\n          </div>\n        )}\n\n        {info ? (\n          <dl className=\"grid gap-3\">\n            <div className=\"flex justify-between gap-4\">\n              <dt className=\"text-textMuted text-sm\">{t('about_appVersion')}</dt>\n              <dd className=\"font-mono text-sm text-textMain\">{info.appVersion}</dd>\n            </div>\n            <div className=\"flex justify-between gap-4\">\n              <dt className=\"text-textMuted text-sm\">{t('about_electronVersion')}</dt>\n              <dd className=\"font-mono text-sm text-textMain\">{info.electronVersion}</dd>\n            </div>\n            <div className=\"flex justify-between gap-4\">\n              <dt className=\"text-textMuted text-sm\">{t('about_chromeVersion')}</dt>\n              <dd className=\"font-mono text-sm text-textMain\">{info.chromeVersion}</dd>\n            </div>\n            <div className=\"flex justify-between gap-4\">\n              <dt className=\"text-textMuted text-sm\">{t('about_nodeVersion')}</dt>\n              <dd className=\"font-mono text-sm text-textMain\">{info.nodeVersion}</dd>\n            </div>\n            <div className=\"flex justify-between gap-4\">\n              <dt className=\"text-textMuted text-sm\">{t('about_proxyPort')}</dt>\n              <dd className=\"font-mono text-sm text-textMain\">{info.proxyPort}</dd>\n            </div>\n            <div className=\"flex justify-between gap-4\">\n              <dt className=\"text-textMuted text-sm\">{t('about_adminPort')}</dt>\n              <dd className=\"font-mono text-sm text-textMain\">{info.adminPort}</dd>\n            </div>\n            <div className=\"border-t border-border pt-3 mt-1\">\n              <div className=\"text-textMuted text-sm mb-1\">{t('about_repository')}</div>\n              <button\n                onClick={openRepo}\n                className=\"text-accent-neon text-sm hover:underline break-all\"\n              >\n                {info.repoUrl}\n              </button>\n            </div>\n          </dl>\n        ) : (\n          !error && (\n            <div role=\"status\" className=\"text-textMuted text-sm\">\n              {t('loading')}\n            </div>\n          )\n        )}\n\n        <div className=\"flex justify-end mt-6\">\n          <button onClick={onClose} className=\"border border-border px-4 py-2 text-textMain\">\n            {t('cancel')}\n          </button>\n        </div>\n      </div>\n    </div>\n  );\n}
