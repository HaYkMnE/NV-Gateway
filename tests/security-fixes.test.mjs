import os from 'node:os';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const runtimePaths = {
  configPath: path.join(os.tmpdir(), 'security-fix-config.json'),
  statePath: path.join(os.tmpdir(), 'security-fix-state.json'),
  ownerPath: path.join(os.tmpdir(), 'security-fix-owner.json'),
  appLogPath: path.join(os.tmpdir(), 'security-fix-app.jsonl'),
  stdioLogPath: path.join(os.tmpdir(), 'security-fix-stdio.jsonl'),
  logPath: path.join(os.tmpdir(), 'security-fix-gateway.jsonl')
};

function completeState() {
  return {
    keys: [],
    credentials: {
      gatewayToken: 'fixture-gateway-token',
      adminToken: 'fixture-admin-token'
    }
  };
}

function preparedState(name) {
  return {
    keys: [{ key: `fixture-${name}-key` }],
    credentials: {
      gatewayToken: `fixture-${name}-gateway-token`,
      adminToken: `fixture-${name}-admin-token`
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

test('lifecycle rejects invalid post-construction state ingress before child or IPC work and preserves its valid state', async () => {
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  let spawnCalls = 0;
  let persistedStates = 0;
  let statusChanges = 0;
  const instance = new GatewayLifecycle({
    executablePath: process.execPath,
    serverPath: path.join(root, 'src', 'gateway', 'server.mjs'),
    runtimePaths,
    initialState: completeState(),
    spawnChild: () => {
      spawnCalls += 1;
      throw new Error('spawn must not be called');
    },
    persistState: () => { persistedStates += 1; },
    onStatusChange: () => { statusChanges += 1; }
  });
  instance.preflight = async () => null;

  for (const invalid of [undefined, null, {}, { keys: [] }, { credentials: completeState().credentials }, { keys: [], credentials: { gatewayToken: '', adminToken: 'valid' } }]) {
    assert.throws(() => instance.replaceInitialState(invalid), /Gateway lifecycle state is invalid\./);
    await assert.rejects(() => instance.startPrepared(invalid, 12000), /Gateway lifecycle state is invalid\./);
  }

  assert.deepEqual(instance.getStatus(), { state: 'stopped' });
  assert.equal(spawnCalls, 0);
  assert.equal(persistedStates, 0);
  assert.equal(statusChanges, 0);
  assert.deepEqual(instance.initialState, completeState());
});

test('lifecycle status boundary redacts registered child failure secrets before callbacks, snapshots, and lifecycle logging', async () => {
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const redaction = await import(built('redaction.js'));
  const secret = 'runtime-status-secret-98374651';
  const statuses = [];
  const lifecycleEvents = [];
  redaction.setRuntimeSecrets([secret]);
  try {
    const instance = new GatewayLifecycle({
      executablePath: process.execPath,
      serverPath: path.join(root, 'src', 'gateway', 'server.mjs'),
      runtimePaths,
      initialState: completeState(),
      spawnChild: () => { throw new Error(`child spawn failed: ${secret}`); },
      onStatusChange: (status) => statuses.push(status),
      onLifecycleEvent: (event, data) => lifecycleEvents.push({ event, data })
    });
    instance.preflight = async () => null;

    const status = await instance.start(12000);
    const outward = JSON.stringify({ status, snapshot: instance.getStatus(), statuses, lifecycleEvents });
    assert.equal(outward.includes(secret), false);
    assert.equal(status.code, 'START_FAILED');
    assert.match(status.message, /Gateway child process error: .*\[REDACTED\]/);
    assert.equal(lifecycleEvents[0].event, 'gateway_lifecycle');
  } finally {
    redaction.setRuntimeSecrets([]);
  }
});

test('main redaction removes URL queries and fragments from child stdio, lifecycle status surfaces, and app logs', async () => {
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const main = await import(built('redaction.js'));
  const shared = await import(pathToFileURL(path.join(root, 'src', 'shared', 'redaction.mjs')).href);
  const logger = await import(built('app-logger.js'));
  const sandbox = path.join(os.tmpdir(), `nvgw-redaction-${process.pid}-${Date.now()}`);
  const stdioLogPath = path.join(sandbox, 'gateway-stdio.jsonl');
  const appLogPath = path.join(sandbox, 'app.jsonl');
  const querySecret = 'unknown-query-credential';
  const url = `https://host/path?token=${querySecret}&x=visible#frag`;
  const plainUrl = 'https://host/path';
  const statuses = [];
  const lifecycleEvents = [];

  try {
    assert.equal(main.redact(url), shared.redact(url));
    assert.equal(main.redact(plainUrl), plainUrl);
    assert.equal(shared.redact(plainUrl), plainUrl);

    const instance = new GatewayLifecycle({
      executablePath: process.execPath,
      serverPath: path.join(root, 'src', 'gateway', 'server.mjs'),
      runtimePaths: { ...runtimePaths, stdioLogPath },
      initialState: completeState(),
      spawnChild: () => { throw new Error('spawn is not used'); },
      stdioLogPath,
      onStatusChange: (status) => statuses.push(status),
      onLifecycleEvent: (event, data) => lifecycleEvents.push({ event, data })
    });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    instance.captureOutput(child);
    child.stdout.emit('data', Buffer.from(url));
    instance.setStatus({ state: 'error', code: 'START_FAILED', message: url });

    logger.initAppLogger(appLogPath);
    logger.logAppEvent('error', 'gateway_lifecycle', { message: url });

    const exposed = JSON.stringify({
      status: instance.getStatus(),
      statuses,
      lifecycleEvents,
      stdio: fs.readFileSync(stdioLogPath, 'utf8'),
      appLog: fs.readFileSync(appLogPath, 'utf8')
    });
    assert.equal(exposed.includes(querySecret), false);
    assert.equal(exposed.includes('?token='), false);
    assert.equal(exposed.includes('&x='), false);
    assert.equal(exposed.includes('#frag'), false);
    assert.match(exposed, /https:\/\/host\/path/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('main and shared redactors sanitize every embedded http URL without changing ordinary text', async () => {
  const main = await import(built('redaction.js'));
  const shared = await import(pathToFileURL(path.join(root, 'src', 'shared', 'redaction.mjs')).href);
  const ordinary = 'ordinary diagnostic text has no URL';
  const diagnostic = 'first https://user:password@example.test/path?token=percent%2Dencoded#fragment then https://example.test/fragment-only#private and https://example.test/plain';
  const expected = 'first https://example.test/path then https://example.test/fragment-only and https://example.test/plain';

  for (const redactor of [main.redact, shared.redact]) {
    assert.equal(redactor(ordinary), ordinary);
    assert.equal(redactor(diagnostic), expected);
    assert.equal(redactor('before https://user@example.test/path after'), 'before https://example.test/path after');
    assert.equal(redactor('query https://example.test/path? tail'), 'query https://example.test/path tail');
    assert.equal(redactor('fragment https://example.test/path# tail'), 'fragment https://example.test/path tail');
    assert.equal(redactor('combined https://example.test/path?encoded%2Dvalue#fragment tail'), 'combined https://example.test/path tail');
  }
});

test('main and shared redactors sanitize literal structural delimiters and up to triple-encoded URLs without decoding unrelated prose', async () => {
  const main = await import(built('redaction.js'));
  const shared = await import(pathToFileURL(path.join(root, 'src', 'shared', 'redaction.mjs')).href);
  const secret = 'percent-encoded-url-secret-marker';
  const literal = `HTTPS://user:${secret}@example.test/path?token=${secret}%2Dquery#fragment%2D${secret}`;
  const literalStructuralDelimiters = `https://example.test/path%3Fkey%3D${secret}%23fragment%3D${secret}`;
  const encoded = encodeURIComponent(literal);
  const doubleEncoded = encodeURIComponent(encoded);
  const tripleEncoded = encodeURIComponent(doubleEncoded);
  const ordinary = 'ordinary prose keeps status%3A value%2Fpath%3Ftoken%3Dignored%23fragment';
  const malformed = 'diagnostic https%3A%2F%2Fexample.test%2Fpath%ZZ trailing';

  for (const input of [literal, literalStructuralDelimiters, encoded, doubleEncoded, tripleEncoded]) {
    const mainOutput = main.redact(`diagnostic ${input} complete`);
    const sharedOutput = shared.redact(`diagnostic ${input} complete`);
    assert.equal(mainOutput, sharedOutput);
    assert.equal(mainOutput.includes(secret), false);
    assert.equal(mainOutput.includes('?token='), false);
    assert.equal(mainOutput.includes('#fragment'), false);
    assert.equal(mainOutput.includes('https://example.test/path'), true);
  }

  assert.equal(main.redact(ordinary), ordinary);
  assert.equal(shared.redact(ordinary), ordinary);
  assert.equal(main.redact(malformed), 'diagnostic [redacted-url] trailing');
  assert.equal(shared.redact(malformed), 'diagnostic [redacted-url] trailing');
});

test('lifecycle redacts embedded URL credentials across output, snapshots, callbacks, events, logger, and adapter-facing status', async () => {
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const logger = await import(built('app-logger.js'));
  const sandbox = path.join(os.tmpdir(), `nvgw-embedded-url-${process.pid}-${Date.now()}`);
  const stdioLogPath = path.join(sandbox, 'gateway-stdio.jsonl');
  const appLogPath = path.join(sandbox, 'app.jsonl');
  const diagnostic = 'failed at https://user:password@example.test/path?token=encoded%2Dvalue#fragment';
  const statuses = [];
  const lifecycleEvents = [];

  try {
    const instance = new GatewayLifecycle({
      executablePath: process.execPath,
      serverPath: path.join(root, 'src', 'gateway', 'server.mjs'),
      runtimePaths: { ...runtimePaths, stdioLogPath },
      initialState: completeState(),
      spawnChild: () => { throw new Error('spawn is not used'); },
      stdioLogPath,
      onStatusChange: (status) => statuses.push(status),
      onLifecycleEvent: (event, data) => lifecycleEvents.push({ event, data })
    });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    instance.captureOutput(child);
    child.stdout.emit('data', Buffer.from(diagnostic));
    instance.setStatus({ state: 'error', code: 'START_FAILED', message: diagnostic });
    logger.initAppLogger(appLogPath);
    logger.logAppEvent('error', 'gateway_lifecycle', { message: diagnostic });

    const outward = JSON.stringify({
      outputBuffer: instance.output,
      snapshot: instance.getStatus(),
      callback: statuses,
      event: lifecycleEvents,
      logger: fs.readFileSync(appLogPath, 'utf8'),
      stdio: fs.readFileSync(stdioLogPath, 'utf8'),
      trayAndIpcAdapterStatus: instance.getStatus()
    });
    assert.equal(outward.includes('password'), false);
    assert.equal(outward.includes('encoded%2Dvalue'), false);
    assert.equal(outward.includes('?token='), false);
    assert.equal(outward.includes('#fragment'), false);
    assert.equal(outward.includes('https://example.test/path'), true);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('lifecycle fanout redacts literal structural delimiters and up to triple percent-encoded URL credentials', async () => {
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const logger = await import(built('app-logger.js'));
  const sandbox = path.join(os.tmpdir(), `nvgw-encoded-url-${process.pid}-${Date.now()}`);
  const stdioLogPath = path.join(sandbox, 'gateway-stdio.jsonl');
  const appLogPath = path.join(sandbox, 'app.jsonl');
  const secret = 'lifecycle-percent-encoded-secret-marker';
  const literal = `https://user:${secret}@example.test/path?token=${secret}%2Dquery#fragment%2D${secret}`;
  const literalStructuralDelimiters = `https://example.test/path%3Fkey%3D${secret}%23fragment%3D${secret}`;
  const encoded = encodeURIComponent(literal);
  const diagnostics = [literalStructuralDelimiters, encoded, encodeURIComponent(encoded), encodeURIComponent(encodeURIComponent(encoded))];
  const statuses = [];
  const lifecycleEvents = [];

  try {
    const instance = new GatewayLifecycle({
      executablePath: process.execPath,
      serverPath: path.join(root, 'src', 'gateway', 'server.mjs'),
      runtimePaths: { ...runtimePaths, stdioLogPath },
      initialState: completeState(),
      spawnChild: () => { throw new Error('spawn is not used'); },
      stdioLogPath,
      onStatusChange: (status) => statuses.push(status),
      onLifecycleEvent: (event, data) => lifecycleEvents.push({ event, data })
    });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    instance.captureOutput(child);
    logger.initAppLogger(appLogPath);

    for (const diagnostic of diagnostics) {
      child.stdout.emit('data', Buffer.from(diagnostic));
      instance.setStatus({ state: 'error', code: 'START_FAILED', message: diagnostic });
      logger.logAppEvent('error', 'gateway_lifecycle', { message: diagnostic });
    }

    const outward = JSON.stringify({
      outputBuffer: instance.output,
      snapshot: instance.getStatus(),
      callback: statuses,
      event: lifecycleEvents,
      logger: fs.readFileSync(appLogPath, 'utf8'),
      stdio: fs.readFileSync(stdioLogPath, 'utf8'),
      trayAndIpcAdapterStatus: instance.getStatus()
    });
    assert.equal(outward.includes(secret), false);
    assert.equal(outward.includes('?token='), false);
    assert.equal(outward.includes('#fragment'), false);
    assert.equal(outward.includes('https://example.test/path'), true);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('failed prepared start cannot restore state over a synchronous valid replacement', async () => {
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const original = preparedState('original');
  const prepared = preparedState('prepared');
  const replacement = preparedState('replacement');
  const entered = deferred();
  const release = deferred();
  const instance = new GatewayLifecycle({
    executablePath: process.execPath,
    serverPath: path.join(root, 'src', 'gateway', 'server.mjs'),
    runtimePaths,
    initialState: original,
    spawnChild: () => { throw new Error('spawn is not used'); }
  });
  instance.startInternal = async () => {
    entered.resolve();
    await release.promise;
    return { state: 'error', code: 'START_FAILED', port: 12000, message: 'controlled failure' };
  };

  const pending = instance.startPrepared(prepared, 12000);
  await entered.promise;
  instance.replaceInitialState(replacement);
  replacement.keys[0].key = 'mutated-after-replacement';
  release.resolve();

  assert.equal((await pending).state, 'error');
  assert.deepEqual(instance.initialState, preparedState('replacement'));
});

test('overlapping startPrepared calls retain the first queued state for its child IPC', async () => {
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const firstState = preparedState('first');
  const secondState = preparedState('second');
  const preflightHeld = deferred();
  const preflightCalled = deferred();
  const startupHeld = deferred();
  const firstSpawned = deferred();
  const sent = [];
  let spawnCalls = 0;
  const child = new EventEmitter();
  child.pid = 9191;
  child.exitCode = null;
  child.killed = false;
  child.connected = true;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.send = (message) => {
    sent.push(message);
    if (message?.type === 'state:init') {
      child.emit('message', { type: 'ports:bound', challenge: message.challenge, gatewayPort: 12000, adminPort: 12001 });
    }
  };
  const instance = new GatewayLifecycle({
    executablePath: process.execPath,
    serverPath: path.join(root, 'src', 'gateway', 'server.mjs'),
    runtimePaths,
    initialState: completeState(),
    spawnChild: () => {
      spawnCalls += 1;
      firstSpawned.resolve();
      return child;
    }
  });
  instance.preflight = async () => {
    preflightCalled.resolve();
    await preflightHeld.promise;
    return null;
  };
  instance.waitForHealthOrFailure = async () => {
    await startupHeld.promise;
    return null;
  };
  instance.verifyChildOwnership = async () => true;
  instance.writeOwnerRecord = () => {};

  const first = instance.startPrepared(firstState, 12000);
  await preflightCalled.promise;
  const second = instance.startPrepared(secondState, 12002);
  assert.deepEqual(instance.initialState, firstState);
  preflightHeld.resolve();
  await firstSpawned.promise;
  child.emit('message', { type: 'ready', challenge: 'fake-child-challenge-0123456789' });
  startupHeld.resolve();

  assert.deepEqual(await first, { state: 'running', port: 12000 });
  assert.deepEqual(sent.filter((message) => message?.type === 'state:init').map((message) => message.state), [firstState]);
  assert.deepEqual(await second, {
    state: 'error',
    code: 'START_FAILED',
    port: 12002,
    message: 'Gateway is already managed by this application.'
  });
  assert.equal(spawnCalls, 1);
});

test('validation and its admin adapter keep status information while excluding raw upstream diagnostics', async () => {
  const validation = await import(`${pathToFileURL(path.join(root, 'src', 'gateway', 'validation.mjs')).href}?validation=${Date.now()}`);
  const secret = 'runtime-validation-secret-774411';
  const response = new EventEmitter();
  response.statusCode = 403;
  response.destroy = () => {};
  const resultPromise = validation.collectValidationResponse(response, 4096);
  response.emit('data', Buffer.from(`Bearer ${secret} nvapi-${secret} ${secret}`));
  response.emit('end');
  const validationResult = await resultPromise;
  const validationText = JSON.stringify(validationResult);
  assert.equal(validationText.includes(secret), false);
  assert.equal(validationText.includes('Bearer '), false);
  assert.equal(validationText.includes('nvapi-'), false);
  assert.deepEqual(validationResult, { valid: false, statusCode: 403, reason: 'rejected', error: 'Validation request was rejected.' });

  const erroredResponse = new EventEmitter();
  erroredResponse.statusCode = 502;
  erroredResponse.destroy = () => {};
  const errorResultPromise = validation.collectValidationResponse(erroredResponse, 4096);
  erroredResponse.emit('error', new Error(`Bearer ${secret} nvapi-${secret}`));
  const errorResult = await errorResultPromise;
  assert.equal(JSON.stringify(errorResult).includes(secret), false);
  assert.deepEqual(errorResult, { valid: null, reason: 'upstream_error', error: 'Validation request failed.' });

  const previousLogPath = process.env.GATEWAY_LOG_PATH;
  process.env.GATEWAY_LOG_PATH = path.join(os.tmpdir(), 'security-fix-admin-log.jsonl');
  const admin = await import(`${pathToFileURL(path.join(root, 'src', 'gateway', 'admin-api.mjs')).href}?admin=${Date.now()}`);
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/admin/validate';
  req.headers = { authorization: 'Bearer test-admin-token' };
  const writes = [];
  const res = {
    writeHead: (statusCode, headers) => writes.push({ statusCode, headers }),
    end: (body) => writes.push({ body })
  };
  const done = admin.handleAdminRequest(req, res, {
    adminToken: 'test-admin-token',
    validateKey: async () => ({ valid: false, statusCode: 401, body: `Bearer ${secret}`, error: new Error(`nvapi-${secret}`) })
  });
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify({ key: 'nvapi-test-key' })));
    req.emit('end');
  });
  await done;
  const adminResponse = JSON.parse(writes.at(-1).body);
  assert.equal(writes[0].statusCode, 200);
  assert.equal(JSON.stringify(adminResponse).includes(secret), false);
  assert.deepEqual(adminResponse, { valid: false, statusCode: 401, reason: 'unauthorized', error: 'Validation request was rejected.' });
  if (previousLogPath === undefined) delete process.env.GATEWAY_LOG_PATH;
  else process.env.GATEWAY_LOG_PATH = previousLogPath;
});
