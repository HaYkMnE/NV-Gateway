import { shell } from "electron";

/**
 * Safe external-link opening for the renderer.
 *
 * Mirrors the feedback-service pattern: the renderer never navigates and
 * never gets `window.open` (both are denied by electron-security.ts) — it
 * asks the main process over IPC, and the main process validates the URL
 * against a strict allowlist BEFORE handing it to `shell.openExternal`.
 */

/** Hostnames that may ever be opened externally (support / donation platforms, project repository). */
const ALLOWED_EXTERNAL_HOSTS: ReadonlySet<string> = new Set([
  "patreon.com",
  "www.patreon.com",
  "ko-fi.com",
  "www.ko-fi.com",
  "t.me",
  "www.t.me",
  "telegram.org",
  "www.telegram.org",
  "github.com",
  "www.github.com",
]);

export function isAllowedExternalUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_EXTERNAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export async function openExternalUrl(value: unknown): Promise<void> {
  if (!isAllowedExternalUrl(value)) {
    throw new Error("External URL is not on the allowlist.");
  }
  await shell.openExternal(value);
}
