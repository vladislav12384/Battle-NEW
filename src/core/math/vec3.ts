/**
 * Minimal deterministic vector math for the simulation.
 *
 * Coordinate system (matches three.js):
 *   +Y is up. A fighter with yaw = 0 faces -Z.
 *   forward(yaw) = (-sin yaw, 0, -cos yaw)
 *   right(yaw)   = ( cos yaw, 0, -sin yaw)
 *
 * "Local" offsets used by move/hitbox data are expressed as
 *   x = right, y = up, z = forward
 * relative to the fighter's feet position and facing.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Vec3Tuple = readonly [number, number, number];

export const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const clone = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

export function set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export const copy = (out: Vec3, v: Vec3): Vec3 => set(out, v.x, v.y, v.z);
export const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => vec3(a.x * s, a.y * s, a.z * s);
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 =>
  vec3(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const lengthSq = (a: Vec3): number => dot(a, a);
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const distanceSq = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};
export const distance = (a: Vec3, b: Vec3): number => Math.sqrt(distanceSq(a, b));
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 =>
  vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-9 ? scale(a, 1 / l) : vec3();
}

/** Horizontal (XZ-plane) length. */
export const hLength = (v: Vec3): number => Math.hypot(v.x, v.z);
/** Horizontal (XZ-plane) distance. */
export const hDistance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

export const forwardFromYaw = (yaw: number): Vec3 => vec3(-Math.sin(yaw), 0, -Math.cos(yaw));
export const rightFromYaw = (yaw: number): Vec3 => vec3(Math.cos(yaw), 0, -Math.sin(yaw));

/** Yaw that faces along the horizontal direction (dx, dz). */
export const yawFromDir = (dx: number, dz: number): number => Math.atan2(-dx, -dz);
export const yawTo = (from: Vec3, to: Vec3): number => yawFromDir(to.x - from.x, to.z - from.z);

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Wraps an angle to [-PI, PI). */
export function wrapAngle(a: number): number {
  return ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

/** Moves `cur` toward `target` by at most `step`. */
export function approach(cur: number, target: number, step: number): number {
  if (cur < target) return Math.min(cur + step, target);
  return Math.max(cur - step, target);
}

/** Rotates angle `cur` toward `target` along the shortest arc by at most `maxStep` radians. */
export function approachAngle(cur: number, target: number, maxStep: number): number {
  const d = wrapAngle(target - cur);
  if (Math.abs(d) <= maxStep) return wrapAngle(cur + d);
  return wrapAngle(cur + Math.sign(d) * maxStep);
}

/** Converts a local offset (x right, y up, z forward) into world space. */
export function localToWorld(origin: Vec3, yaw: number, lx: number, ly: number, lz: number): Vec3 {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  return vec3(origin.x + c * lx - s * lz, origin.y + ly, origin.z - s * lx - c * lz);
}

/** Converts a local direction (x right, z forward) on the XZ-plane into a world direction. */
export function localDirToWorld(yaw: number, lx: number, lz: number): Vec3 {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  return vec3(c * lx - s * lz, 0, -s * lx - c * lz);
}

/** Replaces -0 with 0 so serialized snapshots round-trip bit-exactly. */
export function sanitize(v: Vec3): void {
  v.x += 0;
  v.y += 0;
  v.z += 0;
}
