// @ts-check
/**
 * W1h — capability-probe verdict discipline (patches 1 + 2).
 *
 *   1. Reasoning observed but NOT ONE reasoning_effort value proven: the entry
 *      must advertise NO modes and NO control key. It used to publish all 8
 *      unverified candidates with controlKey "reasoning_effort".
 *   2. A negative observation requires an accepted 2xx whose answer COMPLETED
 *      (`finish_reason !== "length"`, answer text present) and carried no
 *      reasoning marker. Truncated/empty replies are INCONCLUSIVE, and a
 *      downgrade needs TWO consecutive genuine negatives.
 *
 * All upstream traffic is mocked through an injected requestImpl — NO network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const sandbox = process.env.W1H_TMP || os.tmpdir();
fs.mkdirSync(sandbox, { recursive: true });
const fileTempRoot = fs.mkdtempSync(path.join(sandbox, `w1h-probe-${process.pid}-`));
test.after(() => fs.rmSync(fileTempRoot, { recursive: true, force: true }));

process.env.GATEWAY_CAPABILITY_PROBE_DISABLE = '1';
process.env.GATEWAY_LOG_PATH = path.join(fileTempRoot, 'unit-logs', 'gateway.jsonl');

const probe = await import(`${pathToFileURL(path.join(root, 'src/gateway/capability-probe.mjs')).href}?w1h=${Date.now()}`);

function jsonResponse(status, body) {
    return { status, text: typeof body === 'string' ? body : JSON.stringify(body), parsed: typeof body === 'string' ? null : body };
}

function listing400(accepted) {
    const quoted = accepted.map((m) => `'${m}'`).join(', ');
    return jsonResponse(400, {
        error: { message: `Invalid value for 'reasoning_effort': expected one of ${quoted}, but got 'bogus_probe'.`, type: 'invalid_request_error' }
    });
}

/** A 2xx carrying the probe's COMPUTED answer: real reasoning happened. */
function reasoned() {
    return jsonResponse(200, {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok', reasoning_content: `reversed -> ${probe.PROBE_REASONING_ANSWER}` } }]
    });
}

/** A COMPLETE 2xx answer with no reasoning marker: a genuine negative. */
function silentComplete() {
    return jsonResponse(200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] });
}

/** A 2xx cut off by the token cap: NOT a negative observation. */
function truncated() {
    return jsonResponse(200, { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'the token rev' } }] });
}

/** sentinel ACCEPTED (no reasoning), then a per-candidate responder. */
function sentinelThen(perCandidate) {
    return (args) => {
        const body = JSON.parse(args.body);
        if (body.reasoning_effort === probe.PROBE_SENTINEL) return silentComplete();
        return perCandidate(body.reasoning_effort);
    };
}

/** Prove a model first: sentinel lists two values, both accepted AND reasoning. */
function proven(model, cachePath) {
    probe.resetCapabilityProbeState({ cachePath });
    return probe.probeAndCacheReasoningModes(model, {
        apiKey: 'k',
        requestImpl: (args) => {
            const body = JSON.parse(args.body);
            if (body.reasoning_effort === probe.PROBE_SENTINEL) return listing400(['low', 'high']);
            return reasoned();
        }
    });
}

// ---------------------------------------------------------------------------
// Patch 1 — reasoning seen, nothing verified ⇒ no advertised modes/control
// ---------------------------------------------------------------------------

test('patch 1: reasoning seen but EVERY candidate 429 publishes no modes and no controlKey', async () => {
    probe.resetCapabilityProbeState({ cachePath: null });
    const impl = (args) => {
        const body = JSON.parse(args.body);
        if (body.reasoning_effort === probe.PROBE_SENTINEL) return reasoned();
        return jsonResponse(429, { error: { message: 'rate limited' } });
    };
    const entry = await probe.discoverReasoningModes('unverified/model', { apiKey: 'k', candidates: ['low', 'high'], requestImpl: impl });
    assert.ok(entry, 'observed reasoning is still a real finding');
    assert.equal(entry.supported, true, 'the model demonstrably reasons');
    assert.deepEqual(entry.modes, [], 'NOT ONE effort value was proven — nothing may be advertised');
    assert.equal(entry.controlKey, null, 'no control key without a verified value');
    assert.equal(entry.defaultMode, null);
    assert.match(entry.evidence, /no reasoning_effort value could be verified/);
    assert.equal(entry.verification.low.result, 'inconclusive');
    assert.equal(entry.verification.high.result, 'inconclusive');
});

test('patch 1: a 5xx storm after reasoning is observed never advertises the 8 candidates', async () => {
    probe.resetCapabilityProbeState({ cachePath: null });
    const impl = (args) => {
        const body = JSON.parse(args.body);
        if (body.reasoning_effort === probe.PROBE_SENTINEL) return reasoned();
        return jsonResponse(503, { error: { message: 'upstream burning' } });
    };
    const entry = await probe.discoverReasoningModes('storm/model', { apiKey: 'k', requestImpl: impl });
    assert.deepEqual(entry.modes, []);
    assert.equal(entry.controlKey, null);
    assert.equal(entry.supported, true);
});

// ---------------------------------------------------------------------------
// Patch 2 — finish_reason awareness + 2-strike downgrade
// ---------------------------------------------------------------------------

test('patch 2: one truncated 2xx after a proven probe keeps supported:true', async () => {
    const cachePath = path.join(fileTempRoot, 'truncated', 'r.json');
    const good = await proven('trunc/model', cachePath);
    assert.equal(good.supported, true);
    assert.deepEqual(good.modes, ['low', 'high']);

    // The re-probe's sentinel is accepted; every candidate is cut off by the cap.
    const entry = await probe.probeAndCacheReasoningModes('trunc/model', {
        apiKey: 'k', force: true, requestImpl: sentinelThen(() => truncated())
    });
    assert.equal(entry, null, 'a truncated sweep proves nothing and must not be a verdict');
    const cached = probe.getCachedReasoningCapability('trunc/model');
    assert.equal(cached.supported, true, 'a 64-token cap must never downgrade a proven model');
    assert.deepEqual(cached.modes, ['low', 'high']);
    assert.equal(cached.controlKey, 'reasoning_effort');
});

