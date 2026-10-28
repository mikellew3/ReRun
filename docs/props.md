# Prop calibration

Status: **checked, not yet fit for pricing props.** Projected averages are close for most stats. The sim's ranges are too narrow, though, and QB passing volume runs high. Both need fixing before ReRun shows prop edges.

## How it's checked

`jobs/checkProps.ts` takes every player a book would post a line for in the 184 calibration games (2023–2025, walk-forward snapshots, default settings). Each player is simmed 1,000 times and compared with his real box score (`player_games.json.gz`, from `pipeline/calibration_targets.py`). No prop odds are needed, and none are bought.

**Who counts:**
- **QB props:** QBs the sim expects to throw 15+ passes.
- **Rushing:** players expected to get 5+ carries, or QBs expected to run for 15+ yards.
- **Receiving:** players expected to see 3+ targets.
- **Anytime TD:** players with an 8%+ TD chance.

Props are void when a player doesn't play, so sims where a questionable player sat are skipped for him.

**What it measures:**
- **PIT:** where the real result fell in the sim's range. If the ranges are right, half of results land in the sim's middle 50% (cov50 = 0.50) and 80% in its middle 80% (cov80 = 0.80). Lower coverage means the sim is overconfident. A mean PIT below 0.50 means the sim projects too high.
- **Over/under:** P(over) at half-point lines placed at the sim's 30th, 50th and 70th percentiles, compared with how often the over actually hit.

## Results (engine 0.3.0, seed 2026)

Engine `0.4.0` (red-zone and fourth-down retune) changes these little: see `props-check.json`. Anytime-TD probabilities rose slightly (sim mean 0.26 vs 0.24 actual).

| Market | n | Real avg | Sim avg | PIT | cov50 | cov80 | Over at p30 line, sim / real | p50 line | p70 line |
|---|---|---|---|---|---|---|---|---|---|
| Pass yards | 368 | 212.2 | 230.9 | 0.46 | 0.38 | 0.67 | 0.70 / 0.61 | 0.50 / 0.48 | 0.30 / 0.32 |
| Pass attempts | 368 | 29.3 | 33.7 | 0.39 | 0.38 | 0.62 | 0.67 / 0.50 | 0.47 / 0.36 | 0.28 / 0.23 |
| Completions | 368 | 19.4 | 21.5 | 0.43 | 0.38 | 0.64 | 0.66 / 0.55 | 0.46 / 0.42 | 0.27 / 0.24 |
| Pass TDs | 368 | 1.33 | 1.44 | 0.47 | 0.45 | 0.75 | 0.50 / 0.47 | 0.34 / 0.33 | 0.18 / 0.15 |
| Interceptions | 368 | 0.61 | 0.81 | 0.46 | 0.45 | 0.76 | 0.46 / 0.40 | 0.30 / 0.26 | 0.17 / 0.16 |
| Rush yards | 806 | 42.9 | 44.2 | 0.47 | 0.41 | 0.68 | 0.69 / 0.62 | 0.49 / 0.47 | 0.29 / 0.31 |
| Rush attempts | 596 | 11.4 | 11.6 | 0.48 | 0.35 | 0.65 | 0.64 / 0.59 | 0.45 / 0.44 | 0.26 / 0.32 |
| Receptions | 1,636 | 3.56 | 3.53 | 0.49 | 0.46 | 0.75 | 0.59 / 0.58 | 0.39 / 0.40 | 0.22 / 0.24 |
| Receiving yards | 1,636 | 40.7 | 39.0 | 0.50 | 0.47 | 0.76 | 0.69 / 0.69 | 0.49 / 0.51 | 0.29 / 0.31 |
| Anytime TD | 2,601 | 24% | 25% | 0.50 | 0.49 | 0.79 | | | |

Standard errors on the over rates are about 0.03 for QB markets and 0.01–0.02 for the rest.

**Anytime TD, by predicted probability:**

| Predicted | 8–20% | 20–30% | 30–40% | 40–50% | 50%+ |
|---|---|---|---|---|---|
| n | 1,223 | 595 | 375 | 218 | 190 |
| Sim | 13% | 25% | 35% | 45% | 58% |
| Real | 13% | 25% | 33% | 40% ± 3 | 53% ± 4 |

## What it shows

- **Receiving props are close.** Averages, over rates and coverage are nearly right, though the ranges are slightly narrow (0.47 / 0.76).
- **Anytime TD is well calibrated up to 40%.** Above that it runs about 5 points hot, so the top TD favorites are slightly overrated.
- **QB props are the problem.** Pass attempts run 4.4 too high and the over hits 36% at the sim's median line, not 50%. Coverage is 0.38 / 0.62, far too narrow. There are two causes:
  1. **No mid-game exits.** The sim never pulls a player mid-game. In 9.5% of these games the starting QB threw under 90% of his team's passes (injury, benching, blowout). Real outcomes therefore have a long low tail the sim lacks. That's why the over at the 30th-percentile line hits only 50–61% of the time instead of 70%. It affects RBs too (rush attempts cov50 0.35).
  2. **QB volume runs high.** QBs who played the whole game threw 33.0 passes; the sim says 33.7. Against the calibration target the gap is about 1.5–2 attempts. It sits inside the calibration tolerance, so it never flagged, but props expose it.
- **Interceptions** run 0.2 per game high.

## Next steps (before prop edges are shown)

1. **Mid-game exits.** Each player gets a chance, measured by position from snap counts, of leaving at a random point in the game. His snaps go to the next man up, including the backup QB. This fattens the low tails and also affects game totals.
2. **Trim QB pass volume and interceptions** to the full-game numbers, and re-run calibration.
3. **Re-run this check.** Target coverage within about 0.03 of nominal for every market.

## Re-running

```
cd pipeline && python calibration_targets.py --seasons 2023 2024 2025 --weeks 4 8 12 16
cd .. && npx tsx jobs/checkProps.ts --n 1000 --out docs/props-check.json
```

## Against the books' lines (2026 week 8)

The sim's chance of the over averaged 41% on receptions (books' no-vig chance 48.5%), 44% on receiving yards (50%), 44% on carries (50%) and 48% on rushing yards (50%). Two causes:

- **The sim is a little low on top receivers.** Comparing each team's top-ranked receiver in the sim (ranked by the sim, not by outcome) with what that player did on 2026 weeks 5–7: targets 8.0 vs 8.3, receptions 5.1 vs 5.4, yards 61 vs 64. Second and third receivers are on target. Target shares by depth slot are not the problem: fitted multipliers for WR1–WR5, TE1–TE3 and RB1–RB3 all came out near 1.
- **The books' lines sit at players' medians, with the overs shaded up.** Without historical prop prices, how much of the gap is book shading can't be measured.

So prop value shading stays off, and props are forward-tested (`forward-test/`, `docs/forward-test.json`): every snapshot publish records the sim's chances on each book's prop lines before kickoff, and the results are graded after the games.
