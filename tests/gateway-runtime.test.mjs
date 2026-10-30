import assert from 'node:assert/strict';
import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UPSTREAM_REQUEST_HEADER_ALLOWLIST, buildUpstreamRequestHeaders } from '../src/gateway/proxy-headers.mjs';
import { createUpstreamSocketTimeouts, resolveGatewayTimeouts, resolveRequestDeadlineMs, resolveRetryFirstByteTimeoutMs } from '../src/gateway/upstream-timeouts.mjs';
import { getModelLimits, resetModelLimitsCache, setModelLimits } from '../src/gateway/model-limits.mjs';
import { startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';
import { GATEWAY_START_MAX_ATTEMPTS, highPortReservation, killOnBindCollision } from './support/gateway-bind-collision.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = await import(pathToFileURL(path.join(projectRoot, 'build', 'src', 'main', 'gateway-runtime.js')).href);
const lifecycle = await import(pathToFileURL(path.join(projectRoot, 'build', 'src', 'main', 'gateway-lifecycle.js')).href);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nvidia-gateway-runtime-test-${process.pid}-`));
const localUpstreamPreloadPath = path.join(projectRoot, 'tests', 'local-upstream-preload.cjs');
// Unique per test process so a foreign gateway on a raced port never shares our token.
const TEST_GATEWAY_TOKEN = `test-gateway-${randomUUID()}`;

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('buildUpstreamRequestHeaders emits ONLY allowlisted and gateway-owned headers', () => {
  // Round B B3 replaced the hop-by-hop deny list with an explicit allowlist, so
  // the old "every forbidden header is stripped" guarantee now has to hold in
  // the inverted (and strictly stronger) form: the built upstream header set is
  // exactly {allowlist ∩ client} ∪ {gateway-owned}. Nothing else can survive,
  // including hop-by-hop headers AND client credentials (cookie/x-api-key/
  // x-forwarded-for) that a deny list would have had to enumerate explicitly.
  const gatewayOwned = {
    host: 'integrate.api.nvidia.com',
    authorization: 'Bearer nvapi-upstream-key',
    'HTTP-Referer': 'https://opencode.ai/',
    'X-Title': 'opencode',
    'X-BILLING-INVOKE-ORIGIN': 'OpenCode'
  };
  const clientForbidden = {
    connection: 'forbidden',
    'keep-alive': 'forbidden',
    'proxy-connection': 'forbidden',
    'proxy-authorization': 'forbidden',
    te: 'trailers',
    trailer: 'forbidden',
    upgrade: 'forbidden',
    expect: 'forbidden',
    cookie: 'session=client-secret',
    'x-api-key': 'client-api-key',
    'x-forwarded-for': '203.0.113.10',
    'x-real-ip': '203.0.113.11',
    forwarded: 'for=203.0.113.12',
    'user-agent': 'private-client-agent',
    'x-client-metadata': 'private'
  };
  const clientAllowed = { accept: 'text/event-stream', 'content-type': 'application/json' };

  const built = buildUpstreamRequestHeaders(
    { ...clientForbidden, ...clientAllowed, authorization: 'Bearer client-supplied', 'x-title': 'client-forged-title' },
    { authorization: gatewayOwned.authorization, contentLength: 42 }
  );

  // The allowlist itself is the contract: accept + content-type only.
  assert.deepEqual(UPSTREAM_REQUEST_HEADER_ALLOWLIST, ['accept', 'content-type']);
  // Every emitted key is either an allowlisted client header or gateway-owned.
  const allowedKeys = new Set([...UPSTREAM_REQUEST_HEADER_ALLOWLIST, 'content-length', ...Object.keys(gatewayOwned)]);
  for (const key of Object.keys(built)) {
    assert.equal(allowedKeys.has(key), true, `${key} is neither allowlisted nor gateway-owned`);
  }
  for (const key of allowedKeys) {
    assert.equal(key in built, true, `${key} must be present in the built header set`);
  }
  // Allowed client headers pass through byte-for-byte...
  for (const [key, value] of Object.entries(clientAllowed)) assert.equal(built[key], value);
  // ...and every client-controlled forbidden header is ABSENT (case-insensitive
  // lookup mirrors how the upstream server reads them).
  const lowered = Object.fromEntries(Object.keys(built).map((key) => [key.toLowerCase(), key]));
  for (const key of Object.keys(clientForbidden)) {
    assert.equal(lowered[key.toLowerCase()], undefined, `${key} must not be forwarded`);
  }
  // Gateway-owned values overwrite any client forgery, and content-length is
  // exactly the stringified recomputed length — never the client's.
  assert.equal(built.authorization, gatewayOwned.authorization);
  assert.equal(built['X-Title'], 'opencode');
  assert.equal(built['HTTP-Referer'], 'https://opencode.ai/');
  assert.equal(built['X-BILLING-INVOKE-ORIGIN'], 'OpenCode');
  assert.equal(built.host, 'integrate.api.nvidia.com');
  assert.equal(built['content-length'], '42');
});

for (const proxyCase of [
  { name: '/v1/chat/completions', path: '/v1/chat/completions', method: 'POST', body: '{"stream":false}' },
  { name: '/v1/models', path: '/v1/models', method: 'GET', body: '' }
]) {
  test(`${proxyCase.name} strips required hop-by-hop request headers before forwarding`, async () => {
    let seenHeaders;
    const upstream = await createLocalUpstream((request, response) => {
      seenHeaders = request.headers;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(proxyCase.path === '/v1/models' ? '{"data":[]}' : '{"ok":true}');
    });
    let child;
    let gatewayPort;
    try {
      ({ child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port));
      const result = await requestGateway(gatewayPort, proxyCase.path, proxyCase.method, proxyCase.body, {
        'proxy-connection': 'forbidden',
        'proxy-authorization': 'forbidden',
        te: 'trailers',
        'x-allowed-test-header': 'preserved',
        accept: 'application/json'
      });
      assert.equal(result.statusCode, 200);
      // Round B B3 replaced the hop-by-hop deny list with an explicit request
      // header ALLOWLIST (accept, content-type), so the contract is now: a
      // client header outside the allowlist is DROPPED, and only the allowlisted
      // ones survive. Asserting the old "x-allowed-test-header is preserved"
      // expectation inverted the contract — that header is not allowlisted and
      // must never reach the upstream.
      assert.equal(seenHeaders['x-allowed-test-header'], undefined,
        'a client header outside UPSTREAM_REQUEST_HEADER_ALLOWLIST must be dropped');
      assert.equal(seenHeaders.accept, 'application/json', 'an allowlisted client header must survive');
      for (const header of ['proxy-connection', 'proxy-authorization', 'te']) {
        assert.equal(seenHeaders[header], undefined, `${header} must not reach upstream`);
      }
    } finally {
      await stopGateway(child);
      await closeServer(upstream);
    }
  });
}

test('/v1/models transformed response has exact byte length and valid content metadata', async () => {
  const upstream = await createLocalUpstream((_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'identity',
      'transfer-encoding': 'chunked'
    });
    response.end(JSON.stringify({ data: [{ id: 'z-ai/glm-5.2', object: 'model' }] }));
  });
  let child;
  let gatewayPort;
  try {
    ({ child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port));
    const result = await requestGateway(gatewayPort, '/v1/models');
    const parsed = JSON.parse(result.body);
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['transfer-encoding'], undefined);
    assert.equal(Number(result.headers['content-length']), Buffer.byteLength(result.body));
    assert.match(result.headers['content-type'], /^application\/json(?:;|$)/);
    assert.equal(result.headers['content-encoding'], 'identity');
    assert.equal(typeof parsed.data[0].context_length, 'number');
    assert.equal(typeof parsed.data[0].max_completion_tokens, 'number');
    assert.equal(parsed.data[0].max_tokens, parsed.data[0].context_length);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('/v1/models never emits undefined limits for prototype-chain model ids (W1 defect 7)', async () => {
  // A model id is attacker-influenced request data. `getModelLimits('constructor')`
  // used to answer Object's inherited member ({context: undefined, output:
  // undefined}) and that value was written straight into context_length /
  // max_completion_tokens / max_tokens — an undefined in the client-facing catalog.
  const upstream = await createLocalUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      data: ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'z-ai/glm-5.2']
        .map((id) => ({ id, object: 'model' }))
    }));
  });
  let child;
  let gatewayPort;
  try {
    ({ child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port));
    const result = await requestGateway(gatewayPort, '/v1/models');
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.includes('undefined'), false, 'the catalog must never contain undefined');
    const parsed = JSON.parse(result.body);
    for (const model of parsed.data) {
      assert.equal(Number.isSafeInteger(model.context_length), true, model.id + ' context_length');
      assert.equal(Number.isSafeInteger(model.max_completion_tokens), true, model.id + ' max_completion_tokens');
      assert.equal(model.max_tokens, model.context_length, model.id + ' max_tokens mirrors context_length');
    }
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('uses safe upstream socket timeout defaults when environment values are missing', () => {
  assert.deepEqual(resolveGatewayTimeouts({}), {
    firstByteTimeoutMs: 300_000,
    idleTimeoutMs: 300_000,
    maxStreamDurationMs: 1_800_000
  });
});

test('total request deadline env uses validated positive integer override, otherwise 240s', () => {
  assert.equal(resolveRequestDeadlineMs({}), 240_000);
  assert.equal(resolveRequestDeadlineMs({ GATEWAY_REQUEST_DEADLINE_MS: '60000' }), 60_000);
  assert.equal(resolveRequestDeadlineMs({ GATEWAY_REQUEST_DEADLINE_MS: '1800000' }), 1_800_000);
  for (const invalid of ['0', '-1', '3.5', '1800001', '99999999999999999', '1ms']) {
    assert.equal(resolveRequestDeadlineMs({ GATEWAY_REQUEST_DEADLINE_MS: invalid }), 240_000, invalid);
  }
});

test('accepts positive integer upstream socket timeout environment overrides', () => {
  assert.deepEqual(resolveGatewayTimeouts({
    GATEWAY_FIRST_BYTE_TIMEOUT_MS: '150013',
    GATEWAY_IDLE_TIMEOUT_MS: '90001',
    GATEWAY_MAX_STREAM_DURATION_MS: '900000'
  }), {
    firstByteTimeoutMs: 150_013,
    idleTimeoutMs: 90_001,
    maxStreamDurationMs: 900_000
  });
});

test('falls back to safe upstream socket timeout defaults for invalid environment values', () => {
  assert.deepEqual(resolveGatewayTimeouts({
    GATEWAY_FIRST_BYTE_TIMEOUT_MS: '0',
    GATEWAY_IDLE_TIMEOUT_MS: '90.5',
    GATEWAY_MAX_STREAM_DURATION_MS: 'not-a-number'
  }), {
    firstByteTimeoutMs: 300_000,
    idleTimeoutMs: 300_000,
    maxStreamDurationMs: 1_800_000
  });
  assert.deepEqual(resolveGatewayTimeouts({
    GATEWAY_FIRST_BYTE_TIMEOUT_MS: '-1',
    GATEWAY_IDLE_TIMEOUT_MS: 'not-a-number'
  }), {
    firstByteTimeoutMs: 300_000,
    idleTimeoutMs: 300_000,
    maxStreamDurationMs: 1_800_000
  });
});

test('falls back to defaults when an upstream timeout override exceeds the documented maximum', () => {
  assert.deepEqual(resolveGatewayTimeouts({
    GATEWAY_FIRST_BYTE_TIMEOUT_MS: '1800001',
    GATEWAY_IDLE_TIMEOUT_MS: '2147483648'
  }), {
    firstByteTimeoutMs: 300_000,
    idleTimeoutMs: 300_000,
    maxStreamDurationMs: 1_800_000
  });
});

test('clamps the total stream duration override to its documented range', () => {
  assert.equal(resolveGatewayTimeouts({ GATEWAY_MAX_STREAM_DURATION_MS: '1800000' }).maxStreamDurationMs, 1_800_000);
  assert.equal(resolveGatewayTimeouts({ GATEWAY_MAX_STREAM_DURATION_MS: '299999' }).maxStreamDurationMs, 300_000);
  assert.equal(resolveGatewayTimeouts({ GATEWAY_MAX_STREAM_DURATION_MS: '0' }).maxStreamDurationMs, 300_000);
  assert.equal(resolveGatewayTimeouts({ GATEWAY_MAX_STREAM_DURATION_MS: '3600000' }).maxStreamDurationMs, 3_600_000);
  assert.equal(resolveGatewayTimeouts({ GATEWAY_MAX_STREAM_DURATION_MS: '3600001' }).maxStreamDurationMs, 3_600_000);
  assert.equal(resolveGatewayTimeouts({ GATEWAY_MAX_STREAM_DURATION_MS: '2147483648' }).maxStreamDurationMs, 3_600_000);
  assert.equal(resolveGatewayTimeouts({ GATEWAY_MAX_STREAM_DURATION_MS: '9999999999999999999999' }).maxStreamDurationMs, 1_800_000);
});

test('switches an upstream socket from first-byte to idle timeout after the response starts', () => {
  const socket = new EventEmitter();
  const timeoutValues = [];
  const timeoutPhases = [];
  socket.setTimeout = (value) => timeoutValues.push(value);

  const timeouts = createUpstreamSocketTimeouts({
    firstByteTimeoutMs: 120_000,
    idleTimeoutMs: 90_000,
    onTimeout: (firstByteReceived) => timeoutPhases.push(firstByteReceived)
  });

  timeouts.attach(socket);
  socket.emit('timeout');
  timeouts.markFirstByteReceived();
  socket.emit('timeout');

  assert.deepEqual(timeoutValues, [120_000, 90_000]);
  assert.deepEqual(timeoutPhases, [false, true]);
});

test('resolveRetryFirstByteTimeoutMs collapses the 5-min fresh first-byte default to a 30s retry ceiling', () => {
  // Fresh requests keep the 5-min "day" default; RETRIES must be bounded to a
  // 30s ceiling so a hung upstream cannot stall each key switch for 5 minutes.
  assert.equal(resolveRetryFirstByteTimeoutMs(300_000), 30_000);
});

test('resolveRetryFirstByteTimeoutMs never exceeds the fresh first-byte timeout (min() clamp)', () => {
  // A retry should never tolerate MORE than a fresh request. When the fresh
  // window is smaller than the 30s retry default, the fresh window wins.
  assert.equal(resolveRetryFirstByteTimeoutMs(10_000), 10_000);
  assert.equal(resolveRetryFirstByteTimeoutMs(1_000), 1_000);
  assert.equal(resolveRetryFirstByteTimeoutMs(30_000), 30_000);
});

test('resolveRetryFirstByteTimeoutMs honors GATEWAY_RETRY_FIRST_BYTE_TIMEOUT_MS override, clamped by the fresh window', () => {
  assert.equal(resolveRetryFirstByteTimeoutMs(300_000, { GATEWAY_RETRY_FIRST_BYTE_TIMEOUT_MS: '5000' }), 5_000);
  assert.equal(resolveRetryFirstByteTimeoutMs(300_000, { GATEWAY_RETRY_FIRST_BYTE_TIMEOUT_MS: '1' }), 1);
  // Override larger than the fresh window -> min() clamps back down to fresh.
  assert.equal(resolveRetryFirstByteTimeoutMs(100_000, { GATEWAY_RETRY_FIRST_BYTE_TIMEOUT_MS: '999999' }), 100_000);
});

test('resolveRetryFirstByteTimeoutMs falls back to the 30s default for invalid/missing override', () => {
  assert.equal(resolveRetryFirstByteTimeoutMs(300_000, { GATEWAY_RETRY_FIRST_BYTE_TIMEOUT_MS: 'garbage' }), 30_000);
  assert.equal(resolveRetryFirstByteTimeoutMs(300_000, { GATEWAY_RETRY_FIRST_BYTE_TIMEOUT_MS: '-1' }), 30_000);
  assert.equal(resolveRetryFirstByteTimeoutMs(300_000, { GATEWAY_RETRY_FIRST_BYTE_TIMEOUT_MS: '0' }), 30_000);
  assert.equal(resolveRetryFirstByteTimeoutMs(300_000, {}), 30_000);
  assert.equal(resolveRetryFirstByteTimeoutMs(300_000, undefined), 30_000);
});

test('the retry first-byte ceiling (30s) bounds a hung upstream retry below the 5-min fresh default', () => {
  // Lever 2 of the per-switch delay fix: a RETRY's first-byte wait is capped at
  // 30s (DEFAULT_RETRY_FIRST_BYTE_TIMEOUT_MS), strictly below the 5-min fresh
  // window, so a hung / slow-to-429 upstream cannot stall each key switch for
  // the full fresh first-byte timeout on every retry. Lever 1 (the <=20s
  // no-Retry-After key cooldown mark, which getNextKey skips without blocking)
  // is covered in rotation.test.mjs.
  assert.equal(resolveRetryFirstByteTimeoutMs(300_000), 30_000);
  assert.ok(resolveRetryFirstByteTimeoutMs(300_000) < 300_000,
    'retry must be strictly below the 5-min fresh default');
  assert.ok(resolveRetryFirstByteTimeoutMs(30_000) <= 30_000,
    'retry ceiling never exceeds 30s');
});

test('gateway allows a delayed first byte that arrives before its configured timeout', async () => {
  const upstream = await createLocalUpstream((_request, response) => {
    setTimeout(() => response.end('{"ok":true}'), 50);
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port, {
    firstByteTimeoutMs: 100,
    idleTimeoutMs: 100
  });

  try {
    assert.deepEqual(await postGateway(gatewayPort, '{"stream":false}'), {
      statusCode: 200,
      body: '{"ok":true}',
      terminal: 'ended'
    });
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('first-byte timeout is accounted once and does not log its intentional request destroy as an upstream error', async () => {
  const upstream = await createLocalUpstream((_request, response) => {
    setTimeout(() => response.end('{"ok":true}'), 250);
  });
  let child;
  let gatewayPort;
  let logPath;

  try {
    ({ child, gatewayPort, logPath } = await startGatewayWithLocalUpstream(upstream.address().port));
    const result = await postGateway(gatewayPort, '{"stream":false}');

    // Owner decision 1a: one distinct pass (a single key = one attempt) of a
    // silent-before-answer upstream ends with the neutral 503, not the generic
    // 502 after repeating the one key up to the attempt floor.
    assert.deepEqual(result, {
      statusCode: 503,
      body: '{"error":"Upstream temporarily unavailable"}',
      terminal: 'ended'
    });
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  // Per-attempt accounting unchanged (one first-byte timeout = one key error);
  // the counts follow the attempt count (was 3 attempts, now 1).
  const logs = readGatewayLogs(logPath);
  assert.equal(countGatewayLogs(logs, 'Upstream first-byte timeout'), 1);
  assert.equal(countGatewayLogs(logs, 'Upstream request error'), 0);
  assert.equal(countGatewayLogs(logs, 'Upstream error, backing off'), 1);
});

test('stream idle timeout does not log its intentional upstream destroy as a request failure', async () => {
  const upstream = await createLocalUpstream((_request, response) => {
    response.write('{"chunk":1}');
  });
  let child;
  let gatewayPort;
  let logPath;

  try {
    ({ child, gatewayPort, logPath } = await startGatewayWithLocalUpstream(upstream.address().port));
    const result = await postGateway(gatewayPort, '{"stream":true}');

    assert.equal(result.statusCode, 200);
    assert.match(result.terminal, /^(aborted|error)$/);
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  const logs = readGatewayLogs(logPath);
  assert.equal(countGatewayLogs(logs, 'Upstream socket idle timeout'), 1);
  assert.equal(countGatewayLogs(logs, 'Upstream request error'), 0);
});

test('total request deadline stops key rotation and answers an honest 504 before the client ceiling (ЭТАП 1)', async () => {
  // A SILENT upstream that never sends a first byte. The first-byte window (2s) is longer than the 800ms TOTAL deadline, so the deadline cuts the only attempt: the gateway must answer the honest 504 request_deadline (not the 1a idle-round 503) while the client is still listening.
  const upstream = await createLocalUpstream(() => { /* never responds */ });
  let child;
  let gatewayPort;
  let logPath;

  // Tiny injected budget so the test runs in ~1s instead of 240s: an 800ms TOTAL
  // deadline that fires inside the first attempt's 2s first-byte window (the
  // 15-attempt budget is never reached).
  const DEADLINE_MS = 800;
  const CLIENT_CEILING_MS = 3_000; // stands in for the client's patience (undici ~300s in prod)

  try {
    ({ child, gatewayPort, logPath } = await startGatewayWithLocalUpstream(upstream.address().port, {
      // Decision 1a: a first-byte window SHORTER than the deadline now ends the
      // single-key round with the neutral 503; keep it above the deadline so the
      // deadline (Э1 504) is what stops the attempt.
      firstByteTimeoutMs: 2_000,
      idleTimeoutMs: 100,
      requestDeadlineMs: DEADLINE_MS,
      maxFailoverAttempts: 15
    }));

    const startedAt = Date.now();
    const result = await postGateway(gatewayPort, '{"stream":false}', CLIENT_CEILING_MS);
    const elapsedMs = Date.now() - startedAt;

    // Honest HTTP error delivered WHILE THE CLIENT IS STILL LISTENING: a real
    // 504 with a body that ended cleanly (terminal 'ended', never 'aborted'),
    // distinct from the 502 "All failover attempts exhausted" path.
    assert.equal(result.statusCode, 504, `expected an honest 504 deadline answer, got ${result.statusCode}`);
    assert.equal(result.body, '{"error":"Gateway request deadline exceeded"}');
    assert.equal(result.terminal, 'ended', 'the client must receive a clean response, not a socket abort');

    // The whole request finished within its budget and well before the client
    // would have given up. Without the deadline the attempt would wait out its
    // full 2s first-byte window instead of stopping at the ~800ms budget.
    assert.ok(elapsedMs < CLIENT_CEILING_MS, `request must finish before the client ceiling; took ${elapsedMs}ms`);
    assert.ok(elapsedMs < 2_000, `the deadline must bound total time near ${DEADLINE_MS}ms; took ${elapsedMs}ms`);

    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  // The log must name the deadline as the DISTINCT stop reason, so "ran out of
  // time" is never confused with "ran out of keys" (reused earlyStopReason field
  // NAME, new VALUE).
  const logs = readGatewayLogs(logPath);
  const verdict = logs.find((entry) => entry.message === 'All failover attempts exhausted');
  assert.ok(verdict, 'the exhaustion/deadline verdict line must be logged');
  assert.equal(verdict.earlyStopReason, 'request_deadline', 'the stop reason must be the distinct deadline value');
  assert.equal(verdict.earlyStop, true, 'a deadline stop before the attempt budget is an early stop');
});

test('request deadline expires despite periodic partial precommit SSE bytes', { timeout: 30_000 }, async () => {
  const upstream = await createLocalUpstream((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.end('{"data":[]}'); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"unfinished');
    const drip = setInterval(() => response.write('x'), 40);
    response.once('close', () => clearInterval(drip));
  });
  let child;
  try {
    const started = await startGatewayWithLocalUpstream(upstream.address().port, {
      firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000, requestDeadlineMs: 320, maxFailoverAttempts: 15
    });
    child = started.child;
    const startedAt = Date.now();
    const answer = await postGatewayBeforeHeadersDeadline(started.gatewayPort, '{"stream":true}', 1_500);
    assert.equal(answer.statusCode, 504);
    assert.equal(answer.body, '{"error":"Gateway request deadline exceeded"}');
    assert.equal(answer.terminal, 'ended');
    assert.ok(Date.now() - startedAt < 1_200, 'periodic upstream bytes cannot postpone the total deadline');
    await waitForGatewayLogFlush();
    assert.ok(readGatewayLogs(started.logPath).some((entry) => entry.earlyStopReason === 'request_deadline'));
    assert.deepEqual(readGatewayLogs(started.logPath)
      .filter((entry) => entry.message === 'request_outcome')
      .map((entry) => entry.outcome), ['request_deadline'],
      'a deadline-aborted precommit attempt records one honest terminal outcome');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('P0: partial upstream SSE idles before downstream commit, then a DISTINCT key completes without aborting the client', { timeout: 30_000 }, async () => {
  const seen = [];
  const recovered = 'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n';
  const upstream = await createLocalUpstream((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.end('{"data":[]}'); return; }
    seen.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (request.headers.authorization === 'Bearer key-a') {
      response.write('data: {"choices":[{"delta":{"content":"unfinished');
    } else {
      response.end(recovered);
    }
  });
  let started;
  try {
    started = await startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b'], firstByteTimeoutMs: 1_000, idleTimeoutMs: 90,
      requestDeadlineMs: 420, maxFailoverAttempts: 10
    });
    const answer = await postGateway(started.gatewayPort, '{"stream":true}', 1_500);
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended', 'precommit idle must not destroy the downstream');
    assert.equal(answer.body, recovered, 'held partial bytes from A must not leak into B');
    assert.deepEqual(seen, ['Bearer key-a', 'Bearer key-b']);
    await waitForGatewayLogFlush();
    const logs = readGatewayLogs(started.logPath);
    assert.deepEqual(logs.filter((entry) => entry.message === 'request_outcome').map((entry) => entry.outcome),
      ['idle_timeout', 'completed'], 'each attempt has exactly one honest outcome');
    assert.equal(countGatewayLogs(logs, 'Upstream error, backing off'), 0, 'idle must not penalize the key');
    await waitForKeyStateSave();
    const keys = JSON.parse(fs.readFileSync(started.statePath, 'utf8')).keys;
    assert.equal(keys.find((key) => key.key === 'key-a').usage.fail, 0);
  } finally {
    await stopGateway(started?.child);
    await closeServer(upstream);
  }
});

test('P0: idle retry yields a clean 504 if the deadline arrives before the distinct circle completes', { timeout: 30_000 }, async () => {
  const seen = [];
  let onB;
  const bStarted = new Promise((resolve) => { onB = resolve; });
  const drips = new Set();
  const upstream = await createLocalUpstream((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.end('{"data":[]}'); return; }
    seen.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"unfinished');
    if (request.headers.authorization === 'Bearer key-b') {
      // Barrier: B has begun. Keep its incomplete frame alive through D, so C
      // can only start if the deadline incorrectly loses to a retry.
      const drip = setInterval(() => { if (!response.destroyed) response.write('x'); }, 30);
      drips.add(drip);
      response.once('close', () => { clearInterval(drip); drips.delete(drip); });
      onB();
    }
  });
  let started;
  try {
    started = await startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b', 'key-c'], firstByteTimeoutMs: 1_000, idleTimeoutMs: 90,
      requestDeadlineMs: 500, maxFailoverAttempts: 3
    });
    const answerPending = postGatewayBeforeHeadersDeadline(started.gatewayPort, '{"stream":true}', 2_000);
    let bWatchdog;
    try {
      await Promise.race([bStarted, new Promise((_, reject) => {
        bWatchdog = setTimeout(() => reject(new Error('B did not start before watchdog')), 1_500);
      })]);
    } finally {
      clearTimeout(bWatchdog);
    }
    const answer = await answerPending;
    assert.deepEqual({ status: answer.statusCode, terminal: answer.terminal, body: answer.body },
      { status: 504, terminal: 'ended', body: '{"error":"Gateway request deadline exceeded"}' });
    assert.deepEqual(seen, ['Bearer key-a', 'Bearer key-b'], 'D interrupts the held B before C starts');
    assert.equal(new Set(seen).size, seen.length);
    await waitForGatewayLogFlush();
    const logs = readGatewayLogs(started.logPath);
    const outcomes = logs.filter((entry) => entry.message === 'request_outcome').map((entry) => entry.outcome);
    assert.equal(outcomes.length, seen.length, 'exactly one terminal outcome per started attempt');
    assert.deepEqual(outcomes, ['idle_timeout', 'request_deadline']);
    assert.ok(logs.some((entry) => entry.earlyStopReason === 'request_deadline'));
    assert.equal(countGatewayLogs(logs, 'Upstream error, backing off'), 0);
  } finally {
    for (const drip of drips) clearInterval(drip);
    await stopGateway(started?.child);
    await closeServer(upstream);
  }
});

test('P0: client aborts while partial SSE is held: no retry or key penalty after the idle boundary', { timeout: 30_000 }, async () => {
  const seen = [];
  let signalFirstChunk;
  const firstChunk = new Promise((resolve) => { signalFirstChunk = resolve; });
  const upstream = await createLocalUpstream((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.end('{"data":[]}'); return; }
    seen.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"unfinished');
    signalFirstChunk();
  });
  let started;
  try {
    started = await startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b'], firstByteTimeoutMs: 1_000, idleTimeoutMs: 90, requestDeadlineMs: 420
    });
    await new Promise((resolve, reject) => {
      const body = '{"stream":true}';
      const request = http.request({ host: '127.0.0.1', port: started.gatewayPort, path: '/v1/chat/completions', method: 'POST',
        headers: { authorization: `Bearer ${TEST_GATEWAY_TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
      }, (response) => response.resume());
      request.once('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
      request.end(body);
      Promise.race([firstChunk, new Promise((_, fail) => setTimeout(() => fail(new Error('upstream did not write')), 900))])
        .then(() => { request.destroy(); resolve(); }, reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.deepEqual(seen, ['Bearer key-a'], 'do not launch B after client disconnect');
    await waitForGatewayLogFlush();
    const logs = readGatewayLogs(started.logPath);
    assert.deepEqual(logs.filter((entry) => entry.message === 'request_outcome').map((entry) => entry.outcome),
      ['client_aborted']);
    await waitForKeyStateSave();
    const keys = JSON.parse(fs.readFileSync(started.statePath, 'utf8')).keys;
    assert.equal(keys.find((key) => key.key === 'key-a').usage.fail, 0, 'abort must not penalize the key');
  } finally {
    await stopGateway(started?.child);
    await closeServer(upstream);
  }
});

