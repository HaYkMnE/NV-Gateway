import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const fileTempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-permodel-${process.pid}-`)));
test.after(() => fs.rmSync(fileTempRoot, { recursive: true, force: true }));

// ───────────────────────────────────────────────────────────────────────────
// Per-model key routing, end to end.
//
// NVIDIA rate limits are enforced on BOTH axes: ~40 RPM per key/account AND a
// per-model limit (popular models see model-wide 429 waves). The gateway must
// therefore treat a 429 as a verdict about the (model, key) PAIR, not about the
// key alone, and must keep concurrently-used models on separate keys so they do
// not burn one key's per-minute budget together.
// ───────────────────────────────────────────────────────────────────────────

test('a 429 for one model does NOT remove that key from a different model', async () => {
  // key-0 is rate-limited for modelA and healthy for modelB in the SAME window.
  // modelB is pinned to key-0 first (so stickiness, not spread, decides its key),
  // then modelA burns every key with 429s. modelB must still be served by key-0.
  //
  // Pre-fix this FAILS: handleKeyError puts a GLOBAL backoffUntil on the key, so
  // modelA's 429 evicts key-0 for modelB too.
  const harness = await startPerModelHarness({
    keys: ['key-0', 'key-1'],
    maxFailoverAttempts: 2,
    respond: ({ model, apiKey }) => {
      if (model === 'modelA') return { status: 429, body: '{"error":"rate limit"}' };
      if (apiKey === 'key-0') return { status: 200, body: '{"served_by":"key-0"}' };
      return { status: 429, body: '{"error":"rate limit"}' };
    }
  });
  try {
    // 1. modelB establishes affinity on key-0.
    const warm = await chat(harness.port, 'modelB');
    assert.equal(warm.statusCode, 200, 'modelB must be served before the interference');
    assert.equal(JSON.parse(warm.body).served_by, 'key-0');

    // 2. modelA is uniformly rate-limited and cools every key it touches.
    const limited = await chat(harness.port, 'modelA');
    assert.equal(limited.statusCode, 429, 'modelA is genuinely rate-limited');

    // 3. THE ASSERTION: key-0 is untouched for modelB and serves it immediately.
    harness.calls.length = 0;
    const after = await chat(harness.port, 'modelB');
    assert.equal(after.statusCode, 200,
      'modelB must still succeed: a 429 seen by modelA says nothing about modelB');
    assert.equal(JSON.parse(after.body).served_by, 'key-0');
    assert.deepEqual(harness.calls.map((c) => c.apiKey), ['key-0'],
      'modelB must reach key-0 on the FIRST attempt, with no wasted probe of a cooling key');
  } finally {
    await harness.close();
  }
});

test('three models requested together are served by three DIFFERENT keys', async () => {
  // Global LRU alone cannot prove per-model routing: a single round of 3 requests
  // rotates 3 keys by accident. Each model is therefore asked TWICE. Under global
  // LRU the second round hands every model a rotated (shared) key; under per-model
  // routing each model returns to its OWN key.
  const harness = await startPerModelHarness({
    keys: ['key-0', 'key-1', 'key-2'],
    maxFailoverAttempts: 3,
    respond: ({ apiKey }) => ({ status: 200, body: JSON.stringify({ served_by: apiKey }) })
  });
  try {
    const models = ['deepseek-ai/deepseek-v3', 'moonshotai/kimi-k2', 'minimaxai/minimax-m2'];
    for (const model of models) {
      assert.equal((await chat(harness.port, model)).statusCode, 200);
    }

    harness.calls.length = 0;
    const servedBy = {};
    for (const model of models) {
      const result = await chat(harness.port, model);
      assert.equal(result.statusCode, 200);
      servedBy[model] = JSON.parse(result.body).served_by;
    }

    const used = Object.values(servedBy);
    assert.equal(new Set(used).size, 3,
      `3 concurrently active models must sit on 3 distinct keys, got ${JSON.stringify(servedBy)}`);
    // And each model must be back on the key it used in the warm-up round.
    for (const call of harness.calls) {
      assert.equal(call.apiKey, servedBy[call.model],
        `${call.model} must be sticky on its own key`);
    }
  } finally {
    await harness.close();
  }
});

test('a model stays on its own key across repeated back-to-back requests', async () => {
  // Global LRU rotates on every call, so two consecutive requests for ONE model
  // land on two different keys and split its 40 RPM budget across the pool.
  const harness = await startPerModelHarness({
    keys: ['key-0', 'key-1', 'key-2'],
    maxFailoverAttempts: 3,
    respond: ({ apiKey }) => ({ status: 200, body: JSON.stringify({ served_by: apiKey }) })
  });
  try {
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const result = await chat(harness.port, 'solo-model');
      assert.equal(result.statusCode, 200);
      seen.push(JSON.parse(result.body).served_by);
    }
    assert.equal(new Set(seen).size, 1,
      `one model must reuse ONE key across consecutive requests, got ${JSON.stringify(seen)}`);
  } finally {
    await harness.close();
  }
});

test('a model-wide 429 wave still short-circuits with an honest 429 and does not burn the pool', async () => {
  // The uniform-429 early stop must survive per-model routing: when EVERY key
  // answers 429 for this model, the client gets the honest 429 after a small
  // number of confirming attempts, not a walk of the whole pool.
  const harness = await startPerModelHarness({
    keys: ['key-0', 'key-1', 'key-2', 'key-3', 'key-4'],
    maxFailoverAttempts: 5,
    respond: () => ({ status: 429, body: '{"error":"rate limit"}' })
  });
  try {
    const result = await chat(harness.port, 'flooded-model');
    assert.equal(result.statusCode, 429, 'an honest 429 is returned');
    assert.ok(Number(result.headers['retry-after']) >= 1, 'our own Retry-After is supplied');
    assert.ok(harness.calls.length <= 3,
      `a model-wide 429 wave must stop early, got ${harness.calls.length} upstream calls`);
    assert.ok(harness.calls.length >= 2,
      'at least two independent keys must confirm the verdict');
    assert.equal(new Set(harness.calls.map((c) => c.apiKey)).size, harness.calls.length,
      'each confirming attempt must use a DISTINCT key');
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Harness: fake upstream that answers per (model, key), spawned real gateway.
// Mirrors startGatewayHarness in tests/key-rotation-and-validation.test.mjs.
// ───────────────────────────────────────────────────────────────────────────

async function startPerModelHarness({ keys, respond, maxFailoverAttempts }) {
  const dir = fs.mkdtempSync(path.join(fileTempRoot, 'gw-'));
  const logPath = path.join(dir, 'logs', 'gateway.jsonl');
  const calls = [];

  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let model;
      try { model = JSON.parse(raw)?.model; } catch { model = undefined; }
      const apiKey = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      calls.push({ model, apiKey });
      const answer = respond({ model, apiKey }) ?? { status: 500, body: '{}' };
      res.writeHead(answer.status, answer.headers ?? { 'content-type': 'application/json' });
      res.end(answer.body ?? '{}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const keyRecords = keys.map((key, index) => ({
    id: `0000000${index}-0000-4000-8000-00000000000${index}`,
    key,
    status: 'active',
    backoffUntil: 0,
    usage: { success: 0, fail: 0, tokens: 0, lastUsed: index + 1 }
  }));

  let port;
  let child;
  let ready = false;
  for (let startAttempt = 0; startAttempt < 3 && !ready; startAttempt++) {
    port = await freePort();
    const env = {
      ...process.env,
      GATEWAY_LOG_PATH: logPath,
      GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstream.address().port),
      PORT: String(port)
    };
    if (maxFailoverAttempts) env.GATEWAY_MAX_FAILOVER_ATTEMPTS = String(maxFailoverAttempts);
    else delete env.GATEWAY_MAX_FAILOVER_ATTEMPTS;

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
          state: { keys: keyRecords, credentials: { gatewayToken: 'test-gateway-token', adminToken: 'test-admin-token' } }
        });
      }
    });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        if ((await request(port, '/health')).statusCode === 200) { ready = true; break; }
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
    logPath,
    calls,
    close: async () => {
      await stopChild(child);
      upstream.closeAllConnections?.();
      await new Promise((resolve) => upstream.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function chat(port, model) {
  return request(port, '/v1/chat/completions', 'POST', JSON.stringify({
    model,
    stream: false,
    messages: [{ role: 'user', content: 'hi' }]
  }));
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
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 1_000);
    child.once('exit', () => { clearTimeout(force); resolve(); });
    child.kill();
  });
}

async function freePort() {
  while (true) {
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    if (port < 65534) return port;
  }
}
