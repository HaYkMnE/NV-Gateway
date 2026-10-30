/**
 * W1b production auto-restart wiring test (Level-1 fix wave, pass 2, defect 1).
 *
 * `GatewayLifecycle` gained a bounded auto-restart, but the PRODUCTION call site
 * in src/main/index.ts never passed `autoRestart`, so `scheduleAutoRestart`
 * returned immediately at its first guard and the whole recovery path was DEAD
 * CODE in the shipped app: a crashed gateway child was diagnosed (exit 1,
 * RUNTIME_EXIT) and then stayed dead until the user clicked retry.
 *
 * BEHAVIOURAL, NOT TEXTUAL. This test does not grep for `autoRestart`. It runs
 * the REAL production object literal from `initializeGatewayLifecycle` against a
 * stubbed `GatewayLifecycle` constructor and inspects the options that were
 * actually handed over, then drives a REAL `GatewayLifecycle` built from THOSE
 * options through a genuine crash to prove the restart is reachable.
 *
 * No Electron, no network: the child double completes the real attestation
 * handshake on a reserved loopback port pair.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';
import { reservePortPair } from './support/paired-port-allocation.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-w1c-restart-${process.pid}-`));
const reservations = [];

test.after(async () => {
  for (const reservation of reservations) {
    if (typeof reservation?.release === 'function') await reservation.release();
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Structural helpers. Comments and string contents are masked so a mention in a
// comment can never pose as the wiring; the value is then read out of the REAL
// construct.
// ---------------------------------------------------------------------------

function structuralMask(source) {
  const out = source.split('');
  let mode = 'code';
  let i = 0;
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (mode === 'line') { if (c === '\n') { mode = 'code'; i += 1; continue; } blank(i, i + 1); i += 1; continue; }
    if (mode === 'block') {
      if (c === '*' && next === '/') { blank(i, i + 2); mode = 'code'; i += 2; continue; }
      blank(i, i + 1); i += 1; continue;
    }
    if (mode === '"' || mode === "'" || mode === '`') {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === mode) { mode = 'code'; i += 1; continue; }
      blank(i, i + 1); i += 1; continue;
    }
    if (c === '/' && next === '/') { blank(i, i + 2); mode = 'line'; i += 2; continue; }
    if (c === '/' && next === '*') { blank(i, i + 2); mode = 'block'; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { mode = c; i += 1; continue; }
    i += 1;
  }
  return out.join('');
}

function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** The `{...}` options object of the (single) production `new GatewayLifecycle(`. */
function lifecycleOptionsObject(source) {
  const masked = structuralMask(source);
  const at = masked.indexOf('new GatewayLifecycle(');
  assert.ok(at >= 0, 'src/main/index.ts must construct a GatewayLifecycle');
  let open = at + 'new GatewayLifecycle('.length;
  while (open < masked.length && /\s/.test(masked[open])) open += 1;
  assert.equal(masked[open], '{', 'GatewayLifecycle must be constructed with an object literal');
  const close = matchBrace(masked, open);
  assert.ok(close > open, 'the GatewayLifecycle options object must be balanced');
  return source.slice(open, close + 1);
}

// ---------------------------------------------------------------------------
// The production literal, executed. Every identifier it closes over is stubbed
// with the same shape the real code provides; the object it returns is the
// object the real GatewayLifecycle would receive.
// ---------------------------------------------------------------------------
function productionLifecycleOptions() {
  const optionsText = lifecycleOptionsObject(read('src/main/index.ts'));
  // TypeScript-only syntax (a typed arrow parameter) is transpiled away; the
  // RUNTIME value is what matters here.
  const compiled = typescript.transpileModule(`(function () { return (${optionsText}); })`, {
    compilerOptions: { target: typescript.ScriptTarget.ES2020, module: typescript.ModuleKind.None }
  }).outputText;
  const sandbox = {
    process,
    path,
    fs,
    app: { getPath: () => tempRoot },
    crypto: { randomBytes: () => Buffer.alloc(32) },
    persistChain: Promise.resolve(),
    persistChildProjection: () => {},
    withGatewayModelLimits: (state) => state,
    secureState: { keys: [] },
    gatewayRuntime: {
      statePath: path.join(tempRoot, 'keys.json'),
      configPath: path.join(tempRoot, 'config.json'),
      logPath: path.join(tempRoot, 'gateway.jsonl'),
      appLogPath: path.join(tempRoot, 'app.jsonl'),
      stdioLogPath: path.join(tempRoot, 'gateway-stdio.jsonl'),
      ownerPath: path.join(tempRoot, 'gateway-owner.json')
    },
    serverPath: path.join(root, 'src', 'gateway', 'server.mjs'),
    spawn: () => { throw new Error('not spawned here'); },
    mainWindow: null,
    updateTray: () => {},
    sendGatewayStatus: () => {},
    logAppEvent: () => {},
    logError: () => {},
    migrationPhaseAudit: { emit: () => {} },
    initAppLogger: () => {},
    setRuntimeSecrets: () => {},
    secureStore: { persist: () => {} },
    credentials: { gatewayToken: 'fixture-gateway-token', adminToken: 'fixture-admin-token' },
    acl: { protectFile: () => {} }
  };
  return vm.runInNewContext(compiled, sandbox, { filename: 'src/main/index.ts#GatewayLifecycle' })();
}

