import os from 'node:os';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const sandboxRoot = os.tmpdir();
const tempRoot = fs.mkdtempSync(path.join(sandboxRoot, `nvgw-lifecycle-ownership-${process.pid}-`));
const reservationDirectory = path.join(sandboxRoot, 'nvgw-test-port-reservations');
const pairReservations = new Set();
const productionMigrationPort = migrationPortFromSource();

fs.mkdirSync(reservationDirectory, { recursive: true });

test.after(() => {
  for (const reservation of pairReservations) releaseReservation(reservation);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function freePortPair() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const probe = http.createServer();
    try {
      const port = 40000 + ((process.pid * 2 + attempt * 2) % 25000);
      await listen(probe, port);
      await close(probe);
      if (port >= 65535 || [productionMigrationPort, productionMigrationPort + 1].includes(port) || [productionMigrationPort, productionMigrationPort + 1].includes(port + 1)) continue;
      const adminProbe = http.createServer();
      try {
        await listen(adminProbe, port + 1);
        await close(adminProbe);
      } catch {
        await close(adminProbe).catch(() => {});
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
      await close(probe).catch(() => {});
    }
  }
  throw new Error('No paired test port is available.');
}

function migrationPortFromSource() {
  const source = fs.readFileSync(path.join(root, 'src', 'main', 'final-migration-workflow.ts'), 'utf8');
  const match = source.match(/FINAL_MIGRATION_PORT = (\d+)/);
  assert.ok(match, 'production migration port must be discoverable');
  return Number(match[1]);
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

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for lifecycle condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function assertPairAvailable(port) {
  const gateway = http.createServer();
  const admin = http.createServer();
  try {
    await listen(gateway, port);
    await listen(admin, port + 1);
  } finally {
    await Promise.all([close(gateway).catch(() => {}), close(admin).catch(() => {})]);
  }
}

async function loadMigrationRunner(port) {
  const fixtureRoot = path.join(tempRoot, `migration-runner-${port}-${Date.now()}-${Math.random()}`);
  fs.cpSync(path.join(root, 'build', 'src'), fixtureRoot, { recursive: true });
  const entrypoint = path.join(fixtureRoot, 'test-support', 'final-migration-test-entrypoint.js');
  let source = fs.readFileSync(entrypoint, 'utf8');
  const fixedPort = Number(source.match(/gatewayPort:\s*(\d+)/)?.[1]);
  assert.ok(Number.isInteger(fixedPort), 'fixture migration port must be discoverable');
  source = source.replaceAll(String(fixedPort + 1), String(port + 1)).replaceAll(String(fixedPort), String(port));
  fs.writeFileSync(entrypoint, source, 'utf8');
  const jsoncParserPath = JSON.stringify(path.join(root, 'node_modules', 'jsonc-parser'));
  const targetModule = path.join(fixtureRoot, 'main', 'opencode-jsonc-targets.js');
  const targetSource = fs.readFileSync(targetModule, 'utf8');
  const patchedTargetSource = targetSource.replace('require("jsonc-parser")', `require(${jsoncParserPath})`);
  assert.notEqual(patchedTargetSource, targetSource, 'fixture dependency must be patched for sandbox resolution');
  fs.writeFileSync(targetModule, patchedTargetSource, 'utf8');
  return import(pathToFileURL(entrypoint).href);
}

function fakeChild({
  port,
  attest = true,
  gatewayHealth = () => 200,
  onBound,
  attestation,
  earlyAttestation = false,
  exitOnGracefulKill = true,
  exitOnForcedKill = true,
  stateInitCallback,
  stateInitSend
}) {
  const child = new EventEmitter();
  const servers = [];
  const challenge = 'test-child-challenge-0123456789';
  let listenersStarted = false;
  child.pid = 4242;
  child.exitCode = null;
  child.killed = false;
  child.connected = true;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.killSignals = [];
  child.exitError = null;
  child.exit = () => {
    if (child.exitPromise) return child.exitPromise;
    child.exitPromise = Promise.all(servers.map((server) => close(server).catch((error) => {
      if (error?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    })))
      .then(() => {
        child.connected = false;
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
    return child.exitPromise;
  };
  child.kill = (signal = 'SIGTERM') => {
    child.killCalls += 1;
    child.killSignals.push(signal);
    child.killed = true;
    if ((signal === 'SIGKILL' && exitOnForcedKill) || (signal !== 'SIGKILL' && exitOnGracefulKill)) {
      void child.exit().catch((error) => {
        child.exitError = error;
        if (child.listenerCount('error') > 0) child.emit('error', error);
      });
    }
    return true;
  };
  child.send = (message, callback) => {
    if (message?.type !== 'state:init' || listenersStarted) return;
    if (stateInitSend) return stateInitSend(message, callback);
    listenersStarted = true;
    if (stateInitCallback) stateInitCallback(callback);
    else callback?.(null);
    const gateway = http.createServer((_request, response) => { response.writeHead(gatewayHealth()); response.end(); });
    const admin = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
    servers.push(gateway, admin);
    // Keep late socket errors from escaping the fake when lifecycle listeners have been detached.
    gateway.on('error', () => {});
    admin.on('error', () => {});
    const reportBindError = (error) => setImmediate(() => {
      child.exitError = error;
      if (child.listenerCount('error') > 0) child.emit('error', error);
    });
    gateway.once('error', reportBindError);
    admin.once('error', reportBindError);
    gateway.listen(port, '127.0.0.1', () => admin.listen(port + 1, '127.0.0.1', () => {
      onBound?.();
      if (attest) child.emit('message', attestation ?? { type: 'ports:bound', challenge, gatewayPort: port, adminPort: port + 1 });
    }));
  };
  child.emitReady = () => {
    if (earlyAttestation) child.emit('message', { type: 'ports:bound', challenge, gatewayPort: port, adminPort: port + 1 });
    child.emit('message', { type: 'ready', challenge });
  };
  child.resetForReuse = () => {
    child.exitCode = null;
    child.killed = false;
    child.connected = true;
    child.exitPromise = undefined;
    child.exitError = null;
    listenersStarted = false;
  };
  return child;
}

function installExternalListenerBaseline(child) {
  const listeners = {
    error: () => {},
    exit: () => {},
    message: () => {},
    stdout: () => {},
    stderr: () => {}
  };
  child.on('error', listeners.error);
  child.on('exit', listeners.exit);
  child.on('message', listeners.message);
  child.stdout.on('data', listeners.stdout);
  child.stderr.on('data', listeners.stderr);
  return {
    counts: lifecycleListenerCounts(child),
    dispose() {
      child.removeListener('error', listeners.error);
      child.removeListener('exit', listeners.exit);
      child.removeListener('message', listeners.message);
      child.stdout.removeListener('data', listeners.stdout);
      child.stderr.removeListener('data', listeners.stderr);
    }
  };
}

function lifecycleListenerCounts(child) {
  return {
    error: child.listenerCount('error'),
    exit: child.listenerCount('exit'),
    message: child.listenerCount('message'),
    stdoutData: child.stdout.listenerCount('data'),
    stderrData: child.stderr.listenerCount('data')
  };
}

function assertLifecycleListenersAttached(child, baseline) {
  assert.deepEqual(lifecycleListenerCounts(child), {
    error: baseline.error + 1,
    exit: baseline.exit + 1,
    message: baseline.message + 2,
    stdoutData: baseline.stdoutData + 1,
    stderrData: baseline.stderrData + 1
  });
}

function assertLifecycleListenersRestored(child, baseline) {
  assert.deepEqual(lifecycleListenerCounts(child), baseline);
}

async function assertDetachedEventsAreInert(child, instance, persisted, emitted) {
  const statusBefore = instance.getStatus();
  const outputBefore = instance.output;
  const persistedBefore = persisted.length;
  const emittedBefore = emitted.length;
  child.emit('message', { type: 'state:persist', state: { keys: [] } });
  child.emit('message', {
    type: 'ports:bound',
    challenge: 'test-child-challenge-0123456789',
    gatewayPort: 1,
    adminPort: 2
  });
  child.stdout.emit('data', 'stale stdout');
  child.stderr.emit('data', 'stale stderr');
  child.emit('error', new Error('stale child error'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(instance.getStatus(), statusBefore, 'stale child events must not change lifecycle status');
  assert.equal(instance.output, outputBefore, 'stale child streams must not change captured output');
  assert.equal(persisted.length, persistedBefore, 'stale child IPC must not persist state');
  assert.equal(emitted.length, emittedBefore, 'stale child events must not emit lifecycle status');
}

test('fake child exposes exit only after both bound listeners close', async () => {
  const port = await freePortPair();
  let resolveBound;
  const bound = new Promise((resolve) => { resolveBound = resolve; });
  const child = fakeChild({ port, onBound: resolveBound });

  child.send({ type: 'state:init' });
  await bound;
  const exit = child.exit();

  assert.equal(child.exitCode, null);
  await exit;
  assert.equal(child.exitCode, 0);
  assert.equal(child.exitError, null);
});

async function createLifecycle(port, child, options = {}) {
  const { ensureGatewayRuntime } = await import(built('gateway-runtime.js'));
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const paths = ensureGatewayRuntime(path.join(tempRoot, `runtime-${port}-${Date.now()}-${Math.random()}`));
  return {
    paths,
    instance: new GatewayLifecycle({
      executablePath: process.execPath,
      serverPath: path.join(root, 'src', 'gateway', 'server.mjs'),
      runtimePaths: paths,
      spawnChild: () => {
        setImmediate(() => child.emitReady());
        return child;
      },
      initialState: { keys: [], credentials: { gatewayToken: 'fixture-gateway-token', adminToken: 'fixture-admin-token' } },
      startupTimeoutMs: 250,
      healthPollIntervalMs: 5,
      ...options
    })
  };
}

test('rejects a readiness race with public health responses but no paired-port IPC attestation', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port, attest: false });
  const { instance, paths } = await createLifecycle(port, child);

  const status = await instance.start(port);

  assert.equal(status.state, 'error');
  assert.equal(status.code, 'START_FAILED');
  assert.equal(child.killCalls, 1);
  assert.equal(fs.existsSync(paths.ownerPath), false);
  assert.deepEqual(instance.getStatus(), status);
});

test('migration leaves encrypted state and OpenCode unchanged when public responders lack bound attestation', async () => {
  const { ensureGatewayRuntime } = await import(built('gateway-runtime.js'));
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  const port = await freePortPair();
  const { runLegacyNvidiaMigrationForTests } = await loadMigrationRunner(port);
  const dir = path.join(tempRoot, `migration-race-${Date.now()}-${Math.random()}`);
  const runtime = ensureGatewayRuntime(dir);
  const legacy = path.join(dir, 'legacy.json');
  const first = path.join(dir, 'opencode.json');
  const second = path.join(dir, 'opencode.jsonc');
  const originalConfig = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old/v1"}}}}';
  const credentials = { gatewayToken: 'fake-migration-gateway-token', adminToken: 'fake-migration-admin-token' };
  const adapter = { encrypt: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5), decrypt: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5) };
  fs.writeFileSync(legacy, JSON.stringify({ upstreams: [{ apiKey: 'fake-migration-nvidia-key' }] }));
  fs.writeFileSync(first, originalConfig);
  fs.writeFileSync(second, originalConfig);
  const store = new SecureStore(runtime.statePath, adapter);
  store.persist({ keys: [], credentials });
  const child = fakeChild({ port, attest: false });
  const instance = new GatewayLifecycle({
    executablePath: process.execPath,
    serverPath: path.join(root, 'src', 'gateway', 'server.mjs'),
    runtimePaths: runtime,
    spawnChild: () => { setImmediate(() => child.emitReady()); return child; },
    initialState: { keys: [], credentials: { gatewayToken: 'fixture-gateway-token', adminToken: 'fixture-admin-token' } },
    startupTimeoutMs: 250,
    healthPollIntervalMs: 5
  });

  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime,
    store,
    state: store.initialize(),
    protectFile: () => {},
    sourcePath: legacy,
    configPaths: [first, second],
    lifecycle: instance,
    checkPorts: async (ports) => {
      assert.deepEqual(ports, [port, port + 1]);
      return { [port]: false, [port + 1]: false };
    }
  }), (error) => error.message === 'MIGRATION_GATEWAY_START_FAILED');

  assert.deepEqual(store.initialize(), { keys: [], credentials });
  assert.equal(fs.readFileSync(first, 'utf8'), originalConfig);
  assert.equal(fs.readFileSync(second, 'utf8'), originalConfig);
  assert.equal(child.killCalls, 1);
});

