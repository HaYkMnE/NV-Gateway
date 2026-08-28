export const MIN_RETRY_AFTER_SECONDS = 1;
export const MAX_RETRY_AFTER_SECONDS = 300;
const RETRYABLE = new Set([401, 403, 429, 500, 502, 503, 504, 529]);

/**
 * Resolve the maximum number of per-request failover attempts.
 *
 * Precedence (highest first):
 *  1. Operator env override `GATEWAY_MAX_FAILOVER_ATTEMPTS` — an explicit,
 *     bounded (1..8) override that is authoritative when valid.
 *  2. A configured bound (`configuredMax`) — the value derived from the app
 *     config (global `performanceMode` profile or a per-model
 *     `maxFailoverAttempts`). Only honored when provided; when absent the
 *     gateway falls back to covering the active pool (the pre-config default).
 *  3. Pool-derived fallback — at least 3 attempts, otherwise one attempt per
 *     active key, so a modest pool still exhausts its distinct keys.
 *
 * @param {Record<string, string|undefined>|NodeJS.ProcessEnv} [env] Environment (for the override knob).
 * @param {number} [poolCount] Number of active keys.
 * @param {number|undefined} [configuredMax] Config-derived bound (per-model or profile).
 * @returns {number}
 */
export function resolveMaxFailoverAttempts(env = process.env, poolCount = 0, configuredMax = undefined) {
    const raw = env?.GATEWAY_MAX_FAILOVER_ATTEMPTS;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) {
        const value = Number(raw);
        if (value >= 1 && value <= 8) return value;
    }
    if (Number.isSafeInteger(configuredMax) && configuredMax >= 1) return configuredMax;
    return Number.isInteger(poolCount) && poolCount > 0 ? Math.max(3, poolCount) : 3;
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
// Uniform-429 early stop
//
// A 429 from NVIDIA is MODEL-SCOPED, not key-scoped. Live evidence: the same 15
// pool keys (15 independent accounts) serve one model with HTTP 200 in the very
// same second they all answer 429 for another model, and a direct key outside
// the pool also answers 429 for that model. Walking the whole pool on a 429
// therefore CANNOT succeed — it only spends wall-clock (~350ms per attempt) and
// multiplies upstream load on the very limit being hit.
//
// So a small number of CONFIRMING attempts is enough: once N independent keys
// have each answered 429, the verdict is established and the honest 429 goes
// back to the client with OUR OWN Retry-After (NVIDIA supplies none). Every
// OTHER retryable status keeps the full per-key failover, because those
// genuinely can succeed on a different key.
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
 * Resolve how many uniform-429 attempts are made before the honest 429 is returned.
 *
 * Precedence mirrors {@link resolveMaxFailoverAttempts}:
 *  1. Operator env override `GATEWAY_RATE_LIMIT_MAX_ATTEMPTS`.
 *  2. A configured bound (`configuredMax`) — per-model
 *     `perModelSettings.<id>.rateLimitMaxAttempts`.
 *  3. {@link DEFAULT_RATE_LIMIT_MAX_ATTEMPTS} (2).
 *
 * Unlike resolveMaxFailoverAttempts — which REJECTS an out-of-range env value and
 * falls through — both override sources here are CLAMPED into
 * 1..{@link MAX_RATE_LIMIT_MAX_ATTEMPTS}. The ceiling exists because a larger
 * value cannot help (see the module note above), so an operator asking for 9 is
 * given the largest still-defensible value instead of being silently ignored.
 * Non-numeric / malformed values are not a bound at all and fall through.
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
 * Whether the recorded upstream failures already establish a UNIFORM rate-limit
 * verdict, so no further key may be tried.
 *
 * True only when at least `maxAttempts` REAL upstream failures were recorded and
 * EVERY one of them was a {@link RATE_LIMIT_STATUS}. A single non-429 in the
 * history means the pool is not uniformly rate-limited, so normal per-key
 * failover must continue — a different key can still succeed on a 5xx.
 *
 * Gateway-side synthetic failures (timeouts, socket hang-ups, SSE errors) are
 * never recorded by the caller, so they neither satisfy nor poison this verdict.
 *
 * @param {number[]} seenFailedStatuses Retryable upstream HTTP statuses, in order.
 * @param {number} maxAttempts Confirming attempts required (see {@link resolveRateLimitMaxAttempts}).
 * @returns {boolean}
 */
export function shouldEarlyStopOnRateLimit(seenFailedStatuses, maxAttempts) {
    if (!Array.isArray(seenFailedStatuses) || seenFailedStatuses.length === 0) return false;
    const required = clampRateLimitAttempts(maxAttempts) ?? DEFAULT_RATE_LIMIT_MAX_ATTEMPTS;
    if (seenFailedStatuses.length < required) return false;
    return seenFailedStatuses.every((status) => status === RATE_LIMIT_STATUS);
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
