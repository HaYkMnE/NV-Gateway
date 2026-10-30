/**
 * minimaxai/minimax-m3.1-flash: built-in limits, vision and reasoning control.
 *
 * Evidence (see the comments next to the entries in model-limits.mjs and
 * capability-registry.mjs): NVIDIA card context 262,144; live probes on
 * 2026-10-25 accepted max_tokens 65536, streamed 8068 completion tokens,
 * answered a red PNG correctly, and accepted reasoning_effort
 * low|medium|high|xhigh|max, while neither "none" nor thinking_mode
 * "disabled" turned reasoning off.
 *
 * House invariant under test: what /v1/models advertises is exactly what the
 * chat and Anthropic facades put on the wire.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { translateAnthropicRequest } from '../src/gateway/anthropic-adapter.mjs';
import { mergeProbedReasoning, resetCapabilityProbeState, resolveAdvertisedReasoning } from '../src/gateway/capability-probe.mjs';
import { getCapability, getCapabilityMetadata, registerFamilyPatterns, resetCapabilityRegistry } from '../src/gateway/capability-registry.mjs';
import { getModelLimits, resetModelLimitsCache } from '../src/gateway/model-limits.mjs';
import { applyReasoningDefaults, mapClientEffort, usesReasoningDefaults } from '../src/gateway/reasoning-defaults.mjs';
import { translateResponsesRequest } from '../src/gateway/responses-adapter.mjs';
import { startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';

const MODEL = 'minimaxai/minimax-m3.1-flash';
const FAMILY_SIBLING = 'minimaxai/minimax-m3';
const MODES = ['low', 'medium', 'high', 'xhigh', 'max'];

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localUpstreamPreloadPath = path.join(projectRoot, 'tests', 'local-upstream-preload.cjs');
const configExamplePath = path.join(projectRoot, 'config', 'config.example.json');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-minimax-m31-${process.pid}-`));
const TEST_GATEWAY_TOKEN = `test-gateway-${randomUUID()}`;
let fixtureSequence = 0;

const freshState = () => {
  resetCapabilityProbeState({ cachePath: null });
  resetCapabilityRegistry();
};

test.after(() => {
  freshState();
  resetModelLimitsCache();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// --- Static capability + limits ----------------------------------------------

test('M1. built-in limits: context 262144, output 65536 (beats the wildcard, loses to an exact user entry)', () => {
  resetModelLimitsCache();
  const saved = process.env.GATEWAY_CONFIG_PATH;
  try {
    process.env.GATEWAY_CONFIG_PATH = configExamplePath;
    resetModelLimitsCache();
    assert.deepEqual(getModelLimits(MODEL), { context: 262144, output: 65536 });

    const userConfig = path.join(tempRoot, 'user-config.json');
    fs.writeFileSync(userConfig, JSON.stringify({ modelLimits: { [MODEL]: { context: 1000, output: 100 }, '*': { context: 5, output: 5 } } }));
    process.env.GATEWAY_CONFIG_PATH = userConfig;
    resetModelLimitsCache();
    assert.deepEqual(getModelLimits(MODEL), { context: 1000, output: 100 }, 'explicit user choice still wins');
  } finally {
    if (saved === undefined) delete process.env.GATEWAY_CONFIG_PATH; else process.env.GATEWAY_CONFIG_PATH = saved;
    resetModelLimitsCache();
  }
});

test('M2. exact capability: vision on, reasoning_effort with the five card modes, no "off" mode', () => {
  freshState();
  const cap = getCapability(MODEL);
  assert.equal(cap.family, 'minimaxai');
  assert.equal(cap.vision, true);
  assert.equal(cap.tools, true);
  assert.equal(cap.audio, false);
  assert.deepEqual(getCapabilityMetadata(MODEL).reasoning, {
    supported: true, modes: MODES, controlKey: 'reasoning_effort', defaultMode: 'high'
  });
  for (const off of ['none', 'disabled', 'off']) assert.equal(cap.reasoning.modes.includes(off), false, off);
  assert.equal(getCapability('MiniMaxAI/MiniMax-M3.1-Flash').vision, true, 'lookup is case-insensitive');

  // A family-level config override cannot rename this model's control.
  registerFamilyPatterns({ minimaxai: { reasoning: { defaultMode: 'disabled' } } });
  assert.equal(getCapability(MODEL).reasoning.controlKey, 'reasoning_effort');
  resetCapabilityRegistry();
  assert.equal(getCapability(MODEL).reasoning.controlKey, 'reasoning_effort', 'built-in override survives reset');
});

test('M3. no regression: other minimax ids keep the family thinking_mode row and the 4096 fallback is untouched', () => {
  freshState();
  for (const id of [FAMILY_SIBLING, 'minimaxai/minimax-m2', 'minimaxai/minimax-m3.1', 'minimaxai/minimax-m3.1-flash-extra']) {
    const meta = getCapabilityMetadata(id);
    assert.deepEqual(meta.reasoning, {
      supported: true, modes: ['disabled', 'enabled'], controlKey: 'chat_template_kwargs.thinking_mode', defaultMode: 'enabled'
    }, id);
    assert.equal(meta.vision, false, id);
  }
  resetModelLimitsCache();
  const saved = process.env.GATEWAY_CONFIG_PATH;
  try {
    process.env.GATEWAY_CONFIG_PATH = path.join(tempRoot, 'does-not-exist.json');
    resetModelLimitsCache();
    assert.deepEqual(getModelLimits('minimaxai/minimax-m3.1'), { context: 131072, output: 4096 });
  } finally {
    if (saved === undefined) delete process.env.GATEWAY_CONFIG_PATH; else process.env.GATEWAY_CONFIG_PATH = saved;
    resetModelLimitsCache();
  }
});

// --- Chat facade: nothing injected, client value forwarded --------------------

test('M4. chat: no gateway-injected effort; a client effort is forwarded unchanged', () => {
  freshState();
  assert.equal(usesReasoningDefaults(MODEL), false);
  const absent = { model: MODEL, messages: [] };
  assert.equal(applyReasoningDefaults(absent), absent);
  assert.equal('reasoning_effort' in absent, false);
  assert.equal('chat_template_kwargs' in absent, false);
  for (const effort of MODES) {
    const body = { model: MODEL, messages: [], reasoning_effort: effort };
    applyReasoningDefaults(body);
    assert.equal(body.reasoning_effort, effort);
  }
  // Responses facade keeps its documented "reasoning is ignored" behaviour.
  assert.equal(mapClientEffort(MODEL, 'high'), undefined);
  const r = translateResponsesRequest({ model: MODEL, input: 'hi', reasoning: { effort: 'high' } });
  assert.equal('reasoning_effort' in r.chatBody, false);
});

// --- Anthropic facade: advertised == sent --------------------------------------

const anthropic = (thinking) => translateAnthropicRequest({
  model: MODEL, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], ...(thinking ? { thinking } : {})
});

test('M5. Anthropic thinking:enabled sends the advertised default; budgets map onto advertised modes', () => {
  freshState();
  const advertised = getCapabilityMetadata(MODEL).reasoning;
  const r = anthropic({ type: 'enabled' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.openaiBody.reasoning_effort, advertised.defaultMode);
  assert.equal('chat_template_kwargs' in r.openaiBody, false, 'the family thinking_mode switch is not sent');

  const effortOf = (budget_tokens) => anthropic({ type: 'enabled', budget_tokens }).openaiBody.reasoning_effort;
  assert.equal(effortOf(2000), 'low');
  assert.equal(effortOf(8000), 'medium');
  assert.equal(effortOf(20000), 'high');
  assert.equal(effortOf(64000), 'max');
  for (const b of [2000, 8000, 20000, 64000]) assert.ok(advertised.modes.includes(effortOf(b)), String(b));

  // The shared defaults injector leaves the adapter's choice alone.
  const body = anthropic({ type: 'enabled', budget_tokens: 8000 }).openaiBody;
  applyReasoningDefaults(body);
  assert.equal(body.reasoning_effort, 'medium');
});

test('M6. Anthropic thinking:disabled sends no fake off-switch and warns; no thinking -> nothing sent', () => {
  freshState();
  const r = anthropic({ type: 'disabled' });
  assert.deepEqual(r.errors, []);
  assert.equal('reasoning_effort' in r.openaiBody, false);
  assert.equal('chat_template_kwargs' in r.openaiBody, false);
  assert.ok(r.warnings.some((w) => /cannot be disabled/.test(w)), r.warnings.join('|'));

  const none = anthropic();
  assert.equal('reasoning_effort' in none.openaiBody, false);
  applyReasoningDefaults(none.openaiBody);
  assert.equal('reasoning_effort' in none.openaiBody, false);
});

test('M7. a fresh probe that narrows the modes is advertised AND clamps what Anthropic sends', () => {
  const cachePath = path.join(tempRoot, `probe-${fixtureSequence++}.json`);
  fs.writeFileSync(cachePath, JSON.stringify({
    version: 2,
    savedAt: '2026-10-25T00:00:00.000Z',
    entries: { [MODEL]: { probedAt: Date.now(), source: 'probed', supported: true, controlKey: 'reasoning_effort', modes: ['low', 'high'], defaultMode: 'high' } }
  }));
  resetCapabilityRegistry();
  resetCapabilityProbeState({ cachePath });
  try {
    const advertised = resolveAdvertisedReasoning(MODEL);
    assert.equal(advertised.authoritative, true);
    const meta = mergeProbedReasoning(getCapabilityMetadata(MODEL), MODEL);
    assert.deepEqual(meta.reasoning, { supported: true, modes: ['low', 'high'], controlKey: 'reasoning_effort', defaultMode: 'high' });

    // Budget 8000 maps to "medium", which the probe no longer advertises: clamped down.
    const clamped = anthropic({ type: 'enabled', budget_tokens: 8000 }).openaiBody.reasoning_effort;
    assert.equal(clamped, 'low');
    assert.ok(meta.reasoning.modes.includes(clamped));
    assert.equal(anthropic({ type: 'enabled' }).openaiBody.reasoning_effort, meta.reasoning.defaultMode);
    assert.equal(anthropic({ type: 'enabled', budget_tokens: 64000 }).openaiBody.reasoning_effort, 'high', 'max is clamped to the highest advertised mode');
  } finally {
    freshState();
  }
});

// --- End to end: /v1/models and the chat wire through the real gateway ------

test('M8. /v1/models advertises the limits/capabilities and the chat wire carries exactly what the client sent', async () => {
  const upstreamBody = JSON.stringify({
    object: 'list',
    data: [
      { id: MODEL, object: 'model', owned_by: 'minimaxai' },
      { id: FAMILY_SIBLING, object: 'model', owned_by: 'minimaxai' }
    ]
  });
  /** @type {any[]} */
  const chatBodies = [];
  const upstream = await createLocalUpstream((req, res) => {
    if (req.url === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(upstreamBody);
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        chatBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const { child, gatewayPort } = await startGatewayWithLocalUpstream(upstream.address().port);
  try {
    const models = await requestGateway(gatewayPort, '/v1/models');
    assert.equal(models.statusCode, 200);
    const byId = new Map(JSON.parse(models.body).data.map((m) => [m.id, m]));
    const m31 = byId.get(MODEL);
    assert.equal(m31.context_length, 262144);
    assert.equal(m31.max_completion_tokens, 65536);
    assert.equal(m31.max_tokens, 262144);
    assert.deepEqual(m31.capabilities, {
      reasoning: { supported: true, modes: MODES, controlKey: 'reasoning_effort', defaultMode: 'high' },
      tools: true, vision: true, audio: false
    });
    // Sibling keeps the family row and its config.example.json limits.
    const sibling = byId.get(FAMILY_SIBLING);
    assert.equal(sibling.capabilities.reasoning.controlKey, 'chat_template_kwargs.thinking_mode');
    assert.equal(sibling.capabilities.vision, false);
    assert.equal(sibling.context_length, 1_000_000);
    assert.equal(sibling.max_completion_tokens, 16_384);

    const chat = (extra) => requestGateway(gatewayPort, '/v1/chat/completions', 'POST',
      JSON.stringify({ model: MODEL, stream: false, messages: [{ role: 'user', content: 'hi' }], ...extra }));
    assert.equal((await chat({})).statusCode, 200);
    assert.equal((await chat({ reasoning_effort: 'xhigh' })).statusCode, 200);
    assert.equal(chatBodies.length, 2);
    assert.equal('reasoning_effort' in chatBodies[0], false, 'gateway injects no effort');
    assert.equal('chat_template_kwargs' in chatBodies[0], false, 'gateway injects no thinking_mode');
    assert.equal(chatBodies[1].reasoning_effort, 'xhigh');
    assert.ok(m31.capabilities.reasoning.modes.includes(chatBodies[1].reasoning_effort));
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

// --- Harness (same convention as tests/model-enrichment.test.mjs) ----------

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

function requestGateway(port, requestPath, method = 'GET', body = '', timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    /** @type {Record<string, string | number>} */
    const headers = { authorization: `Bearer ${TEST_GATEWAY_TOKEN}` };
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const request = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers }, (response) => {
      const chunks = [];
      const deadline = setTimeout(() => response.destroy(new Error('Gateway request timed out.')), timeoutMs);
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        clearTimeout(deadline);
        resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() });
      });
      response.once('error', (error) => { clearTimeout(deadline); reject(error); });
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function startGatewayWithLocalUpstream(upstreamPort) {
  let gatewayPort;
  let statePath;
  const started = await startGatewayOnReservedPort({ maxAttempts: 8, spawnChild(port) {
    gatewayPort = port;
    const gatewayDir = fs.mkdtempSync(path.join(tempRoot, `gateway-${gatewayPort}-`));
    statePath = path.join(gatewayDir, 'keys.json');
    const logPath = path.join(gatewayDir, 'gateway.jsonl');
    fs.writeFileSync(statePath, JSON.stringify({
      keys: [{ id: 'test-key', key: 'local-test-key-notreal', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 } }]
    }));
    const spawned = spawn(process.execPath, [
      '--require', localUpstreamPreloadPath,
      path.join(projectRoot, 'src', 'gateway', 'server.mjs')
    ], {
      env: {
        ...process.env,
        PORT: String(gatewayPort),
        GATEWAY_LOG_PATH: logPath,
        GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstreamPort),
        GATEWAY_CONFIG_PATH: configExamplePath,
        // Fresh per-run probe cache inside the temp dir: no real cache is read,
        // and nothing is written next to config/config.example.json.
        GATEWAY_CAPABILITY_CACHE_PATH: path.join(gatewayDir, 'capability-cache.json'),
        GATEWAY_FIRST_BYTE_TIMEOUT_MS: '300000',
        GATEWAY_IDLE_TIMEOUT_MS: '300000'
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true
    });
    spawned.once('message', (message) => {
      if (message?.type === 'ready') {
        spawned.send({
          type: 'state:init',
          challenge: message.challenge,
          state: {
            keys: JSON.parse(fs.readFileSync(statePath, 'utf8')).keys,
            credentials: { gatewayToken: TEST_GATEWAY_TOKEN, adminToken: 'test-admin-token-notreal' }
          }
        });
      }
    });
    spawned.on('message', (message) => {
      if (message?.type === 'state:persist') fs.writeFileSync(statePath, JSON.stringify(message.state));
    });
    return spawned;
  } });
  const child = started.child;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if (await getHealth(gatewayPort) === 200) return { child, gatewayPort };
    } catch {
      // still starting
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await stopGateway(child);
  throw new Error('Gateway did not become healthy on the reserved port.');
}

async function stopGateway(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    child.once('exit', () => { clearTimeout(killTimer); resolve(); });
    child.kill();
  });
}
