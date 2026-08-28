import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = pathToFileURL(path.join(root, 'build', 'src', 'main', 'explicit-legacy-migration-command.js')).href;
const startupBuilt = pathToFileURL(path.join(root, 'build', 'src', 'main', 'explicit-legacy-migration-startup.js')).href;
const mainProcessStartupBuilt = pathToFileURL(path.join(root, 'build', 'src', 'main', 'main-process-startup.js')).href;
const shutdownBuilt = pathToFileURL(path.join(root, 'build', 'src', 'main', 'controlled-startup-shutdown.js')).href;
const beforeQuitBuilt = pathToFileURL(path.join(root, 'build', 'src', 'main', 'before-quit-guard.js')).href;
const exclusionBuilt = pathToFileURL(path.join(root, 'build', 'src', 'main', 'legacy-migration-exclusion.js')).href;
const sandboxRoot = os.tmpdir();
const temporaryDirectories = new Set();
test.after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(sandboxRoot, prefix));
  temporaryDirectories.add(directory);
  return directory;
}

function createStartupOptions(calls, events, options = {}) {
  return {
    validateLegacySource: () => {
      calls.push('validate');
      if (options.validationError) throw options.validationError;
      return { keys: ['fake-key'], fingerprint: 'f'.repeat(64) };
    },
    initializeLifecycle: () => {
      calls.push('lifecycle');
      return { lifecycle: 'ready' };
    },
    runMigration: async () => {
      calls.push('migration');
      if (options.migrationError) throw options.migrationError;
      return { state: { keys: [] }, code: 'MIGRATED' };
    },
    startNormal: async () => calls.push('normal'),
    log: (level, event, data) => events.push({ level, event, data }),
    close: (exitCode) => calls.push(`close:${exitCode}`)
  };
}

function createFakeApp(calls) {
  return {
    setName: () => calls.push('setName'),
    whenReady: async () => calls.push('whenReady'),
    quit: () => calls.push('quit')
  };
}

test('production explicit startup validates before singleton handling and closes once for an invalid source', async () => {
  const { startMainProcess } = await import(mainProcessStartupBuilt);
  const calls = [];
  const events = [];
  let closeCalls = 0;

  const outcome = await startMainProcess({
    argv: ['electron', 'app', '--migrate-legacy-nvidia'],
    app: createFakeApp(calls),
    configureSingleInstance: () => {
      calls.push('configureSingleInstance');
      return false;
    },
    createApplicationStartupOptions: () => createStartupOptions(calls, events, {
      validationError: new Error('LEGACY_SOURCE_SHAPE')
    }),
    close: (exitCode) => {
      closeCalls += 1;
      calls.push(`close:${exitCode}`);
      calls.push('quit');
    }
  });

  assert.deepEqual(outcome, { status: 'known_failure', code: 'LEGACY_SOURCE_SHAPE' });
  assert.deepEqual(calls, ['setName', 'validate', 'close:1', 'quit']);
  assert.equal(closeCalls, 1);
  assert.deepEqual(events, [{
    level: 'error',
    event: 'explicit_legacy_migration_failed',
    data: { code: 'LEGACY_SOURCE_SHAPE' }
  }]);
  assert.deepEqual(events.map(({ event, data }) => ({ event, ...data })), [{
    event: 'explicit_legacy_migration_failed',
    code: 'LEGACY_SOURCE_SHAPE'
  }]);
  assert.equal(JSON.stringify(events).includes('message'), false);
  assert.equal(JSON.stringify(events).includes('stack'), false);
});

test('production explicit startup leaves an unknown failure for the installed fatal path', async () => {
  const { startMainProcess } = await import(mainProcessStartupBuilt);
  const calls = [];
  const events = [];
  const unexpected = new Error('UNEXPECTED_TEST_FAILURE');

  await assert.rejects(
    () => startMainProcess({
      argv: ['electron', 'app', '--migrate-legacy-nvidia'],
      app: createFakeApp(calls),
      configureSingleInstance: () => {
        calls.push('configureSingleInstance');
        return true;
      },
      createApplicationStartupOptions: () => createStartupOptions(calls, events, { migrationError: unexpected }),
      close: (exitCode) => calls.push(`close:${exitCode}`)
    }),
    (error) => error === unexpected
  );

  assert.deepEqual(calls, ['setName', 'validate', 'whenReady', 'lifecycle', 'migration']);
  assert.deepEqual(events, []);
});

