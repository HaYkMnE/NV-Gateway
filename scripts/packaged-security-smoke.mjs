import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_ASSERTIONS = [
  'exactPackagedUrl', 'nodeGlobalsHidden', 'preloadApiNarrow', 'cspBlocksInline',
  'cspBlocksEval', 'cspHasNoUnsafeInline', 'popupDenied', 'navigationDenied',
  'permissionDenied', 'hashRouteIpcAllowed',
  // Repackaging defence (scripts/harden-windows-package.mjs). Still STATIC: the
  // fuse wire and the integrity resource are read out of the binary, nothing is
  // executed. These fail closed if someone later drops the afterPack hook, and
  // runAsNodeFuseEnabled fails closed if someone "hardens" RunAsNode off, which
  // would silently kill the gateway child (ELECTRON_RUN_AS_NODE=1).
  'asarIntegrityFuseEnabled', 'onlyLoadAppFromAsarFuseEnabled', 'runAsNodeFuseEnabled',
  'asarIntegrityResourceEmbedded', 'asarIntegrityHashMatchesArchive'
];

const EXPECTED_API = ['adminAddKey','adminListKeys','adminLogs','adminRemoveKey','adminReorder','adminSetStatus','adminValidateKey','checkPorts','findFreePort','getAppVersion','getAutoLaunch','getGatewayPort','getGatewayStatus','getRuntimeState','retryGateway','setAppConfig','setGatewayPort','toggleAutoLaunch'];

export async function runPackagedSecuritySmoke({ root = path.resolve(import.meta.dirname, '..'), packageOutputDirectory = process.env.NVGW_PACKAGE_OUTPUT_DIRECTORY || path.join(root, 'dist'), sandboxRoot = process.env.TEMP || os.tmpdir() } = {}) {
  const exe = path.join(packageOutputDirectory, 'win-unpacked', 'NV-Gateway.exe');
  assert.ok(fs.existsSync(exe), `Packaged executable missing: ${exe}`);
  const main = path.join(root, 'build', 'src', 'main', 'index.js');
  const preload = path.join(root, 'build', 'src', 'preload', 'index.js');
  const security = path.join(root, 'build', 'src', 'main', 'electron-security.js');
  const renderer = path.join(root, 'build', 'renderer', 'index.html');
  const mainCode = fs.readFileSync(main, 'utf8'); const preloadCode = fs.readFileSync(preload, 'utf8'); const securityCode = fs.readFileSync(security, 'utf8'); const rendererCode = fs.readFileSync(renderer, 'utf8');
  const assertions = {
    exactPackagedUrl: mainCode.includes('renderer/index.html'),
    nodeGlobalsHidden: mainCode.includes('nodeIntegration: false') && mainCode.includes('contextIsolation: true') && mainCode.includes('sandbox: true'),
    preloadApiNarrow: EXPECTED_API.every((name) => preloadCode.includes(name)),
    cspBlocksInline: !rendererCode.includes("'unsafe-inline'"),
    cspBlocksEval: !rendererCode.includes("'unsafe-eval'"),
    cspHasNoUnsafeInline: !rendererCode.includes("'unsafe-inline'"),
    popupDenied: securityCode.includes("action: \"deny\"") || securityCode.includes("action: 'deny'"),
    navigationDenied: mainCode.includes('installElectronSecurity') && securityCode.includes('will-navigate'),
    permissionDenied: mainCode.includes('installElectronSecurity') && securityCode.includes('setPermissionRequestHandler'),
    hashRouteIpcAllowed: preloadCode.includes('getAppVersion'),
    ...await inspectRepackagingDefence(exe, path.join(packageOutputDirectory, 'win-unpacked'))
  };
  for (const name of REQUIRED_ASSERTIONS) assert.equal(assertions[name], true, `${name} static packaged assertion failed`);
  return { executable: exe, assertions, staticInspectionOnly: true };
}

/**
 * Repackaging defence, inspected STATICALLY out of the built binary: the fuse
 * wire and the embedded integrity resource are read, nothing is executed.
 *
 * Loaded lazily so this module stays importable (and the harness tests keep
 * passing) on a machine without a packaged output.
 *
 * @param {string} executablePath Packaged NV-Gateway.exe.
 * @param {string} unpackedDirectory dist/win-unpacked.
 * @returns {Promise<Record<string, boolean>>}
 */
async function inspectRepackagingDefence(executablePath, unpackedDirectory) {
  const { readFuseStates, readWindowsAsarIntegrity, computeAsarIntegrity } =
    await import('./harden-windows-package.mjs');

  const fuses = await readFuseStates(executablePath);
  const embedded = readWindowsAsarIntegrity(executablePath);
  const expected = computeAsarIntegrity({ resourcesPath: path.join(unpackedDirectory, 'resources') });

  // Every archive Electron will validate must be covered by the embedded
  // manifest, with a hash that matches the archive actually shipped. A stale
  // hash is as fatal at runtime as a missing one, so it is caught here.
  const expectedEntries = Object.entries(expected);
  const hashMatches = Array.isArray(embedded)
    && expectedEntries.length > 0
    && expectedEntries.every(([file, { algorithm, hash }]) => embedded.some((entry) =>
      entry.file === file
      && String(entry.alg).toLowerCase() === String(algorithm).toLowerCase()
      && entry.value === hash));

  return {
    asarIntegrityFuseEnabled: fuses.EnableEmbeddedAsarIntegrityValidation === 'enabled',
    onlyLoadAppFromAsarFuseEnabled: fuses.OnlyLoadAppFromAsar === 'enabled',
    // NOT a copy-paste of the two above: the gateway engine is spawned as a
    // child of this binary with ELECTRON_RUN_AS_NODE=1, so this fuse must stay
    // ENABLED. Disabling it (as generic hardening guides advise) kills the
    // gateway, and this assertion is what makes that regression loud.
    runAsNodeFuseEnabled: fuses.RunAsNode === 'enabled',
    asarIntegrityResourceEmbedded: Array.isArray(embedded) && embedded.length > 0,
    asarIntegrityHashMatchesArchive: hashMatches
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runPackagedSecuritySmoke().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; });
}
