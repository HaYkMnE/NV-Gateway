// PET-SPEC 2026-10-26 §11 (layout fixes): the speech-slot anchor
// (attachPetAnchor writes --pet-anchor-top/-bottom and cleans up every
// listener/observer), the fixed tip card and thought bubble values, the RTL
// mirror and the donation hint line.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const css = read('src/renderer/pet/pet.css');
const src = read('src/renderer/pet/PetWidget.tsx');

function loadAnchor() {
  const compiled = typescript.transpileModule(src, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, jsx: typescript.JsxEmit.React },
  }).outputText;
  const stubs = {
    react: { useCallback: (f) => f, useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}], createElement: () => null },
    'react-i18next': { useTranslation: () => ({ t: (k) => k }) },
    '@tanstack/react-query': { useQuery: () => ({}), useQueryClient: () => ({}) },
    'react-router-dom': { useLocation: () => ({ pathname: '/' }), useNavigate: () => () => {} },
    'lucide-react': {},
    '../lib/api': { api: {}, queryKeys: {} },
    '../lib/modal-context': { useModal: () => ({ activeModal: null }) },
    './tips': {}, './pet.css': {}, './audioEngine': { petAudio: {} }, './petEngine': { createPetEngine: () => ({}) },
  };
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    module: mod, exports: mod.exports, console, Math, Number,
    window: { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } },
    require: (name) => stubs[name] ?? {},
  });
  return mod.exports.attachPetAnchor;
}

function fakeTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, fn, opts) { listeners.set(type, { fn, opts }); },
    removeEventListener(type, fn) { if (listeners.get(type)?.fn === fn) listeners.delete(type); },
  };
}

function setup() {
  const props = new Map();
  let rect = { top: 320, bottom: 588 };
  const sidebar = { ...fakeTarget(), overflowY: 'auto', parentElement: null };
  const rootEl = { style: { setProperty: (k, v) => props.set(k, v) }, parentElement: { overflowY: 'visible', parentElement: sidebar } };
  const button = { getBoundingClientRect: () => rect };
  const observers = [];
  const win = {
    ...fakeTarget(),
    getComputedStyle: (el) => ({ overflowY: el.overflowY }),
    ResizeObserver: class { constructor(cb) { this.cb = cb; this.observed = []; this.disconnected = false; observers.push(this); } observe(el) { this.observed.push(el); } disconnect() { this.disconnected = true; } },
  };
  return { props, sidebar, rootEl, button, win, observers, move: (r) => { rect = r; } };
}

test('§11.2 attachPetAnchor writes both anchor vars now and on resize / sidebar scroll / ResizeObserver', () => {
  const attachPetAnchor = loadAnchor();
  const s = setup();
  const cleanup = attachPetAnchor(s.rootEl, s.button, s.win);
  assert.equal(s.props.get('--pet-anchor-top'), '320px');
  assert.equal(s.props.get('--pet-anchor-bottom'), '588px');
  s.move({ top: 100, bottom: 368 });
  s.win.listeners.get('resize').fn();
  assert.equal(s.props.get('--pet-anchor-top'), '100px');
  s.move({ top: 50, bottom: 318 });
  assert.equal(s.sidebar.listeners.get('scroll').opts.passive, true, 'scroll listener is passive');
  s.sidebar.listeners.get('scroll').fn();
  assert.equal(s.props.get('--pet-anchor-bottom'), '318px');
  assert.equal(s.observers.length, 1);
  assert.deepEqual(s.observers[0].observed, [s.button]);
  s.move({ top: 7, bottom: 9 });
  s.observers[0].cb();
  assert.equal(s.props.get('--pet-anchor-top'), '7px');
  cleanup();
});

test('§11.2 cleanup (unmount / hide) removes every listener and the observer', () => {
  const attachPetAnchor = loadAnchor();
  const s = setup();
  const cleanup = attachPetAnchor(s.rootEl, s.button, s.win);
  assert.equal(s.win.listeners.size, 1);
  assert.equal(s.sidebar.listeners.size, 1);
  cleanup();
  assert.equal(s.win.listeners.size, 0, 'window resize removed');
  assert.equal(s.sidebar.listeners.size, 0, 'sidebar scroll removed');
  assert.equal(s.observers[0].disconnected, true, 'ResizeObserver disconnected');
  assert.equal(typeof attachPetAnchor(null, s.button, s.win), 'function', 'no root: no-op cleanup');
});

