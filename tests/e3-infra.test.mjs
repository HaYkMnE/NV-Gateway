// Э3 (plan 12.9.4, spec :41, owner decision 1a): connect-time INFRA failures
// (DNS ENOTFOUND / EAI_AGAIN, ECONNREFUSED) are not a key verdict. They move the
// request to the next DISTINCT key without penalty; a pass made only of
// infra/silent keys ends with the neutral 503; the request deadline answers 504.
// The same applies to /v1/models. ECONNRESET after connect keeps today's path.
// Per-key upstream routing comes from tests/e3-infra-preload.cjs (test-only).
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
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-e3-${process.pid}-`));
// Unique per test process so a foreign gateway on a raced port never shares our token.
const TOKEN = `test-gateway-${randomUUID()}`;
const ADMIN_TOKEN = 'test-admin-token';
const NEUTRAL_BODY = '{"error":"Upstream temporarily unavailable"}';
const DEADLINE_BODY = '{"error":"Gateway request deadline exceeded"}';
const EXHAUSTED_BODY = '{"error":"All failover attempts exhausted"}';
// Chat and /v1/models generic 502s carry the additive key-free `detail` (owner 28.09).
const CHAT_HANGUP_EXHAUSTED_BODY = '{"error":"All failover attempts exhausted","detail":"1 key tried: 1 dropped the connection."}';
const MODELS_STALL_1_EXHAUSTED_BODY = '{"error":"All failover attempts exhausted","detail":"1 key tried: 1 did not answer in time."}';
const MODELS_STALL_2_EXHAUSTED_BODY = '{"error":"All failover attempts exhausted","detail":"2 keys tried: 2 did not answer in time."}';
const OPENAI_JSON = '{"stream":false}';
const OK_JSON = '{"choices":[{"message":{"content":"ok"}}]}';
const KEYS = ['fake-key-a', 'fake-key-b', 'fake-key-c'];
const DNS_HOST = 'nvgw-e3-test.invalid';
// DNS failure (ENOTFOUND), delivered through net's own lookup error path with the
// real errno, like REFUSED_ROUTE below. A real `.invalid` lookup hit the OS resolver
// and was not deterministic: a slow resolver turned the fast ENOTFOUND into a timeout.
const DNS_ROUTE = { lookupError: { code: 'ENOTFOUND', message: `getaddrinfo ENOTFOUND ${DNS_HOST}` } };
// Connection refused, delivered through net's own error path with the real errno
// (server.mjs classifyInfraError reads only err.code / err.cause.code). A real
// "bound then closed" port is not deterministic under the parallel suite: another
// file can take it between close and connect (observed: 404 instead of 503).
const REFUSED_ROUTE = { lookupError: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED synthetic' } };
// Gateway pairs come from highPortReservation() (20000-59999), which never
// overlaps the live app's 12000/12001 or 12004/12005.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gone = (c) => c.exitCode !== null || c.signalCode !== null;

function request(port, method, pathname, { body, token = TOKEN, timeoutMs = 5_000 } = {}) {
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
const postChat = (port, timeoutMs) => request(port, 'POST', '/v1/chat/completions', { body: OPENAI_JSON, timeoutMs });
const getModels = (port, timeoutMs) => request(port, 'GET', '/v1/models', { timeoutMs });

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

async function startGateway(upstreamPort, { keys, routes = {}, deadlineMs = 60_000, maxAttempts, firstByteMs = 2_000, modelsTimeoutMs }) {
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
    const logPath = path.join(dir, 'gateway.jsonl');
    assert.equal(fs.existsSync(logPath), false, 'fresh log per gateway');
    const state = { keys: keys.map((key, index) => ({ id: `test-key-${index}`, key, status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: index } })) };
    const child = spawnChild(process.execPath, ['--require', preloadPath, serverPath], {
      env: {
        ...process.env,
        PORT: String(port),
        GATEWAY_LOG_PATH: logPath,
        GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstreamPort),
        GATEWAY_TEST_E3_ROUTES: JSON.stringify(routes),
        GATEWAY_FIRST_BYTE_TIMEOUT_MS: String(firstByteMs),
        GATEWAY_IDLE_TIMEOUT_MS: '2000',
        GATEWAY_REQUEST_DEADLINE_MS: String(deadlineMs),
        ...(maxAttempts === undefined ? {} : { GATEWAY_MAX_FAILOVER_ATTEMPTS: String(maxAttempts) }),
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
  current.detachCollisionWatch(); // started.child is the last spawned child
  // ports:bound is attested; /health confirms the listener answers, within the total budget.
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
const verdictOf = (entries) => entries.find((e) => e.message === 'All failover attempts exhausted');

async function flushedAccounting(gateway) {
  const before = gateway.persisted.length;
  await stopGateway(gateway.child);
  for (let waited = 0; gateway.persisted.length === before && waited < 1_000; waited += 25) await sleep(25);
  assert.ok(gateway.persisted.length > before, 'shutdown must flush key state');
  return Object.fromEntries(gateway.persisted.at(-1).keys.map((k) => [k.key, { fail: k.usage.fail, success: k.usage.success, backedOff: k.backoffUntil > 0 }]));
}
const CLEAN = { fail: 0, success: 0, backedOff: false };
const SERVED = { fail: 0, success: 1, backedOff: false };
const FAILED_5XX = { fail: 1, success: 0, backedOff: true };

async function scenario(handlers, options, run) {
  const seen = [];
  const upstream = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      seen.push(`${req.url} ${req.headers.authorization}`);
      const handler = req.url === '/v1/models' ? handlers.models : handlers.chat;
      if (handler) handler(req, res); else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); }
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
const okChat = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(OK_JSON); };
const status500 = (_req, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"boom"}'); };
const chatHits = (seen) => seen.filter((s) => s.startsWith('/v1/chat/completions'));
// The exact outcome/errno a key's route must produce (DNS_ROUTE -> ENOTFOUND,
// REFUSED_ROUTE -> ECONNREFUSED). Anything else is a test-setup error.
const expectedInfra = (route) => {
  if (route?.lookupError?.code === 'ENOTFOUND') return { reason: 'infra_dns', code: 'ENOTFOUND' };
  if (route?.lookupError?.code === 'ECONNREFUSED') return { reason: 'infra_refused', code: 'ECONNREFUSED' };
  return { reason: 'unexpected-route', code: 'unexpected-route' };
};
// Key ids are re-minted as UUIDs on load (rotation.mjs:389): map a logged id back to
// its fake key through the last persisted state. Call after flushedAccounting().
const keyById = (gateway) => {
  const byId = new Map(gateway.persisted.at(-1).keys.map((k) => [k.id, k.key]));
  return (id) => byId.get(id) ?? `unknown-id:${id}`;
};

test('Э3 probe: the synthetic DNS route fails fast with ENOTFOUND through net\'s lookup path', { timeout: 15_000 }, async () => {
  const started = Date.now();
  const code = await new Promise((resolve) => {
    // Same shape the preload uses for DNS_ROUTE: net's lookup error path, no resolver.
    const req = http.request({
      hostname: DNS_HOST, port: 80, agent: false,
      lookup: (_host, _opts, callback) => callback(Object.assign(new Error(DNS_ROUTE.lookupError.message), { code: DNS_ROUTE.lookupError.code }))
    });
    req.once('error', (err) => resolve(err.code));
    req.end();
  });
  assert.equal(code, 'ENOTFOUND');
  assert.ok(Date.now() - started < 10_000, 'DNS failure is fast');
});

const infraRoutes = {
  dns: () => DNS_ROUTE,
  eai_again: () => ({ lookupError: { code: 'EAI_AGAIN', message: 'getaddrinfo EAI_AGAIN synthetic' } }),
  cause_enotfound: () => ({ lookupError: { causeCode: 'ENOTFOUND', message: 'wrapped lookup failure' } }),
  refused: () => REFUSED_ROUTE
};
const infraOutcome = { dns: 'infra_dns', eai_again: 'infra_dns', cause_enotfound: 'infra_dns', refused: 'infra_refused' };

for (const kind of Object.keys(infraRoutes)) {
  test(`Э3 chat: ${kind} on A then B succeeds -> 200, A no penalty, B served`, { timeout: 30_000 }, async () => {
    const routes = { [KEYS[0]]: await infraRoutes[kind]() };
    await scenario({ chat: okChat }, { keys: KEYS.slice(0, 2), routes }, async (gateway, seen) => {
      const answer = await postChat(gateway.port);
      assert.equal(answer.statusCode, 200);
      assert.equal(answer.body, OK_JSON);
      assert.deepEqual(chatHits(seen), [`/v1/chat/completions Bearer ${KEYS[1]}`]);
      const entries = await logs(gateway.logPath);
      assert.deepEqual(outcomesOf(entries), [infraOutcome[kind], 'completed']);
      assert.equal(penalties(entries), 0, 'infra error does not penalize the key');
      assert.deepEqual(await flushedAccounting(gateway), { [KEYS[0]]: CLEAN, [KEYS[1]]: SERVED });
    });
  });
}

for (const n of [1, 2, 3]) {
  test(`Э3 chat: all-infra n=${n} -> ${n} distinct attempts, neutral 503, no penalty`, { timeout: 30_000 }, async () => {
    const keys = KEYS.slice(0, n);
    const routes = {};
    for (const [i, key] of keys.entries()) routes[key] = i % 2 === 0 ? DNS_ROUTE : REFUSED_ROUTE;
    await scenario({ chat: okChat }, { keys, routes }, async (gateway, seen) => {
      const answer = await postChat(gateway.port, 15_000);
      assert.equal(answer.statusCode, 503);
      assert.equal(answer.body, NEUTRAL_BODY);
      assert.ok(Number(answer.retryAfter) >= 1, 'Retry-After present');
      assert.equal(chatHits(seen).length, 0);
      const entries = await logs(gateway.logPath);
      assert.equal(outcomesOf(entries).length, n, 'exactly one attempt per distinct key');
      // Key ids are re-minted as UUIDs on load (rotation.mjs:389), so count them.
      const tried = entries.filter((e) => e.message === 'Upstream infra error').map((e) => e.id);
      assert.equal(tried.length, n, 'one infra attempt per key');
      assert.equal(new Set(tried).size, n, 'every distinct key once');
      assert.equal(verdictOf(entries)?.earlyStopReason, 'idle_round');
      assert.equal(penalties(entries), 0);
      const accounting = await flushedAccounting(gateway);
      // Per attempt, by index: the outcome and errno must match THAT key's route
      // (a refused key misclassified as infra_dns must fail here, not just count).
      const keyOf = keyById(gateway);
      const attempts = entries.filter((e) => e.message === 'request_outcome');
      assert.deepEqual(attempts.map((e) => ({ key: keyOf(e.id), outcome: e.outcome })),
        attempts.map((e) => ({ key: keyOf(e.id), outcome: expectedInfra(routes[keyOf(e.id)]).reason })));
      assert.deepEqual(entries.filter((e) => e.message === 'Upstream infra error').map((e) => ({ key: keyOf(e.id), code: e.code })),
        attempts.map((e) => ({ key: keyOf(e.id), code: expectedInfra(routes[keyOf(e.id)]).code })));
      assert.deepEqual(accounting, Object.fromEntries(keys.map((k) => [k, CLEAN])));
    });
  });
}

test('Э3 chat: infra (A) + silent first-byte timeout (B) -> neutral 503', { timeout: 30_000 }, async () => {
  const routes = { [KEYS[0]]: DNS_ROUTE };
  await scenario({ chat: () => { /* silent: no headers */ } }, { keys: KEYS.slice(0, 2), routes, firstByteMs: 300 }, async (gateway) => {
    const answer = await postChat(gateway.port, 15_000);
    assert.equal(answer.statusCode, 503);
    assert.equal(answer.body, NEUTRAL_BODY);
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries).sort(), ['first_byte_timeout', 'infra_dns']);
    assert.equal(verdictOf(entries)?.earlyStopReason, 'idle_round');
  });
});

test('Э3 chat guard: ECONNRESET after connect keeps the 502 path and the key penalty', { timeout: 30_000 }, async () => {
  await scenario({ chat: (req) => req.socket.destroy() }, { keys: KEYS.slice(0, 1), maxAttempts: 1 }, async (gateway) => {
    const answer = await postChat(gateway.port);
    assert.equal(answer.statusCode, 502);
    assert.equal(answer.body, CHAT_HANGUP_EXHAUSTED_BODY);
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['upstream_stream_error']);
    assert.equal(penalties(entries), 1);
    assert.deepEqual(await flushedAccounting(gateway), { [KEYS[0]]: FAILED_5XX });
  });
});

test('Э3 chat mixed (S4, verdict unchanged): DNS on A + real HTTP 500 on B', { timeout: 30_000 }, async (t) => {
  const routes = { [KEYS[0]]: DNS_ROUTE };
  await scenario({ chat: status500 }, { keys: KEYS.slice(0, 2), routes, maxAttempts: 2 }, async (gateway) => {
    const answer = await postChat(gateway.port, 15_000);
    t.diagnostic(`mixed answer: ${answer.statusCode} ${answer.body}`);
    assert.equal(answer.statusCode, 500);
    const entries = await logs(gateway.logPath);
    const accounting = await flushedAccounting(gateway);
    assert.deepEqual(accounting[KEYS[0]], CLEAN, 'the DNS key is never penalized');
    assert.deepEqual(accounting[KEYS[1]], FAILED_5XX, 'the real 500 keeps its penalty');
    assert.equal(penalties(entries), 1);
  });
});

test('Э3 chat: request deadline shorter than the infra attempts -> 504', { timeout: 30_000 }, async () => {
  const slowLookup = { lookupError: { delayMs: 1_500, code: 'ENOTFOUND', message: 'slow lookup' } };
  const routes = Object.fromEntries(KEYS.map((k) => [k, slowLookup]));
  await scenario({ chat: okChat }, { keys: KEYS, routes, deadlineMs: 400 }, async (gateway) => {
    const started = Date.now();
    const answer = await postChat(gateway.port, 10_000);
    assert.equal(answer.statusCode, 504);
    assert.equal(answer.body, DEADLINE_BODY);
    assert.ok(Date.now() - started < 1_400, 'answered at the deadline, not after the slow lookup');
    const entries = await logs(gateway.logPath);
    assert.deepEqual(outcomesOf(entries), ['request_deadline']);
    assert.equal(penalties(entries), 0);
  });
});

test('Э3 models: DNS on A then B -> 200, A no penalty', { timeout: 30_000 }, async () => {
  const routes = { [KEYS[0]]: DNS_ROUTE };
  await scenario({}, { keys: KEYS.slice(0, 2), routes }, async (gateway, seen) => {
    const answer = await getModels(gateway.port);
    assert.equal(answer.statusCode, 200);
    assert.ok(seen.includes(`/v1/models Bearer ${KEYS[1]}`));
    const entries = await logs(gateway.logPath);
    assert.equal(entries.filter((e) => e.message === 'Upstream models infra error').length, 1, 'only key A hit the infra error');
    assert.equal(penalties(entries), 0);
    const accounting = await flushedAccounting(gateway);
    assert.deepEqual(accounting[KEYS[0]], CLEAN);
  });
});

for (const n of [1, 2, 3]) {
  test(`Э3 models: all-infra n=${n} -> ${n} distinct attempts, neutral 503, no penalty`, { timeout: 30_000 }, async () => {
    const keys = KEYS.slice(0, n);
    const routes = {};
    for (const [i, key] of keys.entries()) routes[key] = i % 2 === 0 ? DNS_ROUTE : REFUSED_ROUTE;
    await scenario({}, { keys, routes }, async (gateway) => {
      const answer = await getModels(gateway.port, 15_000);
      assert.equal(answer.statusCode, 503);
      assert.equal(answer.body, NEUTRAL_BODY);
      assert.ok(Number(answer.retryAfter) >= 0, 'Retry-After present');
      const entries = await logs(gateway.logPath);
      const tried = entries.filter((e) => e.message === 'Upstream models infra error').map((e) => e.id);
      assert.equal(tried.length, n, 'exactly one attempt per key');
      assert.equal(new Set(tried).size, n, 'every distinct key once');
      assert.equal(penalties(entries), 0);
      const accounting = await flushedAccounting(gateway);
      // Per attempt, by index: the errno must match THAT key's route.
      const keyOf = keyById(gateway);
      const infraLogged = entries.filter((e) => e.message === 'Upstream models infra error');
      assert.deepEqual(infraLogged.map((e) => ({ key: keyOf(e.id), code: e.code })),
        infraLogged.map((e) => ({ key: keyOf(e.id), code: expectedInfra(routes[keyOf(e.id)]).code })));
      assert.deepEqual(accounting, Object.fromEntries(keys.map((k) => [k, CLEAN])));
    });
  });
}

test('Э3 models: request deadline -> 504 with the chat deadline body', { timeout: 30_000 }, async () => {
  await scenario({ models: () => { /* silent */ } }, { keys: KEYS.slice(0, 2), deadlineMs: 400 }, async (gateway) => {
    const started = Date.now();
    const answer = await getModels(gateway.port, 5_000);
    assert.equal(answer.statusCode, 504);
    assert.equal(answer.body, DEADLINE_BODY);
    assert.ok(Date.now() - started < 2_000, 'answered at the deadline');
    const entries = await logs(gateway.logPath);
    assert.equal(penalties(entries), 0);
    assert.equal(entries.filter((e) => e.message === 'Retrying models with different key').length, 0, 'N3: no retry log for a deadline cut');
  });
});

// N1: after a 200 released the deadline, a stalled body is bounded only by the
// models socket timeout (MODELS_UPSTREAM_TIMEOUT_MS, shortened by the preload
// seam). Its handling is the pre-Э3 one: key penalty + retryable socket_hang_up,
// answered by the attempt-budget 502, never the deadline 504 body.
const stalledBody = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"data":['); };

test('Э3 models N1: 200 then body stalls past the deadline -> pre-Э3 502, not the deadline body', { timeout: 30_000 }, async () => {
  await scenario({ models: stalledBody }, { keys: KEYS.slice(0, 1), deadlineMs: 200, modelsTimeoutMs: 600 }, async (gateway) => {
    const answer = await getModels(gateway.port, 5_000);
    assert.equal(answer.statusCode, 502);
    assert.equal(answer.body, MODELS_STALL_1_EXHAUSTED_BODY);
    assert.notEqual(answer.body, DEADLINE_BODY);
    const entries = await logs(gateway.logPath);
    assert.equal(entries.some((e) => e.earlyStopReason === 'request_deadline'), false, 'no deadline verdict');
    assert.equal(entries.filter((e) => e.message === 'Retrying models with different key').length, 0, 'N3: no retry follows');
    assert.equal(penalties(entries), 1, 'pre-Э3 accounting: the stalled key takes the 502 penalty');
  });
});

test('Э3 models N1: 200 then body stalls within the deadline -> retried as before Э3, then 502', { timeout: 30_000 }, async () => {
  await scenario({ models: stalledBody }, { keys: KEYS.slice(0, 2), maxAttempts: 2, modelsTimeoutMs: 300 }, async (gateway, seen) => {
    const answer = await getModels(gateway.port, 5_000);
    assert.equal(answer.statusCode, 502);
    assert.equal(answer.body, MODELS_STALL_2_EXHAUSTED_BODY);
    assert.equal(seen.filter((s) => s.startsWith('/v1/models')).length, 2);
    const entries = await logs(gateway.logPath);
    assert.equal(entries.filter((e) => e.message === 'Retrying models with different key').length, 1, 'one real retry logged');
    assert.equal(penalties(entries), 2);
  });
});

// Deadline scope (Э1 rule): the deadline covers the wait for the upstream to
// START answering. A 200 whose body trickles past the deadline (within the idle
// window) is passed through in full, as chat does for a non-stream 200.
test('Э3 models: 200 headers fast, body trickles past the deadline -> full 200, not 504', { timeout: 30_000 }, async () => {
  const parts = ['{"data":[', '{"id":"vendor/slow-model","object":"model"}', ']}'];
  const trickle = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    let i = 0;
    const next = () => { if (i < parts.length - 1) { res.write(parts[i++]); setTimeout(next, 350); } else res.end(parts[i]); };
    next();
  };
  await scenario({ models: trickle }, { keys: KEYS.slice(0, 1), deadlineMs: 400 }, async (gateway, seen) => {
    const started = Date.now();
    const answer = await getModels(gateway.port, 5_000);
    assert.ok(Date.now() - started >= 600, 'the body finished after the deadline');
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.terminal, 'ended');
    assert.deepEqual(JSON.parse(answer.body).data.map((m) => m.id), ['vendor/slow-model']);
    assert.equal(seen.filter((s) => s.startsWith('/v1/models')).length, 1, 'no retry');
    const entries = await logs(gateway.logPath);
    assert.equal(entries.some((e) => e.message === 'All models failover attempts exhausted'), false);
    assert.equal(penalties(entries), 0);
  });
});

// A client abort must not leave the attempt's deadline timer armed. The stale
// timer's effect is internal (its callback sees res.destroyed and returns), so
// this pins only the observable side: no late verdict/log, no retry, healthy.
test('Э3 models: client abort before the deadline -> no late log, no retry, gateway healthy', { timeout: 30_000 }, async () => {
  await scenario({ models: () => { /* silent */ } }, { keys: KEYS.slice(0, 2), deadlineMs: 600 }, async (gateway, seen) => {
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: gateway.port, path: '/v1/models', method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } });
      req.once('error', () => resolve());
      req.end();
      setTimeout(() => { req.destroy(); resolve(); }, 150);
    });
    await sleep(1_200); // well past the 600 ms deadline
    assert.equal((await request(gateway.port, 'GET', '/health', { timeoutMs: 1_000 })).statusCode, 200);
    assert.equal(seen.filter((s) => s.startsWith('/v1/models')).length, 1, 'no retry after the abort');
    const entries = await logs(gateway.logPath);
    const late = entries.filter((e) => ['All models failover attempts exhausted', 'Upstream models request error', 'Retrying models with different key'].includes(e.message));
    assert.deepEqual(late.map((e) => e.message), [], 'no late log line after the abort');
    assert.equal(penalties(entries), 0);
  });
});

test('Э3 sentinel: an infra error message/stack never reaches the wire, the log file or getRecentLogs()', { timeout: 30_000 }, async () => {
  const SENTINEL = 'E3-SENTINEL-7f3a9c-do-not-leak';
  const route = { lookupError: { code: 'ENOTFOUND', message: `getaddrinfo ENOTFOUND ${SENTINEL}` } };
  const routes = { [KEYS[0]]: route };
  await scenario({}, { keys: KEYS.slice(0, 1), routes }, async (gateway) => {
    const chat = await postChat(gateway.port, 10_000);
    const models = await getModels(gateway.port, 10_000);
    assert.equal(chat.statusCode, 503);
    assert.equal(models.statusCode, 503);
    for (const body of [chat.body, models.body]) assert.equal(body.includes(SENTINEL), false, 'wire body');
    await sleep(1_100);
    const fileText = fs.readFileSync(gateway.logPath, 'utf8');
    assert.ok(fileText.includes('Upstream infra error'), 'the infra event itself is logged');
    assert.equal(fileText.includes(SENTINEL), false, 'gateway log file');
    const recent = await request(gateway.port + 1, 'GET', '/admin/logs', { token: ADMIN_TOKEN });
    assert.equal(recent.statusCode, 200);
    assert.ok(recent.body.includes('Upstream infra error'), 'getRecentLogs carries the infra event');
    assert.equal(recent.body.includes(SENTINEL), false, 'getRecentLogs()');
  });
});

test.after(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); });
