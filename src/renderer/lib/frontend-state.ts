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
