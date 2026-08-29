import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { parse } from 'jsonc-parser';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const testSupport = (name) => pathToFileURL(path.join(root, 'build', 'src', 'test-support', name)).href;
const sandboxRoot = os.tmpdir();
// realpathSync.native expands Windows 8.3 short names (CI runner TEMP is
// C:\Users\RUNNER~1\...) while plain realpathSync does not. Normalize the
// fixture root up front so both resolvers agree on the same long-form path.
const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(sandboxRoot, `nvgw-final-migration-${process.pid}-`)));
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

const fakeCredentials = Object.freeze({ gatewayToken: 'fake-gateway-token-not-real', adminToken: 'fake-admin-token-not-real' });
const fakeKey = 'fake-nvidia-key-not-real';
const uuid = '550e8400-e29b-41d4-a716-446655440000';

function parseJsoncWithoutLeadingBom(source) {
  const errors = [];
  const parsed = parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source, errors, { allowTrailingComma: true, disallowComments: false });
  assert.deepEqual(errors, []);
  return parsed;
}

function keyShape(value) {
  if (Array.isArray(value)) return value.map(keyShape);
  if (value && typeof value === 'object') return Object.keys(value).map((key) => [key, keyShape(value[key])]);
  return typeof value;
}

function assertOnlyEndpointLiteralEdits(source, edited, replacements) {
  const sourceRanges = replacements.map(({ before, after }) => {
    const text = JSON.stringify(before);
    const offset = source.indexOf(text);
    assert.notEqual(offset, -1, `missing expected literal ${text}`);
    assert.equal(source.indexOf(text, offset + text.length), -1, `literal ${text} must be unique`);
    return { offset, length: text.length, text: JSON.stringify(after) };
  }).sort((left, right) => left.offset - right.offset);
  let expected = source;
  for (const replacement of [...sourceRanges].sort((left, right) => right.offset - left.offset)) {
    expected = expected.slice(0, replacement.offset) + replacement.text + expected.slice(replacement.offset + replacement.length);
  }
  assert.equal(edited, expected);

  let sourceCursor = 0;
  let editedCursor = 0;
  const outputRanges = [];
  for (const replacement of sourceRanges) {
    const unchangedSource = source.slice(sourceCursor, replacement.offset);
    const unchangedEdited = edited.slice(editedCursor, editedCursor + unchangedSource.length);
    assert.equal(unchangedEdited, unchangedSource, 'non-target string range changed');
    assert.deepEqual(Buffer.from(unchangedEdited, 'utf8'), Buffer.from(unchangedSource, 'utf8'), 'non-target byte range changed');
    const outputOffset = editedCursor + unchangedSource.length;
    assert.equal(edited.slice(outputOffset, outputOffset + replacement.text.length), replacement.text);
    outputRanges.push({ offset: outputOffset, length: replacement.text.length });
    sourceCursor = replacement.offset + replacement.length;
    editedCursor = outputOffset + replacement.text.length;
  }
  const unchangedSource = source.slice(sourceCursor);
  const unchangedEdited = edited.slice(editedCursor);
  assert.equal(unchangedEdited, unchangedSource, 'trailing non-target string range changed');
  assert.deepEqual(Buffer.from(unchangedEdited, 'utf8'), Buffer.from(unchangedSource, 'utf8'), 'trailing non-target byte range changed');
  return { sourceRanges, outputRanges };
}

function assertNonTargetStructurePreserved(source, edited, gatewayToken, baseURL) {
  const before = parseJsoncWithoutLeadingBom(source);
  const expected = structuredClone(before);
  expected.provider['nvidia-gateway'].options.apiKey = gatewayToken;
  expected.provider['nvidia-gateway'].options.baseURL = baseURL;
  const after = parseJsoncWithoutLeadingBom(edited);
  assert.deepEqual(after, expected);
  assert.deepEqual(keyShape(after), keyShape(before), 'key order or non-target structure changed');
}

function bomJsonFixture() {
  return '\ufeff{\r\n  "provider": {\r\n    "other": { "options": { "apiKey": "non-target-api-key-placeholder" } },\r\n    "nvidia-gateway": { "options": { "apiKey": "old-target-token-placeholder", "baseURL": "http://old.invalid/v1" } }\r\n  },\r\n  "retained": ["key-order", "and-structure"]\r\n}\r\n';
}

function bomJsoncFixture() {
  return '\ufeff// retain leading comment\r\n{\r\n  "provider": {\r\n    "other": { "options": { "apiKey": "non-target-api-key-placeholder" } },\r\n    "nvidia-gateway": {\r\n      // retain target-adjacent comment\r\n      "options": { "apiKey": "old-target-token-placeholder", "baseURL": "http://old.invalid/v1", },\r\n    },\r\n  },\r\n  "retained": ["key-order", "and-structure",],\r\n}\r\n';
}

function assertLeadingUtf8Bom(source) {
  assert.equal(Buffer.from(source, 'utf8').subarray(0, 3).toString('hex'), 'efbbbf');
}

function assertNoMigrationTemporaries(directory) {
  assert.deepEqual(fs.readdirSync(directory).filter((name) => /\.nvgw-(migration|rollback)\..+\.tmp(?:\.rollback)?$/.test(name)), []);
}

function knownFullLegacyDocument(overrides = {}) {
  return {
    name: 'fake-legacy-gateway',
    port: 12000,
    localKey: 'fake-legacy-local-key-must-not-migrate',
    stateFile: 'fake-legacy-state-file-must-not-migrate',
    defaultCooldownSeconds: 60,
    timeoutCooldownSeconds: 10,
    requestTimeoutMs: 30_000,
    maxFailoverAttempts: 3,
    allowedModels: ['fake-allowed-model'],
    localModels: ['fake-local-model'],
    chatUrl: 'https://fake.invalid/chat',
    modelsUrl: 'https://fake.invalid/models',
    upstreams: Array.from({ length: 11 }, (_, index) => ({ apiKey: index === 0 ? fakeKey : `fake-nvidia-key-${index}-not-real` })),
    headerTimeoutMs: 5_000,
    idleTimeoutMs: 60_000,
    rateLimitCooldownSeconds: 60,
    lockTimeoutMs: 1_000,
    maxStreamDurationMs: 120_000,
    ...overrides
  };
}

function adapter() {
  return {
    encrypt: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5),
    decrypt: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5)
  };
}

function keyRecord(key = fakeKey, id = uuid) {
  return { id, key, status: 'active', backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 } };
}

test('child persistence projection preserves main-owned credentials and migration metadata across save, flush, restart, and key operations', async () => {
  const { mergeChildKeyProjection } = await import(built('state-ownership.js'));
  const source = {
    keys: [keyRecord()],
    credentials: { ...fakeCredentials },
    legacyNvidiaMigration: { version: 1, sourceFingerprint: 'a'.repeat(64), importedCount: 1, importedAt: '2026-08-01T00:00:00.000Z' },
    migrationJournal: { version: 1, phase: 'committed', operationId: 'operation-1' }
  };
  const persisted = mergeChildKeyProjection(source, { keys: [{ ...keyRecord(), status: 'disabled', usage: { success: 2, fail: 1, tokens: 10, lastUsed: 4 } }] });
  assert.equal(persisted.credentials.gatewayToken, fakeCredentials.gatewayToken);
  assert.deepEqual(persisted.legacyNvidiaMigration, source.legacyNvidiaMigration);
  assert.deepEqual(persisted.migrationJournal, source.migrationJournal);
  assert.equal(persisted.keys[0].status, 'disabled');
  const restarted = structuredClone(persisted);
  const flushed = mergeChildKeyProjection(restarted, { keys: [keyRecord()] });
  assert.deepEqual(flushed.credentials, fakeCredentials);
  assert.deepEqual(flushed.legacyNvidiaMigration, source.legacyNvidiaMigration);
  assert.deepEqual(flushed.migrationJournal, source.migrationJournal);
});

test('main port scanner detects a live loopback listener in packaged CommonJS output', async () => {
  const { checkPorts } = await import(built('port-scanner.js'));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  try {
    const port = listener.address().port;
    assert.equal((await checkPorts([port]))[port], true);
  } finally { await new Promise((resolve) => listener.close(resolve)); }
});

test('private state channel rejects credential injection, unexpected root fields, invalid IDs and unbounded key arrays', async () => {
  const { createPrivateStateChannel } = await import(built('private-state-channel.js'));
  const child = new EventEmitter();
  const sent = [];
  const saved = [];
  child.connected = true;
  child.send = (value) => sent.push(value);
  const channel = createPrivateStateChannel({ initialState: { keys: [keyRecord()], credentials: fakeCredentials }, persist: (value) => saved.push(value) });
  channel.attach(child);
  child.emit('message', { type: 'ready', challenge: 'c'.repeat(24) });
  assert.equal(sent.length, 1);
  child.emit('message', { type: 'state:persist', state: { keys: [keyRecord()], credentials: { gatewayToken: 'attacker' } } });
  child.emit('message', { type: 'state:persist', state: { keys: [keyRecord()], migrationJournal: {} } });
  child.emit('message', { type: 'state:persist', state: { keys: [{ ...keyRecord(), id: 'not-a-uuid' }] } });
  child.emit('message', { type: 'state:persist', state: { keys: Array.from({ length: 1001 }, () => keyRecord()) } });
  assert.equal(saved.length, 0);
  child.emit('message', { type: 'state:persist', state: { keys: [keyRecord()] } });
  assert.deepEqual(saved, [{ keys: [keyRecord()] }]);
});

test('child persistence projection rejects duplicate canonical IDs and duplicate key material before persistence', async () => {
  const { isChildKeyProjection, mergeChildKeyProjection } = await import(built('state-ownership.js'));
  const duplicateId = { keys: [keyRecord(fakeKey, uuid), keyRecord('other-fake-key', uuid)] };
  const duplicateKey = { keys: [keyRecord(fakeKey, uuid), keyRecord(fakeKey, '550e8400-e29b-41d4-a716-446655440001')] };
  assert.equal(isChildKeyProjection(duplicateId), false);
  assert.equal(isChildKeyProjection(duplicateKey), false);
  assert.throws(() => mergeChildKeyProjection({ keys: [] }, duplicateId), (error) => error.message === 'STATE_PROJECTION_INVALID');
});

