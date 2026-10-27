/**
 * Fixed engine constants. NOT user-editable.
 *
 * This is the one place for every tunable number in the model. Nothing in the engine,
 * jobs or pipeline may hard-code a value that belongs here.
 *
 * - User-control ranges and defaults live in settings.schema.ts (except home-field range,
 *   which the brief puts here; the schema imports it).
 * - Fitted league baselines (yardage histograms, league-average rates) live in the snapshot,
 *   not here, so they are versioned with the data.
 * - `jobs/exportConfig.ts` writes this object to pipeline/model_config.json so Python reads
 *   the same values. CI fails if that file is stale.
 * - Values marked "start" are starting points, to be tuned by calibration (step 4) and
 *   backtest (step 8). Any change that alters sim output must bump ENGINE_VERSION.
 *
 * Sections still to come: play-call model and clock/pace (step 3), fourth-down and 2-pt
 * decision tables (step 3).
 */

export const MODEL_CONFIG = {
  configVersion: 1,

  /** Parameter fitting (pipeline). */
  fitting: {
    /** History windows the pipeline publishes. Must match HISTORY_WINDOWS in types.ts. */
    historyWindows: ['season', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'],
    /** Season window: weight of a game halves every N games back. start */
    recencyHalfLifeGames: 8,
    /** Ridge penalty for opponent adjustment, in plays (one game is roughly 30-35 plays per unit). start */
    ridgeLambdaPlays: 200,
    /** Fewer games than this in a window -> params for that window are omitted. */
    minTeamGamesPerWindow: 2,
    minPlayerGamesPerWindow: 2,
    /** Early season: prior-season data counts as this many games, fading as games are played. start */
    priorSeasonCarryoverGames: 4,
    /** Thresholds that define "explosive" plays. */
    explosivePassYds: 20,
    explosiveRunYds: 10,
    /** Expected pass-rate grid distance buckets (upper bounds, yards). Last bucket = longer. */
    passRateDistanceBuckets: [2, 4, 7, 10, 15],
    /** Field zones, in yards from the opponent's goal line. */
    redZoneYardline: 20,
    goalLineYardline: 5,
    /** "Neutral" game state for pace, PROE and the pass-rate grid. */
    neutral: { wpMin: 0.2, wpMax: 0.8, maxQuarter: 3 },
    /** Gaps between snaps longer than this (seconds) are not pace (injuries, reviews). */
    paceMaxGapSec: 60,
    /** Integer-yard histogram ranges [min, max]; values outside go to the end bins. */
    histograms: {
      completionYds: [-10, 99],
      runYds: [-10, 99],
      scrambleYds: [-5, 99],
      sackYds: [-25, 0],
      puntNetYds: [-10, 80],
      kickoffStartYardline: [1, 99],
    },
    /** Punts used for the net-yards histogram: snapped at least this far from the opponent goal. */
    puntHistogramMinYardline: 60,
    /** Kicks shorter than this are treated as onside or squib attempts and left out. */
    kickoffMinDistance: 40,
    /** A player whose playProb is below this counts as "out" for starter-injury counts. */
    starterOutPlayProb: 0.5,
    /** Decimal places for floats written to the snapshot (size). */
    snapshotDecimals: 4,
  },

  /** Shrinkage toward league average: adjusted = (n*observed + k*league) / (n + k). */
  shrinkage: {
    /** Defense vs position, in targets. start */
    dvpTargetsK: 60,
    /** Player efficiency, in opportunities. start */
    receiverTargetsK: 50,
    rusherCarriesK: 75,
    qbDropbacksK: 150,
    kickerAttemptsK: 30,
  },

  /** Rules of the game. */
  rules: {
    quarterSec: 900,
    timeoutsPerHalf: 3,
    /** Kicking team kicks from its own 35. */
    kickoffFromYardline: 35,
    /** Kickoff touchback spot (2025 rules): receiving team's 35. */
    kickoffTouchbackYardline: 35,
    /** Punt touchback spot: receiving team's 20. */
    puntTouchbackYardline: 20,
    /** Free kick after a safety is from the kicking team's 20. */
    safetyFreeKickFromYardline: 20,
    /** PAT kick snapped from the 15 (offense yardline 85). */
    patKickYardline: 85,
    /** Two-point try from the 2 (offense yardline 98). */
    twoPointYardline: 98,
    /** FG distance = yards to goal line + this (end zone + hold). */
    fgDistanceOffsetYds: 17,
    overtime: {
      /** Both teams get a possession unless the first ends in a defensive score. */
      bothTeamsPossess: true,
      regularSeason: { periodSec: 600, timeouts: 2, tiesAllowed: true, maxPeriods: 1 },
      postseason: { periodSec: 900, timeouts: 3, tiesAllowed: false, maxPeriods: 99 },
    },
  },

  /** Kicking. */
  kicking: {
    /** FG make probability = logistic(intercept + slopePerYard * distance). start */
    fgCurve: { intercept: 6.18, slopePerYard: -0.098 },
    maxFgDistance: 66,
    /** start */
    xpMakeRate: 0.95,
  },

  /** Injuries and roster. */
  injuries: {
    /** Probability a player plays, by report status. start */
    playProbByStatus: {
      active: 1,
      questionable: 0.8,
      doubtful: 0.2,
      out: 0,
      ir: 0,
      inactive: 0,
    },
    /** QB with no usable data of his own: EPA/dropback vs league average. start */
    qbReplacementEpaPerDropback: -0.15,
    /** Per offensive-line starter out. start */
    olStarterOut: { sackRateMult: 1.06, runEpaDelta: -0.01 },
    /** Per secondary starter out (applied to the defense). start */
    secondaryStarterOut: { passEpaAllowedDelta: 0.015 },
  },

  /** Weather. All effects are multiplied by the user's conditionsWeight lens. */
  weather: {
    /** Wind effects start here and reach full strength here (sustained mph). */
    windStartMph: 12,
    windFullMph: 25,
    /** Effects at full wind. start */
    windFull: { completionRateDelta: -0.05, passYdsTiltDelta: -0.08, fgLogitDelta: -0.9 },
    /** FG wind effect grows with distance: multiplier = distance / this. */
    fgWindReferenceDistance: 45,
    precip: {
      light: { completionRateDelta: -0.01, fumbleRateMult: 1.1 },
      heavy: { completionRateDelta: -0.03, fumbleRateMult: 1.25 },
    },
    /** Snow adds this on top of the precip effect. start */
    snowExtra: { runYdsTiltDelta: -0.03 },
    coldThresholdF: 25,
    cold: { completionRateDelta: -0.01, fgLogitDelta: -0.15 },
  },

  /** Venue. */
  venue: {
    altitudeThresholdFt: 5000,
    /** Points equivalent against the visitor. start */
    altitudeVisitorPenaltyPts: 0.5,
  },

  /** Rest and travel, in points equivalent. start */
  rest: {
    /** Rest days at or below this = short week. */
    shortWeekMaxDays: 4,
    shortWeekPenaltyPts: 0.5,
    /** Rest days at or above this = coming off a bye. */
    byeMinDays: 13,
    byeBonusPts: 0.5,
    longTravelMiles: 2000,
    longTravelPenaltyPts: 0.25,
    tzShiftPenaltyPtsPerHour: 0.1,
  },

  /** Home-field lens range (user control, range set here per the brief). */
  homeField: { minPts: 0, maxPts: 4, stepPts: 0.25, defaultPts: 1.5 },

  /** Streaks lens. The house build uses streaks only if the backtest supports it. */
  streaks: { houseUsesStreaks: false },

  /** Pricing, edges and stakes. */
  markets: {
    /** Ascending. Edge = sim probability - no-vig probability. */
    edgeTiers: [
      { id: 'lean', minEdge: 0.03 },
      { id: 'play', minEdge: 0.05 },
      { id: 'strong', minEdge: 0.08 },
    ],
    kellyFraction: 0.25,
    /** Max suggested stake as a fraction of bankroll. */
    maxStakeFraction: 0.03,
    preferredSharpBook: 'pinnacle',
    /** |market-implied share - historical share| above this flags a role change. */
    roleChangeShareThreshold: 0.05,
    /** Volume props are leaderboard-ineligible when market blend is above this. */
    volumePropMaxMarketBlend: 0.5,
    volumePropMarkets: [
      'player_receptions',
      'player_pass_attempts',
      'player_pass_completions',
      'player_rush_attempts',
    ],
  },

  /** The Odds API budget. */
  oddsApi: {
    regions: ['us', 'eu'],
    /** Jobs abort if remaining credits fall below this. */
    creditFloor: 100,
    monthlyCreditTarget: 1500,
  },

  /** Locks and leaderboard. */
  locks: {
    maxPerUserPerSlate: 25,
    /** Stored sim probability must match the re-run within this (rounding only). */
    verifyProbTolerance: 1e-9,
  },
  leaderboard: { minPicks: 20 },
} as const;

export type ModelConfig = typeof MODEL_CONFIG;
