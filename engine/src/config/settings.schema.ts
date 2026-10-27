/**
 * Every user-controllable value, defined once: type, range, step, default, label, help.
 *
 * Three objects (see docs/proposals/phase1-steps1-3.md, D1):
 * - SimSettings   portable lenses + adjustment toggles; saved on builds, runs and locks
 * - GameOverrides venue, conditions, roster, usage nudges, custom lines; saved on runs and locks
 * - RunRequest    everything needed to reproduce a run exactly
 *
 * The UI renders controls from the *_CONTROLS objects below. Validate with these zod schemas
 * everywhere one of these objects is read (browser, jobs, database writes). Schemas are strict:
 * unknown keys are rejected.
 */

import { z } from 'zod';
import { MODEL_CONFIG } from './model.config';
import { HISTORY_WINDOWS, MARKET_KEYS, PRECIP_KINDS, SELECTIONS } from '../types';
import type { MarketKey, Selection } from '../types';

// ---------------------------------------------------------------------------
// Control definitions
// ---------------------------------------------------------------------------

export type ControlGroup = 'game' | 'conditions' | 'roster' | 'lenses' | 'script' | 'adjustments';

interface ControlBase {
  label: string;
  help: string;
  group: ControlGroup;
}

export interface NumberControl extends ControlBase {
  kind: 'number';
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}

export interface ChoiceControl<T extends string | number> extends ControlBase {
  kind: 'choice';
  options: readonly { value: T; label: string }[];
  default: T;
}

export interface ToggleControl extends ControlBase {
  kind: 'toggle';
  default: boolean;
}

export type Control = NumberControl | ChoiceControl<string> | ChoiceControl<number> | ToggleControl;

/** Number controls whose default is "use the snapshot" (null) rather than a fixed value. */
export type OptionalNumberControl = Omit<NumberControl, 'default'>;
export type OptionalChoiceControl<T extends string> = Omit<ChoiceControl<T>, 'default'>;

const scriptControls = (side: 'home' | 'away') => {
  const team = side === 'home' ? 'Home' : 'Away';
  return {
    pace: {
      kind: 'number',
      group: 'script',
      label: `${team} pace`,
      help: 'Slower (-1) to faster (+1) than this team normally plays. 0 = as fitted.',
      min: -1,
      max: 1,
      step: 0.1,
      default: 0,
    },
    passRate: {
      kind: 'number',
      group: 'script',
      label: `${team} pass-rate tilt`,
      help: 'Run-heavy (-1) to pass-heavy (+1) relative to this team’s normal tendency. 0 = as fitted.',
      min: -1,
      max: 1,
      step: 0.1,
      default: 0,
    },
  } satisfies Record<string, NumberControl>;
};

/**
 * SimSettings controls, keyed by their path in the SimSettings object.
 * DEFAULT_SETTINGS is built from these defaults, so every path must exist in the schema
 * (checked when this module loads).
 */
export const SETTINGS_CONTROLS = {
  'lenses.marketBlend': {
    kind: 'number',
    group: 'lenses',
    label: 'Market blend',
    help: '0 = pure model. 1 = fully anchored to market prices and market-implied usage.',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.5,
  },
  'lenses.historyWindow': {
    kind: 'choice',
    group: 'lenses',
    label: 'History window',
    help: 'Which games the team and player numbers come from: the whole season (recency-weighted) or only the last N games.',
    options: HISTORY_WINDOWS.map((w) => ({
      value: w,
      label: w === 'season' ? 'Season' : `Last ${w.slice(1)}`,
    })),
    default: 'season',
  },
  'lenses.matchupWeight': {
    kind: 'number',
    group: 'lenses',
    label: 'Matchup weight',
    help: 'How strongly defense-vs-position adjustments apply. 0 = ignore matchups, 1 = as fitted, 2 = double.',
    min: 0,
    max: 2,
    step: 0.1,
    default: 1,
    unit: '×',
  },
  'lenses.streaks': {
    kind: 'toggle',
    group: 'lenses',
    label: 'Streaks',
    help: 'Use win, ATS and over/under streaks. Historically weak predictors; off by default.',
    default: false,
  },
  'lenses.homeFieldPts': {
    kind: 'number',
    group: 'lenses',
    label: 'Home-field value',
    help: 'Home-field advantage in points. Ignored at a neutral site.',
    min: MODEL_CONFIG.homeField.minPts,
    max: MODEL_CONFIG.homeField.maxPts,
    step: MODEL_CONFIG.homeField.stepPts,
    default: MODEL_CONFIG.homeField.defaultPts,
    unit: 'pts',
  },
  'lenses.conditionsWeight': {
    kind: 'number',
    group: 'lenses',
    label: 'Conditions weight',
    help: 'How strongly wind, rain, snow and cold affect the game. 1 = as fitted, 2 = double.',
    min: 0,
    max: 2,
    step: 0.1,
    default: 1,
    unit: '×',
  },
  'lenses.script.home.pace': scriptControls('home').pace,
  'lenses.script.home.passRate': scriptControls('home').passRate,
  'lenses.script.away.pace': scriptControls('away').pace,
  'lenses.script.away.passRate': scriptControls('away').passRate,
  'adjustments.injuries': {
    kind: 'toggle',
    group: 'adjustments',
    label: 'Injury adjustments',
    help: 'Apply replacement-level and usage changes for injured or inactive players.',
    default: true,
  },
  'adjustments.weather': {
    kind: 'toggle',
    group: 'adjustments',
    label: 'Weather adjustments',
    help: 'Apply wind, precipitation and cold effects.',
    default: true,
  },
  'adjustments.venue': {
    kind: 'toggle',
    group: 'adjustments',
    label: 'Venue adjustments',
    help: 'Apply altitude effects.',
    default: true,
  },
  'adjustments.rest': {
    kind: 'toggle',
    group: 'adjustments',
    label: 'Rest and travel adjustments',
    help: 'Apply short-week, bye and travel effects.',
    default: true,
  },
} as const satisfies Record<string, Control>;

