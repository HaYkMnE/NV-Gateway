// Э3 rest: cohort L key churn during a request (decision 2a) plus the verdict
// coverage matrix (uniform / mixed / non-uniform / 403 / upstream-vs-gateway 504 /
// /v1/models pins / sentinel). Fake keys and a local fake upstream only; per-key
// DNS routes come from tests/e3-infra-preload.cjs (test-only).
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
const preloadPath = path.join(projectRoot, 'tests', 'e3-infra-preload.cjs');
const serverPath = path.join(projectRoot, 'src', 'gateway', 'server.mjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-e3r-${process.pid}-`));
// Unique per test process so a foreign gateway on a raced port never shares our token.
const TOKEN = `test-gateway-${randomUUID()}`;
const ADMIN_TOKEN = 'test-admin-token';
const KEYS = ['fake-key-a', 'fake-key-b', 'fake-key-c'];
const DNS_HOST = 'nvgw-e3r-test.invalid';
// DNS failure (ENOTFOUND), delivered through net's own lookup error path with the
// real errno (e3-infra-preload `lookupError` route), so server.mjs classifyInfraError
// still maps it to infra_dns. A real `.invalid` lookup hit the OS resolver and was
// not deterministic (a slow resolver turns the fast ENOTFOUND into a timeout).
const DNS_ROUTE = { lookupError: { code: 'ENOTFOUND', message: `getaddrinfo ENOTFOUND ${DNS_HOST}` } };
const OPENAI_JSON = '{"stream":false}';
const ANTHROPIC_JSON = JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10 });
const OK_JSON = '{"choices":[{"message":{"content":"ok"}}]}';
const SENTINEL = 'E3R-SENTINEL-9c2f41-do-not-leak';
const DEADLINE_BODY = '{"error":"Gateway request deadline exceeded"}';
const EXHAUSTED = 'All failover attempts exhausted';
const mixedBody = (s) => JSON.stringify({ error: `Upstream returned HTTP ${s}; some keys could not be reached or did not answer.` });
const UNIFORM_MESSAGE = {
  429: 'Upstream rate limit: every available key is currently rate-limited.',
  500: 'Upstream error: every available key returned an internal server error (500).',
  502: 'Upstream error: every available key returned a bad gateway (502).',
  503: 'Upstream error: every available key is unavailable (503).',
  504: 'Upstream error: every available key timed out (504).',
  529: 'Upstream returned HTTP 529 for every available key.'
};
// Gateway pairs come from highPortReservation() (20000-59999), never 12000/12001/12004/12005.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gone = (c) => c.exitCode !== null || c.signalCode !== null;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function request(port, method, pathname, { body, token = TOKEN, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${token}` };
    if (body !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.once('end', () => resolve({ statusCode: response.statusCode, body: text }));
      response.once('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('client timeout')));
    req.once('error', reject);
    req.end(body);
  });
}
const postChat = (port) => request(port, 'POST', '/v1/chat/completions', { body: OPENAI_JSON, timeoutMs: 15_000 });
const postMessages = (port) => request(port, 'POST', '/v1/messages', { body: ANTHROPIC_JSON, timeoutMs: 15_000 });
const admin = (gateway, method, pathname, body) => request(gateway.port + 1, method, pathname, { body, token: ADMIN_TOKEN });

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

