/**
 * W1y final LOW fixes (CodeRabbit).
 *
 * CRF-001: the chat upstream-error echo flattened a clean MULTI-LINE upstream
 * message (sanitizeUpstreamErrorMessage collapses newlines, so the detector saw
 * a "change") and, for a credential-bearing OpenAI envelope, rebuilt it as
 * `{ error: "<string>" }`, dropping `type`/`code`/`param`.
 *
 * CRF-002: an operator stop queued behind busy lifecycle work could be undone
 * by an auto-restart scheduled from a crash that landed before the queued
 * `stopInternal` ran (the restart captured the post-stop generation).
 *
 * Fake upstream + fake keys + child doubles on 127.0.0.1 only.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { reservePortPair, startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';
import { GATEWAY_START_MAX_ATTEMPTS, highPortReservation, killOnBindCollision } from './support/gateway-bind-collision.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-w1y-${process.pid}-`));
const reservations = [];
const MODEL = 'z-ai/glm-5.2';
const FAKE_KEY = 'nvapi-w1y-must-never-reach-the-client';

test.after(async () => {
  for (const reservation of reservations) {
    if (typeof reservation?.release === 'function') await reservation.release();
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 5_000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(stepMs);
  }
  throw new Error('Timed out waiting for condition.');
}

// ---------------------------------------------------------------- CRF-001 --

function request(port, pathname, method = 'GET', body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      let done = false;
      const finish = (extra) => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), ...extra });
      };
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => finish({}));
      res.on('aborted', () => finish({ aborted: true }));
      res.on('error', (error) => finish({ aborted: true, error }));
      const guard = setTimeout(() => { finish({ aborted: true, timedOut: true }); req.destroy(); }, 20_000);
      guard.unref?.();
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function startHarness(upstreamReply) {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'gw-'));
  const keys = [{ id: 'key-0', key: 'fake-w1y-upstream-key', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 } }];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => upstreamReply(res, Buffer.concat(chunks).toString()));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const gatewayToken = `w1y-${randomUUID()}`;
  let child;
  let detach;
  const started = await startGatewayOnReservedPort({
    maxAttempts: GATEWAY_START_MAX_ATTEMPTS,
    reservationOptions: highPortReservation(),
    readinessTimeoutMs: 20_000,
    spawnChild(candidatePort) {
      const spawned = spawn(process.execPath, ['--require', path.join(root, 'tests/local-upstream-preload.cjs'), path.join(root, 'src/gateway/server.mjs')], {
        env: {
          ...process.env,
          GATEWAY_LOG_PATH: path.join(dir, 'gateway.jsonl'),
          GATEWAY_MAX_FAILOVER_ATTEMPTS: '1',
          GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstream.address().port),
          PORT: String(candidatePort)
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true
      });
      child = spawned;
      detach = killOnBindCollision(spawned);
      spawned.once('message', (message) => {
        if (message?.type === 'ready') {
          spawned.send({ type: 'state:init', challenge: message.challenge, state: { keys, credentials: { gatewayToken, adminToken: 'w1y-admin' } } });
        }
      });
      return spawned;
    }
  });
  child = started.child;
  detach();
  const port = started.port;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try { if ((await request(port, '/health')).statusCode === 200) break; } catch { /* retry */ }
    await delay(25);
  }
  const auth = { authorization: `Bearer ${gatewayToken}`, 'content-type': 'application/json' };
  const chat = (model = MODEL) => request(port, '/v1/chat/completions', 'POST', JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }), auth);
  return {
    chat,
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

test('CRF-001: a clean two-line (Pydantic-style) upstream message is echoed byte-identically', async () => {
  const clean = JSON.stringify({
    error: {
      message: '1 validation error for ChatRequest\nmessages.0.content\n  Field required [type=missing]',
      type: 'invalid_request_error',
      param: 'messages',
      code: 'validation_error'
    }
  });
  const harness = await startHarness((res) => {
    res.writeHead(422, { 'content-type': 'application/json' });
    res.end(clean);
  });
  try {
    const result = await harness.chat();
    assert.equal(result.statusCode, 422);
    assert.equal(result.body, clean, 'a body with no secret must pass through byte-identically, newlines included');
  } finally { await harness.close(); }
});

test('CRF-001: a credential in error.message is scrubbed while the OpenAI envelope (type/code/param) is kept', async () => {
  const upstreamBody = JSON.stringify({
    error: { message: `invalid key ${FAKE_KEY} supplied`, type: 'invalid_request_error', param: 'authorization', code: 'invalid_api_key' }
  });
  const harness = await startHarness((res) => {
    res.writeHead(400, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(upstreamBody)) });
    res.end(upstreamBody);
  });
  try {
    const result = await harness.chat();
    assert.equal(result.statusCode, 400);
    assert.equal(result.aborted, undefined, 'the rewritten body must arrive complete');
    assert.equal(result.body.includes(FAKE_KEY), false, 'the credential must not reach the client');
    assert.equal(/nvapi-/i.test(result.body), false);
    const parsed = JSON.parse(result.body);
    assert.equal(typeof parsed.error, 'object', `the envelope must not be flattened, got ${result.body}`);
    assert.match(parsed.error.message, /invalid key \[REDACTED\] supplied/);
    assert.equal(parsed.error.type, 'invalid_request_error');
    assert.equal(parsed.error.code, 'invalid_api_key');
    assert.equal(parsed.error.param, 'authorization');
  } finally { await harness.close(); }
});

