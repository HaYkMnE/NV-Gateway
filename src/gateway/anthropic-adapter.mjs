// Anthropic Messages API → OpenAI Chat Completions request translator.
// No network, no mutation of caller input, no side effects. The one non-pure
// touch is a READ of the persisted reasoning-capability cache
// (capability-probe.mjs), consulted so a model already PROVEN to reason is not
// second-guessed by a static table — see the precedence note on `thinking`.

import { getReasoningCapability, isFamilyKnown } from "./capability-registry.mjs";
import { getCachedReasoningCapability } from "./capability-probe.mjs";

/**
 * Capability used when NOTHING is known about a model that was asked to think:
 * translate with the control NVIDIA uses most (`reasoning_effort`, the one the
 * probe itself discovers) and declare no mode list, so no effort value is
 * clamped away on a guess. Upstream gets the final say.
 */
const OPTIMISTIC_REASONING = Object.freeze({
  supported: true,
  modes: Object.freeze([]),
  controlKey: 'reasoning_effort',
  defaultMode: 'high',
});

/**
 * Read LIVE probed reasoning evidence for a model, or null when there is none.
 *
 * Only a positive result is returned: the probe discovers `reasoning_effort`
 * support specifically, so a cached `supported:false` means "no
 * reasoning_effort", NOT "cannot think at all" — treating it as the latter
 * would invent a new local veto out of an inconclusive measurement.
 *
 * `controlKey` is null when the probe measured reasoning WITHOUT a usable
 * `reasoning_effort` control, so callers must treat it as "no control key",
 * not as "field missing".
 *
 * @param {unknown} modelId
 * @returns {{ supported: true, modes: string[], controlKey: string | null, defaultMode?: string } | null}
 */
