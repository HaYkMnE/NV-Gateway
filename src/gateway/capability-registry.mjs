// @ts-check
/**
 * Capability registry for the NV-Gateway.
 *
 * Maps NVIDIA model IDs to their capability patterns on a per-FAMILY basis.
 * A "family" is the segment of the model ID before the first "/" — e.g.
 * "z-ai/glm-5.2" -> family "z-ai".
 *
 * Pure logic: NO network, NO file I/O, NO secrets. The only mutable state is
 * the in-memory family-pattern map, which config overrides may extend or
 * replace via {@link registerFamilyPatterns}. Reads return deep clones so
 * callers cannot mutate the registry internals by accident.
 *
 * Context/output limits are intentionally NOT modeled here — that is the job of
 * `model-limits.mjs`. This module owns REASONING + MODALITY patterns only.
 *
 * @module capability-registry
 */

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/**
 * Fallback family pattern used when the family is unknown / unresolvable.
 * Frozen so it can never be accidentally mutated by callers.
 */
const DEFAULT_FAMILY = Object.freeze({
    reasoning: Object.freeze({ supported: false, modes: Object.freeze([]), controlKey: null }),
    tools: true,
    vision: false,
    audio: false,
});

/**
 * Verified built-in family patterns. This seed is never mutated directly; the
 * working map is a deep clone of it (see {@link createSeed}).
 *
 * @type {Record<string, object>}
 */
const SEED_FAMILY_PATTERNS = {
    "z-ai": {
        reasoning: {
            supported: true,
            modes: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
            controlKey: "reasoning_effort", // top-level field in the OpenAI request
            alternateControl: {
                // Nested field also required to actually enable thinking.
                key: "chat_template_kwargs.enable_thinking",
                type: "boolean",
                enableValue: true,
                disableValue: false,
            },
            defaultMode: "high",
        },
        tools: true,
        vision: false,
        audio: false,
    },
    "stepfun-ai": {
        reasoning: {
            // NOTE: NVIDIA direct may expose more modes; ["off","on"] is the safe
            // base. Config can extend via registerFamilyPatterns().
            supported: true,
            modes: ["off", "on"],
            controlKey: "chat_template_kwargs.thinking",
            type: "boolean",
            enableValue: true,
            disableValue: false,
            defaultMode: "on",
        },
        tools: true,
        vision: false,
        audio: false,
    },
    "qwen": {
        reasoning: {
            supported: true,
            modes: ["off", "on"],
            controlKey: "chat_template_kwargs.enable_thinking",
            type: "boolean",
            enableValue: true,
            disableValue: false,
            defaultMode: "on",
        },
        tools: true,
        vision: false,
        audio: false,
    },
    "deepseek-ai": {
        reasoning: {
            supported: true,
            modes: ["none", "minimal", "low", "medium", "high", "max"],
            controlKey: "reasoning_effort",
            defaultMode: "high",
        },
        tools: true,
        vision: false,
        audio: false,
    },
    "deepseek": {
        reasoning: {
            supported: true,
            modes: ["none", "minimal", "low", "medium", "high", "max"],
            controlKey: "reasoning_effort",
            defaultMode: "high",
        },
        tools: true,
        vision: false,
        audio: false,
    },
    "minimaxai": {
        reasoning: {
            supported: true,
            modes: ["disabled", "enabled"],
            controlKey: "chat_template_kwargs.thinking_mode",
            type: "string",
            enableValue: "enabled",
            disableValue: "disabled",
            defaultMode: "enabled",
        },
        tools: true,
        vision: false,
        audio: false,
    },
    "moonshotai": {
        reasoning: {
            // Kimi API docs (platform.kimi.ai, models overview): reasoning effort
            // levels are low/high/max with max as the default.
            supported: true,
            modes: ["low", "high", "max"],
            controlKey: "reasoning_effort",
            defaultMode: "max",
        },
        tools: true,
        // unverified-assumption: kimi-k3 had no NVIDIA Build page (HTTP 404) at
        // fix time, so vision support could not be confirmed; conservatively off.
        vision: false,
        audio: false,
    },
    "meta": {
        reasoning: {
            supported: false,
            modes: [],
            controlKey: null,
        },
        tools: true,
        vision: true, // Llama-4 Maverick supports vision
        audio: false,
    },
    "nvidia": {
        // Nemotron family
        reasoning: {
            supported: false,
            modes: [],
            controlKey: null,
        },
        tools: true,
        vision: false,
        audio: false,
    },
};

// ---------------------------------------------------------------------------
// Working mutable map (reset-able for tests / config reload)
// ---------------------------------------------------------------------------

/** @type {Record<string, object>} */
let FAMILY_PATTERNS = createSeed();

