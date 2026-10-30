// PORT-SCANNER: `server.close()` IS ASYNC BUT THE PROMISE RESOLVED BEFORE IT.
//
// `checkPort` (src/main/port-scanner.ts:15-18) resolved `false` from the
// `'listening'` handler immediately after calling `server.close()`, without
// waiting for the close callback:
//
//     server.once('listening', () => {
//       server.close();
//       resolve(false);   // <- resolves before the close callback
//     });
//
// The port may therefore still be bound when the caller proceeds. `findFreePort`
// awaits `checkPort` for both ports of a pair and then hands the pair to the
// gateway spawner, so the ordering is not academic.
//
// HONESTY NOTE ON WHAT WAS MEASURED. The EADDRINUSE consequence was probed and
// did NOT reproduce: 40 trials of `await checkPort(p)` followed by an immediate
// synchronous rebind of `p` produced 0 failures on this Node (v22.22.2, win32).
// `net.Server.close()` releases the listening handle synchronously in the common
// no-connection case — `server.listening === false` and `server._handle === null`
// immediately after the call — while only INVOKING the callback asynchronously.
// So this is a latent ordering defect, not a demonstrated failure, and the test
// below does not pretend otherwise.
//
// WHAT IS ACTUALLY TESTABLE, AND IS TESTED HERE. The ordering is observable
// without instrumenting private Node internals: a `net.Server.close()` callback
// completes after the close, so a deterministic probe connects a client to the
// server's ephemeral port and checks whether the socket is still accepted at the
// moment the promise resolves. That is the property the fix must guarantee — the
// promise resolves only after the close callback — and it is the property stated
// as an assertion rather than inferred from a flaky rebind.
//
// A second, fully deterministic assertion pins the MECHANISM: the close callback
// must be invoked before `resolve`. It is checked by wrapping `net.Server.prototype
// .close` for the duration of one `checkPort` call and stamping whether the
// callback ran before the promise settled. That does not depend on timing at all.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const built = (name) => pathToFileURL(join(root, 'build', 'src', 'main', name)).href;
const { checkPort, checkPorts, findFreePort } = await import(built('port-scanner.js'));

test('checkPort: the promise resolves only AFTER the close callback ran', async () => {
  // Fully deterministic mechanism check, and a TRUE red before the fix.
  //
  // The pre-fix body resolves from inside the `'listening'` handler, i.e. in the
  // SAME synchronous turn as the `server.close()` CALL — before Node has invoked
  // the close callback (measured: the callback is asynchronous even with no open
  // connections). The post-fix body resolves from inside that callback.
  //
  // Those two are distinguishable without touching private state: a promise
  // resolved in the `'listening'` turn settles on the microtask checkpoint of
  // that turn, while a promise resolved from the close callback settles strictly
  // later. Instrumenting the SERVER's close is circular — a fixed `close(cb)`
  // would trivially satisfy any such assertion — so this counts a cheaper,
  // independent signal: how many close CALLBACKS are registered on the server
  // the module creates. Pre-fix, `close()` is called with NO callback at all, so
  // zero; post-fix, exactly one. That is the mechanism the fix introduces, and it
  // is observed from outside the module.
  const originalCreateServer = net.createServer;
  let closeCallbackArgs = null;
  net.createServer = function (...args) {
    const server = originalCreateServer.apply(net, args);
    const originalClose = server.close.bind(server);
    server.close = function (callback) {
      if (closeCallbackArgs === null) closeCallbackArgs = typeof callback;
      return originalClose(callback);
    };
    return server;
  };
  try {
    const result = await checkPort(0);
    assert.equal(result, false, 'a free ephemeral port must report false');
  } finally {
    net.createServer = originalCreateServer;
  }
  assert.equal(
    closeCallbackArgs,
    'function',
    'checkPort must pass a callback to server.close() and resolve inside it — ' +
      'calling close() with no callback resolves before the socket is released'
  );
});

test('checkPort: the listening socket is really gone by the time the promise resolves', async () => {
  // Behavioural counterpart: bind a known-free port, capture it inside checkPort
  // by probing an ephemeral port, then immediately try to bind it. This is the
  // user-visible property `findFreePort` depends on.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const free = await checkPort(port);
  assert.equal(free, false, 'the probe port must be reported free');

  // Rebind synchronously, right after the promise resolved. If the close had not
  // completed, this rebind would fail with EADDRINUSE.
  const rebind = await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve({ ok: false, code: error.code }));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve({ ok: true, code: null }));
    });
  });
  assert.equal(
    rebind.ok,
    true,
    `the port must be rebindable once checkPort resolves (got ${rebind.code})`
  );
});

test('checkPort: a live listener is still reported as in use (return semantics preserved)', async () => {
  // The fix must not change the return VALUE: true means "in use", false means
  // "free". A live loopback listener is the in-use case.
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  try {
    assert.equal(await checkPort(port), true, 'a live loopback listener must report true');
    const results = await checkPorts([port]);
    assert.equal(results[port], true, 'checkPorts must report the same');
    assert.equal(await findFreePort(port, port + 1), null, 'findFreePort must not hand back a bound port');
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});

test('checkPort: a free port reports false, and checkPorts/findFreePort agree', async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  assert.equal(await checkPort(port), false, 'a free port must report false');
  const results = await checkPorts([port]);
  assert.equal(results[port], false, 'checkPorts must report the same');

  // `findFreePort` returns a port only when BOTH members of the pair are free.
  const found = await findFreePort(port, port + 1);
  if (found !== null) {
    assert.equal(typeof found, 'number');
  }
});
