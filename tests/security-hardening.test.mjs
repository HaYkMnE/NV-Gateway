// Phase 5: opt out of the nvidia-catalog-sync top-level background warm so this
// test process does not make real NGC network calls during the admin-api import
// here (admin-api.mjs now imports nvidia-catalog-sync.mjs, which self-warms at
// top level unless NGC_CATALOG_SYNC_DISABLE_WARM=1). Same rationale as
// production-security-wiring.test.mjs — hermeticism without behavior drift.
process.env.NGC_CATALOG_SYNC_DISABLE_WARM = "1";

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

test('redactor recursively removes credentials, bearer values, nvapi keys and query values', async () => {
  const { redact } = await import(pathToFileURL(path.join(root, 'src/shared/redaction.mjs')).href);
  const value = redact({ authorization: 'Bearer abc', nested: { apiKey: 'nvapi-secret', url: 'https://x.test/a?token=bad' }, stderr: 'failed Bearer xyz nvapi-123' });
  const text = JSON.stringify(value);
  assert.equal(text.includes('abc'), false);
  assert.equal(text.includes('nvapi-secret'), false);
  assert.equal(text.includes('xyz'), false);
  assert.equal(text.includes('token=bad'), false);
  assert.equal(value.nested.url, 'https://x.test/a');
});

test('security helpers use exact bearer comparison, route allowlists and strict CORS', async () => {
  const security = await import(pathToFileURL(path.join(root, 'src/gateway/security.mjs')).href);
  assert.equal(security.isBearerAuthorized('Bearer local-token', 'local-token'), true);
  assert.equal(security.isBearerAuthorized('Bearer local-token-x', 'local-token'), false);
  assert.equal(security.classifyGatewayRoute('GET', '/v1/models'), 'models');
  assert.equal(security.classifyGatewayRoute('POST', '/v1/chat/completions'), 'chat');
  assert.equal(security.classifyGatewayRoute('GET', '/v1/chat/completions'), null);
  assert.equal(security.classifyGatewayRoute('POST', '/v1/other'), null);
  assert.equal(security.isAllowedOrigin('https://allowed.test', ['https://allowed.test']), true);
  assert.equal(security.isAllowedOrigin('https://evil.test', ['https://allowed.test']), false);
});

// MASTER-006: the Anthropic facade (/v1/messages) additionally accepts the
// `x-api-key` credential (Anthropic SDK / Claude Code default), while every
// other public route stays Bearer-only. An explicit Authorization header is
// authoritative: a wrong Bearer is never rescued by a valid x-api-key.
test('gateway route authorization: Bearer is authoritative, x-api-key is a /v1/messages-only fallback', async () => {
  const security = await import(pathToFileURL(path.join(root, 'src/gateway/security.mjs')).href);
  const token = 'local-token';
  // x-api-key fallback: only on the Anthropic messages route, only with no Authorization header.
  assert.equal(security.isGatewayRouteAuthorized('messages', { 'x-api-key': token }, token), true);
  assert.equal(security.isGatewayRouteAuthorized('messages', { 'x-api-key': `${token}-x` }, token), false);
  assert.equal(security.isGatewayRouteAuthorized('chat', { 'x-api-key': token }, token), false);
  assert.equal(security.isGatewayRouteAuthorized('models', { 'x-api-key': token }, token), false);
  // Bearer still works on every route, including messages.
  assert.equal(security.isGatewayRouteAuthorized('messages', { authorization: `Bearer ${token}` }, token), true);
  assert.equal(security.isGatewayRouteAuthorized('chat', { authorization: `Bearer ${token}` }, token), true);
  // An explicit Authorization header is authoritative: valid Bearer wins over a wrong x-api-key...
  assert.equal(security.isGatewayRouteAuthorized('messages', { authorization: `Bearer ${token}`, 'x-api-key': 'wrong' }, token), true);
  // ...and a wrong Bearer is NOT rescued by a valid x-api-key.
  assert.equal(security.isGatewayRouteAuthorized('messages', { authorization: 'Bearer wrong', 'x-api-key': token }, token), false);
  // No credential at all — or no configured token — is never authorized.
  assert.equal(security.isGatewayRouteAuthorized('messages', {}, token), false);
  assert.equal(security.isGatewayRouteAuthorized('messages', { 'x-api-key': token }, ''), false);
  assert.equal(security.isGatewayRouteAuthorized('messages', { 'x-api-key': token }, undefined), false);
});

