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

const GUARD_SCRIPT = 'scripts/verify-baked-update-feed.mjs';

// Actions REVIEWED as incapable of publishing a GitHub release. Every OTHER
// `uses:` in a release job is treated as publish-capable and must therefore be
// routed and ordered like an upload.
//
// This is fail-CLOSED on purpose, and it is the lesson of a measured defect:
// recognising uploads by PATTERN (`action-gh-release`, `gh release upload`)
// while ENFORCING an allowlist meant any publisher outside the pattern received
// no enforcement at all. Measured — each of these published with the guard
// unable to gate it, while this test stayed green:
//   * ncipollo/release-action@v1 in a parallel job (a real release publisher);
//   * `gh api --method POST /repos/.../releases/1/assets` (no `gh release` text);
//   * `uses: ./.github/actions/upload-release` (a local composite wrapper).
// Enumerating every publisher on the marketplace is impossible, so the polarity
// is inverted: an UNKNOWN action in a release job is a review prompt, not a
// silent pass. Adding one line here is the remedy, and it forces a human to
// confirm the action cannot publish.
// upload-artifact/download-artifact write to the WORKFLOW RUN's artifact store,
// which electron-updater never reads and which cannot create a release — they are
// pre-approved so the commonest safe additions to a release job are not blocked.
const REVIEWED_NON_PUBLISHING_ACTIONS = Object.freeze([
  'actions/checkout@',
  'actions/setup-node@',
  'actions/upload-artifact@',
  'actions/download-artifact@',
  'actions/cache@'
]);
/** The single reviewed publish path: fail_on_unmatched_files + repository routing. */
const APPROVED_PUBLISHER = 'softprops/action-gh-release@';

/**
 * Audit the release workflow's guard wiring and return every problem found.
 *
 * Returned as a list rather than thrown so the same logic can be driven against
 * synthetic bypass shapes in-process, instead of only against the real file.
 *
 * @param {any} workflow Parsed .github/workflows/release.yml.
 * @returns {string[]} Human-readable problems; empty means correctly wired.
 */
