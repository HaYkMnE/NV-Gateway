// Non-stream OpenAI /v1/chat/completions: an upstream body cut mid-way must never
// reach the client as a clean end (chunked terminator / complete:true). The 200
// status line is already committed when the body starts, so the only honest
// signal left is a transport abort; the key is accounted upstream_stream_error.
import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';
import { GATEWAY_START_MAX_ATTEMPTS, highPortReservation, killOnBindCollision } from './support/gateway-bind-collision.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preloadPath = path.join(projectRoot, 'tests', 'local-upstream-preload.cjs');
// Seam for the handler-pinning tests: a fake upstreamRes with ONE terminal event.
const nstPreloadPath = path.join(projectRoot, 'tests', 'nonstream-truncation-preload.cjs');
// NST_SERVER_PATH lets a sandbox mutation run against a COPY; never set in the suite.
const serverPath = process.env.NST_SERVER_PATH || path.join(projectRoot, 'src', 'gateway', 'server.mjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-nst-${process.pid}-`));
// Unique per test process so a foreign gateway on a raced port never shares our token.
const TOKEN = `test-gateway-${randomUUID()}`;
const ADMIN_TOKEN = 'test-admin-token';
const KEYS = ['fake-key-a'];
const BODY = JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'Hi' }] });
const SENTINEL = 'NST-SENTINEL-9c2f41-do-not-leak';
const FULL = JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: SENTINEL } }], usage: { total_tokens: 7 } });
const PART1 = FULL.slice(0, 51);
const PART2 = FULL.slice(51);
// Gateway pairs come from highPortReservation() (20000-59999), never 12000/12001/12004/12005.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gone = (c) => c.exitCode !== null || c.signalCode !== null;

