/**
 * Public entry points for running simulations.
 *
 * Sim i always uses RNG stream (seed, i), so a run can be split into chunks (e.g. across Web
 * Workers, or streamed for live histograms) and still give exactly the same results.
 */

import { applySettings } from './applySettings';
import type { GameInputs } from './applySettings';
import type { RunRequest } from './config/settings.schema';
import { simulateGame } from './game';
import type { PlayRecord, SimGameResult, SlateSnapshot } from './types';

export interface RunOptions {
  /** First sim index (default 0). */
  start?: number;
  /** How many sims (default request.nSims - start). */
  count?: number;
  /** Called every `progressEvery` sims with the results so far in this call. */
  onProgress?: (done: number, total: number, latest: SimGameResult[]) => void;
  progressEvery?: number;
}

/** Prepares a run once; reuse the inputs for several chunks. */
export function prepareRun(request: RunRequest, snapshot: SlateSnapshot): GameInputs {
  return applySettings(request, snapshot);
}

export function runSimsWithInputs(inputs: GameInputs, opts: RunOptions = {}): SimGameResult[] {
  const start = opts.start ?? 0;
  const count = opts.count ?? inputs.request.nSims - start;
  const every = opts.progressEvery ?? 500;
  const results: SimGameResult[] = [];
  let batch: SimGameResult[] = [];
  for (let i = start; i < start + count; i++) {
    const { result } = simulateGame(inputs, i);
    results.push(result);
    batch.push(result);
    if (opts.onProgress && (batch.length >= every || i === start + count - 1)) {
      opts.onProgress(results.length, count, batch);
      batch = [];
    }
  }
  return results;
}

/** Runs a request against a snapshot. */
export function runSims(
  request: RunRequest,
  snapshot: SlateSnapshot,
  opts: RunOptions = {},
): SimGameResult[] {
  return runSimsWithInputs(prepareRun(request, snapshot), opts);
}

/** Re-plays one sim with the full play-by-play (for the Replay page). */
export function replayGame(
  request: RunRequest,
  snapshot: SlateSnapshot,
  simIndex: number,
): { result: SimGameResult; plays: PlayRecord[] } {
  const { result, plays } = simulateGame(prepareRun(request, snapshot), simIndex, true);
  return { result, plays: plays ?? [] };
}
