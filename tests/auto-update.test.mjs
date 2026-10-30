import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import typescript from 'typescript';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// ---------------------------------------------------------------------------
// Structural reading of the REAL `createAutoUpdateService({...})` argument.
//
// A regex over the whole file takes the first textual match, so a comment that
// merely MENTIONS `stopGateway: async () => ...` above the real wiring made the
// old assertion green while the adapter was reverted. Instead: mask comments and
// string/template content (same length, newlines preserved), brace-match the
// argument object of the actual call, and read `stopGateway` at depth 0 of THAT
// object only. A decoy comment can no longer be seen at all.
// ---------------------------------------------------------------------------

/** Blank comment + string/template CONTENT with spaces, preserving length. */
function maskNonCode(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  // `mode`: 'code' | 'line-comment' | 'block-comment' | '"' | "'" | '`'.
  // `templateDepths` tracks `${ ... }` nesting inside template literals so the
  // braces of an embedded expression stay visible to the brace matcher.
  let mode = 'code';
  let templateDepths = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (mode === 'line-comment') {
      if (c === '\n') { mode = 'code'; i += 1; continue; }
      blank(i, i + 1); i += 1; continue;
    }
    if (mode === 'block-comment') {
      if (c === '*' && next === '/') { blank(i, i + 2); mode = 'code'; i += 2; continue; }
      blank(i, i + 1); i += 1; continue;
    }
    if (mode === '"' || mode === "'") {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === mode) { mode = 'code'; i += 1; continue; }
      blank(i, i + 1); i += 1; continue;
    }
    if (mode === '`') {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === '$' && next === '{') { templateDepths.push(0); mode = 'code'; i += 2; continue; }
      if (c === '`') { mode = 'code'; i += 1; continue; }
      blank(i, i + 1); i += 1; continue;
    }
    // mode === 'code'
    if (c === '/' && next === '/') { blank(i, i + 2); mode = 'line-comment'; i += 2; continue; }
    if (c === '/' && next === '*') { blank(i, i + 2); mode = 'block-comment'; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { mode = c; i += 1; continue; }
    if (templateDepths.length > 0) {
      if (c === '{') { templateDepths[templateDepths.length - 1] += 1; i += 1; continue; }
      if (c === '}') {
        if (templateDepths[templateDepths.length - 1] === 0) { templateDepths.pop(); mode = '`'; i += 1; continue; }
        templateDepths[templateDepths.length - 1] -= 1; i += 1; continue;
      }
    }
    i += 1;
  }
  return out.join('');
}

/** Index of the bracket closing the one at `open`, or -1. */
function matchBracket(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every `createAutoUpdateService({...})` argument object in the source. */
function autoUpdateCallArguments(source) {
  const masked = maskNonCode(source);
  const found = [];
  const needle = 'createAutoUpdateService';
  let from = 0;
  for (;;) {
    const at = masked.indexOf(needle, from);
    if (at === -1) return found;
    from = at + needle.length;
    // A CALL is `name(` — not the import specifier (`name,`) nor a comment.
    let open = from;
    while (open < masked.length && /\s/.test(masked[open])) open += 1;
    if (masked[open] !== '(') continue;
    let first = open + 1;
    while (first < masked.length && /\s/.test(masked[first])) first += 1;
    if (masked[first] !== '{') continue;
    const close = matchBracket(masked, first);
    if (close === -1) continue;
    found.push(source.slice(first, close + 1));
  }
}

/** The depth-0 value text of `key` in an object literal, or null. */
function topLevelProperty(objectText, key) {
  const masked = maskNonCode(objectText);
  let depth = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '{' || c === '(' || c === '[') { depth += 1; continue; }
    if (c === '}' || c === ')' || c === ']') { depth -= 1; continue; }
    if (depth !== 1 || !masked.startsWith(key, i)) continue;
    const before = masked.slice(0, i).trimEnd();
    if (!(before.endsWith('{') || before.endsWith(','))) continue;
    let cursor = i + key.length;
    while (cursor < masked.length && /\s/.test(masked[cursor])) cursor += 1;
    if (masked[cursor] !== ':') continue;
    cursor += 1;
    while (cursor < masked.length && /\s/.test(masked[cursor])) cursor += 1;
    const start = cursor;
    let valueDepth = 0;
    for (; cursor < masked.length; cursor += 1) {
      const v = masked[cursor];
      if (v === '(' || v === '[' || v === '{') valueDepth += 1;
      else if (v === ')' || v === ']' || v === '}') {
        if (valueDepth === 0) break;
        valueDepth -= 1;
      } else if (v === ',' && valueDepth === 0) break;
    }
    return objectText.slice(start, cursor).trim();
  }
  return null;
}

function loadTypeScriptExports(relative) {
  const compiled = typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { Error, exports: module.exports, module }, { filename: relative });
  return module.exports;
}

