import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readPerModelFailoverAttempts } from '../src/gateway/performance-mode.mjs';

// The per-model failover cache is module-global and keyed by configPath on its
// fast path, so a transient FS error on config B must never be answered with
// records that were cached while reading a different config A. Keeping
// last-known data is only safe when it is last-known FOR THE SAME PATH —
// otherwise one operator's (or test's) levers silently steer another config.
test('per-model failover cache does not leak across config paths on transient FS error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nv-perf-mode-${process.pid}-`));
  const configA = path.join(dir, 'config-a.json');
  // Path B is never created: statSync(configB) throws (simulated transient error).
  const configB = path.join(dir, 'config-b.json');

  fs.writeFileSync(configA, JSON.stringify({
    perModelSettings: {
      'VendorA/Model-X': { maxFailoverAttempts: 5 }
    }
  }));

  // Prime the module-level cache via config A (case-insensitive key stored).
  assert.equal(readPerModelFailoverAttempts('vendora/model-x', configA), 5);

  // A read against the never-existing config B must report "no override"
  // (null), not plagiarise config A's records just because its stat failed.
  assert.equal(readPerModelFailoverAttempts('vendora/model-x', configB), null);

  // Same-path transient error DOES still serve last-known records for that path.
  fs.rmSync(configA);
  assert.equal(readPerModelFailoverAttempts('vendora/model-x', configA), 5);
});
