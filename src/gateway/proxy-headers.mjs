import { parseRetryAfter } from "./failover-policy.mjs";

export const HOP_BY_HOP_HEADERS = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "expect",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer"
];

export function sanitizeProxyHeaders(headers) {
    for (const header of HOP_BY_HOP_HEADERS) {
        delete headers[header];
    }
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
