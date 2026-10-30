// W4d renderer locale fixes (CodeRabbit deep audit, wave D).
//
//   1. Models.tsx: formatLastUpdated() formatted dates with the HOST locale, so
//      a Russian UI printed en-US dates. It must take the active i18n language.
//   2. Settings.tsx: a literal ':' was appended after t('last_refresh'), but the
//      translation values already end with one ("Last refresh::").
//   3. Endpoint.tsx: a failed gateway-credentials fetch reused `keys_error`
//      ("Keys could not be loaded"), which misdescribes it; a dedicated
//      `endpoint_creds_error` key now carries the accurate message in all 7
//      locales.
//
// The repo has no jsdom: the pure formatter is transpiled and executed, the two
// views are transpiled and rendered with react-dom/server (static markup), and
// wiring that cannot be observed statically is pinned at source level and marked
// as such.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import typescript from 'typescript';
import { EXPECTED_LOCALE_KEY_COUNT } from './support/i18n-contract.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const LOCALES = ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar'];

function transpile(relative) {
  return typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, jsx: typescript.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
}

function evalModule(relative, extra = '', requireFn = require, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(relative) + extra, { module, exports: module.exports, require: requireFn, console, window: {}, ...globals }, { filename: relative });
  return module.exports;
}

const resources = evalModule('src/renderer/i18n/resources.ts');
const interpolate = (text, o = {}) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in o ? String(o[k]) : m));
/** `t` bound to one REAL locale, so the rendered text is what a user sees. */
const translatorFor = (locale) => (k, o) => (k in resources[locale] ? interpolate(resources[locale][k], o) : k);
const textOf = (html) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// ---------------------------------------------------------------------------
// 1. Models: the last-updated date follows the UI language
// ---------------------------------------------------------------------------
/**
 * Models.tsx transpiled with only its module-level dependencies stubbed: the
 * real import-free pure libs are used, the view itself is never rendered here.
 */
function loadModelsModule(globals) {
  const icon = () => null;
  const lucide = new Proxy({}, { get: () => icon });
  return evalModule('src/renderer/views/Models.tsx', '', (id) => {
    if (id === 'react') {
      return {
        useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
        useMemo: (f) => f(), useRef: (v) => ({ current: v }),
        useEffect: () => {}, useDeferredValue: (v) => v, createElement: () => null,
      };
    }
    if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') };
    if (id === 'lucide-react') return lucide;
    if (id === 'react-i18next') return { useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }) };
    if (id === '@tanstack/react-query') return { useQuery: () => ({}), useMutation: () => ({}), useQueryClient: () => ({}) };
    if (id === '../lib/api') return { api: {}, queryKeys: {} };
    if (id === '../lib/frontend-state') return { classifyDataState: () => 'success', safeError: (_e, f) => f };
    if (id === '../lib/models-filter') return evalModule('src/renderer/lib/models-filter.ts');
    if (id === '../lib/model-technical') return evalModule('src/renderer/lib/model-technical.ts');
    if (id === '../lib/gateway-lifecycle') return { useGatewayLifecycle: () => ({}) };
    if (id === '../stores/models') return { useModelsStore: () => ({}) };
    if (id === '../stores/config') return { useConfigStore: () => ({}) };
    if (id === '../components/ProviderGlyph') return { ProviderGlyph: () => null, resolveProvider: () => ({}) };
    if (id === 'react-router-dom') return { useLocation: () => ({ pathname: '/', state: null }), useNavigate: () => () => {} };
    if (id === '../pet/tips') return { focusPendingSetting: () => 'heading', focusSettingFrom: () => null };
    throw new Error(`unexpected import ${id} from Models.tsx`);
  }, globals);
}

test('Models: formatLastUpdated uses the ACTIVE locale, not the host one (ru != en)', () => {
  const { formatLastUpdated } = loadModelsModule();
  const old = '2020-03-05T12:00:00Z'; // > 1 year back -> the absolute-date branch
  const en = formatLastUpdated(old, 'en');
  const ru = formatLastUpdated(old, 'ru');

  // TZ-INDEPENDENT: `toLocaleDateString` formats in LOCAL time, so the calendar
  // day of this instant depends on the runner's zone (UTC+12 and beyond put it
  // on 3/6). The expected value is therefore derived from the SAME instant with
  // local getters instead of being hard-coded, and the locale's own format is
  // pinned structurally — the test still proves the UI language is honoured
  // (a host-locale fallback would make en and ru identical).
  const instant = new Date(old);
  const pad = (n) => String(n).padStart(2, '0');
  const localDay = `${instant.getMonth() + 1}/${instant.getDate()}/${instant.getFullYear()}`;
  const localDayRu = `${pad(instant.getDate())}.${pad(instant.getMonth() + 1)}.${instant.getFullYear()}`;

  assert.equal(en, localDay, 'en renders month/day/year for the LOCAL calendar day of the instant');
  assert.match(en, /^\d{1,2}\/\d{1,2}\/\d{4}$/, 'en keeps the M/D/YYYY shape');
  assert.equal(ru, localDayRu, 'ru renders day.month.year for the same instant');
  assert.match(ru, /^\d{2}\.\d{2}\.\d{4}$/, 'ru keeps the DD.MM.YYYY shape');
  assert.notEqual(en, ru, 'the date must actually follow the UI language');
  // Deterministic fallback: an unresolved language must not fall back to the
  // HOST locale (the defect), only to the i18n default.
  assert.equal(formatLastUpdated(old), en, 'no locale -> the i18n default (en)');
  assert.equal(formatLastUpdated(old, ''), en, 'empty locale -> the i18n default (en)');

  // The other branches are locale-independent and unchanged.
  const now = Date.now();
  assert.equal(formatLastUpdated(new Date(now - 5 * 864e5).toISOString(), 'ru'), '5d', 'recent dates stay relative');
  assert.equal(formatLastUpdated('not-a-date', 'ru'), 'not-a-date', 'unparseable input is passed through');
  assert.equal(formatLastUpdated(null, 'ru'), null);
  assert.equal(formatLastUpdated('', 'ru'), null);
});

