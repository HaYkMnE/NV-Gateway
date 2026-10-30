// Э4-H pre-pulse: an upstream SSE error before commit must never become a
// client-visible 200 on the OpenAI route (spec Э1-Э4 :64, plan level-1 :51).
// Harness mirrors tests/e3-truth.test.mjs (per-harness token, reserved port,
// local fake upstream, fake keys only).
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
const serverPath = path.join(projectRoot, 'src', 'gateway', 'server.mjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-e4pp-${process.pid}-`));
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

const TOKEN = `test-gateway-${randomUUID()}`;
const KEYS = ['fake-key-a', 'fake-key-b'];
const OPENAI_SSE = '{"stream":true}';
const SENTINEL = 'E4PP-SENTINEL-9c3a-do-not-leak';
const CONTENT = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
const DONE = 'data: [DONE]\n\n';
const GOOD = CONTENT + DONE;
const BENIGN = ': keepalive\n\ndata: {"choices":[{"delta":{"content":""}}]}\n\n';
const ROLE = 'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n'; // role-only delta is MEANINGFUL today (commits)
const NAMED_ERROR = `event: error\ndata: {"error":{"message":"${SENTINEL}","type":"server_error"}}\n\n`;
const INBAND_ERROR = `data: {"error":{"message":"${SENTINEL}","type":"server_error"}}\n\n`;
const NAMED_NONJSON = `event: error\ndata: ${SENTINEL} upstream exploded\n\n`;
const PING = ': ping\n\n';
const OOPS = 'event: error\ndata: oops\n\n';
const ADMIN_TOKEN = 'test-admin-token';

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
        resolve({ statusCode: response.statusCode, body: text, terminal });
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

async function startGateway(upstreamPort, keys) {
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
        const child = spawnChild(process.execPath, ['--require', preloadPath, serverPath], {
          env: {
            ...process.env,
            PORT: String(port),
            GATEWAY_LOG_PATH: logPath,
            GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstreamPort),
            GATEWAY_FIRST_BYTE_TIMEOUT_MS: '2000',
            GATEWAY_IDLE_TIMEOUT_MS: '2000',
            GATEWAY_REQUEST_DEADLINE_MS: '60000'
          },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          windowsHide: true
        });
        const detachCollisionWatch = killOnBindCollision(child);
        child.once('message', (message) => {
          if (message?.type === 'ready') child.send({ type: 'state:init', challenge: message.challenge, state: { keys: state.keys, credentials: { gatewayToken: TOKEN, adminToken: 'test-admin-token' } } });
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
    try { if ((await request(port, 'GET', '/health', { timeoutMs: 1_000 })).statusCode === 200) return { child, port, logPath: current.logPath, persisted: current.persisted }; } catch { /* not yet */ }
    await sleep(25);
  }
  await stopGateway(child);
  throw new Error('gateway did not become healthy');
}

async function rawLog(logPath) {
  await sleep(1_100); // logger flush interval
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}
const outcomesOf = (text) => text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.message === 'request_outcome').map((e) => e.outcome);

async function flushedAccounting(gateway) {
  const before = gateway.persisted.length;
  await stopGateway(gateway.child);
  for (let waited = 0; gateway.persisted.length === before && waited < 1_000; waited += 25) await sleep(25);
  assert.ok(gateway.persisted.length > before, 'shutdown must flush key state');
  return Object.fromEntries(gateway.persisted.at(-1).keys.map((k) => [k.key, { fail: k.usage.fail, success: k.usage.success, backedOff: k.backoffUntil > 0 }]));
}
const SERVED = { fail: 0, success: 1, backedOff: false };
const FAILED_5XX = { fail: 1, success: 0, backedOff: true };

// Upstream writes each chunk, flushes, waits `gapMs` (the barrier), then the next.
const sse = (chunks, gapMs = 30) => (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let index = 0;
  const next = () => {
    if (index === chunks.length - 1) { res.end(chunks[index]); return; }
    res.write(chunks[index++]);
    setTimeout(next, gapMs);
  };
  next();
};

