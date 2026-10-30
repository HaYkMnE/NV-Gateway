// Anthropic Messages API -†’ OpenAI Chat Completions request translator.
// No network, no mutation of caller input, no side effects. The only non-pure
// touches are READS: the persisted reasoning-capability cache
// (capability-probe.mjs), consulted so a model already PROVEN to reason is not
// second-guessed by a static table -” see the precedence note on `thinking` -”
// and the runtime secret list behind `redact` (shared/redaction.mjs), used to
// scrub an upstream error body before it is echoed to a client.

import { getReasoningCapability, isFamilyKnown } from "./capability-registry.mjs";
import { resolveAdvertisedReasoning, resolveDefaultMode } from "./capability-probe.mjs";
import { isGlm53Model } from "./glm-reasoning.mjs";
import { effortForThinkingBudget, isDeepSeekV41FlashModel, isKimiK3Model, markReasoningDefaultsHandled } from "./reasoning-defaults.mjs";
import { redact } from "../shared/redaction.mjs";

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
 * Does this model's upstream contract accept PRIOR assistant reasoning echoed
 * back as `reasoning_content` on the assistant turn?
 *
 * This is an allowlist of VERIFIED families, not a guess and not simply
 * "supports reasoning": the two are different contracts. A model can reason
 * (nvidia/llama-3.1-nemotron, meta/llama-4-*) while its endpoint rejects or
 * ignores an echoed reasoning field, so replaying there would inject a field
 * upstream never asked for. Families are added only with evidence:
 *  - z-ai/glm-*      : GLM chat template accepts reasoning_content in history.
 *  - deepseek-ai/deepseek-v4* : the V4 generation accepts echoed
 *    reasoning_content. NOT the whole `deepseek-ai/` family: `deepseek-r1`'s
 *    contract answers 400 for a reasoning_content field in history, so a
 *    family-wide match silently broke R1 on every multi-turn request.
 *  - moonshotai/kimi-k3: documented multi-turn/tool continuation requirement.
 * Every other family keeps the previous drop-with-warning behavior.
 *
 * @param {unknown} modelId
 */
function echoesAssistantReasoning(modelId) {
  if (typeof modelId !== 'string') return false;
  return /^z-ai\//i.test(modelId) || /^deepseek-ai\/deepseek-v4/i.test(modelId) || isKimiK3Model(modelId);
}

/**
 * Clamp a requested effort onto the mode list the capability layer ADVERTISES.
 *
 * The GLM-5.3 / Kimi K3 overrides bypass the generic budget path, so without
 * this they could send a value /v1/models never offers (a `['high','max']` model
 * given a small budget would get "low"). Every value this adapter writes for a
 * reasoning_effort control must be one of the advertised modes.
 *
 * @param {string} effort
 * @param {{modes?: unknown, defaultMode?: unknown}} reasoningCap
 * @returns {string}
 */
function clampToAdvertisedModes(effort, reasoningCap) {
  const modes = Array.isArray(reasoningCap.modes)
    ? reasoningCap.modes.filter((m) => typeof m === 'string')
    : [];
  if (modes.length === 0) return effort;
  if (modes.includes(effort)) return effort;
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'on', 'enabled'];
  const idx = order.indexOf(effort);
  for (let i = idx; i >= 0; i--) {
    if (modes.includes(order[i])) return order[i];
  }
  return resolveDefaultMode(modes, reasoningCap.defaultMode) || modes[0];
}

/**
 * Read LIVE probed reasoning evidence for a model, or null when there is none.
 *
 * Only a positive result is returned: the probe discovers `reasoning_effort`
 * support specifically, so a cached `supported:false` means "no
 * reasoning_effort", NOT "cannot think at all" -” treating it as the latter
 * would invent a new local veto out of an inconclusive measurement.
 *
 * `controlKey` is null when the probe measured reasoning WITHOUT a usable
 * control -” or when the entry names a control the adapter cannot drive, or one
 * with no verified value to drive it with. Callers must treat it as "no control
 * key", not as "field missing".
 *
 * `defaultMode` is the SAME value /v1/models advertises: it is resolved with
 * capability-probe's own clamp over the same mode list, so the advertised
 * default and the value this adapter sends cannot disagree.
 *
 * @param {unknown} modelId
 * @returns {{ supported: true, modes: string[], controlKey: string | null, defaultMode: string | null } | null}
 */
