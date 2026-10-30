import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import yaml from 'js-yaml';

// ─────────────────────────────────────────────────────────────────────────────
// W5 — release/installer guards.
//
// Every case here corresponds to a defect that shipped, and each is asserted
// against the REAL files, not a fixture: a fixture proves the assertion works,
// not that the repository is fixed. Where a case needs a mutation, it runs
// against a scratch COPY so the repository is never modified.
// ─────────────────────────────────────────────────────────────────────────────

const root = path.resolve(import.meta.dirname, '..');
const workflowPath = path.join(root, '.github', 'workflows', 'release.yml');
const workflowText = fs.readFileSync(workflowPath, 'utf8');
const workflow = yaml.load(workflowText);

const allSteps = () => Object.entries(workflow.jobs ?? {})
  .flatMap(([jobId, job]) => (job.steps ?? []).map((step, index) => ({ jobId, index, step })));

const uploadSteps = () => allSteps().filter(({ step }) => typeof step.uses === 'string'
  && step.uses.startsWith('softprops/action-gh-release@'));

// ── Defect 1a: concurrency ───────────────────────────────────────────────────

test('W5-1a: the release is serialised per tag, and never cancelled mid-publish', () => {
  assert.ok(workflow.concurrency, 'release.yml must declare a concurrency group, or two runs race on one release');
  assert.equal(typeof workflow.concurrency.group, 'string');

  // The group must be keyed on the TAG, not on the workflow name: a single global
  // group would serialise unrelated releases, and a group keyed on the run id
  // would serialise nothing at all.
  assert.match(workflow.concurrency.group, /inputs\.tag_name/,
    'the concurrency group must include the tag being published');
  assert.match(workflow.concurrency.group, /github\.ref_name/,
    'the concurrency group must fall back to the pushed ref');

  // FALSE is the load-bearing value. Cancelling a publish that already uploaded
  // the installer but not latest.yml leaves a feed that offers a version with no
  // manifest, or a manifest naming an absent file.
  assert.equal(workflow.concurrency['cancel-in-progress'], false,
    'cancel-in-progress must be false: a half-published release is worse than a queued one');
});

// ── Defect 1b: the stale workflow_dispatch default ───────────────────────────

test('W5-1b: workflow_dispatch no longer carries a stale default tag', () => {
  const dispatch = workflow[true]?.workflow_dispatch ?? workflow.on?.workflow_dispatch;
  assert.ok(dispatch, 'workflow_dispatch must still be a trigger');

  const input = dispatch.inputs.tag_name;
  assert.ok(input, 'the tag_name input must still exist');
  assert.equal('default' in input, false,
    'a default tag publishes whatever tree is checked out under a version it does not contain');
  assert.equal(input.required, true,
    'the tag must be required, so a manual run cannot publish an unversioned release');
  // The YAML VALUE must be gone. The string still appears in the explanatory
  // comment above the input, which is deliberate documentation of the defect, so
  // the assertion reads the parsed input rather than the raw text.
  assert.equal(input.default, undefined, 'no default tag may be configured');
});

// ── Defect 1c: tag == package.json version ──────────────────────────────────

