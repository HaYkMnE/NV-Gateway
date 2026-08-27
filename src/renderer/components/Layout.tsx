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
      {status.state === 'error' && (\n        <div role=\"alert\" className=\"mt-2 border border-error/60 bg-error/10 p-2 text-xs text-error break-words\">\n          <div className=\"flex gap-1\">\n            <AlertTriangle aria-hidden size={15} />\n            <span>{t(status.code === 'PORT_IN_USE' ? 'port_conflict' : 'start_failed')}</span>\n          </div>\n          <div className=\"mt-2 flex gap-3\">\n            <button onClick={onRetry} disabled={retrying} className=\"text-textMain hover:text-accent-neon\">\n              {retrying ? (\n                <Loader2 aria-label={t('loading')} size={13} className=\"animate-spin\" />\n              ) : (\n                <>\n                  <RefreshCw aria-hidden size={13} className=\"inline mr-1\" />\n                  {t('retry')}\n                </>\n              )}\n            </button>\n            <button onClick={onChangePort} className=\"text-textMain hover:text-accent-neon\">\n              {t('change_port')}\n            </button>\n          </div>\n        </div>\n      )}\n    </div>\n  );\n});\n\nexport function Layout() {\n  const { t } = useTranslation();\n  const navigate = useNavigate();\n  const { gatewayPort } = useConfigStore();\n  const { openFeedback, openDonation } = useModal();\n  const [menuOpen, setMenuOpen] = useState(false);\n  const [retrying, setRetrying] = useState(false);\n  const menuButton = useRef<HTMLButtonElement>(null);\n\n  const statusQuery = useQuery({\n    queryKey: ['gateway-status'],\n    queryFn: () => window.electronAPI.getGatewayStatus(),\n    refetchInterval: 1000,\n    refetchIntervalInBackground: true,\n  });\n\n  const status: GatewayStatus = useMemo(() => {\n    if (statusQuery.data) return statusQuery.data;\n    if (statusQuery.error) {\n      return {\n        state: 'error',\n        code: 'START_FAILED',\n        message: statusQuery.error instanceof Error ? statusQuery.error.message : t('unknown_error'),\n      };\n    }\n    return { state: 'starting' };\n  }, [statusQuery.data, statusQuery.error, t]);\n\n  const lifecycleValue = useMemo<GatewayLifecycleSnapshot>(\n    () => ({\n      status,\n      isError: statusQuery.isError,\n      refetch: statusQuery.refetch,\n    }),\n    [status, statusQuery.isError, statusQuery.refetch]\n  );\n\n  const closeMenu = useCallback((returnFocus = false) => {\n    setMenuOpen(false);\n    if (returnFocus) window.setTimeout(() => menuButton.current?.focus(), 0);\n  }, []);\n\n  useEffect(() => {\n    if (!menuOpen) return;\n    const key = (event: KeyboardEvent) => {\n      if (event.key === 'Escape') {\n        setMenuOpen((open) => reduceMenu(open, { type: 'escape' }));\n        window.setTimeout(() => menuButton.current?.focus(), 0);\n      }\n    };\n    document.addEventListener('keydown', key);\n    return () => document.removeEventListener('keydown', key);\n  }, [menuOpen]);\n\n  const retry = useCallback(async () => {\n    setRetrying(true);\n    try {\n      await window.electronAPI.retryGateway();\n      await statusQuery.refetch();\n    } finally {\n      setRetrying(false);\n    }\n  }, [statusQuery.refetch]);\n\n  const handleNavigate = useCallback(() => {\n    closeMenu();\n  }, [closeMenu]);\n\n  const handleRetry = useCallback(() => {\n    void retry();\n  }, [retry]);\n\n  const handleChangePort = useCallback(() => {\n    navigate('/wizard?mode=change');\n  }, [navigate]);\n\n  return (\n    <div className=\"flex h-full min-w-0 overflow-hidden\">\n      <aside className=\"hidden md:flex w-[250px] shrink-0 bg-bg border-r border-border flex-col justify-between overflow-y-auto\">\n        <div className=\"p-5 pb-0\">\n          <div className=\"flex items-center gap-3 mb-4\">\n            <Logo className=\"w-9 h-9\" />\n            <h1 className=\"font-bold text-lg\">{t('product_name')}</h1>\n          </div>\n          <Navigation onNavigate={handleNavigate} />\n        </div>\n        <div className=\"px-5 my-2\">\n          <PetWidget onOpenDonation={openDonation} />\n        </div>\n        <div className=\"mt-auto p-5 pt-3 border-t border-border\">\n          <StatusDisplay\n            status={status}\n            gatewayPort={gatewayPort}\n            retrying={retrying}\n            onRetry={handleRetry}\n            onChangePort={handleChangePort}\n          />\n          <button\n            onClick={openFeedback}\n            className=\"mt-3 w-full flex items-center justify-center gap-2 border border-border px-3 py-2 text-xs font-medium text-textMuted hover:text-accent-neon hover:border-accent-neon/50 transition-colors\"\n            aria-label={t('feedback_title')}\n          >\n            <Lightbulb aria-hidden size={15} />\n            {t('feedback_title')}\n          </button>\n        </div>\n      </aside>\n      <div className=\"flex flex-1 min-w-0 flex-col\">\n        <header className=\"md:hidden border-b border-border bg-bg p-3 flex items-center gap-3\">\n          <button\n            ref={menuButton}\n            aria-label={t('menu')}\n            aria-expanded={menuOpen}\n            aria-controls=\"mobile-navigation\"\n            onClick={() => setMenuOpen((open) => reduceMenu(open, { type: 'toggle' }))}\n            className=\"p-2 text-accent-neon\"\n          >\n            {menuOpen ? <X aria-hidden /> : <Menu aria-hidden />}\n          </button>\n          <Logo className=\"w-8 h-8\" />\n          <h1 className=\"font-bold text-lg\">{t('product_name')}</h1>\n          <div className=\"ml-auto flex items-center gap-2 max-w-[60%]\">\n            <StatusDisplay\n              status={status}\n              gatewayPort={gatewayPort}\n              retrying={retrying}\n              onRetry={handleRetry}\n              onChangePort={handleChangePort}\n            />\n            <button\n              onClick={openFeedback}\n              className=\"p-2 text-textMuted hover:text-accent-neon transition-colors\"\n              aria-label={t('feedback_title')}\n              title={t('feedback_title')}\n            >\n              <Lightbulb aria-hidden size={18} />\n            </button>\n          </div>\n        </header>\n        {menuOpen && (\n          <>\n            <button\n              aria-label={t('close_menu')}\n              className=\"md:hidden fixed inset-0 z-20 bg-black/60\"\n              onClick={() => closeMenu(true)}\n            />\n            <aside\n              id=\"mobile-navigation\"\n              className=\"md:hidden fixed inset-y-0 left-0 z-30 w-[min(250px,85vw)] bg-bg border-r border-border p-5\"\n            >\n              <div className=\"mb-8\">\n                <Logo className=\"w-9 h-9\" />\n              </div>\n              <Navigation onNavigate={handleNavigate} />\n            </aside>\n          </>\n        )}\n        <main className=\"flex-1 min-w-0 overflow-hidden bg-bg\">\n          <GatewayLifecycleContext.Provider value={lifecycleValue}>\n            <Outlet />\n          </GatewayLifecycleContext.Provider>\n        </main>\n      </div>\n    </div>\n  );\n}
