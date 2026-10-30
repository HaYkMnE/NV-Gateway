// Behavioural guards for the key-rotation recovery/classification rules.
//
// Every test here is written to FAIL against the pre-fix rotation.mjs, and to
// fail again if the specific line it pins is mutated. See the report in the
// commit body for the mutation matrix that was actually executed.
//
// No network, no API keys: the pool is built from fixtures via initializeState.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rot-recovery-'));
process.env.GATEWAY_LOG_PATH = path.join(tmpDir, 'logs', 'gateway.jsonl');
// Keep the affinity cache off any real userData dir.
process.env.GATEWAY_MODEL_AFFINITY_CACHE_PATH = path.join(tmpDir, 'affinity.json');

const rotation = await import('../src/gateway/rotation.mjs');
const affinity = await import('../src/gateway/model-key-affinity.mjs');
const logger = await import('../src/gateway/logger.mjs');

const {
  initializeState,
  getKeys,
  getNextKey,
  handleKeyError,
  setKeyStatus,
  setPersistenceAdapter,
  closeStateWatcher,
  markKeyUsedAndDebounceSave,
  removeKey,
  QUOTA_RETRY_BASE_MS,
  QUOTA_RETRY_MAX_MS,
  AUTH_RETRY_BASE_MS,
  AUTH_RETRY_MAX_MS,
  reclaimDueParkedKeys
} = rotation;

const MINUTE = 60_000;
const HOUR = 3_600_000;

setPersistenceAdapter(() => {});

const ID = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

function usage(lastUsed = 0) {
  return { success: 0, fail: 0, tokens: 0, lastUsed };
}

// Isolation: quotaRetries/authRetries are module-level Maps (rotation.mjs:80/:103)
// that initializeState never clears. setKeyStatus(id,'active') (rotation.mjs:727)
// deletes both ladder entries; every test then loads its own pool.
const LADDER_IDS = [1, 2, 3, 4, 5, 6, 7, 8].map(ID);
test.beforeEach(() => {
  affinity.resetAffinityState({ cachePath: null });
  initializeState({ keys: LADDER_IDS.map((id, i) => ({ id, key: `fake-reset-${i}`, status: 'active', backoffUntil: 0, usage: usage(0) })) });
  for (const id of LADDER_IDS) assert.equal(setKeyStatus(id, 'active'), true);
});

test.afterEach(() => {
  closeStateWatcher();
  logger.closeLogger();
});

