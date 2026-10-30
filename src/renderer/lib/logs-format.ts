/**
 * Pure log-line formatting for the Logs view.
 *
 * Extracted from Logs.tsx so the formatter can be unit-tested against REAL
 * gateway records: the repo has no jsdom and no @testing-library/react, so
 * Logs.tsx cannot be rendered. The harness (tests/logs-line-format.test.mjs,
 * mirroring tests/models-filter-controls.test.mjs) transpiles this file and runs
 * it in a bare `vm` context whose sandbox holds only { Error, exports, module },
 * so this module MUST stay free of imports.
 */

/** One admin-API log record, as GET /admin/logs returns it. */
export type LogRecord = Record<string, unknown> & {
  level?: string;
  message?: string;
  timestamp?: string;
  time?: string;
};

/**
 * Render one record as a single terminal line.
 *
 * The latency field is `duration_ms`: that is what src/gateway/server.mjs emits
 * (lines 1396-1402 for a finished response and 1409-1416 for an aborted one) and
 * what src/gateway/logger.mjs passes through untouched. There is no producer of
 * a bare `duration` anywhere in src/.
 *
 * Every optional part is expressed as `... ? string : undefined` rather than
 * `cond && string`, and the final filter keeps ONLY non-empty strings and
 * numbers. Both halves matter: a `&&` guard evaluates to its falsy left side, so
 * a boolean `false` would otherwise reach `.map(String)` and be printed as the
 * word "false" on every record lacking that field. Filtering by type instead of
 * by `!== undefined` makes that failure mode unreachable for any part, present
 * or future, instead of only for the ones fixed by hand.
 */
export function formatLogLine(log: LogRecord): string {
  const parts: unknown[] = [
    log.timestamp ?? log.time,
    log.level !== undefined && log.level !== '' ? `[${String(log.level).toUpperCase()}]` : undefined,
    log.method,
    log.path,
    log.status,
    log.duration_ms !== undefined && log.duration_ms !== null ? `${String(log.duration_ms)}ms` : undefined,
    log.outcome,
    log.model,
    log.message,
  ];
  return parts
    .filter((value) => (typeof value === 'string' && value !== '') || typeof value === 'number')
    .map(String)
    .join(' ');
}
