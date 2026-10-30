/**
 * PetWidget — NV-GATEWAY // autonomous desktop pet widget (dual-character host).
 *
 * Visual layer ported from nvgateway-donation-mockups/interactive-showcase.html:
 *   - Cyber Mascot kinematic SVG rig (chassis / neck bellow / head / arm rigs,
 *     claw pivots 16px 94px & 114px 94px, split thruster flames m-flame-left/right,
 *     props nested inside the claws, permanent-VIP shades/crown/halo/reactor,
 *     quantum ring stroke-dash animations)
 *   - Pixel Hacker Canvas 2D engine (160x152 backing store displayed at 80x76,
 *     pixelated; matrix rain, chair/desk/keyboard, hooded sprite, all activity
 *     sequences, VIP gold variants)
 *   - Widget chrome: patron badge, one-click sound toggle (localStorage
 *     `nv_pet_sound`), CAUGHT-IN-THE-ACT cue badge, thought cloud.
 *
 * Logic layer comes from ./petEngine (createPetEngine state machine +
 * attachFocusListeners attention rules) and ./audioEngine (petAudio procedural
 * SFX + ambient cadence). All styles are co-located in an inline <style> block
 * scoped under `.nv-pet-wrap` (same pattern as DonationModal).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Atom, BatteryLow, Boxes, Coffee, Coins, Crosshair, Crown, Fan, Glasses, Heart, Keyboard, Moon,
  PartyPopper, ScanEye, Sparkles, Swords, Trophy, Workflow, X, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, queryKeys } from '../lib/api';
import { useModal, type ModalRequest } from '../lib/modal-context';
import {
  dismissTipOccurrence, markTipShown, neverShowTip, nextRandomTipDelayMs, randomTipGate, restoreCardFocus,
  RANDOM_TIP_FIRST_MS, RANDOM_TIPS_PER_SESSION, selectRandomTip, selectReofferTip, selectTip, usePetTips,
  type RandomTipContext, type SelectedRandomTip, type SelectedTip,
} from './tips';
import './pet.css';
import { petAudio } from './audioEngine';
import {
  createPetEngine,
  createPetHoverTracker,
  createPetRestTimer,
  createActivityTimer,
  createMicroScheduler,
  type MicroScheduler,
  type PausableTimer,
  type PetMicroEvent,
  type PetActivity,
  type PetCharacter,
  type PetEngine,
  type PetRestLevel,
  type PetHoverTracker,
  type PetRestTimer,
  type VipActivity,
} from './petEngine';

type AnyActivity = PetActivity | VipActivity;

// ==========================================
// STORAGE
// ==========================================

export const VIP_STORAGE_KEY = 'nv_pet_vip';
export const VIP_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;
const SOUND_STORAGE_KEY = 'nv_pet_sound';

export function readVipFlag(): boolean {
  try {
    const raw = window.localStorage.getItem(VIP_STORAGE_KEY);
    if (raw === null) {
      return false;
    }
    // Support legacy '1' by migrating it to current timestamp
    if (raw === '1') {
      window.localStorage.setItem(VIP_STORAGE_KEY, Date.now().toString());
      return true;
    }
    const timestamp = Number(raw);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      window.localStorage.removeItem(VIP_STORAGE_KEY);
      return false;
    }
    const now = Date.now();
    const elapsed = now - timestamp;
    if (elapsed >= 0 && elapsed < VIP_EXPIRATION_MS) {
      return true;
    }
    window.localStorage.removeItem(VIP_STORAGE_KEY);
    return false;
  } catch {
    return false;
  }
}

function readSoundPreference(): boolean {
  try {
    return window.localStorage.getItem(SOUND_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function persistSoundPreference(on: boolean): void {
  try {
    window.localStorage.setItem(SOUND_STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable — pref simply won't persist */
  }
}

// ==========================================
// WINDOW AUDIBILITY (П7 — silence unless the window is genuinely active)
// ==========================================

/** The minimal window surface this predicate needs (keeps it unit-testable). */
export interface AudibilityWindow {
  document: {
    visibilityState?: string;
    hasFocus?: () => boolean;
  };
}

/**
 * Whether the window is active enough to make noise.
 *
 * WHY hasFocus() IS THE PRIMARY SIGNAL — measured, not assumed. Three states
 * must be told apart, and `visibilityState` alone cannot do it:
 *
 *   1. visible but UNFOCUSED (user working in another app):
 *      hasFocus() false, visibilityState stays "visible".
 *   2. MINIMISED: hasFocus() false, visibilityState "hidden".
 *   3. HIDDEN TO TRAY (the reported complaint — renderer keeps running):
 *      hasFocus() false; whether visibilityState flips to "hidden" is not
 *      something this code may rely on.
 *
 * Case 1 proves visibilityState is insufficient, and case 3 is the one the user
 * actually complained about, so hasFocus() carries the decision. visibilityState
 * is kept as a cheap additional veto, never as the sole signal.
 *
 * Degrades rather than going permanently mute: in an environment without
 * document.hasFocus, gating falls back to visibility alone instead of silencing
 * the pet forever.
 */
export function windowAudible(win: AudibilityWindow): boolean {
  const doc = win.document;
  if (doc.visibilityState !== undefined && doc.visibilityState !== 'visible') return false;
  if (typeof doc.hasFocus === 'function') return doc.hasFocus() === true;
  return true;
}

// ==========================================
// WINDOW ANIMATABILITY (idle-CPU fix — stop drawing what nobody can see)
// ==========================================

/** The minimal document surface this predicate needs (keeps it unit-testable). */
export interface AnimatabilityDocument {
  visibilityState?: string;
}

/**
 * Whether the pet's animation drivers (canvas rAF loop + CSS animations) may
 * run. This is the gate of PIXELS — sibling of, and deliberately DIFFERENT
 * from, windowAudible above (the gate of SOUND):
 *
 *   - SOUND interrupts: an unfocused window must stay silent, so the audio
 *     gate keys on hasFocus().
 *   - PIXELS do not interrupt: a VISIBLE-but-unfocused window can still be
 *     looked at (side window, second monitor, glance-over). Freezing the pet
 *     there reads as "the app crashed", so focus is NOT part of this gate.
 *
 * Only genuine invisibility stops the drawing: hidden-to-tray and minimised
 * both report visibilityState "hidden" (measured in real Electron 31), and a
 * fully occluded window is already rAF-throttled by Chromium itself. Those
 * are the states where every drawn frame is guaranteed waste.
 *
 * WHY NOT RELY ON CHROMIUM'S OWN THROTTLING. Measured in the assembled app
 * (Electron 31.7.7, this machine): with the window minimised or hidden to
 * the tray, visibilityState flips to "hidden" yet the renderer keeps burning
 * ~80% of one CPU core on this loop — the browser's hidden-page throttling
 * does NOT reliably engage for this app's windows. So the loop is cancelled
 * and the CSS layer paused EXPLICITLY, converting an incidental heuristic
 * into a tested guarantee, independent of backgroundThrottling or
 * occlusion-detection support.
 *
 * Degrades open: an environment without visibilityState keeps animating
 * rather than risk a frozen-but-watched pet.
 */
export function windowAnimatable(doc?: AnimatabilityDocument | null): boolean {
  try {
    return !doc || doc.visibilityState === undefined || doc.visibilityState === 'visible';
  } catch {
    return true;
  }
}

/** The canvas driver the animation gate runs / throttles / suspends. */
export interface PetAnimationDriver {
  /** (Re)arm the rAF loop — must be idempotent. */
  start(): void;
  /** Cancel the rAF loop, preserving all animation state — must be idempotent. */
  stop(): void;
  /** Frame-rate cap for the loop (null = full rAF rate). */
  setMaxFps(n: number | null): void;
}

/** Hacker canvas frame rate while CALM: rest, unfocused or a modal open (spec 2026-10-26 §7). */
export const HACKER_REST_FPS = 12;
/** Hacker canvas frame cap while ALIVE (spec §7; was the full rAF rate). */
export const HACKER_ACTIVE_FPS = 30;

export type PetAnimationMode = 'run' | 'throttle' | 'stop';

export interface PetAnimationState {
  visible: boolean;
  modalOpen: boolean;
  /** Window focus (ALIVE vs CALM). Absent = focused. */
  focused?: boolean;
  reducedMotion: boolean;
  restLevel: PetRestLevel;
}

/**
 * Canvas loop mode (spec §1.1, §3.3, §6.2, §7): a hidden page, deep rest or
 * reduced motion stop the loop (the last frame stays on screen); an open modal,
 * an unfocused window or rest throttle it to HACKER_REST_FPS; ALIVE runs at
 * HACKER_ACTIVE_FPS.
 */
export function petAnimationMode(s: PetAnimationState): PetAnimationMode {
  if (!s.visible || s.reducedMotion || s.restLevel === 'deep') return 'stop';
  if (s.modalOpen || s.focused === false || s.restLevel === 'rest') return 'throttle';
  return 'run';
}

/** Whether the window has focus; degrades to focused without document.hasFocus. */
export function windowFocused(doc?: { hasFocus?: () => boolean } | null): boolean {
  try {
    return !doc || typeof doc.hasFocus !== 'function' || doc.hasFocus() === true;
  } catch {
    return true;
  }
}

/**
 * Report a focus change to the rest timer (spec §1.1): focused = ALIVE, never
 * rests; visible but unfocused = CALM, rests after 60 s. A hidden window is
 * stopped by the visibility gate, so it is not reported here.
 */
export function applyAttention(
  focused: boolean,
  visible: boolean,
  rest: Pick<PetRestTimer, 'focus' | 'blur'> | null,
): void {
  if (!rest || !visible) return;
  if (focused) rest.focus();
  else rest.blur();
}

export interface PetLifeState {
  visible: boolean;
  focused: boolean;
  modalOpen: boolean;
  joy: boolean;
}

/** ALIVE (spec §1.1): visible, focused, no app modal and no click joy running. */
export function petAlive(s: PetLifeState): boolean {
  return s.visible && s.focused && !s.modalOpen && !s.joy;
}

/**
 * Drive the dwell timer and the micro scheduler from the attention state:
 * ALIVE resumes both (the dwell keeps at least resumeMinMs, e.g. 3 s after a
 * modal), CALM pauses both with their remaining time, HIDDEN stops both.
 */
export function applyPetLifeGate(
  s: { visible: boolean; alive: boolean; resumeMinMs?: number },
  timer: PausableTimer | null,
  micro: PausableTimer | null,
): void {
  if (!s.visible) {
    timer?.stop();
    micro?.stop();
    return;
  }
  if (s.alive) {
    timer?.resume(s.resumeMinMs ?? 0);
    micro?.resume();
    return;
  }
  timer?.pause();
  micro?.pause();
}

export interface AmbientGateState extends PetLifeState {
  celebrating: boolean;
}

/** Ambient-only gate (spec §5.2): ambient plays only in ALIVE, never during JOY or a celebration. */
export function ambientAllowed(s: AmbientGateState): boolean {
  return petAlive(s) && !s.celebrating;
}

/** Click joy before the donation modal opens (spec §3.1, §3.4). */
export const CLICK_JOY_MS = 700;
export const CLICK_JOY_REDUCED_MS = 300;

export interface ClickJoyHost {
  /** Open the donation modal (no arguments: never pass the click event). */
  open: () => unknown;
  reducedMotion: () => boolean;
  /** False when the window is hidden: the modal must not open then. */
  canOpen: () => boolean;
  onStart: () => void;
  onEnd: () => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
}

export interface ClickJoy {
  /** Start the joy; ignored (false) while one is pending, so clicks never queue modals. */
  click: () => boolean;
  /** Hidden / unmount: clear the timer and do not open the modal. */
  cancel: () => void;
  pending: () => boolean;
}

export function createClickJoy(host: ClickJoyHost): ClickJoy {
  let timer: unknown = null;
  return {
    click: () => {
      if (timer !== null) return false;
      const ms = host.reducedMotion() ? CLICK_JOY_REDUCED_MS : CLICK_JOY_MS;
      timer = host.setTimer(() => {
        timer = null;
        host.onEnd();
        if (host.canOpen()) host.open();
      }, ms);
      host.onStart();
      return true;
    },
    cancel: () => {
      if (timer === null) return;
      host.clearTimer(timer);
      timer = null;
      host.onEnd();
    },
    pending: () => timer !== null,
  };
}

/** HIDDEN (spec §3.2, §7): cancel the click joy and clear the swap timer. */
export function applyHiddenPetTimers(
  animatable: boolean,
  host: { cancelJoy: () => void; clearSwap: () => void },
): void {
  if (animatable) return;
  host.cancelJoy();
  host.clearSwap();
}

/** Welcome-back hop after a modal closes (spec §3.3): ALIVE only, never with reduced motion. */
export function shouldWelcomeBack(s: { wasModal: boolean; modalOpen: boolean; visible: boolean; focused: boolean; reducedMotion: boolean }): boolean {
  return s.wasModal && !s.modalOpen && s.visible && s.focused && !s.reducedMotion;
}

/** Timer-driven activity crossfade (spec §1.2). */
const ACTIVITY_SWAP_MS = 450;

// ==========================================
// ONE SPEAKING CHANNEL (spec 2026-10-26 4.1, owner rule 28.08)
// ==========================================

/** CAUGHT cue duration (unchanged). */
export const CUE_MS = 3_500;
/** Thought bubble duration (spec 4.1, 9.1: 6,000 -> 13,000 ms). */
export const THOUGHT_MS = 13_000;
/** Gap between one item ending and the next starting. */
export const SPEAK_GAP_MS = 600;
/** At most this many items wait for the channel. */
export const SPEAK_QUEUE_MAX = 2;
/** A queued random tip waits this long, then it is dropped (rescheduled). */
export const RANDOM_TIP_QUEUE_WAIT_MS = 60_000;
/** Hint gesture when a tip card appears (spec 4.6). */
export const HINT_GESTURE_MS = 1_800;

export type SpeakKind = 'event' | 'cue' | 'random' | 'thought';
/** P0 event tip, P1 cue, P2 random tip, P3 thought (spec 4.1 table). */
export const SPEAK_PRIORITY: Readonly<Record<SpeakKind, number>> = { event: 0, cue: 1, random: 2, thought: 3 };

export interface SpeakItem {
  kind: SpeakKind;
  /** Visible time; null = until end(kind) (event tips). */
  durationMs: number | null;
  payload?: unknown;
  /** Thoughts only: a queued thought is dropped once its activity is no longer current. */
  activity?: string;
}

export type SpeakHideReason = 'timeout' | 'end' | 'preempt' | 'clear';

export interface SpeakingChannelHost {
  show: (item: SpeakItem) => void;
  hide: (item: SpeakItem, reason: SpeakHideReason) => void;
  /** A queued item was dropped without being shown. */
  drop?: (item: SpeakItem) => void;
  currentActivity?: () => string;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
  now?: () => number;
}

export interface SpeakingChannel {
  request: (item: SpeakItem) => void;
  /** End the visible item of this kind, or drop a queued one. */
  end: (kind: SpeakKind) => void;
  current: () => SpeakItem | null;
  queued: () => readonly SpeakItem[];
  /** Pointer/focus over the card: pause its timer; on release keep >= 4 s (spec 4.4). */
  hold: (on: boolean) => void;
  /** HIDDEN / unmount: hide everything, drop the queue, clear every timer. */
  clear: () => void;
}

/** Minimum time left after a hold is released (spec 4.4). */
const SPEAK_HOLD_MIN_MS = 4_000;

/**
 * At most one of cue / thought / tip card is visible at a time. A higher
 * priority item pre-empts the visible one (an event tip waits for a running
 * cue); otherwise it queues (length 2, priority order) and starts 600 ms after
 * the visible item ends.
 */
export function createSpeakingChannel(host: SpeakingChannelHost): SpeakingChannel {
  const now = host.now ?? (() => Date.now());
  let current: SpeakItem | null = null;
  let queue: Array<{ item: SpeakItem; at: number }> = [];
  let timer: unknown = null;
  let gapTimer: unknown = null;
  let dueAt = 0;
  let heldRemaining: number | null = null;

  const clearTimer = (): void => {
    if (timer !== null) host.clearTimer(timer);
    timer = null;
  };
  const arm = (ms: number): void => {
    clearTimer();
    dueAt = now() + ms;
    timer = host.setTimer(() => {
      timer = null;
      finish('timeout');
    }, ms);
  };
  const display = (item: SpeakItem): void => {
    current = item;
    heldRemaining = null;
    host.show(item);
    if (item.durationMs !== null && current === item) arm(item.durationMs);
  };
  const stale = (entry: { item: SpeakItem; at: number }): boolean => {
    if (entry.item.kind === 'thought' && entry.item.activity !== undefined && host.currentActivity) {
      return entry.item.activity !== host.currentActivity();
    }
    return entry.item.kind === 'random' && now() - entry.at > RANDOM_TIP_QUEUE_WAIT_MS;
  };
  const next = (): void => {
    gapTimer = null;
    if (current !== null) return;
    while (queue.length > 0) {
      const entry = queue.shift() as { item: SpeakItem; at: number };
      if (stale(entry)) {
        host.drop?.(entry.item);
        continue;
      }
      display(entry.item);
      return;
    }
  };
  const scheduleNext = (): void => {
    if (gapTimer !== null || queue.length === 0) return;
    gapTimer = host.setTimer(next, SPEAK_GAP_MS);
  };
  function finish(reason: SpeakHideReason): void {
    const item = current;
    if (item === null) return;
    clearTimer();
    current = null;
    heldRemaining = null;
    // Arm the gap first: an item requested from inside hide() (the thought that
    // follows a cue) then queues behind a waiting event tip instead of jumping it.
    scheduleNext();
    host.hide(item, reason);
  }
  const dropKind = (kind: SpeakKind): void => {
    queue = queue.filter((entry) => {
      if (entry.item.kind !== kind) return true;
      host.drop?.(entry.item);
      return false;
    });
  };
  const enqueue = (item: SpeakItem): void => {
    dropKind(item.kind);
    queue.push({ item, at: now() });
    queue.sort((a, b) => SPEAK_PRIORITY[a.item.kind] - SPEAK_PRIORITY[b.item.kind]);
    while (queue.length > SPEAK_QUEUE_MAX) host.drop?.((queue.pop() as { item: SpeakItem }).item);
  };
  const preempts = (item: SpeakItem, visible: SpeakItem): boolean => {
    if (item.kind === visible.kind) return item.kind !== 'random';
    if (item.kind === 'event' && visible.kind === 'cue') return false; // waits for the cue (<= 3.5 s)
    return SPEAK_PRIORITY[item.kind] < SPEAK_PRIORITY[visible.kind];
  };

  return {
    request: (item) => {
      if (current === null && gapTimer === null) {
        display(item);
        return;
      }
      if (current !== null && preempts(item, current)) {
        const old = current;
        clearTimer();
        current = null;
        host.hide(old, 'preempt');
        display(item);
        return;
      }
      enqueue(item);
      if (current === null) scheduleNext();
    },
    end: (kind) => {
      if (current?.kind === kind) {
        finish('end');
        return;
      }
      dropKind(kind);
    },
    current: () => current,
    queued: () => queue.map((entry) => entry.item),
    hold: (on) => {
      if (current === null || current.durationMs === null) return;
      if (on) {
        if (timer === null) return;
        heldRemaining = Math.max(0, dueAt - now());
        clearTimer();
        return;
      }
      if (heldRemaining === null) return;
      const ms = Math.max(heldRemaining, SPEAK_HOLD_MIN_MS);
      heldRemaining = null;
      arm(ms);
    },
    clear: () => {
      clearTimer();
      if (gapTimer !== null) host.clearTimer(gapTimer);
      gapTimer = null;
      const dropped = queue;
      queue = [];
      for (const entry of dropped) host.drop?.(entry.item);
      const old = current;
      current = null;
      heldRemaining = null;
      if (old !== null) host.hide(old, 'clear');
    },
  };
}

/** A random tip visible for less than this was not read (it is not counted). */
export const RANDOM_TIP_READ_MS = 3_000;

