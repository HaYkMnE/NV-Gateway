/**
 * W6: a fresh POSITIVE probe may NARROW a curated MODEL_OVERRIDES mode list but
 * never EXPAND it (capability-probe resolveAdvertisedReasoning).
 *
 * Defect: the probe also tries "none"/"minimal"; minimaxai/minimax-m3.1-flash
 * accepts "none" with 200 but keeps reasoning. Before the fix a positive probe
 * replaced the curated modes, so /v1/models advertised "none" and Anthropic
 * thinking:disabled sent reasoning_effort:"none", a no-op, without a warning.
 *
 * Invariant: /v1/models (mergeProbedReasoning), chat (applyReasoningDefaults)
 * and Anthropic (translateAnthropicRequest) all give the same answer.
 * No network: entries are seeded through a cache file in a temp dir.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.GATEWAY_CAPABILITY_PROBE_DISABLE = '1';

const { translateAnthropicRequest } = await import('../src/gateway/anthropic-adapter.mjs');
const probe = await import('../src/gateway/capability-probe.mjs');
const registry = await import('../src/gateway/capability-registry.mjs');
const { applyReasoningDefaults } = await import('../src/gateway/reasoning-defaults.mjs');

const MINIMAX = 'minimaxai/minimax-m3.1-flash';
const KIMI = 'moonshotai/kimi-k3';
const MINIMAX_MODES = ['low', 'medium', 'high', 'xhigh', 'max'];
const KIMI_MODES = ['low', 'high', 'max'];

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `w6-${process.pid}-`));
test.after(() => {
    probe.resetCapabilityProbeState({ cachePath: null });
    registry.resetCapabilityRegistry();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});
test.afterEach(() => {
    registry.resetCapabilityRegistry();
    probe.resetCapabilityProbeState({ cachePath: null });
});

let seq = 0;
/** Seed one fresh positive probe entry for `id` with the given modes. */
function seedPositive(id, modes, defaultMode = 'high') {
    const file = path.join(tempRoot, `c${seq++}`, 'reasoning-capabilities.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry = { source: 'probed', probedAt: Date.now(), supported: true, modes, controlKey: 'reasoning_effort', defaultMode };
    fs.writeFileSync(file, JSON.stringify({ version: 2, savedAt: new Date().toISOString(), entries: { [id]: entry } }), 'utf8');
    probe.resetCapabilityProbeState({ cachePath: file });
}

const advertised = (id) => probe.mergeProbedReasoning(registry.getCapabilityMetadata(id), id).reasoning;
const anthropic = (id, thinking) => translateAnthropicRequest({
    model: id, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], thinking
});
const chat = (id) => applyReasoningDefaults({ model: id, messages: [{ role: 'user', content: 'hi' }] });
const hasDisableWarning = (r) => r.warnings.some((w) => /thinking cannot be disabled/.test(w));