test.after(() => {
  closeStateWatcher();
  logger.closeLogger();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// DEFECT 1 — quota-exceeded keys must recover on their OWN schedule
// ---------------------------------------------------------------------------

test('DEFECT1-A: one surviving active key must NOT starve the rest of the pool (5 keys stay reachable)', () => {
  const now = Date.now();
  // 1 active key + 4 quota-exceeded keys whose retry window has fully elapsed.
  initializeState({
    keys: [
      { id: ID(1), key: 'k1', status: 'active', backoffUntil: 0, usage: usage(now) },
      { id: ID(2), key: 'k2', status: 'quota-exceeded', backoffUntil: now - 1, usage: usage(now - 2 * HOUR) },
      { id: ID(3), key: 'k3', status: 'quota-exceeded', backoffUntil: now - 1, usage: usage(now - 2 * HOUR) },
      { id: ID(4), key: 'k4', status: 'quota-exceeded', backoffUntil: now - 1, usage: usage(now - 2 * HOUR) },
      { id: ID(5), key: 'k5', status: 'quota-exceeded', backoffUntil: now - 1, usage: usage(now - 2 * HOUR) }
    ]
  });

  const served = new Set();
  for (let i = 0; i < 20; i++) {
    const selected = getNextKey();
    if (selected) served.add(selected.id);
  }

  // Pre-fix: exactly 1 (the pool collapses to the single active key, pinning the
  // user at NVIDIA's ~40 RPM baseline). The revival branch is unreachable while
  // any active key exists.
  assert.equal(served.size, 5, `all 5 keys must serve traffic once their retry window elapsed, got ${served.size}`);
  assert.equal(getKeys().filter((k) => k.status === 'active').length, 5, 'due quota keys must be reclaimed to active');
});

test('DEFECT1-B: recovery is governed by the retry schedule, NOT by usage.lastUsed', () => {
  const now = Date.now();
  // The key failed a moment ago (lastUsed = now — exactly what
  // markKeyUsedAndDebounceSave writes on FAILURE) but its retry window is due.
  initializeState({
    keys: [{ id: ID(7), key: 'k7', status: 'quota-exceeded', backoffUntil: now - 1000, usage: usage(now) }]
  });

  const selected = getNextKey();

  // Pre-fix: null — `now - usage.lastUsed >= 3600000` is false because the
  // failure write reset the clock, so the pool reports EMPTY (the 503 path)
  // even though the key was due for a retry.
  assert.ok(selected, 'a due quota key must be retried even though its lastUsed was just bumped by a failure');
  assert.equal(selected.id, ID(7));
  assert.equal(selected.status, 'active');
});

test('DEFECT1-C: a parked quota key is NOT hammered before its window elapses', () => {
  const now = Date.now();
  // lastUsed is ancient (pre-fix revival condition satisfied) but the schedule
  // says "not yet".
  initializeState({
    keys: [{ id: ID(8), key: 'k8', status: 'quota-exceeded', backoffUntil: now + 5 * MINUTE, usage: usage(now - 2 * HOUR) }]
  });

  let revivals = 0;
  for (let i = 0; i < 100; i++) {
    if (getNextKey()) revivals++;
  }

  // Pre-fix: 1 (the ancient lastUsed lets it through, ignoring the schedule).
  assert.equal(revivals, 0, `a key inside its retry window must never be handed out, got ${revivals} revivals`);
  assert.equal(getKeys()[0].status, 'quota-exceeded', 'status must survive the probe attempts');
});

test('DEFECT1-D: failed retries back off, stay bounded, and never exceed the 1 h ceiling', () => {
  const id = ID(9);
  initializeState({
    keys: [{ id, key: 'k9', status: 'quota-exceeded', backoffUntil: Date.now() - 1, usage: usage(Date.now()) }]
  });

  const windows = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const revived = getNextKey();
    assert.ok(revived, `retry ${attempt + 1} must be handed out once due`);
    const before = Date.now();
    // Genuine credit exhaustion, worded WITHOUT the token "quota".
    handleKeyError(id, 429, 'Your credit balance is insufficient; all free credits have been used.', null);
    const key = getKeys().find((k) => k.id === id);
    assert.equal(key.status, 'quota-exceeded', 'credit exhaustion must park the key globally');
    windows.push(key.backoffUntil - before);
    // Make the next window due so the loop can observe the escalation.
    key.backoffUntil = Date.now() - 1;
  }

  // Pre-fix: the body has no "quota" token, so the key is NOT parked at all —
  // status stays 'active' with a 20 s global cooldown, i.e. a dead key gets
  // hammered every 20 s forever. The first assert above is what goes red.
  assert.ok(windows[0] >= QUOTA_RETRY_BASE_MS - 1000 && windows[0] <= QUOTA_RETRY_BASE_MS + 1000,
    `first retry window must be the base ${QUOTA_RETRY_BASE_MS}ms, got ${windows[0]}ms`);
  assert.ok(windows[1] > windows[0], `window must grow on a repeated failure: ${windows[1]}ms vs ${windows[0]}ms`);
  for (const [i, w] of windows.entries()) {
    assert.ok(w <= QUOTA_RETRY_MAX_MS + 1000,
      `window ${i + 1} must never exceed the ${QUOTA_RETRY_MAX_MS}ms ceiling, got ${w}ms`);
  }
  // Bounded: it converges on the ceiling instead of growing without limit, and a
  // failed retry is never scheduled further out than the ceiling the original
  // code used for its single fixed hour.
  assert.ok(windows[windows.length - 1] >= QUOTA_RETRY_MAX_MS - 1000,
    `the schedule must converge on the ceiling, got ${windows[windows.length - 1]}ms`);
  assert.equal(QUOTA_RETRY_MAX_MS, HOUR, 'ceiling stays the 1 h the original code used');
});

test('DEFECT1-D2: quota ladder remains 5/10/20/40/60 minutes after every reclaim sweep', () => {
  const id = 'e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0';
  initializeState({ keys: [{ id, key: 'quota-ladder-key', status: 'active', backoffUntil: 0, usage: usage(0) }] });
  const expectedMinutes = [5, 10, 20, 40, 60];

  for (const expected of expectedMinutes) {
    const before = Date.now();
    handleKeyError(id, 429, 'credit balance exhausted', null);
    const after = Date.now();
    const key = getKeys()[0];
    assert.ok(key.backoffUntil >= before + expected * MINUTE && key.backoffUntil <= after + expected * MINUTE,
      `quota retry window ${expected}m must be scheduled exactly within invocation bounds`);

    reclaimDueParkedKeys(after);
    assert.ok(key.backoffUntil >= before + expected * MINUTE && key.backoffUntil <= after + expected * MINUTE,
      `reclaim sweep must retain the legitimate ${expected}m quota window`);
    key.backoffUntil = after - 1;
    reclaimDueParkedKeys(after);
    assert.equal(key.status, 'active', `quota key must revive after the ${expected}m window is made due`);
  }
});

test('clock-backward protection clamps quota parks to the quota ceiling, not the short cooldown ceiling', () => {
  const now = 1_700_000_000_000;
  initializeState({
    keys: [{ id: ID(5), key: 'quota-clock-key', status: 'quota-exceeded', backoffUntil: now + 2 * HOUR, usage: usage(0) }]
  });
  reclaimDueParkedKeys(now);
  assert.equal(getKeys()[0].backoffUntil, now + QUOTA_RETRY_MAX_MS);
  assert.equal(getKeys()[0].status, 'quota-exceeded');
});

test('clock-backward protection clamps auth parks to the auth ceiling independently', () => {
  const now = 1_700_000_000_000;
  initializeState({
    keys: [{ id: ID(6), key: 'auth-clock-key', status: 'disabled', parkedReason: 'auth', backoffUntil: now + 48 * HOUR, usage: usage(0) }]
  });
  reclaimDueParkedKeys(now);
  assert.equal(getKeys()[0].backoffUntil, now + AUTH_RETRY_MAX_MS);
  assert.equal(getKeys()[0].status, 'disabled');
  assert.equal(getKeys()[0].parkedReason, 'auth');
});

test('DEFECT1-E: a success clears the escalation ladder so a recovered key restarts at the base', () => {
  const id = ID(6);
  initializeState({ keys: [{ id, key: 'k6', status: 'active', backoffUntil: 0, usage: usage(0) }] });

  // Park the key, read the scheduled window, then make it due again.
  const park = () => {
    const before = Date.now();
    handleKeyError(id, 429, 'insufficient credits', null);
    const key = getKeys().find((k) => k.id === id);
    assert.equal(key.status, 'quota-exceeded', 'credit exhaustion must park the key');
    const windowMs = key.backoffUntil - before;
    key.backoffUntil = Date.now() - 1;
    assert.ok(getNextKey(), 'the due key must be reclaimed for its retry');
    return windowMs;
  };

  const first = park();
  const second = park();
  assert.ok(second > first + 60_000, `the ladder must escalate on a repeated failure: ${second}ms vs ${first}ms`);

  // A served request proves the key works again (credits topped up).
  markKeyUsedAndDebounceSave(id, { success: true, tokens: 10 });
  const afterSuccess = park();

  assert.ok(Math.abs(afterSuccess - first) <= 1500,
    `after a success the ladder must restart at the base ${first}ms, got ${afterSuccess}ms`);
  assert.ok(afterSuccess < second, 'a recovered key must not keep carrying the escalated penalty');
});

test('DEFECT1-F: removeKey drops the escalation ladder — a re-added id restarts at the base', () => {
  // NOTE: ID(n) is only valid for single-digit n; this id must also be unique
  // in this file because the in-memory ladder is module-scoped.
  const id = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';
  const parkWindowMs = () => {
    const before = Date.now();
    handleKeyError(id, 429, 'insufficient credits', null);
    const key = getKeys().find((k) => k.id === id);
    assert.equal(key.status, 'quota-exceeded', 'credit exhaustion must park the key');
    return key.backoffUntil - before;
  };

  initializeState({ keys: [{ id, key: 'kr', status: 'active', backoffUntil: 0, usage: usage(0) }] });
  parkWindowMs(); // ladder level 1 (base)
  const escalated = parkWindowMs(); // same live id: ladder level 2
  assert.ok(escalated > QUOTA_RETRY_BASE_MS + 60_000,
    `consecutive failures on a live key must escalate first: ${escalated}ms`);

  removeKey(id);
  // The id gets a second life (state re-push / re-add with the stored id). Its
  // escalation history must not follow it across the deletion.
  initializeState({ keys: [{ id, key: 'kr', status: 'active', backoffUntil: 0, usage: usage(0) }] });
  const afterReadd = parkWindowMs();
  assert.ok(Math.abs(afterReadd - QUOTA_RETRY_BASE_MS) <= 1500,
    `a removed id must restart at the base ${QUOTA_RETRY_BASE_MS}ms, got ${afterReadd}ms`);
});

// ---------------------------------------------------------------------------
// DEFECT 2 — quota classification and branch order
// ---------------------------------------------------------------------------

test('DEFECT2-A: a per-model rate limit that merely CONTAINS "quota" stays model-scoped', () => {
  const id = ID(2);
  const model = 'meta/llama-3.1-405b-instruct';
  initializeState({ keys: [{ id, key: 'kq', status: 'active', backoffUntil: 0, usage: usage(0) }] });

  handleKeyError(id, 429, 'Rate limit reached: you have exceeded your quota of 40 requests per minute for this model.', null, model);

  const key = getKeys().find((k) => k.id === id);
  // Pre-fix: 'quota-exceeded' — the substring match at :217 wins over the
  // model-scoped branch at :218 and kills a healthy key globally.
  assert.equal(key.status, 'active', 'a model-scoped rate limit must not park the key globally');
  assert.equal(key.backoffUntil, 0, 'a model-scoped 429 must not write key.backoffUntil');
  assert.equal(affinity.isRateLimited(model, id), true, 'the (model, key) pair must be cooling down');
  // ...and the key is still immediately usable by a DIFFERENT model.
  const other = getNextKey('nvidia/other-model');
  assert.ok(other && other.id === id, 'the key must stay available to every other model');
});

test('DEFECT2-B: credit exhaustion worded without "quota" parks the key globally', () => {
  const bodies = [
    'Your credit balance is too low to access this model.',
    'You have used all of your free credits.',
    'insufficient credits for this request',
    'error: insufficient_quota'
  ];
  for (const [i, body] of bodies.entries()) {
    affinity.resetAffinityState({ cachePath: null });
    const id = ID(3);
    initializeState({ keys: [{ id, key: `kc${i}`, status: 'active', backoffUntil: 0, usage: usage(0) }] });

    handleKeyError(id, 429, body, null, 'meta/llama-3.1-8b-instruct');

    const key = getKeys().find((k) => k.id === id);
    // Pre-fix: 'active' + a 20 s model cooldown, so the engine hammers a dead key.
    assert.equal(key.status, 'quota-exceeded', `credit exhaustion must be global: ${body}`);
    assert.ok(key.backoffUntil > Date.now() + QUOTA_RETRY_BASE_MS - 2000,
      `a parked key must carry its retry schedule: ${body}`);
    assert.equal(affinity.isRateLimited('meta/llama-3.1-8b-instruct', id), false,
      'global exhaustion must not also be recorded as a model cooldown');
  }
});

test('DEFECT2-C: explicit RFC7807 credit exhaustion detail outranks a generic rate-limit title', () => {
  const bodies = [
    JSON.stringify({ status: 429, title: 'Too Many Requests', detail: 'Account out of credits. Payment required.' }),
    JSON.stringify({ status: 429, title: 'Too Many Requests', error: { message: 'Credit balance depleted; payment required.' } }),
    'Too Many Requests: account out of credits; payment required',
    'Rate limit response: all free credits have been used'
  ];
  for (const [index, body] of bodies.entries()) {
    affinity.resetAffinityState({ cachePath: null });
    const id = ID(5);
    initializeState({ keys: [{ id, key: `mixed-${index}`, status: 'active', backoffUntil: 0, usage: usage(0) }] });
    handleKeyError(id, 429, body, null, 'mixed/model');
    assert.equal(getKeys()[0].status, 'quota-exceeded', body);
    assert.equal(affinity.isRateLimited('mixed/model', id), false, body);
  }
});

test('DEFECT2-D: request-window quota wording and ambiguous generic 429 remain transient', () => {
  const bodies = [
    JSON.stringify({ status: 429, title: 'Too Many Requests', detail: 'quota of 40 requests per minute exceeded' }),
    JSON.stringify({ status: 429, title: 'Too Many Requests' }),
    'Too Many Requests: quota of 120000 tokens per minute exceeded'
  ];
  for (const [index, body] of bodies.entries()) {
    affinity.resetAffinityState({ cachePath: null });
    const id = ID(6);
    initializeState({ keys: [{ id, key: `transient-${index}`, status: 'active', backoffUntil: 0, usage: usage(0) }] });
    handleKeyError(id, 429, body, null, 'transient/model');
    assert.equal(getKeys()[0].status, 'active', body);
    assert.equal(affinity.isRateLimited('transient/model', id), true, body);
  }
});

// ---------------------------------------------------------------------------
// DEFECT 3 — setKeyStatus validation
// ---------------------------------------------------------------------------

test('DEFECT3: setKeyStatus rejects an out-of-set status instead of making the key invisible', () => {
  const id = ID(4);
  initializeState({ keys: [{ id, key: 'kv', status: 'active', backoffUntil: 0, usage: usage(0) }] });

  const result = setKeyStatus(id, 'quota_exceeded'); // plausible typo, not in STATUSES

  // Pre-fix: true, status becomes 'quota_exceeded', every `status === "active"`
  // filter stops seeing the key and getNextKey returns null -> a 503 while a
  // healthy key exists.
  assert.equal(result, false, 'an invalid status must be rejected');
  assert.equal(getKeys().find((k) => k.id === id).status, 'active', 'the stored status must be untouched');
  const selected = getNextKey();
  assert.ok(selected && selected.id === id, 'the pool must still serve the key (no 503 while healthy)');

  // Valid values still work.
  for (const status of ['disabled', 'quota-exceeded', 'active']) {
    assert.equal(setKeyStatus(id, status), true, `${status} must be accepted`);
    assert.equal(getKeys().find((k) => k.id === id).status, status);
  }
  assert.equal(setKeyStatus(id, ''), false, 'empty string must be rejected');
  assert.equal(setKeyStatus(id, undefined), false, 'undefined must be rejected');
});

test('DEFECT3-B: an admin-parked quota key is not reclaimed on the next request', () => {
  const id = ID(5);
  initializeState({ keys: [{ id, key: 'ka', status: 'active', backoffUntil: 0, usage: usage(0) }] });

  assert.equal(setKeyStatus(id, 'quota-exceeded'), true);
  const selected = getNextKey();

  assert.equal(selected, null, 'an admin decision must survive the reclaim sweep');
  assert.equal(getKeys().find((k) => k.id === id).status, 'quota-exceeded');
});

// ---------------------------------------------------------------------------
// INVARIANTS
// ---------------------------------------------------------------------------

test('INVARIANT: 401 and 403 park the key with a bounded auto-reviving window (never permanently)', () => {
  for (const [statusCode, id] of [[401, ID(7)], [403, ID(8)]]) {
    initializeState({ keys: [{ id, key: 'ka', status: 'active', backoffUntil: 0, usage: usage(0) }] });
    handleKeyError(id, statusCode, 'Unauthorized', null, 'some/model');
    const parked = getKeys().find((k) => k.id === id);
    assert.equal(parked.status, 'disabled', `${statusCode} still takes the key out of rotation`);
    const remaining = parked.backoffUntil - Date.now();
    assert.ok(remaining > 5 * MINUTE, `${statusCode} parks with a real window, got ${remaining}ms`);
    assert.ok(remaining <= 60 * MINUTE + 5_000, `${statusCode} base window is the literal 1 h, got ${remaining}ms`);
    // Inside the window the key stays out of selection.
    assert.equal(getNextKey(), null, 'a parked auth key is excluded while its window runs');
  }
});

test('INVARIANT: an auth-parked key auto-revives when its window elapses — no admin action needed', () => {
  const id = ID(1);
  // Simulate "window elapsed" the way a restart sees it: persisted disabled +
  // past-due backoffUntil + the runtime-park marker the 401 path stamped into
  // the projection. The reclaim sweep must return it to active.
  initializeState({ keys: [{ id, key: 'ka', status: 'disabled', backoffUntil: Date.now() - 1_000, usage: usage(0), parkedReason: 'auth' }] });
  const revived = getNextKey();
  assert.equal(revived?.id, id, 'the reclaim sweep must hand the due key back');
  assert.equal(getKeys()[0].status, 'active', 'revival restores active status');
  assert.equal(getKeys()[0].backoffUntil, 0, 'revival clears the mark');
});

test('auth-reject retries escalate (1h base ladder) and a success resets the ladder', () => {
  const id = ID(1);
  assert.ok(Number.isSafeInteger(AUTH_RETRY_BASE_MS) && AUTH_RETRY_BASE_MS >= 10 * MINUTE, 'base window is at least 10 minutes');
  assert.ok(Number.isSafeInteger(AUTH_RETRY_MAX_MS) && AUTH_RETRY_MAX_MS >= 12 * HOUR, 'ceiling reaches at least 12h');

  // First 401: base window.
  initializeState({ keys: [{ id, key: 'ka', status: 'active', backoffUntil: 0, usage: usage(0) }] });
  handleKeyError(id, 401, 'invalid credential', null, undefined);
  const firstWindow = getKeys()[0].backoffUntil - Date.now();
  assert.ok(firstWindow >= AUTH_RETRY_BASE_MS - 5_000 && firstWindow <= AUTH_RETRY_BASE_MS + 5_000, `first window ≈ base, got ${firstWindow}`);

  // Restart-ish: window elapsed, revive, second 401 escalates.
  initializeState({ keys: [{ id, key: 'ka', status: 'disabled', backoffUntil: Date.now() - 1, usage: usage(0), parkedReason: 'auth' }] });
  getNextKey(); // revive
  handleKeyError(id, 401, 'invalid credential', null, undefined);
  const secondWindow = getKeys()[0].backoffUntil - Date.now();
  assert.ok(secondWindow >= 2 * AUTH_RETRY_BASE_MS - 5_000 && secondWindow <= 2 * AUTH_RETRY_BASE_MS + 5_000,
    `second consecutive rejection escalates to 2x base, got ${secondWindow}`);

  // A success clears the ladder: next 401 parks at the base window again.
  initializeState({ keys: [{ id, key: 'ka', status: 'disabled', backoffUntil: Date.now() - 1, usage: usage(0), parkedReason: 'auth' }] });
  getNextKey();
  markKeyUsedAndDebounceSave(id, { success: true, tokens: 1 });
  handleKeyError(id, 401, 'invalid credential', null, undefined);
  const resetWindow = getKeys()[0].backoffUntil - Date.now();
  assert.ok(resetWindow >= AUTH_RETRY_BASE_MS - 5_000 && resetWindow <= AUTH_RETRY_BASE_MS + 5_000,
    `a success resets the ladder to the base window, got ${resetWindow}`);
});

test('an admin-disabled key is NOT auto-revived by the reclaim sweep', () => {
  const id = ID(1);
  initializeState({ keys: [{ id, key: 'ka', status: 'active', backoffUntil: 0, usage: usage(0) }] });
  setKeyStatus(id, 'disabled');
  const key = getKeys().find((k) => k.id === id);
  assert.equal(key.status, 'disabled');
  assert.equal(key.backoffUntil, 0, 'an admin disable must not carry a runtime reclaim schedule');
  assert.equal(getNextKey(), null, 'the sweep must leave an admin-disabled key alone');
});

test('LEGACY: a persisted disabled key WITHOUT a runtime-park marker is never auto-revived (upgrade compatibility)', () => {
  // Old builds persisted { status:'disabled', backoffUntil: <stale future/past> }
  // for admin disables — there was no marker distinguishing them from the new
  // recoverable 401/403 runtime parks. normalize() must treat a missing marker
  // as admin-authored authority: clear the stale window so the reclaim sweep
  // can never resurrect it.
  const id = ID(7);
  // Variant A: past-due timestamp — naive sweep based on backoffUntil would revive.
  initializeState({ keys: [{ id, key: 'legacy-key', status: 'disabled', backoffUntil: Date.now() - 1_000, usage: usage(0) }] });
  assert.equal(getKeys()[0].backoffUntil, 0, 'normalize forces 0 on a marker-less disabled record');
  assert.equal(getKeys()[0].status, 'disabled');
  assert.equal(getNextKey(), null, 'no marker: the sweep must not revive');

  // Variant B: a STALE FUTURE timestamp from before the upgrade — same story.
  initializeState({ keys: [{ id, key: 'legacy-key', status: 'disabled', backoffUntil: Date.now() + 60_000, usage: usage(0) }] });
  assert.equal(getKeys()[0].backoffUntil, 0, 'a legacy future window is dropped (defense in depth)');
});

test('a runtime 401 park carries parkedReason=auth through the persisted projection and a restart', () => {
  const id = ID(8);
  initializeState({ keys: [{ id, key: 'runtime-key', status: 'active', backoffUntil: 0, usage: usage(0) }] });
  handleKeyError(id, 401, 'invalid credential', null, 'some/model');
  const parked = getKeys().find((k) => k.id === id);
  assert.equal(parked.status, 'disabled');
  assert.equal(parked.parkedReason, 'auth', 'runtime auth park is stamped');

  // What the parent process would persist — round-trip through JSON exactly.
  const persisted = JSON.parse(JSON.stringify(rotation.projectKeyState()));
  assert.equal(persisted.keys[0].parkedReason, 'auth', 'the marker survives the projection');

  // Restart with the window still open: parked, not selected.
  initializeState(persisted);
  assert.equal(getNextKey(), null, 'revival only after the window elapses');

  // Restart with the window elapsed (clock passed the persisted timestamp):
  persisted.keys[0].backoffUntil = Date.now() - 500;
  initializeState(persisted);
  const revived = getNextKey();
  assert.equal(revived?.id, id, 'the marker lets the sweep revive after the window');
  assert.equal(getKeys()[0].status, 'active');
  assert.equal(getKeys()[0].backoffUntil, 0);
});

test('an admin disable after a runtime park clears the marker and stays parked forever', () => {
  const id = ID(8);
  initializeState({ keys: [{ id, key: 'admin-after-runtime', status: 'active', backoffUntil: 0, usage: usage(0) }] });
  handleKeyError(id, 401, 'invalid credential', null, undefined);
  assert.equal(getKeys()[0].parkedReason, 'auth');

  assert.equal(setKeyStatus(id, 'disabled'), true);
  const after = getKeys()[0];
  assert.equal(after.status, 'disabled');
  assert.equal(after.parkedReason ?? null, null, 'admin disable removes the runtime-park marker');
  assert.equal(after.backoffUntil, 0);
  assert.equal(getNextKey(), null, 'admin-disabled keys never self-revive');

  // Marker validation is an ENUM: junk must be dropped, never trusted.
  initializeState({ keys: [{ id, key: 'admin-after-runtime', status: 'disabled', backoffUntil: Date.now() + 60_000, usage: usage(0), parkedReason: 'quota' }] });
  assert.equal(getKeys()[0].parkedReason ?? null, null, 'an out-of-enum marker is dropped on load');
  assert.equal(getKeys()[0].backoffUntil, 0, 'and the stale window along with it');
});

test('a restart keeps circular LRU order and past-due cooldowns from downtime are immediately usable', () => {
  // Everything the child persisted while it shut down: LRU in usage.lastUsed and
  // cooldowns as wall-clock timestamps. After "restart" (re-initialize), expired
  // marks must be instantly usable and the circular order preserved.
  const past = Date.now() - 60_000;
  initializeState({
    keys: [
      { id: ID(1), key: 'a', status: 'active', backoffUntil: past, usage: usage(100) },
      { id: ID(2), key: 'b', status: 'active', backoffUntil: 0, usage: usage(200) },
      { id: ID(3), key: 'c', status: 'quota-exceeded', backoffUntil: past, usage: usage(300) },
      // Runtime-parked before the restart: stamped marker + elapsed window.
      { id: ID(4), key: 'd', status: 'disabled', backoffUntil: past, usage: usage(400), parkedReason: 'auth' }
    ]
  });
  assert.deepEqual(
    [getNextKey().id, getNextKey().id, getNextKey().id, getNextKey().id],
    [ID(1), ID(2), ID(3), ID(4)],
    'circular order follows persisted lastUsed; expired cooldowns (any status) never block a restart'
  );
  for (const id of [ID(1), ID(2), ID(3), ID(4)]) {
    assert.equal(getKeys().find((k) => k.id === id).status, 'active', `${id} is active after the restart sweep`);
  }
});

test('INVARIANT: 429 without a model, and any 5xx, take the global backoff', () => {
  const id = ID(1);
  for (const [statusCode, model] of [[429, undefined], [500, 'm'], [502, 'm'], [504, 'm']]) {
    initializeState({ keys: [{ id, key: 'kg', status: 'active', backoffUntil: 0, usage: usage(0) }] });
    const before = Date.now();
    handleKeyError(id, statusCode, 'rate limit / upstream fault', null, model);
    const key = getKeys().find((k) => k.id === id);
    assert.equal(key.status, 'active', `${statusCode} must not change status`);
    assert.ok(key.backoffUntil > before, `${statusCode} must write a global backoff`);
  }
});

test('INVARIANT: getNextKey() with no model is the pool-wide LRU on usage.lastUsed', () => {
  const now = Date.now();
  initializeState({
    keys: [
      { id: ID(1), key: 'a', status: 'active', backoffUntil: 0, usage: usage(now - 100) },
      { id: ID(2), key: 'b', status: 'active', backoffUntil: 0, usage: usage(now - 300) },
      { id: ID(3), key: 'c', status: 'active', backoffUntil: 0, usage: usage(now - 200) }
    ]
  });
  // Least-recently-used first: b (-300), then c (-200), then a (-100).
  assert.deepEqual([getNextKey().id, getNextKey().id, getNextKey().id], [ID(2), ID(3), ID(1)]);
});

test('INVARIANT: a model-scoped miss falls through to the pool, never an empty pool', () => {
  const now = Date.now();
  const model = 'meta/llama-3.1-70b-instruct';
  initializeState({
    keys: [
      { id: ID(1), key: 'a', status: 'active', backoffUntil: 0, usage: usage(now - 100) },
      { id: ID(2), key: 'b', status: 'active', backoffUntil: 0, usage: usage(now - 200) }
    ]
  });
  // Both keys are cooling down for THIS model.
  affinity.markRateLimited(model, ID(1), { cooldownMs: 20_000 });
  affinity.markRateLimited(model, ID(2), { cooldownMs: 20_000 });

  const selected = getNextKey(model);
  assert.ok(selected, 'a model-scoped cooldown must never be reported as an empty pool');
});

test('INVARIANT: getNextKey stays fully synchronous (the `locked` guard depends on it)', () => {
  initializeState({ keys: [{ id: ID(1), key: 'a', status: 'active', backoffUntil: 0, usage: usage(0) }] });
  const selected = getNextKey();
  assert.ok(selected && !(selected instanceof Promise), 'getNextKey must return a key, not a thenable');
  assert.notEqual(Object.getPrototypeOf(getNextKey).constructor.name, 'AsyncFunction');

  // BEHAVIOURAL pin on the `locked` guard, which returns null — the empty-pool
  // signal that feeds the 503 path. If any await were introduced inside the lock
  // (in getNextKey OR in a helper it calls), the finally would not have run yet
  // and this immediate second call would come back null. Two back-to-back calls
  // both returning a key is what proves the lock released synchronously.
  const again = getNextKey();
  assert.ok(again, 'the re-entrancy lock must already be released when getNextKey returns');

  // Secondary, textual: covers getNextKey's own body only (a helper's body is not
  // visible here — the assertion above is what actually guards the helpers).
  assert.equal(/\bawait\b/.test(getNextKey.toString()), false,
    'no await may appear inside getNextKey: the re-entrancy lock releases in a synchronous finally');
});
