// Regression test for the crash trigger in tests/w1b-lifecycle-safety.test.mjs.
//
// MEASURED DEFECT (CodeRabbit deep audit, W-Q wave): the 5a preload armed its
// throw with a fixed `setTimeout(..., 1200)`. That is a wall-clock guess at how
// long the real child needs to bind both paired ports: on a slow CI runner the
// throw can fire BEFORE `ports:bound`, so the harness never sees readiness and
// the test fails for a reason unrelated to what it asserts (the fatal-row +
// non-zero-exit contract). The trigger must be the readiness signal itself.
//
// This file proves the seam in three ways:
//   1. the emitted preload contains NO wall-clock delay and arms on ports:bound;
//   2. an off-contract child that never emits ports:bound never crashes (the old
//      timer would have fired here, which is the race being removed);
//   3. the real child still crashes exactly once, AFTER readiness.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GATEWAY_START_MAX_ATTEMPTS, highPortReservation } from './support/gateway-bind-collision.mjs';
import { startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';

const root = path.resolve(import.meta.dirname, '..');
const lifecycleTestPath = path.join(root, 'tests', 'w1b-lifecycle-safety.test.mjs');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-wq-readiness-${process.pid}-`));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// The 5a helper is not exported (importing the test file would re-register its
// cases in this process), so its source is read and the preload factory is
// extracted and evaluated on its own. A rename therefore fails loudly here
// rather than silently skipping the guarantee.
function loadCrashTriggerPreload() {
  const source = fs.readFileSync(lifecycleTestPath, 'utf8');
  const start = source.indexOf('function crashTriggerPreload(trigger) {');
  assert.ok(start >= 0, 'w1b-lifecycle-safety.test.mjs must keep its crashTriggerPreload factory');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'the factory body must be delimited');
  const body = source.slice(start, end + 3);
  const factory = new Function(`${body}\nreturn crashTriggerPreload;`)();
  return factory;
}

const crashTriggerPreload = loadCrashTriggerPreload();

test('the emitted crash preload arms on ports:bound and carries no wall-clock delay', () => {
  const preload = crashTriggerPreload('throw new Error("boom");');
  assert.match(preload, /message\.type === "ports:bound"/, 'the crash must be armed on the readiness message');
  assert.doesNotMatch(preload, /setTimeout\s*\(\s*\(\)\s*=>/,
    'a fixed wall-clock delay must not be used to arm the crash');
  assert.doesNotMatch(preload, /\b1200\b/, 'the 1200 ms race timer must be gone');
  assert.match(preload, /setImmediate\(\(\) => \{ throw new Error\("boom"\); \}\)/,
    'the trigger must still run exactly as given, once');
});

test('THE REGRESSION: a child that never reaches ports:bound never fires the crash', async () => {
  // Simulates the slow-CI window: the module loads, no readiness message ever
  // arrives. Under the old 1200 ms timer the throw fired here regardless.
  const preloadPath = path.join(tmpRoot, 'no-readiness-preload.cjs');
  fs.writeFileSync(preloadPath, crashTriggerPreload('process.exit(9);'));
  const scriptPath = path.join(tmpRoot, 'no-readiness-child.cjs');
  fs.writeFileSync(scriptPath, [
    "if (typeof process.send === 'function') process.send({ type: 'ready', challenge: 'c' });",
    'setTimeout(() => process.exit(0), 1500);',
    ''
  ].join('\n'));

  const child = spawn(process.execPath, ['--require', preloadPath, scriptPath], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true
  });
  const exitCode = await new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  // Exit 9 is the trigger; exit 0 means the crash never armed without readiness.
  assert.equal(exitCode, 0, 'without ports:bound the crash must stay unarmed (the old timer would have fired)');
});

test('the real child crashes exactly once, only after ports:bound', async () => {
  const preloadPath = path.join(tmpRoot, 'armed-preload.cjs');
  const markerPath = path.join(tmpRoot, 'armed.txt');
  fs.writeFileSync(preloadPath, crashTriggerPreload(
    `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'armed'); throw new Error('boom-after-bound');`
  ));

  const dir = fs.mkdtempSync(path.join(tmpRoot, 'child-'));
  const logPath = path.join(dir, 'readiness.jsonl');
  const statePath = path.join(dir, 'keys.json');
  fs.writeFileSync(statePath, JSON.stringify({
    keys: [{ id: 'key-0', key: 'fake-wq-key', status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 } }]
  }));

  const started = await startGatewayOnReservedPort({
    maxAttempts: GATEWAY_START_MAX_ATTEMPTS,
    reservationOptions: highPortReservation(),
    readinessTimeoutMs: 20_000,
    spawnChild(candidatePort) {
      const child = spawn(process.execPath, ['--require', preloadPath, path.join(root, 'src', 'gateway', 'server.mjs')], {
        env: { ...process.env, GATEWAY_LOG_PATH: logPath, GATEWAY_MAX_FAILOVER_ATTEMPTS: '1', PORT: String(candidatePort) },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true
      });
      child.once('message', (message) => {
        if (message?.type !== 'ready') return;
        child.send({
          type: 'state:init',
          challenge: message.challenge,
          state: {
            keys: JSON.parse(fs.readFileSync(statePath, 'utf8')).keys,
            credentials: { gatewayToken: 'wq-gateway-token', adminToken: 'wq-admin-token' }
          }
        });
      });
      return child;
    }
  });

  const exit = await new Promise((resolve) => {
    if (started.child.exitCode !== null || started.child.signalCode !== null) {
      resolve({ code: started.child.exitCode, signal: started.child.signalCode });
      return;
    }
    started.child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  assert.equal(exit.code, 1, `the armed child must exit non-zero, got ${JSON.stringify(exit)}`);
  // The marker is written by the SAME statement that throws, i.e. after readiness
  // was observed — proof the crash could not have preceded ports:bound.
  assert.equal(fs.readFileSync(markerPath, 'utf8'), 'armed', 'the trigger ran, so readiness had been observed');

  const rows = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const fatal = rows.filter((entry) => entry.message === 'Gateway fatal error');
  assert.equal(fatal.length, 1, 'exactly one fatal row, so the crash fired once (not once per message)');
  assert.equal(fatal[0].kind, 'uncaught_exception');
});

// Guard against the harness silently losing the readiness contract.
test('the 5a helper no longer writes a fixed-delay crash preload', () => {
  const source = fs.readFileSync(lifecycleTestPath, 'utf8');
  assert.doesNotMatch(source, /setTimeout\(\(\) => \{ \$\{trigger\} \}/,
    'the old fixed-delay preload must be gone');
  assert.match(source, /crashTriggerPreload\(trigger\)/, 'the helper must use the readiness-armed factory');
});
