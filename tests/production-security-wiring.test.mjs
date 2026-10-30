// Phase 5: opt out of the nvidia-catalog-sync top-level background warm so this
// test process does not make real NGC network calls during the admin-api import
// (admin-api.mjs now imports nvidia-catalog-sync.mjs, which self-warms at top
// level unless NGC_CATALOG_SYNC_DISABLE_WARM=1). Tests here do not invoke any
// handler that calls getAllModelMetadata(), so the metadata cache itself is
// irrelevant; disabling the warm keeps the test hermetic without changing its
// observations.
process.env.NGC_CATALOG_SYNC_DISABLE_WARM = "1";

import os from 'node:os';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { reservePortPair } from './support/paired-port-allocation.mjs';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const sandboxRoot = os.tmpdir();
const temporaryDirectories = new Set();
const reservationDirectory = path.join(sandboxRoot, 'nvgw-test-port-reservations');
const pairReservations = new Set();
const productionMigrationPort = migrationPortFromSource();

fs.mkdirSync(reservationDirectory, { recursive: true });

test.after(async () => {
  for (const reservation of pairReservations) {
    if (typeof reservation?.release === 'function') await reservation.release();
    else releaseReservation(reservation);
  }
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(sandboxRoot, prefix));
  temporaryDirectories.add(directory);
  return directory;
}

// The gateway logger resolves its file from GATEWAY_LOG_PATH ONCE at import time
// and appends on a 1s debounce. Pointing that at tests/ left an ignored
// non-live-log.jsonl side-effect file in the repo after every run, so both
// admin-api tests share one per-run temp dir (cleaned by the after hook above).
let adminLogDirectory = null;
function adminLogPath() {
  adminLogDirectory ??= temporaryDirectory('nvgw-admin-log-');
  return path.join(adminLogDirectory, 'non-live-log.jsonl');
}

