// W4 renderer fixes (owner-authorized defect wave). The repo has no jsdom, so
// where a defect is behavioural the test exercises the extracted pure function
// or transpiles the module and asserts on its emitted output; pure source/AST
// assertions are marked as such. Nothing here claims a render happened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function loadTs(relative, stubs = null) {
  const ts = require('typescript');
  const js = ts.transpileModule(read(relative), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module_ = { exports: {} };
  const req = stubs === null ? require : (id) => {
    if (id in stubs) return stubs[id];
    if (id.startsWith('.')) {
      const resolved = path.posix.join(path.posix.dirname(relative), id);
      if (resolved in stubs) return stubs[resolved];
    }
    throw new Error(`unexpected import ${id} from ${relative}`);
  };
  new Function('exports', 'module', 'require', js)(module_.exports, module_, req);
  return module_.exports;
}

/** PetWidget's import graph stubbed down to the two values this file needs. */
function loadWidgetModule() {
  const react = {
    useCallback: (f) => f, useEffect: () => {}, useLayoutEffect: () => {},
    useMemo: (f) => f(), useRef: (v) => ({ current: v }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}], createElement: () => null,
  };
  return loadTs('src/renderer/pet/PetWidget.tsx', {
    react,
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') },
    'react-i18next': { useTranslation: () => ({ t: (k) => k }) },
    '@tanstack/react-query': { useQuery: () => ({}), useQueryClient: () => ({}) },
    'react-router-dom': { useLocation: () => ({ pathname: '/' }), useNavigate: () => () => {} },
    'lucide-react': { X: () => null },
    '../lib/api': { api: {}, queryKeys: {} },
    '../lib/modal-context': { useModal: () => ({ activeModal: null }) },
    './tips': {}, './pet.css': {}, './audioEngine': { petAudio: {} },
    './petEngine': { createPetEngine: () => ({}), createPetHoverTracker: () => ({}), createPetRestTimer: () => ({}) },
  });
}

// ---------------------------------------------------------------------------
// 1. OpenCode config: limit + reasoning from real metadata only
// ---------------------------------------------------------------------------
test('opencodeConfig: full metadata emits limit + reasoning, ids/name/baseURL unchanged', () => {
  const { buildOpenCodeConfig } = loadTs('src/renderer/views/opencodeConfig.ts');
  const out = JSON.parse(buildOpenCodeConfig('http://127.0.0.1:12000/v1', 'tok', [{
    id: 'meta/llama-3.1-70b', name: 'Llama 3.1 70B',
    context_length: 131072, max_completion_tokens: 4096,
    capabilities: { reasoning: { supported: true } },
  }]));
  const provider = out.provider['nvidia-gateway'];
  assert.equal(provider.npm, '@ai-sdk/openai-compatible');
  assert.equal(provider.name, 'NV-Gateway');
  assert.deepEqual(provider.options, { baseURL: 'http://127.0.0.1:12000/v1', apiKey: 'tok' });
  const model = provider.models['meta/llama-3.1-70b'];
  assert.equal(model.name, 'Llama 3.1 70B');
  assert.deepEqual(model.limit, { context: 131072, output: 4096 });
  assert.deepEqual(model.reasoning, { supported: true });
});

test('opencodeConfig: partial metadata omits limit entirely (never fabricates a side)', () => {
  const { buildOpenCodeConfig } = loadTs('src/renderer/views/opencodeConfig.ts');
  const cases = [
    { context_length: 131072 },
    { max_completion_tokens: 4096 },
    { context_length: 131072, max_completion_tokens: null },
    { context_length: null, max_completion_tokens: 4096 },
    { context_length: 0, max_completion_tokens: 4096 },
    { context_length: Number.NaN, max_completion_tokens: 4096 },
  ];
  for (const meta of cases) {
    const out = JSON.parse(buildOpenCodeConfig('u', 't', [{ id: 'm', ...meta }]));
    assert.equal(Object.hasOwn(out.provider['nvidia-gateway'].models.m, 'limit'), false,
      `limit must be absent for ${JSON.stringify(meta)}`);
  }
});

