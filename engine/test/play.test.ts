import { describe, expect, it } from 'vitest';
import { applySettings } from '../src/applySettings';
import { createGameCtx } from '../src/game';
import { simulatePass, simulateRun } from '../src/play';
import { loadFixture, makeRequest } from './helpers';

const snapshot = loadFixture();
const inputs = applySettings(makeRequest(snapshot), snapshot);

function midfieldCtx() {
  const ctx = createGameCtx(inputs, 0);
  Object.assign(ctx.state, {
    phase: 'scrimmage',
    possession: 'home',
    down: 1,
    distance: 10,
    yardline: 35,
    quarter: 1,
    clockSec: 800,
  });
  return ctx;
}

describe('pass plays', () => {
  it('sack, scramble and interception rates match the offense unit', () => {
    const ctx = midfieldCtx();
    const unit = ctx.units.home;
    const n = 60_000;
    const counts = { sack: 0, scramble: 0, interception: 0, complete: 0, attempts: 0 };
    for (let i = 0; i < n; i++) {
      const o = simulatePass(ctx, unit);
      if (o.kind === 'sack') counts.sack++;
      else if (o.kind === 'scramble') counts.scramble++;
      else {
        counts.attempts++;
        if (o.kind === 'interception') counts.interception++;
        if (o.kind === 'pass' && o.result === 'complete') counts.complete++;
      }
    }
    expect(counts.sack / n).toBeCloseTo(unit.sackRate, 2);
    expect(counts.scramble / n).toBeCloseTo(unit.scrambleRate, 2);
    expect(counts.interception / counts.attempts).toBeCloseTo(unit.intRate, 2);
    const rate = counts.complete / counts.attempts;
    expect(rate).toBeGreaterThan(0.55);
    expect(rate).toBeLessThan(0.75);
  });

  it('never gains more than the distance to the goal line', () => {
    const ctx = midfieldCtx();
    ctx.state.yardline = 95;
    for (let i = 0; i < 5000; i++) {
      const o = simulatePass(ctx, ctx.units.home);
      if (o.kind === 'pass') {
        expect(o.yards).toBeLessThanOrEqual(5);
        expect(o.td).toBe(o.yards === 5);
      }
    }
  });

  it('records passing and receiving stats consistently', () => {
    const ctx = midfieldCtx();
    for (let i = 0; i < 3000; i++) simulatePass(ctx, ctx.units.home);
    const st = ctx.stats;
    const total = (a: Float64Array) => a.reduce((x, y) => x + y, 0);
    expect(total(st.passCmp)).toBe(total(st.rec));
    expect(total(st.passYds)).toBe(total(st.recYds));
    expect(total(st.passAtt)).toBe(total(st.targets));
  });
});

describe('run plays', () => {
  it('average gain is close to the offense’s typical yards per carry', () => {
    const ctx = midfieldCtx();
    let yards = 0;
    const n = 30_000;
    for (let i = 0; i < n; i++) {
      const o = simulateRun(ctx, ctx.units.home);
      if (o.kind === 'run') yards += o.yards;
    }
    expect(yards / n).toBeGreaterThan(3.3);
    expect(yards / n).toBeLessThan(5.5);
  });

  it('a run from the 1 that loses yards is a safety', () => {
    const ctx = midfieldCtx();
    ctx.state.yardline = 1;
    let safeties = 0;
    for (let i = 0; i < 5000; i++) {
      const o = simulateRun(ctx, ctx.units.home);
      if (o.kind === 'run' && o.safety) {
        safeties++;
        expect(o.yards).toBe(-1);
      }
    }
    expect(safeties).toBeGreaterThan(0);
  });
});