function fakeUpdater() {
  const emitter = new EventEmitter();
  const calls = [];
  const fake = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    emit: (name, payload) => emitter.emit(name, payload),
    calls,
    on: (name, listener) => { calls.push(['on', name]); return emitter.on(name, listener); },
    checkForUpdates: async () => { calls.push(['checkForUpdates']); },
    downloadUpdate: async () => { calls.push(['downloadUpdate']); },
    quitAndInstall: (isSilent, isForceRunAfter) => { calls.push(['quitAndInstall', isSilent, isForceRunAfter]); }
  };
  return fake;
}

function fakeDialog(responses = []) {
  const shown = [];
  return {
    shown,
    showMessageBox: async (options) => {
      shown.push(options);
      return { response: responses.length > 0 ? responses.shift() : 1 };
    }
  };
}

function harness({ language = 'en', dialog = fakeDialog(), enabled = true, stopGateway } = {}) {
  const logs = [];
  const states = [];
  const order = [];
  let quitting = false;
  return {
    logs, states, order, dialog,
    isQuitting: () => quitting,
    build: async () => {
      const { createAutoUpdateService } = await import(built('auto-update.js'));
      const updater = fakeUpdater();
      const service = createAutoUpdateService({
        updater,
        dialog,
        getLanguage: () => language,
        log: (level, event, data) => logs.push({ level, event, data }),
        setQuitting: () => { quitting = true; order.push('setQuitting'); },
        stopGateway: stopGateway ?? (async () => { order.push('stopGateway'); }),
        onStatusChanged: (status) => states.push(status),
        enabled
      });
      return { service, updater };
    }
  };
}

