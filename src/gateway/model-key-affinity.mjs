// @ts-check
/**
 * PER-MODEL key routing for the NV-Gateway.
 *
 * NVIDIA enforces rate limits on TWO independent axes:
 *
 *   1. PER KEY/ACCOUNT — roughly 40 requests per minute for one credential.
 *   2. PER MODEL — every model carries its own limit, popular models see
 *      model-wide 429 waves, and an exhausted credit balance answers 429 for
 *      everything.
 *
 * A 429 is therefore a verdict about the (model, key) PAIR, never about the key
 * alone: the same key that answers 429 for one model serves another with 200 in
 * the very same second. Two consequences drive this module:
 *
 *   - STICKY ASSIGNMENT. Each actively requested model keeps its OWN key and
 *     reuses it on the next request, so N concurrent models consume N separate
 *     per-key budgets instead of jointly burning one key's 40 RPM.
 *   - MODEL-SCOPED COOLDOWN. A rate-limit 429 parks the pair, leaving the key
 *     immediately available to every other model.
 *
 * Deliberately NOT model-scoped (these stay global, unchanged):
 *   - 401/403      — a credential verdict; the key is disabled everywhere.
 *   - 429 + quota  — exhausted credits answer 429 for every model.
 *   - 5xx          — an upstream fault; keeps the existing short global backoff.
 *
 * The module is PURE with respect to the gateway: no logger dependency (mirrors
 * capability-probe.mjs, which avoids logger.mjs because it throws without
 * GATEWAY_LOG_PATH), no upstream I/O, and an injectable clock, so every rule is
 * unit-testable. The only side effect is a small JSON cache written beside the
 * other runtime caches.
 *
 * PRIVACY: the persisted payload holds ONLY model ids, key UUIDs and
 * timestamps. Upstream key material is never read here and never written.
 *
 * Environment variables:
 * - GATEWAY_MODEL_AFFINITY_CACHE_PATH — explicit cache file path override
 * - GATEWAY_CONFIG_PATH / GATEWAY_LOG_PATH — used to derive the cache location
 *
 * @module model-key-affinity
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How long a (model -> key) assignment and a (model, key) cooldown stay
 * remembered without being refreshed. 15 minutes: long enough that an active
 * conversation keeps its key across think-time pauses, short enough that a
 * model nobody is using stops reserving a key against the models that are.
 */
export const AFFINITY_TTL_MS = 15 * 60 * 1000;

/**
 * Fallback model-scoped cooldown for a 429 that carries no Retry-After.
 * Mirrors MAX_KEY_COOLDOWN_429_MS in rotation.mjs so the two axes agree.
 */
export const DEFAULT_MODEL_COOLDOWN_MS = 20_000;

/** Hard ceiling on any single model-scoped cooldown (mirrors MAX_BACKOFF_MS). */
export const MAX_MODEL_COOLDOWN_MS = 300 * 1000;

/** Persistent-cache payload format. */
export const AFFINITY_CACHE_FORMAT_VERSION = 1;

/**
 * Debounce window for deferred cache writes. 5s matches the `saveTimer`
 * precedent in rotation.mjs (markKeyUsedAndDebounceSave) so both of the
 * gateway's persistence paths coalesce on the same cadence.
 */
export const AFFINITY_PERSIST_DEBOUNCE_MS = 5_000;

/** Cache file name used when derived from the gateway's APPDATA state dir. */
const CACHE_FILENAME = "model-key-affinity.json";

/** Bound on persisted entries, so a long-lived install cannot grow unbounded. */
const MAX_TRACKED_MODELS = 500;
const MAX_TRACKED_COOLDOWNS = 2_000;

/** Separator for the composite cooldown key. NUL can appear in neither id. */
const PAIR_SEPARATOR = "\u0000";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {Map<string, { keyId: string, at: number }>} model id -> assignment */
const assignments = new Map();

/** @type {Map<string, { until: number, at: number }>} "model\0keyId" -> cooldown */
const cooldowns = new Map();

/** @type {{ cachePath: string | null | undefined, loaded: boolean }} */
let state = {
    cachePath: resolveAffinityCachePath(),
    loaded: false
};

let ttlMs = AFFINITY_TTL_MS;

/**
 * Single coalescing timer for deferred writes, mirroring the `saveTimer`
 * precedent in rotation.mjs (markKeyUsedAndDebounceSave): while one is armed,
 * further requests ride on it instead of arming another.
 * @type {NodeJS.Timeout | null}
 */
