const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUSES = new Set(['active', 'disabled', 'quota-exceeded']);
export const MAX_TOKEN_LENGTH = 8192;

const fail = (error) => ({ ok: false, error });
export function parseUuid(value) { return typeof value === 'string' && UUID.test(value) ? { ok: true, value } : fail('Invalid canonical UUID'); }
export function parseStatus(value) { return typeof value === 'string' && STATUSES.has(value) ? { ok: true, value } : fail('Invalid status'); }
export function parseToken(value) {
  if (typeof value !== 'string') return fail('Invalid token');
  const token = value.trim();
  return token.length >= 1 && token.length <= MAX_TOKEN_LENGTH && /^[\x21-\x7e]+$/.test(token) ? { ok: true, value: token } : fail('Invalid token');
}
export function parseReorder(value) {
  if (!Array.isArray(value) || value.length > 1000 || value.some((id) => !parseUuid(id).ok) || new Set(value).size !== value.length) return fail('Invalid reorder list');
  return { ok: true, value };
}
