/**
 * W1b upstream-error echo tests (Level-1 fix wave, pass 2, defect 2).
 *
 * MEASURED before this fix: a non-SSE upstream error body was echoed to the
 * CLIENT unbounded and unscrubbed on all three public routes.
 *   - a 1 MB upstream message produced a 1,000,083-byte client body;
 *   - `nvapi-...` and `?token=...` reached the client verbatim on chat,
 *     /v1/messages and /v1/responses.
 *
 * The three echo points are `buildAnthropicUpstreamError`, the Responses
 * envelope builder and the chat pass-through. Every one of them now runs the
 * upstream text through `sanitizeUpstreamErrorMessage` and a byte bound.
 *
 * A short, clean body must STILL pass through byte-identically (pinned by
 * tests/responses-route.test.mjs R16): only a body that actually carries a
 * credential shape or exceeds the bound is rebuilt.
 *
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
const fileTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-w1b-echo-${process.pid}-`));
const MODEL = 'z-ai/glm-5.2';

test.after(() => fs.rmSync(fileTempRoot, { recursive: true, force: true }));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_KEY = 'nvapi-w1c-must-never-reach-the-client';
const QUERY_SECRET = 'abc123secretquerytoken';

function request(port, pathname, method = 'GET', body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      let done = false;
      let guard;
      const finish = (extra) => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), ...extra });
      };
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => finish({}));
      // A body truncated against its declared content-length ends as a
      // transport abort, NOT a clean 'end'. Resolve (rather than hang) and let
      // the assertion name the truncation: this is the defect signature.
      res.on('aborted', () => finish({ aborted: true }));
      res.on('error', (error) => finish({ aborted: true, error }));
      // Absolute guard: a gateway that never terminates the body must FAIL the
      // assertion, not hang the whole file.
      guard = setTimeout(() => { finish({ aborted: true, timedOut: true }); req.destroy(); }, 20_000);
      guard.unref?.();
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Route -> a minimal valid request body for that facade. */
const ROUTES = {
  chat: { pathname: '/v1/chat/completions', body: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] } },
  messages: { pathname: '/v1/messages', body: { model: MODEL, max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] } },
  responses: { pathname: '/v1/responses', body: { model: MODEL, input: 'hi' } }
};

async function startHarness(upstreamReply) {
  const dir = fs.mkdtempSync(path.join(fileTempRoot, 'gw-'));
  const statePath = path.join(dir, 'keys.json');
  const logPath = path.join(dir, 'gateway.jsonl');
  fs.writeFileSync(statePath, JSON.stringify({
    keys: [{ id: 'key-0', key: 'fake-w1c-upstream-key', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 } }]
  }));
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => upstreamReply(res, Buffer.concat(chunks).toString()));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const gatewayToken = `w1c-${randomUUID()}`;
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
              credentials: { gatewayToken, adminToken: 'w1c-admin' }
            }
          });
        }
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

/**
 * Assert the echo contract for ONE route. Failures are COLLECTED per route and
 * raised together, so one run reports the state of all three echo points
 * instead of stopping at the first (the point of this file is that all three
 * leaked, not that one did).
 */
function echoViolations(route, result) {
  const violations = [];
  const check = (condition, message) => { if (!condition) violations.push(`${route}: ${message}`); };
  check(result.statusCode === 400, `the upstream status is preserved, got ${result.statusCode}: ${result.body.slice(0, 200)}`);
  check(result.body.length < 4_096, `the echoed body must be bounded, got ${result.body.length} bytes`);
  check(!result.body.includes(FAKE_KEY), 'the upstream key must never reach the client');
  check(!result.body.includes(QUERY_SECRET), 'a query-string token must never reach the client');
  check(!/\?token=/i.test(result.body), 'the token query must be scrubbed');
  check(!/nvapi-/i.test(result.body), 'no nvapi key may survive the echo');
  let parsed;
  try { parsed = JSON.parse(result.body); } catch { /* recorded below */ }
  check(Boolean(parsed && typeof parsed === 'object'), 'the echo stays a parseable JSON envelope');
  return violations;
}