test('production normal startup preserves setName, singleton, readiness, and lifecycle ordering', async () => {
  const { startMainProcess } = await import(mainProcessStartupBuilt);
  const calls = [];
  const events = [];

  const outcome = await startMainProcess({
    argv: ['electron', 'app'],
    app: createFakeApp(calls),
    configureSingleInstance: () => {
      calls.push('configureSingleInstance');
      return true;
    },
    createApplicationStartupOptions: () => createStartupOptions(calls, events),
    close: (exitCode) => calls.push(`close:${exitCode}`)
  });

  assert.deepEqual(outcome, { status: 'normal' });
  assert.deepEqual(calls, ['setName', 'configureSingleInstance', 'whenReady', 'lifecycle', 'normal']);
  assert.deepEqual(events, []);
});

test('regression: explicit migration names the app before the first userData resolution so lock and runtime share %APPDATA%\\NV-Gateway', async () => {
  const { startMainProcess } = await import(mainProcessStartupBuilt);
  // Fake Electron semantics: userData is cached on the first getPath('userData')
  // under the name current at that moment (the package.json name until setName).
  const appData = process.env.APPDATA ?? path.join(sandboxRoot, 'nvgw-fake-appdata');
  const expectedUserData = path.join(appData, 'NV-Gateway');
  const packageNameUserData = path.join(appData, 'nvidia-gateway-gui');
  let currentName = 'nvidia-gateway-gui';
  let cachedUserData;
  let lockRoot;
  const calls = [];
  const userDataResolutions = [];
  const app = {
    setName: (name) => {
      calls.push('setName');
      currentName = name;
    },
    whenReady: async () => calls.push('whenReady'),
    getPath: (key) => {
      if (key === 'appData') return appData;
      if (key !== 'userData') throw new Error(`unexpected getPath(${key})`);
      if (cachedUserData === undefined) {
        cachedUserData = path.join(appData, currentName);
        calls.push('getPath:userData');
      }
      userDataResolutions.push(cachedUserData);
      return cachedUserData;
    }
  };

  const outcome = await startMainProcess({
    argv: ['electron', 'app', '--migrate-legacy-nvidia'],
    app,
    configureSingleInstance: () => { throw new Error('explicit migration must not use the GUI singleton'); },
    createApplicationStartupOptions: () => ({
      validateLegacySource: () => {
        calls.push('validate');
        return { keys: ['fake-key'], fingerprint: 'f'.repeat(64) };
      },
      initializeLifecycle: () => {
        calls.push('lifecycle');
        return { lifecycle: 'ready' };
      },
      runMigration: async () => {
        calls.push('migration');
        return { state: { keys: [] }, code: 'MIGRATED' };
      },
      startNormal: async () => calls.push('normal'),
      log: () => {}
    }),
    // Production wiring (index.ts) resolves userData lazily inside lock acquisition.
    acquireLegacyMigrationLock: () => {
      calls.push('acquire');
      lockRoot = app.getPath('userData');
      return { release: () => calls.push('release') };
    },
    close: (exitCode) => calls.push(`close:${exitCode}`)
  });

  assert.deepEqual(outcome, { status: 'completed', result: { state: { keys: [] }, code: 'MIGRATED' } });
  assert.equal(calls[0], 'setName', 'app naming must be the first explicit-command startup operation');
  assert.ok(calls.indexOf('setName') < calls.indexOf('acquire'), 'setName must precede the exclusion-lock path resolution');
  assert.ok(calls.indexOf('setName') < calls.indexOf('getPath:userData'), 'setName must precede the first userData resolution');
  assert.equal(lockRoot, expectedUserData, 'the exclusion lock must resolve under %APPDATA%\\NV-Gateway, not the package.json name directory');
  assert.deepEqual(userDataResolutions, [expectedUserData], 'the first userData resolution must already be the product directory');
  assert.equal(app.getPath('userData'), expectedUserData, 'the cached userData stays under %APPDATA%\\NV-Gateway after startup');
  assert.equal(userDataResolutions.includes(packageNameUserData), false, 'userData must never resolve under the package.json name');
});

