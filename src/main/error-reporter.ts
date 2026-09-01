// Error reporter for the NV-Gateway main process.
//
// Writes JSONL entries to %APPDATA%\NV-Gateway\logs\errors.log, applies
// secret / local-path / email sanitization, expires entries older than 10
// days, keeps an on-disk report snapshot, and uploads a bundle to the
// Cloudflare Worker reporting endpoint (/v1/error).
//
// Sanitization (applied before writing and again before sending):
//   nvapi-<...>      -> nvapi-***
//   sk-<...>         -> sk-***   (word boundary + min 20 chars to avoid
//                              matching "disk", "task", "risk", etc.)
//   C:\Users\<user>\ -> C:\Users\***\
//   <addr>@<domain>  -> ***@***.***

import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

import { sanitizeReportEntry } from "./report-sanitizer";
import { REPORTS_BASE_URL } from "./reports-endpoint";

// Reporting endpoint of the deployed Cloudflare Worker (POST /v1/error).
// No auth headers — the worker accepts unauthenticated writes.
const REPORT_ENDPOINT = `${REPORTS_BASE_URL}/v1/error`;
// The worker rejects serialized `report` bodies above this size; oversized
// bundles drop their oldest entries until they fit (see fitReportForWorker).
const MAX_REPORT_BODY_BYTES = 65536;
const SEND_TIMEOUT_MS = 15000;

const RETENTION_DAYS = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Size cap for errors.log, DELIBERATELY the same scheme and the same numbers as
// app-logger.ts:5-6 (5 MB x 3) rather than a second scheme invented here.
//
// WHY IT WAS NEEDED. Retention was the ONLY bound on this file, and it is
// evaluated in exactly two places: on READ (withinRetention, which filters what
// is counted and previewed but never shrinks the file) and in cleanupOldErrors(),
// whose single call site is init(). So a session that never restarts never
// reclaims anything: no init(), no cleanup, no cap.
//
// MEASURED before this cap existed, with one fault repeating in a single session
// (tests/error-reporter-bounds.test.mjs): 1,400 entries carrying an 8,000-unit
// stack wrote 11,359,890 bytes to one file at 8,114 bytes per entry, with zero
// rotated files. That is 2.2x the 5 MB the app logger caps at, still climbing,
// and the projection is linear in the fault rate: a loop logging a handful of
// times a second fills a disk in a long-running session.
//
// TWO CONSEQUENCES, STATED RATHER THAN HIDDEN, both inherited from the app-logger
// scheme this deliberately matches:
//
//   * readErrors() reads the ACTIVE log only, so once a generation rotates out its
//     entries stop being counted by getErrorCount(), previewed, or sent. That is
//     the point of a cap — the alternative is an unbounded read of up to 20 MB into
//     memory to build a 64 KB report — but it does mean a fault storm can now push
//     older still-in-retention entries out of the report. Before this change they
//     were retained; before this change the file was also unbounded.
//   * cleanupOldErrors() rewrites the active log only, so rotated generations are
//     bounded by SIZE (3 x 5 MB) rather than by the 10-day clock. Retention on the
//     active log is unchanged, which is the behaviour the counters and the preview
//     actually read.
const MAX_LOG_SIZE = 5 * 1024 * 1024;
const MAX_ROTATED_LOGS = 3;

