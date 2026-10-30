// OpenAI Responses API facade (POST /v1/responses) <-> OpenAI Chat Completions
// (the only format the gateway sends upstream). Mirrors anthropic-adapter.mjs:
// request translation, buffered response translation, and an SSE translator
// that defers every client byte until the first MEANINGFUL upstream item so the
// failover loop keeps its pre-commit window.
//
// References:
//   - https://platform.openai.com/docs/api-reference/responses (create request,
//     response object, streaming events incl. sequence_number)
//   - https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/common.rs
//     (ResponsesApiRequest: the fields Codex CLI sends)
//   - https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs
//     (the stream events Codex CLI reads: response.created, output_item.added/done,
//     output_text.delta, response.completed / incomplete / failed)

import crypto from 'node:crypto';
import { isOpenAiSseItemMeaningful, sanitizeUpstreamErrorMessage } from './anthropic-adapter.mjs';
import { mapClientEffort } from './reasoning-defaults.mjs';

// Accepted and deliberately IGNORED: no Chat Completions equivalent, or a
// stateful/hosted feature this stateless gateway cannot honor. Codex sends
// store, reasoning, include, prompt_cache_key, text, service_tier,
// client_metadata, access_programs and stream_options (common.rs).
const IGNORED_FIELDS = new Set([
  'store', 'reasoning', 'include', 'prompt_cache_key', 'prompt_cache_retention',
  'text', 'service_tier', 'client_metadata', 'access_programs', 'stream_options',
  'metadata', 'truncation', 'user', 'safety_identifier', 'background',
  'top_logprobs', 'max_tool_calls', 'context_management', 'prompt'
]);
const HANDLED_FIELDS = new Set([
  'model', 'instructions', 'input', 'tools', 'tool_choice', 'temperature', 'top_p',
  'stream', 'parallel_tool_calls', 'max_output_tokens'
]);
// Stateful continuation: the gateway keeps no response store.
const STATEFUL_FIELDS = ['previous_response_id', 'conversation'];

const MESSAGE_ROLE_MAP = { user: 'user', assistant: 'assistant', system: 'system', developer: 'system' };
const MAX_LOGGED_TYPE_CHARS = 64;
const MAX_FRAME_CHARS = 64 * 1024;

const typeLabel = (value) => String(value).slice(0, MAX_LOGGED_TYPE_CHARS);
const nonNegativeInt = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

export function newResponseId() {
  return 'resp_' + crypto.randomUUID().replace(/-/g, '');
}

function newItemId(prefix) {
  return prefix + '_' + crypto.randomUUID().replace(/-/g, '');
}

function contentToChat(content, role, where, warnings, errors) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    errors.push(`${where}.content must be a string or an array`);
    return null;
  }
  const parts = [];
  let hasImage = false;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if ((part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
      parts.push({ type: 'text', text: part.refusal });
    } else if (part.type === 'input_image' && role === 'user' && typeof part.image_url === 'string') {
      hasImage = true;
      parts.push({ type: 'image_url', image_url: { url: part.image_url } });
    } else {
      warnings.push(`${where}: dropped unsupported content part ${typeLabel(part.type)}`);
    }
  }
  // Text-only content becomes a plain string (the most widely accepted chat form).
  return hasImage ? parts : parts.map((part) => part.text).join('\n');
}

function functionOutputToText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .filter((part) => part && typeof part === 'object' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  if (output === undefined || output === null) return '';
  return JSON.stringify(output);
}

// Consecutive calls (and a preceding assistant text) form ONE assistant turn.
function pushAssistantToolCall(messages, toolCall) {
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant') {
    (last.tool_calls ??= []).push(toolCall);
    if (last.content === '') last.content = null;
  } else {
    messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
  }
}

// Freeform (`custom`) tools travel upstream as a function with ONE string
// parameter; this is the schema both directions agree on.
const CUSTOM_TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  properties: { input: { type: 'string', description: 'raw tool input' } },
  required: ['input'],
  additionalProperties: false
});
const MAX_FORMAT_NOTE_CHARS = 4000;