test('Models: a malformed or unsupported locale tag falls back to en instead of throwing / using the host', () => {
  // ANTI-TAUTOLOGY. The old `formatLastUpdated(dateStr)` took ONE parameter, so
  // passing a locale to it was silently ignored and `toLocaleDateString()` never
  // saw the bad tag — the assertions below passed against the unfixed code and
  // proved nothing. The locale argument must therefore be observed ARRIVING at
  // the validation seam, not merely be survivable: `Intl.DateTimeFormat
  // .supportedLocalesOf` is spied, and a no-validation implementation (which
  // hands the raw tag straight to `toLocaleDateString`) fails the last two
  // assertions with RangeError / a raw tag recorded at the format call.
  const validated = [];
  const formatted = [];
  class SpyDate extends Date {
    toLocaleDateString(...args) {
      formatted.push(args[0]);
      return super.toLocaleDateString(...args);
    }
  }
  const IntlSpy = new Proxy(Intl, {
    get(target, key) {
      if (key !== 'DateTimeFormat') return Reflect.get(target, key);
      const Real = target.DateTimeFormat;
      return new Proxy(Real, {
        get(dtf, prop) {
          if (prop !== 'supportedLocalesOf') return Reflect.get(dtf, prop);
          return (locales, ...rest) => {
            for (const l of [].concat(locales)) validated.push(l);
            return Real.supportedLocalesOf(locales, ...rest);
          };
        },
      });
    },
  });

  const { formatLastUpdated } = loadModelsModule({ Date: SpyDate, Intl: IntlSpy });
  const old = '2020-03-05T12:00:00Z';
  const en = formatLastUpdated(old, 'en');
  const malformedTags = ['en_US', 'en US', 'not a locale', 'x', 'de-DE-'];
  // Malformed tags throw RangeError inside toLocaleDateString -> render crash.
  for (const malformed of malformedTags) {
    validated.length = 0;
    formatted.length = 0;
    assert.doesNotThrow(() => formatLastUpdated(old, malformed), `malformed tag ${JSON.stringify(malformed)} must not throw`);
    assert.equal(formatLastUpdated(old, malformed), en, `malformed tag ${JSON.stringify(malformed)} -> the i18n default (en)`);
    assert.ok(validated.includes(malformed),
      `malformed tag ${JSON.stringify(malformed)} must reach the validation seam (a one-parameter signature ignores it and this test would then be vacuous)`);
    assert.equal(formatted.at(-1), 'en',
      `malformed tag ${JSON.stringify(malformed)} must NOT be handed to toLocaleDateString; the validated 'en' must be, got ${JSON.stringify(formatted.at(-1))}`);
  }
  // Well-formed but unsupported: Intl silently ignores it and uses the HOST
  // locale (the original defect) unless the tag is validated first.
  validated.length = 0;
  formatted.length = 0;
  assert.equal(formatLastUpdated(old, 'xx-YY'), en, 'unsupported tag -> en, never the host locale');
  assert.deepEqual(validated, ['xx-YY'], 'the unsupported tag is what gets validated');
  assert.equal(formatted.at(-1), 'en', 'the unsupported tag never reaches toLocaleDateString');
  // A real regional tag still works — and it reaches the formatter unrewritten.
  validated.length = 0;
  formatted.length = 0;
  assert.match(formatLastUpdated(old, 'ru-RU'), /^\d{2}\.\d{2}\.\d{4}$/, 'supported regional tags keep working');
  assert.deepEqual(validated, ['ru-RU'], 'a supported tag is validated, not assumed');
  assert.equal(formatted.at(-1), 'ru-RU', 'a supported tag is passed through to the formatter');
});


test('Models: the card passes i18n.language into the formatter (source wiring)', () => {
  const src = read('src/renderer/views/Models.tsx');
  assert.match(src, /const \{ t, i18n \} = useTranslation\(\)/, 'the view takes the live i18n instance');
  assert.match(src, /formatLastUpdated\(model\.lastUpdated, i18n\.language\)/,
    'the card must hand the active language to the formatter');
  assert.doesNotMatch(src, /formatLastUpdated\(model\.lastUpdated\)/, 'the host-locale call is gone');
  assert.doesNotMatch(src, /toLocaleDateString\(\)/, 'no locale-less date formatting remains in the view');
});

