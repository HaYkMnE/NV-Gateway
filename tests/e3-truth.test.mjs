// Э3 truth (owner principle 28.09: "the client must see the truth").
// Fix 1: an upstream SSE that ends with a lone unterminated `data: [DONE]` line
//        is a normal end (success, client gets a well-formed `data: [DONE]\n\n`);
//        any other unterminated tail (partial JSON) stays a break.
// Fix 2: the generic 502 body carries an additive, key-free `detail` summary.
// Fix 3: the partial-coverage pool-wide text names the real cause.
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
// Per-key routes / a short models socket timeout come from the Э3 test preload.
const e3PreloadPath = path.join(projectRoot, 'tests', 'e3-infra-preload.cjs');
const serverPath = path.join(projectRoot, 'src', 'gateway', 'server.mjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-e3t-${process.pid}-`));
// Unique per test process so a foreign gateway on a raced port never shares our token.
const TOKEN = `test-gateway-${randomUUID()}`;
const ADMIN_TOKEN = 'test-admin-token';
const KEYS = ['fake-key-a', 'fake-key-b', 'fake-key-c', 'fake-key-d'];
const OPENAI_SSE = '{"stream":true}';
const ANTHROPIC_SSE = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10, stream: true });
const CONTENT = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
const SENTINEL = 'E3T-SENTINEL-4b1e7d-do-not-leak';
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
        resolve({ statusCode: response.statusCode, body: text, terminal, retryAfter: response.headers['retry-after'] });
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
const post = (port, pathname, body, timeoutMs) => request(port, 'POST', pathname, { body, timeoutMs });

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

async function startGateway(upstreamPort, { keys, deadlineMs = 60_000, maxAttempts, firstByteMs = 2_000, routes, modelsTimeoutMs }) {
  const useE3Preload = routes !== undefined || modelsTimeoutMs !== undefined;
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
        const child = spawnChild(process.execPath, ['--require', useE3Preload ? e3PreloadPath : preloadPath, serverPath], {
          env: {
            ...process.env,
            PORT: String(port),
            GATEWAY_LOG_PATH: logPath,
            GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstreamPort),
            GATEWAY_FIRST_BYTE_TIMEOUT_MS: String(firstByteMs),
            GATEWAY_IDLE_TIMEOUT_MS: '2000',
            GATEWAY_REQUEST_DEADLINE_MS: String(deadlineMs),
            ...(maxAttempts === undefined ? {} : { GATEWAY_MAX_FAILOVER_ATTEMPTS: String(maxAttempts) }),
            ...(routes === undefined ? {} : { GATEWAY_TEST_E3_ROUTES: JSON.stringify(routes) }),
            ...(modelsTimeoutMs === undefined ? {} : { GATEWAY_TEST_E3_MODELS_TIMEOUT_MS: String(modelsTimeoutMs) })
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
const FAILED_5XX = { fail: 1, success: 0, backedOff: true };

async function scenario(handler, options, run, modelsHandler) {
  const seen = [];
  const upstream = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/models' && modelsHandler) { seen.push(`models ${req.headers.authorization}`); modelsHandler(req, res); return; }
      if (req.url !== '/v1/chat/completions') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      seen.push(req.headers.authorization);
      handler(req, res);
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
// Writes each chunk as its own transport write (small gaps), the last via end().
const sseChunks = (...chunks) => (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let index = 0;
  const next = () => {
    if (index === chunks.length - 1) { res.end(chunks[index]); return; }
    res.write(chunks[index++]);
    setTimeout(next, 30);
  };
  next();
};

// ---- Fix 1 ---------------------------------------------------------------

for (const [label, tail] of [['no trailing newline', 'data: [DONE]'], ['one trailing \\n', 'data: [DONE]\n'], ['no space after data:', 'data:[DONE]']]) {
  test(`Fix 1 committed: content + unterminated [DONE] (${label}) -> clean end, success, no backoff`, { timeout: 30_000 }, async () => {
    await scenario(sseChunks(CONTENT, tail), { keys: KEYS.slice(0, 1) }, async (gateway) => {
      const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
      assert.equal(answer.statusCode, 200);
      assert.equal(answer.terminal, 'ended');
      const expectedTail = tail.endsWith('\n') ? `${tail}\n` : `${tail}\n\n`;
      assert.equal(answer.body, CONTENT + expectedTail);
      const entries = await logs(gateway.logPath);
      assert.deepEqual(outcomesOf(entries), ['completed']);
      assert.equal(penalties(entries), 0);
      assert.deepEqual(await flushedAccounting(gateway), { [KEYS[0]]: SERVED });
    });
  });
}

test('Fix 1 control: content + partial JSON frame at EOF -> still a break with today\'s accounting', { timeout: 30_000 }, async () => {
  await scenario(sseChunks(CONTENT, 'data: {"cho'), { keys: KEYS.slice(0, 1) }, async (gateway) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    assert.equal(answer.statusCode, 200);
    assert.notEqual(answer.terminal, 'ended', 'a break is a transport abort');
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['incomplete_stream']);
    assert.equal(penalties(entries), 1);
    assert.deepEqual(await flushedAccounting(gateway), { [KEYS[0]]: FAILED_5XX });
  });
});

test('Fix 1 pre-commit: a lone unterminated [DONE] is a valid empty completion', { timeout: 30_000 }, async () => {
  await scenario(sseChunks('data: [DONE]'), { keys: KEYS.slice(0, 1) }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended');
    assert.equal(answer.body, 'data: [DONE]\n\n');
    assert.equal(seen.length, 1, 'no failover');
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['completed']);
    assert.deepEqual(await flushedAccounting(gateway), { [KEYS[0]]: SERVED });
  });
});