test('P0: a shared deadline before the first byte never charges a per-key first-byte penalty', { timeout: 30_000 }, async () => {
  const upstream = await createLocalUpstream((request, response) => {
    if (request.url !== '/v1/chat/completions') response.end('{"data":[]}');
  });
  let started;
  try {
    started = await startGatewayWithLocalUpstream(upstream.address().port, {
      firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000, requestDeadlineMs: 180,
      maxFailoverAttempts: 10
    });
    const answer = await postGateway(started.gatewayPort, '{"stream":true}', 1_500);
    assert.equal(answer.statusCode, 504);
    assert.equal(answer.terminal, 'ended');
    assert.equal(answer.body, '{"error":"Gateway request deadline exceeded"}');
    await waitForGatewayLogFlush();
    const logs = readGatewayLogs(started.logPath);
    assert.deepEqual(logs.filter((entry) => entry.message === 'request_outcome').map((entry) => entry.outcome), ['request_deadline']);
    assert.equal(countGatewayLogs(logs, 'Upstream first-byte timeout'), 0);
    assert.equal(JSON.parse(fs.readFileSync(started.statePath, 'utf8')).keys[0].usage.fail, 0);
  } finally {
    await stopGateway(started?.child);
    await closeServer(upstream);
  }
});

test('P0: incomplete non-2xx error body idles before commit, then a distinct key answers cleanly', { timeout: 30_000 }, async () => {
  const seen = [];
  const upstream = await createLocalUpstream((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.end('{"data":[]}'); return; }
    seen.push(request.headers.authorization);
    if (request.headers.authorization === 'Bearer key-a') {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.write('{"error":"unfinished');
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n');
    }
  });
  let started;
  try {
    started = await startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b'], firstByteTimeoutMs: 1_000, idleTimeoutMs: 90, requestDeadlineMs: 420
    });
    const result = await postGateway(started.gatewayPort, '{"stream":true}', 1_500);
    assert.equal(result.statusCode, 200);
    assert.equal(result.terminal, 'ended');
    assert.deepEqual(seen, ['Bearer key-a', 'Bearer key-b']);
    assert.match(result.body, /recovered/);
    await waitForGatewayLogFlush();
    const logs = readGatewayLogs(started.logPath);
    assert.deepEqual(logs.filter((entry) => entry.message === 'request_outcome')
      .map((entry) => entry.outcome), ['idle_timeout', 'completed']);
    assert.equal(countGatewayLogs(logs, 'Upstream error, backing off'), 0,
      'incomplete 503 body cancelled by idle is not a completed upstream 503 key failure');
    await waitForKeyStateSave();
    const keys = JSON.parse(fs.readFileSync(started.statePath, 'utf8')).keys;
    const a = keys.find((key) => key.key === 'key-a');
    assert.equal(a.usage.fail, 0, 'partial non-2xx A is not charged a failure');
    assert.equal(a.backoffUntil, 0, 'partial non-2xx A is not placed into backoff');
  } finally {
    await stopGateway(started?.child);
    await closeServer(upstream);
  }
});

