/**
 * Builds the committed calibration set used by engine/test/calibration.test.ts: walk-forward
 * snapshots for the calibration weeks, trimmed to the "season" history window (what default
 * settings use) and gzipped so the set stays small.
 *
 * Usage (after pipeline/run_slate.py and pipeline/calibration_targets.py):
 *   npx tsx jobs/makeCalibrationSet.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { SlateSnapshot } from '@rerun/engine';

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const outDir = 'engine/test/fixtures/calibration';
const targets = JSON.parse(readFileSync(root(`${outDir}/targets.json`), 'utf8')) as {
  seasons: number[];
  weeks: number[];
};

const ids: string[] = [];
for (const season of targets.seasons) {
  for (const week of targets.weeks) {
    const id = `${season}-W${String(week).padStart(2, '0')}-v1`;
    const snap = JSON.parse(
      readFileSync(root(`pipeline/data/snapshots/${id}.json`), 'utf8'),
    ) as SlateSnapshot;
    const trimmed = {
      ...snap,
      league: { season: snap.league.season },
      teams: Object.fromEntries(
        Object.entries(snap.teams).map(([t, e]) => [
          t,
          { ...e, params: { season: e.params.season }, dvp: { season: e.dvp.season } },
        ]),
      ),
      players: Object.fromEntries(
        Object.entries(snap.players).map(([pid, p]) => [
          pid,
          { ...p, params: p.params.season ? { season: p.params.season } : {} },
        ]),
      ),
    };
    const gz = gzipSync(JSON.stringify(trimmed), { level: 9 });
    writeFileSync(root(`${outDir}/${id}.json.gz`), gz);
    ids.push(id);
    console.log(`${id}: ${(gz.length / 1024).toFixed(0)} KB`);
  }
}
writeFileSync(root(`${outDir}/snapshots.json`), `${JSON.stringify(ids, null, 2)}\n`);
