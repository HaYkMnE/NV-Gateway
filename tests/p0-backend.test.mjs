import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';
import { GATEWAY_START_MAX_ATTEMPTS, highPortReservation, killOnBindCollision } from './support/gateway-bind-collision.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fileTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-p0-backend-${process.pid}-`));
test.after(() => fs.rmSync(fileTempRoot, { recursive: true, force: true }));

test('failover policy has bounded attempts, complete status matrix, and Retry-After parsing', async () => {
  const policy = await import(pathToFileURL(path.join(root, 'src/gateway/failover-policy.mjs')).href);
  assert.equal(policy.resolveMaxFailoverAttempts({}), 3);
  // The configured ceiling is MAX_CONFIGURED_FAILOVER_ATTEMPTS (64), not 3: a
  // large-but-valid env value is capped at the ceiling, while only non-numeric /
  // sub-1 values fall back to the default. (The old expectation of 3 predates
  // the coverage-floor contract; see tests/failover-policy.test.mjs.)
  assert.equal(policy.resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '0' }), 3);
  assert.equal(policy.resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '2.5' }), 3);
  assert.equal(policy.resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: 'garbage' }), 3);
  assert.equal(policy.resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '9' }), 9);
  assert.equal(policy.resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '99' }), policy.MAX_CONFIGURED_FAILOVER_ATTEMPTS);
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