test('explicit successful startup validates the source before lifecycle initialization and migration', async () => {
  const { runApplicationStartup } = await import(startupBuilt);
  const calls = [];
  const source = { keys: ['fake-key'], fingerprint: 'f'.repeat(64) };

  const outcome = await runApplicationStartup({
    explicitLegacyMigration: true,
    validateLegacySource: () => {
      calls.push('validate');
      return source;
    },
    initializeLifecycle: () => {
      calls.push('lifecycle');
      return { state: 'ready' };
    },
    runMigration: async (receivedSource, lifecycle) => {
      calls.push('migration');
      assert.equal(receivedSource, source);
      assert.deepEqual(lifecycle, { state: 'ready' });
      return { state: { keys: [] }, code: 'MIGRATED' };
    },
    startNormal: async () => calls.push('normal'),
    log: () => calls.push('log'),
    close: () => calls.push('close')
  });

  assert.deepEqual(outcome, { status: 'completed', result: { state: { keys: [] }, code: 'MIGRATED' } });
  assert.deepEqual(calls, ['validate', 'lifecycle', 'migration', 'normal']);
});

test('explicit migration exclusion serializes valid commands, releases its own handle, and leaves an invalid source lock-free', async () => {
  const { startMainProcess } = await import(mainProcessStartupBuilt);
  const calls = [];
  const events = [];
  let locked = false;
  let allowFirstMigration;
  let firstMigrationEntered;
  const firstMigrationReady = new Promise((resolve) => { firstMigrationEntered = resolve; });
  const firstMigrationGate = new Promise((resolve) => { allowFirstMigration = resolve; });
  const sharedLock = {
    acquire: async () => {
      calls.push('acquire');
      if (locked) throw new Error('LEGACY_MIGRATION_IN_PROGRESS');
      locked = true;
      return {
        release: async () => {
          assert.equal(locked, true, 'only the owning command may release its lock');
          locked = false;
          calls.push('release');
        }
      };
    }
  };
  const createOptions = (label, options = {}) => ({
    validateLegacySource: () => {
      calls.push(`${label}:validate`);
      if (options.invalid) throw new Error('LEGACY_SOURCE_SHAPE');
      return { keys: ['fake-key'], fingerprint: 'f'.repeat(64) };
    },
    initializeLifecycle: () => {
      calls.push(`${label}:lifecycle`);
      return { lifecycle: 'ready' };
    },
    runMigration: async () => {
      calls.push(`${label}:migration`);
      if (label === 'first') {
        firstMigrationEntered();
        await firstMigrationGate;
      }
      if (options.error) throw options.error;
      return { state: { keys: [] }, code: 'MIGRATED' };
    },
    startNormal: async () => calls.push(`${label}:normal`),
    log: (level, event, data) => events.push({ level, event, data })
  });
  const app = {
    setName: () => calls.push('setName'),
    whenReady: async () => calls.push('whenReady')
  };
  const start = (label, options) => startMainProcess({
    argv: ['electron', 'app', '--migrate-legacy-nvidia'],
    app,
    configureSingleInstance: () => { throw new Error('explicit migration must not use the GUI singleton'); },
    createApplicationStartupOptions: () => createOptions(label, options),
    acquireLegacyMigrationLock: sharedLock.acquire,
    close: (exitCode) => calls.push(`${label}:close:${exitCode}`)
  });

  const firstPromise = start('first');
  await firstMigrationReady;
  const second = await start('second');
  assert.deepEqual(second, { status: 'known_failure', code: 'LEGACY_MIGRATION_IN_PROGRESS' });
  assert.equal(calls.includes('second:lifecycle'), false);
  assert.equal(calls.includes('second:migration'), false);
  assert.deepEqual(events, [{ level: 'error', event: 'explicit_legacy_migration_failed', data: { code: 'LEGACY_MIGRATION_IN_PROGRESS' } }]);

  allowFirstMigration();
  const first = await firstPromise;
  assert.deepEqual(first, { status: 'completed', result: { state: { keys: [] }, code: 'MIGRATED' } });
  assert.deepEqual(calls, ['setName', 'first:validate', 'acquire', 'whenReady', 'first:lifecycle', 'first:migration', 'setName', 'second:validate', 'acquire', 'second:close:1', 'release', 'first:normal']);

  const invalid = await start('invalid', { invalid: true });
  assert.deepEqual(invalid, { status: 'known_failure', code: 'LEGACY_SOURCE_SHAPE' });
  assert.deepEqual(calls.slice(-3), ['setName', 'invalid:validate', 'invalid:close:1']);

  const known = await start('known', { error: new Error('LEGACY_SOURCE_CHANGED') });
  assert.deepEqual(known, { status: 'known_failure', code: 'LEGACY_SOURCE_CHANGED' });
  assert.deepEqual(calls.slice(-8), ['setName', 'known:validate', 'acquire', 'whenReady', 'known:lifecycle', 'known:migration', 'release', 'known:close:1']);

  await assert.rejects(() => start('unknown', { error: new Error('UNEXPECTED_TEST_FAILURE') }), /UNEXPECTED_TEST_FAILURE/);
  assert.deepEqual(calls.slice(-7), ['setName', 'unknown:validate', 'acquire', 'whenReady', 'unknown:lifecycle', 'unknown:migration', 'release']);
});

