// Integration tests for the POST /v1/messages (Anthropic facade) gateway route.
// Pattern mirrors tests/gateway-runtime.test.mjs: spawn the real server.mjs
// against a programmable local fake upstream (redirected via tests/local-upstream-preload.cjs).

import assert from 'node:assert/strict';
import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-gateway-anthropic-route-${process.pid}-`));
const localUpstreamPreloadPath = path.join(projectRoot, 'tests', 'local-upstream-preload.cjs');
const TEST_GATEWAY_TOKEN = 'test-gateway-token-not-a-redaction-sentinel';

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ── Harness helpers (cloned & trimmed from gateway-runtime.test.mjs) ─────────

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((conn) => conn.resume());
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

async function startGatewayWithLocalUpstream(upstreamPort, overrides = {}) {
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
        GATEWAY_FIRST_BYTE_TIMEOUT_MS: String(overrides.firstByteTimeoutMs ?? 100),
        GATEWAY_IDLE_TIMEOUT_MS: String(overrides.idleTimeoutMs ?? 100),
        GATEWAY_MAX_STREAM_DURATION_MS: String(overrides.maxStreamDurationMs ?? 30_000)
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true
    });
    child.once('message', (message) => {
      if (message?.type === 'ready') {
        child.send({
          type: 'state:init',
          challenge: message.challenge,
          state: { keys: JSON.parse(fs.readFileSync(statePath, 'utf8')).keys, credentials: { gatewayToken: TEST_GATEWAY_TOKEN, adminToken: 'test-admin-token' } }
        });
      }
    });
    child.on('message', (message) => {
      if (message?.type === 'state:persist') fs.writeFileSync(statePath, JSON.stringify(message.state));
    });

    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        try {
          if (await getHealth(gatewayPort) === 200) return { child, gatewayPort, logPath, statePath };
        } catch {
          // still starting
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await stopGateway(child);
    } catch (err) {
      await stopGateway(child);
      throw err;
    }
  }
  throw new Error('Gateway did not become healthy after three free-port selections.');
}

async function stopGateway(child) {
  if (!child) return;
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    child.once('exit', () => { clearTimeout(killTimer); resolve(); });
    child.kill();
  });
}

// Generic request helper: POSTs/GETs against the gateway and resolves with
// { statusCode, headers, body, terminal }. Collects all response bytes until
// end/aborted/error/timeout — works for both buffered JSON and SSE streams.
function rawRequest({ port, pathname, method = 'POST', body = '', headers = {}, timeoutMs = 5_000 }) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (body && !('content-length' in requestHeaders)) {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['content-length'] = Buffer.byteLength(body);
    }
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: requestHeaders }, (response) => {
      const chunks = [];
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), ...result });
      };
      const deadline = setTimeout(() => {
        response.destroy();
        finish({ terminal: 'timed-out' });
      }, timeoutMs);
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => finish({ terminal: 'ended' }));
      response.once('aborted', () => finish({ terminal: 'aborted' }));
      response.once('error', (error) => finish({ terminal: 'error', error }));
    });
    request.once('error', reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Request timed out.')));
    request.end(body);
  });
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${TEST_GATEWAY_TOKEN}`, ...extra };
}

function parseSseEvents(text) {
  const events = [];
  for (const frame of text.split('\n\n')) {
    if (!frame.trim()) continue;
    let eventType = '';
    let data = null;
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) eventType = line.slice(7).trim();
      if (line.startsWith('data: ')) {
        try { data = JSON.parse(line.slice(6)); } catch { data = line.slice(6); }
      }
    }
    events.push({ eventType, data });
  }
  return events;
}

// ── Fake upstream canned responses ─────────────────────────────────────────

function openaiCompletionJson({ model = 'z-ai/glm-5.2', content = 'Hello!', usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } = {}) {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage
  });
}

