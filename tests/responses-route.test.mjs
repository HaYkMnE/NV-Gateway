// Integration tests for the POST /v1/responses (OpenAI Responses API facade)
// gateway route used by Codex CLI (`wire_api = "responses"`). Harness mirrors
// tests/anthropic-route.test.mjs: spawn the real server.mjs with fake keys
// against a programmable local fake upstream (tests/local-upstream-preload.cjs
// redirects the NVIDIA upstream to 127.0.0.1), so no real upstream is contacted.

import assert from 'node:assert/strict';
import { spawn as startChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';
import { GATEWAY_ROUTE_PATHS, classifyGatewayRoute } from '../src/gateway/security.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-gateway-responses-route-${process.pid}-`));
const localUpstreamPreloadPath = path.join(projectRoot, 'tests', 'local-upstream-preload.cjs');
const TEST_GATEWAY_TOKEN = `test-gateway-${randomUUID()}`;
const ADMIN_TOKEN = 'test-admin-token';
const MODEL = 'z-ai/glm-5.2';

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ── Harness (trimmed from anthropic-route.test.mjs) ─────────────────────────

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

// Records every upstream request (url, authorization, parsed JSON body).
function createLocalUpstream(handler) {
  const seen = [];
  return new Promise((resolve, reject) => {
    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
        const entry = { url: req.url, authorization: req.headers.authorization, body, contentLength: req.headers['content-length'], rawBytes: Buffer.byteLength(raw) };
        seen.push(entry);
        handler(entry, res, seen.length);
      });
    });
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', () => resolve({ upstream, seen }));
  });
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function startGateway(upstreamPort, overrides = {}) {
  const startupDeadline = Date.now() + 12_000;
  let gatewayPort;
  let statePath;
  let logPath;
  const started = await startGatewayOnReservedPort({ maxAttempts: 8, readinessTimeoutMs: 12_000, spawnChild(port) {
    gatewayPort = port;
    const gatewayDir = fs.mkdtempSync(path.join(tempRoot, `gateway-${gatewayPort}-`));
    statePath = path.join(gatewayDir, 'keys.json');
    logPath = path.join(gatewayDir, 'gateway.jsonl');
    const keys = overrides.keys ?? ['local-test-key'];
    fs.writeFileSync(statePath, JSON.stringify({
      keys: keys.map((key, index) => ({
        id: `test-key-${index}`, key, status: overrides.keyStatus ?? 'active', backoffUntil: 0,
        usage: { success: 0, fail: 0, tokens: 0, lastUsed: index }
      }))
    }));
    const affinityCachePath = path.join(gatewayDir, 'model-key-affinity.json');
    if (overrides.affinityModel) {
      fs.writeFileSync(affinityCachePath, JSON.stringify({
        version: 1,
        assignments: { [overrides.affinityModel]: { keyId: 'test-key-0', at: Date.now() } },
        cooldowns: {}
      }));
    }
    const spawned = spawnGatewayChild(port, gatewayDir, affinityCachePath, upstreamPort, overrides);
    spawned.once('message', (message) => {
      if (message?.type === 'ready') {
        spawned.send({
          type: 'state:init',
          challenge: message.challenge,
          state: { keys: JSON.parse(fs.readFileSync(statePath, 'utf8')).keys, credentials: { gatewayToken: TEST_GATEWAY_TOKEN, adminToken: ADMIN_TOKEN } }
        });
      }
    });
    spawned.on('message', (message) => {
      if (message?.type === 'state:persist') fs.writeFileSync(statePath, JSON.stringify(message.state));
    });
    return spawned;
  } });
  const child = started.child;
  while (Date.now() < startupDeadline) {
    try {
      if (await getHealth(gatewayPort) === 200) return { child, gatewayPort, logPath };
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await stopGateway(child);
  throw new Error('Gateway did not become healthy in time.');
}

// `noNextKey`: register tests/support/no-next-key-hooks.mjs in the child.
const noNextKeyImport = `data:text/javascript,${encodeURIComponent(
  `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(path.join(projectRoot, 'tests', 'support', 'no-next-key-hooks.mjs')).href)});`
)}`;

function spawnGatewayChild(port, gatewayDir, affinityCachePath, upstreamPort, overrides) {
  return startChild(process.execPath, [
    ...(overrides.noNextKey ? ['--import', noNextKeyImport] : []),
    '--require', localUpstreamPreloadPath,
    path.join(projectRoot, 'src', 'gateway', 'server.mjs')
  ], {
    env: {
      ...process.env,
      PORT: String(port),
      GATEWAY_LOG_PATH: path.join(gatewayDir, 'gateway.jsonl'),
      GATEWAY_MODEL_AFFINITY_CACHE_PATH: affinityCachePath,
      GATEWAY_CORS_ALLOWLIST: overrides.corsAllowlist,
      GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstreamPort),
      GATEWAY_MAX_FAILOVER_ATTEMPTS: overrides.maxFailoverAttempts === undefined ? undefined : String(overrides.maxFailoverAttempts),
      GATEWAY_FIRST_BYTE_TIMEOUT_MS: String(overrides.firstByteTimeoutMs ?? 2000),
      GATEWAY_IDLE_TIMEOUT_MS: String(overrides.idleTimeoutMs ?? 2000),
      ...(overrides.requestDeadlineMs === undefined ? {} : { GATEWAY_REQUEST_DEADLINE_MS: String(overrides.requestDeadlineMs) }),
      ...(overrides.maxBufferedBytes === undefined ? {} : { GATEWAY_MAX_BUFFERED_RESPONSE_BYTES: String(overrides.maxBufferedBytes) }),
      GATEWAY_MAX_STREAM_DURATION_MS: '30000'
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true
  });
}

async function stopGateway(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    const fallback = setTimeout(resolve, 2_000);
    child.once('exit', () => { clearTimeout(killTimer); clearTimeout(fallback); resolve(); });
    try { child.kill(); } catch { /* already gone */ }
  });
}

function rawRequest({ port, pathname, method = 'POST', body = '', headers = {}, timeoutMs = 8_000 }) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (body && !('content-length' in requestHeaders)) {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['content-length'] = Buffer.byteLength(body);
    }
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: requestHeaders }, (response) => {
      const chunks = [];
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), ...result });
      };
      const deadline = setTimeout(() => { response.destroy(); finish({ terminal: 'timed-out' }); }, timeoutMs);
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => finish({ terminal: 'ended' }));
      response.once('aborted', () => finish({ terminal: 'aborted' }));
      response.once('error', (error) => finish({ terminal: 'error', error }));
    });
    request.once('error', reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Request timed out.')));
    request.end(body);
  });
}

const authHeaders = (extra = {}) => ({ authorization: `Bearer ${TEST_GATEWAY_TOKEN}`, ...extra });

function postResponses(port, payload, { pathname = '/v1/responses', headers = authHeaders() } = {}) {
  return rawRequest({ port, pathname, body: JSON.stringify(payload), headers });
}

function parseSse(text) {
  return text.split('\n\n').filter((frame) => frame.trim()).map((frame) => {
    let eventType = '';
    let data = null;
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) eventType = line.slice(7).trim();
      if (line.startsWith('data: ')) data = JSON.parse(line.slice(6));
    }
    return { eventType, data };
  });
}