export type SettingsControlPath = keyof typeof SETTINGS_CONTROLS;

/** Game setup and run controls. */
export const GAME_CONTROLS = {
  venue: {
    kind: 'choice',
    group: 'game',
    label: 'Venue',
    help: 'Play the game as scheduled, swap home and away, or at a neutral site.',
    options: [
      { value: 'scheduled', label: 'As scheduled' },
      { value: 'swap', label: 'Swap' },
      { value: 'neutral', label: 'Neutral' },
    ],
    default: 'scheduled',
  },
  nSims: {
    kind: 'choice',
    group: 'game',
    label: 'Sim count',
    help: 'How many times to play the game. 50,000 is slow on phones.',
    options: [
      { value: 1000, label: '1,000' },
      { value: 10000, label: '10,000' },
      { value: 50000, label: '50,000' },
    ],
    default: 10000,
  },
  seed: {
    kind: 'number',
    group: 'game',
    label: 'Seed',
    help: 'Leave blank for a random seed. The same seed, data and settings always give the same result.',
    min: 0,
    max: 0xffffffff,
    step: 1,
  },
} as const satisfies {
  venue: ChoiceControl<string>;
  nSims: ChoiceControl<number>;
  seed: OptionalNumberControl;
};

/** Conditions. No fixed default: blank means "use the snapshot forecast". */
export const CONDITION_CONTROLS = {
  windMph: {
    kind: 'number',
    group: 'conditions',
    label: 'Wind',
    help: 'Sustained wind speed. Effects start at 12 mph.',
    min: 0,
    max: 50,
    step: 1,
    unit: 'mph',
  },
  tempF: {
    kind: 'number',
    group: 'conditions',
    label: 'Temperature',
    help: 'Kickoff temperature.',
    min: -20,
    max: 115,
    step: 1,
    unit: '°F',
  },
  precip: {
    kind: 'choice',
    group: 'conditions',
    label: 'Precipitation',
    help: 'Rain or snow at kickoff.',
    options: [
      { value: 'none', label: 'None' },
      { value: 'light_rain', label: 'Light rain' },
      { value: 'heavy_rain', label: 'Heavy rain' },
      { value: 'light_snow', label: 'Light snow' },
      { value: 'heavy_snow', label: 'Heavy snow' },
    ],
  },
  roof: {
    kind: 'choice',
    group: 'conditions',
    label: 'Roof',
    help: 'Retractable-roof stadiums only. A closed roof turns weather off.',
    options: [
      { value: 'open', label: 'Open' },
      { value: 'closed', label: 'Closed' },
    ],
  },
} as const satisfies {
  windMph: OptionalNumberControl;
  tempF: OptionalNumberControl;
  precip: OptionalChoiceControl<string>;
  roof: OptionalChoiceControl<string>;
};

