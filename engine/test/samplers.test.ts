import { describe, expect, it } from 'vitest';
import { createRng } from '../src/rng';
import {
  AliasTable,
  WeightedPicker,
  YardSampler,
  combineRates,
  sampleExponentialYds,
} from '../src/samplers';

describe('AliasTable', () => {
  it('samples in proportion to the weights', () => {
    const weights = [1, 2, 3, 4];
    const table = new AliasTable(weights);
    const rng = createRng(5);
    const counts = [0, 0, 0, 0];
    const n = 200_000;
    for (let i = 0; i < n; i++) counts[table.sample(rng)]!++;
    counts.forEach((c, i) => expect(c / n).toBeCloseTo(weights[i]! / 10, 2));
  });

  it('rejects bad weights', () => {
    expect(() => new AliasTable([])).toThrow();
    expect(() => new AliasTable([0, 0])).toThrow();
    expect(() => new AliasTable([1, -1])).toThrow();
  });
});

describe('YardSampler', () => {
  const hist = { min: -2, probs: [0.1, 0.2, 0.3, 0.2, 0.1, 0.05, 0.05] };

  it('reproduces the histogram mean with no tilt', () => {
    const s = new YardSampler(hist);
    const expected = hist.probs.reduce((a, p, i) => a + p * (hist.min + i), 0);
    expect(s.mean).toBeCloseTo(expected, 12);
    const rng = createRng(9);
    let total = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) total += s.sample(rng);
    expect(total / n).toBeCloseTo(expected, 1);
  });

  it('a positive tilt raises the mean, a negative one lowers it', () => {
    const base = new YardSampler(hist).mean;
    expect(new YardSampler(hist, 0.2).mean).toBeGreaterThan(base);
    expect(new YardSampler(hist, -0.2).mean).toBeLessThan(base);
  });
});

describe('WeightedPicker', () => {
  it('picks in proportion to the weights', () => {
    const p = new WeightedPicker([0.2, 0.8]);
    const rng = createRng(1);
    let ones = 0;
    for (let i = 0; i < 50_000; i++) ones += p.pick(rng);
    expect(ones / 50_000).toBeCloseTo(0.8, 2);
  });
});

describe('combineRates', () => {
  it('league offense vs league defense gives the league rate', () => {
    expect(combineRates(0.06, 0.06, 0.06)).toBeCloseTo(0.06, 12);
  });

  it('a good offense against an average defense keeps its own rate', () => {
    expect(combineRates(0.7, 0.64, 0.64)).toBeCloseTo(0.7, 12);
  });

  it('effects stack', () => {
    expect(combineRates(0.7, 0.7, 0.64)).toBeGreaterThan(0.7);
  });
});

describe('sampleExponentialYds', () => {
  it('has roughly the right mean', () => {
    const rng = createRng(2);
    let t = 0;
    for (let i = 0; i < 50_000; i++) t += sampleExponentialYds(rng, 10);
    expect(t / 50_000).toBeCloseTo(10, 0);
  });
});