test('accepts a live child only after it attests the exact paired ports', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port });
  const { instance } = await createLifecycle(port, child);

  assert.deepEqual(await instance.start(port), { state: 'running', port });
  assert.deepEqual(await instance.stop(), { state: 'stopped' });
  assert.equal(child.killCalls, 1);
});

test('running stop emits no runtime-exit status', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port });
  const emitted = [];
  const { instance } = await createLifecycle(port, child, {
    onStatusChange: (status) => emitted.push(status)
  });

  assert.deepEqual(await instance.start(port), { state: 'running', port });
  assert.deepEqual(await instance.stop(), { state: 'stopped' });
  assert.equal(emitted.filter((status) => status.code === 'RUNTIME_EXIT').length, 0);
});

test('duplicate same-port start is idempotent and does not preflight or corrupt running status', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port });
  const emitted = [];
  let preflightCalls = 0;
  const { instance, paths } = await createLifecycle(port, child, {
    onStatusChange: (status) => emitted.push(status)
  });

  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });
    instance.preflight = async () => {
      preflightCalls += 1;
      return { state: 'error', code: 'PORT_IN_USE', port, message: 'must not run' };
    };

    assert.deepEqual(await instance.start(port), { state: 'running', port });
    assert.equal(preflightCalls, 0, 'a managed same-port start must not probe its own occupied ports');
    assert.deepEqual(instance.getStatus(), { state: 'running', port });
    assert.equal(instance.child, child);
    assert.equal(fs.existsSync(paths.ownerPath), true);
    assert.equal(emitted.filter((status) => status.code === 'PORT_IN_USE').length, 0);
  } finally {
    await instance.stop();
    await child.exit();
  }
});

