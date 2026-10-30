import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';
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

  const { child, port } = await startPerformanceGateway({
    upstreamPort: upstream.address().port,
    dir,
    configPath,
    logPath,
    keyRecords
  });

  try {
    const health = await request(port, '/health');
    assert.equal(health.statusCode, 200, `gateway must report ready after ports:bound (got ${health.statusCode}: ${health.body})`);

    // Drive 17 real proxied requests. The transition is evaluated on resolve()
    // at request start, so the 17th request observes the window filled by the
    // first 16 completed outcomes (>= MIN_SAMPLES, >= 16 completed, <= 15%
    // pressure). A promote additionally needs AUTO_SWITCH_CONFIRMATIONS
    // consecutive agreeing evaluations, so 19 requests are driven (the window is
    // full from the 16th outcome on; the 3 confirmations land after that).
    for (let i = 0; i < 19; i++) {
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

    assert.ok(transition, 'auto must promote day->night after sustained clean real requests (no transition logged => observe() was never fed)');
    assert.equal(transition.selected, 'auto');
    assert.equal(transition.previousEffective, 'day');
  } finally {
    await stopChild(child);
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('performance gateway startup retries a fresh port pair after a classified bind collision', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-retry-'));
  const upstream = http.createServer((_req, res) => res.end('{"ok":true}'));
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let blocker;
  let injected = false;
  try {
    const started = await startPerformanceGateway({
      upstreamPort: upstream.address().port,
      dir,
      beforeSpawn: async (port, attempt) => {
        if (attempt !== 1) return;
        injected = true;
        blocker = http.createServer();
        await new Promise((resolve, reject) => {
          blocker.once('error', reject);
          blocker.listen(port, '127.0.0.1', resolve);
        });
      }
    });
    try {
      assert.equal(injected, true);
      assert.ok(started.attempt >= 2 && started.attempt <= 4);
      assert.equal((await request(started.port, '/health')).statusCode, 200);
    } finally {
      await stopChild(started.child);
    }
  } finally {
    blocker?.closeAllConnections?.();
    if (blocker?.listening) await new Promise((resolve) => blocker.close(resolve));
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

  // 16 completed total (window length 16 >= 10, <= 15% pressure). A switch now
  // also needs AUTO_SWITCH_CONFIRMATIONS (3) consecutive agreeing evaluations;
  // each observe() below starts a fresh evaluation with the window unchanged.
  for (let i = 0; i < 7; i++) resolver.observe('completed');
  assert.equal(resolver.resolve().effective, 'day', 'evaluation #1 of a clean window: not yet');
  resolver.observe('completed');
  assert.equal(resolver.resolve().effective, 'day', 'evaluation #2: not yet');
  resolver.observe('completed');
  // First-ever switch is exempt from the dwell (lastAutoSwitchAt is -Infinity).
  assert.equal(resolver.resolve().effective, 'night', '16 completed + confirmed evaluations promote day->night');
  assert.equal(transitions.length, 1, 'exactly one transition must be announced');
  assert.equal(transitions[0].selected, 'auto');
  assert.equal(transitions[0].effective, 'night');
  assert.equal(transitions[0].previousEffective, 'day');
  assert.equal(transitions[0].completed, 18);

  // Demote signal present but dwell (600s) not elapsed => stays night. Four
  // first-byte timeouts meet the bar; the three evaluations below accumulate the
  // confirmation streak but are held back by the dwell, so the mode stays night.
  for (let i = 0; i < 4; i++) resolver.observe('first_byte_timeout');
  // A confirmation counts only for a CHANGED window, so each one below follows a
  // fresh outcome.
  assert.equal(resolver.resolve().effective, 'night', 'dwell blocks an immediate demote at t=0');
  resolver.observe('first_byte_timeout');
  assert.equal(resolver.resolve().effective, 'night', 'confirmation #2, still held by the dwell');
  resolver.observe('first_byte_timeout');
  assert.equal(resolver.resolve().effective, 'night', 'confirmation #3, still held by the dwell');
  nowMs = 599_999;
  assert.equal(resolver.resolve().effective, 'night', 'dwell blocks a demote 1ms early');
  // The evidence is already sustained (3 agreeing evaluations); the moment the
  // dwell elapses the held-back demote commits on the next evaluation.
  nowMs = 600_000;
  assert.equal(resolver.resolve().effective, 'day', '4 first-byte timeouts demote once the 600s dwell elapses');
  assert.equal(transitions.length, 2);
  assert.equal(transitions[1].effective, 'day');
  assert.equal(transitions[1].previousEffective, 'night');

  fs.rmSync(dir, { recursive: true, force: true });

  // Pressure-ratio demote: below 40% holds night, at 40% (with confirmation) demotes.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-perf-auto-'));
  const configPath2 = writeConfig(dir, 'auto');
  let now2 = 0;
  const resolver2 = createPerformanceModeResolver({ configPath: configPath2, env: {}, now: () => now2 });
  for (let i = 0; i < 20; i++) resolver2.observe('completed');
  resolver2.resolve(); resolver2.observe('completed');
  resolver2.resolve(); resolver2.observe('completed');
  assert.equal(resolver2.resolve().effective, 'night', 'promote first (clean window)');
  now2 = 600_000; // past dwell so the next decide can take effect
  // 7/20 pressure (35%) is below the 40% bar and under 4 first-byte timeouts.
  for (let i = 0; i < 7; i++) resolver2.observe('idle_timeout');
  resolver2.resolve(); resolver2.resolve();
  assert.equal(resolver2.resolve().effective, 'night', '7/20 pressure (35%) must hold night');
  // 8/20 (40%) meets the bar; the dwell has already elapsed, so the sustained
  // state is confirmed by the further evaluations below (the 35% streak was
  // reset when the window crossed the bar).
  resolver2.observe('idle_timeout');
  resolver2.resolve();
  resolver2.observe('idle_timeout');
  assert.equal(resolver2.resolve().effective, 'night', 'evaluation #2 of the sustained >=40% window');
  resolver2.observe('idle_timeout');
  assert.equal(resolver2.resolve().effective, 'day', '>=40% pressure demotes to day after confirmation');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Test 3: env-override boundaries on the resolver ──

test('env overrides: stream and failover clamp to documented bounds while fbt/idle reject out-of-range', () => {
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

  // Failover attempts: numeric values clamp into 1..64; malformed falls back.
  assert.equal(resolveWith({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '0' }).maxFailoverAttempts, 1);
  assert.equal(resolveWith({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '9' }).maxFailoverAttempts, 9);
  assert.equal(resolveWith({ GATEWAY_MAX_FAILOVER_ATTEMPTS: String(Number.MAX_SAFE_INTEGER) }).maxFailoverAttempts, 64);
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

async function startPerformanceGateway({ upstreamPort, dir, beforeSpawn, configPath, logPath, keyRecords }) {
  return startGatewayOnReservedPort({ maxAttempts: 4, readinessTimeoutMs: 20_000, async spawnChild(port, attempt) {
    await beforeSpawn?.(port, attempt);
    const child = spawn(process.execPath, ['--require', path.join(repoRoot, 'tests', 'local-upstream-preload.cjs'), path.join(repoRoot, 'src', 'gateway', 'server.mjs')], {
      env: {
        ...process.env,
        GATEWAY_LOG_PATH: logPath ?? path.join(dir, 'gateway.jsonl'),
        GATEWAY_CONFIG_PATH: configPath ?? writeConfig(dir, 'day'),
        GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstreamPort),
        PORT: String(port)
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('message', (message) => {
      if (message?.type === 'ready') child.send({
        type: 'state:init', challenge: message.challenge,
        state: {
          keys: keyRecords ?? [{ id: '00000000-0000-4000-8000-000000000001', key: 'retry-key', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 1 } }],
          credentials: { gatewayToken: 'test-gateway-token', adminToken: 'test-admin-token' }
        }
      });
    });
    return child;
  } });
}

function waitForMessage(child, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for gateway ports:bound`));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`gateway exited before ports:bound (code=${code}, signal=${signal ?? 'none'})`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener('message', onMessage);
      child.removeListener('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

function formatChildDiagnostics(stdoutChunks, stderrChunks) {
  const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
  const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
  return `\nchild stdout: ${stdout || '<empty>'}\nchild stderr: ${stderr || '<empty>'}`;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 1_000);
    child.once('exit', () => { clearTimeout(force); resolve(); });
    child.kill();
  });
}
