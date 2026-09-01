import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { translateAnthropicRequest } from '../src/gateway/anthropic-adapter.mjs';
import { resetCapabilityProbeState } from '../src/gateway/capability-probe.mjs';

const tempRoot = fs.mkdtempSync(path.join('C:\\OPENCODE-SANDBOX', 'nv-capability-layering-'));
let fixtureSequence = 0;

test.after(() => {
  resetCapabilityProbeState({ cachePath: null });
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function seedProbe(modelId, entry) {
  const cachePath = path.join(tempRoot, `probe-${fixtureSequence++}.json`);
  fs.writeFileSync(cachePath, JSON.stringify({
    version: 2,
    savedAt: '2026-09-01T00:00:00.000Z',
    entries: {
      [modelId]: {
        probedAt: 1,
        source: 'probed',
        ...entry,
      },
    },
  }));
  resetCapabilityProbeState({ cachePath });
}

function translate(model, type) {
  return translateAnthropicRequest({
    model,
    max_tokens: 100,
    messages: [{ role: 'user', content: 'Think.' }],
    thinking: { type },
  });
}

const STATIC_CONTROL_CASES = [
  {
    model: 'z-ai/glm-4.5',
    assertDisabled(openaiBody) {
      assert.equal(openaiBody.reasoning_effort, 'none');
      assert.equal(openaiBody.chat_template_kwargs?.enable_thinking, false);
    },
  },
  {
    model: 'qwen/qwen3.5-397b-a17b',
    assertDisabled(openaiBody) {
      assert.equal(openaiBody.chat_template_kwargs?.enable_thinking, false);
      assert.ok(!('reasoning_effort' in openaiBody));
    },
  },
  {
    model: 'stepfun-ai/step-3.7-flash',
    assertDisabled(openaiBody) {
      assert.equal(openaiBody.chat_template_kwargs?.thinking, false);
      assert.ok(!('reasoning_effort' in openaiBody));
    },
  },
  {
    model: 'minimaxai/minimax-m3',
    assertDisabled(openaiBody) {
      assert.equal(openaiBody.chat_template_kwargs?.thinking_mode, 'disabled');
      assert.ok(!('reasoning_effort' in openaiBody));
    },
  },
];

for (const { model, assertDisabled } of STATIC_CONTROL_CASES) {
  test(`${model}: probe evidence layers over static controls without gaining veto power`, () => {
    // Deliberately omits controlKey, enableValue, disableValue, and alternateControl.
    seedProbe(model, { supported: true, modes: ['none', 'low', 'high'] });

    const incompletePositive = translate(model, 'disabled');

    assert.deepEqual(incompletePositive.errors, []);
    assert.ok(incompletePositive.openaiBody);
    assertDisabled(incompletePositive.openaiBody);

    // A negative reasoning_effort probe is not evidence that all reasoning is unsupported.
    seedProbe(model, { supported: false, modes: [] });

    const negative = translate(model, 'disabled');

    assert.deepEqual(negative.errors, []);
    assert.ok(negative.openaiBody);
    assertDisabled(negative.openaiBody);
  });
}

test('positive live probe unblocks a model that static data marks unsupported', () => {
  const model = 'meta/llama-4-maverick-17b-128e-instruct';
  seedProbe(model, { supported: true, modes: ['low', 'high'] });

  const result = translate(model, 'enabled');

  assert.deepEqual(result.errors, []);
  assert.equal(result.openaiBody?.reasoning_effort, 'high');
});
