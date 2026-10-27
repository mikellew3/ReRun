/**
 * Coaching decisions, all table- or rule-driven from config:
 * kneel, spike, end-of-half field goals, fourth down, and two-point tries.
 */

import type { OffenseUnit } from './applySettings';
import { inHurryUp } from './clock';
import { MODEL_CONFIG } from './config/model.config';
import type { GameCtx } from './context';
import { halfSecondsLeft, other, scoreDiff } from './context';
import { passProbability } from './playCall';
import type { GameState } from './types';

const F = MODEL_CONFIG.fourthDown;
const CLK = MODEL_CONFIG.clock;

export type Action = 'pass' | 'run' | 'punt' | 'fieldGoal' | 'kneel' | 'spike';

export function fgDistance(yardline: number): number {
  return 100 - yardline + MODEL_CONFIG.rules.fgDistanceOffsetYds;
}

export function inFgRange(state: GameState, unit: OffenseUnit): boolean {
  return unit.kicker >= 0 && fgDistance(state.yardline) <= F.maxFgDistance;
}

/**
 * Leading in the 4th with few enough seconds left that kneeling out the clock ends the game.
 * This snap's runoff has already happened; between each remaining kneel the clock runs
 * `kneelBurnSec` unless the defense stops it with a timeout.
 */
export function canKneelOut(state: GameState): boolean {
  if (state.quarter !== 4 || scoreDiff(state, state.possession) <= 0) return false;
  const kneels = 4 - state.down + 1;
  const gaps = Math.max(0, kneels - 1 - state.timeouts[other(state.possession)]);
  const burn = kneels * CLK.playDurationSec.kneel + gaps * CLK.kneelBurnSec;
  return state.clockSec <= burn;
}

function shouldSpike(state: GameState): boolean {
  return (
    state.clockRunning &&
    state.down < 4 &&
    state.timeouts[state.possession] === 0 &&
    halfSecondsLeft(state) <= CLK.spikeSecLeft &&
    inHurryUp(state, state.possession)
  );
}

/** Would a field goal now help? (First half: always. Later: if it ties or leads.) */
function fieldGoalHelps(state: GameState): boolean {
  return state.quarter <= 2 || scoreDiff(state, state.possession) >= -3;
}

function fourthDown(ctx: GameCtx, unit: OffenseUnit): 'go' | 'punt' | 'fieldGoal' {
  const s = ctx.state;
  const diff = scoreDiff(s, s.possession);
  const late = s.quarter >= 5 || (s.quarter === 4 && s.clockSec <= F.desperationSecLeft);
  const canKick = inFgRange(s, unit);
  if (late && diff < -3) return 'go';
  if (late && diff < 0 && canKick) return 'fieldGoal';

  let zone = F.zoneUpperYardline.findIndex((upper) => s.yardline <= upper);
  if (zone < 0) zone = F.zoneUpperYardline.length - 1;
  let bucket = F.ydsToGoUpper.findIndex((upper) => s.distance <= upper);
  if (bucket < 0) bucket = F.ydsToGoUpper.length - 1;
  if (ctx.rng.chance(F.goProb[zone]![bucket]!)) return 'go';
  return canKick ? 'fieldGoal' : 'punt';
}

export function chooseAction(ctx: GameCtx, unit: OffenseUnit): Action {
  const s = ctx.state;
  if (canKneelOut(s)) return 'kneel';
  if (shouldSpike(s)) return 'spike';
  if (halfSecondsLeft(s) <= F.endOfHalfFgSecLeft && inFgRange(s, unit) && fieldGoalHelps(s)) {
    return 'fieldGoal';
  }
  if (s.down === 4) {
    const choice = fourthDown(ctx, unit);
    if (choice !== 'go') return choice;
  }
  return ctx.rng.chance(passProbability(ctx, unit)) ? 'pass' : 'run';
}

/** Go for two after a touchdown? `diff` = scoring team minus opponent, after the TD. */
export function goForTwo(ctx: GameCtx, diff: number): boolean {
  const pat = MODEL_CONFIG.pat;
  if (ctx.state.quarter >= 4 && (pat.twoPointLateDiffs as readonly number[]).includes(diff)) {
    return true;
  }
  return ctx.rng.chance(pat.twoPointBaseRate);
}