test('strict legacy migration imports only apiKey values, preserves matching key state, and is idempotent without exposing key material', async () => {
  const { SecureStore, decodeEncryptedState } = await import(built('secure-state.js'));
  const { migrateLegacyNvidiaForTests } = await import(testSupport('legacy-nvidia-migration.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'migration-ok-'));
  const legacy = path.join(dir, 'legacy-nvidia.json');
  const statePath = path.join(dir, 'keys.json');
  const source = knownFullLegacyDocument({ upstreams: [{ apiKey: fakeKey }, { apiKey: 'second-fake-nvidia-key-not-real' }] });
  fs.writeFileSync(legacy, JSON.stringify(source));
  const store = new SecureStore(statePath, adapter());
  const matching = keyRecord(fakeKey);
  matching.status = 'disabled'; matching.backoffUntil = 99; matching.usage.success = 9;
  store.persist({ keys: [matching], credentials: { ...fakeCredentials } });
  const result = migrateLegacyNvidiaForTests({ sourcePath: legacy, store, state: store.initialize(), protectFile: () => {} });
  assert.deepEqual(result, { code: 'MIGRATED', importedCount: 1, existingCount: 1 });
  const stored = decodeEncryptedState(fs.readFileSync(statePath), adapter());
  assert.equal(stored.keys.length, 2);
  assert.deepEqual(stored.keys[0], matching);
  assert.equal(stored.keys[1].key, 'second-fake-nvidia-key-not-real');
  assert.match(stored.keys[1].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(stored.legacyNvidiaMigration.importedCount, 2);
  const repeat = migrateLegacyNvidiaForTests({ sourcePath: legacy, store, state: stored, protectFile: () => {} });
  assert.deepEqual(repeat, { code: 'ALREADY_MIGRATED', importedCount: 0, existingCount: 2 });
  assert.equal(JSON.stringify(result).includes(fakeKey), false);
  const persisted = JSON.stringify(stored);
  for (const value of [source.localKey, source.stateFile, source.chatUrl, source.modelsUrl, source.name, ...source.allowedModels, ...source.localModels]) {
    assert.equal(persisted.includes(value), false, `persisted state must not contain source metadata: ${value}`);
    assert.equal(JSON.stringify(result).includes(value), false, `migration result must not contain source metadata: ${value}`);
  }
});

test('production schema parser and test-support reader accept only the minimal or exact audited legacy documents', async () => {
  const { parseLegacyNvidiaDocument } = await import(built('legacy-nvidia-schema.js'));
  const { readStrictLegacySourceForTests } = await import(testSupport('legacy-nvidia-migration.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'migration-schema-parity-'));
  const source = path.join(dir, 'legacy.json');
  const validCases = [
    { name: 'minimal', document: { upstreams: [{ apiKey: ` ${fakeKey} ` }] }, keys: [fakeKey] },
    { name: 'known full document with eleven upstreams', document: knownFullLegacyDocument(), keys: Array.from({ length: 11 }, (_, index) => index === 0 ? fakeKey : `fake-nvidia-key-${index}-not-real`) }
  ];
  for (const { name, document, keys } of validCases) {
    assert.deepEqual(parseLegacyNvidiaDocument(document), keys, `production parser ${name}`);
    fs.writeFileSync(source, JSON.stringify(document));
    assert.deepEqual(readStrictLegacySourceForTests(source).keys, keys, `test support ${name}`);
  }

  const invalidCases = [
    { name: 'unknown root field', document: { upstreams: [{ apiKey: fakeKey }], futureField: true }, code: 'LEGACY_SOURCE_SHAPE' },
    { name: 'upstream metadata', document: { upstreams: [{ apiKey: fakeKey, localKey: 'must-reject' }] }, code: 'LEGACY_UPSTREAM_SHAPE' },
    { name: 'blank apiKey', document: { upstreams: [{ apiKey: '  ' }] }, code: 'LEGACY_KEY_INVALID' },
    { name: 'oversize apiKey', document: { upstreams: [{ apiKey: 'x'.repeat(10_001) }] }, code: 'LEGACY_KEY_INVALID' },
    { name: 'duplicate trimmed apiKey', document: { upstreams: [{ apiKey: fakeKey }, { apiKey: ` ${fakeKey} ` }] }, code: 'LEGACY_KEY_DUPLICATE' }
  ];
  for (const [field, value] of Object.entries(knownFullLegacyDocument())) {
    const missing = knownFullLegacyDocument(); delete missing[field];
    invalidCases.push({ name: `full document missing ${field}`, document: missing, code: 'LEGACY_SOURCE_SHAPE' });
    invalidCases.push({ name: `full document wrong ${field} type`, document: knownFullLegacyDocument({ [field]: Array.isArray(value) ? 'not-an-array' : typeof value === 'string' ? 1 : 'not-a-number' }), code: 'LEGACY_SOURCE_SHAPE' });
  }
  invalidCases.push(
    { name: 'port zero', document: knownFullLegacyDocument({ port: 0 }), code: 'LEGACY_SOURCE_SHAPE' },
    { name: 'port fractional', document: knownFullLegacyDocument({ port: 12_000.5 }), code: 'LEGACY_SOURCE_SHAPE' },
    { name: 'port above range', document: knownFullLegacyDocument({ port: 65_536 }), code: 'LEGACY_SOURCE_SHAPE' }
  );
  for (const field of ['defaultCooldownSeconds', 'timeoutCooldownSeconds', 'requestTimeoutMs', 'maxFailoverAttempts', 'headerTimeoutMs', 'idleTimeoutMs', 'rateLimitCooldownSeconds', 'lockTimeoutMs', 'maxStreamDurationMs']) {
    invalidCases.push(
      { name: `${field} negative`, document: knownFullLegacyDocument({ [field]: -1 }), code: 'LEGACY_SOURCE_SHAPE' },
      { name: `${field} fractional`, document: knownFullLegacyDocument({ [field]: 1.5 }), code: 'LEGACY_SOURCE_SHAPE' },
      { name: `${field} non-finite`, document: knownFullLegacyDocument({ [field]: Number.POSITIVE_INFINITY }), code: 'LEGACY_SOURCE_SHAPE' }
    );
  }
  for (const { name, document, code } of invalidCases) {
    assert.throws(() => parseLegacyNvidiaDocument(document), (error) => error.message === code, `production parser ${name}`);
    fs.writeFileSync(source, JSON.stringify(document));
    assert.throws(() => readStrictLegacySourceForTests(source), (error) => error.message === code, `test support ${name}`);
  }
});

test('legacy migration fails closed for symlinks, malformed or oversized input, unknown shapes, duplicates and source changes', async () => {
  const { SecureStore } = await import(built('secure-state.js'));
  const { migrateLegacyNvidiaForTests, LEGACY_NVIDIA_MAX_BYTES } = await import(testSupport('legacy-nvidia-migration.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'migration-reject-'));
  const source = path.join(dir, 'legacy.json');
  const store = new SecureStore(path.join(dir, 'keys.json'), adapter());
  store.persist({ keys: [], credentials: fakeCredentials });
  const run = (body) => { fs.writeFileSync(source, body); return () => migrateLegacyNvidiaForTests({ sourcePath: source, store, state: { keys: [], credentials: fakeCredentials }, protectFile: () => {} }); };
  for (const body of ['{', '[]', JSON.stringify({ upstreams: [{}] }), JSON.stringify({ upstreams: [{ apiKey: '  ' }] }), JSON.stringify({ upstreams: [{ apiKey: fakeKey }, { apiKey: fakeKey }] })]) {
    assert.throws(run(body), (error) => /^(LEGACY_|MIGRATION_)/.test(error.message));
  }
  assert.throws(run('x'.repeat(LEGACY_NVIDIA_MAX_BYTES + 1)), (error) => error.message === 'LEGACY_SOURCE_TOO_LARGE');
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] }));
  const initial = migrateLegacyNvidiaForTests({ sourcePath: source, store, state: { keys: [], credentials: fakeCredentials }, protectFile: () => {} });
  const state = store.initialize();
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: 'changed-fake-nvidia-key-not-real' }] }));
  assert.deepEqual(initial, { code: 'MIGRATED', importedCount: 1, existingCount: 0 });
  assert.throws(() => migrateLegacyNvidiaForTests({ sourcePath: source, store, state, protectFile: () => {} }), (error) => error.message === 'LEGACY_SOURCE_CHANGED');
});

test('legacy source rejects unknown root fields before a state backup or write', async () => {
  const { migrateLegacyNvidiaForTests } = await import(testSupport('legacy-nvidia-migration.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'migration-root-schema-'));
  const source = path.join(dir, 'legacy.json');
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }], futureField: true }));
  const calls = [];
  const store = { createVersionedBackup: () => { calls.push('backup'); return path.join(dir, 'backup'); }, restoreVersionedBackup: () => calls.push('restore'), persist: () => calls.push('persist') };
  assert.throws(() => migrateLegacyNvidiaForTests({ sourcePath: source, store, state: { keys: [], credentials: fakeCredentials } }), (error) => error.message === 'LEGACY_SOURCE_SHAPE');
  assert.deepEqual(calls, []);
});

test('legacy source detects an injected file identity change during its read snapshot', async () => {
  const { readStrictLegacySourceForTests } = await import(testSupport('legacy-nvidia-migration.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'migration-toctou-'));
  const source = path.join(dir, 'legacy.json');
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] }));
  const realStat = fs.lstatSync(source);
  let leafStats = 0;
  assert.throws(() => readStrictLegacySourceForTests(source, {
    lstatSync: (filePath) => filePath === source && ++leafStats >= 3
      ? new Proxy(realStat, { get: (target, property) => property === 'size' ? target.size + 1 : Reflect.get(target, property) })
      : fs.lstatSync(filePath),
    realpathSync: fs.realpathSync.native,
    readFileSync: fs.readFileSync
  }), (error) => error.message === 'LEGACY_SOURCE_CHANGED_DURING_READ');
});

test('legacy source rejects a parent directory symlink when the platform permits creating one', async (t) => {
  const { migrateLegacyNvidiaForTests } = await import(testSupport('legacy-nvidia-migration.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'migration-parent-link-'));
  const actual = path.join(dir, 'actual'); const linked = path.join(dir, 'linked');
  fs.mkdirSync(actual); fs.writeFileSync(path.join(actual, 'legacy.json'), JSON.stringify({ upstreams: [{ apiKey: fakeKey }] }));
  try { fs.symlinkSync(actual, linked, 'junction'); } catch { t.skip('parent symlink creation is not permitted on this platform'); return; }
  const store = { createVersionedBackup: () => { throw new Error('must not backup'); }, restoreVersionedBackup: () => {}, persist: () => { throw new Error('must not persist'); } };
  assert.throws(() => migrateLegacyNvidiaForTests({ sourcePath: path.join(linked, 'legacy.json'), store, state: { keys: [], credentials: fakeCredentials } }), (error) => error.message === 'LEGACY_SOURCE_NOT_REGULAR');
});

test('migration makes a protected versioned encrypted state backup and restores the prior verified state on persistence failure', async () => {
  const { SecureStore, decodeEncryptedState } = await import(built('secure-state.js'));
  const { migrateLegacyNvidiaForTests } = await import(testSupport('legacy-nvidia-migration.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'migration-rollback-'));
  const statePath = path.join(dir, 'keys.json');
  const source = path.join(dir, 'legacy.json');
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] }));
  const stable = new SecureStore(statePath, adapter());
  stable.persist({ keys: [keyRecord('prior-key-not-real')], credentials: fakeCredentials });
  const state = stable.initialize();
  const protectedPaths = [];
  const failingStore = {
    statePath,
    adapter: adapter(),
    createVersionedBackup: (...args) => stable.createVersionedBackup(...args),
    restoreVersionedBackup: (...args) => stable.restoreVersionedBackup(...args),
    persist: () => { throw new Error('injected-write-failure'); }
  };
  assert.throws(() => migrateLegacyNvidiaForTests({ sourcePath: source, store: failingStore, state, protectFile: (value) => protectedPaths.push(value) }), (error) => error.message === 'MIGRATION_STATE_WRITE_FAILED');
  assert.equal(decodeEncryptedState(fs.readFileSync(statePath), adapter()).keys[0].key, 'prior-key-not-real');
  assert.equal(fs.readdirSync(dir).some((name) => /^keys\.json\.pre-migration\.v1\..+\.bak$/.test(name)), true);
  assert.equal(protectedPaths.length > 0, true);
});

