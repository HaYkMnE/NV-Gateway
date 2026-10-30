/**
 * W1b adapter regressions (Level-1 fix wave, pass 2).
 *
 *  5. `echoesAssistantReasoning` matched the WHOLE `deepseek-ai/*` family, so
 *     `deepseek-ai/deepseek-r1` was sent prior `reasoning_content` even though
 *     its contract answers 400 for that field. The allowlist is narrowed to the
 *     VERIFIED `deepseek-v4*` generation; R1 keeps the drop-with-warning path.
 *
 *  6. `CREDENTIAL_PAIR` redacted the first word after ANY credential-ish key, so
 *     actionable prose lost its meaning ("Invalid api_key: the provided value is
 *     too short" -> "api_key: [REDACTED] provided value...") and even a token
 *     COUNT was hidden ("Value token = 5"). Only credential-SHAPED values may be
 *     redacted.
 *
 * Pure adapter tests: no network, no secrets (all tokens are synthetic).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeUpstreamErrorMessage, translateAnthropicRequest } from '../src/gateway/anthropic-adapter.mjs';
import { resetCapabilityProbeState } from '../src/gateway/capability-probe.mjs';
import { resetCapabilityRegistry } from '../src/gateway/capability-registry.mjs';

function translate(model, extra = {}) {
  resetCapabilityProbeState({ cachePath: null });
  resetCapabilityRegistry();
  return translateAnthropicRequest({
    model,
    max_tokens: 100,
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'prior reasoning' },
        { type: 'text', text: 'visible answer' }
      ]
    }],
    ...extra
  });
}

// ── Defect 5: the echo allowlist is per GENERATION, not per family ────────────

test('defect 5: deepseek-v4* still echoes prior reasoning', () => {
  for (const model of ['deepseek-ai/deepseek-v4.1-flash', 'deepseek-ai/deepseek-v4']) {
    const r = translate(model);
    assert.deepEqual(r.errors, []);
    assert.equal(r.openaiBody.messages[0].reasoning_content, 'prior reasoning', model);
    assert.equal(r.warnings.some((w) => /thinking/.test(w)), false, model);
  }
});

test('defect 5: deepseek-r1 receives NO reasoning_content (its contract rejects the field)', () => {
  const r = translate('deepseek-ai/deepseek-r1');
  assert.deepEqual(r.errors, []);
  const [message] = r.openaiBody.messages;
  assert.equal(message.content, 'visible answer');
  assert.equal('reasoning_content' in message, false, 'R1 must not receive an echoed reasoning field');
  assert.ok(r.warnings.some((w) => /thinking/.test(w)), 'the drop must stay diagnosable');
});

test('defect 5: Kimi K3 and z-ai are unaffected by the narrowing', () => {
  for (const model of ['moonshotai/kimi-k3', 'z-ai/glm-5.3']) {
    const r = translate(model);
    assert.equal(r.openaiBody.messages[0].reasoning_content, 'prior reasoning', model);
  }
});

// ── Defect 6: only credential-SHAPED values are redacted ─────────────────────

test('defect 6: actionable prose keeps its words (no over-redaction)', () => {
  for (const clean of [
    'Invalid api_key: the provided value is too short',
    'Value token = 5',
    'secret: rotation failed after 3 attempts',
    'password: expired'
  ]) {
    assert.equal(sanitizeUpstreamErrorMessage(clean), clean);
  }
});

test('defect 6: real credential values are still redacted', () => {
  for (const [raw, secret] of [
    ['x-api-key: sk-live-abcdef123456789 rejected', 'sk-live-abcdef123456789'],
    ['upstream rejected api_key=sk-live-abcdef123456789', 'sk-live-abcdef123456789'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA== failed', 'dXNlcjpwYXNzd29yZA'],
    ['cookie: session=abcdef123456789 failed', 'abcdef123456789'],
    ['token: a1b2c3d4e5f6', 'a1b2c3d4e5f6']
  ]) {
    const out = sanitizeUpstreamErrorMessage(raw);
    assert.equal(out.includes(secret), false, `${raw} -> ${out}`);
    // Every actionable WORD the upstream wrote must survive redaction (the last
    // fixture carries no verb, so the property is "present verbs survive").
    for (const verb of raw.match(/reject(?:ed)?|fail(?:ed)?/gi) ?? []) {
      assert.equal(out.toLowerCase().includes(verb.toLowerCase()), true, `the actionable verb "${verb}" must survive: ${out}`);
    }
  }
});

// -- Defect 6 (pass 3): quoted / JSON / long-alnum credential values ---------
//
// MEASURED before this fix: the value class `[^\s,;"'`]+` could not START on a
// quote, so a quoted credential survived byte-identically (`x-api-key: "sk-live-..."`,
// `api_key: '...'`, `{"api_key":"..."}`), and a >=8-char pure-lowercase value
// failed every shape marker (`api_key: abcdefghijklmnop`). Both reached the
// client. The prose guards from pass 2 must keep working unchanged.

test('defect 6: a QUOTED credential value is redacted in all three quoting styles', () => {
  for (const [raw, secret] of [
    ['x-api-key: "sk-live-abcdef123456" rejected', 'sk-live-abcdef123456'],
    ["api_key: 'sk-live-abcdef123456' rejected", 'sk-live-abcdef123456'],
    ['{"api_key":"sk-live-abcdef123456"} rejected', 'sk-live-abcdef123456']
  ]) {
    const out = sanitizeUpstreamErrorMessage(raw);
    assert.equal(out.includes(secret), false, `${raw} -> ${out}`);
    assert.match(out, /reject/i, `the actionable verb must survive: ${out}`);
  }
});

test('defect 6: a long pure-lowercase alnum value after a credential key is shaped', () => {
  const out = sanitizeUpstreamErrorMessage('api_key: abcdefghijklmnop rejected');
  assert.equal(out.includes('abcdefghijklmnop'), false, out);
  assert.match(out, /reject/i, `the actionable verb must survive: ${out}`);
});

test('defect 6: the pass-2 prose guards still survive verbatim', () => {
  for (const clean of [
    'Invalid api_key: the provided value is too short',
    'Value token = 5',
    'secret: rotation failed after 3 attempts'
  ]) {
    assert.equal(sanitizeUpstreamErrorMessage(clean), clean, clean);
  }
});

// -- Defect 5 (pass 3): prose keeps its punctuation --------------------------
//
// The path-anchored scrub used to match `/2?` inside ordinary prose, so
// `invalid ratio 1/2? expected an integer` lost the `?` and became
// `1/2 expected`. The rule must only fire on a PATH-like token.

test('defect 5: prose after a slash keeps its punctuation', () => {
  for (const clean of [
    'invalid ratio 1/2? expected an integer',
    'why? because upstream said no',
    'error#42 occurred',
    'model not found #404'
  ]) {
    assert.equal(sanitizeUpstreamErrorMessage(clean), clean, clean);
  }
});
