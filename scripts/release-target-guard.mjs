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
 * Strip YAML comments, leaving executable YAML only.
 *
 * This is load-bearing, not cosmetic. A plain substring test over the RAW text
 * accepts a workflow whose upload step has been commented out or replaced by a
 * hardcoded literal that merely MENTIONS the expected fragment in a trailing
 * comment — measured, both of those passed the earliest text-only check while the
 * release was actually broken. Only executable YAML can publish an artifact, so
 * only executable YAML is examined.
 *
 * Quote-aware on purpose: a '#' inside a quoted scalar is DATA, not a comment,
 * and a blind trailing trim would silently truncate a real value. A comment
 * starts only at a '#' that sits outside quotes at line start or after
 * whitespace.
 *
 * @param {string} line
 * @returns {string}
 */
function stripComment(line) {
  let out = '';
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      out += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      return out.replace(/\s+$/, '');
    }
    out += char;
  }
  return out;
}

/** Indentation width of a line, or -1 when the line carries nothing. */
function indentOf(line) {
  return line.trim() === '' ? -1 : line.length - line.trimStart().length;
}

/**
 * Indent of the first child line under a parent, or -1 when it has no children.
 *
 * Measured rather than assumed: a workflow may nest with two spaces or four, and
 * hardcoding one of them turns a real check into dead code that always passes.
 */
function childIndent(lines, start, end, parentIndent) {
  for (let index = start; index < end; index += 1) {
    const width = indentOf(lines[index]);
    if (width < 0) continue;
    return width > parentIndent ? width : -1;
  }
  return -1;
}

/** Drop one layer of matching surrounding quotes: `'x'` and `"x"` both mean x. */
function unquote(value) {
  const trimmed = value.trim();
  const quoted = (trimmed.startsWith("'") && trimmed.endsWith("'"))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'));
  return quoted && trimmed.length >= 2 ? trimmed.slice(1, -1).trim() : trimmed;
}

/** `${{ x }}` -> `x`, so a quoted expression and a bare one compare equal. */
function unwrapExpression(value) {
  const bare = unquote(value);
  const match = bare.match(/^\$\{\{\s*(.*?)\s*\}\}$/);
  return match ? match[1] : bare;
}

/**
 * Mapping keys declared DIRECTLY at `indent` within [start, end).
 *
 * Each entry carries the line it was found on and the exclusive end of its own
 * nested block, so a nested mapping (`with:`) can be read by recursing with a
 * deeper indent instead of scanning the whole file and hoping.
 *
 * @returns {{key: string, value: string, at: number, blockEnd: number}[]}
 */
function mappingAt(lines, start, end, indent) {
  const found = [];
  for (let index = start; index < end; index += 1) {
    const width = indentOf(lines[index]);
    if (width < 0) continue;
    if (width < indent) break;
    if (width !== indent) continue;
    const match = lines[index].trim().match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) continue;
    let blockEnd = index + 1;
    while (blockEnd < end && (indentOf(lines[blockEnd]) < 0 || indentOf(lines[blockEnd]) > indent)) blockEnd += 1;
    found.push({ key: match[1], value: match[2], at: index, blockEnd });
  }
  return found;
}

/**
 * Every step of every job, each tagged with the job that owns it.
 *
 * Written as a real (if small) indentation-aware reader rather than a set of
 * line regexes, because the questions that decide the release destination are
 * structural: WHICH step declares the guard id, WHICH step's `repository:` input
 * carries the expression, and whether those two live in the SAME job. A regex
 * that merely finds `repository:` somewhere cannot answer any of them — measured,
 * a `repository:` line relocated into an `env:` block satisfied the previous
 * check while the upload step had no destination input at all.
 *
 * Deliberately without js-yaml: this guard runs BEFORE `npm ci`, so node_modules
 * does not exist yet and a devDependency cannot be imported.
 *
 * @returns {{job: string, keys: ReturnType<typeof mappingAt>, lines: string[]}[]}
 */
