/**
 * Pet advisor (wave 6B): the tip registry, the per-occurrence persistence and
 * the target-page focus helper.
 *
 * Only `react` is imported (tests/pet-tips.test.mjs runs this module in a bare
 * vm context with a tiny React fake), so keep it free of other imports.
 *
 * Random tips (spec 2026-10-26 §4.2-4.3): RANDOM_TIP_REGISTRY, selectRandomTip
 * and the pure scheduler helpers; PetWidget owns the timers and the channel.
 *
 * Persistence: localStorage `nv_pet_tips` = { enabled, dismissed[], lastShownAt{}, never[] },
 * read through useSyncExternalStore. getTipsSnapshot() returns the RAW stored
 * string (a primitive, so an unchanged value is Object.is-equal and React does
 * not loop); the parse is memoized on that string. Writes notify subscribers
 * directly, because the `storage` event never fires in the writing document.
 */
import { useMemo, useSyncExternalStore } from 'react';

export const TIPS_STORAGE_KEY = 'nv_pet_tips';
/** J: the soonest key retry must be at least this far away. */
export const KEYS_RETRY_MIN_MS = 30 * 60_000;
/** J: a dismissed keys-exhausted occurrence re-arms this long after it was shown. */
export const KEYS_REARM_MS = 24 * 60 * 60_000;

/** The subset of an admin key record the registry reads. */
export interface TipKey {
  status?: string;
  backoffUntil?: unknown;
}

export interface TipsState {
  enabled: boolean;
  dismissed: string[];
  lastShownAt: Record<string, number>;
  /** Random-tip ids the user hid with "Don't show this again" (spec 4.4). */
  never: string[];
}

export interface TipData {
  route: string;
  gatewayState?: string;
  keys?: readonly TipKey[] | null;
  update?: { state?: string; version?: string | null } | null;
}

export type TipEvalInput = TipData & { lastShownAt: Record<string, number> };

export interface TipOccurrence {
  occurrenceId: string;
  vars?: Record<string, string>;
  /** Set when this evaluation starts a NEW occurrence that must be stamped as lastShownAt. */
  stampAt?: number;
}

export interface TipDefinition {
  id: 'keys-exhausted' | 'update-available';
  kind: 'event';
  route: string;
  targetId: string;
  titleKey: string;
  bodyKey: string;
  actionKey: string;
  /** Lower wins when several tips apply (G: keys-exhausted before update-available). */
  priority: number;
  evaluate(data: TipEvalInput, now: number): TipOccurrence | null;
}

export interface SelectedTip extends TipOccurrence {
  tip: TipDefinition;
}

const keysExhausted: TipDefinition = {
  id: 'keys-exhausted',
  kind: 'event',
  route: '/dashboard',
  targetId: 'dash-add-key',
  titleKey: 'tip_keys_exhausted_title',
  bodyKey: 'tip_keys_exhausted_body',
  actionKey: 'tip_keys_exhausted_action',
  priority: 0,
  evaluate(data, now) {
    if (data.gatewayState !== 'running' || data.route === this.route) return null;
    const keys = data.keys;
    if (!Array.isArray(keys) || keys.length < 1) return null;
    let soonest = Infinity;
    for (const key of keys) {
      if (!key || key.status !== 'quota-exceeded') return null;
      const until = key.backoffUntil;
      if (typeof until !== 'number' || !Number.isFinite(until)) return null;
      soonest = Math.min(soonest, until);
    }
    if (soonest - now < KEYS_RETRY_MIN_MS) return null;
    const last = data.lastShownAt[this.id];
    if (typeof last === 'number' && now - last < KEYS_REARM_MS) return { occurrenceId: `${this.id}:${last}` };
    return { occurrenceId: `${this.id}:${now}`, stampAt: now };
  },
};

