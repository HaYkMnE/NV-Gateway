import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;

// ───────────────────────────────────────────────────────────────────────────
// DEFECT: the credential NAME matcher in report-sanitizer.ts over-matches.
//
// CREDENTIAL_NAME_HINT was an UNANCHORED alternation:
//   /(key|token|secret|auth|password|passwd|credential|bearer|cookie|session)/i
//
// so it fired on any field name merely CONTAINING one of those substrings. The
// logged field names of this product were measured by walking every logger
// call site in src/gateway/**.mjs and src/main/**.ts (the three writers spread a
// meta object into the JSONL entry: logger.mjs -> {timestamp,level,message,...meta},
// app-logger.ts -> {timestamp,level,event,...data}, gateway-lifecycle.ts ->
// {timestamp,text}). 53 distinct field names reach a log line; NONE of them
// carries a credential, yet four were being blanked:
//
//   activeKeys  (server.mjs:198)  keyCount  (rotation.mjs:220)
//   keyIndex    (server.mjs:1358) keysTried (server.mjs:198)
//
// Those four are exactly the key-rotation and rate-limit counters, so a 429
// investigation lost the numbers it depends on.
//
// REQUIRED BEHAVIOUR: match anchored on the whole field NAME, case-insensitively,
// tolerant of -/_/camelCase spellings of those same names. Value-based redaction
// (nvapi- prefix, Bearer, registered runtime secrets) must keep working —
// gatewayToken/adminToken are random UNPREFIXED base64url and can ONLY be caught
// by name, which is why the name rule has to stay correct rather than be dropped.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Every field name that actually reaches a JSONL log line, measured from the
 * logger call sites. None of these carries a secret, so every one of them must
 * survive sanitization intact.
 */
const LOGGED_FIELD_NAMES = [
  'aborted', 'activeKeys', 'arch', 'attempt', 'attempts', 'backoffMs', 'code',
  'contentType', 'count', 'duration_ms', 'earlyStop', 'earlyStopReason',
  'electronVersion', 'enabled', 'error', 'event', 'forced', 'graceful', 'id',
  'keyCount', 'keyIndex', 'keysTried', 'level', 'manual', 'maxAttempts',
  'message', 'method', 'model', 'newPort', 'nodeVersion', 'outcome', 'path',
  'percent', 'platform', 'poolWide', 'port', 'previousPort',
  'rateLimitMaxAttempts', 'reason', 'requestedPort', 'stack', 'state', 'status',
  'statusCode', 'stream', 'text', 'timestamp', 'upstreamCode', 'upstreamStatus',
  'upstreamStatusCode', 'upstreamType', 'version', 'warnings'
];

/** The four the unanchored pattern destroyed — called out so a regression names itself. */
const MEASURED_CASUALTIES = ['activeKeys', 'keyCount', 'keyIndex', 'keysTried'];

/**
 * Non-secret names that must survive whether or not this repo logs them today.
 *
 * activeKeys/keyCount/keyIndex/keysTried ARE logged here (measured above).
 * promptTokens and tokenizerName are NOT currently emitted by any logger call site
 * in this repo — the only `promptTokens` is a local variable in
 * src/gateway/direct-glm-probe.mjs:74 — but both are obvious usage/config fields
 * for a gateway, and each is a name the head-noun rule must classify as benign:
 * `promptTokens` heads on a counting plural, `tokenizerName` heads on `name`.
 * Asserting them keeps the rule honest if either becomes a logged field later.
 */
const MUST_SURVIVE = [
  'activeKeys', 'keyCount', 'keyIndex', 'keysTried', 'promptTokens', 'tokenizerName'
];

/** Credential field names that must ALWAYS be blanked, in the spellings seen in the wild. */
const CREDENTIAL_NAMES = [
  'authorization', 'Authorization', 'proxy-authorization',
  'x-api-key', 'X-API-Key', 'X_API_KEY', 'xApiKey',
  'api_key', 'apiKey', 'api-key', 'API_KEY',
  'gatewayToken', 'gateway_token', 'gateway-token', 'GATEWAYTOKEN',
  'adminToken', 'admin_token', 'admin-token',
  'bearer', 'Bearer',
  'cookie', 'Cookie', 'set-cookie',
  'secret', 'clientSecret', 'password', 'passwd', 'credential', 'credentials',
  'accessToken', 'refreshToken', 'privateKey', 'secretKey', 'authToken', 'localKey'
];

