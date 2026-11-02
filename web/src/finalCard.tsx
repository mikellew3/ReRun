/**
 * Games that have kicked off can't be simmed. Once the snapshot has the final score, this card
 * shows it and how the market lines settled (the last lines before kickoff).
 */

import type { SnapshotGame } from '@rerun/engine';
import { signed } from './charts';
import { marketSpread, marketTotal } from './market';
import { marketTeamTotal } from './teamTotals';

/** Kicked off (by the clock, even if the snapshot hasn't caught up) or finished. */
export function isClosed(game: SnapshotGame, now = Date.now()): boolean {
  return game.status !== 'scheduled' || Date.parse(game.kickoff) <= now;
}

function settle(value: number, line: number, win: string, lose: string, push = 'Push'): string {
  return value > line ? win : value < line ? lose : push;
}

export function FinalCard({ game }: { game: SnapshotGame }) {
  const r = game.result;
  if (!r) {
    return (
      <section className="card empty">
        <h2>Game under way</h2>
        <p className="muted">
          Sims close at kickoff. The final score and how the lines settled show here after the game,
          once the next update has the result (usually within a few hours).
        </p>
      </section>
    );
  }
  const margin = r.home - r.away;
  const total = r.home + r.away;
  const winner = margin > 0 ? game.home : margin < 0 ? game.away : null;
  // nflverse closing lines first; else the last lines the snapshot pulled before kickoff.
  const spread = r.closingSpread ?? marketSpread(game)?.line;
  const ou = r.closingTotal ?? marketTotal(game)?.line;
  const rows: { bet: string; result: string }[] = [];
  rows.push({ bet: 'Moneyline', result: winner ? `${winner} won` : 'Tie' });
  if (spread != null) {
    rows.push({
      bet: `${game.home} ${signed(spread)} / ${game.away} ${signed(-spread)}`,
      result: settle(margin + spread, 0, `${game.home} covered`, `${game.away} covered`),
    });
  }
  if (ou != null) {
    rows.push({ bet: `Total ${ou}`, result: settle(total, ou, 'Over', 'Under') });
  }
  for (const side of ['away', 'home'] as const) {
    const tt = marketTeamTotal(game, side)?.line;
    const team = side === 'home' ? game.home : game.away;
    if (tt != null) {
      rows.push({ bet: `${team} total ${tt}`, result: settle(r[side], tt, 'Over', 'Under') });
    }
  }
  return (
    <section className="card">
      <div className="card-head">
        <div className="head-text">
          <h2>Final</h2>
          <span className="small muted">Sims close at kickoff</span>
        </div>
      </div>
      <div className="score num">
        {(['away', 'home'] as const).map((side) => {
          const team = side === 'home' ? game.home : game.away;
          return (
            <div key={side} className="score-side">
              <span className={team === winner ? 'score-pts copper' : 'score-pts'}>{r[side]}</span>
              <span className="caption">{team}</span>
            </div>
          );
        })}
      </div>
      <div className="table-wrap">
        <table className="num">
          <thead>
            <tr>
              <th scope="col">Closing line</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.bet}>
                <th scope="row">{x.bet}</th>
                <td>{x.result}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
