/** Tiny helpers that keep move definitions compact and readable. */
import type { Vec3Tuple } from '../core/math/vec3';
import type { CharacterDef, HitboxDef, HitDef, KnockbackDef, LimbId, MoveDef } from '../core/types';

/** Sphere hitbox. */
export function box(
  frames: [number, number],
  at: Vec3Tuple,
  radius: number,
  hit: HitDef,
  extra: Partial<HitboxDef> = {},
): HitboxDef {
  return { frames, a: at, radius, hit, ...extra };
}

/** Capsule hitbox sweeping from `from` to `to` (fists and kicks travel, so do their hitboxes). */
export function sweep(
  frames: [number, number],
  from: Vec3Tuple,
  to: Vec3Tuple,
  radius: number,
  hit: HitDef,
  extra: Partial<HitboxDef> = {},
): HitboxDef {
  return { frames, a: from, b: to, radius, hit, ...extra };
}

export function moveList(moves: MoveDef[]): Record<string, MoveDef> {
  const out: Record<string, MoveDef> = {};
  for (const m of moves) {
    if (out[m.id]) throw new Error(`Duplicate move id ${m.id}`);
    out[m.id] = m;
  }
  return out;
}

/**
 * Derives a character from another one: different stats and per-move
 * overrides, same move list. Handy for enemy variants.
 */
export function variant(
  base: CharacterDef,
  patch: {
    id: string;
    name: string;
    color: number;
    stats?: Partial<CharacterDef['stats']>;
    moves?: Record<string, Partial<MoveDef>>;
  },
): CharacterDef {
  const moves: Record<string, MoveDef> = {};
  for (const [id, m] of Object.entries(base.moves)) moves[id] = { ...m, ...(patch.moves?.[id] ?? {}) };
  return {
    ...base,
    id: patch.id,
    name: patch.name,
    color: patch.color,
    stats: { ...base.stats, ...(patch.stats ?? {}) },
    moves,
  };
}

/** Validates content invariants early (cancel targets exist, frames in range...). */
export function validateCharacter(c: CharacterDef): string[] {
  const errors: string[] = [];
  for (const cmd of c.commands) if (!c.moves[cmd.move]) errors.push(`command -> missing move ${cmd.move}`);
  for (const m of Object.values(c.moves)) {
    const total = m.startup + m.active + m.recovery;
    for (const h of m.hitboxes) {
      if (h.frames[0] < 1 || h.frames[1] > total || h.frames[0] > h.frames[1])
        errors.push(`${m.id}: hitbox frames ${h.frames} outside 1..${total}`);
    }
    for (const cn of m.cancels ?? []) {
      if (!c.moves[cn.into]) errors.push(`${m.id}: cancel into missing move ${cn.into}`);
      if (cn.frames[1] > total) errors.push(`${m.id}: cancel window ends after the move (${total})`);
    }
    if (m.charge && m.charge.frame > m.startup) errors.push(`${m.id}: charge frame must be in startup`);
    if (m.kind === 'throw' && !m.throw) errors.push(`${m.id}: throw move without throw data`);
  }
  return errors;
}

const FLIP_LIMB: Partial<Record<LimbId, LimbId>> = { lHand: 'rHand', rHand: 'lHand', lFoot: 'rFoot', rFoot: 'lFoot' };
const flipKb = (k: KnockbackDef | undefined): KnockbackDef | undefined =>
  k && { ...k, side: k.side === undefined ? undefined : -k.side };
function flipHit<T extends Partial<HitDef>>(h: T): T {
  // Only touch keys that exist: a partial counter override must not erase the base knockback.
  const out: T = { ...h };
  if (h.knockback) out.knockback = flipKb(h.knockback);
  if (h.airKnockback) out.airKnockback = flipKb(h.airKnockback);
  if (h.counter) out.counter = flipHit(h.counter);
  return out;
}

/** Left/right mirror of a move (left hook <-> right hook...). */
export function mirror(m: MoveDef, id: string, name: string): MoveDef {
  return {
    ...m,
    id,
    name,
    hand: m.hand === 'left' ? 'right' : m.hand === 'right' ? 'left' : undefined,
    hitboxes: m.hitboxes.map((h) => ({
      ...h,
      a: [-h.a[0], h.a[1], h.a[2]],
      b: h.b ? [-h.b[0], h.b[1], h.b[2]] : undefined,
      limb: h.limb ? (FLIP_LIMB[h.limb] ?? h.limb) : undefined,
      hit: flipHit(h.hit),
    })),
    motion: m.motion?.map((mo) => ({ ...mo, side: mo.side === undefined ? undefined : -mo.side })),
  };
}

