import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// ───────────────────────────────────────────────────────────────────────────
// Tray-resident REVEAL must survive a destroyed window.
//
// MEASURED in a real launched Electron app (production build/src/main/index.js
// loaded through a shim app root, isolated --user-data-dir, real Tray):
//
//   ACTION win.destroy() while the tray is ALIVE
//   EVENT window-all-closed
//   SNAP after destroy | windows=0 trayCaptured=yes
//   VERDICT process alive with windows=0 (tray present => window-all-closed
//                                         returned early)
//   TRAY_CLICK THREW TypeError: Object has been destroyed
//
// `mainWindow` is assigned once in createWindow() and NEVER nulled, so after the
// window object is destroyed the module-level pointer stays truthy. Every reveal
// path is spelled `mainWindow?.show()`, and optional chaining guards NULL, not a
// DESTROYED native object — so each one throws TypeError instead of reopening.
//
// Why that is severe rather than cosmetic: the throw lands in the tray click
// listener, i.e. an Electron event callback, so it reaches
// process.on("uncaughtException") -> fatalShutdownAndExit -> process.exit(1).
// That is a RAW process exit which skips before-quit -> cleanupAndQuit ->
// gatewayLifecycle.stop(), the ipc shutdown that flushes keys.json and the
// model-key affinity cache. src/main/index.ts's own window-all-closed comment
// states this must NEVER happen ("It must NEVER be a raw process-level exit
// here: that would skip the flush entirely").
//
// Reachable state: `window-all-closed` deliberately early-returns while a tray
// exists, so a destroyed window leaves a LIVE trayed process with no window.
// The window really is destroyed on any close while isQuiting is true (the close
// guard steps aside), and isQuiting is set before an update install hands off to
// quitAndInstall, which is not guaranteed to terminate the process.
//
// REQUIRED: revealing the window must never throw, and must never leave the user
// with a live process that has a tray but no reachable window.
// ───────────────────────────────────────────────────────────────────────────

test('the window pointer is cleared when the window is destroyed', () => {
  const main = read('src/main/index.ts');
  const body = main.slice(main.indexOf('function createWindow'), main.indexOf('app.on("before-quit"'));
  assert.match(body, /mainWindow\.on\("closed"/,
    'createWindow must observe "closed" so the destroyed window is not left behind as a truthy pointer');
  assert.match(body, /mainWindow\.on\("closed"[\s\S]{0,120}?mainWindow = null/,
    'the "closed" handler must null mainWindow');
});

test('no reveal path calls show() straight through the raw pointer', () => {
  // CODE only: the comments deliberately quote the antipattern to explain why it
  // is forbidden, and documenting a hazard must not count as committing it.
  const code = read('src/main/index.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  // Optional chaining guards null, NOT a destroyed native object: measured to
  // throw TypeError: Object has been destroyed in a real launched app.
  const offenders = [...code.matchAll(/mainWindow\?\.show\(\)/g)];
  assert.deepEqual(offenders.map((m) => m[0]), [],
    'mainWindow?.show() throws on a destroyed window; reveal must go through the guarded helper');
});

test('reveal is centralised in a helper that tolerates a destroyed window', () => {
  const main = read('src/main/index.ts');
  assert.match(main, /function ensureMainWindow\(\)/,
    'a single helper must own "give me a usable window"');
  // Slice to the NEXT top-level declaration rather than a fixed byte count, so a
  // longer (well-commented) helper body cannot fail this by length alone.
  const start = main.indexOf('function ensureMainWindow');
  const next = main.indexOf('\nfunction ', start + 1);
  const helper = main.slice(start, next === -1 ? start + 1200 : next);
  assert.match(helper, /isDestroyed\(\)/,
    'the helper must test isDestroyed(), which is the condition optional chaining cannot see');
  assert.match(helper, /createWindow\(\)/,
    'a destroyed window must be rebuilt, otherwise the tray leads nowhere and the app is invisible');
});

test('the single-instance reveal cannot be handed a destroyed window', () => {
  const main = read('src/main/index.ts');
  const line = main.split('\n').find((entry) => entry.includes('configureSingleInstance(app,'));
  assert.ok(line, 'the production single-instance wiring must be locatable');
  assert.equal(/=>\s*mainWindow\s*\)/.test(line), false,
    'single-instance.ts calls isMinimized()/show()/focus() unguarded, so it must not receive the raw pointer');
  assert.match(line, /ensureMainWindow\(\)/,
    'the second-instance reveal must go through the destroyed-tolerant helper');
});
