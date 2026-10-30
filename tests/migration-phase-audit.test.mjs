import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const sandboxRoot = os.tmpdir();
const temporaryDirectories = new Set();

test.after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(sandboxRoot, prefix));
  temporaryDirectories.add(directory);
  return directory;
}

function records(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function assertSafeRecords(actual, secret, rawMessage) {
  const allowedFields = new Set(['timestamp', 'event', 'phase', 'code', 'pid', 'childPid']);
  for (const record of actual) {
    assert.deepEqual(Object.keys(record).sort(), Object.keys(record).filter((key) => allowedFields.has(key)).sort());
    assert.equal(record.event, 'explicit_migration_phase');
    assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(JSON.stringify(record).includes(secret), false);
    assert.equal(JSON.stringify(record).includes(rawMessage), false);
    assert.equal('message' in record, false);
    assert.equal('stack' in record, false);
  }
}

test('phase audit durably appends only allowlisted records to its DI sandbox target', async () => {
  const { createMigrationPhaseAudit } = await import(built('migration-phase-audit.js'));
  const directory = temporaryDirectory('nvgw-migration-phase-audit-');
  const target = path.join(directory, 'nested', 'migration-phase.jsonl');
  const secret = 'FAKE-MIGRATION-AUDIT-SECRET';
  const rawMessage = `raw failure ${secret}`;
  const audit = createMigrationPhaseAudit({ filePath: target });

  assert.equal(fs.existsSync(target), false, 'DI target is created only when an event is appended');
  audit.emit('command_started', { pid: 123 });
  audit.emit('child_spawned', { pid: 123, childPid: 456, code: 'NOT_AN_ALLOWED_CODE', message: rawMessage, stack: rawMessage, key: secret });
  audit.emit('workflow_failed', { code: 'MIGRATION_GATEWAY_START_FAILED', childPid: 456 });

  const actual = records(target);
  assert.deepEqual(actual.map(({ phase, code, pid, childPid }) => ({ phase, code, pid, childPid })), [
    { phase: 'command_started', code: undefined, pid: 123, childPid: undefined },
    { phase: 'child_spawned', code: undefined, pid: 123, childPid: 456 },
    { phase: 'workflow_failed', code: 'MIGRATION_GATEWAY_START_FAILED', pid: undefined, childPid: 456 }
  ]);
  assertSafeRecords(actual, secret, rawMessage);
});

test('phase audit drops every non-allowlisted runtime phase without creating a target', async () => {
  const { createMigrationPhaseAudit } = await import(built('migration-phase-audit.js'));
  const directory = temporaryDirectory('nvgw-migration-phase-invalid-');
  const target = path.join(directory, 'nested', 'migration-phase.jsonl');
  const audit = createMigrationPhaseAudit({ filePath: target });
  const maliciousPhase = { toJSON() { throw new Error('phase must not serialize'); } };

  assert.doesNotThrow(() => audit.emit(undefined));
  assert.doesNotThrow(() => audit.emit(null));
  assert.doesNotThrow(() => audit.emit('not_an_audit_phase'));
  assert.doesNotThrow(() => audit.emit(maliciousPhase));
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(path.dirname(target)), false);
});

test('phase audit serializes only fixed fields from malicious values objects', async () => {
  const { createMigrationPhaseAudit } = await import(built('migration-phase-audit.js'));
  const directory = temporaryDirectory('nvgw-migration-phase-fields-');
  const target = path.join(directory, 'migration-phase.jsonl');
  const secret = 'FAKE-MALICIOUS-AUDIT-SECRET';
  const audit = createMigrationPhaseAudit({ filePath: target });
  const values = {
    code: 'MIGRATED',
    pid: 91,
    childPid: 92,
    secret,
    error: { message: secret, stack: secret },
    toJSON() { throw new Error('values object must not serialize'); }
  };

  assert.doesNotThrow(() => audit.emit('workflow_committed', values));
  const [record] = records(target);
  assert.deepEqual({ event: record.event, phase: record.phase, code: record.code, pid: record.pid, childPid: record.childPid }, {
    event: 'explicit_migration_phase', phase: 'workflow_committed', code: 'MIGRATED', pid: 91, childPid: 92
  });
  assertSafeRecords([record], secret, 'values object must not serialize');
});

