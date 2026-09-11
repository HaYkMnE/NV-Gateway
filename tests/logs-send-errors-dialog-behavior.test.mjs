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
    module,
    exports: module.exports,
    require: localRequire,
    console,
    Error,
    Promise,
    setTimeout,
    clearTimeout,
    ...globals,
  }, { filename: relative });
  return module.exports;
}

function jsx(type, props) {
  return { type, props: props ?? {} };
}

function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  visit(node);
  walk(node.props?.children, visit);
}

function findNode(tree, predicate) {
  let found;
  walk(tree, (node) => {
    if (found === undefined && predicate(node)) found = node;
  });
  return found;
}

function makeElement(name, document) {
  return {
    name,
    connected: true,
    focus() { document.activeElement = this; },
  };
}

function makeDocument() {
  const listeners = new Map();
  const document = {
    activeElement: null,
    addEventListener(type, listener) {
      const bucket = listeners.get(type) ?? new Set();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    contains(element) { return Boolean(element?.connected); },
    dispatchKey(key, shiftKey = false) {
      const event = {
        key,
        shiftKey,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
      };
      for (const listener of [...(listeners.get('keydown') ?? [])]) listener(event);
      return event;
    },
    listenerCount(type) { return listeners.get(type)?.size ?? 0; },
  };
  return document;
}

function mountSendErrorsDialog() {
  const document = makeDocument();
  const opener = makeElement('opener', document);
  const closeButton = makeElement('close', document);
  const cancelButton = makeElement('cancel', document);
  const sendButton = makeElement('send', document);
  const focusables = [closeButton, cancelButton, sendButton];
  const dialog = makeElement('dialog', document);
  dialog.querySelectorAll = () => focusables;
  document.activeElement = opener;

  const effectSetups = [];
  const react = {
    memo: (component) => component,
    useCallback: (callback) => callback,
    useEffect: (setup) => { effectSetups.push(setup); },
    useMemo: (factory) => factory(),
    useRef: () => ({ current: dialog }),
    useState: (initial) => [initial, () => {}],
  };
  const jsxRuntime = { jsx, jsxs: jsx, Fragment: Symbol('Fragment') };
  const behavior = compile(
    'src/renderer/lib/frontend-behavior.ts',
    read('src/renderer/lib/frontend-behavior.ts'),
    {}
  );
  const focusHook = compile(
    'src/renderer/lib/use-dialog-focus.ts',
    read('src/renderer/lib/use-dialog-focus.ts'),
    { react, 'src/renderer/lib/frontend-behavior': behavior },
    { document }
  );
  const inert = () => null;
  const stubs = {
    react,
    'react/jsx-runtime': jsxRuntime,
    '@tanstack/react-query': { useQuery: () => ({}) },
    'react-i18next': { useTranslation: () => ({ t: (key) => key }) },
    'lucide-react': new Proxy({}, { get: () => inert }),
    'src/renderer/lib/api': { api: {}, queryKeys: {} },
    'src/renderer/lib/frontend-state': {},
    'src/renderer/lib/frontend-behavior': behavior,
    'src/renderer/lib/logs-format': {},
    'src/renderer/lib/gateway-lifecycle': {},
    'src/renderer/lib/modal-context': {},
    'src/renderer/lib/use-dialog-focus': focusHook,
  };
  const source = `${read('src/renderer/views/Logs.tsx')}\nexport { SendErrorsDialog };\n`;
  const exports = compile('src/renderer/views/Logs.tsx', source, stubs, { document, window: { setTimeout } });

  let closeCount = 0;
  let mounted = true;
  let cleanups = [];
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    for (const cleanup of cleanups) cleanup?.();
    cleanups = [];
  };
  const onClose = () => {
    closeCount += 1;
    unmount();
  };
  const tree = exports.SendErrorsDialog({
    count: 2,
    preview: [],
    previewLoading: false,
    sending: false,
    onClose,
    onConfirm() {},
  });
  cleanups = effectSetups.map((setup) => setup()).filter(Boolean);

  const renderedClose = findNode(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'errors_closeDialog');
  const renderedCancel = findNode(tree, (node) => node.type === 'button' && node.props.children === 'errors_cancel');
  assert.ok(renderedClose, 'fixture: rendered X button');
  assert.ok(renderedCancel, 'fixture: rendered Cancel button');

  return {
    document,
    opener,
    closeButton,
    cancelButton,
    sendButton,
    renderedClose,
    renderedCancel,
    unmount,
    closeCount: () => closeCount,
  };
}

test('SendErrorsDialog behavior moves focus in and wraps Tab and Shift+Tab', () => {
  const mounted = mountSendErrorsDialog();
  assert.equal(mounted.document.activeElement, mounted.closeButton, 'open must focus the first dialog control');

  mounted.sendButton.focus();
  const tab = mounted.document.dispatchKey('Tab');
  assert.equal(tab.defaultPrevented, true, 'Tab at the final control must be trapped');
  assert.equal(mounted.document.activeElement, mounted.closeButton, 'Tab must wrap to the first control');

  const shiftTab = mounted.document.dispatchKey('Tab', true);
  assert.equal(shiftTab.defaultPrevented, true, 'Shift+Tab at the first control must be trapped');
  assert.equal(mounted.document.activeElement, mounted.sendButton, 'Shift+Tab must wrap to the final control');
  mounted.unmount();
});

