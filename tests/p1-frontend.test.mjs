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

test('frontend helpers define paired-port validation and complete data states', () => {
  const helpers = read('src/renderer/lib/frontend-state.ts');
  assert.match(helpers, /port >= 1 && port <= 65534/);
  for (const state of ['loading', 'empty', 'error', 'stale', 'success']) assert.match(helpers, new RegExp(`'${state}'`));
});

test('error helpers require a localized fallback and preserve nonempty error messages', () => {
  const stateSource = read('src/renderer/lib/frontend-state.ts');
  const behaviorSource = read('src/renderer/lib/frontend-behavior.ts');
  const { safeError } = loadTypeScriptExports('src/renderer/lib/frontend-state.ts');
  const { mutationFailure } = loadTypeScriptExports('src/renderer/lib/frontend-behavior.ts');
  const unknownLabel = 'Неизвестная ошибка';

  for (const error of [null, new Error('')]) {
    assert.equal(safeError(error, unknownLabel), unknownLabel);
    const result = mutationFailure('delete', error, unknownLabel);
    assert.equal(result.kind, 'delete');
    assert.equal(result.message, unknownLabel);
  }
  assert.equal(safeError(new Error('denied'), unknownLabel), 'denied');
  const result = mutationFailure('delete', new Error('denied'), unknownLabel);
  assert.equal(result.kind, 'delete');
  assert.equal(result.message, 'denied');
  assert.doesNotMatch(stateSource, /Unknown error/);
  assert.doesNotMatch(behaviorSource, /Unknown error/);

  // Strengthening: every view callsite that renders an error message must pass a
  // localized label (t('unknown_error')) as the second argument to safeError, so
  // a future view callsite that hardcodes or omits the fallback is caught. The
  // helper-level contract above only guards the helper; this guards the callsites.
  for (const [name, source] of [
    ['Dashboard', read('src/renderer/views/Dashboard.tsx')],
    ['Logs', read('src/renderer/views/Logs.tsx')],
  ]) {
    const callsites = source.match(/safeError\(/g) || [];
    assert.ok(callsites.length > 0, `${name} must call safeError at its error callsites`);
    assert.match(source, /safeError\([^,]*,\s*t\(['"]unknown_error['"]\)\)/,
      `${name} must pass t('unknown_error') as the second arg to safeError so the fallback is localized`);
  }
});

test('Russian translation is statically constrained to every English key', () => {
  const translations = fs.readFileSync(path.join(root, 'src/renderer/i18n/resources.ts'), 'utf8');
  assert.match(translations, /Record<keyof typeof en, string>/);
});

// Round 75 strengthening: used-keys ⊆ defined-keys. Every static t('key')
// callsite key across every view file (src/renderer/views/*.tsx) AND
// src/renderer/components/Layout.tsx AND src/renderer/App.tsx must exist in the
// EN resources object. This catches the class of defect where a callsite key
// goes missing from both EN and RU (i18next's default missing-key behavior
// returns the raw key string, so both locales render an untranslated
// snake_case literal). Dynamic template literals (t(`gateway_${state}`)) and
// bare-variable calls (t(masked), t(errorKey)) are excluded since their keys
// are not statically extractable; the static keys inside ternary calls
// (t(cond ? 'a' : 'b')) ARE extracted on both branches.
test('every static t() callsite key used by views, Layout, and App is defined in the EN resources', () => {
  const en = loadTypeScriptExports('src/renderer/i18n/resources.ts').en;
  const enKeys = new Set(Object.keys(en));

  // Scan every view + Layout + App. App.tsx also renders the hydration-error
  // fallback and retry control, so its t() callsites must be covered too.
  const targets = [];
  for (const file of fs.readdirSync(path.join(root, 'src/renderer/views'))) {
    if (file.endsWith('.tsx')) targets.push(`src/renderer/views/${file}`);
  }
  targets.push('src/renderer/components/Layout.tsx');
  targets.push('src/renderer/App.tsx');

  const staticKeyPattern = /\bt\(\s*(['"])([A-Za-z0-9_]+)\1\s*\)/g;
  // Ternary calls: t(<cond> ? 'a' : 'b') — extract both static branch literals.
  const ternaryPattern = /\bt\([^?]*\?\s*(['"])([A-Za-z0-9_]+)\1\s*:\s*(['"])([A-Za-z0-9_]+)\3\s*\)/g;

  const usedKeys = new Set();
  const errors = [];
  for (const relative of targets) {
    const source = read(relative);
    let m;
    while ((m = staticKeyPattern.exec(source)) !== null) {
      const key = m[2];
      usedKeys.add(key);
      if (!enKeys.has(key)) {
        errors.push(`${relative}: missing EN key from t('${key}')`);
      }
    }
    while ((m = ternaryPattern.exec(source)) !== null) {
      for (const key of [m[2], m[4]]) {
        usedKeys.add(key);
        if (!enKeys.has(key)) {
          errors.push(`${relative}: missing EN key from ternary branch '${key}'`);
        }
      }
    }
  }

  // Sanity: the scanner must find a non-trivial number of keys, otherwise the
  // regex has rotted and the guard is vacuous.
  assert.ok(usedKeys.size >= 50,
    `the static-key scanner must extract at least 50 used keys (found ${usedKeys.size}); if far fewer, the regex has rotted`);
  // Targeted sanity: well-known callsite keys that must be captured.
  for (const known of ['loading', 'retry', 'settings', 'port', 'version']) {
    assert.ok(usedKeys.has(known),
      `scanner must capture the well-known static callsite key '${known}' (regression guard for the regex itself)`);
  }

  // Defect under test: Settings.tsx calls five keys that were historically
  // missing from both EN and RU. Assert each is now both USED and DEFINED.
  for (const defectKey of ['confirm_reset', 'settings_error', 'auto_launch_error', 'current_status', 'reset_wizard']) {
    assert.ok(usedKeys.has(defectKey),
      `Settings.tsx must call t('${defectKey}') — the defect-scanner must observe this callsite`);
    assert.ok(enKeys.has(defectKey),
      `EN resources must define '${defectKey}' (was missing before the Round 75 fix)`);
  }

  if (errors.length > 0) {
    assert.fail(`Missing EN keys for t() callsites (${errors.length}):\n  - ${errors.join('\n  - ')}`);
  }
});

// Round 76 strengthening: the used⊆defined scanner above only extracts STATIC
// t('literal') callsites. Wizard.tsx renders port-scan candidates via a
// transformation callsite: t(state.replace('-', '_')) (Wizard.tsx:62), where
// `state` is a member of the closed `Scan` union ('available' | 'in-use' |
// 'unknown' | 'error') defined at Wizard.tsx:10. After .replace('-', '_') the
// keyspace becomes {available, in_use, unknown, error}. The static scanner
// cannot see these (the argument is a method-call expression, not a string
// literal), so a missing key here is invisible to the guard above. The catch
// block at Wizard.tsx:31 sets every candidate's state to 'error', so t('error')
// is called for each rejected row — if 'error' is absent from resources,
// i18next returns the raw key and EN/RU users see the literal token 'error'.
// This test hardcodes the post-replacement keyspace of the Scan union and
// asserts every member is defined in EN (and, via the Record<keyof typeof en,
// string> constraint, RU too). It also detects the t(...replace('-', '_'))
// callsite pattern so future drift of this transformation is flagged for
// manual re-enumeration of the union.
test('every Wizard.Scan-union post-replace key (t(state.replace("-","_"))) is defined in EN and RU resources', () => {
  const exports = loadTypeScriptExports('src/renderer/i18n/resources.ts');
  const en = exports.en;
  const ru = exports.ru;
  const enKeys = new Set(Object.keys(en));
  const ruKeys = new Set(Object.keys(ru));

  // Hardcoded enumeration of the `Scan` type union members after the
  // `.replace('-', '_')` transformation applied in Wizard.tsx:62.
  // 'in-use' -> 'in_use'; the other three have no hyphen and pass through.
  const scanUnionKeys = ['available', 'in_use', 'unknown', 'error'];

  const missingEn = [];
  const missingRu = [];
  for (const key of scanUnionKeys) {
    if (!enKeys.has(key)) missingEn.push(key);
    if (!ruKeys.has(key)) missingRu.push(key);
  }
  assert.equal(missingEn.length, 0,
    `EN resources must define every Wizard.Scan-union post-replace key (missing: ${missingEn.join(', ')}). ` +
    `Wizard.tsx:62 calls t(state.replace('-', '_')) for each scan candidate; the catch at Wizard.tsx:31 ` +
    `sets state='error' for every rejected row, so t('error') is called and must resolve to a localized label ` +
    `rather than i18next's raw-key fallback.`);
  assert.equal(missingRu.length, 0,
    `RU resources must define every Wizard.Scan-union post-replace key (missing: ${missingRu.join(', ')}). ` +
    `The Record<keyof typeof en, string> constraint guarantees RU mirrors EN, but assert explicitly for clarity.`);

  // Regression guard: Wizard.tsx must STILL contain the transformation
  // callsite this enumeration was derived from. If the callsite is removed or
  // refactored, the hardcoded union above must be re-validated against the
  // new code; this assertion makes that coupling explicit.
  const wizardSource = read('src/renderer/views/Wizard.tsx');
  assert.match(wizardSource, /t\(state\.replace\(['"]-['"],\s*['"]_['"]\)\)/,
    `Wizard.tsx must retain the t(state.replace('-', '_')) callsite that this Scan-union enumeration was derived from; ` +
    `if it has been refactored, re-derive the post-replace keyspace from the new code and update scanUnionKeys in this test.`);

  // Defensive: also confirm the 'error' value is a localized label, not the
  // raw key string (guards against a regression where the key is added with a
  // placeholder value equal to the key itself).
  assert.ok(typeof en.error === 'string' && en.error.length > 0 && en.error !== 'error',
    `EN 'error' must be a localized label, not the raw key 'error' (got '${en.error}')`);
  assert.ok(typeof ru.error === 'string' && ru.error.length > 0 && ru.error !== 'error',
    `RU 'error' must be a localized label, not the raw key 'error' (got '${ru.error}')`);
});

test('wizard and global CSS retain constrained geometry and accessibility contracts', () => {
  const wizard = fs.readFileSync(path.join(root, 'src/renderer/views/Wizard.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src/renderer/index.css'), 'utf8');
  assert.match(wizard, /overflow-y-auto/);
  assert.match(wizard, /max-h-\[calc\(100vh-2rem\)\]/);
  assert.match(wizard, /aria-live/);
  assert.match(wizard, /type="radio"/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});

test('behavior helpers cover hydration, sequencing, mutations, logs, ports, and mobile menu', async () => {
  const helpers = await import('../build/src/renderer/lib/frontend-behavior.js');
  assert.deepEqual(helpers.reduceHydration({ state: 'loading' }, { type: 'reject', message: 'offline' }), { state: 'error', message: 'offline' });
  assert.equal(helpers.acceptLatestSequence(2, 1), false);
  assert.equal(helpers.acceptLatestSequence(2, 2), true);
  assert.deepEqual(helpers.mutationFailure('delete', new Error('denied'), 'Unknown'), { kind: 'delete', message: 'denied' });
  assert.equal(helpers.isNearBottom({ scrollTop: 700, clientHeight: 300, scrollHeight: 1020 }), true);
  assert.equal(helpers.isNearBottom({ scrollTop: 500, clientHeight: 300, scrollHeight: 1020 }), false);
  assert.equal(helpers.selectRecommendedPort({ changeMode: false, currentPort: 12000, currentPairAvailable: false, recommendedPort: 13000 }), '13000');
  assert.equal(helpers.selectRecommendedPort({ changeMode: true, currentPort: 12000, currentPairAvailable: false, recommendedPort: 13000 }), '12000');
  assert.equal(helpers.reduceMenu(true, { type: 'escape' }), false);
});

test('P1 UI contracts are present and visible literals are translated', () => {
  const app = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf8');
  const layout = fs.readFileSync(path.join(root, 'src/renderer/components/Layout.tsx'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'src/renderer/views/Dashboard.tsx'), 'utf8');
  const logs = fs.readFileSync(path.join(root, 'src/renderer/views/Logs.tsx'), 'utf8');
  const wizard = fs.readFileSync(path.join(root, 'src/renderer/views/Wizard.tsx'), 'utf8');
  assert.match(app, /hydration_error/); assert.match(app, /retryHydration/);
  assert.match(layout, /aria-expanded/); assert.match(layout, /aria-controls/); assert.match(layout, /md:hidden/); assert.match(layout, /refetchInterval/);
  assert.match(dashboard, /mutation_error/); assert.doesNotMatch(dashboard, />Details</);
  assert.match(logs, /role="log"/); assert.match(logs, /<ol/); assert.match(logs, /<li/); assert.match(logs, /isNearBottom/);
  assert.match(wizard, /<Logo/); assert.match(wizard, /selectRecommendedPort/);
});
