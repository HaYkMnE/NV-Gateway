// Е-1b UI: the Settings «Request deadline» field. The renderer has no React
// test harness, so the pure validation / seconds<->ms logic lives in
// src/renderer/views/requestDeadline.ts and is executed here through the
// project's transpileModule+vm convention; Settings.tsx wiring is asserted
// statically (it cannot run outside a renderer).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function loadTsModule(relative) {
  const compiled = typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports }, { filename: relative });
  return module.exports;
}

const deadline = loadTsModule('src/renderer/views/requestDeadline.ts');

test('validation mirrors the port_* codes: required | integer | range', () => {
  const v = deadline.validateDeadlineSeconds;
  assert.equal(v(''), 'required');
  assert.equal(v('   '), 'required');
  for (const bad of ['1.5', 'abc', '1e3', '0x10', '12s', '\u0662\u0664\u0660']) assert.equal(v(bad), 'integer', bad);
  for (const out of ['0', '1801', '-5', '999999']) assert.equal(v(out), 'range', out);
  for (const ok of ['1', '240', '1800', ' 60 ']) assert.equal(v(ok), null, ok);
});

test('seconds -> ms only for valid input (an invalid value is never converted/sent)', () => {
  assert.equal(deadline.deadlineSecondsToMs('240'), 240000);
  assert.equal(deadline.deadlineSecondsToMs('1'), 1000);
  assert.equal(deadline.deadlineSecondsToMs('1800'), 1800000);
  assert.equal(deadline.deadlineSecondsToMs(' 60 '), 60000);
  for (const bad of ['', '1.5', '0', '1801', 'x']) assert.equal(deadline.deadlineSecondsToMs(bad), null, bad);
});

test('display: effective ms shown in seconds as-is; missing/invalid falls back to 240', () => {
  assert.equal(deadline.formatDeadlineSeconds(240000), '240');
  assert.equal(deadline.formatDeadlineSeconds(1500), '1.5');
  assert.equal(deadline.formatDeadlineSeconds(Number.NaN), '240');
  assert.equal(deadline.formatDeadlineSeconds(0), '240');
  assert.equal(deadline.DEADLINE_DEFAULT_SECONDS, 240);
});

test('aria-describedby always has the help text, plus error/env ids only when shown', () => {
  const d = deadline.deadlineDescribedBy;
  assert.equal(d({ error: false, env: false }), 'request-deadline-help');
  assert.equal(d({ error: true, env: false }), 'request-deadline-help request-deadline-error');
  assert.equal(d({ error: false, env: true }), 'request-deadline-help request-deadline-env');
  assert.equal(d({ error: true, env: true }), 'request-deadline-help request-deadline-error request-deadline-env');
});

test('ENV note splits around the interpolated variable name', () => {
  // Spread into a main-realm array: the module runs in a vm context, so its arrays have a foreign prototype.
  assert.deepEqual([...deadline.splitAtPlaceholder('Set by A, so no.', 'A')], ['Set by ', ', so no.']);
  assert.equal(deadline.splitAtPlaceholder('no marker', 'A'), null);
});

test('Settings.tsx wiring: placement, ENV read-only, commit only through the validated converter', () => {
  const src = read('src/renderer/views/Settings.tsx');
  const mode = src.indexOf("aria-label={t('models_mode_label')}");
  const field = src.indexOf('<RequestDeadlineSection');
  const auto = src.indexOf("t('auto_launch')");
  assert.ok(mode > 0 && field > mode && auto > field, 'section sits between performance mode and auto-launch');
  assert.match(src, /id="request-deadline"[^>]*dir="ltr"[^>]*inputMode="numeric"/);
  assert.match(src, /readOnly=\{readOnly\}/);
  assert.match(src, /const readOnly = envLocked \|\| save\.isPending;/);
  assert.match(src, /aria-readonly=\{envLocked \|\| undefined\}/);
  assert.match(src, /const envLocked = source === 'env'/);
  assert.match(src, /const ms = deadlineSecondsToMs\(draft\);\s*if \(ms === null\)/);
  assert.match(src, /setAppConfig\(\{ requestDeadlineMs \}\)/);
  assert.match(src, /invalidateQueries\(\{ queryKey: queryKeys\.runtime \}\)/);
  // Unit suffix removed: every locale's deadline_label already names the unit (seconds).
  assert.doesNotMatch(src, />\s*s\s*<\/span>/);
});

