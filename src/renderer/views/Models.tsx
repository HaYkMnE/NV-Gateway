import { useState, useMemo, useRef, useEffect, useDeferredValue } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Code,
  Copy,
  Cpu,
  Eye,
  Layers,
  RefreshCw,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import { ProviderGlyph, resolveProvider } from '../components/ProviderGlyph';
import { api, queryKeys } from '../lib/api';
import { classifyDataState, safeError } from '../lib/frontend-state';
import { useGatewayLifecycle } from '../lib/gateway-lifecycle';
import { useModelsStore } from '../stores/models';
import { useConfigStore } from '../stores/config';

interface AdminKey {
  id: string;
  accessibleModels?: string[];
}
type ModelMode = 'day' | 'night' | 'auto';
type SortBy = 'popular' | 'name' | 'updated';

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
const searchShortcut = isMac ? '⌘K' : 'Ctrl+K';

function providerSlugOf(m: { publisher?: string | null; provider?: string | null; id: string }): string | null {
  return m.publisher ?? m.provider ?? (m.id.includes('/') ? m.id.split('/')[0] : null);
}

function nameOf(id: string): string {
  return id.includes('/') ? id.split('/').slice(1).join('/') : id;
}

function formatPopularity(pop?: number | null): string | null {
  if (pop == null) return null;
  if (pop >= 1_000_000) return `${(pop / 1_000_000).toFixed(pop % 1_000_000 === 0 || pop >= 10_000_000 ? 0 : 1)}M`;
  if (pop >= 1_000) return `${(pop / 1_000).toFixed(0)}K`;
  return `${pop}`;
}

function formatLastUpdated(dateStr?: string | null): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const diffDays = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays >= 0 && diffDays < 365) return `${diffDays}d`;
  return d.toLocaleDateString();
}

interface CapabilityTag {
  id: string;
  labelKey: string;
  colorClass: string;
  borderClass: string;
  bgClass: string;
  icon: React.ReactNode;
}

function extractCapabilities(id: string, labels: string[] = [], category?: string | null): CapabilityTag[] {
  const tags: CapabilityTag[] = [];
  const lowerId = id.toLowerCase();
  const lowerLabels = labels.map((l) => l.toLowerCase());
  const cat = (category || '').toLowerCase();

  // Reasoning
  if (
    lowerId.includes('r1') ||
    lowerId.includes('reason') ||
    lowerId.includes('qwq') ||
    lowerId.includes('o1') ||
    lowerId.includes('o3') ||
    lowerLabels.some((l) => l.includes('reason'))
  ) {
    tags.push({
      id: 'reasoning',
      labelKey: 'tag_reasoning',
      colorClass: 'text-purple-300',
      borderClass: 'border-purple-700/50',
      bgClass: 'bg-purple-950/40',
      icon: <Sparkles size={11} className="shrink-0 text-purple-400" />,
    });
  }

  // Vision / Multimodal
  if (
    lowerId.includes('vision') ||
    lowerId.includes('-vl') ||
    lowerId.includes('vl-') ||
    lowerId.includes('ocr') ||
    lowerId.includes('4o') ||
    lowerId.includes('omni') ||
    lowerId.includes('pixtral') ||
    cat.includes('vision') ||
    lowerLabels.some((l) => l.includes('vision') || l.includes('image'))
  ) {
    tags.push({
      id: 'vision',
      labelKey: 'tag_vision',
      colorClass: 'text-cyan-300',
      borderClass: 'border-cyan-700/50',
      bgClass: 'bg-cyan-950/40',
      icon: <Eye size={11} className="shrink-0 text-cyan-400" />,
    });
  }

  // Code
  if (
    lowerId.includes('code') ||
    lowerId.includes('coder') ||
    lowerId.includes('starcoder') ||
    cat.includes('code') ||
    lowerLabels.some((l) => l.includes('code'))
  ) {
    tags.push({
      id: 'code',
      labelKey: 'tag_code',
      colorClass: 'text-emerald-300',
      borderClass: 'border-emerald-700/50',
      bgClass: 'bg-emerald-950/40',
      icon: <Code size={11} className="shrink-0 text-emerald-400" />,
    });
  }

  // Function Calling / Tools
  if (
    lowerId.includes('instruct') ||
    lowerLabels.some((l) => l.includes('tool') || l.includes('function'))
  ) {
    tags.push({
      id: 'function_calling',
      labelKey: 'tag_function_calling',
      colorClass: 'text-amber-300',
      borderClass: 'border-amber-700/50',
      bgClass: 'bg-amber-950/40',
      icon: <Wrench size={11} className="shrink-0 text-amber-400" />,
    });
  }

  return tags;
}

