# Walk-forward backtest, 2022–2025 (engine 0.4.0)

**Result: the sim does not beat closing lines.** In every market and every preset, the closing line predicts results better than the sim, and betting the sim's disagreements with the close lost money. Edges stay hidden (`markets.showEdges`), and value shading is off (`markets.valueShading.enabled`) until the forward test shows otherwise.

## Method

- **Games.** Weeks 4–18 of 2022–2025, 895 regular-season games.
- **Walk-forward.** Each week's snapshot is built 90 minutes before that week's first kickoff (`pipeline/run_slate.py`), so every fitted number uses only earlier games. Weather is the game-time weather.
- **Sims.** 2,000 per game with each preset (`jobs/backtest.ts sim`).
- **Market.** nflverse closing spreads, totals and moneylines with their prices (`pipeline/backtest_lines.py`), de-vigged.
- **Scores.**
  - Log loss and Brier score of the sim and of the market against results, with pushes left out.
  - A 50/50 blend of the two: if the sim added information the market lacks, the blend would beat the market.
  - Bets: every side whose edge (sim minus no-vig market) clears a config tier, 1 unit at the closing price.
- **Report:** `backtests/2026-10-28-engine-0.4.0.json`. Rerun with:

```
cd pipeline && python run_slate.py --season 2025 --weeks $(seq 4 18) --version 1   # each season
python backtest_lines.py --seasons 2022 2023 2024 2025
cd .. && npx tsx jobs/backtest.ts sim pipeline/data/snapshots/2025-W*-v1.json --out rows.jsonl
npx tsx jobs/backtest.ts report rows.jsonl --closing pipeline/data/backtest/closing.json --out report.json
```

## Default settings (the house build)

Log loss, lower is better:

| Market | Sim | Market | 50/50 blend |
|---|---|---|---|
| Moneyline | 0.640 | **0.597** | 0.612 |
| Spread | 0.730 | **0.692** | 0.703 |
| Total | 0.715 | **0.693** | 0.698 |

The blend is worse than the market alone in every market, so the sim's view of a game adds nothing the closing line doesn't already have.

Betting every edge at the closing price:

| Market | Edge ≥ 3% | Edge ≥ 5% | Edge ≥ 8% |
|---|---|---|---|
| Moneyline | 279–383, −12.8% | 219–321, −14.2% | 147–234, −18.5% |
| Spread | 334–360–15, −7.2% | 276–295–14, −6.8% | 213–223–14, −5.9% |
| Total | 353–339–5, −2.2% | 274–271–5, −3.5% | 191–206–3, −7.6% |

Bigger edges did not win more often. The sim disagrees with the close a lot: it finds a 3%+ spread edge in 79% of games. When it disagrees, results follow the market:

| Sim's chance the home side covers | Games | Market | Actual |
|---|---|---|---|
| 20–35% | 92 | 50% | 58% |
| 35–45% | 228 | 50% | 50% |
| 45–55% | 292 | 50% | 49% |
| 55–65% | 178 | 50% | 49% |
| 65–80% | 76 | 50% | 51% |

Totals lean over: the sim's chance of the over averaged 5.5 points above the market's. It went 353–339 on 3%+ edges, close to break-even before the vig.

## Presets

Without historical prop prices there is no market-implied usage, so the market blend has nothing to blend: **Sharp** and **Pure Model** give the same results as Default. **Weatherman** is within noise of Default. **Hot Hand** (last 4 games, streaks, matchups) is clearly worse: log loss 0.707 / 0.791 / 0.747, against 0.640 / 0.730 / 0.715 for Default.

## Not measured

- **Closing-line value.** nflverse has closing lines only, and betting the close has no CLV by definition. That makes this a hard test: the sim's numbers might still beat early lines that later move toward them. The forward test (`forward-test/`, graded into `docs/forward-test.json`) records the sim's chances against every book's line before each game and measures CLV.
- **Props, team totals, first halves and alt lines.** There is no historical pricing. These are forward-tested.

## What this means

As it stands, the engine is a good game simulator (calibration passes: margins, key numbers, totals and player lines look like real football), but a poor handicapper. Its team ratings come from play-by-play efficiency alone. The market also knows about injuries, news and matchups, and prices them better.

The usual way to get value from a sim like this is to **anchor the game to the market and use the sim for everything derived from it**: set each team's strength so the sim matches the market spread and total, then price alt lines, team totals, first halves and props from the sim's distributions. Books price those derivative markets less sharply. That is the market-blend lens in CLAUDE.md §7.5, which today applies only to usage. Extending it to team strength is the recommended next step, followed by a re-run of this backtest with the blend.
