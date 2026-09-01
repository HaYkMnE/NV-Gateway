// error-reporter.ts: errors.log under OBSTRUCTED ROTATION.
//
// THE DEFECT. rotateIfNeeded() swallows every failure by design (a logger must
// not throw into its caller) and appendEntry() then appends unconditionally. So
// when all three generation NAMES are occupied and cannot be unlinked or renamed
// onto — an antivirus scanner, a backup tool, an editor, a stale handle — the
// rotation silently no-ops on every single append and the ACTIVE log grows
// without bound. The 5 MB x 3 cap is not a cap at all in that state; it is a cap
// only while the filesystem cooperates.
//
// WHY THE FIXTURE IS A DIRECTORY, not an open file handle. MEASURED on this
// machine (Windows, Node's fs):
//
//   openSync(path, 'r') + rename ONTO it  -> EPERM
//   openSync(path, 'r') + unlink it       -> SUCCEEDED   <-- name is freed
//   openSync(path, 'a') + rename ONTO it  -> EPERM
//   openSync(path, 'a') + unlink it       -> SUCCEEDED   <-- name is freed
//   non-empty DIRECTORY + rename ONTO it  -> EPERM
//   non-empty DIRECTORY + unlink it       -> EPERM
//
// An open handle blocks the RENAME but not the UNLINK, so the first step of the
// rotation (drop the oldest generation) frees a name and the shift partially
// succeeds — that obstruction is self-clearing and does NOT reproduce the
// defect. A non-empty directory refuses both operations, which is exactly the
// "occupied and locked" state the defect is about: unlink EPERM, all three
// renames EPERM, nothing moves, the append proceeds anyway.
//
// THE ASSERTION IS NON-GROWTH, NOT "SMALL". A bound expressed as `active <=
// some generous number` passes for the wrong reason the moment the number is
// generous enough. The variable here is measured twice: batch 1 then batch 2 of
// the same size against the same obstruction, and the size after batch 2 must be
// IDENTICAL to the size after batch 1. Linear growth cannot satisfy that, and no
// choice of threshold can rescue it.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const nodeRequire = createRequire(import.meta.url);
const ts = nodeRequire(join(root, 'node_modules', 'typescript', 'lib', 'typescript.js'));

// Scratch lives OUTSIDE the repo, same convention and same override as
// tests/error-reporter-bounds.test.mjs.
const scratchBase = process.env.NV_TEST_SCRATCH || os.tmpdir();

/** error-reporter and its transitive main-process imports. */
const MODULES = ['redaction', 'report-sanitizer', 'reports-endpoint', 'error-reporter'];

/**
 * The cap is lowered to 64 KiB for the fixture. The production numbers are 5 MB
 * x 3 and are pinned by tests/error-reporter-bounds.test.mjs; pushing 20 MB
 * through the redactor to exercise the same branch would cost minutes for no
 * extra information, and the original author already hit a 300 s shell cap that
 * way. The PATH under test is identical.
 */
const TEST_CAP = 65_536;

/**
 * The most one bounded record can occupy: message and stack are capped at 4,000
 * units each plus a marker, source at 200, timestamp at 64, plus JSON overhead.
 * 16 KiB is comfortably above that and is used only as a sanity ceiling on the
 * ONE record the first-error rule deliberately lets through; the real assertion
 * is non-growth.
 */
const MAX_ONE_RECORD = 16 * 1024;

const scratchDirs = [];

/**
 * Transpile error-reporter and its imports into a throwaway directory, wire
 * `require("electron")` to a stub whose userData points inside it, lower the
 * rotation cap, and return the loaded module.
 *
 * Every rewrite is asserted to have APPLIED. A no-op patch would leave this file
 * measuring the unmodified module and passing for the wrong reason — the exact
 * failure mode that let a test in this repo measure the SUCCESS path of a write
 * for six review rounds.
 */
