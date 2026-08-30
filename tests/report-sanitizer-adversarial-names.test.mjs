import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;

// ───────────────────────────────────────────────────────────────────────────
// DEFECT 1: the head-noun rule is escaped by a benign TRAILING word.
//
// isCredentialFieldName() classifies a field name by its LAST word only. That
// fixed the over-matching defect (activeKeys/keyCount/keyIndex/keysTried), but it
// opened the mirror hole: a credential name that ends in a CARRIER word — a word
// meaning "the thing itself" rather than a fact ABOUT the thing — has a benign
// head and is forwarded verbatim. Measured on the shipped build:
//
//   authorizationHeader -> "Basic dXNlcjpzdXBlcnNlY3JldA=="   (user:supersecret)
//   apiKeyValue, secretValue, tokenValue, keyMaterial, credentialPayload,
//   authHeader, apiKeyString, gatewayTokenValue, sessionSecretData, passwordHash
//
// None of those values is recoverable by the VALUE rules: no nvapi- prefix, no
// `Bearer ` prefix, and a third-party credential is never a registered runtime
// secret. The NAME is the only signal, and the name was ignored.
//
// REQUIRED BEHAVIOUR: a carrier suffix is transparent. Strip it and re-ask the
// head-noun question, so `apiKeyValue` is judged as `apiKey`. The four measured
// casualties must STILL survive, because their heads (`count`, `index`, `tried`,
// `keys`) are facts about keys, not carriers of one.
//
// DEFECT 2: sanitizeDiagnosticEntry THROWS on deeply nested input.
//
//   sanitizeDiagnosticEntry(deep5000) -> RangeError: Maximum call stack exceeded
//
// redact() recurses per level with no depth bound, so one hostile or merely
// pathological JSONL line takes down the whole diagnostic export
// (diagnostic-export.ts:68 calls this per parsed line). A sanitizer is a
// fail-closed boundary: it must degrade to a marker, never propagate.
// ───────────────────────────────────────────────────────────────────────────

/** Opaque: no nvapi- prefix, no Bearer, never a registered runtime secret. */
const OPAQUE = 'CANARYopaque0000000000000000000000000';

/**
 * Credential names whose head noun is a CARRIER word. Each plausibly holds real
 * credential material, and the value rules cannot see any of them.
 */
const CARRIER_SUFFIXED = [
  'authorizationHeader', 'apiKeyValue', 'secretValue', 'tokenValue', 'keyMaterial',
  'credentialPayload', 'authHeader', 'apiKeyString', 'gatewayTokenValue',
  'sessionSecretData', 'passwordHash'
];

/**
 * Plural credential names carrying a DOMAIN qualifier — the qualifier names which
 * credential system the keys belong to, so the field holds keys rather than a
 * count of them. `activeKeys` has no such qualifier and must stay a number.
 */
const QUALIFIED_PLURALS = ['apiKeys', 'x-api-keys'];

/** The four the original unanchored pattern destroyed. They must stay intact. */
const MEASURED_CASUALTIES = ['activeKeys', 'keyCount', 'keyIndex', 'keysTried'];

test('a credential name ending in a carrier word is still redacted', async () => {
  const { sanitizeDiagnosticEntry } = await import(built('report-sanitizer.js'));
  const { setRuntimeSecrets } = await import(built('redaction.js'));
  setRuntimeSecrets([]);

  const leaked = [];
  for (const name of CARRIER_SUFFIXED) {
    const out = sanitizeDiagnosticEntry({ [name]: OPAQUE });
    if (out[name] !== '[REDACTED]') leaked.push(`${name} -> ${JSON.stringify(out[name])}`);
  }
  assert.deepEqual(leaked, [],
    `a carrier suffix must not launder a credential name; these forwarded the value verbatim:\n  ${leaked.join('\n  ')}`);
});

