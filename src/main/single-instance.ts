export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: "second-instance", listener: () => void): unknown;
}

export interface FocusableWindow {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  /**
   * Optional so a plain `{ isMinimized, restore, show, focus }` test double still
   * satisfies the contract. Electron's BrowserWindow always provides it.
   */
  isDestroyed?(): boolean;
}

export function configureSingleInstance(app: SingleInstanceApp, getWindow: () => FocusableWindow | null): boolean {
  const hasLock = app.requestSingleInstanceLock();
  if (!hasLock) {
    app.quit();
    return false;
  }
  app.on("second-instance", () => {
    const window = getWindow();
    if (!window) return;
    // A falsy check guards NULL, not a DESTROYED native object: on a destroyed
    // BrowserWindow the pointer is still truthy and every call below throws
    // "TypeError: Object has been destroyed" (measured in a real launched app —
    // see tests/tray-reveal-destroyed-window.test.mjs). That throw would land in
    // an Electron event callback, reach process.on("uncaughtException") ->
    // fatalShutdownAndExit -> process.exit(1), and that raw exit skips
    // before-quit -> cleanupAndQuit -> gatewayLifecycle.stop(), i.e. the ipc
    // shutdown that flushes keys.json and the model-key affinity cache.
    //
    // Production already passes ensureMainWindow(), which rebuilds a dead window
    // and never hands one over destroyed (index.ts, pinned by that same test), so
    // this is defence for FUTURE callers wiring in the raw pointer, not a live
    // bug being papered over. Bailing out is correct here rather than rebuilding:
    // this module deliberately knows nothing about window construction.
    if (window.isDestroyed?.()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  return true;
}
