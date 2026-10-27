/**
 * Seeded pseudo-random numbers: xoshiro128** (Blackman & Vigna), seeded with splitmix32.
 *
 * Determinism rules:
 * - A run has one 32-bit seed. Each simulated game i gets its own stream: createRng(seed, i).
 *   Results are therefore identical no matter how a run is split across workers or chunks,
 *   and Replay can re-create any single sim from (seed, i) alone.
 * - Never use Math.random() in the engine. randomSeed() is only for picking an "auto" seed
 *   before a run starts; the chosen seed is then stored with the run.
 * - Changing anything in this file changes every sim result: bump ENGINE_VERSION.
 */

const UINT32_TO_UNIT = 1 / 4294967296; // 2^-32

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/** One splitmix32 step: returns [nextState, output]. Used only for seeding. */
function splitmix32(state: number): [number, number] {
  const next = (state + 0x9e3779b9) | 0;
  let z = next;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  z ^= z >>> 16;
  return [next, z >>> 0];
}

/** Four splitmix32 outputs from a starting state. */
function splitmixWords(start: number): [number, number, number, number] {
  let state = start | 0;
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [next, value] = splitmix32(state);
    state = next;
    out.push(value);
  }
  return out as [number, number, number, number];
}

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  /** Prefer createRng(). Takes a raw 128-bit state as four 32-bit words (not all zero). */
  constructor(s0: number, s1: number, s2: number, s3: number) {
    if ((s0 | s1 | s2 | s3) === 0) throw new Error('Rng state must not be all zero');
    this.s0 = s0 | 0;
    this.s1 = s1 | 0;
    this.s2 = s2 | 0;
    this.s3 = s3 | 0;
  }

  /** Next unsigned 32-bit integer. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9);
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextU32() * UINT32_TO_UNIT;
  }

  /** Uniform integer in [0, n). n must be a positive integer below 2^32. */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** true with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/**
 * Creates the RNG for one stream of a run. Use stream = sim index.
 * The seed words and the stream words come from separate splitmix sequences, so
 * (seed, stream) pairs map to distinct, well-mixed states.
 */
export function createRng(seed: number, stream = 0): Rng {
  const a = splitmixWords(seed >>> 0);
  const b = splitmixWords((stream >>> 0) ^ 0x6a09e667);
  let w0 = a[0] ^ rotl(b[0], 16);
  const w1 = a[1] ^ rotl(b[1], 16);
  const w2 = a[2] ^ rotl(b[2], 16);
  const w3 = a[3] ^ rotl(b[3], 16);
  if ((w0 | w1 | w2 | w3) === 0) w0 = 1; // practically unreachable; keeps the state valid
  return new Rng(w0, w1, w2, w3);
}

/** A fresh random 32-bit seed for "auto" runs. Not used inside a sim. */
export function randomSeed(): number {
  const c = (globalThis as { crypto?: { getRandomValues(a: Uint32Array): Uint32Array } }).crypto;
  if (!c) throw new Error('crypto.getRandomValues is not available');
  return c.getRandomValues(new Uint32Array(1))[0]!;
}
