import { MAX_CHILD_KEYS, MAX_KEY_LENGTH } from "./state-ownership";

const MINIMAL_ROOT_FIELDS = ["upstreams"] as const;
const FULL_ROOT_FIELDS = [
  "name",
  "port",
  "localKey",
  "stateFile",
  "defaultCooldownSeconds",
  "timeoutCooldownSeconds",
  "requestTimeoutMs",
  "maxFailoverAttempts",
  "allowedModels",
  "localModels",
  "chatUrl",
  "modelsUrl",
  "upstreams",
  "headerTimeoutMs",
  "idleTimeoutMs",
  "rateLimitCooldownSeconds",
  "lockTimeoutMs",
  "maxStreamDurationMs"
] as const;

const STRING_FIELDS = ["name", "localKey", "stateFile", "chatUrl", "modelsUrl"] as const;
const ARRAY_FIELDS = ["allowedModels", "localModels", "upstreams"] as const;
const NON_NEGATIVE_INTEGER_FIELDS = [
  "defaultCooldownSeconds",
  "timeoutCooldownSeconds",
  "requestTimeoutMs",
  "maxFailoverAttempts",
  "headerTimeoutMs",
  "idleTimeoutMs",
  "rateLimitCooldownSeconds",
  "lockTimeoutMs",
  "maxStreamDurationMs"
] as const;

function fail(code: string): never { throw new Error(code); }

function isExactFieldSet(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const names = Object.keys(value);
  return names.length === fields.length && names.every((name) => fields.includes(name));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isValidPort(value: unknown): value is number {
  return isNonNegativeInteger(value) && value >= 1 && value <= 65_535;
}

function isValidFullLegacyRoot(root: Record<string, unknown>): boolean {
  return isExactFieldSet(root, FULL_ROOT_FIELDS)
    && STRING_FIELDS.every((field) => typeof root[field] === "string")
    && ARRAY_FIELDS.every((field) => Array.isArray(root[field]))
    && isValidPort(root.port)
    && NON_NEGATIVE_INTEGER_FIELDS.every((field) => isNonNegativeInteger(root[field]));
}

export function parseLegacyNvidiaDocument(document: unknown): string[] {
  if (!document || typeof document !== "object" || Array.isArray(document)) fail("LEGACY_SOURCE_SHAPE");
  const root = document as Record<string, unknown>;
  if (!isExactFieldSet(root, MINIMAL_ROOT_FIELDS) && !isValidFullLegacyRoot(root)) fail("LEGACY_SOURCE_SHAPE");
  if (!Array.isArray(root.upstreams) || root.upstreams.length > MAX_CHILD_KEYS) fail("LEGACY_SOURCE_SHAPE");

  const seen = new Set<string>();
  return root.upstreams.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("LEGACY_UPSTREAM_SHAPE");
    const upstream = entry as Record<string, unknown>;
    if (!isExactFieldSet(upstream, ["apiKey"]) || typeof upstream.apiKey !== "string") fail("LEGACY_UPSTREAM_SHAPE");
    const key = upstream.apiKey.trim();
    if (!key || key.length > MAX_KEY_LENGTH) fail("LEGACY_KEY_INVALID");
    if (seen.has(key)) fail("LEGACY_KEY_DUPLICATE");
    seen.add(key);
    return key;
  });
}
