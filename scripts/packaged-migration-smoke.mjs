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
  const gatewaySource = fs.readFileSync(path.join(packageOutputDirectory, 'win-unpacked', 'resources', 'gateway', 'server.mjs'), 'utf8');
  const sourceGateway = fs.readFileSync(path.join(root, 'src', 'gateway', 'server.mjs'), 'utf8');
  assert.equal(gatewaySource, sourceGateway, 'PACKAGED_GATEWAY_SOURCE_STALE');
  assert.equal(gatewaySource.includes('type: "ports:bound"'), true, 'BOUND_ATTESTATION_PROTOCOL_MISSING');
  assert.equal(gatewaySource.includes('gatewayPort: PORT, adminPort: ADMIN_PORT'), true, 'BOUND_ATTESTATION_PORT_PAIR_MISSING');
  return { executableExists: true, normalCodeHasNoEnvironmentMigrationOverride: true, normalCodeHasNoRemoteDebuggingBranch: true, fixedProductionPathsPresent: true, testSupportExcludedByPackagerRule: true, forbiddenIdentifiersAbsentFromAsar: true, testSupportAbsentFromAsar: true, packagedGatewayMatchesSource: true, boundAttestationProtocolPresent: true };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runPackagedMigrationSmoke().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
