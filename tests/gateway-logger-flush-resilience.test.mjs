import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const LOGGER_PATH = path.join(root, 'src', 'gateway', 'logger.mjs');
const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-logger-flush-${process.pid}-`)));
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

// ───────────────────────────────────────────────────────────────────────────
// DEFECT (FIX 1). src/gateway/logger.mjs:92 flushLogs() calls
// fs.appendFileSync with NO try/catch. The flush runs inside the 1s debounce
// timer callback (log() -> setTimeout(flushLogs, 1000)) and there is NO
// uncaughtException handler in the gateway child — so ANY write failure
// (path is a directory, ACL lock, EMFILE, ENOSPC) escapes as an uncaught
// exception and kills the gateway mid-service. The fixture makes the failure
// deterministic without touching permissions: the log PATH is an existing
// DIRECTORY, so the append fails with EISDIR/EPERM on every platform. The
// obstruction then clears (rmdirSync) on the SAME path — logger.mjs reads
// GATEWAY_LOG_PATH once at import, so this is also the only recovery shape
// production can take.
//
// REQUIRED BEHAVIOUR: flushLogs must not throw; each failing batch is DROPPED
// but COUNTED (O(1) state, never the content — same discipline as
// error-reporter's suppression ledger, src/main/error-reporter.ts:361-372);
// on the first flush after the target becomes writable again, exactly ONE
// summary marker line (same `[log-suppressed: ...]` spirit) precedes the
// recovered batch; later healthy flushes emit no further summaries.
// ───────────────────────────────────────────────────────────────────────────
test('a failed log flush must not throw; after recovery exactly one suppression summary is emitted', async () => {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  const target = path.join(dir, 'gateway.jsonl');
  fs.mkdirSync(target); // the log target itself is a directory -> append fails

  const previous = process.env.GATEWAY_LOG_PATH;
  process.env.GATEWAY_LOG_PATH = target;
  const logger = await import(pathToFileURL(LOGGER_PATH).href);
  try {
    // Phase 1 — obstructed flushes. BEFORE the fix this THROWS (EISDIR/EPERM)
    // out of flushLogs and, in production, out of the debounce timer.
    logger.info('entry before the obstruction');
    assert.doesNotThrow(() => logger.flushLogs(),
      'flushLogs must survive a failing write (gateway child has no uncaughtException handler)');
    logger.info('entry in a second blocked batch');
    assert.doesNotThrow(() => logger.flushLogs(), 'a second consecutive failure must be equally survivable');

    assert.equal(fs.statSync(target).isDirectory(), true,
      'no flush has ever succeeded: the target is still the obstructing directory');

    // Phase 2 — the obstruction clears: same path becomes a writable file.
    fs.rmdirSync(target);
    logger.info('entry after recovery');
    logger.flushLogs();

    const lines = fs.readFileSync(target, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line));
    const notices = lines.filter((entry) => String(entry.message ?? '').includes('[log-suppressed:'));

    assert.equal(notices.length, 1,
      `exactly ONE suppression summary after recovery, got ${notices.length}: ${JSON.stringify(notices)}`);
    assert.match(notices[0].message, /2 batches/, 'the summary must account for both failed batches');
    assert.match(notices[0].message, /2 entries/, 'the summary must account for both dropped entries');

    const recovered = lines.find((entry) => entry.message === 'entry after recovery');
    assert.ok(recovered, 'the first post-recovery entry must reach disk');
    assert.equal(lines.some((entry) => entry.message === 'entry before the obstruction'), false,
      'suppressed entries are dropped (counted, not queued) — same O(1) rule as error-reporter');

    // Phase 3 — "never suppress permanently" also means "never announce twice":
    // later healthy flushes must add NO further summaries.
    logger.info('another healthy entry');
    logger.flushLogs();
    const afterMore = fs.readFileSync(target, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(afterMore.filter((e) => String(e.message ?? '').includes('[log-suppressed:')).length, 1,
      'the summary is emitted once, not on every subsequent flush');
    assert.ok(afterMore.some((e) => e.message === 'another healthy entry'), 'healthy flushes keep working');
  } finally {
    logger.closeLogger(); // drop the debounce timer so no stray flush writes after the case
    if (previous === undefined) delete process.env.GATEWAY_LOG_PATH;
    else process.env.GATEWAY_LOG_PATH = previous;
  }
});
