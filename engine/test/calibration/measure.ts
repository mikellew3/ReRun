/**
 * Calibration measurement, shared by calibration.test.ts and jobs/calibrate.ts.
 *
 * Sims every game in the committed calibration set (walk-forward snapshots for 2023-2025 weeks
 * 4/8/12/16) with default settings and compares league-level results with real-NFL targets
 * (pipeline/calibration_targets.py) and with the closing lines for those games.
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { DEFAULT_OVERRIDES, DEFAULT_SETTINGS } from '../../src/config';
import { replayGame, runSims } from '../../src/sim';
import type { PlayerGameLine, SimGameResult, SlateSnapshot } from '../../src/types';
import { ENGINE_VERSION } from '../../src/version';

interface Summary {
  mean: number;
  sd: number;
}

export interface Targets {
  game: {
    absMarginShare: Record<string, number>;
    total: Summary;
    homeMargin: Summary;
    overtimeRate: number;
    tieRate: number;
    teamPoints: Summary;
  };
  plays: {
    playsPerGame: Summary;
    yardsPerPlay: number;
    attemptShare: number;
    completionRate: number;
    turnoversPerTeamGame: number;
    teamYards: Summary;
  };
  starters: {
    qb: Record<'passAtt' | 'passYds' | 'passTd', Summary>;
    rb1: Record<'rushAtt' | 'rushYds', Summary>;
    topTarget: Record<'targets' | 'rec' | 'recYds', Summary>;
  };
  events: {
    touchdownsPerGame: number;
    fieldGoalAttemptsPerGame: number;
    fieldGoalRate: number;
    puntsPerGame: number;
    twoPointTriesPerGame: number;
    fourthDownGoRate: number;
    thirdDownDistance: number;
  };
  calibrationGames: {
    gameId: string;
    spreadLine: number;
    totalLine: number;
    result: number;
    total: number;
  }[];
}

export interface Metric {
  group: string;
  name: string;
  sim: number;
  target: number;
  /** Allowed absolute difference. */
  tolerance: number;
  pass: boolean;
}

const dir = new URL('../fixtures/calibration/', import.meta.url);

export function loadCalibrationSet(): { targets: Targets; snapshots: SlateSnapshot[] } {
  const targets = JSON.parse(readFileSync(new URL('targets.json', dir), 'utf8')) as Targets;
  const ids = JSON.parse(readFileSync(new URL('snapshots.json', dir), 'utf8')) as string[];
  const snapshots = ids.map(
    (id) =>
      JSON.parse(
        gunzipSync(readFileSync(new URL(`${id}.json.gz`, dir))).toString('utf8'),
      ) as SlateSnapshot,
  );
  return { targets, snapshots };
}

export interface GameSims {
  gameId: string;
  snapshot: SlateSnapshot;
  results: SimGameResult[];
}

export function simulateCalibrationSet(
  snapshots: SlateSnapshot[],
  targets: Targets,
  simsPerGame: number,
  seed = 2026,
): GameSims[] {
  const wanted = new Set(targets.calibrationGames.map((g) => g.gameId));
  const out: GameSims[] = [];
  for (const snapshot of snapshots) {
    for (const game of snapshot.games) {
      if (!wanted.has(game.gameId)) continue;
      const results = runSims(
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
        { count: simsPerGame },
      );
      out.push({ gameId: game.gameId, snapshot, results });
    }
  }
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

function slope(x: number[], y: number[]): number {
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i]! - mx) * (y[i]! - my);
    den += (x[i]! - mx) ** 2;
  }
  return num / den;
}

function corr(x: number[], y: number[]): number {
  return (slope(x, y) * sd(x)) / sd(y);
}

/** Starter lines per team-game, defined as in calibration_targets.py. */
function starters(lines: PlayerGameLine[]) {
  const qb = lines.reduce((best, p) => (p.passAtt > (best?.passAtt ?? 0) ? p : best), lines[0]);
  const rbs = lines.filter((p) => p !== qb);
  const rb1 = rbs.reduce((best, p) => (p.rushAtt > (best?.rushAtt ?? -1) ? p : best), rbs[0]);
  const top = lines.reduce(
    (best, p) =>
      p.targets > best.targets || (p.targets === best.targets && p.recYds > best.recYds) ? p : best,
    lines[0]!,
  );
  return { qb, rb1, top };
}

