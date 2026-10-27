/**
 * Presets are named SimSettings objects. Users start from one and customize.
 * Values are starting points; the step-8 backtest reports honest numbers for each.
 */

import { DEFAULT_SETTINGS, deepFreeze, parseSimSettings } from './settings.schema';
import type { SimSettings } from './settings.schema';

export interface Preset {
  id: string;
  name: string;
  description: string;
  settings: SimSettings;
}

type LensChanges = Partial<Omit<SimSettings['lenses'], 'script'>>;

function preset(id: string, name: string, description: string, lenses: LensChanges): Preset {
  const settings = parseSimSettings({
    ...DEFAULT_SETTINGS,
    lenses: { ...DEFAULT_SETTINGS.lenses, ...lenses },
  });
  return deepFreeze({ id, name, description, settings });
}

/** The house build runs this preset. */
export const HOUSE_PRESET_ID = 'default';

export const PRESETS: readonly Preset[] = deepFreeze([
  preset(
    'default',
    'Default',
    'The house build. Even blend of model and market, season-long history.',
    {},
  ),
  preset(
    'sharp',
    'Sharp',
    'Leans on the market, uses season-long history and moderate matchup effects.',
    { marketBlend: 0.8, historyWindow: 'season', matchupWeight: 0.7 },
  ),
  preset('pure-model', 'Pure Model', 'Ignores market prices entirely. Model numbers only.', {
    marketBlend: 0,
  }),
  preset('hot-hand', 'Hot Hand', 'Recent form: last 4 games only, streaks on.', {
    marketBlend: 0.3,
    historyWindow: 'L4',
    streaks: true,
  }),
  preset(
    'weatherman',
    'Weatherman',
    'Default model with conditions weighted up. For wind and snow games.',
    { conditionsWeight: 1.5 },
  ),
]);

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
