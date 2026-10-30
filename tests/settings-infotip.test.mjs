// Wave 6C: settings info-tooltips (InfoTip). Source pins in the style of the
// other renderer tests, a behavioural test of the pure open/close reducer, a
// real static render of the component, the Settings wiring and the i18n
// contract (7 locales, rewritten mode_*_help texts, the Arabic pins).
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
const INFOTIP = 'src/renderer/components/InfoTip.tsx';
const count = (source, re) => (source.match(re) ?? []).length;

function loadInfoTip() {
  const code = typescript.transpileModule(read(INFOTIP), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, jsx: typescript.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const stubs = { 'react-i18next': { useTranslation: () => ({ t: (k, o) => (o && 'name' in o ? `${k}|${o.name}` : k) }) } };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: (id) => (id in stubs ? stubs[id] : require(id)), console }, { filename: 'InfoTip.tsx' });
  return module.exports;
}

test('InfoTip: button + always-rendered tooltip wiring (source)', () => {
  const src = read(INFOTIP);
  assert.match(src, /import \{ Info \} from 'lucide-react';/, 'InfoTip imports its own icon');
  assert.match(src, /const id = useId\(\);/);
  assert.match(src, /<button\s+type="button"/);
  assert.match(src, /aria-describedby=\{id\}/);
  assert.match(src, /aria-label=\{t\('infotip_label', \{ name \}\)\}/);
  assert.match(src, /className="inline-flex h-6 w-6 items-center justify-center text-textMuted hover:text-accent-neon"/);
  assert.match(src, /<Info size=\{14\} aria-hidden="true" \/>/);
  assert.match(src, /<div id=\{id\} role="tooltip" hidden=\{!open\}/, 'the tooltip is always rendered and toggled with hidden');
  assert.doesNotMatch(src, /\{open && /, 'never unmounted while closed');
  const tip = /role="tooltip"[^>]*className="([^"]+)"/.exec(src)?.[1] ?? '';
  for (const cls of ['w-max', '[max-inline-size:min(280px,calc(100vw_-_2rem))]', 'bg-bg', 'border', 'border-border', 'text-textMain',
    'text-[13px]', 'leading-[19px]', 'px-3', 'py-2', 'forced-colors:border-[color:CanvasText]']) {
    assert.ok(tip.split(/\s+/).includes(cls), `tooltip class ${cls}`);
  }
  const classNames = [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]).join(' ');
  assert.doesNotMatch(classNames, /rounded|shadow|transition|animate-/, 'no radius, shadow or animation');
  assert.match(src, /className=\{`absolute top-full \$\{side === 'end' \? 'end-0' : 'start-0'\} z-10 pt-1`\}/, 'logical anchor, z-10, 4px padding bridge');
  assert.match(src, /side = 'start'/, 'start is the default anchor');
});