const OVERSIZED_MESSAGE = `upstream rejected the request ${FAKE_KEY} for /v1/chat/completions?token=${QUERY_SECRET} `
  + 'x'.repeat(1024 * 1024);

test('defect 2: a 1 MB OpenAI-shaped upstream error is bounded and scrubbed on all three routes', async () => {
  const harness = await startHarness((res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: OVERSIZED_MESSAGE, type: 'invalid_request_error' } }));
  });
  try {
    const violations = [];
    for (const [route, spec] of Object.entries(ROUTES)) {
      const body = JSON.stringify(spec.body);
      const result = await request(harness.port, spec.pathname, 'POST', body, harness.auth);
      violations.push(...echoViolations(route, result));
    }
    assert.deepEqual(violations, [], 'every route must bound and scrub the upstream error echo');
  } finally { await harness.close(); }
});

test('defect 2: a 1 MB plain-text upstream error is bounded and scrubbed on all three routes', async () => {
  const harness = await startHarness((res) => {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(OVERSIZED_MESSAGE);
  });
  try {
    const violations = [];
    for (const [route, spec] of Object.entries(ROUTES)) {
      const body = JSON.stringify(spec.body);
      const result = await request(harness.port, spec.pathname, 'POST', body, harness.auth);
      violations.push(...echoViolations(route, result));
    }
    assert.deepEqual(violations, [], 'every route must bound and scrub the upstream error echo');
  } finally { await harness.close(); }
});

test('defect 2: a short CLEAN upstream body is still echoed byte-identically (no over-reach)', async () => {
  const openAiShaped = JSON.stringify({ error: { message: 'context too long', type: 'invalid_request_error', param: 'input', code: 'context_length_exceeded' } });
  const harness = await startHarness((res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(openAiShaped);
  });
  try {
    // Chat keeps the historical verbatim passthrough for a clean body.
    const chat = await request(harness.port, '/v1/chat/completions', 'POST', JSON.stringify(ROUTES.chat.body), harness.auth);
    assert.equal(chat.statusCode, 400);
    assert.equal(chat.body, openAiShaped, 'chat must not rewrite a clean, bounded body');
    // Responses keeps the OpenAI-shaped passthrough Codex parses.
    const responses = await request(harness.port, '/v1/responses', 'POST', JSON.stringify(ROUTES.responses.body), harness.auth);
    assert.equal(responses.statusCode, 400);
    assert.equal(responses.body, openAiShaped, 'the OpenAI-shaped Responses body stays byte-identical');
  } finally { await harness.close(); }
});

// -- Defect 1 (pass 3): a REWRITTEN echo must not reuse upstream framing -----
//
// MEASURED before this fix: the chat echo rewrote the body but forwarded
// upstream's `content-length`. Upstream 94 B (credential-bearing) -> the client
// got 39 B and ECONNRESET; a 5,443 B clean body -> 314 B and an abort. Every
// rewritten chat error was truncated. A clean body keeps its own length.

test('defect 1: a rewritten chat error arrives COMPLETE despite upstream content-length', async () => {
  const upstreamBody = JSON.stringify({ error: { message: `rejected ${FAKE_KEY} at /v1/chat/completions?token=${QUERY_SECRET}`, type: 'invalid_request_error' } });
  const harness = await startHarness((res) => {
    res.writeHead(400, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(upstreamBody)) });
    res.end(upstreamBody);
  });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', JSON.stringify(ROUTES.chat.body), harness.auth);
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.includes(FAKE_KEY), false, 'the credential must not reach the client');
    // The decisive assertion: the client received the WHOLE rewritten body. A
    // stale content-length aborted the connection mid-body (ECONNRESET), so
    // `request()` would have rejected before this line.
    const parsed = JSON.parse(result.body);
    // CRF-001: a JSON-object upstream error keeps its OpenAI envelope
    // ({error:{message,type,...}}) with only the secret-bearing leaves scrubbed,
    // so clients still see `type`/`code`. Accept the flattened legacy string too
    // for non-object bodies; either way the text must be complete and actionable.
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    assert.equal(typeof message, 'string', `the rewritten echo must be a complete envelope, got ${result.body}`);
    assert.match(message, /rejected/, 'the actionable text survives the rewrite');
    const declared = result.headers['content-length'];
    if (declared !== undefined) {
      assert.equal(Number(declared), Buffer.byteLength(result.body), 'a forwarded content-length must describe the REWRITTEN body');
    }
  } finally { await harness.close(); }
});

