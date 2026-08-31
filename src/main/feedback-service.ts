// Feedback is saved LOCALLY and never transmitted.
//
// This module used to POST every saved entry to the reporting worker as a side
// effect of saving — including the exported diagnostic bundle as `logs` (up to
// 32 KB of gateway/app/stdio log lines). The user pressed "save" and an upload
// happened, which is exactly the behaviour the owner requirement forbids:
// nothing may leave the machine until the user explicitly asks for it.
//
// The network leg is therefore gone. What remains:
//   * the local save (the source of truth, and what the user can inspect), and
//   * openGitHubIssue(), which opens a PREFILLED browser page — the user still
//     has to review it and press GitHub's own submit button, and the app itself
//     transmits nothing.
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { exportDiagnostic } from "./diagnostic-export";
import { REPO_ISSUES_URL, openRepoUrl } from "./external-open";
import { sanitizeReportText } from "./report-sanitizer";

export interface FeedbackData {
  type: "suggestion" | "bug";
  title: string;
  description: string;
  email?: string;
  attachDiagnostic: boolean;
}

/**
 * Every LONE UTF-16 surrogate: a high surrogate not followed by a low, or a low
 * surrogate not preceded by a high. A well-formed pair never matches.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Percent-encode one field for the issue URL, repairing lone surrogates first.
 *
 * WHY. MEASURED against the built modules, feedback text containing a lone
 * surrogate made `encodeURIComponent` throw `URIError: URI malformed` right here,
 * BEFORE the allowlist in external-open.ts was ever reached:
 *
 *   description "before\uD800after" -> URIError: URI malformed, openedCount 0
 *   description "before\uDC00after" -> URIError: URI malformed, openedCount 0
 *   description "before\u{1F389}after" -> opened normally
 *
 * `wrapIpcHandler` logged it and FeedbackModal's `.catch` turned it into the
 * generic `feedback_failed` toast, so it was never a crash — but the user lost the
 * WHOLE report to a meaningless error, and the type thrown was a `URIError` from
 * the URL builder rather than the allowlist's own rejection. Lone surrogates
 * genuinely arrive from pastes whose source cut an astral character in half, so
 * this is a real path and not a synthetic one.
 *
 * WHAT THE USER LOSES, stated exactly: one U+FFFD per lone surrogate, substituted
 * in place, with the surrounding text and the string length untouched. A lone
 * surrogate is not a character — it is half of one, it has no rendering, and it is
 * already broken on arrival. U+FFFD is not an invention of this fix either: it is what
 * raw UTF-8 encoding substitutes, MEASURED as
 * `Buffer.from("ab\uD800cd", "utf8") === 6162 efbfbd 6364`.
 *
 * WHAT THIS COMMENT USED TO CLAIM, AND WHY IT WAS WRONG. It said the substitution "is
 * what the local SAVE path above already effectively writes to disk", i.e. that the
 * two feedback paths agree. MEASURED, they do NOT. The save path does not encode the
 * string as raw UTF-8; it goes through `JSON.stringify`, which emits the lone
 * surrogate as a `\uXXXX` ESCAPE and therefore preserves it:
 *
 *   JSON.stringify({ description: "ab\uD800cd" })  ->  {"description":"ab\ud800cd"}
 *   those bytes contain NO efbfbd
 *
 * So the save path keeps the broken half character and the URL path replaces it. The
 * substitution here is still the right behaviour on its own merits — a lone surrogate
 * makes `encodeURIComponent` throw and cost the user their entire report, it has no
 * rendering, and one U+FFFD is a far smaller loss than the whole report — but it is
 * NOT justified by agreement with the save path, because there is none. The two paths
 * differ, deliberately: JSON has an escape for an unpaired surrogate and a URL does
 * not.
 *
 * The alternative — surfacing an error instead — was rejected because it cannot be
 * done honestly. There is no existing localised string meaning "your text contains
 * a character that cannot go in a URL", and adding one is forbidden:
 * `src/renderer/i18n/resources.ts` holds 7 locales at exactly 301 keys and two test
 * files assert that number. Reusing an existing string would land on the same
 * generic `feedback_failed` toast the defect already produces — identical to the
 * user, while still discarding their report.
 *
 * APPLIED AT THE ENCODE SITE, not per field, on purpose. `sanitizeReportText` ends
 * in `redact()`, which ends `.slice(0, 16_384)` — a truncation that can CUT A VALID
 * SURROGATE PAIR IN HALF and so MANUFACTURE a lone surrogate that was not in the
 * user's input. Repairing here, after sanitisation and immediately before
 * encoding, covers that case too and makes the invariant simply "nothing
 * unrepaired ever reaches encodeURIComponent".
 */
function encodeFieldForUrl(value: string): string {
  return encodeURIComponent(value.replace(LONE_SURROGATE, "\uFFFD"));
}

export interface FeedbackResult {
  success: boolean;
  path?: string;
  message: string;
}

/** Injection point for tests; production resolves Electron's userData dir. */
export interface FeedbackOptions {
  userDataPath?: string;
}

function feedbackDir(options?: FeedbackOptions): string {
  const base = options?.userDataPath ?? app.getPath("userData");
  return path.join(base, "feedback");
}

