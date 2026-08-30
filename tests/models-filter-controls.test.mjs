import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// Same loader tests/feedback-save-path-visible.test.mjs uses: transpile the TS to
// CommonJS and run it in a bare context. The sandbox deliberately exposes only
// { Error, exports, module }, so the module under test MUST stay import-free.
function loadTypeScriptExports(relative) {
  const compiled = typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { Error, exports: module.exports, module }, { filename: relative });
  return module.exports;
}

const LOCALE_NAMES = ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar'];

const NEW_KEYS = [
  'models_filter_popularity_label',
  'models_filter_popularity_any',
  'models_filter_popularity_threshold',
  'models_filter_labels_label',
  'models_filter_free_only',
  'models_filter_downloadable_only',
  'models_filter_reset',
  'models_filter_results'
];

// ───────────────────────────────────────────────────────────────────────────
// FEATURE (user bug list П8): the Models view offers a search box, a sort
// select and company chips, but nothing narrows the list by the metadata the
// catalogue already carries.
//
// nvidia-catalog-sync.mjs recordToMetadata() (lines 236-334) produces
// popularity (int >= 0, never null — parseIntSafe), labels (string[]),
// downloadable and freeEndpoint (booleans). admin-api.mjs:247-265 forwards all
// of them and main/models-ipc.ts mapModelCatalog() threads them to the
// renderer, so they are genuinely present client-side.
//
// REQUIRED BEHAVIOUR: a minimum-popularity threshold, any-of label chips and
// two boolean toggles, all COMPOSING with the existing search + company chips,
// with a visible result count and a one-click reset.
// ───────────────────────────────────────────────────────────────────────────

const FILTER_LIB = 'src/renderer/lib/models-filter.ts';

const MODELS = [
  { id: 'nvidia/llama-3.3-nemotron-super-49b', publisher: 'nvidia', labels: ['Agent', 'Frontier'], popularity: 2_000_000, lastUpdated: '2026-08-01T00:00:00Z', downloadable: true, freeEndpoint: true, shortDescription: 'Nemotron reasoning model' },
  { id: 'z-ai/glm-5.2', publisher: 'z-ai', labels: ['Frontier'], popularity: 50_000, lastUpdated: '2026-07-01T00:00:00Z', downloadable: false, freeEndpoint: true, shortDescription: 'GLM frontier chat' },
  { id: 'meta/llama-4-maverick', publisher: 'meta', labels: ['Agent'], popularity: 5_000, lastUpdated: '2026-06-01T00:00:00Z', downloadable: true, freeEndpoint: false, shortDescription: 'Maverick instruct' },
  // No NGC catalogue match: popularity falls back to 0, labels to [].
  { id: 'obscure/unlisted-model', publisher: 'obscure', labels: [], popularity: 0, lastUpdated: null, downloadable: false, freeEndpoint: false, shortDescription: '' }
];

const ids = (list) => list.map((m) => m.id);

test('the filter module exists and is import-free so it stays unit-testable', () => {
  const source = read(FILTER_LIB);
  assert.doesNotMatch(source, /^\s*import\s/m,
    'models-filter.ts must not import anything: the vm harness gives it no module resolver');
});

test('a minimum-popularity threshold narrows the list', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const base = lib.DEFAULT_MODEL_FILTERS;

  assert.equal(base.minPopularity, 0, 'the default must not hide anything');
  assert.deepEqual(ids(lib.applyModelFilters(MODELS, base)).sort(), ids(MODELS).sort(),
    'the default filter state must pass every model through');

  const over10k = lib.applyModelFilters(MODELS, { ...base, minPopularity: 10_000 });
  assert.deepEqual(ids(over10k), ['nvidia/llama-3.3-nemotron-super-49b', 'z-ai/glm-5.2'],
    'only models at or above the threshold survive, most popular first');

  const over1m = lib.applyModelFilters(MODELS, { ...base, minPopularity: 1_000_000 });
  assert.deepEqual(ids(over1m), ['nvidia/llama-3.3-nemotron-super-49b']);

  assert.ok(Array.isArray(lib.POPULARITY_THRESHOLDS) && lib.POPULARITY_THRESHOLDS[0] === 0,
    'the threshold choices must start at 0 = "any"');
});

test('a model with no catalogue match (popularity 0) survives the default state', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const passed = lib.applyModelFilters(MODELS, lib.DEFAULT_MODEL_FILTERS);
  assert.ok(ids(passed).includes('obscure/unlisted-model'),
    'a filter that silently drops unmatched models by default is worse than no filter');
});

