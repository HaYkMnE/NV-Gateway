/**
 * W1h — legacy migration exclusion lock (patches 3 + 4).
 *
 *   3. A FUTURE heartbeat (a host whose clock runs ahead) used to read as fresh
 *      for years, because `now - heartbeat` goes negative. The stamp is clamped
 *      so a +10y record is stale once its REAL age exceeds STALE_LOCK_MS.
 *   4. The presence of `reclaim.json` used to stop the true owner's heartbeat
 *      unconditionally. A leftover claim then let a rival reclaim a lock whose
 *      owner was still ALIVE; the owner's release() failed with
 *      LEGACY_MIGRATION_LOCK_UNAVAILABLE and two migrations ran at once.
 *
 * The module is imported straight from src/main (Node strips the types) — no
 * compiled build is required.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const moduleUrl = pathToFileURL(path.join(root, 'src', 'main', 'legacy-migration-exclusion.ts')).href;
const sandboxRoot = process.env.W1H_TMP || os.tmpdir();
fs.mkdirSync(sandboxRoot, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(sandboxRoot, `w1h-lock-${process.pid}-`));

const { acquireLegacyMigrationExclusionLock, LEGACY_MIGRATION_EXCLUSION_LOCK_NAME } = await import(moduleUrl);

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

const STALE_LOCK_MS = 10 * 60 * 1000;
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

function temporaryDirectory(label) {
    return fs.mkdtempSync(path.join(tempRoot, `${label}-`));
}

function lockPathOf(directory) {
    return path.join(directory, LEGACY_MIGRATION_EXCLUSION_LOCK_NAME);
}

function readOwnerRecord(directory) {
    return JSON.parse(fs.readFileSync(path.join(lockPathOf(directory), 'owner.json'), 'utf8'));
}

function deadPid() {
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    assert.ok(Number.isSafeInteger(child.pid));
    return child.pid;
}

function seedLock(directory, record) {
    const lockPath = lockPathOf(directory);
    fs.mkdirSync(lockPath, { recursive: true });
    if (record !== undefined) fs.writeFileSync(path.join(lockPath, 'owner.json'), record, 'utf8');
    return lockPath;
}

function inProgress(error) {
    return error instanceof Error && error.message === 'LEGACY_MIGRATION_IN_PROGRESS';
}

function unavailable(error) {
    return error instanceof Error && error.message === 'LEGACY_MIGRATION_LOCK_UNAVAILABLE';
}

// ---------------------------------------------------------------------------
// Patch 3 — future-timestamp clamp
// ---------------------------------------------------------------------------

test('patch 3: a +10y FUTURE heartbeat is stale once its real age exceeds the threshold', () => {
    const directory = temporaryDirectory('future-heartbeat');
    const startedAtMs = Date.now() - 60 * 60 * 1000; // an hour ago
    seedLock(directory, JSON.stringify({
        pid: process.pid, // alive, but this is a recycled pid
        host: os.hostname(),
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
        heartbeatAtMs: Date.now() + TEN_YEARS_MS, // skewed host: claims the future
        ownerId: 'skewed-host-owner'
    }));

    const owner = acquireLegacyMigrationExclusionLock(directory);
    assert.notEqual(readOwnerRecord(directory).ownerId, 'skewed-host-owner', 'a future stamp must not freeze the lock forever');
    owner.release();
    assert.equal(fs.existsSync(lockPathOf(directory)), false);
});

test('patch 3: a future heartbeat on ANOTHER host is clamped too', () => {
    const directory = temporaryDirectory('future-foreign');
    const startedAtMs = Date.now() - 2 * 60 * 60 * 1000;
    seedLock(directory, JSON.stringify({
        pid: 999_999,
        host: 'some-other-host',
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
        heartbeatAtMs: Date.now() + TEN_YEARS_MS,
        ownerId: 'foreign-skewed-owner'
    }));

    const owner = acquireLegacyMigrationExclusionLock(directory);
    assert.notEqual(readOwnerRecord(directory).ownerId, 'foreign-skewed-owner');
    owner.release();
});

test('patch 3: a FRESH heartbeat is still respected (the clamp does not steal live locks)', () => {
    const directory = temporaryDirectory('fresh-heartbeat');
    seedLock(directory, JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        startedAtMs: Date.now() - 60 * 60 * 1000,
        heartbeatAtMs: Date.now(),
        ownerId: 'still-working-owner'
    }));
    assert.throws(() => acquireLegacyMigrationExclusionLock(directory), inProgress, 'a fresh heartbeat still means live');
    fs.rmSync(lockPathOf(directory), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fix pass 4 — BOTH stamps in the future (the same skewed host wrote both)
// ---------------------------------------------------------------------------

/** Both stamps in the future + a live (recycled) pid: neither stamp is usable. */
function seedBothFuture(directory, ownerId) {
    const lockPath = seedLock(directory, JSON.stringify({
        pid: process.pid, // ALIVE, but recycled by an unrelated process
        host: os.hostname(),
        startedAt: new Date(Date.now() + TEN_YEARS_MS).toISOString(),
        startedAtMs: Date.now() + TEN_YEARS_MS,
        heartbeatAtMs: Date.now() + TEN_YEARS_MS,
        ownerId
    }));
    return lockPath;
}

function ageOwnerRecord(lockPath, ageMs) {
    const recordPath = path.join(lockPath, 'owner.json');
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(recordPath, past, past);
}

