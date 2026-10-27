export { MODEL_CONFIG } from './model.config';
export type { ModelConfig } from './model.config';
export * from './settings.schema';
export * from './presets';

import { MODEL_CONFIG } from './model.config';

/** JSON with object keys sorted, so the same data always gives the same string. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** 64-bit FNV-1a of a string (UTF-16 code units), as 16 hex characters. Not cryptographic. */
export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Identifies the exact MODEL_CONFIG values. Stored on snapshots and backtest reports. */
export function configHash(): string {
  return fnv1a64(stableStringify(MODEL_CONFIG));
}
