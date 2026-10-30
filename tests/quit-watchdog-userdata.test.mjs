// Source-level pins for two main-process shutdown/isolation fixes:
//  1. cleanupAndQuit arms an unref'd app.exit watchdog only AFTER the awaited
//     gateway stop (the keys.json flush) and the final app.quit(); will-quit logs
//     app_will_quit so a stalled Electron quit is visible in app.jsonl.
//  2. The GPU crash marker and migration log derive from userData (honours
//     --user-data-dir), and the app name is fixed before userData is first read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');

function functionBody(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = source.indexOf('\nconst fatalShutdownAndExit', start);
  assert.ok(next > start, `${name} body end marker must follow it`);
  return source.slice(start, next);
}

test('cleanupAndQuit arms an unref\'d exit watchdog only after the awaited stop/flush and app.quit()', () => {
  const body = functionBody('cleanupAndQuit');
  const stopAt = body.indexOf('await gatewayLifecycle?.stop();');
  const quitAt = body.lastIndexOf('app.quit();');
  const timerAt = body.indexOf('setTimeout(');
  const exitAt = body.indexOf('app.exit(0)');
  const unrefAt = body.indexOf('.unref()');
  assert.ok(stopAt >= 0, 'the gateway stop (keys.json flush) must be awaited');
  assert.ok(quitAt > stopAt, 'app.quit() must follow the awaited stop');
  assert.ok(timerAt > quitAt, 'the watchdog must be armed after the final app.quit()');
  assert.ok(exitAt > timerAt && unrefAt > exitAt, 'the watchdog must call app.exit(0) and be unref\'d');
  assert.equal(body.slice(0, timerAt).includes('app.exit'), false, 'no force-exit may precede the awaited flush');
  assert.match(source, /const QUIT_WATCHDOG_MS = 3_000;/);
});

test('will-quit logs app_will_quit', () => {
  const start = source.indexOf('app.on("will-quit"');
  assert.ok(start >= 0);
  const handler = source.slice(start, source.indexOf('\n});', start));
  assert.match(handler, /logAppEvent\("info", "app_will_quit", \{\}\)/);
});

test('crash marker and migration log follow userData, never appData/NV-Gateway', () => {
  assert.equal(source.includes('getPath("appData")'), false, 'no path may bypass --user-data-dir');
  const setNameAt = source.indexOf('app.setName("NV-Gateway");');
  const firstUserData = source.indexOf('app.getPath("userData")');
  assert.ok(setNameAt >= 0 && setNameAt < firstUserData,
    'the app name must be fixed before userData is first resolved (Chromium caches it)');
  assert.match(source, /gpuCrashMarkerPresent\(app\.getPath\("userData"\)\)/);
  assert.match(source, /writeGpuCrashMarker\(app\.getPath\("userData"\)/);
  assert.match(source, /path\.join\(app\.getPath\("userData"\), "logs", "migration-phase\.jsonl"\)/);
  const gpu = fs.readFileSync(path.join(root, 'src', 'main', 'gpu-fallback.ts'), 'utf8');
  assert.match(gpu, /path\.join\(appDataPath, "gpu-crash\.marker"\)/);
});
