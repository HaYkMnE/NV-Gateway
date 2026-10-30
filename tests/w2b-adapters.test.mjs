/**
 * W2b adapter regression tests (Level-1 fix wave, worker W2) — ADDITIONS.
 *
 * tests/w2-adapters.test.mjs is the W2 spec and is not modified here. This file
 * covers what the spec leaves implicit:
 *  - defect 1: every malformed tool SHAPE (array entry, boolean, number, nested
 *    null input_schema) plus proof that the valid path is untouched;
 *  - defect 2: per-family echo/drop matrix, incl. Nemotron and an unknown
 *    family, and that reasoning never leaks onto a tool message;
 *  - defect 3: the Responses facade shares the same bound/scrub, and the
 *    sanitizer itself keeps short actionable text byte-for-byte;
 *  - defect 5: the Responses reasoning.effort contract for Kimi's full accepted
 *    set, plus the DeepSeek V4.1 no-string-effort rule under every effort value.
 *
 * Pure adapter tests: no network, no secrets (all tokens are synthetic).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  translateAnthropicRequest,
  translateAnthropicSseStream,
  sanitizeUpstreamErrorMessage,
  AnthropicUpstreamSseError
} from '../src/gateway/anthropic-adapter.mjs';
import { translateResponsesRequest, translateResponsesSseStream, ResponsesUpstreamSseError } from '../src/gateway/responses-adapter.mjs';
import { resetCapabilityProbeState } from '../src/gateway/capability-probe.mjs';
import { resetCapabilityRegistry } from '../src/gateway/capability-registry.mjs';

const BASE = { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };
const FAKE_TOKEN = 'nvapi-synthetic0123456789abcdefghijklmn';

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

// ── Defect 1: shapes beyond the spec's list ─────────────────────────────────

const MORE_INVALID_TOOLS = [
  ['an array entry', [[]]],
  ['a boolean entry', [true]],
  ['a number entry', [42]],
  ['a function entry', [() => {}]],
  ['a name with only whitespace is still a non-empty string (kept)', null]
];

for (const [label, tools] of MORE_INVALID_TOOLS) {
  if (tools === null) continue;
  test(`w2b defect 1: ${label} is dropped, never forwarded`, () => {
    const r = translate('z-ai/glm-5.2', { tools });
    assert.deepEqual(r.errors, []);
    assert.equal('tools' in r.openaiBody, false);
    assert.ok(r.warnings.some((w) => /tool/i.test(w)));
  });
}

test('w2b defect 1: a nested null input_schema falls back instead of crashing structuredClone', () => {
  // structuredClone(null) is fine, but `input_schema: null` must not be read as
  // a truthy schema; the existing fallback shape must be used.
  const r = translate('z-ai/glm-5.2', { tools: [{ name: 'weather', input_schema: null }] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.openaiBody.tools.length, 1);
  assert.deepEqual(r.openaiBody.tools[0].function.parameters, { type: 'object', properties: {} });
});

test('w2b defect 1: a valid tools array is byte-identical to the pre-fix translation', () => {
  const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
  const r = translate('z-ai/glm-5.2', {
    tools: [{ name: 'get_weather', description: 'Weather', input_schema: schema }]
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.openaiBody.tools, [{
    type: 'function',
    function: { name: 'get_weather', description: 'Weather', parameters: schema }
  }]);
  assert.deepEqual(r.warnings, [], 'a fully valid request must stay silent');
});

test('w2b defect 1: dropping all tools leaves a usable request (no tools, no tool_choice, no error)', () => {
  const r = translate('z-ai/glm-5.2', { tools: [null], tool_choice: { type: 'auto' } });
  assert.deepEqual(r.errors, []);
  assert.equal('tools' in r.openaiBody, false);
  assert.equal('tool_choice' in r.openaiBody, false);
  // The rest of the request still translates: this is why the policy is DROP
  // (repair) rather than 400 (reject the whole request).
  assert.equal(r.openaiBody.max_tokens, 100);
  assert.deepEqual(r.openaiBody.messages, [{ role: 'user', content: 'hi' }]);
});

// ── Defect 2: per-family echo matrix ───────────────────────────────────────

const ECHO = [
  ['z-ai/glm-5.3', true],
  ['z-ai/glm-5.3-flash', true],
  ['z-ai/glm-5.2', true],
  ['deepseek-ai/deepseek-v4.1-flash', true],
  ['deepseek-ai/deepseek-r1', false],
  ['moonshotai/kimi-k3', true],
  ['nvidia/llama-3.1-nemotron-70b-instruct', false],
  ['meta/llama-4-maverick-17b-128e-instruct', false],
  ['qwen/qwen3-next-80b-a3b-thinking', false],
  ['some-unknown-vendor/unknown-model', false]
];

for (const [model, echoes] of ECHO) {
  test(`w2b defect 2: ${model} ${echoes ? 'echoes' : 'drops'} assistant thinking`, () => {
    const r = translate(model, assistant([
      { type: 'thinking', thinking: 'prior reasoning' },
      { type: 'text', text: 'visible answer' }
    ]));
    assert.deepEqual(r.errors, []);
    const [message] = r.openaiBody.messages;
    assert.equal(message.content, 'visible answer');
    if (echoes) {
      assert.equal(message.reasoning_content, 'prior reasoning');
      assert.equal(r.warnings.some((w) => /thinking/.test(w)), false, 'an echo must not warn about a drop');
    } else {
      assert.equal('reasoning_content' in message, false, `${model} must NOT receive reasoning back`);
      assert.ok(r.warnings.some((w) => /thinking/.test(w)), 'the drop must stay diagnosable');
    }
  });
}

test('w2b defect 2: an echo family replays thinking on a tool-only assistant turn (no text)', () => {
  const r = translate('deepseek-ai/deepseek-v4.1-flash', assistant([
    { type: 'thinking', thinking: 'pick the tool' },
    { type: 'tool_use', id: 'toolu_x', name: 'weather', input: { city: 'Rome' } }
  ]));
  const [message] = r.openaiBody.messages;
  assert.equal(message.content, null);
  assert.equal(message.reasoning_content, 'pick the tool');
  assert.equal(message.tool_calls.length, 1);
});

test('w2b defect 2: reasoning is never attached to the tool RESULT message', () => {
  // A tool_result turn carries no reasoning of its own; echoing onto the tool
  // message would be a protocol violation (tool messages accept no such field).
  const r = translate('z-ai/glm-5.3', {
    messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'think' }, { type: 'tool_use', id: 'toolu_1', name: 'weather', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' }] }
    ]
  });
  assert.deepEqual(r.errors, []);
  const toolMessage = r.openaiBody.messages.find((m) => m.role === 'tool');
  assert.ok(toolMessage, 'the tool result must still be translated');
  assert.equal('reasoning_content' in toolMessage, false);
  assert.equal(toolMessage.tool_call_id, 'toolu_1');
});

test('w2b defect 2: a non-string thinking value is dropped with a warning, not echoed as [object Object]', () => {
  const r = translate('z-ai/glm-5.3', assistant([
    { type: 'thinking', thinking: { bogus: true } },
    { type: 'text', text: 'answer' }
  ]));
  const [message] = r.openaiBody.messages;
  assert.equal(message.content, 'answer');
  assert.equal('reasoning_content' in message, false);
  assert.ok(r.warnings.some((w) => /thinking/.test(w)));
});

// ── Defect 3: sanitizer contract + the Responses facade ────────────────────

test('w2b defect 3: the sanitizer is a no-op for short, clean, actionable text', () => {
  for (const clean of [
    'reasoning_effort is not supported for this model',
    'model `z-ai/glm-5.3` is not found',
    'This model does not support thinking'
  ]) {
    assert.equal(sanitizeUpstreamErrorMessage(clean), clean);
  }
});

test('w2b defect 3: the sanitizer bounds a message with NO secret in it too', () => {
  const long = 'x'.repeat(5_000);
  const out = sanitizeUpstreamErrorMessage(long);
  assert.ok(out.length <= 300, `expected <=300, got ${out.length}`);
});

test('w2b defect 3: the sanitizer strips a Bearer token, nvapi key, and URL query tokens', () => {
  const raw = `auth Bearer ${FAKE_TOKEN} via https://api.example.com/v1/x?api_key=${FAKE_TOKEN}&q=1 plus nvapi-secondkey1234567890`;
  const out = sanitizeUpstreamErrorMessage(raw);
  assert.equal(out.includes(FAKE_TOKEN), false);
  assert.equal(/nvapi-/i.test(out), false);
  assert.equal(/api_key=/i.test(out), false);
  assert.equal(/Bearer\s+nvapi/i.test(out), false);
});

test('w2b defect 3: a RELATIVE url query string is stripped too (redact only scrubs absolute urls)', () => {
  // shared/redaction.mjs only inspects ABSOLUTE urls, so an upstream that quotes
  // its own route ("POST /v1/chat/completions?token=...") slipped through with
  // the credential intact. The sanitizer is the client-facing boundary and must
  // not depend on the upstream choosing an absolute url.
  const out = sanitizeUpstreamErrorMessage('POST /v1/chat/completions?token=abc123secret&x=1 returned 400');
  assert.equal(/token=/i.test(out), false, out);
  assert.equal(out.includes('abc123secret'), false, out);
  assert.match(out, /\/v1\/chat\/completions/, 'the route stays actionable');
});

test('w2b defect 3: header-style credentials are stripped (Basic auth, x-api-key, api_key=, cookie)', () => {
  for (const raw of [
    'Authorization: Basic dXNlcjpwYXNzd29yZA== failed',
    'x-api-key: sk-live-abcdef123456789 rejected',
    'upstream rejected api_key=sk-live-abcdef123456789',
    'cookie: session=abcdef123456789 failed'
  ]) {
    const out = sanitizeUpstreamErrorMessage(raw);
    for (const secret of ['dXNlcjpwYXNzd29yZA', 'sk-live-abcdef123456789', 'abcdef123456789']) {
      assert.equal(out.includes(secret), false, `${raw} -> ${out}`);
    }
    assert.match(out, /fail|reject/i, `the actionable verb must survive: ${out}`);
  }
});

test('w2b defect 3: the wider scrub never eats actionable wording (no key=value, no ?#)', () => {
  // Guards the two new patterns against over-reach: prose that merely MENTIONS a
  // credential word, and a bare route with no query string, must pass through.
  for (const clean of [
    'token budget exceeded',
    'invalid api_key format',
    'the secret sauce is missing',
    'POST /v1/chat/completions returned 400',
    'reasoning_effort is not supported for this model',
    // Punctuation that merely looks like a fragment separator must survive: the
    // scrub is anchored on a path, not on a bare `?` / `#`.
    'why? because upstream said no',
    'error#42 occurred',
    'model not found #404'
  ]) {
    assert.equal(sanitizeUpstreamErrorMessage(clean), clean);
  }
});

test('w2b defect 3: a non-string / empty upstream message falls back to a stable string', () => {
  for (const value of [undefined, null, '', '   ', 42, { message: 'nested' }]) {
    assert.equal(sanitizeUpstreamErrorMessage(value), 'Upstream SSE error', JSON.stringify(value));
  }
});

test('w2b defect 3: the Responses facade bounds and scrubs a pre-commit upstream SSE error', async () => {
  const message = `boom Bearer ${FAKE_TOKEN} ${'    at frame (C:\\svc\\app.js:1:1)\n'.repeat(100)}`;
  let error;
  try {
    await collect(translateResponsesSseStream(chunks([
      `data: ${JSON.stringify({ error: { message, type: 'server_error' } })}\n\n`
    ]), {}, { errorOnIncomplete: true }));
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof ResponsesUpstreamSseError);
  assert.ok(error.message.length <= 300, `expected <=300, got ${error.message.length}`);
  assert.equal(error.message.includes(FAKE_TOKEN), false);
  assert.match(error.message, /boom/);
});

test('w2b defect 3: the Responses facade bounds a post-commit response.failed message', async () => {
  const events = await collect(translateResponsesSseStream(chunks([
    'data: {"choices":[{"delta":{"content":"visible"},"finish_reason":null}]}\n\n',
    `data: ${JSON.stringify({ error: { message: `late Bearer ${FAKE_TOKEN} ${'y'.repeat(2_000)}` } })}\n\n`
  ]), {}, { errorOnIncomplete: true }));
  const failed = events
    .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)))
    .find((data) => data?.type === 'response.failed');
  assert.ok(failed, 'a post-commit error must emit response.failed');
  assert.ok(failed.response.error.message.length <= 300);
  assert.equal(failed.response.error.message.includes(FAKE_TOKEN), false);
});

test('w2b defect 3: an Anthropic pre-commit error keeps its type/status metadata after scrubbing', async () => {
  let error;
  try {
    await collect(translateAnthropicSseStream(chunks([
      `data: ${JSON.stringify({ error: { message: `bad Bearer ${FAKE_TOKEN}`, type: 'overloaded_error', code: 'overloaded', status_code: 529 } })}\n\n`
    ]), 'msg_meta', 'z-ai/glm-5.3', { errorOnIncomplete: true }));
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof AnthropicUpstreamSseError);
  assert.equal(error.upstreamType, 'overloaded_error');
  assert.equal(error.upstreamCode, 'overloaded');
  assert.equal(error.upstreamStatusCode, 529);
  assert.equal(error.message.includes(FAKE_TOKEN), false);
});

// ── Defect 5: Responses reasoning.effort regression matrix ─────────────────

test('w2b defect 5: Kimi K3 maps the full client effort set onto low|high|max', () => {
  const cases = [
    ['low', 'low'],
    ['medium', 'high'],
    ['high', 'high'],
    ['xhigh', 'max'],
    ['max', 'max'],
    ['none', 'low'],
    ['minimal', 'low']
  ];
  for (const [client, expected] of cases) {
    const r = translateResponsesRequest({ model: 'moonshotai/kimi-k3', input: 'hi', reasoning: { effort: client } });
    assert.equal(r.chatBody.reasoning_effort, expected, `kimi ${client}`);
    assert.deepEqual(r.ignored, []);
  }
});

test('w2b defect 5: GLM-5.3 maps the full client effort set onto low|high|max', () => {
  const cases = [
    ['low', 'low'],
    ['medium', 'high'],
    ['high', 'high'],
    ['xhigh', 'max'],
    ['max', 'max'],
    ['none', 'low'],
    ['minimal', 'low']
  ];
  for (const [client, expected] of cases) {
    const r = translateResponsesRequest({ model: 'z-ai/glm-5.3', input: 'hi', reasoning: { effort: client } });
    assert.equal(r.chatBody.reasoning_effort, expected, `glm ${client}`);
    assert.deepEqual(r.ignored, []);
  }
});

test('w2b defect 5: DeepSeek V4.1 never gets a string effort, for ANY client value', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'none', 'minimal', 'nonsense']) {
    const r = translateResponsesRequest({ model: 'deepseek-ai/deepseek-v4.1-flash', input: 'hi', reasoning: { effort } });
    assert.equal('reasoning_effort' in r.chatBody, false, `deepseek ${effort}`);
    assert.deepEqual(r.ignored, ['reasoning'], `deepseek ${effort} must report reasoning as ignored`);
  }
});

test('w2b defect 5: a model with no effort policy ignores reasoning without inventing a field', () => {
  const r = translateResponsesRequest({ model: 'meta/llama-4-maverick-17b-128e-instruct', input: 'hi', reasoning: { effort: 'high' } });
  assert.equal('reasoning_effort' in r.chatBody, false);
  assert.deepEqual(r.ignored, ['reasoning']);
});

test('w2b defect 5: an unknown effort value is not fabricated into a field', () => {
  for (const model of ['z-ai/glm-5.3', 'moonshotai/kimi-k3']) {
    const r = translateResponsesRequest({ model, input: 'hi', reasoning: { effort: 'ultra' } });
    assert.equal('reasoning_effort' in r.chatBody, false, model);
  }
});

test('w2b defect 5: unsupported reasoning subfields are reported by NAME, never by value', () => {
  const r = translateResponsesRequest({
    model: 'z-ai/glm-5.3', input: 'hi',
    reasoning: { effort: 'high', summary: 'secret-derived-summary', encrypted_content: 'opaque-blob' }
  });
  assert.equal(r.chatBody.reasoning_effort, 'high');
  assert.deepEqual(r.ignored, ['reasoning.summary', 'reasoning.encrypted_content']);
  assert.equal(JSON.stringify(r).includes('secret-derived-summary'), false, 'values must never be echoed');
  assert.equal(JSON.stringify(r).includes('opaque-blob'), false, 'values must never be echoed');
});
