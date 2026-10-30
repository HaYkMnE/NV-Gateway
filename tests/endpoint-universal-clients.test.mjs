// Endpoint "Works with any app" block + per-client configs (owner, 30.09:
// "Not only OpenCode. Any place, any program"). Art-director decisions:
// universal block first in Section 2, chips in three labeled groups, file
// clients show the target path, app-settings clients show steps, CloudCode and
// the old Anthropic tab are gone, Codex sits behind CODEX_SUPPORTED.
// Harness mirrors endpoint-hint-settings-models-states.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import typescript from 'typescript';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function transpile(relative) {
  return typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, jsx: typescript.JsxEmit.ReactJSX, esModuleInterop: true }
  }).outputText;
}
function evalModule(relative, requireFn = require) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(relative), { module, exports: module.exports, require: requireFn, console, window: {} }, { filename: relative });
  return module.exports;
}
// vm-realm values -> this realm, so deepEqual compares data, not prototypes.
const plain = (x) => JSON.parse(JSON.stringify(x));

const cc = evalModule('src/renderer/views/clientConfigs.ts');
const resources = evalModule('src/renderer/i18n/resources.ts');
const LOCALES = ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar'];
const interpolate = (text, o = {}) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in o ? String(o[k]) : m));
const tEn = (k, o) => (k in resources.en ? interpolate(resources.en[k], o) : k);

const URLS = cc.endpointUrls(12000);
const OPENAI = 'http://127.0.0.1:12000/v1';
const ANTHROPIC = 'http://127.0.0.1:12000';
const ctx = (o = {}) => ({ openaiBaseUrl: URLS.openai, anthropicBaseUrl: URLS.anthropic, token: 'tok', modelId: 'meta/llama', contextLength: 131072, ...o });

// ── generators ──────────────────────────────────────────────────────────────
test('endpointUrls: OpenAI base has /v1, Anthropic base has none (clients append /v1/messages)', () => {
  assert.equal(URLS.openai, OPENAI);
  assert.equal(URLS.anthropic, ANTHROPIC);
  assert.doesNotMatch(URLS.anthropic, /\/v1/);
});

test('Claude Code: settings.json env block + PowerShell setx alternative', () => {
  const c = cc.buildClientSnippets(ctx())['claude-code'];
  assert.deepEqual(JSON.parse(c.content), { env: { ANTHROPIC_BASE_URL: ANTHROPIC, ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'meta/llama' } });
  assert.equal(c.file, '%USERPROFILE%\\.claude\\settings.json');
  assert.equal(c.extra.content, [`setx ANTHROPIC_BASE_URL '${ANTHROPIC}'`, "setx ANTHROPIC_AUTH_TOKEN 'tok'", "setx ANTHROPIC_MODEL 'meta/llama'"].join('\n'));
});

test('Continue / Hermes / LibreChat: YAML parses to the documented shape', () => {
  const s = cc.buildClientSnippets(ctx());
  assert.deepEqual(yaml.load(s.continue.content), { name: 'NV-Gateway', version: '1.0.0', schema: 'v1', models: [{ name: 'NV-Gateway', provider: 'openai', model: 'meta/llama', apiBase: OPENAI, apiKey: 'tok' }] });
  assert.equal(s.continue.file, '%USERPROFILE%\\.continue\\config.yaml');
  assert.deepEqual(yaml.load(s.hermes.content), { model: { provider: 'custom', base_url: OPENAI, api_key: 'tok', default: 'meta/llama' } });
  assert.equal(s.hermes.file, '~/.hermes/config.yaml');
  assert.deepEqual(yaml.load(s.librechat.content), { endpoints: { custom: [{ name: 'NV-Gateway', apiKey: 'tok', baseURL: OPENAI, models: { default: ['meta/llama'], fetch: true } }] } });
  assert.equal(s.librechat.file, 'librechat.yaml');
});

