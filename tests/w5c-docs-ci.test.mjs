import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

/**
 * Guards for the docs/CI defects found in the CodeRabbit audit.
 *
 * Each claim is checked with a regression proof so a future edit cannot
 * silently restore the defect:
 *
 *   1. The docs named artifact versions ("Setup-0.1.0.exe", "0.1.0 (Latest)")
 *      that no longer matched package.json. Version-neutral wording is required,
 *      because a literal goes stale on the next tag.
 *   2. llms.txt presented the loopback ports as fixed values, while the app
 *      lets the user configure the gateway port (the admin port is always +1).
 *
 * Workflows are parsed with js-yaml rather than pattern-matched wherever the
 * structure matters; raw text is read only where the parser would lose spelling.
 */

const root = path.resolve(import.meta.dirname, '..');
const WORKFLOWS_DIR = path.join(root, '.github', 'workflows');
const SEMVER = String.raw`\d+\.\d+\.\d+`;

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// ── 2. Documentation must not name a stale artifact version ────────────────

test('README names installer and portable artifacts with a version placeholder', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

  // The defect: a literal build number that no longer matches package.json.
  assert.doesNotMatch(readme, new RegExp(`NV-Gateway-Setup-${SEMVER}`),
    'the installer name must not hardcode a version that can drift from package.json');
  assert.doesNotMatch(readme, new RegExp(`NV-Gateway ${SEMVER}\\.exe`),
    'the portable artifact name must not hardcode a version that can drift from package.json');

  // The fix: neutral placeholders, with the version source stated.
  assert.match(readme, /NV-Gateway-Setup-<version>\.exe/);
  assert.match(readme, /NV-Gateway <version>\.exe/);
  assert.match(readme, /`<version>` is the `version` field in \[`package\.json`\]\(package\.json\)/);
});

test('README release badge is not pinned to a literal version', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

  // A static badge is the same defect in another costume: it advertised a tag
  // that was no longer the newest release. The dynamic endpoint reads the feed
  // the install instructions already link to.
  assert.doesNotMatch(readme, /img\.shields\.io\/badge\/Release-v\d/,
    'the release badge must not hardcode a tag that goes stale on the next release');
  assert.match(readme, /img\.shields\.io\/github\/v\/release\/HaYkMnE\/NV-Gateway\?/,
    'the badge reads releases from this repository, where they are published');
  assert.doesNotMatch(readme, /NV-Gateway-releases/, 'the README must not reference the pre-rename feed name');
});

test('SECURITY.md supported-versions table carries no literal version', () => {
  const security = fs.readFileSync(path.join(root, '.github', 'SECURITY.md'), 'utf8');
  const table = /## 1\. Supported Versions([\s\S]*?)\n---/.exec(security)?.[1];

  assert.ok(table, 'SECURITY.md must keep its Supported Versions section');
  assert.doesNotMatch(table, new RegExp('`' + SEMVER + '`'),
    'the supported-versions table must not name a version literal — it goes stale on the next release');
  assert.match(table, /package\.json/,
    'the supported-versions table must point at the single source of the current version');
  assert.match(table, /:white_check_mark:/);
  assert.match(table, /:x:/);
});

test('package.json still carries a parseable version the docs can defer to', () => {
  // The placeholders above are only honest if this field exists and looks like
  // a release version; otherwise "<version> is the version in package.json"
  // would be an instruction that cannot be followed.
  assert.match(packageJson.version, new RegExp(`^${SEMVER}$`));
});

// ── 3. llms.txt ports are defaults, not fixed requirements ─────────────────

test('llms.txt presents the ports as configurable defaults', () => {
  const llms = fs.readFileSync(path.join(root, 'llms.txt'), 'utf8');

  assert.match(llms, /application defaults, not fixed requirements/);
  assert.match(llms, /effective ports? (?:comes?|come) from the app configuration/);
  assert.match(llms, /gateway port is configurable in the app/);
  assert.match(llms, /admin API always listens on that port \+ 1/);
});

test('llms.txt still shows the default literals so the examples stay usable', () => {
  const llms = fs.readFileSync(path.join(root, 'llms.txt'), 'utf8');

  // "Default" must not turn into "unspecified": a reader still needs a concrete
  // value to paste, with the note explaining it may differ.
  assert.match(llms, /127\.0\.0\.1:12000/);
  assert.match(llms, /127\.0\.0\.1:12001\/admin/);
  assert.doesNotMatch(llms, /ports? (?:is|are) fixed/i);
  assert.doesNotMatch(llms, /always (?:runs? on|listens? on) 12000/i);
});

test('README states the same default-and-effective rule as llms.txt', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

  assert.match(readme, /default `12000` and `12001`/);
  assert.match(readme, /The effective port is the one shown in the app/);
  // The application's own default is the value the docs claim it is.
  assert.match(readme, /select your local port \(default: `12000`\)/);
});

// ── 4. The TAP reporter must be requested, not assumed ─────────────────────

test('test.yml passes --test-reporter=tap before piping node --test', () => {
  // MEASURED on Node v24.21.0, the ONLY version this was measured on: `node
  // --test file | Tee-Object` writes the SPEC reporter (`✔ probe ok`,
  // `ℹ tests 1`) even when stdout is a pipe — no `TAP version` line at all.
  // scripts/assert-tap-proof.mjs then exits 1 with "FAIL: NOT TAP", so the
  // proof step fails CLOSED there. The explicit flag is what makes the log
  // shape independent of the runtime, which is why it is required rather than
  // relying on which reporter a given Node happens to default to.
  const testWorkflow = fs.readFileSync(path.join(WORKFLOWS_DIR, 'test.yml'), 'utf8');
  const piped = [...testWorkflow.matchAll(/node --test(?<flags>[^\n|]*)\|/g)];
  assert.ok(piped.length > 0, 'test.yml must still pipe node --test into a log');
  for (const match of piped) {
    assert.match(match.groups.flags, /--test-reporter=tap\b/,
      'a piped node --test run must ask for TAP explicitly; the default reporter is not TAP');
  }
});

