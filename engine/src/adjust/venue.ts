/**
 * Venue: home field (the user's lens) and altitude. Points of advantage per team; applySettings
 * turns advantages into offense/defense shifts.
 */

import { MODEL_CONFIG } from '../config/model.config';
import type { GameOverrides } from '../config/settings.schema';
import type { Side, SnapshotGame } from '../types';

export type SidePts = Record<Side, number>;

export const ZERO_PTS: SidePts = Object.freeze({ home: 0, away: 0 });

/** Is anyone at home? 'swap' plays the game at the away team's place. */
export function hostSide(game: SnapshotGame, venue: GameOverrides['venue']): Side | null {
  if (venue === 'neutral' || (venue === 'scheduled' && game.neutralSite)) return null;
  return venue === 'swap' ? 'away' : 'home';
}

export function homeFieldPts(
  game: SnapshotGame,
  venue: GameOverrides['venue'],
  hfaPts: number,
): SidePts {
  const host = hostSide(game, venue);
  if (host === null) return ZERO_PTS;
  return host === 'home' ? { home: hfaPts, away: 0 } : { home: 0, away: hfaPts };
}

/**
 * Visitors at altitude. Only for the scheduled site: on a swap or neutral venue the snapshot's
 * stadium is not where the game is played.
 */
export function altitudePts(game: SnapshotGame, venue: GameOverrides['venue']): SidePts {
  const v = MODEL_CONFIG.venue;
  if (venue !== 'scheduled' || game.neutralSite) return ZERO_PTS;
  if (game.stadium.altitudeFt < v.altitudeThresholdFt) return ZERO_PTS;
  return { home: 0, away: -v.altitudeVisitorPenaltyPts };
}