test('W5-1c: the job fails unless the tag equals "v" + package.json version', () => {
  const steps = allSteps().map((entry) => entry.step);
  const gateAt = steps.findIndex((step) => step.name === 'Verify the release tag matches package.json');
  assert.ok(gateAt >= 0, 'release.yml must assert the tag against package.json');

  const gate = steps[gateAt];
  // It must run BEFORE npm ci and before packaging: the answer needs neither, and
  // a late check wastes a full Windows packaging run to discover a typo.
  const installAt = steps.findIndex((step) => typeof step.run === 'string' && /npm ci/.test(step.run));
  const buildAt = steps.findIndex((step) => typeof step.run === 'string' && /build:release/.test(step.run));
  assert.ok(gateAt < installAt, 'the version gate must run before npm ci');
  assert.ok(gateAt < buildAt, 'the version gate must run before packaging');

  // The comparison must be a real equality against package.json's version, not a
  // pattern that merely mentions a version.
  assert.match(gate.run, /ConvertFrom-Json\)\.version/,
    'the gate must read the version out of package.json');
  // -cne, not -ne. PowerShell's -ne is case-INSENSITIVE, so `-ne` would accept
  // tag "V0.1.1" against expected "v0.1.1" and publish a tag that is not the
  // version. Git refs are case-sensitive, so the gate must be too.
  assert.match(gate.run, /\$actual\s+-cne\s+\$expected/,
    'the gate must compare the tag to the expected "v"+version string case-sensitively (-cne)');
  // The tag FORMAT must be pinned, case-sensitively, before the version compare:
  // a tag like "v1.2" or "V1.2.3" is not a release tag even if it happens to
  // equal the version string.
  assert.match(gate.run, /\$actual\s+-cnotmatch\s+'\^v\\d\+\\\.\\d\+\\\.\\d\+\$'/,
    'the gate must reject anything that is not ^v\\d+.\\d+.\\d$ (case-sensitive)');
  // The tag must point at the commit being built, or the pipeline publishes a
  // different tree under the tag's version.
  assert.match(gate.run, /git rev-list -n 1 "refs\/tags\/\$actual"/,
    'the gate must resolve the tag\'s commit');
  assert.match(gate.run, /git rev-parse HEAD/,
    'the gate must compare the tag\'s commit against HEAD');
  assert.match(gate.run, /\$tagCommit\s+-cne\s+\$headCommit/,
    'a tag pointing at another commit must fail the gate');
  assert.match(gate.run, /exit 1/,
    'the gate must exit non-zero, not merely print a warning');

  // The tag must arrive through the environment. `${{ }}` inside a run block is
  // a script-injection sink, and a tag is attacker-influenced text.
  assert.ok(gate.env?.NVGW_RELEASE_TAG, 'the tag must be passed via env');
  assert.doesNotMatch(gate.run, /\$\{\{\s*github\.ref_name\s*\}\}/,
    'the tag must not be interpolated directly into the script body');
});

// ── Defect 1d: published bytes are immutable ────────────────────────────────

test('W5-1d: no publish step may overwrite an existing asset', () => {
  const uploads = uploadSteps();
  assert.ok(uploads.length >= 1, 'the publish step must still be present');

  for (const { step } of uploads) {
    // action-gh-release defaults overwrite_files to TRUE. Leaving it unset is
    // therefore the defect, not a neutral omission: a re-run silently replaces
    // the bytes under an identical asset name.
    assert.equal(step.with?.overwrite_files, false,
      `${step.name}: overwrite_files must be explicitly false, not omitted (the default is true)`);
  }
});

// ── Defect 2: fuses ─────────────────────────────────────────────────────────

