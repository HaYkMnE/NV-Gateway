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
// The baked-feed guard's OWN WIRING was only ever checked from `npm test`, and a
// release never runs `npm test`.
//
// MEASURED, which is why this file exists:
//   .github/workflows/test.yml:3-8   on: push: branches: [main] | pull_request | workflow_dispatch
//   .github/workflows/release.yml:3-7  on: push: tags: ['v*.*.*'] | workflow_dispatch
// A tag ref does NOT match a `branches:` filter, so pushing v1.2.3 runs the
// release pipeline and NOTHING else. Every assertion in
// tests/baked-update-feed-guard.test.mjs — the file that proves
// scripts/verify-baked-update-feed.mjs is actually wired in, after packaging and
// before both uploads — is absent at exactly the moment it matters.
//
// The in-pipeline guard (scripts/release-target-guard.mjs) does run on a tag, and
// it validates the release DESTINATION wiring, but it never mentioned
// verify-baked-update-feed.mjs at all. So the baked-feed guard could be deleted,
// commented out, made conditional, `|| true`-ed, or reordered after the upload,
// and a tag push would publish a build that cannot auto-update with every step
// green. That is the same defect class the baked-feed guard was written to close,
// reopened one level up.
//
// These cases drive the REAL guard against scratch roots. None touches the
// repository's own release.yml.
// ───────────────────────────────────────────────────────────────────────────

const tempRoots = [];