test('InfoTip: Escape on the button, hover-only document listener, click toggle (source)', () => {
  const src = read(INFOTIP);
  assert.match(src, /onKeyDown=\{\(event\) => \{\s*if \(event\.key === 'Escape' && open\) \{\s*event\.stopPropagation\(\);\s*setSource\(null\);\s*\}\s*\}\}/);
  assert.match(src, /useEffect\(\(\) => \{\s*if \(source !== 'hover'\) return;\s*const onKey = \(event: KeyboardEvent\) => \{ if \(event\.key === 'Escape'\) setSource\(null\); \};\s*document\.addEventListener\('keydown', onKey\);\s*return \(\) => document\.removeEventListener\('keydown', onKey\);\s*\}, \[source\]\);/);
  assert.equal(count(src, /addEventListener\(/g), 1, 'exactly one listener, the hover-open one');
  assert.match(src, /onClick=\{\(\) => setSource\(\(s\) => nextInfoTip\(s, 'click'\)\)\}/);
  assert.match(src, /onFocus=\{\(\) => setSource\(\(s\) => nextInfoTip\(s, 'focus'\)\)\}/);
  assert.match(src, /onBlur=\{\(\) => setSource\(\(s\) => nextInfoTip\(s, 'blur'\)\)\}/);
  assert.match(src, /onPointerEnter=\{\(event\) => \{ if \(event\.pointerType !== 'touch'\) setSource\(\(s\) => nextInfoTip\(s, 'hover'\)\); \}\}/);
  assert.match(src, /onPointerLeave=\{\(event\) => \{ if \(event\.pointerType !== 'touch'\) setSource\(\(s\) => nextInfoTip\(s, 'leave'\)\); \}\}/);
});

test('InfoTip: open/close reducer (behaviour)', () => {
  const { nextInfoTip } = loadInfoTip();
  assert.equal(nextInfoTip(null, 'focus'), 'focus', 'focus opens');
  assert.equal(nextInfoTip(null, 'hover'), 'hover', 'hover opens');
  assert.equal(nextInfoTip('hover', 'focus'), 'hover', 'an open tip keeps its source');
  assert.equal(nextInfoTip(null, 'click'), 'click', 'click opens');
  assert.equal(nextInfoTip('click', 'click'), null, 'click toggles closed');
  assert.equal(nextInfoTip('hover', 'click'), 'click', 'a click while hover-open keeps it open (then the next click closes)');
  assert.equal(nextInfoTip('focus', 'click'), 'click');
  for (const from of ['focus', 'hover', 'click']) {
    assert.equal(nextInfoTip(from, 'blur'), null, `blur closes (${from})`);
    assert.equal(nextInfoTip(from, 'leave'), null, `leaving the wrapper closes (${from})`);
    assert.equal(nextInfoTip(from, 'escape'), null, `Escape closes (${from})`);
  }
});

test('InfoTip: static render keeps the tooltip in the DOM, hidden, and described by id', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { InfoTip } = loadInfoTip();
  const html = renderToStaticMarkup(React.createElement(InfoTip, { name: 'Models' }, 'Body text'));
  const described = /aria-describedby="([^"]+)"/.exec(html)?.[1];
  assert.ok(described, 'the button is described by the tooltip');
  assert.match(html, new RegExp(`<div id="${described.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" role="tooltip" hidden=""[^>]*>Body text</div>`));
  assert.match(html, /<button type="button"[^>]*aria-label="infotip_label\|Models"/);
  assert.match(html, /class="absolute top-full start-0 z-10 pt-1"/);
  const end = renderToStaticMarkup(React.createElement(InfoTip, { name: 'x', side: 'end' }, 'y'));
  assert.match(end, /class="absolute top-full end-0 z-10 pt-1"/);
});

