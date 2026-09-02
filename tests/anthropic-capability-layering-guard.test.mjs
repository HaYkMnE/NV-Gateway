import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { translateAnthropicRequest } from '../src/gateway/anthropic-adapter.mjs';
import { resetCapabilityProbeState } from '../src/gateway/capability-probe.mjs';
import { registerFamilyPatterns, resetCapabilityRegistry } from '../src/gateway/capability-registry.mjs';

// Independent-verifier additions (adversarial gate on 5589600). These pin two
// behaviors the shipped suite leaves as EQUIVALENT MUTANTS, measured via a
// mutation harness against a scratch copy of the adapter:
//
//  1. anthropic-adapter.mjs:373 `{ ...staticCap, supported: true }` — the
//     `supported: true` override is unreachable from the built-in seed (every
//     family with a non-reasoning_effort control already has supported:true),
//     so deleting it changed nothing. A config-REGISTERED family can have
//     supported:false + a chat_template_kwargs control; only the override
//     lets a positive probe unlock it without renaming its control.
//  2. anthropic-adapter.mjs:45 `entry.supported !== true -> null` — for a
//     family ON the keep-static branch (373), a negative probe is masked by
//     that branch in the shipped tests (their negative halves never fail
//     under any mutation tried). On a supported:false registered family the
//     filter is the ONLY thing stopping a negative probe from becoming an
//     unlock via the forced `supported: true`.

const tempRoot = fs.mkdtempSync(path.join('C:\\OPENCODE-SANDBOX', 'nv-capability-guard-'));
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
    savedAt: '2026-09-02T00:00:00.000Z',
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

// A family the built-in seed cannot produce: statically known, statically
// NON-reasoning, but with a real chat_template_kwargs control (shape mirrors
// stepfun-ai). Only registerFamilyPatterns (config override) reaches it.
const GUARD_MODEL = 'qavfam/guard-1';

function registerGuardFamily() {
  registerFamilyPatterns({
    qavfam: {
      reasoning: {
        supported: false,
        modes: [],
        controlKey: 'chat_template_kwargs.thinking',
        type: 'boolean',
        enableValue: true,
        disableValue: false,
        defaultMode: 'on',
      },
      tools: true,
      vision: false,
      audio: false,
    },
  });
}

test('positive probe unlocks a supported:false static-control family WITHOUT renaming its control', () => {
  registerGuardFamily();
  // Deliberately omits controlKey: the reader derives 'reasoning_effort' from
  // modes (the shape a real all-accepted probe produces). The unlock must come
  // from the keep-static branch's `supported: true`, not from the probe's key.
  seedProbe(GUARD_MODEL, { supported: true, modes: ['none', 'low', 'high'] });

  const enabled = translate(GUARD_MODEL, 'enabled');
  assert.deepEqual(enabled.errors, []);
  assert.equal(enabled.openaiBody?.chat_template_kwargs?.thinking, true,
    'the static control must be switched ON; the probe may unlock but not rename it');
  assert.ok(!('reasoning_effort' in enabled.openaiBody),
    'reasoning_effort is a no-op field for this family; sending it renames the switch');

  seedProbe(GUARD_MODEL, { supported: true, modes: ['none', 'low', 'high'] });
  const disabled = translate(GUARD_MODEL, 'disabled');
  assert.deepEqual(disabled.errors, []);
  assert.equal(disabled.openaiBody?.chat_template_kwargs?.thinking, false,
    'the static control must be switched OFF through the unlocked family branch');
  assert.ok(!('reasoning_effort' in disabled.openaiBody));
});

test('negative probe neither unlocks nor vetoes a supported:false static-control family', () => {
  registerGuardFamily();
  seedProbe(GUARD_MODEL, { supported: false, modes: [] });

  const enabled = translate(GUARD_MODEL, 'enabled');
  assert.ok(enabled.errors.some(e => e.includes('does not support thinking')),
    'a negative reasoning_effort probe is not an unlock; static knowledge stands');
  assert.equal(enabled.openaiBody, null);

  // Same family, no probe at all: identical refusal (the negative probe added
  // no new veto and removed none either).
  resetCapabilityProbeState({ cachePath: null });
  const noProbe = translate(GUARD_MODEL, 'enabled');
  assert.ok(noProbe.errors.some(e => e.includes('does not support thinking')));
  assert.equal(noProbe.openaiBody, null);
});
