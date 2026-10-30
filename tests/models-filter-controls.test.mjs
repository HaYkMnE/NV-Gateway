import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// The main-process allowlist is a COMPILED CommonJS module that requires
// `electron` at load time. `node --test` has no Electron runtime, and outside
// one `require("electron")` yields the executable PATH STRING (so `shell` would
// be undefined), exactly as tests/external-open-validated-href.test.mjs notes.
// The module is therefore pre-seeded in require.cache with a recording stub —
// the same pattern the neighbouring external-open tests use. This is what lets
// the LLM Stats attribution test below assert REACHABILITY (isAllowedExternalUrl
// accepts the URL the view actually opens) instead of only the presence of a
// symbol in the view source.
const nodeRequire = createRequire(import.meta.url);
const electronId = nodeRequire.resolve('electron');
nodeRequire.cache[electronId] = {
  id: electronId,
  filename: electronId,
  loaded: true,
  children: [],
  paths: [],
  exports: { shell: { openExternal: async () => undefined } }
};
const { isAllowedExternalUrl } = await import(
  pathToFileURL(path.join(root, 'build', 'src', 'main', 'external-open.js')).href
);

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
});

test('a model with no catalogue match (popularity 0) survives the default state', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const passed = lib.applyModelFilters(MODELS, lib.DEFAULT_MODEL_FILTERS);
  assert.ok(ids(passed).includes('obscure/unlisted-model'),
    'a filter that silently drops unmatched models by default is worse than no filter');
});

test('label chips filter as any-of and are derived from the real data', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  // This test is about LABEL SEMANTICS, not about the default order: pin the
  // popularity sort so the expectation stays readable (the default is now 'top',
  // which is asserted separately).
  const base = { ...lib.DEFAULT_MODEL_FILTERS, sortBy: 'popular' };

  // Spread before comparing: collectModelLabels builds its result with
  // Array.from INSIDE the vm realm, so the returned array has that realm's
  // Array.prototype and deepStrictEqual would fail on prototype identity alone
  // (measured). Spreading re-homes it so the assertion judges CONTENT.
  // Owner 30.09: the chip universe is the canonical allow-list (Agent -> Agents,
  // Frontier is hidden) — see tests/models-tag-taxonomy.test.mjs.
  assert.deepEqual([...lib.collectModelLabels(MODELS)], ['Agents'],
    'the tag universe must be the canonical allow-list taken from the loaded models');

  const agents = lib.applyModelFilters(MODELS, { ...base, labels: ['Agent'] });
  assert.deepEqual(ids(agents), ['nvidia/llama-3.3-nemotron-super-49b', 'meta/llama-4-maverick']);

  const either = lib.applyModelFilters(MODELS, { ...base, labels: ['Agent', 'Frontier'] });
  assert.equal(either.length, 3,
    'two selected labels must widen (any-of), not collapse to an intersection');
});

// ───────────────────────────────────────────────────────────────────────────
// Owner defect: the label chip row was a raw dump of catalogue plumbing —
// `cloudPartnerType:endpoint:cloud_partner_type_bitdeer`,
// `nimType:endpoint:nim_type_preview`, `playgroundType:endpoint:playgroundtype_chat`,
// `supported language - english`, `usecase:endpoint:usecase_audio_to_text` — plus
// the same capability repeated in different casings (`chat`/`Chat`,
// `Reasoning`/`reasoning`, `coding`/`Coding`). `isNoiseLabel()` already encoded
// the plumbing rule for the drawer; `collectModelLabels` simply never used it.
//
// The FIX must not break selection: the surviving chip is ONE representative
// spelling, so the match path has to accept any casing of that label.
// ───────────────────────────────────────────────────────────────────────────

const NOISY_LABELED_MODELS = [
  {
    id: 'nvidia/nemotron-noisy',
    labels: [
      'cloudPartnerType:endpoint:cloud_partner_type_bitdeer',
      'nimType:endpoint:nim_type_preview',
      'playgroundType:endpoint:playgroundtype_chat',
      'supported language - english',
      'usecase:endpoint:usecase_audio_to_text',
      'InputModalities:text',
      'Reasoning',
    ],
  },
  { id: 'z-ai/glm-chat-lower', labels: ['chat', 'coding'] },
  { id: 'meta/llama-chat-upper', labels: ['Chat', 'Coding'] },
  { id: 'mistralai/mistral-reasoning', labels: ['reasoning'] },
];

