/**
 * W1b backpressure listener-leak test (Level-1 fix wave, pass 2, defect 3).
 *
 * `writeToClientAwaitDrain` registered `res.once("drain")` AND
 * `res.once("close")` for every stalled facade write and never removed the
 * loser. MEASURED before the fix: 48 / 96 / 215 close listeners for 30 / 150 /
 * 300 stalls — i.e. one leaked listener per stall, which `disposeBackpressure`
 * could not cover because it only knows the OTHER pair.
 *
 * MEASURED BEHAVIOURALLY: a preload (written into this test's own temp dir, so
 * nothing is added to the repo) instruments the real `http.ServerResponse`
 * `once` registration and records the highest `close` listener count any
 * response ever reached. The gateway child is then driven with a client that
 * repeatedly stalls and resumes, and the probe reports the peak.
 *
 * Fake upstream + fake keys on 127.0.0.1 only.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';
import { GATEWAY_START_MAX_ATTEMPTS, highPortReservation, killOnBindCollision } from './support/gateway-bind-collision.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fileTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-w1b-listeners-${process.pid}-`));
const MODEL = 'z-ai/glm-5.2';
const STALL_CYCLES = 40;

test.after(() => fs.rmSync(fileTempRoot, { recursive: true, force: true }));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(port, pathname, method = 'GET', body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * The probe: count how many `close` listeners a ServerResponse accumulates.
 * Written to the temp dir so the repo stays untouched. The report is written on
 * EVERY `close` registration, not from a process exit hook: the child is killed
 * by the test, and a kill does not run exit handlers on Windows.
 *
 * `peakClose` is the peak for the response that carried the stream, `responses`
 * counts distinct ServerResponse objects touched, and `lastClose` is the live
 * count at the LAST registration (what a leak grows without bound).
 */
const PROBE_SOURCE = `
const http = require('node:http');
const fs = require('node:fs');
const originalOnce = http.ServerResponse.prototype.once;
const state = { peakClose: 0, closeRegistrations: 0, responses: 0, lastClose: 0 };
const seen = new WeakSet();
function report() {
  try { fs.writeFileSync(process.env.W1C_LISTENER_PROBE_OUT, JSON.stringify(state)); } catch {}
}
http.ServerResponse.prototype.once = function once(event, listener) {
  if (!seen.has(this)) { seen.add(this); state.responses += 1; }
  const result = originalOnce.call(this, event, listener);
  if (event === 'close') {
    state.closeRegistrations += 1;
    state.lastClose = this.listenerCount('close');
    if (state.lastClose > state.peakClose) state.peakClose = state.lastClose;
    report();
  }
  return result;
};
report();
`;

