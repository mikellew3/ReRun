/**
 * Line movement summary and signals from a game's lineHistory (CLAUDE.md §5, config
 * lineMovement). Information only: nothing here feeds the sim.
 *
 * Conventions: spreads are the home team's line (more negative = money on home), totals the
 * game total (higher = money on the over), h2h moves are changes in the home team's no-vig
 * win probability.
 */

import { MODEL_CONFIG } from '../config/model.config';
import type { LineHistory, LineTick, TrackedMarket } from '../types';

type Cfg = typeof MODEL_CONFIG.lineMovement;

export interface BookLine {
  book: string;
  market: TrackedMarket;
  open: LineTick;
  current: LineTick;
  /** Current minus open: points for spreads/totals, home no-vig probability for h2h. */
  move: number;
  ticks: number;
}

export type Lean = 'home' | 'away' | 'over' | 'under';

export type Signal =
  | {
      kind: 'steam';
      market: 'spreads' | 'totals';
      lean: Lean;
      books: string[];
      /** Points moved, the largest of the books in the window. */
      size: number;
      at: string;
    }
  | { kind: 'keyNumber'; book: string; from: number; to: number; crossed: number[] }
  | {
      kind: 'bookGap';
      market: 'spreads' | 'totals';
      low: { book: string; line: number };
      high: { book: string; line: number };
    }
  | {
      kind: 'sharpGap';
      /** h2h: values are home no-vig win probabilities; totals: lines. */
      market: 'h2h' | 'totals';
      sharp: { book: string; value: number };
      recAvg: number;
      /** The side the sharp book rates higher than the recreational books do. */
      lean: Lean;
    };

export interface LineSummary {
  books: BookLine[];
  signals: Signal[];
}

function implied(american: number): number {
  return american > 0 ? 100 / (american + 100) : -american / (-american + 100);
}

/** Home (or over) no-vig probability of a tick. */
export function noVigA(t: LineTick): number {
  const a = implied(t.a);
  const b = implied(t.b);
  return a / (a + b);
}

const ms = (iso: string) => Date.parse(iso);

function leanOf(market: 'spreads' | 'totals', delta: number): Lean {
  if (market === 'spreads') return delta < 0 ? 'home' : 'away';
  return delta > 0 ? 'over' : 'under';
}

export function bookLines(history: readonly LineHistory[]): BookLine[] {
  return history
    .filter((h) => h.ticks.length > 0)
    .map((h) => {
      const open = h.ticks[0]!;
      const current = h.ticks[h.ticks.length - 1]!;
      const move =
        h.market.startsWith('h2h')
          ? noVigA(current) - noVigA(open)
          : (current.line ?? 0) - (open.line ?? 0);
      return { book: h.book, market: h.market, open, current, move, ticks: h.ticks.length };
    });
}

/** Key numbers a spread move from `from` to `to` passed or landed on (same favorite only). */
export function crossedKeys(from: number, to: number, keys: readonly number[]): number[] {
  if (from === to || Math.sign(from) * Math.sign(to) < 0) return [];
  const a = Math.abs(from);
  const b = Math.abs(to);
  return keys.filter((k) => (a < k && b >= k) || (a > k && b <= k));
}

/** Line of a series at or before time t (null before its first tick). */
function lineAt(ticks: readonly LineTick[], t: number): number | null {
  let line: number | null = null;
  for (const tick of ticks) {
    if (ms(tick.t) > t) break;
    line = tick.line;
  }
  return line;
}

