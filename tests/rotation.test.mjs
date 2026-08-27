import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rot-test-'));
process.env.GATEWAY_LOG_PATH = path.join(tmpDir, 'gateway.jsonl');

const rotation = await import('../src/gateway/rotation.mjs');
const proxyHeaders = await import('../src/gateway/proxy-headers.mjs');
const logger = await import('../src/gateway/logger.mjs');

const {
  initializeState,
  getKeys,
  getNextKey,
  handleKeyError,
  setPersistenceAdapter,
  closeStateWatcher,
  MAX_BACKOFF_MS,
  MAX_KEY_COOLDOWN_429_MS,
  getSoonestActiveCooldownRemainingSeconds
} = rotation;

const {
  capResponseHeaders,
  MAX_RESPONSE_RETRY_AFTER_SECONDS
} = proxyHeaders;

const { closeLogger } = logger;

setPersistenceAdapter(() => {});

test.afterEach(() => {
  closeStateWatcher();
  closeLogger();
});

test.after(() => {
  closeStateWatcher();
  closeLogger();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('handleKeyError caps backoffMs to MAX_BACKOFF_MS', () => {
  const keyId = '11111111-1111-4111-8111-111111111111';
  initializeState({
    keys: [{ id: keyId, key: 'test-key-1', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 } }]
  });

  const now = Date.now();
  handleKeyError(keyId, 429, 'Rate limit exceeded', 2145914);

  const key = getKeys().find(k => k.id === keyId);
  assert.ok(key.backoffUntil > now);
  assert.ok(key.backoffUntil <= now + MAX_BACKOFF_MS + 1000);
});

test('capResponseHeaders caps Retry-After header to max 20 seconds', () => {
  assert.equal(MAX_RESPONSE_RETRY_AFTER_SECONDS, 20);
  assert.deepEqual(
    capResponseHeaders({ 'retry-after': '2145914', 'content-type': 'application/json' }),
    { 'retry-after': '20', 'content-type': 'application/json' }
  );
});