test('QA race RED-first: abort client at B-start after A precommit transport error; no late retry or duplicate outcome', { timeout: 30_000 }, async () => {
  const seen = [];
  let aResponse;
  let onA;
  const aStarted = new Promise((resolve) => { onA = resolve; });
  let onB;
  const bStarted = new Promise((resolve) => { onB = resolve; });
  const upstream = await createLocalUpstream((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.end('{"data":[]}'); return; }
    seen.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (request.headers.authorization === 'Bearer key-a') {
      aResponse = response;
      response.write('data: {"choices":[{"delta":{"content":"unfinished');
      onA();
    } else {
      // The upstream receives B only after A has settled retryably. Abort the
      // same downstream client at this barrier, before B can send headers.
      onB();
    }
  });
  let started;
  let request;
  let watchdog;
  let expectedAbort = false;
  let unexpectedClientError;
  let requestClosed;
  let rejectClientError;
  const clientError = new Promise((_, reject) => { rejectClientError = reject; });
  clientError.catch(() => {}); // An early request error must be handled before the first barrier.
  let primary; // The try block's own failure; cleanup errors must never mask it.
  try {
    started = await startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b', 'key-c'], firstByteTimeoutMs: 2_000,
      idleTimeoutMs: 2_000, requestDeadlineMs: 4_000, maxFailoverAttempts: 3,
      upstreamBodyBarrier: true
    });
    const body = '{"stream":true}';
    request = http.request({ host: '127.0.0.1', port: started.gatewayPort, path: '/v1/chat/completions', method: 'POST',
      headers: { authorization: `Bearer ${TEST_GATEWAY_TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, (response) => response.resume());
    requestClosed = new Promise((resolve) => request.once('close', resolve));
    request.on('error', (error) => {
      if (!expectedAbort || error.code !== 'ECONNRESET') {
        unexpectedClientError = error;
        rejectClientError(error);
      }
    });
    request.end(body);
    const bounded = (promise, name) => Promise.race([promise, clientError, new Promise((_, reject) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => reject(new Error(`barrier ${name} not reached`)), 5_000);
    })]);
    await bounded(aStarted, 'A');
    // Confirm that the gateway received A's partial response, not just that
    // the fake upstream wrote it: the next action must exercise the response
    // stream's precommit aborted/error listeners, not a first-byte socket error.
    await bounded(started.firstUpstreamBody, 'gateway received A body');
    aResponse.socket.destroy();
    await bounded(bStarted, 'B after A error');
    expectedAbort = true;
    request.destroy();
    await withTimeout(requestClosed, 3_000, 'requestClosed');
    assert.equal(unexpectedClientError, undefined, 'unexpected client error must reject the controlled barrier promise');
    clearTimeout(watchdog);
    await waitForGatewayLogFlush();
    assert.deepEqual(seen, ['Bearer key-a', 'Bearer key-b'], 'abort at B-start forbids a late C or replayed A');
    const logs = readGatewayLogs(started.logPath);
    const outcomes = logs.filter((entry) => entry.message === 'request_outcome');
    assert.deepEqual(outcomes.map((entry) => entry.outcome), ['upstream_stream_error', 'client_aborted'],
      'one terminal outcome for each started attempt; aborted B never completes');
    assert.equal(new Set(outcomes.map((entry) => entry.id)).size, 2, 'distinct key IDs per attempt');
  } catch (e) {
    primary = e;
    throw e;
  } finally {
    clearTimeout(watchdog);
    expectedAbort = true;
    request?.destroy();
    // Bounded, and cleanup still runs if it stalls; the labeled error is rethrown after
    // only when the body itself passed, so it never replaces the primary failure.
    let requestClosedError;
    if (requestClosed) await withTimeout(requestClosed, 3_000, 'requestClosed').catch((error) => { requestClosedError = error; });
    await stopGateway(started?.child);
    await closeServer(upstream);
    if (requestClosedError && !primary) throw requestClosedError;
  }
});

test('QA barrier: partial A idle leaves outer answer pending until B completes, with no stale A bytes', { timeout: 30_000 }, async () => {
  const seen = [];
  let onB;
  const bStarted = new Promise((resolve) => { onB = resolve; });
  let finishB;
  const recovered = 'data: {"choices":[{"delta":{"content":"only-b"}}]}\n\ndata: [DONE]\n\n';
  const upstream = await createLocalUpstream((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.end('{"data":[]}'); return; }
    seen.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (request.headers.authorization === 'Bearer key-a') {
      response.write('data: {"choices":[{"delta":{"content":"must-never-leak');
    } else if (request.headers.authorization === 'Bearer key-b') {
      finishB = () => response.end(recovered);
      onB();
    } else {
      response.end('data: [DONE]\n\n');
    }
  });
  let startup;
  let started;
  let answerPending;
  let cancelAnswer;
  try {
    startup = startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b', 'key-c'], firstByteTimeoutMs: 1_000,
      idleTimeoutMs: 300, requestDeadlineMs: 1_800, maxFailoverAttempts: 3
    });
    started = await withTimeout(startup, 12_000, 'startGatewayWithLocalUpstream');
    let settled = false;
    answerPending = postGatewayBeforeHeadersDeadline(started.gatewayPort, '{"stream":true}', 2_500,
      (request) => { cancelAnswer = () => request.destroy(); })
      .finally(() => { settled = true; });
    answerPending.catch(() => {}); // Observe rejection immediately, including before the B watchdog.
    await withTimeout(waitForBStartOrCancel(bStarted, answerPending, cancelAnswer, 1_400), 2_000, 'waitForBStartOrCancel');
    assert.equal(settled, false, 'outer request cannot settle or expose A while B has not returned');
    assert.deepEqual(seen, ['Bearer key-a', 'Bearer key-b']);
    finishB();
    const answer = await withTimeout(answerPending, 3_000, 'answerPending');
    assert.deepEqual(answer, { statusCode: 200, body: recovered, terminal: 'ended' });
    await withTimeout(waitForGatewayLogFlush(), 1_500, 'waitForGatewayLogFlush');
    assert.deepEqual(readGatewayLogs(started.logPath).filter((entry) => entry.message === 'request_outcome')
      .map((entry) => entry.outcome), ['idle_timeout', 'completed']);
    assert.deepEqual(seen, ['Bearer key-a', 'Bearer key-b'], 'no late C after B success');
    await withTimeout(stopGateway(started?.child), 4_500, 'stopGateway');
  } finally {
    cancelAnswer?.();
    if (answerPending) await Promise.allSettled([answerPending]);
    if (started) {
      await stopGateway(started.child);
    } else if (startup) {
      // Startup outlived its limit: reap the late child instead of orphaning it (bounded so cleanup never hangs).
      await withTimeout(startup.then((late) => stopGateway(late.child), () => {}), 5_000, 'orphanCleanup').catch(() => {});
    }
    await closeServer(upstream);
  }
});

// Labeled per-step limit so a stall reports which await hung instead of a bare test timeout.
function withTimeout(promise, ms, label) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`stalled at: ${label} (>${ms}ms)`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

test('QA barrier failure: B never starts; cancel the client before its ceiling without late rejection or open sockets', { timeout: 30_000 }, async () => {
  let onB;
  const bStarted = new Promise((resolve) => { onB = resolve; });
  let chatAttempts = 0;
  const upstream = await createLocalUpstream((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.end('{"data":[]}'); return; }
    chatAttempts += 1;
    if (request.headers.authorization === 'Bearer key-b') { onB(); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"unfinished');
    const drip = setInterval(() => response.write('x'), 30);
    response.once('close', () => clearInterval(drip));
  });
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  let started;
  let client;
  let clientClosed;
  let answerPending;
  let startup;
  try {
    startup = startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b'], firstByteTimeoutMs: 1_000, idleTimeoutMs: 900,
      requestDeadlineMs: 4_000, maxFailoverAttempts: 2
    });
    started = await withTimeout(startup, 12_000, 'startGatewayWithLocalUpstream');
    const startedAt = Date.now();
    answerPending = postGatewayBeforeHeadersDeadline(started.gatewayPort, '{"stream":true}', 2_500, (request) => {
      client = request;
      clientClosed = new Promise((resolve) => request.once('close', resolve));
    });
    answerPending.catch(() => {}); // Startup/failure before the barrier also has an immediate observer.
    await assert.rejects(withTimeout(waitForBStartOrCancel(bStarted, answerPending, () => client.destroy(), 200),
      1_500, 'waitForBStartOrCancel'), /B never started while response held/);
    assert.equal(chatAttempts, 1, 'A started and the held B never started');
    await withTimeout(clientClosed, 1_500, 'clientClosed');
    assert.ok(Date.now() - startedAt < 1_500, 'client must close well before the 2500ms ceiling');
    assert.equal(client.destroyed, true);
    await withTimeout(stopGateway(started?.child), 4_500, 'stopGateway');
    await new Promise((resolve) => setTimeout(resolve, 2_600)); // Observe past the former 2500ms late rejection ceiling.
    const connections = await new Promise((resolve, reject) => upstream.getConnections((error, count) => error ? reject(error) : resolve(count)));
    assert.equal(connections, 0, 'the fixture has no open upstream sockets after teardown');
    assert.deepEqual(unhandled, [], 'no unhandled rejection after the abandoned B barrier');
  } finally {
    client?.destroy();
    if (answerPending) await Promise.allSettled([answerPending]);
    if (started) {
      await stopGateway(started.child);
    } else if (startup) {
      // Startup outlived its limit: reap the late child instead of orphaning it (bounded so cleanup never hangs).
      await withTimeout(startup.then((late) => stopGateway(late.child), () => {}), 5_000, 'orphanCleanup').catch(() => {});
    }
    await closeServer(upstream);
    process.off('unhandledRejection', onUnhandled);
  }
});

test('P0: max-stream timer fires before SSE commit, retries a distinct key instead of aborting the client', { timeout: 30_000 }, async () => {
  const seen = [];
  const upstream = await createLocalUpstream((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.end('{"data":[]}'); return; }
    seen.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (request.headers.authorization === 'Bearer key-a') response.write('data: {"choices":[{"delta":{"content":"unfinished');
    else response.end('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n');
  });
  let started;
  try {
    started = await startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b'], firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000,
      requestDeadlineMs: 420, maxStreamTimerTestMs: 90
    });
    const answer = await postGateway(started.gatewayPort, '{"stream":true}', 1_500);
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended');
    assert.deepEqual(seen, ['Bearer key-a', 'Bearer key-b']);
    assert.match(answer.body, /recovered/);
    await waitForGatewayLogFlush();
    const logs = readGatewayLogs(started.logPath);
    assert.deepEqual(logs.filter((entry) => entry.message === 'request_outcome').map((entry) => entry.outcome),
      ['max_stream_duration', 'completed']);
    assert.equal(countGatewayLogs(logs, 'Upstream error, backing off'), 0);
  } finally {
    await stopGateway(started?.child);
    await closeServer(upstream);
  }
});

test('a committed SSE stream survives the precommit deadline clamp', { timeout: 30_000 }, async () => {
  const upstream = await createLocalUpstream((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.end('{"data":[]}'); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    setTimeout(() => response.end('data: [DONE]\n\n'), 650);
  });
  let child;
  try {
    const started = await startGatewayWithLocalUpstream(upstream.address().port, {
      firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000, requestDeadlineMs: 320
    });
    child = started.child;
    const result = await postGateway(started.gatewayPort, '{"stream":true}', 1_500);
    assert.equal(result.statusCode, 200);
    assert.equal(result.terminal, 'ended');
    assert.match(result.body, /data: \[DONE\]/);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('genuine upstream request error is logged and accounted for', async () => {
  const upstream = await createLocalUpstream((request) => {
    request.socket.destroy();
  });
  let child;
  let gatewayPort;
  let logPath;

  try {
    ({ child, gatewayPort, logPath } = await startGatewayWithLocalUpstream(upstream.address().port));
    const result = await postGateway(gatewayPort, '{"stream":false}');

    assert.deepEqual(result, {
      statusCode: 502,
        body: '{"error":"All failover attempts exhausted","detail":"1 key tried (3 attempts): 3 dropped the connection."}',
        terminal: 'ended'
    });
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  const logs = readGatewayLogs(logPath);
  assert.equal(countGatewayLogs(logs, 'Upstream request error'), 3);
  assert.equal(countGatewayLogs(logs, 'Upstream error, backing off'), 3);
});

test('non-2xx diagnostic logging excludes an upstream-controlled error-message sentinel', async () => {
  const clientSecret = 'client-authorization-secret';
  const promptSecret = 'private prompt text';
  const upstreamSecret = 'upstream-api-key-secret';
  const upstreamMessageSecret = 'UPSTREAM_ERROR_MESSAGE_SENTINEL_DO_NOT_LOG';
  const requestBody = JSON.stringify({
    model: 'vendor/missing-model',
    stream: false,
    messages: [{ role: 'user', content: promptSecret }]
  });
  const upstreamBody = JSON.stringify({
    error: {
      code: 'model_not_found',
      message: upstreamMessageSecret
    },
    prompt: promptSecret,
    api_key: upstreamSecret
  });
  const upstream = await createLocalUpstream((_request, response) => {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(upstreamBody);
  });
  let child;
  let gatewayPort;
  let logPath;

  try {
    ({ child, gatewayPort, logPath } = await startGatewayWithLocalUpstream(upstream.address().port));
    const result = await postGateway(gatewayPort, requestBody, 2_000, {
      'x-redaction-sentinel': `Bearer ${clientSecret}`
    });

    // The CLIENT must not receive a credential-named leaf either: the gateway
    // scrubs `api_key` before echoing the upstream error (the original assertion
    // pinned a verbatim echo, i.e. the very leak). Everything else in the
    // upstream envelope (code, message, prompt) is still forwarded.
    assert.equal(result.statusCode, 404);
    assert.equal(result.terminal, 'ended');
    const echoed = JSON.parse(result.body);
    assert.equal(echoed.api_key, '[REDACTED]', 'a credential-named upstream leaf is redacted for the client');
    assert.equal(result.body.includes(upstreamSecret), false, 'the upstream credential never reaches the client');
    assert.equal(echoed.error.code, 'model_not_found', 'the actionable upstream code is preserved');
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  const logText = fs.readFileSync(logPath, 'utf8');
  const diagnostic = readGatewayLogs(logPath).find((entry) => entry.message === 'Upstream non-2xx response');

  assert.deepEqual(diagnostic, {
    timestamp: diagnostic.timestamp,
    level: 'warn',
    message: 'Upstream non-2xx response',
    statusCode: 404,
    model: 'vendor/missing-model',
    upstreamCode: 'model_not_found'
  });
  assert.equal(logText.includes(clientSecret), false);
  assert.equal(logText.includes(promptSecret), false);
  assert.equal(logText.includes(upstreamSecret), false);
  assert.equal(logText.includes(upstreamMessageSecret), false);
});

test('records one failed terminal outcome when a non-2xx upstream response aborts before end', async () => {
  const upstream = await createLocalUpstream((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.write('{"error":{"code":"temporarily_unavailable"');
    setTimeout(() => response.socket.destroy(), 10);
  });
  let child;
  let gatewayPort;
  let logPath;
  let statePath;

  try {
    ({ child, gatewayPort, logPath, statePath } = await startGatewayWithLocalUpstream(upstream.address().port));
    const result = await postGateway(gatewayPort, '{"stream":false}');
    assert.equal(result.statusCode, 503);
    assert.match(result.terminal, /^(aborted|error)$/);
    await waitForKeyStateSave();
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  const outcomes = readGatewayLogs(logPath)
    .filter((entry) => entry.message === 'request_outcome')
    .map(({ outcome }) => outcome);
  assert.deepEqual(outcomes, ['upstream_stream_error']);
  assert.equal(readKeyUsage(statePath).success, 0);
});

test('forwards chunked SSE error bytes unchanged and records a safe upstream SSE failure', async () => {
  const clientSecret = 'client-authorization-secret';
  const promptSecret = 'private prompt text';
  const upstreamSecret = 'upstream-api-key-secret';
  const originalBytes = `event: error\ndata: ${JSON.stringify({
    error: {
      code: 'upstream_failure',
      type: 'server_error',
      status_code: 502,
      message: upstreamSecret
    },
    prompt: promptSecret,
    api_key: upstreamSecret
  })}\n\n`;
  const upstream = await createLocalUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(originalBytes.slice(0, 19));
    setTimeout(() => {
      response.write(originalBytes.slice(19, 67));
      response.end(originalBytes.slice(67));
    }, 10);
  });
  let child;
  let gatewayPort;
  let logPath;
  let statePath;

  try {
    ({ child, gatewayPort, logPath, statePath } = await startGatewayWithLocalUpstream(upstream.address().port));
    const result = await postGateway(gatewayPort, JSON.stringify({
      stream: true,
      messages: [{ role: 'user', content: promptSecret }]
    }), 2_000, { 'x-redaction-sentinel': `Bearer ${clientSecret}` });

    assert.deepEqual(result, {
      statusCode: 502,
      body: JSON.stringify({ error: 'All failover attempts exhausted', detail: '1 key tried (3 attempts): 3 sent a stream error.' }),
      terminal: 'ended'
    });
    await waitForKeyStateSave();
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  const logs = readGatewayLogs(logPath);
  const logText = fs.readFileSync(logPath, 'utf8');
  const responseStartedEvents = logs.filter((entry) => entry.message === 'Upstream response started');
  const outcomes = logs.filter((entry) => entry.message === 'request_outcome');

  assert.equal(responseStartedEvents.length, 3);
  assert.deepEqual({ ...responseStartedEvents[0], id: '[uuid]' }, {
    timestamp: responseStartedEvents[0].timestamp,
    level: 'info',
    message: 'Upstream response started',
    id: '[uuid]',
    upstreamStatus: 200,
    stream: true,
    contentType: 'text/event-stream'
  });
  assert.deepEqual(outcomes.map(({ outcome }) => outcome), ['upstream_sse_error', 'upstream_sse_error', 'upstream_sse_error']);
  assert.equal(readKeyUsage(statePath).success, 0);
  assert.equal(logText.includes(clientSecret), false);
  assert.equal(logText.includes(promptSecret), false);
  assert.equal(logText.includes(upstreamSecret), false);
});

test('records an SSE error from data without an event error frame and preserves its bytes', async () => {
  const originalBytes = `data: ${JSON.stringify({
    error: {
      code: 'upstream_failure',
      type: 'server_error',
      status: 502,
      message: 'UPSTREAM_SSE_ERROR_MESSAGE_SENTINEL'
    }
  })}\n\n`;
  const upstream = await createLocalUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(originalBytes);
  });
  let child;
  let gatewayPort;
  let logPath;
  let statePath;

  try {
    ({ child, gatewayPort, logPath, statePath } = await startGatewayWithLocalUpstream(upstream.address().port));
    assert.deepEqual(await postGateway(gatewayPort, '{"stream":true}'), {
      statusCode: 502,
      body: JSON.stringify({ error: 'All failover attempts exhausted', detail: '1 key tried (3 attempts): 3 sent a stream error.' }),
      terminal: 'ended'
    });
    await waitForKeyStateSave();
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  assert.deepEqual(readGatewayLogs(logPath)
    .filter((entry) => entry.message === 'request_outcome')
    .map(({ outcome }) => outcome), ['upstream_sse_error', 'upstream_sse_error', 'upstream_sse_error']);
  assert.equal(readKeyUsage(statePath).success, 0);
});

test('records incomplete_stream and no success when a 200 SSE response ends without DONE', async () => {
  const originalBytes = 'data: {"id":"chunk-1"}\n\n';
  const upstream = await createLocalUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(originalBytes);
  });
  let child;
  let gatewayPort;
  let logPath;
  let statePath;

  try {
    ({ child, gatewayPort, logPath, statePath } = await startGatewayWithLocalUpstream(upstream.address().port));
    const result = await postGateway(gatewayPort, '{"stream":true}');
    assert.equal(result.statusCode, 200);
    assert.equal(result.body, originalBytes);
    // Decision 3a: benign-only EOF without [DONE] is "not finished" -> transport abort.
    assert.ok(result.terminal === 'aborted' || result.terminal === 'error', `expected transport abort, got ${result.terminal}`);
    await waitForKeyStateSave();
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  assert.deepEqual(readGatewayLogs(logPath)
    .filter((entry) => entry.message === 'request_outcome')
    .map(({ outcome }) => outcome), ['incomplete_stream']);
  assert.equal(readKeyUsage(statePath).success, 0);
});

test('forwards the first SSE chunk before the controlled upstream response closes', async () => {
  const firstChunk = 'data: {"id":"chunk-1"}\n\n';
  const doneChunk = 'data: [DONE]\n\n';
  let upstreamClosedAt = 0;
  const upstream = await createLocalUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(firstChunk);
    setTimeout(() => {
      upstreamClosedAt = Date.now();
      response.end(doneChunk);
    }, 25);
  });
  let child;
  let gatewayPort;

  try {
    ({ child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port));
    const result = await postGatewayWithFirstChunkTiming(gatewayPort, '{"stream":true}');
    assert.equal(result.statusCode, 200);
    assert.equal(result.body, firstChunk + doneChunk);
    assert.equal(result.terminal, 'ended');
    assert.ok(result.firstChunkAt > 0, 'client must receive a first chunk');
    assert.ok(upstreamClosedAt > 0, 'upstream must close under test control');
    assert.ok(result.firstChunkAt < upstreamClosedAt, 'first client chunk must arrive before upstream closes');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('records a completed outcome and success accounting for a normal SSE stream ending with DONE', async () => {
  const originalBytes = 'data: {"id":"chunk-1"}\n\ndata: [DONE]\n\n';
  const upstream = await createLocalUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(originalBytes.slice(0, 28));
    setTimeout(() => response.end(originalBytes.slice(28)), 10);
  });
  let child;
  let gatewayPort;
  let logPath;
  let statePath;

  try {
    ({ child, gatewayPort, logPath, statePath } = await startGatewayWithLocalUpstream(upstream.address().port));
    assert.deepEqual(await postGateway(gatewayPort, '{"stream":true}'), {
      statusCode: 200,
      body: originalBytes,
      terminal: 'ended'
    });
    await waitForKeyStateSave();
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  const logs = readGatewayLogs(logPath);
  assert.deepEqual(logs
    .filter((entry) => entry.message === 'request_outcome')
    .map(({ outcome }) => outcome), ['completed']);
  assert.equal(readKeyUsage(statePath).success, 1);
});

test('records upstream_stream_error when an upstream transport fails after a 200 stream starts', async () => {
  const upstream = await createLocalUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"id":"partial"}\n\n');
    setTimeout(() => response.socket.destroy(), 10);
  });
  let child;
  let gatewayPort;
  let logPath;

  try {
    ({ child, gatewayPort, logPath } = await startGatewayWithLocalUpstream(upstream.address().port));
    const result = await postGateway(gatewayPort, '{"stream":true}');
    assert.equal(result.statusCode, 200);
    assert.match(result.terminal, /^(aborted|error)$/);
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  const logs = readGatewayLogs(logPath);
  assert.deepEqual(logs
    .filter((entry) => entry.message === 'request_outcome')
    .map(({ outcome }) => outcome), ['upstream_stream_error']);
});

test('records client_aborted when the streaming client disconnects', async () => {
  const upstream = await createLocalUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"id":"partial"}\n\n');
  });
  let child;
  let gatewayPort;
  let logPath;

  try {
    ({ child, gatewayPort, logPath } = await startGatewayWithLocalUpstream(upstream.address().port));
    await postGatewayAndAbortAfterFirstChunk(gatewayPort, '{"stream":true}');
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  const logs = readGatewayLogs(logPath);
  assert.deepEqual(logs
    .filter((entry) => entry.message === 'request_outcome')
    .map(({ outcome }) => outcome), ['client_aborted']);
});

// ── Level-1 Round C regression block (defects C1/C2). ───────────────────────
// The pre-commit SSE gate must distinguish "upstream sent a real body we are
// holding" from "upstream sent nothing at all":
//   * a benign-only REAL body (frames carrying no content/role/finish/error)
//     is honest to the client and NOT a failover candidate — dropping it and
//     retrying produced `502 All failover attempts exhausted` with a single
//     key, and even with several keys it burned the pool on a healthy stream;
//   * a TRULY EMPTY 200 stream (zero bytes) must still fail over — that is the
//     2026-09-16 incident protection and it stays;
//   * a benign prelude followed by meaningful content commits normally;
//   * a client that aborts while benign frames are held must settle promptly
//     (the held bytes have to reach the client, otherwise the client never
//     observes a first chunk and the abort path can never run — the hang).

test('C1: a benign-only real SSE body is proxied, accounted honestly, and never fails over', async () => {
  // Real upstream body, no meaningful content, no [DONE], no error frame, and
  // an upstream that ends normally. Nothing here justifies a retry: the client
  // must receive exactly these bytes with a 200 and the key must not be charged
  // a failover retry.
  const originalBytes = 'data: {"id":"chunk-1"}\n\n';
  const seenChatAuthorizations = [];
  const upstream = await createLocalUpstream((request, response) => {
    // Only the Chat Completions forward is a failover attempt; the gateway also
    // probes the model catalog on a timer, and that probe must not be counted.
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[]}');
      return;
    }
    seenChatAuthorizations.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(originalBytes);
  });
  let child;
  let gatewayPort;
  let logPath;
  let statePath;

  try {
    ({ child, gatewayPort, logPath, statePath } = await startGatewayWithLocalUpstream(upstream.address().port));
    const result = await postGateway(gatewayPort, '{"stream":true}');
    assert.equal(result.statusCode, 200);
    assert.equal(result.body, originalBytes);
    // Decision 3a: benign-only EOF without [DONE] is "not finished" -> transport abort.
    assert.ok(result.terminal === 'aborted' || result.terminal === 'error', `expected transport abort, got ${result.terminal}`);
    await waitForKeyStateSave();
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  assert.equal(seenChatAuthorizations.length, 1, 'a benign real body must not be retried on a fresh key');
  const outcomes = readGatewayLogs(logPath)
    .filter((entry) => entry.message === 'request_outcome')
    .map(({ outcome }) => outcome);
  // Honest accounting: the stream ended without [DONE], so it is incomplete —
  // but it was NOT retryable and the bytes were not dropped. (The key's usage is
  // unchanged from the pre-existing contract of test #24: incomplete_stream is
  // not a success, because the client never received a completed completion.)
  assert.deepEqual(outcomes, ['incomplete_stream']);
  assert.equal(readKeyUsage(statePath).success, 0,
    'a body with no meaningful content and no [DONE] is not a success');
});

test('C1: a genuinely empty 200 SSE stream is still retryable and fails over (incident protection)', async () => {
  // The 2026-09-16 protection: an upstream 200 that produces NOTHING must not be
  // presented to the client as a successful empty completion — the failover loop
  // retries the next key.
  const recoveredBody = 'data: {"choices":[{"delta":{"content":"recovered-b"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
  const seenAuthorizations = [];
  const upstream = await createLocalUpstream((request, response) => {
    // The gateway also probes the model catalog; only a chat forward is an
    // attempt that must be counted.
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[]}');
      return;
    }
    seenAuthorizations.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (seenAuthorizations.length === 1) {
      // Empty 200: the stream ends before a single byte is written.
      response.end();
      return;
    }
    response.end(recoveredBody);
  });
  let child;
  let gatewayPort;
  let logPath;

  try {
    ({ child, gatewayPort, logPath } = await startGatewayWithLocalUpstream(upstream.address().port));
    const result = await postGateway(gatewayPort, '{"stream":true}');
    assert.equal(result.statusCode, 200, 'the recovered key must serve the client');
    assert.equal(result.body, recoveredBody);
    assert.equal(result.terminal, 'ended');
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  assert.deepEqual(seenAuthorizations, ['Bearer local-test-key', 'Bearer local-test-key'],
    'an empty upstream stream must fail over to the next attempt');
  // The empty attempt settles as a retryable incomplete_stream, and the
  // recovered attempt then completes — the retry is the point of the test.
  assert.deepEqual(readGatewayLogs(logPath)
    .filter((entry) => entry.message === 'request_outcome')
    .map(({ outcome }) => outcome), ['incomplete_stream', 'completed']);
});

test('C1: a benign prelude followed by meaningful content commits the stream normally', async () => {
  const benign = 'data: {"id":"chunk-1"}\n\n';
  const meaningful = 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n';
  const done = 'data: [DONE]\n\n';
  const upstream = await createLocalUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(benign);
    setTimeout(() => {
      response.write(meaningful);
      setTimeout(() => response.end(done), 10);
    }, 10);
  });
  let child;
  let gatewayPort;
  let logPath;
  let statePath;

  try {
    ({ child, gatewayPort, logPath, statePath } = await startGatewayWithLocalUpstream(upstream.address().port));
    assert.deepEqual(await postGateway(gatewayPort, '{"stream":true}'), {
      statusCode: 200,
      body: benign + meaningful + done,
      terminal: 'ended'
    });
    await waitForKeyStateSave();
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  assert.deepEqual(readGatewayLogs(logPath)
    .filter((entry) => entry.message === 'request_outcome')
    .map(({ outcome }) => outcome), ['completed']);
  assert.equal(readKeyUsage(statePath).success, 1);
});

test('C2: a client abort while benign frames are held settles as client_aborted (no hang)', { timeout: 30_000 }, async () => {
  // The client only aborts AFTER observing a first chunk, so the gateway has to
  // release the held benign bytes. If it does not, the client never sees a
  // chunk, never destroys the request, and the outcome never settles. The
  // explicit 15s timeout is the REAL bound on this test: node:test defaults to
  // no per-test timeout, and the production maxStreamDurationMs (30 min) would
  // otherwise be the only limit, far too slow to fail fast. The abort helper
  // carries its own 10s deadline for the same reason.
  const upstream = await createLocalUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"id":"partial"}\n\n');
  });
  let child;
  let gatewayPort;
  let logPath;

  try {
    ({ child, gatewayPort, logPath } = await startGatewayWithLocalUpstream(upstream.address().port));
    await postGatewayAndAbortAfterFirstChunk(gatewayPort, '{"stream":true}');
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  assert.deepEqual(readGatewayLogs(logPath)
    .filter((entry) => entry.message === 'request_outcome')
    .map(({ outcome }) => outcome), ['client_aborted']);
});

test('C1: a >64KiB benign real body is proxied byte-for-byte and committed', async () => {
  // The bounded hold must never silently drop a large benign body: once real
  // bytes exist the response is proxied honestly regardless of size.
  const bigBenignFrame = 'data: {"id":"' + 'x'.repeat(80 * 1024) + '"}\n\n';
  const done = 'data: [DONE]\n\n';
  const upstream = await createLocalUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(bigBenignFrame);
    setTimeout(() => response.end(done), 10);
  });
  let child;
  let gatewayPort;
  let logPath;
  let statePath;

  try {
    ({ child, gatewayPort, logPath, statePath } = await startGatewayWithLocalUpstream(upstream.address().port));
    const result = await postGateway(gatewayPort, '{"stream":true}', 5_000);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body, bigBenignFrame + done, 'the oversized benign body must not be dropped or truncated');
    assert.equal(result.terminal, 'ended');
    await waitForKeyStateSave();
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  assert.deepEqual(readGatewayLogs(logPath)
    .filter((entry) => entry.message === 'request_outcome')
    .map(({ outcome }) => outcome), ['completed']);
  assert.equal(readKeyUsage(statePath).success, 1);
});

// ── Level-1 Round D regression block (defect D1). ───────────────────────────
// The post-commit meaningful-frame detector used to be a THROWAWAY parser
// rebuilt per chunk (chunkContainsMeaningfulOpenAiSseFrame), so a meaningful
// frame split across two post-commit TCP writes was never recognized:
// meaningfulContentForwarded stayed false and a later truncation (no [DONE])
// omitted the synthetic incomplete_stream marker even though the client had
// already received real content. The detector is now the same persistent
// parser that classified the pre-commit phase, so the frame completes across
// chunks. The marker stays additive: a stream with NO meaningful content is
// still proxied byte-for-byte (the guard below, plus the pre-existing
// `records incomplete_stream ... without DONE` contract).

test('D1: a meaningful frame split across post-commit chunks aborts without the incomplete_stream marker', async () => {
  const benign = 'data: {"id":"chunk-1"}\n\n';
  const meaningfulHalf1 = 'data: {"choices":[{"delta":{"content":"hel';
  const meaningfulHalf2 = 'lo"},"finish_reason":null}]}\n\n';
  const seenChatAuthorizations = [];
  const upstream = await createLocalUpstream((request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[]}');
      return;
    }
    seenChatAuthorizations.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // 1) benign frame -> released to the client (the stream is real);
    // 2) meaningful frame split across two writes -> post-commit phase;
    // 3) truncation: upstream ends with no [DONE].
    response.write(benign);
    setTimeout(() => {
      response.write(meaningfulHalf1);
      setTimeout(() => {
        response.write(meaningfulHalf2);
        setTimeout(() => response.end(), 10);
      }, 10);
    }, 10);
  });
  let child;
  let gatewayPort;
  let logPath;
  let statePath;

  try {
    ({ child, gatewayPort, logPath, statePath } = await startGatewayWithLocalUpstream(upstream.address().port));
    const result = await postGateway(gatewayPort, '{"stream":true}', 5_000);
    assert.equal(result.statusCode, 200);
    // Plan L1 (обрывы): after a meaningful commit the break is a transport
    // abort — the forwarded bytes are kept verbatim, no [DONE]/marker JSON.
    assert.equal(result.body, benign + meaningfulHalf1 + meaningfulHalf2,
      'a truncated stream whose split meaningful frame reached the client must not gain a synthetic marker/[DONE]');
    assert.ok(!result.body.includes('data: [DONE]'), 'no clean [DONE] after a committed upstream break');
    assert.ok(result.terminal === 'aborted' || result.terminal === 'error', `expected transport abort, got ${result.terminal}`);
    await waitForKeyStateSave();
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  assert.equal(seenChatAuthorizations.length, 1,
    'the released stream must not be retried on a fresh key (contract B)');
  assert.deepEqual(readGatewayLogs(logPath)
    .filter((entry) => entry.message === 'request_outcome')
    .map(({ outcome }) => outcome), ['incomplete_stream']);
  assert.equal(readKeyUsage(statePath).success, 0,
    'an incomplete stream is never a success');
});

test('D1 guard: a split BENIGN frame is still proxied byte-for-byte with no marker', async () => {
  const benignHalf1 = 'data: {"id":"chunk-';
  const benignHalf2 = '1"}\n\n';
  const seenChatAuthorizations = [];
  const upstream = await createLocalUpstream((request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[]}');
      return;
    }
    seenChatAuthorizations.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(benignHalf1);
    setTimeout(() => {
      response.write(benignHalf2);
      setTimeout(() => response.end(), 10);
    }, 10);
  });
  let child;
  let gatewayPort;
  let logPath;
  let statePath;

  try {
    ({ child, gatewayPort, logPath, statePath } = await startGatewayWithLocalUpstream(upstream.address().port));
    const result = await postGateway(gatewayPort, '{"stream":true}', 5_000);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body, benignHalf1 + benignHalf2,
      'a body without meaningful content must stay byte-for-byte');
    // Decision 3a: benign-only EOF without [DONE] is "not finished" -> transport abort.
    assert.ok(result.terminal === 'aborted' || result.terminal === 'error', `expected transport abort, got ${result.terminal}`);
    await waitForKeyStateSave();
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  assert.equal(seenChatAuthorizations.length, 1);
  assert.deepEqual(readGatewayLogs(logPath)
    .filter((entry) => entry.message === 'request_outcome')
    .map(({ outcome }) => outcome), ['incomplete_stream']);
  assert.equal(readKeyUsage(statePath).success, 0);
});

test('D2: the pre-commit hold byte budget is reset on both release and commit', () => {
  // `precommitHeldBytes` is a per-attempt pre-commit budget: it is incremented
  // when bytes are held, and it MUST return to zero the moment the held bytes
  // are flushed (release) or the stream commits — otherwise a later hold path
  // reads a phantom overflow. The two helpers are the only flush points, so pin
  // the reset in each by source invariant (a behavioural test cannot observe a
  // counter whose stale value only matters on a path that no longer runs).
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'gateway', 'server.mjs'), 'utf8');
  const commitHelper = /const commitHeldSseStream = [\s\S]*?\n {12}\};/.exec(source)?.[0] ?? '';
  const releaseHelper = /const releaseHeldSseStream = [\s\S]*?\n {12}\};/.exec(source)?.[0] ?? '';

  assert.notEqual(commitHelper, '', 'commitHeldSseStream helper must exist');
  assert.notEqual(releaseHelper, '', 'releaseHeldSseStream helper must exist');
  assert.match(commitHelper, /precommitHeldBytes = 0;/, 'commit must reset the hold budget');
  assert.match(releaseHelper, /precommitHeldBytes = 0;/, 'release must reset the hold budget');
});

test('initializes portable runtime state under userData', () => {
  const paths = runtime.ensureGatewayRuntime(tempRoot);

  assert.equal(paths.configPath, path.join(tempRoot, 'config.json'));
  assert.equal(paths.statePath, path.join(tempRoot, 'keys.json'));
  assert.equal(paths.logPath, path.join(tempRoot, 'logs', 'gateway.jsonl'));
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.configPath, 'utf8')), {
    version: 1,
    gatewayPort: 12000,
    language: 'en',
    setupComplete: false,
    performanceMode: 'day',
    autoStartGateway: true,
    modelLimits: {
      'deepseek-ai/deepseek-v4-flash': { context: 1_048_576, output: 393_216 },
      'deepseek-ai/deepseek-v4.1-flash': { context: 1_048_576, output: 1_048_576 },
      'stepfun-ai/step-3.7-flash': { context: 256_000, output: 16_384 },
      'meta/llama-4-maverick-17b-128e-instruct': { context: 128_000, output: 4_096 },
      'qwen/qwen3.5-397b-a17b': { context: 262_144, output: 8_192 },
      'z-ai/glm-5.2': { context: 202_752, output: 131_072 },
      'minimaxai/minimax-m3': { context: 1_000_000, output: 16_384 }
    },
    perModelSettings: {
      'stepfun-ai/step-3.7-flash': {
        enabled: true,
        performanceMode: 'day',
        firstByteTimeoutMs: 300000,
        idleTimeoutMs: 300000,
        maxStreamDurationMs: 1800000,
        maxFailoverAttempts: 3
      }
    },
    disabledModels: [
      'deepseek-ai/deepseek-v4-pro',
      'deepseek/deepseek-v4-pro'
    ]
  });
  assert.equal(fs.existsSync(paths.statePath), false);
});

test('upgrades legacy config with DeepSeek V4.1 built-in limits without replacing wildcard or explicit override', () => {
  const model = 'deepseek-ai/deepseek-v4.1-flash';
  const legacyRoot = path.join(tempRoot, 'legacy-v41-default');
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'config.json'), JSON.stringify({
    version: 1, gatewayPort: 12000, modelLimits: { '*': { context: 131072, output: 4096 } }
  }));
  runtime.ensureGatewayRuntime(legacyRoot);
  const upgraded = JSON.parse(fs.readFileSync(path.join(legacyRoot, 'config.json'), 'utf8'));
  assert.deepEqual(upgraded.modelLimits['*'], { context: 131072, output: 4096 });
  assert.deepEqual(upgraded.modelLimits[model], { context: 1048576, output: 1048576 });

  const overrideRoot = path.join(tempRoot, 'legacy-v41-explicit');
  fs.mkdirSync(overrideRoot, { recursive: true });
  fs.writeFileSync(path.join(overrideRoot, 'config.json'), JSON.stringify({
    version: 1, gatewayPort: 12000,
    modelLimits: { '*': { context: 131072, output: 4096 }, [model]: { context: 700000, output: 600000 } }
  }));
  runtime.ensureGatewayRuntime(overrideRoot);
  const preserved = JSON.parse(fs.readFileSync(path.join(overrideRoot, 'config.json'), 'utf8'));
  assert.deepEqual(preserved.modelLimits[model], { context: 700000, output: 600000 });
});

function writeLegacyDeepSeekLimitsConfig(root) {
  const configPath = path.join(root, 'config.json');
  const original = '{\n  "version": 1,\n  "gatewayPort": 12000,\n  "modelLimits": { "*": { "context": 131072, "output": 4096 } }\n}\n';
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(configPath, original, 'utf8');
  return { configPath, original, temporaryPath: `${configPath}.known-model-limits.tmp` };
}

function assertLegacyConfigStillUsesSafeDeepSeekLimits(configPath) {
  const previousConfigPath = process.env.GATEWAY_CONFIG_PATH;
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  process.env.GATEWAY_CONFIG_PATH = configPath;
  resetModelLimitsCache();
  setModelLimits(parsed.modelLimits ?? {});
  try {
    assert.deepEqual(getModelLimits('deepseek-ai/deepseek-v4.1-flash'), { context: 1048576, output: 1048576 });
  } finally {
    setModelLimits({});
    resetModelLimitsCache();
    if (previousConfigPath === undefined) delete process.env.GATEWAY_CONFIG_PATH;
    else process.env.GATEWAY_CONFIG_PATH = previousConfigPath;
  }
}

test('DeepSeek limits migration write failure is best-effort and leaves the valid config unchanged', (t) => {
  const root = path.join(tempRoot, 'legacy-v41-write-failure');
  const { configPath, original, temporaryPath } = writeLegacyDeepSeekLimitsConfig(root);
  const realWriteFileSync = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(temporaryPath)) {
      throw Object.assign(new Error('synthetic migration write failure'), { code: 'EACCES' });
    }
    return realWriteFileSync(target, ...args);
  });

  assert.doesNotThrow(() => runtime.ensureGatewayRuntime(root));
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.equal(fs.existsSync(temporaryPath), false);
  assertLegacyConfigStillUsesSafeDeepSeekLimits(configPath);
});

test('DeepSeek limits migration rename failure is best-effort and preserves original bytes', (t) => {
  const root = path.join(tempRoot, 'legacy-v41-rename-failure');
  const { configPath, original, temporaryPath } = writeLegacyDeepSeekLimitsConfig(root);
  const realRenameSync = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (path.resolve(String(source)) === path.resolve(temporaryPath)
      && path.resolve(String(destination)) === path.resolve(configPath)) {
      throw Object.assign(new Error('synthetic migration rename failure'), { code: 'EPERM' });
    }
    return realRenameSync(source, destination);
  });

  assert.doesNotThrow(() => runtime.ensureGatewayRuntime(root));
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.equal(fs.existsSync(temporaryPath), false);
  assertLegacyConfigStillUsesSafeDeepSeekLimits(configPath);
});

test('DeepSeek limits migration cleanup failure is contained and deletes no unrelated file', (t) => {
  const root = path.join(tempRoot, 'legacy-v41-cleanup-failure');
  const { configPath, original, temporaryPath } = writeLegacyDeepSeekLimitsConfig(root);
  const unrelatedPath = path.join(root, 'unrelated.keep');
  fs.writeFileSync(unrelatedPath, 'keep-me', 'utf8');
  const realUnlinkSync = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (target) => {
    if (path.resolve(String(target)) === path.resolve(temporaryPath)) {
      throw Object.assign(new Error('synthetic migration cleanup failure'), { code: 'EPERM' });
    }
    return realUnlinkSync(target);
  });
  const protector = {
    protectDirectory: () => {},
    protectFile: (target) => {
      if (path.resolve(target) === path.resolve(temporaryPath)) throw new Error('stop before rename');
    }
  };

  assert.doesNotThrow(() => runtime.ensureGatewayRuntime(root, protector));
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.equal(fs.readFileSync(unrelatedPath, 'utf8'), 'keep-me');
  assert.equal(fs.existsSync(temporaryPath), true);
  assertLegacyConfigStillUsesSafeDeepSeekLimits(configPath);
});

test('creates a child environment with explicit state, logs, and selected port', () => {
  const paths = runtime.ensureGatewayRuntime(tempRoot);
  const options = runtime.createGatewaySpawnOptions('C:\\resources\\gateway\\server.mjs', paths, 24000);

  assert.deepEqual(options.args, ['C:\\resources\\gateway\\server.mjs']);
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(options.env.GATEWAY_STATE_PATH, undefined);
  assert.equal(options.env.GATEWAY_LOG_PATH, paths.logPath);
  assert.equal(options.env.PORT, '24000');
});

test('filters parent environment to Windows essentials and explicit gateway spawn values', () => {
  const originalEnv = process.env;
  process.env = {
    systemroot: 'C:\\Windows',
    temp: 'C:\\sandbox\\temp',
    TMP: 'C:\\sandbox\\tmp',
    userprofile: 'C:\\sandbox\\profile',
    Path: 'C:\\Windows\\System32',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    pathext: '.COM;.EXE;.BAT;.CMD',
    windir: 'C:\\Windows',
    NODE_OPTIONS: '--require=C:\\sandbox\\injected.cjs',
    ELECTRON_ENABLE_LOGGING: '1',
    GATEWAY_CORS_ORIGIN: 'https://untrusted.example',
    SECRET_SHOULD_NOT_LEAK: 'synthetic-sensitive-value',
    UNRELATED: 'unrelated-value',
    ELECTRON_RUN_AS_NODE: 'parent-electron-value',
    GATEWAY_LOG_PATH: 'C:\\parent\\gateway.jsonl',
    GATEWAY_CONFIG_PATH: 'C:\\parent\\config.json',
    PORT: '11111'
  };

  try {
    const paths = runtime.ensureGatewayRuntime(tempRoot);
    const options = runtime.createGatewaySpawnOptions('C:\\resources\\gateway\\server.mjs', paths, 24000);

    assert.deepEqual(options.env, {
      systemroot: 'C:\\Windows',
      temp: 'C:\\sandbox\\temp',
      TMP: 'C:\\sandbox\\tmp',
      userprofile: 'C:\\sandbox\\profile',
      Path: 'C:\\Windows\\System32',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      pathext: '.COM;.EXE;.BAT;.CMD',
      windir: 'C:\\Windows',
      ELECTRON_RUN_AS_NODE: '1',
      GATEWAY_LOG_PATH: paths.logPath,
      GATEWAY_CONFIG_PATH: paths.configPath,
      PORT: '24000'
    });
  } finally {
    process.env = originalEnv;
  }
});

test('forwards only the approved GATEWAY_* tuning knobs from the parent environment', () => {
  const originalEnv = process.env;
  process.env = {
    PATH: 'C:\\Windows\\System32',
    GATEWAY_FIRST_BYTE_TIMEOUT_MS: '301000',
    GATEWAY_REQUEST_DEADLINE_MS: '234567',
    GATEWAY_IDLE_TIMEOUT_MS: '302000',
    GATEWAY_MAX_STREAM_DURATION_MS: '1800000',
    GATEWAY_MAX_FAILOVER_ATTEMPTS: '3',
    GATEWAY_MAX_BUFFERED_RESPONSE_BYTES: '1048576',
    GATEWAY_CORS_ALLOWLIST: 'https://untrusted.example',
    GATEWAY_STATE_PATH: 'C:\\must-not-forward\\keys.json',
    SECRET_SHOULD_NOT_LEAK: 'synthetic-sensitive-value'
  };

  try {
    const paths = runtime.ensureGatewayRuntime(tempRoot);
    const options = runtime.createGatewaySpawnOptions('C:\\resources\\gateway\\server.mjs', paths, 24000);

    assert.equal(options.env.GATEWAY_FIRST_BYTE_TIMEOUT_MS, '301000');
    assert.equal(options.env.GATEWAY_REQUEST_DEADLINE_MS, '234567');
    assert.equal(options.env.GATEWAY_IDLE_TIMEOUT_MS, '302000');
    assert.equal(options.env.GATEWAY_MAX_STREAM_DURATION_MS, '1800000');
    assert.equal(options.env.GATEWAY_MAX_FAILOVER_ATTEMPTS, '3');
    assert.equal(options.env.GATEWAY_MAX_BUFFERED_RESPONSE_BYTES, '1048576');
    assert.equal('GATEWAY_CORS_ALLOWLIST' in options.env, false);
    assert.equal('GATEWAY_STATE_PATH' in options.env, false);
    assert.equal('SECRET_SHOULD_NOT_LEAK' in options.env, false);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(options.env.GATEWAY_LOG_PATH, paths.logPath);
    assert.equal(options.env.GATEWAY_CONFIG_PATH, paths.configPath);
    assert.equal(options.env.PORT, '24000');
  } finally {
    process.env = originalEnv;
  }
});

test('forwards NV_GATEWAY_DIRECT_GLM_PROBE to the child environment only when set', () => {
  const originalEnv = process.env;
  process.env = {
    PATH: 'C:\\Windows\\System32',
    NV_GATEWAY_DIRECT_GLM_PROBE: '1'
  };
  try {
    const paths = runtime.ensureGatewayRuntime(tempRoot);
    const options = runtime.createGatewaySpawnOptions('C:\\resources\\gateway\\server.mjs', paths, 24000);
    assert.equal(options.env.NV_GATEWAY_DIRECT_GLM_PROBE, '1');

    process.env = { PATH: 'C:\\Windows\\System32' };
    const cleanOptions = runtime.createGatewaySpawnOptions('C:\\resources\\gateway\\server.mjs', paths, 24000);
    assert.equal('NV_GATEWAY_DIRECT_GLM_PROBE' in cleanOptions.env, false);
  } finally {
    process.env = originalEnv;
  }
});

test('forwards every capability-probe GATEWAY_CAPABILITY_* knob documented in capability-probe.mjs', () => {
  // Regression: the parent->child environment subset forwarded only six
  // GATEWAY_* knobs, none of them GATEWAY_CAPABILITY_*, while
  // src/gateway/capability-probe.mjs reads SIX of them. The subset dropped each
  // one silently, so the documented operator override never reached the process
  // that reads it. The names below are exactly the ones the probe module reads:
  //   capability-probe.mjs:109  GATEWAY_CAPABILITY_PROBE_TIMEOUT_MS
  //   capability-probe.mjs:526/881 GATEWAY_CAPABILITY_PROBE_TTL_MS
  //   capability-probe.mjs:553  GATEWAY_CAPABILITY_CACHE_PATH
  //   capability-probe.mjs:790  GATEWAY_CAPABILITY_PROBE_ENABLE
  //   capability-probe.mjs:791  GATEWAY_CAPABILITY_PROBE_DISABLE
  //   capability-probe.mjs:799  GATEWAY_CAPABILITY_PROBE_MAX_PER_SWEEP
  const capabilityKnobs = {
    GATEWAY_CAPABILITY_CACHE_PATH: 'C:\\capability-cache\\reasoning-capabilities.json',
    GATEWAY_CAPABILITY_PROBE_TTL_MS: '3600000',
    GATEWAY_CAPABILITY_PROBE_TIMEOUT_MS: '9000',
    GATEWAY_CAPABILITY_PROBE_MAX_PER_SWEEP: '7',
    GATEWAY_CAPABILITY_PROBE_DISABLE: '1',
    GATEWAY_CAPABILITY_PROBE_ENABLE: '1'
  };
  const originalEnv = process.env;
  process.env = {
    PATH: 'C:\\Windows\\System32',
    ...capabilityKnobs,
    // A non-allowlisted GATEWAY_* must still be filtered, so the widening does
    // not become a blanket pass-through for operator-shaped variables.
    GATEWAY_CAPABILITY_UNLISTED_KNOB: 'must-not-forward',
    GATEWAY_CORS_ALLOWLIST: 'https://untrusted.example',
    SECRET_SHOULD_NOT_LEAK: 'synthetic-sensitive-value'
  };

  try {
    const paths = runtime.ensureGatewayRuntime(tempRoot);
    const options = runtime.createGatewaySpawnOptions('C:\\resources\\gateway\\server.mjs', paths, 24000);

    for (const [name, value] of Object.entries(capabilityKnobs)) {
      assert.equal(options.env[name], value, `${name} must survive createGatewaySpawnOptions`);
    }
    assert.equal('GATEWAY_CAPABILITY_UNLISTED_KNOB' in options.env, false,
      'a non-allowlisted GATEWAY_CAPABILITY_* var must NOT be forwarded');
    assert.equal('GATEWAY_CORS_ALLOWLIST' in options.env, false);
    assert.equal('SECRET_SHOULD_NOT_LEAK' in options.env, false);
    // The explicit spawn values are still set, not shadowed by the widened set.
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(options.env.GATEWAY_LOG_PATH, paths.logPath);
    assert.equal(options.env.GATEWAY_CONFIG_PATH, paths.configPath);
    assert.equal(options.env.PORT, '24000');
  } finally {
    process.env = originalEnv;
  }
});

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((conn) => {
      // Consume data from the connection so that it does not stall the
      // TCP receive buffers when a health check probes this port.
      conn.resume();
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

async function freeGatewayPort() {
  const probe = await listen(0);
  const port = probe.address().port;
  await close(probe);
  if (port >= 65534) return freeGatewayPort();

  const adminProbe = await listen(port + 1).catch(() => null);
  if (!adminProbe) return freeGatewayPort();
  await close(adminProbe);
  return port;
}

function getHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/health' }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.setTimeout(2_000, () => request.destroy(new Error('Health request timed out.')));
  });
}

function waitForBStartOrCancel(bStarted, answerPending, cancel, watchdogMs) {
  // Attach both a fulfillment and a rejection observer before waiting for B.
  const settledAnswer = answerPending.then(
    () => { throw new Error('outer answer settled before B started'); },
    (error) => { throw error; }
  );
  let watchdog;
  return Promise.race([bStarted, settledAnswer, new Promise((_, reject) => {
    watchdog = setTimeout(() => reject(new Error('B never started while response held')), watchdogMs);
  })]).catch(async (error) => {
    cancel();
    await Promise.allSettled([answerPending]);
    throw error;
  }).finally(() => clearTimeout(watchdog));
}

function postGatewayBeforeHeadersDeadline(port, body, timeoutMs, onRequest) {
  return new Promise((resolve, reject) => {
    let responseBody = '';
    const request = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { authorization: `Bearer ${TEST_GATEWAY_TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, (response) => {
      response.on('data', (chunk) => { responseBody += chunk; });
      response.once('end', () => { clearTimeout(timer); resolve({ statusCode: response.statusCode, body: responseBody, terminal: 'ended' }); });
      response.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    onRequest?.(request);
    const timer = setTimeout(() => { request.destroy(); reject(new Error('no response headers before client ceiling')); }, timeoutMs);
    request.once('error', (error) => { clearTimeout(timer); reject(error); });
    request.end(body);
  });
}

function postGateway(port, body, timeoutMs = 2_000, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'authorization': `Bearer ${TEST_GATEWAY_TOKEN}`,
        ...headers
      }
    }, (response) => {
      let responseBody = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve({ statusCode: response.statusCode, body: responseBody, ...result });
      };
      const deadline = setTimeout(() => {
        response.destroy();
        finish({ terminal: 'timed-out' });
      }, timeoutMs);

      response.on('data', (chunk) => { responseBody += chunk; });
      response.once('end', () => finish({ terminal: 'ended' }));
      response.once('aborted', () => finish({ terminal: 'aborted' }));
      response.once('error', (error) => finish({ terminal: 'error', error }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

function requestGateway(port, requestPath, method = 'GET', body = '', headers = {}, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { authorization: `Bearer ${TEST_GATEWAY_TOKEN}`, ...headers };
    if (body) {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['content-length'] = Buffer.byteLength(body);
    }
    const request = http.request({
      host: '127.0.0.1', port, path: requestPath, method, headers: requestHeaders
    }, (response) => {
      const chunks = [];
      const deadline = setTimeout(() => response.destroy(new Error('Gateway request timed out.')), timeoutMs);
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        clearTimeout(deadline);
        resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() });
      });
      response.once('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

function postGatewayWithFirstChunkTiming(port, body, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${TEST_GATEWAY_TOKEN}`,
        'content-length': Buffer.byteLength(body)
      }
    }, (response) => {
      let responseBody = '';
      let firstChunkAt = 0;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve({ statusCode: response.statusCode, body: responseBody, firstChunkAt, ...result });
      };
      const deadline = setTimeout(() => {
        response.destroy();
        finish({ terminal: 'timed-out' });
      }, timeoutMs);

      response.on('data', (chunk) => {
        if (!firstChunkAt) firstChunkAt = Date.now();
        responseBody += chunk;
      });
      response.once('end', () => finish({ terminal: 'ended' }));
      response.once('aborted', () => finish({ terminal: 'aborted' }));
      response.once('error', (error) => finish({ terminal: 'error', error }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

function postGatewayAndAbortAfterFirstChunk(port, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${TEST_GATEWAY_TOKEN}`,
        'content-length': Buffer.byteLength(body)
      }
    }, (response) => {
      // Bounded wait for the first chunk: without it a gateway that holds the
      // stream forever would hang the whole test file (no per-test default
      // timeout in node:test). 10s is the helper's own fail-fast deadline.
      const deadline = setTimeout(() => {
        request.destroy();
        reject(new Error('client abort helper: no first chunk within 10s'));
      }, 10_000);
      response.once('data', () => {
        clearTimeout(deadline);
        request.destroy();
        resolve();
      });
      response.once('error', () => {});
    });
    request.once('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    request.end(body);
  });
}

