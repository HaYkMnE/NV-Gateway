/**
 * Pure presentation helpers for the Models «Информация» drawer's technical rows.
 *
 * Extracted from Models.tsx so the formatter and the capability-row derivation
 * can be unit-tested: the repo has no jsdom and no @testing-library/react, so the
 * view cannot be rendered. The harness (tests/models-details-drawer.test.mjs,
 * mirroring tests/models-filter-controls.test.mjs) transpiles this file and runs
 * it in a bare `vm` context whose sandbox holds only { Error, exports, module },
 * so this module MUST stay free of imports.
 *
 * SOURCE OF TRUTH: the values handled here come verbatim from the gateway's
 * GET /admin/models (src/gateway/admin-api.mjs:312-314) through
 * src/main/models-ipc.ts mapModelCatalog. Nothing here invents a value: an
 * absent / hostile input yields null (row omitted) or an empty list.
 */

/**
 * Format a token count for display.
 *
 *   1000000 -> "1M"   131072 -> "131K"   4096 -> "4 096"
 *
 * Returns null for anything that is not a finite, non-negative integer, so the
 * caller omits the row instead of printing "NaN" or a fabricated default.
 *
 * Thresholds (chosen so the three brief cases round-trip exactly):
 *  - >= 1_000_000: millions, one decimal only when it adds information.
 *  - >= 10_000:    thousands, rounded ("131K", "64K").
 *  - otherwise:    plain digits with narrow-group spaces ("4 096").
 * The plain-space thousand grouping is intentional: it is locale neutral, unlike
 * toLocaleString, which would vary with the user's locale and make the unit
 * tests environment-dependent.
 */
export function formatTokenCount(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 0) return null;

  // Promote on the ROUNDED value: 999_950 rounds to 1000K, which must read "1M".
  const thousands = Math.round(value / 1_000);
  if (value >= 1_000_000 || thousands >= 1_000) {
    const millions = value / 1_000_000;
    // One decimal only when it adds information (1.5M, but 2M not 2.0M).
    const rounded = Math.round(millions * 10) / 10;
    // Same promote-on-rounded rule one tier up: 999_950_000 must read "1B", not "1000M".
    if (value >= 1_000_000_000 || rounded >= 1_000) {
      const billions = Math.round((value / 1_000_000_000) * 10) / 10;
      // And once more: 999_950_000_000 must read "1T", not "1000B".
      if (value >= 1_000_000_000_000 || billions >= 1_000) {
        const trillions = Math.round((value / 1_000_000_000_000) * 10) / 10;
        // No tier above T: a value that would read "1000T" or more is not a
        // real token count, so the row is omitted (as for Infinity).
        if (trillions >= 1_000) return null;
        return `${Number.isInteger(trillions) ? trillions : trillions.toFixed(1)}T`;
      }
      return `${Number.isInteger(billions) ? billions : billions.toFixed(1)}B`;
    }
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}M`;
  }
  if (value >= 10_000) {
    return `${thousands}K`;
  }
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Format a popularity count for display.
 *
 *   1500 -> "2K"   2_500_000 -> "2.5M"   0 -> "0"
 *
 * Strict on purpose, like formatTokenCount: a non-finite or negative count is
 * not a value we have, so null is returned and the caller omits the row rather
 * than printing "NaN" / "InfinityM".
 */
export function formatPopularity(pop?: number | null): string | null {
  // Strict on purpose, like formatTokenCount: a non-finite or negative count is
  // not a value we have, so the row is omitted instead of printing "NaN"/"-5".
  if (typeof pop !== 'number' || !Number.isFinite(pop) || pop < 0) return null;
  // Promote on the ROUNDED value, so 999_600 reads "1M" (not "1000K"),
  // 1_049_999 reads "1M" (not "1.0M") and 9_999_999 reads "10M" (not "10.0M").
  const thousands = Math.round(pop / 1_000);
  if (pop >= 1_000_000 || thousands >= 1_000) {
    const millions = pop / 1_000_000;
    // Promote on the ROUNDED value one tier up too: 999_950_000 reads "1B", not "1000M".
    if (pop >= 1_000_000_000 || Math.round(millions) >= 1_000) {
      const billions = pop / 1_000_000_000;
      // And once more: 999_950_000_000 reads "1T", not "1000B".
      if (pop >= 1_000_000_000_000 || Math.round(billions) >= 1_000) {
        const trillions = pop / 1_000_000_000_000;
        // No tier above T: a count that would read "1000T" or more is omitted (as for Infinity).
        if (Math.round(trillions) >= 1_000) return null;
        const roundedT = Math.round(trillions * 10) / 10;
        if (roundedT >= 10) return `${Math.round(trillions)}T`;
        return `${Number.isInteger(roundedT) ? roundedT : roundedT.toFixed(1)}T`;
      }
      const roundedB = Math.round(billions * 10) / 10;
      if (roundedB >= 10) return `${Math.round(billions)}B`;
      return `${Number.isInteger(roundedB) ? roundedB : roundedB.toFixed(1)}B`;
    }
    const rounded = Math.round(millions * 10) / 10;
    // One decimal below 10M only when it adds information; whole millions from 10M.
    if (rounded >= 10) return `${Math.round(millions)}M`;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}M`;
  }
  // A fractional count must never print raw ("12.7"): round, and let a value
  // that rounds to 1000 (999.6) take the K tier.
  const whole = Math.round(pop);
  if (whole >= 1_000) return `${thousands}K`;
  return `${whole}`;
}

