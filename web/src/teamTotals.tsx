/**
 * Team totals: each team's simulated points against the books' team-total line. The histogram
 * shows how often the team scores each total (copper = over the market line), the ladder shows
 * how often it clears nearby lines, and the book rows show each book's current line and prices
 * (DraftKings and FanDuel via SharpAPI). Information only, like the other market cards.
 */

import type { MarketLine, SnapshotGame } from '@rerun/engine';
import {
  Bars,
  RefLine,
  Stat,
  at,
  fairAmerican,
  pct,
  quantile,
  shareWhere,
  type Counts,
} from './charts';
import { bookName, odds } from './market';

const FROM = 0;
const TO = 56;
/** Ladder lines either side of the reference line, in points. */
const LADDER_STEPS = [-6, -4, -2, 0, 2, 4, 6];

/** The market's over line for one team's total, if the snapshot has one. */
export function marketTeamTotal(game: SnapshotGame, side: 'home' | 'away'): MarketLine | undefined {
  return game.market.find(
    (m) => m.market === 'team_totals' && m.side === side && m.selection === 'over',
  );
}

/** Each book's latest team-total quote (line, over, under), even where books differ on line. */
function bookQuotes(game: SnapshotGame, side: 'home' | 'away') {
  const market = side === 'home' ? 'team_totals_home' : 'team_totals_away';
  return (game.lineHistory ?? [])
    .filter((h) => h.market === market && h.ticks.length > 0)
    .map((h) => {
      const open = h.ticks[0]!;
      const current = h.ticks[h.ticks.length - 1]!;
      return { book: h.book, open, current };
    })
    .sort((a, b) => bookName(a.book).localeCompare(bookName(b.book)));
}

function TeamTotalCard(props: {
  game: SnapshotGame;
  side: 'home' | 'away';
  counts: Counts;
  n: number;
}) {
  const { game, side, counts, n } = props;
  const team = side === 'home' ? game.home : game.away;
  const market = marketTeamTotal(game, side);
  const quotes = bookQuotes(game, side);
  const median = quantile(counts, n, 0.5);
  const line = market?.line ?? Math.floor(median) + 0.5;
  const avg = Object.entries(counts).reduce((acc, [x, c]) => acc + Number(x) * c, 0) / n;
  const over = shareWhere(counts, n, (x) => x > line);
  const rows = LADDER_STEPS.map((d) => line + d)
    .filter((l) => l > 0)
    .map((l) => ({ line: l, p: shareWhere(counts, n, (x) => x > l) }));

  return (
    <section className="card chart-card">
      <div className="card-head">
        <div className="head-text">
          <h2>{team} points</h2>
          <span className="small muted">
            Avg {avg.toFixed(1)} · half of sims land between {quantile(counts, n, 0.25)} and{' '}
            {quantile(counts, n, 0.75)}
          </span>
        </div>
        <div className="stats-row">
          <Stat value={pct(over)} label={`Sim over ${line}`} copper />
          {market?.noVigProb != null && <Stat value={pct(market.noVigProb)} label="Market over" />}
        </div>
      </div>

      <div className="plot short" role="img" aria-label={`Histogram of ${team} points`}>
        <div className="grid" />
        <Bars
          counts={counts}
          from={FROM}
          to={TO}
          n={n}
          highlight={(x) => x > line}
          label={(x) => `${team} ${x} points`}
        />
        <RefLine
          x={line}
          from={FROM}
          to={TO}
          label={market ? `Market ${line}` : `Middle ${line}`}
        />
      </div>
      <div className="ticks num" aria-hidden="true">
        {[0, 7, 14, 21, 28, 35, 42, 49].map((t) => (
          <span key={t} style={{ left: `${at(t, FROM, TO)}%` }}>
            {t}
          </span>
        ))}
      </div>

      <div className="ladder num">
        {rows.map((r) => (
          <div key={r.line} className={r.line === line ? 'ladder-row fair' : 'ladder-row'}>
            <span className="ladder-label">
              Over {r.line}
              {r.line === line && market && <span className="pill-dark">MKT</span>}
            </span>
            <div className="meter">
              <div className={r.p >= 0.5 ? 'fill on' : 'fill'} style={{ width: `${100 * r.p}%` }} />
            </div>
            <span className="ladder-pct">{pct(r.p)}</span>
            <span className="ladder-fair muted">{fairAmerican(r.p)}</span>
          </div>
        ))}
      </div>

      {quotes.length > 0 && (
        <div className="table-wrap">
          <table className="num">
            <thead>
              <tr>
                <th scope="col">Book</th>
                <th scope="col">Line</th>
                <th scope="col">Over</th>
                <th scope="col">Under</th>
                <th scope="col">Sim over</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((q) => {
                const l = q.current.line;
                const moved = l !== q.open.line;
                return (
                  <tr key={q.book}>
                    <th scope="row">{bookName(q.book)}</th>
                    <td>
                      {l ?? '–'}
                      {moved && q.open.line !== null && (
                        <span className="muted"> (opened {q.open.line})</span>
                      )}
                    </td>
                    <td>{odds(q.current.a)}</td>
                    <td>{odds(q.current.b)}</td>
                    <td>{l === null ? '–' : pct(shareWhere(counts, n, (x) => x > l))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <span className="caption muted">
        Copper bars = sims where {team} scores over {line}. Ladder: how often {team} clears each
        line, with the fair no-vig price.
        {market?.noVigProb != null &&
          ` Market over = the books' no-vig chance (${market.noVigSource === 'pinnacle' ? 'Pinnacle' : 'DK/FD consensus'}).`}
      </span>
    </section>
  );
}

export function TeamTotals(props: {
  game: SnapshotGame;
  homePts: Counts;
  awayPts: Counts;
  n: number;
}) {
  const { game, homePts, awayPts, n } = props;
  return (
    <div className="pair">
      <TeamTotalCard game={game} side="away" counts={awayPts} n={n} />
      <TeamTotalCard game={game} side="home" counts={homePts} n={n} />
    </div>
  );
}
