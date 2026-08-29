import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const bundlePath = path.join(root, 'build', 'gateway', 'server.mjs');
const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `nvgw-engine-bundle-${process.pid}-`)));
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

// ───────────────────────────────────────────────────────────────────────────
// The engine must ship as ONE minified bundle, never as readable sources.
//
// extraResources used to copy src/gateway verbatim, so an installed copy held
// the whole engine annotated with the comments that document hard-won upstream
// behaviour: that a 429 is scoped to BOTH the key and the model, how NVIDIA's
// two structurally different 404s distinguish an NVCF dispatch failure, and how
// validation-error text is parsed to discover reasoning modes. Those comments
// are worth more than the code they explain.
//
// MARKER CHOICE: every marker below is verified to EXIST in src/gateway (see the
// first test) before being asserted absent from the shipped artifact. A marker
// that is missing from the sources too would make the absence assertion vacuous.
// Identifiers that live in FUNCTIONAL code are deliberately excluded — "NVCF"
// survives minification because isNvcfDispatchFailure matches the nvcf-status /
// nvcf-reqid response headers, and stripping it would break NVCF detection.
// ───────────────────────────────────────────────────────────────────────────

/** Prose that exists only inside engine comments. */
const MOAT_MARKERS = Object.freeze([
  'MODEL-SCOPED',
  'uniform-429',
  '40 RPM',
  'TerminateProcess',
  'Live evidence',
  'stability-audit',
  'function-dispatch',
  'rate-limit storm',
  'sticky',
  'Retry-After header',
  'event loop'
]);

/** Engine modules that must never appear as separate shipped files. */
const ENGINE_MODULES = Object.freeze([
  'rotation.mjs', 'failover-policy.mjs', 'capability-probe.mjs', 'model-key-affinity.mjs',
  'logger.mjs', 'admin-api.mjs', 'proxy-headers.mjs', 'model-discovery.mjs',
  'anthropic-adapter.mjs', 'validation.mjs', 'security.mjs', 'model-limits.mjs',
  'nvidia-catalog-sync.mjs', 'performance-mode.mjs', 'upstream-timeouts.mjs',
  'bounded-buffer.mjs', 'admin-schema.mjs', 'capability-registry.mjs',
  'direct-glm-probe.mjs', 'redaction.mjs'
]);

