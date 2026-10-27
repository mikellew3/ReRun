/**
 * Prop calibration: are the sim's player stat distributions the right shape?
 *
 * No historical prop odds are used (the brief says not to buy them). Instead every
 * prop-relevant player in the 184 calibration games is checked against his real box score:
 *
 * - PIT: where the actual result fell in the sim's distribution (0 = below every sim, 1 = above).
 *   If the distributions are right, PIT is uniform: mean 0.5, half of results inside the sim's
 *   middle 50%, 80% inside its middle 80%. Coverage below that = sim ranges too narrow
 *   (overconfident props); above = too wide. Mean PIT above 0.5 = sim projects too low.
 * - Over/under at book-style lines: half-point lines at the sim's 30th, 50th and 70th
 *   percentiles. The sim's P(over) is compared with how often the over actually hit.
 * - Anytime TD: predicted probability vs hit rate, by probability bucket.
 *
 * Props are void when the player doesn't play, so sims where a questionable player sat are
 * skipped for him, and players the snapshot lists as out are skipped (counted separately).
 * Only players a book would post a line for are included (thresholds below).
 *
 * Usage: npx tsx jobs/checkProps.ts [--n 1000] [--seed 2026] [--out docs/props-check.json]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_OVERRIDES,
  DEFAULT_SETTINGS,
  ENGINE_VERSION,
  createRng,
  prepareRun,
  runSimsWithInputs,
} from '@rerun/engine';
import type { PlayerGameLine } from '@rerun/engine';
import { loadCalibrationSet } from '../engine/test/calibration/measure';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const n = Number(arg('n', '1000'));
const seed = Number(arg('seed', '2026'));
const outPath = arg('out', '');

type Box = Record<
  | 'passAtt'
  | 'passCmp'
  | 'passYds'
  | 'passTd'
  | 'passInt'
  | 'carries'
  | 'rushYds'
  | 'rushTd'
  | 'targets'
  | 'rec'
  | 'recYds'
  | 'recTd',
  number
>;
const box = JSON.parse(
  gunzipSync(
    readFileSync(
      fileURLToPath(
        new URL('../engine/test/fixtures/calibration/player_games.json.gz', import.meta.url),
      ),
    ),
  ).toString('utf8'),
) as Record<string, Record<string, Box>>;

/** One prop market: how to read the stat from a sim line and from the box score, and which
 *  players get a line (by the sim's own mean of `gateStat`). */
interface Market {
  key: string;
  sim: (l: PlayerGameLine) => number;
  actual: (b: Box) => number;
  gate: (mean: (f: (l: PlayerGameLine) => number) => number, position: string) => boolean;
}

const MARKETS: Market[] = [
  {
    key: 'player_pass_yds',
    sim: (l) => l.passYds,
    actual: (b) => b.passYds,
    gate: (m, pos) => pos === 'QB' && m((l) => l.passAtt) >= 15,
  },
  {
    key: 'player_pass_attempts',
    sim: (l) => l.passAtt,
    actual: (b) => b.passAtt,
    gate: (m, pos) => pos === 'QB' && m((l) => l.passAtt) >= 15,
  },
  {
    key: 'player_pass_completions',
    sim: (l) => l.passCmp,
    actual: (b) => b.passCmp,
    gate: (m, pos) => pos === 'QB' && m((l) => l.passAtt) >= 15,
  },
  {
    key: 'player_pass_tds',
    sim: (l) => l.passTd,
    actual: (b) => b.passTd,
    gate: (m, pos) => pos === 'QB' && m((l) => l.passAtt) >= 15,
  },
  {
    key: 'player_pass_interceptions',
    sim: (l) => l.passInt,
    actual: (b) => b.passInt,
    gate: (m, pos) => pos === 'QB' && m((l) => l.passAtt) >= 15,
  },
  {
    key: 'player_rush_yds',
    sim: (l) => l.rushYds,
    actual: (b) => b.rushYds,
    gate: (m, pos) => (pos === 'QB' ? m((l) => l.rushYds) >= 15 : m((l) => l.rushAtt) >= 5),
  },
  {
    key: 'player_rush_attempts',
    sim: (l) => l.rushAtt,
    actual: (b) => b.carries,
    gate: (m, pos) => pos !== 'QB' && m((l) => l.rushAtt) >= 5,
  },
  {
    key: 'player_receptions',
    sim: (l) => l.rec,
    actual: (b) => b.rec,
    gate: (m, pos) => pos !== 'QB' && m((l) => l.targets) >= 3,
  },
  {
    key: 'player_reception_yds',
    sim: (l) => l.recYds,
    actual: (b) => b.recYds,
    gate: (m, pos) => pos !== 'QB' && m((l) => l.targets) >= 3,
  },
  {
    key: 'player_anytime_td',
    sim: (l) => (l.rushTd + l.recTd > 0 ? 1 : 0),
    actual: (b) => (b.rushTd + b.recTd > 0 ? 1 : 0),
    gate: (m, pos) => pos !== 'QB' && m((l) => (l.rushTd + l.recTd > 0 ? 1 : 0)) >= 0.08,
  },
];