test('JSONC sync changes only target string literals, preserves comments/trailing commas, and rejects ambiguous, malformed and non-string config', async () => {
  const { editOpenCodeJsonc } = await import(testSupport('opencode-jsonc-sync.js'));
  const source = `// keep this comment\n{\n  "provider": {\n    "other": { "options": { "apiKey": "unchanged" } },\n    "nvidia-gateway": {\n      // keep this comment too\n      "options": { "apiKey": "old-key", "baseURL": "http://old/v1", },\n    },\n  },\n}\n`;
  const edited = editOpenCodeJsonc(source, fakeCredentials.gatewayToken, 'http://127.0.0.1:12004/v1');
  assert.equal(edited.includes('// keep this comment'), true);
  assert.equal(edited.includes('"other": { "options": { "apiKey": "unchanged" } }'), true);
  assert.equal(edited.includes('"apiKey": "old-key"'), false);
  assert.equal(edited.includes(fakeCredentials.gatewayToken), true);
  for (const invalid of ['{', '{}', '{"provider":{"nvidia-gateway":{"options":{"apiKey":1,"baseURL":"x"}}}}', '{"provider":{"nvidia-gateway":{"options":{"apiKey":"x","baseURL":"y"}},"nvidia-gateway":{"options":{"apiKey":"x","baseURL":"y"}}}}']) {
    assert.throws(() => editOpenCodeJsonc(invalid, fakeCredentials.gatewayToken, 'http://127.0.0.1:12004/v1'), (error) => /^OPENCODE_CONFIG_/.test(error.message));
  }
});

test('BOM-aware JSONC edit preserves a leading UTF-8 BOM and changes only the two target literal spans', async () => {
  const { editOpenCodeJsonc } = await import(testSupport('opencode-jsonc-sync.js'));
  const baseURL = 'http://127.0.0.1:12004/v1';
  for (const source of [bomJsonFixture(), bomJsoncFixture()]) {
    const edited = editOpenCodeJsonc(source, fakeCredentials.gatewayToken, baseURL);
    assertLeadingUtf8Bom(source); assertLeadingUtf8Bom(edited);
    const ranges = assertOnlyEndpointLiteralEdits(source, edited, [
      { before: 'old-target-token-placeholder', after: fakeCredentials.gatewayToken },
      { before: 'http://old.invalid/v1', after: baseURL }
    ]);
    assert.equal(ranges.sourceRanges.length, 2);
    assert.equal(edited.includes('non-target-api-key-placeholder'), true);
    assert.equal(edited.includes('\r\n'), true);
    assertNonTargetStructurePreserved(source, edited, fakeCredentials.gatewayToken, baseURL);
  }

  const normal = bomJsoncFixture().slice(1);
  const normalEdited = editOpenCodeJsonc(normal, fakeCredentials.gatewayToken, baseURL);
  assert.equal(normalEdited.charCodeAt(0) === 0xfeff, false);
  assertOnlyEndpointLiteralEdits(normal, normalEdited, [
    { before: 'old-target-token-placeholder', after: fakeCredentials.gatewayToken },
    { before: 'http://old.invalid/v1', after: baseURL }
  ]);
  assert.throws(() => editOpenCodeJsonc(bomJsonFixture().replace('{', '{\ufeff'), fakeCredentials.gatewayToken, baseURL), (error) => error.message === 'OPENCODE_CONFIG_MALFORMED');
});

test('shared production JSONC target locator translates parser offsets back to BOM-prefixed raw source offsets', async () => {
  const { locateOpenCodeJsoncTargets } = await import(built('opencode-jsonc-targets.js'));
  const source = bomJsoncFixture();
  const targets = locateOpenCodeJsoncTargets(source);
  assert.equal(targets.apiKey.rawOffset, source.indexOf('"old-target-token-placeholder"'));
  assert.equal(targets.baseURL.rawOffset, source.indexOf('"http://old.invalid/v1"'));
  assert.equal(source.slice(targets.apiKey.rawOffset, targets.apiKey.rawOffset + targets.apiKey.length), '"old-target-token-placeholder"');
  assert.equal(source.slice(targets.baseURL.rawOffset, targets.baseURL.rawOffset + targets.baseURL.length), '"http://old.invalid/v1"');
  assert.throws(() => locateOpenCodeJsoncTargets(bomJsonFixture().replace('{', '{\ufeff')), (error) => error.message === 'OPENCODE_CONFIG_MALFORMED');
});

test('strict shared OpenCode decoder retains one leading UTF-8 BOM and rejects non-leading BOMs, malformed UTF-8, and UTF-16 BOMs', async () => {
  const { decodeStrictUtf8OpenCodeConfig } = await import(built('opencode-config-decoding.js'));
  const bomSource = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"title":"cafГ©"}\r\n', 'utf8')]);
  const decoded = decodeStrictUtf8OpenCodeConfig(bomSource);
  assert.equal(decoded.charCodeAt(0), 0xfeff);
  assert.deepEqual(Buffer.from(decoded, 'utf8'), bomSource);
  assert.equal(decodeStrictUtf8OpenCodeConfig(Buffer.from('{"title":"ж™®йЂљиЇќ"}', 'utf8')).charCodeAt(0) === 0xfeff, false);
  for (const invalid of [Buffer.from('{"value":"a\ufeffb"}'), Buffer.from([0x2f, 0x2f, 0xc3, 0x28]), Buffer.from([0xff, 0xfe, 0x7b, 0x00]), Buffer.from([0xfe, 0xff, 0x00, 0x7b])]) {
    assert.throws(() => decodeStrictUtf8OpenCodeConfig(invalid), (error) => error.message === 'OPENCODE_CONFIG_MALFORMED');
  }
});

test('shared locator rejects every non-leading U+FEFF before JSONC traversal', async () => {
  const { locateOpenCodeJsoncTargets } = await import(built('opencode-jsonc-targets.js'));
  const source = bomJsoncFixture();
  const invalidSources = [
    source.replace('// retain leading comment', '// retain\ufeffleading comment'),
    source.replace('\r\n{', '\r\n\ufeff{'),
    source.replace('"non-target-api-key-placeholder"', '"non-target-\ufeffapi-key-placeholder"')
  ];
  for (const invalid of invalidSources) {
    assert.throws(() => locateOpenCodeJsoncTargets(invalid), (error) => error.message === 'OPENCODE_CONFIG_MALFORMED');
  }
});

