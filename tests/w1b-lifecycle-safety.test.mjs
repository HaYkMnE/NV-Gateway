/**
 * W1b lifecycle safety tests (Level-1 fix wave).
 *
 * Two independent guarantees, each with a real reproduction:
 *
 *  5a. The gateway CHILD had no `uncaughtException` / `unhandledRejection`
 *      handler, so one stray throw killed it silently (the 2026-10-23 crash:
 *      2h14m downtime, nothing in gateway.jsonl). The last-resort handler must
 *      LOG the redacted reason and then exit DELIBERATELY non-zero — it must
 *      never swallow the throw and keep serving a broken process.
 *
 *  5b. `GatewayLifecycle` reported RUNTIME_EXIT and stopped there. A bounded
 *      auto-restart (max 3 attempts, exponential backoff, counter reset after a
 *      stable uptime, lifecycle events) replaces the "stay dead" default and
 *      must NEVER loop forever.
 *
 * 5a spawns the REAL child (reserved loopback port pair, fake key, fake log).
 * 5b drives the compiled lifecycle against a child double that completes the
 * real attestation handshake, so a crash is a genuine unexpected runtime exit.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { reservePortPair } from './support/paired-port-allocation.mjs';
import { GATEWAY_START_MAX_ATTEMPTS, highPortReservation, killOnBindCollision } from './support/gateway-bind-collision.mjs';
import { startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-w1b-lifecycle-${process.pid}-`));
const reservations = [];

test.after(async () => {
  for (const reservation of reservations) {
    if (typeof reservation?.release === 'function') await reservation.release();
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ── 5a: the real child dies HONESTLY and LOGGED ──────────────────────────────

/**
 * The crash preload. Kept as a plain (non-exported) function so importing this
 * test file can never re-register its cases elsewhere; tests/wq-lifecycle-crash-
 * readiness.test.mjs reads this source text and evaluates the function body to
 * prove the arming signal is `ports:bound`, not a wall-clock delay.
 */
function crashTriggerPreload(trigger) {
  return [
    'const originalSend = process.send ? process.send.bind(process) : null;',
    'if (originalSend) {',
    '  process.send = (message, ...rest) => {',
    '    const result = originalSend(message, ...rest);',
    '    if (message && message.type === "ports:bound") {',
    '      process.send = originalSend;',
    `      setImmediate(() => { ${trigger} });`,
    '    }',
    '    return result;',
    '  };',
    '}',
    ''
  ].join('\n');
}

/**
 * Start the real gateway child with a preload that throws AFTER the server is
 * listening, then return its exit code and the log rows.
 *
 * The crash is armed on the child's `ports:bound` IPC message — the real
 * readiness signal, emitted only once both paired ports are listening — instead
 * of a wall-clock delay. A fixed 1200 ms timer raced slow CI startup: on a cold
 * runner the throw could land BEFORE the child finished binding, so the harness
 * never observed `ports:bound` and failed for the wrong reason.
 */
