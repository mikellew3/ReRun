# Situational adjustments (Phase 1, step 5)

Status: **in the engine from `0.3.0`**. Injuries, weather, venue and rest are on by default. Defense-vs-position matchups and streaks are lenses, off by default. Calibration still passes 55/55 (see [calibration.md](calibration.md)).

The brief (§9.4–9.7) lists the adjustments and says each must be toggleable and backtested on its own. Every adjustment here is a pure function in `engine/src/adjust/`, and every number it uses lives in `model.config.ts`. Each number was measured from 2022–2025 data rather than guessed.

## Where the numbers come from

`pipeline/measure_adjustments.py` measures every effect. It writes `docs/adjustments.json`.

- **Weather.** The data is per-play results in outdoor games. Each play is compared with what its offense and defense averaged that season, so a windy city's weak passing team doesn't read as a wind effect. Effects are fitted jointly for wind (ramping from 12 to 25 mph), rain, snow and cold (under 25°F).
- **Backup QBs.** These are dropbacks by anyone other than the team's main QB that season (16,926 dropbacks), adjusted for the defense faced.
- **Line injuries.** These come from snap counts. A starter counts as missing if he played under a quarter of the snaps, where starters are the top 5 linemen and top 4 defensive backs by season snaps. Each game is compared with the same team's other games.
- **Usage.** When a player with a big share misses a game, the script measures how much of his share his position group picks up.
- **Rest, travel, altitude, streaks.** Closing spreads for 1,087 games are regressed on these factors, with each team's rating held fixed per half-season. Closing lines are the best available estimate of what these factors are worth. Results are checked too, but at about 13 points of noise per game they can't pin down effects this small.

The rule for weather: keep an effect at its measured value if it is at least 1.5 standard errors from zero, else set it to 0. FG wind is kept at its estimate anyway, because wind obviously hurts long kicks.

## What each adjustment does

### Injuries (`adjust/injuries.ts`, switch: `adjustments.injuries`)

| Effect | Value | Measured |
|---|---|---|
| Backup QB vs league average | completion −0.10 logit, sacks +0.13, INTs +0.25, −0.59 yds/completion | same (EPA/dropback −0.127) |
| Each OL starter out | sacks +0.02 logit, −0.07 yds/carry | +0.021 (se 0.021), −0.074 (se 0.035) |
| Each secondary starter out | opponent completions +0.04 logit | +0.042 (se 0.013) |
| Out player's targets kept by his position group | WR 80%, TE 55%, RB 53% | proportional reallocation would keep 50% / 8% / 5% |
| Out RB's carries kept by other RBs | 99% | proportional would keep 77% |

- **QB swaps.** The pipeline shrinks every QB's numbers toward league average. For a QB starting in place of the usual starter, the engine moves that prior to backup level, with the same shrinkage weight. A backup with no data plays exactly at backup level. A veteran with thousands of dropbacks is mostly himself. Before this step, a backup with no data played like the starter.
- **Usage.** The kept share is split evenly across the available players at the position. The backups take the snaps, so the WR2 doesn't simply absorb the WR1's targets in proportion. The rest goes to everyone else in proportion to their shares.
- **Brief vs data.** The brief expected heavy precipitation to raise fumbles. No such effect was found (+0.0001 per play, se 0.0011), so there isn't one.

### Weather (`adjust/weather.ts`, switch: `adjustments.weather`, lens: `conditionsWeight`)

| Condition | Completion (logit) | Yds/completion | Yds/carry | FG (logit) |
|---|---|---|---|---|
| Full wind (25+ mph; ramps from 12) | −0.17 | 0 (measured −0.64, se 0.49) | 0 | −0.57 at 45 yds, scaling with distance |
| Light rain or snow | −0.08 | −0.48 | −0.22 | 0 |
| Heavy rain or snow | −0.16 | −0.96 | −0.44 | 0 |
| Cold (under 25°F) | 0 | −0.79 | 0 | 0 |

- **Heavy = 2 × light.** This is an assumption: play-by-play doesn't record how hard it rained.
- **Snow** had too few plays to measure on its own, so it uses the rain values.
- **Domes and closed roofs** have no weather.
- **The `conditionsWeight` lens** scales every effect (the Weatherman preset uses 1.5).
- **Historical snapshots now carry game-time weather** from nflverse (`source: 'observed'`), standing in for the forecast a live snapshot will carry (step 6). Live snapshots carry none until then.

### Venue (`adjust/venue.ts`, switch: `adjustments.venue`)

- **Altitude:** visitors at 5,000 ft or higher lose **0.4 points**. Closing spreads charge 0.41 (se 0.69). Results show 3.1 (se 2.7) over 34 Denver games.
- **Swap and neutral venues.** Altitude applies only at the scheduled site. Home field (the `homeFieldPts` lens) follows the venue setting: as scheduled, swapped, or none at a neutral site. Closing spreads price home field at 1.63 points; the default lens stays 1.5.

### Rest and travel (`adjust/rest.ts`, switch: `adjustments.rest`)

| Factor | In the engine | Closing spreads | Results |
|---|---|---|---|
| Coming off a bye | +0.7 pts | +0.70 (se 0.29) | +1.4 (se 1.4) |
| Rest-day gap, non-bye games | 0 | +0.01/day (se 0.17) | +0.23 (se 0.76) |
| Away team travels 2,000+ miles | 0 | −0.61 (se 0.40) | −2.4 (se 1.8) |
| Time-zone change, per hour | 0 | +0.08 (se 0.11) | −0.32 (se 0.50) |