function request(port, method, pathname, { body, token = TOKEN, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${token}` };
    if (body !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (response) => {
      let text = '';
      let settled = false;
      const finish = (terminal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ statusCode: response.statusCode, body: text, terminal, complete: response.complete });
      };
      const timer = setTimeout(() => { response.destroy(); finish('timed-out'); }, timeoutMs);
      response.on('data', (chunk) => { text += chunk; });
      response.once('end', () => finish('ended'));
      response.once('aborted', () => finish('aborted'));
      response.once('error', () => finish('error'));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('client timeout')));
    req.once('error', reject);
    req.end(body);
  });
}

async function stopGateway(child) {
  if (!child || gone(child)) return;
  const exited = (ms) => new Promise((resolve) => {
    if (gone(child)) { resolve(true); return; }
    const timer = setTimeout(() => resolve(gone(child)), ms);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
  try { if (child.connected) child.send({ type: 'shutdown' }); } catch { /* gone */ }
  if (await exited(2_000)) return;
  child.kill();
  if (await exited(1_000)) return;
  child.kill('SIGKILL');
  await exited(1_000);
}

async function startGateway(upstreamPort, { keys, env = {} }) {
  const startBy = Date.now() + 12_000;
  let current;
  let started;
  try {
    started = await startGatewayOnReservedPort({
      maxAttempts: GATEWAY_START_MAX_ATTEMPTS,
      reservationOptions: highPortReservation(),
      readinessTimeoutMs: Math.max(1, startBy - Date.now()),
      spawnChild(port, attempt) {
        if (Date.now() >= startBy) throw new Error(`gateway start budget exhausted after attempt ${attempt - 1}`);
        const dir = fs.mkdtempSync(path.join(tempRoot, `gw-${port}-${attempt}-`));
        const logPath = path.join(dir, 'gateway.jsonl');
        const state = { keys: keys.map((key, index) => ({ id: `test-key-${index}`, key, status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: index } })) };
        const child = spawnChild(process.execPath, ['--require', env.GATEWAY_TEST_NST_MODE ? nstPreloadPath : preloadPath, serverPath], {
          env: {
            ...process.env,
            PORT: String(port),
            GATEWAY_LOG_PATH: logPath,
            GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstreamPort),
            GATEWAY_FIRST_BYTE_TIMEOUT_MS: '2000',
            GATEWAY_IDLE_TIMEOUT_MS: '2000',
            GATEWAY_REQUEST_DEADLINE_MS: '60000',
            ...env
          },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          windowsHide: true
        });
        const detachCollisionWatch = killOnBindCollision(child);
        child.once('message', (message) => {
          if (message?.type === 'ready') child.send({ type: 'state:init', challenge: message.challenge, state: { keys: state.keys, credentials: { gatewayToken: TOKEN, adminToken: ADMIN_TOKEN } } });
        });
        const persisted = [];
        child.on('message', (message) => { if (message?.type === 'state:persist') persisted.push(message.state); });
        current = { child, detachCollisionWatch, logPath, persisted };
        return child;
      }
    });
  } catch (error) {
    if (current) await stopGateway(current.child);
    throw new Error('gateway did not become healthy', { cause: error });
  }
  const { child, port } = started;
  current.detachCollisionWatch();
  while (Date.now() < startBy && !gone(child)) {
    try { if ((await request(port, 'GET', '/health', { timeoutMs: 1_000 })).statusCode === 200) return { child, port, logPath: current.logPath, persisted: current.persisted }; } catch { /* starting */ }
    await sleep(25);
  }
  await stopGateway(child);
  throw new Error('gateway did not become healthy');
}

async function logs(logPath) {
  await sleep(1_100); // logger flush interval
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
const outcomesOf = (entries) => entries.filter((e) => e.message === 'request_outcome').map((e) => e.outcome);
const penalties = (entries) => entries.filter((e) => e.message === 'Upstream error, backing off').length;

async function flushedAccounting(gateway) {
  const before = gateway.persisted.length;
  await stopGateway(gateway.child);
  for (let waited = 0; gateway.persisted.length === before && waited < 1_000; waited += 25) await sleep(25);
  assert.ok(gateway.persisted.length > before, 'shutdown must flush key state');
  return Object.fromEntries(gateway.persisted.at(-1).keys.map((k) => [k.key, { fail: k.usage.fail, success: k.usage.success, backedOff: k.backoffUntil > 0 }]));
}
const SERVED = { fail: 0, success: 1, backedOff: false };
// Committed-body break: same accounting as a committed OpenAI stream break
// (upstream_stream_error -> usage.fail, no backoff: the key did answer).
const BROKEN_COMMITTED = { fail: 1, success: 0, backedOff: false };

async function scenario(handler, run, env) {
  const upstream = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url !== '/v1/chat/completions') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      req.resume();
      req.once('end', () => handler(req, res));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  let gateway;
  try {
    gateway = await startGateway(upstream.address().port, { keys: KEYS, env });
    await run(gateway);
  } finally {
    await stopGateway(gateway?.child);
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

const cutAfterPart = (headers) => (_req, res) => {
  res.writeHead(200, headers);
  res.write(PART1);
  setTimeout(() => res.socket.destroy(), 80);
};

async function assertNoLeak(gateway) {
  await sleep(1_100);
  assert.equal(fs.readFileSync(gateway.logPath, 'utf8').includes(SENTINEL), false, 'gateway log file');
  const recent = await request(gateway.port + 1, 'GET', '/admin/logs', { token: ADMIN_TOKEN });
  assert.equal(recent.statusCode, 200);
  assert.equal(recent.body.includes(SENTINEL), false, 'getRecentLogs()');
}

test('(a) chunked body cut mid-JSON -> client sees a transport abort, never a clean end', { timeout: 30_000 }, async () => {
  await scenario(cutAfterPart({ 'content-type': 'application/json' }), async (gateway) => {
    const answer = await request(gateway.port, 'POST', '/v1/chat/completions', { body: BODY });
    assert.equal(answer.statusCode, 200, 'status line was committed before the body');
    assert.notEqual(answer.terminal, 'ended', `terminal=${answer.terminal} complete=${answer.complete}`);
    assert.ok(['aborted', 'error'].includes(answer.terminal), `terminal=${answer.terminal}`);
    assert.equal(answer.complete, false, 'truncated body must not be complete');
    assert.equal(answer.body, PART1, 'already-forwarded bytes are kept');
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['upstream_stream_error']);
    assert.equal(penalties(entries), 0);
    await assertNoLeak(gateway);
    assert.deepEqual((await flushedAccounting(gateway))['fake-key-a'], BROKEN_COMMITTED);
  });
});

test('(b) content-length body cut mid-JSON -> client sees an abort (pinned)', { timeout: 30_000 }, async () => {
  await scenario(cutAfterPart({ 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(FULL)) }), async (gateway) => {
    const answer = await request(gateway.port, 'POST', '/v1/chat/completions', { body: BODY });
    assert.equal(answer.statusCode, 200);
    assert.ok(['aborted', 'error'].includes(answer.terminal), `terminal=${answer.terminal}`);
    assert.equal(answer.complete, false);
    assert.equal(answer.body, PART1);
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['upstream_stream_error']);
    assert.equal(penalties(entries), 0);
    assert.deepEqual((await flushedAccounting(gateway))['fake-key-a'], BROKEN_COMMITTED);
  });
});

test('(c) control: full chunked body -> 200, full body, clean end, completed', { timeout: 30_000 }, async () => {
  await scenario((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(PART1);
    setTimeout(() => res.end(PART2), 40);
  }, async (gateway) => {
    const answer = await request(gateway.port, 'POST', '/v1/chat/completions', { body: BODY });
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended');
    assert.equal(answer.complete, true);
    assert.equal(answer.body, FULL);
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['completed']);
    assert.deepEqual((await flushedAccounting(gateway))['fake-key-a'], SERVED);
  });
});

test('(d) control: full content-length body -> normal clean end', { timeout: 30_000 }, async () => {
  await scenario((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(FULL)) });
    res.end(FULL);
  }, async (gateway) => {
    const answer = await request(gateway.port, 'POST', '/v1/chat/completions', { body: BODY });
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended');
    assert.equal(answer.complete, true);
    assert.equal(answer.body, FULL);
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['completed']);
    assert.deepEqual((await flushedAccounting(gateway))['fake-key-a'], SERVED);
  });
});

test('(e) upstream error before headers -> honest error status, no false 200', { timeout: 30_000 }, async () => {
  await scenario((req) => { req.socket.destroy(); }, async (gateway) => {
    const answer = await request(gateway.port, 'POST', '/v1/chat/completions', { body: BODY });
    assert.notEqual(answer.statusCode, 200);
    assert.ok(answer.statusCode >= 500 && answer.statusCode <= 504, `status ${answer.statusCode}`);
    assert.equal(answer.terminal, 'ended');
    const entries = await logs(gateway.logPath);
    assert.equal(outcomesOf(entries).includes('completed'), false);
  });
});

// ---- handler pinning (seam: fake upstreamRes with exactly ONE terminal event) ----
const CLIENT_GONE = 'Client disconnected during upstream transfer';
const clientGoneWarnings = (entries) => entries.filter((e) => e.message === CLIENT_GONE).length;
const neverCalled = () => { throw new Error('seam mode must not reach the local upstream'); };

for (const mode of ['close-only', 'error-only']) {
  test(`(f) seam ${mode}: committed 200 + partial body -> abort, upstream_stream_error, no false client-gone log`, { timeout: 30_000 }, async () => {
    await scenario(neverCalled, async (gateway) => {
      const answer = await request(gateway.port, 'POST', '/v1/chat/completions', { body: BODY });
      assert.equal(answer.statusCode, 200);
      assert.ok(['aborted', 'error'].includes(answer.terminal), `terminal=${answer.terminal} complete=${answer.complete}`);
      assert.equal(answer.complete, false);
      assert.equal(answer.body, PART1);
      const entries = await logs(gateway.logPath);
      assert.deepEqual(outcomesOf(entries), ['upstream_stream_error']);
      assert.equal(clientGoneWarnings(entries), 0, 'gateway-initiated abort must not log a client disconnect');
      assert.deepEqual((await flushedAccounting(gateway))['fake-key-a'], BROKEN_COMMITTED);
    }, { GATEWAY_TEST_NST_MODE: mode, GATEWAY_TEST_NST_PARTIAL: PART1 });
  });
}

test('(g) L2: real truncation does not log a client disconnect', { timeout: 30_000 }, async () => {
  await scenario(cutAfterPart({ 'content-type': 'application/json' }), async (gateway) => {
    const answer = await request(gateway.port, 'POST', '/v1/chat/completions', { body: BODY });
    assert.ok(['aborted', 'error'].includes(answer.terminal), `terminal=${answer.terminal}`);
    const entries = await logs(gateway.logPath);
    assert.equal(clientGoneWarnings(entries), 0);
  });
});

test('(h) L2 control: a real client abort still logs the disconnect and is not charged', { timeout: 30_000 }, async () => {
  await scenario((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(PART1); // then hold the body open until the client leaves
  }, async (gateway) => {
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: gateway.port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(BODY) } }, (response) => {
        response.once('data', () => { req.destroy(); resolve(); });
        response.on('error', () => {});
      });
      req.on('error', () => {});
      req.setTimeout(10_000, () => reject(new Error('no first body byte')));
      req.end(BODY);
    });
    await sleep(300);
    const entries = await logs(gateway.logPath);
    assert.equal(clientGoneWarnings(entries), 1);
    assert.deepEqual(outcomesOf(entries), ['client_aborted']);
    assert.deepEqual((await flushedAccounting(gateway))['fake-key-a'], { fail: 0, success: 0, backedOff: false });
  });
});

test.after(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); });