interface Obs {
  pit: number;
  actual: number;
  simMean: number;
  /** [line, sim P(over), actual over 0/1] at the 30th/50th/70th percentile lines. */
  lines: [number, number, number][];
}

const { targets, snapshots } = loadCalibrationSet();
const wanted = new Set(targets.calibrationGames.map((g) => g.gameId));
const obs: Record<string, Obs[]> = Object.fromEntries(MARKETS.map((m) => [m.key, []]));
let listedOutButPlayed = 0;
const pitRng = createRng(seed, 7);
const t0 = performance.now();

/** Half-point line at the q-th quantile of sorted values (books hang x.5 lines). */
function halfPointLine(sorted: number[], q: number): number {
  const v = sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return Math.floor(v) + 0.5;
}

for (const snapshot of snapshots) {
  for (const game of snapshot.games) {
    if (!wanted.has(game.gameId)) continue;
    const inputs = prepareRun(
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
    );
    const results = runSimsWithInputs(inputs, { count: n });
    const playable = new Set<string>();
    for (const side of ['home', 'away'] as const) {
      const t = inputs.teams[side];
      for (const idx of t.fixedIn) playable.add(inputs.playerIds[idx]!);
      for (const u of t.uncertain) playable.add(inputs.playerIds[u.idx]!);
    }
    const lines = results.map((r) => new Map(r.players.map((l) => [l.playerId, l])));
    const sat = results.map((r) => new Set(r.sittingOut));

    for (const [pid, actualBox] of Object.entries(box[game.gameId] ?? {})) {
      const info = snapshot.players[pid];
      if (!info) continue;
      if (!playable.has(pid)) {
        if (actualBox.passAtt + actualBox.carries + actualBox.targets > 0) listedOutButPlayed++;
        continue;
      }
      // Sims where he played; an empty line means he played and recorded nothing.
      const played = results.flatMap((_, i) => (sat[i]!.has(pid) ? [] : [i]));
      if (played.length < 50) continue;
      const zero: PlayerGameLine = {
        playerId: pid,
        passAtt: 0,
        passCmp: 0,
        passYds: 0,
        passTd: 0,
        passInt: 0,
        rushAtt: 0,
        rushYds: 0,
        rushTd: 0,
        targets: 0,
        rec: 0,
        recYds: 0,
        recTd: 0,
      };
      const lineOf = (i: number) => lines[i]!.get(pid) ?? zero;
      const mean = (f: (l: PlayerGameLine) => number) =>
        played.reduce((a, i) => a + f(lineOf(i)), 0) / played.length;

      for (const m of MARKETS) {
        if (!m.gate(mean, info.position)) continue;
        const vals = played.map((i) => m.sim(lineOf(i))).sort((a, b) => a - b);
        const a = m.actual(actualBox);
        const below = vals.filter((v) => v < a).length / vals.length;
        const at = vals.filter((v) => v === a).length / vals.length;
        const over = (line: number) => vals.filter((v) => v > line).length / vals.length;
        const qs = m.key === 'player_anytime_td' ? [] : [0.3, 0.5, 0.7];
        obs[m.key]!.push({
          pit: below + pitRng.next() * at,
          actual: a,
          simMean: vals.reduce((s, v) => s + v, 0) / vals.length,
          lines: qs.map((q) => {
            const line = halfPointLine(vals, q);
            return [line, over(line), a > line ? 1 : 0];
          }),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const avg = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length);
const se = (p: number, k: number) => Math.sqrt((p * (1 - p)) / Math.max(1, k));

interface Row {
  market: string;
  n: number;
  actualMean: number;
  simMean: number;
  pitMean: number;
  cover50: number;
  cover80: number;
  /** Per line type (p30, p50, p70): sim P(over) vs actual over rate. */
  overs: { line: string; simOver: number; actualOver: number; se: number }[];
  /** Anytime TD only: by predicted-probability bucket. */
  buckets?: { range: string; n: number; predicted: number; actual: number; se: number }[];
}

const rows: Row[] = [];
for (const m of MARKETS) {
  const o = obs[m.key]!;
  const row: Row = {
    market: m.key,
    n: o.length,
    actualMean: avg(o.map((x) => x.actual)),
    simMean: avg(o.map((x) => x.simMean)),
    pitMean: avg(o.map((x) => x.pit)),
    cover50: avg(o.map((x) => (x.pit >= 0.25 && x.pit <= 0.75 ? 1 : 0))),
    cover80: avg(o.map((x) => (x.pit >= 0.1 && x.pit <= 0.9 ? 1 : 0))),
    overs: ['p30', 'p50', 'p70'].map((label, j) => {
      const xs = o.filter((x) => x.lines[j]);
      const actualOver = avg(xs.map((x) => x.lines[j]![2]));
      return {
        line: label,
        simOver: avg(xs.map((x) => x.lines[j]![1])),
        actualOver,
        se: se(actualOver, xs.length),
      };
    }),
  };
  if (m.key === 'player_anytime_td') {
    row.overs = [];
    const edges = [0.08, 0.2, 0.3, 0.4, 0.5, 1.01];
    row.buckets = edges.slice(0, -1).map((lo, i) => {
      const hi = edges[i + 1]!;
      const xs = o.filter((x) => x.simMean >= lo && x.simMean < hi);
      const actual = avg(xs.map((x) => x.actual));
      return {
        range: `${Math.round(lo * 100)}-${Math.min(100, Math.round(hi * 100))}%`,
        n: xs.length,
        predicted: avg(xs.map((x) => x.simMean)),
        actual,
        se: se(actual, xs.length),
      };
    });
  }
  rows.push(row);
}

const f = (x: number, d = 2) => x.toFixed(d);
console.log(
  `Prop calibration: ${targets.calibrationGames.length} games, ${n} sims each, seed ${seed}, engine ${ENGINE_VERSION}.`,
);
console.log('Ideal: PIT mean 0.50, cover50 0.50, cover80 0.80, sim P(over) = actual over rate.\n');
console.log(
  [
    'market'.padEnd(26),
    'n'.padStart(5),
    'actual'.padStart(8),
    'sim'.padStart(8),
    'PIT'.padStart(6),
    'cov50'.padStart(7),
    'cov80'.padStart(7),
    '   over@p30 sim/act',
    '   over@p50 sim/act',
    '   over@p70 sim/act',
  ].join(''),
);
for (const r of rows) {
  console.log(
    [
      r.market.padEnd(26),
      String(r.n).padStart(5),
      f(r.actualMean).padStart(8),
      f(r.simMean).padStart(8),
      f(r.pitMean).padStart(6),
      f(r.cover50).padStart(7),
      f(r.cover80).padStart(7),
      ...r.overs.map((o) => `${f(o.simOver)}/${f(o.actualOver)}±${f(o.se)}`.padStart(19)),
    ].join(''),
  );
}
const td = rows.find((r) => r.buckets)!;
console.log('\nAnytime TD by predicted probability:');
for (const b of td.buckets!) {
  console.log(
    `  ${b.range.padEnd(8)} n=${String(b.n).padStart(4)}  predicted ${f(b.predicted)}  actual ${f(b.actual)} ± ${f(b.se)}`,
  );
}
console.log(
  `\nPlayers listed out in the snapshot who played: ${listedOutButPlayed}. ${((performance.now() - t0) / 1000).toFixed(0)}s`,
);
if (outPath) {
  writeFileSync(
    outPath,
    `${JSON.stringify({ engineVersion: ENGINE_VERSION, n, seed, games: targets.calibrationGames.length, listedOutButPlayed, rows }, null, 2)}\n`,
  );
}
