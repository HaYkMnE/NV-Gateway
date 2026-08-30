import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;

// ───────────────────────────────────────────────────────────────────────────
// PRIVACY CONTRACT
//
// Owner requirement: nothing leaves the machine until the user explicitly asks
// for it. Logs stay local and readable for the user's own diagnostics; only the
// TRANSMISSION is gated.
//
// Two defects these tests pin, both measured on the shipped build:
//
//  1. AUTOMATIC TRANSMISSION. saveFeedback() POSTed to the reporting worker as a
//     side effect of SAVING — including the diagnostic bundle as `logs` (up to
//     32 KB of gateway/app/stdio log lines). The user pressed "save", and a
//     network upload happened.
//
//  2. CREDENTIAL LEAK. error-reporter / feedback-service / diagnostic-export each
//     carried their OWN regex sanitizer covering only `nvapi-*`, `sk-*`, user
//     paths and e-mail. gatewayToken and adminToken are
//     crypto.randomBytes(32).toString("base64url") — random, UNPREFIXED — so no
//     regex could see them, and sanitizeEntry inspected VALUES only, never KEY
//     NAMES, so an `x-api-key` field survived verbatim. src/main/redaction.ts
//     already handles all of it (exact-match runtime secrets + sensitive key
//     names + Bearer stripping); the report modules simply did not use it.
// ───────────────────────────────────────────────────────────────────────────

/** Credential shapes the product actually holds. */
const CANARY = {
  nvidiaKey: 'nvapi-CANARY-ALPHA-0000000000000000000000000000',
  gatewayToken: 'CANARYbravoGATEWAYtoken0000000000000000000',
  adminToken: 'CANARYcharlieADMINtoken000000000000000000',
  rawBearer: 'CANARYechoRAWbearer00000000000000000'
};

function tempDir(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-privacy-${label}-`));
  test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('report sanitization removes unprefixed runtime credentials, not just nvapi keys', async () => {
  const { sanitizeReportText, sanitizeReportEntry } = await import(built('report-sanitizer.js'));
  const { setRuntimeSecrets } = await import(built('redaction.js'));
  setRuntimeSecrets([CANARY.gatewayToken, CANARY.adminToken]);
  try {
    // Free text — an upstream body, a Node error string, a stack frame. Each case
    // states WHY the value is recognisable, because free-text redaction can only
    // remove what it can identify:
    //   nvidiaKey    — the nvapi- prefix
    //   gatewayToken — exact match, via setRuntimeSecrets (this is the leak that
    //   adminToken     was measured: no regex can match random base64url)
    //   rawBearer    — the `Bearer ` prefix carries an otherwise opaque token
    const freeText = [
      ['nvidiaKey', CANARY.nvidiaKey, `upstream failed: ${CANARY.nvidiaKey} while calling the model`],
      ['gatewayToken', CANARY.gatewayToken, `admin probe rejected for ${CANARY.gatewayToken}`],
      ['adminToken', CANARY.adminToken, `429 cooldown recorded, adminToken=${CANARY.adminToken}`],
      ['rawBearer', CANARY.rawBearer, `header sent: Bearer ${CANARY.rawBearer}`]
    ];
    for (const [label, secret, text] of freeText) {
      assert.equal(sanitizeReportText(text).includes(secret), false,
        `${label} must not survive report sanitization`);
    }

    // HONEST LIMIT, asserted so it cannot be mistaken for a guarantee: a bare
    // credential of an UNKNOWN shape — no prefix, not a registered runtime secret
    // — cannot be recognised in free text by any sanitizer. That is precisely why
    // the entry-level allow-list below exists: fail-closed is achieved on FIELDS,
    // where a decision is possible, rather than pretended on arbitrary prose.
    const unknownShape = 'glpat-CANARYfoxtrotUNKNOWNshape0000000';
    assert.equal(sanitizeReportText(`token was ${unknownShape}`).includes(unknownShape), true,
      'documenting the limit: an unknown bare shape survives free text, which the field allow-list compensates for');

    // Object paths: the KEY NAME must be honoured, not only the value shape.
    const sanitized = sanitizeReportEntry({
      timestamp: '2026-08-30T00:00:00.000Z',
      type: 'gateway',
      message: '429 rate limit',
      stack: `at request (https://integrate.api.nvidia.com/v1/chat?key=${CANARY.nvidiaKey})`,
      source: 'gateway'
    });
    const serialized = JSON.stringify(sanitized);
    for (const [label, secret] of Object.entries(CANARY)) {
      assert.equal(serialized.includes(secret), false, `${label} must not survive in an entry`);
    }
  } finally {
    setRuntimeSecrets([]);
  }
});

