import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const root = path.resolve(import.meta.dirname, '..');
const workflowPath = path.join(root, '.github', 'workflows', 'autonomous-analysis.yml');
const workflowText = fs.readFileSync(workflowPath, 'utf8');
const workflow = yaml.load(workflowText);
const statePath = path.join(root, '.jules', 'state', 'quota-state.json');
const workflowsDirectory = path.join(root, '.github', 'workflows');
const autonomousWorkflowFiles = [
  'autonomous-analysis.yml',
  'autonomous-change.yml',
  'autonomous-developer.yml',
  'autonomous-merge.yml',
  'autonomous-quota-reset.yml'
];

function loadAutonomousWorkflowDocuments(directoryEntries = fs.readdirSync(workflowsDirectory)) {
  const discovered = directoryEntries
    .filter((file) => /^autonomous-.*\.ya?ml$/i.test(file))
    .sort();
  assert.deepEqual(discovered, autonomousWorkflowFiles,
    'the autonomous workflow contract must load the complete expected file set');
  return new Map(autonomousWorkflowFiles.map((file) => [
    file,
    yaml.load(fs.readFileSync(path.join(workflowsDirectory, file), 'utf8'))
  ]));
}

function stripBalancedOuterParentheses(value) {
  let expression = value.trim();
  while (expression.startsWith('(')) {
    let depth = 0;
    let quote = null;
    let closesAt = -1;
    for (let index = 0; index < expression.length; index += 1) {
      const character = expression[index];
      if (quote) {
        if (character === quote) {
          if (quote === "'" && expression[index + 1] === "'") index += 1;
          else if (expression[index - 1] !== '\\') quote = null;
        }
        continue;
      }
      if (character === "'" || character === '"') quote = character;
      else if (character === '(') depth += 1;
      else if (character === ')') {
        depth -= 1;
        if (depth === 0) {
          closesAt = index;
          break;
        }
        if (depth < 0) return null;
      }
    }
    if (quote || closesAt < 0) return null;
    if (closesAt !== expression.length - 1) break;
    expression = expression.slice(1, -1).trim();
  }
  return expression;
}

