/**
 * Kinematic character physics.
 *
 * Fighting games don't use rigid-body solvers for characters: every velocity
 * is authored (knockback, launches, root motion) and integrated with a
 * fixed timestep so outcomes are exact and repeatable. This module only
 * integrates and resolves geometry; *reactions* (wall splat, ground bounce,
 * landing lag, tech) are decided by the fighter state machine.
 */
import { sanitize } from './math/vec3';
import { DT } from './rules';
import type { FighterState } from './state';
import type { CharacterStats } from './types';

export interface Pillar {
  x: number;
  z: number;
  r: number;
}

/** Rectangular arena with walls on all sides plus round pillars. */
export interface ArenaDef {
  halfX: number;
  halfZ: number;
  wallHeight: number;
  pillars: Pillar[];
}

export const DEFAULT_ARENA: ArenaDef = {
  halfX: 16,
  halfZ: 16,
  wallHeight: 7,
  pillars: [
    { x: -7, z: -7, r: 1.2 },
    { x: 7, z: -7, r: 1.2 },
    { x: -7, z: 7, r: 1.2 },
    { x: 7, z: 7, r: 1.2 },
  ],
};

export interface WallContact {
  /** Wall normal pointing back into the arena. */
  nx: number;
  nz: number;
  /** Speed into the wall (m/s), > 0 when moving into it. */
  speed: number;
}

/**
 * Pushes a circle of `radius` out of walls and pillars. Returns the contact
 * with the highest impact speed (or null). Velocity is NOT modified.
 */
export function collideArena(
  arena: ArenaDef,
  pos: { x: number; z: number },
  vel: { x: number; z: number },
  radius: number,
): WallContact | null {
  let best: WallContact | null = null;
  const consider = (nx: number, nz: number): void => {
    const speed = -(vel.x * nx + vel.z * nz);
    if (best === null || speed > best.speed) best = { nx, nz, speed };
  };
  if (pos.x > arena.halfX - radius) {
    pos.x = arena.halfX - radius;
    consider(-1, 0);
  } else if (pos.x < -arena.halfX + radius) {
    pos.x = -arena.halfX + radius;
    consider(1, 0);
  }
  if (pos.z > arena.halfZ - radius) {
    pos.z = arena.halfZ - radius;
    consider(0, -1);
  } else if (pos.z < -arena.halfZ + radius) {
    pos.z = -arena.halfZ + radius;
    consider(0, 1);
  }
  for (const p of arena.pillars) {
    const dx = pos.x - p.x;
    const dz = pos.z - p.z;
    const d = Math.hypot(dx, dz);
    const min = p.r + radius;
    if (d < min) {
      const nx = d > 1e-6 ? dx / d : 1;
      const nz = d > 1e-6 ? dz / d : 0;
      pos.x = p.x + nx * min;
      pos.z = p.z + nz * min;
      consider(nx, nz);
    }
  }
  return best;
}

export interface BodyStepResult {
  landed: boolean;
  /** Downward speed at the moment of landing (m/s). */
  impactSpeed: number;
  wall: WallContact | null;
}

/** Integrates one tick of gravity + velocity and resolves floor/walls. */
export function integrateBody(
  f: FighterState,
  stats: CharacterStats,
  gravityScale: number,
  arena: ArenaDef,
): BodyStepResult {
  const res: BodyStepResult = { landed: false, impactSpeed: 0, wall: null };
  if (!f.grounded) {
    f.vel.y -= stats.gravity * gravityScale * DT;
    if (f.vel.y < -stats.maxFallSpeed) f.vel.y = -stats.maxFallSpeed;
  } else if (f.vel.y < 0) {
    f.vel.y = 0;
  }
  f.pos.x += f.vel.x * DT;
  f.pos.y += f.vel.y * DT;
  f.pos.z += f.vel.z * DT;

  if (f.pos.y <= 0) {
    f.pos.y = 0;
    if (!f.grounded) {
      res.landed = true;
      res.impactSpeed = -f.vel.y;
      f.grounded = true;
      f.vel.y = 0;
    }
  } else {
    f.grounded = false;
  }

  res.wall = collideArena(arena, f.pos, f.vel, stats.radius);
  sanitize(f.pos);
  sanitize(f.vel);
  return res;
}

/** Decelerates horizontal velocity by `decel` m/s^2. */
export function applyFriction(f: FighterState, decel: number): void {
  const sp = Math.hypot(f.vel.x, f.vel.z);
  if (sp < 1e-6) {
    f.vel.x = 0;
    f.vel.z = 0;
    return;
  }
  const ns = Math.max(0, sp - decel * DT);
  f.vel.x *= ns / sp;
  f.vel.z *= ns / sp;
}

/** Accelerates horizontal velocity toward (tx, tz) by at most accel m/s^2. */
export function accelerateTo(f: FighterState, tx: number, tz: number, accel: number): void {
  const dx = tx - f.vel.x;
  const dz = tz - f.vel.z;
  const d = Math.hypot(dx, dz);
  const step = accel * DT;
  if (d <= step) {
    f.vel.x = tx;
    f.vel.z = tz;
  } else {
    f.vel.x += (dx / d) * step;
    f.vel.z += (dz / d) * step;
  }
}

/**
 * Soft push-apart so bodies never overlap ("pushboxes"). Grabs, knocked-down
 * and KO'd fighters are excluded so you can stand over a downed opponent.
 */
export function separateFighters(
  fighters: FighterState[],
  statsOf: (f: FighterState) => CharacterStats,
  arena: ArenaDef,
): void {
  const solid = (f: FighterState): boolean =>
    f.state !== 'ko' && f.state !== 'knockdown' && f.state !== 'grabbed' && f.state !== 'grabbing';
  for (let i = 0; i < fighters.length; i++) {
    const a = fighters[i];
    if (!solid(a)) continue;
    const sa = statsOf(a);
    for (let j = i + 1; j < fighters.length; j++) {
      const b = fighters[j];
      if (!solid(b)) continue;
      const sb = statsOf(b);
      // Vertical overlap of the two bodies.
      if (a.pos.y > b.pos.y + sb.height * 0.8 || b.pos.y > a.pos.y + sa.height * 0.8) continue;
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const d = Math.hypot(dx, dz);
      const min = sa.radius + sb.radius;
      if (d >= min) continue;
      const nx = d > 1e-6 ? dx / d : 1;
      const nz = d > 1e-6 ? dz / d : 0;
      const push = (min - d) / 2;
      a.pos.x -= nx * push;
      a.pos.z -= nz * push;
      b.pos.x += nx * push;
      b.pos.z += nz * push;
      collideArena(arena, a.pos, a.vel, sa.radius);
      collideArena(arena, b.pos, b.vel, sb.radius);
    }
  }
}
