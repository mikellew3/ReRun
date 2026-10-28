# ReRun Betting Simulator — Project Brief

> "Every game, 10,000 times. Your way."

ReRun is a GMDHC property where users run their own NFL game simulations. They pick a matchup, set the roster, conditions and model "lenses", and run thousands of sims in their browser. ReRun prices game lines and player props from the simulated outcomes and compares them to the market. Users can save a setup as a **build**, lock picks from it, and climb a **build leaderboard** graded on real results. A **house build** with default settings runs every slate to keep a public track record.

Football first; the engine is designed so other sports can be added later.

Owner: Mike Llewellyn (GMDHC). Read this whole file before starting any task.

---

## 1. Working conventions (non-negotiable)

- **Always output complete file contents** when creating or changing a file. Never partial edits, diffs or snippets in responses to Mike.
- **All tunable numbers live in config, never hard-coded.** Engine constants, user-control ranges and defaults, presets, edge cutoffs, Kelly fraction — all in `engine/src/config/`. Mike wants one editable place for rules.
- **Deterministic simulations.** Every sim run takes a seed; same data snapshot + same settings + same seed = identical output. Store all three with every saved run.
- **No model feature ships without a backtest result** showing it doesn't hurt calibration (see §9).
- Low cost is a hard requirement. Sims run in the user's browser. No always-on servers. No paid services beyond The Odds API and the existing Vercel/Supabase accounts.
- Keep the code boring and readable. Plain functions and typed data over clever abstractions.

## 2. Stack

| Layer | Tech | Where it runs |
|---|---|---|
| Data pipeline | Python 3.12 + `nflreadpy` + `pandas` | GitHub Actions (scheduled) |
| Sim engine | TypeScript library (no DOM deps) | **User's browser** (Web Worker), plus GitHub Actions (Node 20) for the house build, backtests and pick verification |
| Database + auth | Supabase (Postgres, magic-link auth) | existing GMDHC account |
| Front end | Vite + React + TypeScript | Vercel |
| Scheduling | GitHub Actions cron | free minutes |

The sim engine is written **once**, in TypeScript, and shared everywhere. Python only fetches data and fits parameters.

## 3. Repo layout

```
rerun/
├── CLAUDE.md
├── engine/                     # TS sim library (shared)
│   ├── src/
│   │   ├── config/
│   │   │   ├── model.config.ts     # fixed engine constants (not user-editable)
│   │   │   ├── settings.schema.ts  # user-controllable SimSettings: ranges, defaults, validation (zod)
│   │   │   └── presets.ts          # Sharp, Pure Model, Hot Hand, etc.
│   │   ├── types.ts
│   │   ├── rng.ts               # seeded PRNG (e.g. xoshiro128**)
│   │   ├── play.ts              # single-play outcome model
│   │   ├── drive.ts             # drive loop
│   │   ├── game.ts              # full game loop, clock, halves, OT
│   │   ├── specialTeams.ts      # FG, punts, kickoffs
│   │   ├── usage.ts             # target/carry allocation
│   │   ├── adjust/              # injuries, weather, venue, rest, matchup, form
│   │   ├── applySettings.ts     # SimSettings + data snapshot -> engine inputs
│   │   ├── aggregate.ts         # sims -> distributions -> market prices
│   │   └── pricing.ts           # no-vig, edge, Kelly
│   └── test/
├── jobs/                       # Node entrypoints that run the engine in batch
│   ├── houseRun.ts
│   ├── verifyLocks.ts
│   ├── gradePicks.ts
│   └── backtest.ts
├── pipeline/                   # Python data jobs
│   ├── fetch_nflverse.py
│   ├── fetch_odds.py
│   ├── fetch_weather.py
│   ├── fit_team_params.py
│   ├── fit_player_params.py
│   ├── market_usage.py
│   ├── build_snapshot.py        # writes the versioned data snapshot the browser loads
│   └── stadiums.csv             # static: lat/lon, roof, surface, altitude, tz
├── web/                        # Vite React app
├── supabase/migrations/
└── .github/workflows/
```

## 4. Configuration

Two kinds of settings, kept strictly separate:

