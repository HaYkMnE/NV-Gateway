import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Lightbulb } from 'lucide-react';
import { api, queryKeys } from '../lib/api';
import { useConfigStore, type AppLanguage } from '../stores/config';
import { useModelsStore } from '../stores/models';
import { useModal } from '../lib/modal-context';

function ModelsSection() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { models, loading, error, lastRefreshed, setModels, setLoading, setError, setLastRefreshed } = useModelsStore();

  const refreshMutation = useMutation({
    mutationFn: async () => {
      setLoading(true);
      setError(null);
      await window.electronAPI.refreshModels();
      const result = await window.electronAPI.getModels();
      setModels(result.models as Array<{ id: string; name: string; enabled: boolean; mode: 'day' | 'night' | 'auto'; deprecated: boolean }>);
      setLastRefreshed(Date.now());
      setLoading(false);
      return result;
    },
    onError: (err: Error) => {
      setError(err.message);
      setLoading(false);
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.models }),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      await window.electronAPI.toggleModel(id, enabled);
      return { id, enabled };
    },
    onSuccess: ({ id, enabled }) => {
      // Read live state (not closure-captured `models`) — strict Level 1 parity
      // with Models.tsx's onSuccess pattern (avoids stale-snapshot optimistic
      // maps when multiple toggles fire within one render cycle).
      setModels(useModelsStore.getState().models.map((m) => (m.id === id ? { ...m, enabled } : m)));
    },
    onError: (err: Error) => {
      setError(err.message);
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.models }),
  });

  const modeMutation = useMutation({
    mutationFn: async ({ id, mode }: { id: string; mode: 'day' | 'night' | 'auto' }) => {
      await window.electronAPI.updateModelSettings(id, { mode });
      return { id, mode };
    },
    onSuccess: ({ id, mode }) => {
      // Same stale-closure parity fix as toggleMutation above.
      setModels(useModelsStore.getState().models.map((m) => (m.id === id ? { ...m, mode } : m)));
    },
    onError: (err: Error) => {
      setError(err.message);
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.models }),
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      setLoading(true);
      setError(null);
      await window.electronAPI.refreshModels();
      const result = await window.electronAPI.getModels();
      setModels(result.models as Array<{ id: string; name: string; enabled: boolean; mode: 'day' | 'night' | 'auto'; deprecated: boolean }>);
      setLastRefreshed(Date.now());
      setLoading(false);
      return result;
    },
    onError: (err: Error) => {
      setError(err.message);
      setLoading(false);
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.models }),
  });

  const isPending = refreshMutation.isPending || resetMutation.isPending;

  return (
    <section aria-label={t('models_title')} className="grid gap-3 border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-4">
        <span className="text-textMain font-medium">{t('models_title')}</span>
        <div className="flex gap-2">
          <button
            onClick={() => refreshMutation.mutate()}
            disabled={isPending}
            className="border border-border px-4 py-2 text-textMain disabled:opacity-50"
          >
            {t('models_refresh')}
          </button>
          <button
            onClick={() => resetMutation.mutate()}
            disabled={isPending}
            className="border border-border px-4 py-2 text-textMuted disabled:opacity-50"
          >
            {t('models_reset')}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-error">{error}</p>
      )}

      {loading && (
        <p role="status" className="text-sm text-textMuted">{t('loading')}</p>
      )}

      {!loading && models.length === 0 && !error && (
        <p className="text-sm text-textMuted">{t('models_available')}</p>
      )}

      {models.length > 0 && (
        <ul className="grid gap-2">
          {models.map((model) => (
            <li
              key={model.id}
              className="flex flex-wrap items-center justify-between gap-3 border border-border bg-surface p-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-sm text-textMain truncate">{model.name}</span>
                {model.deprecated && (
                  <span className="text-xs text-textMuted border border-border px-2 py-0.5">{t('models_deprecated')}</span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <select
                  value={model.mode}
                  onChange={(e) => modeMutation.mutate({ id: model.id, mode: e.target.value as 'day' | 'night' | 'auto' })}
                  disabled={modeMutation.isPending}
                  className="bg-surface border border-border px-2 py-1 text-sm text-textMain disabled:opacity-50"
                  aria-label={t('models_title')}
                >
                  <option value="day">{t('mode_day')}</option>
                  <option value="night">{t('mode_night')}</option>
                  <option value="auto">{t('mode_auto')}</option>
                </select>
                <label className="flex items-center gap-2 text-sm text-textMuted">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={model.enabled}
                    disabled={toggleMutation.isPending}
                    onChange={(e) => toggleMutation.mutate({ id: model.id, enabled: e.target.checked })}
                  />
                  <span>{t('models_enabled')}</span>
                </label>
              </div>
            </li>
          ))}
        </ul>
      )}

      {lastRefreshed && !loading && (
        <p className="text-xs text-textMuted">
          {t('last_refresh')}: {new Date(lastRefreshed).toLocaleTimeString()}
        </p>
      )}
    </section>
  );
}