test('label chips filter as any-of and are derived from the real data', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const base = lib.DEFAULT_MODEL_FILTERS;

  // Spread before comparing: collectModelLabels builds its result with
  // Array.from INSIDE the vm realm, so the returned array has that realm's
  // Array.prototype and deepStrictEqual would fail on prototype identity alone
  // (measured). Spreading re-homes it so the assertion judges CONTENT.
  assert.deepEqual([...lib.collectModelLabels(MODELS)], ['Agent', 'Frontier'],
    'the label universe must be deduped, sorted and taken from the loaded models');

  const agents = lib.applyModelFilters(MODELS, { ...base, labels: ['Agent'] });
  assert.deepEqual(ids(agents), ['nvidia/llama-3.3-nemotron-super-49b', 'meta/llama-4-maverick']);

  const either = lib.applyModelFilters(MODELS, { ...base, labels: ['Agent', 'Frontier'] });
  assert.equal(either.length, 3,
    'two selected labels must widen (any-of), not collapse to an intersection');
});

test('the free-endpoint and downloadable toggles only ever hide when switched on', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const base = lib.DEFAULT_MODEL_FILTERS;

  assert.equal(base.freeOnly, false);
  assert.equal(base.downloadableOnly, false);

  const free = lib.applyModelFilters(MODELS, { ...base, freeOnly: true });
  assert.deepEqual(ids(free), ['nvidia/llama-3.3-nemotron-super-49b', 'z-ai/glm-5.2']);

  const dl = lib.applyModelFilters(MODELS, { ...base, downloadableOnly: true });
  assert.deepEqual(ids(dl), ['nvidia/llama-3.3-nemotron-super-49b', 'meta/llama-4-maverick']);
});

test('search, company, label, threshold and toggles all compose together', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const base = lib.DEFAULT_MODEL_FILTERS;

  // Company alone.
  assert.deepEqual(ids(lib.applyModelFilters(MODELS, { ...base, company: 'meta' })), ['meta/llama-4-maverick']);

  // Search alone still matches id, description and labels.
  assert.deepEqual(ids(lib.applyModelFilters(MODELS, { ...base, query: 'nemotron' })), ['nvidia/llama-3.3-nemotron-super-49b']);
  assert.deepEqual(ids(lib.applyModelFilters(MODELS, { ...base, query: 'maverick' })), ['meta/llama-4-maverick']);

  // Every axis at once: the new filters must AND with the pre-existing ones.
  const composed = lib.applyModelFilters(MODELS, {
    ...base, query: 'llama', company: 'nvidia', labels: ['Agent'], minPopularity: 1_000, freeOnly: true, downloadableOnly: true
  });
  assert.deepEqual(ids(composed), ['nvidia/llama-3.3-nemotron-super-49b']);

  // A company that contradicts the label selection yields nothing — the empty
  // result the view has to explain.
  const contradiction = lib.applyModelFilters(MODELS, { ...base, company: 'meta', labels: ['Frontier'] });
  assert.deepEqual(contradiction, []);
});

test('the three existing sort orders survive the new filtering', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const base = lib.DEFAULT_MODEL_FILTERS;

  assert.deepEqual(ids(lib.applyModelFilters(MODELS, { ...base, sortBy: 'popular' })),
    ['nvidia/llama-3.3-nemotron-super-49b', 'z-ai/glm-5.2', 'meta/llama-4-maverick', 'obscure/unlisted-model']);

  assert.deepEqual(ids(lib.applyModelFilters(MODELS, { ...base, sortBy: 'updated' })),
    ['nvidia/llama-3.3-nemotron-super-49b', 'z-ai/glm-5.2', 'meta/llama-4-maverick', 'obscure/unlisted-model'],
    'a missing lastUpdated must sort last, not first');

  // Order is real localeCompare collation on the part AFTER the slash, measured
  // with node: 'llama-3.3-…'.localeCompare('llama-4-…') === -1.
  assert.deepEqual(ids(lib.applyModelFilters(MODELS, { ...base, sortBy: 'name' })),
    ['z-ai/glm-5.2', 'nvidia/llama-3.3-nemotron-super-49b', 'meta/llama-4-maverick', 'obscure/unlisted-model'],
    'name sort compares the part after the publisher slash');
});

test('reset clears everything that can hide a model but keeps the sort order', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const base = lib.DEFAULT_MODEL_FILTERS;

  assert.equal(lib.hasActiveFilters(base), false);
  assert.equal(lib.hasActiveFilters({ ...base, minPopularity: 1_000 }), true);
  assert.equal(lib.hasActiveFilters({ ...base, labels: ['Agent'] }), true);
  assert.equal(lib.hasActiveFilters({ ...base, query: 'x' }), true);
  assert.equal(lib.hasActiveFilters({ ...base, company: 'meta' }), true);
  assert.equal(lib.hasActiveFilters({ ...base, freeOnly: true }), true);
  assert.equal(lib.hasActiveFilters({ ...base, downloadableOnly: true }), true);
  assert.equal(lib.hasActiveFilters({ ...base, sortBy: 'name' }), false,
    'sorting hides nothing, so it must not count as an active filter');

  const dirty = { query: 'x', company: 'meta', sortBy: 'name', minPopularity: 10_000, labels: ['Agent'], freeOnly: true, downloadableOnly: true };
  const cleared = lib.resetModelFilters(dirty);
  assert.equal(lib.hasActiveFilters(cleared), false, 'reset must clear every hiding filter');
  assert.equal(cleared.sortBy, 'name', 'reset must preserve the chosen sort order');
});

