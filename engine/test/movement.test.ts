import { describe, expect, it } from 'vitest';
import { MODEL_CONFIG } from '../src/config';
import { crossedKeys, noVigA, summarizeLines } from '../src/market/movement';
import type { LineHistory, LineTick } from '../src/types';

const tick = (t: string, line: number | null, a = -110, b = -110): LineTick => ({
  t: `2026-10-28T${t}:00Z`,
  line,
  a,
  b,
});

const series = (book: string, market: LineHistory['market'], ticks: LineTick[]): LineHistory => ({
  book,
  market,
  ticks,
});

describe('line movement', () => {
  it('no-vig probability of a fair line is a coin flip', () => {
    expect(noVigA(tick('10:00', -3))).toBeCloseTo(0.5);
    expect(noVigA(tick('10:00', null, -200, 170))).toBeGreaterThan(0.6);
  });

  it('finds key numbers a spread move crossed', () => {
    expect(crossedKeys(-2.5, -3.5, [3, 7])).toEqual([3]);
    expect(crossedKeys(-2.5, -3, [3, 7])).toEqual([3]);
    expect(crossedKeys(-6.5, -2.5, [3, 7])).toEqual([3]);
    expect(crossedKeys(-1.5, 1.5, [3, 7])).toEqual([]);
    expect(crossedKeys(-3.5, -4.5, [3, 7])).toEqual([]);
  });

  it('summarizes open, current and move per book', () => {
    const { books } = summarizeLines([
      series('draftkings', 'spreads', [tick('10:00', -2.5), tick('12:00', -3.5)]),
      series('draftkings', 'h2h', [tick('10:00', null, -140, 120), tick('12:00', null, -170, 145)]),
    ]);
    const spread = books.find((b) => b.market === 'spreads')!;
    expect(spread.move).toBe(-1);
    expect(books.find((b) => b.market === 'h2h')!.move).toBeGreaterThan(0);
  });

  it('flags steam when two books move the same way inside the window', () => {
    const { signals } = summarizeLines([
      series('draftkings', 'spreads', [tick('10:00', -2.5), tick('12:00', -3.5)]),
      series('fanduel', 'spreads', [tick('10:00', -2.5), tick('12:20', -3)]),
    ]);
    const steam = signals.find((s) => s.kind === 'steam');
    expect(steam).toMatchObject({
      market: 'spreads',
      lean: 'home',
      books: ['draftkings', 'fanduel'],
    });
  });

  it('no steam when moves are hours apart', () => {
    const { signals } = summarizeLines([
      series('draftkings', 'spreads', [tick('08:00', -2.5), tick('09:00', -3.5)]),
      series('fanduel', 'spreads', [tick('08:00', -2.5), tick('15:00', -3.5)]),
    ]);
    expect(signals.some((s) => s.kind === 'steam')).toBe(false);
  });

  it('flags a book gap', () => {
    const { signals } = summarizeLines([
      series('draftkings', 'spreads', [tick('10:00', -3.5)]),
      series('fanduel', 'spreads', [tick('10:00', -3)]),
    ]);
    expect(signals.find((s) => s.kind === 'bookGap')).toMatchObject({
      low: { book: 'draftkings', line: -3.5 },
      high: { book: 'fanduel', line: -3 },
    });
  });

  it('sharp gap on sides uses moneyline win probability, not lines', () => {
    const sharp = MODEL_CONFIG.lineMovement.sharpBook;
    // Pinnacle -4 +101 vs DK -3.5 -120: different lines, same bet. No sharp gap.
    const same = summarizeLines([
      series('draftkings', 'spreads', [tick('10:00', -3.5, -120, 100)]),
      series(sharp, 'spreads', [tick('10:00', -4, 101, -113)]),
      series('draftkings', 'h2h', [tick('10:00', null, -190, 160)]),
      series(sharp, 'h2h', [tick('10:00', null, -185, 165)]),
    ]);
    expect(same.signals.some((s) => s.kind === 'sharpGap')).toBe(false);
    // Pinnacle rates the home team clearly higher on the moneyline.
    const gap = summarizeLines([
      series('draftkings', 'h2h', [tick('10:00', null, -150, 130)]),
      series(sharp, 'h2h', [tick('10:00', null, -185, 165)]),
    ]);
    expect(gap.signals.find((s) => s.kind === 'sharpGap')).toMatchObject({
      market: 'h2h',
      lean: 'home',
    });
  });

  it('sharp gap on totals needs a full point', () => {
    const sharp = MODEL_CONFIG.lineMovement.sharpBook;
    const small = summarizeLines([
      series('draftkings', 'totals', [tick('10:00', 44.5)]),
      series(sharp, 'totals', [tick('10:00', 44)]),
    ]);
    expect(small.signals.some((s) => s.kind === 'sharpGap')).toBe(false);
    const big = summarizeLines([
      series('draftkings', 'totals', [tick('10:00', 44.5)]),
      series(sharp, 'totals', [tick('10:00', 46)]),
    ]);
    expect(big.signals.find((s) => s.kind === 'sharpGap')).toMatchObject({ lean: 'over' });
  });

  it('is empty without history', () => {
    expect(summarizeLines(undefined)).toEqual({ books: [], signals: [] });
  });
});
