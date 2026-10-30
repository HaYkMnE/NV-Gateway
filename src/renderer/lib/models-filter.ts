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
 *   - popularity: nvidia-catalog-sync.mjs recordToMetadata() yields an int >= 0
 *     when NGC publishes a count and null when it does not; admin-api.mjs emits
 *     null (never a fabricated 0) for a model with no count. A "minimum
 *     popularity" threshold therefore treats a missing count as "unknown" (the
 *     model is NOT hidden at threshold > 0), and 0 ("any") hides nothing.
 *   - labels: string[] from the NGC labels/tags array (publisher entries are
 *     stripped upstream), [] when unmatched. Chips are derived from the loaded
 *     models, so a label can only be offered when something actually carries it.
 *   - freeEndpoint / downloadable: booleans (isPublic / canGuestDownload),
 *     defaulted to false upstream. Modelled as opt-in narrowing toggles rather
 *     than tri-state, because false is indistinguishable from "unknown" here.
 *
 * Deliberately NOT filtered on: reasoning support. The gateway DOES expose it in
 * the optional `capabilities` object and mapModelCatalog() now forwards it
 * (ModelConfig / ModelEntry declare it), but the object can be absent or empty
 * for a given model — and for a window after gateway start while the discovery
 * cache is cold — so filtering on it could hide otherwise-working models.
 */

/** Sort orders already offered by the Models toolbar. */
export type ModelSortBy = 'popular' | 'name' | 'updated' | 'top';

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
  /**
   * Overall-strength position from LLM Stats (1 = strongest), fed by
   * llm-stats-ranking.mjs. ABSENT for the 58 of 82 models with no genuine
   * counterpart, which is why the strength sort treats a missing value as
   * "unranked" and never as a top position.
   */
  llmStatsRank?: number;
}

export interface ModelFilterState {
  /** Free-text search — the pre-existing search box. */
  query: string;
  /** Provider slug from the pre-existing company chips ('' = all companies). */
  company: string;
  /** Sort order from the pre-existing select. Sorting hides nothing. */
  sortBy: ModelSortBy;
  /**
   * Minimum monthly-invocation count; 0 = any.
   *
   * DORMANT: the owner removed the "minimum popularity" row, which was the only
   * control that ever wrote this field, so the view can no longer set it and it
   * stays at its neutral 0. The field and its logic in applyModelFilters() /
   * hasActiveFilters() are kept on purpose — the axis still behaves correctly if
   * a threshold is passed, so removing the UI cannot silently change the filter's
   * public behaviour, and `0` (the only value reachable now) hides nothing.
   */
  minPopularity: number;
  /** Selected label chips, matched as ANY-of. Empty = no label narrowing. */
  labels: string[];
  /** Show only models NVIDIA exposes as a free endpoint. */
  freeOnly: boolean;
  /** Show only models flagged downloadable. */
  downloadableOnly: boolean;
}

