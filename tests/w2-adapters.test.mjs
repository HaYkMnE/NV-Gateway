/**
 * W2 adapter regression tests (Level-1 fix wave).
 *
 * Defects under test:
 *  1. `body.tools.map(t => t.name)` threw on `[null]` and emitted nameless tools.
 *  2. Assistant `thinking` blocks were replayed only for Kimi K3, so multi-turn
 *     fidelity differed per family.
 *  3. Upstream SSE error text was echoed to clients up to 1000 chars with no
 *     credential/URL-token stripping.
 *  5. Regression guard for the Responses facade reasoning.effort contract.
 *
 * Pure adapter tests: no network, no secrets.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { translateAnthropicRequest, translateAnthropicSseStream, AnthropicUpstreamSseError } from '../src/gateway/anthropic-adapter.mjs';
import { translateResponsesRequest } from '../src/gateway/responses-adapter.mjs';
import { resetCapabilityProbeState } from '../src/gateway/capability-probe.mjs';
import { resetCapabilityRegistry } from '../src/gateway/capability-registry.mjs';

const BASE = { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };

function translate(model, extra = {}) {
  resetCapabilityProbeState({ cachePath: null });
  resetCapabilityRegistry();
  return translateAnthropicRequest({ model, ...BASE, ...extra });
}

function assistant(blocks) {
  return { messages: [{ role: 'assistant', content: blocks }] };
}

async function* chunks(list) {
  for (const chunk of list) yield chunk;
}

async function collect(generator) {
  const out = [];
  for await (const event of generator) out.push(event);
  return out;
}

// ── Defect 1: malformed tool entries must never crash or reach upstream ───────

const INVALID_TOOL_CASES = [
  ['a null entry', [null]],
  ['an entry with no name', [{}]],
  ['a numeric name', [{ name: 123 }]],
  ['an empty-string name', [{ name: '' }]],
  ['a string entry', ['not-a-tool']]
];

for (const [label, tools] of INVALID_TOOL_CASES) {
  test(`defect 1: ${label} is dropped with a warning and no tools are forwarded`, () => {
    const r = translate('z-ai/glm-5.2', { tools });
    assert.deepEqual(r.errors, [], `malformed tools must not become a request error: ${r.errors.join('|')}`);
    assert.equal('tools' in r.openaiBody, false, 'an all-invalid tools array must omit the field');
    assert.ok(r.warnings.length > 0, 'dropping tools must be diagnosable from the log');
  });
}

test('defect 1: a mixed valid/invalid tools array keeps only the valid entry', () => {
  const r = translate('z-ai/glm-5.2', {
    tools: [null, { name: 'weather', description: 'Get weather', input_schema: { type: 'object' } }, { name: 7 }]
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.openaiBody.tools.length, 1);
  assert.equal(r.openaiBody.tools[0].function.name, 'weather');
  assert.equal(r.openaiBody.tools[0].function.description, 'Get weather');
  assert.deepEqual(r.openaiBody.tools[0].function.parameters, { type: 'object' });
  assert.ok(r.warnings.some((w) => /tool/i.test(w)), 'the dropped entries must be reported');
});

test('defect 1: an all-invalid tools array also drops tool_choice (OpenAI rejects it without tools)', () => {
  const r = translate('z-ai/glm-5.2', { tools: [null, {}], tool_choice: { type: 'any' } });
  assert.equal('tools' in r.openaiBody, false);
  assert.equal('tool_choice' in r.openaiBody, false);
});

test('defect 1: tools:null and tools:{} keep their existing non-regressing behavior', () => {
  for (const tools of [null, {}]) {
    const r = translate('z-ai/glm-5.2', { tools });
    assert.deepEqual(r.errors, [], JSON.stringify(tools));
    assert.equal('tools' in r.openaiBody, false, JSON.stringify(tools));
    assert.deepEqual(r.warnings, [], `${JSON.stringify(tools)} must stay silent`);
  }
});

// ── Defect 2: prior assistant reasoning is replayed for the reasoning families ─

const ECHO_FAMILIES = [
  ['z-ai/glm-5.3', 'GLM-5.3'],
  ['z-ai/glm-5.2', 'z-ai'],
  ['deepseek-ai/deepseek-v4.1-flash', 'DeepSeek V4.1'],
  ['moonshotai/kimi-k3', 'Kimi K3 (unchanged)']
];

for (const [model, label] of ECHO_FAMILIES) {
  test(`defect 2: ${label} replays prior assistant thinking as reasoning_content`, () => {
    const r = translate(model, assistant([
      { type: 'thinking', thinking: 'prior reasoning' },
      { type: 'text', text: 'visible answer' }
    ]));
    assert.deepEqual(r.errors, []);
    assert.equal(r.openaiBody.messages.length, 1);
    assert.equal(r.openaiBody.messages[0].reasoning_content, 'prior reasoning', `${label} must echo reasoning`);
    assert.equal(r.openaiBody.messages[0].content, 'visible answer');
  });
}

test('defect 2: thinking + text + tool_use keeps text, reasoning and tool_calls on one message in order', () => {
  const r = translate('z-ai/glm-5.3', assistant([
    { type: 'thinking', thinking: 'plan the call' },
    { type: 'text', text: 'calling the tool' },
    { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'Paris' } }
  ]));
  assert.deepEqual(r.errors, []);
  const [message] = r.openaiBody.messages;
  assert.equal(message.content, 'calling the tool');
  assert.equal(message.reasoning_content, 'plan the call');
  assert.equal(message.tool_calls.length, 1);
  assert.equal(message.tool_calls[0].id, 'toolu_1');
  assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { city: 'Paris' });
});

test('defect 2: multiple thinking blocks join in order for the newly covered families', () => {
  const r = translate('deepseek-ai/deepseek-v4.1-flash', assistant([
    { type: 'thinking', thinking: 'step one' },
    { type: 'thinking', thinking: 'step two' },
    { type: 'text', text: 'done' }
  ]));
  assert.equal(r.openaiBody.messages[0].reasoning_content, 'step one\nstep two');
});

for (const [model, label] of [
  ['nvidia/llama-3.1-nemotron-70b-instruct', 'Nemotron (must not receive reasoning back)'],
  ['meta/llama-4-maverick-17b-128e-instruct', 'a non-reasoning family']
]) {
  test(`defect 2: ${label} still drops assistant thinking with a warning`, () => {
    const r = translate(model, assistant([
      { type: 'thinking', thinking: 'private thought' },
      { type: 'text', text: 'visible answer' }
    ]));
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.openaiBody.messages, [{ role: 'assistant', content: 'visible answer' }]);
    assert.ok(r.warnings.some((w) => /thinking/.test(w)), 'the drop must stay diagnosable');
  });
}

test('defect 2: a USER-role thinking block is never replayed', () => {
  const r = translate('z-ai/glm-5.3', {
    messages: [{ role: 'user', content: [{ type: 'thinking', thinking: 'not mine' }, { type: 'text', text: 'hi' }] }]
  });
  assert.equal(r.openaiBody.messages.length, 1);
  assert.equal('reasoning_content' in r.openaiBody.messages[0], false);
  assert.equal(r.openaiBody.messages[0].content, 'hi');
});

// ── Defect 3: upstream SSE error text is bounded and credential-safe ─────────

const FAKE_TOKEN = 'nvapi-abcdefghijklmnopqrstuvwxyz0123456789';
const FAKE_STACK = `Error: upstream exploded\n    at handler (C:\\svc\\app.js:1:1)\n${'    at frame (app.js:2:2)\n'.repeat(200)}`;

function sseErrorFrame(message) {
  return `data: ${JSON.stringify({ error: { type: 'api_error', message } })}\n\n`;
}

test('defect 3: an upstream SSE error message is capped and stripped of credentials and URL tokens', async () => {
  const message = `Authorization: Bearer ${FAKE_TOKEN} failed for https://api.example.com/v1/run?token=${FAKE_TOKEN}#frag\n${FAKE_STACK}`;
  let error;
  try {
    await collect(translateAnthropicSseStream(chunks([sseErrorFrame(message)]), 'msg_err', 'z-ai/glm-5.3', { errorOnIncomplete: true }));
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof AnthropicUpstreamSseError, 'the pre-commit error must stay typed');
  assert.ok(error.message.length <= 300, `message must be bounded, got ${error.message.length} chars`);
  assert.equal(error.message.includes(FAKE_TOKEN), false, 'the fake token must never reach the client');
  assert.equal(/token=/i.test(error.message), false, 'URL query tokens must be stripped');
  assert.equal(/nvapi-/i.test(error.message), false);
  assert.match(error.message, /upstream exploded/i, 'the actionable part of the message must survive');
});

test('defect 3: a plain actionable upstream error message is preserved verbatim', async () => {
  let error;
  try {
    await collect(translateAnthropicSseStream(chunks([sseErrorFrame('reasoning_effort is not supported for this model')]), 'msg_err2', 'z-ai/glm-5.3', { errorOnIncomplete: true }));
  } catch (caught) {
    error = caught;
  }
  assert.equal(error.message, 'reasoning_effort is not supported for this model');
});

test('defect 3: a post-commit upstream error event is also bounded and stripped', async () => {
  const events = await collect(translateAnthropicSseStream(chunks([
    'data: {"choices":[{"delta":{"content":"visible"},"finish_reason":null}]}\n\n',
    sseErrorFrame(`boom Bearer ${FAKE_TOKEN} ${FAKE_STACK}`)
  ]), 'msg_err3', 'z-ai/glm-5.3', { errorOnIncomplete: true }));
  const errorEvent = events.map((event) => {
    const line = event.split('\n').find((entry) => entry.startsWith('data: '));
    return line ? JSON.parse(line.slice(6)) : null;
  }).find((data) => data?.type === 'error');
  assert.ok(errorEvent, 'a post-commit error event must be emitted');
  assert.ok(errorEvent.error.message.length <= 300);
  assert.equal(errorEvent.error.message.includes(FAKE_TOKEN), false);
});

// ── Defect 5: Responses facade reasoning.effort contract (regression guard) ──

test('defect 5: Responses reasoning.effort still maps for GLM-5.3 and Kimi K3', () => {
  const glm = translateResponsesRequest({ model: 'z-ai/glm-5.3', input: 'hi', reasoning: { effort: 'xhigh' } });
  assert.equal(glm.chatBody.reasoning_effort, 'max');
  const glmDefault = translateResponsesRequest({ model: 'z-ai/glm-5.3', input: 'hi' });
  assert.equal('reasoning_effort' in glmDefault.chatBody, false, 'no effort is fabricated without client intent');

  const kimi = translateResponsesRequest({ model: 'moonshotai/kimi-k3', input: 'hi', reasoning: { effort: 'medium' } });
  assert.equal(kimi.chatBody.reasoning_effort, 'high');
  assert.deepEqual(kimi.ignored, []);
});

test('defect 5: Responses never fabricates the unverified DeepSeek V4.1 string effort', () => {
  const result = translateResponsesRequest({ model: 'deepseek-ai/deepseek-v4.1-flash', input: 'hi', reasoning: { effort: 'high' } });
  assert.equal('reasoning_effort' in result.chatBody, false);
  assert.deepEqual(result.ignored, ['reasoning']);
});
