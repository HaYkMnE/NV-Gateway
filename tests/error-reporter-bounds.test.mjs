// error-reporter.ts: the errors.log SIZE CAP, and independence from the
// truncating slice in redaction.ts.
//
// WHY THIS FILE TRANSPILES FROM SOURCE instead of importing `build/`. The
// neighbouring tests import `build/src/main/*.js`, but `prebuild` CLEANS
// `build/`, so a suite that races a build reads a directory that is being
// deleted underneath it. Everything here is transpiled out of `src/main/*.ts`
// into a fresh mkdtemp directory, which also makes the second measurement below
// possible at all: it needs TWO variants of redaction.js in the same run.
//
// D1 — UNBOUNDED errors.log WITHIN ONE SESSION.
// `appendEntry` appends with no size check, and `cleanupOldErrors()` is called
// from exactly ONE place: `init()`. So in a session that never restarts, nothing
// ever reclaims the file: the 10-day retention is evaluated only at startup and
// on read, never on write. `app-logger` and the gateway stdio both rotate at
// 5 MB x 3; this file did not.
//
// D2 — `logError` DEPENDED ON A SLICE IT DOES NOT OWN.
// `redaction.ts:83` ends in `.slice(0, 16_384)`. `logError` fed arbitrary text
// straight into it, so a 100,000-unit message was silently cut to exactly 16,384
// units with nothing recording that anything was lost. The bound was a side
// effect of a REDACTION module with no stake in log-record size — raise or remove
// that slice and the field is unbounded again, silently.
//
// The D2 assertions are BEHAVIOURAL, not textual: the harness builds a second
// redaction.js with the slice REMOVED and asserts the stored size is unchanged.
// A textual guard ("error-reporter must contain a bound") passes while the code
// still depends on the slice; this one fails unless the dependency is really
// gone. The patch is asserted to have applied, because a rewrite that silently
// no-ops would make this test measure nothing at all.
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

// Scratch lives OUTSIDE the repo: the transpiled modules and the multi-megabyte
// logs written below are throwaway, and nothing temporary belongs in a tracked
// tree. Overridable so a sandboxed run can pin it somewhere specific; defaults
// to the OS temp dir so the suite stays portable.
const scratchBase = process.env.NV_TEST_SCRATCH || os.tmpdir();

/** error-reporter and its transitive main-process imports. */
const MODULES = ['redaction', 'report-sanitizer', 'reports-endpoint', 'error-reporter'];

/** The convention error-reporter must match: app-logger.ts:5-6. */
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_ROTATED_FILES = 3;

/** The slice error-reporter must NOT depend on: redaction.ts:83. */
const REDACTION_SLICE = 16_384;

const scratchDirs = [];

/**
 * Transpile error-reporter and its imports into a throwaway directory, wire
 * `require("electron")` to a stub whose userData points inside it, and return
 * the loaded module.
 *
 * @param liftSlice Remove `.slice(0, 16384)` from redaction.js, simulating a
 *   future change to a module error-reporter does not own.
 */
function harness({ liftSlice = false } = {}) {
  fs.mkdirSync(scratchBase, { recursive: true });
  const dir = fs.mkdtempSync(join(scratchBase, 'nv-error-reporter-'));
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

    if (name === 'redaction' && liftSlice) {
      const before = js;
      // Both spellings: TypeScript may carry the `16_384` numeric separator
      // through to the emitted JS depending on target.
      js = js.replace(/\.slice\(0,\s*16_?384\)/, '');
      // A no-op patch would leave this test measuring the ORIGINAL module and
      // passing for the wrong reason. That exact failure mode (a test that
      // silently exercised the path it was meant to break) is why this asserts.
      assert.notEqual(js, before, 'slice-lift patch did not apply: the D2 measurement would be meaningless');
    }
    if (name === 'error-reporter') {
      const before = js;
      js = js.replace('require("electron")', 'require("./electron-stub")');
      assert.notEqual(js, before, 'electron stub rewrite did not apply');
    }
    fs.writeFileSync(join(outDir, `${name}.js`), js, 'utf8');
  }

  fs.writeFileSync(
    join(outDir, 'electron-stub.js'),
    `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' } };\n`,
    'utf8'
  );

  const load = createRequire(join(outDir, 'anchor.js'));
  return {
    reporter: load('./error-reporter.js'),
    logFile: join(userData, 'logs', 'errors.log'),
    rotatedPath: (index) => join(userData, 'logs', `errors.${index}.log`)
  };
}

/** Last JSONL record in the active log. */
function lastEntry(logFile) {
  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter((line) => line.trim());
  return JSON.parse(lines[lines.length - 1]);
}

