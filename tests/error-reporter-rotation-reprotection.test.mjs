// error-reporter.ts: the ACTIVE errors.log after a rotation, and the PRODUCTION
// wiring that arms the protector in the first place.
//
// THE DEFECTS.
//
// (1) WIRING. index.ts's only `initErrorReporter(...)` call site passed NOTHING,
//     so error-reporter's `init(protect = () => {})` default made every
//     protectFile call in the module a no-op in production. MEASURED against
//     the real compiled module: `init()` -> protectCalls 0; `init(realProtector)`
//     -> protectCalls 1 with calledPaths ["<dir>\\logs\\errors.log"].
//
// (2) ROTATION GAP. rotateIfNeeded() renamed the (protected) active log away and
//     the following append re-created it with the process default mode and no
//     ACL call — the same class already fixed in app-logger.ts. MEASURED against
//     the real compiled module with a recording protector: 0 protect calls
//     during a rotation, and the re-created active errors.log was left
//     unprotected while the rotated generation kept its ACL.
//
// The module must be transpiled into a scratch dir with an electron stub because
// it requires("electron"), same harness shape as
// tests/error-reporter-rotation-obstructed.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const scratchBase = process.env.NV_TEST_SCRATCH || os.tmpdir();
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MODULES = ['redaction', 'report-sanitizer', 'reports-endpoint', 'error-reporter'];

const scratchDirs = [];

/**
 * Transpile error-reporter (+ its imports) into a throwaway dir, wire the
 * `electron` require to a stub whose userData lives inside it, optionally lower
 * the rotation cap, and return a freshly-loaded module with a recording
 * protector already armed.
 */
function harness({ cap } = {}) {
  fs.mkdirSync(scratchBase, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratchBase, 'nv-error-rot-protect-'));
  scratchDirs.push(dir);
  const outDir = path.join(dir, 'main');
  const userData = path.join(dir, 'userData');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });

  const require_ = createRequire(import.meta.url);
  const ts = require_(path.join(root, 'node_modules', 'typescript', 'lib', 'typescript.js'));

  for (const name of MODULES) {
    const source = fs.readFileSync(path.join(root, 'src', 'main', `${name}.ts`), 'utf8');
    let js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    if (name === 'error-reporter') {
      let before = js;
      js = js.replace('require("electron")', 'require("./electron-stub")');
      assert.notEqual(js, before, 'electron stub rewrite did not apply');
      if (cap !== undefined) {
        before = js;
        js = js.replace(/const MAX_LOG_SIZE = [^;]+;/, `const MAX_LOG_SIZE = ${cap};`);
        assert.notEqual(js, before, 'cap-lowering patch did not apply: this test would measure nothing');
      }
    }
    fs.writeFileSync(path.join(outDir, `${name}.js`), js, 'utf8');
  }
  fs.writeFileSync(
    path.join(outDir, 'electron-stub.js'),
    `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' } };\n`,
    'utf8'
  );

  const load = createRequire(path.join(outDir, 'anchor.js'));
  const reporter = load('./error-reporter.js');
  const protectedPaths = [];
  reporter.init((filePath) => protectedPaths.push(path.resolve(filePath)));
  return {
    reporter,
    protectedPaths,
    logsDir: path.join(userData, 'logs'),
    logFile: path.join(userData, 'logs', 'errors.log'),
    rotatedPath: (index) => path.join(userData, 'logs', `errors.${index}.log`)
  };
}

