// @ts-check
// NOTE: this gateway module is plain Node ESM and is NOT part of either
// tsconfig project (same as the sibling cache modules capability-probe.mjs /
// model-key-affinity.mjs / nvidia-catalog-sync.mjs). The `@ts-nocheck` below
// only silences the editor's structural-JSDoc strictness; `npm run build`
// never type-checks this file.
// @ts-nocheck
/**
 * Model-strength ranking from LLM Stats (Round E).
 *
 * Replaces the usage-based `popularity` (NGC monthly invocation count) as the
 * Models panel's "how good is this model" axis with a real overall-strength
 * index, and feeds the «Топовые» sort.
 *
 * SOURCE (keyless, free, public):
 *   GET https://api.zeroeval.com/leaderboard/categories/general/index
 *   -> { category_id, method, methodology, games, models: [
 *          { model_id, model_name, organization_id, organization_name,
 *            mu, sigma, conservative, ci_lower, ci_upper, games_played, rank, ... } ] }
 *
 *   `conservative` (mu - 3*sigma) is the source's own sort key; `rank` is its
 *   published overall position (1 = strongest), which is what we surface.
 *
 * ATTRIBUTION (required by the source's licence): wherever this ranking is
 * displayed, show "Data by LLM Stats" linking to https://llm-stats.com/.
 * The renderer does that; the strings live in the i18n bundle.
 *
 * RESILIENCE (mirrors capability-probe.mjs / nvidia-catalog-sync.mjs):
 *   * fetched at most once per TTL (24h, GATEWAY_LLM_STATS_TTL_MS overrides);
 *   * persisted to `<state dir>/llm-stats-ranking.json` following the same
 *     cache convention as reasoning-capabilities.json / model-key-affinity.json
 *     (env path override -> dirname(GATEWAY_CONFIG_PATH) -> parent of
 *     dirname(GATEWAY_LOG_PATH));
 *   * on fetch failure (timeout / non-200 / 403 / network / parse) the LAST
 *     CACHE is used; with no cache the module reports "unavailable" and every
 *     model stays unranked — a score is NEVER invented.
 *
 * The matching half is deliberately dependency-free (pure functions) so the
 * whole rule set is unit-testable without a network.
 *
 * @module llm-stats-ranking
 */

import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { createBoundedBuffer } from "./bounded-buffer.mjs";
import { readLlmStatsEnabled } from "./performance-mode.mjs";

/** Source endpoint. Keyless; the licence requires attribution. */
export const LLM_STATS_INDEX_URL = "https://api.zeroeval.com/leaderboard/categories/general/index";

/** Human-facing source name + URL, quoted verbatim in the UI attribution. */
export const LLM_STATS_SOURCE_NAME = "LLM Stats";
export const LLM_STATS_SOURCE_URL = "https://llm-stats.com/";
export const LLM_STATS_ATTRIBUTION = "Data by LLM Stats";

/**
 * Browser User-Agent.
 *
 * The brief reports HTTP 403 for this endpoint when a default/bot User-Agent is
 * sent (verified by the researcher with a normal browser UA). On the machine
 * this module was developed on the endpoint answered 200 either way, so this
 * header is DEFENSIVE rather than strictly required — but it costs nothing and
 * is the documented difference between working and blocked.
 */
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Cache file name inside the gateway state dir (same convention as the other caches). */
const CACHE_FILENAME = "llm-stats-ranking.json";

/** Cache payload format version; an unknown FUTURE version is ignored, not misread. */
export const LLM_STATS_CACHE_FORMAT_VERSION = 1;

/** Default TTL: fetch once per day. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Default per-request timeout. */
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * How long a FAILED refresh suppresses the next one. Without this, every
 * /admin/models call retried a dead upstream (403 / timeout / network) — the
 * Models panel is polled, so that hammered the endpoint and the gateway log.
 * The sibling caches use the same short grace idea (nvidia-catalog-sync.mjs /
 * model-discovery.mjs background-revalidate instead of blocking). Bounded and
 * simple: one timestamp, no retry queue. `force: true` is the explicit operator
 * retry (manual refresh) and bypasses it.
 */
