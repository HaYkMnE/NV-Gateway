import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-affinity-${process.pid}-`)));
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

const affinityUrl = pathToFileURL(path.join(root, 'src/gateway/model-key-affinity.mjs')).href;

/** Fresh module instance so module-level state never leaks between tests. */
async function loadAffinity() {
  return import(`${affinityUrl}?t=${Date.now()}-${Math.random()}`);
}

function keyPool(ids) {
  return ids.map((id, index) => ({ id, status: 'active', backoffUntil: 0, usage: { lastUsed: index + 1 } }));
}

const KEY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

test('affinity exposes a 15 minute TTL as a named constant', async () => {
  const affinity = await loadAffinity();
  assert.equal(affinity.AFFINITY_TTL_MS, 15 * 60 * 1000);
});

test('a model sticks to the key it was assigned on the previous request', async () => {
  const affinity = await loadAffinity();
  affinity.resetAffinityState({ cachePath: null });
  const keys = keyPool([KEY_A, KEY_B, KEY_C]);

  const first = affinity.selectKeyForModel('deepseek-ai/deepseek-v3', keys, { now: 1_000 });
  assert.ok(first, 'a key must be selected');
  affinity.recordAssignment('deepseek-ai/deepseek-v3', first.id, { now: 1_000 });

  // Second request for the SAME model must reuse the SAME key, even though the
  // global LRU order would now prefer a different (less recently used) key.
  const second = affinity.selectKeyForModel('deepseek-ai/deepseek-v3', keys, { now: 2_000 });
  assert.equal(second.id, first.id, 'the model must stay sticky on its assigned key');
});

test('a 429 cooldown is scoped to (model, key) and leaves the key usable by other models', async () => {
  const affinity = await loadAffinity();
  affinity.resetAffinityState({ cachePath: null });
  const keys = keyPool([KEY_A, KEY_B, KEY_C]);

  affinity.markRateLimited('modelA', KEY_A, { now: 1_000, cooldownMs: 20_000 });

  assert.equal(affinity.isRateLimited('modelA', KEY_A, { now: 5_000 }), true,
    'the rate-limited pair must be in cooldown');
  assert.equal(affinity.isRateLimited('modelB', KEY_A, { now: 5_000 }), false,
    'the SAME key must remain healthy for a DIFFERENT model');

  const eligibleA = affinity.getEligibleKeys('modelA', keys, { now: 5_000 }).map((k) => k.id);
  const eligibleB = affinity.getEligibleKeys('modelB', keys, { now: 5_000 }).map((k) => k.id);
  assert.ok(!eligibleA.includes(KEY_A), 'cooling key is not eligible for the model that hit the limit');
  assert.ok(eligibleB.includes(KEY_A), 'cooling key IS still eligible for every other model');
});

test('a model-scoped cooldown expires after its own window', async () => {
  const affinity = await loadAffinity();
  affinity.resetAffinityState({ cachePath: null });
  affinity.markRateLimited('modelA', KEY_A, { now: 1_000, cooldownMs: 20_000 });
  assert.equal(affinity.isRateLimited('modelA', KEY_A, { now: 20_999 }), true);
  assert.equal(affinity.isRateLimited('modelA', KEY_A, { now: 21_001 }), false,
    'cooldown must lapse once its window passes');
});

test('three concurrently active models are spread across three DIFFERENT keys', async () => {
  const affinity = await loadAffinity();
  affinity.resetAffinityState({ cachePath: null });
  const keys = keyPool([KEY_A, KEY_B, KEY_C]);
  const models = ['deepseek-ai/deepseek-v3', 'moonshotai/kimi-k2', 'minimaxai/minimax-m2'];

  const assigned = [];
  let clock = 1_000;
  for (const model of models) {
    const key = affinity.selectKeyForModel(model, keys, { now: clock });
    assert.ok(key, `a key must be selected for ${model}`);
    affinity.recordAssignment(model, key.id, { now: clock });
    assigned.push(key.id);
    clock += 10;
  }

  assert.equal(new Set(assigned).size, 3,
    `3 active models must sit on 3 distinct keys, got ${JSON.stringify(assigned)}`);
});

test('assignment memory decays after AFFINITY_TTL_MS so a stale model releases its key', async () => {
  const affinity = await loadAffinity();
  affinity.resetAffinityState({ cachePath: null });
  const keys = keyPool([KEY_A, KEY_B]);

  affinity.recordAssignment('stale-model', KEY_A, { now: 1_000 });
  assert.equal(affinity.getAssignedKeyId('stale-model', { now: 1_000 + affinity.AFFINITY_TTL_MS - 1 }), KEY_A,
    'inside the TTL the assignment still holds');
  assert.equal(affinity.getAssignedKeyId('stale-model', { now: 1_000 + affinity.AFFINITY_TTL_MS + 1 }), null,
    'past the TTL the assignment must be forgotten');

  // A stale holder must not reserve the key against a fresh model.
  const freshNow = 1_000 + affinity.AFFINITY_TTL_MS + 1;
  affinity.recordAssignment('busy-model', KEY_B, { now: freshNow });
  const picked = affinity.selectKeyForModel('new-model', keys, { now: freshNow });
  assert.equal(picked.id, KEY_A, 'the key released by the decayed assignment is preferred over a live holder');
});

test('pruneExpired drops decayed assignments and lapsed cooldowns', async () => {
  const affinity = await loadAffinity();
  affinity.resetAffinityState({ cachePath: null });
  affinity.recordAssignment('m1', KEY_A, { now: 1_000 });
  affinity.markRateLimited('m1', KEY_B, { now: 1_000, cooldownMs: 5_000 });

  const snapshotBefore = affinity.snapshotAffinity();
  assert.equal(Object.keys(snapshotBefore.assignments).length, 1);
  assert.equal(Object.keys(snapshotBefore.cooldowns).length, 1);

  affinity.pruneExpired({ now: 1_000 + affinity.AFFINITY_TTL_MS + 1 });
  const snapshotAfter = affinity.snapshotAffinity();
  assert.deepEqual(snapshotAfter.assignments, {}, 'decayed assignments are dropped');
  assert.deepEqual(snapshotAfter.cooldowns, {}, 'lapsed cooldowns are dropped');
});

test('affinity map round-trips through its JSON cache and stores no key material', async () => {
  const cachePath = path.join(tempRoot, 'round-trip', 'model-key-affinity.json');
  const writer = await loadAffinity();
  writer.resetAffinityState({ cachePath });
  writer.recordAssignment('deepseek-ai/deepseek-v3', KEY_A, { now: 1_000 });
  writer.markRateLimited('deepseek-ai/deepseek-v3', KEY_B, { now: 1_000, cooldownMs: 60_000 });
  writer.persistAffinity();

  const raw = fs.readFileSync(cachePath, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, writer.AFFINITY_CACHE_FORMAT_VERSION, 'payload carries its format version');
  assert.match(raw, /deepseek-ai\/deepseek-v3/, 'model ids are persisted');
  assert.match(raw, new RegExp(KEY_A), 'key UUIDs are persisted');
  // Only ids/uuids/timestamps — never secret material.
  assert.ok(!/nvapi-/i.test(raw), 'no upstream key material may be written');
  assert.ok(!/"key"\s*:/.test(raw), 'no verbatim key field may be written');

  // A separate module instance (a process restart) must read the map back.
  const reader = await loadAffinity();
  reader.resetAffinityState({ cachePath });
  assert.equal(reader.getAssignedKeyId('deepseek-ai/deepseek-v3', { now: 2_000 }), KEY_A,
    'the sticky assignment survives a restart');
  assert.equal(reader.isRateLimited('deepseek-ai/deepseek-v3', KEY_B, { now: 2_000 }), true,
    'the model-scoped cooldown survives a restart');
});

test('a corrupt, empty, absent or wrong-version cache file degrades to an empty map without throwing', async () => {
  const dir = path.join(tempRoot, 'corrupt');
  fs.mkdirSync(dir, { recursive: true });

  const cases = {
    'corrupt.json': '{ this is not json',
    'empty.json': '',
    'array.json': '[]',
    'future.json': JSON.stringify({ version: 999, assignments: { m: { keyId: KEY_A, at: 1 } } }),
    'garbage-entries.json': JSON.stringify({ version: 1, assignments: { m: 'not-an-object' }, cooldowns: 42 })
  };
  for (const [name, contents] of Object.entries(cases)) {
    fs.writeFileSync(path.join(dir, name), contents, 'utf8');
    const affinity = await loadAffinity();
    assert.doesNotThrow(() => affinity.resetAffinityState({ cachePath: path.join(dir, name) }),
      `${name} must not throw on load`);
    assert.deepEqual(affinity.snapshotAffinity().assignments, {}, `${name} yields an empty map`);
    assert.equal(affinity.getAssignedKeyId('m', { now: 2 }), null, `${name} exposes no assignment`);
  }

  const absent = await loadAffinity();
  assert.doesNotThrow(() => absent.resetAffinityState({ cachePath: path.join(dir, 'does-not-exist.json') }));
  assert.deepEqual(absent.snapshotAffinity().assignments, {});
});

test('selection never returns a key that is globally unavailable', async () => {
  const affinity = await loadAffinity();
  affinity.resetAffinityState({ cachePath: null });
  const keys = [
    { id: KEY_A, status: 'disabled', backoffUntil: 0, usage: { lastUsed: 1 } },
    { id: KEY_B, status: 'active', backoffUntil: 0, usage: { lastUsed: 2 } }
  ];
  // Even a sticky assignment must not resurrect a disabled key.
  affinity.recordAssignment('m', KEY_A, { now: 1_000 });
  const picked = affinity.selectKeyForModel('m', keys, { now: 1_100 });
  assert.equal(picked.id, KEY_B, 'a disabled key is never selected, sticky or not');
});

test('selectKeyForModel returns null when every candidate is cooling for this model', async () => {
  const affinity = await loadAffinity();
  affinity.resetAffinityState({ cachePath: null });
  const keys = keyPool([KEY_A, KEY_B]);
  affinity.markRateLimited('m', KEY_A, { now: 1_000, cooldownMs: 20_000 });
  affinity.markRateLimited('m', KEY_B, { now: 1_000, cooldownMs: 20_000 });
  assert.equal(affinity.selectKeyForModel('m', keys, { now: 2_000 }), null,
    'no eligible key for this model yields null so the caller can fall back');
});

test('affinity helpers ignore a missing/blank model id instead of inventing an entry', async () => {
  const affinity = await loadAffinity();
  affinity.resetAffinityState({ cachePath: null });
  const keys = keyPool([KEY_A]);
  assert.equal(affinity.selectKeyForModel(undefined, keys, { now: 1 }), null);
  assert.equal(affinity.selectKeyForModel('', keys, { now: 1 }), null);
  affinity.recordAssignment(undefined, KEY_A, { now: 1 });
  affinity.markRateLimited('', KEY_A, { now: 1 });
  assert.deepEqual(affinity.snapshotAffinity().assignments, {}, 'no entry is created for a blank model id');
  assert.equal(affinity.isRateLimited(undefined, KEY_A, { now: 1 }), false);
});
