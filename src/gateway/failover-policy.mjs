export const MIN_RETRY_AFTER_SECONDS = 1;
export const MAX_RETRY_AFTER_SECONDS = 300;
// The requested retry budget from config/env is capped at 64. Independently,
// eligible-pool coverage may raise the effective attempt count above 64, up to
// the product's MAX_KEYS=1,000 pool limit, so the cap never truncates a full
// circular pass through keys this request may use.
export const MAX_CONFIGURED_FAILOVER_ATTEMPTS = 64;
const RETRYABLE = new Set([401, 403, 429, 500, 502, 503, 504, 529]);

/**
 * Resolve the maximum number of per-request failover attempts.
 *
 * Precedence (highest first):
 *  1. COVERAGE FLOOR — owner's rule: rotation is circular across the whole
 *     pool, so the attempt budget must never be below the number of DISTINCT
 *     keys this request may use (`minimumCoverage`, normally the model's
 *     eligible-key snapshot; falls back to the active pool count). An env
 *     override or config cap BELOW that number is raised to it.
 *  2. Operator env override `GATEWAY_MAX_FAILOVER_ATTEMPTS` — bounded
 *     (1..MAX_CONFIGURED_FAILOVER_ATTEMPTS);
 *     controls the budget only when it is at or above the coverage floor.
 *  3. A configured bound (`configuredMax`) — app config value (global
 *     `performanceMode` profile or per-model `maxFailoverAttempts`), likewise
 *     only at/above the floor.
 *  4. Pool-derived fallback — at least 3 attempts, otherwise one attempt per
 *     active key.
 *
 * @param {Record<string, string|undefined>|NodeJS.ProcessEnv} [env] Environment (for the override knob).
 * @param {number} [poolCount] Number of active keys.
 * @param {number|undefined} [configuredMax] Config-derived bound (per-model or profile).
 * @param {number} [minimumCoverage] Distinct keys this request may use (eligible snapshot).
 * @returns {number}
 */
export function resolveMaxFailoverAttempts(env = process.env, poolCount = 0, configuredMax = undefined, minimumCoverage = undefined) {
    let base;
    const raw = env?.GATEWAY_MAX_FAILOVER_ATTEMPTS;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) {
        const value = Number(raw);
        if (Number.isSafeInteger(value) && value >= 1) base = Math.min(value, MAX_CONFIGURED_FAILOVER_ATTEMPTS);
    }
    if (base === undefined && Number.isSafeInteger(configuredMax) && configuredMax >= 1) {
        base = Math.min(configuredMax, MAX_CONFIGURED_FAILOVER_ATTEMPTS);
    }
    if (base === undefined) base = Number.isInteger(poolCount) && poolCount > 0 ? Math.max(3, poolCount) : 3;
    const coverage = Number.isSafeInteger(minimumCoverage) && minimumCoverage >= 1
        ? minimumCoverage
        : Number.isInteger(poolCount) && poolCount > 0 ? poolCount : 1;
    return Math.max(base, coverage);
}

export function classifyUpstreamStatus(statusCode) {
    return { success: Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300, retryable: RETRYABLE.has(statusCode) };
}

// Statuses that can legitimately describe the WHOLE pool rather than one key.
// A quota/capacity/upstream-fault answer is a property of the upstream service
// (or of every key's quota), so seeing it from every attempted key is real
// evidence the pool is uniformly affected and the status should be propagated.
const POOL_WIDE_CAPABLE = new Set([429, 500, 502, 503, 504, 529]);

/**
 * Whether a repeated upstream status may be treated as a POOL-WIDE verdict.
 *
 * Deliberately excludes per-key signals even though they are retryable:
 *  - 401 / 403 — a credential verdict about ONE key. Several bad keys in a row
 *    is a key-management problem, never an upstream outage, and must not be
 *    reported to the client as the upstream's answer.
 *  - 404 — an NVCF dispatch failure is per-credential entitlement (see
 *    {@link isNvcfDispatchFailure}); a non-NVCF 404 is already non-retryable
 *    and passes straight through, so it never reaches this path.
 *
 * @param {number} statusCode Upstream HTTP status.
 * @returns {boolean}
 */
export function isPoolWideCapableStatus(statusCode) {
    return POOL_WIDE_CAPABLE.has(statusCode);
}

