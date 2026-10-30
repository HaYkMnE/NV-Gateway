/**
 * W3 catalog + main-process regression tests (Level-1 fix wave).
 *
 * Defect 1: a successful HTTP response carrying zero metadata overwrote a good
 *           catalog cache (10 entries -> 0, fetchedAt advanced).
 * Defect 2: the update install's `stopGateway` adapter discarded the resolved
 *           `{state:'error'}` that auto-update.ts explicitly checks.
 * Defect 3: the old source-text assertion pinned the buggy adapter string.
 * Defect 4: cleanupAndQuit logs `app_shutdown_complete` even when the child
 *           stop resolved an error status.
 *
 * Hermetic: the catalog fetcher is replaced by a mock; no network, no Electron.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import typescript from 'typescript';
import { pathToFileURL, fileURLToPath } from 'node:url';

process.env.NGC_CATALOG_SYNC_DISABLE_WARM = '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const catalog = await import(pathToFileURL(path.join(root, 'src', 'gateway', 'nvidia-catalog-sync.mjs')).href);

// ---------------------------------------------------------------------------
// Source-structure helpers.
//
// A bare regex over the whole file matches the FIRST textual hit, so a comment
// that merely mentions the wiring satisfied the old assertions while the real
// code was reverted. Every source-derived assertion below therefore runs on a
// comment-masked copy and reads the value out of the ACTUAL construct
// (createAutoUpdateService's argument object / cleanupAndQuit's body).
// ---------------------------------------------------------------------------

/**
 * Replace comments AND string-literal contents with spaces, preserving offsets
 * and newlines. Indices found in the mask are therefore valid in the ORIGINAL
 * text, so callers can slice the real source (keeping string values intact)
 * while matching only actual code — a comment or string can never pose as code.
 */
function structuralMask(source) {
  const out = source.split('');
  let mode = 'code';
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; i += 1; continue; }
      blank(i, i + 1); i += 1; continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') { blank(i, i + 2); mode = 'code'; i += 2; continue; }
      blank(i, i + 1); i += 1; continue;
    }
    if (mode === '"' || mode === "'" || mode === '`') {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === mode) { mode = 'code'; i += 1; continue; }
      blank(i, i + 1); i += 1; continue;
    }
    if (c === '/' && next === '/') { blank(i, i + 2); mode = 'line'; i += 2; continue; }
    if (c === '/' && next === '*') { blank(i, i + 2); mode = 'block'; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { mode = c; i += 1; continue; }
    i += 1;
  }
  return out.join('');
}

/** Index of the bracket closing `open`, or -1. */
function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The `{...}` argument object of the (single) `name(` call, from masked code. */
function callArgumentObject(source, name) {
  const masked = structuralMask(source);
  const at = masked.indexOf(`${name}(`);
  assert.ok(at >= 0, `${name} must be called in the main process`);
  let open = at + name.length + 1;
  while (open < masked.length && /\s/.test(masked[open])) open += 1;
  assert.equal(masked[open], '{', `${name} must be called with an object literal`);
  const close = matchBrace(masked, open);
  assert.ok(close > open, `${name}'s argument object must be balanced`);
  return source.slice(open, close + 1);
}

/** Depth-0 `key: value` of an object literal, or null. */
function topLevelProperty(objectText, key) {
  const masked = structuralMask(objectText);
  let depth = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '{' || c === '(' || c === '[') { depth += 1; continue; }
    if (c === '}' || c === ')' || c === ']') { depth -= 1; continue; }
    if (depth !== 1 || !masked.startsWith(key, i)) continue;
    const before = masked.slice(0, i).trimEnd();
    if (!before.endsWith('{') && !before.endsWith(',')) continue;
    let cursor = i + key.length;
    while (cursor < masked.length && /\s/.test(masked[cursor])) cursor += 1;
    if (masked[cursor] !== ':') continue;
    cursor += 1;
    while (cursor < masked.length && /\s/.test(masked[cursor])) cursor += 1;
    const start = cursor;
    let valueDepth = 0;
    for (; cursor < masked.length; cursor += 1) {
      const v = masked[cursor];
      if (v === '(' || v === '[' || v === '{') valueDepth += 1;
      else if (v === ')' || v === ']' || v === '}') {
        if (valueDepth === 0) break;
        valueDepth -= 1;
      } else if (v === ',' && valueDepth === 0) break;
    }
    return objectText.slice(start, cursor).trim();
  }
  return null;
}

