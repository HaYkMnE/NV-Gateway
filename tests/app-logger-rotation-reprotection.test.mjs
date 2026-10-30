// app-logger.ts: the ACTIVE log after a rotation.
//
// THE DEFECT. rotateIfNeeded() renames the active file to generation 1 and
// re-applies protectFile() to the ROTATED target, but the append that follows
// re-creates the active path with the process DEFAULT mode and no ACL call. The
// rotated generations stay protected; the file the app keeps writing to does
// not. initAppLogger protects the path once at startup — the rotation then
// moves that protected inode out from under the path, and nothing re-applies
// either protection to the re-created file.
//
// MEASURED on Windows: fs.statSync().mode does NOT reflect a 0o600 open() here
// (this machine reports 0o666 for both openSync(path, "a", 0o600) and a plain
// appendFileSync), so the cross-platform observable pinned below is the ACL
// callback — the protectFile(filePath) hook initAppLogger is handed, which is
// what actually hardens the file on the supported platform. The 0o600 open is
// pinned by source inspection in the same test so the mode half cannot rot.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const MAX_FILE_SIZE = 5 * 1024 * 1024;

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-app-logger-rot-${process.pid}-`));
  return { directory, logFile: path.join(directory, 'app.jsonl') };
}

test('rotation re-protects the re-created ACTIVE log and opens it 0o600', async () => {
  const logger = await import(built('app-logger.js'));
  const { directory, logFile } = fixture();
  const protectedPaths = [];
  try {
    logger.initAppLogger(logFile, (filePath) => protectedPaths.push(path.resolve(filePath)));
    assert.deepEqual(protectedPaths, [path.resolve(logFile)], 'init must protect the active log');
    protectedPaths.length = 0;

    // Exactly at the cap: rotateIfNeeded() rotates when size is NOT < MAX_FILE_SIZE.
    fs.writeFileSync(logFile, 'x'.repeat(MAX_FILE_SIZE), 'utf8');
    logger.logAppEvent('info', 'rotation-trigger');

    const rotated = path.join(directory, 'app.1.jsonl');
    assert.equal(fs.existsSync(rotated), true, 'the over-cap active log must rotate to generation 1');
    assert.equal(fs.existsSync(logFile), true, 'the append must re-create the active log');
    assert.match(fs.readFileSync(logFile, 'utf8'), /rotation-trigger/, 'the appended entry must land in the re-created active log');
    assert.deepEqual(
      protectedPaths,
      [path.resolve(rotated), path.resolve(logFile)],
      'both the rotated generation AND the re-created ACTIVE log must be protected'
    );

    // The mode half of the fix: the re-creation must use the same 0o600 open as
    // initAppLogger, not the process default appendFileSync would apply.
    const source = fs.readFileSync(path.join(root, 'src', 'main', 'app-logger.ts'), 'utf8');
    const rotation = source.slice(source.indexOf('function rotateIfNeeded'), source.indexOf('export function logAppEvent'));
    assert.match(rotation, /openSync\(filePath, "a", 0o600\)/, 'the re-created active log must be opened 0o600');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a below-cap append neither rotates nor re-protects the active log', async () => {
  const logger = await import(built('app-logger.js'));
  const { directory, logFile } = fixture();
  const protectedPaths = [];
  try {
    logger.initAppLogger(logFile, (filePath) => protectedPaths.push(path.resolve(filePath)));
    protectedPaths.length = 0;

    logger.logAppEvent('info', 'no-rotation');

    assert.deepEqual(protectedPaths, [], 'nothing rotated, so nothing may be re-protected');
    assert.equal(fs.existsSync(path.join(directory, 'app.1.jsonl')), false, 'no generation may appear below the cap');
    assert.match(fs.readFileSync(logFile, 'utf8'), /no-rotation/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a throwing protector during rotation never escapes the logger and the entry still lands', async () => {
  const logger = await import(built('app-logger.js'));
  const { directory, logFile } = fixture();
  let calls = 0;
  try {
    // Call 1 is initAppLogger's own protection. Everything after it fails: a
    // real protector degrades to a warning, but a logger must stay best-effort
    // even against an injected throw.
    logger.initAppLogger(logFile, () => {
      calls += 1;
      if (calls > 1) throw new Error('ACL degraded');
    });

    fs.writeFileSync(logFile, 'x'.repeat(MAX_FILE_SIZE), 'utf8');
    assert.doesNotThrow(() => logger.logAppEvent('info', 'resilient-rotation'));

    assert.equal(fs.existsSync(path.join(directory, 'app.1.jsonl')), true, 'the rename itself must have happened');
    assert.match(fs.readFileSync(logFile, 'utf8'), /resilient-rotation/, 'the append must survive a failing protector');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('F3: when protectFile on the ROTATED target throws, the re-created ACTIVE log is STILL re-protected', async () => {
  // Two audits independently identified this surviving hole: the re-protection
  // ran ONLY inside `if (activeRotated)`, but activeRotated is set AFTER
  // protectFile(newPath) runs on the same line
  // (`fs.renameSync(...); if (i === 1) activeRotated = true; protectFile(newPath);`).
  // A protectFile that throws on the rotated target is swallowed with the rest
  // of the line, so activeRotated stays false — yet the active file was already
  // renamed away, and the append re-creates it UNPROTECTED and at the default
  // mode. The fix guards on `activeRotated || !fs.existsSync(filePath)`.
  const logger = await import(built('app-logger.js'));
  const { directory, logFile } = fixture();
  const protectedPaths = [];
  try {
    logger.initAppLogger(logFile, (filePath) => {
      // Throw ONLY for the rotated generation (app.1.jsonl) — initAppLogger's
      // own protection of the active path is not guarded, so throwing there
      // would abort initialization rather than exercise rotation.
      if (path.basename(filePath) === 'app.1.jsonl') throw new Error('protect(rotated) rejected by AV handle');
      protectedPaths.push(path.resolve(filePath));
    });
    protectedPaths.length = 0;

    fs.writeFileSync(logFile, 'x'.repeat(MAX_FILE_SIZE), 'utf8');
    assert.doesNotThrow(() => logger.logAppEvent('info', 'rotation-after-protector-throw'));

    assert.equal(fs.existsSync(path.join(directory, 'app.1.jsonl')), true, 'the rename must still have happened');
    assert.match(fs.readFileSync(logFile, 'utf8'), /rotation-after-protector-throw/, 'the append must land');
    assert.ok(protectedPaths.includes(path.resolve(logFile)),
      'the re-created ACTIVE log MUST be protected even when the rotated-target protect threw');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('F3: an abort DURING the rotation loop still re-protects the active log on the next append', async () => {
  // Companion to the rotated-target-throw case: the hole is that the
  // re-protection was reachable ONLY through `if (activeRotated)`. When the
  // active file has already been renamed away but the flag never got set, the
  // NEXT append must not leave a re-created, unprotected active file behind.
  // Here the rotated-target protect throws while the active file exists, then
  // the file is deleted before the append, so the active path is genuinely
  // missing when rotateIfNeeded() runs — the existence guard is the only thing
  // that can protect the re-created file.
  const logger = await import(built('app-logger.js'));
  const { directory, logFile } = fixture();
  const protectedPaths = [];
  try {
    logger.initAppLogger(logFile, (filePath) => {
      if (path.basename(filePath) === 'app.1.jsonl') throw new Error('protect(rotated) rejected by AV handle');
      protectedPaths.push(path.resolve(filePath));
    });
    protectedPaths.length = 0;

    // Rotate once (protect on the rotated target throws, swallowed).
    fs.writeFileSync(logFile, 'x'.repeat(MAX_FILE_SIZE), 'utf8');
    logger.logAppEvent('info', 'first-rotation');
    assert.equal(protectedPaths.includes(path.resolve(logFile)), true,
      'the FIRST rotation must already have re-protected the active log');

    // Now delete the active log and append again: it must be re-created AND
    // protected (the existence guard), with no rotation involved.
    protectedPaths.length = 0;
    fs.rmSync(logFile, { force: true });
    logger.logAppEvent('info', 'recreated-after-delete');

    assert.equal(fs.existsSync(logFile), true, 'the append must re-create the vanished active log');
    assert.match(fs.readFileSync(logFile, 'utf8'), /recreated-after-delete/);
    assert.ok(protectedPaths.includes(path.resolve(logFile)),
      'a re-created active log must be protected even without a rotation');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