export async function saveFeedback(data: FeedbackData, options?: FeedbackOptions): Promise<FeedbackResult> {
  if (!data || typeof data !== "object") {
    return { success: false, message: "Invalid feedback data." };
  }
  // ONE READ PER FIELD, into a local, before any of them is inspected — same reason
  // as openGitHubIssue below. This function previously read `data.title` at the shape
  // check and AGAIN at the sanitise call, and `data.email` twice in one expression, so
  // the value it validated was not necessarily the value it wrote to disk.
  const rawTitle = data.title;
  const rawDescription = data.description;
  const rawEmail = data.email;
  const rawType = data.type;
  const attachDiagnostic = Boolean(data.attachDiagnostic);

  if (typeof rawTitle !== "string" || typeof rawDescription !== "string") {
    return { success: false, message: "Invalid feedback data: title and description are required." };
  }
  const title = sanitizeReportText(rawTitle);
  const description = sanitizeReportText(rawDescription);
  const trimmedEmail = typeof rawEmail === "string" ? rawEmail.trim() : "";
  const email = trimmedEmail ? sanitizeReportText(trimmedEmail) : "";

  const dir = feedbackDir(options);
  fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString();
  const stamp = timestamp.replace(/[:.]/g, "-");

  let diagnosticPath: string | undefined;
  if (attachDiagnostic) {
    try {
      const result = await exportDiagnostic(options);
      if (result.success && result.path) diagnosticPath = result.path;
    } catch {
      // Diagnostic export must not block feedback submission.
    }
  }

  const entry: Record<string, unknown> = {
    timestamp,
    type: rawType === "bug" ? "bug" : "suggestion",
    title,
    description,
    attachDiagnostic
  };
  if (email) entry.email = email;
  if (diagnosticPath) entry.diagnosticPath = diagnosticPath;

  const jsonlPath = path.join(dir, "feedback.jsonl");
  try {
    fs.appendFileSync(jsonlPath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    return { success: false, message: "Failed to append feedback log." };
  }

  const standalonePath = path.join(dir, `feedback-${stamp}.json`);
  try {
    fs.writeFileSync(standalonePath, JSON.stringify(entry, null, 2), "utf8");
  } catch {
    return { success: false, message: "Failed to write feedback file." };
  }

  // NO NETWORK LEG. This is where the entry used to be POSTed to the reporting
  // worker — with the diagnostic bundle attached as `logs` — purely because the
  // user pressed "save". Saving is a local action and stays local; transmitting
  // is a separate, explicit decision the user makes elsewhere.
  return {
    success: true,
    path: standalonePath,
    message: "Feedback saved"
  };
}

// Opens a PREFILLED GitHub issue page in the user's browser. The app transmits
// nothing: the user reviews the prefilled text and presses GitHub's own submit
// button, so this remains an explicit user action end to end.
export async function openGitHubIssue(data: FeedbackData): Promise<void> {
  // ONE READ PER FIELD, into a local, BEFORE anything is used. The previous shape,
  // `typeof data.title === "string" ? data.title : String(data.title ?? "")`, read
  // `data.title` TWICE by itself, and the validator at the IPC boundary had already
  // read it once — 3 reads of one property, MEASURED. A property that returns a
  // different value on a later read therefore defeated the validation entirely: a
  // getter yielding 'short' then 1,000,000 units passed the boundary and produced a
  // 33,137-character URL. The boundary now hands this function a frozen snapshot
  // (see feedback-validation.ts), and this function reads each field once regardless,
  // so a future main-process caller that forgets to snapshot cannot reintroduce the
  // gap. `tests/feedback-ipc-payload-bounds.test.mjs` asserts the single-read shape
  // statically, per function.
  const rawTitle = data.title;
  const rawDescription = data.description;
  const rawEmail = data.email;
  const rawType = data.type;
  const attachDiagnostic = Boolean(data.attachDiagnostic);

  const title = sanitizeReportText(typeof rawTitle === "string" ? rawTitle : String(rawTitle ?? ""));
  const description = sanitizeReportText(typeof rawDescription === "string" ? rawDescription : String(rawDescription ?? ""));
  const email = typeof rawEmail === "string" && rawEmail.trim() ? sanitizeReportText(rawEmail.trim()) : "";
  const typeLabel = rawType === "bug" ? "Bug report" : "Suggestion";

  const lines: string[] = [];
  lines.push(`**Type:** ${typeLabel}`);
  lines.push("");
  lines.push(`**Title:** ${title}`);
  lines.push("");
  lines.push("### Description");
  lines.push("");
  lines.push(description);
  lines.push("");
  if (attachDiagnostic) {
    lines.push("> A diagnostic bundle was exported locally when this feedback was saved.");
    lines.push("> Please attach it to this issue if relevant.");
    lines.push("");
  }
  if (email) {
    lines.push(`**Contact:** ${email}`);
  }

  // Routed through the allowlist in external-open.ts rather than reaching for
  // Electron's shell here. This call used to hand the OS a URL that had passed
  // no validation at all, which made the invariant stated in external-open.ts
  // false for this route even though that file owns the allowlist. It is benign
  // today — the URL is built from the compiled REPO_ISSUES_URL constant plus
  // encodeURIComponent'd user text — but if that constant is ever edited to
  // point elsewhere, openRepoUrl rejects it instead of opening it. openRepoUrl is
  // scoped to this repository, so routing through it adds no reachable surface.
  // encodeFieldForUrl, NOT encodeURIComponent: a lone surrogate anywhere in the
  // title or description used to throw `URIError: URI malformed` on these two calls
  // and lose the report. See encodeFieldForUrl above for what is substituted and
  // what that costs the user.
  const url = `${REPO_ISSUES_URL}?title=${encodeFieldForUrl(title)}&body=${encodeFieldForUrl(lines.join("\n"))}`;
  await openRepoUrl(url);
}
