// Э1a: one-shot PRE-COMMIT request deadline (plan §12.9.2, decisions Р1/Р5/Р6).
// Hermetic: local fake upstream on an ephemeral loopback port, fake keys only.
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
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-e1a-${process.pid}-`));
// Unique per test process so a foreign gateway on a raced port never shares our token.
const TOKEN = `test-gateway-${randomUUID()}`;
const DEADLINE_BODY = '{"error":"Gateway request deadline exceeded"}';
const ANTHROPIC_DEADLINE = { type: 'error', error: { type: 'request_timeout', message: 'Gateway request deadline exceeded' } };
const PARTIAL_SSE = 'data: {"choices":[{"delta":{"content":"unfinished';

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function upstreamServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function closeServer(server) {
  server?.closeAllConnections?.();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
}

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

// A child is gone once it exited normally (exitCode) or was killed by a signal
// (signalCode); exitCode alone stays null for a signal kill.
const gone = (c) => c.exitCode !== null || c.signalCode !== null;

// One total startup budget across all retries (default 12 s) so a slow startup
// fails with a labeled error well inside the per-test timeout instead of an
// unlabeled "test timed out" (3 attempts x 15 s poll could reach ~45 s).
async function startGateway(upstreamPort, { keys = ['fake-key-a'], firstByteMs = 1_000, idleMs = 1_000, deadlineMs, maxAttempts, startupDeadlineMs = 12_000 } = {}) {
  const startBy = Date.now() + startupDeadlineMs;
  // Why the last attempt failed: child exit status (captured before stopGateway, so
  // null means "still running, never healthy") and the last health-poll error.
  let lastExit = null;
  let lastError = null;
  const why = () => ` (exit=${lastExit}, lastError=${lastError?.message ?? 'none'})`;
  const stalled = (attempt) => new Error(`stalled at: gateway startup (attempt ${attempt}, >${startupDeadlineMs}ms)${why()}`);
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
    // Fresh unique dir per start: a reused port must never append to an earlier test's log.
    const dir = fs.mkdtempSync(path.join(tempRoot, `gw-${port}-${attempt}-`));
    const statePath = path.join(dir, 'keys.json');
    const logPath = path.join(dir, 'gateway.jsonl');
    assert.equal(fs.existsSync(logPath), false, 'fresh log dir');
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
        ...(deadlineMs === undefined ? {} : { GATEWAY_REQUEST_DEADLINE_MS: String(deadlineMs) }),
        ...(maxAttempts === undefined ? {} : { GATEWAY_MAX_FAILOVER_ATTEMPTS: String(maxAttempts) })
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true
    });
    const detachCollisionWatch = killOnBindCollision(child);
    child.once('message', (message) => {
      if (message?.type === 'ready') child.send({ type: 'state:init', challenge: message.challenge, state: { keys: state.keys, credentials: { gatewayToken: TOKEN, adminToken: 'test-admin-token' } } });
    });
    // Every state the child persists (debounced save or the shutdown flush), in order.
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
    lastExit = current ? current.child.exitCode ?? current.child.signalCode : null;
    lastError = error;
    if (current) await stopGateway(current.child);
    if (Date.now() >= startBy) throw stalled(GATEWAY_START_MAX_ATTEMPTS);
    throw new Error(`gateway did not become healthy${why()}`);
  }
  const { child, port } = started;
  current.detachCollisionWatch(); // started.child is the last spawned child
  // ports:bound is attested; /health confirms the listener answers, within the total budget.
  while (Date.now() < startBy && !gone(child)) {
    try { const status = await health(port); if (status === 200) return { child, port, logPath: current.logPath, statePath: current.statePath, persisted: current.persisted }; else lastError = new Error(`health ${status}`); } catch (error) { lastError = error; /* starting */ }
    await sleep(25);
  }
  lastExit = child.exitCode ?? child.signalCode;
  // Stop/kill the spawned child before failing, so none is left running.
  await stopGateway(child);
  if (Date.now() >= startBy) throw stalled(started.attempt);
  throw new Error(`gateway did not become healthy${why()}`);
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

// F4: key usage persists on a 5 s debounce (rotation.mjs markKeyUsedAndDebounceSave)
// or on the shutdown flush (server.mjs shutdown -> flushState). Reading the file
// right after the request sees the seed, so the old `usage.fail === 0` could never
// fail. Stop first, REQUIRE a new state:persist from the flush, then assert that
// no key carries a failure count, a backoff (handleKeyError) or a park.
async function assertNoKeyPenaltyAfterFlush(gateway, expectedKeys) {
  const before = gateway.persisted.length;
  await stopGateway(gateway.child);
  // IPC messages can trail the 'exit' event; give the flush a bounded window.
  for (let waited = 0; gateway.persisted.length === before && waited < 1_000; waited += 25) await sleep(25);
  assert.ok(gateway.persisted.length > before, 'shutdown must flush key state (no state:persist after stop)');
  const flushed = gateway.persisted.at(-1).keys;
  const onDisk = JSON.parse(fs.readFileSync(gateway.statePath, 'utf8')).keys;
  assert.deepEqual(onDisk, flushed, 'state file holds the flushed state');
  assert.deepEqual(flushed.map((key) => key.key).sort(), [...expectedKeys].sort(), 'every key is in the flushed state');
  for (const key of flushed) {
    assert.equal(key.usage.fail, 0, `${key.key}: the deadline must not count a failure`);
    assert.equal(key.backoffUntil, 0, `${key.key}: the deadline must not back the key off`);
    assert.equal(key.status, 'active', `${key.key}: the deadline must not park the key`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function post(port, pathname, body, timeoutMs = 2_000) {
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
        resolve({ statusCode: response.statusCode, body: text, terminal });
      };
      const timer = setTimeout(() => { response.destroy(); finish('timed-out'); }, timeoutMs);
      response.on('data', (chunk) => { text += chunk; });
      response.once('end', () => finish('ended'));
      response.once('aborted', () => finish('aborted'));
      response.once('error', () => finish('error'));
    });
    const headerTimer = setTimeout(() => { request.destroy(); reject(new Error('no response headers before client ceiling')); }, timeoutMs);
    request.once('response', () => clearTimeout(headerTimer));
    request.once('error', (error) => { clearTimeout(headerTimer); reject(error); });
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

const OPENAI_SSE = '{"stream":true}';
const OPENAI_JSON = '{"stream":false}';
const ANTHROPIC_SSE = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10, stream: true });
const ANTHROPIC_JSON = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10, stream: false });

// Runs one scenario and always tears the child and upstream down.
async function scenario(handler, options, run) {
  const seen = [];
  const upstream = await upstreamServer((request, response) => {
    if (request.url !== '/v1/chat/completions') { response.end('{"data":[]}'); return; }
    seen.push(request.headers.authorization);
    handler(request, response, seen.length);
  });
  let gateway;
  try {
    gateway = await startGateway(upstream.address().port, options);
    await run(gateway, seen);
  } finally {
    await stopGateway(gateway?.child);
    await closeServer(upstream);
  }
}

// ---- partial-then-silent before commit: the audit defect ----------------

// Owner decision 1a (27.09): was a 504 request_deadline after repeating the one
// key until D; now the single distinct pass (1 attempt) ends with the neutral 503.
test('Э1a audit repro: partial SSE, socket idle < deadline, one key: exactly one facade neutral 503, no stream error (decision 1a)', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(PARTIAL_SSE);
  }, { idleMs: 90, deadlineMs: 420, maxAttempts: 10 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE, 2_000);
    assert.deepEqual(answer, { statusCode: 503, body: '{"error":"Upstream temporarily unavailable"}', terminal: 'ended' });
    assert.equal(seen.length, 1, 'exactly one attempt: one distinct key, one pass');
    const entries = await logs(gateway.logPath);
    const outcomes = outcomesOf(entries);
    assert.equal(outcomes.includes('upstream_stream_error'), false, `no stream error outcome: ${outcomes}`);
    assert.equal(outcomes.includes('client_aborted'), false, `no false client abort: ${outcomes}`);
    assert.deepEqual(outcomes, ['idle_timeout']);
    assert.equal(entries.filter((entry) => entry.message === 'Upstream error, backing off').length, 0, 'Р1: idle does not penalize');
    assert.equal(verdictOf(entries)?.earlyStopReason, 'idle_round');
    assert.equal(verdictOf(entries)?.coverage, true, 'the only key answered (idle) before D: circle finished');
    await assertNoKeyPenaltyAfterFlush(gateway, ['fake-key-a']);
  });
});

for (const keyCount of [1, 2, 3]) {
  test(`Э1a: ${keyCount} key(s), partial SSE then silence past the deadline: 504, no further attempt, coverage=false`, { timeout: 30_000 }, async () => {
    const keys = ['fake-key-a', 'fake-key-b', 'fake-key-c'].slice(0, keyCount);
    await scenario((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(PARTIAL_SSE);
    }, { keys, idleMs: 1_000, deadlineMs: 300, maxAttempts: 10 }, async (gateway, seen) => {
      const startedAt = Date.now();
      const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE, 1_500);
      assert.deepEqual(answer, { statusCode: 504, body: DEADLINE_BODY, terminal: 'ended' });
      assert.ok(Date.now() - startedAt < 900, 'bounded by the deadline, not by idle');
      await sleep(200);
      assert.deepEqual(seen, ['Bearer fake-key-a'], 'no attempt after the deadline');
      const entries = await logs(gateway.logPath);
      assert.deepEqual(outcomesOf(entries), ['request_deadline']);
      const verdict = verdictOf(entries);
      assert.equal(verdict?.earlyStopReason, 'request_deadline');
      assert.equal(verdict?.coverage, false, 'the deadline cut the circle before every key answered');
      assert.equal(entries.filter((entry) => entry.message === 'Upstream error, backing off').length, 0, 'Р1: the deadline does not penalize');
      // F4: state persists on a 5 s debounce or on shutdown, so read it only
      // after the shutdown flush; a missing flush must fail, not pass vacuously.
      await assertNoKeyPenaltyAfterFlush(gateway, keys);
    });
  });
}

test('Э1a: OpenAI non-stream partial non-2xx body then silence before commit: 504', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.write('{"error":"unfinished');
  }, { keys: ['fake-key-a', 'fake-key-b'], idleMs: 1_000, deadlineMs: 300 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_JSON, 1_500);
    assert.deepEqual(answer, { statusCode: 504, body: DEADLINE_BODY, terminal: 'ended' });
    await sleep(200);
    assert.equal(seen.length, 1);
    assert.deepEqual(outcomesOf(await logs(gateway.logPath)), ['request_deadline']);
  });
});

test('Э1a: Anthropic SSE partial then silence before commit: facade 504', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(PARTIAL_SSE);
  }, { keys: ['fake-key-a', 'fake-key-b'], idleMs: 1_000, deadlineMs: 300 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_SSE, 1_500);
    assert.equal(answer.statusCode, 504);
    assert.equal(answer.terminal, 'ended');
    assert.deepEqual(JSON.parse(answer.body), ANTHROPIC_DEADLINE);
    await sleep(200);
    assert.equal(seen.length, 1);
    assert.deepEqual(outcomesOf(await logs(gateway.logPath)), ['request_deadline']);
  });
});

test('Э1a: Anthropic buffered partial JSON then silence before commit: facade 504', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"id":"chatcmpl-1","choices":[{"message":{"content":"unfin');
  }, { keys: ['fake-key-a', 'fake-key-b'], idleMs: 1_000, deadlineMs: 300 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_JSON, 1_500);
    assert.equal(answer.statusCode, 504);
    assert.equal(answer.terminal, 'ended');
    assert.deepEqual(JSON.parse(answer.body), ANTHROPIC_DEADLINE);
    await sleep(200);
    assert.equal(seen.length, 1);
    assert.deepEqual(outcomesOf(await logs(gateway.logPath)), ['request_deadline']);
  });
});

// ---- Р6: a real final answer before the deadline wins -------------------

for (const [status, keys] of [[429, ['fake-key-a']], [429, ['fake-key-a', 'fake-key-b', 'fake-key-c']], [503, ['fake-key-a', 'fake-key-b']]]) {
  test(`Э1a Р6: complete ${status} from ${keys.length} key(s) before the deadline is returned, not 504`, { timeout: 30_000 }, async () => {
    await scenario((request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(`{"error":"upstream ${status}"}`);
    }, { keys, deadlineMs: 2_000 }, async (gateway) => {
      const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE, 1_800);
      assert.equal(answer.statusCode, status);
      assert.equal(answer.terminal, 'ended');
    });
  });
}

test('Э1a Р6: deadline before a delayed 429 answers 504 and ignores the late 429', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end('{"error":"late 429"}');
    }, 600);
  }, { keys: ['fake-key-a', 'fake-key-b'], deadlineMs: 250 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE, 1_500);
    assert.deepEqual(answer, { statusCode: 504, body: DEADLINE_BODY, terminal: 'ended' });
    await sleep(500);
    assert.equal(seen.length, 1);
    assert.deepEqual(outcomesOf(await logs(gateway.logPath)), ['request_deadline']);
  });
});

// F2: key A answers a complete 429/503, key B is cut by the deadline before any
// answer. The real status wins (Р6), but the circle was NOT fully answered, so
// neither the body nor the log may claim a uniform / pool-wide verdict (§12.9.4).
for (const status of [429, 503]) {
  test(`Э1a F2: ${status} from key A, key B cut by the deadline: real ${status}, no all-keys claim`, { timeout: 30_000 }, async () => {
    await scenario((request, response, n) => {
      if (n !== 1) return; // key B: silent past the deadline
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(`{"error":"upstream ${status}"}`);
    }, { keys: ['fake-key-a', 'fake-key-b'], deadlineMs: 400 }, async (gateway, seen) => {
      const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_JSON, 2_000);
      assert.equal(answer.statusCode, status);
      assert.doesNotMatch(answer.body, /every available key/);
      assert.equal(seen.length, 2);
      const verdict = verdictOf(await logs(gateway.logPath));
      assert.ok(verdict, 'exhaustion verdict logged');
      assert.notEqual(verdict.earlyStopReason, 'uniform_rate_limit');
      assert.notEqual(verdict.earlyStopReason, 'pool_coverage');
      assert.equal(verdict.coverage, false);
    });
  });
}

test('Э1a F2 control: both keys answer a complete 429 before the deadline: uniform verdict unchanged', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end('{"error":"upstream 429"}');
  }, { keys: ['fake-key-a', 'fake-key-b'], deadlineMs: 2_000 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_JSON, 3_000);
    assert.equal(answer.statusCode, 429);
    assert.equal(answer.body, '{"error":"Upstream rate limit: every available key is currently rate-limited."}');
    assert.equal(seen.length, 2);
    const verdict = verdictOf(await logs(gateway.logPath));
    assert.equal(verdict.earlyStopReason, 'uniform_rate_limit');
    assert.equal(verdict.coverage, true);
  });
});

// N2: key A answers a complete 429, key B's upstream accepts then hangs up
// (synthetic failure, no HTTP status). B did NOT return a real status, so the
// circle is not fully answered: no uniform / pool-wide claim (§12.9.4).
for (const [facade, pathname, body] of [['OpenAI', '/v1/chat/completions', OPENAI_JSON], ['Anthropic', '/v1/messages', ANTHROPIC_JSON]]) {
  test(`Э1a N2 RED: ${facade} 429 from key A, key B socket hang-up: real 429, no all-keys claim`, { timeout: 30_000 }, async () => {
    await scenario((request, response, n) => {
      if (n !== 1) { request.socket.destroy(); return; } // key B: hang-up, no status
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end('{"error":"upstream 429"}');
    }, { keys: ['fake-key-a', 'fake-key-b'], deadlineMs: 2_000 }, async (gateway, seen) => {
      const answer = await post(gateway.port, pathname, body, 3_000);
      assert.equal(answer.statusCode, 429);
      assert.doesNotMatch(answer.body, /every available key/);
      assert.equal(seen.length, 2);
      const verdict = verdictOf(await logs(gateway.logPath));
      assert.ok(verdict, 'exhaustion verdict logged');
      assert.notEqual(verdict.earlyStopReason, 'uniform_rate_limit');
      assert.notEqual(verdict.earlyStopReason, 'pool_coverage');
    });
  });
}

test('Э1a Р6: empty pool returns the real 503, both facades', { timeout: 30_000 }, async () => {
  await scenario(() => assert.fail('no upstream call with an empty pool'), { keys: [], deadlineMs: 300 }, async (gateway) => {
    const openai = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE, 1_500);
    assert.deepEqual(openai, { statusCode: 503, body: '{"error":"All API keys exhausted"}', terminal: 'ended' });
    const anthropic = await post(gateway.port, '/v1/messages', ANTHROPIC_SSE, 1_500);
    assert.equal(anthropic.statusCode, 503);
    assert.equal(JSON.parse(anthropic.body).error.message, 'All API keys exhausted');
  });
});

// ---- commit / abort -----------------------------------------------------

test('Э1a: a stream committed before the deadline is never cut by it', { timeout: 30_000 }, async () => {
  const frame = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n';
  await scenario((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame);
    setTimeout(() => { if (!response.destroyed) response.end(`${frame}data: [DONE]\n\n`); }, 500);
  }, { keys: ['fake-key-a', 'fake-key-b'], deadlineMs: 200 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE, 2_000);
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended');
    assert.ok(answer.body.includes('[DONE]'));
    assert.equal(seen.length, 1);
    assert.deepEqual(outcomesOf(await logs(gateway.logPath)), ['completed']);
  });
});

test('Э1a §12.9 п.1: OpenAI non-stream 200 body failure after commit aborts, never 504 or clean end', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"id":"chatcmpl-1","choices":[');
  }, { keys: ['fake-key-a', 'fake-key-b'], idleMs: 300, deadlineMs: 100 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_JSON, 2_000);
    assert.equal(answer.statusCode, 200, 'early pass-through keeps the upstream 200');
    assert.ok(answer.terminal === 'aborted' || answer.terminal === 'error', `body failure after 200 must abort, got ${answer.terminal}`);
    assert.equal(answer.body.includes('deadline'), false);
    assert.equal(seen.length, 1);
  });
});

test('Э1a: client abort before the deadline: no retry, no late deadline outcome', { timeout: 30_000 }, async () => {
  let signal;
  const reached = new Promise((resolve) => { signal = resolve; });
  await scenario(() => signal(), { keys: ['fake-key-a', 'fake-key-b'], deadlineMs: 300 }, async (gateway, seen) => {
    const request = http.request({ host: '127.0.0.1', port: gateway.port, path: '/v1/chat/completions', method: 'POST', headers: {
      authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(OPENAI_SSE)
    } }, (response) => response.resume());
    let gotResponse = false;
    request.once('response', () => { gotResponse = true; });
    request.once('error', () => {});
    request.end(OPENAI_SSE);
    let watchdog;
    await Promise.race([reached, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('upstream not reached')), 1_000); })]);
    clearTimeout(watchdog);
    request.destroy();
    await sleep(600); // well past the 300ms deadline
    assert.equal(gotResponse, false, 'no write to an aborted client');
    assert.equal(seen.length, 1, 'no attempt after abort');
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['client_aborted']);
    assert.equal(verdictOf(entries), undefined, 'no late exhaustion/deadline verdict after abort');
  });
});

// ---- RED: client abort / shutdown during a partial-then-silent pre-commit ----

// Opens a raw client request and resolves once the fake upstream has been reached.
function openPending(port, pathname, body, reached) {
  const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: {
    authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body)
  } }, (response) => response.resume());
  request.once('error', () => {});
  request.end(body);
  let watchdog;
  const ready = Promise.race([reached, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('upstream not reached')), 1_000); })])
    .finally(() => clearTimeout(watchdog));
  return { request, ready };
}

const countMessage = (entries, message) => entries.filter((entry) => entry.message === message).length;

for (const [facade, pathname, body] of [['OpenAI', '/v1/chat/completions', OPENAI_SSE], ['Anthropic', '/v1/messages', ANTHROPIC_SSE]]) {
  test(`Э1a RED: ${facade} SSE partial-then-silent pre-commit, client abort at ~200ms: no penalty, no retry`, { timeout: 30_000 }, async () => {
    let signal;
    const reached = new Promise((resolve) => { signal = resolve; });
    await scenario((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(PARTIAL_SSE);
      signal();
    }, { keys: ['fake-key-a', 'fake-key-b'], deadlineMs: 60_000 }, async (gateway, seen) => {
      const startedAt = Date.now();
      const { request, ready } = openPending(gateway.port, pathname, body, reached);
      await ready;
      await sleep(Math.max(0, 200 - (Date.now() - startedAt)));
      request.destroy();
      await sleep(800);
      assert.equal(seen.length, 1, 'exactly one upstream request');
      const entries = await logs(gateway.logPath);
      assert.equal(countMessage(entries, 'Upstream error, backing off'), 0, 'client abort must not penalize the key');
      assert.equal(countMessage(entries, 'Retrying with different key'), 0, 'client abort must not fail over');
    });
  });
}

test('Э1a RED: shutdown during partial-then-silent pre-commit: child exits <1500ms, no penalty', { timeout: 30_000 }, async () => {
  let signal;
  const reached = new Promise((resolve) => { signal = resolve; });
  await scenario((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(PARTIAL_SSE);
    signal();
  }, { keys: ['fake-key-a', 'fake-key-b'], deadlineMs: 60_000 }, async (gateway, seen) => {
    const { request, ready } = openPending(gateway.port, '/v1/chat/completions', OPENAI_SSE, reached);
    try {
      await ready;
      await sleep(100);
      const stopAt = Date.now();
      await stopGateway(gateway.child);
      const elapsed = Date.now() - stopAt;
      assert.ok(elapsed < 1_500, `child must exit promptly on shutdown, took ${elapsed}ms`);
      assert.equal(seen.length, 1, 'no attempt during shutdown');
      const entries = await logs(gateway.logPath);
      assert.equal(countMessage(entries, 'Upstream error, backing off'), 0, 'shutdown must not penalize the key');
    } finally {
      request.destroy();
    }
  });
});

// ---- F5: client abort AFTER commit must not penalize the key (plan 12.9.3) ----

// Opens a raw client request; `committed` resolves once the client body contains `marker`.
function openCommitted(port, pathname, body, marker) {
  let seenBody = '';
  let signal;
  let watchdog;
  const committed = new Promise((resolve, reject) => {
    signal = resolve;
    watchdog = setTimeout(() => reject(new Error(`client never saw ${JSON.stringify(marker)}`)), 2_000);
  }).finally(() => clearTimeout(watchdog));
  const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: {
    authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body)
  } }, (response) => {
    response.on('data', (chunk) => { seenBody += chunk; if (seenBody.includes(marker)) signal(); });
    response.on('error', () => {});
  });
  request.once('error', () => {});
  request.end(body);
  return { request, committed };
}

for (const [label, facade, pathname, body, marker] of [
  ['RED', 'Anthropic', '/v1/messages', ANTHROPIC_SSE, 'event: message_start'],
  ['control', 'OpenAI', '/v1/chat/completions', OPENAI_SSE, 'data: ']
]) {
  test(`Э1a F5 ${label}: ${facade} stream committed, client abort: no key penalty`, { timeout: 30_000 }, async () => {
    const frame = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n';
    await scenario((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(frame); // one complete frame: the gateway commits, then upstream stays silent
    }, { keys: ['fake-key-a', 'fake-key-b'], deadlineMs: 60_000, firstByteMs: 10_000, idleMs: 10_000 }, async (gateway, seen) => {
      const { request, committed } = openCommitted(gateway.port, pathname, body, marker);
      try {
        await committed;
        await sleep(300);
        request.destroy();
        await sleep(800);
      } finally {
        request.destroy();
      }
      assert.equal(seen.length, 1, 'exactly one upstream request');
      const entries = await logs(gateway.logPath);
      assert.equal(countMessage(entries, 'Upstream error, backing off'), 0, 'client abort after commit must not penalize the key');
      await assertNoKeyPenaltyAfterFlush(gateway, ['fake-key-a', 'fake-key-b']);
    });
  });
}

// ---- 12.9.2 coverage: request-level circle, not the last pass -----------

// Owner decision 1a (27.09): a pass in which every distinct key went idle
// before commit is final — no pass 2 (previously pinned here as >= 3 attempts
// ending in 504 request_deadline); the request answers the neutral 503.
test('Э1a coverage: pass 1 finishes by idle on both keys: no pass 2, neutral 503, coverage true (decision 1a)', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(PARTIAL_SSE); // then silence: each attempt ends by idle_timeout
  }, { keys: ['fake-key-a', 'fake-key-b'], idleMs: 90, deadlineMs: 420, maxAttempts: 10 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE, 2_000);
    assert.deepEqual(answer, { statusCode: 503, body: '{"error":"Upstream temporarily unavailable"}', terminal: 'ended' });
    assert.equal(seen.length, 2, `one attempt per distinct key, no pass 2: ${seen.length} attempts`);
    assert.deepEqual([...seen].sort(), ['Bearer fake-key-a', 'Bearer fake-key-b'], 'pass 1 covered both distinct keys');
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['idle_timeout', 'idle_timeout']);
    assert.equal(entries.filter((entry) => entry.message === 'Upstream error, backing off').length, 0, 'Р1: idle does not penalize');
    const verdict = verdictOf(entries);
    assert.equal(verdict?.earlyStopReason, 'idle_round');
    assert.equal(verdict?.coverage, true, 'the distinct circle finished in pass 1');
    assert.equal(verdict?.poolWide, false, 'an idle round is never a pool-wide verdict');
  });
});

// §12.9.2: once the pre-commit deadline fires, no further upstream attempt may
// start. Node timers can fire ~1 ms early, so a clock-vs-deadline retry check
// alone can let a second ~1 ms attempt out. Probabilistic: many short requests.
// 0 attempts for a request is valid: the deadline may expire before the first
// attempt reaches the upstream (the loop checks the deadline before every attempt).
test('Э1a: after the deadline fires no further upstream attempt is made (≤1 per request)', { timeout: 30_000 }, async () => {
  const REQUESTS = 150;
  // Attribute every upstream hit to its client request by a body marker, not by a
  // time window: a legitimate attempt may reach the upstream after its 504 returned.
  const hits = new Map(); // marker -> upstream hits
  let unknown = 0; // hits whose body was cut off before a marker could be read
  await scenario((request) => {
    // silent upstream: reads the body, never answers
    let body = '';
    let classified = false;
    const classify = () => {
      if (classified) return;
      classified = true;
      const marker = /probe-\d+/.exec(body)?.[0];
      if (marker) hits.set(marker, (hits.get(marker) ?? 0) + 1); else unknown += 1;
    };
    request.on('data', (chunk) => { body += chunk; });
    request.once('end', classify);
    request.once('close', classify);
    request.once('error', () => {});
  }, { keys: ['fake-key-a', 'fake-key-b'], firstByteMs: 5_000, idleMs: 5_000, deadlineMs: 15, maxAttempts: 10 }, async (gateway, seen) => {
    const statuses = [];
    for (let i = 0; i < REQUESTS; i++) {
      const body = JSON.stringify({ stream: false, messages: [{ role: 'user', content: `probe-${i}` }] });
      const answer = await post(gateway.port, '/v1/chat/completions', body, 2_000);
      statuses.push(answer.statusCode);
    }
    await sleep(300); // let any late attempt reach the upstream before counting
    const total = [...hits.values()].reduce((sum, n) => sum + n, 0) + unknown;
    assert.deepEqual(statuses.filter((status) => status !== 504), [], 'every request must answer 504');
    const over = [...hits].filter(([, n]) => n > 1);
    assert.deepEqual(over, [], 'no request may make more than one upstream attempt (extra attempt after the deadline)');
    assert.equal(total, seen.length, `every upstream hit is classified: ${total} classified vs ${seen.length} seen`);
    assert.ok(total <= REQUESTS, `at most one upstream attempt per request: ${total} attempts for ${REQUESTS} requests`);
    assert.ok(total > 0, 'the upstream must be exercised at least once');
    assert.ok(hits.size > 0, `markers must be readable at the upstream (unknown=${unknown})`);
    // Log-side check: the gateway counts every attempt it STARTED, including an
    // extra ~1 ms attempt destroyed before its body (and marker) reached the upstream.
    const exhausted = (await logs(gateway.logPath)).filter((entry) => entry.message === 'All failover attempts exhausted');
    assert.equal(exhausted.length, REQUESTS, 'one exhausted verdict per 504');
    const overLogged = exhausted.filter((entry) => !(entry.attempts <= 1)).map((entry) => entry.attempts);
    assert.deepEqual(overLogged, [], `every exhausted verdict must log attempts ≤ 1: ${overLogged.length} of ${exhausted.length} entries over (attempts=${overLogged.join(',')})`);
  });
});

// ---- F6: idle_timeout AFTER commit must not penalize the key (Р1) -------

for (const [label, facade, pathname, body, marker] of [
  ['RED', 'Anthropic', '/v1/messages', ANTHROPIC_SSE, 'event: message_start'],
  ['control', 'OpenAI', '/v1/chat/completions', OPENAI_SSE, 'data: ']
]) {
  test(`Э1a F6 ${label}: ${facade} stream committed, then idle_timeout: no key penalty (Р1)`, { timeout: 30_000 }, async () => {
    const frame = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n';
    await scenario((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(frame); // one complete frame: the gateway commits, then silence until idle fires
    }, { keys: ['fake-key-a', 'fake-key-b'], deadlineMs: 60_000, firstByteMs: 10_000, idleMs: 300 }, async (gateway, seen) => {
      const { request, committed } = openCommitted(gateway.port, pathname, body, marker);
      try {
        await committed;
        await sleep(1_200); // idle (300 ms) fires well inside this bounded window
      } finally {
        request.destroy();
      }
      assert.equal(seen.length, 1, 'exactly one upstream request');
      const entries = await logs(gateway.logPath);
      assert.equal(countMessage(entries, 'Upstream error, backing off'), 0, 'Р1: idle_timeout after commit must not penalize the key');
      await assertNoKeyPenaltyAfterFlush(gateway, ['fake-key-a', 'fake-key-b']);
    });
  });
}

// ---- AC traceability gaps (plan line 124): G1 / G2 / G3 / G4 ------------

// The four facade cells; the last element checks the facade-format 504 body.
const AC_CELLS = [
  ['OpenAI SSE', '/v1/chat/completions', OPENAI_SSE, (body) => assert.equal(body, DEADLINE_BODY)],
  ['OpenAI non-stream', '/v1/chat/completions', OPENAI_JSON, (body) => assert.equal(body, DEADLINE_BODY)],
  ['Anthropic SSE', '/v1/messages', ANTHROPIC_SSE, (body) => assert.deepEqual(JSON.parse(body), ANTHROPIC_DEADLINE)],
  ['Anthropic non-stream', '/v1/messages', ANTHROPIC_JSON, (body) => assert.deepEqual(JSON.parse(body), ANTHROPIC_DEADLINE)]
];

// G1 (+ G3: the watchdog before headers is covered here, no separate test):
// upstream accepts the connection and sends nothing at all, not even headers.
for (const [cell, pathname, body, expectBody] of AC_CELLS) {
  test(`Э1a AC: G1 ${cell}: silence before headers: one facade 504 at the deadline, no further attempt`, { timeout: 30_000 }, async () => {
    await scenario(() => { /* accept, never respond */ },
      { keys: ['fake-key-a', 'fake-key-b'], firstByteMs: 2_000, idleMs: 2_000, deadlineMs: 300, maxAttempts: 10 }, async (gateway, seen) => {
        const startedAt = Date.now();
        const answer = await post(gateway.port, pathname, body, 1_500);
        const elapsed = Date.now() - startedAt;
        assert.equal(answer.statusCode, 504);
        assert.equal(answer.terminal, 'ended');
        expectBody(answer.body);
        assert.ok(elapsed < 700, `504 by the deadline, not the first-byte window: ${elapsed} ms`);
        await sleep(200);
        assert.equal(seen.length, 1, 'no attempt after the deadline');
        assert.deepEqual(outcomesOf(await logs(gateway.logPath)), ['request_deadline']);
      });
  });
}

// G4: tight bound on the partial-then-silence setups (300 ms deadline, < 300 + 400 ms).
const PARTIAL_THEN_SILENCE = {
  'OpenAI SSE': (response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(PARTIAL_SSE); },
  'OpenAI non-stream': (response) => { response.writeHead(503, { 'content-type': 'application/json' }); response.write('{"error":"unfinished'); },
  'Anthropic SSE': (response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(PARTIAL_SSE); },
  'Anthropic non-stream': (response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"id":"chatcmpl-1","choices":[{"message":{"content":"unfin'); }
};
for (const [cell, pathname, body, expectBody] of AC_CELLS) {
  test(`Э1a AC: G4 ${cell}: partial then silence: 504 within deadline + 400 ms`, { timeout: 30_000 }, async () => {
    await scenario((request, response) => PARTIAL_THEN_SILENCE[cell](response),
      { keys: ['fake-key-a', 'fake-key-b'], idleMs: 1_000, deadlineMs: 300 }, async (gateway, seen) => {
        const startedAt = Date.now();
        const answer = await post(gateway.port, pathname, body, 1_500);
        const elapsed = Date.now() - startedAt;
        assert.equal(answer.statusCode, 504);
        assert.equal(answer.terminal, 'ended');
        expectBody(answer.body);
        assert.ok(elapsed < 300 + 400, `tight bound: ${elapsed} ms`);
        await sleep(200);
        assert.equal(seen.length, 1, 'no attempt after the deadline');
        assert.deepEqual(outcomesOf(await logs(gateway.logPath)), ['request_deadline']);
      });
  });
}

// G2: max-stream before commit on Anthropic, mirroring gateway-runtime.test.mjs:866
// (OpenAI). startGateway has no max-stream option, so the preload seam
// (GATEWAY_TEST_MAX_STREAM_TIMER_MS) reaches the child through the inherited
// env only for this spawn, then is restored.
test('Э1a AC: G2 Anthropic SSE: max-stream fires before commit, retries a distinct key instead of aborting', { timeout: 30_000 }, async () => {
  const names = ['GATEWAY_TEST_MAX_STREAM_TIMER_MS', 'GATEWAY_MAX_STREAM_DURATION_MS'];
  const saved = names.map((name) => process.env[name]);
  const restore = () => names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
  const timers = [];
  process.env.GATEWAY_TEST_MAX_STREAM_TIMER_MS = '90';
  process.env.GATEWAY_MAX_STREAM_DURATION_MS = '300000';
  try {
    await scenario((request, response, attempt) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (attempt === 1) {
        // Non-committing trickle: SSE comment lines only, never a data frame.
        response.write(': ping\n\n');
        const timer = setInterval(() => { if (!response.destroyed) response.write(': ping\n\n'); }, 30);
        timers.push(timer);
        response.once('close', () => clearInterval(timer));
      } else {
        response.end('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n');
      }
    }, { keys: ['fake-key-a', 'fake-key-b'], firstByteMs: 1_000, idleMs: 1_000, deadlineMs: 420 }, async (gateway, seen) => {
      restore();
      const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_SSE, 1_500);
      assert.equal(answer.statusCode, 200);
      assert.equal(answer.terminal, 'ended');
      assert.deepEqual(seen, ['Bearer fake-key-a', 'Bearer fake-key-b']);
      assert.match(answer.body, /recovered/);
      const entries = await logs(gateway.logPath);
      assert.deepEqual(outcomesOf(entries), ['max_stream_duration', 'completed']);
      assert.equal(countMessage(entries, 'Upstream error, backing off'), 0);
    });
  } finally {
    restore();
    for (const timer of timers) clearInterval(timer);
  }
});

// ---- AC2: remaining four-cell gaps (plan line 124) ------------------------

// A: client abort before commit, the two non-stream cells (SSE cells: :423, :465).
for (const [cell, pathname, body] of [['OpenAI non-stream', '/v1/chat/completions', OPENAI_JSON], ['Anthropic non-stream', '/v1/messages', ANTHROPIC_JSON]]) {
  test(`Э1a AC2: A ${cell}: client abort before commit: no retry, no key penalty, no late deadline outcome`, { timeout: 30_000 }, async () => {
    let signal;
    const reached = new Promise((resolve) => { signal = resolve; });
    await scenario(() => signal(), { keys: ['fake-key-a', 'fake-key-b'], deadlineMs: 300 }, async (gateway, seen) => {
      let gotResponse = false;
      const { request, ready } = openPending(gateway.port, pathname, body, reached);
      request.once('response', () => { gotResponse = true; });
      await ready;
      request.destroy();
      await sleep(600); // well past the 300 ms deadline
      assert.equal(gotResponse, false, 'no write to an aborted client');
      assert.equal(seen.length, 1, 'no attempt after abort');
      const entries = await logs(gateway.logPath);
      assert.deepEqual(outcomesOf(entries), ['client_aborted']);
      assert.equal(verdictOf(entries), undefined, 'no late exhaustion/deadline verdict after abort');
      assert.equal(countMessage(entries, 'Upstream error, backing off'), 0);
      await assertNoKeyPenaltyAfterFlush(gateway, ['fake-key-a', 'fake-key-b']);
    });
  });
}

// B: 1 and 3 keys, partial then silence -> exactly one 504 (OpenAI SSE cell: :222).
for (const [cell, pathname, body, expectBody] of AC_CELLS.filter(([cell]) => cell !== 'OpenAI SSE')) {
  for (const keyCount of [1, 3]) {
    test(`Э1a AC2: B ${cell}: ${keyCount} key(s), partial then silence: one 504, no further attempt, no penalty`, { timeout: 30_000 }, async () => {
      const keys = ['fake-key-a', 'fake-key-b', 'fake-key-c'].slice(0, keyCount);
      await scenario((request, response) => PARTIAL_THEN_SILENCE[cell](response),
        { keys, idleMs: 1_000, deadlineMs: 300, maxAttempts: 10 }, async (gateway, seen) => {
          const startedAt = Date.now();
          const answer = await post(gateway.port, pathname, body, 1_500);
          assert.equal(answer.statusCode, 504);
          assert.equal(answer.terminal, 'ended');
          expectBody(answer.body);
          assert.ok(Date.now() - startedAt < 900, 'bounded by the deadline, not by idle');
          await sleep(200);
          assert.deepEqual(seen, ['Bearer fake-key-a'], 'no attempt after the deadline');
          const entries = await logs(gateway.logPath);
          assert.deepEqual(outcomesOf(entries), ['request_deadline']);
          assert.equal(verdictOf(entries)?.earlyStopReason, 'request_deadline');
          assert.equal(countMessage(entries, 'Upstream error, backing off'), 0);
          await assertNoKeyPenaltyAfterFlush(gateway, keys);
        });
    });
  }
}

// C: Anthropic SSE committed before the deadline is never cut by it (OpenAI cell: :394).
test('Э1a AC2: C Anthropic SSE: a stream committed before the deadline completes normally past it', { timeout: 30_000 }, async () => {
  const frame = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n';
  await scenario((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame);
    setTimeout(() => { if (!response.destroyed) response.end(`${frame}data: [DONE]\n\n`); }, 500);
  }, { keys: ['fake-key-a', 'fake-key-b'], deadlineMs: 300 }, async (gateway, seen) => {
    const startedAt = Date.now();
    const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_SSE, 2_000);
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended');
    assert.ok(Date.now() - startedAt >= 450, 'the stream outlived the 300 ms deadline');
    assert.match(answer.body, /event: message_stop/);
    await sleep(200); // settle: a late retry would land in this window
    assert.equal(seen.length, 1);
    assert.deepEqual(outcomesOf(await logs(gateway.logPath)), ['completed']);
    await assertNoKeyPenaltyAfterFlush(gateway, ['fake-key-a', 'fake-key-b']);
  });
});

// D: a committed SSE trickling data frames is ended by max-stream, not by the deadline.
// No after-commit max-stream test exists in gateway-runtime.test.mjs (only the
// pre-commit one at :866), so the expectations come from server.mjs:1290-1304:
// after commit -> outcome max_stream_duration and res.destroy (client sees an abort).
for (const [cell, pathname, body] of [['OpenAI SSE', '/v1/chat/completions', OPENAI_SSE], ['Anthropic SSE', '/v1/messages', ANTHROPIC_SSE]]) {
  test(`Э1a AC2: D ${cell}: committed stream lives past the deadline and is ended by max-stream`, { timeout: 30_000 }, async () => {
    const names = ['GATEWAY_TEST_MAX_STREAM_TIMER_MS', 'GATEWAY_MAX_STREAM_DURATION_MS'];
    const saved = names.map((name) => process.env[name]);
    const restore = () => names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
    const timers = [];
    process.env.GATEWAY_TEST_MAX_STREAM_TIMER_MS = '700';
    process.env.GATEWAY_MAX_STREAM_DURATION_MS = '300000';
    try {
      await scenario((request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        let n = 0;
        const send = () => { if (!response.destroyed) response.write(`data: {"choices":[{"delta":{"content":"t${n++}"}}]}\n\n`); };
        send();
        const timer = setInterval(send, 50);
        timers.push(timer);
        response.once('close', () => clearInterval(timer));
      }, { keys: ['fake-key-a', 'fake-key-b'], firstByteMs: 1_000, idleMs: 1_000, deadlineMs: 200 }, async (gateway, seen) => {
        restore();
        const startedAt = Date.now();
        const answer = await post(gateway.port, pathname, body, 3_000);
        const elapsed = Date.now() - startedAt;
        assert.equal(answer.statusCode, 200);
        assert.ok(answer.terminal === 'aborted' || answer.terminal === 'error', `max-stream after commit aborts, got ${answer.terminal}`);
        assert.ok(elapsed >= 600 && elapsed < 2_000, `ended by the 700 ms max-stream, not the 200 ms deadline: ${elapsed} ms`);
        assert.ok(answer.body.includes('"t8"'), 'frames sent ~400 ms after the deadline reached the client');
        assert.equal(answer.body.includes('deadline'), false);
        await sleep(200); // settle: a late retry would land in this window
        assert.equal(seen.length, 1, 'no retry after commit');
        const entries = await logs(gateway.logPath);
        assert.deepEqual(outcomesOf(entries), ['max_stream_duration']);
        assert.equal(outcomesOf(entries).includes('request_deadline'), false);
        await assertNoKeyPenaltyAfterFlush(gateway, ['fake-key-a', 'fake-key-b']);
      });
    } finally {
      restore();
      for (const timer of timers) clearInterval(timer);
    }
  });
}

// E: Anthropic non-stream BUFFERS (server.mjs:1901-1916, failBufferedAnthropic), so
// there is no early pass-through: a 200 with a broken body is not committed. Mirror
// of :410 params -> facade 504; a body failure before the deadline -> failover to B.
test('Э1a AC2: E Anthropic non-stream: buffered, so 200 then stalled body is a facade 504, not an abort', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"id":"chatcmpl-1","choices":[');
  }, { keys: ['fake-key-a', 'fake-key-b'], idleMs: 300, deadlineMs: 100 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_JSON, 2_000);
    assert.equal(answer.statusCode, 504);
    assert.equal(answer.terminal, 'ended');
    assert.deepEqual(JSON.parse(answer.body), ANTHROPIC_DEADLINE);
    await sleep(200); // settle: a late retry would land in this window
    assert.equal(seen.length, 1);
    assert.deepEqual(outcomesOf(await logs(gateway.logPath)), ['request_deadline']);
    await assertNoKeyPenaltyAfterFlush(gateway, ['fake-key-a', 'fake-key-b']);
  });
});

test('Э1a AC2: E Anthropic non-stream: buffered 200 body failure fails over to a healthy key', { timeout: 30_000 }, async () => {
  const completion = JSON.stringify({ id: 'chatcmpl-b', object: 'chat.completion', created: 1, model: 'z-ai/glm-5.2',
    choices: [{ index: 0, message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
  await scenario((request, response, attempt) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (attempt === 1) { response.write('{"id":"chatcmpl-1","choices":['); setTimeout(() => response.socket?.destroy(), 30); } else response.end(completion);
  }, { keys: ['fake-key-a', 'fake-key-b'], idleMs: 1_000, deadlineMs: 2_000 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_JSON, 2_500);
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended');
    assert.match(answer.body, /recovered/);
    assert.deepEqual(seen, ['Bearer fake-key-a', 'Bearer fake-key-b']);
  });
});

// A3: client abort AFTER upstream 200 while the Anthropic non-stream body is still
// being buffered (server.mjs failBufferedAnthropic path): the key is not at fault.
test('Э1a AC2: A3 Anthropic non-stream: client abort after upstream 200 while buffering: no penalty, no retry', { timeout: 30_000 }, async () => {
  let signal;
  const reached = new Promise((resolve) => { signal = resolve; });
  await scenario((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"id":"chatcmpl-1","choices":[', () => signal());
  }, { keys: ['fake-key-a', 'fake-key-b'], firstByteMs: 5_000, idleMs: 5_000, deadlineMs: 60_000 }, async (gateway, seen) => {
    let gotResponse = false;
    const { request, ready } = openPending(gateway.port, '/v1/messages', ANTHROPIC_JSON, reached);
    request.once('response', () => { gotResponse = true; });
    await ready;
    await sleep(200); // the 200 headers + partial body are now being buffered
    request.destroy();
    await sleep(600);
    assert.equal(gotResponse, false, 'buffered path: nothing was written to the client');
    assert.equal(seen.length, 1, 'no attempt after abort');
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['client_aborted']);
    assert.equal(countMessage(entries, 'Upstream error, backing off'), 0);
    await assertNoKeyPenaltyAfterFlush(gateway, ['fake-key-a', 'fake-key-b']);
  });
});