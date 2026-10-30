import crypto from "node:crypto";
import { info, warn } from "./logger.mjs";
import {
  closeAffinityPersistence,
  countEligibleKeys,
  getEligibleKeys,
  flushAffinity,
  getModelCooldownRemainingSeconds,
  markRateLimited,
  pruneExpired,
  recordAssignment,
  removeKeyReferences,
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

// AUTH FAILURE (401/403) retry schedule.
//
// Owner rule: upstream errors must never remove a key permanently. A credential
// rejection parks the key as `disabled` for a BOUNDED window — 1 h base,
// doubling per consecutive failure up to 24 h — and the reclaim sweep hands it
// back automatically once the window elapses (mirroring the quota schedule
// above). A success resets the ladder. Admin-parked keys are NOT part of this
// schedule (their backoffUntil is 0 and they carry no parkedReason marker, so
// the sweep leaves them alone) — an operator's disable still sticks.
//
// Like quotaRetries, the ladder is deliberately in-memory only: losing it to a
// restart restarts at the 1 h base, never at 0.
export const AUTH_RETRY_BASE_MS = 60 * 60_000;
export const AUTH_RETRY_MAX_MS = 24 * 60 * 60_000;

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
  delete key.disabledBy;
  delete key.legacyDisabled;
  key.backoffUntil = Date.now() + windowMs;
  warn("Key parked as quota-exceeded", { id: key.id, retryInMs: windowMs, attempt: failures + 1 });
}

/** Consecutive auth-rejections per key id, in memory only (see quotaRetries). */
const authRetries = new Map();

/** The auth-retry window for the Nth consecutive failure (0-based): 1h, 2h, 4h… ≤24h. */
function authRetryWindowMs(failures) {
  const scaled = AUTH_RETRY_BASE_MS * Math.pow(2, Math.max(0, failures));
  return Math.min(AUTH_RETRY_MAX_MS, scaled);
}

/**
 * Park a key whose credential was rejected (401/403) behind a bounded,
 * escalating window AND stamp the runtime-park provenance marker. The key is
 * excluded from selection while the window runs and auto-revives once it
 * elapses — a credential verdict stays RECOVERABLE (owner rule), never a
 * permanent delete.
 */
function parkAuthRejected(key) {
  const failures = authRetries.get(key.id) ?? 0;
  const windowMs = authRetryWindowMs(failures);
  authRetries.set(key.id, failures + 1);
  key.status = "disabled";
  key.backoffUntil = Date.now() + windowMs;
  // Provenance marker: reclaimDueParkedKeys revives a disabled key ONLY when
  // this marker is present (runtime park). Admin disables (and all legacy
  // records from before the marker existed) have no marker and stay parked.
  key.parkedReason = "auth";
  delete key.disabledBy;
  delete key.legacyDisabled;
  warn("Key parked on auth rejection with a bounded retry window", { id: key.id, retryInMs: windowMs, attempt: failures + 1 });
}

// A 429 body that is a RATE LIMIT, not exhausted credits. NVIDIA words a
// per-model rate limit as "exceeded your quota of 40 requests per minute", so a
// bare substring test for "quota" misreads it as dead credits and kills a
// healthy key pool-wide — bypassing the per-(model,key) cooldown design.
const RATE_LIMIT_SIGNAL = /rate[\s_-]?limit|requests?\s+per\s+(minute|second|hour|day)|\brpm\b|\btpm\b|too\s+many\s+requests|slow\s+down/;
// Explicit account/billing/credit evidence is stronger than a generic RFC7807
// title such as "Too Many Requests". Generic quota wording remains subordinate
// to concrete request-window wording so "quota of 40 requests per minute" is
// still a transient model limit rather than a globally parked credential.
const ACCOUNT_EXHAUSTED_SIGNAL = /out\s+of\s+credits?|no\s+credits?\s+(left|remaining)|credits?\s+(exhausted|depleted|used|remaining)|insufficient\s+(credit|balance|funds)|credit\s+(balance|limit)|free\s+credits?|billing|payment\s+required/;
const QUOTA_EXHAUSTED_SIGNAL = /insufficient[_\s-]?quota|quota\s+(exceeded|exhausted|reached|limit)|exceeded\s+your\s+quota/;

function quotaSemanticText(responseBody) {
  try {
    const parsed = JSON.parse(responseBody);
    const values = [];
    const visit = (value, key = "") => {
      if (typeof value === "string" && /^(detail|error|message)$/i.test(key)) values.push(value);
      else if (value && typeof value === "object") {
        for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
      }
    };
    visit(parsed);
    return values.join(" ").toLowerCase();
  } catch {
    return responseBody.toLowerCase();
  }
}

