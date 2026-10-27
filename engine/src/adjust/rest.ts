/**
 * Rest and travel, in points of advantage per team. Values are what closing spreads charge
 * (config.rest; docs/adjustments.md): coming off a bye is worth something, travel and time
 * zones are not (their config values are 0, and stay switchable).
 */

import { MODEL_CONFIG } from '../config/model.config';
import type { GameOverrides } from '../config/settings.schema';
import type { SnapshotGame } from '../types';
import type { SidePts } from './venue';

export function restPts(game: SnapshotGame): SidePts {
  const r = MODEL_CONFIG.rest;
  const days = game.context.restDays;
  const bye = (d: number) => (d >= r.byeMinDays ? r.byeBonusPts : 0);
  let home = bye(days.home);
  let away = bye(days.away);
  if (days.home < r.byeMinDays && days.away < r.byeMinDays) {
    const gap = Math.max(-r.restGapMaxDays, Math.min(r.restGapMaxDays, days.home - days.away));
    home += (gap * r.restGapPtsPerDay) / 2;
    away -= (gap * r.restGapPtsPerDay) / 2;
  }
  return { home, away };
}

/** Away-team travel; only when the game is where the snapshot says. */
export function travelPts(game: SnapshotGame, venue: GameOverrides['venue']): SidePts {
  const r = MODEL_CONFIG.rest;
  if (venue !== 'scheduled' || game.neutralSite) return { home: 0, away: 0 };
  const long = game.context.awayTravelMiles >= r.longTravelMiles ? r.longTravelPenaltyPts : 0;
  const tz = Math.abs(game.context.awayTzShift) * r.tzShiftPenaltyPtsPerHour;
  return { home: 0, away: -(long + tz) };
}