/**
 * Parse an engines-style range down to `{ major, minor }`.
 *
 * Only the two shapes this repository actually writes are accepted (`>=X.Y.Z`
 * and `>=X.Y`). Returning null for anything else is deliberate: a caret, a
 * tilde or a disjunction would make "the floor" ambiguous, and a test that
 * guessed at it would be asserting a number it never read.
 */
function engineFloor(range) {
  const match = /^>=\s*(\d+)\.(\d+)(?:\.\d+)?$/.exec(String(range ?? '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** True when `floor` is at least `major.minor`. */
function atLeast(floor, major, minor) {
  if (!floor) return false;
  return floor.major > major || (floor.major === major && floor.minor >= minor);
}

/**
 * Parse a CI Node pin down to `{ major, minor }`, where `minor: null` means the
 * pin is FLOATING.
 *
 * Only the shapes this repository writes are accepted. `22.x` and a bare `22`
 * are floating: setup-node resolves them to the newest published 22 release, so
 * they name no minor. `22.12.0` and `22.11` are CONCRETE and carry one.
 */
function ciPinFloor(pin) {
  const text = String(pin ?? '').trim();
  const concrete = /^v?(\d+)\.(\d+)(?:\.\d+)?$/.exec(text);
  if (concrete) return { major: Number(concrete[1]), minor: Number(concrete[2]) };
  const floating = /^v?(\d+)(?:\.(?:x|\*))?$/.exec(text);
  if (floating) return { major: Number(floating[1]), minor: null };
  return null;
}

/**
 * True when a CI pin admits `floor`.
 *
 * The MAJOR alone is not enough: the defect this replaces compared only the
 * major, so a pin of `22.0` or `22.11` passed while sitting below the declared
 * 22.12.0 floor. A concrete pin therefore has to clear the minor too. A floating
 * pin (`22.x`, `22`) is accepted at the floor's own major because it resolves to
 * the NEWEST 22, which is above 22.12.0 — unlike a literal `22.0`.
 */
function pinCoversFloor(pinFloor, floor) {
  if (!pinFloor || !floor) return false;
  if (pinFloor.major !== floor.major) return pinFloor.major > floor.major;
  return pinFloor.minor === null || pinFloor.minor >= floor.minor;
}

/**
 * Every LITERAL `node-version` value in a workflow, read from the RAW TEXT.
 *
 * MEASURED, and the reason this exists instead of reading the parsed document:
 * js-yaml resolves an unquoted `22.0` to the NUMBER 22, so a parsed pin cannot
 * tell `22.0` from a bare `22`. The first version of this guard did read the
 * parsed value, and the mutation `[22.x] -> [22.0]` stayed GREEN because the
 * literal had already been flattened to `22`. Reading the source preserves the
 * spelling, which is the only thing that distinguishes a below-floor pin from a
 * floating one.
 *
 * `${{ }}` expressions are skipped: they are not literals, and the matrix entry
 * they resolve to is collected on its own.
 */
function rawNodePins(text) {
  const pins = [];
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const clean = (value) => value.trim().replace(/^['"]|['"]$/g, '').replace(/\s+#.*$/, '').trim();
  const push = (value, line) => {
    const cleaned = clean(value);
    if (cleaned === '' || cleaned.includes('${{')) return;
    pins.push({ value: cleaned, line });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*node-version:\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const rest = match[1].replace(/\s+#.*$/, '').trim();
    if (rest === '') {
      // Block-list form: `node-version:` then `- 22.x` lines.
      for (let next = index + 1; next < lines.length; next += 1) {
        const item = /^\s*-\s*(.+)$/.exec(lines[next]);
        if (!item) break;
        push(item[1], next + 1);
      }
      continue;
    }
    const inline = /^\[(.*)\]$/.exec(rest);
    for (const value of inline ? inline[1].split(',') : [rest]) push(value, index + 1);
  }
  return pins;
}

test('package.json declares a Node engine floor that covers every CI pin', () => {
  // MEASURED, not stylistic. `import.meta.dirname` landed in Node v20.11.0 and
  // is used throughout tests/ and scripts/ — 96 occurrences at the time of
  // writing (83 in tests/, 13 in scripts/; 72 of them in files tracked by git,
  // the rest added by in-flight test work). The figure is a FLOOR, not a pinned
  // count: it only grows, and the assertion below never reads it. On 20.0–20.10
  // it is `undefined`, so `path.resolve(import.meta.dirname, '..')` throws
  // ERR_INVALID_ARG_TYPE before a single assertion runs. `mock.timers.enable({
  // apis, now })` (tests/e3-r6-recovery.test.mjs:58,327) is also v20.11.0+.
  // A floor of 20.0.0 therefore ADMITS runtimes on which the suite cannot start.
  //
  // @electron/fuses 2.1.3 raises it further: it declares engines.node
  // >=22.12.0 and is imported by the afterPack hook. That is why the floor is
  // 22.12.0 rather than 20.11.0, and why every workflow pins 22.x.
  const range = packageJson.engines?.node;
  assert.equal(typeof range, 'string', 'package.json must declare engines.node');

  const floor = engineFloor(range);
  assert.ok(floor, `engines.node must be a >=<major>.<minor> range, got ${range}`);
  assert.ok(atLeast(floor, 20, 11),
    `engines.node floor ${range} must be at least 20.11.0 — import.meta.dirname is undefined below it`);
  assert.ok(atLeast(floor, 22, 12),
    `engines.node floor ${range} must be at least 22.12.0 — @electron/fuses 2.1.3 requires it`);
});

test('regression proof: the old >=20.0.0 floor is rejected', () => {
  // The defect this replaces: `floor <= 20` compared only the MAJOR number, so
  // ">=20.0.0" passed while every test file threw on import. The mutation below
  // is the literal value that shipped, fed through the same helpers the real
  // assertion uses.
  const broken = engineFloor('>=20.0.0');
  assert.deepEqual(broken, { major: 20, minor: 0 }, 'the mutation must parse to the shipped floor');
  assert.equal(atLeast(broken, 20, 11), false,
    '>=20.0.0 must FAIL a 20.11 requirement, or this guard is still major-only');
  assert.equal(atLeast(broken, 22, 12), false, '>=20.0.0 must also fail the @electron/fuses floor');

  // And the values that must still pass, so the guard is not simply rejecting
  // everything it is shown.
  assert.equal(atLeast(engineFloor('>=20.11.0'), 20, 11), true);
  assert.equal(atLeast(engineFloor('>=22.12.0'), 22, 12), true);
  assert.equal(atLeast(engineFloor('>=22.12'), 22, 12), true, 'a two-component floor is legal');
  // An unparseable range is NOT silently treated as compliant.
  assert.equal(engineFloor('^22.12.0'), null, 'a caret range has no single floor to assert');
  assert.equal(atLeast(engineFloor('*'), 22, 12), false, 'an unbounded range must not pass a floor check');
});

test('every CI workflow runs on a Node version the engine floor admits', () => {
  // The floor is only honest if CI does not contradict it. MEASURED: test.yml
  // pinned 20.x while release.yml pinned 22.x, so the workflows ran on different
  // runtimes and the packaging leg alone loaded @electron/fuses.
  const floor = engineFloor(packageJson.engines?.node);
  assert.ok(floor, 'the floor must be parseable before it can be compared to the pins');

  // Read from the RAW TEXT, not the parsed document: js-yaml turns an unquoted
  // `22.0` into the number 22, which is indistinguishable from a bare `22` — the
  // exact collapse that made the first version of this guard blind to `22.0`.
  const pins = [];
  for (const file of ['test.yml', 'release.yml']) {
    const text = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
    for (const { value, line } of rawNodePins(text)) pins.push({ file, line, pin: value });
  }
  assert.ok(pins.length >= 3, `every workflow that runs the suite must pin Node, found ${JSON.stringify(pins)}`);
  // The guard is only meaningful if it actually sees each file: a pin list that
  // silently lost a workflow would pass vacuously.
  for (const file of ['test.yml', 'release.yml']) {
    assert.ok(pins.some((entry) => entry.file === file), `${file} must contribute a Node pin to this check`);
  }

  for (const { file, line, pin } of pins) {
    // Compared at MAJOR.MINOR, not major alone: `22.0` and `22.11` both name the
    // floor's major while sitting below it, and a major-only check cannot see
    // that. `22.x` stays legal because it floats to the newest 22.
    const pinFloor = ciPinFloor(pin);
    assert.ok(pinFloor, `${file}:${line} pins an unparseable Node version ${JSON.stringify(pin)}`);
    assert.ok(pinCoversFloor(pinFloor, floor),
      `${file}:${line} pins Node ${pin}, below the declared floor ${packageJson.engines?.node} — ` +
      'import.meta.dirname is undefined on 20.0–20.10 and @electron/fuses needs >=22.12.0');
  }
});

/**
 * Every Node version a human-facing doc ADVERTISES, read from the raw text.
 *
 * The badge form spells the plus as `%2B`, so both spellings are accepted and
 * decoded to the same literal. A mention with no version after it ("direct Node
 * or Electron access") is not an advertisement and is skipped.
 */
function advertisedNodeVersions(text) {
  const mentions = [];
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const pattern = /Node(?:\.js)?[\s-]+v?(\d+(?:\.\d+)*)(\+|%2B)?/gi;
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(pattern)) {
      mentions.push({ version: match[1], line: index + 1, text: match[0].trim() });
    }
  }
  return mentions;
}

test('README and CONTRIBUTING advertise the Node floor package.json declares', () => {
  // MEASURED: both docs said "Node-20+"/"Node 20" while engines.node had already
  // moved to >=22.12.0 and every workflow pinned 22.x, so a contributor following
  // the docs installed a runtime the suite cannot start on.
  const floor = engineFloor(packageJson.engines?.node);
  assert.ok(floor, 'the floor must be parseable before the docs can be compared to it');

  for (const file of ['README.md', '.github/CONTRIBUTING.md']) {
    const mentions = advertisedNodeVersions(fs.readFileSync(path.join(root, file), 'utf8'));
    assert.ok(mentions.length > 0, `${file} must state a supported Node version`);
    for (const { version, line, text } of mentions) {
      const advertised = ciPinFloor(version);
      assert.ok(advertised, `${file}:${line} advertises an unparseable Node version ${JSON.stringify(text)}`);
      assert.ok(pinCoversFloor(advertised, floor),
        `${file}:${line} advertises ${JSON.stringify(text)}, below the declared floor ${packageJson.engines?.node}`);
    }
  }
});

test('regression proof: the shipped Node-20 doc wording is rejected', () => {
  // The three literal spellings that shipped, fed through the same helpers.
  const floor = engineFloor('>=22.12.0');
  for (const shipped of [
    'Node-20%2B',
    'Node.js 20+ with native ESM',
    'The shipped product jobs target Windows and Node 20;'
  ]) {
    const mentions = advertisedNodeVersions(shipped);
    assert.equal(mentions.length, 1, `${JSON.stringify(shipped)} must yield exactly one version mention`);
    assert.equal(pinCoversFloor(ciPinFloor(mentions[0].version), floor), false,
      `${JSON.stringify(shipped)} must FAIL the 22.12 floor, or this guard is blind to the defect`);
  }
  // And the fixed spellings pass, so the guard is not rejecting everything.
  for (const fixed of ['Node-22.12%2B', 'Node.js 22.12+ with native ESM', 'Windows and Node 22.12;']) {
    const mentions = advertisedNodeVersions(fixed);
    assert.equal(mentions.length, 1, `${JSON.stringify(fixed)} must yield exactly one version mention`);
    assert.equal(pinCoversFloor(ciPinFloor(mentions[0].version), floor), true,
      `${JSON.stringify(fixed)} must PASS the 22.12 floor`);
  }
  // A mention with no version is not an advertisement.
  assert.deepEqual(advertisedNodeVersions('direct Node or Electron access'), []);
});

test('regression proof: the raw pin reader preserves a below-floor minor', () => {
  // The collapse that broke the first version of this guard: the PARSED value of
  // an unquoted `22.0` is the number 22.
  assert.equal(yaml.load('node-version: [22.0]')['node-version'][0], 22,
    'the YAML parser flattens 22.0 to 22, which is why the raw text is read');
  // The raw reader keeps the spelling, so the comparison can see the minor.
  assert.deepEqual(rawNodePins('node-version: [22.0]\n'), [{ value: '22.0', line: 1 }]);
  assert.deepEqual(rawNodePins("node-version: '22.11'\n"), [{ value: '22.11', line: 1 }]);
  // Matrix, block list, scalar and a trailing comment all resolve to the literal.
  assert.deepEqual(rawNodePins('    node-version: [22.x]  # CI pin\n'), [{ value: '22.x', line: 1 }]);
  assert.deepEqual(rawNodePins('node-version:\n  - 22.x\n  - 20\n'), [
    { value: '22.x', line: 2 }, { value: '20', line: 3 }
  ]);
  // An expression is not a literal and is not asserted here.
  assert.deepEqual(rawNodePins('node-version: ${{ matrix.node-version }}\n'), []);
  // And the real files still yield the pins they actually carry.
  const testPins = rawNodePins(fs.readFileSync(path.join(WORKFLOWS_DIR, 'test.yml'), 'utf8'));
  assert.deepEqual(testPins.map((entry) => entry.value), ['22.x', '22.x']);
  const releasePins = rawNodePins(fs.readFileSync(path.join(WORKFLOWS_DIR, 'release.yml'), 'utf8'));
  assert.deepEqual(releasePins.map((entry) => entry.value), ['22.x'],
    'release.yml must pin 22.x: it runs npm run build:release');
});

test('regression proof: a below-floor concrete pin is rejected by the CI pin check', () => {
  const floor = engineFloor('>=22.12.0');
  assert.ok(floor, 'the fixture floor must parse');

  // THE DEFECT: the previous check compared the MAJOR only, so both of these
  // passed while naming a minor below 22.12.0. MEASURED on the old code: setting
  // both workflow pins to `22.0` left all 30 tests green.
  for (const pin of ['22.0', '22.0.0', '22.11', '22.11.9', 'v22.11']) {
    const parsed = ciPinFloor(pin);
    assert.ok(parsed, `${pin} must parse as a concrete pin`);
    assert.equal(pinCoversFloor(parsed, floor), false, `${pin} must FAIL the 22.12 floor`);
  }

  // And the values that must still pass, so the guard is not rejecting
  // everything it is shown.
  for (const pin of ['22.12', '22.12.0', '22.13.1', '23.0.0', '22.x', '22']) {
    assert.equal(pinCoversFloor(ciPinFloor(pin), floor), true, `${pin} must PASS the 22.12 floor`);
  }

  // A floating pin cannot be a below-floor literal: `22.x` resolves to the newest
  // 22, which is the reason it is admitted while `22.0` is not.
  assert.deepEqual(ciPinFloor('22.x'), { major: 22, minor: null });
  assert.deepEqual(ciPinFloor('22'), { major: 22, minor: null });
  assert.deepEqual(ciPinFloor('22.0'), { major: 22, minor: 0 });

  // A major below the floor fails regardless of the minor.
  assert.equal(pinCoversFloor(ciPinFloor('20.99.99'), floor), false, 'a lower major can never clear a higher floor');
  assert.equal(pinCoversFloor(ciPinFloor('20'), floor), false, 'a floating lower major must fail too');
  // Unparseable pins are not silently compliant.
  assert.equal(ciPinFloor('latest'), null, 'a dist-tag has no major.minor to compare');
  assert.equal(ciPinFloor('>=22.12.0'), null, 'a range is not a pin');
  assert.equal(pinCoversFloor(null, floor), false);
  assert.equal(pinCoversFloor(ciPinFloor('22.12.0'), null), false, 'no floor means no pass');
});

// ── 5. The installer include must be COMPILED in CI, not just referenced ───

/**
 * Locate the installer-compile step in test.yml, or null.
 *
 * Matched on the command it runs rather than on its display name, because a
 * renamed step must not silently satisfy this guard — the thing that has to
 * exist is the `--win nsis` build, not a title.
 */
function installerCompileStep() {
  const testWorkflow = yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, 'test.yml'), 'utf8'));
  return Object.values(testWorkflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .find((step) => typeof step.run === 'string' && /--win\s+nsis\b/.test(step.run)) ?? null;
}

test('test.yml compiles the nsis target, so build/installer.nsh cannot rot unbuilt', () => {
  // THE DEFECT: electron-builder.yml:99 sets `nsis.include: installer.nsh`, but
  // every packaging step in this workflow used `--dir`, which builds no
  // installer target. makensis therefore never saw the include in CI, and a
  // broken customInstall/customUnInstall surfaced only at release time.
  const builder = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
  assert.equal(builder.nsis?.include, 'installer.nsh',
    'this guard exists because electron-builder.yml wires a custom nsis include');

  const step = installerCompileStep();
  assert.ok(step, 'test.yml must run an `electron-builder --win nsis` step to compile the include');

  // Non-publishing, by construction. A missing --publish never lets
  // electron-builder fall back to its default, and any credential in the
  // environment would then be usable by the whole packaging dependency tree.
  assert.match(step.run, /--publish\s+never\b/, 'the installer smoke must never publish');
  assert.equal(step.env?.GH_TOKEN, undefined, 'the installer smoke must not receive GH_TOKEN');
  assert.doesNotMatch(JSON.stringify(step.env ?? {}), /secrets\./, 'the installer smoke must not receive any secret');

  // Cheap: it consumes the --dir output instead of repacking it. That also
  // keeps the afterPack hardening hook single-pass (with --prepackaged,
  // platformPackager.doPack returns early and afterPack does not run).
  assert.match(step.run, /--prepackaged\b/,
    'the installer smoke must reuse dist/win-unpacked rather than repack the app');

  // MEASURED: the nsis target writes resources/elevate.exe into whatever
  // directory --prepackaged names (nsisUtil.js:105). Building in place would
  // mutate the artifact the dist-gated tests just audited, so the tree has to
  // be copied first.
  assert.match(step.run, /Copy-Item[^\n]*dist\/win-unpacked/,
    'the smoke must copy dist/win-unpacked before --prepackaged: the nsis target adds resources/elevate.exe to it');

  // A zero exit alone is not proof; makensis being skipped would also be zero.
  // The GLOB ALONE is not proof either: deleting the `if (-not $installer)` branch
  // leaves the glob line intact and still prints INSTALLER_COMPILED with an empty
  // name, so the step would go green having compiled nothing. MEASURED: removing
  // that branch kept all 30 tests green under the old text-only assertion. The
  // fail-closed branch is therefore asserted as code, together with its exit 1.
  assert.match(step.run, /NV-Gateway-Setup-\*\.exe/, 'the smoke must assert the installer artifact exists');
  assert.match(step.run, /if\s*\(\s*-not\s+\$installer\s*\)\s*\{[^}]*exit\s+1/,
    'the smoke must FAIL CLOSED when no installer is produced: the glob alone still matches an empty result');
  // And it must be downstream of the glob it guards, not a stray branch elsewhere.
  const globAt = step.run.indexOf('NV-Gateway-Setup-*.exe');
  const failClosedAt = step.run.search(/if\s*\(\s*-not\s+\$installer\s*\)/);
  assert.ok(globAt >= 0 && failClosedAt > globAt,
    'the fail-closed branch must come AFTER the artifact glob it guards');
});

test('regression proof: deleting the fail-closed branch is rejected by the installer guard', () => {
  // The mutation is the exact edit that used to pass: the glob survives, the
  // guard that turns an empty glob into a failure does not.
  const greenWithoutGuard = [
    "$installer = Get-ChildItem $out -Filter 'NV-Gateway-Setup-*.exe' -ErrorAction SilentlyContinue",
    'Write-Output "INSTALLER_COMPILED $($installer.Name) $($installer.Length) bytes"'
  ].join('\n');
  const detector = (run) => /if\s*\(\s*-not\s+\$installer\s*\)\s*\{[^}]*exit\s+1/.test(run);
  assert.equal(detector(greenWithoutGuard), false,
    'the glob line alone must NOT satisfy the fail-closed assertion');
  // The real shape (with the branch) does satisfy it, so the detector is not
  // simply rejecting everything.
  assert.equal(detector(`${greenWithoutGuard}\nif (-not $installer) { Write-Error "none"; exit 1 }`), true);
  // `exit 0`, a bare `exit`, or a message without a nonzero exit is still a hole.
  assert.equal(detector(`${greenWithoutGuard}\nif (-not $installer) { exit 0 }`), false);
  assert.equal(detector(`${greenWithoutGuard}\nif (-not $installer) { Write-Error "none" }`), false);
});

// ── 5b. The smoke must GENERATE the gitignored file electron-builder demands ─
test('test.yml generates build/release-notes.md before the installer smoke runs', () => {
  // THE DEFECT: electron-builder.yml:68-69 names build/release-notes.md as
  // releaseInfo.releaseNotesFile, and app-builder-lib throws when an explicitly
  // named resource is missing. The file is GITIGNORED (.gitignore:46) and only
  // `npm run build:release` -> prebuild:release produces it (package.json:18),
  // while the smoke runs after `npm run package:dir`. MEASURED on a clean copy of
  // the tree: exit 1 `cannot find specified resource "build/release-notes.md"`;
  // after adding the file: exit 0. Every PR and push would have gone red.
  const builder = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
  assert.equal(builder.releaseInfo?.releaseNotesFile, 'build/release-notes.md',
    'this guard exists because the packaging config names the generated notes file');
  assert.equal(fs.existsSync(path.join(root, 'scripts', 'release-notes.mjs')), true,
    'the generator the smoke is expected to call must exist');
  // The file must really be ignored, or the premise (absent on a clean runner)
  // is wrong and the generator would be redundant.
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(gitignore, /^build\/release-notes\.md$/m, 'the notes file must stay gitignored');

  const step = installerCompileStep();
  assert.ok(step, 'the installer smoke must exist for this ordering check');
  const notesAt = step.run.indexOf('node scripts/release-notes.mjs');
  const builderAt = step.run.indexOf('run-electron-builder.mjs');
  assert.ok(notesAt >= 0, 'the smoke must run `node scripts/release-notes.mjs` to create the required file');
  assert.ok(builderAt > notesAt,
    'the notes must be generated BEFORE electron-builder starts, or it fails on a clean runner');
  // A generator that fails must stop the step rather than let packaging continue
  // and report the less specific "cannot find specified resource" error.
  assert.match(step.run, /release-notes\.mjs[\s\S]{0,200}if\s*\(\s*\$LASTEXITCODE\s+-ne\s+0\s*\)\s*\{\s*exit/,
    'a failing release-notes run must exit before packaging');
});

test('regression proof: an installer smoke without the notes step is rejected', () => {
  const detector = (run) => {
    const notesAt = run.indexOf('node scripts/release-notes.mjs');
    const builderAt = run.indexOf('run-electron-builder.mjs');
    return notesAt >= 0 && builderAt > notesAt;
  };
  const cleanRunnerShape = [
    "Copy-Item -Path dist/win-unpacked -Destination $app -Recurse -Force",
    'node scripts/run-electron-builder.mjs --win nsis --publish never --prepackaged $app'
  ].join('\n');
  assert.equal(detector(cleanRunnerShape), false,
    'the pre-fix shape must be rejected: it fails on a clean runner');
  assert.equal(detector(`node scripts/release-notes.mjs\n${cleanRunnerShape}`), true);
  // Order matters: generating the file after the packaging run is no help.
  assert.equal(detector(`${cleanRunnerShape}\nnode scripts/release-notes.mjs`), false);
});

// ── 5c. The smoke is SCOPED, but never skipped on main ──────────────────────
test('test.yml scopes the installer smoke to packaging changes and keeps it on main', () => {
  // The step costs 30-33 s and copies 229 MB, and it can only fail when the
  // packaging surface changed. It must therefore not run on every pull request —
  // but a push to main (and a manual dispatch) must still run it unconditionally.
  const document = yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, 'test.yml'), 'utf8'));
  const jobEntries = Object.entries(document.jobs ?? {});
  const steps = jobEntries.flatMap(([, job]) => job.steps ?? []);
  const smoke = steps.find((step) => typeof step.run === 'string' && /--win\s+nsis\b/.test(step.run));
  assert.ok(smoke, 'the installer smoke must still exist');
  // The checkout that matters is the one in the SAME job as the smoke; other
  // jobs in this workflow have no reason to fetch full history.
  const smokeJob = jobEntries.find(([, job]) => (job.steps ?? []).includes(smoke))?.[1];
  assert.ok(smokeJob, 'the smoke must belong to a job');

  const condition = String(smoke.if ?? '');
  assert.match(condition, /github\.event_name\s*!=\s*'pull_request'/,
    'the smoke must run unconditionally off pull requests, so main coverage is unchanged');
  assert.match(condition, /steps\.nsis_scope\.outputs\.run\s*==\s*'true'/,
    'on a pull request the smoke must be gated on the scope step verdict');

  // The scope step must exist, be the one the condition names, and decide from a
  // real changed-files check rather than from a hardcoded value.
  const scope = steps.find((step) => step.id === 'nsis_scope');
  assert.ok(scope, 'the scope step the condition references must exist');
  assert.match(String(scope.run), /git\b[^\n]*\bdiff --name-only\b/,
    'the scope must come from the pull request diff, not from a constant');
  // A path is only matchable if git prints it literally. MEASURED with the
  // default `core.quotePath=true`: `build/ïñstaller-ñ.nsh` arrives as
  // `"build/\303\257\303\261staller-\303\261.nsh"`, which the anchored scope
  // below never matches, so the smoke was silently skipped. `-z` also keeps a
  // path containing a newline from being split into two lines.
  assert.match(String(scope.run), /git\s+-c\s+core\.quotePath=false\s+diff\b/,
    'the diff must disable core.quotePath, or a non-ASCII packaging path is unmatchable');
  assert.match(String(scope.run), /\bdiff --name-only -z\b/,
    'the diff must be NUL-separated so a newline in a path cannot split one entry into two');
  assert.match(String(scope.run), /GITHUB_OUTPUT/, 'the verdict must be published as a step output');
  // Every path that can change what the nsis target compiles or reads. The
  // patterns are regexes inside PowerShell, so a literal dot may arrive escaped
  // (`electron-builder\.yml`); both spellings are accepted.
  for (const [label, pattern] of [
    ['build/', /build\//],
    ['CHANGELOG.md', /CHANGELOG\\?\.md/],
    ['electron-builder.yml', /electron-builder\\?\.yml/],
    ['scripts/harden-windows-package.mjs', /harden-windows-package\\?\.mjs/],
    ['scripts/packaging-env-guard.mjs', /packaging-env-guard\\?\.mjs/],
    ['scripts/release-notes.mjs', /release-notes\\?\.mjs/],
    ['scripts/run-electron-builder.mjs', /run-electron-builder\\?\.mjs/],
    ['package.json', /package\\?\.json/],
    // CRF3-002: a PR editing only the smoke steps must still run the smoke.
    ['.github/workflows/test.yml', /\\\.github\/workflows\/test\\\.yml\$/]
  ]) {
    assert.match(String(scope.run), pattern, `the scope must include ${label}`);
  }
  // Fail OPEN: an unreadable diff must run the smoke, never skip a check. An
  // EMPTY base is its own unreadable answer — it silently becomes HEAD...HEAD.
  assert.match(String(scope.run), /\$diffExit -ne 0[\s\S]{0,200}run=true/,
    'a failed diff must fall back to running the smoke, not to skipping it');
  assert.match(String(scope.run), /IsNullOrWhiteSpace\(\$env:NVGW_PR_BASE_SHA\)[\s\S]{0,200}run=true/,
    'an empty base ref must fall back to running the smoke: HEAD...HEAD exits 0 with no paths');

  // The base commit must reach the script through env, never interpolated.
  assert.equal(scope.env?.NVGW_PR_BASE_SHA, '${{ github.event.pull_request.base.sha }}',
    'the diff base must be the pull request base commit, passed via env');
  assert.doesNotMatch(String(scope.run), /\$\{\{/, 'the ref must not be interpolated into the script body');

  // And the checkout must carry enough history for that diff to resolve.
  const checkout = (smokeJob.steps ?? []).find((step) => String(step.uses ?? '').startsWith('actions/checkout@'));
  assert.equal(checkout?.with?.['fetch-depth'], 0,
    'the scope diffs against the base commit, so the depth-1 default checkout is not enough');
});

// ── 5d. The scope step is EXECUTED, not just pattern-matched ────────────────

/**
 * Locate the `nsis_scope` step in test.yml.
 *
 * The scoping tests above read the script as text, and text alone cannot tell a
 * working changed-files check from one that never matches: the pre-fix step
 * looked correct and returned `run=false` for every non-ASCII packaging path.
 * These tests therefore run the REAL script under PowerShell.
 */
function nsisScopeStep() {
  const document = yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, 'test.yml'), 'utf8'));
  return Object.values(document.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .find((step) => step.id === 'nsis_scope') ?? null;
}

/** PowerShell to execute the step with: `pwsh` is what the workflow declares. */
function powershellExe() {
  for (const exe of ['pwsh', 'powershell']) {
    const probe = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return exe;
  }
  return null;
}

/** Run `git` in `cwd`, returning status and stdout; never throws on a nonzero exit. */
function gitIn(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) assert.fail(`git ${args.join(' ')} could not be run: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Scratch roots created by this file, removed once the file's tests finish. */
const scopeScratch = [];

/** A temp directory under the suite's scratch base, registered for cleanup. */
function scopeScratchDir(prefix) {
  const base = process.env.NV_TEST_SCRATCH || os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, prefix));
  scopeScratch.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of scopeScratch) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A throwaway repository whose HEAD adds one file, so `base...HEAD` is a real diff.
 *
 * `core.quotePath` is pinned to the DEFAULT value `true` in the fixture's local
 * config: the defect only exists because that is git's default, and a machine
 * whose global config set it to false would otherwise make the pre-fix proof
 * pass for the wrong reason.
 */
function scopeFixture(filePath) {
  const dir = scopeScratchDir('nvgw-nsis-scope-');
  const git = (...args) => gitIn(dir, [
    '-c', 'user.email=scope@test.invalid', '-c', 'user.name=scope', '-c', 'commit.gpgsign=false',
    ...args
  ]);
  assert.equal(git('init', '-q').status, 0, 'git init must succeed in the fixture');
  assert.equal(git('config', 'core.quotePath', 'true').status, 0, 'the fixture must carry the default quotePath');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n', 'utf8');
  assert.equal(git('add', '-A').status, 0);
  assert.equal(git('commit', '-qm', 'base').status, 0);
  const base = git('rev-parse', 'HEAD').stdout.trim();

  fs.mkdirSync(path.join(dir, path.dirname(filePath)), { recursive: true });
  fs.writeFileSync(path.join(dir, filePath), '; changed\n', 'utf8');
  assert.equal(git('add', '-A').status, 0);
  assert.equal(git('commit', '-qm', 'change').status, 0);
  return { dir, base };
}

/**
 * Execute a scope-step script body as the runner would, and return the verdict.
 *
 * The env the step reads is set explicitly (`GITHUB_EVENT_NAME`,
 * `NVGW_PR_BASE_SHA`, `GITHUB_OUTPUT`) so the run is the real control flow,
 * including the `exit 0` paths.
 */
function runScopeScript(exe, script, { cwd, baseSha }) {
  const box = scopeScratchDir('nvgw-nsis-run-');
  const scriptPath = path.join(box, 'scope.ps1');
  const outputPath = path.join(box, 'github-output.txt');
  fs.writeFileSync(scriptPath, String(script), 'utf8');
  const env = { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_OUTPUT: outputPath };
  if (baseSha === null) delete env.NVGW_PR_BASE_SHA;
  else env.NVGW_PR_BASE_SHA = baseSha;
  const result = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    cwd, encoding: 'utf8', env, timeout: 60_000
  });
  const output = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  const verdict = /run=(true|false)/.exec(output)?.[1] ?? null;
  return { status: result.status, stdout: result.stdout ?? '', output, verdict };
}

/**
 * The pre-fix shape of the step, derived by mutating the LIVE script.
 *
 * Derived rather than pasted so the proof cannot drift from the file under test.
 * The derivation is deliberately lenient: on the pre-fix workflow both
 * substitutions are no-ops and this returns the script unchanged, which makes the
 * behavioural assertions below fail on the actual defect (a `run=false` verdict)
 * instead of on a meta-assertion about the mutation.
 */
function preFixScopeScript(script) {
  const withoutQuoteFix = String(script)
    .replace('git -c core.quotePath=false diff --name-only -z', 'git diff --name-only');
  const lines = withoutQuoteFix.split('\n');
  const start = lines.findIndex((line) => line.includes('IsNullOrWhiteSpace($env:NVGW_PR_BASE_SHA)'));
  if (start < 0) return withoutQuoteFix;
  const end = lines.findIndex((line, index) => index > start && line.trim() === '}');
  if (end < start) return withoutQuoteFix;
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n');
}

test('the scope step really returns run=true for a non-ASCII path under build/', (t) => {
  // MEASURED with the default core.quotePath=true: `git diff --name-only` prints
  //   "build/\303\257\303\261staller-\303\261.nsh"
  // and the anchored `^(?:build/|...)` pattern never matches, so run=false and a
  // real change to the NSIS include skipped the smoke silently.
  const exe = powershellExe();
  if (!exe) { t.skip('PowerShell is unavailable'); return; }
  if (gitIn(root, ['--version']).status !== 0) { t.skip('git is unavailable'); return; }

  const step = nsisScopeStep();
  assert.ok(step, 'the scope step must exist to be executed');
  const script = String(step.run);
  const filePath = 'build/ïñstaller-ñ.nsh';
  const { dir, base } = scopeFixture(filePath);

  // The pre-fix shape first, so a green result below is not vacuous.
  const before = runScopeScript(exe, preFixScopeScript(script), { cwd: dir, baseSha: base });
  assert.equal(before.status, 0, `the pre-fix script must run to completion: ${before.stdout}`);
  assert.equal(before.verdict, 'false',
    `the pre-fix command must skip the smoke for ${filePath} — it prints the path quoted, ` +
    `and that is the defect this guard exists for (stdout: ${JSON.stringify(before.stdout)})`);

  // And the shipped command must see the same change.
  const after = runScopeScript(exe, script, { cwd: dir, baseSha: base });
  assert.equal(after.status, 0, `the scope script must run to completion: ${after.stdout}`);
  assert.equal(after.verdict, 'true',
    `a changed ${filePath} must run the smoke; stdout: ${JSON.stringify(after.stdout)}`);
});

test('the scope step fails OPEN when the base ref is empty', (t) => {
  // `git diff "...HEAD"` with an empty ref collapses to `HEAD...HEAD`: exit 0,
  // no output, run=false — a skip derived from an answer git never gave. The
  // stated rule is that an unreadable answer never means "skip".
  const exe = powershellExe();
  if (!exe) { t.skip('PowerShell is unavailable'); return; }
  if (gitIn(root, ['--version']).status !== 0) { t.skip('git is unavailable'); return; }

  const step = nsisScopeStep();
  assert.ok(step, 'the scope step must exist to be executed');
  const script = String(step.run);
  const { dir, base } = scopeFixture('src/main/unrelated.ts');

  // Control: with a real base the same script DOES skip an out-of-scope change,
  // so the fail-open result below is the guard's doing and not a script that
  // always says true.
  const control = runScopeScript(exe, script, { cwd: dir, baseSha: base });
  assert.equal(control.verdict, 'false',
    `an out-of-scope change must still skip the smoke (stdout: ${JSON.stringify(control.stdout)})`);

  const before = runScopeScript(exe, preFixScopeScript(script), { cwd: dir, baseSha: '' });
  assert.equal(before.verdict, 'false',
    'the pre-fix script must skip on an empty base — HEAD...HEAD is a silent empty diff');

  for (const empty of ['', '   ']) {
    const after = runScopeScript(exe, script, { cwd: dir, baseSha: empty });
    assert.equal(after.status, 0, `the scope script must run to completion: ${after.stdout}`);
    assert.equal(after.verdict, 'true',
      `an empty base ${JSON.stringify(empty)} must run the smoke, not skip it; ` +
      `stdout: ${JSON.stringify(after.stdout)}`);
  }

  // An UNSET variable is the same unreadable answer as an empty one.
  const unset = runScopeScript(exe, script, { cwd: dir, baseSha: null });
  assert.equal(unset.verdict, 'true',
    `a missing NVGW_PR_BASE_SHA must run the smoke; stdout: ${JSON.stringify(unset.stdout)}`);
});

test('regression proof: a hardcoded or main-skipping smoke gate is rejected', () => {
  const accepts = (step) => {
    const condition = String(step.if ?? '');
    return /github\.event_name\s*!=\s*'pull_request'/.test(condition)
      && /steps\.nsis_scope\.outputs\.run\s*==\s*'true'/.test(condition);
  };
  assert.equal(accepts({}), false, 'an unguarded step is not a scoped step');
  assert.equal(accepts({ if: "steps.nsis_scope.outputs.run == 'true'" }), false,
    'dropping the event check would skip main pushes, which must always run the smoke');
  assert.equal(accepts({ if: "github.event_name != 'pull_request'" }), false,
    'ignoring the scope would restore the every-PR cost');
  assert.equal(accepts({ if: "${{ github.event_name != 'pull_request' || steps.nsis_scope.outputs.run == 'true' }}" }), true);
});

test('regression proof: a --dir-only workflow is rejected by the installer guard', () => {
  // The mutation is the real pre-fix shape: package:dir, no nsis target. The
  // detector must report it, or the guard above proves nothing.
  const dirOnly = { jobs: { 'packaged-audit': { steps: [{ run: 'npm run package:dir' }] } } };
  const find = (document) => Object.values(document.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .find((step) => typeof step.run === 'string' && /--win\s+nsis\b/.test(step.run)) ?? null;
  assert.equal(find(dirOnly), null, '`--dir` alone must not satisfy the installer guard');

  // And a step that publishes is not an acceptable substitute.
  const publishing = { jobs: { x: { steps: [{ run: 'electron-builder --win nsis' }] } } };
  const found = find(publishing);
  assert.ok(found, 'the detector must find an nsis step');
  assert.doesNotMatch(found.run, /--publish\s+never\b/, 'a publishing nsis step must fail the non-publish assertion');
});

// ── 6. The CI proof step must name the REAL test titles ────────────────────
/**
 * Every `--require-ok='<name>'` argument the packaged-audit proof step passes.
 *
 * scripts/assert-tap-proof.mjs compares the TAP name with `===` (deliberately —
 * substring matching let `--require-ok=Foo` be satisfied by a passing `FooBar`).
 * The consequence is that a TRUNCATED title is a hard MISSING failure that
 * blocks the whole job. MEASURED on a real green TAP log of the three dist-gated
 * suites: `--require-ok='the packaged engine lives INSIDE app.asar'` exits 1
 * with `FAIL: MISSING`, while the full declared title `the packaged engine lives
 * INSIDE app.asar and nothing executable is left in resources` exits 0 with
 * ALL_PACKAGED_ASSERTIONS_EXECUTED.
 */
function ciRequiredOkNames() {
  const testWorkflow = fs.readFileSync(path.join(WORKFLOWS_DIR, 'test.yml'), 'utf8');
  const start = testWorkflow.indexOf('assert-tap-proof.mjs');
  assert.ok(start >= 0, 'test.yml must still run scripts/assert-tap-proof.mjs');
  return [...testWorkflow.slice(start).matchAll(/--require-ok='([^']+)'/g)].map((match) => match[1]);
}

test('every --require-ok name in test.yml is a FULL title a dist-gated test declares', () => {
  const names = ciRequiredOkNames();
  assert.ok(names.length >= 2,
    `the proof step must still require the packaged assertions, found ${JSON.stringify(names)}`);

  // The suites that step actually runs; their titles are what TAP can print.
  const declared = new Set();
  for (const file of ['gateway-bundle-shipping.test.mjs', 'packaged-security-smoke.test.mjs', 'final-migration.test.mjs']) {
    const source = fs.readFileSync(path.join(root, 'tests', file), 'utf8');
    for (const match of source.matchAll(/^test\('([^']+)'/gm)) declared.add(match[1]);
  }
  assert.ok(declared.size > 0, 'the dist-gated suites must still declare tests');

  for (const name of names) {
    assert.equal(declared.has(name), true,
      `test.yml requires ${JSON.stringify(name)}, which no dist-gated test declares — the === compare would fail MISSING`);
    // The precise regression: a title that is a PREFIX of a declared one.
    const truncated = [...declared].filter((title) => title !== name && title.startsWith(name));
    assert.deepEqual(truncated, [],
      `${JSON.stringify(name)} is a TRUNCATED prefix of ${JSON.stringify(truncated)} — pass the full title`);
  }
});