function auditReleaseWiring(workflow) {
  const problems = [];
  const jobs = Object.entries(workflow?.jobs ?? {});
  const isGuardStep = (step) => typeof step.run === 'string' && step.run.includes(GUARD_SCRIPT);
  // Status-check functions that let a step or job run even though something
  // FAILED re-open the silent-success mode. success() is the default and safe.
  const hasBypassCondition = (value) =>
    typeof value === 'string' && /\b(?:always|failure|cancelled)\s*\(/i.test(value);
  const isApprovedPublisher = (step) =>
    typeof step.uses === 'string' && step.uses.startsWith(APPROVED_PUBLISHER);
  const isReviewedInert = (step) =>
    typeof step.uses === 'string' &&
    REVIEWED_NON_PUBLISHING_ACTIONS.some((prefix) => step.uses.startsWith(prefix));
  // `gh release <anything>` and a REST asset/release POST both publish. Matching
  // `gh release` broadly (not just upload/create) costs nothing: a read-only
  // `gh release view` in a release job is still worth a human glance.
  const runCanPublish = (step) =>
    typeof step.run === 'string' &&
    (/\bgh\s+release\b/.test(step.run) || /\bgh\s+api\b[^\n]*releases?\b/.test(step.run));
  const isPublishCapable = (step) =>
    isApprovedPublisher(step) || runCanPublish(step) ||
    (typeof step.uses === 'string' && !isReviewedInert(step));

  // Locate the guard and ITS JOB. Ordering is only meaningful within one job:
  // YAML job order is not execution order — jobs run in parallel absent needs:.
  const guardJobEntry = jobs.find(([, job]) => (job?.steps ?? []).some(isGuardStep));
  if (!guardJobEntry) return [`release.yml must run ${GUARD_SCRIPT}`];
  const [guardJobName, guardJob] = guardJobEntry;
  const guardSteps = guardJob.steps ?? [];
  const guardAt = guardSteps.findIndex(isGuardStep);
  const guard = guardSteps[guardAt];

  // The guard's `run` must be ONE command that invokes the script, with no shell
  // chaining or substitution able to swallow its exit code. Arguments are fine —
  // forbidding them would block legitimate maintenance (`--verbose`) without
  // closing any hole. What must never appear: `|| true`, `; exit 0`, a pipeline,
  // a second command line, or a command substitution.
  const runLines = String(guard.run).trim().split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (runLines.length !== 1) {
    problems.push(`the baked-feed guard's run must be a SINGLE command — ${runLines.length} command lines can swallow its exit code (a trailing \`exit 0\` reports success after a failure)`);
  } else {
    const [command] = runLines;
    if (/[&|;`$()<>]/.test(command)) {
      problems.push(`the baked-feed guard's run must not use shell chaining or substitution (found in \`${command}\`) — \`|| true\` and friends swallow its exit code`);
    }
    if (!new RegExp(`^node\\s+${GUARD_SCRIPT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(command)) {
      problems.push(`the baked-feed guard must be invoked as \`node ${GUARD_SCRIPT}\` (optionally with arguments), found \`${command}\``);
    }
  }

  // Packaging must precede the guard IN THE SAME JOB: app-update.yml exists on
  // that runner's disk only after build:release ran there.
  const buildAt = guardSteps.findIndex((step) =>
    typeof step.run === 'string' && step.run.includes('build:release'));
  if (buildAt < 0) problems.push(`release.yml must still build the release in the guard's job ("${guardJobName}")`);
  else if (!(guardAt > buildAt)) {
    problems.push('the baked-feed guard must run AFTER packaging — app-update.yml does not exist before it');
  }

  // Resolve each job's transitive needs: closure. A chain
  // (publish -> gate -> build) genuinely orders publish after the guard, so
  // demanding a DIRECT needs: would block a legitimate refactor. A named job
  // that does not exist contributes nothing, so it still fails.
  const needsOf = (job) => (Array.isArray(job?.needs) ? job.needs : (job?.needs ? [job.needs] : []));
  const jobsByName = new Map(jobs);
  const closureOf = (name) => {
    const seen = new Set();
    const queue = [...needsOf(jobsByName.get(name))];
    while (queue.length > 0) {
      const next = queue.shift();
      if (typeof next !== 'string' || seen.has(next) || !jobsByName.has(next)) continue;
      seen.add(next);
      queue.push(...needsOf(jobsByName.get(next)));
    }
    return seen;
  };

  // Every publish-capable step must be gated by the guard, or a feed-less build
  // could still be published before anyone notices.
  let publishCapableCount = 0;
  for (const [name, job] of jobs) {
    const steps = job?.steps ?? [];
    const candidates = steps.map((step, index) => ({ step, index })).filter(({ step }) => isPublishCapable(step));
    if (candidates.length === 0) continue;
    publishCapableCount += candidates.length;
    for (const { step, index } of candidates) {
      const label = `"${step.name ?? step.uses ?? `#${index}`}" in job "${name}"`;
      if (hasBypassCondition(step.if)) {
        problems.push(`upload step ${label} carries always()/failure()/cancelled() — it would publish even after the guard failed`);
      }
      if (!isApprovedPublisher(step)) {
        problems.push(typeof step.uses === 'string'
          ? `step ${label} uses "${step.uses}", which is neither the approved publisher (${APPROVED_PUBLISHER}) nor a reviewed non-publishing action — an unreviewed action in a release job may publish artifacts the baked-feed guard cannot gate. Either route it through the approved publisher, or add it to REVIEWED_NON_PUBLISHING_ACTIONS once confirmed it cannot publish.`
          : `upload step ${label} publishes through an ad-hoc command instead of the pinned, audited ${APPROVED_PUBLISHER} — an ad-hoc path is not reviewed for fail-closed artifact semantics (fail_on_unmatched_files, repository routing)`);
      }
      if (name === guardJobName && !(guardAt < index)) {
        problems.push(`the baked-feed guard must run BEFORE any upload so a feed-less build is never published (${label})`);
      }
    }
    if (name !== guardJobName) {
      // A publish in ANOTHER job runs in parallel with the guard unless it
      // reaches the guard's job through needs: — directly or transitively.
      const closure = closureOf(name);
      if (!closure.has(guardJobName)) {
        problems.push(`upload job "${name}" must reach needs: ["${guardJobName}"] — jobs run in parallel, so without it the upload can publish before the guard finishes`);
      }
      // A bypass condition ANYWHERE on the chain re-opens the hole: an
      // intermediate `if: always()` lets the publish run after the guard failed.
      for (const link of [name, ...closure]) {
        if (hasBypassCondition(jobsByName.get(link)?.if)) {
          problems.push(`job "${link}" on upload job "${name}"'s needs: chain carries always()/failure()/cancelled() at job level — it would publish even after the guard's job failed`);
        }
      }
    }
  }
  if (publishCapableCount === 0) problems.push('release.yml must upload release artifacts');

  // Job-level continue-on-error converts the guard's failure into a green check
  // (and lets needs:-dependent jobs run) exactly as step-level would.
  if ((guardJob['continue-on-error'] ?? false) !== false) {
    problems.push(`job "${guardJobName}" runs the baked-feed guard, so it must not continue-on-error`);
  }
  // Not optional on the step either: an `if:` or continue-on-error restores the
  // silent-success mode.
  if ('if' in guard) problems.push('the baked-feed guard must not be conditional');
  if ('continue-on-error' in guard) problems.push('the baked-feed guard must not fail softly');

  // It must resolve the expected feed from the same owner used at package time,
  // and must NOT set NVGW_GH_REPO (that would redirect the baked feed). The
  // value may live at step, job or workflow level — GitHub's own precedence is
  // step > job > workflow, and all three are equally effective, so pinning it to
  // the step would block a legitimate hoist to workflow-level env.
  const envLayers = [guard.env, guardJob.env, workflow.env];
  const effective = (key) => {
    for (const layer of envLayers) if (layer && Object.hasOwn(layer, key)) return layer[key];
    return undefined;
  };
  if (effective('NVGW_GH_OWNER') !== '${{ github.repository_owner }}') {
    problems.push('the guard must resolve the expected feed from the packaging owner (NVGW_GH_OWNER: ${{ github.repository_owner }} at step, job or workflow level)');
  }
  if (envLayers.some((layer) => layer && Object.hasOwn(layer, 'NVGW_GH_REPO'))) {
    problems.push('the guard must not set NVGW_GH_REPO at any level — the baked feed stays on the releases repo');
  }
  return problems;
}

test('release.yml runs the baked-feed guard after packaging and before every upload', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8'));
  assert.deepEqual(auditReleaseWiring(workflow), [],
    'release.yml is no longer wired so the baked-feed guard gates every publish');
});

// ───────────────────────────────────────────────────────────────────────────
// The wiring audit is itself mutation-tested. A wiring test that recognises
// only the publishers it already knows about enforces nothing on the others —
// MEASURED: ncipollo/release-action, a `gh api` asset POST and a local
// composite action each published with the guard unable to gate them while the
// previous version of this test stayed green.
// ───────────────────────────────────────────────────────────────────────────

test('the wiring audit CATCHES every way to publish around the guard', () => {
  const guardJobSteps = (extra = []) => [
    { uses: 'actions/checkout@v4' },
    { run: 'npm run build:release' },
    ...extra,
    { run: `node ${GUARD_SCRIPT}`, env: { NVGW_GH_OWNER: '${{ github.repository_owner }}' } },
    { uses: 'softprops/action-gh-release@v2.6.2', with: { files: 'dist/x.exe' } }
  ];
  const wellWired = () => ({ jobs: { 'build-release': { steps: guardJobSteps() } } });
  // Control: the shape the assertions below mutate must itself be clean.
  assert.deepEqual(auditReleaseWiring(wellWired()), [], 'the control workflow must audit clean');

  const PUBLISHERS = [
    ['a different release action', { name: 'p', uses: 'ncipollo/release-action@v1' }],
    ['a gh api asset POST', { name: 'p', run: 'gh api --method POST /repos/o/r/releases/1/assets -f name=x' }],
    ['a local composite action', { name: 'p', uses: './.github/actions/upload-release' }],
    ['a FORK of the approved action', { name: 'p', uses: 'evil-fork/action-gh-release@v2.6.2' }],
    ['the approved action', { name: 'p', uses: 'softprops/action-gh-release@v2.6.2' }],
    ['a gh release upload command', { name: 'p', run: 'gh release upload v1 dist/x.exe' }]
  ];
  for (const [label, publisher] of PUBLISHERS) {
    // (a) publishing in a PARALLEL job the guard cannot gate.
    const parallel = wellWired();
    parallel.jobs['publish-elsewhere'] = { steps: [publisher] };
    assert.notEqual(auditReleaseWiring(parallel).length, 0,
      `${label} in a parallel job must be caught — it publishes before the guard finishes`);
    // (b) publishing BEFORE the guard in the guard's own job.
    const early = { jobs: { 'build-release': { steps: guardJobSteps([publisher]) } } };
    assert.notEqual(auditReleaseWiring(early).length, 0,
      `${label} before the guard must be caught — the feed is unverified at that point`);
  }

  // Neutralisations of the guard step itself.
  const NEUTRALISATIONS = [
    ['|| true swallowing the exit code', (w) => { w.jobs['build-release'].steps[2].run = `node ${GUARD_SCRIPT} || true`; }],
    ['a trailing exit 0', (w) => { w.jobs['build-release'].steps[2].run = `node ${GUARD_SCRIPT}\nexit 0`; }],
    ['a command substitution', (w) => { w.jobs['build-release'].steps[2].run = `node ${GUARD_SCRIPT} $(echo)`; }],
    ['a piped-away failure', (w) => { w.jobs['build-release'].steps[2].run = `node ${GUARD_SCRIPT} | cat`; }],
    ['not invoking node at all', (w) => { w.jobs['build-release'].steps[2].run = `echo ${GUARD_SCRIPT}`; }],
    ['step continue-on-error', (w) => { w.jobs['build-release'].steps[2]['continue-on-error'] = true; }],
    ['a conditional guard', (w) => { w.jobs['build-release'].steps[2].if = 'success()'; }],
    ['job continue-on-error', (w) => { w.jobs['build-release']['continue-on-error'] = true; }],
    ['the guard placed before packaging', (w) => { w.jobs['build-release'].steps.splice(1, 0, w.jobs['build-release'].steps.splice(2, 1)[0]); }],
    ['NVGW_GH_REPO redirecting the expectation', (w) => { w.jobs['build-release'].steps[2].env.NVGW_GH_REPO = 'NV-Gateway'; }],
    ['NVGW_GH_REPO hoisted to workflow level', (w) => { w.env = { NVGW_GH_REPO: 'NV-Gateway' }; }],
    ['a wrong owner expectation', (w) => { w.jobs['build-release'].steps[2].env.NVGW_GH_OWNER = 'someone-else'; }],
    ['always() on the upload step', (w) => { w.jobs['build-release'].steps[3].if = 'always()'; }],
    ['packaging removed entirely', (w) => { w.jobs['build-release'].steps.splice(1, 1); }],
    ['the guard removed entirely', (w) => { w.jobs['build-release'].steps.splice(2, 1); }]
  ];
  for (const [label, mutate] of NEUTRALISATIONS) {
    const workflow = wellWired();
    mutate(workflow);
    assert.notEqual(auditReleaseWiring(workflow).length, 0, `${label} must be caught`);
  }

  // Cross-job bypasses.
  const crossJob = (publishJob) => {
    const workflow = wellWired();
    workflow.jobs['publish-elsewhere'] = { ...publishJob, steps: [{ name: 'p', uses: 'softprops/action-gh-release@v2.6.2' }] };
    return workflow;
  };
  for (const [label, job] of [
    ['no needs: at all', {}],
    ['needs: naming a job that does not exist', { needs: ['nope'] }],
    ['needs: the guard job but job-level always()', { needs: ['build-release'], if: 'always()' }]
  ]) {
    assert.notEqual(auditReleaseWiring(crossJob(job)).length, 0, `a cross-job upload with ${label} must be caught`);
  }
  // An intermediate job with a bypass condition breaks the chain's guarantee.
  const brokenChain = wellWired();
  brokenChain.jobs.gate = { needs: ['build-release'], if: 'always()', steps: [{ run: 'echo ok' }] };
  brokenChain.jobs['publish-elsewhere'] = { needs: ['gate'], steps: [{ uses: 'softprops/action-gh-release@v2.6.2' }] };
  assert.notEqual(auditReleaseWiring(brokenChain).length, 0,
    'a needs: chain whose intermediate job carries always() must be caught');
});

test('the wiring audit ACCEPTS legitimate, safe maintenance edits', () => {
  const base = () => ({
    jobs: {
      'build-release': {
        steps: [
          { uses: 'actions/checkout@v4' },
          { uses: 'actions/setup-node@v4', with: { 'node-version': '20.x' } },
          { run: 'npm run build:release' },
          { run: `node ${GUARD_SCRIPT}`, env: { NVGW_GH_OWNER: '${{ github.repository_owner }}' } },
          { uses: 'softprops/action-gh-release@v2.6.2', if: "startsWith(github.ref, 'refs/tags/')" }
        ]
      }
    }
  });

  const LEGITIMATE = [
    // Pinning to a commit SHA is a SECURITY IMPROVEMENT. A wiring test that
    // blocks it would push maintainers to delete the test instead.
    ['the action pinned to a commit SHA', (w) => {
      w.jobs['build-release'].steps[4].uses = 'softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65';
    }],
    ['the action bumped to a newer tag', (w) => { w.jobs['build-release'].steps[4].uses = 'softprops/action-gh-release@v2.7.0'; }],
    ['a legitimate flag on the guard', (w) => { w.jobs['build-release'].steps[3].run = `node ${GUARD_SCRIPT} --verbose`; }],
    ['the guard run as a block scalar', (w) => { w.jobs['build-release'].steps[3].run = `node ${GUARD_SCRIPT}\n`; }],
    ['extra whitespace in the guard run', (w) => { w.jobs['build-release'].steps[3].run = `  node  ${GUARD_SCRIPT}  `; }],
    ['timeout-minutes on the guard', (w) => { w.jobs['build-release'].steps[3]['timeout-minutes'] = 5; }],
    ['shell: pwsh on the guard', (w) => { w.jobs['build-release'].steps[3].shell = 'pwsh'; }],
    ['NVGW_GH_OWNER hoisted to workflow level', (w) => {
      delete w.jobs['build-release'].steps[3].env;
      w.env = { NVGW_GH_OWNER: '${{ github.repository_owner }}' };
    }],
    ['NVGW_GH_OWNER hoisted to job level', (w) => {
      delete w.jobs['build-release'].steps[3].env;
      w.jobs['build-release'].env = { NVGW_GH_OWNER: '${{ github.repository_owner }}' };
    }],
    ['a third upload after the guard', (w) => {
      w.jobs['build-release'].steps.push({ uses: 'softprops/action-gh-release@v2.6.2', with: { files: 'dist/SHA256SUMS.txt' } });
    }],
    ['a tag condition on the upload', (w) => { w.jobs['build-release'].steps[4].if = "startsWith(github.ref, 'refs/tags/')"; }],
    ['a strategy.matrix of one', (w) => { w.jobs['build-release'].strategy = { matrix: { os: ['windows-latest'] } }; }],
    // Writes to the workflow-run artifact store, which cannot create a release.
    ['actions/upload-artifact added after the guard', (w) => {
      w.jobs['build-release'].steps.push({ uses: 'actions/upload-artifact@v4', with: { path: 'dist/*.exe' } });
    }],
    ['actions/cache added before packaging', (w) => {
      w.jobs['build-release'].steps.splice(2, 0, { uses: 'actions/cache@v4', with: { path: '~/.npm' } });
    }],
    ['a cross-job upload with a DIRECT needs:', (w) => {
      w.jobs['publish-readme'] = { needs: ['build-release'], steps: [{ uses: 'softprops/action-gh-release@v2.6.2' }] };
    }],
    ['a cross-job upload with needs: as a STRING', (w) => {
      w.jobs['publish-readme'] = { needs: 'build-release', steps: [{ uses: 'softprops/action-gh-release@v2.6.2' }] };
    }],
    ['a cross-job upload reached TRANSITIVELY', (w) => {
      w.jobs.gate = { needs: ['build-release'], steps: [{ run: 'echo ok' }] };
      w.jobs['publish-readme'] = { needs: ['gate'], steps: [{ uses: 'softprops/action-gh-release@v2.6.2' }] };
    }]
  ];
  for (const [label, mutate] of LEGITIMATE) {
    const workflow = base();
    mutate(workflow);
    assert.deepEqual(auditReleaseWiring(workflow), [],
      `${label} is a legitimate edit and must NOT be blocked — a wiring test that cries wolf gets deleted`);
  }
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
