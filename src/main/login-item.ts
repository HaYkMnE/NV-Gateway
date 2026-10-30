/**
 * Windows login-item (HKCU\Software\Microsoft\Windows\CurrentVersion\Run) path form.
 *
 * VERIFIED against Electron 31.7.7 shell/browser/browser_win.cc:
 *   :140-152  FormatCommandLineString uses the `path` option VERBATIM (it adds no
 *             quotes) and only appends " " + args.join(" ").
 *   :631-633  setLoginItemSettings writes that string as the Run value.
 *   :670-672  getLoginItemSettings().openAtLogin = (Run value == that same string),
 *             a plain string equality.
 * So the caller must quote the exe itself (an unquoted path with a space is the
 * unquoted-path risk: Windows may try C:\...\NV.exe first), and read and write must
 * pass the SAME string, or the switch shows OFF while autostart is ON.
 *
 * Pure (no electron import) so it is unit-testable; index.ts supplies the native read.
 */

/** The exe wrapped in exactly one pair of quotes (idempotent: never double-quotes). */
export function loginItemPath(exePath: string): string {
  return `"${exePath.replace(/^"+|"+$/g, "")}"`;
}

/** The bare, unquoted form that builds before the quoting fix wrote. */
export function legacyLoginItemPath(exePath: string): string {
  return exePath.replace(/^"+|"+$/g, "");
}

/**
 * openAtLogin for this exe. Tries the quoted form first (current writer, current
 * installer); only when that does not match, falls back to the legacy UNQUOTED form
 * so an install upgraded from a space-free path still reads ON. The next toggle then
 * rewrites the value in the quoted form. `readNative` performs ONE native read per call.
 */
export function readOpenAtLogin(readNative: (path: string) => boolean, exePath: string): boolean {
  return readNative(loginItemPath(exePath)) || readNative(legacyLoginItemPath(exePath));
}
