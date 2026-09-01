#!/usr/bin/env node
// Verifies that a `node --test` TAP log PROVES the named assertions actually ran.
//
// Why this exists as a script instead of inline PowerShell in test.yml: the inline
// version was a textual guard, and it had a hole. It rejected `# SKIP` on the named
// `ok` lines, but node:test has a SECOND way to neutralise a test — `t.todo()` /
// `{ todo: true }` — and TODO is reported completely differently:
//
//   ok 1 - <name> # TODO reason          <- reads as a pass to an `# SKIP`-only check
//   not ok 2 - <name> # TODO             <- a THROWN test, yet counted as todo, not fail
//   # fail 0                             <- still zero
//   exit code 0                          <- still success
//
// Measured on Node v20.20.2 and v22.22.2, both with the default reporter and with
// `--test-reporter=tap`: flipping a `skip:` gate to `todo:` makes the whole proof
// step pass while the assertions never execute — and one of them can even THROW.
// So this checks fail/todo/skip counts, rejects `not ok` outright, and refuses to
// pass when it cannot parse the summary at all (shape drift fails CLOSED, not open).
//
// Takes the log path and the expectations as ARGUMENTS on purpose. There is no env
// var that can redirect or relax it — an env-redirected guard has already been a bug
// in this repo once (NVGW_PACKAGE_OUTPUT_DIRECTORY).
//
// Usage:
//   node scripts/assert-tap-proof.mjs <tap-log> --require-ok=<name> [...] [--require-marker=<text>]
// Exit 0 = proven, 1 = not proven (with reasons on stderr).

import fs from 'node:fs';

const argv = process.argv.slice(2);
const logPath = argv.find((a) => !a.startsWith('--'));
const requiredOk = argv
  .filter((a) => a.startsWith('--require-ok='))
  .map((a) => a.slice('--require-ok='.length))
  .filter(Boolean);
const requiredMarkers = argv
  .filter((a) => a.startsWith('--require-marker='))
  .map((a) => a.slice('--require-marker='.length))
  .filter(Boolean);

const problems = [];
const notes = [];

if (!logPath) {
  console.error('USAGE: node scripts/assert-tap-proof.mjs <tap-log> --require-ok=<name> ...');
  process.exit(2);
}
if (requiredOk.length === 0 && requiredMarkers.length === 0) {
  // A guard with nothing to assert is the vacuous pass this script exists to stop.
  console.error('REFUSING: no --require-ok / --require-marker expectations were given.');
  process.exit(2);
}
if (!fs.existsSync(logPath)) {
  console.error(`MISSING LOG: ${logPath} does not exist — the test step produced no output.`);
  process.exit(1);
}

// Decode by BOM, not by assumption. `shell: pwsh` (test.yml) makes Tee-Object write
// UTF-8, but Windows PowerShell 5.1 writes UTF-16LE for the same pipeline — measured:
// the same log came out `54 41 50 20` under pwsh 7 and `ff fe 54 00` under 5.1. Read
// as UTF-8, a UTF-16LE log parses as garbage, no pattern matches, and a naive checker
// would report "nothing failed". Handling the BOM keeps that from ever mattering.
const buf = fs.readFileSync(logPath);
let raw;
if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) raw = buf.toString('utf16le');
else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) raw = buf.swap16().toString('utf16le');
else raw = buf.toString('utf8');
raw = raw.replace(/^\uFEFF/, '');
const lines = raw.split(/\r?\n/);

// ---- Shape sanity: if this log is not TAP at all, every pattern below would
// ---- silently match nothing. Fail closed instead of reporting success.
if (!lines.some((l) => /^TAP version \d+/.test(l.trim()))) {
  problems.push('NOT TAP: no "TAP version" line — cannot prove anything from this log.');
}

// ---- Counters. Absence of a counter is itself a failure (shape drift).
const counter = (name) => {
  const re = new RegExp(`^#\\s*${name}\\s+(\\d+)\\s*$`);
  for (const l of lines) {
    const m = re.exec(l.trim());
    if (m) return Number(m[1]);
  }
  return null;
};

// `# skipped` is deliberately NOT asserted to be 0. final-migration.test.mjs:322
// legitimately calls t.skip() when the runner refuses junction creation, and that
// skip is unrelated to the packaged assertions. Skipping of the assertions that DO
// matter is caught per-name below, which is the precise check rather than a blunt
// one that could fail the build for an honest reason.
for (const [name, expected] of [['fail', 0], ['todo', 0]]) {
  const got = counter(name);
  if (got === null) {
    problems.push(`UNPARSEABLE: no "# ${name} <n>" summary line — TAP shape changed, refusing to pass.`);
  } else if (got !== expected) {
    problems.push(`# ${name} ${got} (expected ${expected}) — assertions were neutralised or failed.`);
  } else {
    notes.push(`# ${name} ${got}`);
  }
}
// Reported for the log, never used as a pass/fail input.
const skipped = counter('skipped');
if (skipped !== null) notes.push(`# skipped ${skipped} (informational)`);

// ---- A thrown test marked todo still prints `not ok`. Nothing legitimate in a
// ---- green packaged run does, so any `not ok` is fatal regardless of counters.
const notOk = lines.filter((l) => /^not ok \d+\b/.test(l));
for (const l of notOk) problems.push(`NOT OK: ${l.trim()}`);

// ---- The named assertions must appear as a real, un-annotated pass.
for (const name of requiredOk) {
  const line = lines.find((l) => /^ok \d+ - /.test(l) && l.includes(name));
  if (!line) {
    problems.push(`MISSING : ${name}`);
    continue;
  }
  const annotation = /#\s*(SKIP|TODO)\b/i.exec(line);
  if (annotation) {
    problems.push(`NEUTRALISED (${annotation[1].toUpperCase()}): ${line.trim()}`);
  } else {
    notes.push(`EXECUTED: ${line.trim()}`);
  }
}

// ---- Markers prove an early-RETURN test actually reached its assertions.
for (const marker of requiredMarkers) {
  const line = lines.find((l) => l.includes(marker));
  if (!line) problems.push(`MISSING : ${marker} marker`);
  else notes.push(`EXECUTED: ${line.trim()}`);
}

for (const n of notes) console.log(n);
if (problems.length > 0) {
  console.error('');
  for (const p of problems) console.error(`FAIL: ${p}`);
  console.error('PACKAGED_ASSERTIONS_NOT_PROVEN');
  process.exit(1);
}
console.log('ALL_PACKAGED_ASSERTIONS_EXECUTED');