test('duplicate different-port start rejects without changing authoritative running status or owner', async () => {
  const port = await freePortPair();
  const differentPort = await freePortPair();
  const child = fakeChild({ port });
  const emitted = [];
  const { instance, paths } = await createLifecycle(port, child, {
    onStatusChange: (status) => emitted.push(status)
  });

  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });
    const ownerBefore = fs.readFileSync(paths.ownerPath, 'utf8');
    assert.deepEqual(await instance.start(differentPort), {
      state: 'error',
      code: 'START_FAILED',
      port: differentPort,
      message: 'Gateway is already managed by this application.'
    });
    assert.deepEqual(instance.getStatus(), { state: 'running', port });
    assert.equal(instance.child, child);
    assert.equal(instance.managedPort, port);
    assert.equal(fs.readFileSync(paths.ownerPath, 'utf8'), ownerBefore);
    assert.equal(emitted.at(-1)?.state, 'running', 'rejected presentation result must not be broadcast as authoritative state');
  } finally {
    await instance.stop();
    await child.exit();
  }
});

for (const [name, stateInitSend] of [
  ['synchronous state-init serialization failure', (message) => JSON.stringify(message)],
  ['asynchronous state-init callback failure', (_message, callback) => { setImmediate(() => callback(new Error('private callback detail'))); return true; }]
]) {
  test(`${name} resolves startup failure without escaping or retaining false channel state`, async () => {
    const port = await freePortPair();
    const child = fakeChild({ port, stateInitSend });
    const { instance, paths } = await createLifecycle(port, child, {
      initialState: {
        keys: [],
        credentials: { gatewayToken: 'fixture-gateway-token', adminToken: 'fixture-admin-token' },
        allowedExtra: 1n
      }
    });

    const status = await instance.start(port);

    assert.equal(status.state, 'error');
    assert.equal(status.code, 'START_FAILED');
    assert.equal(status.message.includes('private callback detail'), false);
    assert.equal(status.message.includes('BigInt'), false);
    assert.equal(instance.child, null);
    assert.equal(instance.managedPort, null);
    assert.equal(fs.existsSync(paths.ownerPath), false);
    assert.equal(child.exitCode, 0);
  });
}

