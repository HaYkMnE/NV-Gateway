import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const fileTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-p0-backend-${process.pid}-`));
test.after(() => fs.rmSync(fileTempRoot, { recursive: true, force: true }));

test('failover policy has bounded attempts, complete status matrix, and Retry-After parsing', async () => {
  const policy = await import(pathToFileURL(path.join(root, 'src/gateway/failover-policy.mjs')).href);
  assert.equal(policy.resolveMaxFailoverAttempts({}), 3);
  for (const invalid of ['0', '9', '2.5', 'garbage']) assert.equal(policy.resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: invalid }), 3);
  assert.equal(policy.resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '8' }), 8);
  for (const status of [401, 403, 429, 500, 502, 503, 504, 529]) assert.equal(policy.classifyUpstreamStatus(status).retryable, true);
  for (const status of [400, 404, 410, 422]) assert.equal(policy.classifyUpstreamStatus(status).retryable, false);
  assert.equal(policy.parseRetryAfter('15', 0), 15);
  assert.equal(policy.parseRetryAfter(new Date(20_000).toUTCString(), 0), 20);
  assert.equal(policy.parseRetryAfter('999999', 0), policy.MAX_RETRY_AFTER_SECONDS);
  assert.equal(policy.parseRetryAfter('-1', 0), policy.MIN_RETRY_AFTER_SECONDS);
});

test('buffer limit is bounded and collector rejects oversized byte streams', async () => {
  const buffers = await import(pathToFileURL(path.join(root, 'src/gateway/bounded-buffer.mjs')).href);
  assert.equal(buffers.resolveMaxBufferedResponseBytes({}), 5 * 1024 * 1024);
  assert.equal(buffers.resolveMaxBufferedResponseBytes({ GATEWAY_MAX_BUFFERED_RESPONSE_BYTES: '0' }), 5 * 1024 * 1024);
  const collector = buffers.createBoundedBuffer(4);
  assert.equal(collector.push(Buffer.from('1234')), true);
  assert.equal(collector.push(Buffer.from('5')), false);
  assert.throws(() => collector.toBuffer(), /exceeded/);
});

test('rotation skips invalid persisted keys and normalizes additions', async () => {
  const dir = fs.mkdtempSync(path.join(fileTempRoot, 'rotation-'));
  const statePath = path.join(dir, 'keys.json');
  const logPath = path.join(dir, 'gateway.jsonl');
  fs.writeFileSync(statePath, JSON.stringify({ keys: [
    { id: 'blank', key: '   ' },
    { id: 'valid', apiKey: '  valid-key  ' },
    { id: 'huge', key: 'x'.repeat(20_000) }
  ] }));
  process.env.GATEWAY_STATE_PATH = statePath;
  process.env.GATEWAY_LOG_PATH = logPath;
  const rotation = await import(`${pathToFileURL(path.join(root, 'src/gateway/rotation.mjs')).href}?p0=${Date.now()}`);
  try {
    rotation.initializeState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
    rotation.setPersistenceAdapter((state) => fs.writeFileSync(statePath, JSON.stringify(state)));
    const normalized = rotation.getKeys();
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].key, 'valid-key');
    assert.match(normalized[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(rotation.addKey('   '), null);
    assert.equal(rotation.addKey(' valid-key '), null);
    assert.equal(rotation.addKey('x'.repeat(20_000)), null);
    assert.equal(rotation.addKey(' new-key ')?.key, 'new-key');
    rotation.markKeyUsedAndDebounceSave(normalized[0].id, { success: true });
    rotation.flushState();
    assert.equal(JSON.parse(fs.readFileSync(statePath)).keys.find((key) => key.id === normalized[0].id).usage.success, 1);
  } finally {
    rotation.closeStateWatcher();
    const logger = await import(pathToFileURL(path.join(root, 'src/gateway/logger.mjs')).href);
    logger.closeLogger();
  }
});

test('one logical request selects one distinct key per failover attempt without mutating a discarded key', async () => {
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c'],
    responses: [{ status: 503 }, { status: 429 }, { status: 200, body: '{"ok":true}' }]
  });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.deepEqual(result, { statusCode: 200, body: '{"ok":true}' });
    assert.deepEqual(harness.seenAuthorizations, ['Bearer key-a', 'Bearer key-b', 'Bearer key-c']);
    const selectionEvents = JSON.parse(fs.readFileSync(harness.statePath, 'utf8')).keys.map((key) => key.usage.lastUsed);
    assert.equal(selectionEvents[0] > 0, true);
    assert.equal(selectionEvents[1] > selectionEvents[0], true);
    assert.equal(selectionEvents[2] > selectionEvents[1], true);
  } finally {
    await harness.close();
  }
});

test('runtime single-instance helper quits lock-denied launch and restores, shows, and focuses the existing window', async () => {
  const { configureSingleInstance } = await import(pathToFileURL(path.join(root, 'build/src/main/single-instance.js')).href);
  const events = [];
  let secondInstance;
  const denied = configureSingleInstance({ requestSingleInstanceLock: () => false, quit: () => events.push('quit'), on: () => {} }, () => null);
  assert.equal(denied, false);
  assert.deepEqual(events, ['quit']);

  const window = { isMinimized: () => true, restore: () => events.push('restore'), show: () => events.push('show'), focus: () => events.push('focus') };
  const accepted = configureSingleInstance({ requestSingleInstanceLock: () => true, quit: () => {}, on: (_name, listener) => { secondInstance = listener; } }, () => window);
  assert.equal(accepted, true);
  secondInstance();
  assert.deepEqual(events, ['quit', 'restore', 'show', 'focus']);
});

test('failover retries the complete transient matrix, never retries terminal statuses, and stops after response commit', async () => {
  for (const status of [401, 403, 429, 500, 502, 503, 504, 529]) {
    const harness = await startGatewayHarness({ keys: ['key-a', 'key-b'], responses: [{ status }, { status: 200, body: '{"ok":true}' }] });
    try {
      assert.equal((await request(harness.port, '/v1/chat/completions', 'POST', '{}')).statusCode, 200);
      assert.equal(harness.seenAuthorizations.length, 2);
    } finally { await harness.close(); }
  }
  for (const status of [400, 404, 410, 422]) {
    const harness = await startGatewayHarness({ keys: ['key-a', 'key-b'], responses: [{ status }, { status: 200 }] });
    try {
      assert.equal((await request(harness.port, '/v1/chat/completions', 'POST', '{}')).statusCode, status);
      assert.equal(harness.seenAuthorizations.length, 1);
    } finally { await harness.close(); }
  }
  const committed = await startGatewayHarness({ keys: ['key-a', 'key-b'], responses: [{ status: 503, body: '{"partial":', abort: true }, { status: 200 }] });
  try {
    await requestTerminal(committed.port, '/v1/chat/completions', '{}');
    assert.equal(committed.seenAuthorizations.length, 1);
  } finally { await committed.close(); }
});

test('/v1/models applies failed-key state and Retry-After delta/date before choosing a distinct key', async () => {
  for (const retryAfter of ['2', new Date(Date.now() + 2_000).toUTCString()]) {
    const before = Date.now();
    const harness = await startGatewayHarness({ keys: ['key-a', 'key-b'], responses: [{ status: 503, headers: { 'retry-after': retryAfter } }, { status: 200, body: '{"data":[]}' }] });
    try {
      assert.deepEqual(await request(harness.port, '/v1/models'), { statusCode: 200, body: '{"data":[]}' });
      assert.deepEqual(harness.seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);
      const failed = await waitForState(harness.statePath, (state) => state.keys.some((key) => key.usage.fail === 1));
      assert.equal(failed.usage.fail, 1);
      assert.equal(failed.backoffUntil >= before + 900, true);
      assert.equal(failed.backoffUntil <= Date.now() + 3_000, true);
    } finally { await harness.close(); }
  }
});

test('/v1/models bounds upstream overflow and forwards 204 without a body', async () => {
  const oversizedBody = 'x'.repeat(1_025);
  const overflow = await startGatewayHarness({ keys: ['key-a'], maxBufferBytes: 1_024, responses: [{ status: 200, body: oversizedBody }] });
  try { assert.deepEqual(await request(overflow.port, '/v1/models'), { statusCode: 502, body: '{"error":"Upstream response too large"}' }); }
  finally { await overflow.close(); }
  const bodyless = await startGatewayHarness({ keys: ['key-a'], responses: [{ status: 204, body: 'must-not-forward' }] });
  try { assert.deepEqual(await request(bodyless.port, '/v1/models'), { statusCode: 204, body: '' }); }
  finally { await bodyless.close(); }
});

test('bounded non-stream success observation forwards an oversized body and accounts completion exactly once', async () => {
  const oversizedBody = 'x'.repeat(1_025);
  const harness = await startGatewayHarness({ keys: ['key-a'], maxBufferBytes: 1_024, responses: [{ status: 200, body: oversizedBody }] });
  try {
    assert.deepEqual(await request(harness.port, '/v1/chat/completions', 'POST', '{}'), { statusCode: 200, body: oversizedBody });
    await delay(1_100);
    const logs = fs.readFileSync(harness.logPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(logs.filter((entry) => entry.message === 'request_outcome' && entry.outcome === 'completed').length, 1);
  } finally { await harness.close(); }
});

test('malformed JSON body fails fast with 400 and never touches a key', async () => {
  const harness = await startGatewayHarness({ keys: ['key-a', 'key-b', 'key-c'], responses: [{ status: 200, body: '{"ok":true}' }] });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"stream":');
    assert.equal(result.statusCode, 400);
    assert.match(result.body, /invalid request body/);
    assert.deepEqual(harness.seenAuthorizations, [], 'no upstream key must be touched on invalid JSON');
  } finally { await harness.close(); }
});

test('pool-wide 429 propagates 429 with a supplied Retry-After instead of a generic 502', async () => {
  // A uniform 429 now stops after the confirming-attempt bound (default 2) rather
  // than covering the pool: NVIDIA scopes a 429 to the MODEL, so the third key
  // would answer 429 too. The honest status + Retry-After are what matter here;
  // the exact attempt count is pinned by the dedicated early-stop test below.
  const harness = await startGatewayHarness({ keys: ['key-a', 'key-b', 'key-c'], responses: [{ status: 429 }, { status: 429 }, { status: 429 }] });
  try {
    const result = await requestWithHeaders(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 429);
    assert.ok(result.headers['retry-after'], 'Retry-After header must be supplied for a pool-wide 429');
    assert.equal(Number(result.headers['retry-after']) >= 1, true);
    assert.match(result.body, /rate limit/i);
    assert.deepEqual(harness.seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);
  } finally { await harness.close(); }
});

test('pool-wide 500 propagates 500 instead of a generic 502', async () => {
  const harness = await startGatewayHarness({ keys: ['key-a', 'key-b', 'key-c'], responses: [{ status: 500 }, { status: 500 }, { status: 500 }] });
  try {
    const result = await requestWithHeaders(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 500);
    assert.match(result.body, /internal server error/i);
    assert.deepEqual(harness.seenAuthorizations, ['Bearer key-a', 'Bearer key-b', 'Bearer key-c']);
  } finally { await harness.close(); }
});

test('mixed per-key failures that exhaust still return the generic 502', async () => {
  const harness = await startGatewayHarness({ keys: ['key-a', 'key-b', 'key-c'], responses: [{ status: 429 }, { status: 500 }, { status: 503 }] });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 502);
    assert.match(result.body, /All failover attempts exhausted/);
    assert.deepEqual(harness.seenAuthorizations, ['Bearer key-a', 'Bearer key-b', 'Bearer key-c']);
  } finally { await harness.close(); }
});

test('malformed JSON body returns exactly {"error":"invalid request body"} and leaks no parser detail', async () => {
  const harness = await startGatewayHarness({ keys: ['key-a', 'key-b', 'key-c'], responses: [{ status: 200, body: '{"ok":true}' }] });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"model":"m","messages":[}');
    assert.equal(result.statusCode, 400);
    // Exact body: the JSON.parse message reflects attacker-controlled bytes.
    assert.deepEqual(JSON.parse(result.body), { error: 'invalid request body' });
    assert.doesNotMatch(result.body, /JSON|position|token/i, 'parser detail must not be echoed');
    assert.deepEqual(harness.seenAuthorizations, [], 'no upstream key must be touched on invalid JSON');
  } finally { await harness.close(); }
});

test('malformed JSON body on the Anthropic /v1/messages path also fails fast with 400 and no key use', async () => {
  const harness = await startGatewayHarness({ keys: ['key-a', 'key-b', 'key-c'], responses: [{ status: 200, body: '{"ok":true}' }] });
  try {
    const result = await request(harness.port, '/v1/messages', 'POST', '{"model":"m","messages":[}');
    assert.equal(result.statusCode, 400);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.type, 'error');
    assert.equal(parsed.error.type, 'invalid_request_error');
    assert.equal(parsed.error.message, 'invalid request body');
    assert.deepEqual(harness.seenAuthorizations, [], 'no upstream key must be touched on invalid JSON');
  } finally { await harness.close(); }
});

test('pool-wide same-status failure stops early instead of burning the whole attempt budget', async () => {
  // 3 active keys, but an attempt budget of 8. Once every DISTINCT key has answered
  // 503 the pool verdict is already known, so the loop must stop at 3 upstream calls
  // rather than retrying keys a second and third time.
  // Uses 503 (not 429) deliberately: 429 has its own, tighter confirming-attempt
  // rule, so this test would no longer exercise the COVERAGE-based early stop.
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c'],
    responses: Array.from({ length: 8 }, () => ({ status: 503 })),
    maxFailoverAttempts: 8
  });
  try {
    const result = await requestWithHeaders(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 503);
    assert.equal(harness.seenAuthorizations.length, 3, `expected one attempt per distinct key, got ${harness.seenAuthorizations.length}`);
    assert.deepEqual(harness.seenAuthorizations, ['Bearer key-a', 'Bearer key-b', 'Bearer key-c']);
    assert.match(result.body, /unavailable/i);
  } finally { await harness.close(); }
});

test('repeated per-key 401s are NOT treated as a pool-wide verdict and still return the generic 502', async () => {
  // 401 is retryable (the next key may be valid) but it is a verdict about ONE
  // credential. Propagating it as the upstream's answer would mask a key-management
  // problem as an upstream outage.
  const harness = await startGatewayHarness({ keys: ['key-a', 'key-b', 'key-c'], responses: [{ status: 401 }, { status: 401 }, { status: 401 }] });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 502);
    assert.match(result.body, /All failover attempts exhausted/);
  } finally { await harness.close(); }
});

test('a non-NVCF 404 passes through as-is without consuming further keys', async () => {
  // Unknown-model 404 (text/plain, no nvcf-* headers) is permanent: every key would
  // get the same answer, so it must not be retried and the real status is returned.
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c'],
    responses: [{ status: 404, headers: { 'content-type': 'text/plain' }, body: '404 page not found' }]
  });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 404);
    assert.equal(harness.seenAuthorizations.length, 1, 'a permanent 404 must not be retried across keys');
  } finally { await harness.close(); }
});

test('config perModelSettings.maxFailoverAttempts bounds the failover loop without an env override', async () => {
  // No GATEWAY_MAX_FAILOVER_ATTEMPTS (maxFailoverAttempts: null) so the config value
  // is the effective bound. 3 active keys would otherwise yield 3 attempts; the
  // per-model bound of 2 must cap it at 2 upstream calls. Mixed statuses keep the
  // pool-wide early stop out of the picture, isolating the bound itself.
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c'],
    responses: [{ status: 429 }, { status: 500 }, { status: 503 }],
    maxFailoverAttempts: null,
    config: { performanceMode: 'day', perModelSettings: { 'bounded/model': { maxFailoverAttempts: 2 } } }
  });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"stream":false,"model":"bounded/model"}');
    assert.equal(result.statusCode, 502);
    assert.equal(harness.seenAuthorizations.length, 2, `per-model maxFailoverAttempts=2 must cap attempts, got ${harness.seenAuthorizations.length}`);
  } finally { await harness.close(); }
});

test('global performanceMode profile bounds failover for a model with no per-model override', async () => {
  // "night" profile => maxFailoverAttempts 2. The requested model has no explicit
  // per-model entry, so the global profile is the effective bound.
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c'],
    responses: [{ status: 429 }, { status: 500 }, { status: 503 }],
    maxFailoverAttempts: null,
    config: { performanceMode: 'night', perModelSettings: { 'other/model': { maxFailoverAttempts: 8 } } }
  });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"stream":false,"model":"unbounded/model"}');
    assert.equal(result.statusCode, 502);
    assert.equal(harness.seenAuthorizations.length, 2, `night profile maxFailoverAttempts=2 must cap attempts, got ${harness.seenAuthorizations.length}`);
  } finally { await harness.close(); }
});

test('uniform upstream 429 stops at exactly 2 upstream calls and returns an honest 429 with Retry-After', async () => {
  // Live-established: NVIDIA scopes a 429 to the MODEL, so all 15 pool keys answer
  // 429 for it in the same second they serve another model with 200. Walking the
  // pool cannot succeed — it only burns ~350ms per attempt and multiplies upstream
  // load. 5 keys and a budget of 5 make the assertion non-vacuous: without the
  // early stop the loop would issue 5 upstream calls, not 2.
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c', 'key-d', 'key-e'],
    responses: Array.from({ length: 5 }, () => ({ status: 429 })),
    maxFailoverAttempts: 5
  });
  try {
    const result = await requestWithHeaders(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 429);
    assert.equal(harness.seenAuthorizations.length, 2, `uniform 429 must stop at 2 upstream calls, got ${harness.seenAuthorizations.length}`);
    assert.deepEqual(harness.seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);
    assert.ok(Number(result.headers['retry-after']) >= 1, 'our own Retry-After must be supplied (NVIDIA sends none)');
    assert.match(result.body, /rate limit/i);
    await delay(1_100);
    const verdict = fs.readFileSync(harness.logPath, 'utf8').trim().split('\n').map(JSON.parse)
      .find((entry) => entry.message === 'All failover attempts exhausted');
    assert.equal(verdict.poolWide, true);
    assert.equal(verdict.upstreamStatus, 429);
    assert.equal(verdict.earlyStop, true);
    assert.equal(verdict.earlyStopReason, 'uniform_rate_limit');
    assert.equal(verdict.attempts, 2);
    assert.equal(verdict.keysTried, 2);
    assert.equal(verdict.activeKeys, 5);
  } finally { await harness.close(); }
});

test('mixed 429-then-500 does NOT trigger the rate-limit early stop and still fails over per key', async () => {
  // A 500 after a 429 means the pool is NOT uniformly rate-limited, so a different
  // key can still succeed. Third key answers 200 — reached only if failover continued
  // past the 2-attempt rate-limit bound.
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c'],
    responses: [{ status: 429 }, { status: 500 }, { status: 200, body: '{"ok":true}' }],
    maxFailoverAttempts: 3
  });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 200, 'mixed statuses must keep failing over to a key that succeeds');
    assert.equal(result.body, '{"ok":true}');
    assert.equal(harness.seenAuthorizations.length, 3, `expected full failover past the 429 bound, got ${harness.seenAuthorizations.length}`);
    assert.deepEqual(harness.seenAuthorizations, ['Bearer key-a', 'Bearer key-b', 'Bearer key-c']);
  } finally { await harness.close(); }
});

test('uniform 503 keeps the existing pool-wide behaviour (no 429 early stop applied)', async () => {
  // 5 keys, budget 5. A 503 genuinely can succeed on another key, so the loop keeps
  // the full per-key failover and only the COVERAGE rule ends it — at 5 calls, not 2.
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c', 'key-d', 'key-e'],
    responses: Array.from({ length: 5 }, () => ({ status: 503 })),
    maxFailoverAttempts: 5
  });
  try {
    const result = await requestWithHeaders(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 503);
    assert.equal(harness.seenAuthorizations.length, 5, `uniform 503 must still try every key, got ${harness.seenAuthorizations.length}`);
    assert.match(result.body, /unavailable/i);
    await delay(1_100);
    const verdict = fs.readFileSync(harness.logPath, 'utf8').trim().split('\n').map(JSON.parse)
      .find((entry) => entry.message === 'All failover attempts exhausted');
    assert.equal(verdict.upstreamStatus, 503);
    assert.equal(verdict.earlyStopReason, undefined, 'a uniform 503 must not be attributed to the rate-limit rule');
  } finally { await harness.close(); }
});

test('NVCF dispatch-failure 404 still retries across keys and succeeds, unchanged by the 429 rule', async () => {
  // A 404 carrying nvcf-status is a per-CREDENTIAL entitlement failure: the model
  // exists and another key can invoke it. It must stay retryable and must not be
  // swept into any early stop.
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b'],
    responses: [
      { status: 404, headers: { 'content-type': 'application/json', 'nvcf-status': 'errored', 'nvcf-reqid': 'a03acae2-322f-4e37-9540-884e0851f09d' } },
      { status: 200, body: '{"ok":true}' }
    ],
    maxFailoverAttempts: 2
  });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 200, 'an NVCF dispatch 404 must fail over to a key that can invoke the function');
    assert.equal(result.body, '{"ok":true}');
    assert.deepEqual(harness.seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);
  } finally { await harness.close(); }
});

test('GATEWAY_RATE_LIMIT_MAX_ATTEMPTS is respected and clamped to 1..3', async () => {
  // Respected: 1 => a single 429 is enough to answer honestly.
  const single = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c', 'key-d'],
    responses: Array.from({ length: 4 }, () => ({ status: 429 })),
    maxFailoverAttempts: 4,
    rateLimitMaxAttempts: 1
  });
  try {
    const result = await requestWithHeaders(single.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 429);
    assert.equal(single.seenAuthorizations.length, 1, `override 1 must stop at 1 call, got ${single.seenAuthorizations.length}`);
  } finally { await single.close(); }

  // Clamped ABOVE the ceiling: 9 => 3, not 9 and not the default 2. A 4-key pool
  // with a budget of 4 distinguishes all three outcomes.
  const clampedHigh = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c', 'key-d'],
    responses: Array.from({ length: 4 }, () => ({ status: 429 })),
    maxFailoverAttempts: 4,
    rateLimitMaxAttempts: 9
  });
  try {
    const result = await requestWithHeaders(clampedHigh.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 429);
    assert.equal(clampedHigh.seenAuthorizations.length, 3, `override 9 must clamp to 3, got ${clampedHigh.seenAuthorizations.length}`);
  } finally { await clampedHigh.close(); }

  // Clamped BELOW the floor: 0 => 1.
  const clampedLow = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c', 'key-d'],
    responses: Array.from({ length: 4 }, () => ({ status: 429 })),
    maxFailoverAttempts: 4,
    rateLimitMaxAttempts: 0
  });
  try {
    const result = await requestWithHeaders(clampedLow.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 429);
    assert.equal(clampedLow.seenAuthorizations.length, 1, `override 0 must clamp to 1, got ${clampedLow.seenAuthorizations.length}`);
  } finally { await clampedLow.close(); }
});

test('per-model config rateLimitMaxAttempts overrides the default without an env knob', async () => {
  // No GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: the per-model config entry is the effective
  // bound (3), so the loop must make 3 calls rather than the default 2.
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c', 'key-d'],
    responses: Array.from({ length: 4 }, () => ({ status: 429 })),
    maxFailoverAttempts: 4,
    config: { performanceMode: 'day', perModelSettings: { 'slow/model': { rateLimitMaxAttempts: 3 } } }
  });
  try {
    const result = await requestWithHeaders(harness.port, '/v1/chat/completions', 'POST', '{"stream":false,"model":"slow/model"}');
    assert.equal(result.statusCode, 429);
    assert.equal(harness.seenAuthorizations.length, 3, `per-model rateLimitMaxAttempts=3 must apply, got ${harness.seenAuthorizations.length}`);
  } finally { await harness.close(); }
});

test('the honest 429 verdict log carries no upstream-controlled text', async () => {
  // Upstream bodies can embed secrets, so the 429 path must stay body-free in logs
  // (same rule as the non-2xx diagnostic path). The sentinel is unique enough that
  // any echo of the upstream body would surface it.
  const sentinel = 'UPSTREAM-429-BODY-SENTINEL-8f3a1c';
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c'],
    responses: Array.from({ length: 3 }, () => ({ status: 429, body: JSON.stringify({ status: 429, title: 'Too Many Requests', detail: sentinel }) })),
    maxFailoverAttempts: 3
  });
  try {
    assert.equal((await request(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}')).statusCode, 429);
    await delay(1_100);
    const logs = fs.readFileSync(harness.logPath, 'utf8');
    assert.doesNotMatch(logs, new RegExp(sentinel), 'upstream body text must never reach the log');
    assert.doesNotMatch(logs, /key-a|key-b|key-c/, 'raw key material must never reach the log');
  } finally { await harness.close(); }
});

test('repeated failover attempts do not leak inbound abort listeners (no MaxListenersExceededWarning)', async () => {
  // Node's warning threshold is per EVENT NAME (default 10), and each attempt adds one
  // "close" + one "aborted". So the leak only surfaces past 10 attempts — hence a
  // 12-key pool with NO env/config bound (pool-derived coverage = 12 attempts), which
  // registers 12 "close" listeners on the SAME inbound request when uncleaned.
  // Mixed statuses defeat the pool-wide early stop so the full budget is spent.
  const statuses = [429, 500, 503, 502, 504, 529, 500, 429, 503, 502, 500, 429];
  const keys = Array.from({ length: 12 }, (_, index) => `key-${String.fromCharCode(97 + index)}`);
  const harness = await startGatewayHarness({
    keys,
    responses: statuses.map((status) => ({ status })),
    maxFailoverAttempts: null,
    captureStderr: true
  });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 502);
    // Guard the probe itself: fewer than 11 attempts could not trip the warning,
    // so a passing assertion below would be vacuous.
    assert.equal(harness.seenAuthorizations.length, 12, `expected 12 attempts to exceed the 10-listener threshold, got ${harness.seenAuthorizations.length}`);
    const stderr = harness.stderr();
    assert.doesNotMatch(stderr, /MaxListenersExceededWarning/, `listener leak detected:\n${stderr}`);
  } finally { await harness.close(); }
});

function request(port, url, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { authorization: 'Bearer test-gateway-token', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function requestWithHeaders(port, url, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { authorization: 'Bearer test-gateway-token', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function requestTerminal(port, url, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { authorization: 'Bearer test-gateway-token', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      res.resume();
      const done = () => resolve();
      res.once('end', done); res.once('aborted', done); res.once('error', done);
    });
    req.once('error', resolve); req.end(body);
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForState(statePath, predicate) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (predicate(state)) return state.keys.find((key) => key.usage.fail === 1) ?? state.keys[0];
    await delay(25);
  }
  throw new Error('Timed out waiting for persisted key state.');
}

// `maxFailoverAttempts`: overrides the default env attempt bound (which mirrors
//   `responses.length`). Pass `null` to omit GATEWAY_MAX_FAILOVER_ATTEMPTS entirely
//   so the config-derived bound is exercised instead of the env override.
// `rateLimitMaxAttempts`: sets GATEWAY_RATE_LIMIT_MAX_ATTEMPTS (the uniform-429
//   confirming-attempt bound). Omit to exercise the built-in default of 2.
// `config`: when provided, written to a config.json and exposed as
//   GATEWAY_CONFIG_PATH so perModelSettings / performanceMode are honored.
// `captureStderr`: collect the child's stderr so tests can assert on process
//   warnings (e.g. MaxListenersExceededWarning).
async function startGatewayHarness({ keys, responses, maxBufferBytes, maxFailoverAttempts, rateLimitMaxAttempts, config, captureStderr }) {
  const dir = fs.mkdtempSync(path.join(fileTempRoot, 'gateway-'));
  const statePath = path.join(dir, 'keys.json');
  const logPath = path.join(dir, 'gateway.jsonl');
  const seenAuthorizations = [];
  let configPath;
  if (config) {
    configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config));
  }
  const stderrChunks = [];
  fs.writeFileSync(statePath, JSON.stringify({ keys: keys.map((key, index) => ({ id: `key-${index}`, key, status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: index + 1 } })) }));
  const upstream = http.createServer((req, res) => {
    seenAuthorizations.push(req.headers.authorization);
    const response = responses.shift() ?? { status: 500 };
    res.writeHead(response.status, response.headers ?? { 'content-type': 'application/json' });
    if (response.abort) { res.write(response.body ?? 'x'); setTimeout(() => res.socket.destroy(), 5); return; }
    res.end(response.body ?? '{}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let port;
  let child;
  let ready = false;
  for (let startAttempt = 0; startAttempt < 3 && !ready; startAttempt++) {
    port = await freePortPair();
    const envAttempts = maxFailoverAttempts === null
      ? undefined
      : String(maxFailoverAttempts ?? responses.length);
    child = spawn(process.execPath, ['--require', path.join(root, 'tests/local-upstream-preload.cjs'), path.join(root, 'src/gateway/server.mjs')], {
      env: { ...process.env, GATEWAY_LOG_PATH: logPath, GATEWAY_MAX_FAILOVER_ATTEMPTS: envAttempts, GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: rateLimitMaxAttempts === undefined ? undefined : String(rateLimitMaxAttempts), GATEWAY_CONFIG_PATH: configPath, GATEWAY_MAX_BUFFERED_RESPONSE_BYTES: maxBufferBytes ? String(maxBufferBytes) : undefined, GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstream.address().port), PORT: String(port) },
      stdio: ['ignore', 'ignore', captureStderr ? 'pipe' : 'ignore', 'ipc'], windowsHide: true
    });
    if (captureStderr) child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.once('message', (message) => {
      if (message?.type === 'ready') child.send({ type: 'state:init', challenge: message.challenge, state: { keys: JSON.parse(fs.readFileSync(statePath, 'utf8')).keys, credentials: { gatewayToken: 'test-gateway-token', adminToken: 'test-admin-token' } } });
    });
    child.on('message', (message) => { if (message?.type === 'state:persist') fs.writeFileSync(statePath, JSON.stringify(message.state)); });
    // Poll by condition; the deadline covers Windows child-start latency under
    // cross-file concurrency. A child that loses the free-port race retries a
    // newly selected pair instead of sharing a stale candidate.
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
    throw new Error(`Gateway did not become healthy on port ${port}.`);
  }
  return { port, statePath, logPath, seenAuthorizations, stderr: () => Buffer.concat(stderrChunks).toString(), close: async () => {
    await stopChild(child);
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  } };
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
