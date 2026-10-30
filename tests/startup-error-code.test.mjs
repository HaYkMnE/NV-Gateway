// E_STARTUP stderr line carries the bind error CODE (e.g. EADDRINUSE) so a bind
// race is diagnosable from stderr alone. Only the code: err.message may contain
// paths, so it stays in the gateway log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function occupyPort() {
  return new Promise((resolve, reject) => {
    const blocker = net.createServer();
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', () => resolve(blocker));
  });
}

// Upper bound for the whole test: the 20s E_STARTUP timer covers the line, and
// this cap also bounds `await closed` so a child that never closes cannot hang
// the suite.
test('a startup with the public port already bound reports (EADDRINUSE) on stderr, code only', { timeout: 30_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-startup-code-'));
  const blocker = await occupyPort();
  t.after(() => { blocker.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = blocker.address().port;

  const child = spawn(process.execPath, [path.join(root, 'src/gateway/server.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      GATEWAY_LOG_PATH: path.join(dir, 'gateway.jsonl'),
      GATEWAY_CONFIG_PATH: path.join(dir, 'config.json'),
      GATEWAY_STATE_PATH: path.join(dir, 'state.json'),
      GATEWAY_CAPABILITY_CACHE_PATH: path.join(dir, 'capability.json'),
      GATEWAY_MODEL_AFFINITY_CACHE_PATH: path.join(dir, 'affinity.json')
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true
  });
  // Registered right after spawn so it cannot miss a `close` that fires while
  // we are still awaiting the E_STARTUP line (the gateway exits on its own).
  // `close` (not `exit`) fires only after stderr has drained — see
  // tests/paired-port-allocation-close.test.mjs.
  const closed = new Promise((resolve) => child.once('close', resolve));
  let stderr = '';
  const line = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no E_STARTUP line; stderr=${stderr.slice(-500)}`)), 20_000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      const found = stderr.split(/\r?\n/).find((l) => l.includes('[Gateway:E_STARTUP]'));
      if (found) { clearTimeout(timer); resolve(found); }
    });
    child.once('close', () => { clearTimeout(timer); reject(new Error(`exited without E_STARTUP; stderr=${stderr.slice(-500)}`)); });
  });
  child.kill();
  await closed;

  assert.equal(line.trim(), '[Gateway:E_STARTUP] Startup failed (EADDRINUSE)');
  assert.ok(!line.includes(dir) && !/[\\/]/.test(line), 'no path in the stderr line');
  // Consumer contract (tests/support isBindCollision pattern) still matches.
  assert.match(line, /\[Gateway:E_STARTUP\]\s*Startup failed/);
});
