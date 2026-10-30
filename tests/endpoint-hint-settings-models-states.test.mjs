// Endpoint OpenCode hint + localized snippet header, and the Settings per-model
// section's pending / error / empty states (art-director decision after CR7).
// Harness mirrors endpoint-query-error.test.mjs: the views are transpiled
// (react-jsx) and rendered with react-dom/server; only data/i18n/store
// dependencies are stubbed. `t` interpolates the REAL en resources so the
// rendered hint text (and its <bdi> spans) is what users see.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import typescript from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function transpile(relative) {
  return typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, jsx: typescript.JsxEmit.ReactJSX, esModuleInterop: true }
  }).outputText;
}
function evalModule(relative, extra = '', requireFn = require) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(relative) + extra, { module, exports: module.exports, require: requireFn, console, window: {} }, { filename: relative });
  return module.exports;
}

const resources = evalModule('src/renderer/i18n/resources.ts');
const LOCALES = ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar'];
const interpolate = (text, o = {}) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in o ? String(o[k]) : m));
const tEn = (k, o) => (k in resources.en ? interpolate(resources.en[k], o) : k);

const ok = (data) => ({ data, isPending: false, isError: false, error: null, refetch() {} });

function renderEndpoint({ tab } = {}) {
  const byKey = { keys: ok({ keys: [{}] }), models: ok({ models: [{ id: 'meta/llama', enabled: true }] }), 'gateway-credentials': ok({ port: 12000, gatewayToken: 'tok' }) };
  // Only the config-tab state is overridden (the initial 'opencode' tab), to render another tab.
  const reactForTab = tab ? { ...React, useState: (init) => React.useState(init === 'opencode' ? tab : init) } : React;
  const stubs = {
    react: reactForTab,
    '@tanstack/react-query': { useQuery: ({ queryKey }) => byKey[queryKey[0]] },
    'react-i18next': { useTranslation: () => ({ t: tEn }) },
    '../lib/api': { api: {}, queryKeys: { keys: ['keys'], models: ['models'] } },
    '../lib/frontend-state': { safeError: (_e, f) => f, knownCount: (d) => (d == null ? null : d.length) },
    '../lib/gateway-lifecycle': { useGatewayLifecycle: () => ({ status: { state: 'running' } }) },
    '../stores/config': { useConfigStore: () => ({ gatewayPort: 12000 }) },
    '../components/ProviderGlyph': { ProviderGlyph: () => null, resolveProvider: () => ({ tagBg: '#000', color: '#fff' }) },
    './opencodeConfig': evalModule('src/renderer/views/opencodeConfig.ts'),
    './clientConfigs': evalModule('src/renderer/views/clientConfigs.ts'),
    'react-router-dom': { useLocation: () => ({ pathname: '/', state: null }), useNavigate: () => () => {} },
    '../pet/tips': { focusPendingSetting: () => 'heading', focusSettingFrom: () => null },
  };
  const exp = evalModule('src/renderer/views/Endpoint.tsx', '', (id) => (id in stubs ? stubs[id] : require(id)));
  return renderToStaticMarkup(React.createElement(exp.Endpoint));
}

const BDI = '<bdi dir="ltr" class="font-mono">';
const HINT_OPEN = '<p class="text-xs text-textMuted mb-2">';
const textOf = (html) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

test('Endpoint: the OpenCode tab shows the merge hint with the block name and paths in LTR mono <bdi>', () => {
  const html = renderEndpoint();
  const at = html.indexOf(HINT_OPEN);
  assert.ok(at > 0, 'hint paragraph rendered on the OpenCode tab');
  const hint = html.slice(at, html.indexOf('</p>', at) + 4);
  assert.equal(textOf(hint),
    "Merge the provider.nvidia-gateway block into your opencode.json (global: ~/.config/opencode/opencode.json, or opencode.json in the project root). Don't replace the file: your other providers stay.");
  for (const literal of ['provider.nvidia-gateway', '~/.config/opencode/opencode.json', 'opencode.json']) {
    assert.ok(hint.includes(`${BDI}${literal}</bdi>`), `${literal} is wrapped in <bdi dir="ltr" class="font-mono">`);
  }
  assert.equal(hint.split(BDI).length - 1, 4, 'block name + 3 file/path mentions');
  // Placed between the header row and the <pre>.
  assert.ok(html.indexOf('OpenCode configuration</span>') < at && at < html.indexOf('<pre dir="ltr"'), 'header row < hint < pre');
});

