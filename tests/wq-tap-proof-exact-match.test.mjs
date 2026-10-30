// Regression test for scripts/assert-tap-proof.mjs: --require-ok must match the
// test NAME EXACTLY, never as a substring.
//
// MEASURED DEFECT (CodeRabbit deep audit, W-Q wave): the lookup was
// `lines.find((l) => /^ok \d+ - /.test(l) && l.includes(name))`, so
// `--require-ok=Foo` was satisfied by a passing test named `FooBar`. The guard
// then "proves" an assertion ran that never did — the same vacuous-pass class
// the script exists to prevent (see tests/assert-tap-proof.test.mjs).
//
// These cases run the real script as a subprocess against real TAP-shaped logs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts', 'assert-tap-proof.mjs');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-wq-tapproof-${process.pid}-`));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;
function writeLog(okNames) {
  const lines = ['TAP version 13'];
  okNames.forEach((name, index) => {
    lines.push(`# Subtest: ${name}`);
    lines.push(`ok ${index + 1} - ${name}`);
    lines.push('  ---');
    lines.push('  duration_ms: 1.0');
    lines.push('  ...');
  });
  lines.push(`1..${okNames.length}`);
  lines.push(`# tests ${okNames.length}`);
  lines.push('# suites 0');
  lines.push(`# pass ${okNames.length}`);
  lines.push('# fail 0');
  lines.push('# cancelled 0');
  lines.push('# skipped 0');
  lines.push('# todo 0');
  lines.push('');
  const file = path.join(tmpRoot, `log-${seq++}.log`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

function run(logPath, ...expectations) {
  const r = spawnSync(process.execPath, [script, logPath, ...expectations], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('a PREFIX of a passing test name no longer satisfies --require-ok', () => {
  // The exact defect: FooBar passes, Foo was required.
  const { code, out } = run(writeLog(['FooBar']), '--require-ok=Foo');
  assert.equal(code, 1, `FooBar must NOT satisfy --require-ok=Foo: ${out}`);
  assert.match(out, /MISSING : Foo/);
  assert.match(out, /PACKAGED_ASSERTIONS_NOT_PROVEN/);
});

test('a SUFFIX or infix of a passing test name does not satisfy --require-ok', () => {
  const prefixed = run(writeLog(['Prefix Foo']), '--require-ok=Foo');
  assert.equal(prefixed.code, 1, prefixed.out);
  assert.match(prefixed.out, /MISSING : Foo/);

  const infixed = run(writeLog(['a Foo b']), '--require-ok=Foo');
  assert.equal(infixed.code, 1, infixed.out);
  assert.match(infixed.out, /MISSING : Foo/);
});

test('the exact name still passes, including the CI names with punctuation and spaces', () => {
  const name = 'the packaged engine lives INSIDE app.asar';
  const { code, out } = run(writeLog([name]), `--require-ok=${name}`);
  assert.equal(code, 0, out);
  assert.match(out, /ALL_PACKAGED_ASSERTIONS_EXECUTED/);
});

test('an exact name followed by a TAP directive is still recognised as neutralised', () => {
  // The directive is a SEPARATE token after ` # `, so the name match must strip
  // it — otherwise a real name would read as MISSING instead of NEUTRALISED.
  const name = 'Foo';
  const file = path.join(tmpRoot, `log-${seq++}.log`);
  fs.writeFileSync(file, [
    'TAP version 13',
    `# Subtest: ${name}`,
    `ok 1 - ${name} # SKIP not today`,
    '1..1',
    '# tests 1',
    '# suites 0',
    '# pass 0',
    '# fail 0',
    '# cancelled 0',
    '# skipped 1',
    '# todo 0',
    ''
  ].join('\n'), 'utf8');
  const { code, out } = run(file, `--require-ok=${name}`);
  assert.equal(code, 1, out);
  assert.match(out, /NEUTRALISED \(SKIP\)/);
});

test('a name that only occurs in a nested subtest line is not a top-level proof', () => {
  // The script proves top-level `ok` lines only; a name mentioned in a
  // `# Subtest:` header or in a diagnostic must not count.
  const file = path.join(tmpRoot, `log-${seq++}.log`);
  fs.writeFileSync(file, [
    'TAP version 13',
    '# Subtest: Foo',
    'ok 1 - something else',
    '  ---',
    '  name: Foo',
    '  ...',
    '1..1',
    '# tests 1',
    '# suites 0',
    '# pass 1',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    ''
  ].join('\n'), 'utf8');
  const { code, out } = run(file, '--require-ok=Foo');
  assert.equal(code, 1, out);
  assert.match(out, /MISSING : Foo/);
});
