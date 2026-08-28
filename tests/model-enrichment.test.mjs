// @ts-check
/**
 * Tests for /v1/models response enrichment in src/gateway/server.mjs
 * `handleModelsRequest`.
 *
 * Verifies that every model entry returned by `GET /v1/models` carries:
 *   - the existing context_length / max_completion_tokens / max_tokens fields
 *     sourced from model-limits.mjs (no regression), AND
 *   - a new `capabilities` field sourced from the capability registry's
 *     getCapabilityMetadata(modelId) (reasoning modes, tools, vision, audio).
 *
 * The enrichment contract mirrors the example in the build spec:
 *   capabilities: { reasoning: {supported, modes, controlKey, defaultMode},
 *                    tools, vision, audio }
 *
 * Harness follows the project convention from tests/gateway-runtime.test.mjs:
 * a programmable fake local upstream (http.createServer) redirected via
 * tests/local-upstream-preload.cjs (https.request → local HTTP), with the real
 * gateway spawned as a child from source (src/gateway/server.mjs). No real
 * network and no real API keys are used.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localUpstreamPreloadPath = path.join(projectRoot, 'tests', 'local-upstream-preload.cjs');
const configExamplePath = path.join(projectRoot, 'config', 'config.example.json');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-model-enrichment-${process.pid}-`));
const TEST_GATEWAY_TOKEN = 'test-gateway-token-not-a-real-credential';

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// Test 1: /v1/models response includes `capabilities` with correct values for
// known families (z-ai, stepfun-ai, meta) plus an unknown family.
// ───────────────────────────────────────────────────────────────────────────
test('/v1/models enriches every model entry with capabilities from the capability registry', async () => {
  const upstreamBody = JSON.stringify({
    object: 'list',
    data: [
      { id: 'z-ai/glm-5.2', object: 'model', created: 735790403, owned_by: 'z-ai' },
      { id: 'stepfun-ai/step-3.7-flash', object: 'model', created: 735790404, owned_by: 'stepfun-ai' },
      { id: 'meta/llama-4-maverick-17b-128e-instruct', object: 'model', created: 735790405, owned_by: 'meta' },
      { id: 'totally-unknown/whatever-model', object: 'model', created: 735790406, owned_by: 'unknown' }
    ]
  });

  const harness = await startModelsGateway(upstreamBody);
  try {
    const result = await requestGateway(harness.gatewayPort, '/v1/models');
    assert.equal(result.statusCode, 200);
    const parsed = JSON.parse(result.body);
    assert.ok(Array.isArray(parsed.data), 'response must have a data array');
    assert.equal(parsed.data.length, 4);

    const byId = new Map(parsed.data.map((m) => [m.id, m]));

    // z-ai: full reasoning, 7 modes, reasoning_effort control, default high
    assert.deepEqual(byId.get('z-ai/glm-5.2').capabilities, {
      reasoning: {
        supported: true,
        modes: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        controlKey: 'reasoning_effort',
        defaultMode: 'high'
      },
      tools: true,
      vision: false,
      audio: false
    });

    // stepfun-ai: boolean thinking control, default "on"
    assert.deepEqual(byId.get('stepfun-ai/step-3.7-flash').capabilities, {
      reasoning: {
        supported: true,
        modes: ['off', 'on'],
        controlKey: 'chat_template_kwargs.thinking',
        defaultMode: 'on'
      },
      tools: true,
      vision: false,
      audio: false
    });

    // meta: no reasoning, but vision enabled (Llama-4 Maverick)
    assert.deepEqual(byId.get('meta/llama-4-maverick-17b-128e-instruct').capabilities, {
      reasoning: {
        supported: false,
        modes: [],
        controlKey: null,
        defaultMode: null
      },
      tools: true,
      vision: true,
      audio: false
    });

    // unknown family: DEFAULT_FAMILY (no reasoning, tools enabled)
    assert.deepEqual(byId.get('totally-unknown/whatever-model').capabilities, {
      reasoning: {
        supported: false,
        modes: [],
        controlKey: null,
        defaultMode: null
      },
      tools: true,
      vision: false,
      audio: false
    });
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Test 2: existing context_length / max_completion_tokens / max_tokens
// enrichment still works (no regression).
// ───────────────────────────────────────────────────────────────────────────
test('/v1/models still stamps context_length, max_completion_tokens, max_tokens from model-limits (no regression)', async () => {
  const upstreamBody = JSON.stringify({
    object: 'list',
    data: [
      { id: 'z-ai/glm-5.2', object: 'model' },
      { id: 'meta/llama-4-maverick-17b-128e-instruct', object: 'model' },
      { id: 'some/unrecognized-model', object: 'model' }
    ]
  });

  const harness = await startModelsGateway(upstreamBody);
  try {
    const result = await requestGateway(harness.gatewayPort, '/v1/models');
    assert.equal(result.statusCode, 200);
    const parsed = JSON.parse(result.body);
    const byId = new Map(parsed.data.map((m) => [m.id, m]));

    // Exact-match limits from config.example.json
    const zai = byId.get('z-ai/glm-5.2');
    assert.equal(typeof zai.context_length, 'number');
    assert.equal(typeof zai.max_completion_tokens, 'number');
    assert.equal(zai.context_length, 202_752);
    assert.equal(zai.max_completion_tokens, 131_072);
    assert.equal(zai.max_tokens, zai.context_length);

    // meta exact-match
    const meta = byId.get('meta/llama-4-maverick-17b-128e-instruct');
    assert.equal(meta.context_length, 128_000);
    assert.equal(meta.max_completion_tokens, 4_096);
    assert.equal(meta.max_tokens, 128_000);

    // Unrecognized model → wildcard "*" fallback (131072 / 4096)
    const unknown = byId.get('some/unrecognized-model');
    assert.equal(unknown.context_length, 131_072);
    assert.equal(unknown.max_completion_tokens, 4_096);
    assert.equal(unknown.max_tokens, 131_072);

    // The response Content-Length must match the (re-serialized) body length,
    // and transfer-encoding must be stripped — the existing fix logic.
    assert.equal(result.headers['transfer-encoding'], undefined);
    assert.equal(Number(result.headers['content-length']), Buffer.byteLength(result.body));
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Test 3: a model with an unknown family gets DEFAULT_FAMILY capabilities
// (reasoning.supported === false, tools === true).
// ───────────────────────────────────────────────────────────────────────────
test('/v1/models unknown family resolves to DEFAULT_FAMILY (reasoning off, tools on)', async () => {
  const upstreamBody = JSON.stringify({
    object: 'list',
    data: [
      { id: 'acme-corp/never-heard-of-it', object: 'model' },
      // A model whose family is unknown AND which has no id still must not
      // break enrichment; getCapabilityMetadata(undefined) is DEFAULT_FAMILY.
      { object: 'model' }
    ]
  });

  const harness = await startModelsGateway(upstreamBody);
  try {
    const result = await requestGateway(harness.gatewayPort, '/v1/models');
    assert.equal(result.statusCode, 200);
    const parsed = JSON.parse(result.body);

    const acme = parsed.data.find((m) => m.id === 'acme-corp/never-heard-of-it');
    assert.ok(acme, 'family-unknown model must be present');
    assert.equal(acme.capabilities.reasoning.supported, false);
    assert.equal(acme.capabilities.tools, true);
    assert.deepEqual(acme.capabilities.reasoning.modes, []);
    assert.equal(acme.capabilities.reasoning.controlKey, null);
    assert.equal(acme.capabilities.reasoning.defaultMode, null);

    // The id-less model: getCapabilityMetadata(undefined) → DEFAULT_FAMILY.
    const idLess = parsed.data.find((m) => !('id' in m));
    assert.ok(idLess, 'id-less model must still be enriched, not dropped');
    assert.equal(idLess.capabilities.reasoning.supported, false);
    assert.equal(idLess.capabilities.tools, true);
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Test 4: the capabilities field is JSON-serializable (no undefined, no
// functions, no circular refs) across reasoning-capable and non-reasoning
// families, and across an unknown family.
// ───────────────────────────────────────────────────────────────────────────
test('/v1/models capabilities are fully JSON-serializable (no undefined / functions / circular refs)', async () => {
  const upstreamBody = JSON.stringify({
    object: 'list',
    data: [
      { id: 'z-ai/glm-5.2', object: 'model' },
      { id: 'stepfun-ai/step-3.7-flash', object: 'model' },
      { id: 'meta/llama-4-maverick-17b-128e-instruct', object: 'model' },
      { id: 'mystery-vendor/odd-model', object: 'model' }
    ]
  });

  const harness = await startModelsGateway(upstreamBody);
  try {
    const result = await requestGateway(harness.gatewayPort, '/v1/models');
    assert.equal(result.statusCode, 200);

    // 1) The whole wire response re-serializes losslessly (catches circular
    //    refs / functions / non-serializable values anywhere in the payload).
    const parsed = JSON.parse(result.body);
    const roundTrip = JSON.parse(JSON.stringify(parsed));
    assert.deepEqual(roundTrip, parsed, 'full /v1/models body must round-trip through JSON losslessly');

    for (const model of parsed.data) {
      const cap = model.capabilities;
      assert.ok(cap && typeof cap === 'object', `${model.id}: capabilities must be an object`);
      assert.ok(!Array.isArray(cap), `${model.id}: capabilities must not be an array`);

      // 2) No function-typed values anywhere in the capabilities object.
      assertNoFunctions(cap, `${model.id}.capabilities`);

      // 3) Nullable fields must be null (never undefined) so JSON serializes
      //    them losslessly — verified by a lossless single-object round-trip.
      const capRound = JSON.parse(JSON.stringify(cap));
      assert.deepEqual(capRound, cap, `${model.id}: capabilities must round-trip losslessly`);
      assert.notEqual(cap.reasoning.controlKey, undefined, `${model.id}: controlKey must never be undefined`);
      assert.notEqual(cap.reasoning.defaultMode, undefined, `${model.id}: defaultMode must never be undefined`);

      // 4) Enumerate primitive-type invariants.
      assert.equal(typeof cap.reasoning.supported, 'boolean');
      assert.ok(Array.isArray(cap.reasoning.modes));
      for (const mode of cap.reasoning.modes) {
        assert.equal(typeof mode, 'string', `${model.id}: all reasoning modes must be strings`);
      }
      assert.ok(
        cap.reasoning.controlKey === null || typeof cap.reasoning.controlKey === 'string',
        `${model.id}: controlKey must be string | null`
      );
      assert.ok(
        cap.reasoning.defaultMode === null || typeof cap.reasoning.defaultMode === 'string',
        `${model.id}: defaultMode must be string | null`
      );
      assert.equal(typeof cap.tools, 'boolean');
      assert.equal(typeof cap.vision, 'boolean');
      assert.equal(typeof cap.audio, 'boolean');
    }

    // Explicitly: a non-reasoning family uses null (not undefined) for the
    // nullable reasoning knobs, so JSON output is lossless and explicit.
    const metaCap = parsed.data.find((m) => m.id === 'meta/llama-4-maverick-17b-128e-instruct').capabilities;
    assert.equal(metaCap.reasoning.controlKey, null);
    assert.equal(metaCap.reasoning.defaultMode, null);

    const unknownCap = parsed.data.find((m) => m.id === 'mystery-vendor/odd-model').capabilities;
    assert.equal(unknownCap.reasoning.controlKey, null);
    assert.equal(unknownCap.reasoning.defaultMode, null);

    // Raw wire body must not contain the token "undefined" or "function" as a
    // serialized value (a belt-and-braces guard against undefined leaking).
    assert.equal(result.body.includes('undefined'), false, 'wire body must not serialize "undefined"');
    assert.equal(result.body.includes('function'), false, 'wire body must not serialize "function"');
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Test 5 (robustness — build spec constraint #4): a malformed (non-object)
// model entry does not crash the whole /v1/models response; valid entries
// are still enriched with limits AND capabilities.
// ───────────────────────────────────────────────────────────────────────────
test('/v1/models skips a malformed (null / non-object) entry without crashing the whole response', async () => {
  // Mix of a valid object, a null entry, a primitive string entry, and a
  // valid object. Without the per-entry object guard, the null entry would
  // throw inside forEach and the catch branch would return the RAW body,
  // removing enrichment from the valid entries as well.
  const upstreamBody = JSON.stringify({
    object: 'list',
    data: [
      { id: 'z-ai/glm-5.2', object: 'model' },
      null,
      'not-an-object-either',
      { id: 'stepfun-ai/step-3.7-flash', object: 'model' }
    ]
  });

  const harness = await startModelsGateway(upstreamBody);
  try {
    const result = await requestGateway(harness.gatewayPort, '/v1/models');
    assert.equal(result.statusCode, 200);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.data.length, 4, 'all four entries must be returned as-is');

    // Valid entries MUST be enriched despite the malformed siblings.
    const zai = parsed.data[0];
    assert.equal(zai.context_length, 202_752);
    assert.equal(zai.max_completion_tokens, 131_072);
    assert.equal(zai.capabilities.reasoning.supported, true);
    assert.equal(zai.capabilities.reasoning.controlKey, 'reasoning_effort');
    assert.equal(zai.capabilities.tools, true);

    const step = parsed.data[3];
    assert.equal(step.context_length, 256_000);
    assert.equal(step.max_completion_tokens, 16_384);
    assert.equal(step.capabilities.reasoning.supported, true);
    assert.equal(step.capabilities.reasoning.controlKey, 'chat_template_kwargs.thinking');
    assert.equal(step.capabilities.tools, true);

    // The malformed entries pass through untouched (no crash, no enrichment).
    assert.equal(parsed.data[1], null);
    assert.equal(parsed.data[2], 'not-an-object-either');
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Harness helpers — mirror tests/gateway-runtime.test.mjs conventions.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Helper: assert that no value reachable from `value` is a function.
 * @param {unknown} value
 * @param {string} label
 */