async function startGateway(upstreamPort, { keys, routes = {}, deadlineMs = 60_000, maxAttempts, firstByteMs = 2_000 }) {
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
        // UUID ids: the admin DELETE route only accepts UUIDs.
        const stateKeys = keys.map((key, index) => ({ id: randomUUID(), key, status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: index } }));
        const child = spawnChild(process.execPath, ['--require', preloadPath, serverPath], {
          env: {
            ...process.env,
            PORT: String(port),
            GATEWAY_LOG_PATH: logPath,
            GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstreamPort),
            GATEWAY_FIRST_BYTE_TIMEOUT_MS: String(firstByteMs),
            GATEWAY_IDLE_TIMEOUT_MS: '2000',
            GATEWAY_REQUEST_DEADLINE_MS: String(deadlineMs),
            GATEWAY_TEST_E3_ROUTES: JSON.stringify(routes),
            ...(maxAttempts === undefined ? {} : { GATEWAY_MAX_FAILOVER_ATTEMPTS: String(maxAttempts) })
          },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          windowsHide: true
        });
        const detachCollisionWatch = killOnBindCollision(child);
        child.once('message', (message) => {
          if (message?.type === 'ready') child.send({ type: 'state:init', challenge: message.challenge, state: { keys: stateKeys, credentials: { gatewayToken: TOKEN, adminToken: ADMIN_TOKEN } } });
        });
        const persisted = [];
        child.on('message', (message) => {
          if (message?.type !== 'state:persist') return;
          persisted.push(message.state);
          // Durable admin mutations wait for the "main process" acknowledgement.
          if (typeof message.requestId === 'string') {
            try { child.send({ type: 'state:persist:ack', requestId: message.requestId, revision: message.revision }); } catch { /* exited */ }
          }
        });
        current = { child, detachCollisionWatch, logPath, persisted, ids: Object.fromEntries(stateKeys.map((k) => [k.key, k.id])) };
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
    try { if ((await request(port, 'GET', '/health', { timeoutMs: 1_000 })).statusCode === 200) return { child, port, logPath: current.logPath, persisted: current.persisted, ids: current.ids }; } catch { /* starting */ }
    await sleep(25);
  }
  await stopGateway(child);
  throw new Error('gateway did not become healthy');
}

async function logText(logPath) {
  await sleep(1_100); // logger flush interval
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}
const parseLog = (text) => text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const exhaustedEntry = (entries) => entries.find((e) => e.message === 'All failover attempts exhausted');

// handlers: { chat(req, res, hit), models(req, res) } where hit = per-key call index (1-based).
async function scenario(handlers, options, run) {
  const seen = [];
  const perKey = new Map();
  const upstream = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const auth = String(req.headers.authorization ?? '');
      const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      seen.push(`${req.url} ${key}`);
      if (req.url === '/v1/models') {
        if (handlers.models) { handlers.models(req, res, key); return; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return;
      }
      const hit = (perKey.get(key) ?? 0) + 1;
      perKey.set(key, hit);
      handlers.chat(req, res, key, hit);
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
const reply = (res, status, body = '{"error":"upstream"}') => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); };
const hangUp = (req) => req.socket.destroy();
const chatHits = (seen, key) => seen.filter((s) => s === `/v1/chat/completions ${key}`).length;

// ---------------------------------------------------------------------------
// A. Cohort L: key churn during one request (decision 2a).
// ---------------------------------------------------------------------------

test('L1: A fails DNS, A removed mid-request, B hangs up then returns 503 in pass 2 -> mixed wording, not uniform', { timeout: 60_000 }, async () => {
  const bHeld = deferred();
  const release = deferred();
  const routes = { [KEYS[0]]: DNS_ROUTE };
  await scenario({
    chat: async (req, res, key, hit) => {
      if (hit === 1) { bHeld.resolve(); await release.promise; hangUp(req); return; }
      reply(res, 503, `{"error":"${SENTINEL}"}`);
    }
  }, { keys: KEYS.slice(0, 2), routes, maxAttempts: 4 }, async (gateway, seen) => {
    const pending = postChat(gateway.port);
    await bHeld.promise; // A already failed DNS; B is in flight
    assert.equal((await admin(gateway, 'DELETE', `/admin/keys/${gateway.ids[KEYS[0]]}`)).statusCode, 200);
    release.resolve();
    const answer = await pending;
    assert.equal(answer.statusCode, 503);
    assert.equal(answer.body, mixedBody(503), 'the removed key keeps its "could not be reached" mark across passes');
    assert.equal(chatHits(seen, KEYS[1]), 2, 'B served pass 1 and pass 2');
    const text = await logText(gateway.logPath);
    const entry = exhaustedEntry(parseLog(text));
    assert.equal(entry.poolWide, false, 'no all-keys claim while a removed key never answered');
    // Sentinel (churn case): an upstream error body never leaks.
    assert.ok(!answer.body.includes(SENTINEL));
    assert.ok(!text.includes(SENTINEL), 'gateway log');
    const recent = await admin(gateway, 'GET', '/admin/logs');
    assert.equal(recent.statusCode, 200);
    assert.ok(!recent.body.includes(SENTINEL), '/admin/logs');
  });
});

