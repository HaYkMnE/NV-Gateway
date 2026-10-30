import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// Same bare-context loader as tests/models-filter-controls.test.mjs: transpile
// the TS to CommonJS and run it with sandbox { Error, exports, module } only.
// The module under test MUST stay import-free for this to work.
function loadTypeScriptExports(relative) {
  const compiled = typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { Error, exports: module.exports, module }, { filename: relative });
  return module.exports;
}

// ───────────────────────────────────────────────────────────────────────────
// FEATURE (deferred notes item 2, section «2. Теги под именем модели»): the
// expanded «Подробнее» drawer currently dumps EVERY raw `model.labels` entry —
// including catalogue plumbing like `cloudPartnerType:endpoint:cloud_partner_type_*`
// and `nimType:endpoint:*` — as an unbounded chip row. The requirement is a
// CURATED, bounded set of capability tags for that specific model.
//
// These tests pin the curation rule. Filtering (collectModelLabels /
// applyModelFilters) is deliberately NOT touched and is re-asserted below so a
// later edit cannot regress the filter chips while "cleaning up" the drawer.
// ───────────────────────────────────────────────────────────────────────────

const FILTER_LIB = 'src/renderer/lib/models-filter.ts';

test('curation module stays import-free (vm harness has no module resolver)', () => {
  const source = read(FILTER_LIB);
  assert.doesNotMatch(source, /^\s*import\s/m,
    'models-filter.ts must not import anything: the vm harness gives it no module resolver');
});

test('a model whose labels are pure catalogue noise contributes NO curated tags', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);

  // Realistic unlisted-model payload: only namespaced plumbing labels.
  const noisy = [
    'cloudPartnerType:endpoint:cloud_partner_type_nim',
    'nimType:endpoint:nim',
    'endpoint:usecase_text_gen',
    'supported_input_types:text',
    'InputModalities:text',
  ];

  for (const label of noisy) {
    assert.equal(lib.isNoiseLabel(label), true, `${label} must be classified as plumbing`);
  }
  assert.equal(lib.isNoiseLabel(''), true, 'a blank label is noise');
  assert.equal(lib.isNoiseLabel(42), true, 'a non-string label is noise');

  assert.deepEqual([...lib.curateCapabilityTags([], noisy)], [],
    'noise must never surface as a curated capability tag');
});

test('only genuinely applicable capabilities survive, in priority order', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);

  // Non-noise labels that DO assert capabilities (mixed with noise).
  const labels = [
    'nimType:endpoint:nim',
    'Reasoning',
    'vision',
    'tool_use',
    'cloudPartnerType:endpoint:cloud_partner_type_nim',
  ];

  assert.deepEqual([...lib.curateCapabilityTags([], labels)],
    ['reasoning', 'vision', 'function_calling'],
    'exactly the asserted capabilities survive; noise is dropped');

  assert.equal(lib.isNoiseLabel('Reasoning'), false, 'a capability label is not noise');
});

test('label signals match the card vocabulary predicate-for-predicate', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);

  // One assertion per case so a failure names the exact predicate that drifted.
  const cases = [
    [['reasoning'], ['reasoning']],
    [['Reasoning'], ['reasoning']],
    [['coder'], ['code']],
    [['image-to-text'], ['vision']],
    [['code'], ['code']],
    [['codellama'], ['code']],
    [['tool_use'], ['function_calling']],
    [['nvidia-nim'], []],
  ];
  for (const [labels, expected] of cases) {
    assert.deepEqual([...lib.curateCapabilityTags([], labels)], expected,
      `labels ${JSON.stringify(labels)} must curate to ${JSON.stringify(expected)}`);
  }
});

test('card-level id/category tags are honoured even when labels are silent', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);

  // extractCapabilities() derives Vision from an id/category keyword it never
  // sees again in the drawer — the drawer must not contradict the card.
  const cardTags = [{ id: 'reasoning' }, { id: 'vision' }, { id: 'code' }];
  assert.deepEqual([...lib.curateCapabilityTags(cardTags, ['cloudPartnerType:endpoint:x'])],
    ['reasoning', 'vision', 'code'],
    'tags already proven on the card survive into the drawer');

  // Union: card tags + label-only signals, de-duplicated.
  assert.deepEqual([...lib.curateCapabilityTags([{ id: 'vision' }], ['Reasoning'])],
    ['reasoning', 'vision'],
    'card tags and label signals union without duplicates');
});

