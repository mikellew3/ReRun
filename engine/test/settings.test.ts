import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERRIDES,
  DEFAULT_SETTINGS,
  MODEL_CONFIG,
  SETTINGS_CONTROLS,
  configHash,
  lineShapeError,
  parseGameOverrides,
  parseRunRequest,
  parseSimSettings,
  stableStringify,
} from '../src/config';
import { HISTORY_WINDOWS } from '../src/types';
import { ENGINE_VERSION } from '../src/version';

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, k) => (node as Record<string, unknown>)[k], obj);
}

function leafPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('SimSettings defaults', () => {
  it('validate against the schema', () => {
    expect(() => parseSimSettings(DEFAULT_SETTINGS)).not.toThrow();
  });

  it('come from the control definitions', () => {
    for (const [path, control] of Object.entries(SETTINGS_CONTROLS)) {
      expect(getPath(DEFAULT_SETTINGS, path), path).toBe(control.default);
    }
  });

  it('have a control for every setting (except schemaVersion)', () => {
    const leaves = leafPaths(DEFAULT_SETTINGS).filter((p) => p !== 'schemaVersion');
    expect(leaves.sort()).toEqual(Object.keys(SETTINGS_CONTROLS).sort());
  });

  it('are frozen', () => {
    expect(() => {
      (DEFAULT_SETTINGS.lenses as { marketBlend: number }).marketBlend = 1;
    }).toThrow();
  });

  it('use home-field range from MODEL_CONFIG', () => {
    const c = SETTINGS_CONTROLS['lenses.homeFieldPts'];
    expect(c.min).toBe(MODEL_CONFIG.homeField.minPts);
    expect(c.max).toBe(MODEL_CONFIG.homeField.maxPts);
    expect(DEFAULT_SETTINGS.lenses.homeFieldPts).toBe(MODEL_CONFIG.homeField.defaultPts);
  });

  it('offer exactly the history windows the pipeline publishes', () => {
    expect([...HISTORY_WINDOWS]).toEqual([...MODEL_CONFIG.fitting.historyWindows]);
  });
});

describe('SimSettings validation', () => {
  it('rejects out-of-range values', () => {
    const s = clone(DEFAULT_SETTINGS);
    s.lenses.marketBlend = 1.2;
    expect(() => parseSimSettings(s)).toThrow();
  });

  it('rejects values off the step grid', () => {
    const s = clone(DEFAULT_SETTINGS);
    s.lenses.matchupWeight = 1.05;
    expect(() => parseSimSettings(s)).toThrow();
  });

  it('accepts float values that are on the grid', () => {
    const s = clone(DEFAULT_SETTINGS);
    s.lenses.marketBlend = 0.35;
    s.lenses.script.away.pace = -0.7;
    expect(() => parseSimSettings(s)).not.toThrow();
  });

  it('rejects unknown keys', () => {
    const s = { ...clone(DEFAULT_SETTINGS), extra: true };
    expect(() => parseSimSettings(s)).toThrow();
  });

  it('rejects an unknown history window', () => {
    const s = clone(DEFAULT_SETTINGS) as unknown as { lenses: { historyWindow: string } };
    s.lenses.historyWindow = 'L2';
    expect(() => parseSimSettings(s)).toThrow();
  });
});

describe('GameOverrides', () => {
  it('defaults validate', () => {
    expect(() => parseGameOverrides(DEFAULT_OVERRIDES)).not.toThrow();
  });

  it('accepts a realistic override set', () => {
    const o = {
      ...clone(DEFAULT_OVERRIDES),
      venue: 'neutral',
      conditions: { windMph: 22, tempF: 18, precip: 'light_snow', roof: null },
      roster: { '00-0033873': 'out' },
      usage: { '00-0036900': { targetShare: 0.04 } },
      customLines: [
        { market: 'spreads', selection: 'away', line: -2.5, price: -115 },
        { market: 'team_totals', selection: 'over', side: 'home', line: 24.5, price: -110 },
        {
          market: 'player_reception_yds',
          selection: 'over',
          playerId: '00-0036900',
          line: 74.5,
          price: -112,
        },
        {
          market: 'player_anytime_td',
          selection: 'yes',
          playerId: '00-0036900',
          line: null,
          price: 150,
        },
      ],
    };
    expect(() => parseGameOverrides(o)).not.toThrow();
  });

  it('rejects usage nudges beyond the control range', () => {
    const o = { ...clone(DEFAULT_OVERRIDES), usage: { p1: { carryShare: 0.4 } } };
    expect(() => parseGameOverrides(o)).toThrow();
  });

  it('rejects impossible American odds', () => {
    const o = {
      ...clone(DEFAULT_OVERRIDES),
      customLines: [{ market: 'spreads', selection: 'home', line: -3, price: -50 }],
    };
    expect(() => parseGameOverrides(o)).toThrow();
  });
});

describe('lineShapeError', () => {
  it('accepts valid shapes', () => {
    expect(lineShapeError({ market: 'h2h', selection: 'home', line: null })).toBeNull();
    expect(lineShapeError({ market: 'totals', selection: 'under', line: 44.5 })).toBeNull();
  });

  it('catches mismatched selections, lines, sides and players', () => {
    expect(lineShapeError({ market: 'totals', selection: 'home', line: 44.5 })).toMatch(
      /selection/,
    );
    expect(lineShapeError({ market: 'h2h', selection: 'home', line: -3 })).toMatch(/no line/);
    expect(lineShapeError({ market: 'spreads', selection: 'home', line: null })).toMatch(
      /needs a line/,
    );
    expect(lineShapeError({ market: 'team_totals', selection: 'over', line: 21.5 })).toMatch(
      /side/,
    );
    expect(lineShapeError({ market: 'player_rush_yds', selection: 'over', line: 60.5 })).toMatch(
      /playerId/,
    );
    expect(
      lineShapeError({ market: 'totals', selection: 'over', line: 44.5, playerId: 'p1' }),
    ).toMatch(/player props only/);
  });
});

describe('RunRequest', () => {
  const base = {
    snapshotId: '2026-W09-v3',
    gameId: '2026_09_KC_BUF',
    engineVersion: ENGINE_VERSION,
    settings: DEFAULT_SETTINGS,
    overrides: DEFAULT_OVERRIDES,
    nSims: 10000,
    seed: 4294967295,
  };

  it('accepts a valid request', () => {
    expect(() => parseRunRequest(base)).not.toThrow();
  });

  it('rejects sim counts that are not offered', () => {
    expect(() => parseRunRequest({ ...base, nSims: 5000 })).toThrow();
  });

  it('rejects non-uint32 seeds', () => {
    expect(() => parseRunRequest({ ...base, seed: -1 })).toThrow();
    expect(() => parseRunRequest({ ...base, seed: 2 ** 32 })).toThrow();
    expect(() => parseRunRequest({ ...base, seed: 1.5 })).toThrow();
  });
});

describe('configHash', () => {
  it('is stable and 16 hex characters', () => {
    expect(configHash()).toMatch(/^[0-9a-f]{16}$/);
    expect(configHash()).toBe(configHash());
  });

  it('stableStringify ignores key order', () => {
    expect(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(
      stableStringify({ a: [1, { c: 3, d: 2 }], b: 1 }),
    );
  });
});
