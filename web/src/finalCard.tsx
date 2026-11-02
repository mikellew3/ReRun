/**
 * Games that have kicked off can't be simmed. Instead this card shows the sim's final pregame
 * projection (the forward test's last run before kickoff, attached to the snapshot as
 * game.projection) next to the final score, and the sim's call on each closing line against how
 * it settled.
 */

import type { GameProjection, SnapshotGame } from '@rerun/engine';
import { pct, signed } from './charts';
import { marketSpread, marketTotal } from './market';
import { marketTeamTotal } from './teamTotals';

/** Kicked off (by the clock, even if the snapshot hasn't caught up) or finished. */
export function isClosed(game: SnapshotGame, now = Date.now()): boolean {
  return game.status !== 'scheduled' || Date.parse(game.kickoff) <= now;
}

type Dist = Record<number, number>;

/** Share of sims where `win` holds, given no push (pushes are refunded). */
function chance(dist: Dist, win: (x: number) => boolean, push: (x: number) => boolean) {
  let n = 0;
  let w = 0;
  let p = 0;
  for (const [x, c] of Object.entries(dist)) {
    n += c;
    if (push(Number(x))) p += c;
    else if (win(Number(x))) w += c;
  }
  return n - p > 0 ? w / (n - p) : null;
}

interface Row {
  bet: string;
  /** The side the sim favored, with its chance; null when there's no projection. */
  call: { side: string; p: number } | null;
  result: string;
  /** Did the sim's side win? null = push or no call. */
  hit: boolean | null;
}

/** One two-way line: side A wins when toValue(x) > 0 (the line is already in toValue). */
function line(
  bet: string,
  dist: Dist | undefined,
  toValue: (x: number) => number,
  actual: number,
  sides: [string, string],
  results: [string, string],
): Row {
  const pA =
    dist && Object.keys(dist).length > 0
      ? chance(
          dist,
          (x) => toValue(x) > 0,
          (x) => toValue(x) === 0,
        )
      : null;
  const call =
    pA === null ? null : pA >= 0.5 ? { side: sides[0], p: pA } : { side: sides[1], p: 1 - pA };
  const v = toValue(actual);
  const result = v > 0 ? results[0] : v < 0 ? results[1] : 'Push';
  const hit = call === null || v === 0 ? null : v > 0 === (call.side === sides[0]);
  return { bet, call, result, hit };
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function rows(game: SnapshotGame, proj: GameProjection | undefined): Row[] {
  const r = game.result!;
  const margin = r.home - r.away;
  const total = r.home + r.away;
  const out: Row[] = [
    line(
      'Moneyline',
      proj?.margins,
      (m) => m,
      margin,
      [game.home, game.away],
      [`${game.home} won`, `${game.away} won`],
    ),
  ];
  // nflverse closing lines first; else the last lines the snapshot pulled before kickoff.
  const spread = r.closingSpread ?? marketSpread(game)?.line;
  if (spread != null) {
    out.push(
      line(
        `${game.home} ${signed(spread)}`,
        proj?.margins,
        (m) => m + spread,
        margin,
        [`${game.home} ${signed(spread)}`, `${game.away} ${signed(-spread)}`],
        [`${game.home} covered`, `${game.away} covered`],
      ),
    );
  }
  const ou = r.closingTotal ?? marketTotal(game)?.line;
  if (ou != null) {
    out.push(
      line(
        `Total ${ou}`,
        proj?.totals,
        (t) => t - ou,
        total,
        [`Over ${ou}`, `Under ${ou}`],
        ['Over', 'Under'],
      ),
    );
  }
  for (const side of ['away', 'home'] as const) {
    const tt = marketTeamTotal(game, side)?.line;
    const team = side === 'home' ? game.home : game.away;
    if (tt == null) continue;
    out.push(
      line(
        `${team} total ${tt}`,
        side === 'home' ? proj?.homeDist : proj?.awayDist,
        (x) => x - tt,
        r[side],
        [`${team} over`, `${team} under`],
        ['Over', 'Under'],
      ),
    );
  }
  return out;
}

function ScoreBlock({ game, proj }: { game: SnapshotGame; proj?: GameProjection }) {
  const r = game.result;
  const winner = r ? (r.home > r.away ? game.home : r.away > r.home ? game.away : null) : null;
  return (
    <div className="score num">
      {(['away', 'home'] as const).map((side) => {
        const team = side === 'home' ? game.home : game.away;
        const projected = proj ? (side === 'home' ? proj.homePts : proj.awayPts) : null;
        return (
          <div key={side} className="score-side">
            {r ? (
              <span className={team === winner ? 'score-pts copper' : 'score-pts'}>{r[side]}</span>
            ) : (
              <span className="score-pts">{projected?.toFixed(1)}</span>
            )}
            <span className="caption">
              {team}
              {r && projected !== null && (
                <span className="muted"> · sim projected {projected.toFixed(1)}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function FinalCard({ game }: { game: SnapshotGame }) {
  const proj = game.projection;
  const projNote = proj
    ? `Sim's final projection: ${proj.sims.toLocaleString()} sims run ${when(proj.t)}, before kickoff`
    : 'No pregame projection was recorded for this game';
  if (!game.result) {
    return (
      <section className="card">
        <div className="card-head">
          <div className="head-text">
            <h2>Game under way</h2>
            <span className="small muted">
              Sims close at kickoff. The final score shows here after the next update (usually
              within a few hours).
            </span>
          </div>
        </div>
        {proj && (
          <>
            <ScoreBlock game={game} proj={proj} />
            <span className="caption muted">{projNote}</span>
          </>
        )}
      </section>
    );
  }
  const list = rows(game, proj);
  const called = list.filter((x) => x.hit !== null);
  return (
    <section className="card">
      <div className="card-head">
        <div className="head-text">
          <h2>Final</h2>
          <span className="small muted">{projNote}</span>
        </div>
        {called.length > 0 && (
          <div className="stats-row">
            <div className="stat">
              <span className="stat-value num">
                {called.filter((x) => x.hit).length}/{called.length}
              </span>
              <span className="caption">Sim&apos;s calls right</span>
            </div>
          </div>
        )}
      </div>
      <ScoreBlock game={game} proj={proj} />
      <div className="table-wrap">
        <table className="num">
          <thead>
            <tr>
              <th scope="col">Closing line</th>
              <th scope="col">Sim&apos;s call</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.bet}>
                <th scope="row">{x.bet}</th>
                <td>{x.call ? `${x.call.side} · ${pct(x.call.p)}` : '–'}</td>
                <td>
                  {x.result}{' '}
                  {x.hit !== null && (
                    <span className={x.hit ? 'call hit' : 'call miss'}>
                      {x.hit ? 'Right' : 'Wrong'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span className="caption muted">
        Sim&apos;s call = the side the sim gave better than even odds at the closing line, before
        kickoff. The 2022–25 backtest found these calls don&apos;t beat the closing line over time,
        so judge them over many games, not one.
      </span>
    </section>
  );
}
