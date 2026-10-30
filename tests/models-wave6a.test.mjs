// Wave 6A regressions for the Models view (F1, F3, F4, F5/F9, F7, F8).
//
// The repo has no jsdom, so — like tests/models-details-drawer.test.mjs — the
// pure helpers are transpiled and run in a bare `vm` context, and the view's
// wiring is pinned with static source assertions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const TECH_LIB = 'src/renderer/lib/model-technical.ts';
const VIEW = 'src/renderer/views/Models.tsx';
const FILTER_LIB = 'src/renderer/lib/models-filter.ts';

function loadTypeScriptExports(relative) {
  const compiled = typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { Error, exports: module.exports, module }, { filename: relative });
  return module.exports;
}

/**
 * Minimal POSIX-shell reading of ONE word: '…' literal runs, \x escapes, and
 * any unquoted " $ ` is rejected (it would be interpreted by the shell).
 */
function readShellWord(src) {
  let i = 0;
  let word = '';
  while (i < src.length && !/\s/.test(src[i])) {
    const c = src[i];
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new Error('unterminated single quote');
      word += src.slice(i + 1, end);
      i = end + 1;
    } else if (c === '\\') {
      word += src[i + 1];
      i += 2;
    } else if (c === '"' || c === '$' || c === '`' || c === ';' || c === '|' || c === '&') {
      throw new Error(`unquoted shell metacharacter ${c}`);
    } else {
      word += c;
      i += 1;
    }
  }
  return { word, rest: src.slice(i) };
}

test('F5/F9: a count that rounds to 1000M rolls over to B', () => {
  const lib = loadTypeScriptExports(TECH_LIB);
  assert.equal(lib.formatPopularity(999_950_000), '1B');
  assert.equal(lib.formatPopularity(2_500_000_000), '2.5B');
  assert.equal(lib.formatPopularity(999_499_999), '999M', 'below the rollover stays in M');
  assert.equal(lib.formatTokenCount(999_950_000), '1B');
  assert.equal(lib.formatTokenCount(1_500_000_000), '1.5B');
  assert.equal(lib.formatTokenCount(999_000_000), '999M', 'below the rollover stays in M');
});

test('T-tier: a count that rounds to 1000B rolls over to T', () => {
  const lib = loadTypeScriptExports(TECH_LIB);
  for (const fmt of ['formatPopularity', 'formatTokenCount']) {
    assert.equal(lib[fmt](999_950_000_000), '1T', `${fmt}: 999_950_000_000`);
    assert.equal(lib[fmt](1e12), '1T', `${fmt}: 1e12`);
    assert.equal(lib[fmt](1.5e12), '1.5T', `${fmt}: 1.5e12`);
    assert.equal(lib[fmt](999_000_000_000), '999B', `${fmt}: below the rollover stays in B`);
  }
});

test('T-tier upper bound: a count that rounds to 1000T or more is omitted (null)', () => {
  const lib = loadTypeScriptExports(TECH_LIB);
  for (const fmt of ['formatPopularity', 'formatTokenCount']) {
    assert.equal(lib[fmt](1e15), null, `${fmt}: 1e15`);
    assert.equal(lib[fmt](Number.MAX_SAFE_INTEGER), null, `${fmt}: MAX_SAFE_INTEGER`);
    assert.equal(lib[fmt](999e12), '999T', `${fmt}: 999e12 still renders`);
  }
  assert.equal(lib.formatPopularity(1e300), null, 'formatPopularity: 1e300');
});

test('F2: a tool_use model yields exactly one Function Calling drawer tag, no Tools tag', () => {
  const lib = loadTypeScriptExports(FILTER_LIB);
  assert.deepEqual([...lib.curateCapabilityTags([], ['tool_use'])], ['function_calling']);
  assert.deepEqual([...lib.curateCapabilityTags([{ id: 'function_calling' }], ['tools'])], ['function_calling'],
    'card tag + tools label still curate to one tag');
  assert.ok(![...lib.CURATED_TAG_VOCABULARY].some((e) => e.id === 'tools'), 'tools is not a drawer tag');
  assert.equal('tools' in lib.deriveTagSignals(['tool_use']), false, 'no separate tools signal');
  assert.doesNotMatch(read(VIEW), /labelKey: 'tag_tools'/, 'the view has no Tools presentation entry');

  // Filtering still runs on the raw label.
  const models = [{ id: 'a/tooly', labels: ['tool_use'] }, { id: 'b/plain', labels: ['chat'] }];
  const kept = lib.applyModelFilters(models, { ...lib.DEFAULT_MODEL_FILTERS, labels: ['tool_use'] });
  assert.deepEqual(kept.map((m) => m.id), ['a/tooly']);
  assert.ok(![...lib.collectModelLabels(models)].includes('tool_use'),
    'tool_use is outside the canonical allow-list (owner 30.09), so no raw chip is offered');
});

