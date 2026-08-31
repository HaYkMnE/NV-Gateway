// GATE RESIDUAL 1 — THE IPC HANDLERS APPLIED NO PAYLOAD VALIDATION.
//
// `feedback:open-github-issue` and its sibling `feedback:save` were wrapped in
// `secure()`, which is `validateIpcSender` ONLY — it proves WHO is speaking, never
// WHAT they said. The main process therefore trusted whatever the renderer sent,
// while its neighbours in the same file all assert their payloads first:
// `check-ports` calls `validators.ports` (index.ts:724), the key handlers call
// `validators.key` / `validators.uuid` / `validators.status` / `validators.reorder`
// (index.ts:768-774), `set-app-config` goes through createAppConfigUpdateHandler
// (app-config-ipc.ts:23-30), and `clipboard:write-text` calls assertClipboardText
// (index.ts:714). The feedback pair was the gap.
//
// THE UI LIMITS ARE NOT A BOUNDARY. `FeedbackModal.tsx:5-6` caps the title at 100
// and the description at 2000 characters with DOM `maxLength` attributes. A DOM
// attribute is a typing affordance: it does not constrain programmatic value
// assignment, and anything that can reach this IPC channel never sees the DOM at
// all. The e-mail field carries no `maxLength` whatsoever.
//
// THE OLD BOUND WAS AN ACCIDENT IN AN UNRELATED MODULE. MEASURED against the built
// modules before this fix:
//
//   sanitizeReportText('a'.repeat(1e6)).length === 16384
//   description 20,000 units    -> OPENED a 16,733-character URL
//   description 1,000,000 units -> OPENED a 16,733-character URL
//   saveFeedback 1e6 x 3 fields -> wrote a 49,294-byte file, 16,384 per field
//   payload 'nope' (a STRING)   -> OPENED a 144-character URL
//   payload null                -> raw TypeError reading 'title'
//
// The only reason a 1 MB description was not a 1 MB URL is `src/main/redaction.ts`
// ending `.slice(0, 16_384)` — a truncation that exists for REDACTION reasons, in a
// module with no stake in URL length. Raise or remove that slice and the door is
// unbounded again, silently.
//
// That slice is also PER FIELD, so it never bounded the payload as a whole:
// measured, title + description + email each at 1,000,000 characters summed past
// the repository door's 65,536 cap and the flow died with the door's generic
// "External URL is not on the allowlist." — a misleading error for what is really
// an oversized payload, and the other half of the same defect.
//
// WHERE THE VALIDATOR LIVES, and why not in ipc-security.ts. The validators there
// are single-line assertions over scalars and that file imports nothing; this is a
// multi-field payload with an aggregate bound that must be DERIVED against the URL
// door. The precedent followed is `assertClipboardText` (index.ts:714), which was
// added for exactly this reason — free-form user text needing a size bound — and
// which deliberately sits outside ipc-security.ts while mirroring its style: assert
// the type, bound the size, throw a generic Error, never echo the value.
//
// SCOPE NOTE: `node --test` has no Electron runtime, so `src/main/index.ts` cannot
// be imported (it builds an app). The wiring is therefore asserted STATICALLY on
// the source and the validator's behaviour is exercised against the built module —
// the same split `tests/production-security-wiring.test.mjs` uses. FeedbackModal is
// NOT rendered: there is no jsdom and no @testing-library/react in node_modules and
// installing them is forbidden, so the renderer's limits are read out of its source
// as constants.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const openedUrls = [];
const nodeRequire = createRequire(import.meta.url);
const electronId = nodeRequire.resolve('electron');
nodeRequire.cache[electronId] = {
  id: electronId,
  filename: electronId,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    shell: {
      openExternal: async (url) => {
        openedUrls.push(url);
      }
    },
    app: {
      getPath: () => join(root, 'build', '.test-userdata-unused'),
      getVersion: () => '0.0.0-test',
      getName: () => 'nv-gateway-test'
    }
  }
};

const built = (name) => pathToFileURL(join(root, 'build', 'src', 'main', name)).href;
const {
  assertFeedbackData,
  snapshotFeedbackData,
  FEEDBACK_TITLE_MAX,
  FEEDBACK_DESCRIPTION_MAX,
  FEEDBACK_EMAIL_MAX
} = await import(built('feedback-validation.js'));
const { openGitHubIssue } = await import(built('feedback-service.js'));

const indexSource = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8');
const modalSource = readFileSync(join(root, 'src', 'renderer', 'components', 'FeedbackModal.tsx'), 'utf8');
const validationSource = readFileSync(join(root, 'src', 'main', 'feedback-validation.ts'), 'utf8');

