import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_OVERRIDES,
  DEFAULT_SETTINGS,
  ENGINE_VERSION,
  GAME_CONTROLS,
  randomSeed,
} from '@rerun/engine';
import type { RunRequest, SimCount, SlateSnapshot, SnapshotGame } from '@rerun/engine';
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

function Histogram(props: {
  counts: Record<number, number>;
  from: number;
  to: number;
  n: number;
  highlight?: (x: number) => boolean;
  label: (x: number) => string;
}) {
  const { counts, from, to, n, highlight, label } = props;
  const xs = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const max = Math.max(1, ...xs.map((x) => counts[x] ?? 0));
  const w = 100 / xs.length;
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
      </svg>
      <div className="axis">
        <span>{label(from)}</span>
        <span>{label(Math.round((from + to) / 2))}</span>
        <span>{label(to)}</span>
      </div>
    </div>
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
        const latest = (await (await fetch('/snapshots/latest.json')).json()) as { path: string };
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
    const request: RunRequest = {
      snapshotId: snapshot.id,
      gameId: game.gameId,
      engineVersion: ENGINE_VERSION,
      settings: DEFAULT_SETTINGS,
      overrides: DEFAULT_OVERRIDES,
      nSims,
      seed: s,
    };
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
          RE<span>RUN</span>
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
              <div className="meta mono">
                {game.stadium.name} · {game.stadium.roof} · slate {snapshot.id} · engine{' '}
                {ENGINE_VERSION}
              </div>
            )}
          </section>

          {runError && <p className="error">{runError}</p>}

          {summary && game && agg && (
            <>
              <section className="panel">
                <div className="progress">
                  <div style={{ width: pct(agg.done / agg.total) }} />
                </div>
                <div className="meta mono">
                  {agg.done.toLocaleString()} / {agg.total.toLocaleString()} sims ·{' '}
                  {(agg.elapsedMs / 1000).toFixed(1)}s · seed {seed}
                </div>
                <div className="score">
                  <div>
                    <div className="team">{game.away}</div>
                    <div className="pts mono">{summary.away.toFixed(1)}</div>
                    <div className="muted mono">win {pct(1 - summary.homeWin - summary.tie)}</div>
                  </div>
                  <div className="at">@</div>
                  <div>
                    <div className="team">{game.home}</div>
                    <div className="pts mono">{summary.home.toFixed(1)}</div>
                    <div className="muted mono">win {pct(summary.homeWin)}</div>
                  </div>
                </div>
                <div className="stats mono">
                  <span>
                    Home margin {(summary.home - summary.away).toFixed(1)} (median {summary.median})
                  </span>
                  <span>Total {(summary.home + summary.away).toFixed(1)}</span>
                  <span>Tie {pct(summary.tie)}</span>
                </div>
              </section>

              <section className="panel">
                <h2>
                  Margin ({game.home} − {game.away})
                </h2>
                <Histogram
                  counts={agg.margins}
                  from={-35}
                  to={35}
                  n={summary.n}
                  highlight={(x) => KEY_NUMBERS.has(Math.abs(x))}
                  label={(x) => (x > 0 ? `+${x}` : `${x}`)}
                />
                <p className="muted small">Highlighted: key numbers 3, 6, 7, 10, 14.</p>
              </section>

              <section className="panel">
                <h2>Total points</h2>
                <Histogram counts={agg.totals} from={10} to={80} n={summary.n} label={String} />
              </section>

              <section className="panel">
                <h2>Player projections</h2>
                <table className="mono">
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
                        <td className="sans">
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
            Early preview. Default model settings only. Market lines, weather, rest, travel and
            matchup adjustments, edges and the full Sim Lab controls are coming. Injury reports
            update when teams publish them.
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
