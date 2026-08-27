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
  }, [models, deferredQuery, query, companyFilter, sortBy]);

  const state = classifyDataState({
    pending: modelsQuery.isPending,
    error: modelsQuery.isError,
    data: modelsQuery.data?.models,
    stale: modelsQuery.isError && Boolean(modelsQuery.data),
  });

  const invalidate = () => client.invalidateQueries({ queryKey: queryKeys.models });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      return window.electronAPI.toggleModel(id, enabled);
    },
    onMutate: async ({ id, enabled }) => {
      setMutationError(null);
      await client.cancelQueries({ queryKey: queryKeys.models });
      const previous = client.getQueryData(queryKeys.models);
      client.setQueryData(queryKeys.models, (old: { models?: ModelConfig[] } | undefined) => {
        if (!old?.models) return old;
        return {
          ...old,
          models: old.models.map((m) => (m.id === id ? { ...m, enabled } : m)),
        };
      });
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) client.setQueryData(queryKeys.models, context.previous);
      setMutationError(safeError(error, t('unknown_error')));
    },
    onSettled: invalidate,
  });

  const modeMutation = useMutation({
    mutationFn: async ({ id, mode }: { id: string; mode: ModelMode }) => {
      return window.electronAPI.updateModelSettings(id, { mode });
    },
    onMutate: async ({ id, mode }) => {
      setMutationError(null);
      await client.cancelQueries({ queryKey: queryKeys.models });
      const previous = client.getQueryData(queryKeys.models);
      client.setQueryData(queryKeys.models, (old: { models?: ModelConfig[] } | undefined) => {
        if (!old?.models) return old;
        return {
          ...old,
          models: old.models.map((m) => (m.id === id ? { ...m, mode } : m)),
        };
      });
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) client.setQueryData(queryKeys.models, context.previous);
      setMutationError(safeError(error, t('unknown_error')));
    },
    onSettled: invalidate,
  });

  const bulkToggleMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      return window.electronAPI.bulkToggleModels(enabled);
    },
    onMutate: async (enabled) => {
      setMutationError(null);
      await client.cancelQueries({ queryKey: queryKeys.models });
      const previous = client.getQueryData(queryKeys.models);
      client.setQueryData(queryKeys.models, (old: { models?: ModelConfig[] } | undefined) => {
        if (!old?.models) return old;
        return {
          ...old,
          models: old.models.map((m) => ({ ...m, enabled })),
        };
      });
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) client.setQueryData(queryKeys.models, context.previous);
      setMutationError(safeError(error, t('unknown_error')));
    },
    onSettled: invalidate,
  });

  const handleRefresh = async () => {
    setRefreshPending(true);
    setMutationError(null);
    try {
      await api.refreshModels();
      await invalidate();
    } catch (err) {
      setMutationError(safeError(err, t('unknown_error')));
    } finally {
      setRefreshPending(false);
    }
  };

  const handleToggleAll = async (targetState: boolean) => {
    setToggleAllPending(true);
    try {
      await bulkToggleMutation.mutateAsync(targetState);
    } finally {
      setToggleAllPending(false);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
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

  const allActive = models.length > 0 && activeCount === models.length;

  return (
    <div className="flex flex-col h-full p-4 sm:p-8 min-w-0 overflow-y-auto">
      {/* Header with Title + Action Buttons */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-textMain">{t('models_title')}</h2>
          <p className="text-xs text-textMuted mt-1 font-mono">
            {activeCount}/{models.length} {t('models_active_count')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => handleToggleAll(!allActive)}
            disabled={toggleAllPending || models.length === 0}
            className="px-3.5 py-2 border border-border hover:border-accent-neon/60 bg-surface hover:bg-bg text-textMain text-xs font-semibold rounded-lg transition-all cursor-pointer disabled:opacity-50 animate-tactile-tick"
          >
            {allActive ? t('models_disable_all') : t('models_enable_all')}
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshPending}
            className="px-3.5 py-2 border border-border hover:border-accent-neon/60 bg-surface hover:bg-bg text-accent-neon text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 animate-tactile-tick"
          >
            <RefreshCw size={14} className={refreshPending ? 'animate-spin' : ''} />
            <span>{t('models_refresh')}</span>
          </button>
        </div>
      </div>

      {/* Mutation Error Toast */}
      {mutationError && (
        <div role="alert" className="border border-error bg-error/10 text-error p-3.5 mb-4 rounded-lg text-xs break-words">
          {mutationError}
        </div>
      )}

      {/* Search Bar + Sort Dropdown */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        {/* Search Input */}
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-textMuted" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`${t('models_search_placeholder')} (${searchShortcut})`}
            className="w-full bg-surface border border-border focus:border-accent-neon pl-9 pr-8 py-2 text-xs text-textMain rounded-lg outline-none placeholder:text-textMuted font-mono transition-colors"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-textMuted hover:text-textMain p-0.5"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Sort Controls */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-textMuted font-medium">{t('models_sort_by')}:</span>
          <div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setSortBy('popular')}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                sortBy === 'popular' ? 'bg-bg text-accent-neon font-semibold' : 'text-textMuted hover:text-textMain'
              }`}
            >
              {t('models_sort_popular')}
            </button>
            <button
              type="button"
              onClick={() => setSortBy('name')}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                sortBy === 'name' ? 'bg-bg text-accent-neon font-semibold' : 'text-textMuted hover:text-textMain'
              }`}
            >
              {t('models_sort_name')}
            </button>
            <button
              type="button"
              onClick={() => setSortBy('updated')}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                sortBy === 'updated' ? 'bg-bg text-accent-neon font-semibold' : 'text-textMuted hover:text-textMain'
              }`}
            >
              {t('models_sort_updated')}
            </button>
          </div>
        </div>
      </div>

      {/* Company / Provider Filter Chips */}
      {companies.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-5 pb-3 border-b border-border/60">
          <button
            type="button"
            onClick={() => setCompanyFilter('')}
            className={`px-2.5 py-1 rounded-md text-xs transition-all cursor-pointer font-medium ${
              companyFilter === ''
                ? 'bg-accent-neon/15 text-accent-neon border border-accent-neon/60 font-semibold'
                : 'bg-surface/80 text-textMuted hover:text-textMain border border-border/80'
            }`}
          >
            {t('models_filter_all')} ({models.length})
          </button>
          {companies.map((slug) => {
            const pInfo = resolveProvider(slug);
            const count = models.filter((m) => providerSlugOf(m) === slug).length;
            const isSelected = companyFilter === slug;
            return (
              <button
                key={slug}
                type="button"
                onClick={() => setCompanyFilter(isSelected ? '' : slug)}
                className={`px-2.5 py-1 rounded-md text-xs transition-all cursor-pointer flex items-center gap-1.5 border font-medium ${
                  isSelected
                    ? 'font-semibold'
                    : 'bg-surface/80 text-textMuted hover:text-textMain border-border/80'
                }`}
                style={
                  isSelected
                    ? {
                        backgroundColor: pInfo.tagBg,
                        color: pInfo.color,
                        borderColor: pInfo.color,
                      }
                    : undefined
                }
              >
                <ProviderGlyph provider={slug} size={13} color={isSelected ? pInfo.color : undefined} />
                <span>{pInfo.name}</span>
                <span className="text-[10px] opacity-70 font-mono">({count})</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Loading / Error States */}
      {state === 'loading' && <div role="status" className="p-8 text-center text-textMuted">{t('loading')}</div>}
      {state === 'error' && (
        <div role="alert" className="border border-error p-4 rounded-lg mb-4">
          <p className="text-error font-medium">{t('models_error')}</p>
          <p className="text-xs text-textMuted mt-1 break-all">{safeError(modelsQuery.error, t('unknown_error'))}</p>
          <button onClick={() => void modelsQuery.refetch()} className="mt-3 text-xs text-accent-neon hover:underline">
            {t('retry')}
          </button>
        </div>
      )}

      {/* Models List */}
      {(state === 'success' || state === 'stale') && (
        <div className="space-y-3 pb-8">
          {filteredModels.length === 0 ? (
            <div className="bg-surface/60 border border-dashed border-border/80 p-8 rounded-xl text-center text-textMuted text-sm">
              <Cpu size={32} className="mx-auto mb-2 text-textMuted/60" />
              <p>{t('models_no_match')}</p>
            </div>
          ) : (
            filteredModels.map((m) => {
              const slug = providerSlugOf(m);
              const providerInfo = resolveProvider(slug);
              const isExpanded = expandedIds.has(m.id);
              const capabilities = extractCapabilities(m.id, m.labels, m.category);
              const popLabel = formatPopularity(m.popularity);
              const updatedLabel = formatLastUpdated(m.lastUpdated);

              return (
                <div
                  key={m.id}
                  className={`bg-surface border rounded-xl transition-all ${
                    m.enabled ? 'border-border hover:border-accent-neon/50' : 'border-border/60 opacity-75'
                  }`}
                >
                  {/* Top Bar / Summary */}
                  <div className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
                    {/* Left side: Icon + Names + Tags */}
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      {/* Provider Glyph Badge */}
                      <div
                        className="p-2 rounded-lg border shrink-0 mt-0.5"
                        style={{
                          backgroundColor: providerInfo.tagBg,
                          borderColor: `${providerInfo.color}30`,
                        }}
                      >
                        <ProviderGlyph provider={slug} size={20} color={providerInfo.color} />
                      </div>

                      {/* Main Info */}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className="font-mono text-sm font-bold text-textMain break-all">{m.id}</span>
                          <button
                            type="button"
                            onClick={() => copyId(m.id)}
                            className="p-1 text-textMuted hover:text-accent-neon transition-colors cursor-pointer"
                            aria-label={t('copy')}
                            title={t('copy')}
                          >
                            {copiedId === m.id ? <Check size={13} className="text-accent-neon" /> : <Copy size={13} />}
                          </button>
                        </div>

                        {/* Model Human Name */}
                        {m.name && m.name !== m.id && (
                          <div className="text-xs text-textMuted mb-2">{m.name}</div>
                        )}

                        {/* Capability & Metadata Badges */}
                        <div className="flex flex-wrap items-center gap-1.5 mt-2">
                          {/* Provider chip */}
                          <span
                            className="px-2 py-0.5 rounded-md text-[10px] font-semibold border"
                            style={{
                              backgroundColor: providerInfo.tagBg,
                              color: providerInfo.color,
                              borderColor: `${providerInfo.color}40`,
                            }}
                          >
                            {providerInfo.name}
                          </span>

                          {/* Capabilities */}
                          {capabilities.map((c) => (
                            <span
                              key={c.id}
                              className={`px-2 py-0.5 rounded-md text-[10px] font-medium border flex items-center gap-1 ${c.colorClass} ${c.borderClass} ${c.bgClass}`}
                            >
                              {c.icon}
                              <span>{t(c.labelKey)}</span>
                            </span>
                          ))}

                          {/* Popularity metric */}
                          {popLabel && (
                            <span className="px-2 py-0.5 rounded-md text-[10px] font-mono font-medium text-textMuted bg-bg border border-border/70">
                              ★ {popLabel}
                            </span>
                          )}

                          {/* Last updated */}
                          {updatedLabel && (
                            <span className="px-2 py-0.5 rounded-md text-[10px] font-mono text-textMuted bg-bg border border-border/70">
                              🕒 {updatedLabel}
                            </span>
                          )}

                          {/* Free endpoint badge */}
                          {m.freeEndpoint && (
                            <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold text-purple-300 bg-purple-950/50 border border-purple-800/60">
                              {t('models_free_endpoint')}
                            </span>
                          )}

                          {/* Deprecated warning */}
                          {m.deprecated && (
                            <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold text-warning bg-warning/10 border border-warning/40">
                              {t('models_deprecated')}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Right side: Controls (Mode dropdown + Enabled toggle + Expand button) */}
                    <div className="flex items-center justify-between md:justify-end gap-3 pt-3 md:pt-0 border-t md:border-t-0 border-border/60 shrink-0">
                      {/* Performance Mode Selector */}
                      <select
                        value={m.mode}
                        onChange={(e) => modeMutation.mutate({ id: m.id, mode: e.target.value as ModelMode })}
                        disabled={modeMutation.isPending || !m.enabled}
                        aria-label={t('models_mode_label')}
                        className="bg-bg border border-border/80 px-2.5 py-1.5 text-xs text-textMain rounded-lg outline-none cursor-pointer disabled:opacity-40"
                      >
                        <option value="day">{t('mode_day')}</option>
                        <option value="night">{t('mode_night')}</option>
                        <option value="auto">{t('mode_auto')}</option>
                      </select>

                      {/* Enable / Disable Switch */}
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          role="switch"
                          checked={m.enabled}
                          disabled={toggleMutation.isPending}
                          onChange={(e) => toggleMutation.mutate({ id: m.id, enabled: e.target.checked })}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-border/80 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-nvidia relative"></div>
                        <span className="text-xs font-semibold text-textMain hidden sm:inline">
                          {m.enabled ? t('models_enabled') : t('models_disabled')}
                        </span>
                      </label>

                      {/* Collapsible Details Trigger */}
                      <button
                        type="button"
                        onClick={() => toggleExpand(m.id)}
                        className="p-1.5 text-textMuted hover:text-textMain rounded-lg hover:bg-bg border border-transparent hover:border-border transition-colors cursor-pointer"
                        aria-expanded={isExpanded}
                        aria-label={t('details')}
                      >
                        {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      </button>
                    </div>
                  </div>

                  {/* Expanded Detail Panel */}
                  {isExpanded && (
                    <div className="px-4 pb-4 pt-2 border-t border-border/60 bg-bg/50 rounded-b-xl space-y-3">
                      {/* Short Description */}
                      {m.shortDescription && (
                        <div>
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-textMuted block mb-1">
                            {t('models_description')}
                          </span>
                          <p className="text-xs text-textMain leading-relaxed">{m.shortDescription}</p>
                        </div>
                      )}

                      {/* Details Grid */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2">
                        <div className="bg-surface border border-border/70 p-2.5 rounded-lg">
                          <span className="text-[10px] text-textMuted uppercase block">{t('models_category')}</span>
                          <span className="text-xs font-mono font-medium text-textMain">
                            {m.category || t('models_unknown')}
                          </span>
                        </div>
                        <div className="bg-surface border border-border/70 p-2.5 rounded-lg">
                          <span className="text-[10px] text-textMuted uppercase block">{t('models_downloadable')}</span>
                          <span className="text-xs font-mono font-medium text-textMain">
                            {m.downloadable ? t('yes') : t('no')}
                          </span>
                        </div>
                        <div className="bg-surface border border-border/70 p-2.5 rounded-lg">
                          <span className="text-[10px] text-textMuted uppercase block">{t('models_publisher')}</span>
                          <span className="text-xs font-mono font-medium text-textMain">
                            {m.publisher || providerInfo.name}
                          </span>
                        </div>
                        <div className="bg-surface border border-border/70 p-2.5 rounded-lg">
                          <span className="text-[10px] text-textMuted uppercase block">{t('models_last_updated')}</span>
                          <span className="text-xs font-mono font-medium text-textMain">
                            {m.lastUpdated ? new Date(m.lastUpdated).toLocaleDateString() : t('models_unknown')}
                          </span>
                        </div>
                      </div>

                      {/* Quick cURL / OpenAI Usage Snippet */}
                      <div className="pt-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-textMuted block mb-1">
                          {t('models_usage_example')}
                        </span>
                        <pre className="bg-[#080B09] border border-border p-3 text-[11px] font-mono text-accent-neon overflow-x-auto whitespace-pre-wrap rounded-lg">
                          {`curl http://127.0.0.1:${gatewayPort}/v1/chat/completions \\
  -H "Authorization: Bearer <GATEWAY_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${m.id}",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