test('phase audit drops throwing values accessors without serializing them', async () => {
  const { createMigrationPhaseAudit } = await import(built('migration-phase-audit.js'));
  const directory = temporaryDirectory('nvgw-migration-phase-throwing-fields-');
  const target = path.join(directory, 'migration-phase.jsonl');
  const audit = createMigrationPhaseAudit({ filePath: target });
  const values = {};
  Object.defineProperty(values, 'code', { get() { throw new Error('secret accessor must not run'); } });
  Object.defineProperty(values, 'pid', { get() { throw new Error('pid accessor must not run'); } });

  assert.doesNotThrow(() => audit.emit('workflow_failed', values));
  const [record] = records(target);
  assert.deepEqual(Object.keys(record).sort(), ['event', 'phase', 'timestamp']);
  assert.equal(JSON.stringify(record).includes('secret accessor must not run'), false);
});

test('phase audit protects its created log directory and file best-effort without blocking writes', async () => {
  const { createMigrationPhaseAudit } = await import(built('migration-phase-audit.js'));
  const directory = temporaryDirectory('nvgw-migration-phase-acl-');
  const target = path.join(directory, 'logs', 'migration-phase.jsonl');
  const calls = [];
  const audit = createMigrationPhaseAudit({
    filePath: target,
    protector: {
      protectDirectory(value) { calls.push(['directory', path.resolve(value)]); },
      protectFile(value) { calls.push(['file', path.resolve(value)]); }
    }
  });

  audit.emit('command_started', { pid: 123 });
  assert.deepEqual(calls, [['directory', path.resolve(path.dirname(target))], ['file', path.resolve(target)]]);
  assert.deepEqual(records(target).map((record) => record.phase), ['command_started']);

  const nonBlockingTarget = path.join(directory, 'unprotected', 'migration-phase.jsonl');
  const nonBlocking = createMigrationPhaseAudit({
    filePath: nonBlockingTarget,
    protector: {
      protectDirectory() { throw new Error('directory ACL failure includes C:\\private'); },
      protectFile() { throw new Error('file ACL failure includes C:\\private'); }
    }
  });
  assert.doesNotThrow(() => nonBlocking.emit('source_validated', { pid: 123 }));
  assert.deepEqual(records(nonBlockingTarget).map((record) => record.phase), ['source_validated']);
  assert.equal(fs.readFileSync(nonBlockingTarget, 'utf8').includes('C:\\private'), false);
});

test('prepared production lifecycle callback emits an allowlisted child phase with a numeric PID', async () => {
  const { createMigrationPhaseAudit } = await import(built('migration-phase-audit.js'));
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const directory = temporaryDirectory('nvgw-migration-phase-prepared-child-');
  const target = path.join(directory, 'migration-phase.jsonl');
  const audit = createMigrationPhaseAudit({ filePath: target });
  const child = new (await import('node:events')).EventEmitter();
  child.pid = 7654;
  child.exitCode = null;
  child.killed = false;
  child.connected = true;
  child.stdout = new (await import('node:events')).EventEmitter();
  child.stderr = new (await import('node:events')).EventEmitter();
  child.send = () => {};
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    child.emit('exit', 0, null);
    return true;
  };
  const lifecycle = new GatewayLifecycle({
    executablePath: process.execPath,
    serverPath: path.join(root, 'src', 'gateway', 'server.mjs'),
    runtimePaths: { configPath: path.join(directory, 'config.json'), statePath: path.join(directory, 'keys.json'), logPath: path.join(directory, 'gateway.jsonl'), appLogPath: path.join(directory, 'app.jsonl'), stdioLogPath: path.join(directory, 'stdio.jsonl'), ownerPath: path.join(directory, 'owner.json') },
    initialState: { keys: [], credentials: { gatewayToken: 'fixture-token', adminToken: 'fixture-admin-token' } },
    spawnChild: () => child,
    onPreparedChildSpawn: (phase, childPid) => audit.emit(phase === 'requested' ? 'child_spawn_requested' : 'child_spawned', { pid: process.pid, childPid })
  });
  lifecycle.preflight = async () => null;
  lifecycle.waitForHealthOrFailure = async () => ({ state: 'error', code: 'START_FAILED', port: 12000, message: 'controlled startup stop' });
  lifecycle.verifyChildOwnership = async () => true;
  lifecycle.writeOwnerRecord = () => {};

  assert.equal((await lifecycle.startPrepared({ keys: [], credentials: { gatewayToken: 'fixture-token', adminToken: 'fixture-admin-token' } }, 12000)).state, 'error');
  const actual = records(target);
  assert.deepEqual(actual.map((record) => record.phase), ['child_spawn_requested', 'child_spawned']);
  assert.equal(actual[1].childPid, 7654);
  assert.equal(Number.isInteger(actual[1].childPid), true);
  assertSafeRecords(actual, 'fixture-token', 'fixture-admin-token');
});

