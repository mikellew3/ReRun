/**
 * Sims one game from a snapshot file and prints a summary. Default settings unless a preset
 * is named. Useful for checking a fresh snapshot end to end.
 *
 * Usage:
 *   npx tsx jobs/simGame.ts <snapshot.json> <gameId|all> [--n 10000] [--seed 1] [--preset sharp]
 */

import { readFileSync } from 'node:fs';
import {
  DEFAULT_OVERRIDES,
  DEFAULT_SETTINGS,
  ENGINE_VERSION,
  getPreset,
  runSims,
} from '@rerun/engine';
import type { RunRequest, SimCount, SimGameResult, SlateSnapshot } from '@rerun/engine';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const [file, gameArg] = process.argv.slice(2);
if (!file || !gameArg) {
  console.error('Usage: tsx jobs/simGame.ts <snapshot.json> <gameId|all> [--n N] [--seed S]');
  process.exit(1);
}
const snapshot = JSON.parse(readFileSync(file, 'utf8')) as SlateSnapshot;
const n = Number(arg('n', '10000')) as SimCount;
const seed = Number(arg('seed', '1'));
const preset = getPreset(arg('preset', 'default'));
if (!preset) throw new Error('Unknown preset');

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

function summarize(gameId: string, results: SimGameResult[], ms: number): void {
  const game = snapshot.games.find((g) => g.gameId === gameId)!;
  const margin = results.map((r) => r.final.home - r.final.away);
  const total = results.map((r) => r.final.home + r.final.away);
  const homeWin = results.filter((r) => r.final.home > r.final.away).length;
  const ties = results.filter((r) => r.final.home === r.final.away).length;
  console.log(`\n${gameId}  (${results.length} sims, ${(ms / 1000).toFixed(2)}s)`);
  console.log(
    `  ${game.away} ${mean(results.map((r) => r.final.away)).toFixed(1)} @ ` +
      `${game.home} ${mean(results.map((r) => r.final.home)).toFixed(1)}   ` +
      `home win ${pct(homeWin / results.length)}  ties ${pct(ties / results.length)}  ` +
      `OT ${pct(results.filter((r) => r.overtime).length / results.length)}`,
  );
  console.log(
    `  margin ${mean(margin).toFixed(2)}  total ${mean(total).toFixed(1)}  ` +
      `plays ${mean(results.map((r) => r.plays)).toFixed(1)}`,
  );
  const keys = [3, 7, 6, 10, 14, 1, 2, 4];
  const abs = margin.map((m) => Math.abs(m));
  console.log(
    '  |margin| = ' +
      keys.map((k) => `${k}: ${pct(abs.filter((m) => m === k).length / abs.length)}`).join('  '),
  );
  const lines = new Map<string, { yds: number[]; att: number; rec: number; td: number }>();
  for (const r of results) {
    for (const p of r.players) {
      const l = lines.get(p.playerId) ?? { yds: [], att: 0, rec: 0, td: 0 };
      l.yds.push(p.passYds + p.rushYds + p.recYds);
      l.att += p.passAtt + p.rushAtt;
      l.rec += p.rec;
      l.td += p.passTd + p.rushTd + p.recTd;
      lines.set(p.playerId, l);
    }
  }
  const top = [...lines.entries()]
    .map(([id, l]) => ({ id, ...l, ydsMean: l.yds.reduce((a, b) => a + b, 0) / results.length }))
    .sort((a, b) => b.ydsMean - a.ydsMean)
    .slice(0, 8);
  for (const t of top) {
    const p = snapshot.players[t.id];
    console.log(
      `    ${(p?.name ?? t.id).padEnd(24)} ${p?.position ?? ''} ${p?.team ?? ''}  ` +
        `yds ${t.ydsMean.toFixed(1)}  att ${(t.att / results.length).toFixed(1)}  ` +
        `rec ${(t.rec / results.length).toFixed(1)}  td ${(t.td / results.length).toFixed(2)}`,
    );
  }
}

const gameIds = gameArg === 'all' ? snapshot.games.map((g) => g.gameId) : [gameArg];
for (const gameId of gameIds) {
  const request: RunRequest = {
    snapshotId: snapshot.id,
    gameId,
    engineVersion: ENGINE_VERSION,
    settings: preset.settings ?? DEFAULT_SETTINGS,
    overrides: DEFAULT_OVERRIDES,
    nSims: n,
    seed,
  };
  const t0 = performance.now();
  const results = runSims(request, snapshot);
  summarize(gameId, results, performance.now() - t0);
}