test('init(protector) arms the module; the production call site must pass a real protector', () => {
  // RUNTIME half: against the real compiled module, init(protector) records the
  // ACTIVE errors.log — the difference the wiring fix makes observable. Without
  // the argument the module's no-op default records nothing, which is the state
  // production was silently in (index.ts passed no argument).
  const armed = harness();
  assert.deepEqual(
    armed.protectedPaths,
    [path.resolve(armed.logFile)],
    'init(protector) must protect the ACTIVE errors.log exactly once'
  );

  // SOURCE half: the production call site in index.ts must pass an argument.
  const source = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
  const calls = [...source.matchAll(/initErrorReporter\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.equal(calls.length >= 1, true, 'index.ts must contain an initErrorReporter call');
  for (const argument of calls) {
    assert.notEqual(argument, '', 'every production initErrorReporter() call must pass a real protector, not the no-op default');
  }
  assert.match(source, /initErrorReporter\(createRuntimeAclProtector\(\)\.protectFile\)/,
    'the production call site must pass the same protector form as its sibling call sites');
});

test('rotation re-protects BOTH the rotated generation and the re-created ACTIVE errors.log', () => {
  const h = harness({ cap: 65_536 });
  // init() protected the active path once; start the rotation assertions clean.
  h.protectedPaths.length = 0;
  // Exactly at the cap so rotateIfNeeded() rotates (it rotates when size is NOT < cap).
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'gateway', message: 'filler', stack: 'z'.repeat(2_000), source: 'm' })}\n`;
  fs.writeFileSync(h.logFile, line.repeat(Math.ceil((65_536 + 1_024) / line.length)), 'utf8');

  h.reporter.logError({ type: 'gateway', message: 'after-rotation', source: 'm' });

  assert.equal(fs.existsSync(h.rotatedPath(1)), true, 'the over-cap active log must rotate to generation 1');
  assert.equal(fs.existsSync(h.logFile), true, 'the append must re-create the active log');
  assert.match(fs.readFileSync(h.logFile, 'utf8'), /after-rotation/, 'the appended entry must land in the re-created active log');
  assert.deepEqual(
    h.protectedPaths,
    [path.resolve(h.rotatedPath(1)), path.resolve(h.logFile)],
    'both the rotated generation AND the re-created ACTIVE log must be protected'
  );

  // The mode half of the fix, pinned by source inspection (as app-logger does):
  // Windows statSync().mode does not reflect a 0o600 open() here.
  const source = fs.readFileSync(path.join(root, 'src', 'main', 'error-reporter.ts'), 'utf8');
  const rotation = source.slice(source.indexOf('function rotateIfNeeded'), source.indexOf('// ---- Suppression state'));
  assert.match(rotation, /openSync\(file, "a", 0o600\)/, 'the re-created active log must be opened 0o600');
});

test('a MISSING active errors.log is re-created 0o600 and protected on the next append', () => {
  const h = harness({ cap: 65_536 });
  h.reporter.logError({ type: 'gateway', message: 'first', source: 'm' });
  h.protectedPaths.length = 0;
  fs.rmSync(h.logFile, { force: true });
  h.reporter.logError({ type: 'gateway', message: 'recreated-after-delete', source: 'm' });

  assert.equal(fs.existsSync(h.logFile), true, 'the append must re-create the vanished active log');
  assert.match(fs.readFileSync(h.logFile, 'utf8'), /recreated-after-delete/);
  assert.ok(h.protectedPaths.includes(path.resolve(h.logFile)),
    'a re-created active log must be protected even without a rotation');
});

test('a throwing protector during rotation never escapes and the entry still lands', () => {
  // A logger must stay best-effort even against an injected protector throw. The
  // harness below arms a protector that throws on every call AFTER init()'s own
  // protection, which is exactly the "ACL degraded" case the module documents.
  fs.mkdirSync(scratchBase, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratchBase, 'nv-error-rot-throw-'));
  scratchDirs.push(dir);
  const outDir = path.join(dir, 'main');
  const userData = path.join(dir, 'userData');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  const require_ = createRequire(import.meta.url);
  const ts = require_(path.join(root, 'node_modules', 'typescript', 'lib', 'typescript.js'));
  for (const name of MODULES) {
    const source = fs.readFileSync(path.join(root, 'src', 'main', `${name}.ts`), 'utf8');
    let js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    if (name === 'error-reporter') {
      let before = js;
      js = js.replace('require("electron")', 'require("./electron-stub")');
      assert.notEqual(js, before, 'electron stub rewrite did not apply');
      before = js;
      js = js.replace(/const MAX_LOG_SIZE = [^;]+;/, 'const MAX_LOG_SIZE = 65536;');
      assert.notEqual(js, before, 'cap-lowering patch did not apply');
    }
    fs.writeFileSync(path.join(outDir, `${name}.js`), js, 'utf8');
  }
  fs.writeFileSync(path.join(outDir, 'electron-stub.js'),
    `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.0.0' } };\n`, 'utf8');
  const load = createRequire(path.join(outDir, 'anchor.js'));
  const reporter = load('./error-reporter.js');
  let calls = 0;
  reporter.init(() => { calls += 1; if (calls > 1) throw new Error('ACL degraded'); });

  const logFile = path.join(userData, 'logs', 'errors.log');
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'gateway', message: 'filler', stack: 'z'.repeat(2_000), source: 'm' })}\n`;
  fs.writeFileSync(logFile, line.repeat(Math.ceil((65_536 + 1_024) / line.length)), 'utf8');

  assert.doesNotThrow(() => reporter.logError({ type: 'gateway', message: 'resilient-rotation', source: 'm' }));
  assert.match(fs.readFileSync(logFile, 'utf8'), /resilient-rotation/, 'the append must survive a failing protector');
  assert.equal(fs.existsSync(path.join(userData, 'logs', 'errors.1.log')), true, 'the rename itself must have happened');
});

test.after(() => {
  for (const dir of scratchDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
