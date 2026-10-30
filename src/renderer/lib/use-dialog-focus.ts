import { useEffect, type RefObject } from 'react';
import { FOCUSABLE_SELECTOR, nextFocusTarget } from './frontend-behavior';

/**
 * Shared focus management for app-level modal dialogs (FeedbackModal,
 * AboutDialog, DonationModal — including the donation dialog's enlarged-QR
 * overlay). ONE implementation so both dialogs behave identically:
 *  1. on open, focus moves INTO the dialog (first focusable child, with the
 *     dialog container — which must carry tabIndex={-1} — as the fallback for
 *     a focusable-free subtree);
 *  2. Tab/Shift+Tab are trapped inside the dialog subtree: edge wraps and
 *     stray focus are pulled back in via the pure nextFocusTarget helper,
 *     and preventDefault only fires when the browser would let focus escape;
 *  3. on EVERY close path (X button, Escape, backdrop — all funnel through
 *     isOpen flipping, so this effect's cleanup always runs) focus returns
 *     to the element that opened the dialog, provided it is still mounted.
 */
export function useDialogFocus(dialogRef: RefObject<HTMLElement>, isOpen: boolean): void {
  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Capture the opener BEFORE moving focus into the dialog.
    const opener = document.activeElement as HTMLElement | null;
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    (focusables[0] ?? dialog).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      const target = nextFocusTarget(items, document.activeElement as HTMLElement | null, event.shiftKey);
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    // document-level (not dialog-level) so that focus that somehow escaped to
    // the page behind the modal is caught and pulled back inside.
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [dialogRef, isOpen]);
}