test('catalogue plumbing never reaches the label chip row', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);

  const chips = [...lib.collectModelLabels(NOISY_LABELED_MODELS)];
  const plumbing = [
    'cloudPartnerType:endpoint:cloud_partner_type_bitdeer',
    'nimType:endpoint:nim_type_preview',
    'playgroundType:endpoint:playgroundtype_chat',
    'supported language - english',
    'usecase:endpoint:usecase_audio_to_text',
    'InputModalities:text',
  ];
  for (const label of plumbing) {
    assert.equal(lib.isNoiseLabel(label), true, `${label} must be classified as plumbing`);
    assert.ok(!chips.includes(label), `the chip row must not offer ${label}`);
  }

  // Allow-listed labels survive (Chat is not in the owner's allow-list); the
  // noise-only model contributes nothing.
  assert.deepEqual(chips.sort(), ['Coding', 'Reasoning']);
});

test('case-duplicates collapse to ONE chip, chosen deterministically', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);

  // `chat` appears once, `Chat` once -> a tie at count 1. The tie-break is
  // alphabetical, so the representative is the SAME regardless of catalogue
  // order or which spelling came first.
  const forward = [...lib.collectModelLabels(NOISY_LABELED_MODELS)];
  const reversed = [...lib.collectModelLabels([...NOISY_LABELED_MODELS].reverse())];
  assert.deepEqual(reversed.sort(), forward.sort(),
    'the representative must not depend on catalogue order');

  assert.equal(forward.filter((l) => l.toLowerCase() === 'chat').length, 0,
    'chat/Chat is outside the allow-list and must render no chip');
  assert.equal(forward.filter((l) => l.toLowerCase() === 'coding').length, 1,
    'coding/Coding must render as exactly one chip');
  assert.equal(forward.filter((l) => l.toLowerCase() === 'reasoning').length, 1,
    'Reasoning/reasoning must render as exactly one chip');

  // Every chip is a canonical allow-list tag, never a raw catalogue spelling.
  const canonical = new Set([...lib.CANONICAL_MODEL_TAGS].map((e) => e.tag));
  for (const chip of forward) {
    assert.ok(canonical.has(chip), `${chip} must be a canonical tag`);
  }

  // Every casing of an allow-listed label collapses to its ONE canonical tag.
  const casings = [
    { id: 'a/one', labels: ['coding'] },
    { id: 'b/two', labels: ['Coding'] },
    { id: 'c/three', labels: ['CODING'] },
  ];
  assert.deepEqual([...lib.collectModelLabels(casings)], ['Coding'],
    'all casings collapse to the canonical tag');
});

test('a selected chip still filters models that spell the label differently', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const base = lib.DEFAULT_MODEL_FILTERS;

  // The chip text is a single casing; BOTH casings of the underlying label must
  // still match, otherwise the chip would hide its own models.
  const reasoningChip = [...lib.collectModelLabels(NOISY_LABELED_MODELS)].find((l) => l.toLowerCase() === 'reasoning');
  assert.ok(reasoningChip, 'a reasoning chip must exist');

  assert.deepEqual(ids(lib.applyModelFilters(NOISY_LABELED_MODELS, { ...base, labels: [reasoningChip] })).sort(),
    ['mistralai/mistral-reasoning', 'nvidia/nemotron-noisy'],
    'selecting the chip must match every casing of that label');

  const codingChip = [...lib.collectModelLabels(NOISY_LABELED_MODELS)].find((l) => l.toLowerCase() === 'coding');
  assert.deepEqual(ids(lib.applyModelFilters(NOISY_LABELED_MODELS, { ...base, labels: [codingChip] })).sort(),
    ['meta/llama-chat-upper', 'z-ai/glm-chat-lower']);

  // The label match helper is the tested primitive behind this behaviour.
  assert.equal(lib.labelMatchesSelection('Chat', 'chat'), true);
  assert.equal(lib.labelMatchesSelection('  CHAT ', 'chat'), true, 'trimming must not defeat the match');
  assert.equal(lib.labelMatchesSelection('chat', 'coding'), false);
  assert.equal(lib.labelMatchesSelection(null, 'chat'), false, 'a non-string label never matches');
});