test('a real Basic authorization header is not forwarded because of its suffix', async () => {
  const { sanitizeDiagnosticEntry } = await import(built('report-sanitizer.js'));
  const { setRuntimeSecrets } = await import(built('redaction.js'));
  setRuntimeSecrets([]);

  // base64("user:supersecret") — a credential no value rule can recognise.
  const basic = 'Basic dXNlcjpzdXBlcnNlY3JldA==';
  const out = sanitizeDiagnosticEntry({ authorizationHeader: basic, upstreamAuthHeader: basic });
  assert.equal(out.authorizationHeader, '[REDACTED]');
  assert.equal(out.upstreamAuthHeader, '[REDACTED]');
  assert.equal(JSON.stringify(out).includes('dXNlcjpzdXBlcnNlY3JldA'), false,
    'the encoded credential must not survive anywhere in the entry');
});

test('a plural key field with a credential-domain qualifier is redacted', async () => {
  const { sanitizeDiagnosticEntry } = await import(built('report-sanitizer.js'));
  const { setRuntimeSecrets } = await import(built('redaction.js'));
  setRuntimeSecrets([]);

  const leaked = [];
  for (const name of QUALIFIED_PLURALS) {
    const out = sanitizeDiagnosticEntry({ [name]: `${OPAQUE},${OPAQUE}` });
    if (out[name] !== '[REDACTED]') leaked.push(`${name} -> ${JSON.stringify(out[name])}`);
  }
  assert.deepEqual(leaked, [],
    `a joined list of credentials is not a count; these leaked:\n  ${leaked.join('\n  ')}`);
});

test('closing the carrier hole does not re-break the four measured casualties', async () => {
  const { sanitizeDiagnosticEntry } = await import(built('report-sanitizer.js'));

  // Numeric, as the gateway actually logs them.
  const numeric = sanitizeDiagnosticEntry({ activeKeys: 4, keyCount: 4, keyIndex: 2, keysTried: 3 });
  assert.deepEqual(numeric, { activeKeys: 4, keyCount: 4, keyIndex: 2, keysTried: 3 },
    'the rotation counters must keep both their values and their numeric type');

  // And as strings, which is how the existing 53-name guard exercises them.
  const stringly = sanitizeDiagnosticEntry(
    Object.fromEntries(MEASURED_CASUALTIES.map((name) => [name, `value-of-${name}`]))
  );
  const destroyed = MEASURED_CASUALTIES.filter((name) => stringly[name] !== `value-of-${name}`);
  assert.deepEqual(destroyed, [], `these carry no secret and must survive: ${destroyed.join(', ')}`);

  // Benign names that merely END in a carrier word must not be swept up.
  const benign = { contentType: 'application/json', logData: 'ok', keyIndexValue: 2, tokenizerName: 'cl100k' };
  const out = sanitizeDiagnosticEntry(benign);
  assert.equal(out.contentType, 'application/json');
  assert.equal(out.logData, 'ok');
  assert.equal(out.tokenizerName, 'cl100k');
});

test('sanitizeDiagnosticEntry never throws on hostile or pathological input', async () => {
  const { sanitizeDiagnosticEntry, sanitizeReportEntry } = await import(built('report-sanitizer.js'));

  let deep = { leaf: 1 };
  for (let level = 0; level < 5000; level += 1) deep = { nested: deep };

  const hostile = Object.defineProperty({ ok: 1 }, 'exploding', {
    get() { throw new Error('property getter blew up'); },
    enumerable: true
  });

  const cyclic = { a: 1 };
  cyclic.self = cyclic;

  for (const [label, input] of [
    ['deeply nested 5000 levels', deep],
    ['throwing getter', hostile],
    ['cyclic', cyclic]
  ]) {
    assert.doesNotThrow(() => sanitizeDiagnosticEntry(input),
      `sanitizeDiagnosticEntry must degrade rather than throw on: ${label}`);
    assert.doesNotThrow(() => sanitizeReportEntry(input),
      `sanitizeReportEntry must degrade rather than throw on: ${label}`);
  }

  // Degrading must also be fail-CLOSED: nothing unreviewed may slip through.
  const degraded = sanitizeDiagnosticEntry(deep);
  assert.equal(typeof degraded, 'object');
  assert.notEqual(degraded, null);
});
