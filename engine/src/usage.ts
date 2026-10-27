/**
 * Target and carry allocation.
 *
 * For one team and one kind of usage (targets or carries):
 * 1. Players who are not available are left out; the rest are renormalized, so a missing
 *    player's share goes to teammates in proportion to their own shares.
 * 2. Historical and market-implied shares are blended by the market-blend lens.
 * 3. The user's nudges are applied to the nudged players, and everyone else is rescaled so
 *    the team still adds up to 1.
 *
 * Red-zone and goal-line shares follow the same changes: each player's red-zone share is
 * scaled by how much his overall share moved.
 */

export interface UsageCandidate {
  /** Historical share from the chosen history window (0..1). */
  hist: number;
  /** Market-implied share, if the snapshot has one. */
  market?: number | undefined;
  /** User nudge in share points (+0.03 = +3 pts). 0 = none. */
  nudge: number;
}

function normalize(values: Float64Array): Float64Array {
  let total = 0;
  for (const v of values) total += v;
  if (total <= 0) {
    // Nobody has any history: share equally rather than leave the team with no one.
    return values.fill(values.length > 0 ? 1 / values.length : 0);
  }
  for (let i = 0; i < values.length; i++) values[i] = values[i]! / total;
  return values;
}

/** Final shares for the available candidates, summing to 1 (empty input -> empty output). */
export function allocateShares(candidates: UsageCandidate[], marketBlend: number): Float64Array {
  const n = candidates.length;
  const base = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = candidates[i]!;
    const hist = Math.max(0, c.hist);
    base[i] =
      c.market !== undefined && marketBlend > 0
        ? marketBlend * Math.max(0, c.market) + (1 - marketBlend) * hist
        : hist;
  }
  normalize(base);

  const nudged = candidates.map((c) => c.nudge !== 0);
  if (!nudged.some(Boolean)) return base;

  const out = new Float64Array(n);
  let nudgedTotal = 0;
  let othersBase = 0;
  for (let i = 0; i < n; i++) {
    if (nudged[i]) {
      out[i] = Math.min(1, Math.max(0, base[i]! + candidates[i]!.nudge));
      nudgedTotal += out[i]!;
    } else {
      othersBase += base[i]!;
    }
  }
  if (nudgedTotal >= 1 || othersBase <= 0) return normalize(out);
  const scale = (1 - nudgedTotal) / othersBase;
  for (let i = 0; i < n; i++) if (!nudged[i]) out[i] = base[i]! * scale;
  return out;
}

/**
 * Red-zone (or goal-line) shares that follow the overall changes.
 * sub: historical red-zone shares; before: historical overall shares (normalized over the
 * same candidates); after: final overall shares from allocateShares.
 */
export function followShares(
  sub: ArrayLike<number>,
  before: ArrayLike<number>,
  after: ArrayLike<number>,
): Float64Array {
  const n = after.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = before[i]!;
    out[i] = b > 0 ? Math.max(0, sub[i]!) * (after[i]! / b) : after[i]!;
  }
  let total = 0;
  for (const v of out) total += v;
  return total > 0 ? normalize(out) : Float64Array.from(after);
}

/** Historical shares of the candidates, normalized among them. */
export function normalizedHistory(hist: number[]): Float64Array {
  return normalize(Float64Array.from(hist, (h) => Math.max(0, h)));
}
