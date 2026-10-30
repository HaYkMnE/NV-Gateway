// @ts-check
/**
 * W1g fix pass 2 — capability-probe invariants that the W1f pass left open.
 *
 *   1. A FULLY inconclusive sweep (every candidate 429/5xx/network, i.e. zero
 *      accepted responses) must never turn a proven `supported:true` into a
 *      negative finding. The documented invariant is "a transient upstream
 *      failure must never erase known-good", and `reconcileWithPrevious` only
 *      protected `modes` — not the verdict itself.
 *   2. The reasoning marker is injected INTO THE PROMPT, so a model/upstream
 *      that echoes the prompt into `reasoning_content` proved nothing. Support
 *      now requires the COMPUTED answer (the marker reversed), which a verbatim
 *      echo cannot contain.
 *   3. `mergeProbedReasoning` must not advertise `modes` for an unsupported
 *      entry: `/v1/models` would otherwise offer modes with no control key.
 *
 * All upstream traffic is mocked through an injected requestImpl — NO network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const sandbox = process.env.W1G_TMP || os.tmpdir();
fs.mkdirSync(sandbox, { recursive: true });
const fileTempRoot = fs.mkdtempSync(path.join(sandbox, `w1g-probe-${process.pid}-`));
test.after(() => fs.rmSync(fileTempRoot, { recursive: true, force: true }));

process.env.GATEWAY_CAPABILITY_PROBE_DISABLE = '1';
process.env.GATEWAY_LOG_PATH = path.join(fileTempRoot, 'unit-logs', 'gateway.jsonl');

const probe = await import(`${pathToFileURL(path.join(root, 'src/gateway/capability-probe.mjs')).href}?w1g=${Date.now()}`);

function jsonResponse(status, body) {
    return { status, text: typeof body === 'string' ? body : JSON.stringify(body), parsed: typeof body === 'string' ? null : body };
}

function listing400(accepted) {
    const quoted = accepted.map((m) => `'${m}'`).join(', ');
    return jsonResponse(400, {
        error: {
            message: `Invalid value for 'reasoning_effort': expected one of ${quoted}, but got 'bogus_probe'.`,
            type: 'invalid_request_error'
        }
    });
}

/** A 2xx that carries the probe's COMPUTED answer: real reasoning happened. */
function reasonedAccepted() {
    return jsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'ok', reasoning_content: `reversed -> ${probe.PROBE_REASONING_ANSWER}` } }]
    });
}

function cacheFile(label) {
    return path.join(fileTempRoot, label, 'reasoning-capabilities.json');
}

const CANDIDATES = ['low', 'medium', 'high'];

// ---------------------------------------------------------------------------
// Finding 2 — a verbatim prompt echo is not reasoning
// ---------------------------------------------------------------------------

