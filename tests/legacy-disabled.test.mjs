// Owner decision 2a: keys an OLD version disabled permanently after a 401/403
// carry no provenance, so they are NOT auto-migrated. The child flags them
// in memory (legacyDisabled), warns once with a count, and never persists the
// flag. Admin disables carry disabledBy:"admin" so they stop looking legacy.
// Fake keys only; loopback admin server on an ephemeral port.

process.env.NGC_CATALOG_SYNC_DISABLE_WARM = '1';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-disabled-'));
process.env.GATEWAY_LOG_PATH = path.join(tmpDir, 'gateway.jsonl');
process.env.GATEWAY_STATE_PATH = path.join(tmpDir, 'gateway-state.json');
process.env.GATEWAY_MODEL_AFFINITY_CACHE_PATH = path.join(tmpDir, 'affinity.json');

const rotation = await import(pathToFileURL(path.join(root, 'src/gateway/rotation.mjs')).href);
const logger = await import(pathToFileURL(path.join(root, 'src/gateway/logger.mjs')).href);
const { initializeState, getKeys, getNextKey, handleKeyError, setKeyStatus, setKeyStatusDurably,
  setPersistenceAdapter, projectKeyState, reclaimDueParkedKeys, closeStateWatcher } = rotation;

const WARNING = 'Disabled keys without provenance (possibly an old auth failure; re-enable manually)';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const usage = () => ({ success: 0, fail: 0, tokens: 0, lastUsed: 0 });
const rec = (id, key, extra = {}) => ({ id, key, status: 'active', backoffUntil: 0, usage: usage(), ...extra });
const legacy = (id, key) => rec(id, key, { status: 'disabled' });
const warnings = () => logger.getRecentLogs().filter((entry) => entry.message === WARNING);
const reload = () => initializeState(JSON.parse(JSON.stringify(projectKeyState())));
const find = (id) => getKeys().find((k) => k.id === id);
const projected = (id) => projectKeyState().keys.find((k) => k.id === id);

setPersistenceAdapter(() => {});