// Per-field caps for a stored error record, in UTF-16 CODE UNITS.
//
// WHY THIS MODULE STATES ITS OWN BOUND. Until now the only thing limiting these
// fields was `redaction.ts:83` ending `.slice(0, 16_384)` — a truncation that
// exists for REDACTION reasons, in a module this one does not own and which has
// no stake in how big a log record may be. MEASURED before this cap existed:
// `logError({ message: 'a'.repeat(100000) })` stored exactly 16,384 units, the
// slice bound to the character, with nothing in the record indicating that 83,616
// units had been dropped. Raise or remove that slice and this path is unbounded
// again, silently. `feedback-validation.ts` was made independent of the same slice
// for the same reason (see its header); this is the remaining caller that was not.
//
// 4,000 MATCHES THAT PRECEDENT rather than inventing a second scheme: the feedback
// paths bound their fields so the worst case is 3,998 units against the same
// 16,384 threshold. 4,000 units holds a full diagnostic message and roughly 40-50
// stack frames, so nothing diagnostically useful is lost, and it sits at a quarter
// of the slice so this module's bound is what binds.
//
// TRUNCATION IS VISIBLE, NOT SILENT. The record says what was dropped and how big
// the input was. It cannot say so in a NEW FIELD: sanitizeReportEntry keeps a
// fail-closed ALLOW-LIST of fields (report-sanitizer.ts:29) and drops everything
// else, so a `truncated` flag would be discarded on the way out. The note goes in
// the value, in the same untranslated-marker style as `[REDACTED]`, `[omitted]`
// and `[Circular]`, so it adds no user-facing string and no i18n key.
//
// THE SIZE IS NAMED, THE CONTENT IS NEVER ECHOED — same discipline as
// assertClipboardText (index.ts:715) and assertText (feedback-validation.ts:86):
// an error message can carry an NVIDIA key or the gateway token.
const MAX_MESSAGE_UNITS = 4000;
const MAX_STACK_UNITS = 4000;
// `source` is a short origin discriminator — the call sites in this file pass
// "main", and the renderer passes a view name. It is still renderer-supplied
// free text, so it needs its own bound or it inherits the slice exactly as the
// other fields did.
const MAX_SOURCE_UNITS = 200;
// A `timestamp` this module accepts is one Date.parse understands, and every such
// spelling is far shorter than this; the cap only stops an unparsed-but-long value
// from being stored. No marker is appended to this field — it is PARSED by
// withinRetention, so a note inside the value would make the entry unexpirable.
const MAX_TIMESTAMP_UNITS = 64;

/**
 * Every LONE UTF-16 surrogate: a high surrogate not followed by a low, or a low
 * not preceded by a high. A well-formed pair never matches. Same pattern as
 * feedback-service.ts:33 — a per-field cut here can split a pair exactly as a
 * cut there could.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Sanitization lives in ./report-sanitizer, which builds on ./redaction — the
// same redactor the app logger uses. The regex-only sanitizer that used to live
// here could not see gatewayToken / adminToken (random, unprefixed base64url) and
// inspected values only, never key names.

export interface ErrorEntry {
  timestamp: string;
  type: "uncaughtException" | "unhandledRejection" | "gateway" | "renderer";
  message: string;
  stack?: string;
  source?: string;
}

export interface ErrorReportResult {
  success: boolean;
  count: number;
  message: string;
  reportPath?: string;
}

let initialized = false;

function dataDir(): string {
  // app.getPath("userData") resolves to %APPDATA%\NV-Gateway once the app
  // name is aligned with electron-builder productName.
  return app.getPath("userData");
}

function errorsLogPath(): string {
  return path.join(dataDir(), "logs", "errors.log");
}

function reportsDir(): string {
  return path.join(dataDir(), "reports");
}

// Delegates to the shared, fail-closed sanitizer: allow-listed fields only, each
// passed through ./redaction (runtime secrets by exact match + sensitive key
// names + Bearer stripping). The previous local implementation forwarded every
// field it was handed and could not see an unprefixed gatewayToken/adminToken.
function sanitizeEntry(entry: Record<string, unknown>): Record<string, unknown> {
  return sanitizeReportEntry(entry);
}

/**
 * Bound one already-sanitized field and record the loss inside the value.
 *
 * ORDER MATTERS, AND IT IS SANITIZE-THEN-BOUND. Cutting first would be a
 * security regression, not merely a cosmetic difference: `redact()` removes
 * registered runtime secrets by EXACT MATCH (redaction.ts:83), so a cut landing
 * inside the gateway or admin token would leave a PREFIX of that token, which no
 * longer matches, is no longer removed, and is written to disk verbatim. Bounding
 * the redacted text cannot resurrect a secret, because every secret is already
 * `[REDACTED]` by then.
 *
 * THE SIZE REPORTED IS THE ORIGINAL INPUT'S, not the sanitized string's, for two
 * reasons. It is the number an operator actually wants ("the renderer sent us
 * 100,000 units"), and it is invariant: redaction both shrinks text (a token
 * becomes `[REDACTED]`) and grows it (`nvapi-a`, 7 units, becomes `[REDACTED]`,
 * 10), so quoting the post-redaction size would make the recorded figure depend on
 * the very slice this bound exists to be independent of.
 *
 * @param value Sanitized field value.
 * @param originalUnits Length in UTF-16 units of the value as the caller supplied it.
 * @param max Cap for this field.
 * @param field Field name, used in the marker. The VALUE is never echoed.
 * @returns The value unchanged, or a truncated value carrying a size marker.
 */