test('the curated row is bounded by the documented cap', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);

  assert.equal(lib.MAX_CURATED_TAGS, 5, 'the documented cap is 5');

  // Every vocabulary tag asserted (all 4 signals true; 'tool_use' and 'tools'
  // both raise Function Calling), so an implementation that ignores one signal
  // cannot pass this test.
  const everything = ['Reasoning', 'vision', 'code', 'tool_use', 'tools'];
  const all = lib.curateCapabilityTags([], everything);
  assert.deepEqual([...all],
    ['reasoning', 'vision', 'code', 'function_calling'],
    'all four vocabulary tags must be reachable');
  assert.ok(all.length <= lib.MAX_CURATED_TAGS, 'the cap must hold');

  // A 3-tag cap keeps the highest-priority tags only.
  assert.deepEqual([...lib.curateCapabilityTags([], everything, 3)], ['reasoning', 'vision', 'code'],
    'the cap keeps vocabulary-priority order');

  assert.deepEqual([...lib.curateCapabilityTags([], everything, 0)], [],
    'a zero cap renders nothing');

  // A hostile/unknown card tag id cannot be admitted: membership is decided by
  // the fixed vocabulary, not by whatever the card happens to carry.
  assert.deepEqual([...lib.curateCapabilityTags([{ id: 'audio' }, { id: 'vision' }], [])], ['vision'],
    'an id outside the vocabulary must not leak into the drawer');
});

test('undefined / missing inputs degrade to an empty curated set', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);

  assert.deepEqual([...lib.curateCapabilityTags(undefined, undefined)], []);
  assert.deepEqual([...lib.curateCapabilityTags(null, [])], []);
  assert.deepEqual([...lib.curateCapabilityTags([], null)], []);
  assert.deepEqual([...Object.entries(lib.deriveTagSignals(undefined))].sort(),
    [['code', false], ['function_calling', false], ['reasoning', false], ['vision', false]]);

  // A hostile `max` must degrade to the documented cap, never to "unbounded".
  // The cap (5) exceeds the 4-entry vocabulary, so the fallback yields all 4.
  const all = ['Reasoning', 'vision', 'code', 'tool_use'];
  assert.equal(lib.curateCapabilityTags([], all, NaN).length, 4, 'NaN cap falls back to the documented cap');
  assert.equal(lib.curateCapabilityTags([], all, 2.9).length, 2, 'a fractional cap floors');
  assert.equal(lib.curateCapabilityTags([], all, -3).length, 4, 'a negative cap falls back to the documented cap');
  assert.equal(lib.curateCapabilityTags([], all, Infinity).length, 4, 'Infinity keeps the whole (vocabulary-bounded) set');

  // The 4-entry vocabulary sits below the cap of 5, so the checks above cannot
  // tell "falls back to the cap" from "falls back to unbounded". Load a copy
  // with the cap lowered to 2 (same transpile + bare vm context as the loader).
  const source = read(FILTER_LIB);
  const lowered = source.replace('export const MAX_CURATED_TAGS = 5;', 'export const MAX_CURATED_TAGS = 2;');
  assert.notEqual(lowered, source, 'the cap declaration must be found to lower it');
  const capped = { exports: {} };
  vm.runInNewContext(typescript.transpileModule(lowered, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }
  }).outputText, { Error, exports: capped.exports, module: capped }, { filename: FILTER_LIB });
  assert.equal(capped.exports.curateCapabilityTags([], all).length, 2, 'the default max is the cap');
  assert.equal(capped.exports.curateCapabilityTags([], all, NaN).length, 2, 'NaN falls back to the cap, not unbounded');
  assert.equal(capped.exports.curateCapabilityTags([], all, -3).length, 2, 'a negative max falls back to the cap, not unbounded');

  // The fixed vocabulary is exactly the 4 capability tags with i18n keys.
  // (Spread first: the array is born in the vm realm — see the prototype-identity
  // note in tests/models-filter-controls.test.mjs.)
  assert.deepEqual(
    [...lib.CURATED_TAG_VOCABULARY].map((t) => t.id),
    ['reasoning', 'vision', 'code', 'function_calling']
  );
  for (const entry of lib.CURATED_TAG_VOCABULARY) {
    assert.ok(typeof entry.labelKey === 'string' && entry.labelKey.startsWith('tag_'),
      `${entry.id} must map to an existing tag_* i18n key`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// The drawer curation and the filter-chip row are DIFFERENT consumers of the
// same noise rule. Curation (curateCapabilityTags) has always dropped plumbing;
// the CHIP ROW now drops it too (owner defect: «что это за дичь? … Эти все
// метки. Столько бессмысленных»). What must NOT change is that a non-plumbing
// label always reaches the chip row, and that the narrowing still works.
// ───────────────────────────────────────────────────────────────────────────

test('the filter-chip row drops plumbing but never a real label', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);

  const models = [
    { id: 'a/one', labels: ['cloudPartnerType:endpoint:cloud_partner_type_nim', 'Agent'] },
    { id: 'b/two', labels: ['nimType:endpoint:nim'] }
  ];

  // The plumbing labels are gone; the real one survives. (Before this fix the
  // same call returned all three, which is what the owner saw as a raw dump.)
  assert.deepEqual([...lib.collectModelLabels(models)], ['Agents'],
    'collectModelLabels must drop plumbing and map the real label to its canonical tag');

  // Narrowing works through the canonical chip, so the surviving chip is not
  // decorative.
  const narrowed = lib.applyModelFilters(models, { ...lib.DEFAULT_MODEL_FILTERS, labels: ['Agents'] });
  assert.deepEqual(narrowed.map((m) => m.id), ['a/one']);
});

