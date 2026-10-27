/**
 * One scrimmage snap, from the huddle to the whistle:
 * timeouts -> pre-snap clock runoff -> penalty check -> decision -> play -> move the ball.
 *
 * playDrive() repeats snaps until the possession, the phase or the period changes.
 */

import { inHurryUp, preSnapRunoff, runClock } from './clock';
import { MODEL_CONFIG } from './config/model.config';
import type { GameCtx } from './context';
import { halfSecondsLeft, other, recordPlay, scoreDiff, snapshotState } from './context';
import { chooseAction } from './decisions';
import { simulateKneel, simulatePass, simulatePenalty, simulateRun, simulateSpike } from './play';
import { addScore, afterTouchdown, changePossession, firstDown, setupKickoff } from './rules';
import { fieldGoal, punt } from './specialTeams';
import type { PlayOutcome, Side } from './types';

const CLK = MODEL_CONFIG.clock;
const T = MODEL_CONFIG.turnovers;

function defenseWantsTimeout(ctx: GameCtx, def: Side): boolean {
  const s = ctx.state;
  return (
    s.quarter >= 4 &&
    s.timeouts[def] > 0 &&
    scoreDiff(s, def) < 0 &&
    halfSecondsLeft(s) <= CLK.defenseTimeoutSecLeft
  );
}

function offenseWantsTimeout(ctx: GameCtx, off: Side): boolean {
  const s = ctx.state;
  return (
    s.timeouts[off] > 0 && inHurryUp(s, off) && halfSecondsLeft(s) <= CLK.offenseTimeoutSecLeft
  );
}

/** Moves the ball after a play that kept possession (unless downs run out). */
function advance(ctx: GameCtx, gain: number): void {
  const s = ctx.state;
  s.yardline += gain;
  if (gain >= s.distance) {
    firstDown(ctx);
    return;
  }
  s.distance -= gain;
  if (s.down === 4) {
    changePossession(ctx, 100 - s.yardline);
  } else {
    s.down = (s.down + 1) as 1 | 2 | 3 | 4;
  }
}

function applyPenalty(ctx: GameCtx, o: Extract<PlayOutcome, { kind: 'penalty' }>): void {
  const s = ctx.state;
  if (o.against === 'offense') {
    s.yardline -= o.yards;
    s.distance += o.yards;
    return;
  }
  s.yardline += o.yards;
  if (o.automaticFirstDown || o.yards >= s.distance) firstDown(ctx);
  else s.distance -= o.yards;
}

function applyScrimmage(ctx: GameCtx, o: PlayOutcome): void {
  const s = ctx.state;
  const off = s.possession;
  const def = other(off);
  const team = ctx.stats.team[off];

  switch (o.kind) {
    case 'interception': {
      team.turnovers += 1;
      const spot = Math.min(99, s.yardline + T.interceptionDepthYds);
      const defYardline = 100 - spot + o.returnYards;
      if (o.defensiveTd || defYardline >= 100) {
        changePossession(ctx, 50);
        addScore(ctx, def, 6, 'defense');
        afterTouchdown(ctx, def);
      } else {
        changePossession(ctx, defYardline);
      }
      return;
    }
    case 'pass':
    case 'run':
    case 'scramble':
    case 'sack': {
      if ((o.kind === 'run' || o.kind === 'sack') && o.safety) {
        addScore(ctx, def, 2, 'defense');
        setupKickoff(ctx, off, true);
        return;
      }
      if (o.kind !== 'sack' && o.td) {
        addScore(ctx, off, 6, 'offense');
        afterTouchdown(ctx, off);
        return;
      }
      if (o.fumbleLost) {
        team.turnovers += 1;
        changePossession(ctx, 100 - (s.yardline + o.yards));
        return;
      }
      advance(ctx, o.yards);
      return;
    }
    case 'kneel':
      advance(ctx, s.yardline > 1 ? -1 : 0);
      return;
    case 'spike':
      advance(ctx, 0);
      return;
    default:
      return;
  }
}

const SNAP_KINDS = new Set(['pass', 'interception', 'sack', 'scramble', 'run', 'kneel', 'spike']);

/** One snap. Returns false if the period expired before the ball was snapped. */
export function stepScrimmage(ctx: GameCtx): boolean {
  const s = ctx.state;
  const offSide = s.possession;
  const defSide = other(offSide);
  const unit = ctx.units[offSide];

  let timeoutBy: Side | undefined;
  if (s.clockRunning) {
    if (defenseWantsTimeout(ctx, defSide)) timeoutBy = defSide;
    else if (offenseWantsTimeout(ctx, offSide)) timeoutBy = offSide;
    if (timeoutBy) {
      s.timeouts[timeoutBy] -= 1;
      s.clockRunning = false;
    }
  }

  const clockAtHuddle = s.clockSec;
  if (runClock(s, preSnapRunoff(s, unit))) return false;
  const runoff = clockAtHuddle - s.clockSec;

  const before = snapshotState(ctx);
  const scoreBefore = s.score.home + s.score.away;

  let outcome = simulatePenalty(ctx, unit);
  if (outcome?.kind === 'penalty') {
    applyPenalty(ctx, outcome);
  } else {
    const action = chooseAction(ctx, unit);
    switch (action) {
      case 'pass':
        outcome = simulatePass(ctx, unit);
        break;
      case 'run':
        outcome = simulateRun(ctx, unit);
        break;
      case 'kneel':
        outcome = simulateKneel(ctx, unit);
        break;
      case 'spike':
        outcome = simulateSpike(ctx, unit);
        break;
      case 'punt':
        outcome = punt(ctx, unit);
        break;
      case 'fieldGoal':
        outcome = fieldGoal(ctx, unit);
        break;
    }
    if (SNAP_KINDS.has(outcome.kind)) {
      ctx.stats.plays += 1;
      applyScrimmage(ctx, outcome);
    }
  }

  // Possession or score changes always stop the clock.
  if (s.possession !== offSide || s.score.home + s.score.away !== scoreBefore) {
    outcome.stopsClock = true;
  }
  const clockAtSnap = s.clockSec;
  s.clockRunning = !outcome.stopsClock;
  runClock(s, outcome.clockSec);
  outcome.clockSec = runoff + (clockAtSnap - s.clockSec);
  if (timeoutBy) outcome.timeoutBy = timeoutBy;
  s.playIndex += 1;
  recordPlay(ctx, before, outcome);
  return true;
}

/** Snaps until the possession changes, the phase changes, or the period ends. */
export function playDrive(ctx: GameCtx): void {
  const s = ctx.state;
  const side = s.possession;
  while (s.phase === 'scrimmage' && s.possession === side && s.clockSec > 0) {
    if (!stepScrimmage(ctx)) return;
  }
}
