/**
 * Injuries' effects beyond who plays (who plays is decided in applySettings):
 *
 * - QB swaps: a QB starting in place of the usual starter is judged against backup level, not
 *   league average (config.injuries.backupQb).
 * - Offensive-line and secondary starters out: small efficiency changes per starter.
 * - Usage: an out player's targets/carries mostly stay with his position group, split evenly
 *   (the backups take his snaps), instead of going to everyone in proportion.
 *
 * Values are measured; see docs/adjustments.md.
 */

import { MODEL_CONFIG } from '../config/model.config';
import { logit, tiltForMeanShift } from '../samplers';
import type { QbParams, UnitParams, YardHistogram } from '../types';

export interface QbDeltas {
  completionLogit: number;
  sackLogit: number;
  intLogit: number;
  scrambleLogit: number;
  /** Added to the team's pass yardage tilt. */
  passYdsTilt: number;
}

export const NO_QB_DELTAS: QbDeltas = Object.freeze({
  completionLogit: 0,
  sackLogit: 0,
  intLogit: 0,
  scrambleLogit: 0,
  passYdsTilt: 0,
});

const QB_RATES = [
  ['completionRate', 'completionLogit'],
  ['sackRate', 'sackLogit'],
  ['intRate', 'intLogit'],
  ['scrambleRate', 'scrambleLogit'],
] as const;

/**
 * How the starting QB differs from the team's usual QB (whose play is already in the team's
 * numbers). With `backupPrior` (injury adjustments on), the starter's numbers are re-shrunk
 * toward backup level: the pipeline shrank them toward league average with weight
 * k / (n + k); moving that prior to league + backupQb adds weight x backupQb. A starter with no
 * data plays exactly at backup level. Without `backupPrior`, a starter with no data is treated
 * like the usual QB (the engine's behavior before step 5).
 */
export function qbSwapDeltas(
  starter: QbParams | undefined,
  usual: QbParams | undefined,
  league: UnitParams,
  completionYds: YardHistogram,
  backupPrior: boolean,
): QbDeltas {
  if (!usual) return NO_QB_DELTAS;
  if (!starter && !backupPrior) return NO_QB_DELTAS;
  const b = MODEL_CONFIG.injuries.backupQb;
  const k = MODEL_CONFIG.shrinkage.qbDropbacksK;
  const priorWeight = !backupPrior ? 0 : starter ? k / (starter.dropbacks + k) : 1;
  const out = { ...NO_QB_DELTAS };
  for (const [field, key] of QB_RATES) {
    const own = starter ? logit(starter[field]) : logit(league[field]);
    out[key] = own + priorWeight * b[key] - logit(usual[field]);
  }
  const backupTilt = tiltForMeanShift(completionYds, b.yardsPerCompletion);
  out.passYdsTilt = (starter?.passYdsTilt ?? 0) + priorWeight * backupTilt - usual.passYdsTilt;
  return out;
}

export interface LineEffects {
  /** Offense: added to the sack logit; change in mean yards per carry. */
  sackLogit: number;
  yardsPerCarry: number;
  /** From the opposing secondary's missing starters: added to the completion logit. */
  completionLogit: number;
}

export function lineInjuryEffects(olOut: number, oppSecondaryOut: number): LineEffects {
  const cfg = MODEL_CONFIG.injuries;
  return {
    sackLogit: olOut * cfg.olStarterOut.sackLogit,
    yardsPerCarry: olOut * cfg.olStarterOut.yardsPerCarry,
    completionLogit: oppSecondaryOut * cfg.secondaryStarterOut.completionLogit,
  };
}

export interface ShareHolder {
  position: string;
  share: number;
  available: boolean;
}

/**
 * Hands each unavailable player's share to available teammates: `keep[position]` of it split
 * evenly across available players at his position, the rest across everyone else in proportion
 * to their shares. Returns the shares of the available players, in input order (not
 * normalized; allocateShares normalizes). Total share is preserved.
 */
export function redistributeOutShares(
  players: readonly ShareHolder[],
  keep: Readonly<Record<string, number>>,
): number[] {
  const shares = players.map((p) => (p.available ? p.share : 0));
  for (const out of players) {
    if (out.available || out.share <= 0) continue;
    const same = players.flatMap((p, i) => (p.available && p.position === out.position ? [i] : []));
    const others = players.flatMap((p, i) =>
      p.available && p.position !== out.position ? [i] : [],
    );
    const othersTotal = others.reduce((acc, i) => acc + players[i]!.share, 0);
    let kept = same.length > 0 ? (keep[out.position] ?? 0) : 0;
    if (othersTotal <= 0) kept = same.length > 0 ? 1 : 0;
    for (const i of same) shares[i]! += (out.share * kept) / same.length;
    // othersTotal is 0 exactly when kept is 1 (or no one is left): nothing to hand on.
    if (othersTotal > 0) {
      for (const i of others) {
        shares[i]! += (out.share * (1 - kept) * players[i]!.share) / othersTotal;
      }
    }
  }
  return players.flatMap((p, i) => (p.available ? [shares[i]!] : []));
}