async function startCrashedChild({ trigger, logName }) {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'crash-'));
  const logPath = path.join(dir, logName);
  const statePath = path.join(dir, 'keys.json');
  fs.writeFileSync(statePath, JSON.stringify({
    keys: [{ id: 'key-0', key: 'fake-w1b-key', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 } }]
  }));
  const preloadPath = path.join(dir, 'crash-trigger.cjs');
  fs.writeFileSync(preloadPath, crashTriggerPreload(trigger));

  const started = await startGatewayOnReservedPort({
    maxAttempts: GATEWAY_START_MAX_ATTEMPTS,
    reservationOptions: highPortReservation(),
    readinessTimeoutMs: 20_000,
    spawnChild(candidatePort) {
      const child = spawn(process.execPath, ['--require', preloadPath, path.join(root, 'src', 'gateway', 'server.mjs')], {
        env: {
          ...process.env,
          GATEWAY_LOG_PATH: logPath,
          GATEWAY_MAX_FAILOVER_ATTEMPTS: '1',
          PORT: String(candidatePort)
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true
      });
      child.once('message', (message) => {
        if (message?.type === 'ready') {
          child.send({
            type: 'state:init',
            challenge: message.challenge,
            state: {
              keys: JSON.parse(fs.readFileSync(statePath, 'utf8')).keys,
              credentials: { gatewayToken: 'w1b-gateway-token', adminToken: 'w1b-admin-token' }
            }
          });
        }
      });
      return child;
    }
  });
  const detach = killOnBindCollision(started.child);
  const exit = await new Promise((resolve) => {
    if (started.child.exitCode !== null || started.child.signalCode !== null) {
      resolve({ code: started.child.exitCode, signal: started.child.signalCode });
      return;
    }
    started.child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  detach();
  await delay(150); // logger flush is synchronous on the fatal path, this is slack
  return { exit, rows: readJsonLines(logPath), logPath };
}

test('5a: an uncaught exception logs a redacted fatal row and exits non-zero', async () => {
  const fakeKey = 'nvapi-w1b-must-never-be-logged';
  const { exit, rows } = await startCrashedChild({
    trigger: `throw new Error('boom ' + ${JSON.stringify(fakeKey)});`,
    logName: 'crash-uncaught.jsonl'
  });

  assert.equal(exit.code, 1, `the child must exit deliberately non-zero, got code ${exit.code} signal ${exit.signal}`);
  const fatal = rows.filter((entry) => entry.message === 'Gateway fatal error');
  assert.equal(fatal.length, 1, 'exactly one fatal row must be written');
  assert.equal(fatal[0].kind, 'uncaught_exception');
  assert.match(String(fatal[0].error), /boom/);
  assert.equal(JSON.stringify(rows).includes(fakeKey), false, 'the fatal row must be redacted');
});

test('5a: an unhandled rejection is reported the same way and still exits non-zero', async () => {
  const { exit, rows } = await startCrashedChild({
    trigger: `Promise.reject(new Error('rejected-by-test'));`,
    logName: 'crash-rejection.jsonl'
  });

  assert.equal(exit.code, 1, `got code ${exit.code} signal ${exit.signal}`);
  const fatal = rows.filter((entry) => entry.message === 'Gateway fatal error');
  assert.equal(fatal.length, 1);
  assert.equal(fatal[0].kind, 'unhandled_rejection');
  assert.match(String(fatal[0].error), /rejected-by-test/);
});

// ── 5b: bounded auto-restart, driven through a real attestation handshake ────

/**
 * Child double that satisfies the lifecycle's real startup contract: it answers
 * the state:init, binds the paired ports, attests them, and serves /health.
 * `crash()` reaps it the way an OOM/segfault would — exit with no intentional
 * stop — which is exactly what the restart policy reacts to.
 */
function attestableChild({ port, onCrash }) {
  const child = new EventEmitter();
  const servers = [];
  const challenge = 'w1b-child-challenge-0123456789';
  let bound = false;
  child.pid = 6000 + port % 1000;
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
  const closeServers = () => Promise.all(servers.map((server) => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
  child.crash = async () => {
    if (child.exitCode !== null) return;
    await closeServers();
    child.exitCode = 1;
    child.connected = false;
    onCrash?.();
    child.emit('exit', 1, null);
  };
  return child;
}

async function freePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidates = Array.from({ length: 200 }, (_, offset) => 20_000 + ((process.pid + attempt * 200 + offset) % 30_000));
    const reservation = await reservePortPair({ candidatePorts: candidates, maxAttempts: candidates.length });
    reservations.push(reservation);
    return reservation.port;
  }
  throw new Error('no free paired port');
}

test('5b: a crashed running child is restarted, and three crashes exhaust the bound', async () => {
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const { ensureGatewayRuntime } = await import(built('gateway-runtime.js'));
  const port = await freePort();
  const runtime = ensureGatewayRuntime(path.join(tempRoot, `restart-${Date.now()}`));
  const events = [];
  const statuses = [];
  const children = [];

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
    autoRestart: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, stableUptimeMs: 60_000 },
    onLifecycleEvent: (event, data) => events.push({ event, data }),
    onStatusChange: (status) => statuses.push(status)
  });

  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });

    // Crash 1 -> restart 1 succeeds.
    await children[0].crash();
    for (let i = 0; i < 200 && children.length < 2; i += 1) await delay(10);
    assert.equal(children.length, 2, 'a crashed running child must be replaced');
    for (let i = 0; i < 200 && instance.getStatus().state !== 'running'; i += 1) await delay(10);
    assert.equal(instance.getStatus().state, 'running', 'the replacement must reach running');

    // Crashes 2 and 3 -> restarts 2 and 3.
    await children[1].crash();
    for (let i = 0; i < 200 && children.length < 3; i += 1) await delay(10);
    assert.equal(children.length, 3);
    for (let i = 0; i < 200 && instance.getStatus().state !== 'running'; i += 1) await delay(10);

    await children[2].crash();
    for (let i = 0; i < 200 && children.length < 4; i += 1) await delay(10);
    assert.equal(children.length, 4, 'the third attempt is the last one allowed');

    // Crash 4: the budget is spent, so this one stays terminal.
    for (let i = 0; i < 200 && instance.getStatus().state !== 'running'; i += 1) await delay(10);
    await children[3].crash();
    await delay(250);

    assert.equal(children.length, 4, 'the restart count must stop at maxAttempts (no infinite loop)');
    assert.equal(instance.getStatus().code, 'RUNTIME_EXIT');
    const scheduled = events.filter((entry) => entry.event === 'gateway_restart_scheduled');
    assert.equal(scheduled.length, 3, `exactly three restarts, saw ${scheduled.length}`);
    assert.equal(events.some((entry) => entry.event === 'gateway_restart_exhausted'), true,
      'exhaustion must be reported, not silent');
    assert.ok(statuses.some((entry) => entry.code === 'RUNTIME_EXIT'), 'the terminal status stays truthful');
  } finally {
    await instance.stop();
    for (const child of children) await child.crash();
  }
});

