import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateAnthropicRequest, translateAnthropicResponse, translateAnthropicSseStream } from '../src/gateway/anthropic-adapter.mjs';

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
  assert.equal(r.content.length, 2);
  assert.equal(r.content[0].type, 'text');
  assert.equal(r.content[1].type, 'thinking');
  assert.equal(r.content[1].thinking, 'Let me think...');
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
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"London\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const events = parseEvents(await collectSseEvents(translateAnthropicSseStream(chunks, 'msg_3', 'z-ai/glm-5.2')));
  const toolStarts = events.filter(e => e.eventType === 'content_block_start' && e.data?.content_block?.type === 'tool_use');
  assert.equal(toolStarts.length, 1, 'exactly one tool_use content_block_start');
  assert.equal(toolStarts[0].data.content_block.name, 'weather');
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
