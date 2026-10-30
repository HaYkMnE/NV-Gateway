/**
 * NV-GATEWAY // Pet Autonomous State Machine (pure logic layer)
 *
 * Source of truth: nvgateway-donation-mockups/interactive-showcase.html
 * (sections: "1. DATA DEFINITIONS : ACTIVITIES & VIP MODES",
 *  "2. STATE OBJECT & PERSISTENT SESSION CHARACTER",
 *  "9. WINDOW VISIBILITY & ATTENTION-DRIVEN ACTIVITY ENGINE",
 *  "8. EMOTIONAL REACTION HANDLERS").
 *
 * This module contains ONLY the state machine logic:
 * character selection, activity pools & non-repeating cycling,
 * focus/visibility switching rules ("CAUGHT IN THE ACT").
 * No SVG markup or canvas rendering lives here — that belongs to the
 * component layer, which consumes this engine's callbacks.
 */

// ==========================================
// 1. TYPES
// ==========================================

export type PetCharacter = 'mascot' | 'hacker';

export type PetActivity =
  | 'bug-hunter'
  | 'low-battery'
  | 'turbine-generator'
  | 'sensor-polish'
  | 'model-juggler'
  | 'nano-coffee'
  | 'power-nap'
  | 'code-frenzy'
  | 'zero-errors'
  | 'empty-mug'
  | 'bug-slayer'
  | 'coin-drop'
  | 'flowchart'
  | 'terminal-nap';

export type VipActivity =
  | 'syndicate-salute'
  | 'espresso-toast'
  | 'fourth-wall-wink'
  | 'hyper-hack'
  | 'quantum-meditation';

// ==========================================
// 2. ACTIVITY POOLS (per character)
// ==========================================

export const MASCOT_ACTIVITIES: readonly PetActivity[] = [
  'bug-hunter',
  'low-battery',
  'turbine-generator',
  'sensor-polish',
  'model-juggler',
  'nano-coffee',
  'power-nap',
];

const HACKER_ACTIVITIES: readonly PetActivity[] = [
  'code-frenzy',
  'zero-errors',
  'empty-mug',
  'bug-slayer',
  'coin-drop',
  'flowchart',
  'terminal-nap',
];

/** Exclusive VIP idle behaviors (shared ids across both characters). */
export const VIP_ACTIVITIES: readonly VipActivity[] = [
  'syndicate-salute',
  'espresso-toast',
  'fourth-wall-wink',
  'hyper-hack',
  'quantum-meditation',
];

const CHARACTER_STORAGE_KEY = 'nv_pet_character';

type AnyActivity = PetActivity | VipActivity;

// ==========================================
// 3. ATTENTION-SWITCHING GUARDS
// ==========================================

/** Blur/focus flickers shorter than this never count as "user was away". */
export const MIN_AWAY_MS = 800;
/**
 * Minimum time between a focus-return activity switch and the last switch of
 * ANY kind (spec 2026-10-26 §1.2: 30 s -> 5 s). Guarantees the pet can never
 * rapid-fire even across genuine blur->focus sequences.
 */
export const SWITCH_COOLDOWN_MS = 5_000;
/**
 * Upper bound for the deferred attention-return work (requestIdleCallback
 * timeout). The return is run off the focus/visibilitychange task so showing
 * the window never blocks on audio scheduling or the activity switch.
 */
const RETURN_IDLE_TIMEOUT_MS = 200;

// ==========================================
// 3b. REST MODE (idle-CPU: pause decoration while nothing happens)
// ==========================================

/**
 * Rest starts this long after the last activity/event/interaction, counted
 * only while the window is visible and NOT focused (spec 2026-10-26 §1.1, §9.1).
 */
export const PET_REST_DELAY_MS = 60_000;
/** Deep rest (breathing paused too, only the blink runs) after this long, same rule. */
export const PET_DEEP_REST_DELAY_MS = 180_000;

export type PetRestLevel = 'awake' | 'rest' | 'deep';

export interface PetRestTimerOptions {
  onChange: (level: PetRestLevel) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  /**
   * Initial focus state. Default false keeps the pre-spec behaviour for
   * callers that never report focus (timers arm on wake). A focused window
   * never rests; report changes with focus()/blur().
   */
  initialFocused?: boolean;
}

export interface PetRestTimer {
  /** An activity/event started or the user interacted: leave rest, re-arm both timers (unless held or focused). */
  wake: () => void;
  /** Pointer entered the pet: stay awake, clear both timers until release(). */
  hold: () => void;
  /** Pointer left the pet: end the hold, then wake (the rest timer restarts if unfocused). */
  release: () => void;
  /** Hide/unmount: clear every timer and return to awake. */
  stop: () => void;
  /** Window gained focus (ALIVE): leave rest and clear both timers without arming. */
  focus: () => void;
  /** Window lost focus while visible (CALM): arm both timers (unless held or stopped). */
  blur: () => void;
  /** Whether the timer currently treats the window as focused. */
  isFocused: () => boolean;
  level: () => PetRestLevel;
}