test('W5-2: the harden step disables the two code-execution fuses and asserts them off', async () => {
  const harden = await import('../scripts/harden-windows-package.mjs');

  // The requirement table is the single source of truth for both the flip and
  // the post-build assertion, so they cannot drift apart.
  const required = harden.REQUIRED_FUSE_STATES;
  assert.ok(required, 'REQUIRED_FUSE_STATES must be exported');

  const byName = Object.fromEntries(Object.entries(required).map(([option, value]) => [option, value]));
  // FuseV1Options is a numeric enum; the names are what a reader checks.
  const nameOf = (index) => ['RunAsNode', 'EnableCookieEncryption', 'EnableNodeOptionsEnvironmentVariable',
    'EnableNodeCliInspectArguments', 'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar',
    'LoadBrowserProcessSpecificV8Snapshot', 'GrantFileProtocolExtraPrivileges', 'WasmTrapHandlers'][Number(index)];

  const states = Object.fromEntries(Object.entries(byName).map(([index, value]) => [nameOf(index), value]));

  assert.equal(states.EnableNodeOptionsEnvironmentVariable, false,
    'NODE_OPTIONS=--require=<code> must not be honoured: it executes before any app code and bypasses ASAR integrity');
  assert.equal(states.EnableNodeCliInspectArguments, false,
    '--inspect must not open a debugger on a process holding the user API keys');

  // The two integrity fuses must stay ON, and RunAsNode must stay ON: the
  // gateway child IS this binary with ELECTRON_RUN_AS_NODE=1.
  assert.equal(states.EnableEmbeddedAsarIntegrityValidation, true);
  assert.equal(states.OnlyLoadAppFromAsar, true);
  assert.equal(states.RunAsNode, true,
    'RunAsNode must stay enabled or the gateway child cannot start');
  // Hardening, no cookie use: cookie store encrypted at rest (added on Electron 44).
  assert.equal(states.EnableCookieEncryption, true,
    'EnableCookieEncryption must be ON: hardening, the app uses no cookies');

  // The post-build assertion must actually consult the table.
  assert.equal(typeof harden.findFuseViolation, 'function');
  assert.equal(harden.findFuseViolation({
    EnableEmbeddedAsarIntegrityValidation: 'enabled',
    OnlyLoadAppFromAsar: 'enabled',
    RunAsNode: 'enabled',
    EnableNodeOptionsEnvironmentVariable: 'disabled',
    EnableNodeCliInspectArguments: 'disabled',
    EnableCookieEncryption: 'enabled'
  }), null, 'a correctly hardened binary must pass');

  for (const [broken, expected] of [
    [{ EnableNodeOptionsEnvironmentVariable: 'enabled' }, /EnableNodeOptionsEnvironmentVariable/],
    [{ EnableNodeCliInspectArguments: 'enabled' }, /EnableNodeCliInspectArguments/],
    [{ RunAsNode: 'disabled' }, /RunAsNode/],
    [{ EnableEmbeddedAsarIntegrityValidation: 'disabled' }, /EnableEmbeddedAsarIntegrityValidation/],
    [{ EnableCookieEncryption: 'disabled' }, /EnableCookieEncryption/]
  ]) {
    const fuses = {
      EnableEmbeddedAsarIntegrityValidation: 'enabled',
      OnlyLoadAppFromAsar: 'enabled',
      RunAsNode: 'enabled',
      EnableNodeOptionsEnvironmentVariable: 'disabled',
      EnableNodeCliInspectArguments: 'disabled',
      EnableCookieEncryption: 'enabled',
      ...broken
    };
    const violation = harden.findFuseViolation(fuses);
    assert.ok(violation, `a ${Object.keys(broken)[0]} regression must be reported`);
    assert.match(violation, expected);
  }
});

test('W5-2: hardenWindowsPackage refuses to return a package whose fuses are wrong', () => {
  // The assertion must be wired into the hook itself, not only exported: a
  // helper nobody calls is not a guard.
  const source = fs.readFileSync(path.join(root, 'scripts', 'harden-windows-package.mjs'), 'utf8');
  assert.match(source, /findFuseViolation\(fuses\)/, 'hardenWindowsPackage must call findFuseViolation');
  assert.match(source, /FUSE_STATE_VIOLATION/, 'a fuse violation must throw, not log');
  assert.match(source, /applyRequiredFuses\(executablePath\)/, 'the flip must go through the shared table');
});

// ── Defect 3: uninstall leaves the Run value ────────────────────────────────

test('W5-3: the NSIS include is wired and deletes exactly this app\'s autostart values', () => {
  const builder = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));

  assert.equal(builder.nsis?.include, 'installer.nsh',
    'nsis.include must name the custom template');
  assert.equal(builder.nsis?.deleteAppDataOnUninstall, false,
    'deleteAppDataOnUninstall must stay false: user data is not ours to delete');

  // Resolve the path the way app-builder-lib's getResource does:
  //   path.resolve(buildResourcesDir, custom)   -- buildResources defaults to build/
  //   ...falling back to path.resolve(projectDir, custom) when that is absent.
  const resourcesDir = path.join(root, 'build');
  let includePath = path.resolve(resourcesDir, builder.nsis.include);
  if (!fs.existsSync(includePath)) includePath = path.resolve(root, builder.nsis.include);
  assert.equal(fs.existsSync(includePath), true, `the include must resolve to an existing file (${includePath})`);
  assert.equal(path.dirname(includePath), resourcesDir,
    'it must live in build/, so electron-builder finds it without an extra path');

  const include = fs.readFileSync(includePath, 'utf8');

  // The exact value name, in a DeleteRegValue against the Run key. A prefix or a
  // wildcard would delete other applications' entries.
  assert.match(include,
    /DeleteRegValue\s+HKCU\s+"Software\\Microsoft\\Windows\\CurrentVersion\\Run"\s+"electron\.app\.NV-Gateway"/,
    'the uninstaller must delete HKCU Run\\electron.app.NV-Gateway by its exact name');

  // StartupApproved records the user's enabled/disabled choice; leaving it behind
  // makes a later install inherit a stale "disabled" bit.
  assert.match(include,
    /DeleteRegValue\s+HKCU\s+"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run"\s+"electron\.app\.NV-Gateway"/,
    'the uninstaller must also clear the StartupApproved twin');

  // It must live in customUnInstall, which electron-builder expands from the
  // uninstall section (uninstaller.nsh:!ifmacrodef customUnInstall).
  assert.match(include, /!macro\s+customUnInstall\b/, 'the deletes must sit in customUnInstall');
  assert.match(include, /!macro\s+customInstall\b/, 'the shortcut repair must sit in customInstall');

  // No wildcard, no prefix match, no whole-key delete anywhere in the file.
  assert.doesNotMatch(include, /DeleteRegKey\s+HKCU\s+"Software\\Microsoft\\Windows\\CurrentVersion\\Run"/,
    'the whole Run key must never be deleted');
  assert.doesNotMatch(include, /electron\.app\.\*/,
    'no wildcard on the value name');
});