/** Compile the real top-level `async function NAME() {...}` from a TS source. */
function compileFunction(relative, name) {
  const source = read(relative);
  const masked = structuralMask(source);
  const start = masked.search(new RegExp(`async\\s+function\\s+${name}\\s*\\(\\s*\\)`));
  assert.ok(start >= 0, `${name} must exist in ${relative}`);
  const open = masked.indexOf('{', start);
  const close = matchBrace(masked, open);
  assert.ok(close > open, `${name}'s body must be balanced`);
  const body = source.slice(open + 1, close);
  return typescript.transpileModule(`async function ${name}() {${body}}`, {
    compilerOptions: { target: typescript.ScriptTarget.ES2020, module: typescript.ModuleKind.None }
  }).outputText;
}

const SEARCH_PATH_PREFIX = '/v2/search';

function searchResponse(names) {
  return {
    resultTotal: names.length,
    resources: names.map((name) => ({
      artifact: { name, displayName: name, publisher: 'z-ai', labels: [] }
    }))
  };
}

function detailResponse(name) {
  return { artifact: { name, displayName: name, publisher: 'z-ai', shortDescription: `${name} detail`, labels: [] } };
}

/** Install a fetcher: search returns `searchBody`, details resolve per record. */
function useFetcher(searchBody) {
  catalog.__setFetcherForTests__(async (urlPath) => {
    if (urlPath.startsWith(SEARCH_PATH_PREFIX)) return searchBody;
    const name = decodeURIComponent(urlPath.split('/').pop() ?? '');
    return detailResponse(name);
  });
}

function useThrowingFetcher() {
  catalog.__setFetcherForTests__(async () => { throw new Error('synthetic catalog outage'); });
}

function warmCache(names) {
  catalog.resetCatalogCache();
  useFetcher(searchResponse(names));
  return catalog.refreshCatalog();
}

const TEN_MODELS = Array.from({ length: 10 }, (_, index) => `model-${index}`);

// ── Defect 1: empty metadata must never destroy a good cache ─────────────────

test('defect 1: a successful refresh with resources: [] keeps the previous good cache', async () => {
  await warmCache(TEN_MODELS);
  const before = catalog.getCatalogCacheInfo();
  assert.equal(before.size, 20, '10 models + 10 bare aliases');

  useFetcher(searchResponse([]));
  const returned = await catalog.refreshCatalog();

  const after = catalog.getCatalogCacheInfo();
  assert.equal(after.size, before.size, 'the good cache must survive an empty refresh');
  assert.equal(after.fetchedAt, before.fetchedAt, 'freshness must NOT advance on an empty refresh');
  assert.ok(catalog.getMetadataForModelId('z-ai/model-0'), 'cached lookups must keep working');
  assert.equal(returned.size, before.size, 'the returned map is the preserved cache');
});

test('defect 1: a refresh with zero successfully-parsed records also keeps the previous cache', async () => {
  await warmCache(['alpha', 'beta']);
  const before = catalog.getCatalogCacheInfo();
  // Search advertises records, but every detail fetch fails and the search
  // record carries no usable name => zero metadata produced.
  catalog.__setFetcherForTests__(async (urlPath) => {
    if (urlPath.startsWith(SEARCH_PATH_PREFIX)) return { resources: [null, {}, { artifact: {} }] };
    throw new Error('detail unavailable');
  });
  await catalog.refreshCatalog();
  assert.equal(catalog.getCatalogCacheInfo().size, before.size);
  assert.equal(catalog.getCatalogCacheInfo().fetchedAt, before.fetchedAt);
});

