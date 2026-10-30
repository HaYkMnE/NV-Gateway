import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
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
// DEFECT: the new honest copy is invisible to assistive technology.
//
// 151e275 added feedback_localNote — the sentence stating that nothing is
// transmitted and the report is a local file — as a bare <p> sitting next to the
// buttons. A <p> carries no programmatic relationship to any control, so a
// screen-reader user who tabs to the primary button hears only "Save Report" and
// never the disclosure. The entire point of that commit is that the user
// understands what the button does, so an unreachable note defeats it for exactly
// the users who cannot see the layout.
//
// REQUIRED BEHAVIOUR: the note is referenced by the control it explains, via
// aria-describedby on the save button itself.
// ───────────────────────────────────────────────────────────────────────────

const LOCALE_NAMES = ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar'];

test('the local-file note is programmatically associated with the save button', () => {
  const modal = read('src/renderer/components/FeedbackModal.tsx');

  const noteElement = /id=["']([\w-]+)["'][^>]*>[^<]*\{t\(['"]feedback_localNote['"]\)\}/s.exec(modal);
  assert.ok(noteElement,
    'the element rendering feedback_localNote must carry an id so a control can reference it');

  const id = noteElement[1];
  assert.match(modal, new RegExp(`aria-describedby=["']${id}["']`),
    `the save button must reference the note via aria-describedby="${id}", otherwise a screen-reader user never hears that nothing is transmitted`);

  // The association must sit on the control the note explains: the primary button
  // wired to the local save handler, not some unrelated element.
  const fromSaveHandler = modal.slice(modal.indexOf('onClick={handleSave}'));
  const buttonEnd = fromSaveHandler.indexOf('</button>');
  assert.ok(buttonEnd > 0, 'the save button must be locatable');
  assert.match(fromSaveHandler.slice(0, buttonEnd), new RegExp(`aria-describedby=["']${id}["']`),
    'aria-describedby must sit on the save button itself');
});

test('the localized note is a real translation in every locale, including ar and hi', () => {
  const exports = loadTypeScriptExports('src/renderer/i18n/resources.ts');

  // A disclosure nobody can read is not a disclosure. Script is what actually
  // distinguishes a translated string from an English one left in place.
  assert.match(exports.ar.feedback_localNote, /[\u0600-\u06FF]/, 'the Arabic note must be in Arabic script');
  assert.match(exports.hi.feedback_localNote, /[\u0900-\u097F]/, 'the Hindi note must be in Devanagari script');
  assert.match(exports.ar.feedback_save, /[\u0600-\u06FF]/, 'the Arabic save label must be in Arabic script');
  assert.match(exports.hi.feedback_save, /[\u0900-\u097F]/, 'the Hindi save label must be in Devanagari script');

  for (const locale of LOCALE_NAMES) {
    assert.ok(String(exports[locale].feedback_localNote).trim().length > 0,
      `${locale} must define a non-empty feedback_localNote`);
  }
});