test('patch 2: finish_reason is read in camelCase too, and an EMPTY answer is inconclusive', async () => {
    const cachePath = path.join(fileTempRoot, 'camel', 'r.json');
    await proven('camel/model', cachePath);
    const camelTruncated = () => jsonResponse(200, { choices: [{ finishReason: 'length', message: { role: 'assistant', content: 'partial' } }] });
    assert.equal(await probe.probeAndCacheReasoningModes('camel/model', { apiKey: 'k', force: true, requestImpl: sentinelThen(camelTruncated) }), null);
    assert.equal(probe.getCachedReasoningCapability('camel/model').supported, true);

    const emptyAnswer = () => jsonResponse(200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '' } }] });
    assert.equal(await probe.probeAndCacheReasoningModes('camel/model', { apiKey: 'k', force: true, requestImpl: sentinelThen(emptyAnswer) }), null);
    assert.equal(probe.getCachedReasoningCapability('camel/model').supported, true, 'an absent answer is not a negative observation');
});

test('patch 2: two CONSECUTIVE complete negatives downgrade a proven model', async () => {
    const cachePath = path.join(fileTempRoot, 'two-strike', 'r.json');
    await proven('strike/model', cachePath);

    const first = await probe.probeAndCacheReasoningModes('strike/model', { apiKey: 'k', force: true, requestImpl: sentinelThen(silentComplete) });
    assert.equal(first, null, 'one genuine negative is held, not published');
    assert.equal(probe.getCachedReasoningCapability('strike/model').supported, true);

    const second = await probe.probeAndCacheReasoningModes('strike/model', { apiKey: 'k', force: true, requestImpl: sentinelThen(silentComplete) });
    assert.ok(second);
    assert.equal(second.supported, false, 'the second consecutive genuine negative downgrades');
    assert.equal(second.controlKey, null);
    assert.match(second.evidence, /no reasoning output observed/);
});

test('patch 2: one complete negative on a COLD model does not set supported:false', async () => {
    const cachePath = path.join(fileTempRoot, 'cold-negative', 'r.json');
    probe.resetCapabilityProbeState({ cachePath });
    const entry = await probe.probeAndCacheReasoningModes('cold-neg/model', { apiKey: 'k', requestImpl: sentinelThen(silentComplete) });
    assert.equal(entry, null, 'a cold model with ONE negative stays unknown');
    assert.equal(probe.getCachedReasoningCapability('cold-neg/model'), null, 'no negative entry may be written');
    assert.equal(fs.existsSync(cachePath), false);
});

test('patch 2: a positive observation RESETS the negative run', async () => {
    const cachePath = path.join(fileTempRoot, 'reset-run', 'r.json');
    await proven('reset/model', cachePath);
    // negative #1
    assert.equal(await probe.probeAndCacheReasoningModes('reset/model', { apiKey: 'k', force: true, requestImpl: sentinelThen(silentComplete) }), null);
    // a POSITIVE sweep clears the run
    const positive = await probe.probeAndCacheReasoningModes('reset/model', {
        apiKey: 'k', force: true,
        requestImpl: (args) => {
            const body = JSON.parse(args.body);
            if (body.reasoning_effort === probe.PROBE_SENTINEL) return listing400(['low', 'high']);
            return reasoned();
        }
    });
    assert.equal(positive.supported, true);
    // negative #2 must be treated as a FIRST strike again
    assert.equal(await probe.probeAndCacheReasoningModes('reset/model', { apiKey: 'k', force: true, requestImpl: sentinelThen(silentComplete) }), null,
        'the run was reset by the positive observation');
    assert.equal(probe.getCachedReasoningCapability('reset/model').supported, true);
    probe.resetCapabilityProbeState({ cachePath: null });
});

test('patch 2: the reversed-answer requirement is unchanged — the raw marker is NOT reasoning', async () => {
    const cachePath = path.join(fileTempRoot, 'marker-only', 'r.json');
    probe.resetCapabilityProbeState({ cachePath });
    const impl = sentinelThen(() => jsonResponse(200, {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok', reasoning_content: `token ${probe.PROBE_REASONING_MARKER}` } }]
    }));
    assert.equal(await probe.probeAndCacheReasoningModes('marker/model', { apiKey: 'k', requestImpl: impl }), null);
    const entry = await probe.probeAndCacheReasoningModes('marker/model', { apiKey: 'k', requestImpl: impl });
    assert.equal(entry.supported, false, 'a bare marker (input echo) is still not proof');
    assert.equal(entry.controlKey, null);
    probe.resetCapabilityProbeState({ cachePath: null });
});

// ---------------------------------------------------------------------------
// Fix pass 4 — residual defects in the patches above
// ---------------------------------------------------------------------------

test('fix A: an explicit controlKey:null survives reconcileWithPrevious (never re-defaulted)', async () => {
    const cachePath = path.join(fileTempRoot, 'null-control', 'r.json');
    await proven('nullctl/model', cachePath);

    // The sentinel reply REASONS (positive) while every candidate is 429
    // (inconclusive): patch 1 measures "reasoning happens, no verified
    // reasoning_effort value" and writes controlKey:null.
    const all429 = (args) => {
        const body = JSON.parse(args.body);
        if (body.reasoning_effort === probe.PROBE_SENTINEL) return reasoned();
        return jsonResponse(429, { error: { message: 'rate limited' } });
    };
    const first = await probe.probeAndCacheReasoningModes('nullctl/model', { apiKey: 'k', force: true, requestImpl: all429 });
    assert.equal(first.controlKey, null, 'the measured "no usable control" answer is null, not a default');

    // The SECOND all-inconclusive sweep is where reconcile used to drop every
    // mode AND re-apply finalizeEntry's default, publishing the impossible shape
    // {supported:true, modes:[], controlKey:'reasoning_effort'} — a control key
    // for a value this sweep never verified.
    const second = await probe.probeAndCacheReasoningModes('nullctl/model', { apiKey: 'k', force: true, requestImpl: all429 });
    assert.ok(second);
    assert.deepEqual(second.modes, [], 'nothing was verified in this sweep');
    assert.equal(second.supported, true, 'the model still demonstrably reasons');
    assert.equal(second.controlKey, null, 'null means "deliberately no control" and must NOT become the default');
    assert.ok(Object.prototype.hasOwnProperty.call(second, 'controlKey'), 'the key must be PRESENT as null, not absent');

    const cached = probe.getCachedReasoningCapability('nullctl/model');
    assert.equal(cached.controlKey, null);
    assert.deepEqual(cached.modes, []);

    // /v1/models advertisement keeps the null control.
    const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
    probe.mergeProbedReasoning(caps, 'nullctl/model');
    assert.equal(caps.reasoning.controlKey, null);
    assert.deepEqual(caps.reasoning.modes, []);

    // …and the Anthropic facade must not send a reasoning_effort that was never
    // verified. The adapter reads the SAME module instance it imports itself, so
    // this half runs against a plain (non-cache-busted) import of the probe.
    const plainProbe = await import(pathToFileURL(path.join(root, 'src/gateway/capability-probe.mjs')).href);
    plainProbe.resetCapabilityProbeState({ cachePath });
    assert.equal(plainProbe.getCachedReasoningCapability('nullctl/model').controlKey, null,
        'the null control key must survive the persistence round-trip');
    const { translateAnthropicRequest } = await import(pathToFileURL(path.join(root, 'src/gateway/anthropic-adapter.mjs')).href);
    const translated = translateAnthropicRequest({
        model: 'nullctl/model', max_tokens: 64,
        messages: [{ role: 'user', content: 'think' }],
        thinking: { type: 'enabled', budget_tokens: 20000 }
    });
    assert.deepEqual(translated.errors, []);
    assert.ok(translated.openaiBody);
    assert.equal('reasoning_effort' in translated.openaiBody, false,
        'no reasoning_effort may be sent for a value the probe never verified');
    assert.equal('chat_template_kwargs' in translated.openaiBody, false, 'no control may be invented either');
    plainProbe.resetCapabilityProbeState({ cachePath: null });
    probe.resetCapabilityProbeState({ cachePath: null });
});