test('delayed state-init delivery failure cannot commit a healthy attested child as running', async () => {
  const port = await freePortPair();
  let callbackFired = false;
  const child = fakeChild({
    port,
    stateInitCallback: (callback) => setTimeout(() => {
      callbackFired = true;
      callback(new Error('delayed private callback detail'));
    }, 50)
  });
  const emitted = [];
  const { instance, paths } = await createLifecycle(port, child, {
    startupTimeoutMs: 500,
    onStatusChange: (status) => emitted.push(status)
  });

  try {
    const status = await instance.start(port);

    assert.equal(callbackFired, true, 'startup must await confirmation that state:init was delivered');
    assert.equal(status.state, 'error');
    assert.equal(status.code, 'START_FAILED');
    assert.equal(status.message.includes('delayed private callback detail'), false);
    assert.equal(emitted.some((candidate) => candidate.state === 'running'), false);
    assert.equal(instance.child, null);
    assert.equal(instance.managedPort, null);
    assert.equal(fs.existsSync(paths.ownerPath), false);
    assert.equal(child.exitCode, 0);
  } finally {
    await instance.stop();
    await child.exit();
  }
});

test('stop without a tracked child preserves a foreign owner record and external gateway', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port });
  const { instance, paths } = await createLifecycle(port, child);
  const foreignOwner = JSON.stringify({
    pid: 999999,
    ownerIdHash: 'f'.repeat(64),
    executablePath: 'foreign.exe',
    serverPath: 'foreign-server.mjs',
    createdAt: 'foreign-owner',
    gatewayPort: port,
    adminPort: port + 1
  });
  const external = http.createServer((_request, response) => { response.writeHead(200); response.end('external'); });
  fs.writeFileSync(paths.ownerPath, foreignOwner);
  await listen(external, port);

  try {
    assert.deepEqual(await instance.stop(), { state: 'stopped' });
    assert.equal(fs.readFileSync(paths.ownerPath, 'utf8'), foreignOwner);
    assert.equal(await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      }).once('error', reject);
    }), 200);
  } finally {
    await close(external);
    fs.rmSync(paths.ownerPath, { force: true });
  }
});

test('intentional stop restores every lifecycle-owned child listener and stale events are inert', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port });
  const external = installExternalListenerBaseline(child);
  const persisted = [];
  const emitted = [];
  const { instance } = await createLifecycle(port, child, {
    persistState: (state) => persisted.push(state),
    onStatusChange: (status) => emitted.push(status)
  });

  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });
    assertLifecycleListenersAttached(child, external.counts);
    assert.deepEqual(await instance.stop(), { state: 'stopped' });
    assertLifecycleListenersRestored(child, external.counts);
    await assertDetachedEventsAreInert(child, instance, persisted, emitted);
  } finally {
    external.dispose();
    await child.exit();
  }
});

test('genuine runtime exit restores every lifecycle-owned child listener and stale events are inert', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port });
  const external = installExternalListenerBaseline(child);
  const persisted = [];
  const emitted = [];
  const { instance } = await createLifecycle(port, child, {
    persistState: (state) => persisted.push(state),
    onStatusChange: (status) => emitted.push(status)
  });

  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });
    assertLifecycleListenersAttached(child, external.counts);
    await child.exit();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(instance.getStatus().code, 'RUNTIME_EXIT');
    assertLifecycleListenersRestored(child, external.counts);
    await assertDetachedEventsAreInert(child, instance, persisted, emitted);
  } finally {
    external.dispose();
    await child.exit();
  }
});

test('late exit after unconfirmed stop restores every lifecycle-owned child listener', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port, exitOnGracefulKill: false, exitOnForcedKill: false });
  const external = installExternalListenerBaseline(child);
  const persisted = [];
  const emitted = [];
  const { instance } = await createLifecycle(port, child, {
    shutdownTimeoutMs: 10,
    forcedShutdownTimeoutMs: 10,
    persistState: (state) => persisted.push(state),
    onStatusChange: (status) => emitted.push(status)
  });

  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });
    assert.equal((await instance.stop()).message, 'Managed gateway child shutdown could not be confirmed.');
    await child.exit();
    await new Promise((resolve) => setImmediate(resolve));
    assertLifecycleListenersRestored(child, external.counts);
    await assertDetachedEventsAreInert(child, instance, persisted, emitted);
  } finally {
    external.dispose();
    await child.exit();
  }
});

test('confirmed startup failure restores every lifecycle-owned child listener', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port, attest: false });
  const external = installExternalListenerBaseline(child);
  const persisted = [];
  const emitted = [];
  const { instance } = await createLifecycle(port, child, {
    persistState: (state) => persisted.push(state),
    onStatusChange: (status) => emitted.push(status)
  });

  try {
    const status = await instance.start(port);
    assert.equal(status.code, 'START_FAILED');
    assertLifecycleListenersRestored(child, external.counts);
    await assertDetachedEventsAreInert(child, instance, persisted, emitted);
  } finally {
    external.dispose();
    await child.exit();
  }
});

test('confirmed protocol-violation cleanup restores every lifecycle-owned child listener', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port });
  const external = installExternalListenerBaseline(child);
  const persisted = [];
  const emitted = [];
  const { instance } = await createLifecycle(port, child, {
    persistState: (state) => persisted.push(state),
    onStatusChange: (status) => emitted.push(status)
  });

  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });
    child.emit('message', {
      type: 'ports:bound',
      challenge: 'test-child-challenge-0123456789',
      gatewayPort: port,
      adminPort: port + 1
    });
    await waitFor(() => instance.getStatus().message === 'Gateway lifecycle protocol violation.');
    assertLifecycleListenersRestored(child, external.counts);
    await assertDetachedEventsAreInert(child, instance, persisted, emitted);
  } finally {
    external.dispose();
    await child.exit();
  }
});

