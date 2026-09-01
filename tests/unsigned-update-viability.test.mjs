import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');

// ───────────────────────────────────────────────────────────────────────────
// UNSIGNED AUTO-UPDATE VIABILITY
//
// The owner has decided there will be NO code-signing certificate, ever. That
// makes one question load-bearing for every future release: does electron-updater
// ACCEPT an installer with no Authenticode signature, or does it refuse it and
// break updates for every user, silently, forever?
//
// MEASURED ANSWER: it accepts. Read out of the installed dependencies rather than
// believed, and the two halves have to be read together:
//
//   1. PACKAGE TIME — app-builder-lib 24.13.3
//      out/publish/PublishManager.js:202-208
//        if (packager.platform === Platform.WINDOWS && publishConfig.publisherName == null) {
//          const publisherName = winPackager.isForceCodeSigningVerification
//            ? await winPackager.computedPublisherName.value : undefined;
//          if (publisherName != null) { publishConfig.publisherName = publisherName; }
//        }
//      out/winPackager.js:27-28
//        get isForceCodeSigningVerification() {
//          return this.platformSpecificBuildOptions.verifyUpdateCodeSignature !== false; }
//      out/winPackager.js:79-89 (computedPublisherName)
//        win.publisherName unset -> falls through to lazyCertInfo -> cscInfo.
//      out/winPackager.js:90-107 + 32-76 (cscInfo)
//        no certificateSubjectName, no certificateSha1, no certificateFile and no
//        WIN_CSC_LINK/CSC_LINK -> Promise.resolve(null) -> certInfo null
//        -> computedPublisherName returns NULL -> publisherName is NEVER BAKED.
//
//      So `verifyUpdateCodeSignature` defaulting to ON is a RED HERRING here: it is
//      true, it is consulted, and it still bakes nothing, because with no
//      certificate there is no publisher name to bake.
//
//   2. RUN TIME — electron-updater 6.8.9
//      out/NsisUpdater.js:84-100
//        async verifySignature(tempUpdateFile) {
//          publisherName = (await this.configOnDisk.value).publisherName;
//          if (publisherName == null) { return null; }        // <- taken
//          ...
//          return await this._verifyUpdateCodeSignature(...); }
//      out/NsisUpdater.js:52-57
//        const signatureVerificationStatus = await this.verifySignature(destinationFile);
//        if (signatureVerificationStatus != null) { throw newError(... ERR_UPDATER_INVALID_SIGNATURE) }
//      null means "nothing wrong", so the throw is not reached and PowerShell's
//      Get-AuthenticodeSignature is never even spawned.
//
// NOTHING HAD TO BE CHANGED to make unsigned updates work. This file exists
// because the property is FRAGILE, not because it is broken: a single
// `publisherName:` under `win:`, or a WIN_CSC_LINK appearing in CI, flips a
// working updater into one that throws ERR_UPDATER_INVALID_SIGNATURE on every
// download — after the bytes are fetched, so the user sees a failed update rather
// than no update.
//
// The assertions below therefore drive the REAL installed electron-updater rather
// than asserting on text. A comment cannot notice a dependency bump; this can.
// ───────────────────────────────────────────────────────────────────────────

/** Exactly the document electron-builder bakes for this project (see verify-baked-update-feed.mjs). */
const BAKED_FEED_WITHOUT_PUBLISHER = Object.freeze({
  provider: 'github',
  owner: 'HaYkMnE',
  repo: 'NV-Gateway-releases',
  releaseType: 'release',
  updaterCacheDirName: 'nv-gateway-updater'
});

/**
 * A real NsisUpdater whose only stubs are the two seams a unit test must own:
 * the on-disk config and the PowerShell verifier. `verifySignature` itself is the
 * dependency's own unmodified code.
 */
function nsisUpdaterWithConfig(document) {
  const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
  const updater = Object.create(NsisUpdater.prototype);
  const calls = [];
  updater.configOnDisk = { value: Promise.resolve(document) };
  updater._verifyUpdateCodeSignature = (publisherNames, file) => {
    calls.push({ publisherNames, file });
    // Stand in for "PowerShell looked and found no valid signature": the real
    // verifier resolves a non-null STRING to report a failure.
    return Promise.resolve('stub: no signature present');
  };
  return { updater, calls };
}

test('electron-updater 6.8.9 ACCEPTS an unsigned installer when no publisherName is baked', async () => {
  const { updater, calls } = nsisUpdaterWithConfig({ ...BAKED_FEED_WITHOUT_PUBLISHER });

  const status = await updater.verifySignature('C:\\Temp\\NV-Gateway-Setup-0.1.0.exe');

  // null is electron-updater's "nothing wrong" value; NsisUpdater.js:53 throws
  // ERR_UPDATER_INVALID_SIGNATURE only when this is non-null.
  assert.equal(status, null,
    'a baked feed without publisherName must produce NO signature complaint, or every unsigned update throws ERR_UPDATER_INVALID_SIGNATURE after downloading');
  assert.deepEqual(calls, [],
    'the Authenticode verifier must never even be invoked without a baked publisherName');
});

