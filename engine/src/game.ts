/**
 * Full game: coin toss, kickoffs, drives, PATs, quarters, halftime, overtime.
 * One call = one simulated game, fully determined by (inputs, simIndex).
 */

import type { GameInputs } from './applySettings';
import { withUsageNoise } from './applySettings';
import { GameStats, newGameState, other, recordPlay, snapshotState } from './context';
import type { GameCtx } from './context';
import { playDrive } from './drive';
import { createRng, gameSeed } from './rng';
import { setupKickoff, startOvertime } from './rules';
import { kickoff, pat } from './specialTeams';
import type { GameState, PlayRecord, PlayerGameLine, SimGameResult, Side } from './types';
import { MODEL_CONFIG } from './config/model.config';

const MAX_STEPS = 5000;

function currentPhase(ctx: GameCtx): GameState['phase'] {
  return ctx.state.phase;
}

function endPeriod(ctx: GameCtx): void {
  const s = ctx.state;
  s.clockRunning = false;
  switch (s.quarter) {
    case 1:
    case 3:
      s.quarter += 1;
      s.clockSec = MODEL_CONFIG.rules.quarterSec;
      return;
    case 2:
      ctx.firstHalf = { ...s.score };
      s.quarter = 3;
      s.clockSec = MODEL_CONFIG.rules.quarterSec;
      s.timeouts = {
        home: MODEL_CONFIG.rules.timeoutsPerHalf,
        away: MODEL_CONFIG.rules.timeoutsPerHalf,
      };
      setupKickoff(ctx, other(s.secondHalfReceiver));
      return;
    case 4:
      if (s.score.home !== s.score.away) s.phase = 'final';
      else startOvertime(ctx);
      return;
    default: {
      const rules = MODEL_CONFIG.rules.overtime.postseason;
      if (ctx.inputs.regularSeason || s.score.home !== s.score.away) {
        s.phase = 'final';
      } else {
        s.clockSec = rules.periodSec; // postseason: another OT period
      }
    }
  }
}

function buildResult(ctx: GameCtx, simIndex: number): SimGameResult {
  const st = ctx.stats;
  const players: PlayerGameLine[] = [];
  const ids = ctx.inputs.playerIds;
  for (let i = 0; i < ids.length; i++) {
    if (st.passAtt[i] || st.rushAtt[i] || st.targets[i]) {
      players.push({
        playerId: ids[i]!,
        passAtt: st.passAtt[i]!,
        passCmp: st.passCmp[i]!,
        passYds: st.passYds[i]!,
        passTd: st.passTd[i]!,
        passInt: st.passInt[i]!,
        rushAtt: st.rushAtt[i]!,
        rushYds: st.rushYds[i]!,
        rushTd: st.rushTd[i]!,
        targets: st.targets[i]!,
        rec: st.rec[i]!,
        recYds: st.recYds[i]!,
        recTd: st.recTd[i]!,
      });
    }
  }
  const s = ctx.state;
  return {
    simIndex,
    final: { ...s.score },
    firstHalf: ctx.firstHalf ?? { ...s.score },
    overtime: s.ot !== null,
    plays: st.plays,
    team: { home: { ...st.team.home }, away: { ...st.team.away } },
    players,
  };
}

/** Sets up one sim: its RNG stream, who is available, the offenses and the coin toss. */
export function createGameCtx(inputs: GameInputs, simIndex: number, record = false): GameCtx {
  const rng = createRng(gameSeed(inputs.request.seed, inputs.request.gameId), simIndex);
  const availability = inputs.drawAvailability(rng);
  const units = {
    home: withUsageNoise(
      inputs.offense('home', availability.home.available, availability.home.key),
      rng,
    ),
    away: withUsageNoise(
      inputs.offense('away', availability.away.available, availability.away.key),
      rng,
    ),
  };
  const firstReceiver: Side = rng.chance(0.5) ? 'home' : 'away';
  const ctx: GameCtx = {
    inputs,
    rng,
    state: newGameState(firstReceiver, other(firstReceiver)),
    units,
    stats: new GameStats(inputs.playerIds.length),
    safetyKick: false,
    firstHalf: null,
    record: record ? [] : null,
  };
  return ctx;
}

export function simulateGame(
  inputs: GameInputs,
  simIndex: number,
  record = false,
): { result: SimGameResult; plays: PlayRecord[] | null } {
  const ctx = createGameCtx(inputs, simIndex, record);
  const s = ctx.state;

  for (let step = 0; s.phase !== 'final'; step++) {
    if (step > MAX_STEPS) throw new Error(`Sim ${simIndex} did not finish (engine bug)`);
    if (s.phase === 'kickoff') {
      const before = snapshotState(ctx);
      recordPlay(ctx, before, kickoff(ctx));
    } else if (s.phase === 'pat') {
      const before = snapshotState(ctx);
      recordPlay(ctx, before, pat(ctx));
    } else {
      playDrive(ctx);
    }
    // Read through a function: the steps above change the phase (TypeScript can't see that).
    const phase = currentPhase(ctx);
    if (phase !== 'pat' && phase !== 'final' && s.clockSec <= 0) endPeriod(ctx);
  }
  return { result: buildResult(ctx, simIndex), plays: ctx.record };
}
