import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseRetryAfter,
  resolveMaxFailoverAttempts,
  classifyUpstreamStatus,
  classifyUpstreamResponse,
  isNvcfDispatchFailure,
  isPoolWideCapableStatus,
  resolvePoolWideFailureStatus,
  resolveRateLimitMaxAttempts,
  shouldEarlyStopOnRateLimit,
  isSuccessfulStatus,
  DEFAULT_RATE_LIMIT_MAX_ATTEMPTS,
  MAX_RATE_LIMIT_MAX_ATTEMPTS,
  MIN_RATE_LIMIT_MAX_ATTEMPTS,
  MAX_CONFIGURED_FAILOVER_ATTEMPTS,
  MAX_RETRY_AFTER_SECONDS,
  MIN_RETRY_AFTER_SECONDS
} from '../src/gateway/failover-policy.mjs';

test('parseRetryAfter caps absurd retry-after values (e.g. 2145914s) to MAX_RETRY_AFTER_SECONDS (300)', () => {
  assert.equal(MAX_RETRY_AFTER_SECONDS, 300);
  assert.equal(parseRetryAfter('2145914'), 300);
  assert.equal(parseRetryAfter('9999999'), 300);
  assert.equal(parseRetryAfter(2145914), 300);
});

test('parseRetryAfter handles normal seconds and bounds lower limit', () => {
  assert.equal(parseRetryAfter('15'), 15);
  assert.equal(parseRetryAfter('1'), 1);
  assert.equal(parseRetryAfter('0'), MIN_RETRY_AFTER_SECONDS);
  assert.equal(parseRetryAfter('-50'), MIN_RETRY_AFTER_SECONDS);
});

test('parseRetryAfter handles HTTP date strings', () => {
  const now = Date.now();
  const futureDate = new Date(now + 10_000).toUTCString();
  assert.equal(parseRetryAfter(futureDate, now), 10);

  const farFutureDate = new Date(now + 10_000_000).toUTCString();
  assert.equal(parseRetryAfter(farFutureDate, now), 300);

  const pastDate = new Date(now - 10_000).toUTCString();
  assert.equal(parseRetryAfter(pastDate, now), MIN_RETRY_AFTER_SECONDS);
});

test('parseRetryAfter returns null for invalid inputs', () => {
  assert.equal(parseRetryAfter('invalid-string'), null);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(NaN), null);
});

test('resolveMaxFailoverAttempts parses env and defaults safely', () => {
  assert.equal(resolveMaxFailoverAttempts({}), 3);
  assert.equal(resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '5' }), 5);
  assert.equal(resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '99' }), MAX_CONFIGURED_FAILOVER_ATTEMPTS);
  assert.equal(resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: 'invalid' }), 3);
  assert.equal(resolveMaxFailoverAttempts({}, 5), 5);
  assert.equal(resolveMaxFailoverAttempts({}, 10), 10);
  assert.equal(resolveMaxFailoverAttempts({}, 2), 3);
});

test('resolveMaxFailoverAttempts bounds huge requested budgets but never truncates eligible coverage', () => {
  assert.equal(MAX_CONFIGURED_FAILOVER_ATTEMPTS, 64);
  assert.equal(resolveMaxFailoverAttempts({}, 1, Number.MAX_SAFE_INTEGER, 1), MAX_CONFIGURED_FAILOVER_ATTEMPTS);
  assert.equal(resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: String(Number.MAX_SAFE_INTEGER) }, 1, 3, 1), MAX_CONFIGURED_FAILOVER_ATTEMPTS);
  assert.equal(resolveMaxFailoverAttempts({}, 1, 999_999_999, 1), MAX_CONFIGURED_FAILOVER_ATTEMPTS);
  assert.equal(resolveMaxFailoverAttempts({}, 1_000, 2_000, 1_000), 1_000,
    'the MAX_KEYS coverage floor remains fully reachable above the configured ceiling');
  assert.equal(resolveMaxFailoverAttempts({}, 1_001, 2, 1_001), 1_001,
    'coverage remains authoritative even if a defensive caller reports more than MAX_KEYS');
});