for (const [label, body] of [
  ['clean message + secret in a sibling leaf', { error: { message: 'bad request', type: 't', detail: 'leak ' + FAKE_KEY } }],
  ['clean message + credential-named leaf', { error: { message: 'bad request', api_key: 'shortkey' } }],
  ['secret used as an object KEY', { detail: { [FAKE_KEY]: 1 } }],
  ['credential-named key with a NUMBER value', { error: { message: 'bad request', api_key: 98765432109 } }],
  ['credential-named key with an OBJECT value', { error: { message: 'bad request', token: { value: 'shortkey' } } }],
]) {
  test(`CRF-001b: ${label} never reaches the client`, async () => {
    // A clean error.message used to short-circuit the leak detector, so a
    // secret anywhere else in the object (sibling leaf, credential-named key,
    // or a key name itself) was proxied verbatim.
    const upstreamBody = JSON.stringify(body);
    const harness = await startHarness((res) => {
      res.writeHead(400, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(upstreamBody)) });
      res.end(upstreamBody);
    });
    try {
      const result = await harness.chat();
      assert.equal(result.statusCode, 400);
      assert.equal(result.aborted, undefined, 'the rewritten body must arrive complete');
      assert.equal(result.body.includes(FAKE_KEY), false, 'the credential must not reach the client');
      assert.equal(result.body.includes('shortkey'), false, 'a credential-named value must not reach the client');
      assert.equal(result.body.includes('98765432109'), false, 'a numeric credential-named value must not reach the client');
      JSON.parse(result.body);
    } finally { await harness.close(); }
  });
}

test('CRF-001b: a harmless prose KEY with a path and a question mark is not renamed', async () => {
  const upstreamBody = JSON.stringify({ error: { message: 'bad request', type: 't' }, 'is it /v1/chat?': 'no' });
  const harness = await startHarness((res) => {
    res.writeHead(400, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(upstreamBody)) });
    res.end(upstreamBody);
  });
  try {
    const result = await harness.chat();
    assert.equal(result.statusCode, 400);
    assert.equal(result.body, upstreamBody, 'a clean body with a prose key stays byte-identical');
  } finally { await harness.close(); }
});

