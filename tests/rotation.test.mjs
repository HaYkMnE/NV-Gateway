import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

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
  reclaimDueParkedKeys,
  saveState,
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
  // A gets a 429 with Retry-After=30s -> a ~30s cooldown MARK on A. The
  // failover loop must NOT block for 30s: getNextKey skips A (backoffUntil >
  // now) and returns B immediately.
  initializeState({
    keys: [
      { id: idA, key: 'key-A', status: 'active', backoffUntil: 0, usage: { lastUsed: 1 } },
      { id: idB, key: 'key-B', status: 'active', backoffUntil: 0, usage: { lastUsed: 2 } }
    ]
  });

  // Bracket the call TIGHTLY. The product computes `backoffUntil` from its own
  // Date.now() inside handleKeyError (rotation.mjs), so the only honest window
  // is [just before the call, just after it]. A reference captured earlier
  // would fold UNRELATED setup time into the window and a scheduling stall
  // there would misread the mark as too long — the flake this replaces.
  // Deterministic "did not block" contract (replaces wall-clock `< 10ms`
  // asserts that GC/CI load could break): the call must return a non-thenable
  // AND its effect (the mark) must already be observable in the SAME tick,
  // before this synchronous test body ever yields. An async/awaiting
  // implementation fails one of the two regardless of machine speed.
  const t0 = Date.now();
  const errorResult = handleKeyError(idA, 429, 'rate limit', 30); // Retry-After=30s -> 30s cooldown mark
  const t1 = Date.now();

  const keyA = getKeys().find((k) => k.id === idA);
  // A holds the FULL Retry-After as a cooldown mark (key stays parked for its
  // full Retry-After, as the contract says). `backoffUntil` is stamped between
  // the two samples, so it must land inside [t0+29000, t1+30000]: the mark is
  // ~30s out, never a no-op, and never above the Retry-After ceiling.
  assert.ok(keyA.backoffUntil >= t0 + 29000,
    `A cooldown must be ~30s (Retry-After respected), got ${keyA.backoffUntil - t0}ms`);
  assert.ok(keyA.backoffUntil <= t1 + 30000,
    `A cooldown must be capped at Retry-After, got ${keyA.backoffUntil - t1}ms`);
  // Hard guarantee: strictly below the old 60s value.
  assert.ok(keyA.backoffUntil < t0 + 60000, 'cooldown must be far below the old 60s');
  // ...and the synchronous call itself must NOT have awaited the mark.
  // (the mark asserted above was read in the same tick as the call returned)
  assert.equal(typeof errorResult?.then, 'undefined', 'handleKeyError must record a mark synchronously, not return a Promise');

  // ...but moving to the next key is NOT blocked by that mark: a plain key
  // object is returned in the same tick (no Promise to await), and it is B.
  const next = getNextKey();
  assert.equal(typeof next?.then, 'undefined', 'getNextKey must NOT wait on the Retry-After cooldown mark (returned a Promise)');
  assert.ok(next);
  assert.equal(next.id, idB, 'B (eligible, not in cooldown) is returned immediately');
  assert.notEqual(next.id, idA, 'A (in Retry-After cooldown) is skipped, not waited on');
});

// ─── Durable admin mutations (acknowledged persistence + rollback) ──────────
//
// Contract: admin add/remove/status/reorder are only a success once the MAIN
// process durably persisted the projected state AND acknowledged the exact
// (requestId, revision) pair. Timeout, channel disconnect, a rejected ack and a
// stale/skipped ack are all failures; every failure rolls back the in-memory
// mutation (keys, quotaRetries, and model-key affinity references). Ordinary
// (fire-and-forget) saves must never overtake an in-flight durable mutation.

const affinity = await import('../src/gateway/model-key-affinity.mjs');

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function tick() { return new Promise((resolve) => setImmediate(resolve)); }

const DURABLE_ID_A = 'd1111111-1111-4111-8111-111111111111';
const DURABLE_ID_B = 'd2222222-2222-4222-8222-222222222222';

