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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
