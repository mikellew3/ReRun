"""Small numeric helpers: histograms, exponential tilts, shrinkage, ridge opponent adjustment."""

import math

import numpy as np
import pandas as pd


def yard_histogram(values: pd.Series, lo: int, hi: int, weights: pd.Series | None = None) -> dict:
    """Integer-yard histogram over [lo, hi]. Values outside go to the end bins.

    Returns {"min": lo, "probs": [...]} with probs summing to 1 (the YardHistogram type).
    """
    v = np.clip(np.rint(values.to_numpy(dtype=float)), lo, hi).astype(int) - lo
    w = np.ones(len(v)) if weights is None else weights.to_numpy(dtype=float)
    counts = np.bincount(v, weights=w, minlength=hi - lo + 1)
    total = counts.sum()
    if total <= 0:
        raise ValueError("cannot build a histogram from no data")
    return {"min": lo, "probs": (counts / total).tolist()}


def histogram_mean(hist: dict, tilt: float = 0.0) -> float:
    x = np.arange(len(hist["probs"])) + hist["min"]
    p = np.asarray(hist["probs"]) * np.exp(tilt * (x - x.mean()))
    return float((p * x).sum() / p.sum())


def solve_tilt(hist: dict, target_mean: float, lo: float = -1.0, hi: float = 1.0) -> float:
    """Exponential tilt t such that the histogram reweighted by exp(t * yards) has this mean.

    Tilt 0 = league shape. The engine applies the same reweighting, so the tilt preserves the
    league's shape (including spikes) while moving its mean. Clamped to [lo, hi].
    """
    if target_mean <= histogram_mean(hist, lo):
        return lo
    if target_mean >= histogram_mean(hist, hi):
        return hi
    for _ in range(60):
        mid = (lo + hi) / 2
        if histogram_mean(hist, mid) < target_mean:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def shrink(observed: float, n: float, prior: float, k: float) -> float:
    """(n * observed + k * prior) / (n + k). With no data, returns the prior."""
    if n <= 0 or observed is None or (isinstance(observed, float) and math.isnan(observed)):
        return prior
    return (n * observed + k * prior) / (n + k)


def ridge_team_effects(
    rows: pd.DataFrame, value: str, count: str, weight: str, lam: float
) -> tuple[float, dict[str, float], dict[str, float]]:
    """Fits value ~ mean + offense[off] + defense[def] by weighted ridge regression.

    rows: one row per (game, offense team) with columns "off", "def", the per-game rate
    `value`, its denominator `count` and a recency `weight`. Each row's regression weight is
    count * weight, so lam is in plays. The intercept is not penalized.

    Returns (league mean, offense effects, defense effects). Effects are deviations from the
    league mean: a positive defense effect means the defense ALLOWS more of `value`.
    """
    df = rows[(rows[count] > 0) & rows[value].notna()]
    teams = sorted(set(df["off"]) | set(df["def"]))
    idx = {t: i for i, t in enumerate(teams)}
    n_teams = len(teams)
    n = len(df)

    x = np.zeros((n, 1 + 2 * n_teams))
    x[:, 0] = 1.0
    x[np.arange(n), 1 + df["off"].map(idx).to_numpy()] = 1.0
    x[np.arange(n), 1 + n_teams + df["def"].map(idx).to_numpy()] = 1.0
    y = df[value].to_numpy(dtype=float)
    w = (df[count] * df[weight]).to_numpy(dtype=float)

    penalty = np.full(1 + 2 * n_teams, lam)
    penalty[0] = 0.0
    xtw = x.T * w
    beta = np.linalg.solve(xtw @ x + np.diag(penalty), xtw @ y)

    off = {t: float(beta[1 + i]) for t, i in idx.items()}
    deff = {t: float(beta[1 + n_teams + i]) for t, i in idx.items()}
    return float(beta[0]), off, deff