test('explicit coordinator records success-ish, known-source, child failure, and unknown fatal boundaries without raw errors', async () => {
  const { createMigrationPhaseAudit } = await import(built('migration-phase-audit.js'));
  const { runApplicationStartup } = await import(built('explicit-legacy-migration-startup.js'));
  const { createFatalShutdown } = await import(built('fatal-shutdown.js'));
  const directory = temporaryDirectory('nvgw-migration-phase-sequences-');
  const target = path.join(directory, 'migration-phase.jsonl');
  const audit = createMigrationPhaseAudit({ filePath: target });
  const secret = 'FAKE-RUNTIME-SECRET-FOR-AUDIT';
  const rawMessage = `unexpected failure contains ${secret}`;
  const common = {
    explicitLegacyMigration: true,
    acquireLegacyMigrationLock: () => ({ release() {} }),
    initializeLifecycle: () => ({ fake: true }),
    startNormal: async () => {},
    log: () => {},
    close: () => {},
    audit
  };

  await runApplicationStartup({
    ...common,
    validateLegacySource: () => ({ fake: true }),
    runMigration: async () => {
      audit.emit('recovery_prevalidated');
      audit.emit('child_spawn_requested', { pid: 71 });
      audit.emit('child_spawned', { pid: 71, childPid: 72 });
      audit.emit('gateway_ready', { pid: 71, childPid: 72 });
      audit.emit('workflow_committed', { pid: 71, childPid: 72, code: 'MIGRATED' });
      return { code: 'MIGRATED' };
    }
  });
  await runApplicationStartup({
    ...common,
    validateLegacySource: () => { throw new Error('LEGACY_SOURCE_SHAPE'); },
    runMigration: async () => ({})
  });
  await assert.rejects(() => runApplicationStartup({
    ...common,
    validateLegacySource: () => ({ fake: true }),
    runMigration: async () => {
      audit.emit('recovery_prevalidated');
      audit.emit('child_spawn_requested', { pid: 81 });
      audit.emit('child_spawned', { pid: 81, childPid: 82 });
      throw new Error('MIGRATION_GATEWAY_START_FAILED');
    }
  }), /MIGRATION_GATEWAY_START_FAILED/);
  await assert.rejects(() => runApplicationStartup({
    ...common,
    validateLegacySource: () => ({ fake: true }),
    runMigration: async () => { throw new Error(rawMessage); }
  }), (error) => error instanceof Error && error.message === rawMessage);
  await createFatalShutdown({ stop: async () => {}, exit: () => {}, onFatalShutdown: () => audit.emit('fatal_shutdown', { pid: 91 }) })();

  const actual = records(target);
  assert.deepEqual(actual.map((record) => record.phase), [
    'command_started', 'source_validated', 'lifecycle_initializing', 'recovery_prevalidated', 'child_spawn_requested', 'child_spawned', 'gateway_ready', 'workflow_committed',
    'command_started', 'workflow_failed',
    'command_started', 'source_validated', 'lifecycle_initializing', 'recovery_prevalidated', 'child_spawn_requested', 'child_spawned', 'workflow_failed',
    'command_started', 'source_validated', 'lifecycle_initializing', 'workflow_failed', 'fatal_shutdown'
  ]);
  assert.deepEqual(actual.filter((record) => record.phase === 'workflow_failed').map((record) => record.code), [
    'LEGACY_SOURCE_SHAPE', 'MIGRATION_GATEWAY_START_FAILED', undefined
  ]);
  assertSafeRecords(actual, secret, rawMessage);
});