const DEFAULT_FAILURE_BACKOFF_MS = 30_000;

/** Bound on a single response body, so a hostile/broken upstream cannot OOM us. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Bound on cached entries (the live index has ~369; keep headroom, stay bounded). */
const MAX_CACHED_MODELS = 2_000;

// ---------------------------------------------------------------------------
// Matching rules (pure)
// ---------------------------------------------------------------------------

/**
 * Tokens that carry no model identity: capability/mode markers, stage markers
 * and packaging flavours. Dropping them lets our `…-instruct` id line up with
 * the source's bare id, and lets `-flash`/`-high` variants be distinguished by
 * the tokens that REMAIN rather than by the ones dropped.
 */
const DROP_TOKENS = new Set(Object.freeze([
  "max", "high", "xhigh", "thinking", "reasoning", "exp", "medium", "low", "minimal",
  "flash", "highspeed", "nvfp4", "bf16", "fp8", "int4", "int8", "instruct", "it",
  "chat", "preview", "latest", "rc", "beta",
  // Generation tokens (v1, v3, v4, v4.1, v3.2) are NOT here: they ARE model
  // identity. Dropping them left every `deepseek-v*` id with the kept set
  // [deepseek], so an unindexed id inherited the best DeepSeek rank. Minor
  // versions stay distinct too (v3.1 != v3.2 are different releases).
]));

/**
 * Dropped tokens that still CHANGE the model (a different score on the board):
 * speed/size tier (flash, highspeed) and reasoning effort/mode (max, high, …,
 * thinking). They stay out of the prefix/sequence logic like every dropped
 * token, but a sibling match additionally requires BOTH ids to carry the same
 * set of them — so `glm-5.3` never borrows `glm-5.3-flash`'s rank (or the
 * reverse). The remaining DROP_TOKENS are packaging/channel noise of ONE model
 * (instruct/it/chat tuning label, fp8/int4/… quantisation, preview/latest/…
 * release channel) and keep matching freely.
 */
const VARIANT_TOKENS = new Set(Object.freeze([
  "max", "high", "xhigh", "thinking", "reasoning", "medium", "low", "minimal",
  "flash", "highspeed",
]));

/**
 * `v0.1`, `v0.2.3` — a pre-1.0 stage suffix, not part of the name.
 * DOCUMENTED DECISION: pre-1.0 stages are revisions of ONE model, so e.g.
 * `mistral-7b-instruct-v0.2` may take the `v0.3` rank when only that is indexed.
 */
const VERSION_LIKE = /^v0(?:\.\d+)+$/;

/** A generation token `v1`, `v4.1`; used for the v1.0 == v1 and bare == v1 rules. */
const GENERATION = /^v[1-9]\d*(?:\.\d+)*$/;

/**
 * A bare 4-digit release/date code (2407, 0731, 2509, 2512).
 * DOCUMENTED DECISION: a date code is a snapshot of ONE model, so e.g.
 * `mistral-large-2411` may take the `2407` rank when only that is indexed.
 * Also an 8-digit YYYYMMDD snapshot (`kimi-k3-20250711`), restricted to a real
 * 20YY calendar shape so an arbitrary 8-digit number is never dropped. 6-digit
 * YYMMDD is NOT accepted: no fixture or index id uses it.
 */
const DATE_CODE = /^(?:\d{4}|20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))$/;

/** Size markers: 8b, 70b, 22b, 675b, 30b, 128k, 8x22b. */
const SIZE_TOKEN = /^\d+(?:\.\d+)?[bkm]$|^\d+x\d+[bkm]$/;

/**
 * Same model, different token sequence — VERIFIED case by case during the
 * coverage study (each has an external identity proof; a wrong entry here is a
 * wrong score in the UI, so the list stays short and evidence-backed):
 *
 *   * `nv-mistralai/mistral-nemo-12b-instruct` — NVIDIA/Mistral joint model; the
 *     upstream HF release is `mistralai/Mistral-Nemo-Instruct-2407` (2024-07-18).
 *   * `mistralai/mistral-large-2-instruct` — Mistral Large 2; API id
 *     `mistral-large-2407` (2024-07-24).
 *   * `mistralai/codestral-22b-instruct-v0.1` — Codestral 22B (2024-05-29); our
 *     id carries a stage suffix the source does not.
 */