/** A payload the renderer really produces, for reuse. */
const valid = () => ({
  type: 'bug',
  title: 'Rate limit confusion',
  description: 'Cooldown reported.',
  email: 'a@b.test',
  attachDiagnostic: true
});

/**
 * THE DERIVED BOUND, hoisted so every test in this file measures against the same
 * arithmetic instead of restating it. `encodeURIComponent` expands at most 9 URL
 * characters per UTF-16 code unit, and the title is emitted TWICE (query parameter
 * and body), so the ceiling over validator-accepted payloads is
 *
 *   9 * (2*title + description + email) + fixed scaffolding
 *
 * 9 per unit is the WORST case and it belongs to 3-byte BMP characters such as CJK
 * U+65E5, which occupy ONE unit: `encodeURIComponent('\u65E5').length === 9`. An
 * astral emoji is 4 bytes across TWO units, so `encodeURIComponent('\u{1F389}')` is
 * 12 characters, i.e. only 6 per unit. CJK is therefore the worst script, not emoji.
 */
const DERIVED_BOUND = 9 * (2 * FEEDBACK_TITLE_MAX + FEEDBACK_DESCRIPTION_MAX + FEEDBACK_EMAIL_MAX) + 1024;

/**
 * THE MEASURED MAXIMUM over validator-accepted payloads, pinned so the figures in
 * the source comments cannot rot again. GATE F2/F4: the numbers previously shipped
 * in `feedback-validation.ts` (20,147) and `external-open.ts` (13,514, "~4.8x
 * headroom", emoji named as the worst case) were all wrong. Measured here.
 */
const MEASURED_MAX_URL = 23_014;
const REPO_DOOR_CAP = 65_536;

test('R1: a feedback payload validator exists, in the assertion style of its neighbours', () => {
  assert.equal(
    typeof assertFeedbackData,
    'function',
    'the main process must expose a feedback payload validator'
  );
  // Same shape as assertClipboardText and the ipc-security validators: a bare
  // assertion function that throws a generic Error.
  assert.match(
    validationSource,
    /export function assertFeedbackData\(value: unknown\): asserts value is FeedbackData/,
    'the validator must be a TypeScript assertion function, matching the existing validators'
  );
});

test('R1: the validator accepts everything the renderer legitimately sends', () => {
  assert.doesNotThrow(() => assertFeedbackData(valid()));
  // email is optional on FeedbackData; the modal sends undefined when empty.
  assert.doesNotThrow(() => assertFeedbackData({ ...valid(), email: undefined }));
  const { email, ...withoutEmail } = valid();
  assert.doesNotThrow(() => assertFeedbackData(withoutEmail));
  assert.doesNotThrow(() => assertFeedbackData({ ...valid(), type: 'suggestion' }));
  assert.doesNotThrow(() => assertFeedbackData({ ...valid(), attachDiagnostic: false }));
});

test('R1: the limits are NOT tighter than what the UI legitimately allows', () => {
  // The renderer's own caps, read from its source so this cannot drift silently.
  const titleMax = Number(modalSource.match(/const TITLE_MAX = (\d+);/)[1]);
  const descriptionMax = Number(modalSource.match(/const DESCRIPTION_MAX = (\d+);/)[1]);
  assert.equal(titleMax, 100, 'guard assumption: FeedbackModal TITLE_MAX');
  assert.equal(descriptionMax, 2000, 'guard assumption: FeedbackModal DESCRIPTION_MAX');

  // The boundary must match the UI contract EXACTLY — not tighter (it would reject
  // reports the user can really type) and not looser (that leaves slack for a
  // caller that skips the DOM).
  assert.equal(FEEDBACK_TITLE_MAX, titleMax, 'the title bound must equal the UI limit');
  assert.equal(FEEDBACK_DESCRIPTION_MAX, descriptionMax, 'the description bound must equal the UI limit');

  // Checked in the WORST encodings, because the DOM attribute counts UTF-16 code
  // UNITS and so must the validator: an emoji is 2 units, so 50 of them fill a
  // 100-unit textbox and must be accepted.
  for (const [label, fields] of [
    ['UI-max ASCII', { title: 'T'.repeat(titleMax), description: 'word '.repeat(400).trim() }],
    ['UI-max Cyrillic', { title: '\u0417'.repeat(titleMax), description: '\u041E'.repeat(descriptionMax) }],
    ['UI-max CJK', { title: '\u65E5'.repeat(titleMax), description: '\u672C'.repeat(descriptionMax) }],
    ['UI-max emoji', { title: '\u{1F389}'.repeat(titleMax / 2), description: '\u{1F389}'.repeat(descriptionMax / 2) }]
  ]) {
    assert.doesNotThrow(
      () => assertFeedbackData({ ...valid(), ...fields }),
      `a report the UI permits must pass validation: ${label}`
    );
  }
});

