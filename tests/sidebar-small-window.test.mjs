// PET-SPEC 2026-10-26 §12 (small-window layout): the desktop <aside> no longer
// scrolls; brand+nav and the status footer are pinned structurally and only the
// pet region scrolls. Below 687 px of viewport (the `short` screen,
// max-height: 686px) the nav and the pet go compact.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const layout = read('src/renderer/components/Layout.tsx');
const css = read('src/renderer/pet/pet.css');
const tailwind = read('tailwind.config.js');
const widget = read('src/renderer/pet/PetWidget.tsx');

const SCROLLER = 'flex-1 min-h-0 flex flex-col overflow-y-auto overflow-x-hidden overscroll-contain';
const FOOTER = 'shrink-0 bg-bg p-5 pt-3 short:pt-2 short:pb-3 border-t border-border-soft';

/** The desktop sidebar markup only (the mobile drawer is a second <aside>). */
function desktopAside() {
  const start = layout.indexOf('<aside className="hidden md:flex');
  assert.ok(start >= 0, 'desktop <aside> present');
  const end = layout.indexOf('</aside>', start);
  return layout.slice(start, end);
}

/** Body of the `@media (max-height: 686px)` block in pet.css. */
function compactBlock() {
  const start = css.indexOf('@media (max-height: 686px) {');
  assert.ok(start >= 0, 'pet.css has the §12.3 @media (max-height: 686px) block');
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}' && (depth -= 1) === 0) return css.slice(start, i + 1);
  }
  throw new Error('unterminated compact block');
}
const rule = (body, sel) => body.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? null;

test('§12.2 aside clips (overflow-hidden) instead of scrolling', () => {
  const cls = layout.match(/<aside className="hidden md:flex([^"]*)"/)[1];
  assert.match(cls, /\bflex-col overflow-hidden$/);
  assert.doesNotMatch(cls, /overflow-y-auto/);
});

test('§12.2 brand + nav block is shrink-0 with compact spacing', () => {
  const aside = desktopAside();
  assert.match(aside, /<div className="shrink-0 p-5 pb-2 short:pt-3">/);
  assert.match(aside, /className="flex items-center gap-3 mb-4 short:mb-2"/);
  assert.match(layout, /<nav className="flex flex-col gap-1\.5 short:gap-1">/, 'nav gap 6 -> 4 px');
  assert.match(layout, /px-3\.5 py-2\.5 short:py-2 rounded-sm/, 'nav item 40 -> 36 px');
});