/** The neutral state: every model passes, nothing is hidden. */
export const DEFAULT_MODEL_FILTERS: ModelFilterState = {
  query: '',
  company: '',
  // 'top' (LLM Stats overall strength) is the default: the owner asked for the
  // strongest models first on a fresh profile («сортировки по умолчанию сделай
  // топовые»). It only applies while `filters` is at its initial value — the
  // view seeds its state from this constant once per mount and every subsequent
  // change goes through patchFilters/resetModelFilters, so an explicitly chosen
  // sort is never overwritten. `resetModelFilters` deliberately PRESERVES the
  // user's sort (it copies `sortBy` from the current state), so a reset lands on
  // the sort the user picked, not back on 'top'.
  sortBy: 'top',
  // Kept at the neutral value: with the "minimum popularity" row removed there
  // is no control that could raise it, so this is the only reachable state.
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
 * Known NGC label values -> i18n key of the human-readable chip text.
 *
 * recordToMetadata() pushes string-valued NGC label entries verbatim
 * (nvidia-catalog-sync.mjs:271-291), and NGC emits some of them as namespaced
 * backend keys ("usecase:endpoint:usecase_text_gen", "cloudPartnerType:endpoint:…",
 * "nimType:…", "playgroundType:…"). Rendering those raw in the filter chips is
 * meaningless to a user, so the values we KNOW map to localized display text.
 * The map keys are the bare VALUE token — the part after the last ':' — so the
 * same value is recognized whether it arrives namespaced or bare.
 */
const KNOWN_LABEL_I18N_KEYS: Readonly<Record<string, string>> = {
  usecase_text_gen: 'models_label_usecase_text_gen',
};

/**
 * The i18n key of the human-readable chip text for a label, or null when the
 * label is not a known mapping — the caller MUST then render the raw label so
 * an unknown label never silently disappears.
 */
export function modelLabelI18nKey(label: string): string | null {
  if (typeof label !== 'string') return null;
  const value = label.includes(':') ? label.slice(label.lastIndexOf(':') + 1) : label;
  return KNOWN_LABEL_I18N_KEYS[value] ?? null;
}

/**
 * The FIXED tag allow-list for the filter chips (owner 30.09: «слишком много
 * лишних меток, убери хотя бы половину»; table by design-art-virtuoso).
 *
 * Each canonical tag lists the raw NGC labels it stands for; matching is
 * case-insensitive on the trimmed label. A raw label that is NOT listed here is
 * HIDDEN from the chip row (e.g. nemotron, nvidia nim, Open, Frontier, Chat,
 * text-to-text, Customization, …). Canonical names are English in every locale.
 * The per-card drawer tags are unaffected: they come from curateCapabilityTags().
 */
export const CANONICAL_MODEL_TAGS: readonly { tag: string; raw: readonly string[] }[] = [
  { tag: 'MoE', raw: ['Mixture-of-Experts', 'MoE', 'Multimodal MOE'] },
  { tag: 'Guardrails', raw: ['ai safety nemo guardrails', 'Guardrail', 'nemo guardrails', 'nemoguard', 'multilingual guard model'] },
  {
    tag: 'Safety',
    raw: ['content moderation', 'Content Moderator', 'Content Safety', 'dialogue safety', 'LLM Multimodal Safety',
      'LLM safety', 'multilingual content safety', 'Safety and moderation'],
  },
  { tag: 'Retrieval', raw: ['Agentic Retrieval', 'Code Retrieval', 'Image-Text Retrieval', 'nemo retriever', 'Nemotron Retriever'] },
  { tag: 'Embedding', raw: ['embedding'] },
  { tag: 'Agents', raw: ['Agent', 'agentic', 'Agentic AI', 'Long-running agents'] },
  { tag: 'Tool Use', raw: ['Tool Use'] },
  {
    tag: 'Multimodal',
    raw: ['Multimodal', 'VLM', 'Vision Language Model', 'Image-to-Text', 'Image Captioning', 'Visual QA',
      'Visual Grounding', 'Omni'],
  },
  { tag: 'OCR', raw: ['OCR', 'document parsing', 'text and table extraction'] },
  { tag: 'Coding', raw: ['Coding'] },
  { tag: 'Reasoning', raw: ['Reasoning'] },
  { tag: 'Math', raw: ['math'] },
  { tag: 'Long Context', raw: ['Long Context'] },
  { tag: 'Translation', raw: ['neural machine translation'] },
  { tag: 'Video', raw: ['Video'] },
];

/** Lower-cased raw label -> canonical tag, built once from the table above. */
const CANONICAL_TAG_BY_RAW: ReadonlyMap<string, string> = new Map(
  CANONICAL_MODEL_TAGS.flatMap((entry) => entry.raw.map((raw) => [raw.toLowerCase(), entry.tag] as [string, string]))
);

/** The canonical tag a raw catalogue label maps to, or null when it is hidden. */
export function canonicalModelTag(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  return CANONICAL_TAG_BY_RAW.get(label.trim().toLowerCase()) ?? null;
}

/**
 * The canonical tags carried by the given models — the chip row is built from
 * this, so it can never offer a tag that matches nothing.
 *
 * Rules: only allow-listed labels count (canonicalModelTag); catalogue plumbing
 * (`cloudPartnerType:…`, `supported …`) is additionally dropped by the existing
 * isNoiseLabel() predicate — none of it is in the allow-list, so this is a
 * belt-and-braces guard, not a second rule. All casings of a raw label collapse
 * to its one canonical tag. Order: number of models carrying the tag,
 * descending; ties alphabetical (codepoint order, deterministic on every ICU).
 */
export function collectModelLabels(models: readonly FilterableModel[]): string[] {
  const counts = new Map<string, number>();
  for (const m of models) {
    if (!Array.isArray(m.labels)) continue;
    // A model counts ONCE per tag even when it carries several of its raw labels.
    const own = new Set<string>();
    for (const label of m.labels) {
      if (typeof label !== 'string' || isNoiseLabel(label)) continue;
      const tag = canonicalModelTag(label);
      if (tag !== null) own.add(tag);
    }
    for (const tag of own) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([tag]) => tag);
}

/**
 * Drop selected tags that are no longer offered (e.g. after a models reload),
 * so a selection can never keep narrowing the list invisibly. Returns the SAME
 * array when nothing is dropped, so a state setter can bail out of a re-render.
 */
export function pruneSelectedLabels(selected: readonly string[], available: readonly string[]): readonly string[] {
  const kept = selected.filter((s) => available.some((a) => labelMatchesSelection(a, s)));
  return kept.length === selected.length ? selected : kept;
}

/** Whether one raw model label satisfies one selected chip (canonical tag or raw label). */
function modelLabelMatches(rawLabel: unknown, selected: string): boolean {
  const tag = canonicalModelTag(rawLabel);
  if (tag !== null && labelMatchesSelection(tag, selected)) return true;
  // Kept for API compatibility: a caller passing a raw label still matches it.
  return labelMatchesSelection(rawLabel, selected);
}

/**
 * Whether a model carries the label a chip stands for.
 *
 * Case-insensitive on purpose: `collectModelLabels` collapses `chat`/`Chat` into
 * ONE chip whose text is a single real spelling, so an exact `includes()` would
 * silently stop matching the models that spell it the other way — the chip would
 * advertise a filter that hides its own models.
 */
export function labelMatchesSelection(rawLabel: unknown, selectedLabel: string): boolean {
  if (typeof rawLabel !== 'string' || typeof selectedLabel !== 'string') return false;
  return rawLabel.trim().toLowerCase() === selectedLabel.trim().toLowerCase();
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
 * Apply every axis (search, company, labels, toggles — plus the dormant
 * `minPopularity`, which does nothing at its neutral 0) and then sort.
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
      // A chip is a canonical tag (see collectModelLabels): it matches a model
      // carrying ANY of that tag's raw labels, in any casing. Tags OR together.
      if (!own.some((l) => wanted.some((w) => modelLabelMatches(l, w)))) return false;
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
      case 'top': {
        // LLM Stats overall strength: rank 1 is the strongest, so ascending.
        // A model is "ranked" ONLY on a positive integer rank; anything else
        // (absent, null, NaN, Infinity, 0, negative, fractional, a string) is
        // unranked and must never be promoted to the top of the list.
        const rankA = validStrengthRank(a.llmStatsRank);
        const rankB = validStrengthRank(b.llmStatsRank);
        if (rankA !== null && rankB !== null) {
          if (rankA !== rankB) return rankA - rankB;
        } else if (rankA !== null) {
          return -1;
        } else if (rankB !== null) {
          return 1;
        }
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
 * A usable LLM Stats rank, or null when the model is unranked.
 *
 * Strict on purpose: the value arrives over IPC from a remote index, so only a
 * positive safe integer counts. Everything else means "no ranking", which keeps
 * a malformed payload from silently reordering the list.
 */
function validStrengthRank(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * True when some filter can currently hide a model. Sort order is excluded on
 * purpose: reordering never removes anything, so resetting must not disturb it.
 *
 * `minPopularity` is included because it is not forced to 0 by the type or the
 * reset — a caller passing a positive threshold must still see "something is
 * hiding models". The view can no longer reach a non-zero value (the threshold
 * row is gone), so for the current UI this term is always false.
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

// ───────────────────────────────────────────────────────────────────────────
// Card-drawer ("Подробнее") presentation helpers — UI PRESENTATION ONLY.
//
// These do NOT touch filtering: collectModelLabels / applyModelFilters above
// are untouched, so the filter-chip universe and every narrowing axis behave
// exactly as before. The helpers below shape what the per-card drawer shows.
//
// The input shape is structural (no imports — see the module header) so
// ModelEntry (stores/models.ts) and ModelConfig (global.d.ts) satisfy it.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The capability tags the drawer may show, in display priority order, paired
 * with their i18n key and the icon `extractCapabilities()` renders for each id.
 *
 * This is a FIXED vocabulary: a tag can only appear when the corresponding
 * signal is actually true for the model, so the drawer can never invent a
 * capability. The order is the order they are rendered (highest signal first).
 */
export const CURATED_TAG_VOCABULARY: readonly { id: string; labelKey: string }[] = [
  { id: 'reasoning', labelKey: 'tag_reasoning' },
  { id: 'vision', labelKey: 'tag_vision' },
  { id: 'code', labelKey: 'tag_code' },
  { id: 'function_calling', labelKey: 'tag_function_calling' },
];

/**
 * Hard cap on the number of curated capability tags rendered in the drawer.
 *
 * CHOSEN CAP = 5 (backend-generalist, 2026-09-18, Level-1 UX Round 1). The
 * vocabulary above now has 4 members (Tools was folded into Function Calling,
 * wave 6A F2), so the realistic maximum for one model is reasoning + vision +
 * code + function_calling, and most models carry 1-3. The cap is enforced
 * anyway (and unit-tested) so that adding vocabulary entries later can
 * never silently overflow the row. Raise/lower here — nothing else reads it.
 */
export const MAX_CURATED_TAGS = 5;

/**
 * The vocabulary ids that have NO presentation meta for the given id set.
 *
 * The drawer renders `metaFor(tagId)` and drops the tag when it is absent, so a
 * vocabulary entry without presentation would silently vanish. Both callers
 * (the view's dev-time guard and the tests) derive from the SAME comparison.
 *
 * Pure and side-effect-free; exported so the contract is unit-testable without
 * a renderer harness.
 */
export function missingCuratedTagPresentation(
  presentIds: Iterable<string> | undefined | null,
  vocabulary: readonly { id: string }[] = CURATED_TAG_VOCABULARY
): string[] {
  const present = new Set<string>();
  if (presentIds) {
    for (const id of presentIds) if (typeof id === 'string') present.add(id);
  }
  return vocabulary.filter((entry) => !present.has(entry.id)).map((entry) => entry.id);
}

/**
 * Dev-time guard: the vocabulary (this module) and the view's presentation map
 * must describe the SAME ids. Call it from the view with the ids its map
 * actually carries; a drift is reported here (NOT in the view — the repo bans
 * `console.*` in `src/renderer/views/*.tsx`). Returns the missing ids so the
 * check is testable and so callers may act on it.
 *
 * Full coverage is the normal case: zero output, zero warning.
 */
export function warnOnCuratedTagPresentationDrift(
  presentIds: Iterable<string> | undefined | null
): string[] {
  const missing = missingCuratedTagPresentation(presentIds);
  if (missing.length > 0 && typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(
      'CURATED_TAG_VOCABULARY/META drift: curated tag(s) without presentation meta will not render: '
      + missing.join(', ')
    );
  }
  return missing;
}

/**
 * Which labels count as pure catalogue plumbing and are therefore never shown
 * as curated tags. Everything here is namespaced metadata (keyed by the bare
 * value token, i.e. the part after the last ':') or the `supported*` /
 * `Input|Output*` family. Filtering is done on the RAW label too, so an
 * unrecognised-namespace case can only err by hiding a label that would never
 * have matched the allowed vocabulary anyway.
 */
const NOISE_LABEL_TOKENS = new Set<string>([
  'endpoint',
  'usecase',
  'cloudpartnertype',
  'nimtype',
  'playgroundtype',
  'supported',
  'input',
  'output',
]);

/** Namespace prefixes (lowercased, before the first ':') that are pure metadata. */
const NOISE_LABEL_NAMESPACES = [
  'cloudpartnertype:',
  'nimtype:',
  'endpoint:',
  'usecase:',
  'playgroundtype:',
];

/**
 * True when a raw catalogue label is plumbing the user should never read as a
 * capability: a namespaced backend key (`cloudPartnerType:endpoint:…`,
 * `nimType:endpoint:…`), a `supported*` / `Input*` / `Output*` plumbing value,
 * or an empty/blank string.
 *
 * Pure and side-effect-free; exported so the rule is unit-testable directly.
 */
export function isNoiseLabel(label: unknown): boolean {
  if (typeof label !== 'string') return true;
  const trimmed = label.trim().toLowerCase();
  if (!trimmed) return true;
  if (NOISE_LABEL_NAMESPACES.some((prefix) => trimmed.startsWith(prefix))) return true;
  if (trimmed.startsWith('supported') || trimmed.startsWith('input') || trimmed.startsWith('output')) return true;
  const token = trimmed.includes(':') ? trimmed.slice(trimmed.lastIndexOf(':') + 1) : trimmed;
  return NOISE_LABEL_TOKENS.has(token);
}

/** The curated-tag signal shape read from a catalogue label. */
export interface CuratedTagSignals {
  reasoning: boolean;
  vision: boolean;
  code: boolean;
  function_calling: boolean;
}

/**
 * Derive the raw capability signals `extractCapabilities()` uses for its tags
 * from a model's labels.
 *
 * The match predicates are byte-for-byte the label-based predicates of the
 * existing per-card `extractCapabilities()` (Models.tsx): a NON-noise label
 * containing 'reason' / 'vision' / 'image' / 'code' / 'tool' / 'function'
 * raises the corresponding signal. Every signal defaults to FALSE — an
 * unrecognised label is inert, so the drawer never shows a tag it cannot back.
 *
 * `extractCapabilities()` itself starts from these same label signals but ALSO
 * accepts id/category keyword heuristics (e.g. a bare `…-vl` id ⇒ Vision). The
 * drawer deliberately renders the union of both, so a capability that is
 * visibly inferred on the card cannot vanish from the expanded drawer.
 */
export function deriveTagSignals(labels: readonly string[] | undefined | null): CuratedTagSignals {
  const signals: CuratedTagSignals = {
    reasoning: false,
    vision: false,
    code: false,
    function_calling: false,
  };
  if (!Array.isArray(labels)) return signals;
  for (const label of labels) {
    if (isNoiseLabel(label)) continue;
    const normalized = (label as string).trim().toLowerCase();
    if (normalized.includes('reason')) signals.reasoning = true;
    if (normalized.includes('vision') || normalized.includes('image')) signals.vision = true;
    if (normalized.includes('code')) signals.code = true;
    // 'tool'/'function' label signals map to the card's single Function Calling
    // tag, exactly as extractCapabilities() does, so card and drawer use one
    // term and a screen reader announces the capability once (no separate Tools tag).
    if (normalized.includes('tool') || normalized.includes('function')) {
      signals.function_calling = true;
    }
  }
  return signals;
}

/** Structural shape of a card-level capability tag (mirrors CapabilityTag in Models.tsx). */
export interface TagLike {
  id: string;
}

/**
 * Curate the capability tags a model's drawer should show.
 *
 * Rules (all unit-tested):
 *   1. A tag survives only when it appears in `cardTags` — the tags already
 *      rendered on the card by `extractCapabilities(id, labels, category)`, so
 *      the drawer can never contradict the card — OR when the model's
 *      non-noise labels raise the matching signal (`deriveTagSignals`), which
 *      covers the inverse direction (a label-only signal the id heuristics
 *      missed). The union keeps card and drawer consistent.
 *   2. Pure metadata labels (`cloudPartnerType:*`, `nimType:*`, `endpoint:*`,
 *      `usecase:*`, `supported*`, `Input*`/`Output*` plumbing) contribute
 *      nothing — see `isNoiseLabel`.
 *   3. The result is bounded by `MAX_CURATED_TAGS` and de-duplicated.
 *   4. No tag applies ⇒ `[]` (the drawer renders nothing, never an empty row).
 *
 * Returns tag IDs drawn from the fixed `CURATED_TAG_VOCABULARY` vocabulary.
 */
export function curateCapabilityTags(
  cardTags: readonly TagLike[] | undefined | null,
  labels: readonly string[] | undefined | null,
  max = MAX_CURATED_TAGS
): string[] {
  const limit = Number.isFinite(max) && Number(max) >= 0 ? Math.floor(Number(max)) : MAX_CURATED_TAGS;
  if (limit === 0) return [];
  const present = new Set<string>();
  if (Array.isArray(cardTags)) {
    for (const tag of cardTags) {
      if (tag && typeof tag.id === 'string') present.add(tag.id);
    }
  }
  const signals = deriveTagSignals(labels) as unknown as Record<string, boolean>;
  const curated: string[] = [];
  // Membership is decided by the FIXED vocabulary, so `cardTags` can only ever
  // ADMIT a vocabulary id — a future card-only tag cannot leak into the drawer
  // without an explicit vocabulary entry (see the test asserting the vocabulary
  // and the view's presentation map describe the same ids).
  for (const entry of CURATED_TAG_VOCABULARY) {
    if (present.has(entry.id) || signals[entry.id] === true) curated.push(entry.id);
    if (curated.length >= limit) break;
  }
  return curated;
}
