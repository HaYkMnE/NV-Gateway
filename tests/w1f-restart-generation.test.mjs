/**
 * W1f finding 3 - the queued auto-restart is generation-guarded.
 *
 * Clearing the restart TIMER is not enough once it has already fired: its
 * callback is then sitting in the lifecycle operation queue, and a stop or a
 * manual retry that lands in that window is queued BEHIND it. The callback's
 * `this.child || status === 'running'` test cannot see the operator's intent
 * (their transition has not run yet), so it spawned a child the operator had
 * already taken down.
 *
 * The fix is a restart generation counter: captured when the restart is
 * scheduled, re-checked before the dequeue spawns. These tests drive a child
 * double through the REAL attestation handshake, so a crash is a genuine
 * unexpected runtime exit.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { reservePortPair } from './support/paired-port-allocation.mjs';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-w1f-restart-${process.pid}-`));
const reservations = [];

test.after(async () => {
  for (const reservation of reservations) {
    if (typeof reservation?.release === 'function') await reservation.release();
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(predicate, timeoutMs = 5_000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(stepMs);
  }
  throw new Error('Timed out waiting for lifecycle condition.');
}

async function freePort() {
  const candidates = Array.from({ length: 200 }, (_, offset) => 20_000 + ((process.pid + offset) % 30_000));
  const reservation = await reservePortPair({ candidatePorts: candidates, maxAttempts: candidates.length });
  reservations.push(reservation);
  return reservation.port;
}

/** Child double that satisfies the lifecycle's real startup contract. */
function attestableChild({ port }) {
  const child = new EventEmitter();
  const servers = [];
  const challenge = 'w1f-child-challenge-0123456789';
  let bound = false;
  child.pid = 7000 + (port % 1000);
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

async function createLifecycle(port, options = {}) {
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const { ensureGatewayRuntime } = await import(built('gateway-runtime.js'));
  const runtime = ensureGatewayRuntime(path.join(tempRoot, `runtime-${port}-${Date.now()}-${Math.random()}`));
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
    // Long enough that the restart is still PENDING when the test acts, short
    // enough that "it never ran" is provable inside the test timeout.
    autoRestart: { maxAttempts: 3, baseDelayMs: 400, maxDelayMs: 400, stableUptimeMs: 60_000 },
    onLifecycleEvent: (event, data) => events.push({ event, data }),
    ...options
  });
  return { instance, children, events, runtime };
}

// Matches the createLifecycle autoRestart fixture: attempt 1 waits
// min(maxDelayMs, baseDelayMs * 2 ** 0) = 400 ms.
const EXPECTED_FIRST_RESTART_DELAY_MS = 400;

/**
 * Capture EVERY setTimeout the process creates while installed, without
 * letting any of them fire, so the test can count them and decide exactly
 * when the restart timer "fires".
 */
function captureTimers() {
  const original = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const captured = [];
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = original(() => {}, 0x7fffffff);
    captured.push({ fire: () => fn(...args), ms, handle });
    return handle;
  };
  return {
    restore() { globalThis.setTimeout = original; },
    get count() { return captured.length; },
    get timer() { return captured.at(-1) ?? null; },
    clearAll() { for (const entry of captured) originalClear(entry.handle); }
  };
}

function assertSingleRestartTimer(capture, events) {
  assert.equal(capture.count, 1, `the crash must schedule exactly one restart timer, saw ${capture.count}`);
  assert.equal(capture.timer.ms, EXPECTED_FIRST_RESTART_DELAY_MS, 'restart timer must use the configured first backoff');
  const scheduled = events.filter((entry) => entry.event === 'gateway_restart_scheduled');
  assert.equal(scheduled.length, 1, 'exactly one restart must be announced');
  assert.equal(scheduled[0].data.delayMs, capture.timer.ms, 'announced delay must match the scheduled timer');
}

test('stop while a restart timer is still pending clears it: no spawn', async () => {
  const port = await freePort();
  const { instance, children, events } = await createLifecycle(port);
  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });
    await children[0].crash();
    await waitFor(() => events.some((entry) => entry.event === 'gateway_restart_scheduled'));

    assert.deepEqual(await instance.stop(), { state: 'stopped' });
    await delay(600);
    assert.equal(children.length, 1, 'a stopped gateway must not be resurrected by a pending restart');
    assert.deepEqual(instance.getStatus(), { state: 'stopped' });
  } finally {
    await instance.stop();
    for (const child of children) await child.crash();
  }
});

test('stop landing between timer fire and dequeue aborts the queued restart (generation mismatch)', async () => {
  const port = await freePort();
  const { instance, children, events } = await createLifecycle(port);
  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });

    const capture = captureTimers();
    try {
      await children[0].crash();
    } finally {
      capture.restore();
    }
    await waitFor(() => events.some((entry) => entry.event === 'gateway_restart_scheduled'));
    assertSingleRestartTimer(capture, events);

    // The timer fires: its callback is now queued, but has not run yet. The
    // stop is requested in the same synchronous turn, so its generation bump
    // lands BEFORE the queued callback is dequeued.
    capture.timer.fire();
    const stopped = instance.stop();
    capture.clearAll();
    assert.deepEqual(await stopped, { state: 'stopped' });

    await delay(300);
    assert.equal(children.length, 1, 'a stop that wins the race must not spawn a replacement child');
    assert.equal(events.some((entry) => entry.event === 'gateway_restart_failed'), false,
      'the aborted restart must not report a failed start');
    assert.deepEqual(instance.getStatus(), { state: 'stopped' });
  } finally {
    await instance.stop();
    for (const child of children) await child.crash();
  }
});

test('manual retry landing between timer fire and dequeue spawns exactly one child', async () => {
  const port = await freePort();
  const { instance, children, events } = await createLifecycle(port);
  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });

    const capture = captureTimers();
    try {
      await children[0].crash();
    } finally {
      capture.restore();
    }
    await waitFor(() => events.some((entry) => entry.event === 'gateway_restart_scheduled'));
    assertSingleRestartTimer(capture, events);

    capture.timer.fire();
    const retried = instance.retry(port);
    capture.clearAll();
    assert.deepEqual(await retried, { state: 'running', port });

    await delay(600); // past the queued restart's own delay window
    assert.equal(children.length, 2, `retry must produce exactly one replacement, saw ${children.length - 1}`);
    assert.deepEqual(instance.getStatus(), { state: 'running', port });
    assert.equal(events.filter((entry) => entry.event === 'gateway_restart_failed').length, 0);
  } finally {
    await instance.stop();
    for (const child of children) await child.crash();
  }
});

test('an untouched pending restart still fires: the generation guard aborts only superseded restarts', async () => {
  const port = await freePort();
  const { instance, children, events } = await createLifecycle(port);
  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });
    await children[0].crash();

    await waitFor(() => children.length === 2, 5_000);
    await waitFor(() => instance.getStatus().state === 'running');
    assert.equal(children.length, 2, 'a restart nobody superseded must still happen');
    assert.equal(events.filter((entry) => entry.event === 'gateway_restart_scheduled').length, 1);
  } finally {
    await instance.stop();
    for (const child of children) await child.crash();
  }
});
