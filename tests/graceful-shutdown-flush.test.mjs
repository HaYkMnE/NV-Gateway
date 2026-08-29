import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-shutdown-${process.pid}-`)));
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

// ───────────────────────────────────────────────────────────────────────────
// Graceful-stop flush.
//
// On Windows `child.kill("SIGTERM")` is TerminateProcess: Node NEVER runs the
// child's signal handlers. The chain shutdown() -> flushState() -> flushAffinity()
// therefore never executed on a managed stop, so the debounced affinity cache
// AND the keys.json usage projection were both silently dropped on every stop.
//
// The fix is co-operative: the parent ASKS over the already-bound ipc channel
// before falling back to signals, and the child also flushes if the parent
// disappears. The signal escalation itself is unchanged, so an unresponsive
// child is still guaranteed to die.
// ───────────────────────────────────────────────────────────────────────────

test('child flushes queued affinity marks when asked to shut down over IPC', async () => {
  const harness = await startChild();
  try {
    // A rate-limited model queues model-scoped cooldowns behind the 5s debounce.
    const limited = await chat(harness.port, 'deepseek-ai/deepseek-v3');
    assert.equal(limited.statusCode, 429, 'the model is genuinely rate-limited');
    assert.ok(harness.calls.length >= 2, 'at least two keys confirmed the 429');

    // Nothing on disk yet: that is the debounce working (writes are OFF the hot path).
    assert.equal(fs.existsSync(harness.cachePath), false,
      'the debounced write must not have touched the disk yet');

    // THE POINT: ask over ipc, and the child flushes before exiting.
    assert.equal(harness.requestShutdown(), true, 'the ipc request must be accepted by the channel');
    const exit = await harness.waitForExit(5_000);
    assert.equal(exit.timedOut, false, 'the child must exit on the ipc request, without a signal');

    assert.equal(fs.existsSync(harness.cachePath), true,
      'the graceful stop must have flushed the affinity cache to disk');
    const parsed = JSON.parse(fs.readFileSync(harness.cachePath, 'utf8'));
    const marks = Object.keys(parsed.cooldowns ?? {});
    assert.ok(marks.length >= 2,
      `every queued (model, key) cooldown must be persisted, got ${JSON.stringify(marks)}`);
    for (const mark of marks) {
      assert.match(mark, /^deepseek-ai\/deepseek-v3\u0000/, 'marks are scoped to the requested model');
      assert.ok(parsed.cooldowns[mark].until > parsed.cooldowns[mark].at, 'a persisted cooldown has a future expiry');
    }
    for (const key of harness.keyMaterial) {
      assert.ok(!fs.readFileSync(harness.cachePath, 'utf8').includes(key), 'no key material is written');
    }
  } finally {
    await harness.close();
  }
});

test('child flushes queued affinity marks when the parent disconnects', async () => {
  const harness = await startChild();
  try {
    assert.equal((await chat(harness.port, 'moonshotai/kimi-k2')).statusCode, 429);
    assert.equal(fs.existsSync(harness.cachePath), false, 'still debounced, nothing on disk');

    // Parent vanishes rather than asking politely.
    harness.child.disconnect();
    const exit = await harness.waitForExit(5_000);
    assert.equal(exit.timedOut, false, 'losing the parent must not leave the child hanging');

    assert.equal(fs.existsSync(harness.cachePath), true,
      'a disconnect must still flush: the child must not lose state because the parent died');
    const parsed = JSON.parse(fs.readFileSync(harness.cachePath, 'utf8'));
    assert.ok(Object.keys(parsed.cooldowns ?? {}).length >= 2, 'cooldowns survived the disconnect');
  } finally {
    await harness.close();
  }
});

test('shutdown is idempotent: an IPC request followed by a disconnect flushes once and exits clean', async () => {
  const harness = await startChild();
  try {
    assert.equal((await chat(harness.port, 'minimaxai/minimax-m2')).statusCode, 429);

    // Both triggers for the SAME stop. shutdown() also disconnects internally,
    // which re-enters via the 'disconnect' event — the guard must absorb it.
    harness.requestShutdown();
    try { harness.child.disconnect(); } catch { /* channel may already be closing */ }

    const exit = await harness.waitForExit(5_000);
    assert.equal(exit.timedOut, false, 'the child still exits');
    assert.equal(exit.code, 0, `a double shutdown must exit cleanly, got code=${exit.code} signal=${exit.signal}`);

    // No crash noise, and exactly one coherent payload on disk.
    assert.equal(/Error|Cannot read|ERR_|Unhandled/i.test(harness.stderr()), false,
      `no error output on a double shutdown, saw: ${harness.stderr().slice(0, 400)}`);
    const raw = fs.readFileSync(harness.cachePath, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), 'the flushed file is a single valid payload, not a double write');
    assert.equal(JSON.parse(raw).version, 1);

    // The gateway logged its graceful shutdown exactly once.
    const shutdownLines = fs.readFileSync(harness.logPath, 'utf8').trim().split('\n')
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((entry) => entry?.message === 'Gateway shutting down');
    assert.equal(shutdownLines.length, 1, 'shutdown() must run exactly once, not twice');
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Parent side. stopChild is exercised directly: TS `private` is erased at
// compile time, so the built JS exposes it, and calling it keeps these
// assertions about the STOP SEQUENCE only — no start()/health/attestation setup.
// ───────────────────────────────────────────────────────────────────────────

test('stopChild asks over IPC first and sends NO signal when the child complies', async () => {
  const { instance } = await createLifecycle({ ipcShutdownGraceMs: 500 });
  const child = fakeChild({ onShutdownRequest: (c) => c.finishExit(0) });

  const stopped = await instance.stopChild(child);

  assert.equal(stopped, true, 'the stop is confirmed');
  assert.deepEqual(child.sentTypes, ['shutdown'], 'exactly one ipc shutdown request was sent');
  assert.deepEqual(child.killSignals, [],
    'a compliant child must never be signalled — this is what lets it flush on Windows');
});

test('stopChild still escalates SIGTERM then SIGKILL when the child ignores the IPC request', async () => {
  const { instance } = await createLifecycle({
    ipcShutdownGraceMs: 20,
    shutdownTimeoutMs: 20,
    forcedShutdownTimeoutMs: 20
  });
  // Accepts the request on the channel but never acts on it, and ignores SIGTERM.
  const child = fakeChild({ exitOnSignal: 'SIGKILL' });

  const startedAt = Date.now();
  const stopped = await instance.stopChild(child);
  const elapsed = Date.now() - startedAt;

  assert.equal(stopped, true, 'an unresponsive child is still confirmed dead');
  assert.deepEqual(child.sentTypes, ['shutdown'], 'the ipc request was attempted first');
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL'],
    'the guarantee that the child eventually dies must be preserved');
  assert.ok(elapsed < 2_000, `every wait stays bounded, took ${elapsed}ms`);
});

test('stopChild skips the IPC grace when the channel cannot confirm the request', async () => {
  const { instance } = await createLifecycle({
    ipcShutdownGraceMs: 5_000, // deliberately long: must NOT be waited on
    shutdownTimeoutMs: 20,
    forcedShutdownTimeoutMs: 20
  });

  // A disconnected child, and a mock whose send() confirms nothing (returns
  // undefined) — the shape every existing fake-child test uses.
  for (const child of [
    fakeChild({ connected: false, exitOnSignal: 'SIGTERM' }),
    fakeChild({ unconfirmedSend: true, exitOnSignal: 'SIGTERM' }),
    fakeChild({ sendThrows: true, exitOnSignal: 'SIGTERM' }),
    fakeChild({ noSend: true, exitOnSignal: 'SIGTERM' })
  ]) {
    const startedAt = Date.now();
    assert.equal(await instance.stopChild(child), true);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 1_000,
      `an unconfirmed ipc request must not burn the grace window, took ${elapsed}ms`);
    assert.deepEqual(child.killSignals, ['SIGTERM'], 'it falls straight through to signals');
  }
});

test('stopChild returns immediately for an already-exited child and touches nothing', async () => {
  const { instance } = await createLifecycle({});
  const child = fakeChild({});
  child.exitCode = 0;

  assert.equal(await instance.stopChild(child), true);
  assert.deepEqual(child.sentTypes, [], 'no ipc request for a dead child');
  assert.deepEqual(child.killSignals, [], 'no signals for a dead child');
});

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

async function createLifecycle(options) {
  const { ensureGatewayRuntime } = await import(built('gateway-runtime.js'));
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const paths = ensureGatewayRuntime(path.join(tempRoot, `rt-${Date.now()}-${Math.random()}`));
  return {
    paths,
    instance: new GatewayLifecycle({
      executablePath: process.execPath,
      serverPath: path.join(root, 'src', 'gateway', 'server.mjs'),
      runtimePaths: paths,
      spawnChild: () => { throw new Error('spawn must not happen in a stop-sequence test'); },
      initialState: { keys: [], credentials: { gatewayToken: 'fixture-gateway-token', adminToken: 'fixture-admin-token' } },
      ...options
    })
  };
}

/**
 * Minimal ChildProcess stand-in for stop-sequence assertions.
 * `sendReturns` defaults to true (what a real connected channel returns).
 */
function fakeChild({
  connected = true,
  // `unconfirmedSend` models a send() that returns undefined — the shape every
  // pre-existing fake-child in this repo uses. A plain `sendReturns: undefined`
  // option could NOT express it: the destructuring default would replace it.
  unconfirmedSend = false,
  sendThrows = false,
  noSend = false,
  onShutdownRequest = null,
  exitOnSignal = null
} = {}) {
  const child = new EventEmitter();
  child.pid = 5150;
  child.exitCode = null;
  child.killed = false;
  child.connected = connected;
  child.sentTypes = [];
  child.killSignals = [];
  child.finishExit = (code = 0) => {
    if (child.exitCode !== null) return;
    child.connected = false;
    child.exitCode = code;
    child.emit('exit', code, null);
  };
  if (!noSend) {
    child.send = (message) => {
      if (sendThrows) throw new Error('channel closed');
      child.sentTypes.push(message?.type);
      if (onShutdownRequest && message?.type === 'shutdown') setImmediate(() => onShutdownRequest(child));
      // A real connected channel returns true; an unconfirmed one returns undefined.
      return unconfirmedSend ? undefined : true;
    };
  }
  child.kill = (signal = 'SIGTERM') => {
    child.killSignals.push(signal);
    child.killed = true;
    if (exitOnSignal && signal === exitOnSignal) setImmediate(() => child.finishExit(0));
    return true;
  };
  return child;
}

/** Spawn the REAL gateway child against a fake upstream that always rate-limits. */
async function startChild() {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'child-'));
  const logPath = path.join(dir, 'logs', 'gateway.jsonl');
  const cachePath = path.join(dir, 'model-key-affinity.json');
  const calls = [];
  let stderr = '';

  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      calls.push(String(req.headers.authorization ?? ''));
      // 429 WITHOUT the word "quota": a rate limit, so it takes the
      // model-scoped cooldown branch rather than quota-exceeded.
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":"Too Many Requests for this model"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const keyMaterial = ['key-alpha', 'key-bravo', 'key-charlie'];
  const keys = keyMaterial.map((key, index) => ({
    id: `0000000${index}-0000-4000-8000-00000000000${index}`,
    key,
    status: 'active',
    backoffUntil: 0,
    usage: { success: 0, fail: 0, tokens: 0, lastUsed: index + 1 }
  }));

  // The child binds BOTH `port` and `port + 1` (admin), so the pair must be
  // reserved together — probing only `port` let a concurrently running test file
  // own `port + 1`, which made this file and gateway-runtime's port-conflict
  // test fail alternately under `node --test`. Retrying on a fresh pair mirrors
  // startGatewayHarnessNoOverride in key-rotation-and-validation.test.mjs.
  let port;
  let child;
  let ready = false;
  let exited = null;
  for (let startAttempt = 0; startAttempt < 3 && !ready; startAttempt++) {
    port = await freePortPair();
    stderr = '';
    exited = null;
    child = spawn(process.execPath, [
      '--require', path.join(root, 'tests/local-upstream-preload.cjs'),
      path.join(root, 'src/gateway/server.mjs')
    ], {
      env: {
        ...process.env,
        GATEWAY_LOG_PATH: logPath,
        GATEWAY_MODEL_AFFINITY_CACHE_PATH: cachePath,
        GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstream.address().port),
        GATEWAY_MAX_FAILOVER_ATTEMPTS: '3',
        PORT: String(port)
      },
      // Same stdio shape the real gateway child is spawned with.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('exit', (code, signal) => { exited = { code, signal, timedOut: false }; });
    child.once('message', (message) => {
      if (message?.type === 'ready') {
        child.send({
          type: 'state:init',
          challenge: message.challenge,
          state: { keys, credentials: { gatewayToken: 'test-gateway-token', adminToken: 'test-admin-token' } }
        });
      }
    });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        if ((await request(port, '/health')).statusCode === 200) { ready = true; break; }
      } catch { /* not up yet */ }
      if (child.exitCode !== null) break;
      await delay(25);
    }
    if (!ready && child.exitCode === null) {
      child.kill('SIGKILL');
      await delay(100);
    }
  }
  if (!ready) {
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    throw new Error(`Gateway child did not become healthy on port ${port}.`);
  }

  return {
    port, child, cachePath, logPath, calls, keyMaterial,
    stderr: () => stderr,
    requestShutdown: () => {
      if (!child.connected) return false;
      return child.send({ type: 'shutdown' }) === true;
    },
    waitForExit: async (timeoutMs) => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (exited) return exited;
        await delay(20);
      }
      return { code: null, signal: null, timedOut: true };
    },
    close: async () => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await delay(150);
      }
      upstream.closeAllConnections?.();
      await new Promise((resolve) => upstream.close(resolve));
    }
  };
}

function chat(port, model) {
  return request(port, '/v1/chat/completions', 'POST', JSON.stringify({
    model, stream: false, messages: [{ role: 'user', content: 'hi' }]
  }));
}

function request(port, url, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: url, method,
      headers: {
        authorization: 'Bearer test-gateway-token',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * Reserve a port whose ADMIN neighbour (port + 1) is free too, since the gateway
 * child binds both. Same helper the other spawned-gateway suites use
 * (key-rotation-and-validation, p0-backend, gateway-lifecycle-ownership).
 */
async function freePortPair() {
  while (true) {
    const first = http.createServer();
    await new Promise((resolve) => first.listen(0, '127.0.0.1', resolve));
    const port = first.address().port;
    await new Promise((resolve) => first.close(resolve));
    if (port >= 65534) continue;
    const second = http.createServer();
    try {
      await new Promise((resolve, reject) => {
        second.once('error', reject);
        second.listen(port + 1, '127.0.0.1', resolve);
      });
    } catch {
      continue; // neighbour taken — try another pair
    }
    await new Promise((resolve) => second.close(resolve));
    return port;
  }
}
