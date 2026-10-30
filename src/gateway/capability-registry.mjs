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
            // levels are low/high/max with max as the family default.
            supported: true,
            modes: ["low", "high", "max"],
            controlKey: "reasoning_effort",
            defaultMode: "max",
        },
        tools: true,
        // Family default stays off: other moonshotai models are unverified. Kimi K3
        // itself accepts images, see MODEL_OVERRIDES["moonshotai/kimi-k3"].
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
// Per-model overrides (exact lowercase model id -> fields layered over the family)
// ---------------------------------------------------------------------------

/**
 * Built-in, never reset. Only fields that differ from the family are listed.
 *
 * deepseek-ai/deepseek-v4.1-flash: NVIDIA Build model card (build.nvidia.com/
 * deepseek-ai/deepseek-v4.1-flash) lists text + image input, so vision is true
 * while the generic deepseek-ai family stays vision-off. The official model card
 * documents numeric reasoning effort 1..100, while the NVIDIA endpoint schema
 * exposes no string reasoning control. Until numeric facade mapping is verified,
 * this exact model advertises reasoning but no translatable effort control.
 *
 * @type {Record<string, { id: string, fields: object }>}
 */
const MODEL_OVERRIDES = Object.freeze({
    "deepseek-ai/deepseek-v4.1-flash": Object.freeze({
        id: "deepseek-ai/deepseek-v4.1-flash",
        fields: Object.freeze({
            vision: true,
            reasoning: Object.freeze({ supported: true, modes: Object.freeze([]), controlKey: null }),
        }),
    }),
    // moonshotai/kimi-k3: the NVIDIA reference page
    // (docs.api.nvidia.com/nim/reference/moonshotai-kimi-k3) lists Input Types
    // Text and Image, so vision is true here while the moonshotai family stays
    // vision-off. Reasoning modes are the family's (low|high|max), but the
    // DEFAULT is lowered to "high" for this model only: upstream "max" produced
    // 140-180 s first-byte waits in the live gateway logs (first_byte_timeout),
    // and the gateway therefore sends "high" when the client expresses no
    // preference. Advertised default == sent default; a client that wants max
    // asks for it explicitly.
    "moonshotai/kimi-k3": Object.freeze({
        id: "moonshotai/kimi-k3",
        fields: Object.freeze({
            vision: true,
            // Full object: override fields are layered SHALLOWLY over the family
            // pattern, so a partial `reasoning` here would drop supported/modes.
            reasoning: Object.freeze({
                supported: true,
                modes: Object.freeze(["low", "high", "max"]),
                controlKey: "reasoning_effort",
                defaultMode: "high",
            }),
        }),
    }),
    // minimaxai/minimax-m3.1-flash: the NVIDIA card
    // (build.nvidia.com/qc69jvmznzxy/minimax-m3.1-flash.md) lists Input Types Text
    // and Image and reasoning_effort low|medium|high|xhigh|max. Live probes on
    // 2026-10-25 through the gateway: a red PNG was answered "Red" (vision), and
    // every one of those five efforts returned 200. Neither reasoning_effort
    // "none" nor chat_template_kwargs.thinking_mode "disabled" stopped reasoning,
    // so the family's disabled/enabled switch is NOT used here and no "off" mode
    // is advertised (thinking:disabled then warns instead of sending a no-op).
    // defaultMode "high" is the value the Anthropic facade sends for thinking
    // without a budget; the chat facade still injects nothing when the client
    // sends no effort (same as every non-GLM-5.3/Kimi-K3 model).
    "minimaxai/minimax-m3.1-flash": Object.freeze({
        id: "minimaxai/minimax-m3.1-flash",
        fields: Object.freeze({
            vision: true,
            // Full object: override fields are layered SHALLOWLY over the family.
            reasoning: Object.freeze({
                supported: true,
                modes: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
                controlKey: "reasoning_effort",
                defaultMode: "high",
            }),
        }),
    }),
});
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
    const override = typeof modelId === "string"
        ? MODEL_OVERRIDES[modelId.toLowerCase()]
        : undefined;
    if (override) {
        // Layer the per-model fields over the override's own family pattern
        // (shallow: callers clone before handing anything out).
        const base = FAMILY_PATTERNS[resolveFamily(override.id) ?? ""] ?? DEFAULT_FAMILY;
        return { pattern: { ...base, ...override.fields }, family };
    }
    const pattern =
        family !== null && Object.prototype.hasOwnProperty.call(FAMILY_PATTERNS, family)
            ? FAMILY_PATTERNS[family]
            : DEFAULT_FAMILY;
    return { pattern, family };
}