- **Short weeks.** The brief expected a short-week penalty. Only one game in four seasons had one team on short rest and the other not, so the rest-day gap replaces it.
- **Zero-valued factors** stay in config, so they can be switched on if new data says otherwise.
- **How points are applied.** Points of advantage are split half to the team's offense and half against the opponent's, through `pointsToEfficiency`, like home field.

### Matchups (`adjust/matchup.ts`, lens: `matchupWeight`, default 0)

- **The idea.** A defense's targets and yards allowed to WR1, WR2, WR3, TEs and RBs are compared with its overall pass defense, against the league's pattern. Only the pattern counts, because the overall level is already in the team numbers. Each bucket is shrunk toward league (k = 60) and the result is raised to the lens power.
- **Why it's off by default.** A defense's split in weeks 1–9 tells you nothing about weeks 10–18: the correlations are 0.003 for target share and 0.017 for yards per target, across 640 defense-buckets. That implies a shrinkage constant in the thousands, meaning the splits are noise.
- **The on/off check agrees.** Turning matchups on made player predictions worse: receiving-yards error went up by 10.3 (se 3.5).
- **The lens stays** for users who want it, and the Hot Hand preset turns it on.
- **Brief vs data.** The brief described Sharp as having "moderate matchup weight". It now has none.

### Streaks (`adjust/form.ts`, lens: `streaks`, default off)

- **When on:** 0.25 points per game of a team's win or losing streak, capped at 4 games. ATS streaks get 0.
- **The evidence.** Against closing spreads, win streaks are worth +0.23 (se 0.17) and ATS streaks −0.20 (se 0.19). Neither is reliable, and the market already moves 0.38 points per game of win streak.
- **The on/off check:** turning streaks on made margins worse against the closing spread (+1.4 squared points, se 0.9).
- **House build:** streaks stay off (`houseUsesStreaks: false`).

## On/off check

`jobs/checkAdjustments.ts` sims all 184 calibration games, 400 times each, with each adjustment alone and then all together. Every variant uses the same seed, so differences come from the adjustment, not sim noise. The full output is in `docs/adjustments-check.json`.

**How to read the table.**
- **Errors** are mean squared errors (log loss for win probability).
- **Each row** is the change from all adjustments off. Negative means better. The ± is one standard error.
- **Player columns** cover non-QB skill players: 4,902 player-games against the real box scores.

| Variant | Margin vs spread | Margin vs result | Total vs line | Total vs result | Win prob log loss | Targets | Rec yds | Carries | Rush yds |
|---|---|---|---|---|---|---|---|---|---|
| All off (squared error) | 14.30 | 183.0 | 11.73 | 148.2 | 0.642 | 3.67 | 391.6 | 4.40 | 166.0 |
| Injuries | −0.29 ± 0.66 | **−5.77 ± 2.57** | **−1.64 ± 0.72** | −1.87 ± 1.90 | −0.008 ± 0.007 | **−0.118 ± 0.028** | −1.5 ± 2.4 | +0.03 ± 0.08 | +0.2 ± 1.9 |
| Weather | +0.13 ± 0.12 | 0.00 ± 0.24 | −1.15 ± 0.65 | −1.49 ± 2.06 | +0.002 ± 0.002 | 0.000 ± 0.002 | −0.3 ± 0.4 | 0.00 ± 0.00 | −0.2 ± 0.3 |
| Venue | −0.12 ± 0.09 | −0.52 ± 0.36 | +0.02 ± 0.01 | +0.06 ± 0.07 | −0.001 ± 0.001 | 0.000 ± 0.001 | −0.1 ± 0.1 | 0.00 ± 0.00 | −0.1 ± 0.1 |
| Rest | −0.38 ± 0.21 | −1.43 ± 0.76 | +0.05 ± 0.08 | +0.11 ± 0.39 | −0.003 ± 0.002 | 0.000 ± 0.002 | −0.3 ± 0.2 | 0.00 ± 0.00 | −0.3 ± 0.3 |
| Matchups (weight 1) | −0.57 ± 0.36 | −0.86 ± 1.14 | −0.37 ± 0.33 | −0.71 ± 1.31 | +0.002 ± 0.005 | **+0.068 ± 0.029** | **+10.3 ± 3.5** | **+0.03 ± 0.01** | −0.1 ± 0.6 |
| **Defaults** | −0.58 ± 0.68 | **−7.14 ± 2.64** | **−2.59 ± 0.99** | −2.84 ± 2.85 | −0.007 ± 0.007 | **−0.119 ± 0.029** | −1.4 ± 2.6 | +0.03 ± 0.08 | −0.4 ± 1.9 |
| Defaults + streaks | +1.40 ± 0.93 | −5.35 ± 3.25 | −2.64 ± 0.98 | −1.68 ± 2.95 | −0.008 ± 0.008 | −0.119 ± 0.028 | −0.8 ± 2.6 | +0.05 ± 0.08 | −0.8 ± 2.0 |

Bold marks changes of at least 2 standard errors.

**Reading it:**
- **Injuries** are the big win: QB swaps, and targets going where they really go.
- **Weather** helps totals.
- **Venue and rest** are small, and point the right way.
- **Matchups** hurt.
- **Streaks** hurt against the closing spread.
- **No default adjustment makes anything worse.**

This is 184 games. The step-8 walk-forward backtest (2022–2025, every week) will repeat the check on about 1,000 games.

## Re-running

```
cd pipeline && python measure_adjustments.py          # effects -> docs/adjustments.json
cd .. && npx tsx jobs/checkAdjustments.ts --n 400 --out docs/adjustments-check.json
npx tsx jobs/calibrate.ts                             # calibration with defaults
```

After changing any number in `model.config.ts`, bump `ENGINE_VERSION`.
