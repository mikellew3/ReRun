/**
 * Kickoffs, punts, field goals and points after touchdown. Each mutates the game state and
 * returns the PlayOutcome for the record.
 */

import type { OffenseUnit } from './applySettings';
import { playDuration, runClock } from './clock';
import { MODEL_CONFIG } from './config/model.config';
import type { GameCtx } from './context';
import { halfSecondsLeft, other, scoreDiff } from './context';
import { fgDistance, goForTwo } from './decisions';
import { addScore, afterTouchdown, changePossession, firstDown, setupKickoff } from './rules';
import { sigmoid } from './samplers';
import type { PlayOutcome } from './types';

const R = MODEL_CONFIG.rules;
const K = MODEL_CONFIG.kickoffs;
const PUNTS = MODEL_CONFIG.punts;

function startScrimmage(ctx: GameCtx, yardline: number): void {
  const s = ctx.state;
  s.phase = 'scrimmage';
  s.yardline = Math.min(99, Math.max(1, Math.round(yardline)));
  firstDown(ctx);
  s.clockRunning = false;
}

/** Kickoff by the team not in possession (possession = receiving team). */
export function kickoff(ctx: GameCtx): PlayOutcome {
  const { state: s, rng, inputs } = ctx;
  const receiving = s.possession;
  const kicking = other(receiving);
  const st = inputs.league.specialTeams;

  if (ctx.safetyKick) {
    ctx.safetyKick = false;
    runClock(s, playDuration('kickoffReturn'));
    startScrimmage(ctx, K.safetyKickStartYardline);
    return {
      kind: 'kickoff',
      touchback: false,
      receiveYardline: K.safetyKickStartYardline,
      returnTd: false,
      clockSec: playDuration('kickoffReturn'),
      stopsClock: true,
    };
  }

  const deficit = -scoreDiff(s, kicking);
  const onside =
    s.quarter >= 4 &&
    deficit > 0 &&
    deficit <= K.onsideMaxDeficit &&
    halfSecondsLeft(s) <= K.onsideSecLeft;
  if (onside) {
    const recovered = rng.chance(K.onsideRecoveryRate);
    runClock(s, playDuration('spike'));
    if (recovered) {
      s.possession = kicking;
      startScrimmage(ctx, K.onsideRecoveredYardline);
    } else {
      startScrimmage(ctx, 100 - K.onsideRecoveredYardline);
    }
    s.driveIndex += 1;
    return {
      kind: 'kickoff',
      touchback: false,
      receiveYardline: s.yardline,
      returnTd: false,
      onsideRecovered: recovered,
      clockSec: playDuration('spike'),
      stopsClock: true,
    };
  }

  s.driveIndex += 1;
  if (rng.chance(st.kickoffTouchbackRate)) {
    startScrimmage(ctx, R.kickoffTouchbackYardline);
    return {
      kind: 'kickoff',
      touchback: true,
      receiveYardline: R.kickoffTouchbackYardline,
      returnTd: false,
      clockSec: 0,
      stopsClock: true,
    };
  }

  runClock(s, playDuration('kickoffReturn'));
  const returnTd = rng.chance(st.kickoffReturnTdRate / (1 - st.kickoffTouchbackRate));
  if (returnTd) {
    s.phase = 'scrimmage';
    addScore(ctx, receiving, 6, 'return');
    afterTouchdown(ctx, receiving);
    return {
      kind: 'kickoff',
      touchback: false,
      receiveYardline: 100,
      returnTd: true,
      clockSec: playDuration('kickoffReturn'),
      stopsClock: true,
    };
  }
  const start = inputs.kickoffStart.sample(rng);
  startScrimmage(ctx, start);
  return {
    kind: 'kickoff',
    touchback: false,
    receiveYardline: s.yardline,
    returnTd: false,
    clockSec: playDuration('kickoffReturn'),
    stopsClock: true,
  };
}

export function punt(ctx: GameCtx, unit: OffenseUnit): PlayOutcome {
  const { state: s, rng, inputs } = ctx;
  const punting = s.possession;
  const receiving = other(punting);
  const land = s.yardline + inputs.puntNetYds.sample(rng);
  const net = land - s.yardline;
  const base = { punter: unit.punter >= 0 ? inputs.playerIds[unit.punter]! : '' };

  if (rng.chance(inputs.league.specialTeams.puntReturnTdRate)) {
    changePossession(ctx, 50);
    addScore(ctx, receiving, 6, 'return');
    afterTouchdown(ctx, receiving);
    return {
      kind: 'punt',
      ...base,
      netYards: net,
      touchback: false,
      returnTd: true,
      clockSec: playDuration('punt'),
      stopsClock: true,
    };
  }

  let receiveAt: number;
  let touchback = false;
  if (land >= 100) {
    touchback = rng.chance(PUNTS.overshootTouchbackRate);
    receiveAt = touchback ? R.puntTouchbackYardline : PUNTS.pinnedYardline;
  } else {
    receiveAt = Math.max(1, 100 - land);
  }
  changePossession(ctx, receiveAt);
  return {
    kind: 'punt',
    ...base,
    netYards: net,
    touchback,
    returnTd: false,
    clockSec: playDuration('punt'),
    stopsClock: true,
  };
}

export function fieldGoal(ctx: GameCtx, unit: OffenseUnit): PlayOutcome {
  const { state: s, rng, inputs } = ctx;
  const kicking = s.possession;
  const distance = fgDistance(s.yardline);
  const curve = MODEL_CONFIG.kicking.fgCurve;
  const p = Math.min(
    0.995,
    Math.max(0.01, sigmoid(curve.intercept + curve.slopePerYard * distance) + unit.fgMakeShift),
  );
  const blocked = rng.chance(inputs.league.specialTeams.fgBlockRate);
  const made = !blocked && rng.chance(p);
  const kicker = unit.kicker >= 0 ? inputs.playerIds[unit.kicker]! : '';
  if (made) {
    addScore(ctx, kicking, 3, 'offense');
    setupKickoff(ctx, kicking);
  } else {
    const spot = s.yardline - (R.fgDistanceOffsetYds - 10);
    changePossession(ctx, Math.max(R.puntTouchbackYardline, 100 - spot));
  }
  return {
    kind: 'fieldGoal',
    kicker,
    distance,
    made,
    clockSec: playDuration('fieldGoal'),
    stopsClock: true,
  };
}

/** Extra point or two-point try by the team in possession, then kickoff. */
export function pat(ctx: GameCtx): PlayOutcome {
  const { state: s, rng } = ctx;
  const scoring = s.possession;
  const unit = ctx.units[scoring];
  const twoPoint = goForTwo(ctx, scoreDiff(s, scoring));
  const success = twoPoint
    ? rng.chance(MODEL_CONFIG.pat.twoPointSuccessRate)
    : rng.chance(unit.xpRate);
  s.phase = 'scrimmage';
  if (success) addScore(ctx, scoring, twoPoint ? 2 : 1, 'pat');
  setupKickoff(ctx, scoring);
  return {
    kind: 'pat',
    type: twoPoint ? 'twoPoint' : 'kick',
    success,
    clockSec: 0,
    stopsClock: true,
  };
}