### 4.1 Engine constants (`model.config.ts`) — fixed, not user-editable
Play-outcome distributions, fourth-down table, FG model, clock rules, base recency decay, matchup shrinkage constant, weather impact curves, injury replacement priors, edge tiers, Kelly cap. Exported to `pipeline/model_config.json` by `jobs/exportConfig.ts` so Python reads the same values.

### 4.2 User settings (`settings.schema.ts`) — the `SimSettings` object
Every user-controllable value is defined once here with type, min, max, step, default, label and help text. The UI renders controls from this schema, so adding a control means editing one file. Validate with zod everywhere a `SimSettings` is read (browser, verify job, database writes).

See §7 for the full list.

## 5. Data sources

| Data | Source | Notes |
|---|---|---|
| Play-by-play, rosters, weekly rosters, depth charts, injuries, snap counts, player stats, schedules | nflverse via `nflreadpy` | free; updated nightly in season |
| Historical closing spreads/totals/moneylines | nflverse schedules (`spread_line`, `total_line`, moneylines) | free; used for backtests — do NOT buy historical odds |
| Current game lines + player props | The Odds API | key `ODDS_API_KEY`, server-side only; regions `us,eu` (eu gives Pinnacle); props via per-event endpoint |
| DraftKings + FanDuel line movement | SharpAPI free tier (`api.sharpapi.io`) | key `SHARPAPI_KEY`, server-side only; 2 books, 60s delayed, 12 requests/min; polled every 30 min by `.github/workflows/lines.yml`. Betting splits need its paid Pro tier (not used). Pinnacle comes from The Odds API at config `oddsApi.sharpPullHoursUtc` |
| Weather | National Weather Service API (`api.weather.gov`) | free; forecast by stadium lat/lon; international games fall back to Open-Meteo |
| Stadium facts | `pipeline/stadiums.csv` | maintained by hand |

**The browser never calls an outside data API.** It only reads the published data snapshot (§6) and Supabase. User clicks never spend Odds API credits.

**Odds API budget:** credits = markets × regions per call. Log `x-requests-remaining` and `x-requests-last` on every call to `api_usage`; abort a job if remaining credits fall below a config floor. Target well under 1,500 credits/month in season.

Env vars: `ODDS_API_KEY`, `SHARPAPI_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (jobs only); `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (web).

## 6. Data snapshots

The pipeline publishes a **versioned slate snapshot**: one compact JSON per slate containing everything the engine needs (team params, player params, depth charts, injuries, weather, stadium facts, market lines and market-implied usage). Store it in Supabase Storage with an id like `2026-W09-v3`.

- The browser downloads the snapshot once per session (target under 1 MB gzipped per slate) and caches it.
- Every saved run and locked pick records the snapshot id, so any result can be reproduced exactly.
- A new snapshot version is published on each scheduled refresh (§11); old versions are kept.

## 7. User controls (`SimSettings`)

### 7.1 Game setup
- Matchup (from the current slate)
- Venue: as scheduled / swap / neutral
- Sim count: 1,000 / 10,000 / 50,000 (default 10,000)
- Seed: auto, or user-entered for reproducibility

### 7.2 Lines to test
- Spreads, totals, moneylines, team totals and props are pre-filled from the snapshot's market prices
- User can enter any custom line and price (e.g. "KC −2.5 at −115")
- Custom lines are allowed for analysis but **not leaderboard-eligible** (§8)

### 7.3 Roster
- Mark any player in or out (QB swap included); "questionable" players default to a probability-weighted mixture, and the user can force in or out
- Usage sliders: nudge a player's target or carry share up or down; the engine renormalizes teammates so team totals still add up
- Shown next to each slider: historical share and market-implied share

### 7.4 Conditions
- Wind (mph), temperature (°F), precipitation (none / light / heavy, rain or snow)
- Roof open/closed where applicable
- Defaults come from the forecast in the snapshot

### 7.5 Model lenses
- **Market blend** — 0 (pure model) to 1 (fully anchored to the market)
- **History window** — season-long vs. last N games (N from 3 to 8)
- **Matchup weight** — how strongly defense-vs-position adjustments apply (0 to 2×)
- **Streaks** — on/off (off by default; see §10.5)
- **Home-field value** — in points equivalent, range from config
- **Game script tilt** — pace (slower/faster) and pass-rate tilt (run-heavy to pass-heavy), per team