test('explicit router records a fixed lifecycle initialization failure code and rethrows the original unknown error', async () => {
  const { createMigrationPhaseAudit } = await import(built('migration-phase-audit.js'));
  const { runApplicationStartup } = await import(built('explicit-legacy-migration-startup.js'));
  const directory = temporaryDirectory('nvgw-migration-phase-lifecycle-failure-');
  const target = path.join(directory, 'migration-phase.jsonl');
  const audit = createMigrationPhaseAudit({ filePath: target });
  const secret = 'FAKE-LIFECYCLE-INITIALIZATION-SECRET';
  const lifecycleError = new Error(`unexpected lifecycle initialization failure ${secret}`);
  const logged = [];
  let closeCalls = 0;

  await assert.rejects(() => runApplicationStartup({
    explicitLegacyMigration: true,
    validateLegacySource: () => ({ fake: true }),
    acquireLegacyMigrationLock: () => ({ release() {} }),
    initializeLifecycle: async () => { throw lifecycleError; },
    runMigration: async () => ({ code: 'MIGRATED' }),
    startNormal: async () => {},
    log: (...args) => logged.push(args),
    close: () => { closeCalls += 1; },
    audit
  }), (error) => error === lifecycleError);

  const actual = records(target);
  assert.deepEqual(actual.map(({ phase, code }) => ({ phase, code })), [
    { phase: 'command_started', code: undefined },
    { phase: 'source_validated', code: undefined },
    { phase: 'lifecycle_initializing', code: undefined },
    { phase: 'workflow_failed', code: 'MIGRATION_LIFECYCLE_INITIALIZATION_FAILED' }
  ]);
  assert.deepEqual(logged, []);
  assert.equal(closeCalls, 0);
  assertSafeRecords(actual, secret, lifecycleError.message);
});

test('audit write failures are non-throwing and do not reject the command workflow', async () => {
  const { createMigrationPhaseAudit } = await import(built('migration-phase-audit.js'));
  const { runApplicationStartup } = await import(built('explicit-legacy-migration-startup.js'));

  // The target must be a path whose write REALLY fails, and it must be absolute
  // and inside the sandbox.
  //
  // This case used to pass the RELATIVE path 'NUL\\invalid\\migration-phase.jsonl',
  // which proved nothing and polluted the repo. MEASURED on Windows: `NUL` only
  // resolves to the null device as the FINAL path component. As a directory
  // component it is an ordinary name, so the audit's
  // `fs.mkdirSync(path.dirname(filePath), { recursive: true })` CREATED a real
  // directory named NUL in the repo root (relative path => resolved against
  // process.cwd(), i.e. the repo), and the write then SUCCEEDED:
  //
  //   NUL\invalid\migration-phase.jsonl   mkdir=ok  open=ok  append=ok   6 bytes landed
  //   in<valid\migration-phase.jsonl      mkdir=ENOENT
  //   <regular file>\migration-phase.jsonl mkdir=EEXIST
  //
  // So this test asserted "write failures are non-throwing" while exercising the
  // SUCCESS path, and every run appended to repo-root NUL\invalid (225 records /
  // 26,214 bytes had accumulated). A file used as a directory is a real failure
  // on every platform, and staying under the temp sandbox keeps the repo clean.
  const directory = temporaryDirectory('nvgw-migration-phase-write-failure-');
  const blocker = path.join(directory, 'blocker');
  fs.writeFileSync(blocker, 'not a directory', 'utf8');
  const unwritableTarget = path.join(blocker, 'migration-phase.jsonl');
  assert.equal(path.isAbsolute(unwritableTarget), true,
    'the audit target must be absolute: a relative path is resolved against the repo and pollutes it');
  assert.throws(() => fs.mkdirSync(path.dirname(unwritableTarget), { recursive: true }),
    'the chosen target must genuinely fail to be created, otherwise this test proves nothing');

  const audit = createMigrationPhaseAudit({ filePath: unwritableTarget });
  const result = await runApplicationStartup({
    explicitLegacyMigration: true,
    validateLegacySource: () => ({ fake: true }),
    acquireLegacyMigrationLock: () => ({ release() {} }),
    initializeLifecycle: () => ({ fake: true }),
    runMigration: async () => ({ code: 'MIGRATED' }),
    startNormal: async () => {},
    log: () => {},
    close: () => {},
    audit
  });
  assert.deepEqual(result, { status: 'completed', result: { code: 'MIGRATED' } });
});
