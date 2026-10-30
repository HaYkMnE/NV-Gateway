import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtMain = path.join(root, 'build', 'src', 'main', 'index.js');

// ───────────────────────────────────────────────────────────────────────────
// MASTER-010: when Chromium's GPU process cannot start (VM without GPU
// passthrough, RDP session, corrupted drivers), it crash-loops and fires a
// native abort() — no JS exception, no uncaughtException, no
// fatalShutdownAndExit, no keys.json flush. The HUD is simple forms and
// tables; software rendering is sufficient. There is no reliable in-process
// VM probe, so the mitigation is layered: an operator opt-out
// (NV_GATEWAY_DISABLE_GPU=1 or --disable-gpu), automatic RDP/remote-session
// detection, and a persisted GPU-crash marker that arms software rendering
// on the relaunch that follows a GPU child-process crash.
//
// BEHAVIOURAL, NOT TEXTUAL: a child process loads the REAL BUILT main module
// under a faked electron whose disableHardwareAcceleration/relaunch/quit
// record calls. Module-level code runs synchronously at require time, ahead
// of the never-resolving whenReady(), so a recorded call proves the ordering
// (before whenReady) as well as the call itself. The fake app also records
// event listeners so the child-process-gone recovery path can be driven
// directly.
// ───────────────────────────────────────────────────────────────────────────

const PROBE = `
  const Module = require('node:module');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const realLoad = Module._load;
  const listeners = new Map();
  const events = [];
  let disableCalls = 0;
  let relaunchCalls = 0;
  let quitCalls = 0;
  let exitCalls = 0;
  const appData = process.env.NVGW_PROBE_APP_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'nvgw-gpu-probe-'));
  const app = {
    getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings() {},
    getVersion: () => '0', getName: () => 'p',
    // Electron semantics: userData = appData/<app name> (NV-Gateway after setName).
    getPath: (key) => key === 'userData' ? path.join(appData, 'NV-Gateway') : appData, getAppPath: () => os.tmpdir(),
    setName() {}, setPath() {}, setAppUserModelId() {}, isPackaged: false,
    requestSingleInstanceLock: () => true,
    on(name, listener) { const list = listeners.get(name) || []; list.push(listener); listeners.set(name, list); return this; },
    once(name, listener) { return this.on(name, listener); },
    emit(name, ...args) { for (const listener of listeners.get(name) || []) listener(...args); },
    whenReady: () => new Promise(() => {}),
    quit() { quitCalls++; }, exit() { exitCalls++; }, relaunch() { relaunchCalls++; }, focus() {},
    disableHardwareAcceleration() { disableCalls++; },
    commandLine: { appendSwitch() {} }
  };
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return {
      app,
      ipcMain: { handle() {}, on() {}, removeHandler() {} },
      BrowserWindow: class { static getAllWindows() { return []; } },
      Menu: { buildFromTemplate: () => ({ popup() {} }), setApplicationMenu() {} },
      Tray: class { setToolTip() {} setContextMenu() {} on() {} destroy() {} },
      shell: { openExternal: async () => {} },
      dialog: { showMessageBox: async () => ({ response: 0 }) },
      safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
      nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }), createEmpty: () => ({ isEmpty: () => true }) },
      session: { defaultSession: {} }, clipboard: { writeText() {} },
      powerSaveBlocker: { start: () => 0, stop() {} },
      screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1, height: 1 } }) },
      contextBridge: { exposeInMainWorld() {} }, ipcRenderer: { invoke: async () => {}, on() {}, removeListener() {} }
    };
    if (request === 'electron-updater') return { autoUpdater: { on() {}, once() {}, checkForUpdates: async () => null, downloadUpdate: async () => null, quitAndInstall() {}, setFeedURL() {}, autoDownload: false, autoInstallOnAppQuit: false, logger: null } };
    return realLoad.call(this, request, parent, isMain);
  };
  process.on('uncaughtException', () => {});
  process.on('unhandledRejection', () => {});
  try { require(${JSON.stringify(builtMain)}); } catch (error) { events.push('require-error:' + error.message); }
  const markerPath = path.join(app.getPath('userData'), 'gpu-crash.marker');
  (async () => {
    for (const action of JSON.parse(process.env.NVGW_PROBE_ACTIONS || '[]')) {
      try { app.emit(action.event, ...(action.args || [])); } catch (error) { events.push('emit-error:' + error.message); }
    }
    // Let the async graceful-shutdown continuation (app.quit) settle so the
    // recorded counts are deterministic rather than a microtask race.
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.stdout.write(JSON.stringify({
      disableCalls, relaunchCalls, quitCalls, exitCalls, appData, markerPath,
      markerExists: fs.existsSync(markerPath), events
    }) + '\\n');
  })();
`;