test('secure store migrates both plaintext files and persists encrypted credentials atomically', async () => {
  const { SecureStore } = await import(built('secure-state.js'));
  const dir = temporaryDirectory('nvgw-store-');
  const sentinel = 'nvapi-PLAINTEXT-SENTINEL';
  const statePath = path.join(dir, 'keys.json');
  fs.writeFileSync(statePath, JSON.stringify({ keys: [{ id: 'x', key: sentinel }] }));
  fs.writeFileSync(`${statePath}.bak`, JSON.stringify({ keys: [{ id: 'y', key: `${sentinel}-bak` }] }));
  const protectedPaths = [];
  const adapter = { encrypt: (v) => Buffer.from(v).map((b) => b ^ 0xaa), decrypt: (v) => Buffer.from(v).map((b) => b ^ 0xaa) };
  const store = new SecureStore(statePath, adapter, (value) => protectedPaths.push(path.resolve(value)));
  const loaded = store.initialize();
  assert.equal(loaded.keys[0].key, sentinel);
  store.persist({ ...loaded, credentials: { gatewayToken: 'gateway-sentinel', adminToken: 'admin-sentinel' } });
  for (const entry of fs.readdirSync(dir)) {
    const bytes = fs.readFileSync(path.join(dir, entry));
    assert.equal(bytes.includes(Buffer.from(sentinel)), false, entry);
    assert.equal(bytes.includes(Buffer.from('gateway-sentinel')), false, entry);
  }
  assert.equal(fs.existsSync(`${statePath}.bak`), false);
  assert.ok(protectedPaths.some((value) => value.endsWith('keys.json')));
  assert.ok(protectedPaths.some((value) => value.endsWith('keys.json.encrypted.bak')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('private channel binds a child-generated challenge to the attached IPC child', async () => {
  const { createPrivateStateChannel } = await import(built('private-state-channel.js'));
  const messages = [];
  const child = new EventEmitter(); child.connected = true; child.send = (value, callback) => { messages.push(value); callback?.(null); };
  let persisted;
  const channel = createPrivateStateChannel({ initialState: { keys: [{ key: 'secret' }] }, persist: (state) => { persisted = state; } });
  channel.attach(child);
  child.emit('message', { type: 'ready', challenge: '' });
  assert.equal(messages.length, 0);
  child.emit('message', { type: 'ready', challenge: 'child-random-challenge-1234567890' });
  assert.deepEqual(messages[0], { type: 'state:init', challenge: 'child-random-challenge-1234567890', state: { keys: [{ key: 'secret' }] } });
  child.emit('message', { type: 'state:persist', state: { keys: [] } });
  assert.deepEqual(persisted, { keys: [] });
  assert.equal(channel.authenticated, true);
  assert.equal(channel.initializationSent, true);
  assert.equal(channel.challenge, 'child-random-challenge-1234567890');
});

test('private channel reports synchronous state-init send failure without false authentication or an escaping throw', async () => {
  const { createPrivateStateChannel } = await import(built('private-state-channel.js'));
  const child = new EventEmitter();
  child.connected = true;
  child.send = (value) => JSON.stringify(value);
  const channel = createPrivateStateChannel({ initialState: { keys: [], allowedExtra: 1n }, persist: () => {} });
  channel.attach(child);

  assert.doesNotThrow(() => child.emit('message', { type: 'ready', challenge: 'sync-failure-challenge-123456789' }));
  assert.equal(channel.authenticated, false);
  assert.equal(channel.initializationSent, false);
  assert.equal(channel.failed, true);
  assert.equal(channel.challenge, null);
});

test('private channel reports async send callback failure and callback success exactly once', async () => {
  const { createPrivateStateChannel } = await import(built('private-state-channel.js'));
  for (const [error, expected] of [[new Error('private callback detail'), false], [null, true]]) {
    const child = new EventEmitter();
    child.connected = true;
    let sends = 0;
    child.send = (_value, callback) => {
      sends += 1;
      setImmediate(() => { callback(error); callback(error ? null : new Error('late duplicate callback')); });
      return true;
    };
    const channel = createPrivateStateChannel({ initialState: { keys: [] }, persist: () => {} });
    channel.attach(child);
    assert.doesNotThrow(() => child.emit('message', { type: 'ready', challenge: 'callback-channel-challenge-123456' }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sends, 1);
    assert.equal(channel.authenticated, expected);
    assert.equal(channel.initializationSent, expected);
    assert.equal(channel.failed, !expected);
    assert.equal(channel.challenge, expected ? 'callback-channel-challenge-123456' : null);
  }
});

test('private channel acknowledges a revision only after durable persistence settles', async () => {
  const { createPrivateStateChannel } = await import(built('private-state-channel.js'));
  const sent = [];
  const child = new EventEmitter();
  child.connected = true;
  child.send = (value, callback) => { sent.push(value); callback?.(null); return true; };
  let persistCalls = 0;
  let settle;
  const persist = () => { persistCalls += 1; return persistCalls === 2 ? new Promise((resolve) => { settle = resolve; }) : undefined; };
  const channel = createPrivateStateChannel({ initialState: { keys: [] }, persist });
  channel.attach(child);
  child.emit('message', { type: 'ready', challenge: 'durable-ack-challenge-12345678' });
  assert.deepEqual(sent.map((m) => m.type), ['state:init']);

  // A legacy fire-and-forget persist carries no request context and earns no ack.
  child.emit('message', { type: 'state:persist', state: { keys: [] } });
  assert.equal(persistCalls, 1);
  assert.equal(sent.some((m) => m.type === 'state:persist:ack'), false, 'legacy saves are not acknowledged');

  // A durable persist (requestId + revision) is acknowledged with BOTH echoed.
  child.emit('message', { type: 'state:persist', state: { keys: [] }, requestId: 'req-1', revision: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(persistCalls, 2);
  assert.equal(sent.some((m) => m.type === 'state:persist:ack' && m.requestId === 'req-1' && m.revision === 1), false,
    'the ack must wait for an async persistence to SETTLE first');
  settle();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sent.some((m) => m.type === 'state:persist:ack' && m.requestId === 'req-1' && m.revision === 1),
    'once persistence settles the ack carries the exact requestId and revision');
});

test('private channel rejects a failed persistence and stale or skipped revisions without persisting them', async () => {
  const { createPrivateStateChannel } = await import(built('private-state-channel.js'));
  const sent = [];
  const child = new EventEmitter();
  child.connected = true;
  child.send = (value, callback) => { sent.push(value); callback?.(null); return true; };
  const persistedRevisions = [];
  let failNext = false;
  const channel = createPrivateStateChannel({
    initialState: { keys: [] },
    persist: () => { if (failNext) { failNext = false; throw new Error('simulated write failure'); } persistedRevisions.push(currentRevision); }
  });
  let currentRevision = 0;
  channel.attach(child);
  child.emit('message', { type: 'ready', challenge: 'revision-channel-challenge-1234' });

  const emitPersist = (requestId, revision) => {
    currentRevision = revision;
    child.emit('message', { type: 'state:persist', state: { keys: [] }, requestId, revision });
  };

  emitPersist('r1', 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(persistedRevisions, [1]);
  assert.ok(sent.some((m) => m.type === 'state:persist:ack' && m.requestId === 'r1' && m.revision === 1), 'revision 1 acknowledged');

  // A STALE revision whose projection DIVERGES from what was committed at that
  // revision is rejected and never persisted again. (An IDENTICAL replay is the
  // ack-loss case and is re-acknowledged idempotently — covered separately.)
  currentRevision = 1;
  child.emit('message', {
    type: 'state:persist',
    state: { keys: [{ id: '22222222-2222-4222-8222-222222222222', key: 'divergent-key', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] }] },
    requestId: 'stale-replay',
    revision: 1
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(persistedRevisions, [1], 'a stale revision must not be persisted twice');
  assert.ok(sent.some((m) => m.type === 'state:persist:rejected' && m.requestId === 'stale-replay'), 'a stale divergent revision is rejected');

  // A SKIPPED revision (3 while 2 is expected) is rejected: the successor would
  // otherwise silently overwrite an unpersisted intermediate state.
  emitPersist('skip-3', 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(persistedRevisions, [1], 'a skipped revision must not be persisted');
  assert.ok(sent.some((m) => m.type === 'state:persist:rejected' && m.requestId === 'skip-3'), 'a skipped revision is rejected');

  // The NEXT expected revision still works after the rejections.
  emitPersist('r2', 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(persistedRevisions, [1, 2], 'the sequence continues only with the expected revision');
  assert.ok(sent.some((m) => m.type === 'state:persist:ack' && m.requestId === 'r2' && m.revision === 2));

  // A persistence FAILURE is rejected with the failure surfaced, never acked.
  failNext = true;
  emitPersist('r3', 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(persistedRevisions, [1, 2], 'a failed persistence leaves the revision un-advanced');
  assert.ok(sent.some((m) => m.type === 'state:persist:rejected' && m.requestId === 'r3' && /write failure/.test(String(m.error))), 'the rejection carries the reason');
  assert.equal(sent.some((m) => m.type === 'state:persist:ack' && m.requestId === 'r3'), false, 'a failed persistence is never acknowledged');
});

test('private channel re-acks an identical replay of the committed revision and stamps rejections with the ledger', async () => {
  const { createPrivateStateChannel } = await import(built('private-state-channel.js'));
  const sent = [];
  const child = new EventEmitter();
  child.connected = true;
  child.send = (value, callback) => { sent.push(value); callback?.(null); return true; };
  const persistedStates = [];
  const channel = createPrivateStateChannel({ initialState: { keys: [] }, persist: (state) => { persistedStates.push(structuredClone(state)); } });
  channel.attach(child);
  child.emit('message', { type: 'ready', challenge: 'replay-channel-challenge-12345678' });

  const revOneState = { keys: [{ id: '11111111-1111-4111-8111-111111111111', key: 'replay-key', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] }] };
  child.emit('message', { type: 'state:persist', state: revOneState, requestId: 'rev1', revision: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(persistedStates.length, 1);
  assert.ok(sent.some((m) => m.type === 'state:persist:ack' && m.requestId === 'rev1'));

  // The SAME durable revision replayed with the SAME projection (ack was lost
  // in transit): idempotent re-ack, NO second disk write.
  child.emit('message', { type: 'state:persist', state: revOneState, requestId: 'rev1-replay', revision: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(persistedStates.length, 1, 'an identical replayed revision must not be persisted twice');
  assert.ok(sent.some((m) => m.type === 'state:persist:ack' && m.requestId === 'rev1-replay'), 'an identical replayed revision is re-acknowledged');

  // A DIFFERENT projection at the already-committed revision is a genuine
  // divergence: reject AND tell the child the ledger position so it can heal.
  const divergent = { keys: [] };
  child.emit('message', { type: 'state:persist', state: divergent, requestId: 'rev1-divergent', revision: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const rejection = sent.find((m) => m.type === 'state:persist:rejected' && m.requestId === 'rev1-divergent');
  assert.ok(rejection, 'a divergent stale revision is still rejected');
  assert.equal(rejection.lastPersistedRevision, 1, 'the rejection carries the ledger so the child can fast-forward');
  assert.equal(persistedStates.length, 1, 'the divergent projection is never persisted');
});

test('a legacy persist refreshes the recorded projection, so an idempotent re-ack only fires against disk truth', async () => {
  const { createPrivateStateChannel } = await import(built('private-state-channel.js'));
  const sent = [];
  const child = new EventEmitter();
  child.connected = true;
  child.send = (value, callback) => { sent.push(value); callback?.(null); return true; };
  const written = [];
  const channel = createPrivateStateChannel({
    initialState: { keys: [] },
    persist: (state) => { written.push(structuredClone(state)); }
  });
  channel.attach(child);
  child.emit('message', { type: 'ready', challenge: 'projection-refresh-challenge-1234' });

  // (1) Durable revision 1 commits P1.
  const p1 = { keys: [{ id: '11111111-1111-4111-8111-111111111111', key: 'p1-key', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] }] };
  child.emit('message', { type: 'state:persist', state: p1, requestId: 'd1', revision: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sent.some((m) => m.type === 'state:persist:ack' && m.requestId === 'd1'));

  // (2) A legacy fire-and-forget save LANDS P0 on disk (the ack for P1 was lost
  // and the child rolled back). The recorded projection MUST follow the disk.
  const p0 = { keys: [] };
  child.emit('message', { type: 'state:persist', state: p0 });
  await new Promise((resolve) => setImmediate(resolve));

  // (3) Replaying revision 1 with P1 is now a DIVERGENT stale revision — disk
  // truth is P0 — so it must be rejected with the ledger, NOT re-acked.
  child.emit('message', { type: 'state:persist', state: p1, requestId: 'replay-after-legacy', revision: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const rejection = sent.find((m) => m.type === 'state:persist:rejected' && m.requestId === 'replay-after-legacy');
  assert.ok(rejection, 'a replay that no longer matches the on-disk projection must be rejected');
  assert.equal(rejection.lastPersistedRevision, 1);
  assert.equal(sent.some((m) => m.type === 'state:persist:ack' && m.requestId === 'replay-after-legacy'), false, 'no false idempotent ack against stale projection memory');

  // (4) Sanity: replaying the projection that MATCHES the refreshed record
  // still gets the idempotent re-ack (the ack-loss fast path survives).
  child.emit('message', { type: 'state:persist', state: p0, requestId: 'replay-matching-legacy', revision: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(written.length, 2, 'both real writes happened; neither replay wrote again');
  assert.ok(sent.some((m) => m.type === 'state:persist:ack' && m.requestId === 'replay-matching-legacy'), 'an identical replay of the disk-true projection is still idempotently acked');
});

test('a persist-WRITE failure is classified PERSIST_WRITE_FAILED so the child treats it as possibly-committed', async () => {
  const { createPrivateStateChannel } = await import(built('private-state-channel.js'));
  const sent = [];
  const child = new EventEmitter();
  child.connected = true;
  child.send = (value, callback) => { sent.push(value); callback?.(null); return true; };
  const channel = createPrivateStateChannel({
    initialState: { keys: [] },
    persist: () => { throw new Error('disk write blew up midway'); }
  });
  channel.attach(child);
  child.emit('message', { type: 'ready', challenge: 'write-failure-classification-12' });
  child.emit('message', { type: 'state:persist', state: { keys: [] }, requestId: 'w1', revision: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const rejection = sent.find((m) => m.type === 'state:persist:rejected' && m.requestId === 'w1');
  assert.ok(rejection, 'a write failure rejects the durable mutation');
  assert.equal(rejection.code, 'PERSIST_WRITE_FAILED',
    'write-originated rejections must be distinguishable from pre-persist rejections (wrong revision / migration)');
  assert.equal(rejection.lastPersistedRevision, 0, 'ledger unchanged — but the child still reconciles because the WRITE may be partial');
});

test('an fs-level error code on a write failure (EBUSY/EPERM/ENOSPC) is reclassified PERSIST_WRITE_FAILED', async () => {
  // Finding: an fs throw from mid-write carries its OWN .code — forwarding it
  // verbatim would make the child treat a possibly-committed write as a proven
  // pre-persist rejection. The channel must apply an allowlist: ONLY codes that
  // provably originate before any write (MIGRATION_IN_PROGRESS) survive as-is.
  const { createPrivateStateChannel } = await import(built('private-state-channel.js'));
  for (const fsCode of ['EBUSY', 'EPERM', 'ENOSPC', 'ENOENT', 'EIO']) {
    const sent = [];
    const child = new EventEmitter();
    child.connected = true;
    child.send = (value, callback) => { sent.push(value); callback?.(null); return true; };
    const channel = createPrivateStateChannel({
      initialState: { keys: [] },
      persist: () => { throw Object.assign(new Error('io burst'), { code: fsCode }); }
    });
    channel.attach(child);
    child.emit('message', { type: 'ready', challenge: 'fs-code-challenge-' + fsCode + '-123456' });
    child.emit('message', { type: 'state:persist', state: { keys: [] }, requestId: 'fs1', revision: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    const rejection = sent.find((m) => m.type === 'state:persist:rejected' && m.requestId === 'fs1');
    assert.ok(rejection, `${fsCode}: a write failure still rejects`);
    assert.equal(rejection.code, 'PERSIST_WRITE_FAILED',
      `${fsCode}: an fs-level code MUST NOT survive as a pre-persist classification`);
  }
});

test('durable persists during the migration window are rejected with a retry-later code and never touch the ledger', async () => {
  const { createPrivateStateChannel } = await import(built('private-state-channel.js'));
  const sent = [];
  const child = new EventEmitter();
  child.connected = true;
  child.send = (value, callback) => { sent.push(value); callback?.(null); return true; };
  let migrationOpen = true;
  const persisted = [];
  // Model the main-process behavior contract: a DURABLE persist during the
  // migration window answers the in-memory merge buffer — an ack there would be
  // a lie, so it must throw with a retry-later code instead.
  const persist = (state, context) => {
    if (migrationOpen && context?.durable === true) {
      const error = new Error('Migration in progress; durable key mutations are temporarily unavailable.');
      error.code = 'MIGRATION_IN_PROGRESS';
      throw error;
    }
    persisted.push({ state, context });
  };
  const channel = createPrivateStateChannel({ initialState: { keys: [] }, persist });
  channel.attach(child);
  child.emit('message', { type: 'ready', challenge: 'migration-window-challenge-12345' });

  // Channel must hand the durability context to the persistence callback.
  child.emit('message', { type: 'state:persist', state: { keys: [] }, requestId: 'd1', revision: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const rejection = sent.find((m) => m.type === 'state:persist:rejected' && m.requestId === 'd1');
  assert.ok(rejection, 'a durable persist during migration must be rejected, not acked');
  assert.equal(rejection.code, 'MIGRATION_IN_PROGRESS', 'the rejection carries the retry-later code');
  assert.equal(rejection.lastPersistedRevision, 0, 'a rejected migration-window revision must not advance the ledger');
  assert.equal(persisted.length, 0, 'nothing is persisted while the migration window is open');

  // Ledger-safe: once the window closes, THE SAME revision is legal again.
  migrationOpen = false;
  child.emit('message', { type: 'state:persist', state: { keys: [] }, requestId: 'd1-retry', revision: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sent.some((m) => m.type === 'state:persist:ack' && m.requestId === 'd1-retry' && m.revision === 1), 'same revision accepted after the window closed');
  assert.deepEqual(persisted.map((p) => p.context), [{ durable: true }], 'the durable context flag reaches the persistence callback');
});

test('main wires durable-aware persistence: migration window guard and a serialized persist chain', async () => {
  // Source-level guard for main/index.ts contracts that are impractical to
  // unit-test through the module (it boots Electron at import).
  const source = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  assert.match(source, /MIGRATION_IN_PROGRESS/, 'durable persists during a migration must be rejected with a retry-later code');
  assert.match(source, /pendingPersistChain|persistChain/, 'persists must be serialized through a promise chain so async persistence cannot reorder');
  assert.match(source, /persistChain = task\.(then|catch)/, 'the chain must absorb failures and keep serializing');
});

test('the replace-primary/replace-recovery seam heals via the child reconcile: disk returns to the pre-mutation state', async () => {
  const { createPrivateStateChannel } = await import(built('private-state-channel.js'));
  const { SecureStore, decodeEncryptedState } = await import(built('secure-state.js'));
  const adapter = { encrypt: (v) => Buffer.from(v).reverse(), decrypt: (v) => Buffer.from(v).reverse() };
  const dir = temporaryDirectory('nvgw-seam-');
  const statePath = path.join(dir, 'keys.json');
  const prior = { keys: [{ id: '11111111-1111-4111-8111-111111111111', key: 'seam-original', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] }] };
  const store = new SecureStore(statePath, adapter, () => {});
  store.persist(prior);

  // Fail ONCE exactly at the seam: primary has already been replaced with the
  // new state, recovery has not. persist() throws toward the channel.
  let tripWire = true;
  const hookStore = new SecureStore(statePath, adapter, () => {}, {
    boundary: (name) => { if (tripWire && name === 'replace-recovery') { tripWire = false; throw new Error('replace-recovery'); } }
  });

  const sent = [];
  const child = new EventEmitter();
  child.connected = true;
  child.send = (value, callback) => { sent.push(value); callback?.(null); return true; };
  const channel = createPrivateStateChannel({
    initialState: { keys: [] },
    persist: (state) => { hookStore.persist(state); }
  });
  channel.attach(child);
  child.emit('message', { type: 'ready', challenge: 'seam-partial-commit-challenge-1' });

  const next = { keys: [] };
  child.emit('message', { type: 'state:persist', state: next, requestId: 's1', revision: 1 });
  await new Promise((resolve) => setImmediate(resolve));

  const rejection = sent.find((m) => m.type === 'state:persist:rejected' && m.requestId === 's1');
  assert.ok(rejection, 'the mid-seam failure rejects the revision');
  assert.equal(rejection.code, 'PERSIST_WRITE_FAILED', 'the seam failure is classified as possibly-committed');
  assert.equal(decodeEncryptedState(fs.readFileSync(statePath), adapter).keys.length, 0,
    'PARTIAL COMMIT: primary already holds the rejected projection (the seam is real)');

  // The child side (rotation.mjs) reconciles by pushing its rolled-back state
  // through the legacy path. Emulate exactly that message here.
  child.emit('message', { type: 'state:persist', state: prior });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(decodeEncryptedState(fs.readFileSync(statePath), adapter).keys.length, 1,
    'after the reconcile, primary again holds the pre-mutation state (disk == memory)');
  assert.equal(decodeEncryptedState(fs.readFileSync(`${statePath}.encrypted.bak`), adapter).keys.length, 1,
    'recovery is consistent too');
});

test('spawn options contain no state path or explicit gateway credential in argv or environment', async () => {
  const runtime = await import(built('gateway-runtime.js'));
  const dir = temporaryDirectory('nvgw-runtime-');
  const paths = runtime.ensureGatewayRuntime(dir);
  const options = runtime.createGatewaySpawnOptions('C:\\app\\server.mjs', paths, 12000);
  const text = JSON.stringify(options);
  assert.equal(text.includes('nvidia-local-key'), false);
  assert.equal(text.includes(paths.statePath), false);
  assert.equal('GATEWAY_STATE_PATH' in options.env, false);
  assert.equal('GATEWAY_LOCAL_TOKEN' in options.env, false);
  assert.equal('GATEWAY_ADMIN_TOKEN' in options.env, false);
  assert.deepEqual(options.args, ['C:\\app\\server.mjs']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('IPC validation requires exact main webContents and validates all admin arguments', async () => {
  const { validateIpcSender, validators } = await import(built('ipc-security.js'));
  const contents = {};
  const frame = { url: 'file:///app/index.html', parent: null };
  assert.doesNotThrow(() => validateIpcSender({ sender: contents, senderFrame: frame }, contents, [frame.url]));
  assert.doesNotThrow(() => validateIpcSender({ sender: contents, senderFrame: { url: `${frame.url}#/wizard`, parent: null } }, contents, [frame.url]));
  assert.throws(() => validateIpcSender({ sender: contents, senderFrame: { url: `${frame.url}?route=wizard`, parent: null } }, contents, [frame.url]), /origin/);
  assert.throws(() => validateIpcSender({ sender: contents, senderFrame: { url: 'file:///app/other.html#/wizard', parent: null } }, contents, [frame.url]), /origin/);
  assert.throws(() => validateIpcSender({ sender: {}, senderFrame: frame }, contents, [frame.url]), /webContents/);
  assert.doesNotThrow(() => validators.key('nvapi-test'));
  assert.throws(() => validators.key('bad key'), /key/);
  assert.doesNotThrow(() => validators.uuid('550e8400-e29b-41d4-a716-446655440000'));
  assert.throws(() => validators.status('root'), /status/);
  assert.throws(() => validators.reorder(['550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000']), /reorder/);
});

test('CSP helper removes inline styles and denies permissions, popups and navigation', async () => {
  const security = await import(built('electron-security.js'));
  assert.equal(security.PRODUCTION_CSP.includes("'unsafe-inline'"), false);
  assert.match(security.PRODUCTION_CSP, /style-src 'self'/);
  const events = [];
  const contents = { setWindowOpenHandler: (fn) => events.push(fn()), on: (_name, fn) => { const event = { preventDefault: () => events.push('blocked') }; fn(event, 'https://evil.test'); } };
  security.secureWebContents(contents, 'file:///app/index.html');
  assert.deepEqual(events, [{ action: 'deny' }, 'blocked']);
});

test('production Electron installer registers headers, permission denial and exact packaged URL policy', async () => {
  const security = await import(built('electron-security.js'));
  let headersListener; let permissionHandler; let popupHandler; let navigateHandler;
  const targetSession = {
    webRequest: { onHeadersReceived: (fn) => { headersListener = fn; } },
    setPermissionRequestHandler: (fn) => { permissionHandler = fn; }
  };
  const contents = {
    setWindowOpenHandler: (fn) => { popupHandler = fn; },
    on: (name, fn) => { if (name === 'will-navigate') navigateHandler = fn; }
  };
  security.installElectronSecurity({ targetSession, contents, exactUrl: 'file:///C:/app/renderer/index.html' });
  let denied; permissionHandler({}, 'camera', (value) => { denied = value; });
  assert.equal(denied, false);
  assert.deepEqual(popupHandler(), { action: 'deny' });
  let blocked = false; navigateHandler({ preventDefault: () => { blocked = true; } }, 'file:///C:/app/renderer/other.html');
  assert.equal(blocked, true);
  blocked = false; navigateHandler({ preventDefault: () => { blocked = true; } }, 'file:///C:/app/renderer/index.html');
  assert.equal(blocked, false);
  let response; headersListener({ responseHeaders: { 'X-Test': ['kept'] } }, (value) => { response = value; });
  assert.deepEqual(response.responseHeaders['X-Test'], ['kept']);
  assert.equal(response.responseHeaders['Content-Security-Policy'][0].includes("'unsafe-inline'"), false);
});

test('Windows ACL production hook uses injected SID/executor and directory inheritance rules', async () => {
  const acl = await import(built('windows-acl.js'));
  const calls = [];
  const protect = acl.createWindowsAclProtector({ sid: '*S-1-5-21-42', platform: 'win32', execute: (command, args) => { calls.push({ command, args }); return { status: 0 }; } });
  protect('C:\\runtime', true); protect('C:\\runtime\\keys.json', false);
  assert.equal(calls[0].command, 'icacls.exe');
  assert.ok(calls[0].args.includes('*S-1-5-21-42:(OI)(CI)(F)'));
  assert.ok(calls[1].args.includes('*S-1-5-21-42:(F)'));
  // Phase 4 (2026-08-16): protector now NEVER throws across the bridge to main —
  // it does a bounded retry then logs + degrades (file is already mode 0o600 from
  // the open() that precedes protectFile; ACL is additional hardening only).
  const degradedCalls = [];
  const originalWarn = console.warn;
  console.warn = (msg) => degradedCalls.push(String(msg));
  try {
    assert.doesNotThrow(() =>
      acl.createWindowsAclProtector({ sid: '*S-1-5-21-42', platform: 'win32', execute: () => ({ status: 5 }) })('C:\\runtime', true)
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    degradedCalls.some((line) => line.includes('ACL protectFile degraded')),
    'expected a degrade warning to be emitted instead of throwing on non-zero icacls status'
  );
});

test('runtime protects directories with inheritance and precreates every primary log before child startup', async () => {
  const runtime = await import(built('gateway-runtime.js'));
  const dir = temporaryDirectory('nvgw-acl-runtime-');
  const calls = [];
  const paths = runtime.ensureGatewayRuntime(dir, {
    protectDirectory: (value) => calls.push(['directory', path.resolve(value)]),
    protectFile: (value) => calls.push(['file', path.resolve(value)])
  });
  assert.deepEqual(calls.slice(0, 2), [['directory', path.resolve(dir)], ['directory', path.resolve(dir, 'logs')]]);
  for (const file of [paths.configPath, paths.logPath, paths.appLogPath, paths.stdioLogPath]) {
    assert.equal(fs.existsSync(file), true, file);
    assert.ok(calls.some(([kind, value]) => kind === 'file' && value === path.resolve(file)), file);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// RESTORED GENERAL CASE. This fixture carries NO modelLimits, so it is the
// general shape every existing user has: an ordinary config that startup must
// not rewrite. It was narrowed (renamed to "already-current" with a hardcoded
// modelLimits block) when ensureKnownModelLimits was added, which silently
// dropped the only coverage that a startup touching config.json is caught at
// all. Restored: the user's own keys and values must survive verbatim, the only
// permitted delta is the deliberate additive migration, and a SECOND run must be
// byte-for-byte identical (idempotent) — so a startup that reformats, reorders or
// drops user values fails here.
test('normal runtime initialization preserves an existing app config and migrates additively', async () => {
  const runtime = await import(built('gateway-runtime.js'));
  const dir = temporaryDirectory('nvgw-inert-runtime-');
  const configPath = path.join(dir, 'config.json');
  const original = '{\n  "gatewayPort": 12000,\n  "setupComplete": true,\n  "custom": "preserve"\n}\n';
  fs.writeFileSync(configPath, original);

  runtime.ensureGatewayRuntime(dir);
  const after = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(after);

  // Every user key survives with its exact value; nothing is dropped or reordered
  // away. (Key ORDER is asserted too: the migration spreads the parsed object.)
  assert.deepEqual(Object.keys(parsed), ['gatewayPort', 'setupComplete', 'custom', 'modelLimits']);
  assert.equal(parsed.gatewayPort, 12000);
  assert.equal(parsed.setupComplete, true);
  assert.equal(parsed.custom, 'preserve');
  // The only delta is the one additive entry, with the builtin limit.
  assert.deepEqual(parsed.modelLimits, {
    'deepseek-ai/deepseek-v4.1-flash': { context: 1048576, output: 1048576 }
  });

  // IDEMPOTENT: a config that already carries the entry is byte-for-byte unchanged.
  runtime.ensureGatewayRuntime(dir);
  assert.equal(fs.readFileSync(configPath, 'utf8'), after,
    'a second startup must not rewrite the config again');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ADDITION (kept from the narrowed version): an already-current config is
// untouched byte-for-byte, including its own formatting. This is the case the
// previous edit left as the ONLY coverage.
test('normal runtime initialization leaves an already-current app config byte-for-byte unchanged', async () => {
  const runtime = await import(built('gateway-runtime.js'));
  const dir = temporaryDirectory('nvgw-current-runtime-');
  const original = '{\n  "gatewayPort": 12000,\n  "setupComplete": true,\n  "custom": "preserve",\n  "modelLimits": {\n    "deepseek-ai/deepseek-v4.1-flash": { "context": 1048576, "output": 1048576 }\n  }\n}\n';
  fs.writeFileSync(path.join(dir, 'config.json'), original);
  runtime.ensureGatewayRuntime(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), original);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A user's exact entry is never changed, even when it differs from the builtin:
// the migration returns early on the presence of the key, not on its value.
test('the known-model-limit migration never overwrites a user-chosen limit', async () => {
  const runtime = await import(built('gateway-runtime.js'));
  const dir = temporaryDirectory('nvgw-user-limits-');
  const original = '{\n  "modelLimits": {\n    "deepseek-ai/deepseek-v4.1-flash": { "context": 1000, "output": 500 }\n  }\n}\n';
  fs.writeFileSync(path.join(dir, 'config.json'), original);
  runtime.ensureGatewayRuntime(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), original,
    'a user-chosen limit must never be replaced by the builtin one');
  fs.rmSync(dir, { recursive: true, force: true });
});

// A malformed config must never be replaced: the migration returns before any
// write, so a temporarily unreadable file is not destroyed at startup.
test('the known-model-limit migration leaves an unparseable config untouched', async () => {
  const runtime = await import(built('gateway-runtime.js'));
  const dir = temporaryDirectory('nvgw-bad-config-');
  const original = '{ "gatewayPort": 12000, ';
  fs.writeFileSync(path.join(dir, 'config.json'), original);
  runtime.ensureGatewayRuntime(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), original,
    'a malformed config must be left exactly as found');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runtime ACL setup fails closed when directory or log protection fails', async () => {
  const runtime = await import(built('gateway-runtime.js'));
  const dir = temporaryDirectory('nvgw-acl-fail-');
  assert.throws(() => runtime.ensureGatewayRuntime(dir, { protectDirectory: () => { throw new Error('directory denied'); }, protectFile: () => {} }), /directory denied/);
  assert.throws(() => runtime.ensureGatewayRuntime(dir, { protectDirectory: () => {}, protectFile: () => { throw new Error('file denied'); } }), /file denied/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('secure store preserves a verified old copy at every injected transaction boundary', async () => {
  const { SecureStore, decodeEncryptedState } = await import(built('secure-state.js'));
  const adapter = { encrypt: (v) => Buffer.from(v).reverse(), decrypt: (v) => Buffer.from(v).reverse() };
  const boundaries = ['write-primary', 'fsync-primary', 'verify-primary', 'write-recovery', 'fsync-recovery', 'verify-recovery', 'replace-primary', 'replace-recovery'];
  for (const boundary of boundaries) {
    const dir = temporaryDirectory(`nvgw-txn-${boundary}-`);
    const statePath = path.join(dir, 'keys.json');
    const initial = new SecureStore(statePath, adapter, () => {});
    initial.persist({ keys: [{ key: 'old-value' }] });
    const failing = new SecureStore(statePath, adapter, () => {}, { boundary: (name) => { if (name === boundary) throw new Error(boundary); } });
    assert.throws(() => failing.persist({ keys: [{ key: 'new-value' }] }), new RegExp(boundary));
    const candidates = [statePath, `${statePath}.encrypted.bak`].filter(fs.existsSync).map((value) => decodeEncryptedState(fs.readFileSync(value), adapter));
    assert.ok(candidates.some((value) => value.keys[0].key === 'old-value'), boundary);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('actual lifecycle spawn boundary excludes secrets and sends state only after child challenge', async () => {
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const runtime = await import(built('gateway-runtime.js'));
  const dir = temporaryDirectory('nvgw-spawn-boundary-');
  const paths = runtime.ensureGatewayRuntime(dir);
  const secret = 'FAKE-SPAWN-SECRET-SENTINEL';
  let sent;
  let child;
  let start;
  let captured;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    sent = [];
    const capturedSpawn = createSpawnCapture();
    child = new EventEmitter();
    child.pid = 42; child.exitCode = null; child.killed = false; child.connected = true;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.send = (value, callback) => { sent.push(value); callback?.(null); };
    child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0, null); return true; };
    const instance = new GatewayLifecycle({ executablePath: 'C:\\Electron\\electron.exe', serverPath: 'C:\\app\\gateway\\server.mjs', runtimePaths: paths,
      initialState: { keys: [{ key: secret }], credentials: { gatewayToken: secret, adminToken: secret } }, startupTimeoutMs: 20, healthPollIntervalMs: 1,
      spawnChild: (command, args, options) => {
        try {
          capturedSpawn.capture({ command, args, options });
          return child;
        } catch (error) {
          capturedSpawn.fail(error);
          throw error;
        }
      } });
    start = instance.start(await freePortPair());
    try {
      captured = await capturedSpawn.wait(start);
      break;
    } catch (error) {
      await start;
      if (attempt === 9 || !String(error.message).includes('lifecycle returned error')) throw error;
    }
  }
  assert.ok(captured, 'spawnChild must be reached after bounded transient port-conflict retries');
  assert.equal(sent.length, 0);
  const serializedBoundary = JSON.stringify(captured);
  assert.equal(serializedBoundary.includes(secret), false);
  assert.deepEqual(captured.options.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
  assert.equal(serializedBoundary.includes(paths.ownerPath), false);
  assert.equal(serializedBoundary.includes(paths.statePath), false);
  child.emit('message', { type: 'ready', challenge: 'valid-child-challenge-123456789' });
  assert.equal(JSON.stringify(sent[0]).includes(secret), true);
  await start;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('source console policy has no renderer console and fixed literal-only remaining console calls', () => {
  const renderer = fs.readdirSync(path.join(root, 'src', 'renderer', 'views')).filter((name) => name.endsWith('.tsx'))
    .map((name) => fs.readFileSync(path.join(root, 'src', 'renderer', 'views', name), 'utf8')).join('\n');
  assert.doesNotMatch(renderer, /console\s*\./);
  const sources = ['src/main/app-logger.ts', 'src/gateway/server.mjs'].map((name) => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
  for (const match of sources.matchAll(/console\.(?:log|error|warn)\(([^\n]+)\)/g)) assert.match(match[1], /^\s*["'][^"']*["']\s*$/);
});

function createSpawnCapture() {
  let settled = false;
  let resolveCapture;
  let rejectCapture;
  const captured = new Promise((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject; });
  let timeout = null;
  const finish = (settler, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    settler(value);
  };
  // finish() must exist before the timer callback is armed, so a spawn that
  // never signals settles through the same guarded path instead of throwing
  // from inside a timer callback.
  timeout = setTimeout(
    () => finish(rejectCapture, new Error('spawnChild did not signal captured arguments within 250ms.')),
    250
  );
  return {
    capture(value) { finish(resolveCapture, value); },
    fail(error) { finish(rejectCapture, error); },
    wait(start) {
      return Promise.race([
        captured,
        start.then(
          (status) => Promise.reject(new Error(`spawnChild did not signal captured arguments: lifecycle returned ${status.state}.`)),
          (error) => Promise.reject(error)
        )
      ]).finally(() => clearTimeout(timeout));
    }
  };
}

test('spawn capture rejects deterministically when lifecycle completes without a callback', async () => {
  const capture = createSpawnCapture();
  await assert.rejects(() => capture.wait(Promise.resolve({ state: 'error' })), /did not signal captured arguments/);
});

function migrationPortFromSource() {
  const source = fs.readFileSync(path.join(root, 'src', 'main', 'final-migration-workflow.ts'), 'utf8');
  const match = source.match(/FINAL_MIGRATION_PORT = (\d+)/);
  assert.ok(match, 'production migration port must be discoverable');
  return Number(match[1]);
}

async function freePortPair() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidates = Array.from({ length: 200 }, (_, offset) => 40000 + ((process.pid * 2 + (attempt * 200 + offset) * 2) % 25000));
    const reservation = await reservePortPair({ candidatePorts: candidates, maxAttempts: candidates.length });
    if ([productionMigrationPort, productionMigrationPort + 1].includes(reservation.port) || [productionMigrationPort, productionMigrationPort + 1].includes(reservation.adminPort)) {
      await reservation.release();
      continue;
    }
    pairReservations.add(reservation);
    return reservation.port;
  }
  throw new Error('No non-migration paired test port is available.');
}

// Legacy lock-file claim retained ONLY as the subject of the pure unit tests
// below (legacy lock-file ownership semantics in the old
// `nvgw-test-port-reservations` directory). The live reservation path above
// uses the shared support/paired-port-allocation.mjs helper; do not call
// claimPair from live test code.
function claimPair(port, fileSystem = fs) {
  const reservations = [port, port + 1].map((candidate) => path.join(reservationDirectory, `port-${candidate}.lock`));
  const acquired = [];
  for (const reservation of reservations) {
    try {
      fileSystem.writeFileSync(reservation, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
      acquired.push(reservation);
    } catch (error) {
      releaseReservation(acquired, fileSystem);
      if (error?.code === 'EEXIST') return null;
      throw error;
    }
  }
  return reservations;
}

function releaseReservation(reservation, fileSystem = fs) {
  for (const file of reservation) fileSystem.rmSync(file, { force: true });
}

test('claimPair preserves an active foreign second-port reservation after partial acquisition fails', () => {
  const port = 64000 + (process.pid % 1000);
  const firstReservation = path.join(reservationDirectory, `port-${port}.lock`);
  const foreignReservation = path.join(reservationDirectory, `port-${port + 1}.lock`);
  const foreignContent = JSON.stringify({ pid: process.pid, owner: 'foreign-test-process' });
  fs.rmSync(firstReservation, { force: true });
  fs.rmSync(foreignReservation, { force: true });
  fs.writeFileSync(foreignReservation, foreignContent, { flag: 'wx' });

  try {
    assert.equal(claimPair(port), null);
    assert.equal(fs.existsSync(firstReservation), false);
    assert.equal(fs.existsSync(foreignReservation), true);
    assert.equal(fs.readFileSync(foreignReservation, 'utf8'), foreignContent);
  } finally {
    fs.rmSync(firstReservation, { force: true });
    fs.rmSync(foreignReservation, { force: true });
  }
});

test('claimPair preserves stale and malformed foreign reservations at either port byte-for-byte', () => {
  const firstReservation = path.join(reservationDirectory, `port-${63000 + (process.pid % 1000)}.lock`);
  const secondReservation = path.join(reservationDirectory, `port-${63001 + (process.pid % 1000)}.lock`);
  const cases = [
    [firstReservation, JSON.stringify({ pid: 999999999, owner: 'foreign-stale-first' })],
    [firstReservation, '{malformed-first'],
    [secondReservation, JSON.stringify({ pid: 999999999, owner: 'foreign-stale-second' })],
    [secondReservation, '{malformed-second']
  ];

  for (const [foreignReservation, foreignContent] of cases) {
    fs.rmSync(firstReservation, { force: true });
    fs.rmSync(secondReservation, { force: true });
    fs.writeFileSync(foreignReservation, foreignContent, { flag: 'wx' });
    try {
      assert.equal(claimPair(63000 + (process.pid % 1000)), null);
      assert.equal(fs.readFileSync(foreignReservation, 'utf8'), foreignContent);
      assert.equal(fs.existsSync(foreignReservation), true);
    } finally {
      fs.rmSync(firstReservation, { force: true });
      fs.rmSync(secondReservation, { force: true });
    }
  }
});

test('claimPair releases its first lock when the second exclusive create fails unexpectedly', () => {
  const port = 62000 + (process.pid % 1000);
  const firstReservation = path.join(reservationDirectory, `port-${port}.lock`);
  const secondReservation = path.join(reservationDirectory, `port-${port + 1}.lock`);
  const injectedFs = {
    writeFileSync(file, data, options) {
      if (file === secondReservation) {
        const error = new Error('injected second-lock failure');
        error.code = 'EACCES';
        throw error;
      }
      return fs.writeFileSync(file, data, options);
    },
    rmSync: (...args) => fs.rmSync(...args)
  };
  fs.rmSync(firstReservation, { force: true });
  fs.rmSync(secondReservation, { force: true });

  try {
    assert.throws(() => claimPair(port, injectedFs), /injected second-lock failure/);
    assert.equal(fs.existsSync(firstReservation), false);
    assert.equal(fs.existsSync(secondReservation), false);
  } finally {
    fs.rmSync(firstReservation, { force: true });
    fs.rmSync(secondReservation, { force: true });
  }
});

test('claimPair cleanup removes only locks acquired by the current attempt', () => {
  const port = 61000 + (process.pid % 1000);
  const firstReservation = path.join(reservationDirectory, `port-${port}.lock`);
  const secondReservation = path.join(reservationDirectory, `port-${port + 1}.lock`);
  const foreignReservation = path.join(reservationDirectory, `port-${port + 2}.lock`);
  const foreignContent = '{foreign-unrelated-reservation';
  fs.rmSync(firstReservation, { force: true });
  fs.rmSync(secondReservation, { force: true });
  fs.rmSync(foreignReservation, { force: true });
  fs.writeFileSync(foreignReservation, foreignContent, { flag: 'wx' });

  try {
    const acquired = claimPair(port);
    assert.deepEqual(acquired, [firstReservation, secondReservation]);
    releaseReservation(acquired);
    assert.equal(fs.existsSync(firstReservation), false);
    assert.equal(fs.existsSync(secondReservation), false);
    assert.equal(fs.readFileSync(foreignReservation, 'utf8'), foreignContent);
  } finally {
    fs.rmSync(firstReservation, { force: true });
    fs.rmSync(secondReservation, { force: true });
    fs.rmSync(foreignReservation, { force: true });
  }
});

test('admin route boundary returns 404/405 before authentication or body reads', async () => {
  process.env.GATEWAY_STATE_PATH = path.join(import.meta.dirname, 'non-live-state.json');
  process.env.GATEWAY_LOG_PATH = adminLogPath();
  const api = await import(`${pathToFileURL(path.join(root, 'src/gateway/admin-api.mjs')).href}?boundary=${Date.now()}`);
  assert.deepEqual(api.classifyAdminRoute('GET', '/admin/keys'), { name: 'keys', params: {} });
  assert.equal(api.classifyAdminRoute('DELETE', '/admin/keys/not-a-uuid')?.name, 'key');
  assert.equal(api.classifyAdminRoute('GET', '/admin/keys/extra/path'), null);
  assert.deepEqual(api.classifyAdminRequest('PUT', '/admin/keys'), { status: 405 });
  assert.deepEqual(api.classifyAdminRequest('POST', '/admin/unknown'), { status: 404 });
});

test('admin route matrix is canonical and exhaustive across methods and malformed paths', async () => {
  process.env.GATEWAY_LOG_PATH = adminLogPath();
  const api = await import(`${pathToFileURL(path.join(root, 'src/gateway/admin-api.mjs')).href}?matrix=${Date.now()}`);
  const valid = [
    ['GET', '/admin/keys'], ['POST', '/admin/keys'], ['POST', '/admin/keys/reorder'],
    ['GET', '/admin/state'], ['POST', '/admin/validate'], ['GET', '/admin/logs'],
    ['DELETE', '/admin/keys/550e8400-e29b-41d4-a716-446655440000'],
    ['PATCH', '/admin/keys/550e8400-e29b-41d4-a716-446655440000']
  ];
  const allowedByPath = new Map();
  for (const [method, pathname] of valid) allowedByPath.set(pathname, new Set([...(allowedByPath.get(pathname) ?? []), method]));
  for (const [method, pathname] of valid) assert.equal(api.classifyAdminRequest(method, pathname).status, 200, `${method} ${pathname}`);
  for (const [, pathname] of valid) for (const wrong of ['GET', 'POST', 'DELETE', 'PATCH', 'PUT', 'OPTIONS'].filter((value) => !allowedByPath.get(pathname).has(value))) {
    assert.equal(api.classifyAdminRequest(wrong, pathname).status, 405, `${wrong} ${pathname}`);
  }
  for (const pathname of ['/admin/unknown', '/admin/keys/', '/admin//keys', '/Admin/keys', '/admin/keys?x=1', '/admin/keys#x', '/admin/keys%2Fbad', '/admin/%E0%A4%A']) {
    assert.equal(api.classifyCanonicalAdminRequest('GET', pathname).status, 404, pathname);
  }
});
