import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import typescript from 'typescript';

// ───────────────────────────────────────────────────────────────────────────
// Renderer half of the main->renderer gateway-status push channel.
//
// d5e7e02 landed the main-side send (gateway-status-changed) and the preload
// listener. THIS file pins the renderer subscription in Layout.tsx:
//
//   1. Layout MUST subscribe to electronAPI.onGatewayStatusChanged. A push
//      carries the full status; without the subscription the optimisation
//      delivers nothing and the renderer is back to polling for transitions.
//   2. The handler MUST write the pushed payload with setQueryData, NOT
//      invalidateQueries — the push already carries the full four-field
//      status, so invalidating reintroduces one IPC round-trip per transition,
//      which is the exact cost the channel exists to remove.
//   3. The backup poll (refetchInterval: 30000) and the reveal-freshness pins
//      (refetchOnWindowFocus: 'always', staleTime: 0, added in 51fb01d against
//      a measured 1.0 s reveal-staleness defect) MUST SURVIVE: pushes are lost
//      whenever the window is absent or destroyed, so the 30 s poll and the
//      focus refetch are the convergence safety net.
//
// EVERY ASSERTION IS BEHAVIOURAL. The REAL Layout.tsx is compiled and executed
// with instrumented React/TanStack hook stubs; the captured useQuery options
// and the captured effect are then driven against the REAL @tanstack/query-core
// (QueryClient, QueryObserver, focusManager, timeoutManager). Nothing here
// greps source text for the wiring — a textual guard cannot see what the
// shipped component does at runtime, and every textual guard in this repo has
// eventually been evaded.
// ───────────────────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// query-core decides "server" at module load (typeof window === 'undefined'),
// and a "server" QueryObserver never schedules refetchInterval. Give the test
// process a browser-ish global BEFORE query-core is required.
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
}

const queryCore = require('@tanstack/query-core');
const { QueryClient, QueryObserver, focusManager } = queryCore;
const timeoutManager = queryCore.timeoutManager
  ?? (await import(pathToFileURL(path.join(root, 'node_modules', '@tanstack', 'query-core', 'build', 'modern', 'timeoutManager.js')))).timeoutManager;

