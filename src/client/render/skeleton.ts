/**
 * Procedural animation. Placeholder characters have no animation clips, so
 * poses are computed from the simulation state every frame:
 *
 *   - attacks drive the striking limb THROUGH the move's real hitboxes
 *     (wind-up -> strike path -> recovery), so what you see is what hits;
 *   - stun / juggle / knockdown / tech / dodge... get hand-authored poses;
 *   - walking uses a stride cycle driven by actual ground speed.
 *
 * All joints are in character-local space: x = right, y = up, z = forward,
 * relative to the feet. Real art can later replace this module.
 */
import { chestHeight } from '../../core/moves';
import { clamp } from '../../core/math/vec3';
import { RULES } from '../../core/rules';
import type { FighterState } from '../../core/state';
import type { CharacterStats, HitboxDef, LimbId, MoveDef } from '../../core/types';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const lerpV = (a: V3, b: V3, t: number): V3 => v(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
const addV = (a: V3, b: V3): V3 => v(a.x + b.x, a.y + b.y, a.z + b.z);
const subV = (a: V3, b: V3): V3 => v(a.x - b.x, a.y - b.y, a.z - b.z);
const scaleV = (a: V3, s: number): V3 => v(a.x * s, a.y * s, a.z * s);
const lenV = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const dotV = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const normV = (a: V3): V3 => {
  const l = lenV(a);
  return l > 1e-6 ? scaleV(a, 1 / l) : v(0, 1, 0);
};
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

/** The pose targets the renderer turns into a skeleton. */
export interface PoseTargets {
  lHand: V3;
  rHand: V3;
  lFoot: V3;
  rFoot: V3;
  hipY: number;
  /** Torso lean forward (+) / back (-), radians. */
  lean: number;
  /** Torso twist (+ = right shoulder forward). */
  twist: number;
  /** Whole-body rotation around the hips (tumbles, lying down). */
  tiltPitch: number;
  tiltRoll: number;
  /** 0..1 energy glow (charging, burst, super). */
  glow: number;
  /** Limbs currently striking (for motion trails). */
  striking: LimbId[];
}

export interface Joints {
  hip: V3;
  chest: V3;
  head: V3;
  lShoulder: V3;
  rShoulder: V3;
  lElbow: V3;
  rElbow: V3;
  lHand: V3;
  rHand: V3;
  lHipJ: V3;
  rHipJ: V3;
  lKnee: V3;
  rKnee: V3;
  lFoot: V3;
  rFoot: V3;
}

/** Per-fighter animation memory kept by the client between frames. */
export interface AnimMemory {
  phase: number;
  lastX: number;
  lastZ: number;
  smoothed: PoseTargets | null;
  seed: number;
}

export function newAnimMemory(seed: number): AnimMemory {
  return { phase: 0, lastX: 0, lastZ: 0, smoothed: null, seed };
}

interface Body {
  s: number;
  w: number;
  hipY: number;
  shoulderY: number;
  shoulderX: number;
  upperArm: number;
  foreArm: number;
  thigh: number;
  shin: number;
}

export function bodyOf(stats: CharacterStats): Body {
  const s = stats.height / 1.8;
  const w = stats.radius / 0.35;
  return {
    s,
    w,
    hipY: 0.95 * s,
    shoulderY: 1.43 * s,
    shoulderX: 0.19 * w,
    upperArm: 0.33 * s,
    foreArm: 0.33 * s,
    thigh: 0.47 * s,
    shin: 0.47 * s,
  };
}

function guardPose(b: Body): PoseTargets {
  return {
    lHand: v(-0.12 * b.w, 1.5 * b.s, 0.34 * b.s),
    rHand: v(0.15 * b.w, 1.42 * b.s, 0.24 * b.s),
    lFoot: v(-0.16 * b.w, 0, 0.18 * b.s),
    rFoot: v(0.17 * b.w, 0, -0.17 * b.s),
    hipY: b.hipY - 0.03 * b.s,
    lean: 0.06,
    twist: -0.15,
    tiltPitch: 0,
    tiltRoll: 0,
    glow: 0,
    striking: [],
  };
}

/** Rotates a local hitbox point by the aim pitch around the chest (mirrors core/moves.aimedPoint). */
function aimLocal(p: readonly [number, number, number], pitch: number, pivot: number): V3 {
  if (pitch === 0) return v(p[0], p[1], p[2]);
  const ry = p[1] - pivot;
  const c = Math.cos(pitch);
  const sn = Math.sin(pitch);
  return v(p[0], ry * c + p[2] * sn + pivot, p[2] * c - ry * sn);
}

function limbTarget(
  boxes: HitboxDef[],
  m: MoveDef,
  frame: number,
  rest: V3,
  shoulder: V3,
  pitch: number,
  pivot: number,
): { pos: V3; striking: boolean } {
  // Pick the hitbox that is current, else the next upcoming, else the last finished one.
  let cur = boxes.find((h) => frame >= h.frames[0] - 0.5 && frame <= h.frames[1] + 0.5);
  let prevEnd = 0;
  let prevPos = rest;
  if (!cur) {
    const upcoming = boxes.filter((h) => h.frames[0] > frame).sort((a, b) => a.frames[0] - b.frames[0])[0];
    const past = boxes.filter((h) => h.frames[1] < frame).sort((a, b) => b.frames[1] - a.frames[1])[0];
    if (past) {
      prevEnd = past.frames[1];
      prevPos = aimLocal(past.b ?? past.a, pitch, pivot);
    }
    if (upcoming) {
      // Wind-up toward a chambered position behind the strike's start.
      const start = aimLocal(upcoming.a, pitch, pivot);
      const chamber = addV(lerpV(shoulder, start, upcoming.b ? 0.8 : 0.35), v(0, 0, -0.12));
      const t = clamp((frame - prevEnd) / Math.max(1, upcoming.frames[0] - prevEnd), 0, 1);
      return { pos: lerpV(prevPos, chamber, easeOut(t)), striking: false };
    }
    if (past) {
      const total = m.startup + m.active + m.recovery;
      const t = clamp((frame - prevEnd) / Math.max(1, total - prevEnd), 0, 1);
      return { pos: lerpV(prevPos, rest, easeInOut(t)), striking: frame - prevEnd < 3 };
    }
    return { pos: rest, striking: false };
  }
  const a = aimLocal(cur.a, pitch, pivot);
  const b = cur.b ? aimLocal(cur.b, pitch, pivot) : a;
  const t = clamp((frame - cur.frames[0] + 1) / (cur.frames[1] - cur.frames[0] + 1), 0, 1);
  return { pos: lerpV(a, b, easeOut(t)), striking: true };
}

/**
 * Computes the raw pose targets for this frame.
 * @param frac fraction of a tick elapsed since the last simulation step (0..1)
 */
export function computePose(
  f: FighterState,
  stats: CharacterStats,
  move: MoveDef | null,
  mem: AnimMemory,
  time: number,
  frac: number,
): PoseTargets {
  const b = bodyOf(stats);
  const p = guardPose(b);
  const fr = f.hitstop > 0 ? 0 : frac;
  const sf = f.stateFrame + fr;

  // --- locomotion cycle from real ground speed
  const yawS = Math.sin(f.yaw);
  const yawC = Math.cos(f.yaw);
  const localX = yawC * f.vel.x - yawS * f.vel.z; // right component
  const localZ = -yawS * f.vel.x - yawC * f.vel.z; // forward component
  const speed = Math.hypot(localX, localZ);

  switch (f.state) {
    case 'ground':
    case 'block': {
      if (f.state === 'block') {
        p.lHand = v(-0.07 * b.w, 1.56 * b.s, 0.3 * b.s);
        p.rHand = v(0.09 * b.w, 1.5 * b.s, 0.27 * b.s);
        p.hipY -= 0.05 * b.s;
        p.lean = 0.14;
      }
      if (speed > 0.3 && f.grounded) {
        const run = f.running;
        const stride = (run ? 0.55 : 0.35) * b.s;
        const dirX = localX / speed;
        const dirZ = localZ / speed;
        const sL = Math.sin(mem.phase);
        const sR = Math.sin(mem.phase + Math.PI);
        p.lFoot = v(-0.13 * b.w + dirX * sL * stride, Math.max(0, Math.cos(mem.phase)) * 0.14 * b.s, dirZ * sL * stride);
        p.rFoot = v(0.13 * b.w + dirX * sR * stride, Math.max(0, Math.cos(mem.phase + Math.PI)) * 0.14 * b.s, dirZ * sR * stride);
        p.hipY -= Math.abs(Math.sin(mem.phase)) * 0.03 * b.s;
        if (run && f.state === 'ground') {
          p.lean = 0.3;
          p.lHand = v(-0.2 * b.w, 1.15 * b.s, -sL * 0.35 * b.s);
          p.rHand = v(0.2 * b.w, 1.15 * b.s, -sR * 0.35 * b.s);
        }
      } else {
        // idle breathing
        const br = Math.sin(time * 2.2 + mem.seed) * 0.012 * b.s;
        p.lHand.y += br;
        p.rHand.y += br;
        p.hipY += br * 0.5;
      }
      break;
    }
    case 'jumpsquat':
    case 'land':
      p.hipY -= 0.18 * b.s;
      p.lean = 0.2;
      break;
    case 'air': {
      p.lFoot = v(-0.14 * b.w, 0.35 * b.s, 0.12 * b.s);
      p.rFoot = v(0.15 * b.w, 0.5 * b.s, -0.05 * b.s);
      p.hipY += 0.05 * b.s;
      if (f.vel.y > 2 && f.stateFrame < 20) p.tiltPitch = 0; // rising
      break;
    }
    case 'attack': {
      if (!move) break;
      const frame = (f.charging ? f.moveFrame : f.moveFrame + fr) + 0;
      const pivot = chestHeight(stats);
      const pitch = move.pitchAim === false ? 0 : clamp(f.aimPitch, -RULES.maxPitch, RULES.maxPitch);
      const byLimb = new Map<LimbId, HitboxDef[]>();
      for (const h of move.hitboxes) {
        const limb = h.limb ?? 'rHand';
        if (!byLimb.has(limb)) byLimb.set(limb, []);
        byLimb.get(limb)!.push(h);
      }
      const lShoulder = v(-b.shoulderX, b.shoulderY, 0);
      const rShoulder = v(b.shoulderX, b.shoulderY, 0);
      const total = move.startup + move.active + move.recovery;
      const progress = clamp(frame / total, 0, 1);
      for (const [limb, boxes] of byLimb) {
        if (limb === 'lHand' || limb === 'rHand') {
          const sh = limb === 'lHand' ? lShoulder : rShoulder;
          const rest = limb === 'lHand' ? p.lHand : p.rHand;
          const r = limbTarget(boxes, move, frame, rest, sh, pitch, pivot);
          if (limb === 'lHand') p.lHand = r.pos;
          else p.rHand = r.pos;
          if (r.striking) {
            p.striking.push(limb);
            p.twist = limb === 'rHand' ? 0.35 : -0.45;
            p.lean = 0.18;
          }
        } else if (limb === 'lFoot' || limb === 'rFoot') {
          const hip = v(limb === 'lFoot' ? -0.1 : 0.1, b.hipY, 0);
          const rest = limb === 'lFoot' ? p.lFoot : p.rFoot;
          const r = limbTarget(boxes, move, frame, rest, hip, pitch, pivot);
          if (limb === 'lFoot') p.lFoot = r.pos;
          else p.rFoot = r.pos;
          if (r.striking) {
            p.striking.push(limb);
            p.lean = -0.25;
            p.twist = limb === 'rFoot' ? 0.5 : -0.5;
          }
        } else if (limb === 'body') {
          const first = boxes[0];
          const t = clamp((frame - 1) / Math.max(1, first.frames[0]), 0, 1);
          p.lean = 0.15 + 0.35 * easeOut(t);
          p.lHand = v(-0.15 * b.w, 1.35 * b.s, 0.3 * b.s);
          p.rHand = v(0.05 * b.w, 1.25 * b.s, 0.15 * b.s);
          if (frame >= first.frames[0] && frame <= first.frames[1]) p.striking.push('body');
        }
      }
      if (f.charging || (move.charge && frame <= move.charge.frame + 1 && f.chargeFrames > 0)) {
        const c = move.charge ? Math.min(1, f.chargeFrames / move.charge.fullAt) : 0;
        p.rHand = v(0.32 * b.w, 1.42 * b.s, -0.32 * b.s);
        p.twist = -0.6;
        p.lean = -0.05;
        p.glow = 0.3 + 0.7 * c;
        p.hipY -= 0.06 * b.s;
      }
      if (move.kind === 'super') p.glow = Math.max(p.glow, 0.8);
      if (move.air) {
        p.lFoot = byLimb.has('lFoot') ? p.lFoot : v(-0.14 * b.w, 0.35 * b.s, 0.12 * b.s);
        p.rFoot = byLimb.has('rFoot') ? p.rFoot : v(0.15 * b.w, 0.5 * b.s, -0.05 * b.s);
      }
      if (move.kind === 'throw') {
        p.lHand = v(-0.15 * b.w, 1.3 * b.s, 0.45 + 0.1 * Math.sin(progress * Math.PI));
        p.rHand = v(0.15 * b.w, 1.3 * b.s, 0.45 + 0.1 * Math.sin(progress * Math.PI));
      }
      // Overhead/axe kicks lift the body; rising moves stretch upward.
      if (move.motion?.some((mo) => (mo.up ?? 0) > 0) && !f.grounded) {
        p.lFoot = v(-0.12 * b.w, 0.2 * b.s, -0.05);
        p.rFoot = v(0.12 * b.w, 0.35 * b.s, 0.05);
      }
      break;
    }
    case 'blockstun':
      p.lHand = v(-0.07 * b.w, 1.56 * b.s, 0.26 * b.s);
      p.rHand = v(0.09 * b.w, 1.5 * b.s, 0.23 * b.s);
      p.lean = -0.12;
      p.hipY -= 0.06 * b.s;
      break;
    case 'hitstun': {
      const k = clamp(f.stun / 20, 0, 1);
      p.lean = -0.35 * k - 0.05;
      p.twist = Math.sin(mem.seed * 7) * 0.4 * k;
      p.lHand = v(-0.3 * b.w, 1.25 * b.s, 0.1);
      p.rHand = v(0.32 * b.w, 1.3 * b.s, 0.05);
      p.hipY -= 0.05 * b.s;
      break;
    }
    case 'stagger': {
      const w = Math.sin(sf * 0.25 + mem.seed) * 0.25;
      p.lean = -0.15;
      p.tiltRoll = w * 0.4;
      p.lHand = v(-0.3 * b.w, 1.0 * b.s, 0.05);
      p.rHand = v(0.3 * b.w, 1.0 * b.s, 0.05);
      p.hipY -= 0.08 * b.s;
      break;
    }
    case 'juggle':
    case 'wallsplat':
    case 'grabbed': {
      p.lHand = v(-0.45 * b.w, 1.5 * b.s, -0.05);
      p.rHand = v(0.45 * b.w, 1.55 * b.s, -0.1);
      p.lFoot = v(-0.2 * b.w, 0.15 * b.s, 0.2);
      p.rFoot = v(0.22 * b.w, 0.25 * b.s, -0.1);
      if (f.state === 'juggle') {
        // Tumble: rotate backward depending on airtime; flatten when falling.
        p.tiltPitch = -clamp(0.4 + sf * 0.035, 0, 1.35);
        p.tiltRoll = Math.sin(mem.seed * 3) * 0.3;
        if (f.grounded) p.tiltPitch = -Math.PI / 2;
      } else if (f.state === 'wallsplat') {
        p.tiltPitch = -0.2;
        p.lHand = v(-0.6 * b.w, 1.7 * b.s, -0.15);
        p.rHand = v(0.6 * b.w, 1.75 * b.s, -0.15);
      } else {
        p.hipY += 0.1 * b.s;
        p.lFoot.y += 0.1;
        p.rFoot.y += 0.1;
      }
      break;
    }
    case 'knockdown':
    case 'ko':
      if (f.grounded || f.state === 'knockdown') {
        p.tiltPitch = -Math.PI / 2;
        p.lHand = v(-0.45 * b.w, 1.3 * b.s, 0);
        p.rHand = v(0.45 * b.w, 1.4 * b.s, 0.1);
        p.lFoot = v(-0.2 * b.w, 0, 0.1);
        p.rFoot = v(0.2 * b.w, 0.05, 0.05);
      } else {
        p.tiltPitch = -clamp(0.4 + sf * 0.04, 0, Math.PI / 2);
        p.lHand = v(-0.45 * b.w, 1.5 * b.s, -0.05);
        p.rHand = v(0.45 * b.w, 1.55 * b.s, -0.1);
      }
      break;
    case 'getup': {
      const t = clamp(sf / RULES.getupFrames, 0, 1);
      p.tiltPitch = -Math.PI / 2 * (1 - easeOut(t));
      p.hipY -= 0.2 * (1 - t);
      break;
    }
    case 'tech': {
      const t = clamp(sf / RULES.techFrames, 0, 1);
      p.tiltPitch = (f.grounded ? -1 : 1) * Math.PI * 2 * easeInOut(t) * (f.grounded ? 0.5 : 1);
      p.hipY -= 0.35 * b.s * Math.sin(t * Math.PI);
      p.lFoot = v(-0.12, 0.4 * b.s * Math.sin(t * Math.PI), 0.1);
      p.rFoot = v(0.12, 0.4 * b.s * Math.sin(t * Math.PI), 0.1);
      break;
    }
    case 'dodge': {
      const D = f.dodgeAir ? RULES.airDodge : RULES.dodge;
      const t = clamp(sf / D.frames, 0, 1);
      const dx = yawC * f.dodgeDirX - yawS * f.dodgeDirZ;
      const dz = -yawS * f.dodgeDirX - yawC * f.dodgeDirZ;
      const k = Math.sin(t * Math.PI);
      p.tiltRoll = -dx * 0.35 * k;
      p.lean = dz * 0.3 * k;
      p.hipY -= 0.15 * b.s * k;
      break;
    }
    case 'recoil':
      p.lean = -0.25;
      p.lHand = v(-0.25 * b.w, 1.4 * b.s, 0.1);
      p.rHand = v(0.28 * b.w, 1.35 * b.s, 0.0);
      break;
    case 'grabbing':
      p.lHand = v(-0.12 * b.w, 1.3 * b.s, 0.5 * b.s);
      p.rHand = v(0.12 * b.w, 1.3 * b.s, 0.5 * b.s);
      p.lean = 0.15;
      if (f.stateFrame > RULES.throwTechWindow) {
        const t = clamp((sf - RULES.throwTechWindow) / 12, 0, 1);
        p.twist = 1.2 * easeOut(t);
        p.lHand.z += 0.2 * t;
        p.rHand.y += 0.3 * t;
      }
      break;
    case 'burst': {
      const t = clamp(sf / 10, 0, 1);
      p.lHand = v(-0.7 * b.w, 1.8 * b.s, 0.1);
      p.rHand = v(0.7 * b.w, 1.8 * b.s, 0.1);
      p.lFoot = v(-0.3 * b.w, 0, 0);
      p.rFoot = v(0.3 * b.w, 0, 0);
      p.lean = -0.25 * t;
      p.glow = 1 - clamp((sf - 10) / 20, 0, 1);
      break;
    }
  }
  if (f.meter >= 100 && f.state !== 'ko') p.glow = Math.max(p.glow, 0.12);
  return p;
}

/** Exponentially smooths pose targets so state changes blend instead of popping. */
export function smoothPose(mem: AnimMemory, target: PoseTargets, dt: number, snappy: boolean): PoseTargets {
  if (!mem.smoothed) {
    mem.smoothed = structuredClone(target);
    return mem.smoothed;
  }
  const s = mem.smoothed;
  const k = 1 - Math.exp(-dt * (snappy ? 45 : 18));
  const kt = 1 - Math.exp(-dt * (snappy ? 30 : 12));
  s.lHand = lerpV(s.lHand, target.lHand, k);
  s.rHand = lerpV(s.rHand, target.rHand, k);
  s.lFoot = lerpV(s.lFoot, target.lFoot, k);
  s.rFoot = lerpV(s.rFoot, target.rFoot, k);
  s.hipY += (target.hipY - s.hipY) * k;
  s.lean += (target.lean - s.lean) * k;
  s.twist += (target.twist - s.twist) * k;
  // Angles can jump by full turns (tech flips), so blend the shortest way.
  s.tiltPitch += (target.tiltPitch - s.tiltPitch) * kt;
  s.tiltRoll += (target.tiltRoll - s.tiltRoll) * kt;
  s.glow += (target.glow - s.glow) * k;
  s.striking = target.striking;
  return s;
}

/** Two-bone IK: returns the middle joint (elbow/knee) for root -> target. */
function ik(root: V3, target: V3, l1: number, l2: number, pole: V3): { mid: V3; end: V3 } {
  let d = subV(target, root);
  let dist = lenV(d);
  const max = (l1 + l2) * 0.999;
  const dn = normV(d);
  if (dist > max) {
    dist = max;
    d = scaleV(dn, max);
  }
  dist = Math.max(dist, Math.abs(l1 - l2) + 1e-3);
  const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
  const a = Math.acos(cosA);
  let pn = subV(pole, scaleV(dn, dotV(pole, dn)));
  pn = normV(pn);
  const mid = addV(root, addV(scaleV(dn, l1 * Math.cos(a)), scaleV(pn, l1 * Math.sin(a))));
  return { mid, end: addV(root, scaleV(dn, dist)) };
}

function rotateAround(pt: V3, pivot: V3, pitch: number, roll: number): V3 {
  let x = pt.x - pivot.x;
  let y = pt.y - pivot.y;
  let z = pt.z - pivot.z;
  if (pitch !== 0) {
    const c = Math.cos(pitch);
    const s = Math.sin(pitch);
    const ny = y * c - z * s;
    const nz = y * s + z * c;
    y = ny;
    z = nz;
  }
  if (roll !== 0) {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    const nx = x * c + y * s;
    const ny = -x * s + y * c;
    x = nx;
    y = ny;
  }
  return v(x + pivot.x, y + pivot.y, z + pivot.z);
}

/** Builds the full skeleton (joint positions) from pose targets. */
export function solveSkeleton(stats: CharacterStats, p: PoseTargets): Joints {
  const b = bodyOf(stats);
  const lying = Math.abs(p.tiltPitch) > 1.2 && Math.abs(p.tiltPitch) < 2;
  const hipY = lying ? 0.22 * b.s : p.hipY;
  const hip = v(0, hipY, 0);
  const torsoLen = b.shoulderY - b.hipY;
  const chest = v(0, hipY + torsoLen * Math.cos(p.lean), torsoLen * Math.sin(p.lean));
  const tw = p.twist;
  const lShoulder = addV(chest, v(-b.shoulderX * Math.cos(tw), 0, b.shoulderX * Math.sin(tw)));
  const rShoulder = addV(chest, v(b.shoulderX * Math.cos(tw), 0, -b.shoulderX * Math.sin(tw)));
  const head = addV(chest, v(0, 0.2 * b.s, 0.02 + 0.05 * Math.sin(p.lean)));
  // Hands are authored relative to an upright body; carry them with the lean.
  const dy = hipY - (b.hipY - 0.03 * b.s);
  const lift = (h: V3): V3 => v(h.x, h.y + dy, h.z + Math.sin(p.lean) * 0.15);
  const lArm = ik(lShoulder, lift(p.lHand), b.upperArm, b.foreArm, v(-0.6, -1, -0.4));
  const rArm = ik(rShoulder, lift(p.rHand), b.upperArm, b.foreArm, v(0.6, -1, -0.4));
  const lHipJ = v(-0.1 * b.w, hipY - 0.04, 0);
  const rHipJ = v(0.1 * b.w, hipY - 0.04, 0);
  const lLeg = ik(lHipJ, p.lFoot, b.thigh, b.shin, v(-0.2, 0, 1));
  const rLeg = ik(rHipJ, p.rFoot, b.thigh, b.shin, v(0.2, 0, 1));
  const j: Joints = {
    hip,
    chest,
    head,
    lShoulder,
    rShoulder,
    lElbow: lArm.mid,
    rElbow: rArm.mid,
    lHand: lArm.end,
    rHand: rArm.end,
    lHipJ,
    rHipJ,
    lKnee: lLeg.mid,
    rKnee: rLeg.mid,
    lFoot: lLeg.end,
    rFoot: rLeg.end,
  };
  if (p.tiltPitch !== 0 || p.tiltRoll !== 0) {
    const pivot = lying ? v(0, hipY, 0) : hip;
    for (const k of Object.keys(j) as (keyof Joints)[]) j[k] = rotateAround(j[k], pivot, p.tiltPitch, p.tiltRoll);
  }
  return j;
}

/** Advances the stride phase from horizontal movement. */
export function advanceWalk(mem: AnimMemory, x: number, z: number, stats: CharacterStats, running: boolean): void {
  const d = Math.hypot(x - mem.lastX, z - mem.lastZ);
  if (d < 2) mem.phase += (d / ((running ? 0.9 : 0.65) * (stats.height / 1.8))) * Math.PI;
  mem.lastX = x;
  mem.lastZ = z;
}

