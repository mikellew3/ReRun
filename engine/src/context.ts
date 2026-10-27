/**
 * Runtime context for one simulated game: mutable state, stats counters and small helpers
 * shared by the play, drive, special-teams and game modules.
 */

import type { GameInputs, OffenseUnit } from './applySettings';
import { MODEL_CONFIG } from './config/model.config';
import type { Rng } from './rng';
import type { GameState, PlayOutcome, PlayerId, PlayRecord, Side } from './types';

export const other = (side: Side): Side => (side === 'home' ? 'away' : 'home');

/** Counting stats for every player in the game, by global player index. */
export class GameStats {
  readonly passAtt: Float64Array;
  readonly passCmp: Float64Array;
  readonly passYds: Float64Array;
  readonly passTd: Float64Array;
  readonly passInt: Float64Array;
  readonly rushAtt: Float64Array;
  readonly rushYds: Float64Array;
  readonly rushTd: Float64Array;
  readonly targets: Float64Array;
  readonly rec: Float64Array;
  readonly recYds: Float64Array;
  readonly recTd: Float64Array;
  readonly team: Record<
    Side,
    { passAtt: number; rushAtt: number; yards: number; turnovers: number }
  >;
  plays = 0;

  constructor(nPlayers: number) {
    const arr = () => new Float64Array(nPlayers);
    this.passAtt = arr();
    this.passCmp = arr();
    this.passYds = arr();
    this.passTd = arr();
    this.passInt = arr();
    this.rushAtt = arr();
    this.rushYds = arr();
    this.rushTd = arr();
    this.targets = arr();
    this.rec = arr();
    this.recYds = arr();
    this.recTd = arr();
    this.team = {
      home: { passAtt: 0, rushAtt: 0, yards: 0, turnovers: 0 },
      away: { passAtt: 0, rushAtt: 0, yards: 0, turnovers: 0 },
    };
  }
}

export interface GameCtx {
  inputs: GameInputs;
  rng: Rng;
  state: GameState;
  units: Record<Side, OffenseUnit>;
  stats: GameStats;
  /** Set when the next kickoff is a free kick after a safety. */
  safetyKick: boolean;
  firstHalf: Record<Side, number> | null;
  /** Questionable/doubtful players this sim drew as not playing. */
  sittingOut: PlayerId[];
  /** Filled only when replaying one game. */
  record: PlayRecord[] | null;
}

export function newGameState(firstReceiver: Side, otherSide: Side): GameState {
  return {
    quarter: 1,
    clockSec: 900,
    clockRunning: false,
    phase: 'kickoff',
    possession: firstReceiver,
    down: 1,
    distance: 10,
    yardline: 25,
    score: { home: 0, away: 0 },
    timeouts: { home: 3, away: 3 },
    secondHalfReceiver: otherSide,
    ot: null,
    driveIndex: 0,
    playIndex: 0,
  };
}

/** Offense score minus defense score, from `side`'s point of view. */
export function scoreDiff(state: GameState, side: Side): number {
  return state.score[side] - state.score[other(side)];
}

/** Seconds left in the current half (overtime counts as its own half). */
export function halfSecondsLeft(state: GameState): number {
  return state.quarter === 1 || state.quarter === 3 ? state.clockSec + 900 : state.clockSec;
}

/** In the final N seconds of a half? (OT always counts as the second half.) */
export function lateInHalf(state: GameState, secs: { firstHalf: number; secondHalf: number }) {
  const left = halfSecondsLeft(state);
  return state.quarter <= 2 ? left <= secs.firstHalf : left <= secs.secondHalf;
}

/** Fraction of regulation elapsed (1 in overtime). */
export function gameElapsedFraction(state: GameState): number {
  if (state.quarter >= 5) return 1;
  return ((state.quarter - 1) * 900 + (900 - state.clockSec)) / 3600;
}

export function recordPlay(ctx: GameCtx, before: GameState | null, outcome: PlayOutcome): void {
  if (ctx.record && before) ctx.record.push({ before, outcome });
}

export function cloneState(s: GameState): GameState {
  return {
    ...s,
    score: { ...s.score },
    timeouts: { ...s.timeouts },
    ot: s.ot ? { ...s.ot, possessed: { ...s.ot.possessed } } : null,
  };
}

/** A copy of the state, only when replaying. */
export function snapshotState(ctx: GameCtx): GameState | null {
  return ctx.record ? cloneState(ctx.state) : null;
}

/** Late-game script level for the offense in possession: -maxLevel..maxLevel, 0 = neutral. */
export function scriptLevel(state: GameState): number {
  const g = MODEL_CONFIG.gameScript;
  if (state.quarter < 4) return 0;
  const diff = scoreDiff(state, state.possession);
  let bucket = g.diffUpper.findIndex((upper) => diff <= upper);
  if (bucket < 0) bucket = g.diffUpper.length - 1;
  const pts = g.ptsShift[bucket]! * Math.pow(gameElapsedFraction(state), g.timePower);
  return Math.max(-g.maxLevel, Math.min(g.maxLevel, Math.round(pts / g.ptsPerLevel)));
}
