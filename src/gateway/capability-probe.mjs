// @ts-check
/**
 * REAL reasoning-capability discovery for the NV-Gateway.
 *
 * The static {@link module:capability-registry} advertises reasoning modes per
 * model FAMILY (a curated guess). This module discovers what the upstream key
 * ACTUALLY accepts for a specific model ID:
 *
 *   1. LISTING (1 request): send a minimal chat completion with
 *      `reasoning_effort: "bogus_probe"`. A 400 validation error usually LISTS
 *      the allowed values in its message — parse them out.
 *   2. VERIFICATION: live upstreams enforce that listing at DESERIALIZATION
 *      time as an endpoint-level enum union, but may still reject individual
 *      variants per model at execution time (observed on moonshotai/kimi-k3).
 *      Every listed value is confirmed with a small request (max_tokens=64 —
 *      thinking models degenerate at 1 token): 2xx = accepted, 400/422 with a
 *      reasoning_effort VALIDATION error = rejected. ANY other 4xx/5xx/timeout
 *      during per-value verification ⇒ INCONCLUSIVE: the value STAYS LISTED
 *      with evidence (strict classification discipline — transient failures
 *      must never erase known-good modes).
 *   3. FALLBACK PATH: when no listing can be parsed, probe the full candidate
 *      set [low, medium, high, xhigh, max, none, off, minimal] the same way.
 *
 * A failing/ambiguous SENTINEL request (401/403/429/5xx/network) still makes
 * the whole probe inconclusive → return null so callers fall back to the
 * static family patterns. Per-VALUE failures no longer abort: they are
 * recorded as INCONCLUSIVE evidence instead (see probeCandidatesIndividually).
 * A failed probe NEVER breaks /v1/models.
 *
 * Results are cached in gateway state `{ model: { modes, defaultMode, ...,
 * probedAt, source, verification, rejectedOnce? } }` with a 24h TTL (+ force-
 * refresh), persisted to a JSON file next to the existing state files (same
 * APPDATA dir the gateway already uses) so restarts keep the cache (format
 * version 2; v1 files are migrated). DROPPING a previously-verified mode
 * requires two consecutive adverse probes (hysteresis via `rejectedOnce`).
 * One probe runs per model at a time (in-flight dedup).
 *
 * Style notes (mirrors direct-glm-probe.mjs / model-discovery.mjs):
 *   - NO hard dependency on logger.mjs (which throws without GATEWAY_LOG_PATH);
 *     log outcomes are handed to an injected `logger` callback instead.
 *   - Upstream requests go through node:https so the test preload
 *     (tests/local-upstream-preload.cjs) can redirect them to a local fake.
 *
 * Environment variables:
 * - GATEWAY_CAPABILITY_CACHE_PATH       — explicit cache file path override
 * - GATEWAY_CAPABILITY_PROBE_TTL_MS     — cache TTL in ms (default 24h)
 * - GATEWAY_CAPABILITY_PROBE_TIMEOUT_MS — per-request timeout (default 15s)
 * - GATEWAY_CAPABILITY_PROBE_MAX_PER_SWEEP    — models probed per sweep (default 25)
 * - GATEWAY_CAPABILITY_PROBE_DISABLE=1  — opt-out of background scheduling
 * - GATEWAY_CAPABILITY_PROBE_ENABLE=1   — force-enable even under the test
 *                                         sentinel (wins over DISABLE too)
 *
 * @module capability-probe
 */

import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { redact } from "../shared/redaction.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NVIDIA_API_HOST = "integrate.api.nvidia.com";
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

/** Value sent to provoke a listing validation error. Never a real mode. */
export const PROBE_SENTINEL = "bogus_probe";

/** Candidate effort values tried individually when the fast path fails. */
export const PROBE_CANDIDATES = Object.freeze([
    "low", "medium", "high", "xhigh", "max", "none", "off", "minimal"
]);

/**
 * Verification probes use 64 completion tokens: thinking models degenerate at
 * max_tokens=1 (empty/degenerate completions caused unstable classifications
 * between sweeps — see the 2026-08 stability audit).
 */
export const PROBE_VERIFY_MAX_TOKENS = 64;

/** Canonical display order for discovered modes (ascending effort). */
const CANONICAL_ORDER = Object.freeze([
    "none", "off", "minimal", "low", "medium", "high", "xhigh", "max"
]);

/**
 * Keyword windows shared by the listing parser and the rejection classifier:
 * text right after one of these phrases is high-signal enum territory.
 * Stored as a SOURCE string (not a /g regex) so every consumer builds a fresh
 * RegExp — a reused /g regex keeps `lastIndex` state between `.test()` calls.
 */