test('strict UTF-8 transaction validation rejects malformed sources before backups, temporaries, or rewrites', async () => {
  const { syncOpenCodeConfigs } = await import(testSupport('opencode-jsonc-sync.js'));
  const valid = Buffer.from(bomJsoncFixture(), 'utf8');
  const validWithoutBom = Buffer.from(bomJsoncFixture().slice(1), 'utf8');
  const malformedUtf8 = Buffer.concat([Buffer.from('// non-target comment: '), Buffer.from([0xc3, 0x28]), Buffer.from('\r\n'), validWithoutBom]);
  const malformedUtf16Bom = Buffer.concat([Buffer.from([0xff, 0xfe]), valid]);
  for (const malformed of [malformedUtf8, malformedUtf16Bom]) {
    for (const malformedIndex of [0, 1]) {
      const dir = fs.mkdtempSync(path.join(tempRoot, `jsonc-strict-utf8-${malformedIndex}-`));
      const paths = [path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc')];
      const originals = malformedIndex === 0 ? [malformed, valid] : [valid, malformed];
      fs.writeFileSync(paths[0], originals[0]); fs.writeFileSync(paths[1], originals[1]);
      assert.throws(() => syncOpenCodeConfigs({ configPaths: paths, gatewayToken: fakeCredentials.gatewayToken, port: 12004, protectFile: () => {} }), (error) => error.message === 'OPENCODE_CONFIG_MALFORMED');
      assert.deepEqual(fs.readFileSync(paths[0]), originals[0]);
      assert.deepEqual(fs.readFileSync(paths[1]), originals[1]);
      assertNoMigrationTemporaries(dir);
      assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.nvgw-migration.') && name.endsWith('.bak')), []);
    }
  }
});

test('large strict UTF-8 JSONC with CRLF, comments, trailing commas, and Unicode changes exactly target literals', async () => {
  const { editOpenCodeJsonc } = await import(testSupport('opencode-jsonc-sync.js'));
  const retained = Array.from({ length: 300 }, (_, index) => `    // retained note ${index}: ж™®йЂљиЇќ cafГ©\r\n    "setting-${index}": { "label": "Р·РЅР°С‡РµРЅРёРµ-${index}", "items": ["О±", "ОІ",], },`).join('\r\n');
  const source = `// large real-like document\r\n{\r\n  "provider": {\r\n    "nvidia-gateway": {\r\n      "options": { "apiKey": "old-target-token-placeholder", "baseURL": "http://old.invalid/v1", },\r\n    },\r\n  },\r\n  "retained": {\r\n${retained}\r\n  },\r\n}\r\n`;
  const edited = editOpenCodeJsonc(source, fakeCredentials.gatewayToken, 'http://127.0.0.1:12004/v1');
  assertOnlyEndpointLiteralEdits(source, edited, [
    { before: 'old-target-token-placeholder', after: fakeCredentials.gatewayToken },
    { before: 'http://old.invalid/v1', after: 'http://127.0.0.1:12004/v1' }
  ]);
  assertNonTargetStructurePreserved(source, edited, fakeCredentials.gatewayToken, 'http://127.0.0.1:12004/v1');
});

test('BOM-prefixed sandbox OpenCode transaction and rollback preserve exact bytes outside target literals', async () => {
  const { syncOpenCodeConfigs, rollbackOpenCodeConfigs } = await import(testSupport('opencode-jsonc-sync.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'jsonc-bom-transaction-'));
  const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const originals = [Buffer.from(bomJsonFixture()), Buffer.from(bomJsoncFixture())];
  fs.writeFileSync(first, originals[0]); fs.writeFileSync(second, originals[1]);
  const result = syncOpenCodeConfigs({ configPaths: [first, second], gatewayToken: fakeCredentials.gatewayToken, port: 12004, protectFile: () => {} });
  const baseURL = 'http://127.0.0.1:12004/v1';
  for (const [index, filePath] of [first, second].entries()) {
    const edited = fs.readFileSync(filePath, 'utf8');
    assertLeadingUtf8Bom(edited);
    assertOnlyEndpointLiteralEdits(originals[index].toString('utf8'), edited, [
      { before: 'old-target-token-placeholder', after: fakeCredentials.gatewayToken },
      { before: 'http://old.invalid/v1', after: baseURL }
    ]);
    assertNonTargetStructurePreserved(originals[index].toString('utf8'), edited, fakeCredentials.gatewayToken, baseURL);
    assert.equal(edited.includes('non-target-api-key-placeholder'), true);
    assert.deepEqual(fs.readFileSync(result.backups[index]), originals[index]);
  }
  assertNoMigrationTemporaries(dir);
  rollbackOpenCodeConfigs({ configPaths: [first, second], backups: result.backups, gatewayToken: fakeCredentials.gatewayToken, port: 12004, protectFile: () => {} });
  assert.deepEqual(fs.readFileSync(first), originals[0]); assert.deepEqual(fs.readFileSync(second), originals[1]);
  assertNoMigrationTemporaries(dir);
  assert.equal(result.backups.every((backup) => fs.existsSync(backup)), true, 'protected backups remain for operator recovery');
});

test('OpenCode config transaction detects concurrent edits, rolls back the first file after second-file failure, and keeps token out of error output', async () => {
  const { syncOpenCodeConfigs } = await import(testSupport('opencode-jsonc-sync.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'jsonc-txn-'));
  const first = path.join(dir, 'opencode.json');
  const second = path.join(dir, 'opencode.jsonc');
  const original = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  fs.writeFileSync(first, original); fs.writeFileSync(second, original);
  assert.throws(() => syncOpenCodeConfigs({ configPaths: [first, second], gatewayToken: fakeCredentials.gatewayToken, port: 12004, protectFile: () => {}, hooks: { beforeReplace: (file) => { if (file === first) fs.writeFileSync(first, `${original}\n// external edit`); } } }), (error) => error.message === 'OPENCODE_CONFIG_CHANGED');
  assert.equal(fs.readFileSync(first, 'utf8').includes('// external edit'), true);
  fs.writeFileSync(first, original); fs.writeFileSync(second, original);
  assert.throws(() => syncOpenCodeConfigs({ configPaths: [first, second], gatewayToken: fakeCredentials.gatewayToken, port: 12004, protectFile: () => {}, hooks: { beforeReplace: (file) => { if (file === second) throw new Error('injected'); } } }), (error) => error.message === 'OPENCODE_CONFIG_WRITE_FAILED');
  assert.equal(fs.readFileSync(first, 'utf8'), original);
  try { syncOpenCodeConfigs({ configPaths: [first, second], gatewayToken: fakeCredentials.gatewayToken, port: 12004, protectFile: () => {}, hooks: { beforeReplace: () => { throw new Error('contains ' + fakeCredentials.gatewayToken); } } }); } catch (error) { assert.equal(String(error).includes(fakeCredentials.gatewayToken), false); }
});

test('OpenCode transaction refuses a mutation between final check and replacement without overwriting it', async () => {
  const { syncOpenCodeConfigs } = await import(testSupport('opencode-jsonc-sync.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'jsonc-final-race-'));
  const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const original = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  fs.writeFileSync(first, original); fs.writeFileSync(second, original);
  assert.throws(() => syncOpenCodeConfigs({ configPaths: [first, second], gatewayToken: fakeCredentials.gatewayToken, port: 12004, protectFile: () => {}, hooks: {
    afterFinalCheckBeforeReplace: (file) => { if (file === first) fs.writeFileSync(first, `${original}\n// user edit`); }
  } }), (error) => error.message === 'OPENCODE_CONFIG_CONCURRENT_MODIFICATION');
  assert.equal(fs.readFileSync(first, 'utf8'), `${original}\n// user edit`);
  assert.equal(fs.readFileSync(first, 'utf8').includes(fakeCredentials.gatewayToken), false);
});

test('OpenCode transaction detects a post-replace external edit and never rolls it back blindly', async () => {
  const { syncOpenCodeConfigs } = await import(testSupport('opencode-jsonc-sync.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'jsonc-post-race-'));
  const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const original = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  const userEdit = `${original}\n// user post-replace edit`;
  fs.writeFileSync(first, original); fs.writeFileSync(second, original);
  assert.throws(() => syncOpenCodeConfigs({ configPaths: [first, second], gatewayToken: fakeCredentials.gatewayToken, port: 12004, protectFile: () => {}, hooks: {
    afterReplaceBeforeVerify: (file) => { if (file === first) fs.writeFileSync(first, userEdit); }
  } }), (error) => error.message === 'OPENCODE_CONFIG_CONCURRENT_MODIFICATION');
  assert.equal(fs.readFileSync(first, 'utf8'), userEdit);
  assert.equal(fs.readFileSync(first, 'utf8').includes(fakeCredentials.gatewayToken), false);
});

test('OpenCode rollback preserves a user edit that races a failed second replacement', async () => {
  const { syncOpenCodeConfigs } = await import(testSupport('opencode-jsonc-sync.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'jsonc-rollback-race-'));
  const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const original = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  fs.writeFileSync(first, original); fs.writeFileSync(second, original);
  assert.throws(() => syncOpenCodeConfigs({ configPaths: [first, second], gatewayToken: fakeCredentials.gatewayToken, port: 12004, protectFile: () => {}, hooks: {
    beforeReplace: (file) => { if (file === second) throw new Error('fail second'); },
    beforeRollbackReplace: (file) => { if (file === first) fs.writeFileSync(first, `${original}\n// user rollback edit`); }
  } }), (error) => error.message === 'OPENCODE_CONFIG_CONCURRENT_MODIFICATION');
  assert.equal(fs.readFileSync(first, 'utf8'), `${original}\n// user rollback edit`);
});

test('OpenCode ACL failures after either visible replacement compensate every owned config without exposing credentials', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  for (const failAtTargetProtection of [1, 2]) {
    const dir = fs.mkdtempSync(path.join(tempRoot, `workflow-opencode-acl-${failAtTargetProtection}-`));
    const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
    const appOriginal = JSON.stringify({ gatewayPort: 12000, language: 'en', setupComplete: false });
    const openCodeOriginal = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
    fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, appOriginal); fs.writeFileSync(first, openCodeOriginal); fs.writeFileSync(second, openCodeOriginal);
    const store = new SecureStore(path.join(dir, 'keys.json'), adapter()); store.persist({ keys: [], credentials: fakeCredentials });
    let targetProtections = 0;
    const protectFile = (filePath) => {
      if (filePath === first || filePath === second) {
        targetProtections++;
        if (targetProtections === failAtTargetProtection) throw new Error('injected-acl-protection-failure');
      }
    };
    await assert.rejects(() => runLegacyNvidiaMigrationForTests({
      runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: store.initialize(), protectFile, sourcePath: source, configPaths: [first, second],
      lifecycle: { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => ({ state: 'stopped' }) }, checkPorts: async () => ({ 12004: false, 12005: false })
    }), (error) => error.message === 'MIGRATION_FAILED');
    assert.deepEqual(store.initialize(), { keys: [], credentials: fakeCredentials }, `state ${failAtTargetProtection}`);
    for (const filePath of [first, second]) {
      const current = fs.readFileSync(filePath, 'utf8');
      assert.equal(current, openCodeOriginal, `${path.basename(filePath)} ${failAtTargetProtection}`);
      assert.equal(current.includes(fakeCredentials.gatewayToken), false);
      assert.equal(current.includes('127.0.0.1:12004'), false);
    }
    assert.equal(fs.readFileSync(config, 'utf8'), appOriginal);
  }
});

test('migration does not commit state, OpenCode or app config when managed gateway readiness fails after preflight', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'workflow-start-fail-'));
  const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const appOriginal = JSON.stringify({ gatewayPort: 12000, language: 'en', setupComplete: false });
  const openCodeOriginal = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, appOriginal); fs.writeFileSync(first, openCodeOriginal); fs.writeFileSync(second, openCodeOriginal);
  const store = new SecureStore(path.join(dir, 'keys.json'), adapter()); store.persist({ keys: [], credentials: fakeCredentials });
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({ runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: store.initialize(), protectFile: () => {}, sourcePath: source, configPaths: [first, second], lifecycle: { startPrepared: async () => ({ state: 'error', code: 'START_FAILED' }), stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false }) }), (error) => error.message === 'MIGRATION_GATEWAY_START_FAILED');
  assert.deepEqual(store.initialize(), { keys: [], credentials: fakeCredentials });
  assert.equal(fs.readFileSync(config, 'utf8'), appOriginal); assert.equal(fs.readFileSync(first, 'utf8'), openCodeOriginal); assert.equal(fs.readFileSync(second, 'utf8'), openCodeOriginal);
});

test('migration rolls encrypted state and OpenCode back when every later commit boundary fails', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  for (const boundary of ['sync', 'app-config', 'journal']) {
    const dir = fs.mkdtempSync(path.join(tempRoot, `workflow-rollback-${boundary}-`));
    const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
    const appOriginal = JSON.stringify({ gatewayPort: 12000, language: 'en', setupComplete: false }); const openCodeOriginal = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
    fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, appOriginal); fs.writeFileSync(first, openCodeOriginal); fs.writeFileSync(second, openCodeOriginal);
    const stable = new SecureStore(path.join(dir, 'keys.json'), adapter()); stable.persist({ keys: [], credentials: fakeCredentials });
    let writes = 0; const store = boundary === 'journal' ? { initialize: () => stable.initialize(), createVersionedBackup: (...args) => stable.createVersionedBackup(...args), restoreVersionedBackup: (...args) => stable.restoreVersionedBackup(...args), persist: (value) => { writes++; if (writes === 3) throw new Error('journal failure'); stable.persist(value); } } : stable;
    const lifecycle = { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => ({ state: 'stopped' }) };
    const hooks = boundary === 'sync' ? { beforeReplace: (file) => { if (file === second) throw new Error('second config failure'); } } : undefined;
    const afterAppConfigWrite = boundary === 'app-config' ? () => { throw new Error('app failure'); } : undefined;
    await assert.rejects(() => runLegacyNvidiaMigrationForTests({ runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: stable.initialize(), protectFile: () => {}, sourcePath: source, configPaths: [first, second], lifecycle, checkPorts: async () => ({ 12004: false, 12005: false }), syncHooks: hooks, afterAppConfigWrite }), (error) => /^MIGRATION_/.test(error.message));
    assert.deepEqual(stable.initialize(), { keys: [], credentials: fakeCredentials }, boundary);
    assert.equal(fs.readFileSync(config, 'utf8'), appOriginal, boundary); assert.equal(fs.readFileSync(first, 'utf8'), openCodeOriginal, boundary); assert.equal(fs.readFileSync(second, 'utf8'), openCodeOriginal, boundary);
  }
});

test('migration preserves an external app-config edit made after its own write and reports concurrent modification', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'workflow-app-config-race-'));
  const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const appOriginal = JSON.stringify({ gatewayPort: 12000, language: 'en', setupComplete: false });
  const userEdit = JSON.stringify({ gatewayPort: 45678, language: 'ru', setupComplete: false, external: true });
  const openCodeOriginal = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, appOriginal); fs.writeFileSync(first, openCodeOriginal); fs.writeFileSync(second, openCodeOriginal);
  const stable = new SecureStore(path.join(dir, 'keys.json'), adapter()); stable.persist({ keys: [], credentials: fakeCredentials });
  const store = stable;
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: stable.initialize(), protectFile: () => {}, sourcePath: source, configPaths: [first, second],
    lifecycle: { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => ({ state: 'stopped' }) }, checkPorts: async () => ({ 12004: false, 12005: false }),
    afterAppConfigWrite: () => fs.writeFileSync(config, userEdit)
  }), (error) => error.message === 'MIGRATION_CONFIG_CONCURRENT_MODIFICATION');
  assert.equal(fs.readFileSync(config, 'utf8'), userEdit);
});