const flush = async (times = 5) => { for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

test('update service forces offer-only policy and maps update-available to a localized dialog and status', async () => {
  const dialog = fakeDialog([0, 0]); // user picks "Download", then "Restart and install"
  const h = harness({ language: 'ru', dialog });
  const { service, updater } = await h.build();
  assert.equal(updater.autoDownload, false, 'updates are only offered, never auto-downloaded');
  assert.equal(updater.autoInstallOnAppQuit, false, 'updates are never silently installed on quit');

  await service.checkForUpdates({ manual: true });
  assert.equal(service.getStatus().state, 'checking');
  assert.equal(updater.calls.some(([name]) => name === 'checkForUpdates'), true);

  updater.emit('update-available', { version: '1.1.0' });
  assert.equal(service.getStatus().state, 'available');
  assert.equal(service.getStatus().version, '1.1.0');
  await flush();
  assert.equal(dialog.shown.length, 1, 'update-available shows the offer dialog');
  assert.match(dialog.shown[0].message, /Доступна новая версия/);
  assert.match(dialog.shown[0].message, /1\.1\.0/);
  assert.deepEqual(dialog.shown[0].buttons, ['Скачать', 'Позже']);
  await flush();
  assert.equal(updater.calls.some(([name]) => name === 'downloadUpdate'), true, 'Download choice starts the download');
  assert.equal(service.getStatus().state, 'downloading');

  updater.emit('download-progress', { percent: 42.4 });
  assert.deepEqual(service.getStatus(), { state: 'downloading', version: '1.1.0', percent: 42 });
  updater.emit('download-progress', { percent: 42.6 });
  assert.equal(service.getStatus().percent, 43, 'progress percent is rounded for display');

  updater.emit('update-downloaded', { version: '1.1.0' });
  assert.equal(service.getStatus().state, 'ready');
  await flush();
  assert.equal(dialog.shown.length, 2, 'update-downloaded shows the install dialog');
  assert.equal(dialog.shown[1].title, 'Готово к установке');
  assert.deepEqual(dialog.shown[1].buttons, ['Перезапустить и установить', 'Позже']);
  await flush();
  assert.equal(h.isQuitting(), true, 'install marks the app as quitting so quit guards stand down');
  assert.equal(updater.calls.filter(([name]) => name === 'quitAndInstall').length, 1);
});

test('download postponement keeps the offered update without downloading', async () => {
  const dialog = fakeDialog([1]); // user picks "Later"
  const h = harness({ language: 'en', dialog });
  const { service, updater } = await h.build();
  await service.checkForUpdates({ manual: true });
  updater.emit('update-available', { version: '2.0.0' });
  await flush();
  assert.equal(dialog.shown.length, 1);
  assert.deepEqual(dialog.shown[0].buttons, ['Download', 'Later']);
  assert.equal(updater.calls.some(([name]) => name === 'downloadUpdate'), false, 'Later skips the download');
  assert.equal(service.getStatus().state, 'available', 'the offered update remains available');
  assert.equal(h.logs.some(({ event }) => event === 'update_download_postponed'), true);
});

test('background checks stay silent: not-available and errors log only, never dialog', async () => {
  const dialog = fakeDialog();
  const h = harness({ language: 'en', dialog });
  const { service, updater } = await h.build();
  await service.checkForUpdates({ manual: false });
  updater.emit('update-not-available', {});
  assert.equal(service.getStatus().state, 'upToDate');
  await flush();
  assert.equal(dialog.shown.length, 0, 'background up-to-date result shows no dialog');
  updater.emit('error', new Error('net down'));
  assert.equal(service.getStatus().state, 'error');
  await flush();
  assert.equal(dialog.shown.length, 0, 'background errors show no dialog');
  assert.deepEqual(h.logs.filter(({ event }) => event === 'update_error').map(({ data }) => data.manual), [false]);

  // A manual check surfaces both outcomes as localized dialogs.
  await service.checkForUpdates({ manual: true });
  updater.emit('update-not-available', {});
  await flush();
  assert.equal(dialog.shown.length, 1, 'manual up-to-date result is acknowledged');
  assert.equal(dialog.shown[0].message, 'You have the latest version.');
  updater.emit('error', new Error('net down'));
  await flush();
  assert.equal(dialog.shown.length, 2, 'manual failures surface an error dialog');
  assert.equal(dialog.shown[1].title, 'Update error');
});

test('same Error object handled once across event emission and promise rejection', async () => {
  const dialog = fakeDialog();
  const h = harness({ language: 'en', dialog });
  const { service, updater } = await h.build();
  const failure = new Error('dns failure');
  updater.checkForUpdates = async () => { updater.emit('error', failure); throw failure; };
  await service.checkForUpdates({ manual: true });
  await flush();
  assert.equal(dialog.shown.length, 1, 'the duplicate rejection path must not surface a second dialog');
  assert.equal(h.logs.filter(({ event }) => event === 'update_error').length, 1);
  assert.equal(service.getStatus().state, 'error');
});

test('unpackaged runs skip checks with a log event instead of calling electron-updater', async () => {
  const h = harness({ enabled: false });
  const { service, updater } = await h.build();
  const status = await service.checkForUpdates({ manual: true });
  assert.equal(status.state, 'none');
  assert.equal(updater.calls.some(([name]) => name === 'checkForUpdates'), false, 'no electron-updater call in dev/unpackaged runs');
  assert.equal(h.logs.some(({ event }) => event === 'update_check_skipped'), true);
});

test('quitAndInstall ordering: the child stop is confirmed BEFORE the quitting flag and quitAndInstall(false, true)', async () => {
  let h; // stopGateway closes over the SHARED harness order log
  let resolveStop;
  const stopGateway = async () => {
    h.order.push('stop-begin');
    await new Promise((resolve) => { resolveStop = resolve; });
    h.order.push('stop-end');
  };
  h = harness({ stopGateway });
  const { service, updater } = await h.build();
  const install = service.installAndQuit();
  await flush(2);
  assert.deepEqual(h.order, ['stop-begin'], 'the child stop starts first...');
  assert.equal(h.isQuitting(), false, '...and quitting is NOT flagged while the stop is in flight (no before-quit bypass window)');
  assert.equal(service.isInstalling(), true, 'install lock reports in-flight for the before-quit gate');
  assert.equal(updater.calls.some(([name]) => name === 'quitAndInstall'), false, 'quitAndInstall must NOT run while the child is still stopping');
  resolveStop();
  await install;
  assert.deepEqual(h.order, ['stop-begin', 'stop-end', 'setQuitting'], 'quitting is flagged only after the child stop is confirmed');
  assert.deepEqual(updater.calls.filter(([name]) => name === 'quitAndInstall')[0], ['quitAndInstall', false, true], 'quitAndInstall(isSilent=false, isForceRunAfter=true)');

  // A rejected child stop aborts the install and leaves a retryable, coherent state.
  const failing = harness({ stopGateway: async () => { throw new Error('stop refused'); } });
  const failed = await failing.build();
  await failed.service.installAndQuit();
  assert.equal(failed.updater.calls.some(([name]) => name === 'quitAndInstall'), false, 'failed stop must not hand off to the installer');
  assert.equal(failing.logs.some(({ event }) => event === 'update_gateway_stop_failed'), true);
  assert.deepEqual(failed.service.getStatus(), { state: 'error', version: null, percent: null }, 'aborted install surfaces an error state, not a stale ready');
  assert.equal(failed.service.isInstalling(), false, 'install lock is released so a later attempt can retry');
  assert.equal(failing.isQuitting(), false, 'quitting never flagged on the aborted path');
});

test('install aborts when the child stop RESOLVES with an error status (GatewayLifecycle.stop failure shape)', async () => {
  // Production GatewayLifecycle.stop() never rejects: stopInternal resolves
  // with { state: 'error', code: 'START_FAILED' } when the child shutdown
  // cannot be confirmed (gateway-lifecycle stopChild returns false).
  const h = harness({
    stopGateway: async () => ({ state: 'error', code: 'START_FAILED', message: 'Managed gateway child shutdown could not be confirmed.' })
  });
  const { service, updater } = await h.build();
  await service.installAndQuit();
  assert.equal(updater.calls.some(([name]) => name === 'quitAndInstall'), false, 'a resolved error status must abort the install handoff');
  assert.equal(service.isInstalling(), false, 'install lock reset for retry');
  assert.deepEqual(service.getStatus(), { state: 'error', version: null, percent: null });
  const failure = h.logs.find(({ event }) => event === 'update_gateway_stop_failed');
  assert.ok(failure, 'abort is logged');
  assert.match(failure.data.message, /shutdown could not be confirmed/, 'the resolved failure message is preserved');
  assert.equal(h.isQuitting(), false, 'quitting never flagged on the aborted path');
});

test('install retry proceeds after an aborted attempt once the child stop succeeds', async () => {
  const outcomes = [
    { state: 'error', code: 'START_FAILED', message: 'still running' },
    { state: 'stopped' }
  ];
  const h = harness({ stopGateway: async () => outcomes.shift() ?? { state: 'stopped' } });
  const { service, updater } = await h.build();
  await service.installAndQuit();
  assert.equal(updater.calls.some(([name]) => name === 'quitAndInstall'), false);
  await service.installAndQuit();
  assert.deepEqual(updater.calls.filter(([name]) => name === 'quitAndInstall')[0], ['quitAndInstall', false, true], 'second attempt installs after a confirmed stop');
  assert.equal(h.isQuitting(), true);
});

test('quit during update install is blocked by the before-quit guard until the child stop completes', async () => {
  const { handleBeforeQuit } = await import(built('before-quit-guard.js'));
  let resolveStop;
  const h = harness({ stopGateway: async () => { await new Promise((resolve) => { resolveStop = resolve; }); } });
  const { service, updater } = await h.build();
  const quitting = { value: false };
  const guardEvents = [];
  const prevented = [];
  let cleanups = 0;
  // Mirror the index.ts wiring: block quits while the install stop is in flight.
  const guardOptions = () => ({
    event: { preventDefault() { prevented.push(true); } },
    isQuitting: () => quitting.value,
    setQuitting: () => { quitting.value = true; },
    isControlled: () => false,
    isBlocked: () => service.isInstalling(),
    log: (level, event) => guardEvents.push(event),
    cleanupAndQuit: () => { cleanups += 1; }
  });

  // Baseline: without an install in flight a normal quit still runs cleanup.
  handleBeforeQuit(guardOptions());
  assert.equal(cleanups, 1);
  quitting.value = false;
  prevented.length = 0;
  guardEvents.length = 0;

  const install = service.installAndQuit();
  await flush(2);
  handleBeforeQuit(guardOptions());
  assert.deepEqual(prevented, [true], 'quit is prevented during install');
  assert.equal(cleanups, 1, 'no cleanup while the install stop is in flight');
  assert.equal(quitting.value, false, 'quitting flag untouched by the blocked attempt');
  assert.deepEqual(guardEvents, ['app_shutdown_blocked']);
  assert.equal(updater.calls.some(([name]) => name === 'quitAndInstall'), false);

  resolveStop();
  await install;
  assert.equal(h.isQuitting(), true, 'install itself flags quitting after the confirmed stop');
  assert.deepEqual(updater.calls.filter(([name]) => name === 'quitAndInstall')[0], ['quitAndInstall', false, true]);
});

test('before-quit guard blocked branch: prevents default, skips cleanup and quitting flag; gate stays optional', async () => {
  const { handleBeforeQuit } = await import(built('before-quit-guard.js'));
  const events = [];
  let prevented = false;
  let quitting = false;
  let cleanups = 0;
  handleBeforeQuit({
    event: { preventDefault() { prevented = true; } },
    isQuitting: () => quitting,
    setQuitting: () => { quitting = true; },
    isControlled: () => false,
    isBlocked: () => true,
    log: (level, event) => events.push(event),
    cleanupAndQuit: () => { cleanups += 1; }
  });
  assert.equal(prevented, true);
  assert.equal(quitting, false, 'blocked quit must NOT flag quitting (a retrying quit would then be swallowed)');
  assert.equal(cleanups, 0);
  assert.deepEqual(events, ['app_shutdown_blocked']);

  // Omitting the optional gate preserves the original shutdown semantics.
  cleanups = 0;
  prevented = false;
  events.length = 0;
  handleBeforeQuit({
    event: { preventDefault() { prevented = true; } },
    isQuitting: () => quitting,
    setQuitting: () => { quitting = true; },
    isControlled: () => false,
    log: (level, event) => events.push(event),
    cleanupAndQuit: () => { cleanups += 1; }
  });
  assert.equal(prevented, true);
  assert.equal(quitting, true);
  assert.equal(cleanups, 1);
  assert.deepEqual(events, ['app_shutdown_initiated']);
});

test('check re-entry is quashed while a dialog is pending, preserving background attribution (no stacked dialogs)', async () => {
  const dialog = fakeDialog(); // default "Later" once the microtasks flush
  const h = harness({ language: 'en', dialog });
  const { service, updater } = await h.build();
  await service.checkForUpdates({ manual: false });
  assert.equal(updater.calls.filter(([name]) => name === 'checkForUpdates').length, 1);
  updater.emit('update-available', { version: '1.1.0' });
  assert.equal(dialog.shown.length, 1, 'offer dialog is now pending');

  const status = await service.checkForUpdates({ manual: true });
  assert.equal(status.state, 'available', 'status does not flap while the dialog is pending');
  assert.equal(updater.calls.filter(([name]) => name === 'checkForUpdates').length, 1, 're-entry must not trigger another network check');
  assert.equal(dialog.shown.length, 1, 're-entry must not stack a second dialog');
  assert.equal(h.logs.some(({ event, data }) => event === 'update_check_skipped' && data.reason === 'busy'), true);

  await flush(); // user answered the offer with "Later"
  updater.emit('error', new Error('net down'));
  await flush();
  assert.equal(dialog.shown.length, 1, 'error dialog stays suppressed: attribution belongs to the background check, not the quashed manual one');
  assert.equal(service.getStatus().state, 'error');
});

test('postponed offer allows a fresh manual check; ready state re-presents the cached install prompt without network', async () => {
  const dialog = fakeDialog([1, 1, 1]); // offer: Later; second offer: Later; install prompt: Later
  const h = harness({ language: 'en', dialog });
  const { service, updater } = await h.build();
  await service.checkForUpdates({ manual: true });
  updater.emit('update-available', { version: '1.1.0' });
  await flush(); // Later -> dialogBusy clear, status stays available
  assert.equal(service.getStatus().state, 'available');

  await service.checkForUpdates({ manual: true });
  assert.equal(updater.calls.filter(([name]) => name === 'checkForUpdates').length, 2, 'a postponed offer must not lock out future checks');
  assert.equal(service.getStatus().state, 'checking');
  updater.emit('update-available', { version: '1.2.0' });
  await flush(); // Later again
  assert.equal(dialog.shown.length, 2, 'second offer appears only after the first was answered (no stacking)');
  assert.match(dialog.shown[1].message, /1\.2\.0/);

  updater.emit('update-downloaded', { version: '1.2.0' });
  await flush(); // install prompt: Later
  assert.equal(service.getStatus().state, 'ready');
  assert.equal(dialog.shown.length, 3);
  const networkChecks = updater.calls.filter(([name]) => name === 'checkForUpdates').length;
  await service.checkForUpdates({ manual: true });
  assert.equal(updater.calls.filter(([name]) => name === 'checkForUpdates').length, networkChecks, 'ready re-check re-presents from cache, no redundant network check');
  await flush();
  assert.equal(dialog.shown.length, 4, 'install prompt re-shown from cache');
  assert.equal(dialog.shown[3].title, 'Ready to install');
  assert.equal(h.logs.some(({ event }) => event === 'update_install_prompted'), true);
});

test('tray menu text reflects every updater state in both languages', async () => {
  const { getUpdateMenuText } = await import(built('auto-update.js'));
  assert.deepEqual(getUpdateMenuText({ state: 'none', version: null, percent: null }, 'en'), { checkLabel: 'Check for updates…', statusLabel: null, checkEnabled: true });
  assert.equal(getUpdateMenuText({ state: 'checking', version: null, percent: null }, 'en').checkEnabled, false, 're-entry disabled while checking');
  assert.equal(getUpdateMenuText({ state: 'downloading', version: '1.1.0', percent: 42 }, 'en').statusLabel, 'Downloading update… 42%');
  assert.equal(getUpdateMenuText({ state: 'downloading', version: '1.1.0', percent: 42 }, 'en').checkEnabled, false);
  assert.equal(getUpdateMenuText({ state: 'available', version: '1.1.0', percent: null }, 'ru').statusLabel, 'Доступно обновление: 1.1.0');
  assert.equal(getUpdateMenuText({ state: 'available', version: '1.1.0', percent: null }, 'en').checkEnabled, true, 'postponed offers stay re-checkable from the tray');
  assert.equal(getUpdateMenuText({ state: 'ready', version: '1.1.0', percent: null }, 'ru').statusLabel, 'Обновление готово к установке');
  assert.equal(getUpdateMenuText({ state: 'ready', version: '1.1.0', percent: null }, 'en').checkEnabled, true, 'a pending install prompt stays re-openable from the tray');
  assert.equal(getUpdateMenuText({ state: 'upToDate', version: null, percent: null }, 'ru').statusLabel, 'У вас последняя версия');
  assert.equal(getUpdateMenuText({ state: 'error', version: null, percent: null }, 'ru').statusLabel, null);
  assert.equal(getUpdateMenuText({ state: 'checking', version: null, percent: null }, 'ru').checkLabel, 'Проверить обновления…');
});

test('packaging guard fails fast without NVGW_GH_OWNER and reports the resolved publish target', async () => {
  const guard = path.join(root, 'scripts', 'packaging-env-guard.mjs');
  const run = (extraEnv) => {
    const env = { ...process.env };
    delete env.NVGW_GH_OWNER;
    delete env.NVGW_GH_REPO;
    return spawnSync(process.execPath, [guard], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  };
  const missing = run({});
  assert.notEqual(missing.status, 0, 'packaging must fail fast when the publish owner is unknown');
  assert.match(missing.stderr, /NVGW_GH_OWNER/, 'the fail-fast message names the missing variable');
  assert.match(missing.stderr, /defaults to "NV-Gateway"/, 'the fail-fast message documents the repo fallback');

  const resolved = run({ NVGW_GH_OWNER: 'octo-owner' });
  // The baked block is HaYkMnE/NV-Gateway, so any other owner must refuse to
  // package: the app would poll a repository this pipeline never publishes to.
  assert.notEqual(resolved.status, 0, 'an owner that disagrees with the baked publish block must fail packaging');
  assert.match(resolved.stderr, /does not bake the release target github\.com\/octo-owner\/NV-Gateway/);
  assert.match(resolved.stderr, /owner: octo-owner/, 'the message names the missing literal');

  const real = run({ NVGW_GH_OWNER: 'HaYkMnE' });
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /HaYkMnE\/NV-Gateway \(releaseType: release\)/, 'unset NVGW_GH_REPO falls back to NV-Gateway');

  // A repo override is honoured by the resolver, and the wiring check then
  // proves it no longer matches what electron-builder would bake.
  const custom = run({ NVGW_GH_OWNER: ' HaYkMnE ', NVGW_GH_REPO: 'custom-releases' });
  assert.notEqual(custom.status, 0, 'a repo override that the publish block does not bake must fail packaging');
  assert.match(custom.stderr, /github\.com\/HaYkMnE\/custom-releases/);

  const { resolvePublishEnvironment, DEFAULT_RELEASE_REPOSITORY } = await import(pathToFileURL(guard).href);
  assert.equal(DEFAULT_RELEASE_REPOSITORY, 'NV-Gateway');
  assert.equal(resolvePublishEnvironment({}).ok, false);
  assert.deepEqual(resolvePublishEnvironment({ NVGW_GH_OWNER: 'octo-owner' }), { ok: true, owner: 'octo-owner', repo: 'NV-Gateway' });
  assert.deepEqual(resolvePublishEnvironment({ NVGW_GH_OWNER: 'octo-owner', NVGW_GH_REPO: ' custom-releases ' }), { ok: true, owner: 'octo-owner', repo: 'custom-releases' });
  assert.deepEqual(resolvePublishEnvironment({ NVGW_GH_OWNER: '', NVGW_GH_REPO: 'custom-releases' }).ok, false, 'a blank owner counts as missing even with a repo set');
});

test('electron-builder wiring declares nsis+portable, env-macro publish, per-user NSIS, and preserves extraResources', () => {
  const builder = read('electron-builder.yml');
  assert.match(builder, /^  target:\r?\n    - nsis\r?\n    - portable$/m, 'win targets must be nsis (primary) and portable (kept)');
  for (const fragment of ['oneClick: false', 'allowToChangeInstallationDirectory: true', 'perMachine: false', 'createDesktopShortcut: true', 'shortcutName: NV-Gateway', 'runAfterFinish: true']) {
    assert.ok(builder.includes(fragment), `nsis block must declare ${fragment}`);
  }
  assert.match(builder, /artifactName: \$\{productName\}-Setup-\$\{version\}\.\$\{ext\}/, 'nsis artifact name carries product and version');
  assert.match(builder, /^appId: com\.susmnavorasem\.nvgateway$/m, 'appId (NSIS GUID basis) stays unchanged');
  assert.match(builder, /^publish:\r?\n  - provider: github\r?\n    owner: HaYkMnE\r?\n    repo: NV-Gateway\r?\n    releaseType: release$/m, 'publish block bakes this repository (same-repo releases)');
  assert.doesNotMatch(builder, /\$\{env\.NVGW_GH_/, 'the feed is a literal, not an env macro that a build could redirect');
  assert.match(builder, /forceCodeSigning: false/, 'code signing stays disabled (accepted)');
  assert.match(builder, /signAndEditExecutable: true/, 'Phase 5 icon fix: executable signing+edit enabled');

  // The extraResources payload must survive the edit. The engine now ships as a
  // prebuilt minified bundle (build/gateway -> gateway) rather than as readable
  // sources, and src/shared is no longer shipped at all: its only runtime
  // consumer was the engine and redaction.mjs is inlined into that bundle. Each
  // mapping is asserted as a contiguous from/to pair (explanatory comments are
  // allowed between entries), plus the asset filter verified by tray-icons.
  const normalized = builder.replace(/\r\n/g, '\n');
  assert.match(normalized, /^extraResources:$/m, 'extraResources section must remain');
  // The engine bundle ships INSIDE app.asar (a `files` entry), because ASAR
  // integrity validation only covers the archive. It used to be mapped as an
  // extraResource, i.e. outside that envelope, where a substituted engine ran
  // undetected. Both halves are asserted: present in `files`, absent from
  // `extraResources`.
  assert.ok(normalized.includes('  - build/gateway/**/*\n'),
    'the gateway bundle must be packed into app.asar via the files section');
  assert.equal(/^\s+- from: build\/gateway$/m.test(normalized), false,
    'the engine must NOT be mapped as an extraResource: that is outside ASAR integrity');
  assert.ok(normalized.includes([
    '  - from: build/assets',
    '    to: assets',
    '    filter:',
    '      - icon.png',
    '      - tray-*.svg',
    '      - tray-*-16.png',
    '      - tray-*-32.png'
  ].join('\n')), 'the asset mapping and its filter must stay intact');
  // Readable engine sources must NOT be shipped, in any mapping.
  assert.equal(/^\s+- from: src\/gateway$/m.test(normalized), false, 'src/gateway must never be shipped as sources');
  assert.equal(/^\s+- from: src\/shared$/m.test(normalized), false, 'src/shared must no longer be shipped');
});

test('packaging entry points are guarded by the env-aware electron-builder wrapper', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['build:portable'], /node scripts\/run-electron-builder\.mjs --win portable/, 'portable packaging goes through the guard');
  assert.match(pkg.scripts['package:dir'], /node scripts\/run-electron-builder\.mjs --dir/, 'unpacked packaging goes through the guard');
  assert.match(pkg.scripts['build:release'], /node scripts\/run-electron-builder\.mjs --win --publish never/, 'release packaging builds yml targets without uploading');
  assert.equal(pkg.scripts['package:env-guard'], 'node scripts/packaging-env-guard.mjs');
  assert.match(pkg.scripts['build:portable'], /package:audit/, 'existing static package audits are preserved');
  assert.match(pkg.scripts['package:dir'], /package:audit/, 'existing static package audits are preserved');
  assert.ok(pkg.dependencies['electron-updater'], 'electron-updater is a runtime dependency');
  // The release version is whatever package.json says now; what must hold is that it is a
  // real semver and that CHANGELOG.md has a dated section for exactly that version.
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'release version is a plain semver');
  assert.match(read('CHANGELOG.md'), new RegExp(`^## \\[${pkg.version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'),
    'CHANGELOG.md has a dated section for the package.json version');
  const main = read('src/main/index.ts');
  assert.match(main, /createAutoUpdateService/, 'the update service is wired in the main process');
  assert.match(main, /isBlocked: \(\) => updaterService\?\.isInstalling\(\) \?\? false/, 'the before-quit guard blocks Quit while an update install is in flight');
  const service = read('src/main/auto-update.ts');
  assert.match(service, /updater\.autoDownload = false/, 'offer-only: no background downloads');
  assert.match(service, /updater\.autoInstallOnAppQuit = false/, 'offer-only: no silent install on quit');
  // The wrapper is the ONLY electron-builder entry point left in package.json.
  const scriptsText = JSON.stringify(Object.values(pkg.scripts));
  assert.equal(scriptsText.includes('&& electron-builder'), false, 'no packaging script may bypass run-electron-builder.mjs');
  assert.equal(/\belectron-builder --/.test(scriptsText), false, 'electron-builder flags must go through the wrapper args');
});

/**
 * A dialog whose prompt calls REJECT, while error dialogs raised by handleError
 * still resolve. `promptTitle` identifies the operation under test: the offer
 * dialog's title is "availableTitle", the install dialog's is "readyTitle".
 */
function flakyDialog(promptTitle) {
  const shown = [];
  let failNext = true;
  return {
    shown,
    get failing() { return failNext; },
    set failing(value) { failNext = value; },
    showMessageBox: async (options) => {
      if (failNext && options.title === promptTitle) throw new Error('dialog unavailable');
      shown.push(options);
      return { response: 1 }; // "Later" — accept the dialog itself
    }
  };
}

/**
 * The install wiring is only correct if the adapter's RESOLVED stop status
 * reaches auto-update's error guard. This executes the adapter expression that
 * src/main/index.ts actually wires (no string equality on the literal) against
 * a lifecycle stub, then feeds the resulting function to the real service: an
 * `{state:'error'}` stop must abort the install, and a `{state:'stopped'}` stop
 * must still install.
 */
test('the wired stopGateway adapter propagates the lifecycle status, so an error stop aborts the install', async () => {
  const main = read('src/main/index.ts');
  const calls = autoUpdateCallArguments(main);
  assert.equal(calls.length, 1, 'the main process must call createAutoUpdateService exactly once');
  const wired = topLevelProperty(calls[0], 'stopGateway');
  assert.ok(wired, 'the createAutoUpdateService argument must declare a stopGateway adapter');

  const evaluateAdapter = (stopImpl) => {
    const sandbox = { gatewayLifecycle: { stop: stopImpl } };
    return vm.runInNewContext(`(${wired})`, sandbox, { filename: 'src/main/index.ts' });
  };

  const { createAutoUpdateService } = await import(built('auto-update.js'));
  const runInstall = async (stopResult) => {
    const { EventEmitter } = await import('node:events');
    const emitter = new EventEmitter();
    const calls = [];
    const logs = [];
    const service = createAutoUpdateService({
      updater: {
        autoDownload: true,
        autoInstallOnAppQuit: true,
        on: (name, listener) => emitter.on(name, listener),
        checkForUpdates: async () => {},
        downloadUpdate: async () => {},
        quitAndInstall: (...args) => calls.push(args)
      },
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      getLanguage: () => 'en',
      log: (level, event, data) => logs.push({ level, event, data }),
      setQuitting: () => {},
      stopGateway: evaluateAdapter(async () => stopResult),
      onStatusChanged: () => {},
      enabled: true
    });
    await service.installAndQuit();
    return { calls, logs, status: service.getStatus() };
  };

  const failed = await runInstall({ state: 'error', code: 'START_FAILED', message: 'Managed gateway child shutdown could not be confirmed.' });
  assert.equal(failed.calls.length, 0, 'an unconfirmed child stop must never reach quitAndInstall');
  assert.equal(failed.status.state, 'error', 'the abort surfaces an error state');
  const abortLog = failed.logs.find(({ event }) => event === 'update_gateway_stop_failed');
  assert.ok(abortLog, 'the aborted install is logged');
  assert.match(abortLog.data.message, /shutdown could not be confirmed/, 'the lifecycle message survives the adapter');

  const stopped = await runInstall({ state: 'stopped' });
  assert.deepEqual(stopped.calls, [[false, true]], 'a confirmed stop still hands off to quitAndInstall(false, true)');
});

test('a rejected offer dialog is handled, does not download, and releases the busy gate for a retry', async () => {
  const dialog = flakyDialog('Update available'); // en availableTitle
  const h = harness({ language: 'en', dialog });
  const { service, updater } = await h.build();
  await service.checkForUpdates({ manual: true }); // manual attribution: lastManual === true

  updater.emit('update-available', { version: '1.1.0' });
  await flush();
  // The rejection is routed through the shared error path...
  assert.equal(service.getStatus().state, 'error', 'a rejected dialog surfaces the error state');
  assert.deepEqual(
    h.logs.filter(({ event }) => event === 'update_error').map(({ data }) => data.manual),
    [true],
    'handleError receives the manual attribution'
  );
  // ...and the post-dialog download path is NOT reached.
  assert.equal(updater.calls.some(([name]) => name === 'downloadUpdate'), false, 'no download after a rejected dialog');
  assert.equal(service.getStatus().state === 'downloading', false);

  // The finally block still released dialogBusy, so a fresh manual check works:
  // the retry reaches a REAL dialog (recorded) instead of being quashed as busy.
  dialog.failing = false;
  await service.checkForUpdates({ manual: true });
  updater.emit('update-available', { version: '1.1.0' });
  await flush();
  // The forced manual check first raises the error dialog ("Later"), then the
  // retry presents the offer itself: the retry cleared dialogBusy and reached a
  // real dialog rather than being quashed as busy.
  assert.deepEqual(
    dialog.shown.map(({ buttons }) => buttons),
    [['Later'], ['Download', 'Later']],
    'a retry presents the offer dialog again (busy gate was released); the rejected attempt was never recorded'
  );
  assert.match(dialog.shown[1].message, /1\.1\.0/, 'the retry offers the same update');
});

test('a rejected install dialog is handled, does not install, and releases the busy gate for a retry', async () => {
  const dialog = flakyDialog('Ready to install'); // en readyTitle
  const h = harness({ language: 'en', dialog });
  const { service, updater } = await h.build();

  updater.emit('update-downloaded', { version: '1.1.0' });
  await flush();
  assert.equal(service.getStatus().state, 'error', 'a rejected install dialog surfaces the error state');
  assert.equal(h.logs.some(({ event }) => event === 'update_error'), true, 'the rejection is logged through handleError');
  assert.equal(updater.calls.some(([name]) => name === 'quitAndInstall'), false, 'no install handoff after a rejected dialog');
  assert.equal(h.isQuitting(), false, 'quitting is never flagged on the rejected path');
  assert.equal(service.isInstalling(), false, 'install lock stays free');
  assert.equal(service.getStatus().state === 'ready', false, 'the ready state was replaced by the error');
});

test('update i18n keys exist in EN and RU with natural Russian wording and full key parity', () => {
  const { en, ru } = loadTypeScriptExports('src/renderer/i18n/resources.ts');
  const updateKeys = ['updates', 'update_check', 'update_state_none', 'update_state_checking', 'update_state_available', 'update_state_downloading', 'update_state_ready', 'update_state_upToDate', 'update_state_error', 'update_progress', 'update_version'];
  for (const key of updateKeys) {
    assert.ok(en[key], `EN resources must define ${key}`);
    assert.ok(ru[key], `RU resources must define ${key}`);
  }
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort(), 'RU resources must stay in exact key parity with EN');
  assert.equal(ru.update_check, 'Проверить обновления');
  assert.equal(ru.update_state_available, 'Доступно обновление');
  assert.equal(ru.update_state_ready, 'Готово к установке');
  assert.equal(ru.update_state_upToDate, 'У вас последняя версия');
  assert.match(ru.update_progress, /Скачано \{\{percent\}\}%/, 'download progress carries the percent interpolation');
  // Renderer IPC surface for the Settings section.
  const preload = read('src/preload/index.ts');
  assert.match(preload, /get-update-status/);
  assert.match(preload, /check-for-updates/);
  const globals = read('src/renderer/global.d.ts');
  assert.match(globals, /UpdaterStatus/);
  assert.match(globals, /getUpdateStatus/);
  assert.match(globals, /checkForUpdates/);
});