test('a MISSING app-update.yml is also not a signature failure (the ENOENT branch)', async () => {
  // NsisUpdater.js:92-97 swallows ENOENT and returns null. Worth pinning: it is
  // the reason a --dir/dev build does not report a bogus signature error. It is
  // NOT a substitute for the baked feed — scripts/verify-baked-update-feed.mjs
  // owns that, because an absent feed means no updates are ever FOUND.
  const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
  const updater = Object.create(NsisUpdater.prototype);
  updater.configOnDisk = { value: Promise.reject(enoent) };
  updater._verifyUpdateCodeSignature = () => Promise.resolve('must not be called');

  assert.equal(await updater.verifySignature('C:\\Temp\\Setup.exe'), null);
});

test('the acceptance above is NOT vacuous: a baked publisherName DOES gate the installer', async () => {
  // Without this, the first test would pass just as happily against a stub that
  // never verifies anything. This proves the refusal path is live in 6.8.9, and
  // therefore that adding publisherName is exactly what would break unsigned
  // updates.
  const { updater, calls } = nsisUpdaterWithConfig({
    ...BAKED_FEED_WITHOUT_PUBLISHER,
    publisherName: ['CN=Some Publisher, O=Some Org, C=US']
  });

  const status = await updater.verifySignature('C:\\Temp\\NV-Gateway-Setup-0.1.0.exe');

  assert.notEqual(status, null,
    'with a baked publisherName an unsigned installer MUST be reported — if not, this whole file is measuring nothing');
  assert.equal(calls.length, 1, 'the Authenticode verifier must run when a publisherName is baked');
  assert.deepEqual(calls[0].publisherNames, ['CN=Some Publisher, O=Some Org, C=US']);

  // And a bare string is normalised to an array (NsisUpdater.js:99), so the
  // single-string spelling is gated identically.
  const single = nsisUpdaterWithConfig({ ...BAKED_FEED_WITHOUT_PUBLISHER, publisherName: 'CN=Some Publisher' });
  assert.notEqual(await single.updater.verifySignature('C:\\Temp\\Setup.exe'), null);
  assert.deepEqual(single.calls[0].publisherNames, ['CN=Some Publisher']);
});

// ───────────────────────────────────────────────────────────────────────────
// The packaging side: keep the inputs that would start baking a publisherName
// out of the build. Structural (parsed YAML), not substring — a commented-out
// `publisherName:` must not trip this, and a real one must not hide behind
// quoting.
// ───────────────────────────────────────────────────────────────────────────

/** Every config key that makes computedPublisherName resolve to a non-null value. */
const PUBLISHER_BAKING_KEYS = Object.freeze([
  'publisherName',        // baked verbatim, no certificate needed
  'certificateFile',      // -> cscInfo -> getCertInfo -> commonName
  'certificateSubjectName', // -> getCertificateFromStoreInfo -> subject CN
  'certificateSha1'       // ditto
]);

test('electron-builder.yml declares nothing that would bake a publisherName', () => {
  const config = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));

  for (const key of PUBLISHER_BAKING_KEYS) {
    assert.equal(Object.hasOwn(config.win ?? {}, key), false,
      `win.${key} would give app-builder-lib a publisher name to bake into app-update.yml (winPackager.js:79-107), and electron-updater would then REFUSE every unsigned installer with ERR_UPDATER_INVALID_SIGNATURE. There is no signing certificate for this product.`);
    // The same keys are honoured at top level as build-wide defaults.
    assert.equal(Object.hasOwn(config, key), false,
      `top-level ${key} reaches the Windows packager the same way win.${key} does`);
  }

  // Also pin the publish block that produces the feed this updater reads, so a
  // publisherName cannot arrive pre-baked through publish config either
  // (PublishManager.js:202 only computes one when publishConfig.publisherName is null).
  const [publish] = Array.isArray(config.publish) ? config.publish : [config.publish];
  assert.equal(Object.hasOwn(publish ?? {}, 'publisherName'), false,
    'a publisherName set directly on the publish config is baked verbatim and bypasses the certificate check entirely');
});

