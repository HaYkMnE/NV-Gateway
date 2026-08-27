export interface IpcErrorLog extends Record<string, unknown> {
  handler: string;
  message: string;
  stack: string | null;
}

export function wrapIpcHandler<T extends (...args: unknown[]) => unknown>(
  name: string,
  handler: T,
  logError: (entry: IpcErrorLog) => void
): T {
  return (async (...args: unknown[]) => {
    try {
      return await handler(...args);
    } catch (error) {
      logError({
        handler: name,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack ?? null : null
      });
      throw error;
    }
  }) as T;
}
