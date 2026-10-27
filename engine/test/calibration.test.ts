/**
 * Calibration (CLAUDE.md §10.2): with default settings the engine must reproduce league reality.
 *
 * Sims 184 real games (2023-2025, weeks 4/8/12/16) from walk-forward snapshots and checks
 * margins (with key numbers), totals, plays, pass rate, yards per play, turnovers, starter stat
 * lines, and agreement with the closing lines. Targets and tolerances: calibration/measure.ts.
 *
 * To see the full table while tuning model.config.ts: npx tsx jobs/calibrate.ts
 * To rebuild the calibration set after pipeline changes:
 *   pipeline: python run_slate.py --season <y> --weeks 4 8 12 16 --version 1 (2023-2025)
 *             python calibration_targets.py --seasons 2023 2024 2025 --weeks 4 8 12 16
 *   then:     npx tsx jobs/makeCalibrationSet.ts
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Metric } from './calibration/measure';
import {
  formatReport,
  loadCalibrationSet,
  measure,
  measureEvents,
  simulateCalibrationSet,
} from './calibration/measure';

const SIMS_PER_GAME = 300;
const GROUPS = ['scores', 'key numbers', 'plays', 'starters', 'events', 'market'];
const REPLAYS_PER_GAME = 3;

describe('calibration against 2023-2025 NFL games', () => {
  let metrics: Metric[] = [];
  let gamesSimulated = 0;
  let gamesExpected = 0;

  beforeAll(() => {
    const { targets, snapshots } = loadCalibrationSet();
    const sims = simulateCalibrationSet(snapshots, targets, SIMS_PER_GAME);
    metrics = [...measure(sims, targets), ...measureEvents(sims, targets, REPLAYS_PER_GAME)];
    gamesSimulated = sims.length;
    gamesExpected = targets.calibrationGames.length;
  }, 180_000);

  it('simulates every calibration game', () => {
    expect(gamesSimulated).toBe(gamesExpected);
  });

  for (const group of GROUPS) {
    it(`${group} match the targets`, () => {
      const rows = metrics.filter((m) => m.group === group);
      expect(rows.length).toBeGreaterThan(0);
      const failed = rows.filter((m) => !m.pass);
      expect(failed, `\n${formatReport(rows)}`).toEqual([]);
    });
  }
});
