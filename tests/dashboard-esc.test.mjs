import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Regression test for DEFECT 2 (polish): the Dashboard inline "add key" form
// (Dashboard.tsx ~:50) ignores Escape — the only way out is the Cancel button.
// Contract: Escape closes the form and is EXACTLY equivalent to clicking
// Cancel today (which also resets the draft: setNewKey(''), setKeyError(''),
// setShowToken(false) and setAdding(false)).
//
// Pinning level: this node:test environment has no JSDOM and no React testing
// library (react-dom 18 server-only here), so a keydown cannot be dispatched
// through the React tree. We pin (a) the shared cancel implementation as a
// named function so there is exactly ONE definition, and (b) source contracts
// that the Escape branch and the Cancel button both invoke THAT function with
// an identical disabled-guard. Actual real-browser focus-return on close is
// live-only and not claimed here.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Dashboard defines one named cancelAddKey that mirrors exactly what Cancel did', () => {
  const dashboard = read('src/renderer/views/Dashboard.tsx');
  // One single definition — the Escape handler must NOT inline its own resets
  // (duplicated logic would drift from Cancel and break "equivalent").
  const defs = dashboard.match(/const cancelAddKey = \(\) => \{[^}]*\}/g) || [];
  assert.equal(defs.length, 1, 'cancelAddKey must be defined exactly once');
  const body = defs[0] || '';
  assert.match(body, /setAdding\(false\)/, 'cancel must close the form');
  assert.match(body, /setNewKey\(''\)/, 'cancel must reset the in-progress draft');
  assert.match(body, /setKeyError\(''\)/, 'cancel must clear the key error');
  assert.match(body, /setShowToken\(false\)/, 'cancel must hide the token again');
});

test('Dashboard routes Escape through cancelAddKey (same guard as the Cancel button)', () => {
  const dashboard = read('src/renderer/views/Dashboard.tsx');
  // The add-key form must carry a keydown handler that reacts to Escape and
  // delegates to the SAME named cancel the button uses.
  assert.match(dashboard, /onKeyDown=\{\(event\) => \{ if \(event\.key === 'Escape' && !addKeyMutation\.isPending\) cancelAddKey\(\); \}\}/,
    "the add-key form must handle keydown: Escape invokes cancelAddKey, guarded by the same !addKeyMutation.isPending that disables Cancel");
  // Cancel now points at the named function instead of its old inline lambda.
  assert.match(dashboard, /<button onClick=\{cancelAddKey\} disabled=\{unavailable \|\| addKeyMutation\.isPending\}/,
    'the Cancel button must call cancelAddKey and keep its disabled guard');
  // The old inline Cancel lambda (four resets baked into the button) must be
  // gone — its presence would mean a second, drifting copy of the logic.
  assert.doesNotMatch(dashboard, /onClick=\{\(\) => \{ setAdding\(false\); setNewKey\(''\); setKeyError\(''\); setShowToken\(false\); \}\}/,
    'the inline cancel lambda must be replaced by the shared cancelAddKey');
});