/**
 * The SAME validation seam as the Models test above, for the two refresh clocks.
 *
 * WHY OUTPUT ALONE IS BLIND HERE: a catch-only clock with NO validation
 * (`try { toLocaleTimeString(locale) } catch { ... 'en' }`) behaves exactly like
 * the fixed one on an en-US host — a malformed tag throws and is caught, and a
 * well-formed but unsupported tag ('xx-YY') is resolved to the HOST locale,
 * which on en-US prints the same string as 'en'. So `formatRefreshTime(ts,
 * 'xx-YY') === formatRefreshTime(ts, 'en')` proves nothing there (it does fail on
 * this hy-AM host, which is why the gap was invisible in local runs but ships
 * green on windows-latest). The tag is therefore observed ARRIVING at
 * `Intl.DateTimeFormat.supportedLocalesOf` and never at `toLocaleTimeString`.
 */
function localeSeams() {
  const validated = [];
  const formatted = [];
  class SpyDate extends Date {
    toLocaleTimeString(...args) {
      formatted.push(args[0]);
      return super.toLocaleTimeString(...args);
    }
  }
  const IntlSpy = new Proxy(Intl, {
    get(target, key) {
      if (key !== 'DateTimeFormat') return Reflect.get(target, key);
      const Real = target.DateTimeFormat;
      return new Proxy(Real, {
        get(dtf, prop) {
          if (prop !== 'supportedLocalesOf') return Reflect.get(dtf, prop);
          return (locales, ...rest) => {
            for (const l of [].concat(locales)) validated.push(l);
            return Real.supportedLocalesOf(locales, ...rest);
          };
        },
      });
    },
  });
  return { validated, formatted, globals: { Date: SpyDate, Intl: IntlSpy } };
}

// ---------------------------------------------------------------------------
// 2. Settings: exactly one colon in the "last refresh" label, every locale
// ---------------------------------------------------------------------------
// Fixed instant so the rendered clock is reproducible; its LOCAL wall-clock time
// still depends on the runner's zone, which is why every expectation below is
// derived from the same Intl call rather than hard-coded.
const REFRESHED_AT = Date.UTC(2020, 2, 5, 9, 2, 19);

function renderModelsSection(locale, { lastRefreshed = REFRESHED_AT } = {}) {
  const state = { models: [], loading: false, error: null, lastRefreshed, setModels() {}, setLoading() {}, setError() {}, setLastRefreshed() {} };
  const useModelsStore = () => state;
  useModelsStore.getState = () => state;
  const stubs = {
    '@tanstack/react-query': {
      useQuery: () => ({ data: { models: [] }, isPending: false, isError: false, refetch() {} }),
      useMutation: () => ({ isPending: false, mutate() {} }),
      useQueryClient: () => ({}),
    },
    'react-router-dom': {},
    'react-i18next': { useTranslation: () => ({ t: translatorFor(locale), i18n: { language: locale } }) },
    '../lib/api': { api: { models() {} }, queryKeys: { models: ['models'], runtime: ['runtime'] } },
    '../stores/config': {},
    '../stores/models': { useModelsStore },
    '../lib/modal-context': {},
    '../pet/tips': {},
    '../components/InfoTip': { InfoTip: () => null },
    './requestDeadline': {},
  };
  const exp = evalModule('src/renderer/views/Settings.tsx', '\nmodule.exports.__ModelsSection = ModelsSection;',
    (id) => (id in stubs ? stubs[id] : require(id)));
  return renderToStaticMarkup(React.createElement(exp.__ModelsSection));
}

test('Settings: the last-refresh line adds no second colon in ANY locale', () => {
  for (const locale of LOCALES) {
    const label = resources[locale].last_refresh;
    assert.equal(typeof label, 'string');
    // The translation itself carries exactly one colon (ASCII or the zh full-width form).
    assert.equal((label.match(/[:：]/g) ?? []).length, 1, `${locale}.last_refresh must hold exactly one colon`);
    assert.match(label, /[:：]$/, `${locale}.last_refresh must END with the colon (the view supplies none)`);

    const html = renderModelsSection(locale);
    const line = [...html.matchAll(/<p class="text-xs text-textMuted">([\s\S]*?)<\/p>/g)].pop();
    assert.ok(line, `${locale}: the refresh line must render`);
    const text = textOf(line[1]);
    const time = new Date(REFRESHED_AT).toLocaleTimeString(locale);
    assert.ok(text.startsWith(`${label} `), `${locale}: label then a space then the time, got ${JSON.stringify(text)}`);
    assert.equal(text, `${label} ${time}`,
      `${locale}: label + space + a time formatted in the UI language (never the host's 12h/24h shape)`);

    // COUNT the colons in the rendered LABEL, not just its first two characters.
    // A `doesNotMatch` on `^label:` cannot fail here — `label` already ends with
    // the colon, so that pattern would need TWO colons to match and the
    // doubled-colon regression ("Last refresh::") would slip through.
    const labelPart = text.slice(0, text.length - time.length);
    assert.equal(labelPart, `${label} `, `${locale}: the label part is the translation plus one space`);
    assert.equal((labelPart.match(/[:：]/g) ?? []).length, 1,
      `${locale}: exactly one colon (ASCII or full-width) in the rendered label, got ${JSON.stringify(labelPart)}`);
    // And in the whole line: the label's one colon plus whatever the clock's own
    // separators need — no extra colon can hide between them.
    assert.equal((text.match(/[:：]/g) ?? []).length, 1 + (time.match(/[:：]/g) ?? []).length,
      `${locale}: the only colons outside the clock are the label's, got ${JSON.stringify(text)}`);
  }
  // Source-level (no jsdom needed to prove the literal is gone).
  assert.match(read('src/renderer/views/Settings.tsx'), /\{t\('last_refresh'\)\} \{formatRefreshTime\(lastRefreshed, i18n\.language\)\}/,
    'the JSX is label + space + the locale-aware time, with no literal colon');
  assert.doesNotMatch(read('src/renderer/views/Settings.tsx'), /toLocaleTimeString\(\)/,
    'no locale-less time formatting remains in the view');
});