test('production startup blocks a second command at the real directory lock until the first release completes', async () => {
  const { startMainProcess } = await import(mainProcessStartupBuilt);
  const { acquireLegacyMigrationExclusionLock } = await import(exclusionBuilt);
  const directory = temporaryDirectory('nvgw-migration-startup-lock-');
  const calls = [];
  let enterFirstMigration;
  let allowFirstMigration;
  const firstEntered = new Promise((resolve) => { enterFirstMigration = resolve; });
  const firstGate = new Promise((resolve) => { allowFirstMigration = resolve; });
  const createOptions = (label) => ({
    validateLegacySource: () => {
      calls.push(`${label}:validate`);
      return { keys: ['fake-key'], fingerprint: 'f'.repeat(64) };
    },
    initializeLifecycle: () => {
      calls.push(`${label}:lifecycle`);
      return { lifecycle: 'ready' };
    },
    runMigration: async () => {
      calls.push(`${label}:migration`);
      if (label === 'first') {
        enterFirstMigration();
        await firstGate;
      }
      return { state: { keys: [] }, code: 'MIGRATED' };
    },
    startNormal: async () => calls.push(`${label}:normal`),
    log: (_level, event, data) => calls.push(`${label}:log:${event}:${data.code}`)
  });
  const start = (label) => startMainProcess({
    argv: ['electron', 'app', '--migrate-legacy-nvidia'],
    app: { setName: () => calls.push(`${label}:setName`), whenReady: async () => calls.push(`${label}:whenReady`) },
    configureSingleInstance: () => { throw new Error('explicit migration must not use the GUI singleton'); },
    createApplicationStartupOptions: () => createOptions(label),
    acquireLegacyMigrationLock: () => acquireLegacyMigrationExclusionLock(directory),
    close: (exitCode) => calls.push(`${label}:close:${exitCode}`)
  });

  const firstPromise = start('first');
  await firstEntered;
  const second = await start('second');
  assert.deepEqual(second, { status: 'known_failure', code: 'LEGACY_MIGRATION_IN_PROGRESS' });
  assert.deepEqual(calls, [
    'first:setName', 'first:validate', 'first:whenReady', 'first:lifecycle', 'first:migration',
    'second:setName', 'second:validate', 'second:log:explicit_legacy_migration_failed:LEGACY_MIGRATION_IN_PROGRESS', 'second:close:1'
  ]);

  allowFirstMigration();
  const first = await firstPromise;
  assert.deepEqual(first, { status: 'completed', result: { state: { keys: [] }, code: 'MIGRATED' } });
  assert.deepEqual(calls.slice(-1), ['first:normal']);

  const third = await start('third');
  assert.deepEqual(third, { status: 'completed', result: { state: { keys: [] }, code: 'MIGRATED' } });
  assert.deepEqual(calls.slice(-6), ['third:setName', 'third:validate', 'third:whenReady', 'third:lifecycle', 'third:migration', 'third:normal']);
});

