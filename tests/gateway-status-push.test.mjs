import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = path.join(root, 'tests', 'gateway-status-push-probe.mjs');
const builtMain = path.join(root, 'build', 'src', 'main', 'index.js');

// ───────────────────────────────────────────────────────────────────────────
// DEFECT: the renderer polled `get-gateway-status` every 1000 ms because main
// offered no push channel (src/renderer/components/Layout.tsx). gatewayLifecycle
// already had an onStatusChange hook, wired only to updateTray, so main knew
// about every transition and told nobody.
//
// REQUIRED BEHAVIOUR: main pushes the status to the renderer on that same hook,
// so the renderer can drop to a slow backup poll instead of 1 Hz.
//
// THE PROPERTY THAT MATTERS MOST IS NOT "it sends". It is "it never throws".
// A destroyed window reaching a handler in this app has already crashed the main
// process once: the throw escapes into an Electron event callback, reaches
// process.on('uncaughtException') -> fatalShutdownAndExit -> process.exit(1),
// which is the raw exit that SKIPS before-quit -> cleanupAndQuit ->
// gatewayLifecycle.stop(), i.e. the ipc shutdown that flushes keys.json. A
// gateway status change fires exactly when a window may be gone (stop, retry,
// child error, quit), so this path must be inert, not merely usually fine.
//
// EVERY ASSERTION HERE IS BEHAVIOURAL: a child process loads the REAL BUILT
// main and preload modules under a faked electron and drives the real functions
// with absent / destroyed / throwing windows. No assertion reads source text,
// because a textual guard cannot see what the shipped code does at runtime and
// every textual guard in this repo has eventually been evaded.
// ───────────────────────────────────────────────────────────────────────────

const measured = (() => {
  if (!fs.existsSync(builtMain)) return { skipped: `the built main module is missing: ${builtMain}` };
  const run = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 120_000 });
  const line = run.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) {
    return { failed: `probe exited ${run.status} with no JSON. stderr tail: ${run.stderr?.slice(-600) ?? ''}` };
  }
  return { value: JSON.parse(line), status: run.status };
})();

/** Fail loudly rather than silently passing when the probe could not run. */
function probed() {
  assert.ok(!measured.skipped, measured.skipped);
  assert.ok(!measured.failed, measured.failed);
  assert.equal(measured.status, 0, `probe exited ${measured.status}`);
  assert.equal(measured.value.main.loaded, true, `the built main module failed to load: ${measured.value.main.loadError}`);
  return measured.value;
}

test('the built main module exposes the status broadcaster', () => {
  const result = probed();
  assert.equal(result.main.exportsSender, true,
    'src/main/index.ts must export sendGatewayStatus so the push path can be driven directly '
    + 'against a destroyed window. A broadcaster reachable only through a live Electron '
    + 'BrowserWindow cannot be proven inert, and inertness is the whole point here.');
});

test('a healthy window receives exactly one send on one channel', () => {
  const { main } = probed();
  const healthy = main.cases.healthy;

  assert.equal(healthy.threw, null, `sending to a healthy window threw: ${healthy.threw}`);
  assert.equal(healthy.sends.length, 1,
    `expected exactly 1 webContents.send, got ${healthy.sends.length}. More than one means the `
    + 'same transition is delivered twice; zero means the renderer never learns and its backup '
    + 'poll is doing all the work.');
  assert.equal(typeof healthy.sends[0].channel, 'string');
  assert.ok(healthy.sends[0].channel.length > 0, 'the channel must be a non-empty string');
});

test('an absent window is a no-op, not a throw', () => {
  const { main } = probed();
  for (const name of ['absent', 'undefined']) {
    assert.equal(main.cases[name].threw, null,
      `sendGatewayStatus threw for a ${name} window: ${main.cases[name].threw}. A status change `
      + 'can fire before the first window exists and after the last one has gone.');
    assert.equal(main.cases[name].sends.length, 0, 'nothing can be sent without a window');
  }
});

