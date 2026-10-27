/**
 * Game clock: pace between snaps, play durations, two-minute warning, out-of-bounds rules.
 *
 * Model: a play takes `playDurationSec` from snap to whistle. If the clock keeps running after
 * the play, the next snap comes after `snap-to-snap pace - averagePlaySec` more seconds.
 * Pace is the offense's neutral pace, or hurry-up / milking pace late in halves.
 */

import type { OffenseUnit } from './applySettings';
import { MODEL_CONFIG } from './config/model.config';
import { lateInHalf, scoreDiff } from './context';
import type { GameState, Side } from './types';

const C = MODEL_CONFIG.clock;

export type DurationKind = keyof typeof C.playDurationSec;

/** Offense trailing/tied late (or any team at the end of the first half): hurry up. */
export function inHurryUp(state: GameState, side: Side): boolean {
  if (!lateInHalf(state, MODEL_CONFIG.playCall.hurryUpSecLeft)) return false;
  return state.quarter <= 2 || scoreDiff(state, side) <= 0;
}

/** Offense leading in the 4th quarter with time to burn. */
export function milkingClock(state: GameState, side: Side): boolean {
  return state.quarter === 4 && state.clockSec <= C.milkSecLeft && scoreDiff(state, side) > 0;
}

/** Seconds that run off before the next snap (0 if the clock is stopped). */
export function preSnapRunoff(state: GameState, unit: OffenseUnit): number {
  if (!state.clockRunning) return 0;
  const side = state.possession;
  const pace = inHurryUp(state, side)
    ? C.hurryUpSecPerSnap
    : milkingClock(state, side)
      ? C.milkSecPerSnap
      : unit.secPerSnap;
  return Math.max(0, Math.round(pace - C.averagePlaySec));
}

export function playDuration(kind: DurationKind): number {
  return C.playDurationSec[kind];
}

/** Does going out of bounds stop the clock right now? */
export function outOfBoundsStopsClock(state: GameState): boolean {
  return lateInHalf(state, C.outOfBoundsStopsSecLeft);
}

/**
 * Runs the clock. Stops at the two-minute warning if it is crossed (and leaves the clock
 * stopped). Returns true if the period has expired.
 */
export function runClock(state: GameState, seconds: number): boolean {
  if (seconds <= 0) return state.clockSec <= 0;
  const warning = C.twoMinuteWarningSec;
  const hasWarning = state.quarter === 2 || state.quarter === 4;
  if (hasWarning && state.clockSec > warning && state.clockSec - seconds <= warning) {
    state.clockSec = warning;
    state.clockRunning = false;
    return false;
  }
  state.clockSec = Math.max(0, state.clockSec - seconds);
  return state.clockSec <= 0;
}
