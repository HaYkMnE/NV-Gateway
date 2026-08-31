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
 * bytes and 18,000 URL characters.
 *
 * MEASURED end to end over validator-accepted payloads, the largest URL the UI can
 * produce is 23,014 characters: a CJK title, a CJK description, a 320-unit CJK
 * e-mail, and `attachDiagnostic = true`. The worst case is CJK, NOT emoji, which
 * measures 15,454 in the same configuration — a 3-byte BMP character occupies ONE
 * UTF-16 unit and expands to 9 URL characters, while a 4-byte astral character
 * occupies TWO units and expands to 12, i.e. only 6 per unit.
 *
 * The figure previously stated here was 20,147, which is the same CJK payload with
 * an ASCII e-mail rather than a CJK one — 320 units of ASCII e-mail add 201 URL
 * characters where 320 units of CJK add 2,868. Both sit under the derived bound and
 * far under the door's 65,536 cap, so the conclusion never changed, but the number
 * was wrong and is now the measured maximum. `tests/feedback-ipc-payload-bounds.test.mjs`
 * pins BOTH the arithmetic above and this measured figure, so neither can rot again.
 *
 * That 9x spread between units and URL characters is exactly why the URL bound must
 * be DERIVED from the unit count rather than assumed equal to it.
 */
export function assertFeedbackData(value: unknown): asserts value is FeedbackData {
  snapshotFeedbackData(value);
}

/**
 * READ EACH FIELD EXACTLY ONCE, validate what was read, and return THAT.
 *
 * WHY THIS EXISTS AND WHY THE BOUNDARY USES IT INSTEAD OF THE ASSERTION ABOVE.
 * `assertFeedbackData` is a TypeScript assertion function, so it can only narrow the
 * type of the object it was handed — it cannot replace it. The IPC handlers therefore
 * validated `data` and then passed THE SAME `data` on to `saveFeedback` /
 * `openGitHubIssue`, which read the fields AGAIN. A property whose value differs
 * between the validating read and the consuming read defeats the validator entirely.
 *
 * MEASURED against the built modules before this function existed, with an object
 * carrying a getter on `title` that returned `'short'` on its first read and
 * 1,000,000 UTF-16 units on every read after:
 *
 *   assertFeedbackData(hostile)  -> PASSED (it saw 'short', 5 units)
 *   openGitHubIssue(hostile)     -> OPENED a 33,137-character URL
 *   `title` reads recorded       -> 3
 *
 * 33,137 is past the 23,704 bound the comment above derives, so the validator's own
 * stated guarantee was false for that payload. It stayed under the door's 65,536 cap,
 * so the URL opened; the origin and path never moved, because every user byte still
 * goes through `encodeURIComponent`. The oversize came from `redaction.ts`'s
 * `.slice(0, 16_384)` capping each field, which is the same incidental truncation
 * this file exists to stop relying on.
 *
 * NOT REACHABLE FROM A RENDERER TODAY, stated honestly. Electron IPC serialises with
 * the structured clone algorithm, and MEASURED, `structuredClone` flattens a getter
 * to a plain value — one read during the clone, and the descriptor on the far side
 * comes back `{value:'short',writable:true,enumerable:true,configurable:true}`. A
 * live getter cannot cross the boundary, and no other main-process module calls
 * either consumer. So this is defence-in-depth against a future main-process caller,
 * not a live renderer escape.
 *
 * THE SHAPE. Every field is read into a local ONCE, the locals are validated, and a
 * fresh object built from the locals is FROZEN and returned. Freezing matters as much
 * as copying: a plain copy could have a getter installed on it afterwards, whereas a
 * frozen object with plain data properties cannot be re-armed. Consumers that receive
 * this object cannot observe a value that was not the validated one, because there is
 * nothing left to re-evaluate.
 *
 * `assertFeedbackData` is kept, delegates here, and therefore rejects exactly what it
 * always rejected — but it must NOT be used at a boundary that hands the object
 * onward, because narrowing a type is not the same as controlling what the consumer
 * reads. That is the whole lesson of this defect.
 */
export function snapshotFeedbackData(value: unknown): FeedbackData {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid feedback data.");
  }
  const source = value as Record<string, unknown>;

  // ONE read per field. Nothing below this line touches `source` again, so a getter,
  // a Proxy trap or a concurrent mutation cannot make the validated value and the
  // consumed value disagree.
  const type = source.type;
  const title = source.title;
  const description = source.description;
  const email = source.email;
  const attachDiagnostic = source.attachDiagnostic;

  if (typeof type !== "string" || !FEEDBACK_TYPES.has(type)) {
    throw new Error("Invalid feedback type.");
  }
  assertText(title, "title", FEEDBACK_TITLE_MAX, true);
  assertText(description, "description", FEEDBACK_DESCRIPTION_MAX, true);
  assertText(email, "email", FEEDBACK_EMAIL_MAX, false);
  if (typeof attachDiagnostic !== "boolean") {
    throw new Error("Invalid feedback attachDiagnostic flag.");
  }

  const snapshot: FeedbackData = {
    type: type as FeedbackData["type"],
    title: title as string,
    description: description as string,
    attachDiagnostic
  };
  // Absent and empty are both "the user declined to leave one"; only a real string
  // is carried, so the snapshot never invents a field the payload did not have.
  if (typeof email === "string") snapshot.email = email;
  return Object.freeze(snapshot);
}