/**
 * Resolve a POOL-WIDE upstream failure verdict from the recorded attempt history.
 *
 * Returns the status to propagate (instead of a generic 502) only when ALL of:
 *   1. at least one real upstream HTTP failure was recorded;
 *   2. every recorded failure carried the SAME status;
 *   3. that status can describe the whole pool (429/5xx — see
 *      {@link isPoolWideCapableStatus});
 *   4. enough DISTINCT keys were tried to cover the reachable portion of the
 *      pool, i.e. min(maxAttempts, activeCount).
 *
 * Point (4) is the crux: when a configured `maxFailoverAttempts` (e.g. the
 * performance "day" profile's 3) is smaller than the active pool (e.g. 15), the
 * attempt budget can never cover all active keys, so a coverage test against
 * `activeCount` alone would never fire and a uniformly rate-limited pool would
 * be misreported as a generic 502. Bounding coverage by the attempt budget lets
 * the honest upstream status surface.
 *
 * @param {number[]} seenFailedStatuses      Retryable upstream HTTP statuses, in order.
 * @param {number}   attemptedDistinctKeys   Number of distinct keys tried.
 * @param {number}   maxAttempts             The effective per-request attempt budget.
 * @param {number}   activeCount             Number of active keys in the pool.
 * @returns {number|null}                    The pool-wide status, or null.
 */
export function resolvePoolWideFailureStatus(seenFailedStatuses, attemptedDistinctKeys, maxAttempts, activeCount) {
    if (!Array.isArray(seenFailedStatuses) || seenFailedStatuses.length === 0) return null;
    const first = seenFailedStatuses[0];
    if (!seenFailedStatuses.every((s) => s === first)) return null;
    if (!isPoolWideCapableStatus(first)) return null;
    const reachable = Number.isInteger(maxAttempts) && maxAttempts > 0 ? Math.min(maxAttempts, activeCount) : activeCount;
    const covered = activeCount > 0 ? attemptedDistinctKeys >= reachable : true;
    if (!covered) return null;
    return first;
}

// ───────────────────────────────────────────────────────────────────────────
// Uniform-429 stop rule (owner-decided, circular coverage)
//
// A model-scoped 429 is only the POOL-WIDE verdict once every key the model may
// use has actually answered 429 in THIS request. Until that coverage is complete
// the loop keeps rotating: a 429 from key A proves nothing about key B, and the
// client's request must land on whichever key is still healthy. The verdict is
// therefore gated on DISTINCT KEYS ATTEMPTED reaching the eligible-key snapshot.
//
// Historical note: an earlier iteration short-circuited after 2 confirming 429s
// based on "Live evidence" that every model answers 429 across keys; the owner
// overruled that as too eager (the user's request died while healthy keys were
// never tried). The confirming-count floor survives for pool-agnostic callers.
// ───────────────────────────────────────────────────────────────────────────

export const RATE_LIMIT_STATUS = 429;
export const MIN_RATE_LIMIT_MAX_ATTEMPTS = 1;
export const MAX_RATE_LIMIT_MAX_ATTEMPTS = 3;
export const DEFAULT_RATE_LIMIT_MAX_ATTEMPTS = 2;

function clampRateLimitAttempts(value) {
    if (!Number.isSafeInteger(value)) return null;
    return Math.min(MAX_RATE_LIMIT_MAX_ATTEMPTS, Math.max(MIN_RATE_LIMIT_MAX_ATTEMPTS, value));
}

/**
 * Resolve the minimum number of uniform-429 confirmations before the honest 429
 * is returned — for callers that cannot supply pool coverage. Server-side the
 * circular-coverage gate dominates; see {@link shouldEarlyStopOnRateLimit}.
 *
 * @param {Record<string, string|undefined>|NodeJS.ProcessEnv} [env] Environment (for the override knob).
 * @param {number|undefined} [configuredMax] Config-derived per-model bound.
 * @returns {number} An integer in 1..3.
 */
export function resolveRateLimitMaxAttempts(env = process.env, configuredMax = undefined) {
    const raw = env?.GATEWAY_RATE_LIMIT_MAX_ATTEMPTS;
    if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
        const clamped = clampRateLimitAttempts(Number(raw.trim()));
        if (clamped !== null) return clamped;
    }
    const configured = clampRateLimitAttempts(configuredMax);
    if (configured !== null) return configured;
    return DEFAULT_RATE_LIMIT_MAX_ATTEMPTS;
}

