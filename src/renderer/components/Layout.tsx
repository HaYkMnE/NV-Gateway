import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Boxes, KeyRound, Lightbulb, Loader2, Menu, Plug, RefreshCw, ScrollText, Settings, X } from 'lucide-react';
import { useConfigStore } from '../stores/config';
import { Logo } from './Logo';
import { reduceMenu } from '../lib/frontend-behavior';
import { GatewayLifecycleContext, type GatewayLifecycleSnapshot } from '../lib/gateway-lifecycle';
import { useModal } from '../lib/modal-context';
import { PetWidget } from '../pet/PetWidget';

const navClass = (active: boolean) =>
  `flex items-center gap-3 px-3.5 py-2.5 rounded-sm text-sm transition-colors ${
    active
      ? 'bg-surface text-accent-neon font-medium border-l-2 border-accent-neon'
      : 'text-textMuted hover:bg-surface hover:text-accent-neon'
  }`;

const Navigation = memo(function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  return (
    <nav className="flex flex-col gap-1.5">
      <NavLink onClick={onNavigate} to="/dashboard" className={({ isActive }) => navClass(isActive)}>
        <KeyRound aria-hidden size={18} />
        {t('keys')}
      </NavLink>
      <NavLink onClick={onNavigate} to="/models" className={({ isActive }) => navClass(isActive)}>
        <Boxes aria-hidden size={18} />
        {t('models')}
      </NavLink>
      <NavLink onClick={onNavigate} to="/endpoint" className={({ isActive }) => navClass(isActive)}>
        <Plug aria-hidden size={18} />
        {t('endpoint')}
      </NavLink>
      <NavLink onClick={onNavigate} to="/logs" className={({ isActive }) => navClass(isActive)}>
        <ScrollText aria-hidden size={18} />
        {t('logs')}
      </NavLink>
      <NavLink onClick={onNavigate} to="/settings" className={({ isActive }) => navClass(isActive)}>
        <Settings aria-hidden size={18} />
        {t('settings')}
      </NavLink>
    </nav>
  );
});