function readProbedReasoning(modelId) {
  // ONE shared rule for every consumer. resolveAdvertisedReasoning is the
  // authority on freshness, source and shape; keeping a private copy of those
  // checks here is exactly how the three readers drifted apart (a 25h entry was
  // stale for one consumer and authoritative for another).
  const advertised = resolveAdvertisedReasoning(modelId);
  if (!advertised.authoritative) return null;
  // A probed NEGATIVE means the probe observed NO reasoning output at all
  // (capability-probe.mjs: `supported: sawReasoning`). That is a statement about
  // the MODEL, not about the control: a model that never reasons must keep
  // `supported:false` so the caller can refuse a `thinking` request honestly
  // (HEAD behaviour, 400 with an explanation). Rewriting it to `supported:true`
  // silently accepted thinking for a non-reasoning model - inverted honesty.
  if (!advertised.supported) {
    return { supported: false, controlKey: null, modes: [], defaultMode: null };
  }
  // Positive verdict with no driveable control: the model reasons, but the probe
  // verified no effort value. Keep `supported:true` and send nothing.
  if (advertised.controlKey === null) {
    return { supported: true, controlKey: null, modes: [], defaultMode: null };
  }
  return {
    supported: true,
    modes: [...advertised.modes],
    controlKey: advertised.controlKey,
    defaultMode: advertised.defaultMode,
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
    let reasoningParts = [];
    let hasUnsupported = false;

    for (const block of msg.content) {
      if (!block || typeof block !== 'object' || !block.type) {
        warnings.push('skipped malformed content block (missing type)');
        continue;
      }

      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (block.type === 'thinking' && msg.role === 'assistant'
          && echoesAssistantReasoning(body.model) && typeof block.thinking === 'string') {
        // Prior assistant reasoning is replayed verbatim as `reasoning_content`
        // for the families whose upstream contract accepts it (see
        // echoesAssistantReasoning). Replaying it keeps multi-turn and
        // tool-continuation context intact instead of silently degrading it.
        // A thinking block on a user turn, or a non-echoing family, still falls
        // through to the drop-with-warning branch below.
        reasoningParts.push(block.thinking);
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

    const reasoningField = reasoningParts.length > 0
      ? { reasoning_content: reasoningParts.join('\n') }
      : {};

    // If this message had tool results AND text, text stays as the message
    if (toolResultMessages.length > 0 && textParts.length > 0) {
      messages.push({ role: msg.role, content: textParts.join('\n'), ...reasoningField });
    } else if (textParts.length > 0 && toolCalls.length > 0) {
      // Assistant message with both content and tool_calls
      messages.push({
        role: msg.role,
        content: textParts.join('\n'),
        tool_calls: toolCalls,
        ...reasoningField,
      });
    } else if (textParts.length > 0) {
      messages.push({ role: msg.role, content: textParts.join('\n'), ...reasoningField });
    } else if (toolCalls.length > 0) {
      messages.push({
        role: msg.role,
        content: null,
        tool_calls: toolCalls,
        ...reasoningField,
      });
    } else if (reasoningParts.length > 0) {
      messages.push({ role: msg.role, content: null, ...reasoningField });
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

  // stop_sequences -†’ stop
  if (body.stop_sequences && Array.isArray(body.stop_sequences)) {
    if (body.stop_sequences.length > 4) {
      warnings.push('OpenAI supports max 4 stop sequences, truncating');
    }
    openaiBody.stop = body.stop_sequences.slice(0, 4);
  }

  // stream
  if (body.stream === true) {
    openaiBody.stream = true;
    // Ask upstream for the usage frame. Without it a streamed Chat Completions
    // response carries NO token counts at all, so the facade could only record
    // `tokens: null` for every streamed turn (measured: 0 of 4,224 streamed
    // completions had any). Same field the Responses facade requests.
    openaiBody.stream_options = { include_usage: true };
  }

  // tools translation
  //
  // Each entry is validated BEFORE it is read. `body.tools.map(t => t.name)`
  // used to throw a TypeError on `[null]` (child process exit 1, no client
  // answer at all) and to forward `[{}]`/`[{name:123}]` as a nameless function,
  // which upstream rejects with an opaque 400 blaming the wrong field.
  //
  // Policy: DROP the invalid entry and warn, exactly like the malformed
  // content-block / message / tool_use handling above -” this adapter repairs
  // what it can and only errors on input it cannot express at all. A 400 would
  // reject an otherwise serviceable request (the mixed case keeps its valid
  // tools), and `tools` is advisory: a request without tools still answers.
  // When nothing survives, `tools` is OMITTED rather than sent empty, because
  // OpenAI/NVIDIA reject an empty tools array; `tool_choice` then drops with it
  // through the existing hasTools guard below.
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const translatedTools = [];
    let droppedTools = 0;
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)
          || typeof tool.name !== 'string' || tool.name.length === 0) {
        droppedTools++;
        continue;
      }
      translatedTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          parameters: tool.input_schema ? structuredClone(tool.input_schema) : { type: 'object', properties: {} },
        },
      });
    }
    if (droppedTools > 0) {
      warnings.push(`dropped ${droppedTools} malformed tool definition(s): each tool needs an object with a non-empty string name`);
    }
    if (translatedTools.length > 0) openaiBody.tools = translatedTools;
  }

  // tool_choice translation (Anthropic -†’ OpenAI)
  //
  // Anthropic: { type: 'auto' | 'any' | 'tool' | 'none', name?, disable_parallel_tool_use? }
  // OpenAI:    'auto' | 'required' | 'none' | { type: 'function', function: { name } }
  //
  // Without this mapping the field was parsed by nothing and silently dropped,
  // which downgrades "you MUST call a tool" (any / a named tool) into "you may
  // call a tool" -” an agent loop that depends on forced tool use then never
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

  // metadata -†’ user
  if (body.metadata && typeof body.metadata.user_id === 'string') {
    openaiBody.user = body.metadata.user_id;
  }

  // thinking -†’ per-model reasoning translation
  //
  // PRECEDENCE (deliberate): probed evidence > static family table > optimism.
  //
  // The static family table may INFORM a capability decision but must never
  // VETO one for a model it does not know. NVIDIA adds and changes models
  // without our releases, so an unknown model id is the NORMAL case, not an
  // error case. Fail-closed is right for security decisions; it is wrong here,
  // because UPSTREAM is the real authority on whether a model can think -” and
  // its rejection already reaches the client verbatim through the normal error
  // path (buildAnthropicUpstreamError in server.mjs).
  //
  // Measured behaviour before this fix: `thinking:{type:"enabled"}` on a model
  // whose family is absent from the table returned a hard local 400
  // ("This model does not support thinking") and never contacted upstream,
  // while the SAME model on /v1/chat/completions was forwarded and answered
  // 200 -” the two facades disagreed. A probed cache entry that had already
  // proven reasoning support was ignored at this very decision point.
  //
  // A family we genuinely KNOW lacks reasoning is still refused locally: that
  // is knowledge, not a guess, and refusing costs no upstream round-trip.
  // Honesty gate: the GLM-5.3 / Kimi K3 overrides below may only run when the
  // capability layer actually ADVERTISES a reasoning_effort control with at
  // least one verified mode. Otherwise they would send an effort that
  // /v1/models reports as unavailable (e.g. after a probe sweep that proved
  // nothing) -” advertised must equal sent.
  let overrideAllowed = false;

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
    // than substituted for it -” otherwise a routine background probe silently
    // strips a statically-known second control (z-ai/glm-4.5 needs
    // chat_template_kwargs.enable_thinking as well as reasoning_effort) and
    // `thinking:{type:'disabled'}` stops being honoured upstream.
    //
    // Layering is not enough on its own: the probe interrogates `reasoning_effort`
    // and NOTHING ELSE, so its `controlKey` is only ever "reasoning_effort was
    // accepted", never "this is the switch that governs this model". NVIDIA
    // accepts `reasoning_effort` as an unvalidated no-op on models whose real
    // control is a chat_template_kwargs flag, so every candidate verifies and the
    // probe writes controlKey:'reasoning_effort'. Spreading that over a family
    // that statically names its own control (qwen, stepfun-ai, minimaxai) renames
    // the switch to one that does nothing and drops the only field that works.
    // Probe evidence may therefore UNLOCK reasoning on such a family, but it may
    // not rename its control or replace a mode list describing a different axis.
    let reasoningCap = staticCap;
    if (probedCap && !isDeepSeekV41FlashModel(modelId)) {
      const staticControl = typeof staticCap.controlKey === 'string' && staticCap.controlKey
        ? staticCap.controlKey
        : null;
      if (staticControl && staticControl !== 'reasoning_effort') {
        // The probe only measures reasoning_effort. On a family that drives its
        // own ctk control, a POSITIVE probe may unlock reasoning, but a NEGATIVE
        // one says nothing about that other control — it neither unlocks nor
        // vetoes: the static knowledge stands.
        reasoningCap = probedCap.supported ? { ...staticCap, supported: true } : staticCap;
      } else {
        reasoningCap = { ...staticCap, ...probedCap };
      }
    }
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
          const modes = reasoningCap.modes || [];
          // No budget: send exactly the default /v1/models advertises. Both sides
          // call capability-probe's resolveDefaultMode over the same list, and the
          // cache repair persists its result, so there is ONE clamp -” the old
          // `defaultMode || 'high'` here sent values the probe never advertised
          // ('none', 'bogus', or 'high' outside a ['max'] list).
          let effort = resolveDefaultMode(modes, reasoningCap.defaultMode) || 'high';
          if (typeof body.thinking.budget_tokens === 'number') {
            const b = body.thinking.budget_tokens;
            if (b < 5000) effort = 'low';
            else if (b < 15000) effort = 'medium';
            else if (b < 30000) effort = 'high';
            else effort = 'max';
          }
          if (modes.length > 0 && !modes.includes(effort)) {
            const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'on', 'enabled'];
            const idx = order.indexOf(effort);
            for (let i = idx; i >= 0; i--) {
              if (modes.includes(order[i])) { effort = order[i]; break; }
            }
            // Nothing at or below the requested level is accepted (e.g. modes
            // ['max'] with a 20000 budget, which maps to 'high'): send the
            // advertised default, which is a mode on offer by construction, so
            // the value sent is always one /v1/models advertises.
            if (!modes.includes(effort)) effort = resolveDefaultMode(modes, reasoningCap.defaultMode) || effort;
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
        if (isDeepSeekV41FlashModel(modelId)) {
          warnings.push('thinking effort was not translated for this model: no verified reasoning control is known, so no reasoning_effort field was sent');
        }
      }
    } else if (body.thinking.type === 'disabled') {
      if (reasoningCap.supported) {
        const controlKey = reasoningCap.controlKey;
        // Honesty invariant: an explicit user disable MUST leave a trace -” a
        // real upstream field, or a warning when no field can express "off".
        // A body forwarded with neither misleads the user: upstream applies its
        // own default (thinking ON) while the request reads as "disabled".
        let disableEmitted = false;
        if (controlKey === 'reasoning_effort') {
          if (reasoningCap.modes && reasoningCap.modes.includes('none')) {
            openaiBody.reasoning_effort = 'none';
            disableEmitted = true;
          }
        } else if (controlKey && controlKey.startsWith('chat_template_kwargs.')) {
          if (!openaiBody.chat_template_kwargs) openaiBody.chat_template_kwargs = {};
          openaiBody.chat_template_kwargs[controlKey.split('.')[1]] = reasoningCap.disableValue !== undefined ? reasoningCap.disableValue : false;
          disableEmitted = true;
        }
        // Alternate control, mirroring the enabled path above: it must run
        // whatever the primary controlKey turned out to be. A probed entry can
        // legitimately report controlKey:null ("reasoning happens, but no usable
        // reasoning_effort"), and while this block was nested inside the
        // reasoning_effort branch that answer made `thinking:{type:'disabled'}` a
        // silent NO-OP for exactly the model D1 was about: z-ai/glm-4.5, whose
        // enable_thinking flag is then the only remaining way to switch off.
        if (reasoningCap.alternateControl) {
          const altKey = reasoningCap.alternateControl.key;
          if (altKey && altKey.startsWith('chat_template_kwargs.')) {
            if (!openaiBody.chat_template_kwargs) openaiBody.chat_template_kwargs = {};
            openaiBody.chat_template_kwargs[altKey.split('.')[1]] = reasoningCap.alternateControl.disableValue !== undefined ? reasoningCap.alternateControl.disableValue : false;
            disableEmitted = true;
          }
        }
        if (!disableEmitted) {
          // Never synthesize a control the family does not declare (a guessed
          // key would fail upstream validation OR, worse, be accepted as an
          // unvalidated no-op while claiming success). Warn instead and let the
          // request proceed with thinking untouched.
          warnings.push('thinking cannot be disabled for this model: no "none" reasoning mode and no alternate disable control are known, so the setting had no effect and the model may still reason');
        }
      } else if (!familyKnown) {
        // Unknown family: the "enabled" sibling above warns when translating
        // optimistically; an explicit DISABLE deserves the same honesty. We
        // know of no control, we emit none (inventing one was rejected at the
        // top of this block), and the body goes upstream untouched -” the user
        // must hear that their "off" had no effect.
        warnings.push('thinking cannot be disabled for this model: its family is unknown to the capability registry and no disable control is known, so the setting had no effect and the model may still reason');
      }
    }

  // GLM-5.3 accepts reasoning_effort low|high|max only and always thinks
  // (NVIDIA NIM docs), so the generic z-ai mapping above (none/medium and
  // enable_thinking) would send values upstream rejects. Re-map onto the valid
  // set; "disabled" degrades to the cheapest valid effort and says so.
  // Honesty gate: this override may only run when the capability layer actually
  // ADVERTISES a reasoning_effort control with at least one verified mode.
  // Otherwise it would send an effort that /v1/models reports as unavailable
  // (e.g. after a probe sweep that proved nothing) -” advertised must equal sent.
  overrideAllowed = errors.length === 0 && body && body.thinking
    && reasoningCap.supported === true
    && reasoningCap.controlKey === 'reasoning_effort'
    && Array.isArray(reasoningCap.modes) && reasoningCap.modes.length > 0;
  if (overrideAllowed && isGlm53Model(openaiBody.model)) {
    if (openaiBody.chat_template_kwargs) {
      delete openaiBody.chat_template_kwargs.enable_thinking;
      if (Object.keys(openaiBody.chat_template_kwargs).length === 0) delete openaiBody.chat_template_kwargs;
    }
    if (body.thinking.type === 'disabled') {
      openaiBody.reasoning_effort = clampToAdvertisedModes('low', reasoningCap);
      warnings.push('thinking cannot be disabled for this model: GLM-5.3 always reasons, so the cheapest advertised effort was used instead');
    } else if (body.thinking.type === 'enabled') {
      openaiBody.reasoning_effort = clampToAdvertisedModes(effortForThinkingBudget(body.thinking.budget_tokens), reasoningCap);
    }
  }

  // Kimi K3 takes low|high|max only and always thinks (NVIDIA NIM docs). The family
  // default is "max" (very long first-byte waits), and the generic budget table
  // yields "medium", which Kimi rejects, so thinking is mapped here: no budget ->
  // the advertised default, budgets onto low|high|max.
  if (overrideAllowed && isKimiK3Model(openaiBody.model) && body.thinking.type === 'enabled') {
    // No client budget means "use the gateway default", which is exactly what
    // /v1/models advertises as defaultMode.
    const hasBudget = typeof body.thinking.budget_tokens === 'number'
      && Number.isFinite(body.thinking.budget_tokens);
    const wanted = hasBudget
      ? effortForThinkingBudget(body.thinking.budget_tokens)
      : (typeof reasoningCap.defaultMode === 'string' ? reasoningCap.defaultMode : effortForThinkingBudget(undefined));
    openaiBody.reasoning_effort = clampToAdvertisedModes(wanted, reasoningCap);
  }
  // Kimi K3 + thinking:disabled: the HEAD honesty contract
  // (tests/anthropic-thinking-disable-honesty.test.mjs) forbids synthesizing a
  // reasoning_effort here - Kimi has no "off" mode, so the request goes upstream
  // with an honesty warning and NO effort field; upstream then applies its own
  // default. This is a deliberate, tested choice, not an omission.
  }


  if (errors.length > 0) {
    return { openaiBody: null, warnings, errors };
  }
  // Honesty gate follow-through: when this facade deliberately emits NO reasoning
  // field — the capability layer advertises no usable control, or the client asked
  // for "disabled" on a model that cannot switch thinking off — the server-side
  // default injector must not re-add one behind its back. Whenever an effort WAS
  // written, the shared defaults stay in charge as before.
  const emittedEffort = openaiBody && openaiBody.reasoning_effort !== undefined;
  if (body && body.thinking && openaiBody && !emittedEffort
      && (isGlm53Model(openaiBody.model) || isKimiK3Model(openaiBody.model))) {
    markReasoningDefaultsHandled(openaiBody);
  }
  return { openaiBody, warnings, errors };
}