/** Credential shapes the product actually holds. */
const CANARY = {
  nvidiaKey: 'nvapi-CANARY-ALPHA-0000000000000000000000000000',
  gatewayToken: 'CANARYbravoGATEWAYtoken0000000000000000000',
  adminToken: 'CANARYcharlieADMINtoken000000000000000000',
  rawBearer: 'CANARYechoRAWbearer00000000000000000'
};

test('non-secret logged field names survive diagnostic sanitization', async () => {
  const { sanitizeDiagnosticEntry } = await import(built('report-sanitizer.js'));

  assert.equal(LOGGED_FIELD_NAMES.length, 53,
    'measured from the logger call sites: 53 distinct field names reach a JSONL log line');

  // Each harmless name carries a distinctive, secret-free value so a blanked
  // field is visible as a lost value rather than only a lost key.
  const entry = {};
  for (const [index, name] of LOGGED_FIELD_NAMES.entries()) {
    entry[name] = `diagnostic-value-${index}`;
  }

  const sanitized = sanitizeDiagnosticEntry(entry);
  const destroyed = LOGGED_FIELD_NAMES.filter(
    (name, index) => sanitized[name] !== `diagnostic-value-${index}`
  );

  assert.deepEqual(destroyed, [],
    `these logged field names carry no secret and must survive intact, but were altered: ${destroyed.join(', ')}`);

  // Named explicitly: the four the unanchored pattern was measured to destroy.
  for (const name of MEASURED_CASUALTIES) {
    assert.notEqual(sanitized[name], '[REDACTED]',
      `${name} is a key-rotation/rate-limit counter, not a credential — it must not be redacted`);
  }
});

test('harmless key/token-flavoured names survive, logged here or not', async () => {
  const { sanitizeDiagnosticEntry } = await import(built('report-sanitizer.js'));

  // Each of these reads as a credential to a substring matcher and as plain
  // diagnostics to a human. The head-noun rule must agree with the human.
  const entry = {};
  for (const name of MUST_SURVIVE) entry[name] = `value-of-${name}`;

  const sanitized = sanitizeDiagnosticEntry(entry);
  const destroyed = MUST_SURVIVE.filter((name) => sanitized[name] !== `value-of-${name}`);
  assert.deepEqual(destroyed, [],
    `these names carry no credential and must survive: ${destroyed.join(', ')}`);
});

test('numeric rotation counters keep their numeric type, not just their presence', async () => {
  const { sanitizeDiagnosticEntry } = await import(built('report-sanitizer.js'));
  const sanitized = sanitizeDiagnosticEntry({
    activeKeys: 4, keyCount: 4, keyIndex: 2, keysTried: 3, attempts: 3
  });
  assert.deepEqual(sanitized, { activeKeys: 4, keyCount: 4, keyIndex: 2, keysTried: 3, attempts: 3 },
    'counters must arrive as numbers so a 429 report can be reasoned about arithmetically');
});

test('genuine credential field names stay redacted, in every spelling', async () => {
  const { sanitizeDiagnosticEntry } = await import(built('report-sanitizer.js'));
  const { setRuntimeSecrets } = await import(built('redaction.js'));
  setRuntimeSecrets([]);

  // A value of an UNKNOWN shape — no nvapi- prefix, no Bearer, not a registered
  // runtime secret. Nothing but the NAME can justify blanking it, which is the
  // whole point of keeping name matching correct.
  const opaque = 'OPAQUEvalue0000000000000000000000000';
  const survivors = [];
  for (const name of CREDENTIAL_NAMES) {
    const sanitized = sanitizeDiagnosticEntry({ [name]: opaque });
    if (sanitized[name] !== '[REDACTED]') survivors.push(`${name} -> ${JSON.stringify(sanitized[name])}`);
  }
  assert.deepEqual(survivors, [],
    `these credential field names must be blanked by NAME: ${survivors.join('; ')}`);
});

