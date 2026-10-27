/**
 * Shared types for the ReRun engine, pipeline output (snapshot) and jobs.
 *
 * Conventions (see docs/proposals/phase1-steps1-3.md §3):
 * - Ids are nflverse ids: TeamAbbr "KC", PlayerId gsis id "00-0033873", GameId "2026_09_KC_BUF".
 * - yardline = yards from the offense's OWN goal line (1..99). Distance to a TD = 100 - yardline.
 * - clockSec = seconds left in the current quarter.
 * - Probabilities and shares are 0..1. Prices are American odds integers (-115, +130).
 * - These are boundary types. The hot sim loop uses its own mutable, index-based structures.
 *
 * SimSettings, GameOverrides and RunRequest are inferred from the zod schemas in
 * config/settings.schema.ts and re-exported at the bottom of this file.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type TeamAbbr = string;
export type PlayerId = string;
export type GameId = string;
/** e.g. "2026-W09-v3" */
export type SnapshotId = string;
export type AmericanOdds = number;
export type Side = 'home' | 'away';

export const HISTORY_WINDOWS = ['season', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'] as const;
export type HistoryWindow = (typeof HISTORY_WINDOWS)[number];

export const POSITIONS = ['QB', 'RB', 'FB', 'WR', 'TE', 'K', 'P'] as const;
export type Position = (typeof POSITIONS)[number];

export const INJURY_STATUSES = [
  'active',
  'questionable',
  'doubtful',
  'out',
  'ir',
  'inactive',
] as const;
export type InjuryStatus = (typeof INJURY_STATUSES)[number];

/** Defense-vs-position buckets, assigned by target-share rank within the team. */
export const DVP_BUCKETS = ['WR1', 'WR2', 'WR3', 'TE', 'RB'] as const;
export type DvpBucket = (typeof DVP_BUCKETS)[number];

/** The Odds API market keys, so the odds fetcher needs no mapping. */
export const MARKET_KEYS = [
  'h2h',
  'spreads',
  'totals',
  'team_totals',
  'h2h_h1',
  'spreads_h1',
  'totals_h1',
  'player_pass_yds',
  'player_pass_tds',
  'player_pass_attempts',
  'player_pass_completions',
  'player_pass_interceptions',
  'player_rush_yds',
  'player_rush_attempts',
  'player_receptions',
  'player_reception_yds',
  'player_anytime_td',
] as const;
export type MarketKey = (typeof MARKET_KEYS)[number];

export const SELECTIONS = ['home', 'away', 'over', 'under', 'yes', 'no'] as const;
export type Selection = (typeof SELECTIONS)[number];

export const PRECIP_KINDS = [
  'none',
  'light_rain',
  'heavy_rain',
  'light_snow',
  'heavy_snow',
] as const;
export type Precip = (typeof PRECIP_KINDS)[number];

// ---------------------------------------------------------------------------
// Team params (pipeline/fit_team_params.py)
// ---------------------------------------------------------------------------

export interface TeamParams {
  team: TeamAbbr;
  window: HistoryWindow;
  /** Games in the window (sample size). */
  games: number;
  /** What the offense produces. */
  off: UnitParams;
  /** What the defense allows. */
  def: UnitParams;
  /** Pass rate over expected, e.g. +0.04. */
  proe: number;
  /** Neutral-situation seconds per play. */
  neutralSecPerPlay: number;
  noHuddleRate: number;
}

/** Opponent-adjusted (ridge), recency-weighted. Rates are per play of that type. */
export interface UnitParams {
  passEpa: number;
  runEpa: number;
  passSuccess: number;
  runSuccess: number;

  // Pass play components (per dropback unless noted)
  sackRate: number;
  scrambleRate: number;
  /** Per attempt. */
  intRate: number;
  /** Per attempt. */
  completionRate: number;
  /** Exponential tilt of the league completion-yards histogram. 0 = league average. */
  passYdsTilt: number;
  /** Completions of 20+ yards per attempt. */
  explosivePassRate: number;

  // Run play components
  runYdsTilt: number;
  /** Runs of 10+ yards per carry. */
  explosiveRunRate: number;
  /** Fumbles lost per play. */
  fumbleLostRate: number;

  /** TDs per red-zone trip. */
  redZoneTdRate: number;
  penaltyYdsPerPlay: number;
}

export interface DvpLine {
  targetsPerGame: number;
  yardsPerTarget: number;
  /** Targets observed. Shrinkage toward league is applied in the engine (k in config). */
  n: number;
}
export type DefVsPos = Record<DvpBucket, DvpLine>;

// ---------------------------------------------------------------------------
// Player params (pipeline/fit_player_params.py)
// ---------------------------------------------------------------------------

export interface PlayerParams {
  playerId: PlayerId;
  window: HistoryWindow;
  games: number;
  snapShare: number;
  /** Routes run / team dropbacks (estimated from snaps + pbp). */
  routeShare: number;
  targetShare: number;
  airYardsShare: number;
  carryShare: number;
  rzTargetShare: number;
  rzCarryShare: number;
  /** Carries inside the 5. */
  glCarryShare: number;
  catchRate: number;
  yardsPerTarget: number;
  /** Tilt of the league completion-yards histogram for this receiver. */
  recYdsTilt: number;
  yardsPerCarry: number;
  rushYdsTilt: number;
  qb?: QbParams;
  kicker?: KickerParams;
}

export interface QbParams {
  dropbacks: number;
  completionRate: number;
  yardsPerAttempt: number;
  passYdsTilt: number;
  sackRate: number;
  intRate: number;
  scrambleRate: number;
  /** QB share of the team's designed carries. */
  designedRunShare: number;
}

export interface KickerParams {
  fgAttempts: number;
  /** Vs the config FG curve, already shrunk. */
  fgMakeOverExpected: number;
  xpRate: number;
}

/** One entry per player on an active roster this slate. */
export interface PlayerEntry {
  playerId: PlayerId;
  name: string;
  team: TeamAbbr;
  position: Position;
  /** 1 = starter at his position (nflverse depth chart). */
  depth: number;
  dvpBucket: DvpBucket | null;
  status: InjuryStatus;
  /** From status via config; drives the questionable mixture. */
  playProb: number;
  /** A missing window means too few games in it. */
  params: Partial<Record<HistoryWindow, PlayerParams>>;
  /** Starter efficiency minus next man up (EPA/play). */
  replacementDelta: number | null;
}

// ---------------------------------------------------------------------------
// Slate snapshot (pipeline/build_snapshot.py)
// ---------------------------------------------------------------------------

export interface SlateSnapshot {
  schemaVersion: 1;
  id: SnapshotId;
  season: number;
  week: number;
  seasonType: 'REG' | 'POST';
  version: number;
  /** ISO timestamp. */
  createdAt: string;
  /** Hash of model_config.json the pipeline used. */
  configHash: string;
  dataAsOf: {
    nflverse: string;
    injuries: string;
    odds: string | null;
    weather: string | null;
  };
  league: Record<HistoryWindow, LeagueParams>;
  teams: Record<TeamAbbr, TeamEntry>;
  players: Record<PlayerId, PlayerEntry>;
  games: SnapshotGame[];
}

/** Integer-yard histogram: probs[i] = P(yards = min + i). The last bin is "this many or more". */
export interface YardHistogram {
  min: number;
  probs: number[];
}

export interface LeagueParams {
  completionYds: YardHistogram;
  runYds: YardHistogram;
  scrambleYds: YardHistogram;
  sackYds: YardHistogram;
  puntNetYds: YardHistogram;
  /** Receiving team's starting yardline after a returned kickoff (no touchback). */
  kickoffStartYardline: YardHistogram;
  /** League average, same fields as a team unit. */
  rates: UnitParams;
  /** Expected pass rate grid [down - 1][distance bucket]; buckets defined in config. */
  passRateByDownDist: number[][];
  /** League average; the shrinkage target. */
  dvp: DefVsPos;
  specialTeams: LeagueSpecialTeams;
}

export interface LeagueSpecialTeams {
  /** Per kickoff (excluding onside/squib). */
  kickoffTouchbackRate: number;
  kickoffReturnTdRate: number;
  /** Per punt. */
  puntReturnTdRate: number;
  puntTouchbackRate: number;
  /** Per field-goal attempt. */
  fgBlockRate: number;
}

export interface TeamForm {
  /** + wins, - losses. */
  winStreak: number;
  atsStreak: number;
}

export interface TeamEntry {
  team: TeamAbbr;
  params: Record<HistoryWindow, TeamParams>;
  dvp: Record<HistoryWindow, DefVsPos>;
  /** Ordered, starter first. */
  depthChart: Partial<Record<Position, PlayerId[]>>;
  /** Starters out; config weights turn these into adjustments. */
  olInjuryCount: number;
  secondaryInjuryCount: number;
  /** Only read when the streaks lens is on. */
  form: TeamForm;
}

export interface StadiumFacts {
  stadiumId: string;
  name: string;
  lat: number;
  lon: number;
  roof: 'outdoors' | 'dome' | 'retractable';
  surface: 'grass' | 'turf';
  altitudeFt: number;
  /** IANA time zone. */
  tz: string;
}

export interface WeatherForecast {
  source: 'nws' | 'open-meteo';
  /** Sustained. */
  windMph: number;
  gustMph: number | null;
  tempF: number;
  precip: Precip;
  /** Retractable roofs only. */
  roofExpected: 'open' | 'closed' | null;
}

export interface BookPrice {
  book: string;
  price: AmericanOdds;
}

export interface MarketLine {
  market: MarketKey;
  selection: Selection;
  /** Team totals only: which team's total. */
  side?: Side;
  /** Player props only. */
  playerId?: PlayerId;
  /** null for moneyline and yes/no markets. */
  line: number | null;
  prices: BookPrice[];
  best: BookPrice;
  noVigProb: number | null;
  noVigSource: 'pinnacle' | 'consensus' | null;
}

export interface MarketUsage {
  /** Implied means. */
  receptions?: number;
  receivingYds?: number;
  rushAttempts?: number;
  passAttempts?: number;
  impliedTargetShare?: number;
  impliedCarryShare?: number;
  /** |implied - historical| share > config threshold. */
  roleChange: boolean;
}

export interface SnapshotGame {
  gameId: GameId;
  /** ISO timestamp. */
  kickoff: string;
  home: TeamAbbr;
  away: TeamAbbr;
  /** in_progress and final games are excluded from pricing. */
  status: 'scheduled' | 'in_progress' | 'final';
  neutralSite: boolean;
  stadium: StadiumFacts;
  /** null for domes. */
  weather: WeatherForecast | null;
  context: {
    restDays: Record<Side, number>;
    awayTravelMiles: number;
    /** Hours. */
    awayTzShift: number;
  };
  market: MarketLine[];
  marketUsage: Record<PlayerId, MarketUsage>;
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

export interface GameState {
  /** 5 = overtime. */
  quarter: 1 | 2 | 3 | 4 | 5;
  clockSec: number;
  /** false after incompletions, out-of-bounds, scores, timeouts. */
  clockRunning: boolean;
  phase: 'kickoff' | 'scrimmage' | 'pat' | 'final';
  possession: Side;
  down: 1 | 2 | 3 | 4;
  /** Yards to a first down (goal-to-go: 100 - yardline). */
  distance: number;
  /** From the offense's own goal line, 1..99. */
  yardline: number;
  score: Record<Side, number>;
  timeouts: Record<Side, number>;
  secondHalfReceiver: Side;
  ot: OvertimeState | null;
  driveIndex: number;
  playIndex: number;
}

/**
 * Current NFL rules (2025+): both teams get a possession unless the first ends in a
 * defensive score; then sudden death. Period length and tie rules live in config.
 */
export interface OvertimeState {
  firstPossession: Side;
  possessed: Record<Side, boolean>;
  suddenDeath: boolean;
}

// ---------------------------------------------------------------------------
// Play outcome
// ---------------------------------------------------------------------------

interface OutcomeBase {
  /** Time this play took off the clock, including runoff before the snap. */
  clockSec: number;
  stopsClock: boolean;
  timeoutBy?: Side;
}

export type PlayOutcome = OutcomeBase &
  (
    | {
        kind: 'pass';
        result: 'complete' | 'incomplete';
        passer: PlayerId;
        target: PlayerId;
        yards: number;
        outOfBounds: boolean;
        fumbleLost: boolean;
        td: boolean;
      }
    | {
        kind: 'interception';
        passer: PlayerId;
        target: PlayerId;
        returnYards: number;
        defensiveTd: boolean;
      }
    | { kind: 'sack'; passer: PlayerId; yards: number; fumbleLost: boolean; safety: boolean }
    | {
        kind: 'scramble';
        passer: PlayerId;
        yards: number;
        outOfBounds: boolean;
        fumbleLost: boolean;
        td: boolean;
      }
    | {
        kind: 'run';
        rusher: PlayerId;
        yards: number;
        outOfBounds: boolean;
        fumbleLost: boolean;
        td: boolean;
        safety: boolean;
      }
    | { kind: 'punt'; punter: PlayerId; netYards: number; touchback: boolean; returnTd: boolean }
    | { kind: 'fieldGoal'; kicker: PlayerId; distance: number; made: boolean }
    | { kind: 'kickoff'; touchback: boolean; receiveYardline: number; returnTd: boolean }
    | { kind: 'pat'; type: 'kick' | 'twoPoint'; success: boolean }
    | { kind: 'kneel' }
    | { kind: 'spike' }
    | {
        kind: 'penalty';
        against: 'offense' | 'defense';
        yards: number;
        automaticFirstDown: boolean;
        replayDown: boolean;
      }
  );

/** Only produced when Replay re-sims one sim index. */
export interface PlayRecord {
  before: GameState;
  outcome: PlayOutcome;
}

// ---------------------------------------------------------------------------
// Per-sim result
// ---------------------------------------------------------------------------

export interface PlayerGameLine {
  playerId: PlayerId;
  passAtt: number;
  passCmp: number;
  passYds: number;
  passTd: number;
  passInt: number;
  rushAtt: number;
  rushYds: number;
  rushTd: number;
  targets: number;
  rec: number;
  recYds: number;
  recTd: number;
}

export interface TeamGameLine {
  passAtt: number;
  rushAtt: number;
  yards: number;
  turnovers: number;
}

/** What each simulated game hands to aggregation. No play list. */
export interface SimGameResult {
  simIndex: number;
  final: Record<Side, number>;
  firstHalf: Record<Side, number>;
  overtime: boolean;
  plays: number;
  team: Record<Side, TeamGameLine>;
  /** Players who recorded anything. */
  players: PlayerGameLine[];
}

// ---------------------------------------------------------------------------
// Settings types (inferred from zod; defined in config/settings.schema.ts)
// ---------------------------------------------------------------------------

export type {
  SimSettings,
  ScriptTilt,
  GameOverrides,
  CustomLine,
  RunRequest,
  SimCount,
} from './config/settings.schema';