const updateAvailable: TipDefinition = {
  id: 'update-available',
  kind: 'event',
  route: '/settings',
  targetId: 'setting-updates',
  titleKey: 'tip_update_available_title',
  bodyKey: 'tip_update_available_body',
  actionKey: 'tip_update_available_action',
  priority: 1,
  evaluate(data) {
    if (data.route === this.route) return null;
    const update = data.update;
    if (!update || update.state !== 'available') return null;
    // The body names the version, so an occurrence exists only per real version.
    if (typeof update.version !== 'string' || update.version.trim() === '') return null;
    return { occurrenceId: `${this.id}:${update.version}`, vars: { v: update.version } };
  },
};

export const TIP_REGISTRY: readonly TipDefinition[] = [keysExhausted, updateAvailable].sort((a, b) => a.priority - b.priority);

/** The single tip to show now, or null. Exactly one at a time, highest priority first. */
export function selectTip(data: TipData, state: TipsState, now: number): SelectedTip | null {
  if (!state.enabled) return null;
  const input: TipEvalInput = { ...data, lastShownAt: state.lastShownAt };
  for (const tip of TIP_REGISTRY) {
    const occurrence = tip.evaluate(input, now);
    if (occurrence && !state.dismissed.includes(occurrence.occurrenceId)) return { ...occurrence, tip };
  }
  return null;
}

// ── random tips (spec 2026-10-26 §4.2-4.3) ──────────────────────────────

/** First random tip: no earlier than this much ALIVE time after app start. */
export const RANDOM_TIP_FIRST_MS = 90_000;
/** Later random tips: uniform in [MIN, MAX] ms of ALIVE time after the last tip closed. */
export const RANDOM_TIP_MIN_MS = 240_000;
export const RANDOM_TIP_MAX_MS = 360_000;
/** Quiet rule: no random tip within this long of the last pointerdown/keydown/wheel. */
export const TIP_QUIET_AFTER_INPUT_MS = 20_000;
/** A due tip blocked by recent input is re-checked at most this often. */
export const TIP_QUIET_RECHECK_MS = 5_000;
/** Random tips per session (event tips are not counted). */
export const RANDOM_TIPS_PER_SESSION = 8;
/** Chance of picking a recommendation when both kinds have an eligible tip (~2:1). */
export const RECOMMENDATION_SHARE = 2 / 3;
/** R11 feedback: needs this much ALIVE time this session ... */
export const FEEDBACK_MIN_ALIVE_MS = 30 * 60_000;
/** ... and is shown at most once per this window. */
export const FEEDBACK_REARM_MS = 7 * 24 * 60 * 60_000;
/** S07 tips-switch: only after this many random tips this session. */
export const TIPS_SWITCH_AFTER_SHOWN = 3;

/**
 * The facts the random-tip conditions read. `null` means "not loaded yet";
 * a condition that needs a fact is false while it is null. Part E fills this
 * on each random-tip check, only while ALIVE, via queryClient.fetchQuery
 * (staleTime 60_000, spec §4.2) and the widget's own session counters.
 */
export interface RandomTipContext {
  /** Current route: `useLocation().pathname`. A tip never shows on its own target route. */
  route: string;
  /** Gateway state ('running', ...): `queryKeys.runtime` → `runtime.status.state` (same value the event tips read). */
  gatewayState: string | null;
  /** Number of enabled models: `queryKeys.models` / `api.models`, count of enabled entries. null = not loaded. */
  enabledModelCount: number | null;
  /** Number of NVIDIA keys: `queryKeys.keys` / `api.keys` → `keys.length`. */
  keyCount: number | null;
  /** Any key record with `legacyDisabled === true` (`queryKeys.keys`). */
  anyLegacyDisabled: boolean | null;
  /** `runtime.autoLaunch` (`queryKeys.runtime`, RuntimeState in global.d.ts). */
  autoLaunch: boolean | null;
  /** `runtime.performanceMode`. */
  performanceMode: 'day' | 'night' | 'auto' | null;
  /** `runtime.requestDeadlineSource`. */
  requestDeadlineSource: 'env' | 'config' | 'default' | null;
  /** `runtime.requestDeadlineMs` (fills `{{s}}` in S03). */
  requestDeadlineMs: number | null;
  /** `runtime.llmStatsEnabled`; only `=== true` passes: null (not loaded yet) must not let R08/S04 claim the ranking is on. */
  llmStatsEnabled: boolean | null;
  /** `queryKeys.updates` → `update.state` ('none', 'available', ...). */
  updateState: string | null;
  /** ALIVE time accumulated this session (widget counter). */
  aliveMsThisSession: number;
  /** Random tips shown this session (widget counter; X/close counts as shown). */
  randomShownThisSession: number;
  /** Id of the last random tip shown this session, or null. */
  lastRandomTipId: string | null;
}