test('fix B: an all-rejected-but-reasoning sweep RESETS the negative run (neg -> pos -> neg does not downgrade)', async () => {
    const cachePath = path.join(fileTempRoot, 'reset-all-rejected', 'r.json');
    await proven('resetb/model', cachePath);

    // strike 1 — a complete, marker-free sweep: held, not published.
    assert.equal(await probe.probeAndCacheReasoningModes('resetb/model', { apiKey: 'k', force: true, requestImpl: sentinelThen(silentComplete) }), null);
    assert.equal(probe.getCachedReasoningCapability('resetb/model').supported, true);

    // POSITIVE observation in the all-rejected-but-reasoning branch: the sentinel
    // reply carries the computed answer while every effort value is rejected.
    // This branch used to return WITHOUT resetting the run.
    const positive = await probe.probeAndCacheReasoningModes('resetb/model', {
        apiKey: 'k', force: true,
        requestImpl: (args) => {
            const body = JSON.parse(args.body);
            if (body.reasoning_effort === probe.PROBE_SENTINEL) return reasoned();
            return jsonResponse(400, { error: { message: 'reasoning_effort is not supported by this model' } });
        }
    });
    assert.ok(positive, 'observed reasoning with every value rejected is a real finding');
    assert.equal(positive.supported, true);

    // A SINGLE negative now must be a FIRST strike again — the positive reset the run.
    assert.equal(await probe.probeAndCacheReasoningModes('resetb/model', { apiKey: 'k', force: true, requestImpl: sentinelThen(silentComplete) }), null,
        'the positive observation must reset the run, so one negative is held');
    assert.equal(probe.getCachedReasoningCapability('resetb/model').supported, true,
        'a single negative after a positive must never downgrade');
    probe.resetCapabilityProbeState({ cachePath: null });
});

// ---------------------------------------------------------------------------
// Fix pass 5 — the mode/controlKey invariant (modes are CONTROLS, not evidence)
//
// `modes` may only be advertised together with the control key that drives them.
// The residual defect: after the FIRST all-inconclusive sweep, hysteresis kept
// `modes:['low','high']` next to `controlKey:null`; the Anthropic adapter then
// saw modes, "repaired" the key back to reasoning_effort and sent `high` — a
// value that sweep never verified. Self-healed on the second sweep, so it was
// one TTL cycle of exposure per downgrade and no test covered it.
// ---------------------------------------------------------------------------

/** Sentinel reasons, every candidate 429: measured "no usable control". */
const allInconclusive = (args) => {
    const body = JSON.parse(args.body);
    if (body.reasoning_effort === probe.PROBE_SENTINEL) return reasoned();
    return jsonResponse(429, { error: { message: 'rate limited' } });
};

/** The Anthropic facade reads the SAME module instance it imports itself. */
async function translateViaPlainProbe(cachePath, modelId, thinking = /** @type {any} */ ({ type: 'enabled', budget_tokens: 20000 })) {
    const plainProbe = await import(pathToFileURL(path.join(root, 'src/gateway/capability-probe.mjs')).href);
    plainProbe.resetCapabilityProbeState({ cachePath });
    const { translateAnthropicRequest } = await import(pathToFileURL(path.join(root, 'src/gateway/anthropic-adapter.mjs')).href);
    const translated = translateAnthropicRequest({
        model: modelId, max_tokens: 64,
        messages: [{ role: 'user', content: 'think' }],
        thinking
    });
    assert.deepEqual(translated.errors, []);
    assert.ok(translated.openaiBody);
    return { translated, plainProbe };
}

test('fix C: ONE all-inconclusive sweep leaves no advertisable modes and the adapter sends no reasoning_effort', async () => {
    const cachePath = path.join(fileTempRoot, 'invariant-one-sweep', 'r.json');
    const good = await proven('inv/model', cachePath);
    assert.deepEqual(good.modes, ['low', 'high'], 'baseline: the model is genuinely verified');
    assert.equal(good.controlKey, 'reasoning_effort');

    const swept = await probe.probeAndCacheReasoningModes('inv/model', { apiKey: 'k', force: true, requestImpl: allInconclusive });
    assert.ok(swept, 'observed reasoning is still a real finding');
    assert.equal(swept.supported, true);
    assert.equal(swept.controlKey, null, 'this sweep verified no reasoning_effort value');
    assert.deepEqual(swept.modes, [], 'a null control key may not carry advertised modes');
    assert.equal(swept.defaultMode, null);
    // The per-value evidence is NOT thrown away.
    assert.equal(swept.verification.low.result, 'inconclusive');
    assert.equal(swept.verification.high.result, 'inconclusive');

    const cached = probe.getCachedReasoningCapability('inv/model');
    assert.deepEqual(cached.modes, []);
    assert.equal(cached.controlKey, null);

    // /v1/models advertises no controls it cannot drive.
    const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
    probe.mergeProbedReasoning(caps, 'inv/model');
    assert.equal(caps.reasoning.supported, true);
    assert.deepEqual(caps.reasoning.modes, []);
    assert.equal(caps.reasoning.controlKey, null);
    assert.equal(caps.reasoning.defaultMode, null);

    // …and the adapter must not resurrect the control from a mode list.
    const { translated } = await translateViaPlainProbe(cachePath, 'inv/model');
    assert.equal('reasoning_effort' in translated.openaiBody, false,
        'the sweep never verified any reasoning_effort value');
    assert.equal('chat_template_kwargs' in translated.openaiBody, false, 'no control may be invented either');

    probe.resetCapabilityProbeState({ cachePath: null });
});

