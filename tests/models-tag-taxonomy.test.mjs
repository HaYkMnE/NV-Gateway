import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

// Owner 30.09: «слишком много лишних меток, убери хотя бы половину; блок меток
// СВЁРНУТ по умолчанию — один клик открывает, второй закрывает»; «уменьши самого
// робота, не рамку, чуть-чуть». Spec: design-art-virtuoso (fixed allow-list of
// canonical tags, collapsed toggle, robot SVG at 92% of its unchanged box).
// No jsdom in this repo: the view assertions are STATIC wiring checks.

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

const FILTER_LIB = 'src/renderer/lib/models-filter.ts';
const VIEW = 'src/renderer/views/Models.tsx';

// The spec table, verbatim. Each raw NGC label -> its canonical tag.
const SPEC = {
  MoE: ['Mixture-of-Experts', 'MoE', 'Multimodal MOE'],
  Guardrails: ['ai safety nemo guardrails', 'Guardrail', 'nemo guardrails', 'nemoguard', 'multilingual guard model'],
  Safety: ['content moderation', 'Content Moderator', 'Content Safety', 'dialogue safety', 'LLM Multimodal Safety',
    'LLM safety', 'multilingual content safety', 'Safety and moderation'],
  Retrieval: ['Agentic Retrieval', 'Code Retrieval', 'Image-Text Retrieval', 'nemo retriever', 'Nemotron Retriever'],
  Embedding: ['embedding'],
  Agents: ['Agent', 'agentic', 'Agentic AI', 'Long-running agents'],
  'Tool Use': ['Tool Use'],
  Multimodal: ['Multimodal', 'VLM', 'Vision Language Model', 'Image-to-Text', 'Image Captioning', 'Visual QA',
    'Visual Grounding', 'Omni'],
  OCR: ['OCR', 'document parsing', 'text and table extraction'],
  Coding: ['Coding'],
  Reasoning: ['Reasoning'],
  Math: ['math'],
  'Long Context': ['Long Context'],
  Translation: ['neural machine translation'],
  Video: ['Video'],
};

const HIDDEN = ['nemotron', 'nvidia nim', 'Open', 'Frontier', 'Large Language Models', 'text-to-text', 'Chat',
  'Customization', 'Instruction Following', 'Calibration', 'Causal Encoder Decoder', 'diffusion-llm',
  'KV Cache Optimization', 'Quantum Computing', 'cloudPartnerType:endpoint:cloud_partner_type_bitdeer',
  'supported language - english', 'tool_use'];

const swapCase = (s) => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');

test('every raw label in the spec maps to its canonical tag, case-insensitively', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  assert.equal(typeof lib.canonicalModelTag, 'function', 'canonicalModelTag must be exported');
  for (const [tag, raws] of Object.entries(SPEC)) {
    for (const raw of raws) {
      assert.equal(lib.canonicalModelTag(raw), tag, `${raw} -> ${tag}`);
      assert.equal(lib.canonicalModelTag(swapCase(raw)), tag, `${swapCase(raw)} (case-swapped) -> ${tag}`);
      assert.equal(lib.canonicalModelTag(`  ${raw.toUpperCase()} `), tag, `padded upper-case ${raw} -> ${tag}`);
    }
  }
  // The exported table is exactly the spec: same tags, same raw labels.
  const table = Object.fromEntries([...lib.CANONICAL_MODEL_TAGS].map((e) => [e.tag, [...e.raw]]));
  assert.deepEqual(table, SPEC, 'the allow-list must be exactly the art-director table');
});

