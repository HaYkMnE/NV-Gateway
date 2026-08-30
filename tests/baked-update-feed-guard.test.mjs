import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';
import { APP_UPDATE_FILE, verifyBakedUpdateFeed } from '../scripts/verify-baked-update-feed.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fixturePrefix = `nvgw-baked-feed-${process.pid}-`;

// ───────────────────────────────────────────────────────────────────────────
// The blind spot this guard closes, MEASURED rather than argued:
//
// resources/app-update.yml is the only thing telling electron-updater which
// repository to poll. electron-builder writes it ONLY for an updater-aware
// target — app-builder-lib/out/publish/PublishManager.js:81-84 returns early
// unless a target satisfies isSuitableWindowsTarget (PublishManager.js:361-366:
// nsis, nsis-*, or updater-aware appx).
//
// The CI `Packaged audit` job packages with `--dir`, which produces NO installer
// target, so that job can NEVER observe this file. Verified against a real
// `npm run package:dir` output: dist/win-unpacked/resources/ contained app.asar
// and assets/ only — no app-update.yml.
//
// An absent feed fails SILENTLY: the installer works, the app runs, and update
// checks simply never find anything. The owner's installed build has no
// app-update.yml at all, and nothing ever failed to say so.
// ───────────────────────────────────────────────────────────────────────────

function createFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), fixturePrefix));
}

/** A packaged-output shape whose app-update.yml is `document` (or absent when null). */
function packagedOutput(document) {
  const directory = createFixture();
  const resources = path.join(directory, 'win-unpacked', 'resources');
  fs.mkdirSync(resources, { recursive: true });
  if (document !== null) {
    fs.writeFileSync(
      path.join(resources, 'app-update.yml'),
      typeof document === 'string' ? document : yaml.dump(document),
      'utf8'
    );
  }
  return directory;
}

const OWNER_ENV = { NVGW_GH_OWNER: 'HaYkMnE' };

/** Exactly what electron-builder bakes for this project's publish block. */
const CORRECT_FEED = {
  provider: 'github',
  owner: 'HaYkMnE',
  repo: 'NV-Gateway-releases',
  releaseType: 'release'
};

