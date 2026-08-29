import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-debounce-${process.pid}-`)));

// rotation.mjs imports logger.mjs, which throws without GATEWAY_LOG_PATH.
process.env.GATEWAY_LOG_PATH = path.join(tempRoot, 'logs', 'gateway.jsonl');

const affinity = await import(pathToFileURL(path.join(root, 'src/gateway/model-key-affinity.mjs')).href);
const rotation = await import(pathToFileURL(path.join(root, 'src/gateway/rotation.mjs')).href);
const logger = await import(pathToFileURL(path.join(root, 'src/gateway/logger.mjs')).href);

// Keep the real key projection off any private IPC channel.
rotation.setPersistenceAdapter(() => {});

test.after(() => {
  rotation.closeStateWatcher();
  logger.closeLogger();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const KEYS = [
  { id: '11111111-1111-4111-8111-111111111111', key: 'key-1', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 1 } },
  { id: '22222222-2222-4222-8222-222222222222', key: 'key-2', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 2 } },
  { id: '33333333-3333-4333-8333-333333333333', key: 'key-3', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 3 } }
];

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * Count real writes of the affinity cache. fs.writeFileSync is resolved at call
 * time off the imported namespace, so swapping it here observes exactly the
 * writes persistAffinity() performs — no behaviour is faked, the write still
 * happens for real.
 */
function countingWriter(cachePath) {
  const real = fs.writeFileSync;
  let writes = 0;
  fs.writeFileSync = function (target, ...rest) {
    if (typeof target === 'string' && target.startsWith(cachePath)) writes++;
    return real.call(this, target, ...rest);
  };
  return { writes: () => writes, restore: () => { fs.writeFileSync = real; } };
}

function freshCache(name, overrides = {}) {
  const cachePath = path.join(tempRoot, name, 'model-key-affinity.json');
  affinity.resetAffinityState({ cachePath, persistDebounceMs: 60, ...overrides });
  return cachePath;
}

test('the debounce window is exported and matches the rotation saveTimer cadence', () => {
  assert.equal(affinity.AFFINITY_PERSIST_DEBOUNCE_MS, 5_000);
});

test('a burst of scheduled persists collapses into exactly ONE disk write', async () => {
  const cachePath = freshCache('coalesce');
  const counter = countingWriter(cachePath);
  try {
    for (let i = 0; i < 25; i++) {
      affinity.markRateLimited(`model-${i % 5}`, `key-${i % 5}`, { cooldownMs: 20_000 });
      affinity.schedulePersistAffinity();
    }
    // THE POINT: nothing touched the disk while the burst was being handled.
    assert.equal(counter.writes(), 0, 'no synchronous write may happen on the hot path');
    const armed = affinity.affinityPersistState();
    assert.equal(armed.pending, true, 'changes are queued');
    assert.equal(armed.timerArmed, true, 'exactly one timer is armed');

    await delay(200);
    assert.equal(counter.writes(), 1, '25 scheduled persists must collapse to a single write');
    const settled = affinity.affinityPersistState();
    assert.equal(settled.pending, false, 'queue is drained after the write');
    assert.equal(settled.timerArmed, false, 'timer is released after firing');
  } finally {
    counter.restore();
  }
});

test('N consecutive model-scoped 429s cause ZERO writes on the hot path and ONE on flush', async () => {
  const cachePath = freshCache('rate-limit-wave');
  rotation.initializeState({ keys: KEYS });
  const counter = countingWriter(cachePath);
  try {
    // A 429 wave: 5 models × 3 keys, the shape that previously issued a
    // synchronous ~163 KB write per failure.
    let calls = 0;
    for (let round = 0; round < 5; round++) {
      for (const record of KEYS) {
        rotation.handleKeyError(record.id, 429, 'rate limit exceeded', null, `model-${round}`);
        calls++;
      }
    }
    assert.equal(calls, 15);
    assert.equal(counter.writes(), 0,
      `${calls} model-scoped 429s must not write synchronously, saw ${counter.writes()} write(s)`);

    // Shutdown lands the queued data through the SAME call site production uses.
    rotation.flushState();
    assert.equal(counter.writes(), 1, 'flushState must land the queued affinity write exactly once');

    // ...and the data on disk is correct and complete.
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(parsed.version, affinity.AFFINITY_CACHE_FORMAT_VERSION);
    assert.equal(Object.keys(parsed.cooldowns).length, 15,
      'every (model, key) cooldown from the wave is persisted');
    for (let round = 0; round < 5; round++) {
      for (const record of KEYS) {
        const entry = parsed.cooldowns[`model-${round}\u0000${record.id}`];
        assert.ok(entry, `cooldown for model-${round} / ${record.id} must be on disk`);
        assert.ok(entry.until > entry.at, 'a persisted cooldown must have a future expiry');
      }
    }
    // Privacy contract survives the debounce change.
    const raw = fs.readFileSync(cachePath, 'utf8');
    for (const record of KEYS) {
      assert.ok(!raw.includes(record.key), 'no upstream key material may be written');
    }
  } finally {
    counter.restore();
  }
});

test('the queued write never holds the process alive (timer is unref\'d)', () => {
  freshCache('unref');
  affinity.markRateLimited('m', 'k', { cooldownMs: 20_000 });
  affinity.schedulePersistAffinity();
  const armed = affinity.affinityPersistState();
  assert.equal(armed.timerArmed, true, 'a timer is armed');
  assert.equal(armed.timerHasRef, false,
    'an armed cache-write timer must be unref\'d so it cannot keep node alive');
  affinity.closeAffinityPersistence();
});

test('flushAffinity with nothing queued does not write or create the file', () => {
  const cachePath = freshCache('no-op-flush');
  const counter = countingWriter(cachePath);
  try {
    affinity.flushAffinity();
    assert.equal(counter.writes(), 0, 'a shutdown that changed nothing must not write');
    assert.equal(fs.existsSync(cachePath), false, 'no cache file is created out of nothing');
  } finally {
    counter.restore();
  }
});

test('closeAffinityPersistence drops the timer WITHOUT writing', async () => {
  const cachePath = freshCache('close-no-write');
  const counter = countingWriter(cachePath);
  try {
    affinity.markRateLimited('m', 'k', { cooldownMs: 20_000 });
    affinity.schedulePersistAffinity();
    affinity.closeAffinityPersistence();
    assert.equal(affinity.affinityPersistState().timerArmed, false, 'timer is dropped');
    await delay(200);
    assert.equal(counter.writes(), 0, 'a dropped timer must never fire a write later');
  } finally {
    counter.restore();
  }
});

test('the immediate persistAffinity path still writes synchronously', () => {
  // The round-trip persistence test depends on this staying available; the
  // debounce is an ADDITIONAL path, not a replacement.
  const cachePath = freshCache('immediate');
  const counter = countingWriter(cachePath);
  try {
    affinity.recordAssignment('deepseek-ai/deepseek-v3', '11111111-1111-4111-8111-111111111111');
    affinity.persistAffinity();
    assert.equal(counter.writes(), 1, 'persistAffinity writes right away');
    assert.equal(fs.existsSync(cachePath), true);
    assert.equal(affinity.affinityPersistState().pending, false, 'an immediate write drains the queue too');
  } finally {
    counter.restore();
  }
});

test('memory-only routing neither writes nor arms a timer', async () => {
  affinity.resetAffinityState({ cachePath: null, persistDebounceMs: 60 });
  const counter = countingWriter(path.join(tempRoot, 'memory-only'));
  try {
    affinity.markRateLimited('m', 'k', { cooldownMs: 20_000 });
    affinity.schedulePersistAffinity();
    assert.equal(affinity.affinityPersistState().timerArmed, false,
      'with no cache path there is nothing to write, so no timer is armed');
    await delay(150);
    assert.equal(counter.writes(), 0);
  } finally {
    counter.restore();
  }
});

test('resetAffinityState drops a queued write instead of flushing stale state', async () => {
  const cachePath = freshCache('reset-drops');
  const counter = countingWriter(cachePath);
  try {
    affinity.markRateLimited('doomed-model', 'k', { cooldownMs: 20_000 });
    affinity.schedulePersistAffinity();
    affinity.resetAffinityState({ cachePath, persistDebounceMs: 60 });
    assert.equal(affinity.affinityPersistState().pending, false, 'the queue is discarded with the state');
    await delay(200);
    assert.equal(counter.writes(), 0, 'a reset must not later persist discarded state');
  } finally {
    counter.restore();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Routing semantics must be untouched by the debounce change: only the
// model-scoped 429 branch schedules an affinity write.
// ───────────────────────────────────────────────────────────────────────────

test('only the model-scoped 429 branch queues an affinity write', () => {
  const [first, second, third] = KEYS.map((k) => k.id);

  const cases = [
    {
      what: '401 disables the key globally',
      run: () => rotation.handleKeyError(first, 401, 'unauthorized', null, 'm'),
      expect: () => assert.equal(rotation.getKeys().find((k) => k.id === first).status, 'disabled')
    },
    {
      what: '429 + quota marks quota-exceeded globally',
      run: () => rotation.handleKeyError(second, 429, 'quota exceeded for this account', null, 'm'),
      expect: () => assert.equal(rotation.getKeys().find((k) => k.id === second).status, 'quota-exceeded')
    },
    {
      what: '5xx keeps the short GLOBAL backoff',
      run: () => rotation.handleKeyError(third, 503, 'service unavailable', null, 'm'),
      expect: () => assert.ok(rotation.getKeys().find((k) => k.id === third).backoffUntil > Date.now())
    },
    {
      what: '429 WITHOUT a model id keeps the historical global cooldown',
      run: () => rotation.handleKeyError(third, 429, 'rate limit', null, undefined),
      expect: () => assert.ok(rotation.getKeys().find((k) => k.id === third).backoffUntil > Date.now())
    }
  ];

  for (const scenario of cases) {
    const cachePath = freshCache(`semantics-${cases.indexOf(scenario)}`);
    rotation.initializeState({ keys: structuredClone(KEYS) });
    const counter = countingWriter(cachePath);
    try {
      scenario.run();
      scenario.expect();
      assert.equal(affinity.affinityPersistState().pending, false,
        `${scenario.what}: must NOT queue an affinity write`);
      assert.equal(counter.writes(), 0, `${scenario.what}: must not write the affinity cache`);
    } finally {
      counter.restore();
    }
  }

  // Positive control: the model-scoped rate limit DOES queue one.
  const cachePath = freshCache('semantics-positive');
  rotation.initializeState({ keys: structuredClone(KEYS) });
  rotation.handleKeyError(first, 429, 'rate limit', null, 'some/model');
  assert.equal(affinity.affinityPersistState().pending, true,
    'a model-scoped 429 queues exactly the deferred write');
  assert.equal(rotation.getKeys().find((k) => k.id === first).backoffUntil, 0,
    'and it must NOT place a global backoff on the key');
  assert.equal(fs.existsSync(cachePath), false, 'still nothing on disk before the debounce fires');
  affinity.closeAffinityPersistence();
});
