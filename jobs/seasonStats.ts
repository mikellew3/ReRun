/**
 * Scoring components per game from replayed sims (drives, field position, red zone, kicks),
 * to compare with real play-by-play (pipeline/season_stats.py) when sim scoring drifts from
 * real scoring.
 *
 * Usage: npx tsx jobs/seasonStats.ts <snapshot.json>... [--replays 20] [--seed 1]
 */

import { readFileSync } from 'node:fs';
import {
  DEFAULT_OVERRIDES,
  DEFAULT_SETTINGS,
  ENGINE_VERSION,
  MODEL_CONFIG,
  replayGame,
} from '@rerun/engine';
import type { SlateSnapshot } from '@rerun/engine';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const files = process.argv
  .slice(2)
  .filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
const replays = Number(arg('replays', '20'));

// --patch '{"redZone":{"completionLogitShift":-0.05}}' overrides engine constants for a
// what-if run (merged into MODEL_CONFIG in place before any sims).
function merge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      merge(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}
merge(MODEL_CONFIG as unknown as Record<string, unknown>, JSON.parse(arg('patch', '{}')));
const seed = Number(arg('seed', '1'));

const SNAPS = new Set(['pass', 'interception', 'sack', 'scramble', 'run']);
// By drive start (own yardline bucket): drives, reached the red zone, TD, FG made.
const BUCKETS = [20, 30, 40, 60, 99];
const byStart = BUCKETS.map(() => ({ n: 0, rz: 0, td: 0, fg: 0, opp40: 0 }));
const gains: Record<string, number[]> = { d1: [], d2: [] };
let firstDowns = 0;
const fgByDist: Record<string, number> = {};
const fgReason: Record<string, number> = {};
const startBy: Record<string, { n: number; sum: number }> = {};
const s = {
  games: 0,
  pts: 0,
  tds: 0,
  offTds: 0,
  fga: 0,
  fgm: 0,
  fga50: 0,
  fgm50: 0,
  punts: 0,
  plays: 0,
  yards: 0,
  drives: 0,
  startSum: 0,
  turnovers: 0,
  fourth: 0,
  fourthGo: 0,
  rzDrives: 0,
  rzTds: 0,
  twoPt: 0,
  patMiss: 0,
  kickStarts: 0,
  kickStartSum: 0,
  puntStarts: 0,
  puntStartSum: 0,
  kickTb: 0,
  third: 0,
  thirdConv: 0,
  thirdDist: 0,
  firstDownPlays: 0,
  firstDownYds: 0,
  firstDownSuccess: 0,
};

for (const file of files) {
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as SlateSnapshot;
  for (const game of snapshot.games) {
    for (let i = 0; i < replays; i++) {
      const { plays, result } = replayGame(
        {
          snapshotId: snapshot.id,
          gameId: game.gameId,
          engineVersion: ENGINE_VERSION,
          settings: DEFAULT_SETTINGS,
          overrides: DEFAULT_OVERRIDES,
          nSims: 1000,
          seed,
        },
        snapshot,
        i,
      );
      s.games++;
      s.pts += result.final.home + result.final.away;
      const drives = new Map<
        number,
        { start: number; rz: boolean; td: boolean; fg: boolean; o40: boolean }
      >();
      plays.forEach(({ before: b, outcome: o }, j) => {
        const next = plays[j + 1]?.before;
        if (
          next &&
          next.driveIndex === b.driveIndex &&
          next.down === 1 &&
          next.possession === b.possession &&
          o.kind !== 'kickoff' &&
          o.kind !== 'pat'
        )
          firstDowns++;
        if (b.distance === 10 && b.down === 1 && b.yardline < 80) {
          const gain =
            (o.kind === 'pass' && o.result === 'complete') ||
            o.kind === 'run' ||
            o.kind === 'scramble' ||
            o.kind === 'sack'
              ? o.yards
              : o.kind === 'pass' || o.kind === 'interception'
                ? 0
                : null;
          if (gain !== null) gains.d1!.push(gain);
        }
      });
      let prev: string | null = null;
      let turnover = false;
      for (const { before: b, outcome: o } of plays) {
        const after = prev;
        const prevTurnover = turnover;
        prev = o.kind;
        turnover = o.kind === 'interception' || ('fumbleLost' in o && o.fumbleLost);
        if (o.kind === 'kickoff' || o.kind === 'pat') {
          if (o.kind === 'pat' && o.type === 'twoPoint') s.twoPt++;
          if (o.kind === 'pat' && o.type === 'kick' && !o.success) s.patMiss++;
          if (o.kind === 'kickoff' && o.returnTd) s.tds++;
          if (o.kind === 'kickoff' && o.touchback) s.kickTb++;
          continue;
        }
        let d = drives.get(b.driveIndex);
        if (!d) {
          d = { start: b.yardline, rz: false, td: false, fg: false, o40: false };
          drives.set(b.driveIndex, d);
          const why =
            after === null
              ? 'none'
              : prevTurnover
                ? 'turnover'
                : after === 'fieldGoal'
                  ? 'missedFg'
                  : SNAPS.has(after)
                    ? 'downs'
                    : after;
          startBy[why] ??= { n: 0, sum: 0 };
          startBy[why].n++;
          startBy[why].sum += b.yardline;
          if (after === 'kickoff') {
            s.kickStarts++;
            s.kickStartSum += b.yardline;
          }
          if (after === 'punt') {
            s.puntStarts++;
            s.puntStartSum += b.yardline;
          }
        }
        if (b.yardline >= 80) d.rz = true;
        if (b.yardline >= 60) d.o40 = true;
        if (o.kind === 'fieldGoal' && o.made) d.fg = true;
        if (SNAPS.has(o.kind)) s.plays++;
        const gain =
          (o.kind === 'pass' && o.result === 'complete') ||
          o.kind === 'run' ||
          o.kind === 'scramble' ||
          o.kind === 'sack'
            ? o.yards
            : 0;
        if (b.down === 3 && SNAPS.has(o.kind)) {
          s.third++;
          s.thirdDist += b.distance;
          if (gain >= b.distance) s.thirdConv++;
        }
        if (b.down === 1 && SNAPS.has(o.kind)) {
          s.firstDownPlays++;
          s.firstDownYds += gain;
          if (gain >= 0.4 * b.distance) s.firstDownSuccess++;
        }
        if (o.kind === 'pass' && o.result === 'complete') s.yards += o.yards;
        if (o.kind === 'sack' || o.kind === 'scramble' || o.kind === 'run') s.yards += o.yards;
        if ((o.kind === 'pass' || o.kind === 'run' || o.kind === 'scramble') && o.td) {
          s.tds++;
          s.offTds++;
          d.td = true;
        }
        if (o.kind === 'interception') {
          s.turnovers++;
          if (o.defensiveTd) s.tds++;
        }
        if ('fumbleLost' in o && o.fumbleLost) s.turnovers++;
        if (o.kind === 'punt') {
          s.punts++;
          if (o.returnTd) s.tds++;
        }
        if (o.kind === 'fieldGoal') {
          const bucket = `${Math.floor(o.distance / 10) * 10}s`;
          fgByDist[bucket] = (fgByDist[bucket] ?? 0) + 1;
          const why = b.down === 4 ? '4th' : 'clock';
          fgReason[why] = (fgReason[why] ?? 0) + 1;
          s.fga++;
          if (o.made) s.fgm++;
          if (o.distance >= 50) {
            s.fga50++;
            if (o.made) s.fgm50++;
          }
        }
        if (b.down === 4 && (SNAPS.has(o.kind) || o.kind === 'punt' || o.kind === 'fieldGoal')) {
          s.fourth++;
          if (SNAPS.has(o.kind)) s.fourthGo++;
        }
      }
      for (const d of drives.values()) {
        const k = byStart[BUCKETS.findIndex((u) => d.start <= u)]!;
        k.n++;
        if (d.rz) k.rz++;
        if (d.o40) k.opp40++;
        if (d.td) k.td++;
        if (d.fg) k.fg++;
        s.drives++;
        s.startSum += d.start;
        if (d.rz) {
          s.rzDrives++;
          if (d.td) s.rzTds++;
        }
      }
    }
  }
}

