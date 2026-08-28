// @ts-check
/**
 * Tests for REAL reasoning-capability discovery (capability-probe.mjs).
 *
 * Layers:
 *   1. Pure unit tests — validation-error parser, mode normalization, default
 *      pick, cache-path resolution (no network, no I/O).
 *   2. Cache/service tests — TTL logic, per-model concurrency guard,
 *      persistence round-trip, failure fallback, sweep gating. All upstream
 *      traffic is mocked via an injected requestImpl — NO network.
 *   3. Spawned-gateway integration tests (local fake upstream via
 *      tests/local-upstream-preload.cjs) — /v1/models serving probed-over-
 *      static, passthrough lock for reasoning_effort/chat_template_kwargs,
 *      and probe-failure resilience.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
import { pathToFileURL } from 'node:url';
const fileTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-capability-probe-${process.pid}-`));
test.after(() => fs.rmSync(fileTempRoot, { recursive: true, force: true }));

// Keep background sweeps off in THIS process unless a test explicitly opts in.
process.env.GATEWAY_CAPABILITY_PROBE_DISABLE = '1';
// logger.mjs is imported transitively by some siblings; give it a valid path.
process.env.GATEWAY_LOG_PATH = path.join(fileTempRoot, 'unit-logs', 'gateway.jsonl');

const probe = await import(`${pathToFileURL(path.join(root, 'src/gateway/capability-probe.mjs')).href}?unit=${Date.now()}`);

function jsonResponse(status, body) {
    return async () => ({ status, text: typeof body === 'string' ? body : JSON.stringify(body), parsed: typeof body === 'string' ? null : body });
}

/** Synchronous (non-Promise) response object — what requestImpl resolves TO. */
function syncJsonResponse(status, body) {
    return { status, text: typeof body === 'string' ? body : JSON.stringify(body), parsed: typeof body === 'string' ? null : body };
}

function recordingResponder(responderFactory) {
    const calls = [];
    const impl = async (args) => {
        calls.push(args);
        // Accept BOTH shapes: (args) => response  and  (args) => () => response.
        const produced = responderFactory(args);
        return typeof produced === "function" ? produced(args) : produced;
    };
    return { calls, impl };
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

/**
 * Realistic two-phase responder: the sentinel gets a LISTING validation error;
 * each subsequently verified effort value is ACCEPTED unless named in
 * `rejected` (mirroring live per-model enforcement).
 */
function listingThenAccept(listed, rejected = []) {
    return (args) => {
        const effort = JSON.parse(args.body).reasoning_effort;
        if (effort === probe.PROBE_SENTINEL) return listing400(listed)(args);
        if (rejected.includes(effort)) return jsonResponse(400, { error: { message: `Invalid reasoning_effort: model does not support effort '${effort}'.` } })();
        return jsonResponse(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] })();
    };
}

async function waitFor(predicate, timeoutMs = 15_000, stepMs = 50) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
    throw new Error('Timed out waiting for condition.');
}

// ---------------------------------------------------------------------------
// 1. Pure parser / normalization
// ---------------------------------------------------------------------------

test('parser extracts allowed values from NVIDIA-style validation errors and drops the sentinel', () => {
    const message = "Invalid value for 'reasoning_effort': expected one of 'low', 'medium', 'high', 'xhigh', 'max', but got 'bogus_probe'.";
    assert.deepEqual(probe.parseAllowedValuesFromError(message), ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('parser handles bracket-list and prose shapes', () => {
    assert.deepEqual(
        probe.parseAllowedValuesFromError("reasoning_effort must be one of ['low','medium','high'] but found bogus_probe"),
        ['low', 'medium', 'high']
    );
    assert.deepEqual(
        probe.parseAllowedValuesFromError("Input should be 'low', 'medium' or 'high'"),
        ['low', 'medium', 'high']
    );
});

test('parser excludes stoplist words and keeps unknown-but-plausible modes', () => {
    // 'error'/'value' style noise never leaks; a novel enum value survives.
    const message = "Unsupported value 'bogus_probe'. Supported values are: 'error-free', 'value', 'max', 'ultra'.";
    assert.deepEqual(probe.parseAllowedValuesFromError(message), ['error-free', 'max', 'ultra']);
});

test('parser returns empty for garbage input', () => {
    assert.deepEqual(probe.parseAllowedValuesFromError(null), []);
    assert.deepEqual(probe.parseAllowedValuesFromError(undefined), []);
    assert.deepEqual(probe.parseAllowedValuesFromError(''), []);
    assert.deepEqual(probe.parseAllowedValuesFromError(12345), []);
    assert.deepEqual(probe.parseAllowedValuesFromError("totally unrelated message with no tokens"), []);
});

test('normalizeDiscoveredModes canonicalizes order and dedupes case-insensitively', () => {
    assert.deepEqual(
        probe.normalizeDiscoveredModes(['max', 'HIGH', 'xhigh', 'low', 'medium', 'high']),
        ['low', 'medium', 'high', 'xhigh', 'max']
    );
    assert.deepEqual(probe.normalizeDiscoveredModes(['weird-new', 'none']), ['none', 'weird-new']);
    assert.deepEqual(probe.normalizeDiscoveredModes(null), []);
});

test('pickDefaultMode prefers high then highest listed; null when empty', () => {
    assert.equal(probe.pickDefaultMode(['low', 'medium', 'high', 'xhigh', 'max']), 'high');
    assert.equal(probe.pickDefaultMode(['off', 'on']), 'on');
    assert.equal(probe.pickDefaultMode([]), null);
});

test('buildProbeBody carries model, tiny prompt, max_tokens=64 and reasoning_effort', () => {
    const body = JSON.parse(probe.buildProbeBody('stepfun-ai/step-3.7-flash', 'xhigh'));
    assert.equal(body.model, 'stepfun-ai/step-3.7-flash');
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 64, 'verification probes must use 64 tokens — thinking models degenerate at 1');
    assert.equal(body.max_tokens, probe.PROBE_VERIFY_MAX_TOKENS);
    assert.equal(body.reasoning_effort, 'xhigh');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'ok' }]);
});

