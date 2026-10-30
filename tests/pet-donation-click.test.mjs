// Regression (owner report 30.09): clicking the pet did nothing.
// PetWidget passed `onClick={onOpenDonation}`, so React's click event reached
// App.openDonation as its `request` argument; `request ?? beginModalRequest()`
// kept the event object, the ownership check failed and no modal opened
// (regressed in 46f5127 "session-isolated modals").
//
// No jsdom in this repo: App.tsx is transpiled and run with a minimal hooks
// shim (same approach as tests/modal-race-arbiter.test.mjs). The widget-btn
// onClick expression is lifted from PetWidget.tsx and invoked with an
// event-like object, exercising the real PetWidget -> Layout -> App wiring.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function compile(relative, source, stubs, globals = {}) {
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
      jsx: typescript.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  const module = { exports: {} };
  const dir = path.posix.dirname(relative);
  const localRequire = (id) => {
    if (id in stubs) return stubs[id];
    if (id.startsWith('.')) {
      const resolved = path.posix.normalize(path.posix.join(dir, id));
      if (resolved in stubs) return stubs[resolved];
    }
    throw new Error(`unexpected import ${id} from ${relative}`);
  };
  vm.runInNewContext(compiled.outputText, {
    module, exports: module.exports, require: localRequire,
    console, Error, Promise, Date, setTimeout, clearTimeout,
    ...globals,
  }, { filename: relative });
  return module.exports;
}

function jsx(type, props) { return { type, props: props ?? {} }; }
function findNode(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findNode(child, predicate); if (hit) return hit; }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  if (predicate(node)) return node;
  return findNode(node.props?.children, predicate);
}

function createHooks() {
  const slots = [];
  let cursor = 0;
  let pendingEffects = [];
  const sameDeps = (a, b) => Boolean(a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
  const react = {
    memo: (component) => component,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (next) => {
        slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;
      }];
    },
    useReducer(reducer, initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: initial };
      return [slots[index].value, (action) => { slots[index].value = reducer(slots[index].value, action); }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!(index in slots) || !sameDeps(slots[index].deps, deps)) slots[index] = { value: factory(), deps };
      return slots[index].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(setup, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || !sameDeps(previous.deps, deps)) pendingEffects.push({ index, setup, deps });
    },
  };
  return {
    react,
    begin() { cursor = 0; pendingEffects = []; },
    commit() {
      for (const effect of pendingEffects) {
        slots[effect.index]?.cleanup?.();
        const cleanup = effect.setup();
        slots[effect.index] = { deps: effect.deps, cleanup };
      }
      pendingEffects = [];
    },
  };
}

function makeApp() {
  const hooks = createHooks();
  const ModalProvider = Symbol('ModalProvider');
  const DonationModal = Symbol('DonationModal');
  const inert = () => null;
  const fakeWindow = {
    electronAPI: {
      getRuntimeState: async () => ({ language: 'en' }),
      onNavigateAbout() { return () => {}; },
      onNavigateFeedback() { return () => {}; },
      errorReport: { log() {} },
    },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  };
  class QueryClient { setQueryData() {} }
  const stubs = {
    react: hooks.react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol('Fragment') },
    'react-i18next': { useTranslation: () => ({ t: (key) => key }) },
    'react-router-dom': { HashRouter: inert, Routes: inert, Route: inert, Navigate: inert },
    '@tanstack/react-query': { QueryClient, QueryClientProvider: inert },
    'src/renderer/views/Wizard': { Wizard: inert },
    'src/renderer/views/Dashboard': { Dashboard: inert },
    'src/renderer/views/Logs': { Logs: inert },
    'src/renderer/views/Settings': { Settings: inert },
    'src/renderer/views/Models': { Models: inert },
    'src/renderer/views/Endpoint': { Endpoint: inert },
    'src/renderer/components/Layout': { Layout: inert },
    'src/renderer/components/FeedbackModal': { FeedbackModal: Symbol('FeedbackModal') },
    'src/renderer/components/AboutDialog': { AboutDialog: Symbol('AboutDialog') },
    'src/renderer/pet/DonationModal': { DonationModal },
    'src/renderer/lib/modal-context': { ModalContext: { Provider: ModalProvider } },
    'src/renderer/stores/config': { useConfigStore: () => ({ hydrated: true, setupComplete: true, hydrate() {} }) },
    'src/renderer/i18n/config': { applyStoredLanguage: async () => {} },
    'src/renderer/lib/frontend-behavior': { reduceHydration: (state, action) => action.type === 'resolve' ? { state: 'ready' } : state },
    'src/renderer/lib/api': { queryKeys: { runtime: ['runtime'] } },
  };
  const App = compile('src/renderer/App.tsx', read('src/renderer/App.tsx'), stubs, {
    window: fakeWindow, document: {}, Event: class Event { constructor(type) { this.type = type; } },
  }).default;
  let tree;
  const render = () => { hooks.begin(); tree = App(); hooks.commit(); return tree; };
  render();
  return {
    render,
    modal: () => findNode(tree, (n) => n.type === ModalProvider).props.value,
    donation: () => findNode(tree, (n) => n.type === DonationModal)?.props,
  };
}

