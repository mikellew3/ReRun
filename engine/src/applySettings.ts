/**
 * RunRequest + SlateSnapshot -> GameInputs: everything the play loop needs, resolved once.
 *
 * Rates: offense and defense are combined in logit space against the league average
 * (combineRates). The offense side uses team (opponent-adjusted) rates; if the starting QB is
 * not the team's usual QB, the difference between the two QBs' own numbers is added.
 *
 * Players: receivers and rushers get share tables (usage.ts) and their own completion odds and
 * yardage samplers, centered so the team's overall rates are kept.
 *
 * Availability: players forced in/out by the user, or out/IR/inactive, are fixed. Questionable
 * and doubtful players are drawn per sim with their play probability; the offense built for
 * each in/out combination is cached.
 *
 * Situational adjustments (adjust/): each is a pure function, switchable from SimSettings.
 * - Points of advantage per team (home field, altitude, rest/travel, streaks) become offense and
 *   defense efficiency shifts, half each, through config.pointsToEfficiency.
 * - Weather changes completion odds, yards and FG odds.
 * - Injuries: backup-QB level for QB swaps, OL/secondary starters out, position-aware
 *   reallocation of an out player's usage.
 * - Matchups: defense-vs-position multipliers on receivers' targets and yards.
 */

import {
  lineInjuryEffects,
  NO_QB_DELTAS,
  qbSwapDeltas,
  redistributeOutShares,
} from './adjust/injuries';
import type { LineEffects } from './adjust/injuries';
import { dvpMultipliers } from './adjust/matchup';
import type { DvpMultiplier } from './adjust/matchup';
import { restPts, travelPts } from './adjust/rest';
import { streakPts } from './adjust/form';
import { altitudePts, homeFieldPts, ZERO_PTS } from './adjust/venue';
import type { SidePts } from './adjust/venue';
import { NO_WEATHER, resolveConditions, weatherEffects } from './adjust/weather';
import type { ResolvedConditions, WeatherEffects } from './adjust/weather';
import { MODEL_CONFIG } from './config/model.config';
import { parseRunRequest } from './config/settings.schema';
import type { GameOverrides, RunRequest, SimSettings } from './config/settings.schema';
import type { Rng } from './rng';
import {
  ShiftedSamplers,
  WeightedPicker,
  YardSampler,
  centeredProbs,
  centeredTilts,
  combineRates,
  logit,
  standardNormal,
  tiltForMeanShift,
  tiltedMean,
} from './samplers';
import type {
  DvpBucket,
  HistoryWindow,
  LeagueParams,
  PlayerEntry,
  PlayerId,
  PlayerParams,
  Side,
  SlateSnapshot,
  SnapshotGame,
  TeamEntry,
  TeamParams,
  UnitParams,
} from './types';
import { allocateShares, followShares, normalizedHistory } from './usage';
import { ENGINE_VERSION } from './version';

const RECEIVER_POSITIONS = new Set(['WR', 'TE', 'RB', 'FB']);
const RUSHER_POSITIONS = new Set(['RB', 'FB', 'WR', 'TE']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ResolvedConditions, WeatherEffects };

/** Points of advantage by source, per team, and what was applied to each offense. */
export interface AdjustmentSummary {
  pts: Record<
    Side,
    {
      homeField: number;
      altitude: number;
      rest: number;
      travel: number;
      streaks: number;
      total: number;
    }
  >;
  weather: WeatherEffects;
  lines: Record<Side, LineEffects>;
  /** Per receiver bucket, for each side's offense against the other defense. */
  matchup: Record<Side, Record<DvpBucket, DvpMultiplier>>;
}

