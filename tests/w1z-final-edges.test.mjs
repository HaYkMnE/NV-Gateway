// @ts-check
/**
 * W1z final fix pass — three capability-probe edges.
 *
 *   1. mergeProbedReasoning: a POSITIVE probe on a family whose STATIC control is
 *      a chat_template_kwargs flag (qwen / stepfun-ai / minimaxai) must keep the
 *      static control, modes and default (the Anthropic adapter sends only the
 *      static ctk flag) and only set supported:true. Families driven by
 *      reasoning_effort (kimi-k3) keep advertising the probed modes.
 *   2. isEntryFresh: a probedAt far in the FUTURE is not fresh (clock-skew
 *      allowance of 5 minutes).
 *   3. resolveAdvertisedReasoning: a registry error must yield the
 *      non-authoritative `none`, so a negative cannot veto a static reasoner.
 *
 * No network: every entry is seeded through a cache file in the sandbox.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const sandbox = process.env.W1Z_TMP || os.tmpdir();
fs.mkdirSync(sandbox, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(sandbox, `w1z-${process.pid}-`));
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

process.env.GATEWAY_CAPABILITY_PROBE_DISABLE = '1';
process.env.GATEWAY_LOG_PATH = path.join(tempRoot, 'logs', 'gateway.jsonl');

const probe = await import(`${pathToFileURL(path.join(root, 'src/gateway/capability-probe.mjs')).href}?w1z=${Date.now()}`);
// Same URL the probe module imports, so registry state is shared.
const registry = await import(pathToFileURL(path.join(root, 'src/gateway/capability-registry.mjs')).href);

let seq = 0;
/** Seed a cache file with the given entries and point the probe at it. */
function seed(entries) {
    const file = path.join(tempRoot, `c${seq++}`, 'reasoning-capabilities.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 2, savedAt: new Date().toISOString(), entries }), 'utf8');
    probe.resetCapabilityProbeState({ cachePath: file });
}

function positive(overrides = {}) {
    return {
        source: 'probed', probedAt: Date.now(), supported: true,
        modes: ['low', 'high'], controlKey: 'reasoning_effort', defaultMode: 'high',
        ...overrides
    };
}

test.afterEach(() => {
    registry.resetCapabilityRegistry();
    probe.resetCapabilityProbeState({ cachePath: null });
});

test('fix 1: qwen + fresh positive probe keeps the static ctk control, modes and default', () => {
    const id = 'qwen/qwen3.5-397b-a17b';
    seed({ [id]: positive() });
    const caps = probe.mergeProbedReasoning(registry.getCapabilityMetadata(id), id);
    assert.deepEqual(caps.reasoning, {
        supported: true,
        modes: ['off', 'on'],
        controlKey: 'chat_template_kwargs.enable_thinking',
        defaultMode: 'on'
    });
});

test('fix 1: stepfun-ai and minimaxai keep their static ctk control under a positive probe', () => {
    /** @type {Array<{ id: string, controlKey: string, modes: string[], defaultMode: string }>} */
    const cases = [
        { id: 'stepfun-ai/step-3', controlKey: 'chat_template_kwargs.thinking', modes: ['off', 'on'], defaultMode: 'on' },
        { id: 'minimaxai/minimax-m2', controlKey: 'chat_template_kwargs.thinking_mode', modes: ['disabled', 'enabled'], defaultMode: 'enabled' }
    ];
    for (const { id, controlKey, modes, defaultMode } of cases) {
        seed({ [id]: positive() });
        const caps = probe.mergeProbedReasoning(registry.getCapabilityMetadata(id), id);
        assert.deepEqual(caps.reasoning, { supported: true, modes, controlKey, defaultMode }, id);
    }
});

test('fix 1: kimi-k3 + fresh positive probe still advertises the probed reasoning_effort modes', () => {
    const id = 'moonshotai/kimi-k3';
    seed({ [id]: positive() });
    const caps = probe.mergeProbedReasoning(registry.getCapabilityMetadata(id), id);
    assert.deepEqual(caps.reasoning, {
        supported: true, modes: ['low', 'high'], controlKey: 'reasoning_effort', defaultMode: 'high'
    });
});

test('fix 2: probedAt 10 days in the future is neither fresh nor authoritative', () => {
    const now = Date.now();
    const future = now + 10 * 24 * 60 * 60 * 1000;
    assert.equal(probe.isEntryFresh({ probedAt: future }, now), false);
    const id = 'moonshotai/kimi-k3';
    seed({ [id]: positive({ probedAt: future }) });
    assert.equal(probe.resolveAdvertisedReasoning(id).authoritative, false);
});

test('fix 2: probedAt 1 minute in the future is still fresh (clock-skew allowance)', () => {
    const now = Date.now();
    assert.equal(probe.isEntryFresh({ probedAt: now + 60_000 }, now), true);
    const id = 'moonshotai/kimi-k3';
    seed({ [id]: positive({ probedAt: Date.now() + 60_000 }) });
    assert.equal(probe.resolveAdvertisedReasoning(id).authoritative, true);
});

test('fix 3: a throwing registry makes a negative verdict non-authoritative', () => {
    // A function value cannot be structuredClone()d, so getReasoningCapability
    // throws for this family: a real, reachable registry error.
    registry.registerFamilyPatterns({
        w1zthrow: { reasoning: { supported: true, modes: ['low'], controlKey: 'reasoning_effort', boom: () => 0 } }
    });
    const id = 'w1zthrow/model';
    assert.throws(() => registry.getReasoningCapability(id));
    seed({ [id]: { source: 'probed', probedAt: Date.now(), supported: false, modes: [], controlKey: null, defaultMode: null } });
    assert.deepEqual(probe.resolveAdvertisedReasoning(id), {
        authoritative: false, supported: false, controlKey: null, modes: [], defaultMode: null
    });
});