### 7.6 Presets (`presets.ts`)
- **Sharp** — high market blend, season-long window, moderate matchup weight
- **Pure Model** — market blend 0
- **Hot Hand** — short history window, streaks on
- **Weatherman** — default model with emphasis on conditions (for wind/snow games)
Presets are just named `SimSettings` objects. Users start from a preset and customize.

### 7.7 Outputs
- Win probability, margin histogram with spread overlay and visible key-number spikes (3, 7, 6, 10, 14), total histogram
- Alt-line ladder: cover probability at every half-point spread and total
- Team totals, first-half lines
- Player prop distributions with the market line overlaid
- Edge vs. no-vig market price for every line, with tier badge and suggested stake
- **Replay**: play-by-play of any single simulated game (score bug, drive chart)
- "Compare to house": show how the user's numbers differ from the house build

## 8. Builds, locked picks and the leaderboard

### 8.1 Builds
- Signed-in users (Supabase magic-link auth) can save their current `SimSettings` as a named **build** (e.g. "Mike's Wind Fade")
- Roster and usage overrides are game-specific, so they are stored per game on the run, not on the build
- Builds can be public or private; public builds can be copied by others

### 8.2 Locked picks
- From a run, the user can **lock** a pick. A lock stores: build id, game, market, selection, line, snapshot id, full settings, seed, sim count, sim probability, edge
- **Line and price for the leaderboard come from the server snapshot, never from the client**
- Locks are only accepted before kickoff, and only on the current snapshot version

### 8.3 Verification (anti-tampering)
- Sims run in the browser, so the client is untrusted
- `jobs/verifyLocks.ts` re-runs every new lock deterministically (same snapshot, settings, seed, sim count) and checks the stored sim probability. Mismatches are rejected and removed from the leaderboard
- Rate-limit locks per user per slate (config)

### 8.4 Grading and leaderboard
- After games, `jobs/gradePicks.ts` grades every verified lock, records closing price and CLV
- Leaderboard ranks builds (minimum pick count from config) by ROI, units, and CLV, with filters by market type and season
- The house build appears on the leaderboard like any other build

### 8.5 House build
- `jobs/houseRun.ts` runs the default settings on every game at each final pre-kickoff snapshot and locks picks that clear the edge tiers
- This is ReRun's public track record and the baseline for "compare to house"

## 9. The model