function openaiSseStream({ model = 'z-ai/glm-5.2', segments = ['Hello', '!'] } = {}) {
  let out = '';
  out += `data: ${JSON.stringify({ id: 'chatcmpl-s', model, choices: [{ index: 0, delta: { role: 'assistant', content: segments[0] }, finish_reason: null }] })}\n\n`;
  for (const seg of segments.slice(1)) {
    out += `data: ${JSON.stringify({ id: 'chatcmpl-s', model, choices: [{ index: 0, delta: { content: seg }, finish_reason: null }] })}\n\n`;
  }
  out += `data: ${JSON.stringify({ id: 'chatcmpl-s', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;
  out += 'data: [DONE]\n\n';
  return out;
}

// ── Tests 37–42 ─────────────────────────────────────────────────────────────

test('37. POST /v1/messages simple text → 200 Anthropic response (non-streaming)', async () => {
  const upstream = await createLocalUpstream((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(openaiCompletionJson());
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port);
  try {
    const body = JSON.stringify({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'Say hello' }],
      max_tokens: 100
    });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders() });
    assert.equal(result.statusCode, 200, `body=${result.body}`);
    assert.match(result.headers['content-type'] || '', /^application\/json/);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.type, 'message');
    assert.equal(parsed.role, 'assistant');
    assert.equal(Array.isArray(parsed.content), true);
    assert.equal(parsed.content[0].type, 'text');
    assert.equal(parsed.content[0].text, 'Hello!');
    assert.equal(parsed.stop_reason, 'end_turn');
    assert.equal(parsed.usage.input_tokens, 5);
    assert.equal(parsed.usage.output_tokens, 2);
    assert.equal(result.terminal, 'ended');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('38. POST /v1/messages stream:true → 200 SSE stream with Anthropic named events', async () => {
  const sse = openaiSseStream({ segments: ['Hello', '!'] });
  const upstream = await createLocalUpstream((_req, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sse);
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port);
  try {
    const body = JSON.stringify({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'Say hi' }],
      max_tokens: 100,
      stream: true
    });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
    assert.equal(result.statusCode, 200, `body=${result.body}`);
    assert.match(result.headers['content-type'] || '', /^text\/event-stream/);
    assert.equal(result.terminal, 'ended');
    const events = parseSseEvents(result.body);
    const types = events.map(e => e.eventType);
    assert.equal(types[0], 'message_start', 'first event must be message_start');
    assert.ok(types.includes('content_block_start'), 'must include content_block_start');
    const blockStart = events.find(e => e.eventType === 'content_block_start');
    assert.equal(blockStart.data.content_block.type, 'text', 'open content block must be a text block');
    const textDeltas = events.filter(e => e.eventType === 'content_block_delta' && e.data?.delta?.type === 'text_delta');
    assert.equal(textDeltas.length, 2, 'must emit two text deltas');
    assert.equal(textDeltas[0].data.delta.text, 'Hello');
    assert.equal(textDeltas[1].data.delta.text, '!');
    assert.ok(types.includes('content_block_stop'), 'must include content_block_stop');
    assert.ok(types.includes('message_delta'), 'must include message_delta');
    assert.equal(types[types.length - 1], 'message_stop', 'last event must be message_stop');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('39. POST /v1/messages invalid JSON body → 400 Anthropic error format', async () => {
  // No upstream needed: the error is short-circuited in the route handler.
  const upstream = await createLocalUpstream((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(openaiCompletionJson());
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port);
  try {
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body: '{ not valid json', headers: authHeaders() });
    assert.equal(result.statusCode, 400);
    assert.match(result.headers['content-type'] || '', /^application\/json/);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.type, 'error');
    assert.equal(parsed.error.type, 'invalid_request_error');
    assert.ok(typeof parsed.error.message === 'string' && parsed.error.message.length > 0);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('40. POST /v1/messages missing model → 400 Anthropic error', async () => {
  const upstream = await createLocalUpstream((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(openaiCompletionJson());
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port);
  try {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 100
    });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders() });
    assert.equal(result.statusCode, 400);
    assert.match(result.headers['content-type'] || '', /^application\/json/);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.type, 'error');
    assert.equal(parsed.error.type, 'invalid_request_error');
    assert.match(parsed.error.message, /model is required/);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('41. POST /v1/messages thinking enabled → upstream receives translated reasoning_effort field', async () => {
  let capturedUrl = null;
  let capturedBody = null;
  const upstream = await createLocalUpstream((req, response) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      capturedUrl = req.url;
      try { capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { capturedBody = null; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(openaiCompletionJson());
    });
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port);
  try {
    const body = JSON.stringify({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'Think hard' }],
      max_tokens: 200,
      thinking: { type: 'enabled', budget_tokens: 20000 }
    });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders() });
    assert.equal(result.statusCode, 200, `body=${result.body}`);
    assert.equal(capturedUrl, '/v1/chat/completions', 'gateway must forward to the OpenAI chat-completions upstream path');
    assert.ok(capturedBody, 'upstream must receive a parsed request body');
    assert.equal(capturedBody.reasoning_effort, 'high', 'budget 20000 must translate to reasoning_effort=high');
    assert.equal(capturedBody.chat_template_kwargs?.enable_thinking, true, 'enable_thinking must be set for the z-ai/glm family');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('42. POST /v1/messages without auth → 401', async () => {
  const upstream = await createLocalUpstream((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(openaiCompletionJson());
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port);
  try {
    // Intentionally send NO authorization header (just content-type via rawRequest).
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body: JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10 }), headers: {} });
    assert.equal(result.statusCode, 401);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

// An unknown model family must not be vetoed locally: NVIDIA serves models we
// have no static entry for, so UPSTREAM is the authority on whether a model can
// think. Measured before the fix: 400 with no upstream request attempted, while
// /v1/chat/completions forwarded the same model and answered 200.
test('44. POST /v1/messages thinking enabled on an UNKNOWN family reaches upstream (no local veto)', async () => {
  let capturedBody = null;
  let upstreamHits = 0;
  const upstream = await createLocalUpstream((req, response) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (String(req.url).includes('chat/completions')) {
        upstreamHits += 1;
        try { capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { capturedBody = null; }
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(openaiCompletionJson({ model: 'nousresearch/hermes-4-405b' }));
    });
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port);
  try {
    const body = JSON.stringify({
      model: 'nousresearch/hermes-4-405b',
      messages: [{ role: 'user', content: 'Think hard' }],
      max_tokens: 200,
      thinking: { type: 'enabled', budget_tokens: 20000 }
    });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders() });
    assert.equal(result.statusCode, 200, `body=${result.body}`);
    assert.equal(upstreamHits, 1, 'the gateway must actually ask upstream instead of rejecting locally');
    assert.equal(capturedBody?.reasoning_effort, 'high', 'the reasoning request must be translated for upstream');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('45. POST /v1/messages surfaces the UPSTREAM reasoning rejection in Anthropic error shape', async () => {
  const upstream = await createLocalUpstream((_req, response) => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'reasoning_effort is not supported for this model' } }));
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port);
  try {
    const body = JSON.stringify({
      model: 'nousresearch/hermes-4-405b',
      messages: [{ role: 'user', content: 'Think hard' }],
      max_tokens: 200,
      thinking: { type: 'enabled', budget_tokens: 20000 }
    });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders() });
    assert.equal(result.statusCode, 400);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.type, 'error');
    assert.equal(parsed.error.type, 'invalid_request_error');
    // The upstream's own words must reach the client, not a gateway-invented mask.
    assert.match(parsed.error.message, /reasoning_effort is not supported for this model/);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('43. POST /v1/messages exhausted failover with a pool-wide 500 propagates the upstream 500', async () => {
  const upstream = await createLocalUpstream((_req, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'internal error' } }));
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port);
  try {
    const body = JSON.stringify({
      model: 'z-ai/glm-5.2',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 10
    });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders() });
    assert.equal(result.statusCode, 500);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.type, 'error');
    assert.equal(parsed.error.type, 'overloaded_error');
    assert.match(parsed.error.message, /every available key/);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});
