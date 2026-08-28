// Phase 5: opt out of the nvidia-catalog-sync top-level background warm so this
// test process does not make real NGC network calls during the admin-api import
// (admin-api.mjs now imports nvidia-catalog-sync.mjs, which self-warms at top
// level unless NGC_CATALOG_SYNC_DISABLE_WARM=1). Tests here do not invoke any
// handler that calls getAllModelMetadata(), so the metadata cache itself is
// irrelevant; disabling the warm keeps the test hermetic without changing its
// observations.
process.env.NGC_CATALOG_SYNC_DISABLE_WARM = "1";

import os from 'node:os';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const sandboxRoot = os.tmpdir();
const temporaryDirectories = new Set();
const reservationDirectory = path.join(sandboxRoot, 'nvgw-test-port-reservations');
const pairReservations = new Set();
const productionMigrationPort = migrationPortFromSource();

fs.mkdirSync(reservationDirectory, { recursive: true });

test.after(() => {
  for (const reservation of pairReservations) releaseReservation(reservation);
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(sandboxRoot, prefix));
  temporaryDirectories.add(directory);
  return directory;
}

test('secure store migrates both plaintext files and persists encrypted credentials atomically', async () => {
  const { SecureStore } = await import(built('secure-state.js'));
  const dir = temporaryDirectory('nvgw-store-');
  const sentinel = 'nvapi-PLAINTEXT-SENTINEL';
  const statePath = path.join(dir, 'keys.json');
  fs.writeFileSync(statePath, JSON.stringify({ keys: [{ id: 'x', key: sentinel }] }));
  fs.writeFileSync(`${statePath}.bak`, JSON.stringify({ keys: [{ id: 'y', key: `${sentinel}-bak` }] }));
  const protectedPaths = [];
  const adapter = { encrypt: (v) => Buffer.from(v).map((b) => b ^ 0xaa), decrypt: (v) => Buffer.from(v).map((b) => b ^ 0xaa) };
  const store = new SecureStore(statePath, adapter, (value) => protectedPaths.push(path.resolve(value)));
  const loaded = store.initialize();
  assert.equal(loaded.keys[0].key, sentinel);
  store.persist({ ...loaded, credentials: { gatewayToken: 'gateway-sentinel', adminToken: 'admin-sentinel' } });
  for (const entry of fs.readdirSync(dir)) {
    const bytes = fs.readFileSync(path.join(dir, entry));
    assert.equal(bytes.includes(Buffer.from(sentinel)), false, entry);
    assert.equal(bytes.includes(Buffer.from('gateway-sentinel')), false, entry);
  }
  assert.equal(fs.existsSync(`${statePath}.bak`), false);
  assert.ok(protectedPaths.some((value) => value.endsWith('keys.json')));
  assert.ok(protectedPaths.some((value) => value.endsWith('keys.json.encrypted.bak')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('private channel binds a child-generated challenge to the attached IPC child', async () => {
  const { createPrivateStateChannel } = await import(built('private-state-channel.js'));
  const messages = [];
  const child = new EventEmitter(); child.connected = true; child.send = (value) => messages.push(value);
  let persisted;
  const channel = createPrivateStateChannel({ initialState: { keys: [{ key: 'secret' }] }, persist: (state) => { persisted = state; } });
  channel.attach(child);
  child.emit('message', { type: 'ready', challenge: '' });
  assert.equal(messages.length, 0);
  child.emit('message', { type: 'ready', challenge: 'child-random-challenge-1234567890' });
  assert.deepEqual(messages[0], { type: 'state:init', challenge: 'child-random-challenge-1234567890', state: { keys: [{ key: 'secret' }] } });
  child.emit('message', { type: 'state:persist', state: { keys: [] } });
  assert.deepEqual(persisted, { keys: [] });
  assert.equal(channel.authenticated, true);
  assert.equal(channel.initializationSent, true);
  assert.equal(channel.challenge, 'child-random-challenge-1234567890');
});

test('spawn options contain no state path or explicit gateway credential in argv or environment', async () => {
  const runtime = await import(built('gateway-runtime.js'));
  const dir = temporaryDirectory('nvgw-runtime-');
  const paths = runtime.ensureGatewayRuntime(dir);
  const options = runtime.createGatewaySpawnOptions('C:\\app\\server.mjs', paths, 12000);
  const text = JSON.stringify(options);
  assert.equal(text.includes('nvidia-local-key'), false);
  assert.equal(text.includes(paths.statePath), false);
  assert.equal('GATEWAY_STATE_PATH' in options.env, false);
  assert.equal('GATEWAY_LOCAL_TOKEN' in options.env, false);
  assert.equal('GATEWAY_ADMIN_TOKEN' in options.env, false);
  assert.deepEqual(options.args, ['C:\\app\\server.mjs']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('IPC validation requires exact main webContents and validates all admin arguments', async () => {
  const { validateIpcSender, validators } = await import(built('ipc-security.js'));
  const contents = {};
  const frame = { url: 'file:///app/index.html', parent: null };
  assert.doesNotThrow(() => validateIpcSender({ sender: contents, senderFrame: frame }, contents, [frame.url]));
  assert.doesNotThrow(() => validateIpcSender({ sender: contents, senderFrame: { url: `${frame.url}#/wizard`, parent: null } }, contents, [frame.url]));
  assert.throws(() => validateIpcSender({ sender: contents, senderFrame: { url: `${frame.url}?route=wizard`, parent: null } }, contents, [frame.url]), /origin/);
  assert.throws(() => validateIpcSender({ sender: contents, senderFrame: { url: 'file:///app/other.html#/wizard', parent: null } }, contents, [frame.url]), /origin/);
  assert.throws(() => validateIpcSender({ sender: {}, senderFrame: frame }, contents, [frame.url]), /webContents/);
  assert.doesNotThrow(() => validators.key('nvapi-test'));
  assert.throws(() => validators.key('bad key'), /key/);
  assert.doesNotThrow(() => validators.uuid('550e8400-e29b-41d4-a716-446655440000'));
  assert.throws(() => validators.status('root'), /status/);
  assert.throws(() => validators.reorder(['550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000']), /reorder/);
});

test('CSP helper removes inline styles and denies permissions, popups and navigation', async () => {
  const security = await import(built('electron-security.js'));
  assert.equal(security.PRODUCTION_CSP.includes("'unsafe-inline'"), false);
  assert.match(security.PRODUCTION_CSP, /style-src 'self'/);
  const events = [];
  const contents = { setWindowOpenHandler: (fn) => events.push(fn()), on: (_name, fn) => { const event = { preventDefault: () => events.push('blocked') }; fn(event, 'https://evil.test'); } };
  security.secureWebContents(contents, 'file:///app/index.html');
  assert.deepEqual(events, [{ action: 'deny' }, 'blocked']);
});

test('production Electron installer registers headers, permission denial and exact packaged URL policy', async () => {
  const security = await import(built('electron-security.js'));
  let headersListener; let permissionHandler; let popupHandler; let navigateHandler;
  const targetSession = {
    webRequest: { onHeadersReceived: (fn) => { headersListener = fn; } },
    setPermissionRequestHandler: (fn) => { permissionHandler = fn; }
  };
  const contents = {
    setWindowOpenHandler: (fn) => { popupHandler = fn; },
    on: (name, fn) => { if (name === 'will-navigate') navigateHandler = fn; }
  };
  security.installElectronSecurity({ targetSession, contents, exactUrl: 'file:///C:/app/renderer/index.html' });
  let denied; permissionHandler({}, 'camera', (value) => { denied = value; });
  assert.equal(denied, false);
  assert.deepEqual(popupHandler(), { action: 'deny' });
  let blocked = false; navigateHandler({ preventDefault: () => { blocked = true; } }, 'file:///C:/app/renderer/other.html');
  assert.equal(blocked, true);
  blocked = false; navigateHandler({ preventDefault: () => { blocked = true; } }, 'file:///C:/app/renderer/index.html');
  assert.equal(blocked, false);
  let response; headersListener({ responseHeaders: { 'X-Test': ['kept'] } }, (value) => { response = value; });
  assert.deepEqual(response.responseHeaders['X-Test'], ['kept']);
  assert.equal(response.responseHeaders['Content-Security-Policy'][0].includes("'unsafe-inline'"), false);
});

test('Windows ACL production hook uses injected SID/executor and directory inheritance rules', async () => {
  const acl = await import(built('windows-acl.js'));
  const calls = [];
  const protect = acl.createWindowsAclProtector({ sid: '*S-1-5-21-42', platform: 'win32', execute: (command, args) => { calls.push({ command, args }); return { status: 0 }; } });
  protect('C:\\runtime', true); protect('C:\\runtime\\keys.json', false);
  assert.equal(calls[0].command, 'icacls.exe');
  assert.ok(calls[0].args.includes('*S-1-5-21-42:(OI)(CI)(F)'));
  assert.ok(calls[1].args.includes('*S-1-5-21-42:(F)'));
  // Phase 4 (2026-08-16): protector now NEVER throws across the bridge to main —
  // it does a bounded retry then logs + degrades (file is already mode 0o600 from
  // the open() that precedes protectFile; ACL is additional hardening only).
  const degradedCalls = [];
  const originalWarn = console.warn;
  console.warn = (msg) => degradedCalls.push(String(msg));
  try {
    assert.doesNotThrow(() =>
      acl.createWindowsAclProtector({ sid: '*S-1-5-21-42', platform: 'win32', execute: () => ({ status: 5 }) })('C:\\runtime', true)
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    degradedCalls.some((line) => line.includes('ACL protectFile degraded')),
    'expected a degrade warning to be emitted instead of throwing on non-zero icacls status'
  );
});

test('runtime protects directories with inheritance and precreates every primary log before child startup', async () => {
  const runtime = await import(built('gateway-runtime.js'));
  const dir = temporaryDirectory('nvgw-acl-runtime-');
  const calls = [];
  const paths = runtime.ensureGatewayRuntime(dir, {
    protectDirectory: (value) => calls.push(['directory', path.resolve(value)]),
    protectFile: (value) => calls.push(['file', path.resolve(value)])
  });
  assert.deepEqual(calls.slice(0, 2), [['directory', path.resolve(dir)], ['directory', path.resolve(dir, 'logs')]]);
  for (const file of [paths.configPath, paths.logPath, paths.appLogPath, paths.stdioLogPath]) {
    assert.equal(fs.existsSync(file), true, file);
    assert.ok(calls.some(([kind, value]) => kind === 'file' && value === path.resolve(file)), file);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normal runtime initialization leaves an existing app config byte-for-byte unchanged', async () => {
  const runtime = await import(built('gateway-runtime.js'));
  const dir = temporaryDirectory('nvgw-inert-runtime-');
  const original = '{\n  "gatewayPort": 12000,\n  "setupComplete": true,\n  "custom": "preserve"\n}\n';
  fs.writeFileSync(path.join(dir, 'config.json'), original);
  runtime.ensureGatewayRuntime(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), original);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runtime ACL setup fails closed when directory or log protection fails', async () => {
  const runtime = await import(built('gateway-runtime.js'));
  const dir = temporaryDirectory('nvgw-acl-fail-');
  assert.throws(() => runtime.ensureGatewayRuntime(dir, { protectDirectory: () => { throw new Error('directory denied'); }, protectFile: () => {} }), /directory denied/);
  assert.throws(() => runtime.ensureGatewayRuntime(dir, { protectDirectory: () => {}, protectFile: () => { throw new Error('file denied'); } }), /file denied/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('secure store preserves a verified old copy at every injected transaction boundary', async () => {
  const { SecureStore, decodeEncryptedState } = await import(built('secure-state.js'));
  const adapter = { encrypt: (v) => Buffer.from(v).reverse(), decrypt: (v) => Buffer.from(v).reverse() };
  const boundaries = ['write-primary', 'fsync-primary', 'verify-primary', 'write-recovery', 'fsync-recovery', 'verify-recovery', 'replace-primary', 'replace-recovery'];
  for (const boundary of boundaries) {
    const dir = temporaryDirectory(`nvgw-txn-${boundary}-`);
    const statePath = path.join(dir, 'keys.json');
    const initial = new SecureStore(statePath, adapter, () => {});
    initial.persist({ keys: [{ key: 'old-value' }] });
    const failing = new SecureStore(statePath, adapter, () => {}, { boundary: (name) => { if (name === boundary) throw new Error(boundary); } });
    assert.throws(() => failing.persist({ keys: [{ key: 'new-value' }] }), new RegExp(boundary));
    const candidates = [statePath, `${statePath}.encrypted.bak`].filter(fs.existsSync).map((value) => decodeEncryptedState(fs.readFileSync(value), adapter));
    assert.ok(candidates.some((value) => value.keys[0].key === 'old-value'), boundary);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('actual lifecycle spawn boundary excludes secrets and sends state only after child challenge', async () => {
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const runtime = await import(built('gateway-runtime.js'));
  const dir = temporaryDirectory('nvgw-spawn-boundary-');
  const paths = runtime.ensureGatewayRuntime(dir);
  const secret = 'FAKE-SPAWN-SECRET-SENTINEL';
  let sent;
  let child;
  let start;
  let captured;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    sent = [];
    const capturedSpawn = createSpawnCapture();
    child = new EventEmitter();
    child.pid = 42; child.exitCode = null; child.killed = false; child.connected = true;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.send = (value) => sent.push(value);
    child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0, null); return true; };
    const instance = new GatewayLifecycle({ executablePath: 'C:\\Electron\\electron.exe', serverPath: 'C:\\app\\gateway\\server.mjs', runtimePaths: paths,
      initialState: { keys: [{ key: secret }], credentials: { gatewayToken: secret, adminToken: secret } }, startupTimeoutMs: 20, healthPollIntervalMs: 1,
      spawnChild: (command, args, options) => {
        try {
          capturedSpawn.capture({ command, args, options });
          return child;
        } catch (error) {
          capturedSpawn.fail(error);
          throw error;
        }
      } });
    start = instance.start(await getFreePair());
    try {
      captured = await capturedSpawn.wait(start);
      break;
    } catch (error) {
      await start;
      if (attempt === 9 || !String(error.message).includes('lifecycle returned error')) throw error;
    }
  }
  assert.ok(captured, 'spawnChild must be reached after bounded transient port-conflict retries');
  assert.equal(sent.length, 0);
  const serializedBoundary = JSON.stringify(captured);
  assert.equal(serializedBoundary.includes(secret), false);
  assert.deepEqual(captured.options.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
  assert.equal(serializedBoundary.includes(paths.ownerPath), false);
  assert.equal(serializedBoundary.includes(paths.statePath), false);
  child.emit('message', { type: 'ready', challenge: 'valid-child-challenge-123456789' });
  assert.equal(JSON.stringify(sent[0]).includes(secret), true);
  await start;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('source console policy has no renderer console and fixed literal-only remaining console calls', () => {
  const renderer = fs.readdirSync(path.join(root, 'src', 'renderer', 'views')).filter((name) => name.endsWith('.tsx'))
    .map((name) => fs.readFileSync(path.join(root, 'src', 'renderer', 'views', name), 'utf8')).join('\n');
  assert.doesNotMatch(renderer, /console\s*\./);
  const sources = ['src/main/app-logger.ts', 'src/gateway/server.mjs'].map((name) => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
  for (const match of sources.matchAll(/console\.(?:log|error|warn)\(([^\n]+)\)/g)) assert.match(match[1], /^\s*["'][^"']*["']\s*$/);
});

function createSpawnCapture() {
  let settled = false;
  let resolveCapture;
  let rejectCapture;
  const captured = new Promise((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject; });
  const timeout = setTimeout(() => fail(new Error('spawnChild did not signal captured arguments within 250ms.')), 250);
  const finish = (settler, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    settler(value);
  };
  return {
    capture(value) { finish(resolveCapture, value); },
    fail(error) { finish(rejectCapture, error); },
    wait(start) {
      return Promise.race([
        captured,
        start.then(
          (status) => Promise.reject(new Error(`spawnChild did not signal captured arguments: lifecycle returned ${status.state}.`)),
          (error) => Promise.reject(error)
        )
      ]).finally(() => clearTimeout(timeout));
    }
  };
}

test('spawn capture rejects deterministically when lifecycle completes without a callback', async () => {
  const capture = createSpawnCapture();
  await assert.rejects(() => capture.wait(Promise.resolve({ state: 'error' })), /did not signal captured arguments/);
});

function migrationPortFromSource() {
  const source = fs.readFileSync(path.join(root, 'src', 'main', 'final-migration-workflow.ts'), 'utf8');
  const match = source.match(/FINAL_MIGRATION_PORT = (\d+)/);
  assert.ok(match, 'production migration port must be discoverable');
  return Number(match[1]);
}

async function getFreePair() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const gateway = net.createServer();
    try {
      const port = 40000 + ((process.pid * 2 + attempt * 2) % 25000);
      await listen(gateway, port);
      await close(gateway);
      if (port >= 65535 || [productionMigrationPort, productionMigrationPort + 1].includes(port) || [productionMigrationPort, productionMigrationPort + 1].includes(port + 1)) continue;
      const admin = net.createServer();
      try {
        await listen(admin, port + 1);
        await close(admin);
      } catch {
        await close(admin).catch(() => {});
        continue;
      }
      const reservation = claimPair(port);
      if (!reservation) continue;
      try {
        await assertPairAvailable(port);
        pairReservations.add(reservation);
        return port;
      } catch {
        releaseReservation(reservation);
      }
    } catch {
      await close(gateway).catch(() => {});
    }
  }
  throw new Error('No paired test port is available.');
}

function claimPair(port, fileSystem = fs) {
  const reservations = [port, port + 1].map((candidate) => path.join(reservationDirectory, `port-${candidate}.lock`));
  const acquired = [];
  for (const reservation of reservations) {
    try {
      fileSystem.writeFileSync(reservation, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
      acquired.push(reservation);
    } catch (error) {
      releaseReservation(acquired, fileSystem);
      if (error?.code === 'EEXIST') return null;
      throw error;
    }
  }
  return reservations;
}

function releaseReservation(reservation, fileSystem = fs) {
  for (const file of reservation) fileSystem.rmSync(file, { force: true });
}

test('claimPair preserves an active foreign second-port reservation after partial acquisition fails', () => {
  const port = 64000 + (process.pid % 1000);
  const firstReservation = path.join(reservationDirectory, `port-${port}.lock`);
  const foreignReservation = path.join(reservationDirectory, `port-${port + 1}.lock`);
  const foreignContent = JSON.stringify({ pid: process.pid, owner: 'foreign-test-process' });
  fs.rmSync(firstReservation, { force: true });
  fs.rmSync(foreignReservation, { force: true });
  fs.writeFileSync(foreignReservation, foreignContent, { flag: 'wx' });

  try {
    assert.equal(claimPair(port), null);
    assert.equal(fs.existsSync(firstReservation), false);
    assert.equal(fs.existsSync(foreignReservation), true);
    assert.equal(fs.readFileSync(foreignReservation, 'utf8'), foreignContent);
  } finally {
    fs.rmSync(firstReservation, { force: true });
    fs.rmSync(foreignReservation, { force: true });
  }
});

test('claimPair preserves stale and malformed foreign reservations at either port byte-for-byte', () => {
  const firstReservation = path.join(reservationDirectory, `port-${63000 + (process.pid % 1000)}.lock`);
  const secondReservation = path.join(reservationDirectory, `port-${63001 + (process.pid % 1000)}.lock`);
  const cases = [
    [firstReservation, JSON.stringify({ pid: 999999999, owner: 'foreign-stale-first' })],
    [firstReservation, '{malformed-first'],
    [secondReservation, JSON.stringify({ pid: 999999999, owner: 'foreign-stale-second' })],
    [secondReservation, '{malformed-second']
  ];

  for (const [foreignReservation, foreignContent] of cases) {
    fs.rmSync(firstReservation, { force: true });
    fs.rmSync(secondReservation, { force: true });
    fs.writeFileSync(foreignReservation, foreignContent, { flag: 'wx' });
    try {
      assert.equal(claimPair(63000 + (process.pid % 1000)), null);
      assert.equal(fs.readFileSync(foreignReservation, 'utf8'), foreignContent);
      assert.equal(fs.existsSync(foreignReservation), true);
    } finally {
      fs.rmSync(firstReservation, { force: true });
      fs.rmSync(secondReservation, { force: true });
    }
  }
});

test('claimPair releases its first lock when the second exclusive create fails unexpectedly', () => {
  const port = 62000 + (process.pid % 1000);
  const firstReservation = path.join(reservationDirectory, `port-${port}.lock`);
  const secondReservation = path.join(reservationDirectory, `port-${port + 1}.lock`);
  const injectedFs = {
    writeFileSync(file, data, options) {
      if (file === secondReservation) {
        const error = new Error('injected second-lock failure');
        error.code = 'EACCES';
        throw error;
      }
      return fs.writeFileSync(file, data, options);
    },
    rmSync: (...args) => fs.rmSync(...args)
  };
  fs.rmSync(firstReservation, { force: true });
  fs.rmSync(secondReservation, { force: true });

  try {
    assert.throws(() => claimPair(port, injectedFs), /injected second-lock failure/);
    assert.equal(fs.existsSync(firstReservation), false);
    assert.equal(fs.existsSync(secondReservation), false);
  } finally {
    fs.rmSync(firstReservation, { force: true });
    fs.rmSync(secondReservation, { force: true });
  }
});

test('claimPair cleanup removes only locks acquired by the current attempt', () => {
  const port = 61000 + (process.pid % 1000);
  const firstReservation = path.join(reservationDirectory, `port-${port}.lock`);
  const secondReservation = path.join(reservationDirectory, `port-${port + 1}.lock`);
  const foreignReservation = path.join(reservationDirectory, `port-${port + 2}.lock`);
  const foreignContent = '{foreign-unrelated-reservation';
  fs.rmSync(firstReservation, { force: true });
  fs.rmSync(secondReservation, { force: true });
  fs.rmSync(foreignReservation, { force: true });
  fs.writeFileSync(foreignReservation, foreignContent, { flag: 'wx' });

  try {
    const acquired = claimPair(port);
    assert.deepEqual(acquired, [firstReservation, secondReservation]);
    releaseReservation(acquired);
    assert.equal(fs.existsSync(firstReservation), false);
    assert.equal(fs.existsSync(secondReservation), false);
    assert.equal(fs.readFileSync(foreignReservation, 'utf8'), foreignContent);
  } finally {
    fs.rmSync(firstReservation, { force: true });
    fs.rmSync(secondReservation, { force: true });
    fs.rmSync(foreignReservation, { force: true });
  }
});

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function assertPairAvailable(port) {
  const gateway = net.createServer();
  const admin = net.createServer();
  try {
    await listen(gateway, port);
    await listen(admin, port + 1);
  } finally {
    await Promise.all([close(gateway).catch(() => {}), close(admin).catch(() => {})]);
  }
}

test('admin route boundary returns 404/405 before authentication or body reads', async () => {
  process.env.GATEWAY_STATE_PATH = path.join(import.meta.dirname, 'non-live-state.json');
  process.env.GATEWAY_LOG_PATH = path.join(import.meta.dirname, 'non-live-log.jsonl');
  const api = await import(`${pathToFileURL(path.join(root, 'src/gateway/admin-api.mjs')).href}?boundary=${Date.now()}`);
  assert.deepEqual(api.classifyAdminRoute('GET', '/admin/keys'), { name: 'keys', params: {} });
  assert.equal(api.classifyAdminRoute('DELETE', '/admin/keys/not-a-uuid')?.name, 'key');
  assert.equal(api.classifyAdminRoute('GET', '/admin/keys/extra/path'), null);
  assert.deepEqual(api.classifyAdminRequest('PUT', '/admin/keys'), { status: 405 });
  assert.deepEqual(api.classifyAdminRequest('POST', '/admin/unknown'), { status: 404 });
});

test('admin route matrix is canonical and exhaustive across methods and malformed paths', async () => {
  process.env.GATEWAY_LOG_PATH = path.join(import.meta.dirname, 'non-live-log.jsonl');
  const api = await import(`${pathToFileURL(path.join(root, 'src/gateway/admin-api.mjs')).href}?matrix=${Date.now()}`);
  const valid = [
    ['GET', '/admin/keys'], ['POST', '/admin/keys'], ['POST', '/admin/keys/reorder'],
    ['GET', '/admin/state'], ['POST', '/admin/validate'], ['GET', '/admin/logs'],
    ['DELETE', '/admin/keys/550e8400-e29b-41d4-a716-446655440000'],
    ['PATCH', '/admin/keys/550e8400-e29b-41d4-a716-446655440000']
  ];
  const allowedByPath = new Map();
  for (const [method, pathname] of valid) allowedByPath.set(pathname, new Set([...(allowedByPath.get(pathname) ?? []), method]));
  for (const [method, pathname] of valid) assert.equal(api.classifyAdminRequest(method, pathname).status, 200, `${method} ${pathname}`);
  for (const [, pathname] of valid) for (const wrong of ['GET', 'POST', 'DELETE', 'PATCH', 'PUT', 'OPTIONS'].filter((value) => !allowedByPath.get(pathname).has(value))) {
    assert.equal(api.classifyAdminRequest(wrong, pathname).status, 405, `${wrong} ${pathname}`);
  }
  for (const pathname of ['/admin/unknown', '/admin/keys/', '/admin//keys', '/Admin/keys', '/admin/keys?x=1', '/admin/keys#x', '/admin/keys%2Fbad', '/admin/%E0%A4%A']) {
    assert.equal(api.classifyCanonicalAdminRequest('GET', pathname).status, 404, pathname);
  }
});
