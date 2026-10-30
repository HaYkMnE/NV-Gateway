import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { translateAnthropicRequest, translateAnthropicResponse, translateAnthropicSseStream } from '../src/gateway/anthropic-adapter.mjs';
import * as probe from '../src/gateway/capability-probe.mjs';

// Helpers for consuming the SSE async generator into parseable events.
async function collectSseEvents(asyncGen) {
  const events = [];
  for await (const ev of asyncGen) {
    events.push(ev);
  }
  return events;
}

function parseEvents(events) {
  return events.map(ev => {
    const lines = ev.split('\n');
    let eventType = '';
    let data = null;
    for (const line of lines) {
      if (line.startsWith('event: ')) eventType = line.slice(7).trim();
      if (line.startsWith('data: ')) {
        try { data = JSON.parse(line.slice(6)); } catch (e) { data = line.slice(6); }
      }
    }
    return { eventType, data };
  });
}

// Helper to make an async iterable of raw SSE strings
function asyncFrom(arr) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const x of arr) yield x;
    },
  };
}

test('1. model missing → error', () => {
  const r = translateAnthropicRequest({ messages: [], max_tokens: 100 });
  assert.ok(r.errors.includes('model is required'));
  assert.equal(r.openaiBody, null);
});

test('2. simple text message with string system', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 100,
    system: 'You are helpful.',
  });
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.openaiBody.messages, [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
  ]);
});

test('3. system as array of text blocks', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 100,
    system: [
      { type: 'text', text: 'Part 1' },
      { type: 'text', text: 'Part 2' },
    ],
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.messages[0].role, 'system');
  assert.equal(r.openaiBody.messages[0].content, 'Part 1\nPart 2');
});

test('4. tool_use in assistant message → tool_calls', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [
      { role: 'user', content: 'Get weather' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'London' } },
        ],
      },
    ],
    max_tokens: 100,
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.messages[1].role, 'assistant');
  assert.equal(r.openaiBody.messages[1].content, null);
  assert.equal(r.openaiBody.messages[1].tool_calls[0].id, 'toolu_1');
  assert.equal(JSON.parse(r.openaiBody.messages[1].tool_calls[0].function.arguments).city, 'London');
});

test('5. tool_result in user message → separate tool message', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [
      { role: 'user', content: 'Get weather' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'London' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '15C raining' },
          { type: 'text', text: 'What about tomorrow?' },
        ],
      },
    ],
    max_tokens: 100,
  });
  assert.equal(r.errors.length, 0);
  const toolMsg = r.openaiBody.messages.find(m => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'toolu_1');
  assert.equal(toolMsg.content, '15C raining');
  const userMsg = r.openaiBody.messages.filter(m => m.role === 'user');
  assert.equal(userMsg[1].content, 'What about tomorrow?');
});

test('6. assistant with text + tool_use → content AND tool_calls', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [
      { role: 'user', content: 'Use the tool' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Sure let me check' },
          { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'London' } },
        ],
      },
    ],
    max_tokens: 100,
  });
  assert.equal(r.errors.length, 0);
  const asstMsg = r.openaiBody.messages[1];
  assert.equal(asstMsg.role, 'assistant');
  assert.equal(asstMsg.content, 'Sure let me check');
  assert.equal(asstMsg.tool_calls[0].id, 'toolu_1');
});

test('6a. Kimi K3 assistant thinking + text replays reasoning_content for multi-turn context', () => {
  const r = translateAnthropicRequest({
    model: 'moonshotai/kimi-k3', max_tokens: 100,
    messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'first reason' },
      { type: 'text', text: 'final answer' }
    ] }]
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.openaiBody.messages, [{ role: 'assistant', content: 'final answer', reasoning_content: 'first reason' }]);
});

test('6b. Kimi K3 assistant thinking + tool_use preserves reasoning_content and tool_calls', () => {
  const r = translateAnthropicRequest({
    model: 'moonshotai/kimi-k3', max_tokens: 100,
    messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'use weather' },
      { type: 'tool_use', id: 'toolu_kimi', name: 'weather', input: { city: 'Paris' } }
    ] }]
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.openaiBody.messages[0].content, null);
  assert.equal(r.openaiBody.messages[0].reasoning_content, 'use weather');
  assert.equal(r.openaiBody.messages[0].tool_calls[0].id, 'toolu_kimi');
});

test('6c. Kimi K3 joins multiple assistant thinking blocks in order', () => {
  const r = translateAnthropicRequest({
    model: 'moonshotai/kimi-k3', max_tokens: 100,
    messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'step one' },
      { type: 'thinking', thinking: 'step two' },
      { type: 'text', text: 'done' }
    ] }]
  });
  assert.equal(r.openaiBody.messages[0].reasoning_content, 'step one\nstep two');
});

test('6d. a non-echoing family still drops assistant thinking with a warning', () => {
  // z-ai/glm-5.3, deepseek-ai/* and Kimi K3 now replay prior reasoning (6a-6c
  // and tests/w2-adapters.test.mjs); families whose upstream contract does not
  // accept an echoed reasoning_content keep the drop-with-warning behavior.
  const r = translateAnthropicRequest({
    model: 'meta/llama-4-maverick-17b-128e-instruct', max_tokens: 100,
    messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'private thought' },
      { type: 'text', text: 'visible answer' }
    ] }]
  });
  assert.deepEqual(r.openaiBody.messages, [{ role: 'assistant', content: 'visible answer' }]);
  assert.ok(r.warnings.some((w) => /unsupported content block type: thinking/.test(w)));
});

test('7. tools → OpenAI function format', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 100,
    tools: [
      { name: 'calc', description: 'Calculator', input_schema: { type: 'object', properties: { x: { type: 'number' } } } },
    ],
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.tools[0].type, 'function');
  assert.equal(r.openaiBody.tools[0].function.name, 'calc');
  assert.equal(r.openaiBody.tools[0].function.parameters.properties.x.type, 'number');
});

test('8. max_tokens missing → error', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  assert.ok(r.errors.includes('max_tokens is required'));
  assert.equal(r.openaiBody, null);
});

test('9. stop_sequences → stop, top_k → warning', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 100,
    stop_sequences: ['END'],
    top_k: 40,
  });
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.openaiBody.stop, ['END']);
  assert.equal(r.warnings.filter(w => w.includes('top_k')).length, 1);
});

test('10. image content block → error', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: [{ type: 'image', source: { data: 'x' } }] }],
    max_tokens: 100,
  });
  assert.ok(r.errors.some(e => e.includes('Image')));
  assert.equal(r.openaiBody, null);
});

