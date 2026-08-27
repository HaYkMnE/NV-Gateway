import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const adminIpc = await import(pathToFileURL(path.join(root, 'build', 'src', 'main', 'admin-ipc.js')).href);
const appConfigIpc = await import(pathToFileURL(path.join(root, 'build', 'src', 'main', 'app-config-ipc.js')).href);
const ipcHandler = await import(pathToFileURL(path.join(root, 'build', 'src', 'main', 'ipc-handler.js')).href);

test('stopped admin IPC returns a local structured error without a network request', async () => {
  let networkCalls = 0;
  const request = { method: 'GET', path: '/admin/keys' };
  const dispatch = adminIpc.createAdminIpcDispatcher({
    getStatus: () => ({ state: 'stopped' }),
    getCredentials: () => {
      throw new Error('credentials must not be read while stopped');
    },
    requestAdmin: async () => {
      networkCalls += 1;
      throw new Error('network client must not run while stopped');
    }
  });

  const errorLogs = [];
  const handler = ipcHandler.wrapIpcHandler('admin-list-keys', dispatch, (entry) => errorLogs.push(entry));
  const result = await handler(request);

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'GATEWAY_NOT_RUNNING',
      message: 'Gateway is not running.'
    }
  });
  assert.equal(networkCalls, 0);
  assert.deepEqual(errorLogs, []);
});

test('running admin IPC forwards the request and preserves its successful response', async () => {
  const request = { method: 'POST', path: '/admin/keys', body: { key: 'test-key' } };
  const expected = { keys: [{ id: 'key-1' }] };
  let received;
  const dispatch = adminIpc.createAdminIpcDispatcher({
    getStatus: () => ({ state: 'running', port: 12000 }),
    getCredentials: () => ({ port: 12000, token: 'admin-test-token' }),
    requestAdmin: async (port, token, actualRequest) => {
      received = { port, token, request: actualRequest };
      return expected;
    }
  });

  const result = await dispatch(request);

  assert.equal(result, expected);
  assert.deepEqual(received, { port: 12000, token: 'admin-test-token', request });
});

test('admin IPC aborts locally when stop begins after its running check', async () => {
  let stopStarted = false;
  let networkCalls = 0;
  const dispatch = adminIpc.createAdminIpcDispatcher({
    getStatus: () => ({ state: 'running', port: 12000 }),
    isStopping: () => stopStarted,
    getCredentials: () => {
      stopStarted = true;
      return { port: 12000, token: 'admin-test-token' };
    },
    requestAdmin: async () => {
      networkCalls += 1;
      throw new Error('network client must not run after stop begins');
    }
  });

  const errorLogs = [];
  const handler = ipcHandler.wrapIpcHandler('admin-list-keys', dispatch, (entry) => errorLogs.push(entry));
  const result = await handler({ method: 'GET', path: '/admin/keys' });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'GATEWAY_NOT_RUNNING',
      message: 'Gateway is not running.'
    }
  });
  assert.equal(networkCalls, 0);
  assert.deepEqual(errorLogs, []);
});

test('saving a performance mode persists config without retrying a running gateway', () => {
  const writes = [];
  let retryCalls = 0;
  const saved = { gatewayPort: 12000, language: 'en', setupComplete: true, performanceMode: 'night' };
  const save = appConfigIpc.createAppConfigUpdateHandler({
    getConfigPath: () => 'test-config.json',
    writeAppConfig: (configPath, update, protect) => {
      writes.push({ configPath, update, protect });
      return saved;
    },
    protectFile: () => {},
    validateBoolean: (value) => {
      if (typeof value !== 'boolean') throw new Error('Invalid boolean');
    },
    getStatus: () => ({ state: 'running', port: 12000 }),
    retryGateway: async () => { retryCalls += 1; }
  });

  const result = save({ performanceMode: 'night' });

  assert.deepEqual(result, { ...saved, status: { state: 'running', port: 12000 } },
    'the IPC must return the saved configuration and current gateway status');
  assert.deepEqual(writes.map(({ configPath, update }) => ({ configPath, update })), [
    { configPath: 'test-config.json', update: { performanceMode: 'night' } }
  ], 'the selected performance mode must be persisted');
  assert.equal(retryCalls, 0, 'saving a mode must not interrupt active streams with retryGateway');
});