test('R1: the validator rejects a payload the UI could never produce', () => {
  const cases = [
    ['not an object', 'nope'],
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['a number', 42],
    ['unknown type', { ...valid(), type: 'exploit' }],
    ['missing type', (() => { const { type, ...rest } = valid(); return rest; })()],
    ['title not a string', { ...valid(), title: 12345 }],
    ['empty title', { ...valid(), title: '' }],
    ['description not a string', { ...valid(), description: { toString: () => 'x' } }],
    ['empty description', { ...valid(), description: '' }],
    ['email not a string', { ...valid(), email: 99 }],
    ['attachDiagnostic not a boolean', { ...valid(), attachDiagnostic: 'yes' }],
    ['attachDiagnostic missing', (() => { const { attachDiagnostic, ...rest } = valid(); return rest; })()]
  ];
  for (const [label, payload] of cases) {
    assert.throws(
      () => assertFeedbackData(payload),
      /feedback/i,
      `the validator must reject: ${label}`
    );
  }
});

test('R1: oversized free-form text is refused at the boundary, not truncated elsewhere', () => {
  // These are the payloads that previously sailed through to the URL builder and
  // were bounded only by redaction.ts's slice.
  for (const size of [20_000, 100_000, 1_000_000]) {
    assert.throws(
      () => assertFeedbackData({ ...valid(), description: 'a'.repeat(size) }),
      /feedback/i,
      `a ${size}-unit description must be refused`
    );
    assert.throws(
      () => assertFeedbackData({ ...valid(), title: 'a'.repeat(size) }),
      /feedback/i,
      `a ${size}-unit title must be refused`
    );
  }
  assert.throws(
    () => assertFeedbackData({ ...valid(), email: `${'e'.repeat(100_000)}@b.test` }),
    /feedback/i,
    'an oversized email must be refused'
  );
  // One unit past each limit, so the bound is exact rather than approximate.
  assert.throws(() => assertFeedbackData({ ...valid(), title: 'a'.repeat(FEEDBACK_TITLE_MAX + 1) }), /feedback/i);
  assert.throws(() => assertFeedbackData({ ...valid(), description: 'a'.repeat(FEEDBACK_DESCRIPTION_MAX + 1) }), /feedback/i);
  assert.throws(() => assertFeedbackData({ ...valid(), email: 'e'.repeat(FEEDBACK_EMAIL_MAX + 1) }), /feedback/i);
  assert.doesNotThrow(() => assertFeedbackData({ ...valid(), title: 'a'.repeat(FEEDBACK_TITLE_MAX) }));
  assert.doesNotThrow(() => assertFeedbackData({ ...valid(), description: 'a'.repeat(FEEDBACK_DESCRIPTION_MAX) }));
  assert.doesNotThrow(() => assertFeedbackData({ ...valid(), email: 'e'.repeat(FEEDBACK_EMAIL_MAX) }));
});

test('R1: the validator NEVER echoes the payload into the error message', () => {
  // Same discipline as assertClipboardText in index.ts: the value can be pasted
  // credential material, and wrapIpcHandler logs this message, so it must not reach
  // a log through the message.
  const secret = 'nvapi-must-not-appear-in-any-message';
  try {
    assertFeedbackData({ ...valid(), title: secret.repeat(200) });
    assert.fail('expected a rejection');
  } catch (error) {
    assert.ok(!error.message.includes('nvapi'), `message leaked the payload: ${error.message}`);
    assert.ok(error.message.length < 120, `message is suspiciously large: ${error.message.length}`);
  }
});