test('admin schemas enforce canonical UUID, statuses, bounded unique reorder and token format', async () => {
  const schema = await import(pathToFileURL(path.join(root, 'src/gateway/admin-schema.mjs')).href);
  assert.equal(schema.parseUuid('550e8400-e29b-41d4-a716-446655440000').ok, true);
  assert.equal(schema.parseUuid('550E8400-E29B-41D4-A716-446655440000').ok, false);
  assert.equal(schema.parseStatus('active').ok, true);
  assert.equal(schema.parseStatus('root').ok, false);
  assert.equal(schema.parseToken(' nvapi-test ').value, 'nvapi-test');
  assert.equal(schema.parseReorder(['550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440000']).ok, false);
});

test('IPC sender and argument helpers reject subframes, unexpected origins, and invalid values', async () => {
  const { validateIpcSender, validators } = await import(pathToFileURL(path.join(root, 'build/src/main/ipc-security.js')).href);
  const frame = { url: 'file:///app/index.html', parent: null };
  assert.doesNotThrow(() => validateIpcSender({ senderFrame: frame }, ['file:///app/index.html']));
  assert.doesNotThrow(() => validateIpcSender({ senderFrame: { url: `${frame.url}#/wizard`, parent: null } }, [frame.url]));
  assert.throws(() => validateIpcSender({ senderFrame: { url: `${frame.url}?route=wizard`, parent: null } }, [frame.url]), /origin/);
  assert.throws(() => validateIpcSender({ senderFrame: { url: 'file:///app/other.html#/wizard', parent: null } }, [frame.url]), /origin/);
  assert.throws(() => validateIpcSender({ senderFrame: { url: frame.url, parent: frame } }, [frame.url]), /sender/);
  assert.throws(() => validateIpcSender({ senderFrame: { url: 'https://evil.test', parent: null } }, [frame.url]), /origin/);
  assert.doesNotThrow(() => validators.port(12004));
  assert.throws(() => validators.port('12004'), /port/);
});

test('admin handler rejects missing token before reading body', async () => {
  // Per-run temp dir, NOT tests/: the gateway logger derives its file from
  // GATEWAY_LOG_PATH and appends there on a 1s debounce, so a path inside the
  // repo left an ignored *.jsonl side-effect file behind on every run.
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), `nv-security-hardening-${process.pid}-`));
  process.env.GATEWAY_ADMIN_TOKEN = 'admin-secret-token';
  process.env.GATEWAY_STATE_PATH = path.join(logDir, 'non-live-state.json');
  process.env.GATEWAY_LOG_PATH = path.join(logDir, 'non-live-log.jsonl');
  const { createAdminRequestHandler } = await import(`${pathToFileURL(path.join(root, 'src/gateway/admin-api.mjs')).href}?security=${Date.now()}`);
  const handler = createAdminRequestHandler({ listKeys: () => [] });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const unauthorized = await request(server.address().port, '/admin/keys');
    assert.equal(unauthorized.statusCode, 401);
    const authorized = await request(server.address().port, '/admin/keys', { authorization: 'Bearer admin-secret-token' });
    assert.equal(authorized.statusCode, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('encrypted state format and migration never retain plaintext fake keys', async () => {
  const fs = await import('node:fs'); const os = await import('node:os');
  const module = await import(pathToFileURL(path.join(root, 'build/src/main/secure-state.js')).href);
  const adapter = { encrypt: (value) => Buffer.from(value).reverse(), decrypt: (value) => Buffer.from(value).reverse() };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-secure-state-')); const state = path.join(dir, 'keys.json');
  fs.writeFileSync(state, JSON.stringify({ keys: [{ key: 'nvapi-fake-plaintext' }] }));
  module.migratePlaintextStateAtomically(state, adapter);
  assert.equal(fs.readFileSync(state).includes(Buffer.from('nvapi-fake-plaintext')), false);
  assert.equal(fs.readFileSync(`${state}.encrypted.bak`).includes(Buffer.from('nvapi-fake-plaintext')), false);
  assert.equal(module.decodeEncryptedState(fs.readFileSync(state), adapter).keys[0].key, 'nvapi-fake-plaintext');
  fs.rmSync(dir, { recursive: true, force: true });
});

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      res.resume(); res.on('end', () => resolve({ statusCode: res.statusCode }));
    });
    req.on('error', reject);
  });
}