test('Settings: the refresh clock follows the UI language, not the host (source + formatter)', () => {
  // 09:02:19Z: en/hi/ar use a 12-hour clock with a day-period marker, ru/zh/es/fr
  // a 24-hour one.
  //
  // The split is read from Intl's OWN resolved options, never from a rendered
  // day-period string. A `/[AP]M|pm|م/` scan of the formatted time was itself
  // timezone-dependent: `ar` renders its markers as ص/م, and 09:02:19Z is AM in
  // every zone west of ~UTC+5:30, so the AM half of the marker set never matched
  // and `ar` was dropped on UTC/Berlin/New York/Los Angeles hosts. hour12 is
  // metadata about the locale, so it is identical in all 10 zones (verified).
  const hour12 = LOCALES.filter((l) => new Intl.DateTimeFormat(l, { hour: 'numeric' }).resolvedOptions().hour12 === true);
  assert.deepEqual(hour12.sort(), ['ar', 'en', 'hi'], 'the fixture must actually exercise both clock styles');
  // Cross-check that the two families really differ in FORMAT, not just in that
  // flag: a 12h locale emits a dayPeriod part, a 24h locale emits none. Derived
  // from the same instant, so it holds in every zone and for every glyph set.
  const dayPeriods = (l) => new Intl.DateTimeFormat(l, { hour: 'numeric', minute: 'numeric' })
    .formatToParts(REFRESHED_AT).filter((p) => p.type === 'dayPeriod');
  for (const l of hour12) assert.ok(dayPeriods(l).length > 0, `${l}: a 12h locale must carry a day-period part`);
  for (const l of LOCALES.filter((x) => !hour12.includes(x))) {
    assert.equal(dayPeriods(l).length, 0, `${l}: a 24h locale must carry no day-period part`);
  }

  const seams = localeSeams();
  const { formatRefreshTime } = evalModule('src/renderer/views/Settings.tsx', '\nmodule.exports.__formatRefreshTime = formatRefreshTime;',
    (id) => (id === '@tanstack/react-query' ? { useQuery: () => ({}), useMutation: () => ({}), useQueryClient: () => ({}) }
      : id === 'react-router-dom' ? {}
      : id === 'react-i18next' ? { useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }) }
      : id === 'lucide-react' ? new Proxy({}, { get: () => () => null })
      : id === '../lib/api' ? { api: {}, queryKeys: {} }
      : id === '../stores/config' ? {}
      : id === '../stores/models' ? { useModelsStore: () => ({}) }
      : id === '../lib/modal-context' ? {}
      : id === '../pet/tips' ? {}
      : id === '../components/InfoTip' ? { InfoTip: () => null }
      : id === './requestDeadline' ? {}
      : require(id)), seams.globals);

  for (const locale of LOCALES) {
    assert.equal(formatRefreshTime(REFRESHED_AT, locale), new Date(REFRESHED_AT).toLocaleTimeString(locale),
      `${locale}: the clock uses the UI language`);
  }
  // The defect: a 12-hour UI language printed a 24-hour host time (and vice versa).
  assert.notEqual(formatRefreshTime(REFRESHED_AT, 'en'), formatRefreshTime(REFRESHED_AT, 'ru'),
    'en and ru must not render the same clock shape');
  // Fallbacks: unresolved, malformed and unsupported tags all resolve to en.
  const en = formatRefreshTime(REFRESHED_AT, 'en');
  seams.validated.length = 0;
  seams.formatted.length = 0;
  assert.equal(formatRefreshTime(REFRESHED_AT), en, 'no locale -> the i18n default (en)');
  assert.equal(formatRefreshTime(REFRESHED_AT, ''), en, 'empty locale -> the i18n default (en)');
  assert.equal(seams.formatted.at(-1), 'en',
    'an absent/empty locale still formats as en — never as the host default');
  for (const bad of ['en_US', 'en US', 'x']) {
    seams.validated.length = 0;
    seams.formatted.length = 0;
    assert.doesNotThrow(() => formatRefreshTime(REFRESHED_AT, bad), `malformed tag ${JSON.stringify(bad)} must not throw`);
    assert.equal(formatRefreshTime(REFRESHED_AT, bad), en, `malformed tag ${JSON.stringify(bad)} -> en`);
    // ANTI-TAUTOLOGY on an en-US host: a catch-only clock returns `en` here too,
    // so the OUTPUT proves nothing. The tag must be seen at the validation seam
    // and must never reach the formatter.
    assert.ok(seams.validated.includes(bad),
      `malformed tag ${JSON.stringify(bad)} must reach supportedLocalesOf (a no-validation clock never calls it)`);
    assert.equal(seams.formatted.at(-1), 'en',
      `malformed tag ${JSON.stringify(bad)} must NOT reach toLocaleTimeString, got ${JSON.stringify(seams.formatted.at(-1))}`);
  }
  seams.validated.length = 0;
  seams.formatted.length = 0;
  assert.equal(formatRefreshTime(REFRESHED_AT, 'xx-YY'), en, 'unsupported tag -> en, never the host locale');
  // The en-US blind spot: Intl ignores an unsupported tag and formats with the
  // HOST locale, which on an en-US host IS 'en' — so equality alone passes for a
  // clock that never validates. These two assertions fail there.
  assert.deepEqual(seams.validated, ['xx-YY'], 'the unsupported tag is what gets validated');
  assert.equal(seams.formatted.at(-1), 'en', 'the unsupported tag never reaches toLocaleTimeString');
  // A supported regional tag still works — and reaches the formatter unrewritten.
  seams.validated.length = 0;
  seams.formatted.length = 0;
  assert.equal(formatRefreshTime(REFRESHED_AT, 'ru-RU'), new Date(REFRESHED_AT).toLocaleTimeString('ru-RU'),
    'a supported regional tag keeps working');
  assert.deepEqual(seams.validated, ['ru-RU'], 'a supported tag is validated, not assumed');
  assert.equal(seams.formatted.at(-1), 'ru-RU', 'a supported tag is passed through to the formatter');
  // The single-colon contract is proven on the RENDERED line above (exactly one
  // colon in the label part, plus only the clock's own separators).
});