let persistTimer = null;

/** True when memory holds changes not yet on disk. */
let persistPending = false;

/** Mutable so tests can shorten the window via resetAffinityState() (same pattern as ttlMs). */
let persistDebounceMs = AFFINITY_PERSIST_DEBOUNCE_MS;

// ---------------------------------------------------------------------------
// Path resolution + persistence (mirrors capability-probe.mjs)
// ---------------------------------------------------------------------------

/**
 * Resolve where the persistent affinity cache lives. Preference order:
 *   GATEWAY_MODEL_AFFINITY_CACHE_PATH → dirname(GATEWAY_CONFIG_PATH) → parent of
 *   dirname(GATEWAY_LOG_PATH) (logs dir is <userData>/logs, so its parent is the
 *   same APPDATA userData dir that already holds config.json/keys.json).
 * Returns null when nothing is known → memory-only routing.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function resolveAffinityCachePath(env = process.env) {
    if (typeof env.GATEWAY_MODEL_AFFINITY_CACHE_PATH === "string" && env.GATEWAY_MODEL_AFFINITY_CACHE_PATH.trim()) {
        return env.GATEWAY_MODEL_AFFINITY_CACHE_PATH;
    }
    if (typeof env.GATEWAY_CONFIG_PATH === "string" && env.GATEWAY_CONFIG_PATH.trim()) {
        return path.join(path.dirname(env.GATEWAY_CONFIG_PATH), CACHE_FILENAME);
    }
    if (typeof env.GATEWAY_LOG_PATH === "string" && env.GATEWAY_LOG_PATH.trim()) {
        return path.join(path.dirname(path.dirname(env.GATEWAY_LOG_PATH)), CACHE_FILENAME);
    }
    return null;
}

function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}

/** A finite, non-negative timestamp. */
function isTimestamp(value) {
    return Number.isFinite(value) && value >= 0;
}