test('5b: a stable-uptime child resets the crash counter', async () => {
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const { ensureGatewayRuntime } = await import(built('gateway-runtime.js'));
  const port = await freePort();
  const runtime = ensureGatewayRuntime(path.join(tempRoot, `reset-${Date.now()}`));
  const events = [];
  const children = [];

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
    // Uptime of 0 ms counts as stable: every crash starts a fresh budget, which
    // is the documented reset semantics under test (the production default is 60s).
    autoRestart: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, stableUptimeMs: 0 },
    onLifecycleEvent: (event, data) => events.push({ event, data })
  });

  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });
    for (let round = 0; round < 3; round += 1) {
      const current = children.at(-1);
      await current.crash();
      for (let i = 0; i < 200 && children.length < round + 2; i += 1) await delay(10);
      assert.equal(children.length, round + 2, `round ${round} must still restart after a stable run`);
      for (let i = 0; i < 200 && instance.getStatus().state !== 'running'; i += 1) await delay(10);
    }
    assert.equal(events.filter((entry) => entry.event === 'gateway_restart_exhausted').length, 0);
  } finally {
    await instance.stop();
    for (const child of children) await child.crash();
  }
});

test('5b: backoff doubles and is capped', async () => {
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const { ensureGatewayRuntime } = await import(built('gateway-runtime.js'));
  const port = await freePort();
  const runtime = ensureGatewayRuntime(path.join(tempRoot, `backoff-${Date.now()}`));
  const events = [];
  const children = [];

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
    autoRestart: { maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 25, stableUptimeMs: 60_000 },
    onLifecycleEvent: (event, data) => events.push({ event, data })
  });

  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });
    for (let round = 0; round < 3; round += 1) {
      await children.at(-1).crash();
      for (let i = 0; i < 200 && children.length < round + 2; i += 1) await delay(10);
      for (let i = 0; i < 200 && instance.getStatus().state !== 'running'; i += 1) await delay(10);
    }
    const delays = events.filter((entry) => entry.event === 'gateway_restart_scheduled').map((entry) => entry.data.delayMs);
    assert.deepEqual(delays, [20, 25, 25], `backoff must double then cap: ${JSON.stringify(delays)}`);
  } finally {
    await instance.stop();
    for (const child of children) await child.crash();
  }
});

test('5b: without autoRestart a crash stays terminal (unchanged default)', async () => {
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const { ensureGatewayRuntime } = await import(built('gateway-runtime.js'));
  const port = await freePort();
  const runtime = ensureGatewayRuntime(path.join(tempRoot, `no-restart-${Date.now()}`));
  const events = [];
  const children = [];

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
    onLifecycleEvent: (event, data) => events.push({ event, data })
  });

  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });
    await children[0].crash();
    await delay(300);
    assert.equal(children.length, 1, 'without autoRestart no replacement may be spawned');
    assert.equal(instance.getStatus().code, 'RUNTIME_EXIT');
    assert.equal(events.some((entry) => entry.event === 'gateway_restart_scheduled'), false);
  } finally {
    await instance.stop();
    for (const child of children) await child.crash();
  }
});
