import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseRetryAfter,
  resolveMaxFailoverAttempts,
  classifyUpstreamStatus,
  classifyUpstreamResponse,
  MAX_RETRY_AFTER_SECONDS,
  MIN_RETRY_AFTER_SECONDS
} from '../src/gateway/failover-policy.mjs';

test('failover policy handles retry-after and bounds', () => {
  assert.equal(MAX_RETRY_AFTER_SECONDS, 300);
  assert.equal(parseRetryAfter('15'), 15);
  assert.equal(parseRetryAfter('0'), MIN_RETRY_AFTER_SECONDS);
  assert.equal(resolveMaxFailoverAttempts({}), 3);
  assert.equal(classifyUpstreamStatus(429).retryable, true);
  assert.equal(classifyUpstreamStatus(500).retryable, true);
  assert.equal(classifyUpstreamStatus(400).retryable, false);
});
