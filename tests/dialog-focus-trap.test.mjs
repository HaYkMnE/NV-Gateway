import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Regression tests for DEFECT 1 (confirmed by the width-audit): the app-level
// dialogs (FeedbackModal, AboutDialog — and, per the later UI audit, the pet
// DonationModal) open with NO focus management — focus
// stays on the opener, Tab escapes into the page behind, and closing drops
// focus into the void. Minimum contract pinned here:
//   1. ONE shared hook/helper implementation (not duplicated logic),
//   2. on open focus moves INTO the dialog (first focusable, container fallback),
//   3. Tab/Shift+Tab are trapped within the dialog subtree,
//   4. on close (button/Esc/backdrop — all unmount paths) focus returns to the
//      element that opened the dialog.
// Style follows frontend-defects.test.mjs / p1-frontend.test.mjs: the trap's
// decision logic is pinned as a PURE helper exercised through the built
// behavior bundle (DOM-free, real assertions), while React/DOM wiring (which
// this node:test environment cannot render — there is no JSDOM and the repo
// has no React testing library) is pinned at the source level. Live-only
// behavior is marked in the report, not claimed here.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// ── 1. Pure focus-trap decision helper (the one non-trivial piece) ───────────
test('nextFocusTarget wraps Tab inside the dialog subtree and pulls stray focus back in', async () => {
  const source = read('src/renderer/lib/frontend-behavior.ts');
  const compiled = (await import('typescript')).default.transpileModule(source, {
    compilerOptions: { module: 1, target: 7 },
  }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', compiled)(module, module.exports);
  const helpers = module.exports;
  assert.equal(typeof helpers.nextFocusTarget, 'function',
    'a pure nextFocusTarget helper must exist in frontend-behavior.js so ONE implementation is shared by both dialogs');
  assert.equal(typeof helpers.FOCUSABLE_SELECTOR, 'string',
    'the focusable-element selector must be a shared constant');
  assert.match(helpers.FOCUSABLE_SELECTOR, /button/, 'selector must cover buttons');
  assert.match(helpers.FOCUSABLE_SELECTOR, /input/, 'selector must cover inputs');
  assert.match(helpers.FOCUSABLE_SELECTOR, /tabindex/, 'selector must honor [tabindex]');
  assert.match(helpers.FOCUSABLE_SELECTOR, /:not\(\[disabled\]\)/,
    'selector must exclude disabled native controls so the trap never targets an unfocusable button');
  assert.match(helpers.FOCUSABLE_SELECTOR, /aria-disabled/,
    'selector must exclude controls marked aria-disabled from the focus cycle');

  // Stable stub elements (the helper is element-agnostic — pure array math).
  const [a, b, c] = ['a', 'b', 'c'];
  const list = [a, b, c];
  // Forward Tab in the middle of the dialog: nothing to wrap — let the browser move.
  assert.equal(helpers.nextFocusTarget(list, b, false), null,
    'a mid-dialog Tab must return null so the browser handles the move');
  // Forward Tab on the LAST focusable wraps to the first (this is the trap).
  assert.equal(helpers.nextFocusTarget(list, c, false), a,
    'Tab from the last focusable must wrap to the first instead of escaping the dialog');
  // Backward Tab on the FIRST focusable wraps to the last.
  assert.equal(helpers.nextFocusTarget(list, a, true), c,
    'Shift+Tab from the first focusable must wrap to the last');
  // Backward Tab in the middle: browser handles it.
  assert.equal(helpers.nextFocusTarget(list, b, true), null);
  // Focus outside the dialog entirely (e.g. still on the page behind): pull it in.
  assert.equal(helpers.nextFocusTarget(list, null, false), a,
    'Tab with focus outside the dialog must be pulled to the first focusable');
  assert.equal(helpers.nextFocusTarget(list, null, true), c,
    'Shift+Tab with focus outside must be pulled to the last focusable');
  // A dialog with nothing focusable falls back to the container itself.
  assert.equal(helpers.nextFocusTarget([], a, false), null);
});

// ── 2. ONE shared hook, DOM-wired, used by both dialogs ──────────────────────
test('a single shared useDialogFocus hook implements open-focus, Tab trap and close-restore', () => {
  const hook = read('src/renderer/lib/use-dialog-focus.ts');
  // Remembers the opener BEFORE moving focus.
  assert.match(hook, /const opener = document\.activeElement/,
    'the hook must capture document.activeElement as the opener on open');
  // Moves focus INTO the dialog: first focusable, dialog container as fallback.
  assert.match(hook, /querySelectorAll?<HTMLElement>\(FOCUSABLE_SELECTOR\)/,
    'the hook must query the dialog subtree with the shared FOCUSABLE_SELECTOR');
  assert.match(hook, /\?\? dialog\)\.focus\(\)/,
    'when the dialog has no focusable child the container itself must receive focus');
  assert.match(hook, /\.focus\(\)/, 'an explicit focus() call must happen on open');
  // Traps Tab via the shared pure helper and only suppresses the browser default
  // when the helper says the move would escape the dialog.
  assert.match(hook, /event\.key !== 'Tab'/, 'the keydown handler must react only to Tab/Shift+Tab');
  assert.match(hook, /nextFocusTarget\(/, 'the handler must delegate to the ONE shared pure helper');
  assert.match(hook, /event\.preventDefault\(\);?\s*\n?\s*target\.focus\(\)/,
    'on a wrap the default must be prevented and the wrapped target focused');
  // Cleanup runs for EVERY close path (X button, Esc, backdrop, unmount) because
  // all of them flip isOpen/unmount the dialog — focus must return to the opener.
  assert.match(hook, /return \(\) => \{[\s\S]*removeEventListener[\s\S]*\};?\s*\}, \[dialogRef, isOpen\]\);/,
    'the effect cleanup must remove the keydown listener and restore focus');
  assert.match(hook, /opener\.focus\(\)/, 'cleanup must refocus the opener');
  assert.match(hook, /document\.contains\(opener\)/,
    'cleanup must not refocus a detached opener (defensive guard)');
});

