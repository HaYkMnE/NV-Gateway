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
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redact } from "../shared/redaction.mjs";
import { isDeepSeekV41FlashModel } from "./reasoning-defaults.mjs";
import { getCuratedReasoningOverride, getReasoningCapability } from "./capability-registry.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NVIDIA_API_HOST = "integrate.api.nvidia.com";
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

/** Value sent to provoke a listing validation error. Never a real mode. */
export const PROBE_SENTINEL = "bogus_probe";

/**
 * Unique string the probe puts in its own prompt, together with a trivial
 * TRANSFORMATION the model must apply to it. Reasoning support is only
 * advertised when the TRANSFORMED RESULT (see
 * {@link PROBE_REASONING_ANSWER}) comes back inside the model's reasoning
 * output: a 2xx alone proves nothing (a model that merely echoes unknown request
 * fields accepts `reasoning_effort` while producing no reasoning at all, so the
 * UI would offer modes that do nothing).
 *
 * Requiring the COMPUTED answer — not the marker itself — is what keeps a
 * prompt ECHO from counting as reasoning: the marker is part of the prompt, so
 * any model (or upstream) that copies the prompt into `reasoning_content`
 * would satisfy a marker-only check with zero thinking (reproduced live).
 * Random per process so a model cannot learn it from a previous probe; tests
 * import it to compute the answer deliberately.
 */
export const PROBE_REASONING_MARKER = `NVPROBE-${crypto.randomBytes(8).toString("hex")}`;

/**
 * The answer the probe requires: {@link PROBE_REASONING_MARKER} reversed. It is
 * never present in the prompt, so it can only appear in reasoning output if the
 * model actually performed the transformation.
 */
export const PROBE_REASONING_ANSWER = [...PROBE_REASONING_MARKER].reverse().join("");

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
/** Max clock skew tolerated for a probedAt in the future (isEntryFresh). */
const FUTURE_SKEW_ALLOWANCE_MS = 5 * 60 * 1000;

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
 * Pick the advertised default mode from a mode list: prefer "high" (sane strong
 * default), else the HIGHEST mode in {@link CANONICAL_ORDER} (ascending effort).
 * A mode outside that order cannot be ranked against the canonical ones, so it
 * ranks just above the disabled group ("none"/"off") and below "minimal": that
 * keeps `["max","bogus"]` on "max" while still letting a boolean-style
 * `["off","on"]` list resolve to "on". Among equal-ranked entries the LAST one
 * listed wins, so the result is deterministic for an unsorted legacy list too.
 * @param {string[]} modes Non-empty mode list.
 * @returns {string | null}
 */
export function pickDefaultMode(modes) {
    if (!Array.isArray(modes)) return null;
    const listed = modes.filter((m) => typeof m === "string");
    if (listed.length === 0) return null;
    if (listed.includes("high")) return "high";
    const unknownRank = CANONICAL_ORDER.indexOf("off") + 0.5;
    let best = null;
    let bestRank = -1;
    for (const mode of listed) {
        const idx = CANONICAL_ORDER.indexOf(mode);
        const rank = idx === -1 ? unknownRank : idx;
        if (rank >= bestRank) {
            best = mode;
            bestRank = rank;
        }
    }
    return best;
}

/**
 * THE single default-mode clamp. Resolve the one default a mode list can offer:
 * the requested value when it is actually listed, otherwise
 * {@link pickDefaultMode}. The cache repair persists the result, and both the
 * /v1/models advertisement and the Anthropic adapter read that persisted value,
 * so the advertised default and the value sent upstream cannot disagree.
 * @param {string[]} modes
 * @param {unknown} requested
 * @returns {string | null} null when the list offers nothing.
 */
export function resolveDefaultMode(modes, requested) {
    const listed = Array.isArray(modes) ? modes.filter((m) => typeof m === "string") : [];
    if (listed.length === 0) return null;
    if (typeof requested === "string" && listed.includes(requested)) return requested;
    return pickDefaultMode(listed);
}

