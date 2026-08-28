import assert from 'node:assert/strict';
import { spawn as spawnChild } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOP_BY_HOP_HEADERS, sanitizeProxyHeaders } from '../src/gateway/proxy-headers.mjs';
import { createUpstreamSocketTimeouts, resolveGatewayTimeouts, resolveRetryFirstByteTimeoutMs } from '../src/gateway/upstream-timeouts.mjs';
import { getModelLimits, resetModelLimitsCache } from '../src/gateway/model-limits.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = await import(pathToFileURL(path.join(projectRoot, 'build', 'src', 'main', 'gateway-runtime.js')).href);
const lifecycle = await import(pathToFileURL(path.join(projectRoot, 'build', 'src', 'main', 'gateway-lifecycle.js')).href);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nvidia-gateway-runtime-test-${process.pid}-`));
const localUpstreamPreloadPath = path.join(projectRoot, 'tests', 'local-upstream-preload.cjs');
const TEST_GATEWAY_TOKEN = 'test-gateway-token-not-a-redaction-sentinel';

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('sanitizeProxyHeaders removes every forbidden proxy header and preserves allowed headers', () => {
  const forbiddenHeaders = [
    'connection',
    'keep-alive',
    'proxy-connection',
    'transfer-encoding',
    'expect',
    'upgrade',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer'
  ];
  const allowedHeaders = {
    accept: 'application/json',
    'HTTP-Referer': 'https://opencode.ai/',
    'X-Title': 'opencode',
    'X-BILLING-INVOKE-ORIGIN': 'OpenCode'
  };
  const headers = {
    ...Object.fromEntries(forbiddenHeaders.map((header, index) => [header, `forbidden-${index}`])),
    ...allowedHeaders
  };

  assert.deepEqual(HOP_BY_HOP_HEADERS, forbiddenHeaders);
  sanitizeProxyHeaders(headers);

  for (const header of forbiddenHeaders) {
    assert.equal(header in headers, false, `${header} must not be forwarded`);
  }
  assert.deepEqual(headers, allowedHeaders);
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
        'x-allowed-test-header': 'preserved'
      });
      assert.equal(result.statusCode, 200);
      assert.equal(seenHeaders['x-allowed-test-header'], 'preserved');
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

test('uses safe upstream socket timeout defaults when environment values are missing', () => {
  assert.deepEqual(resolveGatewayTimeouts({}), {
    firstByteTimeoutMs: 300_000,
    idleTimeoutMs: 300_000,
    maxStreamDurationMs: 1_800_000
  });
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

    assert.deepEqual(result, {
      statusCode: 502,
      body: '{"error":"All failover attempts exhausted"}',
      terminal: 'ended'
    });
    await waitForGatewayLogFlush();
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }

  const logs = readGatewayLogs(logPath);
  assert.equal(countGatewayLogs(logs, 'Upstream first-byte timeout'), 3);
  assert.equal(countGatewayLogs(logs, 'Upstream request error'), 0);
  assert.equal(countGatewayLogs(logs, 'Upstream error, backing off'), 3);
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
      body: '{"error":"All failover attempts exhausted"}',
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

    assert.deepEqual(result, {
      statusCode: 404,
      body: upstreamBody,
      terminal: 'ended'
    });
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
      body: JSON.stringify({ error: 'All failover attempts exhausted' }),
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
      body: JSON.stringify({ error: 'All failover attempts exhausted' }),
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
      response.once('data', () => {
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

async function startGatewayWithLocalUpstream(upstreamPort, timeoutOverrides = {}) {
  let gatewayPort;
  let child;
  for (let startAttempt = 0; startAttempt < 3; startAttempt++) {
  gatewayPort = await freeGatewayPort();
  const gatewayDir = path.join(tempRoot, `gateway-${gatewayPort}`);
  const statePath = path.join(gatewayDir, 'keys.json');
  const logPath = path.join(gatewayDir, 'gateway.jsonl');
  fs.mkdirSync(gatewayDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    keys: [{
      id: 'test-key',
      key: 'local-test-key',
      status: 'active',
      backoffUntil: 0,
      usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }
    }]
  }));

  child = spawnChild(process.execPath, [
    '--require', localUpstreamPreloadPath,
    path.join(projectRoot, 'src', 'gateway', 'server.mjs')
  ], {
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      GATEWAY_LOG_PATH: logPath,
      GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstreamPort),
      GATEWAY_FIRST_BYTE_TIMEOUT_MS: String(timeoutOverrides.firstByteTimeoutMs ?? 100),
      GATEWAY_IDLE_TIMEOUT_MS: String(timeoutOverrides.idleTimeoutMs ?? 100)
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true
  });
  child.once('message', (message) => {
    if (message?.type === 'ready') child.send({ type: 'state:init', challenge: message.challenge, state: { keys: JSON.parse(fs.readFileSync(statePath, 'utf8')).keys, credentials: { gatewayToken: TEST_GATEWAY_TOKEN, adminToken: 'test-admin-token' } } });
  });
  child.on('message', (message) => { if (message?.type === 'state:persist') fs.writeFileSync(statePath, JSON.stringify(message.state)); });

  try {
    // Condition-based polling tolerates Windows process-start latency under
    // Node's default cross-file test concurrency without adding a fixed wait.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        if (await getHealth(gatewayPort) === 200) return { child, gatewayPort, logPath, statePath };
      } catch {
        // The child may still be starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await stopGateway(child);
  } catch (error) {
    await stopGateway(child);
    throw error;
  }
  }
  throw new Error('Gateway did not become healthy after three free-port selections.');
}

async function stopGateway(child) {
  if (!child) return;
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill();
  });
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

function createLifecycle() {
  const paths = runtime.ensureGatewayRuntime(tempRoot);
  const serverPath = path.join(projectRoot, 'src', 'gateway', 'server.mjs');
  return new lifecycle.GatewayLifecycle({
    serverPath,
    runtimePaths: paths,
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
  const port = await freeGatewayPort();
  const instance = createLifecycle();

  try {
    const status = await instance.start(port);
    assert.deepEqual(status, { state: 'running', port });
    assert.equal(await getHealth(port), 200);
  } finally {
    const stopped = await instance.stop();
    assert.deepEqual(stopped, { state: 'stopped' });
  }
});

test('does not stop a healthy gateway when a requested replacement port conflicts', async () => {
  const currentPort = await freeGatewayPort();
  const instance = createLifecycle();
  let occupied;

  try {
    assert.deepEqual(await instance.start(currentPort), { state: 'running', port: currentPort });
    const requestedPort = await freeGatewayPort();
    occupied = await listen(requestedPort);

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
  const firstPort = await freeGatewayPort();
  const secondPort = await freeGatewayPort();
  const thirdPort = await freeGatewayPort();
  const paths = runtime.ensureGatewayRuntime(path.join(tempRoot, `serialized-${firstPort}`));
  const instance = new lifecycle.GatewayLifecycle({
    serverPath: path.join(projectRoot, 'src', 'gateway', 'server.mjs'), runtimePaths: paths,
    spawnChild: (command, args, options) => spawnChild(command, args, options), executablePath: process.execPath, initialState: lifecycleFixtureState(),
    startupTimeoutMs: 5_000, healthPollIntervalMs: 10
  });
  try {
    assert.equal((await instance.start(firstPort)).state, 'running');
    const earlier = instance.retry(secondPort);
    const latest = instance.retry(thirdPort);
    assert.equal((await earlier).port, secondPort);
    assert.deepEqual(await latest, { state: 'running', port: thirdPort });
    runtime.writeGatewayPort(paths.configPath, thirdPort);
    assert.deepEqual(instance.getStatus(), { state: 'running', port: thirdPort });
    assert.equal(runtime.readGatewayPort(paths.configPath), thirdPort);
    assert.equal(await getHealth(thirdPort), 200);
    await assert.rejects(getHealth(secondPort));
  } finally { await instance.stop(); }
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
