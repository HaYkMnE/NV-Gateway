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

test('handleKeyError caps backoffMs to MAX_BACKOFF_MS (300,000ms) even with absurd retryAfterSeconds', () => {
  const keyId = '11111111-1111-4111-8111-111111111111';
  initializeState({
    keys: [{ id: keyId, key: 'test-key-1', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 } }]
  });

  const now = Date.now();
  // Pass absurd retryAfterSeconds (2,145,914 seconds)
  handleKeyError(keyId, 429, 'Rate limit exceeded', 2145914);

  const key = getKeys().find(k => k.id === keyId);
  assert.ok(key.backoffUntil > now);
  // Ensure backoffUntil is capped at Date.now() + 300,000 ms (allowing slight timing delta)
  assert.ok(key.backoffUntil <= now + MAX_BACKOFF_MS + 1000);
  assert.ok(key.backoffUntil >= now + MAX_BACKOFF_MS - 5000);
});

test('getNextKey falls back to active key with smallest backoffUntil when ALL active keys are in backoff', () => {
  const id1 = '11111111-1111-4111-8111-111111111111';
  const id2 = '22222222-2222-4222-8222-222222222222';
  const now = Date.now();

  initializeState({
    keys: [
      { id: id1, key: 'key-1', status: 'active', backoffUntil: now + 60000, usage: { lastUsed: 100 } },
      { id: id2, key: 'key-2', status: 'active', backoffUntil: now + 10000, usage: { lastUsed: 200 } }
    ]
  });

  // All active keys are in backoff, so getNextKey should select key-2 (expires soonest: +10s vs +60s)
  const selected = getNextKey();
  assert.ok(selected);
  assert.equal(selected.id, id2);
  assert.equal(selected.backoffUntil, 0); // backoffUntil reset to 0
});

test('getNextKey falls back to quota-exceeded key if no active keys exist and cooldown elapsed (> 1 hour)', () => {
  const id1 = '11111111-1111-4111-8111-111111111111';
  const twoHoursAgo = Date.now() - 7200000;

  initializeState({
    keys: [
      { id: id1, key: 'key-1', status: 'quota-exceeded', backoffUntil: 0, usage: { lastUsed: twoHoursAgo } }
    ]
  });

  const selected = getNextKey();
  assert.ok(selected);
  assert.equal(selected.id, id1);
  assert.equal(selected.status, 'active');
  assert.equal(selected.backoffUntil, 0);
});

test('capResponseHeaders caps Retry-After header to max 20 seconds', () => {
  assert.equal(MAX_RESPONSE_RETRY_AFTER_SECONDS, 20);

  assert.deepEqual(
    capResponseHeaders({ 'retry-after': '2145914', 'content-type': 'application/json' }),
    { 'retry-after': '20', 'content-type': 'application/json' }
  );

  assert.deepEqual(
    capResponseHeaders({ 'Retry-After': '3600' }),
    { 'Retry-After': '20' }
  );

  assert.deepEqual(
    capResponseHeaders({ 'retry-after': '10' }),
    { 'retry-after': '10' }
  );
});

test('getSoonestActiveCooldownRemainingSeconds returns <=20s and matches earliest active key cooldown', () => {
  // 1. No keys initialized -> returns 20
  initializeState({ keys: [] });
  assert.equal(getSoonestActiveCooldownRemainingSeconds(), 20);

  // 2. No active keys -> returns 20
  initializeState({
    keys: [
      { id: '11111111-1111-4111-8111-111111111111', key: 'k1', status: 'disabled', backoffUntil: Date.now() + 5000 },
      { id: '22222222-2222-4222-8222-222222222222', key: 'k2', status: 'quota-exceeded', backoffUntil: Date.now() + 5000 }
    ]
  });
  assert.equal(getSoonestActiveCooldownRemainingSeconds(), 20);

  // 3. Active keys exist with no backoff -> returns 1
  initializeState({
    keys: [
      { id: '11111111-1111-4111-8111-111111111111', key: 'k1', status: 'active', backoffUntil: 0 },
      { id: '22222222-2222-4222-8222-222222222222', key: 'k2', status: 'active', backoffUntil: 0 }
    ]
  });
  assert.equal(getSoonestActiveCooldownRemainingSeconds(), 1);

  // 4. Active keys in backoff -> returns ceil((minBackoff - now) / 1000), capped <= 20
  const now = Date.now();
  initializeState({
    keys: [
      { id: '11111111-1111-4111-8111-111111111111', key: 'k1', status: 'active', backoffUntil: now + 8000 },
      { id: '22222222-2222-4222-8222-222222222222', key: 'k2', status: 'active', backoffUntil: now + 15000 },
      // Disabled key with smaller backoff must NOT be picked
      { id: '33333333-3333-4333-8333-333333333333', key: 'k3', status: 'disabled', backoffUntil: now + 2000 }
    ]
  });
  const remaining = getSoonestActiveCooldownRemainingSeconds();
  assert.ok(remaining >= 7 && remaining <= 9, `expected ~8s, got ${remaining}s`);
  assert.ok(remaining <= 20, 'must be <= 20s');

  // 5. Active keys with large backoff (e.g. 50s) -> clamped to 20
  initializeState({
    keys: [
      { id: '11111111-1111-4111-8111-111111111111', key: 'k1', status: 'active', backoffUntil: now + 50000 }
    ]
  });
  assert.equal(getSoonestActiveCooldownRemainingSeconds(), 20);
});

