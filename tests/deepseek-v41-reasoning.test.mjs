import test from 'node:test';
import assert from 'node:assert/strict';

import { translateAnthropicRequest } from '../src/gateway/anthropic-adapter.mjs';
import { getCapability, getCapabilityMetadata, registerFamilyPatterns, resetCapabilityRegistry } from '../src/gateway/capability-registry.mjs';
import { applyReasoningDefaults } from '../src/gateway/reasoning-defaults.mjs';
import { translateResponsesRequest } from '../src/gateway/responses-adapter.mjs';

const MODEL = 'deepseek-ai/deepseek-v4.1-flash';

test('D1. exact capability keeps reasoning support but exposes no unverified string effort control', () => {
  resetCapabilityRegistry();
  const cap = getCapability(MODEL);
  assert.equal(cap.reasoning.supported, true);
  assert.deepEqual(cap.reasoning.modes, []);
  assert.equal(cap.reasoning.controlKey, null);
  assert.equal(cap.reasoning.defaultMode, undefined);
  assert.equal(cap.vision, true);
  assert.deepEqual(getCapabilityMetadata(MODEL).reasoning, {
    supported: true, modes: [], controlKey: null, defaultMode: null
  });

  registerFamilyPatterns({ 'deepseek-ai': { reasoning: { defaultMode: 'max' } } });
  assert.equal(getCapability(MODEL).reasoning.controlKey, null, 'family changes cannot restore string translation');
  resetCapabilityRegistry();
  assert.equal(getCapability(MODEL).reasoning.controlKey, null, 'built-in override survives reset');
});

test('D2. raw chat values are preserved byte-for-value: no injection or string/numeric transformation', () => {
  for (const effort of [42, 100, 'high', 'max']) {
    const body = { model: MODEL, messages: [], reasoning_effort: effort };
    assert.equal(applyReasoningDefaults(body), body);
    assert.equal(body.reasoning_effort, effort);
  }
  const absent = { model: MODEL, messages: [] };
  applyReasoningDefaults(absent);
  assert.equal('reasoning_effort' in absent, false);
});

test('D3. Responses reasoning.effort is not fabricated into the numeric DeepSeek V4.1 control', () => {
  const r = translateResponsesRequest({ model: MODEL, input: 'hi', reasoning: { effort: 'high' } });
  assert.equal('reasoning_effort' in r.chatBody, false);
  assert.deepEqual(r.ignored, ['reasoning']);
});

test('D4. Anthropic thinking is accepted without fabricating an unverified string reasoning_effort', () => {
  const r = translateAnthropicRequest({
    model: MODEL,
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 8000 }
  });
  assert.deepEqual(r.errors, []);
  assert.equal('reasoning_effort' in r.openaiBody, false);
  assert.ok(r.warnings.some((w) => /no verified reasoning control/i.test(w)), r.warnings.join('|'));
});

test.after(() => resetCapabilityRegistry());