test('resolveMaxFailoverAttempts never shrinks the attempt budget below eligible pool coverage (owner rule)', () => {
  // Owner rule: rotation is CIRCULAR across the whole pool — the attempt budget
  // must cover every eligible key. A profile cap or env override BELOW that is
  // raised to coverage; the default floor is the pool itself.
  assert.equal(resolveMaxFailoverAttempts({}, 15, 3), 15, 'config 3 < 15 pool: coverage wins');
  assert.equal(resolveMaxFailoverAttempts({}, 15, 2), 15);
  assert.equal(resolveMaxFailoverAttempts({}, 3, 5), 5, 'a config cap ABOVE the pool survives');
  // env knob is authoritative only when it meets coverage.
  assert.equal(resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '2' }, 15, 5), 15, 'env 2 < 15 pool: raised to coverage');
  assert.equal(resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '8' }, 5, 3), 8, 'env 8 >= 5 pool: stands');
  // Invalid env falls back through config to the pool fallback.
  assert.equal(resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '999999999' }, 15, 3), MAX_CONFIGURED_FAILOVER_ATTEMPTS);
  assert.equal(resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: 'invalid' }, 5, undefined), 5);
  // Missing/invalid configured bound degrades to the pool fallback.
  assert.equal(resolveMaxFailoverAttempts({}, 10, undefined), 10);
  assert.equal(resolveMaxFailoverAttempts({}, 10, null), 10);
  assert.equal(resolveMaxFailoverAttempts({}, 10, 0), 10);
  assert.equal(resolveMaxFailoverAttempts({}, 10, 3.5), 10);
});

test('resolveMaxFailoverAttempts honors the explicit coverage argument (model-eligible snapshot)', () => {
  // minimumCoverage overrides poolCount as the floor: a model whose eligible
  // set is smaller than the pool only needs to cover its own snapshot.
  assert.equal(resolveMaxFailoverAttempts({}, 15, 3, 4), 4, 'eligible 4 < pool 15: budget covers the model set');
  assert.equal(resolveMaxFailoverAttempts({}, 15, 3, 15), 15);
  // A LARGER configured/env value still wins when it exceeds coverage.
  assert.equal(resolveMaxFailoverAttempts({}, 15, 8, 4), 8);
  assert.equal(resolveMaxFailoverAttempts({ GATEWAY_MAX_FAILOVER_ATTEMPTS: '8' }, 15, 3, 4), 8);
  // Zero-eligible (all model-cooled): the server substitutes activeCount; the
  // function itself treats 0/absent as pool-wide coverage.
  assert.equal(resolveMaxFailoverAttempts({}, 5, 2, 0), 5, '0 coverage falls through to the pool floor');
});

test('resolveRateLimitMaxAttempts defaults to 2 and CLAMPS both override sources into 1..3', () => {
  assert.equal(MIN_RATE_LIMIT_MAX_ATTEMPTS, 1);
  assert.equal(MAX_RATE_LIMIT_MAX_ATTEMPTS, 3);
  assert.equal(DEFAULT_RATE_LIMIT_MAX_ATTEMPTS, 2);

  // Default with no override of any kind.
  assert.equal(resolveRateLimitMaxAttempts({}), 2);
  assert.equal(resolveRateLimitMaxAttempts({}, undefined), 2);

  // Env override inside the range is taken verbatim.
  assert.equal(resolveRateLimitMaxAttempts({ GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: '1' }), 1);
  assert.equal(resolveRateLimitMaxAttempts({ GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: '3' }), 3);

  // Out-of-range env is CLAMPED (not rejected, unlike resolveMaxFailoverAttempts):
  // a larger value cannot help, so the operator gets the largest defensible one.
  assert.equal(resolveRateLimitMaxAttempts({ GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: '9' }), 3);
  assert.equal(resolveRateLimitMaxAttempts({ GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: '15' }), 3);
  assert.equal(resolveRateLimitMaxAttempts({ GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: '0' }), 1);

  // Malformed env is not a bound at all and falls through to config, then default.
  assert.equal(resolveRateLimitMaxAttempts({ GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: 'invalid' }), 2);
  assert.equal(resolveRateLimitMaxAttempts({ GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: '' }), 2);
  assert.equal(resolveRateLimitMaxAttempts({ GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: '2.5' }), 2);
  assert.equal(resolveRateLimitMaxAttempts({ GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: '-1' }), 2);
  assert.equal(resolveRateLimitMaxAttempts({ GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: 'invalid' }, 3), 3);

  // Config bound is honored and likewise clamped; env stays authoritative over it.
  assert.equal(resolveRateLimitMaxAttempts({}, 1), 1);
  assert.equal(resolveRateLimitMaxAttempts({}, 3), 3);
  assert.equal(resolveRateLimitMaxAttempts({}, 9), 3);
  assert.equal(resolveRateLimitMaxAttempts({ GATEWAY_RATE_LIMIT_MAX_ATTEMPTS: '1' }, 3), 1);

  // Degenerate config values degrade to the default.
  assert.equal(resolveRateLimitMaxAttempts({}, null), 2);
  assert.equal(resolveRateLimitMaxAttempts({}, 2.5), 2);
  assert.equal(resolveRateLimitMaxAttempts({}, NaN), 2);
});

