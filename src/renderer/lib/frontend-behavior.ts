export type HydrationState = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string };
export type HydrationAction = { type: 'resolve' } | { type: 'retry' } | { type: 'reject'; message: string };
export function reduceHydration(_state: HydrationState, action: HydrationAction): HydrationState { return action.type === 'resolve' ? { state: 'ready' } : action.type === 'reject' ? { state: 'error', message: action.message } : { state: 'loading' }; }
export function acceptLatestSequence(latestStarted: number, completed: number): boolean { return completed === latestStarted; }
export function mutationFailure(kind: string, error: unknown, unknownLabel: string) { return { kind, message: error instanceof Error && error.message ? error.message : unknownLabel }; }
export function isNearBottom(metrics: { scrollTop: number; clientHeight: number; scrollHeight: number }, threshold = 48): boolean { return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold; }
export function shouldCancelAutoScroll(metrics: { scrollTop: number; clientHeight: number; scrollHeight: number; programmatic: boolean }, threshold = 48): boolean { if (metrics.programmatic) return false; return !isNearBottom(metrics, threshold); }

export function classifyScrollEvent(prevTop: number, nextTop: number, programmatic: boolean, scrollHeight: number, clientHeight: number, threshold = 48): 'user-up' | 'programmatic' | 'settle' {
  const nearBottom = scrollHeight - clientHeight - nextTop <= threshold;
  if (nearBottom) return 'settle';
  if (nextTop < prevTop) return 'user-up';
  if (programmatic) return 'programmatic';
  return 'settle';
}
export function selectRecommendedPort(input: { changeMode: boolean; currentPort: number; currentPairAvailable: boolean | null; recommendedPort: number | null }): string { return !input.changeMode && input.recommendedPort !== null && input.currentPairAvailable !== true ? String(input.recommendedPort) : String(input.currentPort); }
export function reduceMenu(open: boolean, action: { type: 'toggle' | 'close' | 'escape' }): boolean { return action.type === 'toggle' ? !open : false; }

function isGatewayUnavailableForPolicy(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof Error) {
    if (error.name === "GATEWAY_NOT_RUNNING") return true;
    if ((error as Error & { code?: string }).code === "ECONNRESET") return true;
    if ((error as Error & { code?: string }).code === "ECONNREFUSED") return true;
    if (error.message && error.message.includes("Gateway is not running.")) return true;
  }
  return false;
}

export function createLogsQueryPolicy(paused: boolean): {
  refetchInterval: number | false;
  refetchOnWindowFocus: boolean;
  refetchOnReconnect: boolean;
  retry: boolean;
} {
  if (paused) return { refetchInterval: false, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false };
  return { refetchInterval: 2000, refetchOnWindowFocus: false, refetchOnReconnect: true, retry: true };
}

export function createDashboardKeysQueryPolicy(): {
  refetchInterval: number | false;
  refetchOnWindowFocus: boolean;
  refetchOnReconnect: boolean;
  retry: (failureCount: number, error: unknown) => boolean;
} {
  return {
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    retry: (_failureCount, error) => !isGatewayUnavailableForPolicy(error)
  };
}

export class GatewayLifecycleGenerationTracker {
  private generation = 0;
  private pendingError: { error: unknown; generation: number } | null = null;

  advance(): void {
    this.generation += 1;
    this.pendingError = null;
  }

  observeError(error: unknown): void {
    this.pendingError = { error, generation: this.generation };
  }

  hasFreshError(): boolean {
    return this.pendingError !== null && this.pendingError.generation === this.generation;
  }

  shouldShowAvailableOverlay(gatewayRunningNow: boolean): boolean {
    if (gatewayRunningNow && this.pendingError !== null && this.pendingError.generation === this.generation) return false;
    return gatewayRunningNow && !this.hasFreshError();
  }
}
