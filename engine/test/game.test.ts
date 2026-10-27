import { describe, expect, it } from 'vitest';
import { applySettings } from '../src/applySettings';
import type { GameCtx } from '../src/context';
import { createGameCtx } from '../src/game';
import { checkOvertime, startOvertime } from '../src/rules';
import { replayGame, runSims, runSimsWithInputs } from '../src/sim';
import type { SimGameResult } from '../src/types';
import { ENGINE_VERSION } from '../src/version';
import { loadFixture, makeRequest } from './helpers';

const snapshot = loadFixture();
const request = makeRequest(snapshot, { nSims: 1000, seed: 7 });
const results = runSims(request, snapshot, { count: 600 });

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('game invariants', () => {
  it('every game finishes with legal scores', () => {
    for (const r of results) {
      for (const side of ['home', 'away'] as const) {
        expect(r.final[side]).toBeGreaterThanOrEqual(0);
        expect(r.final[side]).not.toBe(1);
        expect(r.firstHalf[side]).toBeLessThanOrEqual(r.final[side]);
      }
      if (r.final.home === r.final.away) expect(r.overtime).toBe(true);
    }
  });

  it('plays, pass attempts and yards per game are in a realistic range', () => {
    for (const r of results) {
      expect(r.plays).toBeGreaterThan(80);
      expect(r.plays).toBeLessThan(180);
    }
    const plays = mean(results.map((r) => r.plays));
    expect(plays).toBeGreaterThan(115);
    expect(plays).toBeLessThan(140);
  });

  it('team passing yards equal the sum of player receiving yards', () => {
    const r = results[0]!;
    const passYds = r.players.reduce((a, p) => a + p.passYds, 0);
    const recYds = r.players.reduce((a, p) => a + p.recYds, 0);
    expect(passYds).toBe(recYds);
  });

  // Rough shape only; the full key-number calibration is in calibration.test.ts (step 4).
  it('shows key-number spikes at 3 and 7', () => {
    const abs = results.map((r) => Math.abs(r.final.home - r.final.away));
    const share = (k: number) => abs.filter((m) => m === k).length / abs.length;
    expect(share(3)).toBeGreaterThan(share(2) * 1.5);
    expect(share(7)).toBeGreaterThan(share(8) * 1.3);
  });
});

describe('determinism', () => {
  it('the same request gives identical results', () => {
    const again = runSims(request, snapshot, { count: 50 });
    expect(again).toEqual(results.slice(0, 50));
  });

  it('a different seed gives different results', () => {
    const other = runSims({ ...request, seed: 8 }, snapshot, { count: 50 });
    expect(other).not.toEqual(results.slice(0, 50));
  });

  it('sims are identical however the run is chunked', () => {
    const inputs = applySettings(request, snapshot);
    const chunk = runSimsWithInputs(inputs, { start: 300, count: 100 });
    expect(chunk).toEqual(results.slice(300, 400));
  });

  it('replay reproduces the same game play by play', () => {
    const { result, plays } = replayGame(request, snapshot, 123);
    expect(result).toEqual(results[123]);
    const snaps = plays.filter((p) =>
      ['pass', 'interception', 'sack', 'scramble', 'run', 'kneel', 'spike'].includes(
        p.outcome.kind,
      ),
    );
    expect(snaps.length).toBe(result.plays);
    const last = plays[plays.length - 1]!.before;
    expect(last.quarter).toBeGreaterThanOrEqual(4);
  });

  it('pins its output (if this changes, sim results changed: bump ENGINE_VERSION)', () => {
    const summary = (rs: SimGameResult[]) => ({
      engine: ENGINE_VERSION,
      first: rs.slice(0, 5).map((r) => `${r.final.away}-${r.final.home}`),
      meanTotal: Math.round(10 * mean(rs.map((r) => r.final.home + r.final.away))) / 10,
    });
    expect(summary(results)).toMatchInlineSnapshot(`
      {
        "engine": "0.3.0",
        "first": [
          "20-23",
          "23-20",
          "17-28",
          "27-24",
          "38-35",
        ],
        "meanTotal": 41.4,
      }
    `);
  });
});

describe('overtime rules', () => {
  function otCtx(): GameCtx {
    const inputs = applySettings(request, snapshot);
    const ctx = createGameCtx(inputs, 0);
    ctx.state.quarter = 4;
    ctx.state.score = { home: 20, away: 20 };
    startOvertime(ctx);
    ctx.state.ot!.firstPossession = 'home';
    return ctx;
  }

  it('a touchdown on the first possession does not end the game', () => {
    const ctx = otCtx();
    ctx.state.score.home = 27;
    ctx.state.ot!.possessed.home = true;
    checkOvertime(ctx);
    expect(ctx.state.phase).not.toBe('final');
  });

  it('the second team wins by outscoring the first', () => {
    const ctx = otCtx();
    ctx.state.score = { home: 23, away: 26 };
    ctx.state.ot!.possessed.home = true;
    checkOvertime(ctx);
    expect(ctx.state.phase).toBe('final');
  });

  it('level after both possessions becomes sudden death', () => {
    const ctx = otCtx();
    ctx.state.score = { home: 23, away: 23 };
    ctx.state.ot!.possessed = { home: true, away: true };
    checkOvertime(ctx);
    expect(ctx.state.phase).not.toBe('final');
    expect(ctx.state.ot!.suddenDeath).toBe(true);
    ctx.state.score.home = 25;
    checkOvertime(ctx);
    expect(ctx.state.phase).toBe('final');
  });

  it('a defensive score on the first possession ends it', () => {
    const ctx = otCtx();
    ctx.state.score = { home: 20, away: 22 };
    checkOvertime(ctx);
    expect(ctx.state.phase).toBe('final');
  });
});