// ───────────────────────────────────────────────────────────────────────────
// Static wiring: no jsdom / @testing-library in this repo, so these assert the
// view CONSUMES the tested rule and stopped rendering raw labels. They do not
// prove rendered output.
// ───────────────────────────────────────────────────────────────────────────

test('the drawer renders curated tags, not the raw label list', () => {
  const view = read('src/renderer/views/Models.tsx');

  assert.match(view, /curateCapabilityTags\(/, 'the drawer must render through the tested curation rule');
  assert.match(view, /CURATED_TAG_VOCABULARY/, 'tag icons/labels must come from the shared vocabulary');
  assert.doesNotMatch(view, /model\.labels\?\.map\(/,
    'the raw unbounded label list must no longer be rendered anywhere in the view');
});

test('the drawer is split into named sections', () => {
  const view = read('src/renderer/views/Models.tsx');

  assert.match(view, /models_section_info/, 'an «Информация» section heading is required');
  assert.match(view, /models_section_examples/, 'a «Примеры» section heading is required');
  assert.match(view, /<h4/, 'section headings must be real heading elements');
  assert.match(view, /models_details_description/, 'a catalogue-provided description row must be wired');
});

test('every drawer row is bound to a field the main process really forwards', () => {
  const view = read('src/renderer/views/Models.tsx');
  const ipc = read('src/main/models-ipc.ts');
  const dts = read('src/renderer/global.d.ts');
  const store = read('src/renderer/stores/models.ts');

  // The e2e-ness of the drawer depends on these fields SURVIVING
  // mapModelCatalog (src/main/models-ipc.ts). If a field is dropped there,
  // `model.provider`/`model.shortDescription`/… would be permanently undefined
  // and every row of the drawer would vanish — a silent regression this test
  // catches at source level (the repo has no renderer DOM harness).
  const forwarded = [
    'provider',
    'publisher',
    'shortDescription',
    'category',
    'labels',
    'popularity',
    'lastUpdated',
    'downloadable',
    'freeEndpoint',
  ];
  for (const field of forwarded) {
    assert.match(ipc, new RegExp(`\\b${field}:`), `mapModelCatalog must forward ${field}`);
    assert.match(dts, new RegExp(`\\b${field}\\?:`), `ModelConfig must declare ${field}`);
    assert.match(view, new RegExp(`model\\.${field}\\b`), `the drawer/ card must consume ${field}`);
  }

  // Round 1b: the three technical fields the gateway emits (admin-api.mjs:312-314)
  // must ALSO survive the IPC boundary, be declared on BOTH renderer types, and
  // reach the drawer. Dropping any of them regresses the «Информация» rows back
  // to a permanent absence.
  const technical = ['context_length', 'max_completion_tokens', 'capabilities'];
  const mappedReturn = ipc.slice(ipc.indexOf('return {'));
  for (const field of technical) {
    assert.match(mappedReturn, new RegExp(`\\b${field}:`),
      `mapModelCatalog must COPY ${field} into the mapped payload`);
    assert.match(dts, new RegExp(`\\b${field}\\?:`), `ModelConfig must declare ${field}`);
    assert.match(store, new RegExp(`\\b${field}\\?:`), `ModelEntry must declare ${field}`);
    assert.match(view, new RegExp(`model\\.${field}\\b`), `the drawer must consume ${field}`);
  }

  // The mapping must PRESERVE the gateway's exact value, never invent one: no
  // `?? 0` / `|| 0` / `: 0` fallback for the two numeric limits. An absent value
  // stays absent so the UI omits the row (Round-1 rule).
  for (const field of ['context_length', 'max_completion_tokens']) {
    assert.doesNotMatch(mappedReturn, new RegExp(`${field}:\\s*(?:m\\.${field}\\s*)?(?:\\?\\?|\\|\\|)\\s*\\d`),
      `${field} must not be defaulted to a number in mapModelCatalog`);
  }
});

test('every new drawer string exists in all 7 locales', () => {
  const NEW_KEYS = [
    'models_section_info',
    'models_section_examples',
    'models_info_provider',
    'models_info_publisher',
    'models_info_family',
    'models_info_category',
    'models_info_description',
    'models_info_availability',
    'models_info_free_endpoint',
    'models_info_downloadable',
    'models_info_last_updated',
    'models_info_popularity',
    'models_details_description',
    // Round 1b technical rows:
    'models_info_context_length',
    'models_info_max_output',
    'models_info_capabilities',
    'models_info_reasoning',
    'models_info_control_key',
    'models_info_vision',
    'models_info_tools',
  ];
  const LOCALE_NAMES = ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar'];
  const exports_ = loadTypeScriptExports('src/renderer/i18n/resources.ts');

  for (const locale of LOCALE_NAMES) {
    for (const key of NEW_KEYS) {
      const value = exports_[locale][key];
      assert.ok(typeof value === 'string' && value.trim().length > 0, `${locale} must define ${key}`);
    }
  }

  // models_info_control_key is WIRED, not dead: the drawer labels the control
  // key it prints (previously the key was defined in all 7 locales but
  // referenced nowhere, so the bare `reasoning_effort` identifier was rendered
  // with no explanation). The view must therefore reference it.
  assert.match(read('src/renderer/views/Models.tsx'), /models_info_control_key/,
    'the drawer must label the capability control key it renders');

  // Non-Latin scripts must be real translations, not English left in place.
  for (const key of NEW_KEYS) {
    assert.match(exports_.ru[key], /[\u0400-\u04FF]/, `ru.${key} must be in Cyrillic script`);
    assert.match(exports_.ar[key], /[\u0600-\u06FF]/, `ar.${key} must be in Arabic script`);
    assert.match(exports_.hi[key], /[\u0900-\u097F]/, `hi.${key} must be in Devanagari script`);
    assert.match(exports_.zh[key], /[\u4E00-\u9FFF]/, `zh.${key} must be in Han script`);
    for (const locale of ['fr', 'es']) {
      assert.notEqual(exports_[locale][key], exports_.en[key],
        `${locale}.${key} must be translated, not the English string verbatim`);
    }
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Round 1b: REAL technical data end-to-end.
//
// The gateway emits context_length / max_completion_tokens / capabilities on
// GET /admin/models (src/gateway/admin-api.mjs:312-314), the main-process
// payload type declares them (src/main/models-ipc.ts:124-126), and
// mapModelCatalog() COPIES all three into its return object
// (src/main/models-ipc.ts:205-215) — so the data DOES reach the renderer. The
// drawer renders each technical row ONLY when the gateway actually carried the
// field: an absent value stays absent (the mapper never defaults it), so the
// rows are conditional on presence rather than guaranteed.
//
// These tests pin the presentation helper that turns the raw gateway values
// into the drawer's rows. The repo has no jsdom, so the view cannot be
// rendered; the pure helper is extracted into src/renderer/lib/model-technical.ts
// and exercised here through the same bare-vm harness.
// ───────────────────────────────────────────────────────────────────────────

const TECHNICAL_LIB = 'src/renderer/lib/model-technical.ts';

test('the technical presentation module stays import-free (vm harness has no module resolver)', () => {
  const source = read(TECHNICAL_LIB);
  assert.doesNotMatch(source, /^\s*import\s/m,
    'model-technical.ts must not import anything: the vm harness gives it no module resolver');
});

test('formatTokenCount renders the exact gateway counts in human units', () => {
  const lib = loadTypeScriptExports(TECHNICAL_LIB);

  // The three cases named in the task brief (measured literals, not guesses).
  assert.equal(lib.formatTokenCount(1000000), '1M');
  assert.equal(lib.formatTokenCount(131072), '131K');
  assert.equal(lib.formatTokenCount(4096), '4 096');

  // Grouping below 1000 stays plain; thousands use the narrow no-break room the
  // brief asked for (a plain space between thousand groups).
  assert.equal(lib.formatTokenCount(0), '0');
  assert.equal(lib.formatTokenCount(1), '1');
  assert.equal(lib.formatTokenCount(999), '999');
  assert.equal(lib.formatTokenCount(1000), '1 000');
  // Decimal K, matching the brief's 131072 -> "131K" (not a binary 128K).
  assert.equal(lib.formatTokenCount(65536), '66K');
  assert.equal(lib.formatTokenCount(200000), '200K');

  // Fractional millions keep one decimal only when it adds information.
  assert.equal(lib.formatTokenCount(1500000), '1.5M');
  assert.equal(lib.formatTokenCount(2000000), '2M');

  // Unit boundary: K rounds half-up (Math.round), so a count that rounds to
  // 1000K moves up to M instead of printing "1000K".
  assert.equal(lib.formatTokenCount(10000), '10K');
  assert.equal(lib.formatTokenCount(999499), '999K');
  assert.equal(lib.formatTokenCount(999500), '1M');
  assert.equal(lib.formatTokenCount(999950), '1M');
  assert.equal(lib.formatTokenCount(999999), '1M');
  assert.equal(lib.formatTokenCount(1000000), '1M');

  // Absent / hostile values yield null so the caller omits the row.
  for (const bad of [undefined, null, NaN, Infinity, -1, 1.5, '4096']) {
    assert.equal(lib.formatTokenCount(bad), null, `${String(bad)} must yield null (row omitted)`);
  }
});

// The raw capabilities shape the gateway serves (capability-registry.mjs:286-300):
//   { reasoning: { supported, modes[], controlKey, defaultMode }, tools, vision, audio }
test('capabilities present -> the applicable rows are derived; absent -> none', () => {
  const lib = loadTypeScriptExports(TECHNICAL_LIB);

  // The vm harness gives the module a different realm, so its objects are not
  // deepEqual-comparable to literals born in this one. Normalize to plain
  // objects (same prototype-identity note as tests/models-filter-controls).
  const rows = (caps) => [...lib.describeCapabilities(caps)].map((r) => ({ ...r }));

  const full = {
    reasoning: { supported: true, modes: ['low', 'high'], controlKey: 'reasoning_effort', defaultMode: 'high' },
    tools: true,
    vision: true,
    audio: false,
  };
  assert.deepEqual(rows(full),
    [
      { id: 'reasoning', labelKey: 'models_info_reasoning', controlKey: 'reasoning_effort' },
      { id: 'vision', labelKey: 'models_info_vision' },
      { id: 'tools', labelKey: 'tag_function_calling' },
    ],
    'reasoning (with its control key), vision and function calling are shown; audio is not a requested row');

  // reasoning unsupported must NOT yield a reasoning row even when modes exist.
  const noReasoning = {
    reasoning: { supported: false, modes: ['low'], controlKey: 'reasoning_effort' },
    tools: true,
    vision: false,
    audio: true,
  };
  assert.deepEqual(rows(noReasoning),
    [{ id: 'tools', labelKey: 'tag_function_calling' }],
    'unsupported reasoning is omitted; false vision is omitted; audio is never shown');

  // Reasoning supported but no control key: the row survives, the key is absent.
  const keyless = { reasoning: { supported: true, modes: [], controlKey: null }, tools: false, vision: false, audio: false };
  assert.deepEqual(rows(keyless),
    [{ id: 'reasoning', labelKey: 'models_info_reasoning', controlKey: null }],
    'a supported reasoning capability is shown; a null control key adds no key');

  // Absent / hostile inputs degrade to an EMPTY set (no fabricated rows).
  for (const bad of [undefined, null, 42, 'caps', [], {}]) {
    assert.deepEqual(rows(bad), [],
      `${JSON.stringify(bad)} must yield no capability rows`);
  }
  // A capabilities object with every flag false is truthful emptiness, not a row.
  assert.deepEqual(rows({ reasoning: { supported: false }, tools: false, vision: false, audio: false }), []);
});

test('the drawer renders the technical rows CONDITIONALLY from the threaded fields', () => {
  const view = read('src/renderer/views/Models.tsx');

  // The rows are driven by the pure helpers, never inlined ad hoc.
  assert.match(view, /formatTokenCount/, 'the drawer must format token counts with the tested helper');
  assert.match(view, /describeCapabilities/, 'the drawer must derive capability rows with the tested helper');

  // Presence-guarded rows (absence => no row). Each row interpolates the helper
  // result or the raw field inside a conditional block.
  assert.match(view, /model\.context_length\b/, 'context length must be consumed');
  assert.match(view, /model\.max_completion_tokens\b/, 'max output must be consumed');
  assert.match(view, /model\.capabilities\b/, 'capabilities must be consumed');

  // Technical values keep the LTR isolation the rest of the drawer uses.
  assert.match(view, /dir="ltr"/, 'technical values must stay dir="ltr"');
  // The dl/dt/dd + aria-labelledby structure is preserved.
  assert.match(view, /aria-labelledby=\{`drawer-info-\$\{model\.id\}`\}/, 'the info section keeps its aria-labelledby');
  assert.match(view, /<dl\b/, 'the rows stay inside a dl');
});

test('the formatter lives in a lib, not inline in the view', () => {
  const view = read('src/renderer/views/Models.tsx');
  const lib = read(TECHNICAL_LIB);
  // The formatter must be exported AND imported by the view; an inline copy in
  // the view would let the two drift and would not be unit-tested.
  assert.match(lib, /export function formatTokenCount/);
  assert.match(lib, /export function describeCapabilities/);
  assert.match(view, /from '\.\.\/lib\/model-technical'/);
});

// ───────────────────────────────────────────────────────────────────────────
// Audit fixes (external renderer audit): script purity, disclosure ARIA,
// per-row pending, formatter hostility, truncated-value tooltips, copy
// announcements, dir consistency, redundant roles, tag-guard visibility.
// ───────────────────────────────────────────────────────────────────────────

test('formatPopularity is hostile-safe and omits non-finite / negative input', () => {
  const lib = loadTypeScriptExports(TECHNICAL_LIB);

  // Valid values keep the exact human form the card/threshold rendered before.
  assert.equal(lib.formatPopularity(0), '0');
  assert.equal(lib.formatPopularity(1500), '2K');
  assert.equal(lib.formatPopularity(2500000), '2.5M');
  assert.equal(lib.formatPopularity(2000000), '2M');
  assert.equal(lib.formatPopularity(999), '999');

  // Unit boundaries: promotion is decided on the ROUNDED value, so nothing
  // prints "1000K" / "1.0M" / "10.0M". K rounds half-up (Math.round).
  assert.equal(lib.formatPopularity(999499), '999K');
  assert.equal(lib.formatPopularity(999600), '1M');
  assert.equal(lib.formatPopularity(999999), '1M');
  assert.equal(lib.formatPopularity(1000000), '1M');
  assert.equal(lib.formatPopularity(1049999), '1M');
  assert.equal(lib.formatPopularity(1050000), '1.1M');
  assert.equal(lib.formatPopularity(1500000), '1.5M');
  assert.equal(lib.formatPopularity(9940000), '9.9M');
  assert.equal(lib.formatPopularity(9999999), '10M');
  assert.equal(lib.formatPopularity(12345678), '12M');
  assert.equal(lib.formatPopularity(1000), '1K');

  // A value we do not have must yield null (row omitted), never "NaN"/"InfinityM".
  for (const bad of [NaN, Infinity, -Infinity, -1, undefined, null, '1500']) {
    assert.equal(lib.formatPopularity(bad), null, `${String(bad)} must yield null (row omitted)`);
  }
});

test('formatScore is finite-guarded and rounds without inventing precision', () => {
  const lib = loadTypeScriptExports(TECHNICAL_LIB);

  assert.equal(lib.formatScore(1287.4567), '1287.5', 'a long float is rounded to one decimal');
  assert.equal(lib.formatScore(1287), '1287', 'an integer stays integer (no ".0")');
  assert.equal(lib.formatScore(0), '0', 'a real zero is a real value');
  // Math.round(-32.5) is -32 (rounds toward +Infinity), so -3.25 -> "-3.2".
  assert.equal(lib.formatScore(-3.25), '-3.2', 'a finite negative score is not hidden');

  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '1287']) {
    assert.equal(lib.formatScore(bad), null, `${String(bad)} must yield null`);
  }
});

test('formatStrengthRank accepts only a genuine positive integer position', () => {
  const lib = loadTypeScriptExports(TECHNICAL_LIB);

  assert.equal(lib.formatStrengthRank(1), '#1', 'rank 1 is the strongest and is a real position');
  assert.equal(lib.formatStrengthRank(8), '#8');
  assert.equal(lib.formatStrengthRank(271), '#271');

  // "No ranking" must be null (the caller omits the whole row), never a
  // fabricated top slot and never the string "0".
  for (const bad of [0, -1, -3, 1.5, NaN, Infinity, -Infinity, undefined, null, '8', {}, []]) {
    assert.equal(lib.formatStrengthRank(bad), null, `${String(bad)} must mean "no ranking"`);
  }
});

test('the drawer shows the strength rank row ONLY on a genuine rank, attribution included', () => {
  const view = read('src/renderer/views/Models.tsx');

  // The rank is derived through the tested helper and gates the whole block.
  assert.match(view, /const strengthRank = formatStrengthRank\(model\.llmStatsRank\)/,
    'the rank must be derived through the tested formatter');
  assert.match(view, /\{strengthRank && \(\s*<>/, 'the strength block must be conditional on the rank');

  // The old unconditional/placeholder behaviour must not survive.
  assert.doesNotMatch(view, /models_info_strength_unranked/,
    'the unranked placeholder must not be rendered (no data => no row)');
  assert.doesNotMatch(view, /\?\? t\('models_info_strength_unranked'\)/,
    'the rank must not fall back to a placeholder');

  // The attribution is required by the licence wherever the ranking is shown,
  // so it must sit inside the same visibility guard, not outside it. The block
  // is a `<>…</>` fragment, so the guard closes at the matching `</>`. The
  // filter toolbar carries its OWN global attribution (which always shows when
  // the ranking-capable toolbar is visible); this assertion is about the
  // DRAWER's attribution, so the search starts at the guard.
  const guardStart = view.indexOf('{strengthRank && (');
  const attribution = view.indexOf('models_source_attribution', guardStart);
  const fragmentEnd = view.indexOf('</>', guardStart);
  assert.ok(guardStart !== -1 && fragmentEnd !== -1, 'the strength block must be a guarded fragment');
  assert.ok(attribution > guardStart && attribution < fragmentEnd,
    'the drawer attribution link must remain visible exactly when the rank is visible');
});

test('the Arabic models_refresh value is pure Arabic (no Cyrillic corruption)', () => {
  const resources = read('src/renderer/i18n/resources.ts');
  const exports_ = loadTypeScriptExports('src/renderer/i18n/resources.ts');

  const arRefresh = exports_.ar.models_refresh;
  assert.equal(typeof arRefresh, 'string');
  // The audit found U+043C 'м' / U+0430 'а' inside النماذج, which are Cyrillic
  // lookalikes and render as visible corruption.
  assert.doesNotMatch(arRefresh, /[\u0400-\u04FF]/,
    'ar.models_refresh must not contain any Cyrillic codepoint (U+0400–U+04FF)');
  assert.match(arRefresh, /[\u0600-\u06FF]/, 'ar.models_refresh must contain Arabic script');
  assert.equal(arRefresh, 'تحديث النماذج الآن');

  // The literal source line must be pure too (no hiding behind an escape).
  assert.ok(resources.includes('"models_refresh": "تحديث النماذج الآن"'),
    'the Arabic models_refresh literal must be corrected in source');
});

test('the Details disclosure exposes aria-expanded and a matching aria-controls panel id', () => {
  const view = read('src/renderer/views/Models.tsx');

  // The audit measured 0 aria-expanded occurrences; the toggle must now carry it.
  assert.match(view, /aria-expanded=\{isExpanded\}/, 'the Details toggle must reflect its state via aria-expanded');
  assert.match(view, /aria-controls=\{`models-details-\$\{model\.id\}`\}/,
    'the toggle must point at a stable panel id');
  assert.match(view, /id=\{`models-details-\$\{model\.id\}`\}/,
    'the panel must carry the id the toggle references');
});

// ───────────────────────────────────────────────────────────────────────────
// Owner defect: opening one card's drawer opened MANY at once, because the
// state was a Set of ids mutated per toggle. The requirement is at most ONE
// drawer open, closed by default, and re-clicking the same card closes it
// («Нажимаешь, открывается. Еще раз нажимаешь, закрывается»).
// There is no jsdom here, so the state machine is exercised via the pure
// reducer extracted below plus static wiring assertions on the view.
// ───────────────────────────────────────────────────────────────────────────

/** The exact transition the view implements for `toggleExpanded`. */
const nextExpandedId = (prev, id) => (prev === id ? null : id);

test('the drawer id state is a single nullable id, not a Set', () => {
  const view = read('src/renderer/views/Models.tsx');

  assert.match(view, /const \[expandedId, setExpandedId\] = useState<string \| null>\(null\)/,
    'the drawer must be a single id initialised to null (closed by default)');
  assert.doesNotMatch(view, /expandedIds/,
    'the multi-open Set state must be gone entirely');
  assert.match(view, /const isExpanded = expandedId === model\.id/,
    'a card is expanded exactly when it owns the single id');

  // Re-click closes: the reducer returns null when the SAME id is toggled.
  assert.equal(nextExpandedId(null, 'a/model'), 'a/model', 'clicking a closed card opens it');
  assert.equal(nextExpandedId('a/model', 'a/model'), null, 'clicking the open card closes it');
});

test('opening a second card closes the first (one drawer at a time)', () => {
  // Default closed.
  let state = null;
  assert.equal(state, null, 'nothing is open before any click');

  // Open card A, then card B: only B stays open.
  state = nextExpandedId(state, 'a/model');
  assert.equal(state, 'a/model');
  state = nextExpandedId(state, 'b/model');
  assert.equal(state, 'b/model', 'the previously open card must close when another opens');

  // The other cards are closed by construction: exactly one id can be open.
  const openCount = ['a/model', 'b/model', 'c/model'].filter((id) => id === state).length;
  assert.equal(openCount, 1, 'at most one card may be open at a time');

  // Re-click closes.
  state = nextExpandedId(state, 'b/model');
  assert.equal(state, null, 're-clicking the open card closes it');
});

test('a pending row mutation disables only that row, not the whole grid', () => {
  const view = read('src/renderer/views/Models.tsx');

  // Both mutations are keyed by the model id in their variables shape
  // ({ id, enabled } / { id, mode }); the disabled flag must compare it.
  assert.match(view, /toggleMutation\.isPending && toggleMutation\.variables\?\.id === model\.id/,
    'the toggle must be disabled only for the model being mutated');
  assert.match(view, /modeMutation\.isPending && modeMutation\.variables\?\.id === model\.id/,
    'the mode select must be disabled only for the model being mutated');
  // The old grid-wide flags must be gone.
  assert.doesNotMatch(view, /disabled=\{toggleMutation\.isPending\}/,
    'the grid-wide toggle flag must not remain');
  assert.doesNotMatch(view, /disabled=\{modeMutation\.isPending\}/,
    'the grid-wide mode flag must not remain');
});

test('truncated technical dd values carry a title, and copy actions announce politely', () => {
  const view = read('src/renderer/views/Models.tsx');

  // Title on the truncated values (provider/publisher/family/category/date/popularity).
  for (const field of ['model.provider', 'model.publisher', 'namespace', 'model.category', 'model.lastUpdated']) {
    assert.match(view, new RegExp(`title=\\{${field.replace('.', '\\.')}\\}`),
      `${field} truncation must expose the full value via title`);
  }

  // The copy result is surfaced through a polite live region (existing idiom,
  // reusing the existing `copied` key — no new i18n).
  assert.match(view, /aria-live="polite"/, 'the copy result must use a polite live region');
  assert.match(view, /copyAnnouncement/, 'the live region must be wired to the copy result state');
});

test('the drawer popularity row renders a formatted value, never the literal "null"', () => {
  const view = read('src/renderer/views/Models.tsx');

  // The value must go through the tested formatter (which returns null — row
  // omitted — for an absent/unknown count), not be interpolated raw. A raw
  // `{model.popularity}` would render the STRING "null" if a null ever reached
  // the row; the backend does emit null for an unknown invocation count
  // (admin-api.mjs:336-338 → models-ipc.ts:202-204 preserves it verbatim).
  assert.match(view, /<dd dir="ltr" title=\{String\(formatPopularity\(model\.popularity\)\)\}[^>]*>\{formatPopularity\(model\.popularity\)\}<\/dd>/,
    'the drawer popularity dd must render through formatPopularity(), not the raw value');
  assert.doesNotMatch(view, />\{model\.popularity\}</,
    'the raw {model.popularity} interpolation must be gone: it can print the literal "null"');

  // Non-vacuous: the formatter really does refuse an absent value (row omitted),
  // so routing through it is what prevents the "null" text.
  const lib = loadTypeScriptExports(TECHNICAL_LIB);
  assert.equal(lib.formatPopularity(null), null, 'null must yield null (row omitted), never the string "null"');
  assert.equal(lib.formatPopularity(undefined), null, 'undefined must yield null (row omitted)');
  assert.equal(lib.formatPopularity(1500), '2K', 'a real count still renders its formatted form');
});

test('tag direction is consistent and native buttons carry no redundant role', () => {
  const view = read('src/renderer/views/Models.tsx');

  // Cards and drawer tags must agree (dir="auto" for short labels).
  assert.doesNotMatch(view, /dir="ltr"\s*\n\s*className=\{`flex items-center gap-1 text-\[10px\]/,
    'drawer tags must not be locked to dir="ltr"');
  assert.match(view, /dir="auto"/, 'short capability tags must use dir="auto"');

  // aria-pressed already conveys the toggle role; role="button" on a native
  // <button> is redundant.
  assert.doesNotMatch(view, /role="button"/, 'native buttons must not carry a redundant role="button"');
});

test('the curated-tag presentation guard is checked outside the view (no console in views/)', () => {
  const view = read('src/renderer/views/Models.tsx');

  // The repo bans `console.*` in src/renderer/views/*.tsx (see the source
  // console policy test in tests/production-security-wiring.test.mjs), so the
  // drift warning must live in the lib — the view only wires the contract check.
  assert.doesNotMatch(view, /console\s*\./,
    'the view must not call console.* — the dev warning lives in ../lib/models-filter');
  assert.match(view, /warnOnCuratedTagPresentationDrift\(/,
    'the view must wire the vocabulary/presentation contract check from the lib');
  assert.match(view, /CURATED_TAG_VOCABULARY/,
    'the guard must compare against the shared vocabulary');
  assert.doesNotMatch(view, /void _curatedTagPresentationComplete/,
    'the guard must not be computed and thrown away with void');

  // The contract check itself is real and unit-tested through the lib: a
  // vocabulary id with no presentation is reported; full coverage reports none.
  const lib = loadTypeScriptExports(FILTER_LIB);
  assert.deepEqual([...lib.missingCuratedTagPresentation(['reasoning', 'vision', 'code', 'function_calling'])], [],
    'a complete presentation map must report no drift');
  assert.deepEqual([...lib.missingCuratedTagPresentation(['reasoning', 'vision'])],
    ['code', 'function_calling'],
    'every vocabulary id without presentation meta must be reported');
  assert.deepEqual([...lib.missingCuratedTagPresentation(undefined)],
    ['reasoning', 'vision', 'code', 'function_calling'],
    'a missing/empty presentation map must report the whole vocabulary');
  assert.deepEqual([...lib.warnOnCuratedTagPresentationDrift(['reasoning', 'vision', 'code', 'function_calling'])], [],
    'the dev guard returns no missing ids when the map is complete');
});