export function Models() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const lifecycle = useGatewayLifecycle();
  const { gatewayPort } = useConfigStore();
  const unavailable = lifecycle.status?.state !== 'running';

  const [mutationError, setMutationError] = useState<string | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  const [toggleAllPending, setToggleAllPending] = useState(false);

  // Search + sort state + Ctrl+K focus
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('popular');
  const [companyFilter, setCompanyFilter] = useState<string>('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const deferredQuery = useDeferredValue(query);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const modelsQuery = useQuery({ queryKey: queryKeys.models, queryFn: api.models, enabled: !unavailable });
  const keysQuery = useQuery({ queryKey: queryKeys.keys, queryFn: api.keys, enabled: !unavailable });

  const models = modelsQuery.data?.models ?? [];
  const keys = (keysQuery.data?.keys ?? []) as AdminKey[];

  const activeCount = useMemo(() => models.filter((m) => m.enabled).length, [models]);

  // Derive unique provider slugs (companies) for the company-filter chips.
  const companies = useMemo(() => {
    const slugs = new Set<string>();
    models.forEach((m) => {
      const slug = providerSlugOf(m);
      if (slug) slugs.add(slug);
    });
    return Array.from(slugs).sort((a, b) => {
      const nameA = resolveProvider(a).name;
      const nameB = resolveProvider(b).name;
      return nameA.localeCompare(nameB);
    });
  }, [models]);

  const filteredModels = useMemo(() => {
    const useQ = (deferredQuery || query).trim().toLowerCase();
    const filtered = useQ
      ? models.filter((m) => {
          if (m.id?.toLowerCase().includes(useQ)) return true;
          if (m.name?.toLowerCase().includes(useQ)) return true;
          if (nameOf(m.id ?? '').toLowerCase().includes(useQ)) return true;
          const slug = providerSlugOf(m);
          if (slug?.toLowerCase().includes(useQ)) return true;
          if (m.shortDescription?.toLowerCase().includes(useQ)) return true;
          if (m.publisher?.toLowerCase().includes(useQ)) return true;
          if (m.provider?.toLowerCase().includes(useQ)) return true;
          if (Array.isArray(m.labels) && m.labels.some((l: string) => typeof l === 'string' && l.toLowerCase().includes(useQ))) return true;
          return false;
        })
      : models;

    const companyFiltered = companyFilter ? filtered.filter((m) => providerSlugOf(m) === companyFilter) : filtered;
    const sorted = [...companyFiltered].sort((a, b) => {
      switch (sortBy) {
        case 'name': {
          return nameOf(a.id ?? '').localeCompare(nameOf(b.id ?? ''));
        }
        case 'updated': {
          const timeA = a.lastUpdated ? Date.parse(a.lastUpdated) : 0;
          const timeB = b.lastUpdated ? Date.parse(b.lastUpdated) : 0;
          const validA = Number.isFinite(timeA) && timeA > 0;
          const validB = Number.isFinite(timeB) && timeB > 0;
          if (validA && validB && timeA !== timeB) return timeB - timeA;
          if (validA) return -1;
          if (validB) return 1;
          return (a.id ?? '').localeCompare(b.id ?? '');
        }
        case 'popular':
        default: {
          const popA = typeof a.popularity === 'number' ? a.popularity : 0;
          const popB = typeof b.popularity === 'number' ? b.popularity : 0;
          if (popA !== popB) return popB - popA;
          return (a.id ?? '').localeCompare(b.id ?? '');
        }
      }
    });
    return sorted;
  }, [models, query, deferredQuery, sortBy, companyFilter]);

  const state = classifyDataState({
    pending: modelsQuery.isPending,
    error: modelsQuery.isError,
    data: modelsQuery.data?.models,
    stale: modelsQuery.isError && Boolean(modelsQuery.data),
  });

  const toggleMutation = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) => window.electronAPI.toggleModel(vars.id, vars.enabled),
    onSuccess: (_data, vars) => {
      setMutationError(null);
      void client.invalidateQueries({ queryKey: queryKeys.models });
      const prev = useModelsStore.getState().models;
      useModelsStore.getState().setModels(prev.map((m) => (m.id === vars.id ? { ...m, enabled: vars.enabled } : m)));
    },
    onError: (err) => setMutationError(t('models_toggle_error', { error: safeError(err, t('unknown_error')) })),
  });

  const modeMutation = useMutation({
    mutationFn: (vars: { id: string; mode: ModelMode }) => window.electronAPI.updateModelSettings(vars.id, { mode: vars.mode }),
    onSuccess: (_data, vars) => {
      setMutationError(null);
      void client.invalidateQueries({ queryKey: queryKeys.models });
      const prev = useModelsStore.getState().models;
      useModelsStore.getState().setModels(prev.map((m) => (m.id === vars.id ? { ...m, mode: vars.mode } : m)));
    },
    onError: (err) => setMutationError(t('models_mode_error', { error: safeError(err, t('unknown_error')) })),
  });

  const handleRefresh = () => {
    setRefreshPending(true);
    void api
      .refreshModels()
      .then(() => {
        setMutationError(null);
        void client.invalidateQueries({ queryKey: queryKeys.models });
      })
      .catch((err) => setMutationError(t('models_refresh_error', { error: safeError(err, t('unknown_error')) })))
      .finally(() => setRefreshPending(false));
  };

  const handleToggleAll = async (enabled: boolean) => {
    const toToggle = models.filter((m) => m.enabled !== enabled);
    if (toToggle.length === 0) return;
    setToggleAllPending(true);
    try {
      const updatedModels = await window.electronAPI.bulkToggleModels(enabled);
      if (Array.isArray(updatedModels)) {
        useModelsStore.getState().setModels(updatedModels);
        client.setQueryData(queryKeys.models, { models: updatedModels });
      }
      void client.invalidateQueries({ queryKey: queryKeys.models });
      setMutationError(null);
    } catch (err) {
      setMutationError(t('models_toggle_error', { error: safeError(err, t('unknown_error')) }));
    } finally {
      setToggleAllPending(false);
    }
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const copy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId(null), 2000);
    } catch {
      /* ignore */
    }
  };

  if (unavailable) {
    return (
      <div role="alert" className="flex flex-col h-full p-4 sm:p-8 min-w-0 items-center justify-center text-center">
        <AlertTriangle aria-hidden size={40} className="text-warning mb-4" />
        <p className="text-lg">{t('gateway_stopped')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full p-4 sm:p-8 min-w-0 overflow-y-auto">
      {/* Header Hub */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold text-textMain tracking-tight">{t('models_title')}</h2>
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 text-xs font-mono font-semibold bg-accent-neon/15 text-accent-neon border border-accent-neon/30 rounded-full">
                {t('models_active_count', { count: activeCount })}
              </span>
              <span className="px-2.5 py-0.5 text-xs font-mono text-textMuted bg-surface border border-border rounded-full">
                {t('models_total_count', { count: models.length })}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleRefresh}
            disabled={state === 'loading' || refreshPending}
            className="flex items-center gap-2 bg-nvidia text-bg px-4 py-2 text-sm font-semibold rounded hover:brightness-110 active:scale-95 disabled:opacity-50 transition-all cursor-pointer shadow-[0_0_12px_rgba(118,185,0,0.3)] animate-tactile-tick"
          >
            <RefreshCw aria-hidden size={16} className={refreshPending ? 'animate-spin' : ''} />
            <span>{t('models_refresh')}</span>
          </button>
        </div>
      </div>

      {mutationError && (
        <div role="alert" className="border border-error bg-error/10 text-error p-3 mb-4 break-words rounded">
          {mutationError}
        </div>
      )}

      {state === 'loading' && (
        <div role="status" className="flex-1 grid place-items-center text-textMuted font-mono">
          <div className="flex items-center gap-3">
            <RefreshCw className="animate-spin text-accent-neon" size={20} />
            <span>{t('loading')}</span>
          </div>
        </div>
      )}

      {state === 'error' && (
        <div role="alert" className="border border-error bg-error/10 text-error p-4 mb-4 break-words rounded-lg">
          <div className="font-semibold mb-1">{t('models_error')}</div>
          <div className="font-mono text-xs break-all text-error/90 mb-3">{safeError(modelsQuery.error, t('unknown_error'))}</div>
          <button
            onClick={() => void modelsQuery.refetch()}
            className="text-xs font-semibold px-3 py-1.5 bg-error/20 hover:bg-error/30 text-white rounded transition-colors"
          >
            {t('retry')}
          </button>
        </div>
      )}

      {state === 'stale' && (
        <div role="status" className="border border-warning/40 bg-warning/10 p-3 mb-4 text-xs text-warning rounded flex items-center justify-between">
          <span>{t('stale')}</span>
          <button onClick={() => void modelsQuery.refetch()} className="text-accent-neon underline hover:brightness-125">
            {t('retry')}
          </button>
        </div>
      )}

      {state === 'empty' && (
        <div className="flex-1 grid place-items-center text-textMuted py-16">
          <div className="text-center space-y-3">
            <Cpu size={40} className="mx-auto text-textMuted/60" />
            <p className="text-base">{t('models_available')}</p>
          </div>
        </div>
      )}

      {(state === 'success' || state === 'stale') && (
        <>
          {/* Cyber Filter Toolbar */}
          <div className="bg-surface/80 border border-border/80 rounded-xl p-3.5 mb-6 backdrop-blur-md">
            <div className="flex flex-wrap items-center gap-3">
              {/* Search Bar */}
              <div className="relative flex-1 min-w-[220px]">
                <Search aria-hidden size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-textMuted pointer-events-none" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('models_search_placeholder')}
                  aria-label={t('models_search_placeholder')}
                  className="w-full bg-bg border border-border/90 pl-9 pr-16 py-2 text-sm rounded-lg focus:border-accent-neon/80 focus:shadow-[0_0_10px_rgba(89,255,0,0.2)] outline-none text-textMain transition-all"
                />
                {query && (
                  <button
                    onClick={() => setQuery('')}
                    className="absolute right-9 top-1/2 -translate-y-1/2 text-textMuted hover:text-textMain p-1"
                    aria-label={t('models_clear_search')}
                  >
                    <X aria-hidden size={14} />
                  </button>
                )}
                <kbd aria-hidden="true" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-mono text-textMuted/70 bg-surface px-1.5 py-0.5 border border-border rounded hidden sm:block">
                  {searchShortcut}
                </kbd>
              </div>

              {/* Sort By */}
              <label className="flex items-center gap-2 text-xs font-medium text-textMuted">
                <span>{t('models_sort_label')}</span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortBy)}
                  className="bg-bg border border-border/90 text-textMain px-2.5 py-1.5 text-xs rounded-lg outline-none focus:border-accent-neon/60"
                  aria-label={t('models_sort_label')}
                >
                  <option value="popular">{t('models_sort_popular')}</option>
                  <option value="name">{t('models_sort_name')}</option>
                  <option value="updated">{t('models_sort_updated')}</option>
                </select>
              </label>

              {/* Bulk Toggle Buttons */}
              <div className="flex items-center gap-2 ml-auto">
                <button
                  type="button"
                  onClick={() => void handleToggleAll(true)}
                  disabled={toggleAllPending}
                  className="px-3 py-1.5 text-xs font-semibold border border-border hover:border-accent-neon/50 bg-bg hover:bg-surface text-textMain rounded-lg disabled:opacity-50 transition-all cursor-pointer animate-tactile-tick"
                >
                  {t('models_enable_all')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleToggleAll(false)}
                  disabled={toggleAllPending}
                  className="px-3 py-1.5 text-xs font-semibold border border-border hover:border-error/50 bg-bg hover:bg-surface text-textMuted hover:text-error rounded-lg disabled:opacity-50 transition-all cursor-pointer animate-tactile-tick"
                >
                  {t('models_disable_all')}
                </button>
              </div>
            </div>

            {/* Interactive Company Cyber-Chips Bar */}
            {companies.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border/50">
                <div className="flex flex-wrap gap-1.5 items-center" role="toolbar" aria-label={t('models_company_filter')}>
                  {/* All Companies Chip */}
                  <button
                    type="button"
                    role="button"
                    aria-pressed={companyFilter === ''}
                    aria-label={t('models_all_companies')}
                    onClick={() => setCompanyFilter('')}
                    className={`group flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-all cursor-pointer select-none animate-tactile-tick border ${
                      companyFilter === ''
                        ? 'border-accent-neon/80 bg-accent-neon/15 text-accent-neon shadow-[0_0_10px_rgba(89,255,0,0.25)] font-bold'
                        : 'border-border/80 bg-surface/50 text-textMuted hover:text-textMain hover:border-border hover:bg-surface font-medium'
                    }`}
                  >
                    <Layers size={13} className={`shrink-0 ${companyFilter === '' ? 'text-accent-neon' : 'text-textMuted group-hover:text-textMain'}`} />
                    <span>{t('models_all_companies')}</span>
                  </button>

                  {/* Individual Company Chips */}
                  {companies.map((slug) => {
                    const providerInfo = resolveProvider(slug);
                    const isSelected = companyFilter === slug;
                    return (
                      <button
                        key={slug}
                        type="button"
                        role="button"
                        aria-pressed={isSelected}
                        aria-label={providerInfo.name}
                        onClick={() => setCompanyFilter((prev) => (prev === slug ? '' : slug))}
                        style={
                          isSelected
                            ? {
                                borderColor: providerInfo.color,
                                backgroundColor: providerInfo.tagBg,
                                color: providerInfo.tagText,
                                boxShadow: `0 0 10px ${providerInfo.glowColor}`,
                              }
                            : undefined
                        }
                        className={`group flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-all cursor-pointer select-none animate-tactile-tick border ${
                          isSelected
                            ? 'font-bold'
                            : 'border-border/80 bg-surface/50 text-textMuted hover:text-textMain hover:border-border hover:bg-surface font-medium'
                        }`}
                      >
                        <ProviderGlyph provider={slug} size={14} color={providerInfo.color} />
                        <span>{providerInfo.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Catalog Grid */}
          {filteredModels.length === 0 ? (
            <div className="flex-1 grid place-items-center text-textMuted py-12">
              <p className="text-sm font-mono">{t('models_no_models_found')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4 pb-6">
              {filteredModels.map((model) => {
                const keysCount = keys.filter((k) => Array.isArray(k.accessibleModels) && k.accessibleModels.includes(model.id)).length;
                const keysTotal = keys.length;
                const providerSlug = providerSlugOf(model);
                const providerInfo = resolveProvider(providerSlug);
                const capabilityTags = extractCapabilities(model.id, model.labels ?? [], model.category);
                const isExpanded = expandedIds.has(model.id);

                const [namespace, heroName] = model.id.includes('/')
                  ? [model.id.split('/')[0], model.id.split('/').slice(1).join('/')]
                  : ['', model.id];

                const curlSnippet = `curl http://127.0.0.1:${gatewayPort}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $GATEWAY_TOKEN" \\
  -d '{
    "model": "${model.id}",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;

                return (
                  <section
                    key={model.id}
                    className={`relative rounded-xl p-5 flex flex-col justify-between transition-all duration-200 overflow-hidden border ${
                      model.enabled
                        ? 'border-border/90 hover:border-accent-neon/60 shadow-lg'
                        : 'border-border/60 bg-surface/60 opacity-80 hover:opacity-100 hover:border-border'
                    }`}
                    style={
                      model.enabled
                        ? {
                            background: `radial-gradient(ellipse 90% 60% at 20% 0%, ${providerInfo.glowColor} 0%, rgba(13, 17, 14, 0.98) 75%), #0D110E`,
                          }
                        : undefined
                    }
                  >
                    {/* Active model neon top accent line */}
                    {model.enabled && (
                      <div
                        className="absolute top-0 inset-x-0 h-[2px] rounded-t-xl"
                        style={
                          {\n                            background: `linear-gradient(90deg, transparent 0%, ${providerInfo.borderAccent} 50%, transparent 100%)`,\n                          }
                        }
                      />
                    )}

                    <div>
                      {/* Card Header (Provider Badge + Capability Tags + Status Flags) */}
                      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 mb-3">
                        {/* Provider Badge */}
                        <div
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-bold tracking-wider uppercase shrink-0"
                          style={{
                            backgroundColor: providerInfo.tagBg,
                            borderColor: `${providerInfo.color}40`,
                            color: providerInfo.tagText,
                          }}
                        >
                          <ProviderGlyph provider={providerSlug} size={15} color={providerInfo.color} />
                          <span>{providerInfo.name}</span>
                        </div>

                        {/* Status Badges (Free, Downloadable, Deprecated) */}
                        <div className="flex flex-wrap items-center gap-1.5">
                          {model.freeEndpoint && (
                            <span className="bg-purple-950/70 text-purple-300 border border-purple-700/60 text-[10px] font-bold px-2 py-0.5 rounded-full">
                              {t('models_free_endpoint')}
                            </span>
                          )}
                          {model.downloadable && (
                            <span className="bg-cyan-950/70 text-cyan-300 border border-cyan-700/60 text-[10px] font-bold px-2 py-0.5 rounded-full">
                              {t('models_downloadable')}
                            </span>
                          )}
                          {model.deprecated && (
                            <span className="bg-amber-950/70 text-amber-300 border border-amber-700/60 text-[10px] font-bold px-2 py-0.5 rounded-full">
                              {t('models_deprecated')}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Card Title (Namespace + Crisp Bold Hero Name) */}
                      <div className="mt-2 mb-1.5">
                        {namespace && (
                          <div className="text-[11px] font-mono text-textMuted tracking-wider font-semibold uppercase flex items-center gap-1 mb-0.5">
                            <span>{namespace}</span>
                            <span className="text-border-soft">/</span>
                          </div>
                        )}
                        <h3 className="text-base sm:text-lg font-bold text-textMain tracking-tight break-words">
                          {heroName}
                        </h3>
                      </div>

                      {/* Card Description */}
                      <p className="text-xs text-[#9EABB2] line-clamp-2 leading-relaxed min-h-[32px] mt-1">
                        {model.shortDescription || t('models_default_description', { provider: providerInfo.name })}
                      </p>

                      {/* Capability & Category Tags Row */}
                      <div className="flex flex-wrap items-center justify-between gap-2 mt-3.5 text-xs">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {capabilityTags.map((cap) => (
                            <span
                              key={cap.id}
                              className={`flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${cap.bgClass} ${cap.borderClass} ${cap.colorClass}`}
                            >
                              {cap.icon}
                              <span>{t(cap.labelKey as any)}</span>
                            </span>
                          ))}
                        </div>

                        {/* Popularity & Last Updated */}
                        <div className="flex items-center gap-3 text-[11px] text-textMuted font-mono shrink-0 ml-auto">
                          {model.popularity != null && <span title={t('models_popularity', { count: model.popularity })}>↓ {formatPopularity(model.popularity)}</span>}
                          {model.lastUpdated && <span>⏱ {formatLastUpdated(model.lastUpdated)}</span>}
                        </div>
                      </div>
                    </div>

                    {/* Card Action Controls & Expand Button */}
                    <div className="mt-4 pt-3 border-t border-border/70">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-3">
                          {/* Tactile Glowing Toggle Switch */}
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={model.enabled}
                              aria-label={`${t('models_enabled')} ${model.id}`}
                              disabled={toggleMutation.isPending}
                              onClick={() => toggleMutation.mutate({ id: model.id, enabled: !model.enabled })}
                              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-all duration-200 cursor-pointer animate-tactile-tick ${
                                model.enabled
                                  ? 'bg-accent-neon shadow-[0_0_12px_rgba(89,255,0,0.6)]'
                                  : 'bg-white/15 hover:bg-white/20'
                              }`}
                            >
                              <span
                                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-md transition-transform duration-200 ${
                                  model.enabled ? 'translate-x-6 bg-black' : 'translate-x-1'
                                }`}
                              />
                            </button>
                            <span className="text-xs font-semibold text-textMuted">{t('models_enabled')}</span>
                          </div>

                          {/* Day/Night/Auto Mode Selector */}
                          <label className="flex items-center gap-1.5 text-xs text-textMuted">
                            <select
                              aria-label={`${t('models_mode_label')} ${model.id}`}
                              value={model.mode}
                              disabled={modeMutation.isPending}
                              onChange={(e) => modeMutation.mutate({ id: model.id, mode: e.target.value as ModelMode })}
                              className="bg-bg border border-border px-2 py-1 text-xs rounded text-textMain outline-none focus:border-accent-neon/50"
                            >
                              <option value="day">{t('mode_day')}</option>
                              <option value="night">{t('mode_night')}</option>
                              <option value="auto">{t('mode_auto')}</option>
                            </select>
                          </label>

                          {/* Key Quorum Battery / LED Meter */}
                          <div
                            className="flex items-center gap-1.5 px-2.5 py-1 bg-bg border border-border/80 rounded-md"
                            title={t('models_quorum_active', { count: keysCount, total: keysTotal })}
                          >
                            <div className="flex items-center gap-1">
                              {Array.from({ length: Math.max(keysTotal, 1) }).map((_, idx) => {
                                const isLedActive = idx < keysCount;
                                return (
                                  <span
                                    key={idx}
                                    className={`w-1.5 h-2.5 rounded-xs transition-all ${
                                      isLedActive
                                        ? 'bg-accent-neon shadow-[0_0_6px_#59FF00]'
                                        : 'bg-white/15'
                                    }`}
                                  />
                                );
                              })}
                            </div>
                            <span className="text-[11px] font-mono text-textMuted">
                              {keysCount}/{keysTotal} {t('keys_short')}
                            </span>
                          </div>
                        </div>

                        {/* Expand Details / Inspector Button */}
                        <button
                          type="button"
                          onClick={() => toggleExpanded(model.id)}
                          className="flex items-center gap-1 text-xs font-medium text-textMuted hover:text-accent-neon transition-colors ml-auto cursor-pointer"
                        >
                          <span>{isExpanded ? t('models_hide_details') : t('models_details')}</span>
                          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                      </div>

                      {/* Expandable Inspector Drawer */}
                      {isExpanded && (
                        <div className="mt-3.5 p-3.5 bg-bg/90 border border-border/80 rounded-lg space-y-3">
                          {/* 1-Click Copy Model ID */}
                          <div className="flex items-center justify-between gap-2 pb-2 border-b border-border/50">
                            <div className="min-w-0 flex-1">
                              <div className="text-[10px] text-textMuted uppercase font-bold tracking-wider">{t('models_full_id')}</div>
                              <code className="font-mono text-xs text-accent-neon break-all select-all">{model.id}</code>
                            </div>
                            <button
                              type="button"
                              onClick={() => copy(model.id, `model-id-${model.id}`)}
                              className="px-2.5 py-1.5 border border-border hover:border-accent-neon/50 bg-surface hover:bg-bg text-accent-neon text-xs flex items-center gap-1.5 shrink-0 rounded transition-all cursor-pointer animate-tactile-tick"
                            >
                              {copiedId === `model-id-${model.id}` ? <Check size={13} /> : <Copy size={13} />}
                              <span>{copiedId === `model-id-${model.id}` ? t('copied') : t('models_copy_id')}</span>
                            </button>
                          </div>

                          {/* cURL Snippet Preview */}
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-1.5 text-[10px] text-textMuted uppercase font-bold tracking-wider">
                                <Terminal size={12} className="text-nvidia" />
                                <span>{t('models_curl_preview')}</span>
                              </div>
                              <button
                                type="button"
                                onClick={() => copy(curlSnippet, `curl-${model.id}`)}
                                className="text-xs text-accent-neon hover:text-accent-neon/80 flex items-center gap-1 cursor-pointer"
                              >
                                {copiedId === `curl-${model.id}` ? (
                                  <>
                                    <Check size={12} />
                                    <span>{t('copied')}</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy size={12} />
                                    <span>{t('models_copy_curl')}</span>
                                  </>
                                )}
                              </button>
                            </div>
                            <pre className="bg-[#080B09] border border-border/80 p-2.5 text-[11px] font-mono text-textMuted overflow-x-auto whitespace-pre-wrap break-all rounded leading-relaxed">
                              {curlSnippet}
                            </pre>
                          </div>

                          {/* Model Metadata Labels */}
                          {(model.labels?.length || 0) > 0 && (
                            <div className="flex flex-wrap gap-1 pt-1">
                              {model.labels?.map((labelItem, i) => (
                                <span key={i} className="px-2 py-0.5 text-[10px] font-mono bg-white/5 border border-white/10 text-textMuted rounded">
                                  {labelItem}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