function topLevelConjuncts(value) {
  const conjuncts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) {
        if (quote === "'" && value[index + 1] === "'") index += 1;
        else if (value[index - 1] !== '\\') quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth < 0) return null;
    } else if (depth === 0 && value.startsWith('&&', index)) {
      if (value[index - 1] === '&' || value[index + 2] === '&') return null;
      conjuncts.push(value.slice(start, index).trim());
      start = index + 2;
      index += 1;
    } else if (depth === 0 && (value.startsWith('||', index) || character === '?')) {
      return null;
    } else if (depth === 0 && character === '!' && value[index + 1] !== '=') {
      return null;
    }
  }
  if (quote || depth !== 0) return null;
  conjuncts.push(value.slice(start).trim());
  // Conservative GitHub-condition recognizer: top-level && peers must start
  // with an operand, not an operator fragment; nested/quoted syntax stays opaque.
  return conjuncts.every((conjunct) => {
    if (!conjunct) return false;
    const normalized = stripBalancedOuterParentheses(conjunct);
    return normalized !== null && /^(?:[A-Za-z_][A-Za-z0-9_]*|\d|['"])/.test(normalized);
  }) ? conjuncts : null;
}

function expressionRequiresAutonomousGate(value) {
  const envelope = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(value);
  const expression = stripBalancedOuterParentheses(envelope ? envelope[1] : value);
  if (!expression) return false;
  const conjuncts = topLevelConjuncts(expression);
  if (!conjuncts) return false;
  return conjuncts.some((conjunct) => {
    const normalized = stripBalancedOuterParentheses(conjunct);
    return normalized !== null
      && /^vars\s*\.\s*AUTONOMOUS_LOOP_ENABLED\s*==\s*(['"])true\1$/.test(normalized);
  });
}

function assertEveryAutonomousJobIsGated(documents) {
  assert.deepEqual([...documents.keys()], autonomousWorkflowFiles,
    'the autonomous workflow contract must inspect every expected file');
  let totalJobs = 0;
  for (const [file, document] of documents) {
    assert.ok(document && typeof document === 'object', `${file} must parse as a YAML mapping`);

    assert.ok(Object.hasOwn(document, 'on'), `${file} must define an own on trigger mapping`);
    const triggers = document.on;
    assert.ok(triggers && typeof triggers === 'object' && !Array.isArray(triggers),
      `${file} must define a nonempty on trigger mapping`);
    assert.ok(Object.keys(triggers).length > 0, `${file} must define at least one trigger`);

    const jobs = document.jobs;
    assert.ok(jobs && typeof jobs === 'object' && !Array.isArray(jobs),
      `${file} must define a jobs mapping`);
    const jobEntries = Object.entries(jobs);
    assert.ok(jobEntries.length > 0, `${file} must define at least one job`);
    totalJobs += jobEntries.length;

    for (const [jobName, job] of jobEntries) {
      assert.equal(typeof job?.if, 'string', `${file} job ${jobName} must define an if gate`);
      assert.ok(expressionRequiresAutonomousGate(job.if),
        `${file} job ${jobName} must require vars.AUTONOMOUS_LOOP_ENABLED == 'true'`);
    }
  }
  assert.ok(totalJobs > 0, 'the autonomous workflow contract must inspect at least one job');
}

function mutateWorkflowDocument(documents, file, mutate) {
  const document = structuredClone(documents.get(file));
  mutate(document);
  documents.set(file, document);
  return documents;
}

test('an OR branch cannot bypass the repository-variable gate', () => {
  const documents = mutateWorkflowDocument(
    loadAutonomousWorkflowDocuments(),
    'autonomous-change.yml',
    (document) => {
      document.jobs['build-and-test'].if = "${{ vars.AUTONOMOUS_LOOP_ENABLED == 'true' && false || true }}";
    }
  );

  assert.throws(
    () => assertEveryAutonomousJobIsGated(documents),
    /autonomous-change\.yml job build-and-test must require vars\.AUTONOMOUS_LOOP_ENABLED/
  );
});

test('a third ampersand cannot form a valid peer conjunct', () => {
  const documents = mutateWorkflowDocument(
    loadAutonomousWorkflowDocuments(),
    'autonomous-change.yml',
    (document) => {
      document.jobs['build-and-test'].if = "${{ vars.AUTONOMOUS_LOOP_ENABLED == 'true' &&& true }}";
    }
  );

  assert.throws(
    () => assertEveryAutonomousJobIsGated(documents),
    /autonomous-change\.yml job build-and-test must require vars\.AUTONOMOUS_LOOP_ENABLED/
  );
});

test('an equals sign cannot begin a peer conjunct', () => {
  const documents = mutateWorkflowDocument(
    loadAutonomousWorkflowDocuments(),
    'autonomous-change.yml',
    (document) => {
      document.jobs['build-and-test'].if = "${{ vars.AUTONOMOUS_LOOP_ENABLED == 'true' && = true }}";
    }
  );

  assert.throws(
    () => assertEveryAutonomousJobIsGated(documents),
    /autonomous-change\.yml job build-and-test must require vars\.AUTONOMOUS_LOOP_ENABLED/
  );
});

test('a parenthesized repository-variable gate remains a required conjunct', () => {
  const documents = mutateWorkflowDocument(
    loadAutonomousWorkflowDocuments(),
    'autonomous-change.yml',
    (document) => {
      document.jobs['build-and-test'].if = "${{ (vars.AUTONOMOUS_LOOP_ENABLED == 'true') && success() }}";
    }
  );

  assert.doesNotThrow(() => assertEveryAutonomousJobIsGated(documents));
});

test('quoted operator text remains opaque within a valid peer conjunct', () => {
  const documents = mutateWorkflowDocument(
    loadAutonomousWorkflowDocuments(),
    'autonomous-change.yml',
    (document) => {
      document.jobs['build-and-test'].if = "${{ vars.AUTONOMOUS_LOOP_ENABLED == 'true' && contains(github.event.issue.title, '&& || ? !') }}";
    }
  );

  assert.doesNotThrow(() => assertEveryAutonomousJobIsGated(documents));
});

test('an unrelated literal true key cannot substitute for the on trigger key', () => {
  const documents = mutateWorkflowDocument(
    loadAutonomousWorkflowDocuments(),
    'autonomous-change.yml',
    (document) => {
      document.true = document.on;
      delete document.on;
    }
  );

  assert.throws(
    () => assertEveryAutonomousJobIsGated(documents),
    /autonomous-change\.yml must define an own on trigger mapping/
  );
});

test('case-variant autonomous workflow filenames are discovered and rejected', () => {
  const directoryEntries = [
    ...fs.readdirSync(workflowsDirectory),
    'Autonomous-shadow.yml'
  ];

  assert.throws(
    () => loadAutonomousWorkflowDocuments(directoryEntries),
    /complete expected file set/
  );
});

test('regression proof: an autonomous job missing the repository-variable gate is rejected', () => {
  const documents = loadAutonomousWorkflowDocuments();
  const file = 'autonomous-change.yml';
  const document = structuredClone(documents.get(file));
  delete document.jobs['build-and-test'].if;
  documents.set(file, document);

  assert.throws(
    () => assertEveryAutonomousJobIsGated(documents),
    /autonomous-change\.yml job build-and-test must define an if gate/
  );
});

test('every job in every autonomous workflow requires the repository-variable gate', () => {
  assertEveryAutonomousJobIsGated(loadAutonomousWorkflowDocuments());
});

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

/**
 * Runs git and returns its exit status alongside stdout.
 *
 * `git check-ignore` exits 1 to mean "no match", which execFileSync turns into a
 * throw; a thrown spawn error would masquerade as a missing ignore rule. Reading
 * the status explicitly keeps a real "not ignored" result distinguishable from
 * git being unavailable.
 */
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) assert.fail(`git ${args.join(' ')} could not be run: ${result.error.message}`);
  return { status: result.status, stdout: (result.stdout ?? '').trim() };
}

test('quota-state.json is RUNTIME state and is not tracked in git', () => {
  // quota-state.json is a mutable per-run counter that a scheduled workflow
  // rewrites and commits back, so tracking it wrote runtime state into the
  // project's permanent history. It is a cache, not source: untracked and
  // ignored, exactly like keys.json and config.json above it in .gitignore.
  const tracked = git(['ls-files', '--', '.jules/state/quota-state.json']);
  assert.equal(tracked.status, 0, 'git ls-files must succeed');
  assert.equal(tracked.stdout, '',
    'quota-state.json must not be tracked: it is runtime state, not source');

  // check-ignore deliberately reports nothing for a TRACKED path, so this also
  // fails while the file is still in the index — the two assertions reinforce
  // each other rather than duplicating.
  const ignored = git(['check-ignore', '--', '.jules/state/quota-state.json']);
  assert.equal(ignored.status, 0,
    'quota-state.json must match an ignore rule so a local run cannot re-commit runtime state');
  assert.equal(ignored.stdout, '.jules/state/quota-state.json');
});

test('when a local quota-state.json exists it still holds the right TYPES', () => {
  // Absence is the correct state for a fresh clone, so absence is not a failure.
  // Whenever a local file DOES exist (a developer or workflow run produced one),
  // its types must still be right: exhausted_date strictly null or YYYY-MM-DD,
  // never the four-character string "null" that `jq --arg` would produce.
  if (!fs.existsSync(statePath)) return;
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
  assert.ok(Object.hasOwn(workflow, 'on'), 'the workflow must define its own on trigger key');
  const on = workflow.on;
  assert.ok(Object.hasOwn(on, 'workflow_dispatch'), 'workflow_dispatch must remain');
  assert.equal(on.schedule?.[0]?.cron, '0 */1 * * *', 'the cron schedule must remain unchanged');
});
