const SENSITIVE = /^(authorization|proxy-authorization|api[-_]?key|key|token|gatewaytoken|admintoken|localkey|cookie|set-cookie)$/i;
const SECRET_TEXT = /(Bearer\s+)[^\s,;]+|nvapi-[A-Za-z0-9._-]+/gi;
const ABSOLUTE_URL_TOKEN = /https?:\/\/[^\s<>"'`]+/gi;
const ENCODED_ABSOLUTE_URL_TOKEN = /https?%(?:25){0,2}3a%(?:25){0,2}2f%(?:25){0,2}2f[^\s<>"'`]+/gi;
const ENCODED_URL_STRUCTURE = /%(?:25){0,2}(?:3f|23|40)/i;
let runtimeSecrets = [];

export function setRuntimeSecrets(values) {
  runtimeSecrets = Array.isArray(values) ? values.filter((value) => typeof value === 'string' && value.length > 0).sort((left, right) => right.length - left.length) : [];
}

function redactEmbeddedUrls(value) {
  return value.replace(ABSOLUTE_URL_TOKEN, (candidate) => {
    const { url, trailing } = splitTrailingProsePunctuation(candidate);
    const inspected = ENCODED_URL_STRUCTURE.test(url) ? decodeEncodedAbsoluteUrl(url) : url;
    if (inspected === null) return `[redacted-url]${trailing}`;
    try {
      const parsed = new URL(inspected);
      if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash && !inspected.includes('?') && !inspected.includes('#')) return candidate;
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}${trailing}`;
    } catch {
      return `[redacted-url]${trailing}`;
    }
  });
}

function redactEncodedEmbeddedUrls(value) {
  return value.replace(ENCODED_ABSOLUTE_URL_TOKEN, (candidate) => {
    const decoded = decodeEncodedAbsoluteUrl(candidate);
    return decoded === null ? '[redacted-url]' : redactEmbeddedUrls(decoded);
  });
}

function decodeEncodedAbsoluteUrl(candidate) {
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

function splitTrailingProsePunctuation(candidate) {
  const match = candidate.match(/[.,;:!]+$/);
  if (!match) return { url: candidate, trailing: '' };
  return { url: candidate.slice(0, -match[0].length), trailing: match[0] };
}

function redactString(value) {
  let result = redactEmbeddedUrls(redactEncodedEmbeddedUrls(value.replace(SECRET_TEXT, (match, prefix) => prefix ? `${prefix}[REDACTED]` : '[REDACTED]')));
  return runtimeSecrets.reduce((redacted, secret) => redacted.split(secret).join('[REDACTED]'), result);
}

export function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE.test(key) ? '[REDACTED]' : redact(item, seen)]));
}

export function pathnameOnly(value) {
  try { return new URL(value, 'http://localhost').pathname; } catch { return '/'; }
}

// ---- Windows user-path redaction (canonical single source of truth) ----
//
// redactUserPaths() scrubs local Windows user paths out of any text before it
// is persisted or transmitted. Adversarially validated leak classes covered:
//   C:\Users\<name>\          canonical, any drive letter, any case of "Users"
//   C:\Users\<name>           missing trailing separator (EOF/quote/comma/paren)
//   C:/Users/<name>/          forward slashes (incl. file:///C:/Users/<name>)
//   \\HOST\share\Users\<n>    UNC (only the Users\<name> part is replaced)
//   C:\\Users\\<name>         JSON-escaped (doubled backslashes are matched by
//                             the same [\\/]+ separator class)
//   C%3A%5CUsers%5C<n>        URL-encoded (incl. %25-nested double encoding)
//
// Anchoring (false-positive guard): a drive-rooted match REQUIRES a drive
// letter + colon, "Users" as the FIRST path segment (case-insensitive), and
// at least one following name segment. A UNC match REQUIRES a leading
// \\HOST\ (or //HOST/) prefix chain. Negatives that stay untouched by design:
//   D:\Temp\x   C:\User\x   Usersfile   C:\Users\ (no name)   /home/user/
//
// Name-segment terminators: path separators, whitespace, quotes, comma,
// semicolon, parentheses, EOF. The trailing separator after the name is NOT
// consumed, so substituting the token in place never corrupts surrounding
// structure (further path components, raw-JSON backslash pairs, quotes).
//
// Replacement token (ONE, used by every sink): C:\Users\***
// (No trailing backslash — the unconsumed trailing separator, if any, stays
// in the source text right after the token.)
//
// Failure mode: this function NEVER throws; degenerate/unexpected input is
// returned unchanged.

const USERPATH_TOKEN = 'C:\\Users\\***';
// Drive-rooted form: [A-Za-z]: + any mix of \ and / + "Users" (any case) +
// name segment (1+ chars, stops at separators and prose terminators).
const DRIVE_USERPATH = /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"';()]+/gi;
// UNC form: (\\HOST\share\... or //HOST/share/...) + Users + name. Only the
// Users\<name> part is replaced; the share prefix (capture group 1) is kept.
// Host/share segments exclude ':', so URL forms like file:///C:/Users/... are
// NOT treated as UNC and stay reachable for the drive-rooted rule.
const UNC_USERPATH = /((?:\\\\|\/\/)(?:[^\\/\s"';():]+[\\/]+)+)Users[\\/]+[^\\/\s"';()]+/gi;
// URL-encoded form: drive letter + (%-nested) encoded colon, then a run of
// chars that cannot terminate an encoded path in log prose.
const ENCODED_DRIVE_HEAD = /[A-Za-z]%(?:25){0,2}3a[^\s"';()\\]*/gi;
// Anchored probe applied to the fully decoded candidate.
const DRIVE_USERPATH_PROBE = /^[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"';()]+/i;
// Fallback probe for candidates that fail to decode (malformed %-tail): still
// redact when the raw encoded text unambiguously starts as drive+Users.
const ENCODED_USERPATH_PROBE = /^[A-Za-z]%(?:25){0,2}3a(?:%(?:25){0,2}(?:5c|2f))+users/i;

function redactEncodedUserPaths(value) {
  return value.replace(ENCODED_DRIVE_HEAD, (candidate) => {
    let decoded = candidate;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let next;
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

export function redactUserPaths(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  try {
    let result = redactEncodedUserPaths(text);
    result = result.replace(UNC_USERPATH, (_match, prefix) => `${prefix}${USERPATH_TOKEN}`);
    result = result.replace(DRIVE_USERPATH, USERPATH_TOKEN);
    return result;
  } catch {
    // Redaction must never break the caller — return the input untouched.
    return text;
  }
}
