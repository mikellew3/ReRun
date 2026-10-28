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
}

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
    players: [],
    elapsedMs: 0,
  };
  const players = new Map<string, PlayerAgg>();

  const absorb = (batch: SimGameResult[]) => {
    for (const r of batch) {
      const m = r.final.home - r.final.away;
      const t = r.final.home + r.final.away;
      agg.margins[m] = (agg.margins[m] ?? 0) + 1;
      agg.totals[t] = (agg.totals[t] ?? 0) + 1;
      if (m > 0) agg.homeWins++;
      if (m === 0) agg.ties++;
      agg.sumHome += r.final.home;
      agg.sumAway += r.final.away;
      for (const l of r.players) {
        let p = players.get(l.playerId);
        if (!p) {
          p = {
            id: l.playerId,
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
          };
          players.set(l.playerId, p);
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
