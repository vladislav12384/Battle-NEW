/**
 * Ricochet geometry: beams that bounce off the arena (walls, pillars, floor),
 * and the planner that finds a bounce path from a shooter to a target.
 *
 * The same `castSurface` / `reflect` pair moves bouncing projectiles in the
 * simulation and traces paths for the planner (and the client preview), so a
 * planned path is exactly the path the beam flies. Everything is plain math
 * on the state: deterministic, no randomness.
 */
import type { Capsule } from './math/geometry';
import { closestSegmentSegment } from './math/geometry';
import { clamp, DEG, type Vec3, vec3, wrapAngle, yawFromDir } from './math/vec3';
import { aimDirection } from './moves';
import type { ArenaDef } from './physics';
import { RULES } from './rules';

export interface SurfaceHit {
  /** Fraction of the segment a -> b at which it meets the surface. */
  t: number;
  point: Vec3;
  /** Surface normal pointing back into the arena. */
  normal: Vec3;
}

const EPS = 1e-6;

/**
 * First surface (floor, wall below its top, pillar) met by the segment a -> b,
 * or null. Walls end at `wallHeight`: above them a shot just leaves the arena.
 */
export function castSurface(arena: ArenaDef, a: Vec3, b: Vec3): SurfaceHit | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  let best = Infinity;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const consider = (t: number, x: number, y: number, z: number): void => {
    if (t > EPS && t <= 1 && t < best) {
      best = t;
      nx = x;
      ny = y;
      nz = z;
    }
  };
  const below = (t: number): boolean => a.y + dy * t <= arena.wallHeight;
  if (dy < 0) consider(-a.y / dy, 0, 1, 0);
  if (dx > 0) {
    const t = (arena.halfX - a.x) / dx;
    if (below(t)) consider(t, -1, 0, 0);
  } else if (dx < 0) {
    const t = (-arena.halfX - a.x) / dx;
    if (below(t)) consider(t, 1, 0, 0);
  }
  if (dz > 0) {
    const t = (arena.halfZ - a.z) / dz;
    if (below(t)) consider(t, 0, 0, -1);
  } else if (dz < 0) {
    const t = (-arena.halfZ - a.z) / dz;
    if (below(t)) consider(t, 0, 0, 1);
  }
  // Pillars: vertical cylinders, entered from outside.
  const hh = dx * dx + dz * dz;
  if (hh > EPS * EPS) {
    for (const p of arena.pillars) {
      const ox = a.x - p.x;
      const oz = a.z - p.z;
      const c = ox * ox + oz * oz - p.r * p.r;
      if (c < 0) continue;
      const bb = ox * dx + oz * dz;
      if (bb >= 0) continue;
      const disc = bb * bb - hh * c;
      if (disc < 0) continue;
      const t = (-bb - Math.sqrt(disc)) / hh;
      if (!below(t)) continue;
      const hx = ox + dx * t;
      const hz = oz + dz * t;
      const l = Math.hypot(hx, hz) || 1;
      consider(t, hx / l, 0, hz / l);
    }
  }
  if (best === Infinity) return null;
  return { t: best, point: vec3(a.x + dx * best, a.y + dy * best, a.z + dz * best), normal: vec3(nx, ny, nz) };
}

/** Mirror reflection of `d` off a surface with unit normal `n`. */
export function reflect(d: Vec3, n: Vec3): Vec3 {
  const k = 2 * (d.x * n.x + d.y * n.y + d.z * n.z);
  return vec3(d.x - k * n.x, d.y - k * n.y, d.z - k * n.z);
}

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return l > 1e-9 ? vec3(v.x / l, v.y / l, v.z / l) : vec3(0, 0, -1);
}

/** Angle between two unit vectors (radians). */
export const angleBetween = (a: Vec3, b: Vec3): number => Math.acos(clamp(dot(a, b), -1, 1));