function customToolDescription(tool) {
  const base = typeof tool.description === 'string' ? tool.description : '';
  const format = tool.format && typeof tool.format === 'object' ? tool.format : null;
  if (!format) return base;
  const kind = [format.type, format.syntax].filter((value) => typeof value === 'string' && value).join('/') || 'text';
  let note = `Put the raw tool input (not JSON-wrapped) in the \`input\` string. Input format: ${kind}.`;
  if (typeof format.definition === 'string' && format.definition.length > 0) {
    const definition = format.definition.length > MAX_FORMAT_NOTE_CHARS
      ? format.definition.slice(0, MAX_FORMAT_NOTE_CHARS) + '\n...(truncated)'
      : format.definition;
    note += `\nDefinition:\n${definition}`;
  }
  return base ? `${base}\n\n${note}` : note;
}

// `input` of a custom tool call from the upstream function arguments; invalid
// JSON or a missing `input` string falls back to the raw arguments text.
export function extractCustomToolInput(args) {
  const raw = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.input === 'string') return parsed.input;
  } catch {
    // fall through to the raw text
  }
  return raw;
}

function translateInputItem(item, index, messages, warnings, errors) {
  const where = `input[${index}]`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    errors.push(`${where} must be an object`);
    return;
  }
  // EasyInputMessage may omit `type`.
  const type = item.type ?? (item.role !== undefined ? 'message' : undefined);
  if (type === 'message') {
    const role = MESSAGE_ROLE_MAP[item.role];
    if (!role) {
      errors.push(`${where}.role must be one of user, assistant, system, developer`);
      return;
    }
    const content = contentToChat(item.content, role, where, warnings, errors);
    if (content !== null) messages.push({ role, content });
    return;
  }
  if (type === 'function_call') {
    if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name) {
      errors.push(`${where}: function_call requires call_id and name`);
      return;
    }
    pushAssistantToolCall(messages, {
      id: item.call_id,
      type: 'function',
      function: {
        name: item.name,
        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
      }
    });
    return;
  }
  if (type === 'custom_tool_call') {
    if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name) {
      errors.push(`${where}: custom_tool_call requires call_id and name`);
      return;
    }
    // Same wire shape the upstream saw when the call was made (CUSTOM_TOOL_PARAMETERS).
    pushAssistantToolCall(messages, {
      id: item.call_id,
      type: 'function',
      function: { name: item.name, arguments: JSON.stringify({ input: typeof item.input === 'string' ? item.input : '' }) }
    });
    return;
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    if (typeof item.call_id !== 'string' || !item.call_id) {
      errors.push(`${where}: ${type} requires call_id`);
      return;
    }
    messages.push({ role: 'tool', tool_call_id: item.call_id, content: functionOutputToText(item.output) });
    return;
  }
  // reasoning, web_search_call, ... have no chat equivalent.
  warnings.push(`${where}: dropped unsupported input item ${typeLabel(type)}`);
}

