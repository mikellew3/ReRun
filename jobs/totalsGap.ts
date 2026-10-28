/**
 * Compares sim scoring with the market for every game in a snapshot: game totals, team totals
 * and a few drive stats, so a gap can be traced to offense, defense or game flow.
 *
 * Usage: npx tsx jobs/totalsGap.ts <snapshot.json>... [--n 2000] [--seed 1] [--off weather]
 *        [--finals finals.json]   gameId -> {home, away, total}: real scores and closing total,
 *                                 for historical snapshots that have no market lines
 */

import { readFileSync } from 'node:fs';
import { DEFAULT_OVERRIDES, DEFAULT_SETTINGS, ENGINE_VERSION, runSims } from '@rerun/engine';
import type { RunRequest, SimCount, SlateSnapshot } from '@rerun/engine';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const files = process.argv
  .slice(2)
  .filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
const finalsFile = arg('finals', '');
const finals: Record<string, { home: number; away: number; total: number }> = finalsFile
  ? JSON.parse(readFileSync(finalsFile, 'utf8'))
  : {};
const n = Number(arg('n', '2000')) as SimCount;
const seed = Number(arg('seed', '1'));
// --off injuries,weather turns adjustments off, to see how much each one moves scoring.
const off = arg('off', '').split(',').filter(Boolean);
const settings = {
  ...DEFAULT_SETTINGS,
  adjustments: {
    ...DEFAULT_SETTINGS.adjustments,
    ...Object.fromEntries(off.map((k) => [k, false])),
  },
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

const rows: {
  game: string;
  sim: number;
  mkt: number;
  home: number;
  away: number;
  real?: number;
  tth?: number;
  tta?: number;
}[] = [];
for (const file of files) {
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as SlateSnapshot;
  for (const game of snapshot.games) {
    const request: RunRequest = {
      snapshotId: snapshot.id,
      gameId: game.gameId,
      engineVersion: ENGINE_VERSION,
      settings,
      overrides: DEFAULT_OVERRIDES,
      nSims: n,
      seed,
    };
    const results = runSims(request, snapshot);
    const line = (m: string, side?: string) =>
      game.market.find(
        (x) => x.market === m && x.selection === 'over' && (!side || x.side === side),
      )?.line ?? NaN;
    rows.push({
      game: `${game.away}@${game.home}`,
      sim: mean(results.map((r) => r.final.home + r.final.away)),
      mkt: finals[game.gameId]?.total ?? line('totals'),
      real: finals[game.gameId] ? finals[game.gameId]!.home + finals[game.gameId]!.away : undefined,
      home: mean(results.map((r) => r.final.home)),
      away: mean(results.map((r) => r.final.away)),
      tth: line('team_totals', 'home'),
      tta: line('team_totals', 'away'),
    });
  }
}
for (const r of rows) {
  console.log(
    `${r.game.padEnd(9)} sim ${r.sim.toFixed(1)}  mkt ${r.mkt}  gap ${(r.sim - r.mkt).toFixed(1).padStart(5)}` +
      `   away ${r.away.toFixed(1)} vs ${r.tta}   home ${r.home.toFixed(1)} vs ${r.tth}`,
  );
}
const ok = rows.filter((r) => !Number.isNaN(r.mkt));
const real = rows.filter((r) => r.real !== undefined);
if (real.length > 0) {
  console.log(
    `\n${real.length} played games: real total ${mean(real.map((r) => r.real!)).toFixed(2)}  sim minus real ${mean(real.map((r) => r.sim - r.real!)).toFixed(2)}`,
  );
}
console.log(
  `\nmean sim ${mean(ok.map((r) => r.sim)).toFixed(2)}  mean market ${mean(ok.map((r) => r.mkt)).toFixed(2)}  gap ${mean(ok.map((r) => r.sim - r.mkt)).toFixed(2)}`,
);