/** Turns unit vector `d` toward unit vector `to` by at most `max` radians. */
export function turnToward(d: Vec3, to: Vec3, max: number): Vec3 {
  const ang = angleBetween(d, to);
  if (ang <= max || ang < 1e-6) return ang <= max ? vec3(to.x, to.y, to.z) : d;
  // Unit vector perpendicular to d in the d/to plane.
  const c = dot(d, to);
  const perp = unit(vec3(to.x - d.x * c, to.y - d.y * c, to.z - d.z * c));
  const cs = Math.cos(max);
  const sn = Math.sin(max);
  return unit(vec3(d.x * cs + perp.x * sn, d.y * cs + perp.y * sn, d.z * cs + perp.z * sn));
}

/** Nothing solid between two points. */
export function lineOfSight(arena: ArenaDef, a: Vec3, b: Vec3): boolean {
  return castSurface(arena, a, b) === null;
}

/** Where a ricochet aims on a body: the chest. */
export function aimPoint(c: Capsule): Vec3 {
  return vec3(c.a.x + (c.b.x - c.a.x) * 0.6, c.a.y + (c.b.y - c.a.y) * 0.6, c.a.z + (c.b.z - c.a.z) * 0.6);
}

// ==========================================================================
// Tracing

export interface TraceOptions {
  maxLength: number;
  maxBounces: number;
  /** Stop when the path comes within `reach` of this capsule's axis. */
  target?: Capsule;
  reach?: number;
}

export interface Trace {
  /** Start, every bounce point, end (target contact, last surface or max length). */
  points: Vec3[];
  normals: Vec3[];
  bounces: number;
  length: number;
  /** Reached the target: closest distance to its axis and the direction it arrives in. */
  hit: { miss: number; dir: Vec3; point: Vec3 } | null;
}

/** Follows a beam from `from` along unit `dir`, bouncing off the arena. */
export function traceRay(arena: ArenaDef, from: Vec3, dir: Vec3, o: TraceOptions): Trace {
  const points: Vec3[] = [from];
  const normals: Vec3[] = [];
  let p = from;
  let d = dir;
  let length = 0;
  let bounces = 0;
  const reach2 = (o.reach ?? 0) ** 2;
  for (let guard = 0; guard <= o.maxBounces + 1; guard++) {
    const left = o.maxLength - length;
    if (left <= 1e-3) break;
    const end = vec3(p.x + d.x * left, p.y + d.y * left, p.z + d.z * left);
    const s = castSurface(arena, p, end);
    const segEnd = s ? s.point : end;
    if (o.target) {
      const c = closestSegmentSegment(p, segEnd, o.target.a, o.target.b);
      if (c.distSq <= reach2) {
        points.push(c.c1);
        return { points, normals, bounces, length: length + Math.hypot(c.c1.x - p.x, c.c1.y - p.y, c.c1.z - p.z), hit: { miss: Math.sqrt(c.distSq), dir: d, point: c.c1 } };
      }
    }
    points.push(segEnd);
    length += s ? left * s.t : left;
    if (!s) break;
    if (bounces >= o.maxBounces) break;
    bounces++;
    normals.push(s.normal);
    d = reflect(d, s.normal);
    p = vec3(s.point.x + s.normal.x * 1e-3, s.point.y + s.normal.y * 1e-3, s.point.z + s.normal.z * 1e-3);
  }
  return { points, normals, bounces, length, hit: null };
}

// ==========================================================================
// Planning

export interface PlanTarget {
  capsule: Capsule;
  /** Facing of the target: paths that come in outside its guard are preferred. */
  yaw: number;
}

export interface PlanOptions {
  maxBounces: number;
  maxLength: number;
  /** Re-planning off a surface: only directions leaving it. */
  normal?: Vec3;
  /** Prefer the path closest to this direction (re-plans look like natural bounces). */
  near?: Vec3;
}

export interface RicochetPlan {
  dir: Vec3;
  points: Vec3[];
  bounces: number;
  length: number;
}

