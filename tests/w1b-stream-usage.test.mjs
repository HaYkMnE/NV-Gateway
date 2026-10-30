/**
 * W1b streamed-usage tests (Level-1 fix wave, defect 4).
 *
 * Measured production state: `tokens` was null in 5,528 of 5,532 streamed rows
 * and 0 of 4,224 streamed completions recorded any. Root cause: the facade's
 * `streamedTokens()` returned a hard 0 unless the request was /v1/responses, and
 * the OpenAI pass-through never read usage at all — so neither
 * `request_outcome.tokens` nor `usage.tokens` on the key ever saw a value.
 *
 * These tests pin BOTH consumers (log row + key counter) for a plain chat
 * stream, and pin that an absent usage stays null instead of a fabricated 0.
 * Fake upstream + fake keys on 127.0.0.1 only.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';
import { GATEWAY_START_MAX_ATTEMPTS, highPortReservation, killOnBindCollision } from './support/gateway-bind-collision.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fileTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-w1b-usage-${process.pid}-`));
const MODEL = 'z-ai/glm-5.2';
const ADMIN_TOKEN = 'w1b-admin';

test.after(() => fs.rmSync(fileTempRoot, { recursive: true, force: true }));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(port, pathname, method = 'GET', body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function sseFrames(chunks) {
  return chunks.map((chunk) => `data: ${JSON.stringify({ id: 'chatcmpl-w1b', model: MODEL, ...chunk })}\n\n`).join('') + 'data: [DONE]\n\n';
}

async function startHarness(handleRequest) {
  const dir = fs.mkdtempSync(path.join(fileTempRoot, 'gw-'));
  const statePath = path.join(dir, 'keys.json');
  const logPath = path.join(dir, 'gateway.jsonl');
  fs.writeFileSync(statePath, JSON.stringify({
    keys: [{ id: 'key-0', key: 'fake-w1b-upstream-key', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 } }]
  }));
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => handleRequest({ req, res, body: Buffer.concat(chunks).toString() }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const gatewayToken = `w1b-${randomUUID()}`;
  let child;
  let detach;
  const started = await startGatewayOnReservedPort({
    maxAttempts: GATEWAY_START_MAX_ATTEMPTS,
    reservationOptions: highPortReservation(),
    readinessTimeoutMs: 20_000,
    spawnChild(candidatePort) {
      const spawned = spawn(process.execPath, ['--require', path.join(root, 'tests/local-upstream-preload.cjs'), path.join(root, 'src/gateway/server.mjs')], {
        env: {
          ...process.env,
          GATEWAY_LOG_PATH: logPath,
          GATEWAY_MAX_FAILOVER_ATTEMPTS: '1',
          GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstream.address().port),
          PORT: String(candidatePort)
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true
      });
      child = spawned;
      detach = killOnBindCollision(spawned);
      spawned.once('message', (message) => {
        if (message?.type === 'ready') {
          spawned.send({
            type: 'state:init',
            challenge: message.challenge,
            state: {
              keys: JSON.parse(fs.readFileSync(statePath, 'utf8')).keys,
              credentials: { gatewayToken, adminToken: ADMIN_TOKEN }
            }
          });
        }
      });
      spawned.on('message', (message) => {
        if (message?.type === 'state:persist') fs.writeFileSync(statePath, JSON.stringify(message.state));
      });
      return spawned;
    }
  });
  child = started.child;
  detach();
  const port = started.port;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try { if ((await request(port, '/health')).statusCode === 200) break; } catch { /* retry */ }
    await delay(25);
  }
  const auth = { authorization: `Bearer ${gatewayToken}`, 'content-type': 'application/json' };
  return {
    port,
    auth,
    readKeys: () => JSON.parse(fs.readFileSync(statePath, 'utf8')).keys,
    readOutcomes: () => fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((entry) => entry?.message === 'request_outcome')
      : [],
    close: async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => {
          const force = setTimeout(() => child.kill('SIGKILL'), 1_000);
          child.once('exit', () => { clearTimeout(force); resolve(); });
          child.kill();
        });
      }
      upstream.closeAllConnections?.();
      await new Promise((resolve) => upstream.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const USAGE_CHUNK = { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } };
const BUFFERED_USAGE = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };

test('defect 4: a plain CHAT stream records upstream usage on the key and in the outcome row', async () => {
  const harness = await startHarness(({ res, body }) => {
    const stream = JSON.parse(body || '{}').stream === true;
    if (!stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-w1b', object: 'chat.completion', model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: BUFFERED_USAGE
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseFrames([
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      USAGE_CHUNK
    ]));
  });
  try {
    const chat = (payload) => request(harness.port, '/v1/chat/completions', 'POST', JSON.stringify(payload), harness.auth);
    assert.equal((await chat({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] })).statusCode, 200);
    assert.equal((await chat({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] })).statusCode, 200);

    let keys;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      keys = harness.readKeys();
      if (keys[0].usage.success === 2 && keys[0].usage.tokens === 20) break;
      await delay(50);
    }
    assert.equal(keys[0].usage.success, 2);
    assert.equal(keys[0].usage.tokens, 13 + 7, 'streamed usage (13) + buffered total_tokens (7)');

    let rows = [];
    for (let attempt = 0; attempt < 80 && rows.length < 2; attempt += 1) {
      rows = harness.readOutcomes();
      if (rows.length < 2) await delay(50);
    }
    assert.deepEqual(rows.map((row) => row.tokens), [13, 7], 'both rows carry the real token counts');
  } finally { await harness.close(); }
});

test('defect 4: prompt/completion-only usage is summed, and an absent usage stays null', async () => {
  const harness = await startHarness(({ res, body }) => {
    const split = JSON.parse(body || '{}').messages?.some((message) => String(message.content).includes('split'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseFrames([
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      // Variant: no total_tokens, only the two counters.
      ...(split ? [{ choices: [], usage: { prompt_tokens: 4, completion_tokens: 6 } }] : [])
    ]));
  });
  try {
    const chat = (content) => request(harness.port, '/v1/chat/completions', 'POST',
      JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content }] }), harness.auth);
    assert.equal((await chat('split prompt')).statusCode, 200);
    assert.equal((await chat('plain prompt')).statusCode, 200);

    let rows = [];
    for (let attempt = 0; attempt < 80 && rows.length < 2; attempt += 1) {
      rows = harness.readOutcomes();
      if (rows.length < 2) await delay(50);
    }
    assert.deepEqual(rows.map((row) => row.tokens), [10, null],
      'prompt+completion is summed; an absent usage stays null (never a fabricated 0)');
    assert.equal(rows.some((row) => row.tokens === 0), false, 'tokens is never the ambiguous 0');
  } finally { await harness.close(); }
});

test('defect 4: the Anthropic streaming facade records upstream usage too', async () => {
  const harness = await startHarness(({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseFrames([
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      USAGE_CHUNK
    ]));
  });
  try {
    const body = JSON.stringify({ model: MODEL, max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal((await request(harness.port, '/v1/messages', 'POST', body, harness.auth)).statusCode, 200);

    let rows = [];
    for (let attempt = 0; attempt < 80 && rows.length < 1; attempt += 1) {
      rows = harness.readOutcomes();
      if (rows.length < 1) await delay(50);
    }
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'completed');
    assert.equal(rows[0].tokens, 13, 'the Anthropic stream must record the upstream usage frame');
  } finally { await harness.close(); }
});

// ── Defect 4 (pass 2): usage must be REQUESTED, not merely accepted ──────────
//
// The three tests above pass on a fake that VOLUNTEERS a usage frame. A real
// OpenAI-compatible upstream does not: usage on a streamed completion is
// emitted only when the request carries `stream_options.include_usage`. These
// two tests use a fake that sends NO usage frame unless the flag is present,
// so they fail on a gateway that merely reads usage it is handed.

test('defect 4: a plain CHAT stream ASKS upstream for usage and records it', async () => {
  const captured = [];
  const harness = await startHarness(({ res, body }) => {
    const parsed = JSON.parse(body || '{}');
    captured.push(parsed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Honors the flag exactly like a real upstream: usage ONLY when asked.
    const frames = [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ];
    if (parsed.stream_options?.include_usage === true) frames.push(USAGE_CHUNK);
    res.end(sseFrames(frames));
  });
  try {
    const body = JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal((await request(harness.port, '/v1/chat/completions', 'POST', body, harness.auth)).statusCode, 200);

    assert.equal(captured.length, 1, 'the stream must reach upstream exactly once');
    assert.deepEqual(captured[0].stream_options, { include_usage: true },
      'a streamed chat request must ask upstream for the usage frame');

    let rows = [];
    for (let attempt = 0; attempt < 80 && rows.length < 1; attempt += 1) {
      rows = harness.readOutcomes();
      if (rows.length < 1) await delay(50);
    }
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tokens, 13, 'the requested usage frame must be recorded on the outcome row');
    let keys = harness.readKeys();
    for (let attempt = 0; attempt < 120 && keys[0].usage.tokens !== 13; attempt += 1) {
      await delay(50);
      keys = harness.readKeys();
    }
    assert.equal(keys[0].usage.tokens, 13, 'the requested usage frame must reach the key counter');
  } finally { await harness.close(); }
});

test('defect 4: a NON-streaming chat request sends no stream_options', async () => {
  const captured = [];
  const harness = await startHarness(({ res, body }) => {
    captured.push(JSON.parse(body || '{}'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-w1b', object: 'chat.completion', model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: BUFFERED_USAGE
    }));
  });
  try {
    const body = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal((await request(harness.port, '/v1/chat/completions', 'POST', body, harness.auth)).statusCode, 200);
    assert.equal(captured.length, 1);
    assert.equal('stream_options' in captured[0], false,
      'stream_options is a streaming-only field and must not be sent on a buffered turn');
  } finally { await harness.close(); }
});

