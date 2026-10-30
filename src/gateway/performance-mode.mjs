// Runtime performance profiles for the gateway.
//
// The user selects a mode manually ("day" | "night" | "auto") in Settings; it is
// persisted in the app config (performanceMode), read by the gateway child from
// GATEWAY_CONFIG_PATH. Explicit GATEWAY_* env tuning vars always win over profile
// values (per knob). When mode is "auto", the effective profile is derived from
// recent REAL request outcomes (rolling window + asymmetric thresholds + minimum
// dwell time) — never from the wall clock.

import fs from "node:fs";
import { MAX_CONFIGURED_FAILOVER_ATTEMPTS } from "./failover-policy.mjs";
import { MAX_UPSTREAM_TIMEOUT_MS, isValidRequestDeadlineMs } from "./upstream-timeouts.mjs";

export const PROFILES = Object.freeze({
    day: Object.freeze({
        firstByteTimeoutMs: 300_000,
        idleTimeoutMs: 300_000,
        maxStreamDurationMs: 1_800_000,
        maxFailoverAttempts: 3
    }),
    night: Object.freeze({
        firstByteTimeoutMs: 120_000,
        idleTimeoutMs: 120_000,
        maxStreamDurationMs: 600_000,
        maxFailoverAttempts: 2
    })
});

const VALID_MODES = new Set(["day", "night", "auto"]);
const WINDOW_SIZE = 20;
const MIN_SAMPLES = 10;
// Minimum time between two auto switches. Evidence: the live log holds 107 logged
// auto transitions, 38 of them separated by less than 5 minutes (and 49 under 10
// minutes) — the GLOBAL mode was effectively thrashing. Replaying the same real
// outcome stream through this module's rules (sandbox calibration, 8123 outcomes
// 2026-09-09..19) shows gaps<5min: 39 at 120s dwell vs 0 at 600s dwell, min gap
// 600s; a 900s dwell also drives gaps<15min to 0 at the cost of 10 fewer useful
// transitions, so 10 minutes is the knee. 600_000 = knee between the 5-minute
// flap band and an over-slow reaction.
const MIN_DWELL_MS = 600_000;
// Consecutive evaluations that must agree on a candidate mode before this module
// commits to it. One sample of the 20-outcome window was enough to flip the mode
// before; the same replay shows 3 confirmations leave every measured transition
// intact while a single evaluation no longer can. 3 = the smallest streak that
// survived the replay without changing the mode's direction on real data.
const AUTO_SWITCH_CONFIRMATIONS = 3;
// Pressure-driven outcomes: first-byte stalls and broken/hung upstream streams.
const PRESSURE_OUTCOMES = new Set([
    "first_byte_timeout",
    "idle_timeout",
    "upstream_stream_error",
    "max_stream_duration"
]);
// Auto switching (asymmetric = hysteresis). The DIRECTION is fixed by design —
// slow upstream => day (patient 5-minute budgets), fast upstream => night (fast
// 2-minute budgets) — and day/night are FORMAL labels, never a wall clock.
//
// The window is GLOBAL (it mixes all models), so one persistently dead model can
// cap the best achievable cleanliness. The bars are therefore RATIOS, not the
// absolutist "0 first-byte timeouts" the module used before:
//  day -> night: >=16/20 completed AND <=15% pressure. A clean window reaches
//    0/20; 16/20 completed already bounds pressure to <=4/20, and one isolated
//    blip (1/20 = 5%) must not veto an otherwise healthy stretch, while the old
//    "0 first-byte timeouts" requirement made promotion nearly unreachable under
//    exactly the cross-model pollution this module cannot avoid.
//  night -> day: >=4 first-byte timeouts OR >=40% pressure. The old 2-timeout
//    trigger fired on 20/20 of the logged demotes' windows (evidence: 31 of the
//    52 logged demotes carried pressure=2/20 or 3/20) — a single noisy pair. 4/20
//    and 40% are reached only by a window that is genuinely dominated by stalls
//    (the 2026-09-18 day, 469 first-byte timeouts, sits far above both).
const AUTO_PROMOTE_MIN_COMPLETED = 16;
// Cleanliness companion to the promote bar (see above): 15% = 3/20 pressure.
const AUTO_PROMOTE_MAX_PRESSURE_RATIO = 0.15;
// Sustained-stall demote bar: >=4/20 first-byte timeouts in the window.
const AUTO_DEMOTE_FIRST_BYTE_TIMEOUTS = 4;
// Sustained-stall demote bar: >=40% of the window is pressure outcomes.
const AUTO_DEMOTE_PRESSURE_RATIO = 0.4;