test('opencodeConfig: no metadata emits name only; reasoning false/absent emits nothing', () => {
  const { buildOpenCodeConfig } = loadTs('src/renderer/views/opencodeConfig.ts');
  const out = JSON.parse(buildOpenCodeConfig('u', 't', [
    { id: 'bare' },
    { id: 'no-reasoning', capabilities: { reasoning: { supported: false } } },
    { id: 'null-reasoning', capabilities: { reasoning: null } },
    { id: 'no-caps', capabilities: null },
  ]));
  const models = out.provider['nvidia-gateway'].models;
  assert.deepEqual(models.bare, { name: 'bare' }, 'no metadata -> name only');
  for (const id of ['no-reasoning', 'null-reasoning', 'no-caps']) {
    assert.equal(Object.hasOwn(models[id], 'reasoning'), false, `${id} must not claim reasoning`);
    assert.equal(Object.hasOwn(models[id], 'limit'), false);
  }
});

test('opencodeConfig: token and baseURL are escaped by JSON, not interpolated raw', () => {
  const { buildOpenCodeConfig } = loadTs('src/renderer/views/opencodeConfig.ts');
  const evil = 'a"b\\c\n\td';
  const out = JSON.parse(buildOpenCodeConfig('http://x/"quote', evil, [{ id: 'm', name: 'n"x' }]));
  assert.equal(out.provider['nvidia-gateway'].options.apiKey, evil);
  assert.equal(out.provider['nvidia-gateway'].options.baseURL, 'http://x/"quote');
  assert.equal(out.provider['nvidia-gateway'].models.m.name, 'n"x');
});

// ---------------------------------------------------------------------------
// 2. Reset copy tells the truth in all 7 locales
// ---------------------------------------------------------------------------
test('confirm_reset: every locale says setup re-runs and keys/models stay', () => {
  const resources = loadTs('src/renderer/i18n/resources.ts');
  const forbidden = /(removed|deleted|cleared|удал|清除|eliminar|hata|supprim|إزالة)/i;
  for (const locale of ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar']) {
    const value = resources[locale].confirm_reset;
    assert.equal(typeof value, 'string');
    assert.doesNotMatch(value, forbidden, `${locale}.confirm_reset must not claim data is removed`);
  }
  assert.match(resources.en.confirm_reset, /keys and models stay/i);
});

// ---------------------------------------------------------------------------
// 3. Plural forms for every {{count}} key
// ---------------------------------------------------------------------------
test('pluralization: all 15 count keys carry plural forms in every locale', () => {
  const resources = loadTs('src/renderer/i18n/resources.ts');
  const locales = ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar'];
  const countKeys = Object.keys(resources.en).filter(
    (k) => resources.en[k].includes('{{count}}') && !/_(zero|one|two|few|many|other)$/.test(k),
  );
  assert.equal(countKeys.length, 15, `expected 15 count keys, found ${countKeys.length}`);
  // Categories each locale's CLDR rules actually select.
  const REQUIRED = {
    en: ['one', 'other'], ru: ['one', 'few', 'many'],
    zh: ['other'], es: ['one', 'other'], hi: ['one', 'other'],
    fr: ['one', 'other'], ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
  };
  for (const locale of locales) {
    for (const key of countKeys) {
      for (const cat of REQUIRED[locale]) {
        const form = resources[locale][`${key}_${cat}`];
        assert.equal(typeof form, 'string', `${locale}.${key}_${cat} missing`);
        // Arabic one/two are spelled-out duals ("error" / "two errors") and
        // legitimately carry no number; every other form must interpolate it.
        const spelledOutDual = locale === 'ar' && (cat === 'one' || cat === 'two');
        if (!spelledOutDual) assert.match(form, /\{\{count\}\}/, `${locale}.${key}_${cat} must interpolate {{count}}`);
      }
    }
  }
});