/**
 * Whether a random tip that just closed counts as shown (session cap, 24 h
 * stamp, back-to-back id). Pre-empted or cleared by a hide/unmount: never.
 * Dismissed or acted on: always. Otherwise only after RANDOM_TIP_READ_MS.
 */
export function shouldCountTipShown(reason: SpeakHideReason, visibleMs: number, interacted: boolean): boolean {
  if (reason === 'preempt' || reason === 'clear') return false;
  if (interacted) return true;
  return visibleMs >= RANDOM_TIP_READ_MS;
}

/** A tip cleared by a hide/unmount is offered again when the pet is ALIVE (spec §4.6 "the card shows on return"). */
export function shouldReofferTip(reason: SpeakHideReason, interacted: boolean): boolean {
  return reason === 'clear' && !interacted;
}

/** Main's view of the window (window-state bridge); absent bridge/value = trust the document signals. */
export function mainWindowVisible(state: { visible?: boolean; minimized?: boolean } | null | undefined): boolean {
  if (!state || typeof state.visible !== 'boolean') return true;
  return state.visible && state.minimized !== true;
}

/** The random-tip ALIVE clock runs only while the document AND main agree the window is on screen and focused. */
export function tipClockAlive(pageVisible: boolean, focused: boolean, mainVisible: boolean): boolean {
  return pageVisible && focused && mainVisible;
}

/**
 * After a random round's fetch resolves: 'defer' if the pet stopped being ALIVE
 * meanwhile (nothing shown or counted; re-offered on return), 'none' if nothing
 * qualifies (the round ends), else 'show'.
 */
export function randomRoundOutcome(aliveNow: boolean, picked: unknown): 'defer' | 'none' | 'show' {
  if (!aliveNow) return 'defer';
  return picked === null || picked === undefined ? 'none' : 'show';
}

/** Random-tip visible time (spec 4.4): clamp(12 s, 4 s + 60 ms per character, 25 s). */
export function randomTipVisibleMs(titleLength: number, bodyLength: number): number {
  return Math.min(25_000, Math.max(12_000, 4_000 + 60 * (titleLength + bodyLength)));
}

// ==========================================
// RANDOM-TIP CADENCE (spec 4.2): ALIVE-time clock + quiet rule + cap
// ==========================================

export interface RandomTipSchedulerHost {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
  now?: () => number;
  random?: () => number;
  lastInputAt: () => number | null;
  shownThisSession: () => number;
  /** TipsState.enabled (Settings #setting-tips). */
  enabled: () => boolean;
  /** A tip may be tried now; the scheduler waits until roundDone(). */
  onDue: () => void;
}

export interface RandomTipScheduler {
  /** ALIVE (visible + focused) on/off: the clock and the timer run only while on. */
  setAlive: (alive: boolean) => void;
  /** The round ended (tip closed, dropped, or nothing eligible): the next one is 240-360 s of ALIVE time later. */
  roundDone: () => void;
  /** Re-evaluate now (the tips switch changed). */
  refresh: () => void;
  aliveMs: () => number;
  /** ALIVE time at which the next tip is due. */
  dueAliveMs: () => number;
  stop: () => void;
}

export function createRandomTipScheduler(host: RandomTipSchedulerHost): RandomTipScheduler {
  const now = host.now ?? (() => Date.now());
  const random = host.random ?? Math.random;
  let accumulated = 0;
  let aliveSince: number | null = null;
  let due = RANDOM_TIP_FIRST_MS;
  let timer: unknown = null;
  let busy = false;

  const aliveMs = (): number => accumulated + (aliveSince !== null ? now() - aliveSince : 0);
  const clear = (): void => {
    if (timer !== null) host.clearTimer(timer);
    timer = null;
  };
  const check = (): void => {
    clear();
    if (aliveSince === null || busy) return;
    const left = due - aliveMs();
    if (left > 0) {
      timer = host.setTimer(check, left);
      return;
    }
    // Due on the ALIVE clock; the gate applies the switch, the cap and the quiet rule.
    const at = now();
    const gate = randomTipGate({
      now: at,
      dueAt: at,
      lastInputAt: host.lastInputAt(),
      shownThisSession: host.shownThisSession(),
      enabled: host.enabled(),
    });
    if (gate.status === 'off') return;
    if (gate.status === 'wait') {
      timer = host.setTimer(check, Math.max(1, gate.at - at));
      return;
    }
    busy = true;
    host.onDue();
  };

  return {
    setAlive: (alive) => {
      if (alive && aliveSince === null) {
        aliveSince = now();
        check();
      } else if (!alive && aliveSince !== null) {
        accumulated += now() - aliveSince;
        aliveSince = null;
        clear();
      }
    },
    roundDone: () => {
      busy = false;
      due = aliveMs() + nextRandomTipDelayMs(random);
      check();
    },
    refresh: () => {
      if (!busy) check();
    },
    aliveMs,
    dueAliveMs: () => due,
    stop: () => {
      clear();
      if (aliveSince !== null) accumulated += now() - aliveSince;
      aliveSince = null;
    },
  };
}

/** Facts for the random-tip conditions (spec 4.2), from the fetched queries + session counters. */
export function buildRandomTipContext(input: {
  route: string;
  runtime?: Partial<RuntimeState> | null;
  models?: { models?: ReadonlyArray<{ enabled?: boolean }> } | null;
  keys?: { keys?: ReadonlyArray<{ legacyDisabled?: boolean }> } | null;
  update?: { state?: string } | null;
  aliveMs: number;
  shown: number;
  lastId: string | null;
}): RandomTipContext {
  const runtime = input.runtime ?? null;
  const models = Array.isArray(input.models?.models) ? input.models.models : null;
  const keys = Array.isArray(input.keys?.keys) ? input.keys.keys : null;
  return {
    route: input.route,
    gatewayState: typeof runtime?.status?.state === 'string' ? runtime.status.state : null,
    enabledModelCount: models === null ? null : models.filter((model) => model.enabled === true).length,
    keyCount: keys === null ? null : keys.length,
    anyLegacyDisabled: keys === null ? null : keys.some((key) => key.legacyDisabled === true),
    autoLaunch: typeof runtime?.autoLaunch === 'boolean' ? runtime.autoLaunch : null,
    performanceMode: runtime?.performanceMode ?? null,
    requestDeadlineSource: runtime?.requestDeadlineSource ?? null,
    requestDeadlineMs: typeof runtime?.requestDeadlineMs === 'number' ? runtime.requestDeadlineMs : null,
    llmStatsEnabled: typeof runtime?.llmStatsEnabled === 'boolean' ? runtime.llmStatsEnabled : null,
    updateState: typeof input.update?.state === 'string' ? input.update.state : null,
    aliveMsThisSession: input.aliveMs,
    randomShownThisSession: input.shown,
    lastRandomTipId: input.lastId,
  };
}

/** The random tip the channel shows (payload of a 'random' item). */
export interface ShownRandomTip extends SelectedRandomTip {
  occurrenceId: string;
}
/** A timer switch shows the thought bubble with this probability (spec §1.2). */
const TIMER_SWITCH_THOUGHT_P = 0.35;
/** Minimum dwell left when a modal closes (spec §1.1). */
const MODAL_RESUME_MIN_MS = 3_000;

/**
 * Single transition point for the animation gate. Suspension preserves state
 * (the cancelled renderer keeps its particles/mode/clock anchor), so a resume
 * continues exactly where the pet stopped — no replay burst, no visual jump.
 */
export function applyPetAnimationGate(mode: PetAnimationMode, driver: PetAnimationDriver): void {
  if (mode === 'stop') {
    driver.stop();
    return;
  }
  driver.setMaxFps(mode === 'throttle' ? HACKER_REST_FPS : HACKER_ACTIVE_FPS);
  driver.start();
}

/**
 * Hit-test a pointer event's client coordinates against the pet button rect.
 * Measured on show (main-process hide/show): Chromium sends a TRUSTED
 * pointermove at the real OS cursor position, so the coordinates are the
 * truth about where the cursor is. Returns null for unusable coordinates
 * (non-finite), so the caller ignores that event and the 2 s show probe stays in
 * charge. Right/bottom edges are exclusive.
 */
export function pointerOverButton(
  x: number,
  y: number,
  rect: { left: number; top: number; right: number; bottom: number } | null,
): boolean | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!rect) return false;
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

/** Minimal host surface for attachPetAnchor (structural, so tests can fake it). */
export interface PetAnchorWindow {
  addEventListener(type: 'resize', fn: () => void): void;
  removeEventListener(type: 'resize', fn: () => void): void;
  getComputedStyle?: (el: Element) => { overflowY: string };
  ResizeObserver?: new (cb: () => void) => { observe(el: Element): void; disconnect(): void };
}

/**
 * Spec §11.2 speech-slot anchor: writes --pet-anchor-top/--pet-anchor-bottom
 * (px, from the pet button rect) on the pet root now, on window resize, on a
 * ResizeObserver tick of the button, and on scroll of the nearest scrolling
 * ancestor (the sidebar). CSSOM setProperty, not a <style> block, so the
 * renderer CSP (style-src 'self') allows it. Returns a cleanup that removes
 * every listener and observer.
 */