test('a migration lock release error remains on the fatal path and its fail-closed resource can be released after repair', async () => {
  const { startMainProcess } = await import(mainProcessStartupBuilt);
  const { acquireLegacyMigrationExclusionLock, LEGACY_MIGRATION_EXCLUSION_LOCK_NAME } = await import(exclusionBuilt);
  const directory = temporaryDirectory('nvgw-migration-release-error-');
  const lockPath = path.join(directory, LEGACY_MIGRATION_EXCLUSION_LOCK_NAME);
  const calls = [];
  let owner;

  await assert.rejects(() => startMainProcess({
    argv: ['electron', 'app', '--migrate-legacy-nvidia'],
    app: { setName: () => calls.push('setName'), whenReady: async () => calls.push('whenReady') },
    configureSingleInstance: () => true,
    createApplicationStartupOptions: () => ({
      validateLegacySource: () => ({ keys: ['fake-key'], fingerprint: 'f'.repeat(64) }),
      initializeLifecycle: () => ({ lifecycle: 'ready' }),
      runMigration: async () => ({ state: { keys: [] }, code: 'MIGRATED' }),
      startNormal: async () => calls.push('normal'),
      log: () => calls.push('log')
    }),
    acquireLegacyMigrationLock: () => {
      owner = acquireLegacyMigrationExclusionLock(directory);
      return {
        release: () => {
          fs.writeFileSync(path.join(lockPath, 'foreign-state'), 'foreign', 'utf8');
          owner.release();
        }
      };
    },
    close: () => calls.push('close')
  }), /LEGACY_MIGRATION_LOCK_UNAVAILABLE/);

  // The injected competing entry leaves the resource fail-closed. Repair is
  // external; the failed handle is terminal and cannot perform it on retry.
  fs.unlinkSync(path.join(lockPath, 'foreign-state'));
  fs.rmdirSync(lockPath);
  owner.release();
  assert.equal(fs.existsSync(lockPath), false);
  const repairedOwner = acquireLegacyMigrationExclusionLock(directory);
  repairedOwner.release();
  assert.deepEqual(calls, ['setName', 'whenReady']);
});

test('production before-quit guard skips normal shutdown after controlled command closure while preserving one quit and exit code', async () => {
  const { createControlledStartupShutdown } = await import(shutdownBuilt);
  const { handleBeforeQuit } = await import(beforeQuitBuilt);
  let controlled = false;
  let exitCode;
  let quits = 0;
  let quitting = false;
  let normalShutdowns = 0;
  const events = [];
  const shutdown = createControlledStartupShutdown({
    setControlled: () => { controlled = true; },
    setExitCode: (value) => { exitCode = value; },
    quit: () => { quits += 1; }
  });

  shutdown.close(1);
  shutdown.close(1);
  const beforeQuitEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  handleBeforeQuit({
    event: beforeQuitEvent,
    isQuitting: () => quitting,
    setQuitting: () => { quitting = true; },
    isControlled: () => shutdown.isControlled(),
    log: (level, event, data) => events.push({ level, event, data }),
    cleanupAndQuit: () => { normalShutdowns += 1; }
  });
  handleBeforeQuit({
    event: { preventDefault() { throw new Error('duplicate before-quit must not prevent again'); } },
    isQuitting: () => quitting,
    setQuitting: () => { quitting = true; },
    isControlled: () => shutdown.isControlled(),
    log: () => { throw new Error('duplicate before-quit must not log'); },
    cleanupAndQuit: () => { normalShutdowns += 1; }
  });

  assert.equal(controlled, true);
  assert.equal(exitCode, 1);
  assert.equal(quits, 1);
  assert.equal(normalShutdowns, 0);
  assert.equal(beforeQuitEvent.prevented, false);
  assert.deepEqual(events, []);
});

