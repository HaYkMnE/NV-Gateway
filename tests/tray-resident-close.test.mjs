import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// ───────────────────────────────────────────────────────────────────────────
// Tray-resident escape hatch.
//
// MEASURED on the reporter's own machine, not assumed:
//   * %APPDATA%/NV-Gateway/logs/app.jsonl -> tray_created == app_start == 62,
//     uncaught_exception == 0, unhandled_rejection == 0, fatal_shutdown == 0.
//     new Tray() has NEVER thrown and the tray was created on every start.
//   * resources/assets ships all 13 icon files in the real install, and the
//     rasters decode to real artwork (tray-stopped-16.png: 45.3% of pixels
//     have alpha > 16). trayAssetsDir() already branches on app.isPackaged.
//   * HKCU\Control Panel\NotifyIconSettings holds an entry for the installed
//     exe WITH an IconSnapshot but WITHOUT IsPromoted, i.e. Windows 11 filed
//     the icon in the hidden overflow flyout behind the chevron.
//   * 6 NV-Gateway processes were live while the reporter believed the app was
//     gone, and only 6 of 62 sessions ever logged app_shutdown_initiated.
//
// So neither symptom is a tray-creation failure. The defect is that hide-on-
// close was UNCONDITIONAL: it hid the only surface the user can see, and when
// the tray icon is parked in the overflow (or absent altogether) the app
// becomes an invisible process with no reachable Quit. "X killed the app" is
// the user reading that state; "the tray icon never appears" is the same root
// cause seen from the other side.
//
// These tests pin the escape hatch. What they CANNOT do is prove a human sees
// the icon: Windows alone decides overflow placement and no supported API
// promotes an icon. That part is observation-only and is reported as such.
// ───────────────────────────────────────────────────────────────────────────

/** Slice a top-level `app.on(...)` / handler block, tolerating nested `});`. */
function topLevelBlock(source, startNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `expected to find ${startNeedle}`);
  const rest = source.slice(start);
  const end = rest.indexOf('\n});');
  assert.notEqual(end, -1, `expected a top-level close for ${startNeedle}`);
  return rest.slice(0, end + 4);
}

test('the close guard hides to the tray when a tray exists', async () => {
  const { createWindowCloseGuard } = await import(built('window-close-guard.js'));
  const handleWindowClose = createWindowCloseGuard();
  const calls = [];
  const result = handleWindowClose({
    event: { preventDefault: () => calls.push('preventDefault') },
    isQuitting: () => false,
    hasTray: () => true,
    hide: () => calls.push('hide'),
    log: (level, event) => calls.push(`log:${level}:${event}`)
  });

  assert.equal(result, 'hidden', 'a tray-backed close hides instead of closing');
  assert.ok(calls.includes('preventDefault'), 'the real close must be prevented');
  assert.ok(calls.includes('hide'), 'the window is hidden to the tray');
});

test('the close guard lets the window really close when NO tray exists, so the user is never trapped', async () => {
  const { createWindowCloseGuard } = await import(built('window-close-guard.js'));
  const handleWindowClose = createWindowCloseGuard();
  const calls = [];
  const result = handleWindowClose({
    event: { preventDefault: () => calls.push('preventDefault') },
    isQuitting: () => false,
    hasTray: () => false,
    hide: () => calls.push('hide'),
    log: (level, event) => calls.push(`log:${level}:${event}`)
  });

  assert.equal(result, 'closing', 'without a tray the close must proceed');
  assert.equal(calls.includes('preventDefault'), false,
    'preventing the close with no tray strands the user with an invisible, unquittable app');
  assert.equal(calls.includes('hide'), false, 'hiding into nowhere is exactly the reported defect');
  assert.ok(calls.some((entry) => entry.startsWith('log:warn:')),
    'the degraded path must be visible in the log, never silent');
});

