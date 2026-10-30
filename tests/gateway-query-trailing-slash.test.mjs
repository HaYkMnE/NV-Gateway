// Client compatibility on the public /v1 routes: a query string (Claude Code
// always sends POST /v1/messages?beta=true) and a single trailing slash must be
// routed by the canonical pathname only. Security contract kept: the query never
// reaches the upstream request path, auth is still required, and unknown or
// non-canonical paths (e.g. `//`) still 404.
// Harness trimmed from tests/anthropic-route.test.mjs (real server.mjs + local fake upstream).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-gateway-query-slash-${process.pid}-`));
const preloadPath = path.join(projectRoot, 'tests', 'local-upstream-preload.cjs');
const TOKEN = `test-gateway-${randomUUID()}`;
const CANARY = 'qcanary';

const seenUpstreamPaths = [];
let upstream;
let child;
let gatewayPort;

function request(pathname, { method = 'POST', body = '', token = TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const req = http.request({ host: '127.0.0.1', port: gatewayPort, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.once('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.setTimeout(5_000, () => req.destroy(new Error('timed out')));
    req.end(body);
  });
}

function getHealth(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject);
    req.setTimeout(2_000, () => req.destroy(new Error('health timed out')));
  });
}

async function stopGateway(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise((resolve) => {
    const kill = setTimeout(() => proc.kill('SIGKILL'), 1_000);
    const fallback = setTimeout(resolve, 2_000);
    proc.once('exit', () => { clearTimeout(kill); clearTimeout(fallback); resolve(); });
    try { proc.kill(); } catch { /* already gone */ }
  });
}

const CHAT_BODY = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'hi' }] });
const MESSAGES_BODY = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 });

test.before(async () => {
  upstream = http.createServer((req, res) => {
    seenUpstreamPaths.push(req.url);
    req.resume();
    req.once('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.startsWith('/v1/models')) return res.end('{"data":[]}');
      res.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: 'z-ai/glm-5.2',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;

  const started = await startGatewayOnReservedPort({ maxAttempts: 8, readinessTimeoutMs: 12_000, spawnChild(port) {
    gatewayPort = port;
    const dir = fs.mkdtempSync(path.join(tempRoot, `gw-${port}-`));
    const statePath = path.join(dir, 'keys.json');
    const keys = [{ id: 'test-key-0', key: 'local-test-key', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 } }];
    fs.writeFileSync(statePath, JSON.stringify({ keys }));
    const spawned = spawnChildProcess(port, dir, upstreamPort);
    spawned.once('message', (message) => {
      if (message?.type === 'ready') {
        spawned.send({ type: 'state:init', challenge: message.challenge,
          state: { keys, credentials: { gatewayToken: TOKEN, adminToken: 'test-admin-token' } } });
      }
    });
    return spawned;
  } });
  child = started.child;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if (await getHealth(gatewayPort) === 200) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('gateway did not become healthy');
});

function spawnChildProcess(port, dir, upstreamPort) {
  return spawn(process.execPath, ['--require', preloadPath, path.join(projectRoot, 'src', 'gateway', 'server.mjs')], {
    env: { ...process.env, PORT: String(port), GATEWAY_LOG_PATH: path.join(dir, 'gateway.jsonl'),
      GATEWAY_MODEL_AFFINITY_CACHE_PATH: path.join(dir, 'model-key-affinity.json'),
      GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstreamPort) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true
  });
}

test.after(async () => {
  await stopGateway(child);
  upstream?.closeAllConnections?.();
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function assertNoQueryUpstream() {
  for (const p of seenUpstreamPaths) {
    assert.equal(p.includes('?'), false, `query forwarded upstream: ${p}`);
    assert.equal(p.includes(CANARY), false, `query canary forwarded upstream: ${p}`);
  }
}

test('POST /v1/messages?beta=true (Claude Code) reaches upstream; query not forwarded', async () => {
  seenUpstreamPaths.length = 0;
  const r = await request(`/v1/messages?beta=true&${CANARY}=1`, { body: MESSAGES_BODY });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(seenUpstreamPaths.includes('/v1/chat/completions'), JSON.stringify(seenUpstreamPaths));
  assertNoQueryUpstream();
});

test('POST /v1/chat/completions?foo=1 → 200; upstream path is exactly /v1/chat/completions', async () => {
  seenUpstreamPaths.length = 0;
  const r = await request(`/v1/chat/completions?foo=1&${CANARY}=1`, { body: CHAT_BODY });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(seenUpstreamPaths.includes('/v1/chat/completions'), JSON.stringify(seenUpstreamPaths));
  assertNoQueryUpstream();
});

test('GET /v1/models?x=1 → 200; query not forwarded', async () => {
  seenUpstreamPaths.length = 0;
  const r = await request(`/v1/models?x=1&${CANARY}=1`, { method: 'GET' });
  assert.equal(r.statusCode, 200, r.body);
  assertNoQueryUpstream();
});

test('single trailing slash on known routes → 200, forwarded as the canonical path', async () => {
  seenUpstreamPaths.length = 0;
  const chat = await request('/v1/chat/completions/', { body: CHAT_BODY });
  assert.equal(chat.statusCode, 200, chat.body);
  assert.ok(seenUpstreamPaths.includes('/v1/chat/completions'), JSON.stringify(seenUpstreamPaths));
  assert.equal(seenUpstreamPaths.includes('/v1/chat/completions/'), false);
  const models = await request('/v1/models/', { method: 'GET' });
  assert.equal(models.statusCode, 200, models.body);
});

test('dot-segment POST /v1/chat/completions/./ → 200 (resolved by WHATWG URL); upstream path is exactly /v1/chat/completions', async () => {
  seenUpstreamPaths.length = 0;
  const r = await request('/v1/chat/completions/./', { body: CHAT_BODY });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(seenUpstreamPaths, ['/v1/chat/completions']);
});

test('unknown / non-canonical paths still 404', async () => {
  for (const [method, p] of [['GET', '/v1/unknown?x=1'], ['GET', '/v1//models'], ['GET', '/v1/models//'],
    ['POST', '/v1//chat/completions'], ['GET', '/v1/unknown/'], ['POST', '/v1/messages//']]) {
    const r = await request(p, { method, body: method === 'POST' ? CHAT_BODY : '' });
    assert.equal(r.statusCode, 404, `${method} ${p}`);
  }
});

test('auth still required with a query string or trailing slash → 401', async () => {
  for (const [method, p] of [['POST', '/v1/messages?beta=true'], ['POST', '/v1/chat/completions?foo=1'], ['GET', '/v1/models?x=1'], ['GET', '/v1/models/']]) {
    const r = await request(p, { method, token: '', body: method === 'POST' ? CHAT_BODY : '' });
    assert.equal(r.statusCode, 401, `${method} ${p}`);
  }
});