test('handleKeyError 429 (no Retry-After) places a <=20s cooldown mark, not the old 60s', () => {
  const id = '33333333-3333-4333-8333-333333333333';
  const before = Date.now();
  initializeState({
    keys: [{ id, key: 'key-x', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 } }]
  });

  // Bug being fixed: the fallback cooldown for a 429 without Retry-After was
  // 60s. It must now be MAX_KEY_COOLDOWN_429_MS (<=20s).
  assert.equal(MAX_KEY_COOLDOWN_429_MS, 20000);
  handleKeyError(id, 429, 'rate limit exceeded (no retry-after header)', null);

  const key = getKeys().find((k) => k.id === id);
  assert.ok(key.backoffUntil > before, 'a cooldown mark must be set');
  // ~20s, and never above the 20s ceiling (plus a small timing delta).
  assert.ok(key.backoffUntil >= before + 19000,
    `cooldown should be ~20s (>=19s), got backoff in ${key.backoffUntil - before}ms`);
  assert.ok(key.backoffUntil <= before + 20000 + 1000,
    `cooldown must not exceed 20s, got backoff in ${key.backoffUntil - before}ms`);
  // Hard guarantee: strictly below the old 60s value.
  assert.ok(key.backoffUntil < before + 60000, 'cooldown must be far below the old 60s');
});

test('getNextKey SKIPS keys in cooldown and returns the next eligible key immediately (no waiting)', () => {
  const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const idC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const now = Date.now();
  // key A just got a 429 -> 60s cooldown MARK (skipped), keys B and C are
  // immediately available. A has the smallest lastUsed — proving the skip is
  // by cooldown, not by LRU ordering.
  initializeState({
    keys: [
      { id: idA, key: 'key-A', status: 'active', backoffUntil: now + 60000, usage: { lastUsed: 1 } },
      { id: idB, key: 'key-B', status: 'active', backoffUntil: 0, usage: { lastUsed: 2 } },
      { id: idC, key: 'key-C', status: 'active', backoffUntil: 0, usage: { lastUsed: 3 } }
    ]
  });

  const t0 = Date.now();
  const selected = getNextKey();
  const elapsed = Date.now() - t0;

  // Returned synchronously — it must NOT wait for A's 60s cooldown to expire.
  assert.ok(elapsed < 10, `getNextKey must return immediately, waited ${elapsed}ms`);
  assert.ok(selected, 'a key must be returned');
  assert.notEqual(selected.id, idA, 'a key in cooldown must be skipped, never returned');
  // LRU among the eligible (B has the smallest lastUsed of the eligible set).
  assert.equal(selected.id, idB, 'B is the least-recently-used ELIGIBLE key');
  // A keeps its cooldown mark untouched — we did not reset it just to skip it.
  assert.ok(getKeys().find((k) => k.id === idA).backoffUntil > now,
    'A must keep its cooldown mark (skipped, not reset)');
});

test('Retry-After is respected as a MARK on the key, NOT a blocking wait in the failover loop', () => {
  const idA = '11111111-1111-4111-8111-111111111111';
  const idB = '22222222-2222-4222-8222-222222222222';
  const before = Date.now();
  // A gets a 429 with Retry-After=30s -> a ~30s cooldown MARK on A. The
  // failover loop must NOT block for 30s: getNextKey skips A (backoffUntil >
  // now) and returns B immediately.
  initializeState({
    keys: [
      { id: idA, key: 'key-A', status: 'active', backoffUntil: 0, usage: { lastUsed: 1 } },
      { id: idB, key: 'key-B', status: 'active', backoffUntil: 0, usage: { lastUsed: 2 } }
    ]
  });

  handleKeyError(idA, 429, 'rate limit', 30); // Retry-After=30s -> 30s cooldown mark

  const keyA = getKeys().find((k) => k.id === idA);
  // A holds the FULL Retry-After as a cooldown mark (key stays parked for its
  // full Retry-After, as the contract says).
  assert.ok(keyA.backoffUntil >= before + 29000, 'A cooldown ~30s (Retry-After respected)');
  assert.ok(keyA.backoffUntil <= before + 30000 + 1000, 'A cooldown capped at Retry-After');

  // ...but moving to the next key is NOT blocked by that mark:
  const t0 = Date.now();
  const next = getNextKey();
  assert.ok(Date.now() - t0 < 10, 'getNextKey must NOT block on the Retry-After cooldown mark');
  assert.ok(next);
  assert.equal(next.id, idB, 'B (eligible, not in cooldown) is returned immediately');
  assert.notEqual(next.id, idA, 'A (in Retry-After cooldown) is skipped, not waited on');
});