test('11. stream=true forwarded, temperature forwarded', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 100,
    stream: true,
    temperature: 0.7,
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.stream, true);
  assert.equal(r.openaiBody.temperature, 0.7);
});

test('12. tool parameters do not alias caller input_schema (defensive clone)', () => {
  const body = {
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 100,
    tools: [{ name: 'calc', description: 'x', input_schema: { type: 'object', properties: { x: { type: 'number' } } } }],
  };
  const r = translateAnthropicRequest(body);
  assert.equal(r.errors.length, 0);
  // Mutate the output — the input must not change
  r.openaiBody.tools[0].function.parameters.properties = 'CORRUPTED';
  assert.notEqual(body.tools[0].input_schema.properties, 'CORRUPTED');
});

test('13. stop_sequences does not alias caller array (defensive copy)', () => {
  const stop = ['END'];
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 100,
    stop_sequences: stop,
  });
  assert.equal(r.errors.length, 0);
  assert.notStrictEqual(r.openaiBody.stop, stop);
});

test('14. malformed tool_result without tool_use_id → error', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [
      { role: 'user', content: 'Use tool' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'result' }] }, // no tool_use_id
    ],
    max_tokens: 100,
  });
  assert.ok(r.errors.some(e => e.includes('tool_use_id')));
});

test('15. unsupported message role → skipped with warning', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'system', content: 'Extra system' },
      { role: 'weird', content: 'weird' },
    ],
    max_tokens: 100,
  });
  assert.ok(r.warnings.some(w => w.includes('system')));
  assert.ok(r.warnings.some(w => w.includes('weird')));
  // Only the user message should survive
  const nonUser = r.openaiBody.messages.filter(m => m.role !== 'user' && m.role !== 'system');
  // "system" role is skipped, "weird" role is skipped; only user remains (plus the gateway's own system if any)
  assert.equal(r.openaiBody.messages.filter(m => m.role === 'weird').length, 0);
  assert.equal(r.openaiBody.messages.filter(m => m.role === 'system' && m.content === 'Extra system').length, 0);
});

test('16. text block with non-string text → warning mentions malformed text', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: [{ type: 'text', text: 123 }] }],
    max_tokens: 100,
  });
  assert.ok(r.warnings.some(w => w.includes('malformed text')));
});

test('17. thinking enabled on z-ai/glm-5.2 budget 20000 -> reasoning_effort=high + enable_thinking=true', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 100,
    thinking: { type: 'enabled', budget_tokens: 20000 },
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.reasoning_effort, 'high');
  assert.equal(r.openaiBody.chat_template_kwargs.enable_thinking, true);
});

test('18. thinking disabled on z-ai/glm-5.2 -> enable_thinking=false + reasoning_effort=none', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 100,
    thinking: { type: 'disabled' },
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.reasoning_effort, 'none');
  assert.equal(r.openaiBody.chat_template_kwargs.enable_thinking, false);
});

test('19. thinking enabled on meta/llama model -> error', () => {
  const r = translateAnthropicRequest({
    model: 'meta/llama-4-maverick-17b-128e-instruct',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 100,
    thinking: { type: 'enabled', budget_tokens: 10000 },
  });
  assert.ok(r.errors.some(e => e.includes('does not support thinking')));
  assert.equal(r.openaiBody, null);
});

test('20. thinking enabled budget 4000 on z-ai/glm-5.2 -> reasoning_effort=low', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 100,
    thinking: { type: 'enabled', budget_tokens: 4000 },
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.reasoning_effort, 'low');
});

test('21. thinking enabled budget 50000 on z-ai/glm-5.2 -> reasoning_effort=max (no longer clamped to high; direct NVIDIA accepts Max)', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 100,
    thinking: { type: 'enabled', budget_tokens: 50000 },
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.reasoning_effort, 'max', 'budget 50000 -> max (z-ai/glm-5.2 modes include "max", adapter modes-clamp-down keeps it)');
});