test('§12.2 the pet sits in the new scroller; the status footer is outside it', () => {
  const aside = desktopAside();
  const scroller = aside.indexOf(`<div className="${SCROLLER}">`);
  assert.ok(scroller >= 0, 'pet scroller with the §12 classes');
  const pet = aside.indexOf('<PetWidget onOpenDonation={openDonation} />');
  const footer = aside.indexOf(`<div className="${FOOTER}">`);
  assert.ok(footer >= 0, 'footer is shrink-0 bg-bg with a border-border-soft top hairline');
  assert.ok(scroller < pet && pet < footer, 'order: scroller > pet, then footer');
  // The scroller closes before the footer opens: count div depth between them.
  const between = aside.slice(scroller, footer);
  const opens = (between.match(/<div\b/g) ?? []).length;
  const closes = (between.match(/<\/div>/g) ?? []).length;
  assert.equal(opens, closes, 'the footer is a sibling of the scroller, not inside it');
  assert.match(aside, /<div className="px-5 my-auto py-2 short:py-1">/);
  const tail = aside.slice(footer);
  assert.match(tail, /<StatusDisplay/, 'status (Шлюз работает + port) lives in the footer');
  assert.match(tail, /openFeedback\(\)/, 'feedback button lives in the footer');
  assert.match(tail, /mt-3 short:mt-2 w-full[^"]*py-2 short:py-1\.5/);
  assert.match(tailwind, /'border-soft': '#2A322D'/, 'border-border-soft = #2A322D');
  assert.match(tailwind, /\bbg: '#060706'/);
});

test('§12.2 `short` variant = @media (max-height: 686px), and NOT an object screen', () => {
  assert.match(tailwind, /addVariant\('short',\s*'@media \(max-height: 686px\)'\)/);
  // An object entry in `screens` makes Tailwind 3.4 drop every min-*/max-*
  // variant, which silently killed Dashboard's min-[800px]:grid-cols-... rule.
  assert.doesNotMatch(tailwind, /screens:\s*\{[^}]*raw:/);
});

test('§12.3 compact pet sizes under the breakpoint; hint hidden', () => {
  const block = compactBlock();
  assert.match(rule(block, '.nv-pet-wrap .mascot-viewport'), /width:\s*130px;\s*height:\s*120px;/, 'viewBox 130x120 at scale 1.0');
  assert.match(rule(block, '.nv-pet-wrap .pet-hint'), /display:\s*none/);
  assert.match(rule(block, '.nv-pet-wrap .crt-screen'), /height:\s*90px/);
  assert.match(rule(block, '.nv-pet-wrap .pet-caption'), /margin-top:\s*4px/);
  assert.doesNotMatch(rule(block, '.nv-pet-wrap .pet-caption'), /height/, 'caption height stays 30 px');
  assert.match(rule(block, '.nv-pet-wrap .widget-btn'), /padding:\s*6px/);
  assert.match(rule(block, '.nv-pet-wrap .sidebar-widget-wrap'), /margin:\s*2px 0 0/);
  assert.match(rule(block, '.nv-pet-wrap .vip-badge'), /padding:\s*2px 8px;\s*margin-bottom:\s*2px/);
  // The full tier is untouched outside the query.
  assert.match(rule(css, '.nv-pet-wrap .mascot-viewport'), /width:\s*191px;\s*height:\s*176\.31px;/);
  // Artwork viewBox is 130x120 with the default preserveAspectRatio (xMidYMid
  // meet), so the 130x120 frame scales it uniformly.
  assert.match(widget, /<svg className="mascot-svg" viewBox="0 0 130 120" aria-hidden="true">/);
  assert.doesNotMatch(widget, /className="mascot-svg"[^>]*preserveAspectRatio/, 'no non-uniform override');
});

test('§12.2 attachPetAnchor binds to the pet scroller, not the clipping aside', () => {
  const compiled = typescript.transpileModule(widget, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, jsx: typescript.JsxEmit.React },
  }).outputText;
  const stubs = {
    react: { useCallback: (f) => f, useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], createElement: () => null },
    'react-i18next': { useTranslation: () => ({ t: (k) => k }) },
  };
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    module: mod, exports: mod.exports, console, Math, Number,
    window: { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } },
    require: (name) => stubs[name] ?? {},
  });
  const target = () => {
    const listeners = new Map();
    return { listeners, addEventListener: (t, fn) => listeners.set(t, fn), removeEventListener: (t) => listeners.delete(t) };
  };
  // DOM chain from Layout.tsx: aside(hidden) > scroller(auto) > gutter(visible) > pet root.
  const aside = { ...target(), overflowY: 'hidden', parentElement: null };
  const scroller = { ...target(), overflowY: 'auto', parentElement: aside };
  const gutter = { overflowY: 'visible', parentElement: scroller };
  const props = new Map();
  const rootEl = { style: { setProperty: (k, v) => props.set(k, v) }, parentElement: gutter };
  const button = { getBoundingClientRect: () => ({ top: 270, bottom: 448 }) };
  const win = { ...target(), getComputedStyle: (el) => ({ overflowY: el.overflowY }) };
  const cleanup = mod.exports.attachPetAnchor(rootEl, button, win);
  assert.ok(scroller.listeners.has('scroll'), 'scroll listener on the pet scroller');
  assert.ok(!aside.listeners.has('scroll'), 'no listener on the clipping aside');
  assert.equal(props.get('--pet-anchor-top'), '270px');
  cleanup();
  assert.ok(!scroller.listeners.has('scroll'), 'cleanup removes it');
});
