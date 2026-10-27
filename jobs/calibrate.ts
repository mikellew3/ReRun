/**
 * Prints the calibration report (the same checks as engine/test/calibration.test.ts).
 * Use it while tuning engine constants in model.config.ts.
 *
 * Usage: npx tsx jobs/calibrate.ts [--n 300] [--seed 2026]
 */

import {
  formatReport,
  loadCalibrationSet,
  measure,
  measureEvents,
  simulateCalibrationSet,
} from '../engine/test/calibration/measure';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const n = Number(arg('n', '300'));
const seed = Number(arg('seed', '2026'));
const t0 = performance.now();
const { targets, snapshots } = loadCalibrationSet();
const sims = simulateCalibrationSet(snapshots, targets, n, seed);
console.log(formatReport([...measure(sims, targets), ...measureEvents(sims, targets, 3, seed)]));
console.log(`${sims.length} games x ${n} sims in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
