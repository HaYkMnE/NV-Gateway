import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

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
function walk(node, visit) {
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  if (!node || typeof node !== 'object') return;
  visit(node);
  walk(node.props?.children, visit);
}
function findNode(tree, predicate) {
  let found;
  walk(tree, (node) => { if (found === undefined && predicate(node)) found = node; });
  return found;
}

function createDocument() {
  const listeners = new Map();
  return {
    activeElement: null,
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? new Set();
      values.add(listener);
      listeners.set(type, values);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    contains(value) { return Boolean(value); },
    dispatchKey(key) {
      const event = { key, shiftKey: false, preventDefault() {} };
      for (const listener of [...(listeners.get('keydown') ?? [])]) listener(event);
    },
    listenerCount(type) { return listeners.get(type)?.size ?? 0; },
  };
}

function createTimers() {
  let nextId = 1;
  const pending = new Map();
  const scheduled = new Map();
  let cleared = 0;
  return {
    setTimeout(callback) {
      const id = nextId++;
      pending.set(id, callback);
      scheduled.set(id, callback);
      return id;
    },
    clearTimeout(id) { if (pending.delete(id)) cleared += 1; },
    runCaptured(id) { scheduled.get(id)?.(); },
    runAll() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    ids: () => [...scheduled.keys()],
    pending: () => pending.size,
    cleared: () => cleared,
  };
}

function createHooks() {
  const slots = [];
  let cursor = 0;
  let pendingEffects = [];
  const sameDeps = (a, b) => Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));
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
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
      slots.length = 0;
    },
  };
}

function makeAppHarness() {
  const hooks = createHooks();
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
    'src/renderer/components/FeedbackModal': { FeedbackModal },
    'src/renderer/components/AboutDialog': { AboutDialog },
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
    modal: () => findNode(tree, (node) => node.type === ModalProvider).props.value,
    modalProps: (type) => findNode(tree, (node) => node.type === type)?.props,
    FeedbackModal, AboutDialog, DonationModal,
    navigateAbout: () => navigateAbout,
    navigateFeedback: () => navigateFeedback,
  };
}

function makeLogsHarness(app, errorReport, document = createDocument()) {
  const hooks = createHooks();
  const inert = () => null;
  const useDialogFocus = (_ref, active) => {
    hooks.react.useEffect(() => {
      if (!active) return;
      const listener = (event) => { if (event.key === 'Tab') event.preventDefault(); };
      document.addEventListener('keydown', listener);
      return () => document.removeEventListener('keydown', listener);
    }, [active]);
  };
  const stubs = {
    react: hooks.react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol('Fragment') },
    '@tanstack/react-query': { useQuery: () => ({ data: { logs: [] }, dataUpdatedAt: 0, error: null, isPending: false, isError: false, refetch() {} }) },
    'react-i18next': { useTranslation: () => ({ t: (key) => key }) },
    'lucide-react': new Proxy({}, { get: () => inert }),
    'src/renderer/lib/api': { api: {}, queryKeys: { logs: ['logs'] } },
    'src/renderer/lib/frontend-state': {
      CLIPBOARD_TEXT_MAX: 1, classifyDataState: () => 'empty', isOversizedForClipboard: () => false, safeError: String,
    },
    'src/renderer/lib/frontend-behavior': {
      classifyScrollEvent: () => 'settle', createLogsQueryPolicy: () => ({ refetchInterval: false, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false }), isNearBottom: () => true, shouldCancelAutoScroll: () => false,
    },
    'src/renderer/lib/logs-format': { formatLogLine: () => '' },
    'src/renderer/lib/gateway-lifecycle': { useGatewayLifecycle: () => ({ status: { state: 'running' } }) },
    'src/renderer/lib/modal-context': { useModal: () => app.modal() },
    'src/renderer/lib/use-dialog-focus': { useDialogFocus },
  };
  const source = `${read('src/renderer/views/Logs.tsx')}\nexport { SendErrorsDialog };`;
  const exports = compile('src/renderer/views/Logs.tsx', source, stubs, {
    document,
    window: {
      electronAPI: { errorReport, clipboard: { writeText: async () => {} } },
      setTimeout, clearTimeout,
    },
  });
  let tree;
  const render = () => { hooks.begin(); tree = exports.Logs(); hooks.commit(); return tree; };
  render();
  return { render, tree: () => tree, exports, hooks, document };
}

function button(tree, label) {
  const node = findNode(tree, (candidate) => candidate.type === 'button' && candidate.props.children === label);
  assert.ok(node, `fixture: button ${label}`);
  return node;
}

