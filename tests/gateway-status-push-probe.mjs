// Behavioural probe for the main->renderer gateway-status push channel.
// Spawned as a CHILD PROCESS by tests/gateway-status-push.test.mjs; prints one
// line of JSON on stdout.
//
// WHY A CHILD PROCESS: importing the real built main module registers ~40 IPC
// handlers, installs process-level error handlers and starts the real startup
// promise. Those side effects must not leak into the test runner.
//
// WHAT THIS MEASURES (runtime, not source text):
//   1. the exact channel name the built main module sends on;
//   2. what it does when the window is absent, DESTROYED, or its webContents
//      throws -- a destroyed window reaching a handler has already crashed this
//      process once, past the state flush, so "does not throw" is the property
//      that matters;
//   3. the payload that actually crosses the bridge, field by field;
//   4. the built preload surface: how many keys it adds, whether the listener
//      unsubscribes for real, and whether the IpcRendererEvent leaks through.
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const builtMain = path.join(root, 'build', 'src', 'main', 'index.js');
const builtPreload = path.join(root, 'build', 'src', 'preload', 'index.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nvg-status-push-probe-'));

const result = {
  main: { loaded: false, loadError: null, exportsSender: false, cases: {} },
  preload: { loaded: false, loadError: null, addedKeys: [], listener: {} }
};

const app = {
  getLoginItemSettings() { return { openAtLogin: false }; },
  setLoginItemSettings() {},
  getVersion: () => '0.0.0-probe',
  getName: () => 'nvg-probe',
  getPath: () => scratch,
  getAppPath: () => scratch,
  setName() {}, setPath() {}, setAppUserModelId() {},
  isPackaged: false,
  requestSingleInstanceLock: () => true,
  on() { return app; }, once() { return app; },
  whenReady: () => new Promise(() => {}),
  quit() {}, exit() {}, relaunch() {}, focus() {}, disableHardwareAcceleration() {},
  commandLine: { appendSwitch() {} }
};

const fakeElectron = {
  app,
  ipcMain: { handle() {}, on() {}, removeHandler() {} },
  BrowserWindow: class { static getAllWindows() { return []; } },
  Menu: { buildFromTemplate: () => ({ popup() {} }), setApplicationMenu() {} },
  Tray: class { setToolTip() {} setContextMenu() {} on() {} destroy() {} },
  shell: { openExternal: async () => {} },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }), createEmpty: () => ({ isEmpty: () => true }) },
  session: { defaultSession: {} },
  clipboard: { writeText() {} },
  powerSaveBlocker: { start: () => 0, stop() {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  contextBridge: { exposeInMainWorld(_key, api) { fakeElectron.__exposed = api; } },
  ipcRenderer: {
    __listeners: new Map(),
    invoke: async () => undefined,
    on(channel, listener) {
      if (!this.__listeners.has(channel)) this.__listeners.set(channel, []);
      this.__listeners.get(channel).push(listener);
    },
    removeListener(channel, listener) {
      const list = this.__listeners.get(channel) ?? [];
      const index = list.indexOf(listener);
      if (index !== -1) list.splice(index, 1);
    },
    emit(channel, event, payload) {
      for (const listener of [...(this.__listeners.get(channel) ?? [])]) listener(event, payload);
    }
  }
};

const fakeUpdater = {
  autoUpdater: {
    on() {}, once() {}, checkForUpdates: async () => null, downloadUpdate: async () => null,
    quitAndInstall() {}, setFeedURL() {}, autoDownload: false, autoInstallOnAppQuit: false, logger: null
  }
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (request === 'electron-updater') return fakeUpdater;
  return realLoad.call(this, request, parent, isMain);
};

process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

// ── main side ──────────────────────────────────────────────────────────────
let mainModule = null;
try {
  await import(pathToFileURL(builtMain).href);
  mainModule = createRequire(import.meta.url)(builtMain);
  result.main.loaded = true;
} catch (error) {
  result.main.loadError = error instanceof Error ? error.message : String(error);
}

const sendGatewayStatus = mainModule?.sendGatewayStatus;
result.main.exportsSender = typeof sendGatewayStatus === 'function';

if (result.main.exportsSender) {
  const status = { state: 'running', port: 41100 };

  const drive = (name, window) => {
    const record = { threw: null, sends: [] };
    try {
      sendGatewayStatus(window, status);
    } catch (error) {
      record.threw = error instanceof Error ? error.message : String(error);
    }
    if (window && window.__sends) record.sends = window.__sends;
    result.main.cases[name] = record;
  };

  const healthy = () => {
    const sends = [];
    return {
      __sends: sends,
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel, payload) => sends.push({ channel, payload }) }
    };
  };

  drive('absent', null);
  drive('undefined', undefined);
  drive('destroyedWindow', {
    __sends: [],
    isDestroyed: () => true,
    webContents: { isDestroyed: () => false, send() { throw new Error('Object has been destroyed'); } }
  });
  drive('destroyedWebContents', {
    __sends: [],
    isDestroyed: () => false,
    webContents: { isDestroyed: () => true, send() { throw new Error('Object has been destroyed'); } }
  });
  drive('sendThrows', {
    __sends: [],
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send() { throw new Error('Object has been destroyed'); } }
  });
  drive('healthy', healthy());

  // THE SHAPES A LIVENESS CHECK CANNOT SURVIVE. Electron's destroyed-object
  // wrapper throws "Object has been destroyed" on property ACCESS and on method
  // CALLS, so every check in the guard is itself a throwing expression against a
  // dead native object. A guard that only wraps the send leaves all of these
  // escaping into an Electron event callback -> uncaughtException -> exit past
  // the keys.json flush. Each of the four below DID escape before this was fixed.
  drive('webContentsGetterThrows', {
    isDestroyed: () => false,
    get webContents() { throw new Error('Object has been destroyed'); }
  });
  drive('windowIsDestroyedThrows', {
    isDestroyed() { throw new Error('Object has been destroyed'); },
    webContents: { isDestroyed: () => false, send() {} }
  });
  drive('contentsIsDestroyedThrows', {
    isDestroyed: () => false,
    webContents: { isDestroyed() { throw new Error('Object has been destroyed'); }, send() {} }
  });
  drive('webContentsNull', { isDestroyed: () => false, webContents: null });
  // Not a BrowserWindow at all: the hook hands over whatever `mainWindow` holds.
  drive('notABrowserWindow', 7);

  // Payload fidelity: a status carrying an unexpected extra field must not
  // widen what crosses the bridge.
  const probeWindow = healthy();
  try {
    sendGatewayStatus(probeWindow, {
      state: 'error', port: 41100, code: 'START_FAILED', message: 'boom',
      secretSmuggled: 'nvapi-must-not-cross'
    });
  } catch { /* recorded below as a missing send */ }
  result.main.payload = probeWindow.__sends[0] ?? null;

  // A TOKEN-SHAPED STRING in the one field that legitimately carries free text.
  // The projection drops fields a caller ATTACHES; it says nothing about what a
  // caller puts INSIDE `message`. sendGatewayStatus is exported, so its "no
  // secret crosses" contract must not rest on every caller remembering to
  // sanitize first. Fixture kept small on purpose: a sibling agent burned a
  // 300 s shell cap pushing ~90 MB through these same regexes.
  const tokenWindow = healthy();
  const token = 'nvapi-' + 'A'.repeat(64);
  try {
    sendGatewayStatus(tokenWindow, {
      state: 'error', code: 'START_FAILED', port: 41100,
      message: `gateway child failed: token=${token} admin=${token}`
    });
  } catch { /* recorded below as a missing send */ }
  result.main.tokenPayload = { token, sent: tokenWindow.__sends[0] ?? null };

  // And an oversized message must be capped, not forwarded whole.
  const longWindow = healthy();
  try {
    sendGatewayStatus(longWindow, { state: 'error', message: 'x'.repeat(40_000) + token });
  } catch { /* recorded below */ }
  const longSent = longWindow.__sends[0] ?? null;
  result.main.longPayload = {
    length: longSent ? String(longSent.payload.message).length : null,
    containsToken: longSent ? String(longSent.payload.message).includes(token) : null
  };
}