test('R1: BOTH feedback IPC handlers validate their payload before using it', () => {
  // The load-bearing wiring assertion. `secure()` is validateIpcSender ONLY, so
  // without this call the main process trusts the renderer's payload.
  //
  // feedback:save carries the SAME defect as feedback:open-github-issue: the same
  // FeedbackData payload, the same secure()-only wrapper. MEASURED before this fix,
  // saveFeedback with three 1,000,000-character fields wrote a 49,294-byte file
  // (16,384 per field, bounded only by redaction.ts), and its own shape checks
  // returned { success: false } rather than refusing at the boundary. One validator
  // call fixes both; this is not a sweep of every handler in the file.
  for (const channel of ['feedback:save', 'feedback:open-github-issue']) {
    const line = indexSource
      .split('\n')
      .find((candidate) => candidate.includes(`ipcMain.handle("${channel}"`));
    assert.ok(line, `${channel} must still be registered`);
    // STRENGTHENED for GATE F1. This previously asserted only `/assertFeedbackData\(/`
    // — that the handler CALLED a validator. That is not enough, and the gap it left
    // is the whole of F1: `assertFeedbackData` is a TypeScript assertion function, so
    // it narrows the type of the object it was handed and then the handler passed THAT
    // SAME object onward, to be read a second time by the consumer. A property whose
    // value differs between the two reads defeats the validator completely.
    //
    // So the requirement is now the stronger one: the handler must SNAPSHOT the
    // payload and hand the CONSUMER THE SNAPSHOT. Both halves are asserted, because
    // snapshotting and then passing `data` anyway would be the same defect.
    assert.match(
      line,
      /snapshotFeedbackData\(\s*data\s*\)/,
      `${channel} must snapshot its payload, so validation and consumption read the same values`
    );
    assert.doesNotMatch(
      line,
      /(saveFeedback|openGitHubIssue)\(\s*data\s*\)/,
      `${channel} must pass the SNAPSHOT to its consumer, never the raw payload it was handed`
    );
    // The payload must arrive as `unknown` and be narrowed by the assertion, not
    // declared `FeedbackData` and trusted — a type annotation is erased at runtime.
    assert.match(
      line,
      /data: unknown/,
      `${channel} must take its payload as unknown, since a TS annotation is not a runtime check`
    );
  }
});

// ---------------------------------------------------------------------------
// GATE F1 (MEDIUM) — THE VALIDATOR READ EACH FIELD ONCE AND THE CONSUMER READ IT
// AGAIN, so a payload could return one value to the validator and another to the
// consumer. A validator at a trust boundary that can be lied to is worse than no
// validator: it manufactures confidence in a bound it does not actually enforce.
//
// MEASURED against the built modules BEFORE the fix, with a getter on `title`
// returning 'short' on its first read and 1,000,000 UTF-16 units afterwards:
//
//   assertFeedbackData(hostile) -> PASSED          (it saw 5 units)
//   openGitHubIssue(hostile)    -> OPENED 33,137 characters
//   `title` reads recorded      -> 3
//
// 33,137 is past the 23,704 bound this file's own arithmetic derives, so the
// validator's stated guarantee was false for that payload. It stayed under the
// door's 65,536 cap, so it opened rather than erroring.
//
// NOT REACHABLE FROM A RENDERER TODAY, stated honestly: Electron IPC serialises
// with the structured clone algorithm and MEASURED, `structuredClone` flattens a
// getter to a plain value (one read, and the far-side descriptor is
// `{value:'short',writable:true,...}`), so a live getter cannot cross the IPC
// boundary, and no other main-process module calls either consumer. This is
// defence-in-depth against a future main-process caller.
// ---------------------------------------------------------------------------

/** An object that lies: cheap on the first read, enormous on every read after. */
function hostilePayload(field, counter) {
  const big = 'A'.repeat(1_000_000);
  return {
    type: 'bug',
    title: 'ordinary title',
    description: 'ordinary description',
    email: 'a@b.test',
    attachDiagnostic: true,
    get [field]() {
      counter.reads += 1;
      return counter.reads === 1 ? 'short' : big;
    }
  };
}

test('F1: the boundary exposes a snapshotting validator, not only a type assertion', () => {
  assert.equal(
    typeof snapshotFeedbackData,
    'function',
    'the boundary needs a validator that RETURNS what it validated; an assertion function cannot replace the object it narrowed'
  );
});

test('F1: a getter that changes value between reads cannot smuggle an oversized field', async () => {
  for (const field of ['title', 'description', 'email']) {
    const counter = { reads: 0 };
    const snapshot = snapshotFeedbackData(hostilePayload(field, counter));

    // The field was read EXACTLY ONCE. That is the property that makes the
    // validated value and the consumed value the same value by construction.
    assert.equal(counter.reads, 1, `${field} must be read exactly once, got ${counter.reads}`);

    // What came back is the value that was validated, and it is bounded.
    assert.equal(snapshot[field], 'short', `the snapshot must carry the validated ${field}`);
    assert.ok(snapshot[field].length <= 1000, `the snapshot ${field} must be the bounded value`);

    // Consuming the snapshot cannot re-trigger the getter, so the URL stays inside
    // the derived bound instead of the 33,137 characters measured before the fix.
    openedUrls.length = 0;
    await openGitHubIssue(snapshot);
    assert.equal(counter.reads, 1, `consuming the snapshot must not re-read ${field}`);
    assert.equal(openedUrls.length, 1, `the snapshotted report must still open: ${field}`);
    assert.ok(
      openedUrls[0].length < DERIVED_BOUND,
      `URL ${openedUrls[0].length} must stay under the derived bound ${DERIVED_BOUND} for ${field}`
    );
    const opened = new URL(openedUrls[0]);
    assert.equal(opened.origin, 'https://github.com', `origin stays pinned for ${field}`);
    assert.equal(opened.pathname, '/HaYkMnE/NV-Gateway/issues/new', `path stays pinned for ${field}`);
  }
});