test('durable admin mutation is acknowledged before success and rolls back on persistence failure', async () => {
  initializeState({
    keys: [{ id: DURABLE_ID_A, key: 'durable-key-1', status: 'active', backoffUntil: 0, usage: { success: 1, fail: 0, tokens: 5, lastUsed: 10 }, accessibleModels: ['m/a'] }]
  });
  affinity.resetAffinityState({ cachePath: null });
  affinity.recordAssignment('model-x', DURABLE_ID_A, { now: 1_000 });
  affinity.markRateLimited('model-x', DURABLE_ID_A, { now: 1_000, cooldownMs: 20_000 });

  const sent = [];
  let gate;
  setPersistenceAdapter((projection, context) => {
    sent.push({ projection: structuredClone(projection), context: { ...context } });
    gate = deferred();
    return gate.promise;
  });
  try {
    const removal = rotation.removeKeyDurably(DURABLE_ID_A);
    await tick();
    assert.equal(sent.length, 1, 'exactly one durable persistence request');
    assert.equal(sent[0].context.durable, true, 'the adapter is told this call needs an ack');
    assert.equal(typeof sent[0].context.requestId, 'string');
    assert.ok(sent[0].context.requestId.length > 0);
    assert.equal(sent[0].context.revision, 1, 'first durable mutation starts the revision counter at 1');
    assert.equal(sent[0].projection.keys.length, 0, 'the persisted projection carries the POST-mutation state');
    assert.equal(getKeys().length, 0, 'the in-memory mutation is applied while awaiting the ack');

    gate.reject(new Error('simulated disk failure'));
    await assert.rejects(removal, (err) => err?.code === 'KEY_PERSISTENCE_FAILED');

    assert.equal(getKeys().length, 1, 'a failed durable mutation rolls back the removed key');
    assert.equal(getKeys()[0].key, 'durable-key-1');
    assert.equal(affinity.getAssignedKeyId('model-x', { now: 2_000 }), DURABLE_ID_A, 'affinity assignment restored on rollback');
    assert.equal(affinity.isRateLimited('model-x', DURABLE_ID_A, { now: 2_000 }), true, 'affinity cooldown restored on rollback');
  } finally {
    setPersistenceAdapter(() => {});
  }
});

test('durable admin mutations are serialized and each persistence request carries its exact resulting state', async () => {
  initializeState({ keys: [] });
  affinity.resetAffinityState({ cachePath: null });

  const sent = [];
  const gates = [];
  setPersistenceAdapter((projection, context) => {
    sent.push({ projection: structuredClone(projection), context: { ...context } });
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  });
  try {
    const addA = rotation.addKeyDurably('serialized-key-A');
    const addB = rotation.addKeyDurably('serialized-key-B');
    await tick();
    await tick();
    assert.equal(sent.length, 1, 'the second mutation must wait for the first durable commit');

    gates[0].resolve();
    const addedA = await addA;
    await tick();
    assert.equal(sent.length, 2, 'the second mutation starts only after the first ack');
    gates[1].resolve();
    const addedB = await addB;

    assert.ok(addedA && addedB && addedA.id !== addedB.id, 'both adds succeed');
    assert.equal(sent[0].context.revision, 1);
    assert.equal(sent[1].context.revision, 2, 'revisions are strictly sequential per mutation');
    assert.equal(sent[0].projection.keys.length, 1, 'the first projection holds only key A');
    assert.deepEqual(sent[1].projection.keys.map((k) => k.key).sort(), ['serialized-key-A', 'serialized-key-B']);
  } finally {
    setPersistenceAdapter(() => {});
  }
});

test('background persistence cannot bypass an in-flight durable admin mutation', async () => {
  initializeState({ keys: [] });
  affinity.resetAffinityState({ cachePath: null });

  const calls = [];
  const gates = [];
  setPersistenceAdapter((projection, context) => {
    calls.push({ projection: structuredClone(projection), durable: context?.durable === true });
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  });
  try {
    const add = rotation.addKeyDurably('queued-key');
    await tick();
    assert.equal(calls.length, 1, 'the durable request is in flight');

    saveState(); // background-style save (usage / accessibleModels) must not overtake
    await tick();
    assert.equal(calls.length, 1, 'a background save must not overtake the pending durable mutation');

    gates[0].resolve();
    await add;
    await tick();
    await tick();
    assert.equal(calls.length, 2, 'the deferred background save lands after the durable commit');
    assert.equal(calls[1].durable, false, 'the replayed save is fire-and-forget, not a second durable request');
    assert.equal(calls[1].projection.keys.length, 1, 'the deferred save carries the newest state');
  } finally {
    setPersistenceAdapter(() => {});
  }
});