export function measure(sims: GameSims[], targets: Targets): Metric[] {
  const all = sims.flatMap((g) => g.results);
  const metrics: Metric[] = [];
  const add = (group: string, name: string, sim: number, target: number, tolerance: number) =>
    metrics.push({
      group,
      name,
      sim,
      target,
      tolerance,
      pass: Math.abs(sim - target) <= tolerance,
    });

  // --- Scores
  const margin = all.map((r) => r.final.home - r.final.away);
  const abs = margin.map(Math.abs);
  const total = all.map((r) => r.final.home + r.final.away);
  const g = targets.game;
  add('scores', 'total points: mean', mean(total), g.total.mean, 1.5);
  add('scores', 'total points: sd', sd(total), g.total.sd, 1.5);
  add('scores', 'home margin: mean', mean(margin), g.homeMargin.mean, 1.0);
  add('scores', 'margin: sd', sd(margin), g.homeMargin.sd, 1.5);
  add(
    'scores',
    'overtime rate',
    all.filter((r) => r.overtime).length / all.length,
    g.overtimeRate,
    0.02,
  );
  add(
    'scores',
    'tie rate',
    all.filter((r) => r.final.home === r.final.away).length / all.length,
    g.tieRate,
    0.005,
  );
  const share = (k: number) => abs.filter((m) => m === k).length / abs.length;
  const keyTolerance: Record<number, number> = {
    3: 0.025,
    7: 0.02,
    6: 0.015,
    10: 0.015,
    14: 0.015,
  };
  for (const k of [3, 7, 6, 10, 14]) {
    add('key numbers', `|margin| = ${k}`, share(k), g.absMarginShare[String(k)]!, keyTolerance[k]!);
  }
  for (const k of [1, 2, 4]) {
    add('key numbers', `|margin| = ${k}`, share(k), g.absMarginShare[String(k)]!, 0.015);
  }

  // --- Plays
  const p = targets.plays;
  const teamGames = all.flatMap((r) => [r.team.home, r.team.away]);
  const passAtt = teamGames.reduce((a, t) => a + t.passAtt, 0);
  const rushAtt = teamGames.reduce((a, t) => a + t.rushAtt, 0);
  const yards = teamGames.reduce((a, t) => a + t.yards, 0);
  const plays = all.reduce((a, r) => a + r.plays, 0);
  const lines = all.flatMap((r) => r.players);
  const cmp = lines.reduce((a, l) => a + l.passCmp, 0);
  const att = lines.reduce((a, l) => a + l.passAtt, 0);
  add('plays', 'plays per game', plays / all.length, p.playsPerGame.mean, 3);
  add('plays', 'yards per play', yards / plays, p.yardsPerPlay, 0.15);
  add('plays', 'pass attempt share', passAtt / (passAtt + rushAtt), p.attemptShare, 0.02);
  add('plays', 'completion rate', cmp / att, p.completionRate, 0.015);
  add(
    'plays',
    'turnovers per team-game',
    mean(teamGames.map((t) => t.turnovers)),
    p.turnoversPerTeamGame,
    0.15,
  );
  add('plays', 'team yards: sd', sd(teamGames.map((t) => t.yards)), p.teamYards.sd, 10);

  // --- Starters (per team-game)
  const qb: PlayerGameLine[] = [];
  const rb1: PlayerGameLine[] = [];
  const top: PlayerGameLine[] = [];
  for (const gs of sims) {
    const players = gs.snapshot.players;
    const game = gs.snapshot.games.find((x) => x.gameId === gs.gameId)!;
    for (const r of gs.results) {
      for (const team of [game.home, game.away]) {
        const teamLines = r.players.filter((l) => players[l.playerId]?.team === team);
        if (teamLines.length === 0) continue;
        const s = starters(teamLines);
        if (s.qb) qb.push(s.qb);
        if (s.rb1) rb1.push(s.rb1);
        top.push(s.top);
      }
    }
  }
  const st = targets.starters;
  const starterMetric = (label: string, xs: number[], t: Summary) => {
    add('starters', `${label}: mean`, mean(xs), t.mean, Math.max(0.07 * t.mean, 0.1));
    add('starters', `${label}: sd`, sd(xs), t.sd, 0.15 * t.sd);
  };
  starterMetric(
    'QB pass attempts',
    qb.map((l) => l.passAtt),
    st.qb.passAtt,
  );
  starterMetric(
    'QB pass yards',
    qb.map((l) => l.passYds),
    st.qb.passYds,
  );
  starterMetric(
    'QB pass TDs',
    qb.map((l) => l.passTd),
    st.qb.passTd,
  );
  starterMetric(
    'RB1 carries',
    rb1.map((l) => l.rushAtt),
    st.rb1.rushAtt,
  );
  starterMetric(
    'RB1 rush yards',
    rb1.map((l) => l.rushYds),
    st.rb1.rushYds,
  );
  starterMetric(
    'top target: targets',
    top.map((l) => l.targets),
    st.topTarget.targets,
  );
  starterMetric(
    'top target: receptions',
    top.map((l) => l.rec),
    st.topTarget.rec,
  );
  starterMetric(
    'top target: rec yards',
    top.map((l) => l.recYds),
    st.topTarget.recYds,
  );

  // --- Against the closing line (sim mean per game vs market)
  const byId = new Map(targets.calibrationGames.map((x) => [x.gameId, x]));
  const simMargin: number[] = [];
  const simTotal: number[] = [];
  const spread: number[] = [];
  const totalLine: number[] = [];
  for (const gs of sims) {
    const t = byId.get(gs.gameId)!;
    simMargin.push(mean(gs.results.map((r) => r.final.home - r.final.away)));
    simTotal.push(mean(gs.results.map((r) => r.final.home + r.final.away)));
    spread.push(t.spreadLine);
    totalLine.push(t.totalLine);
  }
  add('market', 'sim margin vs spread: slope', slope(spread, simMargin), 1, 0.15);
  add(
    'market',
    'sim margin vs spread: correlation >= 0.8',
    Math.min(corr(spread, simMargin), 0.8),
    0.8,
    0,
  );
  add(
    'market',
    'sim total - total line: mean',
    mean(simTotal.map((x, i) => x - totalLine[i]!)),
    0,
    1.5,
  );
  add('market', 'sim margin - spread: mean', mean(simMargin.map((x, i) => x - spread[i]!)), 0, 1.0);
  return metrics;
}