test('a DESTROYED window is a no-op, not a throw', () => {
  const { main } = probed();
  const destroyed = main.cases.destroyedWindow;

  assert.equal(destroyed.threw, null,
    `sendGatewayStatus threw for a destroyed window: ${destroyed.threw}. This is the exact HIGH `
    + 'already found in this codebase: the throw escapes into an Electron event callback, becomes '
    + 'an uncaughtException, and exits the process past the keys.json flush.');
  assert.equal(destroyed.sends.length, 0,
    'a destroyed window must be detected BEFORE touching webContents, not by catching the throw');
});

test('destroyed webContents are checked separately from the window', () => {
  const { main } = probed();
  const contents = main.cases.destroyedWebContents;

  assert.equal(contents.threw, null,
    `sendGatewayStatus threw when webContents were destroyed but the window was not: `
    + `${contents.threw}. window.isDestroyed() alone does not cover this: a reloading or crashed `
    + 'renderer can leave a live window with dead contents.');
  assert.equal(contents.sends.length, 0, 'no send may be attempted on destroyed contents');
});

test('a send that throws anyway is still contained', () => {
  // Defence in depth. Both liveness checks can pass and the send still throw:
  // the native object can die between the check and the call. Electron gives no
  // atomic way to do this, so the call must also be wrapped.
  const { main } = probed();
  const raced = main.cases.sendThrows;

  assert.equal(raced.threw, null,
    `webContents.send threw past both liveness checks and the throw escaped: ${raced.threw}. `
    + 'The window can be torn down between the isDestroyed() check and the send, so the call '
    + 'itself must be guarded, not just preceded by checks.');
});

test('the pushed payload carries the status fields and nothing else', () => {
  const { main } = probed();
  const sent = main.payload;

  assert.ok(sent, 'the probe captured no payload for a fully populated status');
  assert.deepEqual(Object.keys(sent.payload).sort(), ['code', 'message', 'port', 'state'],
    'the payload must be an explicit projection of the GatewayStatus fields. A spread of the '
    + 'status object would let any field a future caller attaches ride across the bridge; this '
    + 'repo already learned that lesson where a raw JSON.stringify leaked the gateway and admin '
    + `tokens verbatim. Got: ${JSON.stringify(Object.keys(sent.payload))}`);

  assert.equal(sent.payload.state, 'error');
  assert.equal(sent.payload.port, 41100);
  assert.equal(sent.payload.code, 'START_FAILED');
  assert.equal(sent.payload.message, 'boom');

  const serialized = JSON.stringify(sent.payload);
  assert.doesNotMatch(serialized, /nvapi-/,
    'a field the caller attached to the status reached the renderer. The projection is what '
    + 'keeps an accidental secret out of a channel that fires on every transition.');
  assert.equal('secretSmuggled' in sent.payload, false, 'unknown fields must be dropped, not forwarded');
});

test('the preload adds exactly ONE narrowly-typed listener and no invoke channel', () => {
  const { preload } = probed();
  assert.equal(preload.loaded, true, `the built preload failed to load: ${preload.loadError}`);

  assert.deepEqual(preload.addedKeys, ['onGatewayStatusChanged'],
    'the preload surface must grow by exactly one key. Every key here is permanently reachable '
    + `from renderer JavaScript, so the bridge is widened once and never quietly again. Got: `
    + JSON.stringify(preload.addedKeys));

  assert.equal(preload.listener.type, 'function', 'onGatewayStatusChanged must be callable');
});

test('the listener delivers the status WITHOUT the IpcRendererEvent', () => {
  const { preload } = probed();
  const received = preload.listener.received;

  assert.equal(received.length, 1, `expected 1 delivery, got ${received.length}`);
  assert.equal(received[0].length, 1,
    'the callback must receive exactly one argument, the status. Forwarding the '
    + 'IpcRendererEvent hands renderer code a live IPC handle (event.sender) it has no business '
    + `holding; the existing onNavigateAbout/onNavigateFeedback bridges drop it too. Got `
    + `${received[0].length} args: ${JSON.stringify(received[0])}`);

  assert.deepEqual(received[0][0], { state: 'running', port: 41100 },
    'the status must arrive unchanged as the first and only argument');
  assert.doesNotMatch(JSON.stringify(received[0]), /MUST-NOT-LEAK/,
    'the IpcRendererEvent leaked through to the renderer callback');
});