test('a rolled-back durable mutation preserves unrelated runtime deltas gathered during the ack window', async () => {
  const now = Date.now();
  initializeState({
    keys: [
      { id: DURABLE_ID_A, key: 'merge-key-a', status: 'active', backoffUntil: 0, usage: { success: 3, fail: 0, tokens: 30, lastUsed: now - 100 }, accessibleModels: [] },
      { id: DURABLE_ID_B, key: 'merge-key-b', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 4, tokens: 10, lastUsed: now - 50 }, accessibleModels: [] }
    ]
  });
  affinity.resetAffinityState({ cachePath: null });

  let gate;
  setPersistenceAdapter(() => { gate = deferred(); return gate.promise; });
  try {
    // Durable status flip of A, parked behind an unresolved ack.
    const mutation = rotation.setKeyStatusDurably(DURABLE_ID_A, 'disabled');
    await tick();
    assert.equal(getKeys().find((k) => k.id === DURABLE_ID_A).status, 'disabled',
      'the mutation IS visible to readers while the ack is pending (documented contract)');

    // Meanwhile the UNTOUCHED key keeps serving traffic, THEN parks itself on a
    // quota verdict — a status flip, a backoff schedule and a retry-ladder step
    // that have nothing to do with the mutation under test. (Order matters: a
    // later success would legitimately clear the ladder again.)
    rotation.markKeyUsedAndDebounceSave(DURABLE_ID_B, { success: true, tokens: 7 });
    handleKeyError(DURABLE_ID_B, 429, 'credit balance exhausted', null);

    gate.reject(new Error('simulated disk failure'));
    await assert.rejects(mutation, (err) => err?.code === 'KEY_PERSISTENCE_FAILED');

    const rolledBackA = getKeys().find((k) => k.id === DURABLE_ID_A);
    assert.equal(rolledBackA.status, 'active', 'the touched key rolls back to its pre-mutation status');
    assert.equal(rolledBackA.usage.success, 3, 'the touched key restores its pre-mutation usage');

    const liveB = getKeys().find((k) => k.id === DURABLE_ID_B);
    assert.equal(liveB.status, 'quota-exceeded', 'an untouched key keeps its live park state, not the snapshot');
    assert.ok(liveB.backoffUntil > now, 'the untouched key keeps the backoff it was given during the window');
    assert.equal(liveB.usage.fail, 5, 'the untouched key keeps usage gathered during the ack window');
    assert.equal(liveB.usage.tokens, 17, '10 + 7 tokens gathered during the window survive');

    // The retry ladder for B must still be escalated: a second quota park lands
    // the SECOND window (~10 min), proof the rollback preserved quotaRetries
    // instead of globally resetting the ladder to the 5-minute base.
    handleKeyError(DURABLE_ID_B, 429, 'credit balance exhausted', null);
    const parkedAgain = getKeys().find((k) => k.id === DURABLE_ID_B);
    assert.ok(parkedAgain.backoffUntil >= Date.now() + 9 * 60_000,
      'the second escalation window proves the retry ladder survived the rollback');
  } finally {
    setPersistenceAdapter(() => {});
  }
});

