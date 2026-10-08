/**
 * Held beams (Cyclops' mega beam): where the beam is, and its pulses of damage.
 *
 * The beam leaves the eyes along the fighter's aim (yaw + pitch, up to almost
 * straight down so it can be fired at someone below while flying) and runs
 * until the first surface: walls and pillars stop it, the floor catches it.
 * It goes through bodies: every pulse hits everyone along it.
 */
import { type HitResult, resolveHit } from './combat';
import type { SimContext } from './fighterUtil';
import { capsuleOverlap } from './math/geometry';
import { clamp, type Vec3, vec3, yawFromDir } from './math/vec3';
import { aimDirection, aimedPoint, hurtCapsule } from './moves';
import type { ArenaDef } from './physics';
import { castSurface, type SurfaceHit } from './ricochet';
import type { FighterState } from './state';
import type { BeamDef, MoveDef } from './types';

export interface BeamHost extends SimContext {
  readonly arena: ArenaDef;
}

/** Steepest the beam can aim (rad): almost straight down or up. */
export const BEAM_MAX_PITCH = 1.4;

export interface BeamSegment {
  from: Vec3;
  to: Vec3;
  /** Unit direction of the beam. */
  dir: Vec3;
  /** The surface that stops it (null: it fades out at full length). */
  surface: SurfaceHit | null;
}

/** The beam of `f` right now: from the eyes along the aim to the first surface. */
export function beamSegment(sim: BeamHost, f: FighterState, b: BeamDef): BeamSegment {
  const pitch = clamp(f.aimPitch, -BEAM_MAX_PITCH, BEAM_MAX_PITCH);
  const from = aimedPoint(f, sim.statsOf(f), b.offset, pitch);
  const dir = aimDirection(f.yaw, pitch);
  const end = vec3(from.x + dir.x * b.length, from.y + dir.y * b.length, from.z + dir.z * b.length);
  const surface = castSurface(sim.arena, from, end);
  return { from, to: surface ? surface.point : end, dir, surface };
}

/** The beam move a fighter is firing right now (null when none). */
export function firingBeam(sim: SimContext, f: FighterState): MoveDef | null {
  if (f.state !== 'attack' || !f.beaming) return null;
  const m = sim.moveOf(f);
  return m?.beam ? m : null;
}

/** Pulses of every firing beam: on the pulse frames everyone along a beam is hit. */
export function processBeams(sim: BeamHost, frozen: ReadonlySet<number>): void {
  for (const f of sim.state.fighters) {
    if (frozen.has(f.id) || f.hitstop > 0) continue;
    const m = firingBeam(sim, f);
    const b = m?.beam;
    if (!m || !b || f.beamFrames % b.every !== 0) continue;
    const seg = beamSegment(sim, f, b);
    for (const v of sim.state.fighters) {
      if (v === f || v.team === f.team || v.state === 'ko') continue;
      const point = capsuleOverlap({ a: seg.from, b: seg.to, r: b.radius }, hurtCapsule(v, sim.statsOf(v)));
      if (!point) continue;
      const res: HitResult = resolveHit(sim, {
        attacker: f,
        victim: v,
        hit: b.hit,
        move: m,
        point,
        kbYaw: yawFromDir(seg.dir.x, seg.dir.z),
        // The guard faces the eyes the beam comes from.
        from: seg.from,
        source: 'projectile',
      });
      if (res === 'hit' || res === 'block' || res === 'guardBreak') f.moveHit = f.moveHit || res === 'hit';
    }
  }
}