/** A scratch repo root whose release.yml is `text`, plus the scripts the guard needs. */
function makeRoot(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-baked-wiring-${process.pid}-`));
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

/** Run the guard with a reachable feed, so only the WIRING can fail it. */
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

const BAKED_RUN = 'run: node scripts/verify-baked-update-feed.mjs';
const lines = () => REAL_WORKFLOW.split('\n');
const lineOf = (all, needle) => all.findIndex((line) => line.includes(needle));
const A = lines();
const BAKED_STEP = lineOf(A, '- name: Verify the update feed was baked into the package');
const BAKED_RUN_AT = lineOf(A, BAKED_RUN);
const FEED_COMMENT = lineOf(A, '── Destination 1 of 2');
const ARCHIVE_STEP = lineOf(A, '- name: Archive Portable Distribution as ZIP');

/** The whole baked-feed step block, from its `- name:` up to the next step. */
const BAKED_BLOCK = A.slice(BAKED_STEP, ARCHIVE_STEP);

/** Everything below `jobs:` re-indented by two spaces. Still valid YAML. */
function reindentJobs(text) {
  const all = text.split('\n');
  const jobsAt = all.findIndex((line) => /^jobs:\s*$/.test(line));
  return all.map((line, index) => (index > jobsAt && line.trim() !== '' ? `  ${line}` : line)).join('\n');
}

/** The workflow with the baked-feed step removed entirely. */
function withoutBakedStep(all = lines()) {
  return [...all.slice(0, BAKED_STEP), ...all.slice(ARCHIVE_STEP)];
}

// ── Cases that MUST be rejected: the release could publish an unverifiable feed ──
const mustReject = [
  ['the baked-feed guard is deleted outright',
    withoutBakedStep().join('\n'),
    /verify-baked-update-feed/],

  ['the baked-feed guard is commented out, so only its text survives',
    lines()
      .map((line, index) => (index >= BAKED_STEP && index < ARCHIVE_STEP
        ? line.replace(/^(\s*)(\S)/, '$1# $2')
        : line))
      .join('\n'),
    /verify-baked-update-feed/],

  ['`|| true` swallows the baked-feed guard\'s exit code',
    lines().map((line) => line.replace(BAKED_RUN, `${BAKED_RUN} || true`)).join('\n'),
    /chaining|substitution|swallow/i],

  ['a trailing `exit 0` reports success after the guard failed',
    [...lines().slice(0, BAKED_RUN_AT + 1), '          exit 0', ...lines().slice(BAKED_RUN_AT + 1)]
      .map((line) => line.replace(BAKED_RUN, 'run: |\n          node scripts/verify-baked-update-feed.mjs'))
      .join('\n'),
    /SINGLE command|swallow/i],

  ['the baked-feed guard is made conditional, so a false expression skips it',
    [...lines().slice(0, BAKED_RUN_AT), "        if: github.event_name == 'schedule'", ...lines().slice(BAKED_RUN_AT)].join('\n'),
    /conditional|if:/i],

  ['the baked-feed guard is made non-fatal with continue-on-error',
    [...lines().slice(0, BAKED_RUN_AT), '        continue-on-error: true', ...lines().slice(BAKED_RUN_AT)].join('\n'),
    /continue-on-error/i],

  ['the baked-feed guard runs BEFORE packaging, where app-update.yml cannot exist yet',
    (() => {
      const stripped = withoutBakedStep();
      const buildAt = lineOf(stripped, 'run: |');
      const stepStart = stripped.findIndex((line, index) =>
        index < buildAt && line.includes('- name: Build and Package Release Artifacts'));
      return [...stripped.slice(0, stepStart), ...BAKED_BLOCK, ...stripped.slice(stepStart)].join('\n');
    })(),
    /AFTER packaging|does not exist/i],

  ['the baked-feed guard runs AFTER both uploads, so an unverifiable build is already published',
    // Appended as the LAST step of the job: both publishes have already happened
    // by the time the feed is checked, which is the ordering the guard exists to
    // forbid. Placing it merely before "Destination 1 of 2" would still be
    // correctly ordered, so that would prove nothing.
    [...withoutBakedStep(), ...BAKED_BLOCK].join('\n'),
    /BEFORE any upload|before any publish/i],

  ['the baked-feed guard is moved into a second job, where it gates nothing',
    [
      ...withoutBakedStep(),
      '',
      '  verify-feed:',
      '    name: Verify the feed from a second job',
      '    runs-on: windows-latest',
      '    needs: build-release',
      '    steps:',
      ...BAKED_BLOCK
    ].join('\n'),
    /job/i],

  ['the guard is replaced by an echo that never invokes node',
    lines().map((line) => line.replace(BAKED_RUN, 'run: echo scripts/verify-baked-update-feed.mjs')).join('\n'),
    /invoked as|verify-baked-update-feed/i]
];

for (const [title, workflow, expected] of mustReject) {
  test(`rejected: ${title}`, () => {
    const { code, output } = runGuard(makeRoot(workflow));
    assert.equal(code, 1, `this lets a release publish an unverified update feed and must fail the job:\n${output}`);
    assert.match(output, expected, `the message must name the actual problem:\n${output}`);
  });
}

// ── Cases that MUST be accepted: a guard that cries wolf gets deleted ──────────
const mustAccept = [
  ['the workflow exactly as it ships', REAL_WORKFLOW],
  ['four-space job indentation with the wiring left intact', reindentJobs(REAL_WORKFLOW)],
  ['a legitimate flag on the baked-feed guard',
    lines().map((line) => line.replace(BAKED_RUN, `${BAKED_RUN} --verbose`)).join('\n')],
  ['the baked-feed guard invoked through a Windows backslash path',
    lines().map((line) => line.replace(BAKED_RUN, 'run: node scripts\\verify-baked-update-feed.mjs')).join('\n')],
  ['timeout-minutes on the baked-feed guard',
    [...lines().slice(0, BAKED_RUN_AT), '        timeout-minutes: 5', ...lines().slice(BAKED_RUN_AT)].join('\n')],
  ['an actions/upload-artifact step added before the guard, which cannot create a release',
    (() => {
      const all = lines();
      return [
        ...all.slice(0, BAKED_STEP),
        '      - name: Keep the build log',
        '        uses: actions/upload-artifact@v4',
        '        with:',
        '          path: dist/*.exe',
        '',
        ...all.slice(BAKED_STEP)
      ].join('\n');
    })()],
  // The shipping workflow pins the publisher to a commit SHA. Re-pinning it — to a
  // different SHA or back to a tag — must stay a free maintenance edit, and this
  // case asserts it MUTATED something so it cannot rot into a duplicate of the
  // "exactly as it ships" case above the way its first version silently did.
  ['the publisher re-pinned to a different reference',
    (() => {
      const mutated = REAL_WORKFLOW.replace(
        /softprops\/action-gh-release@[0-9a-f]{40}/g,
        'softprops/action-gh-release@v2.7.0');
      assert.notEqual(mutated, REAL_WORKFLOW,
        'this case must actually re-pin the publisher, or it proves nothing');
      return mutated;
    })()]
];

for (const [title, workflow] of mustAccept) {
  test(`accepted: ${title}`, () => {
    const { code, output } = runGuard(makeRoot(workflow));
    assert.equal(code, 0, `a guard that cries wolf on a valid edit is its own defect:\n${output}`);
  });
}

test('no message ever echoes the token value', () => {
  for (const [, workflow] of [...mustReject, ...mustAccept]) {
    const { output } = runGuard(makeRoot(workflow));
    assert.equal(output.includes(FAKE_TOKEN), false, 'the guard must never print the token value');
  }
});

test.after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});
