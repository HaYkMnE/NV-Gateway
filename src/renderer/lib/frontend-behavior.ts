export type HydrationState = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string };
export type HydrationAction = { type: 'resolve' } | { type: 'retry' } | { type: 'reject'; message: string };
export function reduceHydration(_state: HydrationState, action: HydrationAction): HydrationState { return action.type === 'resolve' ? { state: 'ready' } : action.type === 'reject' ? { state: 'error', message: action.message } : { state: 'loading' }; }
export function acceptLatestSequence(latestStarted: number, completed: number): boolean { return completed === latestStarted; }
export function mutationFailure(kind: string, error: unknown, unknownLabel: string) { return { kind, message: error instanceof Error && error.message ? error.message : unknownLabel }; }
export function isNearBottom(metrics: { scrollTop: number; clientHeight: number; scrollHeight: number }, threshold = 48): boolean { return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold; }
// Decides whether a scroll event should cancel autoscroll. The effect that
// streams new logs fires a programmatic smooth (or reduced-motion instant)
// scrollTo toward the bottom; Chromium emits scroll events *during* that
// animation whose scrollTop is past the old position but not yet within the
// isNearBottom threshold. Those intermediate events must NOT cancel autoscroll
// — only a genuine user scroll-up (programmatic=false, not near bottom) does.
export function shouldCancelAutoScroll(metrics: { scrollTop: number; clientHeight: number; scrollHeight: number; programmatic: boolean }, threshold = 48): boolean { if (metrics.programmatic) return false; return !isNearBottom(metrics, threshold); }

// Classifies a scroll event as a genuine user scroll-up, an effect-initiated
// programmatic step, or a near-bottom settle. Composed with the programmatic
// flag in Logs.trackScroll so the Round 70 short-circuit (a forward programmatic
// step never self-cancels) is preserved while a genuine user scroll-up DURING
// the 600ms programmatic window still disables follow.
//
// Direction-aware: a DECREASING scrollTop is a genuine user wheel/drag up
// (mouse wheels and scrollbar drags move opposite to the programmatic smooth
// jump toward the bottom) and must disable autoscroll immediately even while
// the programmatic flag is still true. Non-decreasing steps within the
// programmatic window are part of the effect-initiated smooth/instant jump
// (programmatic), and an arrival within the isNearBottom threshold settles
// the programmatic flag so the next genuine user scroll can cancel cleanly.
//
// Returns 'user-up' (disable autoscroll), 'programmatic' (do NOT cancel), or
// 'settle' (arrival near the bottom — clear the programmatic flag).
export function classifyScrollEvent(prevTop: number, nextTop: number, programmatic: boolean, scrollHeight: number, clientHeight: number, threshold = 48): 'user-up' | 'programmatic' | 'settle' {
  const nearBottom = scrollHeight - clientHeight - nextTop <= threshold;
  // Near-bottom arrival settles the programmatic flag regardless of direction.
  if (nearBottom) return 'settle';
  // A genuine user scroll-up: scrollTop decreased. This is real user intent
  // even while the programmatic flag is held true during the smooth-scroll
  // window — the effect's scrollTo only ever advances scrollTop toward the
  // bottom, so any decreasing step must be a user-initiated wheel/drag.
  if (nextTop < prevTop) return 'user-up';
  // Non-decreasing step while the programmatic flag is true: the effect's
  // smooth/instant forward jump. Keep the short-circuit (do NOT self-cancel).
  if (programmatic) return 'programmatic';
  // Outside the programmatic window, a non-decreasing step that is not near
  // the bottom is a settle arriving from an unrelated position — do not cancel.
  return 'settle';
}
export function selectRecommendedPort(input: { changeMode: boolean; currentPort: number; currentPairAvailable: boolean | null; recommendedPort: number | null }): string { return !input.changeMode && input.recommendedPort !== null && input.currentPairAvailable !== true ? String(input.recommendedPort) : String(input.currentPort); }
export function reduceMenu(open: boolean, action: { type: 'toggle' | 'close' | 'escape' }): boolean { return action.type === 'toggle' ? !open : false; }

/**
 * Inlined mirror of isGatewayUnavailable (frontend-state.ts).
 *
 * Inlined rather than imported because tsconfig.node.json's file list only
 * includes frontend-behavior.ts from the renderer lib; importing
 * frontend-state.ts would pull an unlisted file into that project and fail
 * `tsc -p tsconfig.node.json`. The canonical classifier remains exported from
 * frontend-state.ts for renderer code; this private copy keeps the node-side
 * build self-contained.
 */
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

  /** Advance the generation on a settled "running" status. Clear any stale pending error. */
  advance(): void {
    this.generation += 1;
    this.pendingError = null;
  }

  /** Record an error from the current generation. If a later arrival is an old error, ignore it. */
  observeError(error: unknown): void {
    this.pendingError = { error, generation: this.generation };
  }

  /** True iff the latest observed error is from the current generation. */
  hasFreshError(): boolean {
    return this.pendingError !== null && this.pendingError.generation === this.generation;
  }

  /** True iff there are no fresh errors and the gateway is now expected to be running. */
  shouldShowAvailableOverlay(gatewayRunningNow: boolean): boolean {
    if (gatewayRunningNow && this.pendingError !== null && this.pendingError.generation === this.generation) return false;
    return gatewayRunningNow && !this.hasFreshError();
  }
}