test('shouldEarlyStopOnRateLimit requires full eligible-pool coverage of the 429 history', () => {
  // The verdict is coverage-gated: a uniform 429 history must cover EVERY
  // eligible key (attempted distinct, by the request-start snapshot).
  // Confirming attempts alone (the old 2-of-15 rule) is NOT enough.
  assert.equal(shouldEarlyStopOnRateLimit([429, 429], 2, 3, 2), false, 'only 2 of 3 eligible covered — keep rotating');
  assert.equal(shouldEarlyStopOnRateLimit([429, 429, 429], 2, 3, 3), true, 'all 3 eligible keys answered 429');
  assert.equal(shouldEarlyStopOnRateLimit([429, 429, 429, 429], 3, 4, 3), false, '3 of 4 — still not covered');

  // The legacy 2-arg calls (no snapshot) degrade to the old confirming-count
  // semantics for direct callers of the helper.
  assert.equal(shouldEarlyStopOnRateLimit([429, 429], 2), true);
  assert.equal(shouldEarlyStopOnRateLimit([429], 2), false);

  // Mixed-outcome histories never stop early, regardless of coverage.
  assert.equal(shouldEarlyStopOnRateLimit([429, 500], 2, 3, 2), false);
  assert.equal(shouldEarlyStopOnRateLimit([503, 503, 503], 2, 3, 3), false);
  assert.equal(shouldEarlyStopOnRateLimit([404, 404], 2, 2, 2), false);
  assert.equal(shouldEarlyStopOnRateLimit([], 2, 3, 0), false);
  assert.equal(shouldEarlyStopOnRateLimit(undefined, 2, 3, 0), false);

  // Degenerate knobs degrade to defaults; the coverage gate is the floor.
  assert.equal(shouldEarlyStopOnRateLimit([429, 429], undefined), true);
});

test('isPoolWideCapableStatus admits capacity/fault statuses and rejects per-key signals', () => {
  // Quota / capacity / upstream-fault answers can describe the whole pool.
  for (const status of [429, 500, 502, 503, 504, 529]) {
    assert.equal(isPoolWideCapableStatus(status), true, `${status} should be pool-wide capable`);
  }
  // Credential verdicts are about ONE key — never the upstream's answer for the pool.
  for (const status of [401, 403]) {
    assert.equal(isPoolWideCapableStatus(status), false, `${status} is a per-key signal`);
  }
  // 404 is either a per-credential NVCF dispatch failure or already non-retryable.
  assert.equal(isPoolWideCapableStatus(404), false);
  assert.equal(isPoolWideCapableStatus(410), false);
  assert.equal(isPoolWideCapableStatus(200), false);
  assert.equal(isPoolWideCapableStatus(undefined), false);
});

test('classifyUpstreamStatus identifies retryable vs non-retryable statuses', () => {
  assert.equal(isSuccessfulStatus(200), true);
  assert.equal(isSuccessfulStatus(204), true);
  assert.equal(isSuccessfulStatus(400), false);

  assert.equal(classifyUpstreamStatus(429).retryable, true);
  assert.equal(classifyUpstreamStatus(500).retryable, true);
  assert.equal(classifyUpstreamStatus(503).retryable, true);
  assert.equal(classifyUpstreamStatus(400).retryable, false);
  assert.equal(classifyUpstreamStatus(404).retryable, false);
});

test('isNvcfDispatchFailure detects the NVCF dispatch-marker 404 but not a plain 404', () => {
  // A genuinely unknown / unroutable model id is answered by the frontend
  // with a text/plain "404 page not found" and no nvcf-* headers.
  assert.equal(isNvcfDispatchFailure(404, { 'content-type': 'text/plain; charset=utf-8' }), false);
  assert.equal(isNvcfDispatchFailure(404, {}), false);
  assert.equal(isNvcfDispatchFailure(404, undefined), false);
  assert.equal(isNvcfDispatchFailure(404, null), false);

  // A per-key NVCF function-dispatch failure carries nvcf-status / nvcf-reqid.
  assert.equal(isNvcfDispatchFailure(404, { 'nvcf-status': 'errored' }), true);
  assert.equal(isNvcfDispatchFailure(404, { 'nvcf-reqid': 'a03acae2-322f-4e37-9540-884e0851f09d' }), true);

  // Only 404 is treated this way.
  assert.equal(isNvcfDispatchFailure(400, { 'nvcf-status': 'errored' }), false);
  assert.equal(isNvcfDispatchFailure(500, { 'nvcf-status': 'errored' }), false);
});