test('Fix 1 released prelude: benign frame, content, unterminated [DONE] -> clean end, success', { timeout: 30_000 }, async () => {
  await scenario(sseChunks(': ping\n\n', CONTENT, 'data: [DONE]'), { keys: KEYS.slice(0, 1) }, async (gateway) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended');
    assert.equal(answer.body, `: ping\n\n${CONTENT}data: [DONE]\n\n`);
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['completed']);
    assert.equal(penalties(entries), 0);
    assert.deepEqual(await flushedAccounting(gateway), { [KEYS[0]]: SERVED });
  });
});

test('Fix 1 Anthropic facade: content + unterminated [DONE] -> message_stop, clean end, success', { timeout: 30_000 }, async () => {
  await scenario(sseChunks(CONTENT, 'data: [DONE]'), { keys: KEYS.slice(0, 1) }, async (gateway) => {
    const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_SSE);
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended');
    assert.equal(answer.body.includes('event: error'), false, answer.body);
    assert.ok(answer.body.includes('event: message_delta'), 'normal stop');
    assert.ok(answer.body.endsWith('event: message_stop\ndata: {}\n\n'), 'well-formed end');
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['completed']);
    assert.equal(penalties(entries), 0);
    assert.deepEqual(await flushedAccounting(gateway), { [KEYS[0]]: SERVED });
  });
});

// ---- Fix 2 ---------------------------------------------------------------

