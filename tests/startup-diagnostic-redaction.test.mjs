import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import typescript from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function loadTypeScriptExports(relative) {
  const compiled = typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 }
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { Error, exports: module.exports, module, URL, WeakSet, Object, Array, JSON, RegExp, decodeURIComponent }, { filename: relative });
  return module.exports;
}

// ───────────────────────────────────────────────────────────────────────────
// DEFECT: a startup diagnostic writes caller-supplied data to stderr with the
// app's redaction layer bypassed entirely.
//
// src/main/index.ts wires the migration/startup `log` callback as
//     console.error(JSON.stringify({ event, ...data }))
// while EVERYTHING else that leaves the app goes through redact() from
// src/main/redaction.ts (app-logger.ts:49 does exactly that) or the allow-listed
// report-sanitizer. That exception exists precisely where credentials have leaked
// through diagnostic paths before.
//
// Why this is a REAL leak path and not a theoretical one: NVIDIA keys carry an
// `nvapi-` prefix and are caught by SECRET_TEXT (redaction.ts:2) on value alone,
// but the app's OWN gatewayToken / adminToken are random base64url with NO
// prefix. Nothing in their VALUE marks them as secret. They are caught only by
// field NAME (SENSITIVE, redaction.ts:1) or by being registered through
// setRuntimeSecrets (registered live at src/main/index.ts:160 and :483, and in
// src/gateway/server.mjs:93). A raw JSON.stringify defeats both mechanisms, so
// any token reaching that callback lands on stderr verbatim.
//
// REQUIRED BEHAVIOUR: that write goes through the same redact() the rest of the
// app uses.
// ───────────────────────────────────────────────────────────────────────────

test('the pre-logger startup diagnostic routes its stderr write through redact()', () => {
  const main = read('src/main/index.ts');

  const callback = /log:\s*\(_?level[^)]*\)\s*=>\s*\{([\s\S]*?)\n\s*\},/.exec(main);
  assert.ok(callback, 'the startup log callback must be locatable in src/main/index.ts');

  assert.match(callback[1], /redact\(/,
    'the startup diagnostic writes caller data to stderr before the app logger exists; '
    + 'it must pass through redact() like every other exit path, or an unprefixed '
    + 'gatewayToken / adminToken lands on stderr verbatim');

  assert.doesNotMatch(callback[1], /JSON\.stringify\(\s*\{\s*event,\s*\.\.\.data\s*\}\s*\)/,
    'JSON.stringify({ event, ...data }) bypasses redaction entirely');
});

test('src/main/index.ts imports redact from the redaction layer', () => {
  assert.match(read('src/main/index.ts'), /^import \{[^}]*\bredact\b[^}]*\} from "\.\/redaction";/m,
    'index.ts must import redact, not only setRuntimeSecrets');
});

test('no console.* in src/main/index.ts serialises caller data unredacted', () => {
  const main = read('src/main/index.ts');
  const offenders = [];

  for (const match of main.matchAll(/console\.(?:log|error|warn|info|debug)\(/g)) {
    const region = main.slice(match.index, match.index + 240);
    const carriesCallerData = /JSON\.stringify\(|\.\.\./.test(region);
    if (carriesCallerData && !/redact\(/.test(region)) {
      const line = main.slice(0, match.index).split('\n').length;
      offenders.push(`index.ts:${line}`);
    }
  }

  assert.deepEqual(offenders, [],
    `every console write that carries caller data must be redacted first: ${offenders.join(', ')}`);
});

// ---- the mechanism itself: prove redact() actually closes this leak ----
//
// A source-shape assertion alone would only prove the call was added. These
// assertions prove the thing being called genuinely neutralises the credentials
// this defect exposes.

test('redact() neutralises an unprefixed local token registered via setRuntimeSecrets', () => {
  const redaction = loadTypeScriptExports('src/main/redaction.ts');

  // Shaped like a real gatewayToken: random base64url, no prefix, nothing in the
  // value marking it secret.
  const gatewayToken = 'K7fQ2mZr8xVbN4pLdS6hTgYwJc0AeUiO';
  redaction.setRuntimeSecrets([gatewayToken]);

  const written = JSON.stringify(redaction.redact({ event: 'legacy_migration_probe', detail: `token=${gatewayToken}` }));
  assert.doesNotMatch(written, new RegExp(gatewayToken),
    'a registered runtime secret must not survive redaction in a free-text field');
  assert.match(written, /\[REDACTED\]/, 'the secret must be replaced by a redaction marker');

  redaction.setRuntimeSecrets([]);
});

test('redact() neutralises credential FIELD NAMES even when the value looks innocuous', () => {
  const redaction = loadTypeScriptExports('src/main/redaction.ts');
  redaction.setRuntimeSecrets([]);

  const written = JSON.stringify(redaction.redact({
    event: 'startup_probe',
    gatewayToken: 'aVeryOrdinaryLookingString',
    adminToken: 'anotherOrdinaryString',
    token: 'third'
  }));

  assert.doesNotMatch(written, /aVeryOrdinaryLookingString/, 'gatewayToken must be redacted by field name');
  assert.doesNotMatch(written, /anotherOrdinaryString/, 'adminToken must be redacted by field name');
  assert.doesNotMatch(written, /third/, 'token must be redacted by field name');
});

test('redact() neutralises an nvapi- key by value alone', () => {
  const redaction = loadTypeScriptExports('src/main/redaction.ts');
  redaction.setRuntimeSecrets([]);

  const key = 'nvapi-QF3xN7pLm2ZbVc8dRtYgHwSjKa0UeIoP';
  const written = JSON.stringify(redaction.redact({ event: 'probe', message: `upstream rejected ${key}` }));
  assert.doesNotMatch(written, new RegExp(key), 'an nvapi- key must be redacted by value');
});

// ───────────────────────────────────────────────────────────────────────────
// RELATED (hygiene, not a live leak): the ipc_handler_error field census.
//
// src/main/index.ts logs `{ ...entry }`, and the spread injects a `handler`
// field. Because it arrives via spread, it is invisible to the project's
// field-name census of logged field names — unprotected-by-inspection. It
// currently carries an IPC channel name such as "keys:list", which is no
// credential, so this is hygiene. Naming the fields makes them auditable.
// ───────────────────────────────────────────────────────────────────────────

test('ipc_handler_error names its logged fields explicitly instead of spreading', () => {
  const main = read('src/main/index.ts');

  const call = /logAppEvent\("error",\s*"ipc_handler_error",\s*\{([\s\S]*?)\}\)/.exec(main);
  assert.ok(call, 'the ipc_handler_error log call must be locatable');

  assert.doesNotMatch(call[1], /\.\.\./,
    'a spread hides which field names reach the log from the field-name census; '
    + 'list the fields explicitly so they are visible to inspection');

  for (const field of ['handler', 'message', 'stack']) {
    assert.match(call[1], new RegExp(`\\b${field}\\b`),
      `the explicit payload must still carry ${field} so the diagnostic keeps its value`);
  }
});
