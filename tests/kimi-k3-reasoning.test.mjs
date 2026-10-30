import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyReasoningDefaults,
  isKimiK3Model,
  mapClientEffort,
  usesReasoningDefaults
} from '../src/gateway/reasoning-defaults.mjs';
import { translateResponsesRequest } from '../src/gateway/responses-adapter.mjs';
import { translateAnthropicRequest } from '../src/gateway/anthropic-adapter.mjs';
import { resetCapabilityProbeState } from '../src/gateway/capability-probe.mjs';
import { getCapability, getCapabilityMetadata, getReasoningCapability, resetCapabilityRegistry } from '../src/gateway/capability-registry.mjs';

const KIMI = 'moonshotai/kimi-k3';

test('K1. isKimiK3Model matches the kimi-k3 id only', () => {
  for (const id of [KIMI, 'MoonshotAI/Kimi-K3']) assert.equal(isKimiK3Model(id), true, id);
  for (const id of ['moonshotai/kimi-k2', 'moonshotai/kimi-k3-extra', 'moonshotai/kimi-k30', 'z-ai/glm-5.3', '', undefined, null, 3]) {
    assert.equal(isKimiK3Model(id), false, String(id));
  }
  assert.equal(usesReasoningDefaults(KIMI), true);
  assert.equal(usesReasoningDefaults('z-ai/glm-5.3'), true);
  assert.equal(usesReasoningDefaults('z-ai/glm-5.2'), false);
});

test('K2. no effort from the client -> reasoning_effort "high" (documented default max is far too slow)', () => {
  for (const effort of [undefined, null, '', '   ']) {
    const out = applyReasoningDefaults({ model: KIMI, messages: [], reasoning_effort: effort });
    assert.equal(out.reasoning_effort, 'high', JSON.stringify(effort));
  }
  assert.equal(applyReasoningDefaults({ model: KIMI }).reasoning_effort, 'high');
});

