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
/**
 * Remove YAML comments before any wiring check reads the file.
 *
 * This is load-bearing, not cosmetic. A plain substring test over the RAW text
 * accepts a workflow whose upload step has been commented out or replaced by a
 * hardcoded literal that merely MENTIONS the expected fragment in a trailing
 * comment — measured, both of those passed the earlier text-only check while the
 * release was actually broken. Only executable YAML can publish an artifact, so
 * only executable YAML is examined.
 *
 * Full-line comments are dropped entirely; a trailing ` # ...` is trimmed. The
 * workflow carries no '#' inside a quoted scalar, so the conservative trailing
 * trim cannot corrupt a real value here.
 *
 * @param {string} text
 * @returns {string}
 */
function stripYamlComments(text) {
  return text
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line.replace(/\s+#.*$/, '')))
    .join('\n');
}

/**
 * The guard is only worth anything if the workflow actually sends the artifacts
 * where this script says.
 *
 * Checked STRUCTURALLY rather than by substring presence, and deliberately
 * without js-yaml: this step runs BEFORE `npm ci`, so node_modules does not yet
 * exist and a YAML library cannot be imported. The checks below therefore work
 * on comment-stripped lines and on the relationship BETWEEN them (which step id
 * is declared, which id is referenced, which job each lives in), because that
 * relationship — not the mere presence of a string — is what decides where the
 * upload lands.
 *
 * @param {string} root Repository root.
 */
function validateWorkflowWiring(root) {
  const file = path.join(root, RELEASE_WORKFLOW_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, error: `cannot read ${RELEASE_WORKFLOW_FILE} to verify the upload destination: ${error.message}` };
  }

  const fail = (reason) => ({
    ok: false,
    error: `${RELEASE_WORKFLOW_FILE} no longer wires the release to the baked update feed: ${reason}. Restore the cross-repo upload so the installer, its blockmap and latest.yml reach the repository the app polls.`
  });

  const text = stripYamlComments(raw);
  const lines = text.split('\n');

  // ── The guard step must still exist, and its id is what the upload references.
  const guardRunAt = lines.findIndex((line) => line.includes('scripts/release-target-guard.mjs'));
  if (guardRunAt < 0) {
    return fail('it no longer runs scripts/release-target-guard.mjs');
  }

  // Bound the guard's own step block: from its `- ` marker to the next one.
  let blockStart = guardRunAt;
  while (blockStart > 0 && !/^\s*-\s/.test(lines[blockStart])) blockStart -= 1;
  let blockEnd = guardRunAt + 1;
  while (blockEnd < lines.length && !/^\s*-\s/.test(lines[blockEnd])) blockEnd += 1;

  const guardBlock = lines.slice(blockStart, blockEnd);
  const idLine = guardBlock.find((line) => /^\s*id:\s*\S+/.test(line));
  if (!idLine) {
    return fail('the destination-guard step has no `id:`, so no upload step can reference its resolved destination');
  }
  const guardId = idLine.match(/^\s*id:\s*(\S+)/)[1];
  const guardIdAt = blockStart + guardBlock.indexOf(idLine);

  // ── Every reference to the resolved destination must name THIS step's id.
  //
  // A dangling reference is the dangerous case: action-gh-release v2.6.2 resolves
  // `repository` as `env.INPUT_REPOSITORY || env.GITHUB_REPOSITORY` (src/util.ts),
  // so an expression pointing at a step id that does not exist expands to EMPTY
  // and the upload SILENTLY falls back to the repository the workflow runs in —
  // exactly the drift this guard exists to prevent, with a green build.
  const referenced = [...text.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\.feed_repository/g)].map((m) => m[1]);
  if (referenced.length === 0) {
    return fail('no upload step takes its `repository:` from this guard\'s feed_repository output');
  }
  const dangling = referenced.filter((id) => id !== guardId);
  if (dangling.length > 0) {
    return fail(`an upload step references steps.${dangling[0]}.outputs.feed_repository, but the guard step's id is "${guardId}" — that expression expands to EMPTY and the upload would silently fall back to this repository`);
  }

  // ── The `repository:` input must BE that expression, not a literal.
  const repoExpression = new RegExp(`^\\s*repository:\\s*\\$\\{\\{\\s*steps\\.${guardId}\\.outputs\\.feed_repository\\s*\\}\\}\\s*$`);
  const repoAt = lines.findIndex((line) => repoExpression.test(line));
  if (repoAt < 0) {
    return fail('no upload step sets `repository:` to the guard\'s resolved feed_repository output; a hardcoded literal can drift from the baked feed');
  }

  // ── The cross-repo upload must carry the PAT; GITHUB_TOKEN cannot write there.
  if (!lines.some((line) => new RegExp(`^\\s*token:\\s*\\$\\{\\{\\s*secrets\\.${RELEASES_TOKEN_SECRET}\\s*\\}\\}\\s*$`).test(line))) {
    return fail(`the cross-repo upload no longer passes token: \${{ secrets.${RELEASES_TOKEN_SECRET} }}, and the default GITHUB_TOKEN cannot create a release in another repository`);
  }

  // ── The upload must live in the SAME job as the guard, or the guard's output
  //    is not even in scope for it (`steps.` context is per-job).
  const jobHeader = /^  [A-Za-z0-9_-]+:\s*$/;
  if (repoAt < guardIdAt || lines.slice(guardIdAt, repoAt).some((line) => jobHeader.test(line))) {
    return fail('the feed upload sits in a different job from the destination guard, where `steps.<id>.outputs` is out of scope and expands to empty');
  }

  // ── Artifacts electron-updater needs, as executable list entries.
  for (const fragment of ['dist/latest.yml', 'dist/NV-Gateway-Setup-*.exe.blockmap']) {
    if (!lines.some((line) => line.trim() === fragment)) {
      return fail(`"${fragment}" is no longer an uploaded artifact`);
    }
  }

  // ── Nothing may make a matched-nothing glob, or the guard itself, non-fatal.
  if (!lines.some((line) => /^\s*fail_on_unmatched_files:\s*true\s*$/.test(line))) {
    return fail('fail_on_unmatched_files: true is gone, so a renamed artifact would publish a release that looks complete and updates nobody');
  }
  if (lines.some((line) => /^\s*fail_on_unmatched_files:\s*false\s*$/.test(line))) {
    return fail('an upload step sets fail_on_unmatched_files: false, which lets a missing artifact publish silently');
  }
  if (lines.some((line) => /^\s*continue-on-error:\s*true\s*$/.test(line))) {
    return fail('a step sets continue-on-error: true, which restores the silent-success mode this guard removes');
  }
  if (lines.some((line) => /^\s*if:\s*false\s*$/.test(line))) {
    return fail('a step is disabled with `if: false`');
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
