import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Upper bound on the DEFAULT (bind(0)-probe) reservation's DISTINCT-candidate
// budget. The OS ephemeral allocator hands out ports as a SEQUENTIAL stream
// (measured: four concurrent workers drew overlapping bands, e.g.
// 9372-9849 / 9373-9850 / 9374-9851 / 9375-9852), so a single bind(0) probe per
// attempt let concurrent workers keep colliding inside the SAME narrow band
// until the 8-attempt budget was exhausted. One reservation now draws a batch of
// probes up-front and consumes batch entries as DISTINCT candidates, mirroring
// the explicit `candidatePorts` path, which never exhausts because each
// collision costs one candidate rather than the whole budget.
const DEFAULT_MAX_ATTEMPTS = 8;
// Probes drawn per batch. A batch maps to a contiguous run of fresh ephemeral
// ports; filtering it against the coordination directory lets the reservation
// skip the band that concurrent workers are actively locking.
const RANDOM_CANDIDATE_PROBES_PER_ROUND = 16;
// Hard ceiling on distinct candidates a single DEFAULT reservation may try:
// 64 distinct candidates with a ~1-8% per-pair incidental-lock collision rate
// leaves a success margin of roughly 0.92^64 ~= 0.005 (well beyond the ~5-8%
// failure rate measured for the pre-fix 8-attempt budget, whose margin was
// 0.92^8 ~= 0.50).
const MAX_DISTINCT_CANDIDATES = 64;
const DEFAULT_STALE_LOCK_MS = 5 * 60_000;
const DEFAULT_READINESS_TIMEOUT_MS = 20_000;
const BIND_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 5_000;
// Upper bound between a child's `exit` and its stdio `close` (see waitForBoundOrExit).
const EXIT_DRAIN_TIMEOUT_MS = 1_000;
const MAX_RANDOM_CANDIDATE_ATTEMPTS = 50;
// Lower bound of the usable dynamic-port range (Windows `netsh int ipv4 show
// dynamicport tcp` reports start 1024 on this class of machine). Candidates
// below it would be rejected at bind time anyway, so they are not consumed as
// attempts.
const RANDOM_CANDIDATE_MIN_PORT = 1024;
const RANDOM_CANDIDATE_MAX_PORT = 65534;
// Bounded backoff between bind-collision retries: longer than the time another
// test takes to release a contended socket, short enough to stay invisible when
// no collision occurs (the delay is only taken on the retry path).
const COLLISION_BACKOFF_MS = 40;
const COLLISION_BACKOFF_JITTER_MS = 60;
const COORDINATION_DIRECTORY = path.join(os.tmpdir(), 'nv-gateway-test-port-pairs-v1');

export function getPairLockPaths(port, directory = COORDINATION_DIRECTORY) {
  return {
    directory,
    gateway: path.join(directory, `${port}.lock`),
    admin: path.join(directory, `${port + 1}.lock`)
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function readLock(lockPath) {
  try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
  catch { return null; }
}

function removeStaleLock(lockPath, staleLockMs, now) {
  let stat;
  try { stat = fs.statSync(lockPath); } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
  const lock = readLock(lockPath);
  const createdAt = Number.isFinite(lock?.createdAt) ? lock.createdAt : stat.mtimeMs;
  if (now - createdAt < staleLockMs || processIsAlive(lock?.pid)) return false;
  // Re-read immediately before deletion to NARROW the window in which a
  // concurrent cleaner could delete a lock that a fresh owner just created.
  // This is NOT atomic: the sequence read -> compare -> unlink has a residual
  // gap, so two cleaners can both judge one dead-owner lock stale and the
  // second unlink can still remove the first one's replacement. The accepted
  // worst case is test-only: two workers believing they own one pair collide
  // on bind and the existing fresh-pair retry absorbs it. A full fix would
  // need an atomic compare-and-delete, which this two-file scheme cannot give
  // on NTFS; that machinery is not justified for a test helper whose stale
  // condition additionally requires a dead pid and an aged lock.
  const expectedToken = lock?.token;
  const current = readLock(lockPath);
  if (current?.token !== expectedToken || current?.pid !== lock?.pid || current?.createdAt !== lock?.createdAt) return false;
  try { fs.unlinkSync(lockPath); return true; }
  catch (error) { return error?.code === 'ENOENT'; }
}

function acquireLock(lockPath, payload, staleLockMs) {
  for (let pass = 0; pass < 2; pass++) {
    try { fs.writeFileSync(lockPath, payload, { flag: 'wx' }); return true; }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (pass === 0 && removeStaleLock(lockPath, staleLockMs, Date.now())) continue;
      return false;
    }
  }
  return false;
}

function releaseOwnedLock(lockPath, token) {
  const lock = readLock(lockPath);
  if (lock?.token !== token) return;
  try { fs.unlinkSync(lockPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

async function bind(port) {
  const server = net.createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { server.closeAllConnections?.(); } catch {}
        try { server.close(); } catch {}
        reject(new Error(`Timed out after ${BIND_TIMEOUT_MS}ms binding 127.0.0.1:${port}.`));
      }, BIND_TIMEOUT_MS);
      server.once('error', (error) => { clearTimeout(timer); reject(error); });
      server.listen(port, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
    });
    return server;
  } catch (error) {
    try { server.close(); } catch {}
    throw error;
  }
}