test('the close guard steps aside once a quit is already in flight', async () => {
  const { createWindowCloseGuard } = await import(built('window-close-guard.js'));
  const handleWindowClose = createWindowCloseGuard();
  const calls = [];
  const result = handleWindowClose({
    event: { preventDefault: () => calls.push('preventDefault') },
    isQuitting: () => true,
    hasTray: () => true,
    hide: () => calls.push('hide'),
    log: () => {}
  });

  assert.equal(result, 'closing', 'a quit in progress must not be blocked');
  assert.deepEqual(calls, [], 'no preventDefault and no hide while quitting');
});

test('the first hide announces where the window went, exactly once per guard', async () => {
  const { createWindowCloseGuard } = await import(built('window-close-guard.js'));
  const handleWindowClose = createWindowCloseGuard();
  let announced = 0;
  const close = () => handleWindowClose({
    event: { preventDefault: () => {} },
    isQuitting: () => false,
    hasTray: () => true,
    hide: () => {},
    onFirstHide: () => { announced += 1; },
    log: () => {}
  });

  close();
  assert.equal(announced, 1, 'the user is told the app is still alive in the tray');
  close();
  close();
  assert.equal(announced, 1, 'the notice is a one-off, not nagging on every close');
});

test('an onFirstHide failure never breaks hide-to-tray', async () => {
  const { createWindowCloseGuard } = await import(built('window-close-guard.js'));
  const handleWindowClose = createWindowCloseGuard();
  const calls = [];
  const result = handleWindowClose({
    event: { preventDefault: () => calls.push('preventDefault') },
    isQuitting: () => false,
    hasTray: () => true,
    hide: () => calls.push('hide'),
    onFirstHide: () => { throw new Error('displayBalloon is unavailable'); },
    log: (level, event) => calls.push(`log:${level}:${event}`)
  });

  assert.equal(result, 'hidden', 'a cosmetic notification failure must not change close semantics');
  assert.ok(calls.includes('hide'), 'the window still hides');
  assert.ok(calls.some((entry) => entry === 'log:warn:tray_hide_notice_failed'),
    'the swallowed notification error is still recorded');
});

test('createTray failure is caught, logged, and leaves the app closable', () => {
  const main = read('src/main/index.ts');
  const body = main.slice(main.indexOf('function createTray'), main.indexOf('function createWindow'));
  assert.ok(body.includes('try'), 'createTray must not let a Tray constructor throw escape');
  assert.ok(body.includes('catch'), 'a throwing Tray constructor is caught');
  assert.match(body, /tray_create_failed/, 'the failure must be visible in the log, not silent');
  assert.match(body, /tray = null/, 'a failed tray must leave the tray state null so the close guard degrades');
});

test('src/main/index.ts routes window close through the guard instead of hiding unconditionally', () => {
  const main = read('src/main/index.ts');
  assert.match(main, /^import \{[^}]*\bcreateWindowCloseGuard\b[^}]*\} from "\.\/window-close-guard";/m,
    'index.ts must use the tested guard');
  const handler = main.slice(main.indexOf('mainWindow.on("close"'), main.indexOf('app.on("before-quit"'));
  assert.ok(handler.includes('handleWindowClose'), 'the close handler delegates the decision to the guard');
  assert.ok(handler.includes('hasTray'), 'the decision is conditioned on a tray actually existing');
  assert.equal(/if \(!isQuiting\) \{\s*event\.preventDefault\(\);\s*mainWindow\?\.hide\(\);/.test(handler), false,
    'the unconditional hide-on-close that produced the report must be gone');
});

test('window-all-closed quits through the flushing path when there is no tray to return to', () => {
  const body = topLevelBlock(read('src/main/index.ts'), 'app.on("window-all-closed"');
  assert.ok(body.includes('tray'), 'the decision depends on whether a tray survives');
  assert.match(body, /app\.quit\(\)/,
    'with no tray the app must quit for real rather than linger as an invisible process');
  // app.quit() -> before-quit -> handleBeforeQuit -> cleanupAndQuit ->
  // gatewayLifecycle.stop(), which is the IPC-shutdown path that flushes
  // keys.json and the affinity cache. Reusing it keeps the flush invariant.
  assert.equal(/process\.exit\(/.test(body), false,
    'never bypass before-quit: that is what flushes keys.json and the affinity cache');
});
