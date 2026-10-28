import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_OVERRIDES,
  DEFAULT_SETTINGS,
  ENGINE_VERSION,
  GAME_CONTROLS,
  prepareRun,
  randomSeed,
} from '@rerun/engine';
import type {
  AdjustmentSummary,
  ResolvedConditions,
  RunRequest,
  SimCount,
  SlateSnapshot,
  SnapshotGame,
} from '@rerun/engine';
import { AltLadder, MarginHistogram, TotalHistogram, WinProbability, pct, signed } from './charts';
import type { Counts } from './charts';
import { Icon } from './icons';
import { EdgesCard, MarketCard, marketSpread, marketTotal } from './market';
import { PropsCard } from './props';
import { TeamTotals } from './teamTotals';
import type { Aggregate, WorkerOut } from './sim.worker';

function kickoffLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "Week 8 · Updated Wed 10:29 AM": the newest of the snapshot's data timestamps. */
function dataLine(snapshot: SlateSnapshot): string {
  const times = Object.values(snapshot.dataAsOf)
    .filter((t): t is string => typeof t === 'string')
    .map((t) => Date.parse(t))
    .filter((t) => Number.isFinite(t));
  const newest = times.length ? Math.max(...times) : Date.parse(snapshot.createdAt);
  const when = new Date(newest).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Week ${snapshot.week} · Updated ${when}`;
}

function makeRequest(
  snapshot: SlateSnapshot,
  game: SnapshotGame,
  nSims: SimCount,
  seed: number,
): RunRequest {
  return {
    snapshotId: snapshot.id,
    gameId: game.gameId,
    engineVersion: ENGINE_VERSION,
    settings: DEFAULT_SETTINGS,
    overrides: DEFAULT_OVERRIDES,
    nSims,
    seed,
  };
}

// ---------------------------------------------------------------------------
// Game card
// ---------------------------------------------------------------------------

const PTS_LABELS: Record<Exclude<keyof AdjustmentSummary['pts']['home'], 'total'>, string> = {
  homeField: 'home field',
  altitude: 'altitude',
  rest: 'rest',
  travel: 'travel',
  streaks: 'streaks',
};

function ptsParts(pts: AdjustmentSummary['pts']['home']): string {
  const parts = Object.entries(PTS_LABELS)
    .map(([key, label]) => [pts[key as keyof typeof PTS_LABELS], label] as const)
    .filter(([v]) => Math.abs(v) >= 0.005)
    .map(([v, label]) => `${signed(v)} ${label}`);
  return parts.length ? parts.join(', ') : 'none';
}

function weatherValue(c: ResolvedConditions, hasForecast: boolean): string {
  if (c.indoor) return 'Indoors';
  if (!hasForecast) return 'No forecast yet';
  return `${Math.round(c.tempF)}°F`;
}

function Chip(props: { icon: Parameters<typeof Icon>[0]['name']; children: string }) {
  return (
    <span className="chip warning">
      <Icon name={props.icon} size={14} />
      {props.children}
    </span>
  );
}

function GameCard({ snapshot, game }: { snapshot: SlateSnapshot; game: SnapshotGame }) {
  const inputs = useMemo(
    () => prepareRun(makeRequest(snapshot, game, GAME_CONTROLS.nSims.default, 0), snapshot),
    [snapshot, game],
  );
  const { pts } = inputs.adjustments;
  const c = inputs.conditions;
  const hurt = (team: string) =>
    Object.values(snapshot.players)
      .filter((p) => p.team === team && p.status !== 'active')
      .sort((a, b) => a.status.localeCompare(b.status));
  const hurtAway = hurt(game.away);
  const hurtHome = hurt(game.home);
  const edge = pts.home.total - pts.away.total;
  const chips: { icon: Parameters<typeof Icon>[0]['name']; text: string }[] = [];
  if (!c.indoor && game.weather && c.windMph >= 12) {
    chips.push({ icon: 'wind', text: `Wind ${Math.round(c.windMph)} mph` });
  }
  if (!c.indoor && game.weather && c.precip !== 'none') {
    chips.push({
      icon: 'rain',
      text:
        c.precip.replace('_', ' ').replace(/^./, (s) => s.toUpperCase()) +
        (c.precipChance < 1 ? ` ${Math.round(100 * c.precipChance)}%` : ''),
    });
  }
  if (pts.away.altitude < 0) chips.push({ icon: 'mountain', text: 'Altitude' });
  if (hurtAway.length + hurtHome.length > 0) {
    chips.push({ icon: 'injury', text: `${hurtAway.length + hurtHome.length} injury listed` });
  }

  const teamRow = (team: string, side: 'home' | 'away') => (
    <div className="team-row">
      <div className="team-name">
        <span className="abbr">{team}</span>
        <span>{side === 'home' ? 'Home' : 'Away'}</span>
      </div>
      <span className="num muted">{signed(pts[side].total)} pts</span>
    </div>
  );

  return (
    <article className="card game-card">
      <div className="game-card-top">
        <span className="small muted with-icon">
          <Icon name="clock" />
          {kickoffLabel(game.kickoff)}
        </span>
        <div className="chips">
          {chips.map((ch) => (
            <Chip key={ch.text} icon={ch.icon}>
              {ch.text}
            </Chip>
          ))}
        </div>
      </div>
      <div className="teams">
        {teamRow(game.away, 'away')}
        {teamRow(game.home, 'home')}
      </div>
      <div className="tiles num">
        <div>
          <span className="caption">Weather</span>
          <strong>{weatherValue(c, game.weather !== null)}</strong>
        </div>
        <div>
          <span className="caption">Wind</span>
          <strong>{c.indoor || !game.weather ? '–' : `${Math.round(c.windMph)} mph`}</strong>
        </div>
        <div>
          <span className="caption">Edge</span>
          <strong>
            {Math.abs(edge) < 0.05
              ? 'Even'
              : `${edge > 0 ? game.home : game.away} ${signed(Math.abs(edge))}`}
          </strong>
        </div>
      </div>
      <dl className="details small">
        <dt>{game.away}</dt>
        <dd>{ptsParts(pts.away)}</dd>
        <dt>{game.home}</dt>
        <dd>{ptsParts(pts.home)}</dd>
        <dt>Venue</dt>
        <dd>
          {game.stadium.name} · {game.stadium.roof}
        </dd>
        {[...hurtAway, ...hurtHome].length > 0 && (
          <>
            <dt>Injuries</dt>
            <dd>
              {[...hurtAway, ...hurtHome]
                .map((p) => `${p.name} (${p.team} ${p.position}, ${p.status})`)
                .join(', ')}
            </dd>
          </>
        )}
      </dl>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** The market spread from the sim favorite's side (e.g. −4), if the snapshot has lines. */
function favSpread(game: SnapshotGame, favoriteIsHome: boolean): number | undefined {
  const home = marketSpread(game)?.line;
  if (home === undefined || home === null) return undefined;
  return favoriteIsHome ? home : -home;
}

/** Margins re-expressed from the favorite's side (positive = favorite wins). */
function fromSide(margins: Counts, favoriteIsHome: boolean): Counts {
  if (favoriteIsHome) return margins;
  const out: Counts = {};
  for (const [m, c] of Object.entries(margins)) out[-Number(m)] = c;
  return out;
}

export function App() {
  const [snapshot, setSnapshot] = useState<SlateSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gameId, setGameId] = useState<string>('');
  const [nSims, setNSims] = useState<SimCount>(GAME_CONTROLS.nSims.default);
  const [agg, setAgg] = useState<Aggregate | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // no-store: a new snapshot is published twice a day; always ask for the newest.
        const latest = (await (
          await fetch('/snapshots/latest.json', { cache: 'no-store' })
        ).json()) as { path: string };
        const snap = (await (await fetch(latest.path)).json()) as SlateSnapshot;
        setSnapshot(snap);
        const first = snap.games.find((g) => g.status === 'scheduled') ?? snap.games[0];
        if (first) setGameId(first.gameId);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => workerRef.current?.terminate();
  }, []);

  const game: SnapshotGame | undefined = snapshot?.games.find((g) => g.gameId === gameId);

  function run() {
    if (!snapshot || !game) return;
    workerRef.current?.terminate();
    const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    const s = randomSeed();
    const request = makeRequest(snapshot, game, nSims, s);
    setAgg(null);
    setRunError(null);
    setRunning(true);
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data;
      if (msg.type === 'error') {
        setRunError(msg.message);
        setRunning(false);
        return;
      }
      setAgg({ ...msg.agg });
      if (msg.type === 'done') setRunning(false);
    };
    worker.postMessage({ snapshot, request });
  }

  // Results belong to the game they were run on.
  const shown = agg && game && agg.gameId === game.gameId ? agg : null;

  const summary = useMemo(() => {
    if (!shown || shown.done === 0 || !snapshot || !game) return null;
    const n = shown.done;
    const homeWin = shown.homeWins / n;
    const tie = shown.ties / n;
    const awayWin = 1 - homeWin - tie;
    const favoriteIsHome = homeWin >= awayWin;
    const players = shown.players
      .map((p) => {
        const info = snapshot.players[p.id];
        return {
          ...p,
          name: info?.name ?? p.id,
          team: info?.team ?? '',
          position: info?.position ?? '',
          yds: (p.passYds + p.rushYds + p.recYds) / n,
        };
      })
      .sort((a, b) => b.yds - a.yds)
      .slice(0, 12);
    return {
      n,
      tie,
      home: shown.sumHome / n,
      away: shown.sumAway / n,
      favorite: favoriteIsHome ? game.home : game.away,
      underdog: favoriteIsHome ? game.away : game.home,
      favWin: favoriteIsHome ? homeWin : awayWin,
      dogWin: favoriteIsHome ? awayWin : homeWin,
      margins: fromSide(shown.margins, favoriteIsHome),
      favSpread: favSpread(game, favoriteIsHome),
      marketTotal: marketTotal(game)?.line ?? undefined,
      players,
    };
  }, [shown, snapshot, game]);

  const progress = agg && running ? agg.done / agg.total : 0;

  return (
    <div className="page">
      <header className="site-header">
        <div className="brand">
          <span className="logo-tile">
            <Icon name="logo" size={24} />
          </span>
          <span className="brand-text">
            <span className="wordmark">ReRun</span>
            <span className="caption">Betting Simulator</span>
          </span>
        </div>
        <h1 className="display">Every game, 10,000 times. Your way.</h1>
      </header>

      {loadError && <p className="error">Could not load the slate: {loadError}</p>}
      {!snapshot && !loadError && <p className="muted">Loading the slate…</p>}

      {snapshot && (
        <div className="layout">
          <aside className="controls">
            <section className="card">
              <h3>Run a game</h3>
              <label className="field">
                <span className="caption">Game</span>
                <select value={gameId} onChange={(e) => setGameId(e.target.value)}>
                  {snapshot.games.map((g) => (
                    <option key={g.gameId} value={g.gameId}>
                      {g.away} @ {g.home} · {kickoffLabel(g.kickoff)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="caption">Sims</span>
                <select
                  value={nSims}
                  onChange={(e) => setNSims(Number(e.target.value) as SimCount)}
                >
                  {GAME_CONTROLS.nSims.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn-run num"
                onClick={run}
                disabled={!game}
                aria-busy={running}
              >
                {running && <span className="sweep" style={{ width: `${100 * progress}%` }} />}
                <span className="btn-run-label">
                  {running ? (
                    `Running… ${(agg?.done ?? 0).toLocaleString()} / ${nSims.toLocaleString()}`
                  ) : (
                    <>
                      <Icon name="play" size={20} />
                      Run {nSims.toLocaleString()} sims
                    </>
                  )}
                </span>
              </button>
              <span className="caption muted meta">{dataLine(snapshot)}</span>
            </section>
            {game && <GameCard snapshot={snapshot} game={game} />}
          </aside>

          <main className="results">
            {game && <MarketCard game={game} sims={shown && shown.done > 0 ? shown : null} />}

            {runError && <p className="error">{runError}</p>}

            {!summary && !runError && (
              <section className="card empty">
                <h2>No results yet</h2>
                <p className="muted">
                  Pick a game and run the sims. Each sim plays the whole game play by play; the
                  charts fill in as they finish.
                </p>
              </section>
            )}

            {/* Before a run, props sit at the bottom; after, just above player projections. */}
            {!summary && game && <PropsCard game={game} snapshot={snapshot} />}

            {summary && game && (
              <>
                <section className="card">
                  <div className="card-head">
                    <div className="head-text">
                      <h2>Projected score</h2>
                      <span className="small muted num">
                        Average over {summary.n.toLocaleString()} sims ·{' '}
                        {(summary.home + summary.away).toFixed(1)} total points
                        {summary.tie >= 0.005 && ` · tie ${pct(summary.tie)}`}
                      </span>
                    </div>
                  </div>
                  <div className="score num">
                    {(['away', 'home'] as const).map((side) => (
                      <div key={side} className="score-side">
                        <span
                          className={
                            game[side] === summary.favorite ? 'score-pts copper' : 'score-pts'
                          }
                        >
                          {summary[side].toFixed(1)}
                        </span>
                        <span className="caption">{game[side]}</span>
                      </div>
                    ))}
                  </div>
                </section>

                <WinProbability
                  favorite={summary.favorite}
                  underdog={summary.underdog}
                  favWin={summary.favWin}
                  dogWin={summary.dogWin}
                />

                <EdgesCard game={game} agg={shown!} n={summary.n} />

                <MarginHistogram
                  margins={summary.margins}
                  n={summary.n}
                  favorite={summary.favorite}
                  underdog={summary.underdog}
                  market={summary.favSpread}
                />

                <div className="pair">
                  <TotalHistogram
                    totals={shown!.totals}
                    n={summary.n}
                    market={summary.marketTotal}
                  />
                  <AltLadder
                    margins={summary.margins}
                    n={summary.n}
                    favorite={summary.favorite}
                    market={summary.favSpread}
                  />
                </div>

                <TeamTotals
                  game={game}
                  homePts={shown!.homePts}
                  awayPts={shown!.awayPts}
                  n={summary.n}
                />

                <PropsCard
                  game={game}
                  snapshot={snapshot}
                  sims={{ players: shown!.players, n: shown!.done }}
                />

                <section className="card">
                  <div className="card-head baseline">
                    <h2>Player projections</h2>
                    <span className="caption muted">Average per game</span>
                  </div>
                  <div className="table-wrap">
                    <table className="num">
                      <thead>
                        <tr>
                          <th scope="col">Player</th>
                          <th scope="col">Pass</th>
                          <th scope="col">Rush</th>
                          <th scope="col">Rec</th>
                          <th scope="col">Catches</th>
                          <th scope="col">Any TD</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.players.map((p) => (
                          <tr key={p.id}>
                            <th scope="row">
                              {p.name} <span className="muted">{`${p.team} ${p.position}`}</span>
                            </th>
                            <td>{p.passYds ? (p.passYds / summary.n).toFixed(0) : '–'}</td>
                            <td>{p.rushYds ? (p.rushYds / summary.n).toFixed(0) : '–'}</td>
                            <td>{p.recYds ? (p.recYds / summary.n).toFixed(0) : '–'}</td>
                            <td>{p.rec ? (p.rec / summary.n).toFixed(1) : '–'}</td>
                            <td>{pct(p.anyTd / summary.n)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            )}

            <section className="card note small">
              Early preview with default model settings. Injuries, weather, altitude and rest are in
              the model; weather forecasts and market lines are live. Edges are research from an
              early model, not picks. The full Sim Lab controls are coming.
            </section>
          </main>
        </div>
      )}

      <footer className="site-footer caption">
        ReRun is a simulation tool for entertainment and research. 21+ only. Please gamble
        responsibly — if you or someone you know has a gambling problem, call 1-800-GAMBLER. A GMDHC
        property.
      </footer>
    </div>
  );
}
