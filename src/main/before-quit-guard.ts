export interface BeforeQuitGuardOptions {
  event: { preventDefault(): void };
  isQuitting(): boolean;
  setQuitting(): void;
  isControlled(): boolean;
  /**
   * Optional foreground-operation lockout (e.g. an update install in flight):
   * when it returns true the quit request is prevented and IGNORED entirely —
   * quitting is not flagged and cleanupAndQuit never runs — because letting
   * the quit proceed would bypass the foreground operation's ordering
   * guarantees (gateway child must be fully stopped before any exit).
   */
  isBlocked?(): boolean;
  log(level: string, event: string, data: Record<string, unknown>): void;
  cleanupAndQuit(): void | Promise<void>;
}

/** Handles the production before-quit listener without importing Electron in tests. */
export function handleBeforeQuit(options: BeforeQuitGuardOptions): void {
  if (options.isQuitting()) return;
  if (options.isBlocked?.()) {
    // Ignore the quit request rather than letting cleanup run concurrently
    // with the blocked foreground operation.
    options.event.preventDefault();
    options.log("info", "app_shutdown_blocked", { reason: "update_install_in_progress" });
    return;
  }
  options.setQuitting();
  if (options.isControlled()) return;

  options.event.preventDefault();
  options.log("info", "app_shutdown_initiated", { forced: false });
  void options.cleanupAndQuit();
}