test('the returned unsubscribe really removes the listener', () => {
  const { preload } = probed();

  assert.equal(preload.listener.returnedUnsubscribe, 'function',
    'subscribing must return an unsubscribe function, matching onNavigateAbout/onNavigateFeedback. '
    + 'Without one, a remounting renderer component stacks listeners on a channel that fires on '
    + 'every gateway transition.');
  assert.equal(preload.listener.receivedAfterUnsubscribe, 0,
    'the callback still fired after unsubscribing');
  assert.equal(preload.listener.listenersAfterUnsubscribe, 0,
    'the ipcRenderer listener was not detached, so the subscription leaks per mount');
});

test('the push channel is send-only: main registers no handler for it', () => {
  const { main } = probed();
  const channel = main.payload?.channel ?? main.cases.healthy?.sends?.[0]?.channel;
  assert.ok(channel, 'the probe could not determine the channel name');

  // The auto-launch probe already proves the module registers its invoke
  // handlers under a faked electron; here the requirement is the opposite -- the
  // push channel must NOT be one of them. An invoke handler would make the
  // channel renderer-triggerable, which is a new inbound surface needing
  // validateIpcSender; a pure send has no inbound edge at all.
  const run = spawnSync(process.execPath, ['-e', `
    const Module = require('node:module');
    const channels = [];
    const realLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return {
        app: { getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings(){}, getVersion: () => '0', getName: () => 'p', getPath: () => require('node:os').tmpdir(), getAppPath: () => require('node:os').tmpdir(), setName(){}, setPath(){}, setAppUserModelId(){}, isPackaged: false, requestSingleInstanceLock: () => true, on(){ return this; }, once(){ return this; }, whenReady: () => new Promise(() => {}), quit(){}, exit(){}, relaunch(){}, focus(){}, disableHardwareAcceleration(){}, commandLine: { appendSwitch(){} } },
        ipcMain: { handle(c){ channels.push(c); }, on(c){ channels.push('on:' + c); }, removeHandler(){} },
        BrowserWindow: class { static getAllWindows(){ return []; } },
        Menu: { buildFromTemplate: () => ({ popup(){} }), setApplicationMenu(){} },
        Tray: class { setToolTip(){} setContextMenu(){} on(){} destroy(){} },
        shell: { openExternal: async () => {} },
        dialog: { showMessageBox: async () => ({ response: 0 }) },
        safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
        nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }), createEmpty: () => ({ isEmpty: () => true }) },
        session: { defaultSession: {} }, clipboard: { writeText(){} },
        powerSaveBlocker: { start: () => 0, stop(){} },
        screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1, height: 1 } }) },
        contextBridge: { exposeInMainWorld(){} }, ipcRenderer: { invoke: async () => {}, on(){}, removeListener(){} }
      };
      if (request === 'electron-updater') return { autoUpdater: { on(){}, once(){}, checkForUpdates: async () => null, downloadUpdate: async () => null, quitAndInstall(){}, setFeedURL(){}, autoDownload: false, autoInstallOnAppQuit: false, logger: null } };
      return realLoad.call(this, request, parent, isMain);
    };
    process.on('uncaughtException', () => {});
    process.on('unhandledRejection', () => {});
    try { require(${JSON.stringify(builtMain)}); } catch {}
    process.stdout.write(JSON.stringify(channels));
  `], { encoding: 'utf8', timeout: 120_000 });

  const registered = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.ok(registered.length > 10, `the module registered too few channels to trust: ${registered.length}`);
  assert.equal(registered.includes(channel), false,
    `main registered an inbound handler for the push channel "${channel}". This channel is `
    + 'main->renderer only; an inbound edge would need validateIpcSender/secure() like every '
    + 'other invoke channel, and would let a renderer forge status transitions.');
  assert.equal(registered.includes('on:' + channel), false,
    `main registered ipcMain.on for the push channel "${channel}"; it must have no inbound edge`);
});