test('Continue: the required top-level name / version / schema (docs.continue.dev/reference) come first', () => {
  const text = cc.buildClientSnippets(ctx()).continue.content;
  assert.ok(text.startsWith('name: NV-Gateway\nversion: 1.0.0\nschema: v1\nmodels:\n'), text);
  const doc = yaml.load(text);
  assert.equal(doc.name, 'NV-Gateway');
  assert.equal(doc.version, '1.0.0');
  assert.equal(doc.schema, 'v1');
  const m = doc.models[0];
  assert.deepEqual([m.provider, m.model, m.apiBase, m.apiKey], ['openai', 'meta/llama', OPENAI, 'tok']);
});

test('Zed: openai_compatible provider, the key never in the file, env NV_GATEWAY_API_KEY', () => {
  const z = cc.buildClientSnippets(ctx()).zed;
  assert.deepEqual(JSON.parse(z.content), { language_models: { openai_compatible: { 'NV-Gateway': { api_url: OPENAI, available_models: [{ name: 'meta/llama', max_tokens: 131072 }] } } } });
  // Quoted: the bare 'tok' is a substring of the "max_tokens" key.
  assert.ok(!z.content.includes('"tok"'), 'no token in settings.json');
  assert.ok(!cc.buildClientSnippets(ctx({ token: 'SECRET-XYZ' })).zed.content.includes('SECRET-XYZ'), 'no token in settings.json (distinct value)');
  assert.equal(z.extra.content, "setx NV_GATEWAY_API_KEY 'tok'");
  const noCtx = JSON.parse(cc.buildClientSnippets(ctx({ contextLength: undefined })).zed.content);
  assert.equal(noCtx.language_models.openai_compatible['NV-Gateway'].available_models[0].max_tokens, cc.ZED_DEFAULT_MAX_TOKENS);
});

test('Codex: config.toml provider block (responses wire API) + setx NV_GATEWAY_TOKEN', () => {
  const c = cc.buildClientSnippets(ctx()).codex;
  assert.equal(c.content, [
    'model = "meta/llama"',
    'model_provider = "nv-gateway"',
    '',
    '[model_providers.nv-gateway]',
    'name = "NV-Gateway"',
    `base_url = "${OPENAI}"`,
    'env_key = "NV_GATEWAY_TOKEN"',
    'wire_api = "responses"',
  ].join('\n'));
  assert.equal(c.file, '%USERPROFILE%\\.codex\\config.toml');
  assert.equal(c.extra.content, "setx NV_GATEWAY_TOKEN 'tok'");
});

test('Aider / OpenAI Python / OpenAI JS / curl: exact snippets', () => {
  const s = cc.buildClientSnippets(ctx());
  assert.equal(s.aider.content, `$env:OPENAI_API_BASE = '${OPENAI}'\n$env:OPENAI_API_KEY = 'tok'\naider --model 'openai/meta/llama'`);
  assert.equal(s['openai-python'].content, [
    'from openai import OpenAI', '', 'client = OpenAI(', `    base_url="${OPENAI}",`, '    api_key="tok"', ')', '',
    'response = client.chat.completions.create(', '    model="meta/llama",', '    messages=[{"role": "user", "content": "Hello!"}]', ')',
    'print(response.choices[0].message.content)',
  ].join('\n'), 'the Python snippet is unchanged');
  assert.equal(s['openai-js'].content, [
    "import OpenAI from 'openai';", '', 'const client = new OpenAI({', `  baseURL: "${OPENAI}",`, '  apiKey: "tok",', '});', '',
    'const response = await client.chat.completions.create({', '  model: "meta/llama",', "  messages: [{ role: 'user', content: 'Hello!' }],", '});',
    'console.log(response.choices[0].message.content);',
  ].join('\n'));
  assert.equal(s.curl.content, [
    "$body = @'", '{"model":"meta/llama","messages":[{"role":"user","content":"Hello!"}]}', "'@",
    `$body | curl.exe -s '${OPENAI}/chat/completions' -H 'Content-Type: application/json' -H 'Authorization: Bearer tok' --data-binary '@-'`,
  ].join('\n'));
});

