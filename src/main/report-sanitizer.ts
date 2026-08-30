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
    // WIDER than redaction.ts in the spellings it accepts, but still ANCHORED on
    // the whole field name. redaction.ts matches the bare name only (^api[-_]?key$),
    // so a real-world header like `x-api-key` slips past it — measured. Here the
    // name is normalised first, so `x-api-key`, `X_API_KEY` and `xApiKey` are one
    // name, and a qualifier such as `upstreamAuthorization` is still caught —
    // without blanking a field that merely CONTAINS a credential-ish word.
    if (isCredentialFieldName(key)) {
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
 * Nouns that NAME a credential rather than describe one. A compound field name is
 * treated as a credential when one of these is its HEAD — its last word — because
 * that is what makes `apiKey` the key itself while `keyCount` is a number ABOUT
 * keys.
 *
 * PLURALS, deliberately asymmetric. `secrets`/`credentials`/`passwords` are listed
 * because those words have no counting sense in a log field. `keys` and `tokens`
 * are NOT, because they demonstrably do: `activeKeys` is how many keys are live and
 * `promptTokens` is a usage count, and blanking those is the defect being fixed. A
 * plural credential COLLECTION is still covered without the name rule — an array or
 * object value becomes "[omitted]" below, and a joined string is still subject to
 * the value rules in redaction.ts (nvapi- prefix, `Bearer …`, runtime secrets).
 */
const CREDENTIAL_HEAD_NOUNS = [
  "authorization", "auth", "bearer", "cookie", "session",
  "credential", "credentials",
  "key", "token",
  "secret", "secrets", "password", "passwords", "passwd", "passphrase"
];

/**
 * Split a field name into lowercase words on `-`, `_` and camelCase boundaries, so
 * `x-api-key`, `X_API_KEY` and `xApiKey` all normalise to the same three words.
 */
function fieldNameTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}

/**
 * Decide whether a field NAME denotes a credential.
 *
 * ANCHORED on the whole name, unlike the substring alternation this replaced. That
 * pattern fired on any name merely CONTAINING a credential-ish word, so the
 * key-rotation and rate-limit counters this product logs — `activeKeys`,
 * `keyCount`, `keyIndex`, `keysTried` — were blanked, which is exactly the data a
 * 429 investigation needs. All 53 field names that reach a JSONL log line were
 * enumerated from the logger call sites; none of them carries a credential.
 *
 * The rule is the HEAD NOUN: a name is a credential when its last word is one of
 * CREDENTIAL_HEAD_NOUNS (`apiKey`, `x-api-key`, `gatewayToken`, `set-cookie`,
 * `clientSecret`, `privateKey`), and is not when the credential word is a mere
 * modifier of a benign head (`keyCount`, `keyIndex`, `keysTried`). A separator-less
 * all-caps spelling has no boundaries to split on, so `GATEWAYTOKEN` is matched on
 * its ending instead.
 *
 * Fail-closed on the unknown NAME SHAPE: an unrecognised compound is still redacted
 * whenever its head is a credential noun, so a future `upstreamAuthorization` or
 * `sessionToken` needs no listing.
 *
 * STATED TRADE-OFFS, both narrowed by the value-based rules that still run:
 *   * a benign head carrying a credential word inside it is no longer blanked by
 *     NAME, e.g. `gatewayTokenHash` — a hash is derived, not the secret;
 *   * `keys`/`tokens` are not head nouns (see CREDENTIAL_HEAD_NOUNS), so a plural
 *     name like `apiKeys` is not blanked by NAME either.
 * In both cases redaction.ts still applies to the VALUE (nvapi- prefix, `Bearer …`,
 * registered runtime secrets), and a non-primitive value becomes "[omitted]".
 */
function isCredentialFieldName(key: string): boolean {
  const tokens = fieldNameTokens(key);
  if (tokens.length === 0) return false;

  const head = tokens[tokens.length - 1];
  if (CREDENTIAL_HEAD_NOUNS.includes(head)) return true;
  // No separator to split on (`GATEWAYTOKEN`): match the credential noun the name
  // ends with, which is the same head-noun position.
  return tokens.length === 1 && CREDENTIAL_HEAD_NOUNS.some((noun) => head.endsWith(noun));
}

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
