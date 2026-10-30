import { parseRetryAfter } from "./failover-policy.mjs";

// Round B B3: the hop-by-hop deny list (`HOP_BY_HOP_HEADERS`) and its
// `sanitizeProxyHeaders()` helper were removed. They were the old
// deny-list-style header hygiene, superseded by the explicit
// UPSTREAM_REQUEST_HEADER_ALLOWLIST below: the upstream request is now built
// from the allowlist only, so no client header can reach upstream by default
// and there is nothing left to strip. Zero call sites remained.

export const UPSTREAM_REQUEST_HEADER_ALLOWLIST = ["accept", "content-type"];

export function buildUpstreamRequestHeaders(clientHeaders, { authorization, contentLength } = {}) {
    const source = clientHeaders && typeof clientHeaders === "object" ? clientHeaders : {};
    const headers = {};
    for (const name of UPSTREAM_REQUEST_HEADER_ALLOWLIST) {
        const value = source[name];
        if (typeof value === "string" || Array.isArray(value)) headers[name] = value;
    }
    if (Number.isSafeInteger(contentLength) && contentLength >= 0) {
        headers["content-length"] = String(contentLength);
    }
    return {
        ...headers,
        host: "integrate.api.nvidia.com",
        authorization,
        "HTTP-Referer": "https://opencode.ai/",
        "X-Title": "opencode",
        "X-BILLING-INVOKE-ORIGIN": "OpenCode"
    };
}

export const MAX_RESPONSE_RETRY_AFTER_SECONDS = 20;

export function capResponseHeaders(headers, maxRetryAfterSeconds = MAX_RESPONSE_RETRY_AFTER_SECONDS) {
    if (!headers || typeof headers !== "object") return headers;
    const result = { ...headers };
    for (const key of Object.keys(result)) {
        if (key.toLowerCase() === "retry-after") {
            const raw = result[key];
            const parsed = parseRetryAfter(raw);
            const capped = parsed !== null ? Math.min(maxRetryAfterSeconds, parsed) : maxRetryAfterSeconds;
            result[key] = String(capped);
        }
    }
    return result;
}
