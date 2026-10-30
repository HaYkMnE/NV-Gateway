// Э3-R6: temporarily failed keys return to rotation on their own, and a
// restart (state reload) never leaves a stuck penalty. Owner rule (28.09):
// every automatic penalty is temporary; only an admin disable is permanent.
//
// Time is driven by node:test mock.timers (Date only) - no real sleeps.
// No network, fake keys only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-r6-'));
process.env.GATEWAY_LOG_PATH = path.join(tmpDir, 'logs', 'gateway.jsonl');
process.env.GATEWAY_MODEL_AFFINITY_CACHE_PATH = path.join(tmpDir, 'affinity.json');

const rotation = await import('../src/gateway/rotation.mjs');
const affinity = await import('../src/gateway/model-key-affinity.mjs');
const logger = await import('../src/gateway/logger.mjs');
const { resolveMaxFailoverAttempts } = await import('../src/gateway/failover-policy.mjs');

const {
  initializeState, getKeys, getNextKey, handleKeyError, setKeyStatus, removeKey, addKey,
  setPersistenceAdapter, closeStateWatcher, markKeyUsedAndDebounceSave, projectKeyState,
  getCurrentEligibleKeyIds, getModelEligibleKeyCount,
  AUTH_RETRY_BASE_MS, AUTH_RETRY_MAX_MS, MAX_BACKOFF_MS, MAX_KEY_COOLDOWN_429_MS
} = rotation;

const SEC = 1_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const ID = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const A = ID(1);
const B = ID(2);
const usage = () => ({ success: 0, fail: 0, tokens: 0, lastUsed: 0 });
const rec = (id, key, extra = {}) => ({ id, key, status: 'active', backoffUntil: 0, usage: usage(), ...extra });
const key = (id) => getKeys().find((k) => k.id === id);
const eligible = (model) => new Set(getCurrentEligibleKeyIds(model));
/** Simulated restart: project -> JSON (disk) -> normalize/load. */
const restart = () => initializeState(JSON.parse(JSON.stringify(projectKeyState())));

setPersistenceAdapter(() => {});

/**
 * Isolation: quotaRetries/authRetries are module-level Maps (rotation.mjs:80/:103)
 * that initializeState never clears, so tests would inherit ladders in any other
 * order. setKeyStatus(id,'active') (rotation.mjs:727) deletes BOTH ladder entries;
 * its only other effect is saveState() into the no-op adapter, and every test
 * re-initializes its own pool afterwards.
 */
const LADDER_IDS = [A, B, ID(3)];
function resetLadders() {
  initializeState({ keys: LADDER_IDS.map((id, i) => rec(id, `fake-reset-${i}`)) });
  for (const id of LADDER_IDS) assert.equal(setKeyStatus(id, 'active'), true);
}