test('finding 2: a verbatim echo of the PROMPT into reasoning_content is NOT reasoning support', async () => {
    // The upstream copies the user message (which contains the marker) into
    // reasoning_content and adds nothing. That is the reproduced false positive:
    // the marker is part of the prompt, so the echo always contains it.
    const seen = [];
    const impl = async (args) => {
        const body = JSON.parse(args.body);
        seen.push(body);
        if (body.reasoning_effort === probe.PROBE_SENTINEL) return jsonResponse(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
        return jsonResponse(200, {
            choices: [{
                message: {
                    role: 'assistant',
                    content: 'ok',
                    reasoning_content: `The user said: ${body.messages[0].content}`
                }
            }]
        });
    };
    const entry = await probe.discoverReasoningModes('echo/model', { apiKey: 'k', candidates: CANDIDATES, requestImpl: impl });
    // One silent sweep is held (2-strike downgrade); the second publishes.
    assert.equal(entry, null, 'a single silent sweep must not publish a verdict');
    const verdict = await probe.discoverReasoningModes('echo/model', { apiKey: 'k', candidates: CANDIDATES, requestImpl: impl });
    assert.ok(verdict);
    assert.equal(verdict.supported, false, 'copying the prompt is not computing anything');
    assert.equal(verdict.controlKey, null);
    assert.match(verdict.evidence, /no reasoning output observed/);
    // The answer is never part of the prompt, so an echo cannot contain it.
    for (const body of seen) {
        assert.equal(body.messages[0].content.includes(probe.PROBE_REASONING_ANSWER), false,
            'the prompt must carry only the transformation INPUT, never the answer');
    }
});

test('finding 2: the COMPUTED answer in reasoning proves support; a bare marker does not', async () => {
    const impl = (args) => {
        const body = JSON.parse(args.body);
        if (body.reasoning_effort === probe.PROBE_SENTINEL) return listing400(['low', 'high']);
        if (body.reasoning_effort === 'low') return reasonedAccepted();
        // 'high' echoes only the raw marker (input), no transformed result.
        return jsonResponse(200, {
            choices: [{ message: { role: 'assistant', content: 'ok', reasoning_content: `token ${probe.PROBE_REASONING_MARKER}` } }]
        });
    };
    const entry = await probe.discoverReasoningModes('computed/model', { apiKey: 'k', requestImpl: impl });
    assert.deepEqual(entry.modes, ['low', 'high']);
    assert.equal(entry.supported, true, 'one reply carried the computed answer');
    assert.equal(entry.controlKey, 'reasoning_effort');
});

test('finding 2: no reasoning output at all is not support', async () => {
    const impl = (args) => {
        const body = JSON.parse(args.body);
        if (body.reasoning_effort === probe.PROBE_SENTINEL) return listing400(['low']);
        return jsonResponse(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    };
    // 2-strike: the FIRST silent sweep is held, the SECOND is the finding.
    assert.equal(await probe.discoverReasoningModes('silent/model', { apiKey: 'k', requestImpl: impl }), null);
    const entry = await probe.discoverReasoningModes('silent/model', { apiKey: 'k', requestImpl: impl });
    assert.equal(entry.supported, false);
    assert.equal(entry.controlKey, null);
});

test('finding 2: the prompt marker stays random per process and is the reversal INPUT', () => {
    assert.match(probe.PROBE_REASONING_MARKER, /^NVPROBE-[0-9a-f]{16}$/);
    assert.equal(probe.PROBE_REASONING_ANSWER, [...probe.PROBE_REASONING_MARKER].reverse().join(''));
    assert.notEqual(probe.PROBE_REASONING_ANSWER, probe.PROBE_REASONING_MARKER);
    const body = JSON.parse(probe.buildProbeBody('a/b', 'low'));
    assert.ok(body.messages[0].content.includes(probe.PROBE_REASONING_MARKER));
    assert.equal(body.messages[0].content.includes(probe.PROBE_REASONING_ANSWER), false);
});

// ---------------------------------------------------------------------------
// Finding 1 — a fully inconclusive sweep never erases known-good
// ---------------------------------------------------------------------------

/** sentinel 200 (accepted, no reasoning) then a per-candidate responder. */
function sentinelAcceptedThen(perCandidate) {
    return (args) => {
        const body = JSON.parse(args.body);
        if (body.reasoning_effort === probe.PROBE_SENTINEL) {
            return jsonResponse(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
        }
        return perCandidate(body.reasoning_effort);
    };
}

test('finding 1: good probe then an ALL-429 sweep keeps the proven supported:true entry', async () => {
    const cachePath = cacheFile('all-429');
    probe.resetCapabilityProbeState({ cachePath });
    const good = await probe.probeAndCacheReasoningModes('keep/model', {
        apiKey: 'k',
        requestImpl: (args) => {
            const body = JSON.parse(args.body);
            if (body.reasoning_effort === probe.PROBE_SENTINEL) return listing400(['low', 'high']);
            return reasonedAccepted();
        }
    });
    assert.equal(good.supported, true);
    assert.deepEqual(good.modes, ['low', 'high']);

    // Every candidate 429: zero accepted, zero rejected — PROVES NOTHING.
    const all429 = sentinelAcceptedThen(() => jsonResponse(429, { error: { message: 'rate limited' } }));
    const second = await probe.probeAndCacheReasoningModes('keep/model', { apiKey: 'k', requestImpl: all429, force: true });
    assert.equal(second, null, 'a fully inconclusive sweep reports inconclusive, not a verdict');

    const cached = probe.getCachedReasoningCapability('keep/model');
    assert.equal(cached.supported, true, 'known-good must survive a transient upstream failure');
    assert.deepEqual(cached.modes, ['low', 'high']);
    assert.equal(cached.controlKey, 'reasoning_effort');

    const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
    probe.mergeProbedReasoning(caps, 'keep/model');
    assert.deepEqual(caps.reasoning.modes, ['low', 'high'], '/v1/models keeps advertising the known-good modes');
    assert.equal(caps.reasoning.controlKey, 'reasoning_effort');
});

test('finding 1: a COLD all-429 sweep stays UNKNOWN — no false negative is cached', async () => {
    const cachePath = cacheFile('cold-429');
    probe.resetCapabilityProbeState({ cachePath });
    const impl = sentinelAcceptedThen(() => jsonResponse(429, { error: { message: 'rate limited' } }));
    const entry = await probe.probeAndCacheReasoningModes('cold/model', { apiKey: 'k', requestImpl: impl });
    assert.equal(entry, null, 'nothing was proven, so nothing is reported');
    assert.equal(probe.getCachedReasoningCapability('cold/model'), null, 'no negative entry may be written');
    assert.equal(fs.existsSync(cachePath), false, 'an inconclusive sweep must not persist anything');

    // The static fallback stays authoritative, untouched.
    const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
    probe.mergeProbedReasoning(caps, 'cold/model');
    assert.deepEqual(caps.reasoning.modes, ['off', 'on']);
    assert.equal(caps.reasoning.controlKey, 'chat_template_kwargs.thinking');
});

test('finding 1: a MIXED sweep (accepted + inconclusive) keeps support and the known modes', async () => {
    const cachePath = cacheFile('mixed');
    probe.resetCapabilityProbeState({ cachePath });
    await probe.probeAndCacheReasoningModes('mix/model', {
        apiKey: 'k',
        requestImpl: (args) => {
            const body = JSON.parse(args.body);
            if (body.reasoning_effort === probe.PROBE_SENTINEL) return listing400(['low', 'high']);
            return reasonedAccepted();
        }
    });
    const mixed = sentinelAcceptedThen((effort) => (effort === 'low'
        ? reasonedAccepted()
        : jsonResponse(503, { error: { message: 'upstream burning' } })));
    const entry = await probe.probeAndCacheReasoningModes('mix/model', { apiKey: 'k', requestImpl: mixed, force: true });
    assert.ok(entry, 'a partial result is a result');
    assert.equal(entry.supported, true);
    // The sentinel was accepted, so the full candidate set was walked: the one
    // accepted value plus every inconclusive one stays listed, in canonical order.
    assert.deepEqual(entry.modes, probe.normalizeDiscoveredModes(probe.PROBE_CANDIDATES));
    assert.ok(entry.modes.includes('low') && entry.modes.includes('high'), 'known modes survive the transient failures');
    assert.equal(entry.verification.low.result, 'accepted');
    assert.equal(entry.verification.high.result, 'inconclusive');
});

test('finding 1: a GENUINELY negative sweep (accepted, no reasoning) still downgrades', async () => {
    const cachePath = cacheFile('negative');
    probe.resetCapabilityProbeState({ cachePath });
    await probe.probeAndCacheReasoningModes('down/model', {
        apiKey: 'k',
        requestImpl: (args) => {
            const body = JSON.parse(args.body);
            if (body.reasoning_effort === probe.PROBE_SENTINEL) return listing400(['low', 'high']);
            return reasonedAccepted();
        }
    });
    // Every value ACCEPTED (200) but nothing reasons: a genuine negative. ONE is
    // not enough — a previously-proven model keeps its verdict until the run
    // reaches two consecutive genuine negatives.
    const negative = sentinelAcceptedThen(() => jsonResponse(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    assert.equal(await probe.probeAndCacheReasoningModes('down/model', { apiKey: 'k', requestImpl: negative, force: true }), null,
        'the first complete-but-silent sweep must not downgrade a proven model');
    assert.equal(probe.getCachedReasoningCapability('down/model').supported, true, 'one negative is not a downgrade');
    const entry = await probe.probeAndCacheReasoningModes('down/model', { apiKey: 'k', requestImpl: negative, force: true });
    assert.ok(entry, 'observed accepted responses with no reasoning is a finding');
    assert.equal(entry.supported, false, 'two consecutive real negatives must downgrade');
    assert.equal(entry.controlKey, null);
    // Hysteresis still owns the mode list for one cycle; the VERDICT is what
    // must flip, and advertisement is gated on it (see finding 3).
    const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
    probe.mergeProbedReasoning(caps, 'down/model');
    assert.equal(caps.reasoning.supported, false);
    assert.deepEqual(caps.reasoning.modes, [], 'an unsupported entry must not advertise modes');
    assert.equal(caps.reasoning.controlKey, null);
});

// ---------------------------------------------------------------------------
// Finding 3 — unsupported entries advertise no modes
// ---------------------------------------------------------------------------

test('finding 3: mergeProbedReasoning clears modes for an unsupported entry', () => {
    const cachePath = cacheFile('merge-unsupported');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        entries: {
            'neg/model': { modes: ['low', 'high'], defaultMode: null, supported: false, controlKey: null, probedAt: Date.now(), source: 'probed' }
        }
    }));
    probe.resetCapabilityProbeState({ cachePath });

    const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
    probe.mergeProbedReasoning(caps, 'neg/model');
    assert.equal(caps.reasoning.supported, false);
    assert.deepEqual(caps.reasoning.modes, [], 'no modes may be advertised without a control key');
    assert.equal(caps.reasoning.controlKey, null);
    assert.equal(caps.reasoning.defaultMode, null);
});

test('finding 3: the DeepSeek V4.1 exact override still wins before any merge logic (COLD/WARM/RESET)', () => {
    const cachePath = cacheFile('merge-override');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        entries: {
            'deepseek-ai/deepseek-v4.1-flash': {
                modes: ['low', 'high'], defaultMode: 'high', supported: true,
                controlKey: 'reasoning_effort', probedAt: Date.now(), source: 'probed'
            }
        }
    }));
    const staticReasoning = () => ({ reasoning: { supported: true, modes: [], controlKey: null, defaultMode: null } });

    // COLD
    probe.resetCapabilityProbeState({ cachePath: path.join(fileTempRoot, 'never-written', 'r.json') });
    const cold = staticReasoning();
    probe.mergeProbedReasoning(cold, 'deepseek-ai/deepseek-v4.1-flash');
    assert.deepEqual(cold.reasoning, { supported: true, modes: [], controlKey: null, defaultMode: null });

    // WARM
    probe.resetCapabilityProbeState({ cachePath });
    const warm = staticReasoning();
    probe.mergeProbedReasoning(warm, 'deepseek-ai/deepseek-v4.1-flash');
    assert.deepEqual(warm.reasoning, { supported: true, modes: [], controlKey: null, defaultMode: null });

    // RESET (fresh module state reading the same file)
    probe.resetCapabilityProbeState({ cachePath });
    const reset = staticReasoning();
    probe.mergeProbedReasoning(reset, 'deepseek-ai/deepseek-v4.1-flash');
    assert.deepEqual(reset.reasoning, { supported: true, modes: [], controlKey: null, defaultMode: null });
    probe.resetCapabilityProbeState({ cachePath: null });
});