export function attachPetAnchor(
  root: HTMLElement | null,
  button: HTMLElement | null,
  win: PetAnchorWindow,
): () => void {
  if (!root || !button) return () => {};
  const update = (): void => {
    const rect = button.getBoundingClientRect();
    root.style.setProperty('--pet-anchor-top', `${rect.top}px`);
    root.style.setProperty('--pet-anchor-bottom', `${rect.bottom}px`);
  };
  update();
  win.addEventListener('resize', update);
  let scroller: HTMLElement | null = null;
  for (let el = root.parentElement; el; el = el.parentElement) {
    const overflowY = win.getComputedStyle?.(el).overflowY ?? '';
    if (overflowY === 'auto' || overflowY === 'scroll') { scroller = el; break; }
  }
  scroller?.addEventListener('scroll', update, { passive: true });
  const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(update) : null;
  observer?.observe(button);
  return () => {
    win.removeEventListener('resize', update);
    scroller?.removeEventListener('scroll', update);
    observer?.disconnect();
  };
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Follow the OS reduced-motion setting live: reports the current value now
 * and on every 'change'. Returns the unsubscribe. No-op without matchMedia.
 */
export function subscribeReducedMotion(
  win: { matchMedia?: (query: string) => MediaQueryList },
  onValue: (reduce: boolean) => void,
): () => void {
  if (typeof win.matchMedia !== 'function') return () => {};
  const mql = win.matchMedia(REDUCED_MOTION_QUERY);
  const onChange = (): void => onValue(mql.matches);
  onChange();
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/** Current prefers-reduced-motion value; false where matchMedia is unavailable. */
function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// ==========================================
// THOUGHT CLOUD CONTENT (per activity)
// Texts live in the i18n pet_* namespace (pet_thought_<slug>_<variant>,
// see src/renderer/i18n/resources.ts); only the emoji glyphs stay in-code.
// ==========================================

interface ThoughtVariant {
  emoji: string;
  text: string;
}

/** Emoji glyph per variant — parallel to the pet_thought_* keys below. */
const THOUGHT_EMOJI: Record<string, ReadonlyArray<string>> = {
  'power-nap': ['💤', '😴', '💤'],
  'terminal-nap': ['💤', '😴'],
  'low-battery': ['🪫', '⚡', '🔋', '🥱'],
  'empty-mug': ['☕', '☕', '🥺', '🥱'],
  'code-frenzy': ['⌨️', '🍕', '⚡', '🔥'],
  'bug-hunter': ['🎯', '⚡', '🗡️'],
  'bug-slayer': ['🎯', '⚡', '🗡️'],
  'coin-drop': ['🪙', '✨', '💖'],
  'nano-coffee': ['☕', '✨', '🚀'],
  'turbine-generator': ['🌀', '⚡'],
  'sensor-polish': ['✨', '🔍'],
  'model-juggler': ['💎', '✨'],
  'zero-errors': ['🏆', '🎉'],
  flowchart: ['📈', '📊'],
  'syndicate-salute': ['👑'],
  'espresso-toast': ['☕'],
  'fourth-wall-wink': ['🕶️'],
  'hyper-hack': ['⚡'],
  'quantum-meditation': ['🌌'],
};

/** Localized variant count per activity (pet_thought_<slug>_<0..n-1>). */
const THOUGHT_VARIANT_COUNTS: Record<string, number> = {
  'power-nap': 3,
  'terminal-nap': 2,
  'low-battery': 4,
  'empty-mug': 4,
  'code-frenzy': 4,
  'bug-hunter': 3,
  'bug-slayer': 3,
  'coin-drop': 3,
  'nano-coffee': 3,
  'turbine-generator': 2,
  'sensor-polish': 2,
  'model-juggler': 2,
  'zero-errors': 2,
  flowchart: 2,
  'syndicate-salute': 1,
  'espresso-toast': 1,
  'fourth-wall-wink': 1,
  'hyper-hack': 1,
  'quantum-meditation': 1,
};

// ACTIVITY CAPTIONS (spec 2026-10-26 §2): icon + pet_caption_<slug>_<0|1>.
/** Lucide icon per activity (spec §2.3 tables). */
export const CAPTION_ICONS: Readonly<Record<string, LucideIcon>> = {
  'bug-hunter': Crosshair,
  'low-battery': BatteryLow,
  'turbine-generator': Fan,
  'sensor-polish': ScanEye,
  'model-juggler': Boxes,
  'nano-coffee': Coffee,
  'power-nap': Moon,
  'code-frenzy': Keyboard,
  'zero-errors': Trophy,
  'empty-mug': Coffee,
  'bug-slayer': Swords,
  'coin-drop': Coins,
  flowchart: Workflow,
  'terminal-nap': Moon,
  'syndicate-salute': Crown,
  'espresso-toast': Coffee,
  'fourth-wall-wink': Glasses,
  'hyper-hack': Zap,
  'quantum-meditation': Atom,
};
/** Each activity has 2 caption variants (spec §2.1). */
export const CAPTION_VARIANT_COUNT = 2;

/** i18n key of caption variant `n` for an activity (same slug rule as pickThought). */
export function captionKey(activity: string, n: number): string {
  return `pet_caption_${activity.replace(/-/g, '_')}_${n}`;
}

/**
 * Spec §2.1: a random caption variant for `activity`, never the same as the
 * last variant shown for that activity. `random` returns [0, 1).
 */
export function pickCaptionVariant(activity: string, last: number | null, random: () => number = Math.random): number {
  const count = activity in CAPTION_ICONS ? CAPTION_VARIANT_COUNT : 1;
  const r = random();
  const unit = Number.isFinite(r) ? Math.min(Math.max(r, 0), 0.999999) : 0;
  if (count <= 1) return 0;
  if (last === null || !Number.isInteger(last) || last < 0 || last >= count) return Math.floor(unit * count);
  const k = Math.floor(unit * (count - 1));
  return k >= last ? k + 1 : k;
}

function pickThought(activity: AnyActivity, t: (key: string) => string): ThoughtVariant | null {
  const emojis = THOUGHT_EMOJI[activity];
  const count = THOUGHT_VARIANT_COUNTS[activity] ?? 0;
  if (!emojis || count === 0) return null;
  const index = Math.floor(Math.random() * count);
  const slug = activity.replace(/-/g, '_');
  return {
    emoji: emojis[index % emojis.length],
    text: t(`pet_thought_${slug}_${index}`),
  };
}

// ==========================================
// ACTIVITY -> PROCEDURAL SFX (played ONCE per switch)
// ==========================================

const ACTIVITY_SFX: Record<string, () => number> = {
  'bug-hunter': () => petAudio.playMascotBugHunter(),
  'low-battery': () => petAudio.playMascotLowBattery(),
  'turbine-generator': () => petAudio.playMascotTurbine(),
  'sensor-polish': () => petAudio.playMascotSensorPolish(),
  'model-juggler': () => petAudio.playMascotModelJuggler(),
  'nano-coffee': () => petAudio.playMascotNanoCoffee(),
  'power-nap': () => petAudio.playMascotPowerNap(),
  'code-frenzy': () => petAudio.playHackerCodeFrenzy(),
  'zero-errors': () => petAudio.playHackerZeroErrors(),
  'empty-mug': () => petAudio.playHackerEmptyMug(),
  'bug-slayer': () => petAudio.playHackerBugSlayer(),
  'coin-drop': () => petAudio.playHackerCoinDrop(),
  flowchart: () => petAudio.playHackerFlowchart(),
  'terminal-nap': () => petAudio.playHackerTerminalNap(),
  'syndicate-salute': () => petAudio.playActionCheer(),
  'espresso-toast': () => petAudio.playMascotNanoCoffee(),
  'fourth-wall-wink': () => petAudio.playChime(),
  'hyper-hack': () => petAudio.playHackerCodeFrenzy(),
  'quantum-meditation': () => petAudio.playAscensionRitual(),
};

// ==========================================
// HACKER CANVAS MODE MAPPING
// ==========================================

const VIP_ACTIVITY_IDS: ReadonlySet<string> = new Set<VipActivity>([
  'syndicate-salute',
  'espresso-toast',
  'fourth-wall-wink',
  'hyper-hack',
  'quantum-meditation',
]);

/** Map an engine activity id onto the canvas renderer's internal mode id. */
function hackerModeOf(activity: AnyActivity): string {
  return VIP_ACTIVITY_IDS.has(activity) ? `vip-${activity}` : activity;
}

// ==========================================
// COMPONENT
// ==========================================

/** How long the ascension celebration overlay stays on before it is cleared. */
const CELEBRATION_MS = 8000;
/**
 * The mascot's celebration activity. Must be in VIP_ACTIVITIES (a real engine
 * activity the mascot branch can render) and NOT in MASCOT_ACTIVITIES (so it
 * cannot collide with the normal rotation); pet.css styles it for the mascot
 * via `.nv-pet-wrap.act-syndicate-salute` (.m-vip-salute-scene + salute arm).
 */
export const MASCOT_CELEBRATION_ACTIVITY = 'syndicate-salute' as const;

/** The state machine behind one celebration (see createCelebration). */
export interface CelebrationState {
  /** Capture the prior and arm the timer for this event. */
  start: () => void;
  /**
   * Report an engine activity commit (the widget calls this from
   * handleActivityChange). A commit the celebration did not make itself means
   * the pet genuinely switched activity, so the timer must not restore over it.
   */
  onActivityChange: (next: AnyActivity) => void;
  /** Whether a celebration is running (JOY, micro and ambient gates). */
  isRunning: () => boolean;
}

export interface CelebrationHost {
  /** Current activity as React knows it (updated by commit -> onActivityChange). */
  currentActivity: () => AnyActivity;
  /** Whether the running character is the mascot. */
  isMascot: () => boolean;
  setActivity: (activity: AnyActivity) => void;
  setHackerMode: (mode: string) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
  /** Running flag changed (drives the celebration caption, spec §2.3). */
  onRunningChange?: (running: boolean) => void;
}

/**
 * The celebration state machine, extracted from the handler so it can be
 * replayed against the REAL logic (tests used to re-implement it, which hid two
 * bugs: a dead hacker reset and an activity-id sentinel collision).
 *
 * Invariants:
 *  - "a celebration is running" is a BOOLEAN (`celebrating`), never an
 *    activity-id comparison. 'syndicate-salute' is a real VIP activity, so
 *    comparing ids both skipped capturing when the pet genuinely idled on it
 *    and clobbered a real switch to it mid-celebration.
 *  - which character the celebration belongs to is also captured ONCE, in the
 *    same per-celebration step as the prior (`forMascot`). The hacker restore
 *    used to test the MASCOT sentinel, which the hacker path never set, so the
 *    reset was dead code and the canvas stayed in `celebration` forever.
 *  - the prior and the character are captured ONCE per celebration; a repeat
 *    event inside the window only extends the timer.
 *  - a commit the celebration did not make itself is a GENUINE activity switch:
 *    `ownCommit` marks the salute it commits, and `onActivityChange` disarms
 *    the restore for anything else. That is what lets the pet be switched to
 *    'syndicate-salute' mid-celebration without being clobbered back to a
 *    stale prior (an id comparison cannot tell the two apart).
 */
export function createCelebration(host: CelebrationHost): CelebrationState {
  let celebrating = false;
  let prior: AnyActivity = host.currentActivity();
  let forMascot = false;
  let timer: unknown = null;
  /** True only while the machine itself commits the mascot salute. */
  let ownCommit = false;

  const commitOwnActivity = (activity: AnyActivity): void => {
    ownCommit = true;
    try {
      host.setActivity(activity);
    } finally {
      ownCommit = false;
    }
  };

  return {
    start: () => {
      if (!celebrating) {
        prior = host.currentActivity();
        forMascot = host.isMascot();
        celebrating = true;
        host.onRunningChange?.(true);
        host.setHackerMode('celebration');
        if (forMascot) commitOwnActivity(MASCOT_CELEBRATION_ACTIVITY);
      }
      // Per-timer captures: a repeat event keeps the ORIGINAL prior/character.
      const restoreTo = prior;
      const restoreMascot = forMascot;
      if (timer !== null) host.clearTimer(timer);
      timer = host.setTimer(() => {
        timer = null;
        if (!celebrating) return;
        celebrating = false;
        host.onRunningChange?.(false);
        if (!restoreMascot) host.setHackerMode(hackerModeOf(restoreTo));
        else commitOwnActivity(restoreTo);
      }, CELEBRATION_MS);
    },
    isRunning: () => celebrating,
    onActivityChange: (next) => {
      // A genuine switch (or a switch back to a genuine idle) during the
      // celebration: keep the new activity, drop the pending restore.
      if (!celebrating || ownCommit) return;
      celebrating = false;
      host.onRunningChange?.(false);
      if (timer !== null) {
        host.clearTimer(timer);
        timer = null;
      }
      // The hacker canvas is driven by THIS machine, not by the engine's
      // activity state, so the mode must be restored here: the widget's
      // activity->mode effect only re-runs when the React activity value
      // actually changes, and a genuine commit can carry the id the canvas is
      // already showing. Without this the canvas would be disarmed but stay
      // frozen in `celebration` forever (the dead-hacker-reset class of bug).
      // The mascot has no canvas; its salute is cleared by the activity state.
      if (!forMascot) host.setHackerMode(hackerModeOf(next));
    },
  };
}
const ADVICE_TITLE_ID = 'pet-advice-title';
/** Placeholder swapped for the <bdi>-wrapped version in the update tip body. */
const VERSION_MARK = '\u0001v\u0001';

export interface PetWidgetProps {
  /**
   * Fired when the widget body (not the sound toggle) is clicked. Typed like
   * the modal-context opener so passing a React event as `request` is a type
   * error (the 46f5127 click bug class).
   */
  onOpenDonation: (request?: ModalRequest) => boolean;
}

export function PetWidget({ onOpenDonation }: PetWidgetProps): React.JSX.Element {
  const { t } = useTranslation();
  const [isVip, setIsVip] = useState<boolean>(readVipFlag);
  const [soundOn, setSoundOn] = useState<boolean>(readSoundPreference);
  const [character, setCharacter] = useState<PetCharacter>('mascot');
  const [activity, setActivity] = useState<AnyActivity>('bug-hunter');
  const [cueShown, setCueShown] = useState<boolean>(false);
  const [crossfading, setCrossfading] = useState<boolean>(false);
  const [thought, setThought] = useState<ThoughtVariant | null>(null);
  // One speaking channel (spec §4.1): cue, thought and the tip cards are shown
  // only through it. The host is re-bound every render (speakHostRef).
  const [randomTip, setRandomTip] = useState<ShownRandomTip | null>(null);
  const [eventShown, setEventShown] = useState<boolean>(false);
  // Celebration caption (spec §2.3), mirrored from the celebration machine.
  const [celebrating, setCelebrating] = useState<boolean>(false);
  // Hint gesture (spec §4.6): 'up' = the tip has a route (the pet looks up at the nav).
  const [hint, setHint] = useState<'down' | 'up' | null>(null);
  const speakHostRef = useRef<Pick<SpeakingChannelHost, 'show' | 'hide' | 'drop'>>({ show: () => {}, hide: () => {} });
  const channelRef = useRef<SpeakingChannel | null>(null);
  if (channelRef.current === null) {
    channelRef.current = createSpeakingChannel({
      show: (item) => speakHostRef.current.show(item),
      hide: (item, reason) => speakHostRef.current.hide(item, reason),
      drop: (item) => speakHostRef.current.drop?.(item),
      currentActivity: () => activityRef.current,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
    });
  }
  // Activity caption variant (spec §2.1); set in the same commit as the activity.
  const [captionIndex, setCaptionIndex] = useState<number>(0);
  const lastCaptionRef = useRef<Record<string, number>>({});
  // Animation visibility gate state: drives the nv-pet-paused class on the
  // widget root (CSS layer). The canvas rAF loop is driven directly through
  // hackerRendererRef in the gate effect below (no re-render needed there).
  const [pageVisible, setPageVisible] = useState<boolean>(() => windowAnimatable(document));
  // Any app modal (Donation / About / Feedback / SendErrors) covers the pet.
  // The pet stays CALM but alive behind it (spec 2026-10-26 §1.5, §3.3): only a
  // hidden page pauses the CSS layer, so nv-pet-paused keys on pageVisible.
  const { activeModal } = useModal();
  const activeModalRef = useRef(activeModal);
  // ALIVE vs CALM (spec §1.1): window focus, set from the engine's attention hooks.
  const [focused, setFocused] = useState<boolean>(() => windowFocused(document));
  const focusedRef = useRef<boolean>(focused);
  // Click joy (spec §3): 'hop' (mascot hops) or 'still' (celebration owns the rig).
  const [joy, setJoy] = useState<'hop' | 'still' | null>(null);
  const joyPendingRef = useRef<boolean>(false);
  const joyRef = useRef<ClickJoy | null>(null);
  // Mascot micro-actions (spec §1.3): one-shot class on .m-micro, drift station on .m-station.
  const [microId, setMicroId] = useState<string | null>(null);
  const [station, setStation] = useState<{ x: number; ms: number }>({ x: 0, ms: 600 });
  // Timer-driven activity crossfade (spec §1.2).
  const [swapping, setSwapping] = useState<boolean>(false);
  const swappingRef = useRef<boolean>(false);
  const swapTimerRef = useRef<number | null>(null);
  const activityTimerRef = useRef<PausableTimer | null>(null);
  const microRef = useRef<MicroScheduler | null>(null);
  /** True only while the dwell timer itself switches the activity (a silent switch). */
  const timerSwitchRef = useRef<boolean>(false);
  /** Minimum dwell left when ALIVE resumes (3 s after a modal closes). */
  const resumeMinRef = useRef<number>(0);
  const onOpenDonationRef = useRef(onOpenDonation);
  // Rest mode: 'rest' 8 s after the last activity/event/interaction, 'deep'
  // after 60 s (see createPetRestTimer and the REST MODE block in pet.css).
  const [restLevel, setRestLevel] = useState<PetRestLevel>('awake');
  const restRef = useRef<PetRestTimer | null>(null);
  // Hover hold that survives a window hide/show (see createPetHoverTracker).
  const hoverRef = useRef<PetHoverTracker | null>(null);
  // Reduced motion stops the hacker canvas (the CSS rule handles the mascot);
  // followed live via subscribeReducedMotion in a mount effect below.
  const [reducedMotion, setReducedMotion] = useState<boolean>(prefersReducedMotion);
  const reducedMotionRef = useRef<boolean>(reducedMotion);
  useEffect(() => { reducedMotionRef.current = reducedMotion; }, [reducedMotion]);
  useEffect(() => { activeModalRef.current = activeModal; }, [activeModal]);
  useEffect(() => { onOpenDonationRef.current = onOpenDonation; }, [onOpenDonation]);

  const vipRef = useRef<boolean>(isVip);
  const soundRef = useRef<boolean>(soundOn);
  const activityRef = useRef<AnyActivity>(activity);
  const characterRef = useRef<PetCharacter>(character);
  useEffect(() => { characterRef.current = character; }, [character]);
  const engineRef = useRef<PetEngine | null>(null);
  const hackerRendererRef = useRef<PixelHackerRenderer | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fadeTimerRef = useRef<number | null>(null);
  // Random tips (spec §4.2): last input stamp, session counters, scheduler.
  const lastInputAtRef = useRef<number | null>(null);
  const randomShownRef = useRef<number>(0);
  const lastRandomIdRef = useRef<string | null>(null);
  const randomSchedRef = useRef<RandomTipScheduler | null>(null);
  /** When the visible random tip appeared, and whether the user dismissed/acted on it. */
  const randomShownAtRef = useRef<number>(0);
  const randomInteractedRef = useRef<boolean>(false);
  /** A random tip cleared by a hide before it was read; re-offered when ALIVE again. */
  const pendingRandomTipRef = useRef<{ id: string | null } | null>(null);
  /** Latest random-tip ALIVE state, read after the fetch await. */
  const tipAliveRef = useRef<boolean>(true);
  /** Main's view of the window (window-state bridge); true while the bridge is absent. */
  const [mainVisible, setMainVisible] = useState<boolean>(true);
  const offerRandomTipRef = useRef<(pendingId?: string | null) => Promise<void>>(async () => {});
  // Hint gesture (spec §4.6): one timer; start/stop bound every render.
  const hintTimerRef = useRef<number | null>(null);
  const startHintRef = useRef<(routed: boolean) => void>(() => {});
  const stopHintRef = useRef<() => void>(() => {});
  /** The celebration state machine (prior + timer), created once per widget. */
  const celebrationRef = useRef<CelebrationState | null>(null);
  const widgetBtnRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // ── Pet advisor (wave 6B) data ──────────────────────────────────────
  // The pet sits OUTSIDE the gateway-lifecycle Provider, so it observes the
  // status cache Layout fills via setQueryData. Keys: a passive observer plus
  // an explicit, throttled (staleTime) local fetch — never a timer or a new
  // listener. Updates: one IPC on mount; Settings' poll keeps it fresh.
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const statusQuery = useQuery<GatewayStatus>({ queryKey: ['gateway-status'], enabled: false });
  const keysQuery = useQuery({ queryKey: queryKeys.keys, queryFn: api.keys, enabled: false });
  const updatesQuery = useQuery({ queryKey: queryKeys.updates, queryFn: api.updateStatus, refetchInterval: false, refetchOnWindowFocus: false });
  const running = statusQuery.data?.state === 'running';
  const refreshKeys = useCallback((): void => {
    if (!running || document.visibilityState !== 'visible') return;
    void queryClient.fetchQuery({ queryKey: queryKeys.keys, queryFn: api.keys, staleTime: 60_000 }).catch(() => {});
  }, [running, queryClient]);
  // The attention hook is wired once in the engine effect below (its deps do
  // not include refreshKeys), so it calls the latest refreshKeys through a ref.
  const refreshKeysRef = useRef(refreshKeys);
  useEffect(() => {
    refreshKeysRef.current = refreshKeys;
  }, [refreshKeys]);
  // Runs when running becomes true (refreshKeys identity) and on route change.
  useEffect(() => { refreshKeys(); }, [refreshKeys, location.pathname]);

  // Keep a stable ref to `t`: react-i18next's translator identity can churn
  // between renders, and if it flowed into a callback used as an effect dep
  // it would tear down + re-mount the engine on every render (each re-mount
  // seeds another activity switch → machine-gunning). The engine must mount
  // exactly once per widget lifetime.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const syncVipFromStorage = useCallback((): void => {
    const vip = readVipFlag();
    vipRef.current = vip;
    setIsVip(vip);
  }, []);

  // The thought goes through the one speaking channel (spec §4.1): it waits for
  // a cue or a tip card, and a queued thought is dropped once its activity changed.
  const showThought = useCallback((act: AnyActivity, durationMs = THOUGHT_MS): void => {
    const picked = pickThought(act, tRef.current);
    if (picked === null) return;
    channelRef.current?.request({ kind: 'thought', durationMs, payload: picked, activity: act });
  }, []);

  // Spec §5.2: any non-ambient pet sound restarts the ambient window at a fresh
  // 60-90 s. Closing and reopening the ambient-only gate does that
  // (audioEngine.setAmbientGate: false clears the pending timer, true arms a
  // fresh window while a cadence is registered). The predicate installed at
  // mount is kept: the boolean and the predicate are separate gates.
  const restartAmbientWindow = useCallback((): void => {
    try {
      petAudio.setAmbientGate(false);
      petAudio.setAmbientGate(true);
    } catch {
      /* best-effort: audio must never break the pet */
    }
  }, []);

  const startSwap = useCallback((): void => {
    if (swapTimerRef.current !== null) window.clearTimeout(swapTimerRef.current);
    swappingRef.current = true;
    setSwapping(true);
    swapTimerRef.current = window.setTimeout(() => {
      swapTimerRef.current = null;
      swappingRef.current = false;
      setSwapping(false);
    }, ACTIVITY_SWAP_MS);
  }, []);

  // Micro-action beat (spec §1.3): canvas routine for the hacker, CSS class or
  // drift station for the mascot.
  const applyMicro = useCallback((event: PetMicroEvent): void => {
    if (characterRef.current === 'hacker') {
      hackerRendererRef.current?.setMicro(event.id, event.durationMs);
      return;
    }
    if (event.id === 'drift') {
      setStation({ x: event.station ?? 0, ms: event.durationMs });
      return;
    }
    setMicroId(event.id);
  }, []);
  // .m-micro animations are one-shot: drop the class when its own animation ends.
  const onMicroAnimationEnd = useCallback((event: React.AnimationEvent<SVGGElement>): void => {
    if (event.target === event.currentTarget) setMicroId(null);
  }, []);

  // Activity switch: re-render character animation, play matching SFX once,
  // show themed thought cloud, re-sync VIP flag (it may have flipped while
  // the donation modal was open).
  //
  // Identity-stable by construction: reads `t` through tRef so this callback
  // never changes identity when the translator instance does.
  const handleActivityChange = useCallback(
    (next: AnyActivity): void => {
      activityRef.current = next;
      // Tell the celebration machine about EVERY engine commit. A commit it did
      // not make itself is a genuine switch and must survive its timer (it used
      // to be clobbered back to a stale prior). The machine ignores its own
      // salute/restore commits.
      celebrationRef.current?.onActivityChange(next);
      restRef.current?.wake(); // a new activity starts: leave rest, re-arm 8 s
      setActivity(next);
      // Caption rotates with the activity (spec §2.1): no back-to-back variant repeat.
      const variant = pickCaptionVariant(next, lastCaptionRef.current[next] ?? null);
      lastCaptionRef.current[next] = variant;
      setCaptionIndex(variant);
      syncVipFromStorage();
      // Audio must never take the widget down: the FIRST seeded activity
      // fires this synchronously inside the mount effect, and an uncaught
      // effect error makes React unmount the whole subtree. Losing an SFX
      // is cosmetic; losing the widget is not.
      // Micro-actions: the station resets to 0 (600 ms), a 1.5 s quiet window starts.
      microRef.current?.notifyActivityChange();
      setStation({ x: 0, ms: 600 });
      setMicroId(null);
      if (timerSwitchRef.current) {
        // Timer switch (spec §1.2, §5.3): silent, 450 ms crossfade, thought with p = 0.35.
        startSwap();
        if (channelRef.current?.current()?.kind !== 'cue' && Math.random() < TIMER_SWITCH_THOUGHT_P) showThought(next, THOUGHT_MS);
        return;
      }
      try {
        ACTIVITY_SFX[next]?.();
      } catch {
        /* procedural SFX is best-effort — ignore engine failures */
      }
      // A non-ambient sound played: restart the ambient window (spec §5.2).
      restartAmbientWindow();
      // If a cue is currently active, the cue's end queues the thought (one channel).
      if (channelRef.current?.current()?.kind !== 'cue') {
        showThought(next, THOUGHT_MS);
      }
    },
    [restartAmbientWindow, showThought, startSwap, syncVipFromStorage],
  );

  // CAUGHT IN THE ACT! — fired by the engine when focus returns after away.
  // Sequential display through the speaking channel: the cue shows for 3500 ms
  // first (it pre-empts a thought), then the thought cloud for 13000 ms.
  const handleCue = useCallback((): void => {
    if (fadeTimerRef.current !== null) {
      window.clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }

    restRef.current?.wake(); // engine event: leave rest, re-arm 8 s
    // Focus-return switch (spec §1.2): restart the dwell timer while ALIVE.
    // The cue only fires on a genuine focus return, so the window is focused here.
    if (focusedRef.current && activeModalRef.current === null) activityTimerRef.current?.start();
    // Never show thought simultaneously with cue: the channel pre-empts it.
    channelRef.current?.request({ kind: 'cue', durationMs: CUE_MS });
    setCrossfading(true);

    fadeTimerRef.current = window.setTimeout(() => {
      setCrossfading(false);
      fadeTimerRef.current = null;
    }, 600);
  }, []);

  // Rest timer (mount once). Declared BEFORE the engine effect so the first
  // seeded activity already arms it. Its timers are cleared on unmount here
  // and on hide by the visibility gate below.
  useEffect(() => {
    const rest = createPetRestTimer({ onChange: setRestLevel, initialFocused: windowFocused(document) });
    restRef.current = rest;
    const hover = createPetHoverTracker({ rest, isHidden: () => !windowAnimatable(document) });
    hoverRef.current = hover;
    rest.wake();
    return () => { hover.dispose(); hoverRef.current = null; rest.stop(); restRef.current = null; };
  }, []);

  // Click on .widget-btn leaves rest and restarts the 8 s timer.
  const wakePet = useCallback((): void => {
    restRef.current?.wake();
  }, []);
  // Hover keeps the pet awake for as long as the pointer is over it; leaving
  // restarts the 8 s timer. The tracker ignores the mouseleave Chromium fires
  // when the window hides.
  const holdPet = useCallback((): void => {
    hoverRef.current?.enter();
  }, []);
  const releasePet = useCallback((): void => {
    hoverRef.current?.leave();
  }, []);

  // After a show, :hover stays false until the mouse moves, and a pointermove
  // onto the pet may arrive with no mouseenter at all. So from a show until a
  // confirmed mouseenter/mouseleave, every window pointermove is hit-tested
  // against the button (the first one may come no later than
  // PET_HOVER_SHOW_PROBE_MS, else the tracker releases).
  useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      const hover = hoverRef.current;
      if (!hover?.tracksPointer()) return;
      const over = pointerOverButton(event.clientX, event.clientY, widgetBtnRef.current?.getBoundingClientRect() ?? null);
      if (over !== null) hover.pointer(over);
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, []);

  // Live OS reduced-motion setting -> the canvas gate state (unsubscribed on unmount).
  useEffect(() => subscribeReducedMotion(window, setReducedMotion), []);

  // Engine + audio wiring (mount once).
  useEffect(() => {
    const engine = createPetEngine({
      isVip: () => vipRef.current,
      onActivityChange: handleActivityChange,
      onCue: handleCue,
    });
    engineRef.current = engine;

    // П7 — install the window-audibility gate FIRST, before anything can make
    // a sound. Polled at every sound-production point, so a hide whose
    // blur/visibilitychange never reaches the renderer (the tray case) still
    // ends up silent. This COMPOSES with setEnabled below: the engine requires
    // enabled AND audible, so the user's mute preference is never overridden.
    petAudio.setAudibleGate(() => windowAudible(window));
    // Ambient-only gate (spec §5.2): ambient plays only in ALIVE. Not part of
    // setAudibleGate, because the donation modal plays sounds through the same engine.
    petAudio.setAmbientGate(() => ambientAllowed({
      visible: windowAnimatable(document),
      focused: focusedRef.current,
      modalOpen: activeModalRef.current !== null,
      joy: joyPendingRef.current,
      celebrating: celebrationRef.current?.isRunning() ?? false,
    }));

    // Enable audio BEFORE the first seeded activity so its SFX is audible,
    // and register a user-gesture unlock: Chromium autoplay policy keeps the
    // AudioContext `suspended` until a resume() runs inside a real gesture.
    petAudio.setEnabled(soundRef.current);
    // The same listeners stamp the last user input for the random-tip quiet
    // rule (spec §4.2); one extra passive wheel listener does the same.
    const stampInput = (): void => {
      lastInputAtRef.current = Date.now();
    };
    const unlockAudio = (): void => {
      stampInput();
      petAudio.unlock();
    };
    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    window.addEventListener('keydown', unlockAudio, { passive: true });
    window.addEventListener('wheel', stampInput, { passive: true });

    setCharacter(engine.pickSessionCharacter());
    engine.nextRandomActivity(); // seed a valid random act for this character

    // Single attention-listener path: the engine's attachFocusListeners owns
    // ALL blur/focus/visibilitychange wiring. Ambient audio gating rides the
    // same listeners via hooks (no duplicate listener set here).
    // Attention lost: hard-silence. silenceNow() stops AND RELEASES live
    // oscillator/gain nodes rather than ducking them — a muted graph with
    // running oscillators is a resource leak — and stops the cadence.
    //
    // Both hooks are wrapped: they run from window event listeners, and the
    // same reasoning as window-close-guard.ts applies — a failed sound must
    // never turn into a failed attention transition or take the widget down.
    const stopAmbient = (): void => {
      try {
        petAudio.silenceNow();
      } catch {
        /* audio teardown is best-effort — never break the pet's visuals */
      }
    };
    const startAmbient = (): void => {
      if (!soundRef.current) return;
      try {
        petAudio.scheduleAmbient(() => engineRef.current?.getActivity() ?? 'idle');
      } catch {
        /* re-arming the cadence is best-effort — visuals must survive */
      }
    };
    // ALIVE / CALM (spec §1.1): the same hooks drive the focus flag and the
    // rest timer (focus = never rests, visible + unfocused = rest after 60 s).
    const markAttention = (now: boolean): void => {
      focusedRef.current = now;
      setFocused(now);
      applyAttention(now, windowAnimatable(document), restRef.current);
    };
    const detachFocus = engine.attachFocusListeners(window, {
      onAttentionLost: () => { stopAmbient(); markAttention(false); },
      onAttentionGained: () => { markAttention(windowFocused(document)); startAmbient(); refreshKeysRef.current(); },
    });

    petAudio.scheduleAmbient(() => engineRef.current?.getActivity() ?? 'idle');

    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === VIP_STORAGE_KEY) syncVipFromStorage();
    };
    window.addEventListener('storage', onStorage);

    // The celebration state machine (prior + its own timer). "Running" is a
    // boolean inside it, never an activity-id comparison: 'syndicate-salute'
    // is a real VIP activity, so an id test both skipped capturing when the
    // pet genuinely idled on it and clobbered a real switch to it.
    celebrationRef.current = createCelebration({
      currentActivity: () => activityRef.current,
      isMascot: () => characterRef.current === 'mascot',
      setActivity: (a) => engineRef.current?.setActivity(a),
      setHackerMode: (m) => hackerRendererRef.current?.setMode(m),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
      onRunningChange: setCelebrating,
    });

    // Same-window ascension signal from DonationModal's onAscension (storage
    // events don't fire in the originating window): re-sync VIP flag, then
    // run the celebration.
    //
    // The mascot gets 'syndicate-salute' through the ENGINE (a member of
    // VIP_ACTIVITIES with real mascot CSS at pet.css: act-syndicate-salute
    // shows .m-vip-salute-scene and animates the salute arm/head), bounded by
    // CELEBRATION_MS. REDUCED MOTION: the CSS rule pauses that salute at its
    // 0% keyframe, i.e. the mascot's normal rest pose — the celebration is then
    // NOT visible as motion. We do not claim otherwise.
    const onAscension = (): void => {
      restRef.current?.wake(); // celebration event: leave rest, re-arm 8 s
      syncVipFromStorage();
      if (readVipFlag()) celebrationRef.current?.start();
    };
    window.addEventListener('nv-pet-ascension', onAscension);

    return () => {
      detachFocus();
      petAudio.stopAmbient();
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('nv-pet-ascension', onAscension);
      window.removeEventListener('wheel', stampInput);
      channelRef.current?.clear();
      stopHintRef.current();
      if (fadeTimerRef.current !== null) window.clearTimeout(fadeTimerRef.current);
      if (swapTimerRef.current !== null) window.clearTimeout(swapTimerRef.current);
      celebrationRef.current = null;
      engineRef.current = null;
    };
  }, [handleActivityChange, handleCue, syncVipFromStorage]);

  // ALIVE life (spec §1.2, §1.3): the dwell timer and the micro-action
  // scheduler, created once. They run only while ALIVE (life gate below).
  useEffect(() => {
    const setTimer = (fn: () => void, ms: number): unknown => window.setTimeout(fn, ms);
    const clearTimer = (id: unknown): void => window.clearTimeout(id as number);
    const timer = createActivityTimer({
      setTimer,
      clearTimer,
      onDue: () => {
        const engine = engineRef.current;
        // The celebration owns the pet for its 8 s; the timer has re-armed itself.
        if (!engine || (celebrationRef.current?.isRunning() ?? false)) return;
        timerSwitchRef.current = true;
        try {
          engine.nextRandomActivity();
        } finally {
          timerSwitchRef.current = false;
        }
      },
    });
    const micro = createMicroScheduler({
      setTimer,
      clearTimer,
      character: () => characterRef.current,
      activity: () => activityRef.current,
      activityRemainingMs: () => timer.remainingMs(),
      isBlocked: () => joyPendingRef.current || swappingRef.current || reducedMotionRef.current
        || (celebrationRef.current?.isRunning() ?? false),
      onMicro: applyMicro,
      onMicroEnd: () => setMicroId(null),
    });
    activityTimerRef.current = timer;
    microRef.current = micro;
    return () => {
      timer.stop();
      micro.stop();
      activityTimerRef.current = null;
      microRef.current = null;
    };
  }, [applyMicro]);

  // Click joy (spec §3): a 700 ms joy (300 ms reduced motion), THEN the modal.
  useEffect(() => {
    let restoreHacker = false;
    const celebrating = (): boolean => celebrationRef.current?.isRunning() ?? false;
    const clickJoy = createClickJoy({
      open: () => onOpenDonationRef.current(),
      reducedMotion: () => reducedMotionRef.current,
      canOpen: () => windowAnimatable(document),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
      onStart: () => {
        joyPendingRef.current = true;
        setMicroId(null);
        setJoy(celebrating() ? 'still' : 'hop');
        // The celebration owns the hacker canvas (spec §3.2): no intent swap then.
        restoreHacker = characterRef.current === 'hacker' && !celebrating();
        if (restoreHacker) {
          hackerRendererRef.current?.setMode('intent');
          if (reducedMotionRef.current) hackerRendererRef.current?.paintOnce();
        }
        try {
          petAudio.playChime();
        } catch {
          /* best-effort */
        }
        restartAmbientWindow(); // the joy chime is a non-ambient sound (spec §5.2)
      },
      onEnd: () => {
        joyPendingRef.current = false;
        setJoy(null);
        if (restoreHacker && !celebrating()) {
          hackerRendererRef.current?.setMode(hackerModeOf(activityRef.current));
          if (reducedMotionRef.current) hackerRendererRef.current?.paintOnce();
        }
        restoreHacker = false;
      },
    });
    joyRef.current = clickJoy;
    return () => {
      clickJoy.cancel();
      joyRef.current = null;
    };
  }, [restartAmbientWindow]);
  const startJoy = useCallback((): void => {
    joyRef.current?.click();
  }, []);

  // Modal open: keep at least 3 s of dwell for the return; modal closed: one
  // welcome-back hop (spec §3.3).
  const prevModalRef = useRef(activeModal);
  useEffect(() => {
    const was = prevModalRef.current;
    prevModalRef.current = activeModal;
    if (activeModal !== null) {
      resumeMinRef.current = MODAL_RESUME_MIN_MS;
      return;
    }
    if (!shouldWelcomeBack({
      wasModal: was !== null,
      modalOpen: false,
      visible: windowAnimatable(document),
      focused: focusedRef.current,
      reducedMotion: reducedMotionRef.current,
    })) return;
    if (characterRef.current === 'hacker') hackerRendererRef.current?.setMicro('chair-hop', 600);
    else setMicroId('hop');
  }, [activeModal]);

  // LIFE GATE: the dwell timer and micro-actions run only while ALIVE
  // (visible + focused + no modal + no joy); CALM pauses, HIDDEN stops.
  const alive = petAlive({ visible: pageVisible, focused, modalOpen: activeModal !== null, joy: joy !== null });
  useEffect(() => {
    applyPetLifeGate({ visible: pageVisible, alive, resumeMinMs: resumeMinRef.current }, activityTimerRef.current, microRef.current);
    if (alive) resumeMinRef.current = 0;
  }, [pageVisible, alive]);

  // NOTE: ambient audio focus-gating is wired THROUGH the engine's
  // attachFocusListeners hooks above (single listener path). Do NOT attach a
  // second blur/focus/visibilitychange set here — duplicate wiring was the
  // historical source of fighting listeners and is now merged into one.

  // Hacker canvas renderer lifecycle (only mounted for the hacker character).
  useEffect(() => {
    if (character !== 'hacker') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = PixelHackerRenderer.create(canvas);
    if (!renderer) return;
    hackerRendererRef.current = renderer;
    // The rAF loop is started/stopped ONLY by the visibility-gate effect
    // below — never here: a page (re)loaded while hidden to the tray must
    // not spin up drawing that nobody can see (destroy() below cancels it).
    return () => {
      renderer.destroy();
      hackerRendererRef.current = null;
    };
  }, [character]);

  // ANIMATION VISIBILITY GATE (idle-CPU fix) — suspend EVERY pet animation
  // driver while the page cannot be seen; resume it, same state and same
  // phase, when it can.
  //
  // Keys on the Page Visibility API ALONE — never on window blur/focus.
  // `visibilitychange` fires for both hide-to-tray and minimise (measured in
  // real Electron 31: both flip visibilityState to "hidden") and it does NOT
  // fire for a merely unfocused window, which is exactly the case that must
  // keep animating (a visible pet is a pet being looked at; freezing it
  // reads as a crash). See windowAnimatable for the full rationale.
  //
  // One listener per widget lifetime, removed in the cleanup, so no stacking
  // across hide/show cycles. The canvas loop itself is driven by the gate
  // effect below, which re-runs on every input of petAnimationMode.
  useEffect(() => {
    const applyVisibility = (): void => {
      const animatable = windowAnimatable(document);
      setPageVisible(animatable); // React owns nv-pet-paused on the root
      // Hidden: no rest timers run; shown again: keep the hover hold if the
      // cursor was over the pet, otherwise start awake and re-arm 8 s.
      hoverRef.current?.visibility(animatable);
      // Hidden: cancel JOY (never open the modal, spec §3.2) and the swap
      // crossfade timer (no pending pet timers while hidden, spec §7).
      // Hidden: the speaking channel and the hint gesture hold no timers (spec §7).
      if (!animatable) {
        channelRef.current?.clear();
        stopHintRef.current();
      }
      applyHiddenPetTimers(animatable, {
        cancelJoy: () => joyRef.current?.cancel(),
        clearSwap: () => {
          if (swapTimerRef.current !== null) window.clearTimeout(swapTimerRef.current);
          swapTimerRef.current = null;
          swappingRef.current = false;
          setSwapping(false);
        },
      });
    };
    applyVisibility();
    document.addEventListener('visibilitychange', applyVisibility);
    return () => {
      document.removeEventListener('visibilitychange', applyVisibility);
    };
  }, []);

  // CANVAS GATE — run / throttle / stop the hacker loop from the current
  // visibility, modal, reduced-motion and rest state. Declared after the
  // renderer-lifecycle effect so a new renderer exists when this runs.
  // start()/destroy() are idempotent, so same-mode re-runs cannot double-arm.
  useEffect(() => {
    const mode = petAnimationMode({ visible: pageVisible, modalOpen: activeModal !== null, focused, reducedMotion, restLevel });
    applyPetAnimationGate(mode, {
      start: () => hackerRendererRef.current?.start(),
      stop: () => {
        hackerRendererRef.current?.destroy();
        // A loop stopped before its first frame would leave a blank canvas.
        hackerRendererRef.current?.paintIfBlank();
      },
      setMaxFps: (n) => hackerRendererRef.current?.setMaxFps(n),
    });
  }, [character, pageVisible, activeModal, focused, reducedMotion, restLevel]);

  // Activity change -> switch rendered character animation/mode.
  useEffect(() => {
    if (character !== 'hacker') return;
    const renderer = hackerRendererRef.current;
    renderer?.setMode(hackerModeOf(activity));
    // Reduced motion (spec §6.2): the loop is stopped, so paint the new pose once.
    if (reducedMotion) renderer?.paintOnce();
  }, [character, activity, reducedMotion]);

  // One-click sound toggle (persists to localStorage, never triggers donation).
  const handleToggleSound = useCallback((event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    const next = !soundRef.current;
    soundRef.current = next;
    setSoundOn(next);
    persistSoundPreference(next);
    petAudio.setEnabled(next);
    if (next && engineRef.current) {
      const engine = engineRef.current;
      petAudio.scheduleAmbient(() => engine.getActivity());
    }
  }, []);

  // ── Pet advisor (wave 6B) card ──────────────────────────────────────
  // One tip at a time (registry priority), re-derived from push/query data,
  // the route and the persisted state — never from a timer. The pet itself
  // never animates, moves or plays a sound for a tip.
  const tips = usePetTips();
  const selected = useMemo<SelectedTip | null>(
    () => selectTip(
      { route: location.pathname, gatewayState: statusQuery.data?.state, keys: keysQuery.data?.keys, update: updatesQuery.data },
      tips,
      Date.now(),
    ),
    [location.pathname, statusQuery.data?.state, keysQuery.data, updatesQuery.data, tips],
  );
  // A NEW keys occurrence is stamped as lastShownAt (J: 24 h re-arm).
  useEffect(() => {
    if (selected?.stampAt !== undefined) markTipShown(selected.tip.id, selected.stampAt);
  }, [selected]);

  // ── One speaking channel + random tips + hint gesture (spec §4) ─────────
  const { openFeedback } = useModal();
  const tipsRef = useRef(tips);
  tipsRef.current = tips;
  const routeRef = useRef(location.pathname);
  routeRef.current = location.pathname;

  // Hint gesture (spec §4.6): 1.8 s, only while ALIVE and never during JOY or a
  // celebration (the card still shows). Dwell + micro pause for its duration.
  stopHintRef.current = (): void => {
    if (hintTimerRef.current === null) return;
    window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = null;
    setHint(null);
    if (characterRef.current === 'hacker' && !(celebrationRef.current?.isRunning() ?? false)) {
      hackerRendererRef.current?.setMode(hackerModeOf(activityRef.current));
    }
  };
  startHintRef.current = (routed: boolean): void => {
    const aliveNow = windowAnimatable(document) && focusedRef.current && activeModalRef.current === null;
    if (!aliveNow || joyPendingRef.current || (celebrationRef.current?.isRunning() ?? false)) return;
    stopHintRef.current();
    setHint(routed ? 'up' : 'down');
    activityTimerRef.current?.pause();
    microRef.current?.pause();
    const hacker = characterRef.current === 'hacker';
    if (hacker) {
      hackerRendererRef.current?.setMode('intent');
      if (reducedMotionRef.current) hackerRendererRef.current?.paintOnce();
    }
    try {
      if (hacker) petAudio.playHackerCursorTick();
      else petAudio.playChime();
    } catch {
      /* best-effort */
    }
    restartAmbientWindow(); // the cue is a non-ambient sound (spec §5.2)
    hintTimerRef.current = window.setTimeout(() => {
      hintTimerRef.current = null;
      setHint(null);
      if (hacker && !(celebrationRef.current?.isRunning() ?? false)) {
        hackerRendererRef.current?.setMode(hackerModeOf(activityRef.current));
        if (reducedMotionRef.current) hackerRendererRef.current?.paintOnce();
      }
      if (windowAnimatable(document) && focusedRef.current && activeModalRef.current === null && !joyPendingRef.current) {
        activityTimerRef.current?.resume();
        microRef.current?.resume();
      }
    }, HINT_GESTURE_MS);
  };

  // The channel host, re-bound every render (latest state setters and t).
  speakHostRef.current = {
    show: (item) => {
      if (item.kind === 'cue') setCueShown(true);
      else if (item.kind === 'thought') setThought(item.payload as ThoughtVariant);
      else if (item.kind === 'event') {
        setEventShown(true);
        startHintRef.current(true);
      } else {
        const shown = item.payload as ShownRandomTip;
        setRandomTip(shown);
        randomShownRef.current += 1;
        randomShownAtRef.current = Date.now();
        randomInteractedRef.current = false;
        const translate = tRef.current;
        setAnnouncement(translate('tip_announce', { title: translate(shown.tip.titleKey, shown.vars) }));
        startHintRef.current(shown.tip.route !== null);
      }
    },
    hide: (item, reason) => {
      if (item.kind === 'cue') {
        setCueShown(false);
        // Cue finished: the thought cloud follows (13000 ms).
        if (reason === 'timeout') showThought(activityRef.current, THOUGHT_MS);
      } else if (item.kind === 'thought') setThought(null);
      else if (item.kind === 'event') setEventShown(false);
      else {
        setRandomTip(null);
        const shown = item.payload as ShownRandomTip;
        const interacted = randomInteractedRef.current;
        randomInteractedRef.current = false;
        // Pre-empted by an event tip, cleared by a hide/unmount, or closed unread
        // (< 3 s, no dismiss/action): back to the pool, not counted (spec §4.1).
        // The 24 h lastShownAt stamp and the back-to-back id are written only for a tip the user saw.
        if (shouldCountTipShown(reason, Date.now() - randomShownAtRef.current, interacted)) {
          lastRandomIdRef.current = shown.tip.id;
          markTipShown(shown.tip.id, Date.now());
        } else {
          randomShownRef.current = Math.max(0, randomShownRef.current - 1);
        }
        // Cleared by a hide: the card shows on return (spec §4.6); the round stays open until then.
        if (shouldReofferTip(reason, interacted)) {
          pendingRandomTipRef.current = { id: shown.tip.id };
          stopHintRef.current();
          return;
        }
        randomSchedRef.current?.roundDone();
      }
      if (item.kind === 'event' || item.kind === 'random') stopHintRef.current();
    },
    drop: (item) => {
      if (item.kind === 'random') randomSchedRef.current?.roundDone();
    },
  };

  // Event tips (P0) enter the channel when an occurrence appears; they leave
  // when it is dismissed, acted on, or its condition turns false.
  // A hide clears the channel, so the still-valid occurrence is re-requested
  // when the page is visible again (pageVisible dep); never twice while shown.
  useEffect(() => {
    const channel = channelRef.current;
    if (!channel) return;
    if (selected === null) {
      channel.end('event');
      return;
    }
    if (!pageVisible) return;
    const shown = channel.current();
    if (shown?.kind === 'event' && (shown.payload as SelectedTip | undefined)?.occurrenceId === selected.occurrenceId) return;
    channel.request({ kind: 'event', durationMs: null, payload: selected });
  }, [selected?.occurrenceId, pageVisible]); // eslint-disable-line react-hooks/exhaustive-deps

  // Random tip round: fetch the facts (staleTime 60 s), select, queue.
  // pendingId: a re-offer round (spec §4.6) — the cleared tip is preferred only
  // if it still qualifies on the fresh facts (selectReofferTip).
  offerRandomTipRef.current = async (pendingId: string | null = null): Promise<void> => {
    const sched = randomSchedRef.current;
    try {
      if (randomShownRef.current >= RANDOM_TIPS_PER_SESSION || !tipsRef.current.enabled) {
        sched?.roundDone();
        return;
      }
      const fetchOr = <T,>(queryKey: readonly unknown[], queryFn: () => Promise<T>): Promise<T | null> =>
        queryClient.fetchQuery({ queryKey, queryFn, staleTime: 60_000 }).catch(() => null);
      const [runtime, models, keys, update] = await Promise.all([
        fetchOr(queryKeys.runtime, api.runtime),
        fetchOr(queryKeys.models, api.models),
        fetchOr(queryKeys.keys, api.keys),
        fetchOr(queryKeys.updates, api.updateStatus),
      ]);
      // Unmounted (scheduler gone) while fetching: touch no state.
      if (sched === null || randomSchedRef.current !== sched) return;
      const ctx = buildRandomTipContext({
        route: routeRef.current,
        runtime,
        models,
        keys,
        update,
        aliveMs: sched?.aliveMs() ?? 0,
        shown: randomShownRef.current,
        lastId: lastRandomIdRef.current,
      });
      const picked: SelectedRandomTip | null = pendingId === null
        ? selectRandomTip(ctx, tipsRef.current, Date.now())
        : selectReofferTip(pendingId, ctx, tipsRef.current, Date.now());
      const outcome = randomRoundOutcome(tipAliveRef.current, picked);
      // Hidden while fetching: show nothing, count nothing; the round re-offers on return.
      if (outcome === 'defer') {
        pendingRandomTipRef.current = { id: picked?.tip.id ?? pendingId };
        return;
      }
      if (outcome === 'none' || picked === null) {
        sched?.roundDone();
        return;
      }
      const translate = tRef.current;
      const title = translate(picked.tip.titleKey);
      const bodyText = translate(picked.tip.bodyKey, picked.vars);
      channelRef.current?.request({
        kind: 'random',
        durationMs: randomTipVisibleMs(title.length, bodyText.length),
        payload: { ...picked, occurrenceId: `random:${picked.tip.id}:${Date.now()}` } satisfies ShownRandomTip,
      });
    } catch {
      sched?.roundDone();
    }
  };

  // Random-tip cadence (mount once): first at 90 s of ALIVE time, then 240-360 s.
  useEffect(() => {
    const sched = createRandomTipScheduler({
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id as number),
      lastInputAt: () => lastInputAtRef.current,
      shownThisSession: () => randomShownRef.current,
      enabled: () => tipsRef.current.enabled,
      onDue: () => { void offerRandomTipRef.current(); },
    });
    randomSchedRef.current = sched;
    return () => {
      sched.stop();
      randomSchedRef.current = null;
    };
  }, []);
  // Main's own view of the window (window-state bridge). Without the bridge
  // (tests, older preload) mainVisible stays true: the document signals decide.
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.electronAPI : undefined;
    let live = true;
    const apply = (state: WindowState | null): void => {
      if (live) setMainVisible(mainWindowVisible(state));
    };
    const off = bridge?.onWindowState?.(apply);
    void bridge?.getWindowState?.().then(apply, () => {});
    return () => {
      live = false;
      off?.();
    };
  }, []);
  // The ALIVE clock runs only while the window is visible and focused, by the
  // document AND by main (the document alone ran it 3.4 h off screen under CDP).
  const tipAlive = tipClockAlive(pageVisible, focused, mainVisible);
  useEffect(() => {
    // A tip cleared by a hide before it was read shows on return (spec §4.6),
    // before the scheduler may pick a new one (its round is still open).
    // Never the stored payload: a FRESH round (fetch + selectReofferTip) re-checks
    // it. The scheduler round is still open (busy), so no second slot is used.
    tipAliveRef.current = tipAlive;
    const pending = pendingRandomTipRef.current;
    if (tipAlive && pending !== null) {
      pendingRandomTipRef.current = null;
      void offerRandomTipRef.current(pending.id);
    }
    randomSchedRef.current?.setAlive(tipAlive);
  }, [tipAlive]);
  // Tips switch: off stops random and event tips at once; on resumes the cadence.
  useEffect(() => {
    if (!tips.enabled) channelRef.current?.end('random');
    randomSchedRef.current?.refresh();
  }, [tips.enabled]);

  // Announcer: "Tip: {title}" once per occurrence, deferred while the cue or a
  // thought is speaking (their own polite regions) — an effect, not a timer.
  const busy = cueShown || thought !== null;
  const [announcement, setAnnouncement] = useState('');
  const announcedRef = useRef<string | null>(null);
  useEffect(() => {
    if (selected === null) {
      setAnnouncement('');
      return;
    }
    if (busy || announcedRef.current === selected.occurrenceId) return;
    announcedRef.current = selected.occurrenceId;
    const translate = tRef.current;
    setAnnouncement(translate('tip_announce', { title: translate(selected.tip.titleKey, selected.vars) }));
  }, [selected, busy]);

  // Keyboard focus inside the card, tracked with React focus props (no new
  // listener). When the card changes by itself the effect below, which runs
  // after the commit, returns focus that fell to body to the pet button.
  const focusInCardRef = useRef(false);
  const onCardBlur = (event: React.FocusEvent<HTMLElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) focusInCardRef.current = false;
  };
  // A new tip card is an event: wake, so its fade-in is not frozen by rest.
  useEffect(() => {
    if (selected?.occurrenceId !== undefined) restRef.current?.wake();
  }, [selected?.occurrenceId]);
  useEffect(() => {
    restoreCardFocus(focusInCardRef.current, document, widgetBtnRef.current);
    focusInCardRef.current = false;
  }, [selected?.occurrenceId]);

  // X / Escape: focus goes to the pet button first, so it never lands on body.
  const dismissTip = (current: SelectedTip): void => {
    widgetBtnRef.current?.focus();
    setAnnouncement('');
    dismissTipOccurrence(current.occurrenceId);
  };
  const actOnTip = (current: SelectedTip): void => {
    const { tip } = current;
    dismissTipOccurrence(current.occurrenceId);
    setAnnouncement('');
    navigate(tip.route, { state: { focusSetting: tip.targetId } });
  };
  // Bound on the card itself, so Escape only acts while focus is inside it.
  const onCardKeyDown = (current: SelectedTip) => (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      dismissTip(current);
    }
  };
  // Random tip card (spec §4.4): X counts as shown; the action navigates to the
  // target view and focuses the element (router state focusSetting, read by
  // focusPendingSetting there) or opens Feedback (R11); "never" persists.
  const closeRandomTip = (): void => {
    randomInteractedRef.current = true; // dismissed = seen (counts, spec §4.4)
    widgetBtnRef.current?.focus();
    setAnnouncement('');
    channelRef.current?.end('random');
  };
  const actOnRandomTip = (current: ShownRandomTip): void => {
    randomInteractedRef.current = true;
    setAnnouncement('');
    channelRef.current?.end('random');
    const { tip } = current;
    if (tip.action === 'feedback' || tip.route === null) {
      openFeedback();
      return;
    }
    navigate(tip.route, { state: { focusSetting: tip.targetId } });
  };
  const neverRandomTip = (current: ShownRandomTip): void => {
    neverShowTip(current.tip.id);
    closeRandomTip();
  };
  const onRandomCardKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeRandomTip();
    }
  };
  // The version is wrapped in <bdi dir="ltr"> so it reads correctly in RTL.
  const renderTipBody = (current: SelectedTip): React.ReactNode => {
    const version = current.vars?.v;
    if (version === undefined) return t(current.tip.bodyKey);
    const [before, after = ''] = t(current.tip.bodyKey, { v: VERSION_MARK }).split(VERSION_MARK);
    return <>{before}<bdi dir="ltr">{version}</bdi>{after}</>;
  };

  const thoughtTheme = isVip ? 'theme-vip' : character === 'mascot' ? 'theme-mascot' : 'theme-hacker';

  // Activity caption (spec §2.1, §2.3): decorative (aria-hidden); the button
  // keeps its accessible name. key = text, so each change replays the fade-in.
  // Priority: click joy, then the celebration (both characters), then the activity.
  const CaptionIcon: LucideIcon = joy !== null ? PartyPopper : celebrating ? Sparkles : CAPTION_ICONS[activity] ?? Sparkles;
  const captionText = joy !== null
    ? t('pet_caption_joy')
    : celebrating ? t('pet_caption_celebration') : t(captionKey(activity, captionIndex));
  const caption = (
    <div className={`pet-caption pet-caption-${character}`} aria-hidden="true">
      <span className="pet-caption-icon"><CaptionIcon size={14} strokeWidth={2} aria-hidden="true" /></span>
      <span key={captionText} className="pet-caption-text">{captionText}</span>
    </div>
  );

  // Speech-slot anchor (spec §11.2): while a thought or card is shown, mirror
  // the pet button rect into --pet-anchor-top/-bottom on the root (CSSOM
  // setProperty, allowed by style-src 'self'). Listeners live only while shown.
  const speaking = thought !== null || (selected !== null && eventShown) || randomTip !== null;
  // Layout effect: measure synchronously after commit and before paint, so the
  // first visible frame already has the real anchor (no one-frame jump under
  // reduced motion). speechKey re-runs it (re-measure) whenever a different
  // thought or card becomes visible while the slot stays occupied.
  const speechKey = `${thought !== null ? 't' : ''}|${selected !== null && eventShown ? selected.occurrenceId : ''}|${randomTip?.occurrenceId ?? ''}`;
  useLayoutEffect(() => {
    if (!speaking) return undefined;
    const cleanup = attachPetAnchor(rootRef.current, widgetBtnRef.current, window);
    return cleanup;
  }, [speaking, speechKey]);

  return (
    <div
      ref={rootRef}
      className={`nv-pet-wrap${isVip ? ' vip-mode' : ''} act-${activity}${crossfading ? ' activity-crossfade' : ''}${swapping ? ' activity-swap' : ''}${joy !== null ? ' nv-pet-joying' : ''}${pageVisible ? '' : ' nv-pet-paused'}${restLevel === 'awake' ? '' : ' nv-pet-rest'}${restLevel === 'deep' ? ' nv-pet-rest-deep' : ''}${hint !== null ? ` nv-pet-hint nv-pet-hint-${hint}` : ''}`}
    >


      {isVip && (
        <div className="vip-badge" title={t('pet_vip_badge_title')}>
          <span className="vip-badge-glyph">⚡</span>
          <span className="vip-badge-text">{t('pet_vip_badge_text')}</span>
          <span className="vip-badge-glow-dot" />
        </div>
      )}

      <div className="sidebar-widget-wrap">
        {/* ✦ CAUGHT IN THE ACT! attention-return visual cue */}
        <div className={`caught-in-act-cue${cueShown ? ' show' : ''}`} aria-live="polite">
          <span className="cue-sparkle">✦</span>
          <span className="cue-text">{t('pet_caught_cue')}</span>
          <span className="cue-sparkle">✦</span>
        </div>

        {/* Organic floating thought cloud */}
        <div
          className={`thought-cloud-container${thought !== null ? ' show' : ''} ${thoughtTheme}`}
          aria-live="polite"
        >
          <div className="thought-cloud-bubble">
            <span className="thought-emoji">{thought?.emoji ?? '💬'}</span>
            <span className="thought-text">{thought?.text ?? '...'}</span>
          </div>
          <div className="thought-trail">
            <div className="thought-dot thought-dot-1" />
            <div className="thought-dot thought-dot-2" />
          </div>
        </div>

        {/* 1-click neon sound toggle */}
        <button
          type="button"
          className={`widget-sound-toggle${soundOn ? '' : ' muted'}`}
          onClick={handleToggleSound}
          aria-label={soundOn ? t('pet_sound_on_aria') : t('pet_sound_off_aria')}
          title={soundOn ? t('pet_sound_on_tooltip') : t('pet_sound_off_tooltip')}
        >
          <span className="sound-toggle-indicator" />
          <svg className="sound-icon-on" viewBox="0 0 20 20" aria-hidden="true">
            <path
              d="M9 4L4 8H1v4h3l5 4V4z"
              strokeWidth="1.6"
              strokeLinejoin="round"
              fill="currentColor"
              fillOpacity="0.25"
            />
            <path d="M13 7.5a4 4 0 0 1 0 5" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M15.5 5a7.5 7.5 0 0 1 0 10" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <svg className="sound-icon-off" viewBox="0 0 20 20" aria-hidden="true">
            <path
              d="M9 4L4 8H1v4h3l5 4V4z"
              strokeWidth="1.6"
              strokeLinejoin="round"
              fill="currentColor"
              fillOpacity="0.25"
            />
            <line x1="2" y1="2" x2="18" y2="18" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>

        <button
          ref={widgetBtnRef}
          type="button"
          className="widget-btn"
          onClick={startJoy}
          onMouseEnter={holdPet}
          onMouseLeave={releasePet}
          onClickCapture={wakePet}
          aria-label={t('pet_support_aria')}
        >
          {character === 'mascot' ? (
            <div className="mascot-viewport">
            <svg className="mascot-svg" viewBox="0 0 130 120" aria-hidden="true">
              <defs>
                <linearGradient id="chassisGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#1E2833" />
                  <stop offset="100%" stopColor="#10161C" />
                </linearGradient>
                <linearGradient id="headGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#1B242E" />
                  <stop offset="100%" stopColor="#0E141A" />
                </linearGradient>
                <linearGradient id="visorGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#050A0E" />
                  <stop offset="100%" stopColor="#020508" />
                </linearGradient>
                <linearGradient id="plasmaGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#FFFFFF" />
                  <stop offset="25%" stopColor="#00F0FF" />
                  <stop offset="85%" stopColor="#33FF00" />
                  <stop offset="100%" stopColor="transparent" />
                </linearGradient>
                <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#FFF070" />
                  <stop offset="60%" stopColor="#FFD028" />
                  <stop offset="100%" stopColor="#B8800A" />
                </linearGradient>
                <linearGradient id="goldVisorGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#FFF59D" />
                  <stop offset="35%" stopColor="#FFD700" />
                  <stop offset="70%" stopColor="#FFB000" />
                  <stop offset="100%" stopColor="#D48800" />
                </linearGradient>
                <radialGradient id="reactorGoldGlow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#FFF59D" stopOpacity="1" />
                  <stop offset="45%" stopColor="#FFB000" stopOpacity="0.85" />
                  <stop offset="100%" stopColor="#FF8F00" stopOpacity="0" />
                </radialGradient>
              </defs>

              {/* Micro-action wrappers (spec §1.3): drift station + one-shot micro / joy beat. */}
              <g className="m-station" style={{ transform: `translateX(${station.x}px)`, transitionDuration: `${station.ms}ms` }}>
              <g
                className={`m-micro${microId !== null ? ` nv-pet-micro-${microId}` : ''}${joy === 'hop' ? ' nv-pet-joy' : ''}`}
                onAnimationEnd={onMicroAnimationEnd}
              >
              {/* SKELETAL RIG ROOT */}
              <g className="m-root-rig">
                {/* 1. JET THRUSTER NOZZLE & INDEPENDENT DUAL PLASMA FLAMES */}
                <g className="m-thruster-rig">
                  <rect x="42" y="96" width="14" height="8" rx="3" fill="#18222B" stroke="#2D3E4E" strokeWidth="1.2" />
                  <rect x="74" y="96" width="14" height="8" rx="3" fill="#18222B" stroke="#2D3E4E" strokeWidth="1.2" />
                  <g className="m-plasma-flame m-flame-left">
                    <polygon points="43,103 55,103 49,118" fill="url(#plasmaGrad)" />
                    <polygon className="m-flame-core" points="46,103 52,103 49,113" fill="#FFFFFF" />
                  </g>
                  <g className="m-plasma-flame m-flame-right">
                    <polygon points="75,103 87,103 81,118" fill="url(#plasmaGrad)" />
                    <polygon className="m-flame-core" points="78,103 84,103 81,113" fill="#FFFFFF" />
                  </g>
                  <circle
                    className="m-thrust-spark spark-1"
                    cx="49"
                    cy="106"
                    r="1.5"
                    fill="#33FF00"
                    style={{ '--sx': '-4px' } as React.CSSProperties}
                  />
                  <circle
                    className="m-thrust-spark spark-2"
                    cx="81"
                    cy="107"
                    r="1.5"
                    fill="#00F0FF"
                    style={{ '--sx': '5px' } as React.CSSProperties}
                  />
                  <circle
                    className="m-thrust-spark spark-3"
                    cx="65"
                    cy="108"
                    r="1.2"
                    fill="#FFFFFF"
                    style={{ '--sx': '-1px' } as React.CSSProperties}
                  />
                </g>

                {/* 2. MAIN TORSO / CHASSIS POD */}
                <g className="m-torso-chassis">
                  <rect x="36" y="68" width="58" height="32" rx="14" fill="url(#chassisGrad)" stroke="#324458" strokeWidth="1.5" />
                  <line x1="42" y1="78" x2="88" y2="78" stroke="#162029" strokeWidth="1.2" />
                  <circle cx="42" cy="74" r="1.2" fill="#3B4E60" />
                  <circle cx="88" cy="74" r="1.2" fill="#3B4E60" />
                  <circle cx="42" cy="92" r="1.2" fill="#3B4E60" />
                  <circle cx="88" cy="92" r="1.2" fill="#3B4E60" />

                  {/* Center Power Turbine Reactor Core */}
                  <circle cx="65" cy="84" r="9" fill="#070D12" stroke="#00F0FF" strokeWidth="1.4" />
                  <circle cx="65" cy="84" r="6" fill="#0E1C26" />
                  <g className="m-rotor-spin">
                    <line x1="65" y1="78" x2="65" y2="90" stroke="#33FF00" strokeWidth="1.4" strokeLinecap="round" />
                    <line x1="59" y1="84" x2="71" y2="84" stroke="#33FF00" strokeWidth="1.4" strokeLinecap="round" />
                    <line x1="61" y1="80" x2="69" y2="88" stroke="#00F0FF" strokeWidth="1.2" strokeLinecap="round" />
                    <line x1="61" y1="88" x2="69" y2="80" stroke="#00F0FF" strokeWidth="1.2" strokeLinecap="round" />
                  </g>
                  <circle cx="65" cy="84" r="2.2" fill="#FFFFFF" />

                  {/* Quantum Golden Reactor Core Overlay (Permanent VIP) */}
                  <g className="m-vip-reactor-glow">
                    <circle cx="65" cy="84" r="11" fill="url(#reactorGoldGlow)" />
                    <circle cx="65" cy="84" r="8.5" fill="#1C1402" stroke="#FFD028" strokeWidth="1.6" />
                    <g className="m-rotor-spin">
                      <line x1="65" y1="77" x2="65" y2="91" stroke="#FFE57F" strokeWidth="1.6" strokeLinecap="round" />
                      <line x1="58" y1="84" x2="72" y2="84" stroke="#FFE57F" strokeWidth="1.6" strokeLinecap="round" />
                      <line x1="60" y1="79" x2="70" y2="89" stroke="#FFB000" strokeWidth="1.4" strokeLinecap="round" />
                      <line x1="60" y1="89" x2="70" y2="79" stroke="#FFB000" strokeWidth="1.4" strokeLinecap="round" />
                    </g>
                    <circle cx="65" cy="84" r="2.8" fill="#FFFFFF" />
                    <circle
                      className="m-vip-ember ember-1"
                      cx="63"
                      cy="80"
                      r="1.4"
                      fill="#FFD028"
                      style={{ '--ex': '-5px' } as React.CSSProperties}
                    />
                    <circle
                      className="m-vip-ember ember-2"
                      cx="67"
                      cy="81"
                      r="1.3"
                      fill="#FFB000"
                      style={{ '--ex': '6px' } as React.CSSProperties}
                    />
                    <circle
                      className="m-vip-ember ember-3"
                      cx="65"
                      cy="78"
                      r="1.1"
                      fill="#FFE57F"
                      style={{ '--ex': '1px' } as React.CSSProperties}
                    />
                  </g>
                </g>

                {/* 3. ARTICULATED SPRING NECK JOINT */}
                <g className="m-neck-bellow">
                  <rect x="55" y="58" width="20" height="4" rx="2" fill="#243240" stroke="#3B4D5E" strokeWidth="1" />
                  <rect x="57" y="61" width="16" height="3" rx="1.5" fill="#151E26" />
                  <rect x="55" y="63" width="20" height="4" rx="2" fill="#243240" stroke="#3B4D5E" strokeWidth="1" />
                </g>

                {/* 4. HEAD ASSEMBLY WITH INDEPENDENT ROTATION/TILT */}
                <g className="m-head-rig">
                  <rect x="25" y="18" width="80" height="46" rx="18" fill="url(#headGrad)" stroke="#33FF00" strokeWidth="1.8" />
                  <rect x="18" y="32" width="8" height="18" rx="4" fill="#1A242E" stroke="#2E4050" strokeWidth="1.4" />
                  <rect x="104" y="32" width="8" height="18" rx="4" fill="#1A242E" stroke="#2E4050" strokeWidth="1.4" />
                  <line x1="22" y1="36" x2="22" y2="46" stroke="#33FF00" strokeWidth="1.2" />
                  <line x1="108" y1="36" x2="108" y2="46" stroke="#33FF00" strokeWidth="1.2" />

                  {/* Top Flexible Antenna Stalk & Sensor Dome */}
                  <line x1="65" y1="18" x2="65" y2="7" stroke="#33FF00" strokeWidth="2" strokeLinecap="round" />
                  <circle className="m-antenna-orb" cx="65" cy="6" r="4.5" fill="#33FF00" />
                  <circle cx="65" cy="6" r="2" fill="#FFFFFF" />

                  {/* Floating 3D Holographic Syndicate Crown/Halo (Permanent VIP) */}
                  <g className="m-vip-crown-halo">
                    <ellipse
                      className="m-vip-halo-ring"
                      cx="65"
                      cy="4"
                      rx="24"
                      ry="6"
                      fill="none"
                      stroke="url(#goldGrad)"
                      strokeWidth="2"
                      strokeDasharray="8 3"
                    />
                    <polygon
                      points="46,11 50,2 56,7 65,-4 74,7 80,2 84,11 65,8"
                      fill="url(#goldGrad)"
                      stroke="#FFF9C4"
                      strokeWidth="1.2"
                    />
                    <polygon points="65,0 67,4 65,7 63,4" fill="#FFFFFF" />
                    <circle cx="50" cy="3" r="1" fill="#FFFFFF" />
                    <circle cx="80" cy="3" r="1" fill="#FFFFFF" />
                  </g>

                  {/* Glossy Digital Visor Screen */}
                  <rect
                    className="m-visor-screen"
                    x="32"
                    y="24"
                    width="66"
                    height="34"
                    rx="12"
                    fill="url(#visorGrad)"
                    stroke="#223648"
                    strokeWidth="1.5"
                  />
                  <path d="M36 28 Q65 24 94 28" stroke="rgba(255, 255, 255, 0.15)" strokeWidth="1" fill="none" />

                  {/* High-Density Matrix LED Eyes */}
                  <g className="m-eyes-container">
                    <g className="m-blink-loop">
                      <g className="m-pupil-track">
                        <rect x="40" y="31" width="17" height="18" rx="6" fill="#09141B" stroke="#1D3342" strokeWidth="1" />
                        <rect x="44" y="34" width="8" height="11" rx="2.5" fill="#33FF00" />
                        <rect x="45" y="35" width="3" height="4" rx="1" fill="#FFFFFF" />
                        <rect x="73" y="31" width="17" height="18" rx="6" fill="#09141B" stroke="#1D3342" strokeWidth="1" />
                        <rect x="78" y="34" width="8" height="11" rx="2.5" fill="#33FF00" />
                        <rect x="79" y="35" width="3" height="4" rx="1" fill="#FFFFFF" />
                      </g>
                    </g>
                    {/* Visor Mouth Audio Grille */}
                    <line x1="56" y1="52" x2="74" y2="52" stroke="#00F0FF" strokeWidth="1.8" strokeLinecap="round" />
                  </g>

                  {/* Golden Cyber Polarized Shades Rig (Permanent VIP) */}
                  <g className="m-vip-shades-rig">
                    <polygon points="35,30 63,30 60,46 39,46" fill="url(#goldVisorGrad)" stroke="#FFF59D" strokeWidth="1.2" />
                    <polygon points="67,30 95,30 91,46 71,46" fill="url(#goldVisorGrad)" stroke="#FFF59D" strokeWidth="1.2" />
                    <line x1="61" y1="33" x2="69" y2="33" stroke="#FFD028" strokeWidth="2.5" />
                    <line x1="33" y1="30" x2="97" y2="30" stroke="#FFF59D" strokeWidth="1.4" />
                    <g className="m-shades-glint">
                      <line x1="44" y1="28" x2="52" y2="48" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" opacity="0.9" />
                      <line x1="76" y1="28" x2="84" y2="48" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" opacity="0.9" />
                    </g>
                  </g>
                </g>

                {/* VIP 4 : MATRIX HYPER-HACK PROPS (before arms so claws type on top) */}
                <g className="m-vip-hack-scene">
                  <g className="m-holo-kb-ring">
                    <path d="M24 88 Q65 104 106 88" fill="none" stroke="#FFD028" strokeWidth="4" strokeLinecap="round" opacity="0.85" />
                    <path d="M26 87 Q65 102 104 87" fill="none" stroke="#FFFFFF" strokeWidth="1" strokeDasharray="4 2" />
                  </g>
                  <text className="m-hex-stream-1" x="28" y="78" fontFamily="'JetBrains Mono', monospace" fontSize="6.5" fontWeight="bold" fill="#FFD028">0xVIP</text>
                  <text className="m-hex-stream-2" x="52" y="74" fontFamily="'JetBrains Mono', monospace" fontSize="6.5" fontWeight="bold" fill="#FFE57F">0xARCH</text>
                  <text className="m-hex-stream-3" x="82" y="76" fontFamily="'JetBrains Mono', monospace" fontSize="6.5" fontWeight="bold" fill="#FFB000">100TB</text>
                </g>

                {/* 5. MULTI-JOINTED LEFT ARM RIG */}
                <g className="m-arm-left-rig">
                  <circle cx="26" cy="72" r="4.5" fill="#1C2731" stroke="#33FF00" strokeWidth="1.2" />
                  <line x1="26" y1="72" x2="18" y2="84" stroke="#2C3D4D" strokeWidth="3" strokeLinecap="round" />
                  <circle cx="18" cy="84" r="3.5" fill="#141E26" stroke="#00F0FF" strokeWidth="1" />
                  <line x1="18" y1="84" x2="16" y2="94" stroke="#3A4F63" strokeWidth="2.5" strokeLinecap="round" />
                  <g className="m-claw-l">
                    <path d="M13 94 L11 100 M16 95 L16 102 M19 94 L21 100" stroke="#33FF00" strokeWidth="1.5" strokeLinecap="round" />
                  </g>
                </g>

                {/* 6. MULTI-JOINTED RIGHT ARM RIG WITH NESTED IN-HAND PROPS */}
                <g className="m-arm-right-rig">
                  <circle cx="104" cy="72" r="4.5" fill="#1C2731" stroke="#33FF00" strokeWidth="1.2" />
                  <line x1="104" y1="72" x2="112" y2="84" stroke="#2C3D4D" strokeWidth="3" strokeLinecap="round" />
                  <circle cx="112" cy="84" r="3.5" fill="#141E26" stroke="#00F0FF" strokeWidth="1" />
                  <line x1="112" y1="84" x2="114" y2="94" stroke="#3A4F63" strokeWidth="2.5" strokeLinecap="round" />
                  <g className="m-claw-r">
                    <path d="M111 94 L109 100 M114 95 L114 102 M117 94 L119 100" stroke="#33FF00" strokeWidth="1.5" strokeLinecap="round" />

                    {/* IN-HAND PROP 1: BLASTER CANNON (Bug Hunter) */}
                    <g className="m-cannon-prop">
                      <rect x="108" y="93" width="14" height="7" rx="2" fill="#1E2B38" stroke="#00F0FF" strokeWidth="1.2" />
                      <rect x="120" y="94" width="4" height="5" rx="1" fill="#33FF00" />
                      <line className="m-laser-strike" x1="124" y1="96" x2="108" y2="28" />
                    </g>

                    {/* IN-HAND PROP 2: MICROFIBER CLOTH (Sensor Polish) */}
                    <g className="m-polish-cloth">
                      <rect x="109" y="94" width="10" height="10" rx="3" fill="#00F0FF" stroke="#FFFFFF" strokeWidth="1" opacity="0.9" />
                    </g>

                    {/* IN-HAND PROP 3: NANO ESPRESSO CUP (Nano Coffee) */}
                    <g className="m-coffee-cup">
                      <rect x="108" y="93" width="12" height="14" rx="3" fill="#243340" stroke="#33FF00" strokeWidth="1.2" />
                      <path d="M120 96 Q124 100 120 104" fill="none" stroke="#33FF00" strokeWidth="1.2" />
                      <g className="m-coffee-steam">
                        <path d="M110 90 Q114 86 118 90 M111 85 Q114 81 117 85" fill="none" stroke="#00F0FF" strokeWidth="1" strokeLinecap="round" />
                      </g>
                    </g>

                    {/* IN-HAND PROP 4: GOLDEN TOAST MUG (VIP Toast) */}
                    <g className="m-toast-mug">
                      <rect x="108" y="92" width="13" height="15" rx="3" fill="#2E2406" stroke="#FFD028" strokeWidth="1.4" />
                      <rect x="110" y="94" width="9" height="4" rx="1" fill="#FFD028" />
                      <path d="M121 95 Q126 99 121 104" fill="none" stroke="#FFD028" strokeWidth="1.4" />
                      <g className="m-gold-steam">
                        <path d="M110 88 Q114 83 118 88 M111 82 Q115 77 119 82" fill="none" stroke="#FFE57F" strokeWidth="1.4" strokeLinecap="round" />
                      </g>
                    </g>
                  </g>
                </g>

                {/* ACTIVITY 1 : BUG HUNTER (Reticle + Evading Cyber Bug) */}
                <g className="m-bug-group">
                  <g className="m-target-reticle">
                    <circle cx="106" cy="26" r="10" fill="none" stroke="#FF2E63" strokeWidth="1" strokeDasharray="3 2" />
                  </g>
                  <g className="m-target-bug">
                    <ellipse cx="106" cy="26" rx="4" ry="3" fill="#FF2E63" />
                    <circle cx="104" cy="25" r="1" fill="#FFFFFF" />
                    <circle cx="108" cy="25" r="1" fill="#FFFFFF" />
                    <ellipse className="m-bug-wing-l" cx="103" cy="22" rx="3.5" ry="1.5" fill="rgba(0, 240, 255, 0.7)" />
                    <ellipse className="m-bug-wing-r" cx="109" cy="22" rx="3.5" ry="1.5" fill="rgba(0, 240, 255, 0.7)" />
                    <polygon points="106,20 108,24 112,26 108,28 106,32 104,28 100,26 104,24" fill="#FFD028" opacity="0.85" />
                  </g>
                </g>

                {/* ACTIVITY 2 : LOW BATTERY HUD */}
                <g className="m-low-batt-hud">
                  <rect x="52" y="32" width="26" height="15" rx="3" fill="#0A0406" stroke="#FF2E63" strokeWidth="1.5" />
                  <rect x="78" y="36" width="2" height="7" rx="1" fill="#FF2E63" />
                  <rect x="55" y="35" width="6" height="9" rx="1" fill="#FF2E63" />
                  <text x="65" y="44" fontFamily="'JetBrains Mono', monospace" fontSize="8" fontWeight="bold" fill="#FF2E63" textAnchor="middle">!</text>
                </g>

                {/* ACTIVITY 3 : TURBINE GENERATOR FX */}
                <g className="m-turbine-fx">
                  <path className="m-plasma-arc" d="M30 76 Q45 84 60 84 M100 76 Q85 84 70 84" fill="none" stroke="#00F0FF" strokeWidth="2" />
                  <circle cx="65" cy="84" r="13" fill="none" stroke="#33FF00" strokeWidth="1" strokeDasharray="3 2" />
                </g>

                {/* ACTIVITY 4 : SENSOR POLISH GLINT */}
                <g className="m-polish-fx">
                  <polygon className="m-polish-glint" points="48,34 51,40 57,43 51,46 48,52 45,46 39,43 45,40" fill="#FFFFFF" />
                </g>

                {/* ACTIVITY 5 : MODEL JUGGLER CUBES */}
                <g className="m-juggler-fx">
                  <g className="j-cube-1">
                    <rect x="-6" y="-6" width="12" height="12" rx="3" fill="#00F0FF" stroke="#FFFFFF" strokeWidth="0.8" />
                    <text x="0" y="3" fontFamily="'JetBrains Mono', monospace" fontSize="6" fontWeight="bold" fill="#05141C" textAnchor="middle">70B</text>
                  </g>
                  <g className="j-cube-2">
                    <rect x="-6" y="-6" width="12" height="12" rx="3" fill="#33FF00" stroke="#FFFFFF" strokeWidth="0.8" />
                    <text x="0" y="3" fontFamily="'JetBrains Mono', monospace" fontSize="6" fontWeight="bold" fill="#051405" textAnchor="middle">8B</text>
                  </g>
                  <g className="j-cube-3">
                    <rect x="-6" y="-6" width="12" height="12" rx="3" fill="#FFD028" stroke="#FFFFFF" strokeWidth="0.8" />
                    <text x="0" y="3" fontFamily="'JetBrains Mono', monospace" fontSize="5" fontWeight="bold" fill="#1C1405" textAnchor="middle">MoE</text>
                  </g>
                </g>

                {/* ACTIVITY 6 : NANO COFFEE flag anchor */}
                <g className="m-coffee-fx" />

                {/* ACTIVITY 7 : POWER NAP (Sleepy eyes + sinusoidal Zzz) */}
                <g className="m-nap-fx">
                  <path d="M42 42 Q48 46 54 42" fill="none" stroke="#33FF00" strokeWidth="2.5" strokeLinecap="round" />
                  <path d="M76 42 Q82 46 88 42" fill="none" stroke="#33FF00" strokeWidth="2.5" strokeLinecap="round" />
                  <text className="nap-zzz-1" x="0" y="0" fontFamily="'JetBrains Mono', monospace" fontSize="10" fontWeight="bold" fill="#33FF00">Z</text>
                  <text className="nap-zzz-2" x="0" y="0" fontFamily="'JetBrains Mono', monospace" fontSize="8" fontWeight="bold" fill="#00F0FF">z</text>
                  <text className="nap-zzz-3" x="0" y="0" fontFamily="'JetBrains Mono', monospace" fontSize="7" fill="#33FF00">z</text>
                </g>

                {/* VIP EXCLUSIVE SCENE PROPS */}
                <g className="m-vip-salute-scene">
                  <line x1="88" y1="60" x2="120" y2="52" stroke="#FFD028" strokeWidth="1.5" strokeDasharray="3 2" opacity="0.8" />
                </g>
                <g className="m-vip-toast-scene" />
                <g className="m-vip-wink-scene">
                  <polygon className="m-wink-lens-flare" points="44,28 46,34 52,36 46,38 44,44 42,38 36,36 42,34" fill="#FFFFFF" />
                </g>
                <g className="m-vip-meditation-scene">
                  <g className="m-quantum-matrix-ring">
                    <ellipse className="q-ring-outer" cx="65" cy="65" rx="58" ry="18" fill="none" stroke="#FFD028" strokeWidth="1.8" strokeDasharray="8 4" />
                    <ellipse className="q-ring-inner" cx="65" cy="65" rx="46" ry="14" fill="none" stroke="#FFE57F" strokeWidth="1" strokeDasharray="4 3" />
                    <g className="m-quantum-node-1">
                      <circle cx="7" cy="65" r="3" fill="#FFD028" />
                      <polygon points="7,62 9,65 7,68 5,65" fill="#FFFFFF" />
                    </g>
                    <g className="m-quantum-node-2">
                      <circle cx="123" cy="65" r="3" fill="#FFD028" />
                      <polygon points="123,62 125,65 123,68 121,65" fill="#FFFFFF" />
                    </g>
                  </g>
                </g>

                {/* EASTER EGG : DATA-DISK TOSS */}
                <g className="m-vip-disk-scene">
                  <g className="m-tossed-disk">
                    <ellipse cx="65" cy="40" rx="14" ry="7" fill="url(#goldGrad)" stroke="#FFFFFF" strokeWidth="1" />
                    <ellipse cx="65" cy="40" rx="6" ry="3" fill="#1A1202" stroke="#FFE57F" strokeWidth="0.8" />
                    <text x="65" y="42" fontFamily="'JetBrains Mono', monospace" fontSize="4" fontWeight="bold" fill="#FFE57F" textAnchor="middle">100TB</text>
                  </g>
                </g>
              </g>
              </g>
              </g>
            </svg>
            </div>
          ) : (
            <div className="hacker-viewport">
              <div className="crt-casing">
                <div className="crt-screen">
                  <div className="crt-term-line">
                    <span className="crt-term-prompt">&gt;</span>
                    <span className="crt-type-text">nv-gateway --serve</span>
                    <span className="crt-cursor" />
                  </div>
                  <div className="hacker-stage">
                    <canvas ref={canvasRef} width={160} height={152} />
                  </div>
                </div>
                <div className="crt-brand">
                  <span>TRM-80 · DEV PET</span>
                  <span className="crt-led" />
                </div>
              </div>

              {/* Dev tip jar row */}
              <div className="jar-box">
                <svg className="jar-svg px" viewBox="0 0 34 42" shapeRendering="crispEdges" aria-hidden="true">
                  <rect x="7" y="3" width="4" height="2" fill="#2C3A48" />
                  <rect x="23" y="3" width="4" height="2" fill="#2C3A48" />
                  <path
                    d="M10 5 h14 v2 h2 v2 h2 v26 h-2 v2 h-2 v2 h-14 v-2 h-2 v-2 h-2 v-26 h2 v-2 h2 z"
                    fill="rgba(0, 240, 255, 0.05)"
                    stroke="#3A4B5C"
                    strokeWidth="1"
                  />
                  <rect x="9" y="11" width="2" height="10" fill="rgba(220, 229, 237, 0.08)" />
                  <g fill="#FFD028">
                    <rect x="11" y="34" width="10" height="3" />
                    <rect x="15" y="31" width="10" height="3" />
                    <rect x="10" y="28" width="10" height="3" />
                  </g>
                  <g className="h-coin-drop-loop" fill="#FFD028">
                    <rect x="12" y="0" width="10" height="3" />
                  </g>
                </svg>
                {caption}
              </div>
            </div>
          )}

          {character === 'mascot' && caption}
          <div className="pet-hint" aria-hidden="true">
            <Heart size={11} aria-hidden="true" />
            <span>{t('pet_hint_donate')}</span>
          </div>
        </button>

        {selected !== null && eventShown && (
          <section
            key={selected.occurrenceId}
            className="advice-card"
            aria-labelledby={ADVICE_TITLE_ID}
            data-hint={hint !== null ? '' : undefined}
            onKeyDown={onCardKeyDown(selected)}
            onFocus={() => { focusInCardRef.current = true; }}
            onBlur={onCardBlur}
          >
            <div className="advice-head">
              <span className="advice-label">{t('tip_label')}</span>
              <button
                type="button"
                className="advice-dismiss"
                aria-label={t('tip_dismiss')}
                onClick={() => dismissTip(selected)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <h2 id={ADVICE_TITLE_ID} tabIndex={-1} className="advice-title">{t(selected.tip.titleKey)}</h2>
            <p className="advice-body">{renderTipBody(selected)}</p>
            <button type="button" className="advice-action" onClick={() => actOnTip(selected)}>
              {t(selected.tip.actionKey)}
            </button>
          </section>
        )}
        {randomTip !== null && !eventShown && (
          <section
            key={randomTip.occurrenceId}
            className="advice-card advice-card-random"
            aria-labelledby={ADVICE_TITLE_ID}
            data-hint={hint !== null ? '' : undefined}
            onKeyDown={onRandomCardKeyDown}
            onMouseEnter={() => channelRef.current?.hold(true)}
            onMouseLeave={() => channelRef.current?.hold(false)}
            onFocus={() => { focusInCardRef.current = true; channelRef.current?.hold(true); }}
            onBlur={(event) => { onCardBlur(event); if (!event.currentTarget.contains(event.relatedTarget as Node | null)) channelRef.current?.hold(false); }}
          >
            <div className="advice-head">
              <span className="advice-label">
                <Sparkles size={14} aria-hidden="true" />
                {t(randomTip.tip.kind === 'setting' ? 'tip_label_setting' : 'tip_label')}
              </span>
              <button type="button" className="advice-dismiss" aria-label={t('tip_dismiss')} onClick={closeRandomTip}>
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <h2 id={ADVICE_TITLE_ID} tabIndex={-1} className="advice-title">{t(randomTip.tip.titleKey)}</h2>
            <p className="advice-body">{t(randomTip.tip.bodyKey, randomTip.vars)}</p>
            <button type="button" className="advice-action" onClick={() => actOnRandomTip(randomTip)}>
              {t(randomTip.tip.actionKey)}
            </button>
            <button type="button" className="advice-never" onClick={() => neverRandomTip(randomTip)}>
              {t('tip_never')}
            </button>
          </section>
        )}
        <p className="advice-announcement" aria-live="polite" aria-atomic="true">{announcement}</p>
      </div>
    </div>
  );
}