test('defect 1: a network error keeps the previous cache (unchanged behavior)', async () => {
  await warmCache(['alpha', 'beta']);
  const before = catalog.getCatalogCacheInfo();
  useThrowingFetcher();
  const returned = await catalog.refreshCatalog();
  assert.equal(catalog.getCatalogCacheInfo().size, before.size);
  assert.equal(catalog.getCatalogCacheInfo().fetchedAt, before.fetchedAt);
  assert.equal(returned.size, before.size);
});

test('defect 1: a valid smaller non-empty response DOES replace the cache', async () => {
  await warmCache(TEN_MODELS);
  useFetcher(searchResponse(['only-one']));
  await catalog.refreshCatalog();
  const after = catalog.getCatalogCacheInfo();
  assert.equal(after.size, 2, 'one model + one bare alias');
  assert.ok(after.fetchedAt > 0);
  assert.ok(catalog.getMetadataForModelId('z-ai/only-one'));
  assert.equal(catalog.getMetadataForModelId('z-ai/model-0'), undefined, 'the smaller catalog is authoritative');
});

test('defect 1: an authoritatively empty cold catalog is CACHED so the TTL — not every request — governs refetching', async () => {
  catalog.resetCatalogCache();
  let searches = 0;
  catalog.__setFetcherForTests__(async (urlPath) => {
    if (urlPath.startsWith(SEARCH_PATH_PREFIX)) {
      searches += 1;
      return { resultTotal: 0, resources: [] };
    }
    throw new Error('no details expected');
  });

  const first = await catalog.refreshCatalog();
  assert.equal(first.size, 0, 'an empty catalog is empty');
  const info = catalog.getCatalogCacheInfo();
  assert.equal(info.size, 0);
  assert.ok(typeof info.fetchedAt === 'number' && info.fetchedAt > 0,
    'an authoritative empty result must be cached with a real fetchedAt (so /admin/catalog/sync can report 200)');

  // The whole point: a fresh empty cache must NOT re-hit upstream on every call.
  await catalog.getAllModelMetadata();
  await catalog.getAllModelMetadata();
  assert.equal(searches, 1, 'a cached empty catalog must not trigger another upstream search');

  // refreshCatalog always bypasses the TTL — the explicit-sync contract.
  await catalog.refreshCatalog();
  assert.equal(searches, 2, 'refreshCatalog must still force a fresh fetch');
});

test('defect 1: an empty refresh over a WARM cache is preserved even when upstream claims resultTotal: 0', async () => {
  await warmCache(['alpha', 'beta']);
  const before = catalog.getCatalogCacheInfo();
  useFetcher({ resultTotal: 0, resources: [] });
  const returned = await catalog.refreshCatalog();
  const after = catalog.getCatalogCacheInfo();
  assert.equal(after.size, before.size, 'a warm cache must never be replaced by an empty result');
  assert.equal(after.fetchedAt, before.fetchedAt, 'freshness must not advance on a preserved cache');
  assert.equal(returned.size, before.size);
});

test('defect 1: a claimed-but-unparseable catalog (resultTotal > 0, zero usable records) is preserved, not cached as empty', async () => {
  catalog.resetCatalogCache();
  catalog.__setFetcherForTests__(async (urlPath) => {
    if (urlPath.startsWith(SEARCH_PATH_PREFIX)) {
      return { resultTotal: 5, resources: [null, {}, { artifact: {} }] };
    }
    throw new Error('detail unavailable');
  });
  await catalog.refreshCatalog();
  const info = catalog.getCatalogCacheInfo();
  assert.equal(info.size, 0);
  assert.equal(info.fetchedAt, null,
    'a parse failure must NOT be cached as an authoritative empty catalog (no fetchedAt advance)');
});

test('defect 1: a body with NO trustworthy total is treated as a parse failure, not an authoritative empty', async () => {
  catalog.resetCatalogCache();
  catalog.__setFetcherForTests__(async () => ({ resources: [] }));
  await catalog.refreshCatalog();
  assert.equal(catalog.getCatalogCacheInfo().fetchedAt, null,
    'without a trustworthy resultTotal the empty response must not be cached');
});

