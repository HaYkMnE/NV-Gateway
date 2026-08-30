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

// ───────────────────────────────────────────────────────────────────────────
// DEFECT: the feedback primary button promised transmission it does not perform.
//
// FeedbackModal.tsx calls window.electronAPI.feedback.save(), which reaches
// saveFeedback() in src/main/feedback-service.ts. That function writes
// feedback.jsonl under userData and performs NO network call — automatic
// transmission was deliberately removed for privacy, and
// tests/privacy-no-auto-transmission.test.mjs pins that.
//
// The button nevertheless rendered t('feedback_send') — "Send" / "Отправить" /
// "发送" / "Enviar" / "भेजें" / "Envoyer" / "إرسال". Nothing is sent, so the
// label was a false promise in all 7 locales, and the surrounding copy repeated
// it: the modal title said "Send Feedback" and the checkbox said "Attach" a
// diagnostic log, both of which describe an upload.
//
// REQUIRED BEHAVIOUR: the primary action names SAVING, in idiomatic wording per
// language, and the modal states that the report is written to a local file the
// user can share themselves. The key is renamed too — a key called
// `feedback_send` holding "Save" would move the lie into the source.
// ───────────────────────────────────────────────────────────────────────────

/** Every locale exported by the i18n module. */
const LOCALE_NAMES = ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar'];

/**
 * Verbs that promise transmission. If one of these appears in the primary
 * action label, the button is claiming to send something.
 */
const TRANSMISSION_VERBS = {
  en: ['send', 'submit', 'upload'],
  ru: ['отправ', 'загруз'],
  zh: ['发送', '提交', '上传'],
  es: ['enviar', 'envía', 'subir'],
  hi: ['भेज'],
  fr: ['envoyer', 'envoi', 'soumettre'],
  ar: ['إرسال', 'ارسال', 'رفع']
};

/** The idiomatic SAVE verb each locale is expected to use instead. */
const SAVE_VERBS = {
  en: ['save'],
  ru: ['сохран'],
  zh: ['保存'],
  es: ['guardar'],
  hi: ['सहेज'],
  fr: ['enregistrer'],
  ar: ['حفظ']
};

test('the i18n module exports exactly the 7 expected locales', () => {
  const exports = loadTypeScriptExports('src/renderer/i18n/resources.ts');
  const exported = Object.keys(exports).filter((name) => exports[name] && typeof exports[name] === 'object');
  assert.deepEqual(exported.sort(), [...LOCALE_NAMES].sort(),
    'the locale set is the contract every translation key must satisfy');
  assert.equal(exported.length, 7, 'measured: 7 locales, not 8');
});

test('every locale stays key-complete with EN', () => {
  const exports = loadTypeScriptExports('src/renderer/i18n/resources.ts');
  const enKeys = Object.keys(exports.en).sort();
  for (const locale of LOCALE_NAMES) {
    if (locale === 'en') continue;
    const localeKeys = Object.keys(exports[locale]).sort();
    const missing = enKeys.filter((key) => !localeKeys.includes(key));
    const extra = localeKeys.filter((key) => !enKeys.includes(key));
    assert.deepEqual(missing, [], `${locale} is missing keys: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${locale} has keys EN does not define: ${extra.join(', ')}`);
  }
});

test('the feedback modal primary action names SAVING, not sending', () => {
  const modal = read('src/renderer/components/FeedbackModal.tsx');

  // The lying key must be gone from the source entirely, so a future reader
  // cannot reintroduce the promise by trusting the key name.
  assert.doesNotMatch(modal, /feedback_send/,
    'FeedbackModal must not reference feedback_send: the handler calls save(), which transmits nothing');
  assert.match(modal, /t\(['"]feedback_save['"]\)/,
    'the primary button must render the honest save label');

  // And the handler it is wired to must genuinely be the local save.
  assert.match(modal, /window\.electronAPI\.feedback\s*\n?\s*\.save\(/,
    'the primary action must call the local save path');
});

test('the save label is an honest save verb in all 7 locales', () => {
  const exports = loadTypeScriptExports('src/renderer/i18n/resources.ts');

  const dishonest = [];
  const missingSaveVerb = [];
  for (const locale of LOCALE_NAMES) {
    const label = exports[locale].feedback_save;
    assert.ok(typeof label === 'string' && label.length > 0,
      `${locale} must define feedback_save`);
    const lowered = label.toLowerCase();
    for (const verb of TRANSMISSION_VERBS[locale]) {
      if (lowered.includes(verb)) dishonest.push(`${locale}: "${label}" contains transmission verb "${verb}"`);
    }
    if (!SAVE_VERBS[locale].some((verb) => lowered.includes(verb))) {
      missingSaveVerb.push(`${locale}: "${label}"`);
    }
  }

  assert.deepEqual(dishonest, [],
    `the button saves to a local file and must not promise transmission:\n  ${dishonest.join('\n  ')}`);
  assert.deepEqual(missingSaveVerb, [],
    `each locale must use its own idiomatic save verb:\n  ${missingSaveVerb.join('\n  ')}`);

  // feedback_send must no longer exist anywhere: renaming, not shadowing.
  for (const locale of LOCALE_NAMES) {
    assert.equal('feedback_send' in exports[locale], false,
      `${locale} must not keep the old feedback_send key`);
  }
});

test('surrounding modal copy does not imply transmission either', () => {
  const exports = loadTypeScriptExports('src/renderer/i18n/resources.ts');

  // The modal title and the diagnostic checkbox both described an upload. They
  // frame the whole dialog, so an honest button under a "Send Feedback" heading
  // would still mislead.
  const offenders = [];
  for (const locale of LOCALE_NAMES) {
    for (const key of ['feedback_title', 'feedback_attachDiagnostic']) {
      const value = exports[locale][key];
      const lowered = String(value).toLowerCase();
      for (const verb of TRANSMISSION_VERBS[locale]) {
        if (lowered.includes(verb)) offenders.push(`${locale}.${key}: "${value}" contains "${verb}"`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `nothing in this modal is transmitted, so its copy must not say so:\n  ${offenders.join('\n  ')}`);
});

test('the modal tells the user the report is a local file they can share', () => {
  const exports = loadTypeScriptExports('src/renderer/i18n/resources.ts');
  const modal = read('src/renderer/components/FeedbackModal.tsx');

  assert.match(modal, /t\(['"]feedback_localNote['"]\)/,
    'the modal must render an explanation that the report is saved locally');

  for (const locale of LOCALE_NAMES) {
    const note = exports[locale].feedback_localNote;
    assert.ok(typeof note === 'string' && note.trim().length > 0,
      `${locale} must define feedback_localNote so the honest explanation is localized`);
  }

  // The note must not itself promise an upload.
  const offenders = [];
  for (const locale of LOCALE_NAMES) {
    const lowered = String(exports[locale].feedback_localNote).toLowerCase();
    for (const verb of TRANSMISSION_VERBS[locale]) {
      if (lowered.includes(verb)) offenders.push(`${locale}: contains "${verb}"`);
    }
  }
  assert.deepEqual(offenders, [],
    `the local-file note must not promise transmission:\n  ${offenders.join('\n  ')}`);
});
