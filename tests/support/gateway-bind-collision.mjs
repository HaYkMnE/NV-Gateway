// Test-only companions for startGatewayOnReservedPort (paired-port-allocation.mjs,
// used as-is). Two measured problems in the parallel suite:
//
// 1. A child that loses the free-port race logs `[Gateway:E_STARTUP] Startup
//    failed` at once but only EXITS 3 s later (server.mjs failStartup timer), so a
//    helper that waits for 'exit' pays ~3.2 s per lost race. killOnBindCollision()
//    kills the child as soon as the marker appears on stderr; the helper then sees
//    the exit with that stderr, classifies it as a bind collision and retries a
//    fresh pair immediately.
// 2. bind(0) hands out a sequential ephemeral stream, so concurrent files draw
//    adjacent pairs. highPortReservation() supplies random candidates in a high
//    band instead; reservePortPair still verifies P and P+1 by binding both.

export const GATEWAY_START_MAX_ATTEMPTS = 8;

const BIND_COLLISION_PATTERN = /EADDRINUSE|\[Gateway:E_STARTUP\]/;
const CANDIDATE_MIN_PORT = 20_000;
const CANDIDATE_MAX_PORT = 59_998; // P+1 must stay <= 59999
const CANDIDATES_PER_RESERVATION = 64;

// Caller must spawn the child with stderr 'pipe'. Returns detach(): call it once
// the start succeeded (after ports:bound) so a later stderr line can never kill a
// healthy child. detach() leaves a no-op 'data' listener behind, so the stderr
// pipe keeps flowing (draining) whatever other listeners do; a child whose
// stderr pipe fills up would otherwise block on its next write.
export function killOnBindCollision(child) {
  let tail = '';
  let killed = false;
  const onData = (chunk) => {
    if (killed) return;
    // Keep a short tail so a marker split across two chunks is still detected.
    tail = (tail + Buffer.from(chunk).toString('utf8')).slice(-512);
    if (!BIND_COLLISION_PATTERN.test(tail)) return;
    killed = true;
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch { /* already gone */ }
    }
  };
  child.stderr?.on('data', onData);
  let detached = false;
  return function detach() {
    if (detached) return;
    detached = true;
    // Drain first, then remove: the stream never loses its last 'data' listener.
    child.stderr?.on('data', () => {});
    child.stderr?.removeListener('data', onData);
  };
}

function randomHighPorts(count) {
  const ports = new Set();
  while (ports.size < count) {
    ports.add(CANDIDATE_MIN_PORT + Math.floor(Math.random() * (CANDIDATE_MAX_PORT - CANDIDATE_MIN_PORT + 1)));
  }
  return [...ports];
}

// startGatewayOnReservedPort spreads `reservationOptions` once per start attempt;
// the getter makes every attempt draw a FRESH random candidate list instead of
// re-walking the same one after a collision.
export function highPortReservation() {
  return {
    get candidatePorts() { return randomHighPorts(CANDIDATES_PER_RESERVATION); },
    maxAttempts: CANDIDATES_PER_RESERVATION
  };
}