test('F2: a transient /v1/models socket error parks the failing key so the next attempt uses a DIFFERENT key', async () => {
  // The models network-error path used to settle `retryable: true` WITHOUT
  // calling handleKeyError, so getNextKey() could hand the SAME broken key back
  // and the failover loop spun to maxAttempts making no progress. The chat path
  // parks the key (server.mjs handleKeyError on upstreamReq "error"); the models
  // path must do the same. Here key A's upstream response is destroyed mid-flight
  // (socket hang-up), and the retry MUST land on key B.
  let firstKeySeen = null;
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b'],
    responses: [],
    maxFailoverAttempts: 2,
    upstreamHandlerOverride: (req, res) => {
      if (firstKeySeen === null) {
        // First attempt: destroy the socket BEFORE any response headers, so the
        // gateway's https client reports an upstream request "error" (ECONNRESET
        // / socket hang-up) — the transport-failure path under test.
        firstKeySeen = req.headers.authorization;
        setTimeout(() => res.socket.destroy(), 5);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
    }
  });
  try {
    const result = await request(harness.port, '/v1/models', 'GET');
    // The first key must have been parked, so the retry used the OTHER key.
    assert.equal(firstKeySeen, 'Bearer key-a', 'the first attempt must use key-a');
    assert.deepEqual(harness.seenAuthorizations, ['Bearer key-a', 'Bearer key-b'],
      'a socket hang-up must park key-a so the next attempt selects key-b, not key-a again');
    // The parked key carries a future backoffUntil in the persisted state (the
    // save is debounced, so poll rather than race it).
    const parked = await waitForState(harness.statePath, (state) =>
      state.keys.some((key) => key.key === 'key-a' && key.usage.fail >= 1));
    assert.equal(parked.usage.fail >= 1, true, 'the failing key must be accounted as failed');
    assert.equal(parked.backoffUntil > Date.now(), true,
      'the failing key must be parked (backoffUntil in the future) by handleKeyError');
  } finally { await harness.close(); }
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

test('F4: EVERY oversized POST body receives HTTP 413 (not a connection reset)', async () => {
  // The payload-limit path used to writeHead(413) then IMMEDIATELY req.destroy().
  // That raced the client's still-running UPLOAD: `res`'s "finish" only means the
  // RESPONSE was flushed, so destroying the socket there aborted the in-flight
  // send and the client saw ECONNRESET — measured at ~50% of requests on the REAL
  // gateway (15 x 413 / 15 x ECONNRESET out of 30). A single request is therefore
  // a COIN FLIP and cannot regress-detect this defect. The fix DRAINS the
  // incoming body (req.resume()) instead of destroying the request, so the client
  // finishes sending and reads the 413. We fire many requests per route so the
  // ~50% race is reliably red, not occasionally green.
  const harness = await startGatewayHarness({ keys: ['key-a'], responses: [] });
  try {
    const oversized = JSON.stringify({ model: 'm', padding: 'x'.repeat(6 * 1024 * 1024) });
    const ROUNDS = 10;
    for (const route of ['/v1/chat/completions', '/v1/messages']) {
      for (let round = 1; round <= ROUNDS; round++) {
        let result;
        try {
          result = await request(harness.port, route, 'POST', oversized);
        } catch (err) {
          assert.fail(`${route} round ${round}/${ROUNDS}: oversized body reset the connection (${err.code ?? err.message}) instead of answering 413`);
        }
        assert.equal(result.statusCode, 413,
          `${route} round ${round}/${ROUNDS}: an oversized body must answer 413, not reset the connection`);
        assert.match(result.body, /Payload Too Large/,
          `${route} round ${round}/${ROUNDS}: the 413 body must carry the payload-too-large reason`);
      }
    }
    // SECURITY INTENT: the oversized body is DRAINED, never buffered, and no
    // upstream key may be touched for it.
    assert.deepEqual(harness.seenAuthorizations, [],
      'no upstream key may be touched for an oversized body');
  } finally { await harness.close(); }
});

test('F4: an oversized body is drained, not buffered, and a never-finishing sender is bounded', async () => {
  // Two security intents, asserted against the REAL gateway:
  //  (1) DRAIN, NOT BUFFER: once the limit is crossed nothing more accumulates.
  //      We prove it observably — the request completes with 413 and the gateway
  //      child survives (a buffered ~24 MiB body across the requests above would
  //      not corrupt the process, but a hung socket would stall close()); and
  //  (2) BOUNDED: a client that keeps the socket open after the 413 must not hold
  //      the connection forever. We send the oversized body SLOWLY and keep the
  //      upload open; the gateway's drain-safety timer
  //      (OVERSIZED_REQUEST_DRAIN_TIMEOUT_MS, 10s) must then destroy the socket.
  //      The client observes the abort as ECONNRESET/EPIPE — which is the CORRECT
  //      outcome for a non-cooperative sender, not the defect (the defect was
  //      aborting an HONEST client that had already delivered the whole body).
  const harness = await startGatewayHarness({ keys: ['key-a'], responses: [] });
  try {
    const chunk = Buffer.alloc(256 * 1024, 0x78); // 256 KiB
    const totalChunks = 40; // ~10 MiB, well past the 5 MiB limit
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: harness.port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${harness.gatewayToken}`, 'content-type': 'application/json', 'content-length': String(chunk.length * totalChunks) } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      // If the client is destroyed by the gateway's safety timer, surface that as
      // the expected bounded outcome rather than an uncaught rejection.
      req.on('error', (err) => resolve({ reset: err.code ?? err.message }));
      // Send past the limit, then STALL (never call req.end()) so the server must
      // rely on its own bound rather than the client's cooperation.
      let sent = 0;
      const pump = () => {
        if (sent >= 22) return; // > 5 MiB (22 * 256 KiB = 5.5 MiB) marks it oversized
        if (req.destroyed) return;
        req.write(chunk);
        sent += 1;
        setTimeout(pump, 10);
      };
      pump();
    });
    if (result.reset) {
      assert.match(result.reset, /ECONNRESET|EPIPE|ERR_STREAM_DESTROYED/,
        `a stalled oversized upload must be bounded with a socket abort, got ${result.reset}`);
    } else {
      // Some platforms surface the bound as a clean 413 before the timer fires.
      assert.equal(result.statusCode, 413, 'an oversized body must still answer 413');
      assert.match(result.body, /Payload Too Large/);
    }
    assert.deepEqual(harness.seenAuthorizations, [], 'no upstream key may be touched for an oversized body');
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
  // Owner rule (live contract): rotation is CIRCULAR across the whole eligible
  // pool, so the attempt budget is floored at pool coverage and a uniform 429
  // verdict requires every key the model may use to have answered 429. With 3
  // keys that means 3 upstream calls — the status and Retry-After are what this
  // test pins; the attempt count is pinned by the dedicated early-stop test.
  const harness = await startGatewayHarness({ keys: ['key-a', 'key-b', 'key-c'], responses: [{ status: 429 }, { status: 429 }, { status: 429 }] });
  try {
    const result = await requestWithHeaders(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 429);
    assert.ok(result.headers['retry-after'], 'Retry-After header must be supplied for a pool-wide 429');
    assert.equal(Number(result.headers['retry-after']) >= 1, true);
    assert.match(result.body, /rate limit/i);
    assert.deepEqual(harness.seenAuthorizations, ['Bearer key-a', 'Bearer key-b', 'Bearer key-c']);
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

test('an empty key pool answers an honest 503 "All API keys exhausted" (not a 502 exhaustion)', async () => {
  // No keys were ever configured. Nobody tried anything, so reporting
  // "All failover attempts exhausted" with attempts:0 was a lie. The honest
  // answer is the empty-pool 503 with a Retry-After, and the upstream is NEVER
  // contacted.
  const harness = await startGatewayHarness({ keys: [], responses: [] });
  try {
    const result = await requestWithHeaders(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 503, 'an untried empty pool must be a 503, not a 502');
    assert.match(result.body, /All API keys exhausted/);
    assert.ok(Number(result.headers['retry-after']) >= 1, 'a Retry-After must be supplied');
    assert.equal(harness.seenAuthorizations.length, 0, 'no upstream call may happen with an empty pool');
  } finally { await harness.close(); }
});

test('an empty key pool answers the Anthropic-shaped 503 body on /v1/messages', async () => {
  const harness = await startGatewayHarness({ keys: [], responses: [] });
  try {
    const result = await requestWithHeaders(harness.port, '/v1/messages', 'POST', '{"stream":false,"model":"m","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}');
    assert.equal(result.statusCode, 503);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.type, 'error');
    assert.equal(parsed.error.type, 'api_error');
    assert.equal(parsed.error.message, 'All API keys exhausted');
    assert.ok(Number(result.headers['retry-after']) >= 1);
    assert.equal(harness.seenAuthorizations.length, 0);
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
  // is the effective bound. Owner rule: the budget is floored at eligible-pool
  // coverage, so a configured bound of TWO cannot truncate a THREE-key pool — the
  // request must still cover all three keys. (An earlier contract let the cap
  // shrink below coverage; the owner rule explicitly forbids that.) Mixed statuses
  // keep the pool-wide early stop out of the picture, isolating the bound itself.
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c'],
    responses: [{ status: 429 }, { status: 500 }, { status: 503 }],
    maxFailoverAttempts: null,
    config: { performanceMode: 'day', perModelSettings: { 'bounded/model': { maxFailoverAttempts: 2 } } }
  });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"stream":false,"model":"bounded/model"}');
    assert.equal(result.statusCode, 502);
    assert.equal(harness.seenAuthorizations.length, 3,
      `coverage floor must keep the 3-key pool reachable despite maxFailoverAttempts=2, got ${harness.seenAuthorizations.length}`);
    assert.deepEqual(harness.seenAuthorizations, ['Bearer key-a', 'Bearer key-b', 'Bearer key-c']);
  } finally { await harness.close(); }
});

test('global performanceMode profile bounds failover for a model with no per-model override', async () => {
  // "night" profile => maxFailoverAttempts 2. The requested model has no explicit
  // per-model entry, so the global profile is the effective bound — but the owner
  // rule floors the budget at eligible-pool coverage, so a 3-key pool is still
  // walked in full.
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c'],
    responses: [{ status: 429 }, { status: 500 }, { status: 503 }],
    maxFailoverAttempts: null,
    config: { performanceMode: 'night', perModelSettings: { 'other/model': { maxFailoverAttempts: 8 } } }
  });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"stream":false,"model":"unbounded/model"}');
    assert.equal(result.statusCode, 502);
    assert.equal(harness.seenAuthorizations.length, 3,
      `coverage floor must keep the 3-key pool reachable despite the night profile's maxFailoverAttempts=2, got ${harness.seenAuthorizations.length}`);
    assert.deepEqual(harness.seenAuthorizations, ['Bearer key-a', 'Bearer key-b', 'Bearer key-c']);
  } finally { await harness.close(); }
});

test('uniform upstream 429 covers the whole pool and returns an honest 429 with Retry-After', async () => {
  // Live-established: NVIDIA scopes a 429 to the MODEL, so pool keys answer 429 for
  // it in the same second they serve another model with 200. Owner rule: rotation is
  // CIRCULAR across the whole eligible pool, so the uniform-429 verdict requires
  // every key the model may use to have genuinely answered 429 — it can no longer be
  // declared after a small confirming count. The verdict is still POOL-WIDE and the
  // status is still the honest 429 with our own Retry-After.
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c', 'key-d', 'key-e'],
    responses: Array.from({ length: 5 }, () => ({ status: 429 })),
    maxFailoverAttempts: 5
  });
  try {
    const result = await requestWithHeaders(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}');
    assert.equal(result.statusCode, 429);
    assert.equal(harness.seenAuthorizations.length, 5, `uniform 429 must cover the pool before the verdict, got ${harness.seenAuthorizations.length}`);
    assert.deepEqual(harness.seenAuthorizations, ['Bearer key-a', 'Bearer key-b', 'Bearer key-c', 'Bearer key-d', 'Bearer key-e']);
    assert.ok(Number(result.headers['retry-after']) >= 1, 'our own Retry-After must be supplied (NVIDIA sends none)');
    assert.match(result.body, /rate limit/i);
    await delay(1_100);
    const verdict = fs.readFileSync(harness.logPath, 'utf8').trim().split('\n').map(JSON.parse)
      .find((entry) => entry.message === 'All failover attempts exhausted');
    assert.equal(verdict.poolWide, true);
    assert.equal(verdict.upstreamStatus, 429);
    // The verdict is reached by COVERING the pool (owner rule) rather than by the
    // old short confirming count, so `earlyStop` is false and the attempt count is
    // the pool size. The rate-limit attribution is preserved.
    assert.equal(verdict.earlyStop, false);
    assert.equal(verdict.earlyStopReason, 'uniform_rate_limit');
    assert.equal(verdict.attempts, 5);
    assert.equal(verdict.keysTried, 5);
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
  // MASTER-008: a 404 carrying nvcf-status is a per-CREDENTIAL entitlement
  // failure: the model exists and another key can invoke it. It must stay
  // retryable and must not be swept into any early stop. The request MUST carry
  // a `model` field (as every real client does): without it getNextKey(undefined)
  // bypasses selectKeyForModel()/sticky affinity and the test would pass on
  // pool-wide LRU even while per-model affinity pins failover to one key
  // (MASTER-001). The harness below now rejects a model-less chat request so
  // this blind spot cannot recur.
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b'],
    responses: [
      { status: 404, headers: { 'content-type': 'application/json', 'nvcf-status': 'errored', 'nvcf-reqid': 'a03acae2-322f-4e37-9540-884e0851f09d' } },
      { status: 200, body: '{"ok":true}' }
    ],
    maxFailoverAttempts: 2,
    requireChatModel: true
  });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"stream":false,"model":"meta/llama-3.3-70b-instruct"}');
    assert.equal(result.statusCode, 200, 'an NVCF dispatch 404 must fail over to a key that can invoke the function');
    assert.equal(result.body, '{"ok":true}');
    assert.deepEqual(harness.seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);
  } finally { await harness.close(); }
});