// Translate an OpenAI Chat Completions response to Anthropic Messages API format (non-streaming)
export function translateAnthropicResponse(openaiResponse) {
  const content = [];
  let stopReason = 'end_turn';

  if (openaiResponse.choices && openaiResponse.choices[0]) {
    const choice = openaiResponse.choices[0];
    if (choice.message) {
      // Anthropic's contract (and this adapter's streaming path, where upstream
      // reasoning deltas arrive before content deltas) is thinking blocks FIRST,
      // then text, then tool_use. Each block is therefore pushed in place; the
      // old deferred `content.unshift(text)` put text ahead of thinking and
      // contradicted both the spec and the stream.
      if (choice.message.reasoning_content) {
        content.push({ type: 'thinking', thinking: choice.message.reasoning_content });
      }
      if (choice.message.content) {
        content.push({ type: 'text', text: choice.message.content });
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

// Maximum bytes in one SSE frame, EXCLUDING its terminating blank-line
// delimiter (LF LF, CR CR, or CRLF CRLF). Exactly 65,536 frame bytes are valid;
// byte 65,537 makes the whole frame malformed and it is discarded through the
// delimiter. Four extra scratch bytes are reserved only to recognize a split
// CRLF delimiter without growing memory with the upstream stream.
const MAX_INCOMPLETE_SSE_FRAME_BYTES = 64 * 1024;

// Upstream error text is echoed to the CLIENT, so it is untrusted output from a
// third party and must be bounded and scrubbed before it leaves the gateway.
// 300 chars is enough for the actionable sentence ("model X does not support
// reasoning_effort"), while a 1000-char stack dump both floods an SSE frame and
// leaks local paths / header values an upstream chose to quote back.
const MAX_UPSTREAM_ERROR_MESSAGE_CHARS = 300;
const UPSTREAM_ERROR_FALLBACK = 'Upstream SSE error';
// A JS stack frame: leading indentation, then `at `. No actionable cause lives
// there (only file paths and offsets), so the frames are removed wholesale.
const STACK_FRAME_LINE = /^\s+at\s/;
// `redact()` scrubs query/fragment parts of ABSOLUTE urls only, and knows just
// Bearer + nvapi secrets. An upstream quoting its own route or a header value
// therefore slipped through the client-facing boundary with the credential
// intact. These two patterns close that gap without widening redaction.mjs
// (whose behavior other call sites depend on):
//  1. the `?...`/`#...` tail of a PATH-like token (`/v1/x?token=...`), absolute
//     or relative -” anchored on the leading `/` AND on a TOKEN BOUNDARY (start of
//     text or any non-alphanumeric separator), so ordinary prose keeps its
//     punctuation ("why? because ...", "error #42", and a ratio like
//     "invalid ratio 1/2? expected an integer" is untouched: `/2` there is a
//     fraction whose slash follows a DIGIT, not a path separator);
//  2. `key: value` / `key=value` where the key names a credential.
// The tail class is written as `(?:[^...]*)` rather than the bare `[^...]*`
// ONLY to keep the class-closing `]` and the `*` from becoming ADJACENT: `]*` at
// the end of a literal is byte-for-byte a comment terminator, so it survived
// minification into the shipped bundle and tripped the comment-leak guard. The
// extra group is semantically transparent (a group around one class quantifier
// matches exactly what the bare quantifier matched), and esbuild prints a regex
// literal as written instead of rewriting it, so nothing can reintroduce `]*`.
const URL_QUERY_OR_FRAGMENT = /(^|[^A-Za-z0-9])(\/[^\s<>"'`?#]*)[?#](?:[^\s<>"'`]*)/g;
// The VALUE is captured and judged separately (see isCredentialShapedValue):
// a bare `[^\s]+` value class redacted the first word after ANY credential-ish
// key, so "Invalid api_key: the provided value is too short" lost its meaning
// and even a token COUNT was hidden ("Value token = 5"). Only credential-SHAPED
// values may be redacted; actionable prose must survive verbatim.
//
// The KEY may be quoted (`"api_key":`) and the VALUE may be wrapped in a
// matching quote (`x-api-key: "sk-..."`, `{"api_key":"sk-..."}`). Pass 3
// MEASURED that a value class unable to START on a quote left every quoted
// credential byte-identical, so the wrapper is part of the match and is
// PRESERVED on both sides of the replacement (only the secret is replaced).
const CREDENTIAL_PAIR = /(?<prefix>["'`]?(?:authorization|x-api-key|api[-_]?key|cookie|set-cookie|token|secret|password)["'`]?\s*[:=]\s*)(?:(?<scheme>basic|bearer|digest)\s+)?(?<quote>["'`]?)(?<value>[^\s,;"'`]+)(?:\k<quote>)?/gi;
// Shorter values are prose or counters ("5", "the", "expired"), never a key.
const MIN_CREDENTIAL_VALUE_CHARS = 8;
// A LONG pure-alnum value has no shape marker a human word carries, but past
// this length it is a key, not a word: `api_key: abcdefghijklmnop` (16) is a
// credential; `secret: rotation` / `token: provided` (<=9) stay readable.
const LONG_OPAQUE_CREDENTIAL_CHARS = 16;

/**
 * Does this token look like a credential VALUE (so it must be redacted), or is
 * it an ordinary word that happens to follow a credential-ish key?
 *
 * Evidence, not vocabulary: an explicit auth scheme (`Basic ...`) is always a
 * credential; otherwise the token needs to be long enough AND carry a marker a
 * human word does not -” a digit, `=`, base64/url punctuation, or mixed case.
 * `rotation`, `expired`, `provided` and `5` all fail this and stay readable.
 *
 * @param {string} value
 * @param {boolean} hasAuthScheme
 */
function isCredentialShapedValue(value, hasAuthScheme) {
  if (hasAuthScheme) return true;
  if (value.length < MIN_CREDENTIAL_VALUE_CHARS) return false;
  if (/[0-9=+/_.-]/.test(value)) return true;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) return true;
  // Pass 3: `abcdefghijklmnop` carries NO marker, yet 16 opaque alnum chars
  // after a credential key is a key (measured: it was echoed byte-identically).
  return value.length >= LONG_OPAQUE_CREDENTIAL_CHARS && /^[A-Za-z0-9]+$/.test(value);
}

/**
 * Bound + scrub an upstream-supplied error message for client display.
 *
 * Order matters: redact FIRST (so a secret is never split by the length cap),
 * then the relative-URL and credential-pair scrubs `redact` cannot see, then
 * drop stack frames, then collapse whitespace (so the cap is spent on content),
 * then cap. `redact` (shared/redaction.mjs) replaces `Bearer <token>`,
 * `nvapi-*`, runtime secrets and ABSOLUTE-url query/fragment components with
 * `[REDACTED]` / a bare origin+path; the two local patterns cover a relative
 * route (`/v1/x?token=`) and header-style credentials (`x-api-key: ...`).
 *
 * A clean message is returned unchanged, so actionable upstream wording is
 * preserved verbatim.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeUpstreamErrorMessage(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return UPSTREAM_ERROR_FALLBACK;
  let message = String(redact(raw));
  message = message.replace(URL_QUERY_OR_FRAGMENT, '$1$2');
  message = message.replace(CREDENTIAL_PAIR, (match, prefix, scheme, quote, value) => {
    if (!isCredentialShapedValue(value, typeof scheme === 'string' && scheme.length > 0)) return match;
    const schemePrefix = scheme ? `${scheme} ` : '';
    const consumed = prefix.length + schemePrefix.length + quote.length + value.length;
    // Everything the match consumed AFTER the value is a closing quote (or
    // nothing): it is preserved so `"..."`/`'...'`/JSON stay well-formed.
    return `${prefix}${schemePrefix}${quote}[REDACTED]${match.slice(consumed)}`;
  });
  message = message.split(/\r\n|\r|\n/).filter((line) => !STACK_FRAME_LINE.test(line)).join(' ');
  message = message.replace(/\s+/g, ' ').trim();
  if (message === '') return UPSTREAM_ERROR_FALLBACK;
  if (message.length <= MAX_UPSTREAM_ERROR_MESSAGE_CHARS) return message;
  // Keep exactly the cap and mark the cut, never splitting a surrogate pair.
  let cut = MAX_UPSTREAM_ERROR_MESSAGE_CHARS - 1;
  const lastUnit = message.charCodeAt(cut - 1);
  if (lastUnit >= 0xD800 && lastUnit <= 0xDBFF) cut -= 1;
  return message.slice(0, cut) + '\u2026';
}

export class AnthropicUpstreamSseError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AnthropicUpstreamSseError';
    this.responseCommitted = false;
    this.upstreamCode = details.code;
    this.upstreamType = details.type;
    this.upstreamStatusCode = details.status_code ?? details.status;
  }
}

function parseOpenAiSseFrame(frame) {
  const dataLines = [];
  let eventType = '';
  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    if (line === 'event') eventType = '';
    else if (line.startsWith('event:')) eventType = line.slice(6).replace(/^ /, '').trim();
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

function upstreamErrorFromItem(item, eventType = '') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const hasErrorProperty = 'error' in item;
  if (!hasErrorProperty && eventType.toLowerCase() !== 'error') return null;
  const details = hasErrorProperty && item.error && typeof item.error === 'object' && !Array.isArray(item.error)
    ? item.error
    : item;
  const message = sanitizeUpstreamErrorMessage(details.message);
  return new AnthropicUpstreamSseError(message, details);
}

// Does this parsed OpenAI SSE data item carry MEANINGFUL client-visible
// output? Contract B (2026-09-16 incident): failover is allowed until the
// first client-visible meaningful byte -” a delta with content/reasoning/
// role/tool_call/function_call, or a finish-bearing choice. Keepalive comment
// frames never reach here (the parser drops them) and empty/no-op deltas,
// usage-only frames, and bare id/object frames are NOT meaningful: they
// must not translate into a client event and must not commit the stream.
export function isOpenAiSseItemMeaningful(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!Array.isArray(data.choices)) return false;
  for (const choice of data.choices) {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) continue;
    if (choice.finish_reason) return true;
    const delta = choice.delta;
    if (!delta || typeof delta !== 'object' || Array.isArray(delta)) continue;
    if (typeof delta.content === 'string' && delta.content.length > 0) return true;
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) return true;
    if (typeof delta.role === 'string' && delta.role.length > 0) return true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
    if (delta.function_call && typeof delta.function_call === 'object') return true;
  }
  return false;
}

// Translate an OpenAI SSE stream into Anthropic SSE events (async generator)
export async function* translateAnthropicSseStream(openaiSseChunks, requestId, model, options = {}) {
  let started = false;
  // First non-empty upstream `model` seen on a pre-start item; message_start
  // is deferred until a MEANINGFUL item, so the hint may come from a
  // benign no-op frame that must never translate on its own.
  let modelHint = '';
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
  const frameBuffer = Buffer.allocUnsafe(MAX_INCOMPLETE_SSE_FRAME_BYTES + 4);
  let pendingFrameBytes = 0;
  let discardingOversizedFrame = false;
  // WHATWG SSE line state, kept across transport chunks.
  let atLineStart = true;
  let afterCarriageReturn = false;
  let malformedOrIncomplete = false;
  let stringHighSurrogateCarry = '';
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
    // Transport chunks are unrelated to SSE event boundaries. Decode byte
    // chunks incrementally (so a UTF-8 code point may span chunks), retain only
    // the current unterminated frame, and parse frames only after a blank-line
    // delimiter arrives. Object chunks remain supported for internal callers.
    const items = [];
    if (chunk !== null && typeof chunk === 'object' && !(chunk instanceof Uint8Array)) {
      if (pendingFrameBytes > 0 || discardingOversizedFrame) malformedOrIncomplete = true;
      items.push({ eventType: '', value: chunk });
    } else {
      let stringChunk = typeof chunk === 'string' ? chunk : null;
      if (stringChunk !== null) {
        stringChunk = stringHighSurrogateCarry + stringChunk;
        stringHighSurrogateCarry = '';
        const finalCodeUnit = stringChunk.charCodeAt(stringChunk.length - 1);
        if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) {
          stringHighSurrogateCarry = stringChunk.at(-1);
          stringChunk = stringChunk.slice(0, -1);
        }
      }
      let bytes;
      if (stringChunk !== null) {
        bytes = Buffer.from(stringChunk, 'utf8');
      } else {
        const byteChunk = chunk instanceof Uint8Array
          ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : Buffer.alloc(0);
        if (stringHighSurrogateCarry) {
          // A byte chunk cannot complete a UTF-16 code-unit pair. Preserve stream
          // order, flush the unmatched carry honestly, then consume unchanged bytes.
          bytes = Buffer.concat([Buffer.from(stringHighSurrogateCarry, 'utf8'), byteChunk]);
          stringHighSurrogateCarry = '';
        } else {
          bytes = byteChunk;
        }
      }
      for (const byte of bytes) {
        // WHATWG SSE framing: a line ends at CRLF, LF or CR, and an empty line
        // ends the frame. The LF of a CRLF is swallowed (also across chunks, via
        // afterCarriageReturn), so a frame ends on the blank line's first line-end
        // byte and a `\r` | `\n` split never yields an extra line or frame.
        if (byte === 10 && afterCarriageReturn) { afterCarriageReturn = false; continue; }
        afterCarriageReturn = byte === 13;
        const lineEnd = byte === 13 || byte === 10;
        const endsFrame = lineEnd && atLineStart;
        atLineStart = lineEnd;

        if (!endsFrame) {
          if (!discardingOversizedFrame && pendingFrameBytes < frameBuffer.length) {
            frameBuffer[pendingFrameBytes] = byte;
          }
          pendingFrameBytes++;
        }

        if (endsFrame) {
          // The frame's last line end (one stored CR or LF) is not frame content,
          // so the MAX_INCOMPLETE_SSE_FRAME_BYTES cap applies exactly as before.
          const lastByte = frameBuffer[pendingFrameBytes - 1];
          const frameBytes = pendingFrameBytes > 0 && pendingFrameBytes <= frameBuffer.length && (lastByte === 10 || lastByte === 13)
            ? pendingFrameBytes - 1
            : pendingFrameBytes;
          if (!discardingOversizedFrame && frameBytes <= MAX_INCOMPLETE_SSE_FRAME_BYTES) {
            const parsed = parseOpenAiSseFrame(frameBuffer.subarray(0, frameBytes).toString('utf8'));
            if (parsed.kind === 'item') items.push({ eventType: parsed.eventType, value: parsed.value });
            else if (parsed.kind === 'malformed') malformedOrIncomplete = true;
          } else {
            malformedOrIncomplete = true;
          }
          pendingFrameBytes = 0;
          discardingOversizedFrame = false;
        } else if (!discardingOversizedFrame && pendingFrameBytes > frameBuffer.length) {
          malformedOrIncomplete = true;
          discardingOversizedFrame = true;
        }
      }
    }

    if (items.length === 0) continue;

    for (const parsedItem of items) {
      const item = parsedItem.value;
      const eventType = parsedItem.eventType;
      // F4: [DONE] handling lives inside the item loop so message_start is
      // guaranteed to have been emitted before message_delta/message_stop.
      if (item === '[DONE]') {
        if (malformedOrIncomplete) {
          if (!started) throw new Error('Malformed upstream SSE event before completion');
          if (contentBlockStarted) {
            yield closeContentBlock();
            contentBlockStarted = false;
            currentBlockType = null;
            activeToolCallIndex = null;
          }
          // `started` is only true after a meaningful item emitted message_start,
          // so this is a post-commit break: tag it like the incomplete tail so the
          // caller drops the following message_stop and aborts (plan L1).
          options.incompleteTail = true;
          yield formatSse('error', {
            type: 'error',
            error: { type: 'api_error', message: 'Malformed upstream SSE event' },
          });
          yield formatSse('message_stop', {});
          return;
        }
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
      const upstreamError = upstreamErrorFromItem(data, eventType);
      if (upstreamError) {
        if (!started) throw upstreamError;
        if (contentBlockStarted) {
          yield closeContentBlock();
          contentBlockStarted = false;
          currentBlockType = null;
          activeToolCallIndex = null;
        }
        yield formatSse('error', {
          type: 'error',
          error: { type: 'api_error', message: upstreamError.message },
        });
        yield formatSse('message_stop', {});
        return;
      }
      if (!started) {
        if (!isOpenAiSseItemMeaningful(data)) {
          // 2026-09-16 incident: a benign no-op frame (empty delta, usage-only,
          // bare id/object) must not translate into a client event -” emitting
          // message_start here would commit the stream before meaningful
          // output exists and forfeit the pre-commit failover window. Absorb
          // the item silently (usage/finish_reason still update the eventual
          // message_start/stop) and keep its model hint.
          if (!modelHint && typeof data.model === 'string' && data.model) modelHint = data.model;
        } else {
          started = true;
          yield emitMessageStart(data.model || modelHint);
        }
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

  if (stringHighSurrogateCarry) {
    const replacementBytes = Buffer.from(stringHighSurrogateCarry, 'utf8');
    for (const byte of replacementBytes) {
      if (!discardingOversizedFrame && pendingFrameBytes < frameBuffer.length) frameBuffer[pendingFrameBytes] = byte;
      pendingFrameBytes++;
      if (!discardingOversizedFrame && pendingFrameBytes > frameBuffer.length) {
        malformedOrIncomplete = true;
        discardingOversizedFrame = true;
      }
    }
    stringHighSurrogateCarry = '';
  }

  // Owner 28.09 (Fix 1): a pending frame that is exactly one unterminated
  // `data: [DONE]` line at EOF is the normal end (SDK parsers accept it), so it
  // takes the regular message_delta/message_stop tail. Any other pending tail,
  // or a stream already marked malformed, keeps today's incomplete handling.
  let eofDone = false;
  if (!discardingOversizedFrame && !malformedOrIncomplete && pendingFrameBytes > 0 && pendingFrameBytes <= frameBuffer.length
    && /^data: ?\[DONE\]$/.test(frameBuffer.subarray(0, pendingFrameBytes).toString('utf8').replace(/^[\r\n]+|[\r\n]+$/g, ''))) {
    pendingFrameBytes = 0;
    eofDone = true;
  }

  if (discardingOversizedFrame || pendingFrameBytes > 0) malformedOrIncomplete = true;

  if (malformedOrIncomplete && !started) {
    throw new Error('Upstream SSE stream ended before a complete event');
  }

  // F4: tail block. If the stream produced no data chunks at all (empty stream,
  // or only keep-alive lines), message_start was never emitted -” emit it here
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
  if (!eofDone && (options.errorOnIncomplete === true || malformedOrIncomplete)) {
    // Explicit tag for the caller: the next two frames are the synthetic
    // incomplete-tail `error` + `message_stop` (not an upstream error frame).
    options.incompleteTail = true;
    yield formatSse('error', {
      type: 'error',
      error: { type: 'api_error', message: 'Upstream stream ended before completion' },
    });
    yield formatSse('message_stop', {});
    return;
  }
  yield formatSse('message_delta', { stop_reason: stopReason, stop_sequence: null, usage: { output_tokens: outputTokens } });
  yield formatSse('message_stop', {});
}