export function createPetRestTimer(opts: PetRestTimerOptions): PetRestTimer {
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let level: PetRestLevel = 'awake';
  let restTimer: unknown = null;
  let deepTimer: unknown = null;
  /** Pointer is over the pet: no rest timer may run until release(). */
  let held = false;
  /** Focused window = ALIVE: rest never applies. */
  let focused = opts.initialFocused ?? false;
  /** stop() (hidden) until the next wake/hold/release/focus: blur() must not arm. */
  let stopped = false;

  const set = (next: PetRestLevel): void => {
    if (level === next) return;
    level = next;
    opts.onChange(next);
  };
  const clear = (): void => {
    if (restTimer !== null) clearTimer(restTimer);
    if (deepTimer !== null) clearTimer(deepTimer);
    restTimer = null;
    deepTimer = null;
  };

  const arm = (): void => {
    restTimer = setTimer(() => { restTimer = null; set('rest'); }, PET_REST_DELAY_MS);
    deepTimer = setTimer(() => { deepTimer = null; set('deep'); }, PET_DEEP_REST_DELAY_MS);
  };

  return {
    wake: () => {
      stopped = false;
      clear();
      set('awake');
      // An event during hover keeps the pet awake but must not re-arm the
      // timers the hover is holding off. A focused window never rests.
      if (!held && !focused) arm();
    },
    hold: () => {
      stopped = false;
      held = true;
      clear();
      set('awake');
    },
    release: () => {
      stopped = false;
      held = false;
      clear();
      set('awake');
      if (!focused) arm();
    },
    stop: () => {
      stopped = true;
      held = false;
      clear();
      set('awake');
    },
    focus: () => {
      stopped = false;
      focused = true;
      clear();
      set('awake');
    },
    blur: () => {
      if (focused === false && (restTimer !== null || level !== 'awake')) return; // already counting
      focused = false;
      if (held || stopped) return;
      clear();
      arm();
    },
    isFocused: () => focused,
    level: () => level,
  };
}

// ==========================================
// 3c. HOVER ACROSS HIDE/SHOW
// ==========================================

/**
 * After a show with the pet hovered at hide, the hold waits at most this long
 * for the first pointer event to report where the cursor really is, then
 * releases (the normal rest timer follows). Measured (main-process hide/show,
 * real cursor): with the cursor inside the window Chromium sends a trusted
 * pointermove at the real cursor 59–762 ms after the show (3 of 3 runs); with
 * the cursor outside the window (the tray-click case) no event arrives at all.
 * 2 s covers the slowest measured event with margin and bounds every
 * unconfirmed hold, so the pet can never be stuck awake.
 */
export const PET_HOVER_SHOW_PROBE_MS = 2_000;
/**
 * A mouseleave only counts once this long has passed without a hide.
 * Measured with main-process win.hide(): Chromium's mouseleave arrives in its
 * own task 184 ms BEFORE visibilitychange(hidden) (f12/measure5-diag), so a
 * one-task defer is not enough. Inside this window a hide cancels the leave;
 * 500 ms is far below the 60 s rest scale and not perceptible.
 */
export const PET_HIDE_LEAVE_GRACE_MS = 500;