function harness({ failFirstNotice = false, hostileNotice = false } = {}) {
  fs.mkdirSync(scratchBase, { recursive: true });
  const dir = fs.mkdtempSync(join(scratchBase, 'nv-error-rotation-'));
  scratchDirs.push(dir);
  const outDir = join(dir, 'main');
  const userData = join(dir, 'userData');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });

  for (const name of MODULES) {
    const source = fs.readFileSync(join(root, 'src', 'main', `${name}.ts`), 'utf8');
    let js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;

    if (name === 'error-reporter') {
      let before = js;
      js = js.replace('require("electron")', 'require("./electron-stub")');
      assert.notEqual(js, before, 'electron stub rewrite did not apply');

      before = js;
      js = js.replace(/const MAX_LOG_SIZE = [^;]+;/, `const MAX_LOG_SIZE = ${TEST_CAP};`);
      assert.notEqual(js, before, 'cap-lowering patch did not apply: this file would measure nothing');

      if (failFirstNotice) {
        // Make the RECOVERY NOTICE's own append fail once, on demand, leaving
        // every other append healthy. The flag is read at call time so the test
        // controls exactly which write fails.
        before = js;
        js = js.replace(
          /fs\.appendFileSync\(file, JSON\.stringify\(notice\) \+ "\\n", "utf8"\);/,
          'if (globalThis.__nvFailNotice) { globalThis.__nvFailNotice = false; ' +
            'throw Object.assign(new Error("EPERM: injected notice failure"), { code: "EPERM" }); } ' +
            'fs.appendFileSync(file, JSON.stringify(notice) + "\\n", "utf8");'
        );
        assert.notEqual(js, before, 'notice-failure patch did not apply: this file would measure nothing');
      }

      if (hostileNotice) {
        // Simulate the PLAUSIBLE NEAR-FUTURE EDIT: someone names the log path in
        // the recovery message (the obvious next request from an operator) and
        // adds a field. Neither is caller data today, which is the whole point:
        // the record must be sanitized because the CONTENT of this message is not
        // an invariant, and a path carries the local account name.
        // ANCHORED ON CODE-ONLY TEXT, and that is a correction made after this very
        // test passed for the wrong reason. The anchor was `[log-suppressed: `,
        // whose FIRST occurrence in the transpiled output is inside the doc comment
        // above suppressionNotice (transpileModule keeps comments), so the payload
        // was injected into a COMMENT, the `notEqual` guard below was satisfied by
        // the comment changing, and the two leak assertions then passed vacuously —
        // they would have stayed green with the bypass fully restored. `${suppressedCount}`
        // appears only in the executable template.
        before = js;
        js = js.replace(
          '`[log-suppressed: ${suppressedCount}',
          '`C:\\\\Users\\\\victim\\\\AppData\\\\errors.log nvapi-DEADBEEFCAFE0123456789 [log-suppressed: ${suppressedCount}'
        );
        assert.notEqual(js, before, 'hostile-message patch did not apply');
        // Belt and braces: the payload must be in CODE, not merely somewhere in the
        // file. Without this, a future anchor drift repeats the vacuous pass above.
        assert.ok(
          /message:\s*`C:\\\\Users\\\\victim/.test(js),
          'hostile payload did not land in the message expression: this test would measure nothing'
        );
        before = js;
        js = js.replace('source: "error-reporter"', 'source: "error-reporter", forgedExtra: "must-be-dropped"');
        assert.notEqual(js, before, 'hostile-field patch did not apply');
      }
    }
    fs.writeFileSync(join(outDir, `${name}.js`), js, 'utf8');
  }

  fs.writeFileSync(
    join(outDir, 'electron-stub.js'),
    `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' } };\n`,
    'utf8'
  );

  const load = createRequire(join(outDir, 'anchor.js'));
  const logsDir = join(userData, 'logs');
  return {
    reporter: load('./error-reporter.js'),
    logsDir,
    logFile: join(logsDir, 'errors.log'),
    rotatedPath: (index) => join(logsDir, `errors.${index}.log`)
  };
}

/**
 * Occupy all three generation names with non-empty DIRECTORIES, so both the
 * unlink of the oldest and every rename in the shift fail with EPERM.
 * Returns a function that clears the obstruction.
 */
function obstructRotation({ logsDir, rotatedPath }) {
  fs.mkdirSync(logsDir, { recursive: true });
  const occupied = [];
  for (let i = 1; i <= 3; i += 1) {
    const target = rotatedPath(i);
    // A generation name may already hold a real FILE from an earlier successful
    // rotation; mkdirSync would throw EEXIST on it.
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(join(target, 'held-open.bin'), 'x', 'utf8');
    occupied.push(target);
  }
  // Prove the obstruction is real rather than assumed: the module's own two
  // filesystem operations must both be refused.
  const probe = join(logsDir, 'probe.tmp');
  fs.writeFileSync(probe, 'p', 'utf8');
  assert.throws(() => fs.unlinkSync(rotatedPath(3)), /EPERM|EISDIR|EACCES|ENOTEMPTY/, 'the oldest generation is not actually locked');
  assert.throws(() => fs.renameSync(probe, rotatedPath(1)), /EPERM|EISDIR|EACCES|ENOTEMPTY/, 'generation 1 is not actually locked');
  fs.unlinkSync(probe);

  return () => {
    for (const target of occupied) fs.rmSync(target, { recursive: true, force: true });
  };
}

/**
 * Put the active log JUST OVER the cap deterministically, so a storm that starts
 * afterwards starts in the over-cap state.
 *
 * WRITTEN DIRECTLY rather than by calling logError in a loop, for correctness
 * before cost. Filling via logError ROTATES on the way up (that path is
 * unobstructed), so the active log lands at an arbitrary size BELOW the cap and
 * the "first of the storm" would not be the first entry to meet the obstruction
 * at all — the assertions below would then be measuring an ordinary append.
 * Writing the fixture makes the starting state exact.
 */
function seedOverCap({ reporter, logFile }) {
  // Through the module's own path, so the logs directory exists.
  reporter.logError({ type: 'gateway', message: 'seed', source: 'measurement' });
  const line = `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'gateway',
    message: 'seed-filler',
    stack: 'z'.repeat(2_000),
    source: 'measurement'
  })}\n`;
  fs.writeFileSync(logFile, line.repeat(Math.ceil((TEST_CAP + 1_024) / line.length)), 'utf8');
  const size = fs.statSync(logFile).size;
  assert.ok(size > TEST_CAP, `seed must exceed the cap, got ${size} B`);
  return size;
}

const entries = (file) =>
  fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));

