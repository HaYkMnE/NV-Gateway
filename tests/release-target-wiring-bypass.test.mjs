import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { RELEASE_WORKFLOW_FILE } from '../scripts/release-target-guard.mjs';

const root = path.resolve(import.meta.dirname, '..');
const REAL_WORKFLOW = fs.readFileSync(path.join(root, RELEASE_WORKFLOW_FILE), 'utf8');

// ───────────────────────────────────────────────────────────────────────────
// The wiring check is only as good as the RELATIONSHIP it proves. The first
// version proved a string was present somewhere in the file; the second proved a
// line matched a regex somewhere in the file. Neither is the same as "the step
// that uploads to the feed is configured to reach the feed".
//
// Every case below was MEASURED against the guard before this file existed: each
// "must be rejected" case exited 0, and each "must be accepted" case exited 1.
// All of them are valid YAML — verified with js-yaml at authoring time — and the
// rejected ones each break the destination while the build stays green, which is
// the exact defect the guard exists to prevent:
//
//   * action-gh-release v2.6.2 resolves the destination as
//       github_repository: env.INPUT_REPOSITORY || env.GITHUB_REPOSITORY || ''
//       -- src/util.ts @ v2.6.2
//     so ANY route to an empty `repository:` input silently publishes to the
//     repository the workflow runs in. A `repository:` line that is not an input
//     to the upload step, or an upload step in a job the guard's outputs cannot
//     reach, both take that fallback.
//   * An artifact that moved to a DIFFERENT upload step is still a literal line
//     in the file, but only the guard-resolved upload reaches the feed.
//
// None of these touches the repository's own release.yml: each writes into an
// mkdtemp scratch root that also receives a copy of the guard.
// ───────────────────────────────────────────────────────────────────────────

const tempRoots = [];