test('Endpoint: the hint is OpenCode-only', () => {
  // Tabs since the "Works with any app" rework (CloudCode and the adapter-note
  // Anthropic tab are gone): a file client, a YAML client, a code client, a UI client.
  for (const tab of ['claude-code', 'continue', 'openai-python', 'cursor']) {
    const html = renderEndpoint({ tab });
    assert.ok(!html.includes(HINT_OPEN), `${tab}: no hint`);
    assert.ok(!html.includes('~/.config/opencode'), `${tab}: no OpenCode path`);
  }
});

test('Endpoint: the snippet header uses endpoint_config_snippet_title with the client label, classes kept', () => {
  assert.ok(renderEndpoint().includes('<span class="text-xs text-textMuted font-mono uppercase tracking-wider">OpenCode configuration</span>'));
  assert.ok(renderEndpoint({ tab: 'cursor' }).includes('<span class="text-xs text-textMuted font-mono uppercase tracking-wider">Cursor configuration</span>'));
  const src = read('src/renderer/views/Endpoint.tsx');
  assert.match(src, /\{t\('endpoint_config_snippet_title', \{ client: active\.label \}\)\}/);
  assert.doesNotMatch(src, /\{active\.label\} Configuration/);
});

test('i18n: the 2 new keys in all 7 locales, en/ru copy as specified, placeholders intact', () => {
  for (const loc of LOCALES) {
    const r = resources[loc];
    assert.ok(r.endpoint_config_snippet_title.includes('{{client}}'), `${loc}: {{client}}`);
    for (const ph of ['{{block}}', '{{file}}', '{{globalPath}}']) assert.ok(r.endpoint_opencode_hint.includes(ph), `${loc}: ${ph}`);
    assert.equal(r.endpoint_opencode_hint.split('{{file}}').length - 1, 2, `${loc}: {{file}} twice`);
    assert.ok(r.models_error && r.retry, `${loc}: models_error + retry exist`);
  }
  const fill = (s) => interpolate(s, { block: '`provider.nvidia-gateway`', file: 'opencode.json', globalPath: '~/.config/opencode/opencode.json' });
  assert.equal(resources.en.endpoint_config_snippet_title, '{{client}} configuration');
  assert.equal(resources.ru.endpoint_config_snippet_title, 'Конфигурация {{client}}');
  assert.equal(fill(resources.en.endpoint_opencode_hint),
    "Merge the `provider.nvidia-gateway` block into your opencode.json (global: ~/.config/opencode/opencode.json, or opencode.json in the project root). Don't replace the file: your other providers stay.");
  assert.equal(fill(resources.ru.endpoint_opencode_hint),
    'Добавьте блок `provider.nvidia-gateway` в ваш opencode.json (глобальный: ~/.config/opencode/opencode.json или opencode.json в корне проекта). Не заменяйте файл целиком: остальные провайдеры сохранятся.');
});

// ── Settings per-model section ──────────────────────────────────────────────
function renderModelsSection({ query, models = [], loading = false, error = null }) {
  const state = { models, loading, error, lastRefreshed: null, setModels() {}, setLoading() {}, setError() {}, setLastRefreshed() {} };
  const useModelsStore = () => state;
  useModelsStore.getState = () => state;
  const stubs = {
    '@tanstack/react-query': { useQuery: () => query, useMutation: () => ({ isPending: false, mutate() {} }), useQueryClient: () => ({}) },
    'react-router-dom': {},
    'react-i18next': { useTranslation: () => ({ t: (k) => k }) },
    '../lib/api': { api: { models() {} }, queryKeys: { models: ['models'], runtime: ['runtime'] } },
    '../stores/config': {},
    '../stores/models': { useModelsStore },
    '../lib/modal-context': {},
    '../pet/tips': {},
    '../components/InfoTip': { InfoTip: () => null },
    './requestDeadline': {},
  };
  const exp = evalModule('src/renderer/views/Settings.tsx', '\nmodule.exports.__ModelsSection = ModelsSection;', (id) => (id in stubs ? stubs[id] : require(id)));
  return renderToStaticMarkup(React.createElement(exp.__ModelsSection));
}

const LOADING = '<p role="status" class="text-sm text-textMuted">loading</p>';
const EMPTY = '<p class="text-sm text-textMuted">models_available</p>';
const ALERT = '<p role="alert" class="text-sm text-error">models_error <button type="button" class="text-nvidia">retry</button></p>';
const pendingQ = { data: undefined, isPending: true, isError: false, refetch() {} };
const errorQ = { data: undefined, isPending: false, isError: true, refetch() {} };
const model = { id: 'a/b', name: 'A B', enabled: true, mode: 'auto', deprecated: false };

