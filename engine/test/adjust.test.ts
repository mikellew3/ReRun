import { describe, expect, it } from 'vitest';
import { streakPts } from '../src/adjust/form';
import { NO_QB_DELTAS, qbSwapDeltas, redistributeOutShares } from '../src/adjust/injuries';
import { dvpMultipliers } from '../src/adjust/matchup';
import { restPts } from '../src/adjust/rest';
import { altitudePts, homeFieldPts } from '../src/adjust/venue';
import { NO_WEATHER, weatherEffects, windStrength } from '../src/adjust/weather';
import type { ResolvedConditions } from '../src/adjust/weather';
import { applySettings } from '../src/applySettings';
import { MODEL_CONFIG } from '../src/config';
import { logit, tiltForMeanShift, tiltedMean } from '../src/samplers';
import { DVP_BUCKETS } from '../src/types';
import type { DefVsPos, QbParams, SnapshotGame } from '../src/types';
import { GAME_ID, loadFixture, makeRequest } from './helpers';

const snapshot = loadFixture();
const game = snapshot.games.find((g) => g.gameId === GAME_ID)!;
const W = MODEL_CONFIG.weather;

const outdoors = (c: Partial<ResolvedConditions>): ResolvedConditions => ({
  indoor: false,
  windMph: 0,
  tempF: 60,
  precip: 'none',
  precipChance: 1,
  ...c,
});

describe('weather', () => {
  it('wind ramps from windStartMph to windFullMph', () => {
    expect(windStrength(W.windStartMph)).toBe(0);
    expect(windStrength(W.windFullMph)).toBe(1);
    expect(windStrength(40)).toBe(1);
    expect(windStrength((W.windStartMph + W.windFullMph) / 2)).toBeCloseTo(0.5);
  });

  it('has no effect indoors or with conditions weight 0', () => {
    expect(weatherEffects(outdoors({ indoor: true, windMph: 30 }), 1)).toEqual(NO_WEATHER);
    expect(weatherEffects(outdoors({ windMph: 30 }), 0)).toEqual(NO_WEATHER);
  });

  it('applies config effects, scaled by the lens', () => {
    const full = weatherEffects(outdoors({ windMph: 30, precip: 'light_rain' }), 1);
    expect(full.completionLogit).toBeCloseTo(
      W.windFull.completionLogit + W.precip.light_rain.completionLogit,
    );
    expect(full.fgLogitPerYard * W.fgWindReferenceDistance).toBeCloseTo(
      W.windFull.fgLogitAtReference,
    );
    const double = weatherEffects(outdoors({ windMph: 30, precip: 'light_rain' }), 2);
    expect(double.completionLogit).toBeCloseTo(2 * full.completionLogit);
    const maybe = weatherEffects(outdoors({ precip: 'light_rain', precipChance: 0.6 }), 1);
    expect(maybe.yardsPerCarry).toBeCloseTo(0.6 * W.precip.light_rain.yardsPerCarry);
    const cold = weatherEffects(outdoors({ tempF: W.coldThresholdF - 1 }), 1);
    expect(cold.yardsPerCompletion).toBeCloseTo(W.cold.yardsPerCompletion);
  });
});

describe('tiltForMeanShift', () => {
  it('moves a histogram mean by the asked yards', () => {
    const hist = snapshot.league.season.completionYds;
    const t = tiltForMeanShift(hist, -0.5);
    expect(tiltedMean(hist, t) - tiltedMean(hist, 0)).toBeCloseTo(-0.5, 4);
    expect(tiltForMeanShift(hist, 0)).toBe(0);
  });
});