function makeRoot(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-wiring-bypass-${process.pid}-`));
  tempRoots.push(dir);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  for (const file of ['release-target-guard.mjs', 'packaging-env-guard.mjs']) {
    fs.copyFileSync(path.join(root, 'scripts', file), path.join(dir, 'scripts', file));
  }
  fs.writeFileSync(path.join(dir, RELEASE_WORKFLOW_FILE), text);
  return dir;
}

const FAKE_TOKEN = 'not-a-real-token-only-wiring-decides';

function runGuard(dir) {
  const result = spawnSync(process.execPath, [path.join(dir, 'scripts', 'release-target-guard.mjs')], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    windowsHide: true,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      windir: process.env.windir,
      TEMP: os.tmpdir(),
      TMP: os.tmpdir(),
      NVGW_GH_OWNER: 'HaYkMnE',
      GITHUB_REPOSITORY: 'HaYkMnE/NV-Gateway',
      // A stray token in the environment must change nothing and never be echoed.
      NVGW_RELEASES_TOKEN: FAKE_TOKEN
    }
  });
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const lines = () => REAL_WORKFLOW.split('\n');
const lineOf = (all, needle) => all.findIndex((line) => line.includes(needle));
const A = lines();
const FEED_COMMENT = lineOf(A, '── Publish: the single destination');
const FEED_STEP = lineOf(A, '- name: Publish the release');
// The publish step is the last step of the file: its block runs to the end.
const FEED_END = A.length - 1;
const GUARD_RUN = lineOf(A, 'run: node scripts/release-target-guard.mjs');
const FEED_IF = "if: startsWith(github.ref, 'refs/tags/') || github.event_name == 'workflow_dispatch'";
const REPO_INPUT = 'repository: ${{ steps.release-target.outputs.feed_repository }}';

/** Everything below `jobs:` re-indented by two spaces. Still valid YAML. */
function reindentJobs(text) {
  const all = text.split('\n');
  const jobsAt = all.findIndex((line) => /^jobs:\s*$/.test(line));
  return all.map((line, index) => (index > jobsAt && line.trim() !== '' ? `  ${line}` : line)).join('\n');
}

/** The feed upload step relocated into a second job, where `steps.` cannot reach it. */
function feedUploadInSecondJob(all = lines()) {
  const block = all.slice(FEED_STEP, FEED_END + 1);
  return [
    ...all.slice(0, FEED_COMMENT),
    '',
    '  publish-feed:',
    '    name: Publish the feed from a second job',
    '    runs-on: ubuntu-latest',
    '    needs: build-release',
    '    steps:',
    ...block
  ].join('\n');
}

const inFeedStep = (index) => index >= FEED_STEP && index <= FEED_END;

/**
 * A second upload step to this repository with no `repository:` input, i.e. one
 * the guard does not treat as the feed upload.
 */
const SECOND_UPLOAD = [
  '',
  '      - name: Second upload with no repository input',
  "        uses: softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65 # v2.6.2",
  '        with:',
  '          token: ${{ secrets.GITHUB_TOKEN }}',
  '          tag_name: ${{ github.ref_name }}',
  '          fail_on_unmatched_files: true',
  '          files: |',
  '            dist/NV-Gateway-*-win-x64.zip'
];

/** Drop a list entry from the FEED step and re-add it to a second upload step. */
function moveArtifactToSecondStep(entry) {
  const kept = lines().filter((line, index) => !(inFeedStep(index) && line.trim() === entry));
  assert.notEqual(kept.length, lines().length, `the feed step must carry ${entry} for this bypass case`);
  return [...kept, ...SECOND_UPLOAD, `            ${entry}`].join('\n');
}

// ── Cases that MUST be rejected: the destination or the feed breaks silently ──
const mustReject = [
  ['a second job holds the feed upload even when the file uses four-space job indentation',
    reindentJobs(feedUploadInSecondJob()),
    /different job|out of scope/i],

  ['the feed upload is disabled with an `if:` expression that evaluates to false',
    lines().map((l, i) => (inFeedStep(i) ? l.replace(FEED_IF, 'if: ${{ false }}') : l)).join('\n'),
    /disabled|never runs|false/i],

  ['the feed upload is disabled with a quoted `if: \'false\'`',
    lines().map((l, i) => (inFeedStep(i) ? l.replace(FEED_IF, "if: 'false'") : l)).join('\n'),
    /disabled|never runs|false/i],

  ['the guard step is made non-fatal with continue-on-error as an expression',
    [...lines().slice(0, GUARD_RUN), '        continue-on-error: ${{ true }}', ...lines().slice(GUARD_RUN)].join('\n'),
    /continue-on-error/i],

  ['the guard step carries an `if:` that keeps it from running, leaving its outputs unset',
    [...lines().slice(0, GUARD_RUN), "        if: github.event_name == 'schedule'", ...lines().slice(GUARD_RUN)].join('\n'),
    /if:|conditional|unset|empty/i],

  ['the repository expression sits in an env: block instead of being the upload input',
    (() => {
      const kept = lines().filter((line) => !line.includes(REPO_INPUT));
      const envAt = kept.findIndex((line) => line.includes('NVGW_FEED_REPOSITORY: ${{ steps.release-target.outputs.feed_repository }}'));
      assert.ok(envAt >= 0, 'the republish guard env block must exist for this bypass case');
      return [...kept.slice(0, envAt + 1), `          ${REPO_INPUT}`, ...kept.slice(envAt + 1)].join('\n');
    })(),
    /repository|input/i],

  ['dist/latest.yml is moved off the feed upload and onto a second upload',
    moveArtifactToSecondStep('dist/latest.yml'),
    /latest\.yml/],

  ['the blockmap is dropped from the feed upload while the literal survives elsewhere',
    lines()
      .filter((line, index) => !(inFeedStep(index) && line.trim() === 'dist/NV-Gateway-Setup-*.exe.blockmap'))
      .join('\n')
      .replace('permissions:', 'x-notes: |\n  dist/NV-Gateway-Setup-*.exe.blockmap\n\npermissions:'),
    /blockmap/],

  ['the release token is moved to a second upload, leaving the feed upload without one',
    (() => {
      const tokenLine = 'token: ${{ secrets.GITHUB_TOKEN }}';
      const kept = lines().filter((line, index) => !(inFeedStep(index) && line.includes(tokenLine)));
      assert.notEqual(kept.length, lines().length, 'the feed upload must carry the token for this bypass case');
      return [...kept, ...SECOND_UPLOAD].join('\n');
    })(),
    /GITHUB_TOKEN/],

  ['the artifact list is a folded scalar, so every entry collapses into one glob that matches nothing',
    lines().map((l, i) => (inFeedStep(i) ? l.replace('files: |', 'files: >') : l)).join('\n'),
    /latest\.yml|blockmap|list entr/i],

  ['indentation uses tabs, which GitHub Actions cannot parse at all',
    REAL_WORKFLOW.replace(/^ {8}/gm, '\t\t\t\t'),
    /tab/i]
];

