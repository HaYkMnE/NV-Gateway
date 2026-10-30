// Integration tests for the POST /v1/messages (Anthropic facade) gateway route.
// Pattern mirrors tests/gateway-runtime.test.mjs: spawn the real server.mjs
// against a programmable local fake upstream (redirected via tests/local-upstream-preload.cjs).

import assert from 'node:assert/strict';
import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-gateway-anthropic-route-${process.pid}-`));
const localUpstreamPreloadPath = path.join(projectRoot, 'tests', 'local-upstream-preload.cjs');
// Unique per test process so a foreign gateway on a raced port never shares our token.
// Readiness is already gated on this child's ports:bound via startGatewayOnReservedPort.
const TEST_GATEWAY_TOKEN = `test-gateway-${randomUUID()}`;

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
  // One total startup budget (port reservation + health poll). Optional so existing callers are unchanged.
  const startupBudgetMs = overrides.startupDeadlineMs ?? 12_000;
  const startupDeadline = Date.now() + startupBudgetMs;
  const stalledError = () => new Error(`stalled at: gateway startup (>${startupBudgetMs}ms)`);
  let gatewayPort;
  let child;
  let statePath;
  let logPath;
  {
    // One startup pass; bind retries are owned by startGatewayOnReservedPort (maxAttempts: 8).
    // Support helper reuses readinessTimeoutMs per collision retry; overrun only on repeated bind collisions; checked after return at startupDeadline guard below.
    const started = await startGatewayOnReservedPort({ maxAttempts: 8, readinessTimeoutMs: Math.max(1, startupDeadline - Date.now()), spawnChild(port) {
    gatewayPort = port;
    const gatewayDir = fs.mkdtempSync(path.join(tempRoot, `gateway-${gatewayPort}-`));
    statePath = path.join(gatewayDir, 'keys.json');
    logPath = path.join(gatewayDir, 'gateway.jsonl');
    assert.equal(fs.existsSync(logPath), false, 'fresh log dir');
    const keys = overrides.keys ?? ['local-test-key'];
    fs.writeFileSync(statePath, JSON.stringify({
      keys: keys.map((key, index) => ({
        id: `test-key-${index}`,
        key,
        status: 'active',
        backoffUntil: 0,
        usage: { success: 0, fail: 0, tokens: 0, lastUsed: index }
      }))
    }));
    const affinityCachePath = path.join(gatewayDir, 'model-key-affinity.json');
    if (overrides.affinityModel) {
      fs.writeFileSync(affinityCachePath, JSON.stringify({
        version: 1,
        assignments: { [overrides.affinityModel]: { keyId: 'test-key-0', at: Date.now() } },
        cooldowns: {}
      }));
    }

    const spawned = spawnChild(process.execPath, [
      '--require', localUpstreamPreloadPath,
      path.join(projectRoot, 'src', 'gateway', 'server.mjs')
    ], {
      env: {
        ...process.env,
        PORT: String(gatewayPort),
        GATEWAY_LOG_PATH: logPath,
        GATEWAY_MODEL_AFFINITY_CACHE_PATH: affinityCachePath,
        GATEWAY_CORS_ALLOWLIST: overrides.corsAllowlist,
        GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstreamPort),
        GATEWAY_MAX_FAILOVER_ATTEMPTS: overrides.maxFailoverAttempts === undefined ? undefined : String(overrides.maxFailoverAttempts),
        GATEWAY_FIRST_BYTE_TIMEOUT_MS: String(overrides.firstByteTimeoutMs ?? 100),
        GATEWAY_IDLE_TIMEOUT_MS: String(overrides.idleTimeoutMs ?? 100),
        ...(overrides.requestDeadlineMs === undefined ? {} : { GATEWAY_REQUEST_DEADLINE_MS: String(overrides.requestDeadlineMs) }),
        GATEWAY_MAX_STREAM_DURATION_MS: String(overrides.maxStreamDurationMs ?? 30_000)
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true
    });
    spawned.once('message', (message) => {
      if (message?.type === 'ready') {
        spawned.send({
          type: 'state:init',
          challenge: message.challenge,
          state: { keys: JSON.parse(fs.readFileSync(statePath, 'utf8')).keys, credentials: { gatewayToken: TEST_GATEWAY_TOKEN, adminToken: 'test-admin-token' } }
        });
      }
    });
    spawned.on('message', (message) => {
      if (message?.type === 'state:persist') fs.writeFileSync(statePath, JSON.stringify(message.state));
    });
    return spawned;
    } });
    child = started.child;
    if (Date.now() >= startupDeadline) {
      // Port reservation alone consumed the whole startup budget.
      await stopGateway(child);
      throw stalledError();
    }

    try {
      // Health poll uses min(20s, remaining total startup budget).
      const deadline = Math.min(Date.now() + 20_000, startupDeadline);
      while (Date.now() < deadline) {
        try {
          if (await getHealth(gatewayPort) === 200) return { child, gatewayPort, logPath, statePath };
        } catch {
          // still starting
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await stopGateway(child);
      if (Date.now() >= startupDeadline) throw stalledError();
    } catch (err) {
      await stopGateway(child);
      throw err;
    }
  }
  throw new Error('Gateway did not become healthy on the reserved port (child exited early or the deadline passed).');
}

async function stopGateway(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    // Fallback: never hang teardown if 'exit' is not delivered.
    const fallback = setTimeout(resolve, 2_000);
    child.once('exit', () => { clearTimeout(killTimer); clearTimeout(fallback); resolve(); });
    try { child.kill(); } catch { /* already gone; timers resolve */ }
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

test('P0: Anthropic partial upstream SSE idles before translation and a distinct key recovers', { timeout: 30_000 }, async () => {
  const seen = [];
  const upstream = await createLocalUpstream((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.end('{"data":[]}'); return; }
    seen.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (request.headers.authorization === 'Bearer key-a') response.write('data: {"choices":[{"delta":{"content":"unfinished');
    else response.end(openaiSseStream({ segments: ['Recovered'] }));
  });
  let child;
  try {
    const started = await startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b'], firstByteTimeoutMs: 1_000, idleTimeoutMs: 90, requestDeadlineMs: 420
    });
    child = started.child;
    const body = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10, stream: true });
    const result = await rawRequest({ port: started.gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 2_000 });
    assert.equal(result.statusCode, 200);
    assert.equal(result.terminal, 'ended');
    assert.deepEqual(seen, ['Bearer key-a', 'Bearer key-b']);
    const events = parseSseEvents(result.body);
    assert.ok(events.some((event) => event.data?.delta?.text === 'Recovered'));
    assert.equal(events.at(-1).eventType, 'message_stop');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const logs = fs.readFileSync(started.logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.deepEqual(logs.filter((entry) => entry.message === 'request_outcome').map((entry) => entry.outcome),
      ['idle_timeout', 'completed']);
    assert.equal(logs.filter((entry) => entry.message === 'Upstream error, backing off').length, 0,
      'the cancelled translation of A must not penalize its key after idle failover');
    const persistedA = JSON.parse(fs.readFileSync(started.statePath, 'utf8')).keys.find((key) => key.key === 'key-a');
    assert.equal(persistedA.usage.fail, 0, 'A idle must not persist a failed usage count');
    assert.equal(persistedA.backoffUntil, 0, 'A idle must not persist backoff');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('P0: Anthropic buffered JSON idle before commit recovers on a distinct key', { timeout: 30_000 }, async () => {
  const seen = [];
  const upstream = await createLocalUpstream((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.end('{"data":[]}'); return; }
    seen.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.headers.authorization === 'Bearer key-a') response.write('{"choices":[{"message":{"content":"unfinished');
    else response.end(openaiCompletionJson());
  });
  let child;
  try {
    const started = await startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b'], firstByteTimeoutMs: 1_000, idleTimeoutMs: 90, requestDeadlineMs: 420
    });
    child = started.child;
    const body = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10 });
    const result = await rawRequest({ port: started.gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 2_000 });
    assert.equal(result.statusCode, 200);
    assert.equal(result.terminal, 'ended');
    assert.equal(JSON.parse(result.body).type, 'message');
    assert.deepEqual(seen, ['Bearer key-a', 'Bearer key-b']);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.deepEqual(fs.readFileSync(started.logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      .filter((entry) => entry.message === 'request_outcome').map((entry) => entry.outcome), ['idle_timeout', 'completed']);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('P0: Anthropic precommit partial SSE idle then deadline returns clean facade 504', { timeout: 30_000 }, async () => {
  const seen = [];
  let onB;
  const bStarted = new Promise((resolve) => { onB = resolve; });
  const drips = new Set();
  // Timing contract (this test pins the DEADLINE branch, not the idle branch):
  //   drip 25ms  <<  idle 250ms  <<  deadline 2000ms
  // The old 90ms idle vs 500ms deadline was only a 5.5x margin, so on a loaded
  // box B's 30ms drip could slip past its idle window and complete a full
  // idle round (A idle + B idle) BEFORE the deadline -> the neutral 503, i.e.
  // the other documented branch, and the 504 assertion flaked. A drip that is
  // 10x under the idle window and a deadline 8x over it make D (the deadline)
  // the branch that must fire, on any machine, so 504 coverage stays exact.
  const DRIP_MS = 25;
  const IDLE_MS = 250;
  const DEADLINE_MS = 2_000;
  const upstream = await createLocalUpstream((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.end('{"data":[]}'); return; }
    seen.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"unfinished');
    if (request.headers.authorization === 'Bearer key-b') {
      // A's cancelled queue must never commit translated events while B is
      // pending. Keep B's incomplete frame alive past D; C must not start.
      const drip = setInterval(() => { if (!response.destroyed) response.write('x'); }, DRIP_MS);
      drips.add(drip);
      response.once('close', () => { clearInterval(drip); drips.delete(drip); });
      onB();
    }
  });
  let child;
  try {
    const started = await startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b', 'key-c'],
      firstByteTimeoutMs: 1_000, idleTimeoutMs: IDLE_MS,
      requestDeadlineMs: DEADLINE_MS, maxFailoverAttempts: 3
    });
    child = started.child;
    const body = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10, stream: true });
    const answerPending = rawRequest({ port: started.gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: DEADLINE_MS + 4_000 });
    let watchdog;
    try {
      await Promise.race([bStarted, new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('B not started before client watchdog')), DEADLINE_MS + 2_000);
      })]);
    } finally {
      clearTimeout(watchdog);
    }
    const result = await answerPending;
    assert.equal(result.statusCode, 504);
    assert.equal(result.terminal, 'ended');
    assert.deepEqual(JSON.parse(result.body), { type: 'error', error: { type: 'request_timeout', message: 'Gateway request deadline exceeded' } });
    // Contract: exactly two attempts, A then B, each once (D interrupts the
    // held B before C can start). Asserted WITHOUT ever printing an
    // Authorization value: a deepEqual on the raw `seen` array echoes the
    // captured header into the failure diff, so a real (non-fixture) run would
    // dump key material into the test log. Length first, then an order
    // predicate — both report only booleans.
    assert.equal(seen.length, 2, 'exactly two attempts: A idled, B was held until D — key-c never starts');
    assert.equal(seen[0] === 'Bearer key-a' && seen[1] === 'Bearer key-b', true,
      'attempt order must be A then B, once each (no repeated or spliced key)');
    assert.equal(result.body.includes('event:'), false, 'no late A or B translation escaped before facade 504');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const logs = fs.readFileSync(started.logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.deepEqual(logs.filter((entry) => entry.message === 'request_outcome').map((entry) => entry.outcome),
      ['idle_timeout', 'request_deadline']);
    assert.equal(logs.filter((entry) => entry.message === 'Upstream error, backing off').length, 0);
    assert.ok(logs.some((entry) => entry.earlyStopReason === 'request_deadline'));
    for (const key of JSON.parse(fs.readFileSync(started.statePath, 'utf8')).keys) {
      assert.equal(key.usage.fail, 0, 'cancelled translation must not persist a failure');
      assert.equal(key.backoffUntil, 0, 'cancelled translation must not impose backoff');
    }
  } finally {
    for (const drip of drips) clearInterval(drip);
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('38a. persisted sticky key is excluded after empty Anthropic SSE so the healthy key completes the stream', async () => {
  const seenAuthorizations = [];
  const sse = openaiSseStream({ model: 'sticky/anthropic', segments: ['Recovered'] });
  const upstream = await createLocalUpstream((req, response) => {
    seenAuthorizations.push(req.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (seenAuthorizations.length === 1) response.end();
    else response.end(sse);
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port, {
    keys: ['key-a', 'key-b'],
    affinityModel: 'sticky/anthropic',
    maxFailoverAttempts: 2
  });
  try {
    const body = JSON.stringify({
      model: 'sticky/anthropic',
      messages: [{ role: 'user', content: 'Recover' }],
      max_tokens: 100,
      stream: true
    });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
    assert.equal(result.statusCode, 200, `body=${result.body}`);
    assert.equal(result.terminal, 'ended');
    assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);
    const events = parseSseEvents(result.body);
    assert.equal(events.at(-1)?.eventType, 'message_stop', 'the replacement stream must complete');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('38ab. unterminated Anthropic SSE before any complete frame fails over without committing bytes', async () => {
  const seenAuthorizations = [];
  const incomplete = 'data: {"choices":[{"delta":{"content":"discard-me"},"finish_reason":null}]}';
  const recovered = openaiSseStream({ model: 'incomplete/anthropic', segments: ['Recovered'] });
  const upstream = await createLocalUpstream((req, response) => {
    seenAuthorizations.push(req.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(seenAuthorizations.length === 1 ? incomplete : recovered);
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port, {
    keys: ['key-a', 'key-b'],
    affinityModel: 'incomplete/anthropic',
    maxFailoverAttempts: 2
  });
  try {
    const body = JSON.stringify({ model: 'incomplete/anthropic', messages: [{ role: 'user', content: 'Recover' }], max_tokens: 100, stream: true });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
    assert.equal(result.statusCode, 200, `body=${result.body}`);
    assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);
    const events = parseSseEvents(result.body);
    assert.equal(events.some((event) => event.data?.delta?.text === 'discard-me'), false);
    assert.equal(events.some((event) => event.data?.delta?.text === 'Recovered'), true);
    assert.equal(events.at(-1)?.eventType, 'message_stop');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('38aa. partial incomplete Anthropic SSE terminates with an error, never retries in-request, and the next request changes key', async () => {
  const seenAuthorizations = [];
  const partial = `data: ${JSON.stringify({ id: 'chatcmpl-partial', model: 'partial/anthropic', choices: [{ index: 0, delta: { content: 'half' }, finish_reason: null }] })}\n\n`;
  const recovered = openaiSseStream({ model: 'partial/anthropic', segments: ['whole'] });
  const upstream = await createLocalUpstream((req, response) => {
    if (!req.headers.authorization) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[]}');
      return;
    }
    seenAuthorizations.push(req.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(seenAuthorizations.length === 1 ? partial : recovered);
  });
  const { child, gatewayPort, statePath } = await startGatewayWithLocalUpstream(upstream.address().port, {
    keys: ['key-a', 'key-b'],
    affinityModel: 'partial/anthropic',
    maxFailoverAttempts: 2
  });
  try {
    const body = JSON.stringify({ model: 'partial/anthropic', messages: [{ role: 'user', content: 'Recover' }], max_tokens: 100, stream: true });
    const first = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
    assert.equal(first.statusCode, 200);
    // Plan L1 (обрывы): committed then upstream EOF -> `event: error` may be
    // written, but no `message_stop` and the client sees a transport abort.
    assert.ok(first.terminal === 'aborted' || first.terminal === 'error', `expected transport abort, got ${first.terminal}`);
    const firstEvents = parseSseEvents(first.body);
    assert.equal(firstEvents.some((event) => event.eventType === 'content_block_delta' && event.data?.delta?.text === 'half'), true);
    assert.equal(firstEvents.some((event) => event.eventType === 'message_stop'), false);
    assert.equal(firstEvents.at(-1)?.eventType, 'error');
    assert.deepEqual(firstEvents.at(-1)?.data, { type: 'error', error: { type: 'api_error', message: 'Upstream stream ended before completion' } });
    assert.deepEqual(seenAuthorizations, ['Bearer key-a'], 'a committed Anthropic stream must not splice in key B');

    const second = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
    assert.equal(second.statusCode, 200);
    assert.equal(parseSseEvents(second.body).at(-1)?.eventType, 'message_stop');
    assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('38ac. split first error frame fails over before commitment and returns only healthy key B output', async () => {
  const seenAuthorizations = [];
  const recovered = openaiSseStream({ model: 'split-error/anthropic', segments: ['healthy-b'] });
  const upstream = await createLocalUpstream((req, response) => {
    seenAuthorizations.push(req.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (seenAuthorizations.length === 1) {
      response.write('da');
      setTimeout(() => response.end('ta: {"error":{"message":"key A failed"}}\n\ndata: [DONE]\n\n'), 5);
    } else response.end(recovered);
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port, {
    keys: ['key-a', 'key-b'], affinityModel: 'split-error/anthropic', maxFailoverAttempts: 2
  });
  try {
    const body = JSON.stringify({ model: 'split-error/anthropic', messages: [{ role: 'user', content: 'Recover' }], max_tokens: 100, stream: true });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
    const events = parseSseEvents(result.body);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);
    assert.deepEqual(events.filter((event) => event.data?.delta?.text).map((event) => event.data.delta.text), ['healthy-b']);
    assert.equal(events.some((event) => event.eventType === 'error'), false);
    assert.equal(events.at(-1)?.eventType, 'message_stop');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('38ad. split error after visible content does not fail over, terminates once, and fails the key/model', async () => {
  const seenAuthorizations = [];
  const recovered = openaiSseStream({ model: 'late-error/anthropic', segments: ['healthy-b'] });
  const upstream = await createLocalUpstream((req, response) => {
    if (!req.headers.authorization) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[]}');
      return;
    }
    seenAuthorizations.push(req.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.headers.authorization === 'Bearer key-b') {
      response.end(recovered);
      return;
    }
    response.write('data: {"choices":[{"delta":{"content":"visible-once"},"finish_reason":null}]}\n\n');
    response.write('data: {"error":{"message":"late ');
    setTimeout(() => response.end('failure"}}\n\ndata: [DONE]\n\n'), 5);
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port, {
    keys: ['key-a', 'key-b'], affinityModel: 'late-error/anthropic', maxFailoverAttempts: 2
  });
  try {
    const body = JSON.stringify({ model: 'late-error/anthropic', messages: [{ role: 'user', content: 'Stream' }], max_tokens: 100, stream: true });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
    const events = parseSseEvents(result.body);
    assert.deepEqual(seenAuthorizations, ['Bearer key-a']);
    assert.equal(events.filter((event) => event.data?.delta?.text === 'visible-once').length, 1);
    assert.equal(events.filter((event) => event.eventType === 'error').length, 1);
    assert.equal(events.filter((event) => event.eventType === 'message_stop').length, 1);
    assert.deepEqual(events.slice(-2).map((event) => event.eventType), ['error', 'message_stop']);
    const second = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
    assert.equal(parseSseEvents(second.body).some((event) => event.data?.delta?.text === 'healthy-b'), true);
    assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b'], 'the failed key/model must be skipped on the next request');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

for (const phase of ['precommit', 'post-visible']) {
  test(`38ada. split named event:error with top-level payload is semantic upstream failure ${phase}`, async () => {
    const seenAuthorizations = [];
    const model = `named-error-${phase}/anthropic`;
    const recovered = openaiSseStream({ model, segments: ['healthy-b'] });
    const upstream = await createLocalUpstream((req, response) => {
      if (!req.headers.authorization) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"data":[]}');
        return;
      }
      seenAuthorizations.push(req.headers.authorization);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (req.headers.authorization === 'Bearer key-b') {
        response.end(recovered);
        return;
      }
      if (phase === 'post-visible') response.write('data: {"choices":[{"delta":{"content":"visible-a"},"finish_reason":null}]}\n\n');
      response.write('eve');
      response.write('nt: er');
      response.write('ror\nda');
      response.write('ta: {"type":"overloaded_error","mes');
      response.end('sage":"named failure"}\n\ndata: [DONE]\n\n');
    });
    const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b'], affinityModel: model, maxFailoverAttempts: 2
    });
    try {
      const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'Stream' }], max_tokens: 100, stream: true });
      const first = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
      const events = parseSseEvents(first.body);
      assert.equal(first.terminal, 'ended');
      if (phase === 'precommit') {
        assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);
        assert.deepEqual(events.filter((event) => event.data?.delta?.text).map((event) => event.data.delta.text), ['healthy-b']);
        assert.equal(events.some((event) => event.eventType === 'error'), false);
      } else {
        assert.deepEqual(seenAuthorizations, ['Bearer key-a']);
        assert.equal(events.filter((event) => event.eventType === 'error').length, 1);
        assert.equal(events.filter((event) => event.eventType === 'message_stop').length, 1);
        assert.deepEqual(events.slice(-2).map((event) => event.eventType), ['error', 'message_stop']);
        const second = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
        assert.equal(parseSseEvents(second.body).some((event) => event.data?.delta?.text === 'healthy-b'), true);
        assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);
      }
    } finally {
      await stopGateway(child);
      await closeServer(upstream);
    }
  });
}

// ── 2026-09-16 incident, Anthropic facade: benign frames (keepalive comments,
// empty no-op deltas) must not count as client-visible meaningful output. The
// incremental decoder must not translate them into a commit; an SSE error that
// follows such frames is still a PRE-COMMIT failure and must fail over. ─────

for (const [name, benignFrame] of [
  ['comment keepalive frame', ': keepalive\n\n'],
  ['empty no-op delta frame', 'data: {"id":"noop","choices":[{"index":0,"delta":{},"finish_reason":null}]}\n\n']
]) {
  test(`38aea. benign ${name} before an SSE error must not commit; the healthy key completes the stream`, async () => {
    const seenAuthorizations = [];
    const model = `benign-then-error/anthropic`;
    const recovered = openaiSseStream({ model, segments: ['healthy-b'] });
    const upstream = await createLocalUpstream((req, response) => {
      if (!req.headers.authorization) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"data":[]}');
        return;
      }
      seenAuthorizations.push(req.headers.authorization);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (req.headers.authorization === 'Bearer key-b') {
        response.end(recovered);
        return;
      }
      response.write(benignFrame);
      setTimeout(() => response.end('data: {"error":{"code":500,"type":"internal_server_error"}}\n\ndata: [DONE]\n\n'), 10);
    });
    const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b'], affinityModel: model, maxFailoverAttempts: 2
    });
    try {
      const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'Stream' }], max_tokens: 100, stream: true });
      const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
      const events = parseSseEvents(result.body);
      assert.equal(result.terminal, 'ended');
      assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b'],
        'the benign-then-error attempt must fail over before the first translated client event');
      assert.equal(result.statusCode, 200);
      assert.deepEqual(events.filter((event) => event.data?.delta?.text).map((event) => event.data.delta.text), ['healthy-b']);
      assert.equal(events.some((event) => event.eventType === 'error'), false,
        'no upstream error may reach the client after a pre-commit failure');
      assert.equal(events.at(-1)?.eventType, 'message_stop');
    } finally {
      await stopGateway(child);
      await closeServer(upstream);
    }
  });
}

for (const failureMode of ['response-error', 'aborted', 'premature-close']) {
  test(`38adb. ${failureMode} after visible Anthropic output emits one protocol terminal and does not splice keys`, async () => {
    const seenAuthorizations = [];
    const model = `committed-${failureMode}/anthropic`;
    const recovered = openaiSseStream({ model, segments: ['healthy-b'] });
    const upstream = await createLocalUpstream((req, response) => {
      if (!req.headers.authorization) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"data":[]}');
        return;
      }
      seenAuthorizations.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer key-b') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(recovered);
        return;
      }
      const visible = 'data: {"choices":[{"delta":{"content":"visible-a"},"finish_reason":null}]}\n\n';
      const headers = { 'content-type': 'text/event-stream' };
      if (failureMode === 'premature-close') headers['content-length'] = String(Buffer.byteLength(visible) + 100);
      response.writeHead(200, headers);
      response.write(visible);
      setTimeout(() => {
        if (failureMode === 'response-error') response.destroy(new Error('synthetic upstream response error'));
        else if (failureMode === 'aborted') response.socket.destroy();
        else response.end();
      }, 10);
    });
    const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b'], affinityModel: model, maxFailoverAttempts: 2
    });
    try {
      const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'Stream' }], max_tokens: 100, stream: true });
      const first = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
      const events = parseSseEvents(first.body);
      // Plan L1 (обрывы): a post-commit upstream break ends as a transport
      // abort — `event: error` allowed, no `message_stop`, no clean EOF.
      assert.ok(['aborted', 'error'].includes(first.terminal), `terminal=${first.terminal}; body=${first.body}`);
      assert.deepEqual(seenAuthorizations, ['Bearer key-a'], 'a committed stream must not fail over in-request');
      assert.equal(events.filter((event) => event.data?.delta?.text === 'visible-a').length, 1);
      assert.equal(events.filter((event) => event.eventType === 'error').length, 1);
      assert.equal(events.filter((event) => event.eventType === 'message_stop').length, 0);
      assert.equal(events.at(-1)?.eventType, 'error');

      const second = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
      assert.equal(parseSseEvents(second.body).some((event) => event.data?.delta?.text === 'healthy-b'), true);
      assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);
    } finally {
      await stopGateway(child);
      await closeServer(upstream);
    }
  });
}

for (const transportFailure of ['response-error', 'socket-abort']) {
  test(`38ae. incomplete first transport fragment followed by ${transportFailure} fails over before commitment`, async () => {
    const seenAuthorizations = [];
    const model = `transport-${transportFailure}/anthropic`;
    const recovered = openaiSseStream({ model, segments: ['healthy-b'] });
    const upstream = await createLocalUpstream((req, response) => {
      seenAuthorizations.push(req.headers.authorization);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (seenAuthorizations.length === 1) {
        response.write('da');
        setTimeout(() => {
          if (transportFailure === 'response-error') response.destroy(new Error('synthetic response failure'));
          else response.socket.destroy();
        }, 5);
      } else response.end(recovered);
    });
    const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b'], affinityModel: model, maxFailoverAttempts: 2
    });
    try {
      const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'Recover' }], max_tokens: 100, stream: true });
      const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
      const events = parseSseEvents(result.body);
      assert.equal(result.statusCode, 200, `body=${result.body}`);
      assert.equal(result.terminal, 'ended');
      assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);
      assert.deepEqual(events.filter((event) => event.data?.delta?.text).map((event) => event.data.delta.text), ['healthy-b']);
      assert.equal(events.at(-1)?.eventType, 'message_stop');

      const second = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
      assert.equal(second.statusCode, 200);
      assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b', 'Bearer key-b'], 'only successful B may replace the persisted affinity');
    } finally {
      await stopGateway(child);
      await closeServer(upstream);
    }
  });
}

for (const [label, invalidBody] of [
  ['malformed JSON', 'not-json'],
  ['truncated JSON', '{"choices":[{"message":{"content":"cut"}}]']
]) {
  test(`38af. buffered Anthropic ${label} fails over before success and persists only healthy B`, async () => {
    const seenAuthorizations = [];
    const model = `buffered-${label.replaceAll(' ', '-')}/anthropic`;
    const upstream = await createLocalUpstream((req, response) => {
      seenAuthorizations.push(req.headers.authorization);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(seenAuthorizations.length === 1 ? invalidBody : openaiCompletionJson({ model, content: 'healthy-b' }));
    });
    const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b'], affinityModel: model, maxFailoverAttempts: 2
    });
    try {
      const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'Recover' }], max_tokens: 100 });
      const first = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
      assert.equal(first.statusCode, 200, `body=${first.body}`);
      assert.equal(JSON.parse(first.body).content[0].text, 'healthy-b');
      assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);

      const second = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
      assert.equal(second.statusCode, 200);
      assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b', 'Bearer key-b'], 'invalid A must never repin affinity before B succeeds');
    } finally {
      await stopGateway(child);
      await closeServer(upstream);
    }
  });
}

test('38ag. buffered Anthropic HTTP 200 error envelope fails over, backs off A, and assigns only healthy B', async () => {
  const seenAuthorizations = [];
  const model = 'buffered-semantic-error/anthropic';
  const upstream = await createLocalUpstream((req, response) => {
    seenAuthorizations.push(req.headers.authorization);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(seenAuthorizations.length === 1
      ? JSON.stringify({ error: { type: 'overloaded_error', message: 'temporary overload' } })
      : openaiCompletionJson({ model, content: 'healthy-b', usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }));
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port, {
    keys: ['key-a', 'key-b'], affinityModel: model, maxFailoverAttempts: 2
  });
  try {
    const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'Recover' }], max_tokens: 100 });
    const first = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
    assert.equal(first.statusCode, 200, `body=${first.body}`);
    assert.equal(JSON.parse(first.body).content[0].text, 'healthy-b');
    assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);

    const keysResult = await rawRequest({ port: gatewayPort + 1, pathname: '/admin/keys', method: 'GET', headers: { authorization: 'Bearer test-admin-token' } });
    const keys = JSON.parse(keysResult.body).keys;
    assert.equal(keysResult.statusCode, 200);
    assert.equal(keys[0].usage.fail, 1, 'semantic HTTP 200 failure must be accounted against A');
    assert.ok(keys[0].backoffUntil > Date.now(), 'semantic HTTP 200 failure must back off A');
    assert.equal(keys[1].usage.success, 1, 'only B may receive successful usage');

    const second = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b', 'Bearer key-b'], 'only successful B may become affinity');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

for (const [label, invalidCompletion] of [
  ['missing choices', { id: 'x', object: 'chat.completion' }],
  ['empty choices', { id: 'x', object: 'chat.completion', choices: [] }],
  ['missing choices[0]', { id: 'x', object: 'chat.completion', choices: [null] }],
  ['choice missing message', { id: 'x', object: 'chat.completion', choices: [{ finish_reason: 'stop' }] }]
]) {
  test(`38ah. buffered Anthropic structurally invalid completion (${label}) fails over to B`, async () => {
    const seenAuthorizations = [];
    const model = `buffered-invalid-${label.replaceAll(/[^a-z0-9]+/gi, '-')}/anthropic`;
    const upstream = await createLocalUpstream((req, response) => {
      seenAuthorizations.push(req.headers.authorization);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(seenAuthorizations.length === 1
        ? JSON.stringify(invalidCompletion)
        : openaiCompletionJson({ model, content: 'healthy-b' }));
    });
    const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port, {
      keys: ['key-a', 'key-b'], affinityModel: model, maxFailoverAttempts: 2
    });
    try {
      const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'Recover' }], max_tokens: 100 });
      const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
      assert.equal(result.statusCode, 200, `body=${result.body}`);
      assert.equal(JSON.parse(result.body).content[0].text, 'healthy-b');
      assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);
    } finally {
      await stopGateway(child);
      await closeServer(upstream);
    }
  });
}

test('38ai. buffered Anthropic valid completion with optional metadata remains accepted on A', async () => {
  const seenAuthorizations = [];
  const upstream = await createLocalUpstream((req, response) => {
    seenAuthorizations.push(req.headers.authorization);
    response.writeHead(200, { 'content-type': 'application/json' });
    const completion = JSON.parse(openaiCompletionJson({ model: 'buffered-valid/anthropic', content: 'accepted-a' }));
    completion.system_fingerprint = 'optional-provider-metadata';
    completion.provider = { trace: 'opaque-but-valid' };
    response.end(JSON.stringify(completion));
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port, {
    keys: ['key-a', 'key-b'], affinityModel: 'buffered-valid/anthropic', maxFailoverAttempts: 2
  });
  try {
    const body = JSON.stringify({ model: 'buffered-valid/anthropic', messages: [{ role: 'user', content: 'Accept' }], max_tokens: 100 });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
    assert.equal(result.statusCode, 200, `body=${result.body}`);
    assert.equal(JSON.parse(result.body).content[0].text, 'accepted-a');
    assert.deepEqual(seenAuthorizations, ['Bearer key-a']);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('38aj. buffered Anthropic semantic error metadata is bounded and never leaks arbitrary upstream bodies', async () => {
  const seenAuthorizations = [];
  const secretA = `private-a-${'x'.repeat(2_000)}`;
  const secretB = `private-b-${'y'.repeat(2_000)}`;
  const upstream = await createLocalUpstream((req, response) => {
    seenAuthorizations.push(req.headers.authorization);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: {
      type: seenAuthorizations.length === 1 ? 'overloaded_error' : `invalid-${'z'.repeat(500)}`,
      code: `hostile-${'q'.repeat(500)}`,
      message: seenAuthorizations.length === 1 ? secretA : secretB,
      arbitrary: { body: secretA + secretB }
    } }));
  });
  const { child, gatewayPort, logPath } = await startGatewayWithLocalUpstream(upstream.address().port, {
    keys: ['key-a', 'key-b'], affinityModel: 'buffered-sanitized/anthropic', maxFailoverAttempts: 2
  });
  try {
    const body = JSON.stringify({ model: 'buffered-sanitized/anthropic', messages: [{ role: 'user', content: 'Fail safely' }], max_tokens: 100 });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders(), timeoutMs: 8_000 });
    assert.equal(result.statusCode, 502, `body=${result.body}`);
    assert.deepEqual(seenAuthorizations, ['Bearer key-a', 'Bearer key-b']);
    assert.doesNotMatch(result.body, /private-a-|private-b-|hostile-|invalid-z/);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const logs = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    assert.doesNotMatch(logs, /private-a-|private-b-|hostile-|invalid-z/);
    const semanticEntries = logs.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.message === 'Buffered Anthropic semantic failure');
    assert.equal(semanticEntries.length, 2);
    assert.equal(semanticEntries[0].upstreamType, 'overloaded_error');
    assert.equal(semanticEntries[0].upstreamCode, undefined);
    assert.equal(semanticEntries[1].upstreamType, undefined);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});


test('38b. Anthropic upstream receives only protocol and gateway-owned request headers', async () => {
  let upstreamHeaders;
  const upstream = await createLocalUpstream((req, response) => {
    upstreamHeaders = req.headers;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(openaiCompletionJson());
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port, { corsAllowlist: 'https://client.invalid' });
  try {
    const body = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10 });
    const result = await rawRequest({
      port: gatewayPort,
      pathname: '/v1/messages',
      body,
      headers: authHeaders({
        accept: 'application/json',
        cookie: 'session=client-secret',
        'x-api-key': 'client-api-key',
        'x-forwarded-for': '203.0.113.10',
        'x-real-ip': '203.0.113.11',
        forwarded: 'for=203.0.113.12',
        referer: 'https://client.invalid/private',
        origin: 'https://client.invalid',
        'proxy-authorization': 'Basic client-proxy-secret',
        'x-secret': 'unknown-client-secret',
        'user-agent': 'private-client-agent',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'private-beta'
      })
    });
    assert.equal(result.statusCode, 200, `body=${result.body}`);
    assert.equal(upstreamHeaders.authorization, 'Bearer local-test-key');
    assert.equal(upstreamHeaders.host, 'integrate.api.nvidia.com');
    assert.equal(upstreamHeaders.accept, 'application/json');
    assert.equal(upstreamHeaders['content-type'], 'application/json');
    assert.equal(Number(upstreamHeaders['content-length']) > 0, true);
    for (const header of ['cookie', 'x-api-key', 'x-forwarded-for', 'x-real-ip', 'forwarded', 'referer', 'origin', 'proxy-authorization', 'x-secret', 'user-agent', 'anthropic-version', 'anthropic-beta']) {
      assert.equal(upstreamHeaders[header], undefined, `${header} must not reach upstream`);
    }
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('38c. Anthropic streaming forwards SSE accept and recomputed translated length without client secrets', async () => {
  let upstreamHeaders;
  let upstreamBody;
  const upstream = await createLocalUpstream((req, response) => {
    upstreamHeaders = req.headers;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      upstreamBody = Buffer.concat(chunks);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(openaiSseStream({ segments: ['Safe'] }));
    });
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port, { corsAllowlist: 'https://client.invalid' });
  try {
    const body = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10, stream: true });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders({
      accept: 'text/event-stream', 'accept-encoding': 'br', cookie: 'private', 'x-api-key': 'private',
      'x-forwarded-for': '203.0.113.10', 'anthropic-version': '2023-06-01', 'x-client-metadata': 'private'
    }) });
    assert.equal(result.statusCode, 200);
    assert.equal(upstreamHeaders.accept, 'text/event-stream');
    assert.equal(Number(upstreamHeaders['content-length']), upstreamBody.length, 'translated OpenAI body length must be recomputed');
    assert.equal(upstreamHeaders.authorization, 'Bearer local-test-key');
    assert.equal(upstreamHeaders['http-referer'], 'https://opencode.ai/');
    assert.equal(upstreamHeaders['x-title'], 'opencode');
    assert.equal(upstreamHeaders['x-billing-invoke-origin'], 'OpenCode');
    for (const header of ['accept-encoding', 'cookie', 'x-api-key', 'x-forwarded-for', 'anthropic-version', 'x-client-metadata']) assert.equal(upstreamHeaders[header], undefined);
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

// ── MASTER-006: x-api-key ingress on the Anthropic facade ───────────────────
// AUDIT-BRIEF 4.3.3 documents `x-api-key: <gatewayToken>` as an alternative to
// `Authorization: Bearer <gatewayToken>` on POST /v1/messages — that is what the
// official Anthropic SDK and Claude Code send by default. Contract under test:
//   * /v1/messages accepts a valid x-api-key when no Authorization header is sent;
//   * an explicit Authorization header is AUTHORITATIVE — a wrong Bearer is not
//     rescued by a valid x-api-key, and a valid Bearer wins over a wrong x-api-key;
//   * the OpenAI route (/v1/chat/completions) stays Bearer-only.

test('46. POST /v1/messages accepts a valid x-api-key credential (no Authorization header)', async () => {
  const upstream = await createLocalUpstream((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(openaiCompletionJson());
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port);
  try {
    const body = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10 });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: { 'x-api-key': TEST_GATEWAY_TOKEN } });
    assert.equal(result.statusCode, 200, `x-api-key must authenticate /v1/messages; body=${result.body}`);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.type, 'message');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('47. POST /v1/messages rejects a wrong x-api-key credential', async () => {
  const upstream = await createLocalUpstream((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(openaiCompletionJson());
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port);
  try {
    const body = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10 });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: { 'x-api-key': `${TEST_GATEWAY_TOKEN}-wrong` } });
    assert.equal(result.statusCode, 401);
    assert.equal(result.headers['www-authenticate'], 'Bearer');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('48. POST /v1/chat/completions stays Bearer-only: a valid x-api-key is NOT accepted', async () => {
  const upstream = await createLocalUpstream((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(openaiCompletionJson());
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port);
  try {
    const body = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], stream: false });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/chat/completions', body, headers: { 'x-api-key': TEST_GATEWAY_TOKEN } });
    assert.equal(result.statusCode, 401, 'the OpenAI route must not accept x-api-key');
    assert.equal(result.headers['www-authenticate'], 'Bearer');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('49. POST /v1/messages with a valid Bearer AND a wrong x-api-key uses Bearer (Bearer takes precedence)', async () => {
  const upstream = await createLocalUpstream((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(openaiCompletionJson());
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port);
  try {
    const body = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10 });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: authHeaders({ 'x-api-key': 'wrong-x-api-key' }) });
    assert.equal(result.statusCode, 200, `a valid Bearer must win over a wrong x-api-key; body=${result.body}`);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('50. POST /v1/messages with a wrong Bearer AND a valid x-api-key is rejected (Authorization is authoritative)', async () => {
  const upstream = await createLocalUpstream((_req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(openaiCompletionJson());
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port);
  try {
    const body = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10 });
    const result = await rawRequest({ port: gatewayPort, pathname: '/v1/messages', body, headers: { authorization: 'Bearer wrong-bearer-token', 'x-api-key': TEST_GATEWAY_TOKEN } });
    assert.equal(result.statusCode, 401, 'a wrong Bearer must not be rescued by a valid x-api-key');
    assert.equal(result.headers['www-authenticate'], 'Bearer');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});