function stepsOfWorkflow(lines) {
  const jobsAt = lines.findIndex((line) => indentOf(line) === 0 && line.trim() === 'jobs:');
  if (jobsAt < 0) return [];

  // Measured, never assumed: a workflow may nest with two spaces or four, and
  // hardcoding one turns every check below into dead code on the other.
  const jobIndent = childIndent(lines, jobsAt + 1, lines.length, 0);
  if (jobIndent < 0) return [];

  const steps = [];
  for (const job of mappingAt(lines, jobsAt + 1, lines.length, jobIndent)) {
    const jobKeyIndent = childIndent(lines, job.at + 1, job.blockEnd, jobIndent);
    if (jobKeyIndent < 0) continue;
    const [stepsKey] = mappingAt(lines, job.at + 1, job.blockEnd, jobKeyIndent)
      .filter((entry) => entry.key === 'steps');
    if (!stepsKey) continue;

    // List items sit at whatever indent the first `- ` uses.
    let itemIndent = -1;
    for (let index = stepsKey.at + 1; index < stepsKey.blockEnd; index += 1) {
      if (/^\s*-\s/.test(lines[index])) { itemIndent = indentOf(lines[index]); break; }
    }
    if (itemIndent < 0) continue;

    const starts = [];
    for (let index = stepsKey.at + 1; index < stepsKey.blockEnd; index += 1) {
      if (indentOf(lines[index]) === itemIndent && /^\s*-\s/.test(lines[index])) starts.push(index);
    }
    starts.forEach((start, order) => {
      const end = order + 1 < starts.length ? starts[order + 1] : stepsKey.blockEnd;
      // Rewrite the `- ` marker into plain indentation so the key riding on the
      // item line reads at the same depth as the keys beneath it.
      const body = lines.slice(start, end)
        .map((line, offset) => (offset === 0 ? line.replace(/^(\s*)-(\s)/, '$1 $2') : line));
      steps.push({
        job: job.key,
        jobAt: job.at,
        jobBlockEnd: job.blockEnd,
        jobKeyIndent,
        lines: body,
        keys: mappingAt(body, 0, body.length, itemIndent + 2)
      });
    });
  }
  return steps;
}