test('pluralization: i18next really selects the forms (en/ru/ar), count is passed through', async () => {
  const i18n = require('i18next').createInstance();
  const resources = loadTs('src/renderer/i18n/resources.ts');
  await i18n.init({
    resources: { en: { translation: resources.en }, ru: { translation: resources.ru }, ar: { translation: resources.ar } },
    lng: 'en', fallbackLng: 'en', interpolation: { escapeValue: false },
  });
  assert.equal(i18n.t('errors_success', { count: 1 }), 'Sent 1 error');
  assert.equal(i18n.t('errors_success', { count: 5 }), 'Sent 5 errors');
  await i18n.changeLanguage('ru');
  assert.match(i18n.t('errors_success', { count: 1 }), /1 ошибка/);
  assert.match(i18n.t('errors_success', { count: 3 }), /3 ошибки/);
  assert.match(i18n.t('errors_success', { count: 5 }), /5 ошибок/);
  await i18n.changeLanguage('ar');
  assert.match(i18n.t('errors_success', { count: 2 }), /خطأين/);
  await i18n.changeLanguage('en');
  assert.equal(i18n.t('feedback_charCount', { count: 1, max: 500 }), '1/500 character');
  assert.equal(i18n.t('feedback_charCount', { count: 9, max: 500 }), '9/500 characters');
});

// ---------------------------------------------------------------------------
// 4 + 5. Models.tsx Tailwind / contrast classes (source assertion: styling only)
// ---------------------------------------------------------------------------
test('Models.tsx + Endpoint.tsx: no non-existent rounded-xs, no sub-AA text-textMuted/50|60|70|80', () => {
  for (const file of ['src/renderer/views/Models.tsx', 'src/renderer/views/Endpoint.tsx']) {
    const src = read(file);
    assert.doesNotMatch(src, /text-textMuted\/(?:50|60|70|80)\b/,
      `${file}: these opacities fail WCAG AA on #060706 (/60 is 2.80:1)`);
  }
  assert.doesNotMatch(read('src/renderer/views/Models.tsx'), /\brounded-xs\b/, 'rounded-xs is not a Tailwind 3.4 class');
  assert.match(read('src/renderer/views/Models.tsx'), /rounded-sm/, 'the LED cells use a real class');
});

