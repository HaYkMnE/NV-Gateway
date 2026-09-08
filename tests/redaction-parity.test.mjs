// @ts-check
/**
 * Parity regression: src/shared/redaction.mjs is the gateway twin of
 * src/main/redaction.ts. The main copy caps string values at 16_384 chars and
 * arrays/objects at 1000 entries; the shared copy previously lacked both caps,
 * letting unbounded secrets/URLs fan out into bounded log/meta fields.
 *
 * (a) over-16_384 string -> 16_384 slice (exact main behavior)
 * (b) arrays/objects >1000 entries capped at 1000
 * (c) small/typical inputs unchanged
 * (d) crucially PARITY: the SAME fixture through BOTH implementations must
 *     yield identical output, so the twins can never silently drift again.
 *
 * Both copies redact FIRST, then cap (redaction may expand text via
 * [REDACTED]/pathname substitutions). Imports the compiled main twin from
 * build/src/main/redaction.js plus the raw shared module.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const shared = await import(pathToFileURL(path.join(root, 'src', 'shared', 'redaction.mjs')).href);
const main = await import(pathToFileURL(path.join(root, 'build', 'src', 'main', 'redaction.js')).href);

const MAX_STRING = 16_384;
const MAX_ENTRIES = 1000;

test('shared redaction caps a string value at 16_384 chars (main behavior)', () => {
  const big = `prefix nvapi-SECRETKEY1234567890 ${'x'.repeat(20_000)}`;
  const sharedOut = shared.redact(big);
  assert.equal(typeof sharedOut, 'string');
  assert.equal(sharedOut.length, MAX_STRING);
  // Exact main behavior: redact first, then slice(0, 16384) — identical output.
  assert.equal(sharedOut, main.redact(big));
  // Redaction still applied before the cap (secret gone, marker present).
  assert.ok(!sharedOut.includes('SECRETKEY1234567890'));
  assert.ok(sharedOut.includes('[REDACTED]'));
});

test('shared redaction caps arrays and objects at 1000 entries (main behavior)', () => {
  const bigArray = Array.from({ length: 1500 }, (_, i) => `item-${i}`);
  const sharedArr = shared.redact(bigArray);
  assert.equal(sharedArr.length, MAX_ENTRIES);
  assert.deepEqual(sharedArr, main.redact(bigArray));

  const bigObject = Object.fromEntries(
    Array.from({ length: 1500 }, (_, i) => [`key-${i}`, `value-${i}`])
  );
  const sharedObj = shared.redact(bigObject);
  assert.equal(Object.keys(sharedObj).length, MAX_ENTRIES);
  assert.deepEqual(sharedObj, main.redact(bigObject));
});

test('small/typical inputs pass through both copies unchanged', () => {
  const fixtures = [
    'plain log line, nothing secret',
    'Bearer abc123 rest of the line',
    'GET https://api.example.com/v1/models?key=secret#frag done',
    { authorization: 'Bearer hidden', note: 'visible', count: 3 },
    ['a', 'b', { token: 'shh', ok: true }],
    42,
    null,
    true
  ];
  for (const fixture of fixtures) {
    assert.deepEqual(shared.redact(fixture), main.redact(fixture),
      `parity on small input: ${JSON.stringify(fixture)?.slice(0, 80)}`);
  }
  // Spot-check redaction semantics survived: secrets masked, innocents kept.
  const masked = shared.redact({ authorization: 'Bearer hidden', note: 'visible' });
  assert.equal(masked.authorization, '[REDACTED]');
  assert.equal(masked.note, 'visible');
});

test('parity: identical mixed fixture through main and shared copies yields identical output', () => {
  const longSecretTail = `nvapi-${'K'.repeat(500)}`;
  const fixture = {
    authorization: 'Bearer topsecret-token-value',
    summary: 'short text',
    // Over-cap string carrying a secret mid-way: redaction expands it, then cap.
    blob: `${'A'.repeat(9000)} ${longSecretTail} ${'B'.repeat(9000)}`,
    url: 'https://user:pass@example.com/admin?next=/dash#frag trailing.',
    bigArray: Array.from({ length: 1200 }, (_, i) => `entry-${i} nvapi-${i}`),
    bigMap: Object.fromEntries(
      Array.from({ length: 1200 }, (_, i) => [`k-${i}`, `v-${i}`])
    ),
    nested: {
      cookie: 'session=abc',
      items: ['x', 'y', { key: 'hidden-key' }],
      count: 7
    }
  };
  const fromShared = shared.redact(fixture);
  const fromMain = main.redact(fixture);
  assert.deepEqual(fromShared, fromMain);
  // And the caps actually bit on the mixed payload:
  assert.equal(fromShared.blob.length, MAX_STRING);
  assert.equal(fromShared.bigArray.length, MAX_ENTRIES);
  assert.equal(Object.keys(fromShared.bigMap).length, MAX_ENTRIES);
  assert.equal(fromShared.authorization, '[REDACTED]');
});