test('a label outside the allow-list is hidden, and the chip row stays at <= 15 tags', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  for (const label of HIDDEN) {
    assert.equal(lib.canonicalModelTag(label), null, `${label} must be hidden`);
  }
  assert.equal(lib.canonicalModelTag(null), null);
  assert.equal(lib.canonicalModelTag(42), null);

  // A catalogue carrying EVERY raw label plus all the hidden ones.
  const everything = [
    ...Object.values(SPEC).flat().map((raw, i) => ({ id: `p/m${i}`, labels: [raw] })),
    { id: 'p/hidden', labels: HIDDEN },
  ];
  const chips = [...lib.collectModelLabels(everything)];
  assert.ok(chips.length <= 15, `at most 15 chips, got ${chips.length}`);
  assert.deepEqual([...chips].sort(), Object.keys(SPEC).sort(), 'only canonical tags reach the chip row');
  for (const label of HIDDEN) assert.ok(!chips.includes(label), `${label} must not be offered`);
});

test('a canonical tag nobody carries is not offered', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const chips = [...lib.collectModelLabels([{ id: 'a/x', labels: ['VLM', 'Chat'] }, { id: 'b/y', labels: [] }])];
  assert.deepEqual(chips, ['Multimodal']);
  assert.deepEqual([...lib.collectModelLabels([])], []);
});

test('selecting a canonical tag matches every model carrying ANY of its raw labels (OR across tags)', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const base = { ...lib.DEFAULT_MODEL_FILTERS, sortBy: 'name' };
  const models = [
    { id: 'a/vlm', labels: ['VLM'] },
    { id: 'b/omni', labels: ['omni'] },
    { id: 'c/captions', labels: ['Image Captioning', 'Chat'] },
    { id: 'd/coder', labels: ['coding'] },
    { id: 'e/chat', labels: ['Chat'] },
  ];
  // Order-free: this test is about membership, not the sort.
  const ids = (list) => list.map((m) => m.id).sort();
  assert.deepEqual(ids(lib.applyModelFilters(models, { ...base, labels: ['Multimodal'] })),
    ['a/vlm', 'b/omni', 'c/captions'], 'Multimodal matches VLM / Omni / Image Captioning in any casing');
  assert.deepEqual(ids(lib.applyModelFilters(models, { ...base, labels: ['Multimodal', 'Coding'] })),
    ['a/vlm', 'b/omni', 'c/captions', 'd/coder'], 'two tags widen (any-of)');
  assert.deepEqual(ids(lib.applyModelFilters(models, { ...base, labels: ['Video'] })), [],
    'a tag no model carries matches nothing');
});

test('chips are ordered by model count descending, ties alphabetical', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  const models = [
    { id: 'a', labels: ['math', 'Reasoning'] },
    { id: 'b', labels: ['Reasoning', 'OCR'] },
    { id: 'c', labels: ['Reasoning', 'Agent', 'agentic'] }, // one model, counted once for Agents
    { id: 'd', labels: ['Coding', 'Agentic AI'] },
    { id: 'e', labels: ['Coding'] },
  ];
  // Reasoning 3; Agents 2, Coding 2; Math 1, OCR 1.
  assert.deepEqual([...lib.collectModelLabels(models)], ['Reasoning', 'Agents', 'Coding', 'Math', 'OCR']);
  assert.deepEqual([...lib.collectModelLabels([...models].reverse())], ['Reasoning', 'Agents', 'Coding', 'Math', 'OCR'],
    'order must not depend on catalogue order');
});

test('selected tags that vanish after a reload are pruned (E)', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  assert.equal(typeof lib.pruneSelectedLabels, 'function');
  const selected = ['Coding', 'Video'];
  assert.deepEqual([...lib.pruneSelectedLabels(selected, ['Coding', 'Math'])], ['Coding']);
  const same = ['Coding'];
  assert.equal(lib.pruneSelectedLabels(same, ['Coding']), same, 'unchanged selection keeps its identity (no re-render loop)');
  assert.deepEqual([...lib.pruneSelectedLabels(['coding'], ['Coding'])], ['coding'], 'case-insensitive, like the filter');

  const view = read(VIEW);
  assert.match(view, /pruneSelectedLabels\(prev\.labels, availableLabels\)/,
    'the view must drop selected tags that are no longer offered');
  assert.match(view, /\[filters\.labels, availableLabels\]\)/, 'the pruning effect must re-run on reload');
});

