# Phase 1, steps 1–3 — proposal for review

Status: **approved by Mike, 2026-10-27.** Steps 1–3 implemented. Step 4 (calibration): see [`docs/calibration.md`](../calibration.md).

### Changes made while implementing step 1

- **Node 22, not Node 20.** Node 20 reached end of life in April 2026, and vitest 5 requires Node 22.12+. CI and `.nvmrc` use 22.
- **`Precip` is a plain string**, `'none' | 'light_rain' | 'heavy_rain' | 'light_snow' | 'heavy_snow'`, instead of a nested object. Simpler, and maps 1:1 to the UI dropdown.
- **`side` added to `MarketLine` and `CustomLine`** for team totals (which team's total).
- **`ENGINE_VERSION` is a hand-bumped version** in `engine/src/version.ts`. A golden-output test (step 3) will fail if sim output changes without a bump.
- **Python config loader and its test moved into step 1** (`pipeline/common/config.py`, `pipeline/tests/test_model_config.py`) so the Python CI job has something to run.

### Changes made while implementing step 3

- **Extra engine files:** `context.ts` (per-game state and stats) and `rules.ts` (scoring, possession changes, overtime) alongside the planned `clock.ts`, `decisions.ts` and `playCall.ts`.
- **How team and player numbers combine:** offense and defense rates are combined in logit space against the league average. If the starting QB is not the team's usual QB, the gap between the two QBs' own numbers is added. Each receiver's catch odds and yardage, and each rusher's yardage, are set relative to the team average, so the team totals are preserved.
- **Points-equivalent effects** (home field now; rest, travel and altitude in step 5) become small shifts in completion odds and yardage. The conversion rates live in `MODEL_CONFIG.pointsToEfficiency` and are tuned in step 4.
- **Questionable players** are drawn in or out per sim with their play probability. Each sim's in/out draw comes from its own random stream, so results stay identical however a run is split.
- **Random streams (fixed in step 4):** sim *i* of game *g* uses `createRng(gameSeed(seed, g), i)`. Originally the stream ignored the game, so different games in one run were correlated.
- **Not yet applied** (steps 5 and 6): weather, rest, travel, altitude, defense-vs-position matchups, streaks, backup-player efficiency, OL/secondary injuries and market-implied usage. Conditions are already resolved (forecast or user override) and passed through.
- **Kickoff outcome** gained an optional `onsideRecovered` flag for the replay.
- **Uncalibrated results on the 2026 week-8 slate:** the sim's margins correlate 0.88 with market spreads, but totals run about 3 points low and margins are too spread out. Key-number spikes at 3 and 7 are present. Step 4 fixes the level and spread.
- **Speed:** 10,000 sims of one game take about 1.1 s in Node on the CI-class machine. A phone will likely be 3–5x slower, which is close to the 5-second target, so the Web Worker in Phase 2 will be benchmarked on a real phone.

### Changes made while implementing step 2

- **`LeagueParams.kickReturnYds` renamed `kickoffStartYardline`** (where the receiving team starts after a returned kickoff, which is what the engine needs), and a **`specialTeams` block** added (kickoff/punt touchback and return-TD rates, FG block rate).
- **Fitting constants added to `model.config.ts`** (`fitting.*`: red-zone and goal-line lines, neutral game state, pace gap cap, histogram ranges, punt/kickoff filters, rounding). `ridgeLambda` became `ridgeLambdaPlays: 200`, with its unit stated.
- **Opponent adjustment method:** one ridge regression per rate over the season window gives each team's offense and defense effect; each game is then adjusted by the opponent's effect and averaged over the chosen history window. This lets every window (season, L3–L8) reuse one fit.
- **`L3`–`L8` windows cross into the prior season** when a team or player has fewer games this season, so they always have data.
- **`routeShare` is snap share** for now: free nflverse data has no route counts.
- **`replacementDelta` is filled for QBs only** in step 2. Skill-position replacement comes with injuries in step 5.
- **Depth charts:** ESPN-format charts (2025+) are used directly. Older seasons fall back to ordering by snap share, which the 2022–2024 backtest will rely on.
- **Injury status is never carried over from last week.** Until the current week's report exists, players are `active`.

Contents:
1. Decisions that need a yes/no
2. File list, steps 1–3
3. Conventions (units, ids, determinism)
4. Types: `SimSettings` (+ per-game overrides and run request)
5. Types: team params
6. Types: player params
7. Types: slate snapshot
8. Types: game state
9. Types: play outcome (+ per-sim result)
10. What goes in `model.config.ts` vs the snapshot

---

## 1. Decisions that need a yes/no

**D1. Split "settings" into three objects.** The brief says builds hold `SimSettings` but roster/usage overrides are per game. Some §7 items are also per game or per run (venue, conditions, custom lines, sim count, seed). Proposal:

| Object | Holds | Saved on |
|---|---|---|
| `SimSettings` | lenses + adjustment toggles (portable across games) | build, run, lock |
| `GameOverrides` | venue, conditions, roster in/out, usage nudges, custom lines | run, lock |
| `RunRequest` | snapshot id, game id, settings, overrides, sim count, seed, engine version | run, lock |

Script tilt stays in `SimSettings` keyed by **home/away** (not team), so a build like "slow the road team down" is portable. OK?

**D2. Weatherman needs a lever.** No §7.5 lens does "emphasis on conditions". Proposal: add a `conditionsWeight` lens (0–2×, default 1) that scales every weather effect. Weatherman sets it to 1.5. OK?

**D3. Yardage distributions = league shape + team tilt.** Storing full per-team histograms for 7 history windows blows the 1 MB snapshot budget and is noisy at L3. Proposal: the snapshot holds **league-wide empirical histograms** (by play type), and each team/player gets a small set of numbers (mean shift via exponential tilt, explosive rate) that reweight the league shape. This keeps real key-number shape and fits in ~300–500 KB gzipped per slate. OK?

**D4. Fitted baselines live in the snapshot, not `model.config.ts`.** §4.1 lists "play-outcome distributions" as config. They are fitted from data, so I'd put them in the snapshot's `league` block (versioned, reproducible). Config keeps hand-set constants and priors. OK?

**D5. Engine version on every run and lock.** Same snapshot + settings + seed only reproduces if the engine code is also the same. Every `RunRequest` records `engineVersion` (package version + git short hash). Locks are accepted only on the current engine version, and `verifyLocks` refuses (rather than rejects) locks from a different version. OK?

**D6. Per-sim seeding.** Each simulated game gets its own RNG seeded from `(runSeed, simIndex)`. Results are then identical no matter how a run is split across workers or chunks, and Replay can re-create sim #4127 exactly without storing every play. (No decision needed — flagging the design.)

**D7. "Slot" isn't in free data.** nflverse doesn't give reliable slot alignment. Proposal: defense-vs-position buckets are **WR1 / WR2 / WR3 / TE / RB** by target-share rank within the team, instead of WR1/WR2/slot/TE/RB. OK?

**D8. Tooling.** npm workspaces (engine, jobs; web later), TypeScript 5 strict, vitest, zod 4, ESLint + Prettier. Python: pip + `pyproject.toml`, ruff, pytest. Node 20 in CI. OK?

---

## 2. File list, steps 1–3

`(new)` = not in the CLAUDE.md layout; reason given.

### Step 1 — scaffold, CI, config, RNG

```
package.json                     # npm workspaces: engine, jobs
tsconfig.base.json               # strict TS shared by all packages
.nvmrc                           # 20
.gitignore
.editorconfig
.prettierrc.json
eslint.config.js
.github/workflows/ci.yml         # typecheck, lint, test (engine + jobs); ruff + pytest (pipeline)

engine/package.json
engine/tsconfig.json
engine/vitest.config.ts
engine/src/index.ts              # (new) public exports
engine/src/types.ts              # all shared types in this doc
engine/src/rng.ts                # xoshiro128** + splitmix32 seeding, simSeed(runSeed, i)
engine/src/version.ts            # (new) ENGINE_VERSION, filled at build (D5)
engine/src/config/model.config.ts
engine/src/config/settings.schema.ts
engine/src/config/presets.ts
engine/src/config/index.ts       # (new) re-exports + configHash()
engine/test/rng.test.ts          # determinism, uniformity, independence of sim streams
engine/test/settings.test.ts     # defaults validate; out-of-range rejected
engine/test/presets.test.ts      # every preset validates against the schema

jobs/package.json
jobs/tsconfig.json
jobs/exportConfig.ts             # writes pipeline/model_config.json

pipeline/pyproject.toml          # deps: nflreadpy, pandas, pyarrow, numpy, scikit-learn; dev: ruff, pytest
pipeline/model_config.json       # generated by exportConfig; committed so Python CI needs no Node
```

### Step 2 — pipeline: nflverse, stadiums, team + player params

```
pipeline/stadiums.csv
pipeline/common/__init__.py
pipeline/common/config.py        # (new) loads model_config.json
pipeline/common/io.py            # (new) paths, parquet read/write under pipeline/data/ (gitignored)
pipeline/common/weights.py       # (new) recency weights + history-window filters, shared by both fitters
pipeline/fetch_nflverse.py       # pbp, rosters, weekly rosters, depth charts, injuries, snaps, player stats, schedules
pipeline/fit_league_params.py    # (new) league histograms + baseline rates (D3, D4)
pipeline/fit_team_params.py      # per team, off/def, per window, ridge opponent adjustment
pipeline/fit_player_params.py    # per player, per window; replacement-level deltas
pipeline/build_snapshot.py       # step-2 version: no odds/weather yet (those fields null); full version in step 6
pipeline/tests/test_weights.py
pipeline/tests/test_fit_team_params.py   # on a small fixture
pipeline/tests/fixtures/...              # tiny pbp sample
```

`build_snapshot.py` starts in step 2 (without market/weather) because step 3's engine tests need a real snapshot to run against.

### Step 3 — engine core

```
engine/src/samplers.ts           # (new) alias-method sampling of histograms, exponential tilt, Poisson
engine/src/usage.ts              # target/carry allocation; renormalize after nudges and outs
engine/src/applySettings.ts      # RunRequest + snapshot -> EngineInputs (resolved per-matchup rates)
engine/src/playCall.ts           # (new) pass/run choice from PROE, situation, script tilt
engine/src/play.ts               # one scrimmage play -> PlayOutcome
engine/src/specialTeams.ts       # FG, punts, kickoffs, PATs/2-pt
engine/src/decisions.ts          # (new) 4th-down, timeouts, kneel/spike, 2-pt choice (table-driven)
engine/src/clock.ts              # (new) runoff by situation, 2-minute drill, quarter/half ends
engine/src/drive.ts              # drive loop
engine/src/game.ts               # game loop, halves, OT
engine/src/sim.ts                # (new) runSims(request, snapshot, onProgress) -> SimGameResult stream
engine/test/fixtures/snapshot.sample.json   # small real snapshot from step 2
engine/test/usage.test.ts        # shares sum to 1; outs redistribute; nudges renormalize
engine/test/play.test.ts         # outcome rates match inputs over many samples
engine/test/game.test.ts         # invariants (clock, downs, legal scores), determinism, chunk-independence
engine/test/applySettings.test.ts
```

`clock.ts`, `decisions.ts` and `playCall.ts` split out of `game.ts`/`play.ts` only to keep each file short and testable. `adjust/`, `aggregate.ts`, `pricing.ts` and `calibration.test.ts` come in steps 4–7.

---

## 3. Conventions

- **Ids:** nflverse everywhere. `TeamAbbr` = `"KC"`, `PlayerId` = gsis id `"00-0033873"`, `GameId` = `"2026_09_KC_BUF"`. Snapshot id = `"2026-W09-v3"`.
- **Field position:** `yardline` = yards from the **offense's own** goal line (1–99). 75 = own 25. Distance to TD = `100 − yardline`.
- **Clock:** seconds remaining in the current quarter.
- **Probabilities** 0–1. **Prices** American odds as integers (−115, +130).
- **Shares** 0–1. User usage nudges are in **share points** (+0.03 = +3 pts of target share).
- **Seeds** unsigned 32-bit integers. "Auto" seed is resolved to a number before the run starts, so a stored run always has a concrete seed.
- **Performance:** the types below are the boundary types (snapshot, settings, results, replay). The hot loop uses mutable state and numeric indices (players mapped to small ints by `applySettings`) and doesn't allocate per play.

---

## 4. `SimSettings`, `GameOverrides`, `RunRequest`

The TypeScript types are inferred from the zod schema (`z.infer`), so the schema is the single source. Written out here for readability:

```ts
// engine/src/types.ts (excerpt)

export type Side = 'home' | 'away';
export type HistoryWindow = 'season' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8';

/** Portable across games. Saved on builds. */
export interface SimSettings {
  schemaVersion: 1;
  lenses: {
    marketBlend: number;        // 0..1, step 0.05, default 0.5 (config)
    historyWindow: HistoryWindow; // default 'season'
    matchupWeight: number;      // 0..2, step 0.1, default 1
    streaks: boolean;           // default false
    homeFieldPts: number;       // range/default from config (start: 0..4, default 1.5)
    conditionsWeight: number;   // 0..2, step 0.1, default 1  (D2)
    script: Record<Side, ScriptTilt>;
  };
  /** Turn whole adjustment modules on/off (each backtested separately, §9.7). */
  adjustments: {
    injuries: boolean;
    weather: boolean;
    venue: boolean;
    rest: boolean;
  };
}

export interface ScriptTilt {
  pace: number;     // -1 (slowest) .. +1 (fastest), default 0; mapped to sec/play via config
  passRate: number; // -1 (run-heavy) .. +1 (pass-heavy), default 0; mapped to PROE shift via config
}

/** Game-specific. Saved on runs and locks, never on builds. */
export interface GameOverrides {
  venue: 'scheduled' | 'swap' | 'neutral';
  /** null = use the snapshot forecast */
  conditions: {
    windMph: number | null;
    tempF: number | null;
    precip: Precip | null;
    roof: 'open' | 'closed' | null;   // only honoured for retractable roofs
  };
  /** Absent = snapshot status (questionable -> per-sim mixture). */
  roster: Record<PlayerId, 'in' | 'out'>;
  usage: Record<PlayerId, { targetShare?: number; carryShare?: number }>; // deltas in share points
  customLines: CustomLine[];
}

export type Precip =
  | { kind: 'none' }
  | { kind: 'rain' | 'snow'; intensity: 'light' | 'heavy' };

export interface CustomLine {
  market: MarketKey;
  selection: string;          // 'home' | 'away' | 'over' | 'under' | 'yes' | 'no'
  playerId?: PlayerId;        // props only
  line: number | null;        // null for moneyline / yes-no
  price: AmericanOdds;
}

/** Everything needed to reproduce a run exactly. */
export interface RunRequest {
  snapshotId: SnapshotId;
  gameId: GameId;
  engineVersion: string;      // D5
  settings: SimSettings;
  overrides: GameOverrides;
  nSims: 1000 | 10000 | 50000;
  seed: number;               // uint32, already resolved
}
```

How `settings.schema.ts` defines a control once (UI, validation and defaults all read from it):

```ts
// shape only — real file will list every control
export const CONTROLS = {
  marketBlend: num({ min: 0, max: 1, step: 0.05, default: 0.5,
    group: 'lenses', label: 'Market blend',
    help: '0 = pure model, 1 = fully anchored to market prices.' }),
  historyWindow: choice({ options: ['season','L3','L4','L5','L6','L7','L8'], default: 'season',
    group: 'lenses', label: 'History window', help: '...' }),
  // ...
} as const;

export const simSettingsSchema = buildSchema(CONTROLS);   // zod object
export type SimSettings = z.infer<typeof simSettingsSchema>;
export const DEFAULT_SETTINGS: SimSettings = defaultsFrom(CONTROLS);
```

Proposed presets (values to tune after backtest):

| Preset | marketBlend | window | matchupWeight | streaks | conditionsWeight |
|---|---|---|---|---|---|
| Default (house) | 0.5 | season | 1.0 | off | 1.0 |
| Sharp | 0.8 | season | 0.7 | off | 1.0 |
| Pure Model | 0 | season | 1.0 | off | 1.0 |
| Hot Hand | 0.3 | L4 | 1.0 | on | 1.0 |
| Weatherman | 0.5 | season | 1.0 | off | 1.5 |

---

## 5. Team params

```ts
export interface TeamParams {
  team: TeamAbbr;
  window: HistoryWindow;
  games: number;                // games in the window (sample size)
  off: UnitParams;              // what the offense produces
  def: UnitParams;              // what the defense allows
  proe: number;                 // pass rate over expected, e.g. +0.04
  neutralSecPerPlay: number;    // neutral-situation pace
  noHuddleRate: number;
}

/** Opponent-adjusted (ridge), recency-weighted. Rates are per play of that type. */
export interface UnitParams {
  passEpa: number;
  runEpa: number;
  passSuccess: number;
  runSuccess: number;

  // pass play components (per dropback)
  sackRate: number;
  scrambleRate: number;
  intRate: number;              // per attempt
  completionRate: number;       // per attempt
  passYdsTilt: number;          // exponential tilt of league completion-yards histogram (D3)
  explosivePassRate: number;    // completions of 20+ yds per attempt

  // run play components
  runYdsTilt: number;
  explosiveRunRate: number;     // runs of 10+ yds
  fumbleLostRate: number;       // per play

  redZoneTdRate: number;        // TDs per red-zone trip
  penaltyYdsPerPlay: number;
}

/** Defense vs position, raw (shrinkage applied in the engine with k from config). */
export type DvpBucket = 'WR1' | 'WR2' | 'WR3' | 'TE' | 'RB';   // D7
export type DefVsPos = Record<DvpBucket, {
  targetsPerGame: number;
  yardsPerTarget: number;
  n: number;                    // targets observed
}>;
```

Combining offense and defense: rates combine additively in logit space against the league baseline (`logit(p) = logit(off) + logit(def) − logit(league)`), tilts add. Method fixed in config.

---

## 6. Player params

```ts
export type Position = 'QB' | 'RB' | 'FB' | 'WR' | 'TE' | 'K' | 'P';
export type InjuryStatus = 'active' | 'questionable' | 'doubtful' | 'out' | 'ir' | 'inactive';

export interface PlayerParams {
  playerId: PlayerId;
  window: HistoryWindow;
  games: number;
  snapShare: number;
  routeShare: number;           // routes run / team dropbacks (estimated from snaps + pbp)
  targetShare: number;
  airYardsShare: number;
  carryShare: number;
  rzTargetShare: number;
  rzCarryShare: number;
  glCarryShare: number;         // inside the 5
  catchRate: number;
  yardsPerTarget: number;
  recYdsTilt: number;           // tilt of league completion-yards histogram for this receiver
  yardsPerCarry: number;
  rushYdsTilt: number;
  qb?: QbParams;
  kicker?: KickerParams;
}

export interface QbParams {
  dropbacks: number;
  completionRate: number;       // over expected is derived vs league in applySettings
  yardsPerAttempt: number;
  passYdsTilt: number;
  sackRate: number;
  intRate: number;
  scrambleRate: number;
  designedRunShare: number;     // QB share of team designed carries
}

export interface KickerParams {
  fgAttempts: number;
  fgMakeOverExpected: number;   // vs config FG curve, shrunk
  xpRate: number;
}

/** One entry per player on an active roster this slate. */
export interface PlayerEntry {
  playerId: PlayerId;
  name: string;
  team: TeamAbbr;
  position: Position;
  depth: number;                // 1 = starter at his position (nflverse depth chart)
  dvpBucket: DvpBucket | null;  // role used for matchup (D7)
  status: InjuryStatus;
  playProb: number;             // from status via config; used for the questionable mixture
  params: Partial<Record<HistoryWindow, PlayerParams>>;  // missing window = too few games
  replacementDelta: number | null;  // starter efficiency minus next man up (EPA/play), §9.6
}
```

---

## 7. Slate snapshot

```ts
export interface SlateSnapshot {
  schemaVersion: 1;
  id: SnapshotId;               // '2026-W09-v3'
  season: number;
  week: number;
  seasonType: 'REG' | 'POST';
  version: number;
  createdAt: string;            // ISO
  configHash: string;           // hash of model_config.json used by the pipeline
  dataAsOf: { nflverse: string; injuries: string; odds: string | null; weather: string | null };
  league: Record<HistoryWindow, LeagueParams>;
  teams: Record<TeamAbbr, TeamEntry>;
  players: Record<PlayerId, PlayerEntry>;
  games: SnapshotGame[];
}

export interface LeagueParams {
  /** Integer-yard histograms; probs[i] = P(yards = min + i). Last bin = "this many or more". */
  completionYds: YardHistogram;
  runYds: YardHistogram;
  scrambleYds: YardHistogram;
  sackYds: YardHistogram;
  puntNetYds: YardHistogram;
  kickReturnYds: YardHistogram;
  rates: UnitParams;            // league average, same fields as team units
  passRateByDownDist: number[][];  // expected pass rate grid [down][distance bucket]
  dvp: DefVsPos;                // league average, the shrinkage target
}

export interface YardHistogram { min: number; probs: number[] }

export interface TeamEntry {
  team: TeamAbbr;
  params: Record<HistoryWindow, TeamParams>;
  dvp: Record<HistoryWindow, DefVsPos>;
  depthChart: Partial<Record<Position, PlayerId[]>>;  // ordered, starter first
  olInjuryCount: number;        // starters out; config weights turn this into an adjustment
  secondaryInjuryCount: number;
  form: TeamForm;               // streak features, only read when streaks lens is on
}

export interface TeamForm {
  winStreak: number;            // + wins, − losses
  atsStreak: number;
}

export interface SnapshotGame {
  gameId: GameId;
  kickoff: string;              // ISO
  home: TeamAbbr;
  away: TeamAbbr;
  status: 'scheduled' | 'in_progress' | 'final';   // in_progress/final are excluded from pricing
  neutralSite: boolean;
  stadium: StadiumFacts;
  weather: WeatherForecast | null;   // null for domes
  context: {
    restDays: Record<Side, number>;
    awayTravelMiles: number;
    awayTzShift: number;        // hours
  };
  market: MarketLine[];         // empty until step 6
  marketUsage: Record<PlayerId, MarketUsage>;   // empty until step 6
}

export interface StadiumFacts {
  stadiumId: string;
  name: string;
  lat: number;
  lon: number;
  roof: 'outdoors' | 'dome' | 'retractable';
  surface: 'grass' | 'turf';
  altitudeFt: number;
  tz: string;                   // IANA
}

export interface WeatherForecast {
  source: 'nws' | 'open-meteo';
  windMph: number;              // sustained
  gustMph: number | null;
  tempF: number;
  precip: Precip;
  roofExpected: 'open' | 'closed' | null;   // retractable only
}

export type MarketKey =
  | 'h2h' | 'spreads' | 'totals' | 'team_totals'
  | 'h2h_h1' | 'spreads_h1' | 'totals_h1'
  | 'player_pass_yds' | 'player_pass_tds' | 'player_pass_attempts' | 'player_pass_completions'
  | 'player_pass_interceptions' | 'player_rush_yds' | 'player_rush_attempts'
  | 'player_receptions' | 'player_reception_yds' | 'player_anytime_td';
// Odds API market keys, so fetch_odds.py needs no mapping.

export type AmericanOdds = number;

export interface MarketLine {
  market: MarketKey;
  selection: string;            // 'home' | 'away' | 'over' | 'under' | 'yes' | 'no'
  playerId?: PlayerId;
  line: number | null;
  prices: { book: string; price: AmericanOdds }[];
  best: { book: string; price: AmericanOdds };
  noVigProb: number | null;
  noVigSource: 'pinnacle' | 'consensus' | null;
}

export interface MarketUsage {
  receptions?: number;          // implied means
  receivingYds?: number;
  rushAttempts?: number;
  passAttempts?: number;
  impliedTargetShare?: number;
  impliedCarryShare?: number;
  roleChange: boolean;          // |implied − historical| > config threshold
}
```

Size estimate: 7 windows × 32 teams × ~30 numbers, plus ~14 games × ~45 players × 7 windows × ~20 numbers ≈ 100k numbers → roughly 300–500 KB gzipped. Within the 1 MB target. Players on bye-week teams are left out.

---

## 8. Game state

```ts
export interface GameState {
  quarter: 1 | 2 | 3 | 4 | 5;   // 5 = overtime
  clockSec: number;             // seconds left in the quarter
  clockRunning: boolean;        // false after incompletions, out-of-bounds, scores, timeouts
  phase: 'kickoff' | 'scrimmage' | 'pat' | 'final';
  possession: Side;
  down: 1 | 2 | 3 | 4;
  distance: number;             // yards to first down (goal-to-go = 100 − yardline)
  yardline: number;             // from offense's own goal line, 1..99
  score: Record<Side, number>;
  timeouts: Record<Side, number>;
  secondHalfReceiver: Side;
  ot: OvertimeState | null;
  driveIndex: number;
  playIndex: number;
}

/** Current NFL rules (2025+): 10-minute OT, both teams get a possession unless the first
 *  ends in a defensive score; then sudden death; regular-season ties allowed. Rules in config. */
export interface OvertimeState {
  firstPossession: Side;
  possessed: Record<Side, boolean>;
  suddenDeath: boolean;
}
```

---

## 9. Play outcome and per-sim result

```ts
interface OutcomeBase {
  clockSec: number;             // time this play took off the clock (incl. runoff before snap)
  stopsClock: boolean;
  timeoutBy?: Side;
}

export type PlayOutcome = OutcomeBase & (
  | { kind: 'pass'; result: 'complete' | 'incomplete';
      passer: PlayerId; target: PlayerId; yards: number; outOfBounds: boolean;
      fumbleLost: boolean; td: boolean }
  | { kind: 'interception'; passer: PlayerId; target: PlayerId;
      returnYards: number; defensiveTd: boolean }
  | { kind: 'sack'; passer: PlayerId; yards: number; fumbleLost: boolean; safety: boolean }
  | { kind: 'scramble'; passer: PlayerId; yards: number; outOfBounds: boolean;
      fumbleLost: boolean; td: boolean }
  | { kind: 'run'; rusher: PlayerId; yards: number; outOfBounds: boolean;
      fumbleLost: boolean; td: boolean; safety: boolean }
  | { kind: 'punt'; punter: PlayerId; netYards: number; touchback: boolean; returnTd: boolean }
  | { kind: 'fieldGoal'; kicker: PlayerId; distance: number; made: boolean }
  | { kind: 'kickoff'; touchback: boolean; receiveYardline: number; returnTd: boolean }
  | { kind: 'pat'; type: 'kick' | 'twoPoint'; success: boolean }
  | { kind: 'kneel' }
  | { kind: 'spike' }
  | { kind: 'penalty'; against: 'offense' | 'defense'; yards: number;
      automaticFirstDown: boolean; replayDown: boolean }
);

/** Only produced when Replay asks for it (re-sim of one sim index, D6). */
export interface PlayRecord { before: GameState; outcome: PlayOutcome }

/** What each simulated game returns to aggregation (compact; no play list). */
export interface SimGameResult {
  simIndex: number;
  final: Record<Side, number>;
  firstHalf: Record<Side, number>;
  overtime: boolean;
  plays: number;
  team: Record<Side, { passAtt: number; rushAtt: number; yards: number; turnovers: number }>;
  /** Flat stat lines for players who recorded anything. */
  players: PlayerGameLine[];
}

export interface PlayerGameLine {
  playerId: PlayerId;
  passAtt: number; passCmp: number; passYds: number; passTd: number; passInt: number;
  rushAtt: number; rushYds: number; rushTd: number;
  targets: number; rec: number; recYds: number; recTd: number;
}
```

`aggregate.ts` (step 7) turns a stream of `SimGameResult` into histograms and prices. Internally the engine fills preallocated typed arrays and only builds these objects at the boundary.

---

## 10. `model.config.ts` vs snapshot

`model.config.ts` (hand-edited, exported to `pipeline/model_config.json`):
- **Fitting:** recency decay half-life, history windows list, ridge lambda, minimum games per window, shrinkage `k` for DvP and player efficiency
- **Engine structure:** off/def combination method, play-call model coefficients (score, clock, field position), script-tilt mapping (tilt → PROE shift, tilt → sec/play), penalty rates, fumble recovery rate
- **4th-down table**, 2-point decision table, timeout and kneel rules
- **Special teams:** FG make curve by distance, wind/cold adjustments, XP rate, touchback rate, onside rate
- **Clock and rules:** quarter length, OT rules, 2-minute drill behaviour, runoff by play type
- **Injuries:** play probability by status, QB replacement prior, OL/secondary weights
- **Weather/venue/rest:** wind start (12 mph) and full (25 mph), precip effects, cold threshold (25°F), altitude, short week, bye, travel
- **Markets and pricing:** edge tiers (3/5/8%), Kelly fraction (0.25), Kelly cap, role-change threshold, volume-prop market-blend threshold, Odds API credit floor, lock rate limit
- **User-control ranges** are *not* here — they live in `settings.schema.ts`. Home-field range is the one exception the brief puts in config; the schema imports it.

Snapshot `league` block (fitted, versioned): yardage histograms, league-average rates, expected pass rate grid, league DvP.

---

## After approval

Step 1 lands as one commit (scaffold + config + RNG + tests + CI). I'll then pause briefly with a summary before starting step 2.