/**
 * Is this 429 body a GLOBAL credit/quota exhaustion verdict?
 *
 * Semantic precedence: explicit account/billing/credit evidence wins over a
 * generic rate-limit title; concrete RPM/TPM/request-window wording wins over
 * generic quota wording; an ambiguous body remains transient.
 *
 * @param {unknown} responseBody
 * @returns {boolean}
 */
export function isQuotaExhaustedBody(responseBody) {
  if (typeof responseBody !== "string" || responseBody.length === 0) return false;
  const body = quotaSemanticText(responseBody);
  if (ACCOUNT_EXHAUSTED_SIGNAL.test(body)) return true;
  if (RATE_LIMIT_SIGNAL.test(body)) return false;
  return QUOTA_EXHAUSTED_SIGNAL.test(body);
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUSES = new Set(["active", "disabled", "quota-exceeded"]);
let keys = [];
let saveTimer = null;

// ─── Durable persistence acknowledgement ────────────────────────────────────
//
// Admin add/remove/status/reorder must not report success on an in-memory
// change alone: the child mutates, asks the MAIN process to persist the exact
// resulting projection, and waits for a matching `state:persist:ack` (same
// requestId + revision). A rejection, a mismatch, a disconnect, or the bounded
// timeout all fail the mutation and restore the pre-mutation state via the
// merge rollback, so the UI never reports a change that was never persisted.

export const DURABLE_ACK_TIMEOUT_MS = 5_000;
export const KEY_PERSISTENCE_ERROR_CODE = "KEY_PERSISTENCE_FAILED";

export class KeyPersistenceError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "KeyPersistenceError";
    this.code = KEY_PERSISTENCE_ERROR_CODE;
  }
}

/**
 * Bounded waiter table for `state:persist:ack` / `state:persist:rejected`
 * messages, keyed by requestId. Exported so the matching rules (exact
 * requestId + revision, stale-ack rejection, timeout, disconnect) are
 * unit-testable without a live IPC child.
 */
