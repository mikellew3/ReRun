/**
 * Result charts, per the design system's data-viz rules: neutral bars, copper for the side being
 * tested, a thin dashed line for the reference line, gridlines #F2EFEC, no chart borders, bar
 * tops radius 4, tabular figures everywhere.
 */

import type { CSSProperties } from 'react';

export type Counts = Record<number, number>;

export const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

/** Share of sims where the value satisfies `test`. */
export function shareWhere(counts: Counts, n: number, test: (x: number) => boolean): number {
  let k = 0;
  for (const [x, c] of Object.entries(counts)) if (test(Number(x))) k += c;
  return k / Math.max(1, n);
}

/** Value at quantile q of a count table. */
export function quantile(counts: Counts, n: number, q: number): number {
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

/** No-vig American price for a probability, e.g. 0.6 -> "−150", 0.4 -> "+150". */
export function fairAmerican(p: number): string {
  const q = Math.min(0.999, Math.max(0.001, p));
  if (q >= 0.5) return `−${Math.round((100 * q) / (1 - q))}`;
  return `+${Math.round((100 * (1 - q)) / q)}`;
}

/** Signed number with a real minus sign. */
export const signed = (x: number, digits = 1) =>
  `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(digits)}`;

const KEY_NUMBERS = new Set([3, 7, 10, 14]);

function Bars(props: {
  counts: Counts;
  from: number;
  to: number;
  highlight: (x: number) => boolean;
  label: (x: number) => string;
  n: number;
}) {
  const { counts, from, to, highlight, label, n } = props;
  const xs = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const max = Math.max(1, ...xs.map((x) => counts[x] ?? 0));
  return (
    <div className="bars">
      {xs.map((x) => (
        <div
          key={x}
          className={highlight(x) ? 'bar on' : 'bar'}
          style={{ height: `${(100 * (counts[x] ?? 0)) / max}%` }}
          title={`${label(x)}: ${pct((counts[x] ?? 0) / Math.max(1, n))}`}
        />
      ))}
    </div>
  );
}

/** Position (%) of the center of value x among bars from..to. */
const at = (x: number, from: number, to: number) => ((x - from + 0.5) / (to - from + 1)) * 100;

function RefLine(props: { x: number; from: number; to: number; label: string }) {
  const left: CSSProperties = { left: `${at(props.x, props.from, props.to)}%` };
  return (
    <>
      <div className="ref-line" style={left} />
      <div className="ref-pill num" style={left}>
        {props.label}
      </div>
    </>
  );
}

function Stat(props: { value: string; label: string; copper?: boolean }) {
  return (
    <div className="stat">
      <span className={props.copper ? 'stat-value num copper' : 'stat-value num'}>
        {props.value}
      </span>
      <span className="caption">{props.label}</span>
    </div>
  );
}

/**
 * Margin from the favorite's side: copper bars are the games the favorite wins. Key numbers on
 * the axis are emphasized.
 */
export function MarginHistogram(props: {
  margins: Counts;
  n: number;
  favorite: string;
  underdog: string;
  /** The favorite's market spread (e.g. −4), when the snapshot has market lines. */
  market?: number;
}) {
  const { margins, n, favorite, underdog, market } = props;
  // The favorite covers when it wins by more than this.
  const cover = market === undefined ? 0 : -market;
  const coverLabel =
    market === undefined ? `${favorite} wins` : `${favorite} covers ${signed(market)}`;
  const from = -35;
  const to = 35;
  const ticks = [-21, -14, -7, 0, 3, 7, 10, 14, 21, 28];
  return (
    <section className="card chart-card">
      <div className="card-head">
        <div className="head-text">
          <h2>Margin</h2>
          <span className="small muted">
            {favorite} margin across {n.toLocaleString()} sims
          </span>
        </div>
        <div className="stats-row">
          <Stat value={pct(shareWhere(margins, n, (m) => m > cover))} label={coverLabel} copper />
          <Stat value={pct(shareWhere(margins, n, (m) => Math.abs(m) === 3))} label="Lands on 3" />
          <Stat value={pct(shareWhere(margins, n, (m) => Math.abs(m) <= 7))} label="One score" />
        </div>
      </div>
      <div className="plot" role="img" aria-label={`Histogram of ${favorite} margin of victory`}>
        <div className="grid" />
        <Bars
          counts={margins}
          from={from}
          to={to}
          n={n}
          highlight={(m) => m > cover}
          label={(m) => (m === 0 ? 'Tie' : m > 0 ? `${favorite} by ${m}` : `${underdog} by ${-m}`)}
        />
        <RefLine
          x={cover}
          from={from}
          to={to}
          label={market === undefined ? 'Even' : `Market ${favorite} ${signed(market)}`}
        />
      </div>
      <div className="ticks num" aria-hidden="true">
        {ticks.map((t) => (
          <span
            key={t}
            className={[KEY_NUMBERS.has(t) ? 'key' : '', t === 3 || t === 10 ? 'minor' : '']
              .join(' ')
              .trim()}
            style={{ left: `${at(t, from, to)}%` }}
          >
            {t === 0 ? '0' : signed(t, 0)}
          </span>
        ))}
      </div>
      <div className="axis-sides caption">
        <span>← {underdog} wins</span>
        <span>{favorite} margin (points)</span>
        <span>{favorite} wins →</span>
      </div>
      <div className="legend caption">
        <span>
          <i className="swatch on" />
          {coverLabel}
        </span>
        <span>
          <i className="swatch" />
          {market === undefined ? `${underdog} wins or tie` : 'Doesn’t cover'}
        </span>
        {market !== undefined && (
          <span>
            <i className="swatch dashed" />
            Market line
          </span>
        )}
        <span>
          <b className="key">3 · 7 · 10 · 14</b>Key numbers
        </span>
      </div>
    </section>
  );
}

/** Totals against the market total (else the sim's middle line): copper bars go over it. */
export function TotalHistogram(props: { totals: Counts; n: number; market?: number }) {
  const { totals, n, market } = props;
  const from = 10;
  const to = 80;
  const median = quantile(totals, n, 0.5);
  const line = market ?? Math.floor(median) + 0.5;
  return (
    <section className="card chart-card">
      <div className="card-head">
        <div className="head-text">
          <h2>Total points</h2>
          <span className="small muted">
            Combined points · half of games land between {quantile(totals, n, 0.25)} and{' '}
            {quantile(totals, n, 0.75)}
          </span>
        </div>
        <Stat value={pct(shareWhere(totals, n, (t) => t > line))} label={`Over ${line}`} copper />
      </div>
      <div className="plot short" role="img" aria-label="Histogram of total points">
        <div className="grid" />
        <Bars
          counts={totals}
          from={from}
          to={to}
          n={n}
          highlight={(t) => t > line}
          label={(t) => `${t} points`}
        />
        <RefLine
          x={line}
          from={from}
          to={to}
          label={market === undefined ? `Middle ${line}` : `Market ${line}`}
        />
      </div>
      <div className="ticks num" aria-hidden="true">
        {[20, 30, 40, 50, 60, 70].map((t) => (
          <span key={t} style={{ left: `${at(t, from, to)}%` }}>
            {t === 70 ? '70+' : t}
          </span>
        ))}
      </div>
    </section>
  );
}

/** Cover probability and fair price for the favorite at each half-point spread. */
export function AltLadder(props: {
  margins: Counts;
  n: number;
  favorite: string;
  /** The favorite's market spread, marked MKT when it is on the ladder. */
  market?: number;
}) {
  const { margins, n, favorite, market } = props;
  const rows = Array.from({ length: 11 }, (_, i) => {
    const line = i + 0.5;
    const p = shareWhere(margins, n, (m) => m > line);
    return { line, p };
  });
  // The fair line: the spread closest to a coin flip.
  const fairIdx = rows.reduce(
    (best, r, i) => (Math.abs(r.p - 0.5) < Math.abs(rows[best]!.p - 0.5) ? i : best),
    0,
  );
  return (
    <section className="card">
      <div className="card-head baseline">
        <h2>Alt-line ladder</h2>
        <div className="ladder-cols caption">
          <span>Cover</span>
          <span>Fair</span>
        </div>
      </div>
      <div className="ladder num">
        {rows.map((r, i) => (
          <div key={r.line} className={i === fairIdx ? 'ladder-row fair' : 'ladder-row'}>
            <span className="ladder-label">
              {favorite} −{r.line}
              {i === fairIdx && <span className="pill-dark">FAIR</span>}
              {market !== undefined && -market === r.line && <span className="pill-dark">MKT</span>}
            </span>
            <div className="meter">
              <div className={r.p >= 0.5 ? 'fill on' : 'fill'} style={{ width: `${100 * r.p}%` }} />
            </div>
            <span className="ladder-pct">{pct(r.p)}</span>
            <span className="ladder-fair muted">{fairAmerican(r.p)}</span>
          </div>
        ))}
      </div>
      <span className="caption muted">
        Cover = {favorite} wins by more than the line. Fair = no-vig American price.
      </span>
    </section>
  );
}

export function WinProbability(props: {
  favorite: string;
  underdog: string;
  favWin: number;
  dogWin: number;
}) {
  const { favorite, underdog, favWin, dogWin } = props;
  return (
    <section className="card">
      <h2>Win probability</h2>
      <div className="win-row num">
        <div className="win-side">
          <span className="win-pct muted">{pct(dogWin)}</span>
          <span className="caption">{underdog}</span>
        </div>
        <div className="win-side right">
          <span className="win-pct copper">{pct(favWin)}</span>
          <span className="caption">{favorite}</span>
        </div>
      </div>
      <div
        className="split"
        role="img"
        aria-label={`${favorite} ${pct(favWin)}, ${underdog} ${pct(dogWin)}`}
      >
        <div className="split-dog" style={{ width: `${100 * dogWin}%` }} />
        <div className="split-fav" />
      </div>
      <span className="caption muted num">
        Fair moneyline {favorite} {fairAmerican(favWin / Math.max(1e-9, favWin + dogWin))} ·{' '}
        {underdog} {fairAmerican(dogWin / Math.max(1e-9, favWin + dogWin))}
      </span>
    </section>
  );
}