function ensureLoaded() {
    if (state.loaded) return;
    state.loaded = true;
    if (!state.cachePath) return;
    let raw;
    try {
        raw = fs.readFileSync(state.cachePath, "utf8");
    } catch {
        return; // absent / unreadable — start empty
    }
    try {
        const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
        // Reject anything that is not a recognized object payload of a KNOWN
        // version: an unknown FUTURE version is ignored rather than misread.
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        if (parsed.version !== AFFINITY_CACHE_FORMAT_VERSION) return;

        const rawAssignments = parsed.assignments;
        if (rawAssignments && typeof rawAssignments === "object" && !Array.isArray(rawAssignments)) {
            for (const [model, entry] of Object.entries(rawAssignments)) {
                if (!isNonEmptyString(model) || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
                if (!isNonEmptyString(entry.keyId) || !isTimestamp(entry.at)) continue;
                assignments.set(model, { keyId: entry.keyId, at: entry.at });
            }
        }

        const rawCooldowns = parsed.cooldowns;
        if (rawCooldowns && typeof rawCooldowns === "object" && !Array.isArray(rawCooldowns)) {
            for (const [pair, entry] of Object.entries(rawCooldowns)) {
                if (!isNonEmptyString(pair) || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
                if (!isTimestamp(entry.until) || !isTimestamp(entry.at)) continue;
                cooldowns.set(pair, { until: entry.until, at: entry.at });
            }
        }
    } catch {
        // Corrupt cache file — ignore it; routing rebuilds from live traffic.
    }
}

/**
 * Write the current map to disk IMMEDIATELY. Best-effort: a failure leaves the
 * in-memory routing fully functional. Only model ids, key UUIDs and timestamps
 * are written — never key material.
 *
 * Prefer {@link schedulePersistAffinity} on hot paths: this call is a synchronous
 * writeFileSync + rename and must not run once per upstream failure.
 *
 * @returns {void}
 */
export function persistAffinity() {
    ensureLoaded();
    if (!state.cachePath) return;
    // Disk is about to match memory, so any queued write is satisfied. Cleared
    // up front: even if the write below fails, re-queueing is the scheduler's
    // job, not a retry loop hidden in here.
    persistPending = false;
    const payload = {
        version: AFFINITY_CACHE_FORMAT_VERSION,
        savedAt: new Date().toISOString(),
        assignments: Object.fromEntries(assignments),
        cooldowns: Object.fromEntries(cooldowns)
    };
    const tmpPath = `${state.cachePath}.tmp`;
    try {
        fs.mkdirSync(path.dirname(state.cachePath), { recursive: true });
        fs.writeFileSync(tmpPath, JSON.stringify(payload), "utf8");
        fs.renameSync(tmpPath, state.cachePath);
    } catch {
        // Persistence is best-effort by design.
    }
}

/**
 * Queue a deferred write, coalescing a burst into ONE disk write.
 *
 * Why this exists: {@link persistAffinity} is a synchronous writeFileSync +
 * rename of a payload that can reach ~163 KB. Calling it once per rate-limit 429
 * put that write on the FAILURE hot path — during a 429 wave (many models ×
 * many keys) the gateway would issue a burst of synchronous file writes at
 * precisely the moment it is already degrading, blocking the event loop.
 *
 * Mirrors the `saveTimer` precedent in rotation.mjs
 * (markKeyUsedAndDebounceSave): one timer, {@link AFFINITY_PERSIST_DEBOUNCE_MS}
 * apart, and while it is armed every further request simply rides on it.
 *
 * The timer is `unref`'d so a queued cache write can never hold the gateway
 * child — or a test runner — alive. Durability comes from
 * {@link flushAffinity} on the shutdown path instead, so a graceful stop always
 * lands the data; an ungraceful kill forfeits at most one debounce window of
 * cooldown marks, which are short-lived rate-limit hints (20s cooldowns under a
 * 15-minute TTL), never authoritative state.
 *
 * @returns {void}
 */
export function schedulePersistAffinity() {
    ensureLoaded();
    if (!state.cachePath) return; // memory-only: nothing to write, nothing to arm
    persistPending = true;
    if (persistTimer) return; // coalesce onto the already-armed timer
    persistTimer = setTimeout(() => {
        persistTimer = null;
        if (persistPending) persistAffinity();
    }, persistDebounceMs);
    persistTimer.unref?.();
}

/**
 * Write any queued changes NOW and drop the timer. Shutdown counterpart of
 * {@link schedulePersistAffinity}, mirroring flushState() in rotation.mjs.
 *
 * Unlike flushState — which always writes — this writes only when something is
 * actually queued, so a shutdown that changed nothing does not create or rewrite
 * the cache file.
 *
 * @returns {void}
 */
export function flushAffinity() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    if (persistPending) persistAffinity();
}

/**
 * Drop the timer WITHOUT writing, mirroring closeStateWatcher() in rotation.mjs.
 * Used where the goal is only to stop holding a timer.
 * @returns {void}
 */
export function closeAffinityPersistence() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
}

/**
 * Persistence bookkeeping, for tests and diagnostics.
 *
 * `timerHasRef` is false for an armed timer because it is unref'd: a queued
 * cache write must never be the reason a process stays alive.
 *
 * @returns {{ pending: boolean, timerArmed: boolean, timerHasRef: boolean }}
 */
export function affinityPersistState() {
    return {
        pending: persistPending,
        timerArmed: persistTimer !== null,
        timerHasRef: persistTimer !== null && persistTimer.hasRef?.() === true
    };
}

// ---------------------------------------------------------------------------
// Core rules (pure, injectable clock)
// ---------------------------------------------------------------------------

function clockOf(options) {
    return Number.isFinite(options?.now) ? options.now : Date.now();
}

function pairKey(modelId, keyId) {
    return `${modelId}${PAIR_SEPARATOR}${keyId}`;
}

/**
 * The key this model is currently pinned to, or null when nothing is
 * remembered or the memory has decayed past the TTL.
 *
 * @param {unknown} modelId
 * @param {{ now?: number }} [options]
 * @returns {string | null}
 */
export function getAssignedKeyId(modelId, options = {}) {
    ensureLoaded();
    if (!isNonEmptyString(modelId)) return null;
    const entry = assignments.get(modelId);
    if (!entry) return null;
    if (clockOf(options) - entry.at > ttlMs) return null;
    return entry.keyId;
}

/**
 * Pin a model to a key (or refresh an existing pin's freshness).
 *
 * @param {unknown} modelId
 * @param {unknown} keyId
 * @param {{ now?: number }} [options]
 * @returns {void}
 */