test('the free-endpoint and downloadable toggles only ever hide when switched on', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  // Order-independent intent: the toggles NARROW, so pin the popularity order
  // for a readable expectation (the default is asserted separately).
  const base = { ...lib.DEFAULT_MODEL_FILTERS, sortBy: 'popular' };

  assert.equal(lib.DEFAULT_MODEL_FILTERS.freeOnly, false);
  assert.equal(lib.DEFAULT_MODEL_FILTERS.downloadableOnly, false);

  const free = lib.applyModelFilters(MODELS, { ...base, freeOnly: true });
  assert.deepEqual(ids(free), ['nvidia/llama-3.3-nemotron-super-49b', 'z-ai/glm-5.2']);

  const dl = lib.applyModelFilters(MODELS, { ...base, downloadableOnly: true });
  assert.deepEqual(ids(dl), ['nvidia/llama-3.3-nemotron-super-49b', 'meta/llama-4-maverick']);
});

test('search, company, label and toggle axes all compose together', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const base = lib.DEFAULT_MODEL_FILTERS;

  // Company alone.
  assert.deepEqual(ids(lib.applyModelFilters(MODELS, { ...base, company: 'meta' })), ['meta/llama-4-maverick']);

  // Search alone still matches id, description and labels.
  assert.deepEqual(ids(lib.applyModelFilters(MODELS, { ...base, query: 'nemotron' })), ['nvidia/llama-3.3-nemotron-super-49b']);
  assert.deepEqual(ids(lib.applyModelFilters(MODELS, { ...base, query: 'maverick' })), ['meta/llama-4-maverick']);

  // Every axis at once: the filters must AND with the pre-existing ones.
  const composed = lib.applyModelFilters(MODELS, {
    ...base, query: 'llama', company: 'nvidia', labels: ['Agent'], freeOnly: true, downloadableOnly: true
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

// ───────────────────────────────────────────────────────────────────────────
// «Топовые» (Round E): an LLM Stats overall-strength sort. The rank arrives from
// the gateway as `llmStatsRank` (1 = strongest) and is OPTIONAL: 58 of the 82
// catalogue models have no LLM Stats counterpart. The contract:
//   * ranked models first, ascending rank (rank 1 is the strongest);
//   * unranked models last, in the EXISTING secondary order (id A-Z);
//   * a model is never given a fabricated rank, so `undefined`/null/NaN rank
//     means "unranked" (never a top position);
//   * the other three sorts are untouched;
//   * `top` hides nothing, so it is not an "active filter".
// ───────────────────────────────────────────────────────────────────────────

const RANKED_MODELS = [
  { id: 'z-ai/glm-5.3', publisher: 'z-ai', popularity: 10, lastUpdated: '2026-08-01T00:00:00Z', llmStatsRank: 9 },
  { id: 'moonshotai/kimi-k3', publisher: 'moonshotai', popularity: 20, lastUpdated: '2026-07-01T00:00:00Z', llmStatsRank: 8 },
  { id: 'google/deplot', publisher: 'google', popularity: 30, lastUpdated: '2026-06-01T00:00:00Z' },
  { id: 'adept/fuyu-8b', publisher: 'adept', popularity: 40, lastUpdated: '2026-05-01T00:00:00Z' },
  { id: 'mistralai/mistral-large', publisher: 'mistralai', popularity: 50, lastUpdated: '2026-04-01T00:00:00Z', llmStatsRank: 271 },
];

test('the "top" sort puts ranked models first, ascending rank', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const base = lib.DEFAULT_MODEL_FILTERS;

  assert.deepEqual(ids(lib.applyModelFilters(RANKED_MODELS, { ...base, sortBy: 'top' })),
    ['moonshotai/kimi-k3', 'z-ai/glm-5.3', 'mistralai/mistral-large', 'adept/fuyu-8b', 'google/deplot'],
    'rank 8 then 9 then 271, then the two unranked ids A-Z');
});

test('unranked models stay LAST and keep the existing secondary order', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const base = lib.DEFAULT_MODEL_FILTERS;

  // Reverse the unranked pair: their relative order must still be id A-Z.
  const shuffled = [
    { id: 'google/deplot', publisher: 'google', popularity: 30 },
    { id: 'adept/fuyu-8b', publisher: 'adept', popularity: 40 },
  ];
  assert.deepEqual(ids(lib.applyModelFilters(shuffled, { ...base, sortBy: 'top' })),
    ['adept/fuyu-8b', 'google/deplot'],
    'unranked models are ordered by id, not by their input order');

  // A ranked model beats an unranked one regardless of popularity/updated.
  const mixed = [
    { id: 'obscure/unlisted-model', publisher: 'obscure', popularity: 9_999_999 },
    { id: 'z-ai/glm-5.3', publisher: 'z-ai', popularity: 1, llmStatsRank: 300 },
  ];
  assert.deepEqual(ids(lib.applyModelFilters(mixed, { ...base, sortBy: 'top' })),
    ['z-ai/glm-5.3', 'obscure/unlisted-model'],
    'even a low rank outranks "unranked"');
});

test('a hostile rank value can never fabricate a top position', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const base = lib.DEFAULT_MODEL_FILTERS;

  const hostile = [
    { id: 'a/model', llmStatsRank: 0 },
    { id: 'b/model', llmStatsRank: -5 },
    { id: 'c/model', llmStatsRank: NaN },
    { id: 'd/model', llmStatsRank: '8' },
    { id: 'e/model', llmStatsRank: 1.5 },
    { id: 'f/model', llmStatsRank: null },
    { id: 'g/model', llmStatsRank: Infinity },
    { id: 'h/model', llmStatsRank: 2 },
  ];
  assert.deepEqual(ids(lib.applyModelFilters(hostile, { ...base, sortBy: 'top' })),
    ['h/model', 'a/model', 'b/model', 'c/model', 'd/model', 'e/model', 'f/model', 'g/model'],
    'only a positive integer rank counts; everything else is unranked and sorts by id');
});