test('W6a. minimax + probe incl. none/minimal: curated 5 modes, default high; disabled sends nothing and warns; chat injects nothing', () => {
    seedPositive(MINIMAX, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(advertised(MINIMAX), {
        supported: true, modes: MINIMAX_MODES, controlKey: 'reasoning_effort', defaultMode: 'high'
    });
    const off = anthropic(MINIMAX, { type: 'disabled' });
    assert.deepEqual(off.errors, []);
    assert.ok(!('reasoning_effort' in off.openaiBody), `no effort must be sent, got ${off.openaiBody.reasoning_effort}`);
    assert.ok(!('chat_template_kwargs' in off.openaiBody));
    assert.ok(hasDisableWarning(off), `disable warning expected, got ${JSON.stringify(off.warnings)}`);
    const on = anthropic(MINIMAX, { type: 'enabled' });
    assert.equal(on.openaiBody.reasoning_effort, 'high');
    assert.ok(!('reasoning_effort' in chat(MINIMAX)), 'chat facade injects nothing for minimax');
});

test('W6b. minimax + probe [low, high]: narrowed to [low, high]; a max-level budget is clamped into it', () => {
    seedPositive(MINIMAX, ['low', 'high']);
    assert.deepEqual(advertised(MINIMAX), {
        supported: true, modes: ['low', 'high'], controlKey: 'reasoning_effort', defaultMode: 'high'
    });
    const r = anthropic(MINIMAX, { type: 'enabled', budget_tokens: 40000 });
    assert.deepEqual(r.errors, []);
    assert.equal(r.openaiBody.reasoning_effort, 'high', 'max budget clamps to the highest advertised mode');
});

test('W6b2. minimax + probe [low, medium]: curated default high is gone, the shared clamp picks from the intersection', () => {
    seedPositive(MINIMAX, ['low', 'medium'], 'high');
    const adv = advertised(MINIMAX);
    assert.deepEqual(adv.modes, ['low', 'medium']);
    assert.equal(adv.defaultMode, probe.resolveDefaultMode(['low', 'medium'], 'high'));
    assert.equal(anthropic(MINIMAX, { type: 'enabled' }).openaiBody.reasoning_effort, adv.defaultMode);
});

test('W6c. minimax + probe [none, minimal] only: empty intersection keeps the curated object unchanged', () => {
    seedPositive(MINIMAX, ['none', 'minimal'], 'minimal');
    const curated = registry.getCuratedReasoningOverride(MINIMAX);
    assert.deepEqual(advertised(MINIMAX), {
        supported: true, modes: curated?.modes, controlKey: curated?.controlKey, defaultMode: curated?.defaultMode
    });
    const off = anthropic(MINIMAX, { type: 'disabled' });
    assert.ok(!('reasoning_effort' in off.openaiBody));
    assert.ok(hasDisableWarning(off));
});

test('W6d. kimi-k3 + probe [low, high, max, none]: none not advertised; chat default and Anthropic match /v1/models', () => {
    seedPositive(KIMI, ['low', 'high', 'max', 'none'], 'max');
    const adv = advertised(KIMI);
    assert.deepEqual(adv, { supported: true, modes: KIMI_MODES, controlKey: 'reasoning_effort', defaultMode: 'high' },
        'curated default high is still offered, so it wins over the probed max');
    assert.equal(chat(KIMI).reasoning_effort, adv.defaultMode);
    assert.equal(anthropic(KIMI, { type: 'enabled' }).openaiBody.reasoning_effort, adv.defaultMode);
    const off = anthropic(KIMI, { type: 'disabled' });
    assert.ok(!('reasoning_effort' in off.openaiBody), 'no "none" no-op is sent');
    assert.ok(hasDisableWarning(off));
});

test('W6e. non-curated models keep today\'s behaviour: the probed modes are advertised as-is', () => {
    for (const id of ['w6unknown/some-model', 'deepseek-ai/deepseek-w6-test']) {
        assert.equal(registry.getCuratedReasoningOverride(id), null, id);
        seedPositive(id, ['none', 'low', 'high']);
        assert.deepEqual(advertised(id), {
            supported: true, modes: ['none', 'low', 'high'], controlKey: 'reasoning_effort', defaultMode: 'high'
        }, id);
        assert.equal(anthropic(id, { type: 'disabled' }).openaiBody.reasoning_effort, 'none', id);
    }
});

test('W6f. getCuratedReasoningOverride: exact ids only, case-insensitive, returns a clone', () => {
    assert.deepEqual(registry.getCuratedReasoningOverride('MiniMaxAI/MiniMax-M3.1-Flash')?.modes, MINIMAX_MODES);
    assert.equal(registry.getCuratedReasoningOverride('minimaxai/minimax-m3'), null);
    assert.equal(registry.getCuratedReasoningOverride(undefined), null);
    const a = registry.getCuratedReasoningOverride(KIMI);
    a?.modes.push('none');
    assert.deepEqual(registry.getCuratedReasoningOverride(KIMI)?.modes, KIMI_MODES);
});