// Returns { chatBody, warnings, errors, ignored, unsupportedParam }.
export function translateResponsesRequest(body) {
  const warnings = [];
  const errors = [];
  const ignored = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { chatBody: null, warnings, errors: ['request body must be a JSON object'], ignored };
  }
  for (const field of STATEFUL_FIELDS) {
    if (body[field] !== undefined && body[field] !== null) {
      return {
        chatBody: null,
        warnings,
        errors: [`${field} is not supported: this gateway is stateless and stores no responses; resend the full conversation in \`input\``],
        ignored,
        unsupportedParam: field
      };
    }
  }
  if (typeof body.model !== 'string' || body.model.length === 0) errors.push('model is required');

  const messages = [];
  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    messages.push({ role: 'system', content: body.instructions });
  }
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    body.input.forEach((item, index) => translateInputItem(item, index, messages, warnings, errors));
  } else if (body.input !== undefined && body.input !== null) {
    errors.push('input must be a string or an array of items');
  }
  if (errors.length === 0 && !messages.some((message) => message.role !== 'system')) {
    errors.push('input is required');
  }

  const chatBody = { model: body.model, messages };
  for (const field of ['temperature', 'top_p', 'stream']) {
    if (body[field] !== undefined && body[field] !== null) chatBody[field] = body[field];
  }
  if (Number.isInteger(body.max_output_tokens) && body.max_output_tokens > 0) {
    chatBody.max_tokens = body.max_output_tokens;
  }
  // Streamed Chat Completions carry usage only on request; response.completed
  // and the key's token accounting both need it. (The client's own
  // Responses-API `stream_options` is a different object and stays ignored.)
  if (chatBody.stream === true) chatBody.stream_options = { include_usage: true };
  const customToolNames = new Set();

  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) {
      errors.push('tools must be an array');
    } else {
      const tools = [];
      // Names forwarded upstream (function + custom). Upstream sees one flat
      // function namespace, so a repeated name would make the reply ambiguous
      // (a function reply could be mislabeled custom_tool_call). Dropped hosted
      // tools never reach upstream and are not counted.
      const toolNames = new Set();
      for (const tool of body.tools) {
        if (tool && (tool.type === 'function' || tool.type === 'custom') && typeof tool.name === 'string' && tool.name) {
          if (toolNames.has(tool.name)) {
            return {
              chatBody: null,
              warnings,
              errors: [`duplicate tool name '${typeLabel(tool.name)}': tool names must be unique across function and custom tools`],
              ignored,
              unsupportedParam: 'tools',
              customToolNames: []
            };
          }
          toolNames.add(tool.name);
        }
        if (tool && tool.type === 'function' && typeof tool.name === 'string' && tool.name) {
          const fn = { name: tool.name };
          if (typeof tool.description === 'string') fn.description = tool.description;
          fn.parameters = tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} };
          tools.push({ type: 'function', function: fn });
        } else if (tool && tool.type === 'custom' && typeof tool.name === 'string' && tool.name) {
          // Freeform tool (Codex `apply_patch` is freeform-only): a function with
          // one `input` string; replies are mapped back to custom_tool_call.
          customToolNames.add(tool.name);
          tools.push({
            type: 'function',
            function: { name: tool.name, description: customToolDescription(tool), parameters: structuredClone(CUSTOM_TOOL_PARAMETERS) }
          });
        } else {
          // Hosted tool types (web_search, namespace, tool_search, ...) cannot
          // run upstream; dropping them keeps the other tools usable.
          warnings.push(`dropped non-function tool ${typeLabel(tool?.type)}`);
        }
      }
      if (tools.length > 0) chatBody.tools = tools;
    }
  }
  // Tool controls only make sense (and are only accepted upstream) with tools.
  if (chatBody.tools) {
    const choice = body.tool_choice;
    if (typeof choice === 'string') {
      chatBody.tool_choice = choice;
    } else if (choice && typeof choice === 'object' && (choice.type === 'function' || choice.type === 'custom') && typeof choice.name === 'string') {
      chatBody.tool_choice = { type: 'function', function: { name: choice.name } };
    } else if (choice !== undefined && choice !== null) {
      warnings.push(`dropped unsupported tool_choice ${typeLabel(choice?.type)}`);
    }
    if (typeof body.parallel_tool_calls === 'boolean') chatBody.parallel_tool_calls = body.parallel_tool_calls;
  }

  // `reasoning` stays an ignored field for every model except GLM-5.3 and Kimi K3,
  // whose effort (default max upstream = minutes of thinking) Codex must be able to set.
  const mappedEffort = mapClientEffort(chatBody.model, body.reasoning?.effort);
  if (mappedEffort) chatBody.reasoning_effort = mappedEffort;

  for (const key of Object.keys(body)) {
    if (HANDLED_FIELDS.has(key)) continue;
    if (key === 'reasoning' && mappedEffort && body.reasoning && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning)) {
      // effort was handled. Report only unsupported subfield NAMES, never their
      // values (which may contain prompt-derived or encrypted content).
      for (const subfield of Object.keys(body.reasoning)) {
        if (subfield !== 'effort') ignored.push(`reasoning.${typeLabel(subfield)}`);
      }
    } else if (IGNORED_FIELDS.has(key)) ignored.push(key);
    else warnings.push(`ignored unknown field ${typeLabel(key)}`);
  }

  if (errors.length > 0) return { chatBody: null, warnings, errors, ignored, customToolNames: [] };
  return { chatBody, warnings, errors, ignored, customToolNames: [...customToolNames] };
}

