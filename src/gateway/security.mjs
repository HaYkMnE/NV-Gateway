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

// MASTER-006: an explicit Authorization header is authoritative on every public
// route; `x-api-key` is accepted only as a fallback credential on the Anthropic
// facade (route === 'messages') when no Authorization header was sent.
export function isGatewayRouteAuthorized(route, headers, token) {
  if (typeof token !== 'string' || token.length === 0) return false;
  const authorization = headers && headers.authorization;
  if (typeof authorization === 'string') return isBearerAuthorized(authorization, token);
  const apiKey = headers && headers['x-api-key'];
  if (route === 'messages' && typeof apiKey === 'string') return constantTimeEqual(apiKey, token);
  return false;
}

// Canonical public path per classified route. The server rewrites the inbound
// URL to this value after auth so upstream paths are built from the route.
export const GATEWAY_ROUTE_PATHS = Object.freeze({
  models: '/v1/models',
  chat: '/v1/chat/completions',
  messages: '/v1/messages',
  // OpenAI Responses API facade (Codex CLI `wire_api = "responses"`).
  responses: '/v1/responses'
});

// Callers pass the URL PATHNAME only (never the query). Exactly ONE trailing
// slash is tolerated on the known routes (`/v1/models/` -> `/v1/models`) for
// client compatibility; dot-segments are resolved by WHATWG URL before
// classification; `//` and percent-encoding are not normalized, so any other
// variant stays unclassified (404).
export function classifyGatewayRoute(method, rawPathname) {
  const pathname = typeof rawPathname === 'string' && rawPathname.length > 1 && rawPathname.endsWith('/') && !rawPathname.endsWith('//')
    ? rawPathname.slice(0, -1)
    : rawPathname;
  if (method === 'GET' && pathname === '/v1/models') return 'models';
  if (method === 'POST' && pathname === '/v1/chat/completions') return 'chat';
  if (method === 'POST' && pathname === '/v1/messages') return 'messages';
  if (method === 'POST' && pathname === '/v1/responses') return 'responses';
  return null;
}

export function isAllowedOrigin(origin, allowlist) {
  return typeof origin === 'string' && allowlist.some((allowed) => constantTimeEqual(origin, allowed));
}

export function parseCorsAllowlist(raw = '') {
  return raw.split(',').map((value) => value.trim()).filter((value) => /^https?:\/\/[^/]+$/.test(value));
}
