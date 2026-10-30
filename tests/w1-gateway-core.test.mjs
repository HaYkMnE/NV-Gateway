/**
 * W1 gateway-core regression tests (Level-1 fix wave).
 *
 * Defects under test, each with a real reproduction:
 *  1. `new URL(req.url, ...)` outside a guard crashed the child on `GET //`.
 *  2. A `null`/array/string JSON body crashed or burned keys upstream.
 *  3. JSON gating (disabled models, reasoning defaults) was skipped whenever the
 *     client omitted `content-type: application/json`.
 *  4. Streamed completions recorded `tokens: null` because usage was never read
 *     from the SSE stream.
 *  6. SSE passthrough ignored downstream backpressure (stalled client grew RSS).
 *  7. `getModelLimits` walked the prototype chain ("constructor" etc.).
 *
 * Everything runs on 127.0.0.1 with a fake upstream and fake keys only.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';
import { GATEWAY_START_MAX_ATTEMPTS, highPortReservation, killOnBindCollision } from './support/gateway-bind-collision.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fileTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-w1-core-${process.pid}-`));
test.after(() => fs.rmSync(fileTempRoot, { recursive: true, force: true }));

const DEEPSEEK = 'deepseek-ai/deepseek-v4.1-flash';
const KIMI = 'moonshotai/kimi-k3';

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function request(port, url, method = 'GET', body = '', headers = {}, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (timeoutMs !== undefined) req.setTimeout(timeoutMs, () => req.destroy(new Error(`${url} timeout`)));
    req.end(body);
  });
}

/** Send a RAW request line so Node's client never normalizes the path away. */
function rawRequest(port, requestLine) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    socket.on('error', reject);
    socket.setTimeout(8_000, () => { socket.destroy(); reject(new Error('raw request timeout')); });
  });
}

function statusLine(raw) {
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
  return match ? Number(match[1]) : 0;
}

/**
 * @typedef {{ status: number, body?: string, headers?: Record<string, string>, abort?: boolean }} FakeResponse
 * @typedef {{
 *   keys?: string[],
 *   responses?: FakeResponse[],
 *   config?: Record<string, unknown>,
 *   handleRequest?: (ctx: { req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, rawBody: string }) => void,
 *   captureBody?: boolean,
 *   env?: Record<string, string>
 * }} HarnessOptions
 * @param {HarnessOptions} [options]
 */
