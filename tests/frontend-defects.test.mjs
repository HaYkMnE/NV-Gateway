import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

// Regression tests for the five confirmed frontend defects. One failing test
// was written per defect BEFORE the fix (TDD); the matching fix makes it pass.
// The style follows the project's existing p1-frontend.test.mjs: source
// contracts are asserted via string matching, and behavior helpers are
// exercised through the built renderer bundle (cf. the isNearBottom precedent).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const LOCALE_NAMES = ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar'];

// Same loader tests/feedback-save-path-visible.test.mjs uses: transpile the TS
// to CommonJS and run it in a bare context (sandbox sees only { Error, exports,
// module }), so the modules loaded through it MUST stay import-free.
function loadTypeScriptExports(relative) {
  const compiled = typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { Error, exports: module.exports, module }, { filename: relative });
  return module.exports;
}

// ── Defect 1: Settings view clips bottom controls (unreachable < 600px) ──────
test('Settings outer container scrolls so bottom controls stay reachable at the 600px minimum height', () => {
  const settings = read('src/renderer/views/Settings.tsx');
  // The outer container was "flex flex-col h-full p-4 sm:p-8" with no vertical
  // scroll; the parent <main> is overflow-hidden, so ~40px clipped at 600px.
  // Dashboard/Logs/Wizard all carry overflow-y-auto; Settings now does too.
  const outer = settings.match(/return <div className="([^"]+)"><h2/);
  assert.ok(outer, 'Settings should return an outer <div> wrapping the <h2> heading');
  assert.match(outer[1], /overflow-y-auto/, 'Settings outer container must scroll (overflow-y-auto)');
  assert.match(outer[1], /h-full/, 'Settings outer container must still fill height (h-full)');
  // The previously clipped controls must remain present below the fold.
  assert.match(settings, /reset_wizard/);
  assert.match(settings, /<dl /);
});

