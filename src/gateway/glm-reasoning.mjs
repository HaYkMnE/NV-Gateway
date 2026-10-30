// @ts-check
// GLM-5.3 reasoning controls (NVIDIA NIM docs: z-ai/glm-5.3 and glm-5.3-flash,
// "Input" section): `reasoning_effort` accepts ONLY low | high | max and
// DEFAULTS to max, which makes agentic/chat turns reason for minutes (first-byte
// and request-deadline timeouts). `clear_thinking` defaults to false in the chat
// template; chat scenarios should pass clear_thinking=true explicitly.
//
// Pure logic: no I/O, no secrets. Every other model is returned untouched.

const GLM_53_MODEL = /^z-ai\/glm-5\.3(?:-flashx?)?$/i;

// Gateway default when the client expressed no preference: bounded thinking
// instead of upstream's `max`. Clients that want `max` still get it.
export const GLM_53_DEFAULT_EFFORT = 'high';

const EFFORT_MAP = Object.freeze({
  none: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max'
});

/** @param {unknown} modelId */
export function isGlm53Model(modelId) {
  return typeof modelId === 'string' && GLM_53_MODEL.test(modelId);
}

/**
 * Map any OpenAI/Anthropic-style effort onto the set glm-5.3 accepts.
 * "none"/"minimal" -> low: glm-5.3 cannot switch thinking off (NVIDIA doc: thinking
 * is always enabled for the 5.3 family, and `none` / enable_thinking:false are not
 * accepted values), so the cheapest valid effort is the closest honest answer.
 * Unknown values return undefined so upstream, not the gateway, rejects them.
 * @param {unknown} value
 * @returns {'low'|'high'|'max'|undefined}
 */
export function normalizeGlm53Effort(value) {
  if (typeof value !== 'string') return undefined;
  const mapped = EFFORT_MAP[value.trim().toLowerCase()];
  return /** @type {any} */ (mapped);
}

/**
 * Apply GLM-5.3 request defaults to a Chat Completions body (mutates and returns
 * it). Client-provided values are never replaced: a recognised effort is only
 * normalised into the accepted set, an unknown one is left for upstream to
 * reject, and an existing chat_template_kwargs object is merged, not clobbered.
 * @template T
 * @param {T} body
 * @returns {T}
 */
export function applyGlm53ReasoningDefaults(body) {
  const target = /** @type {any} */ (body);
  if (!target || typeof target !== 'object' || Array.isArray(target) || !isGlm53Model(target.model)) return body;

  const sent = target.reasoning_effort;
  if (sent === undefined || sent === null || (typeof sent === 'string' && sent.trim() === '')) {
    target.reasoning_effort = GLM_53_DEFAULT_EFFORT;
  } else {
    const normalized = normalizeGlm53Effort(sent);
    if (normalized) target.reasoning_effort = normalized;
  }

  if (target.chat_template_kwargs === undefined || target.chat_template_kwargs === null) {
    target.chat_template_kwargs = { clear_thinking: true };
  } else if (typeof target.chat_template_kwargs === 'object' && !Array.isArray(target.chat_template_kwargs)) {
    // Thinking is always on for GLM-5.3 and enable_thinking is not one of its
    // controls (the Anthropic facade strips it too), so a client value is dropped.
    delete target.chat_template_kwargs.enable_thinking;
    if (target.chat_template_kwargs.clear_thinking === undefined) target.chat_template_kwargs.clear_thinking = true;
  }
  // Any other chat_template_kwargs shape (string, array, number) is forwarded as is: upstream rejects it.
  return body;
}