export const VERIFIED_SIBLINGS = new Map(Object.freeze([
  ["nv-mistralai/mistral-nemo-12b-instruct", "mistral-nemo-instruct-2407"],
  ["mistralai/mistral-large-2-instruct", "mistral-large-2-2407"],
  ["mistralai/codestral-22b-instruct-v0.1", "codestral-22b"],
]));

/** @param {unknown} value */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** Lowercase token list. `[^a-z0-9.]` keeps the dots inside `3.2` / `v0.1`. */
export function tokenizeModelId(value) {
  if (typeof value !== "string") return [];
  return value.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
}

/** True for a token that carries no model identity (see DROP_TOKENS + regexes). */
export function isDroppedToken(token) {
  return DROP_TOKENS.has(token) || VERSION_LIKE.test(token) || DATE_CODE.test(token);
}

/** Instrumentation only: how many times normalizeModelId ran (see the test-only export). */
let normalizeCalls = 0;

/**
 * TEST-ONLY: total normalizeModelId calls so far. Lets the tests pin the
 * matcher's cost at O(ids + entries) without a flaky wall-clock assertion.
 * Not part of the runtime contract; no production caller.
 */
export function __TEST_ONLY_normalizeCallCount() {
  return normalizeCalls;
}

/**
 * Normalise a model id into `{ all, kept }`.
 *
 * `all`  — every token (used for the strict "exactly the same id" check).
 * `kept` — identity tokens only (used for the tolerant sibling check).
 *
 * The vendor prefix (everything up to the first `/`) is always stripped, so our
 * `z-ai/glm-5.3` and the source's `glm-5.3` normalise alike.
 */
export function normalizeModelId(value) {
  normalizeCalls += 1;
  let id = typeof value === "string" ? value : "";
  const slash = id.indexOf("/");
  if (slash !== -1) id = id.slice(slash + 1);
  // `v1.0` / `v2.0.0` are the same release as `v1` / `v2`: strip trailing `.0`.
  const all = tokenizeModelId(id).map((t) => (GENERATION.test(t) ? t.replace(/(?:\.0)+$/, "") : t));
  const variants = [...new Set(all.filter((t) => VARIANT_TOKENS.has(t)))].sort().join("|");
  return { all, kept: all.filter((t) => !isDroppedToken(t)), variants };
}

/**
 * Bare-vs-v1 rule: an id with NO generation token names the family's default
 * (first) release, so it may pair with `…-v1` — and ONLY v1; a later release
 * (v2, v1.1) must be spelled out. Returns `kept` with that `v1` removed when
 * the rule applies, otherwise `kept` unchanged.
 */
/**
 * Per-entry normalisation cache, keyed by the entry OBJECT (a refresh builds new
 * objects in extractModels, so old ones simply fall out with their array). The
 * cached record also stores the exact `model_id`/`model_name` strings it was
 * built from and is rebuilt if either changed — an entry mutated in place is
 * never served stale.
 */
const entryCache = new WeakMap();

/** Normalised view of one source entry, or null for a non-object entry. */
function normalizedEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const rawId = entry.model_id;
  const rawName = entry.model_name;
  const cached = entryCache.get(entry);
  if (cached && cached.rawId === rawId && cached.rawName === rawName) return cached;
  const id = normalizeModelId(rawId);
  const name = normalizeModelId(rawName);
  const fields = [];
  if (isNonEmptyString(rawId)) fields.push(id);
  if (isNonEmptyString(rawName)) fields.push(name);
  const variants = [...new Set([...id.variants.split("|"), ...name.variants.split("|")].filter(Boolean))]
    .sort().join("|");
  const record = { rawId, rawName, id, name, fields, variants };
  entryCache.set(entry, record);
  return record;
}

function withDefaultRelease(kept, otherKept) {
  if (!kept.includes("v1") || otherKept.some((t) => GENERATION.test(t))) return kept;
  return kept.filter((t) => t !== "v1");
}

/** Longest common token prefix length. */
function sharedPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

