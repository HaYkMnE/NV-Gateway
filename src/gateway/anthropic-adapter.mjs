// Anthropic Messages API → OpenAI Chat Completions request translator.
// Pure logic: no network, no I/O, no side effects.

import { getReasoningCapability } from "./capability-registry.mjs";

export function translateAnthropicRequest(body) {
  const errors = [];
  const warnings = [];
  const openaiBody = {};

  if (!body || typeof body !== 'object') {
    errors.push('request body is required');
    return { openaiBody: null, warnings, errors };
  }

  if (!body.model || typeof body.model !== 'string') {
    errors.push('model is required');
    return { openaiBody: null, warnings, errors };
  }
  openaiBody.model = body.model;

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    errors.push('messages is required and must be a non-empty array');
    return { openaiBody: null, warnings, errors };
  }

  const messages = [];

  // System prompt translation
  if (body.system !== undefined && body.system !== null) {
    let systemContent = '';
    if (typeof body.system === 'string') {
      systemContent = body.system;
    } else if (Array.isArray(body.system)) {
      systemContent = body.system
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('\n');
    }
    if (systemContent) {
      messages.push({ role: 'system', content: systemContent });
    }
  }

  // Messages translation
  for (const msg of body.messages) {
    if (!msg || typeof msg !== 'object' || !msg.role) {
      warnings.push('skipped malformed message (missing role)');
      continue;
    }

    if (msg.role !== 'user' && msg.role !== 'assistant') {
      warnings.push(`unsupported message role: ${msg.role}, skipping`);
      continue;
    }

    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      messages.push({ role: msg.role, content: String(msg.content ?? '') });
      continue;
    }

    // Content is an array of blocks
    let textParts = [];
    let toolCalls = [];
    let toolResultMessages = [];
    let hasUnsupported = false;

    for (const block of msg.content) {
      if (!block || typeof block !== 'object' || !block.type) {
        warnings.push('skipped malformed content block (missing type)');
        continue;
      }

      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (block.type === 'text') {
        warnings.push('malformed text block (missing or non-string text)');
      } else if (block.type === 'tool_use') {
        if (!block.id || !block.name || block.input === undefined) {
          warnings.push('skipped malformed tool_use block (missing id/name/input)');
          continue;
        }
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      } else if (block.type === 'tool_result') {
        if (!block.tool_use_id) {
          errors.push('malformed tool_result block (missing tool_use_id)');
          continue;
        }
        let resultContent = '';
        if (typeof block.content === 'string') {
          resultContent = block.content;
        } else if (Array.isArray(block.content)) {
          resultContent = block.content
            .filter(b => b && b.type === 'text' && typeof b.text === 'string')
            .map(b => b.text)
            .join('\n');
        }
        toolResultMessages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: resultContent,
        });
      } else if (block.type === 'image') {
        errors.push('Image input is not yet supported through the Anthropic facade');
        hasUnsupported = true;
      } else {
        warnings.push(`unsupported content block type: ${block.type}`);
      }
    }

    if (hasUnsupported) {
      return { openaiBody: null, warnings, errors };
    }

    // Tool results come first (Anthropic convention), then text
    for (const tr of toolResultMessages) {
      messages.push(tr);
    }

    // If this message had tool results AND text, text stays as the message
    if (toolResultMessages.length > 0 && textParts.length > 0) {
      messages.push({ role: msg.role, content: textParts.join('\n') });
    } else if (textParts.length > 0 && toolCalls.length > 0) {
      // Assistant message with both content and tool_calls
      messages.push({
        role: msg.role,
        content: textParts.join('\n'),
        tool_calls: toolCalls,
      });
    } else if (textParts.length > 0) {
      messages.push({ role: msg.role, content: textParts.join('\n') });
    } else if (toolCalls.length > 0) {
      messages.push({
        role: msg.role,
        content: null,
        tool_calls: toolCalls,
      });
    } else if (toolResultMessages.length === 0) {
      // Empty message with no useful content
      warnings.push('skipped message with no translatable content');
    }
  }

  openaiBody.messages = messages;

  // max_tokens (required by Anthropic)
  if (typeof body.max_tokens === 'number') {
    openaiBody.max_tokens = body.max_tokens;
  } else {
    errors.push('max_tokens is required');
  }

  // Optional fields forwarded as-is
  if (body.temperature !== undefined && typeof body.temperature === 'number') {
    openaiBody.temperature = body.temperature;
  }
  if (body.top_p !== undefined && typeof body.top_p === 'number') {
    openaiBody.top_p = body.top_p;
  }
  if (body.top_k !== undefined && typeof body.top_k === 'number') {
    warnings.push('top_k is not supported by OpenAI API and was dropped');
  }

  // stop_sequences → stop
  if (body.stop_sequences && Array.isArray(body.stop_sequences)) {
    if (body.stop_sequences.length > 4) {
      warnings.push('OpenAI supports max 4 stop sequences, truncating');
    }
    openaiBody.stop = body.stop_sequences.slice(0, 4);
  }

  // stream
  if (body.stream === true) {
    openaiBody.stream = true;
  }

  // tools translation
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    openaiBody.tools = body.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema ? structuredClone(t.input_schema) : { type: 'object', properties: {} },
      },
    }));
  }

  // metadata → user
  if (body.metadata && typeof body.metadata.user_id === 'string') {
    openaiBody.user = body.metadata.user_id;
  }

  // thinking → per-model reasoning translation
  if (body && body.thinking) {
    const reasoningCap = getReasoningCapability(openaiBody.model || body.model);
    if (body.thinking.type === 'enabled') {
      if (!reasoningCap.supported) {
        errors.push('This model does not support thinking');
      } else {
        const controlKey = reasoningCap.controlKey;
        if (controlKey === 'reasoning_effort') {
          let effort = reasoningCap.defaultMode || 'high';
          if (typeof body.thinking.budget_tokens === 'number') {
            const b = body.thinking.budget_tokens;
            if (b < 5000) effort = 'low';
            else if (b < 15000) effort = 'medium';
            else if (b < 30000) effort = 'high';
            else effort = 'max';
          }
          const modes = reasoningCap.modes || [];
          if (modes.length > 0 && !modes.includes(effort)) {
            const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'on', 'enabled'];
            const idx = order.indexOf(effort);
            for (let i = idx; i >= 0; i--) {
              if (modes.includes(order[i])) { effort = order[i]; break; }
            }
          }
          openaiBody.reasoning_effort = effort;
        } else if (controlKey && controlKey.startsWith('chat_template_kwargs.')) {
          if (!openaiBody.chat_template_kwargs) openaiBody.chat_template_kwargs = {};
          const fieldName = controlKey.split('.')[1];
          openaiBody.chat_template_kwargs[fieldName] = reasoningCap.enableValue !== undefined ? reasoningCap.enableValue : true;
        }
        // Alternate control (e.g. z-ai has both reasoning_effort AND chat_template_kwargs.enable_thinking)
        if (reasoningCap.alternateControl) {
          const altKey = reasoningCap.alternateControl.key;
          if (altKey && altKey.startsWith('chat_template_kwargs.')) {
            if (!openaiBody.chat_template_kwargs) openaiBody.chat_template_kwargs = {};
            openaiBody.chat_template_kwargs[altKey.split('.')[1]] = reasoningCap.alternateControl.enableValue !== undefined ? reasoningCap.alternateControl.enableValue : true;
          }
        }
      }
    } else if (body.thinking.type === 'disabled') {
      if (reasoningCap.supported) {
        const controlKey = reasoningCap.controlKey;
        if (controlKey === 'reasoning_effort') {
          if (reasoningCap.modes && reasoningCap.modes.includes('none')) {
            openaiBody.reasoning_effort = 'none';
          }
          if (reasoningCap.alternateControl) {
            const altKey = reasoningCap.alternateControl.key;
            if (altKey && altKey.startsWith('chat_template_kwargs.')) {
              if (!openaiBody.chat_template_kwargs) openaiBody.chat_template_kwargs = {};
              openaiBody.chat_template_kwargs[altKey.split('.')[1]] = reasoningCap.alternateControl.disableValue !== undefined ? reasoningCap.alternateControl.disableValue : false;
            }
          }
        } else if (controlKey && controlKey.startsWith('chat_template_kwargs.')) {
          if (!openaiBody.chat_template_kwargs) openaiBody.chat_template_kwargs = {};
          openaiBody.chat_template_kwargs[controlKey.split('.')[1]] = reasoningCap.disableValue !== undefined ? reasoningCap.disableValue : false;
        }
      }
    }
  }

  if (errors.length > 0) {
    return { openaiBody: null, warnings, errors };
  }
  return { openaiBody, warnings, errors };
}