test('Settings models: first-visit pending shows the loading line, not the empty text', () => {
  const html = renderModelsSection({ query: pendingQ });
  assert.ok(html.includes(LOADING));
  assert.ok(!html.includes('models_available'));
  assert.ok(!html.includes('models_error'));
  // Store already filled: the list, no loading line.
  const filled = renderModelsSection({ query: pendingQ, models: [model] });
  assert.ok(!filled.includes(LOADING) && filled.includes('A B'));
});

test('Settings models: query error with no models shows the alert + retry, not the empty text', () => {
  const html = renderModelsSection({ query: errorQ });
  assert.ok(html.includes(ALERT), html);
  assert.ok(!html.includes('models_available'));
  assert.ok(!html.includes(LOADING));
  assert.ok(!renderModelsSection({ query: errorQ, models: [model] }).includes('models_error'), 'no alert over a known list');
  const src = read('src/renderer/views/Settings.tsx');
  assert.match(src, /\{modelsQuery\.isError && !error && !loading && models\.length === 0 && \(\s*<p role="alert" className="text-sm text-error">\{t\('models_error'\)\} <button type="button" onClick=\{\(\) => void modelsQuery\.refetch\(\)\} className="text-nvidia">\{t\('retry'\)\}<\/button><\/p>\s*\)\}/);
});

test('Settings models: a query error never stacks with loading or the store alert (exactly one message)', () => {
  const messages = (html) => (html.match(/<p role="(?:alert|status)"/g) || []).length + (html.includes(EMPTY) ? 1 : 0);
  // (a) Refresh clicked after a failed query: loading only.
  const a = renderModelsSection({ query: errorQ, loading: true });
  assert.equal(messages(a), 1, a);
  assert.ok(a.includes(LOADING) && !a.includes('models_error'), 'loading only');
  // (b) the query and the Refresh both failed: the store alert only.
  const b = renderModelsSection({ query: errorQ, error: 'boom' });
  assert.equal(messages(b), 1, b);
  assert.ok(b.includes('<p role="alert" class="text-sm text-error">boom</p>') && !b.includes('models_error'), 'store alert only');
});

test('Settings models: state table — exactly one message, by priority store error > loading/pending > query error > empty', () => {
  const STORE_ALERT = '<p role="alert" class="text-sm text-error">boom</p>';
  const MESSAGES = { store: STORE_ALERT, loading: LOADING, query: ALERT, empty: EMPTY };
  const count = (html) => Object.values(MESSAGES).filter((m) => html.includes(m)).length
    + ((html.match(/<p role="(?:alert|status)"/g) || []).length - [STORE_ALERT, LOADING, ALERT].filter((m) => html.includes(m)).length);
  let combos = 0;
  for (const storeError of [false, true]) for (const loading of [false, true])
  for (const q of ['pending', 'error', 'success']) for (const modelsEmpty of [true, false]) {
    // Query pending and query error together can't happen (TanStack status is one of them).
    const query = q === 'pending' ? pendingQ : q === 'error' ? errorQ : ok({ models: [] });
    const html = renderModelsSection({ query, loading, error: storeError ? 'boom' : null, models: modelsEmpty ? [] : [model] });
    const expected = storeError ? 'store'
      : loading || (q === 'pending' && modelsEmpty) ? 'loading'
      : q === 'error' && modelsEmpty ? 'query'
      : modelsEmpty ? 'empty' : null;
    const label = JSON.stringify({ storeError, loading, q, modelsEmpty });
    if (expected) {
      assert.equal(count(html), 1, `${label}: exactly one message\n${html}`);
      assert.ok(html.includes(MESSAGES[expected]), `${label}: ${expected}`);
    } else {
      assert.equal(count(html), 0, `${label}: no message over a known list\n${html}`);
    }
    if (!modelsEmpty) assert.ok(html.includes('A B'), `${label}: known list stays visible`);
    combos += 1;
  }
  assert.equal(combos, 24);
});

test('Settings models: the empty text renders only for a genuinely empty fetched list', () => {
  const html = renderModelsSection({ query: ok({ models: [] }) });
  assert.ok(html.includes(EMPTY));
  assert.ok(!html.includes(LOADING) && !html.includes('models_error'));
  assert.ok(!renderModelsSection({ query: ok({ models: [] }), loading: true }).includes(EMPTY), 'not while the store is loading');
  assert.ok(!renderModelsSection({ query: ok({ models: [] }), error: 'x' }).includes(EMPTY), 'not with a store error');
  assert.ok(!renderModelsSection({ query: ok({ models: [] }), models: [model] }).includes(EMPTY), 'not with models');
});
