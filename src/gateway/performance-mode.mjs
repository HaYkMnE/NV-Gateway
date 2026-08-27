// Runtime performance profiles for the gateway.
//
// The user selects a mode manually ("day" | "night" | "auto") in Settings; it is
// persisted in the app config (performanceMode), read by the gateway child from
// GATEWAY_CONFIG_PATH. Explicit GATEWAY_* env tuning vars always win over profile
// values (per knob). When mode is "auto", the effective profile is derived from
// recent REAL request outcomes (rolling window + asymmetric thresholds + minimum
// dwell time) — never from the wall clock.

import fs from "node:fs";

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
const MIN_DWELL_MS = 120_000;
// Pressure-driven outcomes: first-byte stalls and broken/hung upstream streams.
const PRESSURE_OUTCOMES = new Set([
    "first_byte_timeout",
    "idle_timeout",
    "upstream_stream_error",
    "max_stream_duration"
]);
// Auto switching (asymmetric = hysteresis):
//  day -> night: at least MIN_SAMPLES outcomes, >=16 completed, 0 first-byte timeouts.
//  night -> day: >=2 first-byte timeouts OR >=25% pressure outcomes in the window.
const AUTO_PROMOTE_MIN_COMPLETED = 16;
const AUTO_DEMOTE_FIRST_BYTE_TIMEOUTS = 2;
const AUTO_DEMOTE_PRESSURE_RATIO = 0.25;

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

function applyEnvOverrides(profile, env) {
    const result = { ...profile };
    const firstByte = parseTimeoutOverride(env?.[ENV_FIRST_BYTE]);
    const idle = parseTimeoutOverride(env?.[ENV_IDLE]);
    // Same documented clamp range as upstream-timeouts.mjs.
    const stream = parseBoundedInteger(env?.[ENV_STREAM], 300_000, 3_600_000);
    const failover = parseStrictBoundedInteger(env?.[ENV_FAILOVER], 1, 8);
    if (firstByte !== null) result.firstByteTimeoutMs = firstByte;
    if (idle !== null) result.idleTimeoutMs = idle;
    if (stream !== null) result.maxStreamDurationMs = stream;
    if (failover !== null) result.maxFailoverAttempts = failover;
    return result;
}

function readSelectedMode(configPath, cache) {
    if (typeof configPath !== "string" || configPath.length === 0) return "day";
    let stat;
    try { stat = fs.statSync(configPath); } catch { return cache.mode ?? "day"; }
    if (cache.mode && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.mode;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")); } catch { return "day"; }
    const mode = VALID_MODES.has(parsed?.performanceMode) ? parsed.performanceMode : "day";
    cache.mode = mode;
    cache.mtimeMs = stat.mtimeMs;
    cache.size = stat.size;
    return mode;
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

    function observe(outcome) {
        if (typeof outcome !== "string" || outcome.length === 0 || outcome.length > 64) return;
        window.push(outcome);
        if (window.length > WINDOW_SIZE) window.shift();
    }

    function decideAuto() {
        if (window.length < MIN_SAMPLES) return effective; // stays "day" at cold start
        const completed = window.filter((o) => o === "completed").length;
        const firstByteTimeouts = window.filter((o) => o === "first_byte_timeout").length;
        const pressure = window.filter((o) => PRESSURE_OUTCOMES.has(o)).length;
        if (effective === "day") {
            if (completed >= AUTO_PROMOTE_MIN_COMPLETED && firstByteTimeouts === 0) return "night";
            return "day";
        }
        if (firstByteTimeouts >= AUTO_DEMOTE_FIRST_BYTE_TIMEOUTS
            || pressure / window.length >= AUTO_DEMOTE_PRESSURE_RATIO) return "day";
        return "night";
    }

    function resolve() {
        const selected = readSelectedMode(configPath, configCache);
        let next = selected;
        if (selected === "auto") {
            const decided = decideAuto();
            if (decided !== effective && now() - lastAutoSwitchAt >= MIN_DWELL_MS) {
                const previous = effective;
                effective = decided;
                lastAutoSwitchAt = now();
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
            next = effective;
        }
        return { selected, effective: selected === "auto" ? effective : selected, ...applyEnvOverrides(PROFILES[next], env) };
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
