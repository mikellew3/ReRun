/**
 * Value shading: after a run, a book's price is shaded green when betting it has expected value
 * of at least config markets.valueShading.minEv at the sim's probability. Pushes refund the
 * stake. Research only: no stakes or tiers (those stay behind markets.showEdges).
 */

import { MODEL_CONFIG } from '@rerun/engine';
import type { MarketKey, TrackedMarket } from '@rerun/engine';
import { pct } from './charts';
import type { Counts } from './charts';
import type { Aggregate, PlayerAgg, PropStat } from './sim.worker';

const CFG = MODEL_CONFIG.markets.valueShading;

export interface Value {
  /** Sim chance the bet wins, and pushes. */
  win: number;
  push: number;
  /** Win rate the price needs to break even (ignoring pushes). */
  breakEven: number;
  /** Expected profit per unit staked. */
  ev: number;
}

/** American odds with a real minus sign. */
const odds = (a: number) => (a > 0 ? `+${a}` : `−${Math.abs(a)}`);

const decimal = (a: number) => 1 + (a > 0 ? a / 100 : 100 / -a);

export function priceValue(win: number, push: number, american: number): Value {
  const d = decimal(american);
  return { win, push, breakEven: 1 / d, ev: win * (d - 1) - (1 - win - push) };
}

function share(counts: Counts, n: number, test: (x: number) => boolean): number {
  let k = 0;
  for (const [x, c] of Object.entries(counts)) if (test(Number(x))) k += c;
  return k / Math.max(1, n);
}

/** Win and push chance of `win`/`push` tests over a count table. */
function chances(
  counts: Counts,
  n: number,
  win: (x: number) => boolean,
  push: (x: number) => boolean,
) {
  return { win: share(counts, n, win), push: share(counts, n, push) };
}

/**
 * Sim chances for one side of a game line as the line history stores it: side 'a' is home
 * (spreads, moneylines) or over (totals, team totals); spreads are the home team's line.
 * Moneyline ties push.
 */
export function lineChances(
  agg: Aggregate,
  market: TrackedMarket,
  side: 'a' | 'b',
  line: number | null,
): { win: number; push: number } | null {
  const n = agg.done;
  const a = side === 'a';
  const half = market.endsWith('_h1');
  const margins = half ? agg.h1Margins : agg.margins;
  if (market.startsWith('h2h')) {
    return chances(
      margins,
      n,
      (m) => (a ? m > 0 : m < 0),
      (m) => m === 0,
    );
  }
  if (line === null) return null;
  if (market.startsWith('spreads')) {
    // Home covers when margin + home line > 0.
    return chances(
      margins,
      n,
      (m) => (a ? m + line > 0 : m + line < 0),
      (m) => m + line === 0,
    );
  }
  const counts = market.startsWith('totals')
    ? half
      ? agg.h1Totals
      : agg.totals
    : market === 'team_totals_home'
      ? agg.homePts
      : agg.awayPts;
  return chances(
    counts,
    n,
    (t) => (a ? t > line : t < line),
    (t) => t === line,
  );
}

/** Prop market -> the stat whose distribution prices it. */
export const PROP_STAT: Partial<Record<MarketKey, PropStat>> = {
  player_pass_yds: 'passYds',
  player_pass_attempts: 'passAtt',
  player_pass_completions: 'passCmp',
  player_pass_tds: 'passTd',
  player_pass_interceptions: 'passInt',
  player_rush_yds: 'rushYds',
  player_rush_attempts: 'rushAtt',
  player_receptions: 'rec',
  player_reception_yds: 'recYds',
};

/** Over/under chances for a prop, counting only sims the player played (others are void). */
export function propChances(
  p: PlayerAgg,
  n: number,
  market: MarketKey,
  line: number,
  over: boolean,
): { win: number; push: number } | null {
  const stat = PROP_STAT[market];
  if (!stat) return null;
  const played = n - p.sitOut;
  if (played <= 0) return null;
  const dist = p.dist[stat];
  let above = 0;
  let at = 0;
  let nonzero = 0;
  for (const [x, c] of Object.entries(dist)) {
    const v = Number(x);
    nonzero += c;
    if (v > line) above += c;
    if (v === line) at += c;
  }
  if (line === 0) at += played - nonzero;
  const win = over ? above / played : (played - above - at) / played;
  return { win, push: at / played };
}

export const shadeProps = (market: MarketKey) =>
  CFG.enabled && (CFG.propMarkets as readonly string[]).includes(market);

/** A price, shaded green when it has value at the sim's chances. */
export function Price(props: { american: number; chances?: { win: number; push: number } | null }) {
  const { american, chances: c } = props;
  if (!CFG.enabled || !c) return <span>{odds(american)}</span>;
  const v = priceValue(c.win, c.push, american);
  const good = v.ev >= CFG.minEv;
  return (
    <span
      className={good ? 'price value' : 'price'}
      title={`Sim ${pct(v.win)}${v.push >= 0.005 ? ` (push ${pct(v.push)})` : ''} · needs ${pct(
        v.breakEven,
      )} · EV ${v.ev >= 0 ? '+' : '−'}${Math.abs(100 * v.ev).toFixed(1)}%`}
    >
      {odds(american)}
    </span>
  );
}

export function ValueNote() {
  if (!CFG.enabled) return null;
  return (
    <span className="caption muted value-note">
      <i className="price value">Green</i> = at least +{Math.round(100 * CFG.minEv)}% expected value
      at the sim&apos;s odds (hover a price for the numbers). An early model: research, not picks.
    </span>
  );
}