test.beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  affinity.resetAffinityState({ cachePath: null });
  resetLadders();
});
test.afterEach(() => {
  mock.timers.reset();
  closeStateWatcher();
  logger.closeLogger();
});
test.after(() => {
  closeStateWatcher();
  logger.closeLogger();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('R6-a: a per-model 429 blocks only (model,key), expires after 20 s, never touches other models', () => {
  initializeState({ keys: [rec(A, 'fake-a'), rec(B, 'fake-b')] });
  handleKeyError(A, 429, 'rate limit', null, 'm1');
  assert.equal(key(A).status, 'active');
  assert.equal(key(A).backoffUntil, 0, 'no global backoff for a model-scoped 429');
  assert.deepEqual([...eligible('m1')], [B]);
  assert.ok(eligible('m2').has(A), 'other models keep using the key');
  mock.timers.tick(MAX_KEY_COOLDOWN_429_MS - 1);
  assert.ok(!eligible('m1').has(A), 'still cooling 1 ms before expiry');
  mock.timers.tick(2);
  assert.ok(eligible('m1').has(A), 'selectable for m1 again after the cooldown');
});

test('R6-a: Retry-After on a per-model 429 is capped at 300 s', () => {
  initializeState({ keys: [rec(A, 'fake-a'), rec(B, 'fake-b')] });
  handleKeyError(A, 429, 'rate limit', 100_000, 'm1');
  mock.timers.tick(MAX_BACKOFF_MS - 1);
  assert.ok(!eligible('m1').has(A));
  mock.timers.tick(2);
  assert.ok(eligible('m1').has(A), 'capped window elapsed');
});

test('R6-b: quota park 5->10->20->40->60->60 min, reclaimed after each step, success resets to 5 min', () => {
  const MIN = 60_000;
  initializeState({ keys: [rec(A, 'fake-a'), rec(B, 'fake-b')] });
  for (const [i, windowMs] of [5, 10, 20, 40, 60, 60].map((m) => m * MIN).entries()) {
    handleKeyError(A, 429, 'You have exceeded your credit balance quota', null, 'm1');
    assert.equal(key(A).status, 'quota-exceeded', `step #${i + 1} parks pool-wide`);
    assert.equal(key(A).backoffUntil - Date.now(), windowMs, `step #${i + 1}`);
    assert.ok(!eligible('m2').has(A), 'quota park is pool-wide');
    mock.timers.tick(windowMs + 1);
    assert.ok(eligible('m2').has(A), `reclaimed after step #${i + 1}`);
    assert.equal(key(A).status, 'active');
  }
  markKeyUsedAndDebounceSave(A, { success: true, tokens: 1 });
  handleKeyError(A, 429, 'You have exceeded your credit balance quota', null, 'm1');
  assert.equal(key(A).backoffUntil - Date.now(), 5 * MIN, 'success resets the ladder');
});

for (const [label, status, retryAfter, windowMs] of [
  ['5xx default', 503, null, 10 * SEC],
  ['timeout/504 default', 504, null, 10 * SEC],
  ['5xx Retry-After capped', 502, 100_000, MAX_BACKOFF_MS]
]) {
  test(`R6-c: ${label} -> globally parked for ${windowMs} ms, then selectable`, () => {
    initializeState({ keys: [rec(A, 'fake-a'), rec(B, 'fake-b')] });
    handleKeyError(A, status, 'upstream', retryAfter, 'm1');
    assert.equal(key(A).backoffUntil, T0 + windowMs);
    assert.ok(!eligible(undefined).has(A) && !eligible('m1').has(A));
    mock.timers.tick(windowMs + 1);
    assert.ok(eligible(undefined).has(A) && eligible('m1').has(A), 'back in rotation');
  });
}

test('R6-d: 401/403 park doubles 1h->2h->...->24h, stays capped at 24h, sweep revives, success resets', () => {
  initializeState({ keys: [rec(A, 'fake-a'), rec(B, 'fake-b')] });
  const expected = [1, 2, 4, 8, 16, 24, 24].map((h) => h * HOUR);
  for (const [i, windowMs] of expected.entries()) {
    handleKeyError(A, i % 2 ? 403 : 401, 'invalid credential', null, 'm1');
    assert.equal(key(A).status, 'disabled');
    assert.equal(key(A).parkedReason, 'auth');
    assert.equal(key(A).backoffUntil - Date.now(), windowMs, `rejection #${i + 1}`);
    mock.timers.tick(windowMs - 1);
    getNextKey('m1');
    assert.equal(key(A).status, 'disabled', 'not revived early');
    mock.timers.tick(2);
    getNextKey('m1');
    assert.equal(key(A).status, 'active', `revived after window #${i + 1}`);
    assert.equal(key(A).parkedReason, undefined);
    assert.ok(eligible('m1').has(A));
  }
  markKeyUsedAndDebounceSave(A, { success: true, tokens: 1 });
  handleKeyError(A, 401, 'invalid credential', null, 'm1');
  assert.equal(key(A).backoffUntil - Date.now(), AUTH_RETRY_BASE_MS, 'success resets to 1h');
  assert.equal(AUTH_RETRY_MAX_MS, 24 * HOUR);
});

test('R6-e: restart with past-due backoff and past-due auth park -> keys selectable, no stuck marker', () => {
  initializeState({ keys: [
    rec(A, 'fake-a', { backoffUntil: T0 - 1 }),
    rec(B, 'fake-b', { status: 'disabled', backoffUntil: T0 - 1, parkedReason: 'auth' })
  ] });
  restart();
  assert.deepEqual(eligible('m1'), new Set([A, B]));
  assert.equal(key(B).status, 'active');
  assert.equal(key(B).parkedReason, undefined);
  restart();
  assert.equal(projectKeyState().keys.find((k) => k.id === B).parkedReason, undefined, 'marker not re-persisted');
});

test('R6-e: restart with a future auth park and future 5xx backoff -> still parked, freed when time passes', () => {
  initializeState({ keys: [rec(A, 'fake-a'), rec(B, 'fake-b'), rec(ID(3), 'fake-c')] });
  handleKeyError(A, 500, 'upstream', null, undefined);
  handleKeyError(B, 401, 'invalid credential', null, undefined);
  restart();
  assert.equal(key(A).backoffUntil, T0 + 10 * SEC, 'absolute 5xx deadline survives');
  assert.equal(key(B).parkedReason, 'auth');
  assert.equal(key(B).backoffUntil, T0 + AUTH_RETRY_BASE_MS, 'absolute auth deadline survives');
  assert.deepEqual([...eligible('m1')], [ID(3)]);
  mock.timers.tick(10 * SEC + 1);
  assert.ok(eligible('m1').has(A) && !eligible('m1').has(B));
  mock.timers.tick(AUTH_RETRY_BASE_MS);
  restart();
  assert.deepEqual(eligible('m1'), new Set([A, B, ID(3)]), 'auth park freed after restart past its time');
});

test('R6-f: restart with a persisted affinity cooldown in the past -> no stale block; a future one expires', () => {
  const cachePath = path.join(tmpDir, 'r6-affinity.json');
  const pair = (m, id) => `${m}\u0000${id}`;
  fs.writeFileSync(cachePath, JSON.stringify({
    version: affinity.AFFINITY_CACHE_FORMAT_VERSION,
    assignments: {},
    cooldowns: {
      [pair('m1', A)]: { until: T0 - 1, at: T0 - 20 * SEC },
      [pair('m2', A)]: { until: T0 + 30 * SEC, at: T0 - 1 * SEC }
    }
  }));
  affinity.resetAffinityState({ cachePath });
  initializeState({ keys: [rec(A, 'fake-a'), rec(B, 'fake-b')] });
  assert.ok(eligible('m1').has(A), 'past cooldown does not block');
  assert.ok(!eligible('m2').has(A), 'future cooldown survives restart');
  mock.timers.tick(30 * SEC + 1);
  assert.ok(eligible('m2').has(A), 'and expires on time');
});

test('R6-g (M1): admin disable clears the auth marker; sweep never revives it; re-enable inherits nothing', () => {
  initializeState({ keys: [rec(A, 'fake-a'), rec(B, 'fake-b')] });
  handleKeyError(A, 401, 'invalid credential', null, undefined);
  handleKeyError(A, 401, 'invalid credential', null, undefined); // ladder at 2
  assert.equal(setKeyStatus(A, 'disabled'), true);
  assert.equal(key(A).parkedReason, undefined);
  assert.equal(key(A).backoffUntil, 0);
  mock.timers.tick(AUTH_RETRY_MAX_MS * 2);
  restart();
  getNextKey();
  assert.equal(key(A).status, 'disabled', 'admin disable is permanent across time and restart');
  assert.equal(setKeyStatus(A, 'active'), true);
  assert.equal(key(A).parkedReason, undefined);
  assert.ok(eligible(undefined).has(A));
  handleKeyError(A, 401, 'invalid credential', null, undefined);
  assert.equal(key(A).backoffUntil - Date.now(), AUTH_RETRY_BASE_MS, 'ladder not inherited');
});

test('R6-g (M1): legacy disabled record without marker loads with backoffUntil 0 and stays disabled', () => {
  initializeState({ keys: [rec(A, 'fake-a', { status: 'disabled', backoffUntil: T0 - 1 }), rec(B, 'fake-b')] });
  assert.equal(key(A).backoffUntil, 0);
  getNextKey();
  assert.equal(key(A).status, 'disabled');
});

test('R6-g (M1): remove + re-add a parked key -> fresh active record, no marker, base ladder', () => {
  initializeState({ keys: [rec(A, 'fake-a'), rec(B, 'fake-b')] });
  handleKeyError(A, 403, 'forbidden', null, undefined);
  handleKeyError(A, 403, 'forbidden', null, undefined);
  assert.equal(removeKey(A), true);
  const readded = addKey('fake-a');
  assert.ok(readded);
  assert.equal(readded.status, 'active');
  assert.equal(readded.parkedReason, undefined);
  assert.equal(readded.backoffUntil, 0);
  handleKeyError(readded.id, 401, 'invalid credential', null, undefined);
  assert.equal(key(readded.id).backoffUntil - Date.now(), AUTH_RETRY_BASE_MS);
});

// --- M1 rollback: a durable admin mutation whose persist FAILS -------------
// Failure injection (same as rotation.test.mjs:299-316): the persistence
// adapter rejects the durable (ack-awaiting) write; the background reconcile
// write it triggers is accepted. The mutation must reject KEY_PERSISTENCE_FAILED.
async function withFailingDurablePersist(run) {
  setPersistenceAdapter((_projection, context) => (context?.durable
    ? Promise.reject(new Error('simulated disk failure'))
    : undefined));
  try { await run(); } finally { setPersistenceAdapter(() => {}); }
}
const persistFailed = (err) => err?.code === 'KEY_PERSISTENCE_FAILED';

test('R6-r1 (M1 rollback): failed admin disable of an auth-parked key keeps the auth park and its reclaim', async () => {
  initializeState({ keys: [rec(A, 'fake-a'), rec(B, 'fake-b')] });
  handleKeyError(A, 401, 'invalid credential', null, undefined);
  const parkedUntil = key(A).backoffUntil;
  assert.equal(parkedUntil, T0 + AUTH_RETRY_BASE_MS);
  await withFailingDurablePersist(async () => {
    await assert.rejects(rotation.setKeyStatusDurably(A, 'disabled'), persistFailed);
  });
  assert.equal(key(A).status, 'disabled');
  assert.equal(key(A).parkedReason, 'auth', 'rollback restores the runtime-park marker');
  assert.equal(key(A).backoffUntil, parkedUntil, 'rollback restores the same finite window');
  mock.timers.tick(AUTH_RETRY_BASE_MS - 1);
  getNextKey();
  assert.equal(key(A).status, 'disabled', 'not revived early');
  mock.timers.tick(2);
  getNextKey();
  assert.equal(key(A).status, 'active', 'the sweep still reclaims it after the window');
  assert.ok(eligible('m1').has(A));
});

test('R6-r2 (M1 rollback): failed admin re-enable of an auth-parked key restores the marker, nothing permanent', async () => {
  initializeState({ keys: [rec(A, 'fake-a'), rec(B, 'fake-b')] });
  handleKeyError(A, 403, 'forbidden', null, undefined);
  const parkedUntil = key(A).backoffUntil;
  assert.equal(parkedUntil, T0 + AUTH_RETRY_BASE_MS, 'isolated ladder: first rejection parks for exactly 1 h');
  await withFailingDurablePersist(async () => {
    await assert.rejects(rotation.setKeyStatusDurably(A, 'active'), persistFailed);
  });
  assert.equal(key(A).status, 'disabled');
  assert.equal(key(A).parkedReason, 'auth', 'marker is back');
  assert.equal(key(A).backoffUntil, parkedUntil, 'finite window is back (not the admin 0)');
  restart();
  assert.equal(key(A).parkedReason, 'auth', 'restored marker survives a restart');
  mock.timers.tick(AUTH_RETRY_BASE_MS - 1);
  assert.ok(!eligible('m1').has(A), 'not revived early');
  mock.timers.tick(2);
  assert.ok(eligible('m1').has(A), 'reclaimed after the window');
  assert.equal(key(A).status, 'active');
});

test('R6-r3 (rollback): failed key removal restores its affinity cooldown with the original finite until', async () => {
  initializeState({ keys: [rec(A, 'fake-a'), rec(B, 'fake-b')] });
  handleKeyError(A, 429, 'rate limit', null, 'm1');
  assert.ok(!eligible('m1').has(A));
  await withFailingDurablePersist(async () => {
    await assert.rejects(rotation.removeKeyDurably(A), persistFailed);
  });
  assert.ok(key(A), 'the key is back');
  assert.equal(key(A).status, 'active');
  assert.ok(affinity.isRateLimited('m1', A, { now: T0 + MAX_KEY_COOLDOWN_429_MS - 1 }), 'cooldown restored');
  assert.ok(!affinity.isRateLimited('m1', A, { now: T0 + MAX_KEY_COOLDOWN_429_MS + 1 }), 'original until kept');
  assert.ok(!eligible('m1').has(A) && eligible('m2').has(A), 'still model-scoped only');
  mock.timers.tick(MAX_KEY_COOLDOWN_429_MS + 1);
  assert.ok(eligible('m1').has(A), 'restored cooldown expires on time');
});

test('R6-h (M2): eligible==0 (every key model-cooled) -> coverage = max(1, activeCount), not 0', () => {
  initializeState({ keys: [rec(A, 'fake-a'), rec(B, 'fake-b')] });
  handleKeyError(A, 429, 'rate limit', null, 'm1');
  handleKeyError(B, 429, 'rate limit', null, 'm1');
  assert.equal(getModelEligibleKeyCount('m1'), 0);
  assert.deepEqual(eligible('m1'), new Set([A, B]), 'selection falls back to the active pool');
  assert.ok(getNextKey('m1'), 'a key is still handed out');
  // Pin the server.mjs coverage formula (inline in the request handler).
  const src = fs.readFileSync(new URL('../src/gateway/server.mjs', import.meta.url), 'utf8');
  assert.match(src, /modelEligibleKeyCount > 0\s*\?\s*modelEligibleKeyCount\s*:\s*Math\.max\(1, activeCount\)/);
  assert.ok(resolveMaxFailoverAttempts({}, 2, 1, Math.max(1, 2)) >= 2, 'budget raised to cover the active pool');
});

test('R6-i: every automatic penalty path ends in a finite window (only admin disable is permanent)', () => {
  const cases = [
    [401, 'invalid credential', null, 'm1'], [403, 'forbidden', null, undefined],
    [429, 'You have exceeded your credit balance quota', null, 'm1'],
    [429, 'rate limit', 100_000, 'm1'], [429, 'rate limit', 100_000, undefined],
    [500, 'upstream', 100_000, 'm1'], [504, 'timeout', null, undefined]
  ];
  for (const [status, body, retryAfter, model] of cases) {
    mock.timers.reset();
    mock.timers.enable({ apis: ['Date'], now: T0 });
    affinity.resetAffinityState({ cachePath: null });
    initializeState({ keys: [rec(A, 'fake-a'), rec(B, 'fake-b')] });
    for (let i = 0; i < 12; i++) {
      handleKeyError(A, status, body, retryAfter, model);
      mock.timers.tick(AUTH_RETRY_MAX_MS + 1); // longest possible automatic window
      restart();
      assert.ok(eligible('m1').has(A), `${status} "${body}" #${i + 1}: key must be back in rotation`);
      assert.equal(key(A).status, 'active');
    }
  }
});