test('D1: errors.log is size-capped like app-logger, not retention-only', () => {
  const { reporter, logFile, rotatedPath } = harness();

  // NO init() ON PURPOSE. init() is the only caller of cleanupOldErrors(), so
  // this is the long session the defect is about: the process started once,
  // days ago, and has been logging ever since.
  // A realistic runaway: one fault repeating in a session that never restarts.
  // The stack is sized AT the per-field bound rather than far above it, so the
  // record size is the same before and after the fix and the only variable under
  // test is whether anything reclaims the file. Volume is chosen to clear 5 MB
  // several times over, so rotation is genuinely exercised rather than merely
  // never reached; keeping each record small keeps the redaction cost linear and
  // the run inside a sane wall-clock.
  const stack = 'x'.repeat(8_000);
  const started = Date.now();
  const events = 1400;
  for (let i = 0; i < events; i += 1) {
    reporter.logError({ type: 'gateway', message: `event ${i}`, stack, source: 'measurement' });
  }
  const elapsedMs = Date.now() - started;

  const active = fs.statSync(logFile).size;
  const rotated = [];
  for (let i = 1; i <= MAX_ROTATED_FILES + 1; i += 1) {
    if (fs.existsSync(rotatedPath(i))) rotated.push(fs.statSync(rotatedPath(i)).size);
  }
  const total = active + rotated.reduce((sum, size) => sum + size, 0);
  const perEvent = Math.round(total / events);

  console.log(
    `D1 measured: ${events} events in ${elapsedMs}ms -> ${perEvent} B/event, ` +
    `active=${active} B, rotated=[${rotated.join(', ')}], total=${total} B, ` +
    `projected/hour at this rate=${Math.round((total / Math.max(elapsedMs, 1)) * 3_600_000 / 1_048_576)} MiB`
  );

  // The cap, and the ceiling it implies. Without rotation `active` is the whole
  // total and grows with `events` without limit.
  assert.ok(active <= MAX_FILE_SIZE, `active log ${active} B exceeds the ${MAX_FILE_SIZE} B cap`);
  assert.ok(rotated.length >= 1, 'no rotated log was produced, so nothing bounds the file');
  assert.ok(rotated.length <= MAX_ROTATED_FILES, `kept ${rotated.length} rotations, cap is ${MAX_ROTATED_FILES}`);
  assert.ok(
    total <= MAX_FILE_SIZE * (MAX_ROTATED_FILES + 1),
    `total on disk ${total} B exceeds the ${MAX_FILE_SIZE * (MAX_ROTATED_FILES + 1)} B ceiling`
  );
});

test('D1: the 10-day retention still drops expired entries', () => {
  const { reporter, logFile } = harness();
  const expired = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000).toISOString();

  reporter.logError({ type: 'gateway', message: 'expired', timestamp: expired, source: 'measurement' });
  reporter.logError({ type: 'gateway', message: 'fresh', source: 'measurement' });

  assert.equal(reporter.getErrorCount(), 1, 'an expired entry must not be counted');
  assert.equal(reporter.cleanupOldErrors(), 1, 'cleanupOldErrors must reclaim exactly the expired entry');

  const remaining = fs.readFileSync(logFile, 'utf8').split('\n').filter((line) => line.trim());
  assert.equal(remaining.length, 1);
  assert.equal(JSON.parse(remaining[0]).message, 'fresh');
});

test('D2: a 100,000-unit message is bounded VISIBLY, not silently sliced', () => {
  const { reporter, logFile } = harness();

  reporter.logError({ type: 'renderer', message: 'a'.repeat(100_000), source: 'measurement' });
  const stored = lastEntry(logFile);

  console.log(`D2 measured: 100000-unit message stored as ${stored.message.length} units`);

  // The defect: exactly the slice bound, with nothing saying data was lost.
  assert.notEqual(
    stored.message.length,
    REDACTION_SLICE,
    'stored length equals redaction.ts\u2019s slice bound, so the slice is still what bounds this field'
  );
  assert.ok(stored.message.length < REDACTION_SLICE, 'the caller\u2019s bound must bind BEFORE the slice');
  // Visible: the record itself states what was dropped and how big it was.
  assert.match(stored.message, /truncated/i, 'truncation must be recorded in the entry, not silent');
  assert.ok(stored.message.includes('100000'), 'the original size must be named in the record');
});

test('D2: the bound holds when redaction.ts\u2019s slice is REMOVED', () => {
  const bounded = harness();
  const lifted = harness({ liftSlice: true });

  const message = 'a'.repeat(100_000);
  const stack = 'b'.repeat(100_000);
  bounded.reporter.logError({ type: 'renderer', message, stack, source: 'measurement' });
  lifted.reporter.logError({ type: 'renderer', message, stack, source: 'measurement' });

  const withSlice = lastEntry(bounded.logFile);
  const withoutSlice = lastEntry(lifted.logFile);

  console.log(
    `D2 slice-lifted: message ${withSlice.message.length} -> ${withoutSlice.message.length} units, ` +
    `stack ${withSlice.stack.length} -> ${withoutSlice.stack.length} units`
  );

  // THE independence property. If logError still leaned on the slice, removing
  // it would let these fields grow to 100,000.
  assert.equal(withoutSlice.message.length, withSlice.message.length, 'message size changed when the slice was removed');
  assert.equal(withoutSlice.stack.length, withSlice.stack.length, 'stack size changed when the slice was removed');
  assert.ok(withoutSlice.message.length < REDACTION_SLICE);
  assert.ok(withoutSlice.stack.length < REDACTION_SLICE);
});

test('D2: redaction cannot expand a bounded field back onto the slice', () => {
  const { reporter, logFile } = harness();

  // Redaction can GROW a string: `nvapi-a` (7 units) becomes `[REDACTED]` (10).
  // The bound is applied before redaction, so the expanded result must still sit
  // clear of the slice, or the dependency returns through the back door.
  reporter.logError({ type: 'renderer', message: 'nvapi-a '.repeat(20_000), stack: 'nvapi-a '.repeat(20_000), source: 'measurement' });
  const stored = lastEntry(logFile);

  console.log(`D2 expansion: message ${stored.message.length} units, stack ${stored.stack.length} units after redaction`);

  assert.ok(stored.message.length < REDACTION_SLICE, `redacted message reached ${stored.message.length} units`);
  assert.ok(stored.stack.length < REDACTION_SLICE, `redacted stack reached ${stored.stack.length} units`);
  assert.ok(stored.message.includes('[REDACTED]'), 'redaction must still run on the bounded value');
});

test.after(() => {
  for (const dir of scratchDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
