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
 * Sections are tuned by the calibration tests in step 4 (engine/test/calibration.test.ts).
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
    /** Completion/run/scramble histograms use open-field plays only: outside the red zone (the
     *  engine's redZone shifts cover it) and, for runs, not short yardage (sneaks, stacked boxes). */
    histogramRunMinYdsToGo: 3,
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

  /** Play calling. Expected pass rate comes from the snapshot's neutral down/distance grid. */
  playCall: {
    /** Team PROE is added to the expected pass rate (probability points), times this. */
    proeWeight: 1,
    /** User pass-rate tilt of +1 adds this to the expected pass rate. */
    passRateTiltPerUnit: 0.08,
    /**
     * Game script: logit shift = perPt * scoreDiff * (elapsed game fraction)^power, with separate
     * slopes when leading and trailing (leading teams lean on the run far more than trailing
     * teams lean on the pass). Fitted by logistic regression on 2023-2025 play-by-play.
     */
    scoreLeadingLogitPerPt: -0.156,
    scoreTrailingLogitPerPt: -0.047,
    scoreDiffTimePower: 4,
    /** Hurry-up: last 2 min of the first half (anyone), last 5 min of the game if trailing/tied. */
    hurryUpSecLeft: { firstHalf: 120, secondHalf: 300 },
    hurryUpPassLogit: 0.99,
    /** Pass-rate bounds, so no situation is ever a certainty. */
    minPassRate: 0.03,
    maxPassRate: 0.97,
  },

  /** Clock and pace. All seconds. */
  clock: {
    /** Time each play takes from snap to whistle. */
    playDurationSec: {
      run: 5,
      passComplete: 6,
      passIncomplete: 5,
      interception: 7,
      sack: 5,
      scramble: 6,
      punt: 9,
      fieldGoal: 5,
      kickoffReturn: 6,
      kneel: 2,
      spike: 1,
    },
    /** Average snap-to-whistle time, subtracted from snap-to-snap pace to get the runoff. */
    averagePlaySec: 5.5,
    /** User pace tilt of +1 cuts seconds-per-play by this fraction. */
    paceTiltFraction: 0.15,
    /** Snap-to-snap seconds in hurry-up, and when milking a lead late. */
    hurryUpSecPerSnap: 17,
    milkSecPerSnap: 44,
    /** Leading in the 4th quarter with this little time left: milk the clock. */
    milkSecLeft: 600,
    twoMinuteWarningSec: 120,
    /** Out of bounds stops the clock only in these final seconds of each half. */
    outOfBoundsStopsSecLeft: { firstHalf: 120, secondHalf: 300 },
    outOfBoundsRate: { run: 0.06, completion: 0.18, scramble: 0.3 },
    /** Each kneel burns this many seconds if the defense cannot stop the clock. */
    kneelBurnSec: 42,
    /** Defense trailing late uses timeouts to stop the clock. */
    defenseTimeoutSecLeft: 180,
    /** Offense in hurry-up uses timeouts when the clock is running. */
    offenseTimeoutSecLeft: 60,
    /** Spike when trailing, no timeouts, clock running and at most this much time left. */
    spikeSecLeft: 25,
  },

  /** Points-equivalent adjustments (home field, rest, travel...) become efficiency shifts.
   *  Per point of advantage given to an offense. Tuned in step 4 so 1 pt ~ 1 pt of margin. */
  pointsToEfficiency: {
    passYdsTiltPerPt: 0.0028,
    runYdsTiltPerPt: 0.004,
    completionLogitPerPt: 0.012,
  },

  /** Passing by situation: early downs (play action, fewer sacks) vs 3rd/4th down by yards to
   *  go (more sacks and incompletions, least of all on very short and very long). Logit shifts vs
   *  the all-situations rate, measured on 2023-2025 open-field play-by-play. */
  passBySituation: {
    earlyDowns: { completionLogit: 0.1, sackLogit: -0.22, intLogit: -0.12 },
    lateDownDistanceUpper: [3, 6, 10, 99],
    lateDowns: {
      completionLogit: [-0.15, -0.27, -0.39, -0.04],
      sackLogit: [0.11, 0.37, 0.55, 0.45],
      intLogit: [0.16, 0.18, 0.32, 0.36],
      /** Throws aimed at the sticks: a completion that would fall short of the line to gain is
       *  instead caught at or just past it (0-2 yards) this often. Sized from 3rd/4th-down
       *  conversion rates by distance (2023-2025). */
      sticksCatchRate: [0, 0.2, 0.32, 0.08],
    },
  },

  /** Inside the opponent's 20 the field is compressed: shorter gains, lower completion odds.
   *  Retuned on 2025-2026 games (jobs/seasonStats.ts vs pipeline/season_stats.py) to the real
   *  red-zone TD rate per trip (58.7%); the earlier values gave 56%. */
  redZone: {
    passYdsTiltShift: -0.0245,
    runYdsTiltShift: -0.028,
    completionLogitShift: -0.084,
  },

  /**
   * Late-game script efficiency: in the last minutes, teams nursing a one-score lead (or tied)
   * play it safe, teams down two scores face prevent defenses, and teams down three scores fade.
   * Points-equivalent shift on the offense, by score bucket (offense minus defense; upper
   * bounds), times (elapsed fraction)^timePower so it only bites late in the 4th quarter.
   * Applied in steps of ptsPerLevel, up to maxLevel steps either way.
   */
  gameScript: {
    diffUpper: [-17, -9, -1, 0, 8, 16, 99],
    ptsShift: [-5, 7, 2, -3, -6, 0, 0],
    timePower: 8,
    ptsPerLevel: 1.5,
    maxLevel: 6,
  },

  /** Usage. Real per-game shares swing more than a fixed share implies (game plan, rotation,
   *  in-game injuries): each sim multiplies every player's share by a lognormal factor with
   *  this sd (then renormalizes). Tuned on RB1 carries and top-target lines (step 4). */
  usage: {
    shareNoiseSd: 0.15,
    /** Depth-chart starters' historical shares get this bonus before teammates are rescaled
     *  (role changes and absent teammates' work flow to the starter first). Fitted by
     *  likelihood on 2023-2025 calibration weeks: carries go to the RB1, targets to any
     *  position's starter. */
    starterCarryBonus: 0.25,
    starterTargetBonus: 0.05,
  },

  /** Penalties, drawn before each snap. Rates come from team penalty yards per snap. */
  penalties: {
    /** Yardage mixes and first-down share measured on 2023-2025 play-by-play. */
    offense: { yards: [5, 10, 15], probs: [0.592, 0.344, 0.064] },
    defense: { yards: [5, 10, 15, 25], probs: [0.551, 0.089, 0.265, 0.095] },
    /** Share of defensive penalties that give an automatic first down. */
    defenseAutoFirstDownRate: 0.78,
    /** Team penalty yards per snap become a per-snap rate via the mean yards above; these
     *  scales correct that conversion so penalty counts per game match 2023-2025 (step 4). */
    offenseRateScale: 0.92,
    defenseRateScale: 0.87,
  },

  /** Turnovers. */
  turnovers: {
    /** Interceptions happen this far downfield from the line of scrimmage. */
    interceptionDepthYds: 12,
    interceptionReturnMeanYds: 10,
    pickSixRate: 0.07,
    sackFumbleLostRate: 0.035,
  },

  /** Punts. The net-yards histogram comes from open-field punts; near the goal line: */
  punts: {
    /** A punt whose net distance reaches the end zone is a touchback this often... */
    overshootTouchbackRate: 0.45,
    /** ...otherwise it is downed or fair-caught at this receiving yardline. */
    pinnedYardline: 10,
  },

  /** Fourth down. Rows by field zone (offense yardline upper bound), columns by yards to go
   *  bucket (upper bounds). Values = probability of going for it. */
  fourthDown: {
    zoneUpperYardline: [39, 59, 79, 99],
    ydsToGoUpper: [1, 2, 4, 7, 99],
    /** Real go rates 2024-2026 outside the last 5 minutes and end-of-half kicks
     *  (teams now go for it much more on 4th-and-short, at midfield and at the goal line). */
    goProb: [
      [0.37, 0.06, 0.05, 0.03, 0.01],
      [0.85, 0.49, 0.31, 0.11, 0.04],
      [0.9, 0.55, 0.4, 0.15, 0.05],
      [0.92, 0.59, 0.28, 0.07, 0.04],
    ],
    /** Longest FG a team normally attempts (yards). */
    maxFgDistance: 57,
    /** Trailing by more than a field goal in the 4th/OT with this little time: always go. */
    desperationSecLeft: 300,
    /** Kick a FG on any down with this little time left in a half (if it helps). */
    endOfHalfFgSecLeft: 12,
  },

  /** Points after touchdown. */
  pat: {
    twoPointSuccessRate: 0.48,
    /** Go for two at a random rate, plus always in the 4th quarter/OT when the score
     *  difference after the TD (offense minus defense) is in this list. */
    twoPointBaseRate: 0.05,
    twoPointLateDiffs: [-2, -5, -10, -16, 1],
  },

  /** Kickoffs beyond the fitted league rates. */
  kickoffs: {
    /** Onside kick when trailing by at most this many points in the last N seconds. */
    onsideMaxDeficit: 16,
    onsideSecLeft: 180,
    onsideRecoveryRate: 0.12,
    /** Kicking team's yardline after recovering an onside kick. */
    onsideRecoveredYardline: 45,
    /** Receiving team's yardline after a free kick following a safety. */
    safetyKickStartYardline: 40,
  },

  /** Kicking. */
  kicking: {
    /** FG make probability = logistic(intercept + slopePerYard * distance). start */
    fgCurve: { intercept: 6.18, slopePerYard: -0.098 },
    maxFgDistance: 66,
    /** start */
    xpMakeRate: 0.96,
  },

  /**
   * Injuries and roster. Measured values come from pipeline/measure_adjustments.py (2022-2025);
   * see docs/adjustments.md. Applied when adjustments.injuries is on.
   */
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
    /**
     * QB with no usable data of his own: EPA/dropback vs league average. Used by the pipeline for
     * each QB's replacementDelta (shown in the UI). Measured: -0.127.
     */
    qbReplacementEpaPerDropback: -0.13,
    /**
     * A QB starting in place of the team's usual QB plays like a backup: his own numbers are
     * shrunk toward league average + these (instead of league average), with the same k as the
     * pipeline (shrinkage.qbDropbacksK). A QB with no data gets exactly these. Logits vs league;
     * yards per completion in yards. Measured on 16,926 non-starter dropbacks.
     */
    backupQb: {
      completionLogit: -0.1,
      sackLogit: 0.13,
      intLogit: 0.25,
      scrambleLogit: 0,
      yardsPerCompletion: -0.59,
    },
    /**
     * Per offensive-line starter out (report status out/doubtful). Measured per starter missing:
     * sack logit +0.021 (se 0.021), yards per carry -0.074 (se 0.035), completions no effect.
     */
    olStarterOut: { sackLogit: 0.02, yardsPerCarry: -0.07 },
    /**
     * Per secondary starter out, applied to the passing his defense allows. Measured:
     * completion logit +0.042 (se 0.013), yards per completion no effect.
     */
    secondaryStarterOut: { completionLogit: 0.04 },
    /**
     * Where an out player's targets or carries go. This fraction stays with his position group
     * (WR, TE, RB), split evenly among the available players there (backups take the snaps); the
     * rest goes to everyone else in proportion to their shares. Proportional reallocation alone
     * would keep about 0.50 (WR), 0.08 (TE), 0.05 (RB targets) and 0.77 (RB carries).
     */
    outShareKeptInPosition: {
      targets: { WR: 0.8, TE: 0.55, RB: 0.53 },
      carries: { RB: 0.99 },
    },
  },

  /**
   * Weather, measured on outdoor plays with each offense's and defense's season averages taken
   * out (docs/adjustments.md). Effects are kept at the measured value when at least 1.5 standard
   * errors from zero, else 0; FG wind is kept at its estimate because its direction is physical.
   * All effects are multiplied by the user's conditionsWeight lens. Domes and closed roofs: none.
   */
  weather: {
    /** Wind effects start here and reach full strength here (sustained mph), linearly. */
    windStartMph: 12,
    windFullMph: 25,
    /**
     * At full wind. Measured: completion logit -0.174 (se 0.083); yards per completion -0.64
     * (se 0.49, not kept); FG logit -0.57 at 45 yards (se 0.85).
     */
    windFull: { completionLogit: -0.17, yardsPerCompletion: 0, fgLogitAtReference: -0.57 },
    /** FG wind effect scales with distance: effect x distance / this. */
    fgWindReferenceDistance: 45,
    /**
     * By precipitation. light_rain is the measured "rain" effect (completion logit -0.081
     * se 0.039; yards per completion -0.48 se 0.23; yards per carry -0.22 se 0.13). Snow had too
     * few plays to measure and uses the rain values. Heavy = 2x light: an assumption (play-by-play
     * does not record intensity). No precipitation effect on fumbles was found (+0.0001/play).
     */
    precip: {
      none: { completionLogit: 0, yardsPerCompletion: 0, yardsPerCarry: 0 },
      light_rain: { completionLogit: -0.08, yardsPerCompletion: -0.48, yardsPerCarry: -0.22 },
      heavy_rain: { completionLogit: -0.16, yardsPerCompletion: -0.96, yardsPerCarry: -0.44 },
      light_snow: { completionLogit: -0.08, yardsPerCompletion: -0.48, yardsPerCarry: -0.22 },
      heavy_snow: { completionLogit: -0.16, yardsPerCompletion: -0.96, yardsPerCarry: -0.44 },
    },
    /** Below this temperature (F). Measured: yards per completion -0.79 (se 0.37); others ~0. */
    coldThresholdF: 25,
    cold: { completionLogit: 0, yardsPerCompletion: -0.79, fgLogit: 0 },
  },

  /**
   * Live forecasts (pipeline/fetch_weather.py): National Weather Service hourly forecast for US
   * stadiums, Open-Meteo for international games or when NWS fails. Conditions are averaged
   * over the game window starting at kickoff.
   */
  weatherForecast: {
    gameWindowHours: 3,
    /** NWS: precipitation counts when the chance in the game window reaches this (%). */
    precipProbThreshold: 50,
    /** Open-Meteo: mm per hour in the game window for light / heavy precipitation. */
    lightPrecipMmPerHour: 0.3,
    heavyPrecipMmPerHour: 4,
    /** NWS hourly forecasts reach about 7 days out; beyond this the game gets no forecast. */
    maxLeadDays: 7,
  },

  /**
   * Defense vs position (matchupWeight lens, 0 by default). Shrinkage k is
   * shrinkage.dvpTargetsK. Split-half check, 2022-2025 (measure_adjustments.py): a defense's
   * positional target-share and yards-per-target pattern in weeks 1-9 has correlation 0.003
   * and 0.017 with weeks 10-18, i.e. it is noise (the implied k is in the thousands). The lens
   * exists for users who want it anyway; k = 60 keeps it visible when they turn it up.
   */
  matchup: {
    /** Bounds on the per-bucket multipliers after shrinkage, before the lens. */
    minMultiplier: 0.8,
    maxMultiplier: 1.25,
  },

  /** Venue. Applied when adjustments.venue is on. */
  venue: {
    altitudeThresholdFt: 5000,
    /**
     * Points against the visitor. Closing spreads charge 0.41 (se 0.69); results show 3.1
     * (se 2.7) over 34 games.
     */
    altitudeVisitorPenaltyPts: 0.4,
  },

  /**
   * Rest and travel, in points. Applied when adjustments.rest is on. Values are what 2022-2025
   * closing spreads charge with team ratings held fixed (docs/adjustments.md); results agree
   * within their (large) errors.
   */
  rest: {
    /** Rest days at or above this = coming off a bye. Spreads: +0.70 (se 0.29). */
    byeMinDays: 13,
    byeBonusPts: 0.7,
    /** Per day of rest advantage, non-bye games, capped at 3 days. Spreads: +0.01 (se 0.17). */
    restGapPtsPerDay: 0,
    restGapMaxDays: 3,
    /** Away team travelling at least this far. Spreads: -0.61 (se 0.40), i.e. nothing. */
    longTravelMiles: 2000,
    longTravelPenaltyPts: 0,
    /** Per hour of time-zone change for the away team. Spreads: +0.08 (se 0.11). */
    tzShiftPenaltyPtsPerHour: 0,
  },

  /** Home-field lens range (user control, range set here per the brief). */
  homeField: { minPts: 0, maxPts: 4, stepPts: 0.25, defaultPts: 1.5 },

  /**
   * Streaks lens (off by default). Points per game of a team's current win streak (+) or losing
   * streak (-), capped. Against closing spreads, win streaks are worth +0.23 (se 0.17) and ATS
   * streaks -0.20 (se 0.19): neither is reliable, and the market already moves 0.38 per game of
   * win streak. The house build uses streaks only if the backtest supports it.
   */
  streaks: {
    houseUsesStreaks: false,
    winStreakPtsPerGame: 0.25,
    atsStreakPtsPerGame: 0,
    maxStreakGames: 4,
  },

  /** Pricing, edges and stakes. */
  markets: {
    /** Ascending. Edge = sim probability - no-vig probability. */
    edgeTiers: [
      { id: 'lean', minEdge: 0.03 },
      { id: 'play', minEdge: 0.05 },
      { id: 'strong', minEdge: 0.08 },
    ],
    /**
     * Show edges, tiers and stakes on the site. Off until the backtest supports the model's
     * numbers: live 2026 sims run 2.7 points under market totals (calibration games: +0.9).
     */
    showEdges: false,
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

  /**
   * Line movement signals (engine/src/market/movement.ts). Shown next to the sim's numbers as
   * information only; none of them feed the model until a backtest supports it. start
   */
  lineMovement: {
    /** Recreational books (SharpAPI free tier) and the sharp reference (The Odds API). */
    recBooks: ['draftkings', 'fanduel'],
    sharpBook: 'pinnacle',
    /** Steam: at least this many books move the same way by this much within the window. */
    steamWindowMinutes: 60,
    steamMinMovePts: 0.5,
    steamMinBooks: 2,
    /** Spread key numbers a move can cross. */
    keyNumbers: [3, 7, 10, 14],
    /** Two books' current lines this far apart (points) = a book gap. */
    bookGapPts: 0.5,
    /**
     * Sharp gap. Lines alone mislead (Pinnacle -4 at +101 is about the same bet as DK -3.5 at
     * -120), so sides compare the moneyline no-vig win probability: the sharp book this far
     * from the recreational average. Totals need a real line difference.
     */
    sharpGapWinProb: 0.02,
    sharpGapTotalPts: 1,
    /** A move this big since open (points) counts as "the line moved". */
    minMovePts: 0.5,
  },

  /** The Odds API budget. */
  oddsApi: {
    regions: ['us', 'eu'],
    /** Jobs abort if remaining credits fall below this. */
    creditFloor: 100,
    monthlyCreditTarget: 1500,
    /** Pinnacle pulls (h2h, spreads, totals = 3 credits each) run at these UTC hours. */
    sharpPullHoursUtc: [12, 18, 23],
    /**
     * Books per pull. Up to 10 books cost the same as one region, so this list costs the same
     * 3 credits as Pinnacle alone. DraftKings and FanDuel are left out: SharpAPI tracks them
     * every 30 minutes, and mixing two feeds for one book would create fake line moves.
     */
    bookmakers: [
      'pinnacle',
      'betmgm',
      'williamhill_us',
      'espnbet',
      'fanatics',
      'betrivers',
      'bovada',
      'betonlineag',
      'lowvig',
    ],
  },

  /** SharpAPI (free tier: DraftKings + FanDuel, 60s delayed, 12 requests/minute). */
  sharpApi: {
    requestsPerMinute: 12,
    /** Main-line market types and the snapshot market each maps to. */
    marketTypes: {
      point_spread: 'spreads',
      total_points: 'totals',
      moneyline: 'h2h',
      '1st_half_point_spread': 'spreads_h1',
      '1st_half_total_points': 'totals_h1',
      '1st_half_moneyline': 'h2h_h1',
      team_total: 'team_totals',
    },
    /** Player-prop market types and the snapshot market (The Odds API key) each maps to. */
    propMarketTypes: {
      player_passing_yards: 'player_pass_yds',
      player_passing_touchdowns: 'player_pass_tds',
      player_passing_attempts: 'player_pass_attempts',
      player_passing_completions: 'player_pass_completions',
      player_interceptions: 'player_pass_interceptions',
      player_rushing_yards: 'player_rush_yds',
      player_rushing_attempts: 'player_rush_attempts',
      player_receptions: 'player_receptions',
      player_receiving_yards: 'player_reception_yds',
      anytime_touchdown_scorer: 'player_anytime_td',
    },
    /** Props change slowly and take many requests: pulled at most this often. */
    propsEveryMinutes: 120,
    pageLimit: 200,
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