async function adminKeys(port) {
  const result = await rawRequest({ port: port + 1, pathname: '/admin/keys', method: 'GET', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  assert.equal(result.statusCode, 200);
  return JSON.parse(result.body).keys;
}

// ── Fake upstream payloads (OpenAI Chat Completions) ────────────────────────

function chatCompletion(message, { finish = 'stop', usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } = {}) {
  return JSON.stringify({
    id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
    usage
  });
}

function sseFrames(chunks) {
  return chunks.map((chunk) => `data: ${JSON.stringify({ id: 'chatcmpl-s', model: MODEL, ...chunk })}\n\n`).join('') + 'data: [DONE]\n\n';
}

const USAGE_CHUNK = { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } };

function replyJson(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function replySse(res, body) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(body);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('R0. security classifies /v1/responses as its own protected route', () => {
  assert.equal(classifyGatewayRoute('POST', '/v1/responses'), 'responses');
  assert.equal(classifyGatewayRoute('POST', '/v1/responses/'), 'responses');
  assert.equal(classifyGatewayRoute('GET', '/v1/responses'), null);
  assert.equal(GATEWAY_ROUTE_PATHS.responses, '/v1/responses');
});

test('R1. non-streaming text: instructions + string input reach upstream as chat messages; reply is a response object', async () => {
  const { upstream, seen } = await createLocalUpstream((_entry, res) => replyJson(res, chatCompletion({ content: 'Hello!' })));
  const { child, gatewayPort } = await startGateway(upstream.address().port);
  try {
    const result = await postResponses(gatewayPort, {
      model: MODEL, instructions: 'Be brief.', input: 'Say hello', max_output_tokens: 64, temperature: 0.2, top_p: 0.9
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.match(result.headers['content-type'] || '', /^application\/json/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/v1/chat/completions');
    assert.deepEqual(seen[0].body, {
      model: MODEL,
      messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Say hello' }],
      temperature: 0.2, top_p: 0.9, max_tokens: 64
    });
    const response = JSON.parse(result.body);
    assert.match(response.id, /^resp_/);
    assert.equal(response.object, 'response');
    assert.equal(Number.isInteger(response.created_at), true);
    assert.equal(response.status, 'completed');
    assert.equal(response.model, MODEL);
    assert.equal(response.output.length, 1);
    assert.equal(response.output[0].type, 'message');
    assert.equal(response.output[0].role, 'assistant');
    assert.deepEqual(response.output[0].content, [{ type: 'output_text', text: 'Hello!', annotations: [] }]);
    assert.equal(response.usage.input_tokens, 5);
    assert.equal(response.usage.output_tokens, 2);
    assert.equal(response.usage.total_tokens, 7);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('R2. tool round trip: tools forwarded, tool_calls -> function_call items, function_call_output -> tool message', async () => {
  const { upstream, seen } = await createLocalUpstream((_entry, res, n) => replyJson(res, n === 1
    ? chatCompletion({ content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, { finish: 'tool_calls' })
    : chatCompletion({ content: 'It is sunny.' })));
  const { child, gatewayPort } = await startGateway(upstream.address().port);
  const tool = { type: 'function', name: 'get_weather', description: 'Weather by city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, strict: false };
  try {
    const first = await postResponses(gatewayPort, {
      model: MODEL, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Weather in Paris?' }] }],
      tools: [tool], tool_choice: 'auto', parallel_tool_calls: false
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(seen[0].body.tools, [{ type: 'function', function: { name: 'get_weather', description: 'Weather by city', parameters: tool.parameters } }]);
    assert.equal(seen[0].body.tool_choice, 'auto');
    assert.equal(seen[0].body.parallel_tool_calls, false);
    assert.deepEqual(seen[0].body.messages, [{ role: 'user', content: 'Weather in Paris?' }]);
    const output = JSON.parse(first.body).output;
    assert.equal(output.length, 1);
    assert.equal(output[0].type, 'function_call');
    assert.equal(output[0].call_id, 'call_abc');
    assert.equal(output[0].name, 'get_weather');
    assert.equal(output[0].arguments, '{"city":"Paris"}');

    const second = await postResponses(gatewayPort, {
      model: MODEL,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Weather in Paris?' }] },
        { type: 'function_call', call_id: 'call_abc', name: 'get_weather', arguments: '{"city":"Paris"}' },
        { type: 'function_call_output', call_id: 'call_abc', output: '{"sky":"sunny"}' }
      ],
      tools: [tool]
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(seen[1].body.messages, [
      { role: 'user', content: 'Weather in Paris?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'call_abc', content: '{"sky":"sunny"}' }
    ]);
    assert.equal(JSON.parse(second.body).output[0].content[0].text, 'It is sunny.');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

function assertWellFormedSse(events) {
  events.forEach((event, index) => {
    assert.equal(event.eventType, event.data.type, `event line must equal JSON type at #${index}`);
    assert.equal(event.data.sequence_number, index, `sequence_number must count from 0 at #${index}`);
  });
}

test('R3a. streaming text: exact Responses event order and usage in response.completed', async () => {
  const { upstream, seen } = await createLocalUpstream((_entry, res) => replySse(res, sseFrames([
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    USAGE_CHUNK
  ])));
  const { child, gatewayPort } = await startGateway(upstream.address().port);
  try {
    const result = await postResponses(gatewayPort, { model: MODEL, input: 'hi', stream: true });
    assert.equal(result.statusCode, 200, result.body);
    assert.match(result.headers['content-type'] || '', /^text\/event-stream/);
    assert.equal(result.terminal, 'ended');
    assert.equal(seen[0].body.stream, true);
    const events = parseSse(result.body);
    assert.deepEqual(events.map((event) => event.eventType), [
      'response.created', 'response.in_progress',
      'response.output_item.added', 'response.content_part.added',
      'response.output_text.delta', 'response.output_text.delta',
      'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
      'response.completed'
    ]);
    assertWellFormedSse(events);
    assert.deepEqual(events.filter((e) => e.eventType === 'response.output_text.delta').map((e) => e.data.delta), ['Hel', 'lo']);
    assert.equal(events[6].data.text, 'Hello');
    const completed = events.at(-1).data.response;
    assert.equal(completed.status, 'completed');
    assert.match(completed.id, /^resp_/);
    assert.equal(completed.id, events[0].data.response.id);
    assert.deepEqual(completed.output[0].content, [{ type: 'output_text', text: 'Hello', annotations: [] }]);
    assert.equal(completed.usage.input_tokens, 9);
    assert.equal(completed.usage.output_tokens, 4);
    assert.equal(completed.usage.total_tokens, 13);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('R3b. streaming tool call: function_call item events in order, arguments assembled', async () => {
  const { upstream } = await createLocalUpstream((_entry, res) => replySse(res, sseFrames([
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: '' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '["ls"]}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    USAGE_CHUNK
  ])));
  const { child, gatewayPort } = await startGateway(upstream.address().port);
  try {
    const result = await postResponses(gatewayPort, {
      model: MODEL, input: 'list files', stream: true,
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: {} } }]
    });
    assert.equal(result.statusCode, 200, result.body);
    const events = parseSse(result.body);
    assert.deepEqual(events.map((event) => event.eventType), [
      'response.created', 'response.in_progress',
      'response.output_item.added',
      'response.function_call_arguments.delta', 'response.function_call_arguments.delta',
      'response.function_call_arguments.done', 'response.output_item.done',
      'response.completed'
    ]);
    assertWellFormedSse(events);
    assert.equal(events[2].data.item.type, 'function_call');
    assert.equal(events[2].data.item.call_id, 'call_1');
    assert.equal(events[5].data.arguments, '{"command":["ls"]}');
    const done = events[6].data.item;
    assert.deepEqual({ type: done.type, call_id: done.call_id, name: done.name, arguments: done.arguments, status: done.status },
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":["ls"]}', status: 'completed' });
    assert.equal(events.at(-1).data.response.usage.total_tokens, 13);
    assert.equal(events.at(-1).data.response.output[0].type, 'function_call');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('R3c. streaming upstream SSE error after content ends with response.failed', async () => {
  const { upstream } = await createLocalUpstream((_entry, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ error: { message: 'boom', type: 'server_error' } })}\n\n`);
  });
  const { child, gatewayPort } = await startGateway(upstream.address().port);
  try {
    const result = await postResponses(gatewayPort, { model: MODEL, input: 'hi', stream: true });
    assert.equal(result.statusCode, 200);
    const events = parseSse(result.body);
    const failed = events.at(-1);
    assert.equal(failed.eventType, 'response.failed');
    assert.equal(failed.data.response.status, 'failed');
    assert.equal(failed.data.response.error.message, 'boom');
    assert.equal(events.some((e) => e.eventType === 'response.completed'), false);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('R4a. no token -> 401 and previous_response_id -> 400; neither reaches upstream', async () => {
  const { upstream, seen } = await createLocalUpstream((_entry, res) => replyJson(res, chatCompletion({ content: 'x' })));
  const { child, gatewayPort } = await startGateway(upstream.address().port);
  try {
    const unauthorized = await postResponses(gatewayPort, { model: MODEL, input: 'hi' }, { headers: {} });
    assert.equal(unauthorized.statusCode, 401);
    const wrongToken = await postResponses(gatewayPort, { model: MODEL, input: 'hi' }, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(wrongToken.statusCode, 401);
    // x-api-key is an Anthropic-facade-only fallback (MASTER-006).
    const apiKeyOnly = await postResponses(gatewayPort, { model: MODEL, input: 'hi' }, { headers: { 'x-api-key': TEST_GATEWAY_TOKEN } });
    assert.equal(apiKeyOnly.statusCode, 401);

    const stateful = await postResponses(gatewayPort, { model: MODEL, input: 'again', previous_response_id: 'resp_123' });
    assert.equal(stateful.statusCode, 400);
    const error = JSON.parse(stateful.body).error;
    assert.equal(error.type, 'invalid_request_error');
    assert.equal(error.param, 'previous_response_id');
    assert.match(error.message, /stateless/);

    const malformed = await rawRequest({ port: gatewayPort, pathname: '/v1/responses', body: '{not json', headers: authHeaders() });
    assert.equal(malformed.statusCode, 400);
    assert.equal(seen.length, 0, 'rejected requests must never touch a key');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

function keySnapshot(keys) {
  return keys.map((key) => ({ status: key.status, success: key.usage.success, fail: key.usage.fail, tokens: key.usage.tokens }));
}

async function runRateLimitFailover(pathname, payload) {
  const model = 'rate-limit-failover/model';
  const { upstream, seen } = await createLocalUpstream((_entry, res, n) => (n === 1
    ? replyJson(res, JSON.stringify({ error: { message: 'Too Many Requests', type: 'rate_limit' } }), 429)
    : replyJson(res, chatCompletion({ content: 'from-b' }))));
  const { child, gatewayPort } = await startGateway(upstream.address().port, { keys: ['key-a', 'key-b'], affinityModel: model, maxFailoverAttempts: 2 });
  try {
    const result = await rawRequest({ port: gatewayPort, pathname, body: JSON.stringify({ model, ...payload }), headers: authHeaders() });
    const keys = await adminKeys(gatewayPort);
    return { result, authorizations: seen.map((entry) => entry.authorization), keys: keySnapshot(keys) };
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
}

test('R4b. upstream 429 fails over to the next key with the same key accounting as chat/completions', async () => {
  const chat = await runRateLimitFailover('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] });
  const responses = await runRateLimitFailover('/v1/responses', { input: 'hi' });
  assert.equal(chat.result.statusCode, 200, chat.result.body);
  assert.equal(responses.result.statusCode, 200, responses.result.body);
  assert.equal(JSON.parse(responses.result.body).output[0].content[0].text, 'from-b');
  assert.deepEqual(responses.authorizations, ['Bearer key-a', 'Bearer key-b']);
  assert.deepEqual(responses.authorizations, chat.authorizations);
  assert.deepEqual(responses.keys, chat.keys, 'key usage/fail/tokens must match the chat route exactly');
  assert.equal(responses.keys[1].success, 1);
  assert.equal(responses.keys[1].tokens, 7, 'buffered success accounts total_tokens like chat');
});

test('R5. query string, single trailing slash, CORS preflight and the 5 MB body limit behave like chat', async () => {
  const { upstream, seen } = await createLocalUpstream((_entry, res) => replyJson(res, chatCompletion({ content: 'ok' })));
  const origin = 'http://localhost:5173';
  const { child, gatewayPort } = await startGateway(upstream.address().port, { corsAllowlist: origin });
  try {
    for (const pathname of ['/v1/responses?x=1', '/v1/responses/']) {
      const result = await postResponses(gatewayPort, { model: MODEL, input: 'hi' }, { pathname });
      assert.equal(result.statusCode, 200, `${pathname}: ${result.body}`);
      assert.equal(JSON.parse(result.body).object, 'response');
    }
    assert.deepEqual(seen.map((entry) => entry.url), ['/v1/chat/completions', '/v1/chat/completions'], 'client query/slash never reaches upstream');

    const preflight = await rawRequest({ port: gatewayPort, pathname: '/v1/responses', method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], origin);
    const foreign = await rawRequest({ port: gatewayPort, pathname: '/v1/responses', method: 'OPTIONS', headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(foreign.statusCode, 403);

    const oversized = await rawRequest({ port: gatewayPort, pathname: '/v1/responses', body: JSON.stringify({ model: MODEL, input: 'x'.repeat(5 * 1024 * 1024 + 16) }), headers: authHeaders() });
    assert.equal(oversized.statusCode, 413);
    assert.equal(seen.length, 2, 'oversized body must not reach upstream');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('R6. Codex CLI-shaped streaming request is accepted and translated', async () => {
  // Shape from Codex CLI source, codex-rs/codex-api/src/common.rs (struct
  // ResponsesApiRequest: model, stream, instructions, input, tools, tool_choice,
  // parallel_tool_calls, reasoning, store, include, prompt_cache_key, text,
  // client_metadata) and codex-rs/tools/src/tool_spec.rs (ToolSpec tagged
  // `function` | `custom` | `web_search` | `namespace` | `tool_search`).
  const codexRequest = {
    model: MODEL,
    stream: true,
    instructions: 'You are Codex, a coding agent.',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions>sandbox</permissions>' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list the repo' }] },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' }
    ],
    tools: [
      { type: 'function', name: 'shell', description: 'Runs a shell command', strict: false, parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } }, required: ['command'] } },
      { type: 'custom', name: 'apply_patch', description: 'Apply a patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } },
      { type: 'web_search' }
    ],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning: { effort: 'medium', summary: 'auto' },
    store: false,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: randomUUID(),
    text: { verbosity: 'medium' },
    client_metadata: { originator: 'codex_cli_rs' }
  };
  const { upstream, seen } = await createLocalUpstream((_entry, res) => replySse(res, sseFrames([
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    USAGE_CHUNK
  ])));
  const { child, gatewayPort } = await startGateway(upstream.address().port);
  try {
    const result = await postResponses(gatewayPort, codexRequest);
    assert.equal(result.statusCode, 200, result.body);
    const sent = seen[0].body;
    assert.deepEqual(Object.keys(sent).sort(), ['messages', 'model', 'parallel_tool_calls', 'stream', 'stream_options', 'tool_choice', 'tools']);
    assert.deepEqual(sent.messages, [
      { role: 'system', content: 'You are Codex, a coding agent.' },
      { role: 'system', content: '<permissions>sandbox</permissions>' },
      { role: 'user', content: 'list the repo' }
    ]);
    assert.deepEqual(sent.tools.map((tool) => tool.function.name), ['shell', 'apply_patch'], 'custom tools become functions; hosted web_search is dropped');
    const events = parseSse(result.body);
    assertWellFormedSse(events);
    assert.equal(events.at(-1).eventType, 'response.completed');
    assert.equal(events.at(-1).data.response.output[0].content[0].text, 'Done.');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

// ── Freeform (custom) tools: Codex apply_patch ──────────────────────────────

// Codex's real apply_patch tool: codex-rs/core/src/tools/handlers/apply_patch_spec.rs
// (create_apply_patch_freeform_tool -> ToolSpec::Freeform, serialized with
// `type: "custom"` per codex-rs/tools/src/tool_spec.rs) and the grammar in
// codex-rs/core/assets/tools/apply_patch.lark. The function variant was removed
// in openai/codex PR #21651, so this is the only shape Codex sends.
const APPLY_PATCH_LARK = [
  'start: begin_patch hunk+ end_patch',
  'begin_patch: "*** Begin Patch" LF',
  'end_patch: "*** End Patch" LF?',
  '',
  'hunk: add_hunk | delete_hunk | update_hunk',
  'add_hunk: "*** Add File: " filename LF add_line+',
  'delete_hunk: "*** Delete File: " filename LF',
  'update_hunk: "*** Update File: " filename LF change_move? change?',
  '',
  'filename: /(.+)/',
  'add_line: "+" /(.*)/ LF -> line',
  '',
  'change_move: "*** Move to: " filename LF',
  'change: (change_context | change_line)+ eof_line?',
  'change_context: ("@@" | "@@ " /(.+)/) LF',
  'change_line: ("+" | "-" | " ") /(.*)/ LF',
  'eof_line: "*** End of File" LF',
  '',
  '%import common.LF',
  ''
].join('\n');
const APPLY_PATCH_TOOL = {
  type: 'custom',
  name: 'apply_patch',
  description: 'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.',
  format: { type: 'grammar', syntax: 'lark', definition: APPLY_PATCH_LARK }
};
const SHELL_TOOL = { type: 'function', name: 'shell', description: 'Runs a shell command', strict: false, parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } }, required: ['command'] } };
// Multi-line patch with double quotes and backslashes (a regex and a Windows path).
const PATCH = '*** Begin Patch\n*** Update File: src/say "hi".js\n@@\n-const re = /\\d+\\s*/;\n+const dir = "C:\\\\Users\\\\dev";\n*** End Patch\n';
const PATCH_ARGS = JSON.stringify({ input: PATCH });

test('R7. apply_patch custom tool reaches upstream as a function with `input`; tool_call returns as custom_tool_call (non-stream)', async () => {
  const { upstream, seen } = await createLocalUpstream((_entry, res) => replyJson(res, chatCompletion(
    { content: null, tool_calls: [{ id: 'call_patch', type: 'function', function: { name: 'apply_patch', arguments: PATCH_ARGS } }] },
    { finish: 'tool_calls' })));
  const { child, gatewayPort } = await startGateway(upstream.address().port);
  try {
    const result = await postResponses(gatewayPort, { model: MODEL, input: 'edit the file', tools: [APPLY_PATCH_TOOL], tool_choice: 'auto' });
    assert.equal(result.statusCode, 200, result.body);
    const [sentTool] = seen[0].body.tools;
    assert.equal(sentTool.type, 'function');
    assert.equal(sentTool.function.name, 'apply_patch');
    assert.deepEqual(sentTool.function.parameters, {
      type: 'object', properties: { input: { type: 'string', description: 'raw tool input' } }, required: ['input'], additionalProperties: false
    });
    assert.ok(sentTool.function.description.startsWith(APPLY_PATCH_TOOL.description));
    assert.match(sentTool.function.description, /grammar\/lark/);
    assert.ok(sentTool.function.description.includes('start: begin_patch hunk+ end_patch'), 'grammar note is included');

    const output = JSON.parse(result.body).output;
    assert.equal(output.length, 1);
    const call = output[0];
    assert.match(call.id, /^ctc_/);
    assert.deepEqual({ type: call.type, call_id: call.call_id, name: call.name, input: call.input, status: call.status },
      { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: PATCH, status: 'completed' });
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('R8. streamed apply_patch tool_call: custom_tool_call events carry the exact patch (arguments split mid-escape)', async () => {
  const cut1 = PATCH_ARGS.indexOf('\\\\') + 1; // inside an escaped backslash
  const cut2 = PATCH_ARGS.indexOf('\\"') + 1;  // inside an escaped quote
  const [a, b, c] = [PATCH_ARGS.slice(0, Math.min(cut1, cut2)), PATCH_ARGS.slice(Math.min(cut1, cut2), Math.max(cut1, cut2)), PATCH_ARGS.slice(Math.max(cut1, cut2))];
  const { upstream } = await createLocalUpstream((_entry, res) => replySse(res, sseFrames([
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_patch', type: 'function', function: { name: 'apply_patch', arguments: a } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: b } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: c } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    USAGE_CHUNK
  ])));
  const { child, gatewayPort } = await startGateway(upstream.address().port);
  try {
    const result = await postResponses(gatewayPort, { model: MODEL, input: 'edit', stream: true, tools: [APPLY_PATCH_TOOL] });
    assert.equal(result.statusCode, 200, result.body);
    const events = parseSse(result.body);
    assert.deepEqual(events.map((event) => event.eventType), [
      'response.created', 'response.in_progress',
      'response.output_item.added',
      'response.custom_tool_call_input.delta', 'response.custom_tool_call_input.done',
      'response.output_item.done',
      'response.completed'
    ]);
    assertWellFormedSse(events);
    assert.equal(events[2].data.item.type, 'custom_tool_call');
    assert.equal(events[3].data.delta, PATCH);
    assert.equal(events[4].data.input, PATCH);
    const done = events[5].data.item;
    assert.deepEqual({ type: done.type, call_id: done.call_id, name: done.name, input: done.input, status: done.status },
      { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: PATCH, status: 'completed' });
    assert.equal(events.at(-1).data.response.output[0].input, PATCH);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('R9. history: custom_tool_call + output (string or content parts) reach upstream as tool_calls + tool messages', async () => {
  const { upstream, seen } = await createLocalUpstream((_entry, res) => replyJson(res, chatCompletion({ content: 'Patched.' })));
  const { child, gatewayPort } = await startGateway(upstream.address().port);
  try {
    const result = await postResponses(gatewayPort, {
      model: MODEL,
      tools: [APPLY_PATCH_TOOL, SHELL_TOOL],
      input: [
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] },
        { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_patch', name: 'apply_patch', input: PATCH, status: 'completed' },
        { type: 'custom_tool_call_output', call_id: 'call_patch', output: [{ type: 'input_text', text: 'Success.' }, { type: 'input_text', text: 'M src/a.js' }] },
        { type: 'function_call', call_id: 'call_sh', name: 'shell', arguments: '{"command":["git","diff"]}' },
        { type: 'function_call_output', call_id: 'call_sh', output: [{ type: 'input_text', text: 'diff --git' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'thanks' }] }
      ]
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(seen[0].body.messages, [
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_patch', type: 'function', function: { name: 'apply_patch', arguments: PATCH_ARGS } }] },
      { role: 'tool', tool_call_id: 'call_patch', content: 'Success.\nM src/a.js' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_sh', type: 'function', function: { name: 'shell', arguments: '{"command":["git","diff"]}' } }] },
      { role: 'tool', tool_call_id: 'call_sh', content: 'diff --git' },
      { role: 'user', content: 'thanks' }
    ]);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('R10. mixed turn: one response carries a function_call and a custom_tool_call (non-stream and stream)', async () => {
  const toolCalls = [
    { index: 0, id: 'call_sh', type: 'function', function: { name: 'shell', arguments: '{"command":["ls"]}' } },
    { index: 1, id: 'call_patch', type: 'function', function: { name: 'apply_patch', arguments: PATCH_ARGS } }
  ];
  const { upstream } = await createLocalUpstream((entry, res) => (entry.body.stream
    ? replySse(res, sseFrames([
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Working.' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [toolCalls[0]] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [toolCalls[1]] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      USAGE_CHUNK
    ]))
    : replyJson(res, chatCompletion({ content: 'Working.', tool_calls: toolCalls.map(({ index, ...call }) => call) }, { finish: 'tool_calls' }))));
  const { child, gatewayPort } = await startGateway(upstream.address().port);
  const pick = (item) => (item.type === 'message'
    ? { type: item.type, text: item.content[0].text }
    : item.type === 'function_call'
      ? { type: item.type, call_id: item.call_id, name: item.name, arguments: item.arguments }
      : { type: item.type, call_id: item.call_id, name: item.name, input: item.input });
  const expected = [
    { type: 'message', text: 'Working.' },
    { type: 'function_call', call_id: 'call_sh', name: 'shell', arguments: '{"command":["ls"]}' },
    { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: PATCH }
  ];
  try {
    const buffered = await postResponses(gatewayPort, { model: MODEL, input: 'go', tools: [SHELL_TOOL, APPLY_PATCH_TOOL] });
    assert.equal(buffered.statusCode, 200, buffered.body);
    assert.deepEqual(JSON.parse(buffered.body).output.map(pick), expected);

    const streamed = await postResponses(gatewayPort, { model: MODEL, input: 'go', stream: true, tools: [SHELL_TOOL, APPLY_PATCH_TOOL] });
    assert.equal(streamed.statusCode, 200, streamed.body);
    const events = parseSse(streamed.body);
    assertWellFormedSse(events);
    assert.deepEqual(events.filter((e) => e.eventType === 'response.output_item.done').map((e) => pick(e.data.item)), expected);
    assert.equal(events.some((e) => e.eventType === 'response.function_call_arguments.done' && e.data.item_id === events.find((x) => x.eventType === 'response.output_item.added' && x.data.item.type === 'custom_tool_call').data.item.id), false,
      'custom tool calls never emit function_call_arguments events');
    assert.deepEqual(events.at(-1).data.response.output.map(pick), expected);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('R12. duplicate tool names across function/custom tools -> 400 before upstream; hosted tools never collide', async () => {
  const { upstream, seen } = await createLocalUpstream((_entry, res) => replyJson(res, chatCompletion(
    { content: null, tool_calls: [{ id: 'call_ap', type: 'function', function: { name: 'apply_patch', arguments: '{"patch":"x"}' } }] },
    { finish: 'tool_calls' })));
  const { child, gatewayPort } = await startGateway(upstream.address().port);
  const customShell = { type: 'custom', name: 'shell', description: 'freeform shell' };
  try {
    for (const tools of [[SHELL_TOOL, customShell], [SHELL_TOOL, { ...SHELL_TOOL, description: 'second' }]]) {
      const result = await postResponses(gatewayPort, { model: MODEL, input: 'go', tools });
      assert.equal(result.statusCode, 400, result.body);
      const error = JSON.parse(result.body).error;
      assert.equal(error.type, 'invalid_request_error');
      assert.equal(error.param, 'tools');
      assert.equal(error.code, 'unsupported_parameter');
      assert.match(error.message, /duplicate tool name/);
      assert.match(error.message, /'shell'/);
    }
    assert.equal(seen.length, 0, 'duplicate tool names must never reach upstream');

    // A FUNCTION named apply_patch (no custom tool of that name) stays a function_call.
    const fnApplyPatch = { type: 'function', name: 'apply_patch', parameters: { type: 'object', properties: { patch: { type: 'string' } } } };
    const plain = await postResponses(gatewayPort, { model: MODEL, input: 'go', tools: [fnApplyPatch] });
    assert.equal(plain.statusCode, 200, plain.body);
    const [call] = JSON.parse(plain.body).output;
    assert.deepEqual({ type: call.type, name: call.name, arguments: call.arguments }, { type: 'function_call', name: 'apply_patch', arguments: '{"patch":"x"}' });

    // Dropped hosted tools do not count toward duplicates.
    const hosted = await postResponses(gatewayPort, { model: MODEL, input: 'go', tools: [{ type: 'web_search', name: 'apply_patch' }, fnApplyPatch] });
    assert.equal(hosted.statusCode, 200, hosted.body);
    assert.deepEqual(seen[1].body.tools.map((tool) => tool.function.name), ['apply_patch']);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

// ── CR9-001: failover exits answer /v1/responses with the OpenAI error object ─

// One request per fresh gateway, so key counters are per scenario and per route.
const FAILURE_ROUTES = {
  chat: { pathname: '/v1/chat/completions', body: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] } },
  chatStream: { pathname: '/v1/chat/completions', body: { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true } },
  responses: { pathname: '/v1/responses', body: { model: MODEL, input: 'hi' } },
  responsesStream: { pathname: '/v1/responses', body: { model: MODEL, input: 'hi', stream: true } },
  anthropic: { pathname: '/v1/messages', body: { model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 } }
};

const hangUpstream = () => {}; // never answers; closeServer() tears the socket down

const FAILURE_SCENARIOS = {
  // writePoolWideFailure: every key answered 429.
  rateLimit: {
    status: 429, anthropicType: 'rate_limit_error', gateway: { keys: ['key-a', 'key-b'] },
    message: 'Upstream rate limit: every available key is currently rate-limited.',
    upstream: (_entry, res) => replyJson(res, JSON.stringify({ error: { message: 'Too Many Requests', type: 'rate_limit' } }), 429)
  },
  // Total request deadline cuts the only attempt before the first byte.
  deadline: {
    status: 504, anthropicType: 'request_timeout', gateway: { firstByteTimeoutMs: 2000, requestDeadlineMs: 800 },
    message: 'Gateway request deadline exceeded', upstream: hangUpstream
  },
  // Decision 1a idle round: the single key stays silent past first-byte.
  idle: {
    status: 503, anthropicType: 'api_error', gateway: { firstByteTimeoutMs: 100 },
    message: 'Upstream temporarily unavailable', upstream: hangUpstream
  },
  // Every attempt hangs up -> 502 exhausted with the key-free `detail`.
  reset: {
    status: 502, anthropicType: 'api_error', gateway: {},
    message: 'All failover attempts exhausted', upstream: (_entry, res) => res.socket.destroy()
  },
  // No eligible key on the first attempt -> 503 before any upstream call.
  noKeys: {
    status: 503, anthropicType: 'api_error', gateway: { keyStatus: 'disabled' },
    message: 'All API keys exhausted', upstream: (_entry, res) => replyJson(res, chatCompletion({ content: 'x' }))
  },
  // Selection returns no key although the pool has an active one -> the
  // "No available keys to service request" exit (reached via a loader hook).
  noNextKey: {
    status: 503, anthropicType: 'api_error', gateway: { noNextKey: true },
    message: 'All API keys exhausted', upstream: (_entry, res) => replyJson(res, chatCompletion({ content: 'x' }))
  },
  // Upstream error body larger than the buffered-response cap -> 502.
  tooLarge: {
    status: 502, anthropicType: 'api_error', gateway: { maxBufferedBytes: 1024 },
    message: 'Upstream response too large',
    upstream: (_entry, res) => replyJson(res, JSON.stringify({ error: { message: 'x'.repeat(4096), type: 'invalid_request_error' } }), 400)
  }
};

async function runFailure(scenario, route) {
  const { upstream, seen } = await createLocalUpstream(scenario.upstream);
  const { child, gatewayPort } = await startGateway(upstream.address().port, scenario.gateway);
  try {
    const { pathname, body } = FAILURE_ROUTES[route];
    const result = await rawRequest({ port: gatewayPort, pathname, body: JSON.stringify(body), headers: authHeaders(), timeoutMs: 10_000 });
    return { result, keys: keySnapshot(await adminKeys(gatewayPort)), upstreamCalls: seen.length };
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
}

async function assertFailureShapes(name) {
  const scenario = FAILURE_SCENARIOS[name];
  const routes = Object.keys(FAILURE_ROUTES);
  const runs = Object.fromEntries(await Promise.all(routes.map(async (route) => [route, await runFailure(scenario, route)])));
  for (const route of routes) {
    const { result } = runs[route];
    assert.equal(result.statusCode, scenario.status, `${name}/${route}: ${result.body}`);
    assert.equal(result.terminal, 'ended', `${name}/${route}`);
    assert.match(result.headers['content-type'] || '', /^application\/json/, `${name}/${route}: plain JSON, never SSE`);
  }

  // Chat keeps the historical `{ error: "<string>" }` body (plus `detail` on 502).
  const chatBody = JSON.parse(runs.chat.result.body);
  assert.equal(chatBody.error, scenario.message, `${name}: chat body unchanged`);
  assert.deepEqual(JSON.parse(runs.chatStream.result.body), chatBody);
  const { error: message, ...extra } = chatBody;
  if (name === 'reset') assert.match(extra.detail, /dropped the connection/);

  // /v1/responses: the OpenAI error object Codex parses (error.code / error.type).
  const expected = {
    error: {
      message,
      type: scenario.status === 429 ? 'rate_limit_error' : 'server_error',
      param: null,
      code: scenario.status === 429 ? 'rate_limit_exceeded' : null
    },
    ...extra
  };
  for (const route of ['responses', 'responsesStream']) {
    assert.deepEqual(JSON.parse(runs[route].result.body), expected, `${name}/${route}`);
    assert.equal('retry-after' in runs[route].result.headers, 'retry-after' in runs.chat.result.headers, `${name}/${route}: Retry-After parity`);
  }

  // Anthropic facade unchanged.
  assert.deepEqual(JSON.parse(runs.anthropic.result.body), { type: 'error', error: { type: scenario.anthropicType, message }, ...extra });

  // Failover/accounting untouched: same key counters and upstream calls as chat.
  assert.deepEqual(runs.responses.keys, runs.chat.keys, `${name}: key counters match chat`);
  assert.deepEqual(runs.responsesStream.keys, runs.chatStream.keys, `${name}: stream key counters match chat`);
  assert.equal(runs.responses.upstreamCalls, runs.chat.upstreamCalls);
  assert.equal(runs.responsesStream.upstreamCalls, runs.chatStream.upstreamCalls);
  return runs;
}

test('R13. all keys 429 -> 429 with the OpenAI rate-limit error object and Retry-After', { timeout: 60_000 }, async () => {
  const runs = await assertFailureShapes('rateLimit');
  for (const route of ['responses', 'responsesStream']) {
    assert.match(runs[route].result.headers['retry-after'] || '', /^\d+$/, `${route}: Retry-After`);
    assert.equal(JSON.parse(runs[route].result.body).error.code, 'rate_limit_exceeded');
  }
  assert.equal(runs.responses.upstreamCalls, 2, 'both keys were tried');
});

test('R14. deadline 504, idle 503, reset 502 and no-keys 503 return the OpenAI error object (stream and non-stream)', { timeout: 120_000 }, async () => {
  for (const name of ['deadline', 'idle', 'reset', 'noKeys']) await assertFailureShapes(name);
  const noKeys = await runFailure(FAILURE_SCENARIOS.noKeys, 'responses');
  assert.equal(noKeys.upstreamCalls, 0, 'no-keys never reaches upstream');
});

test('R15. "No available keys" exit and an oversized upstream error body use the per-mode error shape', { timeout: 120_000 }, async () => {
  const noNextKey = await assertFailureShapes('noNextKey');
  assert.equal(noNextKey.responses.upstreamCalls, 0, 'selection returned no key: upstream never called');
  // Chat and Anthropic stay byte-identical.
  assert.equal(noNextKey.chat.result.body, '{"error":"All API keys exhausted"}');
  assert.equal(noNextKey.anthropic.result.body, '{"type":"error","error":{"type":"api_error","message":"All API keys exhausted"}}');
  for (const route of ['chat', 'responses', 'responsesStream', 'anthropic']) {
    assert.match(noNextKey[route].result.headers['retry-after'] || '', /^\d+$/, `${route}: Retry-After kept`);
  }

  const tooLarge = await assertFailureShapes('tooLarge');
  assert.equal(tooLarge.chat.result.body, '{"error":"Upstream response too large"}');
  assert.equal(tooLarge.anthropic.result.body, '{"type":"error","error":{"type":"api_error","message":"Upstream response too large"}}');
});

test('R16. non-retryable upstream 400: OpenAI-shaped body passes through, other bodies are wrapped (responses only)', { timeout: 60_000 }, async () => {
  const openaiShaped = JSON.stringify({ error: { message: 'context too long', type: 'invalid_request_error', param: 'input', code: 'context_length_exceeded' } });
  const variants = {
    'v/openai': { contentType: 'application/json', body: openaiShaped },
    'v/string': { contentType: 'application/json', body: '{"error":"bad"}' },
    'v/text': { contentType: 'text/plain', body: '  bad\n' },
    'v/empty': { contentType: 'text/plain', body: '' }
  };
  const { upstream, seen } = await createLocalUpstream((entry, res) => {
    const variant = variants[entry.body.model];
    // A header that must never be echoed on the wrapped (gateway-built) body.
    res.writeHead(400, { 'content-type': variant.contentType, 'x-upstream-trace': 'trace-123' });
    res.end(variant.body);
  });
  const { child, gatewayPort } = await startGateway(upstream.address().port);
  const send = (pathname, model, stream) => rawRequest({
    port: gatewayPort, pathname, headers: authHeaders(),
    body: JSON.stringify(pathname === '/v1/responses' ? { model, input: 'hi', stream } : { model, messages: [{ role: 'user', content: 'hi' }], stream })
  });
  const wrapped = (message) => ({ error: { message, type: 'invalid_request_error', param: null, code: null } });
  try {
    for (const stream of [false, true]) {
      const label = stream ? 'stream' : 'non-stream';
      const passthrough = await send('/v1/responses', 'v/openai', stream);
      assert.equal(passthrough.statusCode, 400, label);
      assert.equal(passthrough.body, openaiShaped, `${label}: OpenAI-shaped body passes through unchanged`);

      for (const [model, message] of [['v/string', 'bad'], ['v/text', 'bad'], ['v/empty', 'Upstream returned status 400']]) {
        const result = await send('/v1/responses', model, stream);
        assert.equal(result.statusCode, 400, `${label} ${model}`);
        assert.match(result.headers['content-type'] || '', /^application\/json/, `${label} ${model}`);
        assert.deepEqual(JSON.parse(result.body), wrapped(message), `${label} ${model}`);
        assert.equal(result.headers['x-upstream-trace'], undefined, `${label} ${model}: no upstream headers on a wrapped body`);
      }

      // Chat keeps the verbatim upstream body (unchanged behaviour).
      assert.equal((await send('/v1/chat/completions', 'v/string', stream)).body, '{"error":"bad"}', `${label}: chat string error verbatim`);
      assert.equal((await send('/v1/chat/completions', 'v/text', stream)).body, '  bad\n', `${label}: chat text body verbatim`);
    }
    assert.equal(seen.length, 2 * (1 + 3 + 2), 'a non-retryable 400 is never retried on another key');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('R17. GLM-5.3 gets bounded reasoning defaults on chat, responses and anthropic; other models are untouched', { timeout: 60_000 }, async () => {
  const { upstream, seen } = await createLocalUpstream((entry, res) => replyJson(res, chatCompletion({ content: 'hi' })));
  const { child, gatewayPort } = await startGateway(upstream.address().port);
  const glm = 'z-ai/glm-5.3';
  const chat = (payload) => rawRequest({ port: gatewayPort, pathname: '/v1/chat/completions', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(payload) });
  const messages = [{ role: 'user', content: 'hi' }];
  try {
    // chat: nothing sent -> defaults injected; the rest of the body is preserved.
    assert.equal((await chat({ model: glm, messages, temperature: 0.3 })).statusCode, 200);
    assert.equal(seen[0].body.reasoning_effort, 'high');
    assert.deepEqual(seen[0].body.chat_template_kwargs, { clear_thinking: true });
    assert.equal(seen[0].body.temperature, 0.3);
    assert.deepEqual(seen[0].body.messages, messages);

    // chat: client values win; kwargs are merged, not replaced.
    assert.equal((await chat({ model: glm, messages, reasoning_effort: 'max', chat_template_kwargs: { clear_thinking: false, x: 1 } })).statusCode, 200);
    assert.equal(seen[1].body.reasoning_effort, 'max');
    assert.deepEqual(seen[1].body.chat_template_kwargs, { clear_thinking: false, x: 1 });

    // chat: an out-of-set value is normalised.
    assert.equal((await chat({ model: 'z-ai/glm-5.3-flash', messages, reasoning_effort: 'medium' })).statusCode, 200);
    assert.equal(seen[2].body.reasoning_effort, 'high');

    // responses: reasoning.effort is mapped; absent -> default.
    assert.equal((await postResponses(gatewayPort, { model: glm, input: 'hi', reasoning: { effort: 'xhigh' } })).statusCode, 200);
    assert.equal(seen[3].body.reasoning_effort, 'max');
    assert.deepEqual(seen[3].body.chat_template_kwargs, { clear_thinking: true });
    assert.equal((await postResponses(gatewayPort, { model: glm, input: 'hi' })).statusCode, 200);
    assert.equal(seen[4].body.reasoning_effort, 'high');

    // anthropic: disabled -> low (cannot be turned off); budget -> valid value.
    const messagesRoute = (payload) => rawRequest({ port: gatewayPort, pathname: '/v1/messages', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ model: glm, max_tokens: 64, messages, ...payload }) });
    assert.equal((await messagesRoute({ thinking: { type: 'disabled' } })).statusCode, 200);
    assert.equal(seen[5].body.reasoning_effort, 'low');
    assert.equal(seen[5].body.chat_template_kwargs.enable_thinking, undefined);
    assert.equal(seen[5].body.chat_template_kwargs.clear_thinking, true);
    assert.equal((await messagesRoute({ thinking: { type: 'enabled', budget_tokens: 40000 } })).statusCode, 200);
    assert.equal(seen[6].body.reasoning_effort, 'max');
    assert.equal((await messagesRoute({})).statusCode, 200);
    assert.equal(seen[7].body.reasoning_effort, 'high');

    // other models: no injection on any route.
    assert.equal((await chat({ model: MODEL, messages })).statusCode, 200);
    assert.equal('reasoning_effort' in seen[8].body, false);
    assert.equal('chat_template_kwargs' in seen[8].body, false);
    assert.equal((await postResponses(gatewayPort, { model: MODEL, input: 'hi', reasoning: { effort: 'high' } })).statusCode, 200);
    assert.equal('reasoning_effort' in seen[9].body, false);
    assert.equal('chat_template_kwargs' in seen[9].body, false);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('R18. request_outcome rows carry timing and token counts, never prompt content', { timeout: 60_000 }, async () => {
  const { upstream } = await createLocalUpstream((entry, res) => replyJson(res, chatCompletion({ content: 'hi' })));
  const { child, gatewayPort, logPath } = await startGateway(upstream.address().port);
  try {
    assert.equal((await postResponses(gatewayPort, { model: MODEL, input: 'prompt-canary-8841' })).statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // logger flush
    const raw = fs.readFileSync(logPath, 'utf8');
    const rows = raw.trim().split('\n').filter(Boolean).map(JSON.parse).filter((entry) => entry.message === 'request_outcome');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'completed');
    assert.equal(rows[0].tokens, 7, 'total_tokens of the buffered completion');
    for (const field of ['ttfbMs', 'elapsedMs']) {
      assert.ok(Number.isInteger(rows[0][field]) && rows[0][field] >= 0, field + ' = ' + rows[0][field]);
    }
    assert.ok(rows[0].elapsedMs >= rows[0].ttfbMs);
    assert.equal(JSON.stringify(rows[0]).includes('prompt-canary-8841'), false);
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});
test('R19. Kimi K3 defaults to high effort; GLM chat strips enable_thinking; multi-byte bodies and stream survive', { timeout: 60_000 }, async () => {
  const { upstream, seen } = await createLocalUpstream((entry, res) => (entry.body.stream
    ? replySse(res, sseFrames([
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ]))
    : replyJson(res, chatCompletion({ content: 'hi' }))));
  const { child, gatewayPort, logPath } = await startGateway(upstream.address().port);
  const chat = (payload) => rawRequest({ port: gatewayPort, pathname: '/v1/chat/completions', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(payload) });
  const kimi = 'moonshotai/kimi-k3';
  const messages = [{ role: 'user', content: 'hi' }];
  try {
    // Kimi K3: default high, client value normalised, sampling params and kwargs untouched.
    assert.equal((await chat({ model: kimi, messages, top_p: 0.4, temperature: 1 })).statusCode, 200);
    assert.equal(seen[0].body.reasoning_effort, 'high');
    assert.equal(seen[0].body.top_p, 0.4);
    assert.equal('chat_template_kwargs' in seen[0].body, false);
    assert.equal((await chat({ model: kimi, messages, reasoning_effort: 'xhigh' })).statusCode, 200);
    assert.equal(seen[1].body.reasoning_effort, 'max');
    assert.equal((await postResponses(gatewayPort, { model: kimi, input: 'hi', reasoning: { effort: 'low' } })).statusCode, 200);
    assert.equal(seen[2].body.reasoning_effort, 'low');
    assert.equal((await rawRequest({ port: gatewayPort, pathname: '/v1/messages', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ model: kimi, max_tokens: 32, messages }) })).statusCode, 200);
    assert.equal(seen[3].body.reasoning_effort, 'high');

    // GLM-5.3 chat: client enable_thinking is stripped, other kwargs kept, multi-byte text intact
    // and Content-Length matches the re-serialized bytes.
    const text = '日本語 🙂 ключ';
    assert.equal((await chat({ model: 'z-ai/glm-5.3', messages: [{ role: 'user', content: text }], chat_template_kwargs: { enable_thinking: false, keep: 1 } })).statusCode, 200);
    assert.deepEqual(seen[4].body.chat_template_kwargs, { keep: 1, clear_thinking: true });
    assert.equal(seen[4].body.messages[0].content, text);
    assert.equal(Number(seen[4].contentLength), seen[4].rawBytes, 'Content-Length equals the real byte length');
    assert.ok(seen[4].rawBytes > JSON.stringify(seen[4].body).length, 'the body really contains multi-byte characters');

    // GLM-5.3 chat stream: the stream flag survives and the client still receives SSE.
    const streamed = await chat({ model: 'z-ai/glm-5.3', messages, stream: true });
    assert.equal(streamed.statusCode, 200, streamed.body);
    assert.equal(seen[5].body.stream, true);
    assert.equal(seen[5].body.reasoning_effort, 'high');
    assert.match(streamed.body, /\[DONE\]|"finish_reason":"stop"/);

    // Unknown token count is logged as null, not 0 (the streamed chat reply reported no usage).
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const rows = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((entry) => entry.message === 'request_outcome');
    const streamedRow = rows.at(-1);
    assert.equal(streamedRow.outcome, 'completed');
    assert.equal(streamedRow.tokens, null);
    assert.equal(rows.some((entry) => entry.tokens === 0), false, 'tokens is never the ambiguous 0');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});
test('R20. request_outcome rows: ttfbMs/elapsedMs are numbers, tokens is a number with usage and null without, no prompt content', { timeout: 60_000 }, async () => {
  const { upstream } = await createLocalUpstream((entry, res) => {
    const withUsage = entry.body.messages?.some((m) => String(m.content).includes('with-usage'));
    const reply = JSON.parse(chatCompletion({ content: 'hi' }));
    if (!withUsage) delete reply.usage;
    replyJson(res, JSON.stringify(reply));
  });
  const { child, gatewayPort, logPath } = await startGateway(upstream.address().port);
  const chat = (content) => rawRequest({ port: gatewayPort, pathname: '/v1/chat/completions', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }] }) });
  try {
    assert.equal((await chat('with-usage prompt-canary-5521')).statusCode, 200);
    assert.equal((await chat('no-usage prompt-canary-5521')).statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // logger flush
    const raw = fs.readFileSync(logPath, 'utf8');
    const rows = raw.trim().split('\n').filter(Boolean).map(JSON.parse).filter((entry) => entry.message === 'request_outcome');
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.outcome, 'completed');
      assert.ok(Number.isInteger(row.ttfbMs) && row.ttfbMs >= 0, 'ttfbMs = ' + row.ttfbMs);
      assert.ok(Number.isInteger(row.elapsedMs) && row.elapsedMs >= row.ttfbMs, 'elapsedMs = ' + row.elapsedMs);
    }
    assert.equal(rows[0].tokens, 7, 'upstream usage.total_tokens present -> a number');
    assert.equal(rows[1].tokens, null, 'no upstream usage -> null, never an ambiguous 0');
    assert.equal(raw.includes('prompt-canary-5521'), false, 'no prompt content anywhere in the log');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('R21. DeepSeek V4.1: chat preserves raw numeric effort, Responses and Anthropic fabricate none', { timeout: 60_000 }, async () => {
  const { upstream, seen } = await createLocalUpstream((entry, res) => replyJson(res, chatCompletion({ content: 'hi' })));
  const { child, gatewayPort } = await startGateway(upstream.address().port);
  const model = 'deepseek-ai/deepseek-v4.1-flash';
  try {
    const chat = await rawRequest({
      port: gatewayPort, pathname: '/v1/chat/completions', headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 42 })
    });
    assert.equal(chat.statusCode, 200, chat.body);
    assert.equal(seen[0].body.reasoning_effort, 42, 'raw numeric value is preserved');

    const responses = await postResponses(gatewayPort, { model, input: 'hi', reasoning: { effort: 'high' } });
    assert.equal(responses.statusCode, 200, responses.body);
    assert.equal('reasoning_effort' in seen[1].body, false, 'Responses string effort is not translated');

    const anthropic = await rawRequest({
      port: gatewayPort, pathname: '/v1/messages', headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled', budget_tokens: 8000 } })
    });
    assert.equal(anthropic.statusCode, 200, anthropic.body);
    assert.equal('reasoning_effort' in seen[2].body, false, 'Anthropic thinking is not translated into a string effort');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});

test('R11. streamed turn asks upstream for usage and records its tokens on the key (buffered turns send no stream_options)', async () => {
  const { upstream, seen } = await createLocalUpstream((entry, res) => (entry.body.stream
    ? replySse(res, sseFrames([
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      USAGE_CHUNK
    ]))
    : replyJson(res, chatCompletion({ content: 'hi' }))));
  const { child, gatewayPort } = await startGateway(upstream.address().port);
  try {
    // A client-side Responses `stream_options` must not leak through verbatim.
    const streamed = await postResponses(gatewayPort, { model: MODEL, input: 'hi', stream: true, stream_options: { include_obfuscation: false } });
    assert.equal(streamed.statusCode, 200, streamed.body);
    assert.deepEqual(seen[0].body.stream_options, { include_usage: true });
    assert.equal(parseSse(streamed.body).at(-1).data.response.usage.total_tokens, 13);

    const buffered = await postResponses(gatewayPort, { model: MODEL, input: 'hi' });
    assert.equal(buffered.statusCode, 200, buffered.body);
    assert.equal('stream_options' in seen[1].body, false);

    const [key] = keySnapshot(await adminKeys(gatewayPort));
    assert.equal(key.success, 2);
    assert.equal(key.tokens, 13 + 7, 'streamed usage.total_tokens (13) + buffered total_tokens (7)');
  } finally {
    await stopGateway(child);
    await closeServer(upstream);
  }
});
