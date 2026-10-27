import { readFileSync } from 'node:fs';
import { DEFAULT_OVERRIDES, DEFAULT_SETTINGS } from '../src/config';
import type { GameOverrides, RunRequest, SimSettings } from '../src/config';
import type { SlateSnapshot } from '../src/types';
import { ENGINE_VERSION } from '../src/version';

/** Two games from the real 2026 week-8 snapshot (made with jobs/sliceSnapshot.ts). */
export function loadFixture(): SlateSnapshot {
  const url = new URL('./fixtures/snapshot.sample.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as SlateSnapshot;
}

export const GAME_ID = '2026_08_KC_DEN';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export function makeRequest(
  snapshot: SlateSnapshot,
  changes: {
    gameId?: string;
    seed?: number;
    nSims?: RunRequest['nSims'];
    settings?: (s: SimSettings) => void;
    overrides?: (o: GameOverrides) => void;
  } = {},
): RunRequest {
  const settings = clone(DEFAULT_SETTINGS);
  const overrides = clone(DEFAULT_OVERRIDES);
  changes.settings?.(settings);
  changes.overrides?.(overrides);
  return {
    snapshotId: snapshot.id,
    gameId: changes.gameId ?? GAME_ID,
    engineVersion: ENGINE_VERSION,
    settings,
    overrides,
    nSims: changes.nSims ?? 1000,
    seed: changes.seed ?? 42,
  };
}

export function playerId(snapshot: SlateSnapshot, name: string): string {
  const p = Object.values(snapshot.players).find((x) => x.name === name);
  if (!p) throw new Error(`No player named ${name} in fixture`);
  return p.playerId;
}