function assertNoFunctions(value, label) {
  if (typeof value === 'function') {
    assert.fail(`${label} contains a function value`);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoFunctions(value[i], `${label}[${i}]`);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      assertNoFunctions(value[key], `${label}.${key}`);
    }
  }
}

/**
 * Spin up a fake upstream that responds to GET /v1/models with `upstreamBody`,
 * plus a real gateway child process pointed at it. Returns the gateway port
 * and a `close()` that tears both down.
 *
 * @param {string} upstreamBody — raw JSON the fake upstream returns for /v1/models
 * @returns {Promise<{ gatewayPort: number, upstreamSaw: string[], close: () => Promise<void> }>}
 */
async function startModelsGateway(upstreamBody) {
  /** @type {string[]} */
  const upstreamSaw = [];
  const upstream = await createLocalUpstream((req, res) => {
    upstreamSaw.push(`${req.method} ${req.url}`);
    if (req.url === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'identity',
        'transfer-encoding': 'chunked'
      });
      res.end(upstreamBody);
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });

  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port);
  return {
    gatewayPort,
    get upstreamSaw() { return upstreamSaw; },
    close: async () => {
      await stopGateway(child);
      await closeServer(upstream);
    }
  };
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((conn) => { conn.resume(); });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

async function freeGatewayPort() {
  const probe = await listen(0);
  const port = probe.address().port;
  await close(probe);
  if (port >= 65534) return freeGatewayPort();
  const adminProbe = await listen(port + 1).catch(() => null);
  if (!adminProbe) return freeGatewayPort();
  await close(adminProbe);
  return port;
}

function getHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/health' }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.setTimeout(2_000, () => request.destroy(new Error('Health request timed out.')));
  });
}

function requestGateway(port, requestPath, method = 'GET', body = '', headers = {}, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { authorization: `Bearer ${TEST_GATEWAY_TOKEN}`, ...headers };
    if (body) {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['content-length'] = Buffer.byteLength(body);
    }
    const request = http.request({
      host: '127.0.0.1', port, path: requestPath, method, headers: requestHeaders
    }, (response) => {
      const chunks = [];
      const deadline = setTimeout(() => response.destroy(new Error('Gateway request timed out.')), timeoutMs);
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        clearTimeout(deadline);
        resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() });
      });
      response.once('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

function createLocalUpstream(handler) {
  return new Promise((resolve, reject) => {
    const upstream = http.createServer(handler);
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', () => resolve(upstream));
  });
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function startGatewayWithLocalUpstream(upstreamPort) {
  let gatewayPort;
  let child;
  for (let startAttempt = 0; startAttempt < 3; startAttempt++) {
    gatewayPort = await freeGatewayPort();
    const gatewayDir = path.join(tempRoot, `gateway-${gatewayPort}`);
    const statePath = path.join(gatewayDir, 'keys.json');
    const logPath = path.join(gatewayDir, 'gateway.jsonl');
    fs.mkdirSync(gatewayDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      keys: [{
        id: 'test-key',
        key: 'local-test-key-notreal',
        status: 'active',
        backoffUntil: 0,
        usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }
      }]
    }));

    child = spawn(process.execPath, [
      '--require', localUpstreamPreloadPath,
      path.join(projectRoot, 'src', 'gateway', 'server.mjs')
    ], {
      env: {
        ...process.env,
        PORT: String(gatewayPort),
        GATEWAY_LOG_PATH: logPath,
        GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstreamPort),
        // Pin deterministic limits from the example config so the limit
        // regression assertions use stable, known numbers.
        GATEWAY_CONFIG_PATH: configExamplePath,
        // Make upstream socket timeouts generous enough that a slow CI box
        // never trips them during the /v1/models round-trip.
        GATEWAY_FIRST_BYTE_TIMEOUT_MS: '300000',
        GATEWAY_IDLE_TIMEOUT_MS: '300000'
      },
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
            credentials: { gatewayToken: TEST_GATEWAY_TOKEN, adminToken: 'test-admin-token-notreal' }
          }
        });
      }
    });
    child.on('message', (message) => {
      if (message?.type === 'state:persist') fs.writeFileSync(statePath, JSON.stringify(message.state));
    });

    const deadline = Date.now() + 20_000;
    let ready = false;
    try {
      while (Date.now() < deadline) {
        try {
          if (await getHealth(gatewayPort) === 200) { ready = true; break; }
        } catch {
          // child may still be starting
        }
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (ready) return { child, gatewayPort, logPath, statePath };
      await stopGateway(child);
    } catch (err) {
      await stopGateway(child);
      throw err;
    }
  }
  throw new Error('Gateway did not become healthy after three free-port selections.');
}

async function stopGateway(child) {
  if (!child) return;
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill();
  });
}