/** One team's offense against the other team's defense, for one in/out combination. */
export interface OffenseUnit {
  side: Side;
  team: string;
  qb: number;
  /** Per dropback. */
  sackRate: number;
  scrambleRate: number;
  /** Per attempt. */
  intRate: number;
  /** Per play. */
  fumbleLostRate: number;
  receivers: Int32Array;
  /** Final shares (pickers are built from these; usage noise perturbs them per sim). */
  targetShares: Float64Array;
  rzTargetShares: Float64Array;
  carryShares: Float64Array;
  rzCarryShares: Float64Array;
  glCarryShares: Float64Array;
  targetPicker: WeightedPicker | null;
  rzTargetPicker: WeightedPicker | null;
  /** P(complete | target, not intercepted), per receiver; red-zone version inside the 20. */
  completionProb: Float64Array;
  rzCompletionProb: Float64Array;
  /** Yardage by (situational tilt shift, receiver): late-game script, down. See play.ts. */
  receiverYds: ShiftedSamplers;
  rzReceiverYds: ShiftedSamplers;
  rushers: Int32Array;
  carryPicker: WeightedPicker | null;
  rzCarryPicker: WeightedPicker | null;
  glCarryPicker: WeightedPicker | null;
  rusherYds: ShiftedSamplers;
  rzRusherYds: ShiftedSamplers;
  /** -1 = none available. */
  kicker: number;
  /** Added to the FG make logit: flat, and per yard of kick distance (weather). */
  fgLogit: number;
  fgLogitPerYard: number;
  punter: number;
  fgMakeShift: number;
  xpRate: number;
  /** Expected pass rate shift (probability points). */
  proeShift: number;
  /** Neutral snap-to-snap seconds. */
  secPerSnap: number;
  /** Per-snap penalty rates: this offense, and the opposing defense. */
  offensePenaltyRate: number;
  defensePenaltyRate: number;
}

interface PlayerRef {
  idx: number;
  entry: PlayerEntry;
  params: PlayerParams | undefined;
}

export interface TeamSetup {
  side: Side;
  team: string;
  entry: TeamEntry;
  params: TeamParams;
  /** Points of efficiency shift for this team's offense: half its own advantage (home field,
   *  rest...) minus half the opponent's. */
  ptsShift: number;
  players: PlayerRef[];
  /** Global player indexes whose availability is drawn per sim, with play probabilities. */
  uncertain: { idx: number; playProb: number }[];
  /** Global player indexes that are definitely available. */
  fixedIn: Set<number>;
}

