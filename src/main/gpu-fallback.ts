/**
 * MASTER-010: Chromium's GPU process cannot start on some hosts (a VM without
 * GPU passthrough, a Remote Desktop session, corrupted drivers). It then
 * crash-loops and fires a native abort() — no JS exception, no
 * uncaughtException, no fatalShutdownAndExit, no keys.json flush. The HUD is
 * simple forms and tables, so software rendering is sufficient.
 *
 * This module holds the three dependency-free decisions of the layered
 * mitigation, kept out of index.ts so each is unit-testable on its own:
 *   1. should the app start with hardware acceleration disabled (operator
 *      opt-out, a detected remote session, or the crash marker left by a
 *      previous GPU crash),
 *   2. where that crash marker lives and how it is recorded/consumed,
 *   3. what a `child-process-gone` event means for recovery.
 *
 * There is no reliable in-process VM probe (the audit's own conclusion), so
 * VM detection is deliberately absent; a VM that truly cannot start the GPU
 * process is caught by the crash handler instead.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface GpuEnvironment {
  /** NV_GATEWAY_DISABLE_GPU — the explicit operator opt-out. */
  disableGpu?: string | undefined;
  /** Windows session name: "Console" locally, "RDP-Tcp#<n>" over Remote Desktop. */
  sessionName?: string | undefined;
  /** Windows name of the remote client attached to this session (RDP only). */
  clientName?: string | undefined;
}

/**
 * A Remote Desktop / remote-display session. Windows reports the session name
 * "RDP-Tcp#<n>" for an RDP session, and sets CLIENTNAME to the connecting
 * machine; both are environment facts, so no native dependency is needed.
 * A console session reports SESSIONNAME=Console with no CLIENTNAME, which must
 * NOT disable acceleration (the control case).
 */
export function isRemoteSession(env: GpuEnvironment = {}): boolean {
  const sessionName = typeof env.sessionName === "string" ? env.sessionName.trim().toUpperCase() : "";
  if (sessionName.includes("RDP")) return true;
  const clientName = typeof env.clientName === "string" ? env.clientName.trim() : "";
  // CLIENTNAME is the name of the client attached to the session. Some Windows
  // configurations report the literal "Console" for a LOCAL session, so a
  // non-empty value alone is not proof of a remote client — only a named remote
  // client (e.g. "RDP-Tcp#12" or a workstation) is. The comparison is
  // case-insensitive because the value's casing is not contractual.
  return clientName.length > 0 && clientName.toLowerCase() !== "console";
}

/** The operator opt-out, the argv opt-out, or a detected remote session. */
export function shouldDisableHardwareAcceleration({ env = {}, argv = [] }: { env?: GpuEnvironment; argv?: readonly string[] } = {}): boolean {
  if (env.disableGpu === "1") return true;
  if (Array.isArray(argv) && argv.includes("--disable-gpu")) return true;
  return isRemoteSession(env);
}

/**
 * The crash marker lives beside the app's other runtime state (migration-phase
 * audit uses the same base). Its presence means "the previous launch lost its
 * GPU process", so the next launch starts in software rendering. The argument
 * is app.getPath("userData") (%APPDATA%/NV-Gateway normally, the
 * --user-data-dir of an isolated run).
 */
export function gpuCrashMarkerPath(appDataPath: string): string {
  return path.join(appDataPath, "gpu-crash.marker");
}

export function gpuCrashMarkerPresent(appDataPath: string): boolean {
  try {
    fs.statSync(gpuCrashMarkerPath(appDataPath));
    return true;
  } catch {
    return false;
  }
}

export function writeGpuCrashMarker(appDataPath: string, details: { reason?: string; exitCode?: number } = {}): void {
  const file = gpuCrashMarkerPath(appDataPath);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      recordedAt: new Date().toISOString(),
      reason: details.reason ?? null,
      exitCode: details.exitCode ?? null
    }), "utf8");
  } catch {
    // Best-effort: an unwritable marker must not stop the recovery relaunch.
  }
}

/**
 * Consume the marker: it arms software rendering for exactly ONE launch. That
 * launch cannot crash-relaunch again (see planGpuCrashRecovery), so the loop is
 * impossible; and because the marker is gone, a machine whose GPU recovers is
 * not locked into software rendering forever.
 */
export function clearGpuCrashMarker(appDataPath: string): void {
  try {
    fs.unlinkSync(gpuCrashMarkerPath(appDataPath));
  } catch {
    // Absent marker is the normal case.
  }
}

export interface GpuChildProcessGoneDetails {
  type?: string;
  reason?: string;
  exitCode?: number;
}

/**
 * - "ignore": not a GPU crash (every other child process type, and a clean GPU
 *   exit, is routine and must not trigger recovery).
 * - "log-only": a real GPU crash, but a relaunch cannot help — either software
 *   rendering is already active (it was disabled at startup), or this session
 *   already requested its one recovery.
 * - "record-and-relaunch": record the crash and restart once into software
 *   rendering, through the graceful quit path so keys.json is flushed.
 */
export type GpuCrashRecovery = "ignore" | "log-only" | "record-and-relaunch";

export function planGpuCrashRecovery(
  details: GpuChildProcessGoneDetails | undefined,
  { alreadySoftwareRendering, recoveryRequested }: { alreadySoftwareRendering: boolean; recoveryRequested: boolean }
): GpuCrashRecovery {
  if (!details || details.type !== "GPU") return "ignore";
  if (details.reason === "clean-exit") return "ignore";
  if (recoveryRequested || alreadySoftwareRendering) return "log-only";
  return "record-and-relaunch";
}