test('F1: a getter that is oversized on its FIRST read is still rejected', () => {
  // The mirror case: reading once must not become a way to skip the bound.
  for (const field of ['title', 'description', 'email']) {
    const counter = { reads: 1 }; // so the getter returns the big value immediately
    assert.throws(
      () => snapshotFeedbackData(hostilePayload(field, counter)),
      /feedback/i,
      `an oversized ${field} must be refused even when read once`
    );
  }
});

test('F1: the snapshot is FROZEN, so a getter cannot be installed on it afterwards', () => {
  const snapshot = snapshotFeedbackData(valid());
  assert.ok(Object.isFrozen(snapshot), 'the snapshot must be frozen');
  for (const field of ['title', 'description', 'email', 'type', 'attachDiagnostic']) {
    assert.throws(
      () => Object.defineProperty(snapshot, field, { get: () => 'A'.repeat(1_000_000) }),
      TypeError,
      `a frozen snapshot must refuse a re-armed getter on ${field}`
    );
  }
  // And every field is a plain data property, with nothing left to re-evaluate.
  for (const field of Object.keys(snapshot)) {
    const descriptor = Object.getOwnPropertyDescriptor(snapshot, field);
    assert.equal(descriptor.get, undefined, `${field} must not be an accessor`);
    assert.equal(descriptor.writable, false, `${field} must not be writable`);
  }
});

test('F1: a Proxy that lies on repeated reads is defeated by the same property', async () => {
  // Not just getters. Any exotic object whose `get` trap is non-deterministic is
  // covered, because the snapshot reads once and never consults the source again.
  let reads = 0;
  const proxied = new Proxy(
    { type: 'bug', title: 'x', description: 'ordinary description', email: 'a@b.test', attachDiagnostic: true },
    {
      get(target, property, receiver) {
        if (property === 'title') {
          reads += 1;
          return reads === 1 ? 'short' : 'A'.repeat(1_000_000);
        }
        return Reflect.get(target, property, receiver);
      }
    }
  );
  const snapshot = snapshotFeedbackData(proxied);
  assert.equal(reads, 1, 'the proxy title must be read exactly once');
  assert.equal(snapshot.title, 'short');
  openedUrls.length = 0;
  await openGitHubIssue(snapshot);
  assert.equal(reads, 1, 'consuming the snapshot must not hit the proxy trap again');
  assert.ok(openedUrls[0].length < DERIVED_BOUND, `URL ${openedUrls[0].length} must stay bounded`);
});

test('F1: the snapshot accepts and rejects EXACTLY what the assertion always did', () => {
  // The fix must not change the accepted set in either direction.
  for (const accepted of [
    valid(),
    { ...valid(), email: undefined },
    (() => { const { email, ...rest } = valid(); return rest; })(),
    { ...valid(), type: 'suggestion' },
    { ...valid(), attachDiagnostic: false },
    { ...valid(), title: 'a'.repeat(FEEDBACK_TITLE_MAX) },
    { ...valid(), description: 'a'.repeat(FEEDBACK_DESCRIPTION_MAX) },
    { ...valid(), email: 'e'.repeat(FEEDBACK_EMAIL_MAX) }
  ]) {
    assert.doesNotThrow(() => snapshotFeedbackData(accepted));
    assert.doesNotThrow(() => assertFeedbackData(accepted));
  }
  for (const rejected of [
    'nope', null, undefined, [], 42,
    { ...valid(), type: 'exploit' },
    { ...valid(), title: 12345 },
    { ...valid(), title: '' },
    { ...valid(), description: '' },
    { ...valid(), email: 99 },
    { ...valid(), attachDiagnostic: 'yes' },
    { ...valid(), title: 'a'.repeat(FEEDBACK_TITLE_MAX + 1) },
    { ...valid(), description: 'a'.repeat(FEEDBACK_DESCRIPTION_MAX + 1) },
    { ...valid(), email: 'e'.repeat(FEEDBACK_EMAIL_MAX + 1) }
  ]) {
    assert.throws(() => snapshotFeedbackData(rejected), /feedback/i);
    assert.throws(() => assertFeedbackData(rejected), /feedback/i);
  }
  // An absent email stays absent rather than becoming an empty string.
  const { email, ...withoutEmail } = valid();
  assert.ok(!('email' in snapshotFeedbackData(withoutEmail)), 'an absent email must not be invented');
  assert.ok(!('email' in snapshotFeedbackData({ ...valid(), email: undefined })), 'undefined email must not become a field');
});

