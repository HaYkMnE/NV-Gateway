import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, CircleAlert, Lightbulb, Lock } from 'lucide-react';
import { api, queryKeys } from '../lib/api';
import { useConfigStore, type AppLanguage } from '../stores/config';
import { useModelsStore, type ModelEntry } from '../stores/models';
import { useModal } from '../lib/modal-context';
import { clearTipsState, focusPendingSetting, focusSettingFrom, setTipsEnabled, usePetTips } from '../pet/tips';
import { InfoTip } from '../components/InfoTip';
import { DEADLINE_ENV_NAME, deadlineDescribedBy, deadlineSecondsToMs, formatDeadlineSeconds, splitAtPlaceholder, validateDeadlineSeconds } from './requestDeadline';

// Е-1b «Request deadline»: edited in whole seconds, stored in ms. The value and
// its source are ALWAYS read from runtime state (the effective value): the
// set-app-config response carries the stored-or-default value, not the
// effective one, so after a save we only refetch runtime state.
function RequestDeadlineSection({ effectiveMs, source }: { effectiveMs: number; source: 'env' | 'config' | 'default' }) {
  const { t } = useTranslation(); const client = useQueryClient(); const { setConfig } = useConfigStore();
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const envLocked = source === 'env';
  const saved = formatDeadlineSeconds(effectiveMs);
  const save = useMutation({
    mutationFn: async (requestDeadlineMs: number) => { const config = await window.electronAPI.setAppConfig({ requestDeadlineMs }); setConfig(config); return config; },
    // Keep the typed value (and the saving state) until the refetched effective value arrives.
    onSuccess: async () => { await client.invalidateQueries({ queryKey: queryKeys.runtime }); setEditing(false); setShowSaved(true); },
    onError: () => { void client.invalidateQueries({ queryKey: queryKeys.runtime }); },
  });
  useEffect(() => { if (!showSaved) return; const timer = setTimeout(() => setShowSaved(false), 3000); return () => clearTimeout(timer); }, [showSaved]);
  const validation = editing && !envLocked ? validateDeadlineSeconds(draft) : null;
  const readOnly = envLocked || save.isPending;
  const commit = (reason: 'enter' | 'blur') => {
    if (envLocked || save.isPending || !editing) return;
    const ms = deadlineSecondsToMs(draft);
    if (ms === null) { if (reason === 'blur') setEditing(false); return; } // never sent; blur reverts to the last saved value
    if (ms === effectiveMs) { setEditing(false); return; }
    save.mutate(ms);
  };
  const envNote = envLocked ? t('deadline_env_override', { name: DEADLINE_ENV_NAME }) : '';
  const envParts = envLocked ? splitAtPlaceholder(envNote, DEADLINE_ENV_NAME) : null;
  return <section aria-labelledby="request-deadline-label" className="grid gap-2 text-sm text-textMuted border border-border bg-surface p-3"><div>
    <label id="request-deadline-label" htmlFor="request-deadline" className="block text-sm text-textMuted mb-2">{t('deadline_label')}</label>
    <div className="relative flex items-center gap-2 w-fit">
      <input id="request-deadline" dir="ltr" inputMode="numeric" value={editing ? draft : saved} readOnly={readOnly} aria-readonly={envLocked || undefined} aria-invalid={Boolean(validation)} aria-describedby={deadlineDescribedBy({ error: Boolean(validation), env: envLocked })}
        onChange={(event) => { setDraft(event.target.value); setEditing(true); setShowSaved(false); if (save.isError) save.reset(); }}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit('enter'); } }}
        onBlur={() => commit('blur')}
        className={`w-32 border py-3 pe-3 font-mono text-textMain rtl:text-right focus-visible:outline-offset-2 ${envLocked ? 'request-deadline-readonly ps-9 rtl:ps-3 rtl:pe-9 bg-surface border-dashed border-textMuted cursor-default focus-visible:outline-1 focus-visible:outline-dashed focus-visible:outline-textMuted' : validation ? 'ps-3 bg-bg border-error focus-visible:outline focus-visible:outline-2 focus-visible:outline-error' : 'ps-3 bg-bg border-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-nvidia'} ${save.isPending ? 'opacity-50' : ''}`} />
      {/* Lock sits AFTER the input so it paints above it: the global base `:focus-visible` rule gives the focused input position:relative + z-index:1. */}
      {envLocked && <span aria-hidden="true" className="request-deadline-lock pointer-events-none absolute start-2.5 top-1/2 z-[1] flex -translate-y-1/2 text-textMuted"><Lock size={14} /></span>}
    </div>
    <p id="request-deadline-help" className="text-xs text-textMuted mt-2">{t('deadline_help')}</p>
    {validation && <p id="request-deadline-error" role="alert" className="flex items-center gap-1 text-sm text-error mt-1"><CircleAlert aria-hidden="true" size={14} className="shrink-0" />{t(`deadline_${validation}`)}</p>}
    {envLocked && <p id="request-deadline-env" className="text-xs text-textMuted mt-1">{envParts ? <>{envParts[0]}<bdi dir="ltr" className="font-mono">{DEADLINE_ENV_NAME}</bdi>{envParts[1]}</> : envNote}</p>}
    <p role="status" aria-live="polite" className="flex items-center gap-1 text-sm text-nvidia mt-1">{showSaved ? <><Check aria-hidden="true" size={14} className="shrink-0" />{t('deadline_saved')}</> : ''}</p>
    {save.isError && <p role="alert" className="text-error mt-1">{t('deadline_save_error')}</p>}
  </div></section>;
}