test('GATEWAY_RATE_LIMIT_MAX_ATTEMPTS is respected and clamped to 1..3', async () => {
  // The knob's VALUE is clamped by the policy (1..3) — that contract is pinned
  // directly. At the HTTP layer the uniform-429 verdict additionally requires
  // full eligible-pool coverage (owner rule: circular rotation), so a clamped
  // knob BELOW the pool no longer truncates the walk; the honest 429 is still
  // returned after every key has answered.
  const policy = await import(pathToFileURL(path.join(root, 'src/gateway/failover-policy.mjs')).href);
  assert.equal(policy.resolveRateLimitMaxAttempts({ GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: '1' }), 1);
  assert.equal(policy.resolveRateLimitMaxAttempts({ GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: '9' }), 3, 'override 9 must clamp to 3');
  assert.equal(policy.resolveRateLimitMaxAttempts({ GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: '0' }), 1, 'override 0 must clamp to 1');

  for (const [name, rateLimitMaxAttempts] of [['1', 1], ['9', 9], ['0', 0]]) {
    const harness = await startGatewayHarness({
      keys: ['key-a', 'key-b', 'key-c', 'key-d'],
      responses: Array.from({ length: 4 }, () => ({ status: 429 })),
      maxFailoverAttempts: 4,
      rateLimitMaxAttempts
    });
    try {
      const result = await requestWithHeaders(harness.port, '/v1/chat/completions', 'POST', '{"stream":false}');
      assert.equal(result.statusCode, 429, `rateLimitMaxAttempts=${name} must answer the honest 429`);
      assert.equal(harness.seenAuthorizations.length, 4,
        `rateLimitMaxAttempts=${name} cannot narrow below pool coverage, got ${harness.seenAuthorizations.length}`);
    } finally { await harness.close(); }
  }
});