test('defect 4: the ANTHROPIC streaming facade ASKS upstream for usage and records it', async () => {
  const captured = [];
  const harness = await startHarness(({ res, body }) => {
    const parsed = JSON.parse(body || '{}');
    captured.push(parsed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frames = [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ];
    if (parsed.stream_options?.include_usage === true) frames.push(USAGE_CHUNK);
    res.end(sseFrames(frames));
  });
  try {
    const body = JSON.stringify({ model: MODEL, max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal((await request(harness.port, '/v1/messages', 'POST', body, harness.auth)).statusCode, 200);

    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].stream_options, { include_usage: true },
      'the translated Anthropic stream must ask upstream for the usage frame');

    let rows = [];
    for (let attempt = 0; attempt < 80 && rows.length < 1; attempt += 1) {
      rows = harness.readOutcomes();
      if (rows.length < 1) await delay(50);
    }
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'completed');
    assert.equal(rows[0].tokens, 13, 'the requested usage frame must be recorded through the facade');
  } finally { await harness.close(); }
});

// -- Defect 6 (pass 3): the usage frame is a TRADE-OFF, not a free win --------
//
// Asking upstream for `include_usage` makes it emit a `{"choices":[],"usage":...}`
// frame the client never asked for. That is spec-legal (the flag was sent) and
// it is the only way streamed turns record tokens at all -- MEASURED, tokens
// were null in 5,528 of 5,532 streamed rows before. So the DEFAULT stays: ask.
// The exception is an EXPLICIT opt-out, where the client's contract must win.

test('defect 6: a client that did NOT mention include_usage still gets it injected (default)', async () => {
  const captured = [];
  const harness = await startHarness(({ res, body }) => {
    captured.push(JSON.parse(body || '{}'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseFrames([{ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }]));
  });
  try {
    const body = JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal((await request(harness.port, '/v1/chat/completions', 'POST', body, harness.auth)).statusCode, 200);
    assert.equal(captured[0].stream_options?.include_usage, true,
      'the default must keep asking for usage: it is the only source of streamed token counts');
  } finally { await harness.close(); }
});

test('defect 6: an explicit include_usage:false is respected (no frame injected into the client contract)', async () => {
  const captured = [];
  const harness = await startHarness(({ res, body }) => {
    captured.push(JSON.parse(body || '{}'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseFrames([{ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }]));
  });
  try {
    const body = JSON.stringify({
      model: MODEL,
      stream: true,
      stream_options: { include_usage: false },
      messages: [{ role: 'user', content: 'hi' }]
    });
    assert.equal((await request(harness.port, '/v1/chat/completions', 'POST', body, harness.auth)).statusCode, 200);
    assert.deepEqual(captured[0].stream_options, { include_usage: false },
      'an explicit opt-out must reach upstream unchanged, so no usage frame is produced');
  } finally { await harness.close(); }
});

test('defect 6: a client stream_options sibling field survives the merge', async () => {
  const captured = [];
  const harness = await startHarness(({ res, body }) => {
    captured.push(JSON.parse(body || '{}'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseFrames([{ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }]));
  });
  try {
    const body = JSON.stringify({
      model: MODEL,
      stream: true,
      stream_options: { include_obfuscation: false },
      messages: [{ role: 'user', content: 'hi' }]
    });
    assert.equal((await request(harness.port, '/v1/chat/completions', 'POST', body, harness.auth)).statusCode, 200);
    assert.deepEqual(captured[0].stream_options, { include_obfuscation: false, include_usage: true },
      'the merge keeps the client field AND adds the usage request');
  } finally { await harness.close(); }
});