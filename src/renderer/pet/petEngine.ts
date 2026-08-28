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
 * focus/visibility switching rules ("CAUGHT IN THE ACT"), affective states.
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

/** Affective overlay state. `nominal` = no affective override active. */
export type AffectiveState = 'nominal' | 'intent' | 'celebration' | 'patron';

// ==========================================
// 2. ACTIVITY POOLS (per character)
// ==========================================

const MASCOT_ACTIVITIES: readonly PetActivity[] = [
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
const VIP_ACTIVITIES: readonly VipActivity[] = [
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
const MIN_AWAY_MS = 800;
/**
 * Minimum dwell time between automatic (focus-return) activity switches,
 * measured from the last switch of ANY kind. Guarantees the pet can never
 * rapid-fire even across genuine blur->focus sequences.
 */
const SWITCH_COOLDOWN_MS = 30_000;

export interface PetEngineOptions {
  /** Dynamic VIP gate — consulted at every activity decision point. */
  isVip: () => boolean;
  /** Fired whenever the active activity changes. */
  onActivityChange: (a: AnyActivity) => void;
  /** Fired when the pet gets "CAUGHT IN THE ACT" on window refocus. */
  onCue: () => void;
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
  /** Force a specific activity (clears any affective override). */
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
   * attention listener path for this engine. While focused, the activity
   * NEVER changes on its own; switching is armed by blur/hidden and executed
   * by focus/visible, subject to two guards:
   *   1. Flicker debounce: blur/focus pairs shorter than MIN_AWAY_MS (~800ms,
   *      e.g. Electron menu/modal focus steals) never trigger a switch.
   *   2. Dwell cooldown: automatic switches happen at most once per
   *      SWITCH_COOLDOWN_MS (~30s), even across genuine focus returns.
   * `hooks` receive raw attention transitions (audio gating etc.).
   * Returns a disposer that removes the listeners.
   */
  attachFocusListeners: (targetWindow: Window, hooks?: AttentionHooks) => () => void;
  /** Whether the pet is currently armed to switch on next focus return. */
  isAway: () => boolean;
  /** Apply an affective overlay state ('nominal' clears the override). */
  setAffective: (s: AffectiveState) => void;
  /** Clear the affective overlay (back to nominal). */
  clearAffective: () => void;
  /** Current affective state. */
  getAffective: () => AffectiveState;
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

function rollCharacter(): PetCharacter {
  // Cold-load roll: 50% Cyber Mascot vs 50% Pixel Hacker
  return Math.random() < 0.5 ? 'mascot' : 'hacker';
}

/**
 * Uniformly random index in [0, length), never equal to `prev`
 * (mirrors the mockup's do/while non-repeat rule).
 */
function randomIndexExcept(prev: number, length: number): number {
  if (length <= 1) return 0;
  let next = prev;
  do {
    next = Math.floor(Math.random() * length);
  } while (next === prev);
  return next;
}

// ==========================================
// 4. ENGINE FACTORY
// ==========================================

export function createPetEngine(opts: PetEngineOptions): PetEngine {
  let character: PetCharacter = readStoredCharacter() ?? rollCharacter();
  if (readStoredCharacter() === null) persistCharacter(character);

  let currentActivity: AnyActivity = MASCOT_ACTIVITIES[0];
  let affective: AffectiveState = 'nominal';
  let wasAway = false;
  /** Timestamp of the last observed attention loss (blur/hidden). */
  let awaySinceMs = -1;
  /** Timestamp of the last activity switch of any kind (dwell anchor). */
  let lastSwitchAtMs = Date.now();

  const standardPool = (): readonly PetActivity[] =>
    character === 'mascot' ? MASCOT_ACTIVITIES : HACKER_ACTIVITIES;

  const commit = (next: AnyActivity): void => {
    currentActivity = next;
    // Mockup rule: every activity transition clears the emotional override.
    affective = 'nominal';
    lastSwitchAtMs = Date.now();
    opts.onActivityChange(next);
  };

  const pickNextRandom = (): AnyActivity => {
    if (opts.isVip()) {
      // In VIP mode, cycle through the 5 exclusive VIP behaviors.
      const prevIdx = VIP_ACTIVITIES.indexOf(currentActivity as VipActivity);
      const nextIdx = randomIndexExcept(prevIdx < 0 ? -1 : prevIdx, VIP_ACTIVITIES.length);
      return VIP_ACTIVITIES[nextIdx];
    }
    // In standard mode, cycle through the 7 activities of this character.
    const pool = standardPool();
    const prevIdx = pool.indexOf(currentActivity as PetActivity);
    // If the current activity doesn't belong to this pool, any index is fine.
    const nextIdx = randomIndexExcept(prevIdx < 0 ? -1 : prevIdx, pool.length);
    return pool[nextIdx];
  };

  const engine: PetEngine = {
    pickSessionCharacter: () => character,

    resetSessionCharacter: () => {
      character = rollCharacter();
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
      if (Date.now() - lastSwitchAtMs < SWITCH_COOLDOWN_MS) return;
      const next = pickNextRandom();
      commit(next); // seamless cross-fade handled by the component layer
      opts.onCue(); // ✦ CAUGHT IN THE ACT!
    },

    attachFocusListeners: (targetWindow, hooks) => {
      /** Route a focus/visible return through debounce + the switch rule. */
      const handleReturn = (): void => {
        hooks?.onAttentionGained?.();
        if (!wasAway) return; // focused all along — never switch
        const awayMs = Date.now() - awaySinceMs;
        if (awaySinceMs >= 0 && awayMs < MIN_AWAY_MS) {
          // Flicker (menu click, modal focus steal, alt-tab graze): consume
          // the armed state silently — no activity change, no cue.
          wasAway = false;
          return;
        }
        engine.onWindowFocus();
      };
      const markAway = (): void => {
        wasAway = true;
        awaySinceMs = Date.now();
        hooks?.onAttentionLost?.();
      };

      const onBlur = (): void => {
        markAway();
      };
      const onFocus = (): void => {
        handleReturn();
      };
      const onVisibilityChange = (): void => {
        if (targetWindow.document.visibilityState === 'visible') {
          handleReturn();
        } else {
          markAway();
        }
      };

      targetWindow.addEventListener('focus', onFocus);
      targetWindow.addEventListener('blur', onBlur);
      targetWindow.document.addEventListener('visibilitychange', onVisibilityChange);

      return () => {
        targetWindow.removeEventListener('focus', onFocus);
        targetWindow.removeEventListener('blur', onBlur);
        targetWindow.document.removeEventListener('visibilitychange', onVisibilityChange);
      };
    },

    isAway: () => wasAway,

    setAffective: (s) => {
      affective = s;
    },

    clearAffective: () => {
      affective = 'nominal';
    },

    getAffective: () => affective,
  };

  return engine;
}
