/**
 * Sampling primitives. Everything here is set up once per game (in applySettings) and then
 * sampled in O(1) inside the play loop.
 */

import type { Rng } from './rng';
import type { YardHistogram } from './types';

/** Walker alias table over n outcomes: one uniform draw per sample. */
export class AliasTable {
  private readonly prob: Float64Array;
  private readonly alias: Int32Array;
  readonly size: number;

  constructor(weights: ArrayLike<number>) {
    const n = weights.length;
    if (n === 0) throw new Error('AliasTable needs at least one outcome');
    let total = 0;
    for (let i = 0; i < n; i++) {
      const w = weights[i]!;
      if (!(w >= 0)) throw new Error(`AliasTable weight ${i} is invalid: ${w}`);
      total += w;
    }
    if (total <= 0) throw new Error('AliasTable weights sum to zero');

    this.size = n;
    this.prob = new Float64Array(n);
    this.alias = new Int32Array(n);
    const scaled = new Float64Array(n);
    const small: number[] = [];
    const large: number[] = [];
    for (let i = 0; i < n; i++) {
      scaled[i] = (weights[i]! * n) / total;
      (scaled[i]! < 1 ? small : large).push(i);
    }
    while (small.length > 0 && large.length > 0) {
      const s = small.pop()!;
      const l = large.pop()!;
      this.prob[s] = scaled[s]!;
      this.alias[s] = l;
      scaled[l] = scaled[l]! + scaled[s]! - 1;
      (scaled[l]! < 1 ? small : large).push(l);
    }
    for (const i of large) this.prob[i] = 1;
    for (const i of small) this.prob[i] = 1; // rounding leftovers
  }

  /** Index in [0, size). */
  sample(rng: Rng): number {
    const x = rng.next() * this.size;
    const i = Math.floor(x);
    return x - i < this.prob[i]! ? i : this.alias[i]!;
  }
}

/** Probabilities of a histogram reweighted by exp(tilt * yards), normalized. */
export function tiltedProbs(hist: YardHistogram, tilt: number): Float64Array {
  const n = hist.probs.length;
  const out = new Float64Array(n);
  // Center the exponent for numerical safety; it cancels in the normalization.
  const center = hist.min + (n - 1) / 2;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const w = hist.probs[i]! * Math.exp(tilt * (hist.min + i - center));
    out[i] = w;
    total += w;
  }
  for (let i = 0; i < n; i++) out[i] = out[i]! / total;
  return out;
}

/** Samples integer yards from a (possibly tilted) histogram. */
export class YardSampler {
  private readonly table: AliasTable;
  readonly min: number;
  readonly mean: number;

  constructor(hist: YardHistogram, tilt = 0) {
    const probs = tiltedProbs(hist, tilt);
    this.table = new AliasTable(probs);
    this.min = hist.min;
    let m = 0;
    for (let i = 0; i < probs.length; i++) m += probs[i]! * (hist.min + i);
    this.mean = m;
  }

  sample(rng: Rng): number {
    return this.min + this.table.sample(rng);
  }
}

/** Picks an index from small weight arrays (a handful of players): linear scan. */
export class WeightedPicker {
  private readonly cumulative: Float64Array;

  constructor(weights: ArrayLike<number>) {
    this.cumulative = new Float64Array(weights.length);
    let total = 0;
    for (let i = 0; i < weights.length; i++) {
      total += Math.max(0, weights[i]!);
      this.cumulative[i] = total;
    }
    if (total <= 0) throw new Error('WeightedPicker weights sum to zero');
    for (let i = 0; i < weights.length; i++) this.cumulative[i] = this.cumulative[i]! / total;
  }

  pick(rng: Rng): number {
    const u = rng.next();
    const c = this.cumulative;
    for (let i = 0; i < c.length - 1; i++) if (u < c[i]!) return i;
    return c.length - 1;
  }
}

/** Exponential with the given mean, rounded to whole yards. */
export function sampleExponentialYds(rng: Rng, mean: number): number {
  return Math.round(-mean * Math.log(1 - rng.next()));
}

export function logit(p: number): number {
  const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(q / (1 - q));
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Offense rate vs defense rate, both relative to league, combined additively in logit space. */
export function combineRates(off: number, def: number, league: number, extraLogit = 0): number {
  return sigmoid(logit(off) + logit(def) - logit(league) + extraLogit);
}