for (const [title, workflow, expected] of mustReject) {
  test(`rejected: ${title}`, () => {
    const { code, output } = runGuard(makeRoot(workflow));
    assert.equal(code, 1, `this breaks the release destination and must fail the job:\n${output}`);
    assert.match(output, expected, `the message must name the actual problem:\n${output}`);
  });
}

// ── Cases that MUST be accepted: valid edits a guard may not cry wolf over ────
const mustAccept = [
  ['the workflow exactly as it ships', REAL_WORKFLOW],
  ['a consistent rename of the guard id and its reference', lines()
    .map((line) => line
      .replace('id: release-target', 'id: renamed-guard')
      .replace('steps.release-target.outputs.feed_repository', 'steps.renamed-guard.outputs.feed_repository'))
    .join('\n')],
  ['four-space job indentation with the wiring left intact', reindentJobs(REAL_WORKFLOW)],
  ['the guard id written as a single-quoted scalar', lines()
    .map((line) => line.replace('id: release-target', "id: 'release-target'")).join('\n')],
  ['the guard id written as a double-quoted scalar', lines()
    .map((line) => line.replace('id: release-target', 'id: "release-target"')).join('\n')],
  ['the repository input written as a double-quoted scalar', lines()
    .map((line) => line.replace(REPO_INPUT, `repository: "\${{ steps.release-target.outputs.feed_repository }}"`)).join('\n')],
  ['the guard invoked through a Windows backslash path, which is what windows-latest runs', lines()
    .map((line) => line.replace('run: node scripts/release-target-guard.mjs', 'run: node scripts\\release-target-guard.mjs')).join('\n')],
  ['an extra upload step to this repository that deliberately has no repository: input', [
    ...lines(), '',
    '  extra:', '    runs-on: ubuntu-latest', '    needs: build-release', '    steps:',
    '      - name: Extra upload to this repository',
    '        uses: softprops/action-gh-release@v2.6.2',
    '        with:', '          tag_name: ${{ github.ref_name }}',
    '          token: ${{ secrets.GITHUB_TOKEN }}',
    '          fail_on_unmatched_files: true', '          files: |', '            dist/SHA256SUMS.txt'
  ].join('\n')]
];

for (const [title, workflow] of mustAccept) {
  test(`accepted: ${title}`, () => {
    const { code, output } = runGuard(makeRoot(workflow));
    assert.equal(code, 0, `a guard that cries wolf on a valid edit is its own defect:\n${output}`);
  });
}

test('no rejection message ever echoes the token value', () => {
  for (const [, workflow] of [...mustReject, ...mustAccept]) {
    const { output } = runGuard(makeRoot(workflow));
    assert.equal(output.includes(FAKE_TOKEN), false, 'the guard must never print the token value');
  }
});

test.after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});
