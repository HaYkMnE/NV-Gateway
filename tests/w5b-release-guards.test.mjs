import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

import {
  decideRepublish,
  expectedTagForVersion,
  isReleaseTag,
  probeRelease,
  readGuardEnvironment,
  RELEASE_TAG_PATTERN
} from '../scripts/republish-guard.mjs';
import {
  findFuseViolation,
  REQUIRED_FUSE_STATES
} from '../scripts/harden-windows-package.mjs';
import {
  REQUIRED_ASSERTIONS,
  REQUIRED_FUSE_ASSERTIONS
} from '../scripts/packaged-security-smoke.mjs';
import { FuseV1Options } from '@electron/fuses';

const root = path.resolve(import.meta.dirname, '..');
const workflowPath = path.join(root, '.github', 'workflows', 'release.yml');
const workflowText = fs.readFileSync(workflowPath, 'utf8');
const workflow = yaml.load(workflowText);

const allSteps = () => Object.entries(workflow.jobs ?? {})
  .flatMap(([jobId, job]) => (job.steps ?? []).map((step, index) => ({ jobId, index, step })));
const stepNamed = (name) => allSteps().find(({ step }) => step.name === name)?.step;

// ─────────────────────────────────────────────────────────────────────────────
// W5b — the guards added on top of the W5 set. Every case is asserted against
// the REAL files or the REAL exported functions, and every guard is then
// mutation-tested: a guard that cannot fail proves nothing.
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. Tag format ────────────────────────────────────────────────────────────