test('per-model config rateLimitMaxAttempts overrides the default without an env knob', async () => {
  // No GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: the per-model config entry (3) is the
  // effective value, and it takes precedence over the default (2). The value is
  // asserted on the resolver; at the HTTP layer the uniform-429 verdict requires
  // full pool coverage, so the 4-key pool is walked in full.
  const policy = await import(pathToFileURL(path.join(root, 'src/gateway/failover-policy.mjs')).href);
  assert.equal(policy.resolveRateLimitMaxAttempts({}, 3), 3, 'the per-model value must override the default');
  assert.equal(policy.resolveRateLimitMaxAttempts({}), 2, 'the default stays 2');

  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b', 'key-c', 'key-d'],
    responses: Array.from({ length: 4 }, () => ({ status: 429 })),
    maxFailoverAttempts: 4,
    config: { performanceMode: 'day', perModelSettings: { 'slow/model': { rateLimitMaxAttempts: 3 } } }
  });
  try {
    const result = await requestWithHeaders(harness.port, '/v1/chat/completions', 'POST', '{"stream":false,"model":"slow/model"}');
    assert.equal(result.statusCode, 429);
    assert.equal(harness.seenAuthorizations.length, 4,
      `pool coverage must be walked in full, got ${harness.seenAuthorizations.length}`);
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

test('repeated SSE failover attempts do not accumulate `res` listeners on the stream branches (B1)', async () => {
  // B1: the OpenAI SSE branch (and the Anthropic facade) attaches its OWN
  // `res` "error"/"close" pair INSIDE proxyRequest, per attempt, on the SAME
  // long-lived `res`. Before the fix the funnel detach only removed the funnel
  // pair, so every retried attempt appended two more `res` listeners — past ~10
  // attempts Node emitted MaxListenersExceededWarning and stale closures acted
  // on dead attempt state.
  //
  // Force a retryable pre-commit stream failure on EVERY attempt: a 200 with a
  // text/event-stream content-type and ZERO bytes is the genuine empty-stream
  // shape the 2026-09-16 incident classifies as a retryable incomplete_stream.
  // A 12-key pool with no bound spends 12 streaming attempts.
  const keys = Array.from({ length: 12 }, (_, index) => `key-${String.fromCharCode(97 + index)}`);
  const harness = await startGatewayHarness({
    keys,
    responses: keys.map(() => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: '' })),
    maxFailoverAttempts: null,
    captureStderr: true,
    requireChatModel: true
  });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"stream":true,"model":"meta/llama-3.3-70b-instruct"}');
    assert.equal(result.statusCode, 502);
    // Guard the probe: fewer than 11 attempts could not trip the 10-listener
    // warning on `res`, so a passing assertion below would be vacuous.
    assert.equal(harness.seenAuthorizations.length, 12, `expected 12 streaming attempts to exceed the 10-listener threshold, got ${harness.seenAuthorizations.length}`);
    const stderr = harness.stderr();
    assert.doesNotMatch(stderr, /MaxListenersExceededWarning/, `res listener leak detected:\n${stderr}`);
  } finally { await harness.close(); }
});