// ---------------------------------------------------------------------------
// 6. Endpoint credentials: error/retry + copy disabled without a token
// ---------------------------------------------------------------------------
test('Endpoint: failed credentials query shows a retry alert and copy is disabled without a token', () => {
  const src = read('src/renderer/views/Endpoint.tsx');
  assert.match(src, /const credsFailed = credsQuery\.isError;/, 'the failure is an explicit state');
  assert.match(src, /credsFailed && \([\s\S]{0,400}?role="alert"[\s\S]{0,200}?credsQuery\.refetch\(\)/,
    'the alert offers a retry that refetches');
  assert.match(src, /disabled=\{!hasToken\}/, 'the token Copy button is disabled without a token');
  assert.match(src, /if \(text\.length === 0\) return;/, 'copy() refuses to copy an empty string');
});

test('Endpoint: only token-bearing content is refused while the token is missing; placeholders always are', () => {
  const { hasUnresolvedPlaceholder } = loadTs('src/renderer/views/opencodeConfig.ts');
  const TOKEN = 'tok';

  // Behavioural: the pure predicate every Copy button goes through.
  assert.equal(hasUnresolvedPlaceholder('{"apiKey":"tok"}', TOKEN, { embedsToken: true }), false,
    'resolved token: copyable');
  assert.equal(hasUnresolvedPlaceholder('{"apiKey":""}', '', { embedsToken: true }), true,
    'token-bearing content with no token (failed creds fetch): refused');
  assert.equal(hasUnresolvedPlaceholder('{"apiKey":"<model-id>"}', TOKEN, { embedsToken: true }), true,
    'the <model-id> placeholder is never copied');
  // AUDIT CORRECTION: plain strings must copy even when the token is missing.
  assert.equal(hasUnresolvedPlaceholder('http://127.0.0.1:12000/v1', '', { embedsToken: false }), false,
    'base URL copies while creds are failing');
  assert.equal(hasUnresolvedPlaceholder('https://api.nvidia.com', '', { embedsToken: false }), false,
    'Anthropic URL copies too');
  assert.equal(hasUnresolvedPlaceholder('meta/llama-3.1-70b', '', { embedsToken: false }), false,
    'a real model id copies');
  assert.equal(hasUnresolvedPlaceholder('<model-id>', '', { embedsToken: false }), true,
    'the placeholder is refused even as a plain string');

  // Source/AST-level (no jsdom): each call site passes the right flag.
  const src = read('src/renderer/views/Endpoint.tsx');
  assert.match(src, /copy\(gatewayToken, 'token', true\)/, 'the token row is token-bearing');
  assert.match(src, /copy\(baseUrl, 'url'\)/, 'the base URL is not');
  assert.match(src, /copy\(anthropicBaseUrl, 'url-anthropic'\)/, 'nor the Anthropic URL');
  assert.match(src, /copy\(modelId, 'model-id'\)/, 'nor a real model id');
  assert.match(src, /copy\(stepValues\[key\]\.value, `step-\$\{key\}`, key === 'token'\)/,
    'only the token step row is token-bearing');
  // AUDIT CORRECTION: the snippet flag is per-generator, not hard-coded true.
  assert.match(src, /copy\(active\.content, `config-\$\{configTab\}`, active\.embedsToken\)/,
    'the snippet copy uses the snippet\'s own flag');
  assert.match(src, /copy\(active\.extra!\.content, `config-\$\{configTab\}-extra`, active\.extra!\.embedsToken\)/);
  assert.match(src, /disabled=\{!canCopyContent\(active\.content, active\.embedsToken\)\}/);
  assert.doesNotMatch(src, /canCopyContent\([^)]*\{ embedsToken: true \}/, 'no hard-coded true at the call site');
  assert.match(src, /disabled=\{modelId === '<model-id>'\}/, 'the model-id placeholder is disabled');
  assert.match(src, /setCopyError\(t\('endpoint_copy_unresolved'\)\)/, 'a refusal surfaces the error state');
});

test('clientConfigs: every snippet declares embedsToken, and it matches whether the token is really in the content', () => {
  const { buildClientSnippets } = loadTs('src/renderer/views/clientConfigs.ts');
  const TOKEN = 'SECRET-TOKEN-VALUE';
  const snippets = buildClientSnippets({
    openaiBaseUrl: 'http://127.0.0.1:1/v1', anthropicBaseUrl: 'http://127.0.0.1:1',
    token: TOKEN, modelId: 'meta/llama', contextLength: 8192,
  });
  // Behavioural: the flag must equal reality for every generator, including
  // the two that reach the token indirectly (Zed via env var, Codex via
  // env_key) and therefore must stay copyable while creds fail.
  const NOT_TOKEN_BEARING = new Set(['zed', 'codex']);
  for (const [id, snippet] of Object.entries(snippets)) {
    assert.equal(typeof snippet.embedsToken, 'boolean', `${id} must declare embedsToken`);
    assert.equal(snippet.embedsToken, snippet.content.includes(TOKEN),
      `${id}: embedsToken must match whether the token is really in the content`);
    assert.equal(snippet.embedsToken, !NOT_TOKEN_BEARING.has(id), `${id}: expected flag`);
    if (snippet.extra) {
      assert.equal(snippet.extra.embedsToken, true, `${id}: every extra is a setx of the token`);
      assert.equal(snippet.extra.content.includes(TOKEN), true, `${id}: and really contains it`);
    }
  }
  // The two indirect blocks stay copyable with an empty token; the direct ones do not.
  const { hasUnresolvedPlaceholder } = loadTs('src/renderer/views/opencodeConfig.ts');
  assert.equal(hasUnresolvedPlaceholder(snippets.zed.content, '', { embedsToken: snippets.zed.embedsToken }), false,
    'a valid Zed settings.json is copyable while creds fail');
  assert.equal(hasUnresolvedPlaceholder(snippets.codex.content, '', { embedsToken: snippets.codex.embedsToken }), false,
    'a valid Codex config.toml too');
  assert.equal(hasUnresolvedPlaceholder(snippets.curl.content, '', { embedsToken: snippets.curl.embedsToken }), true,
    'a token-bearing block is still refused');
});

// ---------------------------------------------------------------------------
// 7. Dashboard: network validation failure is not reported as a bad key
// ---------------------------------------------------------------------------
test('Dashboard: valid === null (upstream_error) shows the network message, not the failure banner', () => {
  const src = read('src/renderer/views/Dashboard.tsx');
  assert.match(src, /if \(validation\.valid === null\) return 'network';/, 'null is classified as a network failure');
  // AUDIT CORRECTION: the gateway emits `statusCode`, not `status`; reading only
  // `status` made the 401/403 branch dead code.
  assert.match(src, /const code = validation\.statusCode \?\? validation\.status;/, 'reads the real field, tolerates the old one');
  assert.match(src, /code === 401 \|\| code === 403/, 'the auth branch now tests the real code');
  assert.doesNotMatch(src, /validation\.status === 401/, 'the dead `status`-only check is gone');
  assert.match(src, /err\.name = 'KeyNetwork'/, 'it gets its own error identity');
  assert.match(src, /error\.name === 'KeyNetwork'\) setKeyError\(error\.message\)/,
    'the network message goes to the key field, not the mutation banner');
  assert.match(src, /failure === 'network'[\s\S]{0,120}?new Error\(t\('key_network'\)\)/,
    'the unused key_network string is used for the network branch');
  // The declaration must allow what the gateway really sends.
  const types = read('src/renderer/global.d.ts');
  assert.match(types, /adminValidateKey:[\s\S]{0,160}?statusCode\?: number/, 'the bridge type declares statusCode');
  assert.match(types, /adminValidateKey:[\s\S]{0,160}?valid\?: boolean \| null/, 'and valid can be null');
});

