import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import typescript from 'typescript';

// Regression tests for the idle-CPU feedback loop:
//
//   App.tsx's retryHydration useCallback listed `t` in its dependency array and
//   called i18n.changeLanguage(state.language) unconditionally. i18next emits
//   `languageChanged` even when the language has NOT changed (verified against
//   the i18next@23 dist source AND live in this file below). react-i18next's
//   useTranslation subscribes `boundReset` -> setT(getNewT) to that event, so
//   every emission hands a NEW `t` identity -> App re-renders -> retryHydration
//   is rebuilt -> the effect [retryHydration] re-fires -> changeLanguage again.
//   The loop never stops: ~600 DOM mutations/s of <html lang> sets and ~90% of
//   one CPU core burned in the renderer while the app sits idle.
//
// The fix has two independent edges, each alone sufficient to break the loop:
//   1. App.tsx reads `t` through a tRef (the pattern PetWidget.tsx already
//      uses) so the callback identity is stable across translator churn.
//   2. config.ts exports applyStoredLanguage(), which early-returns when the
//      requested language already matches i18n.resolvedLanguage, so a no-op
//      re-application never emits `languageChanged` at all.
//
// Written RED-first (TDD): the wiring tests fail against the unfixed tree.
// Executable parts run the REAL config.ts + REAL resources through the
// project's transpileModule+vm convention (extended with a require hook so
// config.ts's relative/node_modules imports resolve); wiring that cannot run
// outside a renderer (React hook identity) is asserted statically.

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function loadTsModule(relative, sandboxExtra = {}) {
  const compiled = typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, esModuleInterop: true }
  });
  const module = { exports: {} };
  const dir = path.dirname(relative).split(path.sep).join('/');
  const localRequire = (id) => {
    if (id.startsWith('.')) {
      let resolved = path.posix.join(dir, id);
      if (!resolved.endsWith('.ts')) resolved += '.ts';
      return loadTsModule(resolved, sandboxExtra);
    }
    return require(id);
  };
  const sandbox = {
    module, exports: module.exports, require: localRequire,
    console, Error, setTimeout, clearTimeout, queueMicrotask,
    ...sandboxExtra
  };
  vm.runInNewContext(compiled.outputText, sandbox, { filename: relative });
  return module.exports;
}

// ── 1. App.tsx wiring: retryHydration must be identity-stable across t churn ──
test('App.tsx: retryHydration does not depend on `t` and reads it through a tRef', () => {
  const app = read('src/renderer/App.tsx');

  const block = app.match(/const retryHydration = useCallback\(async \(\) => \{[\s\S]*?\n  \}, \[([^\]]*)\]\);/);
  assert.ok(block, 'App.tsx must define retryHydration via useCallback(async () => {...}, [deps])');

  const deps = block[1].split(',').map((d) => d.trim());
  assert.ok(!deps.includes('t'),
    `retryHydration deps [${block[1]}] must NOT include \`t\`: react-i18next hands a new t identity on every ` +
    `'languageChanged' emission, so a t dependency rebuilds the callback and re-fires the hydration effect, ` +
    `closing the changeLanguage -> languageChanged -> new t -> re-hydrate loop`);

  // The callback body must apply the stored language through the guarded helper,
  // never via a bare i18n.changeLanguage(state.language) (which emits even on no-op).
  assert.match(block[0], /applyStoredLanguage\(state\.language\)/,
    'retryHydration must apply the stored language via applyStoredLanguage() (the resolvedLanguage-guarded helper)');
  assert.doesNotMatch(block[0], /i18n\.changeLanguage\(/,
    'retryHydration must NOT call i18n.changeLanguage directly: i18next emits languageChanged even when the language is unchanged');

  // The error path still needs a translator, but read through the tRef pattern
  // (same as PetWidget.tsx) so it costs no callback-identity churn.
  assert.match(app, /const tRef = useRef\(t\)/, 'App.tsx must keep a tRef (useRef(t)) — the PetWidget pattern for translator churn');
  assert.match(app, /tRef\.current = t/, 'App.tsx must sync tRef.current = t on render');
  assert.match(block[0], /tRef\.current\('unknown_error'\)/,
    "retryHydration's error path must translate via tRef.current('unknown_error'), not the render-scoped t");

  // The reactive render-scoped `t` must remain for the loading/error UI so the
  // pre-hydration screens still re-render on a language change.
  assert.match(app, /const \{ t \} = useTranslation\(\)/, 'App must still take the reactive t from useTranslation for its render body');
});