// Translate an OpenAI Chat Completions response to Anthropic Messages API format (non-streaming)
export function translateAnthropicResponse(openaiResponse) {
  const content = [];
  let textContent = '';
  let stopReason = 'end_turn';

  if (openaiResponse.choices && openaiResponse.choices[0]) {
    const choice = openaiResponse.choices[0];
    if (choice.message) {
      if (choice.message.reasoning_content) {
        content.push({ type: 'thinking', thinking: choice.message.reasoning_content });
      }
      if (choice.message.content) {
        textContent = choice.message.content;
      }
      if (choice.message.tool_calls && Array.isArray(choice.message.tool_calls)) {
        for (const tc of choice.message.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function?.arguments || '{}'); } catch (e) { input = {}; }
          content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
        }
      }
    }
    const stopReasonMap = { 'stop': 'end_turn', 'length': 'max_tokens', 'tool_calls': 'tool_use', 'content_filter': 'end_turn' };
    stopReason = stopReasonMap[choice.finish_reason] || 'end_turn';
  }

  if (textContent) {
    content.unshift({ type: 'text', text: textContent });
  }

  const usage = {
    input_tokens: openaiResponse.usage?.prompt_tokens || 0,
    output_tokens: openaiResponse.usage?.completion_tokens || 0,
  };

  return {
    id: openaiResponse.id || 'msg_' + Date.now(),
    type: 'message',
    role: 'assistant',
    model: openaiResponse.model || '',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

// Helper: format an SSE event string
function formatSse(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Translate an OpenAI SSE stream into Anthropic SSE events (async generator)
export async function* translateAnthropicSseStream(openaiSseChunks, requestId, model) {
  let started = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = 'end_turn';
  let contentBlockStarted = false;
  let currentBlockIndex = -1;
  // F1/F2/F3: track the TYPE of the open content block, not just a boolean.
  // Each delta kind must live in a block of the matching type; a delta whose
  // required type differs from the open block first closes the open block.
  let currentBlockType = null;      // null | 'text' | 'thinking' | 'tool_use'
  let activeToolCallIndex = null;   // F3: tc.index of the currently-open tool_use block
  const stopReasonMap = { 'stop': 'end_turn', 'length': 'max_tokens', 'tool_calls': 'tool_use', 'content_filter': 'end_turn' };

  // Build the message_start event. modelHint is the model field observed on the
  // current data chunk (used only when the caller-supplied `model` param is empty).
  const emitMessageStart = (modelHint) => formatSse('message_start', {\r
    type: 'message_start',
    message: {
      id: requestId || ('msg_' + Date.now()),
      type: 'message',
      role: 'assistant',
      model: model || modelHint || '',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });

  // Close the open content block (if any) and reset block tracking.
  const closeContentBlock = () => formatSse('content_block_stop', { index: currentBlockIndex });

  for await (const chunk of openaiSseChunks) {
    // F5: a single physical chunk may carry multiple SSE events (TCP coalescing).
    // Parse every `data:` line into an ordered item list instead of stopping at
    // the first. Each `[DONE]` becomes a string sentinel; parsed payloads become
    // objects. Non-`data:` lines (comments, blank separators) are ignored.
    const items = [];
    if (typeof chunk === 'string') {
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '') continue;
        if (payload === '[DONE]') {
          items.push('[DONE]');
          continue;
        }
        try {
          items.push(JSON.parse(payload));
        } catch (e) {
          // skip a malformed data line without dropping the rest of the chunk
        }
      }
    } else if (chunk !== null && typeof chunk === 'object') {
      items.push(chunk);
    }

    if (items.length === 0) continue;

    for (const item of items) {
      // F4: [DONE] handling lives inside the item loop so message_start is
      // guaranteed to have been emitted before message_delta/message_stop.
      if (item === '[DONE]') {
        if (!started) {
          started = true;
          yield emitMessageStart(undefined);
        }
        if (contentBlockStarted) {
          yield closeContentBlock();
          contentBlockStarted = false;
          currentBlockType = null;
          activeToolCallIndex = null;
        }
        yield formatSse('message_delta', { stop_reason: stopReason, stop_sequence: null, usage: { output_tokens: outputTokens } });
        yield formatSse('message_stop', {});
        return;
      }
      if (!item || typeof item !== 'object') continue;

      const data = item;
      if (!started) {
        started = true;
        yield emitMessageStart(data.model);
      }

      if (data.choices && data.choices[0]) {
        const choice = data.choices[0];
        if (choice.delta) {
          // ---- text content (-> text block) ----
          if (choice.delta.content) {
            // F1: text_delta must be emitted inside a *text* block. If the open
            // block is a thinking or tool_use block, close it before opening text.
            if (currentBlockType !== 'text') {
              if (contentBlockStarted) {
                yield closeContentBlock();
                contentBlockStarted = false;
                currentBlockType = null;
              }
              currentBlockIndex++;
              contentBlockStarted = true;
              currentBlockType = 'text';
              yield formatSse('content_block_start', { index: currentBlockIndex, content_block: { type: 'text', text: '' } });
            }
            yield formatSse('content_block_delta', { index: currentBlockIndex, delta: { type: 'text_delta', text: choice.delta.content } });
            outputTokens++;
          }
          // ---- reasoning content (-> thinking block) ----
          if (choice.delta.reasoning_content) {
            // F2: only open a NEW thinking block when the open block is NOT
            // already thinking. Same-type (thinking -> thinking) deltas therefore
            // accumulate inside the single block instead of fragmenting it.
            if (currentBlockType !== 'thinking') {
              if (contentBlockStarted) {
                yield closeContentBlock();
                contentBlockStarted = false;
                currentBlockType = null;
              }
              currentBlockIndex++;
              contentBlockStarted = true;
              currentBlockType = 'thinking';
              yield formatSse('content_block_start', { index: currentBlockIndex, content_block: { type: 'thinking', thinking: '' } });
            }
            yield formatSse('content_block_delta', { index: currentBlockIndex, delta: { type: 'thinking_delta', thinking: choice.delta.reasoning_content } });
          }
          // ---- tool calls (-> tool_use block) ----
          if (choice.delta.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const tcIndex = (typeof tc.index === 'number') ? tc.index : 0;
              // F3: a fresh tool_use block is required when no tool_use block is
              // open, OR when the open tool_use block belongs to a different tool
              // call (tc.index changed). Any open text/thinking block is closed
              // first so the tool call is never dropped into the wrong block.
              if (currentBlockType !== 'tool_use' || activeToolCallIndex !== tcIndex) {
                if (contentBlockStarted) {
                  yield closeContentBlock();
                  contentBlockStarted = false;
                  currentBlockType = null;
                  activeToolCallIndex = null;
                }
                currentBlockIndex++;
                contentBlockStarted = true;
                currentBlockType = 'tool_use';
                activeToolCallIndex = tcIndex;
                yield formatSse('content_block_start', {
                  index: currentBlockIndex,
                  content_block: { type: 'tool_use', id: tc.id || ('toolu_' + Date.now()), name: tc.function?.name || '', input: {} },
                });
              }
              if (tc.function?.arguments) {
                yield formatSse('content_block_delta', {
                  index: currentBlockIndex,
                  delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
                });
              }
            }
          }
        }
        if (choice.finish_reason) {
          stopReason = stopReasonMap[choice.finish_reason] || 'end_turn';
        }
      }
      if (data.usage) {
        inputTokens = data.usage.prompt_tokens || inputTokens;
        outputTokens = data.usage.completion_tokens || outputTokens;
      }
    }
  }

  // F4: tail block. If the stream produced no data chunks at all (empty stream,
  // or only keep-alive lines), message_start was never emitted — emit it here
  // before the terminal message_delta/message_stop so the stream is well-formed.
  if (!started) {
    started = true;
    yield emitMessageStart(undefined);
  }
  if (contentBlockStarted) {
    yield closeContentBlock();
    contentBlockStarted = false;
    currentBlockType = null;
  }
  yield formatSse('message_delta', { stop_reason: stopReason, stop_sequence: null, usage: { output_tokens: outputTokens } });
  yield formatSse('message_stop', {});
}