function isCustomTool(meta, name) {
  return Array.isArray(meta.customToolNames) && typeof name === 'string' && meta.customToolNames.includes(name);
}

function mapUsage(usage) {
  const inputTokens = nonNegativeInt(usage?.prompt_tokens);
  const outputTokens = nonNegativeInt(usage?.completion_tokens);
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: nonNegativeInt(usage?.prompt_tokens_details?.cached_tokens) },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: nonNegativeInt(usage?.completion_tokens_details?.reasoning_tokens) },
    total_tokens: nonNegativeInt(usage?.total_tokens) || inputTokens + outputTokens
  };
}

function baseResponse(meta, status) {
  return {
    id: meta.id || newResponseId(),
    object: 'response',
    created_at: Number.isInteger(meta.createdAt) ? meta.createdAt : Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: null,
    model: meta.model || '',
    output: [],
    usage: null
  };
}

function applyFinishReason(response, finishReason) {
  if (finishReason === 'length') {
    response.status = 'incomplete';
    response.incomplete_details = { reason: 'max_output_tokens' };
  } else {
    response.status = 'completed';
  }
}

// Buffered: a validated Chat Completions object -> Responses `response` object.
export function translateChatCompletionToResponse(completion, meta = {}) {
  const choice = completion.choices[0];
  const message = choice.message || {};
  const response = baseResponse({ ...meta, model: meta.model || completion.model }, 'completed');
  if (typeof message.content === 'string' && message.content.length > 0) {
    response.output.push({
      id: newItemId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content, annotations: [] }]
    });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      const args = toolCall?.function?.arguments;
      if (isCustomTool(meta, toolCall?.function?.name)) {
        response.output.push({
          type: 'custom_tool_call',
          id: newItemId('ctc'),
          call_id: toolCall?.id || newItemId('call'),
          name: toolCall.function.name,
          input: extractCustomToolInput(args),
          status: 'completed'
        });
        continue;
      }
      response.output.push({
        id: newItemId('fc'),
        type: 'function_call',
        status: 'completed',
        call_id: toolCall?.id || newItemId('call'),
        name: toolCall?.function?.name || '',
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {})
      });
    }
  }
  applyFinishReason(response, choice.finish_reason);
  response.usage = mapUsage(completion.usage);
  return response;
}

export class ResponsesUpstreamSseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResponsesUpstreamSseError';
  }
}

function parseSseFrame(frame) {
  const dataLines = [];
  let eventType = '';
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    if (line.startsWith('event:')) eventType = line.slice(6).replace(/^ /, '').trim();
    else if (line === 'data') dataLines.push('');
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return { kind: 'ignore' };
  const payload = dataLines.join('\n').trim();
  if (payload === '') return { kind: 'ignore' };
  if (payload === '[DONE]') return { kind: 'item', eventType, value: '[DONE]' };
  try {
    return { kind: 'item', eventType, value: JSON.parse(payload) };
  } catch {
    return { kind: 'malformed' };
  }
}

function upstreamErrorMessage(item, eventType) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (!('error' in item) && eventType.toLowerCase() !== 'error') return null;
  const details = item.error && typeof item.error === 'object' ? item.error : item;
  // Same bound + credential/URL-token scrub as the Anthropic facade: this text
  // is third-party output echoed to the client (response.error.message), so an
  // unbounded copy would flood the payload and leak whatever upstream quoted.
  return sanitizeUpstreamErrorMessage(details.message);
}

