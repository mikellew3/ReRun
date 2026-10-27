import { loadCalibrationSet } from '../engine/test/calibration/measure';
import { DEFAULT_OVERRIDES, DEFAULT_SETTINGS, ENGINE_VERSION, replayGame } from '@rerun/engine';
const { targets, snapshots } = loadCalibrationSet();
const wanted = new Set(targets.calibrationGames.map((g) => g.gameId));
const acc: Record<string, { db: number; n: number }> = {};
const add = (k: string, db: boolean) => {
  acc[k] ??= { db: 0, n: 0 };
  acc[k].n++;
  if (db) acc[k].db++;
};
let thirdDist = 0,
  thirdN = 0;
const kinds: Record<string, number> = {};
let games = 0;
for (const snap of snapshots)
  for (const g of snap.games) {
    if (!wanted.has(g.gameId)) continue;
    for (let i = 0; i < 4; i++) {
      games++;
      const { plays } = replayGame(
        {
          snapshotId: snap.id,
          gameId: g.gameId,
          engineVersion: ENGINE_VERSION,
          settings: DEFAULT_SETTINGS,
          overrides: DEFAULT_OVERRIDES,
          nSims: 1000,
          seed: 9,
        },
        snap,
        i,
      );
      for (const p of plays) {
        const o = p.outcome.kind;
        kinds[o] = (kinds[o] ?? 0) + 1;
        if (!['pass', 'interception', 'sack', 'scramble', 'run'].includes(o)) continue;
        const db = o !== 'run';
        const b = p.before;
        const diff = b.score[b.possession] - b.score[b.possession === 'home' ? 'away' : 'home'];
        add('all', db);
        add(`down${b.down}`, db);
        const neutral = b.quarter <= 3 && Math.abs(diff) <= 8;
        add(neutral ? 'neutral(q1-3,|d|<=8)' : 'non-neutral', db);
        if (b.quarter === 4 && diff > 8) add('q4 leading >8', db);
        if (b.quarter === 4 && diff < -8) add('q4 trailing >8', db);
        if (b.down === 1 && b.distance === 10) add('1st&10', db);
        if (b.down === 3) {
          thirdDist += b.distance;
          thirdN++;
        }
      }
    }
  }
for (const [k, v] of Object.entries(acc))
  console.log(k.padEnd(24), (v.db / v.n).toFixed(3), (v.n / games).toFixed(1));
console.log(
  'avg 3rd down distance',
  (thirdDist / thirdN).toFixed(2),
  '3rd downs/game',
  (thirdN / games).toFixed(1),
);
console.log(
  Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, +(v / games).toFixed(2)])),
);