// ---------------------------------------------------------------------------
// 3. Endpoint: a failed credentials fetch has its own, accurate message
// ---------------------------------------------------------------------------
const pending = { data: undefined, isPending: true, isError: false, error: null, refetch() {} };
const failed = { data: undefined, isPending: false, isError: true, error: new Error('boom'), refetch() {} };
const ok = (data) => ({ data, isPending: false, isError: false, error: null, refetch() {} });

function renderEndpoint({ creds, keys = ok({ keys: [{}] }), models = ok({ models: [{ id: 'meta/llama', enabled: true }] }) }) {
  const byKey = { keys, models, 'gateway-credentials': creds };
  const stubs = {
    '@tanstack/react-query': { useQuery: ({ queryKey }) => byKey[queryKey[0]] },
    'react-i18next': { useTranslation: () => ({ t: (k, o) => (o && 'count' in o ? `${k}|${o.count}` : k) }) },
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

test('Endpoint: failed credentials show endpoint_creds_error, never the keys-list error', () => {
  const html = renderEndpoint({ creds: failed });
  assert.match(html, /role="alert"[^>]*>[\s\S]{0,120}?endpoint_creds_error/,
    'the credentials alert carries its own key');
  assert.doesNotMatch(html, /keys_error/, 'the keys-list wording must not describe a credentials failure');

  // The retry that refetches is still there, next to the accurate message.
  assert.match(html, /endpoint_creds_error[\s\S]{0,200}?retry/, 'the alert still offers Retry');

  // The keys CARD keeps its own (correct) message when the KEYS query fails.
  const keysFailed = renderEndpoint({ creds: ok({ port: 12000, gatewayToken: 'tok' }), keys: failed });
  assert.match(keysFailed, /title="keys_error"/, 'the keys card still reports a keys-list failure with keys_error');
  assert.doesNotMatch(keysFailed, /endpoint_creds_error/, 'no credentials error while credentials are fine');

  // Source-level: the branch uses the new key (no jsdom required to prove it).
  const src = read('src/renderer/views/Endpoint.tsx');
  assert.match(src, /credsFailed && \([\s\S]{0,300}?\{t\('endpoint_creds_error'\)\}/,
    'the credsFailed branch renders endpoint_creds_error');
  assert.match(src, /title=\{t\('keys_error'\)\}/, 'the keys card keeps keys_error');
});

test('i18n: endpoint_creds_error exists in all 7 locales, is accurate and never duplicates keys_error', () => {
  for (const locale of LOCALES) {
    const value = resources[locale].endpoint_creds_error;
    assert.equal(typeof value, 'string', `${locale}.endpoint_creds_error missing`);
    assert.ok(value.trim().length > 0, `${locale}.endpoint_creds_error must not be empty`);
    assert.doesNotMatch(value, /\{\{/, `${locale}: no interpolation`);
    assert.notEqual(value, resources[locale].keys_error, `${locale}: a credentials failure is not a keys-list failure`);
    // It must talk about the TOKEN (the thing that failed), not the key list.
    assert.match(value, /(token|токен|令牌|token|टोकन|jeton|رمز)/i, `${locale}: message names the token`);
  }
  // English source of truth, verbatim.
  assert.equal(resources.en.endpoint_creds_error, 'The gateway token could not be loaded.');
  // Parity: the new key moved every locale by exactly one.
  assert.equal(Object.keys(resources.en).length, EXPECTED_LOCALE_KEY_COUNT);
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(resources[locale]).sort(), Object.keys(resources.en).sort(), `${locale} parity`);
  }
});

// ---------------------------------------------------------------------------
// 3b. Logs: the same refresh clock follows the UI language
// ---------------------------------------------------------------------------
/**
 * Renders the real Logs view with react-dom/server. The stub `Date` returns a
 * FIXED host-locale string from the argument-less call, so an implementation
 * that formats without a locale renders exactly the host shape no matter which
 * zone the suite runs in — the leak is then observable, not hypothetical.
 */
function renderLogs({ uiLanguage, hostClock, seams = localeSeams() }) {
  const seen = [];
  // Extends the seam spy, so a render-time format call is recorded on BOTH
  // channels: `seen` (which locale the view handed over) and `seams.formatted`.
  class HostDate extends seams.globals.Date {
    toLocaleTimeString(...args) {
      seen.push(args.length === 0 ? '<host>' : args[0]);
      return args.length === 0 ? hostClock : super.toLocaleTimeString(...args);
    }
  }
  const stubs = {
    '@tanstack/react-query': {
      useQuery: () => ({ data: { logs: [] }, dataUpdatedAt: LOGS_REFRESHED_AT, error: null, isPending: false, isError: false, refetch() {} }),
    },
    'react-i18next': { useTranslation: () => ({ t: translatorFor(uiLanguage), i18n: { language: uiLanguage } }) },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    '../lib/gateway-lifecycle': { useGatewayLifecycle: () => ({ status: { state: 'running' } }) },
    '../lib/modal-context': {
      useModal: () => ({
        activeModal: null, activeModalRequest: null, beginModalRequest: () => 1, closeModal() {},
        isCurrentModalRequest: () => true, openFeedback() {}, openSendErrors: () => true,
      }),
    },
    '../lib/use-dialog-focus': { useDialogFocus() {} },
    'react-router-dom': { useLocation: () => ({ pathname: '/', state: null }), useNavigate: () => () => {} },
    '../pet/tips': { focusPendingSetting: () => 'heading', focusSettingFrom: () => null },
  };
  const exp = evalModule('src/renderer/views/Logs.tsx', '', (id) => {
    if (id in stubs) return stubs[id];
    if (id === '../lib/api') return { api: { logs: async () => ({ logs: [] }) }, queryKeys: { logs: ['logs'] } };
    if (id === '../lib/frontend-state') return evalModule('src/renderer/lib/frontend-state.ts');
    if (id === '../lib/frontend-behavior') return evalModule('src/renderer/lib/frontend-behavior.ts');
    if (id === '../lib/logs-format') return evalModule('src/renderer/lib/logs-format.ts');
    if (!id.startsWith('.')) return require(id);
    throw new Error(`unexpected import ${id} from Logs.tsx`);
  }, { Date: HostDate, Intl: seams.globals.Intl });  const html = renderToStaticMarkup(React.createElement(exp.Logs));
  const line = html.match(/<div class="text-xs text-textMuted mb-2">([\s\S]*?)<\/div>/);
  return { text: line ? textOf(line[1]) : null, seen, html, exp, seams };
}

const LOGS_REFRESHED_AT = Date.UTC(2020, 2, 5, 9, 2, 19);

test('Logs: a 12h HOST clock must not leak AM/PM into a 24h UI language, and vice versa', () => {
  const expected = (locale) => new Date(LOGS_REFRESHED_AT).toLocaleTimeString(locale);
  const label = resources.ru.last_refresh;

  // 1. Host clock is 12-hour ("11:02:19 PM"), UI language is 24-hour (ru).
  const ru = renderLogs({ uiLanguage: 'ru', hostClock: '11:02:19 PM' });
  assert.ok(ru.text, 'the refresh line must render');
  assert.equal(ru.text, `${label} ${expected('ru')}`, 'ru UI renders the ru clock, not the host one');
  assert.doesNotMatch(ru.text, /[AP]M|AM|PM/, 'a 12-hour host marker must not leak into a 24-hour UI language');
  assert.deepEqual(ru.seen, ['ru'], 'the UI language is what reaches toLocaleTimeString');

  // 2. The reverse: host clock is 24-hour ("23:02:19"), UI language is 12-hour (en).
  const en = renderLogs({ uiLanguage: 'en', hostClock: '23:02:19' });
  assert.equal(en.text, `${resources.en.last_refresh} ${expected('en')}`, 'en UI renders the en clock, not the host one');
  assert.match(en.text, /\d{1,2}:\d{2}:\d{2}\s*[AP]M/i, 'the 12-hour UI language keeps its day-period marker');
  assert.deepEqual(en.seen, ['en'], 'the UI language is what reaches toLocaleTimeString');

  // 3. The formatter itself, across every locale, plus its fallbacks.
  const { formatRefreshTime } = ru.exp;
  const { seams } = ru;
  for (const locale of LOCALES) {
    assert.equal(formatRefreshTime(LOGS_REFRESHED_AT, locale), expected(locale), `${locale}: the clock uses the UI language`);
  }
  const enTime = formatRefreshTime(LOGS_REFRESHED_AT, 'en');
  seams.validated.length = 0;
  seams.formatted.length = 0;
  assert.equal(formatRefreshTime(LOGS_REFRESHED_AT), enTime, 'no locale -> the i18n default (en)');
  assert.equal(formatRefreshTime(LOGS_REFRESHED_AT, ''), enTime, 'empty locale -> the i18n default (en)');
  assert.equal(seams.formatted.at(-1), 'en',
    'an absent/empty locale still formats as en — never as the host default');
  for (const bad of ['en_US', 'en US', 'x']) {
    seams.validated.length = 0;
    seams.formatted.length = 0;
    assert.doesNotThrow(() => formatRefreshTime(LOGS_REFRESHED_AT, bad), `malformed tag ${JSON.stringify(bad)} must not throw`);
    assert.equal(formatRefreshTime(LOGS_REFRESHED_AT, bad), enTime, `malformed tag ${JSON.stringify(bad)} -> en`);
    // ANTI-TAUTOLOGY, same seam as the Models test: on an en-US host a
    // catch-only clock also returns `en`, so only the seam observations can
    // tell a validated clock from one that hands the raw tag to Intl.
    assert.ok(seams.validated.includes(bad),
      `malformed tag ${JSON.stringify(bad)} must reach supportedLocalesOf (a no-validation clock never calls it)`);
    assert.equal(seams.formatted.at(-1), 'en',
      `malformed tag ${JSON.stringify(bad)} must NOT reach toLocaleTimeString, got ${JSON.stringify(seams.formatted.at(-1))}`);
  }
  seams.validated.length = 0;
  seams.formatted.length = 0;
  assert.equal(formatRefreshTime(LOGS_REFRESHED_AT, 'xx-YY'), enTime, 'unsupported tag -> en, never the host locale');
  // The en-US blind spot: Intl ignores an unsupported tag and formats with the
  // HOST locale, which on an en-US host IS 'en' — so equality alone passes for a
  // clock that never validates. These two assertions fail there.
  assert.deepEqual(seams.validated, ['xx-YY'], 'the unsupported tag is what gets validated');
  assert.equal(seams.formatted.at(-1), 'en', 'the unsupported tag never reaches toLocaleTimeString');

  // Source wiring: no locale-less formatting may remain in the view.
  const src = read('src/renderer/views/Logs.tsx');
  assert.match(src, /const \{ t, i18n \} = useTranslation\(\)/, 'the view takes the live i18n instance');
  assert.match(src, /\$\{t\('last_refresh'\)\} \$\{formatRefreshTime\(query\.dataUpdatedAt, i18n\.language\)\}/,
    'the refresh line hands the active language to the formatter');
  assert.doesNotMatch(src, /toLocaleTimeString\(\)/, 'no locale-less time formatting remains in Logs.tsx');
  // The sr-only live region must still carry ONLY feedback (frontend-defects
  // pins the same invariant from the other side).
  const live = src.match(/<p[^>]*aria-live="polite"[^>]*>\{feedback\}<\/p>/);
  assert.ok(live, 'the sr-only aria-live region still carries only feedback');
});

// ---------------------------------------------------------------------------
// 3c. The two refresh clocks are ONE behaviour (drift guard)
// ---------------------------------------------------------------------------
/**
 * Settings.tsx and Logs.tsx each carry a local formatRefreshTime. Extraction to
 * src/renderer/lib/refresh-time.ts was MEASURED to break three suites this pass
 * may not edit — their loaders throw on any new relative import from these views
 * (`unexpected import ../lib/refresh-time` in
 * tests/logs-send-errors-dialog-behavior.test.mjs, tests/modal-race-arbiter.test.mjs,
 * and `Cannot find module` in tests/endpoint-hint-settings-models-states.test.mjs),
 * so the sanctioned parity branch is taken: the two implementations must stay
 * byte-identical and must produce identical output for every input class.
 */
test('Settings and Logs keep ONE refresh-clock implementation (byte parity + behaviour parity)', () => {
  const bodyOf = (file) => {
    const src = read(file);
    const start = src.indexOf('export function formatRefreshTime(');
    assert.notEqual(start, -1, `${file} must define formatRefreshTime`);
    const end = src.indexOf('\n}\n', start);
    assert.notEqual(end, -1, `${file}: the function must close at column 0`);
    return src.slice(start, end + 3);
  };
  const settingsBody = bodyOf('src/renderer/views/Settings.tsx');
  const logsBody = bodyOf('src/renderer/views/Logs.tsx');
  assert.equal(logsBody, settingsBody,
    'the two clocks must be the same source text — any edit to one must be mirrored in the other');

  // Behaviour parity, not just text: both exports agree on every input class.
  const load = (file, stubs) => evalModule(file, '\nmodule.exports.__f = formatRefreshTime;', (id) => (id in stubs ? stubs[id] : require(id))).__f;
  const settingsF = load('src/renderer/views/Settings.tsx', {
    '@tanstack/react-query': { useQuery: () => ({}), useMutation: () => ({}), useQueryClient: () => ({}) },
    'react-router-dom': {},
    'react-i18next': { useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }) },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    '../lib/api': { api: {}, queryKeys: {} },
    '../stores/config': {},
    '../stores/models': { useModelsStore: () => ({}) },
    '../lib/modal-context': {},
    '../pet/tips': {},
    '../components/InfoTip': { InfoTip: () => null },
    './requestDeadline': {},
  });
  const logsF = load('src/renderer/views/Logs.tsx', {
    '@tanstack/react-query': { useQuery: () => ({}) },
    'react-i18next': { useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }) },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    '../lib/api': { api: {}, queryKeys: {} },
    '../lib/frontend-state': evalModule('src/renderer/lib/frontend-state.ts'),
    '../lib/frontend-behavior': evalModule('src/renderer/lib/frontend-behavior.ts'),
    '../lib/logs-format': evalModule('src/renderer/lib/logs-format.ts'),
    '../lib/gateway-lifecycle': { useGatewayLifecycle: () => ({}) },
    '../lib/modal-context': { useModal: () => ({}) },
    '../lib/use-dialog-focus': { useDialogFocus() {} },
    'react-router-dom': {},
    '../pet/tips': {},
  });
  for (const locale of [...LOCALES, undefined, '', 'xx-YY', 'en_US', 'en US', 'x', 'ru-RU']) {
    assert.equal(logsF(LOGS_REFRESHED_AT, locale), settingsF(LOGS_REFRESHED_AT, locale),
      `both views must format ${JSON.stringify(locale)} identically`);
  }
});