const storm = (reporter, count, tag) => {
  let completed = 0;
  for (let i = 0; i < count; i += 1) {
    reporter.logError({ type: 'gateway', message: `${tag} ${i}`, stack: 'x'.repeat(2_000), source: 'measurement' });
    completed += 1;
  }
  return completed;
};

test('OBSTRUCTED ROTATION: the active log stays bounded and STOPS growing', () => {
  const h = harness();
  const clear = obstructRotation(h);

  const batch = 900;
  const completedA = storm(h.reporter, batch, 'batch-a');
  const afterA = fs.statSync(h.logFile).size;
  const completedB = storm(h.reporter, batch, 'batch-b');
  const afterB = fs.statSync(h.logFile).size;

  console.log(
    `OBSTRUCTED measured: cap=${TEST_CAP} B, after ${batch} appends=${afterA} B ` +
    `(${(afterA / TEST_CAP).toFixed(2)}x cap), after ${batch * 2}=${afterB} B ` +
    `(${(afterB / TEST_CAP).toFixed(2)}x cap), growth across the second batch=${afterB - afterA} B`
  );

  // No rotation happened, so nothing may have appeared under a generation name.
  for (let i = 1; i <= 3; i += 1) {
    assert.ok(fs.statSync(h.rotatedPath(i)).isDirectory(), `generation ${i} should still be the obstruction`);
  }

  // Nothing threw: the storm ran to completion.
  assert.equal(completedA, batch);
  assert.equal(completedB, batch);

  // THE BOUND. One record is allowed past the cap on purpose (the first error of
  // a storm is the diagnostic one and is never dropped); nothing beyond that.
  assert.ok(
    afterA <= TEST_CAP + MAX_ONE_RECORD,
    `active log reached ${afterA} B against a ${TEST_CAP} B cap (${(afterA / TEST_CAP).toFixed(2)}x)`
  );
  // THE REAL PROPERTY, immune to the choice of threshold above: a second
  // identical batch against the same obstruction adds NOTHING.
  assert.equal(
    afterB,
    afterA,
    `the active log grew ${afterB - afterA} B across the second batch, so it is not bounded, only slower`
  );

  clear();
});

test('OBSTRUCTED ROTATION: the FIRST error of a storm is never dropped', () => {
  const h = harness();

  // The storm must BEGIN over cap, so the entry below is genuinely the first to
  // meet the obstruction rather than an ordinary append that happens to be first.
  seedOverCap(h);
  const clear = obstructRotation(h);

  h.reporter.logError({ type: 'gateway', message: 'FIRST-OF-STORM', stack: 'x'.repeat(2_000), source: 'measurement' });
  storm(h.reporter, 200, 'follow-up');

  const stored = entries(h.logFile);
  const first = stored.filter((entry) => entry.message === 'FIRST-OF-STORM');
  const followUps = stored.filter((entry) => String(entry.message).startsWith('follow-up'));

  console.log(
    `FIRST-OF-STORM measured: kept ${first.length} first-of-storm record(s), ` +
    `${followUps.length} of 200 follow-ups written, active=${fs.statSync(h.logFile).size} B`
  );

  assert.equal(first.length, 1, 'the first error of a storm must be written, it is the diagnostic one');
  assert.equal(followUps.length, 0, 'follow-ups must be suppressed, not written');

  clear();
});