test('rollback precedence: a touched key restores its pre-mutation status/backoff; racing runtime verdicts on THAT key do not survive', async () => {
  // Decision (documented at mergeRollback): for the key the admin action
  // touched, rollback restores the pre-mutation status/backoff wholesale.
  // Usage counters are observational and merge; status is INTENT — two writers
  // (admin vs runtime verdict) cannot be safely unioned, and a 'set active'
  // rollback must never resurrect a runtime park, nor must a racing 401 outlive
  // an uncommitted admin edit. The runtime re-derives its verdict on the next
  // real request anyway.
  const now = Date.now();
  const preBackoff = now + 45_000;
  initializeState({
    keys: [{ id: DURABLE_ID_A, key: 'precedence-key', status: 'quota-exceeded', backoffUntil: preBackoff, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] }]
  });
  affinity.resetAffinityState({ cachePath: null });

  let gate;
  setPersistenceAdapter(() => { gate = deferred(); return gate.promise; });
  try {
    const mutation = rotation.setKeyStatusDurably(DURABLE_ID_A, 'active'); // admin unpark, in flight
    await tick();
    assert.equal(getKeys()[0].status, 'active', 'admin intent is visible during the ack window');

    // Meanwhile a live request gets a 401 verdict on the SAME key.
    handleKeyError(DURABLE_ID_A, 401, 'unauthorized', null);
    assert.equal(getKeys().find((k) => k.id === DURABLE_ID_A).status, 'disabled');

    gate.reject(new Error('simulated disk failure'));
    await assert.rejects(mutation, (err) => err?.code === 'KEY_PERSISTENCE_FAILED');

    const rolledBack = getKeys().find((k) => k.id === DURABLE_ID_A);
    assert.equal(rolledBack.status, 'quota-exceeded', 'the uncommitted admin edit AND the racing runtime verdict are both rolled back to the durable truth');
    assert.equal(rolledBack.backoffUntil, preBackoff, 'the pre-mutation backoff schedule is restored verbatim');
  } finally {
    setPersistenceAdapter(() => {});
  }
});

test('the persist-ack registry resolves matching acks and rejects stale/skipped/rejected/timeout outcomes', async () => {
  assert.equal(rotation.DURABLE_ACK_TIMEOUT_MS, 5_000, 'production acks time out after 5s');
  const registry = rotation.createPersistAckRegistry({ timeoutMs: 50, unref: false });
  assert.equal(typeof registry.awaitAck, 'function');
  assert.equal(typeof registry.handleMessage, 'function');

  // A stale ack (unknown requestId) is ignored and never resolves a waiter.
  const first = registry.awaitAck('req-1', 1);
  assert.equal(registry.handleMessage({ type: 'state:persist:ack', requestId: 'stale-req', revision: 99 }), false);
  assert.equal(registry.pendingCount, 1);

  // A REVISION-MISMATCHED ack for a pending request id is a protocol violation.
  registry.handleMessage({ type: 'state:persist:ack', requestId: 'req-1', revision: 2 });
  await assert.rejects(first, /revision/i);
  assert.equal(registry.pendingCount, 0);

  // An exact ack resolves.
  const second = registry.awaitAck('req-2', 2);
  assert.equal(registry.handleMessage({ type: 'state:persist:ack', requestId: 'req-2', revision: 2 }), true);
  await assert.doesNotReject(second);

  // A rejection message rejects with the recorded failure.
  const third = registry.awaitAck('req-3', 3);
  registry.handleMessage({ type: 'state:persist:rejected', requestId: 'req-3', revision: 3, error: 'write failed' });
  await assert.rejects(third, /write failed/);

  // A never-answered durable request times out (bounded wait).
  await assert.rejects(registry.awaitAck('req-4', 4), /timeout/i);
  assert.equal(registry.pendingCount, 0);

  // A disconnect fails every pending waiter immediately.
  const fifth = registry.awaitAck('req-5', 5);
  registry.rejectAll(new Error('channel disconnected'));
  await assert.rejects(fifth, /channel disconnected/);
  assert.equal(registry.pendingCount, 0);
});

// ─── Ack-loss healing (HIGH regression) ─────────────────────────────────────
//
// Wiring: the real rotation durable path (only the adapter is bridged) + the
// REAL built private-state-channel (the main-process side) + an in-memory IPC
// bridge. Scenario: main persists durable revision 1 but its ack is LOST in
// transit. The child must roll back AND re-persist the restored pre-mutation
// state (disk stays equal to memory); the next durable mutation must not
// deadlock on the stale revision — the main side rejects it WITH its ledger,
// the child fast-forwards and retries once at the expected revision, and the
// mutation eventually succeeds with disk === memory.

