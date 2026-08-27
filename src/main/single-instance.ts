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
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  return true;
}