test('fix C: TWO all-inconclusive sweeps keep the same coherent shape (no second-cycle drift)', async () => {
    const cachePath = path.join(fileTempRoot, 'invariant-two-sweeps', 'r.json');
    await proven('inv2/model', cachePath);

    for (const sweep of [1, 2]) {
        const entry = await probe.probeAndCacheReasoningModes('inv2/model', { apiKey: 'k', force: true, requestImpl: allInconclusive });
        assert.ok(entry, `sweep ${sweep} is a finding, not a failure`);
        assert.equal(entry.supported, true, `sweep ${sweep}`);
        assert.equal(entry.controlKey, null, `sweep ${sweep}`);
        assert.deepEqual(entry.modes, [], `sweep ${sweep}: no modes without a control`);
        assert.equal(entry.defaultMode, null, `sweep ${sweep}`);
    }

    const { translated } = await translateViaPlainProbe(cachePath, 'inv2/model');
    assert.equal('reasoning_effort' in translated.openaiBody, false);

    probe.resetCapabilityProbeState({ cachePath: null });
});

test('fix C: a genuinely verified model still advertises its modes and still sends the verified value', async () => {
    const cachePath = path.join(fileTempRoot, 'invariant-verified', 'r.json');
    const entry = await proven('inv3/model', cachePath);
    assert.deepEqual(entry.modes, ['low', 'high']);
    assert.equal(entry.controlKey, 'reasoning_effort');
    assert.equal(entry.defaultMode, 'high');

    const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
    probe.mergeProbedReasoning(caps, 'inv3/model');
    assert.deepEqual(caps.reasoning.modes, ['low', 'high'], 'a verified control keeps its modes');
    assert.equal(caps.reasoning.controlKey, 'reasoning_effort');
    assert.equal(caps.reasoning.defaultMode, 'high');

    const { translated } = await translateViaPlainProbe(cachePath, 'inv3/model');
    assert.equal(translated.openaiBody.reasoning_effort, 'high', 'verified evidence must still reach upstream');

    probe.resetCapabilityProbeState({ cachePath: null });
});

test('fix C: the invariant survives the disk round-trip (a restart cannot resurrect modes)', async () => {
    const cachePath = path.join(fileTempRoot, 'invariant-disk', 'r.json');
    await proven('inv4/model', cachePath);
    await probe.probeAndCacheReasoningModes('inv4/model', { apiKey: 'k', force: true, requestImpl: allInconclusive });

    // What was WRITTEN, not just what the in-memory cache says.
    const onDisk = JSON.parse(fs.readFileSync(cachePath, 'utf8')).entries['inv4/model'];
    assert.deepEqual(onDisk.modes, [], 'the persisted entry must not carry modes without a control');
    assert.equal(onDisk.controlKey, null);
    assert.equal(onDisk.defaultMode, null);
    assert.equal(onDisk.verification.low.result, 'inconclusive', 'evidence is still persisted');

    // A fresh process re-reads the same file: identical, coherent shape.
    probe.resetCapabilityProbeState({ cachePath });
    const restored = probe.getCachedReasoningCapability('inv4/model');
    assert.deepEqual(restored.modes, []);
    assert.equal(restored.controlKey, null);
    assert.equal(restored.supported, true);

    const { translated } = await translateViaPlainProbe(cachePath, 'inv4/model');
    assert.equal('reasoning_effort' in translated.openaiBody, false);

    probe.resetCapabilityProbeState({ cachePath: null });
});

test('fix C: an incoherent legacy cache entry (modes present, controlKey null) is repaired deterministically on load', async () => {
    const cachePath = path.join(fileTempRoot, 'invariant-legacy', 'r.json');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    // Exactly the shape the old hysteresis could persist.
    fs.writeFileSync(cachePath, JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        entries: {
            'legacy-incoherent/model': {
                modes: ['low', 'high'], defaultMode: 'high', supported: true,
                controlKey: null, probedAt: Date.now(), source: 'probed',
                verification: { low: { result: 'inconclusive' }, high: { result: 'inconclusive' } }
            }
        }
    }));

    for (const attempt of [1, 2]) {
        probe.resetCapabilityProbeState({ cachePath });
        const repaired = probe.getCachedReasoningCapability('legacy-incoherent/model');
        assert.ok(repaired, `attempt ${attempt}: the entry still serves`);
        assert.deepEqual(repaired.modes, [], `attempt ${attempt}: modes without a control are repaired away`);
        assert.equal(repaired.controlKey, null, `attempt ${attempt}: null is a measurement, not a default`);
        assert.equal(repaired.defaultMode, null);
        assert.equal(repaired.supported, true);
        assert.equal(repaired.verification.low.result, 'inconclusive', 'evidence is preserved by the repair');
    }

    // Same verdict on the advertisement path and in the adapter.
    const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
    probe.mergeProbedReasoning(caps, 'legacy-incoherent/model');
    assert.deepEqual(caps.reasoning.modes, []);
    assert.equal(caps.reasoning.controlKey, null);

    const { translated } = await translateViaPlainProbe(cachePath, 'legacy-incoherent/model');
    assert.equal('reasoning_effort' in translated.openaiBody, false,
        'an explicit null control key must never be repaired back from the mode list');

    probe.resetCapabilityProbeState({ cachePath: null });
});

// ---------------------------------------------------------------------------
// Fix pass 6 — the invariant must be TOTAL, not keyed on an exact null.
//
// F1: `defaultMode` was not gated on the resolved key, so a legacy entry with a
//     garbage controlKey advertised `{controlKey:null, modes:[], defaultMode:'high'}`
//     — a default for a mode nobody can drive.
// F2: `repairEntryInvariant` only fired on `controlKey === null`; ""/42/true
//     survived, the adapter read them as ABSENT and repaired them back to
//     `reasoning_effort`, then SENT the unverified default.
// ---------------------------------------------------------------------------

