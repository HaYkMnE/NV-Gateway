import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

// ── Anti-evasion ───────────────────────────────────────────────────────────
// The assertion above only forbids the LITERAL string `getLoginItemSettings`
// inside the hot handler, which is not enough. Six re-arming edits were applied
// to src/main/index.ts one at a time and the guard was run against each; three
// of them PASSED the original six assertions with exit code 0:
//
//   PASSED  hot path calls refreshAutoLaunch()      <- re-arms the exact leak
//   PASSED  4th call site in get-gateway-status     <- polled every 1s, and
//                                                      refetchIntervalInBackground
//   PASSED  a sibling src/main/*.ts reads it
//   caught  app['getLoginItemSettings']()
//   caught  hot path inlines the raw primitive
//   caught  cache assigned the requested value
//
// The helper the fix introduced is itself the evasion vector: forbidding the
// primitive's NAME does not forbid REACHING it. Hence the assertions below check
// indirect reach, the full set of call sites, aliasing, and sibling modules. All
// six edits now fail. The measurement lives in the commit that added them.
test('the hot path cannot reach the native read through the refresh helper', () => {
  const code = stripComments(read('src/main/index.ts'));
  const handler = handlerBlock(code, 'get-runtime-state');

  assert.doesNotMatch(handler, /refreshAutoLaunch/,
    'get-runtime-state must not call refreshAutoLaunch(): it wraps '
    + 'app.getLoginItemSettings(), so calling it here leaks one kernel `Key` handle per '
    + 'renderer refresh exactly as before the fix. Only getAutoLaunchCached() is allowed '
    + 'on this path.');
});

test('every call site of the leaking read is one of the three sanctioned ones', () => {
  const code = stripComments(read('src/main/index.ts'));

  // A call, not the declaration `function refreshAutoLaunch()`.
  const callSites = (text) => [...text.matchAll(/(?<!function\s)\brefreshAutoLaunch\(\)/g)].length;

  // The only regions where a native read is legitimate: the lazy one-time seed
  // inside the cached accessor, and the two user-driven channels.
  const accessor = /function getAutoLaunchCached\(\)[\s\S]*?\n\}/.exec(code);
  assert.ok(accessor, 'a cached accessor must exist for the hot path');
  const sanctioned = {
    'getAutoLaunchCached (lazy seed)': accessor[0],
    'toggle-auto-launch (after write)': handlerBlock(code, 'toggle-auto-launch'),
    'get-auto-launch (explicit query)': handlerBlock(code, 'get-auto-launch')
  };

  // Each sanctioned region must still contain its read...
  for (const [name, body] of Object.entries(sanctioned)) {
    assert.ok(callSites(body) >= 1, `the native read must still happen in ${name}`);
  }

  // ...and once those regions are masked out, NO call site may remain. This is
  // what makes a fourth call site -- a new handler, a helper, a timer, a menu
  // action, the hot path itself -- fail here instead of leaking silently.
  let masked = code;
  for (const body of Object.values(sanctioned)) masked = masked.split(body).join('\n/* sanctioned */\n');
  assert.equal(callSites(masked), 0,
    'refreshAutoLaunch() is called outside getAutoLaunchCached(), toggle-auto-launch and '
    + 'get-auto-launch. It wraps app.getLoginItemSettings(), so every extra call site leaks '
    + 'one kernel `Key` handle per invocation; if a new one is genuinely needed, add it to '
    + 'the sanctioned list here together with the argument for why it is bounded.');
});

