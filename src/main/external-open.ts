import { shell } from "electron";

/**
 * Safe external-link opening.
 *
 * The renderer never navigates and never gets `window.open` (both are denied by
 * electron-security.ts) — it asks the main process over IPC, and the main
 * process validates the URL against a strict allowlist BEFORE handing it to
 * `shell.openExternal`.
 *
 * WHAT IS ACTUALLY GUARANTEED, AND BY WHICH DOOR. This file owns the allowlist,
 * so a claim made here reads as a whole-app invariant. It previously described
 * only the `shell:open-external` route, while `feedback-service.ts` called
 * `shell.openExternal` directly and never passed through this allowlist — so the
 * claim was not true of the whole app. Both outbound doors now live here:
 *
 *   openExternalUrl — the renderer-facing door behind `shell:open-external`.
 *                     Full allowlist (donation hosts plus the one repository
 *                     path) AND the length cap, because its input is arbitrary
 *                     and renderer-supplied.
 *   openRepoUrl     — the narrower door used by `feedback-service.ts` for the
 *                     prefilled issue page. Repository path ONLY; the donation
 *                     hosts are unreachable through it.
 *
 * Every allowed destination is https, carries no explicit port, and is either an
 * allowlisted host or a path below the one repository. What is validated is also
 * what is opened: callers receive the parsed, normalised `url.href` rather than
 * the raw input string, so the two can never disagree.
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
 * Cap on the repository door (see `openRepoUrl`), deliberately far above anything
 * the product can generate.
 *
 * This door cannot redirect — every user byte goes through `encodeURIComponent`,
 * so no amount of text moves the authority or the path — but "cannot redirect" is
 * not "bounded". MEASURED before this constant existed, `openRepoUrl` accepted a
 * 10,000,054-character URL and handed all 10 MB to `shell.openExternal` without
 * complaint. The only thing actually limiting it was `redaction.ts`'s trailing
 * `.slice(0, 16_384)` — a truncation that exists for redaction reasons, in a
 * module with no stake in URL length, which a future edit could raise or remove
 * without ever looking at this file.
 *
 * The number is chosen so the cap can never be what breaks legitimate feedback:
 * the renderer caps the title at 100 and the description at 2000 characters, and
 * the worst-case encoding of those limits (emoji, 12 characters per 2 UTF-16
 * units) MEASURED at 13,514 characters. 65,536 leaves roughly 4.8x headroom over
 * the largest URL the UI can produce, while a runaway payload is refused here
 * instead of becoming a multi-megabyte argument to the OS.
 */
const MAX_REPO_URL_LENGTH = 65_536;

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
 *
 * `hostRuleMatches` selects how wide the door is, so both doors share one
 * implementation of the scheme and port checks instead of duplicating them.
 * `maxLength` is optional because the two doors have genuinely different input
 * provenance; see `openRepoUrl`.
 */
function parseAllowedUrl(
  value: unknown,
  hostRuleMatches: (url: URL) => boolean,
  maxLength?: number
): URL | null {
  if (typeof value !== "string") return null;
  if (maxLength !== undefined && value.length > maxLength) return null;
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
      return hostRuleMatches(url) ? url : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** The renderer-facing surface: the donation hosts, or the one repository path. */
function matchesExternalHostRule(url: URL): boolean {
  return ALLOWED_EXTERNAL_HOSTS.has(url.hostname) || isAllowedRepoUrl(url);
}

export function isAllowedExternalUrl(value: unknown): value is string {
  return parseAllowedUrl(value, matchesExternalHostRule, MAX_EXTERNAL_URL_LENGTH) !== null;
}

/**
 * The renderer-facing door, behind the `shell:open-external` IPC channel. Full
 * allowlist and the length cap, because the input is arbitrary and comes from
 * the renderer.
 */
export async function openExternalUrl(value: unknown): Promise<void> {
  const url = parseAllowedUrl(value, matchesExternalHostRule, MAX_EXTERNAL_URL_LENGTH);
  if (!url) {
    throw new Error("External URL is not on the allowlist.");
  }
  // `url.href`, NOT `value`: the OS gets the representation that was validated.
  await shell.openExternal(url.href);
}

/**
 * The narrow door for main-process links into THIS repository — currently the
 * prefilled issue page built by `feedback-service.ts`, which used to call
 * `shell.openExternal` directly and so never passed through this allowlist at
 * all. Strictly narrower than `openExternalUrl`: the donation hosts are not
 * reachable through it, so this adds no surface, it only removes an unvalidated
 * one.
 *
 * Bounded by `MAX_REPO_URL_LENGTH`, NOT by the 2048-character cap the
 * renderer-facing door uses. Measured at the renderer's own field limits
 * (FeedbackModal caps the title at 100 and the description at 2000 characters) the
 * prefilled issue URL runs to about 2.5 KB of ASCII and about 13.5 KB with
 * Cyrillic or emoji text, so applying 2048 here would reject legitimate feedback
 * and break "Open GitHub issue".
 *
 * Redirection is not the risk on this path: the URL is rooted in the compiled
 * `REPO_ISSUES_URL` and every user byte goes through `encodeURIComponent`, which
 * percent-encodes "/", ":", "?", "#" and "@" — so no amount of user text can move
 * the authority or the path. But not being able to redirect is not the same as
 * being bounded, and this door was previously bounded only by an incidental
 * `.slice(0, 16_384)` in `redaction.ts`; see `MAX_REPO_URL_LENGTH`.
 *
 * The destination is validated in full regardless, which is what makes the header's
 * claim true for this route too: if `REPO_URL` is ever edited to point somewhere
 * else, this rejects it instead of opening it.
 */
export async function openRepoUrl(value: unknown): Promise<void> {
  const url = parseAllowedUrl(value, isAllowedRepoUrl, MAX_REPO_URL_LENGTH);
  if (!url) {
    throw new Error("External URL is not on the allowlist.");
  }
  await shell.openExternal(url.href);
}
