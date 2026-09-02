import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPerformanceModeResolver } from '../src/gateway/performance-mode.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Wiring + boundary coverage for src/gateway/performance-mode.mjs.
//
// THE FIX: performanceMode.observe(...) had ZERO call sites in src/ — the "auto"
// mode could never accumulate evidence and stayed pinned at "day" forever, and
// the day/night timeout profiles never reached the request path (server.mjs
// resolved env-only timeouts once at module load; only maxFailoverAttempts was
// taken from the resolver). server.mjs now feeds every real request outcome
// into observe() at the existing recordOutcome chokepoint and resolves
// first-byte/idle/max-stream timeouts per request from the resolver.
//
// Test 1 is the behavioural wiring proof: RED pre-fix (no transition is ever
// logged, because the evidence window stays empty) and GREEN post-fix.
// Removing the observe line must turn it RED again (verified by mutation run).
// ─────────────────────────────────────────────────────────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function writeConfig(dir, mode) {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ performanceMode: mode }), 'utf8');
  return configPath;
}

// ── Test 1: behavioural wiring proof (spawned real gateway, stub upstream) ──

test('observe() is fed by real request outcomes and drives the auto day->night transition', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-wiring-'));
  const logPath = path.join(dir, 'logs', 'gateway.jsonl');
  const configPath = writeConfig(dir, 'auto');

  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl-test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { total_tokens: 1 }
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const keyRecords = [{
    id: '00000000-0000-4000-8000-000000000000',
    key: 'test-upstream-key',
    status: 'active',
    backoffUntil: 0,
    usage: { success: 0, fail: 0, tokens: 0, lastUsed: 1 }
  }];

  const port = await freePort();
  const child = spawn(process.execPath, ['--require', path.join(repoRoot, 'tests', 'local-upstream-preload.cjs'), path.join(repoRoot, 'src', 'gateway', 'server.mjs')], {
    env: {
      ...process.env,
      GATEWAY_LOG_PATH: logPath,
      GATEWAY_CONFIG_PATH: configPath,
      GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstream.address().port),
      PORT: String(port)
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true
  });

  try {
    child.once('message', (message) => {
      if (message?.type === 'ready') {
        child.send({
          type: 'state:init',
          challenge: message.challenge,
          state: { keys: keyRecords, credentials: { gatewayToken: 'test-gateway-token', adminToken: 'test-admin-token' } }
        });
      }
    });

    await waitFor(async () => {
      try { return (await request(port, '/health')).statusCode === 200; } catch { return false; }
    }, 20_000, 25);

    // Drive 17 real proxied requests. The transition is evaluated on resolve()
    // at request start, so the 17th request observes the window filled by the
    // first 16 completed outcomes (>= MIN_SAMPLES, >= 16 completed, 0 FBT).
    for (let i = 0; i < 17; i++) {
      const result = await request(port, '/v1/chat/completions', 'POST', JSON.stringify({
        model: 'test/model',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }]
      }));
      assert.equal(result.statusCode, 200, `request ${i + 1} must succeed (got ${result.statusCode}: ${result.body})`);
    }

    const readLines = () => {
      try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; }
    };
    // The gateway logger flushes on a 1s debounce — wait for the outcomes to
    // land before asserting on them.
    const completed = await waitFor(() => {
      const lines = readLines().split('\n').filter((l) => l.includes('"request_outcome"') && l.includes('"completed"'));
      return lines.length >= 16 ? lines : undefined;
    }, 15_000, 100);
    assert.ok(completed, 'expected >= 16 logged "completed" outcomes');

    const transition = await waitFor(() => {
      const found = readLines().split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).find((entry) => entry && entry.message === 'performance_mode_transition' && entry.effective === 'night');
      return found || undefined;
    }, 15_000, 100);

    assert.ok(transition, 'auto must promote day->night after 16 completed real requests (no transition logged => observe() was never fed)');
    assert.equal(transition.selected, 'auto');
    assert.equal(transition.previousEffective, 'day');
  } finally {
    await stopChild(child);
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Test 2: auto boundaries with an injected clock ──

test('auto boundaries: cold start, MIN_SAMPLES gate, promote, demote, dwell', () => {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-auto-'));
  const configPath = writeConfig(dir, 'auto');

  // Cold start: no evidence yet => stay conservative on "day".
  let nowMs = 0;
  const transitions = [];
  const resolver = createPerformanceModeResolver({
    configPath,
    env: {},
    now: () => nowMs,
    onEffectiveChange: (state) => transitions.push(state)
  });
  assert.equal(resolver.resolve().effective, 'day', 'cold start must stay on day');

  // Below MIN_SAMPLES (10): 9 completed still cannot promote.
  for (let i = 0; i < 9; i++) resolver.observe('completed');
  assert.equal(resolver.resolve().effective, 'day', '9 samples must not promote');

  // 16 completed total (window length 16 >= 10, 0 first-byte timeouts) promotes.
  // First-ever switch is exempt from the dwell (lastAutoSwitchAt is -Infinity).
  for (let i = 0; i < 7; i++) resolver.observe('completed');
  assert.equal(resolver.resolve().effective, 'night', '16 completed + 0 FBT must promote day->night');
  assert.equal(transitions.length, 1, 'exactly one transition must be announced');
  assert.equal(transitions[0].selected, 'auto');
  assert.equal(transitions[0].effective, 'night');
  assert.equal(transitions[0].previousEffective, 'day');
  assert.equal(transitions[0].completed, 16);

  // Demote signal present but dwell (120s) not elapsed => stays night.
  resolver.observe('first_byte_timeout');
  resolver.observe('first_byte_timeout');
  assert.equal(resolver.resolve().effective, 'night', 'dwell blocks an immediate demote at t=0');
  nowMs = 119_999;
  assert.equal(resolver.resolve().effective, 'night', 'dwell blocks a demote 1ms early');
  nowMs = 120_000;
  assert.equal(resolver.resolve().effective, 'day', '2 first-byte timeouts demote after the 120s dwell');
  assert.equal(transitions.length, 2);
  assert.equal(transitions[1].effective, 'day');
  assert.equal(transitions[1].previousEffective, 'night');
  assert.equal(transitions[1].firstByteTimeouts, 2);

  fs.rmSync(dir, { recursive: true, force: true });

  // Pressure-ratio demote: below 25% holds night, at 25% demotes.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-auto-'));
  const configPath2 = writeConfig(dir, 'auto');
  let now2 = 0;
  const resolver2 = createPerformanceModeResolver({ configPath: configPath2, env: {}, now: () => now2 });
  for (let i = 0; i < 16; i++) resolver2.observe('completed');
  assert.equal(resolver2.resolve().effective, 'night', 'promote first (clean window)');
  now2 = 120_000; // past dwell so the next decide can take effect
  for (let i = 0; i < 4; i++) resolver2.observe('idle_timeout');
  assert.equal(resolver2.resolve().effective, 'night', '4/20 pressure (20%) must hold night');
  resolver2.observe('idle_timeout');
  assert.equal(resolver2.resolve().effective, 'day', '5/20 pressure (25%) must demote to day');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Test 3: env-override boundaries on the resolver ──

test('env overrides: stream clamped to [300_000, 3_600_000], fbt/idle/failover reject out-of-range', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-env-'));
  const dayConfig = writeConfig(dir, 'day');

  const resolveWith = (env) => createPerformanceModeResolver({ configPath: dayConfig, env }).resolve();

  // Stream duration: CLAMPED into [300_000, 3_600_000].
  assert.equal(resolveWith({ GATEWAY_MAX_STREAM_DURATION_MS: '299999' }).maxStreamDurationMs, 300_000);
  assert.equal(resolveWith({ GATEWAY_MAX_STREAM_DURATION_MS: '0' }).maxStreamDurationMs, 300_000);
  assert.equal(resolveWith({ GATEWAY_MAX_STREAM_DURATION_MS: '3600001' }).maxStreamDurationMs, 3_600_000);
  assert.equal(resolveWith({ GATEWAY_MAX_STREAM_DURATION_MS: '1200000' }).maxStreamDurationMs, 1_200_000);

  // First-byte: out-of-range / malformed REJECTED => day profile value (300_000).
  assert.equal(resolveWith({ GATEWAY_FIRST_BYTE_TIMEOUT_MS: '0' }).firstByteTimeoutMs, 300_000);
  assert.equal(resolveWith({ GATEWAY_FIRST_BYTE_TIMEOUT_MS: '1800001' }).firstByteTimeoutMs, 300_000);
  assert.equal(resolveWith({ GATEWAY_FIRST_BYTE_TIMEOUT_MS: 'abc' }).firstByteTimeoutMs, 300_000);
  assert.equal(resolveWith({ GATEWAY_FIRST_BYTE_TIMEOUT_MS: '-5' }).firstByteTimeoutMs, 300_000);
  assert.equal(resolveWith({ GATEWAY_FIRST_BYTE_TIMEOUT_MS: '5000' }).firstByteTimeoutMs, 5_000);

  // Idle: same strict-accept rule.
  assert.equal(resolveWith({ GATEWAY_IDLE_TIMEOUT_MS: '0' }).idleTimeoutMs, 300_000);
  assert.equal(resolveWith({ GATEWAY_IDLE_TIMEOUT_MS: '1800001' }).idleTimeoutMs, 300_000);
  assert.equal(resolveWith({ GATEWAY_IDLE_TIMEOUT_MS: '45000' }).idleTimeoutMs, 45_000);

  // Failover attempts: strict 1..8, else day profile (3).
  assert.equal(resolveWith({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '0' }).maxFailoverAttempts, 3);
  assert.equal(resolveWith({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '9' }).maxFailoverAttempts, 3);
  assert.equal(resolveWith({ GATEWAY_MAX_FAILOVER_ATTEMPTS: 'abc' }).maxFailoverAttempts, 3);
  assert.equal(resolveWith({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '5' }).maxFailoverAttempts, 5);

  // An explicit env var wins over the NIGHT profile too (per knob).
  const nightConfig = writeConfig(dir, 'night');
  const nightResolved = createPerformanceModeResolver({ configPath: nightConfig, env: { GATEWAY_FIRST_BYTE_TIMEOUT_MS: '45000' } }).resolve();
  assert.equal(nightResolved.firstByteTimeoutMs, 45_000);
  assert.equal(nightResolved.idleTimeoutMs, 120_000, 'untouched knobs keep the night profile');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Harness helpers ──

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

async function waitFor(predicate, timeoutMs = 10_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
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

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 1_000);
    child.once('exit', () => { clearTimeout(force); resolve(); });
    child.kill();
  });
}