test('L2: key C added mid-request after A and B failed -> C is tried and its success returned', { timeout: 60_000 }, async () => {
  // A=500 and B=502 (different, so no uniform early stop) both FAIL in pass 1.
  // Pass 2 re-picks A and the upstream holds it; only then is C added. A's
  // second attempt is released after the add, and the next pick must be C.
  const aSecondHeld = deferred();
  const release = deferred();
  const order = [];
  const C_OK_JSON = '{"choices":[{"message":{"content":"served-by-key-c"}}]}';
  await scenario({
    chat: async (_req, res, key, hit) => {
      if (key === KEYS[0] && hit === 1) { order.push('A#1 500'); reply(res, 500); return; }
      if (key === KEYS[1]) { order.push(`B#${hit} 502`); reply(res, 502); return; }
      if (key === KEYS[0]) { order.push(`A#${hit} held`); aSecondHeld.resolve(); await release.promise; order.push(`A#${hit} 500`); reply(res, 500); return; }
      order.push(`C#${hit} 200`);
      reply(res, 200, C_OK_JSON);
    }
  }, { keys: KEYS.slice(0, 2), maxAttempts: 4 }, async (gateway, seen) => {
    const pending = postChat(gateway.port);
    await aSecondHeld.promise;
    assert.equal(chatHits(seen, KEYS[2]), 0, 'C unknown before the add');
    assert.equal((await admin(gateway, 'POST', '/admin/keys', JSON.stringify({ key: KEYS[2] }))).statusCode, 201);
    order.push('C added');
    release.resolve();
    const answer = await pending;
    assert.deepEqual(order, ['A#1 500', 'B#1 502', 'A#2 held', 'C added', 'A#2 500', 'C#1 200'], 'C was added only after A and B had failed');
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.body, C_OK_JSON, 'the 200 body is key C\'s');
    assert.equal(chatHits(seen, KEYS[2]), 1, 'the added key joins the running request exactly once');
    assert.equal(chatHits(seen, KEYS[0]), 2);
    assert.equal(chatHits(seen, KEYS[1]), 1);
  });
});

test('L3: a key removed while in flight is never retried in pass 2', { timeout: 60_000 }, async () => {
  const aHeld = deferred();
  const release = deferred();
  await scenario({
    chat: async (req, res, key, hit) => {
      if (key === KEYS[0]) { aHeld.resolve(); await release.promise; hangUp(req); return; }
      if (hit === 1) { hangUp(req); return; }
      reply(res, 200, OK_JSON);
    }
  }, { keys: KEYS.slice(0, 2), maxAttempts: 4 }, async (gateway, seen) => {
    const pending = postChat(gateway.port);
    await aHeld.promise;
    assert.equal((await admin(gateway, 'DELETE', `/admin/keys/${gateway.ids[KEYS[0]]}`)).statusCode, 200);
    release.resolve();
    const answer = await pending;
    assert.equal(answer.statusCode, 200);
    assert.equal(chatHits(seen, KEYS[0]), 1, 'removed key not selected again');
    assert.equal(chatHits(seen, KEYS[1]), 2);
  });
});

test('L4: a removed in-flight key\'s result is recorded exactly once', { timeout: 60_000 }, async () => {
  const aHeld = deferred();
  const release = deferred();
  await scenario({
    chat: async (_req, res, key) => {
      if (key === KEYS[0]) { aHeld.resolve(); await release.promise; reply(res, 500); return; }
      reply(res, 502);
    }
  }, { keys: KEYS.slice(0, 2), maxAttempts: 2 }, async (gateway) => {
    const pending = postChat(gateway.port);
    await aHeld.promise;
    const removedId = gateway.ids[KEYS[0]];
    assert.equal((await admin(gateway, 'DELETE', `/admin/keys/${removedId}`)).statusCode, 200);
    release.resolve();
    const answer = await pending;
    assert.equal(answer.statusCode, 502);
    assert.deepEqual(JSON.parse(answer.body), { error: EXHAUSTED, detail: '2 keys tried: 1 returned HTTP 500, 1 returned HTTP 502.' });
    const entries = parseLog(await logText(gateway.logPath));
    assert.equal(entries.filter((e) => e.message === 'request_outcome' && e.id === removedId).length, 1);
    assert.equal(exhaustedEntry(entries).keysTried, 2);
  });
});

