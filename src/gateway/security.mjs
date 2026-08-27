import crypto from 'node:crypto';

export function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = crypto.createHash('sha256').update(left).digest();
  const b = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(a, b);
}

export function isBearerAuthorized(header, token) {
  return typeof header === 'string' && header.startsWith('Bearer ') && constantTimeEqual(header.slice(7), token);
}

export function classifyGatewayRoute(method, pathname) {
  if (method === 'GET' && pathname === '/v1/models') return 'models';
  if (method === 'POST' && pathname === '/v1/chat/completions') return 'chat';
  if (method === 'POST' && pathname === '/v1/messages') return 'messages';
  return null;
}

export function isAllowedOrigin(origin, allowlist) {
  return typeof origin === 'string' && allowlist.some((allowed) => constantTimeEqual(origin, allowed));
}

export function parseCorsAllowlist(raw = '') {
  return raw.split(',').map((value) => value.trim()).filter((value) => /^https?:\/\/[^/]+$/.test(value));
}
