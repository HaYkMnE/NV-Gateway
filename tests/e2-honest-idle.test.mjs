// Э2: after a 200 is committed to the client, an upstream break (EOF without a
// terminator) or idle must reach the client as a transport abort/error, never as
// a clean EOF carrying `data: [DONE]` or `event: message_stop`. The key must not
// be penalized for the upstream idle/break (Р1), and no retry happens after commit.
// Harness copied from tests/e1a-precommit-deadline.test.mjs (it exports nothing).

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
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-e2-${process.pid}-`));
// Unique per test process so a foreign gateway on a raced port never shares our token.
const TOKEN = `test-gateway-${randomUUID()}`;
const KEYS = ['fake-key-a', 'fake-key-b'];
// Literal copy of the JSON part of OPENAI_INCOMPLETE_STREAM_ERROR (src/gateway/server.mjs ~:640).
const OPENAI_INCOMPLETE_STREAM_ERROR_JSON = '{"error":{"message":"Upstream stream ended before completion","type":"upstream_stream_error","code":"incomplete_stream"}}';

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gone = (c) => c.exitCode !== null || c.signalCode !== null;

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

// Bounded startup: one total budget across retries, labeled failure (as in e1a).
async function startGateway(upstreamPort, { keys = KEYS, firstByteMs = 2_000, idleMs = 400, deadlineMs = 60_000, startupDeadlineMs = 12_000 } = {}) {
  const startBy = Date.now() + startupDeadlineMs;
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
        GATEWAY_REQUEST_DEADLINE_MS: String(deadlineMs)
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
    try { const status = await health(port); if (status === 200) return { child, port, logPath: current.logPath, statePath: current.statePath, persisted: current.persisted }; lastError = new Error(`health ${status}`); } catch (error) { lastError = error; }
    await sleep(25);
  }
  lastExit = child.exitCode ?? child.signalCode;
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

// Stop, require the shutdown flush, then prove no key carries a failure/backoff/park.
async function flushedKeysAfterStop(gateway, expectedKeys) {
  const before = gateway.persisted.length;
  await stopGateway(gateway.child);
  for (let waited = 0; gateway.persisted.length === before && waited < 1_000; waited += 25) await sleep(25);
  assert.ok(gateway.persisted.length > before, 'shutdown must flush key state (no state:persist after stop)');
  const flushed = gateway.persisted.at(-1).keys;
  assert.deepEqual(JSON.parse(fs.readFileSync(gateway.statePath, 'utf8')).keys, flushed, 'state file holds the flushed state');
  assert.deepEqual(flushed.map((key) => key.key).sort(), [...expectedKeys].sort(), 'every key is in the flushed state');
  return flushed;
}

async function assertNoKeyPenaltyAfterFlush(gateway, expectedKeys) {
  const flushed = await flushedKeysAfterStop(gateway, expectedKeys);
  for (const key of flushed) {
    assert.equal(key.usage.fail, 0, `${key.key}: an upstream idle/break after commit must not count a failure`);
    assert.equal(key.backoffUntil, 0, `${key.key}: an upstream idle/break after commit must not back the key off`);
    assert.equal(key.status, 'active', `${key.key}: an upstream idle/break after commit must not park the key`);
  }
}

// Current contract for an upstream EOF after commit (plan :126, per-key failure
// by contract; Р1 :179 covers IDLE only): handleKeyError(502) counts exactly one
// failure on the tried key A; key B is never tried and stays untouched.
async function assertEofKeyContractAfterFlush(gateway, expectedKeys, seen) {
  const flushed = await flushedKeysAfterStop(gateway, expectedKeys);
  const tried = String(seen[0] ?? '').replace(/^Bearer /, '');
  assert.equal(tried, KEYS[0], `key A (${KEYS[0]}) is the tried key (tried=${tried})`);
  const keyA = flushed.find((key) => key.key === KEYS[0]);
  const keyB = flushed.find((key) => key.key === KEYS[1]);
  assert.equal(keyA.usage.fail, 1, `${keyA.key}: upstream EOF after commit records exactly one failure (current contract)`);
  assert.equal(keyB.usage.fail, 0, `${keyB.key}: second key must not record a failure`);
  assert.equal(keyB.usage.success, 0, `${keyB.key}: second key must not be attempted`);
}

// Client terminal state: 'ended' (clean EOF) | 'aborted' | 'error' | 'timed-out'.
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

const OPENAI_SSE = '{"stream":true}';
const OPENAI_JSON = '{"stream":false}';
const ANTHROPIC_SSE = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10, stream: true });
const FRAME = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n';
const isAbort = (terminal) => terminal === 'aborted' || terminal === 'error';

// Upstream commits one meaningful frame, then either ends the socket without a
// terminator ('eof') or goes silent ('idle').
function sseUpstream(mode) {
  return (request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(FRAME);
    if (mode === 'eof') setTimeout(() => { if (!response.destroyed) response.end(); }, 150);
  };
}

// Common post-conditions: one upstream attempt (no retry after commit), no
// 'completed' outcome, no key penalty. Then the client-visible wire rule.
async function assertCommittedBreak(gateway, seen, answer, forbidden, { keyContract = 'no-penalty' } = {}) {
  const outcomes = outcomesOf(await logs(gateway.logPath));
  const wire = `terminal=${answer.terminal} outcomes=${JSON.stringify(outcomes)} tail=${JSON.stringify(answer.body.slice(-160))}`;
  // Collect every violation so one failure does not hide the others.
  const failures = [];
  const check = async (fn) => { try { await fn(); } catch (error) { failures.push(error.message.split('\n')[0]); } };
  await check(() => assert.equal(answer.statusCode, 200, 'committed 200 expected'));
  await check(() => assert.equal(seen.length, 1, `no retry after commit (upstream attempts=${seen.length})`));
  await check(() => assert.equal(outcomes.includes('completed'), false, "a broken stream is not 'completed'"));
  for (const marker of forbidden) {
    await check(() => assert.equal(answer.body.includes(marker), false, `client must not receive ${JSON.stringify(marker)}`));
  }
  await check(() => assert.ok(isAbort(answer.terminal), 'client must see a transport abort/error, not a clean EOF'));
  await check(() => (keyContract === 'eof-fail-once'
    ? assertEofKeyContractAfterFlush(gateway, KEYS, seen)
    : assertNoKeyPenaltyAfterFlush(gateway, KEYS)));
  assert.deepEqual(failures, [], `Э2 violations; ${wire}`);
}

test('Э2: T1 OpenAI SSE committed, upstream EOF without [DONE]: transport abort, no [DONE]', { timeout: 30_000 }, async () => {
  await scenario(sseUpstream('eof'), {}, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    assert.ok(answer.body.includes('"content":"x"'), 'the meaningful frame reached the client');
    await assertCommittedBreak(gateway, seen, answer, ['data: [DONE]', OPENAI_INCOMPLETE_STREAM_ERROR_JSON], { keyContract: 'eof-fail-once' });
  });
});

test('Э2: T2 OpenAI SSE committed, upstream idle: transport abort, no [DONE] (regression guard)', { timeout: 30_000 }, async () => {
  await scenario(sseUpstream('idle'), {}, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    assert.ok(answer.body.includes('"content":"x"'), 'the meaningful frame reached the client');
    await assertCommittedBreak(gateway, seen, answer, ['data: [DONE]']);
  });
});

test('Э2: T3 Anthropic SSE committed, upstream idle: transport abort, no message_stop', { timeout: 30_000 }, async () => {
  await scenario(sseUpstream('idle'), {}, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_SSE);
    assert.ok(answer.body.includes('event: message_start'), `committed: message_start reached the client; body=${JSON.stringify(answer.body.slice(0, 160))}`);
    await assertCommittedBreak(gateway, seen, answer, ['event: message_stop']);
  });
});

test('Э2: T4 Anthropic SSE committed, upstream EOF without finish/[DONE]: transport abort, no message_stop', { timeout: 30_000 }, async () => {
  await scenario(sseUpstream('eof'), {}, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_SSE);
    assert.ok(answer.body.includes('event: message_start'), `committed: message_start reached the client; body=${JSON.stringify(answer.body.slice(0, 160))}`);
    await assertCommittedBreak(gateway, seen, answer, ['event: message_stop'], { keyContract: 'eof-fail-once' });
  });
});

test('Э2: Anthropic complete stream then upstream socket destroy still ends cleanly with message_stop', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(FRAME);
    response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    // Complete stream, but the upstream tears the socket down instead of a clean end.
    setTimeout(() => { if (!response.destroyed) response.socket.destroy(); }, 150);
  }, {}, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_SSE);
    const events = [...answer.body.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
    const wire = `terminal=${answer.terminal} events=${JSON.stringify(events)}`;
    assert.equal(answer.statusCode, 200, wire);
    assert.equal(answer.terminal, 'ended', `complete stream must end cleanly; ${wire}`);
    assert.equal(events.at(-1), 'message_stop', `last event must be message_stop; ${wire}`);
    assert.equal(seen.length, 1, `one upstream attempt (attempts=${seen.length})`);
    // Decision 4a: the answer arrived in full; the later socket teardown is not a key failure.
    assert.deepEqual(outcomesOf(await logs(gateway.logPath)), ['completed'], `accounted as a normal completed stream; ${wire}`);
    await assertCompletedKeyAccounting(gateway);
  });
});

// Decision 4a: exactly what finishOutcome("completed") records for a normal end:
// key A success=1, no failure/backoff/park; key B never tried.
async function assertCompletedKeyAccounting(gateway) {
  const flushed = await flushedKeysAfterStop(gateway, KEYS);
  const keyA = flushed.find((key) => key.key === KEYS[0]);
  const keyB = flushed.find((key) => key.key === KEYS[1]);
  assert.equal(keyA.usage.fail, 0, `${keyA.key}: a completed stream must not count a failure`);
  assert.equal(keyA.usage.success, 1, `${keyA.key}: a completed stream counts one success`);
  assert.equal(keyA.backoffUntil, 0, `${keyA.key}: a completed stream must not back the key off`);
  assert.equal(keyA.status, 'active', `${keyA.key}: a completed stream must not park the key`);
  assert.equal(keyB.usage.fail + keyB.usage.success, 0, `${keyB.key}: second key must stay untouched`);
}

test('Э2: 4a OpenAI complete stream then upstream socket destroy ends cleanly, key not penalized', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(FRAME);
    response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    setTimeout(() => { if (!response.destroyed) response.socket.destroy(); }, 150);
  }, {}, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    const outcomes = outcomesOf(await logs(gateway.logPath));
    const wire = `terminal=${answer.terminal} outcomes=${JSON.stringify(outcomes)} tail=${JSON.stringify(answer.body.slice(-80))}`;
    assert.equal(answer.statusCode, 200, wire);
    assert.ok(answer.body.includes('data: [DONE]'), `client got [DONE]; ${wire}`);
    assert.equal(answer.terminal, 'ended', `complete stream must end cleanly; ${wire}`);
    assert.equal(seen.length, 1, `one upstream attempt (attempts=${seen.length})`);
    assert.deepEqual(outcomes, ['completed'], `accounted as a normal completed stream; ${wire}`);
    await assertCompletedKeyAccounting(gateway);
  });
});

test('Э2: 5a OpenAI non-JSON frame after commit then [DONE]: abort, [DONE] withheld', { timeout: 90_000 }, async () => {
  const MALFORMED = 'data: not-json\n\n';
  const DONE = 'data: [DONE]\n\n';
  // FRAME+MALFORMED+DONE in the COMMITTING chunk (incl. after a released prelude) is covered by the 5a tests below.
  for (const layout of ['separate', 'same-chunk', 'eof']) {
    await scenario((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const later = (ms, fn) => setTimeout(() => { if (!response.destroyed) fn(); }, ms);
      response.write(FRAME);
      if (layout === 'separate') { later(50, () => response.write(MALFORMED)); later(100, () => response.write(DONE)); }
      if (layout === 'same-chunk') later(50, () => response.write(MALFORMED + DONE));
      if (layout === 'eof') later(50, () => response.write(MALFORMED));
      later(200, () => response.end());
    }, {}, async (gateway, seen) => {
      const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
      const outcomes = outcomesOf(await logs(gateway.logPath));
      const wire = `layout=${layout} terminal=${answer.terminal} outcomes=${JSON.stringify(outcomes)} tail=${JSON.stringify(answer.body.slice(-80))}`;
      assert.equal(answer.statusCode, 200, wire);
      assert.ok(answer.body.includes('"content":"x"'), `meaningful frame reached the client; ${wire}`);
      assert.equal(answer.body.includes('data: [DONE]'), false, `client must not receive [DONE]; ${wire}`);
      assert.ok(isAbort(answer.terminal), `transport abort, not clean EOF; ${wire}`);
      assert.equal(seen.length, 1, `one upstream attempt (attempts=${seen.length})`);
      if (layout === 'eof') {
        // No [DONE]: the existing committed-EOF contract (incomplete_stream, key A fail=1).
        assert.deepEqual(outcomes, ['incomplete_stream'], wire);
        await assertEofKeyContractAfterFlush(gateway, KEYS, seen);
      } else {
        // Owner decided the wire, not the accounting: upstream [DONE] stays `completed`.
        assert.deepEqual(outcomes, ['completed'], wire);
        await assertCompletedKeyAccounting(gateway);
      }
    });
  }
});

// Decision 5a (F1/F2): committed OpenAI SSE shapes around the committing chunk
// and the 64K frame cap. Normal shapes must stay byte-exact with a clean end.
const MALFORMED_5A = 'data: not-json\n\n';
const DONE_5A = 'data: [DONE]\n\n';
const FINISH_5A = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';

async function run5aScenario(parts, { broken }) {
  await scenario((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    parts.forEach((part, index) => setTimeout(() => { if (!response.destroyed) response.write(part); }, index * 40));
    setTimeout(() => { if (!response.destroyed) response.end(); }, parts.length * 40 + 150);
  }, {}, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    const outcomes = outcomesOf(await logs(gateway.logPath));
    const wire = `terminal=${answer.terminal} outcomes=${JSON.stringify(outcomes)} len=${answer.body.length} tail=${JSON.stringify(answer.body.slice(-80))}`;
    assert.equal(answer.statusCode, 200, wire);
    assert.equal(seen.length, 1, `one upstream attempt (attempts=${seen.length})`);
    if (broken) {
      assert.ok(answer.body.includes('"content":"x"'), `meaningful frame reached the client; ${wire}`);
      assert.equal(answer.body.includes('data: [DONE]'), false, `client must not receive [DONE]; ${wire}`);
      assert.ok(isAbort(answer.terminal), `transport abort, not clean EOF; ${wire}`);
    } else {
      assert.ok(answer.body === parts.join(''), `client bytes must equal upstream bytes; ${wire}`);
      assert.equal(answer.terminal, 'ended', `normal stream must end cleanly; ${wire}`);
    }
    assert.deepEqual(outcomes, ['completed'], wire);
    await assertCompletedKeyAccounting(gateway);
  });
}

test('Э2: OpenAI 150K multi-line data frame after commit passes through byte-exact with [DONE] and clean end', { timeout: 60_000 }, async () => {
  // Multi-line data: each line alone is not JSON; joined with \n it is.
  const lines = ['{"choices":[{"delta":{"content":"y"}}],', '"pad":['];
  while (lines.join('\n').length < 150_000) lines.push(`"${'a'.repeat(1_000)}",`);
  lines.push('""]}');
  const big = lines.map((line) => `data: ${line}`).join('\n') + '\n\n';
  const chunks = [];
  for (let at = 0; at < big.length; at += 30_000) chunks.push(big.slice(at, at + 30_000));
  await run5aScenario([FRAME, ...chunks, FINISH_5A + DONE_5A], { broken: false });
});

test('Э2: OpenAI content + malformed + [DONE] in the committing chunk → abort, no [DONE]', { timeout: 60_000 }, async () => {
  await run5aScenario([FRAME + MALFORMED_5A + DONE_5A], { broken: true });
});

test('Э2: OpenAI content split across held and committing chunk, then malformed + [DONE] → abort, no [DONE]', { timeout: 60_000 }, async () => {
  await run5aScenario([FRAME.slice(0, 20), FRAME.slice(20) + MALFORMED_5A + DONE_5A], { broken: true });
});

test('Э2: OpenAI non-JSON prelude in the committing chunk before content, then normal [DONE] → clean end, byte-exact', { timeout: 60_000 }, async () => {
  await run5aScenario([MALFORMED_5A + FRAME + FINISH_5A + DONE_5A], { broken: false });
});

// Decision 5a (H1/H2): a benign prelude chunk is RELEASED before the first
// meaningful frame (headers on the wire, stream not yet committed). The later
// committing chunk must still go through the F2 split and the post-commit tracker.
const PING_5A = ': ping\n\n';

test('Э2: OpenAI released benign prelude chunk, then content + malformed + [DONE] → abort, no [DONE]', { timeout: 60_000 }, async () => {
  await run5aScenario([PING_5A, FRAME + MALFORMED_5A + DONE_5A], { broken: true });
});

test('Э2: OpenAI released benign prelude chunk, then non-JSON + content + [DONE] → byte-exact clean end, completed', { timeout: 60_000 }, async () => {
  await run5aScenario([PING_5A, MALFORMED_5A + FRAME + FINISH_5A + DONE_5A], { broken: false });
});

test('Э2: OpenAI released benign prelude, then normal content chunks + [DONE] → byte-exact clean end', { timeout: 60_000 }, async () => {
  await run5aScenario([PING_5A, FRAME, FRAME, FINISH_5A + DONE_5A], { broken: false });
});

// Э4-H option (b), spec :64: after a benign-only release, an upstream SSE error
// frame before any meaningful content is not forwarded — the released 200 is
// aborted (no clean EOF, no [DONE]) and the attempt is `upstream_sse_error`.
const SSE_ERROR_5A = 'data: {"error":{"message":"transient"}}\n\n';

// Э4-H option (b) (spec :64 "никогда parsed success", plan :126): this test used
// to pin the false 200 - an SSE error before any content after a released
// prelude was forwarded and later reported `completed`. Now the error frame is
// not forwarded, the released 200 is aborted and key A is charged exactly like
// the pre-commit upstream_sse_error (handleKeyError 500: fail+1, backoff).
test('Э2/Э4-H: OpenAI released prelude, SSE error frame before content → abort, upstream_sse_error, key A penalized', { timeout: 60_000 }, async () => {
  for (const parts of [[PING_5A, SSE_ERROR_5A, FRAME + FINISH_5A + DONE_5A], [PING_5A, SSE_ERROR_5A + FRAME + FINISH_5A + DONE_5A]]) {
    await scenario((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      parts.forEach((part, index) => setTimeout(() => { if (!response.destroyed) response.write(part); }, index * 40));
      setTimeout(() => { if (!response.destroyed) response.end(); }, parts.length * 40 + 150);
    }, {}, async (gateway, seen) => {
      const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
      assert.equal(answer.statusCode, 200);
      assert.equal(answer.body, PING_5A, 'only the released prelude reaches the client');
      assert.ok(isAbort(answer.terminal), `transport abort expected, got ${answer.terminal}`);
      assert.equal(seen.length, 1, 'no failover after write');
      assert.deepEqual(outcomesOf(await logs(gateway.logPath)), ['upstream_sse_error']);
      const keyA = (await flushedKeysAfterStop(gateway, KEYS)).find((key) => key.key === KEYS[0]);
      assert.equal(keyA.usage.fail, 1);
      assert.equal(keyA.usage.success, 0);
      assert.ok(keyA.backoffUntil > 0, 'upstream error charges the key like pre-commit');
    });
  }
});

test('Э2: OpenAI released prelude, content, then SSE error frame, then [DONE] → completed (old accounting), byte-exact clean end', { timeout: 60_000 }, async () => {
  // P3a: the error frame arrives in its own chunk after the committing chunk.
  await run5aScenario([PING_5A, FRAME, SSE_ERROR_5A, FINISH_5A + DONE_5A], { broken: false });
  // P3b: the error frame sits in the committing chunk after the content.
  await run5aScenario([PING_5A, FRAME + SSE_ERROR_5A, FINISH_5A + DONE_5A], { broken: false });
});

test('Э2: OpenAI released prelude, content, then EOF without [DONE] → abort, key A failure without backoff (old accounting kept)', { timeout: 60_000 }, async () => {
  await scenario((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(PING_5A);
    setTimeout(() => { if (!response.destroyed) response.write(FRAME); }, 40);
    setTimeout(() => { if (!response.destroyed) response.end(); }, 200);
  }, {}, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    const outcomes = outcomesOf(await logs(gateway.logPath));
    const wire = `terminal=${answer.terminal} outcomes=${JSON.stringify(outcomes)} tail=${JSON.stringify(answer.body.slice(-80))}`;
    assert.equal(answer.statusCode, 200, wire);
    assert.ok(answer.body.includes('"content":"x"'), `meaningful frame reached the client; ${wire}`);
    assert.equal(answer.body.includes('data: [DONE]'), false, `client must not receive [DONE]; ${wire}`);
    assert.ok(isAbort(answer.terminal), `transport abort, not clean EOF; ${wire}`);
    assert.equal(seen.length, 1, `one upstream attempt (attempts=${seen.length})`);
    assert.deepEqual(outcomes, ['incomplete_stream'], wire);
    const flushed = await flushedKeysAfterStop(gateway, KEYS);
    const keyA = flushed.find((key) => key.key === KEYS[0]);
    const keyB = flushed.find((key) => key.key === KEYS[1]);
    assert.equal(keyA.usage.fail, 1, `${keyA.key}: exactly one failure (old released-path accounting)`);
    assert.equal(keyA.backoffUntil, 0, `${keyA.key}: no backoff (old path never called handleKeyError)`);
    assert.equal(keyA.status, 'active', `${keyA.key}: key must not be parked`);
    assert.equal(keyB.usage.fail + keyB.usage.success, 0, `${keyB.key}: second key must stay untouched`);
  });
});

test('Э2: Anthropic malformed upstream frame after commit ends as abort, no message_stop', { timeout: 60_000 }, async () => {
  for (const ending of ['done', 'eof']) {
    await scenario((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(FRAME);
      response.write('data: {not json\n\n');
      if (ending === 'done') response.write('data: [DONE]\n\n');
      setTimeout(() => { if (!response.destroyed) response.end(); }, 150);
    }, {}, async (gateway, seen) => {
      const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_SSE);
      const events = [...answer.body.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
      const wire = `ending=${ending} terminal=${answer.terminal} events=${JSON.stringify(events)}`;
      assert.equal(answer.statusCode, 200, wire);
      assert.ok(events.includes('message_start'), `committed; ${wire}`);
      assert.equal(events.includes('message_stop'), false, `no message_stop; ${wire}`);
      assert.ok(isAbort(answer.terminal), `transport abort, not clean EOF; ${wire}`);
      assert.equal(seen.length, 1, `one upstream attempt (attempts=${seen.length})`);
      const flushed = await flushedKeysAfterStop(gateway, KEYS);
      const keyB = flushed.find((key) => key.key === KEYS[1]);
      assert.equal(keyB.usage.fail + keyB.usage.success, 0, `${keyB.key}: second key must stay untouched`);
      if (ending === 'done') {
        // Plan :43/:126: upstream [DONE] keeps the pre-L1 accounting (`completed`):
        // only the wire changed, no new failure/backoff for key A.
        const keyA = flushed.find((key) => key.key === KEYS[0]);
        assert.equal(keyA.usage.fail, 0, `${keyA.key}: [DONE] after malformed frame must not count a failure`);
        assert.equal(keyA.usage.success, 1, `${keyA.key}: [DONE] keeps the completed (success) accounting`);
        assert.equal(keyA.backoffUntil, 0, `${keyA.key}: [DONE] after malformed frame must not back the key off`);
      }
    });
  }
});

test('Э2: Anthropic error-marked malformed frame after commit ends as abort, no message_stop', { timeout: 60_000 }, async () => {
  for (const ending of ['eof', 'done']) {
    await scenario((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(FRAME);
      // The SSE observer flags `event: error`; the adapter sees non-JSON data (malformed).
      response.write('event: error\ndata: not-json\n\n');
      if (ending === 'done') response.write('data: [DONE]\n\n');
      setTimeout(() => { if (!response.destroyed) response.end(); }, 150);
    }, {}, async (gateway, seen) => {
      const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_SSE);
      const events = [...answer.body.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
      const wire = `ending=${ending} terminal=${answer.terminal} events=${JSON.stringify(events)}`;
      assert.equal(answer.statusCode, 200, wire);
      assert.ok(events.includes('message_start'), `committed; ${wire}`);
      assert.equal(events.includes('message_stop'), false, `no message_stop; ${wire}`);
      assert.ok(isAbort(answer.terminal), `transport abort, not clean EOF; ${wire}`);
      assert.equal(seen.length, 1, `one upstream attempt (attempts=${seen.length})`);
      const keyB = (await flushedKeysAfterStop(gateway, KEYS)).find((key) => key.key === KEYS[1]);
      assert.equal(keyB.usage.fail + keyB.usage.success, 0, `${keyB.key}: second key must stay untouched`);
    });
  }
});

test('Э2: T5 OpenAI non-stream 200, partial JSON body then idle: transport abort, no complete JSON', { timeout: 30_000 }, async () => {
  await scenario((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"id":"chatcmpl-1","choices":[');
  }, {}, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_JSON);
    let parsed = true;
    try { JSON.parse(answer.body); } catch { parsed = false; }
    assert.equal(parsed, false, `client must not receive a complete parseable JSON; body=${JSON.stringify(answer.body.slice(-160))}`);
    await assertCommittedBreak(gateway, seen, answer, []);
  });
});

// Decision 3a (27.09): a plain empty [DONE] with a normal end is a normal empty
// answer; benign-only frames with no real end are "not finished" for the client.
const BENIGN_ONLY_3A = ': ping\n\n' + 'data: {"id":"chunk-1"}\n\n';
const DONE_ONLY_3A = 'data: [DONE]\n\n';
const endAfter = (bytes) => (request, response) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(bytes);
  setTimeout(() => { if (!response.destroyed) response.end(); }, 100);
};

test('Э2 3a: OpenAI plain empty [DONE] → clean end, completed, key success', { timeout: 30_000 }, async () => {
  await scenario(endAfter(DONE_ONLY_3A), {}, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    const outcomes = outcomesOf(await logs(gateway.logPath));
    const wire = `terminal=${answer.terminal} outcomes=${JSON.stringify(outcomes)} body=${JSON.stringify(answer.body)}`;
    assert.equal(answer.statusCode, 200, wire);
    assert.equal(answer.body, DONE_ONLY_3A, wire);
    assert.equal(answer.terminal, 'ended', wire);
    assert.equal(seen.length, 1, wire);
    assert.deepEqual(outcomes, ['completed'], wire);
    await assertCompletedKeyAccounting(gateway);
  });
});

test('Э2 3a: OpenAI benign-only EOF → abort, not a clean end, incomplete_stream, key accounting unchanged', { timeout: 30_000 }, async () => {
  await scenario(endAfter(BENIGN_ONLY_3A), {}, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    const outcomes = outcomesOf(await logs(gateway.logPath));
    const wire = `terminal=${answer.terminal} outcomes=${JSON.stringify(outcomes)} body=${JSON.stringify(answer.body)}`;
    assert.equal(answer.statusCode, 200, wire);
    assert.equal(answer.body, BENIGN_ONLY_3A, `benign bytes stay byte-for-byte; ${wire}`);
    assert.ok(isAbort(answer.terminal), `benign-only EOF must not end cleanly; ${wire}`);
    assert.equal(seen.length, 1, wire);
    assert.deepEqual(outcomes, ['incomplete_stream'], wire);
    // Key accounting exactly as before (plan :43): one failure, no backoff, no success.
    const flushed = await flushedKeysAfterStop(gateway, KEYS);
    const keyA = flushed.find((key) => key.key === KEYS[0]);
    const keyB = flushed.find((key) => key.key === KEYS[1]);
    assert.equal(keyA.usage.success, 0, `${keyA.key}: no success`);
    assert.equal(keyA.usage.fail, 1, `${keyA.key}: exactly one failure (unchanged)`);
    assert.equal(keyA.backoffUntil, 0, `${keyA.key}: no backoff (unchanged)`);
    assert.equal(keyA.status, 'active', `${keyA.key}: not parked`);
    assert.equal(keyB.usage.fail + keyB.usage.success, 0, `${keyB.key}: untouched`);
  });
});

test('Э2 3a: Anthropic plain empty [DONE] → clean end with message_stop, completed, key success', { timeout: 30_000 }, async () => {
  await scenario(endAfter(DONE_ONLY_3A), {}, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_SSE);
    const events = [...answer.body.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
    const outcomes = outcomesOf(await logs(gateway.logPath));
    const wire = `terminal=${answer.terminal} events=${JSON.stringify(events)} outcomes=${JSON.stringify(outcomes)}`;
    assert.equal(answer.statusCode, 200, wire);
    assert.equal(answer.terminal, 'ended', wire);
    assert.equal(events.includes('error'), false, wire);
    assert.equal(events.at(-1), 'message_stop', wire);
    assert.equal(seen.length, 1, wire);
    assert.deepEqual(outcomes, ['completed'], wire);
    await assertCompletedKeyAccounting(gateway);
  });
});

test('Э2 3a: Anthropic benign-only EOF → abort, no message_stop, incomplete_stream, key accounting unchanged', { timeout: 30_000 }, async () => {
  await scenario(endAfter(BENIGN_ONLY_3A), {}, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_SSE);
    const outcomes = outcomesOf(await logs(gateway.logPath));
    const wire = `terminal=${answer.terminal} outcomes=${JSON.stringify(outcomes)} tail=${JSON.stringify(answer.body.slice(-160))}`;
    assert.equal(answer.statusCode, 200, wire);
    assert.equal(answer.body.includes('event: message_stop'), false, wire);
    assert.ok(isAbort(answer.terminal), `benign-only EOF must not end cleanly; ${wire}`);
    assert.deepEqual(outcomes, ['incomplete_stream'], wire);
    await assertEofKeyContractAfterFlush(gateway, KEYS, seen);
  });
});