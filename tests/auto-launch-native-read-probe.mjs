// Behavioural probe for the auto-launch handle leak. Spawned as a CHILD PROCESS
// by tests/auto-launch-handle-leak.test.mjs; prints one line of JSON on stdout.
//
// WHY THIS EXISTS: every other assertion in that test file reads SOURCE TEXT.
// A textual guard cannot see what the shipped code actually does at runtime, and
// this repo has had textual guards bypassed before. This probe loads the REAL
// BUILT main module (build/src/main/index.js) with a faked `electron` and counts
// how many times app.getLoginItemSettings() -- the primitive that leaks one
// kernel `Key` handle per call while the HKCU Run value exists -- is invoked.
//
// WHY A CHILD PROCESS: loading the real module registers ~37 IPC handlers,
// installs process-level error handlers and starts the real startup promise.
// Those side effects must not leak into the test runner's process.
//
// HONEST LIMIT, stated here so the numbers are never over-read: the
// get-runtime-state handler is wrapped in secure(), which throws
// "Window unavailable." while the module-private `mainWindow` is unset. Under a
// faked electron there is no BrowserWindow, so invoking the channel is REJECTED
// AT THE GATE and never enters the handler body. `hotPath.reachedBody` reports
// this. A zero read count on a rejected call is NOT evidence about the body --
// only `startupNativeReads` is a real measurement of the built code.
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = path.join(root, 'build', 'src', 'main', 'index.js');

// Keep every path the real code might touch inside a throwaway directory, so the
// probe cannot write into the developer's real application data.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nvg-autolaunch-probe-'));

/** Every call here would cost one leaked kernel `Key` handle in production. */
let nativeReads = 0;
const handlers = new Map();

const app = {
  getLoginItemSettings() { nativeReads += 1; return { openAtLogin: true }; },
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
  ipcMain: { handle(channel, fn) { handlers.set(channel, fn); }, on() {}, removeHandler() {} },
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
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) }
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

const result = {
  loaded: false,
  loadError: null,
  handlerCount: 0,
  channels: [],
  startupNativeReads: 0,
  hotPath: { invocations: 0, nativeReads: 0, reachedBody: false, rejectedWith: null }
};

// The real module installs its own process-level handlers; swallow anything the
// faked host provokes so the probe still reports its measurement.
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

try {
  await import(pathToFileURL(built).href);
  result.loaded = true;
} catch (error) {
  result.loadError = error instanceof Error ? error.message : String(error);
}

result.handlerCount = handlers.size;
result.channels = [...handlers.keys()];
// Reads performed merely by loading the module and registering handlers. This is
// the load-bearing measurement: it must be zero, because anything that samples
// the registry eagerly at startup leaks a handle on every launch.
result.startupNativeReads = nativeReads;

// Drive the REAL registered get-runtime-state handler. See the honest-limit note
// at the top: without a BrowserWindow this is rejected by secure() before the
// body runs, which is itself worth pinning (the hot path is not reachable by a
// caller with no live window).
const hotPath = handlers.get('get-runtime-state');
if (typeof hotPath === 'function') {
  const before = nativeReads;
  const event = { senderFrame: { url: 'http://localhost:5173/' }, sender: {} };
  for (let i = 0; i < 200; i += 1) {
    result.hotPath.invocations += 1;
    try {
      await hotPath(event);
      result.hotPath.reachedBody = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.hotPath.rejectedWith = message;
      // Any error other than the window gate means the body DID execute.
      if (!/Window unavailable/i.test(message)) result.hotPath.reachedBody = true;
    }
  }
  result.hotPath.nativeReads = nativeReads - before;
}

try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }

process.stdout.write(JSON.stringify(result) + '\n');
process.exit(0);
