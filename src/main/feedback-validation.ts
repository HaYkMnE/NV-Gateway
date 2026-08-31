// Payload validation for the two feedback IPC channels.
//
// WHY THIS FILE EXISTS. `feedback:save` and `feedback:open-github-issue` were
// wrapped in `secure()`, which is `validateIpcSender` ONLY — it proves WHO is
// speaking, never WHAT they said. So the main process trusted the renderer's
// payload completely, while its neighbours in the same file assert theirs first:
// `check-ports` calls `validators.ports` (index.ts:724), the key handlers call
// `validators.key` / `validators.uuid` / `validators.status` / `validators.reorder`
// (index.ts:768-774), `set-app-config` goes through `createAppConfigUpdateHandler`
// (app-config-ipc.ts:23-30), and `clipboard:write-text` calls
// `assertClipboardText` (index.ts:714). The feedback pair was the gap.
//
// THE UI LIMITS ARE NOT A BOUNDARY. `FeedbackModal.tsx:5-6` caps the title at 100
// and the description at 2000 with DOM `maxLength` attributes. A `maxLength`
// attribute is a typing affordance: it does not constrain programmatic value
// assignment, and anything that can reach this IPC channel never sees the DOM at
// all. The e-mail field carries no `maxLength` whatsoever.
//
// THE OLD BOUND WAS AN ACCIDENT IN AN UNRELATED MODULE. MEASURED against the built
// modules before this file existed:
//
//   description 20,000 units    -> opened a 16,733-character URL
//   description 1,000,000 units -> opened a 16,733-character URL
//   saveFeedback 1e6 x 3 fields -> wrote a 49,294-byte file, 16,384 per field
//   payload "nope" (a STRING)   -> opened a 144-character URL
//   payload null                -> raw TypeError reading "title"
//   all three fields at 1e6     -> "External URL is not on the allowlist."
//
// The only thing holding any of that was `redaction.ts` ending `.slice(0, 16_384)`
// — a truncation that exists for REDACTION reasons, in a module with no stake in
// URL length or file size, applied PER FIELD so it never bounded the whole payload
// anyway. Raise or remove that slice and both paths are unbounded again, silently.
// The last case is the other half of the same defect: an oversized payload died at
// the door reporting an ALLOWLIST failure, which is not what went wrong.
//
// The bound therefore has to be stated HERE, at the boundary, derived from the UI
// contract rather than inherited from another module's side effect.
//
// WHY NOT IN ipc-security.ts. That file's validators are single-line assertions
// over scalars and it imports nothing. This is a multi-field payload with a derived
// aggregate bound. The precedent followed is `assertClipboardText` (index.ts:714),
// added for exactly this reason — free-form user text needing a size bound — and
// which deliberately sits outside ipc-security.ts while mirroring its style:
// assert the type, bound the size, throw a generic Error, and NEVER echo the value.

import type { FeedbackData } from "./feedback-service";

/**
 * Field bounds, in UTF-16 CODE UNITS.
 *
 * THE UNIT MATTERS AND IT IS NOT "CHARACTERS". DOM `maxLength` counts UTF-16 code
 * units, so these count the same thing and are therefore EXACTLY the UI contract —
 * neither tighter (which would reject reports a user can really type) nor looser
 * (which would leave slack for a caller that skips the DOM). Counting code POINTS
 * instead would admit 100 emoji, which is 200 units, twice what the textbox permits.
 *
 * `tests/feedback-ipc-payload-bounds.test.mjs` reads `TITLE_MAX` and
 * `DESCRIPTION_MAX` out of `FeedbackModal.tsx` and asserts they equal these, so the
 * two cannot drift apart silently: raising the DOM cap without raising these fails
 * the suite rather than quietly rejecting legitimate feedback.
 */
export const FEEDBACK_TITLE_MAX = 100;
export const FEEDBACK_DESCRIPTION_MAX = 2000;

/**
 * The e-mail field has NO `maxLength` in the renderer, so there is no UI contract
 * to match and a bound has to be chosen. 320 is the RFC 5321 ceiling for an
 * addressable mailbox — a 64-octet local part, "@", and a 255-octet domain — so no
 * address a user could actually be reached at exceeds it, and it is comfortably
 * above the 254 figure usually quoted as the practical maximum. The field is
 * optional; absent or empty means the user declined to leave one.
 */
export const FEEDBACK_EMAIL_MAX = 320;

/** The two values the renderer's radio group can produce (FeedbackModal.tsx:19). */
const FEEDBACK_TYPES: ReadonlySet<string> = new Set(["suggestion", "bug"]);

/**
 * Bound a single free-form field, counting UTF-16 code units.
 *
 * The value is NEVER interpolated into the message. Feedback text is pasted by the
 * user and can contain an NVIDIA API key or the local gateway token, and this error
 * is logged by `wrapIpcHandler` and shown in a toast. Same discipline as
 * `assertClipboardText`: name the FIELD, never the content.
 */
function assertText(value: unknown, field: string, max: number, required: boolean): void {
  if (value === undefined && !required) return;
  if (typeof value !== "string") throw new Error(`Invalid feedback ${field}.`);
  if (required && value.length === 0) throw new Error(`Invalid feedback ${field}.`);
  if (value.length > max) throw new Error(`Invalid feedback ${field}.`);
}

/**
 * Assert that an IPC payload really is a `FeedbackData` the renderer could have
 * produced, and that its free-form fields are bounded.
 *
 * WHY THE AGGREGATE FITS THE DOOR BY CONSTRUCTION. `openGitHubIssue` builds
 * `?title=<title>&body=<lines>` with `encodeURIComponent`, and the title is emitted
 * TWICE (once as the query parameter, once inside the body). `encodeURIComponent`
 * expands at most 9 URL characters per UTF-16 code unit — a 3-byte BMP character
 * such as U+65E5 becomes `%E6%97%A5`, while an astral character is 4 bytes across 2
 * units, i.e. only 6 per unit — so the worst case is
 *
 *   9 * (2*100 + 2000 + 320) + scaffolding = 22,680 + scaffolding
 *
 * which sits under `MAX_REPO_URL_LENGTH` (65,536) with roughly 2.7x headroom. A
 * validated payload therefore can no longer be refused by the door and mislabelled
 * as an allowlist failure.
 *
 * CHARACTERS vs UNITS vs BYTES, since all three differ here: 2000 units of Cyrillic
 * is 4000 UTF-8 bytes and 12,000 URL characters; the same 2000 units of CJK is 6000
 * bytes and 18,000 URL characters. MEASURED end to end, the largest URL the UI can
 * produce is 20,147 characters, with title and description both full of CJK — NOT
 * the emoji case, which measures 13,547. That 9x spread between units and URL
 * characters is exactly why the URL bound must be DERIVED from the unit count
 * rather than assumed equal to it.
 */
export function assertFeedbackData(value: unknown): asserts value is FeedbackData {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid feedback data.");
  }
  const data = value as Record<string, unknown>;
  if (typeof data.type !== "string" || !FEEDBACK_TYPES.has(data.type)) {
    throw new Error("Invalid feedback type.");
  }
  assertText(data.title, "title", FEEDBACK_TITLE_MAX, true);
  assertText(data.description, "description", FEEDBACK_DESCRIPTION_MAX, true);
  assertText(data.email, "email", FEEDBACK_EMAIL_MAX, false);
  if (typeof data.attachDiagnostic !== "boolean") {
    throw new Error("Invalid feedback attachDiagnostic flag.");
  }
}