function boundField(value: unknown, originalUnits: number, max: number, field: string): string {
  const text = typeof value === "string" ? value : "";
  // THE MARKER FOLLOWS THE CUT, NOT THE INPUT SIZE. The condition was
  // `text.length <= max && originalUnits <= max`, which appended the marker
  // whenever the CALLER's value was long — even when the value being stored was
  // not cut at all. MEASURED: `nvapi-` + 4,200 units is one runtime secret, so
  // redaction collapses it to `[REDACTED]` (10 units) and nothing is lost, yet
  // the record read `[REDACTED][truncated: message was 4206 units, cap 4000]` —
  // 55 units claiming 4,196 units of loss that never happened. A diagnostic
  // record that reports imaginary data loss sends an operator hunting a
  // truncation that is not there, so the marker is now attached only when this
  // function actually cuts something.
  if (text.length <= max) return text;
  // LONE SURROGATE REPAIR, same substitution and same reason as
  // encodeFieldForUrl (feedback-service.ts:93). A cut at an arbitrary UTF-16
  // index lands between the halves of a surrogate pair, MANUFACTURING a lone
  // surrogate that was not in the input. MEASURED at this cap: 3,999 units then
  // U+1F600 stored U+D83D at index 3,999 with no low surrogate after it. It does
  // not break this file (JSON.stringify emits `\ud83d`, and the line re-parses),
  // but it is invalid text this module invented, and one U+FFFD per broken half
  // is what a UTF-8 encoder produces anyway. The substitution is 1:1, so the cap
  // still binds at exactly `max` units.
  const cut = text.slice(0, max).replace(LONE_SURROGATE, "\uFFFD");
  // THE SIZE NAMED IS THE ONE THAT EXPLAINS THE CUT. Normally that is the
  // caller's own figure, which is what an operator wants and the only figure
  // independent of the slice. But redaction can GROW text (`nvapi-a`, 7 units,
  // becomes `[REDACTED]`, 10), so a 3,900-unit message of many such tokens
  // exceeds a 4,000 cap only AFTER sanitizing; quoting 3,900 against a cap of
  // 4,000 would read as a contradiction in the one record meant to explain
  // itself. Whichever size actually crossed the cap is reported.
  const reportedUnits = Math.max(originalUnits, text.length);
  // Names the field and the sizes, never the content — assertClipboardText and
  // assertText (feedback-validation.ts:86) hold the same line, because this text
  // can contain a credential the redactor did not recognise.
  return `${cut}[truncated: ${field} was ${reportedUnits} units, cap ${max}]`;
}

// Clamps the report bundle to the worker's serialized-size limit by dropping
// the oldest entries first.  Mutates the report in place; `count` is kept
// consistent with the retained entries.  A single entry larger than the
// limit is still sent once — the HTTP failure path handles that gracefully.
function fitReportForWorker(report: { timestamp: string; count: number; errors: unknown[] }): void {
  while (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_REPORT_BODY_BYTES && report.errors.length > 1) {
    report.errors.shift();
    report.count = report.errors.length;
  }
}

function readErrors(): Record<string, unknown>[] {
  const file = errorsLogPath();
  if (!fs.existsSync(file)) return [];
  const out: Record<string, unknown>[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // Ignore malformed lines — JSONL is append-only and best-effort.
    }
  }
  return out;
}

// Rotate errors.log once it reaches MAX_LOG_SIZE, keeping MAX_ROTATED_LOGS
// generations. Same algorithm as app-logger.ts:19-41 — oldest generation removed
// first, then each generation shifted up from the highest down so nothing is
// overwritten — with two deliberate differences:
//
//   * the extension is `.log`, not `.jsonl`, so the basename is stripped with a
//     `\.log$` rule. Copying app-logger's `\.jsonl$` rule verbatim would have
//     produced `errors.log.1.jsonl`.
//   * no protectFile/ACL hook. app-logger re-applies its ACL to each rotated
//     file because initAppLogger is handed a protector; this module has never
//     had one (appendEntry only ever did mkdirSync + appendFileSync), and wiring
//     one in is a separate concern from bounding the size.
//
// Every failure is swallowed: a logger must never throw into its caller, and a
// failed rotation must still leave the append below to run.
function rotateIfNeeded(file: string): void {
  try {
    if (fs.statSync(file).size < MAX_LOG_SIZE) return;
  } catch {
    // No file yet, or it cannot be stat'ed: nothing to rotate.
    return;
  }

  const baseName = file.replace(/\.log$/, "");
  try {
    fs.unlinkSync(`${baseName}.${MAX_ROTATED_LOGS}.log`);
  } catch {
    // The oldest generation may not exist yet.
  }

  // Highest generation first so a rename never clobbers a file still needed.
  // i === 1 moves the active log itself; i > 1 moves generation i-1 up to i.
  for (let i = MAX_ROTATED_LOGS; i >= 1; i -= 1) {
    const from = i === 1 ? file : `${baseName}.${i - 1}.log`;
    try {
      fs.renameSync(from, `${baseName}.${i}.log`);
    } catch {
      // A missing generation is normal before the log has rotated that often.
    }
  }
}

