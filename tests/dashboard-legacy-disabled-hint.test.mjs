import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import typescript from 'typescript';

// Owner decision 2a: keys carrying `legacyDisabled` (permanently disabled by an
// OLD version after an auth failure, indistinguishable from an admin disable)
// get an informational hint + a summary banner. No auto-revive, no new action.
//
// Harness: Dashboard.tsx is transpiled (react-jsx) and rendered for real with
// react-dom/server. Only its data/i18n/lifecycle dependencies are stubbed;
// React and lucide-react are the real modules. No jsdom -> static markup only.

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

function renderDashboard(keys) {
  const mutation = { mutate() {}, isPending: false };
  const stubs = {
    '@tanstack/react-query': {
      useQuery: () => ({ data: { keys }, isPending: false, isError: false, error: null, refetch() {} }),
      useMutation: () => mutation,
      useQueryClient: () => ({})
    },
    'react-i18next': { useTranslation: () => ({ t: (k, o) => (o && 'count' in o ? `${k}|${o.count}` : k) }) },
    '../lib/api': { api: {}, queryKeys: { keys: ['keys'] } },
    '../lib/frontend-state': { classifyDataState: () => 'success', isPlausibleNvidiaKey: () => true, moveItem: (a) => a, safeError: (_e, f) => f },
    '../lib/frontend-behavior': { createDashboardKeysQueryPolicy: () => ({}) },
    '../lib/gateway-lifecycle': { useGatewayLifecycle: () => ({ status: { state: 'running' } }) },
    // Wave 6B pet-advisor focus flow (not under test here).
    'react-router-dom': { useLocation: () => ({ pathname: '/dashboard', state: null }), useNavigate: () => () => {} },
    '../pet/tips': { focusPendingSetting: () => 'heading', focusSettingFrom: () => null }
  };
  const module = { exports: {} };
  const localRequire = (id) => (id in stubs ? stubs[id] : require(id));
  vm.runInNewContext(transpile('src/renderer/views/Dashboard.tsx'), { module, exports: module.exports, require: localRequire, console }, { filename: 'Dashboard.tsx' });
  return renderToStaticMarkup(React.createElement(module.exports.Dashboard));
}

const usage = { success: 0, fail: 0, tokens: 0, lastUsed: 0 };
const legacyKey = (id) => ({ id, key: `nvapi-****${id}`, status: 'disabled', backoffUntil: 0, usage, legacyDisabled: true });
const adminKey = { id: 'k2', key: 'nvapi-****k2', status: 'disabled', backoffUntil: 0, usage, disabledBy: 'admin' };
const activeKey = { id: 'k3', key: 'nvapi-****k3', status: 'active', backoffUntil: 0, usage };
const article = (html, masked) => html.split('<article').find((chunk) => chunk.includes(masked)) ?? '';

test('(a) hint renders only on the legacy key; its Enable button is described by the hint', () => {
  const html = renderDashboard([legacyKey('k1'), adminKey]);
  const legacy = article(html, 'nvapi-****k1');
  const admin = article(html, 'nvapi-****k2');

  assert.match(legacy, /<p id="legacy-hint-k1" class="mt-2 flex items-start gap-1\.5 text-xs text-textMuted"><svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>key_legacy_disabled<\/p>/);
  assert.doesNotMatch(admin, /legacy-hint|key_legacy_disabled/, 'a normal (admin) disabled key gets no hint');
  assert.equal(html.match(/key_legacy_disabled/g)?.length, 1);

  const described = [...html.matchAll(/<button[^>]*aria-describedby="([^"]+)"[^>]*>/g)];
  assert.equal(described.length, 1, 'only the legacy key\'s Enable button carries aria-describedby');
  assert.match(described[0][0], /aria-label="enable"/);
  assert.ok(legacy.includes(described[0][0]), 'the described button lives in the legacy key row');
  assert.ok(html.includes(`id="${described[0][1]}"`), 'aria-describedby must point to an element that exists');
});

test('(b) summary banner shows the legacy count, is absent at 0, and is not role="alert"', () => {
  const banner = /<div([^>]*)><svg[\s\S]*?<\/svg>keys_legacy_summary\|(\d+)<\/div>/;
  const one = renderDashboard([legacyKey('k1'), adminKey, activeKey]).match(banner);
  assert.ok(one, 'banner renders with one legacy key');
  assert.equal(one[2], '1');
  assert.match(one[1], /class="border border-warning\/60 p-3 mb-3 text-sm text-textMuted flex items-center gap-2"/);
  assert.doesNotMatch(one[1], /role=|aria-live/);

  assert.equal(renderDashboard([legacyKey('k1'), legacyKey('k4'), adminKey]).match(banner)?.[2], '2');
  assert.doesNotMatch(renderDashboard([adminKey, activeKey]), /keys_legacy_summary/, 'no banner when there are 0 legacy keys');
});

test('(c) all 7 locales define both keys, non-empty; the summary keeps {{count}}', () => {
  const module = { exports: {} };
  vm.runInNewContext(transpile('src/renderer/i18n/resources.ts'), { module, exports: module.exports }, { filename: 'resources.ts' });
  for (const locale of ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar']) {
    const bundle = module.exports[locale];
    assert.ok(bundle, `${locale} bundle exists`);
    for (const key of ['key_legacy_disabled', 'keys_legacy_summary']) {
      assert.equal(typeof bundle[key], 'string', `${locale}.${key} must exist`);
      assert.ok(bundle[key].trim().length > 0, `${locale}.${key} must not be empty`);
    }
    assert.match(bundle.keys_legacy_summary, /\{\{count\}\}/, `${locale}.keys_legacy_summary must interpolate {{count}}`);
  }
});
