import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// ───────────────────────────────────────────────────────────────────────────
// DEFECT: every "Copy" button in the app silently fails to copy.
//
// MEASURED ROOT CAUSE (not assumed). A probe reproducing this app's exact
// renderer context — webPreferences { sandbox: true, contextIsolation: true,
// nodeIntegration: false } from src/main/index.ts:343-348, the production CSP
// from src/main/electron-security.ts:1 installed via onHeadersReceived, and the
// packaged file:// origin from loadFile() at src/main/index.ts:353 — established
// under Electron 31.7.7:
//
//   location.protocol            file:
//   window.isSecureContext       true      <- file:// IS a secure context
//   typeof navigator.clipboard   object    <- the API is PRESENT
//   navigator.clipboard.writeText function
//   permissions.query('clipboard-write')  granted
//
//   document focused  -> writeText() RESOLVED and the text LANDED
//   document blurred  -> writeText() REJECTED:
//        NotAllowedError: Failed to execute 'writeText' on 'Clipboard':
//        Document is not focused.
//   main-process clipboard.writeText() while blurred -> LANDED
//
// So the popular explanations are all REFUTED: it is not an absent API, not an
// insecure origin, not the CSP, not the sandbox, and not a missing user gesture
// (a focused write needs no gesture). The renderer clipboard is FOCUS-DEPENDENT,
// and this app is tray-resident (src/main/index.ts:331 shows the window from the
// tray, and hides rather than closes at :365-370), so a visible-but-unfocused
// window is an ordinary state here, not a corner case.
//
// The failure is SILENT because the handlers throw the rejection away:
// Endpoint.tsx and Models.tsx both `catch { /* ignore */ }`, so the button
// produces no clipboard write, no error, and not even its own "Copied" tick.
// That is exactly the user report: "the buttons do nothing".
//
// REQUIRED BEHAVIOUR: renderer copy routes through a narrow, write-only IPC
// channel so Electron's own main-process clipboard performs the write (proven
// focus-independent above), main validates the payload, and every failure is
// surfaced to the user instead of swallowed.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Every renderer module that owns a copy affordance, with the helper that
 * performs the write and the user-visible surface it must report failure on.
 * Enumerated by searching src/renderer/** for clipboard / writeText / copy and
 * for i18n keys containing "copy" — the user said "buttons", plural.
 */
const COPY_MODULES = [
  { file: 'src/renderer/views/Dashboard.tsx', helper: 'copy', buttons: 1 },
  { file: 'src/renderer/views/Endpoint.tsx', helper: 'copy', buttons: 4 },
  { file: 'src/renderer/views/Logs.tsx', helper: 'copy', buttons: 1 },
  { file: 'src/renderer/views/Models.tsx', helper: 'copy', buttons: 2 },
  { file: 'src/renderer/pet/DonationModal.tsx', helper: 'copyText', buttons: 2 }
];