test('Settings.tsx deadline states: ENV read-only look, invalid state, saved live region', () => {
  const src = read('src/renderer/views/Settings.tsx');
  // ENV read-only: distinct class (dashed muted border, card bg, default cursor) + decorative lock icon.
  // Readonly focus: dashed muted outline, not the accent ring; padding class carries no state variant.
  assert.match(src, /envLocked \? 'request-deadline-readonly ps-9 rtl:ps-3 rtl:pe-9 bg-surface border-dashed border-textMuted cursor-default focus-visible:outline-1 focus-visible:outline-dashed focus-visible:outline-textMuted'/);
  const readonlyCls = src.match(/'request-deadline-readonly[^']*'/)[0];
  // Readonly focus ring is 1px (quieter next to the dashed border), never 2px.
  assert.match(readonlyCls, /focus-visible:outline-1(?![\d])/);
  assert.doesNotMatch(readonlyCls, /outline-2/);
  // Arabic: digits stay LTR but align to the lock side; physical rtl:text-right (text-end would resolve against dir="ltr").
  const inputTag = src.slice(src.indexOf('<input id="request-deadline" dir="ltr"'), src.indexOf('request-deadline-lock'));
  assert.match(inputTag.match(/className=\{`[^`]*`\}/)[0], /rtl:text-right/);
  assert.doesNotMatch(src.slice(src.indexOf('function RequestDeadlineSection'), src.indexOf('function ModelsSection')), /text-end/);
  assert.doesNotMatch(readonlyCls, /(focus|focus-visible|hover|active|disabled|read-only):p/);
  assert.doesNotMatch(readonlyCls, /outline-nvidia/);
  // The input is dir="ltr", so its own ps-* always means left; the lock follows the PAGE direction.
  // Under an RTL page the pad must move to the lock side (right). Direction-only, never state-dependent.
  assert.match(readonlyCls, /ps-9 rtl:ps-3 rtl:pe-9/);
  // Lock: aria-hidden span that is a SIBLING after the input (outside the input and its className branch), z-1, no pointer events.
  const input = src.indexOf('<input id="request-deadline"');
  const inputEnd = src.indexOf('/>', input);
  const lock = src.indexOf('<span aria-hidden="true" className="request-deadline-lock');
  const rowEnd = src.indexOf('</div>', inputEnd);
  assert.ok(input > 0 && lock > inputEnd && lock < rowEnd, 'lock span is a sibling after the input, inside the row');
  assert.match(src, /\{envLocked && <span aria-hidden="true" className="request-deadline-lock pointer-events-none absolute start-2\.5 top-1\/2 z-\[1\][^"]*"><Lock size=\{14\} \/><\/span>\}/);
  assert.doesNotMatch(src, /<Lock aria-hidden="true"[^>]*start-3/);
  assert.doesNotMatch(src, /request-deadline-readonly[^']*(opacity|text-error|border-error)/);
  // Invalid: aria-invalid kept, error-red border AND error-red focus outline, 2px focus-visible outline with offset, aria-hidden alert icon.
  assert.match(src, /aria-invalid=\{Boolean\(validation\)\}/);
  assert.match(src, /validation \? 'ps-3 bg-bg border-error focus-visible:outline focus-visible:outline-2 focus-visible:outline-error'/);
  assert.match(src, /: 'ps-3 bg-bg border-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-nvidia'/);
  assert.match(src, /font-mono text-textMain rtl:text-right focus-visible:outline-offset-2 \$\{envLocked/);
  assert.match(src, /id="request-deadline-error" role="alert"[^>]*><CircleAlert aria-hidden="true"/);
  // Saved: polite live region, accent colour (not the neon success token), aria-hidden check icon.
  assert.match(src, /<p role="status" aria-live="polite" className="[^"]*text-nvidia[^"]*mt-1[^"]*">\{showSaved \? <><Check aria-hidden="true"/);
  assert.doesNotMatch(src.slice(src.indexOf('function RequestDeadlineSection'), src.indexOf('function ModelsSection')), /text-success/);
  // RTL: dir="ltr" on the input only, not on the row wrapper.
  assert.match(src, /<input id="request-deadline" dir="ltr"/);
  assert.match(src, /<div className="relative flex items-center gap-2 w-fit">\s*<input id="request-deadline"/);
  // Row wrapper: the last <div before the input, up to its closing '>', must carry no dir attribute (any attribute order).
  assert.ok(input >= 0, 'request-deadline input marker found');
  const rowStart = src.lastIndexOf('<div', input);
  const rowTag = src.slice(rowStart, src.indexOf('>', rowStart) + 1);
  assert.ok(rowStart >= 0 && rowTag.startsWith('<div'), 'row wrapper opening tag extracted');
  assert.doesNotMatch(rowTag, /\bdir=/);
});

test('every locale deadline_label names the unit (why no separate unit suffix is rendered)', () => {
  const res = read('src/renderer/i18n/resources.ts');
  const labels = [...res.matchAll(/"?deadline_label"?\s*:\s*(['"])(.*?)\1/g)].map((m) => m[2]);
  assert.equal(labels.length, 7);
  const unit = [/\(seconds\)/, /\(секунды\)/, /（秒）/, /\(segundos\)/, /\(सेकंड\)/, /\(secondes\)/, /\(بالثواني\)/];
  for (const re of unit) assert.ok(labels.some((l) => re.test(l)), `a locale label matches ${re}`);
});
