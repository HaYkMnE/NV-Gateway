import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyGlm53ReasoningDefaults,
  isGlm53Model,
  normalizeGlm53Effort
} from '../src/gateway/glm-reasoning.mjs';
import { translateAnthropicRequest } from '../src/gateway/anthropic-adapter.mjs';
import { translateResponsesRequest } from '../src/gateway/responses-adapter.mjs';

const GLM = 'z-ai/glm-5.3';

test('G1. isGlm53Model matches glm-5.3 and its variants only', () => {
  for (const id of ['z-ai/glm-5.3', 'z-ai/glm-5.3-flash', 'Z-AI/GLM-5.3', 'z-ai/glm-5.3-flashx']) {
    assert.equal(isGlm53Model(id), true, id);
  }
  for (const id of ['z-ai/glm-5.2', 'z-ai/glm-5.30', 'z-ai/glm-5.3.1', 'z-ai/glm-5.3-foo', 'z-ai/glm-5.3-flash-extra', 'z-ai/glm-5.3-', 'z-ai/glm-4.5', 'qwen/qwen3.5-397b-a17b', '', undefined, null, 5]) {
    assert.equal(isGlm53Model(id), false, String(id));
  }
});

test('G2. normalizeGlm53Effort maps every client value onto low|high|max', () => {
  const table = {
    none: 'low', minimal: 'low', low: 'low',
    medium: 'high', high: 'high',
    xhigh: 'max', max: 'max',
    HIGH: 'high', ' Max ': 'max'
  };
  for (const [input, expected] of Object.entries(table)) {
    assert.equal(normalizeGlm53Effort(input), expected, JSON.stringify(input));
  }
  // Unknown / non-string values are not guessed at: upstream validates them.
  for (const input of ['bogus', '', 7, null, undefined, {}]) {
    assert.equal(normalizeGlm53Effort(input), undefined, JSON.stringify(input));
  }
});

test('G3. defaults: reasoning_effort high + clear_thinking true when the client sent neither', () => {
  const body = { model: GLM, messages: [{ role: 'user', content: 'hi' }] };
  const out = applyGlm53ReasoningDefaults(body);
  assert.equal(out.reasoning_effort, 'high');
  assert.deepEqual(out.chat_template_kwargs, { clear_thinking: true });
  assert.deepEqual(out.messages, body.messages);
  for (const nullish of [null, undefined]) {
    assert.equal(applyGlm53ReasoningDefaults({ model: GLM, reasoning_effort: nullish }).reasoning_effort, 'high');
  }
  assert.equal(applyGlm53ReasoningDefaults({ model: 'z-ai/glm-5.3-flash' }).reasoning_effort, 'high');
});

test('G4. client-provided values are never overridden; chat_template_kwargs is merged', () => {
  assert.equal(applyGlm53ReasoningDefaults({ model: GLM, reasoning_effort: 'max' }).reasoning_effort, 'max');
  assert.equal(applyGlm53ReasoningDefaults({ model: GLM, reasoning_effort: 'low' }).reasoning_effort, 'low');
  // Out-of-set values are normalised, not replaced by the default.
  assert.equal(applyGlm53ReasoningDefaults({ model: GLM, reasoning_effort: 'medium' }).reasoning_effort, 'high');
  assert.equal(applyGlm53ReasoningDefaults({ model: GLM, reasoning_effort: 'xhigh' }).reasoning_effort, 'max');
  assert.equal(applyGlm53ReasoningDefaults({ model: GLM, reasoning_effort: 'none' }).reasoning_effort, 'low');
  // An unknown value is left for upstream to reject.
  assert.equal(applyGlm53ReasoningDefaults({ model: GLM, reasoning_effort: 'bogus' }).reasoning_effort, 'bogus');

  // enable_thinking is not a GLM-5.3 control (thinking is always on), so a client's
  // value is stripped, exactly as the Anthropic facade does; other keys survive.
  const merged = applyGlm53ReasoningDefaults({ model: GLM, chat_template_kwargs: { enable_thinking: true, custom: 1 } });
  assert.deepEqual(merged.chat_template_kwargs, { custom: 1, clear_thinking: true });
  const onlyEnable = applyGlm53ReasoningDefaults({ model: GLM, chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(onlyEnable.chat_template_kwargs, { clear_thinking: true });
  const kept = applyGlm53ReasoningDefaults({ model: GLM, chat_template_kwargs: { clear_thinking: false } });
  assert.deepEqual(kept.chat_template_kwargs, { clear_thinking: false });
});

test('G5. other models and non-objects are returned untouched', () => {
  for (const model of ['z-ai/glm-5.2', 'z-ai/glm-4.5', 'qwen/qwen3.5-397b-a17b', 'meta/llama-3.3-70b-instruct']) {
    const body = { model, reasoning_effort: 'medium', messages: [] };
    const before = JSON.stringify(body);
    const out = applyGlm53ReasoningDefaults(body);
    assert.equal(out, body, model);
    assert.equal(JSON.stringify(out), before, model);
  }
  assert.equal(applyGlm53ReasoningDefaults(null), null);
  assert.deepEqual(applyGlm53ReasoningDefaults([1]), [1]);
});

const anthropicBody = (model, thinking) => ({
  model,
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'hi' }],
  ...(thinking ? { thinking } : {})
});