/** Build a fresh, independent deep copy of the built-in seed patterns. */
function createSeed() {
    return structuredClone(SEED_FAMILY_PATTERNS);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {unknown} v */
function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Resolve the family name (segment before the first "/") from a model ID.
 * Returns null for non-string / empty input so callers can fall back.
 * @param {unknown} modelId
 * @returns {string | null}
 */
function resolveFamily(modelId) {
    if (typeof modelId !== "string" || modelId.length === 0) return null;
    const slash = modelId.indexOf("/");
    return slash === -1 ? modelId : modelId.slice(0, slash);
}

/**
 * Look up the live (un-cloned) family pattern + resolved family name.
 * @param {unknown} modelId
 * @returns {{ pattern: object, family: string | null }}
 */
function resolvePattern(modelId) {
    const family = resolveFamily(modelId);
    const pattern =
        family !== null && Object.prototype.hasOwnProperty.call(FAMILY_PATTERNS, family)
            ? FAMILY_PATTERNS[family]
            : DEFAULT_FAMILY;
    return { pattern, family };
}

/**
 * Deep-merge `source` into `target` in place. Arrays and primitives replace;
 * nested plain objects merge recursively.
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 * @returns {Record<string, unknown>}
 */
function deepMerge(target, source) {
    for (const key of Object.keys(source)) {
        const sv = source[key];
        const tv = target[key];
        if (isPlainObject(tv) && isPlainObject(sv)) {
            deepMerge(/** @type {Record<string, unknown>} */ (tv), /** @type {Record<string, unknown>} */ (sv));
        } else if (isPlainObject(sv)) {
            target[key] = structuredClone(sv);
        } else {
            // Arrays must be defensively cloned — without this, a caller can
            // mutate the array they passed in *after* registerFamilyPatterns
            // returns and corrupt the registry. Primitives (boolean, number,
            // string, null) are safe to assign by value.
            target[key] = Array.isArray(sv) ? structuredClone(sv) : sv;
        }
    }
    return target;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the full capability object for a model ID, including the resolved family.
 *
 * @param {unknown} modelId
 * @returns {{
 *   reasoning: { supported: boolean, modes: string[], controlKey: string | null, alternateControl?: object, defaultMode?: string, type?: string, enableValue?: *, disableValue?: * },
 *   tools: boolean,
 *   vision: boolean,
 *   audio: boolean,
 *   family: string | null
 * }}
 */
export function getCapability(modelId) {
    const { pattern, family } = resolvePattern(modelId);
    const clone = structuredClone(pattern);
    clone.family = family;
    return clone;
}

/**
 * Get ONLY the reasoning sub-object for a model ID. Includes internal knobs
 * (alternateControl / type / enableValue / disableValue) when present.
 *
 * @param {unknown} modelId
 * @returns {object} A deep clone of the reasoning pattern.
 */
export function getReasoningCapability(modelId) {
    const { pattern } = resolvePattern(modelId);
    return structuredClone(pattern.reasoning);
}

/**
 * Get a clean, JSON-serializable capability metadata object suitable for the
 * /v1/models response. Omits family and internal-only reasoning knobs.
 *
 * Nullable fields use null (never undefined) so the output serializes losslessly.
 *
 * @param {unknown} modelId
 * @returns {{
 *   reasoning: { supported: boolean, modes: string[], controlKey: string | null, defaultMode: string | null },
 *   tools: boolean,
 *   vision: boolean,
 *   audio: boolean
 * }}
 */
export function getCapabilityMetadata(modelId) {
    const { pattern } = resolvePattern(modelId);
    const r = pattern.reasoning;
    return {
        reasoning: {
            supported: Boolean(r.supported),
            modes: Array.isArray(r.modes) ? [...r.modes] : [],
            controlKey: r.controlKey ?? null,
            defaultMode: r.defaultMode ?? null,
        },
        tools: Boolean(pattern.tools),
        vision: Boolean(pattern.vision),
        audio: Boolean(pattern.audio),
    };
}

/**
 * Merge user-provided family patterns into the registry (deep merge). Lets the
 * config file extend families the registry does not know about, or override
 * existing ones (e.g. add more Step modes) without replacing whole entries.
 *
 * @param {Record<string, object>} overrides Map of family -> partial pattern.
 * @returns {void}
 */
export function registerFamilyPatterns(overrides) {
    if (!isPlainObject(overrides)) return;
    for (const family of Object.keys(overrides)) {
        const ov = overrides[family];
        const existing = FAMILY_PATTERNS[family];
        if (isPlainObject(existing) && isPlainObject(ov)) {
            deepMerge(existing, ov);
        } else if (isPlainObject(ov)) {
            FAMILY_PATTERNS[family] = structuredClone(ov);
        } else {
            // Non-object override: replace outright (unusual, but keep behavior well-defined).
            FAMILY_PATTERNS[family] = ov;
        }
    }
}

/**
 * List all currently known families (built-in + registered overrides).
 * Sorted for deterministic output.
 * @returns {string[] }
 */
export function listKnownFamilies() {
    return Object.keys(FAMILY_PATTERNS).sort();
}

/**
 * Reset the in-memory registry back to the built-in seed patterns, discarding
 * any config overrides. Useful for tests and hot config reload.
 */
export function resetCapabilityRegistry() {
    FAMILY_PATTERNS = createSeed();
}
