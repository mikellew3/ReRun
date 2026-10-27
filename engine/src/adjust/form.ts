/**
 * Streaks lens (off by default): points per game of a team's current win/loss streak and ATS
 * streak, capped. The evidence for them is weak (config.streaks; docs/adjustments.md).
 */

import { MODEL_CONFIG } from '../config/model.config';
import type { TeamForm } from '../types';

export function streakPts(form: TeamForm): number {
  const s = MODEL_CONFIG.streaks;
  const cap = (n: number) => Math.max(-s.maxStreakGames, Math.min(s.maxStreakGames, n));
  return cap(form.winStreak) * s.winStreakPtsPerGame + cap(form.atsStreak) * s.atsStreakPtsPerGame;
}