test('fix C: BOTH timestamps in the future + a live recycled pid is reclaimed after the threshold (not wedged forever)', () => {
    const directory = temporaryDirectory('both-future');
    const lockPath = seedBothFuture(directory, 'both-skewed-owner');
    // The filesystem's own clock says this record is older than the threshold:
    // that is the only clock a skewed writer cannot forge.
    ageOwnerRecord(lockPath, STALE_LOCK_MS + 60_000);

    const owner = acquireLegacyMigrationExclusionLock(directory);
    assert.notEqual(readOwnerRecord(directory).ownerId, 'both-skewed-owner',
        'two future stamps must not wedge the lock forever behind a live recycled pid');
    assert.doesNotThrow(() => owner.release());
    assert.equal(fs.existsSync(lockPath), false);
});

test('fix C: BOTH timestamps in the future but a FRESH file is still live (the mtime fallback does not steal it)', () => {
    const directory = temporaryDirectory('both-future-fresh');
    const lockPath = seedBothFuture(directory, 'both-skewed-live-owner');
    // A genuinely live owner rewrites owner.json every heartbeat, so a fresh
    // mtime must still read as live even when its own stamps are skewed.
    assert.throws(() => acquireLegacyMigrationExclusionLock(directory), inProgress,
        'a record being refreshed right now must never be stolen');
    fs.rmSync(lockPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Patch 4 — a reclaim claim must not stop the true owner
// ---------------------------------------------------------------------------

test('patch 4: a rival claim next to a LIVE owner does not stop the owner beating', async () => {
    const directory = temporaryDirectory('claim-vs-live');
    const owner = acquireLegacyMigrationExclusionLock(directory);
    const first = readOwnerRecord(directory);
    // A leftover claim from a crashed reclaimer sits at the path.
    fs.writeFileSync(path.join(lockPathOf(directory), 'reclaim.json'), JSON.stringify({
        pid: deadPid(), host: os.hostname(), claimedAt: new Date().toISOString()
    }), 'utf8');

    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = readOwnerRecord(directory);
    assert.equal(second.ownerId, first.ownerId, 'the owner keeps its identity');
    assert.ok(second.heartbeatAtMs >= first.heartbeatAtMs, 'the owner must KEEP BEATING despite the claim');

    // The rival must not acquire: the owner is provably alive.
    assert.throws(() => acquireLegacyMigrationExclusionLock(directory), inProgress, 'a live owner is never stolen');
    // …and the owner's own release still succeeds (no two concurrent migrations).
    assert.doesNotThrow(() => owner.release(), 'release must succeed for the true owner');
    assert.equal(fs.existsSync(lockPathOf(directory)), false);
});

test('patch 4: after STALE_LOCK_MS with a DEAD owner the rival acquires EXACTLY once', () => {
    const directory = temporaryDirectory('claim-dead-owner');
    const pid = deadPid();
    const lockPath = seedLock(directory, JSON.stringify({
        pid,
        host: os.hostname(),
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        startedAtMs: Date.now() - 60_000,
        heartbeatAtMs: Date.now() - 60_000,
        ownerId: 'crashed-migration-owner'
    }));
    // An OLD leftover claim must not block the takeover either.
    fs.writeFileSync(path.join(lockPath, 'reclaim.json'), JSON.stringify({
        pid: deadPid(), host: os.hostname(), claimedAt: new Date(Date.now() - STALE_LOCK_MS - 60_000).toISOString()
    }), 'utf8');

    const owner = acquireLegacyMigrationExclusionLock(directory);
    assert.notEqual(readOwnerRecord(directory).ownerId, 'crashed-migration-owner');
    // Exactly once: a second acquire while we hold it is IN_PROGRESS, never a
    // second winner.
    assert.throws(() => acquireLegacyMigrationExclusionLock(directory), inProgress, 'only one winner');
    assert.doesNotThrow(() => owner.release());
    assert.equal(fs.existsSync(lockPath), false);
});

test('patch 4: release still fails honestly when a SUCCESSOR owns the record', () => {
    const directory = temporaryDirectory('claim-successor');
    const owner = acquireLegacyMigrationExclusionLock(directory);
    const current = readOwnerRecord(directory);
    // Simulate a takeover: the record now names someone else.
    fs.writeFileSync(path.join(lockPathOf(directory), 'owner.json'), JSON.stringify({
        ...current, ownerId: 'a-different-live-owner'
    }), 'utf8');
    assert.throws(() => owner.release(), unavailable, 'a terminal handle must not erase a successor');
    fs.rmSync(lockPathOf(directory), { recursive: true, force: true });
});

test('patch 4: O_EXCL one-winner semantics are intact for a stale lock with a stale claim', () => {
    const directory = temporaryDirectory('one-winner');
    const lockPath = seedLock(directory, JSON.stringify({
        pid: deadPid(),
        host: os.hostname(),
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        startedAtMs: Date.now() - 60_000,
        heartbeatAtMs: Date.now() - 60_000,
        ownerId: 'crashed-migration-owner-2'
    }));
    fs.writeFileSync(path.join(lockPath, 'reclaim.json'), JSON.stringify({
        pid: deadPid(), host: os.hostname(), claimedAt: new Date(Date.now() - STALE_LOCK_MS - 60_000).toISOString()
    }), 'utf8');

    const winner = acquireLegacyMigrationExclusionLock(directory);
    for (let i = 0; i < 3; i += 1) {
        assert.throws(() => acquireLegacyMigrationExclusionLock(directory), inProgress, `rival ${i} must not win`);
    }
    winner.release();
    assert.equal(fs.existsSync(lockPath), false);
});