// ── 3. FeedbackModal: wired to the hook, dialog container focusable ─────────
test('FeedbackModal uses the shared hook (dialogRef is no longer a dead ref)', () => {
  const modal = read('src/renderer/components/FeedbackModal.tsx');
  assert.match(modal, /import \{ useDialogFocus \} from '\.\.\/lib\/use-dialog-focus'/,
    'FeedbackModal must import the shared hook');
  assert.match(modal, /useDialogFocus\(dialogRef, isOpen\)/,
    'FeedbackModal must activate the hook with its existing dialogRef (no layout/style changes)');
  // The container must be programmatically focusable for the empty-subtree fallback.
  assert.match(modal, /ref=\{dialogRef\}\s*\n\s*role="dialog"\s*\n\s*aria-modal="true"\s*\n\s*tabIndex=\{-1\}/,
    'the role=dialog container must keep ref/aria-modal and gain tabIndex={-1} (focus fallback only)');
  // The defect root: dialogRef existed but was never focused. The hook now owns focus.
  assert.doesNotMatch(modal, /dialogRef\.current/,
    'focus handling must live in the shared hook, not re-implemented in the component');
});

// ── 4. AboutDialog: gains the ref it never had, wired to the same hook ─────
test('AboutDialog uses the same shared hook with a newly created dialog ref', () => {
  const dialog = read('src/renderer/components/AboutDialog.tsx');
  assert.match(dialog, /import \{ useDialogFocus \} from '\.\.\/lib\/use-dialog-focus'/,
    'AboutDialog must import the shared hook (ONE implementation reused, not duplicated)');
  assert.match(dialog, /const dialogRef = useRef<HTMLDivElement>\(null\)/,
    'AboutDialog must create the dialog ref it previously lacked');
  assert.match(dialog, /useDialogFocus\(dialogRef, isOpen\)/,
    'AboutDialog must activate the hook');
  assert.match(dialog, /ref=\{dialogRef\}\s*\n\s*role="dialog"\s*\n\s*aria-modal="true"\s*\n\s*tabIndex=\{-1\}/,
    'the role=dialog container must gain ref + tabIndex={-1} without layout/style changes');
});

