import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const LOCALE_NAMES = ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar'];

function loadTypeScriptExports(relative) {
  const compiled = typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { Error, exports: module.exports, module }, { filename: relative });
  return module.exports;
}

test('each dialog X button uses its own context-specific localized close label', () => {
  const targets = [
    ['FeedbackModal', 'src/renderer/components/FeedbackModal.tsx', 'feedback_closeDialog'],
    ['AboutDialog', 'src/renderer/components/AboutDialog.tsx', 'about_closeDialog'],
    ['SendErrorsDialog', 'src/renderer/views/Logs.tsx', 'errors_closeDialog'],
  ];

  for (const [name, relative, key] of targets) {
    const source = read(relative);
    assert.match(source, new RegExp(`aria-label=\\{t\\(['\"]${key}['\"]\\)\\}`),
      `${name} X button must use t('${key}') so its accessible name identifies the dialog it closes`);
  }

  for (const [name, relative] of targets) {
    assert.doesNotMatch(read(relative), /aria-label=\{t\(['"]close_menu['"]\)\}/,
      `${name} must not name a dialog close control "Close menu"`);
  }
});

test('all seven locales provide truthful context-specific dialog close labels', () => {
  const resources = loadTypeScriptExports('src/renderer/i18n/resources.ts');
  const expectations = {
    feedback_closeDialog: {
      en: /feedback/i, ru: /обратн/i, zh: /反馈/, es: /comentarios/i,
      hi: /फ़ीडबैक/, fr: /commentaires/i, ar: /الملاحظات/
    },
    about_closeDialog: {
      en: /about/i, ru: /программ/i, zh: /关于/, es: /acerca/i,
      hi: /परिचय/, fr: /à propos/i, ar: /حول/
    },
    errors_closeDialog: {
      en: /error/i, ru: /ошиб/i, zh: /错误/, es: /errores/i,
      hi: /त्रुटि/, fr: /erreurs/i, ar: /الأخطاء/
    },
  };

  for (const [key, localePatterns] of Object.entries(expectations)) {
    for (const locale of LOCALE_NAMES) {
      const value = resources[locale][key];
      assert.ok(typeof value === 'string' && value.trim().length > 0,
        `${locale}.${key} must be a non-empty localized string`);
      assert.match(value, localePatterns[locale],
        `${locale}.${key} must identify the dialog rather than generically naming a menu`);
      assert.notEqual(value, resources[locale].close_menu,
        `${locale}.${key} must not reuse the generic close-menu label`);
    }
  }
});

test('Endpoint copy success has exactly one dedicated polite live announcement without duplicating failure output', () => {
  const endpoint = read('src/renderer/views/Endpoint.tsx');
  const liveRegions = endpoint.match(/<p[^>]*className="sr-only"[^>]*aria-live="polite"[^>]*>[\s\S]*?<\/p>/g)
    || endpoint.match(/<p[^>]*aria-live="polite"[^>]*className="sr-only"[^>]*>[\s\S]*?<\/p>/g)
    || [];

  assert.equal(liveRegions.length, 1,
    `Endpoint must render exactly one sr-only aria-live="polite" region (found ${liveRegions.length})`);
  assert.match(liveRegions[0], /\{copyFeedback\}/,
    'the polite live region must carry only Endpoint copy-success feedback');
  assert.doesNotMatch(liveRegions[0], /copyError|copy_failed/,
    'copy failure already uses role="alert" and must not also be spoken by the polite region');

  const copyHandler = endpoint.match(/const copy = async \(text: string, field: string\) => \{[\s\S]*?\n  \};/);
  assert.ok(copyHandler, 'Endpoint must retain its copy handler');
  assert.match(copyHandler[0], /announceCopySuccess\(t\(['"]copied['"]\)\)/,
    'successful clipboard writes must announce the localized Copied message');
  assert.doesNotMatch(copyHandler[0], /catch[\s\S]*announceCopySuccess/,
    'the failure path must rely on its existing role=alert rather than duplicate polite output');
  assert.match(endpoint, /\{copyError && \(\s*<div role="alert"/,
    'the existing copy-failure role=alert must remain');
});
