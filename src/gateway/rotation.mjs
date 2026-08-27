import crypto from "node:crypto";
import { info, warn } from "./logger.mjs";

export const MAX_KEY_LENGTH = 8192;
export const MAX_KEYS = 1000;
export const MAX_BACKOFF_MS = 300 * 1000;
// Cooldown placed on a key that received a 429 WITHOUT a Retry-After header.
// Kept small (<=20s): a no-Retry-After rate limit must NOT knock a key out for
// a full minute. getNextKey already SKIPS cooldown keys (it never blocks; it
// only forcibly resets the soonest-backoff key when none are available), so
// this value governs how soon the key is reusable for other loops/requests,
// never a per-switch blocking wait. Exceeding ~20s here would needlessly stall
// a key during a rate-limit storm — keeping it at 20s aligns with the "max ~20s
// between key switches" contract.
export const MAX_KEY_COOLDOWN_429_MS = 20_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUSES = new Set(["active", "disabled", "quota-exceeded"]);
let keys = [];
let saveTimer = null;
let persistAdapter = (state) => {
  if (typeof process.send !== "function") throw new Error("Private persistence channel is unavailable.");
  process.send({ type: "state:persist", state });
};

function normalize(state) {
  if (!state || !Array.isArray(state.keys)) return [];
  let invalidCount = 0;
  const result = state.keys.slice(0, MAX_KEYS).flatMap((record) => {
    const value = typeof record?.key === "string" ? record.key : record?.apiKey;
    const key = typeof value === "string" ? value.trim() : "";
    if (!key || key.length > MAX_KEY_LENGTH) { invalidCount++; return []; }
    const usage = record?.usage && typeof record.usage === "object" ? record.usage : {};
    const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    return [{
        id: typeof record?.id === "string" && UUID_V4.test(record.id) ? record.id : crypto.randomUUID(),
        key,
        status: STATUSES.has(record?.status) ? record.status : "active",
        backoffUntil: count(record?.backoffUntil),
        usage: { success: count(usage.success), fail: count(usage.fail), tokens: count(usage.tokens), lastUsed: count(usage.lastUsed) },
        accessibleModels: Array.isArray(record?.accessibleModels) ? record.accessibleModels.filter((id) => typeof id === "string") : []
    }];
  });
  if (invalidCount) warn("Skipped invalid key records", { count: invalidCount });
  return result;
}

export function initializeState(state) { keys = normalize(state); info("State initialized", { count: keys.length }); }
export function setPersistenceAdapter(adapter) { persistAdapter = adapter; }
export function saveState() {
  // Project the per-key contract the main process validates (state-ownership.ts
  // isChildKeyProjection). Phase 2 widened the contract to accept the optional
  // 6th field accessibleModels: string[] (durable across gateway-child restart);
  // 5-field legacy projections are still accepted. accessibleModels is carried
  // here so a restart restores each key's upstream-accessible catalog (the
  // Models panel is no longer blank after restart) — see normalize() below,
  // which seeds accessibleModels from the persisted record (default []).
  const projection = keys.map((k) => ({
    id: k.id,
    key: k.key,
    status: k.status,
    backoffUntil: k.backoffUntil,
    usage: k.usage,
    accessibleModels: Array.isArray(k.accessibleModels) ? k.accessibleModels.filter((id) => typeof id === "string") : []
  }));
  persistAdapter({ keys: projection });
}
export function flushState() { if (saveTimer) clearTimeout(saveTimer); saveTimer = null; saveState(); }
export function closeStateWatcher() { if (saveTimer) clearTimeout(saveTimer); saveTimer = null; }
export function getKeys() { return keys; }

export function getSoonestActiveCooldownRemainingSeconds() {
  const now = Date.now();
  const activeKeys = keys.filter(k => k.status === 'active');
  if (activeKeys.length === 0) return 20;
  const inBackoff = activeKeys.filter(k => k.backoffUntil > now);
  if (inBackoff.length === 0) return 1;
  const minBackoff = Math.min(...inBackoff.map(k => k.backoffUntil));
  return Math.max(1, Math.min(20, Math.ceil((minBackoff - now) / 1000)));
}