// ── preload side ───────────────────────────────────────────────────────────
const BASELINE_KEYS = [
  'checkPorts', 'findFreePort', 'getGatewayPort', 'getGatewayStatus', 'getRuntimeState',
  'setAppConfig', 'setGatewayPort', 'retryGateway', 'toggleAutoLaunch', 'getAutoLaunch',
  'getAppVersion', 'getUpdateStatus', 'checkForUpdates', 'getModels', 'refreshModels',
  'updateModelSettings', 'toggleModel', 'bulkToggleModels', 'adminListKeys', 'adminAddKey',
  'adminRemoveKey', 'adminSetStatus', 'adminReorder', 'adminLogs', 'adminGetPerformance',
  'adminValidateKey', 'getGatewayCredentials', 'errorReport', 'feedback', 'openExternal',
  'clipboard', 'diagnostic', 'about', 'onNavigateAbout', 'onNavigateFeedback'
];

try {
  createRequire(import.meta.url)(builtPreload);
  result.preload.loaded = true;
} catch (error) {
  result.preload.loadError = error instanceof Error ? error.message : String(error);
}

const exposed = fakeElectron.__exposed;
if (exposed) {
  result.preload.addedKeys = Object.keys(exposed).filter((key) => !BASELINE_KEYS.includes(key));

  const subscribe = exposed.onGatewayStatusChanged;
  const record = { type: typeof subscribe, received: [], returnedUnsubscribe: null, listenersAfterUnsubscribe: null, receivedAfterUnsubscribe: 0 };
  if (typeof subscribe === 'function') {
    const unsubscribe = subscribe((...args) => record.received.push(args));
    record.returnedUnsubscribe = typeof unsubscribe;

    const channel = result.main.payload?.channel ?? 'gateway-status-changed';
    const event = { sender: 'MUST-NOT-LEAK', senderId: 7 };
    fakeElectron.ipcRenderer.emit(channel, event, { state: 'running', port: 41100 });
    record.channelListened = [...fakeElectron.ipcRenderer.__listeners.keys()];

    if (typeof unsubscribe === 'function') {
      unsubscribe();
      const before = record.received.length;
      fakeElectron.ipcRenderer.emit(channel, event, { state: 'stopped' });
      record.receivedAfterUnsubscribe = record.received.length - before;
      record.listenersAfterUnsubscribe = (fakeElectron.ipcRenderer.__listeners.get(channel) ?? []).length;
    }
  }
  result.preload.listener = record;
}

try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }

process.stdout.write(JSON.stringify(result) + '\n');
process.exit(0);