test('no workflow supplies a code-signing certificate through the environment', () => {
  // WIN_CSC_LINK / CSC_LINK are read straight from process.env
  // (platformPackager.js:75-78 getCscLink), so a certificate can enter the build
  // without electron-builder.yml changing at all — and would silently start
  // baking publisherName, breaking updates for everyone already installed.
  const directory = path.join(root, '.github', 'workflows');
  const files = fs.readdirSync(directory).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, 'expected workflow files to audit');

  for (const name of files) {
    const text = fs.readFileSync(path.join(directory, name), 'utf8');
    // Comment-stripped so documentation about these names is not a failure.
    const executable = text.split('\n')
      .map((line) => line.replace(/(^|\s)#.*$/, ''))
      .join('\n');
    for (const variable of ['WIN_CSC_LINK', 'CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_KEY_PASSWORD']) {
      assert.equal(new RegExp(`\\b${variable}\\b`).test(executable), false,
        `.github/workflows/${name} references ${variable}; a certificate reaching the packager makes app-builder-lib bake a publisherName, and every unsigned update then fails at ERR_UPDATER_INVALID_SIGNATURE`);
    }
  }
});

// ───────────────────────────────────────────────────────────────────────────
// MEASURED NEUTRALISATION of the baked-feed guard, closed here.
//
// scripts/verify-baked-update-feed.mjs is the gate that stops a build which
// cannot auto-update from being published. `|| true`, `if: always()`, uploading
// from another job and job-level continue-on-error were all closed on it.
//
// Its `main()` nonetheless resolved the directory it inspects from
// NVGW_PACKAGE_OUTPUT_DIRECTORY — a test seam. Pointing that at any directory
// holding a hand-written win-unpacked/resources/app-update.yml made the guard
// validate THAT file and exit 0 while the real dist/ carried no feed at all.
// Measured against this repo's own dist/ before the fix:
//
//   $env:NVGW_PACKAGE_OUTPUT_DIRECTORY = "C:\OPENCODE-SANDBOX\nvgw-poc"
//   node scripts/verify-baked-update-feed.mjs
//   [verify-baked-update-feed] baked update feed: github.com/HaYkMnE/NV-Gateway-releases ...
//   EXIT=0
//
// One workflow-level `env:` entry, no guard step touched, every existing wiring
// test still green. `main()` now resolves dist/ itself. Asserted BEHAVIOURALLY by
// running the real script, because a textual assertion is what was evaded before.
// ───────────────────────────────────────────────────────────────────────────

test('the baked-feed guard cannot be redirected away from dist/ by NVGW_PACKAGE_OUTPUT_DIRECTORY', () => {
  // A throwaway root: scripts/ only, so its dist/ is absent exactly like a build
  // whose packaging produced no app-update.yml. Same fixture pattern as
  // tests/release-target-wiring-integrity.test.mjs.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-feed-override-${process.pid}-`));
  try {
    fs.mkdirSync(path.join(directory, 'scripts'), { recursive: true });
    for (const file of ['verify-baked-update-feed.mjs', 'packaging-env-guard.mjs']) {
      fs.copyFileSync(path.join(root, 'scripts', file), path.join(directory, 'scripts', file));
    }
    // js-yaml must resolve from the copy.
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'junction');

    // A decoy that is PERFECTLY VALID, so the only thing that can fail the guard
    // is refusing to look here at all.
    const decoy = path.join(directory, 'decoy');
    fs.mkdirSync(path.join(decoy, 'win-unpacked', 'resources'), { recursive: true });
    fs.writeFileSync(
      path.join(decoy, 'win-unpacked', 'resources', 'app-update.yml'),
      yaml.dump(BAKED_FEED_WITHOUT_PUBLISHER),
      'utf8'
    );

    const result = spawnSync(process.execPath, [path.join(directory, 'scripts', 'verify-baked-update-feed.mjs')], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        NVGW_GH_OWNER: 'HaYkMnE',
        NVGW_GH_REPO: '',
        NVGW_PACKAGE_OUTPUT_DIRECTORY: decoy
      }
    });

    assert.notEqual(result.status, 0,
      `the guard accepted a feed from NVGW_PACKAGE_OUTPUT_DIRECTORY while the real dist/ had none — that is a silent-success bypass of the release gate. stdout: ${result.stdout}`);
    assert.match(`${result.stderr}`, /has no win-unpacked[\\/]resources[\\/]app-update\.yml/,
      'the guard must report the absent feed in the REAL packaged output');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the guard still reports the real dist/ correctly when pointed at nothing', () => {
  // Non-vacuous companion to the test above: with no override at all the guard
  // must reach the same verdict about this repo's actual dist/. Running the real
  // script (not the exported function) is the point — main() is what CI invokes.
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify-baked-update-feed.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NVGW_GH_OWNER: 'HaYkMnE', NVGW_GH_REPO: '', NVGW_PACKAGE_OUTPUT_DIRECTORY: '' }
  });

  const feedExists = fs.existsSync(path.join(root, 'dist', 'win-unpacked', 'resources', 'app-update.yml'));
  assert.equal(result.status === 0, feedExists,
    `the guard's verdict must match the real dist/ (app-update.yml present: ${feedExists}). stdout: ${result.stdout} stderr: ${result.stderr}`);
  console.log(`FEED_GUARD_REAL_DIST ok=${result.status === 0} app_update_yml_present=${feedExists}`);
});