test('OBSTRUCTED ROTATION: recovery emits ONE record naming the loss, then resumes', () => {
  const h = harness();
  // Over cap BEFORE the obstruction, so every one of the `attempts` below is
  // suppressed and the recovery count is an exact, predictable number rather
  // than "however many happened to land before the cap was crossed".
  seedOverCap(h);
  const clear = obstructRotation(h);

  const suppressedTag = 'SUPPRESSED-BODY-MUST-NOT-BE-RETAINED';
  h.reporter.logError({ type: 'gateway', message: 'storm-opener', stack: 'x'.repeat(2_000), source: 'measurement' });
  const attempts = 300;
  for (let i = 0; i < attempts; i += 1) {
    h.reporter.logError({ type: 'gateway', message: `${suppressedTag} ${i}`, stack: 'x'.repeat(2_000), source: 'measurement' });
  }

  // The obstruction clears on its own — an antivirus scan finishes, an editor is
  // closed. No restart.
  clear();
  h.reporter.logError({ type: 'gateway', message: 'after-recovery', stack: 'x'.repeat(2_000), source: 'measurement' });

  const stored = entries(h.logFile);
  const recovery = stored.filter((entry) => /log-suppressed/.test(String(entry.message)));

  console.log(
    `RECOVERY measured: ${attempts} suppressed, recovery records=${recovery.length}, ` +
    `message=${JSON.stringify(recovery[0]?.message ?? null)}`
  );

  assert.equal(recovery.length, 1, 'recovery must emit exactly ONE record, not one per suppressed entry');
  assert.ok(
    recovery[0].message.includes(String(attempts)),
    `the recovery record must name how many entries were suppressed: ${recovery[0].message}`
  );
  // The PERIOD, so the loss is placed in time rather than merely counted.
  const stamps = recovery[0].message.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) || [];
  assert.equal(stamps.length, 2, `the recovery record must name the period it covers: ${recovery[0].message}`);

  // BOUNDED STATE, measured on the observable: if the suppressed ENTRIES had been
  // accumulated in memory to be flushed later, their content would be here.
  const rawLog = fs.readFileSync(h.logFile, 'utf8');
  assert.ok(
    !rawLog.includes(suppressedTag),
    'suppressed entry CONTENT was retained and written out; only a counter and timestamps may be kept'
  );

  // Rotation resumed, and so did appending.
  assert.ok(stored.some((entry) => entry.message === 'after-recovery'), 'appends must resume after recovery');
  assert.ok(fs.existsSync(h.rotatedPath(1)) && fs.statSync(h.rotatedPath(1)).isFile(), 'rotation must have produced a real generation 1');
  assert.ok(fs.statSync(h.logFile).size <= TEST_CAP + MAX_ONE_RECORD, 'the active log must be back under its cap');
});

test('OBSTRUCTED ROTATION: suppression never throws, and readErrors still works', () => {
  const h = harness();
  const clear = obstructRotation(h);

  let thrown = 0;
  const attempts = 500;
  for (let i = 0; i < attempts; i += 1) {
    try {
      h.reporter.logError({ type: 'gateway', message: `noThrow ${i}`, stack: 'x'.repeat(2_000), source: 'measurement' });
    } catch {
      thrown += 1;
    }
  }
  // The read path must not be collateral damage of the suppression state.
  const count = h.reporter.getErrorCount();
  console.log(`NON-THROWING measured: ${attempts - thrown}/${attempts} appends returned normally, getErrorCount()=${count}`);

  assert.equal(thrown, 0, 'logError must never throw, obstructed or not');
  assert.ok(count > 0, 'the entries already on disk must still be readable while suppression is active');

  clear();
});

