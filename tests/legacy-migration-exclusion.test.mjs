/**
 * W1f finding 2 - legacy migration exclusion lock liveness.
 *
 * The mkdir lock used to carry NO owner record: a lock left behind by a crashed
 * migration returned LEGACY_MIGRATION_IN_PROGRESS forever and blocked the
 * documented recovery path. The lock must now be owned (pid + start timestamp +
 * host) and a stale owner must be reclaimable ATOMICALLY, while two processes
 * reclaiming at the same time must never both win.
 *
 * The module is imported straight from src/main (Node strips the types), so no
 * compiled build is required for these unit tests.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const moduleUrl = pathToFileURL(path.join(root, 'src', 'main', 'legacy-migration-exclusion.ts')).href;
const sandboxRoot = process.env.W1F_TMP || os.tmpdir();
fs.mkdirSync(sandboxRoot, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(sandboxRoot, `nv-legacy-lock-${process.pid}-`));

const { acquireLegacyMigrationExclusionLock, LEGACY_MIGRATION_EXCLUSION_LOCK_NAME } = await import(moduleUrl);

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function temporaryDirectory(label) {
  return fs.mkdtempSync(path.join(tempRoot, `${label}-`));
}

function lockPathOf(directory) {
  return path.join(directory, LEGACY_MIGRATION_EXCLUSION_LOCK_NAME);
}

function readOwnerRecord(directory) {
  return JSON.parse(fs.readFileSync(path.join(lockPathOf(directory), 'owner.json'), 'utf8'));
}

/** A pid that is guaranteed not to be running: a child that already exited. */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(Number.isSafeInteger(child.pid), 'spawnSync must report the finished child pid');
  return child.pid;
}

function seedStaleLock(directory, record) {
  const lockPath = lockPathOf(directory);
  fs.mkdirSync(lockPath, { recursive: true });
  if (record !== undefined) fs.writeFileSync(path.join(lockPath, 'owner.json'), record, 'utf8');
  return lockPath;
}

function ageLock(directory, ageMs) {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPathOf(directory), when, when);
  return when;
}

function inProgress(error) {
  return error instanceof Error && error.message === 'LEGACY_MIGRATION_IN_PROGRESS';
}

const WORKER = `
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const [,, modulePath, userDataPath, readyPath, barrierPath, resultPath, donePath] = process.argv;
(async () => {
  const { acquireLegacyMigrationExclusionLock } = await import(pathToFileURL(modulePath).href);
  fs.writeFileSync(readyPath, 'ready', { flag: 'wx' });
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(barrierPath)) {
    if (Date.now() > deadline) process.exit(14);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  let outcome;
  try {
    acquireLegacyMigrationExclusionLock(userDataPath);
    outcome = 'acquired';
  } catch (error) {
    outcome = error && error.message === 'LEGACY_MIGRATION_IN_PROGRESS' ? 'in_progress' : 'error:' + (error && error.message);
  }
  fs.writeFileSync(resultPath, outcome);
  // Hold the lock (and this pid) until the parent has collected BOTH verdicts.
  // Exiting first would legitimately free the lock, letting the straggler
  // reclaim it and making "exactly one winner" unprovable.
  if (donePath) {
    while (!fs.existsSync(donePath)) {
      if (Date.now() > deadline + 15000) process.exit(15);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  process.exit(outcome === 'acquired' ? 0 : outcome === 'in_progress' ? 10 : 11);
})().catch(() => process.exit(13));
`;

