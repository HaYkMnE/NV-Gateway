import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

// ───────────────────────────────────────────────────────────────────────────
// The packaging config must be loaded EXPLICITLY.
//
// Read out of the dependencies rather than assumed:
//
//   read-config-file/out/main.js:75-82
//     function getConfig(request, configPath) {
//       if (configPath == null) {
//         return loadConfig(request);                                  // implicit
//       } else {
//         return readConfig(path.resolve(request.projectDir, configPath), request);
//       }
//     }
//
//   read-config-file/out/main.js:71-72   (inside loadConfig)
//     const data = packageMetadata == null ? null : packageMetadata[request.packageKey];
//     return data == null ? findAndReadConfig(request) : { result: data, configFile: null };
//
//   app-builder-lib/out/packager.js:243-248
//     let configFromOptions = this.options.config;
//     if (typeof configFromOptions === "string") { configPath = configFromOptions; ... }
//
// So without --config, loadConfig runs and a top-level `build` field in
// package.json replaces the whole config before any file is opened — leaving
// electron-builder.yml, and every audit that inspects it, silently inert.
// Naming the file takes the readConfig branch, so that short-circuit and the
// sibling-extension walk are not merely detected, they are never reached.
//
// These assertions exist so a future edit of the wrapper cannot drop the flag
// quietly: removing it fails this file.
// ───────────────────────────────────────────────────────────────────────────

test('the packaging wrapper loads electron-builder.yml explicitly', async () => {
  const { buildElectronBuilderArgs, PACKAGING_CONFIG_FILE } = await import('../scripts/run-electron-builder.mjs');

  assert.equal(PACKAGING_CONFIG_FILE, 'electron-builder.yml');

  // Every real entry point must carry the explicit config. These are exactly the
  // argument lists package.json's scripts pass today.
  for (const [label, forwarded] of [
    ['package:dir', ['--dir']],
    ['build:portable', ['--win', 'portable']],
    ['build:release', ['--win', '--publish', 'never']],
    ['bare invocation', []]
  ]) {
    const args = buildElectronBuilderArgs(forwarded);
    const at = args.indexOf('--config');
    assert.ok(at >= 0, `${label} must pass --config`);
    assert.equal(args[at + 1], PACKAGING_CONFIG_FILE, `${label} must name ${PACKAGING_CONFIG_FILE}`);
    // The forwarded arguments must survive untouched and in order, or a target
    // like "--win portable" would silently change meaning.
    assert.deepEqual(args.slice(at + 2), forwarded, `${label} must forward its own arguments unchanged`);
  }

  // Exactly once, never duplicated: electron-builder would otherwise see two
  // config values and the effective one would depend on argument order.
  for (const forwarded of [[], ['--dir'], ['--win', 'portable']]) {
    const args = buildElectronBuilderArgs(forwarded);
    assert.equal(args.filter((value) => value === '--config').length, 1,
      'the config flag must be added exactly once');
  }

  // A caller who names a config keeps it — the flag is a default, not a lock —
  // and no second one is appended in any spelling.
  for (const forwarded of [
    ['--config', 'other.yml'],
    ['--config=other.yml'],
    ['-c', 'other.yml'],
    ['--dir', '--config', 'other.yml']
  ]) {
    const args = buildElectronBuilderArgs(forwarded);
    assert.deepEqual(args, forwarded, 'an explicit caller config must be preserved verbatim');
    const named = args.filter((value) =>
      value === '--config' || value === '-c' || value.startsWith('--config=') || value.startsWith('-c=')).length;
    assert.equal(named, 1, 'exactly one config must be named');
  }

  // Defensive shapes must not throw or invent arguments.
  assert.deepEqual(buildElectronBuilderArgs(), ['--config', 'electron-builder.yml']);
  assert.deepEqual(buildElectronBuilderArgs(null), ['--config', 'electron-builder.yml']);
});

test('the wrapper actually hands the explicit config to electron-builder', () => {
  // The builder above is only meaningful if its result reaches the spawn. Asserted
  // on the source so a refactor that computes the arguments and then forwards
  // process.argv anyway is caught.
  const source = fs.readFileSync(path.join(root, 'scripts', 'run-electron-builder.mjs'), 'utf8');

  assert.match(source, /buildElectronBuilderArgs\(process\.argv\.slice\(2\)\)/,
    'the wrapper must derive its arguments from buildElectronBuilderArgs');
  assert.match(source, /spawnSync\(\s*process\.execPath,\s*\[cli,\s*\.\.\.args\]/,
    'the spawn must forward the derived arguments, not raw argv');
  assert.equal(/spawnSync\(\s*process\.execPath,\s*\[cli,\s*\.\.\.process\.argv/.test(source), false,
    'the spawn must not bypass the derived arguments');

  // The file it names must exist, otherwise readConfig would fail the build.
  assert.equal(fs.existsSync(path.join(root, 'electron-builder.yml')), true,
    'the explicitly named config must exist');
});