export interface GameInputs {
  request: RunRequest;
  game: SnapshotGame;
  window: HistoryWindow;
  regularSeason: boolean;
  /** Global player list; stats are kept by index into it. */
  playerIds: PlayerId[];
  league: LeagueParams;
  teams: Record<Side, TeamSetup>;
  conditions: ResolvedConditions;
  weather: WeatherEffects;
  adjustments: AdjustmentSummary;
  sackYds: YardSampler;
  scrambleYds: YardSampler;
  puntNetYds: YardSampler;
  kickoffStart: YardSampler;
  /** Down (0..3) x distance bucket expected pass rates, as logits. */
  passLogitGrid: number[][];
  /** Builds (or returns the cached) offense for a side given who is available. */
  offense(side: Side, available: Set<number>, key: string): OffenseUnit;
  /** Draws availability for one sim. Returns a cache key and the available set per side. */
  drawAvailability(rng: Rng): Record<Side, { key: string; available: Set<number> }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function paramsFor(entry: PlayerEntry, window: HistoryWindow): PlayerParams | undefined {
  return entry.params[window] ?? entry.params.season;
}

/** Each team's points of advantage, by source. */
function advantagePts(
  game: SnapshotGame,
  settings: SimSettings,
  overrides: GameOverrides,
  teams: Record<Side, TeamEntry>,
): AdjustmentSummary['pts'] {
  const venue = overrides.venue;
  const adj = settings.adjustments;
  const hfa = homeFieldPts(game, venue, settings.lenses.homeFieldPts);
  const altitude: SidePts = adj.venue ? altitudePts(game, venue) : ZERO_PTS;
  const rest: SidePts = adj.rest ? restPts(game) : ZERO_PTS;
  const travel: SidePts = adj.rest ? travelPts(game, venue) : ZERO_PTS;
  const out = {} as AdjustmentSummary['pts'];
  for (const side of ['home', 'away'] as const) {
    const streaks = settings.lenses.streaks ? streakPts(teams[side].form) : 0;
    const parts = {
      homeField: hfa[side],
      altitude: altitude[side],
      rest: rest[side],
      travel: travel[side],
      streaks,
    };
    out[side] = {
      ...parts,
      total: parts.homeField + parts.altitude + parts.rest + parts.travel + parts.streaks,
    };
  }
  return out;
}

function meanOf(dist: { yards: readonly number[]; probs: readonly number[] }): number {
  return dist.yards.reduce((acc, y, i) => acc + y * dist.probs[i]!, 0);
}

function availabilityOf(
  entry: PlayerEntry,
  overrides: GameOverrides,
  injuriesOn: boolean,
): { fixed: boolean; in: boolean; playProb: number } {
  const forced = overrides.roster[entry.playerId];
  if (forced) return { fixed: true, in: forced === 'in', playProb: forced === 'in' ? 1 : 0 };
  switch (entry.status) {
    case 'active':
      return { fixed: true, in: true, playProb: 1 };
    case 'questionable':
    case 'doubtful':
      return injuriesOn
        ? { fixed: false, in: false, playProb: entry.playProb }
        : { fixed: true, in: true, playProb: 1 };
    default:
      return { fixed: true, in: false, playProb: 0 };
  }
}

/**
 * Historical shares, or an even split when no available player has one (e.g. a team resting
 * its starters behind backups with too few games to fit): even among `preferred` players
 * (RBs for carries), else among everyone. Keeps the engine from having no one to give the
 * ball to.
 */
function withFallback(hist: number[], preferred: boolean[]): number[] {
  if (hist.some((h) => h > 0)) return hist;
  const anyPreferred = preferred.some(Boolean);
  return hist.map((_, i) => (!anyPreferred || preferred[i] ? 1 : 0));
}

export function picker(shares: Float64Array): WeightedPicker | null {
  return shares.length > 0 && shares.some((s) => s > 0) ? new WeightedPicker(shares) : null;
}

/**
 * This sim's version of a unit with per-game usage noise: every player's share is multiplied by
 * a lognormal factor (mean 1), the same factor for his normal, red-zone and goal-line shares.
 */
export function withUsageNoise(unit: OffenseUnit, rng: Rng): OffenseUnit {
  const sd = MODEL_CONFIG.usage.shareNoiseSd;
  if (sd <= 0) return unit;
  const factors = (n: number) =>
    Float64Array.from({ length: n }, () => Math.exp(sd * standardNormal(rng) - (sd * sd) / 2));
  const rec = factors(unit.receivers.length);
  const rush = factors(unit.rushers.length);
  const scale = (shares: Float64Array, f: Float64Array) => shares.map((s, i) => s * f[i]!);
  return {
    ...unit,
    targetPicker: picker(scale(unit.targetShares, rec)),
    rzTargetPicker: picker(scale(unit.rzTargetShares, rec)),
    carryPicker: picker(scale(unit.carryShares, rush)),
    rzCarryPicker: picker(scale(unit.rzCarryShares, rush)),
    glCarryPicker: picker(scale(unit.glCarryShares, rush)),
  };
}

// ---------------------------------------------------------------------------
// Offense builder
// ---------------------------------------------------------------------------

type BaseInputs = Omit<GameInputs, 'offense' | 'drawAvailability'>;

function buildOffense(inputs: BaseInputs, side: Side, available: Set<number>): OffenseUnit {
  const cfg = MODEL_CONFIG;
  const own = inputs.teams[side];
  const opp = inputs.teams[side === 'home' ? 'away' : 'home'];
  const league = inputs.league.rates;
  const off: UnitParams = own.params.off;
  const def: UnitParams = opp.params.def;
  const settings = inputs.request.settings;
  const overrides = inputs.request.overrides;
  const marketUsage = inputs.game.marketUsage;
  const pts = own.ptsShift;
  const p2e = cfg.pointsToEfficiency;
  const injuriesOn = settings.adjustments.injuries;
  const weather = inputs.weather;
  const lines = inputs.adjustments.lines[side];
  const dvp = inputs.adjustments.matchup[side];
  const completionYds = inputs.league.completionYds;

  const byId = new Map(own.players.map((p) => [p.entry.playerId, p]));
  const isIn = (p: PlayerRef) => available.has(p.idx);
  const depth = (pos: string) =>
    (own.entry.depthChart[pos as keyof TeamEntry['depthChart']] ?? [])
      .map((id) => byId.get(id))
      .filter((p): p is PlayerRef => p !== undefined);

  // --- Quarterback: first available on the depth chart; "usual" QB = most dropbacks.
  const qbs = depth('QB');
  const starter = qbs.find(isIn) ?? qbs[0];
  if (!starter) throw new Error(`${own.team} has no quarterback in the snapshot`);
  const usual = qbs
    .filter((p) => p.params?.qb)
    .sort((a, b) => b.params!.qb!.dropbacks - a.params!.qb!.dropbacks)[0];
  const qb =
    starter === usual
      ? NO_QB_DELTAS
      : qbSwapDeltas(starter.params?.qb, usual?.params?.qb, league, completionYds, injuriesOn);

  const sackRate = combineRates(
    off.sackRate,
    def.sackRate,
    league.sackRate,
    qb.sackLogit + lines.sackLogit,
  );
  const scrambleRate = combineRates(
    off.scrambleRate,
    def.scrambleRate,
    league.scrambleRate,
    qb.scrambleLogit,
  );
  const intRate = combineRates(off.intRate, def.intRate, league.intRate, qb.intLogit);
  const teamCompletion = combineRates(
    off.completionRate,
    def.completionRate,
    league.completionRate,
    qb.completionLogit +
      pts * p2e.completionLogitPerPt +
      weather.completionLogit +
      lines.completionLogit,
  );
  const fumbleLostRate = combineRates(
    off.fumbleLostRate,
    def.fumbleLostRate,
    league.fumbleLostRate,
  );
  const passTilt =
    off.passYdsTilt +
    def.passYdsTilt +
    qb.passYdsTilt +
    pts * p2e.passYdsTiltPerPt +
    tiltForMeanShift(completionYds, weather.yardsPerCompletion);
  const runTilt =
    off.runYdsTilt +
    def.runYdsTilt +
    pts * p2e.runYdsTiltPerPt +
    tiltForMeanShift(inputs.league.runYds, weather.yardsPerCarry + lines.yardsPerCarry);

  // --- Receivers. Historical shares (with the starter bonus), out players' shares handed on
  // (injury adjustments), then defense-vs-position multipliers.
  const keep = cfg.injuries.outShareKeptInPosition;
  const receiverPool = own.players.filter((p) => RECEIVER_POSITIONS.has(p.entry.position));
  const receivers = receiverPool.filter(isIn);
  const targetBase = (p: PlayerRef) =>
    (p.params?.targetShare ?? 0) * (p.entry.depth === 1 ? 1 + cfg.usage.starterTargetBonus : 1);
  const targetPooled = injuriesOn
    ? redistributeOutShares(
        receiverPool.map((p) => ({
          position: p.entry.position,
          share: targetBase(p),
          available: isIn(p),
        })),
        keep.targets,
      )
    : receivers.map(targetBase);
  const dvpOf = (p: PlayerRef) => (p.entry.dvpBucket ? dvp[p.entry.dvpBucket] : undefined);
  const targetHist = withFallback(
    receivers.map((p, i) => targetPooled[i]! * (dvpOf(p)?.targets ?? 1)),
    receivers.map((p) => p.entry.position !== 'QB'),
  );
  const targetShares = allocateShares(
    receivers.map((p, i) => ({
      hist: targetHist[i]!,
      market: marketUsage[p.entry.playerId]?.impliedTargetShare,
      nudge: overrides.usage[p.entry.playerId]?.targetShare ?? 0,
    })),
    settings.lenses.marketBlend,
  );
  const rzTargetShares = followShares(
    receivers.map((p) => p.params?.rzTargetShare ?? 0),
    normalizedHistory(targetHist),
    targetShares,
  );
  const catchLogits = receivers.map((p) => logit(p.params?.catchRate ?? league.completionRate));
  const rz = cfg.redZone;
  const completionAt = (shift: number) =>
    centeredProbs(teamCompletion, catchLogits, targetShares, shift).map((p) =>
      Math.min(0.99, p / (1 - intRate)),
    );
  const completionProb = completionAt(0);
  const rzCompletionProb = completionAt(rz.completionLogitShift);
  const compMean = tiltedMean(completionYds, 0);
  const recTilts = centeredTilts(
    completionYds,
    passTilt,
    receivers.map((p) => {
      const m = dvpOf(p)?.yardsPerTarget ?? 1;
      const dvpTilt = m === 1 ? 0 : tiltForMeanShift(completionYds, (m - 1) * compMean);
      return (p.params?.recYdsTilt ?? 0) + dvpTilt;
    }),
    Float64Array.from(receivers, (_, i) => targetShares[i]! * completionProb[i]!),
  );
  const receiverYds = new ShiftedSamplers(completionYds, recTilts);
  const rzReceiverYds = new ShiftedSamplers(
    completionYds,
    recTilts.map((t) => t + rz.passYdsTiltShift),
  );

  // --- Rushers (starting QB included through his designed-run share)
  const isRusher = (p: PlayerRef) =>
    isIn(p) && (RUSHER_POSITIONS.has(p.entry.position) || p === starter);
  const rusherPool = own.players.filter(
    (p) => RUSHER_POSITIONS.has(p.entry.position) || p.entry.position === 'QB',
  );
  const rushers = rusherPool.filter(isRusher);
  const carryBase = (p: PlayerRef) =>
    (p.params?.carryShare ?? 0) *
    (p.entry.position === 'RB' && p.entry.depth === 1 ? 1 + cfg.usage.starterCarryBonus : 1);
  const carryHist = injuriesOn
    ? redistributeOutShares(
        rusherPool.map((p) => ({
          position: p.entry.position,
          share: carryBase(p),
          available: isRusher(p),
        })),
        keep.carries,
      )
    : rushers.map(carryBase);
  const carryHistSafe = withFallback(
    carryHist,
    rushers.map((p) => p.entry.position === 'RB'),
  );
  const carryShares = allocateShares(
    rushers.map((p, i) => ({
      hist: carryHistSafe[i]!,
      market: marketUsage[p.entry.playerId]?.impliedCarryShare,
      nudge: overrides.usage[p.entry.playerId]?.carryShare ?? 0,
    })),
    settings.lenses.marketBlend,
  );
  const carryBefore = normalizedHistory(carryHistSafe);
  const rzCarryShares = followShares(
    rushers.map((p) => p.params?.rzCarryShare ?? 0),
    carryBefore,
    carryShares,
  );
  const glCarryShares = followShares(
    rushers.map((p) => p.params?.glCarryShare ?? 0),
    carryBefore,
    carryShares,
  );
  const rushTilts = centeredTilts(
    inputs.league.runYds,
    runTilt,
    rushers.map((p) => p.params?.rushYdsTilt ?? 0),
    carryShares,
  );
  const rusherYds = new ShiftedSamplers(inputs.league.runYds, rushTilts);
  const rzRusherYds = new ShiftedSamplers(
    inputs.league.runYds,
    rushTilts.map((t) => t + rz.runYdsTiltShift),
  );

  // --- Specialists
  const kicker = depth('K').find(isIn);
  const punter = depth('P').find(isIn);

  // --- Style
  const tilt = settings.lenses.script[side];
  const pen = cfg.penalties;

  return {
    side,
    team: own.team,
    qb: starter.idx,
    sackRate,
    scrambleRate,
    intRate,
    fumbleLostRate,
    receivers: Int32Array.from(receivers, (p) => p.idx),
    targetShares,
    rzTargetShares,
    carryShares,
    rzCarryShares,
    glCarryShares,
    targetPicker: picker(targetShares),
    rzTargetPicker: picker(rzTargetShares),
    completionProb,
    rzCompletionProb,
    receiverYds,
    rzReceiverYds,
    rushers: Int32Array.from(rushers, (p) => p.idx),
    carryPicker: picker(carryShares),
    rzCarryPicker: picker(rzCarryShares),
    glCarryPicker: picker(glCarryShares),
    rusherYds,
    rzRusherYds,
    kicker: kicker ? kicker.idx : -1,
    fgLogit: weather.fgLogit,
    fgLogitPerYard: weather.fgLogitPerYard,
    punter: punter ? punter.idx : -1,
    fgMakeShift: kicker?.params?.kicker?.fgMakeOverExpected ?? 0,
    xpRate: kicker?.params?.kicker?.xpRate ?? cfg.kicking.xpMakeRate,
    proeShift:
      own.params.proe * cfg.playCall.proeWeight + tilt.passRate * cfg.playCall.passRateTiltPerUnit,
    secPerSnap: own.params.neutralSecPerPlay * (1 - tilt.pace * cfg.clock.paceTiltFraction),
    offensePenaltyRate: Math.min(
      0.15,
      (pen.offenseRateScale * off.penaltyYdsPerPlay) / meanOf(pen.offense),
    ),
    defensePenaltyRate: Math.min(
      0.15,
      (pen.defenseRateScale * def.penaltyYdsPerPlay) / meanOf(pen.defense),
    ),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function applySettings(rawRequest: RunRequest, snapshot: SlateSnapshot): GameInputs {
  const request = parseRunRequest(rawRequest);
  if (request.snapshotId !== snapshot.id) {
    throw new Error(`Request is for snapshot ${request.snapshotId}, got ${snapshot.id}`);
  }
  if (request.engineVersion !== ENGINE_VERSION) {
    throw new Error(
      `Request was made on engine ${request.engineVersion}; this is engine ${ENGINE_VERSION}`,
    );
  }
  const game = snapshot.games.find((g) => g.gameId === request.gameId);
  if (!game) throw new Error(`Game ${request.gameId} is not in snapshot ${snapshot.id}`);

  const window = request.settings.lenses.historyWindow;
  const league = snapshot.league[window];
  const injuriesOn = request.settings.adjustments.injuries;
  const entries = {} as Record<Side, TeamEntry>;
  for (const side of ['home', 'away'] as const) {
    const entry = snapshot.teams[game[side]];
    if (!entry) throw new Error(`Team ${game[side]} is not in snapshot ${snapshot.id}`);
    entries[side] = entry;
  }
  const pts = advantagePts(game, request.settings, request.overrides, entries);

  const playerIds: PlayerId[] = [];
  const teams = {} as Record<Side, TeamSetup>;
  for (const side of ['home', 'away'] as const) {
    const abbr = game[side];
    const entry = entries[side];
    const opp = side === 'home' ? 'away' : 'home';
    const roster = Object.values(snapshot.players)
      .filter((p) => p.team === abbr)
      .sort((a, b) => (a.playerId < b.playerId ? -1 : 1));
    const setup: TeamSetup = {
      side,
      team: abbr,
      entry,
      params: entry.params[window],
      ptsShift: (pts[side].total - pts[opp].total) / 2,
      players: [],
      uncertain: [],
      fixedIn: new Set(),
    };
    for (const p of roster) {
      const idx = playerIds.length;
      playerIds.push(p.playerId);
      setup.players.push({ idx, entry: p, params: paramsFor(p, window) });
      const a = availabilityOf(p, request.overrides, injuriesOn);
      if (!a.fixed) setup.uncertain.push({ idx, playProb: a.playProb });
      else if (a.in) setup.fixedIn.add(idx);
    }
    teams[side] = setup;
  }

  const passLogitGrid = league.passRateByDownDist.map((row) => row.map((p) => logit(p)));
  const conditions = resolveConditions(game, request.overrides);
  const weather = request.settings.adjustments.weather
    ? weatherEffects(conditions, request.settings.lenses.conditionsWeight)
    : NO_WEATHER;
  const lineFx = (side: Side, opp: Side): LineEffects =>
    injuriesOn
      ? lineInjuryEffects(entries[side].olInjuryCount, entries[opp].secondaryInjuryCount)
      : lineInjuryEffects(0, 0);
  const matchupWeight = request.settings.lenses.matchupWeight;
  const adjustments: AdjustmentSummary = {
    pts,
    weather,
    lines: { home: lineFx('home', 'away'), away: lineFx('away', 'home') },
    matchup: {
      home: dvpMultipliers(entries.away.dvp[window], league.dvp, matchupWeight),
      away: dvpMultipliers(entries.home.dvp[window], league.dvp, matchupWeight),
    },
  };

  const base: BaseInputs = {
    request,
    game,
    window,
    regularSeason: snapshot.seasonType === 'REG',
    playerIds,
    league,
    teams,
    conditions,
    weather,
    adjustments,
    sackYds: new YardSampler(league.sackYds),
    scrambleYds: new YardSampler(league.scrambleYds),
    puntNetYds: new YardSampler(league.puntNetYds),
    kickoffStart: new YardSampler(league.kickoffStartYardline),
    passLogitGrid,
  };

  const cache: Record<Side, Map<string, OffenseUnit>> = { home: new Map(), away: new Map() };

  return {
    ...base,
    offense(side, available, key) {
      let unit = cache[side].get(key);
      if (!unit) {
        unit = buildOffense(base, side, available);
        cache[side].set(key, unit);
      }
      return unit;
    },
    drawAvailability(rng) {
      const out = {} as Record<Side, { key: string; available: Set<number> }>;
      for (const side of ['home', 'away'] as const) {
        const t = teams[side];
        let key = '';
        const available = new Set(t.fixedIn);
        for (const u of t.uncertain) {
          const plays = rng.chance(u.playProb);
          if (plays) available.add(u.idx);
          key += plays ? '1' : '0';
        }
        out[side] = { key, available };
      }
      return out;
    },
  };
}