function appendEntry(entry: Record<string, unknown>): void {
  const file = errorsLogPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  rotateIfNeeded(file);
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
}

function withinRetention(entry: Record<string, unknown>): boolean {
  const ts = entry?.timestamp ? Date.parse(String(entry.timestamp)) : NaN;
  return Number.isFinite(ts) && ts >= Date.now() - RETENTION_DAYS * MS_PER_DAY;
}

// ---- Public API ----

export function init(): void {
  if (initialized) return;
  initialized = true;

  try {
    fs.mkdirSync(path.dirname(errorsLogPath()), { recursive: true });
  } catch {
    // Directory creation is best-effort.
  }

  try {
    cleanupOldErrors();
  } catch {
    // Cleanup must never block startup.
  }

  process.on("uncaughtException", (err: unknown) => {
    // The existing main-process handler owns fatal shutdown; this listener
    // only records the structured error entry for the report bundle.
    try {
      logError({
        type: "uncaughtException",
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
        source: "main"
      });
    } catch {
      // A logger must never throw.
    }
  });

  process.on("unhandledRejection", (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error && reason.stack ? reason.stack : undefined;
    try {
      logError({
        type: "unhandledRejection",
        message,
        ...(stack ? { stack } : {}),
        source: "main"
      });
    } catch {
      // Best-effort.
    }
  });
}

export function logError(entry: Partial<ErrorEntry> & { message?: string }): void {
  const source = entry && typeof entry === "object" ? entry : {};

  // ONE READ PER FIELD, into a local. The original UTF-16 length is captured here,
  // BEFORE sanitization, for two reasons: it is the size an operator actually wants
  // to see, and it is the only figure independent of redaction, which both shrinks
  // text (a token becomes `[REDACTED]`) and grows it (`nvapi-a` -> `[REDACTED]`).
  // Reading once also means the value that is measured is by construction the value
  // that is stored — the lesson snapshotFeedbackData records in feedback-validation.ts.
  const readTimestamp = source.timestamp;
  const readType = source.type;
  const readMessage = source.message;
  const readStack = source.stack;
  const readSource = source.source;

  const rawMessage = typeof readMessage === "string" ? readMessage : String(readMessage ?? "");
  const rawStack = typeof readStack === "string" ? readStack : "";
  const rawSource = typeof readSource === "string" ? readSource : "";

  const record = sanitizeEntry({
    timestamp: readTimestamp || new Date().toISOString(),
    type: readType || "renderer",
    message: rawMessage,
    ...(rawStack ? { stack: rawStack } : {}),
    ...(rawSource ? { source: rawSource } : {})
  });

  // BOUND AFTER SANITIZING — see boundField for why that order is a security
  // property and not a preference. Each field is given its own pre-sanitization
  // size, so the marker names what the caller actually sent rather than whatever
  // survived the redactor.
  record.message = boundField(record.message, rawMessage.length, MAX_MESSAGE_UNITS, "message");
  if (typeof record.stack === "string") {
    record.stack = boundField(record.stack, rawStack.length, MAX_STACK_UNITS, "stack");
  }
  if (typeof record.source === "string") {
    record.source = boundField(record.source, rawSource.length, MAX_SOURCE_UNITS, "source");
  }
  // Bounded WITHOUT a marker, unlike the fields above: withinRetention PARSES this
  // value, and appending a note would make the entry unparseable and therefore
  // unexpirable. An over-long timestamp is garbage input; cutting it makes it fail
  // Date.parse, so the entry is simply not counted and is reclaimed at cleanup.
  if (typeof record.timestamp === "string" && record.timestamp.length > MAX_TIMESTAMP_UNITS) {
    record.timestamp = record.timestamp.slice(0, MAX_TIMESTAMP_UNITS);
  }

  try {
    appendEntry(record);
  } catch {
    // Logging must never throw into the caller.
  }
}

