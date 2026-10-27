/**
 * Single scrimmage plays. Each function draws the outcome, records player and team stats, and
 * returns a PlayOutcome. It does not move the ball: drive.ts applies the outcome to the state.
 *
 * Pass: sack -> scramble -> target a receiver (red-zone shares inside the 20) ->
 *       interception -> complete (receiver's own catch odds) or incomplete.
 * Run:  carrier by carry share (goal-line shares inside the 5, red-zone inside the 20).
 * Yards come from the player's tilted sampler, capped at the goal line.
 */

import type { OffenseUnit } from './applySettings';
import { outOfBoundsStopsClock, playDuration } from './clock';
import { MODEL_CONFIG } from './config/model.config';
import type { GameCtx } from './context';
import { sampleExponentialYds } from './samplers';
import type { PlayOutcome } from './types';

const T = MODEL_CONFIG.turnovers;
const OOB = MODEL_CONFIG.clock.outOfBoundsRate;
const PEN = MODEL_CONFIG.penalties;
const GOAL_LINE = 100 - MODEL_CONFIG.fitting.goalLineYardline;
const RED_ZONE = 100 - MODEL_CONFIG.fitting.redZoneYardline;

function id(ctx: GameCtx, idx: number): string {
  return idx >= 0 ? ctx.inputs.playerIds[idx]! : '';
}

function pickFrom(dist: { yards: readonly number[]; probs: readonly number[] }, u: number): number {
  let acc = 0;
  for (let i = 0; i < dist.yards.length; i++) {
    acc += dist.probs[i]!;
    if (u < acc) return dist.yards[i]!;
  }
  return dist.yards[dist.yards.length - 1]!;
}

/** Pre-snap/no-play penalty, or null if the snap is clean. Half-the-distance applies. */
export function simulatePenalty(ctx: GameCtx, unit: OffenseUnit): PlayOutcome | null {
  const s = ctx.state;
  const u = ctx.rng.next();
  if (u < unit.offensePenaltyRate) {
    let yards = pickFrom(PEN.offense, ctx.rng.next());
    if (yards >= s.yardline) yards = Math.floor(s.yardline / 2);
    return {
      kind: 'penalty',
      against: 'offense',
      yards,
      automaticFirstDown: false,
      replayDown: true,
      clockSec: 0,
      stopsClock: false,
    };
  }
  if (u < unit.offensePenaltyRate + unit.defensePenaltyRate) {
    const toGoal = 100 - s.yardline;
    let yards = pickFrom(PEN.defense, ctx.rng.next());
    // Half the distance to the goal; at the 1 the ball stays put (whole yards only).
    if (yards >= toGoal) yards = Math.floor(toGoal / 2);
    return {
      kind: 'penalty',
      against: 'defense',
      yards,
      automaticFirstDown: ctx.rng.chance(PEN.defenseAutoFirstDownRate),
      replayDown: true,
      clockSec: 0,
      stopsClock: false,
    };
  }
  return null;
}

