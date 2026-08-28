// Phase 4 source-of-the-crash fix test: verify the protector TOLERANT behavior.
// Root cause (2026-08-16): the protector used to `throw new Error("Failed to
// protect runtime ACL.")` whenever icacls.exe exited non-zero, which escaped
// across the bridge to the Electron main and crashed it 5x in production
// (Aug 04/07/12x2/15). The file is already opened mode 0o600 (owner-only)
// before protectFile is called (see src/main/gateway-runtime.ts:133
//    fs.closeSync(fs.openSync(filePath, "a", 0o600));
//    protector.protectFile(filePath);
// ), so the ACL is additional hardening only — degrading is strictly safer
// than crashing the main process. This test pins the new contract.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;

test('createWindowsAclProtector: status 0 returns void unchanged (success path)', async () => {
  const acl = await import(built('windows-acl.js'));
  const calls = [];
  const protect = acl.createWindowsAclProtector({
    sid: '*S-1-5-21-42',
    platform: 'win32',
    execute: (_command, _args) => { calls.push({ status: 0 }); return { status: 0 }; }
  });
  const out = protect('C:\\runtime\\keys.json', false);
  assert.equal(out, undefined, 'successful protectFile returns void');
  assert.equal(calls.length, 1, 'success path executes icacls exactly once');
});

test('createWindowsAclProtector: non-zero status DOES NOT throw — logs warn and degrades (the core fix)', async () => {
  const acl = await import(built('windows-acl.js'));
  let warned = false;
  const originalWarn = console.warn;
  console.warn = (msg) => { if (String(msg).includes('ACL protectFile degraded')) warned = true; };
  try {
    const protect = acl.createWindowsAclProtector({
      sid: '*S-1-5-21-42',
      platform: 'win32',
      execute: () => ({ status: 1 })
    });
    assert.doesNotThrow(() => protect('C:\\runtime\\keys.json', false), 'protector must NOT throw on non-zero icacls status');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warned, true, 'protector must emit a degrade warning instead of throwing');
});

test('createWindowsAclProtector: non-win32 platform is a no-op (early return)', async () => {
  const acl = await import(built('windows-acl.js'));
  const calls = [];
  const protect = acl.createWindowsAclProtector({
    sid: '*S-1-5-21-42',
    platform: 'linux',
    execute: () => { calls.push('executed'); return { status: 0 }; }
  });
  protect('/tmp/runtime/keys.json', false);
  assert.equal(calls.length, 0, 'non-win32 platform skips execute entirely');
});

test('createWindowsAclProtector: retry band — execute called exactly ACL_MAX_ATTEMPTS (2) for persistent status 1', async () => {
  const acl = await import(built('windows-acl.js'));
  const executes = [];
  // Silence the degrade warn so the test output stays clean.
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const protect = acl.createWindowsAclProtector({
      sid: '*S-1-5-21-42',
      platform: 'win32',
      execute: () => { executes.push('exec'); return { status: 1 }; }
    });
    protect('C:\\runtime\\keys.json', false);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(executes.length, 2, 'protector retries up to 2 attempts before degrading');
});
