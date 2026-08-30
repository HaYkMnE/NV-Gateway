import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

import {
  RELEASES_TOKEN_SECRET,
  RELEASE_WORKFLOW_FILE,
  resolveReleaseTarget
} from '../scripts/release-target-guard.mjs';
import { DEFAULT_RELEASE_REPOSITORY } from '../scripts/packaging-env-guard.mjs';

const root = path.resolve(import.meta.dirname, '..');
const workflowPath = path.join(root, RELEASE_WORKFLOW_FILE);
const workflowText = fs.readFileSync(workflowPath, 'utf8');
// js-yaml is the parser the shipping-credential guard already uses, so workflow
// shape is read the way a YAML consumer sees it rather than by regex guesswork.
const workflow = yaml.load(workflowText);

const SOURCE_REPOSITORY = 'HaYkMnE/NV-Gateway';
const FEED_REPOSITORY = `HaYkMnE/${DEFAULT_RELEASE_REPOSITORY}`;

/** Every step of every job, flattened, with its job id for error messages. */
function allSteps() {
  return Object.entries(workflow.jobs ?? {}).flatMap(([jobId, job]) =>
    (job.steps ?? []).map((step, index) => ({ jobId, index, step })));
}

/** Steps that invoke the release-upload action, in workflow order. */
function uploadSteps() {
  return allSteps().filter(({ step }) => typeof step.uses === 'string'
    && step.uses.startsWith('softprops/action-gh-release@'));
}

// ───────────────────────────────────────────────────────────────────────────
// The destination the app POLLS and the destination CI UPLOADS to must be the
// same repository, and that has to be enforced by the pipeline rather than by
// anybody remembering.
//
// The feed is baked, not configured at runtime:
//   electron-builder.yml:67-71   publish.owner/repo = ${env.NVGW_GH_*} macros,
//                                expanded into resources/app-update.yml
//   scripts/packaging-env-guard.mjs:23   NVGW_GH_REPO default NV-Gateway-releases
//   scripts/run-electron-builder.mjs:78  applies that default in-process
//   .github/workflows/release.yml        sets NVGW_GH_OWNER only
// => installed copies poll github.com/HaYkMnE/NV-Gateway-releases.
//
// The upload defaults to the repository the workflow runs in, which is
// github.com/HaYkMnE/NV-Gateway. Different repository, no failure, green run:
// auto-update stops for every install and nothing reports it. These assertions
// fail against that configuration.
// ───────────────────────────────────────────────────────────────────────────

test('the release job fails loudly when it cannot publish to the baked update feed', () => {
  // Cross-repo with no token is the live CI shape today. It must be a hard error,
  // never a warning, and it must be actionable without reading any source.
  const blocked = resolveReleaseTarget({
    NVGW_GH_OWNER: 'HaYkMnE',
    GITHUB_REPOSITORY: SOURCE_REPOSITORY
  });
  assert.equal(blocked.ok, false, 'a cross-repo release without a token must not be allowed to proceed');
  assert.equal(blocked.feedRepository, FEED_REPOSITORY);
  assert.equal(blocked.crossRepo, true);
  // The maintainer must learn the secret name, the scope and the target repo from
  // the message alone.
  assert.match(blocked.error, new RegExp(RELEASES_TOKEN_SECRET),
    'the failure must name the exact missing secret');
  assert.match(blocked.error, /Contents: Read and write/,
    'the failure must name the required permission');
  assert.match(blocked.error, new RegExp(FEED_REPOSITORY.replace('/', '\\/')),
    'the failure must name the repository the token needs access to');
  assert.match(blocked.error, /OWNER ACTION REQUIRED/,
    'the failure must state that this is an owner action, not a retryable error');
  // It must not suggest the rejected shortcut of repointing the feed.
  assert.match(blocked.error, /Do NOT "fix" this by setting NVGW_GH_REPO/,
    'the failure must warn against redirecting the baked feed instead');

  // An unset secret expands to an empty string in a workflow expression, so blank
  // must be treated as missing rather than as a usable token.
  for (const token of ['', '   ']) {
    const blank = resolveReleaseTarget({
      NVGW_GH_OWNER: 'HaYkMnE',
      GITHUB_REPOSITORY: SOURCE_REPOSITORY,
      [RELEASES_TOKEN_SECRET]: token
    });
    assert.equal(blank.ok, false, 'a blank secret must count as missing, not as present');
  }

  // With the secret present the same cross-repo release is allowed.
  const allowed = resolveReleaseTarget({
    NVGW_GH_OWNER: 'HaYkMnE',
    GITHUB_REPOSITORY: SOURCE_REPOSITORY,
    [RELEASES_TOKEN_SECRET]: 'x'
  });
  assert.equal(allowed.ok, true, 'a cross-repo release with the token must proceed');
  assert.equal(allowed.feedRepository, FEED_REPOSITORY);
  assert.equal(allowed.crossRepo, true);

  // Same-repository publishing needs no extra token: GITHUB_TOKEN can do it.
  const sameRepo = resolveReleaseTarget({
    NVGW_GH_OWNER: 'HaYkMnE',
    NVGW_GH_REPO: 'NV-Gateway',
    GITHUB_REPOSITORY: SOURCE_REPOSITORY
  });
  assert.equal(sameRepo.ok, true, 'publishing into the workflow repository needs no PAT');
  assert.equal(sameRepo.crossRepo, false);

  // Repository names are case-insensitive on GitHub, so case alone is not a
  // cross-repo publish and must not demand a secret.
  const casing = resolveReleaseTarget({
    NVGW_GH_OWNER: 'haykmne',
    NVGW_GH_REPO: 'nv-gateway',
    GITHUB_REPOSITORY: SOURCE_REPOSITORY
  });
  assert.equal(casing.ok, true, 'a case difference must not be treated as a different repository');
  assert.equal(casing.crossRepo, false);

  // A missing owner must still fail through the packaging guard's own message.
  const noOwner = resolveReleaseTarget({ GITHUB_REPOSITORY: SOURCE_REPOSITORY });
  assert.equal(noOwner.ok, false, 'a missing NVGW_GH_OWNER must fail');
  assert.match(noOwner.error, /NVGW_GH_OWNER is required/);
});

