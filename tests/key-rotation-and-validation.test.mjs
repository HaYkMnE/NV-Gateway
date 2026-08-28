import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const fileTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-rot-val-${process.pid}-`));
test.after(() => fs.rmSync(fileTempRoot, { recursive: true, force: true }));

test('Task 1: resolveMaxFailoverAttempts dynamically covers active pool count when env is unset', async () => {
  const policy = await import(pathToFileURL(path.join(root, 'src/gateway/failover-policy.mjs')).href);
  // When poolCount is provided and env is unset, it should cover all active keys (at least poolCount, min 3)
  assert.equal(policy.resolveMaxFailoverAttempts({}, 5), 5);
  assert.equal(policy.resolveMaxFailoverAttempts({}, 10), 10);
  assert.equal(policy.resolveMaxFailoverAttempts({}, 1), 3);
  assert.equal(policy.resolveMaxFailoverAttempts({}, 0), 3);
  assert.equal(policy.resolveMaxFailoverAttempts({}), 3);

  // When explicit operator override is set (1..8), respect it
  assert.equal(policy.resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '4' }, 10), 4);
  assert.equal(policy.resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '8' }, 5), 8);
  assert.equal(policy.resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '2' }, 5), 2);

  // Invalid env falls back to dynamic poolCount (or 3)
  assert.equal(policy.resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: 'invalid' }, 5), 5);
  assert.equal(policy.resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '99' }, 5), 5);
  assert.equal(policy.resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: 'invalid' }, 0), 3);
});

test('Task 1: Full pool key failover succeeds on 5th key across 5 active keys without env override', async () => {
  // Exercises the FAILOVER MECHANISM over a full pool with pool-derived attempts
  // (no GATEWAY_MAX_FAILOVER_ATTEMPTS): four keys fail, the fifth succeeds.
  // Uses 503 rather than 429 deliberately. A 503 is a per-key/transient upstream
  // fault, so another key genuinely can succeed — which is what this test asserts.
  // A 429, by contrast, is MODEL-scoped upstream (all keys answer 429 for the same
  // model in the same second), so it now stops after a small number of confirming
  // attempts instead of walking the pool; that rule has its own tests in
  // p0-backend.test.mjs and would make the "succeeds on the 5th key" premise false.
  const harness = await startGatewayHarnessNoOverride({
    keys: ['key-0', 'key-1', 'key-2', 'key-3', 'key-4'],
    responses: [
      { status: 503, headers: { 'content-type': 'application/json' }, body: '{"error":"Service unavailable"}' },
      { status: 503, headers: { 'content-type': 'application/json' }, body: '{"error":"Service unavailable"}' },
      { status: 503, headers: { 'content-type': 'application/json' }, body: '{"error":"Service unavailable"}' },
      { status: 503, headers: { 'content-type': 'application/json' }, body: '{"error":"Service unavailable"}' },
      { status: 200, headers: { 'content-type': 'application/json' }, body: '{"choices":[{"message":{"content":"success"}}]}' }
    ]
  });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"messages":[{"role":"user","content":"hi"}]}');
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), { choices: [{ message: { content: 'success' } }] });
    assert.deepEqual(harness.seenAuthorizations, [
      'Bearer key-0',
      'Bearer key-1',
      'Bearer key-2',
      'Bearer key-3',
      'Bearer key-4'
    ]);
  } finally {
    await harness.close();
  }
});

test('Task 1: Streaming first-frame SSE error triggers transparent key failover to next key', async () => {
  const sseChunk = 'data: {"id":"chatcmpl-123","choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n';
  const harness = await startGatewayHarnessNoOverride({
    keys: ['key-bad', 'key-good'],
    responses: [
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: {"code":500,"type":"internal_server_error"}\n\n'
      },
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseChunk
      }
    ]
  });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', '{"stream":true,"messages":[{"role":"user","content":"hi"}]}');
    assert.equal(result.statusCode, 200);
    assert.equal(result.body, sseChunk);
    assert.deepEqual(harness.seenAuthorizations, ['Bearer key-bad', 'Bearer key-good']);
  } finally {
    await harness.close();
  }
});

test('Task 2: Key validation classifies 2xx from /v1/models as valid and exposes accessible models', async () => {
  const validation = await import(`${pathToFileURL(path.join(root, 'src/gateway/validation.mjs')).href}?t=${Date.now()}`);
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headers = { 'content-type': 'application/json' };
  response.destroy = () => {};
  const resultPromise = validation.collectValidationResponse(response, 4096);
  response.emit('data', Buffer.from('{"object":"list","data":[{"id":"z-ai/glm-5.2"},{"id":"nvidia/llama-3.1-nemotron-70b-instruct"}]}'));
  response.emit('end');
  const result = await resultPromise;
  assert.deepEqual(result, {
    valid: true,
    accessibleModels: ['z-ai/glm-5.2', 'nvidia/llama-3.1-nemotron-70b-instruct'],
    accessibleModelCount: 2
  });
});

test('Task 2: Key validation reports valid:true with empty accessibleModels when /v1/models returns 200 with no data array', async () => {
  const validation = await import(`${pathToFileURL(path.join(root, 'src/gateway/validation.mjs')).href}?t=${Date.now()}`);
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headers = { 'content-type': 'application/json' };
  response.destroy = () => {};
  const resultPromise = validation.collectValidationResponse(response, 4096);
  response.emit('data', Buffer.from('{"id":"chatcmpl-123"}'));
  response.emit('end');
  const result = await resultPromise;
  assert.deepEqual(result, { valid: true, accessibleModels: [], accessibleModelCount: 0 });
});

test('Task 2: Key validation reports valid:true with empty accessibleModels when /v1/models returns 200 with an unparseable body', async () => {
  const validation = await import(`${pathToFileURL(path.join(root, 'src/gateway/validation.mjs')).href}?t=${Date.now()}`);
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headers = { 'content-type': 'application/json' };
  response.destroy = () => {};
  const resultPromise = validation.collectValidationResponse(response, 4096);
  response.emit('data', Buffer.from('not-json'));
  response.emit('end');
  const result = await resultPromise;
  assert.deepEqual(result, { valid: true, accessibleModels: [], accessibleModelCount: 0 });
});

test('Task 2: Key validation classifies 401 as unauthorized and 403 as rejected', async () => {
  const validation = await import(`${pathToFileURL(path.join(root, 'src/gateway/validation.mjs')).href}?t=${Date.now()}`);

  // 401
  const res401 = new EventEmitter();
  res401.statusCode = 401;
  res401.headers = { 'content-type': 'application/json' };
  res401.destroy = () => {};
  const promise401 = validation.collectValidationResponse(res401, 4096);
  res401.emit('data', Buffer.from('{"error":{"message":"Invalid API key"}}'));
  res401.emit('end');
  const result401 = await promise401;
  assert.deepEqual(result401, {
    valid: false,
    statusCode: 401,
    reason: 'unauthorized',
    error: 'Validation request was rejected.'
  });

  // 403
  const res403 = new EventEmitter();
  res403.statusCode = 403;
  res403.headers = { 'content-type': 'application/json' };
  res403.destroy = () => {};
  const promise403 = validation.collectValidationResponse(res403, 4096);
  res403.emit('data', Buffer.from('{"error":{"message":"Forbidden"}}'));
  res403.emit('end');
  const result403 = await promise403;
  assert.deepEqual(result403, {
    valid: false,
    statusCode: 403,
    reason: 'rejected',
    error: 'Validation request was rejected.'
  });
});

test('Task 2: Key validation classifies 429 as valid but rate-limited', async () => {
  const validation = await import(`${pathToFileURL(path.join(root, 'src/gateway/validation.mjs')).href}?t=${Date.now()}`);
  const response = new EventEmitter();
  response.statusCode = 429;
  response.headers = { 'content-type': 'application/json', 'retry-after': '30' };
  response.destroy = () => {};
  const resultPromise = validation.collectValidationResponse(response, 4096);
  response.emit('data', Buffer.from('{"error":{"message":"Rate limit exceeded"}}'));
  response.emit('end');
  const result = await resultPromise;
  assert.deepEqual(result, {
    valid: true,
    rateLimited: true,
    statusCode: 429,
    reason: 'rate_limited'
  });
});

test('Task 2: Key validation classifies 5xx and network errors as upstream_error with valid: null', async () => {
  const validation = await import(`${pathToFileURL(path.join(root, 'src/gateway/validation.mjs')).href}?t=${Date.now()}`);

  // 500
  const res500 = new EventEmitter();
  res500.statusCode = 500;
  res500.headers = { 'content-type': 'application/json' };
  res500.destroy = () => {};
  const promise500 = validation.collectValidationResponse(res500, 4096);
  res500.emit('data', Buffer.from('{"error":"Internal Server Error"}'));
  res500.emit('end');
  const result500 = await promise500;
  assert.deepEqual(result500, {
    valid: null,
    statusCode: 500,
    reason: 'upstream_error',
    error: 'Validation request failed.'
  });

  // 503
  const res503 = new EventEmitter();
  res503.statusCode = 503;
  res503.headers = { 'content-type': 'application/json' };
  res503.destroy = () => {};
  const promise503 = validation.collectValidationResponse(res503, 4096);
  res503.emit('data', Buffer.from('Service Unavailable'));
  res503.emit('end');
  const result503 = await promise503;
  assert.deepEqual(result503, {
    valid: null,
    statusCode: 503,
    reason: 'upstream_error',
    error: 'Validation request failed.'
  });

  // Network transport error on response
  const resErr = new EventEmitter();
  resErr.destroy = () => {};
  const promiseErr = validation.collectValidationResponse(resErr, 4096);
  resErr.emit('error', new Error('ECONNRESET'));
  const resultErr = await promiseErr;
  assert.deepEqual(resultErr, {
    valid: null,
    reason: 'upstream_error',
    error: 'Validation request failed.'
  });

  // Aborted response
  const resAbort = new EventEmitter();
  resAbort.destroy = () => {};
  const promiseAbort = validation.collectValidationResponse(resAbort, 4096);
  resAbort.emit('aborted');
  const resultAbort = await promiseAbort;
  assert.deepEqual(resultAbort, {
    valid: null,
    reason: 'upstream_error',
    error: 'Response aborted.'
  });
});

test('Task 2: validateKey routes to GET /v1/models and classifies 200 as valid even when the legacy chat-completion test model would 403', async () => {
  // Regression for the real incident: a key valid for its own catalog was marked
  // "rejected" because validation used to call a hardcoded chat-completion model
  // (meta/llama3-8b-instruct). The fake upstream 403s that legacy path to prove we
  // never call it any more, and that a catalog-valid key is no longer misclassified.
  const harness = await startValidationFakeUpstream({
    modelsStatus: 200,
    modelsBody: JSON.stringify({ object: 'list', data: [
      { id: 'z-ai/glm-5.2' },
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct' }
    ] }),
    chatStatus: 403,
    chatBody: '{"error":{"message":"model not accessible"}}'
  });
  try {
    const result = await harness.validate('nvapi-fake-test-key-notreal');
    assert.deepEqual(harness.requestedPaths, ['/v1/models']);
    assert.deepEqual(harness.requestedMethods, ['GET']);
    assert.equal(harness.touchedChatCompletions, false);
    assert.deepEqual(result, {
      valid: true,
      accessibleModels: ['z-ai/glm-5.2', 'nvidia/llama-3.1-nemotron-70b-instruct'],
      accessibleModelCount: 2
    });
  } finally {
    await harness.close();
  }
});

test('Task 2: validateKey reports valid:true with empty accessibleModels when /v1/models returns 200 with no accessible models', async () => {
  const harness = await startValidationFakeUpstream({ modelsStatus: 200, modelsBody: '{"object":"list","data":[]}' });
  try {
    const result = await harness.validate('nvapi-fake-test-key-notreal');
    assert.deepEqual(harness.requestedPaths, ['/v1/models']);
    assert.deepEqual(result, { valid: true, accessibleModels: [], accessibleModelCount: 0 });
  } finally {
    await harness.close();
  }
});

test('Task 2: validateKey classifies 401 on /v1/models as unauthorized', async () => {
  const harness = await startValidationFakeUpstream({ modelsStatus: 401, modelsBody: '{"error":{"message":"invalid key"}}' });
  try {
    const result = await harness.validate('nvapi-fake-test-key-notreal');
    assert.deepEqual(harness.requestedPaths, ['/v1/models']);
    assert.deepEqual(result, {
      valid: false,
      statusCode: 401,
      reason: 'unauthorized',
      error: 'Validation request was rejected.'
    });
  } finally {
    await harness.close();
  }
});

test('Task 2: validateKey classifies 403 on /v1/models as rejected', async () => {
  const harness = await startValidationFakeUpstream({ modelsStatus: 403, modelsBody: '{"error":{"message":"forbidden"}}' });
  try {
    const result = await harness.validate('nvapi-fake-test-key-notreal');
    assert.deepEqual(harness.requestedPaths, ['/v1/models']);
    assert.deepEqual(result, {
      valid: false,
      statusCode: 403,
      reason: 'rejected',
      error: 'Validation request was rejected.'
    });
  } finally {
    await harness.close();
  }
});

test('Task 2: validateKey classifies 429 on /v1/models as valid but rate-limited', async () => {
  const harness = await startValidationFakeUpstream({ modelsStatus: 429, modelsBody: '{"error":{"message":"rate limited"}}' });
  try {
    const result = await harness.validate('nvapi-fake-test-key-notreal');
    assert.deepEqual(harness.requestedPaths, ['/v1/models']);
    assert.deepEqual(result, {
      valid: true,
      rateLimited: true,
      statusCode: 429,
      reason: 'rate_limited'
    });
  } finally {
    await harness.close();
  }
});

test('Task 2: validateKey classifies 5xx and connection failures on /v1/models as upstream_error with valid:null', async () => {
  // 5xx response
  const harness500 = await startValidationFakeUpstream({ modelsStatus: 503, modelsBody: '{"error":"upstream"}' });
  try {
    const result500 = await harness500.validate('nvapi-fake-test-key-notreal');
    assert.deepEqual(harness500.requestedPaths, ['/v1/models']);
    assert.deepEqual(result500, {
      valid: null,
      statusCode: 503,
      reason: 'upstream_error',
      error: 'Validation request failed.'
    });
  } finally {
    await harness500.close();
  }

  // Connection reset by the upstream server before any response
  const harnessNetwork = await startValidationFakeUpstream({ networkError: true });
  try {
    const resultNetwork = await harnessNetwork.validate('nvapi-fake-test-key-notreal');
    assert.deepEqual(harnessNetwork.requestedPaths, ['/v1/models']);
    assert.deepEqual(resultNetwork, {
      valid: null,
      reason: 'upstream_error',
      error: 'Validation request failed.'
    });
  } finally {
    await harnessNetwork.close();
  }
});

// Programmable fake upstream for validateKey end-to-end tests. Redirects
// https.request (which validation.mjs uses) at a local HTTP server, so there is
// no real network and no real keys. Mirrors tests/local-upstream-preload.cjs but
// scoped to the in-process https singleton (mutated/restored per test).
async function startValidationFakeUpstream({ modelsStatus = 200, modelsBody = '{}', chatStatus = 403, chatBody = '{"error":"forbidden"}', networkError = false } = {}) {
  const requestedPaths = [];
  const requestedMethods = [];
  let touchedChatCompletions = false;

  const server = http.createServer((req, res) => {
    requestedPaths.push(req.url);
    requestedMethods.push(req.method);
    if (req.url === '/v1/models' && req.method === 'GET') {
      if (networkError) { req.socket.destroy(); return; }
      res.writeHead(modelsStatus, { 'content-type': 'application/json' });
      res.end(modelsBody);
    } else if (req.url === '/v1/chat/completions') {
      touchedChatCompletions = true;
      res.writeHead(chatStatus, { 'content-type': 'application/json' });
      res.end(chatBody);
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const originalRequest = https.request;
  https.request = function patchedRequest(options, callback) {
    return http.request({
      ...options,
      hostname: '127.0.0.1',
      port,
      protocol: 'http:'
    }, callback);
  };

  const validation = await import(`${pathToFileURL(path.join(root, 'src/gateway/validation.mjs')).href}?fakeup=${port}&t=${Date.now()}`);

  return {
    requestedPaths,
    requestedMethods,
    get touchedChatCompletions() { return touchedChatCompletions; },
    validate: (key) => validation.validateKey(key),
    close: async () => {
      https.request = originalRequest;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function request(port, url, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: url,
      method,
      headers: {
        authorization: 'Bearer test-gateway-token',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startGatewayHarnessNoOverride({ keys, responses }) {
  const dir = fs.mkdtempSync(path.join(fileTempRoot, 'gateway-no-override-'));
  const statePath = path.join(dir, 'keys.json');
  const logPath = path.join(dir, 'gateway.jsonl');
  const seenAuthorizations = [];
  fs.writeFileSync(statePath, JSON.stringify({
    keys: keys.map((key, index) => ({
      id: `key-${index}`,
      key,
      status: 'active',
      backoffUntil: 0,
      usage: { success: 0, fail: 0, tokens: 0, lastUsed: index + 1 }
    }))
  }));

  const upstream = http.createServer((req, res) => {
    seenAuthorizations.push(req.headers.authorization);
    const response = responses.shift() ?? { status: 500 };
    res.writeHead(response.status, response.headers ?? { 'content-type': 'application/json' });
    if (response.abort) {
      res.write(response.body ?? 'x');
      setTimeout(() => res.socket.destroy(), 5);
      return;
    }
    res.end(response.body ?? '{}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  let port;
  let child;
  let ready = false;
  for (let startAttempt = 0; startAttempt < 3 && !ready; startAttempt++) {
    port = await freePortPair();
    const env = { ...process.env, GATEWAY_LOG_PATH: logPath, GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstream.address().port), PORT: String(port) };
    delete env.GATEWAY_MAX_FAILOVER_ATTEMPTS;

    child = spawn(process.execPath, ['--require', path.join(root, 'tests/local-upstream-preload.cjs'), path.join(root, 'src/gateway/server.mjs')], {
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true
    });

    child.once('message', (message) => {
      if (message?.type === 'ready') {
        child.send({
          type: 'state:init',
          challenge: message.challenge,
          state: {
            keys: JSON.parse(fs.readFileSync(statePath, 'utf8')).keys,
            credentials: { gatewayToken: 'test-gateway-token', adminToken: 'test-admin-token' }
          }
        });
      }
    });

    child.on('message', (message) => {
      if (message?.type === 'state:persist') {
        fs.writeFileSync(statePath, JSON.stringify(message.state));
      }
    });

    const readinessDeadline = Date.now() + 20_000;
    while (Date.now() < readinessDeadline) {
      try {
        if ((await request(port, '/health')).statusCode === 200) {
          ready = true;
          break;
        }
      } catch {}
      if (child.exitCode !== null) break;
      await delay(25);
    }
    if (!ready) await stopChild(child);
  }

  if (!ready) {
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Gateway did not become healthy on port ${port}.`);
  }

  return {
    port,
    statePath,
    logPath,
    seenAuthorizations,
    close: async () => {
      await stopChild(child);
      upstream.closeAllConnections?.();
      await new Promise((resolve) => upstream.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 1_000);
    child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    child.kill();
  });
}

async function freePortPair() {
  while (true) {
    const first = http.createServer();
    await new Promise((resolve) => first.listen(0, '127.0.0.1', resolve));
    const port = first.address().port;
    await new Promise((resolve) => first.close(resolve));
    if (port >= 65534) continue;
    const second = http.createServer();
    try {
      await new Promise((resolve, reject) => {
        second.once('error', reject);
        second.listen(port + 1, '127.0.0.1', resolve);
      });
    } catch {
      continue;
    }
    await new Promise((resolve) => second.close(resolve));
    return port;
  }
}
