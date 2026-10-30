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

// MASTER-003 regressions: resolveWindowsSid() used to throw straight out of the
// factory (line 26 `options.sid ?? resolveWindowsSid()`) and out of
// buildProtectedAclArgs' default parameter whenever whoami.exe failed or returned
// no SID. index.ts call sites have no try/catch, so a single whoami hiccup crashed
// the Electron main at startup — the exact crash class the icacls degrade path
// (added 2026-08-16) cannot catch because the throw happens BEFORE any icacls run.
// The fixed contract: SID resolution failure degrades to a console.warn no-op,
// mirroring the icacls degrade path (file is already mode 0o600 owner-only).
test('createWindowsAclProtector: failing whoami spawn does NOT throw — degrades to no-op protector (MASTER-003)', async () => {
  const acl = await import(built('windows-acl.js'));
  const calls = [];
  let warned = false;
  const originalWarn = console.warn;
  console.warn = (msg) => { if (String(msg).includes('ACL protector degraded')) warned = true; };
  try {
    const protect = acl.createWindowsAclProtector({
      platform: 'win32',
      // No injected sid: the factory must resolve via whoami — which fails here.
      spawn: () => ({ status: 1, stdout: '' }),
      execute: () => { calls.push('executed'); return { status: 0 }; }
    });
    assert.doesNotThrow(() => protect('C:\\runtime\\keys.json', false), 'degraded protector must NOT throw');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(calls.length, 0, 'degraded protector never executes icacls');
  assert.equal(warned, true, 'degrade path must emit a console.warn');
});

test('createWindowsAclProtector: whoami returning garbage (no SID match) does NOT throw — degrades to no-op protector (MASTER-003)', async () => {
  const acl = await import(built('windows-acl.js'));
  const calls = [];
  let warned = false;
  const originalWarn = console.warn;
  console.warn = (msg) => { if (String(msg).includes('ACL protector degraded')) warned = true; };
  try {
    const protect = acl.createWindowsAclProtector({
      platform: 'win32',
      // whoami succeeds (status 0) but stdout contains no S-1-... SID.
      spawn: () => ({ status: 0, stdout: '"garbage output without any sid"' }),
      execute: () => { calls.push('executed'); return { status: 0 }; }
    });
    assert.doesNotThrow(() => protect('C:\\runtime\\keys.json', false), 'degraded protector must NOT throw');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(calls.length, 0, 'degraded protector never executes icacls');
  assert.equal(warned, true, 'degrade path must emit a console.warn');
});

test('buildProtectedAclArgs: failing whoami does NOT throw — warns and returns empty args (no-op for icacls) (MASTER-003)', async () => {
  const acl = await import(built('windows-acl.js'));
  let warned = false;
  const originalWarn = console.warn;
  console.warn = (msg) => { if (String(msg).includes('ACL args degraded')) warned = true; };
  try {
    let result;
    assert.doesNotThrow(() => {
      result = acl.buildProtectedAclArgs('C:\\runtime\\keys.json', undefined, false, () => ({ status: 1, stdout: '' }));
    }, 'buildProtectedAclArgs must NOT throw when whoami fails');
    assert.deepEqual(result, [], 'degraded buildProtectedAclArgs returns empty args (icacls no-op)');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warned, true, 'degrade path must emit a console.warn');
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