// CRF3-001: an update runs the previous uninstaller with --updated
// (installUtil.nsh:205-206), so the autostart deletes must be skipped then, or
// every update silently drops the user's "Launch at sign-in".
function autostartDeletesOutsideUpdateGuard(source) {
  const lines = source.split('\n').map((line) => line.trim());
  const start = lines.findIndex((line) => /^!macro\s+customUnInstall\b/.test(line));
  const end = lines.findIndex((line, index) => index > start && /^!macroend\b/.test(line));
  if (start < 0 || end < 0) return ['customUnInstall missing'];
  const problems = [];
  let guarded = 0;
  let deletes = 0;
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index];
    if (/^\$\{ifNot\}\s+\$\{isUpdated\}$/.test(line)) { guarded += 1; continue; }
    if (/^\$\{(?:endIf|endif)\}$/.test(line)) { guarded -= 1; continue; }
    if (/^DeleteRegValue\b.*electron\.app\.NV-Gateway/.test(line)) {
      deletes += 1;
      if (guarded < 1) problems.push(`unguarded: ${line}`);
    }
  }
  if (deletes !== 4) problems.push(`expected 4 autostart deletes, found ${deletes}`);
  return problems;
}

test('CRF3-001: autostart deletes run only on a real uninstall, never on an update', () => {
  const include = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
  assert.deepEqual(autostartDeletesOutsideUpdateGuard(include), []);

  // Mutation proof: removing the guard must be detected.
  const mutated = include
    .replace(/^\s*\$\{ifNot\}\s+\$\{isUpdated\}\s*\n/m, '')
    .replace(/^\s*\$\{endIf\}\s*\n(?=!macroend)/m, '');
  assert.notEqual(mutated, include, 'the fixture must actually strip the guard');
  const violations = autostartDeletesOutsideUpdateGuard(mutated);
  assert.equal(violations.length, 4, JSON.stringify(violations));
  assert.ok(violations.every((entry) => entry.startsWith('unguarded:')));
});

