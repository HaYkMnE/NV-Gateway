import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;

// ───────────────────────────────────────────────────────────────────────────
// DEFECT 1 (outbound PII): stripUserPaths in report-sanitizer.ts recognised ONE
// shape of Windows user path:
//
//     /C:\\Users\\[^\\]+\\/gi
//
// so the account name survived every OTHER spelling. Measured against the built
// module before this fix:
//
//   D:\Users\Hayk\...            -> D:\Users\Hayk\...            LEAKED
//   \\server\Users\Hayk\...      -> \\server\Users\Hayk\...      LEAKED
//   C:/Users/Hayk/...            -> C:/Users/Hayk/...            LEAKED
//   C:\Users\Hayk (no trailing)  -> C:\Users\Hayk                LEAKED
//
// This is not theoretical: sanitizeReportEntry() feeds the ONLY outbound path in
// the app (error-reporter.ts POSTs to the reports worker on explicit user action),
// and a `stack` field carries absolute paths of app files. A relocated user
// profile (D:\Users\<name>) or a roaming/UNC profile therefore transmitted the
// local account name. Forward-slash spellings appear in stack frames and file://
// URLs, so they are ordinary, not exotic.
//
// The repo previously carried tests/redaction-userpath.test.mjs; it was removed in
// 04ba099 and NOTHING replaced it, leaving user-path redaction entirely unpinned.
// This file is that pin.
//
// DEFECT 2 (PII to stderr): windows-acl.ts logged the degrade warning as
//   console.warn(`... degraded after N attempt(s): ${filePath}`)
// interpolating the raw path, so the account name reached stderr verbatim on the
// ACL-degrade path that exists precisely because it fires in production.
//
// REQUIRED BEHAVIOUR: the account-name segment is masked for every drive letter,
// UNC host and separator style, wherever a user path is emitted.
// ───────────────────────────────────────────────────────────────────────────

const USER = 'Hayk';

test('maskUserPaths hides the account name for every Windows user-path spelling', async () => {
  const { maskUserPaths } = await import(built('redaction.js'));

  const cases = [
    ['canonical backslash', 'C:\\Users\\Hayk\\AppData\\Roaming\\nv-gateway\\app.jsonl', 'C:\\Users\\***\\AppData\\Roaming\\nv-gateway\\app.jsonl'],
    ['non-system drive', 'D:\\Users\\Hayk\\AppData\\Roaming\\nv-gateway\\app.jsonl', 'D:\\Users\\***\\AppData\\Roaming\\nv-gateway\\app.jsonl'],
    ['UNC / roaming profile', '\\\\server\\Users\\Hayk\\Documents\\report.json', '\\\\server\\Users\\***\\Documents\\report.json'],
    ['forward slashes', 'C:/Users/Hayk/AppData/Roaming/nv-gateway/app.jsonl', 'C:/Users/***/AppData/Roaming/nv-gateway/app.jsonl'],
    ['leaf with no trailing separator', 'C:\\Users\\Hayk', 'C:\\Users\\***'],
    ['lowercase spelling', 'c:\\users\\Hayk\\AppData', 'c:\\users\\***\\AppData']
  ];

  for (const [label, input, expected] of cases) {
    const output = maskUserPaths(input);
    assert.equal(output, expected, `${label}: expected the account name to be masked`);
    assert.equal(output.includes(USER), false, `${label}: account name must not survive`);
  }
});

test('maskUserPaths does not swallow surrounding prose or unrelated paths', async () => {
  const { maskUserPaths } = await import(built('redaction.js'));

  // The mask must stop at the path separator, not eat the rest of the sentence.
  assert.equal(
    maskUserPaths('failed writing C:\\Users\\Hayk\\app.jsonl after 2 attempts'),
    'failed writing C:\\Users\\***\\app.jsonl after 2 attempts'
  );
  // A path with no user segment is untouched.
  assert.equal(maskUserPaths('C:\\Program Files\\NV-Gateway\\app.exe'), 'C:\\Program Files\\NV-Gateway\\app.exe');
  assert.equal(maskUserPaths(''), '');
});

test('the outbound report path masks the account name in every field it forwards', async () => {
  const { sanitizeReportEntry, sanitizeReportText } = await import(built('report-sanitizer.js'));

  // `stack` is allow-listed and outbound; it is where absolute app paths live.
  const entry = sanitizeReportEntry({
    timestamp: '2026-08-30T00:00:00.000Z',
    type: 'renderer',
    message: 'failed writing C:\\Users\\Hayk\\AppData\\Roaming\\nv-gateway\\app.jsonl',
    stack: 'at write (D:\\Users\\Hayk\\proj\\x.js:1:1)\n at load (C:/Users/Hayk/app/index.js:2:2)'
  });
  const serialized = JSON.stringify(entry);
  assert.equal(serialized.includes(USER), false,
    `the local account name must not be transmitted, got ${serialized}`);

  for (const shape of [
    'D:\\Users\\Hayk\\proj\\x.js',
    '\\\\server\\Users\\Hayk\\Documents\\r.json',
    'C:/Users/Hayk/app/index.js'
  ]) {
    assert.equal(sanitizeReportText(shape).includes(USER), false,
      `sanitizeReportText must mask the account name in ${shape}`);
  }
});

test('the diagnostic bundle masks the account name in every user-path spelling', async () => {
  const { sanitizeDiagnosticEntry } = await import(built('report-sanitizer.js'));

  const serialized = JSON.stringify(sanitizeDiagnosticEntry({
    event: 'acl_degraded',
    message: 'ACL protectFile degraded after 2 attempt(s): C:\\Users\\Hayk\\AppData\\Roaming\\nv-gateway\\app.jsonl',
    secondary: 'D:\\Users\\Hayk\\side\\file.txt',
    posix: 'C:/Users/Hayk/app/index.js'
  }));
  assert.equal(serialized.includes(USER), false,
    `a shareable diagnostic bundle must not carry the account name, got ${serialized}`);
});

test('the ACL degrade warning does not put the account name on stderr', async () => {
  const acl = await import(built('windows-acl.js'));

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (message) => { warnings.push(String(message)); };
  try {
    const protect = acl.createWindowsAclProtector({
      sid: '*S-1-5-21-42',
      platform: 'win32',
      execute: () => ({ status: 1 })
    });
    protect('C:\\Users\\Hayk\\AppData\\Roaming\\nv-gateway\\app.jsonl', false);
  } finally {
    console.warn = realWarn;
  }

  assert.equal(warnings.length, 1, 'the degrade path still warns exactly once');
  // The existing contract (production-security-wiring / windows-acl-protector
  // tests) is that this line is emitted instead of throwing — keep it findable.
  assert.ok(warnings[0].includes('ACL protectFile degraded'),
    'the degrade warning keeps its recognisable prefix');
  assert.equal(warnings[0].includes(USER), false,
    `the warning must not interpolate the account name, got ${warnings[0]}`);
  assert.ok(warnings[0].includes('C:\\Users\\***\\'),
    `the warning keeps the masked path for diagnosis, got ${warnings[0]}`);
});
