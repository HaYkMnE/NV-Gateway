// Owner rule: automatic penalties are temporary; ONLY an admin disable is
// permanent. A request already in flight when the admin disables a key must
// not, on its late upstream verdict, move that key into a runtime park that
// the sweep later revives. Legacy disabled keys (no provenance) are equally
// "disabled until an admin acts". Auth-parked keys keep their escalation.
// Fake keys only; no network.

process.env.NGC_CATALOG_SYNC_DISABLE_WARM = '1';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-disable-sticky-'));
process.env.GATEWAY_LOG_PATH = path.join(tmpDir, 'gateway.jsonl');
process.env.GATEWAY_STATE_PATH = path.join(tmpDir, 'gateway-state.json');
process.env.GATEWAY_MODEL_AFFINITY_CACHE_PATH = path.join(tmpDir, 'affinity.json');

const rotation = await import(pathToFileURL(path.join(root, 'src/gateway/rotation.mjs')).href);
const logger = await import(pathToFileURL(path.join(root, 'src/gateway/logger.mjs')).href);
const { initializeState, getKeys, handleKeyError, setKeyStatus, setPersistenceAdapter,
  reclaimDueParkedKeys, markKeyUsedAndDebounceSave, closeStateWatcher,
  getCurrentEligibleKeyIds, getModelEligibleKeyCount } = rotation;
const B = '22222222-2222-4222-8222-222222222222';
const countLogs = (message) => logger.getRecentLogs().filter((entry) => entry.message === message).length;

const A = '11111111-1111-4111-8111-111111111111';
const usage = () => ({ success: 0, fail: 0, tokens: 0, lastUsed: 0 });
const rec = (extra = {}) => ({ id: A, key: 'fake-sticky-key-aaaaaaaaaa', status: 'active', backoffUntil: 0, usage: usage(), ...extra });
const QUOTA_BODY = JSON.stringify({ error: { message: 'Your free credits have been used up' } });
const DAY_PLUS = 25 * 60 * 60 * 1000;
const find = () => getKeys().find((k) => k.id === A);

setPersistenceAdapter(() => {});
test.after(() => { closeStateWatcher(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

function adminDisabled() {
  initializeState({ keys: [rec()] });
  assert.equal(setKeyStatus(A, 'disabled'), true);
  assert.equal(find().disabledBy, 'admin');
}

function assertStillAdminDisabled() {
  const key = find();
  assert.equal(key.status, 'disabled');
  assert.equal(key.disabledBy, 'admin');
  assert.equal(key.parkedReason, undefined);
  assert.equal(key.backoffUntil, 0);
}

function lateErrorThenSweep(statusCode, body = '') {
  const failBefore = find().usage.fail;
  handleKeyError(A, statusCode, body, null, 'fake/model');
  assertStillAdminDisabled();
  assert.equal(find().usage.fail, failBefore + 1, 'failure is still counted');
  reclaimDueParkedKeys(Date.now() + DAY_PLUS);
  assertStillAdminDisabled();
}

test('(1) late quota 429 on an admin-disabled key keeps it disabled through the sweep', () => {
  adminDisabled();
  lateErrorThenSweep(429, QUOTA_BODY);
});

test('(2) late 401 and 403 on an admin-disabled key keep it disabled through the sweep', () => {
  adminDisabled();
  lateErrorThenSweep(401);
  adminDisabled();
  lateErrorThenSweep(403);
});

test('(3) late 500/502 on an admin-disabled key leave status and backoff unchanged', () => {
  adminDisabled();
  lateErrorThenSweep(500);
  lateErrorThenSweep(502);
});

test('(4) a late success on an admin-disabled key does not change its status', () => {
  adminDisabled();
  markKeyUsedAndDebounceSave(A, { success: true, tokens: 5 });
  assertStillAdminDisabled();
  assert.equal(find().usage.success, 1);
  reclaimDueParkedKeys(Date.now() + DAY_PLUS);
  assertStillAdminDisabled();
});

test('(5) a late 401 on a legacy-disabled key keeps it disabled and legacy', () => {
  initializeState({ keys: [rec({ status: 'disabled' })] });
  assert.equal(find().legacyDisabled, true);
  handleKeyError(A, 401, '', null, 'fake/model');
  const key = find();
  assert.equal(key.status, 'disabled');
  assert.equal(key.legacyDisabled, true);
  assert.equal(key.parkedReason, undefined);
  assert.equal(key.backoffUntil, 0);
  reclaimDueParkedKeys(Date.now() + DAY_PLUS);
  assert.equal(find().status, 'disabled');
  assert.equal(find().legacyDisabled, true);
});

test('(6) control: an auth-parked key escalates on another 401 (ladder doubles)', () => {
  initializeState({ keys: [rec()] });
  let t0 = Date.now();
  handleKeyError(A, 401, '', null, 'fake/model');
  const first = find().backoffUntil - t0;
  assert.equal(find().status, 'disabled');
  assert.equal(find().parkedReason, 'auth');
  t0 = Date.now();
  handleKeyError(A, 401, '', null, 'fake/model');
  const second = find().backoffUntil - t0;
  assert.equal(find().parkedReason, 'auth');
  assert.ok(Math.abs(second - 2 * first) < 1000, `expected ~2x window, got ${first} -> ${second}`);
});

test('(7) control: an active key parks as quota-exceeded on a quota 429', () => {
  initializeState({ keys: [rec()] });
  handleKeyError(A, 429, QUOTA_BODY, null, 'fake/model');
  assert.equal(find().status, 'quota-exceeded');
  assert.ok(find().backoffUntil > Date.now());
});

test('(N1) an admin-held 5xx never logs "backing off"; a held line is logged instead', () => {
  adminDisabled();
  const before = countLogs('Upstream error, backing off');
  const heldBefore = countLogs('Upstream error on admin-disabled key; no backoff (held)');
  handleKeyError(A, 502, '', null, 'fake/model');
  assert.equal(countLogs('Upstream error, backing off'), before, 'no false backoff claim');
  assert.equal(countLogs('Upstream error on admin-disabled key; no backoff (held)'), heldBefore + 1);
  // Control: an active key still logs the real backoff.
  initializeState({ keys: [rec()] });
  handleKeyError(A, 502, '', null, 'fake/model');
  assert.equal(countLogs('Upstream error, backing off'), before + 1);
});

test('(N2) a late model-scoped 429 on an admin-held key leaves no stale block after re-enable', () => {
  const model = 'fake/n2-model';
  initializeState({ keys: [rec(), { ...rec(), id: B, key: 'fake-sticky-key-bbbbbbbbbb' }] });
  assert.equal(setKeyStatus(A, 'disabled'), true);
  handleKeyError(A, 429, 'rate limit exceeded', 60, model);
  assertStillAdminDisabled();
  assert.equal(setKeyStatus(A, 'active'), true);
  assert.equal(getModelEligibleKeyCount(model), 2, 'A is model-eligible right after re-enable');
  assert.ok(getCurrentEligibleKeyIds(model).includes(A), 'A is selectable for the model');
});