test('app-config writer refuses a foreign temp replacement before target rename and preserves the original target', async () => {
  const { prepareAppConfigMigrationWrite } = await import(testSupport('migration-app-config.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'app-config-temp-replacement-race-'));
  const config = path.join(dir, 'config.json');
  const original = Buffer.from(JSON.stringify({ gatewayPort: 12000, language: 'en', setupComplete: false }));
  const foreign = Buffer.from('{"foreign":"replacement"}');
  fs.writeFileSync(config, original);
  const write = prepareAppConfigMigrationWrite(config, { gatewayPort: 12004, setupComplete: true });
  let temporary;
  assert.throws(() => write.writeIfCurrent(() => {}, {
    afterCandidateVerifiedBeforeReplace: (filePath) => { temporary = filePath; fs.writeFileSync(filePath, foreign); }
  }), (error) => error.message === 'MIGRATION_CONFIG_CONCURRENT_MODIFICATION');
  assert.equal(fs.readFileSync(config).equals(original), true);
  assert.equal(fs.readFileSync(temporary).equals(foreign), true);
});

test('app-config writer rechecks the target immediately before rename and preserves an external edit', async () => {
  const { prepareAppConfigMigrationWrite } = await import(testSupport('migration-app-config.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'app-config-target-replacement-race-'));
  const config = path.join(dir, 'config.json');
  const original = Buffer.from(JSON.stringify({ gatewayPort: 12000, language: 'en', setupComplete: false }));
  const external = Buffer.from('{"external":"target-edit"}');
  fs.writeFileSync(config, original);
  const write = prepareAppConfigMigrationWrite(config, { gatewayPort: 12004, setupComplete: true });
  assert.throws(() => write.writeIfCurrent(() => {}, {
    afterCandidateVerifiedBeforeReplace: () => fs.writeFileSync(config, external)
  }), (error) => error.message === 'MIGRATION_CONFIG_CONCURRENT_MODIFICATION');
  assert.equal(fs.readFileSync(config).equals(external), true);
});

test('app-config writer creates its UUID temp exclusively and still writes then rolls back its verified candidate', async () => {
  const { prepareAppConfigMigrationWrite } = await import(testSupport('migration-app-config.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'app-config-temp-exclusive-'));
  const config = path.join(dir, 'config.json');
  const original = Buffer.from(JSON.stringify({ gatewayPort: 12000, language: 'en', setupComplete: false }));
  const foreign = Buffer.from('{"foreign":"collision"}');
  fs.writeFileSync(config, original);
  const collision = prepareAppConfigMigrationWrite(config, { gatewayPort: 12004, setupComplete: true });
  let temporary;
  assert.throws(() => collision.writeIfCurrent(() => {}, {
    beforeTemporaryCreate: (filePath) => { temporary = filePath; fs.writeFileSync(filePath, foreign); }
  }), (error) => error.message === 'MIGRATION_APP_CONFIG_WRITE_FAILED');
  assert.equal(fs.readFileSync(config).equals(original), true);
  assert.equal(fs.readFileSync(temporary).equals(foreign), true);

  const normal = prepareAppConfigMigrationWrite(config, { gatewayPort: 12004, setupComplete: true });
  assert.doesNotThrow(() => normal.writeIfCurrent(() => {}));
  assert.equal(fs.readFileSync(config).equals(normal.candidate), true);
  assert.doesNotThrow(() => normal.restoreIfOwned(() => {}));
  assert.equal(fs.readFileSync(config).equals(original), true);
});

test('app config ACL failure is compensated, while a persistent failure retains a protected recovery artifact and fails closed', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  for (const persistent of [false, true]) {
    const dir = fs.mkdtempSync(path.join(tempRoot, `workflow-app-acl-${persistent}-`));
    const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
    const appOriginal = JSON.stringify({ gatewayPort: 12000, language: 'en', setupComplete: false });
    const openCodeOriginal = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
    fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, appOriginal); fs.writeFileSync(first, openCodeOriginal); fs.writeFileSync(second, openCodeOriginal);
    const store = new SecureStore(path.join(dir, 'keys.json'), adapter()); store.persist({ keys: [], credentials: fakeCredentials });
    let configProtections = 0;
    const protectFile = (filePath) => {
      if (filePath === config) {
        configProtections++;
        if (persistent || configProtections === 1) throw new Error('injected-app-acl-protection-failure');
      }
    };
    await assert.rejects(() => runLegacyNvidiaMigrationForTests({
      runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: store.initialize(), protectFile, sourcePath: source, configPaths: [first, second],
      lifecycle: { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => ({ state: 'stopped' }) }, checkPorts: async () => ({ 12004: false, 12005: false })
    }), (error) => error.message === (persistent ? 'MIGRATION_ROLLBACK_FAILED' : 'MIGRATION_APP_CONFIG_WRITE_FAILED'));
    assert.deepEqual(store.initialize(), { keys: [], credentials: fakeCredentials });
    assert.equal(fs.readFileSync(config, 'utf8'), appOriginal);
    assert.equal(fs.readFileSync(first, 'utf8'), openCodeOriginal);
    assert.equal(fs.readFileSync(second, 'utf8'), openCodeOriginal);
    const artifacts = fs.readdirSync(dir).filter((name) => /^config\.json\.migration-rollback-recovery\..+\.bak$/.test(name));
    assert.equal(artifacts.length, persistent ? 1 : 0);
    if (persistent) assert.equal(fs.readFileSync(path.join(dir, artifacts[0]), 'utf8'), appOriginal);
  }
});

test('migration journals protected OpenCode backup paths before a later second-config failure', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'workflow-journal-backups-'));
  const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const original = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, JSON.stringify({ gatewayPort: 12000, language: 'en', setupComplete: false })); fs.writeFileSync(first, original); fs.writeFileSync(second, original);
  const stable = new SecureStore(path.join(dir, 'keys.json'), adapter()); stable.persist({ keys: [], credentials: fakeCredentials });
  const phases = []; const store = { initialize: () => stable.initialize(), createVersionedBackup: (...args) => stable.createVersionedBackup(...args), restoreVersionedBackup: (...args) => stable.restoreVersionedBackup(...args), persist: (value) => { phases.push(value.migrationJournal?.phase); stable.persist(value); } };
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({ runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: stable.initialize(), protectFile: () => {}, sourcePath: source, configPaths: [first, second], lifecycle: { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => ({ state: 'stopped' }) }, checkPorts: async () => ({ 12004: false, 12005: false }), syncHooks: { beforeReplace: (file) => { if (file === second) throw new Error('second config failure'); } } }), (error) => error.message === 'MIGRATION_FAILED');
  assert.equal(phases.includes('opencode_backup_prepared'), true);
});

test('OpenCode config retry accepts only its own prior output and refuses a user change after a partial migration', async () => {
  const { editOpenCodeJsonc, syncOpenCodeConfigs } = await import(testSupport('opencode-jsonc-sync.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'jsonc-retry-'));
  const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const source = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  const backups = [path.join(dir, '.opencode.json.nvgw-migration.test.bak'), path.join(dir, '.opencode.jsonc.nvgw-migration.test.bak')];
  fs.writeFileSync(backups[0], source); fs.writeFileSync(backups[1], source);
  fs.writeFileSync(first, editOpenCodeJsonc(source, fakeCredentials.gatewayToken, 'http://127.0.0.1:12004/v1'));
  fs.writeFileSync(second, source);
  assert.doesNotThrow(() => syncOpenCodeConfigs({ configPaths: [first, second], priorBackups: backups, gatewayToken: fakeCredentials.gatewayToken, port: 12004, protectFile: () => {} }));
  fs.writeFileSync(first, `${fs.readFileSync(first, 'utf8')}\n// user edit`);
  assert.throws(() => syncOpenCodeConfigs({ configPaths: [first, second], priorBackups: backups, gatewayToken: fakeCredentials.gatewayToken, port: 12004, protectFile: () => {} }), (error) => error.message === 'OPENCODE_CONFIG_CHANGED');
});

test('workflow propagates an OpenCode concurrent edit without overwriting it and still cleans state and lifecycle', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'workflow-opencode-concurrent-'));
  const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const appOriginal = JSON.stringify({ gatewayPort: 12000, language: 'en', setupComplete: false });
  const original = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  const externalEdit = `${original}\n// external edit`;
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, appOriginal); fs.writeFileSync(first, original); fs.writeFileSync(second, original);
  const store = new SecureStore(path.join(dir, 'keys.json'), adapter()); store.persist({ keys: [], credentials: fakeCredentials });
  let stopped = 0;
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: store.initialize(), protectFile: () => {}, sourcePath: source, configPaths: [first, second],
    lifecycle: { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => { stopped++; } }, checkPorts: async () => ({ 12004: false, 12005: false }),
    syncHooks: { afterFinalCheckBeforeReplace: (file) => { if (file === first) fs.writeFileSync(first, externalEdit); } }
  }), (error) => error.message === 'OPENCODE_CONFIG_CONCURRENT_MODIFICATION');
  assert.equal(fs.readFileSync(first, 'utf8'), externalEdit);
  assert.deepEqual(store.initialize(), { keys: [], credentials: fakeCredentials });
  assert.equal(stopped, 1);
});

test('workflow retry restores the original OpenCode baseline after a crash at verified replacement then downstream failure', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'workflow-retry-original-baseline-'));
  const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const appOriginal = JSON.stringify({ gatewayPort: 12000, language: 'en', setupComplete: false });
  const original = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, appOriginal); fs.writeFileSync(first, original); fs.writeFileSync(second, original);
  const stable = new SecureStore(path.join(dir, 'keys.json'), adapter()); stable.persist({ keys: [], credentials: fakeCredentials });
  const crashingStore = stable;
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store: crashingStore, state: stable.initialize(), protectFile: () => {}, sourcePath: source, configPaths: [first, second],
    lifecycle: { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false }),
    crashAfterVerified: () => { throw new Error('TEST_SIMULATED_CRASH'); }
  }), (error) => error.message === 'TEST_SIMULATED_CRASH');
  const crashedState = stable.initialize();
  assert.equal(crashedState.migrationJournal.phase, 'opencode_replaced_verified');
  const originalBackups = crashedState.migrationJournal.opencodeBackups;
  assert.equal(fs.readFileSync(first, 'utf8').includes(fakeCredentials.gatewayToken), true);
  const staleOwner = { ...crashedState.migrationJournal.opencodeLock, pid: 2147483647 };
  crashedState.migrationJournal.opencodeLock = staleOwner;
  stable.persist(crashedState);
  fs.writeFileSync(staleOwner.lockPath, JSON.stringify(staleOwner));
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store: stable, state: crashedState, protectFile: () => {}, sourcePath: source, configPaths: [first, second],
    lifecycle: { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false }), afterAppConfigWrite: () => { throw new Error('downstream failure'); }
  }), (error) => error.message === 'MIGRATION_APP_CONFIG_WRITE_FAILED');
  assert.equal(fs.readFileSync(first, 'utf8'), original);
  assert.equal(fs.readFileSync(second, 'utf8'), original);
  assert.equal(fs.readFileSync(config, 'utf8'), appOriginal);
  assert.deepEqual(stable.initialize(), { keys: [], credentials: fakeCredentials });
  assert.deepEqual(originalBackups.map((file) => fs.readFileSync(file, 'utf8')), [original, original]);
});

test('retry reconciles only its stale journal-owned migration lock after a verified-replacement crash and rolls every owned output back', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'workflow-stale-lock-recovery-'));
  const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const appOriginal = JSON.stringify({ gatewayPort: 12000, language: 'en', setupComplete: false });
  const original = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, appOriginal); fs.writeFileSync(first, original); fs.writeFileSync(second, original);
  const store = new SecureStore(path.join(dir, 'keys.json'), adapter()); store.persist({ keys: [], credentials: fakeCredentials });
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: store.initialize(), protectFile: () => {}, sourcePath: source, configPaths: [first, second],
    lifecycle: { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false }),
    crashAfterVerified: () => { throw new Error('TEST_SIMULATED_CRASH'); }
  }), (error) => error.message === 'TEST_SIMULATED_CRASH');
  const crashed = store.initialize();
  assert.equal(crashed.migrationJournal.phase, 'opencode_replaced_verified');
  const staleOwner = { ...crashed.migrationJournal.opencodeLock, pid: 2147483647 };
  crashed.migrationJournal.opencodeLock = staleOwner; store.persist(crashed); fs.writeFileSync(staleOwner.lockPath, JSON.stringify(staleOwner));
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: crashed, protectFile: () => {}, sourcePath: source, configPaths: [first, second],
    lifecycle: { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false }), afterAppConfigWrite: () => { throw new Error('downstream failure'); }
  }), (error) => error.message === 'MIGRATION_APP_CONFIG_WRITE_FAILED');
  assert.deepEqual(JSON.parse(fs.readFileSync(staleOwner.lockPath, 'utf8')), staleOwner);
  assert.equal(fs.readFileSync(config, 'utf8'), appOriginal);
  assert.equal(fs.readFileSync(first, 'utf8'), original);
  assert.equal(fs.readFileSync(second, 'utf8'), original);
  assert.deepEqual(store.initialize(), { keys: [], credentials: fakeCredentials });
});