test('defect 1: the PRODUCTION GatewayLifecycle is constructed with a bounded autoRestart', () => {
  const options = productionLifecycleOptions();
  assert.ok(options.autoRestart && typeof options.autoRestart === 'object',
    'production must pass autoRestart; without it scheduleAutoRestart returns at its first guard '
    + 'and the crash-recovery path is dead code in the shipped app');
  const { maxAttempts, baseDelayMs, maxDelayMs, stableUptimeMs } = options.autoRestart;
  assert.equal(Number.isSafeInteger(maxAttempts) && maxAttempts > 0 && maxAttempts <= 10, true,
    `maxAttempts must be a small positive bound (no infinite loop), got ${JSON.stringify(maxAttempts)}`);
  assert.equal(Number.isSafeInteger(baseDelayMs) && baseDelayMs > 0, true,
    `baseDelayMs must be a real backoff, got ${JSON.stringify(baseDelayMs)}`);
  assert.equal(Number.isSafeInteger(maxDelayMs) && maxDelayMs >= baseDelayMs, true,
    `maxDelayMs must cap the exponential growth, got ${JSON.stringify(maxDelayMs)}`);
  assert.equal(Number.isSafeInteger(stableUptimeMs) && stableUptimeMs > 0, true,
    `stableUptimeMs must be a real stability window, got ${JSON.stringify(stableUptimeMs)}`);
});

// ---------------------------------------------------------------------------
// Reachability: build a REAL GatewayLifecycle from THOSE production options and
// crash it. This is the property the dead-code defect broke.
// ---------------------------------------------------------------------------

function attestableChild({ port }) {
  const child = new EventEmitter();
  const servers = [];
  const challenge = 'w1c-child-challenge-0123456789';
  let bound = false;
  child.pid = 7000 + (port % 1000);
  child.exitCode = null;
  child.killed = false;
  child.connected = true;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; return true; };
  child.send = (message, callback) => {
    if (message?.type !== 'state:init' || bound) return;
    bound = true;
    callback?.(null);
    const gateway = http.createServer((_req, res) => { res.writeHead(200); res.end('{}'); });
    const admin = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    servers.push(gateway, admin);
    gateway.on('error', () => {});
    admin.on('error', () => {});
    gateway.listen(port, '127.0.0.1', () => admin.listen(port + 1, '127.0.0.1', () => {
      child.emit('message', { type: 'ports:bound', challenge, gatewayPort: port, adminPort: port + 1 });
    }));
  };
  child.emitReady = () => child.emit('message', { type: 'ready', challenge });
  child.crash = async () => {
    if (child.exitCode !== null) return;
    await Promise.all(servers.map((server) => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })));
    child.exitCode = 1;
    child.connected = false;
    child.emit('exit', 1, null);
  };
  return child;
}

async function freePort() {
  const candidates = Array.from({ length: 200 }, (_, offset) => 21_000 + ((process.pid + offset) % 30_000));
  const reservation = await reservePortPair({ candidatePorts: candidates, maxAttempts: candidates.length });
  reservations.push(reservation);
  return reservation.port;
}

test('defect 1: a crash under the PRODUCTION options is actually recovered (not terminal)', async () => {
  const { GatewayLifecycle } = await import(pathToFileURL(path.join(root, 'build', 'src', 'main', 'gateway-lifecycle.js')).href);
  const { ensureGatewayRuntime } = await import(pathToFileURL(path.join(root, 'build', 'src', 'main', 'gateway-runtime.js')).href);
  const production = productionLifecycleOptions();
  const port = await freePort();
  const runtime = ensureGatewayRuntime(path.join(tempRoot, `restart-${Date.now()}`));
  const events = [];
  const children = [];

  const instance = new GatewayLifecycle({
    executablePath: process.execPath,
    serverPath: path.join(root, 'src', 'gateway', 'server.mjs'),
    runtimePaths: runtime,
    spawnChild: () => {
      const child = attestableChild({ port });
      children.push(child);
      setImmediate(() => child.emitReady());
      return child;
    },
    initialState: { keys: [], credentials: { gatewayToken: 'fixture-gateway-token', adminToken: 'fixture-admin-token' } },
    startupTimeoutMs: 1_000,
    healthPollIntervalMs: 5,
    // THE POINT OF THIS TEST: the options production actually passes.
    autoRestart: { ...production.autoRestart, baseDelayMs: 0, maxDelayMs: 0 },
    onLifecycleEvent: (event, data) => events.push({ event, data })
  });

  try {
    assert.deepEqual(await instance.start(port), { state: 'running', port });
    await children[0].crash();
    for (let i = 0; i < 300 && children.length < 2; i += 1) await delay(10);
    assert.equal(children.length, 2,
      'the production autoRestart options must let a crashed child be replaced; a dead-code wiring '
      + 'leaves the app dead until the user clicks retry');
    for (let i = 0; i < 300 && instance.getStatus().state !== 'running'; i += 1) await delay(10);
    assert.equal(instance.getStatus().state, 'running', 'the replacement must reach running');
    assert.equal(events.filter((entry) => entry.event === 'gateway_restart_scheduled').length, 1);
  } finally {
    await instance.stop();
    for (const child of children) await child.crash();
  }
});