/**
 * Build the minimal chat-completions body used for probing.
 *
 * The prompt carries {@link PROBE_REASONING_MARKER} and asks for it REVERSED.
 * The model's reasoning output must contain that computed result
 * ({@link PROBE_REASONING_ANSWER}) — the ONLY evidence this module accepts that
 * reasoning actually happens. The answer never appears in the prompt, so an
 * echo of the prompt cannot satisfy the check.
 *
 * @param {string} model Model ID.
 * @param {string} effortValue reasoning_effort to test ("bogus_probe" or a candidate).
 * @returns {string} Serialized JSON body.
 */
export function buildProbeBody(model, effortValue) {
    return JSON.stringify({
        model,
        stream: false,
        max_tokens: PROBE_VERIFY_MAX_TOKENS,
        messages: [{
            role: "user",
            content: `Reverse the characters of this token and state the result: ${PROBE_REASONING_MARKER}`
        }],
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
        // resolve/reject are idempotent; `settled` only gates side effects (destroy, parse).
        let settled = false;
        const settle = (fn, value) => { settled = true; fn(value); };
        const req = https.request(options, (res) => {
            let size = 0;
            /** @type {Buffer[]} */
            const chunks = [];
            res.on("data", (chunk) => {
                if (settled) return;
                size += chunk.length;
                if (size > MAX_RESPONSE_BYTES) {
                    // Reject (not resolve with an empty body): a truncated reply is not
                    // evidence of support, so the probe must read as failed/inconclusive.
                    settle(reject, new Error("capability probe response too large"));
                    res.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            res.on("end", () => {
                if (settled) return;
                const text = Buffer.concat(chunks).toString("utf8");
                let parsed = null;
                try { parsed = JSON.parse(text); } catch { /* non-JSON body stays text */ }
                settle(resolve, { status: res.statusCode, text, parsed });
            });
            res.on("error", (err) => settle(reject, err));
            // A mid-body reset fires only aborted/close on res (no error/end).
            res.on("close", () => settle(reject, new Error("capability probe response closed before end")));
        });
        req.setTimeout(Math.max(1, timeoutMs), () => req.destroy(new Error("capability probe timeout")));
        req.on("error", (err) => settle(reject, err));
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

/**
 * Text of a completion message's reasoning output, or "" when it produced none.
 * Accepts the shapes live NVIDIA endpoints use: `reasoning_content`,
 * `reasoning`, and `thinking` (string, or an array of `{ text }` blocks).
 * @param {unknown} message choices[0].message
 * @returns {string}
 */
function reasoningTextOf(message) {
    if (!message || typeof message !== "object") return "";
    const parts = [];
    for (const key of ["reasoning_content", "reasoning", "thinking"]) {
        const value = /** @type {Record<string, unknown>} */ (message)[key];
        if (typeof value === "string") parts.push(value);
        else if (Array.isArray(value)) {
            for (const block of value) {
                if (typeof block === "string") parts.push(block);
                else if (block && typeof block === "object" && typeof (/** @type {Record<string, unknown>} */ (block).text) === "string") {
                    parts.push(/** @type {string} */ (/** @type {Record<string, unknown>} */ (block).text));
                }
            }
        }
    }
    return parts.join("\n");
}

/**
 * True only when the model's REASONING output carries this probe's COMPUTED
 * answer. A plain 2xx is not evidence: it only proves the request was accepted.
 * Neither is a copy of the prompt (which contains the marker but never the
 * answer) — that is the point of requiring a transformed value.
 *
 * KNOWN FALSE-NEGATIVE CLASS (accepted trade-off, do not "fix" by loosening
 * this check): a real reasoner that thinks INLINE in `content`, or one whose
 * endpoint does not emit `reasoning_content`/`reasoning`/`thinking` at all,
 * produces no reasoning field for us to inspect and is therefore reported
 * `supported: false`. That is deliberate: a false POSITIVE advertises modes that
 * do nothing, while a false negative only means we keep the static family
 * metadata (the UI already guards on `supported === true`), and the verdict is
 * re-probed on the normal TTL. Evidence we cannot read is not evidence of
 * reasoning.
 *
 * @param {{ parsed?: * }} response
 * @returns {boolean}
 */
function sawReasoningContent(response) {
    const text = reasoningTextOf(response?.parsed?.choices?.[0]?.message);
    return text.length > 0 && text.includes(PROBE_REASONING_ANSWER);
}

function truncateEvidence(text, max = 300) {
    const s = typeof text === "string" ? text : "";
    return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Per-model run of CONSECUTIVE genuine-negative observations.
 *
 * A "genuine negative" is an accepted 2xx whose answer COMPLETED (no
 * `finish_reason: "length"`, answer text present) and still carried no reasoning
 * marker. One such reply is not a downgrade: a 64-token cap truncating a
 * thinking model, an empty completion and a single flaky turn all look exactly
 * like it. Two in a row are. Any POSITIVE observation (reasoning seen) or
 * INCONCLUSIVE one (truncated/empty/4xx-5xx/network) resets the run, and a
 * validation `rejected` never advances it.
 *
 * @type {Map<string, number>} model id -> consecutive genuine negatives
 */
const negativeRuns = new Map();

/** Consecutive genuine negatives required before a downgrade is published. */
const NEGATIVE_DOWNGRADE_STREAK = 2;

function noteNegativeObservation(model) {
    const next = (negativeRuns.get(model) ?? 0) + 1;
    negativeRuns.set(model, next);
    return next;
}

function resetNegativeRun(model) {
    negativeRuns.delete(model);
}

/** Answer text of a completion message (string, or an array of text blocks). */
function answerTextOf(message) {
    const value = message?.content;
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    const parts = [];
    for (const block of value) {
        if (typeof block === "string") parts.push(block);
        else if (block && typeof block === "object" && typeof block.text === "string") parts.push(block.text);
    }
    return parts.join("");
}

/**
 * Classify an ACCEPTED (2xx) probe reply.
 *
 *   `reasoned`  — the probe's COMPUTED answer came back in reasoning output (the
 *                 only positive evidence this module accepts).
 *   `complete`  — the answer itself finished: `finish_reason` is not "length" AND
 *                 answer text is present. Only a COMPLETE silent reply is a
 *                 NEGATIVE observation; a truncated (`finish_reason: "length"`)
 *                 or empty one proves nothing and is INCONCLUSIVE instead.
 *
 * Both snake_case and camelCase shapes are read: upstreams differ.
 *
 * @param {{ parsed?: * }} response
 * @returns {{ reasoned: boolean, complete: boolean, finishReason: string | null }}
 */
function classifyAcceptedReply(response) {
    const choice = response?.parsed?.choices?.[0];
    const finishReason = typeof choice?.finish_reason === "string"
        ? choice.finish_reason
        : (typeof choice?.finishReason === "string" ? choice.finishReason : null);
    return {
        reasoned: sawReasoningContent(response),
        complete: finishReason !== "length" && answerTextOf(choice?.message).trim().length > 0,
        finishReason
    };
}

// ---------------------------------------------------------------------------
// Probe orchestration
// ---------------------------------------------------------------------------

function finalizeEntry({ modes, supported = true, controlKey = "reasoning_effort", source, method, status, evidence, verification, now }) {
    const ordered = normalizeDiscoveredModes(modes);
    // INVARIANT (enforced at the single source of truth, so no producer — probe
    // branch, hysteresis merge or disk load — can publish an incoherent state):
    // a POSITIVE finding's `modes` are CONTROLS, not free-standing evidence, so
    // they may not exist without the control key that drives them. `controlKey:
    // null` is a MEASURED answer ("reasoning happens, but no usable
    // reasoning_effort value"), and advertising modes next to it offered the UI
    // controls that do nothing AND let the Anthropic adapter repair the key back
    // to reasoning_effort — sending a value the sweep never verified. What was
    // merely accepted stays visible in `verification`.
    // An UNSUPPORTED finding advertises nothing either way (mergeProbedReasoning
    // and the adapter both gate on `supported`), so its mode list is kept as raw
    // evidence of which values were legal.
    const resolvedControlKey = supported && typeof controlKey === "string" && controlKey ? controlKey : null;
    const advertisedModes = resolvedControlKey || !supported ? ordered : [];
    return {
        modes: advertisedModes,
        // An unsupported finding advertises no default mode either: a mode the
        // UI cannot offer must not be presented as the model's default.
        defaultMode: supported ? pickDefaultMode(advertisedModes) : null,
        supported: Boolean(supported),
        controlKey: resolvedControlKey,
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
 *                    When NOT ONE value was accepted, the whole sweep proved
 *                    nothing and returns null (no verdict at all) instead of a
 *                    negative finding — see the guard below the loop.
 *
 * ACCEPTED values are evidence that the VALUE is legal, NOT that the model
 * reasons: support is advertised only when the probe's own COMPUTED answer comes
 * back in reasoning output (see sawReasoningContent).
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
    // The sentinel reply may already have proven that this model reasons.
    let sawReasoning = Boolean(deps.sentinelReasoned);
    let inconclusiveCount = 0;
    // Accepted 2xx replies that carried a COMPLETE answer and no reasoning
    // marker: the only shape that counts as a negative observation.
    let silentCompleteCount = 0;
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
            const reply = classifyAcceptedReply(response);
            if (reply.reasoned) {
                sawReasoning = true;
            } else if (reply.complete) {
                // A COMPLETE silent answer: a genuine negative observation.
                silentCompleteCount++;
            } else {
                // Truncated (`finish_reason: "length"`) or empty answer: the
                // model never got to answer, so this proves NOTHING. Classify
                // INCONCLUSIVE — a 64-token cap must not downgrade a model.
                inconclusiveCount++;
                verification[candidate] = {
                    result: "inconclusive",
                    httpStatus: response.status,
                    evidence: truncateEvidence(reply.finishReason === "length"
                        ? `finish_reason=length; answer truncated before completion`
                        : "empty answer; no reasoning output to judge"),
                    checkedAt: now()
                };
                logger(redact({ step: "probe_candidates", model, result: "inconclusive_truncated", candidate, finishReason: reply.finishReason }));
                continue;
            }
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
            // This is a POSITIVE observation, so it ends any negative run — the
            // invariant above ("any POSITIVE observation resets the run") applies
            // to this branch too. Leaving it out let a proven model be downgraded
            // by the very next single negative: neg -> pos -> neg used to count
            // as two consecutive strikes and published supported:false.
            resetNegativeRun(model);
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

    // NOTHING was accepted and at least one value could not be measured: this
    // sweep proved nothing. Reporting `supported:false` here would flip a
    // previously PROVEN model to unsupported on a transient 429/5xx storm — the
    // exact violation of "a transient upstream failure must never erase
    // known-good" (reconcileWithPrevious only guards the mode list, not the
    // verdict). Return null so the caller keeps what it already knows; a cold
    // model stays UNKNOWN and falls back to the static registry, never falsely
    // negative. A sentinel reply that DID show reasoning is real positive
    // evidence, so it is not discarded.
    if (accepted.length === 0 && inconclusiveCount > 0 && !sawReasoning) {
        // Inconclusive: it proves nothing and must not advance the negative run.
        resetNegativeRun(model);
        return null;
    }

    if (accepted.length === 0) {
        // Reasoning was observed, but NOT ONE reasoning_effort value was proven to
        // work. Publishing the candidate list here would advertise controls that
        // were never verified (the UI would offer modes that do nothing).
        resetNegativeRun(model);
        return finalizeEntry({
            modes: [], supported: true, controlKey: null, source: "probed",
            method: methodLabel,
            evidence: baseEvidence ?? "reasoning_content present; no reasoning_effort value could be verified",
            verification, now
        });
    }

    // Accepted 2xx replies existed, but NOT ONE of them carried a COMPLETE
    // answer (every one was `finish_reason: "length"` or empty). A truncated
    // reply is not a negative observation: the model never finished, so the
    // sweep proved nothing. Returning null keeps a known-good verdict instead of
    // downgrading a model on a 64-token cap.
    if (!sawReasoning && silentCompleteCount === 0) {
        resetNegativeRun(model);
        return null;
    }

    if (sawReasoning) {
        // Any positive observation ends the run: support is re-proven.
        resetNegativeRun(model);
    } else {
        // Genuine negative(s), complete and marker-free. One is not enough: a
        // single silent sweep may be a flaky turn, and a cold model has no
        // prior verdict to downgrade. Hold (publish nothing) until the run
        // reaches NEGATIVE_DOWNGRADE_STREAK.
        const streak = noteNegativeObservation(model);
        logger(redact({ step: "probe_candidates", model, result: "negative_observation", streak }));
        if (streak < NEGATIVE_DOWNGRADE_STREAK) return null;
        // The run is spent once the downgrade is published; the next negative
        // starts a fresh one (a later null keeps the cached `false` anyway).
        resetNegativeRun(model);
    }

    const inconclusiveModes = Object.keys(verification).filter((k) => verification[k].result === "inconclusive");
    // Reasoning is advertised ONLY when this probe saw its own marker come back
    // in reasoning output. `accepted.length > 0` alone is NOT evidence: models
    // that merely echo unknown request fields accept every effort value and
    // reason about nothing (a mode that does nothing in the UI).
    const evidence = [
        baseEvidence,
        inconclusiveCount > 0 ? `${inconclusiveCount} candidate value(s) could not be verified and remain listed` : undefined,
        sawReasoning ? undefined : "no reasoning output observed"
    ].filter(Boolean).join("; ") || undefined;
    return finalizeEntry({
        modes: [...accepted, ...inconclusiveModes],
        // The listed values stay as evidence of what was proven (accepted vs
        // inconclusive), but they are advertised only when reasoning was seen.
        supported: sawReasoning,
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
            // The sentinel reply is evidence too: if the marker came back in its
            // reasoning output, this model reasons (whatever effort value).
            const entry = await probeCandidatesIndividually(model, { ...deps, sentinelReasoned: sawReasoningContent(first) });
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
        resetNegativeRun(model);
        return null;
    } catch (err) {
        deps.logger(redact({ step: "probe", model, result: "failed", error: String(err?.message || err) }));
        resetNegativeRun(model);
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

/** Prefix of the only nested control the Anthropic adapter can write. */
const DRIVEABLE_CONTROL_PREFIX = "chat_template_kwargs.";

/**
 * True only for a control key the Anthropic adapter can actually PUT ON THE
 * WIRE: the top-level `reasoning_effort`, or a `chat_template_kwargs.<field>`
 * (the adapter writes `chat_template_kwargs[field]`, so any field name works).
 * Everything else — `unknown_key`, `REASONING_EFFORT`, a zero-width or NUL
 * suffix — is a control nobody drives: advertising modes next to it put a dead
 * control in the UI while the adapter sent nothing.
 * @param {unknown} key
 * @returns {boolean}
 */
function isDriveableControlKey(key) {
    if (typeof key !== "string" || key.length === 0) return false;
    if (key === "reasoning_effort") return true;
    return key.startsWith(DRIVEABLE_CONTROL_PREFIX) && key.length > DRIVEABLE_CONTROL_PREFIX.length;
}

/**
 * Enforce the entry invariant on data we did NOT just build (a cache file from
 * an older build, a hand-edited file): a PRESENT `controlKey` that is not a
 * non-empty string (null, "", 42, true) is a MEASUREMENT ("reasoning happens,
 * no usable reasoning_effort value"), so it may not carry advertised modes —
 * a legacy entry that did would let the Anthropic adapter repair the key back
 * and send an unverified value. Garbage is normalised to explicit null so that
 * gate cannot be dodged by a value that merely LOOKS absent.
 *
 * An ABSENT key is merely an incomplete legacy entry, not a measurement: those
 * keep their modes and the adapter repairs them to the probe's default.
 * Unsupported entries keep their mode list as raw evidence; nothing advertises
 * it (mergeProbedReasoning and the adapter both gate on `supported`).
 *
 * The default mode is clamped HERE, once, and the clamped value is what gets
 * persisted — so the adapter (which reads the cache) and /v1/models advertise
 * and send the same value. Two independent clamps could disagree; there is now
 * one.
 *
 * @param {object} entry
 * @returns {object} The same object when coherent, a repaired copy otherwise.
 */
function repairEntryInvariant(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    // An ABSENT key is incomplete legacy data, not a measurement: keep it absent
    // so the adapter can still repair it to the probe's default. Its default is
    // clamped the same way, so both sides still agree.
    if (!Object.prototype.hasOwnProperty.call(entry, "controlKey")) {
        const modes = Array.isArray(entry.modes) ? entry.modes : [];
        const defaultMode = entry.supported === false ? null : resolveDefaultMode(modes, entry.defaultMode);
        if (defaultMode === entry.defaultMode) return entry;
        return { ...entry, defaultMode };
    }
    // Any PRESENT value that is not a non-empty string (null, "", 42, true) is a
    // measurement of "no usable control" — the adapter reads garbage as absent
    // and would otherwise resurrect reasoning_effort from the mode list.
    const rawControlKey = entry.controlKey;
    // `length > 0` let a WHITESPACE-only key through, so the entry advertised
    // `{controlKey:"   ", modes:['low','high'], defaultMode:'high'}` while the
    // adapter sent nothing — a silent dead control in the UI. Whitespace-only is
    // therefore a MEASUREMENT ("no usable control"), exactly like "" or 42.
    // A PADDED real key is trimmed back to its canonical form when the adapter
    // can drive it; anything else is dropped rather than re-advertised with the
    // padding intact (that would name a field nobody understands). The gate is
    // the ADAPTER's capability, not a fixed list: an unpadded `unknown_key` /
    // `REASONING_EFFORT` / `reasoning_effort\u200b` was accepted at face value and
    // advertised modes the adapter could never send.
    const trimmedControlKey = typeof rawControlKey === "string" ? rawControlKey.trim() : "";
    const controlKey = isDriveableControlKey(trimmedControlKey) ? trimmedControlKey : null;
    if (entry.supported === false) {
        return rawControlKey === controlKey ? entry : { ...entry, controlKey };
    }
    if (controlKey !== null) {
        const modes = Array.isArray(entry.modes) ? entry.modes : [];
        const defaultMode = resolveDefaultMode(modes, entry.defaultMode);
        if (rawControlKey === controlKey && defaultMode === entry.defaultMode) return entry;
        return { ...entry, controlKey, defaultMode };
    }
    const modes = Array.isArray(entry.modes) ? entry.modes : [];
    if (rawControlKey === null && modes.length === 0 && entry.defaultMode === null) return entry;
    return { ...entry, controlKey: null, modes: [], defaultMode: null };
}

/**
 * The control key an entry actually DRIVES, using the adapter's own rule: an
 * explicit `controlKey` wins only when the adapter can write it; a legacy entry
 * with the key ABSENT is repaired to `reasoning_effort` when it has modes.
 * Shared by the cache repair, the /v1/models advertisement and the Anthropic
 * adapter, so what is advertised is exactly what can be sent.
 * @param {unknown} entry
 * @returns {string | null}
 */
export function resolveEntryControlKey(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const e = /** @type {Record<string, unknown>} */ (entry);
    if (Object.prototype.hasOwnProperty.call(e, "controlKey")) {
        return isDriveableControlKey(e.controlKey) ? /** @type {string} */ (e.controlKey) : null;
    }
    const modes = Array.isArray(e.modes) ? e.modes.filter((m) => typeof m === "string") : [];
    return modes.length > 0 ? "reasoning_effort" : null;
}

/**
 * The ONE decision both facades must use: what does /v1/models advertise for
 * this model, and therefore what may the wire carry?
 *
 * A fresh `source:'probed'` POSITIVE entry is authoritative. A NEGATIVE one has
 * no veto power: if the static registry says the model reasons, it is ignored
 * and the static row stands; only for a known non-reasoner or an unknown family
 * is it returned (authoritative, no modes, no control). A stale or non-probed
 * entry is always ignored so the static family row wins.
 *
 * Returns `{ authoritative, supported, controlKey, modes, defaultMode }`.
 * `authoritative:false` means "no probe evidence; use the static row".
 *
 * @param {unknown} modelId
 * @param {{ ttlMs?: number }} [options]
 */
export function resolveAdvertisedReasoning(modelId, options) {
    /** @type {{ authoritative: boolean, supported: boolean, controlKey: string | null, modes: string[], defaultMode: string | null }} */
    const none = { authoritative: false, supported: false, controlKey: null, modes: [], defaultMode: null };
    if (typeof modelId !== "string" || modelId.length === 0) return none;
    let entry;
    try {
        entry = getCachedReasoningCapability(modelId);
    } catch {
        return none;
    }
    // ONE rule for every consumer. The previous version of this function used a
    // private DEFAULT_TTL_MS + `>` while `isEntryFresh` uses the mutable `ttlMs`
    // + `<`, so "stale" meant two different things and a 25h entry could be
    // advertised by one reader and ignored by another. Delegate instead.
    const effectiveTtl = options && typeof options.ttlMs === "number" && options.ttlMs > 0
        ? options.ttlMs
        : ttlMs;
    if (!entry || entry.source !== "probed") return none;
    if (!Number.isFinite(entry.probedAt)) return none;
    if (!isEntryFresh(entry, Date.now(), effectiveTtl)) return none;
    if (typeof entry.supported !== "boolean") return none;
    // NEGATIVE verdicts: probe evidence has NO VETO POWER. The probe only
    // measures whether its own reasoning_effort marker comes back
    // (`supported: sawReasoning`), and its documented trade-off is false
    // negatives (models that reason through another control, or without
    // echoing). So a negative can never turn a static reasoner off: when the
    // static row says the model reasons, the negative is ignored and every
    // consumer serves the SAME static answer.
    // When the static row already says "no reasoning" (a known non-reasoner,
    // or the DEFAULT row of an unknown family) the negative CONFIRMS it, and is
    // returned as authoritative so /v1/models scrubs any modes/control a caller
    // put in the capabilities object - a cached no-reasoning finding can never
    // re-enable modes. It changes no verdict either way: the outcome always
    // equals the static verdict, so Anthropic refuses exactly the families the
    // static table already refuses (unknown families stay optimistic there).
    if (entry.supported !== true) {
        let staticSupported = false;
        try {
            staticSupported = Boolean(getReasoningCapability(modelId)?.supported);
        } catch {
            // Registry error: the static verdict is UNKNOWN, so the negative has
            // nothing to confirm and must not veto anything.
            return none;
        }
        if (staticSupported) return none;
        return { authoritative: true, supported: false, controlKey: null, modes: [], defaultMode: null };
    }
    const supported = true;
    const modes = supported && Array.isArray(entry.modes)
        ? entry.modes.filter((m) => typeof m === "string")
        : [];
    // CURATED models (an exact MODEL_OVERRIDES reasoning object with a mode
    // list): a positive probe may NARROW the curated modes but never EXPAND
    // them. The probe tries "none"/"minimal" too, and upstream can accept such a
    // value with 200 while still reasoning (minimaxai/minimax-m3.1-flash), so
    // letting the probe add modes would advertise an off-switch that does
    // nothing. Modes = probed ∩ curated (curated order), control = curated,
    // default = curated when still offered, else the shared clamp. An empty
    // intersection keeps the curated object: a known reasoner never advertises
    // zero modes. Resolved HERE so /v1/models, chat and Anthropic agree.
    // deepseek-v4.1-flash (curated modes []) is skipped and keeps its bypass.
    let curated = null;
    try {
        curated = getCuratedReasoningOverride(modelId);
    } catch {
        curated = null;
    }
    if (curated && curated.supported === true && Array.isArray(curated.modes) && curated.modes.length > 0
        && isDriveableControlKey(curated.controlKey)) {
        const curatedModes = curated.modes.filter((m) => typeof m === "string");
        const narrowed = curatedModes.filter((m) => modes.includes(m));
        const finalModes = narrowed.length > 0 ? narrowed : curatedModes;
        return {
            authoritative: true,
            supported: true,
            controlKey: /** @type {string} */ (curated.controlKey),
            modes: finalModes,
            defaultMode: resolveDefaultMode(finalModes, curated.defaultMode),
        };
    }
    const controlKey = supported && modes.length > 0 ? resolveEntryControlKey(entry) : null;
    const defaultMode = controlKey ? resolveDefaultMode(modes, entry.defaultMode) : null;
    return { authoritative: true, supported, controlKey, modes, defaultMode };
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
                    capabilityCache.set(model, repairEntryInvariant(entry));
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
export function isEntryFresh(entry, nowMs = Date.now(), ttlOverride) {
    const effectiveTtl = Number.isFinite(ttlOverride) && ttlOverride > 0 ? ttlOverride : ttlMs;
    // A probedAt beyond the clock-skew allowance is in the future: without this
    // bound it would count as fresh forever.
    return Boolean(entry && Number.isFinite(entry.probedAt)
        && entry.probedAt <= nowMs + FUTURE_SKEW_ALLOWANCE_MS
        && (nowMs - entry.probedAt) < effectiveTtl);
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
        // INVARIANT: a POSITIVE finding may only hold a mode it can still DRIVE.
        // `fresh.controlKey === null` means this sweep measured "no usable
        // reasoning_effort value", so a grace-kept mode would be re-advertised
        // with no control behind it (the exact incoherent shape that made the
        // adapter send an unverified reasoning_effort). An UNSUPPORTED finding
        // keeps its list as evidence: nothing advertises it.
        modes: fresh.supported && !fresh.controlKey ? [] : [...fresh.modes, ...graceKept],
        supported: fresh.supported,
        // PRESERVE an explicit `null`. `fresh.controlKey ?? undefined` collapsed
        // the probe's MEASURED "reasoning happens, but no usable reasoning_effort
        // value" answer (null) into "unset" (undefined), and finalizeEntry then
        // re-applied its 'reasoning_effort' default — re-inventing exactly the
        // control the fresh sweep failed to verify. Only a genuinely MISSING key
        // may fall back to the default.
        controlKey: Object.prototype.hasOwnProperty.call(fresh, "controlKey") ? fresh.controlKey : undefined,
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
    // Exact built-in safety override: this model uses numeric effort 1..100 and
    // the endpoint schema exposes no verified string control. A stale/string-mode
    // probe cache must never re-enable reasoning_effort for /v1/models metadata.
    if (isDeepSeekV41FlashModel(modelId)) return capabilities;
    const reasoning = capabilities.reasoning;
    if (!reasoning || typeof reasoning !== "object") return capabilities;
    // Same single rule as the chat facade and the adapter: only a FRESH probed
    // verdict is authoritative. A stale entry, or a `fallback` row that merely
    // lives in the cache, must leave the static family metadata in charge —
    // otherwise /v1/models, the chat facade and the Anthropic facade each pick a
    // different "truth" for the same model.
    const advertised = resolveAdvertisedReasoning(modelId);
    if (!advertised.authoritative) return capabilities;
    // Mirror the Anthropic adapter: the probe only measures reasoning_effort, so
    // on a family whose STATIC control is another key (a chat_template_kwargs
    // flag: qwen, stepfun-ai, minimaxai) a positive verdict may UNLOCK
    // reasoning but must not rename the control or replace the mode list —
    // the adapter keeps sending the static flag, and /v1/models must say so.
    if (advertised.supported) {
        let staticControl = null;
        try {
            const staticCap = getReasoningCapability(modelId);
            staticControl = typeof staticCap?.controlKey === "string" && staticCap.controlKey ? staticCap.controlKey : null;
        } catch {
            staticControl = typeof reasoning.controlKey === "string" && reasoning.controlKey ? reasoning.controlKey : null;
        }
        if (staticControl && staticControl !== "reasoning_effort") {
            reasoning.supported = true;
            return capabilities;
        }
    }
    reasoning.supported = advertised.supported;
    reasoning.controlKey = advertised.controlKey;
    reasoning.modes = advertised.controlKey ? [...advertised.modes] : [];
    reasoning.defaultMode = advertised.controlKey ? advertised.defaultMode : null;
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
    negativeRuns.clear();
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
