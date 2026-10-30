// CR7 (CodeRabbit full-program review) — Electron-main fixes, one regression
// test group per verified finding:
//   CR7-001 config writers dropped/pinned per-model fields (rateLimitMaxAttempts,
//           unknown fields, the "inherit global mode" state) on ANY config write.
//   CR7-002 main IPC called an admin route (/admin/performance) that does not exist.
//   CR7-005 admin-client never settled on a >2 MiB response (promise hung forever).
//   CR7-006 port-scanner reported "free" for bind errors other than EADDRINUSE.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const runtime = await import(built('gateway-runtime.js'));
const { createModelsHandlers } = await import(built('models-ipc.js'));
const { requestAdmin } = await import(built('admin-client.js'));
const { checkPort, findFreePort } = await import(built('port-scanner.js'));
const perfMode = await import(pathToFileURL(path.join(root, 'src', 'gateway', 'performance-mode.mjs')).href);
const failover = await import(pathToFileURL(path.join(root, 'src', 'gateway', 'failover-policy.mjs')).href);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-cr7-main-'));
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// CR7-001
// ---------------------------------------------------------------------------
const MODEL = 'z-ai/glm-5.2';
const INHERIT_MODEL = 'meta/llama-4-maverick-17b-128e-instruct';
const storedRecord = () => ({ enabled: true, rateLimitMaxAttempts: 5, maxFailoverAttempts: 3, futureField: { nested: 'keep-me' } });

function newConfig() {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'cfg-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    gatewayPort: 12000,
    language: 'en',
    setupComplete: true,
    performanceMode: 'day',
    perModelSettings: { [MODEL]: storedRecord(), [INHERIT_MODEL]: { enabled: true } },
    disabledModels: []
  }, null, 2));
  return configPath;
}
const rawRecord = (configPath, id = MODEL) => JSON.parse(fs.readFileSync(configPath, 'utf8')).perModelSettings[id];

test('CR7-001: an unrelated config write (language) leaves the stored per-model record byte-equal', () => {
  const configPath = newConfig();
  const before = JSON.stringify(rawRecord(configPath));
  runtime.writeAppConfig(configPath, { language: 'ru' });
  assert.equal(JSON.stringify(rawRecord(configPath)), before,
    'rateLimitMaxAttempts, unknown fields and the ABSENT performanceMode must survive a language write');
  assert.equal(JSON.stringify(rawRecord(configPath, INHERIT_MODEL)), JSON.stringify({ enabled: true }));
  // Key accounting: the gateway child still sees the stored 429 early-stop bound.
  assert.equal(perfMode.readPerModelRateLimitAttempts(MODEL, configPath), 5);
  assert.equal(failover.resolveRateLimitMaxAttempts({}, perfMode.readPerModelRateLimitAttempts(MODEL, configPath)), 3,
    'stored 5 is clamped to MAX 3 by the reader, not replaced by the default 2');
});

test('CR7-001: set-mode keeps every stored field and adds only the new mode', async () => {
  const configPath = newConfig();
  const handlers = createModelsHandlers({ dispatch: async () => ({ data: [] }), getConfigPath: () => configPath, writeAppConfig: runtime.writeAppConfig, protectFile: () => {} });
  const result = await handlers.updateModelSettings(MODEL, { mode: 'night' });
  assert.equal(result.mode, 'night');
  assert.deepEqual(rawRecord(configPath), { ...storedRecord(), performanceMode: 'night' });
  assert.deepEqual(rawRecord(configPath, INHERIT_MODEL), { enabled: true },
    'set-mode on one model must not pin the global mode onto another');
});

test('CR7-001: bulk toggle changes only `enabled` and never pins a mode', async () => {
  const configPath = newConfig();
  const handlers = createModelsHandlers({ dispatch: async () => ({ data: [] }), getConfigPath: () => configPath, writeAppConfig: runtime.writeAppConfig, protectFile: () => {} });
  await handlers.bulkToggleModels(false);
  assert.deepEqual(rawRecord(configPath), { ...storedRecord(), enabled: false });
  assert.deepEqual(rawRecord(configPath, INHERIT_MODEL), { enabled: false });
});

test('CR7-001: a model with no stored mode still follows a later global mode change', () => {
  const configPath = newConfig();
  runtime.writeAppConfig(configPath, { language: 'ru' });
  runtime.writeAppConfig(configPath, { performanceMode: 'night' });
  assert.equal(runtime.readAppConfig(configPath).perModelSettings[MODEL].performanceMode, 'night');
  assert.equal(runtime.getEffectivePerformanceMode(runtime.readAppConfig(configPath), INHERIT_MODEL), 'night');
  assert.equal(perfMode.readPerModelPerformanceMode(MODEL, configPath), null, 'child must see no per-model override');
  assert.equal('performanceMode' in rawRecord(configPath), false);
});