// Upstream Chat Completions SSE -> Responses SSE (`event:` equals the JSON `type`).
// Nothing is yielded before the first meaningful upstream item; an upstream
// error before that point THROWS so the caller can fail over. options:
//   errorOnIncomplete: EOF without [DONE] ends with response.failed;
//   incompleteTail (out): set when the failure is the synthetic tail.
export async function* translateResponsesSseStream(chunks, meta = {}, options = {}) {
  const decoder = new TextDecoder('utf-8');
  const response = baseResponse(meta, 'in_progress');
  let carry = '';
  let discardingOversized = false;
  let malformed = false;
  let started = false;
  let sequence = 0;
  let usage = null;
  let finishReason = null;
  let textItem = null;           // { item, outputIndex, text }
  const toolItems = new Map();   // upstream tool_call index -> { item, outputIndex }

  const event = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`;
  const snapshot = () => structuredClone(response);

  function* start() {
    started = true;
    yield event('response.created', { response: snapshot() });
    yield event('response.in_progress', { response: snapshot() });
  }

  function* closeText() {
    if (!textItem) return;
    const { item, outputIndex, text } = textItem;
    textItem = null;
    const part = { type: 'output_text', text, annotations: [] };
    yield event('response.output_text.done', { item_id: item.id, output_index: outputIndex, content_index: 0, text, logprobs: [] });
    yield event('response.content_part.done', { item_id: item.id, output_index: outputIndex, content_index: 0, part });
    item.status = 'completed';
    item.content = [part];
    yield event('response.output_item.done', { output_index: outputIndex, item: structuredClone(item) });
  }

  function* textDelta(delta) {
    if (!textItem) {
      const item = { id: newItemId('msg'), type: 'message', status: 'in_progress', role: 'assistant', content: [] };
      const outputIndex = response.output.push(item) - 1;
      textItem = { item, outputIndex, text: '' };
      yield event('response.output_item.added', { output_index: outputIndex, item: structuredClone(item) });
      yield event('response.content_part.added', {
        item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] }
      });
    }
    textItem.text += delta;
    yield event('response.output_text.delta', { item_id: textItem.item.id, output_index: textItem.outputIndex, content_index: 0, delta, logprobs: [] });
  }

  function* toolDelta(toolCall) {
    const index = typeof toolCall.index === 'number' ? toolCall.index : 0;
    let entry = toolItems.get(index);
    if (!entry) {
      yield* closeText();
      const name = toolCall.function?.name || '';
      const callId = toolCall.id || newItemId('call');
      // Custom (freeform) tool: arguments are buffered, because `input` can only
      // be extracted from the complete JSON; no argument deltas are streamed.
      const custom = isCustomTool(meta, name);
      const item = custom
        ? { type: 'custom_tool_call', id: newItemId('ctc'), call_id: callId, name, input: '', status: 'in_progress' }
        : { id: newItemId('fc'), type: 'function_call', status: 'in_progress', call_id: callId, name, arguments: '' };
      entry = { item, custom, args: '', outputIndex: response.output.push(item) - 1 };
      toolItems.set(index, entry);
      yield event('response.output_item.added', { output_index: entry.outputIndex, item: structuredClone(item) });
    } else if (!entry.item.name && toolCall.function?.name) {
      entry.item.name = toolCall.function.name;
    }
    const args = toolCall.function?.arguments;
    if (typeof args === 'string' && args.length > 0) {
      entry.args += args;
      if (!entry.custom) {
        entry.item.arguments = entry.args;
        yield event('response.function_call_arguments.delta', { item_id: entry.item.id, output_index: entry.outputIndex, delta: args });
      }
    }
  }

  function* finish() {
    yield* closeText();
    const openTools = [...toolItems.values()].sort((a, b) => a.outputIndex - b.outputIndex);
    for (const { item, custom, args, outputIndex } of openTools) {
      if (custom) {
        // Event names/fields: Responses API ResponseCustomToolCallInputDeltaEvent /
        // ResponseCustomToolCallInputDoneEvent; Codex reads the delta and the
        // final item from response.output_item.done (codex-api/src/sse/responses.rs).
        item.input = extractCustomToolInput(args);
        if (item.input.length > 0) {
          yield event('response.custom_tool_call_input.delta', { item_id: item.id, output_index: outputIndex, delta: item.input });
        }
        yield event('response.custom_tool_call_input.done', { item_id: item.id, output_index: outputIndex, input: item.input });
      } else {
        yield event('response.function_call_arguments.done', { item_id: item.id, output_index: outputIndex, name: item.name, arguments: args });
      }
      item.status = 'completed';
      yield event('response.output_item.done', { output_index: outputIndex, item: structuredClone(item) });
    }
    toolItems.clear();
    response.usage = mapUsage(usage);
    // Out-param for the server's key accounting (same metric as buffered chat).
    options.totalTokens = response.usage.total_tokens;
    applyFinishReason(response, finishReason);
    yield event(response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response: snapshot() });
  }

  function* fail(message) {
    response.status = 'failed';
    response.error = { code: 'server_error', message };
    yield event('response.failed', { response: snapshot() });
  }

  const collectFrames = (text, items) => {
    let buffer = carry + text;
    // A trailing CR may be the first half of a CRLF split across chunks.
    let heldCr = '';
    if (buffer.endsWith('\r')) { heldCr = '\r'; buffer = buffer.slice(0, -1); }
    const frames = buffer.replace(/\r\n?/g, '\n').split('\n\n');
    carry = frames.pop() + heldCr;
    for (const frame of frames) {
      if (discardingOversized) { discardingOversized = false; malformed = true; continue; }
      if (frame.length > MAX_FRAME_CHARS) { malformed = true; continue; }
      const parsed = parseSseFrame(frame);
      if (parsed.kind === 'item') items.push(parsed);
      else if (parsed.kind === 'malformed') malformed = true;
    }
    if (carry.length > MAX_FRAME_CHARS) { carry = ''; discardingOversized = true; }
  };

  for await (const chunk of chunks) {
    const items = [];
    if (typeof chunk === 'string') collectFrames(chunk, items);
    else if (chunk instanceof Uint8Array) collectFrames(decoder.decode(chunk, { stream: true }), items);
    for (const { eventType, value } of items) {
      if (value === '[DONE]') {
        if (malformed) {
          if (!started) throw new Error('Malformed upstream SSE event before completion');
          options.incompleteTail = true;
          yield* fail('Malformed upstream SSE event');
          return;
        }
        if (!started) yield* start();
        yield* finish();
        return;
      }
      const errorMessage = upstreamErrorMessage(value, eventType);
      if (errorMessage !== null) {
        if (!started) throw new ResponsesUpstreamSseError(errorMessage);
        yield* fail(errorMessage);
        return;
      }
      if (!value || typeof value !== 'object') continue;
      if (value.usage) usage = value.usage;
      if (!started) {
        // Benign frames (empty delta, usage-only) never commit the stream.
        if (!isOpenAiSseItemMeaningful(value)) continue;
        yield* start();
      }
      const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
      if (!choice || typeof choice !== 'object') continue;
      const delta = choice.delta;
      if (delta && typeof delta === 'object') {
        if (typeof delta.content === 'string' && delta.content.length > 0) yield* textDelta(delta.content);
        if (Array.isArray(delta.tool_calls)) {
          for (const toolCall of delta.tool_calls) {
            if (toolCall && typeof toolCall === 'object') yield* toolDelta(toolCall);
          }
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  carry += decoder.decode();
  let eofDone = false;
  const pending = carry.replace(/^[\r\n]+|[\r\n]+$/g, '');
  if (!discardingOversized && !malformed && /^data: ?\[DONE\]$/.test(pending)) eofDone = true;
  else if (discardingOversized || pending.length > 0) malformed = true;

  if (malformed && !started) throw new Error('Upstream SSE stream ended before a complete event');
  if (!started) yield* start();
  if (!eofDone && (options.errorOnIncomplete === true || malformed)) {
    options.incompleteTail = true;
    yield* fail('Upstream stream ended before completion');
    return;
  }
  yield* finish();
}
