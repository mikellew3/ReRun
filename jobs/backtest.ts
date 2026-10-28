/**
 * Walk-forward backtest (CLAUDE.md §14). Snapshots come from pipeline/run_slate.py (each fit
 * uses only data before its week); closing lines and results from pipeline/backtest_lines.py.
 *
 *   npx tsx jobs/backtest.ts sim <snapshot.json>... --out rows.jsonl [--preset default]
 *                                [--n 2000] [--seed 2026]
 *   npx tsx jobs/backtest.ts report <rows.jsonl>... --closing closing.json --out report.json
 *
 * `sim` writes each game's margin and total counts. `report` scores them against the closing
 * lines: log loss and Brier vs the market's no-vig probabilities (and a 50/50 blend, which beats
 * the market only if the sim adds information), a calibration table, and the record and ROI of
 * betting every side whose edge clears each config tier, at the closing price.
 *
 * Closing-line value can't be measured here: nflverse has closing lines only, and betting the
 * close has zero CLV by definition. That makes this a hard test.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_OVERRIDES, ENGINE_VERSION, MODEL_CONFIG, getPreset, runSims } from '@rerun/engine';
import type { RunRequest, SimCount, SlateSnapshot } from '@rerun/engine';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
/** Arguments after the mode that are not flags or flag values. */
const positional: string[] = [];
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i]!.startsWith('--')) i++;
  else positional.push(process.argv[i]!);
}

type Counts = Record<number, number>;
interface Row {
  gameId: string;
  preset: string;
  snapshot: string;
  engine: string;
  n: number;
  margins: Counts;
  totals: Counts;
}

// ---------------------------------------------------------------------------
// sim
// ---------------------------------------------------------------------------