test('canary credential values never reach a sanitized diagnostic entry', async () => {
  const { sanitizeDiagnosticEntry } = await import(built('report-sanitizer.js'));
  const { setRuntimeSecrets } = await import(built('redaction.js'));

  // gatewayToken and adminToken are crypto.randomBytes(32).toString("base64url")
  // — random and unprefixed. They are registered as runtime secrets, which is the
  // only way a VALUE match can see them; the NAME rule is the second line.
  setRuntimeSecrets([CANARY.gatewayToken, CANARY.adminToken]);
  try {
    const entry = {
      timestamp: '2026-08-30T00:00:00.000Z',
      level: 'error',
      message: 'Upstream non-2xx response 429 rate limit',
      // Named credential fields.
      authorization: `Bearer ${CANARY.rawBearer}`,
      'x-api-key': CANARY.gatewayToken,
      api_key: CANARY.nvidiaKey,
      apiKey: CANARY.nvidiaKey,
      gatewayToken: CANARY.gatewayToken,
      adminToken: CANARY.adminToken,
      cookie: `session=${CANARY.adminToken}`,
      // Secrets smuggled inside otherwise innocent-looking fields, which only
      // value-based redaction can catch.
      detail: `key=${CANARY.nvidiaKey} adminToken=${CANARY.adminToken}`,
      message2: `header sent: Bearer ${CANARY.rawBearer}`,
      // And the harmless counters that must nevertheless survive.
      activeKeys: 4, keyCount: 4, keyIndex: 2, keysTried: 3
    };

    const serialized = JSON.stringify(sanitizeDiagnosticEntry(entry));
    for (const [label, secret] of Object.entries(CANARY)) {
      assert.equal(serialized.includes(secret), false,
        `canary ${label} must not appear in a sanitized diagnostic entry`);
    }

    // Fixing names must not have cost the value-based rules.
    const sanitized = sanitizeDiagnosticEntry(entry);
    assert.equal(sanitized.activeKeys, 4, 'counters survive alongside the redaction');
    assert.equal(sanitized.keysTried, 3, 'counters survive alongside the redaction');
  } finally {
    setRuntimeSecrets([]);
  }
});

test('a real 429 entry keeps all 10 diagnostic features', async () => {
  const { sanitizeDiagnosticEntry } = await import(built('report-sanitizer.js'));

  // The actual shape emitted by src/gateway/server.mjs:198-210 on a pool-wide
  // rate-limit stop, plus the request-level keyIndex from server.mjs:1358 and a
  // stack trace. Nothing here is a credential.
  const entry = {
    timestamp: '2026-08-30T00:00:00.000Z',
    level: 'error',
    message: 'All failover attempts exhausted',
    attempts: 3,
    poolWide: true,
    upstreamStatus: 429,
    earlyStop: true,
    earlyStopReason: 'uniform_rate_limit',
    rateLimitMaxAttempts: 3,
    keysTried: 3,
    activeKeys: 4,
    keyIndex: 2,
    stack: 'Error: rate limit\n    at attemptUpstream (server.mjs:198:21)\n    at failover (server.mjs:266:9)'
  };

  const sanitized = sanitizeDiagnosticEntry(entry);

  // The 10 diagnostic features an operator needs to explain a 429: how many
  // attempts, whether the whole pool answered, the upstream status, whether the
  // loop stopped early and why, the configured budget, how many keys were tried,
  // how many were active, which key served the request, and the stack.
  const DIAGNOSTIC_FEATURES = {
    attempts: 3,
    poolWide: true,
    upstreamStatus: 429,
    earlyStop: true,
    earlyStopReason: 'uniform_rate_limit',
    rateLimitMaxAttempts: 3,
    keysTried: 3,
    activeKeys: 4,
    keyIndex: 2,
    stack: entry.stack
  };
  assert.equal(Object.keys(DIAGNOSTIC_FEATURES).length, 10, 'the established bar is 10 diagnostic features');

  const lost = [];
  for (const [name, expected] of Object.entries(DIAGNOSTIC_FEATURES)) {
    if (sanitized[name] !== expected) lost.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(sanitized[name])}`);
  }
  assert.deepEqual(lost, [],
    `a 429 report must keep every diagnostic feature; lost:\n  ${lost.join('\n  ')}`);

  // The envelope survives too, so the entry is still attributable in time.
  assert.equal(sanitized.timestamp, '2026-08-30T00:00:00.000Z');
  assert.equal(sanitized.level, 'error');
  assert.equal(sanitized.message, 'All failover attempts exhausted');
});

test('the report entry allow-list is unchanged by the name fix', async () => {
  const { sanitizeReportEntry } = await import(built('report-sanitizer.js'));
  // Fail-closed on FIELDS stays fail-closed: the allow-list is the report-side
  // guarantee and the name fix must not have widened it.
  const sanitized = sanitizeReportEntry({
    timestamp: '2026-08-30T00:00:00.000Z',
    type: 'gateway',
    message: '429 rate limit',
    activeKeys: 4,
    keysTried: 3,
    'x-api-key': CANARY.gatewayToken
  });
  assert.deepEqual(Object.keys(sanitized).sort(), ['message', 'timestamp', 'type'],
    'only allow-listed report fields may survive; diagnostic counters belong to the bundle, not the report');
});
