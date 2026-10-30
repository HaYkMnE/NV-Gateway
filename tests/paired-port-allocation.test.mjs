import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import test from 'node:test';

import { getPairLockPaths, reservePortPair, startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';

async function listen(port = 0) {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
async function close(server) { await new Promise((resolve) => server.close(resolve)); }

// Bounded child-exit wait: resolves with the exit code, or rejects after the
// timeout so a wedged child surfaces as a test failure instead of a suite hang.
function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}
let candidateRound = 0;
// Deterministic ODD-port candidates, pid-scattered, drawn from 65001-65499 so
// that BOTH legs of each pair (P and P+1) sit above the band the other paired
// suites reserve. Those suites take EVEN candidates (40000 + even offsets) and
// reserve each as a PAIR, so their reserved union is [40000, 64999]; this
// file's pairs stay within [65001, 65500] and never overlap it. The OS
// ephemeral allocator was observed far below this range on this class of
// machine, and probing still skips occupied/excluded ports and any pair with
// leftover lock files.
async function candidatePair() {
  const round = candidateRound++;
  const candidates = Array.from({ length: 200 }, (_, offset) => 65001 + ((process.pid * 2 + (round * 200 + offset) * 2) % 500));
  for (const port of candidates) {
    const paths = getPairLockPaths(port);
    if (fs.existsSync(paths.gateway) || fs.existsSync(paths.admin)) continue;
    const first = await listen(port).catch(() => null);
    if (!first) continue;
    const second = await listen(port + 1).catch(() => null);
    if (!second) { await close(first); continue; }
    await close(first); await close(second); return port;
  }
  throw new Error('No paired test port is available.');
}

test('exclusive lock files refuse the same pair across worker processes', async () => {
  const reservation = await reservePortPair();
  try {
    const moduleUrl = new URL('./support/paired-port-allocation.mjs', import.meta.url).href;
    const script = `import(${JSON.stringify(moduleUrl)}).then(async ({reservePortPair}) => { try { await reservePortPair({ candidatePorts: [${reservation.port}], maxAttempts: 1 }); process.exit(0); } catch { process.exit(23); } });`;
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore', windowsHide: true });
    // Bounded wait: an unbounded `once('exit')` lets a child that never starts or
    // never exits hang the entire suite (observed as a stall with zero failures
    // on an otherwise-green run). 30s is far beyond the expected ~0.2s.
    assert.equal(await waitForChildExit(child, 30_000), 23, 'the competing worker must be refused the locked pair');
  } finally { await reservation.release(); }
});

test('an occupied P+1 rejects that pair and selects a fresh pair', async () => {
  // Blocker acquisition retries across fresh deterministic candidates in case a
  // verified-free port is taken in the probe-to-bind gap.
  let blocked = 0; let blocker = null;
  for (let tries = 0; tries < 10 && !blocker; tries++) {
    blocked = await candidatePair();
    blocker = await listen(blocked + 1).catch(() => null);
  }
  assert.ok(blocker, 'unable to occupy a probe pair for the blocked candidate');
  const fallback = await candidatePair();
  try {
    const reservation = await reservePortPair({ candidatePorts: [blocked, fallback], maxAttempts: 2 });
    try { assert.equal(reservation.port, fallback); } finally { await reservation.release(); }
  } finally { await close(blocker); }
});

test('stale dead-owner lock files are recovered with bounded cleanup', async () => {
  let port;
  let paths;
  do {
    port = await candidatePair(); paths = getPairLockPaths(port);
  } while (fs.existsSync(paths.gateway) || fs.existsSync(paths.admin));
  fs.mkdirSync(paths.directory, { recursive: true });
  const stale = JSON.stringify({ pid: 2147483646, createdAt: Date.now() - 3_600_000, token: 'stale-test-owner' });
  fs.writeFileSync(paths.gateway, stale, { flag: 'wx' }); fs.writeFileSync(paths.admin, stale, { flag: 'wx' });
  const reservation = await reservePortPair({ candidatePorts: [port], maxAttempts: 1, staleLockMs: 1_000 });
  await reservation.release();
  assert.equal(fs.existsSync(paths.gateway), false); assert.equal(fs.existsSync(paths.admin), false);
});

test('a non-port startup error fails immediately without blind retry or readiness wait', async () => {
  // Load-independent proof: the readiness budget is huge, so settling well under
  // half of it can only mean the child's exit short-circuited the wait (no wall-clock 5 s guess).
  const READINESS_MS = 60_000;
  let attempts = 0; const startedAt = Date.now();
  await assert.rejects(startGatewayOnReservedPort({ readinessTimeoutMs: READINESS_MS, maxAttempts: 4, spawnChild() {
    attempts += 1;
    return spawn(process.execPath, ['-e', 'console.error("configuration exploded"); process.exit(7)'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  } }), (e) => e.childExited === true && e.exitCode === 7 && /configuration exploded/.test(e.stderr));
  const elapsed = Date.now() - startedAt;
  assert.equal(attempts, 1);
  assert.ok(elapsed < READINESS_MS / 2, `settled in ${elapsed}ms; a readiness wait takes ${READINESS_MS}ms`);
});

test('a classified bind collision retries with a freshly reserved pair', { timeout: 90_000 }, async () => {
  const ports = [];
  const result = await startGatewayOnReservedPort({ maxAttempts: 2, readinessTimeoutMs: 20_000, spawnChild(port, attempt) {
    ports.push(port);
    if (attempt === 1) return spawn(process.execPath, ['-e', 'console.error("EADDRINUSE: bind collision"); process.exit(1)'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    return spawn(process.execPath, ['-e', `process.send({ type: 'ports:bound', gatewayPort: ${port}, adminPort: ${port + 1} }); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  } });
  try { assert.equal(result.attempt, 2); assert.equal(new Set(ports).size, 2); } finally { result.child.kill('SIGKILL'); }
});

test('a caller-provided reservationOptions.maxAttempts is honoured, not clobbered', async () => {
  // `startGatewayOnReservedPort` passes reservation attempts down to
  // `reservePortPair`. A caller who sets `reservationOptions.maxAttempts` must
  // keep that value; only an explicit `reservationAttempts` may override it.
  // Proof: reserve to an ALREADY-LOCKED pair with maxAttempts: 1 while pointing
  // the candidate list at a free pair behind it. If the caller's maxAttempts: 1
  // survives, reservePortPair tries the locked pair, fails, and exhausts in ONE
  // attempt — never reaching the free pair in the list. If the value were
  // clobbered by the default (8/20), the reservation would consume the locked
  // pair and then succeed on the fallback, so the start would NOT fail.

  const blocked = await candidatePair();
  const fallback = await candidatePair();
  const blocker = await listen(blocked);
  const paths = getPairLockPaths(blocked);
  fs.mkdirSync(paths.directory, { recursive: true });
  // Occupy the pair with a LIVE owner so stale-lock recovery cannot reclaim it.
  const owned = { pid: process.pid, createdAt: Date.now(), token: 'honour-max-attempts' };
  fs.writeFileSync(paths.gateway, JSON.stringify(owned), { flag: 'wx' });
  fs.writeFileSync(paths.admin, JSON.stringify(owned), { flag: 'wx' });

  let spawnCalls = 0;
  try {
    await assert.rejects(
      startGatewayOnReservedPort({
        maxAttempts: 1,
        readinessTimeoutMs: 2_000,
        reservationOptions: { candidatePorts: [blocked, fallback], maxAttempts: 1 },
        spawnChild() { spawnCalls += 1; return spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true }); }
      }),
      /Unable to reserve a free gateway port pair after 1 attempts/
    );
    assert.equal(spawnCalls, 0,
      'a reservation that exhausts the caller-supplied maxAttempts must not reach spawnChild');
  } finally {
    await close(blocker);
    fs.rmSync(paths.gateway, { force: true });
    fs.rmSync(paths.admin, { force: true });
  }
});

test('concurrent gateway-style starts reserve distinct pairs without collisions', { timeout: 90_000 }, async () => {
  const spawned = new Set();
  const stopTracked = (child) => new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) { spawned.delete(child); resolve(); return; }
    const escalate = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1_000);
    const giveUp = setTimeout(() => { clearTimeout(escalate); spawned.delete(child); resolve(); }, 5_000);
    child.once('exit', () => { clearTimeout(escalate); clearTimeout(giveUp); spawned.delete(child); resolve(); });
    try { child.kill(); } catch { clearTimeout(escalate); clearTimeout(giveUp); spawned.delete(child); resolve(); }
  });
  try {
    for (let round = 0; round < 10; round++) {
      const starts = await Promise.all(Array.from({ length: 4 }, () => startGatewayOnReservedPort({ maxAttempts: 4, reservationAttempts: 20, readinessTimeoutMs: 20_000, spawnChild(port) {
        const child = spawn(process.execPath, ['-e', `const net=require('net'); const a=net.createServer(); const b=net.createServer(); a.listen(${port}, '127.0.0.1', () => b.listen(${port + 1}, '127.0.0.1', () => process.send({type:'ports:bound',gatewayPort:${port},adminPort:${port + 1}}))); setInterval(()=>{},1000);`], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
        spawned.add(child);
        child.once('exit', () => spawned.delete(child));
        return child;
      } })));
      assert.equal(new Set(starts.map((entry) => entry.port)).size, starts.length);
      await Promise.all(starts.map(({ child }) => new Promise((resolve) => {
        const giveUp = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 5_000);
        child.once('exit', () => { clearTimeout(giveUp); resolve(); });
        try { child.kill('SIGKILL'); } catch { clearTimeout(giveUp); resolve(); }
      })));
    }
  } finally {
    await Promise.all([...spawned].map(stopTracked));
  }
});