test('three start-stop cycles reusing one child restore listener baselines without growth', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port });
  const external = installExternalListenerBaseline(child);
  const { instance } = await createLifecycle(port, child);

  try {
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      assert.deepEqual(await instance.start(port), { state: 'running', port }, `cycle ${cycle} must start`);
      assertLifecycleListenersAttached(child, external.counts);
      assert.deepEqual(await instance.stop(), { state: 'stopped' }, `cycle ${cycle} must stop`);
      assertLifecycleListenersRestored(child, external.counts);
      if (cycle < 3) child.resetForReuse();
    }
  } finally {
    external.dispose();
    await child.exit();
  }
});

test('running retry replaces one child without emitting a runtime-exit status', async () => {
  const port = await freePortPair();
  const firstChild = fakeChild({ port });
  const replacementChild = fakeChild({ port });
  const children = [firstChild, replacementChild];
  const emitted = [];
  let spawnIndex = 0;
  const { instance } = await createLifecycle(port, firstChild, {
    onStatusChange: (status) => emitted.push(status),
    spawnChild: () => {
      const child = children[spawnIndex++];
      assert.ok(child, 'retry must not spawn more than one replacement child');
      setImmediate(() => child.emitReady());
      return child;
    }
  });

  assert.deepEqual(await instance.start(port), { state: 'running', port });
  assert.deepEqual(await instance.retry(port), { state: 'running', port });
  assert.equal(spawnIndex, 2, 'retry must start exactly one replacement child');
  assert.deepEqual(await instance.stop(), { state: 'stopped' });
  assert.equal(emitted.filter((status) => status.code === 'RUNTIME_EXIT').length, 0);
});

test('failed running-child shutdown blocks replacement, cleans up on late exit, and permits isolated recovery', async () => {
  const port = await freePortPair();
  const unresponsiveChild = fakeChild({ port, exitOnGracefulKill: false, exitOnForcedKill: false });
  const replacementChild = fakeChild({ port });
  const children = [unresponsiveChild, replacementChild];
  const emitted = [];
  let spawnIndex = 0;
  const { instance, paths } = await createLifecycle(port, unresponsiveChild, {
    shutdownTimeoutMs: 10,
    forcedShutdownTimeoutMs: 10,
    onStatusChange: (status) => emitted.push(status),
    spawnChild: () => {
      const child = children[spawnIndex++];
      assert.ok(child, 'failed shutdown and recovery must spawn only the expected children');
      setImmediate(() => child.emitReady());
      return child;
    }
  });

  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });
    assert.equal(fs.existsSync(paths.ownerPath), true);

    assert.deepEqual(await instance.retry(port), {
      state: 'error',
      code: 'START_FAILED',
      port,
      message: 'Managed gateway child shutdown could not be confirmed.'
    });
    assert.equal(spawnIndex, 1, 'retry must not spawn while the old child shutdown is unconfirmed');
    assert.equal(emitted.filter((status) => status.code === 'RUNTIME_EXIT').length, 0);

    await unresponsiveChild.exit();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(instance.child, null);
    assert.equal(instance.managedPort, null);
    assert.equal(fs.existsSync(paths.ownerPath), false);

    assert.deepEqual(await instance.retry(port), { state: 'running', port });
    assert.equal(spawnIndex, 2, 'recovery must spawn exactly one replacement');
    replacementChild.emit('error', new Error('replacement runtime failure'));
    await replacementChild.exit();
    await new Promise((resolve) => setImmediate(resolve));

    const runtimeExits = emitted.filter((status) => status.code === 'RUNTIME_EXIT');
    assert.equal(runtimeExits.length, 1);
    assert.match(runtimeExits[0].message, /replacement runtime failure/);
    assert.equal(instance.child, null);
    assert.equal(instance.managedPort, null);
    assert.equal(fs.existsSync(paths.ownerPath), false);
  } finally {
    await unresponsiveChild.exit();
    await replacementChild.exit();
  }
});

test('post-readiness exit before final startup commitment emits START_FAILED and no runtime-exit status', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port });
  const emitted = [];
  const { instance } = await createLifecycle(port, child, {
    onStatusChange: (status) => emitted.push(status),
    afterOwnerRecordWrite: () => child.exit()
  });

  const status = await instance.start(port);

  assert.equal(status.state, 'error');
  assert.equal(status.code, 'START_FAILED');
  assert.equal(emitted.filter((candidate) => candidate.code === 'RUNTIME_EXIT').length, 0);
});

test('exit during the final ownership health request cannot commit running', async () => {
  const port = await freePortPair();
  const emitted = [];
  let healthRequests = 0;
  let child;
  child = fakeChild({ port, gatewayHealth: () => {
    healthRequests += 1;
    if (healthRequests === 3) {
      child.connected = false;
      child.exitCode = 0;
      child.emit('exit', 0, null);
    }
    return 200;
  } });
  const { instance, paths } = await createLifecycle(port, child, {
    onStatusChange: (status) => emitted.push(status)
  });

  try {
    const status = await instance.start(port);

    assert.equal(healthRequests, 3, 'the child must exit from inside the final ownership HTTP request');
    assert.equal(status.state, 'error');
    assert.equal(status.code, 'START_FAILED');
    assert.equal(emitted.filter((candidate) => candidate.code === 'START_FAILED').length, 1);
    assert.equal(emitted.filter((candidate) => candidate.code === 'RUNTIME_EXIT').length, 0);
    assert.equal(instance.child, null);
    assert.equal(instance.managedPort, null);
    assert.equal(fs.existsSync(paths.ownerPath), false);
  } finally {
    await child.exit();
  }
});

