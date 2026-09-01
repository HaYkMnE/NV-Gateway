import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;

// ───────────────────────────────────────────────────────────────────────────
// configureSingleInstance must not touch a DESTROYED window.
//
// The reveal body calls isMinimized() -> restore() -> show() -> focus(). The only
// guard in front of it was `if (!window) return`, which tests for NULL. A
// destroyed Electron BrowserWindow is NOT null — the pointer stays truthy and
// every one of those four calls throws "TypeError: Object has been destroyed".
// That was MEASURED in a real launched app for this exact reveal shape and is
// recorded in tests/tray-reveal-destroyed-window.test.mjs:
//
//   ACTION win.destroy() while the tray is ALIVE
//   SNAP  after destroy | windows=0 trayCaptured=yes
//   TRAY_CLICK THREW TypeError: Object has been destroyed
//
// Why it matters beyond a failed reveal: the throw happens inside an Electron
// event callback ("second-instance"), so it reaches
// process.on("uncaughtException") -> fatalShutdownAndExit -> process.exit(1).
// That raw exit skips before-quit -> cleanupAndQuit -> gatewayLifecycle.stop(),
// which is the ipc shutdown that flushes keys.json and the model-key affinity
// cache. src/main/index.ts states this must NEVER be a raw process-level exit.
//
// SCOPE, stated honestly: production is already safe. index.ts passes
// ensureMainWindow(), which rebuilds a destroyed window and never returns one
// destroyed, and tests/tray-reveal-destroyed-window.test.mjs pins that wiring.
// This file guards the MODULE against a future caller that hands over the raw
// pointer — the fragility the audit flagged — and does not relax the existing
// wiring assertion.
// ───────────────────────────────────────────────────────────────────────────

/** Records every reveal call, and throws like Electron once destroyed. */
function destroyableWindow({ destroyed, minimized = false }) {
  const calls = [];
  const guardDestroyed = (name) => {
    calls.push(name);
    if (destroyed) throw new TypeError('Object has been destroyed');
  };
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => { guardDestroyed('isMinimized'); return minimized; },
    restore: () => guardDestroyed('restore'),
    show: () => guardDestroyed('show'),
    focus: () => guardDestroyed('focus')
  };
}

/** A minimal app double that captures the registered "second-instance" listener. */
function wire() {
  let secondInstance = null;
  const app = {
    requestSingleInstanceLock: () => true,
    quit: () => {},
    on: (name, listener) => { if (name === 'second-instance') secondInstance = listener; }
  };
  return { app, fire: () => secondInstance?.(), hasListener: () => secondInstance !== null };
}

test('a second instance arriving at a DESTROYED window neither throws nor touches it', async () => {
  const { configureSingleInstance } = await import(built('single-instance.js'));
  const window = destroyableWindow({ destroyed: true });
  const wired = wire();
  assert.equal(configureSingleInstance(wired.app, () => window), true);
  assert.equal(wired.hasListener(), true, 'the second-instance listener must be registered');

  // The whole point: this must not throw. An escaping TypeError here is what
  // reaches uncaughtException -> process.exit(1) and skips the state flush.
  assert.doesNotThrow(() => wired.fire(),
    'a destroyed window must be detected before any reveal call is made');
  assert.deepEqual(window.calls, [],
    'no reveal method may be invoked on a destroyed window — each one throws "Object has been destroyed"');
});

test('a live window is still revealed exactly as before', async () => {
  const { configureSingleInstance } = await import(built('single-instance.js'));
  const window = destroyableWindow({ destroyed: false, minimized: true });
  const wired = wire();
  assert.equal(configureSingleInstance(wired.app, () => window), true);
  wired.fire();
  assert.deepEqual(window.calls, ['isMinimized', 'restore', 'show', 'focus'],
    'the guard must not change the reveal sequence for a usable window');
});

test('a live, non-minimized window is not restored', async () => {
  const { configureSingleInstance } = await import(built('single-instance.js'));
  const window = destroyableWindow({ destroyed: false, minimized: false });
  const wired = wire();
  configureSingleInstance(wired.app, () => window);
  wired.fire();
  assert.deepEqual(window.calls, ['isMinimized', 'show', 'focus'],
    'restore() must stay conditional on isMinimized()');
});

test('a window double WITHOUT isDestroyed still works', async () => {
  // The published FocusableWindow contract must keep accepting a plain
  // { isMinimized, restore, show, focus } object: tests/p0-backend.test.mjs
  // passes exactly that shape, and an unconditional window.isDestroyed() call
  // would turn it into "isDestroyed is not a function".
  const { configureSingleInstance } = await import(built('single-instance.js'));
  const calls = [];
  const window = {
    isMinimized: () => { calls.push('isMinimized'); return false; },
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus')
  };
  const wired = wire();
  configureSingleInstance(wired.app, () => window);
  assert.doesNotThrow(() => wired.fire(),
    'a double without isDestroyed must not fault — the probe has to be optional');
  assert.deepEqual(calls, ['isMinimized', 'show', 'focus']);
});

test('a null window is still handled, and the lock refusal still quits', async () => {
  const { configureSingleInstance } = await import(built('single-instance.js'));
  const wired = wire();
  configureSingleInstance(wired.app, () => null);
  assert.doesNotThrow(() => wired.fire(), 'a null window must remain a quiet no-op');

  const events = [];
  const denied = configureSingleInstance({
    requestSingleInstanceLock: () => false,
    quit: () => events.push('quit'),
    on: () => { throw new Error('a denied instance must not register listeners'); }
  }, () => null);
  assert.equal(denied, false);
  assert.deepEqual(events, ['quit']);
});
