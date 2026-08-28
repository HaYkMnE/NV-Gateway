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