test('MARKER FORGERY: a forged truncation marker is distinguishable by ARITHMETIC', () => {
  // A caller-supplied field can END in text shaped exactly like this module's
  // truncation marker, and it is stored verbatim on a field that was never cut.
  // Nothing parses the marker, so this is presentation-level only, and a new
  // `truncated` field cannot be added: sanitizeReportEntry keeps a fail-closed
  // allow-list of five fields (report-sanitizer.ts:29) and would DROP it.
  //
  // It does not need a mechanism, because a forgery CANNOT satisfy the size
  // relation a genuine marker satisfies by construction. boundField() returns
  // the value untouched when it fits, and appends the marker only after cutting
  // to exactly `cap` units — so a genuine marker always sits at the END of a
  // value whose length is exactly `cap + markerLength(field, named, cap)`.
  // A forger has only two options and both fail that check:
  //   * stay within the cap -> stored length <= cap, strictly less than
  //     cap + markerLength, so the relation cannot hold;
  //   * exceed the cap -> the value is cut at `cap` and their trailing marker is
  //     discarded with everything else past the cut, then the genuine marker is
  //     appended.
  // This test pins that reasoning so it cannot rot into a comment that used to
  // be true.
  const h = harness();
  const CAP = 4_000;
  const markerLength = (field, units, cap) => `[truncated: ${field} was ${units} units, cap ${cap}]`.length;

  // 1. A short field carrying a forged marker: stored verbatim, fails the relation.
  const forged = `boom at handler${'.'.repeat(100)}[truncated: stack was 999999 units, cap 4000]`;
  h.reporter.logError({ type: 'renderer', message: 'forgery probe', stack: forged, source: 'measurement' });
  const forgedStored = entries(h.logFile).pop().stack;

  // 2. A genuinely truncated field, for the same relation to be checked against.
  h.reporter.logError({ type: 'renderer', message: 'genuine probe', stack: 'y'.repeat(100_000), source: 'measurement' });
  const genuineStored = entries(h.logFile).pop().stack;

  const relationHolds = (stored, field) => {
    const match = /\[truncated: (\w+) was (\d+) units, cap (\d+)\]$/.exec(stored);
    if (!match || match[1] !== field) return false;
    return stored.length === Number(match[3]) + markerLength(field, Number(match[2]), Number(match[3]));
  };

  console.log(
    `FORGERY measured: forged stored ${forgedStored.length} units, relation holds=${relationHolds(forgedStored, 'stack')}; ` +
    `genuine stored ${genuineStored.length} units, relation holds=${relationHolds(genuineStored, 'stack')}`
  );

  assert.ok(/truncated/.test(forgedStored), 'the forged text is stored verbatim, which is the finding being pinned');
  assert.ok(forgedStored.length <= CAP, 'the forged field was not truncated, so it must fit the cap');
  assert.equal(relationHolds(forgedStored, 'stack'), false, 'a forged marker must NOT satisfy the size relation');
  assert.equal(relationHolds(genuineStored, 'stack'), true, 'a genuine marker MUST satisfy the size relation');
});

// ---------------------------------------------------------------------------
// HARDENING, added by an independent 1:1 review of 457d77a. Each test below
// corresponds to a measured way the ORIGINAL six tests stayed green while a
// property the commit message claims was absent or wrong.
// ---------------------------------------------------------------------------