const StatusDisplay = memo(function StatusDisplay({
  status,
  gatewayPort,
  retrying,
  onRetry,
  onChangePort,
}: {
  status: GatewayStatus;
  gatewayPort: number;
  retrying: boolean;
  onRetry: () => void;
  onChangePort: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 break-words">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={`w-2 h-2 rounded-full ${
            status.state === 'running'
              ? 'bg-nvidia'
              : status.state === 'starting'
              ? 'bg-warning animate-pulse'
              : status.state === 'error'
              ? 'bg-error'
              : 'bg-textMuted'
          }`}
        />
        <span className="text-sm font-medium">{t(`gateway_${status.state}`)}</span>
      </div>
      <div className="text-xs text-textMuted font-mono">
        {t('port_label')} {status.port ?? gatewayPort}
      </div>
      {status.state === 'error' && (
        <div role="alert" className="mt-2 border border-error/60 bg-error/10 p-2 text-xs text-error break-words">
          <div className="flex gap-1">
            <AlertTriangle aria-hidden size={15} />
            <span>{t(status.code === 'PORT_IN_USE' ? 'port_conflict' : 'start_failed')}</span>
          </div>
          <div className="mt-2 flex gap-3">
            <button onClick={onRetry} disabled={retrying} className="text-textMain hover:text-accent-neon">
              {retrying ? (
                <Loader2 aria-label={t('loading')} size={13} className="animate-spin" />
              ) : (
                <>
                  <RefreshCw aria-hidden size={13} className="inline mr-1" />
                  {t('retry')}
                </>
              )}
            </button>
            <button onClick={onChangePort} className="text-textMain hover:text-accent-neon">
              {t('change_port')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

export function Layout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { gatewayPort } = useConfigStore();
  const { openFeedback, openDonation } = useModal();
  const [menuOpen, setMenuOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  const statusQuery = useQuery({
    queryKey: ['gateway-status'],
    queryFn: () => window.electronAPI.getGatewayStatus(),
    refetchInterval: 1000,
    // Default refetchIntervalInBackground (false) follows document.visibilityState,
    // so the poll pauses when the window is hidden or minimised to tray — the
    // previous `true` burned ~60 IPC round-trips per minute indefinitely on a
    // window nobody could see. The status display itself cannot go stale while
    // hidden BECAUSE it is hidden; on reveal, refetchOnWindowFocus (overriding
    // the global false in App.tsx) picks up any change immediately, and the
    // resumed 1s interval is the standing safety net.
    refetchOnWindowFocus: true,
  });

  const status: GatewayStatus = useMemo(() => {
    if (statusQuery.data) return statusQuery.data;
    if (statusQuery.error) {
      return {
        state: 'error',
        code: 'START_FAILED',
        message: statusQuery.error instanceof Error ? statusQuery.error.message : t('unknown_error'),
      };
    }
    return { state: 'starting' };
  }, [statusQuery.data, statusQuery.error, t]);

  const lifecycleValue = useMemo<GatewayLifecycleSnapshot>(
    () => ({
      status,
      isError: statusQuery.isError,
      refetch: statusQuery.refetch,
    }),
    [status, statusQuery.isError, statusQuery.refetch]
  );

  const closeMenu = useCallback((returnFocus = false) => {
    setMenuOpen(false);
    if (returnFocus) window.setTimeout(() => menuButton.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen((open) => reduceMenu(open, { type: 'escape' }));
        window.setTimeout(() => menuButton.current?.focus(), 0);
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [menuOpen]);

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      await window.electronAPI.retryGateway();
      await statusQuery.refetch();
    } finally {
      setRetrying(false);
    }
  }, [statusQuery.refetch]);

  const handleNavigate = useCallback(() => {
    closeMenu();
  }, [closeMenu]);

  const handleRetry = useCallback(() => {
    void retry();
  }, [retry]);

  const handleChangePort = useCallback(() => {
    navigate('/wizard?mode=change');
  }, [navigate]);

  return (
    <div className="flex h-full min-w-0 overflow-hidden">
      <aside className="hidden md:flex w-[250px] shrink-0 bg-bg border-r border-border flex-col overflow-y-auto">
        <div className="p-5 pb-2">
          <div className="flex items-center gap-3 mb-4">
            <Logo className="w-9 h-9" />
            <h1 className="font-bold text-lg">{t('product_name')}</h1>
          </div>
          <Navigation onNavigate={handleNavigate} />
        </div>
        <div className="px-5 my-auto py-2">
          <PetWidget onOpenDonation={openDonation} />
        </div>
        <div className="mt-auto p-5 pt-3 border-t border-border">
          <StatusDisplay
            status={status}
            gatewayPort={gatewayPort}
            retrying={retrying}
            onRetry={handleRetry}
            onChangePort={handleChangePort}
          />
          <button
            onClick={openFeedback}
            className="mt-3 w-full flex items-center justify-center gap-2 border border-border px-3 py-2 text-xs font-medium text-textMuted hover:text-accent-neon hover:border-accent-neon/50 transition-colors"
            aria-label={t('feedback_title')}
          >
            <Lightbulb aria-hidden size={15} />
            {t('feedback_title')}
          </button>
        </div>
      </aside>
      <div className="flex flex-1 min-w-0 flex-col">
        <header className="md:hidden border-b border-border bg-bg p-3 flex items-center gap-3">
          <button
            ref={menuButton}
            aria-label={t('menu')}
            aria-expanded={menuOpen}
            aria-controls="mobile-navigation"
            onClick={() => setMenuOpen((open) => reduceMenu(open, { type: 'toggle' }))}
            className="p-2 text-accent-neon"
          >
            {menuOpen ? <X aria-hidden /> : <Menu aria-hidden />}
          </button>
          <Logo className="w-8 h-8" />
          <h1 className="font-bold text-lg">{t('product_name')}</h1>
          <div className="ml-auto flex items-center gap-2 max-w-[60%]">
            <StatusDisplay
              status={status}
              gatewayPort={gatewayPort}
              retrying={retrying}
              onRetry={handleRetry}
              onChangePort={handleChangePort}
            />
            <button
              onClick={openFeedback}
              className="p-2 text-textMuted hover:text-accent-neon transition-colors"
              aria-label={t('feedback_title')}
              title={t('feedback_title')}
            >
              <Lightbulb aria-hidden size={18} />
            </button>
          </div>
        </header>
        {menuOpen && (
          <>
            <button
              aria-label={t('close_menu')}
              className="md:hidden fixed inset-0 z-20 bg-black/60"
              onClick={() => closeMenu(true)}
            />
            <aside
              id="mobile-navigation"
              className="md:hidden fixed inset-y-0 left-0 z-30 w-[min(250px,85vw)] bg-bg border-r border-border p-5"
            >
              <div className="mb-8">
                <Logo className="w-9 h-9" />
              </div>
              <Navigation onNavigate={handleNavigate} />
            </aside>
          </>
        )}
        <main className="flex-1 min-w-0 overflow-hidden bg-bg">
          <GatewayLifecycleContext.Provider value={lifecycleValue}>
            <Outlet />
          </GatewayLifecycleContext.Provider>
        </main>
      </div>
    </div>
  );
}