function readProbedReasoning(modelId) {
  let entry;
  try {
    entry = getCachedReasoningCapability(modelId);
  } catch {
    return null; // a broken cache must never fail a client request
  }
  if (!entry || entry.supported !== true) return null;
  // Only a REAL live run is evidence. `source:'fallback'` is a static guess that
  // merely happens to live in the cache file, so it must never outrank the
  // family table it was guessed from.
  if (entry.source !== 'probed') return null;
  const modes = Array.isArray(entry.modes) ? entry.modes.filter(m => typeof m === 'string') : [];
  // `controlKey: null` TOGETHER WITH an empty mode list is a MEASURED answer,
  // not missing data: the probe writes exactly that shape for a model that emits
  // reasoning_content while rejecting every reasoning_effort candidate. Coercing
  // it to 'reasoning_effort' would send upstream the very value the probe just
  // measured as rejected, so the "no control" answer is carried through and the
  // statically-known alternate control (if any) does the work instead.
  // With modes present the probe always names reasoning_effort, so a missing key
  // there is just an incomplete entry and is repaired to the probe's own default.
  const controlKey = typeof entry.controlKey === 'string' && entry.controlKey
    ? entry.controlKey
    : (modes.length > 0 ? 'reasoning_effort' : null);
  return {
    supported: true,
    modes,
    controlKey,
    ...(typeof entry.defaultMode === 'string' && entry.defaultMode ? { defaultMode: entry.defaultMode } : {}),
  };
}

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

  // tool_choice translation (Anthropic → OpenAI)
  //
  // Anthropic: { type: 'auto' | 'any' | 'tool' | 'none', name?, disable_parallel_tool_use? }
  // OpenAI:    'auto' | 'required' | 'none' | { type: 'function', function: { name } }
  //
  // Without this mapping the field was parsed by nothing and silently dropped,
  // which downgrades "you MUST call a tool" (any / a named tool) into "you may
  // call a tool" — an agent loop that depends on forced tool use then never
  // sees a tool call. OpenAI rejects tool_choice when no tools are declared, so
  // it is only forwarded alongside a non-empty tools array.
  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    const isObjectChoice = typeof body.tool_choice === 'object' && !Array.isArray(body.tool_choice);
    const hasTools = Array.isArray(openaiBody.tools) && openaiBody.tools.length > 0;
    if (!isObjectChoice) {
      // A non-object tool_choice (e.g. an OpenAI-style bare string) is not valid
      // Anthropic input. It is still warned about rather than dropped in
      // silence, so a mis-shaped client request is diagnosable from the log.
      warnings.push('tool_choice was dropped because it is not an object');
    } else if (!hasTools) {
      warnings.push('tool_choice was dropped because the request declares no tools');
    } else {
      const kind = body.tool_choice.type;
      let mapped;
      if (kind === 'auto') {
        mapped = 'auto';
      } else if (kind === 'any') {
        mapped = 'required';
      } else if (kind === 'none') {
        mapped = 'none';
      } else if (kind === 'tool') {
        if (typeof body.tool_choice.name === 'string' && body.tool_choice.name.length > 0) {
          mapped = { type: 'function', function: { name: body.tool_choice.name } };
        } else {
          warnings.push('tool_choice type "tool" was dropped because it names no tool');
        }
      } else {
        warnings.push('unsupported tool_choice type was dropped: ' + JSON.stringify(kind ?? null));
      }
      if (mapped !== undefined) {
        openaiBody.tool_choice = mapped;
        // Anthropic expresses "at most/exactly one tool call" as a flag on
        // tool_choice; OpenAI expresses it as a sibling boolean.
        if (body.tool_choice.disable_parallel_tool_use === true) {
          openaiBody.parallel_tool_calls = false;
        }
      }
    }
  }

  // metadata → user
  if (body.metadata && typeof body.metadata.user_id === 'string') {
    openaiBody.user = body.metadata.user_id;
  }

  // thinking → per-model reasoning translation
  //
  // PRECEDENCE (deliberate): probed evidence > static family table > optimism.
  //
  // The static family table may INFORM a capability decision but must never
  // VETO one for a model it does not know. NVIDIA adds and changes models
  // without our releases, so an unknown model id is the NORMAL case, not an
  // error case. Fail-closed is right for security decisions; it is wrong here,
  // because UPSTREAM is the real authority on whether a model can think — and
  // its rejection already reaches the client verbatim through the normal error
  // path (buildAnthropicUpstreamError in server.mjs).
  //
  // Measured behaviour before this fix: `thinking:{type:"enabled"}` on a model
  // whose family is absent from the table returned a hard local 400
  // ("This model does not support thinking") and never contacted upstream,
  // while the SAME model on /v1/chat/completions was forwarded and answered
  // 200 — the two facades disagreed. A probed cache entry that had already
  // proven reasoning support was ignored at this very decision point.
  //
  // A family we genuinely KNOW lacks reasoning is still refused locally: that
  // is knowledge, not a guess, and refusing costs no upstream round-trip.
  if (body && body.thinking) {
    const modelId = openaiBody.model || body.model;
    const staticCap = getReasoningCapability(modelId);
    const probedCap = readProbedReasoning(modelId);
    const familyKnown = isFamilyKnown(modelId);

    // Only real knowledge (probe first, then a populated family entry) may
    // drive the "disabled" path; with nothing known we invent no fields.
    //
    // The probe MEASURES one thing: which `reasoning_effort` values a model
    // accepts. It never writes alternateControl / enableValue / disableValue, so
    // a probed entry must be layered ONTO the static family knowledge rather
    // than substituted for it — otherwise a routine background probe silently
    // strips a statically-known second control (z-ai/glm-4.5 needs
    // chat_template_kwargs.enable_thinking as well as reasoning_effort) and
    // `thinking:{type:'disabled'}` stops being honoured upstream.
    let reasoningCap = probedCap ? { ...staticCap, ...probedCap } : staticCap;
    if (body.thinking.type === 'enabled' && !reasoningCap.supported && !familyKnown) {
      reasoningCap = OPTIMISTIC_REASONING;
      warnings.push('thinking was translated optimistically: this model family is unknown to the capability registry, so upstream decides whether reasoning is supported');
    }

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
  const emitMessageStart = (modelHint) => formatSse('message_start', {
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