describe('injuries: usage of out players', () => {
  const keep = { WR: 0.8, TE: 0.5 };
  it('keeps the configured part in the position group, split evenly, and preserves the total', () => {
    const shares = redistributeOutShares(
      [
        { position: 'WR', share: 0.3, available: false },
        { position: 'WR', share: 0.2, available: true },
        { position: 'WR', share: 0.05, available: true },
        { position: 'TE', share: 0.25, available: true },
        { position: 'RB', share: 0.2, available: true },
      ],
      keep,
    );
    expect(shares).toHaveLength(4);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    // Each WR gets 0.3 * 0.8 / 2 = 0.12; TE and RB split 0.06 by 0.25 : 0.2.
    expect(shares[0]).toBeCloseTo(0.32);
    expect(shares[1]).toBeCloseTo(0.17);
    expect(shares[2]).toBeCloseTo(0.25 + (0.06 * 0.25) / 0.45);
    expect(shares[3]).toBeCloseTo(0.2 + (0.06 * 0.2) / 0.45);
  });

  it('falls back to proportional when nobody at the position is available', () => {
    const shares = redistributeOutShares(
      [
        { position: 'TE', share: 0.2, available: false },
        { position: 'WR', share: 0.6, available: true },
        { position: 'RB', share: 0.2, available: true },
      ],
      keep,
    );
    expect(shares[0]).toBeCloseTo(0.75);
    expect(shares[1]).toBeCloseTo(0.25);
  });
});

describe('injuries: QB swaps', () => {
  const league = snapshot.teams[game.home]!.params.season.off;
  const hist = snapshot.league.season.completionYds;
  const qb = (dropbacks: number, completionRate: number): QbParams => ({
    dropbacks,
    completionRate,
    yardsPerAttempt: 7,
    passYdsTilt: 0,
    sackRate: 0.07,
    intRate: 0.02,
    scrambleRate: 0.05,
    designedRunShare: 0.05,
  });
  const B = MODEL_CONFIG.injuries.backupQb;

  it('a QB with no data plays at backup level when injury adjustments are on', () => {
    const usual = qb(500, 0.66);
    const d = qbSwapDeltas(undefined, usual, league, hist, true);
    expect(d.completionLogit).toBeCloseTo(
      logit(league.completionRate) + B.completionLogit - logit(0.66),
    );
    expect(qbSwapDeltas(undefined, usual, league, hist, false)).toEqual(NO_QB_DELTAS);
  });

  it('a QB with lots of data is mostly himself', () => {
    const usual = qb(500, 0.66);
    const vet = qb(3000, 0.64);
    const d = qbSwapDeltas(vet, usual, league, hist, true);
    const k = MODEL_CONFIG.shrinkage.qbDropbacksK;
    expect(d.completionLogit).toBeCloseTo(
      logit(0.64) - logit(0.66) + (k / (3000 + k)) * B.completionLogit,
    );
    expect(qbSwapDeltas(vet, usual, league, hist, false).completionLogit).toBeCloseTo(
      logit(0.64) - logit(0.66),
    );
  });
});

describe('matchups: defense vs position', () => {
  const league = snapshot.league.season.dvp;
  const scaled = (f: (b: string) => number): DefVsPos =>
    Object.fromEntries(
      DVP_BUCKETS.map((b) => [
        b,
        { ...league[b], yardsPerTarget: league[b].yardsPerTarget * f(b), n: 10_000 },
      ]),
    ) as DefVsPos;

  it('is neutral at weight 0 and for a league-average defense', () => {
    for (const m of Object.values(
      dvpMultipliers(
        scaled(() => 1.3),
        league,
        0,
      ),
    )) {
      expect(m).toEqual({ targets: 1, yardsPerTarget: 1 });
    }
    for (const m of Object.values(
      dvpMultipliers(
        scaled(() => 1),
        league,
        1,
      ),
    )) {
      expect(m.targets).toBeCloseTo(1);
      expect(m.yardsPerTarget).toBeCloseTo(1);
    }
  });

  it('uses only the positional pattern, not the overall level', () => {
    for (const m of Object.values(
      dvpMultipliers(
        scaled(() => 1.2),
        league,
        1,
      ),
    )) {
      expect(m.yardsPerTarget).toBeCloseTo(1);
    }
    const teWeak = dvpMultipliers(
      scaled((b) => (b === 'TE' ? 1.2 : 1)),
      league,
      1,
    );
    expect(teWeak.TE.yardsPerTarget).toBeGreaterThan(1.1);
    expect(teWeak.WR1.yardsPerTarget).toBeLessThan(1);
    const double = dvpMultipliers(
      scaled((b) => (b === 'TE' ? 1.2 : 1)),
      league,
      2,
    );
    expect(double.TE.yardsPerTarget).toBeCloseTo(teWeak.TE.yardsPerTarget ** 2);
  });

  it('shrinks small samples toward league', () => {
    const tiny = Object.fromEntries(
      DVP_BUCKETS.map((b) => [
        b,
        { ...league[b], yardsPerTarget: league[b].yardsPerTarget * (b === 'TE' ? 2 : 1), n: 1 },
      ]),
    ) as DefVsPos;
    expect(dvpMultipliers(tiny, league, 1).TE.yardsPerTarget).toBeLessThan(1.05);
  });
});

