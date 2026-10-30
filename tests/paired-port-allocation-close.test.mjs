// Regression for the startGatewayOnReservedPort bind-collision classifier.
//
// Node documents that a child's `exit` event may fire while its stdio streams
// are still open (undelivered data); `close` fires only after every stdio
// stream has ended. The helper used to settle on `exit` and join the stderr
// captured SO FAR, so a trailing `EADDRINUSE` / `[Gateway:E_STARTUP]` marker
// could be cut off and a retryable bind collision misread as a hard failure.
//
// Measured on Windows/Node 24 with REAL children (256 KiB and 4 MiB stderr, and
// a grandchild inheriting stderr), `exit` and `close` arrived in the same tick
// with every byte delivered, so the race is not reproducible with a real
// process here. The ordering tests therefore drive the helper through its
// public `spawnChild` API with a ChildProcess-shaped fake that emits events in
// the documented worst-case order. A real-child test is kept as a sanity check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { startGatewayOnReservedPort } from './support/paired-port-allocation.mjs';

const FILLER_BYTES = 256 * 1024;
const COLLISION_LINE = 'Error: listen EADDRINUSE: address already in use 127.0.0.1\n';

// Minimal ChildProcess shape the helper uses: events, stdout/stderr streams,
// exitCode/signalCode, kill(). exitCode is set before `exit` is emitted, as in
// Node, so the helper's stopChild() treats it as already terminated.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  return child;
}

function exitFake(child, code = 1) {
  child.exitCode = code;
  child.emit('exit', code, null);
}

// Attempt 2 of every retry test: attests the paired ports over IPC.
function boundFake(port) {
  const child = fakeChild();
  setImmediate(() => child.emit('message', { type: 'ports:bound', gatewayPort: port, adminPort: port + 1 }));
  return child;
}

async function startWith(firstAttempt, { readinessTimeoutMs = 3_000 } = {}) {
  const attempts = [];
  const result = await startGatewayOnReservedPort({
    maxAttempts: 2,
    readinessTimeoutMs,
    spawnChild: (port, attempt) => {
      attempts.push(attempt);
      return attempt === 1 ? firstAttempt() : boundFake(port);
    }
  });
  return { attempts, result };
}

test('stderr delivered AFTER `exit` but before `close` is classified as a bind collision and retried', async () => {
  const { attempts, result } = await startWith(() => {
    const child = fakeChild();
    setImmediate(() => {
      exitFake(child);                       // process gone, pipe not drained yet
      setImmediate(() => {
        child.stderr.end(COLLISION_LINE);    // trailing diagnostic arrives late
        child.stderr.once('end', () => child.emit('close', 1, null));
        child.stderr.resume();
      });
    });
    return child;
  });
  assert.deepEqual(attempts, [1, 2], 'a late EADDRINUSE must be read at `close`, not dropped at `exit`');
  assert.equal(result.attempt, 2);
});

test('a child that already exited before listeners attached still yields its buffered stderr', async () => {
  const { attempts } = await startWith(() => {
    const child = fakeChild();
    child.stderr.write(COLLISION_LINE);      // buffered, not yet consumed
    child.exitCode = 1;                      // terminal state, no events will follow
    return child;
  });
  assert.deepEqual(attempts, [1, 2], 'the pre-exited child must be settled from its terminal state with the captured stderr');
});

test('`close` that never arrives after `exit` cannot hang startup: it settles with what was captured', async () => {
  const started = Date.now();
  const { attempts } = await startWith(() => {
    const child = fakeChild();
    setImmediate(() => {
      child.stderr.write(COLLISION_LINE);
      setImmediate(() => exitFake(child));   // `close` is never emitted
    });
    return child;
  });
  // Without the bounded post-exit drain, this would wait for the 3s readiness
  // timeout, a NON-collision error, and reject instead of retrying.
  assert.deepEqual(attempts, [1, 2]);
  assert.ok(Date.now() - started < 3_000, 'settled by the post-exit bound, not by the readiness timeout');
});

// Real-process sanity: a real node child writing a large stderr then exiting.
function spawnNode(source) {
  return spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
}

test('real child: EADDRINUSE at the tail of a 256 KiB stderr is retried', async () => {
  const { attempts } = await startWith(
    () => spawnNode(`process.stderr.write('x'.repeat(${FILLER_BYTES}) + ${JSON.stringify('\n' + COLLISION_LINE)}); process.exit(1);`),
    { readinessTimeoutMs: 15_000 }
  );
  assert.deepEqual(attempts, [1, 2]);
});

test('real child: a hard startup failure is still NOT retried (classifier did not become permissive)', async () => {
  const attempts = [];
  await assert.rejects(
    startGatewayOnReservedPort({
      maxAttempts: 2,
      readinessTimeoutMs: 15_000,
      spawnChild: (_port, attempt) => {
        attempts.push(attempt);
        return spawnNode(`process.stderr.write('x'.repeat(${FILLER_BYTES}) + '\\nfatal: bad config\\n'); process.exit(1);`);
      }
    }),
    (error) => error.childExited === true && /fatal: bad config/.test(error.stderr) && error.stderr.length >= FILLER_BYTES
  );
  assert.deepEqual(attempts, [1], 'a non-collision failure must fail fast on the first attempt');
});
