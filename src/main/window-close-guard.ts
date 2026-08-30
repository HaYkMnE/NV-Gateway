// Window-close decision for a tray-resident app, kept free of Electron imports
// so it is unit-testable with plain node:test (same shape as before-quit-guard.ts
// and tray-icons.ts).
//
// WHY THIS EXISTS — measured, not assumed. The reported defect was "X kills the
// app" plus "the tray icon never appears". On the reporter's machine
// %APPDATA%/NV-Gateway/logs/app.jsonl showed tray_created == app_start == 62
// with zero uncaught_exception / unhandled_rejection / fatal_shutdown, and
// resources/assets shipped every icon file, so the tray WAS created every time
// and new Tray() never threw. What actually happened: Windows 11 filed the icon
// in the hidden overflow flyout (HKCU\Control Panel\NotifyIconSettings held an
// IconSnapshot for the exe but no IsPromoted), and the old close handler hid the
// window UNCONDITIONALLY. Hiding the only visible surface while the icon sits
// behind the chevron leaves a live, invisible, unquittable process — six were
// running while the reporter believed the app was dead. Both symptoms are that
// one state seen from two sides.
//
// The rule enforced here: NEVER swallow a close unless there is a tray to
// return from. No tray -> let the close proceed, so the window manager and
// window-all-closed can take the app down through the normal flushing quit path.

export type WindowCloseOutcome = "hidden" | "closing";

export interface WindowCloseDecision {
  event: { preventDefault(): void };
  /** A quit is already in flight; the close must not be interfered with. */
  isQuitting(): boolean;
  /** Whether a tray icon exists to restore the window from. */
  hasTray(): boolean;
  hide(): void;
  /**
   * Invoked at most once per guard, on the first hide, to tell the user the app
   * is still alive in the tray. Cosmetic: a throw here must never change close
   * semantics, so it is caught.
   */
  onFirstHide?(): void;
  log(level: string, event: string, data: Record<string, unknown>): void;
}

export interface WindowCloseGuard {
  (decision: WindowCloseDecision): WindowCloseOutcome;
}

export function createWindowCloseGuard(): WindowCloseGuard {
  let announced = false;

  return function handleWindowClose(decision: WindowCloseDecision): WindowCloseOutcome {
    // A quit already began (tray Quit, menu Quit, updater install, OS shutdown):
    // the close is part of teardown, so stay out of its way.
    if (decision.isQuitting()) return "closing";

    if (!decision.hasTray()) {
      // No tray to come back from. Preventing this close is what stranded the
      // user with an invisible process, so the close is allowed to proceed and
      // the degraded state is made visible in the log.
      // Field names are kept to the ones already in the repo's measured logged-
      // field census (see tests/report-sanitizer-name-matching.test.mjs).
      decision.log("warn", "window_close_without_tray", {
        outcome: "closing",
        reason: "no_tray_to_restore_from"
      });
      return "closing";
    }

    decision.event.preventDefault();
    decision.hide();

    if (!announced) {
      announced = true;
      try {
        decision.onFirstHide?.();
      } catch (error) {
        // A failed balloon/notification must not turn into a failed hide.
        decision.log("warn", "tray_hide_notice_failed", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return "hidden";
  };
}