test('CR7-001: a perModelSettings update merges per id onto the raw record; invalid stays reader-validated', () => {
  const configPath = newConfig();
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  onDisk.perModelSettings[MODEL].firstByteTimeoutMs = 'not-a-number';
  fs.writeFileSync(configPath, JSON.stringify(onDisk));
  const returned = runtime.writeAppConfig(configPath, { perModelSettings: { [MODEL]: { performanceMode: 'auto' } } });
  assert.deepEqual(rawRecord(configPath), { ...storedRecord(), firstByteTimeoutMs: 'not-a-number', performanceMode: 'auto' });
  assert.deepEqual(rawRecord(configPath, INHERIT_MODEL), { enabled: true }, 'ids absent from the update are untouched');
  assert.equal(returned.perModelSettings[MODEL].firstByteTimeoutMs, undefined, 'normalized view still rejects the invalid value');
  assert.equal(perfMode.readPerModelFirstByteTimeoutMs(MODEL, configPath), null, 'child reader still rejects it too');
  assert.equal(returned.perModelSettings[INHERIT_MODEL].performanceMode, 'day');
});

// ---------------------------------------------------------------------------
// CR7-002
// ---------------------------------------------------------------------------
test('CR7-002: every admin path used by main IPC handlers exists in the admin-api route table', async () => {
  // The gateway logger requires these at import time; point them at the temp dir.
  process.env.GATEWAY_STATE_PATH = path.join(tempRoot, 'gateway-state.json');
  process.env.GATEWAY_LOG_PATH = path.join(tempRoot, 'gateway.jsonl');
  const adminApi = await import(`${pathToFileURL(path.join(root, 'src', 'gateway', 'admin-api.mjs')).href}?cr7=${Date.now()}`);
  const pattern = /method:\s*"(GET|POST|PATCH|DELETE)",\s*path:\s*(["`])(\/admin[^"`]*)\2/g;
  const calls = [];
  for (const file of fs.readdirSync(path.join(root, 'src', 'main')).filter((name) => name.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(root, 'src', 'main', file), 'utf8');
    for (const match of source.matchAll(pattern)) {
      calls.push({ file, method: match[1], pathname: match[3].replace(/\$\{[^}]+\}/g, '550e8400-e29b-41d4-a716-446655440000') });
    }
  }
  assert.ok(calls.length >= 8, `expected the known admin IPC calls, found ${calls.length}`);
  const missing = calls.filter(({ method, pathname }) => adminApi.classifyAdminRoute(method, pathname) === null);
  assert.deepEqual(missing, [], 'main must not call admin routes the gateway does not serve');
  const preload = fs.readFileSync(path.join(root, 'src', 'preload', 'index.ts'), 'utf8');
  assert.equal(/adminGetPerformance|admin-get-performance/.test(preload), false, 'dead preload entry must be gone');
});

// ---------------------------------------------------------------------------
// CR7-005
// ---------------------------------------------------------------------------
test('CR7-005: a >2 MiB admin response rejects promptly instead of hanging', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const pump = () => {
      while (sent < 3 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) { res.once('drain', pump); return; }
      }
      res.end();
    };
    res.on('error', () => {});
    pump();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const adminPort = server.address().port;
  try {
    const outcome = await Promise.race([
      requestAdmin(adminPort - 1, 'fake-admin-token', { method: 'GET', path: '/admin/logs' }).then(() => 'resolved', (error) => error),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 1000))
    ]);
    assert.ok(outcome instanceof Error, `expected a rejection within 1 s, got ${String(outcome)}`);
    assert.match(outcome.message, /exceeds 2 MiB/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// CR7-006
// ---------------------------------------------------------------------------
function withFakeServers(blocked, fn) {
  const original = net.createServer;
  net.createServer = () => {
    const server = new EventEmitter();
    server.listen = (port) => {
      queueMicrotask(() => {
        if (blocked.has(port)) {
          const error = new Error(`listen EACCES: permission denied 127.0.0.1:${port}`);
          error.code = 'EACCES';
          server.emit('error', error);
        } else {
          server.emit('listening');
        }
      });
      return server;
    };
    server.close = (callback) => { queueMicrotask(() => callback?.()); return server; };
    return server;
  };
  return Promise.resolve().then(fn).finally(() => { net.createServer = original; });
}

test('CR7-006: an EACCES bind (Windows excluded range) is reported busy, not free', async () => {
  await withFakeServers(new Set([5161]), async () => {
    assert.equal(await checkPort(5161), true);
    assert.equal(await checkPort(5163), false);
  });
});

test('CR7-006: findFreePort skips a pair whose port cannot be bound', async () => {
  await withFakeServers(new Set([40001]), async () => {
    assert.equal(await findFreePort(40000, 40010), 40002);
  });
});
