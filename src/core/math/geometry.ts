import { clamp, type Vec3, vec3 } from './vec3';

/** A capsule: segment a-b swept by radius r. A sphere is a capsule with a == b. */
export interface Capsule {
  a: Vec3;
  b: Vec3;
  r: number;
}

export interface SegmentClosest {
  distSq: number;
  /** Closest point on the first segment. */
  c1: Vec3;
  /** Closest point on the second segment. */
  c2: Vec3;
}

/**
 * Closest points between segments p1-q1 and p2-q2.
 * Ericson, "Real-Time Collision Detection", 5.1.9.
 */
export function closestSegmentSegment(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): SegmentClosest {
  const EPS = 1e-9;
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s: number;
  let t: number;
  if (a <= EPS && e <= EPS) {
    s = 0;
    t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > EPS ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }
  const c1 = vec3(p1.x + d1x * s, p1.y + d1y * s, p1.z + d1z * s);
  const c2 = vec3(p2.x + d2x * t, p2.y + d2y * t, p2.z + d2z * t);
  const dx = c1.x - c2.x, dy = c1.y - c2.y, dz = c1.z - c2.z;
  return { distSq: dx * dx + dy * dy + dz * dz, c1, c2 };
}

/**
 * Tests two capsules for overlap. Returns the contact point (between the
 * closest points, weighted by radius) or null when they don't touch.
 */
export function capsuleOverlap(A: Capsule, B: Capsule): Vec3 | null {
  const res = closestSegmentSegment(A.a, A.b, B.a, B.b);
  const rr = A.r + B.r;
  if (res.distSq > rr * rr) return null;
  const t = rr > 0 ? A.r / rr : 0.5;
  return vec3(
    res.c1.x + (res.c2.x - res.c1.x) * t,
    res.c1.y + (res.c2.y - res.c1.y) * t,
    res.c1.z + (res.c2.z - res.c1.z) * t,
  );
}
