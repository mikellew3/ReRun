/**
 * Defense vs position: how a defense treats each receiver bucket (WR1, WR2, WR3, TE, RB)
 * compared with how it defends passes overall, against the league's pattern.
 *
 * The defense's overall level is already in its team rates, so only its positional pattern is
 * used: a defense that is bad against everyone gives no extra boost to any one bucket. Each
 * bucket is shrunk toward league average: (n x observed + k x league) / (n + k). The result is
 * raised to the matchupWeight lens (0 = off, 1 = as fitted, 2 = double).
 */

import { MODEL_CONFIG } from '../config/model.config';
import { DVP_BUCKETS } from '../types';
import type { DefVsPos, DvpBucket } from '../types';

export interface DvpMultiplier {
  /** Multiplies the receiver's historical target share (before normalization). */
  targets: number;
  /** Multiplies his yards per target (applied to yards per completion by the caller). */
  yardsPerTarget: number;
}

const ONE: DvpMultiplier = Object.freeze({ targets: 1, yardsPerTarget: 1 });

export function dvpMultipliers(
  defense: DefVsPos | undefined,
  league: DefVsPos,
  weight: number,
): Record<DvpBucket, DvpMultiplier> {
  const out = {} as Record<DvpBucket, DvpMultiplier>;
  if (!defense || weight === 0) {
    for (const b of DVP_BUCKETS) out[b] = ONE;
    return out;
  }
  const k = MODEL_CONFIG.shrinkage.dvpTargetsK;
  const { minMultiplier, maxMultiplier } = MODEL_CONFIG.matchup;
  const clamp = (x: number) => Math.min(maxMultiplier, Math.max(minMultiplier, x));

  const leagueTpg = DVP_BUCKETS.reduce((a, b) => a + league[b].targetsPerGame, 0);
  const leagueYds = DVP_BUCKETS.reduce(
    (a, b) => a + league[b].targetsPerGame * league[b].yardsPerTarget,
    0,
  );
  const defTpg = DVP_BUCKETS.reduce((a, b) => a + defense[b].targetsPerGame, 0);
  if (defTpg <= 0 || leagueTpg <= 0) {
    for (const b of DVP_BUCKETS) out[b] = ONE;
    return out;
  }

  // Shrunk per-bucket target share and yards per target.
  const shrink = (obs: number, n: number, prior: number) => (n * obs + k * prior) / (n + k);
  const share = {} as Record<DvpBucket, number>;
  const ypt = {} as Record<DvpBucket, number>;
  for (const b of DVP_BUCKETS) {
    const d = defense[b];
    const l = league[b];
    share[b] = shrink(d.targetsPerGame / defTpg, d.n, l.targetsPerGame / leagueTpg);
    ypt[b] = shrink(d.yardsPerTarget, d.n, l.yardsPerTarget);
  }
  const shareTotal = DVP_BUCKETS.reduce((a, b) => a + share[b], 0);
  // The defense's own overall yards per target, weighted by the league's target mix.
  const defYpt = DVP_BUCKETS.reduce((a, b) => a + league[b].targetsPerGame * ypt[b], 0) / leagueTpg;
  const leagueYpt = leagueYds / leagueTpg;

  for (const b of DVP_BUCKETS) {
    const l = league[b];
    const t = share[b] / shareTotal / (l.targetsPerGame / leagueTpg);
    const y = ypt[b] / defYpt / (l.yardsPerTarget / leagueYpt);
    out[b] = { targets: clamp(t) ** weight, yardsPerTarget: clamp(y) ** weight };
  }
  return out;
}