/**
 * The guard is only worth anything if the workflow actually sends the artifacts
 * where this script says.
 *
 * Every check below is a RELATIONSHIP between parsed steps, because
 * action-gh-release v2.6.2 resolves its destination as
 *   github_repository: env.INPUT_REPOSITORY || env.GITHUB_REPOSITORY || ''
 *   -- src/util.ts @ v2.6.2
 * so EVERY route to an empty `repository:` input — a dangling step id, an upload
 * in a job the guard's outputs cannot reach, a guard that never ran, a
 * `repository:` line that is not an input to the upload at all — publishes to the
 * repository the workflow runs in, silently, behind a green build.
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

  // A BOM or CRLF is what an editor leaves behind, not a wiring change.
  const normalised = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  // GitHub Actions cannot parse a tab in indentation, so a file containing one
  // never runs at all. Failing here — rather than misreading it as a passing
  // structure — keeps the guard fail-closed on input it cannot understand.
  const tabLine = normalised.split('\n').findIndex((line) => /^[ ]*\t/.test(line));
  if (tabLine >= 0) {
    return fail(`line ${tabLine + 1} indents with a tab character, which YAML forbids, so GitHub Actions would reject this workflow outright`);
  }

  const lines = normalised.split('\n').map(stripComment);
  const steps = stepsOfWorkflow(lines);
  const keyOf = (step, name) => step.keys.find((entry) => entry.key === name);

  // ── The guard step itself: present, identified, and actually running.
  const guardSteps = steps.filter((step) => {
    const run = keyOf(step, 'run');
    return Boolean(run) && /scripts[/\\]release-target-guard\.mjs/.test(
      [run.value, ...step.lines.slice(run.at + 1)].join('\n')
    );
  });
  if (guardSteps.length === 0) {
    return fail('it no longer runs scripts/release-target-guard.mjs');
  }
  const guard = guardSteps[0];

  const guardIdKey = keyOf(guard, 'id');
  if (!guardIdKey || unquote(guardIdKey.value) === '') {
    return fail('the destination-guard step has no `id:`, so no upload step can reference its resolved destination');
  }
  const guardId = unquote(guardIdKey.value);

  // A guard that is skipped produces no outputs, so every reference to them
  // expands to empty and the upload takes the fallback. It must be unconditional.
  const guardIf = keyOf(guard, 'if');
  if (guardIf) {
    return fail(`the destination-guard step carries \`if: ${guardIf.value.trim()}\`; on any run where that is false the guard is skipped, its outputs are unset, and the upload's \`repository:\` expands to EMPTY and silently falls back to this repository`);
  }
  const guardSoft = keyOf(guard, 'continue-on-error');
  if (guardSoft && unwrapExpression(guardSoft.value).toLowerCase() !== 'false') {
    return fail(`the destination-guard step sets continue-on-error: ${guardSoft.value.trim()}, which restores the silent-success mode this guard removes`);
  }

  // ── The feed upload: the step whose `repository:` input is the guard's output.
  const uploads = steps
    .map((step) => ({ step, with: keyOf(step, 'with') }))
    .filter((entry) => entry.with)
    .map((entry) => ({
      step: entry.step,
      inputs: mappingAt(entry.step.lines, entry.with.at + 1, entry.with.blockEnd,
        indentOf(entry.step.lines[entry.with.at]) + 2)
    }));

  const referenced = uploads
    .map((entry) => entry.inputs.find((input) => input.key === 'repository'))
    .filter(Boolean)
    .map((input) => unwrapExpression(input.value).match(/^steps\.([A-Za-z0-9_-]+)\.outputs\.feed_repository$/))
    .filter(Boolean)
    .map((match) => match[1]);

  const dangling = referenced.filter((id) => id !== guardId);
  if (dangling.length > 0) {
    return fail(`an upload step references steps.${dangling[0]}.outputs.feed_repository, but the guard step's id is "${guardId}" — that expression expands to EMPTY and the upload would silently fall back to this repository`);
  }

  const feedEntries = uploads.filter((entry) => entry.inputs.some((input) =>
    input.key === 'repository'
    && unwrapExpression(input.value) === `steps.${guardId}.outputs.feed_repository`));
  if (feedEntries.length === 0) {
    return fail('no upload step takes its `repository:` input from this guard\'s feed_repository output; a hardcoded literal, or the expression written anywhere other than that input, can drift from the baked feed');
  }
  const feed = feedEntries[0];

  // ── Same job, or the guard's outputs are not even in scope (`steps.` is per-job).
  if (feed.step.job !== guard.job) {
    return fail(`the feed upload sits in job "${feed.step.job}" while the destination guard runs in "${guard.job}", where \`steps.<id>.outputs\` is out of scope and expands to empty`);
  }

  // ── An upload that never runs publishes nothing.
  const feedIf = keyOf(feed.step, 'if');
  if (feedIf && unwrapExpression(feedIf.value).toLowerCase() === 'false') {
    return fail(`the feed upload is disabled with \`if: ${feedIf.value.trim()}\`, so it never runs and the update feed never gains a release`);
  }
  const feedSoft = keyOf(feed.step, 'continue-on-error');
  if (feedSoft && unwrapExpression(feedSoft.value).toLowerCase() !== 'false') {
    return fail(`the feed upload sets continue-on-error: ${feedSoft.value.trim()}, which lets a failed publish report success`);
  }

  const input = (name) => feed.inputs.find((entry) => entry.key === name);

  // ── The cross-repo PAT must be an input of THIS step; GITHUB_TOKEN cannot
  //    create a release in another repository, and a PAT on a different step
  //    does nothing for this one.
  const token = input('token');
  if (!token || unwrapExpression(token.value) !== `secrets.${RELEASES_TOKEN_SECRET}`) {
    return fail(`the cross-repo upload no longer passes token: \${{ secrets.${RELEASES_TOKEN_SECRET} }}, and the default GITHUB_TOKEN cannot create a release in another repository`);
  }

  // ── The artifacts electron-updater needs must be entries of THIS step's list.
  //    A literal block scalar is the only form whose entries can be read back:
  //    a folded scalar joins them into one glob that matches nothing, and quotes
  //    inside a block scalar are data, so they would ship as part of the pattern.
  const files = input('files');
  if (!files || files.value.trim() !== '|') {
    return fail('the feed upload\'s `files:` is not a literal block scalar (`|`), so its list entries cannot be verified as reaching the feed');
  }
  const filesIndent = indentOf(feed.step.lines[files.at]);
  const entries = feed.step.lines
    .slice(files.at + 1, files.blockEnd)
    .filter((line) => indentOf(line) > filesIndent)
    .map((line) => line.trim());
  for (const fragment of ['dist/latest.yml', 'dist/NV-Gateway-Setup-*.exe.blockmap']) {
    if (!entries.includes(fragment)) {
      return fail(`"${fragment}" is no longer an uploaded artifact of the feed upload (it uploads ${JSON.stringify(entries)})`);
    }
  }

  // ── A glob that matches nothing must fail the release, on THIS step.
  const strict = input('fail_on_unmatched_files');
  if (!strict || unwrapExpression(strict.value).toLowerCase() !== 'true') {
    return fail('the feed upload no longer sets fail_on_unmatched_files: true, so a renamed or missing artifact would publish a release that looks complete and updates nobody');
  }

  // ── A job-level continue-on-error would let the guard fail and the release
  //    carry on regardless. Read from the job's own measured bounds.
  const jobSoft = mappingAt(lines, guard.jobAt + 1, guard.jobBlockEnd, guard.jobKeyIndent)
    .find((entry) => entry.key === 'continue-on-error');
  if (jobSoft && unwrapExpression(jobSoft.value).toLowerCase() !== 'false') {
    return fail(`job "${guard.job}" sets continue-on-error: ${jobSoft.value.trim()}, which lets this guard fail while the release carries on`);
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
