import { shell } from "electron";

/**
 * Safe external-link opening for the renderer.
 *
 * Mirrors the feedback-service pattern: the renderer never navigates and
 * never gets `window.open` (both are denied by electron-security.ts) — it
 * asks the main process over IPC, and the main process validates the URL
 * against a strict allowlist BEFORE handing it to `shell.openExternal`.
 */

/** Hostnames that may ever be opened externally (support / donation platforms). */
const ALLOWED_EXTERNAL_HOSTS: ReadonlySet<string> = new Set([
  "patreon.com",
  "www.patreon.com",
  "ko-fi.com",
  "www.ko-fi.com",
  "t.me",
  "www.t.me",
  "telegram.org",
  "www.telegram.org",
]);

/**
 * The project's real repository — the SINGLE source of truth for it inside
 * `src/**`. Both consumers import from here (`index.ts` for the About dialog's
 * `repoUrl`, `feedback-service.ts` for the prefilled issue page); nothing
 * re-hardcodes a GitHub URL.
 *
 * Why a compiled-in literal and not a runtime `package.json` read: in a
 * packaged build the app ships INSIDE `app.asar`, so any runtime read has to
 * resolve an in-archive path and is a live failure mode. A literal is emitted
 * straight into `build/src/main/external-open.js`, has no filesystem
 * dependency, and therefore cannot fail in a packaged build. Drift from
 * `package.json` is prevented by test instead of by runtime I/O:
 * `tests/repo-url-single-source.test.mjs` asserts this constant equals
 * `package.json:repository.url`.
 *
 * The slug this replaces is DEAD — its `gh api repos/<owner>/<repo>` lookup
 * returned HTTP 404 while this one returned 200 — and the dead URL was being
 * handed to `shell.openExternal`, so users really landed on a 404 page. The old
 * literal is deliberately not repeated here: a test forbids it anywhere in
 * `src/**`, including inside comments.
 */
export const REPO_URL = "https://github.com/HaYkMnE/NV-Gateway";
export const REPO_ISSUES_URL = `${REPO_URL}/issues/new`;

/**
 * `github.com` is NOT allowlisted as a host. Only this exact repository path is
 * reachable, because that is all the two links need: the repo page and its
 * issues page. A host entry would open every repository, gist path, login page
 * and redirector on github.com to anything that can reach this IPC channel;
 * path-scoping keeps the blast radius at one repository.
 */
const REPO_HOST = "github.com";
const REPO_PATH = new URL(REPO_URL).pathname; // "/HaYkMnE/NV-Gateway"

function isAllowedRepoUrl(url: URL): boolean {
  if (url.hostname !== REPO_HOST) return false;
  // Exact repo root, or a path segment BELOW it. Prefix-only matching would
  // also admit sibling repos like "/HaYkMnE/NV-Gateway-evil".
  return url.pathname === REPO_PATH || url.pathname.startsWith(`${REPO_PATH}/`);
}

export function isAllowedExternalUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") {
      return ALLOWED_EXTERNAL_HOSTS.has(url.hostname) || isAllowedRepoUrl(url);
    }
    return false;
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
