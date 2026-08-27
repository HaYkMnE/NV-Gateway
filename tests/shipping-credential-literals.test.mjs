import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('shipping credential scanner captures buffers, derives every builder payload root', async () => {
  const scanner = await import('../scripts/shipping-credential-scan.mjs');
  const result = scanner.runShippingCredentialScan({ root });
  assert.equal(result.scannedFileCount > 0, true);
  assert.deepEqual(result.scannedRoots, [
    'build/src/main', 'build/src/preload', 'build/renderer', 'package.json',
    'src/gateway', 'src/shared', 'build/assets'
  ]);
  assert.equal(result.testSupportExcluded, true);
});