test('F1: the snapshot never echoes the payload into the error message either', () => {
  const secret = 'nvapi-must-not-appear-in-any-message';
  try {
    snapshotFeedbackData({ ...valid(), title: secret.repeat(200) });
    assert.fail('expected a rejection');
  } catch (error) {
    assert.ok(!error.message.includes('nvapi'), `message leaked the payload: ${error.message}`);
    assert.ok(error.message.length < 120, `message is suspiciously large: ${error.message.length}`);
  }
});

test('F1: the consumers read each field once too, so a direct main-process caller is covered', () => {
  // openGitHubIssue and saveFeedback are exported and could be called by a future
  // main-process caller that forgets to snapshot. Their own reads are therefore
  // single-read as well. Asserted statically: `data.<field>` must appear at most
  // once per field per function, because a `typeof x === 'string' ? x : ...`
  // ternary is itself TWO reads — which is where 2 of the 3 measured title reads
  // came from.
  const serviceSource = readFileSync(join(root, 'src', 'main', 'feedback-service.ts'), 'utf8');
  const code = serviceSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  // PER FUNCTION, not per file: both consumers legitimately read `data.title` once
  // each, so a file-wide count of 1 would be wrong. Each function body is sliced out
  // by its own signature and counted on its own.
  const bodies = {
    saveFeedback: code.slice(
      code.indexOf('export async function saveFeedback'),
      code.indexOf('export async function openGitHubIssue')
    ),
    openGitHubIssue: code.slice(code.indexOf('export async function openGitHubIssue'))
  };
  for (const [name, body] of Object.entries(bodies)) {
    assert.ok(body.length > 200, `guard assumption: ${name} body was located in the source`);
    for (const field of ['title', 'description', 'email', 'type', 'attachDiagnostic']) {
      const occurrences = body.match(new RegExp(`\\bdata\\s*\\.\\s*${field}\\b`, 'g')) ?? [];
      assert.ok(
        occurrences.length <= 1,
        `${name} reads data.${field} ${occurrences.length} times; it must read it once into a local`
      );
    }
  }
});

test('R1: the bound is stated at the boundary, not inherited from redaction.ts', () => {
  // The whole point: a future edit to redaction.ts's `.slice(0, 16_384)` must not
  // be able to unbound these paths. The limits must be declared with the validator.
  assert.match(
    validationSource,
    /export const FEEDBACK_TITLE_MAX\s*=\s*[\d_]+/,
    'the title bound must be an explicit named constant'
  );
  assert.match(
    validationSource,
    /export const FEEDBACK_DESCRIPTION_MAX\s*=\s*[\d_]+/,
    'the description bound must be an explicit named constant'
  );
  assert.match(
    validationSource,
    /export const FEEDBACK_EMAIL_MAX\s*=\s*[\d_]+/,
    'the email bound must be an explicit named constant'
  );
});

// ---------------------------------------------------------------------------
// GATE F2 / F4 (LOW) — THREE SHIPPED FIGURES WERE WRONG. No behavioural RED test
// is possible for a comment: a stale number breaks nothing at runtime, so there is
// nothing to make fail first, and claiming otherwise would be inventing a proof.
// What IS possible, and is done here, is pinning the arithmetic and the measured
// maximum by assertion so the figures cannot rot again without failing the suite.
// ---------------------------------------------------------------------------

test('F2/F4: the per-unit expansion arithmetic is what the comments claim', () => {
  // The load-bearing claim behind every figure in these files, and the one the
  // external-open.ts comment got backwards by naming emoji as the worst case.
  // A 3-byte BMP character is ONE UTF-16 unit expanding to 9 URL characters.
  assert.equal(encodeURIComponent('\u65E5').length, 9, 'CJK U+65E5 must expand to 9 URL characters');
  assert.equal('\u65E5'.length, 1, 'and occupy one UTF-16 code unit');
  // A 4-byte astral character is TWO units expanding to 12, i.e. only 6 per unit.
  assert.equal(encodeURIComponent('\u{1F389}').length, 12, 'an astral emoji must expand to 12 URL characters');
  assert.equal('\u{1F389}'.length, 2, 'across two UTF-16 code units');
  assert.equal(
    encodeURIComponent('\u{1F389}').length / '\u{1F389}'.length,
    6,
    'so emoji is 6 URL characters per unit'
  );
  // Therefore CJK is the worst script, by exactly 1.5x per unit.
  assert.ok(
    encodeURIComponent('\u65E5').length / '\u65E5'.length >
      encodeURIComponent('\u{1F389}').length / '\u{1F389}'.length,
    'CJK must expand further per UTF-16 unit than emoji — this is why CJK is the worst case, not emoji'
  );
});