function probeGpuDisable({ env = {}, argv = [], actions = [] } = {}) {
  assert.ok(fs.existsSync(builtMain), `the built main module is missing: ${builtMain}`);
  const run = spawnSync(process.execPath, ['-e', PROBE, '--', ...argv], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...env, NVGW_PROBE_ACTIONS: JSON.stringify(actions) }
  });
  assert.equal(run.status, 0, `probe exited ${run.status}: ${run.stderr?.slice(-400) ?? ''}`);
  const line = run.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, `probe printed no JSON: ${run.stdout.slice(-400)}`);
  const result = JSON.parse(line);
  assert.deepEqual(result.events, [], `the probe must load main and dispatch every action cleanly: ${result.events.join('; ')}`);
  return result;
}

/** A local console session: no RDP marker and no attached remote client. */
const CONSOLE_SESSION_ENV = { SESSIONNAME: 'Console', CLIENTNAME: '' };

test('NV_GATEWAY_DISABLE_GPU=1 disables hardware acceleration before startup', () => {
  const result = probeGpuDisable({ env: { ...CONSOLE_SESSION_ENV, NV_GATEWAY_DISABLE_GPU: '1' } });
  assert.equal(result.disableCalls, 1,
    'app.disableHardwareAcceleration() must be called exactly once when NV_GATEWAY_DISABLE_GPU=1. '
    + 'Without it, a VM/RDP deployment aborts the GPU process natively — past every JS-level '
    + 'guard, including the keys.json flush.');
});

test('--disable-gpu argv disables hardware acceleration before startup', () => {
  const result = probeGpuDisable({ env: { ...CONSOLE_SESSION_ENV, NV_GATEWAY_DISABLE_GPU: '' }, argv: ['--disable-gpu'] });
  assert.equal(result.disableCalls, 1,
    'app.disableHardwareAcceleration() must be called exactly once when --disable-gpu is passed.');
});

test('hardware acceleration stays enabled without the opt-out (control)', () => {
  const result = probeGpuDisable({ env: { ...CONSOLE_SESSION_ENV, NV_GATEWAY_DISABLE_GPU: '' } });
  assert.equal(result.disableCalls, 0,
    'app.disableHardwareAcceleration() must NOT be called without NV_GATEWAY_DISABLE_GPU=1, '
    + '--disable-gpu or a detected remote session; GPU acceleration is the default for normal '
    + 'desktop deployments.');
});

// ── Automatic RDP/remote-session detection (MASTER-010 completion). A Remote
// Desktop session reports SESSIONNAME=RDP-Tcp#<n>; a console session reports
// SESSIONNAME=Console. The HUD is software-rendering-capable, so a remote
// session must arm software rendering automatically — the operator should not
// have to discover NV_GATEWAY_DISABLE_GPU before the GPU process crash-loops.

test('a Remote Desktop session (SESSIONNAME=RDP-Tcp) disables hardware acceleration automatically', () => {
  const result = probeGpuDisable({ env: { SESSIONNAME: 'RDP-Tcp#12', NV_GATEWAY_DISABLE_GPU: '' } });
  assert.equal(result.disableCalls, 1,
    'an RDP session must call app.disableHardwareAcceleration() without any operator opt-in');
});

test('an attached remote client (CLIENTNAME) also disables hardware acceleration automatically', () => {
  const result = probeGpuDisable({ env: { SESSIONNAME: 'Console', CLIENTNAME: 'WORKSTATION-7', NV_GATEWAY_DISABLE_GPU: '' } });
  assert.equal(result.disableCalls, 1,
    'an RDP client attached to the console session must arm software rendering too');
});