const ENV_FIRST_BYTE = "GATEWAY_FIRST_BYTE_TIMEOUT_MS";
const ENV_IDLE = "GATEWAY_IDLE_TIMEOUT_MS";
const ENV_STREAM = "GATEWAY_MAX_STREAM_DURATION_MS";
const ENV_FAILOVER = "GATEWAY_MAX_FAILOVER_ATTEMPTS";

function parseBoundedInteger(raw, min, max) {
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) return null;
    return Math.min(max, Math.max(min, value));
}

function parseStrictBoundedInteger(raw, min, max) {
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function parseTimeoutOverride(raw) {
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 1 && value <= 1_800_000 ? value : null;
}

// ─── Per-model performanceMode overrides ────────────────────────────────────
//
// config.perModelSettings[modelId].performanceMode is the operator's explicit
// profile for ONE model. Matching follows the SAME convention as the sibling
// perModelSettings knobs in this file (readPerModelFailoverOverrides) and in
// model-limits.mjs: both the config keys and the requested id are lowercased, so
// "Vendor/MODEL" in config answers a request for "vendor/model". Matching stays
// EXACT about the id itself — "moonshotai/kimi-k2" never bleeds into
// "moonshotai/kimi-k2-extra". Only the concrete profiles ("day"/"night") apply;
// "auto" is a global evidence-driven mode, not a per-request override, so an
// invalid or auto value falls back to the global mode. Explicit GATEWAY_* env
// knobs stay layered ABOVE both (applyEnvOverrides runs last).

const CONCRETE_PROFILE_MODES = new Set(["day", "night"]);

function isPositiveInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

const unifiedConfigCache = {
    recordsLoaded: false,
    configPath: null,
    mtimeMs: null,
    size: null,
    selectedMode: "day",
    perModelModes: null,
    perModelFailovers: {},
    requestDeadlineMs: null,
    llmStatsEnabled: true
};

function readUnifiedConfig(configPath) {
    if (typeof configPath !== "string" || configPath.length === 0) {
        return { selectedMode: "day", perModelModes: null, perModelFailovers: {}, requestDeadlineMs: null, llmStatsEnabled: true };
    }

    let stat;
    try {
        stat = fs.statSync(configPath);
    } catch {
        if (unifiedConfigCache.configPath === configPath) {
            return unifiedConfigCache;
        }
        return { selectedMode: "day", perModelModes: null, perModelFailovers: {}, requestDeadlineMs: null, llmStatsEnabled: true };
    }

    if (unifiedConfigCache.recordsLoaded
        && unifiedConfigCache.configPath === configPath
        && unifiedConfigCache.mtimeMs === stat.mtimeMs
        && unifiedConfigCache.size === stat.size) {
        return unifiedConfigCache;
    }

    let selectedMode = "day";
    let perModelModes = null;
    let perModelFailovers = {};
    let requestDeadlineMs = null;
    let llmStatsEnabled = true;

    try {
        const raw = fs.readFileSync(configPath, "utf8");
        const parsed = JSON.parse(raw.codePointAt(0) === 0xFEFF ? raw.slice(1) : raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            if (VALID_MODES.has(parsed.performanceMode)) {
                selectedMode = parsed.performanceMode;
            }
            // Э1b app setting (§12.11 Р4); out-of-range/non-integer -> absent.
            if (isValidRequestDeadlineMs(parsed.requestDeadlineMs)) {
                requestDeadlineMs = parsed.requestDeadlineMs;
            }
            // LLM Stats opt-out: ONLY the literal `false` disables; absent or
            // non-boolean keeps the default (enabled), so old configs are unchanged.
            if (parsed.llmStatsEnabled === false) llmStatsEnabled = false;
            const settings = parsed.perModelSettings;
            if (settings && typeof settings === "object" && !Array.isArray(settings)) {
                perModelModes = {};
                for (const [modelId, value] of Object.entries(settings)) {
                    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
                    const key = String(modelId).toLowerCase();
                    if (typeof value.performanceMode === "string") {
                        perModelModes[key] = { performanceMode: value.performanceMode };
                    }
                    const record = {};
                    if (isPositiveInteger(value.maxFailoverAttempts)) record.maxFailoverAttempts = value.maxFailoverAttempts;
                    if (isPositiveInteger(value.rateLimitMaxAttempts)) record.rateLimitMaxAttempts = value.rateLimitMaxAttempts;
                    // Bounded ABOVE by the same documented ceiling as the env knob
                    // (upstream-timeouts.mjs MAX_UPSTREAM_TIMEOUT_MS = 30 min), so a
                    // hostile/typo value (e.g. 10^12) is REJECTED — the model then
                    // keeps its profile default — instead of being cached as an
                    // effectively infinite first-byte wait.
                    if (isPositiveInteger(value.firstByteTimeoutMs) && value.firstByteTimeoutMs <= MAX_UPSTREAM_TIMEOUT_MS) {
                        record.firstByteTimeoutMs = value.firstByteTimeoutMs;
                    }
                    if (Object.keys(record).length > 0) perModelFailovers[key] = record;
                }
            }
        }
    } catch {
        // Corrupt or unreadable JSON: fallback
    }

    unifiedConfigCache.recordsLoaded = true;
    unifiedConfigCache.configPath = configPath;
    unifiedConfigCache.mtimeMs = stat.mtimeMs;
    unifiedConfigCache.size = stat.size;
    unifiedConfigCache.selectedMode = selectedMode;
    unifiedConfigCache.perModelModes = perModelModes;
    unifiedConfigCache.perModelFailovers = perModelFailovers;
    unifiedConfigCache.requestDeadlineMs = requestDeadlineMs;
    unifiedConfigCache.llmStatsEnabled = llmStatsEnabled;

    return unifiedConfigCache;
}

function applyEnvOverrides(profile, env) {
    const result = { ...profile };
    const firstByte = parseTimeoutOverride(env?.[ENV_FIRST_BYTE]);
    const idle = parseTimeoutOverride(env?.[ENV_IDLE]);
    // Same documented clamp range as upstream-timeouts.mjs.
    const stream = parseBoundedInteger(env?.[ENV_STREAM], 300_000, 3_600_000);
    const failover = parseBoundedInteger(env?.[ENV_FAILOVER], 1, MAX_CONFIGURED_FAILOVER_ATTEMPTS);
    if (firstByte !== null) result.firstByteTimeoutMs = firstByte;
    if (idle !== null) result.idleTimeoutMs = idle;
    if (stream !== null) result.maxStreamDurationMs = stream;
    if (failover !== null) result.maxFailoverAttempts = failover;
    return result;
}

function readSelectedMode(configPath, _cache) {
    return readUnifiedConfig(configPath).selectedMode;
}

export function createPerformanceModeResolver(options = {}) {
    const configPath = options.configPath ?? process.env.GATEWAY_CONFIG_PATH;
    const env = options.env ?? process.env;
    const now = options.now ?? (() => Date.now());
    const onEffectiveChange = options.onEffectiveChange ?? (() => {});
    const configCache = { mode: null, mtimeMs: null, size: null };
    const window = [];
    let effective = "day"; // Conservative cold start until evidence accumulates.
    let lastAutoSwitchAt = -Infinity;
    // Candidate mode + how many CONSECUTIVE evaluations have agreed on it. Reset
    // whenever an evaluation disagrees with the current candidate, so a switch
    // needs sustained evidence (AUTO_SWITCH_CONFIRMATIONS), not one sample.
    let pendingEffective = null;
    let pendingAgreements = 0;
    // Evidence generation: bumped once per accepted observe(). resolve() runs
    // several times per request (request start + fallbacks in server.mjs), so a
    // confirmation is counted only when the window CHANGED since the last
    // counted one — re-reading the same window is not new evidence.
    let samplesSeen = 0;
    let lastAgreementSample = -1;

    function observe(outcome) {
        if (typeof outcome !== "string" || outcome.length === 0 || outcome.length > 64) return;
        window.push(outcome);
        if (window.length > WINDOW_SIZE) window.shift();
        samplesSeen += 1;
    }

    function decideAuto() {
        if (window.length < MIN_SAMPLES) return effective; // stays "day" at cold start
        const completed = window.filter((o) => o === "completed").length;
        const firstByteTimeouts = window.filter((o) => o === "first_byte_timeout").length;
        const pressure = window.filter((o) => PRESSURE_OUTCOMES.has(o)).length;
        if (effective === "day") {
            const cleanEnough = pressure / window.length <= AUTO_PROMOTE_MAX_PRESSURE_RATIO;
            if (completed >= AUTO_PROMOTE_MIN_COMPLETED && cleanEnough) return "night";
            return "day";
        }
        if (firstByteTimeouts >= AUTO_DEMOTE_FIRST_BYTE_TIMEOUTS
            || pressure / window.length >= AUTO_DEMOTE_PRESSURE_RATIO) return "day";
        return "night";
    }

    function resolve(requestedModelId) {
        const selected = readSelectedMode(configPath, configCache);
        let next = selected;
        if (selected === "auto") {
            const decided = decideAuto();
            if (decided === effective) {
                // Back at the current mode: nothing is pending any more.
                pendingEffective = null;
                pendingAgreements = 0;
                lastAgreementSample = -1;
            } else {
                if (decided !== pendingEffective) {
                    pendingAgreements = 1;
                    lastAgreementSample = samplesSeen;
                } else if (samplesSeen !== lastAgreementSample) {
                    pendingAgreements += 1;
                    lastAgreementSample = samplesSeen;
                }
                pendingEffective = decided;
                if (pendingAgreements >= AUTO_SWITCH_CONFIRMATIONS && now() - lastAutoSwitchAt >= MIN_DWELL_MS) {
                    const previous = effective;
                    effective = decided;
                    lastAutoSwitchAt = now();
                    pendingEffective = null;
                    pendingAgreements = 0;
                    onEffectiveChange({
                        selected: "auto",
                        effective,
                        previousEffective: previous,
                        windowSize: window.length,
                        completed: window.filter((o) => o === "completed").length,
                        firstByteTimeouts: window.filter((o) => o === "first_byte_timeout").length,
                        pressure: window.filter((o) => PRESSURE_OUTCOMES.has(o)).length
                    });
                }
            }
            next = effective;
        }
        // Request-time per-model profile: perModelSettings[modelId].performanceMode
        // (a concrete "day"/"night") overrides the global selected/auto-effective
        // mode for THIS request. Matching is case-insensitive — the same
        // convention as every other perModelSettings knob — but exact on the id
        // itself (no prefix/family bleed). Anything without a concrete per-model
        // entry keeps the global resolution untouched.
        const perModel = readPerModelPerformanceMode(requestedModelId, configPath);
        const base = perModel ?? next;
        // Per-model firstByteTimeoutMs rides ON TOP of the selected profile
        // (global or per-model performanceMode) and BELOW the explicit
        // GATEWAY_FIRST_BYTE_TIMEOUT_MS env knob — precedence per knob:
        // env > perModelSettings > profile. Only the first-byte knob is
        // per-model; idle/stream/failover stay profile-owned. server.mjs
        // consumes the effective value via profile.firstByteTimeoutMs, so the
        // retry window (resolveRetryFirstByteTimeoutMs) stays <= it automatically.
        const perModelFirstByte = readPerModelFirstByteTimeoutMs(requestedModelId, configPath);
        const profile = perModelFirstByte === null
            ? PROFILES[base]
            : { ...PROFILES[base], firstByteTimeoutMs: perModelFirstByte };
        return { selected, effective: base, ...applyEnvOverrides(profile, env) };
    }

    function getState() {
        const resolved = resolve();
        return {
            selected: resolved.selected,
            effective: resolved.effective,
            windowSize: window.length,
            completed: window.filter((o) => o === "completed").length,
            firstByteTimeouts: window.filter((o) => o === "first_byte_timeout").length,
            pressure: window.filter((o) => PRESSURE_OUTCOMES.has(o)).length
        };
    }

    return { observe, resolve, getState };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-model overrides (failover bounds + first-byte budget)
//
// The config.json `perModelSettings.<modelId>.maxFailoverAttempts` field is the
// operator's explicit per-model bound on failover attempts. It previously
// never reached the gateway child (a dead config knob), so `server.mjs` reads
// it here (case-insensitively keyed) and prefers it over the global profile.
// `perModelSettings.<modelId>.rateLimitMaxAttempts` is the sibling bound for the
// uniform-429 early stop; `perModelSettings.<modelId>.firstByteTimeoutMs` is the
// sibling per-model first-byte budget (consumed by createPerformanceModeResolver
// below the GATEWAY_* env knobs). All live in one cached record per model.
// Like the disabled-models cache, this is mtime+size keyed so config edits are
// picked up on the next request without re-reading the file every call.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Read the operator's per-model `performanceMode` override for a model id.
 * Case-insensitive (both sides lowercased — the same convention as the other
 * perModelSettings knobs); returns null when there is no concrete override for
 * this id (no entry, invalid value, "auto", or absent/unreadable config).
 * Never throws.
 *
 * @param {string|null|undefined} modelId Requested model id.
 * @param {string} [configPath] Config path (defaults to GATEWAY_CONFIG_PATH).
 * @returns {"day"|"night"|null}
 */
export function readPerModelPerformanceMode(modelId, configPath = process.env.GATEWAY_CONFIG_PATH) {
    if (typeof modelId !== "string" || modelId.length === 0) return null;
    const records = readUnifiedConfig(configPath).perModelModes;
    if (!records) return null;
    const mode = records[modelId.toLowerCase()]?.performanceMode;
    return CONCRETE_PROFILE_MODES.has(mode) ? mode : null;
}

/**
 * Read the operator's per-model `maxFailoverAttempts` override for a model id.
 * Case-insensitive; returns null when the model has no explicit override (or the
 * config is absent/malformed). Never throws.
 *
 * @param {string|null|undefined} modelId Requested model id.
 * @param {string} [configPath] Config path (defaults to GATEWAY_CONFIG_PATH).
 * @returns {number|null}
 */
export function readPerModelFailoverAttempts(modelId, configPath = process.env.GATEWAY_CONFIG_PATH) {
    return readPerModelBound(modelId, "maxFailoverAttempts", configPath);
}

/**
 * Read the operator's per-model `rateLimitMaxAttempts` override for a model id —
 * how many confirming 429s are collected before the honest 429 is returned.
 * Case-insensitive; returns null when the model has no explicit override (or the
 * config is absent/malformed). The 1..3 clamp is applied by
 * `resolveRateLimitMaxAttempts`, not here. Never throws.
 *
 * @param {string|null|undefined} modelId Requested model id.
 * @param {string} [configPath] Config path (defaults to GATEWAY_CONFIG_PATH).
 * @returns {number|null}
 */
export function readPerModelRateLimitAttempts(modelId, configPath = process.env.GATEWAY_CONFIG_PATH) {
    return readPerModelBound(modelId, "rateLimitMaxAttempts", configPath);
}

/**
 * Read the operator's per-model `firstByteTimeoutMs` override for a model id —
 * THIS model's first-byte budget. Case-insensitive; returns null when the model
 * has no valid override (or the config is absent/malformed), leaving the
 * performance profile in force. Consumed by createPerformanceModeResolver after
 * profile selection and before the GATEWAY_* env overrides (env > perModel >
 * profile). Never throws.
 *
 * @param {string|null|undefined} modelId Requested model id.
 * @param {string} [configPath] Config path (defaults to GATEWAY_CONFIG_PATH).
 * @returns {number|null}
 */
export function readPerModelFirstByteTimeoutMs(modelId, configPath = process.env.GATEWAY_CONFIG_PATH) {
    return readPerModelBound(modelId, "firstByteTimeoutMs", configPath);
}

/**
 * Э1b: the global per-request deadline app setting (config.json
 * `requestDeadlineMs`), re-read per request through the mtime/size cache.
 * @param {string} [configPath] Config path (defaults to GATEWAY_CONFIG_PATH).
 * @returns {number|null} Valid value in 1..MAX_UPSTREAM_TIMEOUT_MS, else null.
 */
export function readConfiguredRequestDeadlineMs(configPath = process.env.GATEWAY_CONFIG_PATH) {
    const value = readUnifiedConfig(configPath).requestDeadlineMs;
    return isValidRequestDeadlineMs(value) ? value : null;
}

/**
 * LLM Stats ranking opt-out (config.json `llmStatsEnabled`, owned by main).
 * Re-read through the same mtime/size cache, so a toggle written by main applies
 * at runtime with no restart, and on (re)start before the first /admin/models.
 * @param {string} [configPath] Config path (defaults to GATEWAY_CONFIG_PATH).
 * @returns {boolean} false ONLY for a stored literal `false`; true otherwise.
 */
export function readLlmStatsEnabled(configPath = process.env.GATEWAY_CONFIG_PATH) {
    return readUnifiedConfig(configPath).llmStatsEnabled !== false;
}

function readPerModelBound(modelId, field, configPath) {
    if (typeof modelId !== "string" || modelId.length === 0) return null;
    const records = readUnifiedConfig(configPath).perModelFailovers;
    if (!records) return null;
    const value = records[modelId.toLowerCase()]?.[field];
    return isPositiveInteger(value) ? value : null;
}
