const SENSITIVE = /^(authorization|proxy-authorization|api[-_]?key|key|token|gatewaytoken|admintoken|localkey|cookie|set-cookie)$/i;
const SECRET_TEXT = /(Bearer\s+)[^\s,;]+|nvapi-[A-Za-z0-9._-]+/gi;
const ABSOLUTE_URL_TOKEN = /https?:\/\/[^\s<>"'`]+/gi;
const ENCODED_ABSOLUTE_URL_TOKEN = /https?%(?:25){0,2}3a%(?:25){0,2}2f%(?:25){0,2}2f[^\s<>"'`]+/gi;
const ENCODED_URL_STRUCTURE = /%(?:25){0,2}(?:3f|23|40)/i;
let runtimeSecrets: string[] = [];
export function setRuntimeSecrets(values: string[]): void {
  runtimeSecrets = values.filter((value) => typeof value === "string" && value.length > 0).sort((left, right) => right.length - left.length);
}

function redactEmbeddedUrls(value: string): string {
  return value.replace(ABSOLUTE_URL_TOKEN, (candidate) => {
    const { url, trailing } = splitTrailingProsePunctuation(candidate);
    const inspected = ENCODED_URL_STRUCTURE.test(url) ? decodeEncodedAbsoluteUrl(url) : url;
    if (inspected === null) return `[redacted-url]${trailing}`;
    try {
      const parsed = new URL(inspected);
      if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash && !inspected.includes("?") && !inspected.includes("#")) return candidate;
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}${trailing}`;
    } catch {
      return `[redacted-url]${trailing}`;
    }
  });
}

function redactEncodedEmbeddedUrls(value: string): string {
  return value.replace(ENCODED_ABSOLUTE_URL_TOKEN, (candidate) => {
    const decoded = decodeEncodedAbsoluteUrl(candidate);
    return decoded === null ? "[redacted-url]" : redactEmbeddedUrls(decoded);
  });
}

function decodeEncodedAbsoluteUrl(candidate: string): string | null {
  let decoded = candidate;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (/^https?:\/\//i.test(decoded)) return decoded;
  }
  return null;
}

function splitTrailingProsePunctuation(candidate: string): { url: string; trailing: string } {
  const match = candidate.match(/[.,;:!]+$/);
  if (!match) return { url: candidate, trailing: "" };
  return { url: candidate.slice(0, -match[0].length), trailing: match[0] };
}

export function redact(value: unknown, seen = new WeakSet<object>()): any {
  if (typeof value === "string") {
    const generic = redactEmbeddedUrls(redactEncodedEmbeddedUrls(value.replace(SECRET_TEXT, (_match, prefix) => prefix ? `${prefix}[REDACTED]` : "[REDACTED]")));
    return runtimeSecrets.reduce((result, secret) => result.split(secret).join("[REDACTED]"), generic).slice(0, 16_384);
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]"; seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => redact(item, seen));
  return Object.fromEntries(Object.entries(value).slice(0, 1000).map(([key, item]) => [key, SENSITIVE.test(key) ? "[REDACTED]" : redact(item, seen)]));
}

// ---- Windows user-path redaction ----
//
// CANONICAL IMPLEMENTATION lives in src/shared/redaction.mjs
// (export redactUserPaths). This is a deliberate mirror for the main process:
// tsconfig.node.json compiles src/main to CommonJS, which cannot statically
// require() the ESM-only shared .mjs, so the identical logic is duplicated
// here (same pattern this file already follows for redact()). The shared
// .mjs is the single source of truth — any change MUST be mirrored here, and
// tests/redaction-userpath.test.mjs asserts both implementations produce
// identical output for the full leak/negative matrix.
//
// One token everywhere: C:\Users\*** (no trailing backslash; an unconsumed
// trailing separator in the source stays right after the token). NEVER
// throws — degenerate/unexpected input is returned unchanged.
const USERPATH_TOKEN = "C:\\Users\\***";
const DRIVE_USERPATH = /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"',;()]+/gi;
// Host/share segments exclude ':' so URL forms like file:///C:/Users/... are
// NOT treated as UNC and stay reachable for the drive-rooted rule.
const UNC_USERPATH = /((?:\\\\|\/\/)(?:[^\\/\s"',;():]+[\\/]+)+)Users[\\/]+[^\\/\s"',;()]+/gi;
const ENCODED_DRIVE_HEAD = /[A-Za-z]%(?:25){0,2}3a[^\s"',;()\\]*/gi;
const DRIVE_USERPATH_PROBE = /^[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"',;()]+/i;
const ENCODED_USERPATH_PROBE = /^[A-Za-z]%(?:25){0,2}3a(?:%(?:25){0,2}(?:5c|2f))+users/i;

function redactEncodedUserPaths(value: string): string {
  return value.replace(ENCODED_DRIVE_HEAD, (candidate) => {
    let decoded = candidate;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let next: string;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        return ENCODED_USERPATH_PROBE.test(candidate) ? USERPATH_TOKEN : candidate;
      }
      if (next === decoded) break;
      decoded = next;
    }
    return DRIVE_USERPATH_PROBE.test(decoded) ? USERPATH_TOKEN : candidate;
  });
}

export function redactUserPaths(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  try {
    let result = redactEncodedUserPaths(text);
    result = result.replace(UNC_USERPATH, (_match, prefix) => `${prefix}${USERPATH_TOKEN}`);
    result = result.replace(DRIVE_USERPATH, USERPATH_TOKEN);
    return result;
  } catch {
    return text;
  }
}
