import os from 'node:os';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
test('shipping source and direct compiled payload footprints exclude known credential literals without a scan race', async () => {
  const scanner = await import('../scripts/shipping-credential-scan.mjs');
  const result = scanner.runShippingCredentialScan({ root });
  assert.equal(result.testSupportExcluded, true);
  assertExpectedTypeScriptOutputsMatchBuild();
});

test('shipping credential scanner captures buffers, derives every builder payload root, and fails closed on a deterministic post-snapshot change', async () => {
  const scanner = await import('../scripts/shipping-credential-scan.mjs');
  const result = scanner.runShippingCredentialScan({ root });
  assert.equal(result.scannedFileCount > 0, true);
  // The engine ships as a prebuilt bundle (build/gateway), and src/shared is no
  // longer part of the payload — redaction.mjs is inlined into that bundle.
  assert.deepEqual(result.scannedRoots, [
    'build/src/main', 'build/src/preload', 'build/renderer', 'package.json',
    'build/gateway', 'build/assets'
  ]);
  assert.equal(result.testSupportExcluded, true);

  let afterSnapshot = false;
  assert.throws(() => scanner.runShippingCredentialScan({
    root,
    afterSnapshot: () => { afterSnapshot = true; },
    readFile: (file) => {
      const content = fs.readFileSync(file);
      return afterSnapshot && path.resolve(file) === path.join(root, 'package.json')
        ? Buffer.concat([content, Buffer.from('changed-after-snapshot')])
        : content;
    }
  }), /SHIPPING_CREDENTIAL_SCAN_CHANGED/);
});

test('lifecycle requires initial state before spawn, listener setup, or state persistence', async () => {
  const { GatewayLifecycle } = await import(built('gateway-lifecycle.js'));
  const runtimePaths = {
    configPath: path.join(os.tmpdir(), 'not-created-config.json'),
    statePath: path.join(os.tmpdir(), 'not-created-state.json'),
    ownerPath: path.join(os.tmpdir(), 'not-created-owner.json'),
    appLogPath: path.join(os.tmpdir(), 'not-created-app-log.jsonl'),
    stdioLogPath: path.join(os.tmpdir(), 'not-created-stdio-log.jsonl')
  };
  let spawnCalls = 0;
  let persistedStates = 0;

  assert.throws(() => new GatewayLifecycle({
    executablePath: process.execPath,
    serverPath: path.join(root, 'src', 'gateway', 'server.mjs'),
    runtimePaths,
    spawnChild: () => {
      spawnCalls += 1;
      throw new Error('spawn must not be called');
    },
    persistState: () => { persistedStates += 1; }
  }), /Gateway lifecycle state is invalid\./);

  assert.equal(spawnCalls, 0);
  assert.equal(persistedStates, 0);
  assert.equal(fs.existsSync(runtimePaths.ownerPath), false);
});

test('main and shared redactors remove runtime fixture secrets from output messages and stacks', async () => {
  const main = await import(built('redaction.js'));
  const shared = await import(pathToFileURL(path.join(root, 'src', 'shared', 'redaction.mjs')).href);
  const secret = 'runtime-fixture-credential-secret-123456789';
  const failure = new Error(`Gateway failed with ${secret}`);
  failure.stack = `Error: Gateway failed with ${secret}\n    at fixture (${secret})`;
  const input = { message: failure.message, stack: failure.stack, nested: `retry ${secret}` };

  main.setRuntimeSecrets([secret]);
  shared.setRuntimeSecrets([secret]);
  try {
    for (const output of [main.redact(input), shared.redact(input)]) {
      const text = JSON.stringify(output);
      assert.equal(text.includes(secret), false);
      assert.equal(output.message.includes(secret), false);
      assert.equal(output.stack.includes(secret), false);
    }
  } finally {
    main.setRuntimeSecrets([]);
    shared.setRuntimeSecrets([]);
  }
});

function collectScannedFiles(roots) {
  const files = [];
  for (const item of roots) {
    const file = path.join(root, item);
    const stat = fs.statSync(file);
    if (stat.isFile()) files.push(file);
    else visit(file);
  }
  return files;

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push(file);
    }
  }
}

function assertExpectedTypeScriptOutputsMatchBuild() {
  const configPath = path.join(root, 'tsconfig.node.json');
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, root, undefined, configPath);
  assert.equal(parsed.errors.length, 0, 'TypeScript configuration must be readable for compiled-footprint verification');
  const expectedOutputs = new Map();
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const emit = program.emit(undefined, (fileName, contents) => {
    if (fileName.endsWith('.js')) expectedOutputs.set(path.resolve(fileName), contents);
  });
  assert.equal(emit.emitSkipped, false, 'TypeScript production outputs must emit for compiled-footprint verification');
  for (const sourceRoot of ['src/main', 'src/preload']) {
    for (const sourceFile of collectScannedFiles([sourceRoot]).filter((file) => file.endsWith('.ts'))) {
      const compiledFile = path.resolve(path.join(root, 'build', path.relative(root, sourceFile).replace(/\.ts$/, '.js')));
      const expected = expectedOutputs.get(compiledFile);
      assert.equal(typeof expected, 'string', `compiler did not produce ${path.relative(root, compiledFile)} from ${path.relative(root, sourceFile)}`);
      assert.equal(fs.existsSync(compiledFile), true, `compiled module is absent for ${path.relative(root, sourceFile)}`);
      assert.equal(
        crypto.createHash('sha256').update(fs.readFileSync(compiledFile)).digest('hex'),
        crypto.createHash('sha256').update(expected).digest('hex'),
        `compiled module does not match current compiler output for ${path.relative(root, sourceFile)}`
      );
    }
  }
}