// ==========================================
// PIXEL HACKER CANVAS 2D RENDERER
// Ported from interactive-showcase.html class PixelHackerEngine (#hackerCanvas).
// Backing store 160x152; displayed 80x76 via CSS pixelated scaling.
// The DOM/state-global coupling of the mockup is replaced by an explicit
// setMode() API driven by the pet engine's activity changes. Audio coupling
// lives in PetWidget / petAudio, NOT here.
// ==========================================

interface MatrixColumn {
  x: number;
  y: number;
  speed: number;
  chars: string[];
}

interface SmokePuff {
  x: number;
  y: number;
  vy: number;
  vx: number;
  size: number;
  alpha: number;
  color: string;
}

interface ConfettiPiece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rot: number;
  rotSpeed: number;
}

interface SnoreGlyph {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
}

interface KatanaSpark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  alpha: number;
}

interface SteamPuff {
  x: number;
  y: number;
  vy: number;
  alpha: number;
}

interface VipEmber {
  x: number;
  y: number;
  vy: number;
  size: number;
  alpha: number;
}

/** Caps at or above this rate skip rAF ticks instead of waiting on a timeout. */
const FRAME_SKIP_MIN_FPS = 24;
/** Tolerance for rAF jitter, so a 60 Hz display draws every 2nd tick (~30 fps). */
const FRAME_SKIP_SLACK_MS = 4;

