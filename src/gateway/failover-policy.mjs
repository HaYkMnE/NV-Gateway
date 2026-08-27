export const MIN_RETRY_AFTER_SECONDS = 1;
export const MAX_RETRY_AFTER_SECONDS = 300;
const RETRYABLE = new Set([401, 403, 429, 500, 502, 503, 504, 529]);

export function resolveMaxFailoverAttempts(env = process.env, poolCount = 0) {
    const fallback = Number.isInteger(poolCount) && poolCount > 0 ? Math.max(3, poolCount) : 3;
    const raw = env?.GATEWAY_MAX_FAILOVER_ATTEMPTS;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return fallback;
    const value = Number(raw);
    return value >= 1 && value <= 8 ? value : fallback;
}

export function classifyUpstreamStatus(statusCode) {
    return { success: Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300, retryable: RETRYABLE.has(statusCode) };
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