/**
 * Strip comments so the assertions below judge CODE, not prose. Comments that
 * explain why navigator.clipboard was abandoned are documentation worth keeping;
 * a call to it is the defect.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('no renderer module reaches for the focus-dependent navigator.clipboard', () => {
  const offenders = [];
  for (const { file } of COPY_MODULES) {
    const source = stripComments(read(file));
    if (/navigator\.clipboard/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    'navigator.clipboard.writeText rejects with NotAllowedError whenever the document is '
    + 'not focused (measured); a tray-resident window is routinely unfocused, so these '
    + `modules must route through the main process instead: ${offenders.join(', ')}`);
});

test('no renderer module falls back to the deprecated execCommand copy', () => {
  // DonationModal used document.execCommand('copy') as its rejection fallback.
  // execCommand is deprecated, equally focus/selection sensitive, and it hid the
  // real failure behind a second silent attempt.
  const offenders = COPY_MODULES.filter(({ file }) => /execCommand/.test(read(file))).map(({ file }) => file);
  assert.deepEqual(offenders, [],
    `execCommand('copy') is not a fix for a focus-dependent clipboard: ${offenders.join(', ')}`);
});

test('every copy affordance routes through the write-only clipboard IPC bridge', () => {
  for (const { file } of COPY_MODULES) {
    const source = read(file);
    assert.match(source, /window\.electronAPI\??\.clipboard\s*\n?\s*\.writeText\(/,
      `${file} must copy via window.electronAPI.clipboard.writeText so Electron's own `
      + 'main-process clipboard performs the write');
  }
});

/** A catch block whose body holds nothing but whitespace and/or comments. */
const SILENT_CATCH = /catch\s*(\([^)]*\))?\s*\{(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*\}/;

test('no copy handler swallows a failure', () => {
  // An empty catch is what turned a rejecting promise into "the button does
  // nothing". Scoped deliberately to the copy path: an unrelated silent catch
  // elsewhere in these files (DonationModal's optional localStorage VIP flag at
  // :346-350, for instance) is not this defect and is not ours to touch.
  const offenders = [];
  for (const { file } of COPY_MODULES) {
    const source = read(file);
    for (const match of source.matchAll(/clipboard\s*\n?\s*\.writeText\(/g)) {
      const region = source.slice(match.index, match.index + 700);
      if (SILENT_CATCH.test(region)) {
        offenders.push(`${file}: silent catch in the copy path near index ${match.index}`);
      }
      if (!/copy_failed/.test(region)) {
        offenders.push(`${file}: no user-visible failure surface near the copy at index ${match.index}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `a failed copy must reach the user, never be discarded:\n  ${offenders.join('\n  ')}`);
});

test('a failed copy is reported through each view own user-visible surface', () => {
  // Each view already owns a mechanism; the fix must reuse it, not invent one.
  const REQUIRED_SURFACE = {
    'src/renderer/views/Dashboard.tsx': /announce\(t\('copy_failed'\)\)/,
    'src/renderer/views/Endpoint.tsx': /t\('copy_failed'\)/,
    'src/renderer/views/Logs.tsx': /announce\(t\('copy_failed'\)\)/,
    'src/renderer/views/Models.tsx': /t\('copy_failed'\)/,
    'src/renderer/pet/DonationModal.tsx': /t\('copy_failed'\)/
  };
  for (const [file, pattern] of Object.entries(REQUIRED_SURFACE)) {
    assert.match(read(file), pattern,
      `${file} must surface a copy failure using its existing notification mechanism`);
  }
});

test('the success indicator only appears after the copy actually succeeded', () => {
  // DonationModal set its "COPIED" state unconditionally, so the UI claimed
  // success even when the write never happened. A confident lie is worse than
  // silence: the user walks away with an empty clipboard.
  const donation = read('src/renderer/pet/DonationModal.tsx');
  const handler = donation.slice(donation.indexOf('const handleCopy'));
  const body = handler.slice(0, handler.indexOf('\n  );'));
  assert.doesNotMatch(body, /^\s*copyText\(row\.value\);\s*\n\s*setCopiedId\(row\.id\);/m,
    'setCopiedId must not fire unconditionally next to a copy that can fail');
  assert.match(body, /then|await|catch/,
    'handleCopy must observe the outcome of the copy before claiming success');
});

// ---- the preload bridge: one narrow, purpose-specific, write-only channel ----

test('the preload bridge exposes exactly one narrow write-only clipboard channel', () => {
  const preload = read('src/preload/index.ts');

  assert.match(preload, /clipboard:\s*\{[^}]*writeText:\s*\(text:\s*string\)\s*=>\s*ipcRenderer\.invoke\('clipboard:write-text',\s*text\)/s,
    'the bridge must expose clipboard.writeText over a purpose-specific channel, '
    + 'matching the namespaced style of feedback / diagnostic / errorReport');

  // Write-only: a renderer must never be able to read the clipboard back. This
  // app holds NVIDIA API keys and local gateway/admin tokens.
  assert.doesNotMatch(preload, /clipboard:read|readText|clipboard:read-text/,
    'the renderer must not be able to read the clipboard back');

  // The surface must not be widened into a general clipboard passthrough.
  // Property names are read at line starts only, so the `text:` parameter and the
  // 'clipboard:write-text' channel literal inside the arrow body are not mistaken
  // for exposed methods.
  const clipboardKeys = /clipboard:\s*\{([^}]*)\}/s.exec(preload);
  assert.ok(clipboardKeys, 'the clipboard namespace must be present');
  const methodNames = [...clipboardKeys[1].matchAll(/^\s*(\w+)\s*:/gm)].map((match) => match[1]);
  assert.deepEqual(methodNames, ['writeText'],
    `the clipboard bridge must expose writeText only, found: ${methodNames.join(', ')}`);
});

test('the renderer type contract declares the clipboard bridge', () => {
  assert.match(read('src/renderer/global.d.ts'), /clipboard:\s*\{\s*\n?\s*writeText:\s*\(text:\s*string\)\s*=>\s*Promise<void>;?\s*\n?\s*\}/,
    'global.d.ts must declare clipboard.writeText so the renderer type-checks');
});

// ---- the main process handler: validation + Electron clipboard ----

test('main registers the clipboard handler with the same guards as its neighbours', () => {
  const main = read('src/main/index.ts');

  const registration = /ipcMain\.handle\("clipboard:write-text",([\s\S]*?)\n(?=ipcMain\.handle|\/\/ ----|$)/.exec(main);
  assert.ok(registration, 'main must register the clipboard:write-text handler');
  const handler = registration[1];

  // Neighbouring handlers are wrapped in wrapIpcHandler(...) and secure(...);
  // secure() enforces validateIpcSender against the allow-listed renderer URL.
  assert.match(handler, /wrapIpcHandler\("clipboard:write-text"/,
    'the handler must be wrapped in wrapIpcHandler like every neighbouring channel');
  assert.match(handler, /secure\(/,
    'the handler must be wrapped in secure() so the IPC sender frame and origin are validated');

  // It must use Electron's own clipboard module, which the probe proved works
  // regardless of renderer focus.
  assert.match(handler, /clipboard\.writeText\(/,
    "the handler must write through Electron's clipboard module");

  // The copied text is a credential in the Endpoint token case. It must never
  // be logged, echoed, or returned.
  assert.doesNotMatch(handler, /logAppEvent|console\.|JSON\.stringify/,
    'the copied text must never be logged: it can be an API key or a gateway token');
});

test('main imports clipboard from electron', () => {
  // src/main/index.ts carries a UTF-8 BOM, so the ^ anchor must tolerate it.
  assert.match(read('src/main/index.ts'), /^\ufeff?import \{[^}]*\bclipboard\b[^}]*\} from "electron";/m,
    'clipboard must come from the electron module');
});

test('main validates the clipboard payload: string type and a length cap', () => {
  const main = read('src/main/index.ts');
  const validator = /function assertClipboardText[\s\S]*?\n\}/.exec(main);
  assert.ok(validator, 'main must define an explicit validator for the clipboard payload');
  const body = validator[0];

  assert.match(body, /typeof\s+\w+\s*!==\s*"string"/,
    'a non-string payload must be rejected in main, not coerced');
  // The cap may be a named constant or a literal, but a real numeric bound must exist.
  assert.match(body, /\.length\s*>\s*(?:[\d_]+|[A-Z][A-Z0-9_]*)/,
    'an unbounded string must be rejected: a renderer must not be able to push arbitrary volume');
  const cap = /\.length\s*>\s*([A-Z][A-Z0-9_]*)/.exec(body);
  if (cap) {
    assert.match(main, new RegExp(`const ${cap[1]}\\s*=\\s*[\\d_*\\s]+;`),
      `${cap[1]} must be defined as a numeric cap in main`);
  }
  assert.match(body, /throw new Error/,
    'validation failure must throw, matching the validators in ipc-security.ts');

  // And the handler must actually call it.
  assert.match(main, /ipcMain\.handle\("clipboard:write-text",[\s\S]{0,400}?assertClipboardText\(/,
    'the handler must call the validator before touching the clipboard');
});

test('main exposes no clipboard read channel at all', () => {
  const main = read('src/main/index.ts');
  assert.doesNotMatch(main, /ipcMain\.handle\("clipboard:read/,
    'no clipboard read channel may exist: write-only is the security contract');
  assert.doesNotMatch(main, /clipboard\.readText\(/,
    'main must not read the clipboard on behalf of the renderer');
});