export function simulatePass(ctx: GameCtx, unit: OffenseUnit): PlayOutcome {
  const { rng, stats, state: s, inputs } = ctx;
  const side = s.possession;
  const team = stats.team[side];
  const qb = unit.qb;
  const toGoal = 100 - s.yardline;
  const u = rng.next();

  if (u < unit.sackRate) {
    let yards = inputs.sackYds.sample(rng);
    const safety = s.yardline + yards <= 0;
    if (safety) yards = -s.yardline;
    const fumbleLost = !safety && rng.chance(T.sackFumbleLostRate);
    team.yards += yards;
    return {
      kind: 'sack',
      passer: id(ctx, qb),
      yards,
      fumbleLost,
      safety,
      clockSec: playDuration('sack'),
      stopsClock: safety || fumbleLost,
    };
  }

  if (u < unit.sackRate + unit.scrambleRate) {
    let yards = Math.min(inputs.scrambleYds.sample(rng), toGoal);
    if (s.yardline + yards <= 0) yards = 1 - s.yardline;
    const td = yards >= toGoal;
    const fumbleLost = !td && rng.chance(unit.fumbleLostRate);
    const outOfBounds = !td && rng.chance(OOB.scramble);
    stats.rushAtt[qb]! += 1;
    stats.rushYds[qb]! += yards;
    if (td) stats.rushTd[qb]! += 1;
    team.rushAtt += 1;
    team.yards += yards;
    return {
      kind: 'scramble',
      passer: id(ctx, qb),
      yards,
      outOfBounds,
      fumbleLost,
      td,
      clockSec: playDuration('scramble'),
      stopsClock: td || fumbleLost || (outOfBounds && outOfBoundsStopsClock(s)),
    };
  }

  const picker =
    s.yardline >= RED_ZONE && unit.rzTargetPicker ? unit.rzTargetPicker : unit.targetPicker;
  stats.passAtt[qb]! += 1;
  team.passAtt += 1;
  if (!picker) {
    // No eligible receivers available: throw it away.
    return {
      kind: 'pass',
      result: 'incomplete',
      passer: id(ctx, qb),
      target: '',
      yards: 0,
      outOfBounds: false,
      fumbleLost: false,
      td: false,
      clockSec: playDuration('passIncomplete'),
      stopsClock: true,
    };
  }
  const ri = picker.pick(rng);
  const rec = unit.receivers[ri]!;
  stats.targets[rec]! += 1;

  if (rng.chance(unit.intRate)) {
    stats.passInt[qb]! += 1;
    const defensiveTd = rng.chance(T.pickSixRate);
    return {
      kind: 'interception',
      passer: id(ctx, qb),
      target: id(ctx, rec),
      returnYards: defensiveTd ? 0 : sampleExponentialYds(rng, T.interceptionReturnMeanYds),
      defensiveTd,
      clockSec: playDuration('interception'),
      stopsClock: true,
    };
  }

  if (rng.chance(unit.completionProb[ri]!)) {
    let yards = Math.min(unit.receiverYds[ri]!.sample(rng), toGoal);
    if (s.yardline + yards <= 0) yards = 1 - s.yardline;
    const td = yards >= toGoal;
    const fumbleLost = !td && rng.chance(unit.fumbleLostRate);
    const outOfBounds = !td && rng.chance(OOB.completion);
    stats.passCmp[qb]! += 1;
    stats.passYds[qb]! += yards;
    stats.rec[rec]! += 1;
    stats.recYds[rec]! += yards;
    if (td) {
      stats.passTd[qb]! += 1;
      stats.recTd[rec]! += 1;
    }
    team.yards += yards;
    return {
      kind: 'pass',
      result: 'complete',
      passer: id(ctx, qb),
      target: id(ctx, rec),
      yards,
      outOfBounds,
      fumbleLost,
      td,
      clockSec: playDuration('passComplete'),
      stopsClock: td || fumbleLost || (outOfBounds && outOfBoundsStopsClock(s)),
    };
  }

  return {
    kind: 'pass',
    result: 'incomplete',
    passer: id(ctx, qb),
    target: id(ctx, rec),
    yards: 0,
    outOfBounds: false,
    fumbleLost: false,
    td: false,
    clockSec: playDuration('passIncomplete'),
    stopsClock: true,
  };
}

export function simulateRun(ctx: GameCtx, unit: OffenseUnit): PlayOutcome {
  const { rng, stats, state: s } = ctx;
  const team = stats.team[s.possession];
  const toGoal = 100 - s.yardline;
  const picker =
    (s.yardline >= GOAL_LINE && unit.glCarryPicker) ||
    (s.yardline >= RED_ZONE && unit.rzCarryPicker) ||
    unit.carryPicker!;
  const ri = picker.pick(rng);
  const rusher = unit.rushers[ri]!;
  let yards = Math.min(unit.rusherYds[ri]!.sample(rng), toGoal);
  const safety = s.yardline + yards <= 0;
  if (safety) yards = -s.yardline;
  const td = yards >= toGoal;
  const fumbleLost = !td && !safety && rng.chance(unit.fumbleLostRate);
  const outOfBounds = !td && !safety && rng.chance(OOB.run);
  stats.rushAtt[rusher]! += 1;
  stats.rushYds[rusher]! += yards;
  if (td) stats.rushTd[rusher]! += 1;
  team.rushAtt += 1;
  team.yards += yards;
  return {
    kind: 'run',
    rusher: id(ctx, rusher),
    yards,
    outOfBounds,
    fumbleLost,
    td,
    safety,
    clockSec: playDuration('run'),
    stopsClock: td || safety || fumbleLost || (outOfBounds && outOfBoundsStopsClock(s)),
  };
}

export function simulateKneel(ctx: GameCtx, unit: OffenseUnit): PlayOutcome {
  const { stats, state: s } = ctx;
  const yards = s.yardline > 1 ? -1 : 0;
  stats.rushAtt[unit.qb]! += 1;
  stats.rushYds[unit.qb]! += yards;
  stats.team[s.possession].rushAtt += 1;
  stats.team[s.possession].yards += yards;
  return { kind: 'kneel', clockSec: playDuration('kneel'), stopsClock: false };
}

export function simulateSpike(ctx: GameCtx, unit: OffenseUnit): PlayOutcome {
  ctx.stats.passAtt[unit.qb]! += 1;
  ctx.stats.team[ctx.state.possession].passAtt += 1;
  return { kind: 'spike', clockSec: playDuration('spike'), stopsClock: true };
}