// ---------------------------------------------------------------------------
// 4. The earlier W4 fixes are untouched by this wave
// ---------------------------------------------------------------------------
test('W4 guards intact: placeholder refusal, per-snippet embedsToken, copy error path, no sub-AA text', () => {
  const endpoint = read('src/renderer/views/Endpoint.tsx');
  assert.match(endpoint, /if \(hasUnresolvedPlaceholder\(text, gatewayToken, \{ embedsToken \}\)\) \{/,
    'the copy guard still runs');
  assert.match(endpoint, /setCopyError\(t\('endpoint_copy_unresolved'\)\)/, 'the refusal still surfaces');
  assert.match(endpoint, /active\.embedsToken/, 'the snippet copy still uses the per-snippet flag');
  for (const file of ['src/renderer/views/Models.tsx', 'src/renderer/views/Endpoint.tsx', 'src/renderer/views/Settings.tsx']) {
    assert.doesNotMatch(read(file), /text-textMuted\/(?:50|60|70|80)\b/, `${file}: sub-AA muted text must stay gone`);
  }
});

// ---------------------------------------------------------------------------
// 5. CRF2-002: the noun in "{{count}} of {{total}} <noun>" agrees with {{total}}
// ---------------------------------------------------------------------------
test('CRF2-002: plural forms of the count-of-total keys keep the noun of {{total}} (real i18next)', async () => {
  const i18next = require('i18next');
  const inst = i18next.createInstance();
  await inst.init({
    resources: Object.fromEntries(LOCALES.map((l) => [l, { translation: resources[l] }])),
    lng: 'en', fallbackLng: 'en', interpolation: { escapeValue: false }, returnNull: false,
  });
  const KEYS = ['models_per_key', 'models_filter_results', 'models_quorum_active'];
  // A singular noun next to a plural total (total = 5) is the defect.
  const SINGULAR_NEXT_TO_TOTAL = {
    en: [/of 5 model\b/, /of 5 key\b/, /\/ 5 key\b/],
    ru: [/5 ключ(?:а)?(?!\S)/, /из 5 модели/, /Показана/],
    es: [/5 clave\b/, /5 modelo\b/],
    fr: [/clé sur 5/, /\/ 5 clé(?!s)/, /modèle sur 5/],
    hi: [/कुंजी /, /कुंजी$/, /दिखाया जा रहा है/],
    ar: [/واحد/, /نموذجين/, /مفتاحين/, /نماذج/],
  };
  for (const locale of ['en', 'ru', 'es', 'fr', 'hi', 'ar']) {
    for (const key of KEYS) {
      for (const count of [1, 2, 5]) {
        const out = inst.getFixedT(locale)(key, { count, total: 5 });
        const where = `${locale}:${key} count=${count}`;
        assert.notEqual(out, key, `${where}: must resolve to a translation`);
        assert.ok(out.includes(String(count)), `${where}: must show {{count}}: ${out}`);
        assert.ok(out.includes('5'), `${where}: must show {{total}}: ${out}`);
        assert.doesNotMatch(out, /\{\{/, `${where}: no unresolved placeholder: ${out}`);
        for (const bad of SINGULAR_NEXT_TO_TOTAL[locale]) {
          assert.doesNotMatch(out, bad, `${where}: singular noun next to plural total: ${out}`);
        }
        // Every form renders the same noun phrase as the general plural (_other).
        // ar models_per_key is outside CRF2-002 (its forms all carry {{count}}).
        if (!(locale === 'ar' && key === 'models_per_key')) {
          assert.equal(out, interpolate(resources[locale][`${key}_other`], { count, total: 5 }),
            `${where}: noun phrase must match the general plural form`);
        }
      }
    }
  }
});

test('CRF2-002b: every plural form of the total-bound keys is ONE phrase per locale', async () => {
  // The noun in these keys agrees with {{total}}, not {{count}}, so a correct
  // locale renders the same phrase for every count. Each locale writes its six
  // plural lines consecutively, so a run of _zero.._other lines is one locale.
  const src = fs.readFileSync(path.join(root, 'src/renderer/i18n/resources.ts'), 'utf8');
  const keys = ['models_per_key', 'models_filter_results', 'models_quorum_active'];
  const lineRe = /"(models_per_key|models_filter_results|models_quorum_active)_(zero|one|two|few|many|other)":\s*"([^"]*)"/;
  const groups = [];
  let current = null;
  for (const line of src.split('\n')) {
    const m = line.match(lineRe);
    if (!m) { current = null; continue; }
    if (!current || current.key !== m[1]) { current = { key: m[1], values: new Set() }; groups.push(current); }
    current.values.add(m[3]);
  }
  for (const g of groups) {
    assert.equal(g.values.size, 1, g.key + ' plural forms differ within one locale: ' + [...g.values].join(' | '));
  }
  for (const key of keys) {
    assert.ok(groups.filter((g) => g.key === key).length >= 4, key + ': expected plural blocks in at least 4 locales');
  }
});