test('fix D (F1): a defaultMode without a resolved control key is never advertised', () => {
    const cachePath = path.join(fileTempRoot, 'invariant-default-mode', 'r.json');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    // Two measured shapes. The unsupported one survives the repair untouched, so
    // it isolates the MERGE gate: pre-fix it advertised
    // `{supported:false, modes:[], controlKey:null, defaultMode:'high'}` — a
    // default for a mode nobody can drive. The second is the reported shape.
    fs.writeFileSync(cachePath, JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        entries: {
            'default-mode-unsupported/model': {
                modes: ['low', 'high'], defaultMode: 'high', supported: false,
                controlKey: null, probedAt: Date.now(), source: 'probed'
            },
            'default-mode-no-control/model': {
                modes: ['low', 'high'], defaultMode: 'high', supported: true,
                controlKey: '', probedAt: Date.now(), source: 'probed'
            }
        }
    }));

    probe.resetCapabilityProbeState({ cachePath });

    const unsupported = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
    probe.mergeProbedReasoning(unsupported, 'default-mode-unsupported/model');
    assert.equal(unsupported.reasoning.supported, false);
    assert.deepEqual(unsupported.reasoning.modes, []);
    assert.equal(unsupported.reasoning.controlKey, null);
    assert.equal(unsupported.reasoning.defaultMode, null, 'a default mode is a control and needs its key');

    const garbage = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
    probe.mergeProbedReasoning(garbage, 'default-mode-no-control/model');
    assert.deepEqual(garbage.reasoning.modes, []);
    assert.equal(garbage.reasoning.controlKey, null);
    assert.equal(garbage.reasoning.defaultMode, null, 'no default may outlive the control key');

    probe.resetCapabilityProbeState({ cachePath: null });
});

for (const garbage of ['', 42, true]) {
    const label = JSON.stringify(garbage);
    test(`fix D (F2): a PRESENT-but-garbage controlKey ${label} is normalised to null and never resurrected`, async () => {
        const cachePath = path.join(fileTempRoot, `invariant-garbage-${String(garbage)}-${typeof garbage}`, 'r.json');
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify({
            version: 2,
            savedAt: new Date().toISOString(),
            entries: {
                'garbage-control/model': {
                    modes: ['low', 'high'], defaultMode: 'high', supported: true,
                    controlKey: garbage, probedAt: Date.now(), source: 'probed'
                }
            }
        }));

        probe.resetCapabilityProbeState({ cachePath });
        const repaired = probe.getCachedReasoningCapability('garbage-control/model');
        assert.equal(repaired.controlKey, null, 'garbage is a measurement of "no usable control"');
        assert.deepEqual(repaired.modes, [], 'no mode may survive without a real key');
        assert.equal(repaired.defaultMode, null);
        assert.equal(repaired.supported, true);

        const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
        probe.mergeProbedReasoning(caps, 'garbage-control/model');
        assert.deepEqual(caps.reasoning.modes, []);
        assert.equal(caps.reasoning.controlKey, null);
        assert.equal(caps.reasoning.defaultMode, null);

        const { translated } = await translateViaPlainProbe(cachePath, 'garbage-control/model');
        assert.equal('reasoning_effort' in translated.openaiBody, false,
            'garbage must never be repaired back to reasoning_effort and sent');

        probe.resetCapabilityProbeState({ cachePath: null });
    });
}

test('fix C: an INCOMPLETE legacy entry (modes, controlKey absent) still drives reasoning_effort', async () => {
    const cachePath = path.join(fileTempRoot, 'invariant-incomplete', 'r.json');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    // Absent is not a measurement: the adapter repairs it to the probe's default.
    fs.writeFileSync(cachePath, JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        entries: {
            'legacy-incomplete/model': {
                modes: ['low', 'high'], supported: true, probedAt: Date.now(), source: 'probed'
            }
        }
    }));

    probe.resetCapabilityProbeState({ cachePath });
    const restored = probe.getCachedReasoningCapability('legacy-incomplete/model');
    assert.deepEqual(restored.modes, ['low', 'high'], 'an absent key is not an explicit null');

    const { translated } = await translateViaPlainProbe(cachePath, 'legacy-incomplete/model');
    assert.equal(translated.openaiBody.reasoning_effort, 'high');

    probe.resetCapabilityProbeState({ cachePath: null });
});

// ---------------------------------------------------------------------------
// Fix pass 7 — two LOW edge cases of the same invariant.
//
// E1: `length > 0` accepted a WHITESPACE-only controlKey, so the entry
//     advertised {controlKey:"   ", modes:['low','high'], defaultMode:'high'}
//     while the adapter sends nothing — a silent dead control in the UI.
// E2: `defaultMode` was not clamped to `modes`, so a legacy
//     {modes:['low','high'], defaultMode:'max'} advertised 'max' while the
//     adapter clamps down and sends 'high'.
// ---------------------------------------------------------------------------

/** Seed one persisted probe entry and point the module at it. */
function seedEntry(cachePath, modelId, entry) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        entries: { [modelId]: { probedAt: Date.now(), source: 'probed', supported: true, ...entry } }
    }));
    probe.resetCapabilityProbeState({ cachePath });
}

for (const [label, blank] of [['spaces', '   '], ['tab+newline', '\t\n'], ['nbsp', ' \u00a0 ']]) {
    test(`fix E (E1): a whitespace-only controlKey (${label}) is normalised to explicit null`, async () => {
        const cachePath = path.join(fileTempRoot, `ws-control-${label.replace(/[^\w]/g, '_')}`, 'r.json');
        seedEntry(cachePath, 'ws-control/model', {
            controlKey: blank, modes: ['low', 'high'], defaultMode: 'high'
        });

        const repaired = probe.getCachedReasoningCapability('ws-control/model');
        assert.equal(repaired.controlKey, null, 'whitespace is not a usable control key');
        assert.deepEqual(repaired.modes, [], 'no mode may outlive the key that drives it');
        assert.equal(repaired.defaultMode, null);
        assert.equal(repaired.supported, true, 'the measurement itself is preserved');

        // The advertisement must not offer the dead control either.
        const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
        probe.mergeProbedReasoning(caps, 'ws-control/model');
        assert.equal(caps.reasoning.controlKey, null);
        assert.deepEqual(caps.reasoning.modes, []);
        assert.equal(caps.reasoning.defaultMode, null);

        // …and nothing may be sent upstream on the strength of it.
        const { translated } = await translateViaPlainProbe(cachePath, 'ws-control/model');
        assert.equal('reasoning_effort' in translated.openaiBody, false);
        assert.equal('chat_template_kwargs' in translated.openaiBody, false);

        probe.resetCapabilityProbeState({ cachePath: null });
    });
}

