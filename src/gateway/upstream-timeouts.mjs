export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 300_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
// Keep configurable timeouts below Node's 2,147,483,647 ms timer limit.
export const MAX_UPSTREAM_TIMEOUT_MS = 1_800_000;
export const DEFAULT_MAX_STREAM_DURATION_MS = 1_800_000;
export const MIN_STREAM_DURATION_MS = 300_000;
export const MAX_STREAM_DURATION_MS = 3_600_000;

// A RETRIED failover attempt (attempt > 1 after a 429/5xx) is not a fresh
// request — NVIDIA has just signalled trouble on the pool — so the wall time
// we are willing to wait for a first byte on a retry is capped well below the
// fresh-request default (5 min in "day" mode). This bounds the per-key switch
// delay: a hung or slow-to-429 upstream cannot stall failover for the full
// first-byte window on every retry. Default 30s (configurable via env). See
// resolveRetryFirstByteTimeoutMs below for the precise clamp semantics.
export const DEFAULT_RETRY_FIRST_BYTE_TIMEOUT_MS = 30_000;

function parsePositiveInteger(value, fallback) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        return fallback;
    }

    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_UPSTREAM_TIMEOUT_MS
        ? parsed
        : fallback;
}

function parseStreamDurationMs(value, fallback) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        return fallback;
    }

    const parsed = Number(value);
    return Number.isSafeInteger(parsed)
        ? Math.min(MAX_STREAM_DURATION_MS, Math.max(MIN_STREAM_DURATION_MS, parsed))
        : fallback;
}

export function resolveGatewayTimeouts(environment = process.env) {
    return {
        firstByteTimeoutMs: parsePositiveInteger(
            environment.GATEWAY_FIRST_BYTE_TIMEOUT_MS,
            DEFAULT_FIRST_BYTE_TIMEOUT_MS
        ),
        idleTimeoutMs: parsePositiveInteger(
            environment.GATEWAY_IDLE_TIMEOUT_MS,
            DEFAULT_IDLE_TIMEOUT_MS
        ),
        maxStreamDurationMs: parseStreamDurationMs(
            environment.GATEWAY_MAX_STREAM_DURATION_MS,
            DEFAULT_MAX_STREAM_DURATION_MS
        )
    };
}

// The first-byte timeout to apply to a RETRY attempt (attempt > 1 in the
// failover loop). It must NEVER exceed the fresh-request first-byte timeout
// (a retry should never tolerate more than a fresh request) and additionally
// is bounded by GATEWAY_RETRY_FIRST_BYTE_TIMEOUT_MS (default 30s). The min()
// clamp means: when tests set a tiny GATEWAY_FIRST_BYTE_TIMEOUT_MS, retries
// stay tiny too (no slowdown); in production with the 5-min fresh default,
// retries collapse to a 30s ceiling — exactly the "shorter for retries" rule.
export function resolveRetryFirstByteTimeoutMs(firstByteTimeoutMs, environment = process.env) {
    const override = parsePositiveInteger(
        environment?.GATEWAY_RETRY_FIRST_BYTE_TIMEOUT_MS,
        DEFAULT_RETRY_FIRST_BYTE_TIMEOUT_MS
    );
    return Math.min(firstByteTimeoutMs, override);
}

export function createUpstreamSocketTimeouts({ firstByteTimeoutMs, idleTimeoutMs, onTimeout }) {
    let socket;
    let firstByteReceived = false;

    return {
        attach(nextSocket) {
            socket = nextSocket;
            socket.setTimeout(firstByteTimeoutMs);
            socket.on("timeout", () => onTimeout(firstByteReceived));
        },
        markFirstByteReceived() {
            firstByteReceived = true;
            socket?.setTimeout(idleTimeoutMs);
        }
    };
}
