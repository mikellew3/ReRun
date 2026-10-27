/**
 * Cuts a snapshot down to a few games (their teams and players), e.g. for test fixtures.
 *
 * Usage: npx tsx jobs/sliceSnapshot.ts <in.json> <out.json> <gameId> [gameId...]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { SlateSnapshot } from '@rerun/engine';

const [input, output, ...gameIds] = process.argv.slice(2);
if (!input || !output || gameIds.length === 0) {
  console.error('Usage: tsx jobs/sliceSnapshot.ts <in.json> <out.json> <gameId> [gameId...]');
  process.exit(1);
}

const snap = JSON.parse(readFileSync(input, 'utf8')) as SlateSnapshot;
const games = snap.games.filter((g) => gameIds.includes(g.gameId));
const missing = gameIds.filter((id) => !games.some((g) => g.gameId === id));
if (missing.length > 0) throw new Error(`Not in snapshot: ${missing.join(', ')}`);

const teams = new Set(games.flatMap((g) => [g.home, g.away]));
const sliced: SlateSnapshot = {
  ...snap,
  games,
  teams: Object.fromEntries(Object.entries(snap.teams).filter(([t]) => teams.has(t))),
  players: Object.fromEntries(Object.entries(snap.players).filter(([, p]) => teams.has(p.team))),
};
writeFileSync(output, JSON.stringify(sliced));
console.log(`Wrote ${output}: ${games.length} games, ${teams.size} teams`);