// Lift the real `.widget-btn` onClick expression out of PetWidget.tsx and bind
// it to the prop the component receives (Layout passes `openDonation`).
function widgetButtonOnClick(onOpenDonation) {
  const source = read('src/renderer/pet/PetWidget.tsx');
  const match = source.match(/className="widget-btn"\s*onClick=\{([^\n]+)\}\s*\n/);
  assert.ok(match, 'widget-btn onClick not found in PetWidget.tsx');
  const expr = typescript.transpileModule(`(${match[1]})`, {
    compilerOptions: { target: typescript.ScriptTarget.ES2020 },
  }).outputText;
  return vm.runInNewContext(`(onOpenDonation) => ${expr}`)(onOpenDonation);
}

const clickEvent = () => ({ type: 'click', target: {}, currentTarget: {}, preventDefault() {}, stopPropagation() {} });

test('Layout wires PetWidget onOpenDonation to the modal-context openDonation', () => {
  assert.match(read('src/renderer/components/Layout.tsx'), /<PetWidget onOpenDonation=\{openDonation\} \/>/);
});

// The real createClickJoy from PetWidget.tsx (PET-SPEC 2026-10-26 §3.1: the click
// runs a 700 ms joy, THEN opens the modal), run with a fake timer queue.
function loadClickJoy() {
  const compiled = typescript.transpileModule(read('src/renderer/pet/PetWidget.tsx'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, jsx: typescript.JsxEmit.React },
  }).outputText;
  const stubs = {
    react: {}, 'react-i18next': {}, '@tanstack/react-query': {}, 'react-router-dom': {}, 'lucide-react': {},
    '../lib/api': {}, '../lib/modal-context': {}, './tips': {}, './pet.css': {}, './audioEngine': { petAudio: {} }, './petEngine': {},
  };
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    module: mod, exports: mod.exports, console, performance, Math, Number,
    window: { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
    require: (id) => { if (id in stubs) return stubs[id]; throw new Error(`unexpected require: ${id}`); },
  }, { filename: 'src/renderer/pet/PetWidget.tsx' });
  return mod.exports;
}

test('clicking the pet widget button (with a React event) opens the donation dialog', () => {
  const app = makeApp();
  assert.equal(app.donation().open, false);
  // PET-SPEC 2026-10-26 §3.1/§9.2: onClick={startJoy}; startJoy calls
  // joyRef.current?.click() with no arguments, and the joy's open() calls
  // onOpenDonation() with no arguments after CLICK_JOY_MS.
  const src = read('src/renderer/pet/PetWidget.tsx');
  assert.match(src, /const startJoy = useCallback\(\(\): void => \{\s*joyRef\.current\?\.click\(\);\s*\}, \[\]\);/);
  assert.match(src, /open: \(\) => onOpenDonationRef\.current\(\),/);
  const { createClickJoy, CLICK_JOY_MS } = loadClickJoy();
  const timers = [];
  const joy = createClickJoy({
    open: () => app.modal().openDonation(),
    reducedMotion: () => false,
    canOpen: () => true,
    onStart() {}, onEnd() {},
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer() {},
  });
  const startJoy = () => joy.click(); // the click event is never forwarded
  startJoy(clickEvent());
  app.render();
  assert.equal(app.donation().open, false, 'the modal waits for the joy');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, CLICK_JOY_MS);
  assert.equal(CLICK_JOY_MS, 700);
  timers[0].fn();
  app.render();
  assert.equal(app.donation().open, true, 'donation modal must open on pet click');
  assert.equal(typeof app.donation().session, 'number');
});

test('every modal opener ignores a non-number first argument (event objects)', () => {
  for (const [opener, modal] of [['openDonation', 'donation'], ['openFeedback', 'feedback'], ['openAbout', 'about'], ['openSendErrors', 'send-errors']]) {
    const app = makeApp();
    assert.equal(app.modal()[opener](clickEvent()), true, `${opener}(event) must open`);
    app.render();
    assert.equal(app.modal().activeModal, modal);
    assert.equal(typeof app.modal().activeModalRequest, 'number');
  }
});

test('an explicit stale numeric request is still rejected', () => {
  const app = makeApp();
  const stale = app.modal().beginModalRequest();
  app.modal().beginModalRequest();
  assert.equal(app.modal().openDonation(stale), false);
});

test('source pin: PetWidget does not pass the click event into onOpenDonation', () => {
  const source = read('src/renderer/pet/PetWidget.tsx');
  assert.doesNotMatch(source, /onClick=\{onOpenDonation\}/);
  // PET-SPEC 2026-10-26 §3.1/§9.2: was onClick={() => onOpenDonation()}; now the
  // joy runs first and the delayed open still passes no argument.
  assert.match(source, /onClick=\{startJoy\}/);
  assert.match(source, /open: \(\) => onOpenDonationRef\.current\(\),/);
});