/**
 * The refresh clock must follow the ACTIVE UI language, not the host one: a
 * 12-hour host locale printed "11:02:19 PM" inside an English UI (the same
 * defect class as Models.tsx's date). The tag is validated first — a malformed
 * tag ('en_US') throws RangeError during render, and a well-formed but
 * unsupported one ('xx-YY') is ignored by Intl, which then silently formats with
 * the HOST locale. Both resolve to 'en', the i18n default.
 */
export function formatRefreshTime(timestamp: number, locale?: string): string {
  let resolved = 'en';
  if (locale) {
    try {
      if (Intl.DateTimeFormat.supportedLocalesOf([locale]).length > 0) resolved = locale;
    } catch {
      resolved = 'en';
    }
  }
  return new Date(timestamp).toLocaleTimeString(resolved);
}

function ModelsSection() {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const { models, loading, error, lastRefreshed, setModels, setLoading, setError, setLastRefreshed } = useModelsStore();
  // First visit: the store is not persisted and was only filled by the buttons.
  // Seed it from the same query key + fetcher Models.tsx uses, so TanStack
  // dedupes/caches a single fetch instead of starting a second loop.
  const modelsQuery = useQuery({ queryKey: queryKeys.models, queryFn: api.models });
  useEffect(() => {
    const list = modelsQuery.data?.models;
    if (Array.isArray(list)) setModels(list as ModelEntry[]);
  }, [modelsQuery.data, setModels]);

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

  const isPending = refreshMutation.isPending;

  return (
    <section aria-label={t('models_title')} className="grid gap-3 border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex items-center gap-1"><span className="text-textMain font-medium">{t('models_title')}</span><InfoTip name={t('models_title')}>{t('infotip_model_mode')}</InfoTip></div>
        <div className="flex gap-2">
          <button
            onClick={() => { if (!isPending) refreshMutation.mutate(); }}
            aria-disabled={isPending}
            className="border border-border px-4 py-2 text-textMain aria-disabled:opacity-50 aria-disabled:focus-visible:opacity-100"
          >
            {t('models_refresh')}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-error">{error}</p>
      )}

      {modelsQuery.isError && !error && !loading && models.length === 0 && (
        <p role="alert" className="text-sm text-error">{t('models_error')} <button type="button" onClick={() => void modelsQuery.refetch()} className="text-nvidia">{t('retry')}</button></p>
      )}

      {!error && (loading || (modelsQuery.isPending && models.length === 0)) && (
        <p role="status" className="text-sm text-textMuted">{t('loading')}</p>
      )}

      {!loading && !modelsQuery.isPending && !modelsQuery.isError && !error && models.length === 0 && (
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
                  onChange={(e) => { if (!modeMutation.isPending) modeMutation.mutate({ id: model.id, mode: e.target.value as 'day' | 'night' | 'auto' }); }}
                  aria-disabled={modeMutation.isPending}
                  className="bg-surface border border-border px-2 py-1 text-sm text-textMain aria-disabled:opacity-50 aria-disabled:focus-visible:opacity-100"
                  aria-label={t('models_mode_label') + ' — ' + model.name}
                >
                  <option value="day">{t('mode_day')}</option>
                  <option value="night">{t('mode_night')}</option>
                  <option value="auto">{t('mode_auto')}</option>
                </select>
                <label className="flex items-center gap-2 text-sm text-textMuted py-1.5">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={model.enabled}
                    aria-disabled={toggleMutation.isPending}
                    onChange={(e) => { if (!toggleMutation.isPending) toggleMutation.mutate({ id: model.id, enabled: e.target.checked }); }}
                    className="aria-disabled:opacity-50 aria-disabled:focus-visible:opacity-100"
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
          {t('last_refresh')} {formatRefreshTime(lastRefreshed, i18n.language)}
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
  // In-place switches: optimistic runtime-cache update (no snap-back until the refetch), rollback on error.
  const autoLaunch = useMutation({ mutationFn: window.electronAPI.toggleAutoLaunch, onMutate: async (value: boolean) => { await client.cancelQueries({ queryKey: queryKeys.runtime }); const previous = client.getQueryData(queryKeys.runtime); client.setQueryData(queryKeys.runtime, (prev: unknown) => prev && typeof prev === 'object' ? { ...(prev as object), autoLaunch: value } : prev); return { previous }; }, onError: (_error, _value, context) => { client.setQueryData(queryKeys.runtime, context?.previous); }, onSettled: () => client.invalidateQueries({ queryKey: queryKeys.runtime }) });
  const llmStats = useMutation({ mutationFn: async (llmStatsEnabled: boolean) => { const config = await window.electronAPI.setAppConfig({ llmStatsEnabled }); setConfig(config); return config; }, onMutate: async (value: boolean) => { await client.cancelQueries({ queryKey: queryKeys.runtime }); const previous = client.getQueryData(queryKeys.runtime); client.setQueryData(queryKeys.runtime, (prev: unknown) => prev && typeof prev === 'object' ? { ...(prev as object), llmStatsEnabled: value } : prev); return { previous }; }, onError: (_error, _value, context) => { client.setQueryData(queryKeys.runtime, context?.previous); }, onSettled: () => client.invalidateQueries({ queryKey: queryKeys.runtime }) });
  const performanceModeMutation = useMutation({ mutationFn: async (mode: 'day' | 'night' | 'auto') => { const config = await window.electronAPI.setAppConfig({ performanceMode: mode }); setConfig(config); await client.cancelQueries({ queryKey: queryKeys.runtime }); client.setQueryData(queryKeys.runtime, (prev: unknown) => prev && typeof prev === 'object' ? { ...(prev as object), performanceMode: mode } : prev); return config; }, onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.runtime }) });
  const language = async (value: AppLanguage) => { const config = await window.electronAPI.setAppConfig({ language: value }); setConfig(config); await i18n.changeLanguage(value); client.setQueryData(queryKeys.runtime, (prev: unknown) => prev && typeof prev === 'object' ? { ...prev as object, language: value } : prev); client.invalidateQueries({ queryKey: queryKeys.runtime }); };
  const setPerformanceMode = (mode: 'day' | 'night' | 'auto') => { performanceModeMutation.mutate(mode); };
  const performanceBusy = performanceModeMutation.isPending;
  const rerun = async () => { if (!window.confirm(t('confirm_reset'))) return; const config = await window.electronAPI.setAppConfig({ setupComplete: false }); setConfig(config); clearTipsState(); navigate('/wizard'); };
  const tips = usePetTips();
  // Pet-advisor target page (wave 6B): see Dashboard for the same flow.
  const location = useLocation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pendingFocus = useRef<unknown>(focusSettingFrom(location.state));
  useLayoutEffect(() => { if (pendingFocus.current !== null) headingRef.current?.focus(); }, []);
  useEffect(() => {
    if (pendingFocus.current === null || query.isPending) return;
    focusPendingSetting(pendingFocus.current);
    pendingFocus.current = null;
    navigate(location.pathname, { replace: true, state: null });
  }, [query.isPending]);
  const update = updatesQuery.isError ? { state: 'error' as const, version: null, percent: null } : updatesQuery.data ?? null;
  const updateBusy = update !== null && (update.state === 'checking' || update.state === 'downloading');
  const updateStatusText = `${t(`update_state_${update?.state ?? 'none'}`)}${update?.state === 'downloading' && update.percent !== null ? ` — ${t('update_progress', { percent: update.percent })}` : ''}${update?.version ? ` — ${t('update_version', { version: update.version })}` : ''}`;
  const body = query.isPending ? <div role="status">{t('loading')}</div> : query.isError || !query.data ? <div role="alert">{t('settings_error')} <button onClick={() => void query.refetch()} className="text-nvidia">{t('retry')}</button></div> : <div className="max-w-xl grid gap-6">
    <label className="grid gap-2 text-sm text-textMuted">{t('language')}<select id="setting-language" value={query.data.language} onChange={(event) => void language(event.target.value as AppLanguage)} className="bg-surface border border-border p-3 text-textMain rounded focus:outline-none focus:border-nvidia"><option value="en">{t('english')}</option><option value="zh">{t('chinese')}</option><option value="es">{t('spanish')}</option><option value="hi">{t('hindi')}</option><option value="fr">{t('french')}</option><option value="ar">{t('arabic')}</option><option value="ru">{t('russian')}</option></select></label>
    <section aria-label={t('models_mode_label')} className="grid gap-2 text-sm text-textMuted border border-border bg-surface p-3">
      <div className="relative flex items-center gap-1"><span>{t('models_mode_label')}</span><InfoTip name={t('models_mode_label')}><ul className="grid gap-1"><li>{t('mode_day_help')}</li><li>{t('mode_night_help')}</li><li>{t('mode_auto_help')}</li></ul></InfoTip></div>
      <div role="radiogroup" aria-label={t('models_mode_label')} className="flex flex-wrap gap-2">
        {(['day', 'night', 'auto'] as const).map((mode) => <button key={mode} id={query.data.performanceMode === mode ? 'setting-performance-mode' : undefined} type="button" role="radio" aria-checked={query.data.performanceMode === mode} onClick={() => { if (!performanceBusy) setPerformanceMode(mode); }} aria-disabled={performanceBusy} className={`border px-4 py-2 text-textMain ${query.data.performanceMode === mode ? 'border-nvidia bg-nvidia/10 text-nvidia' : 'border-border hover:text-accent-neon'} aria-disabled:opacity-50 aria-disabled:focus-visible:opacity-100`}>{t(`mode_${mode}`)}</button>)}
      </div>
    </section>
    <RequestDeadlineSection effectiveMs={query.data.requestDeadlineMs} source={query.data.requestDeadlineSource} />
    <label className="flex items-center justify-between gap-4 border border-border bg-surface p-4"><span>{t('auto_launch')}</span><input id="setting-auto-launch" type="checkbox" role="switch" checked={query.data.autoLaunch} aria-disabled={autoLaunch.isPending} onChange={(event) => { if (!autoLaunch.isPending) autoLaunch.mutate(event.target.checked); }} className="aria-disabled:opacity-50 aria-disabled:focus-visible:opacity-100" /></label>{autoLaunch.isError && <p role="alert" className="text-error">{t('auto_launch_error')}</p>}
    <div className="grid gap-2 border border-border bg-surface p-4"><label className="flex items-center justify-between gap-4 py-1"><span>{t('settings_tips')}</span><input id="setting-tips" type="checkbox" role="switch" checked={tips.enabled} aria-describedby="setting-tips-help" onChange={(event) => setTipsEnabled(event.target.checked)} /></label><p id="setting-tips-help" className="text-xs text-textMuted">{t('settings_tips_help')}</p></div>
    <div className="grid gap-2 border border-border bg-surface p-4"><label className="flex items-center justify-between gap-4 py-1"><span>{t('settings_llm_stats')}</span><input id="setting-llm-stats" type="checkbox" role="switch" checked={query.data.llmStatsEnabled !== false} aria-describedby="setting-llm-stats-help" aria-disabled={llmStats.isPending} onChange={(event) => { if (!llmStats.isPending) llmStats.mutate(event.target.checked); }} className="aria-disabled:opacity-50 aria-disabled:focus-visible:opacity-100" /></label><p id="setting-llm-stats-help" className="text-xs text-textMuted">{t('settings_llm_stats_help')}</p></div>
    <section aria-label={t('updates')} className="grid gap-3 border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-4"><span>{t('updates')}</span><button id="setting-updates" onClick={() => { if (!(checkUpdates.isPending || updateBusy)) checkUpdates.mutate(); }} aria-disabled={checkUpdates.isPending || updateBusy} className="border border-border px-4 py-2">{t('update_check')}</button></div>
      <p role="status" className="text-sm text-textMuted">{updateStatusText}</p>
    </section>
    <dl className="grid grid-cols-2 gap-3 border border-border bg-surface p-4"><dt>{t('current_status')}</dt><dd>{t(`gateway_${query.data.status.state}`)}</dd><dt>{t('port')}</dt><dd dir="ltr" className="font-mono">{query.data.status.port ?? query.data.gatewayPort}</dd><dt>{t('version')}</dt><dd dir="ltr" className="font-mono">{query.data.version}</dd></dl>
    <ModelsSection />
    <div className="flex flex-wrap gap-3"><button onClick={() => navigate('/wizard?mode=change')} className="bg-nvidia text-bg px-4 py-2">{t('change_port')}</button><InfoTip name={t('change_port')}>{t('infotip_change_port')}</InfoTip><button onClick={() => void rerun()} className="border border-border px-4 py-2 text-textMuted">{t('reset_wizard')}</button></div>
    <section aria-label={t('feedback_title')} className="grid gap-3 border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-4">
        <span className="text-textMain font-medium">{t('feedback_title')}</span>
        <button onClick={() => openFeedback()} className="flex items-center gap-2 border border-border px-4 py-2 text-textMain hover:text-accent-neon">
          <Lightbulb aria-hidden size={16} />
          {t('feedback_title')}
        </button>
      </div>
    </section>
  </div>;
  return <div className="flex flex-col h-full overflow-y-auto p-4 sm:p-8"><h2 ref={headingRef} tabIndex={-1} className="text-2xl font-bold mb-8">{t('settings')}</h2>{body}</div>;
}