export type RandomTipKind = 'recommendation' | 'setting';

export interface RandomTipDefinition {
  id: string;
  /** Spec code (r01..r11, s01..s07); i18n keys are `tip_<code>_title|body|action`. */
  code: string;
  kind: RandomTipKind;
  /** Target route, or null for R11 (opens Feedback, no navigation). */
  route: string | null;
  /** Element id to focus after navigating, or null = the page heading keeps focus. */
  targetId: string | null;
  action: 'navigate' | 'feedback';
  titleKey: string;
  bodyKey: string;
  actionKey: string;
  /** Weight inside its kind (default 1). */
  weight: number;
  condition(ctx: RandomTipContext, lastShownAt: Record<string, number>, now: number): boolean;
  /** Interpolation vars for the body, if any. */
  vars?(ctx: RandomTipContext): Record<string, string>;
}

export interface SelectedRandomTip {
  tip: RandomTipDefinition;
  vars?: Record<string, string>;
}

const running = (ctx: RandomTipContext) => ctx.gatewayState === 'running';
const modelsLoaded = (ctx: RandomTipContext) => typeof ctx.enabledModelCount === 'number';
const hasEnabledModel = (ctx: RandomTipContext) => (ctx.enabledModelCount ?? 0) >= 1;

function randomTip(
  code: string,
  id: string,
  kind: RandomTipKind,
  route: string | null,
  targetId: string | null,
  condition: RandomTipDefinition['condition'],
  extra: Partial<Pick<RandomTipDefinition, 'weight' | 'action' | 'vars'>> = {},
): RandomTipDefinition {
  return {
    id,
    code,
    kind,
    route,
    targetId,
    action: extra.action ?? 'navigate',
    titleKey: `tip_${code}_title`,
    bodyKey: `tip_${code}_body`,
    actionKey: `tip_${code}_action`,
    weight: extra.weight ?? 1,
    condition,
    ...(extra.vars ? { vars: extra.vars } : {}),
  };
}