test('fix E (E1): a real control key with surrounding spaces is trimmed to its canonical value', async () => {
    const cachePath = path.join(fileTempRoot, 'ws-control-trimmed', 'r.json');
    // Trim-to-canonical, not drop: the intent of the entry is unambiguous — the
    // only difference is accidental padding — so the verified modes stay usable
    // instead of being thrown away over a stray space.
    seedEntry(cachePath, 'ws-trimmed/model', {
        controlKey: '  reasoning_effort  ', modes: ['low', 'high'], defaultMode: 'high'
    });

    const repaired = probe.getCachedReasoningCapability('ws-trimmed/model');
    assert.equal(repaired.controlKey, 'reasoning_effort', 'the canonical key is recovered, not discarded');
    assert.deepEqual(repaired.modes, ['low', 'high'], 'a usable control keeps its modes');

    const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
    probe.mergeProbedReasoning(caps, 'ws-trimmed/model');
    assert.equal(caps.reasoning.controlKey, 'reasoning_effort');
    assert.deepEqual(caps.reasoning.modes, ['low', 'high']);

    const { translated } = await translateViaPlainProbe(cachePath, 'ws-trimmed/model');
    assert.equal(translated.openaiBody.reasoning_effort, 'high');

    probe.resetCapabilityProbeState({ cachePath: null });
});

test('fix E (E1): a key the adapters cannot drive is dropped even when it is padded to look real', async () => {
    const cachePath = path.join(fileTempRoot, 'ws-control-unknown', 'r.json');
    // Trimming alone would turn this into a non-empty string and re-advertise a
    // control nobody can drive; the gate is "a key the adapter actually acts on".
    seedEntry(cachePath, 'ws-unknown/model', {
        controlKey: '  not_a_real_control  ', modes: ['low', 'high'], defaultMode: 'high'
    });

    const repaired = probe.getCachedReasoningCapability('ws-unknown/model');
    assert.equal(repaired.controlKey, null);
    assert.deepEqual(repaired.modes, []);
    assert.equal(repaired.defaultMode, null);

    probe.resetCapabilityProbeState({ cachePath: null });
});

test('fix F (E2): an out-of-list defaultMode is clamped to a mode that is actually offered', async () => {
    const cachePath = path.join(fileTempRoot, 'default-clamp', 'r.json');
    // The reported shape: the adapter clamps 'max' down to 'high' and sends it,
    // while /v1/models advertised 'max' — a default the model never offers.
    seedEntry(cachePath, 'clamp/model', {
        controlKey: 'reasoning_effort', modes: ['low', 'high'], defaultMode: 'max'
    });

    const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
    probe.mergeProbedReasoning(caps, 'clamp/model');
    assert.deepEqual(caps.reasoning.modes, ['low', 'high']);
    assert.equal(caps.reasoning.defaultMode, 'high', 'a default outside `modes` is not advertisable');
    assert.ok(caps.reasoning.modes.includes(caps.reasoning.defaultMode));

    // The advertised default is exactly what the adapter sends upstream — with a
    // budget AND without one. Without the second call this assertion was MASKED:
    // budget 20000 makes the adapter take the BUDGET branch, which never reads
    // defaultMode, so it passed even while the wire value was the raw entry.
    const { translated } = await translateViaPlainProbe(cachePath, 'clamp/model');
    assert.equal(translated.openaiBody.reasoning_effort, caps.reasoning.defaultMode);
    const noBudget = await translateViaPlainProbe(cachePath, 'clamp/model', { type: 'enabled' });
    assert.equal(noBudget.translated.openaiBody.reasoning_effort, caps.reasoning.defaultMode,
        'the defaultMode path itself must send the advertised value');

    probe.resetCapabilityProbeState({ cachePath: null });
});

test('fix F (E2): an in-list defaultMode is preserved verbatim', async () => {
    const cachePath = path.join(fileTempRoot, 'default-preserved', 'r.json');
    seedEntry(cachePath, 'preserve/model', {
        controlKey: 'reasoning_effort', modes: ['low', 'medium', 'high'], defaultMode: 'medium'
    });

    const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
    probe.mergeProbedReasoning(caps, 'preserve/model');
    assert.equal(caps.reasoning.defaultMode, 'medium', 'a verified default is not second-guessed');

    probe.resetCapabilityProbeState({ cachePath: null });
});

test('fix F (E2): an empty mode list advertises no defaultMode at all', async () => {
    const cachePath = path.join(fileTempRoot, 'default-empty-modes', 'r.json');
    // A key with no verified value: nothing can be defaulted.
    seedEntry(cachePath, 'empty-modes/model', {
        controlKey: 'reasoning_effort', modes: [], defaultMode: 'high'
    });

    const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
    probe.mergeProbedReasoning(caps, 'empty-modes/model');
    assert.deepEqual(caps.reasoning.modes, []);
    assert.equal(caps.reasoning.defaultMode, null, 'no default for a mode list that offers nothing');

    probe.resetCapabilityProbeState({ cachePath: null });
});

// ---------------------------------------------------------------------------
// Fix pass 8 — advertised === sent, for EVERY legacy defaultMode.
//
// G1: the clamp only normalised the ADVERTISEMENT; the adapter still sent the
//     RAW `entry.defaultMode`. Measured before the fix: defaultMode "none" and
//     "bogus" were advertised as 'high' but SENT as-is, and an ABSENT default
//     with modes ['max']/['xhigh'] advertised 'max'/'xhigh' but sent 'high' —
//     a value that is not even in the list. The comment claiming the picker was
//     "exactly the value the adapter's downward clamp selects" was false.
// G2: the driveability gate only covered PADDED unknown keys; unpadded
//     `unknown_key`, `REASONING_EFFORT`, `reasoning_effort\u200b` and
//     `reasoning_effort\u0000` were advertised with modes+defaultMode while the
//     adapter sent nothing — a dead control in the UI.
// G3: the old advertised==sent assertion was masked: the default budget 20000
//     made the adapter take the BUDGET path, so `defaultMode` was never read.
// G4: `pickDefaultMode` said "highest listed" but returned modes[last].
// G5: an entry with an ABSENT controlKey advertised controlKey:null while the
//     adapter repaired to reasoning_effort and sent 'high'.
// ---------------------------------------------------------------------------

/**
 * Advertise a seeded entry through /v1/models and translate it through the
 * adapter with the given thinking block. Returns both sides of the comparison.
 */
async function advertisedAndSent(cachePath, modelId, thinking) {
    const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
    probe.mergeProbedReasoning(caps, modelId);
    const { translated } = await translateViaPlainProbe(cachePath, modelId, thinking);
    return { advertised: caps.reasoning, sent: translated.openaiBody };
}