// ---------------------------------------------------------------------------
// 8. Pet celebration overlay is bounded and visible for the mascot
// ---------------------------------------------------------------------------
test('PetWidget: the mascot celebration is a REAL engine activity with real mascot CSS (not React state only)', () => {
  const engine = loadTs('src/renderer/pet/petEngine.ts');
  const widget = loadWidgetModule();
  const activity = widget.MASCOT_CELEBRATION_ACTIVITY;

  // The value must be a real activity the engine can hold...
  assert.equal(activity, 'syndicate-salute');
  assert.ok(engine.VIP_ACTIVITIES.includes(activity), 'member of VIP_ACTIVITIES (the engine can set it)');
  assert.equal(engine.MASCOT_ACTIVITIES.includes(activity), false,
    'not in MASCOT_ACTIVITIES: it cannot collide with the normal mascot rotation');

  // ...and pet.css must actually style it for the MASCOT branch: the salute
  // scene is in the mascot JSX and the rule targets it, not the hacker canvas.
  const css = read('src/renderer/pet/pet.css');
  assert.match(css, new RegExp(`\\.nv-pet-wrap\\.act-${activity} \\.m-vip-salute-scene \\{ display: block; \\}`),
    'the mascot salute scene is switched on by the act class');
  assert.match(css, new RegExp(`\\.nv-pet-wrap\\.act-${activity} \\.m-arm-right-rig`), 'and the salute arm is animated');
  const jsx = read('src/renderer/pet/PetWidget.tsx');
  assert.match(jsx, /<g className="m-vip-salute-scene">/, 'the scene exists in the mascot markup');
  assert.doesNotMatch(css, new RegExp(`act-${activity}[^{]*\\.crt-screen`), 'it does not rely on the hacker CRT');

  // Driven through the ENGINE, bounded, and restored to the REAL prior activity.
  // The machine (not a handler-local variable) owns the prior, so the proof is
  // behavioural: it is replayed against the real engine in the harness below.
  assert.match(jsx, /if \(forMascot\) commitOwnActivity\(MASCOT_CELEBRATION_ACTIVITY\);/,
    'the engine activity changes, not just React state');
  assert.doesNotMatch(jsx, /setActivity\('zero-errors'\)/, 'the no-op hacker activity is gone');

  // The prior is captured by the machine BEFORE it commits the salute, so a
  // second ascension inside the same window cannot capture the salute itself.
  // (Behavioural proof: 'mascot double' replay below.)
  assert.match(jsx, /prior = host\.currentActivity\(\);/,
    'the prior is captured from the live activity');
  assert.match(jsx, /else commitOwnActivity\(restoreTo\);/, 'the restore uses the captured value');
  assert.doesNotMatch(jsx, /setActivity\(activityRef\.current\)/, 'restoring the live ref was the bug');
  // The celebration state machine is real code in PetWidget (createCelebration)
  // and is replayed behaviourally below; here we only prove it is wired to the
  // shipped handler and that the dead affective API is gone.
  assert.match(jsx, /celebrationRef\.current = createCelebration\(\{/,
    'the handler drives the extracted state machine');
  assert.match(jsx, /if \(readVipFlag\(\)\) celebrationRef\.current\?\.start\(\);/,
    'the ascension event starts it');
  assert.doesNotMatch(jsx, /setAffective|clearAffective/,
    'the no-op affective overlay (wiped by commit()) is gone');
  const engineSrc = read('src/renderer/pet/petEngine.ts');
  assert.doesNotMatch(engineSrc, /setAffective|clearAffective|getAffective|AffectiveState/,
    'the dead affective API and type are removed from the engine');
  assert.match(jsx, /const CELEBRATION_MS = \d+;/, 'a named bound');
});

// Replay the SHIPPED state machine (createCelebration from PetWidget.tsx) for
// all six scenarios the audit named — against the REAL engine, wired exactly as
// the widget wires it:
//
//   engine.commit() -> opts.onActivityChange -> handleActivityChange
//                   -> celebration.onActivityChange(next)
//   machine.setActivity -> engine.setActivity
//   machine.setHackerMode -> canvas mode
//
// The fake host used to model the engine with a bare `let activity`, which is
// how the dead hacker reset stayed invisible: nothing there could show that the
// widget's activity->mode effect does not re-run when the id is unchanged.
const engineSource = read('src/renderer/pet/petEngine.ts');
function celebrationHarness(character, initialActivity) {
  // petEngine reads/writes the session character; give it a working store.
  const store = new Map([['nv_pet_character', character]]);
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const engineMod = loadTs('src/renderer/pet/petEngine.ts');
  const { createCelebration } = loadWidgetModule();

  let mode = 'idle';
  let nextTimer = 1;
  const timers = new Map();
  // handleActivityChange's view of the activity (activityRef.current).
  let activityRef = initialActivity;

  const engine = engineMod.createPetEngine({
    isVip: () => false,
    onActivityChange: (next) => {
      activityRef = next;             // activityRef.current = next
      machine.onActivityChange(next); // the machine hears EVERY engine commit
    },
    onCue: () => {},
  });

  const machine = createCelebration({
    currentActivity: () => activityRef,
    isMascot: () => character === 'mascot',
    setActivity: (a) => engine.setActivity(a),
    setHackerMode: (m) => { mode = m; },
    setTimer: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimer: (id) => { timers.delete(id); },
  });

  engine.setActivity(initialActivity); // the seeded activity

  return {
    machine,
    engine,
    get activity() { return engine.getActivity(); },
    get mode() { return mode; },
    /** A GENUINE switch: a real engine commit (focus return / rotation). */
    genuine: (a) => engine.setActivity(a),
    timersLeft: () => timers.size,
    fireAll() { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn(); },
  };
}

test('celebration replay: mascot single ascension restores the true prior', () => {
  const h = celebrationHarness('mascot', 'model-juggler');
  h.machine.start();
  assert.equal(h.activity, 'syndicate-salute', 'the mascot celebrates through the engine');
  h.fireAll();
  assert.equal(h.activity, 'model-juggler', 'and restores the prior');
  assert.equal(h.timersLeft(), 0);
});

test('celebration replay: mascot double ascension keeps the ORIGINAL prior', () => {
  const h = celebrationHarness('mascot', 'model-juggler');
  h.machine.start();
  h.machine.start();
  assert.equal(h.timersLeft(), 1, 'the repeat event re-armed, not stacked');
  h.fireAll();
  assert.equal(h.activity, 'model-juggler', 'not the salute, not a stale value');
});

test('celebration replay: ascension while GENUINELY on syndicate-salute still restores it', () => {
  const h = celebrationHarness('mascot', 'syndicate-salute');
  h.machine.start();
  h.fireAll();
  assert.equal(h.activity, 'syndicate-salute', 'the genuine salute idle is preserved');
});

test('celebration replay: hacker single ascension LEAVES celebration mode', () => {
  const h = celebrationHarness('hacker', 'code-frenzy');
  h.machine.start();
  assert.equal(h.mode, 'celebration', 'the canvas celebrates');
  h.fireAll();
  assert.notEqual(h.mode, 'celebration', 'and leaves celebration mode on the timer');
  assert.equal(h.mode, 'code-frenzy', "back to the prior activity's mode");
});

test('celebration replay: hacker double ascension still leaves celebration mode', () => {
  const h = celebrationHarness('hacker', 'coin-drop');
  h.machine.start();
  h.machine.start();
  h.fireAll();
  assert.equal(h.mode, 'coin-drop', 'the original prior mode, never stuck celebrating');
});

test('celebration replay: a genuine activity switch mid-celebration wins over the restore', () => {
  const h = celebrationHarness('mascot', 'model-juggler');
  h.machine.start();
  h.genuine('turbine-generator');
  assert.equal(h.timersLeft(), 0, 'the pending restore is disarmed, not left to fire');
  h.fireAll();
  assert.equal(h.activity, 'turbine-generator', 'the real switch is not clobbered');
});

test('celebration replay: a genuine switch TO syndicate-salute is not clobbered back', () => {
  // The sentinel collision the audit replayed: the salute is a REAL activity, so
  // a switch onto it mid-celebration must survive the timer.
  const h = celebrationHarness('mascot', 'model-juggler');
  h.machine.start();
  h.genuine('syndicate-salute');
  h.fireAll();
  assert.equal(h.activity, 'syndicate-salute', 'not restored to the stale prior');
});

test('celebration replay: a genuine hacker switch mid-celebration also leaves celebration mode', () => {
  // The widget's activity->mode effect only re-runs when the React activity
  // value changes, and a genuine commit can carry the id the canvas already
  // shows. Disarming the timer alone would freeze the canvas in `celebration`
  // forever — the exact dead-hacker-reset failure, reached by another route.
  const h = celebrationHarness('hacker', 'code-frenzy');
  h.machine.start();
  h.genuine('code-frenzy');
  assert.equal(h.mode, 'code-frenzy', 'the canvas left celebration mode without a state change');
});

test('reduced motion shows the static rest pose, not a visible celebration (claim corrected)', () => {
  // The claim under test is BEHAVIOURAL, so it is proven from the CSS that
  // produces it, not from a sentence in a comment (the old version pinned
  // comment prose and rotted the moment the wording changed):
  //  - the salute keyframe STARTS and ENDS at rotate(0deg), i.e. the mascot's
  //    ordinary rest pose, so a paused animation shows the rest pose;
  //  - the reduced-motion rule pauses every animation in the pet subtree.
  const css = read('src/renderer/pet/pet.css');
  const keyframes = css.match(/@keyframes nv-pet-mascotSalutePose \{([\s\S]*?)\n\}/);
  assert.ok(keyframes, 'the salute keyframe exists');
  assert.match(keyframes[1], /0%, 10% \{ transform: rotate\(0deg\) translate\(0, 0\); \}/,
    'the salute starts at the rest pose');
  assert.match(keyframes[1], /100% \{ transform: rotate\(0deg\) translate\(0, 0\); \}/,
    'and returns to it, so a paused frame is the rest pose, not a raised arm');
  // PET-SPEC 2026-10-26 §6.2 rewrote the block as multi-line, multi-rule; the
  // pause rule (same selectors, same declaration) is still its first rule.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.nv-pet-wrap\.nv-pet-wrap\.nv-pet-wrap\.nv-pet-wrap,\s*\.nv-pet-wrap\.nv-pet-wrap\.nv-pet-wrap\.nv-pet-wrap \*:not\(\.m-blink-loop\) \{\s*animation-play-state: paused !important;\s*\}/,
    'the pause rule that produces that behaviour');

  // The widget must not claim a VISIBLE celebration under reduced motion.
  const jsx = read('src/renderer/pet/PetWidget.tsx');
  assert.match(jsx, /REDUCED MOTION: the CSS rule pauses that salute at its/, 'the caveat is documented');
  assert.match(jsx, /NOT visible as motion\. We do not claim otherwise\./, 'and states the honest outcome');
  assert.doesNotMatch(jsx, /pose is static there rather than absent/, 'the old overclaim is gone');
});

// ---------------------------------------------------------------------------
// 9. Renderer error boundary
// ---------------------------------------------------------------------------
test('ErrorBoundary: catches render throws, offers retry, localized, wired around the routed view', () => {
  const boundary = read('src/renderer/components/ErrorBoundary.tsx');
  assert.match(boundary, /static getDerivedStateFromError/, 'a real error boundary, not a try/catch');
  assert.match(boundary, /componentDidCatch/);
  assert.match(boundary, /onClick=\{this\.retry\}/, 'retry action');
  assert.match(boundary, /t\('render_crash'\)/);
  assert.match(boundary, /t\('render_crash_hint'\)/);
  assert.match(boundary, /role="alert"/);

  const layout = read('src/renderer/components/Layout.tsx');
  assert.match(layout, /<ErrorBoundary resetKey=\{viewPath\}>\s*<Outlet \/>\s*<\/ErrorBoundary>/,
    'the routed view is wrapped; the shell survives');
  assert.match(layout, /const viewPath = useLocation\(\)\.pathname;/, 'navigation clears a caught error');

  const resources = loadTs('src/renderer/i18n/resources.ts');
  for (const locale of ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar']) {
    assert.equal(typeof resources[locale].render_crash, 'string');
    assert.equal(typeof resources[locale].render_crash_hint, 'string');
  }
});

// ---------------------------------------------------------------------------
// 10. Logs auto-scroll honours prefers-reduced-motion
// ---------------------------------------------------------------------------
test('Logs: copy is disabled and refuses when there is nothing to copy', () => {
  const src = read('src/renderer/views/Logs.tsx');
  // Source/AST-level (no jsdom): the guard and the disabled binding.
  assert.match(src, /if \(lines\.length === 0\) return;/, 'copy() refuses an empty buffer');
  assert.match(src, /disabled=\{lines\.length === 0\}/, 'the Copy button is disabled when empty');
});

test('Logs: auto-scroll is instant when prefers-reduced-motion is set', () => {
  const src = read('src/renderer/views/Logs.tsx');
  assert.match(src, /behavior: prefersReducedMotion\(\) \? 'auto' : 'smooth'/, 'no smooth scroll under reduced motion');
  assert.match(src, /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.doesNotMatch(src, /behavior: 'smooth' \}/, 'the unconditional smooth scroll is gone');
});