async function close(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { server.closeAllConnections?.(); } catch {}
      resolve();
    }, CLOSE_TIMEOUT_MS);
    server.close(() => { clearTimeout(timer); resolve(); });
    // Force-close idle/keep-alive connections so the close callback can fire.
    try { server.closeAllConnections?.(); } catch {}
  });
}

// Draw a BATCH of fresh bind(0) probes, close them, and return the distinct
// valid ports (excluding any port already attempted in this reservation). The
// whole batch is probed at once, so the syscall count per round stays low while
// the candidate supply widens from one port to many.
async function probeCandidateBatch(count, attempted) {
  const probes = await Promise.allSettled(Array.from({ length: count }, () => bind(0)));
  const ports = [];
  for (const probe of probes) {
    if (probe.status !== 'fulfilled') continue;
    const server = probe.value;
    let port;
    try { port = server.address().port; } catch { port = undefined; }
    await close(server);
    if (Number.isInteger(port) && port >= RANDOM_CANDIDATE_MIN_PORT && port <= RANDOM_CANDIDATE_MAX_PORT && !attempted.has(port)) {
      attempted.add(port);
      ports.push(port);
    }
  }
  return ports;
}

function lockFilesAbsent(port, directory) {
  const paths = getPairLockPaths(port, directory);
  return fs.existsSync(paths.gateway) || fs.existsSync(paths.admin) ? 1 : 0;
}

