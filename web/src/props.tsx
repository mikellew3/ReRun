/**
 * Player props from the snapshot (DraftKings and FanDuel via SharpAPI): line and prices at each
 * book, the market's no-vig chance of the over, and the sim's average once a run finishes.
 * Information only: prop edges stay hidden with the other edges (config markets.showEdges).
 */

import { useState } from 'react';
import type { MarketKey, PropLine, PropQuote, SlateSnapshot, SnapshotGame } from '@rerun/engine';
import { pct } from './charts';
import { bookName, odds } from './market';
import type { PlayerAgg } from './sim.worker';

type Group = 'all' | 'passing' | 'rushing' | 'receiving' | 'tds';

const MARKETS: Partial<
  Record<MarketKey, { label: string; group: Group; sim: (p: PlayerAgg) => number; rate?: true }>
> = {
  player_pass_yds: { label: 'Pass yds', group: 'passing', sim: (p) => p.passYds },
  player_pass_attempts: { label: 'Pass att', group: 'passing', sim: (p) => p.passAtt },
  player_pass_completions: { label: 'Completions', group: 'passing', sim: (p) => p.passCmp },
  player_pass_tds: { label: 'Pass TDs', group: 'passing', sim: (p) => p.passTd },
  player_pass_interceptions: { label: 'INTs', group: 'passing', sim: (p) => p.passInt },
  player_rush_yds: { label: 'Rush yds', group: 'rushing', sim: (p) => p.rushYds },
  player_rush_attempts: { label: 'Carries', group: 'rushing', sim: (p) => p.rushAtt },
  player_receptions: { label: 'Receptions', group: 'receiving', sim: (p) => p.rec },
  player_reception_yds: { label: 'Rec yds', group: 'receiving', sim: (p) => p.recYds },
  player_anytime_td: { label: 'Anytime TD', group: 'tds', sim: (p) => p.anyTd, rate: true },
};

const GROUPS: { id: Group; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'passing', label: 'Passing' },
  { id: 'rushing', label: 'Rushing' },
  { id: 'receiving', label: 'Receiving' },
  { id: 'tds', label: 'TDs' },
];

function implied(a: number): number {
  return a > 0 ? 100 / (a + 100) : -a / (-a + 100);
}

/** Market chance of the over: no-vig when both sides are priced, else the raw implied price. */
function marketOver(q: PropQuote): number {
  if (q.under === null) return implied(q.over);
  const o = implied(q.over);
  const u = implied(q.under);
  return o / (o + u);
}

function quoteText(q: PropQuote, showLine: boolean): string {
  const prices = q.under === null ? odds(q.over) : `${odds(q.over)} / ${odds(q.under)}`;
  return showLine && q.line !== null ? `${q.line}: ${prices}` : prices;
}

export function PropsCard(props: {
  game: SnapshotGame;
  snapshot: SlateSnapshot;
  /** Per-player sums from the current run, if any, and the sim count. */
  sims?: { players: PlayerAgg[]; n: number };
}) {
  const { game, snapshot, sims } = props;
  const [group, setGroup] = useState<Group>('all');
  const lines = (game.props ?? []).filter((p) => MARKETS[p.market]);
  if (lines.length === 0) return null;

  const simBy = new Map((sims?.players ?? []).map((p) => [p.id, p]));
  const teamOf = (p: PropLine) => (p.playerId ? snapshot.players[p.playerId]?.team : undefined);
  const books = [...new Set(lines.flatMap((p) => p.books.map((b) => b.book)))].sort();
  const shown = lines
    .filter((p) => group === 'all' || MARKETS[p.market]!.group === group)
    .sort((a, b) => {
      const order = Object.keys(MARKETS);
      return (
        (teamOf(a) ?? '').localeCompare(teamOf(b) ?? '') ||
        a.player.localeCompare(b.player) ||
        order.indexOf(a.market) - order.indexOf(b.market)
      );
    });

  return (
    <section className="card">
      <div className="card-head baseline">
        <h2>Player props</h2>
        <span className="caption muted">{books.map(bookName).join(' and ')} · main lines</span>
      </div>
      <div className="segmented" role="tablist" aria-label="Prop type">
        {GROUPS.filter(
          (g) => g.id === 'all' || lines.some((p) => MARKETS[p.market]!.group === g.id),
        ).map((g) => (
          <button
            key={g.id}
            type="button"
            role="tab"
            aria-selected={g.id === group}
            className={g.id === group ? 'on' : ''}
            onClick={() => setGroup(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>
      <div className="table-wrap props-table">
        <table className="num">
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Prop</th>
              <th scope="col">Line</th>
              {books.map((b) => (
                <th key={b} scope="col">
                  {bookName(b)}
                </th>
              ))}
              <th scope="col">Market over</th>
              <th scope="col">Sim avg</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const m = MARKETS[p.market]!;
              const ref = p.books[0]!.current;
              const sameLine = p.books.every((b) => b.current.line === ref.line);
              const over =
                p.books.reduce((acc, b) => acc + marketOver(b.current), 0) / p.books.length;
              const sim = p.playerId ? simBy.get(p.playerId) : undefined;
              const moved = p.books.some((b) => b.current.line !== b.open.line);
              return (
                <tr key={`${p.market}|${p.player}`}>
                  <th scope="row">
                    {p.player} <span className="muted">{teamOf(p) ?? ''}</span>
                  </th>
                  <td className="prop-name">{m.label}</td>
                  <td>
                    {ref.line === null ? 'Yes' : ref.line}
                    {moved && <span className="muted"> ·moved</span>}
                  </td>
                  {books.map((b) => {
                    const q = p.books.find((x) => x.book === b)?.current;
                    return <td key={b}>{q ? quoteText(q, !sameLine) : '–'}</td>;
                  })}
                  <td>{pct(over)}</td>
                  <td>
                    {sim && sims
                      ? m.rate
                        ? pct(m.sim(sim) / sims.n)
                        : (m.sim(sim) / sims.n).toFixed(m.sim(sim) / sims.n < 10 ? 1 : 0)
                      : '–'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <span className="caption muted">
        Market over = the books&apos; no-vig chance of the over (anytime TD: the implied price). Sim
        avg fills in after you run the game. The sim&apos;s QB volume runs high and its stat ranges
        are too narrow (see the prop check), so prop edges are not shown yet.
      </span>
    </section>
  );
}