/**
 * Keys that must never be assigned as data. `target["__proto__"] = value` invokes
 * the Object.prototype setter and pollutes EVERY object in the process, and
 * `constructor`/`prototype` are the classic prototype-pollution vectors. A config
 * override is untrusted data: `Object.keys(JSON.parse('{"__proto__":…}'))` yields
 * "__proto__" as a real key, so the guard has to be explicit rather than rely on
 * the key never appearing.
 */
function isUnsafeKey(key) {
    return key === "__proto__" || key === "constructor" || key === "prototype";
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
        // Dropped BEFORE any read or write: reading `source["__proto__"]` is the
        // prototype, not an absent own value, and assigning it mutates the
        // prototype. There is no legitimate capability override under these names.
        if (isUnsafeKey(key)) continue;
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
 * The curated per-model `reasoning` object from MODEL_OVERRIDES, or null when
 * the model has no exact override declaring one. Unlike getReasoningCapability,
 * this never falls back to the family row: it answers "did a human pin this
 * model's reasoning contract?", which the probe resolver uses to keep a probe
 * from EXPANDING a curated mode list (capability-probe resolveAdvertisedReasoning).
 *
 * @param {unknown} modelId
 * @returns {{ supported: boolean, modes: string[], controlKey: string | null, defaultMode?: string } | null} A deep clone.
 */
export function getCuratedReasoningOverride(modelId) {
    if (typeof modelId !== "string" || modelId.length === 0) return null;
    const override = MODEL_OVERRIDES[modelId.toLowerCase()];
    const reasoning = override?.fields?.reasoning;
    return isPlainObject(reasoning) ? structuredClone(reasoning) : null;
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
        // A top-level `__proto__` family key would hit the same prototype setter
        // as the nested case deepMerge now skips. Same guard, same reason.
        if (isUnsafeKey(family)) continue;
        const ov = overrides[family];
        const existing = FAMILY_PATTERNS[family];
        if (isPlainObject(existing) && isPlainObject(ov)) {
            deepMerge(existing, ov);
        } else if (isPlainObject(ov)) {
            // A NEW family with a partial plain-object override must still carry
            // every field the readers require. Storing the override verbatim
            // yields a family with no `reasoning` (and no tools/vision/audio):
            // getReasoningCapability returns undefined and getCapabilityMetadata
            // throws reading `r.supported`. Merge into a clone of the DEFAULT
            // shape so omitted fields keep safe defaults and the override wins.
            FAMILY_PATTERNS[family] = deepMerge(structuredClone(DEFAULT_FAMILY), ov);
        } else {
            // Non-object override: ignored. A family pattern is read as an object
            // (pattern.reasoning / pattern.tools); storing a primitive/array/null
            // would poison the readers exactly as the partial-object case did —
            // e.g. getCapability(123) would read `.reasoning` of a number and
            // getCapabilityMetadata would throw on null. Replacing the family
            // outright cannot be made safe, so the malformed entry is dropped and
            // the family keeps whatever valid pattern it already had.
        }
    }
}

/**
 * True when this model's family has a real entry in the registry, i.e. the
 * capability answer is KNOWLEDGE rather than the DEFAULT_FAMILY fallback.
 *
 * Callers need this to tell "we know this model cannot do X" apart from "we
 * have never heard of this model", because those two justify very different
 * behaviour: the former may refuse locally, the latter must not.
 *
 * @param {unknown} modelId
 * @returns {boolean}
 */
export function isFamilyKnown(modelId) {
    const family = resolveFamily(modelId);
    return family !== null && Object.prototype.hasOwnProperty.call(FAMILY_PATTERNS, family);
}

/**
 * List all currently known families (built-in + registered overrides).
 * Sorted for deterministic output.
 * @returns {string[]}
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
