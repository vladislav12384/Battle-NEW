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
