import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const root = path.resolve(import.meta.dirname, '..');
const workflowPath = path.join(root, '.github', 'workflows', 'autonomous-analysis.yml');
const workflowText = fs.readFileSync(workflowPath, 'utf8');
const workflow = yaml.load(workflowText);
const statePath = path.join(root, '.jules', 'state', 'quota-state.json');

/**
 * Every `run:` body in the workflow, with full-line shell comments removed.
 *
 * The comments have to go before any of this is inspected. A `run:` block is one
 * YAML scalar, so its `#` lines are part of the same string as the code, and the
 * block documents the very mistake being guarded against — matching the prose
 * would report a defect in an explanation of that defect. Only executable lines
 * can persist a wrong type, so only executable lines are examined.
 */
function runBodies() {
  return Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .map((step) => (typeof step.run === 'string' ? step.run : ''))
    .filter(Boolean)
    .map((body) => body
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n'));
}

// ───────────────────────────────────────────────────────────────────────────
// The persisted quota state must carry the right JSON TYPES.
//
// jq's --arg always produces a STRING:
//   "--arg name value:  This option passes a value to the jq program as a
//    predefined variable. [...] value is treated as a string"
//   -- https://jqlang.org/manual/  (Invoking jq)
//
// So `jq -n --arg d "null"` emits {"exhausted_date":"null"} — the four-character
// string, not JSON null. The sibling watchdog writes the correct shape with a
// literal in the filter (autonomous-quota-reset.yml:63):
//   jq -n '{exhausted_date: null, sessions_today: 0}'
// and the committed file currently holds a real null, so a "null" string would be
// a silent type change in a file that is committed back into git.
//
// It is latent rather than live only because this workflow is doubly disabled
// (disabled_manually, plus the vars.AUTONOMOUS_LOOP_ENABLED gate on line 15) and
// because the reader collapses both spellings via `.exhausted_date // "null"`.
// A type that is wrong-but-currently-tolerated is still wrong: any strict consumer,
// schema check, or `== null` test would disagree with the file on disk.
// ───────────────────────────────────────────────────────────────────────────

test('the persisted quota state never stores the STRING "null" for exhausted_date', () => {
  for (const body of runBodies()) {
    // A jq run that binds $d through --arg with the literal null spelling is the
    // defect: --arg cannot produce JSON null, only "null".
    assert.equal(/--arg\s+d\s+["']null["']/.test(body), false,
      'exhausted_date must not be written with `--arg d "null"` — --arg always yields the STRING "null"; use --argjson or a literal null in the jq filter');

    // Guard the general shape too, so the same mistake cannot reappear on another
    // variable name or with a different quoting style.
    assert.equal(/--arg\s+[A-Za-z_][A-Za-z0-9_]*\s+["']null["']/.test(body), false,
      'no jq --arg may be given the literal null spelling; --arg is always a string');
  }
});

test('every quota-state write emits a valid exhausted_date type', () => {
  // Only the WRITES are in scope, and they are identified by the jq object filter
  // `{exhausted_date: ...}` that constructs the file's contents.
  //
  // The reader is deliberately excluded. `jq -r '.exhausted_date // "null"'` maps a
  // JSON null to the string "null" ON PURPOSE, because shell has no null and the
  // value is about to be compared with `[ "$EXHAUSTED" != "null" ]`. That is the
  // correct shape for a shell variable and must not be "fixed"; matching it here
  // would flag working code.
  const writes = runBodies()
    .flatMap((body) => body.split('\n'))
    .filter((line) => /\{\s*exhausted_date/.test(line));
  assert.ok(writes.length > 0, 'the workflow must still persist quota state');

  for (const line of writes) {
    // Either the filter carries a bare `null` literal, or $d is bound from $TODAY.
    const literalNull = /exhausted_date:\s*null/.test(line);
    const boundToToday = /exhausted_date:\s*\$d/.test(line);
    assert.ok(literalNull || boundToToday,
      `exhausted_date must be a literal null or bound from $TODAY, got: ${line.trim()}`);

    // $d, where used, must never be bound from --arg with the null spelling. Proven
    // against the whole body rather than the single line, since the binding and the
    // filter sit on different physical lines of one continued command.
    if (boundToToday) {
      assert.equal(/--arg\s+d\s+["']null["']/.test(line), false,
        `a $d binding must come from $TODAY, not the literal null spelling: ${line.trim()}`);
    }
  }
});

test('the quota-state reader still tolerates both spellings', () => {
  // Defence in depth for the file already committed: whatever type is on disk, the
  // loader must not crash or silently carry yesterday's count into today. This is
  // why the bug was latent rather than live, and it must stay that way.
  assert.ok(/\.exhausted_date \/\/ "null"/.test(workflowText),
    'the reader must keep its null-tolerant default');
  assert.ok(/\.sessions_today \/\/ 0/.test(workflowText),
    'the session counter must keep its 0 default');
});

test('the committed quota-state.json holds a real null, not a string', () => {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(Object.hasOwn(state, 'exhausted_date'), 'quota-state.json must carry exhausted_date');
  // strictly null, or a date string — "null" is neither.
  if (state.exhausted_date !== null) {
    assert.match(state.exhausted_date, /^\d{4}-\d{2}-\d{2}$/,
      'exhausted_date must be JSON null or a YYYY-MM-DD string, never the string "null"');
  }
  assert.notEqual(state.exhausted_date, 'null',
    'exhausted_date must never be the four-character string "null"');
  assert.equal(typeof state.sessions_today, 'number',
    'sessions_today must stay a number');
});

test('the Jules automation stays unable to act on its own', () => {
  // This automation is intentionally and doubly disabled. These assertions exist so
  // a future edit cannot quietly re-arm a scheduled job that opens issues and
  // pushes commits, and cannot drop the fail-fast that stops it burning API quota
  // against an unconnected Jules source.
  const job = workflow.jobs?.analyze;
  assert.ok(job, 'the analyze job must still exist — nothing here is being deleted');
  assert.equal(job.if, "${{ vars.AUTONOMOUS_LOOP_ENABLED == 'true' }}",
    'the repository-variable gate must stay in place');

  assert.ok(workflowText.includes('JULES SETUP REQUIRED'),
    'the HTTP-404 fail-fast guard must stay');
  assert.ok(/if \[ "\$HTTP_CODE" = "404" \]/.test(workflowText),
    'the 404 fail-fast condition must stay');

  // Triggers must be unchanged: dispatch plus the hourly cron.
  const on = workflow.on ?? workflow.true;
  assert.ok(Object.hasOwn(on, 'workflow_dispatch'), 'workflow_dispatch must remain');
  assert.equal(on.schedule?.[0]?.cron, '0 */1 * * *', 'the cron schedule must remain unchanged');
});
