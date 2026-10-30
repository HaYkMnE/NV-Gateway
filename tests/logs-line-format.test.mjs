import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// Same loader tests/models-filter-controls.test.mjs uses: transpile the TS to
// CommonJS and run it in a bare context. The sandbox deliberately exposes only
// { Error, exports, module }, so the module under test MUST stay import-free.
function loadTypeScriptExports(relative) {
  const compiled = typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { Error, exports: module.exports, module }, { filename: relative });
  return module.exports;
}

const FORMAT_LIB = 'src/renderer/lib/logs-format.ts';

// ───────────────────────────────────────────────────────────────────────────
// DEFECT (observed at runtime, not inferred): every row of the Logs view reads
//
//   2026-09-05T23:59:33.221Z [INFO] false Gateway started
//                                   ^^^^^
//
// Measured in the running app via the renderer DOM: 7 of 7 rendered <li> rows
// contained a bare "false" token and 0 of 7 contained a duration ("Nms").
//
// ROOT CAUSE — two faults at the SAME expression in Logs.formatLog:
//
//   log.duration !== undefined && `${log.duration}ms`
//
//   (1) FIELD-NAME MISMATCH. The only producer of these records is
//       src/gateway/logger.mjs log() -> getRecentLogs(), fed by
//       src/gateway/server.mjs:1396-1402 and :1409-1416, which emit the field
//       `duration_ms` — never `duration`. So `log.duration` is ALWAYS undefined
//       and the request latency the gateway measures is never displayed.
//
//   (2) BOOLEAN LEAK. Because the guard is `!== undefined &&` (not `&&`), the
//       false branch evaluates to the BOOLEAN `false`, and the array filter only
//       drops `undefined` and `''`. `false` survives, `.map(String)` turns it
//       into the literal text "false", and it is joined into every single line.
//
// Fault (2) is what the user sees; fault (1) is why it fires on 100% of rows.
// Fixing only (1) would still print "false" for any record without a duration
// (every non-request log: "Gateway started", "Admin API started", ...), and
// fixing only (2) would silently keep hiding the latency. Both are required.
// ───────────────────────────────────────────────────────────────────────────

// Records copied VERBATIM from the running gateway's GET /admin/logs response
// (captured through window.electronAPI.adminLogs() in the live app).
const REAL_LIFECYCLE_RECORD = {
  timestamp: '2026-09-05T23:59:33.221Z',
  level: 'info',
  message: 'Gateway started',
  port: 12008
};
const REAL_REQUEST_RECORD = {
  timestamp: '2026-09-05T23:59:33.333Z',
  level: 'info',
  message: 'request',
  method: 'GET',
  path: '/health',
  status: 200,
  duration_ms: 4,
  keyIndex: null
};

test('the formatter module exists and is import-free so it stays unit-testable', () => {
  const source = read(FORMAT_LIB);
  assert.doesNotMatch(source, /^\s*import\s/m,
    'logs-format.ts must not import anything: the vm harness gives it no module resolver');
});

test('a log line never contains a stray boolean from a guard expression', () => {
  const { formatLogLine } = loadTypeScriptExports(FORMAT_LIB);

  // The exact user-visible symptom, on the exact record that produced it.
  const lifecycle = formatLogLine(REAL_LIFECYCLE_RECORD);
  assert.doesNotMatch(lifecycle, /\bfalse\b/,
    'a lifecycle record has no duration, and the missing-duration guard must not '
    + `leak the boolean false into the line; got: ${lifecycle}`);
  assert.doesNotMatch(lifecycle, /\btrue\b/, 'no guard may leak the boolean true either');
  assert.equal(lifecycle, '2026-09-05T23:59:33.221Z [INFO] Gateway started');

  // Not just this record: NO record may ever produce a bare boolean token,
  // whatever combination of optional fields is present or absent.
  const optional = ['method', 'path', 'status', 'duration_ms', 'outcome', 'model'];
  const values = { method: 'GET', path: '/v1/models', status: 200, duration_ms: 12, outcome: 'success', model: 'z-ai/glm-5.2' };
  for (let mask = 0; mask < (1 << optional.length); mask += 1) {
    const record = { timestamp: '2026-09-06T00:00:00.000Z', level: 'info', message: 'request' };
    for (const [bit, field] of optional.entries()) {
      if (mask & (1 << bit)) record[field] = values[field];
    }
    const line = formatLogLine(record);
    assert.doesNotMatch(line, /\b(?:true|false)\b/,
      `no field combination may emit a bare boolean; mask=${mask} produced: ${line}`);
  }
});

test('the latency the gateway measures is actually displayed', () => {
  const { formatLogLine } = loadTypeScriptExports(FORMAT_LIB);

  // server.mjs emits `duration_ms`. That is the field that must surface.
  const line = formatLogLine(REAL_REQUEST_RECORD);
  assert.match(line, /\b4ms\b/,
    `the gateway's measured duration_ms must be rendered as "4ms"; got: ${line}`);
  assert.equal(line, '2026-09-05T23:59:33.333Z [INFO] GET /health 200 4ms request');

  // A zero-millisecond request is real (server.mjs rounds, and /health does
  // reply in under 0.5ms — three such records exist in the captured sample).
  // 0 must NOT be dropped as falsy.
  const fast = formatLogLine({ ...REAL_REQUEST_RECORD, duration_ms: 0 });
  assert.match(fast, /\b0ms\b/, `a rounded-to-zero duration must still render; got: ${fast}`);
});

test('the field name the formatter reads is the field name the gateway emits', () => {
  // Guard against the mismatch silently returning: assert on BOTH sides.
  const server = read('src/gateway/server.mjs');
  assert.match(server, /duration_ms:\s*Math\.round\(elapsed\)/,
    'server.mjs must still emit the request latency as duration_ms');

  const formatter = read(FORMAT_LIB);
  assert.match(formatter, /duration_ms/,
    'the formatter must read duration_ms — the field the gateway actually emits');
});

test('Logs.tsx delegates to the shared formatter instead of keeping its own copy', () => {
  const logs = read('src/renderer/views/Logs.tsx');
  assert.match(logs, /from '\.\.\/lib\/logs-format'/,
    'Logs.tsx must import the extracted formatter (mirroring the models-filter extraction)');
  assert.doesNotMatch(logs, /function formatLog\(/,
    'the private copy in Logs.tsx must be gone, or the tested code is not the code that runs');
});
