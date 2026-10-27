import { describe, expect, it } from 'vitest';
import { applySettings } from '../src/applySettings';
import { createRng } from '../src/rng';
import type { SlateSnapshot } from '../src/types';
import { loadFixture, makeRequest, playerId } from './helpers';

const snapshot = loadFixture();

function homeUnit(snap: SlateSnapshot, req = makeRequest(snap)) {
  const inputs = applySettings(req, snap);
  const t = inputs.teams.home;
  return { inputs, unit: inputs.offense('home', t.fixedIn, '') };
}

function targetShare(inputs: ReturnType<typeof applySettings>, unitKey: string, name: string) {
  const unit = inputs.offense('home', inputs.teams.home.fixedIn, unitKey);
  const idx = inputs.playerIds.indexOf(playerId(snapshot, name));
  const ri = Array.from(unit.receivers).indexOf(idx);
  // Recover the share from the picker by sampling.
  const rng = createRng(3);
  let hits = 0;
  const n = 40_000;
  for (let i = 0; i < n; i++) if (unit.targetPicker!.pick(rng) === ri) hits++;
  return hits / n;
}

describe('applySettings: request checks', () => {
  it('rejects a request for another snapshot', () => {
    const req = { ...makeRequest(snapshot), snapshotId: '2026-W08-v99' };
    expect(() => applySettings(req, snapshot)).toThrow(/snapshot/);
  });

  it('rejects a request made on another engine version', () => {
    const req = { ...makeRequest(snapshot), engineVersion: '0.0.1' };
    expect(() => applySettings(req, snapshot)).toThrow(/engine/);
  });

  it('rejects an unknown game', () => {
    expect(() => applySettings(makeRequest(snapshot, { gameId: 'nope' }), snapshot)).toThrow(
      /not in snapshot/,
    );
  });

  it('rejects invalid settings', () => {
    const req = makeRequest(snapshot, { settings: (s) => (s.lenses.marketBlend = 3) });
    expect(() => applySettings(req, snapshot)).toThrow();
  });
});

describe('applySettings: offense units', () => {
  it('starts the depth-chart QB and builds sane rates', () => {
    const { inputs, unit } = homeUnit(snapshot);
    expect(inputs.playerIds[unit.qb]).toBe(snapshot.teams.DEN!.depthChart.QB![0]);
    for (const r of [unit.sackRate, unit.scrambleRate, unit.intRate, unit.fumbleLostRate]) {
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThan(0.2);
    }
    expect(unit.receivers.length).toBeGreaterThan(5);
    expect(unit.kicker).toBeGreaterThanOrEqual(0);
    expect(unit.punter).toBeGreaterThanOrEqual(0);
    for (const p of unit.completionProb) {
      expect(p).toBeGreaterThan(0.3);
      expect(p).toBeLessThan(0.95);
    }
  });

  it('a QB ruled out is replaced by the next QB', () => {
    const starter = snapshot.teams.DEN!.depthChart.QB![0]!;
    const req = makeRequest(snapshot, { overrides: (o) => (o.roster[starter] = 'out') });
    const { inputs, unit } = homeUnit(snapshot, req);
    expect(inputs.playerIds[unit.qb]).toBe(snapshot.teams.DEN!.depthChart.QB![1]);
  });

  it('a player ruled out loses his targets to teammates', () => {
    const name = 'Jaylen Waddle';
    const id = playerId(snapshot, name);
    const { inputs } = homeUnit(snapshot);
    expect(targetShare(inputs, 'base', name)).toBeGreaterThan(0.1);
    const req = makeRequest(snapshot, { overrides: (o) => (o.roster[id] = 'out') });
    const { unit } = homeUnit(snapshot, req);
    const idx = applySettings(req, snapshot).playerIds.indexOf(id);
    expect(Array.from(unit.receivers)).not.toContain(idx);
  });

  it('a target-share nudge moves the player’s share by that much', () => {
    const name = 'Courtland Sutton';
    const id = playerId(snapshot, name);
    const before = targetShare(applySettings(makeRequest(snapshot), snapshot), 'a', name);
    const req = makeRequest(snapshot, {
      overrides: (o) => (o.usage[id] = { targetShare: 0.1 }),
    });
    const after = targetShare(applySettings(req, snapshot), 'b', name);
    expect(after - before).toBeCloseTo(0.1, 1);
  });

  it('script tilts change pace and pass rate', () => {
    const { unit: base } = homeUnit(snapshot);
    const req = makeRequest(snapshot, {
      settings: (s) => (s.lenses.script.home = { pace: 1, passRate: 1 }),
    });
    const { unit: tilted } = homeUnit(snapshot, req);
    expect(tilted.secPerSnap).toBeLessThan(base.secPerSnap);
    expect(tilted.proeShift).toBeGreaterThan(base.proeShift);
  });
});

describe('applySettings: availability', () => {
  it('questionable players play in about playProb of sims', () => {
    const snap = JSON.parse(JSON.stringify(snapshot)) as SlateSnapshot;
    const id = playerId(snap, 'Jaylen Waddle');
    snap.players[id]!.status = 'questionable';
    snap.players[id]!.playProb = 0.6;
    const inputs = applySettings(makeRequest(snap), snap);
    const idx = inputs.playerIds.indexOf(id);
    expect(inputs.teams.home.uncertain.map((u) => u.idx)).toContain(idx);
    let plays = 0;
    const n = 5000;
    for (let i = 0; i < n; i++) {
      if (inputs.drawAvailability(createRng(1, i)).home.available.has(idx)) plays++;
    }
    expect(plays / n).toBeCloseTo(0.6, 1);
  });

  it('forcing a questionable player in or out overrides the mixture', () => {
    const snap = JSON.parse(JSON.stringify(snapshot)) as SlateSnapshot;
    const id = playerId(snap, 'Jaylen Waddle');
    snap.players[id]!.status = 'questionable';
    const req = makeRequest(snap, { overrides: (o) => (o.roster[id] = 'in') });
    const inputs = applySettings(req, snap);
    expect(inputs.teams.home.uncertain).toHaveLength(0);
    expect(inputs.teams.home.fixedIn.has(inputs.playerIds.indexOf(id))).toBe(true);
  });

  it('out and inactive players never play', () => {
    const snap = JSON.parse(JSON.stringify(snapshot)) as SlateSnapshot;
    const id = playerId(snap, 'Jaylen Waddle');
    snap.players[id]!.status = 'out';
    const inputs = applySettings(makeRequest(snap), snap);
    expect(inputs.teams.home.fixedIn.has(inputs.playerIds.indexOf(id))).toBe(false);
  });
});

describe('applySettings: venue', () => {
  it('home field goes to the home offense, swaps, or disappears at a neutral site', () => {
    const shift = (venue: 'scheduled' | 'swap' | 'neutral') =>
      applySettings(makeRequest(snapshot, { overrides: (o) => (o.venue = venue) }), snapshot).teams
        .home.ptsShift;
    expect(shift('scheduled')).toBeGreaterThan(0);
    expect(shift('swap')).toBeLessThan(0);
    expect(shift('neutral')).toBe(0);
  });
});
