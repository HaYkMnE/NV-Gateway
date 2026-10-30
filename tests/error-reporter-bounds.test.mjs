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
  // The stack is 8,000 units, TWICE the 4,000-unit per-field bound, so the record
  // size is NOT the same before and after the fix — corrected here after an
  // independent review measured both: 8,114 B/entry before (bounded only by
  // redaction's 16,384 slice) against 4,157 B/entry after. That does not weaken
  // this test, whose variable is whether anything reclaims the file, but the
  // earlier claim that the record size was unchanged was simply wrong.
  // Volume is chosen to clear 5 MB
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

// ---------------------------------------------------------------------------
// HARDENING, added by an independent 1:1 review of 3ee8b9b. Each test below
// corresponds to a measured way the ORIGINAL five tests stayed green while the
// property they claim to pin was gone. Every one of these was demonstrated
// failing against a deliberately weakened error-reporter.ts before being added.
// ---------------------------------------------------------------------------

/** The caps error-reporter declares. Pinned here so RAISING one fails the suite. */
const MAX_MESSAGE_UNITS = 4000;
const MAX_STACK_UNITS = 4000;
const MAX_SOURCE_UNITS = 200;
const MAX_TIMESTAMP_UNITS = 64;

/** Length of the in-value marker for a given field/size, so an exact size can be asserted. */
function markerLength(field, units, cap) {
  return `[truncated: ${field} was ${units} units, cap ${cap}]`.length;
}

test('HARDENING: the cap is pinned to its VALUE, not merely to "below the slice"', () => {
  // MEASURED EVASION: raising MAX_MESSAGE_UNITS/MAX_STACK_UNITS from 4,000 to
  // 12,000 kept all four original D2 assertions green — 12,048 units is still
  // not 16,384, still below it, still carries a marker, still names 100000. So
  // the suite pinned "the slice is not what binds" but placed NO ceiling of its
  // own: the cap could be tripled, or raised to 16,383, and nothing failed.
  // The stored size is asserted EXACTLY, so any change to the cap must be a
  // deliberate change to this number too.
  const { reporter, logFile } = harness();
  const original = 100_000;
  reporter.logError({ type: 'renderer', message: 'a'.repeat(original), stack: 'b'.repeat(original), source: 'measurement' });
  const stored = lastEntry(logFile);

  assert.equal(
    stored.message.length,
    MAX_MESSAGE_UNITS + markerLength('message', original, MAX_MESSAGE_UNITS),
    `message stored ${stored.message.length} units; the cap is ${MAX_MESSAGE_UNITS} and must not drift`
  );
  assert.equal(
    stored.stack.length,
    MAX_STACK_UNITS + markerLength('stack', original, MAX_STACK_UNITS),
    `stack stored ${stored.stack.length} units; the cap is ${MAX_STACK_UNITS} and must not drift`
  );
  // The cap must also stay a SMALL FRACTION of the slice, so the two never
  // converge to the point where the slice could quietly become the real bound.
  assert.ok(MAX_MESSAGE_UNITS * 4 <= REDACTION_SLICE, 'the cap must stay well clear of the slice');
});

test('HARDENING: `source` and `timestamp` are bounded too, not just message/stack', () => {
  // MEASURED EVASION: deleting the boundField call for `source` stored 16,384
  // units (straight back onto redaction.ts's slice) and deleting the timestamp
  // clamp did the same — the original five tests never touch either field, so
  // both bounds could be removed with the suite fully green. `source` is
  // renderer-supplied free text, which is exactly why it was given a cap.
  const { reporter, logFile } = harness();
  reporter.logError({
    type: 'renderer',
    message: 'ok',
    source: 'z'.repeat(50_000),
    timestamp: '9'.repeat(40_000)
  });
  const stored = lastEntry(logFile);

  assert.equal(
    stored.source.length,
    MAX_SOURCE_UNITS + markerLength('source', 50_000, MAX_SOURCE_UNITS),
    `source stored ${stored.source.length} units against a ${MAX_SOURCE_UNITS} cap`
  );
  assert.ok(stored.source.length < REDACTION_SLICE, 'source must not fall back onto the slice');
  // No marker on the timestamp: withinRetention PARSES it, so it is clamped bare.
  assert.equal(stored.timestamp.length, MAX_TIMESTAMP_UNITS, 'timestamp must be clamped to its cap');
  assert.ok(!/truncated/.test(stored.timestamp), 'a marker inside the timestamp would make the entry unexpirable');
});