test('stale-lock validation never deletes a replacement installed during the recovery race', async () => {
  const { reconcileMigrationLockForTests } = await import(testSupport('opencode-jsonc-sync.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'migration-lock-replacement-race-'));
  const lockPath = path.join(dir, `migration.${uuid}.550e8400-e29b-41d4-a716-446655440001.lock`);
  const staleOwner = { version: 1, operationId: uuid, instanceId: '550e8400-e29b-41d4-a716-446655440001', pid: 2147483647, lockPath };
  const replacement = { version: 1, operationId: '550e8400-e29b-41d4-a716-446655440002', instanceId: '550e8400-e29b-41d4-a716-446655440003', pid: process.pid, lockPath };
  fs.writeFileSync(lockPath, JSON.stringify(staleOwner));
  assert.throws(() => reconcileMigrationLockForTests({
    owner: staleOwner,
    hooks: { afterValidated: () => fs.writeFileSync(lockPath, JSON.stringify(replacement)) }
  }), (error) => error.message === 'OPENCODE_CONFIG_LOCK_UNAVAILABLE');
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), replacement);
});

test('successful OpenCode sync retains its unique operation marker rather than unlinking a pathname', async () => {
  const { syncOpenCodeConfigs } = await import(testSupport('opencode-jsonc-sync.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'migration-unique-lock-release-'));
  const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const source = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  const lockPath = path.join(dir, `migration.${uuid}.550e8400-e29b-41d4-a716-446655440004.lock`);
  const owner = { version: 1, operationId: uuid, instanceId: '550e8400-e29b-41d4-a716-446655440004', pid: process.pid, lockPath };
  fs.writeFileSync(first, source); fs.writeFileSync(second, source);
  assert.doesNotThrow(() => syncOpenCodeConfigs({ configPaths: [first, second], gatewayToken: fakeCredentials.gatewayToken, port: 12004, protectFile: () => {}, lockOwner: owner }));
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), owner);
});

test('recovery fails closed without deleting a live or ambiguous migration lock', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  for (const kind of ['live', 'ambiguous']) {
    const dir = fs.mkdtempSync(path.join(tempRoot, `workflow-${kind}-lock-recovery-`));
    const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
    const original = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
    fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, '{}'); fs.writeFileSync(first, original); fs.writeFileSync(second, original);
    const store = new SecureStore(path.join(dir, 'keys.json'), adapter()); store.persist({ keys: [], credentials: fakeCredentials });
    await assert.rejects(() => runLegacyNvidiaMigrationForTests({
      runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: store.initialize(), protectFile: () => {}, sourcePath: source, configPaths: [first, second],
      lifecycle: { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false }),
      crashAfterVerified: () => { throw new Error('TEST_SIMULATED_CRASH'); }
    }), (error) => error.message === 'TEST_SIMULATED_CRASH');
    const crashed = store.initialize(); const owner = { ...crashed.migrationJournal.opencodeLock };
    const blockingLock = kind === 'live' ? { ...owner, pid: process.pid } : { ...owner, instanceId: '550e8400-e29b-41d4-a716-446655440999' };
    fs.writeFileSync(owner.lockPath, JSON.stringify(blockingLock));
    await assert.rejects(() => runLegacyNvidiaMigrationForTests({
      runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: crashed, protectFile: () => { throw new Error('must not write'); }, sourcePath: source, configPaths: [first, second],
      lifecycle: { startPrepared: async () => { throw new Error('must not start'); }, stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false })
    }), (error) => error.message === 'MIGRATION_JOURNAL_RECOVERY_FAILED');
    assert.deepEqual(JSON.parse(fs.readFileSync(owner.lockPath, 'utf8')), blockingLock, kind);
  }
});

test('recovery rejects a journal whose nested dead lock owner belongs to another operation before port checks, lifecycle start, or writes', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'workflow-mismatched-lock-operation-recovery-'));
  const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const appOriginal = JSON.stringify({ gatewayPort: 12000, language: 'en', setupComplete: false });
  const openCodeOriginal = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, appOriginal); fs.writeFileSync(first, openCodeOriginal); fs.writeFileSync(second, openCodeOriginal);
  const store = new SecureStore(path.join(dir, 'keys.json'), adapter()); store.persist({ keys: [], credentials: fakeCredentials });
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: store.initialize(), protectFile: () => {}, sourcePath: source, configPaths: [first, second],
    lifecycle: { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false }),
    crashAfterVerified: () => { throw new Error('TEST_SIMULATED_CRASH'); }
  }), (error) => error.message === 'TEST_SIMULATED_CRASH');
  const crashed = store.initialize();
  const journalOperationId = crashed.migrationJournal.operationId;
  const deadOwner = {
    ...crashed.migrationJournal.opencodeLock,
    operationId: '550e8400-e29b-41d4-a716-446655440010',
    instanceId: '550e8400-e29b-41d4-a716-446655440011',
    pid: 2147483647
  };
  deadOwner.lockPath = path.join(dir, `migration.${deadOwner.operationId}.${deadOwner.instanceId}.lock`);
  crashed.migrationJournal.opencodeLock = deadOwner;
  store.persist(crashed); fs.writeFileSync(deadOwner.lockPath, JSON.stringify(deadOwner));
  const firstBeforeRetry = fs.readFileSync(first, 'utf8');
  const secondBeforeRetry = fs.readFileSync(second, 'utf8');
  let portChecks = 0; let starts = 0; let writes = 0;
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: crashed, protectFile: () => { writes++; }, sourcePath: source, configPaths: [first, second],
    lifecycle: { startPrepared: async () => { starts++; return { state: 'running', port: 12004 }; }, stopPrepared: async () => {} },
    checkPorts: async () => { portChecks++; return { 12004: false, 12005: false }; }
  }), (error) => error.message === 'MIGRATION_JOURNAL_RECOVERY_FAILED');
  assert.notEqual(deadOwner.operationId, journalOperationId);
  assert.equal(portChecks, 0);
  assert.equal(starts, 0);
  assert.equal(writes, 0);
  assert.deepEqual(store.initialize(), crashed);
  assert.deepEqual(JSON.parse(fs.readFileSync(deadOwner.lockPath, 'utf8')), deadOwner);
  assert.equal(fs.readFileSync(config, 'utf8'), appOriginal);
  assert.equal(fs.readFileSync(first, 'utf8'), firstBeforeRetry);
  assert.equal(fs.readFileSync(second, 'utf8'), secondBeforeRetry);
});

test('retry uses the durable app-config baseline after a crash following app write and restores it with state and OpenCode on later failure', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'workflow-app-config-baseline-recovery-'));
  const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const appOriginal = JSON.stringify({ gatewayPort: 12000, language: 'en', setupComplete: false, retained: 'original' });
  const original = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, appOriginal); fs.writeFileSync(first, original); fs.writeFileSync(second, original);
  const store = new SecureStore(path.join(dir, 'keys.json'), adapter()); store.persist({ keys: [], credentials: fakeCredentials });
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: store.initialize(), protectFile: () => {}, sourcePath: source, configPaths: [first, second],
    lifecycle: { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false }),
    crashAfterAppConfigWrite: () => { throw new Error('TEST_SIMULATED_CRASH'); }
  }), (error) => error.message === 'TEST_SIMULATED_CRASH');
  const crashed = store.initialize();
  assert.equal(crashed.migrationJournal.phase, 'app_config_backup_prepared');
  assert.notEqual(fs.readFileSync(config, 'utf8'), appOriginal);
  const staleOwner = { ...crashed.migrationJournal.opencodeLock, pid: 2147483647 };
  crashed.migrationJournal.opencodeLock = staleOwner; store.persist(crashed); fs.writeFileSync(staleOwner.lockPath, JSON.stringify(staleOwner));
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: crashed, protectFile: () => {}, sourcePath: source, configPaths: [first, second],
    lifecycle: { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false }), afterAppConfigWrite: () => { throw new Error('downstream failure'); }
  }), (error) => error.message === 'MIGRATION_APP_CONFIG_WRITE_FAILED');
  assert.equal(fs.readFileSync(config, 'utf8'), appOriginal);
  assert.equal(fs.readFileSync(first, 'utf8'), original);
  assert.equal(fs.readFileSync(second, 'utf8'), original);
  assert.deepEqual(store.initialize(), { keys: [], credentials: fakeCredentials });
});

test('recovery fails closed when the durable app-config baseline is missing, malformed, or tampered', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  for (const corruption of ['missing', 'malformed', 'tampered']) {
    const dir = fs.mkdtempSync(path.join(tempRoot, `workflow-app-backup-${corruption}-`));
    const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
    const original = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
    fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, '{}'); fs.writeFileSync(first, original); fs.writeFileSync(second, original);
    const store = new SecureStore(path.join(dir, 'keys.json'), adapter()); store.persist({ keys: [], credentials: fakeCredentials });
    await assert.rejects(() => runLegacyNvidiaMigrationForTests({
      runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: store.initialize(), protectFile: () => {}, sourcePath: source, configPaths: [first, second],
      lifecycle: { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false }),
      crashAfterAppConfigWrite: () => { throw new Error('TEST_SIMULATED_CRASH'); }
    }), (error) => error.message === 'TEST_SIMULATED_CRASH');
    const crashed = store.initialize(); const backup = crashed.migrationJournal.appConfigBackup.backup;
    if (corruption === 'missing') fs.unlinkSync(backup);
    if (corruption === 'malformed') store.persist({ ...crashed, migrationJournal: { ...crashed.migrationJournal, appConfigBackup: { backup } } });
    if (corruption === 'tampered') fs.writeFileSync(backup, 'tampered');
    await assert.rejects(() => runLegacyNvidiaMigrationForTests({
      runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: store.initialize(), protectFile: () => { throw new Error('must not write'); }, sourcePath: source, configPaths: [first, second],
      lifecycle: { startPrepared: async () => { throw new Error('must not start'); }, stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false })
    }), (error) => error.message === 'MIGRATION_JOURNAL_RECOVERY_FAILED', corruption);
  }
});

test('recovery preserves a third-party app-config state and fails before lifecycle start', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'workflow-app-config-external-recovery-'));
  const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const original = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  const external = JSON.stringify({ gatewayPort: 45678, language: 'ru', setupComplete: false, external: true });
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, '{}'); fs.writeFileSync(first, original); fs.writeFileSync(second, original);
  const store = new SecureStore(path.join(dir, 'keys.json'), adapter()); store.persist({ keys: [], credentials: fakeCredentials });
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: store.initialize(), protectFile: () => {}, sourcePath: source, configPaths: [first, second],
    lifecycle: { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false }),
    crashAfterAppConfigWrite: () => { throw new Error('TEST_SIMULATED_CRASH'); }
  }), (error) => error.message === 'TEST_SIMULATED_CRASH');
  fs.writeFileSync(config, external); let starts = 0;
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: store.initialize(), protectFile: () => { throw new Error('must not write'); }, sourcePath: source, configPaths: [first, second],
    lifecycle: { startPrepared: async () => { starts++; return { state: 'running', port: 12004 }; }, stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false })
  }), (error) => error.message === 'MIGRATION_JOURNAL_RECOVERY_FAILED');
  assert.equal(starts, 0);
  assert.equal(fs.readFileSync(config, 'utf8'), external);
});