test('deferred getCount cannot replace a newer modal request', async () => {
  const count = deferred();
  const app = makeAppHarness();
  const logs = makeLogsHarness(app, { getCount: () => count.promise, preview: async () => [], send: async () => ({ success: true, count: 1 }) });

  button(logs.tree(), 'errors_sendButton').props.onClick();
  app.modal().openFeedback();
  app.render();
  assert.equal(app.modal().activeModal, 'feedback');

  count.resolve(2);
  await flush();
  app.render();
  assert.equal(app.modal().activeModal, 'feedback', 'older getCount completion must not replace newer Feedback');
});

test('older getCount completion cannot overwrite a newer Send Errors count', async () => {
  const countA = deferred();
  const countB = deferred();
  let countCalls = 0;
  const app = makeAppHarness();
  const logs = makeLogsHarness(app, {
    getCount: () => (++countCalls === 1 ? countA.promise : countB.promise),
    preview: async () => [],
    send: async () => ({ success: true, count: 1 }),
  });
  const currentDialogProps = () => findNode(
    logs.tree(),
    (node) => typeof node.type === 'function' && node.type.name === 'SendErrorsDialog',
  )?.props;

  button(logs.tree(), 'errors_sendButton').props.onClick();
  button(logs.tree(), 'errors_sendButton').props.onClick();
  countB.resolve(7);
  await flush();
  app.render();
  logs.render();
  assert.equal(currentDialogProps().count, 7, 'request B must own the visible count');

  countA.resolve(2);
  await flush();
  app.render();
  logs.render();
  assert.equal(currentDialogProps().count, 7, 'request A must not publish its stale count into request B');
});

test('deferred preview from an older Send Errors request cannot overwrite a reopened request', async () => {
  const previewA = deferred();
  const previewB = deferred();
  let previewCalls = 0;
  const app = makeAppHarness();
  const logs = makeLogsHarness(app, {
    getCount: async () => 2,
    preview: () => (++previewCalls === 1 ? previewA.promise : previewB.promise),
    send: async () => ({ success: true, count: 2 }),
  });
  const currentDialogProps = () => findNode(
    logs.tree(),
    (node) => typeof node.type === 'function' && node.type.name === 'SendErrorsDialog',
  )?.props;

  button(logs.tree(), 'errors_sendButton').props.onClick();
  await flush();
  app.render();
  logs.render();
  assert.equal(app.modal().activeModal, 'send-errors');
  assert.equal(currentDialogProps().previewLoading, true, 'request A starts its preview');

  app.modal().openFeedback();
  app.render();
  logs.render();
  button(logs.tree(), 'errors_sendButton').props.onClick();
  await flush();
  app.render();
  logs.render();
  assert.equal(app.modal().activeModal, 'send-errors');
  assert.equal(currentDialogProps().previewLoading, true, 'request B owns the visible loading state');

  previewA.resolve([{ timestamp: 'old', type: 'renderer', message: 'stale preview' }]);
  await flush();
  logs.render();
  assert.equal(currentDialogProps().preview, null, 'request A must not publish stale preview data into request B');
  assert.equal(currentDialogProps().previewLoading, true, 'request A must not clear request B loading state');

  const currentPreview = [{ timestamp: 'new', type: 'renderer', message: 'current preview' }];
  previewB.resolve(currentPreview);
  await flush();
  logs.render();
  assert.deepEqual(currentDialogProps().preview, currentPreview, 'request B still publishes its own preview');
  assert.equal(currentDialogProps().previewLoading, false, 'request B settles its own loading state');
});

test('deferred send completion cannot close a newer modal', async () => {
  const sending = deferred();
  const app = makeAppHarness();
  const logs = makeLogsHarness(app, { getCount: async () => 2, preview: async () => [], send: () => sending.promise });

  button(logs.tree(), 'errors_sendButton').props.onClick();
  await flush();
  app.render();
  logs.render();
  assert.equal(app.modal().activeModal, 'send-errors');
  const dialogNode = findNode(logs.tree(), (node) => typeof node.type === 'function' && node.type.name === 'SendErrorsDialog');
  assert.ok(dialogNode, 'fixture: SendErrorsDialog mounted');
  const sendPromise = dialogNode.props.onConfirm();

  app.modal().openAbout();
  app.render();
  assert.equal(app.modal().activeModal, 'about');
  sending.resolve({ success: true, count: 2 });
  await sendPromise;
  app.render();
  assert.equal(app.modal().activeModal, 'about', 'older send completion must not close newer About');
});