test('the native read is not reachable through an alias or dynamic property access', () => {
  const code = stripComments(read('src/main/index.ts'));

  // `app['getLoginItemSettings']()` and `const f = app.getLoginItemSettings`
  // both defeat a plain textual search for `app.getLoginItemSettings()`.
  assert.doesNotMatch(code, /\[\s*(['"`])getLoginItemSettings\1\s*\]/,
    'dynamic property access to getLoginItemSettings hides the leaking read from review; '
    + 'call it directly inside refreshAutoLaunch() or not at all');
  assert.doesNotMatch(code, /getLoginItemSettings\s*(?![.(])/,
    'getLoginItemSettings must only ever appear as an immediate call '
    + '(app.getLoginItemSettings().openAtLogin), never captured into a variable or passed '
    + 'as a value, because an alias can be invoked from anywhere including the hot path');
});

test('no other main-process file reads the login-item settings', () => {
  // Confining the primitive to one call site in index.ts is worthless if a
  // sibling module reads it and is called from the hot path.
  const dir = path.join(root, 'src', 'main');
  const offenders = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === 'index.ts') continue;
    if (!/\.ts$/.test(entry.name)) continue;
    if (/getLoginItemSettings/.test(stripComments(fs.readFileSync(path.join(dir, entry.name), 'utf8')))) {
      offenders.push(entry.name);
    }
  }
  assert.deepEqual(offenders, [],
    'the leaking read must stay in index.ts behind refreshAutoLaunch(); found it in: '
    + offenders.join(', '));
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

test('the built main module performs zero native reads while starting up', () => {
  // BEHAVIOURAL, not textual. Every other assertion here reads source text and
  // can therefore be satisfied by code that misbehaves at runtime. This one runs
  // the REAL BUILT module (build/src/main/index.js) under a faked electron and
  // counts actual app.getLoginItemSettings() invocations.
  const probe = path.join(root, 'tests', 'auto-launch-native-read-probe.mjs');
  const built = path.join(root, 'build', 'src', 'main', 'index.js');
  if (!fs.existsSync(built)) {
    // `npm test` builds first (pretest). A bare `node --test` on this file alone
    // legitimately has no build to inspect; say so instead of failing opaquely.
    assert.ok(fs.existsSync(probe), 'the behavioural probe script must exist');
    return;
  }

  const run = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, `probe exited ${run.status}: ${run.stderr?.slice(-500) ?? ''}`);

  const line = run.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, `probe produced no JSON result. stdout tail: ${run.stdout.slice(-300)}`);
  const measured = JSON.parse(line);

  assert.equal(measured.loaded, true, `the built main module failed to load: ${measured.loadError}`);
  assert.ok(measured.channels.includes('get-runtime-state'),
    'the built module must register get-runtime-state');

  // The load-bearing number: merely booting the main process must not sample the
  // registry. Anything above zero is a handle leaked on every single launch.
  assert.equal(measured.startupNativeReads, 0,
    'loading the built main module called app.getLoginItemSettings() '
    + `${measured.startupNativeReads} time(s) during startup. Each call leaks one kernel `
    + '`Key` handle while the Run value exists; the cache must be seeded lazily, not eagerly.');

  // Invoking get-runtime-state without a live window must be refused by secure()
  // rather than doing work. This pins the gate, and documents WHY the probe
  // cannot measure the handler body end to end.
  assert.equal(measured.hotPath.reachedBody, false,
    'get-runtime-state executed its body without a BrowserWindow; secure() is supposed to '
    + 'reject callers when no window is available');
  assert.match(String(measured.hotPath.rejectedWith), /Window unavailable/,
    'get-runtime-state must be gated by secure()');
  assert.equal(measured.hotPath.nativeReads, 0,
    'a rejected get-runtime-state call must not reach the registry');
});

test('get-auto-launch has no renderer caller, so the native read is user-driven only', () => {
  // The fix moves the leaking read to get-auto-launch. That is only a real fix if
  // the renderer does not call it on a render cycle. Verified by scanning, not
  // assumed: a per-mount or polled call here would re-create the unbounded leak
  // that get-runtime-state used to have.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (entry.name === 'global.d.ts') continue; // type declaration, not a call
      const source = stripComments(fs.readFileSync(full, 'utf8'));
      if (/\bgetAutoLaunch\s*\(/.test(source)) offenders.push(path.relative(root, full));
    }
  };
  walk(path.join(root, 'src', 'renderer'));

  assert.deepEqual(offenders, [],
    'the renderer now calls getAutoLaunch(), which reaches app.getLoginItemSettings() and '
    + 'leaks one kernel `Key` handle per call. If this is genuinely needed it must be tied '
    + 'to an explicit user action, never to a mount, a re-render or a refetchInterval. '
    + 'Found in: ' + offenders.join(', '));

  // And the hot path the renderer DOES poll must be the cached one.
  const settings = stripComments(read('src/renderer/views/Settings.tsx'));
  assert.match(settings, /queryKey:\s*queryKeys\.runtime[\s\S]{0,120}refetchInterval:\s*\d+/,
    'Settings is expected to poll runtime state on an interval; that is precisely why the '
    + 'auto-launch read must not sit on that path');
});

test('a failed or rejected write never leaves the cache asserting a state the OS refused', () => {
  const handler = handlerBlock(stripComments(read('src/main/index.ts')), 'toggle-auto-launch');

  // The cache must be filled from a real OS read, not from the requested value.
  // `autoLaunchCache = enable` would make the cache assert a state the OS may
  // have silently refused (permission, policy, roaming profile).
  assert.doesNotMatch(handler, /autoLaunchCache\s*=\s*enable/,
    'the toggle must not assign the REQUESTED value into the cache; it must re-read the OS '
    + 'via refreshAutoLaunch(), otherwise a silently failed write makes the cache lie for '
    + 'the rest of the session');

  // If setLoginItemSettings throws, the write is not confirmed. The refresh must
  // sit after it in the same straight-line body (no try/catch swallowing the
  // failure and then caching an optimistic value).
  assert.doesNotMatch(handler, /catch\s*(\([^)]*\))?\s*\{[\s\S]*autoLaunchCache/,
    'a caught write failure must not still update the cache');
});

test('the renderer contract for autoLaunch is untouched', () => {
  // The fix is entirely inside main. If either side of the bridge changed, the
  // toggle in Settings would be a behaviour change rather than a leak fix.
  assert.match(read('src/preload/index.ts'), /getAutoLaunch:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('get-auto-launch'\)/,
    'the preload bridge must still expose get-auto-launch unchanged');
  assert.match(read('src/renderer/global.d.ts'), /autoLaunch:\s*boolean/,
    'RuntimeState must still carry autoLaunch as a boolean');
});