export function createPersistAckRegistry(options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DURABLE_ACK_TIMEOUT_MS;
  // Production unrefs so a pending ack can never hold the child alive; tests
  // pass unref:false so a timed-out ack stays awaitable with an empty loop.
  const unrefTimer = options.unref !== false;
  const pending = new Map();
  const drop = (requestId) => {
    const waiter = pending.get(requestId);
    if (!waiter) return null;
    pending.delete(requestId);
    clearTimeout(waiter.timer);
    return waiter;
  };
  return {
    get pendingCount() { return pending.size; },
    awaitAck(requestId, revision) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Persistence acknowledgement timeout after ${timeoutMs} ms.`));
        }, timeoutMs);
        if (unrefTimer) timer.unref?.();
        pending.set(requestId, { revision, resolve, reject, timer });
      });
    },
    handleMessage(message) {
      if (!message || typeof message !== "object") return false;
      const isAck = message.type === "state:persist:ack";
      const isRejected = message.type === "state:persist:rejected";
      if (!isAck && !isRejected) return false;
      if (typeof message.requestId !== "string") return false;
      const waiter = pending.get(message.requestId);
      if (!waiter) return false;
      if (isRejected) {
        drop(message.requestId);
        const failure = new Error(typeof message.error === "string" && message.error.length > 0 ? message.error : "Persistence rejected by the main process.");
        // The main side stamps every rejection with its ledger position (and a
        // code, when it has one) so the child can re-synchronize revisions or
        // recognize a retry-later window instead of deadlocking.
        if (typeof message.code === "string" && message.code.length > 0) failure.code = message.code;
        if (Number.isSafeInteger(message.lastPersistedRevision)) failure.lastPersistedRevision = message.lastPersistedRevision;
        waiter.reject(failure);
        return true;
      }
      if (message.revision !== waiter.revision) {
        drop(message.requestId);
        waiter.reject(new Error(`Acknowledgement revision mismatch: expected ${waiter.revision}, got ${String(message.revision)}.`));
        return true;
      }
      drop(message.requestId);
      waiter.resolve();
      return true;
    },
    reject(requestId, error) {
      const waiter = drop(requestId);
      waiter?.reject(error instanceof Error ? error : new Error(String(error)));
    },
    rejectAll(error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const waiter of [...pending.values()]) {
        clearTimeout(waiter.timer);
        waiter.reject(failure);
      }
      pending.clear();
    }
  };
}

const persistAcks = createPersistAckRegistry();
if (typeof process.send === "function") {
  // Only the real IPC child wires the ack channel; unit tests substitute the
  // persistence adapter instead of a live main process.
  process.on("message", (message) => persistAcks.handleMessage(message));
  process.on("disconnect", () => persistAcks.rejectAll(new Error("Private persistence channel disconnected.")));
}

let persistAdapter = (state, context = {}) => {
  if (typeof process.send !== "function") return Promise.reject(new Error("Private persistence channel is unavailable."));
  // The parent may already be gone: a deliberate disconnect on a graceful stop,
  // or a parent crash. `process.send` stays a function after the channel closes,
  // so writing anyway emits an unhandled 'error' (EPIPE) ON THE PROCESS and
  // kills the child mid-shutdown — costing it the remaining flushes. With no
  // channel there is no way to persist the projection, so an ordinary save is
  // skipped; a DURABLE mutation fails (and rolls back) instead of faking success.
  if (process.connected !== true) {
    if (context?.durable === true) return Promise.reject(new Error("Private persistence channel is disconnected."));
    return Promise.resolve();
  }
  if (context?.durable === true) {
    let ack;
    try {
      ack = persistAcks.awaitAck(context.requestId, context.revision);
    } catch (error) {
      return Promise.reject(error);
    }
    // The CALLBACK is load-bearing, not decoration: process.send is ASYNCHRONOUS,
    // so a failed write (EPIPE, when the parent disconnects a tick later) is NOT
    // thrown — with no callback Node emits it as an 'error' event ON THE PROCESS,
    // which is unhandled and kills the child mid-shutdown. Routing it to the ack
    // rejection both shields the process and fails the mutation honestly.
    try {
      process.send({ type: "state:persist", state, requestId: context.requestId, revision: context.revision }, (error) => {
        if (error) persistAcks.reject(context.requestId, new Error(`Persistence request could not be sent: ${error.message}`));
      });
    } catch (error) {
      persistAcks.reject(context.requestId, error instanceof Error ? error : new Error(String(error)));
    }
    return ack;
  }
  try { process.send({ type: "state:persist", state }, () => { /* delivery failure is terminal-only */ }); } catch { /* channel closed mid-write */ }
  return Promise.resolve();
};

/**
 * Build a durable-capable persistence adapter over an INJECTED channel. This is
 * the same protocol the default process.send adapter speaks; it exists so tests
 * can wire the REAL durable escalation path (exact-requestId/revision acks,
 * timeout, disconnect) to the REAL main-process channel without a live child.
 */
export function createPersistBridgeAdapter(options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DURABLE_ACK_TIMEOUT_MS;
  const registry = createPersistAckRegistry({ timeoutMs, unref: options.unref !== false });
  const send = options.send;
  const isConnected = typeof options.isConnected === "function" ? options.isConnected : () => true;
  if (typeof options.onMessage === "function") options.onMessage((message) => registry.handleMessage(message));
  if (typeof options.onDisconnect === "function") options.onDisconnect(() => registry.rejectAll(new Error("Private persistence channel disconnected.")));
  return (state, context = {}) => {
    if (typeof send !== "function") return Promise.reject(new Error("Private persistence channel is unavailable."));
    if (context?.durable === true && !isConnected()) return Promise.reject(new Error("Private persistence channel is disconnected."));
    if (context?.durable === true) {
      let ack;
      try {
        ack = registry.awaitAck(context.requestId, context.revision);
      } catch (error) {
        return Promise.reject(error);
      }
      try {
        send({ type: "state:persist", state, requestId: context.requestId, revision: context.revision }, (error) => {
          if (error) registry.reject(context.requestId, new Error(`Persistence request could not be sent: ${error.message}`));
        });
      } catch (error) {
        registry.reject(context.requestId, error instanceof Error ? error : new Error(String(error)));
      }
      return ack;
    }
    try { send({ type: "state:persist", state }, () => {}); } catch { /* channel closed mid-write */ }
    return Promise.resolve();
  };
}

// Durable mutation bookkeeping. The queue serializes admin mutations so each
// main-process persist carries ONE exact projection and revisions are strictly
// monotonic; the pending counter backs saveState()'s deferral, so a background
// (usage/accessibleModels) write can never overtake an in-flight durable one.
let persistenceRevision = 0;
let mutationQueue = Promise.resolve();
let pendingDurableMutations = 0;
let deferredSave = false;

function normalize(state) {
  if (!state || !Array.isArray(state.keys)) return [];
  let invalidCount = 0;
  let legacyCount = 0;
  const result = state.keys.slice(0, MAX_KEYS).flatMap((record) => {
    const value = typeof record?.key === "string" ? record.key : record?.apiKey;
    const key = typeof value === "string" ? value.trim() : "";
    if (!key || key.length > MAX_KEY_LENGTH) { invalidCount++; return []; }
    const usage = record?.usage && typeof record.usage === "object" ? record.usage : {};
    const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    // Runtime-park provenance marker: only "auth" is a legal value; anything
    // else is dropped. A DISABLED record without the marker is admin-authored
    // (admin disables carry no reclaim window) OR legacy data written before
    // the marker existed — either way its stale backoffUntil must not let the
    // reclaim sweep resurrect it later.
    const parkedReason = record?.parkedReason === "auth" ? "auth" : null;
    const status = STATUSES.has(record?.status) ? record.status : "active";
    let backoffUntil = count(record?.backoffUntil);
    if (status === "disabled" && parkedReason === null) backoffUntil = 0;
    const normalized = {
        id: typeof record?.id === "string" && UUID_V4.test(record.id) ? record.id : crypto.randomUUID(),
        key,
        status,
        backoffUntil,
        usage: { success: count(usage.success), fail: count(usage.fail), tokens: count(usage.tokens), lastUsed: count(usage.lastUsed) },
        accessibleModels: Array.isArray(record?.accessibleModels) ? record.accessibleModels.filter((id) => typeof id === "string") : []
    };
    if (parkedReason !== null) normalized.parkedReason = parkedReason;
    // Admin-disable provenance: only "admin" is legal, anything else is dropped.
    if (record?.disabledBy === "admin") normalized.disabledBy = "admin";
    // Owner decision 2a: a disabled record with NO provenance may be an old
    // version's permanent 401/403 disable. It is not auto-migrated; it is only
    // flagged IN MEMORY (never persisted) so the UI can hint at a manual re-enable.
    if (status === "disabled" && parkedReason === null && normalized.disabledBy === undefined) {
      normalized.legacyDisabled = true;
      legacyCount += 1;
    }
    return [normalized];
  });
  if (invalidCount) warn("Skipped invalid key records", { count: invalidCount });
  if (legacyCount > 0) warn("Disabled keys without provenance (possibly an old auth failure; re-enable manually)", { count: legacyCount });
  return result;
}

export function initializeState(state) {
  keys = normalize(state);
  // Durable-mutation bookkeeping belongs to the state lifecycle: a fresh state
  // means a fresh revision lineage, an empty queue and no deferred background
  // write left over from a previous incarnation.
  persistenceRevision = 0;
  mutationQueue = Promise.resolve();
  pendingDurableMutations = 0;
  deferredSave = false;
  // Drop routing memory that decayed while the gateway child was down, so a
  // restart never starts out reserving keys for models nobody is using.
  pruneModelAffinity();
  info("State initialized", { count: keys.length });
}
export function setPersistenceAdapter(adapter) { persistAdapter = adapter; }
export function projectKeyState() {
  // Project the per-key contract the main process validates (state-ownership.ts
  // isChildKeyProjection). Besides the 5 core fields the projection carries the
  // optional accessibleModels (Phase 2) and the optional parkedReason marker
  // (auth runtime-park provenance). Unset optional fields are omitted entirely.
  return {
    keys: keys.map((k) => {
      const record = {
        id: k.id,
        key: k.key,
        status: k.status,
        backoffUntil: k.backoffUntil,
        usage: k.usage,
        accessibleModels: Array.isArray(k.accessibleModels) ? k.accessibleModels.filter((id) => typeof id === "string") : []
      };
      if (k.parkedReason === "auth") record.parkedReason = "auth";
      // Admin-disable provenance is persisted; legacyDisabled is memory-only
      // and deliberately never projected (it is re-derived on every load).
      if (k.disabledBy === "admin") record.disabledBy = "admin";
      return record;
    })
  };
}
function fireAndForgetPersist() {
  try {
    const result = persistAdapter(projectKeyState(), { durable: false });
    if (result && typeof result.catch === "function") result.catch(() => { /* best-effort background write */ });
  } catch { /* a background save must never crash the request path */ }
}
export function saveState() {
  // A durable admin mutation owns the "next" revision lineage until the main
  // process acknowledges it; an ordinary save issued meanwhile would persist an
  // intermediate state and let the durable request's ack confirm a DIFFERENT
  // state than the file holds. Defer and replay the newest state after the
  // durable queue settles instead.
  if (pendingDurableMutations > 0) { deferredSave = true; return; }
  fireAndForgetPersist();
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
 * Return every parked key whose retry window has elapsed to `active`.
 *
 * Covers BOTH bounded park states:
 *  - quota-exceeded (429 credit verdict) — its own due time, existing rule;
 *  - disabled WITH a runtime-park marker AND a now-past backoffUntil (401/403
 *    auth park) — the credential gets a fresh chance.
 *
 * An admin-disabled key carries backoffUntil === 0 and NO parkedReason marker
 * (setKeyStatus[Durably] strip both; normalize() drops stale legacy windows),
 * so the sweep can never resurrect an operator's deliberate disable.
 *
 * Run as a SWEEP at the top of getNextKey, not as a last-resort branch: reclaim
 * is driven only by the key's own due time (and its provenance marker), never
 * by how many other keys are active; the normal LRU below decides who serves
 * this request.
 *
 * @param {number} now
 * @returns {void}
 */
export function reclaimDueParkedKeys(now) {
  for (const key of keys) {
    const clampMax = key.parkedReason === "auth"
      ? AUTH_RETRY_MAX_MS
      : key.status === "quota-exceeded" ? QUOTA_RETRY_MAX_MS : MAX_BACKOFF_MS;
    if (key.backoffUntil && key.backoffUntil > now + clampMax) {
      key.backoffUntil = now + clampMax;
    }
    if (key.status === "quota-exceeded") {
      if ((key.backoffUntil || 0) > now) continue;
      key.status = "active";
      key.backoffUntil = 0;
      delete key.disabledBy;
      info("Quota-exceeded key returned for a bounded retry", { id: key.id, attempt: (quotaRetries.get(key.id) ?? 0) + 1 });
      continue;
    }
    if (key.status === "disabled") {
      // Only runtime auth parks (marker + an elapsed window) revive — never an
      // admin-authored disabled key, whose marker and schedule are both absent.
      if (key.parkedReason !== "auth" || !(key.backoffUntil > 0) || key.backoffUntil > now) continue;
      key.status = "active";
      key.backoffUntil = 0;
      delete key.parkedReason;
      delete key.disabledBy;
      info("Auth-parked key returned after its retry window", { id: key.id, attempt: (authRetries.get(key.id) ?? 0) + 1 });
    }
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
 * @param {{ excludedKeyIds?: Set<string> }} [options] Per-request keys that must
 * not be selected again while an untried eligible key remains.
 * @returns {object | null}
 */
export function getNextKey(modelId, options = {}) {
  if (locked) return null; locked = true;
  try {
    const now = Date.now();
    reclaimDueParkedKeys(now);
    const excludedKeyIds = options.excludedKeyIds instanceof Set ? options.excludedKeyIds : new Set();
    if (typeof modelId === "string" && modelId.length > 0) {
      const affine = selectKeyForModel(modelId, keys, { now, excludedKeyIds });
      if (affine) {
        affine.usage.lastUsed = now;
        return affine;
      }
    }
    const available = keys.filter((key) => key.status === "active" && key.backoffUntil <= now && !excludedKeyIds.has(key.id)).sort((a, b) => a.usage.lastUsed - b.usage.lastUsed);
    if (available.length > 0) {
      available[0].usage.lastUsed = now;
      return available[0];
    }
    const activeInBackoff = keys.filter((key) => key.status === "active" && key.backoffUntil > now && !excludedKeyIds.has(key.id)).sort((a, b) => {
      if (a.backoffUntil !== b.backoffUntil) return a.backoffUntil - b.backoffUntil;
      return a.usage.lastUsed - b.usage.lastUsed;
    });
    if (activeInBackoff.length > 0) {
      const candidate = activeInBackoff[0];
      candidate.backoffUntil = 0;
      candidate.usage.lastUsed = now;
      return candidate;
    }
    // No last-resort quota revival here any more: reclaimDueParkedKeys above has
    // ALREADY reclaimed every key whose retry window elapsed, on its own
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
  // passed), so the escalation ladders must not keep punishing it.
  if (success) { quotaRetries.delete(id); authRetries.delete(id); }
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; saveState(); }, 5000);
}

/**
 * Record an upstream failure against a key.
 *
 * Scope of each verdict — this split is the point of the per-model routing:
 *
 *  - 401/403          GLOBAL, RECOVERABLE. A credential verdict: the key is
 *                     parked (disabled) behind a bounded escalating window and
 *                     auto-reclaimed by the sweep — never deleted, never a
 *                     permanent death sentence.
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
  // A late verdict from a request that was already in flight must never move a
  // key that is "disabled until an admin acts" (admin disable, or a legacy
  // disable without provenance) into a runtime park the sweep would later
  // revive. Only an auth park (parkedReason "auth") is an automatic, temporary
  // disable and keeps escalating. Usage/failure counters are still recorded.
  const adminHeld = key.status === "disabled" && key.parkedReason !== "auth";
  if (statusCode === 401 || statusCode === 403) { if (!adminHeld) parkAuthRejected(key); }
  // GLOBAL exhaustion is decided by isQuotaExhaustedBody, which resolves the
  // precedence INTERNALLY: a rate-limit wording wins even when it also contains
  // the word "quota" ("exceeded your quota of 40 requests per minute"), so this
  // branch can stay ahead of the model-scoped one without stealing model-scoped
  // 429s from it. The old `includes("quota")` failed both ways: it parked healthy
  // keys pool-wide, and it let real exhaustion ("credit balance", "free credits
  // used") through as a 20 s cooldown that hammered a dead key forever.
  else if (statusCode === 429 && isQuotaExhaustedBody(responseBody)) { if (!adminHeld) parkQuotaExceeded(key); }
  // An admin-held key is not selectable, so a model cooldown for it would only
  // leave a stale block that outlives a later admin re-enable: skip it.
  else if (statusCode === 429 && hasModel && !adminHeld) {
    // MODEL-SCOPED: this key stays immediately usable by every other model.
    backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(0, backoffMs || MAX_KEY_COOLDOWN_429_MS));
    markRateLimited(modelId, id, { cooldownMs: backoffMs });
    // DEBOUNCED, never a synchronous write here: this is the failure hot path,
    // and a 429 wave (many models × many keys) would otherwise issue a burst of
    // writeFileSync calls exactly while the gateway is already degrading.
    // flushAffinity() on shutdown is what makes the deferred write durable.
    schedulePersistAffinity();
  }
  else if ((statusCode === 429 || statusCode >= 500) && !adminHeld) {
    backoffMs ||= statusCode === 429 ? MAX_KEY_COOLDOWN_429_MS : 10000;
    backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(0, backoffMs));
    key.backoffUntil = Date.now() + backoffMs;
  }
  markKeyUsedAndDebounceSave(id, { success: false });
  if (statusCode >= 500) {
    if (adminHeld) warn("Upstream error on admin-disabled key; no backoff (held)", { statusCode });
    else warn("Upstream error, backing off", { id, statusCode, backoffMs });
  }
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
 * Current distinct key ids that selection can use for this request/model.
 * Model-eligible keys are preferred. When every active key is model-cooled,
 * preserve the existing bounded reprobe policy by exposing the globally
 * available active pool that getNextKey() falls back to.
 *
 * @param {string} [modelId]
 * @returns {string[]}
 */
export function getCurrentEligibleKeyIds(modelId) {
  const now = Date.now();
  reclaimDueParkedKeys(now);
  const active = keys.filter((key) => key.status === "active");
  const globallyAvailable = active.filter((key) => key.backoffUntil <= now);
  if (typeof modelId !== "string" || modelId.length === 0) {
    return (globallyAvailable.length > 0 ? globallyAvailable : active).map((key) => key.id);
  }
  const modelEligible = getEligibleKeys(modelId, keys, { now });
  return (modelEligible.length > 0 ? modelEligible : active).map((key) => key.id);
}

/** Commit sticky affinity only after a terminal upstream success. */
export function commitModelKeyAssignment(modelId, keyId) {
  if (typeof modelId !== "string" || modelId.length === 0) return;
  recordAssignment(modelId, keyId);
  schedulePersistAffinity();
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
export function removeKey(id) { const before = keys.length; keys = keys.filter((item) => item.id !== id); if (keys.length === before) return false; quotaRetries.delete(id); authRetries.delete(id); saveState(); return true; }
/**
 * Admin status transition. VALIDATED against STATUSES: normalize() guards this
 * on load, but the setter used to write any string through, and an out-of-set
 * value makes the key invisible to every `status === "active"` filter — a 503
 * while healthy keys exist. admin-api.mjs already rejects a bad status with 422
 * (parseStatus), so this closes the non-HTTP callers, not that path.
 *
 * @returns {boolean} false for an unknown status or an unknown id.
 */
// Any admin status decision supersedes the legacy (unknown-provenance) flag;
// only an admin DISABLE carries the persisted disabledBy:"admin" marker.
function applyAdminProvenance(key, status) {
  delete key.legacyDisabled;
  if (status === "disabled") key.disabledBy = "admin";
  else delete key.disabledBy;
}

export function setKeyStatus(id, status) {
  if (!STATUSES.has(status)) { warn("Rejected invalid key status", { id, status: typeof status === "string" ? status : typeof status }); return false; }
  const key = keys.find((item) => item.id === id); if (!key) return false;
  key.status = status;
  applyAdminProvenance(key, status);
  if (status === "active") { key.backoffUntil = 0; quotaRetries.delete(id); authRetries.delete(id); delete key.parkedReason; }
  // An admin disable carries NO reclaim markers: backoffUntil 0 and no
  // parkedReason, so the sweep (which revives only marker+window runtime parks)
  // can never resurrect an operator's deliberate disable.
  else if (status === "disabled") { key.backoffUntil = 0; delete key.parkedReason; }
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

// ─── Durable admin mutations ────────────────────────────────────────────────
//
// Same operations as the sync API above, but each mutation is serialized on
// `mutationQueue`, persisted through the ack-waiting adapter, and rolled back
// (keys — merged so unrelated runtime deltas survive — plus both retry ladders
// and model-key affinity references) when the main process does not durably
// commit it.
//
// HONEST visibility while pending: the mutation runs on a per-key cloned
// "working" array that BECOMES the live state immediately, so concurrent
// readers DO observe the uncommitted change during the ack window (tests pin
// this deliberately — a request that lands mid-mutation must see the pool the
// operator just configured). What rollback guarantees is CONVERGENCE, not
// opacity: if the durable write fails, only the keys the mutation touched are
// reverted, and every usage/park/ladder delta gathered by the OTHER keys
// during the window survives.

function cloneKeyRecord(record) {
  return {
    ...record,
    usage: { ...(record.usage ?? {}) },
    accessibleModels: Array.isArray(record.accessibleModels) ? [...record.accessibleModels] : []
  };
}

function describePersistenceFailure(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Merge rollback: restore ONLY what the mutation touched.
 *
 * - `previous` holds the ORIGINAL records (identity preserved) from before the
 *   mutation; `working` is the live array that accumulated unrelated runtime
 *   deltas (usage, park state) during the ack window.
 * - Untouched keys keep their LIVE working records — their counters, cooldown
 *   marks and ladder positions are not the mutation's to erase.
 * - Touched keys: usage counters MERGE (they are observational truth —
 *   requests really happened), but status and backoffUntil are restored from
 *   the pre-mutation record WHOLESALE. Status is dual-writer INTENT: the admin
 *   edit failed, so its effects must not linger; a runtime verdict (401
 *   disable, quota park) that raced the rollback pointed at the in-flight
 *   state and must not outlive that state's undoing either. Deliberately no
 *   timestamped winner-picking here: a park cleared by a committed admin
 *   'active' transition must never be resurrected by a rollback merge, and a
 *   rollback merge must never fabricate a verdict the durable state never
 *   endorsed. Runtime re-derives the truth on the next live request.
 * - The retry ladders (quotaRetries and authRetries) are restored PER TOUCHED
 *   KEY only.
 */
function mergeRollback({ previous, working, touchedIds, previousQuotaRetries, previousAuthRetries }) {
  const touched = new Set(touchedIds ?? []);
  const workingById = new Map(working.map((record) => [record.id, record]));
  const previousById = new Map(previous.map((record) => [record.id, record]));
  const merged = [];
  for (const record of working) {
    if (!touched.has(record.id)) merged.push(record);
  }
  for (const prior of previous) {
    if (!touched.has(prior.id)) continue;
    const live = workingById.get(prior.id);
    merged.push(live ? { ...prior, usage: mergeUsageCounters(prior.usage, live.usage) } : prior);
  }
  // Restore the pre-mutation ORDER so a failed reorder/remove is invisible to
  // the rotation order, then keep any untouched additions.
  const mergedById = new Map(merged.map((record) => [record.id, record]));
  const ordered = previous.map((prior) => mergedById.get(prior.id)).filter(Boolean);
  for (const record of merged) {
    if (!previousById.has(record.id)) ordered.push(record);
  }
  for (const [map, snapshot] of [[quotaRetries, previousQuotaRetries], [authRetries, previousAuthRetries]]) {
    if (!snapshot) continue;
    for (const id of touched) {
      if (snapshot.has(id)) map.set(id, snapshot.get(id));
      else map.delete(id);
    }
  }
  return ordered;
}

// Usage counters only ever grow (success/fail/tokens/lastUsed); the larger
// value is always the freshest observation.
function mergeUsageCounters(previousUsage, liveUsage) {
  const a = previousUsage ?? {};
  const b = liveUsage ?? {};
  return {
    success: Math.max(a.success ?? 0, b.success ?? 0),
    fail: Math.max(a.fail ?? 0, b.fail ?? 0),
    tokens: Math.max(a.tokens ?? 0, b.tokens ?? 0),
    lastUsed: Math.max(a.lastUsed ?? 0, b.lastUsed ?? 0)
  };
}

export async function executeDurableMutation(mutate) {
  const previousKeys = keys;
  const previousQuotaRetries = new Map(quotaRetries);
  const previousAuthRetries = new Map(authRetries);
  const working = previousKeys.map(cloneKeyRecord);
  keys = working;
  let outcome;
  try {
    outcome = mutate(working);
  } catch (syncError) {
    keys = previousKeys;
    throw syncError;
  }
  if (!outcome || outcome.applied !== true) {
    keys = previousKeys;
    return outcome?.value ?? null;
  }
  const undoAffinity = typeof outcome.undoAffinity === "function" ? outcome.undoAffinity : null;
  const requestId = crypto.randomUUID();
  const revision = persistenceRevision + 1;
  pendingDurableMutations += 1;
  try {
    await Promise.resolve(persistAdapter(projectKeyState(), { durable: true, requestId, revision }));
    persistenceRevision = revision;
    if (undoAffinity) schedulePersistAffinity();
    return outcome.value;
  } catch (error) {
    keys = mergeRollback({
      previous: previousKeys,
      working,
      touchedIds: outcome.touchedIds,
      previousQuotaRetries,
      previousAuthRetries
    });
    if (undoAffinity) {
      try { undoAffinity(); } catch { /* rollback must itself never throw */ }
      schedulePersistAffinity();
    }
    // Reconcile decision. Skipping the legacy reconcile write is only honest
    // when the main side PROVED it never touched disk — a rejection issued
    // BEFORE the store write (wrong revision, MIGRATION_IN_PROGRESS). Everything
    // else may have partially committed (SecureStore replaces the primary file
    // before the recovery one, so a mid-store throw leaves the new projection
    // on disk): ambiguous ack timeouts/disconnects AND rejections classified
    // PERSIST_WRITE_FAILED both reconcile.
    const provenPrePersistRejection = Number.isSafeInteger(error?.lastPersistedRevision) && error?.code !== "PERSIST_WRITE_FAILED";
    if (!provenPrePersistRejection) {
      fireAndForgetPersist();
    }
    warn("Durable key mutation rolled back", { revision, reason: describePersistenceFailure(error) });
    throw new KeyPersistenceError("Key persistence failed", { cause: error });
  } finally {
    pendingDurableMutations -= 1;
    if (pendingDurableMutations === 0 && deferredSave) {
      deferredSave = false;
      fireAndForgetPersist();
    }
  }
}

/**
 * Execute one serialized durable mutation, retrying EXACTLY ONCE when the main
 * side reports progress we did not see: its rejection always carries the ledger
 * (`lastPersistedRevision`). If that ledger is AHEAD of ours, a revision we
 * believed failed was actually committed (its ack was lost in transit); the
 * first attempt already rolled memory back and reconciled disk, so the honest
 * recovery is to fast-forward our counter and replay the mutation at the
 * ledger's expected next revision. Anything else is final.
 */
async function executeDurableWithSingleRetry(mutate) {
  try {
    return await executeDurableMutation(mutate);
  } catch (error) {
    const cause = error instanceof KeyPersistenceError ? error.cause : null;
    const ledger = Number.isSafeInteger(cause?.lastPersistedRevision) ? cause.lastPersistedRevision
      : Number.isSafeInteger(error?.lastPersistedRevision) ? error.lastPersistedRevision
        : null;
    if (ledger === null || ledger <= persistenceRevision) throw error;
    persistenceRevision = ledger;
    info("Durable revision ledger re-synchronized; retrying the mutation once", { lastPersistedRevision: ledger });
    return executeDurableMutation(mutate);
  }
}

function enqueueDurableMutation(mutate) {
  const run = mutationQueue.then(() => executeDurableWithSingleRetry(mutate));
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

export function addKeyDurably(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key || key.length > MAX_KEY_LENGTH) return Promise.resolve(null);
  return enqueueDurableMutation((working) => {
    if (working.length >= MAX_KEYS || working.some((item) => item.key === key)) return { applied: false, value: null };
    const record = { id: crypto.randomUUID(), key, status: "active", backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] };
    working.push(record);
    info("Key added", { id: record.id, keyCount: working.length });
    return { applied: true, value: record, touchedIds: [record.id] };
  });
}

export function removeKeyDurably(id) {
  return enqueueDurableMutation((working) => {
    const index = working.findIndex((item) => item.id === id);
    if (index === -1) return { applied: false, value: false };
    working.splice(index, 1);
    quotaRetries.delete(id);
    authRetries.delete(id);
    // A deleted key must not stay pinned to a model (sticky routing at a key
    // the pool no longer holds) nor carry cooldown entries; the rollback
    // closure reinstates them verbatim when the durable write fails.
    const undoAffinity = removeKeyReferences(id);
    return { applied: true, value: true, touchedIds: [id], undoAffinity };
  });
}

export function setKeyStatusDurably(id, status) {
  if (!STATUSES.has(status)) {
    warn("Rejected invalid key status", { id, status: typeof status === "string" ? status : typeof status });
    return Promise.resolve(false);
  }
  return enqueueDurableMutation((working) => {
    const key = working.find((item) => item.id === id);
    if (!key) return { applied: false, value: false };
    key.status = status;
    applyAdminProvenance(key, status);
    if (status === "active") { key.backoffUntil = 0; quotaRetries.delete(id); authRetries.delete(id); delete key.parkedReason; }
    // Admin disable: no runtime reclaim markers (backoffUntil 0, no marker), so
    // the sweep never resurrects an operator's disable.
    else if (status === "disabled") { key.backoffUntil = 0; delete key.parkedReason; }
    // Parking by hand still gets a retry schedule, otherwise the reclaim sweep
    // would undo the decision on the very next request. Uses the CURRENT ladder
    // level without escalating it: an admin action is not an upstream failure.
    else if (status === "quota-exceeded") { key.backoffUntil = Date.now() + quotaRetryWindowMs(quotaRetries.get(id) ?? 0); }
    return { applied: true, value: true, touchedIds: [id] };
  });
}

export function reorderKeysDurably(ids) {
  return enqueueDurableMutation((working) => {
    const order = new Map(ids.map((id, index) => [id, index]));
    working.sort((a, b) => (order.get(a.id) ?? ids.length) - (order.get(b.id) ?? ids.length));
    // Order-only change: every listed id keeps its live record; rollback only
    // restores the previous SEQUENCE. touchedIds stays empty so no key record
    // is treated as edited.
    return { applied: true, value: true, touchedIds: [] };
  });
}
