// Э2 owner decision 1a (27.09): when every distinct eligible key goes silent
// BEFORE the answer is committed (pre-commit socket idle, spec "I"), the request
// makes ONE pass over the distinct keys and then answers the neutral 503
// (spec :41) instead of repeating keys up to the attempt floor and falling to
// the generic 502. Idle never penalizes a key (§12.10 Р1). If the request
// deadline cuts the pass first, the Э1 504 request_deadline answer stays.
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
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-e2r-${process.pid}-`));
// Unique per test process so a foreign gateway on a raced port never shares our token.
const TOKEN = `test-gateway-${randomUUID()}`;
const NEUTRAL_BODY = '{"error":"Upstream temporarily unavailable"}';
const ANTHROPIC_NEUTRAL = { type: 'error', error: { type: 'api_error', message: 'Upstream temporarily unavailable' } };
const DEADLINE_BODY = '{"error":"Gateway request deadline exceeded"}';
const PARTIAL_SSE = 'data: {"choices":[{"delta":{"content":"unfinished';
const FULL_SSE = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
const OPENAI_SSE = '{"stream":true}';
const ANTHROPIC_SSE = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10, stream: true });
const ALL_KEYS = ['fake-key-a', 'fake-key-b', 'fake-key-c'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gone = (c) => c.exitCode !== null || c.signalCode !== null;

function health(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/health' }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.setTimeout(1_000, () => request.destroy(new Error('health timeout')));
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

async function startGateway(upstreamPort, { keys, firstByteMs = 2_000, idleMs = 150, deadlineMs = 60_000, maxAttempts }) {
  const startBy = Date.now() + 12_000;
  // Shared reserved-port start: readiness is THIS child's ports:bound for the
  // reserved pair; a bind collision (stderr marker) retries a fresh pair at once.
  let current;
  let started;
  try {
    started = await startGatewayOnReservedPort({
      maxAttempts: GATEWAY_START_MAX_ATTEMPTS,
      reservationOptions: highPortReservation(),
      readinessTimeoutMs: Math.max(1, startBy - Date.now()),
      spawnChild(port, attempt) {
    // Total budget check per attempt: a non-collision error ends the helper's loop.
    if (Date.now() >= startBy) throw new Error(`gateway start budget exhausted after attempt ${attempt - 1}`);
    const dir = fs.mkdtempSync(path.join(tempRoot, `gw-${port}-${attempt}-`));
    const statePath = path.join(dir, 'keys.json');
    const logPath = path.join(dir, 'gateway.jsonl');
    const state = { keys: keys.map((key, index) => ({ id: `test-key-${index}`, key, status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: index } })) };
    fs.writeFileSync(statePath, JSON.stringify(state));
    const child = spawnChild(process.execPath, ['--require', preloadPath, serverPath], {
      env: {
        ...process.env,
        PORT: String(port),
        GATEWAY_LOG_PATH: logPath,
        GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstreamPort),
        GATEWAY_FIRST_BYTE_TIMEOUT_MS: String(firstByteMs),
        GATEWAY_IDLE_TIMEOUT_MS: String(idleMs),
        GATEWAY_REQUEST_DEADLINE_MS: String(deadlineMs),
        ...(maxAttempts === undefined ? {} : { GATEWAY_MAX_FAILOVER_ATTEMPTS: String(maxAttempts) })
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true
    });
    const detachCollisionWatch = killOnBindCollision(child);
    child.once('message', (message) => {
      if (message?.type === 'ready') child.send({ type: 'state:init', challenge: message.challenge, state: { keys: state.keys, credentials: { gatewayToken: TOKEN, adminToken: 'test-admin-token' } } });
    });
    const persisted = [];
    child.on('message', (message) => {
      if (message?.type !== 'state:persist') return;
      persisted.push(message.state);
      fs.writeFileSync(statePath, JSON.stringify(message.state));
    });
    current = { child, detachCollisionWatch, logPath, statePath, persisted };
    return child;
      }
    });
  } catch (error) {
    if (current) await stopGateway(current.child);
    throw new Error('gateway did not become healthy', { cause: error });
  }
  const { child, port } = started;
  current.detachCollisionWatch(); // started.child is the last spawned child
  // ports:bound is attested; /health confirms the listener answers, within the total budget.
  while (Date.now() < startBy && !gone(child)) {
    try { if (await health(port) === 200) return { child, port, logPath: current.logPath, statePath: current.statePath, persisted: current.persisted }; } catch { /* starting */ }
    await sleep(25);
  }
  await stopGateway(child);
  throw new Error('gateway did not become healthy');
}

// Key usage persists on a debounce or on the shutdown flush: stop, require the
// flush, then read the flushed key state.
async function flushedKeys(gateway) {
  const before = gateway.persisted.length;
  await stopGateway(gateway.child);
  for (let waited = 0; gateway.persisted.length === before && waited < 1_000; waited += 25) await sleep(25);
  assert.ok(gateway.persisted.length > before, 'shutdown must flush key state');
  return gateway.persisted.at(-1).keys;
}

// Pins per-key accounting after the shutdown flush. backoffUntil is a wall-clock
// deadline, so it is pinned as "backed off or not" (backoffUntil > 0).
async function assertAccounting(gateway, expected) {
  const flushed = await flushedKeys(gateway);
  assert.equal(flushed.length, Object.keys(expected).length, 'every configured key is in the flushed state');
  const actual = Object.fromEntries(flushed.map((key) => [key.key, { fail: key.usage.fail, success: key.usage.success, backedOff: key.backoffUntil > 0 }]));
  assert.deepEqual(actual, expected, 'per-key accounting');
}
const IDLE = { fail: 0, success: 0, backedOff: false };
const FAILED_5XX = { fail: 1, success: 0, backedOff: true }; // handleKeyError(>=500): fail 1 + 10 s backoff
const SERVED = { fail: 0, success: 1, backedOff: false };

function post(port, pathname, body, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: {
      authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body)
    } }, (response) => {
      let text = '';
      let settled = false;
      const finish = (terminal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ statusCode: response.statusCode, body: text, terminal, retryAfter: response.headers['retry-after'] });
      };
      const timer = setTimeout(() => { response.destroy(); finish('timed-out'); }, timeoutMs);
      response.on('data', (chunk) => { text += chunk; });
      response.once('end', () => finish('ended'));
      response.once('aborted', () => finish('aborted'));
      response.once('error', () => finish('error'));
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function logs(logPath) {
  await sleep(1_100); // logger flush interval
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
const outcomesOf = (entries) => entries.filter((entry) => entry.message === 'request_outcome').map((entry) => entry.outcome);
const verdictOf = (entries) => entries.find((entry) => entry.message === 'All failover attempts exhausted');

async function scenario(handler, options, run) {
  const seen = [];
  const upstream = await new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      if (request.url !== '/v1/chat/completions') { response.end('{"data":[]}'); return; }
      seen.push(request.headers.authorization);
      handler(request, response, seen.length);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  let gateway;
  try {
    gateway = await startGateway(upstream.address().port, options);
    await run(gateway, seen);
  } finally {
    await stopGateway(gateway?.child);
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

const partialThenSilence = (_request, response) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(PARTIAL_SSE); // then silence: the attempt ends by pre-commit idle_timeout
};

for (const n of [1, 2, 3]) {
  test(`Э2 1a: ${n} key(s) all idle pre-commit -> exactly ${n} attempt(s), one per distinct key, neutral 503, no key penalty`, { timeout: 30_000 }, async () => {
    const keys = ALL_KEYS.slice(0, n);
    await scenario(partialThenSilence, { keys }, async (gateway, seen) => {
      const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
      assert.equal(answer.statusCode, 503);
      assert.equal(answer.body, NEUTRAL_BODY);
      assert.equal(answer.terminal, 'ended');
      assert.ok(Number(answer.retryAfter) >= 1, 'Retry-After present');
      assert.equal(seen.length, n, `exactly one attempt per distinct key: ${seen.join(',')}`);
      assert.deepEqual([...seen].sort(), keys.map((key) => `Bearer ${key}`).sort(), 'every distinct key once');
      const entries = await logs(gateway.logPath);
      assert.deepEqual(outcomesOf(entries), Array(n).fill('idle_timeout'));
      assert.equal(entries.filter((entry) => entry.message === 'Upstream error, backing off').length, 0, 'Р1: idle does not penalize');
      const verdict = verdictOf(entries);
      assert.equal(verdict?.attempts, n);
      assert.equal(verdict?.earlyStopReason, 'idle_round');
      assert.equal(verdict?.coverage, true, 'the distinct circle finished');
      assert.equal(verdict?.poolWide, false, 'an idle round is never a uniform upstream verdict');
      const flushed = await flushedKeys(gateway);
      assert.equal(flushed.length, n, 'every configured key is in the flushed state');
      for (const key of flushed) {
        assert.equal(key.usage.fail, 0, `${key.key}: idle must not count a failure`);
        assert.equal(key.backoffUntil, 0, `${key.key}: idle must not back the key off`);
        assert.equal(key.status, 'active');
      }
    });
  });
}

test('Э2 1a: Anthropic /v1/messages, 2 keys all idle pre-commit -> 2 attempts, neutral Anthropic 503', { timeout: 30_000 }, async () => {
  await scenario(partialThenSilence, { keys: ALL_KEYS.slice(0, 2) }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_SSE);
    assert.equal(answer.statusCode, 503);
    assert.deepEqual(JSON.parse(answer.body), ANTHROPIC_NEUTRAL);
    assert.equal(answer.terminal, 'ended');
    assert.equal(seen.length, 2);
    assert.deepEqual(outcomesOf(await logs(gateway.logPath)), ['idle_timeout', 'idle_timeout']);
    await assertAccounting(gateway, { 'fake-key-a': IDLE, 'fake-key-b': IDLE });
  });
});

test('Э2 1a: mixed, key A idle + key B real HTTP 503 -> existing pool verdict unchanged (2 attempts, real 503, partial wording)', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    if (request.headers.authorization === 'Bearer fake-key-a') { partialThenSilence(request, response); return; }
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end('{"error":"busy"}');
  }, { keys: ALL_KEYS.slice(0, 2) }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    assert.equal(answer.statusCode, 503);
    assert.equal(answer.body, '{"error":"Upstream returned HTTP 503; some keys could not be reached or did not answer."}');
    assert.equal(seen.length, 2);
    const verdict = verdictOf(await logs(gateway.logPath));
    assert.equal(verdict?.earlyStopReason, undefined, 'not an idle round: B answered a real status');
    assert.equal(verdict?.upstreamStatus, 503);
    await assertAccounting(gateway, { 'fake-key-a': IDLE, 'fake-key-b': FAILED_5XX });
  });
});

test('Э2 1a: key A idle, key B succeeds -> success (regression guard)', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    if (request.headers.authorization === 'Bearer fake-key-a') { partialThenSilence(request, response); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(FULL_SSE);
  }, { keys: ALL_KEYS.slice(0, 2) }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended');
    assert.match(answer.body, /data: \[DONE\]/);
    assert.equal(outcomesOf(await logs(gateway.logPath)).at(-1), 'completed');
    assert.deepEqual(seen, ['Bearer fake-key-a', 'Bearer fake-key-b'], 'exactly 2 attempts: A (idle) then B');
    await assertAccounting(gateway, { 'fake-key-a': IDLE, 'fake-key-b': SERVED });
  });
});

test('Э2 1a: deadline shorter than n x idle -> Э1 504 request_deadline stays, coverage false', { timeout: 30_000 }, async () => {
  await scenario(partialThenSilence, { keys: ALL_KEYS, idleMs: 300, deadlineMs: 750 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    assert.deepEqual({ statusCode: answer.statusCode, body: answer.body, terminal: answer.terminal }, { statusCode: 504, body: DEADLINE_BODY, terminal: 'ended' });
    assert.ok(seen.length >= 1 && seen.length <= 3, `no key repeated: ${seen.length}`);
    assert.equal(seen.length, 3, `idle 300 ms x2 then the 750 ms deadline cuts the 3rd: ${seen.join(',')}`);
    assert.equal(new Set(seen).size, seen.length, 'no key repeated');
    const entries = await logs(gateway.logPath);
    assert.equal(outcomesOf(entries).at(-1), 'request_deadline');
    const verdict = verdictOf(entries);
    assert.equal(verdict?.earlyStopReason, 'request_deadline');
    assert.equal(verdict?.coverage, false);
    await assertAccounting(gateway, { 'fake-key-a': IDLE, 'fake-key-b': IDLE, 'fake-key-c': IDLE });
  });
});

// ---- first-byte timeout joins the silent round (orchestrator decision on 1a) ----
// Upstream sends nothing, not even headers: the attempt ends by the first-byte
// timeout. Key accounting stays as before (first-byte: one key failure each).
const silentNoHeaders = () => { /* never answers */ };

async function assertFailCounts(gateway, expected) {
  const flushed = await flushedKeys(gateway);
  const byKey = Object.fromEntries(flushed.map((key) => [key.key, key.usage.fail]));
  assert.deepEqual(byKey, expected, 'per-key failure accounting unchanged');
}

test('Э2 1a: 2 keys, both first-byte timeout -> 2 attempts, neutral 503, first-byte accounting unchanged', { timeout: 30_000 }, async () => {
  await scenario(silentNoHeaders, { keys: ALL_KEYS.slice(0, 2), firstByteMs: 150 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    assert.deepEqual({ statusCode: answer.statusCode, body: answer.body, terminal: answer.terminal }, { statusCode: 503, body: NEUTRAL_BODY, terminal: 'ended' });
    assert.equal(seen.length, 2, `one attempt per distinct key: ${seen.join(',')}`);
    assert.deepEqual([...seen].sort(), ['Bearer fake-key-a', 'Bearer fake-key-b']);
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['first_byte_timeout', 'first_byte_timeout']);
    assert.equal(entries.filter((entry) => entry.message === 'Upstream first-byte timeout').length, 2);
    const verdict = verdictOf(entries);
    assert.equal(verdict?.earlyStopReason, 'idle_round');
    assert.equal(verdict?.coverage, true);
    assert.equal(verdict?.poolWide, false);
    await assertFailCounts(gateway, { 'fake-key-a': 1, 'fake-key-b': 1 });
  });
});

test('Э2 1a: mixed, A first-byte timeout + B pre-commit idle -> 2 attempts, neutral 503, A fail=1, B fail=0', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    if (request.headers.authorization === 'Bearer fake-key-a') return; // no headers
    partialThenSilence(request, response);
  }, { keys: ALL_KEYS.slice(0, 2), firstByteMs: 150 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    assert.deepEqual({ statusCode: answer.statusCode, body: answer.body, terminal: answer.terminal }, { statusCode: 503, body: NEUTRAL_BODY, terminal: 'ended' });
    assert.equal(seen.length, 2);
    const entries = await logs(gateway.logPath);
    assert.deepEqual([...outcomesOf(entries)].sort(), ['first_byte_timeout', 'idle_timeout']);
    assert.equal(verdictOf(entries)?.earlyStopReason, 'idle_round');
    await assertFailCounts(gateway, { 'fake-key-a': 1, 'fake-key-b': 0 });
  });
});

test('Э2 1a: A first-byte timeout, B succeeds -> success (regression guard)', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    if (request.headers.authorization === 'Bearer fake-key-a') return; // no headers
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(FULL_SSE);
  }, { keys: ALL_KEYS.slice(0, 2), firstByteMs: 150 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended');
    assert.match(answer.body, /data: \[DONE\]/);
    assert.equal(seen.length, 2);
    assert.equal(outcomesOf(await logs(gateway.logPath)).at(-1), 'completed');
    await assertAccounting(gateway, { 'fake-key-a': FAILED_5XX, 'fake-key-b': SERVED });
  });
});

// resolveMaxFailoverAttempts raises a budget below the eligible count to that
// count (failover-policy.mjs coverage floor), so min(maxAttempts, eligible) is
// the whole eligible set: the round still covers all 3 keys, once each.
test('Э2 1a: 3 keys, GATEWAY_MAX_FAILOVER_ATTEMPTS=2 -> round still covers 3 distinct keys once, neutral 503', { timeout: 30_000 }, async () => {
  await scenario(partialThenSilence, { keys: ALL_KEYS, maxAttempts: 2 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    assert.deepEqual({ statusCode: answer.statusCode, body: answer.body }, { statusCode: 503, body: NEUTRAL_BODY });
    assert.deepEqual([...seen].sort(), ALL_KEYS.map((key) => `Bearer ${key}`), 'each distinct key exactly once');
    const verdict = verdictOf(await logs(gateway.logPath));
    assert.equal(verdict?.attempts, 3);
    assert.equal(verdict?.coverage, true);
    assert.equal(verdict?.earlyStopReason, 'idle_round');
    await assertAccounting(gateway, { 'fake-key-a': IDLE, 'fake-key-b': IDLE, 'fake-key-c': IDLE });
  });
});

// Audit finding: a network-type failure (upstream socket destroyed) belongs to
// Э3 and must keep its pre-1a result. Pass 1 is mixed; the failed key backs off,
// so pass 2 holds only the silent key — that must NOT turn into the idle-round
// 503. Pinned to the pre-1a result (verified with the idleRound stop disabled).
test('Э2 1a: silent key + network-failure key -> unchanged pre-1a result (no idle_round)', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    if (request.headers.authorization === 'Bearer fake-key-a') { partialThenSilence(request, response); return; }
    request.socket.destroy(); // key B: connection dropped, no HTTP answer
  }, { keys: ALL_KEYS.slice(0, 2) }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    assert.notEqual(answer.body, NEUTRAL_BODY, 'not the idle-round neutral 503');
    assert.deepEqual({ statusCode: answer.statusCode, body: answer.body, terminal: answer.terminal }, { statusCode: 502, body: '{"error":"All failover attempts exhausted","detail":"2 keys tried (3 attempts): 2 did not answer in time, 1 dropped the connection."}', terminal: 'ended' });
    assert.equal(seen.length, 3, `pre-1a attempt count: ${seen.join(',')}`);
    const verdict = verdictOf(await logs(gateway.logPath));
    assert.notEqual(verdict?.earlyStopReason, 'idle_round');
    assert.equal(verdict?.attempts, 3);
    await assertAccounting(gateway, { 'fake-key-a': IDLE, 'fake-key-b': FAILED_5XX });
  });
});

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