test('defect 1: an empty refresh after a good cache is reported, not silent', async () => {
  await warmCache(['alpha']);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    useFetcher(searchResponse([]));
    await catalog.refreshCatalog();
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.length > 0, 'an empty refresh that discarded nothing must still be diagnosable');
  assert.equal(/alpha|model-|z-ai/i.test(warnings.join(' ')), false, 'the warning must not echo catalog content');
});

test('defect 1: a cold-start empty refresh does not emit the preserve warning', async () => {
  catalog.resetCatalogCache();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    useFetcher(searchResponse([]));
    await catalog.refreshCatalog();
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, [], 'nothing was preserved, so no destructive-refresh warning applies');
});

// ── Defect 2/3: the install adapter must propagate the stop result ───────────

test('defect 2: the wired stopGateway adapter RETURNS the lifecycle result (evaluated, not string-matched)', async () => {
  const main = read('src/main/index.ts');
  const args = callArgumentObject(main, 'createAutoUpdateService');
  const body = topLevelProperty(args, 'stopGateway');
  assert.ok(body, 'the createAutoUpdateService argument must declare a stopGateway adapter');

  // Execute the adapter the main process actually wires and check the VALUE it
  // produces. A source-text check passes on `async () => { await stop(); }`
  // (the value is swallowed inside a block); only running it exposes that.
  const lifecycleResult = { state: 'error', code: 'START_FAILED', message: 'unconfirmed' };
  let stopCalls = 0;
  const adapter = vm.runInNewContext(`(${body})`, {
    gatewayLifecycle: { stop: async () => { stopCalls += 1; return lifecycleResult; } }
  }, { filename: 'src/main/index.ts#stopGateway' });

  assert.equal(typeof adapter, 'function', 'the adapter must be a function');
  assert.equal(await adapter(), lifecycleResult,
    'the adapter must propagate the resolved stop status (an await-and-discard block returns undefined)');
  assert.equal(stopCalls, 1, 'the adapter must call the same stop path exactly once');
});

test('defect 3: installation aborts for the exact GatewayLifecycle error shape, including its message', async () => {
  const { createAutoUpdateService } = await import(pathToFileURL(path.join(root, 'build', 'src', 'main', 'auto-update.js')).href);
  const { EventEmitter } = await import('node:events');
  const emitter = new EventEmitter();
  const calls = [];
  const logs = [];
  let quitting = false;
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: (name, listener) => emitter.on(name, listener),
    checkForUpdates: async () => {},
    downloadUpdate: async () => {},
    quitAndInstall: (...args) => calls.push(args)
  };
  const service = createAutoUpdateService({
    updater,
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    getLanguage: () => 'en',
    log: (level, event, data) => logs.push({ level, event, data }),
    setQuitting: () => { quitting = true; },
    // Exactly what GatewayLifecycle.stop() resolves when shutdown is unconfirmed.
    stopGateway: async () => ({ state: 'error', code: 'START_FAILED', port: 12000, message: 'Managed gateway child shutdown could not be confirmed.' }),
    onStatusChanged: () => {},
    enabled: true
  });
  await service.installAndQuit();
  assert.equal(calls.length, 0, 'quitAndInstall must never run after a failed child stop');
  assert.equal(quitting, false);
  assert.equal(service.isInstalling(), false);
  assert.equal(service.getStatus().state, 'error');
  const failure = logs.find((entry) => entry.event === 'update_gateway_stop_failed');
  assert.ok(failure, 'the abort is logged');
  assert.match(failure.data.message, /shutdown could not be confirmed/);
});

