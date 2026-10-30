import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import { maskUserPaths } from "./redaction";

export function resolveWindowsSid(spawn: typeof spawnSync = spawnSync): string {
  if (process.platform !== "win32") return os.userInfo().username;
  const result = spawn("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Cannot resolve current Windows SID.");
  const match = result.stdout.match(/S-1-[0-9-]+/i);
  if (!match) throw new Error("Cannot resolve current Windows SID.");
  return `*${match[0]}`;
}

export function buildProtectedAclArgs(filePath: string, sid?: string, directory = false, spawn?: typeof spawnSync): string[] {
  let effectiveSid = sid;
  if (effectiveSid === undefined) {
    // MASTER-003: the old default parameter `sid = resolveWindowsSid()` threw
    // synchronously whenever whoami failed, and no caller had a try/catch.
    // Degrade exactly like the icacls failure path in createWindowsAclProtector:
    // warn + return empty args (icacls with no args is a harmless no-op that
    // exits non-zero immediately). The file is already mode 0o600 owner-only.
    try {
      effectiveSid = resolveWindowsSid(spawn);
    } catch {
      console.warn("[nv-gateway] ACL args degraded: cannot resolve current Windows SID; returning empty icacls args.");
      return [];
    }
  }
  if (!/^\*?S-1-[0-9-]+$/i.test(effectiveSid) && process.platform === "win32") throw new Error("Invalid Windows SID.");
  const rights = directory ? "(OI)(CI)(F)" : "(F)";
  return [path.resolve(filePath), "/inheritance:r", "/grant:r", `${effectiveSid}:${rights}`, `*S-1-5-18:${rights}`];
}

const ACL_RETRY_MS = 25;
const ACL_MAX_ATTEMPTS = 2;

export function createWindowsAclProtector(options: { sid?: string; platform?: NodeJS.Platform; execute?: (command: string, args: string[]) => { status: number | null }; spawn?: typeof spawnSync } = {}): (filePath: string, directory?: boolean) => void {
  const platform = options.platform ?? process.platform;
  let sid = options.sid;
  if (sid === undefined) {
    // MASTER-003: resolveWindowsSid() throws when whoami fails or returns no
    // SID. The index.ts call sites have no try/catch, so that throw crashed the
    // Electron main at startup — and the icacls degrade path below could never
    // catch it because it happens before any icacls run. Degrade the same way:
    // warn + no-op protector (the file is already mode 0o600 owner-only).
    try {
      sid = resolveWindowsSid(options.spawn);
    } catch {
      console.warn("[nv-gateway] ACL protector degraded: cannot resolve current Windows SID; ACL hardening disabled.");
      return () => {};
    }
  }
  const execute = options.execute ?? ((_command, args) => spawnSync("icacls.exe", args, { windowsHide: true, encoding: "utf8" }));
  return (filePath: string, directory = false): void => {
    if (platform !== "win32") return;
    const args = buildProtectedAclArgs(filePath, sid, directory);
    let attempt = 0;
    let result: { status: number | null };
    do {
      result = execute("icacls.exe", args);
      if (result.status === 0) return;
      attempt++;
      if (attempt < ACL_MAX_ATTEMPTS && process.platform === "win32") {
        // Synchronous bounded backoff (small); spawnSync is already synchronous.
        const start = Date.now();
        while (Date.now() - start < ACL_RETRY_MS) { /* spin ~25ms — tiny, bounded */ }
      }
    } while (attempt < ACL_MAX_ATTEMPTS);
    // Persistent ACL failure: log + DEGRADE (do NOT throw). The file is already
    // mode 0o600 owner-only from the open() that preceded this call (writeAppConfig,
    // writeProtected, app-logger rotation); ACL is additional hardening. Crashing
    // the Electron main here is strictly worse (5x recurring production crashes,
    // 2026-08-04/07/12x2/15) than a single unprotected-against-inheritance write.
    // The account-name segment is masked: this line reaches stderr, and stderr is
    // captured into shareable diagnostic bundles. The rest of the path is kept —
    // WHICH file failed to be protected is the whole diagnostic value here.
    console.warn(`[nv-gateway] ACL protectFile degraded after ${ACL_MAX_ATTEMPTS} attempt(s): ${maskUserPaths(filePath)}`);
  };
}

export interface RuntimeAclProtector { protectDirectory(directoryPath: string): void; protectFile(filePath: string): void }
export function createRuntimeAclProtector(options: Parameters<typeof createWindowsAclProtector>[0] = {}): RuntimeAclProtector {
  const protect = createWindowsAclProtector(options);
  return { protectDirectory: (value) => protect(value, true), protectFile: (value) => protect(value, false) };
}

export function protectWindowsFile(filePath: string): void {
  createWindowsAclProtector()(filePath, false);
}