function sim(): void {
  const out = arg('out', '');
  if (!out) throw new Error('--out is required');
  const presetId = arg('preset', 'default');
  const preset = getPreset(presetId);
  if (!preset) throw new Error(`Unknown preset ${presetId}`);
  const n = Number(arg('n', '2000'));
  const seed = Number(arg('seed', '2026'));
  for (const file of positional) {
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as SlateSnapshot;
    const t0 = performance.now();
    for (const game of snapshot.games) {
      const request: RunRequest = {
        snapshotId: snapshot.id,
        gameId: game.gameId,
        engineVersion: ENGINE_VERSION,
        settings: preset.settings,
        overrides: DEFAULT_OVERRIDES,
        nSims: 1000 as SimCount,
        seed,
      };
      // Sim counts are a UI choice list; the backtest runs n sims in 1,000-sim blocks with
      // distinct seeds so any n works.
      const margins: Counts = {};
      const totals: Counts = {};
      for (let block = 0; block < Math.ceil(n / 1000); block++) {
        for (const r of runSims({ ...request, seed: seed + block * 7919 }, snapshot)) {
          const m = r.final.home - r.final.away;
          const t = r.final.home + r.final.away;
          margins[m] = (margins[m] ?? 0) + 1;
          totals[t] = (totals[t] ?? 0) + 1;
        }
      }
      const row: Row = {
        gameId: game.gameId,
        preset: presetId,
        snapshot: snapshot.id,
        engine: ENGINE_VERSION,
        n: Math.ceil(n / 1000) * 1000,
        margins,
        totals,
      };
      appendFileSync(out, JSON.stringify(row) + '\n');
    }
    console.log(
      `${snapshot.id}: ${snapshot.games.length} games in ${((performance.now() - t0) / 1000).toFixed(0)}s`,
    );
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

interface Closing {
  season: number;
  week: number;
  homeScore: number;
  awayScore: number;
  homeSpread: number | null;
  homeSpreadPrice: number | null;
  awaySpreadPrice: number | null;
  total: number | null;
  overPrice: number | null;
  underPrice: number | null;
  homeMl: number | null;
  awayMl: number | null;
}

const implied = (a: number) => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
const decimal = (a: number) => 1 + (a > 0 ? a / 100 : 100 / -a);

function share(c: Counts, n: number, test: (x: number) => boolean): number {
  let k = 0;
  for (const [x, v] of Object.entries(c)) if (test(Number(x))) k += v;
  return k / n;
}

/** One two-way bet on a game: side A's sim and market chances (pushes removed) and result. */
interface Pick {
  market: 'moneyline' | 'spread' | 'total';
  season: number;
  /** Sim and no-vig market probability of side A, given no push. */
  sim: number;
  mkt: number;
  /** 1 = side A won, 0 = side B won, null = push. */
  outcome: 1 | 0 | null;
  priceA: number;
  priceB: number;
}

function picks(row: Row, c: Closing): Pick[] {
  const out: Pick[] = [];
  const margin = c.homeScore - c.awayScore;
  const total = c.homeScore + c.awayScore;
  const noPush = (win: number, push: number) => win / Math.max(1e-9, 1 - push);
  const nv = (a: number, b: number) => implied(a) / (implied(a) + implied(b));
  const n = row.n;
  if (c.homeMl !== null && c.awayMl !== null) {
    const tie = share(row.margins, n, (m) => m === 0);
    out.push({
      market: 'moneyline',
      season: c.season,
      sim: noPush(
        share(row.margins, n, (m) => m > 0),
        tie,
      ),
      mkt: nv(c.homeMl, c.awayMl),
      outcome: margin === 0 ? null : margin > 0 ? 1 : 0,
      priceA: c.homeMl,
      priceB: c.awayMl,
    });
  }
  if (c.homeSpread !== null && c.homeSpreadPrice !== null && c.awaySpreadPrice !== null) {
    const s = c.homeSpread;
    out.push({
      market: 'spread',
      season: c.season,
      sim: noPush(
        share(row.margins, n, (m) => m + s > 0),
        share(row.margins, n, (m) => m + s === 0),
      ),
      mkt: nv(c.homeSpreadPrice, c.awaySpreadPrice),
      outcome: margin + s === 0 ? null : margin + s > 0 ? 1 : 0,
      priceA: c.homeSpreadPrice,
      priceB: c.awaySpreadPrice,
    });
  }
  if (c.total !== null && c.overPrice !== null && c.underPrice !== null) {
    const t = c.total;
    out.push({
      market: 'total',
      season: c.season,
      sim: noPush(
        share(row.totals, n, (x) => x > t),
        share(row.totals, n, (x) => x === t),
      ),
      mkt: nv(c.overPrice, c.underPrice),
      outcome: total === t ? null : total > t ? 1 : 0,
      priceA: c.overPrice,
      priceB: c.underPrice,
    });
  }
  return out;
}

const clip = (p: number) => Math.min(1 - 1e-4, Math.max(1e-4, p));
const logLoss = (p: number, y: 0 | 1) => -(y * Math.log(clip(p)) + (1 - y) * Math.log(1 - clip(p)));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function score(ps: Pick[]) {
  const graded = ps.filter((p) => p.outcome !== null) as (Pick & { outcome: 0 | 1 })[];
  const mean = (f: (p: (typeof graded)[number]) => number) =>
    graded.reduce((a, p) => a + f(p), 0) / Math.max(1, graded.length);
  const blend = (p: Pick) => (p.sim + p.mkt) / 2;
  const accuracy = {
    games: graded.length,
    logLoss: {
      sim: r3(mean((p) => logLoss(p.sim, p.outcome))),
      market: r3(mean((p) => logLoss(p.mkt, p.outcome))),
      blend: r3(mean((p) => logLoss(blend(p), p.outcome))),
    },
    brier: {
      sim: r3(mean((p) => (p.sim - p.outcome) ** 2)),
      market: r3(mean((p) => (p.mkt - p.outcome) ** 2)),
    },
    /** Mean sim minus market probability of side A (home / over): a lean. */
    meanLean: r3(mean((p) => p.sim - p.mkt)),
  };

  // Calibration: sim probability bins vs how often side A won.
  const bins = [0, 0.2, 0.35, 0.45, 0.55, 0.65, 0.8, 1.0001];
  const calibration = bins.slice(0, -1).map((lo, i) => {
    const hi = bins[i + 1]!;
    const inBin = graded.filter((p) => p.sim >= lo && p.sim < hi);
    return {
      bin: `${Math.round(lo * 100)}-${Math.min(100, Math.round(hi * 100))}%`,
      n: inBin.length,
      sim: r3(inBin.reduce((a, p) => a + p.sim, 0) / Math.max(1, inBin.length)),
      market: r3(inBin.reduce((a, p) => a + p.mkt, 0) / Math.max(1, inBin.length)),
      actual: r3(inBin.reduce((a, p) => a + p.outcome, 0) / Math.max(1, inBin.length)),
    };
  });

  // Bets: every side whose edge (sim - no-vig) clears the tier, 1 unit at the closing price.
  const betting = MODEL_CONFIG.markets.edgeTiers.map((tier) => {
    let w = 0;
    let l = 0;
    let push = 0;
    let units = 0;
    for (const p of ps) {
      for (const side of ['A', 'B'] as const) {
        const edge = side === 'A' ? p.sim - p.mkt : 1 - p.sim - (1 - p.mkt);
        if (edge < tier.minEdge) continue;
        const price = side === 'A' ? p.priceA : p.priceB;
        if (p.outcome === null) {
          push++;
        } else if ((p.outcome === 1) === (side === 'A')) {
          w++;
          units += decimal(price) - 1;
        } else {
          l++;
          units -= 1;
        }
      }
    }
    const bets = w + l + push;
    return {
      tier: tier.id,
      minEdge: tier.minEdge,
      bets,
      record: `${w}-${l}-${push}`,
      winRate: r3(w / Math.max(1, w + l)),
      units: Math.round(units * 10) / 10,
      roi: r3(units / Math.max(1, bets)),
    };
  });
  return { accuracy, calibration, betting };
}

function report(): void {
  const closing = JSON.parse(readFileSync(arg('closing', ''), 'utf8')) as Record<string, Closing>;
  const rows = positional.flatMap((f) =>
    readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Row),
  );
  const presets = [...new Set(rows.map((r) => r.preset))];
  const out: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
    engine: ENGINE_VERSION,
    note: 'Walk-forward: each week fit only on data before it. Bets at the closing price.',
    presets: {},
  };
  for (const preset of presets) {
    const ps = rows
      .filter((r) => r.preset === preset && closing[r.gameId])
      .flatMap((r) => picks(r, closing[r.gameId]!));
    const byMarket: Record<string, unknown> = {};
    for (const market of ['moneyline', 'spread', 'total'] as const) {
      const m = ps.filter((p) => p.market === market);
      const seasons = [...new Set(m.map((p) => p.season))].sort();
      byMarket[market] = {
        ...score(m),
        bySeason: Object.fromEntries(
          seasons.map((s) => {
            const sc = score(m.filter((p) => p.season === s));
            return [s, { accuracy: sc.accuracy, betting: sc.betting }];
          }),
        ),
      };
    }
    (out.presets as Record<string, unknown>)[preset] = {
      games: new Set(rows.filter((r) => r.preset === preset).map((r) => r.gameId)).size,
      sims: rows.find((r) => r.preset === preset)?.n,
      ...byMarket,
    };
  }
  const file = arg('out', 'backtest-report.json');
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${file}`);
}

const mode = process.argv[2];
if (mode === 'sim') sim();
else if (mode === 'report') report();
else {
  console.error('Usage: tsx jobs/backtest.ts sim|report ...');
  process.exit(1);
}