/** Spec §4.3: 11 recommendations + 7 settings. */
export const RANDOM_TIP_REGISTRY: readonly RandomTipDefinition[] = [
  randomTip('r01', 'endpoint-config', 'recommendation', '/endpoint', 'endpoint-model-id', (c) => running(c) && hasEnabledModel(c)),
  randomTip('r02', 'gateway-token', 'recommendation', '/endpoint', 'endpoint-gateway-token', running),
  randomTip('r03', 'anthropic-url', 'recommendation', '/endpoint', 'endpoint-url-anthropic', running),
  randomTip('r04', 'second-key', 'recommendation', '/dashboard', 'dash-add-key', (c) => c.keyCount === 1),
  randomTip('r05', 'legacy-disabled', 'recommendation', '/dashboard', null, (c) => c.anyLegacyDisabled === true),
  randomTip('r06', 'no-models', 'recommendation', '/models', null, (c) => c.enabledModelCount === 0, { weight: 3 }),
  randomTip('r07', 'free-filter', 'recommendation', '/models', 'models-filter-free', modelsLoaded),
  randomTip('r08', 'top-sort', 'recommendation', '/models', 'models-sort', (c) => c.llmStatsEnabled === true),
  randomTip('r09', 'copy-curl', 'recommendation', '/models', null, (c) => running(c) && hasEnabledModel(c)),
  randomTip('r10', 'logs-pause', 'recommendation', '/logs', 'logs-pause', running),
  randomTip('r11', 'feedback', 'recommendation', null, null, (c, last, now) => {
    if (c.aliveMsThisSession < FEEDBACK_MIN_ALIVE_MS) return false;
    const at = last['feedback'];
    return typeof at !== 'number' || now - at >= FEEDBACK_REARM_MS;
  }, { action: 'feedback' }),
  randomTip('s01', 'auto-launch', 'setting', '/settings', 'setting-auto-launch', (c) => c.autoLaunch === false),
  randomTip('s02', 'performance-auto', 'setting', '/settings', 'setting-performance-mode',
    (c) => c.performanceMode !== null && c.performanceMode !== 'auto'),
  randomTip('s03', 'deadline', 'setting', '/settings', 'request-deadline',
    (c) => c.requestDeadlineSource !== null && c.requestDeadlineSource !== 'env'
      && typeof c.requestDeadlineMs === 'number' && Number.isFinite(c.requestDeadlineMs),
    { vars: (c) => ({ s: String(Math.round((c.requestDeadlineMs ?? 0) / 1000)) }) }),
  randomTip('s04', 'llm-stats', 'setting', '/settings', 'setting-llm-stats', (c) => c.llmStatsEnabled === true),
  randomTip('s05', 'check-updates', 'setting', '/settings', 'setting-updates', (c) => c.updateState === 'none'),
  randomTip('s06', 'language', 'setting', '/settings', 'setting-language', (_c, last) => typeof last['language'] !== 'number'),
  randomTip('s07', 'tips-switch', 'setting', '/settings', 'setting-tips', (c) => c.randomShownThisSession >= TIPS_SWITCH_AFTER_SHOWN),
];

/** True if the tip may be offered now (condition + every §4.2 exclusion). */
function isRandomTipEligible(tip: RandomTipDefinition, ctx: RandomTipContext, state: TipsState, now: number): boolean {
  if (state.never.includes(tip.id)) return false;
  if (tip.id === ctx.lastRandomTipId) return false;
  if (tip.route !== null && ctx.route === tip.route) return false;
  const last = state.lastShownAt[tip.id];
  if (typeof last === 'number' && now - last < KEYS_REARM_MS) return false;
  return tip.condition(ctx, state.lastShownAt, now);
}

function pickWeighted(tips: readonly RandomTipDefinition[], random: () => number): RandomTipDefinition {
  const total = tips.reduce((sum, tip) => sum + tip.weight, 0);
  let r = random() * total;
  for (const tip of tips) {
    r -= tip.weight;
    if (r < 0) return tip;
  }
  return tips[tips.length - 1];
}

/**
 * Spec §4.2: the random tip for this round, or null (tips off, session cap
 * reached, or nothing eligible). `random` returns [0, 1) like Math.random.
 */
export function selectRandomTip(ctx: RandomTipContext, state: TipsState, now: number, random: () => number = Math.random): SelectedRandomTip | null {
  if (!state.enabled) return null;
  if (ctx.randomShownThisSession >= RANDOM_TIPS_PER_SESSION) return null;
  const eligible = RANDOM_TIP_REGISTRY.filter((tip) => isRandomTipEligible(tip, ctx, state, now));
  const recs = eligible.filter((tip) => tip.kind === 'recommendation');
  const settings = eligible.filter((tip) => tip.kind === 'setting');
  let pool: readonly RandomTipDefinition[];
  if (recs.length > 0 && settings.length > 0) pool = random() < RECOMMENDATION_SHARE ? recs : settings;
  else if (recs.length > 0) pool = recs;
  else if (settings.length > 0) pool = settings;
  else return null;
  const tip = pickWeighted(pool, random);
  return tip.vars ? { tip, vars: tip.vars(ctx) } : { tip };
}