test('switching to "top" hides nothing and does not count as an active filter', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const base = lib.DEFAULT_MODEL_FILTERS;

  assert.equal(lib.hasActiveFilters({ ...base, sortBy: 'top' }), false,
    'sorting hides nothing, so sorting by strength must not count as an active filter');
  assert.equal(lib.applyModelFilters(RANKED_MODELS, { ...base, sortBy: 'top' }).length, RANKED_MODELS.length,
    'the strength sort must pass every model through');
  assert.equal(lib.resetModelFilters({ ...base, sortBy: 'top' }).sortBy, 'top',
    'reset must preserve the chosen sort order, including "top"');
});

test('the popularity and name sorts ignore the new rank field entirely', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const base = lib.DEFAULT_MODEL_FILTERS;

  assert.deepEqual(ids(lib.applyModelFilters(RANKED_MODELS, { ...base, sortBy: 'popular' })),
    ['mistralai/mistral-large', 'adept/fuyu-8b', 'google/deplot', 'moonshotai/kimi-k3', 'z-ai/glm-5.3'],
    'popularity sort stays popularity-descending');
  assert.deepEqual(ids(lib.applyModelFilters(RANKED_MODELS, { ...base, sortBy: 'name' })),
    ['google/deplot', 'adept/fuyu-8b', 'z-ai/glm-5.3', 'moonshotai/kimi-k3', 'mistralai/mistral-large'],
    'name sort stays A-Z on the part after the slash (deplot, fuyu-8b, glm-5.3, kimi-k3, mistral-large)');
});