async function startHarness(upstreamHandler, { deadWaitProbe } = {}) {
  const dir = fs.mkdtempSync(path.join(fileTempRoot, 'gw-'));
  const statePath = path.join(dir, 'keys.json');
  const logPath = path.join(dir, 'gateway.jsonl');
  const probePath = path.join(dir, 'listener-probe.cjs');
  const probeOut = path.join(dir, 'listener-probe.json');
  fs.writeFileSync(probePath, PROBE_SOURCE);
  const extraProbePath = deadWaitProbe ? path.join(dir, 'dead-wait-probe.cjs') : null;
  const extraProbeOut = deadWaitProbe ? path.join(dir, 'dead-wait-probe.json') : null;
  if (extraProbePath) fs.writeFileSync(extraProbePath, deadWaitProbe);
  fs.writeFileSync(statePath, JSON.stringify({
    keys: [{ id: 'key-0', key: 'fake-w1c-upstream-key', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 } }]
  }));
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => upstreamHandler(res, Buffer.concat(chunks).toString()));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const gatewayToken = `w1c-${randomUUID()}`;
  let child;
  let detach;
  const started = await startGatewayOnReservedPort({
    maxAttempts: GATEWAY_START_MAX_ATTEMPTS,
    reservationOptions: highPortReservation(),
    readinessTimeoutMs: 20_000,
    spawnChild(candidatePort) {
      const preloads = [path.join(root, 'tests/local-upstream-preload.cjs'), probePath];
      // The dead-wait probe must load AFTER the listener probe so its `once`
      // wrapper sees the final registration path.
      if (extraProbePath) preloads.push(extraProbePath);
      const spawned = spawn(process.execPath, [
        ...preloads.flatMap((preload) => ['--require', preload]),
        path.join(root, 'src/gateway/server.mjs')
      ], {
        env: {
          ...process.env,
          W1C_LISTENER_PROBE_OUT: probeOut,
          ...(extraProbeOut ? { PROBE_OUT: extraProbeOut } : {}),
          GATEWAY_LOG_PATH: logPath,
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
          spawned.send({
            type: 'state:init',
            challenge: message.challenge,
            state: {
              keys: JSON.parse(fs.readFileSync(statePath, 'utf8')).keys,
              credentials: { gatewayToken, adminToken: 'w1c-admin' }
            }
          });
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
  return {
    port,
    auth,
    /** The probe writes its report from a process `exit` hook, so read after exit. */
    readProbe: () => {
      try { return JSON.parse(fs.readFileSync(probeOut, 'utf8')); } catch { return null; }
    },
    readDeadWaitProbe: () => {
      if (!extraProbeOut) return null;
      try { return JSON.parse(fs.readFileSync(extraProbeOut, 'utf8')); } catch { return null; }
    },
    stopChild: async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => {
        const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
        child.once('exit', () => { clearTimeout(force); resolve(); });
        child.kill();
      });
    },
    close: async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => {
          const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
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

/** SSE frames for one Anthropic-facade turn: enough bytes to fill a socket. */
function longSseStream(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (delta) => `data: ${JSON.stringify({ id: 'chatcmpl-w1c', model: MODEL, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
  res.write(frame({ role: 'assistant', content: '' }));
  for (let index = 0; index < 4_000; index += 1) res.write(frame({ content: 'x'.repeat(256) }));
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-w1c', model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-w1c', model: MODEL, choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

/**
 * Drive one facade stream whose client repeatedly STOPS reading and resumes.
 * Every pause eventually makes `res.write` return false, which is the exact
 * path that registered the leaked pair.
 */
function stalledAnthropicStream(port, auth) {
  const body = JSON.stringify({ model: MODEL, max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] });
  return new Promise((resolve, reject) => {
    let cycles = 0;
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: { ...auth, 'content-length': Buffer.byteLength(body) }
    }, (res) => {
      res.on('data', () => {
        if (cycles >= STALL_CYCLES) return;
        cycles += 1;
        res.pause();
        setTimeout(() => res.resume(), 40);
      });
      res.on('end', () => resolve(cycles));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('defect 3: a stalled facade stream keeps a BOUNDED number of close listeners', async () => {
  const harness = await startHarness((res) => longSseStream(res));
  let probe = null;
  try {
    const cycles = await stalledAnthropicStream(harness.port, harness.auth);
    assert.ok(cycles >= 10, `the driver must actually stall the client, saw ${cycles} cycles`);
    // Let the turn finish, then stop the child so the probe's last report is final.
    await delay(200);
    await harness.stopChild();
    // READ BEFORE close(): close() removes this test's temp dir.
    probe = harness.readProbe();
  } finally { await harness.close(); }

  assert.ok(probe, 'the listener probe must report (the gateway child exited without writing it)');
  assert.ok(probe.closeRegistrations >= 20,
    `the probe must have observed the stall path, saw ${probe.closeRegistrations} close registrations`);
  // The leak signature: the peak grew 1:1 with the stall count (MEASURED before
  // the fix: 48 / 96 / 215 close listeners for 30 / 150 / 300 stalls). A peak
  // that does NOT scale with the registration count is the property under test;
  // 8 is comfortably above the fixed steady state and far below the leak.
  assert.ok(probe.peakClose <= 8,
    `close listeners must stay bounded per response, peaked at ${probe.peakClose} `
    + `(${probe.closeRegistrations} registrations over ${probe.responses} responses)`);
});

// -- Defect 4 (pass 3): a write on a DEAD response must not await forever -----
//
// MEASURED before this fix: `writeToClientAwaitDrain` registered its
// `drain`/`close` pair AFTER the failed write. If `close` had already fired,
// neither event fires again, so the promise never settled (measured unresolved
// for >1.5 s with `res.destroyed === true`) and `finalizeAnthropicStream`
// never resolved -- the whole Anthropic stream teardown hung, so the request
// never finalized (no outcome row, no key accounting).
//
// The probe below forces exactly that ordering INSIDE the gateway child: on the
// first `event: message_start` write it DESTROYS the response (the real
// teardown, so `close` fires once, now) and only THEN returns false from the
// write. Any drain/close waiter registered afterwards can never run. The probe
// counts those dead registrations; the fix must make the count zero.

const DEAD_WAIT_PROBE = `
const http = require('node:http');
const fs = require('node:fs');
const state = { armed: 0, deadWaits: 0, writes: 0 };
const originalWrite = http.ServerResponse.prototype.write;
const originalOnce = http.ServerResponse.prototype.once;
http.ServerResponse.prototype.once = function once(event, listener) {
  if ((event === 'drain' || event === 'close') && (this.destroyed === true || this.writableEnded === true)) {
    state.deadWaits += 1;
    report();
  }
  return originalOnce.call(this, event, listener);
};
http.ServerResponse.prototype.write = function write(chunk, ...rest) {
  const text = typeof chunk === 'string' ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString('latin1') : '');
  if (!this.__probeArmed && text.startsWith('event: message_start')) {
    this.__probeArmed = true;
    state.armed += 1;
    // Real teardown: 'close' fires NOW (synchronously inside destroy), before
    // the caller can register its pair. The write then reports backpressure.
    this.destroy();
    state.writes += 1;
    report();
    return false;
  }
  return originalWrite.call(this, chunk, ...rest);
};
function report() {
  try { fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(state)); } catch {}
}
report();
`;

test('defect 4: a write on an already-closed response resolves promptly and never waits on a dead event', async () => {
  const harness = await startHarness((res) => longSseStream(res), { deadWaitProbe: DEAD_WAIT_PROBE });
  let probe = null;
  try {
    // The gateway destroys the response mid-stream. The client therefore sees
    // an abort, which is EXPECTED -- what is under test is the gateway side.
    await stalledAnthropicStream(harness.port, harness.auth).catch(() => {});
    await delay(400);
    // A wedged finalize would keep the request open forever; a healthy gateway
    // still answers the next request on the same process.
    assert.equal((await request(harness.port, '/health')).statusCode, 200,
      'a dead-response write must not wedge the gateway');
    await harness.stopChild();
    probe = harness.readDeadWaitProbe();
  } finally { await harness.close(); }

  assert.ok(probe, 'the dead-wait probe must report');
  assert.ok(probe.armed >= 1, `the probe must have forced the close-before-register race, armed ${probe.armed}`);
  assert.equal(probe.deadWaits, 0,
    `no drain/close waiter may be registered on an unusable response, saw ${probe.deadWaits}`);
});
