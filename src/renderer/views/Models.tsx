import { useState, useMemo, useRef, useEffect, useLayoutEffect, useDeferredValue } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
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
  ExternalLink,
  Layers,
  RefreshCw,
  Search,
  Sparkles,
  Tag,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import { ProviderGlyph, resolveProvider } from '../components/ProviderGlyph';
import { api, queryKeys } from '../lib/api';
import { classifyDataState, safeError } from '../lib/frontend-state';
import {
  DEFAULT_MODEL_FILTERS,
  MAX_CURATED_TAGS,
  CURATED_TAG_VOCABULARY,
  warnOnCuratedTagPresentationDrift,
  applyModelFilters,
  collectModelLabels,
  curateCapabilityTags,
  hasActiveFilters,
  labelMatchesSelection,
  modelLabelI18nKey,
  pruneSelectedLabels,
  resetModelFilters,
} from '../lib/models-filter';
import type { ModelFilterState, ModelSortBy } from '../lib/models-filter';
import { formatTokenCount, describeCapabilities, formatPopularity, formatScore, formatStrengthRank, buildCurlSnippet } from '../lib/model-technical';
import { useGatewayLifecycle } from '../lib/gateway-lifecycle';
import { useModelsStore } from '../stores/models';
import { useConfigStore } from '../stores/config';
import { focusPendingSetting, focusSettingFrom } from '../pet/tips';

interface AdminKey {
  id: string;
  accessibleModels?: string[];
}
type ModelMode = 'day' | 'night' | 'auto';

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
const searchShortcut = isMac ? '⌘K' : 'Ctrl+K';

/**
 * Source of the model-strength ranking. Hard-coded here (not fetched) because
 * the LLM Stats licence requires the attribution to be present wherever the
 * ranking is displayed — it must not depend on the network that provides the
 * numbers. Mirrors LLM_STATS_SOURCE_URL in src/gateway/llm-stats-ranking.mjs.
 */
const LLM_STATS_SOURCE_URL = 'https://llm-stats.com/';

function providerSlugOf(m: { publisher?: string | null; provider?: string | null; id: string }): string | null {
  return m.publisher ?? m.provider ?? (m.id.includes('/') ? m.id.split('/')[0] : null);
}

// `locale` is the ACTIVE i18n language (i18n.language). Without it the browser's
// system locale wins and a Russian UI prints en-US dates ("3/5/2024"). Falls back
// to 'en' — the i18n default — when the language is not resolved yet, so the
// first render is deterministic instead of host-dependent.
//
// The tag is VALIDATED before use. A malformed tag ('en_US') makes
// toLocaleDateString throw RangeError during render, and a well-formed but
// unsupported one ('xx-YY') is silently ignored by Intl, which then formats with
// the HOST locale — the exact defect this function exists to remove. Both resolve
// to 'en'.
function resolveDateLocale(locale?: string): string {
  if (!locale) return 'en';
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale]).length > 0 ? locale : 'en';
  } catch {
    return 'en';
  }
}

export function formatLastUpdated(dateStr?: string | null, locale?: string): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const diffDays = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays >= 0 && diffDays < 365) return `${diffDays}d`;
  return d.toLocaleDateString(resolveDateLocale(locale));
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

/**
 * Presentation (icon + colour) per CURATED_TAG_VOCABULARY id. The ICONS MATCH
 * the ones extractCapabilities() uses for the same ids so the card and the
 * drawer never show the same capability in two different visual languages.
 *
 * The VOCABULARY (and the tag cap) live in ../lib/models-filter so the curation
 * rule is unit-testable; this map only adds presentation.
 */
const CURATED_TAG_META: Record<string, CapabilityTag> = {
  reasoning: {
    id: 'reasoning',
    labelKey: 'tag_reasoning',
    colorClass: 'text-purple-300',
    borderClass: 'border-purple-700/50',
    bgClass: 'bg-purple-950/40',
    icon: <Sparkles size={11} className="shrink-0 text-purple-400" />,
  },
  vision: {
    id: 'vision',
    labelKey: 'tag_vision',
    colorClass: 'text-cyan-300',
    borderClass: 'border-cyan-700/50',
    bgClass: 'bg-cyan-950/40',
    icon: <Eye size={11} className="shrink-0 text-cyan-400" />,
  },
  code: {
    id: 'code',
    labelKey: 'tag_code',
    colorClass: 'text-emerald-300',
    borderClass: 'border-emerald-700/50',
    bgClass: 'bg-emerald-950/40',
    icon: <Code size={11} className="shrink-0 text-emerald-400" />,
  },
  function_calling: {
    id: 'function_calling',
    labelKey: 'tag_function_calling',
    colorClass: 'text-amber-300',
    borderClass: 'border-amber-700/50',
    bgClass: 'bg-amber-950/40',
    icon: <Wrench size={11} className="shrink-0 text-amber-400" />,
  },
};

