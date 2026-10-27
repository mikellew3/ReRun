/**
 * Checks each situational adjustment (CLAUDE.md §9.7: "each toggleable and backtested on its
 * own") on the committed calibration set: 184 games from 2023-2025, each simmed from a
 * walk-forward snapshot taken 90 minutes before its slate.
 *
 * Every variant runs the same games with the same seed (common random numbers), so differences
 * between variants come from the adjustment, not sim noise. Each variant is scored against:
 *   - closing lines: margin and total error vs the closing spread and total
 *   - results: margin and total error vs the final score, log loss of the home-win probability
 *   - box scores: per-player targets, receiving yards, carries, rushing yards (non-QBs)
 * and compared with the "none" variant (all adjustments off), with standard errors.
 *
 * Usage: npx tsx jobs/checkAdjustments.ts [--n 400] [--seed 2026] [--out docs/adjustments-check.json]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OVERRIDES, DEFAULT_SETTINGS, ENGINE_VERSION, runSims } from '@rerun/engine';
import type { SimSettings } from '@rerun/engine';
import { loadCalibrationSet } from '../engine/test/calibration/measure';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const n = Number(arg('n', '400'));
const seed = Number(arg('seed', '2026'));
const outPath = arg('out', '');

type Line = { targets: number; rec: number; recYds: number; carries: number; rushYds: number };
const actualLines = JSON.parse(
  gunzipSync(
    readFileSync(
      fileURLToPath(
        new URL('../engine/test/fixtures/calibration/player_games.json.gz', import.meta.url),
      ),
    ),
  ).toString('utf8'),
) as Record<string, Record<string, Line>>;

const OFF = { injuries: false, weather: false, venue: false, rest: false };
function variant(
  adjustments: Partial<SimSettings['adjustments']>,
  lenses: Partial<SimSettings['lenses']> = {},
): SimSettings {
  return {
    ...DEFAULT_SETTINGS,
    lenses: { ...DEFAULT_SETTINGS.lenses, matchupWeight: 0, ...lenses },
    adjustments: { ...OFF, ...adjustments },
  };
}

const VARIANTS: Record<string, SimSettings> = {
  none: variant({}),
  injuries: variant({ injuries: true }),
  weather: variant({ weather: true }),
  venue: variant({ venue: true }),
  rest: variant({ rest: true }),
  matchup: variant({}, { matchupWeight: 1 }),
  defaults: DEFAULT_SETTINGS,
  'defaults+streaks': {
    ...DEFAULT_SETTINGS,
    lenses: { ...DEFAULT_SETTINGS.lenses, streaks: true },
  },
};

type GameScore = {
  gameId: string;
  marginVsSpread: number;
  marginVsResult: number;
  totalVsLine: number;
  totalVsResult: number;
  logLoss: number;
};
type PlayerScore = {
  key: string;
  targets: number;
  recYds: number;
  carries: number;
  rushYds: number;
};

const { targets, snapshots } = loadCalibrationSet();
const lines = new Map(targets.calibrationGames.map((g) => [g.gameId, g]));

function score(settings: SimSettings): { games: GameScore[]; players: PlayerScore[] } {
  const games: GameScore[] = [];
  const players: PlayerScore[] = [];
  for (const snapshot of snapshots) {
    for (const game of snapshot.games) {
      const line = lines.get(game.gameId);
      if (!line) continue;
      const results = runSims(
        {
          snapshotId: snapshot.id,
          gameId: game.gameId,
          engineVersion: ENGINE_VERSION,
          settings,
          overrides: DEFAULT_OVERRIDES,
          nSims: 1000,
          seed,
        },
        snapshot,
        { count: n },
      );
      let margin = 0;
      let total = 0;
      let homeWin = 0;
      const sums = new Map<string, Line>();
      for (const r of results) {
        const m = r.final.home - r.final.away;
        margin += m / n;
        total += (r.final.home + r.final.away) / n;
        homeWin += (m > 0 ? 1 : m === 0 ? 0.5 : 0) / n;
        for (const l of r.players) {
          const s = sums.get(l.playerId) ?? {
            targets: 0,
            rec: 0,
            recYds: 0,
            carries: 0,
            rushYds: 0,
          };
          s.targets += l.targets / n;
          s.recYds += l.recYds / n;
          s.carries += l.rushAtt / n;
          s.rushYds += l.rushYds / n;
          sums.set(l.playerId, s);
        }
      }
      const p = Math.min(0.999, Math.max(0.001, homeWin));
      const won = line.result > 0 ? 1 : line.result === 0 ? 0.5 : 0;
      games.push({
        gameId: game.gameId,
        marginVsSpread: (margin - line.spreadLine) ** 2,
        marginVsResult: (margin - line.result) ** 2,
        totalVsLine: (total - line.totalLine) ** 2,
        totalVsResult: (total - line.total) ** 2,
        logLoss: -(won * Math.log(p) + (1 - won) * Math.log(1 - p)),
      });
      const actual = actualLines[game.gameId] ?? {};
      // Everyone on both rosters, plus anyone in the box score: the same set for every variant.
      const ids = new Set([
        ...Object.values(snapshot.players)
          .filter((p) => p.team === game.home || p.team === game.away)
          .map((p) => p.playerId),
        ...Object.keys(actual),
      ]);
      for (const id of ids) {
        const info = snapshot.players[id];
        if (!info || info.position === 'QB' || info.position === 'K' || info.position === 'P') {
          continue;
        }
        const s = sums.get(id) ?? { targets: 0, rec: 0, recYds: 0, carries: 0, rushYds: 0 };
        const a = actual[id] ?? { targets: 0, rec: 0, recYds: 0, carries: 0, rushYds: 0 };
        players.push({
          key: `${game.gameId}:${id}`,
          targets: (s.targets - a.targets) ** 2,
          recYds: (s.recYds - a.recYds) ** 2,
          carries: (s.carries - a.carries) ** 2,
          rushYds: (s.rushYds - a.rushYds) ** 2,
        });
      }
    }
  }
  return { games, players };
}

/**
 * Mean of a metric, and (vs the base variant) the paired mean difference with its SE. Rows are
 * paired by key.
 */
