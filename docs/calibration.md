# Engine calibration (Phase 1, step 4)

Status: **all 56 checks pass** with default settings (engine `0.4.0`, CI seed 2026). Engine `0.3.0` added the step-5 adjustments (injuries, weather, venue, rest), which are on by default; see [adjustments.md](adjustments.md). Engine `0.4.0` fixed the sim scoring about 2 points a game under real NFL scoring since 2024; see [Scoring level](#scoring-level-engine-040).

The brief (§10.2) asks that, with default settings, the engine reproduce league reality on historical games. This page covers how that's checked, what had to change to get there, and the gaps that remain.

## How it's checked

- **Games.** 184 real games: weeks 4, 8, 12 and 16 of 2023, 2024 and 2025.
- **Snapshots.** Each week has a walk-forward snapshot built 90 minutes before that week's first kickoff (`pipeline/run_slate.py`), so no fitted number has seen the game being simulated.
- **Committed set.** The snapshots are trimmed to the season history window, gzipped and committed (`engine/test/fixtures/calibration/`, about 630 KB), so the test runs in CI with no network.
- **Targets.** Real-NFL numbers come from all 816 regular-season games of 2023–2025 (`pipeline/calibration_targets.py`). Every stat is defined the way the engine counts it.
- **Test.** `engine/test/calibration.test.ts` sims each game 300 times and replays 5 per game play by play. That takes about 40 seconds.
- **While tuning:** `npx tsx jobs/calibrate.ts [--seed N]` prints the full table.

## Results (seed 2026)

| Group | Check | Sim | Real | Tolerance |
|---|---|---|---|---|
| Scores | Total points, mean | 46.2 | 45.1 | ±1.5 |
| | Sim total minus actual total, same games | −0.3 | 0 | ±1.5 |
| | Total points, sd | 13.6 | 13.6 | ±1.5 |
| | Home margin vs closing spreads | 1.06 | 1.27 | ±1.0 |
| | Margin sd | 14.1 | 14.3 | ±1.5 |
| | Overtime rate | 4.7% | 5.3% | ±2 pts |
| Key numbers | Margin of 3 | 12.8% | 14.2% | ±2.5 pts |
| | Margin of 7 | 8.4% | 8.3% | ±2 pts |
| | Margin of 6 | 7.6% | 6.6% | ±1.5 pts |
| | Margin of 10 | 4.8% | 4.2% | ±1.5 pts |
| | Margin of 14 | 3.6% | 4.4% | ±1.5 pts |
| Plays | Plays per game | 126.7 | 124.4 | ±3 |
| | Yards per play | 5.29 | 5.34 | ±0.15 |
| | Pass attempt share | 55.6% | 55.0% | ±2 pts |
| | Completion rate | 63.8% | 65.0% | ±1.5 pts |
| | Turnovers per team-game | 1.23 | 1.17 | ±0.15 |
| Starters | QB pass yards (mean / sd) | 231 / 68 | 226 / 74 | ±7% / ±15% |
| | QB pass TDs | 1.50 | 1.43 | ±0.1 |
| | RB1 carries / rush yards | 14.6 / 64.1 | 15.2 / 65.9 | ±7% |
| | Top target: targets / rec / yards | 9.5 / 6.0 / 70 | 9.2 / 6.1 / 75 | ±7% |
| Market | Sim margin vs closing spread: slope | 0.94 | 1.00 | ±0.15 |
| | Correlation with closing spread | 0.842 | — | ≥ 0.8 |
| | Sim total minus closing total | +2.1 | +1.1 | ±1.5 |
| Events | Touchdowns / FG attempts / punts per game | 5.19 / 3.68 / 7.99 | 5.01 / 4.00 / 7.65 | ±0.3 / ±0.35 / ±0.6 |
| | FG rate / 4th-down go rate | 83.7% / 21.1% | 85.2% / 20.9% | |
| | 3rd-down distance | 7.40 | 6.97 | ±0.5 |
| | Penalties per game (off / def) | 6.6 / 4.4 | 6.4 / 4.5 | ±0.5 |
| Late drives | Points per drive, last 7 min, by score state | see report | | 2.5 standard errors |

The full report has the sd of every starter line and all six late-drive buckets.

## What changed to get here

Each change is backed by a measurement from 2023–2025 play-by-play, and every value lives in `model.config.ts`.

1. **Play calling.** The score and clock effects were refit by logistic regression. Leading teams run far more than trailing teams pass, so leading and trailing get separate slopes, scaled by elapsed time to the 4th power. Hurry-up is +0.99 logit, down from 1.6. *Pass share went from 59% to 56%.*
2. **Yardage histograms.** Touchdown plays are only a lower bound on how far the play would have gone, so the histograms are now Kaplan–Meier estimates of open-field gains (outside the red zone; runs exclude short yardage). Before, the engine's own goal-line cap shortened them a second time. Team and player tilts became offsets from the league average.
3. **Centering.** Each player's catch odds and yardage are now centered on the team's actual average gain and completion rate. Centering in tilt or log-odds space had pushed team averages up (yardage) or down (completions).
4. **Red zone.** Inside the 20, gains are shorter and catches less likely (`redZone`). *Red-zone TD rate went from 67% to real levels.*
5. **Passing by situation.** Early downs get more completions and fewer sacks. Late downs adjust by yards to go (`passBySituation`). On late downs, a short completion is sometimes caught at the sticks instead (`sticksCatchRate`). *Third-down conversions and punts now match.*
6. **Penalties.** The yardage mix was measured. Defensive penalties give an automatic first down 78% of the time, not 45%. Rate scales make penalties per game match.
7. **Points-to-efficiency** was rescaled so that 1 point of advantage gives 1 point of margin: home field of 4 points had produced 5.04.
8. **Late-game script.** In the last minutes, a points-equivalent shift by score bucket (`gameScript`) captures teams nursing one-score leads or tied, prevent defenses against two-score deficits, and three-score deficits fading. *This fixed the key numbers: too few 1–5-point margins and too many 9–13-point margins.*
9. **Usage.**
   - Depth-chart starters get a share bonus: +25% for the RB1's carries, +5% for targets. Both were fitted by likelihood.
   - Per-game usage noise (lognormal sd 0.15) reflects real game-to-game swings in shares.
10. **Fourth downs and two-point tries.** The go-for-it table was scaled to the real go rate, and the two-point chart was trimmed to the real try rate.
11. **Bug fix: game seeds.** Sim *i* of every game in a run used the same random stream, so games in one run were correlated. This would have mattered for slate-wide runs (house build, backtests). The run seed is now mixed with the game id (`gameSeed`).

## Known gaps (within tolerance, but systematic)

- **Punts** run about 0.5 per game high. Sim drives are slightly shorter (5.5 vs 5.9 snaps), so there are about 1 more possession per game.
- **6-point margins** run about 1.1 points high.
- **Market slope is 0.94** (0.86 before the step-5 adjustments). The sim's margins vary a little less than the closing spreads. Total margin spread is right (13.9 vs 14.3), so the remaining gap is in how far apart the sim rates teams. This should be revisited with the step-8 backtest, which has far more games.
- **Totals sit 2.1 points above the closing totals** for these games, and 0.3 under their actual scores (46.2 vs 46.5). These games went over their closing totals by 2.4 on average, and all 2023–2025 games by 1.1, which is the target for this check.
- **Touchdowns vs field goals:** the sim now scores slightly more touchdowns (5.19 vs 5.01) and tries fewer field goals (3.7 vs 4.0) than real games. Real drives stall at the opponent's 25–35 and kick 40–49-yard field goals more often.
- **3rd-down distance** is 7.4 vs 7.0.

## Scoring level (engine 0.4.0)

Live 2026 sims ran about 2.5 points a game under the market totals. Checking against real results (`jobs/totalsGap.ts --finals`) showed the sim's scoring barely moved between seasons (about 44–46 a game) while real scoring rose from 44.5 in 2023 to about 47.5 in 2024–2025. On walk-forward snapshots for weeks 4–16, the sim was 0.3 over real scores in 2023 but 3.1 under in 2024, 1.7 under in 2025 and 2.2 under in 2026 weeks 4–7.

`jobs/seasonStats.ts` and `pipeline/season_stats.py` compare scoring components on the same games. Field position, first downs, third-down conversions and first-down gains all matched. Two things did not:

| 2025–2026 games | Real | Sim 0.3.0 | Sim 0.4.0 |
|---|---|---|---|
| Points per game | 47.0 | 44.7 | 46.3 |
| Red-zone TD rate (per trip) | 58.7% | 56.3% | 59.5% |
| 4th-down go rate | 22.6% | 19.4% | 21.4% |
| Punts per game | 7.1 | 7.8 | 7.6 |

Changes, both in `model.config.ts`:

1. **Red zone.** The red-zone penalties (shorter gains, lower completion odds inside the 20) were cut to 70% of their old size, which brings the red-zone TD rate to the real level.
2. **Fourth down.** The go-for-it table is now the real 2024–2026 go rates. Teams go for it far more on 4th-and-1 in their own territory (37% vs 15%) and at the goal line (92% vs 72%).

Also in 0.4.0: a forecast chance of rain now applies that share of the rain effect (a 60% chance applies 60% of it), instead of the full effect whenever the chance reached 50%. If the user sets precipitation, the full effect applies.

Result on 2026: weeks 4–7 went from 1.0 under the closing totals to 0.25 over, and from 2.2 under the real scores to 0.9 under. On the week 8 slate, sim totals went from 2.55 under the market to about 1.4 under, before the rain change.



- **Engine constants:** edit `model.config.ts`, run `npx tsx jobs/calibrate.ts`, then run the engine tests. Bump `ENGINE_VERSION` if sim output changes.
- **Pipeline changes** (fits or histograms):

```
cd pipeline
python run_slate.py --season 2023 --weeks 4 8 12 16 --version 1   # also 2024 and 2025
python calibration_targets.py --seasons 2023 2024 2025 --weeks 4 8 12 16
cd .. && npx tsx jobs/makeCalibrationSet.ts
```