test('ack loss after a committed revision heals: rollback reconciles disk and the next mutation succeeds', async () => {
  const built = (name) => pathToFileURL(path.join(path.resolve(import.meta.dirname, '..'), 'build', 'src', 'main', name)).href;
  const { createPrivateStateChannel } = await import(built('private-state-channel.js'));
  assert.equal(typeof rotation.createPersistBridgeAdapter, 'function',
    'rotation must export createPersistBridgeAdapter (real durable adapter over an injectable channel)');

  initializeState({
    keys: [{ id: DURABLE_ID_A, key: 'bridge-key-1', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] }]
  });
  affinity.resetAffinityState({ cachePath: null });

  let persistedProjection = null;
  let childMessageHandler = null;
  let dropNextAck = true; // the ack for durable revision 1 is lost in transit
  const mainSideChild = new EventEmitter();
  mainSideChild.connected = true;
  mainSideChild.send = (message, callback) => {
    if (message?.type === 'state:persist:ack' && dropNextAck) {
      dropNextAck = false; // swallowed in transit: the channel THINKS it replied
      callback?.(null);
      return true;
    }
    if (message?.type === 'state:persist:ack' || message?.type === 'state:persist:rejected') childMessageHandler(message);
    callback?.(null);
    return true;
  };

  const adapter = rotation.createPersistBridgeAdapter({
    timeoutMs: 80,
    unref: false,
    send: (message, callback) => { mainSideChild.emit('message', message); callback?.(null); return true; },
    onMessage: (handler) => { childMessageHandler = handler; },
    onDisconnect: () => {}
  });

  const channel = createPrivateStateChannel({
    initialState: { keys: [] },
    persist: async (state) => { persistedProjection = structuredClone(state); }
  });
  channel.attach(mainSideChild);
  mainSideChild.emit('message', { type: 'ready', challenge: 'bridge-rotation-channel-challenge-1' });
  assert.equal(channel.authenticated, true);

  setPersistenceAdapter(adapter);
  try {
    // 1. The ack for revision 1 is lost: the mutation must FAIL visibly (not
    //    hang), roll back memory, and the reconcile save must put disk back in
    //    sync with the restored state.
    const removal = rotation.removeKeyDurably(DURABLE_ID_A);
    await assert.rejects(removal, (err) => err?.code === 'KEY_PERSISTENCE_FAILED');
    assert.equal(getKeys().length, 1, 'ack loss rolls back the in-memory removal');
    assert.equal(persistedProjection?.keys?.length, 1,
      'the restored pre-mutation state must be re-persisted so disk matches memory');

    // 2. The next durable mutation must NOT deadlock on a stale revision: the
    //    main side rejects it carrying its ledger, the child fast-forwards and
    //    retries once at the expected revision — and it lands.
    const applied = await rotation.setKeyStatusDurably(DURABLE_ID_A, 'disabled');
    assert.equal(applied, true, 'the mutation succeeds after the revision self-heal');
    assert.equal(getKeys()[0].status, 'disabled', 'memory shows the retried mutation');
    assert.equal(persistedProjection?.keys?.[0]?.status, 'disabled', 'disk shows the retried mutation');

    // 3. A subsequent healthy mutation needs no healing at all.
    const removed = await rotation.removeKeyDurably(DURABLE_ID_A);
    assert.equal(removed, true, 'durable mutations keep working after the healed cycle');
    assert.equal(persistedProjection?.keys?.length, 0, 'disk and memory stay identical');
    assert.equal(getKeys().length, 0);
  } finally {
    setPersistenceAdapter(() => {});
  }
});

