import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// ───────────────────────────────────────────────────────────────────────────
// DEFECT: unbounded kernel `Key` handle growth in the main process.
//
// MEASURED (Electron 31.7.7, Windows, headless probe — not assumed):
//   app.getLoginItemSettings() leaks exactly ONE kernel `Key` handle per call,
//   and only when the HKCU\Software\Microsoft\Windows\CurrentVersion\Run value
//   for this app exists, i.e. openAtLogin === true:
//
//     openAtLogin=true    5000 calls -> handle delta +5000 (still held when idle)
//     openAtLogin=false   5000 calls -> handle delta 0
//     openAtLogin=true   20000 calls -> handle delta +20000 in 7445 ms
//
//   The growth is LINEAR, not one-time initialisation: three consecutive batches
//   of 5000 each added 5000. The handles are never returned (45 s idle -> still
//   held). ~16.2 bytes of paged pool per handle.
//
//   The openAtLogin=false result is NOT immunity — it is a path that never
//   executes. Only the armed (openAtLogin=true) measurement is meaningful.
//
// WHY IT MATTERED HERE: the call sat inside the `get-runtime-state` IPC handler,
// which the renderer invokes on EVERY refresh, so an ordinary per-request read
// became unbounded paged-pool growth. One live process on the reporter's machine
// had accumulated 7,201,605 handles, of which 7,200,846 were type `Key`.
//
// REQUIRED BEHAVIOUR: the hot path serves auto-launch from a main-process cache.
// The native setting is read only when it can actually have changed — when the
// app itself writes it (toggle-auto-launch) or when the renderer explicitly asks
// (get-auto-launch). Those are bounded by user actions, not by render cycles.
//
// ACCEPTED TRADEOFF, pinned here so it is never mistaken for a bug: an EXTERNAL
// edit of the Run value (regedit, msconfig, Task Manager Startup tab, another
// installer) is not observed by get-runtime-state, which keeps serving the last
// value seen until the next toggle, an explicit get-auto-launch, or a restart.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Strip comments so the assertions judge CODE, not prose. The comments in
 * index.ts necessarily name app.getLoginItemSettings() to explain why it is
 * confined to one place; documenting the hazard is not committing it.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Slice a single `ipcMain.handle("<channel>", ...)` registration. */
function handlerBlock(source, channel) {
  const start = source.indexOf(`ipcMain.handle("${channel}"`);
  assert.notEqual(start, -1, `expected an ipcMain.handle registration for ${channel}`);
  const rest = source.slice(start + 1);
  const next = rest.indexOf('ipcMain.handle("');
  return next === -1 ? rest : rest.slice(0, next);
}

test('the get-runtime-state hot path never calls getLoginItemSettings', () => {
  const code = stripComments(read('src/main/index.ts'));
  const handler = handlerBlock(code, 'get-runtime-state');

  assert.doesNotMatch(handler, /getLoginItemSettings/,
    'get-runtime-state runs on every renderer refresh and each getLoginItemSettings() '
    + 'call leaks one kernel `Key` handle while openAtLogin is true (measured: 5000 calls '
    + '-> +5000 handles). This handler must read auto-launch from the main-process cache.');

  assert.match(handler, /autoLaunch:\s*getAutoLaunchCached\(\)/,
    'the handler must serve autoLaunch from the cached accessor so the response shape '
    + 'is unchanged while the registry is left alone');
});

test('the native registry read is funnelled through exactly one call site', () => {
  const code = stripComments(read('src/main/index.ts'));
  const occurrences = [...code.matchAll(/getLoginItemSettings/g)].length;
  assert.equal(occurrences, 1,
    'every auto-launch read must go through the single refreshAutoLaunch() helper, so '
    + `the leaking primitive has exactly one call site; found ${occurrences}`);

  assert.match(code, /function refreshAutoLaunch\(\)[\s\S]{0,200}?app\.getLoginItemSettings\(\)\.openAtLogin/,
    'refreshAutoLaunch() must be the one place that touches the OS setting');
});

test('the cached accessor touches the registry at most once per process', () => {
  const code = stripComments(read('src/main/index.ts'));

  assert.match(code, /let autoLaunchCache:\s*boolean\s*\|\s*null\s*=\s*null;/,
    'the cache must be main-process state with an explicit "not yet read" state');

  const accessor = /function getAutoLaunchCached\(\)[\s\S]*?\n\}/.exec(code);
  assert.ok(accessor, 'a cached accessor must exist for the hot path');
  assert.match(accessor[0], /autoLaunchCache\s*\?\?\s*refreshAutoLaunch\(\)/,
    'the accessor must return the cached value and only seed it when still unset, so a '
    + 'steady stream of get-runtime-state calls performs zero registry reads');
});

test('an explicit get-auto-launch still reads the real OS state', () => {
  // Observable behaviour must not change: this channel is the renderer's way to
  // ask for the truth, so it reads through and refreshes the cache rather than
  // returning a possibly stale cached value.
  const handler = handlerBlock(stripComments(read('src/main/index.ts')), 'get-auto-launch');
  assert.match(handler, /refreshAutoLaunch\(\)/,
    'get-auto-launch must perform a real read so an explicit query is never stale');
  assert.doesNotMatch(handler, /getAutoLaunchCached/,
    'an explicit query must not be answered from the cache');
});

test('toggling auto-launch refreshes the cache so the next render is not stale', () => {
  const handler = handlerBlock(stripComments(read('src/main/index.ts')), 'toggle-auto-launch');

  assert.match(handler, /app\.setLoginItemSettings\(\{\s*openAtLogin:\s*enable/,
    'the toggle must still write the OS setting');
  assert.match(handler, /refreshAutoLaunch\(\)/,
    'after changing the setting the cache must be refreshed, otherwise get-runtime-state '
    + 'would keep serving the pre-toggle value for the rest of the session');
  assert.match(handler, /return enable;/,
    'the channel contract (returns the requested state) must be unchanged');

  // Ordering matters: refreshing before the write would cache the old value.
  const write = handler.indexOf('setLoginItemSettings');
  const refresh = handler.indexOf('refreshAutoLaunch()');
  assert.ok(write < refresh,
    'the cache must be refreshed AFTER the write, not before');
});

test('the renderer contract for autoLaunch is untouched', () => {
  // The fix is entirely inside main. If either side of the bridge changed, the
  // toggle in Settings would be a behaviour change rather than a leak fix.
  assert.match(read('src/preload/index.ts'), /getAutoLaunch:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('get-auto-launch'\)/,
    'the preload bridge must still expose get-auto-launch unchanged');
  assert.match(read('src/renderer/global.d.ts'), /autoLaunch:\s*boolean/,
    'RuntimeState must still carry autoLaunch as a boolean');
});