test('recovery rejects syntactically valid protected backups owned by another migration before port checks, lifecycle, or writes', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  const { prepareAppConfigMigrationWrite } = await import(testSupport('migration-app-config.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'workflow-foreign-backup-recovery-'));
  const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const operationA = '550e8400-e29b-41d4-a716-446655440020';
  const operationB = '550e8400-e29b-41d4-a716-446655440021';
  const appOriginal = JSON.stringify({ gatewayPort: 12000, language: 'en', setupComplete: false });
  const openCodeOriginal = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, appOriginal); fs.writeFileSync(first, openCodeOriginal); fs.writeFileSync(second, openCodeOriginal);
  const statePath = path.join(dir, 'keys.json'); const store = new SecureStore(statePath, adapter()); store.persist({ keys: [], credentials: fakeCredentials });
  const stateBackup = `${statePath}.pre-migration.v1.${operationA}.bak`; fs.copyFileSync(statePath, stateBackup);
  const backups = [path.join(dir, `.opencode.json.nvgw-migration.${operationB}.bak`), path.join(dir, `.opencode.jsonc.nvgw-migration.${operationB}.bak`)];
  fs.writeFileSync(backups[0], openCodeOriginal); fs.writeFileSync(backups[1], openCodeOriginal);
  const appBackup = `${config}.nvgw-migration.${operationB}.app-config.bak`; fs.writeFileSync(appBackup, appOriginal);
  const appCandidate = prepareAppConfigMigrationWrite(config, { gatewayPort: 12004, setupComplete: true }, Buffer.from(appOriginal)).candidate;
  const lockOwner = { version: 1, operationId: operationA, instanceId: '550e8400-e29b-41d4-a716-446655440022', pid: 2147483647, lockPath: path.join(dir, `migration.${operationA}.550e8400-e29b-41d4-a716-446655440022.lock`) };
  fs.writeFileSync(lockOwner.lockPath, JSON.stringify(lockOwner));
  store.persist({ keys: [keyRecord()], credentials: fakeCredentials, legacyNvidiaMigration: { version: 1, sourceFingerprint: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), importedCount: 1, importedAt: '2026-08-01T00:00:00.000Z' }, migrationJournal: { version: 1, phase: 'app_config_backup_prepared', operationId: operationA, stateBackup, opencodeLock: lockOwner, opencodeBackups: backups, opencodeOriginalHashes: backups.map(hash), appConfigBackup: { backup: appBackup, originalHash: hash(appBackup), candidateHash: crypto.createHash('sha256').update(appCandidate).digest('hex') } } });
  const before = { config: fs.readFileSync(config, 'utf8'), first: fs.readFileSync(first, 'utf8'), second: fs.readFileSync(second, 'utf8'), state: store.initialize() };
  let portChecks = 0; let starts = 0; let writes = 0;
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime: { configPath: config, statePath }, store, state: before.state, protectFile: () => { writes++; }, sourcePath: source, configPaths: [first, second],
    lifecycle: { startPrepared: async () => { starts++; return { state: 'running', port: 12004 }; }, stopPrepared: async () => {} },
    checkPorts: async () => { portChecks++; return { 12004: false, 12005: false }; }
  }), (error) => error.message === 'MIGRATION_JOURNAL_RECOVERY_FAILED');
  assert.equal(portChecks, 0); assert.equal(starts, 0); assert.equal(writes, 0);
  assert.equal(fs.readFileSync(config, 'utf8'), before.config); assert.equal(fs.readFileSync(first, 'utf8'), before.first); assert.equal(fs.readFileSync(second, 'utf8'), before.second); assert.deepEqual(store.initialize(), before.state);
});

test('incomplete journal with missing or malformed OpenCode recovery metadata fails before any config write', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  for (const journal of [
    { version: 1, phase: 'opencode_replaced_verified', stateBackup: 'missing-state-backup' },
    { version: 1, phase: 'opencode_replaced_verified', stateBackup: 'will-be-replaced', opencodeBackups: ['missing-one', 'missing-two'], opencodeOriginalHashes: ['a'.repeat(64), 'b'.repeat(64)] }
  ]) {
    const dir = fs.mkdtempSync(path.join(tempRoot, 'workflow-invalid-recovery-'));
    const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
    const original = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
    fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, '{}'); fs.writeFileSync(first, original); fs.writeFileSync(second, original);
    const store = new SecureStore(path.join(dir, 'keys.json'), adapter()); store.persist({ keys: [], credentials: fakeCredentials, migrationJournal: journal });
    await assert.rejects(() => runLegacyNvidiaMigrationForTests({
      runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: store.initialize(), protectFile: () => { throw new Error('must not protect/write'); }, sourcePath: source, configPaths: [first, second],
      lifecycle: { startPrepared: async () => { throw new Error('must not start'); }, stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false })
    }), (error) => error.message === 'MIGRATION_JOURNAL_RECOVERY_FAILED');
    assert.equal(fs.readFileSync(first, 'utf8'), original);
    assert.equal(fs.readFileSync(second, 'utf8'), original);
  }
});

test('incomplete journal with an externally changed current OpenCode config fails closed before lifecycle start', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'workflow-current-recovery-change-'));
  const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const original = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  const backups = [path.join(dir, 'first.bak'), path.join(dir, 'second.bak')];
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, '{}'); fs.writeFileSync(first, `${original}\n// external edit`); fs.writeFileSync(second, original); fs.writeFileSync(backups[0], original); fs.writeFileSync(backups[1], original);
  const stateBackup = path.join(dir, 'keys.json.pre-migration.v1.fixture.bak');
  const store = new SecureStore(path.join(dir, 'keys.json'), adapter()); store.persist({ keys: [], credentials: fakeCredentials }); fs.copyFileSync(path.join(dir, 'keys.json'), stateBackup);
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  store.persist({ keys: [keyRecord()], credentials: fakeCredentials, legacyNvidiaMigration: { version: 1, sourceFingerprint: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), importedCount: 1, importedAt: '2026-08-01T00:00:00.000Z' }, migrationJournal: { version: 1, phase: 'opencode_replaced_verified', operationId: '550e8400-e29b-41d4-a716-446655440000', stateBackup, opencodeBackups: backups, opencodeOriginalHashes: backups.map(hash) } });
  let starts = 0;
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: store.initialize(), protectFile: () => { throw new Error('must not write'); }, sourcePath: source, configPaths: [first, second],
    lifecycle: { startPrepared: async () => { starts++; return { state: 'running', port: 12004 }; }, stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false })
  }), (error) => error.message === 'MIGRATION_JOURNAL_RECOVERY_FAILED');
  assert.equal(starts, 0);
  assert.equal(fs.readFileSync(first, 'utf8'), `${original}\n// external edit`);
});

test('test-support recovery rejects malformed protected OpenCode backups before state preparation or any writes', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'workflow-malformed-backup-prevalidation-'));
  const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const operationId = '550e8400-e29b-41d4-a716-446655440030';
  const statePath = path.join(dir, 'keys.json');
  const validConfig = Buffer.from('{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}');
  const malformedBackup = Buffer.from([0x7b, 0xc3, 0x28, 0x7d]);
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, '{}'); fs.writeFileSync(first, validConfig); fs.writeFileSync(second, validConfig);
  const stable = new SecureStore(statePath, adapter()); stable.persist({ keys: [], credentials: fakeCredentials });
  const stateBackup = `${statePath}.pre-migration.v1.${operationId}.bak`; fs.copyFileSync(statePath, stateBackup);
  const backups = [path.join(dir, `.opencode.json.nvgw-migration.${operationId}.bak`), path.join(dir, `.opencode.jsonc.nvgw-migration.${operationId}.bak`)];
  fs.writeFileSync(backups[0], malformedBackup); fs.writeFileSync(backups[1], validConfig);
  const lockOwner = { version: 1, operationId, instanceId: '550e8400-e29b-41d4-a716-446655440031', pid: 2147483647, lockPath: path.join(dir, `migration.${operationId}.550e8400-e29b-41d4-a716-446655440031.lock`) };
  fs.writeFileSync(lockOwner.lockPath, JSON.stringify(lockOwner));
  const journalState = {
    keys: [], credentials: fakeCredentials,
    migrationJournal: { version: 1, phase: 'opencode_backup_prepared', operationId, stateBackup, opencodeLock: lockOwner, opencodeBackups: backups, opencodeOriginalHashes: backups.map((file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')) }
  };
  let stateBackups = 0; let stateWrites = 0; let lifecycleStarts = 0; let configTemporaryOrReplacements = 0;
  const store = {
    initialize: () => stable.initialize(),
    createVersionedBackup: (...args) => { stateBackups++; return stable.createVersionedBackup(...args); },
    restoreVersionedBackup: (...args) => stable.restoreVersionedBackup(...args),
    persist: (value) => { stateWrites++; stable.persist(value); }
  };
  const before = { first: fs.readFileSync(first), second: fs.readFileSync(second), state: stable.initialize(), backups: backups.map((file) => fs.readFileSync(file)) };
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime: { configPath: config, statePath }, store, state: journalState, sourcePath: source, configPaths: [first, second],
    protectFile: (filePath) => { if (filePath === first || filePath === second || filePath.includes('.nvgw-migration.') || filePath.includes('.nvgw-rollback.')) configTemporaryOrReplacements++; },
    lifecycle: { startPrepared: async () => { lifecycleStarts++; return { state: 'running', port: 12004 }; }, stopPrepared: async () => {} },
    checkPorts: async () => ({ 12004: false, 12005: false })
  }), (error) => {
    assert.equal(error.message, 'MIGRATION_JOURNAL_RECOVERY_FAILED');
    assert.equal(error.message.includes(fakeCredentials.gatewayToken), false);
    assert.equal(error.message.includes(malformedBackup.toString('hex')), false);
    return true;
  });
  assert.equal(stateBackups, 0);
  assert.equal(lifecycleStarts, 0);
  assert.equal(stateWrites, 0);
  assert.equal(configTemporaryOrReplacements, 0);
  assert.deepEqual(fs.readFileSync(first), before.first); assert.deepEqual(fs.readFileSync(second), before.second);
  assert.deepEqual(stable.initialize(), before.state);
  assert.deepEqual(backups.map((file) => fs.readFileSync(file)), before.backups);
});