test('two live-child errors retain ownership until exit, emit once, and detach listeners', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port });
  const emitted = [];
  const { instance, paths } = await createLifecycle(port, child, {
    onStatusChange: (status) => emitted.push(status)
  });

  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });
    assert.equal(child.listenerCount('error'), 1);
    assert.doesNotThrow(() => {
      child.emit('error', new Error('first nonterminal runtime failure'));
      child.emit('error', new Error('second nonterminal runtime failure'));
    });

    assert.equal(child.exitCode, null);
    assert.equal(child.listenerCount('error'), 1);
    assert.equal(instance.child, child);
    assert.equal(instance.managedPort, port);
    assert.equal(fs.existsSync(paths.ownerPath), true);
    assert.deepEqual(instance.getStatus(), { state: 'running', port });
    assert.equal(emitted.filter((status) => status.code === 'RUNTIME_EXIT').length, 0);

    await child.exit();
    await new Promise((resolve) => setImmediate(resolve));

    const runtimeExits = emitted.filter((status) => status.code === 'RUNTIME_EXIT');
    assert.equal(runtimeExits.length, 1);
    assert.match(runtimeExits[0].message, /second nonterminal runtime failure/);
    assert.deepEqual(instance.getStatus(), runtimeExits[0]);
    assert.equal(instance.child, null);
    assert.equal(instance.managedPort, null);
    assert.equal(fs.existsSync(paths.ownerPath), false);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('exit'), 0);
  } finally {
    await child.exit();
  }
});

test('two pre-commit errors remain handled and later exit reports exactly once', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port });
  const emitted = [];
  let listenerCountAfterErrors = -1;
  const { instance, paths } = await createLifecycle(port, child, {
    onStatusChange: (status) => emitted.push(status),
    afterOwnerRecordWrite: () => {
      child.emit('error', new Error('first pre-commit failure'));
      child.emit('error', new Error('second pre-commit failure'));
      listenerCountAfterErrors = child.listenerCount('error');
    }
  });

  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });
    assert.equal(listenerCountAfterErrors, 1);
    assert.equal(instance.child, child);
    assert.equal(instance.managedPort, port);
    assert.equal(fs.existsSync(paths.ownerPath), true);
    assert.equal(emitted.filter((status) => status.code === 'RUNTIME_EXIT').length, 0);

    await child.exit();
    await new Promise((resolve) => setImmediate(resolve));

    const runtimeExits = emitted.filter((status) => status.code === 'RUNTIME_EXIT');
    assert.equal(runtimeExits.length, 1);
    assert.match(runtimeExits[0].message, /second pre-commit failure/);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('exit'), 0);
  } finally {
    await child.exit();
  }
});

test('per-child stop and startup intent clears across retry failure and recovery', async () => {
  const port = await freePortPair();
  const firstChild = fakeChild({ port });
  const failedReplacement = fakeChild({ port, attest: false });
  const recoveredChild = fakeChild({ port });
  const children = [firstChild, failedReplacement, recoveredChild];
  const emitted = [];
  let spawnIndex = 0;
  const { instance } = await createLifecycle(port, firstChild, {
    onStatusChange: (status) => emitted.push(status),
    spawnChild: () => {
      const child = children[spawnIndex++];
      assert.ok(child, 'retry sequence must not spawn an extra child');
      setImmediate(() => child.emitReady());
      return child;
    }
  });

  assert.deepEqual(await instance.start(port), { state: 'running', port });
  const failed = await instance.retry(port);
  assert.equal(failed.state, 'error');
  assert.equal(failed.code, 'START_FAILED');
  assert.equal(emitted.filter((status) => status.code === 'RUNTIME_EXIT').length, 0);

  assert.deepEqual(await instance.retry(port), { state: 'running', port });
  assert.equal(spawnIndex, 3);
  await recoveredChild.exit();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(emitted.filter((status) => status.code === 'RUNTIME_EXIT').length, 1,
    'the recovered child must retain independent unexpected-exit reporting');
});

test('rejects a paired-port attestation that includes an extra own property', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port, attestation: {
    type: 'ports:bound',
    challenge: 'test-child-challenge-0123456789',
    gatewayPort: port,
    adminPort: port + 1,
    adminToken: 'must-not-be-accepted'
  } });
  const { instance, paths } = await createLifecycle(port, child);

  const status = await instance.start(port);

  assert.deepEqual(status, { state: 'error', code: 'START_FAILED', port, message: 'Gateway exited before startup could be verified.' });
  assert.equal(child.killCalls, 1);
  assert.equal(fs.existsSync(paths.ownerPath), false);
});

