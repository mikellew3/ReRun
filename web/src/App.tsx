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
import type { Aggregate, WorkerOut } from './sim.worker';

const KEY_NUMBERS = new Set([3, 6, 7, 10, 14]);

function kickoffLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

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

const PTS_LABELS: Record<Exclude<keyof AdjustmentSummary['pts']['home'], 'total'>, string> = {
  homeField: 'home field',
  altitude: 'altitude',
  rest: 'rest',
  travel: 'travel',
  streaks: 'streaks',
};

function ptsLine(pts: AdjustmentSummary['pts']['home']): string {
  const parts = Object.entries(PTS_LABELS)
    .map(([key, label]) => [pts[key as keyof typeof PTS_LABELS], label] as const)
    .filter(([v]) => Math.abs(v) >= 0.005)
    .map(([v, label]) => `${v > 0 ? '+' : ''}${v.toFixed(1)} ${label}`);
  return parts.length ? parts.join(', ') : 'none';
}

function conditionsLine(c: ResolvedConditions, hasForecast: boolean): string {
  if (c.indoor) return 'Indoors: no weather effect';
  if (!hasForecast) return 'No forecast in this snapshot yet';
  const precip = c.precip === 'none' ? 'dry' : c.precip.replace('_', ' ');
  return `${Math.round(c.windMph)} mph wind, ${Math.round(c.tempF)}°F, ${precip}`;
}

function injuryLine(snapshot: SlateSnapshot, team: string): string {
  const hurt = Object.values(snapshot.players).filter(
    (p) => p.team === team && p.status !== 'active',
  );
  if (hurt.length === 0) return 'no skill players listed';
  return hurt
    .sort((a, b) => a.status.localeCompare(b.status))
    .map((p) => `${p.name} (${p.position}, ${p.status})`)
    .join(', ');
}

function GameFactors({ snapshot, game }: { snapshot: SlateSnapshot; game: SnapshotGame }) {
  const inputs = useMemo(
    () => prepareRun(makeRequest(snapshot, game, GAME_CONTROLS.nSims.default, 0), snapshot),
    [snapshot, game],
  );
  const { pts } = inputs.adjustments;
  return (
    <section className="panel">
      <h2>Game factors</h2>
      <dl className="factors">
        <dt>{game.away} points</dt>
        <dd>{ptsLine(pts.away)}</dd>
        <dt>{game.home} points</dt>
        <dd>{ptsLine(pts.home)}</dd>
        <dt>Weather</dt>
        <dd>{conditionsLine(inputs.conditions, game.weather !== null)}</dd>
        <dt>{game.away} injuries</dt>
        <dd>{injuryLine(snapshot, game.away)}</dd>
        <dt>{game.home} injuries</dt>
        <dd>{injuryLine(snapshot, game.home)}</dd>
      </dl>
      <p className="muted small">
        Points are each side&apos;s edge from home field, altitude, rest and travel. Injured
        players&apos; usage goes mostly to teammates at the same position; backup QBs play at backup
        level.
      </p>
    </section>
  );
}

/** Share of sims where the value satisfies `test`. */
function shareWhere(counts: Record<number, number>, n: number, test: (x: number) => boolean) {
  let k = 0;
  for (const [x, c] of Object.entries(counts)) if (test(Number(x))) k += c;
  return k / Math.max(1, n);
}

/** Value at quantile q of a count table. */
function quantile(counts: Record<number, number>, n: number, q: number): number {
  const xs = Object.keys(counts)
    .map(Number)
    .sort((a, b) => a - b);
  let seen = 0;
  for (const x of xs) {
    seen += counts[x]!;
    if (seen >= q * n) return x;
  }
  return xs[xs.length - 1] ?? 0;
}