export function recordAssignment(modelId, keyId, options = {}) {
    ensureLoaded();
    if (!isNonEmptyString(modelId) || !isNonEmptyString(keyId)) return;
    assignments.set(modelId, { keyId, at: clockOf(options) });
    if (assignments.size > MAX_TRACKED_MODELS) evictOldest(assignments, MAX_TRACKED_MODELS);
}

/**
 * Park a (model, key) pair after a rate-limit 429. The key stays fully
 * available to every OTHER model — that is the entire point.
 *
 * @param {unknown} modelId
 * @param {unknown} keyId
 * @param {{ now?: number, cooldownMs?: number }} [options]
 * @returns {void}
 */
export function markRateLimited(modelId, keyId, options = {}) {
    ensureLoaded();
    if (!isNonEmptyString(modelId) || !isNonEmptyString(keyId)) return;
    const now = clockOf(options);
    const requested = Number.isFinite(options.cooldownMs) && options.cooldownMs > 0
        ? options.cooldownMs
        : DEFAULT_MODEL_COOLDOWN_MS;
    const cooldownMs = Math.min(MAX_MODEL_COOLDOWN_MS, requested);
    cooldowns.set(pairKey(modelId, keyId), { until: now + cooldownMs, at: now });
    if (cooldowns.size > MAX_TRACKED_COOLDOWNS) evictOldest(cooldowns, MAX_TRACKED_COOLDOWNS);
}

/**
 * Whether this exact (model, key) pair is still cooling down.
 *
 * @param {unknown} modelId
 * @param {unknown} keyId
 * @param {{ now?: number }} [options]
 * @returns {boolean}
 */
export function isRateLimited(modelId, keyId, options = {}) {
    ensureLoaded();
    if (!isNonEmptyString(modelId) || !isNonEmptyString(keyId)) return false;
    const entry = cooldowns.get(pairKey(modelId, keyId));
    if (!entry) return false;
    const now = clockOf(options);
    if (now - entry.at > ttlMs) return false; // memory decayed
    return entry.until > now;
}

/** A key the pool considers usable right now, ignoring per-model state. */
function isGloballyAvailable(key, now) {
    return Boolean(key) && key.status === "active" && (key.backoffUntil ?? 0) <= now;
}

/**
 * The keys this model may currently use: globally available AND not cooling
 * down for this specific model.
 *
 * @param {unknown} modelId
 * @param {Array<{ id: string, status: string, backoffUntil?: number, usage?: { lastUsed?: number } }>} keys
 * @param {{ now?: number }} [options]
 * @returns {Array<object>}
 */
export function getEligibleKeys(modelId, keys, options = {}) {
    ensureLoaded();
    const now = clockOf(options);
    const pool = Array.isArray(keys) ? keys : [];
    return pool.filter((key) => isGloballyAvailable(key, now)
        && !isRateLimited(modelId, key?.id, { now }));
}

/**
 * How many keys are allowed for this model right now. Used by the failover loop
 * to bound the uniform-429 confirming attempts by the keys that could actually
 * serve THIS model, so the early stop never fires before a known-good key was
 * tried and never walks keys the model may not use.
 *
 * @param {unknown} modelId
 * @param {Array<object>} keys
 * @param {{ now?: number }} [options]
 * @returns {number}
 */
export function countEligibleKeys(modelId, keys, options = {}) {
    return getEligibleKeys(modelId, keys, options).length;
}

/** Models that currently hold a live (non-decayed) pin on some key. */
function liveHolders(now, exceptModelId) {
    const held = new Set();
    for (const [model, entry] of assignments) {
        if (model === exceptModelId) continue;
        if (now - entry.at > ttlMs) continue;
        held.add(entry.keyId);
    }
    return held;
}

function leastRecentlyUsed(candidates) {
    return [...candidates].sort((a, b) => (a.usage?.lastUsed ?? 0) - (b.usage?.lastUsed ?? 0))[0] ?? null;
}

/**
 * Choose the key this model should use.
 *
 * Order of preference:
 *   1. STICKY — the key this model already owns, when it is still eligible.
 *   2. SPREAD — a key no OTHER active model currently holds, least recently
 *      used first, so concurrently used models land on separate keys.
 *   3. LRU — least recently used among the remaining eligible keys, when every
 *      eligible key is already held by another model (pool smaller than the
 *      number of active models).
 *
 * Returns null when NO key is eligible for this model, letting the caller fall
 * back to the pool-wide selection rather than inventing an answer here.
 *
 * @param {unknown} modelId
 * @param {Array<object>} keys
 * @param {{ now?: number }} [options]
 * @returns {object | null}
 */
