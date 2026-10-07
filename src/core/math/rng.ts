/** Serializable PRNG state (mulberry32). Lives inside the simulation snapshot. */
export interface RngState {
  seed: number;
}

/** Returns a float in [0, 1) and advances the state. */
export function nextRandom(state: RngState): number {
  let t = (state.seed = (state.seed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const randomRange = (state: RngState, lo: number, hi: number): number =>
  lo + (hi - lo) * nextRandom(state);

export const chance = (state: RngState, p: number): boolean => nextRandom(state) < p;