test('SendErrorsDialog Escape closes exactly once, restores focus, and removes document listeners', () => {
  const mounted = mountSendErrorsDialog();
  assert.equal(mounted.document.listenerCount('keydown'), 2,
    'the mounted dialog must have one shared Tab listener and one Escape listener');

  mounted.document.dispatchKey('Escape');
  assert.equal(mounted.closeCount(), 1, 'Escape must close exactly once');
  assert.equal(mounted.document.activeElement, mounted.opener, 'Escape close must restore focus to the opener');
  assert.equal(mounted.document.listenerCount('keydown'), 0, 'close must remove both document listeners');

  mounted.document.dispatchKey('Escape');
  assert.equal(mounted.closeCount(), 1, 'a removed listener must not double-close on a later Escape');
});

test('SendErrorsDialog X closes once and restores focus to its opener', () => {
  const mounted = mountSendErrorsDialog();
  mounted.renderedClose.props.onClick();
  assert.equal(mounted.closeCount(), 1);
  assert.equal(mounted.document.activeElement, mounted.opener);
  assert.equal(mounted.document.listenerCount('keydown'), 0);
});

test('SendErrorsDialog Cancel closes once and restores focus to its opener', () => {
  const mounted = mountSendErrorsDialog();
  mounted.renderedCancel.props.onClick();
  assert.equal(mounted.closeCount(), 1);
  assert.equal(mounted.document.activeElement, mounted.opener);
  assert.equal(mounted.document.listenerCount('keydown'), 0);
});

function makeAppHarness() {
  const state = [];
  let cursor = 0;
  let initialEffects = [];
  const react = {
    useCallback: (callback) => callback,
    useEffect: (setup) => { initialEffects.push(setup); },
    useMemo: (factory) => factory(),
    useReducer: (_reducer, initial) => {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (next) => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
    },
    useRef: (value) => ({ current: value }),
    useState: (initial) => {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (next) => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
    },
  };
  const ModalProvider = Symbol('ModalProvider');
  const FeedbackModal = Symbol('FeedbackModal');
  const AboutDialog = Symbol('AboutDialog');
  const DonationModal = Symbol('DonationModal');
  const inert = () => null;
  let navigateAbout;
  let navigateFeedback;
  const fakeWindow = {
    electronAPI: {
      getRuntimeState: async () => ({ language: 'en' }),
      onNavigateAbout(callback) { navigateAbout = callback; return () => {}; },
      onNavigateFeedback(callback) { navigateFeedback = callback; return () => {}; },
      errorReport: { log() {} },
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };
  class QueryClient { setQueryData() {} }
  const stubs = {
    react,
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
    'src/renderer/components/FeedbackModal': { FeedbackModal },
    'src/renderer/components/AboutDialog': { AboutDialog },
    'src/renderer/pet/DonationModal': { DonationModal },
    'src/renderer/lib/modal-context': { ModalContext: { Provider: ModalProvider } },
    'src/renderer/stores/config': { useConfigStore: () => ({ hydrated: true, setupComplete: true, hydrate() {} }) },
    'src/renderer/i18n/config': { applyStoredLanguage: async () => {} },
    'src/renderer/lib/frontend-behavior': { reduceHydration: (value) => value },
    'src/renderer/lib/api': { queryKeys: { runtime: ['runtime'] } },
  };
  const exports = compile('src/renderer/App.tsx', read('src/renderer/App.tsx'), stubs, {
    window: fakeWindow,
    document: {},
    Event: class Event { constructor(type) { this.type = type; } },
  });
  const render = () => {
    cursor = 0;
    initialEffects = [];
    return exports.default();
  };
  let tree = render();
  const effects = initialEffects;
  initialEffects = [];
  for (const setup of effects) setup();

  const rerender = () => { tree = render(); return tree; };
  const provider = () => findNode(tree, (node) => node.type === ModalProvider);
  const modalProps = (type) => findNode(tree, (node) => node.type === type)?.props;
  return {
    provider,
    rerender,
    modalProps,
    FeedbackModal,
    AboutDialog,
    DonationModal,
    navigateAbout: () => navigateAbout,
    navigateFeedback: () => navigateFeedback,
  };
}

test('App-level modal integration keeps one active dialog across context and native-menu opens', () => {
  const app = makeAppHarness();
  let modal = app.provider().props.value;

  modal.openFeedback();
  app.rerender();
  assert.equal(app.modalProps(app.FeedbackModal).isOpen, true, 'context opens Feedback');

  assert.equal(typeof app.navigateAbout(), 'function', 'actual App menu listener must be installed');
  app.navigateAbout()();
  app.rerender();
  assert.equal(app.modalProps(app.AboutDialog).isOpen, true, 'the later native-menu About request wins');
  assert.equal(app.modalProps(app.FeedbackModal).isOpen, false,
    'opening About must suspend Feedback rather than leave two document focus traps active');

  modal = app.provider().props.value;
  assert.equal(typeof modal.openSendErrors, 'function', 'Logs must be able to join the centralized modal arbiter');
  modal.openSendErrors();
  app.rerender();
  assert.equal(app.provider().props.value.activeModal, 'send-errors');

  assert.equal(typeof app.navigateFeedback(), 'function', 'actual App feedback menu listener must be installed');
  app.navigateFeedback()();
  app.rerender();
  assert.equal(app.provider().props.value.activeModal, 'feedback',
    'native Feedback must replace Send Errors, preventing competing document Tab traps');
  assert.equal(app.modalProps(app.FeedbackModal).isOpen, true);
  assert.equal(app.modalProps(app.AboutDialog).isOpen, false);
  assert.equal(app.modalProps(app.DonationModal).open, false);
});