/**
 * Re-offer round for a tip cleared by a hide before it was read (spec §4.6
 * "the card shows on return"). Re-checked on FRESH facts: the pending tip is
 * preferred only while it still qualifies (condition, never, 24 h stamp, route,
 * cap, switch) and gets fresh vars; otherwise a normal fresh selection, or null.
 */
export function selectReofferTip(
  pendingId: string | null,
  ctx: RandomTipContext,
  state: TipsState,
  now: number,
  random: () => number = Math.random,
): SelectedRandomTip | null {
  if (!state.enabled) return null;
  if (ctx.randomShownThisSession >= RANDOM_TIPS_PER_SESSION) return null;
  const pending = pendingId === null ? undefined : RANDOM_TIP_REGISTRY.find((tip) => tip.id === pendingId);
  if (pending && isRandomTipEligible(pending, ctx, state, now)) {
    return pending.vars ? { tip: pending, vars: pending.vars(ctx) } : { tip: pending };
  }
  return selectRandomTip(ctx, state, now, random);
}

// ── random-tip scheduler (pure; part E owns the timers and ALIVE clock) ──

/** ALIVE-time delay until the next random tip: uniform in [240_000, 360_000] ms. */
export function nextRandomTipDelayMs(random: () => number = Math.random): number {
  const span = RANDOM_TIP_MAX_MS - RANDOM_TIP_MIN_MS;
  const r = random();
  const unit = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0;
  return RANDOM_TIP_MIN_MS + Math.round(unit * span);
}

/** The earliest time a tip due at `dueAt` may show, given the last user input. */
export function quietAdjustedTime(dueAt: number, lastInputAt: number | null): number {
  if (typeof lastInputAt !== 'number' || !Number.isFinite(lastInputAt)) return dueAt;
  return Math.max(dueAt, lastInputAt + TIP_QUIET_AFTER_INPUT_MS);
}

export interface RandomTipGateInput {
  now: number;
  /** When the cadence says the next tip is due (same clock as `now`). */
  dueAt: number;
  lastInputAt: number | null;
  shownThisSession: number;
  /** TipsState.enabled (the Settings `#setting-tips` switch). */
  enabled: boolean;
}

export type RandomTipGate =
  | { status: 'off' }
  | { status: 'ready' }
  | { status: 'wait'; at: number };

/**
 * Whether a random tip may be tried now. 'off' = tips disabled or the session
 * cap is reached (stop scheduling). 'wait' = check again at `at` (not due yet,
 * or within the quiet window; quiet re-checks are at least 5 s apart).
 * Event tips do not go through this gate and are never capped.
 */
export function randomTipGate(input: RandomTipGateInput): RandomTipGate {
  if (!input.enabled || input.shownThisSession >= RANDOM_TIPS_PER_SESSION) return { status: 'off' };
  if (input.now < input.dueAt) return { status: 'wait', at: input.dueAt };
  const quietUntil = quietAdjustedTime(input.dueAt, input.lastInputAt);
  if (input.now < quietUntil) return { status: 'wait', at: Math.max(quietUntil, input.now + TIP_QUIET_RECHECK_MS) };
  return { status: 'ready' };
}

// ── persistence ──────────────────────────────────────────────────────────

const MAX_DISMISSED = 50;
const listeners = new Set<() => void>();

export function parseTipsState(raw: string | null): TipsState {
  const state: TipsState = { enabled: true, dismissed: [], lastShownAt: {}, never: [] };
  if (typeof raw !== 'string') return state;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return state;
  }
  if (!parsed || typeof parsed !== 'object') return state;
  const value = parsed as { enabled?: unknown; dismissed?: unknown; lastShownAt?: unknown; never?: unknown };
  state.enabled = value.enabled !== false;
  if (Array.isArray(value.dismissed)) state.dismissed = value.dismissed.filter((id): id is string => typeof id === 'string');
  if (Array.isArray(value.never)) state.never = value.never.filter((id): id is string => typeof id === 'string');
  if (value.lastShownAt && typeof value.lastShownAt === 'object') {
    for (const [id, at] of Object.entries(value.lastShownAt as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) state.lastShownAt[id] = at;
    }
  }
  return state;
}