test('rejects paired-port attestations with inherited fields, symbols, or non-plain prototypes', async () => {
  const port = await freePortPair();
  const inherited = Object.create({ adminToken: 'must-not-be-accepted' });
  Object.assign(inherited, { type: 'ports:bound', challenge: 'test-child-challenge-0123456789', gatewayPort: port, adminPort: port + 1 });
  const symbolFrame = { type: 'ports:bound', challenge: 'test-child-challenge-0123456789', gatewayPort: port, adminPort: port + 1, [Symbol('extra')]: true };

  for (const attestation of [inherited, symbolFrame]) {
    const child = fakeChild({ port, attestation });
    const { instance, paths } = await createLifecycle(port, child);

    const status = await instance.start(port);

    assert.equal(status.state, 'error');
    assert.equal(status.code, 'START_FAILED');
    assert.equal(status.message.includes('adminToken'), false);
    assert.equal(child.killCalls, 1);
    assert.equal(fs.existsSync(paths.ownerPath), false);
  }
});

test('stops the child, clears lifecycle state, and returns a generic error when owner record writing fails', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port });
  const missingOwnerDirectory = path.join(tempRoot, `missing-owner-dir-${Date.now()}-${Math.random()}`);
  const { instance, paths } = await createLifecycle(port, child);
  paths.ownerPath = path.join(missingOwnerDirectory, 'gateway-owner.json');

  const status = await instance.start(port);

  assert.deepEqual(status, { state: 'error', code: 'START_FAILED', port, message: 'Gateway startup could not be completed.' });
  assert.equal(child.killCalls, 1);
  assert.equal(child.exitCode, 0);
  assert.equal(fs.existsSync(paths.ownerPath), false);
  assert.deepEqual(instance.getStatus(), status);
  assert.deepEqual(await instance.stop(), { state: 'stopped' });
  assert.equal(child.killCalls, 1);
});

for (const [name, createAttestation] of [
  ['wrong challenge', (port) => ({ type: 'ports:bound', challenge: 'wrong-child-challenge-0123456789', gatewayPort: port, adminPort: port + 1 })],
  ['wrong port pair', () => ({ type: 'ports:bound', challenge: 'test-child-challenge-0123456789', gatewayPort: 1, adminPort: 2 })],
  ['malformed frame', (port) => ({ type: 'ports:bound', challenge: 'test-child-challenge-0123456789', gatewayPort: 'not-a-port', adminPort: port + 1 })]
]) {
  test(`rejects a ${name} paired-port attestation`, async () => {
    const port = await freePortPair();
    const child = fakeChild({ port, attestation: createAttestation(port) });
    const { instance, paths } = await createLifecycle(port, child);

    const status = await instance.start(port);

    assert.equal(status.state, 'error');
    assert.equal(child.killCalls, 1);
    assert.equal(fs.existsSync(paths.ownerPath), false);
  });
}

test('rejects a duplicate paired-port attestation', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port, onBound: () => {
    child.emit('message', { type: 'ports:bound', challenge: 'test-child-challenge-0123456789', gatewayPort: port, adminPort: port + 1 });
  } });
  const { instance, paths } = await createLifecycle(port, child);

  const status = await instance.start(port);

  assert.equal(status.state, 'error');
  assert.equal(child.killCalls, 1);
  assert.equal(fs.existsSync(paths.ownerPath), false);
});

test('rejects an early paired-port attestation even when a later attestation is correct', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port, earlyAttestation: true });
  const { instance, paths } = await createLifecycle(port, child);

  const status = await instance.start(port);

  assert.equal(status.state, 'error');
  assert.equal(child.killCalls, 1);
  assert.equal(fs.existsSync(paths.ownerPath), false);
});

test('stops the child before clearing lifecycle state when the first post-readiness ownership check fails', async () => {
  const port = await freePortPair();
  let healthRequests = 0;
  const child = fakeChild({ port, gatewayHealth: () => ++healthRequests === 1 ? 200 : 503 });
  const { instance, paths } = await createLifecycle(port, child);

  const status = await instance.start(port);

  assert.equal(status.state, 'error');
  assert.equal(child.killCalls, 1);
  assert.equal(fs.existsSync(paths.ownerPath), false);
  assert.equal(instance.getStatus().state, 'error');
});

test('stops the child and clears its owner record when the post-owner-record check fails', async () => {
  const port = await freePortPair();
  let healthy = true;
  const child = fakeChild({ port, gatewayHealth: () => healthy ? 200 : 503 });
  const { instance, paths } = await createLifecycle(port, child, {
    afterOwnerRecordWrite: () => {
      assert.equal(fs.existsSync(paths.ownerPath), true);
      healthy = false;
    }
  });

  const status = await instance.start(port);

  assert.equal(status.state, 'error');
  assert.equal(child.killCalls, 1);
  assert.equal(fs.existsSync(paths.ownerPath), false);
  assert.equal(instance.getStatus().state, 'error');
});

test('escalates a previously signalled startup cleanup after it still has no exit', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port, exitOnGracefulKill: false, exitOnForcedKill: true });
  const { instance, paths } = await createLifecycle(port, child, {
    shutdownTimeoutMs: 10,
    forcedShutdownTimeoutMs: 10,
    afterOwnerRecordWrite: () => { child.killed = true; }
  });

  try {
    const status = await instance.start(port);

    assert.equal(status.state, 'error');
    assert.deepEqual(child.killSignals, ['SIGKILL']);
    assert.equal(child.exitCode, 0);
    assert.equal(fs.existsSync(paths.ownerPath), false);
    assert.equal(instance.child, null);
    assert.equal(instance.managedPort, null);
  } finally {
    await child.exit();
  }
});