test('§11.2 PetWidget attaches the anchor only while speaking and returns the cleanup', () => {
  assert.match(src, /const speaking = thought !== null \|\| \(selected !== null && eventShown\) \|\| randomTip !== null;/);
  assert.match(src, /if \(!speaking\) return undefined;\s*const cleanup = attachPetAnchor\(rootRef\.current, widgetBtnRef\.current, window\);\s*return cleanup;\s*\}, \[speaking, speechKey\]\);/);
  // Gate fix: the anchor is measured in a layout effect (before paint), never a passive useEffect.
  assert.match(src, /useLayoutEffect\(\(\) => \{\s*if \(!speaking\) return undefined;\s*const cleanup = attachPetAnchor\(/, 'anchor effect is a layout effect');
  assert.doesNotMatch(src, /useEffect\(\(\) => \{\s*if \(!speaking\) return undefined;/, 'no passive anchor effect left');
  assert.match(src, /ref=\{rootRef\}\s*className=\{`nv-pet-wrap/);
  assert.match(src, /root\.style\.setProperty\('--pet-anchor-top'/);
  assert.match(src, /root\.style\.setProperty\('--pet-anchor-bottom'/);
});

const rule = (sel) => {
  const re = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = re.exec(css);
  assert.ok(m, `missing rule ${sel}`);
  return m[2];
};

test('§11.3 tip card CSS values', () => {
  const card = rule('.advice-card');
  for (const decl of ['position: fixed', 'inset-inline-start: 258px', 'inset-block-end: max(16px, calc(100vh - var(--pet-anchor-bottom, 100vh)))',
    'inline-size: 300px', 'max-inline-size: calc(100vw - 258px - 16px)', 'max-block-size: calc(100vh - 32px)', 'overflow-y: auto',
    'overscroll-behavior: contain', 'margin: 0', 'z-index: 40', 'box-shadow: 0 1px 2px rgb(0 0 0 / 0.24), 0 8px 24px rgb(0 0 0 / 0.32)']) {
    assert.ok(card.includes(decl), `.advice-card ${decl}`);
  }
  assert.doesNotMatch(card, /margin-inline: -10px|calc\(100% \+ 20px\)|max-inline-size: 230px|margin-block-start/);
  assert.doesNotMatch(css, /\.advice-card\[data-hint\] \{[^}]*position: relative/, 'reduced-motion rule must not undo position: fixed');
});

test('§11.4 thought bubble CSS values and RTL mirror', () => {
  const box = rule('.nv-pet-wrap .thought-cloud-container');
  for (const decl of ['position: fixed', 'inset-inline-start: 262px',
    'inset-block-start: clamp(8px, calc(var(--pet-anchor-top, 304px) + 16px), calc(100vh - 64px))', 'bottom: auto',
    'inline-size: max-content', 'max-inline-size: 240px', 'flex-direction: row', 'align-items: center',
    'transform: translateX(-4px) scale(0.92)', 'transform-origin: left center', 'z-index: 41', 'pointer-events: none']) {
    assert.ok(box.includes(decl), `.thought-cloud-container ${decl}`);
  }
  assert.doesNotMatch(box, /(^|[\s;])left:|(^|[\s;])right:|230px/, 'no physical left/right, no 230px');
  assert.ok(rule('.nv-pet-wrap .thought-cloud-container.show').includes('transform: translateX(0) scale(1)'));
  assert.ok(rule('.nv-pet-wrap.vip-mode .thought-cloud-container').includes('bottom: auto'));
  const trail = rule('.nv-pet-wrap .thought-trail');
  for (const decl of ['order: -1', 'flex-direction: row-reverse', 'gap: 3px', 'margin: 0', 'margin-inline-end: 4px']) {
    assert.ok(trail.includes(decl), `.thought-trail ${decl}`);
  }
  assert.ok(rule('.nv-pet-wrap .thought-cloud-bubble').includes('max-inline-size: 220px'));
  const rtl = rule('[dir="rtl"] .nv-pet-wrap .thought-cloud-container');
  assert.ok(rtl.includes('transform-origin: right center') && rtl.includes('transform: translateX(4px) scale(0.92)'), 'RTL mirrored');
  assert.ok(rule('[dir="rtl"] .nv-pet-wrap .thought-cloud-container.show').includes('transform: translateX(0) scale(1)'));
});

test('§11.5 donation hint line', () => {
  const hint = rule('.nv-pet-wrap .pet-hint');
  for (const decl of ['font-size: 11px', 'line-height: 14px', 'font-weight: 400', 'letter-spacing: 0.2px', 'color: #7A8CA0']) {
    assert.ok(hint.includes(decl), `.pet-hint ${decl}`);
  }
  assert.match(src, /<Heart size=\{11\} aria-hidden="true" \/>/);
});
