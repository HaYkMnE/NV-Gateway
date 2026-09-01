import crypto from "node:crypto";
import { info, warn } from "./logger.mjs";
import {
  closeAffinityPersistence,
  countEligibleKeys,
  flushAffinity,
  getModelCooldownRemainingSeconds,
  markRateLimited,
  pruneExpired,
  recordAssignment,
  schedulePersistAffinity,
  selectKeyForModel
} from "./model-key-affinity.mjs";

export const MAX_KEY_LENGTH = 8192;
export const MAX_KEYS = 1000;
export const MAX_BACKOFF_MS = 300 * 1000;
// Cooldown placed on a key that received a 429 WITHOUT a Retry-After header.
// Kept small (<=20s): a no-Retry-After rate limit must NOT knock a key out for
// a full minute. getNextKey already SKIPS cooldown keys (it never blocks; it
// only forcibly resets the soonest-backoff key when none are available), so
// this value governs how soon the key is reusable for other loops/requests,
// never a per-switch blocking wait. Exceeding ~20s here would needlessly stall
// a key during a rate-limit storm — keeping it at 20s aligns with the "max ~20s
// between key switches" contract.
export const MAX_KEY_COOLDOWN_429_MS = 20_000;

// RETRY SCHEDULE for a key parked as quota-exceeded.
//
// Original intent of the code this replaces: "credits are gone, stop wasting
// requests on this key, and only as a LAST RESORT (activeCount === 0) try it
// again after an hour". Two things made that starve the pool:
//   1. the last-resort gate meant ONE surviving active key kept every other key
//      parked forever, collapsing a pool of N keys to 1 (≈40 RPM baseline);
//   2. the hour was measured from usage.lastUsed, which handleKeyError bumps on
//      FAILURE — so a retry that 429'd restarted the whole hour, and a fully
//      quota-exceeded pool retried one key per hour.
//
// Replacement: each parked key carries its OWN due time in `backoffUntil` (an
// already-persisted field), so recovery is independent of how many other keys
// are active, and a failed retry escalates on a bounded ladder instead of
// resetting a clock that a failure write keeps pushing forward.
//
// 5 min base: short enough that a transient model-wide 429 wave (which is
// mis-parked as quota by any body-text classifier) heals within one user
// retry, long enough that a genuinely dead key costs ~12 probe requests/hour.
export const QUOTA_RETRY_BASE_MS = 5 * 60_000;
// Ceiling: the same 1 h the original code used. The ladder doubles up to this
// value and stops, so a failed retry is NEVER scheduled further out than the
// original single fixed hour — the schedule can only improve on it.
export const QUOTA_RETRY_MAX_MS = 3_600_000;

/**
 * Consecutive failed quota retries per key id, in memory only.
 *
 * Deliberately NOT persisted: the state projection the main process validates
 * (state-ownership.ts isChildKeyProjection) is a fixed 5/6-field contract, and
 * widening it from here would be a cross-boundary change. Losing the ladder on
 * restart is safe in one direction only — it restarts at the 5 min base, never
 * at 0 — so a restart loop can cost at most a probe every 5 min, not a hammer.
 * @type {Map<string, number>}
 */
const quotaRetries = new Map();

/** The retry window for the Nth consecutive failure (0-based): 5,10,20,40,60,60… min. */
function quotaRetryWindowMs(failures) {
  const scaled = QUOTA_RETRY_BASE_MS * Math.pow(2, Math.max(0, failures));
  return Math.min(QUOTA_RETRY_MAX_MS, scaled);
}

/**
 * Park a key as quota-exceeded and schedule its next retry.
 * Escalates the ladder on each consecutive failure; a success clears it
 * (see markKeyUsedAndDebounceSave).
 */
function parkQuotaExceeded(key) {
  const failures = quotaRetries.get(key.id) ?? 0;
  const windowMs = quotaRetryWindowMs(failures);
  quotaRetries.set(key.id, failures + 1);
  key.status = "quota-exceeded";
  key.backoffUntil = Date.now() + windowMs;
  warn("Key parked as quota-exceeded", { id: key.id, retryInMs: windowMs, attempt: failures + 1 });
}