test('recovery prevalidation rejects every protected backup slot with internal BOM or missing migration targets before any work', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  const valid = Buffer.from(bomJsoncFixture());
  const invalidCases = [
    ['comment', Buffer.from(bomJsoncFixture().replace('// retain leading comment', '// retain\ufeff leading comment'))],
    ['string', Buffer.from(bomJsoncFixture().replace('old-target-token-placeholder', 'old\ufeff-target-token-placeholder'))],
    ['whitespace', Buffer.from(bomJsoncFixture().replace('\r\n{', '\r\n\ufeff{'))],
    ['missing-target', Buffer.from('{"provider":{"nvidia-gateway":{"options":{"apiKey":"old"}}}}')]
  ];
  for (const [kind, invalidBackup] of invalidCases) for (const slot of [0, 1]) {
    const dir = fs.mkdtempSync(path.join(tempRoot, `workflow-${kind}-slot-${slot}-prevalidation-`));
    const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const configPaths = [path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc')];
    const operationId = slot === 0 ? '550e8400-e29b-41d4-a716-446655440040' : '550e8400-e29b-41d4-a716-446655440041';
    const statePath = path.join(dir, 'keys.json');
    fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, '{}'); fs.writeFileSync(configPaths[0], valid); fs.writeFileSync(configPaths[1], valid);
    const stable = new SecureStore(statePath, adapter()); stable.persist({ keys: [], credentials: fakeCredentials });
    const stateBackup = `${statePath}.pre-migration.v1.${operationId}.bak`; fs.copyFileSync(statePath, stateBackup);
    const backups = configPaths.map((filePath) => path.join(dir, `.${path.basename(filePath)}.nvgw-migration.${operationId}.bak`));
    fs.writeFileSync(backups[0], slot === 0 ? invalidBackup : valid); fs.writeFileSync(backups[1], slot === 1 ? invalidBackup : valid);
    const lockOwner = { version: 1, operationId, instanceId: slot === 0 ? '550e8400-e29b-41d4-a716-446655440042' : '550e8400-e29b-41d4-a716-446655440043', pid: 2147483647, lockPath: path.join(dir, `migration.${operationId}.${slot === 0 ? '550e8400-e29b-41d4-a716-446655440042' : '550e8400-e29b-41d4-a716-446655440043'}.lock`) };
    fs.writeFileSync(lockOwner.lockPath, JSON.stringify(lockOwner));
    const journalState = { keys: [], credentials: fakeCredentials, migrationJournal: { version: 1, phase: 'opencode_backup_prepared', operationId, stateBackup, opencodeLock: lockOwner, opencodeBackups: backups, opencodeOriginalHashes: backups.map((file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')) } };
    let stateBackups = 0; let stateWrites = 0; let lifecycleStarts = 0; let portChecks = 0; let configTemporaryOrReplacements = 0;
    const store = { initialize: () => stable.initialize(), createVersionedBackup: (...args) => { stateBackups++; return stable.createVersionedBackup(...args); }, restoreVersionedBackup: (...args) => stable.restoreVersionedBackup(...args), persist: (value) => { stateWrites++; stable.persist(value); } };
    const before = { current: configPaths.map((file) => fs.readFileSync(file)), backups: backups.map((file) => fs.readFileSync(file)), state: stable.initialize() };
    await assert.rejects(() => runLegacyNvidiaMigrationForTests({
      runtime: { configPath: config, statePath }, store, state: journalState, sourcePath: source, configPaths,
      protectFile: (filePath) => { if (filePath === config || configPaths.includes(filePath) || filePath.includes('.nvgw-migration.') || filePath.includes('.nvgw-rollback.')) configTemporaryOrReplacements++; },
      lifecycle: { startPrepared: async () => { lifecycleStarts++; return { state: 'running', port: 12004 }; }, stopPrepared: async () => {} },
      checkPorts: async () => { portChecks++; return { 12004: false, 12005: false }; }
    }), (error) => {
      assert.equal(error.message, 'MIGRATION_JOURNAL_RECOVERY_FAILED', `${kind} slot ${slot}`);
      assert.equal(error.message.includes(fakeCredentials.gatewayToken), false);
      assert.equal(error.message.includes(invalidBackup.toString('hex')), false);
      return true;
    });
    assert.equal(stateBackups, 0, `${kind} slot ${slot} state preparation`);
    assert.equal(stateWrites, 0, `${kind} slot ${slot} state writes`);
    assert.equal(lifecycleStarts, 0, `${kind} slot ${slot} lifecycle`);
    assert.equal(portChecks, 0, `${kind} slot ${slot} port checks`);
    assert.equal(configTemporaryOrReplacements, 0, `${kind} slot ${slot} config work`);
    assert.deepEqual(configPaths.map((file) => fs.readFileSync(file)), before.current);
    assert.deepEqual(backups.map((file) => fs.readFileSync(file)), before.backups);
    assert.deepEqual(stable.initialize(), before.state);
  }
});

test('test-support recovery accepts BOM-valid protected backups and preserves normal valid recovery', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  for (const [name, original] of [['bom', Buffer.from(bomJsoncFixture())], ['normal', Buffer.from(bomJsoncFixture().slice(1))]]) {
    const dir = fs.mkdtempSync(path.join(tempRoot, `workflow-${name}-backup-recovery-`));
    const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
    const operationId = name === 'bom' ? '550e8400-e29b-41d4-a716-446655440032' : '550e8400-e29b-41d4-a716-446655440033';
    const statePath = path.join(dir, 'keys.json');
    fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, '{}'); fs.writeFileSync(first, original); fs.writeFileSync(second, original);
    const stable = new SecureStore(statePath, adapter()); stable.persist({ keys: [], credentials: fakeCredentials });
    const stateBackup = `${statePath}.pre-migration.v1.${operationId}.bak`; fs.copyFileSync(statePath, stateBackup);
    const backups = [path.join(dir, `.opencode.json.nvgw-migration.${operationId}.bak`), path.join(dir, `.opencode.jsonc.nvgw-migration.${operationId}.bak`)];
    fs.writeFileSync(backups[0], original); fs.writeFileSync(backups[1], original);
    const lockOwner = { version: 1, operationId, instanceId: name === 'bom' ? '550e8400-e29b-41d4-a716-446655440034' : '550e8400-e29b-41d4-a716-446655440035', pid: 2147483647, lockPath: path.join(dir, `migration.${operationId}.${name === 'bom' ? '550e8400-e29b-41d4-a716-446655440034' : '550e8400-e29b-41d4-a716-446655440035'}.lock`) };
    fs.writeFileSync(lockOwner.lockPath, JSON.stringify(lockOwner));
    const sourceFingerprint = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const state = { keys: [], credentials: fakeCredentials, legacyNvidiaMigration: { version: 1, sourceFingerprint, importedCount: 1, importedAt: '2026-08-01T00:00:00.000Z' }, migrationJournal: { version: 1, phase: 'opencode_backup_prepared', operationId, stateBackup, opencodeLock: lockOwner, opencodeBackups: backups, opencodeOriginalHashes: backups.map((file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')) } };
    let lifecycleStarts = 0;
    const result = await runLegacyNvidiaMigrationForTests({
      runtime: { configPath: config, statePath }, store: stable, state, protectFile: () => {}, sourcePath: source, configPaths: [first, second],
      lifecycle: { startPrepared: async () => { lifecycleStarts++; return { state: 'running', port: 12004 }; }, stopPrepared: async () => {} }, checkPorts: async () => ({ 12004: false, 12005: false })
    });
    assert.equal(result.code, 'ALREADY_MIGRATED');
    assert.equal(lifecycleStarts, 1);
    for (const filePath of [first, second]) assert.equal(fs.readFileSync(filePath, 'utf8').includes(fakeCredentials.gatewayToken), true, name);
    assert.deepEqual(backups.map((file) => fs.readFileSync(file)), [original, original]);
    if (name === 'bom') for (const filePath of [first, second]) assertLeadingUtf8Bom(fs.readFileSync(filePath, 'utf8'));
  }
});

test('production recovery prevalidation orchestrator rejects each virtual protected backup slot before state preparation', async () => {
  const { runRecoveryPrevalidationBeforeWork } = await import(built('final-migration-workflow.js'));
  const { validateOpenCodeConfigForMigration } = await import(built('opencode-config-migration-validation.js'));
  let statePreparations = 0;
  const invalidBackups = [
    Buffer.from(bomJsoncFixture().replace('// retain leading comment', '// retain\ufeff leading comment')),
    Buffer.from('{"provider":{"nvidia-gateway":{"options":{"apiKey":"old"}}}}')
  ];
  for (const slot of [0, 1]) for (const invalid of invalidBackups) {
    await assert.rejects(() => runRecoveryPrevalidationBeforeWork(
      () => [bomJsonFixture(), bomJsoncFixture()].map((source, index) => validateOpenCodeConfigForMigration(index === slot ? invalid : Buffer.from(source))),
      async () => { statePreparations++; }
    ), (error) => {
      assert.equal(error.message, 'MIGRATION_JOURNAL_RECOVERY_FAILED');
      assert.equal(error.message.includes(fakeCredentials.gatewayToken), false);
      assert.equal(error.message.includes(invalid.toString('hex')), false);
      return true;
    });
  }
  assert.equal(statePreparations, 0);
});

test('workflow propagates an OpenCode rollback race without overwriting the external edit and still restores state', async () => {
  const { runLegacyNvidiaMigrationForTests } = await import(testSupport('final-migration-test-entrypoint.js'));
  const { SecureStore } = await import(built('secure-state.js'));
  const dir = fs.mkdtempSync(path.join(tempRoot, 'workflow-opencode-rollback-concurrent-'));
  const source = path.join(dir, 'legacy.json'); const config = path.join(dir, 'config.json'); const first = path.join(dir, 'opencode.json'); const second = path.join(dir, 'opencode.jsonc');
  const original = '{"provider":{"nvidia-gateway":{"options":{"apiKey":"old","baseURL":"http://old"}}}}';
  const externalEdit = `${original}\n// external rollback edit`;
  fs.writeFileSync(source, JSON.stringify({ upstreams: [{ apiKey: fakeKey }] })); fs.writeFileSync(config, '{}'); fs.writeFileSync(first, original); fs.writeFileSync(second, original);
  const store = new SecureStore(path.join(dir, 'keys.json'), adapter()); store.persist({ keys: [], credentials: fakeCredentials });
  let injected = false; let stopped = 0;
  const protectFile = (filePath) => {
    if (!injected && filePath.includes('.nvgw-rollback.') && filePath.includes('opencode.json')) { injected = true; fs.writeFileSync(first, externalEdit); }
  };
  await assert.rejects(() => runLegacyNvidiaMigrationForTests({
    runtime: { configPath: config, statePath: path.join(dir, 'keys.json') }, store, state: store.initialize(), protectFile, sourcePath: source, configPaths: [first, second],
    lifecycle: { startPrepared: async () => ({ state: 'running', port: 12004 }), stopPrepared: async () => { stopped++; } }, checkPorts: async () => ({ 12004: false, 12005: false }), afterAppConfigWrite: () => { throw new Error('downstream failure'); }
  }), (error) => error.message === 'OPENCODE_CONFIG_CONCURRENT_MODIFICATION');
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(first, 'utf8'), externalEdit);
  assert.deepEqual(store.initialize(), { keys: [], credentials: fakeCredentials });
  assert.equal(stopped, 1);
});

test('main and shared redactors remove explicit gateway/admin/local credential names and exact in-memory values from status, journal and logs', async () => {
  const main = await import(built('redaction.js'));
  const shared = await import(pathToFileURL(path.join(root, 'src', 'shared', 'redaction.mjs')).href);
  const input = { gatewayToken: fakeCredentials.gatewayToken, adminToken: fakeCredentials.adminToken, localKey: fakeKey, nested: `failure ${fakeCredentials.gatewayToken} ${fakeCredentials.adminToken}` };
  const secrets = [fakeCredentials.gatewayToken, fakeCredentials.adminToken, fakeKey];
  main.setRuntimeSecrets(secrets);
  shared.setRuntimeSecrets(secrets);
  try {
    for (const output of [main.redact(input), shared.redact(input)]) {
      const text = JSON.stringify(output);
      assert.equal(text.includes(fakeCredentials.gatewayToken), false);
      assert.equal(text.includes(fakeCredentials.adminToken), false);
      assert.equal(text.includes(fakeKey), false);
    }
  } finally {
    main.setRuntimeSecrets([]);
    shared.setRuntimeSecrets([]);
  }
});

test('packaged gateway layout is self-contained inside app.asar after --dir packaging', async () => {
  // BEFORE: the engine shipped to resources/gateway, so this walked those .mjs
  // files and checked each relative import resolved on disk.
  // NOW: the engine ships INSIDE app.asar (ASAR integrity only covers the
  // archive), so the bytes are read from the archive and the invariant is
  // STRONGER — a bundled engine must have NO relative imports left to resolve.
  // Written as an assertion rather than an early return so the move cannot make
  // this test silently vacuous.
  const resources = path.join(root, 'dist', 'win-unpacked', 'resources');
  const archive = path.join(resources, 'app.asar');
  if (!fs.existsSync(archive)) return;
  const { extractFile, listPackage } = await import('@electron/asar');

  // @electron/asar addresses entries by the NATIVE separator on Windows, so the
  // raw form is kept for extractFile and only the ASSERTION is normalised to
  // posix. A posix path makes extractFile throw "was not found in this archive".
  const toPosix = (entry) => entry.replace(/\\/g, '/');
  const engine = listPackage(archive, {})
    .map((entry) => entry.replace(/^[\\/]+/, ''))
    .filter((entry) => toPosix(entry).startsWith('build/gateway/'));
  assert.deepEqual(engine.map(toPosix), ['build/gateway/server.mjs'], 'the engine must be a single archive entry');
  assert.equal(fs.existsSync(path.join(resources, 'gateway')), false, 'resources/gateway must be gone');

  const source = extractFile(archive, engine[0]).toString('utf8');
  const relativeImports = [...source.matchAll(/from\s*["'](\.{1,2}\/[^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(relativeImports, [], 'a bundled engine must carry no relative imports');
});