test('Fix 2: mixed 500 + 503 + silent + ECONNRESET -> 502, error unchanged, truthful detail, no leak', { timeout: 30_000 }, async () => {
  const handler = (req, res) => {
    const auth = req.headers.authorization;
    if (auth === `Bearer ${KEYS[0]}`) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: SENTINEL })); return; }
    if (auth === `Bearer ${KEYS[1]}`) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: SENTINEL })); return; }
    if (auth === `Bearer ${KEYS[2]}`) return; // silent: no headers -> first-byte timeout
    req.socket.destroy(); // ECONNRESET after connect
  };
  await scenario(handler, { keys: KEYS, maxAttempts: 4, firstByteMs: 300 }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', '{"stream":false}', 15_000);
    assert.equal(answer.statusCode, 502, answer.body);
    assert.equal(seen.length, 4);
    const parsed = JSON.parse(answer.body);
    assert.deepEqual(Object.keys(parsed).sort(), ['detail', 'error']);
    assert.equal(parsed.error, 'All failover attempts exhausted');
    // Parts follow attempt order (key rotation order), so compare them as a set.
    const match = /^4 keys tried: (.+)\.$/.exec(parsed.detail);
    assert.ok(match, parsed.detail);
    assert.deepEqual(match[1].split(', ').sort(), ['1 did not answer in time', '1 dropped the connection', '1 returned HTTP 500', '1 returned HTTP 503']);
    const retryAfter = Number(answer.retryAfter);
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After ${answer.retryAfter}`);
    assert.equal(answer.body.includes(SENTINEL), false, 'wire body');
    assert.equal(/fake-key|test-key/.test(answer.body), false, 'no key ids/values');
    await sleep(1_100);
    assert.equal(fs.readFileSync(gateway.logPath, 'utf8').includes(SENTINEL), false, 'gateway log file');
    const recent = await request(gateway.port + 1, 'GET', '/admin/logs', { token: ADMIN_TOKEN });
    assert.equal(recent.statusCode, 200);
    assert.equal(recent.body.includes(SENTINEL), false, 'getRecentLogs()');
  });
});

// ---- Fix 3 ---------------------------------------------------------------

test('Fix 3: real 503 + a key that dropped the connection -> "could not be reached" wording', { timeout: 30_000 }, async () => {
  const handler = (req, res) => {
    if (req.headers.authorization === `Bearer ${KEYS[0]}`) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"busy"}'); return; }
    req.socket.destroy();
  };
  await scenario(handler, { keys: KEYS.slice(0, 2), maxAttempts: 2 }, async (gateway) => {
    const answer = await post(gateway.port, '/v1/chat/completions', '{"stream":false}');
    assert.equal(answer.statusCode, 503);
    assert.equal(answer.body, '{"error":"Upstream returned HTTP 503; some keys could not be reached or did not answer."}');
  });
});

test('Fix 3: real 503 + a key cut by the request deadline -> deadline wording kept', { timeout: 30_000 }, async () => {
  const handler = (req, res) => {
    if (req.headers.authorization === `Bearer ${KEYS[0]}`) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"busy"}'); return; }
    // silent until the request deadline cuts it
  };
  await scenario(handler, { keys: KEYS.slice(0, 2), maxAttempts: 2, deadlineMs: 1_000, firstByteMs: 5_000 }, async (gateway) => {
    const answer = await post(gateway.port, '/v1/chat/completions', '{"stream":false}');
    assert.equal(answer.statusCode, 503);
    assert.equal(answer.body, '{"error":"Upstream returned HTTP 503; not every key answered before the request deadline."}');
  });
});

// ---- N1: /v1/models generic 502 carries the same truthful `detail` -------

const getModels = (port, timeoutMs) => request(port, 'GET', '/v1/models', { timeoutMs });
const MODELS_ROUTES = { [KEYS[1]]: { lookupError: { code: 'ECONNREFUSED', message: `connect ECONNREFUSED ${SENTINEL}` } } };
const modelsMixed = (req, res) => {
  const auth = req.headers.authorization;
  if (auth === `Bearer ${KEYS[0]}`) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: SENTINEL })); return; }
  if (auth === `Bearer ${KEYS[2]}`) return; // silent -> models socket timeout
  req.socket.destroy(); // KEYS[3]: connection dropped
};
const MODELS_OPTS = { keys: KEYS, maxAttempts: 4, routes: MODELS_ROUTES, modelsTimeoutMs: 400 };

test('N1 (g): /v1/models mixed 500 + refused + timeout + hang-up -> 502, error unchanged, truthful detail', { timeout: 30_000 }, async () => {
  await scenario(() => {}, MODELS_OPTS, async (gateway) => {
    const answer = await getModels(gateway.port, 15_000);
    assert.equal(answer.statusCode, 502, answer.body);
    const parsed = JSON.parse(answer.body);
    assert.deepEqual(Object.keys(parsed), ['error', 'detail'], 'full body: error + additive detail only');
    assert.equal(parsed.error, 'All failover attempts exhausted');
    const match = /^4 keys tried: (.+)\.$/.exec(parsed.detail);
    assert.ok(match, parsed.detail);
    assert.deepEqual(match[1].split(', ').sort(), ['1 could not be reached', '1 did not answer in time', '1 dropped the connection', '1 returned HTTP 500']);
    const retryAfter = Number(answer.retryAfter);
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After ${answer.retryAfter}`);
  }, modelsMixed);
});