test('the release workflow runs the destination guard before it builds anything', () => {
  const steps = allSteps();
  const guardAt = steps.findIndex(({ step }) =>
    typeof step.run === 'string' && step.run.includes('scripts/release-target-guard.mjs'));
  assert.ok(guardAt >= 0, 'release.yml must run scripts/release-target-guard.mjs');

  const guard = steps[guardAt];
  // Nothing may make the guard optional: an `if:` or continue-on-error would
  // restore exactly the silent-success failure mode it exists to remove.
  assert.equal('if' in guard.step, false, 'the destination guard must not be conditional');
  assert.equal('continue-on-error' in guard.step, false,
    'the destination guard must not be allowed to fail softly');

  // It must resolve the feed from the same owner CI packages with, and receive the
  // secret so it can tell present from absent.
  assert.equal(guard.step.env?.NVGW_GH_OWNER, '${{ github.repository_owner }}',
    'the guard must resolve the feed from the same owner used at package time');
  assert.equal(guard.step.env?.[RELEASES_TOKEN_SECRET],
    `\${{ secrets.${RELEASES_TOKEN_SECRET} }}`,
    `the guard must see ${RELEASES_TOKEN_SECRET} to decide whether the feed is reachable`);

  // Fail fast: guarding after the package build would burn a full Windows
  // packaging run before reporting a problem known at second zero.
  const buildAt = steps.findIndex(({ step }) =>
    typeof step.run === 'string' && step.run.includes('build:release'));
  assert.ok(buildAt >= 0, 'release.yml must still build the release');
  assert.ok(guardAt < buildAt, 'the destination guard must run BEFORE the release build');

  // The guard publishes the destination for the upload steps to consume.
  assert.ok(typeof guard.step.id === 'string' && guard.step.id.length > 0,
    'the guard step needs an id so its resolved destination can be referenced');
});

