// Э1b (plan §12.11 Р4/Р5): the per-request deadline is an app setting
// (config.json `requestDeadlineMs`, written by Electron main through
// set-app-config/writeAppConfig) with ENV GATEWAY_REQUEST_DEADLINE_MS on top.
// Child resolution per request: valid ENV -> valid config -> 240000 ms.
// Invalid ENV counts as UNSET; invalid config counts as absent. Main-side tests
// load the compiled build output (run `npm run build` first, like `npm test`).
import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REQUEST_DEADLINE_MS, MAX_UPSTREAM_TIMEOUT_MS, resolveRequestDeadlineMs } from '../src/gateway/upstream-timeouts.mjs';
import * as performanceMode from '../src/gateway/performance-mode.mjs';
import { startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';
import { GATEWAY_START_MAX_ATTEMPTS, highPortReservation, killOnBindCollision } from './support/gateway-bind-collision.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const runtime = require(path.join(projectRoot, 'build', 'src', 'main', 'gateway-runtime.js'));
const appConfigIpc = require(path.join(projectRoot, 'build', 'src', 'main', 'app-config-ipc.js'));
const preloadPath = path.join(projectRoot, 'tests', 'local-upstream-preload.cjs');
const serverPath = path.join(projectRoot, 'src', 'gateway', 'server.mjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-e1b-${process.pid}-`));
const TOKEN = `test-gateway-${randomUUID()}`;
const INVALID_NUMBERS = [0, -1, 1.5, 1_800_001, Number.NaN, Number.POSITIVE_INFINITY];
const INVALID_VALUES = [...INVALID_NUMBERS, '240000', null, true, {}, []];

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

let fileSeq = 0;
function configFile(content) {
  const file = path.join(tempRoot, `config-${fileSeq++}.json`);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

test('Э1b: main and gateway agree on the default (240000) and the ceiling (1800000)', () => {
  assert.equal(DEFAULT_REQUEST_DEADLINE_MS, 240_000);
  assert.equal(MAX_UPSTREAM_TIMEOUT_MS, 1_800_000);
  assert.equal(runtime.DEFAULT_REQUEST_DEADLINE_MS, DEFAULT_REQUEST_DEADLINE_MS);
  assert.equal(runtime.MAX_REQUEST_DEADLINE_MS, MAX_UPSTREAM_TIMEOUT_MS);
});

test('Э1b normalize: absent -> 240000, valid kept, every invalid value -> 240000', () => {
  assert.equal(runtime.readAppConfig(configFile({})).requestDeadlineMs, 240_000);
  assert.equal(runtime.readAppConfig(path.join(tempRoot, 'missing.json')).requestDeadlineMs, 240_000);
  for (const valid of [1, 800, 240_000, 1_800_000]) {
    assert.equal(runtime.readAppConfig(configFile({ requestDeadlineMs: valid })).requestDeadlineMs, valid, String(valid));
  }
  for (const invalid of INVALID_VALUES) {
    const file = configFile(`{"requestDeadlineMs": ${JSON.stringify(invalid) ?? 'null'}}`);
    assert.equal(runtime.readAppConfig(file).requestDeadlineMs, 240_000, `invalid ${String(invalid)}`);
  }
});

// D1: main resolves the EFFECTIVE deadline + its SOURCE with the child's rules
// (valid ENV -> valid stored setting -> 240000; invalid ENV counts as unset).
const ENV = 'GATEWAY_REQUEST_DEADLINE_MS';
const INVALID_ENV = ['', '0', '-5', '1.5', ' 800', '800ms', '1800001', '9'.repeat(20), 'abc'];

test('Э1b D1 resolveEffectiveRequestDeadline: source/effective matrix', () => {
  const resolve = runtime.resolveEffectiveRequestDeadline;
  assert.equal(typeof resolve, 'function', 'shared resolver must be exported from gateway-runtime');
  assert.deepEqual(resolve({ [ENV]: '5000' }, 90_000), { requestDeadlineMs: 5_000, requestDeadlineSource: 'env' });
  assert.deepEqual(resolve({ [ENV]: '1800000' }, undefined), { requestDeadlineMs: 1_800_000, requestDeadlineSource: 'env' });
  for (const bad of INVALID_ENV) {
    assert.deepEqual(resolve({ [ENV]: bad }, 90_000), { requestDeadlineMs: 90_000, requestDeadlineSource: 'config' }, `env ${JSON.stringify(bad)}`);
    assert.deepEqual(resolve({ [ENV]: bad }, undefined), { requestDeadlineMs: 240_000, requestDeadlineSource: 'default' }, `env ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(resolve({}, 90_000), { requestDeadlineMs: 90_000, requestDeadlineSource: 'config' });
  assert.deepEqual(resolve({}, undefined), { requestDeadlineMs: 240_000, requestDeadlineSource: 'default' });
  for (const invalid of INVALID_VALUES) {
    assert.deepEqual(resolve({}, invalid), { requestDeadlineMs: 240_000, requestDeadlineSource: 'default' }, `stored ${String(invalid)}`);
  }
  // A stored 240000 chosen by the user is 'config', not 'default'.
  assert.deepEqual(resolve({}, 240_000), { requestDeadlineMs: 240_000, requestDeadlineSource: 'config' });
});

test('Э1b D1: main effective value agrees with the child resolver for every ENV/stored pair', () => {
  for (const envValue of [undefined, '5000', '0800', ...INVALID_ENV]) {
    for (const stored of [undefined, 90_000, 0, 1_800_001]) {
      const environment = envValue === undefined ? {} : { [ENV]: envValue };
      const childMs = resolveRequestDeadlineMs(environment, stored ?? null);
      assert.equal(runtime.resolveEffectiveRequestDeadline(environment, stored).requestDeadlineMs, childMs, `env ${envValue} stored ${stored}`);
    }
  }
});

test('Э1b D1 get-runtime-state payload: effective requestDeadlineMs + requestDeadlineSource', () => {
  const read = runtime.readRuntimeAppConfigCached;
  assert.equal(typeof read, 'function', 'runtime-state reader must be exported from gateway-runtime');
  const stored = configFile({ language: 'ru', requestDeadlineMs: 90_000 });
  const empty = configFile({ language: 'ru' });
  const bad = configFile({ language: 'ru', requestDeadlineMs: 0 });
  const cases = [
    [stored, { [ENV]: '5000' }, 5_000, 'env'],
    [stored, { [ENV]: 'nope' }, 90_000, 'config'],
    [stored, {}, 90_000, 'config'],
    [empty, {}, 240_000, 'default'],
    [bad, {}, 240_000, 'default'],
    [path.join(tempRoot, 'missing-d1.json'), {}, 240_000, 'default'],
  ];
  for (const [file, environment, ms, source] of cases) {
    runtime.invalidateAppConfigCache();
    const payload = read(file, environment);
    assert.equal(payload.requestDeadlineMs, ms, `${path.basename(file)} ${JSON.stringify(environment)}`);
    assert.equal(payload.requestDeadlineSource, source, `${path.basename(file)} ${JSON.stringify(environment)}`);
    assert.equal(payload.language, file === cases[5][0] ? 'en' : 'ru', 'rest of the config is still served');
    // The cached config itself keeps its existing contract (stored value or 240000 default).
    assert.equal(runtime.readAppConfigCached(file).requestDeadlineSource, undefined);
  }
  runtime.invalidateAppConfigCache();
});

test('Э1b D1/D2: IPC handler uses the resolver; the four type declarations stay in sync', () => {
  const src = (rel) => fs.readFileSync(path.join(projectRoot, ...rel.split('/')), 'utf8');
  const main = src('src/main/index.ts');
  const handler = main.slice(main.indexOf('ipcMain.handle("get-runtime-state"'), main.indexOf('ipcMain.handle("set-app-config"'));
  assert.match(handler, /readRuntimeAppConfigCached\(gatewayRuntime\.configPath\)/, 'get-runtime-state must serve the effective deadline');
  const setLine = main.split('\n').find((line) => line.includes('ipcMain.handle("set-app-config"'));
  assert.match(setLine, /requestDeadlineMs\?: number/, 'index.ts inline set-app-config type');
  assert.match(src('src/main/app-config-ipc.ts'), /requestDeadlineMs\?: number;/, 'AppConfigUpdate');
  const preloadLine = src('src/preload/index.ts').split('\n').find((line) => line.includes('setAppConfig:'));
  assert.match(preloadLine, /requestDeadlineMs\?: number/, 'preload setAppConfig type');
  const globals = src('src/renderer/global.d.ts');
  const globalSetLine = globals.split('\n').find((line) => line.includes('setAppConfig:'));
  assert.match(globalSetLine, /requestDeadlineMs\?: number/, 'global.d.ts setAppConfig type');
  const runtimeStateLine = globals.split('\n').find((line) => line.includes('interface RuntimeState'));
  assert.match(runtimeStateLine, /requestDeadlineMs: number/, 'RuntimeState.requestDeadlineMs');
  assert.match(runtimeStateLine, /requestDeadlineSource: 'env' \| 'config' \| 'default'/, 'RuntimeState.requestDeadlineSource');
});

test('Э1b writeAppConfig: persists a valid value, rejects invalid ones and leaves the file untouched', () => {
  const file = configFile({ version: 1, gatewayPort: 12000, language: 'ru' });
  const saved = runtime.writeAppConfig(file, { requestDeadlineMs: 60_000 });
  assert.equal(saved.requestDeadlineMs, 60_000);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).requestDeadlineMs, 60_000);
  assert.equal(runtime.readAppConfig(file).language, 'ru', 'other fields survive the write');
  const before = fs.readFileSync(file, 'utf8');
  for (const invalid of INVALID_VALUES) {
    assert.throws(() => runtime.writeAppConfig(file, { requestDeadlineMs: invalid }), /Invalid request deadline/, String(invalid));
    assert.equal(fs.readFileSync(file, 'utf8'), before, `file unchanged after ${String(invalid)}`);
  }
});

// The key means "the user chose it": an unrelated write must never materialize
// the code default on disk, or a later change of that default would not reach users.
test('Э1b writeAppConfig: an unrelated write does not add requestDeadlineMs to disk', () => {
  const file = configFile({ version: 1, gatewayPort: 12000, language: 'en' });
  const saved = runtime.writeAppConfig(file, { language: 'ru' });
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.language, 'ru');
  assert.equal(Object.hasOwn(disk, 'requestDeadlineMs'), false, 'default must not be persisted');
  assert.equal(saved.requestDeadlineMs, 240_000, 'returned state still carries the read-time default');
  assert.equal(runtime.readAppConfig(file).requestDeadlineMs, 240_000);
});

test('Э1b writeAppConfig: an invalid on-disk value is removed, not rewritten to 240000', () => {
  for (const invalid of ['"800"', '0', '1.5', 'null', '1800001']) {
    const file = configFile(`{"version":1,"gatewayPort":12000,"language":"en","requestDeadlineMs":${invalid}}`);
    runtime.writeAppConfig(file, { language: 'ru' });
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(disk.language, 'ru', invalid);
    assert.equal(Object.hasOwn(disk, 'requestDeadlineMs'), false, `invalid ${invalid} must be dropped`);
  }
});

test('Э1b writeAppConfig: a user-set valid value survives an unrelated write', () => {
  const file = configFile({ version: 1, gatewayPort: 12000, language: 'en', requestDeadlineMs: 90_000 });
  const saved = runtime.writeAppConfig(file, { language: 'ru' });
  assert.equal(saved.requestDeadlineMs, 90_000);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).requestDeadlineMs, 90_000);
});

test('Э1b IPC set-app-config: validates requestDeadlineMs before any write', () => {
  const writes = [];
  const save = appConfigIpc.createAppConfigUpdateHandler({
    getConfigPath: () => 'test-config.json',
    writeAppConfig: (configPath, update) => { writes.push(update); return { requestDeadlineMs: update.requestDeadlineMs }; },
    protectFile: () => {},
    validateBoolean: (value) => { if (typeof value !== 'boolean') throw new Error('Invalid boolean'); }
  });
  for (const invalid of INVALID_VALUES) {
    assert.throws(() => save({ requestDeadlineMs: invalid }), /Invalid request deadline/, String(invalid));
  }
  assert.deepEqual(writes, [], 'no invalid value may reach writeAppConfig');
  assert.deepEqual(save({ requestDeadlineMs: 1_800_000 }), { requestDeadlineMs: 1_800_000 });
  assert.deepEqual(save({ requestDeadlineMs: 1 }), { requestDeadlineMs: 1 });
  assert.deepEqual(writes, [{ requestDeadlineMs: 1_800_000 }, { requestDeadlineMs: 1 }]);
});

test('IPC set-app-config: only allowlisted keys reach writeAppConfig; unknown own keys are rejected', () => {
  const file = configFile({ version: 1, gatewayPort: 12000, language: 'en' });
  const before = fs.readFileSync(file, 'utf8');
  const writes = [];
  const save = appConfigIpc.createAppConfigUpdateHandler({
    getConfigPath: () => file,
    writeAppConfig: (configPath, update, protect) => { writes.push(update); return runtime.writeAppConfig(configPath, update, protect); },
    protectFile: () => {},
    validateBoolean: (value) => { if (typeof value !== 'boolean') throw new Error('Invalid boolean'); }
  });
  const rejected = [
    { gatewayPort: 12002 },
    { language: 'ru', gatewayPort: 12002 },
    { perModelSettings: { m: { temperature: 1 } } },
    { disabledModels: ['m'] },
    { modelLimits: {} },
    { someUnknownKey: 1 },
    // Least privilege: no renderer caller sends autoStartGateway, so it is not renderer-writable.
    { autoStartGateway: false },
    { language: 'ru', autoStartGateway: true },
    JSON.parse('{"__proto__":{"polluted":true}}'),
    JSON.parse('{"language":"ru","__proto__":{"polluted":true}}'),
    JSON.parse('{"constructor":{"prototype":{"polluted":true}}}'),
    { [Symbol('s')]: 1 },
    []
  ];
  for (const update of rejected) {
    assert.throws(() => save(update), /Invalid config update/, JSON.stringify(update));
  }
  assert.deepEqual(writes, [], 'a rejected update must not reach writeAppConfig');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'config file untouched by rejected updates');
  assert.equal({}.polluted, undefined);

  const accepted = [
    { language: 'ru' },
    { setupComplete: true },
    { performanceMode: 'night' },
    { requestDeadlineMs: 90_000 },
    { language: 'en', setupComplete: true }
  ];
  for (const update of accepted) save(update);
  assert.deepEqual(writes, accepted, 'legitimate updates are forwarded unchanged');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.gatewayPort, 12000);
  assert.equal(stored.language, 'en');
  assert.equal(stored.performanceMode, 'night');
  assert.equal(stored.requestDeadlineMs, 90_000);
});

test('Э1b child reader: config requestDeadlineMs is read, invalid/absent -> null', () => {
  const read = performanceMode.readConfiguredRequestDeadlineMs;
  assert.equal(typeof read, 'function');
  assert.equal(read(undefined), null);
  assert.equal(read(path.join(tempRoot, 'missing-child.json')), null);
  assert.equal(read(configFile('{not json')), null);
  assert.equal(read(configFile({})), null);
  assert.equal(read(configFile({ requestDeadlineMs: 800 })), 800);
  for (const invalid of INVALID_VALUES) {
    assert.equal(read(configFile(`{"requestDeadlineMs": ${JSON.stringify(invalid) ?? 'null'}}`)), null, String(invalid));
  }
});

test('Э1b resolution matrix: valid ENV > valid config > 240000; invalid ENV is unset', () => {
  const env = (value) => ({ GATEWAY_REQUEST_DEADLINE_MS: value });
  assert.equal(resolveRequestDeadlineMs(env('60000'), 800), 60_000, 'valid ENV wins over config');
  assert.equal(resolveRequestDeadlineMs(env('1800000'), 800), 1_800_000);
  for (const invalidEnv of ['0', '-1', '1.5', '1800001', 'abc', '', ' 800']) {
    assert.equal(resolveRequestDeadlineMs(env(invalidEnv), 800), 800, `invalid ENV ${JSON.stringify(invalidEnv)} -> config`);
    assert.equal(resolveRequestDeadlineMs(env(invalidEnv), null), 240_000, `invalid ENV ${JSON.stringify(invalidEnv)}, no config -> default`);
  }
  assert.equal(resolveRequestDeadlineMs({}, 800), 800, 'no ENV -> config');
  assert.equal(resolveRequestDeadlineMs({}, null), 240_000, 'both absent -> default');
  assert.equal(resolveRequestDeadlineMs({}), 240_000);
  for (const invalid of INVALID_VALUES) {
    assert.equal(resolveRequestDeadlineMs({}, invalid), 240_000, `invalid config ${String(invalid)} -> default`);
  }
});

function health(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/health' }, (response) => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    request.once('error', reject);
    request.setTimeout(1_000, () => request.destroy(new Error('health timeout')));
  });
}

function post(port, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: {
      authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body)
    } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.once('end', () => { clearTimeout(timer); resolve({ statusCode: response.statusCode, body: text }); });
    });
    const timer = setTimeout(() => { request.destroy(); reject(new Error(`no answer within ${timeoutMs}ms`)); }, timeoutMs);
    request.once('error', (error) => { clearTimeout(timer); reject(error); });
    request.end(body);
  });
}

const gone = (child) => child.exitCode !== null || child.signalCode !== null;
async function stopGateway(child) {
  if (!child || gone(child)) return;
  const exited = (ms) => new Promise((resolve) => {
    if (gone(child)) { resolve(true); return; }
    const timer = setTimeout(() => resolve(gone(child)), ms);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
  try { if (child.connected) child.send({ type: 'shutdown' }); } catch { /* gone */ }
  if (await exited(2_000)) return;
  child.kill();
  if (!(await exited(1_000))) { child.kill('SIGKILL'); await exited(1_000); }
}

test('Э1b e2e: config.json requestDeadlineMs=800 with no ENV is applied by the child (silent upstream -> 504)', { timeout: 40_000 }, async () => {
  const pending = [];
  const upstream = http.createServer((request, response) => { request.resume(); pending.push(response); });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const dir = path.join(tempRoot, 'e2e');
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, requestDeadlineMs: 800 }));
  const env = { ...process.env };
  delete env.GATEWAY_REQUEST_DEADLINE_MS;
  const keys = [{ id: 'e1b-key', key: 'fake-e1b-key', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 } }];
  let child;
  let port;
  try {
    // Shared reserved-port start (same as e1a): the pair stays reserved until THIS
    // child attests ports:bound; a bind collision (stderr marker) retries a fresh pair.
    let detachCollisionWatch = () => {};
    const startBy = Date.now() + 12_000;
    const started = await startGatewayOnReservedPort({
      maxAttempts: GATEWAY_START_MAX_ATTEMPTS,
      reservationOptions: highPortReservation(),
      readinessTimeoutMs: Math.max(1, startBy - Date.now()),
      spawnChild(candidate, attempt) {
        // Total budget check per attempt: a non-collision error ends the helper's loop.
        if (Date.now() >= startBy) throw new Error(`gateway start budget exhausted after attempt ${attempt - 1}`);
        const spawned = spawnChild(process.execPath, ['--require', preloadPath, serverPath], {
          env: { ...env, PORT: String(candidate), GATEWAY_CONFIG_PATH: configPath, GATEWAY_LOG_PATH: path.join(dir, `gateway-${attempt}.jsonl`),
            GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstream.address().port), GATEWAY_FIRST_BYTE_TIMEOUT_MS: '5000', GATEWAY_IDLE_TIMEOUT_MS: '5000' },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          windowsHide: true
        });
        detachCollisionWatch = killOnBindCollision(spawned);
        spawned.once('message', (message) => {
          if (message?.type === 'ready') spawned.send({ type: 'state:init', challenge: message.challenge, state: { keys, credentials: { gatewayToken: TOKEN, adminToken: 'test-admin-token' } } });
        });
        child = spawned;
        return spawned;
      }
    });
    detachCollisionWatch(); // started.child is the last spawned child
    child = started.child;
    // ports:bound is attested; /health confirms the listener answers, within the total budget.
    while (Date.now() < startBy && !gone(child)) {
      try { if (await health(started.port) === 200) { port = started.port; break; } } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(port !== undefined, 'gateway child must become healthy');
    const startedAt = Date.now();
    const answer = await post(port, '{"model":"fake/model","stream":false,"messages":[{"role":"user","content":"hi"}]}', 3_000);
    const elapsed = Date.now() - startedAt;
    assert.equal(answer.statusCode, 504);
    assert.equal(answer.body, '{"error":"Gateway request deadline exceeded"}');
    assert.ok(elapsed >= 700, `deadline fired too early: ${elapsed}ms`);
    assert.ok(elapsed < 1_400, `config deadline 800ms not applied by child: ${elapsed}ms`);
    assert.ok(pending.length >= 1, 'the request must have reached the fake upstream');
  } finally {
    await stopGateway(child);
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