test('defect 1: a clean chat body keeps upstream content-length AND its exact bytes', async () => {
  const upstreamBody = JSON.stringify({ error: { message: 'context too long', type: 'invalid_request_error' } });
  const length = String(Buffer.byteLength(upstreamBody));
  const harness = await startHarness((res) => {
    res.writeHead(400, { 'content-type': 'application/json', 'content-length': length });
    res.end(upstreamBody);
  });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', JSON.stringify(ROUTES.chat.body), harness.auth);
    assert.equal(result.statusCode, 400);
    assert.equal(result.body, upstreamBody, 'a clean body is still proxied byte-identically');
    assert.equal(result.headers['content-length'], length, 'no rewrite means no header surgery');
  } finally { await harness.close(); }
});

// -- Defect 3 (pass 3): the chat echo sanitizes EVERY body shape --------------
//
// MEASURED before this fix: the chat path only inspected `error.message`,
// `error` (string) and `message`. A FastAPI `detail`, an `error.detail`, or a
// non-string `error.message` matched none of them, so the body was forwarded
// VERBATIM and `nvapi-...` plus `?token=...` reached the client -- while
// /v1/messages and /v1/responses were safe on the same input.

test('defect 3: chat scrubs an unrecognized error shape instead of proxying it verbatim', async () => {
  const shapes = {
    'fastapi detail': { detail: `invalid ${FAKE_KEY}` },
    'nested error.detail': { error: { detail: `invalid /v1/chat/completions?token=${QUERY_SECRET}` } },
    'non-string error.message': { error: { message: { token: FAKE_KEY }, type: 'invalid_request_error' } },
    'plain detail string': { detail: `upstream said no for ${FAKE_KEY}` }
  };
  const harness = await startHarness((res, body) => {
    const model = JSON.parse(body).model;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(shapes[model]));
  });
  try {
    for (const [label, shape] of Object.entries(shapes)) {
      const requestBody = JSON.stringify({ ...ROUTES.chat.body, model: label });
      const result = await request(harness.port, '/v1/chat/completions', 'POST', requestBody, harness.auth);
      assert.equal(result.statusCode, 400, label);
      assert.equal(result.body.includes(FAKE_KEY), false, `${label}: the credential must not reach the client -> ${result.body}`);
      assert.equal(/nvapi-/i.test(result.body), false, `${label}: no nvapi key may survive`);
      assert.equal(result.body.includes(QUERY_SECRET), false, `${label}: the query token must not reach the client -> ${result.body}`);
      assert.equal(/\?token=/i.test(result.body), false, `${label}: the token query must be scrubbed`);
    }
  } finally { await harness.close(); }
});

test('defect 3: a clean unrecognized shape still passes through byte-identically', async () => {
  // The scrub must be shape-agnostic, NOT shape-destructive: FastAPI's own
  // envelope is legitimate client-facing data and carries no secret.
  const clean = JSON.stringify({ detail: [{ loc: ['body', 'model'], msg: 'field required', type: 'value_error.missing' }] });
  const harness = await startHarness((res) => {
    res.writeHead(422, { 'content-type': 'application/json' });
    res.end(clean);
  });
  try {
    const result = await request(harness.port, '/v1/chat/completions', 'POST', JSON.stringify(ROUTES.chat.body), harness.auth);
    assert.equal(result.statusCode, 422);
    assert.equal(result.body, clean, 'a clean body keeps its historical verbatim passthrough');
  } finally { await harness.close(); }
});