test('scenario B: a repeated remove after ack-loss must never get a false idempotent ack (disk really loses the key)', async () => {
  const built = (name) => pathToFileURL(path.join(path.resolve(import.meta.dirname, '..'), 'build', 'src', 'main', name)).href;
  const { createPrivateStateChannel } = await import(built('private-state-channel.js'));

  initializeState({
    keys: [{ id: DURABLE_ID_A, key: 'scenarioB-key', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] }]
  });
  affinity.resetAffinityState({ cachePath: null });

  let persistedProjection = null;
  let childMessageHandler = null;
  let dropNextAck = true;
  const mainSideChild = new EventEmitter();
  mainSideChild.connected = true;
  mainSideChild.send = (message, callback) => {
    if (message?.type === 'state:persist:ack' && dropNextAck) {
      dropNextAck = false; // the ack for the FIRST commit dies in transit
      callback?.(null);
      return true;
    }
    if (message?.type === 'state:persist:ack' || message?.type === 'state:persist:rejected') childMessageHandler(message);
    callback?.(null);
    return true;
  };

  const adapter = rotation.createPersistBridgeAdapter({
    timeoutMs: 80,
    unref: false,
    send: (message, callback) => { mainSideChild.emit('message', message); callback?.(null); return true; },
    onMessage: (handler) => { childMessageHandler = handler; },
    onDisconnect: () => {}
  });

  const channel = createPrivateStateChannel({
    initialState: { keys: [] },
    persist: async (state) => { persistedProjection = structuredClone(state); }
  });
  channel.attach(mainSideChild);
  mainSideChild.emit('message', { type: 'ready', challenge: 'scenario-b-channel-challenge-12345' });
  assert.equal(channel.authenticated, true);

  setPersistenceAdapter(adapter);
  try {
    // (1) Remove A: main commits revision 1 with P1; the ack is lost. The child
    // rolls back and reconciles: disk returns to P0 (the key is back).
    await assert.rejects(rotation.removeKeyDurably(DURABLE_ID_A), (err) => err?.code === 'KEY_PERSISTENCE_FAILED');
    assert.equal(getKeys().length, 1, 'memory rolled back');
    assert.equal(persistedProjection?.keys?.length, 1, 'the reconcile save restored P0 on disk');

    // (2) Operator re-issues the same remove. WITHOUT a projection-aware main
    // side this gets an idempotent re-ack while disk still holds P0 — the key
    // would resurrect on restart. It must instead be rejected-with-ledger and
    // self-heal through the retry, ending with disk === memory === no A.
    const removed = await rotation.removeKeyDurably(DURABLE_ID_A);
    assert.equal(removed, true, 'the repeated mutation completes through the heal path');
    assert.equal(getKeys().length, 0, 'memory lost the key');
    assert.equal(persistedProjection?.keys?.length, 0, 'DISK really lost the key — no false ack');

    // (3) The channel keeps working for further durable mutations.
    const added = await rotation.addKeyDurably('scenario-b-second-key');
    assert.ok(added, 'a later durable mutation still works');
    assert.equal(persistedProjection?.keys?.length, 1, 'disk tracks it');
  } finally {
    setPersistenceAdapter(() => {});
  }
});

test('scenario B reconcile only fires when the main side may have committed; ledger-stamped rejections skip it', async () => {
  // Part A: a divergent-revision rejection (main never wrote anything new) must
  // NOT trigger the extra legacy reconcile write.
  initializeState({
    keys: [{ id: DURABLE_ID_A, key: 'skip-reconcile-a', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] }]
  });
  affinity.resetAffinityState({ cachePath: null });
  const calls = [];
  setPersistenceAdapter((projection, context) => {
    calls.push({ durable: context?.durable === true });
    if (context?.durable === true && context.revision === 1) {
      const failure = new Error('stale revision vs main ledger');
      failure.lastPersistedRevision = 5;
      return Promise.reject(failure);
    }
    return Promise.resolve();
  });
  try {
    const removed = await rotation.removeKeyDurably(DURABLE_ID_A);
    assert.equal(removed, true, 'rejection-with-ledger heals via fast-forward + retry');
    assert.equal(calls.filter((c) => c.durable).length, 2, 'reject + retry are the two durable calls');
    assert.equal(calls.filter((c) => !c.durable).length, 0, 'NO reconcile write: the rejection proves main had nothing new to overwrite');

    // Part B: an AMBIGUOUS failure (ack lost / channel gone) keeps the reconcile.
    initializeState({ keys: [{ id: DURABLE_ID_A, key: 'skip-reconcile-a', status: 'active' }] });
    calls.length = 0;
    setPersistenceAdapter((projection, context) => {
      calls.push({ durable: context?.durable === true });
      if (context?.durable === true) return Promise.reject(new Error('ack timeout — main state unknown'));
      return Promise.resolve();
    });
    await assert.rejects(rotation.removeKeyDurably(DURABLE_ID_A), (err) => err?.code === 'KEY_PERSISTENCE_FAILED');
    assert.ok(calls.filter((c) => !c.durable).length >= 1, 'ambiguous failure reconciles disk with the rolled-back memory');
  } finally {
    setPersistenceAdapter(() => {});
  }
});

