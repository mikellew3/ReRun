/**
 * Market cards: current lines and their movement (information only), and the sim's edges
 * against the market's no-vig prices (CLAUDE.md §10.4). Tiers and stakes come from config.
 */

import { useState } from 'react';
import { MODEL_CONFIG, summarizeLines } from '@rerun/engine';
import type { LineHistory, MarketLine, Signal, SnapshotGame, TrackedMarket } from '@rerun/engine';
import { pct, shareWhere, signed } from './charts';
import type { Counts } from './charts';
import { Icon } from './icons';

const BOOK_NAMES: Record<string, string> = {
  pinnacle: 'Pinnacle',
  draftkings: 'DraftKings',
  fanduel: 'FanDuel',
  betmgm: 'BetMGM',
  williamhill_us: 'Caesars',
  espnbet: 'ESPN BET',
  fanatics: 'Fanatics',
  betrivers: 'BetRivers',
  bovada: 'Bovada',
  betonlineag: 'BetOnline',
  lowvig: 'LowVig',
};
export const bookName = (b: string) => BOOK_NAMES[b] ?? b;

/** American odds with a real minus sign. */
export const odds = (a: number) => (a > 0 ? `+${a}` : `−${Math.abs(a)}`);

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** The home spread (book's main line) at the market's reference line, if any. */
export function marketSpread(game: SnapshotGame): MarketLine | undefined {
  return game.market.find((m) => m.market === 'spreads' && m.selection === 'home');
}

export function marketTotal(game: SnapshotGame): MarketLine | undefined {
  return game.market.find((m) => m.market === 'totals' && m.selection === 'over');
}

// ---------------------------------------------------------------------------
// Market & movement
// ---------------------------------------------------------------------------

function signalText(s: Signal, game: SnapshotGame): string {
  const side = (lean: string) =>
    lean === 'home' ? game.home : lean === 'away' ? game.away : lean === 'over' ? 'Over' : 'Under';
  switch (s.kind) {
    case 'steam':
      return `Steam toward ${side(s.lean)}: ${s.books.map(bookName).join(' + ')} moved ${s.size} in an hour`;
    case 'keyNumber':
      return `${bookName(s.book)} crossed ${s.crossed.join(' and ')}: ${game.home} ${signed(s.from)} → ${signed(s.to)}`;
    case 'bookGap':
      return s.market === 'spreads'
        ? `Book gap: ${game.home} ${signed(s.low.line)} at ${bookName(s.low.book)}, ${signed(s.high.line)} at ${bookName(s.high.book)}`
        : `Book gap: total ${s.low.line} at ${bookName(s.low.book)}, ${s.high.line} at ${bookName(s.high.book)}`;
    case 'sharpGap':
      return s.market === 'h2h'
        ? `${bookName(s.sharp.book)} gives ${side(s.lean)} a better win chance (${game.home} ${pct(s.sharp.value)} vs ${pct(s.recAvg)} at DK/FD): sharp side ${side(s.lean)}`
        : `${bookName(s.sharp.book)} total ${s.sharp.value} vs ${s.recAvg.toFixed(1)} at DK/FD: sharp side ${side(s.lean)}`;
  }
}

/** Spread over time, one stepped line per book; the sharp book in copper. */
function MovementChart({ history, home }: { history: LineHistory[]; home: string }) {
  // Only the books tracked every 30 minutes (and the sharp book); the others are pulled a few
  // times a day and would just add flat lines.
  const tracked: readonly string[] = [
    MODEL_CONFIG.lineMovement.sharpBook,
    ...MODEL_CONFIG.lineMovement.recBooks,
  ];
  const series = history.filter(
    (h) => h.market === 'spreads' && h.ticks.length > 0 && tracked.includes(h.book),
  );
  if (series.length === 0) return null;
  const sharp = MODEL_CONFIG.lineMovement.sharpBook;
  const all = series.flatMap((h) => h.ticks);
  const t0 = Math.min(...all.map((t) => Date.parse(t.t)));
  const t1 = Math.max(Date.now(), ...all.map((t) => Date.parse(t.t)));
  const lines = all.map((t) => t.line ?? 0);
  const lo = Math.floor(Math.min(...lines) * 2) / 2 - 0.5;
  const hi = Math.ceil(Math.max(...lines) * 2) / 2 + 0.5;
  const W = 600;
  const H = 160;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => ((v - lo) / Math.max(0.5, hi - lo)) * H;
  const order = (b: string) => (b === sharp ? 1 : 0);
  return (
    <div className="movement">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${home} spread over time by sportsbook`}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} className="mv-grid" />
        ))}
        {[...series]
          .sort((a, b) => order(a.book) - order(b.book))
          .map((h) => {
            let d = '';
            h.ticks.forEach((t, i) => {
              const px = x(Date.parse(t.t));
              const py = y(t.line ?? 0);
              d += i === 0 ? `M${px},${py}` : `H${px}V${py}`;
            });
            d += `H${W}`;
            return (
              <path
                key={h.book}
                d={d}
                className={`mv-line ${h.book === sharp ? 'sharp' : h.book}`}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
      </svg>
      <div className="mv-axis caption num">
        <span>{timeLabel(new Date(t0).toISOString())}</span>
        <span>
          {home} {signed(lo + 0.5)} to {signed(hi - 0.5)}
        </span>
        <span>now</span>
      </div>
      <div className="legend caption">
        {series.map((h) => (
          <span key={h.book}>
            <i className={`mv-swatch ${h.book === sharp ? 'sharp' : h.book}`} />
            {bookName(h.book)}
          </span>
        ))}
      </div>
    </div>
  );
}

type ViewId = 'full' | 'h1' | 'tt';

function views(
  game: SnapshotGame,
): Record<ViewId, { label: string; cols: { market: TrackedMarket; head: string }[] }> {
  return {
    full: {
      label: 'Full game',
      cols: [
        { market: 'spreads', head: `${game.home} spread` },
        { market: 'totals', head: 'Total' },
        { market: 'h2h', head: `ML ${game.home} / ${game.away}` },
      ],
    },
    h1: {
      label: '1st half',
      cols: [
        { market: 'spreads_h1', head: `${game.home} spread` },
        { market: 'totals_h1', head: 'Total' },
        { market: 'h2h_h1', head: `ML ${game.home} / ${game.away}` },
      ],
    },
    tt: {
      label: 'Team totals',
      cols: [
        { market: 'team_totals_home', head: `${game.home} total` },
        { market: 'team_totals_away', head: `${game.away} total` },
      ],
    },
  };
}

const BOOK_ORDER = [MODEL_CONFIG.lineMovement.sharpBook, 'draftkings', 'fanduel'];

function bookSort(a: string, b: string): number {
  const ia = BOOK_ORDER.indexOf(a);
  const ib = BOOK_ORDER.indexOf(b);
  if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  return bookName(a).localeCompare(bookName(b));
}

export function MarketCard({ game }: { game: SnapshotGame }) {
  const [view, setView] = useState<ViewId>('full');
  const history = game.lineHistory ?? [];
  if (history.length === 0) {
    return (
      <section className="card">
        <h2>Market</h2>
        <p className="small muted">
          No market lines in this snapshot yet. Lines are pulled every 30 minutes and published with
          the next snapshot.
        </p>
      </section>
    );
  }
  const { books, signals } = summarizeLines(history);
  const all = views(game);
  const available = (Object.keys(all) as ViewId[]).filter((v) =>
    all[v].cols.some((c) => books.some((b) => b.market === c.market)),
  );
  const shown = available.includes(view) ? view : 'full';
  const cols = all[shown].cols;
  const bookIds = [
    ...new Set(books.filter((b) => cols.some((c) => c.market === b.market)).map((b) => b.book)),
  ].sort(bookSort);

  const cell = (book: string, market: TrackedMarket) => {
    const b = books.find((x) => x.book === book && x.market === market);
    if (!b) return <td key={market}>–</td>;
    if (market.startsWith('h2h')) {
      return (
        <td key={market}>
          {odds(b.current.a)} / {odds(b.current.b)}
        </td>
      );
    }
    const spread = market.startsWith('spreads');
    const fmt = (v: number | null) => (spread ? signed(v ?? 0) : String(v));
    const moved = b.current.line !== b.open.line;
    return (
      <td key={market}>
        <strong>{fmt(b.current.line)}</strong>{' '}
        <span className="muted">
          {spread ? odds(b.current.a) : `o ${odds(b.current.a)}`}
          {moved && ` · open ${fmt(b.open.line)}`}
        </span>
      </td>
    );
  };
  return (
    <section className="card">
      <div className="card-head baseline">
        <h2>Market</h2>
        <span className="caption muted">Information only, not used by the model</span>
      </div>
      {available.length > 1 && (
        <div className="segmented" role="tablist" aria-label="Market view">
          {available.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={v === shown}
              className={v === shown ? 'on' : ''}
              onClick={() => setView(v)}
            >
              {all[v].label}
            </button>
          ))}
        </div>
      )}
      <div className="table-wrap">
        <table className="num market-table">
          <thead>
            <tr>
              <th scope="col">Book</th>
              {cols.map((c) => (
                <th key={c.market} scope="col">
                  {c.head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bookIds.map((book) => (
              <tr key={book}>
                <th scope="row">{bookName(book)}</th>
                {cols.map((c) => cell(book, c.market))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {signals.length > 0 && (
        <ul className="signals">
          {signals.map((s, i) => (
            <li key={i} className="chip signal">
              <Icon name="trendUp" size={14} />
              {signalText(s, game)}
            </li>
          ))}
        </ul>
      )}
      <MovementChart history={history} home={game.home} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

interface EdgeRow {
  label: string;
  price: number;
  book: string;
  sim: number;
  market: number;
  edge: number;
  ev: number;
  stake: number;
  tier: string | null;
}

const decimal = (a: number) => 1 + (a > 0 ? a / 100 : 100 / -a);

function edgeRow(label: string, m: MarketLine, sim: number): EdgeRow | null {
  if (m.noVigProb === null) return null;
  const cfg = MODEL_CONFIG.markets;
  const d = decimal(m.best.price);
  const edge = sim - m.noVigProb;
  const ev = sim * d - 1;
  const kelly = ev > 0 ? (ev / (d - 1)) * cfg.kellyFraction : 0;
  const tiers = [...cfg.edgeTiers].reverse();
  return {
    label,
    price: m.best.price,
    book: m.best.book,
    sim,
    market: m.noVigProb,
    edge,
    ev,
    stake: Math.min(cfg.maxStakeFraction, kelly),
    tier: tiers.find((t) => edge >= t.minEdge)?.id ?? null,
  };
}

/**
 * Sim probability of each side at the market's line. Pushes are refunded, so they are taken
 * out: P(win | no push).
 */
export function edges(game: SnapshotGame, margins: Counts, totals: Counts, n: number): EdgeRow[] {
  const rows: EdgeRow[] = [];
  const noPush = (win: number, push: number) => win / Math.max(1e-9, 1 - push);
  for (const m of game.market) {
    if (m.market === 'spreads' && m.line !== null) {
      // m.line is this side's spread; home margin = home - away.
      const sign = m.selection === 'home' ? 1 : -1;
      const line = m.line;
      const win = shareWhere(margins, n, (x) => sign * x + line > 0);
      const push = shareWhere(margins, n, (x) => sign * x + line === 0);
      const team = m.selection === 'home' ? game.home : game.away;
      const r = edgeRow(`${team} ${signed(line)}`, m, noPush(win, push));
      if (r) rows.push(r);
    } else if (m.market === 'totals' && m.line !== null) {
      const line = m.line;
      const over = m.selection === 'over';
      const win = shareWhere(totals, n, (t) => (over ? t > line : t < line));
      const push = shareWhere(totals, n, (t) => t === line);
      const r = edgeRow(`${over ? 'Over' : 'Under'} ${line}`, m, noPush(win, push));
      if (r) rows.push(r);
    } else if (m.market === 'h2h') {
      const home = m.selection === 'home';
      const win = shareWhere(margins, n, (x) => (home ? x > 0 : x < 0));
      const tie = shareWhere(margins, n, (x) => x === 0);
      const r = edgeRow(`${home ? game.home : game.away} ML`, m, noPush(win, tie));
      if (r) rows.push(r);
    }
  }
  return rows.sort((a, b) => b.edge - a.edge);
}

export function EdgesCard(props: {
  game: SnapshotGame;
  margins: Counts;
  totals: Counts;
  n: number;
}) {
  if (!MODEL_CONFIG.markets.showEdges) return null;
  const rows = edges(props.game, props.margins, props.totals, props.n);
  if (rows.length === 0) return null;
  const source = props.game.market[0]?.noVigSource;
  return (
    <section className="card">
      <div className="card-head baseline">
        <h2>Edges vs the market</h2>
        <span className="caption muted">
          No-vig from {source === 'pinnacle' ? 'Pinnacle' : 'the DK/FD consensus'}
        </span>
      </div>
      <div className="table-wrap">
        <table className="num">
          <thead>
            <tr>
              <th scope="col">Bet</th>
              <th scope="col">Best price</th>
              <th scope="col">Sim</th>
              <th scope="col">Market</th>
              <th scope="col">Edge</th>
              <th scope="col">Stake</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <th scope="row">
                  {r.label}{' '}
                  {r.tier && (
                    <span className={`tier ${r.tier}`}>
                      {r.tier[0]!.toUpperCase() + r.tier.slice(1)}
                    </span>
                  )}
                </th>
                <td>
                  {odds(r.price)} <span className="muted">{bookName(r.book)}</span>
                </td>
                <td>{pct(r.sim)}</td>
                <td className="muted">{pct(r.market)}</td>
                <td>
                  <span className={r.edge >= 0 ? 'edge pos' : 'edge neg'}>
                    {signed(100 * r.edge)}%
                  </span>
                </td>
                <td>{r.stake > 0 ? `${(100 * r.stake).toFixed(1)}%` : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span className="caption muted">
        Edge = sim probability minus the market&apos;s no-vig probability (pushes refunded). Stake =
        quarter Kelly at the best price, capped at {100 * MODEL_CONFIG.markets.maxStakeFraction}% of
        bankroll. An early-preview model: treat these as research, not picks.
      </span>
    </section>
  );
}
