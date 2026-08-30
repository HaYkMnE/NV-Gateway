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

test('the guard REFUSES feed fields that are collections instead of scalars', () => {
  // String(['HaYkMnE']) === 'HaYkMnE' — without a type gate, js-yaml hands a
  // one-item list back as an Array and String() flattens it into the EXPECTED
  // value: a structurally odd document would be silently accepted.
  const cases = [
    ['owner as a one-item list', 'provider: github\nowner: [HaYkMnE]\nrepo: NV-Gateway-releases\nreleaseType: release\n'],
    ['repo as a one-item list', 'provider: github\nowner: HaYkMnE\nrepo: [NV-Gateway-releases]\nreleaseType: release\n'],
    ['provider as a one-item list', 'provider: [github]\nowner: HaYkMnE\nrepo: NV-Gateway-releases\nreleaseType: release\n'],
    ['releaseType as a one-item list', 'provider: github\nowner: HaYkMnE\nrepo: NV-Gateway-releases\nreleaseType: [release]\n'],
    ['all four fields as one-item lists', 'provider: [github]\nowner: [HaYkMnE]\nrepo: [NV-Gateway-releases]\nreleaseType: [release]\n'],
    ['owner as a mapping', 'provider: github\nowner: {name: HaYkMnE}\nrepo: NV-Gateway-releases\nreleaseType: release\n'],
    ['releaseType as a multi-item list', 'provider: github\nowner: HaYkMnE\nrepo: NV-Gateway-releases\nreleaseType: [release, draft]\n'],
    ['a wrong value inside a list', 'provider: github\nowner: [someone-else]\nrepo: NV-Gateway-releases\nreleaseType: release\n']
  ];
  for (const [label, body] of cases) {
    const directory = packagedOutput(body);
    try {
      const result = verifyBakedUpdateFeed({ root, packageOutputDirectory: directory, env: OWNER_ENV });
      assert.equal(result.ok, false, `${label} must be refused, not flattened into a passing value`);
      assert.match(result.error, /expected a scalar/, `${label} must fail on the TYPE, not on a coerced value`);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('the guard ACCEPTS unusual-but-valid scalar encodings of the correct feed', () => {
  // Regression shield for the scalar gate above: it must reject COLLECTIONS,
  // not encodings. All of these parse to the correct scalars.
  const correct = 'provider: github\nowner: HaYkMnE\nrepo: NV-Gateway-releases\nreleaseType: release\n';
  const cases = [
    ['extra unexpected keys', correct + 'updaterCacheDirName: nv-gateway-updater\nfutureKey: [1, 2]\n'],
    ['unquoted surrounding whitespace (YAML strips it)', 'provider: github\nowner:   HaYkMnE  \nrepo: NV-Gateway-releases\nreleaseType: release\n'],
    ['an anchor/alias resolving to the right value', 'provider: github\nowner: &o HaYkMnE\nrepo: NV-Gateway-releases\nreleaseType: release\nx-copy: *o\n'],
    ['a UTF-8 BOM', '﻿' + correct],
    ['CRLF line endings', correct.replace(/\n/g, '\r\n')]
  ];
  for (const [label, body] of cases) {
    const directory = packagedOutput(body);
    try {
      const result = verifyBakedUpdateFeed({ root, packageOutputDirectory: directory, env: OWNER_ENV });
      assert.equal(result.ok, true, `${label} must still pass, got: ${result.ok ? '' : result.error}`);
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

  const GUARD_SCRIPT = 'scripts/verify-baked-update-feed.mjs';
  const isGuardStep = (step) => typeof step.run === 'string' && step.run.includes(GUARD_SCRIPT);
  // An upload is anything that PUBLISHES release artifacts: the audited action,
  // or a run: command driving `gh release upload/create`. (Mere mentions —
  // `gh release view/list` — publish nothing and are not uploads.)
  const isUploadStep = (step) =>
    (typeof step.uses === 'string' && step.uses.includes('action-gh-release')) ||
    (typeof step.run === 'string' && /\bgh\s+release\s+(?:upload|create)\b/.test(step.run));
  // Status-check functions that let a step or job run even though something
  // FAILED re-open the silent-success mode. success() is the default and safe.
  const hasBypassCondition = (value) =>
    typeof value === 'string' && /\b(?:always|failure|cancelled)\s*\(/i.test(value);

  // Locate the guard and ITS JOB. Ordering is only meaningful within one job:
  // YAML job order is not execution order — jobs run in parallel absent needs:.
  const guardJobEntry = Object.entries(workflow.jobs)
    .find(([, job]) => (job.steps ?? []).some(isGuardStep));
  assert.ok(guardJobEntry, 'release.yml must run scripts/verify-baked-update-feed.mjs');
  const [guardJobName, guardJob] = guardJobEntry;
  const guardSteps = guardJob.steps ?? [];
  const guardAt = guardSteps.findIndex(isGuardStep);
  const guard = guardSteps[guardAt];

  // The guard's run must be the invocation and NOTHING else. Any shell chaining
  // (`|| true`, `;`, `&&`, a second line ending in `exit 0`) can swallow the
  // guard's exit code while a name search still finds the script. Compared
  // against the PARSED scalar, so quoting/re-indentation of keys stays fine.
  assert.equal(guard.run.trim(), `node ${GUARD_SCRIPT}`,
    'the baked-feed guard must be invoked exactly as `node scripts/verify-baked-update-feed.mjs` — shell chaining can swallow its exit code');

  // Packaging must precede the guard IN THE SAME JOB: app-update.yml exists on
  // that runner's disk only after build:release ran there.
  const buildAt = guardSteps.findIndex((step) =>
    typeof step.run === 'string' && step.run.includes('build:release'));
  assert.ok(buildAt >= 0, `release.yml must still build the release in the guard's job ("${guardJobName}")`);
  assert.ok(guardAt > buildAt,
    'the baked-feed guard must run AFTER packaging — app-update.yml does not exist before it');

  // Every artifact upload must be gated by the guard, or a feed-less build
  // could still be published before anyone notices.
  const uploadJobs = Object.entries(workflow.jobs)
    .map(([name, job]) => ({
      name,
      job,
      uploads: (job.steps ?? [])
        .map((step, index) => ({ step, index }))
        .filter(({ step }) => isUploadStep(step))
    }))
    .filter(({ uploads }) => uploads.length > 0);
  assert.ok(uploadJobs.length >= 1, 'release.yml must upload release artifacts');
  for (const { name, job, uploads } of uploadJobs) {
    for (const { step, index } of uploads) {
      assert.ok(!hasBypassCondition(step.if),
        `upload step "${step.name ?? `#${index}`}" carries always()/failure()/cancelled() — it would publish even after the guard failed`);
      assert.ok(typeof step.uses === 'string' && step.uses.startsWith('softprops/action-gh-release@'),
        `upload step "${step.name ?? `#${index}`}" must publish through the pinned, audited softprops/action-gh-release — ` +
        'an ad-hoc upload path (a fork, a run: command) is not reviewed for fail-closed artifact semantics (fail_on_unmatched_files, repository routing)');
      if (name === guardJobName) {
        assert.ok(guardAt < index,
          'the baked-feed guard must run BEFORE any upload so a feed-less build is never published');
      }
    }
    if (name !== guardJobName) {
      // An upload in ANOTHER job runs in parallel with the guard unless it
      // explicitly needs the guard's job — YAML job order is not execution order.
      const needs = Array.isArray(job.needs) ? job.needs : (job.needs ? [job.needs] : []);
      assert.ok(needs.includes(guardJobName),
        `upload job "${name}" must declare needs: ["${guardJobName}"] — jobs run in parallel, so without it the upload can publish before the guard finishes`);
      assert.ok(!hasBypassCondition(job.if),
        `upload job "${name}" carries always()/failure()/cancelled() at job level — it would publish even after the guard's job failed`);
    }
  }

  // Job-level continue-on-error converts the guard's failure into a green check
  // (and lets needs:-dependent jobs run) exactly as step-level would.
  assert.equal(guardJob['continue-on-error'] ?? false, false,
    `job "${guardJobName}" runs the baked-feed guard, so it must not continue-on-error`);

  // Not optional on the step either: an `if:` or continue-on-error restores the
  // silent-success mode.
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