const LISTING_KEYWORD_WINDOW_SOURCE = "(?:\\bsupported\\s+values?\\s*(?:are|include)?|\\ballowed\\s+values?(?:\\s*are)?|\\bvalid\\s+values?(?:\\s*are)?|\\bmust\\s+be\\s+(?:one\\s+of|among)|\\bshould\\s+(?:be\\s+)?(?:one\\s+of|among)|\\bexpected\\s+(?:one\\s+of|among)|\\bone\\s+of)\\s*[:\\-]?\\s*([^.;\\n]*)";

/** Effort-shaped values that make a parsed listing plausibly about reasoning_effort. */
const EFFORT_LIKE_VALUES = new Set(Object.freeze([...PROBE_CANDIDATES, "on"]));

/** HTTP statuses allowed to carry a validation rejection. */
const REJECT_STATUSES = new Set(Object.freeze([400, 422]));

/** Current persistent-cache payload format. Bumped by the stability audit: v2 adds per-mode verification evidence + rejectedOnce hysteresis stamps. v1 files are migrated (entries preserved as-is). */
const CACHE_FORMAT_VERSION = 2;

/** Default cache TTL: 24 hours. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Default per-request timeout for a single probe call (GATEWAY_CAPABILITY_PROBE_TIMEOUT_MS overrides — matches the module docblock). */
const DEFAULT_PROBE_TIMEOUT_MS = positiveIntEnv(process.env.GATEWAY_CAPABILITY_PROBE_TIMEOUT_MS, 15_000);

/** Minimum delay between background sweeps triggered by /v1/models traffic. */
const SWEEP_COOLDOWN_MS = 10 * 60 * 1000;

/** Cache file name used when derived from the gateway's APPDATA state dir. */
const CACHE_FILENAME = "reasoning-capabilities.json";

/** Max bytes read from any single upstream probe response body. */
const MAX_RESPONSE_BYTES = 256 * 1024;

/** Quoted tokens that appear in error messages but are never enum values. */
const NON_ENUM_TOKENS = new Set(Object.freeze([
    "error", "invalid", "unsupported", "expected", "received", "message",
    "value", "values", "type", "string", "integer", "boolean", "null",
    "input", "parameter", "param", "field", "request", "response",
    "server", "client", "api", "key", "token", "reasoning", "effort",
    "reasoning_effort", "chat_template_kwargs", "thinking",
    "enable_thinking", "thinking_mode", "model", "stream", "max_tokens",
    "user", "assistant", "system", "tool"
]));

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * Extract allowed enum values from an upstream validation-error message.
 *
 * Recognizes shapes like:
 *   "Invalid value: 'bogus_probe'. Supported values are: 'low', 'medium'."
 *   "reasoning_effort must be one of ['low','medium','high']"
 *   "Input should be 'low', 'medium' or 'high'"
 *
 * The sentinel value itself (and any token in `sentinels`) is excluded, as are
 * common non-enum words. Order follows the message (canonicalized later).
 *
 * @param {unknown} message Raw error message text (string expected).
 * @param {{ sentinels?: string[] }} [options]
 * @returns {string[]} Lowercased unique values, message order.
 */