/** True when `a` and `b` are the same token sequence (order included). */
function sameSequence(a, b) {
  return a.length === b.length && a.every((token, i) => token === b[i]);
}

/** Rank used for tie-breaks + ordering; entries without a usable rank sort last. */
function rankOf(entry) {
  return Number.isFinite(entry?.rank) && entry.rank > 0 ? entry.rank : Number.MAX_SAFE_INTEGER;
}

/** True when an entry carries a usable, finite rank — a rankless entry claims nothing. */
function hasUsableRank(entry) {
  return !!entry && Number.isFinite(entry.rank) && entry.rank > 0;
}

/**
 * Which source entries could be the same model as `ourId`, and how confidently.
 *
 * `exact`   — the full token sequences (vendor-stripped) are identical.
 * `sibling` — the identity-token sequences match either as a set (same tokens,
 *             different order) or as an equal-length prefix. This is what lets
 *             `codestral-22b-instruct-v0.1` reach `codestral-22b` and
 *             `nemotron-nano-3-30b-a3b` reach `nemotron-3-nano-30b-a3b`.
 * `rejected`— a STRONG prefix relationship where the longer id adds a
 *             substantive (non-size) token. This is the vision/minitron/coder
 *             trap: `llama-3.2-90b-vision-instruct` vs `llama-3.2-90b-instruct`
 *             looks like a shorten-only difference until you notice `vision`
 *             is not a size marker. Never matched.
 *
 * `model_name` is considered alongside `model_id` because the source sometimes
 * spells a variant only in the human name ("GPT-OSS 20B (high)").
 */
function classifyCandidate(ours, theirsEntry) {
  if (!ours.kept.length || !theirsEntry) return "none";
  // Variant identity of the ENTRY is the union of its id and its name: a flash
  // entry named "GLM 5.3" is still the flash model (and vice versa).
  const sameVariant = ours.variants === theirsEntry.variants;

  for (const theirs of theirsEntry.fields) {
    if (!theirs.kept.length) continue;

    if (sameVariant && sameSequence(ours.all, theirs.all)) return "exact";
    const oursKept = withDefaultRelease(ours.kept, theirs.kept);
    const theirsKept = withDefaultRelease(theirs.kept, ours.kept);
    // A sibling must be the SAME variant (flash/high/… both ways, see VARIANT_TOKENS).
    if (sameVariant && !sameSequence(oursKept, theirsKept)) {
      const sameSet = oursKept.length >= 2
        && theirsKept.length >= 2
        && [...oursKept].sort().join("|") === [...theirsKept].sort().join("|");
      if (sameSet) return "sibling";
    }
    if (sameVariant && oursKept.length === theirsKept.length && sameSequence(oursKept, theirsKept)) return "sibling";

    // Strong prefix relationship (one kept sequence is a prefix of the other's
    // PREFIX — i.e. they share the full shorter sequence in order).
    const shorter = oursKept.length <= theirsKept.length ? oursKept : theirsKept;
    const longer = oursKept.length <= theirsKept.length ? theirsKept : oursKept;
    if (shorter.length > 0 && sameSequence(shorter, longer.slice(0, shorter.length))) {
      const extra = longer.filter((t) => !shorter.includes(t));
      if (extra.length > 0 && extra.some((t) => !SIZE_TOKEN.test(t))) return "rejected";
    }
  }
  return "none";
}

/**
 * Pick the best candidate of a given class: longest shared prefix first, then
 * the best (lowest) published rank. Returns null when there is no candidate.
 */