async function randomCandidates(attempted, directory) {
  let lastError;
  for (let round = 1; round <= MAX_RANDOM_CANDIDATE_ATTEMPTS; round++) {
    try {
      const batch = await probeCandidateBatch(RANDOM_CANDIDATE_PROBES_PER_ROUND, attempted);
      // Prefer ports whose lock files are ABSENT in the coordination directory:
      // that rules out both a live owner and a not-yet-stale dead-owner lock, so
      // the batch yields the cleanest candidates first instead of spending
      // attempts on ports another live worker is already holding.
      batch.sort((a, b) => lockFilesAbsent(a, directory) - lockFilesAbsent(b, directory));
      if (batch.length > 0) return batch;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Unable to obtain a random candidate port after ${MAX_RANDOM_CANDIDATE_ATTEMPTS} probe rounds.`, { cause: lastError });
}

export async function reservePortPair(options = {}) {
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const directory = options.coordinationDirectory ?? COORDINATION_DIRECTORY;
  const usesExplicitCandidates = Array.isArray(options.candidatePorts);
  // A reservation is bounded by the number of DISTINCT candidates it may try,
  // never by a raw attempt count: a lock held by a LIVING owner is not a reason
  // to give up, and re-trying the same port is not a reason to continue. An
  // explicit `maxAttempts` still bounds caller-supplied candidate lists in list
  // order (existing callers rely on that); in random mode it is the
  // distinct-candidate budget, defaulting to MAX_DISTINCT_CANDIDATES.
  const candidateBudget = options.maxAttempts ?? (usesExplicitCandidates ? DEFAULT_MAX_ATTEMPTS : MAX_DISTINCT_CANDIDATES);
  const candidates = usesExplicitCandidates ? [...options.candidatePorts] : [];
  const attempted = new Set();
  fs.mkdirSync(directory, { recursive: true });
  let lastError;
  let randomBatch = [];

  for (let distinctTried = 0; distinctTried < candidateBudget; distinctTried++) {
    let port;
    if (usesExplicitCandidates) {
      // Preserve list order: one candidate per budget step, exactly as before.
      if (candidates.length === 0) break;
      port = candidates.shift();
      if (attempted.has(port)) continue;
      attempted.add(port);
    } else {
      // Random mode: draw a batch of distinct candidates on demand and consume
      // them one per step. A candidate that collides costs ONE step; the next
      // step takes the next distinct candidate from the batch (never a retry).
      if (randomBatch.length === 0) {
        try { randomBatch = await randomCandidates(attempted, directory); }
        catch (error) { lastError = error; break; }
      }
      port = randomBatch.shift();
      if (port === undefined) continue;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65534) continue;
    const paths = getPairLockPaths(port, directory);
    const token = crypto.randomBytes(16).toString('hex');
    const payload = JSON.stringify({ pid: process.pid, createdAt: Date.now(), token, port });
    const owned = [];
    let first;
    let second;
    try {
      if (!acquireLock(paths.gateway, payload, staleLockMs)) throw new Error(`Port pair ${port}/${port + 1} is reserved.`);
      owned.push(paths.gateway);
      if (!acquireLock(paths.admin, payload, staleLockMs)) throw new Error(`Port pair ${port}/${port + 1} is reserved.`);
      owned.push(paths.admin);
      first = await bind(port);
      second = await bind(port + 1);
      await Promise.all([close(first), close(second)]);
      first = undefined; second = undefined;
      let released = false;
      return {
        port,
        adminPort: port + 1,
        async release() {
          if (released) return;
          released = true;
          for (const lockPath of owned.reverse()) releaseOwnedLock(lockPath, token);
        }
      };
    } catch (error) {
      lastError = error;
      await Promise.all([close(first), close(second)]);
      for (const lockPath of owned.reverse()) releaseOwnedLock(lockPath, token);
    }
  }
  throw new Error(`Unable to reserve a free gateway port pair after ${candidateBudget} attempts.`, { cause: lastError });
}

function waitForBoundOrExit(child, port, timeoutMs, stdoutChunks, stderrChunks) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(reject, new Error(`Timed out after ${timeoutMs}ms waiting for ports:bound on ${port}/${port + 1}.`)), timeoutMs);
    const onMessage = (message) => {
      if (message?.type !== 'ports:bound' || message.gatewayPort !== port || message.adminPort !== port + 1) return;
      finish(resolve, message);
    };
    // Node emits `exit` as soon as the process ends, while its stdio pipes may
    // still hold undelivered data; `close` fires only after every stdio stream
    // ended. isBindCollision() regexes the captured stderr, so settling on
    // `exit` could drop a trailing EADDRINUSE / [Gateway:E_STARTUP] marker and
    // turn a retryable collision into a hard failure (proven by
    // tests/paired-port-allocation-close.test.mjs). Settle on `close`; after
    // `exit`, wait at most EXIT_DRAIN_TIMEOUT_MS for it (a grandchild holding
    // the pipe must not hang startup), then settle with what was captured.
    let drainTimer;
    const settleExited = (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      finish(reject, Object.assign(new Error(`Gateway exited before ports:bound (code=${code}, signal=${signal ?? 'none'}).\nchild stdout: ${stdout || '<empty>'}\nchild stderr: ${stderr || '<empty>'}`), { childExited: true, stdout, stderr, exitCode: code, signal }));
    };
    const onExit = (code, signal) => {
      if (settled || drainTimer) return;
      drainTimer = setTimeout(() => settleExited(code, signal), EXIT_DRAIN_TIMEOUT_MS);
    };
    const onClose = (code, signal) => settleExited(code ?? child.exitCode, signal ?? child.signalCode);
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(drainTimer);
      child.removeListener('message', onMessage);
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      settle(value);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('close', onClose);
    // A child that already exited before these listeners were attached never
    // emits 'exit' again (and may never emit 'close' again either), so arm the
    // bounded drain from its terminal state instead of letting the readiness
    // timeout run out. If 'close' still arrives, it settles first; finish() is
    // idempotent either way.
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}

export function isBindCollision(error) {
  const diagnostic = `${error?.message ?? ''}\n${error?.stderr ?? ''}\n${error?.stdout ?? ''}`;
  // server.mjs emits this dedicated marker only from a listener's `error`
  // handler; production redaction intentionally withholds the raw bind error.
  return /EADDRINUSE/i.test(diagnostic) || /\[Gateway:E_STARTUP\]\s*Startup failed/.test(diagnostic);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill(); } catch { clearTimeout(timer); resolve(); }
  });
}

export async function startGatewayOnReservedPort(options) {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  let lastCollision;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // `reservationAttempts` is a one-off override for the RESERVATION loop only.
    // It must be applied ONLY when explicitly provided: spreading a literal
    // `maxAttempts: undefined` would overwrite a caller's
    // `reservationOptions.maxAttempts` with `undefined`, and reservePortPair's
    // own `?? DEFAULT_MAX_ATTEMPTS` would then silently replace the caller's
    // value with the default instead of honouring it.
    const reservationOptions = options.reservationAttempts === undefined
      ? { ...options.reservationOptions }
      : { ...options.reservationOptions, maxAttempts: options.reservationAttempts };
    const reservation = await reservePortPair(reservationOptions);
    let child;
    try {
      child = await options.spawnChild(reservation.port, attempt);
      const stdoutChunks = [];
      const stderrChunks = [];
      child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
      child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
      await waitForBoundOrExit(child, reservation.port, readinessTimeoutMs, stdoutChunks, stderrChunks);
      await reservation.release();
      return { child, port: reservation.port, adminPort: reservation.adminPort, attempt };
    } catch (error) {
      await stopChild(child);
      if (!isBindCollision(error) || attempt === maxAttempts) throw error;
      lastCollision = error;
      // MEASURED RELIABILITY FIX (Level-1 Round C): the reservation binds and
      // RELEASES the port pair before the child re-binds it, so the fixed-size
      // retry budget can be exhausted by a burst of collisions when the whole
      // suite runs in parallel (observed: `[Gateway:E_STARTUP] Startup failed`
      // on attempt 3 of 3, and a different test file losing the same race). A
      // short jittered backoff lets the burst drain instead of re-colliding
      // deterministically; it costs nothing on the happy path (no retry taken).
      await new Promise((resolve) => setTimeout(resolve, COLLISION_BACKOFF_MS + Math.floor(Math.random() * COLLISION_BACKOFF_JITTER_MS)));
    } finally {
      await reservation.release();
    }
  }
  throw lastCollision ?? new Error(`Gateway startup attempts exhausted after ${maxAttempts} bounded attempt(s) without a successful start.`);
}