test('W5-3: the include compiles against the real NSIS template chain', (t) => {
  // Static text assertions cannot tell whether the macros are valid NSIS. This
  // compiles the REAL template includes with the REAL custom include, exactly as
  // electron-builder assembles them, and requires exit code 0.
  const makensis = findMakensis();
  if (!makensis) {
    t.skip('makensis is not available on this machine (electron-builder NSIS cache missing)');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-w5-nsis-${process.pid}-`));
  try {
    const script = [
      `!addincludedir "${path.join(root, 'node_modules', 'app-builder-lib', 'templates', 'nsis')}"`,
      `!addincludedir "${path.join(root, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include')}"`,
      `!addplugindir "${makensis.plugins}"`,
      '!include "LogicLib.nsh"',
      '!include "FileFunc.nsh"',
      // The flag preamble nsisScriptGenerator.flags() emits. Without it the
      // template's ${isNoDesktopShortcut} is an undefined macro and nothing
      // compiles, which is why it is reproduced here rather than assumed.
      '!macro _isNoDesktopShortcut _a _b _t _f',
      '  StrCmp "false" "true" `${_t}` `${_f}`',
      '!macroend',
      '!define isNoDesktopShortcut `"" isNoDesktopShortcut ""`',
      '!macro _isUpdated _a _b _t _f',
      '  StrCmp "false" "true" `${_t}` `${_f}`',
      '!macroend',
      '!define isUpdated `"" isUpdated ""`',
      'OutFile "w5.exe"',
      // PRODUCT_NAME and VERSION are what the real build passes as -D defines
      // (26.18.0 NsisTarget.js:268-272 defines), and common.nsh:14 emits
      //   Name "${PRODUCT_NAME}" "${DoubleAmpersand}"
      // from them. This script must therefore NOT emit its own `Name`: doing so
      // is a second Name command, which under -WX (the flag the shipping build
      // uses) is a fatal "warning 6029: Name: specified multiple times". Leaving
      // it in meant the test compiled a script the real build would have rejected.
      '!define PRODUCT_NAME "NV-Gateway"',
      '!define VERSION "0.0.0"',
      '!define APP_ID "com.susmnavorasem.nvgateway"',
      '!define SHORTCUT_NAME "NV-Gateway"',
      '!define PRODUCT_FILENAME "NV-Gateway"',
      '!define APP_DESCRIPTION "probe"',
      '!define INSTALL_REGISTRY_KEY "Software\\probe-guid"',
      '!define UNINSTALL_REGISTRY_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\probe-guid"',
      'Var oldShortcutName', 'Var oldDesktopLink', 'Var newDesktopLink',
      'Var oldMenuDirectory', 'Var oldStartMenuLink', 'Var newStartMenuLink',
      'Var appExe', 'Var keepShortcuts',
      '!include "common.nsh"',
      '!include "installer.nsh"',
      // electron-builder includes the custom file by ABSOLUTE path.
      `!include "${path.join(root, 'build', 'installer.nsh').replace(/\\/g, '\\\\')}"`,
      'Section "install"',
      '  StrCpy $keepShortcuts "false"',
      '  StrCpy $appExe "$INSTDIR\\NV-Gateway.exe"',
      '  !insertmacro setLinkVars',
      '  !insertmacro addDesktopLink "false"',
      '  !insertmacro customInstall',
      '  ; An un.install section without WriteUninstaller is "warning 6020: Uninstaller',
      '  ; script code found but WriteUninstaller never used" — fatal under -WX. The',
      '  ; real chain avoids it by compiling a separate BUILD_UNINSTALLER pass',
      '  ; (installer.nsi:56-58). This harness has one pass, so it writes the',
      '  ; uninstaller here instead of dropping the un.install section that is the',
      '  ; whole point of the case.',
      '  WriteUninstaller "$INSTDIR\\w5-uninstall.exe"',
      'SectionEnd',
      'Section "un.install"',
      '  !insertmacro customUnInstall',
      'SectionEnd'
    ].join('\n');

    const scriptPath = path.join(dir, 'w5.nsi');
    fs.writeFileSync(scriptPath, script, 'ascii');
    // The SAME flags the shipping build uses, read out of
    // app-builder-lib/out/targets/nsis/NsisTarget.js:623-624 (26.18.0) —
    //   const args = this.options.warningsAsErrors === false ? [] : ["-WX"];
    //   args.push("-INPUTCHARSET", "UTF8");
    // electron-builder.yml does not set warningsAsErrors, whose documented default
    // is true (nsisOptions.d.ts), so the real build DOES pass -WX. Compiling
    // without it here was a weaker test than the build: NSIS warnings (an unused
    // macro, a deprecated instruction, an ambiguous define) were tolerated by the
    // test and fatal in the real pipeline. -INPUTCHARSET UTF8 is the other half:
    // the include and the templates are UTF-8, and makensis without it reads them
    // in the ANSI codepage, which is how non-ASCII text silently becomes "?".
    const result = spawnSync(makensis.exe, ['-WX', '-INPUTCHARSET', 'UTF8', '/V2', scriptPath],
      { encoding: 'utf8', windowsHide: true });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(result.status, 0, `the custom include must compile against the shipping templates:\n${output}`);
    assert.equal(fs.existsSync(path.join(dir, 'w5.exe')), true, 'makensis must produce an installer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Locate makensis + the electron-builder plugin dir, or null when unavailable. */
function findMakensis() {
  const cache = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'nsis');
  if (!fs.existsSync(cache)) return null;
  for (const entry of fs.readdirSync(cache)) {
    const exe = path.join(cache, entry, 'makensis.exe');
    if (entry.startsWith('nsis-') && fs.existsSync(exe)) {
      const plugins = path.join(cache, 'nsis-resources-3.4.1', 'plugins', 'x86-ansi');
      return { exe, plugins: fs.existsSync(plugins) ? plugins : path.dirname(exe) };
    }
  }
  return null;
}

// ── Defect 4: SHA256SUMS must describe the release it ships with ────────────

test('W5-4: the checksum file covers exactly the published artifacts', () => {
  const uploads = uploadSteps();
  assert.equal(uploads.length, 1, 'there is ONE release, so exactly one upload step');
  const [release] = uploads;

  const releaseFiles = String(release.step.with.files).split('\n').map((line) => line.trim()).filter(Boolean);
  assert.ok(releaseFiles.includes('dist/SHA256SUMS.txt'), 'the release must ship its checksum file');

  const steps = allSteps().map((entry) => entry.step);
  const sums = steps.find((step) => step.name === 'Generate Checksums');
  assert.ok(sums, 'the checksum step must exist');

  // The checksum step must enumerate the same artifacts the upload ships. Read
  // the literal filenames out of the script and compare against the upload list,
  // with $version standing in for the version the script interpolates.
  const named = [...sums.run.matchAll(/"dist\/([^"]+)"/g)].map((match) => match[1]);
  assert.ok(named.length >= 4, 'the checksum step must name its artifacts explicitly');
  const sample = (file) => `dist/${file.replace(/\$version/g, '9.9.9')}`;
  const globMatches = (glob, candidate) =>
    new RegExp(`^${glob.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}\$`).test(candidate);
  for (const file of named) {
    assert.ok(releaseFiles.some((glob) => globMatches(glob, sample(file))),
      `the checksum file lists dist/${file}, which the release does not ship`);
  }
  // ...and the reverse: every shipped artifact except the checksum file itself
  // must be covered, or a downloader cannot verify it.
  for (const glob of releaseFiles.filter((entry) => entry !== 'dist/SHA256SUMS.txt')) {
    assert.ok(named.some((file) => globMatches(glob, sample(file))),
      `${glob} is published but missing from SHA256SUMS.txt`);
  }

  // A directory glob is how absent files got listed before; enumerate instead.
  assert.doesNotMatch(sums.run, /Get-ChildItem[^\n]*dist\/\*/,
    'a directory glob is how absent files got listed; enumerate the artifacts instead');
  assert.match(sums.run, /NV-Gateway-\$version-win-x64\.zip/,
    'the checksum step must cover the zip the release publishes');
});

// ── Defect 5: desktop shortcut ──────────────────────────────────────────────

test('W5-5: createDesktopShortcut stays true and the include repairs an absent link on update', () => {
  const builder = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));

  // The config value was never the bug, so "fixing" it would have changed nothing.
  // The measured cause is the template's ${ifNot} ${isUpdated} guard around the
  // recreate branch (app-builder-lib 26.18.0
  // templates/nsis/include/installer.nsh:234-238; was :214-222 in 24.13.3).
  assert.equal(builder.nsis?.createDesktopShortcut, true,
    'createDesktopShortcut must stay true: it is not the cause of the missing link');

  const include = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
  assert.match(include, /CreateShortCut\s+"\$newDesktopLink"/,
    'the include must create the shortcut at the template\'s own $newDesktopLink');
  assert.match(include, /\$\{ifNot\}\s+\$\{FileExists\}\s+"\$newDesktopLink"/,
    'it must only fill in a link that is genuinely absent, never overwrite the user\'s');
  assert.match(include, /!macro\s+customInstall\b/,
    'customInstall runs after addDesktopLink, so it sees the final state');
  // It must not override an explicit "no shortcut" choice: the compile-time
  // define and the runtime flag both mean the link is unwanted.
  assert.match(include, /!ifndef\s+DO_NOT_CREATE_DESKTOP_SHORTCUT/,
    'an explicit createDesktopShortcut:false must still suppress the link');
  assert.match(include, /\$\{ifNot\}\s+\$\{isNoDesktopShortcut\}/,
    'the runtime no-desktop-shortcut flag must still suppress the link');
});

// -- Defect 6: the duplicate publish is gone (owner decision: same-repo releases)

test('W5-6: there is exactly one publish, into this repository', () => {
  // The source repo is public and is the update feed, so the old second
  // "archive" publish is retired. If someone re-adds a second upload, this fails
  // and points at that decision.
  const uploads = uploadSteps();
  assert.equal(uploads.length, 1,
    'releases go to ONE repository; a second publish step reintroduces the split this release removed');
  assert.equal(uploads[0].step.with.body_path, 'build/release-body.md',
    'the release body is the user block + the CHANGELOG section');
  assert.match(String(uploads[0].step.with.repository), /steps\.release-target\.outputs\.feed_repository/,
    'the single publish targets the guard-resolved feed, which is this repository');
});

// ── The workflow must still be valid YAML ──────────────────────────────────

test('W5: release.yml parses as YAML and keeps its trigger surface', () => {
  assert.equal(typeof workflow, 'object');
  const triggers = workflow[true] ?? workflow.on;
  assert.ok(triggers.push?.tags?.includes('v*.*.*'), 'tag pushes must still trigger the release');
  assert.ok(triggers.workflow_dispatch, 'manual dispatch must still be available');
  // Least privilege per OpenSSF Scorecard (TokenPermissions): read-only at the
  // top level, write only on the publishing job.
  assert.equal(workflow.permissions?.contents, 'read');
  assert.equal(workflow.jobs?.['build-release']?.permissions?.contents, 'write');
});

// ── The guards above must actually FAIL on the defect, not merely pass today ─
//
// A guard that cannot fail proves nothing. Each case reintroduces one of the
// original defects into a scratch copy and asserts that the corresponding check
// reports it. This is what separates "the file is correct today" from "the file
// cannot silently regress".

/** Re-read a mutated workflow the way every assertion above reads the real one. */
function audit(text) {
  const doc = yaml.load(text);
  const problems = [];
  const steps = Object.values(doc.jobs ?? {}).flatMap((job) => job.steps ?? []);
  const uploads = steps.filter((step) => String(step.uses ?? '').startsWith('softprops/'));

  if (!doc.concurrency) problems.push('concurrency missing');
  else if (doc.concurrency['cancel-in-progress'] !== false) problems.push('cancel-in-progress is not false');

  const input = (doc[true] ?? doc.on).workflow_dispatch.inputs.tag_name;
  if ('default' in input) problems.push('stale default present');
  if (input.required !== true) problems.push('tag not required');

  for (const upload of uploads) {
    if (upload.with?.overwrite_files !== false) problems.push(`overwrite_files unset on ${upload.name}`);
  }

  const gate = steps.find((step) => step.name === 'Verify the release tag matches package.json');
  if (!gate) problems.push('version gate missing');
  else {
    if (!/\$actual\s+-cne\s+\$expected/.test(gate.run)) problems.push('gate does not compare');
    if (!/exit 1/.test(gate.run)) problems.push('gate does not exit 1');
    if (!/\$actual\s+-cnotmatch/.test(gate.run)) problems.push('gate does not check the tag format');
    if (!/\$tagCommit\s+-cne\s+\$headCommit/.test(gate.run)) problems.push('gate does not check the tag commit');
  }

  const sums = steps.find((step) => step.name === 'Generate Checksums');
  if (!sums) problems.push('checksum step missing');
  else if (/Get-ChildItem[^\n]*dist\/\*/.test(sums.run)) problems.push('checksums glob the directory');

  // A republish must be refused BEFORE any upload. Deleting the step restores the
  // silent-green no-op this pipeline was burned by.
  const republishAt = steps.findIndex((step) => step.name === 'Refuse to republish a published tag');
  if (republishAt < 0) problems.push('republish guard missing');
  else {
    const firstUpload = steps.findIndex((step) => String(step.uses ?? '').startsWith('softprops/'));
    if (!(republishAt < firstUpload)) problems.push('republish guard runs after an upload');
  }

  return problems;
}

/**
 * Delete one whole step (by its `- name:`) from a workflow text, leaving the file
 * valid YAML.
 *
 * A regex that stops at the next `Write-Host` cuts mid-step and produces invalid
 * YAML, so the mutation then "fails" because the document will not parse rather
 * than because the guard noticed the defect. That is a vacuous case wearing a
 * passing verdict. This walks the step's own line range instead.
 */
function removeStep(text, name) {
  const all = text.split('\n');
  const start = all.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start < 0) throw new Error(`cannot remove a step that does not exist: ${name}`);
  const indent = all[start].length - all[start].trimStart().length;
  let end = all.length;
  for (let index = start + 1; index < all.length; index += 1) {
    const width = all[index].length - all[index].trimStart().length;
    if (all[index].trim() !== '' && width === indent && /^-\s/.test(all[index].trim())) {
      end = index;
      break;
    }
  }
  return [...all.slice(0, start), ...all.slice(end)].join('\n');
}

test('W5: every guard rejects the defect it was written for', () => {
  // Baseline: the shipping file has no problems, or the cases below prove nothing.
  assert.deepEqual(audit(workflowText), [], 'the shipping workflow must pass its own audit');

  const mutations = [
    ['concurrency removed',
      (text) => text.replace(/^concurrency:\n[\s\S]*?  cancel-in-progress: false\n/m, ''),
      /concurrency missing/],
    ['cancel-in-progress flipped to true',
      (text) => text.replace('cancel-in-progress: false', 'cancel-in-progress: true'),
      /cancel-in-progress is not false/],
    ['the stale v0.1.0 default restored',
      (text) => text.replace('required: true', "required: false\n        default: 'v0.1.0'"),
      /stale default present/],
    ['overwrite_files deleted, restoring the default of true',
      (text) => text.replace(/\n\s*overwrite_files: false/g, ''),
      /overwrite_files unset/],
    ['the version gate deleted',
      (text) => removeStep(text, 'Verify the release tag matches package.json'),
      /version gate missing/],
    ['the version gate made non-failing',
      (text) => text.replace(/\$actual -cne \$expected/, '$false'),
      /gate does not compare/],
    ['the version comparison made case-insensitive (-ne)',
      (text) => text.replace(/\$actual -cne \$expected/, '$actual -ne $expected'),
      /gate does not compare/],
    ['the tag-format check deleted',
      (text) => text.replace(/\$actual -cnotmatch [^\n]*/, '$actual -cnotlike ""'),
      /gate does not check the tag format/],
    ['the tag-commit check made non-failing',
      (text) => text.replace(/\$tagCommit -cne \$headCommit/, '$false'),
      /gate does not check the tag commit/],
    ['the tag-commit comparison made case-insensitive (-ne)',
      (text) => text.replace(/\$tagCommit -cne \$headCommit/, '$tagCommit -ne $headCommit'),
      /gate does not check the tag commit/],
    ['the republish guard deleted',
      (text) => removeStep(text, 'Refuse to republish a published tag'),
      /republish guard missing/],
    ['the republish guard moved after the uploads',
      (text) => {
        const removed = removeStep(text, 'Refuse to republish a published tag');
        const all = removed.split('\n');
        // Re-insert the step text at the end of the job, i.e. after the upload.
        const stepStart = text.split('\n').findIndex((line) => line.trim() === '- name: Refuse to republish a published tag');
        const stepEnd = text.split('\n').findIndex((line, index) => index > stepStart
          && line.trim() === '- name: Install dependencies');
        const block = text.split('\n').slice(stepStart, stepEnd);
        return [...all, ...block].join('\n');
      },
      /republish guard runs after an upload/],
    ['the checksum step reverted to a directory glob',
      (text) => text.replace('$releaseFiles = @(', 'Get-ChildItem -Path dist/*.exe, dist/*.zip\n          $releaseFiles = @('),
      /glob the directory/]
  ];

  for (const [label, mutate, expected] of mutations) {
    const mutated = mutate(workflowText);
    assert.notEqual(mutated, workflowText, `${label}: the mutation must actually change the file, or the case is vacuous`);
    const problems = audit(mutated);
    assert.ok(problems.length > 0, `${label}: the guard MISSED the defect`);
    assert.match(problems.join('; '), expected, `${label}: wrong reason reported`);
  }
});