test('G6. Anthropic facade maps thinking to valid glm-5.3 values', () => {
  const effortOf = (thinking) => translateAnthropicRequest(anthropicBody(GLM, thinking)).openaiBody.reasoning_effort;
  assert.equal(effortOf({ type: 'enabled' }), 'high');
  assert.equal(effortOf({ type: 'enabled', budget_tokens: 2000 }), 'low');
  assert.equal(effortOf({ type: 'enabled', budget_tokens: 10000 }), 'high');
  assert.equal(effortOf({ type: 'enabled', budget_tokens: 20000 }), 'high');
  assert.equal(effortOf({ type: 'enabled', budget_tokens: 40000 }), 'max');

  // thinking cannot be switched off on glm-5.3 (low is the floor): 'none' and
  // enable_thinking:false are not valid inputs, so the cheapest valid effort is
  // sent and the client is told.
  const disabled = translateAnthropicRequest(anthropicBody(GLM, { type: 'disabled' }));
  assert.equal(disabled.openaiBody.reasoning_effort, 'low');
  assert.equal(disabled.openaiBody.chat_template_kwargs?.enable_thinking, undefined);
  assert.ok(disabled.warnings.some((w) => /cannot be disabled/.test(w)), disabled.warnings.join('|'));

  const enabled = translateAnthropicRequest(anthropicBody('z-ai/glm-5.3-flash', { type: 'enabled', budget_tokens: 40000 }));
  assert.equal(enabled.openaiBody.reasoning_effort, 'max');
  assert.equal(enabled.openaiBody.chat_template_kwargs?.enable_thinking, undefined);

  // No thinking field: the adapter invents nothing (the server applies defaults).
  assert.equal(translateAnthropicRequest(anthropicBody(GLM)).openaiBody.reasoning_effort, undefined);
});

test('G7. Anthropic mapping for other z-ai models is unchanged', () => {
  const off = translateAnthropicRequest(anthropicBody('z-ai/glm-5.2', { type: 'disabled' })).openaiBody;
  assert.equal(off.reasoning_effort, 'none');
  assert.equal(off.chat_template_kwargs?.enable_thinking, false);
  const on = translateAnthropicRequest(anthropicBody('z-ai/glm-5.2', { type: 'enabled', budget_tokens: 10000 })).openaiBody;
  assert.equal(on.reasoning_effort, 'medium');
  assert.equal(on.chat_template_kwargs?.enable_thinking, true);
});

test('G8. Responses facade maps reasoning.effort for glm-5.3 through the same normalisation', () => {
  const chatOf = (model, reasoning) => translateResponsesRequest({ model, input: 'hi', ...(reasoning ? { reasoning } : {}) });
  for (const [effort, expected] of Object.entries({ minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max', none: 'low' })) {
    assert.equal(chatOf(GLM, { effort }).chatBody.reasoning_effort, expected, effort);
  }
  assert.equal(chatOf('z-ai/glm-5.3-flash', { effort: 'xhigh' }).chatBody.reasoning_effort, 'max');
  // Nothing to map: the field is left for the server default.
  assert.equal('reasoning_effort' in chatOf(GLM).chatBody, false);
  assert.equal('reasoning_effort' in chatOf(GLM, { summary: 'auto' }).chatBody, false);
  assert.equal('reasoning_effort' in chatOf(GLM, { effort: 7 }).chatBody, false);
});

test('G9. Responses facade leaves other models unchanged (reasoning stays ignored)', () => {
  const result = translateResponsesRequest({ model: 'z-ai/glm-5.2', input: 'hi', reasoning: { effort: 'high' } });
  assert.equal('reasoning_effort' in result.chatBody, false);
  assert.ok(result.ignored.includes('reasoning'));
});

test('G10. an empty / blank effort counts as "not sent" and gets the default; a real unknown value does not', () => {
  for (const blank of ['', '   ']) {
    assert.equal(applyGlm53ReasoningDefaults({ model: GLM, reasoning_effort: blank }).reasoning_effort, 'high', JSON.stringify(blank));
  }
  assert.equal(applyGlm53ReasoningDefaults({ model: GLM, reasoning_effort: 'bogus' }).reasoning_effort, 'bogus');
});

test('G11. a chat_template_kwargs that is not an object is forwarded untouched (upstream rejects it), effort still defaulted', () => {
  for (const kwargs of ['clear_thinking=true', ['clear_thinking'], 7, true]) {
    const out = applyGlm53ReasoningDefaults({ model: GLM, chat_template_kwargs: kwargs });
    assert.deepEqual(out.chat_template_kwargs, kwargs, JSON.stringify(kwargs));
    assert.equal(out.reasoning_effort, 'high');
  }
});

test('G12. stream and the rest of the body survive the defaults untouched', () => {
  const body = { model: GLM, stream: true, stream_options: { include_usage: true }, max_tokens: 64, tools: [{ type: 'function', function: { name: 'f' } }], messages: [{ role: 'user', content: 'hi' }] };
  const before = JSON.parse(JSON.stringify(body));
  const out = applyGlm53ReasoningDefaults(body);
  const { reasoning_effort: effort, chat_template_kwargs: kwargs, ...rest } = out;
  assert.equal(effort, 'high');
  assert.deepEqual(kwargs, { clear_thinking: true });
  assert.deepEqual(rest, before);
  assert.equal(out.stream, true);
});
