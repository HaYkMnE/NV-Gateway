#!/usr/bin/env node
// Release-destination guard. It answers ONE question, at release time, before a
// single artifact is built: can this job actually publish to the repository the
// installed app polls for updates?
//
// Why this has to exist
// ---------------------
// The update feed is baked, not configured at runtime. electron-builder expands
// ${env.NVGW_GH_OWNER}/${env.NVGW_GH_REPO} (electron-builder.yml:67-71) while it
// resolves the publish config and writes the EXPANDED values into
// resources/app-update.yml — the file electron-updater reads on the user's
// machine. NVGW_GH_REPO is not set by CI, so the documented default in
// packaging-env-guard.mjs applies and the feed points at NV-Gateway-releases.
//
// The artifact upload, meanwhile, defaults to the repository the workflow runs
// in. Those two destinations are DIFFERENT repositories, and nothing in the
// pipeline compared them: a release could upload the installer and latest.yml to
// the source repo, report success in green, and leave every installed copy
// polling a feed that never gains a release. Auto-update would stop without a
// single failing step.
//
// So the destination is derived from the SAME function that decides what gets
// baked into app-update.yml (resolvePublishEnvironment). The feed and the upload
// target cannot drift apart, because there is only one of them.
//
// Cross-repo publishing needs a token the default GITHUB_TOKEN cannot provide:
// GITHUB_TOKEN is scoped to the repository running the workflow and cannot create
// releases elsewhere. When the feed lives in another repository and no such token
// is present, this guard FAILS the job and names the missing secret and the exact
// owner action. It deliberately does not warn-and-continue: a green run that
// published to the wrong place is the defect being prevented.
//
// Direct run (`node scripts/release-target-guard.mjs`):
//   - exit 1 with an actionable message when the feed is unreachable;
//   - exit 0 and write feed_repository / cross_repo to $GITHUB_OUTPUT otherwise.
// The pure resolveReleaseTarget is exported for the workflow steps and for tests.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePublishEnvironment } from './packaging-env-guard.mjs';

/**
 * Name of BOTH the repository secret the owner must create and the environment
 * variable the workflow maps it to. One spelling, so the failure message can
 * name the thing the owner actually has to type.
 */
export const RELEASES_TOKEN_SECRET = 'NVGW_RELEASES_TOKEN';

/** Workflow file whose wiring is validated, relative to the repo root. */
export const RELEASE_WORKFLOW_FILE = '.github/workflows/release.yml';

/**
 * Decide where the release must go and whether this job can get it there.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ok: true, feedRepository: string, workflowRepository: string, crossRepo: boolean}
 *          | {ok: false, error: string, feedRepository?: string, workflowRepository?: string, crossRepo?: boolean}}
 */
export function resolveReleaseTarget(env = process.env) {
  // Same resolution as packaging: whatever would be baked into app-update.yml is
  // by definition the repository the app will poll.
  const publish = resolvePublishEnvironment(env);
  if (!publish.ok) {
    return { ok: false, error: publish.error };
  }

  const feedRepository = `${publish.owner}/${publish.repo}`;
  const workflowRepository = typeof env.GITHUB_REPOSITORY === 'string' ? env.GITHUB_REPOSITORY.trim() : '';

  // GitHub repository names are case-insensitive, so a case difference is not a
  // cross-repo publish and must not demand a token.
  const crossRepo = workflowRepository.toLowerCase() !== feedRepository.toLowerCase();

  const rawToken = env[RELEASES_TOKEN_SECRET];
  // An unset GitHub secret expands to an EMPTY STRING in a workflow expression,
  // never to an error — so blank is the real "missing secret" signal.
  const hasToken = typeof rawToken === 'string' && rawToken.trim() !== '';

  if (crossRepo && !hasToken) {
    return {
      ok: false,
      feedRepository,
      workflowRepository,
      crossRepo,
      error: [
        'this release cannot reach the update feed the installed app polls, so it is failing instead of publishing somewhere nobody reads.',
        '',
        `  baked update feed (resources/app-update.yml): github.com/${feedRepository}`,
        `  repository running this workflow:              github.com/${workflowRepository || '(GITHUB_REPOSITORY unset)'}`,
        '',
        'Those are different repositories. The default GITHUB_TOKEN is scoped to the repository running the',
        'workflow and CANNOT create releases in another one. Publishing with it would attach the installer and',
        'latest.yml to the source repo while every installed copy keeps polling the feed repo, finds no release,',
        'and silently stops updating.',
        '',
        'OWNER ACTION REQUIRED (CI cannot do this — it needs repository-settings access):',
        `  1. Create a fine-grained personal access token with "Contents: Read and write" scoped to`,
        `     github.com/${feedRepository} ONLY (no other repository, no other permission).`,
        `     GitHub -> Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens.`,
        `  2. Add it as a repository secret named exactly ${RELEASES_TOKEN_SECRET} on`,
        `     github.com/${workflowRepository || '<this repository>'}`,
        '     (Settings -> Secrets and variables -> Actions -> New repository secret).',
        '  3. Re-run this workflow, or re-push the tag.',
        '',
        `Do NOT "fix" this by setting NVGW_GH_REPO to ${workflowRepository || 'the source repo'}: that redirects the`,
        'baked feed of every future build and abandons the already-installed copies that poll',
        `github.com/${feedRepository}.`
      ].join('\n')
    };
  }

  return { ok: true, feedRepository, workflowRepository, crossRepo };
}

/**
 * The guard is only worth anything if the workflow actually sends the artifacts
 * where this script says. Asserted on the workflow text so removing the
 * cross-repo destination, or dropping an updater artifact, breaks the release
 * loudly rather than quietly reverting to the old broken behaviour.
 *
 * @param {string} root Repository root.
 */
function validateWorkflowWiring(root) {
  const file = path.join(root, RELEASE_WORKFLOW_FILE);
  let workflow;
  try {
    workflow = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, error: `cannot read ${RELEASE_WORKFLOW_FILE} to verify the upload destination: ${error.message}` };
  }

  const required = [
    // The upload target must come from this guard's output, not a second literal
    // that can drift from the baked feed.
    'outputs.feed_repository',
    // electron-updater needs latest.yml plus the installer it names; the blockmap
    // is what keeps differential updates working.
    'dist/latest.yml',
    'dist/NV-Gateway-Setup-*.exe.blockmap',
    // A glob that matches nothing must fail the job, otherwise a renamed artifact
    // produces a release that looks complete and cannot update anyone.
    'fail_on_unmatched_files: true'
  ];
  const missing = required.filter((fragment) => !workflow.includes(fragment));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `${RELEASE_WORKFLOW_FILE} no longer wires the release to the baked update feed (missing: ${missing.join(', ')}); restore the cross-repo upload so the installer, its blockmap and latest.yml reach the repository the app polls.`
    };
  }
  return { ok: true };
}

function main() {
  const root = path.resolve(import.meta.dirname, '..');
  const target = resolveReleaseTarget(process.env);
  if (!target.ok) {
    console.error(`[release-target-guard] ${target.error}`);
    process.exitCode = 1;
    return;
  }

  const wiring = validateWorkflowWiring(root);
  if (!wiring.ok) {
    console.error(`[release-target-guard] ${wiring.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[release-target-guard] update feed: github.com/${target.feedRepository}` +
    ` (${target.crossRepo ? `cross-repo from ${target.workflowRepository}, ${RELEASES_TOKEN_SECRET} present` : 'same repository as this workflow'})`);

  // Hand the resolved destination to the upload steps. Never the token.
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `feed_repository=${target.feedRepository}\ncross_repo=${target.crossRepo}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