test('the default sort is "top" on a fresh profile', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  // Owner: «сортировки по умолчанию сделай топовые». The constant is the seed
  // for a fresh profile ONLY: the view copies it into state once per mount and
  // every later change goes through patchFilters/resetModelFilters, and
  // resetModelFilters PRESERVES the current sortBy — so a sort the user already
  // chose is never silently overridden.
  assert.equal(lib.DEFAULT_MODEL_FILTERS.sortBy, 'top',
    'a fresh profile must open on the strongest-first order');
  assert.equal(lib.resetModelFilters({ ...lib.DEFAULT_MODEL_FILTERS, sortBy: 'name' }).sortBy, 'name',
    'reset must keep the user\'s chosen sort, never snap it back to the default');
});


test('reset clears everything that can hide a model but keeps the sort order', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const base = lib.DEFAULT_MODEL_FILTERS;

  assert.equal(lib.hasActiveFilters(base), false);
  assert.equal(lib.hasActiveFilters({ ...base, labels: ['Agent'] }), true);
  assert.equal(lib.hasActiveFilters({ ...base, query: 'x' }), true);
  assert.equal(lib.hasActiveFilters({ ...base, company: 'meta' }), true);
  assert.equal(lib.hasActiveFilters({ ...base, freeOnly: true }), true);
  assert.equal(lib.hasActiveFilters({ ...base, downloadableOnly: true }), true);
  assert.equal(lib.hasActiveFilters({ ...base, sortBy: 'name' }), false,
    'sorting hides nothing, so it must not count as an active filter');

  const dirty = { query: 'x', company: 'meta', sortBy: 'name', labels: ['Agent'], freeOnly: true, downloadableOnly: true };
  const cleared = lib.resetModelFilters(dirty);
  assert.equal(lib.hasActiveFilters(cleared), false, 'reset must clear every hiding filter');
  assert.equal(cleared.sortBy, 'name', 'reset must preserve the chosen sort order');
});