/**
 * Event rates from replayed games (play-by-play), `replaysPerGame` per calibration game.
 * Uses the same seed as the main run, so these are the same games.
 */
export function measureEvents(
  sims: GameSims[],
  targets: Targets,
  replaysPerGame: number,
  seed = 2026,
): Metric[] {
  let games = 0;
  let tds = 0;
  let fga = 0;
  let fgm = 0;
  let punts = 0;
  let twoPt = 0;
  let fourth = 0;
  let fourthGo = 0;
  let thirdDist = 0;
  let thirdN = 0;
  const snapKinds = new Set(['pass', 'interception', 'sack', 'scramble', 'run']);
  for (const gs of sims) {
    for (let i = 0; i < replaysPerGame; i++) {
      const { plays } = replayGame(
        {
          snapshotId: gs.snapshot.id,
          gameId: gs.gameId,
          engineVersion: ENGINE_VERSION,
          settings: DEFAULT_SETTINGS,
          overrides: DEFAULT_OVERRIDES,
          nSims: 1000,
          seed,
        },
        gs.snapshot,
        i,
      );
      games++;
      for (const { before, outcome: o } of plays) {
        if ((o.kind === 'pass' || o.kind === 'run' || o.kind === 'scramble') && o.td) tds++;
        if (o.kind === 'interception' && o.defensiveTd) tds++;
        if ((o.kind === 'kickoff' || o.kind === 'punt') && o.returnTd) tds++;
        if (o.kind === 'fieldGoal') {
          fga++;
          if (o.made) fgm++;
        }
        if (o.kind === 'punt') punts++;
        if (o.kind === 'pat' && o.type === 'twoPoint') twoPt++;
        if (
          before.down === 4 &&
          (snapKinds.has(o.kind) || o.kind === 'punt' || o.kind === 'fieldGoal')
        ) {
          fourth++;
          if (snapKinds.has(o.kind)) fourthGo++;
        }
        if (before.down === 3 && snapKinds.has(o.kind)) {
          thirdDist += before.distance;
          thirdN++;
        }
      }
    }
  }
  const e = targets.events;
  const rows: Metric[] = [];
  const add = (name: string, sim: number, target: number, tolerance: number) =>
    rows.push({
      group: 'events',
      name,
      sim,
      target,
      tolerance,
      pass: Math.abs(sim - target) <= tolerance,
    });
  add('touchdowns per game', tds / games, e.touchdownsPerGame, 0.3);
  add('field goal attempts per game', fga / games, e.fieldGoalAttemptsPerGame, 0.35);
  add('field goal rate', fgm / fga, e.fieldGoalRate, 0.03);
  add('punts per game', punts / games, e.puntsPerGame, 0.6);
  add('two-point tries per game', twoPt / games, e.twoPointTriesPerGame, 0.15);
  add('4th-down go rate', fourthGo / fourth, e.fourthDownGoRate, 0.04);
  add('3rd-down distance', thirdDist / thirdN, e.thirdDownDistance, 0.5);
  return rows;
}

export function formatReport(metrics: Metric[]): string {
  const rows = metrics.map(
    (m) =>
      `${m.pass ? ' ok ' : 'FAIL'}  ${m.group.padEnd(12)} ${m.name.padEnd(42)} ` +
      `sim ${m.sim.toFixed(3).padStart(9)}  target ${m.target.toFixed(3).padStart(9)}  ` +
      `±${m.tolerance}`,
  );
  const failed = metrics.filter((m) => !m.pass).length;
  return `${rows.join('\n')}\n${metrics.length - failed}/${metrics.length} pass`;
}