test('HARDENING: the recovery notice is SANITIZED and BOUNDED like every other record', () => {
  // MEASURED GAP: suppressionNotice() bypassed sanitizeEntry and boundField,
  // justified as safe because no caller data reaches it. That is true of today's
  // code and is not an invariant of the record. Routing it through costs NOTHING
  // — sanitizeReportEntry left the real notice byte-identical, 179 units in and
  // 179 out, and at ~170 units against a 4,000 cap boundField returns it
  // untouched — so the bypass bought nothing while leaving the leak available.
  //
  // The patch below is the plausible near-future edit: name the log PATH in the
  // message, which is the obvious next thing an operator asks for. MEASURED with
  // the bypass in place, the record reached disk as
  // `C:\Users\victim\AppData\errors.log nvapi-DEADBEEFCAFE0123456789 [log-suppressed: ...]`
  // — local ACCOUNT NAME and an nvapi key stored verbatim — and an extra field on
  // the object was written out too. None of the six original tests inspects the
  // notice for either, so the bypass could be restored with the suite fully green.
  const h = harness({ hostileNotice: true });
  seedOverCap(h);
  const clear = obstructRotation(h);
  h.reporter.logError({ type: 'gateway', message: 'opener', stack: 'x'.repeat(2_000), source: 'measurement' });
  storm(h.reporter, 4, 'dropped');
  clear();
  h.reporter.logError({ type: 'gateway', message: 'after-recovery', stack: 'x'.repeat(2_000), source: 'measurement' });

  const notice = entries(h.logFile).find((entry) => /log-suppressed/.test(String(entry.message)));
  assert.ok(notice, 'the recovery notice must still be emitted');
  const raw = JSON.stringify(notice);

  console.log(`HARDENING notice: ${JSON.stringify(String(notice.message).slice(0, 96))}`);

  assert.ok(!raw.includes('victim'), `the local account name reached disk: ${raw}`);
  assert.ok(!raw.includes('nvapi-DEADBEEFCAFE0123456789'), `an nvapi key reached disk verbatim: ${raw}`);
  assert.ok(String(notice.message).includes('C:\\Users\\***'), 'the user path must be masked, proving maskUserPaths ran');
  assert.ok(String(notice.message).includes('[REDACTED]'), 'the key must be redacted, proving redact() ran');
  // The allow-list must apply to this record too, not only to caller entries.
  assert.ok(!('forgedExtra' in notice), 'a non-allow-listed field on the notice must be dropped');
  // Still the ONE record, still naming the count and the period.
  assert.equal(entries(h.logFile).filter((e) => /log-suppressed/.test(String(e.message))).length, 1);
  assert.ok(/log-suppressed: 4 entries/.test(String(notice.message)), `the count must survive sanitizing: ${notice.message}`);
  assert.ok(String(notice.message).length <= 4_000 + 64, 'the notice must be bounded like any other field');
});

test('HARDENING: a FAILED recovery-notice write does not lose the count', () => {
  // MEASURED DEFECT in 457d77a: the counters were reset BEFORE the notice append,
  // reasoning that a failed write must not leave them primed to emit twice. With
  // an EPERM injected on the notice append ONLY, 5 suppressed entries produced 0
  // recovery records, and three further fully healthy appends produced 0 as well.
  // The count was gone for good and the operator had no signal whatsoever that
  // anything had been dropped — the silent gap this commit exists to eliminate,
  // reintroduced by its own error path. The write that failed is exactly the write
  // to retry: nothing reached disk, so a later attempt is not a duplicate.
  const h = harness({ failFirstNotice: true });
  seedOverCap(h);
  const clear = obstructRotation(h);
  h.reporter.logError({ type: 'gateway', message: 'opener', stack: 'x'.repeat(2_000), source: 'measurement' });
  const dropped = 5;
  storm(h.reporter, dropped, 'dropped');
  clear();

  globalThis.__nvFailNotice = true;
  h.reporter.logError({ type: 'gateway', message: 'recovery-attempt-1', stack: 'x'.repeat(2_000), source: 'measurement' });
  const afterFailure = entries(h.logFile).filter((entry) => /log-suppressed/.test(String(entry.message))).length;

  // Everything healthy from here on.
  h.reporter.logError({ type: 'gateway', message: 'recovery-attempt-2', stack: 'x'.repeat(2_000), source: 'measurement' });
  const notices = entries(h.logFile).filter((entry) => /log-suppressed/.test(String(entry.message)));

  console.log(
    `NOTICE-RETRY measured: notices after the failed write=${afterFailure}, ` +
    `after one further healthy append=${notices.length}, message=${JSON.stringify(notices[0]?.message ?? null)}`
  );

  assert.equal(afterFailure, 0, 'the injected failure must actually have blocked the write');
  assert.equal(notices.length, 1, 'the count must be retried and reported exactly once, not lost and not doubled');
  assert.ok(
    notices[0].message.includes(String(dropped)),
    `the retried notice must still name all ${dropped} dropped entries: ${notices[0].message}`
  );
  // The entry that accompanied the failed notice must not have been lost with it.
  assert.ok(entries(h.logFile).some((e) => e.message === 'recovery-attempt-1'), 'the accompanying entry must still be written');

  // And once reported, it must NOT be reported again.
  h.reporter.logError({ type: 'gateway', message: 'third', stack: 'x'.repeat(2_000), source: 'measurement' });
  assert.equal(
    entries(h.logFile).filter((entry) => /log-suppressed/.test(String(entry.message))).length,
    1,
    'the notice must not be re-emitted once it has been written'
  );
  delete globalThis.__nvFailNotice;
});

test.after(() => {
  for (const dir of scratchDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