/**
 * The cURL preview for one model. Only the `$GATEWAY_TOKEN` placeholder is
 * emitted, never a real token. The model id is JSON-encoded into the body and
 * the whole body is POSIX single-quoted (`'` becomes `'\''`), so shell or JSON
 * metacharacters in an id cannot end the -d argument early.
 */
export function buildCurlSnippet(port: number, modelId: string): string {
  const body = `{
    "model": ${JSON.stringify(String(modelId))},
    "messages": [{"role": "user", "content": "Hello!"}]
  }`;
  return `curl http://127.0.0.1:${port}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $GATEWAY_TOKEN" \\
  -d '${body.replace(/'/g, "'\\''")}'`;
}

/**
 * Render an LLM Stats rank as `#8`, or null when the model is unranked.
 *
 * Strict on purpose: only a positive safe integer is a real position, so a
 * malformed payload (0, negative, NaN, a string) reads as "no ranking" instead
 * of gaining a fabricated top slot. null means "no genuine ranking", which the
 * drawer uses to OMIT the whole strength row rather than print a placeholder.
 */
export function formatStrengthRank(rank?: number | null): string | null {
  if (typeof rank !== 'number' || !Number.isSafeInteger(rank) || rank <= 0) return null;
  return `#${rank}`;
}

/**
 * Format an LLM Stats score for the strength row, or null when absent.
 *
 * The raw score is a float (e.g. 1287.4567); printing it verbatim garbles the
 * row and gets truncated. Rounded to at most one decimal — never more precision
 * than the source carries — and null for anything non-finite, so the caller
 * omits it rather than printing "NaN".
 */
export function formatScore(score?: number | null): string | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  return String(Math.round(score * 10) / 10);
}

/** One applicable capability row, ready for the drawer to render. */
export interface TechnicalCapability {
  id: 'reasoning' | 'vision' | 'tools';
  labelKey: string;
  controlKey?: string | null;
}

/**
 * Derive the capability rows the drawer may show from the gateway's
 * `capabilities` object (capability-registry.mjs:286-300):
 *
 *   { reasoning: { supported, modes[], controlKey, defaultMode }, tools, vision, audio }
 *
 * Rules:
 *  - `reasoning` yields a row ONLY when `reasoning.supported === true`; the
 *    row carries the control key when the gateway names one (null otherwise).
 *  - `vision` / `tools` yield rows only when their flag is exactly `true`.
 *  - `audio` is deliberately NOT a requested drawer row.
 *  - Anything absent or malformed yields an EMPTY list (no fabricated rows) —
 *    which also covers the gateway's cold-start window, where capabilities are
 *    empty for ~30-60 s after start.
 *
 * The order is stable (reasoning, vision, tools) so the rendered list cannot
 * reshuffle between renders.
 */
export function describeCapabilities(capabilities: unknown): TechnicalCapability[] {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return [];
  const caps = capabilities as {
    reasoning?: { supported?: unknown; controlKey?: unknown };
    tools?: unknown;
    vision?: unknown;
  };

  const rows: TechnicalCapability[] = [];

  if (caps.reasoning && typeof caps.reasoning === 'object' && caps.reasoning.supported === true) {
    const key = caps.reasoning.controlKey;
    rows.push({
      id: 'reasoning',
      labelKey: 'models_info_reasoning',
      controlKey: typeof key === 'string' && key.length > 0 ? key : null,
    });
  }
  if (caps.vision === true) {
    rows.push({ id: 'vision', labelKey: 'models_info_vision' });
  }
  if (caps.tools === true) {
    // Same term as the card/drawer tag (wave 6A F2): "Function Calling", not "Tools".
    rows.push({ id: 'tools', labelKey: 'tag_function_calling' });
  }

  return rows;
}
