// Regression test for the W5b-7 NSIS guard in tests/w5b-release-guards.test.mjs.
//
// MEASURED DEFECT (CodeRabbit deep audit, W-Q wave): the test asserted only that
// two HKCU `DeleteRegValue` lines existed, while its own comment promised the
// HKCU deletes are NOT followed by a blanket ClearErrors. A count-only check
// passes after someone adds `ClearErrors` under them — hiding a real HKCU delete
// failure, which is exactly the regression the comment forbids.
//
// This drives the assertion logic against mutated copies of build/installer.nsh,
// so the fix is proven to be sensitive in BOTH directions: the real file passes,
// and a file with a blanket ClearErrors under HKCU fails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const includePath = path.join(root, 'build', 'installer.nsh');

// Mirrors the HKCU half of W5b-7. Kept in sync by the cross-check below, which
// fails if the guard in w5b-release-guards.test.mjs ever drops the ClearErrors
// assertion again.
function hkcuClearErrorsViolations(source) {
  const lines = source.split('\n');
  const violations = [];
  const hkcu = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => /^DeleteRegValue\s+HKCU\b/.test(line));
  if (hkcu.length !== 2) violations.push(`expected 2 HKCU deletes, found ${hkcu.length}`);
  for (const { line, index } of hkcu) {
    const after = lines.slice(index + 1, index + 3).map((entry) => entry.trim());
    if (after.includes('ClearErrors')) violations.push(`ClearErrors follows "${line}"`);
  }
  return violations;
}

test('the real installer.nsh has no ClearErrors after either HKCU delete', () => {
  assert.deepEqual(hkcuClearErrorsViolations(fs.readFileSync(includePath, 'utf8')), []);
});

test('THE REGRESSION: a blanket ClearErrors after an HKCU delete is detected', () => {
  const original = fs.readFileSync(includePath, 'utf8');
  const injected = original.replace(
    /(DeleteRegValue\s+HKCU\s+"Software\\Microsoft\\Windows\\CurrentVersion\\Run"\s+"electron\.app\.NV-Gateway"\n)/,
    '$1  ClearErrors\n'
  );
  assert.notEqual(injected, original, 'the fixture must actually inject a ClearErrors line');
  const violations = hkcuClearErrorsViolations(injected);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.match(violations[0], /ClearErrors follows .*HKCU/);
});

test('the w5b guard itself asserts the ClearErrors placement (not just a count)', () => {
  const guard = fs.readFileSync(path.join(root, 'tests', 'w5b-release-guards.test.mjs'), 'utf8');
  const section = guard.slice(guard.indexOf('The HKCU deletes must NOT be followed'));
  const body = section.slice(0, section.indexOf('});'));
  assert.match(body, /ClearErrors/, 'the HKCU half must name ClearErrors');
  assert.match(body, /after\.includes\('ClearErrors'\)/, 'the HKCU half must inspect the following lines');
  assert.match(body, /assert\.equal\(after\.includes\('ClearErrors'\), false/,
    'the assertion must require ClearErrors to be ABSENT, not merely mention it');
});