function createLocalUpstream(handler) {
  return new Promise((resolve, reject) => {
    const upstream = http.createServer(handler);
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', () => resolve(upstream));
  });
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

// Bounded fresh-pair retry for the free-port race.
//
// MEASURED RACE this removes. A probed-then-released port can be taken by another
// test process before the child binds it. The losing child logs
// `[Gateway:E_STARTUP] Startup failed` at once but exits only ~3 s later
// (server.mjs failStartup), so each lost race cost ~3.2 s and three losses failed
// the test. The shared startGatewayOnReservedPort (tests/support/
// paired-port-allocation.mjs) owns the retry: readiness is THIS child's
// ports:bound for the reserved pair, and killOnBindCollision() ends a colliding
// child as soon as the marker reaches stderr, so the next of
// GATEWAY_START_MAX_ATTEMPTS fresh high-range pairs is tried immediately. Callers
// receive a child that is either healthy or an error that is NOT a port collision.

// ONE total startup budget across all retries (override: timeoutOverrides.startupTotalMs),
// so a slow start fails with a labeled error well inside the caller's test timeout
// instead of repeated 20s polls surfacing as an unlabeled "test timed out".
const GATEWAY_STARTUP_TOTAL_MS = 12_000;

function gatewayStartupStalledError(attempt, totalMs, lastExit = undefined) {
  const exitNote = lastExit ? `, last exit: code ${lastExit.code}, signal ${lastExit.sig}` : '';
  return new Error(`stalled at: gateway startup (attempt ${attempt}, >${totalMs}ms${exitNote})`);
}

async function startGatewayWithLocalUpstream(upstreamPort, timeoutOverrides = {}) {
  const totalMs = timeoutOverrides.startupTotalMs ?? GATEWAY_STARTUP_TOTAL_MS;
  const totalDeadline = Date.now() + totalMs;
  const exitOf = (c) => (c.exitCode !== null || c.signalCode !== null ? { code: c.exitCode, sig: c.signalCode } : undefined);
  let current;
  let started;
  try {
    started = await startGatewayOnReservedPort({
      maxAttempts: GATEWAY_START_MAX_ATTEMPTS,
      reservationOptions: highPortReservation(),
      readinessTimeoutMs: Math.max(1, totalDeadline - Date.now()),
      spawnChild(gatewayPort, attempt) {
        // Total budget check per attempt: a non-collision error ends the helper's loop.
        if (Date.now() >= totalDeadline) throw new Error(`gateway start budget exhausted after attempt ${attempt - 1}`);
        // Fresh unique dir per start: a reused port must never append to an earlier test's log.
        const gatewayDir = fs.mkdtempSync(path.join(tempRoot, `gateway-${gatewayPort}-`));
        const statePath = path.join(gatewayDir, 'keys.json');
        const logPath = path.join(gatewayDir, 'gateway.jsonl');
        assert.equal(fs.existsSync(logPath), false, 'fresh log dir');
        fs.writeFileSync(statePath, JSON.stringify({
          keys: (timeoutOverrides.keys ?? ['local-test-key']).map((key, index) => ({
            id: `test-key-${index}`,
            key,
            status: 'active',
            backoffUntil: 0,
            usage: { success: 0, fail: 0, tokens: 0, lastUsed: index }
          }))
        }));

        const child = spawnChild(process.execPath, [
          '--require', localUpstreamPreloadPath,
          path.join(projectRoot, 'src', 'gateway', 'server.mjs')
        ], {
          env: {
            ...process.env,
            PORT: String(gatewayPort),
            GATEWAY_LOG_PATH: logPath,
            GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstreamPort),
            ...(timeoutOverrides.upstreamBodyBarrier ? { GATEWAY_TEST_UPSTREAM_BODY_BARRIER: '1' } : {}),
            GATEWAY_FIRST_BYTE_TIMEOUT_MS: String(timeoutOverrides.firstByteTimeoutMs ?? 100),
            GATEWAY_IDLE_TIMEOUT_MS: String(timeoutOverrides.idleTimeoutMs ?? 100),
            ...(timeoutOverrides.maxStreamTimerTestMs === undefined
              ? {}
              : { GATEWAY_TEST_MAX_STREAM_TIMER_MS: String(timeoutOverrides.maxStreamTimerTestMs), GATEWAY_MAX_STREAM_DURATION_MS: '300000' }),
            // Guarded: only present when a test asks for them, so every existing caller
            // keeps the production defaults (the 240s request deadline never fires in a
            // sub-second scenario, and the attempt budget stays pool-derived).
            ...(timeoutOverrides.requestDeadlineMs === undefined
              ? {}
              : { GATEWAY_REQUEST_DEADLINE_MS: String(timeoutOverrides.requestDeadlineMs) }),
            ...(timeoutOverrides.maxFailoverAttempts === undefined
              ? {}
              : { GATEWAY_MAX_FAILOVER_ATTEMPTS: String(timeoutOverrides.maxFailoverAttempts) })
          },
          // stderr is piped so a bind collision is seen (and the child killed) at once.
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          windowsHide: true
        });
        const detachCollisionWatch = killOnBindCollision(child);
        child.once('message', (message) => {
          if (message?.type === 'ready') child.send({ type: 'state:init', challenge: message.challenge, state: { keys: JSON.parse(fs.readFileSync(statePath, 'utf8')).keys, credentials: { gatewayToken: TEST_GATEWAY_TOKEN, adminToken: 'test-admin-token' } } });
        });
        child.on('message', (message) => { if (message?.type === 'state:persist') fs.writeFileSync(statePath, JSON.stringify(message.state)); });

        let onFirstUpstreamBody;
        const firstUpstreamBody = new Promise((resolve) => { onFirstUpstreamBody = resolve; });
        if (timeoutOverrides.upstreamBodyBarrier) child.on('message', (message) => {
          if (message?.type === 'test:upstream-first-body' && message.authorization === 'Bearer key-a') onFirstUpstreamBody();
        });
        current = { child, detachCollisionWatch, gatewayPort, logPath, statePath, firstUpstreamBody, attempt };
        return child;
      }
    });
  } catch (error) {
    const lastExit = current ? exitOf(current.child) : undefined;
    if (current) await stopGateway(current.child);
    if (Date.now() >= totalDeadline) throw gatewayStartupStalledError(current?.attempt ?? 1, totalMs, lastExit);
    throw error;
  }

  const { child } = started;
  current.detachCollisionWatch(); // started.child is the last spawned child
  const { gatewayPort, logPath, statePath, firstUpstreamBody } = current;
  try {
    // ports:bound is attested; /health confirms the listener answers. Condition-based
    // polling within what is left of the total budget.
    while (Date.now() < totalDeadline && !exitOf(child)) {
      try {
        if (await getHealth(gatewayPort) === 200) return { child, gatewayPort, logPath, statePath, firstUpstreamBody };
      } catch {
        // The child may still be starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const exited = exitOf(child);
    await stopGateway(child);
    if (exited) throw new Error(`Gateway exited during startup (code ${exited.code}, signal ${exited.sig})`);
    throw gatewayStartupStalledError(started.attempt, totalMs);
  } catch (error) {
    await stopGateway(child);
    throw error;
  }
}

// Stops the gateway the way production does: ASK over ipc first, then escalate.
//
// MEASURED RACE this removes. logger.mjs buffers entries and flushes on
// setTimeout(flushLogs, 1000); an entry was observed reaching the file at 981ms,
// i.e. 119ms inside waitForGatewayLogFlush()'s 1100ms. A plain child.kill() sends
// SIGTERM, which on Windows is TerminateProcess — the child's handlers never run,
// so the flush-on-exit path cannot rescue a still-buffered entry (measured:
// present-after-SIGTERM = false, present-after-ipc-shutdown = true). On a loaded
// runner the 119ms margin disappears and a log assertion fails for timing reasons
// alone, which is what happened in CI.
//
// The ipc request makes the flush deterministic instead of widening the sleep, and
// the unchanged SIGTERM -> SIGKILL escalation still guarantees the child dies.
async function stopGateway(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  const waitForExit = (timeoutMs) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
    const timer = setTimeout(() => resolve(child.exitCode !== null || child.signalCode !== null), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });

  // A confirmed send earns the short grace; an unconfirmed one falls straight
  // through to signals rather than waiting on a request that never arrived.
  let requested = false;
  try {
    requested = child.connected === true && typeof child.send === 'function' && child.send({ type: 'shutdown' }) === true;
  } catch {
    requested = false;
  }
  if (requested && await waitForExit(2_000)) return;

  child.kill();
  if (await waitForExit(1_000)) return;
  child.kill('SIGKILL');
  await waitForExit(1_000);
}

function readGatewayLogs(logPath) {
  return fs.readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function countGatewayLogs(logs, message) {
  return logs.filter((entry) => entry.message === message).length;
}

function waitForGatewayLogFlush() {
  return new Promise((resolve) => setTimeout(resolve, 1_100));
}

function waitForKeyStateSave() {
  return new Promise((resolve) => setTimeout(resolve, 5_100));
}

function readKeyUsage(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8')).keys[0].usage;
}

let lifecycleLogSeq = 0;

// Per-instance child stdio log under tempRoot, so a failed start can show its cause.
function lifecycleLogPath(name = `lifecycle-${++lifecycleLogSeq}`) {
  return path.join(tempRoot, 'lifecycle-logs', `${name}.jsonl`);
}

// Last `lines` child stdio lines from a GatewayLifecycle JSONL log ({ timestamp, text } per line).
function tailLifecycleLog(logPath, lines = 20) {
  if (!logPath || !fs.existsSync(logPath)) return '(no stdio log)';
  const text = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line).text; } catch { return line; }
  }).join('');
  const tail = text.split(/\r?\n/).filter(Boolean).slice(-lines);
  return tail.length ? tail.join('\n') : '(stdio log empty)';
}