test('the selected model id feeds every single-model snippet', () => {
  const s = cc.buildClientSnippets(ctx({ modelId: 'x/second' }));
  for (const [id, v] of Object.entries(s)) {
    const text = v.content + (v.extra ? v.extra.content : '');
    assert.ok(text.includes('x/second'), `${id}: selected model`);
    assert.ok(!text.includes('meta/llama'), `${id}: no stale model`);
  }
});

test('escaping: a token / model id with quotes, a backslash and a colon survive every syntax', () => {
  const token = 'a"b\\c:d\'e';
  const model = 'm"o\\d:e\'l';
  const s = cc.buildClientSnippets(ctx({ token, modelId: model }));
  assert.deepEqual(JSON.parse(s['claude-code'].content).env, { ANTHROPIC_BASE_URL: ANTHROPIC, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: model });
  assert.equal(JSON.parse(s.zed.content).language_models.openai_compatible['NV-Gateway'].available_models[0].name, model);
  const cont = yaml.load(s.continue.content).models[0];
  assert.equal(cont.apiKey, token); assert.equal(cont.model, model);
  const herm = yaml.load(s.hermes.content).model;
  assert.equal(herm.api_key, token); assert.equal(herm.default, model);
  const lib = yaml.load(s.librechat.content).endpoints.custom[0];
  assert.equal(lib.apiKey, token); assert.deepEqual(lib.models.default, [model]);
  assert.ok(s.codex.content.startsWith(String.raw`model = "m\"o\\d:e'l"` + '\n'), 'TOML basic string escapes " and \\');
  assert.ok(s['claude-code'].extra.content.includes(String.raw`setx ANTHROPIC_AUTH_TOKEN 'a"b\c:d''e'`), "PowerShell literal doubles '");
  assert.ok(s.aider.content.includes(String.raw`$env:OPENAI_API_KEY = 'a"b\c:d''e'`));
  assert.ok(s['openai-python'].content.includes(String.raw`api_key="a\"b\\c:d'e"`));
  assert.ok(s['openai-js'].content.includes(String.raw`apiKey: "a\"b\\c:d'e",`));
  assert.equal(JSON.parse(s.curl.content.split('\n')[1]).model, model);
});

test('groups: three rows in the given order; Codex last in "Config file", hidden when CODEX_SUPPORTED=false', () => {
  assert.equal(cc.CODEX_SUPPORTED, true);
  const on = plain(cc.clientGroups(true));
  assert.deepEqual(on, [
    { id: 'file', labelKey: 'endpoint_group_file', clients: ['opencode', 'claude-code', 'continue', 'hermes', 'zed', 'librechat', 'codex'] },
    { id: 'env', labelKey: 'endpoint_group_env', clients: ['aider', 'openai-python', 'openai-js', 'curl'] },
    { id: 'ui', labelKey: 'endpoint_group_ui', clients: ['cline', 'roo', 'kilo', 'cursor', 'copilot', 'openwebui'] },
  ]);
  const off = plain(cc.clientGroups(false));
  assert.ok(off.every((g) => !g.clients.includes('codex')), 'no Codex chip');
  assert.deepEqual(off[0].clients, on[0].clients.slice(0, -1));
});

// ── rendering ───────────────────────────────────────────────────────────────
const ok = (data) => ({ data, isPending: false, isError: false, error: null, refetch() {} });
const TWO = [{ id: 'meta/llama', enabled: true }, { id: 'x/off', enabled: false }, { id: 'x/second', enabled: true }];

