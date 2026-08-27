import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_ASSERTIONS = [
  'exactPackagedUrl', 'nodeGlobalsHidden', 'preloadApiNarrow', 'cspBlocksInline',
  'cspBlocksEval', 'cspHasNoUnsafeInline', 'popupDenied', 'navigationDenied',
  'permissionDenied', 'hashRouteIpcAllowed'
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
    hashRouteIpcAllowed: preloadCode.includes('getAppVersion')
  };
  for (const name of REQUIRED_ASSERTIONS) assert.equal(assertions[name], true, `${name} static packaged assertion failed`);
  return { executable: exe, assertions, staticInspectionOnly: true };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runPackagedSecuritySmoke().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; });
}
