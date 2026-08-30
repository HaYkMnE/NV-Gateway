import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { RELEASES_TOKEN_SECRET, RELEASE_WORKFLOW_FILE } from '../scripts/release-target-guard.mjs';

const root = path.resolve(import.meta.dirname, '..');
const REAL_WORKFLOW = fs.readFileSync(path.join(root, RELEASE_WORKFLOW_FILE), 'utf8');

// ───────────────────────────────────────────────────────────────────────────
// The destination guard validates the workflow's WIRING, and that validation has
// to survive edits that a plain substring test cannot see.
//
// Why this file exists, measured rather than assumed: the first version of the
// guard checked `workflow.includes(fragment)` against the RAW file text. Fifteen
// breaking mutations were applied to a scratch copy of release.yml and the guard
// exited 0 — accepting a broken release — on ten of them, including:
//   * the whole feed-upload step commented out with `#`
//   * `repository:` replaced by a hardcoded literal while the expected fragment
//     survived in a trailing comment on the same line
//   * `token:` deleted
//   * `fail_on_unmatched_files: true` flipped to false
//   * `dist/latest.yml` and the blockmap glob commented out
//   * `continue-on-error: true` added to the guard step itself
//
// The two most dangerous slipped past the committed structural tests as well:
//
//  1. DANGLING STEP REFERENCE. Rename the guard's `id:` and leave
//     `steps.release-target.outputs.feed_repository` pointing at the old name.
//     action-gh-release v2.6.2 resolves the destination as
//       github_repository: env.INPUT_REPOSITORY || env.GITHUB_REPOSITORY || ''
//       -- src/util.ts, https://github.com/softprops/action-gh-release/blob/v2.6.2/src/util.ts
//     An expression naming a step id that does not exist expands to the EMPTY
//     STRING, so `repository:` is empty, the `||` falls through, and the upload
//     lands in the repository the workflow runs in. That is precisely the drift
//     the guard was written to prevent, restored with a fully green build.
//
//  2. UPLOAD IN A DIFFERENT JOB. `steps.<id>.outputs` is scoped per job, so a
//     feed upload moved into a second job reads an empty destination and takes
//     the same silent fallback.
//
// Every case below spawns the real guard against a scratch root. None of them
// touches the repository's own release.yml.
// ───────────────────────────────────────────────────────────────────────────

const tempRoots = [];

/** A scratch repo root whose release.yml is `text`, plus the scripts the guard needs. */
function makeRoot(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-release-wiring-${process.pid}-`));
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

/** Run the guard in `dir` with a reachable feed, so only the WIRING can fail it. */
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
      [RELEASES_TOKEN_SECRET]: FAKE_TOKEN
    }
  });
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const lines = () => REAL_WORKFLOW.split('\n');
const lineOf = (all, needle) => all.findIndex((line) => line.includes(needle));

const FEED_COMMENT = lineOf(lines(), '── Destination 1 of 2');
const FEED_STEP = lineOf(lines(), '- name: Publish to the update feed repository');
const SRC_COMMENT = lineOf(lines(), '── Destination 2 of 2');
const FEED_END = SRC_COMMENT - 1;

/** Replace a list entry inside the feed step with a commented-out copy of itself. */
function commentOutEntry(entry) {
  const all = lines();
  return all
    .map((line, index) => (index >= FEED_STEP && index <= FEED_END && line.trim() === entry
      ? `            # ${entry}`
      : line))
    .join('\n');
}

test('the guard accepts the release workflow as it actually ships', () => {
  // Guards that cry wolf get deleted. The real file must pass untouched.
  const { code, output } = runGuard(makeRoot(REAL_WORKFLOW));
  assert.equal(code, 0, `the shipping release.yml must satisfy its own wiring guard:\n${output}`);
  assert.match(output, /update feed: github\.com\/HaYkMnE\/NV-Gateway-releases/);
});

test('a dangling step reference is rejected, because the upload would silently fall back', () => {
  // action-gh-release resolves repository as INPUT_REPOSITORY || GITHUB_REPOSITORY,
  // so an id that does not exist means "publish to this repo" — the original defect.
  const mutated = lines().map((line) => line.replace('id: release-target', 'id: renamed-guard')).join('\n');
  const { code, output } = runGuard(makeRoot(mutated));
  assert.equal(code, 1, `a dangling steps.<id> reference must fail the release:\n${output}`);
  assert.match(output, /expands to EMPTY|silently fall back/i,
    'the message must explain that the destination expands to empty and falls back');
});

