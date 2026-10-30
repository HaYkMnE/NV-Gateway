// Pet advisor tip targets (PET-SPEC-2026-10-26 sections 4.7 and 9): every
// `focusSetting` id a tip can carry must exist exactly once as an `id`
// attribute in src/renderer/views/*.tsx, in the view the tip navigates to.
// Static check: the repo has no jsdom, so the views cannot be rendered here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewsDir = path.join(root, 'src', 'renderer', 'views');

const TARGETS = {
  'dash-add-key': 'Dashboard.tsx',
  'request-deadline': 'Settings.tsx',
  'setting-tips': 'Settings.tsx',
  'setting-llm-stats': 'Settings.tsx',
  'setting-updates': 'Settings.tsx',
  'endpoint-gateway-token': 'Endpoint.tsx',
  'endpoint-model-id': 'Endpoint.tsx',
  'setting-auto-launch': 'Settings.tsx',
  'setting-performance-mode': 'Settings.tsx',
  'setting-language': 'Settings.tsx',
  'endpoint-url-anthropic': 'Endpoint.tsx',
  'models-filter-free': 'Models.tsx',
  'models-sort': 'Models.tsx',
  'logs-pause': 'Logs.tsx',
};

const views = fs.readdirSync(viewsDir)
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => ({ name, source: fs.readFileSync(path.join(viewsDir, name), 'utf8') }));

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// `id="x"` or `id={... 'x' ...}` (the conditional radio id), never htmlFor.
const idPattern = (id) => new RegExp(`(?<![\\w-])id=(?:"${escape(id)}"|\\{[^}]*'${escape(id)}'[^}]*\\})`, 'g');

for (const [id, file] of Object.entries(TARGETS)) {
  test(`tip target #${id} is declared exactly once, in ${file}`, () => {
    const hits = views.flatMap(({ name, source }) => (source.match(idPattern(id)) ?? []).map(() => name));
    assert.deepEqual(hits, [file]);
  });
}

test('the tip target list has 14 unique ids', () => {
  assert.equal(new Set(Object.keys(TARGETS)).size, 14);
});

test('the performance-mode id sits only on the checked radio', () => {
  const settings = views.find(({ name }) => name === 'Settings.tsx').source;
  assert.match(settings, /id=\{query\.data\.performanceMode === mode \? 'setting-performance-mode' : undefined\}/);
});

for (const file of ['Endpoint.tsx', 'Models.tsx', 'Logs.tsx']) {
  test(`${file} runs the pet focus block on a focusable heading`, () => {
    const source = views.find(({ name }) => name === file).source;
    assert.match(source, /import \{ focusPendingSetting, focusSettingFrom \} from '\.\.\/pet\/tips';/);
    assert.match(source, /useRef<unknown>\(focusSettingFrom\(location\.state\)\)/);
    assert.match(source, /focusPendingSetting\(pendingFocus\.current\)/);
    assert.match(source, /navigate\(location\.pathname, \{ replace: true, state: null \}\)/);
    assert.match(source, /<h2 ref=\{headingRef\} tabIndex=\{-1\}/);
  });
}
