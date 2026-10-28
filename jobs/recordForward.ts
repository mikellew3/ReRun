/**
 * Forward test (CLAUDE.md §14: props are forward-tested from launch). For every game in a
 * snapshot that hasn't kicked off, sims it with the default settings and records the sim's
 * chances on each book's current line: game lines (spreads, totals, moneylines, first half,
 * team totals) and player props. pipeline/grade_forward.py grades the last record before each
 * kickoff once games are played.
 *
 * Games are recorded within config forwardTest.recordWithinHours of kickoff; a game's new
 * record replaces its earlier one, so each week's file ends as the last pre-kickoff numbers.
 *
 * Usage: npx tsx jobs/recordForward.ts <snapshot.json> [--dir forward-test]
 * Writes <dir>/<season>-W<week>.jsonl.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_OVERRIDES,
  DEFAULT_SETTINGS,
  ENGINE_VERSION,
  MODEL_CONFIG,
  runSims,
} from '@rerun/engine';
import type { RunRequest, SimCount, SimGameResult, SlateSnapshot } from '@rerun/engine';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const file = process.argv[2];
if (!file) throw new Error('Usage: tsx jobs/recordForward.ts <snapshot.json>');
const snapshot = JSON.parse(readFileSync(file, 'utf8')) as SlateSnapshot;
const dir = arg('dir', 'forward-test');
const cfg = MODEL_CONFIG.forwardTest;
const n = cfg.sims;
const seed = 2026;
const now = new Date();
const out = join(dir, `${snapshot.id.slice(0, 8)}.jsonl`);
mkdirSync(dir, { recursive: true });

/** Win and push share of sims for a test (pushes are refunded). */
function chances(values: number[], win: (x: number) => boolean, push: (x: number) => boolean) {
  let w = 0;
  let p = 0;
  for (const v of values) {
    if (push(v)) p++;
    else if (win(v)) w++;
  }
  return { win: w / values.length, push: p / values.length };
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;

const PROP_STAT = {
  player_pass_yds: 'passYds',
  player_pass_attempts: 'passAtt',
  player_pass_completions: 'passCmp',
  player_pass_tds: 'passTd',
  player_pass_interceptions: 'passInt',
  player_rush_yds: 'rushYds',
  player_rush_attempts: 'rushAtt',
  player_receptions: 'rec',
  player_reception_yds: 'recYds',
} as const;

const rows: string[] = [];
const recorded = new Set<string>();
let lines = 0;
let props = 0;
for (const game of snapshot.games) {
  const until = Date.parse(game.kickoff) - now.getTime();
  if (until <= 0 || until > cfg.recordWithinHours * 3_600_000) continue;
  recorded.add(game.gameId);
  const request: RunRequest = {
    snapshotId: snapshot.id,
    gameId: game.gameId,
    engineVersion: ENGINE_VERSION,
    settings: DEFAULT_SETTINGS,
    overrides: DEFAULT_OVERRIDES,
    nSims: 1000 as SimCount,
    seed,
  };
  const results: SimGameResult[] = [];
  for (let block = 0; block < Math.ceil(n / 1000); block++) {
    results.push(...runSims({ ...request, seed: seed + block * 7919 }, snapshot));
  }
  const margin = results.map((r) => r.final.home - r.final.away);
  const total = results.map((r) => r.final.home + r.final.away);
  const h1Margin = results.map((r) => r.firstHalf.home - r.firstHalf.away);
  const h1Total = results.map((r) => r.firstHalf.home + r.firstHalf.away);
  const homePts = results.map((r) => r.final.home);
  const awayPts = results.map((r) => r.final.away);
  const base = {
    t: now.toISOString(),
    snapshot: snapshot.id,
    engine: ENGINE_VERSION,
    gameId: game.gameId,
    kickoff: game.kickoff,
  };

  // Game lines: each book's latest quote. Side a = home (spreads, moneylines) or over.
  for (const h of game.lineHistory ?? []) {
    const q = h.ticks[h.ticks.length - 1];
    if (!q) continue;
    const m = h.market;
    let c: { a: { win: number; push: number }; b: { win: number; push: number } } | null = null;
    const both = (
      vals: number[],
      winA: (x: number) => boolean,
      winB: (x: number) => boolean,
      push: (x: number) => boolean,
    ) => ({
      a: chances(vals, winA, push),
      b: chances(vals, winB, push),
    });
    const L = q.line;
    if (m.startsWith('h2h')) {
      const vals = m.endsWith('_h1') ? h1Margin : margin;
      c = both(
        vals,
        (x) => x > 0,
        (x) => x < 0,
        (x) => x === 0,
      );
    } else if (L !== null && m.startsWith('spreads')) {
      const vals = m.endsWith('_h1') ? h1Margin : margin;
      c = both(
        vals,
        (x) => x + L > 0,
        (x) => x + L < 0,
        (x) => x + L === 0,
      );
    } else if (L !== null) {
      const vals = m.startsWith('totals')
        ? m.endsWith('_h1')
          ? h1Total
          : total
        : m === 'team_totals_home'
          ? homePts
          : awayPts;
      c = both(
        vals,
        (x) => x > L,
        (x) => x < L,
        (x) => x === L,
      );
    }
    if (!c) continue;
    rows.push(
      JSON.stringify({
        ...base,
        kind: 'line',
        market: m,
        book: h.book,
        line: L,
        priceA: q.a,
        priceB: q.b,
        quotedAt: q.t,
        simA: r4(c.a.win),
        simB: r4(c.b.win),
        push: r4(c.a.push),
      }),
    );
    lines++;
  }

  // Props: sims where the player sits out are void and left out.
  for (const p of game.props ?? []) {
    if (!p.playerId) continue;
    const stat = PROP_STAT[p.market as keyof typeof PROP_STAT];
    const played = results.filter((r) => !r.sittingOut.includes(p.playerId!));
    if (played.length === 0) continue;
    const lineOf = (r: SimGameResult) => r.players.find((l) => l.playerId === p.playerId);
    const vals = played.map((r) => {
      const l = lineOf(r);
      if (!l) return 0;
      if (stat) return l[stat];
      return l.rushTd + l.recTd > 0 ? 1 : 0; // anytime TD
    });
    for (const b of p.books) {
      const q = b.current;
      const L = q.line ?? 0.5; // anytime TD: over 0.5
      const over = chances(
        vals,
        (x) => x > L,
        (x) => x === L,
      );
      const under = chances(
        vals,
        (x) => x < L,
        (x) => x === L,
      );
      rows.push(
        JSON.stringify({
          ...base,
          kind: 'prop',
          market: p.market,
          book: b.book,
          playerId: p.playerId,
          player: p.player,
          line: q.line,
          priceA: q.over,
          priceB: q.under,
          quotedAt: q.t,
          simA: r4(over.win),
          simB: r4(under.win),
          push: r4(over.push),
          playShare: r4(played.length / results.length),
        }),
      );
      props++;
    }
  }
}
// Keep other games' earlier records; replace the ones just re-recorded.
const kept = existsSync(out)
  ? readFileSync(out, 'utf8')
      .split('\n')
      .filter((l) => l && !recorded.has((JSON.parse(l) as { gameId: string }).gameId))
  : [];
if (recorded.size > 0) writeFileSync(out, [...kept, ...rows].join('\n') + '\n');
console.log(
  `${snapshot.id}: ${recorded.size} games, recorded ${lines} game lines and ${props} prop quotes -> ${out}`,
);