test('the guard accepts a packaged output whose baked feed is correct', () => {
  const directory = packagedOutput(CORRECT_FEED);
  try {
    const result = verifyBakedUpdateFeed({ root, packageOutputDirectory: directory, env: OWNER_ENV });
    assert.equal(result.ok, true, `expected the correct feed to pass, got: ${result.ok ? '' : result.error}`);
    assert.equal(result.feed, 'HaYkMnE/NV-Gateway-releases');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the guard REFUSES a packaged output with no app-update.yml (the --dir blind spot)', () => {
  // This is the exact shape of a `--dir` build: everything else present, feed absent.
  const directory = packagedOutput(null);
  try {
    const result = verifyBakedUpdateFeed({ root, packageOutputDirectory: directory, env: OWNER_ENV });
    assert.equal(result.ok, false, 'a build that cannot auto-update must never be publishable');
    assert.match(result.error, /has no win-unpacked[\\/]resources[\\/]app-update\.yml/);
    assert.match(result.error, /CANNOT auto-update and must not be published/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the guard REFUSES a baked feed pointing at the wrong repository', () => {
  // The specific regression: redirecting the feed at the source repo abandons every
  // installed copy that polls NV-Gateway-releases.
  for (const [field, value] of [['repo', 'NV-Gateway'], ['owner', 'someone-else'], ['provider', 'generic']]) {
    const directory = packagedOutput({ ...CORRECT_FEED, [field]: value });
    try {
      const result = verifyBakedUpdateFeed({ root, packageOutputDirectory: directory, env: OWNER_ENV });
      assert.equal(result.ok, false, `a baked ${field} of "${value}" must be refused`);
      assert.match(result.error, /does not name the expected update feed/);
      assert.match(result.error, new RegExp(`${field}: expected`));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('the guard REFUSES a baked releaseType that would serve drafts or prereleases', () => {
  for (const releaseType of ['draft', 'prerelease']) {
    const directory = packagedOutput({ ...CORRECT_FEED, releaseType });
    try {
      const result = verifyBakedUpdateFeed({ root, packageOutputDirectory: directory, env: OWNER_ENV });
      assert.equal(result.ok, false, `releaseType "${releaseType}" must be refused`);
      assert.match(result.error, /instead of "release"/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('the guard fails CLOSED on an unparseable or non-mapping app-update.yml', () => {
  for (const [label, body] of [['unparseable', 'provider: [github\n'], ['not a mapping', '- github\n']]) {
    const directory = packagedOutput(body);
    try {
      const result = verifyBakedUpdateFeed({ root, packageOutputDirectory: directory, env: OWNER_ENV });
      assert.equal(result.ok, false, `${label} must not be read as "feed present and fine"`);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('the guard refuses to guess the feed when NVGW_GH_OWNER is absent', () => {
  const directory = packagedOutput(CORRECT_FEED);
  try {
    const result = verifyBakedUpdateFeed({ root, packageOutputDirectory: directory, env: {} });
    assert.equal(result.ok, false);
    assert.match(result.error, /NVGW_GH_OWNER is required/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Wiring: a guard nobody runs is decoration. The release workflow must invoke
// it AFTER packaging (the file does not exist before) and BEFORE either upload
// (a build that cannot auto-update must not become a published release).
// ───────────────────────────────────────────────────────────────────────────

test('release.yml runs the baked-feed guard after packaging and before every upload', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8'));
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);

  const guardAt = steps.findIndex((step) =>
    typeof step.run === 'string' && step.run.includes('scripts/verify-baked-update-feed.mjs'));
  assert.ok(guardAt >= 0, 'release.yml must run scripts/verify-baked-update-feed.mjs');

  const buildAt = steps.findIndex((step) =>
    typeof step.run === 'string' && step.run.includes('build:release'));
  assert.ok(buildAt >= 0, 'release.yml must still build the release');
  assert.ok(guardAt > buildAt,
    'the baked-feed guard must run AFTER packaging — app-update.yml does not exist before it');

  // Every artifact upload must sit after the guard, or a feed-less build could
  // still be published before anyone notices.
  const uploadIndexes = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => typeof step.uses === 'string' && step.uses.includes('action-gh-release'))
    .map(({ index }) => index);
  assert.ok(uploadIndexes.length >= 1, 'release.yml must upload release artifacts');
  for (const uploadAt of uploadIndexes) {
    assert.ok(guardAt < uploadAt,
      'the baked-feed guard must run BEFORE any upload so a feed-less build is never published');
  }

  // Not optional: an `if:` or continue-on-error restores the silent-success mode.
  const guard = steps[guardAt];
  assert.equal('if' in guard, false, 'the baked-feed guard must not be conditional');
  assert.equal('continue-on-error' in guard, false, 'the baked-feed guard must not fail softly');

  // It must resolve the expected feed from the same owner used at package time,
  // and must NOT set NVGW_GH_REPO (that would redirect the baked feed).
  assert.equal(guard.env?.NVGW_GH_OWNER, '${{ github.repository_owner }}',
    'the guard must resolve the expected feed from the packaging owner');
  assert.equal(Object.hasOwn(guard.env ?? {}, 'NVGW_GH_REPO'), false,
    'the guard must not set NVGW_GH_REPO — the baked feed stays on the releases repo');
});

test('the baked-feed guard reports the real packaged output when one exists', { skip: !fs.existsSync(path.join(root, 'dist', 'win-unpacked')) }, (t) => {
  if (!fs.existsSync(path.join(root, 'dist', 'win-unpacked'))) {
    t.skip('the packaged output was removed after this file was loaded');
    return;
  }
  // Non-vacuous against reality: on a --dir build this REPORTS the absence rather
  // than inventing a pass, which is the entire point of the guard.
  const result = verifyBakedUpdateFeed({ root, env: OWNER_ENV });
  console.log(`BAKED_FEED_GUARD_OBSERVED ok=${result.ok} detail=${result.ok ? result.feed : 'app-update.yml absent (expected on a --dir build)'}`);
  assert.equal(typeof result.ok, 'boolean');
});
