import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';

const FORBIDDEN_ASAR_IDENTIFIERS = [
  'runLegacyNvidiaMigrationForTests', 'prepareLegacyNvidiaMigrationForTests',
  'migrateLegacyNvidiaForTests', 'readStrictLegacySourceForTests',
  'TestMigrationWorkflowOptions', 'afterAppConfigWrite', 'sourcePath',
  'configPaths', 'test-support'
];

export async function runPackagedMigrationSmoke({ root = path.resolve(import.meta.dirname, '..'), packageOutputDirectory = process.env.NVGW_PACKAGE_OUTPUT_DIRECTORY || path.join(root, 'dist') } = {}) {
  const executable = path.join(packageOutputDirectory, 'win-unpacked', 'NV-Gateway.exe');
  assert.equal(fs.existsSync(executable), true, 'PACKAGED_EXECUTABLE_MISSING');
  const builderConfig = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  assert.equal(builderConfig.includes('!build/src/test-support/**/*'), true, 'TEST_SUPPORT_MUST_BE_EXCLUDED_FROM_ASAR');
  const archive = path.join(packageOutputDirectory, 'win-unpacked', 'resources', 'app.asar');
  const archiveContents = listPackage(archive, {});
  assert.equal(archiveContents.some((entry) => entry.includes('test-support')), false, 'TEST_SUPPORT_SHIPPED_IN_ASAR');
  const asarSource = archiveContents.filter((entry) => entry.endsWith('.js')).map((entry) => extractFile(archive, entry.replace(/^[\\/]+/, '')).toString('utf8')).join('\n');
  for (const forbidden of [...FORBIDDEN_ASAR_IDENTIFIERS, 'NVGW_PACKAGED_SMOKE_', 'NVGW_PACKAGED_TEST_', 'remote-debugging-port', 'remote-allow-origins']) assert.equal(asarSource.includes(forbidden), false, `FORBIDDEN_ASAR_IDENTIFIER:${forbidden}`);
  assert.equal(asarSource.includes('OPENCODE-PROVIDER') && asarSource.includes('nvidia.json'), true, 'FIXED_LEGACY_SOURCE_MISSING');
  assert.equal(asarSource.includes('opencode.json') && asarSource.includes('opencode.jsonc'), true, 'FIXED_OPENCODE_TARGET_MISSING');
  // The engine now ships INSIDE app.asar, so it is read out of the ARCHIVE
  // rather than from resources/. That location change is the security fix: while
  // the engine sat in resources/gateway it was OUTSIDE the ASAR integrity
  // envelope, so a substituted — still functional — engine ran unnoticed, and the
  // engine receives the user's NVIDIA keys in the clear over IPC.
  // The staleness property is unchanged: the shipped bytes are compared to the
  // CURRENT build output, so a packaged bundle that lags a rebuild still fails.
  const stripLeadingSeparators = (entry) => entry.replace(/^[\\/]+/, '');
  const toPosix = (entry) => entry.replace(/\\/g, '/');
  const engineEntries = archiveContents
    .map(stripLeadingSeparators)
    .filter((entry) => toPosix(entry).startsWith('build/gateway/'));
  // Exactly one engine file inside the archive: no sibling module may leak in.
  assert.deepEqual(engineEntries.map(toPosix), ['build/gateway/server.mjs'], 'PACKAGED_GATEWAY_NOT_A_SINGLE_BUNDLE');
  const gatewaySource = extractFile(archive, engineEntries[0]).toString('utf8');
  const builtBundle = fs.readFileSync(path.join(root, 'build', 'gateway', 'server.mjs'), 'utf8');
  assert.equal(gatewaySource, builtBundle, 'PACKAGED_GATEWAY_BUNDLE_STALE');
  // The old integrity-UNCOVERED location must be gone for good: anything
  // executable left in resources/ could be swapped without detection.
  assert.equal(
    fs.existsSync(path.join(packageOutputDirectory, 'win-unpacked', 'resources', 'gateway')),
    false,
    'PACKAGED_GATEWAY_STILL_OUTSIDE_ASAR'
  );
  // The bound-attestation protocol must survive minification. Identifier names
  // are mangled, so the shape is matched instead of the pre-minified spelling.
  assert.match(gatewaySource, /["']ports:bound["']/, 'BOUND_ATTESTATION_PROTOCOL_MISSING');
  assert.match(gatewaySource, /gatewayPort:\s*\w+\s*,\s*adminPort:\s*\w+/, 'BOUND_ATTESTATION_PORT_PAIR_MISSING');
  return { executableExists: true, normalCodeHasNoEnvironmentMigrationOverride: true, normalCodeHasNoRemoteDebuggingBranch: true, fixedProductionPathsPresent: true, testSupportExcludedByPackagerRule: true, forbiddenIdentifiersAbsentFromAsar: true, testSupportAbsentFromAsar: true, packagedGatewayMatchesSource: true, boundAttestationProtocolPresent: true };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runPackagedMigrationSmoke().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