function waitForFile(filePath, child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (fs.existsSync(filePath)) return resolve();
      if (child && child.exitCode !== null) return reject(new Error(`worker exited before readiness: ${child.exitCode}`));
      if (Date.now() >= deadline) return reject(new Error('worker readiness timed out'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('normal acquire/release round-trip leaves an owned lock and no residue', () => {
  const directory = temporaryDirectory('roundtrip');

  const owner = acquireLegacyMigrationExclusionLock(directory);
  const record = readOwnerRecord(directory);
  assert.equal(record.pid, process.pid, 'the owner record must name the holding process');
  assert.equal(record.host, os.hostname(), 'the owner record must name the host');
  assert.ok(Number.isFinite(record.startedAtMs), 'the owner record must carry a start timestamp');
  assert.equal(typeof record.ownerId, 'string');
  assert.ok(record.ownerId.length >= 16, 'the owner record must carry an unguessable identity');

  assert.throws(() => acquireLegacyMigrationExclusionLock(directory), inProgress, 'a live owner blocks a second acquire');

  owner.release();
  assert.equal(fs.existsSync(lockPathOf(directory)), false, 'release removes the whole lock');

  const successor = acquireLegacyMigrationExclusionLock(directory);
  assert.equal(fs.existsSync(lockPathOf(directory)), true, 'the lock is reusable after release');
  successor.release();
  assert.equal(fs.existsSync(lockPathOf(directory)), false);
});

test('a lock owned by a LIVE pid still blocks a second process', async () => {
  const directory = temporaryDirectory('live');
  const owner = acquireLegacyMigrationExclusionLock(directory);
  const workerPath = path.join(directory, 'worker.cjs');
  fs.writeFileSync(workerPath, WORKER, 'utf8');
  const readyPath = path.join(directory, 'live.ready');
  const barrierPath = path.join(directory, 'live.barrier');
  const resultPath = path.join(directory, 'live.result');
  const child = spawn(process.execPath, [workerPath, path.join(root, 'src', 'main', 'legacy-migration-exclusion.ts'), directory, readyPath, barrierPath, resultPath], { stdio: 'ignore' });
  try {
    await waitForFile(readyPath, child);
    fs.writeFileSync(barrierPath, 'go', { flag: 'wx' });
    assert.deepEqual(await waitForExit(child), { code: 10, signal: null }, 'a live owner must block the other process');
    assert.equal(fs.readFileSync(resultPath, 'utf8'), 'in_progress');
    assert.equal(fs.existsSync(lockPathOf(directory)), true, 'the live owner keeps its lock');
  } finally {
    if (child.exitCode === null) child.kill();
    owner.release();
  }
});

test('a lock left by a dead pid is reclaimed instead of blocking forever', () => {
  const directory = temporaryDirectory('dead-pid');
  const pid = deadPid();
  seedStaleLock(directory, JSON.stringify({
    pid,
    host: os.hostname(),
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    startedAtMs: Date.now() - 60_000,
    ownerId: 'crashed-migration-owner'
  }));

  const owner = acquireLegacyMigrationExclusionLock(directory);
  const record = readOwnerRecord(directory);
  assert.equal(record.pid, process.pid, 'the reclaimer must install its own owner record');
  assert.notEqual(record.ownerId, 'crashed-migration-owner');
  owner.release();
  assert.equal(fs.existsSync(lockPathOf(directory)), false, 'the reclaimed lock is fully removable');
});

test('an unreadable/empty owner record is reclaimed once the lock is older than the stale threshold', () => {
  for (const record of ['', 'not json at all', '{}', JSON.stringify({ pid: 'nope' })]) {
    const directory = temporaryDirectory('corrupt');
    seedStaleLock(directory, record);
    ageLock(directory, 60 * 60 * 1000);
    const owner = acquireLegacyMigrationExclusionLock(directory);
    assert.equal(readOwnerRecord(directory).pid, process.pid, `record ${JSON.stringify(record)} must be reclaimable`);
    owner.release();
    assert.equal(fs.existsSync(lockPathOf(directory)), false);
  }

  // A FRESH owner-less lock is NOT stolen: it may be a migration that is still
  // writing its record (or an older build), so it fails closed.
  const fresh = temporaryDirectory('corrupt-fresh');
  seedStaleLock(fresh, 'not json at all');
  assert.throws(() => acquireLegacyMigrationExclusionLock(fresh), inProgress, 'a fresh unreadable lock is never stolen');
});

test('a lock without any owner record is reclaimed once it is older than the stale threshold', () => {
  const directory = temporaryDirectory('ownerless');
  seedStaleLock(directory, undefined);
  ageLock(directory, 60 * 60 * 1000);
  const owner = acquireLegacyMigrationExclusionLock(directory);
  assert.equal(readOwnerRecord(directory).pid, process.pid);
  owner.release();
});

test('a readable owner record with a live pid AND a fresh heartbeat is respected even when it is old', () => {
  const directory = temporaryDirectory('old-live');
  seedStaleLock(directory, JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
    startedAtMs: Date.now() - 10 * 60 * 60 * 1000,
    // The owner keeps refreshing its heartbeat, so it is provably still working.
    heartbeatAtMs: Date.now(),
    ownerId: 'long-running-live-owner'
  }));
  assert.throws(() => acquireLegacyMigrationExclusionLock(directory), inProgress, 'a provably live owner is never stolen');
  fs.rmSync(lockPathOf(directory), { recursive: true, force: true });
});

test('a RECYCLED live pid is detected as stale: a stale heartbeat, not liveness, decides', () => {
  // The reported wedge: the recorded pid now belongs to an unrelated LIVE
  // process, so `kill(pid, 0)` says "alive" forever and an 8h-old record blocked
  // every later migration. Ownership must be proven by the heartbeat the real
  // owner refreshes, not by the pid number alone.
  const directory = temporaryDirectory('recycled-pid');
  seedStaleLock(directory, JSON.stringify({
    pid: process.pid, // genuinely alive, but NOT the process that wrote the record
    host: os.hostname(),
    startedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    startedAtMs: Date.now() - 8 * 60 * 60 * 1000,
    heartbeatAtMs: Date.now() - 8 * 60 * 60 * 1000,
    ownerId: 'recycled-migration-owner'
  }));

  const owner = acquireLegacyMigrationExclusionLock(directory);
  const record = readOwnerRecord(directory);
  assert.equal(record.pid, process.pid);
  assert.notEqual(record.ownerId, 'recycled-migration-owner', 'the reclaimer installs its own identity');
  assert.ok(Number.isFinite(record.heartbeatAtMs), 'a new owner record always carries a heartbeat');
  owner.release();
  assert.equal(fs.existsSync(lockPathOf(directory)), false);
});

test('a legacy record without a heartbeat cannot prove ownership by pid alone once it is old', () => {
  // Records written before heartbeats existed carry none. Their pid may have
  // been recycled, so only age can make them reclaimable — a young one is still
  // respected (see the corrupt/fresh case above).
  const directory = temporaryDirectory('legacy-old');
  seedStaleLock(directory, JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    startedAtMs: Date.now() - 8 * 60 * 60 * 1000,
    ownerId: 'legacy-heartbeatless-owner'
  }));
  const owner = acquireLegacyMigrationExclusionLock(directory);
  assert.notEqual(readOwnerRecord(directory).ownerId, 'legacy-heartbeatless-owner');
  owner.release();
});