test('repeated /v1/models failover attempts keep inbound abort listeners bounded (B1/models)', async () => {
  // B1/models regression invariant for the CURRENT funnel design, NOT a
  // before/after reproduction: handleModelsRequest is now called once per
  // failover attempt on the SAME `req`/`res`, and it attaches a `req`/`res`
  // "close"/"error" pair through the shared funnel map (detached before each
  // re-entry). This test pins that invariant: across 12 attempts the live
  // inbound handler count must stay bounded and no MaxListenersExceededWarning
  // may be emitted. It fails if a FUTURE change registers per-attempt handlers
  // without removing the previous attempt's copy.
  //
  // Honest scope note (P4): the PRE-fix (HEAD) models path attached ZERO inbound
  // `req`/`res` listeners — it leaked nothing and could not emit the warning,
  // and this test passes on that code too. Its real pre-fix defect was the
  // ABSENCE of client-disconnect abort / upstream timeout (see the B2 test
  // below); this test does not and must not claim otherwise.
  //
  // Node's warning threshold is per event name (default 10), so a bounded design
  // can never reach it at any attempt count; the 12-key pool with NO env/config
  // bound (pool-derived coverage = 12 attempts) and mixed retryable statuses
  // (defeating any pool-wide early stop) simply exercise the re-entry path the
  // most. `captureStderr` makes any child MaxListenersExceededWarning
  // observable, so its absence means the per-request handlers stayed bounded.
  const statuses = [429, 500, 503, 502, 504, 529, 500, 429, 503, 502, 500, 429];
  const keys = Array.from({ length: 12 }, (_, index) => `key-${String.fromCharCode(97 + index)}`);
  const harness = await startGatewayHarness({
    keys,
    responses: statuses.map((status) => ({ status })),
    maxFailoverAttempts: null,
    captureStderr: true
  });
  try {
    const result = await request(harness.port, '/v1/models', 'GET');
    assert.equal(result.statusCode, 502);
    // Guard the probe: fewer than 11 attempts could not trip the warning, so a
    // passing assertion below would be vacuous.
    assert.equal(harness.seenAuthorizations.length, 12, `expected 12 models attempts to exceed the 10-listener threshold, got ${harness.seenAuthorizations.length}`);
    const stderr = harness.stderr();
    assert.doesNotMatch(stderr, /MaxListenersExceededWarning/, `models listener leak detected:\n${stderr}`);
  } finally { await harness.close(); }
});