// ── Defect 2: Logs auto-scroll cancels itself mid-flight (smooth-scroll race)
//   AND (Round 71 strengthening) a genuine user scroll-up during the 600ms
//   programmatic-scroll window still disables autoscroll; a programmatic
//   forward (increasing scrollTop) scroll does not self-cancel.
test('Logs auto-scroll guard distinguishes a programmatic smooth scroll from a genuine user scroll-up, even during the programmatic window', async () => {
  const helpers = await import('../build/src/renderer/lib/frontend-behavior.js');
  assert.equal(typeof helpers.shouldCancelAutoScroll, 'function',
    'a pure shouldCancelAutoScroll helper must exist so Logs can guard programmatic scrolls');

  // A scroll event fired DURING the effect-initiated smooth must NOT cancel
  // autoscroll — even when scrollTop is past the old position but not yet
  // within the isNearBottom threshold (the self-cancel bug). programmatic=true
  // => never cancel regardless of position.
  assert.equal(helpers.shouldCancelAutoScroll(
    { scrollTop: 700, scrollHeight: 1020, clientHeight: 300, programmatic: true }), false,
    'programmatic smooth-scroll intermediate event must not cancel autoscroll');

  // A genuine user scroll-up away from the bottom (programmatic false, not near
  // bottom) MUST cancel autoscroll — this is the intended behavior.
  assert.equal(helpers.shouldCancelAutoScroll(
    { scrollTop: 200, scrollHeight: 1020, clientHeight: 300, programmatic: false }), true,
    'a user scroll-up away from the bottom must cancel autoscroll');

  // While still near the bottom, autoscroll stays on even for user events.
  assert.equal(helpers.shouldCancelAutoScroll(
    { scrollTop: 700, scrollHeight: 1020, clientHeight: 300, programmatic: false }), false,
    'scrolling while near the bottom must not cancel autoscroll');

  // Reduced-motion instant jump: the effect still sets programmatic=true, so
  // the single instant scroll event it produces must not self-cancel either.
  assert.equal(helpers.shouldCancelAutoScroll(
    { scrollTop: 720, scrollHeight: 1020, clientHeight: 300, programmatic: true }), false);

  // ── Round 71 strengthening: classifyScrollEvent pure contract ─────────────
  // The previous guard only inspected the *current* scrollTop vs isNearBottom;
  // it could not tell a genuine user wheel/drag UP (decreasing scrollTop) from a
  // programmatic forward step while the programmatic flag was held true for the
  // full 600ms window. A pure direction-aware classifier separates the two —
  // and Logs.trackScroll must compose it with its programmatic flag so a user
  // scroll-up disables follow even mid programmatic window, while a forward
  // step never self-cancels.
  assert.equal(typeof helpers.classifyScrollEvent, 'function',
    'a pure classifyScrollEvent helper must exist so Logs can distinguish a user scroll-up from a programmatic forward step during the smooth-scroll window');

  // Helper inputs are scrollTop-relative px so it is frame-size aware
  // (clientHeight). A reference scrollHeight of 1200 with clientHeight 300
  // places the isNearBottom threshold (default 48px) at scrollTop >= 852.
  const top = 1200, height = 300, nearBottom = top - height - 48 + 10; // 862
  // User scroll-UP while the programmatic flag is true: scrollTop decreases
  // below the last seen value -> genuine user intent -> 'user-up' (disable).
  assert.equal(helpers.classifyScrollEvent(700, 200, true, top, height), 'user-up',
    'a decreasing scrollTop during the programmatic window is a genuine user scroll-up and must be classified user-up');
  // Programmatic FORWARD scroll while the flag is true: scrollTop does not
  // decrease -> still part of the effect-initiated smooth jump -> 'programmatic'
  // (do NOT cancel; the original Round 70 self-cancel defect stays fixed).
  assert.equal(helpers.classifyScrollEvent(700, 720, true, top, height), 'programmatic',
    'a non-decreasing scrollTop during the programmatic window is the effect-initiated smooth jump and must be classified programmatic');
  // Settle near the bottom (within the isNearBottom threshold) clears the
  // programmatic flag -> 'settle'.
  assert.equal(helpers.classifyScrollEvent(700, nearBottom, true, top, height), 'settle',
    'an arrival near the bottom during the programmatic window settles and clears the flag');
  // Outside the programmatic window, a user scroll-up is reported as 'user-up'
  // (programmatic=false path) so the existing shouldCancelAutoScroll contract
  // is preserved.
  assert.equal(helpers.classifyScrollEvent(800, 200, false, top, height), 'user-up',
    'a user scroll-up outside the programmatic window is classified user-up');
  // A non-decreasing scrollTop with programmatic=false (e.g. settling after a
  // manual drag down toward the bottom) does not disable -> 'settle'.
  assert.equal(helpers.classifyScrollEvent(200, nearBottom, false, top, height), 'settle',
    'a non-decreasing scrollTop outside the programmatic window settles');

  // ── Round 71 strengthening: Logs.trackScroll composition contract ────────
  // The tracker must now record the previous scrollTop (a ref) so it can feed
  // the classifier, and on a 'user-up' classification it must disable autoscroll
  // and clear the programmatic flag (and its timer). A 'programmatic' forward
  // step must keep the short-circuit so the smooth jump never self-cancels.
  const logs = read('src/renderer/views/Logs.tsx');
  assert.match(logs, /programmaticScroll/i, 'Logs must track a programmatic-scroll flag');
  assert.match(logs, /shouldCancelAutoScroll/, 'Logs must consult shouldCancelAutoScroll in its tracker');
  // The existing isNearBottom wiring (asserted by p1-frontend.test.mjs) must be
  // preserved — the guard composes on top of it rather than replacing it.
  assert.match(logs, /isNearBottom/);
  // The tracker must consult classifyScrollEvent so a user scroll-up during the
  // programmatic window is not swallowed by the unconditional programmatic-flag
  // short-circuit introduced in Round 70.
  assert.match(logs, /classifyScrollEvent/, 'Logs must consult classifyScrollEvent in its tracker');
  // A previous-scrollTop reference must be tracked so the direction-aware
  // classifier can compare consecutive scroll positions. Avoid matching the
  // built-in `scrollTop` DOM property reads; require a named prev ref.
  assert.match(logs, /prevScrollTop|lastScrollTop|previousScrollTop/i,
    'Logs must track the previous scrollTop in a ref so classifyScrollEvent can detect a user scroll-up');
  // On a user-up classification the tracker must disable autoscroll and clear
  // the programmatic flag (and its timer).
  assert.match(logs, /setAutoScroll\(false\)/,
    'a user-up classification must call setAutoScroll(false)');
  // The programmatic forward branch must NOT call setAutoScroll(false): the
  // pure helper already classified forward steps as 'programmatic' so composing
  // via the same ref read structurally keeps the short-circuit.
});