function describeStartFailure(status, logPath) {
  return `lifecycle start failed: ${JSON.stringify(status)}\n--- child stdio (last 20 lines) ---\n${tailLifecycleLog(logPath)}`;
}

// The incidental release-then-bind race of freeGatewayPort(): another process grabs the
// probed port before the child binds it, and the child exits during startup. Only this
// exact outcome is retried; PORT_IN_USE (preflight) and every other status are not.
// Two conditions, both required:
//  1. the plain code-1 exit (server.mjs failStartup -> process.exit(1)); the signal form
//     "exited during startup (SIGTERM)." from gateway-lifecycle.ts is never retried;
//  2. the child's stderr for THIS attempt (log bytes after `fromOffset`) shows the bind
//     failure "[Gateway:E_STARTUP] Startup failed (EADDRINUSE)". server.mjs writes it ~3 s
//     before exiting and the lifecycle appends stderr synchronously, so it is present when
//     the status is returned. Any other code-1 crash (e.g. a self-SIGTERM on Windows, which
//     exits with code 1) fails on the first attempt.
function logSize(logPath) {
  try { return fs.statSync(logPath).size; } catch { return 0; }
}

function readLifecycleLogSince(logPath, fromOffset = 0) {
  if (!logPath || !fs.existsSync(logPath)) return '';
  return fs.readFileSync(logPath).subarray(fromOffset).toString('utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line).text; } catch { return line; }
  }).join('');
}

