import { loadCalibrationSet } from '../engine/test/calibration/measure';
import { applySettings, DEFAULT_OVERRIDES, DEFAULT_SETTINGS, ENGINE_VERSION } from '@rerun/engine';
import { createGameCtx } from '../engine/src/game';
import { passProbability } from '../engine/src/playCall';
const { targets, snapshots } = loadCalibrationSet();
const wanted = new Set(targets.calibrationGames.map((g) => g.gameId));
let sum = 0,
  n = 0,
  grid = 0,
  proe = 0,
  offPen = 0,
  defPen = 0;
for (const snap of snapshots) {
  grid += snap.league.season.passRateByDownDist[0][3];
  for (const g of snap.games) {
    if (!wanted.has(g.gameId)) continue;
    const inputs = applySettings(
      {
        snapshotId: snap.id,
        gameId: g.gameId,
        engineVersion: ENGINE_VERSION,
        settings: DEFAULT_SETTINGS,
        overrides: DEFAULT_OVERRIDES,
        nSims: 1000,
        seed: 1,
      },
      snap,
    );
    const ctx = createGameCtx(inputs, 0);
    Object.assign(ctx.state, {
      phase: 'scrimmage',
      quarter: 1,
      clockSec: 800,
      down: 1,
      distance: 10,
      yardline: 25,
      score: { home: 0, away: 0 },
    });
    for (const side of ['home', 'away'] as const) {
      ctx.state.possession = side;
      sum += passProbability(ctx, ctx.units[side]);
      n++;
      proe += ctx.units[side].proeShift;
      offPen += ctx.units[side].offensePenaltyRate;
      defPen += ctx.units[side].defensePenaltyRate;
    }
  }
}
console.log(
  'grid 1st&10',
  (grid / snapshots.length).toFixed(3),
  'mean proeShift',
  (proe / n).toFixed(4),
  'passProb q1 0-0 1st&10',
  (sum / n).toFixed(3),
  'offPen',
  (offPen / n).toFixed(3),
  'defPen',
  (defPen / n).toFixed(3),
);