test('HARDENING: no truncation marker when nothing was truncated', () => {
  // MEASURED DEFECT in 3ee8b9b: the guard was `text.length <= max &&
  // originalUnits <= max`, so the marker was attached whenever the CALLER's
  // value was long — even when the stored value was not cut. A single 4,206-unit
  // runtime secret redacts to `[REDACTED]` (10 units) and was stored as
  // `[REDACTED][truncated: message was 4206 units, cap 4000]`: 55 units claiming
  // 4,196 units of loss that never occurred. A record that reports imaginary
  // data loss sends an operator hunting a truncation that is not there.
  const { reporter, logFile } = harness();
  const oneLongSecret = `nvapi-${'a'.repeat(4200)}`;
  reporter.logError({ type: 'renderer', message: oneLongSecret, source: 'measurement' });
  const stored = lastEntry(logFile);

  assert.ok(stored.message.length <= MAX_MESSAGE_UNITS, `stored ${stored.message.length} units`);
  assert.ok(stored.message.includes('[REDACTED]'), 'the secret must still be redacted');
  assert.ok(
    !/truncated/.test(stored.message),
    `nothing was cut, yet the record claims truncation: ${JSON.stringify(stored.message)}`
  );
});

test('HARDENING: the cut never manufactures a lone surrogate', () => {
  // MEASURED DEFECT in 3ee8b9b: a cut at an arbitrary UTF-16 index splits a
  // surrogate pair. `'a'.repeat(3999) + U+1F600` stored U+D83D at index 3,999
  // with no low surrogate after it — a half-character this module invented,
  // which was not in the input. feedback-service.ts:93 already solved the same
  // problem by substituting U+FFFD; this path now does the same.
  const { reporter, logFile } = harness();
  reporter.logError({
    type: 'renderer',
    message: `${'a'.repeat(MAX_MESSAGE_UNITS - 1)}\u{1F600}${'b'.repeat(50)}`,
    source: 'measurement'
  });
  const stored = lastEntry(logFile);

  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.ok(!LONE_SURROGATE.test(stored.message), 'the stored value contains a lone surrogate');
  assert.equal(
    stored.message.charCodeAt(MAX_MESSAGE_UNITS - 1),
    0xfffd,
    'the split pair must be replaced by U+FFFD, matching feedback-service.ts:93'
  );
  // The 1:1 substitution must not move the cap.
  assert.equal(stored.message.slice(0, MAX_MESSAGE_UNITS).length, MAX_MESSAGE_UNITS);
});

test('HARDENING: the 10-day retention reaches ROTATED generations, not the active log only', () => {
  // MEASURED DEFECT in 3ee8b9b: cleanupOldErrors() rewrote the active log only,
  // so once an entry rotated into errors.N.log the clock never reached it again.
  // With the cap lowered to 64 KiB to exercise the same path cheaply, 40 entries
  // stamped 400 days old were rotated out, cleanupOldErrors() reported 0
  // reclaimed, and all 40 were still on disk. That is strictly worse than before
  // the size cap existed, where the next init() reclaimed them — the change made
  // to BOUND the file silently defeated the retention the module documents.
  //
  // The generation is written DIRECTLY rather than by pushing 20 MB through the
  // redactor: the property under test is whether expiry reaches errors.N.log,
  // and a cheap fixture tests it exactly as well as an expensive one.
  const { reporter, logFile, rotatedPath } = harness();
  const ancient = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
  const fresh = new Date().toISOString();
  const line = (timestamp, message) => `${JSON.stringify({ timestamp, type: 'gateway', message, source: 'measurement' })}\n`;

  // Creates the logs directory through the module's own path.
  reporter.logError({ type: 'gateway', message: 'seed', source: 'measurement' });
  fs.writeFileSync(logFile, line(ancient, 'active-ancient') + line(fresh, 'active-fresh'), 'utf8');
  fs.writeFileSync(rotatedPath(1), line(ancient, 'gen1-a') + line(ancient, 'gen1-b') + line(fresh, 'gen1-fresh'), 'utf8');
  fs.writeFileSync(rotatedPath(2), line(ancient, 'gen2-a') + line(ancient, 'gen2-b'), 'utf8');

  const removed = reporter.cleanupOldErrors();
  assert.equal(removed, 5, `expected 1 active + 2 in gen1 + 2 in gen2 reclaimed, got ${removed}`);

  assert.equal(
    fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.trim()).length,
    1,
    'the active log must keep exactly the fresh entry'
  );
  const gen1 = fs.readFileSync(rotatedPath(1), 'utf8');
  assert.ok(!gen1.includes('gen1-a') && !gen1.includes('gen1-b'), 'expired entries must be gone from generation 1');
  assert.ok(gen1.includes('gen1-fresh'), 'an in-retention entry in a generation must survive');
  // A generation left with nothing must not keep occupying a rotation slot.
  assert.ok(!fs.existsSync(rotatedPath(2)), 'a generation emptied by expiry must be removed');
});

test.after(() => {
  for (const dir of scratchDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