// The owner removed the "minimum popularity" row, which was the ONLY writer of
// `minPopularity`. The field is kept deliberately dormant rather than deleted,
// so the removal cannot silently change applyModelFilters/hasActiveFilters for a
// caller that still passes a threshold. That means the axis is now UNREACHABLE
// from the UI and the only place it still has teeth is here.
test('the dormant minPopularity axis still narrows and still counts as an active filter', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const base = lib.DEFAULT_MODEL_FILTERS;

  // The neutral default hides nothing — this is the state the view now pins it to.
  assert.equal(base.minPopularity, 0, 'the dormant default must hide nothing');
  assert.deepEqual(ids(lib.applyModelFilters(MODELS, base)).sort(), ids(MODELS).sort());

  // Non-vacuity: the branch is genuinely live, and it can still hide models.
  const over10k = lib.applyModelFilters(MODELS, { ...base, minPopularity: 10_000 });
  assert.deepEqual(ids(over10k), ['nvidia/llama-3.3-nemotron-super-49b', 'z-ai/glm-5.2'],
    'a positive threshold must still narrow the list');
  // hasActiveFilters still reports it, so a dormant non-zero threshold is never
  // mistaken for "nothing is filtering".
  assert.equal(lib.hasActiveFilters({ ...base, minPopularity: 1_000 }), true,
    'a positive minPopularity must still count as an active filter');
  assert.equal(lib.hasActiveFilters({ ...base, minPopularity: 0 }), false,
    'the neutral value must count as inactive');
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

test('every remaining control is keyboard reachable with an accessible name', () => {
  const view = read('src/renderer/views/Models.tsx');

  // Label chips follow the company-chip idiom: real buttons + aria-pressed.
  assert.match(view, /const selected = filters\.labels\.some\(\(l\) => labelMatchesSelection\(l, label\)\);[\s\S]*?aria-pressed=\{selected\}/,
    'label chips must expose their selected state via aria-pressed');
  // The minimum-popularity select was REMOVED (owner: the row is not wanted —
  // popularity already lives in the sort). Its copy keys went with it, so the
  // whole control family must be absent from the view AND from the locale files.
  assert.doesNotMatch(view, /models_filter_popularity_/,
    'the "minimum popularity" control and its copy must be gone from the view');
  assert.doesNotMatch(view, /patchFilters\(\{ minPopularity/,
    'the view must no longer set a popularity threshold');
  assert.match(view, /models_filter_labels_label/, 'the label chip group needs a group label');
  assert.match(view, /models_filter_free_only/);
  assert.match(view, /models_filter_downloadable_only/);

  // Popularity is still DISPLAYED (per-model) and still SORTABLE — removing the
  // threshold row must not remove either.
  assert.match(view, /formatPopularity\(model\.popularity\)/,
    'the per-model popularity display must survive the control removal');
  assert.match(view, /<option value="popular">/,
    'the popularity sort option must survive the control removal');

  // No mouse-only affordances introduced for the new controls.
  assert.doesNotMatch(view, /<div[^>]*onClick=\{[^}]*setFilters/,
    'the new controls must be native focusable elements, not clickable divs');
});

test('no reasoning filter is offered, because capability data is optional', () => {
  const view = read('src/renderer/views/Models.tsx');

  // mapModelCatalog DOES now forward `capabilities` (models-ipc.ts:213) and both
  // renderer types declare it, so reasoning support does reach the renderer. A
  // "supports reasoning" filter is still deliberately NOT offered: the object is
  // optional and can be absent/empty for a given model (and for a window after
  // gateway start while the discovery cache is cold), so filtering on it would
  // hide otherwise-working models.
  assert.doesNotMatch(view, /supportsReasoning|filter_reasoning/,
    'no reasoning filter may be offered: absent capability data would hide working models');
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

// ───────────────────────────────────────────────────────────────────────────
// Round E static wiring: the «Топовые» option must reach the select, and the
// ranking must carry the licence-required source attribution + a truthful
// "no rank" representation. There is no jsdom here, so these assert the wiring.
// ───────────────────────────────────────────────────────────────────────────

test('the sort control offers "Топовые" alongside the three existing orders', () => {
  const view = read('src/renderer/views/Models.tsx');

  assert.match(view, /<option value="top">/, 'the select must offer the strength order');
  assert.match(view, /models_sort_top/, 'the option must have a localized label');
  // The three pre-existing options must survive: adding a sort is not a rewrite.
  for (const kept of ['popular', 'name', 'updated']) {
    assert.match(view, new RegExp(`<option value="${kept}">`), `the ${kept} option must survive`);
  }
});

test('the ranking carries its required "Data by LLM Stats" attribution', () => {
  const view = read('src/renderer/views/Models.tsx');

  assert.match(view, /llm-stats\.com/, 'the attribution must link to the source');
  assert.match(view, /models_source_attribution/, 'the attribution text must be localized');
  // electron-security.ts denies every target="_blank" (setWindowOpenHandler =>
  // { action: 'deny' }), so the link opens through the preload openExternal
  // route instead — target="_blank" here would be a dead link.
  assert.match(view, /window\.electronAPI\??\.openExternal\(LLM_STATS_SOURCE_URL\)/,
    'the attribution link must open via electronAPI.openExternal, not target="_blank"');
  assert.doesNotMatch(view, /target="_blank"/,
    'target="_blank" is a dead link: the window open handler denies it');

  // MEANINGFUL REACHABILITY, not just symbol presence. A view that calls
  // openExternal(LLM_STATS_SOURCE_URL) is still a SILENT NO-OP if the main-process
  // allowlist rejects the URL: openExternalUrl throws, and the renderer's
  // `.catch(() => undefined)` swallows it. The view and the gateway each hard-code
  // the literal, so this pins it against BOTH sides drifting from the allowlist.
  const LITERAL = 'https://llm-stats.com/';
  assert.ok(view.includes(`'${LITERAL}'`), `the view must carry the literal ${LITERAL}`);
  assert.equal(isAllowedExternalUrl(LITERAL), true,
    'the URL the view opens must be ACCEPTED by the main-process allowlist');
  // And it stays subject to the same bounds as every other allowed destination.
  assert.equal(isAllowedExternalUrl('http://llm-stats.com/'), false, 'https must remain required');
  assert.equal(isAllowedExternalUrl('https://llm-stats.com:8443/'), false, 'a non-default port must remain rejected');

  // The gateway side is the second declaration of the same source URL; if it ever
  // moves, the view's literal and the allowlist entry must move together.
  const gateway = read('src/gateway/llm-stats-ranking.mjs');
  assert.ok(gateway.includes(`"${LITERAL}"`), `the gateway module must declare ${LITERAL}`);
});

test('the rank row is rendered ONLY when a rank genuinely arrived', () => {
  // NON-VACUOUS (the previous version of this test asserted only that the
  // strings exist in the view, so it passed even while the row rendered
  // unconditionally with a "Not ranked" placeholder). Two independent checks:
  //   1. the pure formatter declares null for an absent rank;
  //   2. the view gates the WHOLE strength block on that formatter's result and
  //      no longer contains the placeholder expression.
  const lib = loadTypeScriptExports('src/renderer/lib/model-technical.ts');
  assert.equal(lib.formatStrengthRank(8), '#8', 'a real rank renders as #8');
  assert.equal(lib.formatStrengthRank(1), '#1', 'rank 1 is a real position');
  for (const absent of [undefined, null, 0, -3, 1.5, NaN, Infinity, '8']) {
    assert.equal(lib.formatStrengthRank(absent), null, `${String(absent)} must mean "no ranking"`);
  }

  const view = read('src/renderer/views/Models.tsx');
  // The guard is the formatter result, applied to the whole block (rank row AND
  // the licence-required attribution row live inside it).
  assert.match(view, /const strengthRank = formatStrengthRank\(model\.llmStatsRank\)/,
    'the view must derive the rank through the tested formatter');
  assert.match(view, /\{strengthRank && \(\s*<>/,
    'the whole strength block (rank + attribution) must be conditional on the rank');

  // The placeholder that made the old row render unconditionally must be gone.
  assert.doesNotMatch(view, /formatStrengthRank\(model\.llmStatsRank\) \?\? t\('models_info_strength_unranked'\)/,
    'an absent rank must NOT fall back to a "Not ranked" placeholder row');
  assert.doesNotMatch(view, /models_info_strength_unranked/,
    'the view must not render the unranked placeholder at all');

  // The attributed drawer row lives INSIDE the same guard: no ranking shown =>
  // no drawer attribution (the licence binds the attribution to where a ranking
  // is shown); a ranking shown => the drawer attribution is present. The guarded
  // block is a `<>…</>` fragment, so the guard closes at the matching `</>`. The
  // filter toolbar has its own always-on global attribution, so the search for
  // the DRAWER's attribution starts at the guard.
  const guardStart = view.indexOf('{strengthRank && (');
  const attribution = view.indexOf('models_source_attribution', guardStart);
  const fragmentEnd = view.indexOf('</>', guardStart);
  assert.ok(guardStart !== -1 && fragmentEnd !== -1, 'the strength block must be a guarded fragment');
  assert.ok(attribution > guardStart && attribution < fragmentEnd,
    'the drawer attribution link must stay inside the strength visibility guard');
});

test('the strength strings exist in all 7 locales as real translations', () => {
  const exports_ = loadTypeScriptExports('src/renderer/i18n/resources.ts');
  const KEYS = [
    'models_sort_top',
    'models_info_strength_rank',
    'models_info_strength_score',
    'models_source_attribution',
  ];

  for (const locale of LOCALE_NAMES) {
    for (const key of KEYS) {
      const value = exports_[locale][key];
      assert.ok(typeof value === 'string' && value.trim().length > 0, `${locale} must define ${key}`);
    }
  }
  for (const key of KEYS) {
    assert.match(exports_.ru[key], /[\u0400-\u04FF]/, `ru.${key} must be in Cyrillic script`);
    assert.match(exports_.ar[key], /[\u0600-\u06FF]/, `ar.${key} must be in Arabic script`);
    assert.match(exports_.hi[key], /[\u0900-\u097F]/, `hi.${key} must be in Devanagari script`);
    assert.match(exports_.zh[key], /[\u4E00-\u9FFF]/, `zh.${key} must be in Han script`);
    for (const locale of ['fr', 'es']) {
      assert.notEqual(exports_[locale][key], exports_.en[key],
        `${locale}.${key} must be translated, not the English string verbatim`);
    }
  }
  assert.equal(exports_.en.models_source_attribution, 'Data by LLM Stats',
    'the licence requires the exact attribution wording');
});
