import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { translateAnthropicRequest } from '../src/gateway/anthropic-adapter.mjs';
import { resetCapabilityProbeState } from '../src/gateway/capability-probe.mjs';
import { registerFamilyPatterns, resetCapabilityRegistry } from '../src/gateway/capability-registry.mjs';

// Honesty gate for `thinking: { type: 'disabled' }`: a family that CANNOT
// express "thinking off" (no 'none' mode, no chat_template_kwargs control, no
// alternate control) must surface an explicit warning instead of silently
// forwarding a body with no disable signal (upstream default keeps thinking
// ON while the user believes it is OFF). Measured defect: moonshotai/* (modes
// ['low','high','max']) returned {"keys":["model","messages","max_tokens"],
// "warnings":[],"errors":[]} for an explicit disable.
//
// The warning text is engine output crossing the API boundary (server.mjs
// logs the warnings array); the two pinned fragments below are the contract.

const WARN_CANNOT_DISABLE = 'cannot be disabled';
const WARN_NO_EFFECT = 'no effect';

const tempRoot = fs.mkdtempSync(path.join('C:\\OPENCODE-SANDBOX', 'nv-honesty-'));
let fixtureSequence = 0;

test.after(() => {
  resetCapabilityProbeState({ cachePath: null });
  resetCapabilityRegistry();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function seedProbe(modelId, entry) {
  const cachePath = path.join(tempRoot, `probe-${fixtureSequence++}.json`);
  fs.writeFileSync(cachePath, JSON.stringify({
    version: 2,
    savedAt: '2026-09-03T00:00:00.000Z',
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

function noCacheAndCleanRegistry() {
  resetCapabilityProbeState({ cachePath: null });
  resetCapabilityRegistry();
}

function translateDisabled(model) {
  return translateAnthropicRequest({
    model,
    max_tokens: 100,
    messages: [{ role: 'user', content: 'Hello.' }],
    thinking: { type: 'disabled' },
  });
}

function honestyWarning(r) {
  return r.warnings.find(w => w.includes(WARN_CANNOT_DISABLE));
}

function assertHonestyWarning(r, label) {
  const w = honestyWarning(r);
  assert.ok(w, `${label}: expected a warning containing "${WARN_CANNOT_DISABLE}", got ${JSON.stringify(r.warnings)}`);
  assert.ok(w.includes(WARN_NO_EFFECT), `${label}: warning must state the setting had no effect, got ${JSON.stringify(w)}`);
}

function assertNoHonestyWarning(r, label) {
  assert.ok(!honestyWarning(r),
    `${label}: a family that DID switch thinking off must not cry wolf, got ${JSON.stringify(r.warnings)}`);
}

function assertNoReasoningFields(r, label) {
  assert.ok(!('reasoning_effort' in r.openaiBody),
    `${label}: a fake reasoning_effort control must NOT be synthesized, got ${JSON.stringify(Object.keys(r.openaiBody))}`);
  assert.ok(!('chat_template_kwargs' in r.openaiBody),
    `${label}: a fake chat_template_kwargs control must NOT be synthesized, got ${JSON.stringify(Object.keys(r.openaiBody))}`);
}

// --- 1. The measured defect: moonshotai has no off mode ---------------------

test('moonshotai (modes low/high/max, no alternate) + thinking:disabled warns instead of silently no-oping', () => {
  noCacheAndCleanRegistry();
  const r = translateDisabled('moonshotai/kimi-k3');
  assert.deepEqual(r.errors, []);
  assert.ok(r.openaiBody, 'the request must still translate — warning, not rejection');
  assertNoReasoningFields(r, 'moonshotai');
  assertHonestyWarning(r, 'moonshotai');
  // The rest of the body is untouched: thinking proceeds under upstream default.
  assert.equal(r.openaiBody.model, 'moonshotai/kimi-k3');
  assert.equal(r.openaiBody.max_tokens, 100);
  assert.equal(r.openaiBody.messages.length, 1);
});

// --- 2. Families that CAN express "off" stay quiet ---------------------------

test('deepseek-ai (modes include none) + disabled emits reasoning_effort none with NO honesty warning', () => {
  noCacheAndCleanRegistry();
  const r = translateDisabled('deepseek-ai/deepseek-v3.2');
  assert.deepEqual(r.errors, []);
  assert.equal(r.openaiBody.reasoning_effort, 'none');
  assertNoHonestyWarning(r, 'deepseek-ai');
});

test('z-ai (both controls) + disabled emits none + enable_thinking=false with NO honesty warning', () => {
  noCacheAndCleanRegistry();
  const r = translateDisabled('z-ai/glm-4.5');
  assert.deepEqual(r.errors, []);
  assert.equal(r.openaiBody.reasoning_effort, 'none');
  assert.equal(r.openaiBody.chat_template_kwargs?.enable_thinking, false);
  assertNoHonestyWarning(r, 'z-ai');
});

test('qwen (chat_template_kwargs control) + disabled emits enable_thinking=false with NO honesty warning', () => {
  noCacheAndCleanRegistry();
  const r = translateDisabled('qwen/qwen3.5-397b-a17b');
  assert.deepEqual(r.errors, []);
  assert.equal(r.openaiBody.chat_template_kwargs?.enable_thinking, false);
  assert.ok(!('reasoning_effort' in r.openaiBody));
  assertNoHonestyWarning(r, 'qwen');
});

test('registered alternate-only family (no none-mode primary) + disabled emits enable_thinking=false with NO honesty warning', () => {
  noCacheAndCleanRegistry();
  registerFamilyPatterns({
    altm: {
      reasoning: {
        supported: true,
        modes: ['low', 'high'], // primary control exists but cannot express "off"
        controlKey: 'reasoning_effort',
        alternateControl: { key: 'chat_template_kwargs.enable_thinking', type: 'boolean', enableValue: true, disableValue: false },
        defaultMode: 'high',
      },
      tools: true,
      vision: false,
      audio: false,
    },
  });
  const r = translateDisabled('altm/model-z');
  assert.deepEqual(r.errors, []);
  assert.ok(!('reasoning_effort' in r.openaiBody), 'altm: no "none" mode, primary must emit nothing');
  assert.equal(r.openaiBody.chat_template_kwargs?.enable_thinking, false, 'altm: the alternate control must carry the disable');
  assertNoHonestyWarning(r, 'altm');
});

// --- 3. The other silence paths (probe-measured / config-registered) ---------

test('probed "reasons but no usable control" entry on an unknown family + disabled warns', () => {
  resetCapabilityRegistry();
  // The exact shape capability-probe.mjs writes when a model emits
  // reasoning_content while rejecting every reasoning_effort candidate.
  seedProbe('uncachedthinker/model-x', { supported: true, modes: [], controlKey: null });
  const r = translateDisabled('uncachedthinker/model-x');
  assert.deepEqual(r.errors, []);
  assert.ok(r.openaiBody);
  assertNoReasoningFields(r, 'probed-no-control');
  assertHonestyWarning(r, 'probed-no-control');
});

test('config-registered family with supported:true, no modes and no control + disabled warns', () => {
  noCacheAndCleanRegistry();
  registerFamilyPatterns({
    ctlnone: {
      reasoning: { supported: true, modes: [], controlKey: null },
      tools: true,
      vision: false,
      audio: false,
    },
  });
  const r = translateDisabled('ctlnone/model-y');
  assert.deepEqual(r.errors, []);
  assert.ok(r.openaiBody);
  assertNoReasoningFields(r, 'registered-no-control');
  assertHonestyWarning(r, 'registered-no-control');
});

// --- 3b. Unknown family: the enabled path warns optimistically, disabled must too ---

test('unknown family (no registry entry, no probe evidence) + disabled warns instead of silently forwarding', () => {
  noCacheAndCleanRegistry();
  const r = translateDisabled('totally-unknown-lab/fictional-7b');
  assert.deepEqual(r.errors, []);
  assert.ok(r.openaiBody, 'the request must still translate — warning, not rejection');
  assertNoReasoningFields(r, 'unknown-family');
  assertHonestyWarning(r, 'unknown-family');
});

// --- 4. Boundaries deliberately left silent ----------------------------------

test('a family KNOWN not to reason (meta) + disabled stays silent: there is nothing to switch off', () => {
  noCacheAndCleanRegistry();
  const r = translateDisabled('meta/llama-4-maverick-17b-128e-instruct');
  assert.deepEqual(r.errors, []);
  assert.ok(r.openaiBody);
  assertNoReasoningFields(r, 'meta');
  assertNoHonestyWarning(r, 'meta');
});

// --- 5. The enable path is untouched -----------------------------------------

test('moonshotai + thinking:enabled still maps to its default reasoning_effort (max)', () => {
  noCacheAndCleanRegistry();
  const r = translateAnthropicRequest({
    model: 'moonshotai/kimi-k3',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'Hello.' }],
    thinking: { type: 'enabled' },
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.openaiBody.reasoning_effort, 'max');
  assertNoHonestyWarning(r, 'moonshotai-enabled');
});
