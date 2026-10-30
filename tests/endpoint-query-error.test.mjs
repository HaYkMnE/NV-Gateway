import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import typescript from 'typescript';

// CodeRabbit #6: Endpoint.tsx showed t('loading') forever when the keys/models
// query FAILED, because an errored query and a pending one both have no data.
// The HUD must tell the truth: pending -> loading, error w/o data -> *_error,
// data present -> the data (even if a later refetch errored).
//
// Harness mirrors dashboard-legacy-disabled-hint.test.mjs: Endpoint.tsx is
// transpiled (react-jsx) and rendered with react-dom/server; only its
// data/i18n/lifecycle/store dependencies are stubbed.

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

const pending = { data: undefined, isPending: true, isError: false, error: null, refetch() {} };
const failed = { data: undefined, isPending: false, isError: true, error: new Error('boom'), refetch() {} };
const ok = (data) => ({ data, isPending: false, isError: false, error: null, refetch() {} });
const creds = ok({ port: 12000, gatewayToken: 'tok' });

function renderEndpoint({ keys, models }) {
  const byKey = { keys, models, 'gateway-credentials': creds };
  const stubs = {
    '@tanstack/react-query': { useQuery: ({ queryKey }) => byKey[queryKey[0]] },
    'react-i18next': { useTranslation: () => ({ t: (k, o) => (o && 'count' in o ? `${k}|${o.count}` : k) }) },
    '../lib/api': { api: {}, queryKeys: { keys: ['keys'], models: ['models'] } },
    '../lib/frontend-state': { safeError: (_e, f) => f, knownCount: (d) => (d == null ? null : d.length) },
    '../lib/gateway-lifecycle': { useGatewayLifecycle: () => ({ status: { state: 'running' } }) },
    '../stores/config': { useConfigStore: () => ({ gatewayPort: 12000 }) },
    '../components/ProviderGlyph': { ProviderGlyph: () => null, resolveProvider: () => ({ tagBg: '#000', color: '#fff' }) },
    // CR7-003: the real (pure) OpenCode config builder, not a stub.
    './opencodeConfig': (() => { const m = { exports: {} }; vm.runInNewContext(transpile('src/renderer/views/opencodeConfig.ts'), { module: m, exports: m.exports }); return m.exports; })(),
    // The real (pure) per-client config generators.
    './clientConfigs': (() => { const m = { exports: {} }; vm.runInNewContext(transpile('src/renderer/views/clientConfigs.ts'), { module: m, exports: m.exports }); return m.exports; })(),
    'react-router-dom': { useLocation: () => ({ pathname: '/', state: null }), useNavigate: () => () => {} },
    '../pet/tips': { focusPendingSetting: () => 'heading', focusSettingFrom: () => null },
  };
  const module = { exports: {} };
  const localRequire = (id) => (id in stubs ? stubs[id] : require(id));
  vm.runInNewContext(transpile('src/renderer/views/Endpoint.tsx'), { module, exports: module.exports, require: localRequire, console, window: {} }, { filename: 'Endpoint.tsx' });
  return renderToStaticMarkup(React.createElement(module.exports.Endpoint));
}

const COUNT_CELL = '<div class="font-mono text-base font-bold text-textMain">';
const MODELS_HEADING = '<h3 class="text-sm font-bold text-textMain tracking-tight">';
const MODELS_BOX = '<div role="status" class="bg-surface/60 border border-border/80 p-6 rounded-xl text-center text-textMuted text-sm"><p>';
const model = { id: 'meta/llama', enabled: true };

// Designer spec: in the narrow HUD cards an error is a compact marker (icon +
// em dash) that does not wrap; the full sentence stays for AT (sr-only) and on
// hover (title). The icon and the dash are aria-hidden.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const errorMarker = (key) => new RegExp(
  escapeRe(`${COUNT_CELL}<span class="inline-flex items-center gap-1.5" title="${key}">`) +
  '<svg(?=[^>]*aria-hidden="true")(?=[^>]*class="[^"]*\\bshrink-0 text-error\\b[^"]*")[^>]*>[\\s\\S]*?</svg>' +
  escapeRe(`<span aria-hidden="true" class="text-textMuted">—</span><span class="sr-only">${key}</span></span></div>`)
);

test('(a) keys query errored with no data -> compact error marker in the keys card, no loading', () => {
  const html = renderEndpoint({ keys: failed, models: ok({ models: [model] }) });
  assert.match(html, errorMarker('keys_error'), 'keys card: title + aria-hidden icon + aria-hidden dash + sr-only sentence');
  assert.ok(!html.includes(`${COUNT_CELL}keys_error</div>`), 'the full sentence no longer renders as visible card text');
  assert.doesNotMatch(html, /role="alert"/);
  assert.doesNotMatch(html, /loading/);
});

test('(b) models query errored with no data -> marker in the card, full sentence at :397/:402', () => {
  const html = renderEndpoint({ keys: ok({ keys: [{}, {}] }), models: failed });
  assert.match(html, errorMarker('models_error'), 'models card: title + aria-hidden icon + aria-hidden dash + sr-only sentence');
  assert.ok(!html.includes(`${COUNT_CELL}models_error</div>`));
  assert.doesNotMatch(html, /role="alert"/);
  assert.ok(html.includes(`${MODELS_HEADING}models_error</h3>`));
  assert.ok(html.includes(`${MODELS_BOX}models_error</p></div>`));
  assert.doesNotMatch(html, /loading/);
});

test('(c) pending -> loading, unchanged', () => {
  const html = renderEndpoint({ keys: pending, models: pending });
  assert.ok(html.includes(`${COUNT_CELL}loading</div>`));
  assert.ok(html.includes(`${MODELS_HEADING}loading</h3>`));
  assert.ok(html.includes(`${MODELS_BOX}loading</p></div>`));
  assert.doesNotMatch(html, /keys_error|models_error/);
});

test('(e) a null model list is UNKNOWN like a null key list (knownCount), never 0', () => {
  // Pending-style: null list, no error -> the same loading label the keys card uses.
  const html = renderEndpoint({ keys: ok({ keys: null }), models: ok({ models: null }) });
  assert.ok(html.includes(`${COUNT_CELL}loading</div>`), 'keys card: null list -> loading');
  assert.ok(!html.includes(`${COUNT_CELL}0</div>`), 'models card must not print a fabricated 0');
  assert.ok(html.includes(`${MODELS_HEADING}loading</h3>`), 'models heading: null list -> loading, not "0 enabled"');
  assert.doesNotMatch(html, /endpoint_enabled_models\|0/);

  // Errored with a null list -> the existing compact error marker, same as keys.
  const failedNull = { ...ok({ models: null }), isError: true, error: new Error('boom') };
  const errHtml = renderEndpoint({ keys: ok({ keys: [{}] }), models: failedNull });
  assert.match(errHtml, errorMarker('models_error'));
});

test('(d) data present (even with a later error) -> the counts, unchanged', () => {
  const erroredRefetch = (data) => ({ ...ok(data), isError: true, error: new Error('later') });
  const html = renderEndpoint({ keys: erroredRefetch({ keys: [{}, {}, {}] }), models: erroredRefetch({ models: [model, { id: 'x/off', enabled: false }] }) });
  assert.ok(html.includes(`${COUNT_CELL}3 keys_short</div>`));
  assert.ok(html.includes(`${COUNT_CELL}1</div>`));
  assert.ok(html.includes(`${MODELS_HEADING}endpoint_enabled_models|1</h3>`));
  assert.doesNotMatch(html, /loading|keys_error|models_error/);
});