// ---------------------------------------------------------------------------
// B. Coverage matrix (tests only, behavior pinned).
// ---------------------------------------------------------------------------

// 429 last: its 20 s cooldown must not shape the other statuses on the shared gateway.
const UNIFORM_STATUSES = [500, 502, 503, 504, 529, 429];
for (const n of [1, 2, 3]) {
  test(`B uniform n=${n}: every key returns s -> s with the all-keys body and Anthropic type`, { timeout: 90_000 }, async () => {
    let status = 0;
    await scenario({ chat: (_req, res) => reply(res, status, '{"error":"busy"}') }, { keys: KEYS.slice(0, n), maxAttempts: n }, async (gateway) => {
      for (const s of UNIFORM_STATUSES) {
        status = s;
        const openai = await postChat(gateway.port);
        assert.equal(openai.statusCode, s, `openai n=${n} s=${s}`);
        assert.equal(openai.body, JSON.stringify({ error: UNIFORM_MESSAGE[s] }), `openai body n=${n} s=${s}`);
        const anthropic = await postMessages(gateway.port);
        assert.equal(anthropic.statusCode, s, `anthropic n=${n} s=${s}`);
        // Full envelope, as written by writePoolWideFailure (server.mjs anthropic branch).
        assert.deepEqual(JSON.parse(anthropic.body), { type: 'error', error: { type: s === 429 ? 'rate_limit_error' : 'overloaded_error', message: UNIFORM_MESSAGE[s] } }, `anthropic body n=${n} s=${s}`);
      }
    });
  });
}

for (const s of [503, 500]) {
  for (const order of ['dns-first', 'status-first']) {
    test(`B mixed ${order} s=${s}: DNS key + real ${s} -> ${s} with "could not be reached" wording`, { timeout: 60_000 }, async () => {
      const dnsKey = order === 'dns-first' ? KEYS[0] : KEYS[1];
      await scenario({ chat: (_req, res) => reply(res, s, `{"error":"${SENTINEL}"}`) }, { keys: KEYS.slice(0, 2), routes: { [dnsKey]: DNS_ROUTE }, maxAttempts: 2 }, async (gateway, seen) => {
        const answer = await postChat(gateway.port);
        assert.equal(answer.statusCode, s);
        assert.equal(answer.body, mixedBody(s));
        assert.equal(seen.filter((x) => x.startsWith('/v1/chat/completions')).length, 1, 'only the reachable key hit the upstream');
        if (s === 503 && order === 'dns-first') {
          assert.ok(!(await logText(gateway.logPath)).includes(SENTINEL), 'gateway log');
          assert.ok(!(await admin(gateway, 'GET', '/admin/logs')).body.includes(SENTINEL), '/admin/logs');
        }
      });
    });
  }
}

test('B two statuses 500 -> 502: generic 502 with detail', { timeout: 60_000 }, async () => {
  await scenario({ chat: (_req, res, key) => reply(res, key === KEYS[0] ? 500 : 502) }, { keys: KEYS.slice(0, 2), maxAttempts: 2 }, async (gateway) => {
    const answer = await postChat(gateway.port);
    assert.equal(answer.statusCode, 502);
    assert.deepEqual(JSON.parse(answer.body), { error: EXHAUSTED, detail: '2 keys tried: 1 returned HTTP 500, 1 returned HTTP 502.' });
  });
});

test('B 403 end-to-end: a per-key 403 is not a pool verdict -> generic 502 with detail', { timeout: 60_000 }, async () => {
  await scenario({ chat: (_req, res) => reply(res, 403, '{"error":"forbidden"}') }, { keys: KEYS.slice(0, 1), maxAttempts: 1 }, async (gateway) => {
    const answer = await postChat(gateway.port);
    assert.equal(answer.statusCode, 502);
    assert.deepEqual(JSON.parse(answer.body), { error: EXHAUSTED, detail: '1 key tried: 1 returned HTTP 403.' });
  });
});