// A 429 body that is a RATE LIMIT, not exhausted credits. Checked FIRST: NVIDIA
// words a per-model rate limit as "exceeded your quota of 40 requests per
// minute", so a bare substring test for "quota" misreads it as dead credits and
// kills a healthy key pool-wide — bypassing the per-(model,key) cooldown design.
const RATE_LIMIT_SIGNAL = /rate[\s_-]?limit|requests?\s+per\s+(minute|second|hour|day)|\brpm\b|\btpm\b|too\s+many\s+requests|slow\s+down/;
// Exhausted credits / account-level quota. 429 everywhere, so it IS global.
// Matches the wordings that carry no "quota" token at all ("credit balance",
// "free credits used", "insufficient credits"), which the substring test read
// as a 20 s cooldown and therefore hammered forever.
const CREDIT_EXHAUSTED_SIGNAL = /insufficient[_\s-]?quota|quota\s+(exceeded|exhausted|reached|limit)|exceeded\s+your\s+quota|out\s+of\s+credits?|no\s+credits?\s+(left|remaining)|credits?\s+(exhausted|depleted|used|remaining)|insufficient\s+(credit|balance|funds)|credit\s+(balance|limit)|free\s+credits?|billing|payment\s+required/;

/**
 * Is this 429 body a GLOBAL credit/quota exhaustion verdict?
 *
 * Order is the whole point: a rate-limit wording wins even when it also
 * contains the word "quota", so a model-scoped 429 is never misclassified as a
 * dead key. A body that matches neither is NOT treated as exhaustion — it falls
 * through to the model-scoped/global cooldown branches, which is the safe
 * direction for an unknown wording.
 *
 * @param {unknown} responseBody
 * @returns {boolean}
 */