test('22. thinking enabled on stepfun-ai model -> chat_template_kwargs.thinking=true', () => {
  const r = translateAnthropicRequest({
    model: 'stepfun-ai/step-3.7-flash',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 100,
    thinking: { type: 'enabled' },
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.chat_template_kwargs.thinking, true);
});

test('23. no thinking field -> no reasoning controls added', () => {
  const r = translateAnthropicRequest({
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 100,
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.reasoning_effort, undefined);
  assert.equal(r.openaiBody.chat_template_kwargs, undefined);
});

test('24. translateAnthropicResponse — simple text response -> Anthropic format', () => {
  const r = translateAnthropicResponse({
    id: 'chatcmpl-123',
    model: 'z-ai/glm-5.2',
    choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  assert.equal(r.type, 'message');
  assert.equal(r.role, 'assistant');
  assert.equal(r.stop_reason, 'end_turn');
  assert.equal(r.content[0].type, 'text');
  assert.equal(r.content[0].text, 'Hello!');
  assert.equal(r.usage.input_tokens, 10);
  assert.equal(r.usage.output_tokens, 5);
});

test('25. translateAnthropicResponse — tool_calls -> tool_use blocks', () => {
  const r = translateAnthropicResponse({
    id: 'chatcmpl-456',
    model: 'z-ai/glm-5.2',
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: 'call_1', function: { name: 'weather', arguments: '{"city":"London"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  });
  assert.equal(r.stop_reason, 'tool_use');
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, 'tool_use');
  assert.equal(r.content[0].id, 'call_1');
  assert.equal(r.content[0].name, 'weather');
  assert.deepEqual(r.content[0].input, { city: 'London' });
});

test('26. translateAnthropicResponse — reasoning_content -> thinking block', () => {
  const r = translateAnthropicResponse({
    id: 'chatcmpl-789',
    model: 'z-ai/glm-5.2',
    choices: [{
      message: { content: 'Answer', reasoning_content: 'Let me think...' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 5, completion_tokens: 15 },
  });
  // Anthropic's contract is thinking blocks FIRST, then text (the docs: "one
  // or more thinking content blocks arrive before the text blocks"; the
  // streaming path emits that same order, because upstream reasoning deltas
  // arrive before content deltas). The previous assertion pinned the inverse
  // order — an artefact of the old `content.unshift()` — so it is corrected
  // here rather than preserved.
  assert.equal(r.content.length, 2);
  assert.equal(r.content[0].type, 'thinking');
  assert.equal(r.content[0].thinking, 'Let me think...');
  assert.equal(r.content[1].type, 'text');
  assert.equal(r.content[1].text, 'Answer');
});

test('26a. translateAnthropicResponse — reasoning_content + tool_calls -> thinking precedes tool_use', () => {
  // Previously untested combination: a reasoning model that calls a tool
  // returns BOTH fields. The contract order is thinking -> text -> tool_use,
  // matching the streaming path (thinking deltas arrive first upstream).
  const reasoningPlusTool = translateAnthropicResponse({
    id: 'chatcmpl-790',
    model: 'z-ai/glm-5.2',
    choices: [{
      message: {
        content: null,
        reasoning_content: 'Check the weather first...',
        tool_calls: [{ id: 'call_2', function: { name: 'weather', arguments: '{"city":"London"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 5, completion_tokens: 15 },
  });
  assert.deepEqual(reasoningPlusTool.content.map((block) => block.type), ['thinking', 'tool_use']);
  assert.equal(reasoningPlusTool.content[0].thinking, 'Check the weather first...');
  assert.equal(reasoningPlusTool.content[1].name, 'weather');
  assert.equal(reasoningPlusTool.stop_reason, 'tool_use');

  // All three block kinds together pin the full order: thinking -> text -> tool_use.
  const allThree = translateAnthropicResponse({
    id: 'chatcmpl-791',
    model: 'z-ai/glm-5.2',
    choices: [{
      message: {
        content: 'Calling the tool now.',
        reasoning_content: 'Let me think...',
        tool_calls: [{ id: 'call_3', function: { name: 'weather', arguments: '{}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 5, completion_tokens: 25 },
  });
  assert.deepEqual(allThree.content.map((block) => block.type), ['thinking', 'text', 'tool_use']);
  assert.equal(allThree.content[0].thinking, 'Let me think...');
  assert.equal(allThree.content[1].text, 'Calling the tool now.');
  assert.equal(allThree.content[2].name, 'weather');
});

test('27. translateAnthropicResponse — stop_reason mapping (length->max_tokens)', () => {
  const r = translateAnthropicResponse({
    id: 'x',
    model: 'z-ai/glm-5.2',
    choices: [{ message: { content: '...' }, finish_reason: 'length' }],
    usage: {},
  });
  assert.equal(r.stop_reason, 'max_tokens');
});

test('28. translateAnthropicResponse — usage mapping', () => {
  const r = translateAnthropicResponse({
    id: 'x',
    model: 'x',
    choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 42, completion_tokens: 99 },
  });
  assert.equal(r.usage.input_tokens, 42);
  assert.equal(r.usage.output_tokens, 99);
});

test('29. reasoning→text transition: text_delta is in a TEXT block, not the thinking block', async () => {
  const chunks = asyncFrom([
    'data: {"choices":[{"delta":{"reasoning_content":"thinking..."},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const events = parseEvents(await collectSseEvents(translateAnthropicSseStream(chunks, 'msg_1', 'z-ai/glm-5.2')));
  // Find the text_delta event
  const textDelta = events.find(e => e.eventType === 'content_block_delta' && e.data?.delta?.type === 'text_delta');
  assert.ok(textDelta, 'text_delta must be emitted');
  // Find the content_block_start preceding it — must be type:text, not thinking
  const textIdx = textDelta.data.index;
  const blockStarts = events.filter(e => e.eventType === 'content_block_start');
  const blockForText = blockStarts.find(e => e.data.index === textIdx);
  assert.equal(blockForText.data.content_block.type, 'text', 'text_delta must be in a text block, not thinking');
});

test('30. multiple reasoning deltas accumulate in ONE thinking block', async () => {
  const chunks = asyncFrom([
    'data: {"choices":[{"delta":{"reasoning_content":"part1"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"part2"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"part3"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const events = parseEvents(await collectSseEvents(translateAnthropicSseStream(chunks, 'msg_2', 'z-ai/glm-5.2')));
  const thinkingStarts = events.filter(e => e.eventType === 'content_block_start' && e.data?.content_block?.type === 'thinking');
  assert.equal(thinkingStarts.length, 1, 'must be exactly ONE thinking content_block_start');
  const thinkingDeltas = events.filter(e => e.eventType === 'content_block_delta' && e.data?.delta?.type === 'thinking_delta');
  assert.equal(thinkingDeltas.length, 3, 'must be exactly 3 thinking_delta events');
});

test('31. text then tool_calls → tool_use gets its own block', async () => {
  const chunks = asyncFrom([
    'data: {"choices":[{"delta":{"content":"Let me check."},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"weather","arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"London\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const events = parseEvents(await collectSseEvents(translateAnthropicSseStream(chunks, 'msg_3', 'z-ai/glm-5.2')));
  const toolStarts = events.filter(e => e.eventType === 'content_block_start' && e.data?.content_block?.type === 'tool_use');
  assert.equal(toolStarts.length, 1, 'exactly one tool_use content_block_start');
  assert.equal(toolStarts[0].data.content_block.name, 'weather');

  // The arguments arrive split across two chunks; their input_json_delta
  // partial_json fragments must concatenate into the complete arguments JSON.
  const fragments = events
    .filter(e => e.eventType === 'content_block_delta' && e.data?.delta?.type === 'input_json_delta')
    .map(e => e.data.delta.partial_json);
  assert.deepEqual(fragments, ['{"city":', '"London"}'], 'both argument fragments must be emitted verbatim');
  assert.deepEqual(JSON.parse(fragments.join('')), { city: 'London' }, 'the accumulated fragments must form valid JSON');
});

test('32. two distinct tool_calls → two separate tool_use blocks', async () => {
  const chunks = asyncFrom([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"a","arguments":"{\\"x\\":1}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"b","arguments":"{\\"y\\":2}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const events = parseEvents(await collectSseEvents(translateAnthropicSseStream(chunks, 'msg_4', 'z-ai/glm-5.2')));
  const toolStarts = events.filter(e => e.eventType === 'content_block_start' && e.data?.content_block?.type === 'tool_use');
  assert.equal(toolStarts.length, 2, 'two distinct tool calls must produce two tool_use blocks');
  assert.equal(toolStarts[0].data.content_block.name, 'a');
  assert.equal(toolStarts[1].data.content_block.name, 'b');
});

test('33. empty stream emits message_start before message_delta/stop', async () => {
  const chunks = asyncFrom([]);
  const events = parseEvents(await collectSseEvents(translateAnthropicSseStream(chunks, 'msg_5', 'z-ai/glm-5.2')));
  assert.ok(events.some(e => e.eventType === 'message_start'), 'message_start must be emitted');
  assert.ok(events.some(e => e.eventType === 'message_stop'), 'message_stop must be emitted');
  const startIndex = events.findIndex(e => e.eventType === 'message_start');
  const stopIndex = events.findIndex(e => e.eventType === 'message_stop');
  assert.ok(startIndex < stopIndex, 'message_start must come before message_stop');
});

test('34. [DONE] as first chunk still emits message_start', async () => {
  const chunks = asyncFrom(['data: [DONE]\n\n']);
  const events = parseEvents(await collectSseEvents(translateAnthropicSseStream(chunks, 'msg_6', 'z-ai/glm-5.2')));
  assert.ok(events.some(e => e.eventType === 'message_start'), 'message_start must be emitted');
  assert.ok(events.some(e => e.eventType === 'message_stop'), 'message_stop must be emitted');
});

test('35. chunk with two data: lines processes both events', async () => {
  const chunks = asyncFrom([
    'data: {"choices":[{"delta":{"content":"A"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{"content":"B"},"finish_reason":null}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const events = parseEvents(await collectSseEvents(translateAnthropicSseStream(chunks, 'msg_7', 'z-ai/glm-5.2')));
  const textDeltas = events.filter(e => e.eventType === 'content_block_delta' && e.data?.delta?.type === 'text_delta');
  assert.equal(textDeltas.length, 2, 'both A and B text deltas must be emitted');
  assert.equal(textDeltas[0].data.delta.text, 'A');
  assert.equal(textDeltas[1].data.delta.text, 'B');
});

test('36. simple text stream: message_start → block_start → text_delta → block_stop → message_delta → message_stop', async () => {
  const chunks = asyncFrom([
    'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const events = parseEvents(await collectSseEvents(translateAnthropicSseStream(chunks, 'msg_8', 'z-ai/glm-5.2')));
  const types = events.map(e => e.eventType);
  const expected = ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'];
  // The exact sequence may include more events but should start with message_start and end with message_stop
  assert.equal(types[0], 'message_start');
  assert.equal(types[types.length - 1], 'message_stop');
  assert.ok(types.includes('content_block_start'));
  assert.ok(types.includes('content_block_delta'));
  assert.ok(types.includes('content_block_stop'));
  assert.ok(types.includes('message_delta'));
});

function textDeltasForChunks(chunks, options = {}) {
  return collectSseEvents(translateAnthropicSseStream(asyncFrom(chunks), 'msg_split', 'split/model', options))
    .then(parseEvents)
    .then((events) => events.filter((event) => event.eventType === 'content_block_delta' && event.data?.delta?.type === 'text_delta'));
}

test('36a. incremental SSE decoder preserves JSON split at an ASCII boundary', async () => {
  const deltas = await textDeltasForChunks([
    'data: {"choices":[{"delta":{"content":"hel',
    'lo"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'
  ]);
  assert.deepEqual(deltas.map((event) => event.data.delta.text), ['hello']);
});

test('36b. incremental SSE decoder preserves a split data prefix', async () => {
  const deltas = await textDeltasForChunks([
    'da',
    'ta: {"choices":[{"delta":{"content":"prefix"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'
  ]);
  assert.deepEqual(deltas.map((event) => event.data.delta.text), ['prefix']);
});

test('36c. incremental SSE decoder waits for a frame delimiter split across chunks', async () => {
  const deltas = await textDeltasForChunks([
    'data: {"choices":[{"delta":{"content":"delimiter"},"finish_reason":null}]}\n',
    '\ndata: [DONE]\n\n'
  ]);
  assert.deepEqual(deltas.map((event) => event.data.delta.text), ['delimiter']);
});

test('36d. incremental SSE decoder preserves [DONE] split across chunks', async () => {
  const events = parseEvents(await collectSseEvents(translateAnthropicSseStream(asyncFrom([
    'data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: [DO',
    'NE]\n\n'
  ]), 'msg_done_split', 'split/model', { errorOnIncomplete: true })));
  assert.equal(events.some((event) => event.eventType === 'error'), false);
  assert.equal(events.at(-1)?.eventType, 'message_stop');
});

test('36e. incremental SSE decoder emits complete frames and carries only the partial tail', async () => {
  const deltas = await textDeltasForChunks([
    'data: {"choices":[{"delta":{"content":"A"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"B"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"C',
    '"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'
  ]);
  assert.deepEqual(deltas.map((event) => event.data.delta.text), ['A', 'B', 'C']);
});

test('36f. incremental UTF-8 decoder preserves a multibyte code point split across byte chunks', async () => {
  const frame = Buffer.from('data: {"choices":[{"delta":{"content":"A🙂B"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', 'utf8');
  const emoji = Buffer.from('🙂', 'utf8');
  const emojiStart = frame.indexOf(emoji);
  assert.ok(emojiStart >= 0, 'fixture must contain the multibyte code point');
  const chunks = [
    new Uint8Array(frame.subarray(0, emojiStart + 1)),
    frame.subarray(emojiStart + 1, emojiStart + 3),
    new Uint8Array(frame.subarray(emojiStart + 3))
  ];
  const deltas = await textDeltasForChunks(chunks);
  assert.deepEqual(deltas.map((event) => event.data.delta.text), ['A🙂B']);
});

test('36g. EOF rejects an unterminated pre-byte frame so the route can fail over', async () => {
  const emitted = [];
  await assert.rejects(async () => {
    for await (const event of translateAnthropicSseStream(asyncFrom([
      'data: {"choices":[{"delta":{"content":"must-not-leak"},"finish_reason":null}]}'
    ]), 'msg_partial_eof', 'split/model', { errorOnIncomplete: true })) {
      emitted.push(event);
    }
  }, /ended before a complete event/i);
  assert.deepEqual(emitted, [], 'an incomplete pre-byte frame must not commit client-visible output');
});

test('36h. oversized partial frame is discarded through its delimiter without parsing a tail fragment', async () => {
  const emitted = [];
  const tailThatLooksLikeAFrame = 'data: {"choices":[{"delta":{"content":"must-not-leak"},"finish_reason":null}]}\n\n';
  await assert.rejects(async () => {
    for await (const event of translateAnthropicSseStream(asyncFrom([
      `:${'x'.repeat(64 * 1024 + 1)}`,
      tailThatLooksLikeAFrame,
      'data: [DONE]\n\n'
    ]), 'msg_oversized', 'split/model', { errorOnIncomplete: true })) {
      emitted.push(event);
    }
  }, /malformed upstream SSE event/i);
  assert.deepEqual(emitted, [], 'a tail inside an oversized frame must never be interpreted as a fresh event');
});

for (const [name, chunks] of [
  ['split data prefix', ['da', 'ta: {"error":{"message":"split prefix"}}\n\n']],
  ['split error JSON', ['data: {"err', 'or":{"message":"split json"}}\n\n']],
  ['split error followed by DONE', ['data: {"error":{"message":"before done"', '}}\n\ndata: [DONE]\n\n']]
]) {
  test(`36i. complete upstream error frame is typed before output: ${name}`, async () => {
    const emitted = [];
    await assert.rejects(async () => {
      for await (const event of translateAnthropicSseStream(asyncFrom(chunks), 'msg_error', 'split/model', { errorOnIncomplete: true })) {
        emitted.push(event);
      }
    }, (error) => {
      assert.equal(error.name, 'AnthropicUpstreamSseError');
      assert.equal(error.responseCommitted, false);
      return true;
    });
    assert.deepEqual(emitted, []);
  });
}

test('36j. complete upstream error frame preserves a multibyte message split inside one code point', async () => {
  const frame = Buffer.from('data: {"error":{"message":"ошибка 🙂"}}\r\n\r\n', 'utf8');
  const emojiOffset = frame.indexOf(Buffer.from('🙂'));
  const emitted = [];
  await assert.rejects(async () => {
    for await (const event of translateAnthropicSseStream(asyncFrom([
      new Uint8Array(frame.subarray(0, emojiOffset + 1)),
      frame.subarray(emojiOffset + 1)
    ]), 'msg_error_utf8', 'split/model', { errorOnIncomplete: true })) emitted.push(event);
  }, (error) => {
    assert.equal(error.name, 'AnthropicUpstreamSseError');
    assert.match(error.message, /ошибка 🙂/u);
    return true;
  });
  assert.deepEqual(emitted, []);
});

test('36k. upstream error after visible content emits exactly one error and one terminal stop', async () => {
  const events = parseEvents(await collectSseEvents(translateAnthropicSseStream(asyncFrom([
    'data: {"choices":[{"delta":{"content":"visible"},"finish_reason":null}]}\n\n',
    'data: {"error":{"message":"late failure"}}\n\ndata: [DONE]\n\n'
  ]), 'msg_late_error', 'split/model', { errorOnIncomplete: true })));
  assert.equal(events.filter((event) => event.eventType === 'error').length, 1);
  assert.equal(events.filter((event) => event.eventType === 'message_stop').length, 1);
  assert.equal(events.filter((event) => event.data?.delta?.text === 'visible').length, 1);
  assert.deepEqual(events.slice(-2).map((event) => event.eventType), ['error', 'message_stop']);
  assert.match(events.at(-2).data.error.message, /late failure/);
});

for (const [name, chunks] of [
  ['event, data field, and payload split independently', ['eve', 'nt: er', 'ror\nda', 'ta: {"ty', 'pe":"overloaded_error","mes', 'sage":"split top-level"}\n\ndata: [DO', 'NE]\n\n']],
  ['CRLF event frame split at every boundary', ['event:', ' error\r', '\ndata:', ' {"type":"api_error",', '"message":"split CRLF"}\r', '\n\r', '\ndata: [DONE]\r\n\r\n']]
]) {
  test(`36ka. named upstream error with a top-level payload is typed before output: ${name}`, async () => {
    const emitted = [];
    await assert.rejects(async () => {
      for await (const event of translateAnthropicSseStream(asyncFrom(chunks), 'msg_named_error', 'split/model', { errorOnIncomplete: true })) {
        emitted.push(event);
      }
    }, (error) => {
      assert.equal(error.name, 'AnthropicUpstreamSseError');
      assert.equal(error.responseCommitted, false);
      assert.match(error.message, /split (?:top-level|CRLF)/);
      return true;
    });
    assert.deepEqual(emitted, []);
  });
}

test('36kb. named upstream error with a top-level payload after visible content terminates exactly once', async () => {
  const events = parseEvents(await collectSseEvents(translateAnthropicSseStream(asyncFrom([
    'data: {"choices":[{"delta":{"content":"visible"},"finish_reason":null}]}\n\n',
    'eve', 'nt: error\nda', 'ta: {"type":"overloaded_error","message":"late named failure"}\n\ndata: [DONE]\n\n'
  ]), 'msg_late_named_error', 'split/model', { errorOnIncomplete: true })));
  assert.equal(events.filter((event) => event.eventType === 'error').length, 1);
  assert.equal(events.filter((event) => event.eventType === 'message_stop').length, 1);
  assert.equal(events.filter((event) => event.data?.delta?.text === 'visible').length, 1);
  assert.deepEqual(events.slice(-2).map((event) => event.eventType), ['error', 'message_stop']);
  assert.match(events.at(-2).data.error.message, /late named failure/);
});

for (const [name, original] of [
  ['emoji', 'A🙂B'],
  ['supplementary CJK and musical symbol', 'start𠮷-middle-𝄞-end'],
  ['multiple adjacent supplementary characters', '🙂🚀𐐷']
]) {
  test(`36kc. string chunks split between UTF-16 surrogate halves preserve ${name}`, async () => {
    const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: original }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
    const chunks = [];
    let cursor = 0;
    for (let index = 0; index < frame.length; index++) {
      const code = frame.charCodeAt(index);
      if (code >= 0xD800 && code <= 0xDBFF) {
        chunks.push(frame.slice(cursor, index + 1));
        cursor = index + 1;
      }
    }
    chunks.push(frame.slice(cursor));
    const deltas = await textDeltasForChunks(chunks, { errorOnIncomplete: true });
    assert.equal(deltas.map((event) => event.data.delta.text).join(''), original);
    assert.equal(deltas.some((event) => event.data.delta.text.includes('\uFFFD')), false);
  });
}

test('36l. SSE frame limit accepts exactly 65,536 ASCII payload bytes with a split LF delimiter', async () => {
  const frame = `:${'x'.repeat(65_535)}`;
  assert.equal(Buffer.byteLength(frame), 65_536);
  const events = parseEvents(await collectSseEvents(translateAnthropicSseStream(asyncFrom([
    frame + '\n',
    '\ndata: [DONE]\n\n'
  ]), 'msg_limit_ascii', 'split/model', { errorOnIncomplete: true })));
  assert.equal(events.some((event) => event.eventType === 'error'), false);
  assert.equal(events.at(-1)?.eventType, 'message_stop');
});

test('36m. SSE frame limit accepts exactly 65,536 multibyte UTF-8 payload bytes with a split CRLF delimiter', async () => {
  const frame = `:${'🙂'.repeat(16_383)}xxx`;
  assert.equal(Buffer.byteLength(frame), 65_536);
  const bytes = Buffer.from(frame + '\r\n\r\ndata: [DONE]\r\n\r\n');
  const delimiter = bytes.indexOf(Buffer.from('\r\n\r\n'));
  const events = parseEvents(await collectSseEvents(translateAnthropicSseStream(asyncFrom([
    new Uint8Array(bytes.subarray(0, delimiter + 3)),
    bytes.subarray(delimiter + 3)
  ]), 'msg_limit_utf8', 'split/model', { errorOnIncomplete: true })));
  assert.equal(events.some((event) => event.eventType === 'error'), false);
  assert.equal(events.at(-1)?.eventType, 'message_stop');
});

test('36n. SSE frame limit rejects 65,537 payload bytes and never reparses its tail', async () => {
  const below = `:${'🙂'.repeat(16_383)}xx\n\ndata: [DONE]\n\n`;
  const belowEvents = parseEvents(await collectSseEvents(translateAnthropicSseStream(asyncFrom([below]), 'msg_limit_below', 'split/model', { errorOnIncomplete: true })));
  assert.equal(Buffer.byteLength(below.slice(0, below.indexOf('\n\n'))), 65_535);
  assert.equal(belowEvents.some((event) => event.eventType === 'error'), false);

  const leakedTail = 'data: {"choices":[{"delta":{"content":"must-not-leak"},"finish_reason":null}]}\r\n\r\n';
  const above = `:${'🙂'.repeat(16_384)}`;
  assert.equal(Buffer.byteLength(above), 65_537);
  const emitted = [];
  await assert.rejects(async () => {
    for await (const event of translateAnthropicSseStream(asyncFrom([
      above,
      new Uint8Array(Buffer.from(leakedTail + 'data: [DONE]\r\n\r\n'))
    ]), 'msg_limit_above', 'split/model', { errorOnIncomplete: true })) emitted.push(event);
  }, /malformed upstream SSE event/i);
  assert.deepEqual(emitted, [], 'discard mode must consume the oversized frame through CRLF and never parse its tail');
});

// ---------------------------------------------------------------------------
// tool_choice translation (Anthropic -> OpenAI).
//
// Reported defect: "uses Hermes and the functions didn't work". Measured cause
// is NOT capability gating (capabilities never gate tool requests, and an
// unknown family already reports tools:true) but that `tool_choice` was parsed
// by nothing and silently dropped, so forced tool use was impossible for every
// model on the Anthropic facade. Mapping per Anthropic Messages API docs:
//   auto -> "auto" | any -> "required" | tool+name -> {type:function,...}
//   none -> "none" | disable_parallel_tool_use -> parallel_tool_calls:false
// ---------------------------------------------------------------------------

const HERMES_ID = 'nousresearch/hermes-4-405b';
const oneTool = [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];

test('37. tool_choice auto -> "auto"', () => {
  const r = translateAnthropicRequest({
    model: HERMES_ID, max_tokens: 100,
    messages: [{ role: 'user', content: 'weather?' }],
    tools: oneTool, tool_choice: { type: 'auto' },
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.tool_choice, 'auto');
});

test('38. tool_choice any -> "required" (forced tool use is preserved)', () => {
  const r = translateAnthropicRequest({
    model: HERMES_ID, max_tokens: 100,
    messages: [{ role: 'user', content: 'weather?' }],
    tools: oneTool, tool_choice: { type: 'any' },
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.tool_choice, 'required');
});

test('39. tool_choice tool+name -> {type:function,function:{name}}', () => {
  const r = translateAnthropicRequest({
    model: HERMES_ID, max_tokens: 100,
    messages: [{ role: 'user', content: 'weather?' }],
    tools: oneTool, tool_choice: { type: 'tool', name: 'get_weather' },
  });
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.openaiBody.tool_choice, { type: 'function', function: { name: 'get_weather' } });
});

test('40. tool_choice none -> "none"', () => {
  const r = translateAnthropicRequest({
    model: HERMES_ID, max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    tools: oneTool, tool_choice: { type: 'none' },
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.tool_choice, 'none');
});

test('41. disable_parallel_tool_use -> parallel_tool_calls:false', () => {
  const r = translateAnthropicRequest({
    model: HERMES_ID, max_tokens: 100,
    messages: [{ role: 'user', content: 'weather?' }],
    tools: oneTool, tool_choice: { type: 'any', disable_parallel_tool_use: true },
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.tool_choice, 'required');
  assert.equal(r.openaiBody.parallel_tool_calls, false);
});

test('42. tool_choice without tools is NOT forwarded (OpenAI rejects it)', () => {
  const r = translateAnthropicRequest({
    model: HERMES_ID, max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    tool_choice: { type: 'any' },
  });
  assert.equal(r.errors.length, 0);
  assert.ok(!('tool_choice' in r.openaiBody));
  assert.ok(r.warnings.some(w => w.includes('tool_choice')));
});

test('43. unrecognized tool_choice type is dropped with a warning, not forwarded', () => {
  const r = translateAnthropicRequest({
    model: HERMES_ID, max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    tools: oneTool, tool_choice: { type: 'wat' },
  });
  assert.equal(r.errors.length, 0);
  assert.ok(!('tool_choice' in r.openaiBody));
  assert.ok(r.warnings.some(w => w.includes('tool_choice')));
});

test('44. tool_choice tool without a name is dropped with a warning', () => {
  const r = translateAnthropicRequest({
    model: HERMES_ID, max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    tools: oneTool, tool_choice: { type: 'tool' },
  });
  assert.equal(r.errors.length, 0);
  assert.ok(!('tool_choice' in r.openaiBody));
  assert.ok(r.warnings.some(w => w.includes('tool_choice')));
});

test('45. Hermes (unknown family) still reports tools:true and translates tools', () => {
  const r = translateAnthropicRequest({
    model: HERMES_ID, max_tokens: 100,
    messages: [{ role: 'user', content: 'weather?' }],
    tools: oneTool,
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.tools[0].function.name, 'get_weather');
  assert.deepEqual(r.openaiBody.tools[0].function.parameters.required, ['city']);
});

test('46. non-object tool_choice (bare OpenAI-style string) is dropped with a warning', () => {
  const r = translateAnthropicRequest({
    model: HERMES_ID, max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    tools: oneTool, tool_choice: 'required',
  });
  assert.equal(r.errors.length, 0);
  assert.ok(!('tool_choice' in r.openaiBody));
  assert.ok(r.warnings.some(w => w.includes('tool_choice')));
});

test('47. absent tool_choice adds neither the field nor a warning', () => {
  const r = translateAnthropicRequest({
    model: HERMES_ID, max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    tools: oneTool,
  });
  assert.equal(r.errors.length, 0);
  assert.ok(!('tool_choice' in r.openaiBody));
  assert.ok(!('parallel_tool_calls' in r.openaiBody));
  assert.ok(!r.warnings.some(w => w.includes('tool_choice')));
});

// ---------------------------------------------------------------------------
// The static family table must INFORM, never VETO, a capability for a model it
// does not know. NVIDIA adds and changes models without our releases, so an
// unknown model id is the NORMAL case. Measured before the fix: a model whose
// family is absent from the registry was hard-rejected 400 locally with
// "This model does not support thinking" and NO upstream request was attempted,
// while the same model on /v1/chat/completions was forwarded verbatim and
// answered 200 — the two facades disagreed. A probed cache entry that already
// proved reasoning support was also ignored at this decision point.
// ---------------------------------------------------------------------------

const probeTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-anthropic-adapter-cache-${process.pid}-`));

test.after(() => {
  fs.rmSync(probeTempRoot, { recursive: true, force: true });
});

// Memory-only cache (cachePath: null) ⇒ no probed knowledge for any model.
function withoutProbedCache() {
  probe.resetCapabilityProbeState({ cachePath: null });
}

// Seed a persisted PROBED entry, then point the probe module at it.
function withProbedCache(modelId, entry) {
  const cacheFile = path.join(probeTempRoot, `cache-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 2,
    savedAt: new Date().toISOString(),
    entries: { [modelId]: { probedAt: Date.now(), source: 'probed', ...entry } },
  }));
  probe.resetCapabilityProbeState({ cachePath: cacheFile });
}

const thinkingBody = (model, thinking = { type: 'enabled', budget_tokens: 20000 }) => ({
  model, max_tokens: 100, messages: [{ role: 'user', content: 'Think hard' }], thinking,
});

test('48. unknown family + thinking enabled is NOT hard-rejected by the static table', () => {
  withoutProbedCache();
  const r = translateAnthropicRequest(thinkingBody(HERMES_ID));
  assert.deepEqual(r.errors, [], 'an unknown family must not be vetoed locally');
  assert.ok(r.openaiBody, 'the request must be translated, not nulled out');
  assert.equal(r.openaiBody.model, HERMES_ID);
});

test('49. unknown family + thinking enabled translates a reasoning control for upstream to judge', () => {
  withoutProbedCache();
  const r = translateAnthropicRequest(thinkingBody(HERMES_ID));
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.reasoning_effort, 'high', 'budget 20000 maps to high');
  assert.ok(
    r.warnings.some(w => /unknown|not in the .*registry|upstream/i.test(w)),
    `expected a diagnosable warning about the unknown family, got ${JSON.stringify(r.warnings)}`
  );
});

test('50. unknown family honours the budget_tokens → effort mapping (4000 → low)', () => {
  withoutProbedCache();
  const r = translateAnthropicRequest(thinkingBody(HERMES_ID, { type: 'enabled', budget_tokens: 4000 }));
  assert.equal(r.errors.length, 0);
  assert.equal(r.openaiBody.reasoning_effort, 'low');
});

test('51. a KNOWN genuinely-non-reasoning family is still rejected (that is knowledge we have)', () => {
  withoutProbedCache();
  const r = translateAnthropicRequest(thinkingBody('meta/llama-4-maverick-17b-128e-instruct'));
  assert.ok(r.errors.some(e => e.includes('does not support thinking')));
  assert.equal(r.openaiBody, null);
});

test('52. probed cache proving reasoning support WINS over the static default', () => {
  withProbedCache(HERMES_ID, {
    modes: ['low', 'medium', 'high'],
    controlKey: 'reasoning_effort',
    defaultMode: 'high',
    supported: true,
  });
  const r = translateAnthropicRequest(thinkingBody(HERMES_ID));
  assert.deepEqual(r.errors, []);
  assert.equal(r.openaiBody.reasoning_effort, 'high');
});

test('53. probed cache modes clamp the requested effort (max is not in the probed set)', () => {
  withProbedCache(HERMES_ID, {
    modes: ['low', 'medium'],
    controlKey: 'reasoning_effort',
    defaultMode: 'medium',
    supported: true,
  });
  const r = translateAnthropicRequest(thinkingBody(HERMES_ID, { type: 'enabled', budget_tokens: 90000 }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.openaiBody.reasoning_effort, 'medium', 'effort must clamp down into the probed modes');
});

test('54. probed cache WINS over a known family the static table calls non-reasoning', () => {
  withProbedCache('meta/llama-4-maverick-17b-128e-instruct', {
    modes: ['low', 'high'],
    controlKey: 'reasoning_effort',
    defaultMode: 'high',
    supported: true,
  });
  const r = translateAnthropicRequest(thinkingBody('meta/llama-4-maverick-17b-128e-instruct'));
  assert.deepEqual(r.errors, [], 'live probed evidence outranks the static guess');
  assert.equal(r.openaiBody.reasoning_effort, 'high');
});

test('55. a probed entry reporting NO reasoning_effort support introduces no new local veto', () => {
  // The probe only discovers `reasoning_effort`; a chat_template_kwargs-driven
  // model probes as unsupported. So a probed `supported:false` is not authority
  // over every reasoning style and must not start rejecting requests.
  withProbedCache(HERMES_ID, { modes: [], controlKey: null, supported: false });
  const r = translateAnthropicRequest(thinkingBody(HERMES_ID));
  assert.deepEqual(r.errors, []);
  assert.ok(r.openaiBody);
});

test('56. unknown family + thinking DISABLED stays a no-op (no reasoning fields invented)', () => {
  withoutProbedCache();
  const r = translateAnthropicRequest(thinkingBody(HERMES_ID, { type: 'disabled' }));
  assert.equal(r.errors.length, 0);
  assert.ok(!('reasoning_effort' in r.openaiBody));
  assert.ok(!('chat_template_kwargs' in r.openaiBody));
});

// The probe measures ONE thing: which `reasoning_effort` values a model accepts.
// It never writes alternateControl / enableValue / disableValue. So a probed entry
// must be merged ONTO static knowledge, never substituted for it — otherwise the
// arrival of a routine background probe silently strips a statically-known second
// control (z-ai/glm-4.5 needs chat_template_kwargs.enable_thinking as well as
// reasoning_effort) and `thinking:{type:'disabled'}` stops being honoured upstream.
test('58. a probed entry must not erase a statically-known alternate reasoning control', () => {
  const ZAI = 'z-ai/glm-4.5';
  const realisticProbeOutput = {
    modes: ['none', 'low', 'medium', 'high'],
    controlKey: 'reasoning_effort',
    supported: true,
  };

  withProbedCache(ZAI, realisticProbeOutput);
  const enabled = translateAnthropicRequest(thinkingBody(ZAI));
  assert.deepEqual(enabled.errors, []);
  assert.equal(enabled.openaiBody.reasoning_effort, 'high');
  assert.equal(enabled.openaiBody.chat_template_kwargs?.enable_thinking, true,
    'the statically-known alternate control must survive a probed entry');

  withProbedCache(ZAI, realisticProbeOutput);
  const disabled = translateAnthropicRequest(thinkingBody(ZAI, { type: 'disabled' }));
  assert.deepEqual(disabled.errors, []);
  assert.equal(disabled.openaiBody.reasoning_effort, 'none');
  assert.equal(disabled.openaiBody.chat_template_kwargs?.enable_thinking, false,
    'thinking:disabled must still switch the alternate control off');
});

// `source:'fallback'` is a STATIC GUESS that happens to live in the cache file;
// only `source:'probed'` comes from a real live run. Treating a guess as evidence
// lets it outrank the family table it was guessed from.
test('59. a cached entry with source "fallback" is not probed evidence', () => {
  withProbedCache('meta/llama-4-maverick-17b-128e-instruct', {
    modes: ['low', 'high'],
    controlKey: 'reasoning_effort',
    supported: true,
    source: 'fallback',
  });
  const r = translateAnthropicRequest(thinkingBody('meta/llama-4-maverick-17b-128e-instruct'));
  assert.ok(r.errors.some(e => e.includes('does not support thinking')),
    'a static guess wearing a cache entry\'s clothes must not unlock thinking');
  assert.equal(r.openaiBody, null);
});

// capability-probe.mjs writes `{ modes: [], supported: true, controlKey: null }`
// for a model that emits reasoning_content while REJECTING every reasoning_effort
// candidate. Sending reasoning_effort to such a model is sending the exact value
// the probe measured as rejected.
test('60. a probed implicit reasoner (supported, no control key) gets no reasoning_effort', () => {
  withProbedCache(HERMES_ID, { modes: [], controlKey: null, supported: true });
  const r = translateAnthropicRequest(thinkingBody(HERMES_ID));
  assert.deepEqual(r.errors, []);
  assert.ok(r.openaiBody);
  assert.ok(!('reasoning_effort' in r.openaiBody),
    'the probe measured every reasoning_effort value as rejected; do not send one');
  assert.ok(!('chat_template_kwargs' in r.openaiBody), 'no control may be invented either');
});

// An incomplete entry (modes present, controlKey absent) is repaired to the
// probe's own default rather than silently dropping the reasoning request.
test('61. a probed entry with modes but no controlKey still drives reasoning_effort', () => {
  withProbedCache(HERMES_ID, { modes: ['low', 'high'], supported: true });
  const r = translateAnthropicRequest(thinkingBody(HERMES_ID));
  assert.deepEqual(r.errors, []);
  assert.equal(r.openaiBody.reasoning_effort, 'high');
});

// The probe measures ONE thing: which `reasoning_effort` VALUES upstream accepts.
// Acceptance of that FIELD is not evidence that it is the model's effective switch:
// NVIDIA accepts reasoning_effort on models whose real control is a
// chat_template_kwargs flag, so every candidate comes back "accepted" and the probe
// writes controlKey:'reasoning_effort'. qwen / stepfun-ai / minimaxai keep their real
// switch in the PRIMARY controlKey, so letting a probed entry overwrite it strips the
// only control that actually works — the same defect class as z-ai's alternateControl,
// which merely survived because the probe never writes that field.
for (const [family, model, field, offValue, onValue] of [
  ['qwen', 'qwen/qwen3-next-80b-a3b-thinking', 'enable_thinking', false, true],
  ['stepfun-ai', 'stepfun-ai/step-3', 'thinking', false, true],
  ['minimaxai', 'minimaxai/minimax-m2', 'thinking_mode', 'disabled', 'enabled'],
]) {
  test(`62. [${family}] a probed reasoning_effort entry must not displace the statically-known chat_template_kwargs control`, () => {
    // Exactly what capability-probe writes when upstream accepts the field unvalidated.
    const probedAllAccepted = {
      modes: ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      controlKey: 'reasoning_effort',
      supported: true,
      defaultMode: 'high',
    };

    withProbedCache(model, probedAllAccepted);
    const disabled = translateAnthropicRequest(thinkingBody(model, { type: 'disabled' }));
    assert.deepEqual(disabled.errors, []);
    assert.equal(disabled.openaiBody.chat_template_kwargs?.[field], offValue,
      'thinking:disabled must still switch off the control the family actually uses');

    withProbedCache(model, probedAllAccepted);
    const enabled = translateAnthropicRequest(thinkingBody(model));
    assert.deepEqual(enabled.errors, []);
    assert.equal(enabled.openaiBody.chat_template_kwargs?.[field], onValue,
      'thinking:enabled must still switch on the control the family actually uses');
  });
}

// D3's shape (`{modes:[], controlKey:null, supported:true}`) means "reasoning happens
// but reasoning_effort is rejected". On a family with a statically-known alternate
// control that must NOT turn thinking:disabled into a silent no-op: the alternate
// control is the only remaining way to switch reasoning off.
test('63. a probed implicit reasoner still honours thinking:disabled through the static alternate control', () => {
  withProbedCache('z-ai/glm-4.5', { modes: [], controlKey: null, supported: true });
  const r = translateAnthropicRequest(thinkingBody('z-ai/glm-4.5', { type: 'disabled' }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.openaiBody.chat_template_kwargs?.enable_thinking, false,
    'thinking:disabled must reach upstream even when the probe found no usable reasoning_effort');
  assert.ok(!('reasoning_effort' in r.openaiBody),
    'the probe measured every reasoning_effort value as rejected; do not send one');
});

test('57. unknown family + thinking enabled keeps the tool_choice translation working', () => {
  withoutProbedCache();
  const r = translateAnthropicRequest({
    ...thinkingBody(HERMES_ID),
    tools: oneTool,
    tool_choice: { type: 'any', disable_parallel_tool_use: true },
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.openaiBody.tool_choice, 'required');
  assert.equal(r.openaiBody.parallel_tool_calls, false);
  assert.equal(r.openaiBody.tools[0].function.name, 'get_weather');
  assert.equal(r.openaiBody.reasoning_effort, 'high');
});