let locked = false;
export function getNextKey() {
  if (locked) return null; locked = true;
  try {
    const now = Date.now();
    const available = keys.filter((key) => key.status === "active" && key.backoffUntil <= now).sort((a, b) => a.usage.lastUsed - b.usage.lastUsed);
    if (available.length > 0) {
      available[0].usage.lastUsed = now;
      return available[0];
    }
    const activeInBackoff = keys.filter((key) => key.status === "active" && key.backoffUntil > now).sort((a, b) => {
      if (a.backoffUntil !== b.backoffUntil) return a.backoffUntil - b.backoffUntil;
      return a.usage.lastUsed - b.usage.lastUsed;
    });
    if (activeInBackoff.length > 0) {
      const candidate = activeInBackoff[0];
      candidate.backoffUntil = 0;
      candidate.usage.lastUsed = now;
      return candidate;
    }
    const activeCount = keys.filter((key) => key.status === "active").length;
    if (activeCount === 0) {
      const quotaKeys = keys.filter((key) => key.status === "quota-exceeded").sort((a, b) => a.usage.lastUsed - b.usage.lastUsed);
      if (quotaKeys.length > 0) {
        const cooledDownQuota = quotaKeys.filter((key) => now - (key.usage.lastUsed || 0) >= 3600000);
        const candidate = cooledDownQuota.length > 0 ? cooledDownQuota[0] : null;
        if (candidate) {
          candidate.status = "active";
          candidate.backoffUntil = 0;
          candidate.usage.lastUsed = now;
          return candidate;
        }
      }
    }
    return null;
  } finally { locked = false; }
}

export function markKeyUsedAndDebounceSave(id, { success, tokens = 0 }) {
  const key = keys.find((item) => item.id === id); if (!key) return;
  key.usage.lastUsed = Date.now(); key.usage[success ? "success" : "fail"] += 1; if (success) key.usage.tokens += tokens;
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; saveState(); }, 5000);
}

export function handleKeyError(id, statusCode, responseBody, retryAfterSeconds) {
  const key = keys.find((item) => item.id === id); if (!key) return;
  let backoffMs = retryAfterSeconds ? retryAfterSeconds * 1000 : 0;
  if (statusCode === 401 || statusCode === 403) { key.status = "disabled"; warn("Key disabled due to auth error", { id, statusCode }); }
  else if (statusCode === 429 && typeof responseBody === "string" && responseBody.toLowerCase().includes("quota")) { key.status = "quota-exceeded"; }
  else if (statusCode === 429 || statusCode >= 500) {
    backoffMs ||= statusCode === 429 ? MAX_KEY_COOLDOWN_429_MS : 10000;
    backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(0, backoffMs));
    key.backoffUntil = Date.now() + backoffMs;
  }
  markKeyUsedAndDebounceSave(id, { success: false });
  if (statusCode >= 500) warn("Upstream error, backing off", { id, statusCode, backoffMs });
}

export function addKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key || key.length > MAX_KEY_LENGTH || keys.length >= MAX_KEYS || keys.some((item) => item.key === key)) return null;
  const result = { id: crypto.randomUUID(), key, status: "active", backoffUntil: 0, usage: { success: 0, fail: 0, tokens: 0, lastUsed: 0 }, accessibleModels: [] };
  keys.push(result); saveState(); info("Key added", { id: result.id, keyCount: keys.length }); return result;
}
export function removeKey(id) { const before = keys.length; keys = keys.filter((item) => item.id !== id); if (keys.length === before) return false; saveState(); return true; }
export function setKeyStatus(id, status) { const key = keys.find((item) => item.id === id); if (!key) return false; key.status = status; if (status === "active") key.backoffUntil = 0; saveState(); return true; }

// Persist the upstream-accessible model catalog onto a stored key record
// (in-memory). Populated by the admin validate-on-add and validate-update
// flows. Defensive: non-array -> []. See Module-level notes in saveState for
// why this is NOT carried in the persist projection.
export function setKeyAccessibleModels(id, accessibleModels) {
  const key = keys.find((item) => item.id === id);
  if (!key) return false;
  key.accessibleModels = Array.isArray(accessibleModels) ? accessibleModels.filter((m) => typeof m === "string") : [];
  saveState();
  return true;
}
export function reorderKeys(ids) { const order = new Map(ids.map((id, index) => [id, index])); keys.sort((a, b) => (order.get(a.id) ?? ids.length) - (order.get(b.id) ?? ids.length)); saveState(); }