### 9.1 Team parameters (`fit_team_params.py`)
For each team, offense and defense separately, recency-weighted:
- Pass and run EPA/play, success rate
- Yards-per-play distributions (empirical, by play type, with explosive-play rate)
- Pass rate over expected (PROE) and neutral-situation pace
- Sack, INT and fumble rates; red-zone TD rate
- Opponent-adjusted (ridge regression over the season's games)
- The pipeline publishes params for each history window the UI allows (§7.5), so the browser just picks one

### 9.2 Player parameters (`fit_player_params.py`)
- QB: completion %, YPA, sack/INT tendencies, scramble rate
- Skill players: snap share, route participation, target share, air-yards share, carry share, red-zone/goal-line share, yards per target, yards per carry, catch rate
- Published per history window, like team params

### 9.3 Market-implied usage (`market_usage.py`)
- De-vig each over/under (Pinnacle preferred, else median of books)
- Convert line + no-vig probability to an implied mean: Poisson for receptions/attempts/carries; negative binomial if overdispersion fits better in backtest
- Implied team volume = sum across players; implied shares = player / team
- The engine blends market and historical shares using the user's market-blend lens
- **Role-change flag** when market-implied and historical shares differ by more than a config threshold — surface in the UI

**Circularity rule:** when market blend is high, volume props (receptions, attempts, carries) mostly echo the market. The UI labels these as "market-anchored" and they are **not leaderboard-eligible above a config market-blend threshold**. Yardage props, TD props, alt lines, team totals and sides/totals are always eligible.

### 9.4 Opponent matchup (general and positional)
- General: opponent-adjusted team efficiency (§9.1)
- Positional: defense vs. position — yards/target and targets allowed to WR1/WR2/slot/TE/RB
- Shrink toward league average: `adjusted = (n × observed + k × league_avg) / (n + k)`, `k` in config
- Applied as multipliers on player efficiency, scaled by the user's matchup-weight lens

### 9.5 Form and streaks
- Recency weighting captures genuine form
- Explicit streak features (win streaks, ATS streaks, player over/under hit runs) are historically weak NFL predictors and already priced by markets
- Available as a user lens (off by default). The house build uses them only if the backtest shows improved log loss or CLV. Report the result either way

### 9.6 Injuries
- Status from nflverse injuries + inactives
- Each player has a replacement-level delta: starter efficiency minus the next man up on the depth chart
- QB adjustment is largest; use the backup's own data where available, else a replacement-level prior
- When a skill player is out, redistribute his usage to teammates proportionally to existing shares, adjusted by depth-chart position
- OL and secondary injuries: modest efficiency adjustments with config weights
- Questionable players: probability-weighted mixture across runs unless the user forces in/out

### 9.7 Situational adjustments
Weather, venue, rest and travel as separate pure functions in `engine/src/adjust/`, each toggleable and backtested on its own. Defaults: weather effects start at 12 mph sustained wind and scale through 25 mph; FG probability adjusted by wind and distance; heavy precipitation lowers completion % and raises fumble rate; sub-25°F small penalty; domes/closed roofs disable weather; Denver altitude small visitor penalty; short week, bye and long travel adjustments.

## 10. Simulation engine

### 10.1 Granularity
Play-level, kept lean:
- **Play call:** pass/run from team PROE adjusted for down, distance, field position, score, clock (game script) and the user's script tilt
- **Pass play:** sack / scramble / incompletion / completion / INT; receiver chosen by target share; yards from his distribution adjusted by matchup and weather
- **Run play:** carrier by carry share; yards from distribution
- **Fumbles, penalties:** low-rate events from config
- **Fourth down:** go/punt/FG from a table on yards to go, field position, score, time
- **Special teams:** FG make probability by distance, wind and kicker; punt net yards; kickoffs/touchbacks
- **Clock:** pace by situation, two-minute drill, kneel-downs, current NFL overtime rules

### 10.2 Calibration
With default settings, the engine must reproduce league reality on historical games:
- Final margin distribution, **including spikes at 3, 7, 6, 10, 14**
- Totals distribution
- Plays per game, pass rate, yards per play
- Starter stat distributions
Tests in `engine/test/calibration.test.ts`, required to pass in CI.

### 10.3 Performance targets
- 10,000 sims of one game in **under 5 seconds** in a mid-range phone browser Web Worker (stream progress so the histogram fills in live)
- 50,000 sims allowed on desktop; warn on mobile
- House run of a full slate in under 5 minutes on a GitHub Actions runner

### 10.4 Pricing and picks (`pricing.ts`)
- No-vig market probability from Pinnacle when present, else consensus
- Edge = sim probability − no-vig probability, also shown as EV at the best available price
- Tiers from config (start: ≥3% lean, ≥5% play, ≥8% strong)
- Suggested stake: quarter-Kelly, capped by config
- Games in progress at snapshot time are excluded

## 11. Scheduling (GitHub Actions)

The background work is small — it only keeps data fresh and runs the house build:
- **Nightly (in season):** pull nflverse, refit params
- **Twice daily (morning and evening):** odds + weather → publish new snapshot
- **Friday afternoon:** final injury report → publish snapshot
- **~75 minutes before each kickoff window (Thu, Sun early/late/night, Mon):** inactives + odds + weather → final snapshot → house run → house locks
- **Every 15 minutes on game days, and hourly otherwise:** `verifyLocks.ts` on new locks
- **After games:** `gradePicks.ts` grades locks, records closing prices and CLV, refreshes leaderboard

Every workflow checks the Odds API credit floor before calling it.

## 12. Database (Supabase)

Migrations in `supabase/migrations/`. Row level security on all tables.
- `games` — id, season, week, kickoff, home, away, stadium, roof, surface
- `snapshots` — id, slate, version, storage_path, created_at
- `odds_snapshots` — game, book, market, selection, line, price, captured_at
- `profiles` — user id, display name
- `builds` — id, owner, name, settings jsonb, is_public, is_house, created_at
- `runs` — id, user, build (nullable), game, snapshot, settings jsonb, overrides jsonb, seed, n_sims, summary jsonb, created_at (saved runs only; unsaved runs stay in the browser)
- `locks` — id, user, build, run, game, market, selection, line, price (from snapshot), sim_prob, edge, tier, stake, status (pending / verified / rejected), locked_at
- `results` — lock, closing_price, clv, outcome (win / loss / push / void), graded_at
- `leaderboard` — materialized view over builds + locks + results
- `api_usage` — provider, credits_used, credits_remaining, called_at
- `backtests` — id, git_hash, config_hash, report jsonb, created_at

Users read public data and their own rows. Only jobs, with the service role key, write snapshots, verification status, results and house locks.

## 13. Front end (`web/`)

Design: **ReRun design system v1.0** (Mike's design canvas, replacing the original dark IBM Plex terminal look). Calm, premium, simple, a consumer finance app, not a sportsbook. Plus Jakarta Sans for everything (no monospace; tabular figures for numbers), white ground with warm neutrals, copper as the single highlight (#B87333 fills, #9A5B24+ for copper text), soft card shadows instead of heavy borders, 44px touch targets, Lucide-style outlined icons, no gradients, no emoji. All values live in `web/src/tokens.css` (`--rr-*`). Mobile-first.

Pages:
1. **Slate** — every game this week with market lines, weather, injury and role-change flags, and the house build's numbers; tap a game to open the Sim Lab
2. **Sim Lab** — the core screen: controls panel built from `settings.schema.ts` (preset picker, roster, conditions, lenses, lines to test), Run button, live-filling histograms, alt-line ladder, prop distributions, edges, lock buttons, compare-to-house
3. **Replay** — play-by-play of a single simulated game
4. **My Builds** — saved builds, locked picks, results, CLV
5. **Leaderboard** — public builds ranked by ROI, units and CLV, filterable; copy a build
6. **Track Record** — the house build's full history
7. **Methodology** — plain-language explanation of the model and what each control does

Footer: responsible-gambling note and 21+ notice.

## 14. Backtesting (`jobs/backtest.ts`)

- Seasons 2022–2025, walk-forward: fit using only data available before each week
- Compare default-settings sim probabilities to closing-line implied probabilities from nflverse schedules
- Metrics: log loss and Brier score vs the market, calibration curve, ATS and totals record of edges above each tier, average CLV
- Also backtest each preset, so the Methodology page can show honest numbers for each
- Each report saved to `backtests/` and the `backtests` table with date, git hash and config snapshot
- Props: no historical prop odds are purchased; props are forward-tested from launch

## 15. Build phases

### Phase 1 — Engine, data and backtest (current phase)
1. Repo scaffold, CI, config system (`model.config.ts`, `settings.schema.ts`, `presets.ts`), seeded RNG
2. `pipeline/`: nflverse fetch, stadium table, team + player params per history window
3. Engine: play, drive, game, special teams, usage, `applySettings`
4. Calibration tests passing (§10.2)
5. Adjustments: injuries, weather, venue, rest, matchup, streaks (each toggleable)
6. Odds API fetch with credit logging, market-implied usage, snapshot builder
7. Pricing, edges, tiers
8. Walk-forward backtest 2022–2025 for defaults and each preset
**Done when:** calibration tests pass, backtest reports exist, and a snapshot for the current week loads and sims correctly in a Node script.

### Phase 2 — Sim Lab (single user, no accounts)
Slate page, Sim Lab with all controls and outputs, Web Worker engine, Replay, Methodology.

### Phase 3 — Accounts, builds and house track record
Supabase auth, saved builds and runs, locks, verify and grade jobs, house run, Track Record page.

### Phase 4 — Leaderboard and polish
Public builds, leaderboard, copy-a-build, optional social card export.

Plan for 2026: Phases 1–2 now, Phase 3 in time to forward-test the house build privately through the playoffs; public launch with the leaderboard for the 2027 season.

## 16. How to start

Begin Phase 1, step 1. Before writing code, propose the file list for steps 1–3 and the TypeScript types for `SimSettings`, team params, player params, the slate snapshot, game state and play outcome, and wait for Mike's OK.