/** How close (m) a planned path must pass to the target's axis. */
const PLAN_REACH = 0.24;
/** Fallback sweep (bounces off pillars): yaw step and pitches. */
const SWEEP_YAW = 3 * DEG;
const SWEEP_PITCHES = (() => {
  const out: number[] = [];
  for (let p = -54; p <= 30; p += 6) out.push(p * DEG);
  return out;
})();

function score(t: Trace, target: PlanTarget, o: PlanOptions, dir: Vec3): number {
  const h = t.hit!;
  if (o.near) return angleBetween(dir, o.near) / DEG + t.length * 0.05 + h.miss * 4;
  // A shot coming in outside the target's guard arc can't be blocked.
  const fromYaw = yawFromDir(-h.dir.x, -h.dir.z);
  const front = Math.abs(wrapAngle(fromYaw - target.yaw)) <= RULES.guardArc;
  return t.length + (t.bounces === 0 ? 30 : 0) + (front ? 40 : 0) + h.miss * 10;
}

/** Mirror image of coordinate `c` after `n` reflections between walls at -h and +h (signed: which wall first). */
const mirror = (c: number, h: number, n: number): number => (n % 2 === 0 ? c : -c) + 2 * n * h;

/**
 * Finds a direction from `from` whose bouncing path reaches the target,
 * however many bounces it takes (up to `maxBounces`), or null.
 *
 * Walls and the floor are planes, so every path off them is a straight line
 * to a mirror image of the target ("unfolding" the arena): aiming at each
 * image gives the exact shot, which is then traced for real (pillars may be
 * in the way, walls end at their top). Only when no such path exists, a
 * sweep over all directions looks for shots that bounce off pillars too.
 */
export function planRicochet(arena: ArenaDef, from: Vec3, target: PlanTarget, o: PlanOptions): RicochetPlan | null {
  const opts: TraceOptions = { maxLength: o.maxLength, maxBounces: o.maxBounces, target: target.capsule, reach: PLAN_REACH };
  let best: { s: number; t: Trace; dir: Vec3 } | null = null;
  /** Traces one direction; true when it is the best path so far. */
  const tryDir = (dir: Vec3): boolean => {
    if (o.normal && dot(dir, o.normal) < 0.05) return false;
    const t = traceRay(arena, from, dir, opts);
    if (!t.hit) return false;
    const s = score(t, target, o, dir);
    if (best && s >= best.s) return false;
    best = { s, t, dir };
    return true;
  };
  const c = aimPoint(target.capsule);
  const N = o.maxBounces;
  for (let nx = -N; nx <= N; nx++) {
    const ix = mirror(c.x, arena.halfX, nx);
    for (let nz = -(N - Math.abs(nx)); nz <= N - Math.abs(nx); nz++) {
      const iz = mirror(c.z, arena.halfZ, nz);
      for (let floor = 0; floor <= 1 && Math.abs(nx) + Math.abs(nz) + floor <= N; floor++) {
        const d = vec3(ix - from.x, (floor ? -c.y : c.y) - from.y, iz - from.z);
        const l = Math.hypot(d.x, d.y, d.z);
        if (l < 1e-6 || l > o.maxLength) continue;
        tryDir(vec3(d.x / l, d.y / l, d.z / l));
      }
    }
  }
  if (!best) {
    const steps = Math.round((Math.PI * 2) / SWEEP_YAW);
    let coarse: { yaw: number; pitch: number } | null = null;
    for (let i = 0; i < steps; i++) {
      for (const p of SWEEP_PITCHES) if (tryDir(aimDirection(i * SWEEP_YAW, p))) coarse = { yaw: i * SWEEP_YAW, pitch: p };
    }
    // Refine the winner toward the center of the target.
    if (coarse) {
      const { yaw, pitch } = coarse;
      for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) tryDir(aimDirection(yaw + i * 0.5 * DEG, pitch + j * 0.75 * DEG));
    }
  }
  if (!best) return null;
  const b = best as { t: Trace; dir: Vec3 };
  return { dir: b.dir, points: b.t.points, bounces: b.t.bounces, length: b.t.length };
}