test('regression proof: old file compare-unlink deletes a forced successor while directory release has no check-unlink window', async () => {
  const { acquireLegacyMigrationExclusionLock, LEGACY_MIGRATION_EXCLUSION_LOCK_NAME } = await import(exclusionBuilt);
  const directory = temporaryDirectory('nvgw-migration-exclusion-');
  const lockPath = path.join(directory, LEGACY_MIGRATION_EXCLUSION_LOCK_NAME);
  const oldMarker = Buffer.from('{"owner":"old"}', 'utf8');
  const successorMarker = Buffer.from('{"owner":"successor"}', 'utf8');

  fs.writeFileSync(lockPath, oldMarker);
  const checked = fs.readFileSync(lockPath);
  assert.deepEqual(checked, oldMarker);
  fs.writeFileSync(lockPath, successorMarker);
  fs.unlinkSync(lockPath);
  assert.equal(fs.existsSync(lockPath), false, 'the old read/equals/unlink primitive deletes the successor forced after its check');

  const owner = acquireLegacyMigrationExclusionLock(directory);
  assert.equal(fs.lstatSync(lockPath).isDirectory(), true, 'exclusive ownership must be a directory namespace entry');
  assert.throws(() => acquireLegacyMigrationExclusionLock(directory), (error) => error.message === 'LEGACY_MIGRATION_IN_PROGRESS');
  owner.release();
  const successor = acquireLegacyMigrationExclusionLock(directory);
  owner.release();
  assert.equal(fs.lstatSync(lockPath).isDirectory(), true, 'an old handle must not erase a successor acquired after its release');
  successor.release();
});

test('migration exclusion lock preserves foreign existing state, fails closed, and failed release is terminal', async () => {
  const { acquireLegacyMigrationExclusionLock, LEGACY_MIGRATION_EXCLUSION_LOCK_NAME } = await import(exclusionBuilt);
  const directory = temporaryDirectory('nvgw-migration-exclusion-');
  const lockPath = path.join(directory, LEGACY_MIGRATION_EXCLUSION_LOCK_NAME);

  fs.writeFileSync(lockPath, '{"foreign":"marker"}', 'utf8');
  assert.throws(() => acquireLegacyMigrationExclusionLock(directory), (error) => error.message === 'LEGACY_MIGRATION_IN_PROGRESS');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '{"foreign":"marker"}');
  fs.unlinkSync(lockPath);

  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'malformed-state'), 'foreign', 'utf8');
  assert.throws(() => acquireLegacyMigrationExclusionLock(directory), (error) => error.message === 'LEGACY_MIGRATION_IN_PROGRESS');
  assert.equal(fs.existsSync(path.join(lockPath, 'malformed-state')), true);
  fs.rmSync(lockPath, { recursive: true });

  const owner = acquireLegacyMigrationExclusionLock(directory);
  fs.writeFileSync(path.join(lockPath, 'foreign-state'), 'foreign', 'utf8');
  assert.throws(() => owner.release(), (error) => error.message === 'LEGACY_MIGRATION_LOCK_UNAVAILABLE');
  assert.equal(fs.existsSync(lockPath), true, 'failed release keeps ambiguous state fail-closed');
  fs.unlinkSync(path.join(lockPath, 'foreign-state'));
  fs.rmdirSync(lockPath);

  const successor = acquireLegacyMigrationExclusionLock(directory);
  owner.release();
  assert.equal(fs.existsSync(lockPath), true, 'a terminal failed handle must not erase a manually repaired successor');
  successor.release();
  owner.release();
  assert.equal(fs.existsSync(lockPath), false, 'successful idempotent release leaves no owned resource');
});