export function subscribeTips(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTipsSnapshot(): string | null {
  try {
    return window.localStorage.getItem(TIPS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function writeTipsState(next: TipsState): void {
  const raw = JSON.stringify({ ...next, dismissed: next.dismissed.slice(-MAX_DISMISSED) });
  try {
    if (window.localStorage.getItem(TIPS_STORAGE_KEY) === raw) return;
    window.localStorage.setItem(TIPS_STORAGE_KEY, raw);
  } catch {
    return; // storage unavailable: nothing changed, so nothing to announce
  }
  notify();
}

function updateTipsState(change: (state: TipsState) => TipsState): void {
  writeTipsState(change(parseTipsState(getTipsSnapshot())));
}

export function setTipsEnabled(enabled: boolean): void {
  updateTipsState((state) => ({ ...state, enabled }));
}

export function dismissTipOccurrence(occurrenceId: string): void {
  updateTipsState((state) => (state.dismissed.includes(occurrenceId) ? state : { ...state, dismissed: [...state.dismissed, occurrenceId] }));
}

/** Spec 4.4 "Don't show this again": the random tip id never returns (survives restarts). */
export function neverShowTip(tipId: string): void {
  updateTipsState((state) => (state.never.includes(tipId) ? state : { ...state, never: [...state.never, tipId] }));
}

export function markTipShown(tipId: string, at: number): void {
  updateTipsState((state) => ({ ...state, lastShownAt: { ...state.lastShownAt, [tipId]: at } }));
}

/** Owner item N: the Settings reset/rerun forgets the tips state too. */
export function clearTipsState(): void {
  try {
    window.localStorage.removeItem(TIPS_STORAGE_KEY);
  } catch {
    return;
  }
  notify();
}

export function usePetTips(): TipsState {
  const raw = useSyncExternalStore(subscribeTips, getTipsSnapshot);
  return useMemo(() => parseTipsState(raw), [raw]);
}

// ── target-page focus ────────────────────────────────────────────────────

/**
 * The card can unmount/remount by itself (keys recover, the update installs,
 * the occurrence changes). If keyboard focus was inside it and has now fallen
 * to body, return it to the pet button. Called from a passive effect, i.e.
 * after the commit, when the lost focus is observable. Focus that already
 * moved elsewhere (a target page's <h2>, the Settings tips switch) is kept.
 */
export function restoreCardFocus(
  wasInCard: boolean,
  doc: { activeElement: unknown; body: unknown },
  petButton: { focus(): void } | null,
): boolean {
  if (!wasInCard || !petButton) return false;
  if (doc.activeElement !== null && doc.activeElement !== doc.body) return false;
  petButton.focus();
  return true;
}

/** The `focusSetting` id carried in router state by a tip action, or null. */
export function focusSettingFrom(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const id = (state as { focusSetting?: unknown }).focusSetting;
  return typeof id === 'string' && id !== '' ? id : null;
}

interface FocusTarget {
  disabled?: boolean;
  focus(options?: { preventScroll?: boolean }): void;
  scrollIntoView(options?: { block?: 'nearest' }): void;
}

/**
 * Focus the pending target once, if it exists and is enabled; otherwise leave
 * focus where it is (the page <h2>). Returns which one ends up focused.
 */
export function focusPendingSetting(
  id: unknown,
  lookup: (id: string) => FocusTarget | null = (target) => document.getElementById(target) as FocusTarget | null,
): 'target' | 'heading' {
  if (typeof id !== 'string') return 'heading';
  const el = lookup(id);
  if (!el || el.disabled === true) return 'heading';
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest' });
  return 'target';
}
