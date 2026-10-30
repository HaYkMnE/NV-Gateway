import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

import {
  RELEASE_TOKEN_EXPRESSION,
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
const OLD_FEED_REPOSITORY = 'HaYkMnE/NV-Gateway-releases';

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
//   electron-builder.yml   publish.owner/repo = HaYkMnE/NV-Gateway (literal),
//                          written into resources/app-update.yml
//   scripts/packaging-env-guard.mjs   DEFAULT_RELEASE_REPOSITORY = NV-Gateway and
//                          refuses to package when the block disagrees
//   .github/workflows/release.yml     sets NVGW_GH_OWNER only, uploads with GITHUB_TOKEN
// => installed copies poll github.com/HaYkMnE/NV-Gateway, the repository the
//    workflow runs in. GITHUB_TOKEN cannot publish anywhere else, so any other
//    feed would be a green run that updates nobody. These assertions fail
//    against that configuration.
// ───────────────────────────────────────────────────────────────────────────

test('the release job fails loudly when it cannot publish to the baked update feed', () => {
  // The baked feed is the workflow's own repository: the only shape GITHUB_TOKEN
  // can publish to. It must pass with no extra credential.
  const sameRepo = resolveReleaseTarget({
    NVGW_GH_OWNER: 'HaYkMnE',
    GITHUB_REPOSITORY: SOURCE_REPOSITORY
  });
  assert.equal(sameRepo.ok, true, sameRepo.error);
  assert.equal(sameRepo.feedRepository, SOURCE_REPOSITORY, 'the default feed is this repository');
  assert.equal(FEED_REPOSITORY, SOURCE_REPOSITORY);

  // Every other repository - a fork, the pre-rename feed name, or an
  // NVGW_GH_REPO override - must be a hard error, never a warning, and it must
  // be actionable without reading any source.
  for (const [label, env] of [
    ['a fork running the workflow', { NVGW_GH_OWNER: 'HaYkMnE', GITHUB_REPOSITORY: 'someone/NV-Gateway' }],
    ['the pre-rename feed name', { NVGW_GH_OWNER: 'HaYkMnE', NVGW_GH_REPO: 'NV-Gateway-releases', GITHUB_REPOSITORY: SOURCE_REPOSITORY }],
    ['an unset GITHUB_REPOSITORY', { NVGW_GH_OWNER: 'HaYkMnE' }]
  ]) {
    const blocked = resolveReleaseTarget(env);
    assert.equal(blocked.ok, false, `${label}: a release whose feed is not this repository must not proceed`);
    assert.match(blocked.error, /cannot reach the update feed/, `${label}: the failure must say why`);
    assert.match(blocked.error, /GITHUB_TOKEN/, `${label}: the failure must name the token limitation`);
    assert.match(blocked.error, /Do not add a personal access token/,
      `${label}: the failure must rule out the cross-repo shortcut`);
  }
  const old = resolveReleaseTarget({ NVGW_GH_OWNER: 'HaYkMnE', NVGW_GH_REPO: 'NV-Gateway-releases', GITHUB_REPOSITORY: SOURCE_REPOSITORY });
  assert.equal(old.feedRepository, OLD_FEED_REPOSITORY);
  assert.match(old.error, new RegExp(OLD_FEED_REPOSITORY.replace('/', '\\/')),
    'the failure must name the feed it could not reach');

  // A token in the environment changes nothing: there is no cross-repo mode.
  const withToken = resolveReleaseTarget({
    NVGW_GH_OWNER: 'HaYkMnE',
    GITHUB_REPOSITORY: 'someone/NV-Gateway',
    NVGW_RELEASES_TOKEN: 'x'
  });
  assert.equal(withToken.ok, false, 'a personal access token must not unlock cross-repository publishing');

  // Repository names are case-insensitive on GitHub, so case alone is not a
  // different repository and must not fail the release.
  const casing = resolveReleaseTarget({
    NVGW_GH_OWNER: 'haykmne',
    NVGW_GH_REPO: 'nv-gateway',
    GITHUB_REPOSITORY: SOURCE_REPOSITORY
  });
  assert.equal(casing.ok, true, 'a case difference must not be treated as a different repository');

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

  // It must resolve the feed from the same owner CI packages with. It needs no
  // secret at all: the decision is the repository comparison.
  assert.equal(guard.step.env?.NVGW_GH_OWNER, '${{ github.repository_owner }}',
    'the guard must resolve the feed from the same owner used at package time');
  assert.equal(Object.keys(guard.step.env ?? {}).some((key) => /TOKEN/.test(key)), false,
    'the destination guard must not receive any token');

  // Fail fast: guarding after the package build would burn a full Windows
  // packaging run before reporting a problem known at second zero.
  //
  // Ordering is compared WITHIN the guard's own job. `allSteps()` flattens step
  // indices ACROSS jobs, so a global `guardAt < buildAt` would still pass if the
  // guard lived in job A and the release build in job B — but "before" in
  // different jobs means nothing: the jobs run concurrently, so the guard would
  // not gate the build it is meant to protect. The found steps must therefore
  // share the guard's jobId, and the comparison is on per-job indices.
  const guardJobId = guard.jobId;
  const build = steps.find(({ jobId, step }) =>
    jobId === guardJobId && typeof step.run === 'string' && step.run.includes('build:release'));
  assert.ok(build, `the release build (build:release) must live in the same job as the destination guard (job ${guardJobId})`);
  assert.ok(guard.index < build.index,
    `the destination guard must run BEFORE the release build within job ${guardJobId} ` +
    `(guard at step ${guard.index}, build at step ${build.index})`);

  // The guard publishes the destination for the upload steps to consume. Those
  // uploads must be in the SAME job too: a step that reads another job's output
  // via `needs` is a different contract, and this guard's id/output is only
  // wired for the steps that run beside it.
  const feedUpload = steps.find(({ step }) => typeof step.with?.repository === 'string');
  assert.ok(feedUpload, 'release.yml must upload to the update-feed repository explicitly');
  assert.equal(feedUpload.jobId, guardJobId,
    `the feed upload must live in the guard's job (job ${guardJobId}) so it can read steps.${guard.step.id}.outputs`);
  assert.ok(build.index < feedUpload.index,
    `the release build must run BEFORE the feed upload within job ${guardJobId}`);

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

  // Same-repository publishing: the built-in GITHUB_TOKEN, nothing else.
  assert.equal(step.with.token, `\${{ ${RELEASE_TOKEN_EXPRESSION} }}`,
    'the upload must authenticate with the built-in GITHUB_TOKEN');
  // Least privilege per OpenSSF Scorecard (TokenPermissions): the workflow
  // default is read-only and only the publishing job holds contents: write.
  assert.equal(workflow.permissions?.contents, 'read',
    'the top-level token must stay read-only (least privilege per OpenSSF Scorecard)');
  assert.equal(workflow.jobs?.['build-release']?.permissions?.contents, 'write',
    'GITHUB_TOKEN needs contents: write to create the release');
  assert.doesNotMatch(workflowText, /secrets\.(?!GITHUB_TOKEN\b)[A-Za-z0-9_]+/,
    'no secret other than GITHUB_TOKEN may appear in the release workflow');

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

test('the README download links point at this repository\'s releases page', () => {
  // The source repository is public and is also the release/feed repository, so
  // the README download links point at its own /releases page. The pre-rename
  // feed name only works through GitHub's redirect and must not be linked.
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes(`https://github.com/${SOURCE_REPOSITORY}/releases`),
    'the README download links must point at this repository\'s releases page');
  assert.equal(readme.includes(OLD_FEED_REPOSITORY), false,
    'the README must not link the pre-rename feed repository');
});

test('the release workflow must not redirect the baked update feed', () => {
  // Setting NVGW_GH_REPO here would make the guards expect a feed that the literal
  // publish block does not bake, and point the upload away from the repository
  // installed copies poll. It must stay unset.
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
      `${label} must not set NVGW_GH_REPO - the baked feed is the literal publish block`);
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
  // workflow that lost the feed upload.
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