test('renaming the guard id is allowed when the reference is updated with it', () => {
  // The rule is consistency, not a frozen spelling: a real refactor must pass.
  const mutated = lines()
    .map((line) => line
      .replace('id: release-target', 'id: renamed-guard')
      .replace('steps.release-target.outputs.feed_repository', 'steps.renamed-guard.outputs.feed_repository'))
    .join('\n');
  const { code, output } = runGuard(makeRoot(mutated));
  assert.equal(code, 0, `a consistent rename must still pass:\n${output}`);
});

test('moving the feed upload into another job is rejected', () => {
  // steps.<id>.outputs is per-job scope; in a second job it reads empty.
  const all = lines();
  const stepBlock = all.slice(FEED_STEP, FEED_END + 1);
  const mutated = [
    ...all.slice(0, FEED_COMMENT),
    ...all.slice(SRC_COMMENT),
    '',
    '  publish-feed:',
    '    name: Publish the feed from a second job',
    '    runs-on: ubuntu-latest',
    '    needs: build-release',
    '    steps:',
    ...stepBlock
  ].join('\n');
  const { code, output } = runGuard(makeRoot(mutated));
  assert.equal(code, 1, `an upload outside the guard's job must fail the release:\n${output}`);
  assert.match(output, /different job|out of scope/i);
});

test('commenting the feed upload out does not satisfy the guard', () => {
  // Only executable YAML can publish an artifact. A '#' in front of every line
  // used to keep every required fragment "present" in the raw text.
  const all = lines();
  const mutated = all
    .map((line, index) => (index >= FEED_STEP && index <= FEED_END
      ? line.replace(/^(\s*)(\S)/, '$1# $2')
      : line))
    .join('\n');
  const { code, output } = runGuard(makeRoot(mutated));
  assert.equal(code, 1, `a commented-out feed upload must fail the release:\n${output}`);
});

test('a hardcoded repository literal is rejected even when a comment still names the output', () => {
  // The fragment surviving in a trailing comment is exactly how a text-only check
  // was fooled while the destination had been pinned to a second literal.
  const mutated = lines()
    .map((line) => line.replace(
      'repository: ${{ steps.release-target.outputs.feed_repository }}',
      'repository: HaYkMnE/NV-Gateway-releases  # was steps.release-target.outputs.feed_repository'))
    .join('\n');
  const { code, output } = runGuard(makeRoot(mutated));
  assert.equal(code, 1, `a literal destination must fail even with the fragment in a comment:\n${output}`);
});

test('dropping the cross-repo token is rejected', () => {
  // GITHUB_TOKEN cannot create a release in another repository.
  const mutated = lines()
    .filter((line) => !line.includes(`token: \${{ secrets.${RELEASES_TOKEN_SECRET} }}`))
    .join('\n');
  const { code, output } = runGuard(makeRoot(mutated));
  assert.equal(code, 1, `removing the PAT must fail the release:\n${output}`);
  assert.match(output, new RegExp(RELEASES_TOKEN_SECRET));
});

test('turning fail_on_unmatched_files off is rejected', () => {
  // A partially populated feed looks published and updates nobody.
  const all = lines();
  const mutated = all
    .map((line, index) => (index >= FEED_STEP && index <= FEED_END
      ? line.replace('fail_on_unmatched_files: true', 'fail_on_unmatched_files: false')
      : line))
    .join('\n');
  const { code, output } = runGuard(makeRoot(mutated));
  assert.equal(code, 1, `fail_on_unmatched_files: false must fail the release:\n${output}`);
});

test('commenting out an updater artifact is rejected', () => {
  for (const entry of ['dist/latest.yml', 'dist/NV-Gateway-Setup-*.exe.blockmap']) {
    const { code, output } = runGuard(makeRoot(commentOutEntry(entry)));
    assert.equal(code, 1, `"${entry}" must be an executable list entry, not a comment:\n${output}`);
    assert.match(output, /no longer an uploaded artifact/);
  }
});

test('making the guard step itself non-fatal is rejected', () => {
  // continue-on-error would restore the silent-success mode the guard removes.
  const all = lines();
  const guardRun = lineOf(all, 'run: node scripts/release-target-guard.mjs');
  const mutated = [...all.slice(0, guardRun), '        continue-on-error: true', ...all.slice(guardRun)].join('\n');
  const { code, output } = runGuard(makeRoot(mutated));
  assert.equal(code, 1, `continue-on-error: true must fail the release:\n${output}`);
  assert.match(output, /continue-on-error/);
});

test('the guard never echoes the token value', () => {
  // It receives the secret to tell present from absent; it must never print it.
  for (const workflow of [REAL_WORKFLOW, commentOutEntry('dist/latest.yml')]) {
    const { output } = runGuard(makeRoot(workflow));
    assert.equal(output.includes(FAKE_TOKEN), false, 'the guard must never print the token value');
  }
});

test.after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});