export function getErrorCount(): number {
  return readErrors().filter(withinRetention).length;
}

export function previewErrors(): ErrorEntry[] {
  return readErrors().filter(withinRetention).map((entry) => sanitizeEntry(entry) as unknown as ErrorEntry);
}

/**
 * Expire entries past RETENTION_DAYS in ONE log file, rewriting it in place.
 *
 * @param file Path to an active or rotated log.
 * @returns Count of entries dropped; 0 if the file is absent or unreadable.
 */
function expireFile(file: string): number {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // Absent or unreadable: nothing to expire, and a logger must not throw.
    return 0;
  }
  const entries: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // Malformed lines are dropped, exactly as readErrors() ignores them.
    }
  }
  const kept = entries.filter(withinRetention);
  if (kept.length === entries.length) return 0;
  try {
    if (kept.length === 0) {
      // An emptied GENERATION is removed rather than left as a 0-byte file, so a
      // stale generation does not keep occupying a rotation slot.
      if (file === errorsLogPath()) fs.writeFileSync(file, "", "utf8");
      else fs.unlinkSync(file);
    } else {
      fs.writeFileSync(file, kept.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    }
  } catch {
    return 0;
  }
  return entries.length - kept.length;
}

export function cleanupOldErrors(): number {
  const file = errorsLogPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    // Directory creation is best-effort.
  }
  let removed = expireFile(file);

  // ROTATED GENERATIONS ARE SWEPT TOO, which is the point of this loop.
  //
  // Rotation alone turned the 10-day retention this module DOCUMENTS (see the
  // file header) into a size bound for anything that had rotated out: cleanup
  // rewrote the ACTIVE log only, so an entry pushed into errors.N.log was never
  // reached by the clock again. MEASURED with the cap lowered to 64 KiB so the
  // same code path is exercised cheaply: 40 entries stamped 400 days old were
  // rotated out, cleanupOldErrors() reported 0 reclaimed, and all 40 were still
  // on disk afterwards. That is strictly WORSE than before the cap existed —
  // there the same entries sat in the active log and the next init() reclaimed
  // them — so stale data outlived its retention because of a change made to
  // bound the file.
  //
  // The cost objection does not survive measurement either: reading and parsing
  // three FULL 5 MiB generations takes 98 ms, once, and only from init(). The
  // read path (getErrorCount / previewErrors / sendErrors) is deliberately left
  // reading the active log only, so nothing pulls 20 MB in to build a 64 KB
  // report — expiry and reporting simply do not need the same scope.
  const baseName = file.replace(/\.log$/, "");
  for (let i = 1; i <= MAX_ROTATED_LOGS; i += 1) {
    removed += expireFile(`${baseName}.${i}.log`);
  }
  return removed;
}

export async function sendErrors(): Promise<ErrorReportResult> {
  const errors = previewErrors();
  const count = errors.length;

  // ALWAYS persist a local snapshot of the report bundle — independent of
  // whether the upload path is configured or succeeds, so an operator always
  // has an on-disk copy to send manually.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let reportPath = "";
  try {
    const dir = reportsDir();
    fs.mkdirSync(dir, { recursive: true });
    reportPath = path.join(dir, `report-${stamp}.json`);
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ timestamp: new Date().toISOString(), count, errors }, null, 2),
      "utf8"
    );
  } catch {
    // Best-effort snapshot.
  }

  // Network copy of the bundle — trimmed to the worker's size limit.  The
  // local snapshot above intentionally keeps every entry regardless.
  const report = { timestamp: new Date().toISOString(), count, errors };
  fitReportForWorker(report);
  try {
    const response = await fetch(REPORT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ report, appVersion: app.getVersion() || "0.0.0" }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    if (response.status >= 200 && response.status < 300) {
      return { success: true, count, message: `Sent ${count} errors`, ...(reportPath ? { reportPath } : {}) };
    }
    return { success: false, count, message: `HTTP ${response.status}`, ...(reportPath ? { reportPath } : {}) };
  } catch (err: unknown) {
    return {
      success: false,
      count,
      message: `HTTP request failed: ${err instanceof Error ? err.message : String(err)}`,
      ...(reportPath ? { reportPath } : {})
    };
  }
}
