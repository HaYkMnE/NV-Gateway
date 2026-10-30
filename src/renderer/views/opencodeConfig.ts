// OpenCode custom-provider config emitted by the Endpoint view's OpenCode tab.
// Shape follows https://opencode.ai/docs/providers/#custom-provider and the
// README "OpenCode" block exactly: provider.<id>.{npm, name, options, models},
// with models keyed by model id.
//
// Per-model metadata (owner defect): a copied config without `limit` makes
// OpenCode register an unknown context/output window, and without
// `reasoning.supported` it registers no reasoning variants. Both are emitted
// from the gateway's REAL model metadata only:
//   - `limit: { context, output }` only when BOTH values are known; a missing
//     side is never fabricated (a guessed window is worse than none);
//   - `reasoning: { supported: true }` only when the model really reports
//     reasoning support. A `false`/absent capability emits nothing, so the
//     provider's default applies.
export interface OpenCodeModelMeta {
  id: string;
  name?: string | null;
  context_length?: number | null;
  max_completion_tokens?: number | null;
  capabilities?: { reasoning?: { supported?: boolean | null } | null } | null;
}

/** A positive integer token count, or null when the value is not usable. */
function tokenCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * Literal placeholders a copied snippet must never contain.
 *
 * SCOPE: only markers that actually ship today. `<model-id>` is emitted by
 * Endpoint when no model is known. Angle-bracket credential literals such as
 * `<your-token>` are NOT handled, because no generator emits one — the token
 * is either interpolated or reached indirectly (Zed/Codex via env var), and a
 * missing token is caught by the `embedsToken` rule below. If a generator ever
 * starts emitting such a literal, add it here (or switch to a generic
 * `<[a-z][a-z-]*>` match) rather than relying on this list being exhaustive.
 */
export const UNRESOLVED_MARKERS: readonly string[] = ['<model-id>'];

/**
 * Whether composed snippet text is unusable and must not be copied.
 *
 * The empty-token rule applies ONLY to content that embeds the token
 * (`embedsToken`): the base URLs and a real model id are perfectly copyable
 * while the credentials fetch is failing, and refusing them (with a message
 * about a missing token) was wrong. The `<model-id>` placeholder is always
 * refused, wherever it appears. Pure so the view can disable Copy without a DOM.
 */
export function hasUnresolvedPlaceholder(
  content: string,
  token: string,
  options: { embedsToken: boolean } = { embedsToken: true },
): boolean {
  if (UNRESOLVED_MARKERS.some((marker) => content.includes(marker))) return true;
  return options.embedsToken && token.length === 0;
}

/** Per-model OpenCode entry: name plus only the metadata that is actually known. */
function modelEntry(m: OpenCodeModelMeta): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: m.name ?? m.id };
  const context = tokenCount(m.context_length);
  const output = tokenCount(m.max_completion_tokens);
  if (context !== null && output !== null) entry.limit = { context, output };
  if (m.capabilities?.reasoning?.supported === true) entry.reasoning = { supported: true };
  return entry;
}

export function buildOpenCodeConfig(
  baseUrl: string,
  gatewayToken: string,
  models: ReadonlyArray<OpenCodeModelMeta>
): string {
  return JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        'nvidia-gateway': {
          npm: '@ai-sdk/openai-compatible',
          name: 'NV-Gateway',
          options: { baseURL: baseUrl, apiKey: gatewayToken },
          models: Object.fromEntries(models.map((m) => [m.id, modelEntry(m)])),
        },
      },
    },
    null,
    2
  );
}