test('the owner refreshes its heartbeat while it holds the lock', async () => {
  const directory = temporaryDirectory('heartbeat');
  const workerPath = path.join(directory, 'heartbeat-worker.cjs');
  // This worker keeps its event loop FREE (async waits) so the heartbeat timer
  // can actually fire — the shared WORKER spins on Atomics.wait by design.
  fs.writeFileSync(workerPath, `
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const [,, modulePath, userDataPath, readyPath, donePath] = process.argv;
(async () => {
  const { acquireLegacyMigrationExclusionLock } = await import(pathToFileURL(modulePath).href);
  const lock = acquireLegacyMigrationExclusionLock(userDataPath);
  fs.writeFileSync(readyPath, 'acquired', { flag: 'wx' });
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(donePath)) {
    if (Date.now() > deadline) process.exit(15);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  lock.release();
  process.exit(0);
})().catch(() => process.exit(13));
`, 'utf8');
  const readyPath = path.join(directory, 'hb.ready');
  const donePath = path.join(directory, 'hb.done');
  const child = spawn(process.execPath, [workerPath, path.join(root, 'src', 'main', 'legacy-migration-exclusion.ts'), directory, readyPath, donePath], {
    stdio: 'ignore',
    env: { ...process.env, NV_GATEWAY_LEGACY_LOCK_HEARTBEAT_MS: '25' }
  });
  try {
    await waitForFile(readyPath, child);
    assert.equal(fs.readFileSync(readyPath, 'utf8'), 'acquired');
    const first = readOwnerRecord(directory);
    assert.equal(first.pid, child.pid, 'the child owns the lock');
    assert.ok(Number.isFinite(first.heartbeatAtMs), 'the owner record carries a heartbeat');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const second = readOwnerRecord(directory);
    assert.equal(second.ownerId, first.ownerId, 'the heartbeat never rewrites the owner identity');
    assert.ok(second.heartbeatAtMs > first.heartbeatAtMs, 'the heartbeat must advance while the lock is held');
    assert.ok(Date.now() - second.heartbeatAtMs < 60_000, 'the heartbeat stays close to now');
  } finally {
    try { fs.writeFileSync(donePath, 'done', { flag: 'wx' }); } catch { /* already written */ }
    await Promise.race([waitForExit(child), new Promise((resolve) => setTimeout(resolve, 10_000))]);
    if (child.exitCode === null) child.kill();
  }
});

test('a reclaim claim held by a live but HUNG pid is reclaimed once it ages past the threshold', () => {
  // A reclaimer that dies (or hangs) mid-takeover must not wedge reclaims
  // forever. Age wins for the CLAIM file only; the main lock keeps its
  // liveness rule.
  const directory = temporaryDirectory('hung-claim');
  const pid = deadPid();
  const lockPath = seedStaleLock(directory, JSON.stringify({
    pid,
    host: os.hostname(),
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    startedAtMs: Date.now() - 60_000,
    ownerId: 'crashed-migration-owner'
  }));
  fs.writeFileSync(path.join(lockPath, 'reclaim.json'), JSON.stringify({
    pid: process.pid, // alive, but not making progress
    host: os.hostname(),
    claimedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
  }), 'utf8');

  const owner = acquireLegacyMigrationExclusionLock(directory);
  assert.notEqual(readOwnerRecord(directory).ownerId, 'crashed-migration-owner');
  owner.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test('a FRESH reclaim claim held by a live pid still blocks the takeover', () => {
  const directory = temporaryDirectory('fresh-claim');
  const pid = deadPid();
  const lockPath = seedStaleLock(directory, JSON.stringify({
    pid,
    host: os.hostname(),
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    startedAtMs: Date.now() - 60_000,
    ownerId: 'crashed-migration-owner'
  }));
  fs.writeFileSync(path.join(lockPath, 'reclaim.json'), JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    claimedAt: new Date().toISOString()
  }), 'utf8');
  assert.throws(() => acquireLegacyMigrationExclusionLock(directory), inProgress, 'a live reclaimer in its critical section is respected');
  fs.rmSync(lockPath, { recursive: true, force: true });
});