test('defect 2: a successful stop result still installs (no regression)', async () => {
  const { createAutoUpdateService } = await import(pathToFileURL(path.join(root, 'build', 'src', 'main', 'auto-update.js')).href);
  const { EventEmitter } = await import('node:events');
  const emitter = new EventEmitter();
  const calls = [];
  let quitting = false;
  const service = createAutoUpdateService({
    updater: {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      on: (name, listener) => emitter.on(name, listener),
      checkForUpdates: async () => {},
      downloadUpdate: async () => {},
      quitAndInstall: (...args) => calls.push(args)
    },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    getLanguage: () => 'en',
    log: () => {},
    setQuitting: () => { quitting = true; },
    stopGateway: async () => ({ state: 'stopped' }),
    onStatusChanged: () => {},
    enabled: true
  });
  await service.installAndQuit();
  assert.deepEqual(calls, [[false, true]], 'a confirmed stop proceeds to quitAndInstall(false, true)');
  assert.equal(quitting, true);
});

// ── Defect 4: shutdown truthfulness ─────────────────────────────────────────

/**
 * Run the REAL `cleanupAndQuit` body from src/main/index.ts (transpiled, not
 * string-matched) against stubs, and collect the emitted (level, event) tuples.
 * Source-text assertions could not distinguish the branches; this executes them.
 */
function runCleanupAndQuit({ stopResult, stopThrows } = {}) {
  const compiled = compileFunction('src/main/index.ts', 'cleanupAndQuit');
  const watchdog = /const QUIT_WATCHDOG_MS\s*=\s*([\d_]+)\s*;/.exec(read('src/main/index.ts'));
  assert.ok(watchdog, 'QUIT_WATCHDOG_MS must be declared in the main process');
  const events = [];
  const quits = [];
  const sandbox = {
    QUIT_WATCHDOG_MS: Number(watchdog[1].replace(/_/g, '')),
    logAppEvent: (level, event) => events.push([level, event]),
    gatewayLifecycle: stopThrows
      ? { stop: async () => { throw stopThrows; } }
      : { stop: async () => stopResult },
    app: {
      quit: () => quits.push(true),
      exit: () => {}
    },
    // The watchdog is armed AFTER the stop; it must never fire in these tests.
    setTimeout: () => ({ unref: () => {} }),
    Error,
    String
  };
  vm.runInNewContext(`${compiled}\n;cleanupAndQuit();`, sandbox, { filename: 'src/main/index.ts#cleanupAndQuit' });
  return { events, quits };
}

test('defect 4: cleanupAndQuit logs app_shutdown_incomplete (never app_shutdown_complete) when the child stop failed', async () => {
  const { events } = runCleanupAndQuit({
    stopResult: { state: 'error', code: 'START_FAILED', message: 'Managed gateway child shutdown could not be confirmed.' }
  });
  await new Promise((resolve) => setImmediate(resolve));

  const names = events.map(([, event]) => event);
  assert.deepEqual(names, ['app_shutdown_incomplete'],
    `an unconfirmed stop must emit exactly one truthful event, got: ${JSON.stringify(events)}`);
  assert.deepEqual(events[0][0], 'error', 'the incomplete shutdown is an error-level event');
  assert.equal(names.includes('app_shutdown_complete'), false,
    'claiming a completed shutdown after a failed stop is the defect');
});

test('defect 4: cleanupAndQuit logs exactly one app_shutdown_complete on a stopped child (no double-logging)', async () => {
  const { events } = runCleanupAndQuit({ stopResult: { state: 'stopped' } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [['info', 'app_shutdown_complete']],
    `a confirmed stop emits exactly one success event, got: ${JSON.stringify(events)}`);
});

test('defect 4: cleanupAndQuit still quits and logs app_shutdown_error when the stop rejects', async () => {
  const { events, quits } = runCleanupAndQuit({ stopThrows: new Error('stop exploded') });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events.map(([, event]) => event), ['app_shutdown_error'],
    `a rejecting stop must emit exactly one error event, got: ${JSON.stringify(events)}`);
  assert.equal(events.some(([, event]) => event === 'app_shutdown_complete'), false,
    'a rejected stop must not be reported as a completed shutdown');
  assert.equal(quits.length, 1, 'the quit path still runs after a failed stop');
});