async function startHarness({ keys = ['key-a'], responses, config, handleRequest, captureBody = false, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(fileTempRoot, 'gw-'));
  const statePath = path.join(dir, 'keys.json');
  const logPath = path.join(dir, 'gateway.jsonl');
  const configPath = config ? path.join(dir, 'config.json') : undefined;
  if (config) fs.writeFileSync(configPath, JSON.stringify(config));
  fs.writeFileSync(statePath, JSON.stringify({
    keys: keys.map((key, index) => ({ id: `key-${index}`, key, status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: index + 1 } }))
  }));
  const seenAuthorizations = [];
  const capturedBodies = [];
  const pending = responses ? [...responses] : [];
  const upstream = http.createServer((req, res) => {
    seenAuthorizations.push(req.headers.authorization);
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      if (captureBody) capturedBodies.push(rawBody);
      if (handleRequest) { handleRequest({ req, res, rawBody }); return; }
      const response = pending.shift() ?? { status: 500 };
      res.writeHead(response.status, response.headers ?? { 'content-type': 'application/json' });
      if (response.abort) { res.write(response.body ?? 'x'); setTimeout(() => res.socket.destroy(), 5); return; }
      res.end(response.body ?? '{}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const gatewayToken = `w1-${randomUUID()}`;
  let child;
  let port;
  let detachCollisionWatch;
  const started = await startGatewayOnReservedPort({
    maxAttempts: GATEWAY_START_MAX_ATTEMPTS,
    reservationOptions: highPortReservation(),
    readinessTimeoutMs: 20_000,
    spawnChild(candidatePort) {
      port = candidatePort;
      const spawned = spawn(process.execPath, ['--require', path.join(root, 'tests/local-upstream-preload.cjs'), path.join(root, 'src/gateway/server.mjs')], {
        env: {
          ...process.env,
          GATEWAY_LOG_PATH: logPath,
          GATEWAY_MAX_FAILOVER_ATTEMPTS: '1',
          GATEWAY_CONFIG_PATH: configPath,
          GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstream.address().port),
          PORT: String(candidatePort),
          ...env
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true
      });
      child = spawned;
      detachCollisionWatch = killOnBindCollision(spawned);
      spawned.once('message', (message) => {
        if (message?.type === 'ready') {
          spawned.send({
            type: 'state:init',
            challenge: message.challenge,
            state: { keys: JSON.parse(fs.readFileSync(statePath, 'utf8')).keys, credentials: { gatewayToken, adminToken: 'w1-admin' } }
          });
        }
      });
      spawned.on('message', (message) => {
        if (message?.type === 'state:persist') fs.writeFileSync(statePath, JSON.stringify(message.state));
      });
      return spawned;
    }
  });
  child = started.child;
  port = started.port;
  detachCollisionWatch();
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try { if ((await request(port, '/health')).statusCode === 200) break; } catch { /* retry */ }
    await delay(25);
  }
  const auth = { authorization: `Bearer ${gatewayToken}` };
  return {
    port,
    statePath,
    logPath,
    seenAuthorizations,
    capturedBodies,
    auth,
    alive: () => child.exitCode === null && child.signalCode === null,
    readState: () => JSON.parse(fs.readFileSync(statePath, 'utf8')),
    readOutcomes: () => fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((entry) => entry?.message === 'request_outcome')
      : [],
    close: async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => {
          const force = setTimeout(() => child.kill('SIGKILL'), 1_000);
          child.once('exit', () => { clearTimeout(force); resolve(); });
          child.kill();
        });
      }
      upstream.closeAllConnections?.();
      await new Promise((resolve) => upstream.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// ── Defect 1: unparseable request URLs must answer 400 and never kill the child ──
for (const { name, requestLine } of [
  { name: 'double-slash //', requestLine: 'GET // HTTP/1.1' },
  { name: 'unterminated IPv6 authority', requestLine: 'GET http://[ HTTP/1.1' },
  { name: 'encoded traversal', requestLine: 'GET /%2e%2e%2f%2e%2e%2fetc%2fpasswd HTTP/1.1' },
  { name: 'extremely long path', requestLine: `GET /${'a'.repeat(8000)} HTTP/1.1` }
]) {
  test(`defect 1: ${name} answers 4xx and the gateway child stays alive`, async () => {
    const harness = await startHarness({ responses: [] });
    try {
      const raw = await rawRequest(harness.port, requestLine);
      const status = statusLine(raw);
      assert.ok(status >= 400 && status < 500, `expected a 4xx for ${name}, got ${status || 'no status'}: ${raw.slice(0, 120)}`);
      assert.equal(harness.alive(), true, 'the child must survive an unparseable request URL');
      assert.equal((await request(harness.port, '/health')).statusCode, 200, 'health must stay reachable');
    } finally { await harness.close(); }
  });
}

// ── Defect 2: non-object JSON bodies are rejected with 400 on every entry point ──
for (const [route, envelope] of [
  ['/v1/chat/completions', (body) => body],
  ['/v1/messages', (body) => body],
  ['/v1/responses', (body) => body]
]) {
  for (const rawBody of ['null', '[]', '"just a string"']) {
    test(`defect 2: ${route} rejects ${rawBody} with 400 and never reaches upstream`, async () => {
      const harness = await startHarness({ responses: [{ status: 200, body: '{}' }] });
      try {
        const response = await request(harness.port, route, 'POST', rawBody, { ...harness.auth, 'content-type': 'application/json', 'content-length': Buffer.byteLength(rawBody) });
        assert.equal(response.statusCode, 400, `${route} must answer 400 for ${rawBody}, got ${response.statusCode}: ${response.body}`);
        assert.equal(harness.seenAuthorizations.length, 0, 'a rejected body must not reach the upstream or consume a key');
        assert.equal(harness.alive(), true);
      } finally { await harness.close(); }
    });
  }
}

// ── Defect 3: content-type is a hint only; JSON gating still applies ──
test('defect 3: a valid JSON body with NO content-type still honours disabledModels', async () => {
  const harness = await startHarness({
    config: { version: 1, gatewayPort: 12000, disabledModels: ['meta/llama-4-maverick-17b-128e-instruct'] },
    responses: [{ status: 200, body: '{"ok":true}' }]
  });
  try {
    const body = JSON.stringify({ model: 'meta/llama-4-maverick-17b-128e-instruct', messages: [{ role: 'user', content: 'hi' }] });
    const response = await request(harness.port, '/v1/chat/completions', 'POST', body, { ...harness.auth, 'content-length': Buffer.byteLength(body) });
    assert.equal(response.statusCode, 404, `disabled model must 404 without content-type, got ${response.statusCode}: ${response.body}`);
    assert.equal(harness.seenAuthorizations.length, 0, 'the disabled-model check must run before any key is touched');
  } finally { await harness.close(); }
});

test('defect 3: a valid JSON body with a NON-JSON content-type still gets reasoning defaults', async () => {
  const harness = await startHarness({ captureBody: true, responses: [{ status: 200, body: '{"choices":[{"message":{"content":"ok"}}]}' }] });
  try {
    const body = JSON.stringify({ model: KIMI, messages: [{ role: 'user', content: 'hi' }] });
    const response = await request(harness.port, '/v1/chat/completions', 'POST', body, { ...harness.auth, 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(harness.capturedBodies.length, 1);
    assert.equal(JSON.parse(harness.capturedBodies[0]).reasoning_effort, 'high', 'reasoning defaults must apply regardless of content-type');
  } finally { await harness.close(); }
});

// ── Defect 4: streamed completions record upstream usage tokens ──
test('defect 4: a streamed chat completion records usage.total_tokens (final include_usage chunk)', async () => {
  const usageChunk = `data: ${JSON.stringify({ id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 } })}\n\n`;
  const harness = await startHarness({
    handleRequest({ res }) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write(usageChunk);
      res.end('data: [DONE]\n\n');
    }
  });
  try {
    const body = JSON.stringify({ model: 'z-ai/glm-5.2', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const response = await request(harness.port, '/v1/chat/completions', 'POST', body, { ...harness.auth, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    assert.equal(response.statusCode, 200, response.body);
    let outcome;
    for (let attempt = 0; attempt < 80 && !outcome; attempt += 1) {
      outcome = harness.readOutcomes().find((entry) => entry.outcome === 'completed');
      if (!outcome) await delay(50);
    }
    assert.ok(outcome, 'a completed request_outcome row must be logged');
    assert.equal(outcome.tokens, 13, 'the SSE usage.total_tokens must be recorded, not null');
  } finally { await harness.close(); }
});

test('defect 4: a streamed completion with NO usage keeps tokens null (never fabricates 0)', async () => {
  const harness = await startHarness({
    handleRequest({ res }) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    }
  });
  try {
    const body = JSON.stringify({ model: 'z-ai/glm-5.2', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal((await request(harness.port, '/v1/chat/completions', 'POST', body, { ...harness.auth, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })).statusCode, 200);
    let outcome;
    for (let attempt = 0; attempt < 80 && !outcome; attempt += 1) {
      outcome = harness.readOutcomes().find((entry) => entry.outcome === 'completed');
      if (!outcome) await delay(50);
    }
    assert.ok(outcome);
    assert.equal(outcome.tokens, null, 'unknown usage must stay null');
  } finally { await harness.close(); }
});

// ── Defect 6: a stalled client must pause the upstream (backpressure) ──
test('defect 6: a stalled client pauses the upstream instead of buffering without bound', async () => {
  const CHUNK = Buffer.from(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'x'.repeat(1024) }, finish_reason: null }] })}\n\n`);
  const TOTAL_CHUNKS = 12_000; // ~13 MB if the gateway never applies backpressure
  let bytesWritten = 0;
  let upstreamFinished = false;
  const harness = await startHarness({
    handleRequest({ res }) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let sent = 0;
      const pump = () => {
        while (sent < TOTAL_CHUNKS) {
          sent += 1;
          bytesWritten += CHUNK.length;
          if (!res.write(CHUNK)) { res.once('drain', pump); return; }
        }
        upstreamFinished = true;
        res.end('data: [DONE]\n\n');
      };
      pump();
    }
  });
  try {
    const body = JSON.stringify({ model: 'z-ai/glm-5.2', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const paused = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: harness.port, path: '/v1/chat/completions', method: 'POST',
        headers: { ...harness.auth, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
      }, (res) => {
        res.once('data', () => { res.pause(); resolve(res); });
        res.once('error', reject);
      });
      req.once('error', reject);
      req.end(body);
    });
    // While the client is stalled the gateway must stop pulling from upstream.
    await delay(1_500);
    const stalledBytes = bytesWritten;
    assert.equal(upstreamFinished, false, 'a stalled client must not let the upstream finish streaming');
    assert.ok(stalledBytes < TOTAL_CHUNKS * CHUNK.length / 2,
      `upstream must be paused by downstream backpressure (wrote ${stalledBytes} of ${TOTAL_CHUNKS * CHUNK.length} bytes)`);
    paused.destroy();
  } finally { await harness.close(); }
});

// ── Defect 7: prototype-chain lookups must never answer a limit ──
test('defect 7: getModelLimits never resolves prototype members', async () => {
  const { getModelLimits, setModelLimits, resetModelLimitsCache } = await import('../src/gateway/model-limits.mjs');
  try {
    resetModelLimitsCache();
    setModelLimits({});
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      const limits = getModelLimits(key);
      assert.equal(Number.isSafeInteger(limits.context) && limits.context > 0, true, `${key} must fall back to a real limit, got ${JSON.stringify(limits)}`);
      assert.equal(Number.isSafeInteger(limits.output) && limits.output > 0, true, `${key} must fall back to a real limit, got ${JSON.stringify(limits)}`);
      assert.deepEqual(limits, { context: 131072, output: 4096 }, `${key} must use the hard fallback`);
    }
    // A genuine own entry still wins.
    setModelLimits({ constructor: { context: 7, output: 8 } });
    assert.deepEqual(getModelLimits('constructor'), { context: 7, output: 8 });
  } finally {
    resetModelLimitsCache();
  }
});