const MATRIX_MODES = [['low', 'high'], ['max'], ['xhigh'], []];
const MATRIX_DEFAULTS = ['none', 'bogus', undefined, 'max', 'xhigh', 'high'];

test('fix G (G1/G3): advertised defaultMode === sent reasoning_effort for every defaultMode x modes pair (no budget)', async () => {
    let checked = 0;
    for (const modes of MATRIX_MODES) {
        for (const defaultMode of MATRIX_DEFAULTS) {
            const label = `${JSON.stringify(modes)}/${JSON.stringify(defaultMode)}`;
            const cachePath = path.join(fileTempRoot, 'advertised-equals-sent', label.replace(/[^\w]/g, '_'), 'r.json');
            const modelId = 'aes/model';
            const entry = { controlKey: 'reasoning_effort', modes };
            if (defaultMode !== undefined) entry.defaultMode = defaultMode;
            seedEntry(cachePath, modelId, entry);

            // NO budget: this is the path that reads defaultMode. The old test
            // passed only because budget 20000 sent the adapter down the BUDGET
            // branch, which never looks at defaultMode at all.
            const { advertised, sent } = await advertisedAndSent(cachePath, modelId, { type: 'enabled' });
            assert.equal(sent.reasoning_effort ?? null, advertised.defaultMode,
                `${label}: the wire value must equal the advertised defaultMode`);
            if (advertised.defaultMode !== null) {
                assert.ok(advertised.modes.includes(advertised.defaultMode),
                    `${label}: the advertised default must be a mode on offer`);
                assert.equal(sent.reasoning_effort, advertised.defaultMode, label);
            } else {
                assert.equal('reasoning_effort' in sent, false, `${label}: nothing is advertised, nothing may be sent`);
            }
            checked++;
            probe.resetCapabilityProbeState({ cachePath: null });
        }
    }
    assert.equal(checked, MATRIX_MODES.length * MATRIX_DEFAULTS.length, 'the whole matrix is exercised');
});

test('fix G (G1): an explicit budget still sends a mode that is on offer (never a value outside the list)', async () => {
    for (const [modes, budget] of [
        [['low', 'high'], 20000], [['low', 'high'], 4000], [['low', 'high'], 50000],
        [['max'], 20000], [['xhigh'], 20000], [['xhigh'], 1000], [['max'], 50000],
    ]) {
        const label = `${JSON.stringify(modes)}/budget=${budget}`;
        const cachePath = path.join(fileTempRoot, 'advertised-equals-sent-budget', label.replace(/[^\w]/g, '_'), 'r.json');
        seedEntry(cachePath, 'aes-budget/model', { controlKey: 'reasoning_effort', modes });
        const { advertised, sent } = await advertisedAndSent(cachePath, 'aes-budget/model', { type: 'enabled', budget_tokens: budget });
        assert.ok(advertised.modes.includes(sent.reasoning_effort),
            `${label}: sent ${JSON.stringify(sent.reasoning_effort)} is not one of ${JSON.stringify(advertised.modes)}`);
        probe.resetCapabilityProbeState({ cachePath: null });
    }
});

test('fix G (G1): the persisted cache carries the clamped default, so a restart advertises and sends the same value', async () => {
    const cachePath = path.join(fileTempRoot, 'advertised-equals-sent-persist', 'r.json');
    seedEntry(cachePath, 'aes-persist/model', { controlKey: 'reasoning_effort', modes: ['low', 'high'], defaultMode: 'none' });

    const cached = probe.getCachedReasoningCapability('aes-persist/model');
    assert.equal(cached.defaultMode, 'high', 'the clamp happens at the source and is what the adapter reads');

    // A fresh process re-reads the SAME file: same clamped value, no second clamp.
    probe.resetCapabilityProbeState({ cachePath });
    const restored = probe.getCachedReasoningCapability('aes-persist/model');
    assert.equal(restored.defaultMode, 'high');
    const { advertised, sent } = await advertisedAndSent(cachePath, 'aes-persist/model', { type: 'enabled' });
    assert.equal(advertised.defaultMode, 'high');
    assert.equal(sent.reasoning_effort, 'high');

    probe.resetCapabilityProbeState({ cachePath: null });
});

test('fix G (G2): only a control key the adapter can drive may be advertised (unpadded adversarial keys)', async () => {
    const cases = [
        ['unknown_key', 'a plain unknown field'],
        ['REASONING_EFFORT', 'wrong case'],
        ['reasoning_effort\u200b', 'zero-width-space suffix'],
        ['reasoning_effort\u0000', 'NUL suffix'],
        ['chat_template_kwargs.', 'prefix with no field name'],
    ];
    for (const [controlKey, label] of cases) {
        const cachePath = path.join(fileTempRoot, `driveable-${Buffer.from(controlKey).toString('hex')}`, 'r.json');
        seedEntry(cachePath, 'driveable/model', { controlKey, modes: ['low', 'high'], defaultMode: 'high' });

        const repaired = probe.getCachedReasoningCapability('driveable/model');
        assert.equal(repaired.controlKey, null, `${label}: not a control the adapter can write`);
        assert.deepEqual(repaired.modes, [], `${label}: no mode may outlive the key that drives it`);
        assert.equal(repaired.defaultMode, null, label);

        const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' } };
        probe.mergeProbedReasoning(caps, 'driveable/model');
        assert.equal(caps.reasoning.controlKey, null, `${label}: /v1/models must not advertise a dead control`);
        assert.deepEqual(caps.reasoning.modes, [], label);
        assert.equal(caps.reasoning.defaultMode, null, label);

        const { translated } = await translateViaPlainProbe(cachePath, 'driveable/model');
        assert.equal('reasoning_effort' in translated.openaiBody, false, `${label}: the adapter cannot drive it, so it sends nothing`);
        assert.equal('chat_template_kwargs' in translated.openaiBody, false, label);

        probe.resetCapabilityProbeState({ cachePath: null });
    }
});

test('fix G (G2): a real chat_template_kwargs key is still advertised AND driven', async () => {
    const cachePath = path.join(fileTempRoot, 'driveable-ctk', 'r.json');
    seedEntry(cachePath, 'ctk/model', { controlKey: 'chat_template_kwargs.enable_thinking', modes: ['on'] });

    const repaired = probe.getCachedReasoningCapability('ctk/model');
    assert.equal(repaired.controlKey, 'chat_template_kwargs.enable_thinking', 'the adapter can write this field');
    assert.deepEqual(repaired.modes, ['on']);

    const { advertised, sent } = await advertisedAndSent(cachePath, 'ctk/model', { type: 'enabled' });
    assert.equal(advertised.controlKey, 'chat_template_kwargs.enable_thinking');
    assert.equal(sent.chat_template_kwargs?.enable_thinking, true, 'the advertised control is the one sent');

    probe.resetCapabilityProbeState({ cachePath: null });
});

