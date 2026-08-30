import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function loadTypeScriptExports(relative) {
  const compiled = typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { Error, exports: module.exports, module }, { filename: relative });
  return module.exports;
}

const LOCALE_NAMES = ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar'];

// ───────────────────────────────────────────────────────────────────────────
// DEFECT: the save toast hides where the file went.
//
// FeedbackModal.tsx saves the report through window.electronAPI.feedback.save(),
// whose FeedbackResult carries `path` (src/renderer/global.d.ts:83-87). The
// modal shows t('feedback_success') — "Feedback saved" — and never reads
// result.path. The entire point of this flow is that nothing is transmitted and
// the USER shares the file themselves (feedback_localNote says so), which is
// impossible if the app will not say where the file is.
//
// REQUIRED BEHAVIOUR: on success the toast names the path, localized in all 7
// locales, and stays honest — saved locally, sharing is the user's choice.
// ───────────────────────────────────────────────────────────────────────────

test('the success toast reports the saved path when the save returns one', () => {
  const modal = read('src/renderer/components/FeedbackModal.tsx');

  assert.match(modal, /result\.path/,
    'FeedbackResult.path is returned by the save and must no longer be discarded');

  assert.match(modal, /t\(\s*['"]feedback_savedTo['"]\s*,\s*\{\s*path:\s*result\.path/,
    'the toast must render the localized saved-to string with the real path interpolated');

  // The pathless case must still be handled: `path` is optional in
  // FeedbackResult, so a success without one must not produce "undefined".
  assert.match(modal, /feedback_success/,
    'the pathless success case must keep its existing message as a fallback');
});

test('the saved-to string exists in all 7 locales and interpolates the path', () => {
  const exports = loadTypeScriptExports('src/renderer/i18n/resources.ts');

  for (const locale of LOCALE_NAMES) {
    const value = exports[locale].feedback_savedTo;
    assert.ok(typeof value === 'string' && value.trim().length > 0,
      `${locale} must define feedback_savedTo`);
    assert.match(value, /\{\{path\}\}/,
      `${locale}.feedback_savedTo must interpolate {{path}}, otherwise it cannot name the file`);
  }
});

test('every locale stays key-complete and the key count grew by exactly one', () => {
  const exports = loadTypeScriptExports('src/renderer/i18n/resources.ts');

  const enKeys = Object.keys(exports.en);
  assert.equal(enKeys.length, 293,
    'measured baseline was 292 keys per locale; this defect adds exactly one');

  for (const locale of LOCALE_NAMES) {
    const localeKeys = Object.keys(exports[locale]);
    const missing = enKeys.filter((key) => !localeKeys.includes(key));
    const extra = localeKeys.filter((key) => !enKeys.includes(key));
    assert.deepEqual(missing, [], `${locale} is missing keys: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${locale} has keys EN does not define: ${extra.join(', ')}`);
    assert.equal(localeKeys.length, 293, `${locale} must hold 293 keys`);
  }
});

test('the saved-to string is a real translation, not English left in place', () => {
  const exports = loadTypeScriptExports('src/renderer/i18n/resources.ts');

  // Script is what actually distinguishes a translation from a copy-paste.
  assert.match(exports.ar.feedback_savedTo, /[\u0600-\u06FF]/, 'the Arabic string must be in Arabic script');
  assert.match(exports.hi.feedback_savedTo, /[\u0900-\u097F]/, 'the Hindi string must be in Devanagari script');
  assert.match(exports.zh.feedback_savedTo, /[\u4E00-\u9FFF]/, 'the Chinese string must be in Han script');
  assert.match(exports.ru.feedback_savedTo, /[\u0400-\u04FF]/, 'the Russian string must be in Cyrillic script');

  // fr and es share the Latin script with en, so require they differ from en.
  for (const locale of ['fr', 'es']) {
    assert.notEqual(exports[locale].feedback_savedTo, exports.en.feedback_savedTo,
      `${locale} must be translated, not the English string verbatim`);
  }
});

test('the saved-to string does not promise transmission in any locale', () => {
  const exports = loadTypeScriptExports('src/renderer/i18n/resources.ts');

  // Same discipline tests/feedback-honest-save-label.test.mjs pins for the rest
  // of this modal: nothing here is sent, so no copy may say it was.
  const TRANSMISSION_VERBS = {
    en: ['send', 'sent', 'submit', 'upload'],
    ru: ['отправ', 'загруз'],
    zh: ['发送', '提交', '上传'],
    es: ['enviar', 'enviado', 'subir'],
    hi: ['भेज'],
    fr: ['envoyer', 'envoyé', 'envoi', 'soumettre'],
    ar: ['إرسال', 'ارسال', 'رفع']
  };

  const offenders = [];
  for (const locale of LOCALE_NAMES) {
    const lowered = String(exports[locale].feedback_savedTo).toLowerCase();
    for (const verb of TRANSMISSION_VERBS[locale]) {
      if (lowered.includes(verb)) offenders.push(`${locale}: contains "${verb}"`);
    }
  }
  assert.deepEqual(offenders, [],
    `the report is written to a local file and is not transmitted:\n  ${offenders.join('\n  ')}`);
});