test('/v1/models aborts the upstream fetch when the client disconnects (B2)', async () => {
  // B2: the models path had no abort on client disconnect. Hold the upstream
  // response open, drop the client, and require the upstream socket to be torn
  // down (which is what aborting the upstream request does).
  let upstreamRequestClosed = false;
  const keys = ['key-a'];
  const harness = await startGatewayHarness({
    keys,
    responses: [],
    maxFailoverAttempts: 1,
    captureStderr: false,
    upstreamHandlerOverride: (req, res) => {
      req.on('close', () => { upstreamRequestClosed = true; res.destroy(); });
      res.on('close', () => { upstreamRequestClosed = true; });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"data":[');
      // Never end: the gateway must break the loop by aborting.
    }
  });
  try {
    // Start the request and destroy it as soon as the gateway has forwarded
    // response headers upstream (i.e. the fetch is in flight).
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: harness.port, path: '/v1/models', method: 'GET', headers: { authorization: `Bearer ${harness.gatewayToken}` } }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
        res.once('end', resolve);
      });
      req.once('error', () => resolve());
      req.end();
      setTimeout(() => { req.destroy(); resolve(); }, 1_000).unref?.();
    });
    const deadline = Date.now() + 2_000;
    while (!upstreamRequestClosed && Date.now() < deadline) await delay(25);
    assert.equal(upstreamRequestClosed, true, 'the upstream models fetch must be aborted when the client disconnects');
  } finally { await harness.close(); }
});

test('F1: an intentional /v1/models client-disconnect abort must NOT park the key nor retry into the dead client', async () => {
  // F1: `abortModelsUpstream` (server.mjs) sets `clientGone = true` and calls
  // `upstreamReq.destroy()`. When the client drops BEFORE the upstream has
  // responded (the realistic abandoned-request shape), the request is still
  // pending and Node emits `"error": "socket hang up"` on it (verified
  // behaviour: `ClientRequest.destroy()` with no arg on a pending request emits
  // a request `error`; once response headers exist it emits on the RESPONSE
  // instead). The models `upstreamReq.on("error")` handler ran UNGUARDED, so a
  // merely-disconnected key was (a) parked via handleKeyError (a spurious 5xx
  // backoff) and (b) settled `retryable: true`, making the failover loop
  // re-enter handleModelsRequest on the SAME dead `req`/`res` up to
  // maxAttempts. The fix mirrors the chat path (server.mjs:1808-1809:
  // `if (intentionalUpstreamAbort) return;`) with `if (clientGone) return;`.
  //
  // This test pins the CONSEQUENCE, not the mechanism: with a 2-key pool and a
  // maxFailoverAttempts of 2, an unguarded handler parks key-a and drives a
  // SECOND upstream attempt (key-b); the guard must leave key-a un-parked and
  // fire exactly ONE upstream attempt. The upstream NEVER responds, so the
  // client's disconnect lands while the fetch is still pending.
  let upstreamAttempts = 0;
  const harness = await startGatewayHarness({
    keys: ['key-a', 'key-b'],
    responses: [],
    maxFailoverAttempts: 2,
    captureStderr: false,
    upstreamHandlerOverride: () => {
      // Never respond: the request stays pending so the disconnect aborts it
      // pre-response (the request-`error` path under test).
      upstreamAttempts++;
    }
  });
  try {
    // Start the request, then destroy it while the upstream fetch is pending.
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: harness.port, path: '/v1/models', method: 'GET', headers: { authorization: `Bearer ${harness.gatewayToken}` } }, () => {
        // No upstream response is expected; hang until the destroy fires.
      });
      req.once('error', () => resolve());
      req.end();
      // Give the gateway time to dial the (silent) upstream, then drop the
      // client so `abortModelsUpstream` runs against a PENDING request.
      setTimeout(() => { req.destroy(); resolve(); }, 250);
    });
    // Give an (un)guarded error handler + failover re-entry ample time to act.
    await delay(600);
    // A transient 502 with no modelId is a GLOBAL backoff (see the F2 note in
    // server.mjs), so the key's own usage.fail is not the observable here. The
    // defect's own consequence is the re-entry: the unguarded handler settles
    // `retryable: true`, so the failover loop re-dials the upstream for a client
    // that is already gone. Exactly one upstream attempt proves the guard held.
    assert.equal(upstreamAttempts, 1,
      'a client-disconnect abort must NOT retry into the dead client (exactly one upstream attempt)');
  } finally { await harness.close(); }
});