test('fix G (G4): pickDefaultMode is deterministic for an UNSORTED legacy list', () => {
    // The doc said "highest listed"; modes[last] returned 'low' for this list.
    assert.equal(probe.pickDefaultMode(['max', 'low']), 'max');
    assert.equal(probe.pickDefaultMode(['xhigh', 'max', 'low']), 'max');
    assert.equal(probe.pickDefaultMode(['low', 'medium', 'high', 'max']), 'high', 'high still wins');
    assert.equal(probe.pickDefaultMode(['off', 'on']), 'on');
    assert.equal(probe.pickDefaultMode(['low']), 'low');
    assert.equal(probe.pickDefaultMode([]), null);
    assert.equal(probe.pickDefaultMode(['custom']), 'custom');
});

test('fix G (G5): an ABSENT controlKey is advertised as the repaired key the adapter actually sends', async () => {
    const cachePath = path.join(fileTempRoot, 'absent-key-advertised', 'r.json');
    seedEntry(cachePath, 'absent-key/model', { modes: ['low', 'high'], defaultMode: 'high' });
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')).entries['absent-key/model'];
    assert.equal(Object.prototype.hasOwnProperty.call(raw, 'controlKey'), false, 'fixture: the key is absent');

    const { advertised, sent } = await advertisedAndSent(cachePath, 'absent-key/model', { type: 'enabled' });
    assert.equal(advertised.controlKey, 'reasoning_effort',
        'the UI must name the key the adapter repairs to, not null');
    assert.deepEqual(advertised.modes, ['low', 'high']);
    assert.equal(sent.reasoning_effort, advertised.defaultMode, 'advertised default === sent value');
    assert.equal(advertised.defaultMode, 'high');

    probe.resetCapabilityProbeState({ cachePath: null });
});

test('fix G (G5): a repaired-key entry keeps the invariant — no modes ⇒ no key ⇒ no default', async () => {
    const cachePath = path.join(fileTempRoot, 'absent-key-empty', 'r.json');
    seedEntry(cachePath, 'absent-key-empty/model', { modes: [] });

    const { advertised, sent } = await advertisedAndSent(cachePath, 'absent-key-empty/model', { type: 'enabled' });
    assert.equal(advertised.controlKey, null, 'a key with no verified value drives nothing');
    assert.deepEqual(advertised.modes, []);
    assert.equal(advertised.defaultMode, null);
    assert.equal('reasoning_effort' in sent, false, 'so the adapter sends no unverified effort');

    probe.resetCapabilityProbeState({ cachePath: null });
});

test('fix G: the DeepSeek V4.1 override is untouched by the shared clamp', () => {
    const cachePath = path.join(fileTempRoot, 'deepseek-override-clamp', 'r.json');
    seedEntry(cachePath, 'deepseek-ai/deepseek-v4.1-flash', {
        controlKey: 'reasoning_effort', modes: ['low', 'high', 'max'], defaultMode: 'max'
    });
    const caps = { reasoning: { supported: true, modes: [], controlKey: null, defaultMode: null } };
    probe.mergeProbedReasoning(caps, 'deepseek-ai/deepseek-v4.1-flash');
    assert.deepEqual(caps.reasoning, { supported: true, modes: [], controlKey: null, defaultMode: null });
    probe.resetCapabilityProbeState({ cachePath: null });
});

test('fix G (G6): the CHAT facade honours the probed verdict - advertised == sent', () => {
    // The defaults module and the probe module must share ONE registry for this
    // assertion to mean anything, so run it in a child process instead of mixing
    // the test file's unique-query probe instance with a plain import.
    const script = [
        "const probe = await import('./src/gateway/capability-probe.mjs');",
        "const defs = await import('./src/gateway/reasoning-defaults.mjs');",
        "const fs = await import('node:fs');",
        "const path = await import('node:path');",
        'const cache = path.join(' + JSON.stringify(fileTempRoot.replace(/\\/g, '/')) + ", 'chat-probed-g6', 'r.json');",
        "fs.mkdirSync(path.dirname(cache), { recursive: true });",
        "const seed = (entry) => fs.writeFileSync(cache, JSON.stringify({ version: 2, savedAt: new Date().toISOString(), entries: { 'moonshotai/kimi-k3': { probedAt: Date.now(), source: 'probed', ...entry } } }));",
        "seed({ supported: false, modes: [], controlKey: null, defaultMode: null });",
        "probe.resetCapabilityProbeState({ cachePath: cache });",
        "const negAdv = probe.resolveAdvertisedReasoning('moonshotai/kimi-k3');",
        "const negBody = { model: 'moonshotai/kimi-k3', messages: [] };",
        "defs.applyReasoningDefaults(negBody);",
        "seed({ supported: true, modes: ['low', 'max'], controlKey: 'reasoning_effort', defaultMode: 'max' });",
        "probe.resetCapabilityProbeState({ cachePath: cache });",
        "const posAdv = probe.resolveAdvertisedReasoning('moonshotai/kimi-k3');",
        "const posBody = { model: 'moonshotai/kimi-k3', messages: [] };",
        "defs.applyReasoningDefaults(posBody);",
        "process.stdout.write(JSON.stringify({ negAdv, negBody, posAdv, posBody }));"
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root, encoding: 'utf8', env: { ...process.env, GATEWAY_CAPABILITY_PROBE_DISABLE: '1' }
    });
    const r = JSON.parse(out);

    // A probed NEGATIVE has no veto power: it is not authoritative, so the chat
    // facade falls back to the SAME static answer /v1/models and the Anthropic
    // facade use (Kimi K3 static default "high").
    assert.equal(r.negAdv.authoritative, false,
        'a negative probe must not veto static knowledge');
    assert.equal(r.negBody.reasoning_effort, 'high',
        'chat sends the static default, consistent with every other consumer');

    // A probed POSITIVE with a narrower list must send the advertised default.
    assert.equal(r.posBody.reasoning_effort, r.posAdv.defaultMode);
    assert.ok(r.posAdv.modes.includes(r.posBody.reasoning_effort),
        'the sent value must be one the advertisement offers');
});
