// Single sanitizer for everything that can leave the machine.
//
// WHY THIS EXISTS: error-reporter.ts, feedback-service.ts and diagnostic-export.ts
// each carried their OWN regex sanitizer covering only `nvapi-*`, `sk-*`, user
// paths and e-mail addresses. Measured consequences:
//
//   * gatewayToken and adminToken are crypto.randomBytes(32).toString("base64url")
//     — random and UNPREFIXED. No regex can recognise them, so all three modules
//     forwarded them verbatim.
//   * a raw `Bearer <token>` whose token is not an nvapi key survived intact.
//   * sanitizeEntry inspected VALUES only, never KEY NAMES, so a field literally
//     called `x-api-key` was forwarded as-is.
//
// src/main/redaction.ts already solves all of it: exact-match runtime secrets
// (fed by setRuntimeSecrets), sensitive KEY NAMES, Bearer stripping and URL
// query/fragment removal. It simply was not used on the outgoing paths. It is now
// the only sanitizer here.
//
// FAIL-CLOSED. sanitizeReportEntry keeps an ALLOW-LIST of fields and drops
// everything else, whatever it contains. A value-based filter can only remove
// what it recognises; an allow-list removes what it does not. Adding a field to a
// report is therefore a deliberate act, not something that happens because a
// caller passed an extra property. Sending less is always preferable to sending a
// credential once.

import { redact } from "./redaction";

/** Fields allowed to leave the machine in an error-report entry. */
const ALLOWED_ENTRY_FIELDS = ["timestamp", "type", "message", "stack", "source"] as const;

/** Known entry types; anything else is normalised rather than forwarded. */
const KNOWN_TYPES = new Set(["uncaughtException", "unhandledRejection", "gateway", "renderer"]);

/**
 * Redact free text destined for a report or a diagnostic bundle.
 *
 * @param value Arbitrary text.
 * @returns The text with credentials, secret-bearing URLs and user paths removed.
 */
export function sanitizeReportText(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripUserPaths(String(redact(value)));
}

/**
 * Reduce an entry to the allow-listed fields, each redacted.
 *
 * Unknown fields are DROPPED — that is the fail-closed property. Absent fields
 * stay absent rather than becoming empty strings, so a report keeps the shape the
 * existing preview UI and worker schema expect.
 *
 * @param entry Candidate entry from any source (log line, IPC payload, …).
 * @returns A new object containing only allow-listed, redacted fields.
 */
export function sanitizeReportEntry(entry: unknown): Record<string, unknown> {
  const source: Record<string, unknown> =
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : {};

  const safe: Record<string, unknown> = {};
  for (const field of ALLOWED_ENTRY_FIELDS) {
    if (!(field in source)) continue;
    const value = source[field];
    if (value === undefined || value === null) continue;
    if (field === "type") {
      const type = typeof value === "string" && KNOWN_TYPES.has(value) ? value : "renderer";
      safe.type = type;
      continue;
    }
    // Every surviving field is a string in the report schema; non-strings are
    // stringified BEFORE redaction so a nested object cannot smuggle a secret
    // past it as a non-string value.
    safe[field] = sanitizeReportText(typeof value === "string" ? value : safeStringify(value));
  }
  return safe;
}

/**
 * Reduce a diagnostic log line to redacted primitives.
 *
 * Log lines have no fixed schema (the gateway logs arbitrary structured context),
 * so an allow-list of NAMES is not possible here. The fail-closed rule applied
 * instead is on SHAPE: only primitives survive, each redacted, and nested objects
 * or arrays are replaced by a marker rather than walked. That keeps a diagnostic
 * bundle useful for the user while making it structurally unable to carry an
 * unreviewed nested payload.
 *
 * @param entry Parsed JSONL line.
 * @returns A flat object of redacted primitives.
 */
export function sanitizeDiagnosticEntry(entry: unknown): Record<string, unknown> {
  const source: Record<string, unknown> =
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : {};

  // redact() blanks values whose key name matches its own SENSITIVE list
  // (authorization, api_key, token, gatewayToken, adminToken, cookie, …).
  const redacted = redact(source) as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(redacted)) {
    // BROADER than redaction.ts on purpose. That list is anchored (^…$), so a
    // real-world header name like `x-api-key` slips past it — measured. Here any
    // field whose NAME suggests a credential is blanked regardless of what it
    // holds, because a diagnostic log line has no fixed schema and guessing from
    // the value alone is what let credentials through before.
    if (CREDENTIAL_NAME_HINT.test(key)) {
      safe[key] = "[REDACTED]";
      continue;
    }
    if (typeof value === "string") {
      safe[key] = stripUserPaths(value);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      safe[key] = value;
    } else {
      safe[key] = "[omitted]";
    }
  }
  return safe;
}

/**
 * Field names that must never carry a value into a diagnostic bundle. Substring
 * matching, unlike the anchored list in redaction.ts, so prefixed and suffixed
 * spellings (`x-api-key`, `gatewayTokenHash`, `upstreamAuthorization`) are caught.
 */
const CREDENTIAL_NAME_HINT = /(key|token|secret|auth|password|passwd|credential|bearer|cookie|session)/i;

/**
 * Remove the local account name from Windows paths and e-mail addresses.
 * redaction.ts handles credentials; these two are privacy rather than secrecy, so
 * they are applied here where reports and bundles are produced.
 */
function stripUserPaths(value: string): string {
  return value
    .replace(/C:\\Users\\[^\\]+\\/gi, "C:\\Users\\***\\")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "***@***.***");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