test('the tag block is a collapsed toggle button by default (C)', () => {
  const view = read(VIEW);
  assert.match(view, /const \[labelsOpen, setLabelsOpen\] = useState\(false\);/, 'collapsed on every visit');
  assert.doesNotMatch(view, /(localStorage|sessionStorage)[^\n]*labelsOpen|labelsOpen[^\n]*(localStorage|sessionStorage)/,
    'the open state is not persisted');
  assert.match(view,
    /<button\s+type="button"\s+aria-expanded=\{labelsOpen\}\s+aria-controls="models-label-chips"\s+onClick=\{\(\) => setLabelsOpen\(\(open\) => !open\)\}\s+className="flex items-center gap-1 text-xs font-medium text-textMuted hover:text-accent-neon transition-colors cursor-pointer min-h-6"/,
    'the toggle is a real button with aria-expanded / aria-controls and the details-toggle classes');
  assert.match(view, /\{labelsOpen \? <ChevronUp aria-hidden size=\{14\} \/> : <ChevronDown aria-hidden size=\{14\} \/>\}/);
  assert.match(view,
    /filters\.labels\.length > 0\s*\? t\('models_filter_labels_selected', \{ count: filters\.labels\.length \}\)\s*: t\('models_filter_labels_count', \{ count: availableLabels\.length \}\)/,
    'text shows the selected count when tags are selected, else the tag count');

  // Chips render ONLY inside the open container.
  const gate = view.indexOf('{labelsOpen && availableLabels.length > 0 && (');
  const container = view.indexOf('<div id="models-label-chips" className="basis-full flex flex-wrap gap-1.5"');
  const chips = view.indexOf('availableLabels.map((label)');
  assert.ok(gate > 0 && container > gate && chips > container, 'chips are rendered only when open');
  assert.equal(view.split('id="models-label-chips"').length - 1, 1, 'the id is unique');
  // The static "Метки" span is gone.
  assert.doesNotMatch(view, /<span>\{t\('models_filter_labels_label'\)\}<\/span>/);
});

test('the two new strings exist in all 7 locales with the {{count}} placeholder (D)', () => {
  const res = loadTypeScriptExports('src/renderer/i18n/resources.ts');
  assert.equal(res.en.models_filter_labels_count, 'Tags ({{count}})');
  assert.equal(res.en.models_filter_labels_selected, 'Tags · {{count}} selected');
  assert.equal(res.ru.models_filter_labels_count, 'Метки ({{count}})');
  assert.equal(res.ru.models_filter_labels_selected, 'Метки · выбрано {{count}}');
  for (const locale of ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar']) {
    for (const key of ['models_filter_labels_count', 'models_filter_labels_selected']) {
      assert.match(res[locale][key] ?? '', /\{\{count\}\}/, `${locale}.${key} must keep {{count}}`);
    }
  }
});

test('the robot artwork is 92% of its unchanged box; the hacker is untouched (A)', () => {
  const css = read('src/renderer/pet/pet.css');
  const widget = read('src/renderer/pet/PetWidget.tsx');
  const rule = (sel) => {
    const i = css.indexOf(`${sel} {`);
    return i < 0 ? '' : css.slice(i, css.indexOf('}', i));
  };
  assert.match(rule('.nv-pet-wrap .mascot-svg'), /width:\s*92%;\s*height:\s*92%;/);
  assert.match(rule('.nv-pet-wrap .mascot-viewport'), /width:\s*191px;\s*height:\s*176\.31px;/, 'the frame is unchanged');
  assert.match(rule('.nv-pet-wrap .hacker-viewport'), /width:\s*100%;/, 'the hacker column is unchanged');
  // .mascot-svg is the robot's SVG only — the hacker is a canvas.
  assert.equal(widget.split('className="mascot-svg"').length - 1, 1);
  assert.match(widget, /<svg className="mascot-svg" viewBox="0 0 130 120"/);
});