test('resolveCapabilityCachePath prefers explicit override, then config dir, then log dir parent', () => {
    assert.equal(probe.resolveCapabilityCachePath({ GATEWAY_CAPABILITY_CACHE_PATH: 'C:\\cache\\x.json' }), 'C:\\cache\\x.json');
    assert.equal(
        probe.resolveCapabilityCachePath({ GATEWAY_CONFIG_PATH: '%APPDATA%\\NV-Gateway\\config.json' }),
        path.join('%APPDATA%\\NV-Gateway', 'reasoning-capabilities.json')
    );
    assert.equal(
        probe.resolveCapabilityCachePath({ GATEWAY_LOG_PATH: '%APPDATA%\\NV-Gateway\\logs\\gateway.jsonl' }),
        path.join('%APPDATA%\\NV-Gateway', 'reasoning-capabilities.json')
    );
    assert.equal(probe.resolveCapabilityCachePath({}), null);
});

// ---------------------------------------------------------------------------
// 2. Service layer — mocked upstream, no network
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1b. STRICT rejection classification (stability-audit fix #1)
// ---------------------------------------------------------------------------

test('classifier accepts only validation errors that clearly target reasoning_effort', () => {
    // Explicit field mention ⇒ rejected.
    assert.equal(probe.isReasoningEffortValidationRejection(syncJsonResponse(400, { error: { message: "model does not support reasoning_effort='max'" } })), true);
    assert.equal(probe.isReasoningEffortValidationRejection(syncJsonResponse(422, { error: { message: "invalid reasoning effort value" } })), true);
    // "unknown variant" ⇒ rejected.
    assert.equal(probe.isReasoningEffortValidationRejection(syncJsonResponse(400, { error: { message: "unknown variant: bogus" } })), true);
    // Enum-listing window with effort-shaped values ⇒ rejected (reuses parser patterns).
    assert.equal(probe.isReasoningEffortValidationRejection(syncJsonResponse(400, { error: { message: "Invalid value for 'reasoning_effort': expected one of 'low', 'high', but got 'bogus_probe'." } })), true);
    // Generic 400 about an unrelated field is NOT a rejection.
    assert.equal(probe.isReasoningEffortValidationRejection(syncJsonResponse(400, { error: { message: "context length exceeded" } })), false);
    assert.equal(probe.isReasoningEffortValidationRejection(syncJsonResponse(400, { error: { message: "role expected one of ['system','user']" } })), false, 'listing window must contain effort-shaped values');
    // Non-400/422 statuses are never rejections; empty bodies neither.
    assert.equal(probe.isReasoningEffortValidationRejection(syncJsonResponse(429, { error: { message: 'reasoning_effort rate limited' } })), false);
    assert.equal(probe.isReasoningEffortValidationRejection(syncJsonResponse(500, { error: { message: 'reasoning_effort blew up' } })), false);
    assert.equal(probe.isReasoningEffortValidationRejection({ status: 400, text: '', parsed: null }), false);
    assert.equal(probe.isReasoningEffortValidationRejection(null), false);
});

test('discoverReasoningModes verifies every listed value per-model (listing alone can overstate)', async () => {
    // Real-world shape: the 400 listing is an ENDPOINT enum union; execution
    // then rejects variants this specific model does not support (kimi-k3).
    const { calls, impl } = recordingResponder((args) => {
        const effort = JSON.parse(args.body).reasoning_effort;
        if (effort === probe.PROBE_SENTINEL) return listing400(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])(args);
        if (effort === 'minimal' || effort === 'medium' || effort === 'xhigh') return jsonResponse(400, { error: { message: `Invalid reasoning_effort: model does not support effort '${effort}'.` } })();
        return jsonResponse(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] })();
    });
    const entry = await probe.discoverReasoningModes('moonshotai/kimi-k3', { apiKey: 'k', requestImpl: impl });
    assert.equal(calls.length, 1 + 7, 'sentinel + one tiny verification per listed value');
    assert.deepEqual(entry.modes, ['none', 'low', 'high', 'max'], 'rejected variants must be marked out');
    assert.equal(entry.defaultMode, 'high');
    assert.equal(entry.supported, true);
    assert.equal(entry.source, 'probed');
    assert.equal(entry.method, 'validation_error+verified');
    assert.match(entry.evidence, /expected one of/, 'raw listing message kept as evidence');
});

test('discoverReasoningModes falls back to individual probing when sentinel is ACCEPTED (200)', async () => {
    const { calls, impl } = recordingResponder((args) => {
        const effort = JSON.parse(args.body).reasoning_effort;
        if (effort === 'low') return jsonResponse(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] })();
        return jsonResponse(422, { error: { message: `Invalid reasoning_effort: bad effort '${effort}'` } })();
    });
    // Sentinel accepted → the field is unvalidated, so the probe walks the
    // (restricted) candidate list to find what actually works.
    const entry = await probe.discoverReasoningModes('some/model', {
        apiKey: 'k',
        candidates: ['low', 'medium', 'high'],
        requestImpl: impl
    });
    assert.ok(entry);
    assert.equal(calls.length, 1 + 3); // sentinel + each candidate
    assert.deepEqual(entry.modes, ['low']);
    assert.equal(entry.defaultMode, 'low');
    assert.equal(entry.source, 'probed');
});