test('classifyUpstreamResponse retries NVCF dispatch-failure 404s but not plain 404s', () => {
  // Plain 404 stays non-retryable (existing classifyUpstreamStatus semantics).
  assert.equal(classifyUpstreamResponse(404, { 'content-type': 'text/plain' }).retryable, false);
  assert.equal(classifyUpstreamResponse(404, {}).retryable, false);

  // NVCF entitlement/dispatch 404 becomes retryable so failover can rotate keys.
  assert.deepEqual(classifyUpstreamResponse(404, { 'nvcf-status': 'errored' }), { success: false, retryable: true });

  // Other statuses are unchanged.
  assert.deepEqual(classifyUpstreamResponse(200, { 'nvcf-status': 'errored' }), { success: true, retryable: false });
  assert.deepEqual(classifyUpstreamResponse(429, {}), { success: false, retryable: true });
  assert.deepEqual(classifyUpstreamResponse(500, {}), { success: false, retryable: true });
  assert.deepEqual(classifyUpstreamResponse(400, {}), { success: false, retryable: false });
});

test('resolvePoolWideFailureStatus fires when every attempt is 429 and the attempt budget is BELOW the pool size', () => {
  // REGRESSION (observed live): active pool = 15, but the performance "day"
  // profile caps maxFailoverAttempts at 3. Three distinct keys each returned
  // 429, yet the old coverage test (attemptedKeyIds.size >= activeCount, i.e.
  // 3 >= 15) was UNSATISFIABLE BY CONSTRUCTION, so the verdict never fired and
  // the client received a misleading 502 "All failover attempts exhausted"
  // instead of the honest 429 the upstream actually returned.
  assert.equal(resolvePoolWideFailureStatus([429, 429, 429], 3, 3, 15), 429);
  // Same shape for the other pool-wide-capable statuses.
  assert.equal(resolvePoolWideFailureStatus([503, 503, 503], 3, 3, 15), 503);
});

test('resolvePoolWideFailureStatus uses min(maxAttempts, activeCount) as the coverage ceiling', () => {
  // Budget larger than the keys actually tried => not enough coverage yet.
  assert.equal(resolvePoolWideFailureStatus([429, 429, 429], 3, 15, 15), null);
  // Full coverage of the pool => verdict fires.
  assert.equal(resolvePoolWideFailureStatus([429, 429, 429], 15, 15, 15), 429);
  // Budget larger than the pool clamps to the pool size.
  assert.equal(resolvePoolWideFailureStatus([429, 429], 2, 8, 2), 429);
});

test('resolvePoolWideFailureStatus rejects mixed statuses and per-key signals', () => {
  // MIXED statuses must never yield a pool-wide verdict.
  assert.equal(resolvePoolWideFailureStatus([429, 502], 2, 2, 2), null);
  assert.equal(resolvePoolWideFailureStatus([500, 500, 429], 3, 3, 3), null);
  // Credential verdicts are per-key, never the upstream's answer for the pool.
  assert.equal(resolvePoolWideFailureStatus([401, 401, 401], 3, 3, 3), null);
  assert.equal(resolvePoolWideFailureStatus([403, 403], 2, 2, 2), null);
});

test('resolvePoolWideFailureStatus is defensive about degenerate inputs', () => {
  assert.equal(resolvePoolWideFailureStatus([], 0, 3, 3), null);
  assert.equal(resolvePoolWideFailureStatus(undefined, 0, 3, 3), null);
  assert.equal(resolvePoolWideFailureStatus(null, 0, 3, 3), null);
  // No active keys => coverage is trivially satisfied (nothing left to cover).
  assert.equal(resolvePoolWideFailureStatus([429], 1, 3, 0), 429);
  // Missing/invalid attempt budget degrades to the full-pool requirement.
  assert.equal(resolvePoolWideFailureStatus([429, 429, 429], 3, undefined, 15), null);
  assert.equal(resolvePoolWideFailureStatus([429, 429, 429], 15, undefined, 15), 429);
});