export function Settings() {
  const { t, i18n } = useTranslation(); const navigate = useNavigate(); const client = useQueryClient(); const { setConfig } = useConfigStore(); const { openFeedback } = useModal();
  // Runtime state changes only through this UI's own mutations (each of which
  // invalidates this query immediately) or through rare external config edits;
  // a 15s poll is a safety net, not the freshness mechanism. Every call costs
  // main a synchronous config-file read (get-runtime-state in src/main), so
  // 3s was ~20 blocking reads/min for information that virtually never changes.
  const query = useQuery({ queryKey: queryKeys.runtime, queryFn: api.runtime, refetchInterval: 15000 });
  // Poll fast only while an update check/download is actually in flight (the
  // progress UX needs it); idle states change on user actions and updater
  // events, not on a 2s cadence.
  const updatesQuery = useQuery({
    queryKey: queryKeys.updates,
    queryFn: api.updateStatus,
    refetchInterval: (q) => {
      const state = (q.state.data as UpdaterStatus | undefined)?.state;
      return state === 'checking' || state === 'downloading' ? 2000 : 10000;
    },
  });
  const checkUpdates = useMutation({ mutationFn: window.electronAPI.checkForUpdates, onSettled: () => client.invalidateQueries({ queryKey: queryKeys.updates }) });
  const autoLaunch = useMutation({ mutationFn: window.electronAPI.toggleAutoLaunch, onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.runtime }) });
  const performanceModeMutation = useMutation({ mutationFn: async (mode: 'day' | 'night' | 'auto') => { const config = await window.electronAPI.setAppConfig({ performanceMode: mode }); setConfig(config); client.setQueryData(queryKeys.runtime, (prev: unknown) => prev && typeof prev === 'object' ? { ...(prev as object), performanceMode: mode } : prev); return config; }, onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.runtime }) });
  const language = async (value: AppLanguage) => { const config = await window.electronAPI.setAppConfig({ language: value }); setConfig(config); await i18n.changeLanguage(value); client.setQueryData(queryKeys.runtime, (prev: unknown) => prev && typeof prev === 'object' ? { ...prev as object, language: value } : prev); client.invalidateQueries({ queryKey: queryKeys.runtime }); };
  const setPerformanceMode = (mode: 'day' | 'night' | 'auto') => { performanceModeMutation.mutate(mode); };
  const performanceBusy = performanceModeMutation.isPending;
  const rerun = async () => { if (!window.confirm(t('confirm_reset'))) return; const config = await window.electronAPI.setAppConfig({ setupComplete: false }); setConfig(config); navigate('/wizard'); };
  if (query.isPending) return <div role="status" className="p-8">{t('loading')}</div>;
  if (query.isError || !query.data) return <div role="alert" className="p-8">{t('settings_error')} <button onClick={() => void query.refetch()} className="text-nvidia">{t('retry')}</button></div>;
  const update = updatesQuery.isError ? { state: 'error' as const, version: null, percent: null } : updatesQuery.data ?? null;
  const updateBusy = update !== null && (update.state === 'checking' || update.state === 'downloading');
  const updateStatusText = `${t(`update_state_${update?.state ?? 'none'}`)}${update?.state === 'downloading' && update.percent !== null ? ` — ${t('update_progress', { percent: update.percent })}` : ''}${update?.version ? ` — ${t('update_version', { version: update.version })}` : ''}`;
  return <div className="flex flex-col h-full overflow-y-auto p-4 sm:p-8"><h2 className="text-2xl font-bold mb-8">{t('settings')}</h2><div className="max-w-xl grid gap-6">
    <label className="grid gap-2 text-sm text-textMuted">{t('language')}<select value={query.data.language} onChange={(event) => void language(event.target.value as AppLanguage)} className="bg-surface border border-border p-3 text-textMain rounded focus:outline-none focus:border-nvidia"><option value="en">{t('english')}</option><option value="zh">{t('chinese')}</option><option value="es">{t('spanish')}</option><option value="hi">{t('hindi')}</option><option value="fr">{t('french')}</option><option value="ar">{t('arabic')}</option><option value="ru">{t('russian')}</option></select></label>
    <section aria-label={t('models_mode_label')} className="grid gap-2 text-sm text-textMuted border border-border bg-surface p-3">
      <span>{t('models_mode_label')}</span>
      <div role="radiogroup" aria-label={t('models_mode_label')} className="flex flex-wrap gap-2">
        {(['day', 'night', 'auto'] as const).map((mode) => <button key={mode} type="button" role="radio" aria-checked={query.data.performanceMode === mode} onClick={() => setPerformanceMode(mode)} disabled={performanceBusy} className={`border px-4 py-2 text-textMain ${query.data.performanceMode === mode ? 'border-nvidia bg-nvidia/10 text-nvidia' : 'border-border hover:text-accent-neon'} disabled:opacity-50`}>{t(`mode_${mode}`)}</button>)}
      </div>
    </section>
    <label className="flex items-center justify-between gap-4 border border-border bg-surface p-4"><span>{t('auto_launch')}</span><input type="checkbox" role="switch" checked={query.data.autoLaunch} disabled={autoLaunch.isPending} onChange={(event) => autoLaunch.mutate(event.target.checked)} /></label>{autoLaunch.isError && <p role="alert" className="text-error">{t('auto_launch_error')}</p>}
    <section aria-label={t('updates')} className="grid gap-3 border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-4"><span>{t('updates')}</span><button onClick={() => checkUpdates.mutate()} disabled={checkUpdates.isPending || updateBusy} className="border border-border px-4 py-2">{t('update_check')}</button></div>
      <p role="status" className="text-sm text-textMuted">{updateStatusText}</p>
    </section>
    <dl className="grid grid-cols-2 gap-3 border border-border bg-surface p-4"><dt>{t('current_status')}</dt><dd>{t(`gateway_${query.data.status.state}`)}</dd><dt>{t('port')}</dt><dd className="font-mono">{query.data.status.port ?? query.data.gatewayPort}</dd><dt>{t('version')}</dt><dd className="font-mono">{query.data.version}</dd></dl>
    <ModelsSection />
    <div className="flex flex-wrap gap-3"><button onClick={() => navigate('/wizard?mode=change')} className="bg-nvidia text-bg px-4 py-2">{t('change_port')}</button><button onClick={() => void rerun()} className="border border-border px-4 py-2 text-textMuted">{t('reset_wizard')}</button></div>
    <section aria-label={t('feedback_title')} className="grid gap-3 border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-4">
        <span className="text-textMain font-medium">{t('feedback_title')}</span>
        <button onClick={openFeedback} className="flex items-center gap-2 border border-border px-4 py-2 text-textMain hover:text-accent-neon">
          <Lightbulb aria-hidden size={16} />
          {t('feedback_title')}
        </button>
      </div>
    </section>
  </div></div>;
}