test('a reclaim claim left by a DEAD pid is taken over immediately', () => {
  const directory = temporaryDirectory('dead-claim');
  const pid = deadPid();
  const lockPath = seedStaleLock(directory, JSON.stringify({
    pid,
    host: os.hostname(),
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    startedAtMs: Date.now() - 60_000,
    ownerId: 'crashed-migration-owner'
  }));
  fs.writeFileSync(path.join(lockPath, 'reclaim.json'), JSON.stringify({
    pid,
    host: os.hostname(),
    claimedAt: new Date().toISOString()
  }), 'utf8');
  const owner = acquireLegacyMigrationExclusionLock(directory);
  assert.notEqual(readOwnerRecord(directory).ownerId, 'crashed-migration-owner');
  owner.release();
});

test('a leftover atomic-write temp file never makes an owned lock look foreign', () => {
  const directory = temporaryDirectory('owner-tmp');
  const pid = deadPid();
  const lockPath = seedStaleLock(directory, JSON.stringify({
    pid,
    host: os.hostname(),
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    startedAtMs: Date.now() - 60_000,
    ownerId: 'crashed-migration-owner'
  }));
  // A crash between write and rename leaves the temp behind; it is this
  // module's own artifact, not foreign state.
  fs.writeFileSync(path.join(lockPath, 'owner.json.tmp'), '{"partial":', 'utf8');
  const owner = acquireLegacyMigrationExclusionLock(directory);
  assert.notEqual(readOwnerRecord(directory).ownerId, 'crashed-migration-owner');
  owner.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test('two concurrent reclaimers of one stale lock: exactly one wins', async () => {
  const workerPath = path.join(tempRoot, 'race-worker.cjs');
  fs.writeFileSync(workerPath, WORKER, 'utf8');
  const pid = deadPid();

  for (let round = 0; round < 5; round += 1) {
    const directory = temporaryDirectory(`race-${round}`);
    seedStaleLock(directory, JSON.stringify({
      pid,
      host: os.hostname(),
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      startedAtMs: Date.now() - 60_000,
      ownerId: `crashed-migration-owner-${round}`
    }));
    const barrierPath = path.join(directory, 'barrier');
    const donePath = path.join(directory, 'done');
    const workers = [0, 1].map((index) => {
      const readyPath = path.join(directory, `ready-${index}`);
      const resultPath = path.join(directory, `result-${index}`);
      return {
        resultPath,
        child: spawn(process.execPath, [workerPath, path.join(root, 'src', 'main', 'legacy-migration-exclusion.ts'), directory, readyPath, barrierPath, resultPath, donePath], { stdio: 'ignore' })
      };
    });
    try {
      await Promise.all(workers.map(({ child }, index) => waitForFile(path.join(directory, `ready-${index}`), child)));
      fs.writeFileSync(barrierPath, 'go', { flag: 'wx' });
      await Promise.all(workers.map(({ resultPath }) => waitForFile(resultPath, null).catch(() => null)));
      const outcomes = workers.map(({ resultPath }) => fs.readFileSync(resultPath, 'utf8'));
      assert.equal(outcomes.filter((outcome) => outcome === 'acquired').length, 1,
        `round ${round}: exactly one reclaimer may win, saw ${JSON.stringify(outcomes)}`);
      assert.equal(outcomes.filter((outcome) => outcome === 'in_progress').length, 1,
        `round ${round}: the loser must report IN_PROGRESS, saw ${JSON.stringify(outcomes)}`);
      assert.equal(fs.existsSync(lockPathOf(directory)), true, 'the winner keeps the lock');
      assert.equal(readOwnerRecord(directory).pid !== pid, true, 'the winner installed a live owner');
      // Release the workers only now that both verdicts are collected.
      fs.writeFileSync(donePath, 'done', { flag: 'wx' });
      await Promise.all(workers.map(({ child }) => waitForExit(child)));
    } finally {
      for (const { child } of workers) if (child.exitCode === null) child.kill();
    }
  }
});
