/**
 * Weather: wind, precipitation and cold -> changes to completion odds, yards and FG odds.
 *
 * Effects (config.weather) were measured on 2022-2025 outdoor plays; see docs/adjustments.md.
 * Domes and closed roofs get no effect. Everything scales with the conditionsWeight lens.
 */

import { MODEL_CONFIG } from '../config/model.config';
import type { GameOverrides } from '../config/settings.schema';
import type { Precip, SnapshotGame } from '../types';

export interface ResolvedConditions {
  /** true for domes and closed roofs: weather has no effect. */
  indoor: boolean;
  windMph: number;
  tempF: number;
  precip: Precip;
  /** Share of the precipitation effect applied: the forecast's chance of it during the game
   *  (an expected-value blend), or 1 when the user sets precipitation or it was observed. */
  precipChance: number;
}

export interface WeatherEffects {
  /** Added to the completion logit (both teams). */
  completionLogit: number;
  /** Change in mean yards per completion and per carry (converted to tilts by the caller). */
  yardsPerCompletion: number;
  yardsPerCarry: number;
  /** FG make logit: flat part, and per yard of kick distance (wind grows with distance). */
  fgLogit: number;
  fgLogitPerYard: number;
}

export const NO_WEATHER: WeatherEffects = Object.freeze({
  completionLogit: 0,
  yardsPerCompletion: 0,
  yardsPerCarry: 0,
  fgLogit: 0,
  fgLogitPerYard: 0,
});

/** User overrides first, then the snapshot forecast, then mild defaults. */
export function resolveConditions(game: SnapshotGame, o: GameOverrides): ResolvedConditions {
  const roof = game.stadium.roof;
  const roofState = o.conditions.roof ?? game.weather?.roofExpected ?? null;
  const indoor = roof === 'dome' || (roof === 'retractable' && roofState !== 'open');
  return {
    indoor,
    windMph: o.conditions.windMph ?? game.weather?.windMph ?? 0,
    tempF: o.conditions.tempF ?? game.weather?.tempF ?? 60,
    precip: o.conditions.precip ?? game.weather?.precip ?? 'none',
    precipChance: o.conditions.precip !== null ? 1 : (game.weather?.precipChance ?? 1),
  };
}

/** 0 below windStartMph, 1 at windFullMph and above, linear between. */
export function windStrength(windMph: number): number {
  const w = MODEL_CONFIG.weather;
  return Math.min(1, Math.max(0, (windMph - w.windStartMph) / (w.windFullMph - w.windStartMph)));
}

export function weatherEffects(c: ResolvedConditions, weight: number): WeatherEffects {
  if (c.indoor || weight === 0) return NO_WEATHER;
  const w = MODEL_CONFIG.weather;
  const wind = windStrength(c.windMph);
  const p = w.precip[c.precip];
  const chance = Math.min(1, Math.max(0, c.precipChance));
  const precip = {
    completionLogit: chance * p.completionLogit,
    yardsPerCompletion: chance * p.yardsPerCompletion,
    yardsPerCarry: chance * p.yardsPerCarry,
  };
  const cold = c.tempF < w.coldThresholdF;
  return {
    completionLogit:
      weight *
      (wind * w.windFull.completionLogit +
        precip.completionLogit +
        (cold ? w.cold.completionLogit : 0)),
    yardsPerCompletion:
      weight *
      (wind * w.windFull.yardsPerCompletion +
        precip.yardsPerCompletion +
        (cold ? w.cold.yardsPerCompletion : 0)),
    yardsPerCarry: weight * precip.yardsPerCarry,
    fgLogit: weight * (cold ? w.cold.fgLogit : 0),
    fgLogitPerYard: (weight * wind * w.windFull.fgLogitAtReference) / w.fgWindReferenceDistance,
  };
}