// ───────────────────────────────────────────────────────────────────────────
// Static wiring. There is no jsdom and no @testing-library/react in this repo,
// so these assert the view is WIRED to the verified logic; they do NOT prove
// rendered or screen-reader behaviour.
// ───────────────────────────────────────────────────────────────────────────

test('the Models view drives its list through the shared filter logic', () => {
  const view = read('src/renderer/views/Models.tsx');

  assert.match(view, /from\s+'\.\.\/lib\/models-filter'/,
    'the view must consume the tested module rather than re-implementing filtering inline');
  assert.match(view, /applyModelFilters\(/, 'the list must be produced by applyModelFilters');
  assert.match(view, /collectModelLabels\(/, 'the label chips must be derived from the loaded models');
});

test('the result count is rendered and announced, and the empty state offers a reset', () => {
  const view = read('src/renderer/views/Models.tsx');

  assert.match(view, /models_filter_results/, 'the visible result count must be localized');
  assert.match(view, /aria-live=["']polite["']/,
    'the count must reach a live region so a shrinking list is announced');
  assert.match(view, /sr-only/, 'match the Logs.tsx sr-only live-region idiom');
  assert.match(view, /models_filter_reset/, 'the empty state must offer a one-click reset');
  assert.match(view, /resetModelFilters\(/, 'the reset button must call the tested reset');
});

test('every new control is keyboard reachable with an accessible name', () => {
  const view = read('src/renderer/views/Models.tsx');

  // Label chips follow the company-chip idiom: real buttons + aria-pressed.
  assert.match(view, /aria-pressed=\{filters\.labels\.includes\(/,
    'label chips must expose their selected state via aria-pressed');
  assert.match(view, /models_filter_popularity_label/, 'the threshold select needs a label');
  assert.match(view, /models_filter_labels_label/, 'the label chip group needs a group label');
  assert.match(view, /models_filter_free_only/);
  assert.match(view, /models_filter_downloadable_only/);

  // No mouse-only affordances introduced for the new controls.
  assert.doesNotMatch(view, /<div[^>]*onClick=\{[^}]*setFilters/,
    'the new controls must be native focusable elements, not clickable divs');
});

test('no filter is offered over data that never reaches the renderer', () => {
  const view = read('src/renderer/views/Models.tsx');
  const ipc = read('src/main/models-ipc.ts');

  // mapModelCatalog is the ONLY gateway->renderer path. It threads the 10
  // catalogue fields and drops `capabilities`, so reasoning support is simply
  // not client-side data. A "supports reasoning" filter here would hide
  // working models on absent metadata.
  assert.doesNotMatch(ipc, /return\s*\{[\s\S]{0,900}?capabilities:/,
    'guard: if capabilities ever start reaching the renderer, revisit the rejected reasoning filter');
  assert.doesNotMatch(view, /supportsReasoning|filter_reasoning/,
    'no reasoning filter may be built while the field is dropped at the IPC boundary');
});

test('the new filter strings exist in all 7 locales', () => {
  const exports = loadTypeScriptExports('src/renderer/i18n/resources.ts');

  for (const locale of LOCALE_NAMES) {
    for (const key of NEW_KEYS) {
      const value = exports[locale][key];
      assert.ok(typeof value === 'string' && value.trim().length > 0,
        `${locale} must define ${key}`);
    }
  }

  assert.match(exports.en.models_filter_results, /\{\{count\}\}/,
    'the result count must interpolate the filtered count');
  assert.match(exports.en.models_filter_results, /\{\{total\}\}/,
    'the result count must also name the total, so an empty result is understandable');
  assert.match(exports.en.models_filter_popularity_threshold, /\{\{threshold\}\}/,
    'one interpolated string serves every threshold choice');
});

test('the new filter strings are real translations, not English left in place', () => {
  const exports = loadTypeScriptExports('src/renderer/i18n/resources.ts');

  for (const key of NEW_KEYS) {
    assert.match(exports.ar[key], /[\u0600-\u06FF]/, `ar.${key} must be in Arabic script`);
    assert.match(exports.hi[key], /[\u0900-\u097F]/, `hi.${key} must be in Devanagari script`);
    assert.match(exports.zh[key], /[\u4E00-\u9FFF]/, `zh.${key} must be in Han script`);
    assert.match(exports.ru[key], /[\u0400-\u04FF]/, `ru.${key} must be in Cyrillic script`);

    for (const locale of ['fr', 'es']) {
      assert.notEqual(exports[locale][key], exports.en[key],
        `${locale}.${key} must be translated, not the English string verbatim`);
    }
  }
});
