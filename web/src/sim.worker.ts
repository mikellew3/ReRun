/// <reference lib="webworker" />
/**
 * Runs the engine off the main thread and streams running aggregates back to the page, so the
 * histograms fill in live while the sims run.
 */

import { prepareRun, runSimsWithInputs } from '@rerun/engine';
import type { RunRequest, SimGameResult, SlateSnapshot } from '@rerun/engine';

export interface PlayerAgg {
  id: string;
  passAtt: number;
  passCmp: number;
  passYds: number;
  passTd: number;
  passInt: number;
  rushAtt: number;
  targets: number;
  rushYds: number;
  recYds: number;
  rec: number;
  anyTd: number; // sims with a rushing or receiving TD
  /** Sims the player sat out (questionable players drawn out): props on him are void there. */
  sitOut: number;
  /** Per stat: value -> sims, for sims where the value was above 0 (zeros are implied). */
  dist: Record<PropStat, Record<number, number>>;
}

/** Stats with a full distribution, for pricing props at any line. */
export const PROP_STATS = [
  'passYds',
  'passAtt',
  'passCmp',
  'passTd',
  'passInt',
  'rushYds',
  'rushAtt',
  'rec',
  'recYds',
] as const;
export type PropStat = (typeof PROP_STATS)[number];

export interface Aggregate {
  gameId: string;
  done: number;
  total: number;
  homeWins: number;
  ties: number;
  sumHome: number;
  sumAway: number;
  /** margin (home - away) -> count */
  margins: Record<number, number>;
  /** total points -> count */
  totals: Record<number, number>;
  /** each team's points -> count */
  homePts: Record<number, number>;
  awayPts: Record<number, number>;
  /** First half: margin (home - away) and total points -> count */
  h1Margins: Record<number, number>;
  h1Totals: Record<number, number>;
  players: PlayerAgg[];
  elapsedMs: number;
}

export type WorkerIn = { snapshot: SlateSnapshot; request: RunRequest };
export type WorkerOut =
  | { type: 'progress'; agg: Aggregate }
  | { type: 'done'; agg: Aggregate }
  | { type: 'error'; message: string };

const post = (msg: WorkerOut) => (self as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = (event: MessageEvent<WorkerIn>) => {
  const { snapshot, request } = event.data;
  const t0 = performance.now();
  const agg: Aggregate = {
    gameId: request.gameId,
    done: 0,
    total: request.nSims,
    homeWins: 0,
    ties: 0,
    sumHome: 0,
    sumAway: 0,
    margins: {},
    totals: {},
    homePts: {},
    awayPts: {},
    h1Margins: {},
    h1Totals: {},
    players: [],
    elapsedMs: 0,
  };
  const players = new Map<string, PlayerAgg>();
  const player = (id: string): PlayerAgg => {
    let p = players.get(id);
    if (!p) {
      p = {
        id,
        passAtt: 0,
        passCmp: 0,
        passYds: 0,
        passTd: 0,
        passInt: 0,
        rushAtt: 0,
        targets: 0,
        rushYds: 0,
        recYds: 0,
        rec: 0,
        anyTd: 0,
        sitOut: 0,
        dist: Object.fromEntries(PROP_STATS.map((k) => [k, {}])) as PlayerAgg['dist'],
      };
      players.set(id, p);
    }
    return p;
  };

  const absorb = (batch: SimGameResult[]) => {
    for (const r of batch) {
      const m = r.final.home - r.final.away;
      const t = r.final.home + r.final.away;
      agg.margins[m] = (agg.margins[m] ?? 0) + 1;
      agg.totals[t] = (agg.totals[t] ?? 0) + 1;
      agg.homePts[r.final.home] = (agg.homePts[r.final.home] ?? 0) + 1;
      agg.awayPts[r.final.away] = (agg.awayPts[r.final.away] ?? 0) + 1;
      const hm = r.firstHalf.home - r.firstHalf.away;
      const ht = r.firstHalf.home + r.firstHalf.away;
      agg.h1Margins[hm] = (agg.h1Margins[hm] ?? 0) + 1;
      agg.h1Totals[ht] = (agg.h1Totals[ht] ?? 0) + 1;
      for (const id of r.sittingOut) player(id).sitOut++;
      if (m > 0) agg.homeWins++;
      if (m === 0) agg.ties++;
      agg.sumHome += r.final.home;
      agg.sumAway += r.final.away;
      for (const l of r.players) {
        const p = player(l.playerId);
        for (const k of PROP_STATS) {
          const v = l[k];
          if (v > 0) p.dist[k][v] = (p.dist[k][v] ?? 0) + 1;
        }
        p.passAtt += l.passAtt;
        p.passCmp += l.passCmp;
        p.passInt += l.passInt;
        p.rushAtt += l.rushAtt;
        p.targets += l.targets;
        p.passYds += l.passYds;
        p.passTd += l.passTd;
        p.rushYds += l.rushYds;
        p.recYds += l.recYds;
        p.rec += l.rec;
        if (l.rushTd + l.recTd > 0) p.anyTd++;
      }
    }
    agg.done += batch.length;
    agg.players = [...players.values()];
    agg.elapsedMs = performance.now() - t0;
  };

  try {
    const inputs = prepareRun(request, snapshot);
    runSimsWithInputs(inputs, {
      progressEvery: 500,
      onProgress: (_done, _total, batch) => {
        absorb(batch);
        post({ type: agg.done >= agg.total ? 'done' : 'progress', agg });
      },
    });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
