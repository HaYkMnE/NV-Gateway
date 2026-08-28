// @ts-check

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{ context: number, output: number }} ModelLimit
 */

/**
 * Hard fallback when no config is available anywhere.
 * Matches the "*" wildcard defaults from config.example.json.
 */
const HARD_FALLBACK = Object.freeze({ context: 131072, output: 4096 });

/** @type {Record<string, ModelLimit> | null} */
let limitsCache = null;

// ───────────────────────────────────────────────────────────────────────────
// Runtime-injected limits (bound IPC channel)
//
// In the PACKAGED app none of the file/env resolution paths below exist
// reliably, so the Electron main process attaches a sanitized, NUMBERS-ONLY
// copy of the operator's config.json `modelLimits` to the gateway initial
// state; it rides the challenge-bound `state:init` channel and server.mjs
// hands it here via {@link setModelLimits}. Injected entries win lookups
// BEFORE any file-based resolution; file/env paths stay authoritative for
// dev/tests where nothing is injected. No secrets, no paths — sanitized on
// BOTH sides (main producer + this consumer).
// ───────────────────────────────────────────────────────────────────────────

/** @type {Record<string, ModelLimit>} */
let injectedLimits = {};

/** Defense-in-depth caps for injected records (mirrors main-side sanitizer). */
const MAX_INJECTED_MODEL_LIMITS = 512;
const MAX_INJECTED_MODEL_LIMIT_KEY_LENGTH = 256;

/**
 * Parse an injected limit entry: positive safe integers only, numbers ONLY.
 * Stricter than {@link parseLimitEntry} (no string coercion) because the
 * main-process producer is expected to send already-normalized JSON numbers.
 * @param {unknown} entry
 * @returns {ModelLimit | null}
 */
function parseInjectedLimitEntry(entry) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    /** @type {Record<string, unknown>} */
    const obj = entry;
    const context = obj.context;
    const output = obj.output;
    if (typeof context !== "number" || !Number.isSafeInteger(context) || context <= 0) return null;
    if (typeof output !== "number" || !Number.isSafeInteger(output) || output <= 0) return null;
    return { context, output };
}

function resolveConfigPath() {
    // 1) Explicit env override
    if (process.env.GATEWAY_CONFIG_PATH) {
        return process.env.GATEWAY_CONFIG_PATH;
    }

    // 2) Derive from GATEWAY_STATE_PATH directory (config.json sibling)
    const statePath = process.env.GATEWAY_STATE_PATH;
    if (statePath) {
        const dir = path.dirname(statePath);
        return path.join(dir, "config.json");
    }

    // 3) Project-relative fallback: config/config.example.json
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const projectRoot = path.resolve(__dirname, "..", ".."); // src/gateway → project root
    const exampleConfig = path.join(projectRoot, "config", "config.example.json");
    if (fs.existsSync(exampleConfig)) {
        return exampleConfig;
    }

    return null;
}

/**
 * Parse a model limit entry. Returns null if shape is invalid.
 * @param {unknown} entry
 * @returns {ModelLimit | null}
 */
function parseLimitEntry(entry) {
    if (typeof entry !== "object" || entry === null) return null;
    /** @type {Record<string, unknown>} */
    const obj = /** @type {Record<string, unknown>} */ (entry);
    const context = Number.parseInt(String(obj.context), 10);
    const output = Number.parseInt(String(obj.output), 10);
    if (!Number.isFinite(context) || !Number.isFinite(output) || context <= 0 || output <= 0) return null;
    return { context, output };
}

function loadModelLimits() {
    limitsCache = {};

    const configPath = resolveConfigPath();
    if (!configPath) return;

    try {
        const raw = fs.readFileSync(configPath, "utf8");
        const sanitized = raw.codePointAt(0) === 0xFEFF ? raw.slice(1) : raw;
        const config = JSON.parse(sanitized);

        if (config && typeof config.modelLimits === "object" && config.modelLimits !== null) {
            /** @type {Record<string, ModelLimit>} */
            const limits = {};
            for (const [key, entry] of Object.entries(config.modelLimits)) {
                const parsed = parseLimitEntry(entry);
                if (parsed) {
                    limits[key] = parsed;
                }
            }
            limitsCache = limits;
        }
    } catch (_e) {
        // Config absent or malformed — empty cache, fallback handles it.
    }
}

/**
 * Accept runtime-injected model limits from the main process (the `state:init`
 * IPC payload field `modelLimits`). Merges OVER file-based loading: injected
 * exact and wildcard entries are consulted before any config-file resolution.
 *
 * Sanitization: numbers only (positive safe integers), string keys bounded in
 * length, record capped at {@link MAX_INJECTED_MODEL_LIMITS} entries, malformed
 * entries dropped. A non-object argument is ignored entirely (previous
 * injection retained); a valid but empty object clears prior injections. The
 * stored record never contains secrets or paths by construction.
 *
 * @param {unknown} record Expected shape: Record<string, { context: number, output: number }>
 * @returns {void}
 */
