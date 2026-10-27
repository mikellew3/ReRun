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
 * Situational adjustments (weather, rest, matchup, injuries' efficiency effects) plug in here
 * in step 5.
 */

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
} from './samplers';
import type {
  HistoryWindow,
  LeagueParams,
  PlayerEntry,
  PlayerId,
  PlayerParams,
  Precip,
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

export interface ResolvedConditions {
  /** true for domes and closed roofs: weather has no effect. */
  indoor: boolean;
  windMph: number;
  tempF: number;
  precip: Precip;
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
  /** Points of advantage given to this team's offense (home field etc.). */
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

function resolveConditions(game: SnapshotGame, o: GameOverrides): ResolvedConditions {
  const roof = game.stadium.roof;
  const roofState = o.conditions.roof ?? game.weather?.roofExpected ?? null;
  const indoor = roof === 'dome' || (roof === 'retractable' && roofState !== 'open');
  return {
    indoor,
    windMph: o.conditions.windMph ?? game.weather?.windMph ?? 0,
    tempF: o.conditions.tempF ?? game.weather?.tempF ?? 60,
    precip: o.conditions.precip ?? game.weather?.precip ?? 'none',
  };
}

/** Home-field advantage in points, per side's offense. Split evenly offense/defense. */
function homeFieldShift(game: SnapshotGame, settings: SimSettings, venue: GameOverrides['venue']) {
  const hfa = settings.lenses.homeFieldPts;
  if (venue === 'neutral' || (venue === 'scheduled' && game.neutralSite)) {
    return { home: 0, away: 0 };
  }
  const favored: Side = venue === 'swap' ? 'away' : 'home';
  return favored === 'home' ? { home: hfa / 2, away: -hfa / 2 } : { home: -hfa / 2, away: hfa / 2 };
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

function buildOffense(
  inputs: Omit<GameInputs, 'offense' | 'drawAvailability'>,
  side: Side,
  available: Set<number>,
): OffenseUnit {
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
  const sq = starter.params?.qb;
  const uq = usual?.params?.qb;
  const qbDelta = (field: 'sackRate' | 'scrambleRate' | 'intRate' | 'completionRate') =>
    sq && uq && starter !== usual ? logit(sq[field]) - logit(uq[field]) : 0;
  const qbTiltDelta = sq && uq && starter !== usual ? sq.passYdsTilt - uq.passYdsTilt : 0;

  const sackRate = combineRates(off.sackRate, def.sackRate, league.sackRate, qbDelta('sackRate'));
  const scrambleRate = combineRates(
    off.scrambleRate,
    def.scrambleRate,
    league.scrambleRate,
    qbDelta('scrambleRate'),
  );
  const intRate = combineRates(off.intRate, def.intRate, league.intRate, qbDelta('intRate'));
  const teamCompletion = combineRates(
    off.completionRate,
    def.completionRate,
    league.completionRate,
    qbDelta('completionRate') + pts * p2e.completionLogitPerPt,
  );
  const fumbleLostRate = combineRates(
    off.fumbleLostRate,
    def.fumbleLostRate,
    league.fumbleLostRate,
  );
  const passTilt = off.passYdsTilt + def.passYdsTilt + qbTiltDelta + pts * p2e.passYdsTiltPerPt;
  const runTilt = off.runYdsTilt + def.runYdsTilt + pts * p2e.runYdsTiltPerPt;

  // --- Receivers
  const receivers = own.players.filter((p) => isIn(p) && RECEIVER_POSITIONS.has(p.entry.position));
  const targetHist = receivers.map(
    (p) =>
      (p.params?.targetShare ?? 0) * (p.entry.depth === 1 ? 1 + cfg.usage.starterTargetBonus : 1),
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
  const recTilts = centeredTilts(
    inputs.league.completionYds,
    passTilt,
    receivers.map((p) => p.params?.recYdsTilt ?? 0),
    Float64Array.from(receivers, (_, i) => targetShares[i]! * completionProb[i]!),
  );
  const receiverYds = new ShiftedSamplers(inputs.league.completionYds, recTilts);
  const rzReceiverYds = new ShiftedSamplers(
    inputs.league.completionYds,
    recTilts.map((t) => t + rz.passYdsTiltShift),
  );

  // --- Rushers (starting QB included through his designed-run share)
  const rushers = own.players.filter(
    (p) => isIn(p) && (RUSHER_POSITIONS.has(p.entry.position) || p === starter),
  );
  const carryHist = rushers.map(
    (p) =>
      (p.params?.carryShare ?? 0) *
      (p.entry.position === 'RB' && p.entry.depth === 1 ? 1 + cfg.usage.starterCarryBonus : 1),
  );
  const carryShares = allocateShares(
    rushers.map((p, i) => ({
      hist: carryHist[i]!,
      market: marketUsage[p.entry.playerId]?.impliedCarryShare,
      nudge: overrides.usage[p.entry.playerId]?.carryShare ?? 0,
    })),
    settings.lenses.marketBlend,
  );
  const carryBefore = normalizedHistory(carryHist);
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
  const hfa = homeFieldShift(game, request.settings, request.overrides.venue);

  const playerIds: PlayerId[] = [];
  const teams = {} as Record<Side, TeamSetup>;
  for (const side of ['home', 'away'] as const) {
    const abbr = game[side];
    const entry = snapshot.teams[abbr];
    if (!entry) throw new Error(`Team ${abbr} is not in snapshot ${snapshot.id}`);
    const roster = Object.values(snapshot.players)
      .filter((p) => p.team === abbr)
      .sort((a, b) => (a.playerId < b.playerId ? -1 : 1));
    const setup: TeamSetup = {
      side,
      team: abbr,
      entry,
      params: entry.params[window],
      ptsShift: hfa[side],
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

  const base = {
    request,
    game,
    window,
    regularSeason: snapshot.seasonType === 'REG',
    playerIds,
    league,
    teams,
    conditions: resolveConditions(game, request.overrides),
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