test('individual fallback keeps accepted candidates and rejects validation-marked ones in canonical order', async () => {
    const { calls, impl } = recordingResponder((args) => {
        const effort = JSON.parse(args.body).reasoning_effort;
        if (effort === 'low' || effort === 'xhigh' || effort === 'max') return jsonResponse(200, { choices: [{ message: { role: 'assistant', content: 'ok', reasoning_content: 'thinking…' } }] })();
        return jsonResponse(400, { error: { message: `invalid reasoning_effort value '${effort}'` } })();
    });
    const entry = await probe.discoverReasoningModes('some/model', { apiKey: 'k', requestImpl: impl });
    assert.deepEqual(entry.modes, ['low', 'xhigh', 'max']);
    assert.equal(entry.defaultMode, 'max'); // no 'high' present → highest listed
    assert.equal(entry.supported, true);
    assert.equal(entry.method, 'candidates');
    // Full candidate list was walked: 8 candidates + 1 sentinel.
    assert.equal(calls.length, 1 + probe.PROBE_CANDIDATES.length);
    // Per-mode evidence records the verdicts.
    assert.equal(entry.verification.low.result, 'accepted');
    assert.equal(entry.verification.medium.result, 'rejected');
    assert.match(entry.verification.medium.evidence, /reasoning_effort/);
});

test('per-value INCONCLUSIVE outcomes keep values LISTED and never abort the walk', async () => {
    let seen = 0;
    const { calls, impl } = recordingResponder((args) => {
        seen++;
        const effort = JSON.parse(args.body).reasoning_effort;
        if (effort === 'low') return jsonResponse(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] })();
        if (effort === 'medium') return jsonResponse(429, { error: { message: 'rate limited' } })();          // other 4xx
        if (effort === 'high') return jsonResponse(503, { error: { message: 'upstream burning' } })();       // 5xx
        if (effort === 'xhigh') throw new Error('socket hang up');                                            // network
        if (effort === 'max') return jsonResponse(400, { error: { message: 'context length exceeded' } })(); // non-validation 400
        return jsonResponse(400, { error: { message: `invalid reasoning_effort value '${effort}'` } })();    // true rejections
    });
    const entry = await probe.discoverReasoningModes('some/model', { apiKey: 'k', requestImpl: impl });
    assert.ok(entry, 'an inconclusive per-value outcome must NOT null the whole probe');
    // EVERY candidate was still verified — the loop never aborted early.
    assert.equal(seen, 1 + probe.PROBE_CANDIDATES.length);
    assert.deepEqual(calls.map((c) => JSON.parse(c.body).reasoning_effort),
        [probe.PROBE_SENTINEL, ...probe.PROBE_CANDIDATES]);
    // Accepted + INCONCLUSIVE values stay listed; validated rejections drop out.
    assert.deepEqual(entry.modes,
        ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter((m) => !['none', 'off', 'minimal'].includes(m)));
    assert.equal(entry.supported, true);
    assert.equal(entry.verification.low.result, 'accepted');
    assert.equal(entry.verification.medium.result, 'inconclusive');
    assert.equal(entry.verification.medium.httpStatus, 429);
    assert.equal(entry.verification.high.result, 'inconclusive');
    assert.equal(entry.verification.high.httpStatus, 503);
    assert.equal(entry.verification.xhigh.result, 'inconclusive');
    assert.match(entry.verification.xhigh.evidence, /socket hang up/);
    assert.equal(entry.verification.max.result, 'inconclusive', 'non-validation 400 body must NOT count as rejection');
    assert.match(entry.verification.max.evidence, /context length/);
    assert.equal(entry.verification.none.result, 'rejected');
    assert.equal(entry.verification.off.result, 'rejected');
    assert.equal(entry.verification.minimal.result, 'rejected');
});

test('all-candidates-rejected yields a supported=false finding, not a failure', async () => {
    const impl = jsonResponse(400, { error: { message: 'reasoning_effort is not supported by this model' } });
    const entry = await probe.discoverReasoningModes('some/model', { apiKey: 'k', requestImpl: impl });
    assert.ok(entry);
    assert.deepEqual(entry.modes, []);
    assert.equal(entry.supported, false);
    assert.equal(entry.controlKey, null);
    assert.equal(entry.source, 'probed');
});

test('network failure on the sentinel request returns null', async () => {
    const impl = async () => { throw new Error('ECONNREFUSED'); };
    const entry = await probe.discoverReasoningModes('some/model', { apiKey: 'k', requestImpl: impl });
    assert.equal(entry, null);
});

test('discoverReasoningModes refuses to run without an api key or model id', async () => {
    assert.equal(await probe.discoverReasoningModes('some/model', { apiKey: '' }), null);
    assert.equal(await probe.discoverReasoningModes('', { apiKey: 'k' }), null);
    assert.equal(await probe.discoverReasoningModes(null, { apiKey: 'k' }), null);
});

// ---------------------------------------------------------------------------
// 3. Cache: TTL, concurrency guard, persistence, merge
// ---------------------------------------------------------------------------

