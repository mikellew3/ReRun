/**
 * Scoring, possession changes and overtime rules.
 *
 * Overtime (2025+ rules, regular season and postseason): both teams get a possession unless
 * the team that received first gives up a defensive score. After both have possessed, if the
 * score is level it becomes sudden death. Regular-season OT is one period and can end tied.
 */

import { MODEL_CONFIG } from './config/model.config';
import type { GameCtx } from './context';
import { other } from './context';
import type { Side } from './types';

export type ScoreKind = 'offense' | 'defense' | 'return' | 'pat';

function markPossessed(ctx: GameCtx, side: Side): void {
  const ot = ctx.state.ot;
  if (ot) ot.possessed[side] = true;
}

/** Ends the game if overtime rules say so. */
export function checkOvertime(ctx: GameCtx): void {
  const s = ctx.state;
  if (s.quarter < 5 || !s.ot || s.phase === 'final') return;
  const first = s.ot.firstPossession;
  const second = other(first);
  const level = s.score.home === s.score.away;
  if (s.ot.suddenDeath) {
    if (!level) s.phase = 'final';
  } else if (s.score[second] > s.score[first]) {
    // Defensive score on the first possession, or a walk-off on the second.
    s.phase = 'final';
  } else if (s.ot.possessed[first] && s.ot.possessed[second]) {
    if (level) s.ot.suddenDeath = true;
    else s.phase = 'final';
  }
}

export function addScore(ctx: GameCtx, side: Side, points: number, kind: ScoreKind): void {
  const s = ctx.state;
  s.score[side] += points;
  s.clockRunning = false;
  if (kind === 'offense' || kind === 'return') markPossessed(ctx, side);
  if (kind === 'defense') markPossessed(ctx, other(side));
  checkOvertime(ctx);
}

/** Possession goes to the other team at `yardline` (from their own goal line). */
export function changePossession(ctx: GameCtx, yardline: number): void {
  const s = ctx.state;
  markPossessed(ctx, s.possession);
  s.possession = other(s.possession);
  s.yardline = Math.min(99, Math.max(1, Math.round(yardline)));
  s.down = 1;
  s.distance = Math.min(10, 100 - s.yardline);
  s.clockRunning = false;
  s.driveIndex += 1;
  checkOvertime(ctx);
}

/** Next action is a kickoff by `kicking` (possession = receiving team). */
export function setupKickoff(ctx: GameCtx, kicking: Side, safety = false): void {
  const s = ctx.state;
  if (s.phase === 'final') return;
  s.phase = 'kickoff';
  s.possession = other(kicking);
  s.clockRunning = false;
  ctx.safetyKick = safety;
}

/** After a touchdown by `side`: try for the extra point(s), unless the game just ended. */
export function afterTouchdown(ctx: GameCtx, side: Side): void {
  const s = ctx.state;
  if (s.phase === 'final') return;
  s.phase = 'pat';
  s.possession = side;
}

/** Fresh set of downs at the current spot. */
export function firstDown(ctx: GameCtx): void {
  const s = ctx.state;
  s.down = 1;
  s.distance = Math.min(10, 100 - s.yardline);
}

/** Start overtime: coin toss, OT clock and timeouts, kickoff. */
export function startOvertime(ctx: GameCtx): void {
  const s = ctx.state;
  const rules = ctx.inputs.regularSeason
    ? MODEL_CONFIG.rules.overtime.regularSeason
    : MODEL_CONFIG.rules.overtime.postseason;
  const receiver: Side = ctx.rng.chance(0.5) ? 'home' : 'away';
  s.quarter = 5;
  s.clockSec = rules.periodSec;
  s.timeouts = { home: rules.timeouts, away: rules.timeouts };
  s.ot = { firstPossession: receiver, possessed: { home: false, away: false }, suddenDeath: false };
  setupKickoff(ctx, other(receiver));
}
