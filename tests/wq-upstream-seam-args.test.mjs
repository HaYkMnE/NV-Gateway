// Regression test for tests/local-upstream-preload.cjs: the seam must survive
// EVERY argument shape Node's http/https accept.
//
// MEASURED DEFECT (CodeRabbit deep audit, W-Q wave): the seam was written as
// `function (options, callback)` only, so a caller using the documented
// `https.get(url, cb)` form reached it as options="https://…" and
// callback=<the real OPTIONS object>. http.get then threw
//   TypeError: The "listener" argument must be of type function
// and the redirect never happened — the seam silently defeated itself for that
// call shape. `https.request(url, cb)` had the identical hole.
//
// The child below `--require`s the seam, so the module is exercised exactly as
// the real gateway tests load it (a fresh process with patched module bindings),
// not through a re-implementation of it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const seam = path.join(root, 'tests', 'local-upstream-preload.cjs');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-wq-seam-${process.pid}-`));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// Runs INSIDE the child. Every call shape is driven against a real fake
// upstream; the fallback case deletes the port env var and asserts the request
// leaves over TLS (i.e. the patch delegated to the original https.get).
const HARNESS = [
  "const http = require('node:http');",
  "const https = require('node:https');",
  '',
  'const results = [];',
  'function call(label, invoke, { end = false } = {}) {',
  '  return new Promise((resolve) => {',
  '    let settled = false;',
  '    const done = (ok, detail) => { if (settled) return; settled = true; results.push({ label, ok, detail }); resolve(); };',
  '    const timer = setTimeout(() => done(false, "timed out"), 5000);',
  '    try {',
  '      const req = invoke((res) => {',
  '        const chunks = [];',
  '        res.on("data", (chunk) => chunks.push(chunk));',
  '        res.on("end", () => {',
  '          clearTimeout(timer);',
  '          const body = Buffer.concat(chunks).toString();',
  '          done(res.statusCode === 200 && body === "local-fake", "status=" + res.statusCode + " body=" + body);',
  '        });',
  '      });',
  '      req.on("error", (error) => { clearTimeout(timer); done(false, "request error: " + error.message); });',
  '      if (end) req.end();',
  '    } catch (error) {',
  '      clearTimeout(timer);',
  '      done(false, "threw: " + error.message);',
  '    }',
  '  });',
  '}',
  '',
  'const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("local-fake"); });',
  '',
  'server.listen(0, "127.0.0.1", async () => {',
  '  const port = server.address().port;',
  '  process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT = String(port);',
  '  const url = "https://upstream.invalid/v1/models";',
  '',
  '  await call("get(url, cb)", (cb) => https.get(url, cb));',
  '  await call("get(url, options, cb)", (cb) => https.get(url, { headers: { "x-a": "1" } }, cb));',
  '  await call("get(options, cb)", (cb) => https.get({ hostname: "upstream.invalid", path: "/v1/models", headers: { "x-a": "1" } }, cb));',
  '  await call("request(url, cb)", (cb) => https.request(url, cb), { end: true });',
  '  await call("request(url, options, cb)", (cb) => https.request(url, { headers: { "x-a": "1" } }, cb), { end: true });',
  '  await call("request(options, cb)", (cb) => https.request({ hostname: "upstream.invalid", path: "/v1/models" }, cb), { end: true });',
  '',
  '  // FAIL-CLOSED: with no local port configured the patch must delegate to the',
  '  // ORIGINAL https implementation. The discriminator is TLS: the fake upstream',
  '  // speaks plain HTTP, so a correctly-delegated https request can never receive',
  '  // its 200 "local-fake" response — it fails the handshake instead.',
  '  delete process.env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT;',
  '  const fallback = await new Promise((resolve) => {',
  '    let settled = false;',
  '    const done = (value) => { if (settled) return; settled = true; resolve(value); };',
  '    const timer = setTimeout(() => done({ outcome: "timed out" }), 5000);',
  '    let req;',
  '    try {',
  '      req = https.get("https://127.0.0.1:" + port + "/nope", () => { clearTimeout(timer); done({ outcome: "response" }); });',
  '    } catch (error) {',
  '      clearTimeout(timer);',
  '      done({ outcome: "threw", message: error.message });',
  '      return;',
  '    }',
  '    req.on("error", (error) => { clearTimeout(timer); done({ outcome: "error", code: error.code ?? null }); });',
  '  });',
  '',
  '  process.stdout.write("WQ_RESULT " + JSON.stringify({ results, fallback }) + "\\n");',
  '  server.closeAllConnections?.();',
  '  server.close(() => process.exit(0));',
  '  setTimeout(() => process.exit(0), 1000).unref();',
  '});',
  ''
].join('\n');

test('the local-upstream seam intercepts get/request in all three argument shapes', () => {
  const harnessPath = path.join(tmpRoot, 'harness.cjs');
  fs.writeFileSync(harnessPath, HARNESS);
  const env = { ...process.env };
  delete env.GATEWAY_TEST_LOCAL_UPSTREAM_PORT;
  delete env.GATEWAY_TEST_UPSTREAM_BODY_BARRIER;
  const run = spawnSync(process.execPath, ['--require', seam, harnessPath], { encoding: 'utf8', timeout: 40_000, env });
  const output = `${run.stdout}${run.stderr}`;
  const line = run.stdout.split('\n').find((entry) => entry.startsWith('WQ_RESULT '));
  assert.ok(line, `the harness produced no result (exit ${run.status}): ${output}`);
  const { results, fallback } = JSON.parse(line.slice('WQ_RESULT '.length));

  assert.equal(results.length, 6, `all six call shapes must be exercised: ${JSON.stringify(results)}`);
  for (const entry of results) {
    assert.equal(entry.ok, true, `${entry.label} must be intercepted, got: ${entry.detail}`);
  }

  // A host the seam has no instruction to redirect must still go out for real.
  assert.equal(fallback.outcome, 'error',
    `a non-intercepted host must fail closed (never answer from the fake upstream): ${JSON.stringify(fallback)}`);
});
