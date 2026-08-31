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
    assert.match(
      line,
      /assertFeedbackData\(/,
      `${channel} must validate its payload, as check-ports and the admin handlers do`
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