test('separate processes observe fixed directory exclusion and a terminal failed owner cannot erase a successor', async () => {
  const { acquireLegacyMigrationExclusionLock, LEGACY_MIGRATION_EXCLUSION_LOCK_NAME } = await import(exclusionBuilt);
  const directory = temporaryDirectory('nvgw-migration-process-release-race-');
  const lockPath = path.join(directory, LEGACY_MIGRATION_EXCLUSION_LOCK_NAME);
  const workerPath = path.join(directory, 'lock-worker.cjs');
  const readyPath = path.join(directory, 'successor-ready');
  const releasePath = path.join(directory, 'successor-release');
  const worker = `
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const [,, modulePath, userDataPath, readyPath, releasePath] = process.argv;
(async () => {
  const { acquireLegacyMigrationExclusionLock } = await import(pathToFileURL(modulePath).href);
  let lock;
  try {
    lock = acquireLegacyMigrationExclusionLock(userDataPath);
  } catch (error) {
    process.exit(error && error.message === 'LEGACY_MIGRATION_IN_PROGRESS' ? 10 : 11);
    return;
  }
  if (readyPath) {
    fs.writeFileSync(readyPath, 'ready', { flag: 'wx' });
    while (!fs.existsSync(releasePath)) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try {
    lock.release();
    process.exit(0);
  } catch {
    process.exit(12);
  }
})().catch(() => process.exit(13));
`;
  fs.writeFileSync(workerPath, worker, 'utf8');
  const runWorker = (ready = '', release = '') => spawn(process.execPath, [workerPath, path.join(root, 'build', 'src', 'main', 'legacy-migration-exclusion.js'), directory, ready, release], { stdio: 'ignore' });
  const waitForExit = (child) => new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const waitForFile = async (filePath, child) => {
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(filePath)) {
      if (child.exitCode !== null) throw new Error(`worker exited before ready: ${child.exitCode}`);
      if (Date.now() >= deadline) throw new Error('worker readiness timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  let successor;

  try {
    const owner = acquireLegacyMigrationExclusionLock(directory);
    const blocked = await waitForExit(runWorker());
    assert.deepEqual(blocked, { code: 10, signal: null }, 'the fixed directory must block a second process');

    fs.writeFileSync(path.join(lockPath, 'foreign-state'), 'foreign', 'utf8');
    assert.throws(() => owner.release(), (error) => error.message === 'LEGACY_MIGRATION_LOCK_UNAVAILABLE');
    fs.rmSync(lockPath, { recursive: true });

    successor = runWorker(readyPath, releasePath);
    await waitForFile(readyPath, successor);
    owner.release();
    assert.equal(fs.existsSync(lockPath), true, 'the old process handle is terminal and cannot remove the successor directory');

    fs.writeFileSync(releasePath, 'release', { flag: 'wx' });
    assert.deepEqual(await waitForExit(successor), { code: 0, signal: null }, 'the successor releases its own directory');
    successor = undefined;
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    if (successor && successor.exitCode === null) successor.kill();
  }
});

test('unknown explicit migration failures escape the command boundary unchanged', async () => {
  const { runExplicitLegacyMigrationCommand } = await import(built);
  const unexpected = new Error('UNEXPECTED_TEST_FAILURE');
  const events = [];
  let closeCalls = 0;

  await assert.rejects(
    () => runExplicitLegacyMigrationCommand({
      run: async () => { throw unexpected; },
      log: (level, event, data) => events.push({ level, event, data }),
      close: async () => { closeCalls += 1; }
    }),
    (error) => error === unexpected
  );

  assert.deepEqual(events, []);
  assert.equal(closeCalls, 0);
});