test('K3. client effort is normalised onto low|high|max and never replaced by the default', () => {
  const table = { none: 'low', minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max', MAX: 'max' };
  for (const [input, expected] of Object.entries(table)) {
    assert.equal(applyReasoningDefaults({ model: KIMI, reasoning_effort: input }).reasoning_effort, expected, input);
  }
  // Unknown values are left for upstream to reject.
  assert.equal(applyReasoningDefaults({ model: KIMI, reasoning_effort: 'bogus' }).reasoning_effort, 'bogus');
});

test('K4. only reasoning_effort is injected; unsupported enable_thinking is stripped without touching other values', () => {
  const body = { model: KIMI, temperature: 7, top_p: 0.2, frequency_penalty: 1, n: 3, max_tokens: 999999, messages: [{ role: 'user', content: 'hi' }] };
  const before = { ...body };
  const out = applyReasoningDefaults(body);
  assert.equal(out, body);
  const { reasoning_effort: injected, ...rest } = out;
  assert.equal(injected, 'high');
  assert.deepEqual(rest, before);
  assert.equal('chat_template_kwargs' in out, false, 'clear_thinking is a GLM-only knob');
  const kept = applyReasoningDefaults({ model: KIMI, chat_template_kwargs: { enable_thinking: true, custom: 1 } });
  assert.deepEqual(kept.chat_template_kwargs, { custom: 1 });
  const onlySwitch = applyReasoningDefaults({ model: KIMI, chat_template_kwargs: { enable_thinking: false } });
  assert.equal('chat_template_kwargs' in onlySwitch, false, 'empty kwargs are removed');
  const other = { model: 'moonshotai/kimi-k2', chat_template_kwargs: { enable_thinking: false, custom: 1 } };
  applyReasoningDefaults(other);
  assert.deepEqual(other.chat_template_kwargs, { enable_thinking: false, custom: 1 });
});

test('K5. GLM-5.3 still gets its own defaults through the shared entry point; other models are untouched', () => {
  const glm = applyReasoningDefaults({ model: 'z-ai/glm-5.3' });
  assert.equal(glm.reasoning_effort, 'high');
  assert.deepEqual(glm.chat_template_kwargs, { clear_thinking: true });
  for (const model of ['z-ai/glm-5.2', 'moonshotai/kimi-k2', 'deepseek-ai/deepseek-v4.1-flash', 'qwen/qwen3.5-397b-a17b']) {
    const body = { model, reasoning_effort: 'medium' };
    assert.equal(applyReasoningDefaults(body), body);
    assert.deepEqual(body, { model, reasoning_effort: 'medium' }, model);
  }
});

test('K6. mapClientEffort covers exactly the models with a defaults policy', () => {
  assert.equal(mapClientEffort(KIMI, 'xhigh'), 'max');
  assert.equal(mapClientEffort('z-ai/glm-5.3-flash', 'minimal'), 'low');
  assert.equal(mapClientEffort('z-ai/glm-5.2', 'high'), undefined);
  assert.equal(mapClientEffort(KIMI, 'bogus'), undefined);
  assert.equal(mapClientEffort(KIMI, 5), undefined);
});

test('K7. Responses facade maps reasoning.effort for kimi-k3 (client intent is not dropped)', () => {
  const resultOf = (reasoning) => translateResponsesRequest({ model: KIMI, input: 'hi', ...(reasoning ? { reasoning } : {}) });
  assert.equal(resultOf({ effort: 'medium' }).chatBody.reasoning_effort, 'high');
  assert.equal(resultOf({ effort: 'low' }).chatBody.reasoning_effort, 'low');
  assert.equal(resultOf({ effort: 'max' }).chatBody.reasoning_effort, 'max');
  assert.equal('reasoning_effort' in resultOf().chatBody, false);
  assert.equal('reasoning_effort' in resultOf({ summary: 'auto' }).chatBody, false);
  assert.deepEqual(resultOf({ effort: 'high' }).ignored, [], 'handled effort is not reported as ignored');
  const partial = resultOf({ effort: 'high', summary: 'auto', encrypted_content: 'prompt-secret' });
  assert.deepEqual(partial.ignored, ['reasoning.summary', 'reasoning.encrypted_content']);
  assert.equal(JSON.stringify(partial.ignored).includes('prompt-secret'), false, 'only safe field names are reported');
});

// --- Anthropic facade (the OpenCode / Claude Code route) ---------------------

const anthropicKimi = (model, thinking) => {
  resetCapabilityProbeState({ cachePath: null });
  resetCapabilityRegistry();
  return translateAnthropicRequest({
    model, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], ...(thinking ? { thinking } : {})
  });
};

test('K8. Anthropic thinking:enabled without a budget sends the ADVERTISED default, not a hardcoded one', () => {
  const r = anthropicKimi(KIMI, { type: 'enabled' });
  assert.deepEqual(r.errors, []);
  // The capability layer advertises defaultMode "max" for Kimi K3 (its documented
  // family default), so the wire must carry "max". Sending a hardcoded "high"
  // here made the UI and the request disagree.
  const advertised = getReasoningCapability(KIMI);
  assert.equal(r.openaiBody.reasoning_effort, advertised.defaultMode);
  assert.equal('chat_template_kwargs' in r.openaiBody, false);
});

test('K9. Anthropic budget_tokens map onto low|high|max only (medium is not accepted by Kimi K3)', () => {
  const effortOf = (budget_tokens) => anthropicKimi(KIMI, { type: 'enabled', budget_tokens }).openaiBody.reasoning_effort;
  assert.equal(effortOf(2000), 'low');
  assert.equal(effortOf(4999), 'low');
  assert.equal(effortOf(5000), 'high', 'a mid-size budget used to fall through to low');
  assert.equal(effortOf(8000), 'high');
  assert.equal(effortOf(14999), 'high');
  assert.equal(effortOf(20000), 'high');
  assert.equal(effortOf(30000), 'max');
  assert.equal(effortOf(64000), 'max');
});