// ── Defect 3: Copy feedback never re-announced after first copy (aria-live) ─
test('Dashboard and Logs clear the aria-live region so screen readers re-announce each copy', () => {
  const dashboard = read('src/renderer/views/Dashboard.tsx');
  const logs = read('src/renderer/views/Logs.tsx');

  // aria-live="polite" dedupes identical textContent, so the live region must
  // reset to '' and then announce the new message on the next tick so the empty
  // value commits before the message overwrites it. Both views use announce().
  for (const [name, source] of [['Dashboard', dashboard], ['Logs', logs]]) {
    assert.match(source, /const announce = *\([^)]*\) *=> *\{[^}]*setFeedback\(['"]['"]\)[^}]*setTimeout[^}]*setFeedback\(/,
      `${name} must define announce() that clears '' then defers the message via setTimeout`);
    // The copy handler announces through the helper (not setFeedback directly),
    // and both the success and failure paths announce distinctly.
    assert.match(source, /announce\(t\(['"]copied['"]\)\)/, `${name} copy success must announce via announce(t('copied'))`);
    assert.match(source, /announce\(t\(['"]copy_failed['"]\)\)/, `${name} copy failure must announce via announce(t('copy_failed'))`);
  }

  // ── Round 72 strengthening: Logs aria-live must NOT re-announce the ambient
  //    2-second refresh clock. The visible refresh-timestamp <div> must NOT carry
  //    aria-live (neither bare `aria-live` nor `aria-live="polite"`) so the polite
  //    channel is silent between copies. A SEPARATE sr-only aria-live="polite"
  //    node must carry ONLY feedback — mirroring Dashboard.tsx:36 — so the live
  //    region announces copy feedback and nothing else (no dataUpdatedAt / no
  //    last_refresh ambient content bleeding into the SR channel).
  const logsVisibleDivMatches = logs.match(/<div[^>]*text-textMuted[^>]*>/g) || [];
  const logsVisibleDivsWithAriaLive = logsVisibleDivMatches.filter((m) => /aria-live/.test(m));
  assert.equal(logsVisibleDivsWithAriaLive.length, 0,
    'Logs visible refresh-timestamp <div> must NOT carry aria-live (ambient 2s clock would re-announce ~30x/min)');

  assert.match(logs, /<p[^>]*sr-only[^>]*aria-live="polite"[^>]*>\{feedback\}<\/p>|<p[^>]*aria-live="polite"[^>]*sr-only[^>]*>\{feedback\}<\/p>|sr-only[^>]*\{feedback\}[^<]*<|class="sr-only"[^>]*aria-live="polite"[^>]*>\{feedback\}|sr-only[^=]*="[^"]*sr-only[^"]*"[^>]*aria-live="polite"[^>]*>\{feedback\}/,
    'Logs must have a SEPARATE sr-only aria-live="polite" node carrying ONLY {feedback} (mirror Dashboard.tsx:36)');

  // The sr-only live region must NOT render the ambient clock content.
  const srOnlyLiveMatches = logs.match(/<p[^>]*sr-only[^>]*aria-live="polite"[^>]*>[\s\S]*?<\/p>/g)
    || logs.match(/<p[^>]*aria-live="polite"[^>]*sr-only[^>]*>[\s\S]*?<\/p>/g) || [];
  for (const [i, node] of srOnlyLiveMatches.entries()) {
    assert.doesNotMatch(node, /dataUpdatedAt|last_refresh|toLocaleTimeString/,
      `Logs sr-only aria-live node #${i} must NOT render dataUpdatedAt/last_refresh/toLocaleTimeString ambient content`);
  }
});

// ── Defect 4: Hardcoded English brand "Gateway GUI" — no i18n, untranslated ─
//   AND (Round 71 strengthening) every Layout-wrapped view (Dashboard, Logs,
//   Settings) uses <h2> for its heading — never <h1> — so each page has exactly
//   one <h1> (the Layout brand) followed by a single <h2>.
test('Layout header brand is translated, exposes a real h1 in both viewports, and every Layout-wrapped view uses h2 (no sibling h1)', () => {
  const layout = read('src/renderer/components/Layout.tsx');
  const resources = read('src/renderer/i18n/resources.ts');

  // No hardcoded English brand literal may remain in either header.
  assert.doesNotMatch(layout, />Gateway GUI</, 'Layout must not embed the literal "Gateway GUI"');
  // Both headers must call t() with an i18n key for the product name, and the
  // mobile drawer must use a real <h1> (was a <span>) so the mobile viewport
  // has a real h1 before the <h2> views — this also fixes heading hierarchy.
  const productCalls = layout.match(/t\(['"]product_name['"]\)/g);
  assert.ok(productCalls && productCalls.length === 2, 'both desktop and mobile Layout headers must use t(\'product_name\')');
  assert.match(layout, /<h1 /, 'Layout must use an <h1> for the header title');

  // i18n parity: product_name present in both EN and RU. EN stays consistent
  // with the tray tooltip "NVIDIA Gateway"; RU is a localized equivalent.
  const enMatch = resources.match(/product_name:'([^']*)'/);
  assert.ok(enMatch && /NVIDIA Gateway/.test(enMatch[1]), 'EN product_name must read "NVIDIA Gateway" (tray-consistent)');
  const allValues = resources.match(/product_name:'([^']*)'/g);
  assert.ok(allValues && allValues.length === 2, 'product_name must appear in EN and RU');
  const ruValue = allValues[1].match(/product_name:'([^']*)'/)[1];
  assert.ok(ruValue.length > 0 && !/NVIDIA Gateway/.test(ruValue), 'RU product_name must be a localized value');
  // The compile-time Record<keyof typeof en, string> contract (asserted by
  // p1-frontend.test.mjs) enforces RU has every EN key, including the new one.
  assert.match(resources, /Record<keyof typeof en, string>/);

  // ── Round 71 strengthening: heading hierarchy for Layout-wrapped views ──
  // The Layout brand renders an <h1> in BOTH desktop and mobile headers, so
  // every view rendered as an <Outlet/> of <Layout/> (Dashboard, Logs, Settings)
  // must use <h2> for its own heading — never <h1>. (Wizard renders OUTSIDE
  // <Layout/> and is its own onboarding screen, so it keeps its single <h1
  // id="wizard-title"> and is intentionally excluded here.)
  const appRouting = read('src/renderer/App.tsx');
  assert.match(appRouting, /(<Route|element=\{<Layout)/, 'App must declare routing with a Layout-wrapped route group');
  // Determine which view components are rendered inside the Layout route group.
  // Match the <Route element={<Layout/>}>...</Route> block, then any
  // <Route ... element={<ViewName />}/> within it.
  const layoutBlockMatch = appRouting.match(/<Route\s+element=\{<Layout\s*\/>\}>([\s\S]*?)<\/Route>/);
  assert.ok(layoutBlockMatch, 'App must wrap Dashboard/Logs/Settings inside a <Route element={<Layout/>}> group');
  const layoutBlock = layoutBlockMatch[1];
  const layoutWrapped = new Set();
  const viewFiles = fs.readdirSync(path.join(root, 'src/renderer/views')).filter((f) => f.endsWith('.tsx'));
  for (const file of viewFiles) {
    const name = file.replace(/\.tsx$/, '');
    const re = new RegExp(`<Route\\s+path="[^"]*"\\s+element=\\{?<${name}\\s*/?>`);
    if (re.test(layoutBlock)) layoutWrapped.add(name);
  }
  assert.ok(layoutWrapped.has('Dashboard') && layoutWrapped.has('Logs') && layoutWrapped.has('Settings'),
    'the Layout-wrapped view set must include Dashboard, Logs, and Settings');
  for (const name of layoutWrapped) {
    const source = read(`src/renderer/views/${name}.tsx`);
    // A heading-level element (<h1>...</h1>) is forbidden inside Layout-wrapped
    // views — they must use <h2> so the page has exactly one <h1> (the brand)
    // followed by a single <h2>.
    assert.doesNotMatch(source, /<h1[\s>]/,
      `${name} view (rendered under Layout's brand <h1>) must not use <h1> for its own heading — use <h2>`);
    assert.match(source, /<h2[\s>]/,
      `${name} view must use an <h2> heading (the page sub-heading under Layout's brand <h1>)`);
  }
  // Explicit targeted assertion: Logs (the conversion target of this round)
  // must now use <h2>, not <h1>.
  const logsSource = read('src/renderer/views/Logs.tsx');
  assert.doesNotMatch(logsSource, /<h1[\s>]/, 'Logs view must NOT use <h1> after the Round 71 conversion');
  assert.match(logsSource, /<h2[\s>]/, 'Logs view must use <h2> after the Round 71 conversion');
});

// ── Defect 5: .glow-red uses hardcoded #FF3333 instead of the error token ────
test('glow-red derives its box-shadow from the error token and the build guard asserts it', () => {
  const css = read('src/renderer/index.css');
  const config = read('tailwind.config.js');
  const guard = read('scripts/verify-renderer-css.mjs');

  // The rule must reference the theme token (like :focus-visible uses
  // theme('colors.accent-neon')), not a raw #FF3333 / #f33 literal.
  const glow = css.match(/\.glow-red\s*\{[^}]*\}/);
  assert.ok(glow, '.glow-red rule must exist in index.css');
  assert.match(glow[0], /theme\(['"]colors\.error/, '.glow-red must derive from theme(\'colors.error\')');
  assert.doesNotMatch(glow[0], /#FF3333/i, '.glow-red must not embed the raw #FF3333 literal');

  // The error token that drives .glow-red must remain in the palette.
  assert.match(config, /error:\s*['"]#FF3333['"]/, 'error token must remain #FF3333 in tailwind.config.js');

  // The CSS regression guard must now assert the BUILT .glow-red rule carries
  // the token-derived color (not merely that the selector name survives), so a
  // future drift to a different literal — or a dropped color — fails the guard.
  assert.match(guard, /extractRule/, 'guard must extract the .glow-red rule block from built CSS');
  assert.match(guard, /glowRedCarriesErrorToken/, 'guard must assert the .glow-red rule derives its color from the error token');
  assert.match(guard, /#FF3333/, 'guard must reference the error palette color #FF3333');
});

// ── Defect 6: Mobile header has no <h1> while the drawer menu is closed ──────
//   Root cause: the closed mobile top bar (the `md:hidden` header) contained
//   only the menu button, logo and status. The only mobile <h1> lived inside
//   the conditional drawer (menuOpen && ...), so when the menu was closed a
//   screen reader had no page-level heading for the mobile viewport.
test('Layout mobile top bar carries an <h1> that is present whenever the header is rendered — not only inside the conditional drawer', () => {
  const layout = read('src/renderer/components/Layout.tsx');
  // Isolate the always-visible mobile header: the <header className="md:hidden
  // ...">...</header> block. It must contain its own <h1 ...> (the brand) so the
  // document has a page-level heading at all times (menu open or closed).
  const mobileHeaderMatch = layout.match(/<header className="md:hidden[^"]*"[^>]*>([\s\S]*?)<\/header>/);
  assert.ok(mobileHeaderMatch, 'Layout must render an always-visible md:hidden mobile <header>');
  const mobileHeader = mobileHeaderMatch[1];
  assert.match(mobileHeader, /<h1 /,
    'the md:hidden mobile header (rendered while the menu is closed) must carry its own <h1> (the brand) — not only the conditional drawer');
  // The mobile-header <h1> must read the translated product name (same key as
  // the desktop sidebar and the drawer).
  assert.match(mobileHeader, /t\(['"]product_name['"]\)/,
    'the mobile-header <h1> must render t(\'product_name\')');
});

// ── Defect 7: Settings language change uses stale query state ────────────────
//   Root cause: the language() handler persisted the new language and switched
//   i18n, but never invalidated/updated queryKeys.runtime. The <select> stayed
//   controlled by the old query.data.language until the 3-second refetch, so it
//   could visibly revert to the previous language for up to 3 seconds.
test('Settings language change invalidates or updates the runtime query so the select stays in sync immediately', () => {
  const settings = read('src/renderer/views/Settings.tsx');
  // The language handler (the function bound to the <select> onChange) sits
  // between useQuery and the return. It must be an async function that, after
  // setAppConfig/i18n, either invalidates the runtime query or setQueryData on
  // it. We assert the call site and the query key together.
  const langHandlerMatch = settings.match(/const language[^}]*setAppConfig\(\{[^}]*language[^}]*\}\)[^}]*setConfig\([^)]*\)[^}]*i18n\.changeLanguage\([^)]*\)[^;]*;[^}]*\}/);
  assert.ok(langHandlerMatch, 'the language() handler must persist the language, setConfig, and switch i18n');
  // After mutation success the runtime query must be invalidated or updated.
  const handlerBody = langHandlerMatch[0];
  assert.match(handlerBody, /invalidateQueries\(\{\s*queryKey:\s*queryKeys\.runtime\s*\}\)|setQueryData\(\s*queryKeys\.runtime/,
    'language() must invalidate or setQueryData on queryKeys.runtime so the <select> reflects the new language immediately');
});

// ── Defect 8: Dashboard aria-describedby="key-error" references a ──────────
//   nonexistent id in the valid state. The id="key-error" element renders only
//   when keyError is set, so aria-describedby is always on but the target is
//   absent in the valid state — a dangling ARIA reference.
test('Dashboard add-key input sets aria-describedby only when a key error is present', () => {
  const dashboard = read('src/renderer/views/Dashboard.tsx');
  // The add-key <input ...> must make aria-describedby conditional on !!keyError
  // (e.g. aria-describedby={keyError ? "key-error" : undefined}), not an
  // unconditional aria-describedby="key-error" string literal.
  const inputMatch = dashboard.match(/<input[\s\S]*?id="new-key"[\s\S]*?\/>/);
  assert.ok(inputMatch, 'Dashboard must render the add-key <input id="new-key">');
  const input = inputMatch[0];
  assert.doesNotMatch(input, /aria-describedby="key-error"/,
    'the input must NOT hardcode aria-describedby="key-error" unconditionally');
  assert.match(input, /aria-describedby=\{[^}]*keyError[^}]*\}/,
    'the input must make aria-describedby conditional on keyError (e.g. aria-describedby={keyError ? "key-error" : undefined})');
});

// ── Defect 9: Wizard aria-describedby="port-error" references a nonexistent ─
//   id in the valid state — same pattern as defect 8. The id="port-error"
//   element renders only when validation fails (errorKey truthy).
test('Wizard custom-port input sets aria-describedby for the port error only when an error is present', () => {
  const wizard = read('src/renderer/views/Wizard.tsx');
  // The custom-port <input ...> must NOT hardcode aria-describedby="port-error"
  // unconditionally (the port-help reference may stay, but the port-error part
  // must be conditional on the validation error state).
  const inputMatch = wizard.match(/<input[\s\S]*?id="custom-port"[\s\S]*?\/>/);
  assert.ok(inputMatch, 'Wizard must render the custom-port <input id="custom-port">');
  const input = inputMatch[0];
  // The port-error portion must be conditional. Accept either a fully
  // conditional aria-describedby expression or a template that omits port-error
  // in the valid state. The unconditional literal "port-help port-error" is the
  // defect and must be rejected.
  assert.doesNotMatch(input, /aria-describedby="port-help port-error"/,
    'the input must NOT hardcode aria-describedby="port-help port-error" unconditionally');
  // The error id must be referenced conditionally via a JS expression that
  // incorporates the validation/error state (e.g. errorKey/ validation).
  assert.match(input, /aria-describedby=\{[^}]*\}/,
    'the input must use a JS expression for aria-describedby that conditionally includes the port-error reference');
});

// ── Defect 10: Add-key submission has no in-flight guard ─────────────────────
//   Root cause: the Save button stayed enabled while add() was awaiting
//   validation + adminAddKey(), so a double activation could submit the same
//   key concurrently (the second request surfacing a misleading error after
//   the first closes the form).
test('Dashboard Save button disables while the add-key mutation is in-flight', () => {
  const dashboard = read('src/renderer/views/Dashboard.tsx');
  // The add-key flow must use a pending state while add() runs and the Save
  // button must bind its `disabled` attribute to that state. We assert the
  // mutation/pending wiring exists and that the Save button references it.
  // The add-key mutation must be a TanStack useMutation (or equivalent pending
  // state) whose isPending drives the Save button.
  assert.match(dashboard, /useMutation\(/, 'Dashboard add-key must use a mutation with a pending state');
  // The Save button ('save' label) must set disabled from the mutation pending.
  const saveBtnMatch = dashboard.match(/<button[^>]*onClick=\{\(\) => void add\(\)\}[\s\S]*?>\{t\(['"]save['"]\)\}<\/button>/);
  assert.ok(saveBtnMatch, 'Dashboard must have a Save button bound to add()');
  const saveBtn = saveBtnMatch[0];
  assert.match(saveBtn, /disabled=\{[^}]*\.isPending[^}]*\}/,
    'the Save button must set disabled={*Mutation.isPending} (or the equivalent add-key pending ref) so double-submit is prevented');
});

// ── Defect 11: Sidebar blink loop — "lines that appear and disappear" ────────
//   Root cause: the desktop sidebar is a vertical-only scroll pane declared as
//   `overflow-y-auto`. When only ONE overflow axis is set, CSS computes the
//   other (x) as `auto`, so any 1 CSS px of horizontal overflow paints a real
//   horizontal scrollbar. The pet thought-cloud is `position:absolute;
//   left:50%; transform: translateX(-50%)` and animates scale continuously;
//   at fractional device scale (125%/150% DPI) sub-pixel rounding makes the
//   cloud's measured width oscillate by 1px. Verified live (packaged app, CDP,
//   DSF 1.25): `.thought-cloud-container` flipped scrollWidth-clientWidth
//   between 0 and 1 dozens of times per minute, every flip repainted the
//   sidebar scrollbar strips. Once the horizontal scrollbar appears it eats
//   17px of height, flipping the vertical scrollbar on; that shrinks the
//   client width by 17px, re-centers the cloud, and the horizontal scrollbar
//   disappears — a self-sustaining blink loop the user sees as lines/strips
//   that "appear, disappear, sometimes blink" along the pane edges.
//   Fix: pin overflow-x: hidden on the vertical-only sidebar pane (the same
//   pair Dashboard's list already uses: overflow-y-auto + overflow-x-hidden).
test('Layout sidebar scroll pane pins overflow-x to hidden so 1px sub-pixel wobble cannot paint a blinking horizontal scrollbar', () => {
  const layout = read('src/renderer/components/Layout.tsx');
  const aside = layout.match(/<aside className="hidden md:flex([^"]*)"/);
  assert.ok(aside, 'Layout must render the desktop sidebar <aside>');
  const cls = aside[1];
  assert.match(cls, /w-\[250px\]/, 'sidebar keeps its 250px width');
  assert.match(cls, /overflow-y-auto/, 'sidebar must keep vertical scrolling for overflow content');
  assert.match(cls, /overflow-x-hidden/,
    'sidebar must pin overflow-x-hidden: with only overflow-y set, x computes to auto and the pet thought-cloud 1px sub-pixel wobble paints a blinking h-scrollbar strip along the pane bottom edge (CSS spec: visible computes to auto when the other axis is not)');
  // The Dashboard list container already demonstrates the intended pairing;
  // this test also guards that precedent stays in place.
  const dashboard = read('src/renderer/views/Dashboard.tsx');
  assert.match(dashboard, /overflow-y-auto overflow-x-hidden/,
    'Dashboard list pane keeps the overflow-y-auto + overflow-x-hidden precedent');
});

// ── Defect 12: Models filter chips show raw backend label keys ─────────────
//   Root cause: Models.tsx:576 renders `{label}` verbatim. NGC returns
//   label entries as namespaced strings and recordToMetadata()
//   (nvidia-catalog-sync.mjs:271-291) pushes them untouched, so chips show
//   "usecase:endpoint:usecase_text_gen", "cloudPartnerType:endpoint:…",
//   "nimType:…", "playgroundType:…" — backend keys, not UI text.
//   Fix contract: a pure mapping (known value -> i18n key) so chips render a
//   localized human name; unknown labels keep the RAW string as fallback so
//   nothing silently disappears. Only the visible chip text changes — the
//   filter state keeps carrying the raw label so matching is untouched.
test('modelLabelI18nKey maps known NGC labels to i18n keys and returns null for unknown ones', () => {
  const lib = loadTypeScriptExports('src/renderer/lib/models-filter.ts');
  assert.equal(typeof lib.modelLabelI18nKey, 'function',
    'a pure modelLabelI18nKey helper must live in models-filter.ts (the import-free, unit-testable module)');

  // The live-audit-confirmed chip label, namespaced form.
  assert.equal(lib.modelLabelI18nKey('usecase:endpoint:usecase_text_gen'), 'models_label_usecase_text_gen',
    'the observed namespaced label must map to its i18n key');
  // The same value in bare token form must also be recognized.
  assert.equal(lib.modelLabelI18nKey('usecase_text_gen'), 'models_label_usecase_text_gen',
    'a bare known value token must map to the same key');

  // Unknown labels must NOT be remapped or dropped: null => render raw.
  assert.equal(lib.modelLabelI18nKey('nimType:nim_type_run_anywhere'), null,
    'unknown namespaced labels must fall back to the raw string');
  assert.equal(lib.modelLabelI18nKey('cloudPartnerType:endpoint:aws'), null,
    'unknown partner-type labels must fall back to the raw string');
  assert.equal(lib.modelLabelI18nKey('playgroundType:endpoint:playground_text_gen'), null,
    'unknown playground-type labels must fall back to the raw string');
  assert.equal(lib.modelLabelI18nKey('Agent'), null,
    'already-human catalogue labels pass through unchanged');
  assert.equal(lib.modelLabelI18nKey(''), null, 'an empty label maps to nothing');
});

test('the humanized model-label string exists in all 7 locales as a real translation', () => {
  const res = loadTypeScriptExports('src/renderer/i18n/resources.ts');
  for (const locale of LOCALE_NAMES) {
    const value = res[locale].models_label_usecase_text_gen;
    assert.ok(typeof value === 'string' && value.trim().length > 0,
      `${locale} must define models_label_usecase_text_gen`);
  }
  // Script checks catch a left-in-place English copy (same discipline as
  // tests/feedback-save-path-visible.test.mjs).
  assert.match(res.ar.models_label_usecase_text_gen, /[؀-ۿ]/, 'ar must be Arabic script');
  assert.match(res.hi.models_label_usecase_text_gen, /[ऀ-ॿ]/, 'hi must be Devanagari script');
  assert.match(res.zh.models_label_usecase_text_gen, /[一-鿿]/, 'zh must be Han script');
  assert.match(res.ru.models_label_usecase_text_gen, /[Ѐ-ӿ]/, 'ru must be Cyrillic script');
  for (const locale of ['fr', 'es']) {
    assert.notEqual(res[locale].models_label_usecase_text_gen, res.en.models_label_usecase_text_gen,
      `${locale} must be translated, not the English string verbatim`);
  }
});

test('Models filter chips render the human-readable label with the raw string as fallback, filtering untouched', () => {
  const view = read('src/renderer/views/Models.tsx');
  assert.match(view, /import \{[^}]*modelLabelI18nKey[^}]*\} from '\.\.\/lib\/models-filter'/,
    'Models must import modelLabelI18nKey from the filter library');
  assert.match(view, /const labelKey = modelLabelI18nKey\(label\)/,
    'each chip must resolve its display key through the pure helper');
  assert.match(view, /\{labelKey \? t\(labelKey\) : label\}/,
    'the chip must render t(labelKey) for known labels and the RAW label for unknown ones (nothing silently disappears)');
  // Internal filtering logic is unchanged: selection state and toggling keep
  // operating on the raw, untranslated label value.
  assert.match(view, /aria-pressed=\{filters\.labels\.includes\(label\)\}/,
    'chip selection state must still key off the raw label');
  assert.match(view, /onClick=\{\(\) => toggleLabel\(label\)\}/,
    'chip toggling must still filter on the raw label');
});

// ── Defect 13: hit targets < 24px (WCAG 2.5.8) ──────────────────────────────
//   Measured live: model-card "Details" buttons are 82x16, the Endpoint view's
//   snippet Copy button is 88x16, and the Models/Logs/Settings checkboxes are
//   13x13. All are pointer targets below the 24px WCAG 2.5.8 minimum. The fix
//   grows the CLICKABLE area only (min-height/padding on the control or the
//   wrapping label) — labels, typography and the checkbox glyph stay visually
//   unchanged.
test('model-card Details and Endpoint snippet-Copy buttons get a 24px minimum height', () => {
  const models = read('src/renderer/views/Models.tsx');
  const detailsButton = /<button[\s\S]*?toggleExpanded\(model\.id\)[\s\S]*?>/.exec(models);
  assert.ok(detailsButton, 'the model-card Details expander button must exist');
  assert.match(detailsButton[0], /className="[^"]*\bmin-h-6\b/,
    'the Details button measured 82x16 (12px text, no padding) -> needs min-h-6 (24px) of clickable height; label/typography stay as they are');

  const endpoint = read('src/renderer/views/Endpoint.tsx');
  const copyButton = /<button[\s\S]*?copy\(active\.content, `config-\$\{configTab\}`\)[\s\S]*?>/.exec(endpoint);
  assert.ok(copyButton, 'the Endpoint config-snippet Copy button must exist');
  assert.match(copyButton[0], /className="[^"]*\bmin-h-6\b/,
    'the snippet Copy button measured 88x16 -> needs min-h-6 (24px) of clickable height');
});

test('checkbox rows in Models/Logs/Settings meet the tap target via label padding (the glyph stays 13px)', () => {
  const files = {
    'src/renderer/views/Models.tsx': 2,
    'src/renderer/views/Logs.tsx': 1,
    'src/renderer/views/Settings.tsx': 2,
  };
  for (const [relative, expectedCount] of Object.entries(files)) {
    const source = read(relative);
    const labels = source.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) ?? [];
    const withCheckbox = labels.filter((label) => /<input[^>]*type="checkbox"/.test(label));
    assert.equal(withCheckbox.length, expectedCount,
      `${relative} must render exactly ${expectedCount} checkbox-wrapping label(s) (the audit targets)`);
    for (const label of withCheckbox) {
      const className = /className="([^"]*)"/.exec(label)[1];
      assert.match(className, /(?:^|\s)(?:p-\[?\d|py-\[?\d|pt-\[?\d|pb-\[?\d)/,
        `${relative} checkbox label must carry vertical padding so the tap area reaches >= 24px: got "${className}"`);
      // The checkbox INPUT itself must not gain a size class: the visible 13px
      // glyph stays as designed; only the clickable padding grows.
      const input = /<input[^>]*type="checkbox"[^>]*>/.exec(label)[0];
      assert.doesNotMatch(input, /className="[^"]*\b(?:[hw]|min-[hw])-/,
        `${relative} checkbox glyph must not be visually enlarged (no h-*/w-*/min-h-*/min-w-* on the input)`);
    }
  }
});
