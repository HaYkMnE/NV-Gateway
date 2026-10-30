// Regression test for finding W-Q-2: no test may point the gateway logger at a
// path inside the repository.
//
// MEASURED DEFECT (CodeRabbit deep audit, W-Q wave): security-hardening.test.mjs
// and production-security-wiring.test.mjs set
//   GATEWAY_LOG_PATH = <repo>/tests/non-live-log.jsonl
// The gateway logger resolves that path at import time and appends to it on a 1s
// debounce, so any log call inside those processes dropped an (ignored, hence
// invisible) *.jsonl side-effect file into tests/ — repo dirt on every run, and
// a path that can never be cleaned up reliably because the write is debounced.
//
// Two independent guards:
//   1. STATIC: no test source may assign GATEWAY_LOG_PATH / GATEWAY_STATE_PATH to
//      a path built from import.meta.dirname (i.e. inside the repo).
//   2. BEHAVIOURAL: running the affected test file leaves tests/ byte-identical.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const testsDir = path.join(root, 'tests');

function testFiles() {
  return fs.readdirSync(testsDir).filter((name) => name.endsWith('.test.mjs'));
}

function snapshot() {
  const entries = new Map();
  for (const name of fs.readdirSync(testsDir)) {
    const full = path.join(testsDir, name);
    const stat = fs.statSync(full);
    entries.set(name, `${stat.size}:${stat.mtimeMs}`);
  }
  return entries;
}