async function scenario(handlerFor, keys, run) {
  const seen = [];
  const upstream = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url !== '/v1/chat/completions') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      const auth = String(req.headers.authorization);
      seen.push(auth);
      handlerFor(keys.find((k) => auth.includes(k)))(req, res);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  let gateway;
  try {
    gateway = await startGateway(upstream.address().port, keys);
    await run(gateway, seen);
  } finally {
    await stopGateway(gateway?.child);
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

// ---- Cases 1-4: pre-commit error -> failover, never a false 200 -----------
const PRECOMMIT_CASES = [
  ['1 named event:error first frame', [NAMED_ERROR]],
  ['2 benign + named event:error in the SAME chunk', [BENIGN + NAMED_ERROR]],
  ['3b named event:error with NON-JSON data, first frame', [NAMED_NONJSON]],
  ['3c same-chunk split `: ping` + `event: error` / `data: oops`', [PING + OOPS]],
  ['4a in-band data:{"error"} first frame', [INBAND_ERROR]],
  ['4b benign + in-band data:{"error"} in the SAME chunk', [BENIGN + INBAND_ERROR]]
];

// Sentinel must not reach the gateway log file nor /admin/logs (admin port = P+1).
async function assertNoLeak(gateway) {
  const log = await rawLog(gateway.logPath);
  assert.ok(!log.includes(SENTINEL), 'upstream error text must not reach the gateway log');
  const recent = await request(gateway.port + 1, 'GET', '/admin/logs', { token: ADMIN_TOKEN });
  assert.equal(recent.statusCode, 200);
  assert.ok(!recent.body.includes(SENTINEL), 'upstream error text must not reach /admin/logs');
  return log;
}

for (const [label, badChunks, gapMs] of PRECOMMIT_CASES) {
  test(`Э4-H case ${label}: fails over to key B, client sees only B's stream`, { timeout: 30_000 }, async () => {
    await scenario((key) => (key === KEYS[0] ? sse(badChunks, gapMs) : sse([CONTENT, DONE])), KEYS, async (gateway, seen) => {
      const answer = await request(gateway.port, 'POST', '/v1/chat/completions', { body: OPENAI_SSE });
      assert.equal(answer.statusCode, 200);
      assert.equal(answer.body, GOOD, 'no bytes of the failed attempt may reach the client');
      assert.equal(seen.length, 2, 'exactly one failover');
      const log = await assertNoLeak(gateway);
      assert.deepEqual(outcomesOf(log), ['upstream_sse_error', 'completed']);
      assert.deepEqual(await flushedAccounting(gateway), { [KEYS[0]]: FAILED_5XX, [KEYS[1]]: SERVED });
    });
  });

  test(`Э4-H case ${label}, single key: honest non-200, no leak`, { timeout: 30_000 }, async () => {
    await scenario(() => sse(badChunks, gapMs), KEYS.slice(0, 1), async (gateway) => {
      const answer = await request(gateway.port, 'POST', '/v1/chat/completions', { body: OPENAI_SSE });
      assert.notEqual(answer.statusCode, 200, 'a pre-commit upstream error must not become a 200');
      assert.ok(!answer.body.includes(SENTINEL), 'upstream error text must not reach the client');
      await assertNoLeak(gateway);
      assert.deepEqual(await flushedAccounting(gateway), { [KEYS[0]]: { ...FAILED_5XX, fail: 3 } }); // existing loop re-tries the lone key
    });
  });
}

// ---- Cases 3/4c/3b/3d: error AFTER a benign-only release (option b) ---------
// The benign chunk is already on the wire as a 200 (Round C1/C2 stays), so no
// failover is possible (plan :29). The error frame must NOT be forwarded; the
// client connection is aborted (no clean EOF, no [DONE]) and the key is charged
// like the pre-commit upstream_sse_error.
const RELEASED_CASES = [
  ['3 benign chunk, then named event:error (JSON) in the NEXT chunk', [BENIGN, NAMED_ERROR]],
  ['4c benign chunk, then in-band data:{"error"} in the NEXT chunk', [BENIGN, INBAND_ERROR]],
  ['3b benign chunk, then named event:error with NON-JSON data', [BENIGN, NAMED_NONJSON]],
  ['3d next-chunk split `: ping`, then `event: error` / `data: oops`', [PING, OOPS]]
];

for (const [label, chunks] of RELEASED_CASES) {
  test(`Э4-H case ${label}: 200 + benign bytes, then abort; key charged; no failover, no leak`, { timeout: 30_000 }, async () => {
    await scenario(() => sse(chunks, 300), KEYS, async (gateway, seen) => {
      const answer = await request(gateway.port, 'POST', '/v1/chat/completions', { body: OPENAI_SSE });
      assert.equal(answer.statusCode, 200, 'the benign prelude was already released');
      assert.equal(answer.body, chunks[0], 'only the benign bytes reach the client');
      assert.ok(answer.terminal === 'aborted' || answer.terminal === 'error', `transport abort expected, got ${answer.terminal}`);
      assert.ok(!answer.body.includes('[DONE]') && !answer.body.includes('"error"') && !answer.body.includes(SENTINEL));
      assert.equal(seen.length, 1, 'no failover after write');
      const log = await assertNoLeak(gateway);
      assert.deepEqual(outcomesOf(log), ['upstream_sse_error']);
      assert.deepEqual(await flushedAccounting(gateway), { [KEYS[0]]: FAILED_5XX, [KEYS[1]]: { fail: 0, success: 0, backedOff: false } });
    });
  });
}

// ---- Case 5: error AFTER committed content (Э2 / 5a) - pin ------------------
test('Э4-H case 5: content committed, then event:error -> single attempt, 200 already out, no [DONE] invented', { timeout: 30_000 }, async () => {
  await scenario(() => sse([CONTENT, NAMED_ERROR]), KEYS, async (gateway, seen) => {
    const answer = await request(gateway.port, 'POST', '/v1/chat/completions', { body: OPENAI_SSE });
    assert.equal(answer.statusCode, 200);
    assert.ok(answer.body.startsWith(CONTENT));
    assert.ok(!answer.body.includes('[DONE]'));
    assert.equal(seen.length, 1, 'a committed stream is never retried');
  });
});

// ---- Case 6: controls -------------------------------------------------------
for (const [label, chunks] of [
  ['event:message content', ['event: message\n' + CONTENT, DONE]],
  ['benign prelude then content (same chunk)', [BENIGN + CONTENT, DONE]],
  ['benign prelude chunk then content chunk', [BENIGN, CONTENT, DONE]]
]) {
  test(`Э4-H case 6 control: ${label} -> byte-exact 200, completed`, { timeout: 30_000 }, async () => {
    await scenario(() => sse(chunks), KEYS.slice(0, 1), async (gateway) => {
      const answer = await request(gateway.port, 'POST', '/v1/chat/completions', { body: OPENAI_SSE });
      assert.equal(answer.statusCode, 200);
      assert.equal(answer.terminal, 'ended');
      assert.equal(answer.body, chunks.join(''));
      assert.deepEqual(outcomesOf(await rawLog(gateway.logPath)), ['completed']);
      assert.deepEqual(await flushedAccounting(gateway), { [KEYS[0]]: SERVED });
    });
  });
}

test('E4-H role-only delta + event:error same chunk: role commits, single attempt (pin today)', { timeout: 30_000 }, async () => {
  await scenario(() => sse([ROLE + NAMED_ERROR]), KEYS, async (gateway, seen) => {
    const answer = await request(gateway.port, 'POST', '/v1/chat/completions', { body: OPENAI_SSE });
    assert.equal(answer.statusCode, 200);
    assert.ok(answer.body.startsWith(ROLE));
    assert.equal(seen.length, 1);
  });
});