test('probeAndCache skips upstream while fresh, re-probes after TTL, force bypasses TTL', async () => {
    const cacheFile = path.join(fileTempRoot, 'ttl-cache', 'reasoning-capabilities.json');
    probe.resetCapabilityProbeState({ cachePath: cacheFile, ttlMs: 1000 });
    let clock = 1_000_000;
    const now = () => clock;
    // One full probe = sentinel + 2 verifications = 3 upstream requests.
    const { calls, impl } = recordingResponder(listingThenAccept(['low', 'high']));

    const first = await probe.probeAndCacheReasoningModes('a/model', { apiKey: 'k', requestImpl: impl, now });
    assert.ok(first);
    assert.equal(calls.length, 3);
    assert.equal(first.probedAt, clock);

    // Fresh → served from cache, no new upstream call.
    const fresh = await probe.probeAndCacheReasoningModes('a/model', { apiKey: 'k', requestImpl: impl, now });
    assert.deepEqual(fresh.modes, first.modes);
    assert.equal(calls.length, 3, 'fresh entries must not re-probe');

    clock += 999; // 999ms elapsed — still inside the 1000ms TTL
    await probe.probeAndCacheReasoningModes('a/model', { apiKey: 'k', requestImpl: impl, now });
    assert.equal(calls.length, 3, 'still fresh at 999ms');

    clock += 2; // 1001ms since probedAt → stale → background-style re-probe
    const staleRefresh = await probe.probeAndCacheReasoningModes('a/model', { apiKey: 'k', requestImpl: impl, now });
    assert.ok(staleRefresh);
    assert.equal(calls.length, 6, 'stale entry must trigger a fresh probe');
    assert.equal(staleRefresh.probedAt, clock);

    clock += 1; // would be stale again…
    await probe.probeAndCacheReasoningModes('a/model', { apiKey: 'k', requestImpl: impl, now, force: true }); // …but force re-probes regardless
    assert.equal(calls.length, 9, 'force must bypass the TTL window');

    assert.equal(fs.existsSync(cacheFile), true, 'cache file must persist after probes');
});

test('concurrent probes for one model share a single in-flight upstream sequence', async () => {
    const cacheFile = path.join(fileTempRoot, 'guard-cache', 'r.json');
    probe.resetCapabilityProbeState({ cachePath: cacheFile });
    let sentinelRequests = 0;
    let totalRequests = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const impl = async (args) => {
        totalRequests++;
        if (JSON.parse(args.body).reasoning_effort === probe.PROBE_SENTINEL) sentinelRequests++;
        await gate;
        return listingThenAccept(['low', 'max'])(args);
    };
    const p1 = probe.probeAndCacheReasoningModes('g/model', { apiKey: 'k', requestImpl: impl });
    const p2 = probe.probeAndCacheReasoningModes('g/model', { apiKey: 'k', requestImpl: impl });
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(sentinelRequests, 1, 'second caller must join the in-flight probe (single sentinel)');
    assert.equal(totalRequests, 3, 'exactly ONE sequence of sentinel + verifications ran');
    assert.deepEqual(r1, r2);
    assert.deepEqual(r1.modes, ['low', 'max']);
});

test('a failed re-probe leaves the previously cached entry intact', async () => {
    probe.resetCapabilityProbeState({ cachePath: path.join(fileTempRoot, 'keep-cache', 'r.json') });
    const good = await probe.probeAndCacheReasoningModes('k/model', { apiKey: 'k', requestImpl: listing400(['low', 'high']) });
    assert.ok(good);
    const failing = await probe.probeAndCacheReasoningModes('k/model', { apiKey: 'k', requestImpl: async () => { throw new Error('down'); }, force: true });
    assert.equal(failing, null);
    const cached = probe.getCachedReasoningCapability('k/model');
    assert.deepEqual(cached.modes, good.modes, 'previous probed truth must survive a failed refresh');
});

// ---------------------------------------------------------------------------
// 2b. Hysteresis — dropping verified modes needs two consecutive adverse probes
// ---------------------------------------------------------------------------

test('hysteresis: first adverse probe keeps the mode, second consecutive drops it, acceptance recovers it', async () => {
    const cacheFile = path.join(fileTempRoot, 'hyst-cache', 'r.json');
    probe.resetCapabilityProbeState({ cachePath: cacheFile });
    let clock = 5_000_000;
    const now = () => clock;
    let rejectHigh = false;
    const impl = (args) => {
        const effort = JSON.parse(args.body).reasoning_effort;
        if (effort === probe.PROBE_SENTINEL) return listing400(['low', 'high'])(args);
        if (effort === 'high' && rejectHigh) return jsonResponse(400, { error: { message: "Invalid reasoning_effort: model does not support effort 'high'." } })();
        return jsonResponse(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] })();
    };

    // Cycle 1: low+high both verified.
    const first = await probe.probeAndCacheReasoningModes('h/model', { apiKey: 'k', requestImpl: impl, now });
    assert.deepEqual(first.modes, ['low', 'high']);

    // Cycle 2: high REJECTED once → still advertised (grace), stamp + evidence kept.
    rejectHigh = true;
    clock += 10_000;
    const second = await probe.probeAndCacheReasoningModes('h/model', { apiKey: 'k', requestImpl: impl, now, force: true });
    assert.deepEqual(second.modes, ['low', 'high'], 'a single adverse probe must NOT drop a verified mode');
    assert.ok(second.rejectedOnce && Number.isFinite(second.rejectedOnce.high), 'rejectedOnce timestamp stored in the cache entry');
    assert.equal(second.verification.high.heldByHysteresis, true);
    assert.equal(second.verification.high.result, 'rejected');

    // Cycle 3: SECOND consecutive adverse probe → dropped for good.
    clock += 10_000;
    const third = await probe.probeAndCacheReasoningModes('h/model', { apiKey: 'k', requestImpl: impl, now, force: true });
    assert.deepEqual(third.modes, ['low']);
    assert.equal(third.rejectedOnce, undefined, 'stamp cleared once the drop is confirmed');

    // Cycle 4: upstream accepts again → mode recovers immediately.
    rejectHigh = false;
    clock += 10_000;
    const fourth = await probe.probeAndCacheReasoningModes('h/model', { apiKey: 'k', requestImpl: impl, now, force: true });
    assert.deepEqual(fourth.modes, ['low', 'high']);
});

