import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const require = createRequire(path.join(root, 'package.json'));

/** Evaluate a TypeScript module's exports, as the sibling i18n tests do. */
function loadTypeScriptExports(relative) {
  const ts = require('typescript');
  const js = ts.transpileModule(read(relative), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const module_ = { exports: {} };
  new Function('exports', 'module', 'require', js)(module_.exports, module_, require);
  return module_.exports;
}

const LOCALE_NAMES = ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar'];

// ───────────────────────────────────────────────────────────────────────────
// DEFECT: the oversized-copy failure message in the Logs view is uninformative.
//
// views/Logs.tsx catches a failed copy with a BINDING-LESS `catch {` and calls
// announce(t('copy_failed')) -> "Copy failed". It is the only one of the five
// copy modules that throws the error object away: Dashboard, Endpoint and Models
// all append safeError(...) detail. Main rejects an oversized payload with the
// deliberately generic "Invalid clipboard text." (src/main/index.ts:668-671 --
// generic on purpose, so the credential is never echoed), so a user who copied a
// ~1 MB log view is told only "Copy failed" and cannot tell a SIZE refusal from a
// permission or unknown failure, and has no actionable next step.
//
// REQUIRED BEHAVIOUR: an oversized failure must be distinguishable from any
// other failure, Logs must carry the error detail like its siblings, and the
// message must not promise a retry that does not exist.
//
// CONSTRAINT MEASURED BEFORE DESIGNING THE FIX: two existing tests bound the
// solution and neither may be edited.
//   * tests/clipboard-write-via-main.test.mjs:133 pins the exact literal
//     announce(t('copy_failed')) in Logs.
//   * tests/feedback-save-path-visible.test.mjs:68,77 pins every locale at
//     EXACTLY 301 keys, so a brand-new i18n key would break a passing test.
// The fix therefore composes the already-localized keys clipboard_failed,
// feedback_charCount ("{{count}}/{{max}} characters") and unknown_error, and
// classification lives in a pure, directly testable helper.
// ───────────────────────────────────────────────────────────────────────────

test('the renderer clipboard cap matches the cap main actually enforces', () => {
  // The renderer must classify "too large" against the SAME bound main enforces.
  // Asserted against main's source so the two can never drift apart silently.
  const { CLIPBOARD_TEXT_MAX } = loadTypeScriptExports('src/renderer/lib/frontend-state.ts');
  assert.equal(typeof CLIPBOARD_TEXT_MAX, 'number',
    'the renderer must know the clipboard cap to explain a size refusal');

  const main = read('src/main/index.ts');
  const declared = /const CLIPBOARD_TEXT_MAX\s*=\s*([\d_]+);/.exec(main);
  assert.ok(declared, 'main must declare CLIPBOARD_TEXT_MAX');
  assert.equal(CLIPBOARD_TEXT_MAX, Number(declared[1].replace(/_/g, '')),
    'the renderer cap must equal the cap main enforces, or the UI will explain the wrong bound');
});

test('the oversize classifier is inclusive at the cap, exactly like main', () => {
  // main rejects only length > cap, so the cap itself is VALID. An off-by-one
  // here would blame size for a failure that was really a permission problem.
  const { CLIPBOARD_TEXT_MAX, isOversizedForClipboard } =
    loadTypeScriptExports('src/renderer/lib/frontend-state.ts');
  assert.equal(typeof isOversizedForClipboard, 'function',
    'a pure classifier must exist so the message logic is testable without a DOM');

  assert.equal(isOversizedForClipboard(0), false);
  assert.equal(isOversizedForClipboard(CLIPBOARD_TEXT_MAX - 1), false);
  assert.equal(isOversizedForClipboard(CLIPBOARD_TEXT_MAX), false,
    'the cap is inclusive in main (length > MAX rejects), so the cap itself is not oversized');
  assert.equal(isOversizedForClipboard(CLIPBOARD_TEXT_MAX + 1), true,
    'one character past the cap is what main refuses');
});

test('the Logs copy handler keeps the error object instead of discarding it', () => {
  const logs = read('src/renderer/views/Logs.tsx');
  const copy = /const copy = async \(\) => \{[\s\S]*?\n  \};/.exec(logs);
  assert.ok(copy, 'the Logs copy handler must be present');
  const body = copy[0];

  assert.doesNotMatch(body, /catch\s*\{/,
    'a binding-less `catch {` throws the error away: Logs was the only copy module '
    + 'that discarded it, which is why the user got no detail');
  assert.match(body, /catch\s*\(\s*error\s*\)/,
    'the caught error must be bound so its detail can reach the user');
  assert.match(body, /safeError\(\s*error/,
    'Logs must append error detail via safeError like Dashboard, Endpoint and Models');
});

test('an oversized copy is reported differently from any other copy failure', () => {
  const logs = read('src/renderer/views/Logs.tsx');
  const copy = /const copy = async \(\) => \{[\s\S]*?\n  \};/.exec(logs)[0];

  assert.match(copy, /isOversizedForClipboard\(/,
    'the handler must classify the payload size to explain a size refusal');
  // The size branch must state the actual measured size against the bound;
  // "Copy failed" alone is what made this defect.
  assert.match(copy, /feedback_charCount/,
    'the size branch must report count/max characters so the cause is visible');
  assert.match(copy, /count:\s*text\.length/,
    'the reported count must be the real payload length, not a guess');
});

test('the failure detail reaches a visible surface, not only the live region', () => {
  const logs = read('src/renderer/views/Logs.tsx');
  assert.match(logs, /copyError/,
    'the detail needs its own state, since the live region only carries the short announcement');
  assert.match(logs, /\{copyError && <div role="alert"/,
    'a copy failure must render in a role="alert" banner, matching Dashboard');
});

test('every string the failure message composes exists in all 7 locales', () => {
  const exports_ = loadTypeScriptExports('src/renderer/i18n/resources.ts');
  for (const key of ['copy_failed', 'clipboard_failed', 'feedback_charCount', 'unknown_error']) {
    for (const locale of LOCALE_NAMES) {
      const value = exports_[locale][key];
      assert.ok(typeof value === 'string' && value.trim().length > 0,
        `${locale}.${key} must be a real localized string`);
    }
  }
  // feedback_charCount is what makes the size visible; it must interpolate both.
  for (const locale of LOCALE_NAMES) {
    const value = String(exports_[locale].feedback_charCount);
    assert.match(value, /\{\{count\}\}/, `${locale}.feedback_charCount must interpolate {{count}}`);
    assert.match(value, /\{\{max\}\}/, `${locale}.feedback_charCount must interpolate {{max}}`);
  }
});

test('the fix adds no new i18n key, so every locale stays key-complete at 301', () => {
  // Composing existing localized strings keeps the sibling contract intact
  // (tests/feedback-save-path-visible.test.mjs pins exactly 301) and avoids
  // shipping machine-translated English.
  const exports_ = loadTypeScriptExports('src/renderer/i18n/resources.ts');
  const enKeys = Object.keys(exports_.en);
  assert.equal(enKeys.length, 301, 'EN must stay at 301 keys');
  for (const locale of LOCALE_NAMES) {
    const keys = Object.keys(exports_[locale]);
    assert.equal(keys.length, 301, `${locale} must hold 301 keys`);
    assert.deepEqual(enKeys.filter((k) => !keys.includes(k)), [], `${locale} is missing keys`);
  }
});

test('the copy failure message promises no retry that does not exist', () => {
  const exports_ = loadTypeScriptExports('src/renderer/i18n/resources.ts');
  const logs = read('src/renderer/views/Logs.tsx');
  const copy = /const copy = async \(\) => \{[\s\S]*?\n  \};/.exec(logs)[0];
  // Whatever keys the handler composes, none of them may tell the user the app
  // will try again on its own -- nothing retries a copy.
  for (const match of copy.matchAll(/t\('([a-z_]+)'/g)) {
    const value = String(exports_.en[match[1]] ?? '');
    assert.equal(/try again|retrying|will retry|automatically/i.test(value), false,
      `${match[1]} must not promise an automatic retry: "${value}"`);
  }
});
