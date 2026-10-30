export type DataState = 'loading' | 'empty' | 'error' | 'stale' | 'success';

export function validateGatewayPort(value: string | number): null | 'required' | 'integer' | 'range' {
  if (String(value).trim() === '') return 'required';
  const port = Number(value);
  if (!Number.isInteger(port)) return 'integer';
  return port >= 1 && port <= 65534 ? null : 'range';
}

export function classifyDataState(input: { pending: boolean; error: boolean; data?: unknown[]; stale?: boolean }): DataState {
  if (input.pending && input.data === undefined) return 'loading';
  if (input.error && input.data === undefined) return 'error';
  if (input.stale) return 'stale';
  if (!input.data?.length) return 'empty';
  return 'success';
}

/**
 * A list length that is only KNOWN when the data actually arrived.
 *
 * Returns `null` for an absent list (query still loading or errored — no data
 * yet), so the caller OMITS the value instead of printing a fabricated `0` (the
 * project rule is "no data → no value"). A list that genuinely arrived empty is
 * a KNOWN `0`, not an unknown — it returns 0 rather than null.
 *
 * Absence is checked with `== null` (loose), which is TRUE for BOTH `undefined`
 * and `null`: an explicit `null` is the same "we have no data" signal as a
 * missing property — the backend emits `null` for an unknown count — so it must
 * yield `null` as well. A strict `=== undefined` would have fallen through to
 * `data.length` and thrown `TypeError: Cannot read properties of null`.
 */
export function knownCount(data?: unknown[] | null): number | null {
  return data == null ? null : data.length;
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return items;
  const copy = [...items];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

export function isPlausibleNvidiaKey(value: string): boolean {
  const key = value.trim();
  return key.length >= 12 && key.length <= 8192 && /^[\x21-\x7e]+$/.test(key) && !key.includes('...');
}

export function safeError(error: unknown, unknownLabel: string): string {
  return error instanceof Error && error.message ? error.message : unknownLabel;
}

/**
 * Upper bound the main process enforces on a clipboard write. Mirrors
 * CLIPBOARD_TEXT_MAX in src/main/index.ts, which rejects `length > MAX` with the
 * deliberately generic "Invalid clipboard text." (generic on purpose: the payload
 * can be an NVIDIA API key or the local gateway token, so it is never echoed).
 * Because that message cannot name the cause, the renderer needs the same bound
 * to explain a size refusal itself.
 */
export const CLIPBOARD_TEXT_MAX = 1_000_000;

/**
 * Whether a payload of this length is one main will refuse for SIZE. Inclusive at
 * the cap, exactly like main: `length > MAX` rejects, so the cap itself is valid.
 */
export function isOversizedForClipboard(length: number): boolean {
  return length > CLIPBOARD_TEXT_MAX;
}

export function isGatewayUnavailable(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof Error) {
    if (error.name === "GATEWAY_NOT_RUNNING") return true;
    if ((error as Error & { code?: string }).code === "ECONNRESET") return true;
    if ((error as Error & { code?: string }).code === "ECONNREFUSED") return true;
    if (error.message && error.message.includes("Gateway is not running.")) return true;
  }
  return false;
}

export interface AddKeyMutationOptions {
  mutationFn: (key: string) => Promise<unknown>;
  onSettled?: () => void;
  isUnavailable?: (error: unknown) => boolean;
}

export function createAddKeyMutationOptions(options: AddKeyMutationOptions) {
  return {
    mutationFn: options.mutationFn,
    retry: false,
    onSettled: options.onSettled
  };
}