test('K10. Anthropic thinking:disabled sends no effort of its own (it always thinks) and warns', () => {
  const r = anthropicKimi(KIMI, { type: 'disabled' });
  assert.deepEqual(r.errors, []);
  assert.equal('reasoning_effort' in r.openaiBody, false);
  assert.ok(r.warnings.some((w) => /cannot be disabled/.test(w)), r.warnings.join('|'));
  // The adapter owns the decision (it cannot express "off"), so the shared
  // default injector must NOT re-add an effort behind its back. This matches the
  // HEAD honesty contract in anthropic-thinking-disable-honesty.test.mjs.
  applyReasoningDefaults(r.openaiBody);
  assert.equal('reasoning_effort' in r.openaiBody, false,
    'a deliberate "send nothing" must survive the shared defaults');
  // No thinking field at all: the client expressed no preference, so the
  // documented gateway default still applies.
  const none = anthropicKimi(KIMI);
  assert.equal('reasoning_effort' in none.openaiBody, false);
  assert.equal(applyReasoningDefaults(none.openaiBody).reasoning_effort, 'high');
});

test('K11. Anthropic mapping is unchanged for GLM-5.3 and for other models', () => {
  const glm = (thinking) => anthropicKimi('z-ai/glm-5.3', thinking).openaiBody;
  assert.equal(glm({ type: 'enabled' }).reasoning_effort, 'high');
  assert.equal(glm({ type: 'enabled', budget_tokens: 8000 }).reasoning_effort, 'high');
  assert.equal(glm({ type: 'enabled', budget_tokens: 2000 }).reasoning_effort, 'low');
  assert.equal(glm({ type: 'enabled', budget_tokens: 64000 }).reasoning_effort, 'max');
  assert.equal(glm({ type: 'disabled' }).reasoning_effort, 'low');
  // Other moonshotai models keep the generic family behaviour (default max, medium falls to low).
  assert.equal(anthropicKimi('moonshotai/kimi-k2', { type: 'enabled' }).openaiBody.reasoning_effort, 'max');
  assert.equal(anthropicKimi('moonshotai/kimi-k2', { type: 'enabled', budget_tokens: 8000 }).openaiBody.reasoning_effort, 'low');
  assert.equal(anthropicKimi('z-ai/glm-5.2', { type: 'enabled', budget_tokens: 8000 }).openaiBody.reasoning_effort, 'medium');
  assert.equal(anthropicKimi('deepseek-ai/deepseek-v4-flash', { type: 'enabled' }).openaiBody.reasoning_effort, 'high');
});

test('K12. Kimi K3 accepts images: per-model vision override that survives a registry reset', () => {
  resetCapabilityRegistry();
  assert.equal(getCapability(KIMI).vision, true);
  assert.equal(getCapabilityMetadata(KIMI).vision, true);
  assert.equal(getCapability('MoonshotAI/Kimi-K3').vision, true);
  assert.equal(getCapability(KIMI).family, 'moonshotai');
  // Reasoning MODES are the family's; the DEFAULT is lowered for this model so
  // the advertised default matches the "high" the gateway actually sends (max
  // produced 140-180 s first-byte waits in the live logs).
  assert.deepEqual(getCapability(KIMI).reasoning.modes, ['low', 'high', 'max']);
  assert.equal(getCapability(KIMI).reasoning.defaultMode, 'high');
  // The rest of the family keeps the documented upstream default.
  assert.equal(getCapability('moonshotai/kimi-k2').reasoning.defaultMode, 'max');
  for (const id of ['moonshotai/kimi-k2', 'moonshotai/kimi-k3-extra', 'moonshotai/kimi-k30']) {
    assert.equal(getCapability(id).vision, false, id);
  }
});

test.after(() => {
  resetCapabilityProbeState({ cachePath: null });
  resetCapabilityRegistry();
});