test('N1 (h): /v1/models sentinel never reaches the body, the log file or getRecentLogs()', { timeout: 30_000 }, async () => {
  await scenario(() => {}, MODELS_OPTS, async (gateway) => {
    const answer = await getModels(gateway.port, 15_000);
    assert.equal(answer.statusCode, 502);
    assert.equal(answer.body.includes(SENTINEL), false, 'wire body');
    assert.equal(/fake-key|test-key/.test(answer.body), false, 'no key ids/values');
    await sleep(1_100);
    assert.equal(fs.readFileSync(gateway.logPath, 'utf8').includes(SENTINEL), false, 'gateway log file');
    const recent = await request(gateway.port + 1, 'GET', '/admin/logs', { token: ADMIN_TOKEN });
    assert.equal(recent.statusCode, 200);
    assert.equal(recent.body.includes(SENTINEL), false, 'getRecentLogs()');
  }, modelsMixed);
});

// ---- N2: `\r\n\r` (CRLF line + CR blank line) is a frame end ------------

const X = 'data: {"choices":[{"delta":{"content":"x"}}]}';
const Y = 'data: {"choices":[{"delta":{"content":"y"}}]}';

test('N2 (i): content + `data: [DONE]\\r\\n\\r` at EOF -> one well-formed DONE, no re-appended bytes', { timeout: 30_000 }, async () => {
  await scenario(sseChunks(CONTENT, 'data: [DONE]\r\n\r'), { keys: KEYS.slice(0, 1) }, async (gateway) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended');
    assert.equal(answer.body, `${CONTENT}data: [DONE]\r\n\r`);
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['completed']);
    assert.equal(penalties(entries), 0);
  });
});

test('N2: mid-stream `\\r\\n\\r` separates content from [DONE] -> clean end, success', { timeout: 30_000 }, async () => {
  await scenario(sseChunks(CONTENT, `${X}\r\n\rdata: [DONE]\r\n\r\n`), { keys: KEYS.slice(0, 1) }, async (gateway) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended');
    assert.equal(answer.body, `${CONTENT}${X}\r\n\rdata: [DONE]\r\n\r\n`);
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['completed']);
    assert.equal(penalties(entries), 0);
  });
});

test('N2 Anthropic: mid-stream `\\r\\n\\r` -> both deltas, normal stop, success', { timeout: 30_000 }, async () => {
  await scenario(sseChunks(`${X}\r\n\r${Y}\r\n\rdata: [DONE]\r\n\r\n`), { keys: KEYS.slice(0, 1) }, async (gateway) => {
    const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_SSE);
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended');
    assert.equal(answer.body.includes('event: error'), false, answer.body);
    assert.equal((answer.body.match(/event: content_block_delta/g) || []).length, 2);
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['completed']);
  });
});

// (j) chunk boundary: `\r\n\r` at a chunk end followed by `\n` in the next chunk
// is ONE `\r\n\r\n` separator: 2 events, never 3 (no empty event, no split frame).
for (const route of ['/v1/chat/completions', '/v1/messages']) {
  test(`N2 (j) ${route}: \`data: x\\r\\n\\r\` | \`\\ndata: y\\r\\n\\r\\n\` -> exactly 2 events`, { timeout: 30_000 }, async () => {
    await scenario(sseChunks(`${X}\r\n\r`, `\n${Y}\r\n\r\n`, 'data: [DONE]\n\n'), { keys: KEYS.slice(0, 1) }, async (gateway) => {
      const answer = await post(gateway.port, route, route === '/v1/messages' ? ANTHROPIC_SSE : OPENAI_SSE);
      assert.equal(answer.statusCode, 200);
      assert.equal(answer.terminal, 'ended');
      if (route === '/v1/messages') {
        assert.equal(answer.body.includes('event: error'), false, answer.body);
        assert.equal((answer.body.match(/event: content_block_delta/g) || []).length, 2);
      } else {
        assert.equal(answer.body, `${X}\r\n\r\n${Y}\r\n\r\ndata: [DONE]\n\n`, 'verbatim, nothing re-appended');
      }
      assert.deepEqual(outcomesOf(await logs(gateway.logPath)), ['completed']);
    });
  });
}