export function parseAllowedValuesFromError(message, options = {}) {
    if (typeof message !== "string" || message.length === 0) return [];
    const exclude = new Set([PROBE_SENTINEL]);
    for (const s of Array.isArray(options.sentinels) ? options.sentinels : []) {
        if (typeof s === "string") exclude.add(s.toLowerCase());
    }

    const push = (value, into) => {
        const v = String(value).trim().toLowerCase();
        if (!v || v.length > 32) return;
        if (!/^[a-z][a-z0-9_-]*$/.test(v)) return;
        if (exclude.has(v) || NON_ENUM_TOKENS.has(v)) return;
        if (!into.includes(v)) into.push(v);
    };

    // Stage 1 — keyword windows: text right after "supported values are:",
    // "must be one of", "one of", … is high-signal; take quoted tokens from it.
    // \b anchors keep "Invalid value" from matching the `valid values` keyword.
    // Built from the shared SOURCE each call: a reused /g regex keeps
    // `lastIndex` state between calls — a classic .matchAll bug.
    const windowRe = new RegExp(LISTING_KEYWORD_WINDOW_SOURCE, "gi");
    const stage1 = [];
    for (const m of message.matchAll(windowRe)) {
        for (const tok of m[1].matchAll(/['"`]([A-Za-z][A-Za-z0-9_-]*)['"`]/g)) {
            push(tok[1], stage1);
        }
    }
    if (stage1.length > 0) return stage1;

    // Stage 2 — no keyword window matched: fall back to every quoted lowercase
    // token in the message minus stoplist/sentinels. Conservative but catches
    // terse messages like "invalid reasoning_effort: got 'bogus_probe', want low/high/max".
    const stage2 = [];
    for (const tok of message.matchAll(/['"`]([A-Za-z][A-Za-z0-9_-]*)['"`]/g)) {
        push(tok[1], stage2);
    }
    return stage2;
}

/**
 * Reorder raw discovered values into canonical ascending-effort order; unknown
 * values keep their relative order at the end. Deduplicates (case-insensitive,
 * lowercased output).
 * @param {unknown} values
 * @returns {string[]}
 */
export function normalizeDiscoveredModes(values) {
    if (!Array.isArray(values)) return [];
    const seen = new Set();
    const unique = [];
    for (const v of values) {
        if (typeof v !== "string") continue;
        const lowered = v.trim().toLowerCase();
        if (!lowered || seen.has(lowered)) continue;
        seen.add(lowered);
        unique.push(lowered);
    }
    const rank = (m) => {
        const idx = CANONICAL_ORDER.indexOf(m);
        return idx === -1 ? CANONICAL_ORDER.length : idx;
    };
    return unique
        .map((m, i) => ({ m, i }))
        .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
        .map((e) => e.m);
}

/**
 * Pick the advertised default mode from a discovered mode list:
 * prefer "high" (sane strong default), else the highest listed mode.
 * @param {string[]} modes Non-empty normalized mode list.
 * @returns {string}
 */
export function pickDefaultMode(modes) {
    if (!Array.isArray(modes) || modes.length === 0) return null;
    if (modes.includes("high")) return "high";
    return modes[modes.length - 1];
}

/**
 * Build the minimal chat-completions body used for probing.
 * @param {string} model Model ID.
 * @param {string} effortValue reasoning_effort to test ("bogus_probe" or a candidate).
 * @returns {string} Serialized JSON body.
 */
export function buildProbeBody(model, effortValue) {
    return JSON.stringify({
        model,
        stream: false,
        max_tokens: PROBE_VERIFY_MAX_TOKENS,
        messages: [{ role: "user", content: "ok" }],
        reasoning_effort: effortValue
    });
}

// ---------------------------------------------------------------------------
// Upstream request plumbing (node:https — redirectable by tests/local-upstream-preload.cjs)
// ---------------------------------------------------------------------------

function httpsJsonPost({ apiKey, body, timeoutMs }) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: NVIDIA_API_HOST,
            port: 443,
            path: CHAT_COMPLETIONS_PATH,
            method: "POST",
            agent: false, // match proxyRequest: no connection pooling
            headers: {
                "content-type": "application/json",
                "accept": "application/json",
                "authorization": "Bearer " + apiKey,
                "HTTP-Referer": "https://opencode.ai/",
                "X-Title": "opencode",
                "X-BILLING-INVOKE-ORIGIN": "OpenCode",
                "content-length": Buffer.byteLength(body)
            }
        };
        const req = https.request(options, (res) => {
            let size = 0;
            /** @type {Buffer[]} */
            const chunks = [];
            let overflowed = false;
            res.on("data", (chunk) => {
                size += chunk.length;
                if (size > MAX_RESPONSE_BYTES) { overflowed = true; res.destroy(); return; }
                chunks.push(chunk);
            });
            res.on("end", () => {
                const text = overflowed ? "" : Buffer.concat(chunks).toString("utf8");
                let parsed = null;
                try { parsed = JSON.parse(text); } catch { /* non-JSON body stays text */ }
                resolve({ status: res.statusCode, text, parsed });
            });
            res.on("error", reject);
        });
        req.setTimeout(Math.max(1, timeoutMs), () => req.destroy(new Error("capability probe timeout")));
        req.on("error", reject);
        req.end(body);
    });
}