/** Roster and usage. Usage nudges are deltas in share points (+0.03 = +3 pts). */
export const ROSTER_CONTROLS = {
  status: {
    kind: 'choice',
    group: 'roster',
    label: 'Status',
    help: 'Force a player in or out. Blank = use the injury report (questionable players play in a share of sims).',
    options: [
      { value: 'in', label: 'In' },
      { value: 'out', label: 'Out' },
    ],
  },
  targetShareDelta: {
    kind: 'number',
    group: 'roster',
    label: 'Target share',
    help: 'Nudge this player’s share of team targets. Teammates are rescaled so the team still adds up.',
    min: -0.15,
    max: 0.15,
    step: 0.01,
    default: 0,
  },
  carryShareDelta: {
    kind: 'number',
    group: 'roster',
    label: 'Carry share',
    help: 'Nudge this player’s share of team carries. Teammates are rescaled so the team still adds up.',
    min: -0.15,
    max: 0.15,
    step: 0.01,
    default: 0,
  },
} as const satisfies {
  status: OptionalChoiceControl<string>;
  targetShareDelta: NumberControl;
  carryShareDelta: NumberControl;
};

/** Hard limits on user input that are not individual controls. */
export const INPUT_LIMITS = {
  maxCustomLines: 50,
  /** Custom line values (spreads, totals, props). */
  lineMin: -1000,
  lineMax: 1000,
  lineStep: 0.5,
  /** American odds magnitude. */
  minAbsPrice: 100,
  maxAbsPrice: 100000,
  maxIdLength: 64,
} as const;

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

/** Recursively freezes plain objects and arrays so shared defaults can't be mutated. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function isOnStep(value: number, min: number, step: number): boolean {
  const k = (value - min) / step;
  return Math.abs(k - Math.round(k)) < 1e-6;
}

function numberSchema(c: Omit<NumberControl, 'default'>) {
  return z
    .number()
    .min(c.min)
    .max(c.max)
    .refine((v) => isOnStep(v, c.min, c.step), { message: `must be in steps of ${c.step}` });
}

function choiceSchema<T extends string | number>(c: { options: readonly { value: T }[] }) {
  return z.literal(c.options.map((o) => o.value));
}

const idSchema = z.string().min(1).max(INPUT_LIMITS.maxIdLength);

// ---------------------------------------------------------------------------
// SimSettings
// ---------------------------------------------------------------------------

const C = SETTINGS_CONTROLS;

export const scriptTiltSchema = z.strictObject({
  pace: numberSchema(C['lenses.script.home.pace']),
  passRate: numberSchema(C['lenses.script.home.passRate']),
});

export const simSettingsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  lenses: z.strictObject({
    marketBlend: numberSchema(C['lenses.marketBlend']),
    historyWindow: z.enum(HISTORY_WINDOWS),
    matchupWeight: numberSchema(C['lenses.matchupWeight']),
    streaks: z.boolean(),
    homeFieldPts: numberSchema(C['lenses.homeFieldPts']),
    conditionsWeight: numberSchema(C['lenses.conditionsWeight']),
    script: z.strictObject({
      home: scriptTiltSchema,
      away: scriptTiltSchema,
    }),
  }),
  adjustments: z.strictObject({
    injuries: z.boolean(),
    weather: z.boolean(),
    venue: z.boolean(),
    rest: z.boolean(),
  }),
});

export type SimSettings = z.infer<typeof simSettingsSchema>;
export type ScriptTilt = z.infer<typeof scriptTiltSchema>;

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]!] = value;
}

function buildDefaultSettings(): SimSettings {
  const raw: Record<string, unknown> = { schemaVersion: 1 };
  for (const [path, control] of Object.entries(SETTINGS_CONTROLS)) {
    setPath(raw, path, control.default);
  }
  // Strict parse: fails at load time if a control path and the schema ever disagree.
  return simSettingsSchema.parse(raw);
}

/** House build settings and the starting point for every preset. */
export const DEFAULT_SETTINGS: SimSettings = deepFreeze(buildDefaultSettings());

// ---------------------------------------------------------------------------
// GameOverrides
// ---------------------------------------------------------------------------

const MARKETS_WITH_SIDE_SELECTION: readonly MarketKey[] = [
  'h2h',
  'h2h_h1',
  'spreads',
  'spreads_h1',
];
const MARKETS_WITHOUT_LINE: readonly MarketKey[] = ['h2h', 'h2h_h1', 'player_anytime_td'];

/**
 * Checks that a line's market, selection, side, player and line value fit together.
 * Returns an error message, or null if the shape is valid.
 */