function renderEndpoint({ tab, model, models = TWO, copied } = {}) {
  const byKey = { keys: ok({ keys: [{}] }), models: ok({ models }), 'gateway-credentials': ok({ port: 12000, gatewayToken: 'tok' }) };
  // Override only the config-tab state (initial 'opencode'), the selected-model state (initial
  // undefined) and, with `copied`, the FIRST null state = copiedField (copyError is the second null).
  let nulls = 0;
  const pick = (init) => {
    if (init === null && nulls++ === 0 && copied) return copied;
    return init === 'opencode' && tab ? tab : init === undefined && model ? model : init;
  };
  const stubs = {
    react: { ...React, useState: (init) => React.useState(pick(init)) },
    '@tanstack/react-query': { useQuery: ({ queryKey }) => byKey[queryKey[0]] },
    'react-i18next': { useTranslation: () => ({ t: tEn }) },
    '../lib/api': { api: {}, queryKeys: { keys: ['keys'], models: ['models'] } },
    '../lib/frontend-state': { safeError: (_e, f) => f, knownCount: (d) => (d == null ? null : d.length) },
    '../lib/gateway-lifecycle': { useGatewayLifecycle: () => ({ status: { state: 'running' } }) },
    '../stores/config': { useConfigStore: () => ({ gatewayPort: 12000 }) },
    '../components/ProviderGlyph': { ProviderGlyph: () => null, resolveProvider: () => ({ tagBg: '#000', color: '#fff' }) },
    './opencodeConfig': evalModule('src/renderer/views/opencodeConfig.ts'),
    './clientConfigs': cc,
    'react-router-dom': { useLocation: () => ({ pathname: '/', state: null }), useNavigate: () => () => {} },
    '../pet/tips': { focusPendingSetting: () => 'heading', focusSettingFrom: () => null },
  };
  const exp = evalModule('src/renderer/views/Endpoint.tsx', (id) => (id in stubs ? stubs[id] : require(id)));
  return renderToStaticMarkup(React.createElement(exp.Endpoint));
}

const COPY_BTN = 'px-3.5 py-2 border border-border hover:border-accent-neon/60 bg-surface hover:bg-bg text-accent-neon text-xs font-medium rounded-lg flex items-center gap-1.5 shrink-0 transition-all cursor-pointer animate-tactile-tick';

test('the universal block renders first in Section 2, before the client toggle, with 4 copyable rows', () => {
  const html = renderEndpoint();
  const u = html.indexOf('Works with any app');
  const toggle = html.indexOf('>Configuration</span>');
  assert.ok(u > html.indexOf('Local Routing') && u < toggle, 'after the HUD, before the collapsible clients');
  const block = html.slice(u, toggle);
  for (const s of ['Base URL (OpenAI-compatible)', `>${OPENAI}</code>`, 'Base URL (Anthropic, no /v1)', `>${ANTHROPIC}</code>`, 'Gateway Token', 'type="password"', 'Model ID', '<select'])
    assert.ok(block.includes(s), `universal block has ${s}`);
  assert.equal(block.split(`class="${COPY_BTN}"`).length - 1, 4, 'one copy button per row');
  assert.ok(block.includes('<option value="meta/llama" selected="">meta/llama</option>'), 'defaults to the first enabled model');
  assert.ok(!block.includes('x/off'), 'disabled models are not offered');
  assert.ok(!html.slice(0, u).includes('type="password"'), 'the token row moved out of the HUD');
});

test('the model select feeds the rendered snippet', () => {
  const claude = renderEndpoint({ tab: 'claude-code', model: 'x/second' });
  assert.ok(claude.includes('<option value="x/second" selected="">'));
  assert.ok(claude.includes('&quot;ANTHROPIC_MODEL&quot;: &quot;x/second&quot;'));
  assert.ok(claude.includes('%USERPROFILE%\\.claude\\settings.json'), 'file clients show the target path');
  assert.ok(renderEndpoint({ tab: 'aider', model: 'x/second' }).includes('openai/x/second'));
});