test.after(() => {
  closeStateWatcher();
  logger.closeLogger?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('(a) a disabled record without provenance loads as legacy, warns once with a count, and is not selectable', () => {
  const before = warnings().length;
  initializeState({ keys: [legacy(A, 'fake-legacy-key-aaaaaaaaaaaa'), legacy(B, 'fake-legacy-key-bbbbbbbbbbbb')] });
  assert.equal(find(A).legacyDisabled, true);
  assert.equal(find(B).legacyDisabled, true);
  const emitted = warnings().slice(before);
  assert.equal(emitted.length, 1, 'exactly one warning per load');
  assert.equal(emitted[0].count, 2);
  assert.equal(emitted[0].level, 'warn');
  assert.equal(JSON.stringify(emitted[0]).includes('fake-legacy-key'), false, 'no key material in the warning');
  assert.equal(JSON.stringify(emitted[0]).includes(A), false, 'no ids in the warning');
  assert.equal(getNextKey(), null, 'legacy-disabled keys stay out of selection');
});

test('(a2) auth-parked and admin-marked disabled records are not legacy; foreign disabledBy values are dropped', () => {
  const before = warnings().length;
  initializeState({ keys: [
    rec(A, 'fake-auth-parked-key-aaaaaa', { status: 'disabled', parkedReason: 'auth', backoffUntil: Date.now() + 60_000 }),
    rec(B, 'fake-admin-disabled-key-bbbb', { status: 'disabled', disabledBy: 'admin' })
  ] });
  assert.equal(find(A).legacyDisabled, undefined);
  assert.equal(find(B).legacyDisabled, undefined);
  assert.equal(find(B).disabledBy, 'admin');
  assert.equal(warnings().length, before, 'no warning when nothing is legacy');
  initializeState({ keys: [rec(A, 'fake-foreign-marker-key-aaaa', { status: 'disabled', disabledBy: 'x' })] });
  assert.equal(find(A).disabledBy, undefined, 'only "admin" is accepted');
  assert.equal(find(A).legacyDisabled, true);
  assert.equal(projected(A).disabledBy, undefined);
});

test('(b) admin disable persists disabledBy "admin" and reloads without a legacy flag or warning', async () => {
  initializeState({ keys: [rec(A, 'fake-admin-key-aaaaaaaaaaaa'), rec(B, 'fake-admin-key-bbbbbbbbbbbb')] });
  assert.equal(setKeyStatus(A, 'disabled'), true);
  assert.equal(await setKeyStatusDurably(B, 'disabled'), true);
  for (const id of [A, B]) {
    assert.equal(projected(id).disabledBy, 'admin');
    assert.equal(find(id).legacyDisabled, undefined);
  }
  const before = warnings().length;
  reload();
  for (const id of [A, B]) {
    assert.equal(find(id).disabledBy, 'admin');
    assert.equal(find(id).legacyDisabled, undefined);
  }
  assert.equal(warnings().length, before);
});

test('(c) re-enable (active or manual quota-exceeded) removes disabledBy and reloads as not legacy', async () => {
  initializeState({ keys: [rec(A, 'fake-reenable-key-aaaaaaaaa', { status: 'disabled', disabledBy: 'admin' }),
    rec(B, 'fake-reenable-key-bbbbbbbbb', { status: 'disabled', disabledBy: 'admin' })] });
  assert.equal(setKeyStatus(A, 'active'), true);
  assert.equal(await setKeyStatusDurably(B, 'quota-exceeded'), true);
  assert.equal(Object.hasOwn(projected(A), 'disabledBy'), false);
  assert.equal(Object.hasOwn(projected(B), 'disabledBy'), false);
  reload();
  assert.equal(find(A).legacyDisabled, undefined);
  assert.equal(find(B).legacyDisabled, undefined);
  // Admin action on a LEGACY key clears the flag and sets provenance per status.
  initializeState({ keys: [legacy(A, 'fake-legacy-admin-key-aaaaa'), legacy(B, 'fake-legacy-admin-key-bbbbb')] });
  assert.equal(setKeyStatus(A, 'disabled'), true);
  assert.equal(await setKeyStatusDurably(B, 'active'), true);
  assert.equal(find(A).legacyDisabled, undefined);
  assert.equal(find(A).disabledBy, 'admin');
  assert.equal(find(B).legacyDisabled, undefined);
  assert.equal(find(B).disabledBy, undefined);
});

test('(d) a legacy key stays legacy across save + reload and legacyDisabled is never persisted', () => {
  initializeState({ keys: [legacy(A, 'fake-survivor-key-aaaaaaaaa')] });
  for (let round = 0; round < 3; round += 1) {
    const projection = projectKeyState();
    assert.equal(JSON.stringify(projection).includes('legacyDisabled'), false);
    assert.equal(Object.hasOwn(projection.keys[0], 'disabledBy'), false);
    reload();
    assert.equal(find(A).legacyDisabled, true, `still legacy after reload #${round + 1}`);
  }
});

test('(e) a late auth verdict keeps admin/legacy disables; sweep revive clears disabledBy', () => {
  initializeState({ keys: [rec(A, 'fake-park-key-aaaaaaaaaaaaa', { status: 'disabled', disabledBy: 'admin' })] });
  handleKeyError(A, 401, 'invalid credential', null, undefined);
  assert.equal(find(A).parkedReason, undefined, 'admin disable is never auth-parked');
  assert.equal(find(A).disabledBy, 'admin', 'admin provenance survives a late 401');
  assert.equal(projected(A).disabledBy, 'admin');
  initializeState({ keys: [legacy(A, 'fake-park-key-legacy-aaaaaa')] });
  handleKeyError(A, 403, 'forbidden', null, undefined);
  assert.equal(find(A).legacyDisabled, true, 'legacy disable survives a late 403');
  assert.equal(find(A).parkedReason, undefined);
  const now = Date.now();
  initializeState({ keys: [rec(A, 'fake-revive-key-aaaaaaaaaaa', { status: 'disabled', parkedReason: 'auth', disabledBy: 'admin', backoffUntil: now - 1 })] });
  reclaimDueParkedKeys(now);
  assert.equal(find(A).status, 'active');
  assert.equal(find(A).disabledBy, undefined, 'sweep revive clears disabledBy');
  assert.equal(Object.hasOwn(projected(A), 'disabledBy'), false);
});

test('(f) a failed durable persist rolls disabledBy (and the legacy flag) back exactly', async () => {
  const failed = (err) => err?.code === 'KEY_PERSISTENCE_FAILED';
  initializeState({ keys: [rec(A, 'fake-rollback-key-aaaaaaaaa', { status: 'disabled', disabledBy: 'admin' }), legacy(B, 'fake-rollback-key-bbbbbbbbb')] });
  setPersistenceAdapter((_p, context) => (context?.durable ? Promise.reject(new Error('simulated disk failure')) : undefined));
  try {
    await assert.rejects(setKeyStatusDurably(A, 'active'), failed);
    await assert.rejects(setKeyStatusDurably(B, 'disabled'), failed);
  } finally { setPersistenceAdapter(() => {}); }
  assert.equal(find(A).status, 'disabled');
  assert.equal(find(A).disabledBy, 'admin');
  assert.equal(projected(A).disabledBy, 'admin');
  assert.equal(find(B).status, 'disabled');
  assert.equal(find(B).disabledBy, undefined);
  assert.equal(find(B).legacyDisabled, true);
});

test('(i) a late quota-429 keeps an admin disable; the quota revive clears a stale disabledBy', () => {
  initializeState({ keys: [rec(A, 'fake-quota-key-aaaaaaaaaaaa')] });
  assert.equal(setKeyStatus(A, 'disabled'), true);
  assert.equal(projected(A).disabledBy, 'admin');
  // A request that started before the admin disable comes back as exhausted credits.
  handleKeyError(A, 429, 'Your credit balance is insufficient; all free credits have been used.', null);
  assert.equal(find(A).status, 'disabled', 'late quota verdict does not park an admin-disabled key');
  assert.equal(projected(A).disabledBy, 'admin');
  reclaimDueParkedKeys(Date.now() + 25 * 60 * 60 * 1000);
  assert.equal(find(A).status, 'disabled', 'sweep never revives an admin disable');
  assert.equal(projected(A).disabledBy, 'admin');
  // Revive path on its own: a quota-exceeded record that already carries a stale marker.
  initializeState({ keys: [rec(B, 'fake-quota-key-bbbbbbbbbbbb', { status: 'quota-exceeded', backoffUntil: 1_000, disabledBy: 'admin' })] });
  reclaimDueParkedKeys(2_000);
  assert.equal(find(B).status, 'active');
  assert.equal(Object.hasOwn(projected(B), 'disabledBy'), false, 'quota revive clears a stale disabledBy');
});

test('(h) GET /admin/keys exposes legacyDisabled and never the key value', async () => {
  const adminApi = await import(`${pathToFileURL(path.join(root, 'src/gateway/admin-api.mjs')).href}?legacy=${Date.now()}`);
  const token = 'legacy-admin-token-01';
  const secret = 'nvapi-fake-legacy-key-not-real-0001';
  initializeState({ keys: [legacy(A, secret), rec(B, 'nvapi-fake-admin-key-not-real-0002', { status: 'disabled', disabledBy: 'admin' })] });
  const server = http.createServer(adminApi.createAdminRequestHandler({ adminToken: token }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const body = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/admin/keys', method: 'GET',
        headers: { authorization: `Bearer ${token}` } }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(body.status, 200);
    const parsed = JSON.parse(body.text);
    const legacyKey = parsed.keys.find((k) => k.id === A);
    const adminKey = parsed.keys.find((k) => k.id === B);
    assert.equal(legacyKey.legacyDisabled, true);
    assert.equal(adminKey.legacyDisabled, undefined);
    assert.equal(adminKey.disabledBy, 'admin');
    assert.equal(body.text.includes(secret), false, 'raw key never leaves the admin API');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