export function selectKeyForModel(modelId, keys, options = {}) {
    ensureLoaded();
    if (!isNonEmptyString(modelId)) return null;
    const now = clockOf(options);
    const candidates = getEligibleKeys(modelId, keys, { now });
    if (candidates.length === 0) return null;

    const pinned = getAssignedKeyId(modelId, { now });
    if (pinned) {
        const sticky = candidates.find((key) => key.id === pinned);
        if (sticky) return sticky;
    }

    const held = liveHolders(now, modelId);
    const free = candidates.filter((key) => !held.has(key.id));
    return leastRecentlyUsed(free.length > 0 ? free : candidates);
}

/**
 * The soonest moment this model can retry, in whole seconds, given its own
 * cooldowns. Returns null when the model has no live cooldown at all.
 *
 * @param {unknown} modelId
 * @param {Array<object>} keys
 * @param {{ now?: number }} [options]
 * @returns {number | null}
 */
export function getModelCooldownRemainingSeconds(modelId, keys, options = {}) {
    ensureLoaded();
    if (!isNonEmptyString(modelId)) return null;
    const now = clockOf(options);
    const pool = Array.isArray(keys) ? keys : [];
    const untils = [];
    for (const key of pool) {
        if (!isGloballyAvailable(key, now)) continue;
        const entry = cooldowns.get(pairKey(modelId, key?.id));
        if (!entry) continue;
        if (now - entry.at > ttlMs) continue;
        if (entry.until > now) untils.push(entry.until);
    }
    if (untils.length === 0) return null;
    return Math.max(1, Math.ceil((Math.min(...untils) - now) / 1000));
}

function evictOldest(map, limit) {
    const ordered = [...map.entries()].sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0));
    for (const [mapKey] of ordered.slice(0, Math.max(0, map.size - limit))) map.delete(mapKey);
}

/**
 * Drop every assignment and cooldown whose memory has decayed past the TTL.
 *
 * @param {{ now?: number }} [options]
 * @returns {{ assignments: number, cooldowns: number }} Counts removed.
 */
export function pruneExpired(options = {}) {
    ensureLoaded();
    const now = clockOf(options);
    let removedAssignments = 0;
    let removedCooldowns = 0;
    for (const [model, entry] of [...assignments]) {
        if (now - entry.at > ttlMs) { assignments.delete(model); removedAssignments++; }
    }
    for (const [pair, entry] of [...cooldowns]) {
        if (now - entry.at > ttlMs || entry.until <= now) { cooldowns.delete(pair); removedCooldowns++; }
    }
    return { assignments: removedAssignments, cooldowns: removedCooldowns };
}

/**
 * Plain-object view of the map, for tests and diagnostics.
 * @returns {{ assignments: Record<string, object>, cooldowns: Record<string, object> }}
 */
export function snapshotAffinity() {
    ensureLoaded();
    return {
        assignments: Object.fromEntries(assignments),
        cooldowns: Object.fromEntries(cooldowns)
    };
}

/**
 * Reset all routing state. Used by tests and at gateway-child startup; the next
 * access re-loads from disk, which is exactly what a process restart does.
 * Pass `cachePath: null` for memory-only routing.
 *
 * @param {{ cachePath?: string | null, ttlMs?: number, persistDebounceMs?: number }} [overrides]
 * @returns {void}
 */
export function resetAffinityState(overrides = {}) {
    // Drop any armed timer WITHOUT writing: the state it would have persisted is
    // being discarded on the next line, so writing it would be meaningless — and
    // a surviving timer would fire against freshly reset state.
    closeAffinityPersistence();
    persistPending = false;
    assignments.clear();
    cooldowns.clear();
    ttlMs = Number.isSafeInteger(overrides.ttlMs) && overrides.ttlMs > 0 ? overrides.ttlMs : AFFINITY_TTL_MS;
    persistDebounceMs = Number.isSafeInteger(overrides.persistDebounceMs) && overrides.persistDebounceMs > 0
        ? overrides.persistDebounceMs
        : AFFINITY_PERSIST_DEBOUNCE_MS;
    state = {
        // Explicit null ⇒ memory-only; undefined ⇒ derive from env once.
        cachePath: overrides.cachePath !== undefined ? overrides.cachePath : resolveAffinityCachePath(),
        loaded: false
    };
}