test('SendErrorsDialog uses the shared hook instead of leaving focus in the Logs page', () => {
  const logs = read('src/renderer/views/Logs.tsx');
  assert.match(logs, /import \{ useDialogFocus \} from '\.\.\/lib\/use-dialog-focus'/,
    'Logs must import the one shared dialog-focus hook');
  assert.match(logs, /function SendErrorsDialog[\s\S]*?const dialogRef = useRef<HTMLDivElement>\(null\)/,
    'SendErrorsDialog must own a ref for its dialog container');
  assert.match(logs, /function SendErrorsDialog[\s\S]*?useDialogFocus\(dialogRef, true\)/,
    'the mounted SendErrorsDialog must activate the shared focus trap');
  assert.match(logs, /ref=\{dialogRef\}\s*\n\s*role="dialog"\s*\n\s*aria-modal="true"\s*\n\s*tabIndex=\{-1\}/,
    'SendErrorsDialog must wire its ref and focus fallback to the role=dialog container');
});

// ── 5. Anti-duplication guard ────────────────────────────────────────────────
test('focus management exists exactly once in the renderer (no duplicated trap logic)', () => {
  const files = fs.readdirSync(path.join(root, 'src/renderer/lib'))
    .filter((f) => /^use-dialog-focus/.test(f));
  assert.deepEqual(files, ['use-dialog-focus.ts'],
    'there must be exactly one dialog-focus module in src/renderer/lib');
});

// ── 6. DonationModal: same defect class, fixed through the SAME hook ─────────
//   src/renderer/pet/DonationModal.tsx had an Esc handler but never used
//   useDialogFocus: opening the donation dialog left focus on the pet widget
//   launch button, Tab escaped to the page, and closing dropped focus into the
//   void. The dialog actually renders TWO role="dialog" containers — the main
//   panel and the enlarged-QR scan overlay that stacks above it. Both must go
//   through the ONE shared hook, and the two traps must not fight: while the
//   overlay is open the main dialog's trap is suspended (otherwise a Tab meant
//   for the overlay would be yanked back into the main dialog behind it,
//   because document-level handlers of both hooks would both react).
test('DonationModal wires the shared useDialogFocus hook to its main dialog and the QR overlay, without the two traps fighting', () => {
  const modal = read('src/renderer/pet/DonationModal.tsx');
  assert.match(modal, /import \{ useDialogFocus \} from '\.\.\/lib\/use-dialog-focus'/,
    'DonationModal must import the ONE shared hook (no local re-implementation)');
  assert.match(modal, /const dialogRef = useRef<HTMLDivElement>\(null\)/,
    'DonationModal must create the main-dialog ref (it previously had none)');
  assert.match(modal, /const qrDialogRef = useRef<HTMLDivElement>\(null\)/,
    'the enlarged-QR overlay (a second role="dialog") needs its own ref');
  assert.match(modal, /useDialogFocus\(dialogRef, open && qrRow === null\)/,
    'the main dialog trap must be suspended while the QR overlay is open, otherwise the two document-level Tab handlers fight over the same keypress');
  assert.match(modal, /useDialogFocus\(qrDialogRef, open && qrRow !== null\)/,
    'the QR overlay must trap focus only while its parent Donation modal is actually open');
  // Both dialog containers must be programmatically focusable for the
  // empty-subtree fallback, exactly like FeedbackModal/AboutDialog.
  assert.match(modal, /ref=\{dialogRef\}\s*\n\s*role="dialog"\s*\n\s*aria-modal="true"\s*\n\s*tabIndex=\{-1\}/,
    'the main role=dialog container must carry ref + tabIndex={-1} (focus fallback only, no layout change)');
  assert.match(modal, /ref=\{qrDialogRef\}\s*\n\s*role="dialog"\s*\n\s*aria-modal="true"\s*\n\s*tabIndex=\{-1\}/,
    'the QR overlay role=dialog container must carry ref + tabIndex={-1} the same way');
  // The existing Esc layering (overlay closes first, then the modal) must be kept.
  assert.match(modal, /if \(qrRow\) setQrRow\(null\);\s*\n\s*else onClose\(\);/,
    'the Esc layering (overlay first, then the modal) must be preserved');
});