test('W5b-1: the tag format is ^v<major>.<minor>.<patch>$, case-sensitive', () => {
  for (const good of ['v0.1.0', 'v1.2.3', 'v10.20.30', 'v0.0.0']) {
    assert.equal(isReleaseTag(good), true, `${good} must be accepted`);
  }
  // Case matters: git refs are case-sensitive, and the version compare is built
  // from a literal lowercase "v", so an uppercase V must not slip through here.
  for (const bad of ['V0.1.0', 'v1.2', 'v1.2.3.4', 'v1.2.3-rc1', 'v1.2.3 ', ' 1.2.3',
    'release-v1.2.3', 'v01.2.3x', '', 'v', 'v1..3', 'v1.2.x']) {
    assert.equal(isReleaseTag(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
  assert.equal(RELEASE_TAG_PATTERN.source, '^v\\d+\\.\\d+\\.\\d+$');
  // And the expected tag is a literal "v" plus the version, unmodified.
  assert.equal(expectedTagForVersion('0.1.1'), 'v0.1.1');
  assert.equal(expectedTagForVersion('1.0.0'), 'v1.0.0');
});

test('W5b-1: the workflow gate applies the format check before the version compare', () => {
  const gate = stepNamed('Verify the release tag matches package.json');
  assert.ok(gate, 'the version gate must exist');
  const formatAt = gate.run.indexOf('-cnotmatch');
  const compareAt = gate.run.indexOf('-cne $expected');
  assert.ok(formatAt >= 0, 'the gate must pin the tag format');
  assert.ok(compareAt > formatAt, 'the format check must run before the version compare');
  // Case-sensitive both times. `-ne`/`-notmatch` would accept "V0.1.1".
  assert.match(gate.run, /\$actual\s+-cnotmatch/, 'the format check must be case-sensitive');
  assert.match(gate.run, /\$actual\s+-cne\s+\$expected/, 'the version compare must be case-sensitive');
  assert.doesNotMatch(gate.run, /\$actual\s+-ne\s+\$expected/, 'a case-insensitive compare must not be present');
  assert.doesNotMatch(gate.run, /\$actual\s+-notmatch/, 'a case-insensitive format check must not be present');
});

// ── 1b. Checkout does not persist GITHUB_TOKEN ───────────────────────────────

// actions/checkout writes the job token into .git/config unless told not to.
// In release.yml that token carries contents: write, and npm ci lifecycle
// scripts plus the build run afterwards with the checkout readable.
const checkoutsWithoutPersistOff = (wf) => Object.entries(wf.jobs ?? {})
  .flatMap(([jobId, job]) => (job.steps ?? []).map((step, index) => ({ jobId, index, step })))
  .filter(({ step }) => String(step.uses ?? '').startsWith('actions/checkout@'))
  .filter(({ step }) => step.with?.['persist-credentials'] !== false)
  .map(({ jobId, index }) => `${jobId}#${index}`);

test('W5b-1b: every checkout in release.yml and test.yml sets persist-credentials: false', () => {
  const testWorkflow = yaml.load(fs.readFileSync(path.join(root, '.github', 'workflows', 'test.yml'), 'utf8'));
  for (const [name, wf] of [['release.yml', workflow], ['test.yml', testWorkflow]]) {
    const checkouts = Object.values(wf.jobs ?? {}).flatMap((job) => job.steps ?? [])
      .filter((step) => String(step.uses ?? '').startsWith('actions/checkout@'));
    assert.ok(checkouts.length > 0, `${name} must have a checkout to guard`);
    assert.deepEqual(checkoutsWithoutPersistOff(wf), [], `${name}: checkout must not persist the token`);
  }
  // Mutation: dropping the setting must be detected.
  const mutated = yaml.load(workflowText.replace(/^\s*persist-credentials: false\s*$/m, ''));
  assert.notDeepEqual(checkoutsWithoutPersistOff(mutated), [], 'the guard must fail when the setting is removed');
});

// ── 2. Tag commit == HEAD ────────────────────────────────────────────────────

test('W5b-2: the gate requires the tag to point at HEAD, with history available', () => {
  const gate = stepNamed('Verify the release tag matches package.json');
  assert.match(gate.run, /git rev-list -n 1 "refs\/tags\/\$actual"/,
    'the tag\'s commit must be resolved from the tag ref itself');
  assert.match(gate.run, /git rev-parse HEAD/, 'HEAD must be resolved');
  assert.match(gate.run, /\$tagCommit\s+-cne\s+\$headCommit/,
    'a tag on another commit must fail, case-sensitively');

  // Without full history the tag object is not fetched and the resolve step
  // returns empty — a legitimate release would fail. Both are required together.
  const checkout = allSteps().find(({ step }) => String(step.uses ?? '').startsWith('actions/checkout@'))?.step;
  assert.ok(checkout, 'the workflow must check out the repository');
  assert.equal(checkout.with?.['fetch-depth'], 0, 'fetch-depth: 0 is required to resolve the tag');
  // The checked-out tree must be the tag being released, not the default ref: on a
  // manual dispatch `ref_name` is the branch, and the gate would then compare the
  // tag against a different tree's package.json.
  assert.match(String(checkout.with?.ref ?? ''), /inputs\.tag_name/,
    'checkout must use the tag input on workflow_dispatch');
  assert.match(String(checkout.with?.ref ?? ''), /github\.ref_name/,
    'checkout must fall back to the pushed ref on a tag push');

  // $LASTEXITCODE must be captured IMMEDIATELY after the rev-list. It is a global
  // overwritten by the next native command, so reading it after `git rev-parse
  // HEAD` tests rev-parse's status: a nonexistent tag then reported "HEAD != <empty>"
  // instead of naming the real cause. MEASURED: the first version of this gate did
  // exactly that and blamed a commit mismatch for a missing tag.
  //
  // Matched on the EXECUTABLE lines (`$headCommit = (git rev-parse HEAD)`), not on
  // the bare command text: the explanatory comment above also names the command,
  // and a substring search would land inside the comment.
  const revListAt = gate.run.search(/^\s*\$tagCommit = \(git rev-list -n 1/m);
  const headAt = gate.run.search(/^\s*\$headCommit = \(git rev-parse HEAD\)/m);
  assert.ok(revListAt >= 0 && headAt > revListAt, 'both git commands must be present, rev-list first');
  const between = gate.run.slice(revListAt, headAt);
  assert.match(between, /\$tagExit\s*=\s*\$LASTEXITCODE/,
    '$LASTEXITCODE must be captured into a variable before the next native command runs');
  assert.match(gate.run, /if \(\$tagExit -ne 0/,
    'the captured exit code must be what the resolve failure tests');
  assert.doesNotMatch(between, /^\s*if \(\$LASTEXITCODE -ne 0/m,
    'the raw $LASTEXITCODE must not be tested after another native command has run');
});

// ── 3. Republish refusal ─────────────────────────────────────────────────────

test('W5b-3: the republish guard refuses an existing release and only accepts a 404', () => {
  // 404 on every queried destination is the ONLY passing shape (the decision
  // stays list-based, so it also holds for more than one repository).
  assert.deepEqual(decideRepublish([{ repository: 'o/feed', status: 404 }, { repository: 'o/src', status: 404 }]),
    { ok: true });

  // An existing release fails, and the message carries the measured truth.
  const existing = decideRepublish([{ repository: 'o/feed', status: 200 }, { repository: 'o/src', status: 404 }]);
  assert.equal(existing.ok, false);
  assert.match(existing.error, /o\/feed already has a release/);
  assert.match(existing.error, /already exists and overwrite_files is false/,
    'the message must record how the action actually behaves, not a guess');
  assert.match(existing.error, /fail_on_unmatched_files` does not apply/,
    'the message must record that the unmatched-files guard does not help');

  // Every non-404 status is an unknown, and an unknown is NOT permission. This is
  // the half that a "status !== 200 => proceed" guard would get wrong.
  for (const status of [401, 403, 429, 500, 502, 302, 204]) {
    const result = decideRepublish([{ repository: 'o/feed', status }]);
    assert.equal(result.ok, false, `HTTP ${status} must not be read as "unpublished"`);
    assert.match(result.error, new RegExp(`HTTP ${status}`));
  }

  // A transport failure has no status at all. Treating it as 404 would publish
  // into an unknown state.
  const network = decideRepublish([{ repository: 'o/feed', status: null, error: 'ECONNRESET' }]);
  assert.equal(network.ok, false);
  assert.match(network.error, /could not query o\/feed/);
  assert.match(network.error, /ECONNRESET/);

  // No destination queried proves nothing.
  assert.equal(decideRepublish([]).ok, false);
  assert.equal(decideRepublish(undefined).ok, false);
});

test('W5b-3: the guard probes the single release repository', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init?.headers?.authorization });
    return { status: 404 };
  };
  const config = readGuardEnvironment({
    NVGW_RELEASE_TAG: 'v0.1.1',
    NVGW_GH_OWNER: 'HaYkMnE',
    NVGW_FEED_REPOSITORY: 'HaYkMnE/NV-Gateway',
    GITHUB_TOKEN: 'x'
  });
  assert.equal(config.ok, true);
  assert.deepEqual(config.repositories, ['HaYkMnE/NV-Gateway'],
    'releases go to ONE repository, so exactly that repository is queried');

  for (const repository of config.repositories) {
    await probeRelease({ repository, tag: config.tag, token: config.token, fetchImpl });
  }
  assert.equal(seen.length, 1, 'the one destination must be queried');
  assert.match(seen[0].url, /\/repos\/HaYkMnE\/NV-Gateway\/releases\/tags\/v0\.1\.1$/);
  assert.equal(seen[0].auth, 'Bearer x', 'the lookup authenticates with the workflow token');

  // A bare repository name resolves against the owner.
  const bare = readGuardEnvironment({
    NVGW_RELEASE_TAG: 'v0.1.1',
    NVGW_GH_OWNER: 'HaYkMnE',
    NVGW_FEED_REPOSITORY: 'NV-Gateway',
    GITHUB_TOKEN: 'x'
  });
  assert.deepEqual(bare.repositories, ['HaYkMnE/NV-Gateway']);

  // The retired PAT is not a substitute for the workflow token.
  const patOnly = readGuardEnvironment({
    NVGW_RELEASE_TAG: 'v0.1.1',
    NVGW_GH_OWNER: 'HaYkMnE',
    NVGW_FEED_REPOSITORY: 'HaYkMnE/NV-Gateway',
    NVGW_RELEASES_TOKEN: 'x'
  });
  assert.equal(patOnly.ok, false, 'only GITHUB_TOKEN may authenticate the lookup');
  assert.match(patOnly.error, /GITHUB_TOKEN is required/);
});

test('CRF-003: a hung GitHub fetch times out and FAILS CLOSED', async () => {
  let receivedSignal;
  // Never resolves on its own; only the abort signal can end it.
  const hungFetch = (_url, init) => new Promise((_resolve, reject) => {
    receivedSignal = init?.signal;
    init?.signal?.addEventListener('abort', () => reject(init.signal.reason));
  });
  const started = Date.now();
  // AbortSignal.timeout() arms an UNREF'D timer, and the fake fetch above holds no
  // socket, so nothing keeps the event loop alive while it waits. Measured on
  // Node 22.23.4 (the CI runtime): the loop drains before the 50 ms abort fires and
  // node:test cancels this test ("Promise resolution is still pending but the event
  // loop has already resolved"), cascading to every later test in the file. A real
  // fetch holds a ref'd socket, so production is unaffected. This ref'd keep-alive
  // only stands in for that socket; it does not end the request.
  const keepAlive = setInterval(() => {}, 1_000);
  let probe;
  try {
    probe = await probeRelease({ repository: 'o/feed', tag: 'v0.1.1', token: 'x', fetchImpl: hungFetch, timeoutMs: 50 });
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(receivedSignal instanceof AbortSignal, 'fetch must receive an AbortSignal');
  assert.ok(Date.now() - started < 5_000, 'the timeout must end the hung request');
  assert.equal(probe.status, null);
  assert.equal(typeof probe.error, 'string');
  assert.ok(probe.error.length > 0);

  const decision = decideRepublish([probe]);
  assert.equal(decision.ok, false, 'a timeout must never mean "proceed"');
  assert.match(decision.error, /could not query o\/feed/);

  // The production default is the 15 s budget.
  const source = fs.readFileSync(path.join(root, 'scripts', 'republish-guard.mjs'), 'utf8');
  assert.match(source, /signal: AbortSignal\.timeout\(timeoutMs\)/);
  assert.match(source, /timeoutMs = 15_000/);
});

test('W5b-3: the guard rejects incomplete configuration instead of guessing', () => {
  const base = {
    NVGW_RELEASE_TAG: 'v0.1.1',
    NVGW_GH_OWNER: 'HaYkMnE',
    NVGW_FEED_REPOSITORY: 'HaYkMnE/NV-Gateway',
    GITHUB_TOKEN: 'x'
  };
  assert.equal(readGuardEnvironment(base).ok, true);

  for (const [label, patch, expected] of [
    ['a malformed tag', { NVGW_RELEASE_TAG: 'V0.1.1' }, /must match/],
    ['a missing owner', { NVGW_GH_OWNER: '' }, /NVGW_GH_OWNER is required/],
    ['a missing feed repository', { NVGW_FEED_REPOSITORY: '' }, /NVGW_FEED_REPOSITORY is required/],
    // An unset GitHub secret expands to an EMPTY STRING, never to an error.
    ['a blank token', { GITHUB_TOKEN: '   ' }, /GITHUB_TOKEN is required/]
  ]) {
    const result = readGuardEnvironment({ ...base, ...patch });
    assert.equal(result.ok, false, `${label} must fail`);
    assert.match(result.error, expected, `${label}: wrong reason`);
  }
});

test('W5b-3: the guard is wired before npm ci and before every upload', () => {
  const steps = allSteps();
  const guardAt = steps.findIndex(({ step }) => step.name === 'Refuse to republish a published tag');
  assert.ok(guardAt >= 0, 'release.yml must refuse to republish a published tag');

  const guard = steps[guardAt].step;
  // The destination it must query comes from the guard that resolved the feed, so
  // the two cannot drift.
  assert.match(String(guard.env?.NVGW_FEED_REPOSITORY), /steps\.release-target\.outputs\.feed_repository/,
    'the feed destination must come from the destination guard');
  assert.equal(guard.env?.NVGW_SOURCE_REPOSITORY, undefined,
    'there is no second (archive) destination any more');
  assert.equal(guard.env?.GITHUB_TOKEN, '${{ secrets.GITHUB_TOKEN }}',
    'the lookup must use the workflow token, not a personal access token');
  assert.equal(guard.env?.NVGW_RELEASES_TOKEN, undefined, 'the retired PAT must not be wired');
  assert.equal(guard.env?.NVGW_RELEASE_TAG, '${{ github.event_name == \'workflow_dispatch\' && inputs.tag_name || github.ref_name }}',
    'the tag must be the same expression every publish step uses, passed via env (never interpolated into the shell)');
  assert.doesNotMatch(guard.run, /\$\{\{/, 'the tag must not be interpolated into the script body');
  // No soft failure, no condition: either would restore the silent green no-op.
  assert.equal('if' in guard, false, 'the republish guard must not be conditional');
  assert.equal('continue-on-error' in guard, false, 'the republish guard must not fail softly');

  const installAt = steps.findIndex(({ step }) => typeof step.run === 'string' && /npm ci/.test(step.run));
  assert.ok(guardAt < installAt, 'the republish guard must run before npm ci');
  for (const { step } of steps.filter(({ step }) => String(step.uses ?? '').startsWith('softprops/'))) {
    const uploadAt = steps.findIndex(({ step: candidate }) => candidate === step);
    assert.ok(guardAt < uploadAt, `the republish guard must run before "${step.name}"`);
  }
});

// ── 4. The false "FAILS LOUDLY" claim is gone ────────────────────────────────

test('W5b-4: the workflow records the MEASURED duplicate-publish behaviour', () => {
  assert.equal(workflowText.includes('the release fails LOUDLY'), false,
    'the false claim must be removed, not softened');
  assert.match(workflowText, /already exists and overwrite_files is false/,
    'the measured behaviour of the upload action must be recorded');
  assert.match(workflowText, /returns null/, 'the null return is the reason the step looks green');
  assert.match(workflowText, /fail_on_unmatched_files` does not apply/,
    'it must state why the unmatched-files guard does not catch a republish');
  // And it must point at the guard that DOES catch it.
  assert.match(workflowText, /Refuse to republish a published tag/,
    'the comment must point at the guard that fails instead');
});

// ── 5. Node 22 ──────────────────────────────────────────────────────────────

test('W5b-5: CI uses a Node version that satisfies @electron/fuses', () => {
  const setup = allSteps().find(({ step }) => String(step.uses ?? '').startsWith('actions/setup-node@'))?.step;
  assert.ok(setup, 'the workflow must set up Node');
  const required = fs.readFileSync(path.join(root, 'node_modules', '@electron', 'fuses', 'package.json'), 'utf8');
  const engines = JSON.parse(required).engines?.node ?? '';
  // The declared floor is what makes 20.x unusable: the afterPack hook imports
  // this package, so packaging on 20.x runs a module that DECLARES ITSELF
  // unsupported there. Measured on 20.18.0: it imports fine, so the wording must
  // not claim a load failure — the objection is the declared engines range.
  assert.match(engines, />=\s*22\.12\.0/, 'the fixture assumption changed: @electron/fuses no longer requires >=22.12.0');
  assert.equal(setup.with?.['node-version'], '22.x', 'CI must use 22.x, which satisfies >=22.12.0');
  assert.doesNotMatch(String(setup.with?.['node-version']), /^20\./,
    'Node 20.x is below the range @electron/fuses declares itself supported on');
});

// ── 6. The smoke gate iterates the shared fuse table ─────────────────────────

test('W5b-6: the packaged smoke gate derives its fuse assertions from REQUIRED_FUSE_STATES', () => {
  // Every required fuse must appear as an assertion, with the required polarity.
  for (const [option, required] of Object.entries(REQUIRED_FUSE_STATES)) {
    const name = `fuse_${FuseV1Options[option]}`;
    assert.equal(REQUIRED_FUSE_ASSERTIONS[name], required ? 'enabled' : 'disabled',
      `${name} must be asserted ${required ? 'enabled' : 'disabled'}`);
    assert.ok(REQUIRED_ASSERTIONS.includes(name),
      `${name} must be in REQUIRED_ASSERTIONS, or package:audit does not check it`);
  }

  // The two fuses that must be OFF were the measured hole: they were enabled in
  // the shipped exe while package:audit passed. They must be present here.
  for (const name of ['fuse_EnableNodeOptionsEnvironmentVariable', 'fuse_EnableNodeCliInspectArguments']) {
    assert.ok(REQUIRED_ASSERTIONS.includes(name), `${name} must be enforced by the smoke gate`);
    assert.equal(REQUIRED_FUSE_ASSERTIONS[name], 'disabled', `${name} must be required OFF`);
  }
  // And the four that must be ON (EnableCookieEncryption added on Electron 44:
  // hardening, no cookie use).
  for (const name of ['fuse_EnableEmbeddedAsarIntegrityValidation', 'fuse_OnlyLoadAppFromAsar', 'fuse_RunAsNode', 'fuse_EnableCookieEncryption']) {
    assert.equal(REQUIRED_FUSE_ASSERTIONS[name], 'enabled', `${name} must be required ON`);
  }

  // Six fuses from the table, plus the two integrity-resource assertions.
  assert.equal(Object.keys(REQUIRED_FUSE_ASSERTIONS).length, Object.keys(REQUIRED_FUSE_STATES).length);
  assert.ok(REQUIRED_ASSERTIONS.includes('asarIntegrityResourceEmbedded'));
  assert.ok(REQUIRED_ASSERTIONS.includes('asarIntegrityHashMatchesArchive'));
  assert.equal(REQUIRED_ASSERTIONS.length, 10 + Object.keys(REQUIRED_FUSE_STATES).length + 2);
});

test('W5b-6: a fuse flipped in the table changes what the smoke gate demands', () => {
  // The point of deriving the assertions is that they cannot drift from the flip.
  // Proven by re-deriving from a MUTATED table: the assertion polarity must follow.
  const mutated = { ...REQUIRED_FUSE_STATES, [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: true };
  const derived = Object.fromEntries(Object.entries(mutated).map(([option, required]) => [
    `fuse_${FuseV1Options[option]}`, required ? 'enabled' : 'disabled'
  ]));
  assert.equal(derived.fuse_EnableNodeOptionsEnvironmentVariable, 'enabled',
    'the assertion must follow the table rather than a hardcoded polarity');
  assert.notEqual(derived.fuse_EnableNodeOptionsEnvironmentVariable,
    REQUIRED_FUSE_ASSERTIONS.fuse_EnableNodeOptionsEnvironmentVariable,
    'the mutation must actually change the derived assertion, or this case is vacuous');
});

test('W5b-6: the smoke gate FAILS on the real unhardened binary', (t) => {
  const exe = path.join(root, 'dist', 'win-unpacked', 'NV-Gateway.exe');
  if (!fs.existsSync(exe)) {
    t.skip('no packaged output to inspect');
    return;
  }
  // Static read only — the fuse wire is parsed out of the binary, nothing runs.
  return import('../scripts/harden-windows-package.mjs').then(async ({ readFuseStates }) => {
    const fuses = await readFuseStates(exe);
    // If this binary has the two code-execution fuses ON, the gate above MUST be
    // reporting a failure. Asserting the pair keeps the two facts tied together:
    // the observed state and what the gate does about it.
    const nodeOptionsOn = fuses.EnableNodeOptionsEnvironmentVariable === 'enabled';
    const inspectOn = fuses.EnableNodeCliInspectArguments === 'enabled';
    if (!nodeOptionsOn && !inspectOn) {
      t.skip('this packaged output is already hardened');
      return;
    }
    const violation = findFuseViolation(fuses);
    assert.ok(violation, 'an unhardened binary must produce a fuse violation');
    assert.match(violation, /EnableNodeOptionsEnvironmentVariable|EnableNodeCliInspectArguments/,
      'the violation must name the code-execution fuse that is on');
  });
});

// ── 7. ClearErrors in the NSIS include ──────────────────────────────────────

test('W5b-7: the HKLM mirror clears the expected-absent error flag', () => {
  const include = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
  const lines = include.split('\n');
  const hklm = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => /^DeleteRegValue\s+HKLM\b/.test(line));

  assert.equal(hklm.length, 2, 'both HKLM mirror deletes must still be present');
  for (const { line, index } of hklm) {
    // DeleteRegValue on an absent value sets the NSIS error flag, and on a
    // per-user install (nsis.perMachine is false) both are expected absent. The
    // flag must be cleared before the uninstaller continues, or a healthy
    // per-user uninstall reports failure.
    const after = lines.slice(index + 1, index + 3).map((entry) => entry.trim());
    assert.ok(after.includes('ClearErrors'),
      `ClearErrors must follow "${line}" (found ${JSON.stringify(after)})`);
  }

  // The clears must live inside customUnInstall, not somewhere that never runs.
  const macroStart = lines.findIndex((line) => /^!macro\s+customUnInstall\b/.test(line.trim()));
  const macroEnd = lines.findIndex((line, index) => index > macroStart && /^!macroend/.test(line.trim()));
  assert.ok(macroStart >= 0 && macroEnd > macroStart, 'customUnInstall must still exist');
  for (const { index } of hklm) {
    assert.ok(index > macroStart && index < macroEnd, 'the HKLM mirror must stay inside customUnInstall');
  }

  // The HKCU deletes must NOT be followed by a blanket ClearErrors that would hide
  // a real failure of the delete that actually matters. Assert the FOLLOWING lines,
  // not just the count: a count-only check passes even after someone adds a blanket
  // ClearErrors under them, which is precisely the regression this comment forbids.
  //
  // The window runs from the delete UNTIL THE NEXT `DeleteRegValue` (blank lines and
  // `#` comments skipped), not a fixed index+1..index+2 slice. Measured: with the
  // two-line window, `DeleteRegValue HKCU …` + a blank line + a comment + ClearErrors
  // went undetected, so an indented or documented blanket clear was invisible.
  const hkcu = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => /^DeleteRegValue\s+HKCU\b/.test(line));
  assert.equal(hkcu.length, 2, 'both HKCU deletes must still be present');
  const untilNextDelete = (index) => {
    const window = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const text = lines[cursor].trim();
      if (/^DeleteRegValue\b/.test(text)) break;
      if (text === '' || text.startsWith('#')) continue;
      window.push(text);
    }
    return window;
  };
  for (const { line, index } of hkcu) {
    const after = untilNextDelete(index);
    assert.equal(after.includes('ClearErrors'), false,
      `ClearErrors must NOT follow "${line}" before the next DeleteRegValue — it would hide a real HKCU delete failure (found ${JSON.stringify(after)})`);
  }

  // Mutation proof: the widened window must actually catch what the narrow one
  // missed. Inject a blank line + comment + ClearErrors after the LAST HKCU
  // delete and re-run the SAME predicate over the mutated lines.
  const lastHkcu = hkcu[hkcu.length - 1];
  const mutated = [...lines];
  mutated.splice(lastHkcu.index + 1, 0, '', '  # a documented blanket clear', '  ClearErrors');
  const mutatedHkcu = mutated
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => /^DeleteRegValue\s+HKCU\b/.test(line));
  const mutatedWindow = (() => {
    const window = [];
    for (let cursor = mutatedHkcu[mutatedHkcu.length - 1].index + 1; cursor < mutated.length; cursor += 1) {
      const text = mutated[cursor].trim();
      if (/^DeleteRegValue\b/.test(text)) break;
      if (text === '' || text.startsWith('#')) continue;
      window.push(text);
    }
    return window;
  })();
  assert.equal(mutatedWindow.includes('ClearErrors'), true,
    'the widened window must detect a blanket clear hidden behind blank/comment lines, or it is still vacuous');
});

// ── 8. makensis flags match the real build ──────────────────────────────────

test('W5b-8: the NSIS compile test uses the flags the shipping build uses', () => {
  const source = fs.readFileSync(path.join(root, 'tests', 'w5-release-installer.test.mjs'), 'utf8');
  // Read the real flags out of the dependency rather than trusting a literal.
  const target = fs.readFileSync(
    path.join(root, 'node_modules', 'app-builder-lib', 'out', 'targets', 'nsis', 'NsisTarget.js'), 'utf8');
  assert.match(target, /warningsAsErrors === false \? \[\] : \["-WX"\]/,
    'the fixture assumption changed: electron-builder no longer passes -WX by default');
  assert.match(target, /"-INPUTCHARSET", "UTF8"/, 'the real build passes -INPUTCHARSET UTF8');

  const builder = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
  assert.equal(builder.nsis?.warningsAsErrors, undefined,
    'warningsAsErrors must stay unset so the documented default (true, i.e. -WX) applies');

  // The test must pass both flags, in the same form.
  assert.match(source, /spawnSync\(makensis\.exe, \['-WX', '-INPUTCHARSET', 'UTF8', '\/V2', scriptPath\]/,
    'the compile test must use -WX and -INPUTCHARSET UTF8 like the real build');
});

test('W5b-8: the compile fixture does not emit a second Name command', () => {
  // common.nsh:14 emits `Name "${PRODUCT_NAME}" ...`, so a fixture that also emits
  // `Name` is fatal under -WX ("warning 6029: Name: specified multiple times").
  // The real build passes PRODUCT_NAME as a -D define and never emits Name itself.
  const source = fs.readFileSync(path.join(root, 'tests', 'w5-release-installer.test.mjs'), 'utf8');
  const fixture = source.slice(source.indexOf('const script = ['), source.indexOf("].join('\\n');"));
  assert.doesNotMatch(fixture, /'Name "/, 'the fixture must not emit its own Name command');
  assert.match(fixture, /'!define PRODUCT_NAME "/, 'PRODUCT_NAME must arrive as a define, as the real build passes it');
});