/** Pull a human-readable message out of an upstream error payload. */
function extractErrorMessage(response) {
    const p = response.parsed;
    if (p && typeof p === "object") {
        const candidate = p?.error?.message ?? p?.message ?? p?.detail;
        if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
    return typeof response.text === "string" ? response.text.slice(0, 500) : "";
}

/**
 * STRICT rejection classification (stability-audit fix #1): a candidate counts
 * as REJECTED only when the 4xx/422 body is a VALIDATION error that clearly
 * targets reasoning_effort — the message mentions "reasoning_effort" (or
 * "reasoning effort"), says "unknown variant", or carries an enum-listing
 * keyword window whose parsed values look like effort modes (reuses the SAME
 * windows/patterns as {@link parseAllowedValuesFromError}). Generic 400s about
 * unrelated fields, auth/rate-limit errors and 5xxs are NOT rejections — the
 * caller classifies them INCONCLUSIVE instead of silently dropping modes.
 *
 * @param {{ status?: number, text?: string, parsed?: unknown }} response
 * @returns {boolean}
 */
export function isReasoningEffortValidationRejection(response) {
    if (!response || typeof response !== "object") return false;
    if (!REJECT_STATUSES.has(response.status)) return false;
    const message = extractErrorMessage(response);
    if (!message) return false;
    const lowered = message.toLowerCase();
    if (lowered.includes("reasoning_effort") || lowered.includes("reasoning effort")) return true;
    if (/unknown\s+variant/.test(lowered)) return true;
    if (new RegExp(LISTING_KEYWORD_WINDOW_SOURCE, "i").test(message)) {
        const values = parseAllowedValuesFromError(message, { sentinels: [PROBE_SENTINEL] });
        if (values.some((v) => EFFORT_LIKE_VALUES.has(v))) return true;
    }
    return false;
}

function sawReasoningContent(response) {
    const msg = response?.parsed?.choices?.[0]?.message;
    if (!msg || typeof msg !== "object") return false;
    const rc = msg.reasoning_content ?? msg.reasoning;
    return typeof rc === "string" ? rc.length > 0 : rc != null;
}

function truncateEvidence(text, max = 300) {
    const s = typeof text === "string" ? text : "";
    return s.length > max ? s.slice(0, max) + "…" : s;
}

// ---------------------------------------------------------------------------
// Probe orchestration
// ---------------------------------------------------------------------------

function finalizeEntry({ modes, supported = true, controlKey = "reasoning_effort", source, method, status, evidence, verification, now }) {
    const ordered = normalizeDiscoveredModes(modes);
    return {
        modes: ordered,
        defaultMode: pickDefaultMode(ordered),
        supported: Boolean(supported),
        controlKey: supported ? controlKey : null,
        probedAt: now(),
        source, // 'probed' always here ('fallback' entries never come from a live run)
        ...(method ? { method } : {}),
        ...(Number.isInteger(status) ? { status } : {}),
        ...(evidence ? { evidence: truncateEvidence(evidence) } : {}),
        ...(verification && Object.keys(verification).length > 0 ? { verification } : {})
    };
}

/**
 * Individually probe each candidate effort value with STRICT classification
 * discipline (stability-audit fixes #1–#2):
 *
 *   - ACCEPTED     = any 2xx.
 *   - REJECTED     = 400/422 whose body is a VALIDATION error clearly targeting
 *                    reasoning_effort (see isReasoningEffortValidationRejection).
 *   - INCONCLUSIVE = ANY other 4xx/5xx/timeout/network error. The value STAYS
 *                    LISTED, the outcome is recorded in the per-mode
 *                    `verification` evidence map, and the loop CONTINUES — a
 *                    transient upstream failure must never erase known-good
 *                    modes (the old all-or-nothing null made sweeps flap).
 *
 * Every probe body uses max_tokens=64 (PROBE_VERIFY_MAX_TOKENS): thinking
 * models degenerate at 1 token and produced unstable classifications.
 *
 * Used in two roles: (a) full candidate enumeration when the sentinel request
 * cannot produce a listing, and (b) PER-MODEL VERIFICATION of the values a
 * validation-error listing claimed (live upstreams enforce the enum union at
 * deserialization but reject unsupported variants per model at execution).
 */
async function probeCandidatesIndividually(model, deps) {
    const { apiKey, candidates, timeoutMs, requestImpl, logger, now } = deps;
    const methodLabel = deps.methodLabel || "candidates";
    const baseEvidence = typeof deps.baseEvidence === "string" ? deps.baseEvidence : undefined;
    /** @type {string[]} */
    const accepted = [];
    /** @type {Record<string, object>} mode -> verification outcome/evidence */
    const verification = {};
    let sawReasoning = false;
    let inconclusiveCount = 0;
    for (const candidate of candidates) {
        let response;
        try {
            response = await requestImpl({ apiKey, body: buildProbeBody(model, candidate), timeoutMs });
        } catch (err) {
            inconclusiveCount++;
            verification[candidate] = { result: "inconclusive", evidence: truncateEvidence(String(err?.message || err)), checkedAt: now() };
            logger(redact({ step: "probe_candidates", model, result: "inconclusive_network", candidate, error: String(err?.message || err) }));
            continue; // keep listed
        }
        if (response.status >= 200 && response.status < 300) {
            accepted.push(candidate);
            if (sawReasoningContent(response)) sawReasoning = true;
            verification[candidate] = { result: "accepted", httpStatus: response.status, checkedAt: now() };
            continue;
        }
        if (isReasoningEffortValidationRejection(response)) {
            verification[candidate] = { result: "rejected", httpStatus: response.status, evidence: truncateEvidence(extractErrorMessage(response)), checkedAt: now() };
            logger(redact({ step: "probe_candidates", model, result: "rejected", candidate, status: response.status }));
            continue;
        }
        // ANY other status during per-value verification ⇒ INCONCLUSIVE:
        // keep the value listed, mark evidence, keep probing the rest.
        inconclusiveCount++;
        verification[candidate] = { result: "inconclusive", httpStatus: response.status, evidence: truncateEvidence(extractErrorMessage(response)), checkedAt: now() };
        logger(redact({ step: "probe_candidates", model, result: "inconclusive_status", candidate, status: response.status }));
    }

    if (accepted.length === 0 && inconclusiveCount === 0) {
        if (sawReasoning) {
            // Model reasons implicitly but rejects every reasoning_effort value.
            return finalizeEntry({
                modes: [], supported: true, controlKey: null, source: "probed",
                method: methodLabel,
                evidence: baseEvidence ?? "reasoning_content present; all reasoning_effort candidates rejected",
                verification, now
            });
        }
        return finalizeEntry({
            modes: [], supported: false, controlKey: null, source: "probed",
            method: methodLabel,
            evidence: baseEvidence ?? "all reasoning_effort candidates rejected",
            verification, now
        });
    }

    const inconclusiveModes = Object.keys(verification).filter((k) => verification[k].result === "inconclusive");
    const evidence = baseEvidence
        ?? (inconclusiveCount > 0 ? `${inconclusiveCount} candidate value(s) could not be verified and remain listed` : undefined);
    return finalizeEntry({
        modes: [...accepted, ...inconclusiveModes],
        // Unverified-but-listed values still advertise reasoning support; the
        // per-mode verification evidence marks exactly what was proven.
        supported: accepted.length > 0 || sawReasoning || inconclusiveModes.length > 0,
        controlKey: "reasoning_effort",
        source: "probed", method: methodLabel, evidence,
        verification, now
    });
}

/**
 * Discover the reasoning modes a specific model actually accepts.
 *
 * @param {string} model Full model ID (e.g. "stepfun-ai/step-3.7-flash").
 * @param {{
 *   apiKey?: string,
 *   candidates?: string[],
 *   timeoutMs?: number,
 *   requestImpl?: (args: { apiKey: string, body: string, timeoutMs: number }) => Promise<{status: number, text: string, parsed: *}>,
 *   logger?: (outcome: object) => void,
 *   now?: () => number
 * }} [options]
 * @returns {Promise<null | object>} Cache entry, or null when inconclusive
 *   (caller must fall back to the static capability registry).
 */
export async function discoverReasoningModes(model, options = {}) {
    if (typeof model !== "string" || model.trim().length === 0) return null;
    const apiKey = typeof options.apiKey === "string" ? options.apiKey : "";
    if (!apiKey) return null;
    const deps = {
        apiKey,
        candidates: Array.isArray(options.candidates) && options.candidates.length > 0 ? options.candidates : PROBE_CANDIDATES,
        timeoutMs: Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS,
        requestImpl: typeof options.requestImpl === "function" ? options.requestImpl : httpsJsonPost,
        logger: typeof options.logger === "function" ? options.logger : () => {},
        now: typeof options.now === "function" ? options.now : Date.now
    };
    try {
        // FAST PATH — one request with the sentinel value; a 400 usually lists
        // the allowed reasoning_effort values right in the error message.
        const first = await deps.requestImpl({ apiKey, body: buildProbeBody(model, PROBE_SENTINEL), timeoutMs: deps.timeoutMs });
        if (first.status >= 200 && first.status < 300) {
            // Field accepted unvalidated → cannot enumerate from an error.
            // Detect implicit reasoning support, then enumerate via candidates.
            const entry = await probeCandidatesIndividually(model, deps);
            return entry;
        }
        if (first.status === 400 || first.status === 422) {
            const message = extractErrorMessage(first);
            const listed = parseAllowedValuesFromError(message, { sentinels: [PROBE_SENTINEL] });
            if (listed.length > 0) {
                // The listing reflects the ENDPOINT enum union, not per-model
                // acceptance — verify each listed value with a tiny request so
                // the advertised set is what THIS model actually accepts.
                deps.logger(redact({ step: "probe", model, result: "listed_by_validation_error", status: first.status, listed: normalizeDiscoveredModes(listed) }));
                return await probeCandidatesIndividually(model, {
                    ...deps,
                    candidates: normalizeDiscoveredModes(listed),
                    methodLabel: "validation_error+verified",
                    baseEvidence: message
                });
            }
            deps.logger(redact({ step: "probe", model, result: "unparseable_validation_error", status: first.status }));
            return await probeCandidatesIndividually(model, deps);
        }
        // 401/403/429/5xx/… — inconclusive; static registry remains authoritative.
        deps.logger(redact({ step: "probe", model, result: "inconclusive_status", status: first.status }));
        return null;
    } catch (err) {
        deps.logger(redact({ step: "probe", model, result: "failed", error: String(err?.message || err) }));
        return null;
    }
}

// ---------------------------------------------------------------------------
// Gateway-state cache (TTL + persistence + concurrency guard)
// ---------------------------------------------------------------------------

function positiveIntEnv(raw, fallback) {
    const n = Number.parseInt(String(raw ?? ""), 10);
    return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** Mutable so tests can shorten the window via resetCapabilityProbeState(). */
let ttlMs = positiveIntEnv(process.env.GATEWAY_CAPABILITY_PROBE_TTL_MS, DEFAULT_TTL_MS);

/** @type {{ cachePath: string | null | undefined, loaded: boolean, lastSweepAt: number }} */
let state = {
    // Resolved ONCE from env at import (the gateway child's env is fixed for
    // its lifetime); resetCapabilityProbeState may override it for tests.
    cachePath: resolveCapabilityCachePath(),
    loaded: false,
    lastSweepAt: 0
};

/** @type {Map<string, object>} model id -> cached entry */
const capabilityCache = new Map();

/** @type {Map<string, Promise<object | null>>} model id -> in-flight probe */
const inFlightProbes = new Map();

/**
 * Resolve where the persistent cache lives. Preference order:
 *   GATEWAY_CAPABILITY_CACHE_PATH → dirname(GATEWAY_CONFIG_PATH) → parent of
 *   dirname(GATEWAY_LOG_PATH) (logs dir is <userData>/logs, so its parent is
 *   the same APPDATA userData dir that already holds config.json/keys.json).
 * Returns null when nothing is known → memory-only caching.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function resolveCapabilityCachePath(env = process.env) {
    if (typeof env.GATEWAY_CAPABILITY_CACHE_PATH === "string" && env.GATEWAY_CAPABILITY_CACHE_PATH.trim()) {
        return env.GATEWAY_CAPABILITY_CACHE_PATH;
    }
    if (typeof env.GATEWAY_CONFIG_PATH === "string" && env.GATEWAY_CONFIG_PATH.trim()) {
        return path.join(path.dirname(env.GATEWAY_CONFIG_PATH), CACHE_FILENAME);
    }
    if (typeof env.GATEWAY_LOG_PATH === "string" && env.GATEWAY_LOG_PATH.trim()) {
        return path.join(path.dirname(path.dirname(env.GATEWAY_LOG_PATH)), CACHE_FILENAME);
    }
    return null;
}

function isValidEntry(value) {
    return Boolean(
        value && typeof value === "object" && !Array.isArray(value)
        && Array.isArray(value.modes)
        && value.modes.every((m) => typeof m === "string")
        && Number.isFinite(value.probedAt)
        && (value.source === "probed" || value.source === "fallback")
    );
}

function ensureCacheLoaded() {
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
        // CACHE_FORMAT_VERSION 2 adds per-mode verification evidence + hysteresis
        // stamps; v1 payloads are migrated verbatim (their entries keep serving
        // until the next refresh). Unknown FUTURE versions are ignored rather
        // than misread.
        if (!parsed || typeof parsed !== "object"
            || (parsed.version !== 1 && parsed.version !== CACHE_FORMAT_VERSION)) return;
        const entries = parsed && typeof parsed === "object" ? parsed.entries : null;
        if (entries && typeof entries === "object") {
            for (const [model, entry] of Object.entries(entries)) {
                if (typeof model === "string" && isValidEntry(entry)) {
                    capabilityCache.set(model, entry);
                }
            }
        }
    } catch {
        // Corrupt cache file — ignore it; probes will repopulate.
    }
}

function persistCache() {
    if (!state.cachePath) return;
    const payload = {
        version: CACHE_FORMAT_VERSION,
        savedAt: new Date().toISOString(),
        entries: Object.fromEntries(capabilityCache)
    };
    const tmpPath = `${state.cachePath}.tmp`;
    try {
        fs.mkdirSync(path.dirname(state.cachePath), { recursive: true });
        fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
        fs.renameSync(tmpPath, state.cachePath);
    } catch {
        // Persistence is best-effort; the in-memory cache keeps working.
    }
}

function cloneEntry(entry) {
    return structuredClone(entry);
}

/**
 * Get the cached probed capability for a model (fresh OR stale — stale data is
 * still better advertising material than a static family guess; freshness only
 * drives background refresh).
 * @param {unknown} modelId
 * @returns {object | null} Deep clone of the entry, or null.
 */
export function getCachedReasoningCapability(modelId) {
    ensureCacheLoaded();
    if (typeof modelId !== "string" || modelId.length === 0) return null;
    const entry = capabilityCache.get(modelId);
    return entry ? cloneEntry(entry) : null;
}

/**
 * True when a cached entry exists and is inside the TTL window.
 * Exported for tests.
 */
export function isEntryFresh(entry, nowMs = Date.now()) {
    return Boolean(entry && Number.isFinite(entry.probedAt) && (nowMs - entry.probedAt) < ttlMs);
}

/**
 * HYSTERESIS (stability-audit fix #3): dropping a PREVIOUSLY-verified mode
 * requires TWO consecutive adverse probes. The first probe that fails to see
 * a previously-listed mode stamps it into the cache entry's `rejectedOnce`
 * map and KEEPS it advertised for one more cycle; only a second consecutive
 * absence removes it. Any fresh acceptance clears the stamp immediately.
 *
 * Applies only when the previous entry came from a real probe
 * (source === 'probed'); static-fallback guesses get no grace period.
 *
 * The per-mode verification evidence from the fresh probe is preserved so the
 * advertised entry always shows WHY a mode is currently held or dropped.
 *
 * @param {object | null} existing Previously cached entry (may be stale).
 * @param {object} fresh Entry produced by discoverReasoningModes.
 * @param {number} nowMs Current clock for rejectedOnce stamps.
 * @returns {object} The entry to cache (fresh as-is, or reconciled).
 */
function reconcileWithPrevious(existing, fresh, nowMs) {
    if (!existing || existing.source !== "probed" || !Array.isArray(existing.modes)) return fresh;
    const previousModes = existing.modes.filter((m) => typeof m === "string");
    if (previousModes.length === 0) return fresh;

    const verification = { ...(fresh.verification ?? {}) };
    const rejectedOnce = { ...(existing.rejectedOnce ?? {}) };
    const graceKept = [];
    let changed = false;
    for (const mode of previousModes) {
        if (fresh.modes.includes(mode)) {
            // Still verified — any outstanding stamp is cleared by acceptance.
            if (Object.prototype.hasOwnProperty.call(rejectedOnce, mode)) {
                delete rejectedOnce[mode];
                changed = true;
            }
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(rejectedOnce, mode)) {
            // SECOND consecutive absence → drop for good this time.
            delete rejectedOnce[mode];
            changed = true;
            continue;
        }
        // FIRST absence → one-cycle grace: keep advertising, stamp, annotate.
        const verdict = verification[mode];
        rejectedOnce[mode] = nowMs;
        graceKept.push(mode);
        verification[mode] = {
            ...(verdict ?? {}),
            result: verdict?.result ?? "rejected",
            heldByHysteresis: true,
            ...(verdict?.evidence ? {} : { evidence: "mode absent from fresh probe; held by hysteresis" }),
            checkedAt: Number.isFinite(verdict?.checkedAt) ? verdict.checkedAt : nowMs
        };
        changed = true;
    }
    if (!changed && graceKept.length === 0 && Object.keys(rejectedOnce).length === 0 && !existing.rejectedOnce) {
        return fresh;
    }

    const merged = finalizeEntry({
        modes: [...fresh.modes, ...graceKept],
        supported: fresh.supported,
        controlKey: fresh.controlKey ?? undefined,
        source: fresh.source,
        method: fresh.method,
        status: fresh.status,
        evidence: fresh.evidence,
        verification,
        now: () => nowMs
    });
    if (Object.keys(rejectedOnce).length > 0) merged.rejectedOnce = rejectedOnce;
    return merged;
}

/**
 * Probe a model (with per-model concurrency guard + TTL skip) and cache the
 * result on success. Failures return null and leave any previous entry intact.
 *
 * @param {string} modelId
 * @param {{
 *   force?: boolean,
 *   apiKey?: string,
 *   requestImpl?: Function,
 *   logger?: (outcome: object) => void,
 *   now?: () => number
 * }} [options]
 * @returns {Promise<object | null>} The (new or existing) cached entry, or null.
 */
export async function probeAndCacheReasoningModes(modelId, options = {}) {
    ensureCacheLoaded();
    if (typeof modelId !== "string" || modelId.length === 0) return null;
    const now = typeof options.now === "function" ? options.now : Date.now;
    const existing = capabilityCache.get(modelId) ?? null;
    if (!options.force && existing && isEntryFresh(existing, now())) {
        return cloneEntry(existing);
    }
    const pending = inFlightProbes.get(modelId);
    if (pending) return pending;

    const promise = (async () => {
        const entry = await discoverReasoningModes(modelId, {
            apiKey: typeof options.apiKey === "string" ? options.apiKey : "",
            requestImpl: /** @type {*} */ (options.requestImpl),
            logger: typeof options.logger === "function" ? options.logger : () => {},
            now
        });
        if (entry) {
            const reconciled = reconcileWithPrevious(existing, entry, now());
            capabilityCache.set(modelId, reconciled);
            persistCache();
            return cloneEntry(reconciled);
        }
        return null;
    })().finally(() => {
        if (inFlightProbes.get(modelId) === promise) inFlightProbes.delete(modelId);
    });
    inFlightProbes.set(modelId, promise);
    return promise;
}

/**
 * Background sweep triggered by /v1/models traffic: refresh stale/missing
 * models SEQUENTIALLY (bounded load), fire-and-forget — the HTTP response is
 * served from cache/static immediately and never waits on this.
 *
 * Scheduling gate mirrors the established project convention (model-discovery
 * warm guard): enabled by default in production, disabled under the
 * GATEWAY_TEST_LOCAL_UPSTREAM_PORT test sentinel unless explicitly force-
 * enabled, and hard-disabled via GATEWAY_CAPABILITY_PROBE_DISABLE=1.
 *
 * @param {unknown} modelIds Model ids from the freshly served catalog.
 * @param {{
 *   logger?: (outcome: object) => void,
 *   keyProvider?: () => string | null,
 *   requestImpl?: Function,
 *   force?: boolean
 * }} [options]
 * @returns {number} How many probes were queued this sweep (0 = skipped).
 */
export function scheduleCapabilityRefresh(modelIds, options = {}) {
    const env = process.env;
    const enabled = env.GATEWAY_CAPABILITY_PROBE_ENABLE === "1"
        || (env.GATEWAY_CAPABILITY_PROBE_DISABLE !== "1" && !env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT);
    if (!enabled) return 0;
    ensureCacheLoaded();

    const nowMs = Date.now();
    if (!options.force && (nowMs - state.lastSweepAt) < SWEEP_COOLDOWN_MS) return 0;
    state.lastSweepAt = nowMs;

    const maxPerSweep = positiveIntEnv(env.GATEWAY_CAPABILITY_PROBE_MAX_PER_SWEEP, 25);
    const ids = [...new Set(
        (Array.isArray(modelIds) ? modelIds : [])
            .filter((id) => typeof id === "string" && id.includes("/"))
    )]
        .filter((id) => {
            const entry = capabilityCache.get(id);
            return !isEntryFresh(entry, nowMs);
        })
        .sort()
        .slice(0, maxPerSweep);
    if (ids.length === 0) return 0;

    const logger = typeof options.logger === "function" ? options.logger : () => {};
    const keyProvider = typeof options.keyProvider === "function" ? options.keyProvider : null;

    void (async () => {
        for (const id of ids) {
            try {
                // Inside the try: a throwing keyProvider must degrade to a
                // logged "failed" sweep step, never escape as an
                // unhandledRejection (which would crash the gateway child).
                const apiKey = keyProvider ? keyProvider() : "";
                const entry = await probeAndCacheReasoningModes(id, {
                    apiKey: apiKey ?? "",
                    requestImpl: /** @type {*} */ (options.requestImpl),
                    logger
                });
                logger(redact({
                    step: "sweep", model: id,
                    result: entry ? "cached" : "inconclusive_static_fallback",
                    modes: entry ? entry.modes : undefined
                }));
            } catch (err) {
                logger(redact({ step: "sweep", model: id, result: "failed", error: String(err?.message || err) }));
            }
        }
    })();

    return ids.length;
}

/**
 * Apply a cached probed result OVER the static family metadata for /v1/models
 * advertisement. Mutates `capabilities.reasoning` in place when a probed entry
 * exists; otherwise leaves the static metadata untouched. Tools/vision/audio
 * and the static shape are never altered.
 *
 * @param {{ reasoning?: object }} capabilities Output of getCapabilityMetadata().
 * @param {string} modelId
 * @returns {{ reasoning?: object }} Same object, for chaining.
 */
export function mergeProbedReasoning(capabilities, modelId) {
    if (!capabilities || typeof capabilities !== "object") return capabilities;
    const entry = getCachedReasoningCapability(modelId);
    if (!entry) return capabilities;
    const reasoning = capabilities.reasoning;
    if (!reasoning || typeof reasoning !== "object") return capabilities;
    reasoning.supported = Boolean(entry.supported);
    reasoning.modes = Array.isArray(entry.modes) ? [...entry.modes] : [];
    reasoning.controlKey = typeof entry.controlKey === "string" && entry.controlKey ? entry.controlKey : null;
    reasoning.defaultMode = typeof entry.defaultMode === "string" && entry.defaultMode
        ? entry.defaultMode
        : (reasoning.modes.length > 0 ? reasoning.modes[reasoning.modes.length - 1] : null);
    return capabilities;
}

/**
 * Reset all probe/cache state. Used by tests; accepts overrides so unit tests
 * can inject a deterministic clock / cache path without touching process.env.
 * The next cache access re-loads from disk, which is exactly what a process
 * restart does — pass a fresh path for a clean slate.
 *
 * @param {{ cachePath?: string | null, ttlMs?: number }} [overrides]
 * @returns {void}
 */
export function resetCapabilityProbeState(overrides = {}) {
    capabilityCache.clear();
    inFlightProbes.clear();
    if (Number.isSafeInteger(overrides.ttlMs) && overrides.ttlMs > 0) {
        ttlMs = overrides.ttlMs;
    } else {
        ttlMs = positiveIntEnv(process.env.GATEWAY_CAPABILITY_PROBE_TTL_MS, DEFAULT_TTL_MS);
    }
    state = {
        // Explicit null ⇒ memory-only; undefined ⇒ derive from env once.
        cachePath: overrides.cachePath !== undefined ? overrides.cachePath : resolveCapabilityCachePath(),
        loaded: false,
        lastSweepAt: 0
    };
}