// ── 2. config.ts wiring: guarded applyStoredLanguage + preserved lang setter ──
test('config.ts: applyStoredLanguage early-returns on the resolved language and the <html lang> wiring survives', () => {
  const config = read('src/renderer/i18n/config.ts');

  assert.match(config, /export\s+(async\s+function|const)\s+applyStoredLanguage/,
    'config.ts must export applyStoredLanguage()');
  assert.match(config, /i18n\.resolvedLanguage/,
    'applyStoredLanguage must compare the requested language against i18n.resolvedLanguage and early-return on a match');
  assert.match(config, /i18n\.changeLanguage\(/,
    'applyStoredLanguage must still call i18n.changeLanguage for a genuine language change');

  // The <html lang> setter is the legitimate consumer of languageChanged — it
  // must stay; the defect is the loop that spams it, not the setter itself.
  assert.match(config, /i18n\.on\('languageChanged', \(language\) => \{ document\.documentElement\.lang = language; \}\)/,
    'the languageChanged -> document.documentElement.lang wiring must be preserved (real language switches must still update <html lang>)');

  // No new user-visible strings are needed by this fix: the 301-key per-locale
  // invariant pinned by feedback-save-path-visible/logs-copy-failure-detail
  // must be untouched.
  const { en, ru } = loadTsModule('src/renderer/i18n/resources.ts');
  assert.equal(Object.keys(en).length, 301, 'en must still carry exactly 301 keys');
  assert.equal(Object.keys(ru).length, 301, 'ru must still carry exactly 301 keys');
});

// ── 3. Executable: the guard breaks the emission edge on the real i18n instance ──
test('applyStoredLanguage: no-op applications emit nothing; genuine switches emit once and really translate', async () => {
  const docStub = { documentElement: { lang: '' } };
  const cfg = loadTsModule('src/renderer/i18n/config.ts', { document: docStub });
  const i18n = cfg.default ?? cfg;
  assert.equal(typeof cfg.applyStoredLanguage, 'function',
    'config.ts must export applyStoredLanguage(language) — the guarded application used by App hydration');

  const emissions = [];
  i18n.on('languageChanged', (l) => { emissions.push(l); });

  // Boot steady state: config inits at 'en'; the stored language is 'en'.
  assert.equal(i18n.resolvedLanguage, 'en', 'fixture: fresh config resolves to en');
  await cfg.applyStoredLanguage('en');
  assert.deepEqual(emissions, [],
    'applying the already-active language must emit ZERO languageChanged events — this is the edge that closed the idle loop');
  assert.equal(docStub.documentElement.lang, '', 'a no-op application must not touch <html lang>');

  // A genuine switch en -> ru must still work end to end: exactly one emission,
  // resolvedLanguage flips, <html lang> follows, and t() actually translates.
  await cfg.applyStoredLanguage('ru');
  assert.deepEqual(emissions, ['ru'], 'a genuine language switch must emit exactly once');
  assert.equal(i18n.resolvedLanguage, 'ru');
  assert.equal(docStub.documentElement.lang, 'ru', '<html lang> must follow genuine switches');
  const { en, ru } = loadTsModule('src/renderer/i18n/resources.ts');
  assert.equal(i18n.t('loading'), ru.loading, 'after switching to ru, t(loading) must return the RU string');
  assert.notEqual(ru.loading, en.loading, 'fixture sanity: RU and EN loading strings differ');

  // And back ru -> en.
  await cfg.applyStoredLanguage('en');
  assert.deepEqual(emissions, ['ru', 'en'], 'switching back must emit exactly once more');
  assert.equal(i18n.resolvedLanguage, 'en');
  assert.equal(i18n.t('loading'), en.loading, 'after switching back, t(loading) must return the EN string');

  // Post-switch steady state is silent again.
  await cfg.applyStoredLanguage('en');
  assert.deepEqual(emissions, ['ru', 'en'], 're-applying the active language after a switch must stay silent');

  // A falsy stored language must be a no-op (defensive: config without language).
  await cfg.applyStoredLanguage(undefined);
  assert.deepEqual(emissions, ['ru', 'en'], 'undefined language must be a no-op');
});

// ── 4. Executable: the closed feedback topology terminates instead of spinning ──
test('a subscriber that re-runs hydration on every languageChanged cannot cascade (the exact App loop topology)', async () => {
  const docStub = { documentElement: { lang: '' } };
  const cfg = loadTsModule('src/renderer/i18n/config.ts', { document: docStub });
  const i18n = cfg.default ?? cfg;
  assert.equal(typeof cfg.applyStoredLanguage, 'function');

  // Model the renderer loop: a hydration run applies the stored language; any
  // languageChanged emission re-runs hydration (what the buggy effect chain did).
  const stored = { language: 'en' };
  const MAX_RUNS = 25;
  let hydrationRuns = 0;
  let emissions = 0;
  const hydrateOnce = async () => {
    hydrationRuns += 1;
    if (hydrationRuns > MAX_RUNS) return; // cap so a cascade terminates the test run instead of hanging it
    await cfg.applyStoredLanguage(stored.language);
  };
  i18n.on('languageChanged', () => { emissions += 1; void hydrateOnce(); });

  await hydrateOnce();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(hydrationRuns, 1,
    'with the stored language already active, hydration must run exactly once — the emission feedback loop is broken ' +
    `(got ${hydrationRuns} runs; the unfixed code spins forever at ~500 changeLanguage+IPC calls/s)`);
  assert.equal(emissions, 0, 'steady state must produce ZERO languageChanged emissions');

  // A genuine stored-language change: exactly ONE emission, which reactively
  // re-runs hydration exactly once (the re-run is a guarded no-op), then the
  // system is quiescent. The invariant is BOUNDED TERMINATION, not zero runs.
  stored.language = 'fr';
  await hydrateOnce();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(emissions, 1, 'one genuine language change -> exactly one languageChanged emission (no cascade)');
  assert.equal(hydrationRuns, 3,
    'the single emission re-runs hydration exactly once (initial + change + one reactive no-op re-run) and then stops — quiescent');
  assert.equal(i18n.resolvedLanguage, 'fr');
});

// ── 5. Characterization (documents WHY the guard exists; green before+after) ──
test('characterization: i18next emits languageChanged even for a same-language changeLanguage', async () => {
  const i18next = require('i18next');
  const instance = i18next.createInstance();
  await instance.init({ lng: 'en', resources: { en: { translation: { k: 'v' } } }, fallbackLng: 'en' });

  let emissions = 0;
  instance.on('languageChanged', () => { emissions += 1; });
  await instance.changeLanguage('en'); // already the active language
  assert.equal(emissions, 1,
    'i18next@23 emits languageChanged on a no-op changeLanguage (dist source: done() emits unconditionally) — ' +
    'this is why the resolvedLanguage guard in applyStoredLanguage must exist');
});