export function lineShapeError(l: {
  market: MarketKey;
  selection: Selection;
  side?: 'home' | 'away' | undefined;
  playerId?: string | undefined;
  line: number | null;
}): string | null {
  const isProp = l.market.startsWith('player_');
  const allowed: readonly Selection[] = MARKETS_WITH_SIDE_SELECTION.includes(l.market)
    ? ['home', 'away']
    : l.market === 'player_anytime_td'
      ? ['yes', 'no']
      : ['over', 'under'];
  if (!allowed.includes(l.selection)) {
    return `selection for ${l.market} must be one of ${allowed.join(', ')}`;
  }
  if (MARKETS_WITHOUT_LINE.includes(l.market) !== (l.line === null)) {
    return MARKETS_WITHOUT_LINE.includes(l.market)
      ? `${l.market} takes no line`
      : `${l.market} needs a line`;
  }
  if ((l.market === 'team_totals') !== (l.side !== undefined)) {
    return l.market === 'team_totals' ? 'team_totals needs a side' : 'side is for team_totals only';
  }
  if (isProp !== (l.playerId !== undefined)) {
    return isProp ? `${l.market} needs a playerId` : 'playerId is for player props only';
  }
  return null;
}

export const customLineSchema = z
  .strictObject({
    market: z.enum(MARKET_KEYS),
    selection: z.enum(SELECTIONS),
    side: z.enum(['home', 'away']).optional(),
    playerId: idSchema.optional(),
    line: z
      .number()
      .min(INPUT_LIMITS.lineMin)
      .max(INPUT_LIMITS.lineMax)
      .refine((v) => isOnStep(v, 0, INPUT_LIMITS.lineStep), {
        message: `lines must be in steps of ${INPUT_LIMITS.lineStep}`,
      })
      .nullable(),
    price: z
      .number()
      .int()
      .refine(
        (p) => Math.abs(p) >= INPUT_LIMITS.minAbsPrice && Math.abs(p) <= INPUT_LIMITS.maxAbsPrice,
        { message: 'American odds must be -100 or lower, or +100 or higher' },
      ),
  })
  .superRefine((l, ctx) => {
    const err = lineShapeError(l);
    if (err) ctx.addIssue({ code: 'custom', message: err });
  });

export type CustomLine = z.infer<typeof customLineSchema>;

const usageNudgeSchema = z.strictObject({
  targetShare: numberSchema(ROSTER_CONTROLS.targetShareDelta).optional(),
  carryShare: numberSchema(ROSTER_CONTROLS.carryShareDelta).optional(),
});

export const gameOverridesSchema = z.strictObject({
  venue: choiceSchema(GAME_CONTROLS.venue),
  /** null = use the snapshot forecast. */
  conditions: z.strictObject({
    windMph: numberSchema(CONDITION_CONTROLS.windMph).nullable(),
    tempF: numberSchema(CONDITION_CONTROLS.tempF).nullable(),
    precip: z.enum(PRECIP_KINDS).nullable(),
    roof: choiceSchema(CONDITION_CONTROLS.roof).nullable(),
  }),
  /** Absent player = use the injury report. */
  roster: z.record(idSchema, choiceSchema(ROSTER_CONTROLS.status)),
  usage: z.record(idSchema, usageNudgeSchema),
  customLines: z.array(customLineSchema).max(INPUT_LIMITS.maxCustomLines),
});

export type GameOverrides = z.infer<typeof gameOverridesSchema>;

export const DEFAULT_OVERRIDES: GameOverrides = deepFreeze(
  gameOverridesSchema.parse({
    venue: GAME_CONTROLS.venue.default,
    conditions: { windMph: null, tempF: null, precip: null, roof: null },
    roster: {},
    usage: {},
    customLines: [],
  }),
);

// ---------------------------------------------------------------------------
// RunRequest
// ---------------------------------------------------------------------------

export const simCountSchema = choiceSchema(GAME_CONTROLS.nSims);
export type SimCount = z.infer<typeof simCountSchema>;

export const seedSchema = z.number().int().min(GAME_CONTROLS.seed.min).max(GAME_CONTROLS.seed.max);

export const runRequestSchema = z.strictObject({
  snapshotId: idSchema,
  gameId: idSchema,
  engineVersion: idSchema,
  settings: simSettingsSchema,
  overrides: gameOverridesSchema,
  nSims: simCountSchema,
  /** Already resolved; "auto" never reaches a RunRequest. */
  seed: seedSchema,
});

export type RunRequest = z.infer<typeof runRequestSchema>;

// ---------------------------------------------------------------------------
// Parse helpers (throw a ZodError on invalid input)
// ---------------------------------------------------------------------------

export const parseSimSettings = (input: unknown): SimSettings => simSettingsSchema.parse(input);
export const parseGameOverrides = (input: unknown): GameOverrides =>
  gameOverridesSchema.parse(input);
export const parseRunRequest = (input: unknown): RunRequest => runRequestSchema.parse(input);