function Histogram(props: {
  counts: Record<number, number>;
  from: number;
  to: number;
  n: number;
  highlight?: (x: number) => boolean;
  label: (x: number) => string;
  ticks: number[];
  /** Vertical reference lines (e.g. 0 margin, median total). */
  markers?: number[];
}) {
  const { counts, from, to, n, highlight, label, ticks, markers = [] } = props;
  const xs = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const max = Math.max(1, ...xs.map((x) => counts[x] ?? 0));
  const w = 100 / xs.length;
  const center = (x: number) => (x - from + 0.5) * w;
  return (
    <div className="hist">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img">
        {xs.map((x, i) => {
          const h = (38 * (counts[x] ?? 0)) / max;
          return (
            <rect
              key={x}
              x={i * w + w * 0.1}
              y={40 - h}
              width={w * 0.8}
              height={h}
              className={highlight?.(x) ? 'bar key' : 'bar'}
            >
              <title>{`${label(x)}: ${pct((counts[x] ?? 0) / Math.max(1, n))}`}</title>
            </rect>
          );
        })}
        {markers.map((m) => (
          <line
            key={m}
            x1={center(m)}
            x2={center(m)}
            y1={0}
            y2={40}
            className="marker"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="ticks">
        {ticks.map((t) => (
          <span key={t} style={{ left: `${center(t)}%` }}>
            {label(t)}
          </span>
        ))}
      </div>
    </div>
  );
}

function MarginChart(props: {
  counts: Record<number, number>;
  n: number;
  home: string;
  away: string;
}) {
  const { counts, n, home, away } = props;
  const buckets = [
    { label: `${away} by 8+`, p: shareWhere(counts, n, (m) => m <= -8) },
    { label: `${away} by 1–7`, p: shareWhere(counts, n, (m) => m < 0 && m > -8) },
    { label: 'Tie', p: shareWhere(counts, n, (m) => m === 0) },
    { label: `${home} by 1–7`, p: shareWhere(counts, n, (m) => m > 0 && m < 8) },
    { label: `${home} by 8+`, p: shareWhere(counts, n, (m) => m >= 8) },
  ].filter((b) => b.label !== 'Tie' || b.p >= 0.005);
  return (
    <>
      <div className="sides">
        <span>← {away} wins</span>
        <span>{home} wins →</span>
      </div>
      <Histogram
        counts={counts}
        from={-35}
        to={35}
        n={n}
        highlight={(x) => KEY_NUMBERS.has(Math.abs(x))}
        label={(x) => (x === 0 ? 'Even' : String(Math.abs(x)))}
        ticks={[-28, -21, -14, -7, 0, 7, 14, 21, 28]}
        markers={[0]}
      />
      <div className="buckets num">
        {buckets.map((b) => (
          <div key={b.label}>
            <strong>{pct(b.p)}</strong>
            <span>{b.label}</span>
          </div>
        ))}
      </div>
      <p className="muted small">
        Each bar is one final margin; taller means more likely. Orange bars are 3, 6, 7, 10 and 14
        points, the margins football games end on most often.
      </p>
    </>
  );
}

function TotalChart(props: { counts: Record<number, number>; n: number }) {
  const { counts, n } = props;
  const median = quantile(counts, n, 0.5);
  const low = quantile(counts, n, 0.25);
  const high = quantile(counts, n, 0.75);
  const mid = Math.floor(median) + 0.5;
  const lines = [mid - 7, mid, mid + 7];
  return (
    <>
      <Histogram
        counts={counts}
        from={10}
        to={80}
        n={n}
        label={String}
        ticks={[20, 30, 40, 50, 60, 70]}
        markers={[median]}
      />
      <div className="buckets num">
        {lines.map((l) => (
          <div key={l}>
            <strong>{pct(shareWhere(counts, n, (t) => t > l))}</strong>
            <span>Over {l}</span>
          </div>
        ))}
      </div>
      <p className="muted small">
        Combined points for both teams. The line marks the middle game ({median} points); half of
        games land between {low} and {high}.
      </p>
    </>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<SlateSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gameId, setGameId] = useState<string>('');
  const [nSims, setNSims] = useState<SimCount>(GAME_CONTROLS.nSims.default);
  const [agg, setAgg] = useState<Aggregate | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [seed, setSeed] = useState<number | null>(null);
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
    setSeed(s);
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

  const summary = useMemo(() => {
    if (!agg || agg.done === 0 || !snapshot) return null;
    const n = agg.done;
    const margins = Object.entries(agg.margins).flatMap(([m, c]) => Array(c).fill(Number(m)));
    margins.sort((a, b) => a - b);
    const median = margins[Math.floor(margins.length / 2)] ?? 0;
    const players = agg.players
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
      homeWin: agg.homeWins / n,
      tie: agg.ties / n,
      home: agg.sumHome / n,
      away: agg.sumAway / n,
      median,
      players,
    };
  }, [agg, snapshot]);

  return (
    <div className="page">
      <header>
        <div className="brand">
          Re<span>Run</span>
        </div>
        <div className="tagline">Every game, 10,000 times. Your way.</div>
      </header>

      {loadError && <p className="error">Could not load the slate: {loadError}</p>}
      {!snapshot && !loadError && <p className="muted">Loading the slate…</p>}

      {snapshot && (
        <>
          <section className="panel">
            <div className="row">
              <label>
                Game
                <select value={gameId} onChange={(e) => setGameId(e.target.value)}>
                  {snapshot.games.map((g) => (
                    <option key={g.gameId} value={g.gameId}>
                      {g.away} @ {g.home} · {kickoffLabel(g.kickoff)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Sims
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
              <button onClick={run} disabled={running || !game}>
                {running ? 'Running…' : 'Run'}
              </button>
            </div>
            {game && (
              <div className="meta num">
                {game.stadium.name} · {game.stadium.roof} · slate {snapshot.id} · engine{' '}
                {ENGINE_VERSION}
              </div>
            )}
          </section>

          {game && <GameFactors snapshot={snapshot} game={game} />}

          {runError && <p className="error">{runError}</p>}

          {summary && game && agg && (
            <>
              <section className="panel">
                <div className="progress">
                  <div style={{ width: pct(agg.done / agg.total) }} />
                </div>
                <div className="meta num">
                  {agg.done.toLocaleString()} / {agg.total.toLocaleString()} sims ·{' '}
                  {(agg.elapsedMs / 1000).toFixed(1)}s · seed {seed}
                </div>
                <div className="score">
                  <div>
                    <div className="team">{game.away}</div>
                    <div className="pts num">{summary.away.toFixed(1)}</div>
                    <div className="muted num">win {pct(1 - summary.homeWin - summary.tie)}</div>
                  </div>
                  <div className="at">@</div>
                  <div>
                    <div className="team">{game.home}</div>
                    <div className="pts num">{summary.home.toFixed(1)}</div>
                    <div className="muted num">win {pct(summary.homeWin)}</div>
                  </div>
                </div>
                <div className="stats num">
                  <span>
                    {summary.home >= summary.away ? game.home : game.away} by{' '}
                    {Math.abs(summary.home - summary.away).toFixed(1)} on average
                  </span>
                  <span>{(summary.home + summary.away).toFixed(1)} total points</span>
                  <span>Tie {pct(summary.tie)}</span>
                </div>
              </section>

              <section className="panel">
                <h2>Who wins, and by how much</h2>
                <MarginChart counts={agg.margins} n={summary.n} home={game.home} away={game.away} />
              </section>

              <section className="panel">
                <h2>Total points</h2>
                <TotalChart counts={agg.totals} n={summary.n} />
              </section>

              <section className="panel">
                <h2>Player projections</h2>
                <table className="num">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Pass</th>
                      <th>Rush</th>
                      <th>Rec</th>
                      <th>Catches</th>
                      <th>Any TD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.players.map((p) => (
                      <tr key={p.id}>
                        <td>
                          {p.name} <span className="muted">{`${p.team} ${p.position}`}</span>
                        </td>
                        <td>{p.passYds ? (p.passYds / summary.n).toFixed(0) : '–'}</td>
                        <td>{p.rushYds ? (p.rushYds / summary.n).toFixed(0) : '–'}</td>
                        <td>{p.recYds ? (p.recYds / summary.n).toFixed(0) : '–'}</td>
                        <td>{p.rec ? (p.rec / summary.n).toFixed(1) : '–'}</td>
                        <td>{pct(p.anyTd / summary.n)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted small">Mean per game across all sims.</p>
              </section>
            </>
          )}

          <section className="panel note small">
            Early preview with default model settings. Injuries, weather, altitude and rest are in
            the model. Live weather forecasts are in. Market lines, edges and the full Sim Lab
            controls are coming. Injury reports update when teams publish them.
          </section>
        </>
      )}

      <footer className="small muted">
        21+ only. Simulations are estimates, not guarantees. If gambling stops being fun, call
        1-800-GAMBLER. A GMDHC property.
      </footer>
    </div>
  );
}
