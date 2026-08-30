/**
 * Pure filter/sort logic for the Models view (user bug list П8).
 *
 * Extracted from Models.tsx so it can be unit-tested: the repo has no jsdom and
 * no @testing-library/react, so components cannot be rendered. The test harness
 * (tests/models-filter-controls.test.mjs, mirroring
 * tests/feedback-save-path-visible.test.mjs) transpiles this file and runs it in
 * a bare `vm` context whose sandbox holds only { Error, exports, module } — so
 * this module MUST stay free of imports.
 *
 * Which fields are filtered on, and why (measured, not assumed):
 *   - popularity: nvidia-catalog-sync.mjs recordToMetadata() sets it via
 *     parseIntSafe(), so it is an int >= 0 and NEVER null; admin-api.mjs:260
 *     substitutes 0 when NGC has no match for the model. A "minimum popularity"
 *     threshold is therefore always well-defined, and 0 ("any") hides nothing.
 *   - labels: string[] from the NGC labels/tags array (publisher entries are
 *     stripped upstream), [] when unmatched. Chips are derived from the loaded
 *     models, so a label can only be offered when something actually carries it.
 *   - freeEndpoint / downloadable: booleans (isPublic / canGuestDownload),
 *     defaulted to false upstream. Modelled as opt-in narrowing toggles rather
 *     than tri-state, because false is indistinguishable from "unknown" here.
 *
 * Deliberately NOT filtered on: reasoning support. src/main/models-ipc.ts
 * mapModelCatalog() is the only gateway->renderer path and it drops the
 * `capabilities` field entirely (it is declared on the input type at line 93 and
 * never copied into the returned object), and neither ModelConfig
 * (src/renderer/global.d.ts) nor ModelEntry (src/renderer/stores/models.ts)
 * declares it. Filtering on data that never arrives would silently hide working
 * models, which is worse than offering no filter.
 */

/** Sort orders already offered by the Models toolbar. Unchanged. */
export type ModelSortBy = 'popular' | 'name' | 'updated';

/**
 * The subset of a model record this logic reads. Structural on purpose so both
 * ModelEntry (stores/models.ts) and ModelConfig (global.d.ts) satisfy it without
 * this module importing either.
 */
export interface FilterableModel {
  id: string;
  name?: string;
  publisher?: string | null;
  provider?: string | null;
  shortDescription?: string;
  labels?: string[];
  popularity?: number;
  lastUpdated?: string | null;
  downloadable?: boolean;
  freeEndpoint?: boolean;
}

export interface ModelFilterState {
  /** Free-text search — the pre-existing search box. */
  query: string;
  /** Provider slug from the pre-existing company chips ('' = all companies). */
  company: string;
  /** Sort order from the pre-existing select. Sorting hides nothing. */
  sortBy: ModelSortBy;
  /** Minimum monthly-invocation count; 0 = any. */
  minPopularity: number;
  /** Selected label chips, matched as ANY-of. Empty = no label narrowing. */
  labels: string[];
  /** Show only models NVIDIA exposes as a free endpoint. */
  freeOnly: boolean;
  /** Show only models flagged downloadable. */
  downloadableOnly: boolean;
}

/** Threshold choices offered by the popularity select. 0 must stay first ("any"). */
export const POPULARITY_THRESHOLDS: readonly number[] = [0, 1_000, 10_000, 100_000, 1_000_000];

/** The neutral state: every model passes, nothing is hidden. */
export const DEFAULT_MODEL_FILTERS: ModelFilterState = {
  query: '',
  company: '',
  sortBy: 'popular',
  minPopularity: 0,
  labels: [],
  freeOnly: false,
  downloadableOnly: false,
};

/** Provider slug of a model — same precedence the view has always used. */
function providerSlugOf(m: FilterableModel): string | null {
  return m.publisher ?? m.provider ?? (m.id.includes('/') ? m.id.split('/')[0] : null);
}

/** The part of an id after the publisher slash. */
function nameOf(id: string): string {
  return id.includes('/') ? id.split('/').slice(1).join('/') : id;
}

/**
 * Every distinct label carried by the given models, deduped and sorted. The chip
 * row is built from this, so it can never advertise a label that would match
 * nothing.
 */
export function collectModelLabels(models: readonly FilterableModel[]): string[] {
  const seen = new Set<string>();
  for (const m of models) {
    if (!Array.isArray(m.labels)) continue;
    for (const label of m.labels) {
      if (typeof label === 'string' && label.trim()) seen.add(label.trim());
    }
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

/** Free-text match across id, name, provider slug, description and labels. */
function matchesQuery(m: FilterableModel, needle: string): boolean {
  if (m.id?.toLowerCase().includes(needle)) return true;
  if (m.name?.toLowerCase().includes(needle)) return true;
  if (nameOf(m.id ?? '').toLowerCase().includes(needle)) return true;
  const slug = providerSlugOf(m);
  if (slug?.toLowerCase().includes(needle)) return true;
  if (m.shortDescription?.toLowerCase().includes(needle)) return true;
  if (m.publisher?.toLowerCase().includes(needle)) return true;
  if (m.provider?.toLowerCase().includes(needle)) return true;
  if (Array.isArray(m.labels)
    && m.labels.some((l) => typeof l === 'string' && l.toLowerCase().includes(needle))) return true;
  return false;
}

/**
 * Apply every axis (search, company, popularity, labels, toggles) and then sort.
 * All axes AND together; only the label chips are ANY-of among themselves.
 */
export function applyModelFilters<T extends FilterableModel>(
  models: readonly T[],
  filters: ModelFilterState
): T[] {
  const needle = (filters.query ?? '').trim().toLowerCase();
  const wanted = Array.isArray(filters.labels) ? filters.labels : [];
  const threshold = Number.isFinite(filters.minPopularity) ? Number(filters.minPopularity) : 0;

  const kept = models.filter((m) => {
    if (needle && !matchesQuery(m, needle)) return false;
    if (filters.company && providerSlugOf(m) !== filters.company) return false;
    if (threshold > 0) {
      const pop = typeof m.popularity === 'number' ? m.popularity : 0;
      if (pop < threshold) return false;
    }
    if (wanted.length > 0) {
      const own = Array.isArray(m.labels) ? m.labels : [];
      if (!own.some((l) => wanted.includes(l))) return false;
    }
    if (filters.freeOnly && m.freeEndpoint !== true) return false;
    if (filters.downloadableOnly && m.downloadable !== true) return false;
    return true;
  });

  // Sort semantics preserved verbatim from the previous inline implementation.
  return kept.sort((a, b) => {
    switch (filters.sortBy) {
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
}

/**
 * True when some filter can currently hide a model. Sort order is excluded on
 * purpose: reordering never removes anything, so resetting must not disturb it.
 */
export function hasActiveFilters(filters: ModelFilterState): boolean {
  return Boolean(
    (filters.query ?? '').trim()
    || filters.company
    || (Number.isFinite(filters.minPopularity) ? Number(filters.minPopularity) : 0) > 0
    || (Array.isArray(filters.labels) && filters.labels.length > 0)
    || filters.freeOnly
    || filters.downloadableOnly
  );
}

/** Clear every hiding filter, keeping the user's chosen sort order. */
export function resetModelFilters(filters: ModelFilterState): ModelFilterState {
  return { ...DEFAULT_MODEL_FILTERS, sortBy: filters.sortBy };
}