test('a real remote client name (CLIENTNAME=RDP-Tcp#12) disables hardware acceleration automatically', () => {
  const result = probeGpuDisable({ env: { SESSIONNAME: 'Console', CLIENTNAME: 'RDP-Tcp#12', NV_GATEWAY_DISABLE_GPU: '' } });
  assert.equal(result.disableCalls, 1,
    'a non-Console CLIENTNAME is a remote client and must arm software rendering');
});

// CLIENTNAME is the name of the client attached to the session. Some Windows
// configurations set it to the literal "Console" even for a LOCAL session, so
// a non-empty value alone is not proof of a remote client — treating it as one
// needlessly disables hardware acceleration on a desktop machine.
test('CLIENTNAME=Console (any case) is a local session and keeps hardware acceleration', () => {
  for (const clientName of ['Console', 'console', 'CONSOLE']) {
    const result = probeGpuDisable({ env: { SESSIONNAME: 'Console', CLIENTNAME: clientName, NV_GATEWAY_DISABLE_GPU: '' } });
    assert.equal(result.disableCalls, 0,
      `CLIENTNAME=${clientName} names the local console client and must NOT disable hardware acceleration`);
  }
});

test('a whitespace-only CLIENTNAME is treated as absent (local session)', () => {
  const result = probeGpuDisable({ env: { SESSIONNAME: 'Console', CLIENTNAME: '   ', NV_GATEWAY_DISABLE_GPU: '' } });
  assert.equal(result.disableCalls, 0,
    'a blank CLIENTNAME carries no remote client identity; the trimmed value is empty, so the session stays local');
});

// ── child-process-gone recovery (MASTER-010 completion): a GPU process that
// died must not be allowed to crash-loop into the native abort(). The handler
// persists a crash marker and relaunches ONCE into software rendering; the
// relaunched process consumes the marker and starts with acceleration off.

test('a GPU child-process-gone relaunches once into software rendering and records the crash', () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'nvgw-gpu-crash-'));
  try {
    const result = probeGpuDisable({
      env: { ...CONSOLE_SESSION_ENV, NV_GATEWAY_DISABLE_GPU: '', NVGW_PROBE_APP_DATA: appData },
      actions: [{ event: 'child-process-gone', args: [{}, { type: 'GPU', reason: 'crashed', exitCode: 1 }] }]
    });
    assert.equal(result.relaunchCalls, 1,
      'a crashed GPU child process must trigger exactly one controlled relaunch');
    assert.equal(result.quitCalls, 1,
      'the crash recovery must request one graceful app quit so the gateway child and keys.json are flushed');
    assert.equal(result.exitCalls, 0, 'crash recovery must never bypass the graceful quit path');
    assert.equal(result.markerExists, true,
      'the crash must be recorded so the relaunch can start in software rendering');
    const relaunch = probeGpuDisable({
      env: { ...CONSOLE_SESSION_ENV, NV_GATEWAY_DISABLE_GPU: '', NVGW_PROBE_APP_DATA: appData }
    });
    assert.equal(relaunch.disableCalls, 1,
      'the relaunch after a recorded GPU crash must start with hardware acceleration disabled');
  } finally {
    fs.rmSync(appData, { recursive: true, force: true });
  }
});

test('a non-GPU child-process-gone and a clean GPU exit never relaunch', () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'nvgw-gpu-noop-'));
  try {
    const nonGpu = probeGpuDisable({
      env: { ...CONSOLE_SESSION_ENV, NV_GATEWAY_DISABLE_GPU: '', NVGW_PROBE_APP_DATA: appData },
      actions: [{ event: 'child-process-gone', args: [{}, { type: 'Utility', reason: 'crashed', exitCode: 1 }] }]
    });
    assert.equal(nonGpu.relaunchCalls, 0, 'only a GPU child-process crash may relaunch the app');
    const clean = probeGpuDisable({
      env: { ...CONSOLE_SESSION_ENV, NV_GATEWAY_DISABLE_GPU: '', NVGW_PROBE_APP_DATA: appData },
      actions: [{ event: 'child-process-gone', args: [{}, { type: 'GPU', reason: 'clean-exit', exitCode: 0 }] }]
    });
    assert.equal(clean.relaunchCalls, 0, 'a clean GPU process exit is not a crash and must not relaunch');
    assert.equal(clean.markerExists, false, 'a clean GPU exit must not arm software rendering');
  } finally {
    fs.rmSync(appData, { recursive: true, force: true });
  }
});