test('Settings: three InfoTips with the right keys/anchors; no title= on the radios; model-mode aria-label', () => {
  const src = read('src/renderer/views/Settings.tsx');
  assert.match(src, /import \{ InfoTip \} from '\.\.\/components\/InfoTip';/);
  assert.equal(count(src, /<InfoTip\b/g), 3, 'exactly three info-tips');
  assert.doesNotMatch(src, /side="end"/, 'all three anchor at start');
  // #1 Performance mode: the 3 existing help keys as a list; the radios lose title=.
  assert.match(src, /<div className="relative flex items-center gap-1"><span>\{t\('models_mode_label'\)\}<\/span><InfoTip name=\{t\('models_mode_label'\)\}><ul className="grid gap-1"><li>\{t\('mode_day_help'\)\}<\/li><li>\{t\('mode_night_help'\)\}<\/li><li>\{t\('mode_auto_help'\)\}<\/li><\/ul><\/InfoTip>/);
  const radios = src.slice(src.indexOf('role="radiogroup"'), src.indexOf('<RequestDeadlineSection'));
  assert.doesNotMatch(radios, /title=/, 'the radios have no title= any more');
  assert.doesNotMatch(src, /title=\{t\(`mode_/);
  // #2 Models section label, wrapped because the row is justify-between.
  assert.match(src, /<div className="flex items-center justify-between gap-4">\s*<div className="relative flex items-center gap-1"><span className="text-textMain font-medium">\{t\('models_title'\)\}<\/span><InfoTip name=\{t\('models_title'\)\}>\{t\('infotip_model_mode'\)\}<\/InfoTip><\/div>/);
  // #3 right after Change port.
  assert.match(src, />\{t\('change_port'\)\}<\/button><InfoTip name=\{t\('change_port'\)\}>\{t\('infotip_change_port'\)\}<\/InfoTip><button onClick=\{\(\) => void rerun\(\)\}/);
  // The per-model select is named after its model.
  assert.match(src, /aria-label=\{t\('models_mode_label'\) \+ ' — ' \+ model\.name\}/);
  assert.doesNotMatch(src, /disabled=\{modeMutation\.isPending\}[\s\S]{0,160}aria-label=\{t\('models_title'\)\}/);
});

function loadResources() {
  const compiled = typescript.transpileModule(read('src/renderer/i18n/resources.ts'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { Error, exports: module.exports, module }, { filename: 'resources.ts' });
  return module.exports;
}

test('i18n: infotip keys in all 7 locales, the 6 EN texts verbatim, key parity, interpolation', () => {
  const res = loadResources();
  const { en } = res;
  assert.equal(en.mode_day_help, 'Tolerant profile: waits longer for a slow upstream — 300 s first byte (capped by the request deadline), at least 3 attempts, more to cover every usable key. Best when the network or upstream is slow.');
  assert.equal(en.mode_night_help, 'Fast profile: shorter waits — 120 s first byte (capped by the request deadline), at least 2 attempts, more to cover every usable key. Best when everything is healthy.');
  assert.equal(en.mode_auto_help, 'Auto: switches using timeouts and stream errors in the last 20 requests (needs 10+), after 3 agreeing checks, at most once per 10 min.');
  assert.equal(en.infotip_model_mode, "Each model's mode menu overrides the global mode for that model only. Day and Night apply; Auto follows the global mode.");
  assert.equal(en.infotip_change_port, 'Opens the port picker. The gateway uses port P for clients and P+1 for its admin channel.');
  assert.equal(en.infotip_label, 'More about {{name}}');
  const enKeys = Object.keys(en).sort();
  for (const locale of ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar']) {
    const dict = res[locale];
    assert.deepEqual(Object.keys(dict).sort(), enKeys, `${locale} key set equals EN`);
    for (const key of ['infotip_model_mode', 'infotip_change_port', 'infotip_label', 'mode_day_help', 'mode_night_help', 'mode_auto_help']) {
      assert.ok(typeof dict[key] === 'string' && dict[key].trim() !== '', `${locale}.${key}`);
      const tokens = dict[key].match(/\{\{\s*[^}]*\}\}/g) ?? [];
      assert.deepEqual(tokens, key === 'infotip_label' ? ['{{name}}'] : [], `${locale}.${key} interpolation`);
    }
    // The rewritten texts carry the real numbers.
    assert.match(dict.mode_day_help, /300/);
    assert.match(dict.mode_night_help, /120/);
    for (const n of ['20', '10', '3']) assert.ok(dict.mode_auto_help.includes(n), `${locale}.mode_auto_help mentions ${n}`);
  }
});

test('Settings: LLM Stats ranking switch (default on, same row pattern as the tips switch, writes app config)', () => {
  const src = read('src/renderer/views/Settings.tsx');
  assert.match(src, /const llmStats = useMutation\(\{ mutationFn: async \(llmStatsEnabled: boolean\) => \{ const config = await window\.electronAPI\.setAppConfig\(\{ llmStatsEnabled \}\); setConfig\(config\); return config; \},/);
  // Same markup shape and classes as the tips row; placed right after it.
  const row = '<div className="grid gap-2 border border-border bg-surface p-4"><label className="flex items-center justify-between gap-4 py-1"><span>{t(\'settings_llm_stats\')}</span><input id="setting-llm-stats" type="checkbox" role="switch" checked={query.data.llmStatsEnabled !== false} aria-describedby="setting-llm-stats-help" aria-disabled={llmStats.isPending} onChange={(event) => { if (!llmStats.isPending) llmStats.mutate(event.target.checked); }} className="aria-disabled:opacity-50 aria-disabled:focus-visible:opacity-100" /></label><p id="setting-llm-stats-help" className="text-xs text-textMuted">{t(\'settings_llm_stats_help\')}</p></div>';
  const at = src.indexOf(row);
  assert.ok(at > 0, 'the LLM Stats row is present verbatim');
  const tipsEnd = src.indexOf("{t('settings_tips_help')}</p></div>");
  assert.ok(tipsEnd > 0 && at === tipsEnd + "{t('settings_tips_help')}</p></div>".length + 5, 'placed directly after the tips switch row');
});

test('Settings switches toggled in place keep focus (aria-disabled + guarded handler, never disabled=) and update optimistically', () => {
  const src = read('src/renderer/views/Settings.tsx');
  const inputOf = (marker) => {
    const at = src.indexOf(marker);
    assert.ok(at > 0, `marker ${marker}`);
    const start = src.lastIndexOf('<input', at);
    return src.slice(start, src.indexOf('/>', at) + 2);
  };
  const cases = [
    ["checked={query.data.autoLaunch}", 'autoLaunch', /onChange=\{\(event\) => \{ if \(!autoLaunch\.isPending\) autoLaunch\.mutate\(event\.target\.checked\); \}\}/],
    ['id="setting-llm-stats"', 'llmStats', /onChange=\{\(event\) => \{ if \(!llmStats\.isPending\) llmStats\.mutate\(event\.target\.checked\); \}\}/],
    ['checked={model.enabled}', 'toggleMutation', /onChange=\{\(e\) => \{ if \(!toggleMutation\.isPending\) toggleMutation\.mutate\(\{ id: model\.id, enabled: e\.target\.checked \}\); \}\}/],
  ];
  const DIM = 'aria-disabled:opacity-50 aria-disabled:focus-visible:opacity-100';
  for (const [marker, name, handler] of cases) {
    const input = inputOf(marker);
    assert.doesNotMatch(input, /(?<![-\w])disabled=/, `${name}: a disabled focused switch drops focus to <body>`);
    assert.match(input, new RegExp(`aria-disabled=\\{${name}\\.isPending\\}`), `${name}: aria-disabled while pending`);
    assert.match(input, handler, `${name}: the handler ignores changes while pending`);
    assert.ok(input.includes(`className="${DIM}"`), `${name}: dimmed on the input itself, focus ring stays full`);
  }
  // The other in-place controls: aria-disabled + guarded handler, disabled:opacity-50 mapped.
  const elementOf = (marker, tag) => {
    const at = src.indexOf(marker);
    assert.ok(at > 0, `marker ${marker}`);
    return src.slice(src.lastIndexOf(`<${tag}`, at), src.indexOf(`</${tag}>`, at));
  };
  const controls = [
    ["{t('models_refresh')}", 'button', 'isPending', /onClick=\{\(\) => \{ if \(!isPending\) refreshMutation\.mutate\(\); \}\}/, true],
    ["aria-label={t('models_mode_label') + ' — ' + model.name}", 'select', 'modeMutation.isPending', /onChange=\{\(e\) => \{ if \(!modeMutation\.isPending\) modeMutation\.mutate\(\{ id: model\.id, mode: e\.target\.value as 'day' \| 'night' \| 'auto' \}\); \}\}/, true],
    ['role="radio"', 'button', 'performanceBusy', /onClick=\{\(\) => \{ if \(!performanceBusy\) setPerformanceMode\(mode\); \}\}/, true],
    ['id="setting-updates"', 'button', 'checkUpdates.isPending || updateBusy', /onClick=\{\(\) => \{ if \(!\(checkUpdates\.isPending \|\| updateBusy\)\) checkUpdates\.mutate\(\); \}\}/, false],
  ];
  for (const [marker, tag, busy, handler, dimmed] of controls) {
    const el = elementOf(marker, tag);
    assert.doesNotMatch(el, /(?<![-\w])disabled[=:]/, `${marker}: no disabled= / disabled: variant (focus fixup drops focus to <body>)`);
    assert.ok(el.includes(`aria-disabled={${busy}}`), `${marker}: aria-disabled={${busy}}`);
    assert.match(el, handler, `${marker}: the handler is guarded`);
    if (dimmed) assert.ok(el.includes(DIM), `${marker}: disabled:opacity-50 mapped to aria-disabled`);
    else assert.doesNotMatch(el, /opacity/, `${marker}: had no disabled: variant, so no visual change`);
  }
  assert.doesNotMatch(src, /<form\b/, 'no <form>: Enter on a guarded button cannot submit');
  // Optimistic cache update: cancel the in-flight runtime refetch first, then set; rolled back on error.
  for (const [name, field] of [['autoLaunch', 'autoLaunch'], ['llmStats', 'llmStatsEnabled']]) {
    const def = src.slice(src.indexOf(`const ${name} = useMutation(`), src.indexOf('\n', src.indexOf(`const ${name} = useMutation(`)));
    assert.match(def, new RegExp(`onMutate: async \\(value: boolean\\) => \\{ await client\\.cancelQueries\\(\\{ queryKey: queryKeys\\.runtime \\}\\); const previous = client\\.getQueryData\\(queryKeys\\.runtime\\); client\\.setQueryData\\(queryKeys\\.runtime, \\(prev: unknown\\) => prev && typeof prev === 'object' \\? \\{ \\.\\.\\.\\(prev as object\\), ${field}: value \\} : prev\\); return \\{ previous \\}; \\}`), `${name}: cancel, then optimistic setQueryData`);
    assert.match(def, /onError: \(_error, _value, context\) => \{ client\.setQueryData\(queryKeys\.runtime, context\?\.previous\); \}/, `${name}: rollback on error`);
    assert.match(def, /onSettled: \(\) => client\.invalidateQueries\(\{ queryKey: queryKeys\.runtime \}\)/, `${name}: refetch the truth`);
  }
  const perf = src.slice(src.indexOf('const performanceModeMutation = useMutation('), src.indexOf('\n', src.indexOf('const performanceModeMutation = useMutation(')));
  const cancelAt = perf.indexOf('await client.cancelQueries({ queryKey: queryKeys.runtime });');
  assert.ok(cancelAt > 0 && cancelAt < perf.indexOf('client.setQueryData(queryKeys.runtime'), 'performance mode: cancel the refetch before setQueryData');
});

test('i18n: LLM Stats switch keys in all 7 locales; host name kept verbatim', () => {
  const res = loadResources();
  assert.equal(res.en.settings_llm_stats, 'Model ranking (LLM Stats)');
  assert.equal(res.en.settings_llm_stats_help, "Shows each model's public ranking. About once a day the app fetches it from api.zeroeval.com (no keys or prompts are sent). Turn off to stop these requests.");
  for (const locale of ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar']) {
    const dict = res[locale];
    assert.ok(typeof dict.settings_llm_stats === 'string' && dict.settings_llm_stats.includes('LLM Stats'), `${locale}.settings_llm_stats`);
    assert.ok(typeof dict.settings_llm_stats_help === 'string' && dict.settings_llm_stats_help.includes('api.zeroeval.com'), `${locale}.settings_llm_stats_help`);
    assert.doesNotMatch(dict.settings_llm_stats + dict.settings_llm_stats_help, /\{\{/, `${locale}: no interpolation`);
  }
});

test('i18n: Arabic and Russian attempt wording (dual / number agreement), old wrong wording gone', () => {
  const { en, ru, ar } = loadResources();
  assert.ok(ar.mode_night_help.includes('ومحاولتان للتجاوز على الأقل، وأكثر لتغطية كل مفتاح قابل للاستخدام'));
  assert.ok(!ar.mode_night_help.includes('2 محاولات'), 'no "2 + plural" in Arabic');
  assert.ok(ar.mode_day_help.includes('و3 محاولات تجاوز على الأقل، وأكثر لتغطية كل مفتاح قابل للاستخدام'));
  assert.ok(ru.mode_day_help.includes('не меньше 3 попыток, больше — чтобы охватить все доступные ключи'));
  assert.ok(ru.mode_night_help.includes('не меньше 2 попыток, больше — чтобы охватить все доступные ключи'));
  assert.doesNotMatch(en.mode_day_help + en.mode_night_help, /failover attempts/);
  assert.doesNotMatch(ru.mode_day_help + ru.mode_night_help, /попытки отказоустойчивости/);
  assert.doesNotMatch(en.mode_auto_help, /Slow results|fast results/);
});