export interface TempoScale {
  startup: number;
  active: number;
  recovery: number;
  hitstun: number;
  blockstun: number;
  hitstop: number;
  landingLag: number;
}

/**
 * Re-times a move: scales its startup / active / recovery phases and remaps
 * every frame reference (hitboxes, cancel windows, root motion, projectiles,
 * invulnerability, armor, charge) so they stay in the same phase. Root-motion
 * speeds are rescaled to keep the same distance. Stun and hit stop scale too,
 * which keeps chains that were true combos true combos.
 */
export function tempo(m: MoveDef, k: TempoScale): MoveDef {
  const s0 = m.startup;
  const a0 = m.active;
  const r0 = m.recovery;
  const s1 = Math.max(1, Math.round(s0 * k.startup));
  const a1 = Math.max(1, Math.round(a0 * k.active));
  const r1 = Math.max(1, Math.round(r0 * k.recovery));
  const start = (x: number): number => {
    if (x <= s0) return 1 + Math.floor(((x - 1) * s1) / s0);
    if (x <= s0 + a0) return s1 + 1 + Math.floor(((x - s0 - 1) * a1) / a0);
    return s1 + a1 + 1 + Math.floor(((x - s0 - a0 - 1) * r1) / r0);
  };
  const end = (x: number): number => {
    if (x <= s0) return Math.round((x * s1) / s0);
    if (x <= s0 + a0) return s1 + Math.round(((x - s0) * a1) / a0);
    return s1 + a1 + Math.round(((x - s0 - a0) * r1) / r0);
  };
  const range = (r: readonly [number, number]): [number, number] => {
    const a = start(r[0]);
    return [a, Math.max(a, end(r[1]))];
  };
  const scaleHit = <T extends Partial<HitDef>>(h: T): T => {
    const out: T = { ...h };
    if (h.hitstun !== undefined) out.hitstun = Math.round(h.hitstun * k.hitstun);
    if (h.blockstun !== undefined) out.blockstun = Math.round(h.blockstun * k.blockstun);
    if (h.hitstop !== undefined) out.hitstop = Math.round(h.hitstop * k.hitstop);
    else if (h.damage !== undefined) out.hitstop = Math.round(Math.min(16, Math.max(4, 4 + h.damage / 12)) * k.hitstop);
    if (h.crumple !== undefined) out.crumple = Math.round(h.crumple * k.hitstun);
    if (h.counter) out.counter = scaleHit(h.counter);
    return out;
  };
  return {
    ...m,
    startup: s1,
    active: a1,
    recovery: r1,
    hitboxes: m.hitboxes.map((h) => ({ ...h, frames: range(h.frames), hit: scaleHit(h.hit) })),
    cancels: m.cancels?.map((c) => ({ ...c, frames: range(c.frames) })),
    jumpCancel: m.jumpCancel && { ...m.jumpCancel, frames: range(m.jumpCancel.frames) },
    motion: m.motion?.map((mo) => {
      const frames = range(mo.frames);
      const slow = (mo.frames[1] - mo.frames[0] + 1) / (frames[1] - frames[0] + 1);
      return {
        ...mo,
        frames,
        fwd: mo.fwd === undefined ? undefined : mo.fwd * slow,
        side: mo.side === undefined ? undefined : mo.side * slow,
      };
    }),
    projectiles: m.projectiles?.map((p) => ({ ...p, frame: start(p.frame), hit: scaleHit(p.hit) })),
    invuln: m.invuln?.map((i) => ({ ...i, frames: range(i.frames) })),
    armor: m.armor && { ...m.armor, frames: range(m.armor.frames) },
    charge: m.charge && {
      ...m.charge,
      frame: start(m.charge.frame),
      maxFrames: Math.round(m.charge.maxFrames * k.recovery),
      fullAt: Math.round(m.charge.fullAt * k.recovery),
    },
    throw: m.throw && { hit: scaleHit(m.throw.hit), recovery: Math.round(m.throw.recovery * k.recovery) },
    landingLag: m.landingLag === undefined ? undefined : Math.round(m.landingLag * k.landingLag),
  };
}

/** Applies `tempo` to every move of a move list. */
export function tempoMoves(moves: Record<string, MoveDef>, k: TempoScale): Record<string, MoveDef> {
  const out: Record<string, MoveDef> = {};
  for (const [id, m] of Object.entries(moves)) out[id] = tempo(m, k);
  return out;
}
