// gateway-lifecycle.ts: the ACTIVE stdio log after a rotation.
//
// THE DEFECT. rotateStdioLogIfNeeded() renames the active file to generation 1
// and re-applies protectFile() to the ROTATED target, but the append that
// follows (~:546, fs.appendFileSync) re-creates the active path with the process
// DEFAULT mode and no ACL call. The rotated generations stay protected; the file
// the app keeps writing to does not. The constructor (:134-135) protects the
// path once at startup with a 0o600 open — the rotation then moves that
// protected inode out from under the path, and nothing re-applies either
// protection to the re-created file.
//
// MEASURED on Windows: fs.statSync().mode does NOT reflect a 0o600 open() here
// (this machine reports 0o666 for both openSync(path, "a", 0o600) and a plain
// appendFileSync), so the cross-platform observable pinned below is the ACL
// callback — the protectFile(filePath) hook the constructor is handed, which is
// what actually hardens the file on the supported platform. The 0o600 open is
// pinned by source inspection in the same test so the mode half cannot rot.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { ensureGatewayRuntime } from '../build/src/main/gateway-runtime.js';
import { reservePortPair } from './support/paired-port-allocation.mjs';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const MAX_STDIO_FILE_SIZE = 5 * 1024 * 1024;

/** Reserve a genuinely free paired port so preflight never short-circuits before spawn. */
async function freePort() {
  const reservation = await reservePortPair({
    candidatePorts: Array.from({ length: 200 }, (_, offset) => 40000 + ((process.pid + offset) % 25000))
  });
  return reservation;
}

/** A minimal ChildProcess stand-in that only needs to emit stdout data. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-stdio-rot-${process.pid}-`));
  return { directory, logFile: path.join(directory, 'gateway-stdio.jsonl') };
}

async function createLifecycle(logFile, protectFile, port, child) {
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const runtime = ensureGatewayRuntime(path.join(path.dirname(logFile), 'runtime'));
  const instance = new GatewayLifecycle({
    executablePath: process.execPath,
    serverPath: path.join(root, 'src', 'gateway', 'server.mjs'),
    runtimePaths: runtime,
    spawnChild: () => {
      // captureOutput() attaches stdout listeners synchronously right after
      // this returns; a setImmediate emission lands after they are attached.
      setImmediate(() => child.stdout.emit('data', Buffer.from('rotation-trigger')));
      return child;
    },
    stdioLogPath: logFile,
    initialState: { keys: [], credentials: { gatewayToken: 'fixture-gateway-token', adminToken: 'fixture-admin-token' } },
    persistState: () => {},
    startupTimeoutMs: 50,
    healthPollIntervalMs: 5,
    protectFile
  });
  return instance;
}

test('rotation re-protects the re-created ACTIVE stdio log and opens it 0o600', async () => {
  const { directory, logFile } = fixture();
  const protectedPaths = [];
  const reservation = await freePort();
  try {
    const child = fakeChild();
    const instance = await createLifecycle(logFile, (filePath) => protectedPaths.push(path.resolve(filePath)), reservation.port, child);
    assert.deepEqual(protectedPaths, [path.resolve(logFile)], 'construction must protect the active stdio log');
    protectedPaths.length = 0;

    // Exactly at the cap: rotateStdioLogIfNeeded() rotates when size is NOT < MAX_STDIO_FILE_SIZE.
    fs.writeFileSync(logFile, 'x'.repeat(MAX_STDIO_FILE_SIZE), 'utf8');
    // startInternal spawns (attaching stdout capture) before health polling;
    // the spawned child's setImmediate emission drives the append + rotation.
    await instance.start(reservation.port);

    const rotated = path.join(directory, 'gateway-stdio.1.jsonl');
    assert.equal(fs.existsSync(rotated), true, 'the over-cap active log must rotate to generation 1');
    assert.equal(fs.existsSync(logFile), true, 'the append must re-create the active log');
    assert.match(fs.readFileSync(logFile, 'utf8'), /rotation-trigger/, 'the appended entry must land in the re-created active log');
    assert.deepEqual(
      protectedPaths,
      [path.resolve(rotated), path.resolve(logFile)],
      'both the rotated generation AND the re-created ACTIVE log must be protected'
    );

    // The mode half of the fix: the re-creation must use the same 0o600 open as
    // the constructor, not the process default appendFileSync would apply.
    const source = fs.readFileSync(path.join(root, 'src', 'main', 'gateway-lifecycle.ts'), 'utf8');
    const rotation = source.slice(source.indexOf('private rotateStdioLogIfNeeded'), source.indexOf('private async waitForHealthOrFailure'));
    assert.match(rotation, /openSync\(this\.stdioLogPath, "a", 0o600\)/, 'the re-created active stdio log must be opened 0o600');
  } finally {
    await reservation.release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('F3: a missing active stdio log is re-created 0o600 + protected by the next append', async () => {
  // Companion to the app-logger F3 test. A stdio log deleted out from under the
  // lifecycle (external cleanup, a failed rename) must not be silently
  // re-created unprotected: rotateStdioLogIfNeeded sees the missing file and
  // re-protects the path before the append recreates it.
  const { directory, logFile } = fixture();
  const protectedPaths = [];
  const reservation = await freePort();
  try {
    const child = fakeChild();
    const instance = await createLifecycle(logFile, (filePath) => protectedPaths.push(path.resolve(filePath)), reservation.port, child);
    assert.deepEqual(protectedPaths, [path.resolve(logFile)], 'construction must protect the active stdio log');
    protectedPaths.length = 0;

    // Vanished active log; the spawned child's stdout emission drives the append.
    fs.rmSync(logFile, { force: true });
    await instance.start(reservation.port);

    assert.equal(fs.existsSync(logFile), true, 'the append must re-create the missing active stdio log');
    assert.match(fs.readFileSync(logFile, 'utf8'), /rotation-trigger/);
    assert.deepEqual(
      protectedPaths,
      [path.resolve(logFile)],
      'the re-created ACTIVE stdio log must be protected'
    );
  } finally {
    await reservation.release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a below-cap append neither rotates nor re-protects the active stdio log', async () => {
  const { directory, logFile } = fixture();
  const protectedPaths = [];
  const reservation = await freePort();
  try {
    const child = fakeChild();
    const instance = await createLifecycle(logFile, (filePath) => protectedPaths.push(path.resolve(filePath)), reservation.port, child);
    protectedPaths.length = 0;

    await instance.start(reservation.port);

    assert.deepEqual(protectedPaths, [], 'nothing rotated, so nothing may be re-protected');
    assert.equal(fs.existsSync(path.join(directory, 'gateway-stdio.1.jsonl')), false, 'no generation may appear below the cap');
    assert.match(fs.readFileSync(logFile, 'utf8'), /rotation-trigger/);
  } finally {
    await reservation.release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
