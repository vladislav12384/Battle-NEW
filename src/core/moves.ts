/** Frame-data queries and hitbox/hurtbox geometry. */
import type { Capsule } from './math/geometry';
import { clamp, DEG, forwardFromYaw, localToWorld, type Vec3, vec3, type Vec3Tuple } from './math/vec3';
import { RULES } from './rules';
import type { FighterState } from './state';
import type { ArmorDef, CharacterStats, HitboxDef, MoveDef, StrikeLine } from './types';

export const totalFrames = (m: MoveDef): number => m.startup + m.active + m.recovery;
export const firstActiveFrame = (m: MoveDef): number => m.startup + 1;
export const lastActiveFrame = (m: MoveDef): number => m.startup + m.active;

export type MovePhase = 'startup' | 'active' | 'recovery';

export function movePhase(m: MoveDef, frame: number): MovePhase {
  if (frame <= m.startup) return 'startup';
  if (frame <= m.startup + m.active) return 'active';
  return 'recovery';
}

export const inFrames = (range: readonly [number, number], frame: number): boolean =>
  frame >= range[0] && frame <= range[1];

export function activeHitboxes(m: MoveDef, frame: number): HitboxDef[] {
  return m.hitboxes.filter((h) => inFrames(h.frames, frame));
}

const lineCache = new WeakMap<MoveDef, StrikeLine>();

/**
 * Trajectory of a strike as seen by its target (see StrikeLine), derived
 * from the sweep of its first hitbox in the attacker's local frame
 * (x right, y up, z forward) unless the move states it.
 */
export function strikeLine(m: MoveDef): StrikeLine {
  if (m.line) return m.line;
  let line = lineCache.get(m);
  if (line === undefined) {
    const h = m.hitboxes.find((x) => !x.throw);
    const b = h?.b ?? h?.a;
    if (!h || !b) line = 'straight';
    else {
      const dx = b[0] - h.a[0];
      const dy = b[1] - h.a[1];
      if (Math.max(h.a[1], b[1]) < 0.6) line = 'low';
      // Sweeping toward the attacker's left = coming from the target's left.
      else if (Math.abs(dx) >= 0.4 && Math.abs(dx) >= Math.abs(dy)) line = dx < 0 ? 'fromLeft' : 'fromRight';
      else if (dy <= -0.6) line = 'overhead';
      else if (dy >= 0.5) line = 'rising';
      else line = 'straight';
    }
    lineCache.set(m, line);
  }
  return line;
}

const armorCache = new WeakMap<MoveDef, ArmorDef | null>();

/**
 * The move's armor: explicit armor, or the default poise of heavy blows
 * (light strikes can't interrupt their late wind-up and active frames).
 */
export function armorOf(m: MoveDef): ArmorDef | null {
  if (m.armor) return m.armor;
  let a = armorCache.get(m);
  if (a === undefined) {
    a =
      m.kind === 'heavy' && m.poise !== false
        ? {
            frames: [Math.max(1, Math.ceil(m.startup * RULES.poise.from)), lastActiveFrame(m)],
            hits: 1,
            damageTaken: RULES.poise.damageTaken,
            vs: 'light',
          }
        : null;
    armorCache.set(m, a);
  }
  return a;
}

const reachCache = new WeakMap<MoveDef, number>();

/** How far in front of the fighter the move's hitboxes reach (meters). */
export function moveReach(m: MoveDef): number {
  let r = reachCache.get(m);
  if (r === undefined) {
    r = 0;
    for (const h of m.hitboxes) {
      r = Math.max(r, h.a[2] + h.radius, (h.b ? h.b[2] : h.a[2]) + h.radius);
    }
    for (const p of m.projectiles ?? []) r = Math.max(r, p.speed * (p.lifetime / 60));
    if (r === 0) r = 1;
    reachCache.set(m, r);
  }
  return r;
}

export const chestHeight = (stats: CharacterStats): number => stats.height * 0.75;

export function chestPos(f: FighterState, stats: CharacterStats): Vec3 {
  return vec3(f.pos.x, f.pos.y + chestHeight(stats), f.pos.z);
}

/** Effective aim pitch for a move (clamped; 0 for moves that don't aim vertically). */
export function movePitch(f: FighterState, m: MoveDef): number {
  if (m.pitchAim === false) return 0;
  return clamp(f.aimPitch, -RULES.maxPitch, RULES.maxPitch);
}

/**
 * Transforms a local offset into world space, rotating it around the chest
 * by the aim pitch so attacks follow where the fighter is looking.
 */
export function aimedPoint(f: FighterState, stats: CharacterStats, local: Vec3Tuple, pitch: number): Vec3 {
  let y = local[1];
  let z = local[2];
  if (pitch !== 0) {
    const pivot = chestHeight(stats);
    const ry = y - pivot;
    const c = Math.cos(pitch);
    const s = Math.sin(pitch);
    y = ry * c + z * s + pivot;
    z = z * c - ry * s;
  }
  return localToWorld(f.pos, f.yaw, local[0], y, z);
}

export function hitboxCapsule(f: FighterState, stats: CharacterStats, h: HitboxDef, pitch: number): Capsule {
  const a = aimedPoint(f, stats, h.a, pitch);
  const b = h.b ? aimedPoint(f, stats, h.b, pitch) : a;
  return { a, b, r: h.radius };
}

/** The fighter's vulnerable volume. Lying fighters have a low, horizontal hurtbox. */
export function hurtCapsule(f: FighterState, stats: CharacterStats): Capsule {
  const lying = f.state === 'knockdown' || (f.state === 'ko' && f.grounded);
  if (lying) {
    const fw = forwardFromYaw(f.yaw);
    const h = 0.25;
    return {
      a: vec3(f.pos.x + fw.x * 0.7, f.pos.y + h, f.pos.z + fw.z * 0.7),
      b: vec3(f.pos.x - fw.x * 0.7, f.pos.y + h, f.pos.z - fw.z * 0.7),
      r: 0.28,
    };
  }
  const r = stats.radius;
  return {
    a: vec3(f.pos.x, f.pos.y + r, f.pos.z),
    b: vec3(f.pos.x, f.pos.y + stats.height - r, f.pos.z),
    r,
  };
}

/** Direction of a fighter's aim as a unit vector (yaw + pitch). */
export function aimDirection(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return vec3(-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c);
}

export const degToRad = (d: number): number => d * DEG;