test('retains lifecycle tracking and the owner record until an unresponsive child actually exits', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port, exitOnGracefulKill: false, exitOnForcedKill: false });
  const { instance, paths } = await createLifecycle(port, child, {
    shutdownTimeoutMs: 10,
    forcedShutdownTimeoutMs: 10,
    afterOwnerRecordWrite: () => { child.killed = true; }
  });

  try {
    const status = await instance.start(port);

    assert.equal(status.state, 'error');
    assert.deepEqual(child.killSignals, ['SIGKILL']);
    assert.equal(child.exitCode, null);
    assert.equal(fs.existsSync(paths.ownerPath), true);
    assert.equal(instance.child, child);
    assert.equal(instance.managedPort, port);
    assert.equal(status.message, 'Gateway startup failed and managed child shutdown could not be confirmed.');

    await child.exit();

    assert.equal(fs.existsSync(paths.ownerPath), false);
    assert.equal(instance.child, null);
    assert.equal(instance.managedPort, null);
  } finally {
    await child.exit();
  }
});

test('fails startup when a duplicate attestation arrives during the final ownership check', async () => {
  const port = await freePortPair();
  let emitDuplicateOnNextHealthCheck = false;
  let child;
  child = fakeChild({ port, gatewayHealth: () => {
    if (emitDuplicateOnNextHealthCheck) {
      emitDuplicateOnNextHealthCheck = false;
      child.emit('message', {
        type: 'ports:bound',
        challenge: 'test-child-challenge-0123456789',
        gatewayPort: port,
        adminPort: port + 1
      });
    }
    return 200;
  } });
  const { instance, paths } = await createLifecycle(port, child, {
    afterOwnerRecordWrite: () => { emitDuplicateOnNextHealthCheck = true; }
  });

  const status = await instance.start(port);

  assert.equal(status.state, 'error');
  assert.equal(status.code, 'START_FAILED');
  assert.equal(child.killCalls, 1);
  assert.equal(fs.existsSync(paths.ownerPath), false);
  assert.equal(instance.getStatus().state, 'error');
});

test('shuts down a running child when it sends a duplicate attestation', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port });
  const { instance, paths } = await createLifecycle(port, child);

  assert.deepEqual(await instance.start(port), { state: 'running', port });
  const childExited = new Promise((resolve) => child.once('exit', resolve));
  child.emit('message', {
    type: 'ports:bound',
    challenge: 'test-child-challenge-0123456789',
    gatewayPort: port,
    adminPort: port + 1
  });
  await childExited;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(instance.getStatus(), {
    state: 'error',
    code: 'START_FAILED',
    port,
    message: 'Gateway lifecycle protocol violation.'
  });
  assert.equal(child.killCalls, 1);
  assert.equal(fs.existsSync(paths.ownerPath), false);
  assert.equal(instance.child, null);
  assert.equal(instance.managedPort, null);
});

test('protocol-violation late exit clears only its exact owner record once', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port, exitOnGracefulKill: false, exitOnForcedKill: false });
  const { instance, paths } = await createLifecycle(port, child, {
    shutdownTimeoutMs: 10,
    forcedShutdownTimeoutMs: 10
  });

  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });
    child.emit('message', {
      type: 'ports:bound',
      challenge: 'test-child-challenge-0123456789',
      gatewayPort: port,
      adminPort: port + 1
    });
    await waitFor(() => instance.getStatus().message?.includes('shutdown could not be confirmed') === true);

    const originalOwner = fs.readFileSync(paths.ownerPath, 'utf8');
    const replacementOwner = JSON.stringify({
      ...JSON.parse(originalOwner),
      ownerIdHash: 'a'.repeat(64),
      createdAt: 'replacement-owner'
    });
    fs.writeFileSync(`${paths.ownerPath}.tmp`, originalOwner);
    fs.writeFileSync(paths.ownerPath, replacementOwner);

    await child.exit();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fs.existsSync(`${paths.ownerPath}.tmp`), false, 'the exact failed owner must be cleared');
    assert.equal(fs.readFileSync(paths.ownerPath, 'utf8'), replacementOwner, 'a replacement owner must survive stale cleanup');
    assert.equal(instance.child, null);
    assert.equal(instance.managedPort, null);

    child.emit('exit', 0, null);
    assert.equal(fs.readFileSync(paths.ownerPath, 'utf8'), replacementOwner, 'late cleanup must run only once');
  } finally {
    await child.exit();
    fs.rmSync(paths.ownerPath, { force: true });
    fs.rmSync(`${paths.ownerPath}.tmp`, { force: true });
  }
});

test('rejected second start cannot redirect owner cleanup away from the managed port', async () => {
  const oldPort = await freePortPair();
  const newPort = await freePortPair();
  const child = fakeChild({ port: oldPort });
  const { instance, paths } = await createLifecycle(oldPort, child);

  try {
    assert.deepEqual(await instance.start(oldPort), { state: 'running', port: oldPort });
    assert.deepEqual(await instance.start(newPort), {
      state: 'error',
      code: 'START_FAILED',
      port: newPort,
      message: 'Gateway is already managed by this application.'
    });
    assert.equal(instance.child, child);
    assert.equal(instance.managedPort, oldPort);
    assert.equal(fs.existsSync(paths.ownerPath), true);

    assert.deepEqual(await instance.stop(), { state: 'stopped' });
    assert.equal(fs.existsSync(paths.ownerPath), false);
  } finally {
    await child.exit();
  }
});

test('keeps a child with one valid minimal attestation running', async () => {
  const port = await freePortPair();
  const child = fakeChild({ port });
  const { instance } = await createLifecycle(port, child);

  assert.deepEqual(await instance.start(port), { state: 'running', port });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(instance.getStatus(), { state: 'running', port });
  assert.equal(child.killCalls, 0);
  await instance.stop();
});