// Per-harness random gateway token keyed by the harness port: a FOREIGN gateway
// that grabbed the same port (cross-file port race) answers 401, never 200.
const gatewayTokenByPort = new Map();
// ── Level-1 W1: body parsing must not depend on content-type, and a JSON body
// that is not an object must fail fast on EVERY entry point ───────────────────

test('a JSON body with NO content-type still honours disabledModels (W1 defect 3)', async () => {
  const disabled = 'meta/llama-4-maverick-17b-128e-instruct';
  const harness = await startGatewayHarness({
    keys: ['key-a'],
    responses: [{ status: 200, body: '{"ok":true}' }],
    config: { version: 1, disabledModels: [disabled] }
  });
  try {
    const body = JSON.stringify({ model: disabled, messages: [{ role: 'user', content: 'hi' }] });
    const result = await new Promise((resolve, reject) => {
      // Deliberately NO content-type header: it is a hint, never a gate.
      const req = http.request({ host: '127.0.0.1', port: harness.port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: authFor(harness.port), 'content-length': Buffer.byteLength(body) } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(result.statusCode, 404, result.body);
    assert.deepEqual(harness.seenAuthorizations, [], 'the disabled-model check must run before any key is touched');
  } finally { await harness.close(); }
});

for (const route of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) {
  for (const rawBody of ['null', '[]', '"just a string"', '42']) {
    test(route + ' rejects the non-object JSON body ' + rawBody + ' with 400 and no key use (W1 defect 2)', async () => {
      const harness = await startGatewayHarness({ keys: ['key-a', 'key-b'], responses: [{ status: 200, body: '{}' }] });
      try {
        const result = await requestWithHeaders(harness.port, route, 'POST', rawBody);
        assert.equal(result.statusCode, 400, result.body);
        assert.deepEqual(harness.seenAuthorizations, [], 'a rejected body must not consume a key');
      } finally { await harness.close(); }
    });
  }
}

function authFor(port) { return `Bearer ${gatewayTokenByPort.get(port) ?? 'no-harness-token-for-port'}`; }

// timeoutMs is optional; undefined keeps the original no-timeout behavior for test callers.
function request(port, url, method = 'GET', body = '', timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { authorization: authFor(port), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (timeoutMs !== undefined) req.setTimeout(timeoutMs, () => req.destroy(new Error(`${url} timeout`)));
    req.end(body);
  });
}

function requestWithHeaders(port, url, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { authorization: authFor(port), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
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
    const req = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { authorization: authFor(port), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
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
async function startGatewayHarness({ keys, responses, maxBufferBytes, maxFailoverAttempts, rateLimitMaxAttempts, config, captureStderr, requireChatModel, upstreamHandlerOverride, startupDeadlineMs }) {
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
    if (upstreamHandlerOverride) { upstreamHandlerOverride(req, res); return; }
    // MASTER-008 guard (opt-in via requireChatModel): every real chat client
    // sends a `model`. A model-less chat request bypasses per-model key
    // selection and can silently certify failover behavior the request path
    // does not have — this harness can reject that shape loudly.
    if (requireChatModel && req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let model;
        try { model = JSON.parse(Buffer.concat(chunks).toString() || '{}').model; } catch { /* handled below */ }
        if (typeof model !== 'string' || model.length === 0) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'harness: chat request must carry a model field (MASTER-008)' }));
          return;
        }
        const response = responses.shift() ?? { status: 500 };
        res.writeHead(response.status, response.headers ?? { 'content-type': 'application/json' });
        if (response.abort) { res.write(response.body ?? 'x'); setTimeout(() => res.socket.destroy(), 5); return; }
        res.end(response.body ?? '{}');
      });
      return;
    }
    const response = responses.shift() ?? { status: 500 };
    res.writeHead(response.status, response.headers ?? { 'content-type': 'application/json' });
    if (response.abort) { res.write(response.body ?? 'x'); setTimeout(() => res.socket.destroy(), 5); return; }
    res.end(response.body ?? '{}');
  });  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let port;
  let child;
  // Unique per harness. /health is unauthenticated, so readiness trusts only this child's `ports:bound` for the expected port.
  const gatewayToken = `test-gateway-${randomUUID()}`;
  // ONE total startup budget across all port-race retries.
  const startupBudgetMs = startupDeadlineMs ?? 12_000;
  const totalStartupDeadline = Date.now() + startupBudgetMs;
  let attemptsMade = 0;
  let detachCollisionWatch;
  const cleanupHarness = async () => {
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const childStatusOf = (c) => (c ? `exitCode=${c.exitCode} signal=${c.signalCode}` : 'exitCode=none');
  const envAttempts = maxFailoverAttempts === null
    ? undefined
    : String(maxFailoverAttempts ?? responses.length);
  try {
    // Shared reserved-port start (maxAttempts 8): readiness is THIS child's
    // ports:bound for the reserved pair; killOnBindCollision() ends a child that
    // lost the bind race at once, so a fresh pair is tried immediately.
    const started = await startGatewayOnReservedPort({
      maxAttempts: GATEWAY_START_MAX_ATTEMPTS,
      reservationOptions: highPortReservation(),
      readinessTimeoutMs: Math.max(1, totalStartupDeadline - Date.now()),
      spawnChild(candidatePort, attempt) {
        // Total budget check per attempt: a non-collision error ends the helper's loop.
        if (Date.now() >= totalStartupDeadline) throw new Error(`gateway start budget exhausted after attempt ${attempt - 1}`);
        attemptsMade = attempt;
        port = candidatePort;
        // Only the child that is kept contributes to the test-facing stderr.
        stderrChunks.length = 0;
        const spawned = spawn(process.execPath, ['--require', path.join(root, 'tests/local-upstream-preload.cjs'), path.join(root, 'src/gateway/server.mjs')], {
          env: { ...process.env, GATEWAY_LOG_PATH: logPath, GATEWAY_MAX_FAILOVER_ATTEMPTS: envAttempts, GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: rateLimitMaxAttempts === undefined ? undefined : String(rateLimitMaxAttempts), GATEWAY_CONFIG_PATH: configPath, GATEWAY_MAX_BUFFERED_RESPONSE_BYTES: maxBufferBytes ? String(maxBufferBytes) : undefined, GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstream.address().port), PORT: String(candidatePort) },
          // stderr is always piped so a bind collision is detected; it is recorded only on request.
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true
        });
        child = spawned;
        detachCollisionWatch = killOnBindCollision(spawned);
        if (captureStderr) spawned.stderr.on('data', (chunk) => stderrChunks.push(chunk));
        spawned.once('message', (message) => {
          if (message?.type === 'ready') spawned.send({ type: 'state:init', challenge: message.challenge, state: { keys: JSON.parse(fs.readFileSync(statePath, 'utf8')).keys, credentials: { gatewayToken, adminToken: 'test-admin-token' } } });
        });
        spawned.on('message', (message) => {
          if (message?.type !== 'state:persist') return;
          fs.writeFileSync(statePath, JSON.stringify(message.state));
          // Durable (admin-mutation) persistence carries requestId + revision and
          // must be acknowledged by the "main process" stand-in after the write.
          if (typeof message.requestId === 'string') {
            try { spawned.send({ type: 'state:persist:ack', requestId: message.requestId, revision: message.revision }); } catch {}
          }
        });
        return spawned;
      }
    });
    child = started.child;
    port = started.port;
    detachCollisionWatch();
  } catch (error) {
    await stopChild(child);
    await cleanupHarness();
    if (Date.now() >= totalStartupDeadline) throw new Error(`stalled at: gateway startup (attempt ${attemptsMade}, >${startupBudgetMs}ms) ${childStatusOf(child)}`, { cause: error });
    throw error;
  }
  gatewayTokenByPort.set(port, gatewayToken);
  // ports:bound is attested; /health confirms the listener answers, within the total budget.
  let ready = false;
  while (Date.now() < totalStartupDeadline) {
    // Bounded probe: a child that accepts but never answers cannot hang past the deadline.
    const probeTimeoutMs = Math.max(1, Math.min(1_000, totalStartupDeadline - Date.now()));
    try { if ((await request(port, '/health', 'GET', '', probeTimeoutMs)).statusCode === 200) { ready = true; break; } } catch {}
    if (child.exitCode !== null || child.signalCode !== null) break;
    await delay(25);
  }
  if (!ready) {
    const childStatus = childStatusOf(child);
    await stopChild(child);
    gatewayTokenByPort.delete(port);
    await cleanupHarness();
    if (Date.now() >= totalStartupDeadline) throw new Error(`stalled at: gateway startup (attempt ${attemptsMade}, >${startupBudgetMs}ms) ${childStatus}`);
    throw new Error(`Gateway did not become healthy on port ${port}. ${childStatus}`);
  }
  return { port, gatewayToken, statePath, logPath, seenAuthorizations, stderr: () => Buffer.concat(stderrChunks).toString(), close: async () => {
    await stopChild(child);
    gatewayTokenByPort.delete(port);
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 1_000);
    // Fallback: never hang teardown if 'exit' is not delivered.
    const fallback = setTimeout(resolve, 2_000);
    child.once('exit', () => { clearTimeout(force); clearTimeout(fallback); resolve(); });
    child.kill();
  });
}
