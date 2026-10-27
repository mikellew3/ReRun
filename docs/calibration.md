# Engine calibration (Phase 1, step 4)

Status: **all 55 checks pass** with default settings (engine `0.3.0`, CI seed 2026), and on three other seeds. Engine `0.3.0` adds the step-5 adjustments (injuries, weather, venue, rest), which are on by default; see [adjustments.md](adjustments.md).

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
| Scores | Total points, mean | 45.0 | 45.1 | ±1.5 |
| | Total points, sd | 13.4 | 13.6 | ±1.5 |
| | Home margin vs closing spreads | 1.07 | 1.27 | ±1.0 |
| | Margin sd | 13.9 | 14.3 | ±1.5 |
| | Overtime rate | 4.9% | 5.3% | ±2 pts |
| Key numbers | Margin of 3 | 12.9% | 14.2% | ±2.5 pts |
| | Margin of 7 | 8.4% | 8.3% | ±2 pts |
| | Margin of 6 | 7.7% | 6.6% | ±1.5 pts |
| | Margin of 10 | 4.8% | 4.2% | ±1.5 pts |
| | Margin of 14 | 3.5% | 4.4% | ±1.5 pts |
| Plays | Plays per game | 126.6 | 124.4 | ±3 |
| | Yards per play | 5.27 | 5.34 | ±0.15 |
| | Pass attempt share | 55.6% | 55.0% | ±2 pts |
| | Completion rate | 63.7% | 65.0% | ±1.5 pts |
| | Turnovers per team-game | 1.24 | 1.17 | ±0.15 |
| Starters | QB pass yards (mean / sd) | 231 / 68 | 226 / 74 | ±7% / ±15% |
| | QB pass TDs | 1.44 | 1.43 | ±0.1 |
| | RB1 carries / rush yards | 14.6 / 63.6 | 15.2 / 65.9 | ±7% |
| | Top target: targets / rec / yards | 9.5 / 6.0 / 70 | 9.2 / 6.1 / 75 | ±7% |
| Market | Sim margin vs closing spread: slope | 0.91 | 1.00 | ±0.15 |
| | Correlation with closing spread | 0.841 | — | ≥ 0.8 |
| | Sim total minus closing total | +0.9 | 0 | ±1.5 |
| Events | Touchdowns / FG attempts / punts per game | 5.02 / 3.81 / 8.17 | 5.01 / 4.00 / 7.65 | ±0.3 / ±0.35 / ±0.6 |
| | FG rate / 4th-down go rate | 84.8% / 19.7% | 85.2% / 20.9% | |
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
- **Market slope is 0.91** (0.86 before the step-5 adjustments). The sim's margins vary a little less than the closing spreads. Total margin spread is right (13.9 vs 14.3), so the remaining gap is in how far apart the sim rates teams. This should be revisited with the step-8 backtest, which has far more games.
- **Totals sit 0.9 points above the closing totals** for these games (1.4 before weather), while matching the real final scores (45.0 vs 45.1). These games simply went over their closing totals on average.
- **3rd-down distance** is 7.4 vs 7.0.

## Re-running after changes

- **Engine constants:** edit `model.config.ts`, run `npx tsx jobs/calibrate.ts`, then run the engine tests. Bump `ENGINE_VERSION` if sim output changes.
- **Pipeline changes** (fits or histograms):

```
cd pipeline
python run_slate.py --season 2023 --weeks 4 8 12 16 --version 1   # also 2024 and 2025
python calibration_targets.py --seasons 2023 2024 2025 --weeks 4 8 12 16
cd .. && npx tsx jobs/makeCalibrationSet.ts
```
