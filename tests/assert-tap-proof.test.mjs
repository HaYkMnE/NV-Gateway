// Regression tests for scripts/assert-tap-proof.mjs — the CI step that proves the
// dist-gated packaged assertions actually EXECUTED.
//
// The fixtures below are real `node --test` output shapes, captured from Node
// v20.20.2 (the version CI pins via .github/workflows/test.yml) and confirmed
// byte-identical in shape on v22.22.2. They are not invented.
//
// The bug this file exists to lock down: the previous inline PowerShell check only
// rejected `# SKIP`. node:test can ALSO neutralise a test with t.todo() /
// { todo: true }, which TAP renders as `ok N - <name> # TODO` — indistinguishable
// from a pass to a SKIP-only check — and a test that THROWS under todo prints
// `not ok` while STILL leaving `# fail 0` and process exit code 0. So the whole
// proof step passed with the assertions never running.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'scripts', 'assert-tap-proof.mjs');

const NAME_A = 'the packaged engine lives INSIDE app.asar';
const NAME_B = 'packaged credential smoke statically audits the existing unpacked output when present';
const MARKER = 'PACKAGED_LAYOUT_VERIFIED';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvgw-tapproof-'));
test.after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

let seq = 0;
function writeLog(text, { utf16 = false } = {}) {
  const p = path.join(tmpRoot, `log-${seq++}.log`);
  fs.writeFileSync(p, text, utf16 ? 'utf16le' : 'utf8');
  return p;
}

function run(logPath, extra = []) {
  const args = [script, logPath,
    `--require-ok=${NAME_A}`,
    `--require-ok=${NAME_B}`,
    `--require-marker=${MARKER}`,
    ...extra];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// A genuine green run: both named tests pass un-annotated, marker printed.
const GOOD_LOG = [
  'TAP version 13',
  `# Subtest: ${NAME_A}`,
  `ok 1 - ${NAME_A}`,
  '  ---',
  '  duration_ms: 2.5021',
  '  ...',
  `# Subtest: ${NAME_B}`,
  `ok 2 - ${NAME_B}`,
  '  ---',
  '  duration_ms: 3.1271',
  '  ...',
  `# ${MARKER}`,
  '# Subtest: packaged layout verified',
  'ok 3 - packaged layout verified',
  '1..3',
  '# tests 3',
  '# suites 0',
  '# pass 3',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
  '# duration_ms 314.8389',
  '',
].join('\n');

test('a genuine green packaged run is accepted', () => {
  const { code, out } = run(writeLog(GOOD_LOG));
  assert.equal(code, 0, out);
  assert.match(out, /ALL_PACKAGED_ASSERTIONS_EXECUTED/);
});

test('the same log written UTF-16LE is still parsed (Windows PowerShell 5.1 shape)', () => {
  // shell: pwsh writes UTF-8, but Windows PowerShell 5.1's Tee-Object writes
  // UTF-16LE for the identical pipeline. Read as UTF-8 that log matches nothing,
  // and a naive checker would conclude "nothing failed".
  const { code, out } = run(writeLog(`\uFEFF${GOOD_LOG}`, { utf16: true }));
  assert.equal(code, 0, out);
  assert.match(out, /ALL_PACKAGED_ASSERTIONS_EXECUTED/);
});

test('THE REGRESSION: a skip: gate flipped to todo: is rejected', () => {
  // Measured on Node v20.20.2: `ok 1 - <name> # TODO` plus a THROWN todo test
  // rendering as `not ok 2`, yet `# fail 0` and exit code 0.
  const cloaked = [
    'TAP version 13',
    `# Subtest: ${NAME_A}`,
    `ok 1 - ${NAME_A} # TODO gate flipped to todo`,
    `# Subtest: ${NAME_B}`,
    `not ok 2 - ${NAME_B} # TODO`,
    '  ---',
    "  error: 'body never asserted'",
    '  ...',
    `# ${MARKER}`,
    '1..2',
    '# tests 2',
    '# pass 0',
    '# fail 0',
    '# skipped 0',
    '# todo 2',
    '',
  ].join('\n');
  const { code, out } = run(writeLog(cloaked));
  assert.equal(code, 1, out);
  assert.match(out, /PACKAGED_ASSERTIONS_NOT_PROVEN/);
  assert.match(out, /# todo 2/);
  assert.match(out, /NOT OK/);
});

test('a skipped named assertion is rejected', () => {
  const skipped = GOOD_LOG
    .replace(`ok 1 - ${NAME_A}`, `ok 1 - ${NAME_A} # SKIP no dist/ present`)
    .replace('# skipped 0', '# skipped 1');
  const { code, out } = run(writeLog(skipped));
  assert.equal(code, 1, out);
  assert.match(out, /NEUTRALISED \(SKIP\)/);
});

test('a real test failure is rejected', () => {
  const failed = GOOD_LOG.replace('# fail 0', '# fail 1');
  const { code, out } = run(writeLog(failed));
  assert.equal(code, 1, out);
  assert.match(out, /# fail 1/);
});

test('an absent named assertion is rejected', () => {
  const missing = GOOD_LOG.replace(`ok 2 - ${NAME_B}`, 'ok 2 - some unrelated test');
  const { code, out } = run(writeLog(missing));
  assert.equal(code, 1, out);
  assert.match(out, /MISSING/);
});

test('an absent marker is rejected (early-RETURN test still prints a plain ok)', () => {
  const noMarker = GOOD_LOG.replace(`# ${MARKER}\n`, '');
  const { code, out } = run(writeLog(noMarker));
  assert.equal(code, 1, out);
  assert.match(out, /MISSING : PACKAGED_LAYOUT_VERIFIED marker/);
});

test('a non-TAP log fails CLOSED rather than passing vacuously', () => {
  const { code, out } = run(writeLog('npm ERR! something exploded before the tests ran\n'));
  assert.equal(code, 1, out);
  assert.match(out, /NOT TAP/);
});

test('a TAP log whose summary counters are missing fails CLOSED', () => {
  // Shape drift: if a future Node stops emitting "# fail <n>", every count-based
  // pattern silently matches nothing. That must not read as success.
  const noSummary = GOOD_LOG
    .split('\n')
    .filter((l) => !/^# (fail|todo|skipped) \d+$/.test(l))
    .join('\n');
  const { code, out } = run(writeLog(noSummary));
  assert.equal(code, 1, out);
  assert.match(out, /UNPARSEABLE/);
});

test('a missing log file is rejected, not treated as clean', () => {
  const { code, out } = run(path.join(tmpRoot, 'does-not-exist.log'));
  assert.equal(code, 1, out);
  assert.match(out, /MISSING LOG/);
});

test('the guard refuses to run with no expectations (no vacuous pass)', () => {
  const p = writeLog(GOOD_LOG);
  const r = spawnSync(process.execPath, [script, p], { encoding: 'utf8' });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /REFUSING/);
});

test('there is no env var that can relax or redirect the guard', () => {
  // An env-redirected guard has already been a bug in this repo once
  // (NVGW_PACKAGE_OUTPUT_DIRECTORY neutered a packaging check). Assert the source
  // reads no environment at all, so that cannot recur here.
  const src = fs.readFileSync(script, 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/process\.env/.test(code), 'assert-tap-proof.mjs must not read process.env');
});
