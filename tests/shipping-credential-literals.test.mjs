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

test('the packaging guard rejects every rule that could place the engine outside app.asar', async () => {
  // MEASURED HOLE this pins: with `asarUnpack: - build/gateway/**/*` the engine
  // ships to resources/app.asar.unpacked/build/gateway/server.mjs — a loose file
  // outside the ASAR integrity envelope, swappable without detection. The packaged
  // migration / gateway-link / credential smokes ALL still exited 0 on that layout;
  // only the dist-gated bundle-shipping test noticed, and it SKIPS in CI.
  //
  // This test is deliberately NOT dist-gated, so the guard is verified on the path
  // that actually runs in the ordinary Test Suite.
  const { assertArchiveEnvelopeIsSealed } = await import('../scripts/shipping-credential-scan.mjs');
  const realConfig = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');

  // POSITIVE CONTROL FIRST: the shipped config must pass, so this can never
  // degenerate into a permanently red assertion.
  assert.doesNotThrow(() => assertArchiveEnvelopeIsSealed(realConfig));

  const withPrefix = (text) => realConfig.replace(/^extraResources:/m, `${text}\nextraResources:`);
  // Replaces the whole win: block (header plus its indented body) so an injected
  // flow mapping stays valid YAML instead of orphaning the lines beneath it.
  const replacingWinBlock = (text) => realConfig.replace(/^win:\r?\n(?:[ \t]+.*\r?\n)*/m, text);

  // Any asarUnpack pattern is refused — the guard is absolute rather than
  // pattern-matching, because a matcher would have to out-guess electron-builder's
  // glob semantics and one missed form silently reopens the hole.
  for (const pattern of ['build/gateway/**/*', 'build/**', 'build/gateway/server.mjs']) {
    assert.throws(
      () => assertArchiveEnvelopeIsSealed(withPrefix(`asarUnpack:\n  - ${pattern}`)),
      /PACKAGING_ASAR_UNPACK_FORBIDDEN:asarUnpack/,
      `asarUnpack pattern must be refused: ${pattern}`
    );
  }
  // A leading `*` opens an ALIAS in YAML, so these can only appear QUOTED in a
  // real config. Quoted is therefore the honest fixture, and it proves they are
  // caught as unpack RULES rather than merely as a syntax error.
  for (const pattern of ['**/*.mjs', '**/gateway/**', '**']) {
    assert.throws(
      () => assertArchiveEnvelopeIsSealed(withPrefix(`asarUnpack:\n  - "${pattern}"`)),
      /PACKAGING_ASAR_UNPACK_FORBIDDEN:asarUnpack/,
      `quoted asarUnpack pattern must be refused: ${pattern}`
    );
    // Unquoted the document is invalid YAML; the guard must still refuse it
    // (fail closed) rather than read an unparseable file as "nothing forbidden".
    assert.throws(
      () => assertArchiveEnvelopeIsSealed(withPrefix(`asarUnpack:\n  - ${pattern}`)),
      /PACKAGING_(ASAR_UNPACK_FORBIDDEN|CONFIG_UNPARSEABLE)/,
      `bare asarUnpack pattern must still be refused: ${pattern}`
    );
  }

  // Nested placement counts too: asarUnpack is valid inside the platform blocks.
  assert.throws(
    () => assertArchiveEnvelopeIsSealed(realConfig.replace(/^win:\r?\n/m, 'win:\n  asarUnpack:\n    - build/gateway/**/*\n')),
    /PACKAGING_ASAR_UNPACK_FORBIDDEN:asarUnpack/,
    'a rule nested under win: must be refused as well'
  );
  assert.throws(
    () => assertArchiveEnvelopeIsSealed(withPrefix("asarUnpack: ['build/gateway/**/*']")),
    /PACKAGING_ASAR_UNPACK_FORBIDDEN:asarUnpack/,
    'the inline array form must be refused'
  );
  assert.throws(
    () => assertArchiveEnvelopeIsSealed(withPrefix('asarUnpacked:\n  - build/gateway/**/*')),
    /PACKAGING_ASAR_UNPACK_FORBIDDEN:asarUnpacked/,
    'the legacy asarUnpacked spelling must be refused'
  );

  // THE SIX SPELLINGS A LINE MATCHER MISSED. The previous implementation tested
  // `^\s*asarUnpack\s*:` per line, so it only ever saw an unquoted block key.
  // js-yaml — the parser electron-builder reads the config with — resolves all of
  // these to the same forbidden key, so the guard must too.
  assert.throws(
    () => assertArchiveEnvelopeIsSealed(withPrefix('"asarUnpack": ["build/gateway/**/*"]')),
    /PACKAGING_ASAR_UNPACK_FORBIDDEN:asarUnpack/,
    'a double-quoted key must be refused'
  );
  assert.throws(
    () => assertArchiveEnvelopeIsSealed(withPrefix("'asarUnpack': ['build/gateway/**/*']")),
    /PACKAGING_ASAR_UNPACK_FORBIDDEN:asarUnpack/,
    'a single-quoted key must be refused'
  );
  assert.throws(
    () => assertArchiveEnvelopeIsSealed(withPrefix('? asarUnpack\n: ["build/gateway/**/*"]')),
    /PACKAGING_ASAR_UNPACK_FORBIDDEN:asarUnpack/,
    'the explicit-key syntax must be refused'
  );
  assert.throws(
    () => assertArchiveEnvelopeIsSealed(replacingWinBlock('win: {icon: build/assets/icon.png, asarUnpack: ["build/gateway/**/*"]}\n')),
    /PACKAGING_ASAR_UNPACK_FORBIDDEN:asarUnpack/,
    'a flow mapping must be refused'
  );
  assert.throws(
    () => assertArchiveEnvelopeIsSealed(realConfig.replace(/^win:\r?\n/m, 'win:\n  "asarUnpack":\n    - build/gateway/**/*\n')),
    /PACKAGING_ASAR_UNPACK_FORBIDDEN:asarUnpack/,
    'a quoted key nested under win: must be refused'
  );
  assert.throws(
    () => assertArchiveEnvelopeIsSealed(withPrefix('"asar": false')),
    /PACKAGING_ASAR_MUST_STAY_ENABLED/,
    'a quoted asar key must be refused'
  );

  // ANCHOR + ALIAS with a merge key: structurally unreachable for a line matcher,
  // and the clearest demonstration of why parsing beats text matching.
  assert.throws(
    () => assertArchiveEnvelopeIsSealed(replacingWinBlock([
      '.engineUnpack: &engineUnpack',
      '  asarUnpack:',
      '    - build/gateway/**/*',
      'win:',
      '  <<: *engineUnpack',
      '  icon: build/assets/icon.png',
      ''
    ].join('\n'))),
    /PACKAGING_ASAR_UNPACK_FORBIDDEN:asarUnpack/,
    'a merge key pulling in an anchored rule must be refused'
  );
  assert.throws(
    () => assertArchiveEnvelopeIsSealed(replacingWinBlock([
      '.engineUnpack: &engineUnpack',
      '  - build/gateway/**/*',
      'win:',
      '  asarUnpack: *engineUnpack',
      '  icon: build/assets/icon.png',
      ''
    ].join('\n'))),
    /PACKAGING_ASAR_UNPACK_FORBIDDEN:asarUnpack/,
    'an alias supplying the value must be refused'
  );

  // SECOND VECTOR: `asar` and `asarUnpack` are the only asar keys in the
  // app-builder-lib schema, and disabling archiving ships everything loose.
  // js-yaml 4 keeps no/off/0 as STRINGS rather than booleans, so strict equality
  // to `true` is what collapses the whole truthiness zoo into one rejected case.
  for (const value of ['false', 'False', '"false"', "'false'", 'FALSE', 'no', 'off', '0']) {
    assert.throws(
      () => assertArchiveEnvelopeIsSealed(withPrefix(`asar: ${value}`)),
      /PACKAGING_ASAR_MUST_STAY_ENABLED/,
      `archiving must not be disabled: asar: ${value}`
    );
  }
  // An AsarOptions mapping is refused as well: options such as smartUnpack unpack
  // files, so only the literal `true` is accepted.
  assert.throws(
    () => assertArchiveEnvelopeIsSealed(withPrefix('asar:\n  smartUnpack: true')),
    /PACKAGING_ASAR_MUST_STAY_ENABLED/,
    'an asar options mapping must be refused'
  );
  assert.doesNotThrow(() => assertArchiveEnvelopeIsSealed(withPrefix('asar: true')));

  // FAIL CLOSED: a document that cannot be parsed, or is not a mapping at all,
  // must never be mistaken for "no forbidden keys present".
  assert.throws(
    () => assertArchiveEnvelopeIsSealed('files:\n  - a\n  bad: [unclosed'),
    /PACKAGING_CONFIG_UNPARSEABLE/,
    'an unparseable config must be refused'
  );
  assert.throws(
    () => assertArchiveEnvelopeIsSealed('- just\n- a\n- list'),
    /PACKAGING_CONFIG_NOT_A_MAPPING/,
    'a non-mapping document must be refused'
  );

  // A comment documenting the invariant must not trip the guard on its own prose
  // (the parser discards comments, so this holds for free) — while a quoted value
  // that merely CONTAINS '#' is still a real rule and must be refused.
  assert.doesNotThrow(() => assertArchiveEnvelopeIsSealed(
    withPrefix('# asarUnpack would put the engine outside app.asar')
  ));
  assert.throws(
    () => assertArchiveEnvelopeIsSealed(withPrefix('asarUnpack:\n  - "build/#gateway/**/*"')),
    /PACKAGING_ASAR_UNPACK_FORBIDDEN:asarUnpack/,
    'a quoted value containing # is a rule, not a comment'
  );

  // The message must tell whoever hits this WHERE to go and WHAT the legitimate
  // case looks like, not just name the broken rule.
  assert.throws(
    () => assertArchiveEnvelopeIsSealed(withPrefix('asarUnpack:\n  - build/gateway/**/*')),
    (error) => /shipping-credential-scan\.mjs/.test(error.message)
      && /\.node/.test(error.message)
      && /targeted test/.test(error.message),
    'the failure must point at the guard and describe the legitimate exception'
  );
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
