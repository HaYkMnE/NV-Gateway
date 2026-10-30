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

/**
 * Windows user path, every spelling this app can produce: any drive letter or a
 * UNC host, `Users` at the profile root, then the ACCOUNT NAME segment.
 *
 * MEASURED: the previous single-shape rule in report-sanitizer.ts matched only
 * `C:\Users\<name>\`, so `D:\Users\<name>\` (relocated profile), a UNC/roaming
 * profile, a forward-slash spelling (ordinary in stack frames and file:// URLs)
 * and a trailing-segment path with no final separator all carried the account
 * name through. The prefix and separators are CAPTURED rather than rewritten so
 * the original drive letter, host and slash style survive for diagnosis — only
 * the name is masked.
 */
const WINDOWS_USER_PATH = /([A-Za-z]:[\\/]|\\\\[^\\/\r\n]+[\\/])(Users[\\/])([^\\/\r\n]+)/gi;

/**
 * Mask the local account name in Windows user paths.
 *
 * Privacy rather than secrecy, so it is applied where text LEAVES the machine or
 * reaches stderr — NOT inside redact(), because the user's own local log should
 * keep the real path it is reporting about.
 *
 * @param value Arbitrary text that may embed a user path.
 * @returns The text with each account-name segment replaced by `***`.
 */
export function maskUserPaths(value: string): string {
  return value.replace(WINDOWS_USER_PATH, (_match, prefix, usersSegment) => `${prefix}${usersSegment}***`);
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