function readSourceCorpus() {
  const files = [
    ...fs.readdirSync(path.join(root, 'src', 'gateway')).map((name) => path.join(root, 'src', 'gateway', name)),
    ...fs.readdirSync(path.join(root, 'src', 'shared')).map((name) => path.join(root, 'src', 'shared', name))
  ].filter((file) => file.endsWith('.mjs'));
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

test('every moat marker really exists in the engine sources (guards against a vacuous absence test)', () => {
  const corpus = readSourceCorpus();
  for (const marker of MOAT_MARKERS) {
    assert.ok(corpus.includes(marker),
      `marker ${JSON.stringify(marker)} is absent from src/gateway, so asserting its absence downstream would prove nothing`);
  }
});

test('the built engine bundle exists, is a single non-empty file, and carries no comments', () => {
  assert.equal(fs.existsSync(bundlePath), true, `engine bundle missing: ${bundlePath} (run npm run build)`);
  const bundle = fs.readFileSync(bundlePath, 'utf8');

  // Positive control: a real artifact, not a stub.
  assert.ok(bundle.length > 20_000, `bundle looks truncated: ${bundle.length} bytes`);
  assert.match(bundle, /["']ports:bound["']/, 'the bundle must contain the real engine, not a placeholder');

  // Exactly one file in the output directory.
  assert.deepEqual(fs.readdirSync(path.join(root, 'build', 'gateway')), ['server.mjs'],
    'the engine must build to exactly one file');

  // Comments are gone. Block-comment delimiters must be absent outright, and so
  // must JSDoc tokens — those are unambiguous: they can only ever occur inside a
  // comment, so unlike a raw "//" scan they cannot false-positive on functional
  // code (the minified bundle legitimately contains "//" inside URL string
  // literals and inside regex literals such as /^https?:\/\//i).
  for (const token of ['/*', '*/', '@param', '@returns', '@type', '@module', ' * ']) {
    assert.equal(bundle.includes(token), false,
      `comment token ${JSON.stringify(token)} must not survive minification`);
  }

  // Structural proof that this is genuinely minified rather than concatenated:
  // the sources are ~7100 lines across ~312 KB, the bundle a couple of dozen.
  assert.ok(bundle.split('\n').length < 100,
    `a minified bundle must not be line-formatted, saw ${bundle.split('\n').length} lines`);
});

test('the built engine bundle contains none of the moat comments', () => {
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  const leaked = MOAT_MARKERS.filter((marker) => bundle.includes(marker));
  assert.deepEqual(leaked, [], `moat comments leaked into the shipped bundle: ${JSON.stringify(leaked)}`);
});

test('the packaged output ships no engine sources, only the bundle', (t) => {
  const resources = path.join(root, 'dist', 'win-unpacked', 'resources');
  if (!fs.existsSync(resources)) {
    t.skip('no packaged output in this run (build:portable / package:dir produces it)');
    return;
  }
  const gateway = path.join(resources, 'gateway');
  assert.equal(fs.existsSync(gateway), true, 'resources/gateway must exist');

  // Exactly the bundle, nothing else.
  assert.deepEqual(fs.readdirSync(gateway), ['server.mjs'],
    'resources/gateway must hold the bundle alone');

  // src/shared is no longer shipped: redaction.mjs is inlined into the bundle
  // and src/main uses its own compiled ./redaction.
  assert.equal(fs.existsSync(path.join(resources, 'shared')), false,
    'resources/shared must not be shipped any more');

  // No engine module may appear anywhere under resources, under any name.
  const shipped = [];
  (function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else shipped.push(full);
    }
  })(resources);
  for (const moduleName of ENGINE_MODULES) {
    const hit = shipped.find((file) => path.basename(file) === moduleName);
    assert.equal(hit, undefined, `engine source shipped in the package: ${hit}`);
  }

  // And the packaged bundle carries no moat comments either.
  const packaged = fs.readFileSync(path.join(gateway, 'server.mjs'), 'utf8');
  const leaked = MOAT_MARKERS.filter((marker) => packaged.includes(marker));
  assert.deepEqual(leaked, [], `moat comments leaked into the package: ${JSON.stringify(leaked)}`);
});

// ───────────────────────────────────────────────────────────────────────────
// FUNCTIONAL PROOF: the bundle must actually RUN, not merely exist. The engine
// is spawned from build/gateway/server.mjs (never from src) and driven through a
// fake upstream, so proxying, key rotation and failover are proven on the very
// artifact that ships.
// ───────────────────────────────────────────────────────────────────────────

test('the bundled engine proxies a request end to end', async () => {
  const harness = await startBundledGateway({
    keys: ['key-0', 'key-1'],
    responses: [{ status: 200, body: '{"choices":[{"message":{"content":"bundled-ok"}}]}' }]
  });
  try {
    const result = await chat(harness.port, 'deepseek-ai/deepseek-v3');
    assert.equal(result.statusCode, 200, 'the bundled engine must serve a request');
    assert.deepEqual(JSON.parse(result.body), { choices: [{ message: { content: 'bundled-ok' } }] });
    assert.equal(harness.seenAuthorizations.length, 1, 'exactly one upstream call');
    assert.match(harness.seenAuthorizations[0], /^Bearer key-/, 'a pool key was injected upstream');
  } finally {
    await harness.close();
  }
});

test('the bundled engine still fails over across keys and rotates on a per-key fault', async () => {
  const harness = await startBundledGateway({
    keys: ['key-0', 'key-1', 'key-2'],
    responses: [
      { status: 503, body: '{"error":"Service unavailable"}' },
      { status: 503, body: '{"error":"Service unavailable"}' },
      { status: 200, body: '{"choices":[{"message":{"content":"recovered"}}]}' }
    ]
  });
  try {
    const result = await chat(harness.port, 'moonshotai/kimi-k2');
    assert.equal(result.statusCode, 200, 'failover must reach a key that succeeds');
    assert.deepEqual(JSON.parse(result.body), { choices: [{ message: { content: 'recovered' } }] });
    assert.equal(harness.seenAuthorizations.length, 3, 'all three keys were tried in order');
    assert.equal(new Set(harness.seenAuthorizations).size, 3, 'each attempt used a DISTINCT key');
  } finally {
    await harness.close();
  }
});

test('the bundled engine keeps the model-scoped rate-limit semantics', async () => {
  // A 429 for modelA must not evict the key for modelB — the per-model routing
  // behaviour, proven on the shipped artifact rather than on the sources.
  const harness = await startBundledGateway({
    keys: ['key-0', 'key-1'],
    maxFailoverAttempts: 2,
    respond: ({ model, apiKey }) => {
      if (model === 'modelA') return { status: 429, body: '{"error":"rate limit"}' };
      if (apiKey === 'key-0') return { status: 200, body: '{"served_by":"key-0"}' };
      return { status: 429, body: '{"error":"rate limit"}' };
    }
  });
  try {
    assert.equal((await chat(harness.port, 'modelB')).statusCode, 200, 'modelB is served first');
    assert.equal((await chat(harness.port, 'modelA')).statusCode, 429, 'modelA is genuinely rate-limited');

    harness.seenAuthorizations.length = 0;
    const after = await chat(harness.port, 'modelB');
    assert.equal(after.statusCode, 200, 'modelB must still succeed after modelA was rate-limited');
    assert.deepEqual(harness.seenAuthorizations, ['Bearer key-0'],
      'modelB reaches its own key immediately: the 429 was scoped to (modelA, key-0)');
  } finally {
    await harness.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Harness — spawns the BUNDLE. Mirrors startGatewayHarnessNoOverride in
// tests/key-rotation-and-validation.test.mjs, with the entry point swapped.
// ───────────────────────────────────────────────────────────────────────────

async function startBundledGateway({ keys, responses, respond, maxFailoverAttempts }) {
  assert.equal(fs.existsSync(bundlePath), true, `engine bundle missing: ${bundlePath}`);
  const dir = fs.mkdtempSync(path.join(tempRoot, 'run-'));
  const logPath = path.join(dir, 'logs', 'gateway.jsonl');
  const seenAuthorizations = [];
  const queue = [...(responses ?? [])];

  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seenAuthorizations.push(req.headers.authorization);
      let model;
      try { model = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.model; } catch { model = undefined; }
      const apiKey = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const answer = respond ? respond({ model, apiKey }) : (queue.shift() ?? { status: 500, body: '{}' });
      res.writeHead(answer.status, answer.headers ?? { 'content-type': 'application/json' });
      res.end(answer.body ?? '{}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const keyRecords = keys.map((key, index) => ({
    id: `0000000${index}-0000-4000-8000-00000000000${index}`,
    key,
    status: 'active',
    backoffUntil: 0,
    usage: { success: 0, fail: 0, tokens: 0, lastUsed: index + 1 }
  }));

  let port;
  let child;
  let ready = false;
  for (let attempt = 0; attempt < 3 && !ready; attempt++) {
    port = await freePortPair();
    const env = {
      ...process.env,
      GATEWAY_LOG_PATH: logPath,
      GATEWAY_MODEL_AFFINITY_CACHE_PATH: path.join(dir, 'model-key-affinity.json'),
      GATEWAY_TEST_LOCAL_UPSTREAM_PORT: String(upstream.address().port),
      PORT: String(port)
    };
    if (maxFailoverAttempts) env.GATEWAY_MAX_FAILOVER_ATTEMPTS = String(maxFailoverAttempts);
    else delete env.GATEWAY_MAX_FAILOVER_ATTEMPTS;

    // THE POINT: the entry point is the BUNDLE, not src/gateway/server.mjs.
    child = spawn(process.execPath, ['--require', path.join(root, 'tests/local-upstream-preload.cjs'), bundlePath], {
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true
    });

    child.once('message', (message) => {
      if (message?.type === 'ready') {
        child.send({
          type: 'state:init',
          challenge: message.challenge,
          state: { keys: keyRecords, credentials: { gatewayToken: 'test-gateway-token', adminToken: 'test-admin-token' } }
        });
      }
    });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        if ((await request(port, '/health')).statusCode === 200) { ready = true; break; }
      } catch { /* not up yet */ }
      if (child.exitCode !== null) break;
      await delay(25);
    }
    if (!ready && child.exitCode === null) { child.kill('SIGKILL'); await delay(100); }
  }
  if (!ready) {
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    throw new Error(`The bundled gateway did not become healthy on port ${port}.`);
  }

  return {
    port,
    seenAuthorizations,
    close: async () => {
      if (child.exitCode === null) {
        try { if (child.connected) child.send({ type: 'shutdown' }); } catch { /* already closing */ }
        const until = Date.now() + 2_000;
        while (Date.now() < until && child.exitCode === null) await delay(20);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      upstream.closeAllConnections?.();
      await new Promise((resolve) => upstream.close(resolve));
    }
  };
}

function chat(port, model) {
  return request(port, '/v1/chat/completions', 'POST', JSON.stringify({
    model, stream: false, messages: [{ role: 'user', content: 'hi' }]
  }));
}

function request(port, url, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: url, method,
      headers: {
        authorization: 'Bearer test-gateway-token',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** The engine binds PORT and PORT+1 (admin), so the pair must be reserved together. */
async function freePortPair() {
  while (true) {
    const first = http.createServer();
    await new Promise((resolve) => first.listen(0, '127.0.0.1', resolve));
    const port = first.address().port;
    await new Promise((resolve) => first.close(resolve));
    if (port >= 65534) continue;
    const second = http.createServer();
    try {
      await new Promise((resolve, reject) => {
        second.once('error', reject);
        second.listen(port + 1, '127.0.0.1', resolve);
      });
    } catch { continue; }
    await new Promise((resolve) => second.close(resolve));
    return port;
  }
}