test('older send completion cannot unlock a newer Send Errors submission', async () => {
  const sendA = deferred();
  const sendB = deferred();
  let sendCalls = 0;
  const app = makeAppHarness();
  const logs = makeLogsHarness(app, {
    getCount: async () => 2,
    preview: async () => [],
    send: () => (++sendCalls === 1 ? sendA.promise : sendB.promise),
  });
  const currentDialog = () => findNode(
    logs.tree(),
    (node) => typeof node.type === 'function' && node.type.name === 'SendErrorsDialog',
  );

  button(logs.tree(), 'errors_sendButton').props.onClick();
  await flush();
  app.render();
  logs.render();
  const promiseA = currentDialog().props.onConfirm();
  logs.render();
  assert.equal(currentDialog().props.sending, true, 'fixture: request A is sending');

  app.modal().openAbout();
  app.render();
  logs.render();
  button(logs.tree(), 'errors_sendButton').props.onClick();
  await flush();
  app.render();
  logs.render();
  assert.equal(currentDialog().props.sending, false, 'request B must open with fresh submission state');
  const promiseB = currentDialog().props.onConfirm();
  logs.render();
  assert.equal(currentDialog().props.sending, true, 'fixture: request B is independently sending');

  sendA.resolve({ success: true, count: 2 });
  await promiseA;
  app.render();
  logs.render();
  assert.equal(app.modal().activeModal, 'send-errors', 'request A must not close request B');
  assert.equal(currentDialog().props.sending, true, 'request A finally must not unlock request B controls');

  sendB.resolve({ success: true, count: 2 });
  await promiseB;
});

test('close without replacement immediately revokes Send Errors ownership and quarantines completion', async () => {
  const preview = deferred();
  const sending = deferred();
  const app = makeAppHarness();
  const logs = makeLogsHarness(app, {
    getCount: async () => 2,
    preview: () => preview.promise,
    send: () => sending.promise,
  });

  button(logs.tree(), 'errors_sendButton').props.onClick();
  await flush();
  app.render();
  logs.render();
  const dialog = findNode(logs.tree(), (node) => typeof node.type === 'function' && node.type.name === 'SendErrorsDialog');
  assert.ok(dialog, 'fixture: Send Errors request is visible');
  const request = app.modal().activeModalRequest;
  const sendPromise = dialog.props.onConfirm();
  dialog.props.onClose();

  assert.equal(app.modal().isCurrentModalRequest(request), false,
    'dismissal must revoke request ownership synchronously, before a replacement or rerender');
  app.render();
  logs.render();
  assert.equal(app.modal().activeModal, null, 'dismissal still closes the owned dialog');

  preview.resolve([{ timestamp: 'old', type: 'renderer', message: 'dismissed preview' }]);
  sending.resolve({ success: true, count: 2 });
  await sendPromise;
  await flush();
  app.render();
  logs.render();
  const liveRegion = findNode(logs.tree(), (node) => node.type === 'p' && node.props?.['aria-live'] === 'polite');
  assert.equal(liveRegion.props.children, '', 'dismissed send completion must not announce');
  assert.equal(app.modal().activeModal, null, 'dismissed async cleanup must keep the arbiter closed');
});

function mountStaleSendErrorsDialog(Component, onClose) {
  const hooks = createHooks();
  const document = createDocument();
  const useDialogFocus = (_ref, active) => hooks.react.useEffect(() => {
    if (!active) return;
    const listener = () => {};
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [active]);
  const source = `${read('src/renderer/views/Logs.tsx')}\nexport { SendErrorsDialog };`;
  const inert = () => null;
  const exports = compile('src/renderer/views/Logs.tsx', source, {
    react: hooks.react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol('Fragment') },
    '@tanstack/react-query': { useQuery: () => ({}) },
    'react-i18next': { useTranslation: () => ({ t: (key) => key }) },
    'lucide-react': new Proxy({}, { get: () => inert }),
    'src/renderer/lib/api': { api: {}, queryKeys: {} },
    'src/renderer/lib/frontend-state': {},
    'src/renderer/lib/frontend-behavior': {},
    'src/renderer/lib/logs-format': {},
    'src/renderer/lib/gateway-lifecycle': {},
    'src/renderer/lib/modal-context': {},
    'src/renderer/lib/use-dialog-focus': { useDialogFocus },
  }, { document, window: { setTimeout, clearTimeout } });
  hooks.begin();
  const tree = exports.SendErrorsDialog({ count: 1, preview: [], previewLoading: false, sending: false, onClose, onConfirm() {} });
  hooks.commit();
  return { tree, document, unmount: () => hooks.unmount() };
}

test('stale Send Errors Escape, X, and Cancel cannot close a newer modal', async () => {
  const app = makeAppHarness();
  const logs = makeLogsHarness(app, { getCount: async () => 1, preview: async () => [], send: async () => ({ success: true, count: 1 }) });
  button(logs.tree(), 'errors_sendButton').props.onClick();
  await flush();
  app.render();
  logs.render();
  const staleDialog = findNode(logs.tree(), (node) => typeof node.type === 'function' && node.type.name === 'SendErrorsDialog');
  const staleClose = staleDialog.props.onClose;

  for (const mechanism of ['Escape', 'X', 'Cancel']) {
    app.modal().openDonation();
    app.render();
    const mounted = mountStaleSendErrorsDialog(logs.exports.SendErrorsDialog, staleClose);
    if (mechanism === 'Escape') mounted.document.dispatchKey('Escape');
    if (mechanism === 'X') findNode(mounted.tree, (node) => node.type === 'button' && node.props['aria-label'] === 'errors_closeDialog').props.onClick();
    if (mechanism === 'Cancel') button(mounted.tree, 'errors_cancel').props.onClick();
    app.render();
    assert.equal(app.modal().activeModal, 'donation', `stale ${mechanism} must not close newer Donation`);
    mounted.unmount();
  }
});