describe('venue, rest and streaks', () => {
  it('home field goes to the host; neutral sites have none', () => {
    expect(homeFieldPts(game, 'scheduled', 2)).toEqual({ home: 2, away: 0 });
    expect(homeFieldPts(game, 'swap', 2)).toEqual({ home: 0, away: 2 });
    expect(homeFieldPts(game, 'neutral', 2)).toEqual({ home: 0, away: 0 });
  });

  it('altitude penalizes visitors only at the scheduled site', () => {
    const den: SnapshotGame = { ...game, stadium: { ...game.stadium, altitudeFt: 5280 } };
    expect(altitudePts(den, 'scheduled').away).toBe(-MODEL_CONFIG.venue.altitudeVisitorPenaltyPts);
    expect(altitudePts(den, 'swap')).toEqual({ home: 0, away: 0 });
    const sea: SnapshotGame = { ...game, stadium: { ...game.stadium, altitudeFt: 100 } };
    expect(altitudePts(sea, 'scheduled')).toEqual({ home: 0, away: 0 });
  });

  it('a bye is worth the configured points', () => {
    const g: SnapshotGame = {
      ...game,
      context: { ...game.context, restDays: { home: 14, away: 7 } },
    };
    expect(restPts(g)).toEqual({ home: MODEL_CONFIG.rest.byeBonusPts, away: 0 });
  });

  it('streaks are capped', () => {
    const s = MODEL_CONFIG.streaks;
    expect(streakPts({ winStreak: 10, atsStreak: 0 })).toBeCloseTo(
      s.maxStreakGames * s.winStreakPtsPerGame,
    );
    expect(streakPts({ winStreak: -2, atsStreak: 0 })).toBeCloseTo(-2 * s.winStreakPtsPerGame);
  });
});

describe('applySettings: adjustments', () => {
  it('turns advantages into opposite, half-size offense shifts', () => {
    const inputs = applySettings(makeRequest(snapshot), snapshot);
    const { home, away } = inputs.adjustments.pts;
    expect(inputs.teams.home.ptsShift).toBeCloseTo((home.total - away.total) / 2);
    expect(inputs.teams.away.ptsShift).toBeCloseTo(-inputs.teams.home.ptsShift);
  });

  it('switching venue off removes the altitude penalty', () => {
    const on = applySettings(makeRequest(snapshot), snapshot).adjustments.pts.away.altitude;
    const off = applySettings(
      makeRequest(snapshot, { settings: (s) => (s.adjustments.venue = false) }),
      snapshot,
    ).adjustments.pts.away.altitude;
    expect(off).toBe(0);
    if (game.stadium.altitudeFt >= MODEL_CONFIG.venue.altitudeThresholdFt)
      expect(on).toBeLessThan(0);
  });

  it('wind lowers completion odds outdoors, and the weather switch turns it off', () => {
    const unit = (windMph: number, weather = true) => {
      const inputs = applySettings(
        makeRequest(snapshot, {
          settings: (s) => (s.adjustments.weather = weather),
          overrides: (o) => {
            o.conditions.windMph = windMph;
            o.conditions.roof = 'open';
          },
        }),
        snapshot,
      );
      return inputs.offense('home', inputs.teams.home.fixedIn, '');
    };
    const calm = unit(0);
    const windy = unit(30);
    expect(windy.completionProb[0]!).toBeLessThan(calm.completionProb[0]!);
    expect(windy.fgLogitPerYard).toBeLessThan(0);
    expect(unit(30, false).completionProb[0]!).toBeCloseTo(calm.completionProb[0]!);
  });
});