test('B upstream 504 (every key) vs gateway 504 (deadline): status, body, Anthropic type and log differ', { timeout: 60_000 }, async () => {
  let upstream;
  await scenario({ chat: (_req, res) => reply(res, 504) }, { keys: KEYS.slice(0, 2), maxAttempts: 2 }, async (gateway) => {
    const openai = await postChat(gateway.port);
    const anthropic = await postMessages(gateway.port);
    const entry = exhaustedEntry(parseLog(await logText(gateway.logPath)));
    upstream = { openai, anthropic, entry };
  });
  let deadline;
  await scenario({ chat: () => { /* never answers */ } }, { keys: KEYS.slice(0, 2), maxAttempts: 2, deadlineMs: 800, firstByteMs: 5_000 }, async (gateway) => {
    const openai = await postChat(gateway.port);
    const anthropic = await postMessages(gateway.port);
    const entry = exhaustedEntry(parseLog(await logText(gateway.logPath)));
    deadline = { openai, anthropic, entry };
  });
  assert.equal(upstream.openai.statusCode, 504);
  assert.equal(deadline.openai.statusCode, 504);
  assert.equal(upstream.openai.body, JSON.stringify({ error: UNIFORM_MESSAGE[504] }));
  assert.equal(deadline.openai.body, DEADLINE_BODY);
  assert.equal(upstream.anthropic.statusCode, 504);
  assert.equal(deadline.anthropic.statusCode, 504);
  assert.deepEqual(JSON.parse(upstream.anthropic.body), { type: 'error', error: { type: 'overloaded_error', message: UNIFORM_MESSAGE[504] } });
  assert.deepEqual(JSON.parse(deadline.anthropic.body), { type: 'error', error: { type: 'request_timeout', message: 'Gateway request deadline exceeded' } });
  assert.notEqual(upstream.anthropic.body, deadline.anthropic.body);
  assert.equal(upstream.entry.upstreamStatus, 504);
  assert.equal(upstream.entry.poolWide, true);
  assert.equal(deadline.entry.upstreamStatus, null);
  assert.equal(deadline.entry.earlyStopReason, 'request_deadline');
});

test('B /v1/models with 0 keys: pinned answer, no upstream call', { timeout: 60_000 }, async () => {
  await scenario({ chat: (_req, res) => reply(res, 200, OK_JSON) }, { keys: [] }, async (gateway, seen) => {
    const answer = await request(gateway.port, 'GET', '/v1/models');
    assert.equal(answer.statusCode, 503);
    assert.equal(answer.body, '{"error":"All API keys exhausted"}');
    assert.equal(seen.filter((x) => x !== '/v1/models ').length, 0, 'no keyed upstream call');
  });
});

test('B /v1/models: warm + manual refresh are not client attempts; attempts are per pathname', { timeout: 60_000 }, async () => {
  // Keyless (warm/refresh) catalogue fetches answer 200; keyed client attempts answer 500.
  const models = (_req, res, key) => (key ? reply(res, 500) : reply(res, 200, '{"data":[]}'));
  await scenario({ chat: (_req, res) => reply(res, 200, OK_JSON), models }, { keys: KEYS.slice(0, 2), maxAttempts: 2 }, async (gateway, seen) => {
    const refresh = await request(gateway.port, 'POST', '/v1/models/refresh', { token: ADMIN_TOKEN });
    assert.equal(refresh.statusCode, 200);
    const keyless = () => seen.filter((x) => x === '/v1/models ').length;
    assert.ok(keyless() >= 1, 'the refresh fetched the catalogue without a key');
    const answer = await request(gateway.port, 'GET', '/v1/models');
    // Uniform real 500 on /v1/models stays the generic 502 (separate owner decision, spec :58).
    assert.equal(answer.statusCode, 502);
    assert.deepEqual(JSON.parse(answer.body), { error: EXHAUSTED, detail: '2 keys tried: 2 returned HTTP 500.' });
    assert.equal(seen.filter((x) => x.startsWith('/v1/models fake-key')).length, 2, 'exactly the client attempts carried keys');
    const bare = await request(gateway.port, 'GET', '/models');
    assert.equal(bare.statusCode, 404, '/models is not a models route');
    assert.equal(seen.filter((x) => x.startsWith('/v1/models fake-key')).length, 2, '/models made no keyed attempt');
  });
});

test.after(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); });