test('CRF-001: an oversized object body is still bounded and scrubbed', async () => {
  const upstreamBody = JSON.stringify({
    error: { message: `rejected ${FAKE_KEY} ` + 'x'.repeat(64 * 1024), type: 'invalid_request_error', code: 'too_big' }
  });
  const harness = await startHarness((res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(upstreamBody);
  });
  try {
    const result = await harness.chat();
    assert.equal(result.statusCode, 400);
    assert.ok(result.body.length < 4_096, `the echo must be bounded, got ${result.body.length} bytes`);
    assert.equal(result.body.includes(FAKE_KEY), false);
    assert.equal(typeof JSON.parse(result.body), 'object');
  } finally { await harness.close(); }
});

// ---------------------------------------------------------------- CRF-002 --

const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;

async function freePort() {
  const candidates = Array.from({ length: 200 }, (_, offset) => 21_000 + ((process.pid + offset) % 29_000));
  const reservation = await reservePortPair({ candidatePorts: candidates, maxAttempts: candidates.length });
  reservations.push(reservation);
  return reservation.port;
}

/** Child double that satisfies the lifecycle's real startup contract (same as w1f). */
function attestableChild({ port }) {
  const child = new EventEmitter();
  const servers = [];
  const challenge = 'w1y-child-challenge-0123456789';
  let bound = false;
  child.pid = 8000 + (port % 1000);
  child.exitCode = null;
  child.killed = false;
  child.connected = true;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; return true; };
  child.send = (message, callback) => {
    if (message?.type !== 'state:init' || bound) return;
    bound = true;
    callback?.(null);
    const gateway = http.createServer((_req, res) => { res.writeHead(200); res.end('{}'); });
    const admin = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    servers.push(gateway, admin);
    gateway.on('error', () => {});
    admin.on('error', () => {});
    gateway.listen(port, '127.0.0.1', () => admin.listen(port + 1, '127.0.0.1', () => {
      child.emit('message', { type: 'ports:bound', challenge, gatewayPort: port, adminPort: port + 1 });
    }));
  };
  child.emitReady = () => child.emit('message', { type: 'ready', challenge });
  child.crash = async () => {
    if (child.exitCode !== null) return;
    await Promise.all(servers.map((server) => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })));
    child.exitCode = 1;
    child.connected = false;
    child.emit('exit', 1, null);
  };
  return child;
}

test('CRF-002: a crash between stop() and the queued stopInternal cannot resurrect the gateway', async () => {
  const port = await freePort();
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const { ensureGatewayRuntime } = await import(built('gateway-runtime.js'));
  const runtime = ensureGatewayRuntime(path.join(tempRoot, `runtime-${port}-${Date.now()}`));
  const children = [];
  const events = [];
  const instance = new GatewayLifecycle({
    executablePath: process.execPath,
    serverPath: path.join(root, 'src', 'gateway', 'server.mjs'),
    runtimePaths: runtime,
    spawnChild: () => {
      const child = attestableChild({ port });
      children.push(child);
      setImmediate(() => child.emitReady());
      return child;
    },
    initialState: { keys: [], credentials: { gatewayToken: 'fixture-gateway-token', adminToken: 'fixture-admin-token' } },
    startupTimeoutMs: 1_000,
    healthPollIntervalMs: 5,
    autoRestart: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 50, stableUptimeMs: 60_000 },
    onLifecycleEvent: (event, data) => events.push({ event, data })
  });
  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });

    // Keep the operation queue busy past the restart backoff (TS-private seam,
    // reachable at runtime): the stop's stopInternal waits behind this gate.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    instance.enqueue(() => gate);
    const stopped = instance.stop();

    // The child dies BEFORE stopInternal marks the stop intentional.
    await children[0].crash();
    await delay(250); // well past the 50 ms backoff: any scheduled restart has fired and queued

    release();
    assert.deepEqual(await stopped, { state: 'stopped' });
    await delay(250);
    assert.equal(children.length, 1, `an operator stop must not be undone by an auto-restart (spawned ${children.length - 1} replacement)`);
    assert.deepEqual(instance.getStatus(), { state: 'stopped' });
  } finally {
    await instance.stop();
    for (const child of children) await child.crash();
  }
});
