/**
 * Pass or run. Starts from the league's neutral pass rate for this down and distance
 * (snapshot grid), then adds the team's PROE and the user's pass-rate tilt, the score and
 * clock (game script), and hurry-up.
 */

import type { OffenseUnit } from './applySettings';
import { inHurryUp } from './clock';
import { MODEL_CONFIG } from './config/model.config';
import type { GameCtx } from './context';
import { gameElapsedFraction, scoreDiff } from './context';
import { logit, sigmoid } from './samplers';

const P = MODEL_CONFIG.playCall;
const BUCKETS = MODEL_CONFIG.fitting.passRateDistanceBuckets;

export function distanceBucket(distance: number): number {
  for (let i = 0; i < BUCKETS.length; i++) if (distance <= BUCKETS[i]!) return i;
  return BUCKETS.length;
}

export function passProbability(ctx: GameCtx, unit: OffenseUnit): number {
  const s = ctx.state;
  const grid = ctx.inputs.passLogitGrid;
  const base = sigmoid(grid[s.down - 1]![distanceBucket(s.distance)]!);
  const withStyle = Math.min(0.99, Math.max(0.01, base + unit.proeShift));
  let x = logit(withStyle);
  const diff = scoreDiff(s, s.possession);
  const perPt = diff > 0 ? P.scoreLeadingLogitPerPt : P.scoreTrailingLogitPerPt;
  x += perPt * diff * Math.pow(gameElapsedFraction(s), P.scoreDiffTimePower);
  if (inHurryUp(s, s.possession)) x += P.hurryUpPassLogit;
  return Math.min(P.maxPassRate, Math.max(P.minPassRate, sigmoid(x)));
}
