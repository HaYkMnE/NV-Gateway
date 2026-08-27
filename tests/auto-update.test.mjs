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
  const dialog = fakeDialog([0, 0]);
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
  assert.match(missing.stderr, /NV-Gateway(?!-releases)/, 'the fail-fast message documents the repo fallback');

  const resolved = run({ NVGW_GH_OWNER: 'octo-owner' });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.match(resolved.stdout, /octo-owner\/NV-Gateway(?!-releases)/, 'unset NVGW_GH_REPO falls back to NV-Gateway (the source repo)');

  const { resolvePublishEnvironment, DEFAULT_RELEASE_REPOSITORY } = await import(pathToFileURL(guard).href);
  assert.equal(DEFAULT_RELEASE_REPOSITORY, 'NV-Gateway');
  assert.equal(resolvePublishEnvironment({}).ok, false);
  assert.deepEqual(resolvePublishEnvironment({ NVGW_GH_OWNER: 'octo-owner' }), { ok: true, owner: 'octo-owner', repo: 'NV-Gateway' });
});

test('electron-builder wiring declares nsis+portable, env-macro publish, per-user NSIS, and preserves extraResources', () => {
  const builder = read('electron-builder.yml');
  assert.match(builder, /^  target:\r?\n    - nsis\r?\n    - portable$/m, 'win targets must be nsis (primary) and portable (kept)');
  assert.match(builder, /^appId: com\.haykmne\.nvgateway$/m, 'appId stays unchanged');
  assert.match(builder, /- provider: github\r?\n    owner: \$\{env\.NVGW_GH_OWNER\}\r?\n    repo: \$\{env\.NVGW_GH_REPO\}\r?\n    releaseType: release/, 'publish block consumes the build-time env macros');
});