export interface PetHoverTrackerOptions {
  rest: Pick<PetRestTimer, 'hold' | 'release' | 'wake' | 'stop'>;
  /** Whether the page is hidden right now (polled when a deferred leave runs). */
  isHidden: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface PetHoverTracker {
  /** mouseenter on the pet button. */
  enter: () => void;
  /** mouseleave on the pet button (applied after PET_HIDE_LEAVE_GRACE_MS; a hide cancels it). */
  leave: () => void;
  /** Page visibility changed (true = shown). */
  visibility: (visible: boolean) => void;
  /** A window pointermove after a show, hit-tested: is it over the pet button? */
  pointer: (overButton: boolean) => void;
  /** A hover hold is waiting for the first real pointer event (at most the probe). */
  awaitingPointer: () => boolean;
  /** Since the last show no real pointer event arrived (enter/leave are unconfirmed). */
  expectsPointer: () => boolean;
  /** Window pointermoves decide the hover state (from a show until a confirmed enter/leave). */
  tracksPointer: () => boolean;
  /** Unmount: clear the probe and any deferred leave. */
  dispose: () => void;
}

/**
 * Keeps the hover hold truthful across a window hide/show. Measured: Chromium
 * fires mouseleave on win.hide(), and after the show :hover stays false until
 * a pointer event arrives. So (1) a leave is applied after
 * PET_HIDE_LEAVE_GRACE_MS and dropped if the page is (or becomes) hidden, and
 * (2) after a show the hold stays only until the first pointer event decides
 * (hit-test on / off the pet), at most PET_HOVER_SHOW_PROBE_MS.
 */
export function createPetHoverTracker(opts: PetHoverTrackerOptions): PetHoverTracker {
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const { rest } = opts;
  let hovered = false;
  let awaiting = false;
  /**
   * True from a show until the first real pointer event. Measured: on show
   * Chromium re-hit-tests the LAST KNOWN pointer position and fires mouseenter
   * without any movement; that position may be stale, so such an enter keeps
   * the hold but never lifts the probe.
   */
  let unconfirmed = false;
  /**
   * True from a show until a confirmed (post-pointer-event) mouseenter or
   * mouseleave on the button. Measured (audit): after the probe released, the
   * window moved under the cursor; a trusted pointermove landed on the button
   * but NO mouseenter followed. So window pointermoves keep deciding while
   * tracking, not only during the 2 s probe.
   */
  let tracking = false;
  let pendingLeave: unknown = null;
  let probe: unknown = null;

  const cancelLeave = (): void => {
    if (pendingLeave !== null) clearTimer(pendingLeave);
    pendingLeave = null;
  };
  const endAwait = (): void => {
    awaiting = false;
    if (probe !== null) clearTimer(probe);
    probe = null;
  };
  const releaseNow = (): void => {
    endAwait();
    hovered = false;
    rest.release();
  };
  const armProbe = (): void => {
    awaiting = true;
    if (probe === null) probe = setTimer(() => { probe = null; releaseNow(); }, PET_HOVER_SHOW_PROBE_MS);
  };
  /**
   * Release after PET_HIDE_LEAVE_GRACE_MS unless a hide (or a move back onto
   * the pet) cancels it. restart=false keeps an already pending release, so a
   * stream of off-pet pointermoves cannot postpone the rest.
   */
  const scheduleRelease = (restart: boolean): void => {
    if (pendingLeave !== null) {
      if (!restart) return;
      cancelLeave();
    }
    pendingLeave = setTimer(() => {
      pendingLeave = null;
      if (opts.isHidden()) return;
      releaseNow();
    }, PET_HIDE_LEAVE_GRACE_MS);
  };

  return {
    enter: () => {
      cancelLeave();
      hovered = true;
      rest.hold();
      // Unconfirmed (post-show synthetic) enter: hold, but stay probed and
      // keep hit-testing. A confirmed enter hands the state to enter/leave.
      if (unconfirmed) {
        armProbe();
      } else {
        endAwait();
        tracking = false;
      }
    },
    leave: () => {
      if (opts.isHidden()) return; // leave caused by the hide itself
      if (!unconfirmed) tracking = false; // a confirmed leave takes over
      scheduleRelease(true);
    },
    visibility: (visible) => {
      if (!visible) {
        cancelLeave(); // a leave queued in the hide's own task is not real
        endAwait();
        tracking = false;
        rest.stop();
        return;
      }
      unconfirmed = true;
      tracking = true;
      if (!hovered) {
        rest.wake();
        return;
      }
      rest.hold();
      armProbe();
    },
    pointer: (overButton) => {
      if (!tracking) return; // enter/leave own the state
      unconfirmed = false;
      if (overButton) {
        // On the pet: same effect as a fresh enter (also after the probe released).
        cancelLeave();
        endAwait();
        hovered = true;
        rest.hold();
      } else if (awaiting) {
        releaseNow(); // first event after a show says "off the pet": release now
      } else if (hovered) {
        scheduleRelease(false); // off the pet after a re-hold: 500 ms grace, not postponed
      }
      // Off the pet and nothing held: ignored, so moves never re-arm the rest timer.
    },
    awaitingPointer: () => awaiting,
    expectsPointer: () => unconfirmed,
    tracksPointer: () => tracking,
    dispose: () => {
      cancelLeave();
      endAwait();
    },
  };
}

export interface PetEngineOptions {
  /** Dynamic VIP gate — consulted at every activity decision point. */
  isVip: () => boolean;
  /** Fired whenever the active activity changes. */
  onActivityChange: (a: AnyActivity) => void;
  /** Fired when the pet gets "CAUGHT IN THE ACT" on window refocus. */
  onCue: () => void;
  /** Injectable clock (default Date.now), for tests with fake timers. */
  now?: () => number;
  /** Injectable [0,1) random source (default Math.random). */
  random?: () => number;
}

/**
 * Optional side-channel hooks fired from the SAME listener set that drives
 * activity switching (single wiring path). Used e.g. by PetWidget to gate
 * ambient audio without attaching its own duplicate focus listeners.
 */
export interface AttentionHooks {
  /** Fired immediately on raw blur/hidden — even for sub-debounce flickers. */
  onAttentionLost?: () => void;
  /** Fired on any focus/visible return (genuine or flicker). */
  onAttentionGained?: () => void;
}

export interface PetEngine {
  /**
   * Returns the session character. First call rolls 50/50 mascot vs hacker
   * and persists it (sessionStorage `nv_pet_character`); subsequent calls are
   * stable until {@link resetSessionCharacter}.
   */
  pickSessionCharacter: () => PetCharacter;
  /** Explicitly re-roll the persisted character (50/50) and persist it. */
  resetSessionCharacter: () => void;
  /** Current active activity id. */
  getActivity: () => AnyActivity;
  /** Force a specific activity. */
  setActivity: (a: AnyActivity) => void;
  /** Switch to a uniformly random activity, never repeating the previous one. */
  nextRandomActivity: () => AnyActivity;
  /**
   * Attention-return handler: if the window was away/blurred, seamlessly
   * cross-fades to the next random activity and fires the
   * "CAUGHT IN THE ACT" cue. No-op if the user never left.
   */
  onWindowFocus: () => void;
  /**
   * Wires window focus/blur + document visibilitychange listeners — the ONLY
   * attention listener path for this engine. The listeners themselves never
   * switch while focused (the 18-30 s dwell comes from createActivityTimer,
   * driven by the caller); a focus-return switch is armed by blur/hidden and
   * executed by focus/visible, subject to two guards:
   *   1. Flicker debounce: blur/focus pairs shorter than MIN_AWAY_MS (~800ms,
   *      e.g. Electron menu/modal focus steals) never trigger a switch.
   *   2. Dwell cooldown: automatic switches happen at most once per
   *      SWITCH_COOLDOWN_MS (5 s), even across genuine focus returns.
   * `hooks` receive raw attention transitions (audio gating etc.).
   * Returns a disposer that removes the listeners.
   */
  attachFocusListeners: (targetWindow: Window, hooks?: AttentionHooks) => () => void;
  /** Whether the pet is currently armed to switch on next focus return. */
  isAway: () => boolean;
}

// ==========================================
// 3. HELPERS
// ==========================================

function readStoredCharacter(): PetCharacter | null {
  try {
    const saved = sessionStorage.getItem(CHARACTER_STORAGE_KEY);
    if (saved === 'mascot' || saved === 'hacker') return saved;
  } catch {
    /* storage unavailable — fall through to roll */
  }
  return null;
}

function persistCharacter(c: PetCharacter): void {
  try {
    sessionStorage.setItem(CHARACTER_STORAGE_KEY, c);
    try {
      localStorage.removeItem(CHARACTER_STORAGE_KEY);
    } catch {
      /* ignore legacy cleanup failure if localStorage unavailable */
    }
  } catch {
    /* storage unavailable — keep in-memory value only */
  }
}

function rollCharacter(random: () => number): PetCharacter {
  // Cold-load roll: 50% Cyber Mascot vs 50% Pixel Hacker
  return random() < 0.5 ? 'mascot' : 'hacker';
}

/** Uniform integer in [min, max] from a [0,1) random source. */
function uniformMs(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

// ==========================================
// 3d. SHUFFLE BAG (spec 2026-10-26 §1.2)
// ==========================================

export interface ShuffleBag<T> {
  /**
   * Next item from `pool`: every item once per bag, never equal to `avoid`
   * (the current activity) when the pool has more than one item. A different
   * pool (VIP toggle, character re-roll) starts a fresh bag.
   */
  draw: (pool: readonly T[], avoid: T | null) => T;
  /** Items left in the current bag. */
  remaining: () => number;
}

export function createShuffleBag<T>(random: () => number = Math.random): ShuffleBag<T> {
  let bag: T[] = [];
  let source: readonly T[] | null = null;

  const refill = (pool: readonly T[], avoid: T | null): void => {
    bag = pool.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    // The first item of a new bag must differ from the last one played.
    if (bag.length > 1 && bag[0] === avoid) {
      const j = 1 + Math.floor(random() * (bag.length - 1));
      [bag[0], bag[j]] = [bag[j], bag[0]];
    }
  };

  return {
    draw: (pool, avoid) => {
      if (pool.length === 0) throw new Error('empty activity pool');
      if (source !== pool) {
        source = pool;
        bag = [];
      }
      if (bag.length === 0) refill(pool, avoid);
      if (pool.length > 1 && bag[0] === avoid) {
        // `avoid` was forced in mid-bag (setActivity): skip it this bag.
        bag.shift();
        if (bag.length === 0) refill(pool, avoid);
      }
      return bag.shift() as T;
    },
    remaining: () => bag.length,
  };
}

// ==========================================
// 3e. ACTIVITY DWELL TIMER (spec 2026-10-26 §1.2)
// ==========================================

/** Each activity lasts a uniform random dwell of ALIVE time. */
export const ACTIVITY_DWELL_MIN_MS = 18_000;
export const ACTIVITY_DWELL_MAX_MS = 30_000;

export interface PausableTimerOptions {
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  /** Clock for remainingMs/pause bookkeeping (default Date.now). */
  now?: () => number;
  /** [0,1) random source for the delays (default Math.random). */
  random?: () => number;
}

export interface ActivityTimerOptions extends PausableTimerOptions {
  /** The dwell ended: switch to the next activity. The timer re-arms itself after it. */
  onDue: () => void;
}

export interface PausableTimer {
  /** (Re)start with a fresh random delay (ALIVE entry, focus-return switch). */
  start: () => void;
  /** CALM / JOY / HINT / CELEBRATION: clear the timer, keep the remaining time. */
  pause: () => void;
  /** Back to ALIVE: continue the kept time, at least `minMs` (e.g. 3 s after a modal). */
  resume: (minMs?: number) => void;
  /** HIDDEN / unmount: clear the timer and forget the remaining time. */
  stop: () => void;
  /** Remaining time, or null when stopped. */
  remainingMs: () => number | null;
  running: () => boolean;
}

interface TimerCore {
  arm: (ms: number) => void;
  clear: () => void;
  remaining: () => number | null;
  isRunning: () => boolean;
  keep: (ms: number | null) => void;
  kept: () => number | null;
}

function createTimerCore(opts: PausableTimerOptions, fire: () => void): TimerCore {
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const now = opts.now ?? (() => Date.now());
  let id: unknown = null;
  let dueAt = 0;
  let pausedRemaining: number | null = null;
  const clear = (): void => {
    if (id !== null) clearTimer(id);
    id = null;
  };
  return {
    arm: (ms) => {
      clear();
      pausedRemaining = null;
      dueAt = now() + ms;
      id = setTimer(() => { id = null; fire(); }, ms);
    },
    clear,
    remaining: () => (id !== null ? Math.max(0, dueAt - now()) : pausedRemaining),
    isRunning: () => id !== null,
    keep: (ms) => { pausedRemaining = ms; },
    kept: () => pausedRemaining,
  };
}

/** One setTimeout at a time; no setInterval (spec §7). */
export function createActivityTimer(opts: ActivityTimerOptions): PausableTimer {
  const random = opts.random ?? Math.random;
  const dwell = (): number => uniformMs(random, ACTIVITY_DWELL_MIN_MS, ACTIVITY_DWELL_MAX_MS);
  const core: TimerCore = createTimerCore(opts, () => {
    core.arm(dwell());
    opts.onDue();
  });
  return {
    start: () => core.arm(dwell()),
    pause: () => {
      if (!core.isRunning()) return;
      const left = core.remaining();
      core.clear();
      core.keep(left);
    },
    resume: (minMs = 0) => {
      if (core.isRunning()) return;
      const left = core.kept();
      core.arm(left === null ? dwell() : Math.max(left, minMs));
    },
    stop: () => { core.clear(); core.keep(null); },
    remainingMs: () => core.remaining(),
    running: () => core.isRunning(),
  };
}

// ==========================================
// 3f. MICRO-ACTIONS (spec 2026-10-26 §1.3, §1.4)
// ==========================================

/** A micro-action fires every uniform random gap of ALIVE time, from the end of the previous one. */
export const MICRO_MIN_MS = 4_000;
export const MICRO_MAX_MS = 7_000;
/** No micro within this long after an activity change. */
export const MICRO_AFTER_SWITCH_QUIET_MS = 1_500;
/** No micro when less than this remains before the next activity change. */
export const MICRO_BEFORE_SWITCH_QUIET_MS = 3_000;

/** Mascot ids M1..M7 (CSS `nv-pet-micro-<id>`, drift moves `.m-station`). */
export type MascotMicro = 'drift' | 'hop' | 'look-l' | 'look-r' | 'roll' | 'dip' | 'peek';
/** Hacker ids H1..H7 (`PixelHackerRenderer.setMicro`). */
export type HackerMicro = 'look' | 'chair-sway' | 'stretch' | 'wave' | 'lean' | 'chair-hop' | 'roll';
export type PetMicro = MascotMicro | HackerMicro;

/** Drift stations in viewBox units (§1.3: keeps both claws inside 0..130). */
export const MASCOT_STATIONS: readonly number[] = [-10, 0, 10];

const MASCOT_MICRO_WEIGHT: Readonly<Record<MascotMicro, number>> = {
  drift: 3, hop: 2, 'look-l': 2, 'look-r': 2, roll: 0.5, dip: 1.5, peek: 1,
};
const MASCOT_MICRO_MS: Readonly<Record<MascotMicro, number>> = {
  drift: 1400, hop: 520, 'look-l': 1100, 'look-r': 1100, roll: 900, dip: 700, peek: 900,
};
const HACKER_MICRO_WEIGHT: Readonly<Record<HackerMicro, number>> = {
  look: 2, 'chair-sway': 2, stretch: 1.5, wave: 1, lean: 1.5, 'chair-hop': 1.5, roll: 2,
};
const HACKER_MICRO_MS: Readonly<Record<HackerMicro, number>> = {
  look: 1000, 'chair-sway': 900, stretch: 1000, wave: 900, lean: 800, 'chair-hop': 600, roll: 1600,
};

const ALL_MASCOT: readonly MascotMicro[] = ['drift', 'hop', 'look-l', 'look-r', 'roll', 'dip', 'peek'];
const ALL_HACKER: readonly HackerMicro[] = ['look', 'chair-sway', 'stretch', 'wave', 'lean', 'chair-hop', 'roll'];
const HACKER_VIP: readonly HackerMicro[] = ['look', 'chair-sway', 'lean', 'chair-hop', 'roll'];

/** Allowed micros per activity: the §1.4 table "Added by this spec". */
const MICRO_ALLOWED: Readonly<Record<AnyActivity, readonly PetMicro[]>> = {
  'bug-hunter': ALL_MASCOT,
  'low-battery': ['drift', 'dip'],
  'turbine-generator': ALL_MASCOT,
  'sensor-polish': ['drift', 'hop', 'look-l', 'look-r', 'dip', 'peek'],
  'model-juggler': ALL_MASCOT,
  'nano-coffee': ALL_MASCOT,
  'power-nap': ['drift', 'dip'],
  'code-frenzy': ['look', 'chair-sway', 'lean', 'chair-hop', 'roll'],
  'zero-errors': ['look', 'chair-sway', 'roll'],
  'empty-mug': ['chair-sway', 'lean', 'chair-hop', 'roll'],
  'bug-slayer': ['chair-sway', 'lean', 'chair-hop', 'roll'],
  'coin-drop': ALL_HACKER,
  flowchart: ALL_HACKER,
  'terminal-nap': ['chair-sway'],
  // VIP ids are shared: the character decides which list applies.
  'syndicate-salute': ALL_MASCOT,
  'espresso-toast': ALL_MASCOT,
  'fourth-wall-wink': ALL_MASCOT,
  'hyper-hack': ALL_MASCOT,
  'quantum-meditation': ALL_MASCOT,
};

const isVipActivity = (a: AnyActivity): boolean => (VIP_ACTIVITIES as readonly string[]).includes(a);

/** Micro-actions allowed for this character + activity (§1.3, §1.4). */
export function allowedMicros(character: PetCharacter, activity: AnyActivity): readonly PetMicro[] {
  if (isVipActivity(activity)) return character === 'mascot' ? ALL_MASCOT : HACKER_VIP;
  const list = MICRO_ALLOWED[activity] ?? [];
  const own: readonly string[] = character === 'mascot' ? ALL_MASCOT : ALL_HACKER;
  return list.filter((m) => own.includes(m));
}

/** Weight of a micro for this character + activity (flowchart: stretch/wave/roll ×2). */
export function microWeight(character: PetCharacter, activity: AnyActivity, id: PetMicro): number {
  if (character === 'mascot') return MASCOT_MICRO_WEIGHT[id as MascotMicro] ?? 0;
  const base = HACKER_MICRO_WEIGHT[id as HackerMicro] ?? 0;
  return activity === 'flowchart' && (id === 'stretch' || id === 'wave' || id === 'roll') ? base * 2 : base;
}

/** Duration of one micro beat (mascot drift is slow in power-nap / low-battery). */
export function microDurationMs(character: PetCharacter, activity: AnyActivity, id: PetMicro): number {
  if (character === 'mascot') {
    if (id === 'drift' && (activity === 'power-nap' || activity === 'low-battery')) return 2400;
    return MASCOT_MICRO_MS[id as MascotMicro] ?? 0;
  }
  return HACKER_MICRO_MS[id as HackerMicro] ?? 0;
}

/**
 * Weighted pick, never `prev` while another candidate exists.
 * Returns null when the activity allows no micro.
 */
export function pickMicro(
  character: PetCharacter,
  activity: AnyActivity,
  prev: PetMicro | null,
  random: () => number = Math.random,
): PetMicro | null {
  let candidates = allowedMicros(character, activity);
  if (candidates.length > 1 && prev !== null) candidates = candidates.filter((m) => m !== prev);
  if (candidates.length === 0) return null;
  const weights = candidates.map((m) => microWeight(character, activity, m));
  const total = weights.reduce((s, w) => s + w, 0);
  let r = random() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r < 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

export interface PetMicroEvent {
  id: PetMicro;
  durationMs: number;
  /** Mascot drift only: the target station (one of MASCOT_STATIONS). */
  station?: number;
}

export interface MicroSchedulerOptions extends PausableTimerOptions {
  character: () => PetCharacter;
  activity: () => AnyActivity;
  onMicro: (event: PetMicroEvent) => void;
  /** Called when a beat ends (current() becomes null). */
  onMicroEnd?: (id: PetMicro) => void;
  /** Time left before the next activity change (the activity timer), or null if unknown. */
  activityRemainingMs?: () => number | null;
  /** JOY / HINT / CELEBRATION / crossfade in progress: skip. */
  isBlocked?: () => boolean;
}

export interface MicroScheduler extends PausableTimer {
  /** The micro running right now, or null between beats. */
  current: () => PetMicro | null;
  /** The last micro fired (the no-repeat anchor). */
  last: () => PetMicro | null;
  /** Mascot drift station (resets to 0 on every activity change). */
  station: () => number;
  /** An activity change happened: reset the station, start the 1.5 s quiet window. */
  notifyActivityChange: () => void;
}

export function createMicroScheduler(opts: MicroSchedulerOptions): MicroScheduler {
  const random = opts.random ?? Math.random;
  const now = opts.now ?? (() => Date.now());
  const gap = (): number => uniformMs(random, MICRO_MIN_MS, MICRO_MAX_MS);
  let current: PetMicro | null = null;
  let last: PetMicro | null = null;
  let station = 0;
  let lastSwitchAt = -Infinity;

  const skip = (): boolean => {
    if (opts.isBlocked?.()) return true;
    if (now() - lastSwitchAt < MICRO_AFTER_SWITCH_QUIET_MS) return true;
    const left = opts.activityRemainingMs?.() ?? null;
    return left !== null && left < MICRO_BEFORE_SWITCH_QUIET_MS;
  };

  const fire = (): void => {
    if (current !== null) {
      // The beat ended: the next gap is measured from here.
      const ended = current;
      current = null;
      opts.onMicroEnd?.(ended);
      core.arm(gap());
      return;
    }
    if (skip()) { core.arm(gap()); return; }
    const character = opts.character();
    const activity = opts.activity();
    const id = pickMicro(character, activity, last, random);
    if (id === null) { core.arm(gap()); return; }
    const durationMs = microDurationMs(character, activity, id);
    const event: PetMicroEvent = { id, durationMs };
    if (character === 'mascot' && id === 'drift') {
      const others = MASCOT_STATIONS.filter((s) => s !== station);
      station = others[Math.floor(random() * others.length)];
      event.station = station;
    }
    current = id;
    last = id;
    opts.onMicro(event);
    core.arm(durationMs);
  };
  const core: TimerCore = createTimerCore(opts, fire);

  const endBeat = (): void => {
    if (current === null) return;
    const ended = current;
    current = null;
    opts.onMicroEnd?.(ended);
  };

  return {
    start: () => { endBeat(); core.arm(gap()); },
    pause: () => {
      if (!core.isRunning()) return;
      // A paused beat is cut short; resuming waits a full gap.
      const wasBeat = current !== null;
      const left = core.remaining();
      core.clear();
      endBeat();
      core.keep(wasBeat ? null : left);
    },
    resume: (minMs = 0) => {
      if (core.isRunning()) return;
      const left = core.kept();
      core.arm(left === null ? gap() : Math.max(left, minMs));
    },
    stop: () => { core.clear(); core.keep(null); endBeat(); },
    remainingMs: () => core.remaining(),
    running: () => core.isRunning(),
    current: () => current,
    last: () => last,
    station: () => station,
    notifyActivityChange: () => {
      lastSwitchAt = now();
      station = 0;
    },
  };
}

// ==========================================
// 4. ENGINE FACTORY
// ==========================================

export function createPetEngine(opts: PetEngineOptions): PetEngine {
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  let character: PetCharacter = readStoredCharacter() ?? rollCharacter(random);
  if (readStoredCharacter() === null) persistCharacter(character);

  let currentActivity: AnyActivity =
    character === 'mascot' ? MASCOT_ACTIVITIES[0] : HACKER_ACTIVITIES[0];
  let wasAway = false;
  /** Timestamp of the last observed attention loss (blur/hidden). */
  let awaySinceMs = -1;
  /** Timestamp of the last activity switch of any kind (dwell anchor). */
  let lastSwitchAtMs = now();
  const bag = createShuffleBag<AnyActivity>(random);

  const standardPool = (): readonly PetActivity[] =>
    character === 'mascot' ? MASCOT_ACTIVITIES : HACKER_ACTIVITIES;

  const commit = (next: AnyActivity): void => {
    currentActivity = next;
    lastSwitchAtMs = now();
    opts.onActivityChange(next);
  };

  // Shuffle bag (spec §1.2): VIP mode draws from the 5 VIP behaviors, standard
  // mode from the character's 7; never the current activity next.
  const pickNextRandom = (): AnyActivity =>
    bag.draw(opts.isVip() ? VIP_ACTIVITIES : standardPool(), currentActivity);

  const engine: PetEngine = {
    pickSessionCharacter: () => character,

    resetSessionCharacter: () => {
      character = rollCharacter(random);
      persistCharacter(character);
      // Standard pools differ per character — make sure the current
      // activity is still valid for the freshly rolled character.
      if (!opts.isVip()) {
        const pool = standardPool();
        if (!(pool as readonly string[]).includes(currentActivity)) {
          commit(pool[0]);
        }
      }
    },

    getActivity: () => currentActivity,

    setActivity: (a) => {
      commit(a);
    },

    nextRandomActivity: () => {
      const next = pickNextRandom();
      commit(next);
      return next;
    },

    onWindowFocus: () => {
      // Mockup rule: switch only when attention actually returned from away.
      if (!wasAway) return;
      wasAway = false;
      // Dwell cooldown: swallow genuine focus returns that arrive within the
      // minimum dwell window since the last switch (never rapid-fire).
      if (now() - lastSwitchAtMs < SWITCH_COOLDOWN_MS) return;
      const next = pickNextRandom();
      commit(next); // seamless cross-fade handled by the component layer
      opts.onCue(); // ✦ CAUGHT IN THE ACT!
    },

    attachFocusListeners: (targetWindow, hooks) => {
      /** Route a focus/visible return through debounce + the switch rule. */
      const handleReturn = (returnedAtMs: number): void => {
        hooks?.onAttentionGained?.();
        if (!wasAway) return; // focused all along — never switch
        const awayMs = returnedAtMs - awaySinceMs;
        if (awaySinceMs >= 0 && awayMs < MIN_AWAY_MS) {
          // Flicker (menu click, modal focus steal, alt-tab graze): consume
          // the armed state silently — no activity change, no cue.
          wasAway = false;
          return;
        }
        engine.onWindowFocus();
      };
      // Show-window freeze fix: the return work (ambient re-arm, activity
      // switch + its SFX, cue) runs AFTER the focus/visibilitychange task,
      // in an idle callback with a timeout fallback (or setTimeout 0). The
      // focus + visibilitychange pair of one show coalesces into one run;
      // the return timestamp is taken at the event, so the flicker debounce
      // measures the real away time.
      let pendingReturn: { id: number; idle: boolean } | null = null;
      const cancelReturn = (): void => {
        if (pendingReturn === null) return;
        if (pendingReturn.idle) targetWindow.cancelIdleCallback?.(pendingReturn.id);
        else targetWindow.clearTimeout(pendingReturn.id);
        pendingReturn = null;
      };
      const scheduleReturn = (): void => {
        if (pendingReturn !== null) return;
        const returnedAtMs = now();
        const run = (): void => {
          pendingReturn = null;
          handleReturn(returnedAtMs);
        };
        if (typeof targetWindow.requestIdleCallback === 'function') {
          pendingReturn = { id: targetWindow.requestIdleCallback(run, { timeout: RETURN_IDLE_TIMEOUT_MS }), idle: true };
        } else {
          pendingReturn = { id: targetWindow.setTimeout(run, 0), idle: false };
        }
      };

      const markAway = (): void => {
        cancelReturn();
        wasAway = true;
        awaySinceMs = now();
        hooks?.onAttentionLost?.();
      };

      const onBlur = (): void => {
        markAway();
      };
      const onFocus = (): void => {
        scheduleReturn();
      };
      const onVisibilityChange = (): void => {
        if (targetWindow.document.visibilityState === 'visible') {
          scheduleReturn();
        } else {
          markAway();
        }
      };

      targetWindow.addEventListener('focus', onFocus);
      targetWindow.addEventListener('blur', onBlur);
      targetWindow.document.addEventListener('visibilitychange', onVisibilityChange);

      return () => {
        cancelReturn();
        targetWindow.removeEventListener('focus', onFocus);
        targetWindow.removeEventListener('blur', onBlur);
        targetWindow.document.removeEventListener('visibilitychange', onVisibilityChange);
      };
    },

    isAway: () => wasAway,

  };

  return engine;
}