const g = s.games;
const out = {
  games: g,
  points: s.pts / g,
  touchdowns: s.tds / g,
  offenseTds: s.offTds / g,
  fga: s.fga / g,
  fgRate: s.fgm / s.fga,
  fga50: s.fga50 / g,
  fg50Rate: s.fgm50 / Math.max(1, s.fga50),
  punts: s.punts / g,
  plays: s.plays / g,
  yardsPerPlay: s.yards / s.plays,
  drives: s.drives / g,
  driveStart: s.startSum / s.drives,
  turnovers: s.turnovers / g,
  fourthGoRate: s.fourthGo / s.fourth,
  redZoneDrives: s.rzDrives / g,
  redZoneTdRate: s.rzTds / s.rzDrives,
  pointsPerDrive: s.pts / s.drives,
  twoPt: s.twoPt / g,
  startAfterKickoff: s.kickStartSum / s.kickStarts,
  startAfterPunt: s.puntStartSum / s.puntStarts,
  thirdDist: s.thirdDist / s.third,
  thirdConv: s.thirdConv / s.third,
  firstDownYpp: s.firstDownYds / s.firstDownPlays,
  firstDownSuccess: s.firstDownSuccess / s.firstDownPlays,
};
console.log(
  JSON.stringify(out, (_k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)),
);
console.log(
  Object.entries(startBy)
    .map(([k, v]) => `${k}: ${(v.n / g).toFixed(2)}/g @ ${(v.sum / v.n).toFixed(1)}`)
    .join('  '),
);
console.log(
  byStart
    .map(
      (k, i) =>
        `<=${BUCKETS[i]}: ${(k.n / g).toFixed(2)}/g opp40 ${(k.opp40 / k.n).toFixed(3)} rz ${(k.rz / k.n).toFixed(3)} td ${(k.td / k.n).toFixed(3)} fg ${(k.fg / k.n).toFixed(3)}`,
    )
    .join('\n'),
);
const q = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];
console.log(
  `first downs/g ${(firstDowns / g).toFixed(2)}  1st&10 gain quantiles 25/50/75/90: ${[0.25, 0.5, 0.75, 0.9].map((p) => q(gains.d1!, p)).join('/')}  share>=4 ${(gains.d1!.filter((x) => x >= 4).length / gains.d1!.length).toFixed(3)} share>=10 ${(gains.d1!.filter((x) => x >= 10).length / gains.d1!.length).toFixed(3)}  mean ${(gains.d1!.reduce((a, b) => a + b, 0) / gains.d1!.length).toFixed(2)}`,
);
console.log(
  'FGA by distance/g',
  Object.entries(fgByDist)
    .sort()
    .map(([k, v]) => `${k} ${(v / g).toFixed(2)}`)
    .join(' '),
  ' by reason/g',
  Object.entries(fgReason)
    .map(([k, v]) => `${k} ${(v / g).toFixed(2)}`)
    .join(' '),
);