function bestCandidate(ours, entries, kind) {
  let best = null;
  let bestPrefix = -1;
  let bestRank = Number.MAX_SAFE_INTEGER;

  for (const entry of entries) {
    const theirs = normalizedEntry(entry);
    if (classifyCandidate(ours, theirs) !== kind) continue;
    if (!hasUsableRank(entry)) continue;
    const prefix = Math.max(
      sharedPrefixLength(ours.kept, theirs.id.kept),
      sharedPrefixLength(ours.kept, theirs.name.kept),
    );
    const rank = rankOf(entry);
    if (prefix > bestPrefix || (prefix === bestPrefix && rank < bestRank)) {
      best = entry;
      bestPrefix = prefix;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Shape one public ranking row from a source entry.
 *
 * `matched_via` is `'exact'` or `'sibling'` so a caller (and the tests) can tell
 * a literal id match from a tolerant one.
 */
function toRankingRow(entry, matchedVia) {
  return {
    model_id: entry.model_id,
    model_name: isNonEmptyString(entry.model_name) ? entry.model_name : entry.model_id,
    organization_id: isNonEmptyString(entry.organization_id) ? entry.organization_id : null,
    rank: entry.rank,
    conservative: Number.isFinite(entry.conservative) ? entry.conservative : null,
    matched_via: matchedVia,
  };
}

/**
 * Find the LLM Stats entry for ONE of our model ids.
 *
 * Exact first, then (only if there is no exact match) the verified sibling
 * overrides, then the tolerant token sibling. Returns null — never a guess —
 * when nothing qualifies, including when the input or the index is malformed.
 *
 * @param {unknown} ourId
 * @param {unknown} entries the source `models` array
 * @returns {{ model_id: string, model_name: string, organization_id: string|null,
 *             rank: number, conservative: number|null, matched_via: 'exact'|'sibling' } | null}
 */
export function matchRankingEntry(ourId, entries) {
  if (!isNonEmptyString(ourId)) return null;
  if (!Array.isArray(entries) || entries.length === 0) return null;

  // A VERIFIED override is a deliberate, evidence-backed decision; honour it first.
  const override = VERIFIED_SIBLINGS.get(ourId);
  if (override) {
    const entry = entries.find((e) => e && e.model_id === override && hasUsableRank(e));
    return entry ? toRankingRow(entry, "sibling") : null;
  }

  // Normalise OUR id once per call; entries come from the per-entry cache.
  const ours = normalizeModelId(ourId);
  const exact = bestCandidate(ours, entries, "exact");
  if (exact) return toRankingRow(exact, "exact");

  const sibling = bestCandidate(ours, entries, "sibling");
  if (sibling) return toRankingRow(sibling, "sibling");

  return null;
}

/**
 * Fold a whole catalogue over the index.
 *
 * @param {unknown} ourIds iterable of our model ids
 * @param {unknown} entries the source `models` array
 * @returns {Map<string, ReturnType<typeof toRankingRow>>} keyed by our EXACT id;
 *          ids with no genuine counterpart are simply absent (the UI shows "—").
 */
export function matchCatalog(ourIds, entries) {
  const out = new Map();
  if (!ourIds || typeof ourIds[Symbol.iterator] !== "function" || !Array.isArray(entries)) return out;
  for (const id of ourIds) {
    const row = matchRankingEntry(id, entries);
    if (row) out.set(id, row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cache path resolution + persistence (same convention as the sibling caches)
// ---------------------------------------------------------------------------

/**
 * Resolve the cache path. Preference order:
 *   GATEWAY_LLM_STATS_CACHE_PATH → dirname(GATEWAY_CONFIG_PATH) → parent of
 *   dirname(GATEWAY_LOG_PATH). Returns null when nothing is known (memory-only).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function resolveLlmStatsCachePath(env = process.env) {
  const e = /** @type {Record<string, string|undefined>} */ (env);
  if (isNonEmptyString(e.GATEWAY_LLM_STATS_CACHE_PATH) && e.GATEWAY_LLM_STATS_CACHE_PATH.trim()) {
    return e.GATEWAY_LLM_STATS_CACHE_PATH;
  }
  if (isNonEmptyString(e.GATEWAY_CONFIG_PATH) && e.GATEWAY_CONFIG_PATH.trim()) {
    return path.join(path.dirname(e.GATEWAY_CONFIG_PATH), CACHE_FILENAME);
  }
  if (isNonEmptyString(e.GATEWAY_LOG_PATH) && e.GATEWAY_LOG_PATH.trim()) {
    return path.join(path.dirname(path.dirname(e.GATEWAY_LOG_PATH)), CACHE_FILENAME);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {{ models: object[]|null, fetchedAt: number|null, cachePath: string|null|undefined, loaded: boolean, loadedFromCache: boolean }} */
const state = {
  models: null,
  fetchedAt: null,
  cachePath: resolveLlmStatsCachePath(),
  loaded: false,
  loadedFromCache: false,
};

/** Pluggable fetcher so tests never touch the network. */
let fetcher = defaultFetchIndex;

/** Resolved TTL. */
let ttlMs = resolveTtlMs(process.env);

/** In-flight fetch, so concurrent callers share one request. */
let refreshInFlight = null;

/**
 * Timestamp of the last FAILED refresh, or null. Consulted before a fresh
 * fetch: inside the backoff window a caller gets the existing cache (or null)
 * WITHOUT a new upstream request. Cleared by any success or by `force: true`.
 * @type {number | null}
 */
let lastFailureAt = null;

/** Resolved failure-backoff window (env override, else the 30s default). */
function resolveFailureBackoffMs(env) {
  const raw = Number.parseInt(/** @type {any} */ (env)?.GATEWAY_LLM_STATS_FAILURE_BACKOFF_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FAILURE_BACKOFF_MS;
}

function resolveTtlMs(env) {
  const raw = Number.parseInt(/** @type {any} */ (env)?.GATEWAY_LLM_STATS_TTL_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

function resolveTimeoutMs(env) {
  const raw = Number.parseInt(/** @type {any} */ (env)?.GATEWAY_LLM_STATS_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FETCH_TIMEOUT_MS;
}

/** Logger seam (gateway.jsonl via the caller); defaults to a no-op in tests. */
let logger = () => {};

/**
 * Adopt a caller-supplied logger for ONE call. The production caller
 * (admin-api.mjs:280-283) passes `{ logger: (outcome) => logInfo(...) }` so a
 * failed/timeout/403 fetch lands in gateway.jsonl; the module previously read
 * only `options.force`, silently dropping it. A non-function is ignored so the
 * no-op default survives hostile input.
 * @param {unknown} candidate
 */
function adoptLogger(candidate) {
  if (typeof candidate === "function") logger = candidate;
}

/**
 * HTTPS GET returning parsed JSON. Rejects on non-2xx (including 403), network
 * error, timeout, oversized body, or unparseable JSON.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
function defaultFetchIndex(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    // resolve/reject are idempotent; `settled` only gates side effects (destroy, parse).
    let settled = false;
    const settle = (fn, value) => { settled = true; fn(value); };
    const req = https.get(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume();
        settle(reject, new Error(`LLM Stats index returned HTTP ${status}`));
        return;
      }
      const collector = createBoundedBuffer(MAX_RESPONSE_BYTES);
      // A mid-body reset fires only aborted/close on res (no error/end), so "close" settles too.
      res.on("error", (err) => settle(reject, err));
      res.on("close", () => settle(reject, new Error("LLM Stats index response closed before end")));
      res.on("data", (chunk) => {
        if (settled || collector.push(chunk)) return;
        const tooLarge = new Error("LLM Stats index response too large");
        settle(reject, tooLarge); // reject first, then tear down the socket
        req.destroy(tooLarge);
      });
      res.on("end", () => {
        if (settled) return;
        try {
          settle(resolve, JSON.parse(collector.toBuffer().toString("utf8")));
        } catch (err) {
          settle(reject, new Error(`Failed to parse LLM Stats index: ${err.message}`));
        }
      });
    });
    req.on("error", (err) => settle(reject, err));
    req.setTimeout(timeoutMs, () => req.destroy(new Error("LLM Stats index timeout")));
  });
}

/** Extract the usable `models` array from a raw payload, or null. */
function extractModels(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const models = /** @type {{ models?: unknown }} */ (payload).models;
  if (!Array.isArray(models)) return null;
  const cleaned = [];
  for (const entry of models) {
    if (cleaned.length >= MAX_CACHED_MODELS) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (!isNonEmptyString(entry.model_id)) continue;
    if (!hasUsableRank(entry)) continue;
    cleaned.push({
      model_id: entry.model_id,
      model_name: isNonEmptyString(entry.model_name) ? entry.model_name : entry.model_id,
      organization_id: isNonEmptyString(entry.organization_id) ? entry.organization_id : null,
      rank: entry.rank,
      conservative: Number.isFinite(entry.conservative) ? entry.conservative : null,
    });
  }
  return cleaned.length > 0 ? cleaned : null;
}

/** Read the persisted cache once. A malformed/unknown-version file is ignored. */
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    if (parsed.version !== LLM_STATS_CACHE_FORMAT_VERSION) return;
    const models = extractModels(parsed);
    if (!models) return;
    state.models = models;
    state.fetchedAt = Number.isFinite(parsed.fetched_at) ? parsed.fetched_at : null;
    state.loadedFromCache = true;
  } catch {
    // Corrupt cache — ignore it and fall back to a live fetch.
  }
}

/** Persist the cache. Failures are swallowed: a cache is an optimisation only. */
function persist(models, fetchedAt) {
  if (!state.cachePath) return;
  try {
    const payload = {
      version: LLM_STATS_CACHE_FORMAT_VERSION,
      fetched_at: fetchedAt,
      source: LLM_STATS_SOURCE_URL,
      attribution: LLM_STATS_ATTRIBUTION,
      models,
    };
    fs.mkdirSync(path.dirname(state.cachePath), { recursive: true });
    const tmp = `${state.cachePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
    fs.renameSync(tmp, state.cachePath);
  } catch {
    // Never let a cache write failure break the ranking.
  }
}

/**
 * Test seam: replace the HTTPS fetcher.
 * @param {(url: string, timeoutMs: number) => Promise<unknown>} impl
 */
export function __setFetcherForTests__(impl) {
  fetcher = typeof impl === "function" ? impl : defaultFetchIndex;
}

/** Test seam: capture the logger seam. */
export function __setLoggerForTests__(impl) {
  logger = typeof impl === "function" ? impl : () => {};
}

/** Test seam: reset module state (cache, TTL, fetcher) between tests. */
export function __resetForTests__() {
  state.models = null;
  state.fetchedAt = null;
  state.loaded = true; // tests run without a cache file
  state.loadedFromCache = false;
  refreshInFlight = null;
  lastFailureAt = null;
  fetcher = defaultFetchIndex;
  logger = () => {};
  ttlMs = DEFAULT_TTL_MS;
}

/** Test seam: force TTL. */
export function __setTtlMsForTests__(ms) {
  ttlMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TTL_MS;
}

/** Read-only view of what is loaded (no network). */
export function getLlmStatsSnapshot() {
  // Opt-out: report nothing and do not even read the local cache file.
  if (!readLlmStatsEnabled()) return { available: false, fromCache: false, fetchedAt: null, count: 0 };
  ensureLoaded();
  return {
    available: !!(state.models && state.models.length > 0),
    fromCache: state.loadedFromCache,
    fetchedAt: state.fetchedAt,
    count: state.models ? state.models.length : 0,
  };
}

/**
 * Fetch the index (once per TTL) and return its `models` array.
 *
 * NEVER throws and NEVER invents data: on any failure it returns the last cache,
 * or `null` when there is nothing cached (the caller then leaves every model
 * unranked). The failure is logged honestly through the logger seam — a
 * caller-supplied `options.logger` takes effect for that call (production wires
 * gateway.jsonl here); `__setLoggerForTests__` remains the unit-level seam.
 *
 * A FAILED refresh is backed off (DEFAULT_FAILURE_BACKOFF_MS): callers inside
 * the window get the existing cache / null without a new upstream request, so a
 * polled endpoint cannot hammer a dead upstream. `force: true` (explicit manual
 * refresh) bypasses both the TTL and the failure backoff.
 *
 * @param {{ force?: boolean, logger?: (outcome: object) => void }} [options]
 * @returns {Promise<object[]|null>}
 */
export async function getRankingEntries(options = {}) {
  adoptLogger(options.logger);
  // Owner opt-out (config.json `llmStatsEnabled: false`, re-read per call through
  // the mtime cache): NO request to the upstream at all — not a TTL refresh, not a
  // background refresh, not `force`. The local cache file is neither read nor
  // written, and callers get null (every model unranked, same as a failed fetch).
  if (!readLlmStatsEnabled()) return null;
  ensureLoaded();
  const now = Date.now();
  const fresh = state.models && state.fetchedAt !== null && (now - state.fetchedAt) < ttlMs;
  if (fresh && options.force !== true) return state.models;
  // Failure backoff: after a failed refresh, do not retry on every caller until
  // the window elapses. `force` is the explicit operator retry.
  if (options.force !== true && lastFailureAt !== null && (now - lastFailureAt) < resolveFailureBackoffMs(process.env)) {
    return state.models && state.models.length > 0 ? state.models : null;
  }
  if (refreshInFlight) return refreshInFlight;

  const promise = (async () => {
    try {
      const payload = await fetcher(LLM_STATS_INDEX_URL, resolveTimeoutMs(process.env));
      const models = extractModels(payload);
      if (!models) throw new Error("LLM Stats index carried no usable models");
      state.models = models;
      state.fetchedAt = Date.now();
      state.loadedFromCache = false;
      lastFailureAt = null;
      persist(models, state.fetchedAt);
      logger({ event: "llm_stats_index_refreshed", count: models.length });
      return models;
    } catch (error) {
      const message = error && typeof error.message === "string" ? error.message : String(error);
      lastFailureAt = Date.now();
      logger({ event: "llm_stats_index_failed", error: message, usingCache: !!(state.models && state.models.length) });
      return state.models && state.models.length > 0 ? state.models : null;
    } finally {
      refreshInFlight = null;
    }
  })();
  refreshInFlight = promise;
  return promise;
}

/**
 * The ranking for a whole catalogue: one fetch, then the pure matcher.
 *
 * @param {unknown} ourIds
 * @param {{ force?: boolean, logger?: (outcome: object) => void }} [options]
 * @returns {Promise<Map<string, object>>} empty when no index is available
 */
export async function getCatalogRanking(ourIds, options = {}) {
  const entries = await getRankingEntries(options);
  if (!entries) return new Map();
  return matchCatalog(ourIds, entries);
}

/**
 * The ranking for a whole catalogue WITHOUT waiting on the network: rank the
 * ids against whatever index is already loaded (memory or persisted cache) and
 * kick off a refresh in the BACKGROUND so the NEXT call carries fresh ranks.
 *
 * WHY this exists: the admin Models panel is polled with a bounded client
 * timeout, while a cold-start LLM Stats fetch can legitimately take up to its
 * own timeout. Awaiting the fetch on the /admin/models critical path made a
 * cold start + slow upstream look like a dead panel. Serving the loaded index
 * immediately — and refreshing behind the response — keeps the catalogue fast
 * WITHOUT ever inventing a rank: while nothing is cached the map is simply
 * empty (every model unranked, the UI shows "—").
 *
 * The background refresh routes through getRankingEntries(), so the existing
 * TTL, single-flight dedup, failure backoff, caller logger seam and persistence
 * all apply unchanged; getRankingEntries() never throws or rejects, but the
 * promise is still guarded so an unexpected rejection cannot crash the gateway.
 *
 * @param {unknown} ourIds
 * @param {{ force?: boolean, logger?: (outcome: object) => void }} [options]
 * @returns {Promise<Map<string, object>>} empty when no index is loaded
 */
export async function getCatalogRankingFromCache(ourIds, options = {}) {
  // Opt-out: no rank served (llmStatsRank omitted from /admin/models) and no
  // background refresh kicked off. Re-enabling takes effect on the next call.
  if (!readLlmStatsEnabled()) return new Map();
  // Load the persisted cache BEFORE reading state.models: a cold process must
  // serve the on-disk index on the FIRST call, not only once the background
  // refresh below has run. ensureLoaded() is synchronous and never throws.
  ensureLoaded();
  const entries = state.models;
  const ranking = entries && entries.length > 0 ? matchCatalog(ourIds, entries) : new Map();
  // Fire-and-forget: do NOT await. The caller's response must not be delayed by
  // the upstream fetch; errors are swallowed (getRankingEntries is defensive).
  void getRankingEntries(options).catch(() => {});
  return ranking;
}
