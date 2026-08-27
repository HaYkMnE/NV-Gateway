export const MAX_CHILD_KEYS = 1_000;
export const MAX_KEY_LENGTH = 8_192;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUSES = new Set(["active", "disabled", "quota-exceeded"]);

export interface GatewayKeyProjection {
  id: string;
  key: string;
  status: "active" | "disabled" | "quota-exceeded";
  backoffUntil: number;
  usage: { success: number; fail: number; tokens: number; lastUsed: number };
  /** Phase 2: optional per-key upstream-accessible model catalog. Carried
   *  durably across gateway-child restarts so the Models panel is not blank
   *  after every restart. Optional: 5-field legacy projections are still valid. */
  accessibleModels?: string[];
}

export interface ChildKeyProjection { keys: GatewayKeyProjection[] }

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isChildKeyProjection(value: unknown): value is ChildKeyProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== 1 || !Array.isArray(root.keys) || root.keys.length > MAX_CHILD_KEYS) return false;
  const ids = new Set<string>();
  const materials = new Set<string>();
  return root.keys.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const key = item as Record<string, unknown>;
    const fields = Object.keys(key);
    const hasAccessibleModels = Object.prototype.hasOwnProperty.call(key, "accessibleModels");
    // Accept the 5 required fields (legacy Phase-1 contract) OR a 6-field record
    // that adds the optional accessibleModels: string[] (Phase 2 durable per-key
    // catalog) — and reject any other shape (6 fields without accessibleModels /
    // an injected foreign field / a missing required field). The required-field
    // checks below still apply in both cases.
    if ((fields.length !== 5 && !(fields.length === 6 && hasAccessibleModels))
      || !UUID_V4.test(String(key.id)) || typeof key.key !== "string" || key.key.length === 0 || key.key.length > MAX_KEY_LENGTH || key.key !== key.key.trim()) return false;
    if (typeof key.status !== "string" || !STATUSES.has(key.status) || !isCounter(key.backoffUntil)) return false;
    if (!key.usage || typeof key.usage !== "object" || Array.isArray(key.usage)) return false;
    const usage = key.usage as Record<string, unknown>;
    if (Object.keys(usage).length !== 4 || !isCounter(usage.success) || !isCounter(usage.fail) || !isCounter(usage.tokens) || !isCounter(usage.lastUsed)) return false;
    if (hasAccessibleModels && (!Array.isArray(key.accessibleModels) || !key.accessibleModels.every((m): m is string => typeof m === "string"))) return false;
    const canonicalId = String(key.id).toLowerCase();
    if (ids.has(canonicalId) || materials.has(key.key)) return false;
    ids.add(canonicalId);
    materials.add(key.key);
    return true;
  });
}

export function mergeChildKeyProjection(rootState: unknown, projection: ChildKeyProjection): Record<string, unknown> {
  if (!rootState || typeof rootState !== "object" || Array.isArray(rootState)) throw new Error("STATE_ROOT_INVALID");
  if (!isChildKeyProjection(projection)) throw new Error("STATE_PROJECTION_INVALID");
  return { ...(rootState as Record<string, unknown>), keys: structuredClone(projection.keys) };
}
