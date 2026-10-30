// Auto-launch with an install path that contains a space
// (C:\OPENCODE-PROVIDER\NV Gateway\NV-Gateway.exe).
//
// VERIFIED against Electron 31.7.7 shell/browser/browser_win.cc (not assumed):
//   :140-152  FormatCommandLineString(exe, args) uses `path` VERBATIM (adds no
//             quotes) and only appends " " + args.join(" ").
//   :631-633  setLoginItemSettings writes that string to HKCU\...\Run.
//   :670-672  getLoginItemSettings: openAtLogin = (Run value == the same string),
//             plain equality.
// So read and write must pass the SAME `path`, and it must be quoted by us:
//   - unquoted write of a spaced path = unquoted-path risk (C:\...\NV.exe first);
//   - quoted Run value vs unquoted read = switch shows OFF while autostart is ON.
// MIGRATION: installs in a space-free path hold an UNQUOTED value written by the
// old code; the read must still report ON for it, and the next write replaces it
// with the quoted form.
//
// The fake below re-implements exactly those three source lines so the helper is
// tested against Electron's real semantics, not against a guess.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { loginItemPath, legacyLoginItemPath, readOpenAtLogin } = require(path.join(root, 'build', 'src', 'main', 'login-item.js'));

const SPACED = 'C:\\OPENCODE-PROVIDER\\NV Gateway\\NV-Gateway.exe';
const PLAIN = 'C:\\Apps\\NV-Gateway\\NV-Gateway.exe';

/** Electron 31.7.7 win32 login-item semantics (browser_win.cc:140-152, :631-633, :670-672). */
function fakeElectron(initialRunValue) {
  let runValue = initialRunValue; // undefined = no Run value
  const reads = [];
  const format = (p, args = []) => (args.length ? `${p} ${args.join(' ')}` : p);
  return {
    get runValue() { return runValue; },
    reads,
    setLoginItemSettings({ openAtLogin, path: p, args }) {
      if (openAtLogin) runValue = format(p, args);
      else runValue = undefined;
    },
    getLoginItemSettings({ path: p, args } = {}) {
      reads.push(p);
      return { openAtLogin: runValue !== undefined && runValue === format(p, args) };
    },
  };
}
const readWith = (electron, exe) => readOpenAtLogin((p) => electron.getLoginItemSettings({ path: p }).openAtLogin, exe);

test('write: the Run value is the exe wrapped in exactly ONE pair of quotes', () => {
  assert.equal(loginItemPath(SPACED), `"${SPACED}"`);
  assert.equal(loginItemPath(PLAIN), `"${PLAIN}"`);
  // Idempotent: an already-quoted input is never double-quoted.
  assert.equal(loginItemPath(`"${SPACED}"`), `"${SPACED}"`);
  const electron = fakeElectron(undefined);
  electron.setLoginItemSettings({ openAtLogin: true, path: loginItemPath(SPACED) });
  assert.equal(electron.runValue, `"${SPACED}"`);
  assert.doesNotMatch(electron.runValue, /""/, 'no double quotes');
  assert.equal((electron.runValue.match(/"/g) ?? []).length, 2);
});

test('read: a quoted Run value (current installer / new write) reports ON with one native read', () => {
  const electron = fakeElectron(`"${SPACED}"`);
  assert.equal(readWith(electron, SPACED), true);
  assert.deepEqual(electron.reads, [`"${SPACED}"`], 'the quoted form is tried first; no second read when it matches');
});

test('migration: an old UNQUOTED Run value still reports ON (space-free and spaced installs)', () => {
  for (const exe of [PLAIN, SPACED]) {
    const electron = fakeElectron(exe);
    assert.equal(readWith(electron, exe), true, `legacy unquoted value must read as ON: ${exe}`);
    assert.deepEqual(electron.reads, [`"${exe}"`, exe]);
    // The next write replaces it with the quoted form, which then reads ON directly.
    electron.setLoginItemSettings({ openAtLogin: true, path: loginItemPath(exe) });
    assert.equal(electron.runValue, `"${exe}"`);
    electron.reads.length = 0;
    assert.equal(readWith(electron, exe), true);
    assert.equal(electron.reads.length, 1);
  }
});

test('read: no Run value, or a value for another exe, reports OFF', () => {
  assert.equal(readWith(fakeElectron(undefined), SPACED), false);
  assert.equal(readWith(fakeElectron('"C:\\Other\\App.exe"'), SPACED), false);
  assert.equal(readWith(fakeElectron(`"${SPACED}" --hidden`), SPACED), false, 'args are part of the compared string');
  assert.equal(legacyLoginItemPath(`"${SPACED}"`), SPACED, 'legacy form is the bare path');
});

test('toggle round-trip: ON then OFF leaves no Run value; OFF reads OFF', () => {
  const electron = fakeElectron(undefined);
  electron.setLoginItemSettings({ openAtLogin: true, path: loginItemPath(SPACED) });
  assert.equal(readWith(electron, SPACED), true);
  electron.setLoginItemSettings({ openAtLogin: false, path: loginItemPath(SPACED) });
  assert.equal(electron.runValue, undefined);
  assert.equal(readWith(electron, SPACED), false);
});

test('index.ts: read and write both use the quoted helper; the native read stays confined to refreshAutoLaunch', () => {
  const code = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const toggle = code.slice(code.indexOf('ipcMain.handle("toggle-auto-launch"'), code.indexOf('ipcMain.handle("get-auto-launch"'));
  assert.match(toggle, /app\.setLoginItemSettings\(\{\s*openAtLogin:\s*enable,\s*path:\s*loginItemPath\(app\.getPath\("exe"\)\)\s*\}\)/,
    'the write must pass the QUOTED path');
  const refresh = /function refreshAutoLaunch\(\)[\s\S]*?\n\}/.exec(code)?.[0] ?? '';
  assert.match(refresh, /readOpenAtLogin\(\(\w+\)\s*=>\s*app\.getLoginItemSettings\(\{\s*path:\s*\w+\s*\}\)\.openAtLogin,\s*app\.getPath\("exe"\)\)/,
    'the read must compare against the same quoted path (with the legacy fallback)');
  assert.equal([...code.matchAll(/readOpenAtLogin\(/g)].length, 1, 'readOpenAtLogin is called only inside refreshAutoLaunch');
  assert.doesNotMatch(code, /setLoginItemSettings\(\{[^}]*path:\s*app\.getPath\("exe"\)\s*\}/, 'no unquoted write may remain');
});