function steam(history: readonly LineHistory[], cfg: Cfg): Signal[] {
  const out: Signal[] = [];
  const window = cfg.steamWindowMinutes * 60_000;
  for (const market of ['spreads', 'totals'] as const) {
    const series = history.filter((h) => h.market === market && h.ticks.length > 1);
    // Every line change is a possible start of a steam window.
    const starts = series.flatMap((h) =>
      h.ticks.slice(1).flatMap((t, i) => (t.line !== h.ticks[i]!.line ? [ms(t.t)] : [])),
    );
    let best: Extract<Signal, { kind: 'steam' }> | null = null;
    for (const start of starts) {
      const end = start + window;
      for (const sign of [-1, 1]) {
        const movers: { book: string; size: number }[] = [];
        for (const h of series) {
          const before = lineAt(h.ticks, start - 1);
          const after = lineAt(h.ticks, end);
          if (before === null || after === null) continue;
          const d = after - before;
          if (Math.sign(d) === sign && Math.abs(d) >= cfg.steamMinMovePts) {
            movers.push({ book: h.book, size: Math.abs(d) });
          }
        }
        if (movers.length >= cfg.steamMinBooks) {
          const size = Math.max(...movers.map((m) => m.size));
          if (!best || size > best.size) {
            best = {
              kind: 'steam',
              market,
              lean: leanOf(market, sign),
              books: movers.map((m) => m.book).sort(),
              size,
              at: new Date(start).toISOString(),
            };
          }
        }
      }
    }
    if (best) out.push(best);
  }
  return out;
}

export function summarizeLines(
  history: readonly LineHistory[] | undefined,
  cfg: Cfg = MODEL_CONFIG.lineMovement,
): LineSummary {
  if (!history || history.length === 0) return { books: [], signals: [] };
  const books = bookLines(history);
  const signals: Signal[] = [...steam(history, cfg)];

  for (const b of books) {
    if (b.market !== 'spreads' || b.open.line === null || b.current.line === null) continue;
    const crossed = crossedKeys(b.open.line, b.current.line, cfg.keyNumbers);
    if (crossed.length > 0) {
      signals.push({
        kind: 'keyNumber',
        book: b.book,
        from: b.open.line,
        to: b.current.line,
        crossed,
      });
    }
  }

  const recBooks: readonly string[] = cfg.recBooks;
  for (const market of ['spreads', 'totals'] as const) {
    const current = books.filter((b) => b.market === market && b.current.line !== null);
    const rec = current.filter((b) => recBooks.includes(b.book));
    if (rec.length >= 2) {
      const sorted = [...rec].sort((x, y) => x.current.line! - y.current.line!);
      const low = sorted[0]!;
      const high = sorted[sorted.length - 1]!;
      if (high.current.line! - low.current.line! >= cfg.bookGapPts) {
        signals.push({
          kind: 'bookGap',
          market,
          low: { book: low.book, line: low.current.line! },
          high: { book: high.book, line: high.current.line! },
        });
      }
    }
    const sharp = current.find((b) => b.book === cfg.sharpBook);
    if (market === 'totals' && sharp && rec.length > 0) {
      const recAvg = rec.reduce((acc, b) => acc + b.current.line!, 0) / rec.length;
      const gap = sharp.current.line! - recAvg;
      if (Math.abs(gap) >= cfg.sharpGapTotalPts) {
        signals.push({
          kind: 'sharpGap',
          market,
          sharp: { book: sharp.book, value: sharp.current.line! },
          recAvg,
          lean: leanOf(market, gap),
        });
      }
    }
  }

  // Sides: compare moneyline no-vig home win probability (no line/price mixing).
  const h2h = books.filter((b) => b.market === 'h2h');
  const sharpMl = h2h.find((b) => b.book === cfg.sharpBook);
  const recMl = h2h.filter((b) => recBooks.includes(b.book));
  if (sharpMl && recMl.length > 0) {
    const recAvg = recMl.reduce((acc, b) => acc + noVigA(b.current), 0) / recMl.length;
    const gap = noVigA(sharpMl.current) - recAvg;
    if (Math.abs(gap) >= cfg.sharpGapWinProb) {
      signals.push({
        kind: 'sharpGap',
        market: 'h2h',
        sharp: { book: sharpMl.book, value: noVigA(sharpMl.current) },
        recAvg,
        lean: gap > 0 ? 'home' : 'away',
      });
    }
  }
  return { books, signals };
}
