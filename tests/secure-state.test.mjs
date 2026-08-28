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