export function isQuotaExhaustedBody(responseBody) {
  if (typeof responseBody !== "string" || responseBody.length === 0) return false;
  const body = responseBody.toLowerCase();
  if (RATE_LIMIT_SIGNAL.test(body)) return false;
  return CREDIT_EXHAUSTED_SIGNAL.test(body);
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUSES = new Set(["active", "disabled", "quota-exceeded"]);
let keys = [];
let saveTimer = null;
let persistAdapter = (state) => {
  if (typeof process.send !== "function") throw new Error("Private persistence channel is unavailable.");
  // The parent may already be gone: a deliberate disconnect on a graceful stop,
  // or a parent crash. `process.send` stays a function after the channel closes,
  // so writing anyway emits an unhandled 'error' (EPIPE) ON THE PROCESS and
  // kills the child mid-shutdown — costing it the remaining flushes. With no
  // channel there is no way to persist the projection, so skipping is the only
  // honest option; the file-based affinity cache still flushes independently.
  if (process.connected !== true) return;
  // The CALLBACK is load-bearing, not decoration: process.send is ASYNCHRONOUS,
  // so a failed write (EPIPE, when the parent disconnects a tick later) is NOT
  // thrown — with no callback Node emits it as an 'error' event ON THE PROCESS,
  // which is unhandled and kills the child mid-shutdown, costing the remaining
  // flushes. Supplying a callback routes that error here instead. try/catch is
  // kept for the synchronous failure modes only.
  try { process.send({ type: "state:persist", state }, () => { /* delivery failure is terminal-only */ }); } catch { /* channel closed mid-write */ }
};

function normalize(state) {
  if (!state || !Array.isArray(state.keys)) return [];
  let invalidCount = 0;
  const result = state.keys.slice(0, MAX_KEYS).flatMap((record) => {
    const value = typeof record?.key === "string" ? record.key : record?.apiKey;
    const key = typeof value === "string" ? value.trim() : "";
    if (!key || key.length > MAX_KEY_LENGTH) { invalidCount++; return []; }
    const usage = record?.usage && typeof record.usage === "object" ? record.usage : {};
    const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    return [{
        id: typeof record?.id === "string" && UUID_V4.test(record.id) ? record.id : crypto.randomUUID(),
        key,
        status: STATUSES.has(record?.status) ? record.status : "active",
        backoffUntil: count(record?.backoffUntil),
        usage: { success: count(usage.success), fail: count(usage.fail), tokens: count(usage.tokens), lastUsed: count(usage.lastUsed) },
        accessibleModels: Array.isArray(record?.accessibleModels) ? record.accessibleModels.filter((id) => typeof id === "string") : []
    }];
  });
  if (invalidCount) warn("Skipped invalid key records", { count: invalidCount });
  return result;
}

export function initializeState(state) {
  keys = normalize(state);
  // Drop routing memory that decayed while the gateway child was down, so a
  // restart never starts out reserving keys for models nobody is using.
  pruneModelAffinity();
  info("State initialized", { count: keys.length });
}
export function setPersistenceAdapter(adapter) { persistAdapter = adapter; }
export function saveState() {
  // Project the per-key contract the main process validates (state-ownership.ts
  // isChildKeyProjection). Phase 2 widened the contract to accept the optional
  // 6th field accessibleModels: string[] (durable across gateway-child restart);
  // 5-field legacy projections are still accepted. accessibleModels is carried
  // here so a restart restores each key's upstream-accessible catalog (the
  // Models panel is no longer blank after restart) — see normalize() below,
  // which seeds accessibleModels from the persisted record (default []).
  const projection = keys.map((k) => ({
    id: k.id,
    key: k.key,
    status: k.status,
    backoffUntil: k.backoffUntil,
    usage: k.usage,
    accessibleModels: Array.isArray(k.accessibleModels) ? k.accessibleModels.filter((id) => typeof id === "string") : []
  }));
  persistAdapter({ keys: projection });
}
// Shutdown counterparts. Each also settles the DEBOUNCED affinity-cache write
// (schedulePersistAffinity), so both persistence paths are handled at the same
// call sites and neither leaves a timer holding the process alive:
//   flushState        -> land queued affinity changes on disk (durability)
//   closeStateWatcher -> only stop holding a timer, matching its saveTimer role
// flushAffinity() sits in a `finally`: the two persistence paths are
// INDEPENDENT (ipc projection vs local JSON cache), so a failing projection
// must not cost the affinity flush. The throw still propagates unchanged.
export function flushState() { if (saveTimer) clearTimeout(saveTimer); saveTimer = null; try { saveState(); } finally { flushAffinity(); } }
export function closeStateWatcher() { if (saveTimer) clearTimeout(saveTimer); saveTimer = null; closeAffinityPersistence(); }
export function getKeys() { return keys; }

export function getSoonestActiveCooldownRemainingSeconds() {
  const now = Date.now();
  const activeKeys = keys.filter(k => k.status === 'active');
  if (activeKeys.length === 0) return 20;
  const inBackoff = activeKeys.filter(k => k.backoffUntil > now);
  if (inBackoff.length === 0) return 1;
  const minBackoff = Math.min(...inBackoff.map(k => k.backoffUntil));
  return Math.max(1, Math.min(20, Math.ceil((minBackoff - now) / 1000)));
}

/**
 * Return every quota-exceeded key whose retry window has elapsed to `active`.
 *
 * Run as a SWEEP at the top of getNextKey, not as a last-resort branch: the
 * previous code only looked at quota keys when `activeCount === 0`, so a single
 * surviving active key kept the whole pool parked and the user was pinned at one
 * key's ~40 RPM. Reclaiming is a state transition driven ONLY by the key's own
 * due time, so it is independent of how many other keys are active; the normal
 * LRU below then decides who serves this request.
 *
 * `usage.lastUsed` is deliberately left alone — it is the LRU ordering, and a
 * key that has been parked for a while SHOULD sort to the front.
 *
 * No save here: this is the selection hot path, and the caller's
 * markKeyUsedAndDebounceSave already debounces a write after the request.
 *
 * @param {number} now
 * @returns {void}
 */
function reclaimDueQuotaKeys(now) {
  for (const key of keys) {
    if (key.status !== "quota-exceeded") continue;
    if ((key.backoffUntil || 0) > now) continue;
    key.status = "active";
    key.backoffUntil = 0;
    info("Quota-exceeded key returned for a bounded retry", { id: key.id, attempt: (quotaRetries.get(key.id) ?? 0) + 1 });
  }
}

let locked = false;
/**
 * Select the key that should serve this request.
 *
 * With a `modelId` the choice is PER-MODEL (see model-key-affinity.mjs): the
 * model reuses its own sticky key, avoids keys cooling down for it specifically,
 * and prefers a key no other active model holds. Without a `modelId` — the
 * /v1/models path, admin flows and every existing caller — the behaviour is the
 * unchanged pool-wide LRU, so the model-less contract is preserved exactly.
 *
 * When no key is eligible for the model, selection falls through to the
 * pool-wide algorithm rather than reporting an empty pool: a model-scoped
 * cooldown must never turn into a 503 when the pool itself is healthy. The
 * failover loop's uniform-429 early stop is what ends a genuine model-wide wave.
 *
 * @param {string} [modelId] Requested model id, when the caller knows it.
 * @returns {object | null}
 */
export function getNextKey(modelId) {
  if (locked) return null; locked = true;
  try {
    const now = Date.now();
    reclaimDueQuotaKeys(now);
    if (typeof modelId === "string" && modelId.length > 0) {
      const affine = selectKeyForModel(modelId, keys, { now });
      if (affine) {
        affine.usage.lastUsed = now;
        recordAssignment(modelId, affine.id, { now });
        return affine;
      }
    }
    const available = keys.filter((key) => key.status === "active" && key.backoffUntil <= now).sort((a, b) => a.usage.lastUsed - b.usage.lastUsed);
    if (available.length > 0) {
      available[0].usage.lastUsed = now;
      return available[0];
    }
    const activeInBackoff = keys.filter((key) => key.status === "active" && key.backoffUntil > now).sort((a, b) => {
      if (a.backoffUntil !== b.backoffUntil) return a.backoffUntil - b.backoffUntil;
      return a.usage.lastUsed - b.usage.lastUsed;
    });
    if (activeInBackoff.length > 0) {
      const candidate = activeInBackoff[0];
      candidate.backoffUntil = 0;
      candidate.usage.lastUsed = now;
      return candidate;
    }
    // No last-resort quota revival here any more: reclaimDueQuotaKeys above has
    // ALREADY returned every quota key whose retry window elapsed, on its own
    // schedule and regardless of how many keys are active. Anything still parked
    // at this point is inside its window, and handing it out would be exactly
    // the "hammer a dead key" failure the schedule exists to prevent.
    return null;
  } finally { locked = false; }
}

export function markKeyUsedAndDebounceSave(id, { success, tokens = 0 }) {
  const key = keys.find((item) => item.id === id); if (!key) return;
  key.usage.lastUsed = Date.now(); key.usage[success ? "success" : "fail"] += 1; if (success) key.usage.tokens += tokens;
  // A served request proves the key works again (credits topped up, or the wave
  // passed), so the escalation ladder must not keep punishing it.
  if (success) quotaRetries.delete(id);
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; saveState(); }, 5000);
}