test('a PERSIST_WRITE_FAILED rejection (partial disk commit) still triggers the reconcile write', async () => {
  // The primary file may already hold the rejected mutation when only the
  // recovery replace failed. The child must NOT trust "rejected == nothing
  // committed" for write-originated failures: rollback memory AND reconcile
  // disk. Ledger-stamped PRE-persist rejections (wrong revision, migration)
  // are the only ones allowed to skip the reconcile write.
  initializeState({
    keys: [{ id: DURABLE_ID_A, key: 'partial-commit-key', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] }]
  });
  affinity.resetAffinityState({ cachePath: null });
  const calls = [];
  setPersistenceAdapter((projection, context) => {
    calls.push({ durable: context?.durable === true, projection: structuredClone(projection) });
    if (context?.durable === true) {
      const failure = new Error('recovery replace failed after primary committed');
      failure.lastPersistedRevision = 0;
      failure.code = 'PERSIST_WRITE_FAILED';
      return Promise.reject(failure);
    }
    return Promise.resolve();
  });
  try {
    await assert.rejects(rotation.removeKeyDurably(DURABLE_ID_A), (err) => err?.code === 'KEY_PERSISTENCE_FAILED');
    assert.equal(getKeys().length, 1, 'memory rolled back');
    assert.ok(calls.filter((c) => !c.durable).length >= 1,
      'a write-originated failure is ambiguous at the fs layer: the reconcile save MUST run so disk matches memory');
    const reconcile = calls.find((c) => !c.durable);
    assert.equal(reconcile.projection.keys.length, 1, 'the reconcile carries the restored pre-mutation state');
    assert.equal(calls.filter((c) => c.durable).length, 1, 'no fast-forward retry: the ledger did not advance past ours');
  } finally {
    setPersistenceAdapter(() => {});
  }
});

test('unhandled synchronous throw in mutate() reverts keys to untouched original key list', async () => {
  const originalKey = { id: 'test-sync-throw-id', key: 'original-key', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] };
  initializeState({ keys: [originalKey] });
  const initialKeys = getKeys();
  assert.equal(initialKeys.length, 1);
  assert.equal(initialKeys[0].key, 'original-key');

  await assert.rejects(
    async () => {
      await rotation.executeDurableMutation((working) => {
        working.push({ id: 'bad-key', key: 'mutated-key', status: 'active' });
        throw new Error('sync throw during mutation');
      });
    },
    /sync throw during mutation/
  );

  const afterKeys = getKeys();
  assert.equal(afterKeys.length, 1, 'keys must revert to untouched original key list');
  assert.equal(afterKeys[0].key, 'original-key');
});

test('clock backward jump clamps short active-key backoff using the supplied deterministic time', () => {
  const keyId = '33333333-3333-4333-8333-333333333333';
  const now = 1_700_000_000_000;
  // Key was given backoffUntil far in the future before clock jumped backwards by 2 hours
  const farFuture = now + 7_200_000;
  initializeState({
    keys: [{ id: keyId, key: 'clock-key', status: 'active', backoffUntil: farFuture, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] }]
  });

  reclaimDueParkedKeys(now);
  const key = getKeys().find((k) => k.id === keyId);
  assert.ok(key, 'key must exist in state');
  assert.equal(key.backoffUntil, now + MAX_BACKOFF_MS,
    'the active-key clamp must use the short global cooldown ceiling exactly');
});