test('chips: three labeled groups in the given order', () => {
  const html = renderEndpoint();
  const groups = ['file', 'env', 'ui'].map((id) => {
    const at = html.indexOf(`data-client-group="${id}"`);
    assert.ok(at > 0, `${id} group rendered`);
    return at;
  });
  const chips = (from, to) => [...html.slice(from, to).matchAll(/<button type="button" aria-pressed="(?:true|false)"[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);
  const end = html.indexOf('configuration</span>', groups[2]);
  assert.deepEqual(chips(groups[0], groups[1]), ['OpenCode', 'Claude Code', 'Continue', 'Hermes', 'Zed', 'LibreChat', 'Codex']);
  assert.deepEqual(chips(groups[1], groups[2]), ['Aider', 'OpenAI Python', 'OpenAI JS', 'curl']);
  assert.deepEqual(chips(groups[2], end), ['Cline', 'Roo', 'Kilo', 'Cursor', 'Copilot BYOK', 'Open WebUI']);
  for (const label of ['Config file', 'Env vars &amp; code', 'App settings']) assert.ok(html.includes(label), label);
});

test('app-settings clients render steps: menu path first, then copyable values; the token stays masked', () => {
  const html = renderEndpoint({ tab: 'cline' });
  const at = html.indexOf('<ol class="grid gap-2 text-xs text-textMain">');
  assert.ok(at > 0);
  const ol = html.slice(at, html.indexOf('</ol>', at));
  assert.ok(ol.indexOf(resources.en.endpoint_steps_cline.replace(/"/g, '&quot;')) < ol.indexOf(OPENAI), 'menu path first');
  assert.ok(ol.includes('Model ID') && ol.includes('meta/llama'));
  assert.ok(!ol.includes('>tok<'), 'token masked until the eye toggle');
  assert.ok(!html.includes('<pre dir="ltr"'), 'no snippet for UI-only clients');
});

test('every copy button has its own accessible name ("Copy <row label | client>"), none shared, none bare', () => {
  const COPY = resources.en.copy;
  // Copy buttons are the ones with the tactile tick (chips and the eye toggle have none).
  const expected = { opencode: 7, 'claude-code': 8, cline: 9 }; // 4 universal + snippet/extra/steps + 2 model rows
  for (const [tab, count] of Object.entries(expected)) {
    const html = renderEndpoint({ tab });
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).filter((b) => b.includes('animate-tactile-tick'));
    assert.equal(buttons.length, count, `${tab}: copy buttons found`);
    const labels = buttons.map((b) => (/aria-label="([^"]*)"/.exec(b) || [])[1]);
    assert.ok(labels.every((l) => typeof l === 'string' && l.startsWith(`${COPY} `)), `${tab}: every copy button is labelled: ${labels}`);
    assert.ok(!labels.includes(COPY), `${tab}: no bare "${COPY}"`);
    assert.equal(new Set(labels).size, labels.length, `${tab}: duplicate aria-label in ${labels}`);
  }
  const labelsOf = (tab) => [...renderEndpoint({ tab }).matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(labelsOf('opencode').includes(`${COPY} ${resources.en.endpoint_base_url_anthropic}`), 'row label');
  assert.ok(labelsOf('claude-code').includes(`${COPY} Claude Code`), 'whole-snippet copy names the client');
  assert.ok(labelsOf('cline').includes(`${COPY} Cline: ${resources.en.endpoint_model_id}`), 'step copy names client + row');
});

// RTL: a run of Latin menu names renders LTR even in Arabic, so the chain is
// wrapped in <bdi dir="ltr"> and always uses →; ← would point back to the start.
const STEP_KEYS = ['cline', 'roo', 'kilo', 'cursor', 'copilot', 'openwebui'].map((c) => `endpoint_steps_${c}`);
test('menu chains: no ← in any endpoint_steps_* value, in any locale', () => {
  for (const loc of LOCALES) for (const k of STEP_KEYS) assert.ok(!resources[loc][k].includes('←'), `${loc}.${k}`);
});

test('splitMenuChains isolates Latin → chains; in ar every → sits inside a chain (no Arabic mid-chain)', () => {
  assert.deepEqual(plain(cc.splitMenuChains('Cline → Settings → API Provider: OpenAI Compatible. Then go.')), [
    { text: 'Cline → Settings → API Provider', chain: true },
    { text: ': OpenAI Compatible. Then go.', chain: false },
  ]);
  assert.deepEqual(plain(cc.splitMenuChains('افتح Chat، ثم: Manage Language Models → Add Models. تم')), [
    { text: 'افتح Chat، ثم: ', chain: false },
    { text: 'Manage Language Models → Add Models', chain: true },
    { text: '. تم', chain: false },
  ]);
  for (const k of STEP_KEYS) {
    const parts = cc.splitMenuChains(resources.ar[k]);
    assert.ok(parts.some((p) => p.chain), `ar.${k}: has a menu chain`);
    assert.ok(parts.filter((p) => !p.chain).every((p) => !p.text.includes('→')), `ar.${k}: no → outside a chain: ${resources.ar[k]}`);
    assert.equal(parts.map((p) => p.text).join(''), resources.ar[k], `ar.${k}: lossless`);
  }
});

test('the steps <ol> renders the menu path inside <bdi dir="ltr">', () => {
  const html = renderEndpoint({ tab: 'cline' });
  const at = html.indexOf('<ol class="grid gap-2 text-xs text-textMain">');
  const ol = html.slice(at, html.indexOf('</ol>', at));
  assert.ok(ol.startsWith('<ol class="grid gap-2 text-xs text-textMain"><li><bdi dir="ltr">Cline → Settings → API Provider</bdi>: OpenAI Compatible.'), ol.slice(0, 160));
  const wui = renderEndpoint({ tab: 'openwebui' });
  assert.ok(wui.includes('<bdi dir="ltr">Open WebUI → Settings → Admin → Connections → Manage OpenAI API Connections → Add Connection</bdi>'));
});

// The gateway listens on 127.0.0.1 only (server.mjs:3515): the Docker note warns
// rather than promising a host.docker.internal route that was not verified.
// WCAG 2.5.3 (label in name): the accessible name follows the visible Copy/Copied text.
test('after a copy on key k only that button is named "Copied …"; the others stay "Copy …"', () => {
  const COPY = resources.en.copy;
  const COPIED = resources.en.copied;
  const cases = [
    ['opencode', 'url', `${COPIED} ${resources.en.endpoint_base_url_openai}`],
    ['opencode', 'url-anthropic', `${COPIED} ${resources.en.endpoint_base_url_anthropic}`],
    ['opencode', 'token', `${COPIED} ${resources.en.endpoint_gateway_token}`],
    ['opencode', 'model-id', `${COPIED} ${resources.en.endpoint_model_id}`],
    ['opencode', 'config-opencode', `${COPIED} OpenCode`],
    ['opencode', 'model-meta/llama', `${COPIED} meta/llama`],
    ['claude-code', 'config-claude-code-extra', `${COPIED} Claude Code PowerShell`],
    ['cline', 'step-base', `${COPIED} Cline: ${resources.en.endpoint_base_url_openai}`],
  ];
  for (const [tab, key, name] of cases) {
    const html = renderEndpoint({ tab, copied: key });
    const labels = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).filter((b) => b.includes('animate-tactile-tick'))
      .map((b) => (/aria-label="([^"]*)"/.exec(b) || [])[1]);
    const copiedLabels = labels.filter((l) => l.startsWith(`${COPIED} `));
    assert.deepEqual(copiedLabels, [name], `${key}: exactly that button reads Copied (${labels})`);
    assert.ok(labels.filter((l) => l !== name).every((l) => l.startsWith(`${COPY} `)), `${key}: the others read Copy`);
    assert.equal(new Set(labels).size, labels.length, `${key}: still unique`);
  }
});

test('Open WebUI Docker note is hedged; Cursor names the paid plan and the token-only exposure risk', () => {
  assert.ok(resources.en.endpoint_steps_openwebui.endsWith('If Open WebUI runs in Docker it may not reach 127.0.0.1; if the connection fails, run Open WebUI on this PC.'));
  assert.ok(resources.ru.endpoint_steps_openwebui.endsWith('Если Open WebUI запущен в Docker, он может не достучаться до 127.0.0.1; если подключение не удаётся, запустите Open WebUI на этом ПК.'));
  assert.ok(resources.en.endpoint_steps_cursor.includes('Requires a paid Cursor plan.'));
  assert.ok(resources.en.endpoint_steps_cursor.endsWith('Exposing the gateway publicly makes the gateway token the only protection for your NVIDIA keys.'));
  for (const loc of LOCALES) {
    const r = resources[loc];
    for (const name of ['Cursor', 'NVIDIA', '127.0.0.1', 'HTTPS']) assert.ok(r.endpoint_steps_cursor.includes(name), `${loc}: cursor keeps ${name}`);
    assert.ok(r.endpoint_steps_cursor.split('Cursor').length - 1 >= 3, `${loc}: the paid-plan sentence names Cursor`);
    for (const name of ['Open WebUI', 'Docker', '127.0.0.1']) assert.ok(r.endpoint_steps_openwebui.includes(name), `${loc}: openwebui keeps ${name}`);
  }
});

test('doc-verified step text: Kilo custom provider, Open WebUI Add Connection + Docker note, Cursor cannot reach 127.0.0.1', () => {
  for (const loc of LOCALES) {
    const r = resources[loc];
    assert.ok(r.endpoint_steps_kilo.includes('Custom provider') && r.endpoint_steps_kilo.includes('Providers'), `${loc}: kilo`);
    assert.ok(r.endpoint_steps_openwebui.includes('Add Connection') && r.endpoint_steps_openwebui.includes('Docker') && r.endpoint_steps_openwebui.includes('127.0.0.1'), `${loc}: openwebui`);
    assert.ok(r.endpoint_steps_cursor.includes('127.0.0.1') && r.endpoint_steps_cursor.includes('HTTPS'), `${loc}: cursor`);
  }
});

test('CloudCode and the old Anthropic adapter note are gone', () => {
  const src = read('src/renderer/views/Endpoint.tsx') + read('src/renderer/views/clientConfigs.ts');
  assert.doesNotMatch(src, /cloudcode|LiteLLM|OpenAI-to-Anthropic/i);
  for (const tab of ['opencode', 'claude-code', 'cursor']) assert.doesNotMatch(renderEndpoint({ tab }), /CloudCode|LiteLLM/);
});

test('i18n: new keys in all 7 locales, en/ru as specified, endpoint_base_url removed', () => {
  const keys = ['endpoint_universal_title', 'endpoint_base_url_openai', 'endpoint_base_url_anthropic', 'endpoint_model_id', 'endpoint_group_file', 'endpoint_group_env', 'endpoint_group_ui',
    ...['cline', 'roo', 'kilo', 'cursor', 'copilot', 'openwebui'].map((c) => `endpoint_steps_${c}`)];
  for (const loc of LOCALES) {
    for (const k of keys) assert.ok(typeof resources[loc][k] === 'string' && resources[loc][k].length > 0, `${loc}.${k}`);
    assert.ok(!('endpoint_base_url' in resources[loc]), `${loc}: endpoint_base_url removed`);
  }
  const en = { endpoint_universal_title: 'Works with any app', endpoint_base_url_openai: 'Base URL (OpenAI-compatible)', endpoint_base_url_anthropic: 'Base URL (Anthropic, no /v1)', endpoint_model_id: 'Model ID', endpoint_group_file: 'Config file', endpoint_group_env: 'Env vars & code', endpoint_group_ui: 'App settings' };
  const ru = { endpoint_universal_title: 'Для любой программы', endpoint_base_url_openai: 'Базовый URL (OpenAI-совместимый)', endpoint_base_url_anthropic: 'Базовый URL (Anthropic, без /v1)', endpoint_model_id: 'ID модели', endpoint_group_file: 'Файл настроек', endpoint_group_env: 'Переменные и код', endpoint_group_ui: 'Настройки в приложении' };
  for (const [k, v] of Object.entries(en)) assert.equal(resources.en[k], v);
  for (const [k, v] of Object.entries(ru)) assert.equal(resources.ru[k], v);
});
