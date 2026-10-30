// Enforces the single source of truth for the renderer i18n key contract
// (tests/support/i18n-contract.mjs):
//   (a) every locale in resources.ts holds exactly EXPECTED_LOCALE_KEY_COUNT
//       keys, with two-way key parity against en;
//   (b) the locales exported by resources.ts and registered in i18n/config.ts
//       are exactly LOCALE_NAMES, in order;
//   (c) no test file hard-codes the current count next to i18n words, so the
//       next key bump stays a one-constant change.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { EXPECTED_LOCALE_KEY_COUNT, LOCALE_NAMES } from './support/i18n-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(root, 'tests');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const require = createRequire(path.join(root, 'package.json'));

/** Evaluate a TypeScript module's exports (transpileModule, as the pin tests do). */
function loadTypeScriptExports(relative) {
  const ts = require('typescript');
  const js = ts.transpileModule(read(relative), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const module_ = { exports: {} };
  new Function('exports', 'module', 'require', js)(module_.exports, module_, require);
  return module_.exports;
}

test(`(a) every locale holds exactly EXPECTED_LOCALE_KEY_COUNT (${EXPECTED_LOCALE_KEY_COUNT}) keys with two-way parity`, () => {
  assert.ok(Number.isSafeInteger(EXPECTED_LOCALE_KEY_COUNT) && EXPECTED_LOCALE_KEY_COUNT > 0,
    'EXPECTED_LOCALE_KEY_COUNT must be a positive integer');
  const resources = loadTypeScriptExports('src/renderer/i18n/resources.ts');
  const enKeys = Object.keys(resources.en ?? {});
  for (const locale of LOCALE_NAMES) {
    const keys = Object.keys(resources[locale] ?? {});
    assert.equal(keys.length, EXPECTED_LOCALE_KEY_COUNT,
      `${locale} holds ${keys.length} keys but tests/support/i18n-contract.mjs expects EXPECTED_LOCALE_KEY_COUNT=${EXPECTED_LOCALE_KEY_COUNT}`);
    const missing = enKeys.filter((k) => !Object.hasOwn(resources[locale], k));
    const extra = keys.filter((k) => !Object.hasOwn(resources.en, k));
    assert.deepEqual(missing, [], `${locale} is missing keys: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${locale} has keys en does not define: ${extra.join(', ')}`);
  }
});

test('(b) resources.ts exports and i18n/config.ts registers exactly LOCALE_NAMES', () => {
  const resources = loadTypeScriptExports('src/renderer/i18n/resources.ts');
  assert.deepEqual(Object.keys(resources), [...LOCALE_NAMES],
    'the locales exported by resources.ts must equal LOCALE_NAMES (tests/support/i18n-contract.mjs)');

  const config = read('src/renderer/i18n/config.ts');
  const imported = config.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/resources['"]/);
  assert.ok(imported, 'config.ts must import its locales from ./resources');
  assert.deepEqual(imported[1].split(',').map((s) => s.trim()).filter(Boolean), [...LOCALE_NAMES],
    'config.ts must import exactly LOCALE_NAMES from ./resources');

  const block = config.match(/resources:\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(block, 'config.ts must pass a resources object to i18n.init');
  const registered = [...block[1].matchAll(/(\w+)\s*:\s*\{\s*translation\s*:\s*(\w+)\s*\}/g)];
  assert.deepEqual(registered.map((m) => m[1]), [...LOCALE_NAMES],
    'config.ts must register exactly LOCALE_NAMES with i18next');
  for (const [, name, value] of registered) {
    assert.equal(value, name, `config.ts must map ${name} to its own translation table`);
  }
});

// Files that legitimately contain the current number for a NON-i18n reason
// (e.g. a byte count). Empty today; add a file here only with a reason.
const NON_I18N_ALLOWLIST = new Set([]);
const EXCLUDED = new Set([
  path.join(testsDir, 'support', 'i18n-contract.mjs'), // the single source of truth itself
  fileURLToPath(import.meta.url)
]);

function listTestSources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...listTestSources(full)); }
    else if (/\.(mjs|cjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Find the current count, as a standalone number, within ~80 chars of an i18n word. */
function findHardCodedCount(text, count) {
  const hits = [];
  const number = new RegExp(`(?<![\\d_.])${count}(?![\\d_])`, 'g');
  for (const match of text.matchAll(number)) {
    const window = text.slice(Math.max(0, match.index - 80), match.index + String(count).length + 80);
    if (/key|locale|i18n/i.test(window)) hits.push(text.slice(0, match.index).split('\n').length);
  }
  return hits;
}

test('(c) no test hard-codes the current key count next to i18n words', () => {
  const offenders = [];
  for (const file of listTestSources(testsDir)) {
    if (EXCLUDED.has(file) || NON_I18N_ALLOWLIST.has(path.relative(testsDir, file).split(path.sep).join('/'))) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('\0')) continue; // binary fixture, not source
    for (const line of findHardCodedCount(text, EXPECTED_LOCALE_KEY_COUNT)) {
      offenders.push(`${path.relative(root, file)}:${line}`);
    }
  }
  assert.deepEqual(offenders, [],
    `hard-coded i18n key count ${EXPECTED_LOCALE_KEY_COUNT}; import EXPECTED_LOCALE_KEY_COUNT from tests/support/i18n-contract.mjs instead: ${offenders.join(', ')}`);
});

test('(c) the scanner itself flags a planted hard-coded count and ignores non-i18n numbers', () => {
  const n = EXPECTED_LOCALE_KEY_COUNT;
  assert.deepEqual(findHardCodedCount(`assert.equal(keys.length, ${n}, 'en keys');`, n), [1]);
  assert.deepEqual(findHardCodedCount(`const bytes = ${n}0; const t = 1${n};`, n), []);
  assert.deepEqual(findHardCodedCount(`const payloadBytes = ${n};`, n), []);
});