test('hysteresis holds a previously-verified PROBED mode absent from the fresh probe (one-cycle grace)', async () => {
    const cacheFile = path.join(fileTempRoot, 'hyst-static-cache', 'r.json');
    probe.resetCapabilityProbeState({ cachePath: cacheFile });
    let clock = 9_000_000;
    const now = () => clock;
    // Seed an entry that CAME FROM A REAL PROBE, then run a fresh probe whose
    // upstream rejects everything (listing shrank to nothing usable): the
    // previously-verified mode must survive one adverse cycle.
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        entries: { 's/model': { modes: ['xhigh'], defaultMode: 'xhigh', supported: true, controlKey: 'reasoning_effort', probedAt: clock - 1000, source: 'probed' } }
    }));
    probe.resetCapabilityProbeState({ cachePath: cacheFile });
    const next = await probe.probeAndCacheReasoningModes('s/model', { apiKey: 'k', requestImpl: listing400(['low']), now, force: true });
    // Fresh probe found NOTHING accepted (the listing itself rejects 'low');
    // previously-verified 'xhigh' was never re-listed → hysteresis holds it.
    assert.deepEqual(next.modes, ['xhigh']);
    assert.equal(next.supported, false);
    assert.ok(Number.isFinite(next.rejectedOnce.xhigh));
    assert.equal(next.verification.xhigh.heldByHysteresis, true);
    assert.match(next.verification.xhigh.evidence, /absent from fresh probe/);
});

test('fallback-source predecessors are replaced IMMEDIATELY by a fresh probe (no hysteresis grace, no stamps)', async () => {
    const cacheFile = path.join(fileTempRoot, 'hyst-fallback-cache', 'r.json');
    let clock = 11_000_000;
    const now = () => clock;
    // Seed a STATIC ('fallback') guess listing modes a fresh probe will not all
    // confirm. Unlike a probed predecessor, it earns NO one-cycle grace: the
    // next definitive probe replaces it outright.
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        entries: { 'fb/model': { modes: ['low', 'xhigh'], defaultMode: 'xhigh', supported: true, controlKey: 'reasoning_effort', probedAt: clock - 1000, source: 'fallback' } }
    }));
    probe.resetCapabilityProbeState({ cachePath: cacheFile });

    // Fresh verified truth: only 'low' survives (sentinel lists ['low']; the
    // per-value verification accepts it). If hysteresis wrongly applied,
    // 'xhigh' would be held back and stamped.
    const next = await probe.probeAndCacheReasoningModes('fb/model', { apiKey: 'k', requestImpl: listingThenAccept(['low']), now, force: true });
    assert.deepEqual(next.modes, ['low'], 'static guess must not hold back the fresh probed result');
    assert.equal(next.supported, true);
    assert.equal(next.controlKey, 'reasoning_effort');
    assert.equal(next.source, 'probed');
    assert.equal(next.rejectedOnce, undefined, 'no rejectedOnce stamps for fallback predecessors');
    assert.equal(next.verification.xhigh, undefined, 'no heldByHysteresis annotation for fallback predecessors');
    assert.equal(next.verification.low.result, 'accepted');
});

test('cache format v2: v1 files migrate, future versions ignored, saves bump to 2', async () => {
    const dir = path.join(fileTempRoot, 'fmt-cache');
    const cacheFile = path.join(dir, 'r.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
        version: 1,
        savedAt: '2026-01-01T00:00:00.000Z',
        entries: { 'legacy/model': { modes: ['low', 'max'], defaultMode: 'max', supported: true, controlKey: 'reasoning_effort', probedAt: 1_000, source: 'probed' } }
    }));
    probe.resetCapabilityProbeState({ cachePath: cacheFile });
    const migrated = probe.getCachedReasoningCapability('legacy/model');
    assert.ok(migrated, 'v1 payloads must be migrated verbatim');
    assert.deepEqual(migrated.modes, ['low', 'max']);

    // Unknown FUTURE format versions are ignored rather than misread.
    fs.writeFileSync(cacheFile, JSON.stringify({ version: 999, entries: { 'future/model': { modes: ['x'], probedAt: 1, source: 'probed' } } }));
    probe.resetCapabilityProbeState({ cachePath: cacheFile });
    assert.equal(probe.getCachedReasoningCapability('future/model'), null);

    // New writes carry the bumped format version.
    fs.rmSync(cacheFile, { force: true });
    probe.resetCapabilityProbeState({ cachePath: cacheFile });
    await probe.probeAndCacheReasoningModes('v2/model', { apiKey: 'k', requestImpl: listingThenAccept(['low']) });
    const onDisk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.equal(onDisk.version, 2);
});

test('cache persists across a simulated restart and tolerates a corrupt file', async () => {
    const cacheDir = path.join(fileTempRoot, 'restart-cache');
    const cacheFile = path.join(cacheDir, 'reasoning-capabilities.json');
    fs.rmSync(cacheDir, { recursive: true, force: true });

    probe.resetCapabilityProbeState({ cachePath: cacheFile });
    await probe.probeAndCacheReasoningModes('persist/model', { apiKey: 'k', requestImpl: listingThenAccept(['minimal', 'max']) });

    // "Restart": fresh module state reading the SAME file.
    probe.resetCapabilityProbeState({ cachePath: cacheFile });
    const restored = probe.getCachedReasoningCapability('persist/model');
    assert.ok(restored, 'entry must survive restart');
    assert.deepEqual(restored.modes, ['minimal', 'max']);
    assert.equal(restored.source, 'probed');

    // Corrupt file → empty cache, no crash.
    fs.writeFileSync(cacheFile, '{ this is not json');
    probe.resetCapabilityProbeState({ cachePath: cacheFile });
    assert.equal(probe.getCachedReasoningCapability('persist/model'), null);

    // Unknown model → null, never throws.
    assert.equal(probe.getCachedReasoningCapability('never/probed'), null);
});