// Guard: the curation vocabulary (lib) and the presentation map (here) must
// describe the SAME ids. A vocabulary entry without presentation would silently
// render nothing in the drawer (CURATED_TAG_META[tagId] -> null -> nothing
// rendered), so the contract check and any dev-time warning live in
// ../lib/models-filter (this file must stay console-free — see the source
// console policy test). The view only supplies the ids its map actually carries.
warnOnCuratedTagPresentationDrift(
  CURATED_TAG_VOCABULARY.filter((entry) => Boolean(CURATED_TAG_META[entry.id])).map((entry) => entry.id)
);

export function Models() {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const lifecycle = useGatewayLifecycle();
  const { gatewayPort } = useConfigStore();
  const unavailable = lifecycle.status?.state !== 'running';

  const [mutationError, setMutationError] = useState<string | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  const [toggleAllPending, setToggleAllPending] = useState(false);

  // Search + sort + the narrowing filters, held in ONE object so "reset" is a
  // single call and so every axis composes by construction. The logic itself
  // lives in ../lib/models-filter — extracted so it can be unit-tested, since
  // this repo has no jsdom and components cannot be rendered in tests.
  const [filters, setFilters] = useState<ModelFilterState>(DEFAULT_MODEL_FILTERS);
  // At most ONE drawer open at a time, closed by default, and re-clicking the
  // same card closes it («Нажимаешь, открывается. Еще раз нажимаешь,
  // закрывается»). A single id — not a Set — makes "many cards open at once"
  // unrepresentable.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Tag block open state (owner 30.09): collapsed on every visit, not persisted.
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // The pending "Copied" reset. Cleared on every re-copy (so an older timer
  // cannot wipe the newer feedback early) and on unmount.
  const copiedTimerRef = useRef<number | undefined>(undefined);
  // Announce the copy result to assistive tech (the button label alone changes
  // silently for a screen reader). Same polite-live-region idiom as the filter
  // count below. No new i18n: the existing `copied` key is reused.
  const [copyAnnouncement, setCopyAnnouncement] = useState('');

  const deferredQuery = useDeferredValue(filters.query);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const patchFilters = (patch: Partial<ModelFilterState>) => setFilters((prev) => ({ ...prev, ...patch }));
  const toggleLabel = (label: string) =>
    setFilters((prev) => ({
      ...prev,
      // Case-insensitive, like the filter itself (labelMatchesSelection).
      labels: prev.labels.some((l) => labelMatchesSelection(l, label))
        ? prev.labels.filter((l) => !labelMatchesSelection(l, label))
        : [...prev.labels, label],
    }));

  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), []);

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
  // One predicate for both: a null list is as unknown as an absent one.
  const rawKeys = keysQuery.data?.keys;
  const keys = (Array.isArray(rawKeys) ? rawKeys : []) as AdminKey[];
  // HONESTY: the per-card key-quorum meter renders `keysCount/keysTotal`. With
  // `?? []` both defaulted to 0 while the keys query was still loading (or had
  // failed), so every card claimed "0/0 keys". Track whether the list actually
  // arrived: until it does, the count is unknown and must not be shown as 0.
  const keysKnown = Array.isArray(rawKeys);

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

  // Every distinct label the loaded catalogue actually carries, so a chip can
  // never be offered for a label nothing matches.
  const availableLabels = useMemo(() => collectModelLabels(models), [models]);

  // Sorting + narrowing in one pass. deferredQuery keeps typing responsive on a
  // large catalogue; the trailing `|| filters.query` preserves the pre-existing
  // first-keystroke behaviour.
  const filteredModels = useMemo(
    () => applyModelFilters(models, { ...filters, query: deferredQuery || filters.query }),
    [models, filters, deferredQuery]
  );

  // A drawer whose model left the visible list (filter / sort / refresh) must
  // not stay "open" invisibly and re-open when the model comes back.
  useEffect(() => {
    if (expandedId !== null && !filteredModels.some((m) => m.id === expandedId)) setExpandedId(null);
  }, [expandedId, filteredModels]);

  // Same for a selected tag that the reloaded catalogue no longer offers: it
  // would keep narrowing the list with no visible chip to deselect it.
  useEffect(() => {
    if (filters.labels.some((l) => !availableLabels.some((a) => labelMatchesSelection(a, l)))) {
      setFilters((prev) => ({ ...prev, labels: [...pruneSelectedLabels(prev.labels, availableLabels)] }));
    }
  }, [filters.labels, availableLabels]);

  const filtersActive = hasActiveFilters(filters);
  const resetFilters = () => setFilters((prev) => resetModelFilters(prev));

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
    setExpandedId((prev) => (prev === id ? null : id));
  };

  // Copy goes through the main process: navigator.clipboard rejects with
  // NotAllowedError whenever this tray-resident window is not focused. Failures
  // surface through the view's existing error banner instead of being discarded.
  const copy = async (text: string, id: string) => {
    try {
      await window.electronAPI.clipboard.writeText(text);
      setMutationError(null);
      setCopiedId(id);
      // Toggle the trailing space so a repeated copy of the same control still
      // changes the live region and is re-announced.
      setCopyAnnouncement((prev) => (prev === t('copied') ? `${t('copied')} ` : t('copied')));
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      setMutationError(`${t('copy_failed')} ${safeError(err, t('unknown_error'))}`);
    }
  };

  // Pet-advisor target page: see Dashboard for the same flow. Runs before the
  // gateway-stopped early return so the hooks are unconditional.
  const location = useLocation(); const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pendingFocus = useRef<unknown>(focusSettingFrom(location.state));
  useLayoutEffect(() => { if (pendingFocus.current !== null) headingRef.current?.focus(); }, []);
  useEffect(() => {
    if (pendingFocus.current !== null && !unavailable && state !== 'loading') {
      focusPendingSetting(pendingFocus.current);
      pendingFocus.current = null;
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [state, unavailable]);

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
      <p className="sr-only" aria-live="polite">{copyAnnouncement}</p>
      {/* Header Hub */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
            <div className="flex items-center gap-3">
              <h2 ref={headingRef} tabIndex={-1} className="text-2xl font-bold text-textMain tracking-tight">{t('models_title')}</h2>
              {/* Count badges only when the catalogue actually arrived: while
                  loading/errored we do not know them, and "0 active / 0 total"
                  would state an unknown as a fact. */}
              {(state === 'success' || state === 'stale') && (
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-0.5 text-xs font-mono font-semibold bg-accent-neon/15 text-accent-neon border border-accent-neon/30 rounded-full">
                    {t('models_active_count', { count: activeCount })}
                  </span>
                  <span className="px-2.5 py-0.5 text-xs font-mono text-textMuted bg-surface border border-border rounded-full">
                    {t('models_total_count', { count: models.length })}
                  </span>
                </div>
              )}
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
            <Cpu size={40} className="mx-auto text-textMuted" />
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
                <Search aria-hidden size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-textMuted pointer-events-none" />
                <input
                  dir="auto"
                  ref={searchRef}
                  type="text"
                  value={filters.query}
                  onChange={(e) => patchFilters({ query: e.target.value })}
                  placeholder={t('models_search_placeholder')}
                  aria-label={t('models_search_placeholder')}
                  className="w-full bg-bg border border-border/90 ps-9 pe-16 py-2 text-sm rounded-lg focus:border-accent-neon/80 focus:shadow-[0_0_10px_rgba(89,255,0,0.2)] outline-none text-textMain transition-all"
                />
                {filters.query && (
                  <button
                    type="button"
                    onClick={() => patchFilters({ query: '' })}
                    className="absolute end-9 top-1/2 -translate-y-1/2 text-textMuted hover:text-textMain p-1"
                    aria-label={t('models_clear_search')}
                  >
                    <X aria-hidden size={14} />
                  </button>
                )}
                <kbd dir="ltr" aria-hidden="true" className="absolute end-2.5 top-1/2 -translate-y-1/2 text-[11px] font-mono text-textMuted bg-surface px-1.5 py-0.5 border border-border rounded hidden sm:block">
                  {searchShortcut}
                </kbd>
              </div>

              {/* Sort By */}
              <label className="flex items-center gap-2 text-xs font-medium text-textMuted">
                <span>{t('models_sort_label')}</span>
                <select
                  id="models-sort"
                  value={filters.sortBy}
                  onChange={(e) => patchFilters({ sortBy: e.target.value as ModelSortBy })}
                  className="bg-bg border border-border/90 text-textMain px-2.5 py-1.5 text-xs rounded-lg outline-none focus:border-accent-neon/60"
                  aria-label={t('models_sort_label')}
                >
                  <option value="popular">{t('models_sort_popular')}</option>
                  <option value="top">{t('models_sort_top')}</option>
                  <option value="name">{t('models_sort_name')}</option>
                  <option value="updated">{t('models_sort_updated')}</option>
                </select>
              </label>

              {/* Round E: the strength ranking comes from LLM Stats, whose licence
                  requires this attribution wherever the ranking is shown. */}
              {/* Opens through the preload openExternal route, not a window.open /
                  new-tab: electron-security.ts installs a deny-all window open
                  handler in main, so a new tab would open nothing. */}
              <a
                href={LLM_STATS_SOURCE_URL}
                onClick={(e) => { e.preventDefault(); window.electronAPI?.openExternal(LLM_STATS_SOURCE_URL).catch(() => undefined); }}
                className="flex items-center gap-1 text-[10px] text-textMuted hover:text-accent-neon transition-colors"
                title={t('models_source_attribution')}
              >
                <ExternalLink aria-hidden size={11} />
                <span>{t('models_source_attribution')}</span>
              </a>

              {/* Minimum-popularity select REMOVED (owner: «Вот эта строка мне
                  вообще не нужна… Мы уже популярность добавили в сортировке»).
                  The per-model popularity display (card badge + drawer row) and
                  the popularity SORT both stay; only the threshold row is gone,
                  and with it the POPULARITY_THRESHOLDS choices table, which had
                  no other reader. The view no longer sets a threshold, so the
                  `minPopularity` field stays at its neutral 0. */}

              {/* Bulk Toggle Buttons */}
              <div className="flex items-center gap-2 ms-auto">
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
                    aria-pressed={filters.company === ''}
                    aria-label={t('models_all_companies')}
                    onClick={() => patchFilters({ company: '' })}
                    className={`group flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-all cursor-pointer select-none animate-tactile-tick border ${
                      filters.company === ''
                        ? 'border-accent-neon/80 bg-accent-neon/15 text-accent-neon shadow-[0_0_10px_rgba(89,255,0,0.25)] font-bold'
                        : 'border-border/80 bg-surface/50 text-textMuted hover:text-textMain hover:border-border hover:bg-surface font-medium'
                    }`}
                  >
                    <Layers size={13} className={`shrink-0 ${filters.company === '' ? 'text-accent-neon' : 'text-textMuted group-hover:text-textMain'}`} />
                    <span>{t('models_all_companies')}</span>
                  </button>

                  {/* Individual Company Chips */}
                  {companies.map((slug) => {
                    const providerInfo = resolveProvider(slug);
                    const isSelected = filters.company === slug;
                    return (
                      <button
                        key={slug}
                        type="button"
                        aria-pressed={isSelected}
                        aria-label={providerInfo.name}
                        onClick={() => patchFilters({ company: filters.company === slug ? '' : slug })}
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

            {/* Label chips (any-of) + the two catalogue boolean narrowers. The
                chips are derived from the loaded models, so a chip can never be
                offered for a label nothing carries. */}
            <div className="mt-3 pt-3 border-t border-border/50 flex flex-wrap items-center gap-x-4 gap-y-2">
              {/* Owner 30.09: the tag block is COLLAPSED by default; one click
                  opens it, another closes it, so the models are visible first. */}
              {availableLabels.length > 0 && (
                <button
                  type="button"
                  aria-expanded={labelsOpen}
                  aria-controls="models-label-chips"
                  onClick={() => setLabelsOpen((open) => !open)}
                  className="flex items-center gap-1 text-xs font-medium text-textMuted hover:text-accent-neon transition-colors cursor-pointer min-h-6"
                >
                  <Tag aria-hidden size={13} className="shrink-0" />
                  <span>
                    {filters.labels.length > 0
                      ? t('models_filter_labels_selected', { count: filters.labels.length })
                      : t('models_filter_labels_count', { count: availableLabels.length })}
                  </span>
                  {labelsOpen ? <ChevronUp aria-hidden size={14} /> : <ChevronDown aria-hidden size={14} />}
                </button>
              )}

              <label className="flex items-center gap-2 text-xs font-medium text-textMuted cursor-pointer py-1.5">
                <input
                  id="models-filter-free"
                  type="checkbox"
                  checked={filters.freeOnly}
                  onChange={(e) => patchFilters({ freeOnly: e.target.checked })}
                  className="accent-accent-neon cursor-pointer"
                />
                <span>{t('models_filter_free_only')}</span>
              </label>

              <label className="flex items-center gap-2 text-xs font-medium text-textMuted cursor-pointer py-1.5">
                <input
                  type="checkbox"
                  checked={filters.downloadableOnly}
                  onChange={(e) => patchFilters({ downloadableOnly: e.target.checked })}
                  className="accent-accent-neon cursor-pointer"
                />
                <span>{t('models_filter_downloadable_only')}</span>
              </label>

              {labelsOpen && availableLabels.length > 0 && (
                <div id="models-label-chips" className="basis-full flex flex-wrap gap-1.5" role="group" aria-label={t('models_filter_labels_label')}>
                  {availableLabels.map((label) => {
                    // NGC emits some labels as raw backend keys
                    // ("usecase:endpoint:usecase_text_gen", ...): known values
                    // render a localized human name, unknown ones keep the raw
                    // string so no chip can silently disappear. Filtering still
                    // operates on the raw label everywhere else.
                    const labelKey = modelLabelI18nKey(label);
                    const selected = filters.labels.some((l) => labelMatchesSelection(l, label));
                    return (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleLabel(label)}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-all cursor-pointer select-none animate-tactile-tick border ${
                          selected
                            ? 'border-accent-neon/80 bg-accent-neon/15 text-accent-neon shadow-[0_0_10px_rgba(89,255,0,0.25)] font-bold'
                            : 'border-border/80 bg-surface/50 text-textMuted hover:text-textMain hover:border-border hover:bg-surface font-medium'
                        }`}
                      >
                        {labelKey ? t(labelKey) : label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Result count + reset. The count is always visible so an empty list
              reads as a filter outcome rather than a broken view, and the
              sr-only polite live region below mirrors it (same idiom as
              Logs.tsx:237) so a shrinking list is not a silent change. When the
              result is empty the grid's role="status" adds the explanation, so
              a reader hears the count and then the reason. */}
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <p className="text-xs font-mono text-textMuted">
              {t('models_filter_results', { count: filteredModels.length, total: models.length })}
            </p>
            {filtersActive && (
              <button
                type="button"
                onClick={resetFilters}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold border border-border hover:border-accent-neon/50 bg-bg hover:bg-surface text-textMuted hover:text-accent-neon rounded-lg transition-all cursor-pointer animate-tactile-tick"
              >
                <X aria-hidden size={13} />
                <span>{t('models_filter_reset')}</span>
              </button>
            )}
          </div>
          <p className="sr-only" aria-live="polite">
            {t('models_filter_results', { count: filteredModels.length, total: models.length })}
          </p>

          {/* Catalog Grid. An empty result is EXPLAINED and offers a one-click
              way out, so it never reads as a broken list. role="status" matches
              the view's existing non-error status idiom. */}
          {filteredModels.length === 0 ? (
            <div role="status" className="flex-1 grid place-items-center text-textMuted py-12">
              <div className="text-center space-y-3">
                <Cpu aria-hidden size={36} className="mx-auto text-textMuted" />
                <p className="text-sm font-mono">{t('models_no_models_found')}</p>
                {filtersActive && (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-border hover:border-accent-neon/50 bg-bg hover:bg-surface text-textMain hover:text-accent-neon rounded-lg transition-all cursor-pointer animate-tactile-tick"
                  >
                    <X aria-hidden size={13} />
                    <span>{t('models_filter_reset')}</span>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4 pb-6">
              {filteredModels.map((model) => {
                const keysCount = keys.filter((k) => Array.isArray(k.accessibleModels) && k.accessibleModels.includes(model.id)).length;
                const keysTotal = keys.length;
                const providerSlug = providerSlugOf(model);
                const providerInfo = resolveProvider(providerSlug);
                const capabilityTags = extractCapabilities(model.id, model.labels ?? [], model.category);
                const isExpanded = expandedId === model.id;
                // The drawer shows the curated (bounded, vocabulary-fixed) set:
                // the union of the card's tags and the capability signals carried
                // by non-plumbing labels, capped at MAX_CURATED_TAGS. NGC plumbing
                // (cloudPartnerType:*, nimType:*, endpoint:*, …) contributes
                // nothing, so an unlisted model shows no tag row at all.
                const curatedTagIds = curateCapabilityTags(capabilityTags, model.labels, MAX_CURATED_TAGS);
                // Round 1b: the gateway-asserted capabilities for the «Информация»
                // rows. Distinct from the card tags above: those are derived from
                // the id/labels heuristically, while these come verbatim from
                // GET /admin/models capabilities (empty during cold start).
                const capabilityRows = describeCapabilities(model.capabilities);
                // Round E: the LLM Stats overall-strength rank, or null when the
                // gateway did not genuinely match this model. `null` means the
                // strength/attribution rows are OMITTED entirely — never a
                // placeholder — matching the project rule "no data → no row".
                const strengthRank = formatStrengthRank(model.llmStatsRank);

                const [namespace, heroName] = model.id.includes('/')
                  ? [model.id.split('/')[0], model.id.split('/').slice(1).join('/')]
                  : ['', model.id];

                const curlSnippet = buildCurlSnippet(gatewayPort, model.id);

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
                        style={{
                          background: `linear-gradient(90deg, transparent 0%, ${providerInfo.borderAccent} 50%, transparent 100%)`,
                        }}
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
                          <div dir="ltr" className="text-[11px] font-mono text-textMuted tracking-wider font-semibold uppercase flex items-center gap-1 mb-0.5">
                            <span>{namespace}</span>
                            <span className="text-border-soft">/</span>
                          </div>
                        )}
                        <h3 dir="ltr" className="text-base sm:text-lg font-bold text-textMain tracking-tight break-words">
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
                              dir="auto"
                              className={`flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${cap.bgClass} ${cap.borderClass} ${cap.colorClass}`}
                            >
                              {cap.icon}
                              <span>{t(cap.labelKey as any)}</span>
                            </span>
                          ))}
                        </div>

                        {/* Popularity & Last Updated */}
                        <div className="flex items-center gap-3 text-[11px] text-textMuted font-mono shrink-0 ms-auto">
                          {formatPopularity(model.popularity) != null && <span title={t('models_popularity', { count: model.popularity })}>↓ {formatPopularity(model.popularity)}</span>}
                          {model.lastUpdated && <span>⏱ {formatLastUpdated(model.lastUpdated, i18n.language)}</span>}
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
                              disabled={toggleMutation.isPending && toggleMutation.variables?.id === model.id}
                              onClick={() => toggleMutation.mutate({ id: model.id, enabled: !model.enabled })}
                              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-all duration-200 cursor-pointer animate-tactile-tick ${
                                model.enabled
                                  ? 'bg-accent-neon shadow-[0_0_12px_rgba(89,255,0,0.6)]'
                                  : 'bg-white/15 hover:bg-white/20'
                              }`}
                            >
                              <span
                                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-md transition-transform duration-200 ${
                                  model.enabled ? 'translate-x-6 rtl:-translate-x-6 bg-black' : 'translate-x-1 rtl:-translate-x-1'
                                }`}
                              />
                            </button>
                            <span className="text-xs font-semibold text-textMuted">{t('models_enabled')}</span>
                          </div>

                          {/* Day/Night/Auto Mode Selector */}
                          <label className="flex items-center gap-1.5 text-xs text-textMuted" title={t(`mode_${model.mode}_help`)}>
                            <select
                              aria-label={`${t('models_mode_label')} ${model.id}`}
                              value={model.mode}
                              disabled={modeMutation.isPending && modeMutation.variables?.id === model.id}
                              onChange={(e) => modeMutation.mutate({ id: model.id, mode: e.target.value as ModelMode })}
                              className="bg-bg border border-border px-2 py-1 text-xs rounded text-textMain outline-none focus:border-accent-neon/50"
                            >
                              <option value="day" title={t('mode_day_help')}>{t('mode_day')}</option>
                              <option value="night" title={t('mode_night_help')}>{t('mode_night')}</option>
                              <option value="auto" title={t('mode_auto_help')}>{t('mode_auto')}</option>
                            </select>
                          </label>

                          {/* Key Quorum Battery / LED Meter */}
                          <div
                            className="flex items-center gap-1.5 px-2.5 py-1 bg-bg border border-border/80 rounded-md"
                            title={keysKnown ? t('models_quorum_active', { count: keysCount, total: keysTotal }) : t('loading')}
                          >
                            <div className="flex items-center gap-1">
                              {Array.from({ length: Math.max(keysTotal, 1) }).map((_, idx) => {
                                const isLedActive = idx < keysCount;
                                return (
                                  <span
                                    key={idx}
                                    className={`w-1.5 h-2.5 rounded-sm transition-all ${
                                      isLedActive
                                        ? 'bg-accent-neon shadow-[0_0_6px_#59FF00]'
                                        : 'bg-white/15'
                                    }`}
                                  />
                                );
                              })}
                            </div>
                            <span className="text-[11px] font-mono text-textMuted">
                              {keysKnown ? `${keysCount}/${keysTotal} ${t('keys_short')}` : t('loading')}
                            </span>
                          </div>
                        </div>

                        {/* Expand Details / Inspector Button (min-h-6: the
                            82x16 text-only button was a 16px-tall hit target;
                            WCAG 2.5.8 needs >= 24px of clickable height) */}
                        <button
                          type="button"
                          aria-expanded={isExpanded}
                          aria-controls={`models-details-${model.id}`}
                          onClick={() => toggleExpanded(model.id)}
                          className="flex items-center gap-1 text-xs font-medium text-textMuted hover:text-accent-neon transition-colors ms-auto cursor-pointer min-h-6"
                        >
                          <span>{isExpanded ? t('models_hide_details') : t('models_details')}</span>
                          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                      </div>

                      {/* Expandable Inspector Drawer.
                          Two named sections: «Информация» (technical data that
                          actually exists in the catalogue) and «Примеры»
                          (copy-ready snippets). Then the CURATED capability
                          tags. The raw `model.labels` dump is deliberately
                          gone: it rendered unbounded NGC plumbing such as
                          `cloudPartnerType:endpoint:cloud_partner_type_*` and
                          `nimType:endpoint:*` (see curateCapabilityTags in
                          ../lib/models-filter — unit-tested). */}
                      {isExpanded && (
                        <div
                          id={`models-details-${model.id}`}
                          className="mt-3.5 p-3.5 bg-bg/90 border border-border/80 rounded-lg space-y-3.5"
                        >
                          {/* ── Section 1: Информация ── */}
                          <section aria-labelledby={`drawer-info-${model.id}`} className="space-y-2.5">
                            <h4
                              id={`drawer-info-${model.id}`}
                              className="flex items-center gap-1.5 text-[10px] text-textMuted uppercase font-bold tracking-wider"
                            >
                              <Cpu aria-hidden size={12} className="text-accent-neon" />
                              <span>{t('models_section_info')}</span>
                            </h4>

                            {/* Full Model ID (always visible) + copy */}
                            <div className="flex items-center justify-between gap-2 pb-2 border-b border-border/50">
                              <div className="min-w-0 flex-1">
                                <div className="text-[10px] text-textMuted uppercase font-bold tracking-wider">{t('models_full_id')}</div>
                                <code dir="ltr" className="font-mono text-xs text-accent-neon break-all select-all">{model.id}</code>
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

                            {/* Technical rows. ONLY fields the renderer actually
                                receives are rendered (src/main/models-ipc.ts
                                mapModelCatalog threads exactly these); a row is
                                omitted, never filled with a guess, when its
                                source is absent. Round 1b: context length, max
                                output and capabilities are now genuinely
                                threaded from GET /admin/models
                                (admin-api.mjs:312-314) — but they may still be
                                absent (a pre-Round-1b gateway, an unlisted
                                model, or the gateway's cold-start window where
                                capabilities are empty for ~30-60 s), so each
                                row stays conditional. Nothing is cached as a
                                fallback: absence ⇒ no row. */}
                            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                              {model.provider && (
                                <div className="flex items-baseline justify-between gap-2 min-w-0">
                                  <dt className="text-textMuted shrink-0">{t('models_info_provider')}</dt>
                                  <dd dir="ltr" title={model.provider} className="font-mono text-textMain truncate">{model.provider}</dd>
                                </div>
                              )}
                              {model.publisher && model.publisher !== model.provider && (
                                <div className="flex items-baseline justify-between gap-2 min-w-0">
                                  <dt className="text-textMuted shrink-0">{t('models_info_publisher')}</dt>
                                  <dd dir="ltr" title={model.publisher} className="font-mono text-textMain truncate">{model.publisher}</dd>
                                </div>
                              )}
                              {namespace && namespace !== providerSlug && (
                                <div className="flex items-baseline justify-between gap-2 min-w-0">
                                  <dt className="text-textMuted shrink-0">{t('models_info_family')}</dt>
                                  <dd dir="ltr" title={namespace} className="font-mono text-textMain truncate">{namespace}</dd>
                                </div>
                              )}
                              {model.category && (
                                <div className="flex items-baseline justify-between gap-2 min-w-0">
                                  <dt className="text-textMuted shrink-0">{t('models_info_category')}</dt>
                                  <dd dir="ltr" title={model.category} className="font-mono text-textMain truncate">{model.category}</dd>
                                </div>
                              )}
                              {/* Round 1b: context length / max output. Rendered
                                  ONLY when the gateway carried a finite number;
                                  the formatter returns null otherwise, so no
                                  row and no fabricated default. Values are
                                  technical, hence dir="ltr". */}
                              {formatTokenCount(model.context_length) && (
                                <div className="flex items-baseline justify-between gap-2 min-w-0">
                                  <dt className="text-textMuted shrink-0">{t('models_info_context_length')}</dt>
                                  <dd dir="ltr" className="font-mono text-textMain truncate">{formatTokenCount(model.context_length)}</dd>
                                </div>
                              )}
                              {formatTokenCount(model.max_completion_tokens) && (
                                <div className="flex items-baseline justify-between gap-2 min-w-0">
                                  <dt className="text-textMuted shrink-0">{t('models_info_max_output')}</dt>
                                  <dd dir="ltr" className="font-mono text-textMain truncate">{formatTokenCount(model.max_completion_tokens)}</dd>
                                </div>
                              )}
                              <div className="flex items-baseline justify-between gap-2 min-w-0">
                                <dt className="text-textMuted shrink-0">{t('models_info_description')}</dt>
                                {/* dir="auto" mirrors the card's own description
                                    paragraph: a free-text catalogue string may
                                    mix scripts, and the drawer must not render
                                    it with a different bidi order than the card. */}
                                <dd dir="auto" className="text-textMain/90 text-end break-words">
                                  {model.shortDescription || t('models_default_description', { provider: providerInfo.name })}
                                </dd>
                              </div>
                              {(model.freeEndpoint || model.downloadable) && (
                                <div className="flex items-baseline justify-between gap-2 min-w-0">
                                  <dt className="text-textMuted shrink-0">{t('models_info_availability')}</dt>
                                  <dd className="flex flex-wrap justify-end gap-1">
                                    {model.freeEndpoint && (
                                      <span className="px-2 py-0.5 text-[10px] font-mono rounded border border-purple-700/60 bg-purple-950/40 text-purple-300">
                                        {t('models_info_free_endpoint')}
                                      </span>
                                    )}
                                    {model.downloadable && (
                                      <span className="px-2 py-0.5 text-[10px] font-mono rounded border border-cyan-700/60 bg-cyan-950/40 text-cyan-300">
                                        {t('models_info_downloadable')}
                                      </span>
                                    )}
                                  </dd>
                                </div>
                              )}
                              {model.lastUpdated && (
                                <div className="flex items-baseline justify-between gap-2 min-w-0">
                                  <dt className="text-textMuted shrink-0">{t('models_info_last_updated')}</dt>
                                  <dd dir="ltr" title={model.lastUpdated} className="font-mono text-textMain truncate">{model.lastUpdated}</dd>
                                </div>
                              )}
                              {formatPopularity(model.popularity) != null && (
                                <div className="flex items-baseline justify-between gap-2 min-w-0">
                                  <dt className="text-textMuted shrink-0">{t('models_info_popularity')}</dt>
                                  {/* The value is RENDERED THROUGH the formatter, never raw:
                                      `{model.popularity}` would print the literal text "null" if a
                                      null ever reached this row (the backend emits null for an
                                      unknown count — admin-api.mjs:336-338, models-ipc.ts:202-204).
                                      The guard already proves the formatter is non-null here, so
                                      String(...) only satisfies TS' null-check on the repeated call. */}
                                  <dd dir="ltr" title={String(formatPopularity(model.popularity))} className="font-mono text-textMain truncate">{formatPopularity(model.popularity)}</dd>
                                </div>
                              )}
                              {/* Round E: overall model strength from LLM Stats.
                                  A rank row is rendered ONLY when the gateway
                                  genuinely matched this model (llmStatsRank is
                                  a positive integer, so formatStrengthRank() is
                                  non-null). When there is no genuine ranking the
                                  WHOLE block is omitted — no placeholder, no
                                  "—"/"Not ranked" row. The attribution link is
                                  part of the block because the LLM Stats licence
                                  requires it wherever the ranking is shown:
                                  showing a rank means showing the attribution,
                                  showing nothing means showing no attribution
                                  (a "Strength source" link with no ranking next
                                  to it would itself be an unexplained row). */}
                              {strengthRank && (
                                <>
                                  <div className="flex items-baseline justify-between gap-2 min-w-0">
                                    <dt className="text-textMuted shrink-0">{t('models_info_strength_rank')}</dt>
                                    <dd
                                      dir="ltr"
                                      title={`${strengthRank}${
                                        formatScore(model.llmStatsScore) != null ? ` (${formatScore(model.llmStatsScore)})` : ''
                                      }`}
                                      className="font-mono text-textMain truncate"
                                    >
                                      {strengthRank}
                                      {formatScore(model.llmStatsScore) != null && (
                                        <span className="ms-1 text-textMuted">({formatScore(model.llmStatsScore)})</span>
                                      )}
                                    </dd>
                                  </div>
                                  <div className="flex items-baseline justify-between gap-2 min-w-0">
                                    <dt className="text-textMuted shrink-0">{t('models_info_strength_score')}</dt>
                                    <dd dir="ltr" className="truncate">
                                      {/* Opens via the preload openExternal route; the
                                          main-process window open handler denies new tabs. */}
                                      <a
                                        href={LLM_STATS_SOURCE_URL}
                                        onClick={(e) => { e.preventDefault(); window.electronAPI?.openExternal(LLM_STATS_SOURCE_URL).catch(() => undefined); }}
                                        className="text-accent-neon hover:underline"
                                        title={t('models_source_attribution')}
                                      >
                                        {t('models_source_attribution')}
                                      </a>
                                    </dd>
                                  </div>
                                </>
                              )}
                              {/* Round 1b: capabilities. describeCapabilities()
                                  returns ONLY what the gateway actually
                                  asserted (reasoning with its control key,
                                  vision, tools); an empty/absent payload
                                  yields no row, which also covers the
                                  gateway's ~30-60 s cold-start window. */}
                              {capabilityRows.length > 0 && (
                                <div className="flex items-baseline justify-between gap-2 min-w-0">
                                  <dt className="text-textMuted shrink-0">{t('models_info_capabilities')}</dt>
                                  <dd className="flex flex-wrap justify-end gap-1">
                                    {capabilityRows.map((cap) => (
                                      <span
                                        key={cap.id}
                                        className="px-2 py-0.5 text-[10px] font-mono rounded border border-border bg-surface text-textMain"
                                      >
                                        <span dir="ltr">{t(cap.labelKey)}</span>
                                        {/* The gateway names the request knob it
                                            switches for this capability (e.g.
                                            `reasoning_effort`). Shown with its
                                            label so a bare identifier is not
                                            left unexplained. */}
                                        {cap.controlKey && (
                                          <span className="ms-1">
                                            <span className="text-textMuted">{t('models_info_control_key')}</span>
                                            <code dir="ltr" className="ms-1 text-accent-neon">{cap.controlKey}</code>
                                          </span>
                                        )}
                                      </span>
                                    ))}
                                  </dd>
                                </div>
                              )}
                            </dl>
                            {/* Small print: spells out that these are the rows the
                                catalogue actually provides (nothing invented is
                                rendered above). */}
                            <p className="text-[10px] text-textMuted leading-relaxed">{t('models_details_description')}</p>
                          </section>

                          {/* ── Section 2: Примеры ── */}
                          <section aria-labelledby={`drawer-examples-${model.id}`} className="space-y-2 border-t border-border/50 pt-2.5">
                            <h4
                              id={`drawer-examples-${model.id}`}
                              className="flex items-center gap-1.5 text-[10px] text-textMuted uppercase font-bold tracking-wider"
                            >
                              <Terminal aria-hidden size={12} className="text-nvidia" />
                              <span>{t('models_section_examples')}</span>
                            </h4>

                            {/* cURL Snippet Preview */}
                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <div className="text-[10px] text-textMuted font-mono">{t('models_curl_preview')}</div>
                                <button
                                  type="button"
                                  onClick={() => copy(curlSnippet, `curl-${model.id}`)}
                                  className="text-xs text-accent-neon hover:text-accent-neon/80 flex items-center gap-1 cursor-pointer min-h-6"
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
                              <pre dir="ltr" className="bg-[#080B09] border border-border/80 p-2.5 text-[11px] font-mono text-textMuted overflow-x-auto whitespace-pre-wrap break-all rounded leading-relaxed">
                                {curlSnippet}
                              </pre>
                            </div>
                          </section>

                          {/* ── Curated capability tags ──
                              Bounded (MAX_CURATED_TAGS = 5), vocabulary-fixed
                              and only for capabilities that genuinely apply to
                              THIS model. Nothing applies -> nothing renders
                              (no empty block). */}
                          {curatedTagIds.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 border-t border-border/50 pt-2.5">
                              {curatedTagIds.map((tagId) => {
                                const meta = CURATED_TAG_META[tagId];
                                if (!meta) return null;
                                return (
                                  <span
                                    key={tagId}
                                    dir="auto"
                                    className={`flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${meta.bgClass} ${meta.borderClass} ${meta.colorClass}`}
                                  >
                                    {meta.icon}
                                    <span>{t(meta.labelKey as any)}</span>
                                  </span>
                                );
                              })}
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