function isIncidentalStartupExit(status, logPath, fromOffset = 0) {
  return status?.state === 'error'
    && status.code === 'START_FAILED'
    && /exited during startup with code 1\.$/.test(status.message ?? '')
    && /\[Gateway:E_STARTUP\] Startup failed \(EADDRINUSE\)/.test(readLifecycleLogSince(logPath, fromOffset));
}

const LIFECYCLE_START_ATTEMPTS = 8;

// Starts `instance` on a fresh freeGatewayPort() and retries with new ports only on the
// incidental startup-exit race. Returns the port that reached `running`.
async function startLifecycleWithRetry(instance, logPath) {
  let status;
  let attempt = 0;
  while (attempt < LIFECYCLE_START_ATTEMPTS) {
    attempt += 1;
    const port = await freeGatewayPort();
    const fromOffset = logSize(logPath);
    status = await instance.start(port);
    if (status.state === 'running') {
      assert.deepEqual(status, { state: 'running', port }, describeStartFailure(status, logPath));
      return port;
    }
    if (!isIncidentalStartupExit(status, logPath, fromOffset)) break;
  }
  assert.fail(`[attempt ${attempt}/${LIFECYCLE_START_ATTEMPTS}] ${describeStartFailure(status, logPath)}`);
}

// Binds a fresh free port for a test-owned listener, re-picking on the same race.
async function listenOnFreeGatewayPort() {
  let lastError;
  for (let attempt = 1; attempt <= LIFECYCLE_START_ATTEMPTS; attempt += 1) {
    const port = await freeGatewayPort();
    try {
      return { port, server: await listen(port) };
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function createLifecycle(stdioLogPath = lifecycleLogPath()) {
  const paths = runtime.ensureGatewayRuntime(tempRoot);
  const serverPath = path.join(projectRoot, 'src', 'gateway', 'server.mjs');
  return new lifecycle.GatewayLifecycle({
    serverPath,
    runtimePaths: paths,
    stdioLogPath,
    spawnChild: (command, args, options) => {
      const child = spawnChild(command, args, options);
      child.on('message', (message) => {
        if (message?.type === 'ready') child.send({ type: 'state:init', challenge: message.challenge, state: { keys: [], credentials: { gatewayToken: 'test-gateway-token', adminToken: 'test-admin-token' } } });
      });
      return child;
    },
    executablePath: process.execPath,
    initialState: lifecycleFixtureState(),
    startupTimeoutMs: 5_000,
    healthPollIntervalMs: 50
  });
}

function lifecycleFixtureState() {
  return { keys: [], credentials: { gatewayToken: 'fixture-gateway-token', adminToken: 'fixture-admin-token' } };
}

test('reports PORT_IN_USE for the gateway port without spawning a child', async () => {
  const port = await freeGatewayPort();
  const occupied = await listen(port);
  let spawnCalls = 0;
  const paths = runtime.ensureGatewayRuntime(tempRoot);
  const instance = new lifecycle.GatewayLifecycle({
    serverPath: path.join(projectRoot, 'src', 'gateway', 'server.mjs'),
    runtimePaths: paths,
    spawnChild: (...args) => {
      spawnCalls += 1;
      return spawnChild(...args);
    },
    executablePath: process.execPath,
    initialState: lifecycleFixtureState()
  });

  try {
    const status = await instance.start(port);
    assert.deepEqual(status, {
      state: 'error',
      code: 'PORT_IN_USE',
      port,
      message: `Gateway port ${port} is already in use.`
    });
    assert.equal(spawnCalls, 0);
  } finally {
    await close(occupied);
  }
});

test('reports PORT_IN_USE for the admin port without spawning a child', async () => {
  const port = await freeGatewayPort();
  const occupied = await listen(port + 1);
  const instance = createLifecycle();

  try {
    const status = await instance.start(port);
    assert.deepEqual(status, {
      state: 'error',
      code: 'PORT_IN_USE',
      port: port + 1,
      message: `Admin port ${port + 1} is already in use.`
    });
  } finally {
    await close(occupied);
  }
});

test('reports START_FAILED when the child cannot be spawned', async () => {
  const port = await freeGatewayPort();
  const paths = runtime.ensureGatewayRuntime(tempRoot);
  const instance = new lifecycle.GatewayLifecycle({
    serverPath: path.join(projectRoot, 'src', 'gateway', 'server.mjs'),
    runtimePaths: paths,
    spawnChild: () => { throw new Error('intentional spawn failure'); },
    executablePath: process.execPath,
    initialState: lifecycleFixtureState()
  });

  const status = await instance.start(port);
  assert.deepEqual(status, {
    state: 'error',
    code: 'START_FAILED',
    port,
    message: 'Gateway child process error: intentional spawn failure'
  });
});

test('starts a child on free paired ports and verifies its health endpoint', async () => {
  const logPath = lifecycleLogPath('free-paired');
  const instance = createLifecycle(logPath);

  try {
    const port = await startLifecycleWithRetry(instance, logPath);
    assert.equal(await getHealth(port), 200);
  } finally {
    const stopped = await instance.stop();
    assert.deepEqual(stopped, { state: 'stopped' });
  }
});

test('does not stop a healthy gateway when a requested replacement port conflicts', async () => {
  const logPath = lifecycleLogPath('replacement-conflict');
  const instance = createLifecycle(logPath);
  let occupied;

  try {
    // Setup only: retry picks fresh ports on the incidental bind race. The asserted
    // PORT_IN_USE below is produced by the test's own listener and is never retried.
    const currentPort = await startLifecycleWithRetry(instance, logPath);
    let requestedPort;
    ({ port: requestedPort, server: occupied } = await listenOnFreeGatewayPort());

    assert.deepEqual(await instance.retry(requestedPort), {
      state: 'error',
      code: 'PORT_IN_USE',
      port: requestedPort,
      message: `Gateway port ${requestedPort} is already in use.`
    });
    assert.equal(await getHealth(currentPort), 200);
  } finally {
    await instance.stop();
    if (occupied) await close(occupied);
  }
});

test('removes the ownership record and never reports running when the child exits around owner recording', async () => {
  const port = await freeGatewayPort();
  const paths = runtime.ensureGatewayRuntime(path.join(tempRoot, `owner-race-${port}`));
  const instance = new lifecycle.GatewayLifecycle({
    serverPath: path.join(projectRoot, 'src', 'gateway', 'server.mjs'),
    runtimePaths: paths,
    spawnChild: (command, args, options) => spawnChild(command, args, options),
    executablePath: process.execPath,
    initialState: lifecycleFixtureState(),
    startupTimeoutMs: 5_000,
    healthPollIntervalMs: 10,
    afterOwnerRecordWrite: (child) => child.kill()
  });
  const status = await instance.start(port);
  assert.equal(status.state, 'error');
  assert.equal(fs.existsSync(paths.ownerPath), false);
  assert.equal(instance.getStatus().state, 'error');
});

test('concurrent lifecycle retries serialize and leave the latest accepted child and config port authoritative', async () => {
  // The whole scenario is re-run on fresh ports ONLY when some start hit the incidental
  // freeGatewayPort() bind race (see isIncidentalStartupExit: code 1 + EADDRINUSE). Within an attempt
  // every serialization assertion runs unchanged; any other deviation fails immediately.
  let lastIncidental;
  for (let attempt = 1; attempt <= LIFECYCLE_START_ATTEMPTS; attempt += 1) {
    const firstPort = await freeGatewayPort();
    const secondPort = await freeGatewayPort();
    const thirdPort = await freeGatewayPort();
    const paths = runtime.ensureGatewayRuntime(path.join(tempRoot, `serialized-${firstPort}-${attempt}`));
    const logPath = lifecycleLogPath(`serialized-${firstPort}-${attempt}`);
    const instance = new lifecycle.GatewayLifecycle({
      serverPath: path.join(projectRoot, 'src', 'gateway', 'server.mjs'), runtimePaths: paths, stdioLogPath: logPath,
      spawnChild: (command, args, options) => spawnChild(command, args, options), executablePath: process.execPath, initialState: lifecycleFixtureState(),
      startupTimeoutMs: 5_000, healthPollIntervalMs: 10
    });
    try {
      const first = await instance.start(firstPort);
      if (isIncidentalStartupExit(first, logPath, 0)) { lastIncidental = describeStartFailure(first, logPath); continue; }
      assert.equal(first.state, 'running', `[attempt ${attempt}/${LIFECYCLE_START_ATTEMPTS}] ${describeStartFailure(first, logPath)}`);
      // Retries are serialized by the lifecycle, so the offset captured the moment `earlier`
      // settles (a microtask, before any I/O from the latest child) scopes the EADDRINUSE
      // check to the latest child's own output.
      let latestOffset = logSize(logPath);
      const earlier = instance.retry(secondPort).then((status) => { latestOffset = logSize(logPath); return status; });
      const latest = instance.retry(thirdPort);
      const [earlierStatus, latestStatus] = await Promise.all([earlier, latest]);
      // `earlier` is only asserted by port (as before), so it never triggers a re-run.
      if (isIncidentalStartupExit(latestStatus, logPath, latestOffset)) { lastIncidental = describeStartFailure(latestStatus, logPath); continue; }
      assert.equal(earlierStatus.port, secondPort, describeStartFailure(earlierStatus, logPath));
      assert.deepEqual(latestStatus, { state: 'running', port: thirdPort }, `[attempt ${attempt}/${LIFECYCLE_START_ATTEMPTS}] ${describeStartFailure(latestStatus, logPath)}`);
      runtime.writeGatewayPort(paths.configPath, thirdPort);
      assert.deepEqual(instance.getStatus(), { state: 'running', port: thirdPort });
      assert.equal(runtime.readGatewayPort(paths.configPath), thirdPort);
      assert.equal(await getHealth(thirdPort), 200);
      await assert.rejects(getHealth(secondPort));
      return;
    } finally { await instance.stop(); }
  }
  assert.fail(`incidental startup race persisted for ${LIFECYCLE_START_ATTEMPTS} attempts\n${lastIncidental}`);
});

// ── Orphan port cleanup tests ─────────────────────────────────────

test('reclaimOrphanedPort returns false when a live health endpoint is detected', async () => {
  // Start a real gateway instance that responds to /health
  const upstream = await createLocalUpstream((_request, response) => response.end('{}'));
  try {
    const { child, gatewayPort } = await startGatewayWithLocalUpstream(
      upstream.address().port,
      { firstByteTimeoutMs: 100, idleTimeoutMs: 100 }
    );

    try {
      // The port has a live gateway — reclaimOrphanedPort should not kill it.
      const instance = createLifecycle();
      const reclaimed = await instance.reclaimOrphanedPort(gatewayPort);
      assert.equal(reclaimed, false, 'Should not reclaim a port with a live health endpoint');
    } finally {
      await stopGateway(child);
    }
  } finally {
    await closeServer(upstream);
  }
});

// ── Model limits tests ────────────────────────────────────────────

test('getModelLimits resolves exact model match from config', () => {
  // Set GATEWAY_CONFIG_PATH to the project's config.example.json so
  // the test reads real model limits.
  const configPath = path.join(projectRoot, 'config', 'config.example.json');
  process.env.GATEWAY_CONFIG_PATH = configPath;
  resetModelLimitsCache();

  try {
    const limits = getModelLimits('z-ai/glm-5.2');
    assert.equal(limits.context, 202_752);
    assert.equal(limits.output, 131_072);
  } finally {
    delete process.env.GATEWAY_CONFIG_PATH;
    resetModelLimitsCache();
  }
});

test('getModelLimits returns correct limits for deepseek-ai/deepseek-v4-pro', () => {
  const configPath = path.join(projectRoot, 'config', 'config.example.json');
  process.env.GATEWAY_CONFIG_PATH = configPath;
  resetModelLimitsCache();

  try {
    const limits = getModelLimits('deepseek-ai/deepseek-v4-pro');
    assert.equal(limits.context, 1_048_576);
    assert.equal(limits.output, 393_216);
  } finally {
    delete process.env.GATEWAY_CONFIG_PATH;
    resetModelLimitsCache();
  }
});

test('getModelLimits returns explicit limits for qwen/qwen3.5-397b-a17b', () => {
  const configPath = path.join(projectRoot, 'config', 'config.example.json');
  process.env.GATEWAY_CONFIG_PATH = configPath;
  resetModelLimitsCache();

  try {
    const limits = getModelLimits('qwen/qwen3.5-397b-a17b');
    assert.equal(limits.context, 262_144);
    assert.equal(limits.output, 8_192);
  } finally {
    delete process.env.GATEWAY_CONFIG_PATH;
    resetModelLimitsCache();
  }
});

test('getModelLimits falls back to wildcard for unknown model', () => {
  const configPath = path.join(projectRoot, 'config', 'config.example.json');
  process.env.GATEWAY_CONFIG_PATH = configPath;
  resetModelLimitsCache();

  try {
    const limits = getModelLimits('some/nonexistent-model');
    assert.equal(limits.context, 131_072);
    assert.equal(limits.output, 4_096);
  } finally {
    delete process.env.GATEWAY_CONFIG_PATH;
    resetModelLimitsCache();
  }
});

test('getModelLimits uses hard fallback when no config exists', () => {
  // Unset env so resolveConfigPath returns null
  delete process.env.GATEWAY_CONFIG_PATH;
  // Also unset GATEWAY_STATE_PATH so we don't pick up a runtime config
  const savedStatePath = process.env.GATEWAY_STATE_PATH;
  delete process.env.GATEWAY_STATE_PATH;
  resetModelLimitsCache();

  try {
    const limits = getModelLimits('anything');
    assert.equal(limits.context, 131_072);
    assert.equal(limits.output, 4_096);
  } finally {
    if (savedStatePath) process.env.GATEWAY_STATE_PATH = savedStatePath;
    resetModelLimitsCache();
  }
});

test('/v1/models/cached requires LOCAL_TOKEN: 401 without it, 200 with it, /health stays public', async () => {
  const upstream = await createLocalUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"data":[]}');
  });
  let child;
  let gatewayPort;
  try {
    ({ child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port));
    // BEFORE the fix the /v1 branch sat at server.mjs:1437-1448 ABOVE the
    // /v1 auth gate at :1478-1482, so this returned 200. It must sit BEHIND
    // the same gate as /v1/models: no token -> 401 (with Bearer challenge).
    const denied = await new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port: gatewayPort, path: '/v1/models/cached' }, (response) => {
        response.resume();
        response.once('end', () => resolve({ statusCode: response.statusCode, headers: response.headers }));
      });
      request.once('error', reject);
    });
    assert.equal(denied.statusCode, 401, 'GET /v1/models/cached without Authorization must be 401');
    assert.equal(denied.headers['www-authenticate'], 'Bearer');
    // A healthy token still works, exactly like /v1/models.
    const allowed = await requestGateway(gatewayPort, '/v1/models/cached');
    assert.equal(allowed.statusCode, 200);
    assert.equal(JSON.parse(allowed.body).cached, true);
    // /health is the ONE documented public route: still 200 with no token.
    const health = await new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port: gatewayPort, path: '/health' }, (response) => {
        response.resume();
        response.once('end', () => resolve({ statusCode: response.statusCode }));
      });
      request.once('error', reject);
    });
    assert.equal(health.statusCode, 200, '/health must stay public');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

