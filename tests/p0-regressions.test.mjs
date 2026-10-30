// Phase 5: opt out of the nvidia-catalog-sync top-level background warm so this
// test process does not make real NGC network calls during the admin-api import
// here (admin-api.mjs now imports nvidia-catalog-sync.mjs, which self-warms at
// top level unless NGC_CATALOG_SYNC_DISABLE_WARM=1). Hermeticism for the
// admin-api admin body limit test below — see production-security-wiring.test.mjs.
process.env.NGC_CATALOG_SYNC_DISABLE_WARM = "1";

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const fileTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nv-p0-regressions-${process.pid}-`));
test.after(() => fs.rmSync(fileTempRoot, { recursive: true, force: true }));

test('fatal shutdown awaits stop, is idempotent, and exits after the deadline on a hung stop', async () => {
  const { createFatalShutdown } = await import(pathToFileURL(path.join(root, 'build/src/main/fatal-shutdown.js')).href);
  const events = [];
  let resolveStop;
  const shutdown = createFatalShutdown({
    stop: () => new Promise((resolve) => { resolveStop = () => { events.push('stopped'); resolve(); }; }),
    exit: (code) => events.push(`exit:${code}`),
    deadlineMs: 50
  });
  const first = shutdown();
  const second = shutdown();
  assert.equal(first, second);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(events, []);
  resolveStop();
  await first;
  assert.deepEqual(events, ['stopped', 'exit:1']);

  const timed = [];
  await createFatalShutdown({ stop: () => new Promise(() => {}), exit: (code) => timed.push(code), deadlineMs: 10 })();
  assert.deepEqual(timed, [1]);
});

test('admin parser counts UTF-8 bytes and returns a controlled 413', async () => {
  const dir = fs.mkdtempSync(path.join(fileTempRoot, 'admin-limit-'));
  process.env.GATEWAY_STATE_PATH = path.join(dir, 'keys.json');
  process.env.GATEWAY_LOG_PATH = path.join(dir, 'gateway.jsonl');
  process.env.GATEWAY_ADMIN_TOKEN = 'test-admin-token';
  fs.writeFileSync(process.env.GATEWAY_STATE_PATH, '{"keys":[]}');
  const module = await import(`${pathToFileURL(path.join(root, 'src/gateway/admin-api.mjs')).href}?limit=${Date.now()}`);
  const { handleAdminRequest } = module;
  const server = http.createServer(handleAdminRequest);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const payload = JSON.stringify({ key: '€'.repeat(350_000) });
    const result = await request(server.address().port, '/admin/keys', 'POST', payload, { authorization: 'Bearer test-admin-token' });
    assert.equal(Buffer.byteLength(payload) > 1e6, true);
    assert.deepEqual(result, { statusCode: 413, body: '{"error":"Payload Too Large"}' });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    const rotation = await import(pathToFileURL(path.join(root, 'src/gateway/rotation.mjs')).href);
    rotation.closeStateWatcher();
    const logger = await import(pathToFileURL(path.join(root, 'src/gateway/logger.mjs')).href);
    logger.closeLogger();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validation settles once on overflow, error, and abort without converting an exceeded buffer', async () => {
  const { collectValidationResponse } = await import(pathToFileURL(path.join(root, 'src/gateway/validation.mjs')).href);
  for (const terminal of ['error', 'aborted', 'end']) {
    const response = new EventEmitter();
    response.statusCode = 500;
    response.destroy = () => {};
    const resultPromise = collectValidationResponse(response, 4);
    response.emit('data', Buffer.from('12345'));
    response.emit(terminal, new Error('later'));
    assert.deepEqual(await resultPromise, { valid: false, error: 'Response too large' });
  }
});

function request(port, url, method, body = '', extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { 'content-length': Buffer.byteLength(body), 'content-type': 'application/json', ...extraHeaders } }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: responseBody }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
