import { describe, expect, it } from 'vitest';
import { allocateShares, followShares, normalizedHistory } from '../src/usage';

const sum = (xs: ArrayLike<number>) => Array.from(xs).reduce((a, b) => a + b, 0);

describe('allocateShares', () => {
  it('renormalizes the available players to 1', () => {
    // A 0.3 / B 0.2 / C 0.1 available (a 0.4 player is out): proportional redistribution.
    const s = allocateShares(
      [
        { hist: 0.3, nudge: 0 },
        { hist: 0.2, nudge: 0 },
        { hist: 0.1, nudge: 0 },
      ],
      0,
    );
    expect(sum(s)).toBeCloseTo(1, 12);
    expect(s[0]).toBeCloseTo(0.5, 12);
    expect(s[1]).toBeCloseTo(1 / 3, 12);
  });

  it('blends market and history by the market-blend lens', () => {
    const cands = [
      { hist: 0.6, market: 0.2, nudge: 0 },
      { hist: 0.4, market: 0.8, nudge: 0 },
    ];
    expect(allocateShares(cands, 0)[0]).toBeCloseTo(0.6, 12);
    expect(allocateShares(cands, 1)[0]).toBeCloseTo(0.2, 12);
    expect(allocateShares(cands, 0.5)[0]).toBeCloseTo(0.4, 12);
  });

  it('applies nudges and rescales teammates so the team still adds up', () => {
    const s = allocateShares(
      [
        { hist: 0.5, nudge: 0.1 },
        { hist: 0.3, nudge: 0 },
        { hist: 0.2, nudge: 0 },
      ],
      0,
    );
    expect(s[0]).toBeCloseTo(0.6, 12);
    expect(sum(s)).toBeCloseTo(1, 12);
    expect(s[1]! / s[2]!).toBeCloseTo(1.5, 12); // teammates keep their ratio
  });

  it('clamps nudges at 0 and handles a team with no history', () => {
    const s = allocateShares(
      [
        { hist: 0.1, nudge: -0.5 },
        { hist: 0.9, nudge: 0 },
      ],
      0,
    );
    expect(s[0]).toBe(0);
    expect(s[1]).toBeCloseTo(1, 12);
    const none = allocateShares(
      [
        { hist: 0, nudge: 0 },
        { hist: 0, nudge: 0 },
      ],
      0,
    );
    expect(Array.from(none)).toEqual([0.5, 0.5]);
  });

  it('returns an empty table for no candidates', () => {
    expect(allocateShares([], 0.5).length).toBe(0);
  });
});

describe('followShares', () => {
  it('scales red-zone shares by how much each overall share moved', () => {
    const before = normalizedHistory([0.5, 0.5]);
    const after = Float64Array.from([0.75, 0.25]);
    const rz = followShares([0.4, 0.6], before, after);
    // 0.4 * 1.5 = 0.6 and 0.6 * 0.5 = 0.3, renormalized
    expect(rz[0]).toBeCloseTo(0.6 / 0.9, 12);
    expect(sum(rz)).toBeCloseTo(1, 12);
  });

  it('falls back to overall shares for players with no history', () => {
    const rz = followShares([0, 0], normalizedHistory([0, 0]), Float64Array.from([0.5, 0.5]));
    expect(Array.from(rz)).toEqual([0.5, 0.5]);
  });
});