test('F2/F4: the MEASURED maximum URL matches the figure the comments now state', async () => {
  // The true maximum over validator-accepted payloads. The figure previously stated
  // in feedback-validation.ts was 20,147, which is this payload with an ASCII e-mail
  // instead of a CJK one — 320 units of ASCII e-mail add 201 URL characters where 320
  // units of CJK add 2,868.
  const ceiling = {
    type: 'bug',
    title: '\u65E5'.repeat(FEEDBACK_TITLE_MAX),
    description: '\u672C'.repeat(FEEDBACK_DESCRIPTION_MAX),
    email: '\u65E5'.repeat(FEEDBACK_EMAIL_MAX),
    attachDiagnostic: true
  };
  assert.doesNotThrow(() => snapshotFeedbackData(ceiling), 'the ceiling payload must be valid');
  openedUrls.length = 0;
  await openGitHubIssue(ceiling);
  assert.equal(openedUrls.length, 1, 'the ceiling payload must still open');
  assert.equal(
    openedUrls[0].length,
    MEASURED_MAX_URL,
    `the measured maximum moved; re-derive the figures in feedback-validation.ts and external-open.ts (got ${openedUrls[0].length})`
  );

  // It must sit under the derived bound and the door cap, which is what makes the
  // validator's stated guarantee true.
  assert.ok(MEASURED_MAX_URL < DERIVED_BOUND, `measured max ${MEASURED_MAX_URL} must fit the derived bound ${DERIVED_BOUND}`);
  assert.ok(MEASURED_MAX_URL < REPO_DOOR_CAP, `measured max ${MEASURED_MAX_URL} must fit the door cap ${REPO_DOOR_CAP}`);

  // And CJK really is worse than emoji end to end, not just per unit.
  openedUrls.length = 0;
  await openGitHubIssue({
    type: 'bug',
    title: '\u{1F389}'.repeat(FEEDBACK_TITLE_MAX / 2),
    description: '\u{1F389}'.repeat(FEEDBACK_DESCRIPTION_MAX / 2),
    email: '\u{1F389}'.repeat(FEEDBACK_EMAIL_MAX / 2),
    attachDiagnostic: true
  });
  const emojiMax = openedUrls[0].length;
  assert.equal(emojiMax, 15_454, `the emoji maximum moved; it was measured at 15,454 (got ${emojiMax})`);
  assert.ok(emojiMax < MEASURED_MAX_URL, 'the emoji case must be CHEAPER than CJK, which is why naming it the worst case was wrong');

  console.log(`\n  measured maxima: CJK ${MEASURED_MAX_URL}, emoji ${emojiMax}; derived bound ${DERIVED_BOUND}, door cap ${REPO_DOOR_CAP} (headroom ${(REPO_DOOR_CAP / MEASURED_MAX_URL).toFixed(2)}x)`);
});

test('F2/F4: the source comments state the corrected figures, not the stale claims', () => {
  const externalOpenSource = readFileSync(join(root, 'src', 'main', 'external-open.ts'), 'utf8');

  // The stale CLAIMS must be gone. These target the claim PHRASING rather than the
  // bare digits on purpose: both files deliberately keep a short historical note
  // recording that the old figure was wrong and what replaced it, because deleting
  // that note is how a future reader "restores" the old number in good faith. So what
  // must not survive is the assertion that those figures are current.
  // NOTE ON THE PHRASING OF THIS REGEX. The first attempt was
  // /largest URL the UI can produce is 20,147/, which could NEVER match: the stale
  // comment wrapped that sentence as "the largest URL the UI can\n * produce is
  // 20,147 characters", so the assertion passed vacuously and proved nothing. It is
  // now anchored on a fragment that really did sit on one line in the stale text —
  // verified against the pre-fix revision, see the non-vacuity test below.
  assert.doesNotMatch(
    validationSource,
    /produce is 20,147 characters/,
    'feedback-validation.ts must no longer CLAIM 20,147 is the maximum'
  );
  assert.doesNotMatch(
    externalOpenSource,
    /MEASURED at 13,514 characters/,
    'external-open.ts must no longer CLAIM 13,514 as the measured worst case'
  );
  assert.doesNotMatch(
    externalOpenSource,
    /leaves roughly 4\.8x headroom/,
    'external-open.ts must no longer CLAIM 4.8x headroom'
  );

  // And the corrected ones must be present, so prose and measurement agree.
  assert.match(validationSource, /23,014/, 'feedback-validation.ts must state the measured 23,014 maximum');
  assert.match(externalOpenSource, /23,014/, 'external-open.ts must state the measured 23,014 maximum');
  assert.match(externalOpenSource, /2\.85x/, 'external-open.ts must state the real 2.85x headroom');
  // The worst-case SCRIPT must be named correctly in the file that sizes the cap.
  assert.match(
    externalOpenSource,
    /WORST-CASE SCRIPT IS CJK, NOT EMOJI/,
    'external-open.ts must name CJK as the worst case, since it expands 9 URL characters per unit against emoji 6'
  );
});