test('the updater artifacts are uploaded to the repository the app actually polls', () => {
  const uploads = uploadSteps();
  assert.ok(uploads.length >= 1, 'release.yml must upload release artifacts');

  const feedUploads = uploads.filter(({ step }) => typeof step.with?.repository === 'string');
  assert.equal(feedUploads.length, 1,
    'exactly one upload step must target the update-feed repository explicitly');

  const [{ step }] = feedUploads;

  // The destination must be the guard's resolved value. A second hardcoded
  // literal could drift from the baked feed again, which is the whole defect.
  assert.match(step.with.repository, /steps\.[A-Za-z0-9_-]+\.outputs\.feed_repository/,
    'the upload repository must come from the destination guard, not a separate literal');

  // GITHUB_TOKEN cannot write releases in another repository, so the cross-repo
  // upload must use the PAT secret.
  assert.equal(step.with.token, `\${{ secrets.${RELEASES_TOKEN_SECRET} }}`,
    `the cross-repo upload must authenticate with ${RELEASES_TOKEN_SECRET}`);

  const files = String(step.with.files ?? '').split('\n').map((line) => line.trim()).filter(Boolean);

  // electron-updater reads latest.yml and then downloads the installer it names.
  // Without both, an update check either finds nothing or resolves to a 404.
  assert.ok(files.includes('dist/latest.yml'),
    'latest.yml must reach the feed repo — electron-updater reads it first');
  assert.ok(files.some((pattern) => /NV-Gateway-Setup-.*\.exe$/.test(pattern)),
    'the NSIS installer must reach the feed repo');
  // The blockmap is what makes differential updates possible; an installer glob
  // ending in .exe does NOT match "<installer>.exe.blockmap", so it needs its own
  // entry or differential updates silently degrade to full downloads.
  assert.ok(files.includes('dist/NV-Gateway-Setup-*.exe.blockmap'),
    'the installer blockmap must reach the feed repo or differential updates degrade');

  // A glob that matches nothing must fail the release. Otherwise a renamed
  // artifact produces a release that looks complete and updates nobody.
  assert.equal(step.with.fail_on_unmatched_files, true,
    'an unmatched artifact glob must fail the release, not publish a partial one');
});

test('the source repository still gets its own release for the README download links', () => {
  // README.md:17 and README.md:158 send users to the CODE repo's releases page for
  // the installer. That is intentional and separate from the update feed, so the
  // workflow must keep publishing there ON PURPOSE rather than as a side effect of
  // a missing `repository:` input.
  const uploads = uploadSteps();
  const sourceUploads = uploads.filter(({ step }) => !('repository' in (step.with ?? {})));
  assert.equal(sourceUploads.length, 1,
    'exactly one upload step must publish to the workflow repository for the README links');

  const [{ step }] = sourceUploads;
  const files = String(step.with?.files ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  assert.ok(files.some((pattern) => /NV-Gateway-Setup-.*\.exe$/.test(pattern)),
    'the README tells users to download the installer here, so it must be attached');

  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes(`https://github.com/${SOURCE_REPOSITORY}/releases`),
    'this test is only meaningful while the README points at the source releases page');
});

test('the release workflow must not redirect the baked update feed', () => {
  // Setting NVGW_GH_REPO here would repoint app-update.yml in every future build
  // and abandon the already-installed copies polling NV-Gateway-releases. It was
  // proposed, measured and rejected; this keeps it rejected.
  //
  // Asserted on the PARSED env blocks, not on the file text: the workflow documents
  // why the variable is deliberately left unset, and a comment mentioning the name
  // is not the same thing as assigning it. Reading the env the way a YAML consumer
  // does is also the stricter check, since a raw substring test cannot tell an
  // explanation from an assignment in either direction.
  const envBlocks = [
    ['workflow', workflow.env],
    ...Object.entries(workflow.jobs ?? {}).map(([jobId, job]) => [`job ${jobId}`, job.env]),
    ...allSteps().map(({ jobId, index, step }) =>
      [`job ${jobId} step ${index} (${step.name ?? step.uses ?? 'unnamed'})`, step.env])
  ];
  for (const [label, env] of envBlocks) {
    assert.equal(Object.hasOwn(env ?? {}, 'NVGW_GH_REPO'), false,
      `${label} must not set NVGW_GH_REPO — the baked feed must stay on the releases repo`);
  }

  // A shell assignment inside a run: body would redirect the feed just as well, in
  // either PowerShell or bash spelling.
  for (const { jobId, index, step } of allSteps()) {
    const run = typeof step.run === 'string' ? step.run : '';
    assert.equal(/(?:\$env:)?NVGW_GH_REPO\s*=/.test(run), false,
      `job ${jobId} step ${index} must not assign NVGW_GH_REPO in its shell body`);
  }

  // The owner must stay wired, or packaging fails fast at the env guard.
  assert.ok(workflowText.includes('NVGW_GH_OWNER'),
    'release.yml must still set NVGW_GH_OWNER');
});

test('the guard rejects a workflow that stops wiring the feed upload', () => {
  // The pure resolver cannot notice a workflow edit, so the guard also validates
  // the workflow text. Proven by asserting on the real file: every fragment the
  // guard demands must be present, so its check cannot silently pass on a
  // workflow that lost the cross-repo upload.
  for (const fragment of [
    'outputs.feed_repository',
    'dist/latest.yml',
    'dist/NV-Gateway-Setup-*.exe.blockmap',
    'fail_on_unmatched_files: true'
  ]) {
    assert.ok(workflowText.includes(fragment),
      `release.yml must keep "${fragment}" or the destination guard fails the build`);
  }
});