test('THE REGRESSION: no test assigns a gateway LOG path inside the repo', () => {
  const offenders = [];
  for (const name of testFiles()) {
    const source = fs.readFileSync(path.join(testsDir, name), 'utf8');
    for (const line of source.split('\n')) {
      // GATEWAY_LOG_PATH is APPENDED to by the logger, so a repo-relative value
      // is a write side effect. (GATEWAY_STATE_PATH is not covered: the tests use
      // the committed read-only fixture tests/non-live-state.json.)
      if (!/GATEWAY_LOG_PATH\s*=/.test(line)) continue;
      // Any path expression rooted at the test file's own directory lands in the repo.
      if (/import\.meta\.dirname/.test(line) || /['"]tests['"]/.test(line) || /__dirname/.test(line)) {
        offenders.push(`${name}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `gateway log paths must resolve under os.tmpdir():\n${offenders.join('\n')}`);
});

test('the two fixed files point the logger at os.tmpdir() and clean up', () => {
  for (const name of ['security-hardening.test.mjs', 'production-security-wiring.test.mjs']) {
    const source = fs.readFileSync(path.join(testsDir, name), 'utf8');
    const assignments = source.split('\n').filter((line) => /GATEWAY_LOG_PATH\s*=/.test(line));
    assert.ok(assignments.length > 0, `${name} must still configure GATEWAY_LOG_PATH`);
    for (const line of assignments) {
      assert.doesNotMatch(line, /import\.meta\.dirname/,
        `${name} must not point the logger at tests/: ${line.trim()}`);
    }
    assert.match(source, /mkdtempSync|temporaryDirectory\(/, `${name} must use a per-run temp dir`);
  }
  // security-hardening cleans up in the finally block of its own test.
  const hardening = fs.readFileSync(path.join(testsDir, 'security-hardening.test.mjs'), 'utf8');
  assert.match(hardening, /fs\.rmSync\(logDir, \{ recursive: true, force: true \}\)/,
    'the temp log dir must be removed in a finally');
  // production-security-wiring cleans up in its test.after hook.
  const wiring = fs.readFileSync(path.join(testsDir, 'production-security-wiring.test.mjs'), 'utf8');
  assert.match(wiring, /for \(const directory of temporaryDirectories\) fs\.rmSync\(directory/,
    'the shared temp dirs must be removed in the after hook');
});

// ---------------------------------------------------------------------------
// BEHAVIOURAL PROOF (finding #2). The original case 3 only asserted "no new file
// under tests/" after a run, which was VACUOUS: measured with an auditor hooking
// fs.appendFileSync across both suites, ZERO appends happened, so "no *.jsonl"
// held because nothing was ever written and the case passed even before the fix.
//
// The probe below makes the write REAL and attributes it to a path:
//   * a generated preload (kept in a temp dir, never in the repo) hooks
//     fs.appendFileSync and records every target;
//   * process.env is wrapped in a Proxy that intercepts the ASSIGNMENT of
//     GATEWAY_LOG_PATH (a timer cannot be used: a short-lived suite can finish
//     before the first tick — measured: the 10ms poll fired zero times on
//     production-security-wiring because its admin tests resolve GATEWAY_LOG_PATH
//     lazily via adminLogPath() and the whole file exits in ~1.5s of wall time
//     inside a busy worker);
//   * on that assignment the probe performs one genuine logger write through the
//     SAME logger module the gateway uses (`info` + `flushLogs`), i.e. the exact
//     write path behind admin-api.mjs:287 -> logger.mjs flushLogs -> appendFileSync;
//   * the parent then asserts an append was OBSERVED (not vacuous), that every
//     target resolves under os.tmpdir(), and that none resolves under tests/.
// If the path logic regresses to `path.join(import.meta.dirname, ...)`, the
// observed target becomes <repo>/tests/non-live-log.jsonl and this test fails on
// the target check in addition to the snapshot check.
const PROBE_SOURCE = String.raw`
const fs = require('node:fs');
const realAppend = fs.appendFileSync;
const report = process.env.WQ_LOG_PROBE_REPORT;
function note(entry) {
  try { realAppend.call(fs, report, JSON.stringify(entry) + '\n', 'utf8'); } catch {}
}
fs.appendFileSync = function patched(target, ...rest) {
  note({ kind: 'append', target: String(target) });
  return realAppend.call(fs, target, ...rest);
};
const realEnv = process.env;
const envProxy = new Proxy(realEnv, {
  set(target, key, value) {
    target[key] = value;
    if (key === 'GATEWAY_LOG_PATH' && typeof value === 'string' && value.length > 0) {
      note({ kind: 'observed', target: value });
      Promise.resolve().then(async () => {
        try {
          const logger = await import(process.env.WQ_LOG_PROBE_LOGGER);
          logger.info('wq_log_path_probe', { ok: true });
          logger.flushLogs();
          note({ kind: 'probed', target: value });
        } catch (error) {
          note({ kind: 'error', message: String((error && error.message) || error) });
        }
      });
    }
    return true;
  },
  get(target, key) { return target[key]; },
  has(target, key) { return key in target; },
  deleteProperty(target, key) { delete target[key]; return true; },
  ownKeys(target) { return Reflect.ownKeys(target); },
  getOwnPropertyDescriptor(target, key) { return Reflect.getOwnPropertyDescriptor(target, key); }
});
Object.defineProperty(process, 'env', { value: envProxy, configurable: true, writable: true });
`;

const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-log-probe-${process.pid}-`));
const probePath = path.join(probeRoot, 'log-write-probe.cjs');
fs.writeFileSync(probePath, PROBE_SOURCE, 'utf8');
test.after(() => fs.rmSync(probeRoot, { recursive: true, force: true }));

function runSuiteWithProbe(name) {
  const reportPath = path.join(probeRoot, `${name}-${Date.now()}.jsonl`);
  // NODE_TEST_CONTEXT must NOT be inherited: when this file itself runs under
  // `node --test`, the variable marks the process as a test worker, so a spawned
  // `node --test` prints "node:test run() is being called recursively within a
  // test file. skipping running files", runs NOTHING and exits 0 with empty
  // stdout. The original case 3 inherited it, so its child never executed — the
  // suite "passed" without running a single assertion. Measured both ways.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  const run = spawnSync(process.execPath, ['--test', path.join(testsDir, name)], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...childEnv,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--require ${probePath}`,
      WQ_LOG_PROBE_REPORT: reportPath,
      WQ_LOG_PROBE_LOGGER: pathToFileURL(path.join(root, 'src', 'gateway', 'logger.mjs')).href
    }
  });
  const entries = fs.existsSync(reportPath)
    ? fs.readFileSync(reportPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { run, entries };
}

test('running either suite WRITES its gateway log (inside os.tmpdir(), never under tests/)', () => {
  // Both files are covered: production-security-wiring resolves its path through
  // adminLogPath(), a different expression from security-hardening's logDir, so
  // covering only one of them left the other's path logic unexercised.
  //
  // Paths are compared lexically (normalised, lowercased) rather than through
  // realpath: the suites delete their temp dirs before exiting, so a realpath of
  // the observed target would ENOENT after a correct run.
  const normalise = (value) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  //
  // os.tmpdir() is accepted in BOTH spellings. On GitHub's Windows runners TEMP is
  // the 8.3 short form (C:\Users\RUNNER~1\AppData\Local\Temp); the child suites
  // build their path from that raw os.tmpdir(), while realpathSync.native expands it
  // to the long name, so a realpath-only prefix rejected a correct temp path
  // (measured in Test Suite run 40896040373, reproduced locally with an 8.3 TEMP).
  const tmpPrefixes = [...new Set([
    normalise(os.tmpdir()),
    normalise(fs.realpathSync.native(os.tmpdir()))
  ])];
  const testsPrefix = normalise(fs.realpathSync.native(testsDir));
  for (const name of ['security-hardening.test.mjs', 'production-security-wiring.test.mjs']) {
    const before = snapshot();
    const { run, entries } = runSuiteWithProbe(name);
    assert.equal(run.status, 0, `${name} must pass:\n${run.stdout}${run.stderr}`);

    const observed = entries.filter((entry) => entry.kind === 'observed');
    assert.equal(observed.length > 0, true,
      `the probe must observe GATEWAY_LOG_PATH inside ${name}; without it this case is vacuous again (entries: ${JSON.stringify(entries)})`);
    assert.equal(entries.some((entry) => entry.kind === 'probed'), true,
      `the logger write must COMPLETE inside ${name}, or the append was never exercised: ${JSON.stringify(entries)}`);
    assert.equal(entries.some((entry) => entry.kind === 'error'), false,
      `the probe must not fail to import the logger: ${JSON.stringify(entries.filter((e) => e.kind === 'error'))}`);

    // THE ASSERTION THAT MATTERS: a real append happened, and it happened in the
    // temp dir. A regressed path is caught here, not merely by "no new file".
    const appends = entries.filter((entry) => entry.kind === 'append');
    assert.equal(appends.length > 0, true,
      `${name} must produce at least one real append now that a logging route is exercised: ${JSON.stringify(entries)}`);
    for (const { target } of appends) {
      const resolved = normalise(path.dirname(target));
      assert.equal(resolved.startsWith(testsPrefix), false,
        `${name} appended inside the repository (${target}) — the path logic regressed`);
      assert.equal(tmpPrefixes.some((prefix) => resolved.startsWith(prefix)), true,
        `${name} must append under os.tmpdir(), saw ${target}`);
    }

    // The suite still cleans up after itself: no residue in tests/.
    const after = snapshot();
    const added = [...after.keys()].filter((entry) => !before.has(entry));
    assert.deepEqual(added, [], `${name} must not create a file under tests/: ${added.join(', ')}`);
    const changed = [...after.keys()].filter((entry) => before.has(entry) && before.get(entry) !== after.get(entry));
    assert.deepEqual(changed, [], `${name} must not modify a file under tests/: ${changed.join(', ')}`);
  }
});

test('the probe itself is not vacuous: it reports a write when a repo path is used', () => {
  // Guards the guard. If the probe silently failed to hook (or the logger import
  // broke), the case above would pass on an empty entry list. Here the SAME probe
  // is pointed at a path under tests/ on purpose and must both record an append
  // and land in the repository — proving it can observe the bad case too.
  const sentinel = path.join(testsDir, `wq-probe-sentinel-${process.pid}.jsonl`);
  const reportPath = path.join(probeRoot, `sentinel-${Date.now()}.jsonl`);
  const driver = path.join(probeRoot, `driver-${process.pid}.mjs`);
  fs.writeFileSync(driver, [
    `process.env.GATEWAY_LOG_PATH = ${JSON.stringify(sentinel)};`,
    `process.env.WQ_LOG_PROBE_REPORT = ${JSON.stringify(reportPath)};`,
    `process.env.WQ_LOG_PROBE_LOGGER = ${JSON.stringify(pathToFileURL(path.join(root, 'src', 'gateway', 'logger.mjs')).href)};`,
    `await import(${JSON.stringify(pathToFileURL(probePath).href)});`,
    `const logger = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src', 'gateway', 'logger.mjs')).href)});`,
    `logger.info('wq_probe_sentinel', { ok: true });`,
    `logger.flushLogs();`,
    `await new Promise((resolve) => setTimeout(resolve, 50));`,
    ''
  ].join('\n'), 'utf8');
  try {
    const run = spawnSync(process.execPath, [driver], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const entries = fs.readFileSync(reportPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const appends = entries.filter((entry) => entry.kind === 'append').map((entry) => entry.target);
    assert.equal(appends.length > 0, true, `the probe must record appends, saw ${JSON.stringify(entries)}`);
    assert.equal(
      appends.some((target) => target.toLowerCase() === sentinel.toLowerCase()),
      true,
      `the probe must be able to see a repository target, saw ${JSON.stringify(appends)}`
    );
  } finally {
    fs.rmSync(sentinel, { force: true });
  }
});

