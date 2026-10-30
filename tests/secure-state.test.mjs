import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;

function createDummyAdapter() {
  return {
    encrypt: (value) => Buffer.from(value).reverse(),
    decrypt: (value) => Buffer.from(value).reverse()
  };
}

test('primary keys.json corruption recovers state from keys.json.encrypted.bak', async () => {
  const { SecureStore } = await import(built('secure-state.js'));
  const adapter = createDummyAdapter();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-test-secstore-1-'));
  const statePath = path.join(dir, 'keys.json');

  try {
    const store = new SecureStore(statePath, adapter);
    const originalState = { keys: [{ id: 'k1', secret: 'val1' }] };
    store.persist(originalState);

    assert.equal(fs.existsSync(statePath), true);
    assert.equal(fs.existsSync(store.recoveryPath), true);

    // Corrupt primary file
    fs.writeFileSync(statePath, Buffer.from('CORRUPTED_BYTES_NO_MAGIC_OR_JSON'));

    // Initialize should recover from recoveryPath
    const recovered = store.initialize();
    assert.deepEqual(recovered, originalState);

    // Ensure statePath was repaired
    const reloadedStore = new SecureStore(statePath, adapter);
    assert.deepEqual(reloadedStore.initialize(), originalState);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('both primary and recovery corruption recovers state from latest timestamped .bak', async () => {
  const { SecureStore } = await import(built('secure-state.js'));
  const adapter = createDummyAdapter();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-test-secstore-2-'));
  const statePath = path.join(dir, 'keys.json');

  try {
    const store = new SecureStore(statePath, adapter);

    // Write initial state & versioned backup 1
    const v1State = { keys: [{ id: 'k1', secret: 'old' }] };
    store.persist(v1State);
    store.createVersionedBackup('pre-update');

    // Wait slightly for timestamp differentiation
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Write updated state & versioned backup 2
    const v2State = { keys: [{ id: 'k1', secret: 'new' }, { id: 'k2', secret: 'extra' }] };
    store.persist(v2State);
    store.createVersionedBackup('pre-update');

    // Corrupt both primary keys.json and recovery keys.json.encrypted.bak
    fs.writeFileSync(statePath, Buffer.from('INVALID_PRIMARY'));
    fs.writeFileSync(store.recoveryPath, Buffer.from('INVALID_RECOVERY'));

    // Initialize should fall back to candidate backups and pick newest (v2State)
    const recovered = store.initialize();
    assert.deepEqual(recovered, v2State);

    // Ensure state files were repaired
    assert.deepEqual(store.initialize(), v2State);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing keys.json when keys.json.encrypted.bak exists restores state cleanly', async () => {
  const { SecureStore } = await import(built('secure-state.js'));
  const adapter = createDummyAdapter();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-test-secstore-3-'));
  const statePath = path.join(dir, 'keys.json');

  try {
    const store = new SecureStore(statePath, adapter);
    const stateWithKeys = { keys: [{ id: 'persist-me' }] };
    store.persist(stateWithKeys);

    // Delete primary keys.json
    fs.unlinkSync(statePath);
    assert.equal(fs.existsSync(statePath), false);
    assert.equal(fs.existsSync(store.recoveryPath), true);

    // Initialize should recover from recoveryPath without wiping keys
    const recovered = store.initialize();
    assert.deepEqual(recovered, stateWithKeys);
    assert.equal(fs.existsSync(statePath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('all files corrupted backs up corrupt files to .corrupt.<timestamp>.bak and initializes fresh state', async () => {
  const { SecureStore } = await import(built('secure-state.js'));
  const adapter = createDummyAdapter();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-test-secstore-4-'));
  const statePath = path.join(dir, 'keys.json');

  try {
    const store = new SecureStore(statePath, adapter);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(statePath, Buffer.from('GARBAGE_PRIMARY'));
    fs.writeFileSync(store.recoveryPath, Buffer.from('GARBAGE_RECOVERY'));

    const initialized = store.initialize();
    assert.deepEqual(initialized, { keys: [] });

    // Check that corrupt files were backed up
    const files = fs.readdirSync(dir);
    const corruptFiles = files.filter((f) => f.includes('.corrupt.'));
    assert.equal(corruptFiles.length >= 1, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh install initializes empty state without errors', async () => {
  const { SecureStore } = await import(built('secure-state.js'));
  const adapter = createDummyAdapter();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-test-secstore-5-'));
  const statePath = path.join(dir, 'keys.json');

  try {
    const store = new SecureStore(statePath, adapter);
    const initialized = store.initialize();
    assert.deepEqual(initialized, { keys: [] });
    assert.equal(fs.existsSync(statePath), true);
    assert.equal(fs.existsSync(store.recoveryPath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// MASTER-005: in the Windows replace-fallback branch, the commit rename can
// succeed on disk while the backup unlink then throws EBUSY/EPERM (AV/indexer
// holding a handle). That late throw must NOT masquerade as a commit failure:
// persist() reporting PERSIST_WRITE_FAILED after the new state is already
// durable makes the caller roll back in-memory state that reappears from disk
// on the next restart — memory/disk divergence. The unlink is cleanup, not
// commit, so it must be best-effort, and the orphaned .replace.bak must be
// swept on the next SecureStore startup.
test('windows replace fallback: a blocked backup unlink cannot fail a committed persist', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('the replaceFile fallback branch is windows-only');
    return;
  }
  const { SecureStore, decodeEncryptedState } = await import(built('secure-state.js'));
  const adapter = createDummyAdapter();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-test-secstore-6-'));
  const statePath = path.join(dir, 'keys.json');

  const originalRename = fs.renameSync;
  const originalUnlink = fs.unlinkSync;
  try {
    const store = new SecureStore(statePath, adapter);
    store.persist({ keys: [{ id: 'k1', secret: 'before' }] });
    assert.equal(fs.existsSync(statePath), true);

    // Force the Windows fallback branch: the FIRST rename onto the primary
    // destination fails with EPERM (AV lock on rename-over); every later
    // rename delegates to the real implementation. Independently, EVERY
    // unlink of a .replace.bak backup fails with EBUSY (indexer holding the
    // just-closed handle).
    let failNextPrimaryRename = true;
    fs.renameSync = function (source, destination) {
      if (failNextPrimaryRename && String(destination) === statePath) {
        failNextPrimaryRename = false;
        const error = new Error(`EPERM: operation not permitted, rename '${source}' -> '${destination}'`);
        error.code = 'EPERM';
        throw error;
      }
      return originalRename.call(this, source, destination);
    };
    fs.unlinkSync = function (target) {
      if (String(target).endsWith('.replace.bak')) {
        const error = new Error(`EBUSY: resource busy or locked, unlink '${target}'`);
        error.code = 'EBUSY';
        throw error;
      }
      return originalUnlink.call(this, target);
    };

    const rotatedState = { keys: [{ id: 'k1', secret: 'after' }] };
    assert.doesNotThrow(
      () => store.persist(rotatedState),
      'a blocked backup unlink after a successful commit rename must not surface as PERSIST_WRITE_FAILED'
    );

    // The commit had already landed on disk: the primary must hold the new state.
    assert.deepEqual(decodeEncryptedState(fs.readFileSync(statePath), adapter), rotatedState);
  } finally {
    fs.renameSync = originalRename;
    fs.unlinkSync = originalUnlink;
  }

  // The orphan left behind by the blocked unlink is swept at the next startup.
  assert.equal(fs.readdirSync(dir).some((entry) => entry.endsWith('.replace.bak')), true,
    'test setup error: the blocked unlink should have left an orphaned .replace.bak');
  const reopened = new SecureStore(statePath, adapter);
  assert.deepEqual(reopened.initialize(), { keys: [{ id: 'k1', secret: 'after' }] });
  assert.equal(fs.readdirSync(dir).some((entry) => entry.endsWith('.replace.bak')), false,
    'SecureStore startup must sweep orphaned .replace.bak commit buffers');

  fs.rmSync(dir, { recursive: true, force: true });
});

// CodeRabbit F1: sweepReplaceBackups aged `.replace.bak` buffers by mtime, but
// renameSync PRESERVES the mtime of the file it moves, so a buffer created a
// moment ago from a keys.json last written hours earlier looked "stale" and was
// deleted even when its destination was missing - i.e. when the buffer is the
// ONLY surviving copy of the state (crash between the two renames). A buffer
// whose destination is missing must never be deleted; one whose destination
// exists is residue and is swept, whatever its mtime says.
function replaceBakFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-test-secstore-sweep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'keys.json');
  const backupAt = (fileTimestampMs) => path.join(dir, `keys.json.4242.${fileTimestampMs}.replace.bak`);
  return { dir, statePath, backupAt };
}
const TWO_HOURS_MS = 2 * 3_600_000;

test('sweep: an old .replace.bak whose destination exists is swept', async (t) => {
  const { SecureStore, encodeEncryptedState } = await import(built('secure-state.js'));
  const adapter = createDummyAdapter();
  const { statePath, backupAt } = replaceBakFixture(t);
  new SecureStore(statePath, adapter).persist({ keys: [{ id: 'k1', secret: 'fake-current' }] });
  const oldAt = Date.now() - TWO_HOURS_MS;
  const backup = backupAt(oldAt);
  fs.writeFileSync(backup, encodeEncryptedState({ keys: [{ id: 'k1', secret: 'fake-old' }] }, adapter));
  fs.utimesSync(backup, new Date(oldAt), new Date(oldAt));

  assert.deepEqual(new SecureStore(statePath, adapter).initialize(), { keys: [{ id: 'k1', secret: 'fake-current' }] });
  assert.equal(fs.existsSync(backup), false, 'residue whose commit landed must be swept');
});

test('sweep: an old .replace.bak whose destination is MISSING is kept (it may be the only copy)', async (t) => {
  const { SecureStore, encodeEncryptedState } = await import(built('secure-state.js'));
  const adapter = createDummyAdapter();
  const { statePath, backupAt } = replaceBakFixture(t);
  const oldAt = Date.now() - TWO_HOURS_MS;
  const backup = backupAt(oldAt);
  const onlyCopy = { keys: [{ id: 'k1', secret: 'fake-only-copy' }] };
  fs.writeFileSync(backup, encodeEncryptedState(onlyCopy, adapter));
  fs.utimesSync(backup, new Date(oldAt), new Date(oldAt));
  assert.equal(fs.existsSync(statePath), false, 'test setup: the destination must be missing');

  assert.deepEqual(new SecureStore(statePath, adapter).initialize(), onlyCopy,
    'the state must be recovered from the surviving buffer, not reset to empty');
  assert.equal(fs.existsSync(backup), true, 'a buffer whose destination was missing must never be deleted');
});

test('sweep: a buffer with a recently touched mtime but an old filename timestamp is swept when its destination exists', async (t) => {
  const { SecureStore, encodeEncryptedState } = await import(built('secure-state.js'));
  const adapter = createDummyAdapter();
  const { statePath, backupAt } = replaceBakFixture(t);
  new SecureStore(statePath, adapter).persist({ keys: [{ id: 'k1', secret: 'fake-current' }] });
  const backup = backupAt(Date.now() - TWO_HOURS_MS);
  fs.writeFileSync(backup, encodeEncryptedState({ keys: [{ id: 'k1', secret: 'fake-old' }] }, adapter));
  const now = new Date();
  fs.utimesSync(backup, now, now);

  new SecureStore(statePath, adapter).initialize();
  assert.equal(fs.existsSync(backup), false, 'a fresh mtime must not keep residue alive');
});

test('sweep: a YOUNG buffer (filename timestamp now) with an old preserved mtime is kept when its destination is missing', async (t) => {
  const { SecureStore, encodeEncryptedState } = await import(built('secure-state.js'));
  const adapter = createDummyAdapter();
  const { statePath, backupAt } = replaceBakFixture(t);
  const backup = backupAt(Date.now());
  const onlyCopy = { keys: [{ id: 'k1', secret: 'fake-just-renamed' }] };
  fs.writeFileSync(backup, encodeEncryptedState(onlyCopy, adapter));
  // renameSync keeps the ORIGINAL keys.json mtime, which can be hours old.
  const oldMtime = new Date(Date.now() - TWO_HOURS_MS);
  fs.utimesSync(backup, oldMtime, oldMtime);

  assert.deepEqual(new SecureStore(statePath, adapter).initialize(), onlyCopy,
    'a crash between the two renames must not lose the state');
  assert.equal(fs.existsSync(backup), true, 'an old preserved mtime must not get the only copy deleted');
});

// Audit P3: the sweep ran BEFORE any readability check and deleted a buffer
// whose destination merely EXISTED. With keys.json AND keys.json.encrypted.bak
// both corrupt, the .replace.bak is the only good copy: deleting it reset the
// store to { keys: [] }. A buffer may only go once its destination LOADS.
test('sweep P3: primary and recovery both corrupt, valid .replace.bak -> state recovered, not lost', async (t) => {
  const { SecureStore, encodeEncryptedState } = await import(built('secure-state.js'));
  const adapter = createDummyAdapter();
  const { statePath, backupAt } = replaceBakFixture(t);
  fs.writeFileSync(statePath, 'corrupt-primary{{{');
  fs.writeFileSync(`${statePath}.encrypted.bak`, 'corrupt-recovery{{{');
  const onlyGood = { keys: [{ id: 'k1', secret: 'fake-only-good' }] };
  const backup = backupAt(Date.now() - TWO_HOURS_MS);
  fs.writeFileSync(backup, encodeEncryptedState(onlyGood, adapter));

  assert.deepEqual(new SecureStore(statePath, adapter).initialize(), onlyGood,
    'the only good copy must be recovered, never reset to { keys: [] }');
});

test('sweep: a destination that exists but is corrupt keeps a (corrupt) buffer too', async (t) => {
  const { SecureStore } = await import(built('secure-state.js'));
  const adapter = createDummyAdapter();
  const { statePath, backupAt } = replaceBakFixture(t);
  fs.writeFileSync(statePath, 'corrupt-primary{{{');
  const backup = backupAt(Date.now() - TWO_HOURS_MS);
  fs.writeFileSync(backup, 'corrupt-backup{{{');

  new SecureStore(statePath, adapter).initialize();
  assert.equal(fs.existsSync(backup), true, 'nothing may be deleted while the destination does not load');
});

// ───────────────────────────────────────────────────────────────────────────
// F5: migratePlaintextStateAtomically must write its intermediate files with the
// SAME atomicity as SecureStore.persist — exclusive "wx" at 0o600, fsync, then
// a verified rename. Before the fix it used plain fs.writeFileSync (no exclusive
// create, no mode, no fsync), so a concurrent process could interpose on the
// temporary and a crash before the rename could leave a truncated file.
// ───────────────────────────────────────────────────────────────────────────
test('F5: legacy plaintext migration writes temporaries exclusively at 0o600, fsyncs, then renames', async () => {
  const { migratePlaintextStateAtomically, decodeEncryptedState } = await import(built('secure-state.js'));
  const adapter = createDummyAdapter();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-test-secstore-migrate-'));
  const statePath = path.join(dir, 'keys.json');
  const legacy = { keys: [{ id: 'legacy-1', key: 'nvapi-plaintext-value' }] };
  fs.writeFileSync(statePath, JSON.stringify(legacy));

  const originalOpen = fs.openSync;
  const originalFsync = fs.fsyncSync;
  const opened = [];
  let fsyncCalls = 0;
  fs.openSync = (target, flags, mode) => {
    opened.push({
      name: typeof target === 'string' ? path.basename(target) : String(target),
      flags,
      mode
    });
    return originalOpen.call(fs, target, flags, mode);
  };
  fs.fsyncSync = (descriptor) => { fsyncCalls += 1; return originalFsync.call(fs, descriptor); };
  try {
    migratePlaintextStateAtomically(statePath, adapter);

    // The reads migration performs (source + verification) are 'r' opens and
    // are not part of the atomicity contract; only the WRITE opens are. The
    // temporary names are PER-CALL UNIQUE (pid + Date.now + random), mirroring
    // SecureStore.persist, so only their SHAPE is asserted: one .encrypted.tmp
    // and one .encrypted.bak, both opened "wx" at 0o600.
    const writeOpens = opened.filter((entry) => entry.flags === 'wx');
    assert.equal(writeOpens.length, 2, 'the migration must create exactly the .tmp and .bak intermediates');
    assert.equal(writeOpens.filter((entry) => /\.encrypted\.tmp$/.test(entry.name)).length, 1,
      'exactly one unique .encrypted.tmp must be created');
    assert.equal(writeOpens.filter((entry) => /\.encrypted\.bak$/.test(entry.name)).length, 1,
      'exactly one unique .encrypted.bak must be created');
    for (const entry of writeOpens) {
      assert.equal(entry.flags, 'wx', `${entry.name} must be opened exclusively (wx)`);
      assert.equal(entry.mode, 0o600, `${entry.name} must be created 0o600`);
    }
    assert.equal(fsyncCalls >= 2, true, 'both intermediates must be fsynced');

    // The committed primary and the .bak both decode to the migrated state, and
    // the temporary is gone (it was renamed onto the primary).
    assert.deepEqual(decodeEncryptedState(fs.readFileSync(statePath), adapter), legacy);
    assert.deepEqual(decodeEncryptedState(fs.readFileSync(`${statePath}.encrypted.bak`), adapter), legacy);
    assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.encrypted.tmp')), false, 'no temporary may be left behind');
    // No plaintext may survive on disk.
    assert.equal(fs.readFileSync(statePath).includes(Buffer.from('nvapi-plaintext-value')), false);
  } finally {
    fs.openSync = originalOpen;
    fs.fsyncSync = originalFsync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// DEFECT B: a SECOND migratePlaintextStateAtomically must be SAFE.
//
// MEASURED against the real compiled module before the fix: migration #1 wrote
// `keys.json.encrypted.bak` (fixed name, "wx"), so migration #2 threw
// `EEXIST ... keys.json.encrypted.bak` BEFORE the rename and left the ACTIVE
// path PLAINTEXT (the secret still readable in the clear); migration #3 then
// threw `EEXIST ... keys.json.encrypted.tmp` on the orphan left by #2 — stuck
// forever. The tests below pin the fixed behaviour: a repeat migration succeeds,
// the active path ends ENCRYPTED, and no fixed-name orphan blocks a later run.
// ───────────────────────────────────────────────────────────────────────────────
test('F5: a SECOND migration (plaintext restored + stale .bak) succeeds and leaves the active file ENCRYPTED', async () => {
  const { migratePlaintextStateAtomically, decodeEncryptedState } = await import(built('secure-state.js'));
  const adapter = createDummyAdapter();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-test-secstore-migrate2-'));
  const statePath = path.join(dir, 'keys.json');
  const legacy = { keys: [{ id: 'legacy-1', key: 'nvapi-plaintext-value' }] };
  try {
    // Migration #1 (fresh) — the case the original test covered.
    fs.writeFileSync(statePath, JSON.stringify(legacy));
    migratePlaintextStateAtomically(statePath, adapter);
    assert.equal(fs.existsSync(`${statePath}.encrypted.bak`), true, 'migration #1 must leave a recovery copy');

    // Plaintext is restored at the active path and the STALE .bak from #1 stays.
    fs.writeFileSync(statePath, JSON.stringify(legacy));
    assert.equal(fs.readFileSync(statePath).includes(Buffer.from('nvapi-plaintext-value')), true, 'setup: active must be plaintext');

    assert.doesNotThrow(() => migratePlaintextStateAtomically(statePath, adapter),
      'a repeat migration must not be blocked by the stale recovery copy');

    // THE PROPERTY: the secret must no longer be readable as text at the active path.
    assert.equal(fs.readFileSync(statePath).includes(Buffer.from('nvapi-plaintext-value')), false,
      'the active file must be ENCRYPTED after a repeat migration, not left plaintext');
    assert.deepEqual(decodeEncryptedState(fs.readFileSync(statePath), adapter), legacy);
    assert.deepEqual(decodeEncryptedState(fs.readFileSync(`${statePath}.encrypted.bak`), adapter), legacy);
    assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.encrypted.tmp')), false, 'no orphaned .tmp may remain');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F5: a THIRD migration is still safe (no fixed-name orphan blocks it)', async () => {
  const { migratePlaintextStateAtomically, decodeEncryptedState } = await import(built('secure-state.js'));
  const adapter = createDummyAdapter();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-test-secstore-migrate3-'));
  const statePath = path.join(dir, 'keys.json');
  const legacy = { keys: [{ id: 'legacy-1', key: 'nvapi-plaintext-value' }] };
  try {
    for (let run = 1; run <= 3; run += 1) {
      fs.writeFileSync(statePath, JSON.stringify(legacy));
      assert.doesNotThrow(() => migratePlaintextStateAtomically(statePath, adapter), `migration #${run} must succeed`);
      assert.equal(fs.readFileSync(statePath).includes(Buffer.from('nvapi-plaintext-value')), false,
        `migration #${run}: active must be encrypted`);
    }
    assert.deepEqual(decodeEncryptedState(fs.readFileSync(statePath), adapter), legacy);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