test('mergeProbedReasoning serves probed modes over static family metadata', () => {
    probe.resetCapabilityProbeState({ cachePath: path.join(fileTempRoot, 'merge-cache', 'r.json') });
    // No entry yet → static passes through untouched.
    const staticCaps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' }, tools: true, vision: false, audio: false };
    probe.mergeProbedReasoning(staticCaps, 'stepfun-ai/step-3.7-flash');
    assert.deepEqual(staticCaps.reasoning.modes, ['off', 'on']);

    // Seed a probed entry directly through the service.
    return probe.probeAndCacheReasoningModes('stepfun-ai/step-3.7-flash', { apiKey: 'k', requestImpl: listingThenAccept(['low', 'medium', 'high', 'xhigh', 'max']) }).then(() => {
        const caps = { reasoning: { supported: true, modes: ['off', 'on'], controlKey: 'chat_template_kwargs.thinking', defaultMode: 'on' }, tools: true, vision: false, audio: false };
        probe.mergeProbedReasoning(caps, 'stepfun-ai/step-3.7-flash');
        assert.deepEqual(caps.reasoning.modes, ['low', 'medium', 'high', 'xhigh', 'max']);
        assert.equal(caps.reasoning.defaultMode, 'high');
        assert.equal(caps.reasoning.controlKey, 'reasoning_effort');
        assert.equal(caps.reasoning.supported, true);
        // Non-reasoning modalities are NEVER touched by the merge.
        assert.equal(caps.tools, true);
        assert.equal(caps.vision, false);
        assert.equal(caps.audio, false);
    });
});

test('mergeProbedReasoning handles negative findings and malformed inputs safely', async () => {
    probe.resetCapabilityProbeState({ cachePath: path.join(fileTempRoot, 'merge-neg-cache', 'r.json') });
    await probe.probeAndCacheReasoningModes('neg/model', { apiKey: 'k', requestImpl: jsonResponse(400, { error: { message: 'reasoning_effort is not supported by this model' } }) });
    const caps = { reasoning: { supported: true, modes: ['on'], controlKey: 'x', defaultMode: 'on' } };
    probe.mergeProbedReasoning(caps, 'neg/model');
    assert.equal(caps.reasoning.supported, false);
    assert.deepEqual(caps.reasoning.modes, []);
    assert.equal(caps.reasoning.controlKey, null);

    // Null-ish inputs never throw.
    probe.mergeProbedReasoning(null, 'neg/model');
    probe.mergeProbedReasoning({}, 'neg/model');
    probe.mergeProbedReasoning({ reasoning: null }, 'neg/model');
});

// ---------------------------------------------------------------------------
// 4. Sweep scheduling gates
// ---------------------------------------------------------------------------

test('scheduleCapabilityRefresh respects disable/enable/sentinel gating and cooldown', async () => {
    const prevEnable = process.env.GATEWAY_CAPABILITY_PROBE_ENABLE;
    const prevDisable = process.env.GATEWAY_CAPABILITY_PROBE_DISABLE;
    const prevSentinel = process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT;
    try {
        probe.resetCapabilityProbeState({ cachePath: null });
        const impl = listing400(['low', 'high']);
        const keyProvider = () => 'k';

        // Hard opt-out wins.
        process.env.GATEWAY_CAPABILITY_PROBE_DISABLE = '1';
        delete process.env.GATEWAY_CAPABILITY_PROBE_ENABLE;
        assert.equal(probe.scheduleCapabilityRefresh(['a/m'], { keyProvider, requestImpl: impl }), 0);

        // Explicit enable beats BOTH the disable flag and the test sentinel.
        process.env.GATEWAY_CAPABILITY_PROBE_ENABLE = '1';
        process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT = '59999';
        const queued = probe.scheduleCapabilityRefresh(['a/m'], { keyProvider, requestImpl: impl });
        assert.ok(queued >= 1, 'explicit ENABLE must win over the test sentinel');

        // Cooldown: an immediate second sweep schedules nothing.
        assert.equal(probe.scheduleCapabilityRefresh(['a/m'], { keyProvider, requestImpl: impl, force: false }), 0);
        // …unless forced.
        assert.ok(probe.scheduleCapabilityRefresh(['a/m'], { keyProvider, requestImpl: impl, force: true }) >= 0);

        // Fresh entries are skipped even on a forced sweep (no reset here — the
        // entry cached by the sweep above must be visible to the skip logic).
        await waitFor(() => probe.getCachedReasoningCapability('a/m'));
        assert.equal(probe.scheduleCapabilityRefresh(['a/m'], { keyProvider, requestImpl: impl, force: true }), 0);
    } finally {
        if (prevEnable === undefined) delete process.env.GATEWAY_CAPABILITY_PROBE_ENABLE; else process.env.GATEWAY_CAPABILITY_PROBE_ENABLE = prevEnable;
        if (prevDisable === undefined) delete process.env.GATEWAY_CAPABILITY_PROBE_DISABLE; else process.env.GATEWAY_CAPABILITY_PROBE_DISABLE = prevDisable;
        if (prevSentinel === undefined) delete process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT; else process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT = prevSentinel;
        probe.resetCapabilityProbeState({ cachePath: null });
    }
});