/**
 * Record an upstream failure against a key.
 *
 * Scope of each verdict — this split is the point of the per-model routing:
 *
 *  - 401/403          GLOBAL. A credential verdict: the key is disabled for
 *                     every model.
 *  - 429 with "quota" GLOBAL. Exhausted credits answer 429 everywhere, so the
 *                     key becomes quota-exceeded pool-wide.
 *  - 429 rate limit   PER (model, key) when `modelId` is known. NVIDIA scopes a
 *                     rate limit to the model, so parking the key globally would
 *                     evict a key that is healthy for every other model — the
 *                     defect this replaces. Without a `modelId` the historical
 *                     global cooldown is kept, preserving the old contract.
 *  - 5xx              GLOBAL. An upstream fault is not model-specific; keeps the
 *                     existing short global backoff unchanged.
 *
 * @param {string} id Key id.
 * @param {number} statusCode Upstream HTTP status.
 * @param {string} responseBody Upstream body (quota detection only).
 * @param {number | null} retryAfterSeconds Parsed Retry-After, when present.
 * @param {string} [modelId] Requested model id, when the caller knows it.
 * @returns {void}
 */
export function handleKeyError(id, statusCode, responseBody, retryAfterSeconds, modelId) {
  const key = keys.find((item) => item.id === id); if (!key) return;
  const hasModel = typeof modelId === "string" && modelId.length > 0;
  let backoffMs = retryAfterSeconds ? retryAfterSeconds * 1000 : 0;
  if (statusCode === 401 || statusCode === 403) { key.status = "disabled"; warn("Key disabled due to auth error", { id, statusCode }); }
  // GLOBAL exhaustion is decided by isQuotaExhaustedBody, which resolves the
  // precedence INTERNALLY: a rate-limit wording wins even when it also contains
  // the word "quota" ("exceeded your quota of 40 requests per minute"), so this
  // branch can stay ahead of the model-scoped one without stealing model-scoped
  // 429s from it. The old `includes("quota")` failed both ways: it parked healthy
  // keys pool-wide, and it let real exhaustion ("credit balance", "free credits
  // used") through as a 20 s cooldown that hammered a dead key forever.
  else if (statusCode === 429 && isQuotaExhaustedBody(responseBody)) { parkQuotaExceeded(key); }
  else if (statusCode === 429 && hasModel) {
    // MODEL-SCOPED: this key stays immediately usable by every other model.
    backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(0, backoffMs || MAX_KEY_COOLDOWN_429_MS));
    markRateLimited(modelId, id, { cooldownMs: backoffMs });
    // DEBOUNCED, never a synchronous write here: this is the failure hot path,
    // and a 429 wave (many models × many keys) would otherwise issue a burst of
    // writeFileSync calls exactly while the gateway is already degrading.
    // flushAffinity() on shutdown is what makes the deferred write durable.
    schedulePersistAffinity();
  }
  else if (statusCode === 429 || statusCode >= 500) {
    backoffMs ||= statusCode === 429 ? MAX_KEY_COOLDOWN_429_MS : 10000;
    backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(0, backoffMs));
    key.backoffUntil = Date.now() + backoffMs;
  }
  markKeyUsedAndDebounceSave(id, { success: false });
  if (statusCode >= 500) warn("Upstream error, backing off", { id, statusCode, backoffMs });
}

