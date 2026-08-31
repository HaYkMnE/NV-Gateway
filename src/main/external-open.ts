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

/** Cap on renderer-supplied input. */
const MAX_EXTERNAL_URL_LENGTH = 2048;

/**
 * Parse, validate, and hand back THE URL THAT WAS VALIDATED.
 *
 * Returning the parsed object is the whole point. This logic used to live inside
 * `isAllowedExternalUrl`, which answered a boolean, so `openExternalUrl` decided
 * on the parsed `URL` and then passed `shell.openExternal` the RAW input string
 * — the representation that was checked and the one the OS received could
 * differ.
 *
 * Measured: an input carrying a fullwidth `ｇ` validates as host `github.com`
 * (UTS46 maps it) while the OS got the literal fullwidth bytes; likewise for
 * tab, newline and NUL, which the parser strips out entirely. Browsers apply the
 * same normalisation, so the destination did not actually differ — but
 * validating one representation and using another is how this class of control
 * eventually fails. Callers now open `url.href`, which is by construction the
 * thing that passed validation.
 *
 * Confirmed byte-for-byte on all six links the product really opens (both repo
 * URLs and the four donation links, including the long Telegram `?startapp=`
 * payload): `new URL(link).href === link` for every one. So this is a no-op for
 * legitimate input and cannot re-encode a query or add a trailing slash to a
 * live link.
 */
function parseAllowedExternalUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > MAX_EXTERNAL_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    // THE PORT IS PART OF THE DESTINATION. `url.port` is the empty string when
    // the authority carries no port OR carries the scheme's default, because the
    // WHATWG parser strips a default port while parsing — measured:
    // `new URL("https://github.com:443/…").port === ""`. Requiring the empty
    // string therefore accepts the bare form AND an explicit `:443` (identical
    // destinations, and `href` comes back without the port) while rejecting
    // every other port: 8080, 80, 0, 65535. That needs no special case for 443
    // and no port list to keep in sync, and it is the narrowest rule available.
    // All six links the product really opens carry no port.
    //
    // Before this, the check never looked at `url.port`, so
    // `https://github.com:8080/HaYkMnE/NV-Gateway` and
    // `https://ko-fi.com:8080/haykmne` were both allowed. The hostname was still
    // the operator's, so neither could reach a third party's server and in
    // practice the connection simply fails — but a control whose entire job is
    // constraining the destination was leaving part of it unconstrained.
    if (url.protocol === "https:" && url.port === "") {
      const allowed = ALLOWED_EXTERNAL_HOSTS.has(url.hostname) || isAllowedRepoUrl(url);
      return allowed ? url : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function isAllowedExternalUrl(value: unknown): value is string {
  return parseAllowedExternalUrl(value) !== null;
}

export async function openExternalUrl(value: unknown): Promise<void> {
  const url = parseAllowedExternalUrl(value);
  if (!url) {
    throw new Error("External URL is not on the allowlist.");
  }
  // `url.href`, NOT `value`: the OS gets the representation that was validated.
  await shell.openExternal(url.href);
}
