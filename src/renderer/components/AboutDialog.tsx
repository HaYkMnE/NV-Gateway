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
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const openRepo = () => {
    if (!info?.repoUrl) return;
    // NOT window.open: electron-security.ts installs a deny-all
    // setWindowOpenHandler on this window, so window.open was a silent no-op.
    // The main process validates the URL against its allowlist before opening.
    window.electronAPI?.openExternal(info.repoUrl).catch(() => undefined);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('about_title')}
        onMouseDown={(e) => e.stopPropagation()}
        className="bg-bg border border-border p-6 max-w-md w-full"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">{t('about_title')}</h2>
          <button
            onClick={onClose}
            aria-label={t('close_menu')}
            className="p-1 text-textMuted hover:text-accent-neon"
          >
            <X aria-hidden size={20} />
          </button>
        </div>

        {error && (
          <div role="alert" className="border border-error p-3 text-sm text-error mb-4 break-words">
            {error}
          </div>
        )}

        {info ? (
          <dl className="grid gap-3">
            <div className="flex justify-between gap-4">
              <dt className="text-textMuted text-sm">{t('about_appVersion')}</dt>
              <dd className="font-mono text-sm text-textMain">{info.appVersion}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-textMuted text-sm">{t('about_electronVersion')}</dt>
              <dd className="font-mono text-sm text-textMain">{info.electronVersion}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-textMuted text-sm">{t('about_chromeVersion')}</dt>
              <dd className="font-mono text-sm text-textMain">{info.chromeVersion}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-textMuted text-sm">{t('about_nodeVersion')}</dt>
              <dd className="font-mono text-sm text-textMain">{info.nodeVersion}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-textMuted text-sm">{t('about_proxyPort')}</dt>
              <dd className="font-mono text-sm text-textMain">{info.proxyPort}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-textMuted text-sm">{t('about_adminPort')}</dt>
              <dd className="font-mono text-sm text-textMain">{info.adminPort}</dd>
            </div>
            <div className="border-t border-border pt-3 mt-1">
              <div className="text-textMuted text-sm mb-1">{t('about_repository')}</div>
              <button
                onClick={openRepo}
                className="text-accent-neon text-sm hover:underline break-all"
              >
                {info.repoUrl}
              </button>
            </div>
          </dl>
        ) : (
          !error && (
            <div role="status" className="text-textMuted text-sm">
              {t('loading')}
            </div>
          )
        )}

        <div className="flex justify-end mt-6">
          <button onClick={onClose} className="border border-border px-4 py-2 text-textMain">
            {t('cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