/**
 * Keys currently allowed to serve this model (globally available and not
 * cooling down for it). The failover loop bounds its uniform-429 confirming
 * attempts by this count, so the early stop never fires before the keys this
 * model may actually use have been tried.
 *
 * @param {string} [modelId]
 * @returns {number | undefined} undefined when there is no model to scope by.
 */
export function getModelEligibleKeyCount(modelId) {
  if (typeof modelId !== "string" || modelId.length === 0) return undefined;
  return countEligibleKeys(modelId, keys);
}

/**
 * Honest Retry-After for a model-scoped rate limit: the soonest moment THIS
 * model may retry. Falls back to the pool-wide cooldown view when the model has
 * no live model-scoped cooldown.
 *
 * @param {string} [modelId]
 * @returns {number} Seconds, 1..20.
 */
export function getRetryAfterSecondsForModel(modelId) {
  if (typeof modelId === "string" && modelId.length > 0) {
    const remaining = getModelCooldownRemainingSeconds(modelId, keys);
    if (remaining !== null) return Math.max(1, Math.min(20, remaining));
  }
  return getSoonestActiveCooldownRemainingSeconds();
}

/** Drop decayed per-model routing memory. Called on state init. */
export function pruneModelAffinity() { return pruneExpired(); }

export function addKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key || key.length > MAX_KEY_LENGTH || keys.length >= MAX_KEYS || keys.some((item) => item.key === key)) return null;
  const result = { id: crypto.randomUUID(), key, status: "active", backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] };
  keys.push(result); saveState(); info("Key added", { id: result.id, keyCount: keys.length }); return result;
}
export function removeKey(id) { const before = keys.length; keys = keys.filter((item) => item.id !== id); if (keys.length === before) return false; saveState(); return true; }
/**
 * Admin status transition. VALIDATED against STATUSES: normalize() guards this
 * on load, but the setter used to write any string through, and an out-of-set
 * value makes the key invisible to every `status === "active"` filter — a 503
 * while healthy keys exist. admin-api.mjs already rejects a bad status with 422
 * (parseStatus), so this closes the non-HTTP callers, not that path.
 *
 * @returns {boolean} false for an unknown status or an unknown id.
 */
export function setKeyStatus(id, status) {
  if (!STATUSES.has(status)) { warn("Rejected invalid key status", { id, status: typeof status === "string" ? status : typeof status }); return false; }
  const key = keys.find((item) => item.id === id); if (!key) return false;
  key.status = status;
  if (status === "active") { key.backoffUntil = 0; quotaRetries.delete(id); }
  // Parking by hand still gets a retry schedule, otherwise the reclaim sweep
  // would undo the decision on the very next request. Uses the CURRENT ladder
  // level without escalating it: an admin action is not an upstream failure.
  else if (status === "quota-exceeded") { key.backoffUntil = Date.now() + quotaRetryWindowMs(quotaRetries.get(id) ?? 0); }
  saveState(); return true;
}

// Persist the upstream-accessible model catalog onto a stored key record
// (in-memory). Populated by the admin validate-on-add and validate-update
// flows. Defensive: non-array -> []. See Module-level notes in saveState for
// why this is NOT carried in the persist projection.
export function setKeyAccessibleModels(id, accessibleModels) {
  const key = keys.find((item) => item.id === id);
  if (!key) return false;
  key.accessibleModels = Array.isArray(accessibleModels) ? accessibleModels.filter((m) => typeof m === "string") : [];
  saveState();
  return true;
}
export function reorderKeys(ids) { const order = new Map(ids.map((id, index) => [id, index])); keys.sort((a, b) => (order.get(a.id) ?? ids.length) - (order.get(b.id) ?? ids.length)); saveState(); }