test('F2/F4: those stale-claim regexes are NOT vacuous — they match the text they replaced', () => {
  // A `doesNotMatch` assertion against prose is worthless if the pattern could never
  // have matched anything. That is not hypothetical here: the first version of the
  // check above used /largest URL the UI can produce is 20,147/, and the stale comment
  // wrapped that sentence across two lines, so it passed while proving nothing.
  //
  // The exact stale fragments are reproduced below, copied from the pre-fix revision
  // b1a9dfd, and each regex must MATCH them. So if a future edit reinstates the old
  // wording, the assertions above really do fail.
  const staleValidation = [
    ' * bytes and 18,000 URL characters. MEASURED end to end, the largest URL the UI can',
    ' * produce is 20,147 characters, with title and description both full of CJK — NOT',
    ' * the emoji case, which measures 13,547.'
  ].join('\n');
  const staleExternalOpen = [
    ' * the worst-case encoding of those limits (emoji, 12 characters per 2 UTF-16',
    ' * units) MEASURED at 13,514 characters. 65,536 leaves roughly 4.8x headroom over',
    ' * the largest URL the UI can produce, while a runaway payload is refused here'
  ].join('\n');

  assert.match(staleValidation, /produce is 20,147 characters/, 'the 20,147 pattern must match the text it replaced');
  assert.match(staleExternalOpen, /MEASURED at 13,514 characters/, 'the 13,514 pattern must match the text it replaced');
  assert.match(staleExternalOpen, /leaves roughly 4\.8x headroom/, 'the 4.8x pattern must match the text it replaced');
});

test('R1: a validated payload can never exceed the repository door cap', () => {
  // The bound must be DERIVED, not hoped for. encodeURIComponent expands at most 9
  // URL characters per UTF-16 code unit (a 3-byte BMP character such as U+65E5 ->
  // %E6%97%A5; an astral character is 4 bytes across 2 units, so only 6 per unit).
  // The title is emitted TWICE (query parameter and body), so the worst case is
  // 9 * (2*title + description + email) + fixed scaffolding, and that must fit the
  // 65,536-character cap openRepoUrl enforces.
  const worstCase = 9 * (2 * FEEDBACK_TITLE_MAX + FEEDBACK_DESCRIPTION_MAX + FEEDBACK_EMAIL_MAX) + 1024;
  assert.ok(
    worstCase < 65_536,
    `a validated payload must fit the door by construction (worst case ${worstCase})`
  );

  // And measured end to end, in the encoding that expands the most. That is CJK,
  // not emoji: 3 UTF-8 bytes in a single UTF-16 unit is 9 URL characters per unit,
  // where an astral emoji is 4 bytes across 2 units, i.e. 6.
  openedUrls.length = 0;
  const fields = {
    type: 'bug',
    title: '\u65E5'.repeat(FEEDBACK_TITLE_MAX),
    description: '\u672C'.repeat(FEEDBACK_DESCRIPTION_MAX),
    email: `${'e'.repeat(FEEDBACK_EMAIL_MAX - 8)}@bb.test`,
    attachDiagnostic: true
  };
  assert.doesNotThrow(() => assertFeedbackData(fields), 'the ceiling payload must be valid');
  return openGitHubIssue(fields).then(() => {
    assert.equal(openedUrls.length, 1, 'the ceiling payload must still open');
    assert.ok(
      openedUrls[0].length < 65_536,
      `measured ceiling URL ${openedUrls[0].length} must sit inside the door cap`
    );
    assert.ok(
      openedUrls[0].length <= worstCase,
      `the measured ceiling ${openedUrls[0].length} must sit under the derived bound ${worstCase}`
    );
    const opened = new URL(openedUrls[0]);
    assert.equal(opened.origin, 'https://github.com');
    assert.equal(opened.pathname, '/HaYkMnE/NV-Gateway/issues/new');
    console.log(`\n  measured ceiling URL: ${openedUrls[0].length} characters (derived bound ${worstCase}, door cap 65536)`);
  });
});
