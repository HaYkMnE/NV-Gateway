// @ts-check
// Per-model reasoning defaults applied to Chat Completions bodies before they go
// upstream. Only models listed here are touched; every other body is returned as is.
//
//  - z-ai/glm-5.3*  : see glm-reasoning.mjs (effort high + clear_thinking true).
//  - moonshotai/kimi-k3: NVIDIA doc (docs.api.nvidia.com/nim/reference/moonshotai-kimi-k3)
//    says reasoning_effort accepts low|high|max and DEFAULTS to max, which produced
//    very long first-byte waits (first_byte_timeout in gateway.jsonl). When the client
//    sends no effort the gateway uses "high". Nothing else is injected: top_p, n and the
//    penalties are fixed upstream and temperature is the client's business.
//
// Pure logic: no I/O, no secrets.

import { applyGlm53ReasoningDefaults, isGlm53Model, normalizeGlm53Effort } from './glm-reasoning.mjs';
import { getReasoningCapability } from './capability-registry.mjs';
import { resolveAdvertisedReasoning } from './capability-probe.mjs';

const KIMI_K3_MODEL = /^moonshotai\/kimi-k3$/i;
const DEEPSEEK_V41_FLASH_MODEL = /^deepseek-ai\/deepseek-v4\.1-flash$/i;
export const KIMI_K3_DEFAULT_EFFORT = 'high';

/**
 * The effort the chat facade must send for Kimi K3 when the client expresses no
 * preference. It resolves against the SAME evidence /v1/models uses: fresh probe
 * cache first, static registry second. Returns null when the authoritative
 * evidence says "no usable control", so the caller sends nothing at all.
 * @returns {string | null}
 */
function resolveAdvertisedKimiDefault() {
  try {
    const advertised = resolveAdvertisedReasoning('moonshotai/kimi-k3');
    if (advertised.authoritative) {
      // A probed verdict — positive or negative — is the truth the UI shows.
      return advertised.controlKey ? advertised.defaultMode : null;
    }
    const cap = getReasoningCapability('moonshotai/kimi-k3');
    if (cap && typeof cap.defaultMode === 'string' && cap.defaultMode.length > 0) {
      return cap.defaultMode;
    }
  } catch {
    // a broken registry must never fail a client request
  }
  return KIMI_K3_DEFAULT_EFFORT;
}

/**
 * Marker set by a facade that has ALREADY decided the reasoning fields for a
 * request — including "deliberately send none" when the capability layer
 * advertises no usable control. `applyReasoningDefaults` must then leave the
 * body untouched: re-injecting a default here would put a value on the wire
 * that /v1/models does not advertise.
 *
 * A Symbol is invisible to JSON.stringify, so it can never leak upstream.
 */
export const REASONING_DEFAULTS_HANDLED = Symbol.for('nv-gateway.reasoning-defaults-handled');

/** @param {unknown} body */
export function markReasoningDefaultsHandled(body) {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    /** @type {any} */ (body)[REASONING_DEFAULTS_HANDLED] = true;
  }
  return body;
}

/** @param {unknown} modelId */
export function isKimiK3Model(modelId) {
  return typeof modelId === 'string' && KIMI_K3_MODEL.test(modelId);
}

/** @param {unknown} modelId */
export function isDeepSeekV41FlashModel(modelId) {
  return typeof modelId === 'string' && DEEPSEEK_V41_FLASH_MODEL.test(modelId);
}

/**
 * Anthropic `thinking.budget_tokens` -> an effort the model accepts (low|high|max).
 * Same thresholds as the generic adapter (5000 / 15000 / 30000) with the unsupported
 * "medium" band folded into "high", so GLM-5.3 and Kimi K3 agree. No budget -> the
 * gateway default for Kimi K3 ("high"); non-numbers are ignored.
 * @param {unknown} budget
 * @returns {'low'|'high'|'max'}
 */
export function effortForThinkingBudget(budget) {
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return KIMI_K3_DEFAULT_EFFORT;
  if (budget < 5000) return 'low';
  if (budget < 30000) return 'high';
  return 'max';
}

/** @param {unknown} modelId */
export function usesReasoningDefaults(modelId) {
  return isGlm53Model(modelId) || isKimiK3Model(modelId);
}

/**
 * Map a client effort onto the values the model accepts (low|high|max), or
 * undefined when the model has no policy / the value is unknown. Both models take
 * the same set, so the GLM table is shared.
 * @param {unknown} modelId
 * @param {unknown} value
 */
export function mapClientEffort(modelId, value) {
  return usesReasoningDefaults(modelId) ? normalizeGlm53Effort(value) : undefined;
}

/**
 * Apply the model's defaults to a Chat Completions body (mutates and returns it).
 * Client-provided values are never replaced, only normalised.
 * @template T
 * @param {T} body
 * @returns {T}
 */
export function applyReasoningDefaults(body) {
  const target = /** @type {any} */ (body);
  if (!target || typeof target !== 'object' || Array.isArray(target)) return body;
  // A facade that already resolved the reasoning fields owns the decision,
  // including a deliberate "send nothing". Respect it.
  if (target[REASONING_DEFAULTS_HANDLED] === true) return body;
  if (isGlm53Model(target.model)) return applyGlm53ReasoningDefaults(body);
  if (!isKimiK3Model(target.model)) return body;

  const sent = target.reasoning_effort;
  if (sent === undefined || sent === null || (typeof sent === 'string' && sent.trim() === '')) {
    // Advertised == sent: send exactly what /v1/models names as the default, and
    // send NOTHING when the authoritative evidence says there is no usable
    // control (a probed negative must not be overridden by a built-in constant).
    const advertisedDefault = resolveAdvertisedKimiDefault();
    if (advertisedDefault === null) {
      delete target.reasoning_effort;
    } else {
      target.reasoning_effort = advertisedDefault;
    }
  } else {
    const normalized = normalizeGlm53Effort(sent);
    if (normalized) target.reasoning_effort = normalized;
  }
  if (target.chat_template_kwargs && typeof target.chat_template_kwargs === 'object'
      && !Array.isArray(target.chat_template_kwargs)) {
    delete target.chat_template_kwargs.enable_thinking;
    if (Object.keys(target.chat_template_kwargs).length === 0) delete target.chat_template_kwargs;
  }
  return body;
}