export class PixelHackerRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly width = 160;
  private readonly height = 152;
  private rafId = 0;
  /** Pending throttle timeout between frames while setMaxFps is active. */
  private throttleId: ReturnType<typeof setTimeout> | null = null;
  private maxFps: number | null = null;
  private painted = false;
  /** Running micro-action (spec §1.3), its progress clock and direction. */
  private microId: string | null = null;
  private microElapsed = 0;
  private microDur = 1;
  private microDir = 1;

  private lastTime = performance.now();
  private stateTimer = 0;
  private mode = 'idle';
  private prevMode = '';

  private smokePuffs: SmokePuff[] = [];
  private confetti: ConfettiPiece[] = [];
  private snores: SnoreGlyph[] = [];
  private katanaSparks: KatanaSpark[] = [];
  private steamParticles: SteamPuff[] = [];
  private vipEmbers: VipEmber[] = [];
  private matrixColumns: MatrixColumn[] = [];

  private disk = { x: 80, y: 80, vy: -6, rot: 0, active: false };

  private constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
    canvas.width = this.width;
    canvas.height = this.height;

    // Initialize 10 matrix rain columns
    for (let c = 0; c < 10; c++) {
      this.matrixColumns.push({
        x: 8 + c * 16,
        y: Math.random() * this.height,
        speed: 18 + Math.random() * 32,
        chars: ['0', '1', '>', '#', '*', 'x', '7', 'F', '$', ';'],
      });
    }

    this.initConfetti();
  }

  /** Factory — returns null when a 2D context is unavailable. */
  static create(canvas: HTMLCanvasElement): PixelHackerRenderer | null {
    const ctx = canvas.getContext('2d');
    return ctx ? new PixelHackerRenderer(canvas, ctx) : null;
  }

  start(): void {
    // A pending throttle timeout is an armed loop too: never arm a second one.
    if (this.rafId === 0 && this.throttleId === null) {
      this.lastTime = performance.now();
      this.rafId = requestAnimationFrame(this.loop);
    }
  }

  destroy(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.throttleId !== null) {
      clearTimeout(this.throttleId);
      this.throttleId = null;
    }
  }

  /**
   * Cap the loop's frame rate (null = every rAF). While set, each frame
   * schedules the next rAF through a 1000/n ms timeout. The per-frame dt
   * clamp (0.1 s) already covers the 83 ms step at 12 fps.
   */
  setMaxFps(n: number | null): void {
    this.maxFps = n !== null && n > 0 ? n : null;
  }

  /** Draw one frame if none was ever drawn (a loop stopped before its first frame). */
  paintIfBlank(): void {
    if (!this.painted) this.step(performance.now());
  }

  setMode(mode: string): void {
    this.mode = mode;
  }

  /** Draw exactly one frame now (reduced motion: the loop is stopped, spec §6.2). */
  paintOnce(): void {
    this.step(performance.now());
  }

  /** Start a micro-action beat (spec §1.3); render() applies its offsets. */
  setMicro(id: string, durationMs: number): void {
    this.microId = id;
    this.microElapsed = 0;
    this.microDur = Math.max(0.05, durationMs / 1000);
    this.microDir = Math.random() < 0.5 ? -1 : 1;
  }

  /** 0..1 progress of micro `id`, or -1 when it is not running. */
  private microT(id: string): number {
    return this.microId === id ? Math.min(1, this.microElapsed / this.microDur) : -1;
  }

  private initConfetti(): void {
    this.confetti = [];
    const colors = ['#FFD028', '#00F0FF', '#33FF00', '#FF2E63', '#FFFFFF', '#B55FE6'];
    for (let i = 0; i < 26; i++) {
      this.confetti.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        vy: 24 + Math.random() * 40,
        vx: (Math.random() - 0.5) * 16,
        size: 2 + (i % 3) * 2,
        color: colors[i % colors.length],
        rot: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 5,
      });
    }
  }

  private resetModeState(mode: string): void {
    this.stateTimer = 0;
    this.smokePuffs = [];
    this.snores = [];
    this.katanaSparks = [];
    this.steamParticles = [];

    if (mode === 'disk-toss') {
      this.disk = { x: 80, y: 92, vy: -5.5, rot: 0, active: true };
    } else if (mode === 'zero-errors' || mode === 'celebration') {
      this.initConfetti();
    }
  }

  // Draw utilities
  private drawPixel(x: number, y: number, color: string, size = 1): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.floor(x), Math.floor(y), size, size);
  }

  private drawRect(x: number, y: number, w: number, h: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.floor(x), Math.floor(y), Math.floor(w), Math.floor(h));
  }

  private drawPixelText(text: string, x: number, y: number, color: string, size = 8): void {
    this.ctx.fillStyle = color;
    this.ctx.font = `bold ${size}px 'JetBrains Mono', monospace`;
    this.ctx.fillText(text, Math.floor(x), Math.floor(y));
  }

  private step(timestamp: number): void {
    const dt = Math.min((timestamp - this.lastTime) / 1000, 0.1);
    this.lastTime = timestamp;

    if (this.mode !== this.prevMode) {
      this.resetModeState(this.mode);
      this.prevMode = this.mode;
    }

    this.stateTimer += dt;
    if (this.microId !== null) {
      this.microElapsed += dt;
      if (this.microElapsed >= this.microDur) this.microId = null;
    }
    this.render(timestamp / 1000, dt);
    this.painted = true;
  }

  private readonly loop = (timestamp: number): void => {
    this.rafId = 0;
    const fps = this.maxFps;
    // A cap at or above FRAME_SKIP_MIN_FPS (the ALIVE 30 fps) skips rAF ticks
    // that come too soon instead of arming a timeout, so a running loop always
    // holds exactly one rAF and no extra timer.
    if (fps !== null && fps >= FRAME_SKIP_MIN_FPS) {
      if (!this.painted || timestamp - this.lastTime >= 1000 / fps - FRAME_SKIP_SLACK_MS) this.step(timestamp);
      this.rafId = requestAnimationFrame(this.loop);
      return;
    }
    this.step(timestamp);

    if (fps !== null) {
      this.throttleId = setTimeout(() => {
        this.throttleId = null;
        this.rafId = requestAnimationFrame(this.loop);
      }, 1000 / fps);
    } else {
      this.rafId = requestAnimationFrame(this.loop);
    }
  };

  private render(time: number, dt: number): void {
    const isVip =
      this.mode.startsWith('vip-') || this.mode === 'patron' || this.mode === 'disk-toss';
    const mode = this.mode;

    // 1. Clear screen & ambient phosphor backing
    this.ctx.clearRect(0, 0, this.width, this.height);

    if (mode === 'zero-errors' || mode === 'celebration') {
      const glowAlpha = 0.18 + Math.sin(this.stateTimer * 6) * 0.08;
      this.ctx.fillStyle = `rgba(0, 255, 102, ${glowAlpha})`;
      this.ctx.fillRect(0, 0, this.width, this.height);
    } else if (isVip) {
      this.ctx.fillStyle = 'rgba(255, 208, 40, 0.05)';
      this.ctx.fillRect(0, 0, this.width, this.height);
    }

    // 2. Matrix digital rain background
    this.renderMatrixRain(dt, isVip);

    // Micro H7 roll: chair, torso and head roll dx 0 -> ±6 -> 0; the desk stays.
    const rollT = this.microT('roll');
    const rollDx = rollT >= 0 ? Math.round(Math.sin(Math.PI * rollT) * 6 * this.microDir) : 0;
    this.ctx.save();
    this.ctx.translate(rollDx, 0);

    // 3. Chair backdrop
    this.renderChair(time, isVip, mode);

    // 4. Character parameters
    let jumpY = 0;
    if (mode === 'zero-errors' || mode === 'celebration') {
      jumpY = -Math.abs(Math.sin(this.stateTimer * 6)) * 14;
    } else if (mode === 'vip-quantum-meditation') {
      jumpY = Math.sin(time * 2.5) * 9 - 4;
    }

    let headBobY = Math.sin(time * 2.8) * 1.5;
    if (mode === 'code-frenzy' || mode === 'vip-hyper-hack') {
      headBobY = Math.sin(time * 24) * 2.2;
    } else if (mode === 'terminal-nap') {
      headBobY = 32; // slumped onto keyboard
    } else if (mode === 'empty-mug' && (this.stateTimer % 4.8) > 1.2 && (this.stateTimer % 4.8) < 3.2) {
      headBobY = -3; // head tilted back to drink
    }

    // Micro H6 chair-hop and H5 lean.
    const hopT = this.microT('chair-hop');
    if (hopT >= 0) jumpY += -Math.abs(Math.sin(Math.PI * hopT)) * 6;
    const leanT = this.microT('lean');
    if (leanT >= 0) headBobY += 3 * Math.sin(Math.PI * leanT);

    // 5. Hacker body & hood
    this.renderHackerTorso(jumpY, isVip);
    this.renderHackerHead(jumpY, headBobY, isVip, mode, time);
    this.ctx.restore();

    // 6. Desk & mechanical keyboard
    this.renderDeskAndKeyboard(time, isVip, mode);

    // 7. Hands & mode-specific action layers
    this.renderActionLayer(jumpY, isVip, mode, time, dt);
    this.renderMicroArms(jumpY, isVip, mode, time);

    // 8. Foreground particles
    this.renderForegroundParticles(dt, mode, isVip);
  }

  private renderMatrixRain(dt: number, isVip: boolean): void {
    for (let i = 0; i < this.matrixColumns.length; i++) {
      const col = this.matrixColumns[i];
      col.y += col.speed * dt;
      if (col.y > this.height + 40) {
        col.y = -20 - Math.random() * 30;
        col.speed = 18 + Math.random() * 32;
      }

      // Streaming glyphs per column
      const charCount = 4;
      for (let g = 0; g < charCount; g++) {
        const py = col.y - g * 8;
        if (py >= 0 && py < this.height - 30) {
          const ch = col.chars[(Math.floor(col.y * 0.1) + g) % col.chars.length];
          const isLead = g === 0;
          if (isVip) {
            this.ctx.fillStyle = isLead ? '#FFF9C4' : g === 1 ? '#FFD028' : 'rgba(255, 208, 40, 0.3)';
          } else {
            this.ctx.fillStyle = isLead ? '#E8FFE8' : g === 1 ? '#33FF00' : 'rgba(51, 255, 0, 0.25)';
          }
          this.ctx.font = "bold 6px 'JetBrains Mono', monospace";
          this.ctx.fillText(ch, col.x, py);
        }
      }
    }
  }

  private renderChair(time: number, isVip: boolean, mode: string): void {
    let chairSway = 0;
    if (mode === 'celebration') {
      chairSway = Math.sin(time * 8) * 2;
    }
    // Micro H2 chair-sway (half amplitude in the nap).
    if (this.microT('chair-sway') >= 0) chairSway += Math.sin(time * 8) * 2 * (mode === 'terminal-nap' ? 0.5 : 1);

    const cx = 44 + chairSway;
    const cy = 30;
    const cw = 72;
    const ch = 76;

    const frameColor = isVip ? '#2A2005' : '#0B1A0B';
    const innerColor = isVip ? '#1A1302' : '#040C04';
    const ribColor = isVip ? '#FFD028' : '#143814';

    this.drawRect(cx, cy, cw, ch, frameColor);
    this.drawRect(cx + 4, cy + 4, cw - 8, ch - 8, innerColor);

    // Ribbing & gold accent piping
    this.drawRect(cx + 6, cy + 18, cw - 12, 2, ribColor);
    this.drawRect(cx + 6, cy + 36, cw - 12, 2, ribColor);
    this.drawRect(cx + 6, cy + 54, cw - 12, 2, ribColor);

    if (isVip) {
      this.drawRect(cx, cy, cw, 2, '#FFD028');
      this.drawRect(cx + cw / 2 - 8, cy - 2, 16, 2, '#FFE57F');
    }
  }

  private renderDeskAndKeyboard(time: number, isVip: boolean, mode: string): void {
    const deskEdgeColor = isVip ? '#8C6B14' : '#188000';
    const deskBodyColor = isVip ? '#3A2A04' : '#0A3C00';
    const deskShadeColor = isVip ? '#1F1602' : '#041800';

    this.drawRect(0, 120, this.width, 4, deskEdgeColor);
    this.drawRect(0, 124, this.width, 28, deskBodyColor);
    this.drawRect(0, 146, this.width, 6, deskShadeColor);

    const kbColor = isVip ? '#281C02' : '#0A2E00';
    const kbBorder = isVip ? '#FFD028' : '#146E00';
    this.drawRect(18, 122, 124, 16, kbColor);
    this.drawRect(18, 122, 124, 1, kbBorder);

    // 8 keycap clusters
    const keyPositions = [26, 40, 54, 68, 82, 96, 110, 124];
    const typingLeft = Math.sin(time * 8) > 0;

    for (let k = 0; k < keyPositions.length; k++) {
      const kx = keyPositions[k];
      let isLit = false;

      if (mode === 'code-frenzy' || mode === 'vip-hyper-hack') {
        isLit = Math.random() < 0.4;
      } else if (mode === 'terminal-nap') {
        isLit = k >= 3 && k <= 5;
      } else if (mode === 'idle') {
        isLit = (typingLeft && (k === 1 || k === 2)) || (!typingLeft && (k === 5 || k === 6));
      }

      if (isLit) {
        const litColor = isVip ? '#FFE57F' : '#00FF66';
        this.drawRect(kx, 125, 10, 8, litColor);
        this.drawPixel(kx + 2, 126, '#FFFFFF', 2);
      } else {
        const baseKey = isVip ? '#181001' : '#041A00';
        this.drawRect(kx, 125, 10, 8, baseKey);
      }
    }
  }

  private renderHackerTorso(jumpY: number, isVip: boolean): void {
    const bx = 32;
    const by = 74 + jumpY;
    const bw = 96;
    const bh = 48;

    const robeHighlight = isVip ? '#FFD028' : '#33FF00';
    const robeMain = isVip ? '#3D2E04' : '#20B800';
    const robeShadow = isVip ? '#241B03' : '#146E00';
    const robeDeep = isVip ? '#120D01' : '#083C00';

    // Shoulders
    this.drawRect(bx + 4, by, bw - 8, 14, robeMain);
    this.drawRect(bx + 4, by, bw - 8, 2, robeHighlight);

    // Torso body
    this.drawRect(bx, by + 14, bw, bh - 14, robeMain);
    this.drawRect(bx + 12, by + 14, bw - 24, bh - 14, robeShadow);
    this.drawRect(bx + 28, by + 20, bw - 56, bh - 20, robeDeep);

    // Robe fold details & VIP circuit traces
    if (isVip) {
      this.drawRect(bx + 36, by + 18, 2, 22, '#FFD028');
      this.drawRect(bx + bw - 38, by + 18, 2, 22, '#FFD028');
      this.drawPixel(bx + bw / 2 - 1, by + 28, '#FFE57F', 3);
    } else {
      this.drawRect(bx + 40, by + 18, 2, 22, '#33FF00');
      this.drawRect(bx + bw - 42, by + 18, 2, 22, '#33FF00');
    }
  }

  private renderHackerHead(
    jumpY: number,
    headBobY: number,
    isVip: boolean,
    mode: string,
    time: number,
  ): void {
    const hx = 52;
    const hy = 22 + jumpY + headBobY;
    const hw = 56;
    const hh = 52;

    const hoodHighlight = isVip ? '#FFE57F' : '#33FF00';
    const hoodMain = isVip ? '#3D2E04' : '#20B800';
    const hoodShadow = isVip ? '#1F1702' : '#146E00';
    const shadowVoid = '#010801';

    // Outer hood crown & arch
    this.drawRect(hx + 8, hy, hw - 16, 6, hoodMain);
    this.drawRect(hx + 8, hy, hw - 16, 2, hoodHighlight);
    this.drawRect(hx + 4, hy + 6, hw - 8, 8, hoodMain);
    this.drawRect(hx, hy + 14, hw, hh - 14, hoodMain);
    this.drawRect(hx, hy + 14, 4, hh - 14, hoodHighlight);
    this.drawRect(hx + hw - 4, hy + 14, 4, hh - 14, hoodHighlight);

    // Inner cowl shadow opening
    this.drawRect(hx + 8, hy + 16, hw - 16, hh - 22, hoodShadow);
    this.drawRect(hx + 12, hy + 20, hw - 24, hh - 28, shadowVoid);

    // Visor expressions / eyes
    if (mode === 'terminal-nap') {
      // Resting slits
      this.drawRect(hx + 18, hy + 30, 8, 2, '#146E00');
      this.drawRect(hx + 30, hy + 30, 8, 2, '#146E00');
    } else if (isVip && mode !== 'zero-errors' && mode !== 'celebration') {
      // Golden sunglasses with active ruby laser sweep
      this.drawRect(hx + 14, hy + 24, 12, 10, '#FFD028');
      this.drawRect(hx + 30, hy + 24, 12, 10, '#FFD028');
      this.drawRect(hx + 24, hy + 26, 8, 3, '#FFD028');
      this.drawRect(hx + 16, hy + 26, 8, 6, '#3A2A04');
      this.drawRect(hx + 32, hy + 26, 8, 6, '#3A2A04');

      const laserOffset = (Math.sin(time * 4) + 1) * 0.5 * 24;
      const lx = hx + 15 + laserOffset;
      this.drawRect(lx, hy + 26, 4, 6, '#FF2E63');
      this.drawPixel(lx + 1, hy + 27, '#FFA0B8', 2);
    } else if (mode === 'intent') {
      // Exclamation mark visor ! !
      this.drawRect(hx + 18, hy + 22, 4, 10, '#FFD028');
      this.drawRect(hx + 18, hy + 34, 4, 3, '#FFD028');
      this.drawRect(hx + 34, hy + 22, 4, 10, '#FFD028');
      this.drawRect(hx + 34, hy + 34, 4, 3, '#FFD028');
    } else if (mode === 'zero-errors' || mode === 'celebration') {
      // Joyful arch ^ ^
      const eyeCol = '#00FF66';
      this.drawRect(hx + 16, hy + 28, 3, 4, eyeCol);
      this.drawRect(hx + 19, hy + 24, 4, 4, eyeCol);
      this.drawRect(hx + 23, hy + 28, 3, 4, eyeCol);
      this.drawRect(hx + 30, hy + 28, 3, 4, eyeCol);
      this.drawRect(hx + 33, hy + 24, 4, 4, eyeCol);
      this.drawRect(hx + 37, hy + 28, 3, 4, eyeCol);
    } else if (mode === 'bug-slayer') {
      // Angled blade glare \ /
      this.drawRect(hx + 16, hy + 24, 4, 4, '#00F0FF');
      this.drawRect(hx + 20, hy + 28, 4, 4, '#00F0FF');
      this.drawRect(hx + 32, hy + 28, 4, 4, '#FF2E63');
      this.drawRect(hx + 36, hy + 24, 4, 4, '#FF2E63');
    } else if (mode === 'empty-mug' && this.stateTimer % 4.8 > 2.0) {
      // Droopy sad eyes - -
      this.drawRect(hx + 16, hy + 29, 8, 3, '#00F0FF');
      this.drawRect(hx + 32, hy + 29, 8, 3, '#00F0FF');
      this.drawPixel(hx + 18, hy + 34, '#00F0FF', 3);
    } else {
      // Default blinking eyes
      const isBlink = time % 3.0 < 0.12;
      const eyeH = isBlink ? 2 : 6;
      const eyeY = isBlink ? hy + 28 : hy + 26;

      this.drawRect(hx + 16, eyeY, 8, eyeH, '#E8FFE8');
      this.drawRect(hx + 32, eyeY, 8, eyeH, '#E8FFE8');
      if (!isBlink) {
        // Micro H1: pupils look left, hold, look right, back (±3 px).
        const lookT = this.microT('look');
        const lookX = lookT >= 0 ? Math.round(Math.sin(2 * Math.PI * lookT) * 3) : 0;
        this.drawRect(hx + 18 + lookX, eyeY + 2, 4, 2, '#33FF00');
        this.drawRect(hx + 34 + lookX, eyeY + 2, 4, 2, '#33FF00');
      }
    }

    // 8-bit golden crown in VIP mode
    if (isVip) {
      const cx = hx + 10;
      const cy = hy - 14;
      this.drawRect(cx, cy + 8, 36, 4, '#FFD028');
      this.drawRect(cx + 2, cy + 2, 6, 6, '#FFD028');
      this.drawRect(cx + 15, cy - 2, 6, 10, '#FFD028');
      this.drawRect(cx + 28, cy + 2, 6, 6, '#FFD028');
      this.drawPixel(cx + 16, cy, '#FFFFFF', 3);
    }
  }

  private renderActionLayer(
    jumpY: number,
    isVip: boolean,
    mode: string,
    time: number,
    dt: number,
  ): void {
    const gloveColor = isVip ? '#FFE57F' : '#33FF00';
    const gloveShadow = isVip ? '#C99A0E' : '#20B800';

    if (mode === 'code-frenzy' || mode === 'vip-hyper-hack') {
      // CODE FRENZY: 60fps typing & smoke puffs
      const f1 = Math.floor(time * 28) % 3;
      const f2 = Math.floor(time * 28 + 1) % 3;

      const lx = 32 + f1 * 14;
      const ly = 114 + (f1 === 0 ? 6 : 0);
      const rx = 96 + f2 * 14;
      const ry = 114 + (f2 === 0 ? 6 : 0);

      // Motion ghosting trails
      this.drawRect(lx - 2, ly - 2, 16, 10, 'rgba(51, 255, 0, 0.35)');
      this.drawRect(rx - 2, ry - 2, 16, 10, 'rgba(51, 255, 0, 0.35)');

      // Hands
      this.drawRect(lx, ly, 14, 8, gloveColor);
      this.drawRect(rx, ry, 14, 8, gloveColor);

      // Spawn smoke puffs from keys
      if (Math.random() < 0.35) {
        this.smokePuffs.push({
          x: (Math.random() < 0.5 ? lx : rx) + 4,
          y: 122,
          vy: -35 - Math.random() * 25,
          vx: (Math.random() - 0.5) * 12,
          size: 3,
          alpha: 1.0,
          color: Math.random() < 0.5 ? '#8899A6' : '#78E678',
        });
      }

      for (let s = this.smokePuffs.length - 1; s >= 0; s--) {
        const p = this.smokePuffs[s];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.size += 6 * dt;
        p.alpha -= 1.8 * dt;

        if (p.alpha <= 0) {
          this.smokePuffs.splice(s, 1);
          continue;
        }

        this.ctx.fillStyle = p.color;
        this.ctx.globalAlpha = Math.max(0, p.alpha);
        this.ctx.fillRect(Math.floor(p.x), Math.floor(p.y), Math.floor(p.size), Math.floor(p.size));
        this.ctx.globalAlpha = 1.0;
      }
    } else if (mode === 'zero-errors' || mode === 'celebration') {
      // ZERO ERRORS: double fist pump \o/
      const fistY = 48 + jumpY + Math.sin(time * 12) * 4;
      this.drawRect(22, 68 + jumpY, 14, 28, gloveShadow);
      this.drawRect(18, fistY, 16, 16, gloveColor);
      this.drawPixel(22, fistY + 4, '#FFFFFF', 4);

      this.drawRect(124, 68 + jumpY, 14, 28, gloveShadow);
      this.drawRect(126, fistY, 16, 16, gloveColor);
      this.drawPixel(130, fistY + 4, '#FFFFFF', 4);
    } else if (mode === 'empty-mug') {
      // EMPTY MUG: 180° cup invert & tear drop
      const cycleTime = this.stateTimer % 4.8;

      if (cycleTime < 1.2) {
        // Holding mug on desk
        this.drawRect(118, 110, 16, 16, '#DCE5ED');
        this.drawRect(134, 114, 4, 8, '#8899A6');
        this.drawRect(110, 116, 12, 8, gloveColor);
      } else if (cycleTime < 3.2) {
        // Mug turned completely upside down over face
        this.drawRect(102, 60, 18, 18, '#DCE5ED');
        this.drawRect(102, 74, 18, 4, '#33FF00'); // robe arm
        this.drawRect(98, 64, 4, 10, '#8899A6'); // handle

        const tearProgress = (cycleTime - 1.2) / 2.0;
        const dropY = 78 + tearProgress * 44;
        if (dropY < 122) {
          this.drawRect(110, dropY, 4, 6, '#00F0FF');
          this.drawPixel(111, dropY + 1, '#FFFFFF', 2);
        } else {
          this.drawRect(106, 122, 12, 2, '#00F0FF');
        }
      } else {
        // Despair slump
        this.drawRect(118, 120, 16, 10, '#DCE5ED');
        this.drawRect(100, 122, 14, 8, gloveColor);
      }
    } else if (mode === 'bug-slayer') {
      // BUG SLAYER: neon katana slash & split bug
      const cycleTime = this.stateTimer % 3.6;

      if (cycleTime < 1.2) {
        // Bug crawling on desk
        const bx = 120 + Math.sin(time * 12) * 6;
        const by = 90;
        this.drawRect(bx, by, 14, 12, '#FF2E63');
        this.drawPixel(bx + 2, by - 4, '#FF2E63', 3);
        this.drawPixel(bx + 8, by - 4, '#FF2E63', 3);
        this.drawPixel(bx - 2, by + 3, '#0B1A0B', 2);
        this.drawPixel(bx + 14, by + 3, '#0B1A0B', 2);
        this.drawPixel(bx - 2, by + 9, '#0B1A0B', 2);
        this.drawPixel(bx + 14, by + 9, '#0B1A0B', 2);

        // Katana sheathed / ready
        this.drawRect(36, 104, 20, 4, '#00F0FF');
      } else if (cycleTime < 1.8) {
        // SWOOSH slash arc!
        this.ctx.strokeStyle = '#00F0FF';
        this.ctx.lineWidth = 4;
        this.ctx.beginPath();
        this.ctx.arc(80, 80, 50, -0.4, 0.9);
        this.ctx.stroke();

        this.ctx.strokeStyle = '#FFFFFF';
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.arc(80, 80, 50, -0.2, 0.7);
        this.ctx.stroke();

        this.drawRect(110, 54, 34, 4, '#00F0FF');
        this.drawRect(102, 54, 8, 6, gloveColor);

        // Spawn katana explosion sparks once per slash
        if (this.katanaSparks.length === 0) {
          for (let sp = 0; sp < 16; sp++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 35 + Math.random() * 55;
            this.katanaSparks.push({
              x: 126,
              y: 90,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed - 15,
              color: sp % 2 === 0 ? '#FF2E63' : '#00F0FF',
              size: 2 + Math.floor(Math.random() * 3),
              alpha: 1.0,
            });
          }
        }
      } else {
        // Sliced bug halves flying apart
        const t2 = cycleTime - 1.8;
        const topX = 126 + t2 * 18;
        const topY = 90 - t2 * 22;
        const botX = 126 - t2 * 8;
        const botY = 90 + t2 * 14;

        if (topY > 20) this.drawRect(topX, topY, 14, 6, '#FF2E63');
        if (botY < 124) this.drawRect(botX, botY, 14, 6, '#FF2E63');

        for (let sp = this.katanaSparks.length - 1; sp >= 0; sp--) {
          const p = this.katanaSparks[sp];
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.vy += 120 * dt; // gravity
          p.alpha -= 1.4 * dt;

          if (p.alpha <= 0 || p.y > 124) {
            this.katanaSparks.splice(sp, 1);
            continue;
          }

          this.ctx.fillStyle = p.color;
          this.ctx.globalAlpha = Math.max(0, p.alpha);
          this.ctx.fillRect(Math.floor(p.x), Math.floor(p.y), p.size, p.size);
          this.ctx.globalAlpha = 1.0;
        }
      }
    } else if (mode === 'coin-drop') {
      // COIN DROP: gravity bounce & tip jar
      const cycleTime = this.stateTimer % 3.6;

      // Glass tip jar on right desk edge
      this.drawRect(122, 98, 26, 24, 'rgba(0, 240, 255, 0.15)');
      this.drawRect(122, 98, 26, 2, '#00F0FF');
      this.drawRect(122, 120, 26, 2, '#00F0FF');
      this.drawRect(122, 98, 2, 24, '#00F0FF');
      this.drawRect(146, 98, 2, 24, '#00F0FF');
      // Gold coins in jar bottom
      this.drawRect(126, 114, 18, 6, '#FFD028');

      if (cycleTime < 0.8) {
        // Arm raised holding gold coin
        this.drawRect(132, 70, 14, 10, gloveColor);
        this.drawRect(134, 60, 10, 8, '#FFD028');
        this.drawPixel(136, 62, '#FFFFFF', 3);
      } else {
        // Coin falling with gravity
        const tDrop = cycleTime - 0.8;
        let cy = 60 + 0.5 * 180 * tDrop * tDrop;
        if (cy > 114) {
          cy = 114 - Math.abs(Math.sin((cy - 114) * 0.5)) * 6; // bounce
        }
        this.drawRect(130, cy, 10, 6, '#FFD028');
        this.drawPixel(132, cy + 1, '#FFFFFF', 2);
      }
    } else if (mode === 'flowchart') {
      // FLOWCHART: neural nodes & data packets
      this.ctx.strokeStyle = '#33FF00';
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(112, 114);
      this.ctx.lineTo(84, 40);
      this.ctx.stroke();

      const nCol = '#00F0FF';
      this.drawRect(20, 32, 24, 16, 'rgba(0, 240, 255, 0.2)');
      this.drawRect(20, 32, 24, 2, nCol);
      this.drawPixelText('IN', 26, 44, nCol, 8);

      this.drawRect(70, 22, 28, 16, 'rgba(0, 240, 255, 0.35)');
      this.drawRect(70, 22, 28, 2, nCol);
      this.drawPixelText('70B', 74, 34, '#FFFFFF', 8);

      this.drawRect(124, 32, 26, 16, 'rgba(0, 240, 255, 0.2)');
      this.drawRect(124, 32, 26, 2, nCol);
      this.drawPixelText('OUT', 128, 44, nCol, 8);

      this.ctx.strokeStyle = '#33FF00';
      this.ctx.lineWidth = 1.5;
      this.ctx.beginPath();
      this.ctx.moveTo(44, 40);
      this.ctx.lineTo(70, 30);
      this.ctx.lineTo(98, 30);
      this.ctx.lineTo(124, 40);
      this.ctx.stroke();

      // Moving data packets along the circuit path
      const packetPos = (time * 1.5) % 2.0;
      let px: number;
      let py: number;
      if (packetPos < 1.0) {
        px = 44 + packetPos * 26;
        py = 40 - packetPos * 10;
      } else {
        const p2 = packetPos - 1.0;
        px = 98 + p2 * 26;
        py = 30 + p2 * 10;
      }
      this.drawRect(px - 2, py - 2, 5, 5, '#FFFFFF');
    } else if (mode === 'terminal-nap') {
      // TERMINAL NAP: snore ZZZ glyphs
      if (Math.random() < 0.04 && this.snores.length < 5) {
        this.snores.push({
          x: 94,
          y: 70,
          vx: 12 + Math.random() * 8,
          vy: -20 - Math.random() * 10,
          size: 8,
          alpha: 1.0,
        });
      }

      for (let z = this.snores.length - 1; z >= 0; z--) {
        const sn = this.snores[z];
        sn.x += Math.sin(time * 4) * 0.6;
        sn.y += sn.vy * dt;
        sn.alpha -= 0.6 * dt;

        if (sn.alpha <= 0) {
          this.snores.splice(z, 1);
          continue;
        }

        this.ctx.fillStyle = `rgba(51, 255, 0, ${sn.alpha})`;
        this.ctx.font = "bold 9px 'JetBrains Mono', monospace";
        this.ctx.fillText('Z', Math.floor(sn.x), Math.floor(sn.y));
      }
    } else if (mode === 'intent') {
      // INTENT: waving cyber arm o/
      const waveAngle = Math.sin(time * 14) * 8;
      this.drawRect(120, 72, 14, 26, gloveShadow);
      this.drawRect(126 + waveAngle, 50, 16, 16, gloveColor);
      this.drawPixel(130 + waveAngle, 54, '#FFFFFF', 4);
    } else if (mode === 'vip-syndicate-salute') {
      // VIP 1: syndicate salute
      this.drawRect(114, 60, 14, 28, gloveShadow);
      this.drawRect(98, 44, 18, 12, '#FFD028');
      this.drawPixel(102, 46, '#FFFFFF', 4);
    } else if (mode === 'vip-espresso-toast') {
      // VIP 2: toast to architect
      this.drawRect(114, 70, 16, 24, gloveShadow);
      this.drawRect(118, 52, 18, 18, '#FFD028');
      this.drawRect(134, 56, 4, 10, '#FFE57F');

      // Golden steam spirals
      if (Math.random() < 0.2) {
        this.steamParticles.push({
          x: 124 + Math.random() * 8,
          y: 48,
          vy: -22 - Math.random() * 15,
          alpha: 1.0,
        });
      }
      for (let s = this.steamParticles.length - 1; s >= 0; s--) {
        const st = this.steamParticles[s];
        st.y += st.vy * dt;
        st.x += Math.sin(st.y * 0.1) * 0.8;
        st.alpha -= 1.2 * dt;
        if (st.alpha <= 0) {
          this.steamParticles.splice(s, 1);
          continue;
        }
        this.drawRect(st.x, st.y, 3, 3, `rgba(255, 208, 40, ${st.alpha})`);
      }
    } else if (mode === 'vip-fourth-wall-wink') {
      // VIP 3: 4th-wall wink & lens flare
      this.drawRect(104, 54, 14, 14, '#FFD028'); // hand adjusting shades
      const flarePulse = Math.abs(Math.sin(time * 3));
      if (flarePulse > 0.6) {
        const fx = 70;
        const fy = 50;
        this.drawRect(fx - 6, fy, 13, 2, '#FFFFFF');
        this.drawRect(fx, fy - 6, 2, 13, '#FFFFFF');
        this.drawPixel(fx, fy, '#FFF9C4', 3);
      }
    } else if (mode === 'vip-quantum-meditation') {
      // VIP 5: zero-g hover (body lift handled via jumpY; add orbiting spark)
      const orbAngle = time * 2.2;
      const ox = 80 + Math.cos(orbAngle) * 46;
      const oy = 74 + Math.sin(orbAngle) * 12;
      this.drawRect(ox, oy, 4, 4, '#FFD028');
      this.drawPixel(ox + 1, oy + 1, '#FFF9C4', 2);
    } else if (mode === 'disk-toss') {
      // EASTER EGG: 100TB data disk toss
      this.disk.rot += 12 * dt;
      const arcTime = this.stateTimer % 3.0;
      const dy = 90 - Math.sin((arcTime * Math.PI) / 3.0) * 60;
      const dw = Math.abs(Math.cos(this.disk.rot)) * 16 + 4;

      this.drawRect(80 - dw / 2, dy, dw, 16, '#FFD028');
      this.drawRect(80 - dw / 4, dy + 2, dw / 2, 12, '#FFFFFF');
    } else {
      // DEFAULT IDLE: rhythmic alternating typing
      const typingLeft = Math.sin(time * 8) > 0;
      const ly = typingLeft ? 122 : 116;
      const ry = typingLeft ? 116 : 122;

      this.drawRect(38, 100, 10, 16, gloveShadow);
      this.drawRect(36, ly, 14, 8, gloveColor);

      this.drawRect(112, 100, 10, 16, gloveShadow);
      this.drawRect(110, ry, 14, 8, gloveColor);
    }
  }

  /** Micro H3 stretch / H4 wave (spec §1.3), drawn over the activity's own hands. */
  private renderMicroArms(jumpY: number, isVip: boolean, mode: string, time: number): void {
    const gloveColor = isVip ? '#FFE57F' : '#33FF00';
    const gloveShadow = isVip ? '#C99A0E' : '#20B800';
    const stretchT = this.microT('stretch');
    if (stretchT >= 0) {
      const fistY = 116 - Math.sin(Math.PI * stretchT) * 64 + jumpY;
      this.drawRect(18, fistY, 16, 16, gloveColor);
      this.drawPixel(22, fistY + 4, '#FFFFFF', 4);
      this.drawRect(126, fistY, 16, 16, gloveColor);
      this.drawPixel(130, fistY + 4, '#FFFFFF', 4);
    }
    if (this.microT('wave') >= 0 && mode !== 'intent') {
      const waveAngle = Math.sin(time * 14) * 8;
      this.drawRect(120, 72, 14, 26, gloveShadow);
      this.drawRect(126 + waveAngle, 50, 16, 16, gloveColor);
      this.drawPixel(130 + waveAngle, 54, '#FFFFFF', 4);
    }
  }

  private renderForegroundParticles(dt: number, mode: string, isVip: boolean): void {
    if (mode === 'zero-errors' || mode === 'celebration') {
      for (let i = 0; i < this.confetti.length; i++) {
        const p = this.confetti[i];
        p.y += p.vy * dt;
        p.x += (p.vx + Math.sin(p.y * 0.08) * 12) * dt;
        p.rot += p.rotSpeed * dt;

        if (p.y > this.height) {
          p.y = -10;
          p.x = Math.random() * this.width;
        }

        this.ctx.save();
        this.ctx.translate(Math.floor(p.x), Math.floor(p.y));
        this.ctx.rotate(p.rot);
        this.ctx.fillStyle = p.color;
        this.ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        this.ctx.restore();
      }
    }

    if (isVip && Math.random() < 0.15 && this.vipEmbers.length < 12) {
      this.vipEmbers.push({
        x: Math.random() * this.width,
        y: this.height - 10,
        vy: -20 - Math.random() * 20,
        size: 2,
        alpha: 1.0,
      });
    }

    for (let e = this.vipEmbers.length - 1; e >= 0; e--) {
      const em = this.vipEmbers[e];
      em.y += em.vy * dt;
      em.alpha -= 0.8 * dt;
      if (em.alpha <= 0 || em.y < 0) {
        this.vipEmbers.splice(e, 1);
        continue;
      }
      this.drawRect(em.x, em.y, em.size, em.size, `rgba(255, 208, 40, ${em.alpha})`);
    }
  }
}