function compare<T extends { [k: string]: number | string }>(
  rows: T[],
  base: T[],
  keyField: keyof T,
  field: keyof T,
): { value: number; diff: number; se: number } {
  const baseBy = new Map(base.map((r) => [r[keyField], r[field] as number]));
  const d: number[] = [];
  const v: number[] = [];
  for (const r of rows) {
    const b = baseBy.get(r[keyField]);
    if (b === undefined) continue;
    v.push(r[field] as number);
    d.push((r[field] as number) - b);
  }
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const md = mean(d);
  const sd = Math.sqrt(d.reduce((a, x) => a + (x - md) ** 2, 0) / Math.max(1, d.length - 1));
  return { value: mean(v), diff: md, se: sd / Math.sqrt(d.length) };
}

const t0 = performance.now();
const scored: Record<string, ReturnType<typeof score>> = {};
for (const [name, settings] of Object.entries(VARIANTS)) {
  scored[name] = score(settings);
  console.error(`${name}: done (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
}

const base = scored.none!;
const GAME_FIELDS = [
  'marginVsSpread',
  'marginVsResult',
  'totalVsLine',
  'totalVsResult',
  'logLoss',
] as const;
const PLAYER_FIELDS = ['targets', 'recYds', 'carries', 'rushYds'] as const;
const report: Record<string, Record<string, { value: number; diff: number; se: number }>> = {};
for (const [name, s] of Object.entries(scored)) {
  const row: Record<string, { value: number; diff: number; se: number }> = {};
  for (const f of GAME_FIELDS) row[f] = compare(s.games, base.games, 'gameId', f);
  for (const f of PLAYER_FIELDS) row[f] = compare(s.players, base.players, 'key', f);
  report[name] = row;
}

const fmt = (x: number, d = 3) => x.toFixed(d).padStart(9);
const header = [
  'variant'.padEnd(18),
  ...[...GAME_FIELDS, ...PLAYER_FIELDS].map((f) => f.padStart(16)),
];
console.log(
  `Mean squared error (log loss for logLoss); change vs "none" in brackets (± 1 SE).\n` +
    `${base.games.length} games, ${base.players.length} player-games, ${n} sims each, seed ${seed}\n`,
);
console.log(header.join(''));
for (const [name, row] of Object.entries(report)) {
  const cells = [...GAME_FIELDS, ...PLAYER_FIELDS].map((f) => {
    const m = row[f]!;
    return name === 'none'
      ? fmt(m.value).padStart(16)
      : `${m.diff >= 0 ? '+' : ''}${m.diff.toFixed(3)}±${m.se.toFixed(3)}`.padStart(16);
  });
  console.log([name.padEnd(18), ...cells].join(''));
}
console.log(`\n${((performance.now() - t0) / 1000).toFixed(0)}s`);
if (outPath) {
  writeFileSync(
    outPath,
    `${JSON.stringify({ engineVersion: ENGINE_VERSION, n, seed, games: base.games.length, players: base.players.length, report }, null, 2)}\n`,
  );
}
