// Wave 6B "pet advisor": source pins for the wiring the spec fixes verbatim
// (PetWidget / Settings / Dashboard), the static pet.css contract, the i18n
// contract, and a real static render of Dashboard's single-return layout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const count = (source, re) => (source.match(re) ?? []).length;
const between = (source, start, end) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `markers not found: ${start} .. ${end}`);
  return source.slice(a, b);
};

test('PetWidget: data sources, refresh triggers and no new listeners/timers', () => {
  const src = read('src/renderer/pet/PetWidget.tsx');
  // Baseline before 6B: 5 addEventListener, 3 setTimeout, 2 requestAnimationFrame (all in this file).
  // +1 setTimeout and +1 requestAnimationFrame: the hacker canvas rest throttle
  // (PixelHackerRenderer.setMaxFps, art-director decision), not advisor code.
  // +1 addEventListener: the live prefers-reduced-motion 'change' listener
  // (subscribeReducedMotion, audit fix), not advisor code.
  // +1 addEventListener: the window 'pointermove' that ends the hover hold
  // after a show (createPetHoverTracker, audit fix), not advisor code.
  // PET-SPEC 2026-10-26 §4.2: +1 the passive window 'wheel' listener that stamps lastInputAt (quiet rule), 7 -> 8.
  // PET-SPEC 2026-10-26 §11.2: +3 in attachPetAnchor (window 'resize', sidebar
  // 'scroll', plus the 'resize' in the PetAnchorWindow interface type), 8 -> 11.
  assert.equal(count(src, /addEventListener\(/g), 11, 'no new addEventListener beyond the reduced-motion, hover-show, §4.2 wheel and §11.2 anchor listeners');
  // PET-SPEC 2026-10-26 §1.2/§1.3/§3/§7 (one setTimeout per timer kind): +1 the
  // 450 ms activity-swap crossfade, +1 the shared setTimer of the dwell timer and
  // micro scheduler, +1 the click-joy timer (5 -> 8). +1 rAF: the 30 fps
  // HACKER_ACTIVE_FPS frame-skip re-arms inside rAF (3 -> 4). Not advisor code.
  // PET-SPEC 2026-10-26 §4.1/§4.2/§4.6 (8 -> 9): the thought and cue timers (-2) became the one
  // speaking-channel setTimer (+1); +1 the random-tip ALIVE-clock scheduler; +1 the 1.8 s hint gesture.
  assert.equal(count(src, /setTimeout\(/g), 9, 'no new timers beyond the rest throttle, the celebration overlay, the §7 timer kinds and the §4 channel/scheduler/hint');
  assert.equal(count(src, /setInterval\(/g), 0);
  assert.equal(count(src, /requestAnimationFrame\(/g), 4, 'no new rAF beyond the rest throttle and the 30 fps frame-skip');
  assert.doesNotMatch(src, /useGatewayLifecycle/, 'the pet sits outside the lifecycle Provider');
  assert.match(src, /useQuery<GatewayStatus>\(\{ queryKey: \['gateway-status'\], enabled: false \}\)/);
  assert.match(src, /useQuery\(\{ queryKey: queryKeys\.keys, queryFn: api\.keys, enabled: false \}\)/);
  assert.match(src, /queryKey: queryKeys\.updates, queryFn: api\.updateStatus, refetchInterval: false, refetchOnWindowFocus: false/);
  assert.match(src, /queryClient\.fetchQuery\(\{ queryKey: queryKeys\.keys, queryFn: api\.keys, staleTime: 60_000 \}\)\.catch\(\(\) => \{\}\)/);
  assert.match(src, /if \(!running \|\| document\.visibilityState !== 'visible'\) return;/);
  // §1.1/§9.2: the same attention hook also drives the ALIVE/CALM focus flag.
  assert.match(src, /onAttentionGained: \(\) => \{ markAttention\(windowFocused\(document\)\); startAmbient\(\); refreshKeysRef\.current\(\); \}/);
  assert.match(src, /useEffect\(\(\) => \{ refreshKeys\(\); \}, \[refreshKeys, location\.pathname\]\);/,
    'refresh on running->true (identity) and on every route change');
});

test('PetWidget: card structure, announcer inside the widget, dismiss/act focus paths', () => {
  const src = read('src/renderer/pet/PetWidget.tsx');
  const body = between(src, 'export function PetWidget', 'export class PixelHackerRenderer');
  assert.match(body, /<p className="advice-announcement" aria-live="polite" aria-atomic="true">\{announcement\}<\/p>/,
    'the sr-only announcer lives inside PetWidget');
  assert.match(body, /const busy = cueShown \|\| thought !== null;/);
  assert.match(body, /<section\s+key=\{selected\.occurrenceId\}\s+className="advice-card"\s+aria-labelledby=\{ADVICE_TITLE_ID\}/);
  assert.match(body, /<h2 id=\{ADVICE_TITLE_ID\} tabIndex=\{-1\} className="advice-title">/);
  assert.match(body, /className="advice-dismiss"[\s\S]{0,80}aria-label=\{t\('tip_dismiss'\)\}/);
  assert.match(body, /<X size=\{16\} aria-hidden="true" \/>/);
  assert.match(body, /className="advice-action"/);
  assert.match(body, /if \(event\.key === 'Escape'\)/, 'Escape handled on the card (only while focus is inside)');
  assert.match(body, /widgetBtnRef\.current\?\.focus\(\)/, 'X/Escape return focus to .widget-btn');
  assert.match(body, /ref=\{widgetBtnRef\}\s+type="button"\s+className="widget-btn"/);
  assert.match(body, /navigate\(tip\.route, \{ state: \{ focusSetting: tip\.targetId \} \}\)/);
  const act = between(body, 'const actOnTip', '};');
  assert.ok(act.indexOf('dismissTipOccurrence(') < act.indexOf('navigate('), 'the action marks dismissed BEFORE navigating');
  assert.doesNotMatch(body, /advice[\s\S]{0,40}\.focus\(\)/, 'an auto-shown card never takes focus');
});

test('PetWidget: focus inside the card survives the card changing by itself (no new listener)', () => {
  const src = read('src/renderer/pet/PetWidget.tsx');
  const body = between(src, 'export function PetWidget', 'export class PixelHackerRenderer');
  assert.match(body, /const focusInCardRef = useRef\(false\);/);
  // React focus props on the card section, not addEventListener.
  const section = between(body, '<section', '>\n            <div className="advice-head">');
  assert.match(section, /onFocus=\{\(\) => \{ focusInCardRef\.current = true; \}\}/);
  assert.match(section, /onBlur=\{onCardBlur\}/);
  // Leaving to a real element outside the card clears the flag; a null
  // relatedTarget (window blur / node removal) keeps it.
  assert.match(body, /const next = event\.relatedTarget;\s*if \(next instanceof Node && !event\.currentTarget\.contains\(next\)\) focusInCardRef\.current = false;/);
  // After the commit (passive effect) the lost focus is observable as body.
  assert.match(body, /useEffect\(\(\) => \{\s*restoreCardFocus\(focusInCardRef\.current, document, widgetBtnRef\.current\);\s*focusInCardRef\.current = false;\s*\}, \[selected\?\.occurrenceId\]\);/);
});

test('Settings: one return, h2 above every branch, ids, tips switch, focus flow, reset clears nv_pet_tips', () => {
  const src = read('src/renderer/views/Settings.tsx');
  const fn = src.slice(src.indexOf('export function Settings()'));
  assert.equal(count(fn, /\breturn </g), 1, 'Settings has ONE JSX return');
  assert.doesNotMatch(fn, /if \(query\.isPending\) return/);
  assert.doesNotMatch(fn, /className="p-8"/, 'no inner p-8');
  assert.match(fn, /return <div className="flex flex-col h-full overflow-y-auto p-4 sm:p-8"><h2 ref=\{headingRef\} tabIndex=\{-1\} className="text-2xl font-bold mb-8">\{t\('settings'\)\}<\/h2>\{body\}<\/div>;/);
  assert.match(fn, /<button id="setting-updates" onClick=\{\(\) => \{ if \(!\(checkUpdates\.isPending \|\| updateBusy\)\) checkUpdates\.mutate\(\); \}\}/);
  assert.match(fn, /<input id="setting-tips" type="checkbox" role="switch" checked=\{tips\.enabled\} aria-describedby="setting-tips-help" onChange=\{\(event\) => setTipsEnabled\(event\.target\.checked\)\} \/>/);
  assert.match(fn, /<p id="setting-tips-help"[^>]*>\{t\('settings_tips_help'\)\}<\/p>/);
  assert.match(fn, /t\('settings_tips'\)/);
  assert.match(fn, /const pendingFocus = useRef<unknown>\(focusSettingFrom\(location\.state\)\);/);
  assert.match(fn, /useLayoutEffect\(\(\) => \{ if \(pendingFocus\.current !== null\) headingRef\.current\?\.focus\(\); \}, \[\]\);/);
  assert.match(fn, /if \(pendingFocus\.current === null \|\| query\.isPending\) return;\s*focusPendingSetting\(pendingFocus\.current\);\s*pendingFocus\.current = null;\s*navigate\(location\.pathname, \{ replace: true, state: null \}\);/);
  const rerun = between(fn, 'const rerun = async', '};');
  assert.match(rerun, /clearTipsState\(\);/, 'owner item N: reset/rerun clears nv_pet_tips');
});

test('Dashboard: one return, unconditional header, add-key id, alert below, focus effect', () => {
  const src = read('src/renderer/views/Dashboard.tsx');
  const fn = between(src, 'export function Dashboard()', '\nfunction IconButton');
  assert.equal(count(fn, /\breturn </g), 1, 'Dashboard has ONE JSX return');
  assert.doesNotMatch(fn, /if \(unavailable\) \{/);
  assert.match(fn, /<h2 ref=\{headingRef\} tabIndex=\{-1\} className="text-2xl font-bold">\{t\('keys'\)\}<\/h2><button id="dash-add-key" onClick=\{\(\) => setAdding\(true\)\} disabled=\{unavailable\}/);
  assert.match(fn, /\{unavailable \? <div role="alert" className="flex-1 grid place-items-center text-center">/);
  assert.match(fn, /if \(pendingFocus\.current !== null && !unavailable && state !== 'loading'\) \{/);
  assert.match(fn, /\}, \[state, unavailable\]\);/);
  assert.match(fn, /navigate\(location\.pathname, \{ replace: true, state: null \}\);/);
});

function renderDashboard(lifecycleState) {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const code = typescript.transpileModule(read('src/renderer/views/Dashboard.tsx'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, jsx: typescript.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const stubs = {
    '@tanstack/react-query': {
      useQuery: () => ({ data: undefined, isPending: lifecycleState !== 'running', isError: false, error: null, refetch() {} }),
      useMutation: () => ({ mutate() {}, isPending: false }),
      useQueryClient: () => ({}),
    },
    'react-i18next': { useTranslation: () => ({ t: (k) => k }) },
    'react-router-dom': { useLocation: () => ({ pathname: '/dashboard', state: null }), useNavigate: () => () => {} },
    '../lib/api': { api: {}, queryKeys: { keys: ['keys'] } },
    '../lib/frontend-state': { classifyDataState: () => 'loading', isPlausibleNvidiaKey: () => true, moveItem: (a) => a, safeError: (_e, f) => f },
    '../lib/frontend-behavior': { createDashboardKeysQueryPolicy: () => ({}) },
    '../lib/gateway-lifecycle': { useGatewayLifecycle: () => ({ status: { state: lifecycleState } }) },
    '../pet/tips': { focusPendingSetting: () => 'heading', focusSettingFrom: () => null },
  };
  const module = { exports: {} };
  const errors = [];
  const quietConsole = { ...console, error: (...a) => errors.push(a.join(' ')) };
  vm.runInNewContext(code, { module, exports: module.exports, require: (id) => (id in stubs ? stubs[id] : require(id)), console: quietConsole }, { filename: 'Dashboard.tsx' });
  return renderToStaticMarkup(React.createElement(module.exports.Dashboard));
}

test('Dashboard renders the header on BOTH branches; the unavailable alert sits below it', () => {
  const down = renderDashboard('stopped');
  assert.match(down, /<header[^>]*><h2 tabindex="-1" class="text-2xl font-bold">keys<\/h2><button id="dash-add-key"[^>]*disabled=""/);
  assert.match(down, /<\/header>[\s\S]*<div role="alert" class="flex-1 grid place-items-center text-center">[\s\S]*gateway_stopped/);
  const up = renderDashboard('running');
  assert.match(up, /<h2 tabindex="-1" class="text-2xl font-bold">keys<\/h2><button id="dash-add-key"/);
  assert.doesNotMatch(up, /gateway_stopped/);
  assert.doesNotMatch(up, /id="dash-add-key"[^>]*disabled=""/);
});

test('pet.css: advice card contract (exact values, motion, forced-colors, theme-invariant)', () => {
  const css = read('src/renderer/pet/pet.css');
  const rule = (sel) => {
    const re = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
    const m = re.exec(css);
    assert.ok(m, `missing rule ${sel}`);
    return m[2];
  };
  const card = rule('.advice-card');
  for (const decl of ['background: #16261B', 'border-inline-start: 2px solid #33FF00', 'border-start-start-radius: 0',
    'border-end-start-radius: 0', 'border-start-end-radius: 4px', 'border-end-end-radius: 4px',
    /* §11.3: was max-inline-size 230px / margin-inline -10px / width calc(100% + 20px) / margin-block-start 8px */
    'position: fixed', 'inset-inline-start: 258px', 'inset-block-end: max(16px, calc(100vh - var(--pet-anchor-bottom, 100vh)))',
    'inline-size: 300px', 'max-inline-size: calc(100vw - 258px - 16px)', 'max-block-size: calc(100vh - 32px)',
    'overflow-y: auto', 'margin: 0', 'z-index: 40', 'box-sizing: border-box', 'padding: 12px',
    'animation: nv-advice-in 180ms cubic-bezier(0.2, 0, 0, 1)']) {
    assert.ok(card.includes(decl), `.advice-card must declare ${decl}`);
  }
  assert.match(rule('.advice-label'), /font-size: 12px;[\s\S]*line-height: 16px;[\s\S]*font-weight: 600;[\s\S]*color: #33FF00;[\s\S]*text-transform: none;/);
  assert.match(rule('.advice-title'), /* §4.5: was 13/19 */ /font-size: 14px;[\s\S]*line-height: 20px;[\s\S]*font-weight: 600;[\s\S]*color: #E8ECEF;[\s\S]*margin: 4px 0 0;/);
  assert.match(rule('.advice-body'), /font-size: 13px;[\s\S]*line-height: 19px;[\s\S]*font-weight: 400;[\s\S]*color: #E8ECEF;[\s\S]*text-align: start;[\s\S]*overflow-wrap: anywhere;[\s\S]*margin: 4px 0 0;/);
  const dismiss = rule('.advice-dismiss');
  // Design decision (c): a 40x28 hit area pulled 12px up into the card padding,
  // icon bottom-aligned to the "Tip" label, so the header row is 16px.
  assert.match(dismiss, /display: inline-flex;[\s\S]*align-items: flex-end;[\s\S]*justify-content: center;[\s\S]*inline-size: 40px;[\s\S]*block-size: 28px;[\s\S]*margin-block-start: -12px;[\s\S]*margin-inline-end: -8px;[\s\S]*padding: 0;[\s\S]*color: #7A8CA0;/);
  assert.doesNotMatch(dismiss, /block-size: 40px|margin-block-start: -8px|align-items: center/, 'the old 40x40 box is gone');
  assert.match(rule('.advice-dismiss:hover'), /color: #E8ECEF;/);
  const action = rule('.advice-action');
  assert.match(action, /margin-block-start: 12px;[\s\S]*min-block-size: 44px;[\s\S]*padding: 0 12px;[\s\S]*border: 1px solid #33FF00;[\s\S]*border-radius: 4px;[\s\S]*background: transparent;[\s\S]*color: #E8ECEF;[\s\S]*font-size: 13px;[\s\S]*line-height: 18px;[\s\S]*font-weight: 600;/);
  assert.match(rule('.advice-action:hover'), /background: #183819;/);
  assert.match(rule('.advice-action:active'), /background: #1B4B17;/);
  assert.match(rule('.advice-announcement'), /position: absolute;[\s\S]*clip: rect\(0, 0, 0, 0\);/);
  assert.match(css, /@keyframes nv-advice-in \{\s*from \{ opacity: 0; \}\s*to \{ opacity: 1; \}\s*\}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.advice-card \{ animation: none; \}\s*\}/);
  assert.match(css, /@media \(forced-colors: active\) \{\s*\.advice-card \{ border: 1px solid CanvasText; border-inline-start-width: 2px; \}\s*\}/);

  // Theme-invariant and no custom focus ring: no selector that names .advice-*
  // may also name a theme / VIP class, and no advice rule declares an outline.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [, selector, bodyText] of rules) {
    if (!/\.advice-/.test(selector)) continue;
    assert.doesNotMatch(selector, /theme-|vip-mode|nv-pet-wrap/, `advice rule must be theme-invariant: ${selector.trim()}`);
    assert.doesNotMatch(bodyText, /outline/, `no custom outline on ${selector.trim()}`);
    // §11.3: the floating .advice-card gets exactly the two-layer separation
    // shadow (was box-shadow: none); every other advice rule stays shadowless.
    const SPEC_SHADOW = 'box-shadow: 0 1px 2px rgb(0 0 0 / 0.24), 0 8px 24px rgb(0 0 0 / 0.32)';
    const shadowless = /\.advice-card\s*$/.test(selector.split('*/').pop().trim()) ? bodyText.replace(SPEC_SHADOW, '') : bodyText;
    assert.doesNotMatch(shadowless, /box-shadow:(?!\s*none\b)/, `no shadow on ${selector.trim()}`);
  }
});

const NEW_KEYS = ['tip_label', 'tip_dismiss', 'tip_announce', 'tip_keys_exhausted_title', 'tip_keys_exhausted_body',
  'tip_keys_exhausted_action', 'tip_update_available_title', 'tip_update_available_body', 'tip_update_available_action',
  'settings_tips', 'settings_tips_help'];

test('i18n: 11 advisor keys in all 7 locales, fixed EN copy, interpolations intact', () => {
  const compiled = typescript.transpileModule(read('src/renderer/i18n/resources.ts'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { Error, exports: module.exports, module }, { filename: 'resources.ts' });
  const res = module.exports;
  const en = res.en;
  assert.equal(en.tip_label, 'Tip');
  assert.equal(en.tip_dismiss, 'Dismiss tip');
  assert.equal(en.tip_announce, 'Tip: {{title}}');
  assert.equal(en.tip_keys_exhausted_title, 'Every key hit its quota');
  assert.equal(en.tip_keys_exhausted_body, 'Keys retry on their own; add a key to keep working now.');
  assert.equal(en.tip_keys_exhausted_action, 'Add a key');
  assert.equal(en.tip_update_available_title, 'Update available');
  assert.equal(en.tip_update_available_body, 'Version {{v}} is ready to install from Settings.');
  assert.equal(en.tip_update_available_action, 'View update');
  const enKeys = Object.keys(en).sort();
  for (const locale of ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar']) {
    const dict = res[locale];
    assert.deepEqual(Object.keys(dict).sort(), enKeys, `${locale} key set must equal EN`);
    for (const key of NEW_KEYS) {
      assert.ok(typeof dict[key] === 'string' && dict[key].trim().length > 0, `${locale}.${key}`);
      const tokens = (dict[key].match(/\{\{\s*[^}]*\}\}/g) ?? []).sort();
      const expected = key === 'tip_announce' ? ['{{title}}'] : key === 'tip_update_available_body' ? ['{{v}}'] : [];
      assert.deepEqual(tokens, expected, `${locale}.${key} interpolation tokens`);
    }
  }
});
