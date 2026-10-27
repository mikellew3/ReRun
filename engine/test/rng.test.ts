import { describe, expect, it } from 'vitest';
import { Rng, createRng, randomSeed } from '../src/rng';

describe('xoshiro128** core', () => {
  it('matches the reference algorithm for state [1, 2, 3, 4]', () => {
    // Hand-computed from the reference C implementation's update rule.
    const rng = new Rng(1, 2, 3, 4);
    expect([rng.nextU32(), rng.nextU32(), rng.nextU32()]).toEqual([11520, 0, 5927040]);
  });

  it('rejects an all-zero state', () => {
    expect(() => new Rng(0, 0, 0, 0)).toThrow();
  });
});

describe('createRng', () => {
  it('is deterministic for the same seed and stream', () => {
    const a = createRng(12345, 7);
    const b = createRng(12345, 7);
    for (let i = 0; i < 1000; i++) expect(a.nextU32()).toBe(b.nextU32());
  });

  it('pins its output (changing this breaks lock verification: bump ENGINE_VERSION)', () => {
    const rng = createRng(20260901, 0);
    const first = Array.from({ length: 5 }, () => rng.nextU32());
    expect(first).toMatchInlineSnapshot(`
      [
        2553191814,
        3727791311,
        1834821774,
        193095730,
        1203958629,
      ]
    `);
  });

  it('gives different sequences for different seeds and different streams', () => {
    const seqs = [createRng(1, 0), createRng(2, 0), createRng(1, 1), createRng(2, 1)].map((r) =>
      Array.from({ length: 4 }, () => r.nextU32()).join(','),
    );
    expect(new Set(seqs).size).toBe(4);
  });

  it('treats seeds as unsigned 32-bit', () => {
    expect(createRng(-1).nextU32()).toBe(createRng(0xffffffff).nextU32());
  });

  it('gives a sim the same stream regardless of which other sims ran first', () => {
    // Simulates splitting a run into chunks: sim 500 alone vs after sims 0..499.
    const alone = createRng(99, 500);
    for (let i = 0; i < 500; i++) createRng(99, i).next();
    const after = createRng(99, 500);
    expect(alone.next()).toBe(after.next());
  });
});

describe('distribution', () => {
  it('next() stays in [0, 1) with mean near 0.5', () => {
    const rng = createRng(42);
    let sum = 0;
    const n = 200_000;
    for (let i = 0; i < n; i++) {
      const x = rng.next();
      expect(x >= 0 && x < 1).toBe(true);
      sum += x;
    }
    expect(Math.abs(sum / n - 0.5)).toBeLessThan(0.005);
  });

  it('int(n) is roughly uniform (chi-square, 20 buckets)', () => {
    const rng = createRng(7);
    const buckets = new Array<number>(20).fill(0);
    const n = 200_000;
    for (let i = 0; i < n; i++) buckets[rng.int(20)]!++;
    const expected = n / 20;
    const chi2 = buckets.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);
    // 19 degrees of freedom; 99.9th percentile is ~43.8.
    expect(chi2).toBeLessThan(43.8);
  });

  it('first draws across many sim streams are uncorrelated with the stream index', () => {
    const n = 10_000;
    let sxy = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      const y = createRng(123, i).next();
      sx += i;
      sy += y;
      sxy += i * y;
      sxx += i * i;
      syy += y * y;
    }
    const r = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    expect(Math.abs(r)).toBeLessThan(0.04);
  });

  it('chance(p) hits at rate p', () => {
    const rng = createRng(3);
    let hits = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) if (rng.chance(0.3)) hits++;
    expect(Math.abs(hits / n - 0.3)).toBeLessThan(0.006);
  });
});

describe('randomSeed', () => {
  it('returns an unsigned 32-bit integer', () => {
    const s = randomSeed();
    expect(Number.isInteger(s) && s >= 0 && s <= 0xffffffff).toBe(true);
  });
});