/**
 * Whether the recorded upstream failures establish a UNIFORM rate-limit verdict
 * covering the whole eligible pool for THIS request.
 *
 * Fires only when EVERY recorded real failure is 429 AND the number of DISTINCT
 * keys attempted meets the eligible snapshot — i.e. every key the model may use
 * has genuinely answered 429. Anything less means an untried key might still
 * succeed and the failover loop must continue. When pool information is absent
 * (legacy callers), the confirming-count floor is the rule.
 *
 * Gateway-side synthetic failures (timeouts, socket hang-ups, SSE errors) are
 * never recorded by the caller, so they neither satisfy nor poison the verdict.
 *
 * @param {number[]} seenFailedStatuses Retryable upstream HTTP statuses, in order.
 * @param {number} maxAttempts Minimum confirming attempts (see {@link resolveRateLimitMaxAttempts}).
 * @param {number} [eligibleKeyCount] Keys the requested model may use (snapshot at request start).
 * @param {number} [attemptedDistinctKeys] Distinct keys actually tried.
 * @returns {boolean}
 */
export function shouldEarlyStopOnRateLimit(seenFailedStatuses, maxAttempts, eligibleKeyCount, attemptedDistinctKeys) {
    if (!Array.isArray(seenFailedStatuses) || seenFailedStatuses.length === 0) return false;
    if (!seenFailedStatuses.every((status) => status === RATE_LIMIT_STATUS)) return false;
    // Coverage gate: only "every eligible key answered 429" is a verdict.
    if (Number.isSafeInteger(eligibleKeyCount) && eligibleKeyCount > 0 && Number.isSafeInteger(attemptedDistinctKeys)) {
        return attemptedDistinctKeys >= eligibleKeyCount;
    }
    // Legacy floor for pool-agnostic callers.
    const minimumConfirmations = clampRateLimitAttempts(maxAttempts) ?? DEFAULT_RATE_LIMIT_MAX_ATTEMPTS;
    return seenFailedStatuses.length >= minimumConfirmations;
}

/**
 * Detect an NVCF function-dispatch failure that surfaces as HTTP 404.
 *
 * NVIDIA's upstream returns two structurally different 404s:
 *
 *  1. Unknown / unroutable model id — answered by the API frontend before any
 *     function dispatch: `content-type: text/plain`, body `404 page not found`,
 *     and NO `nvcf-*` headers. This is a permanent client error: every key in
 *     the pool will get the same answer, so it must NOT be retried.
 *
 *  2. A real model whose NVCF function invocation failed for THIS credential
 *     (missing entitlement to the function, or no function version available to
 *     it): the response carries `nvcf-reqid` and `nvcf-status: errored` with an
 *     empty body. The request was routed, so the model exists — only this key
 *     could not invoke it. Another key in the pool can succeed, therefore this
 *     is retryable.
 *
 * Keyed on the presence of the `nvcf-status`/`nvcf-reqid` markers, which only
 * appear once the request has reached function dispatch.
 *
 * @param {number} statusCode Upstream HTTP status.
 * @param {Record<string, string|string[]>} [headers] Upstream response headers.
 * @returns {boolean} True when the 404 is a per-key dispatch failure.
 */
export function isNvcfDispatchFailure(statusCode, headers) {
    if (statusCode !== 404) return false;
    if (!headers || typeof headers !== 'object') return false;
    const status = headers['nvcf-status'] ?? headers['NVCF-Status'];
    const reqId = headers['nvcf-reqid'] ?? headers['NVCF-ReqId'];
    return Boolean(status) || Boolean(reqId);
}

/**
 * Header-aware retry classification.
 *
 * Identical to {@link classifyUpstreamStatus} for every status except an NVCF
 * dispatch-failure 404 (see {@link isNvcfDispatchFailure}), which is retryable.
 *
 * @param {number} statusCode Upstream HTTP status.
 * @param {Record<string, string|string[]>} [headers] Upstream response headers.
 * @returns {{ success: boolean, retryable: boolean }}
 */
export function classifyUpstreamResponse(statusCode, headers) {
    const base = classifyUpstreamStatus(statusCode);
    if (base.success || base.retryable) return base;
    if (isNvcfDispatchFailure(statusCode, headers)) {
        return { success: false, retryable: true };
    }
    return base;
}

export function isSuccessfulStatus(statusCode) {
    return classifyUpstreamStatus(statusCode).success;
}

export function parseRetryAfter(value, now = Date.now()) {
    if (Array.isArray(value)) value = value[0];
    let seconds;
    if (typeof value === 'number' && Number.isFinite(value)) {
        seconds = Math.ceil(value);
    } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
        seconds = Number(value.trim());
    } else if (typeof value === 'string') {
        const timestamp = Date.parse(value);
        if (Number.isFinite(timestamp)) seconds = Math.ceil((timestamp - now) / 1000);
    }
    if (!Number.isFinite(seconds)) return null;
    return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(MIN_RETRY_AFTER_SECONDS, seconds));
}