test('sweep caps models per run and only queues stale/missing ids', async () => {
    const prevMax = process.env.GATEWAY_CAPABILITY_PROBE_MAX_PER_SWEEP;
    const prevDisable = process.env.GATEWAY_CAPABILITY_PROBE_DISABLE;
    try {
        probe.resetCapabilityProbeState({ cachePath: null });
        process.env.GATEWAY_CAPABILITY_PROBE_MAX_PER_SWEEP = '3';
        process.env.GATEWAY_CAPABILITY_PROBE_ENABLE = '1';
        delete process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT;

        // Prime one FRESH entry — it must not be queued again.
        await probe.probeAndCacheReasoningModes('fresh/model', { apiKey: 'k', requestImpl: listing400(['low']) });

        const queued = probe.scheduleCapabilityRefresh(
            ['fresh/model', 'z/model', 'a/model', 'm/model', 'b/model'],
            { keyProvider: () => 'k', requestImpl: listing400(['low']), force: true }
        );
        // fresh/model is skipped; z/a/m/b sorted then capped at MAX_PER_SWEEP=3.
        assert.equal(queued, 3);
    } finally {
        if (prevMax === undefined) delete process.env.GATEWAY_CAPABILITY_PROBE_MAX_PER_SWEEP; else process.env.GATEWAY_CAPABILITY_PROBE_MAX_PER_SWEEP = prevMax;
        if (prevDisable === undefined) delete process.env.GATEWAY_CAPABILITY_PROBE_DISABLE; else process.env.GATEWAY_CAPABILITY_PROBE_DISABLE = prevDisable;
        delete process.env.GATEWAY_CAPABILITY_PROBE_ENABLE;
        probe.resetCapabilityProbeState({ cachePath: null });
    }
});

// ---------------------------------------------------------------------------
// 5. Spawned-gateway integration (fake local upstream — NO network)
// ---------------------------------------------------------------------------

function request(port, urlPath, method = 'GET', body = '', token = 'test-gateway-token') {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: urlPath,
            method,
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body)
            }
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function startGatewayHarness({ keys, handleUpstreamRequest, extraEnv = {} }) {
    const dir = fs.mkdtempSync(path.join(fileTempRoot, 'gw-'));
    const statePath = path.join(dir, 'keys.json');
    const logPath = path.join(dir, 'logs', 'gateway.jsonl');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
        keys: keys.map((key, index) => ({ id: `key-${index}`, key, status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: index + 1 } }))
    }));
    const capturedChatBodies = [];
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString();
            handleUpstreamRequest({ req, res, rawBody, method: req.method, url: req.url, capturedChatBodies });
        });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    let port;
    let child;
    let ready = false;
    for (let startAttempt = 0; startAttempt < 3 && !ready; startAttempt++) {
        port = await freePortPair();
        child = spawn(process.execPath, ['--require', path.join(root, 'tests/local-upstream-preload.cjs'), path.join(root, 'src/gateway/server.mjs')], {
            env: {
                ...process.env,
                GATEWAY_LOG_PATH: logPath,
                GATEWAY_CAPABILITY_CACHE_PATH: path.join(dir, 'reasoning-capabilities.json'),
                GATEWAY_MODEL_DISCOVERY_DISABLE_WARM: '1',
                GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstream.address().port),
                PORT: String(port),
                ...extraEnv
            },
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            windowsHide: true
        });
        child.once('message', (message) => {
            if (message?.type === 'ready') child.send({
                type: 'state:init',
                challenge: message.challenge,
                state: { keys: JSON.parse(fs.readFileSync(statePath, 'utf8')).keys, credentials: { gatewayToken: 'test-gateway-token', adminToken: 'test-admin-token' } }
            });
        });
        child.on('message', (message) => { if (message?.type === 'state:persist') fs.writeFileSync(statePath, JSON.stringify(message.state)); });
        const readinessDeadline = Date.now() + 20_000;
        while (Date.now() < readinessDeadline) {
            try { if ((await request(port, '/health')).statusCode === 200) { ready = true; break; } } catch {}
            if (child.exitCode !== null) break;
            await delay(25);
        }
        if (!ready) await stopChild(child);
    }
    if (!ready) {
        upstream.closeAllConnections?.();
        await new Promise((resolve) => upstream.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error('Gateway did not become healthy.');
    }
    return {
        port, dir, logPath, capturedChatBodies, statePath,
        close: async () => {
            await stopChild(child);
            upstream.closeAllConnections?.();
            await new Promise((resolve) => upstream.close(resolve));
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };
}

async function stopChild(child) {
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
        const force = setTimeout(() => child.kill('SIGKILL'), 1_000);
        child.once('exit', () => { clearTimeout(force); resolve(); });
        child.kill();
    });
}

async function freePortPair() {
    while (true) {
        const first = http.createServer();
        await new Promise((resolve) => first.listen(0, '127.0.0.1', resolve));
        const port = first.address().port;
        await new Promise((resolve) => first.close(resolve));
        if (port >= 65534) continue;
        const second = http.createServer();
        try { await new Promise((resolve, reject) => { second.once('error', reject); second.listen(port + 1, '127.0.0.1', resolve); }); }
        catch { continue; }
        await new Promise((resolve) => second.close(resolve));
        return port;
    }
}

const STATIC_MODELS_BODY = JSON.stringify({
    data: [
        { id: 'stepfun-ai/step-3.7-flash', object: 'model', owned_by: 'stepfun-ai' },
        { id: 'meta/llama-3.1-8b-instruct', object: 'model', owned_by: 'meta' }
    ]
});