// Э1a ENV e2e (plan AC "ENV 800 у parent->child"). The unit test above proves only
// that createGatewaySpawnOptions() COPIES the knob; this spawns the real child from
// that exact env and proves the child APPLIES it. Test-only plumbing added on top of
// options.env (same as startGatewayWithLocalUpstreamOnce): the local-upstream preload
// (--require) + GATEWAY_TEST_LOCAL_UPSTREAM_PORT so https to NVIDIA is redirected to a
// 127.0.0.1 fake, and an ipc stdio channel for the ready/state:init key handshake.
test('Э1a ENV e2e: GATEWAY_REQUEST_DEADLINE_MS=800 passed via parent spawn options is applied by the child', { timeout: 60_000 }, async () => {
  const pending = [];
  const upstream = http.createServer((request, response) => { request.resume(); pending.push(response); });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const originalEnv = process.env;
  let child;
  try {
    const testEnv = {
      ...Object.fromEntries(['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE'].filter((n) => originalEnv[n] !== undefined).map((n) => [n, originalEnv[n]])),
      GATEWAY_REQUEST_DEADLINE_MS: '800',
      GATEWAY_FIRST_BYTE_TIMEOUT_MS: '5000',
      GATEWAY_IDLE_TIMEOUT_MS: '5000',
      FAKE_PARENT_SECRET_E2E: 'fake-secret-not-a-real-key'
    };
    process.env = { ...testEnv };
    const paths = runtime.ensureGatewayRuntime(path.join(tempRoot, 'env-e2e-userdata'));
    const serverPath = path.join(projectRoot, 'src', 'gateway', 'server.mjs');
    let options;
    let gatewayPort;
    let detachCollisionWatch;
    // Shared reserved-port start (maxAttempts 8): readiness is THIS child's ports:bound
    // for the reserved pair; killOnBindCollision() ends a colliding child at once.
    const startBy = Date.now() + GATEWAY_STARTUP_TOTAL_MS;
    const started = await startGatewayOnReservedPort({
      maxAttempts: GATEWAY_START_MAX_ATTEMPTS,
      reservationOptions: highPortReservation(),
      readinessTimeoutMs: 20_000,
      spawnChild(port, attempt) {
        // Total budget check per attempt: a non-collision error ends the helper's loop.
        if (Date.now() >= startBy) throw new Error(`gateway start budget exhausted after attempt ${attempt - 1}`);
        process.env = { ...testEnv }; // re-apply per attempt: createGatewaySpawnOptions reads process.env
        try { options = runtime.createGatewaySpawnOptions(serverPath, paths, port); } finally { process.env = originalEnv; }
        assert.equal(options.env.GATEWAY_REQUEST_DEADLINE_MS, '800');
        assert.equal(options.env.GATEWAY_FIRST_BYTE_TIMEOUT_MS, '5000');
        assert.equal('FAKE_PARENT_SECRET_E2E' in options.env, false, 'fake parent secret must not reach the child env');
        assert.equal(Object.values(options.env).includes('fake-secret-not-a-real-key'), false);
        child = spawnChild(process.execPath, ['--require', localUpstreamPreloadPath, ...options.args], {
          env: { ...options.env, GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstream.address().port) },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          windowsHide: true
        });
        detachCollisionWatch = killOnBindCollision(child);
        child.once('message', (message) => {
          if (message?.type === 'ready') child.send({ type: 'state:init', challenge: message.challenge, state: { keys: [{ id: 'env-e2e-key', key: 'fake-env-e2e-key', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 } }], credentials: { gatewayToken: TEST_GATEWAY_TOKEN, adminToken: 'test-admin-token' } } });
        });
        return child;
      }
    });
    child = started.child;
    detachCollisionWatch();
    const healthDeadline = Date.now() + 20_000;
    while (Date.now() < healthDeadline && child.exitCode === null && child.signalCode === null) {
      try { if (await getHealth(started.port) === 200) { gatewayPort = started.port; break; } } catch { /* still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    process.env = originalEnv;
    assert.ok(gatewayPort !== undefined, 'child spawned from createGatewaySpawnOptions must become healthy');

    const startedAt = Date.now();
    const answer = await postGateway(gatewayPort, '{"model":"fake/model","stream":false,"messages":[{"role":"user","content":"hi"}]}', 3_000);
    const elapsed = Date.now() - startedAt;
    assert.equal(answer.statusCode, 504);
    assert.equal(answer.body, '{"error":"Gateway request deadline exceeded"}');
    assert.ok(elapsed >= 700, `deadline fired too early: ${elapsed}ms`);
    assert.ok(elapsed < 800 + 600, `deadline 800ms not applied by child: ${elapsed}ms`);
    assert.ok(pending.length >= 1, 'the request must have reached the fake upstream');
    await waitForGatewayLogFlush();
    const outcomes = readGatewayLogs(paths.logPath).filter((entry) => entry.message === 'request_outcome').map((entry) => entry.outcome);
    assert.deepEqual(outcomes, ['request_deadline']);
  } finally {
    process.env = originalEnv;
    await stopGateway(child);
    await closeServer(upstream);
  }
});
test('DeepSeek V4.1 Flash is in the model catalog and limits (context/output maximum 1,048,576)', async () => {
  const { getFallbackModels } = await import('../src/gateway/model-discovery.mjs');
  assert.ok(getFallbackModels().some((m) => m.id === 'deepseek-ai/deepseek-v4.1-flash' && m.owned_by === 'deepseek-ai'));

  const configPath = path.join(projectRoot, 'config', 'config.example.json');
  process.env.GATEWAY_CONFIG_PATH = configPath;
  resetModelLimitsCache();
  try {
    const limits = getModelLimits('deepseek-ai/deepseek-v4.1-flash');
    assert.equal(limits.context, 1_048_576);
    assert.equal(limits.output, 1_048_576);
  } finally {
    delete process.env.GATEWAY_CONFIG_PATH;
    resetModelLimitsCache();
  }
  assert.match(fs.readFileSync(path.join(projectRoot, 'src', 'main', 'models-ipc.ts'), 'utf8'), /"deepseek-ai\/deepseek-v4\.1-flash"/);
});
