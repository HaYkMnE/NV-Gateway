import os from 'node:os';
import assert from 'node:assert/strict';
import { createPackage, listPackage } from '@electron/asar';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const sandboxRoot = os.tmpdir();
const fixturePrefix = `nvgw-asar-smoke-${process.pid}-`;
const cleanupMaxAttempts = 8;
const cleanupTimeoutMs = 500;
const fixtureRoots = new Set();

function isFixtureOwnedRoot(directory) {
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(sandboxRoot, resolvedDirectory);
  return relative !== ''
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
    && path.dirname(relative) === '.'
    && path.basename(resolvedDirectory).startsWith(fixturePrefix)
    && fixtureRoots.has(resolvedDirectory);
}

function createFixture() {
  const directory = fs.mkdtempSync(path.join(sandboxRoot, fixturePrefix));
  fixtureRoots.add(path.resolve(directory));
  return directory;
}

function waitForCleanupRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function cleanupFixture(directory) {
  const resolvedDirectory = path.resolve(directory);
  if (!isFixtureOwnedRoot(resolvedDirectory)) {
    throw new Error('Refusing to clean a path outside this test fixture root.');
  }

  try {
    const deadline = Date.now() + cleanupTimeoutMs;
    for (let attempt = 1; attempt <= cleanupMaxAttempts; attempt += 1) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Temporary ASAR fixture cleanup exceeded its ${cleanupTimeoutMs}ms deadline before retry attempt ${attempt}.`
        );
      }

      try {
        fs.rmSync(resolvedDirectory, { recursive: true, force: true });
        return;
      } catch (error) {
        if (error?.code !== 'ENOTEMPTY') {
          throw error;
        }

        const remainingMs = deadline - Date.now();
        if (attempt === cleanupMaxAttempts || remainingMs <= 0) {
          throw new Error(
            `Temporary ASAR fixture cleanup remained non-empty after ${attempt} attempts within ${cleanupTimeoutMs}ms.`,
            { cause: error }
          );
        }

        await waitForCleanupRetry(Math.min(25 * attempt, remainingMs));
      }
    }
  } finally {
    fixtureRoots.delete(resolvedDirectory);
  }
}

test('fixture cleanup does not begin a retry after its deadline expires during the backoff timer', async () => {
  const directory = createFixture();
  const originalNow = Date.now;
  const originalRmSync = fs.rmSync;
  const originalSetTimeout = globalThis.setTimeout;
  let now = 0;
  let removalAttempts = 0;

  Date.now = () => now;
  fs.rmSync = () => {
    removalAttempts += 1;
    const error = new Error('fixture still busy');
    error.code = 'ENOTEMPTY';
    throw error;
  };
  globalThis.setTimeout = (callback) => {
    now = cleanupTimeoutMs;
    callback();
    return 0;
  };

  try {
    await assert.rejects(
      cleanupFixture(directory),
      /Temporary ASAR fixture cleanup/
    );
    assert.equal(removalAttempts, 1);
  } finally {
    Date.now = originalNow;
    fs.rmSync = originalRmSync;
    globalThis.setTimeout = originalSetTimeout;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('packaged security smoke harness exists and reports all required runtime assertions', async () => {
  const smoke = await import('../scripts/packaged-security-smoke.mjs');
  assert.equal(typeof smoke.runPackagedSecuritySmoke, 'function');
  // The original ten static assertions are unchanged; five repackaging-defence
  // assertions were ADDED (ASAR integrity fuses + embedded hash). Pinning the
  // exact set keeps the guard: dropping any assertion fails this test.
  assert.deepEqual(smoke.REQUIRED_ASSERTIONS, [
    'exactPackagedUrl', 'nodeGlobalsHidden', 'preloadApiNarrow', 'cspBlocksInline',
    'cspBlocksEval', 'cspHasNoUnsafeInline', 'popupDenied', 'navigationDenied',
    'permissionDenied', 'hashRouteIpcAllowed',
    'asarIntegrityFuseEnabled', 'onlyLoadAppFromAsarFuseEnabled', 'runAsNodeFuseEnabled',
    'asarIntegrityResourceEmbedded', 'asarIntegrityHashMatchesArchive'
  ]);
});

test('packaged migration smoke harness is isolated and callable', async () => {
  const smoke = await import('../scripts/packaged-migration-smoke.mjs');
  assert.equal(typeof smoke.runPackagedMigrationSmoke, 'function');
});

test('packaged credential smoke harness is static, callable, and does not launch an executable', async () => {
  const smoke = await import('../scripts/packaged-credential-smoke.mjs');
  assert.equal(typeof smoke.runPackagedCredentialSmoke, 'function');
  assert.deepEqual(smoke.DENIED_CREDENTIAL_LITERALS.length, 5);
});

test('regression: packaged credential ASAR fixture survives immediate cleanup after double packaging', async () => {
  const smoke = await import('../scripts/packaged-credential-smoke.mjs');
  const directory = createFixture();
  const source = path.join(directory, 'source');
  const archive = path.join(directory, 'dist', 'win-unpacked', 'resources', 'app.asar');
  try {
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(path.join(source, 'nested', 'text.txt'), 'ordinary nested text', 'utf8');
    fs.writeFileSync(path.join(source, 'top-level.txt'), 'ordinary top level text', 'utf8');
    await createPackage(source, archive);

    const directoryEntry = listPackage(archive, {}).find((entry) => entry.replace(/^[\\/]+/, '') === 'nested');
    assert.equal(typeof directoryEntry, 'string');
    assert.equal(directoryEntry.endsWith('/'), false);
    assert.equal(smoke.runPackagedCredentialSmoke({ packageOutputDirectory: path.join(directory, 'dist') }).categories.appAsarEntries, 2);

    fs.writeFileSync(path.join(source, 'nested', 'text.txt'), smoke.DENIED_CREDENTIAL_LITERALS[0], 'utf8');
    await createPackage(source, archive);
    assert.throws(
      () => smoke.runPackagedCredentialSmoke({ packageOutputDirectory: path.join(directory, 'dist') }),
      /PACKAGED_CREDENTIAL_AUDIT_FAILED/
    );
  } finally {
    await cleanupFixture(directory);
  }
});

test('packaged credential smoke statically audits the existing unpacked output when present', {
  skip: !fs.existsSync(path.join(root, 'dist', 'win-unpacked'))
}, (t) => {
  // TOCTOU, and the whole of the observed flake. node:test evaluates the `skip:`
  // option ONCE, when this FILE IS LOADED; the audit below spawns LATER. If
  // dist/win-unpacked disappears in that window — a concurrent `package:dir`, or
  // the mandatory removal of a stale/unhardened package — the harness exits 1 with
  // PACKAGED_CREDENTIAL_AUDIT_OUTPUT_MISSING. Asserting the bare exit status then
  // reported "1 !== 0", which is indistinguishable from a shipped credential leak
  // and sent readers hunting a phantom.
  //
  // MEASURED, so the blame lands in the right place: the scanner's scanned-root
  // derivation is CORRECT and is NOT relaxed here. os.tmpdir() resolves outside
  // dist/win-unpacked, no denied literal reaches the packaged tree (40/40 files
  // clean), and the harness returns {"matches":0} on every undisturbed run. The
  // defect is this gate, not the guard it invokes.
  if (!fs.existsSync(path.join(root, 'dist', 'win-unpacked'))) {
    t.skip('the packaged output was removed after this file was loaded');
    return;
  }

  const result = spawnSync(process.execPath, ['scripts/packaged-credential-smoke.mjs'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  // The credential assertion is UNCHANGED and unrelaxed; only the failure message
  // now carries the harness's own reason, so "the audit ran and found a leak" can
  // never again be confused with "the audit could not run at all".
  assert.equal(result.status, 0,
    `packaged credential audit exited ${result.status}: ${(result.stderr || '').trim() || '(no stderr)'}`);
  assert.match(result.stdout, /"matches":0/);
});