test('F9: a fractional popularity never prints as a raw fraction', () => {
  const lib = loadTypeScriptExports(TECH_LIB);
  assert.equal(lib.formatPopularity(12.7), '13');
  assert.equal(lib.formatPopularity(0.4), '0');
  assert.equal(lib.formatPopularity(999.6), '1K', 'a value that rounds to 1000 reads 1K, not 1000');
  assert.equal(lib.formatPopularity(42), '42', 'integers are unchanged');
  assert.equal(lib.formatPopularity(1500), '2K', 'the K tier is unchanged');
});

test('F7: cURL snippet keeps the legacy text and only a token placeholder', () => {
  const lib = loadTypeScriptExports(TECH_LIB);
  const snippet = lib.buildCurlSnippet(12000, 'meta/llama-3.1-8b-instruct');
  assert.equal(snippet, [
    'curl http://127.0.0.1:12000/v1/chat/completions \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Authorization: Bearer $GATEWAY_TOKEN" \\',
    "  -d '{",
    '    "model": "meta/llama-3.1-8b-instruct",',
    '    "messages": [{"role": "user", "content": "Hello!"}]',
    "  }'",
  ].join('\n'));
  assert.doesNotMatch(snippet, /nvapi-/, 'a real key must never be inlined');
});

test('F7: shell/JSON-special characters in a model id cannot break out of -d', () => {
  const lib = loadTypeScriptExports(TECH_LIB);
  const hostile = ["evil'; touch pwned #", 'a"b\\c', "x'\"'$(id)`id`", 'line\nbreak'];
  for (const id of hostile) {
    const snippet = lib.buildCurlSnippet(12000, id);
    const { word, rest } = readShellWord(snippet.slice(snippet.indexOf('-d ') + 3));
    assert.equal(rest.trim(), '', `nothing may follow the -d argument for ${JSON.stringify(id)}`);
    assert.equal(JSON.parse(word).model, id, `the body must carry the exact id ${JSON.stringify(id)}`);
    assert.match(snippet, /Authorization: Bearer \$GATEWAY_TOKEN"/);
  }
});

test('F7: the view builds the snippet through the escaping helper', () => {
  const view = read(VIEW);
  assert.match(view, /const curlSnippet = buildCurlSnippet\(gatewayPort, model\.id\);/);
  assert.doesNotMatch(view, /"model": "\$\{model\.id\}"/, 'the id must not be interpolated raw');
});

test('F1: an absent OR null key list is "unknown", consistently for keys and keysKnown', () => {
  const view = read(VIEW);
  assert.match(view, /const rawKeys = keysQuery\.data\?\.keys;/);
  assert.match(view, /const keys = \(Array\.isArray\(rawKeys\) \? rawKeys : \[\]\) as AdminKey\[\];/);
  assert.match(view, /const keysKnown = Array\.isArray\(rawKeys\);/);
  assert.doesNotMatch(view, /keysQuery\.data\?\.keys !== undefined/,
    '`!== undefined` treats null as a known list and prints 0/0 keys');
});

test('F3: the copy-feedback timer is cleared on re-copy and on unmount', () => {
  const view = read(VIEW);
  const copyBody = view.slice(view.indexOf('const copy = async'), view.indexOf('if (unavailable)'));
  assert.match(copyBody,
    /window\.clearTimeout\(copiedTimerRef\.current\);\s*copiedTimerRef\.current = window\.setTimeout\(\(\) => setCopiedId\(null\), 2000\);/);
  assert.doesNotMatch(copyBody, /^\s*window\.setTimeout\(\(\) => setCopiedId/m, 'no fire-and-forget timer');
  assert.match(view, /useEffect\(\(\) => \(\) => window\.clearTimeout\(copiedTimerRef\.current\), \[\]\);/);
});

test('F4: an expanded id whose model left the visible list is dropped', () => {
  const view = read(VIEW);
  assert.match(view,
    /useEffect\(\(\) => \{\s*if \(expandedId !== null && !filteredModels\.some\(\(m\) => m\.id === expandedId\)\) setExpandedId\(null\);\s*\}, \[expandedId, filteredModels\]\);/);
});

test('F8: label chip selection is case-insensitive in the view', () => {
  const view = read(VIEW);
  assert.doesNotMatch(view, /labels\.includes\(label\)/, 'exact-case includes() must be gone');
  assert.match(view, /prev\.labels\.some\(\(l\) => labelMatchesSelection\(l, label\)\)/);
  assert.match(view, /prev\.labels\.filter\(\(l\) => !labelMatchesSelection\(l, label\)\)/);
  assert.match(view, /const selected = filters\.labels\.some\(\(l\) => labelMatchesSelection\(l, label\)\);/);
  assert.match(view, /aria-pressed=\{selected\}/);
});
