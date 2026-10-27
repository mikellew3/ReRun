import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  HOUSE_PRESET_ID,
  PRESETS,
  getPreset,
  parseSimSettings,
} from '../src/config';

describe('presets', () => {
  it('all validate against the SimSettings schema', () => {
    for (const p of PRESETS) expect(() => parseSimSettings(p.settings), p.id).not.toThrow();
  });

  it('have unique ids', () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });

  it('include the house preset, equal to the defaults', () => {
    expect(getPreset(HOUSE_PRESET_ID)?.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('match the brief', () => {
    const sharp = getPreset('sharp')!.settings.lenses;
    expect(sharp.marketBlend).toBeGreaterThan(DEFAULT_SETTINGS.lenses.marketBlend);
    expect(sharp.historyWindow).toBe('season');
    expect(sharp.matchupWeight).toBeLessThan(1);

    expect(getPreset('pure-model')!.settings.lenses.marketBlend).toBe(0);

    const hot = getPreset('hot-hand')!.settings.lenses;
    expect(hot.historyWindow).not.toBe('season');
    expect(hot.streaks).toBe(true);

    expect(getPreset('weatherman')!.settings.lenses.conditionsWeight).toBeGreaterThan(1);
  });

  it('are frozen', () => {
    expect(() => {
      (PRESETS[0]!.settings.lenses as { streaks: boolean }).streaks = true;
    }).toThrow();
  });
});