export function setModelLimits(record) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) return;
    /** @type {Record<string, ModelLimit>} */
    const sanitized = {};
    for (const [key, entry] of Object.entries(record)) {
        if (Object.keys(sanitized).length >= MAX_INJECTED_MODEL_LIMITS) break;
        if (typeof key !== "string" || key.length === 0 || key.length > MAX_INJECTED_MODEL_LIMIT_KEY_LENGTH) continue;
        const parsed = parseInjectedLimitEntry(entry);
        if (parsed) sanitized[key] = parsed;
    }
    injectedLimits = sanitized;
}

/**
 * Look up model limits.
 *
 * Priority:
 *  1. Runtime-injected exact match (bound IPC channel — production path)
 *  2. Runtime-injected wildcard "*" entry
 *  3. Exact model ID match in config.modelLimits
 *  4. Wildcard "*" entry in config.modelLimits
 *  5. Hardcoded safe fallback (131072 context, 4096 output)
 *
 * @param {string} modelId
 * @returns {{ context: number, output: number }}
 */
export function getModelLimits(modelId) {
    if (limitsCache === null) {
        loadModelLimits();
    }

    // Runtime-injected limits (highest priority — see setModelLimits).
    const injectedExact = injectedLimits[modelId];
    if (injectedExact && injectedExact.context > 0 && injectedExact.output > 0) {
        return { context: injectedExact.context, output: injectedExact.output };
    }
    const injectedWildcard = injectedLimits["*"];
    if (injectedWildcard && injectedWildcard.context > 0 && injectedWildcard.output > 0) {
        return { context: injectedWildcard.context, output: injectedWildcard.output };
    }

    // File-based limits (dev/tests; also the env-config path).
    if (limitsCache) {
        const exact = limitsCache[modelId];
        if (exact && exact.context > 0 && exact.output > 0) {
            return { context: exact.context, output: exact.output };
        }

        // Wildcard fallback
        const wildcard = limitsCache["*"];
        if (wildcard && wildcard.context > 0 && wildcard.output > 0) {
            return { context: wildcard.context, output: wildcard.output };
        }
    }

    // Hard fallback
    return { context: HARD_FALLBACK.context, output: HARD_FALLBACK.output };
}

/**
 * Reset limits cache AND any runtime-injected limits. Useful for testing.
 */
export function resetModelLimitsCache() {
    limitsCache = null;
    injectedLimits = {};
}

// ───────────────────────────────────────────────────────────────────────────
// disabledModels (config.json `disabledModels: string[]`)
//
// The gateway child reads the operator-curated disabled-models list from the
// SAME config file as modelLimits (resolved by {@link resolveConfigPath}).
// modelLimits is cached once for the process; disabledModels must reflect
// config edits promptly (a UI toggle must take effect on the next request),
// so it uses an mtime+size-keyed cache (mirrors performance-mode.mjs): a stat
// that matches the last read reuses the cached list; a changed file re-reads.
// Defensive: missing/unreadable/non-array -> [] (never throws, never crashes a
// request).
// ───────────────────────────────────────────────────────────────────────────

/** @type {{ ids: string[], mtimeMs: number | null, size: number | null } | null} */
let disabledCache = null;

function readDisabledModels() {
    const configPath = resolveConfigPath();
    if (!configPath) {
        disabledCache = { ids: [], mtimeMs: null, size: null };
        return [];
    }
    let stat;
    try {
        stat = fs.statSync(configPath);
    } catch {
        // Transit FS error: keep serving the last-known list (or [] on cold start).
        return disabledCache ? disabledCache.ids : [];
    }
    if (disabledCache && disabledCache.mtimeMs === stat.mtimeMs && disabledCache.size === stat.size) {
        return disabledCache.ids;
    }
    let ids = [];
    try {
        const raw = fs.readFileSync(configPath, "utf8");
        const sanitized = raw.codePointAt(0) === 0xFEFF ? raw.slice(1) : raw;
        const config = JSON.parse(sanitized);
        if (Array.isArray(config?.disabledModels)) {
            // F1: normalize to lowercase at read time so all comparison sites can
            // match case-insensitively against the canonical (lowercase) NVIDIA
            // ids. An operator config typo ("DeepSeek-AI/..." vs "deepseek-ai/...")
            // no longer silently defeats the disable. Raw config array is untouched;
            // only the cached comparison keys are normalized.
            ids = config.disabledModels
                .filter((id) => typeof id === "string" && id.length > 0)
                .map((id) => String(id).toLowerCase());
        }
    } catch {
        // Unreadable/malformed: treat as [] but DO NOT poison the cache with the
        // error — a later stat change (operator fixes the file) re-reads.
    }
    disabledCache = { ids, mtimeMs: stat.mtimeMs, size: stat.size };
    return ids;
}

/**
 * Read the disabled model ids from the gateway config (defensive: never throws).
 * @returns {string[]}
 */
export function getDisabledModels() {
    return readDisabledModels();
}

/**
 * Reset the disabled-models cache. Useful for testing.
 */
export function resetDisabledModelsCache() {
    disabledCache = null;
}