test('/v1/models serves static capabilities first, then LIVE-probed modes once discovered', async () => {
    const harness = await startGatewayHarness({
        keys: ['key-a'],
        // Probe flow per model:
        //   stepfun sentinel → 400 LISTING allowed values (the fast path);
        //   meta/* → 400 with NO list for every effort (a supported=false finding).
        handleUpstreamRequest: ({ method, url, res, rawBody }) => {
            if (method === 'GET' && url === '/v1/models') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(STATIC_MODELS_BODY);
                return;
            }
            if (method === 'POST' && url === '/v1/chat/completions') {
                let parsed = {};
                try { parsed = JSON.parse(rawBody); } catch {}
                const isMeta = typeof parsed.model === 'string' && parsed.model.startsWith('meta/');
                if (!isMeta && parsed.reasoning_effort === 'bogus_probe') {
                    res.writeHead(400, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({
                        error: {
                            message: "Invalid value for 'reasoning_effort': expected one of 'low', 'medium', 'high', 'xhigh', 'max', but got 'bogus_probe'.",
                            type: 'invalid_request_error'
                        }
                    }));
                    return;
                }
                if (!isMeta) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
                    return;
                }
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'This model does not support reasoning_effort.' } }));
                return;
            }
            res.writeHead(404);
            res.end('{}');
        },
        extraEnv: {
            GATEWAY_CAPABILITY_PROBE_ENABLE: '1'
        }
    });
    try {
        const before = JSON.parse((await request(harness.port, '/v1/models')).body);
        const stepBefore = before.data.find((m) => m.id === 'stepfun-ai/step-3.7-flash');
        assert.deepEqual(stepBefore.capabilities.reasoning.modes, ['off', 'on'], 'FIRST response must serve static family modes immediately');
        assert.equal(stepBefore.capabilities.reasoning.controlKey, 'chat_template_kwargs.thinking');

        // Background sweep runs post-response; poll until the probed result lands.
        let served = null;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            const res = await request(harness.port, '/v1/models');
            const parsed = JSON.parse(res.body);
            const step = parsed.data.find((m) => m.id === 'stepfun-ai/step-3.7-flash');
            if (Array.isArray(step?.capabilities?.reasoning?.modes)
                && step.capabilities.reasoning.modes.join(',') === 'low,medium,high,xhigh,max') {
                served = step;
                break;
            }
            await delay(100);
        }
        assert.ok(served, '/v1/models must eventually advertise the PROBED modes');
        assert.deepEqual(served.capabilities.reasoning.modes, ['low', 'medium', 'high', 'xhigh', 'max']);
        assert.equal(served.capabilities.reasoning.defaultMode, 'high');
        assert.equal(served.capabilities.reasoning.controlKey, 'reasoning_effort');
        assert.equal(served.capabilities.reasoning.supported, true);
        // A non-probed model keeps its untouched static metadata.
        const meta = JSON.parse((await request(harness.port, '/v1/models')).body).data.find((m) => m.id === 'meta/llama-3.1-8b-instruct');
        assert.equal(meta.capabilities.reasoning.supported, false);
        assert.deepEqual(meta.capabilities.reasoning.modes, []);

        // Restart persistence: the cache file exists next to config/state paths.
        assert.equal(fs.existsSync(path.join(harness.dir, 'reasoning-capabilities.json')), true, 'probed cache must be persisted');
    } finally {
        await harness.close();
    }
});

test('chat bodies pass reasoning_effort and chat_template_kwargs through to upstream UNTOUCHED (lock)', async () => {
    const sentBody = JSON.stringify({
        model: 'z-ai/glm-5.2',
        stream: false,
        messages: [{ role: 'user', content: 'ping' }],
        reasoning_effort: 'xhigh',
        chat_template_kwargs: { thinking: true, enable_thinking: true },
        future_unknown_field: { nested: [1, 2, 3] }
    });
    const harness = await startGatewayHarness({
        keys: ['key-a'],
        handleUpstreamRequest: ({ method, url, res, rawBody, capturedChatBodies }) => {
            if (method === 'POST' && url === '/v1/chat/completions') {
                capturedChatBodies.push(rawBody);
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
                return;
            }
            res.writeHead(404);
            res.end('{}');
        },
        extraEnv: { GATEWAY_CAPABILITY_PROBE_DISABLE: '1' }
    });
    try {
        const response = await request(harness.port, '/v1/chat/completions', 'POST', sentBody);
        assert.equal(response.statusCode, 200);
        assert.equal(harness.capturedChatBodies.length, 1);
        // BYTE-level equality: the gateway forwards the client chat body as-is.
        assert.equal(harness.capturedChatBodies[0], sentBody);
        // Field-level double-check of the contract under lock.
        const forwarded = JSON.parse(harness.capturedChatBodies[0]);
        assert.equal(forwarded.reasoning_effort, 'xhigh');
        assert.deepEqual(forwarded.chat_template_kwargs, { thinking: true, enable_thinking: true });
        assert.deepEqual(forwarded.future_unknown_field, { nested: [1, 2, 3] });
    } finally {
        await harness.close();
    }
});

test('an inconclusive probe (upstream 5xx) NEVER breaks /v1/models — static stays served', async () => {
    const harness = await startGatewayHarness({
        keys: ['key-a'],
        handleUpstreamRequest: ({ method, url, res }) => {
            if (method === 'GET' && url === '/v1/models') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(STATIC_MODELS_BODY);
                return;
            }
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'upstream burning' } }));
        },
        extraEnv: { GATEWAY_CAPABILITY_PROBE_ENABLE: '1' }
    });
    try {
        const first = await request(harness.port, '/v1/models');
        assert.equal(first.statusCode, 200);
        await delay(1500); // give any background probe time to fail
        const second = await request(harness.port, '/v1/models');
        assert.equal(second.statusCode, 200, 'models endpoint must stay healthy after probe failure');
        const parsed = JSON.parse(second.body);
        const step = parsed.data.find((m) => m.id === 'stepfun-ai/step-3.7-flash');
        assert.deepEqual(step.capabilities.reasoning.modes, ['off', 'on'], 'static fallback must remain');
        assert.equal(fs.existsSync(path.join(harness.dir, 'reasoning-capabilities.json')), false, 'inconclusive probe must not write cache entries');
        assert.equal((await request(harness.port, '/health')).statusCode, 200);
    } finally {
        await harness.close();
    }
});
