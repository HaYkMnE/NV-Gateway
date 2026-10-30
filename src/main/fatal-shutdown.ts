export interface FatalShutdownOptions {
  stop: () => Promise<unknown>;
  exit: (code: number) => void;
  deadlineMs?: number;
  onFatalShutdown?: () => void;
}

export function createFatalShutdown(options: FatalShutdownOptions): () => Promise<void> {
  let shutdown: Promise<void> | null = null;
  return () => {
    if (shutdown) return shutdown;
    shutdown = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        try { options.onFatalShutdown?.(); } catch { /* diagnostics must not alter shutdown */ }
        await Promise.race([
          Promise.resolve().then(options.stop).catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, options.deadlineMs ?? 5_000);
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        options.exit(1);
      }
    })();
    return shutdown;
  };
}