test('report entries are fail-closed: unrecognised fields never reach the report', async () => {
  const { sanitizeReportEntry } = await import(built('report-sanitizer.js'));
  const sanitized = sanitizeReportEntry({
    timestamp: '2026-08-30T00:00:00.000Z',
    type: 'gateway',
    message: 'boom',
    // None of these belong in a report. A value-only sanitizer would forward
    // them; an allow-list drops them whatever they contain.
    authorization: `Bearer ${CANARY.rawBearer}`,
    'x-api-key': CANARY.gatewayToken,
    api_key: CANARY.nvidiaKey,
    upstreamBody: `{"api_key":"${CANARY.nvidiaKey}"}`,
    someFutureField: CANARY.adminToken
  });

  assert.deepEqual(Object.keys(sanitized).sort(), ['message', 'timestamp', 'type'],
    'only allow-listed report fields may survive');
  const serialized = JSON.stringify(sanitized);
  for (const [label, secret] of Object.entries(CANARY)) {
    assert.equal(serialized.includes(secret), false, `${label} must be dropped with its field`);
  }
});

test('saving feedback performs NO network transmission', async () => {
  const { saveFeedback } = await import(built('feedback-service.js'));
  const directory = tempDir('feedback');

  // Any outgoing attempt is recorded rather than performed, so the assertion is
  // about intent: a save must not reach for the network at all.
  const attempts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    attempts.push({ url: String(input), body: init?.body ? String(init.body) : '' });
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  };
  try {
    const result = await saveFeedback({
      type: 'bug',
      title: 'Rate limit confusion',
      description: 'The gateway reported a cooldown and I want to understand why.',
      attachDiagnostic: true
    }, { userDataPath: directory });

    assert.equal(result.success, true, 'the local save must still succeed');
    assert.ok(result.path && fs.existsSync(result.path), 'feedback is written to disk');
    assert.deepEqual(attempts, [],
      `saving feedback must not transmit anything, saw ${JSON.stringify(attempts.map((a) => a.url))}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the diagnostic export writes locally and transmits nothing', async () => {
  const { exportDiagnostic } = await import(built('diagnostic-export.js'));
  const directory = tempDir('diagnostic');
  fs.mkdirSync(path.join(directory, 'logs'), { recursive: true });
  // A log line shaped like the 429 path the user pointed at, carrying every
  // credential shape.
  fs.writeFileSync(path.join(directory, 'logs', 'gateway.jsonl'), `${JSON.stringify({
    timestamp: '2026-08-30T00:00:00.000Z',
    level: 'error',
    message: 'Upstream non-2xx response 429 rate limit',
    authorization: `Bearer ${CANARY.rawBearer}`,
    'x-api-key': CANARY.gatewayToken,
    detail: `key=${CANARY.nvidiaKey} adminToken=${CANARY.adminToken}`
  })}\n`, 'utf8');

  const { setRuntimeSecrets } = await import(built('redaction.js'));
  setRuntimeSecrets([CANARY.gatewayToken, CANARY.adminToken]);
  const attempts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input) => { attempts.push(String(input)); return Promise.resolve(new Response('{}', { status: 200 })); };
  try {
    const result = await exportDiagnostic({ userDataPath: directory });
    assert.equal(result.success, true);
    assert.deepEqual(attempts, [], 'exporting a diagnostic bundle must not transmit it');

    const bundle = fs.readFileSync(result.path, 'utf8');
    for (const [label, secret] of Object.entries(CANARY)) {
      assert.equal(bundle.includes(secret), false, `${label} must not appear in the diagnostic bundle`);
    }
  } finally {
    globalThis.fetch = realFetch;
    setRuntimeSecrets([]);
  }
});

test('no main-process module transmits on a crash handler or a timer', () => {
  // Static guard over the shipped sources: the ONLY place allowed to call the
  // reporting endpoint is the explicit send path in error-reporter.ts, which the
  // renderer reaches solely through the confirm dialog in Logs.tsx.
  const mainDir = path.join(root, 'src', 'main');
  const offenders = [];
  for (const name of fs.readdirSync(mainDir).filter((file) => file.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(mainDir, name), 'utf8');
    if (!/REPORTS_BASE_URL|fetch\s*\(/.test(source)) continue;
    if (name === 'error-reporter.ts' || name === 'reports-endpoint.ts') continue;
    offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    `only error-reporter.ts may hold the outgoing report path, found: ${offenders.join(', ')}`);

  // And that one send must not be wired to any implicit trigger.
  const reporter = fs.readFileSync(path.join(mainDir, 'error-reporter.ts'), 'utf8');
  const sendIndex = reporter.indexOf('export async function sendErrors');
  assert.ok(sendIndex > 0, 'sendErrors must exist');
  for (const trigger of ['process.on("uncaughtException"', 'process.on("unhandledRejection"', 'setInterval(', 'setTimeout(']) {
    const at = reporter.indexOf(trigger);
    if (at < 0) continue;
    // A trigger may exist (crash entries are still LOGGED locally) but it must
    // not sit inside the send function.
    assert.ok(at < sendIndex, `${trigger} must not appear inside the send path`);
  }
});