// ---- N2 regression: every SSE line ending (CRLF / LF / CR) inside a frame ----
// A frame may start with a leftover CR/LF of a blank line and may hold lone-CR
// line ends; [DONE] must still be seen (completed, no penalty) on every path.

const C = 'data: {"choices":[{"delta":{"content":"hello"}}]}';
const BENIGN = 'data: {"choices":[]}';
const LINE_END_CASES = [
  // (k) CRLF line, CR blank line, CR blank line (audit input)
  ['(k) committed `\\r\\n\\r\\r`', [`${C}\r\n\r\rdata: [DONE]\r\n\r\n`]],
  ['(k) committed `\\r\\n\\r` | `\\r...` chunk split', [`${C}\r\n\r`, '\rdata: [DONE]\r\n\r\n']],
  // (l) lone-CR stream: a comment and [DONE] in one frame, CR line ends only
  ['(l) lone-CR', [`${C}\r\r: keepalive\rdata: [DONE]\r\r`]],
  // (m) mixed `\r\r\n` (CR line + CRLF blank line)
  ['(m) mixed `\\r\\r\\n`', [`${C}\r\r\n: c\rdata: [DONE]\r\r\n`]],
  // (n) matrix finding: LF line + CR blank line (`\n\r`), LF line + CRLF blank (`\n\r\n`)
  ['(n) mixed `\\n\\r` / `\\n\\r\\n`', [`${C}\n\r\n${C}\n\rdata: [DONE]\n\n`]]
];

test('N2 (k) pre-commit: benign + `\\r\\n\\r\\r` + [DONE] -> valid empty completion, no penalty', { timeout: 30_000 }, async () => {
  const stream = `${BENIGN}\r\n\r\rdata: [DONE]\r\n\r\n`;
  await scenario(sseChunks(stream), { keys: KEYS.slice(0, 1) }, async (gateway, seen) => {
    const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended');
    assert.equal(answer.body, stream);
    assert.equal(seen.length, 1, 'no failover');
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['completed']);
    assert.equal(penalties(entries), 0);
    assert.deepEqual(await flushedAccounting(gateway), { [KEYS[0]]: SERVED });
  });
});

for (const [label, chunks] of LINE_END_CASES) {
  test(`N2 ${label} /v1/chat/completions -> completed, verbatim, no penalty`, { timeout: 30_000 }, async () => {
    await scenario(sseChunks(...chunks), { keys: KEYS.slice(0, 1) }, async (gateway) => {
      const answer = await post(gateway.port, '/v1/chat/completions', OPENAI_SSE);
      assert.equal(answer.statusCode, 200);
      assert.equal(answer.terminal, 'ended');
      assert.equal(answer.body, chunks.join(''), 'verbatim, nothing re-appended');
      const entries = await logs(gateway.logPath);
      assert.deepEqual(outcomesOf(entries), ['completed']);
      assert.equal(penalties(entries), 0);
      assert.deepEqual(await flushedAccounting(gateway), { [KEYS[0]]: SERVED });
    });
  });
  test(`N2 ${label} /v1/messages -> normal stop, completed, no penalty`, { timeout: 30_000 }, async () => {
    await scenario(sseChunks(...chunks), { keys: KEYS.slice(0, 1) }, async (gateway) => {
      const answer = await post(gateway.port, '/v1/messages', ANTHROPIC_SSE);
      assert.equal(answer.statusCode, 200);
      assert.equal(answer.terminal, 'ended');
      assert.equal(answer.body.includes('event: error'), false, answer.body);
      assert.ok(answer.body.endsWith('event: message_stop\ndata: {}\n\n'), 'well-formed end');
      const entries = await logs(gateway.logPath);
      assert.deepEqual(outcomesOf(entries), ['completed']);
      assert.equal(penalties(entries), 0);
      assert.deepEqual(await flushedAccounting(gateway), { [KEYS[0]]: SERVED });
    });
  });
}

test.after(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); });