function makeFeedbackHarness(props, timers, document, feedbackApi) {
  const hooks = createHooks();
  const useDialogFocus = (_ref, active) => hooks.react.useEffect(() => {
    if (!active) return;
    const listener = () => {};
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [active]);
  const inert = () => null;
  const FeedbackModal = compile('src/renderer/components/FeedbackModal.tsx', read('src/renderer/components/FeedbackModal.tsx'), {
    react: hooks.react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol('Fragment') },
    'react-i18next': { useTranslation: () => ({ t: (key) => key }) },
    'lucide-react': new Proxy({}, { get: () => inert }),
    'src/renderer/lib/use-dialog-focus': { useDialogFocus },
  }, {
    document,
    window: { electronAPI: { feedback: feedbackApi }, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
  }).FeedbackModal;
  let currentProps = props;
  let tree;
  const render = (next = currentProps) => { currentProps = next; hooks.begin(); tree = FeedbackModal(currentProps); hooks.commit(); return tree; };
  render();
  return { render, tree: () => tree, unmount: () => hooks.unmount() };
}

function makeAboutHarness(props, aboutApi, document = createDocument()) {
  const hooks = createHooks();
  const useDialogFocus = (_ref, active) => hooks.react.useEffect(() => {
    if (!active) return;
    const listener = () => {};
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [active]);
  const inert = () => null;
  const AboutDialog = compile('src/renderer/components/AboutDialog.tsx', read('src/renderer/components/AboutDialog.tsx'), {
    react: hooks.react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol('Fragment') },
    'react-i18next': { useTranslation: () => ({ t: (key) => key }) },
    'lucide-react': new Proxy({}, { get: () => inert }),
    'src/renderer/lib/use-dialog-focus': { useDialogFocus },
  }, {
    document,
    window: { electronAPI: { about: aboutApi, openExternal: async () => {} } },
  }).AboutDialog;
  let currentProps = props;
  let tree;
  const render = (next = currentProps) => {
    currentProps = next;
    hooks.begin();
    tree = AboutDialog(currentProps);
    hooks.commit();
    return tree;
  };
  render();
  return { render, tree: () => tree, unmount: () => hooks.unmount() };
}

function feedbackField(tree, id) {
  const field = findNode(tree, (node) => node.props?.id === id);
  assert.ok(field, `fixture: Feedback field ${id}`);
  return field;
}

function fillFeedback(feedback, props, title = 'title', description = 'description') {
  feedbackField(feedback.tree(), 'feedback-title').props.onChange({ target: { value: title } });
  feedbackField(feedback.tree(), 'feedback-description').props.onChange({ target: { value: description } });
  feedback.render(props);
}

function assertFreshFeedback(tree, message) {
  assert.equal(feedbackField(tree, 'feedback-title').props.value, '', `${message}: title`);
  assert.equal(feedbackField(tree, 'feedback-description').props.value, '', `${message}: description`);
  assert.equal(feedbackField(tree, 'feedback-email').props.value, '', `${message}: email`);
  assert.equal(findNode(tree, (node) => node.props?.role === 'radio' && node.props['aria-checked'] === true)?.props.children,
    'feedback_suggestion', `${message}: type`);
  assert.equal(findNode(tree, (node) => node.props?.type === 'checkbox').props.checked, true,
    `${message}: diagnostic default`);
  assert.equal(button(tree, 'feedback_save').props.disabled, false, `${message}: submitting`);
  assert.equal(findNode(tree, (node) => node.props?.role === 'status'), undefined, `${message}: toast`);
}

test('native-menu same-Feedback reopen creates a fresh session and quarantines all A work', async () => {
  const saveA = deferred();
  const githubA = deferred();
  const timers = createTimers();
  const document = createDocument();
  const app = makeAppHarness();
  app.modal().openFeedback();
  app.render();
  const propsA = app.modalProps(app.FeedbackModal);
  assert.equal(typeof propsA.session, 'number', 'App must expose the modal request as Feedback session identity');
  const feedback = makeFeedbackHarness(propsA, timers, document, {
    save: () => saveA.promise,
    openGitHubIssue: () => githubA.promise,
  });

  // Give A every kind of state that must not survive: a toast/timer, edited
  // form fields, and both asynchronous actions in flight.
  button(feedback.tree(), 'feedback_save').props.onClick();
  feedback.render(propsA);
  assert.equal(timers.pending(), 1, 'fixture: A owns a toast timer');
  fillFeedback(feedback, propsA, 'A title', 'A description');
  feedbackField(feedback.tree(), 'feedback-email').props.onChange({ target: { value: 'a@example.test' } });
  findNode(feedback.tree(), (node) => node.props?.type === 'checkbox').props.onChange({ target: { checked: false } });
  feedback.render(propsA);
  button(feedback.tree(), 'feedback_openGithub').props.onClick();
  button(feedback.tree(), 'feedback_save').props.onClick();
  feedback.render(propsA);
  assert.equal(button(feedback.tree(), 'feedback_save').props.disabled, true, 'fixture: A is submitting');

  app.navigateFeedback()();
  app.render();
  const propsB = app.modalProps(app.FeedbackModal);
  assert.ok(propsB.session > propsA.session, 'native-menu reopen must advance Feedback identity while it stays open');
  feedback.render(propsB);
  feedback.render(propsB);
  assertFreshFeedback(feedback.tree(), 'B must start fresh');
  assert.equal(timers.pending(), 0, 'B transition must cancel every timer owned by A');

  saveA.resolve({ success: true, path: 'C:\\old-session.jsonl' });
  githubA.reject(new Error('A GitHub failure'));
  await flush();
  feedback.render(propsB);
  timers.runAll();
  feedback.render(propsB);
  assertFreshFeedback(feedback.tree(), 'A then/catch/finally/timer must not mutate B');
  assert.equal(timers.pending(), 0, 'A completion must not schedule work in B');
  assert.equal(app.modal().activeModalRequest, propsB.session, 'A work must leave B as the active request');
  feedback.unmount();
});

test('same-batch close and reopen creates fresh B without a committed false render', async () => {
  const saveA = deferred();
  const timers = createTimers();
  const document = createDocument();
  const app = makeAppHarness();
  app.modal().openFeedback();
  app.render();
  const propsA = app.modalProps(app.FeedbackModal);
  const feedback = makeFeedbackHarness(propsA, timers, document, {
    save: () => saveA.promise,
    openGitHubIssue: async () => {},
  });
  fillFeedback(feedback, propsA, 'A title', 'A description');
  button(feedback.tree(), 'feedback_save').props.onClick();
  feedback.render(propsA);
  assert.equal(button(feedback.tree(), 'feedback_save').props.disabled, true, 'fixture: A is submitting');

  // Deliberately do not render Feedback with isOpen=false between these calls.
  propsA.onClose();
  app.modal().openFeedback();
  app.render();
  const propsB = app.modalProps(app.FeedbackModal);
  assert.ok(propsB.session > propsA.session, 'batched reopen must own a new identity');
  feedback.render(propsB);
  feedback.render(propsB);
  assertFreshFeedback(feedback.tree(), 'same-batch B must start fresh');

  saveA.reject(new Error('A save failure'));
  await flush();
  feedback.render(propsB);
  assertFreshFeedback(feedback.tree(), 'A rejection/finally must not mutate same-batch B');
  assert.equal(app.modal().activeModalRequest, propsB.session);
  feedback.unmount();
});

test('the current replacement Feedback session still saves and closes normally', async () => {
  const saveB = deferred();
  const timers = createTimers();
  const document = createDocument();
  const app = makeAppHarness();
  app.modal().openFeedback();
  app.render();
  app.modal().openFeedback();
  app.render();
  const propsB = app.modalProps(app.FeedbackModal);
  const feedback = makeFeedbackHarness(propsB, timers, document, {
    save: () => saveB.promise,
    openGitHubIssue: async () => {},
  });
  fillFeedback(feedback, propsB, 'B title', 'B description');
  button(feedback.tree(), 'feedback_save').props.onClick();
  feedback.render(propsB);
  assert.equal(button(feedback.tree(), 'feedback_save').props.disabled, true);

  saveB.resolve({ success: true, path: 'C:\\current-session.jsonl' });
  await flush();
  feedback.render(propsB);
  assert.equal(button(feedback.tree(), 'feedback_save').props.disabled, false, 'B finally must unlock B');
  assert.equal(findNode(feedback.tree(), (node) => node.props?.role === 'status')?.props.children,
    'feedback_savedTo', 'B success must show its normal confirmation');
  assert.ok(timers.pending() >= 1, 'B success must schedule its normal toast/close work');
  timers.runAll();
  app.render();
  assert.equal(app.modal().activeModal, null, 'B close timer must close the B request it owns');
  feedback.unmount();
});

test('repeated same-modal opens advance identity without timer or focus-listener leaks', () => {
  const timers = createTimers();
  const document = createDocument();
  const app = makeAppHarness();
  app.modal().openFeedback();
  app.render();
  let props = app.modalProps(app.FeedbackModal);
  const feedback = makeFeedbackHarness(props, timers, document, {
    save: async () => ({ success: true }),
    openGitHubIssue: async () => {},
  });

  for (let index = 0; index < 12; index += 1) {
    button(feedback.tree(), 'feedback_save').props.onClick();
    feedback.render(props);
    assert.equal(timers.pending(), 1, `session ${index} fixture must own one toast timer`);
    const previousSession = props.session;
    app.modal().openFeedback();
    app.render();
    props = app.modalProps(app.FeedbackModal);
    assert.ok(props.session > previousSession, `same-modal request ${index} must advance identity`);
    feedback.render(props);
    feedback.render(props);
    assert.equal(timers.pending(), 0, `same-modal request ${index} must clear the prior timer`);
    assert.equal(document.listenerCount('keydown'), 2,
      `same-modal request ${index} must retain exactly one focus trap and one Escape listener`);
  }

  feedbackField(feedback.tree(), 'feedback-title').props.onChange({ target: { value: 'keep me' } });
  feedback.render(props);
  app.render();
  const unchangedProps = app.modalProps(app.FeedbackModal);
  assert.equal(unchangedProps.session, props.session, 'an unrelated parent rerender must not advance identity');
  feedback.render(unchangedProps);
  assert.equal(feedbackField(feedback.tree(), 'feedback-title').props.value, 'keep me',
    'stable identity must not reset form state on an unrelated parent rerender');
  feedback.unmount();
  assert.equal(document.listenerCount('keydown'), 0, 'unmount must remove all Feedback listeners');
  assert.equal(timers.pending(), 0, 'unmount must leave no Feedback timers');
});

test('Feedback delayed close is cancelled and cannot close its replacement', async () => {
  const save = deferred();
  const timers = createTimers();
  const document = createDocument();
  const app = makeAppHarness();
  app.modal().openFeedback();
  app.render();
  const feedbackProps = app.modalProps(app.FeedbackModal);
  const feedback = makeFeedbackHarness(feedbackProps, timers, document, {
    save: () => save.promise,
    openGitHubIssue: async () => {},
  });

  findNode(feedback.tree(), (node) => node.props?.id === 'feedback-title').props.onChange({ target: { value: 'title' } });
  findNode(feedback.tree(), (node) => node.props?.id === 'feedback-description').props.onChange({ target: { value: 'description' } });
  feedback.render(feedbackProps);
  button(feedback.tree(), 'feedback_save').props.onClick();
  save.resolve({ success: true });
  await flush();
  assert.ok(timers.pending() > 0, 'fixture: success scheduled delayed UI/close work');

  app.modal().openAbout();
  app.render();
  feedback.render(app.modalProps(app.FeedbackModal));
  assert.equal(document.listenerCount('keydown'), 0, 'replacement must remove Feedback key listeners');
  const clearedOnReplace = timers.cleared();
  timers.runAll();
  app.render();
  assert.equal(app.modal().activeModal, 'about', 'stale Feedback timer must not close newer About');
  assert.ok(clearedOnReplace > 0, 'replacement must cancel pending Feedback timers rather than merely ignore them');
  feedback.unmount();
});

test('same-modal About reopen starts a fresh fetch and ignores the prior completion', async () => {
  const infoA = deferred();
  const infoB = deferred();
  let calls = 0;
  const app = makeAppHarness();
  app.modal().openAbout();
  app.render();
  const propsA = app.modalProps(app.AboutDialog);
  assert.equal(typeof propsA.session, 'number', 'App must expose About request identity');
  const about = makeAboutHarness(propsA, {
    getInfo: () => (++calls === 1 ? infoA.promise : infoB.promise),
  });
  assert.equal(calls, 1, 'session A starts one fetch');

  app.navigateAbout()();
  app.render();
  const propsB = app.modalProps(app.AboutDialog);
  assert.ok(propsB.session > propsA.session, 'same-modal About reopen advances identity');
  about.render(propsB);
  assert.equal(calls, 2, 'session B starts a fresh fetch while isOpen remains true');

  infoA.resolve({ appVersion: 'old-session' });
  await flush();
  about.render(propsB);
  assert.equal(findNode(about.tree(), (node) => node.type === 'dd' && node.props.children === 'old-session'), undefined,
    'session A completion must not populate session B');

  const current = {
    appVersion: 'new-session', electronVersion: '31', chromeVersion: '126', nodeVersion: '20',
    proxyPort: 1234, adminPort: 1235, repoUrl: 'https://example.test/current',
  };
  infoB.resolve(current);
  await flush();
  about.render(propsB);
  assert.ok(findNode(about.tree(), (node) => node.type === 'dd' && node.props.children === 'new-session'),
    'session B completion still renders normally');
  about.unmount();
});

test('stale Feedback save completion cannot unlock a reopened Feedback session', async () => {
  const firstSave = deferred();
  const secondSave = deferred();
  let saveCalls = 0;
  const timers = createTimers();
  const document = createDocument();
  const app = makeAppHarness();

  app.modal().openFeedback();
  app.render();
  let feedbackProps = app.modalProps(app.FeedbackModal);
  const feedback = makeFeedbackHarness(feedbackProps, timers, document, {
    save: () => (++saveCalls === 1 ? firstSave.promise : secondSave.promise),
    openGitHubIssue: async () => {},
  });
  const fillAndSave = () => {
    findNode(feedback.tree(), (node) => node.props?.id === 'feedback-title').props.onChange({ target: { value: 'title' } });
    findNode(feedback.tree(), (node) => node.props?.id === 'feedback-description').props.onChange({ target: { value: 'description' } });
    feedback.render(feedbackProps);
    button(feedback.tree(), 'feedback_save').props.onClick();
    feedback.render(feedbackProps);
  };

  fillAndSave();
  feedbackProps.onClose();
  app.render();
  feedback.render(app.modalProps(app.FeedbackModal));

  app.modal().openFeedback();
  app.render();
  feedbackProps = app.modalProps(app.FeedbackModal);
  feedback.render(feedbackProps);
  feedback.render(feedbackProps);
  fillAndSave();
  assert.equal(button(feedback.tree(), 'feedback_save').props.disabled, true, 'second save starts disabled');

  firstSave.resolve({ success: false, message: 'old session failure' });
  await flush();
  feedback.render(feedbackProps);
  assert.equal(
    button(feedback.tree(), 'feedback_save').props.disabled,
    true,
    'completion from the closed session must not unlock the current save',
  );

  secondSave.resolve({ success: true });
  await flush();
  feedback.unmount();
});

test('stale GitHub rejection cannot show an error in a reopened Feedback session', async () => {
  const github = deferred();
  const timers = createTimers();
  const document = createDocument();
  const app = makeAppHarness();

  app.modal().openFeedback();
  app.render();
  let feedbackProps = app.modalProps(app.FeedbackModal);
  const feedback = makeFeedbackHarness(feedbackProps, timers, document, {
    save: async () => ({ success: true }),
    openGitHubIssue: () => github.promise,
  });
  findNode(feedback.tree(), (node) => node.props?.id === 'feedback-title').props.onChange({ target: { value: 'title' } });
  findNode(feedback.tree(), (node) => node.props?.id === 'feedback-description').props.onChange({ target: { value: 'description' } });
  feedback.render(feedbackProps);
  button(feedback.tree(), 'feedback_openGithub').props.onClick();

  feedbackProps.onClose();
  app.render();
  feedback.render(app.modalProps(app.FeedbackModal));
  app.modal().openFeedback();
  app.render();
  feedbackProps = app.modalProps(app.FeedbackModal);
  feedback.render(feedbackProps);
  feedback.render(feedbackProps);

  github.reject(new Error('old session failure'));
  await flush();
  feedback.render(feedbackProps);
  assert.equal(
    findNode(feedback.tree(), (node) => node.props?.role === 'status'),
    undefined,
    'an error from the closed session must not appear in the current session',
  );
  feedback.unmount();
});

function makeDonationHarness(document, options = {}) {
  const hooks = createHooks();
  const useDialogFocus = (_ref, active) => hooks.react.useEffect(() => {
    if (!active) return;
    const listener = (event) => { if (event.key === 'Tab') event.preventDefault(); };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [active]);
  const inert = () => null;
  const timers = options.timers ?? { setTimeout, clearTimeout };
  const clipboard = options.clipboard ?? { writeText: async () => {} };
  const storage = options.storage ?? { setItem() {} };
  const audio = options.audio ?? { playAscensionRitual() {}, playActionCheer() {} };
  const DonationModal = compile('src/renderer/pet/DonationModal.tsx', read('src/renderer/pet/DonationModal.tsx'), {
    react: hooks.react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol('Fragment') },
    'react-i18next': { useTranslation: () => ({ t: (key) => key }) },
    'lucide-react': new Proxy({}, { get: () => inert }),
    qrcode: { __esModule: true, default: { toString: async () => '' } },
    'src/renderer/pet/audioEngine': { petAudio: audio },
    'src/renderer/lib/use-dialog-focus': { useDialogFocus },
    'src/renderer/pet/donation-modal.css': {},
  }, {
    document,
    window: {
      electronAPI: { clipboard, openExternal: async () => {} },
      localStorage: storage, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    },
  }).DonationModal;
  let currentProps = { open: false, session: null, onClose() {}, onAscension() {} };
  let tree;
  const render = (openOrProps, session = openOrProps ? 1 : null) => {
    currentProps = typeof openOrProps === 'object'
      ? openOrProps
      : { ...currentProps, open: openOrProps, session };
    hooks.begin();
    tree = DonationModal(currentProps);
    hooks.commit();
    return tree;
  };
  return { render, tree: () => tree, unmount: () => hooks.unmount() };
}

function firstDonationCopy(tree) {
  const copy = findNode(tree, (node) => node.type === 'button' && node.props.children === 'pet_copy');
  assert.ok(copy, 'fixture: Donation copy button');
  return copy;
}

test('Donation ignores clipboard completion from a replaced session', async () => {
  const writeA = deferred();
  const storageWrites = [];
  let rituals = 0;
  let ascensions = 0;
  const document = createDocument();
  const donation = makeDonationHarness(document, {
    clipboard: { writeText: () => writeA.promise },
    storage: { setItem: (...args) => storageWrites.push(args) },
    audio: { playAscensionRitual: () => { rituals += 1; }, playActionCheer() {} },
  });
  const propsA = { open: true, session: 10, onClose() {}, onAscension: () => { ascensions += 1; } };
  donation.render(propsA);
  firstDonationCopy(donation.tree()).props.onClick({ stopPropagation() {} });

  const propsB = { ...propsA, session: 11 };
  donation.render(propsB);
  donation.render(propsB);
  writeA.resolve();
  await flush();
  donation.render(propsB);

  assert.equal(findNode(donation.tree(), (node) => node.type === 'button' && node.props.children === 'pet_copied'), undefined,
    'session A completion must not set copied UI in B');
  assert.equal(findNode(donation.tree(), (node) => node.props?.role === 'status'), undefined,
    'session A completion must not show a thanks bubble in B');
  assert.deepEqual(storageWrites, [], 'session A completion must not persist VIP state');
  assert.equal(rituals, 0, 'session A completion must not play ascension audio');
  assert.equal(ascensions, 0, 'session A completion must not invoke ascension callback');
  donation.unmount();
});

test('Donation clears owned timers and an already queued old timer cannot clear a new copied indicator', async () => {
  const timers = createTimers();
  const writes = [deferred(), deferred()];
  let writeCall = 0;
  const document = createDocument();
  const donation = makeDonationHarness(document, {
    timers,
    clipboard: { writeText: () => writes[writeCall++].promise },
  });
  const propsA = { open: true, session: 20, onClose() {}, onAscension() {} };
  donation.render(propsA);
  firstDonationCopy(donation.tree()).props.onClick({ stopPropagation() {} });
  writes[0].resolve();
  await flush();
  donation.render(propsA);
  const [oldCopiedTimer] = timers.ids();
  assert.ok(oldCopiedTimer, 'fixture: session A owns a copied-state timer');
  assert.ok(findNode(donation.tree(), (node) => node.type === 'button' && node.props.children === 'pet_copied'));

  const propsB = { ...propsA, session: 21 };
  donation.render(propsB);
  donation.render(propsB);
  assert.equal(timers.pending(), 0, 'session transition clears every timer owned by A');
  firstDonationCopy(donation.tree()).props.onClick({ stopPropagation() {} });
  writes[1].resolve();
  await flush();
  donation.render(propsB);
  assert.ok(findNode(donation.tree(), (node) => node.type === 'button' && node.props.children === 'pet_copied'),
    'fixture: B owns a new copied indicator');

  timers.runCaptured(oldCopiedTimer);
  donation.render(propsB);
  assert.ok(findNode(donation.tree(), (node) => node.type === 'button' && node.props.children === 'pet_copied'),
    'queued timer from A must not clear B copied state');
  donation.unmount();
  assert.equal(timers.pending(), 0, 'unmount clears B timers');
});

test('Donation replacement removes the QR trap and reopening has no stale QR overlay', () => {
  const document = createDocument();
  const donation = makeDonationHarness(document);
  donation.render(true);
  const qrButton = findNode(donation.tree(), (node) => node.type === 'button' && node.props['aria-label'] === 'pet_qr_enlarge_aria');
  assert.ok(qrButton, 'fixture: QR thumbnail button');
  qrButton.props.onClick({ stopPropagation() {} });
  donation.render(true);
  assert.ok(findNode(donation.tree(), (node) => node.props?.['aria-label'] === 'pet_qr_overlay_aria'), 'fixture: QR overlay opened');

  donation.render(false);
  assert.equal(document.listenerCount('keydown'), 0, 'replacing Donation must remove both parent Escape and QR Tab listeners');

  donation.render(true);
  assert.equal(findNode(donation.tree(), (node) => node.props?.['aria-label'] === 'pet_qr_overlay_aria'), undefined,
    'reopening Donation must not briefly restore the QR overlay from the replaced session');
  assert.equal(document.listenerCount('keydown'), 2, 'reopened Donation has exactly one main trap and one Escape listener');
  donation.unmount();
});