// Capture every query-core timer instead of scheduling real ones. Real timers
// would (a) force a 30 s wait into the test and (b) leave a real gc interval
// holding the event loop open after the tests finish. Installed ONCE, before
// any QueryClient exists, so the provider never switches mid-flight.
const timerLog = { timeouts: 0, intervals: [] };
timeoutManager.setTimeoutProvider({
  setTimeout: () => { timerLog.timeouts += 1; return timerLog.timeouts; },
  clearTimeout: () => {},
  setInterval: (cb, delay) => { timerLog.intervals.push({ cb, delay }); return timerLog.intervals.length; },
  clearInterval: () => {},
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

// ── Fake electronAPI: a real pub/sub channel + counting invoke ─────────────
function makeFakeGatewayApi() {
  const listeners = new Set();
  const calls = { getGatewayStatus: 0, onGatewayStatusChanged: 0, unsubscribe: 0 };
  return {
    calls,
    listenerCount: () => listeners.size,
    emit(status) { for (const cb of [...listeners]) cb(status); },
    api: {
      getGatewayStatus: async () => { calls.getGatewayStatus += 1; return { state: 'running', port: 41191 }; },
      onGatewayStatusChanged: (cb) => {
        calls.onGatewayStatusChanged += 1;
        listeners.add(cb);
        return () => { calls.unsubscribe += 1; listeners.delete(cb); };
      },
    },
  };
}

// ── Execute the REAL Layout.tsx with instrumented hooks ────────────────────
function executeLayout(fakeApi) {
  const captured = { queryOptions: [], effects: [] };
  const client = new QueryClient();
  const fakeWindow = { electronAPI: fakeApi.api, setTimeout, clearTimeout };
  const fakeDocument = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };

  const componentStub = () => null;
  const stubs = {
    react: {
      memo: (fn) => fn,
      useCallback: (fn) => fn,
      useEffect: (cb, deps) => { captured.effects.push({ cb, deps }); },
      useMemo: (fn) => fn(),
      useRef: (v) => ({ current: v }),
      useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: {} },
    'react-router-dom': { Outlet: componentStub, NavLink: componentStub, useNavigate: () => () => {} },
    '@tanstack/react-query': {
      useQuery: (options) => {
        captured.queryOptions.push(options);
        return { data: undefined, error: undefined, isError: false, refetch: async () => ({}) };
      },
      useQueryClient: () => client,
    },
    'react-i18next': { useTranslation: () => ({ t: (key) => key }) },
    // Any icon name resolves to an inert component, robust to icon churn.
    'lucide-react': new Proxy({}, { get: () => componentStub }),
  };
  const relativeStubs = {
    'src/renderer/stores/config': { useConfigStore: () => ({ gatewayPort: 41191 }) },
    'src/renderer/components/Logo': { Logo: componentStub },
    'src/renderer/lib/frontend-behavior': { reduceMenu: (open) => !open },
    'src/renderer/lib/gateway-lifecycle': { GatewayLifecycleContext: { Provider: componentStub } },
    'src/renderer/lib/modal-context': { useModal: () => ({ openFeedback() {}, openDonation() {} }) },
    'src/renderer/pet/PetWidget': { PetWidget: componentStub },
  };

  const relative = 'src/renderer/components/Layout.tsx';
  const compiled = typescript.transpileModule(read(relative), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
      jsx: typescript.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  const module = { exports: {} };
  const localRequire = (id) => {
    if (id in stubs) return stubs[id];
    if (id.startsWith('.')) {
      const dir = 'src/renderer/components'; // directory OF Layout.tsx
      const resolved = path.posix.normalize(path.posix.join(dir, id));
      if (resolved in relativeStubs) return relativeStubs[resolved];
      throw new Error(`unexpected relative import in Layout.tsx: ${id}`);
    }
    return require(id);
  };
  const sandbox = {
    module, exports: module.exports, require: localRequire,
    window: fakeWindow, document: fakeDocument,
    console, Error, setTimeout, clearTimeout, queueMicrotask,
  };
  vm.runInNewContext(compiled.outputText, sandbox, { filename: relative });

  assert.equal(typeof module.exports.Layout, 'function', 'Layout.tsx must export a Layout component');
  module.exports.Layout();
  assert.equal(captured.queryOptions.length, 1,
    `Layout must issue exactly ONE useQuery (the gateway-status query); got ${captured.queryOptions.length}`);
  return { captured, client };
}

// ── 1. The query the push feeds: key, 30 s backup poll, reveal pins ────────
test('Layout executes with the pinned gateway-status query options', () => {
  const fake = makeFakeGatewayApi();
  const { captured } = executeLayout(fake);
  const options = captured.queryOptions[0];

  // The options object was built inside the vm realm; spread into this realm
  // before deep-comparing (cross-realm arrays fail deepStrictEqual on
  // prototype, not content).
  assert.deepEqual([...options.queryKey], ['gateway-status'],
    "the status query key must stay ['gateway-status'] — the push handler writes exactly this key, "
    + 'and App.tsx hydration seeds exactly this key; a drift here splits the cache in two');
  assert.equal(options.refetchInterval, 30000,
    `the backup poll must be 30000 ms (was 1000 before the push channel existed). Got ${options.refetchInterval}. `
    + 'Dropping it removes the safety net for pushes lost to absent/destroyed windows; keeping 1000 means the '
    + 'push channel changed nothing for idle IPC load (~60 round-trips/min).');
  assert.equal(options.refetchOnWindowFocus, 'always',
    'reveal freshness pin (51fb01d): a reveal within 3 s of the last poll must still refetch — the global '
    + 'staleTime 3000 in App.tsx otherwise treats the data as fresh and skips it');
  assert.equal(options.staleTime, 0,
    'staleTime must stay 0 for this query (overrides the global 3000) or the focus refetch can be skipped');
  assert.equal(typeof options.queryFn, 'function', 'the query must fetch via a queryFn');
});

// ── 2. The subscription: push -> setQueryData, no IPC per push, unsubscribe ──
test('a pushed status lands in the query cache with ZERO IPC round-trips, and unsubscribe detaches', async () => {
  const fake = makeFakeGatewayApi();
  const { captured, client } = executeLayout(fake);
  const options = captured.queryOptions[0];

  // An ACTIVE observer on the captured query: this is what makes
  // invalidateQueries observable — an invalidation refetches active queries.
  const observer = new QueryObserver(client, options);
  const offObserver = observer.subscribe(() => {});
  try {
    await tick();
    const baseline = fake.calls.getGatewayStatus;
    assert.equal(baseline, 1, `fixture: one mount fetch, got ${baseline}`);

    // Run the component's effects: exactly one must subscribe to the push channel.
    const cleanups = captured.effects.map(({ cb }) => cb());
    assert.equal(fake.calls.onGatewayStatusChanged, 1,
      `Layout must subscribe to onGatewayStatusChanged exactly once on mount (got ${fake.calls.onGatewayStatusChanged}). `
      + 'Without the subscription the push is delivered and ignored, and this whole optimisation delivers nothing.');
    assert.equal(fake.listenerCount(), 1, 'exactly one live listener after mount');
    const effectIndex = cleanups.findIndex((c) => typeof c === 'function');
    assert.notEqual(effectIndex, -1,
      'the subscribing effect must return an unsubscribe cleanup — a remounting Layout must not stack listeners '
      + 'on a channel that fires on every gateway transition');

    // THE PUSH: a full status payload crosses the channel.
    const pushed = { state: 'error', code: 'PORT_IN_USE', port: 41191, message: 'boom' };
    fake.emit(pushed);
    await tick();

    assert.deepEqual(client.getQueryData(['gateway-status']), pushed,
      'the pushed values must land in the cache. (setQueryData passes data through structuralSharing, so content, '
      + 'not identity, is pinned here; the no-round-trip assertion below is what pins setQueryData over a refetch.)');
    assert.deepEqual(observer.getCurrentResult().data, pushed,
      'the live query (what the React tree renders) must see the pushed status immediately');
    assert.equal(fake.calls.getGatewayStatus, baseline,
      `a push must cost ZERO get-gateway-status round-trips (got ${fake.calls.getGatewayStatus - baseline}). `
      + 'A handler that invalidates instead of setQueryData reintroduces one IPC call per transition — the exact '
      + 'cost this channel exists to remove.');

    // Unsubscribe really detaches (remount safety).
    cleanups[effectIndex]();
    assert.equal(fake.listenerCount(), 0, 'unsubscribe must detach the ipc listener');
    fake.emit({ state: 'running', port: 41191 });
    await tick();
    assert.deepEqual(client.getQueryData(['gateway-status']), pushed,
      'after unsubscribe a push must NOT touch the cache (no ghost listener)');

    // NEGATIVE CONTROL: prove this test can actually see an invalidation — if
    // the handler were invalidateQueries instead of setQueryData, the
    // assertions above fail exactly like this:
    client.invalidateQueries({ queryKey: ['gateway-status'] });
    await tick();
    assert.equal(fake.calls.getGatewayStatus, baseline + 1,
      'control: invalidating an active query refetches — so a swapped handler would have been caught above');
  } finally {
    offObserver();
    observer.destroy();
    client.clear();
  }
});

// ── 3. The backup poll really schedules at 30 s and really refetches ────────
test('the captured options schedule a real 30 s interval that fires a real refetch', async () => {
  const fake = makeFakeGatewayApi();
  const { captured, client } = executeLayout(fake);
  const options = captured.queryOptions[0];

  // Intervals registered by THIS observer sit after this marker (earlier
  // tests' observers registered theirs into the same log; re-registrations
  // on fetch completion land here too and must carry the same delay).
  const marker = timerLog.intervals.length;
  const observer = new QueryObserver(client, options);
  const off = observer.subscribe(() => {});
  try {
    await tick();
    assert.ok(fake.calls.getGatewayStatus >= 1, 'fixture: initial fetch happened');

    const mine = timerLog.intervals.slice(marker).filter((r) => r && typeof r.cb === 'function');
    assert.ok(mine.length >= 1,
      'an ACTIVE observer of the status query must schedule a refetch interval. None scheduled = the backup '
      + 'poll was dropped, and pushes lost to an absent/destroyed window never converge.');
    for (const registration of mine) {
      assert.equal(registration.delay, 30000,
        `the backup poll must be 30000 ms, got ${registration.delay}. 1000 reinstates the 1 Hz poll the push `
        + 'channel was built to retire; false/0 leaves lost pushes unconverged forever.');
    }

    const before = fake.calls.getGatewayStatus;
    mine[0].cb();
    await tick();
    assert.equal(fake.calls.getGatewayStatus, before + 1,
      'firing the scheduled interval must issue a real get-gateway-status refetch — the safety net is live');
  } finally {
    off();
    observer.destroy();
    client.clear();
  }
});

// ── 4. Focus refetch converges a reveal, and fresh data is instantly stale ──
test('a window focus refetches immediately even with data 0 ms old (the 51fb01d reveal fix)', async () => {
  const fake = makeFakeGatewayApi();
  const { captured, client } = executeLayout(fake);
  const options = captured.queryOptions[0];

  client.mount(); // useBaseQuery mounts the client; the focus subscription lives there
  const observer = new QueryObserver(client, options);
  const off = observer.subscribe(() => {});
  try {
    await tick();
    const baseline = fake.calls.getGatewayStatus;
    assert.equal(baseline, 1, 'fixture: one mount fetch');

    // Data was fetched milliseconds ago. The 51fb01d defect: a reveal <3 s
    // after the last poll skipped the refetch because global staleTime 3000
    // considered the data fresh. With the pinned options the data must be
    // stale AT ONCE...
    const query = client.getQueryCache().find({ queryKey: ['gateway-status'] });
    assert.ok(query, 'the query exists after the mount fetch');
    assert.equal(query.isStaleByTime(options.staleTime), true,
      `with staleTime ${options.staleTime}, data fetched 0 ms ago must already count as stale — otherwise a `
      + 'reveal within 3 s of the last poll renders the old status (the measured 1.0 s reveal-staleness defect)');

    // ...and a real focus change through the REAL focusManager must refetch.
    focusManager.setFocused(false);
    await tick();
    const hiddenCount = fake.calls.getGatewayStatus;
    focusManager.setFocused(true);
    await tick();
    assert.equal(fake.calls.getGatewayStatus, hiddenCount + 1,
      `a focus event must trigger an immediate refetch (got ${fake.calls.getGatewayStatus - hiddenCount} new calls). `
      + 'Without refetchOnWindowFocus: always, a missed push while hidden stays stale until the next 30 s tick.');
  } finally {
    focusManager.setFocused(undefined);
    off();
    observer.destroy();
    client.unmount();
    client.clear();
  }
});

// ── 5. Hardened: Effect dependencies must be pinned to [queryClient] ────────
test('the subscribing effect has pinned [queryClient] dependencies to prevent subscription thrashing', () => {
  const fake = makeFakeGatewayApi();
  const { captured, client } = executeLayout(fake);

  // Find the effect that subscribes
  let subEffect = null;
  for (const eff of captured.effects) {
    const cleanup = eff.cb();
    if (typeof cleanup === 'function') {
      subEffect = eff;
      cleanup();
      break;
    }
  }

  assert.ok(subEffect, 'must find the subscription effect');
  assert.ok(Array.isArray(subEffect.deps), 'subscribing effect MUST have a dependency array (omitting causes per-render re-subscribes)');
  assert.equal(subEffect.deps.length, 1, `subscribing effect deps must have exactly 1 item ([queryClient]), got ${subEffect.deps.length}`);
  assert.equal(subEffect.deps[0], client, 'subscribing effect dep must be the queryClient instance');
});

// ── 6. Hardened: Multi-mount cycle does not leak listeners ───────────────────
test('sequential mount and unmount cycles do not accumulate listeners (0 leak guarantee)', () => {
  const fake = makeFakeGatewayApi();
  const cleanups = [];

  for (let i = 0; i < 5; i++) {
    const { captured } = executeLayout(fake);
    for (const eff of captured.effects) {
      const c = eff.cb();
      if (typeof c === 'function') cleanups.push(c);
    }
    assert.equal(fake.listenerCount(), i + 1, `after ${i + 1} active mounts, expected ${i + 1} listeners`);
  }

  // Teardown all
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    c();
  }
  assert.equal(fake.listenerCount(), 0, 'after all unmounts, exactly 0 listeners remain in preload');
});

// ── 7. Hardened: Malformed/hostile pushed payloads do not throw or break cache ──
test('pushed payloads with missing fields or abnormal values update cache safely', async () => {
  const fake = makeFakeGatewayApi();
  const { captured, client } = executeLayout(fake);
  const options = captured.queryOptions[0];

  const observer = new QueryObserver(client, options);
  const off = observer.subscribe(() => {});
  const cleanups = captured.effects.map(({ cb }) => cb());

  try {
    await tick();

    const testPayloads = [
      { state: 'stopped' },
      { state: 'starting' },
      { state: 'unknown_custom_state' },
      { state: 'error' },
      { state: 'error', code: 'PORT_IN_USE', port: 8080, message: 'occupied' },
      { state: 'running', port: 41191 },
    ];

    for (const payload of testPayloads) {
      fake.emit(payload);
      await tick();
      assert.deepEqual(client.getQueryData(['gateway-status']), payload);
      assert.deepEqual(observer.getCurrentResult().data, payload);
    }
  } finally {
    for (const c of cleanups) if (typeof c === 'function') c();
    off();
    observer.destroy();
    client.clear();
  }
});

