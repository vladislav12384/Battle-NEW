/**
 * Procedural animation v2.
 *
 * Placeholder fighters have no animation clips, so poses are built every
 * frame from the simulation state and then driven through damped SPRINGS:
 *
 *   - strikes have real phases: wind-up (the body coils, the limb chambers
 *     and holds), a snap through the move's actual hitbox path, follow-through
 *     past the target, and a recovery back to guard;
 *   - the whole body takes part (kinetic chain): hips shift weight, the torso
 *     twists and leans, the head rides along;
 *   - springs give overshoot and settle naturally, so nothing "teleports";
 *   - hits add physical impulses (head snaps the way it was hit, body folds
 *     around a body shot, guard arms get pushed back on block).
 *
 * All positions are in character-local space: x = right, y = up, z = forward,
 * relative to the feet. Real animation clips can replace this later.
 */
import { chestHeight, strikeLine } from '../../core/moves';
import { clamp } from '../../core/math/vec3';
import { RULES } from '../../core/rules';
import type { FighterState } from '../../core/state';
import type { CharacterStats, HitboxDef, LimbId, MoveDef } from '../../core/types';
import { strikePose } from './strikes';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
export const add = (a: V3, b: V3): V3 => v(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: V3, b: V3): V3 => v(a.x - b.x, a.y - b.y, a.z - b.z);
export const mul = (a: V3, s: number): V3 => v(a.x * s, a.y * s, a.z * s);
export const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const norm = (a: V3, fallback: V3 = v(0, 0, 1)): V3 => {
  const l = len(a);
  return l > 1e-6 ? mul(a, 1 / l) : fallback;
};
export const lerpV = (a: V3, b: V3, t: number): V3 => v(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
const cross = (a: V3, b: V3): V3 => v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const easeOut = (t: number): number => 1 - (1 - t) ** 3;
export const easeIn = (t: number): number => t * t * t;
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// ===========================================================================
// Springs

/** Damped harmonic spring. `w` = angular frequency (rad/s), `z` = damping ratio. */
export class Spring {
  v = 0;
  constructor(public x = 0) {}
  step(target: number, dt: number, w: number, z: number): number {
    const n = Math.max(1, Math.ceil(dt * 240));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = w * w * (target - this.x) - 2 * z * w * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

export class Spring3 {
  readonly sx: Spring;
  readonly sy: Spring;
  readonly sz: Spring;
  constructor(p: V3) {
    this.sx = new Spring(p.x);
    this.sy = new Spring(p.y);
    this.sz = new Spring(p.z);
  }
  step(t: V3, dt: number, w: number, z: number): V3 {
    return v(this.sx.step(t.x, dt, w, z), this.sy.step(t.y, dt, w, z), this.sz.step(t.z, dt, w, z));
  }
}

// ===========================================================================
// Pose

export interface Pose {
  lHand: V3;
  rHand: V3;
  lFoot: V3;
  rFoot: V3;
  hipX: number;
  hipY: number;
  hipZ: number;
  /** Torso pitch: + leans forward. */
  lean: number;
  /** Torso yaw: + brings the right shoulder forward. */
  twist: number;
  /** Torso roll: + tilts the chest to the right. */
  roll: number;
  /** Whole-body rotation around the hips (tumbles, lying down). */
  tiltPitch: number;
  tiltRoll: number;
  /** Head relative to the chest: pitch + nods down, yaw + looks left, roll + tilts right. */
  headPitch: number;
  headYaw: number;
  headRoll: number;
  glow: number;
  /** Extra hip yaw on top of the shoulders' (kicks turn the hips over). */
  hipTurn: number;
  /** Elbow placement: -1 tucked in front (uppercuts), 0 down, 1 raised out (hooks), 2 cocked high behind. */
  lElbow: number;
  rElbow: number;
  /** Knee placement: 0 forward, 1 turned out to the side, -1 turned over (roundhouse). */
  lKnee: number;
  rKnee: number;
  /** Foot pivot (yaw, + turns the toes outward) and heel lift (0..1). */
  lToe: number;
  rToe: number;
  lHeel: number;
  rHeel: number;
  /** Whole-body spin around the vertical axis (spinning strikes); not sprung. */
  spin: number;
  /** Whole-body somersault around the hips (+ = forward flip); not sprung. */
  flip: number;
  striking: LimbId[];
  /** Spring frequency per limb for this frame (snappy while striking). */
  stiff: Record<'lHand' | 'rHand' | 'lFoot' | 'rFoot' | 'body', number>;
}

type BodyKey =
  | 'hipX' | 'hipY' | 'hipZ' | 'lean' | 'twist' | 'roll' | 'tiltPitch' | 'tiltRoll' | 'headPitch' | 'headYaw' | 'headRoll' | 'glow'
  | 'hipTurn' | 'lElbow' | 'rElbow' | 'lKnee' | 'rKnee' | 'lToe' | 'rToe' | 'lHeel' | 'rHeel';
const BODY_KEYS: BodyKey[] = [
  'hipX', 'hipY', 'hipZ', 'lean', 'twist', 'roll', 'tiltPitch', 'tiltRoll', 'headPitch', 'headYaw', 'headRoll', 'glow',
  'hipTurn', 'lElbow', 'rElbow', 'lKnee', 'rKnee', 'lToe', 'rToe', 'lHeel', 'rHeel',
];

type ReactKey = 'headPitch' | 'headYaw' | 'headRoll' | 'lean' | 'twist' | 'roll' | 'hipZ' | 'guard';
const REACT_KEYS: ReactKey[] = ['headPitch', 'headYaw', 'headRoll', 'lean', 'twist', 'roll', 'hipZ', 'guard'];

/** Per-fighter animation memory kept by the client between frames. */
export interface AnimMemory {
  seed: number;
  phase: number;
  lastX: number;
  lastZ: number;
  limbs: Record<'lHand' | 'rHand' | 'lFoot' | 'rFoot', Spring3> | null;
  body: Record<BodyKey, Spring>;
  react: Record<ReactKey, Spring>;
}

export function newAnimMemory(seed: number): AnimMemory {
  const body = {} as Record<BodyKey, Spring>;
  for (const k of BODY_KEYS) body[k] = new Spring();
  const react = {} as Record<ReactKey, Spring>;
  for (const k of REACT_KEYS) react[k] = new Spring();
  return { seed, phase: 0, lastX: 0, lastZ: 0, limbs: null, body, react };
}

export interface Body {
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
    foreArm: 0.34 * s,
    thigh: 0.47 * s,
    shin: 0.47 * s,
  };
}

const IDLE = 18;
/** Head orientation of the neutral guard (the first-person camera measures motion relative to it). */
export const REST_HEAD = { pitch: 0.13, yaw: -0.1, roll: 0 };
const STIFF = { windup: 30, strike: 85, follow: 40, recover: 20 };

function guardPose(b: Body): Pose {
  return {
    lHand: v(-0.13 * b.w, 1.47 * b.s, 0.36 * b.s),
    rHand: v(0.16 * b.w, 1.4 * b.s, 0.25 * b.s),
    lFoot: v(-0.16 * b.w, 0, 0.2 * b.s),
    rFoot: v(0.18 * b.w, 0, -0.18 * b.s),
    hipX: 0,
    hipY: b.hipY - 0.04 * b.s,
    hipZ: 0,
    lean: 0.08,
    twist: -0.25, // orthodox stance: left shoulder leads
    roll: 0,
    tiltPitch: 0,
    tiltRoll: 0,
    headPitch: 0.05,
    headYaw: 0,
    headRoll: 0,
    glow: 0,
    hipTurn: 0,
    lElbow: 0,
    rElbow: 0,
    lKnee: 0,
    rKnee: 0,
    lToe: 0.25,
    rToe: 0.5,
    lHeel: 0,
    rHeel: 0.15,
    spin: 0,
    flip: 0,
    striking: [],
    stiff: { lHand: IDLE, rHand: IDLE, lFoot: IDLE, rFoot: IDLE, body: 14 },
  };
}

/** Rotates a hitbox point by the aim pitch around the chest (mirrors core/moves.aimedPoint). */
function aimLocal(p: readonly [number, number, number], pitch: number, pivot: number): V3 {
  if (pitch === 0) return v(p[0], p[1], p[2]);
  const ry = p[1] - pivot;
  const c = Math.cos(pitch);
  const s = Math.sin(pitch);
  return v(p[0], ry * c + p[2] * s + pivot, p[2] * c - ry * s);
}

type Phase = 'idle' | 'windup' | 'strike' | 'follow' | 'recover';

interface LimbAnim {
  pos: V3;
  phase: Phase;
  /** 0..1 progress within the phase. */
  k: number;
  /** Strike vector (B - A) of the relevant hitbox. */
  sweep: V3;
}

/**
 * Drives one limb through a move: wind up to a chambered position (and hold
 * the tension), snap along the real hitbox path, overshoot, recover to guard.
 */
function limbAnim(
  boxes: HitboxDef[],
  m: MoveDef,
  frame: number,
  rest: V3,
  root: V3,
  pitch: number,
  pivot: number,
  foot: boolean,
): LimbAnim {
  const total = m.startup + m.active + m.recovery;
  const sorted = [...boxes].sort((a, b) => a.frames[0] - b.frames[0]);
  const cur = sorted.find((h) => frame >= h.frames[0] - 0.999 && frame <= h.frames[1] + 0.999);
  const next = sorted.find((h) => h.frames[0] - 0.999 > frame);
  const prev = [...sorted].reverse().find((h) => h.frames[1] + 0.999 < frame);
  const pathOf = (h: HitboxDef): { a: V3; b: V3 } => {
    const a = aimLocal(h.a, pitch, pivot);
    return { a, b: h.b ? aimLocal(h.b, pitch, pivot) : add(a, mul(norm(sub(a, root)), 0.12)) };
  };

  if (cur) {
    const { a, b } = pathOf(cur);
    const k = clamp((frame - cur.frames[0] + 1) / (cur.frames[1] - cur.frames[0] + 1), 0, 1);
    return { pos: lerpV(a, b, easeOut(k)), phase: 'strike', k, sweep: sub(b, a) };
  }
  if (prev && (!next || frame - prev.frames[1] < 6)) {
    const { a, b } = pathOf(prev);
    const dir = norm(sub(b, a), norm(sub(b, root)));
    const followLen = Math.min(5, Math.max(2, m.recovery * 0.3));
    const since = frame - prev.frames[1];
    if (since <= followLen) {
      // Follow-through: carry past the target, then ease off.
      const k = since / followLen;
      const over = (foot ? 0.1 : 0.14) * Math.sin(Math.PI * Math.min(1, k * 1.2));
      return { pos: add(b, mul(dir, over)), phase: 'follow', k, sweep: sub(b, a) };
    }
    const end = next ? next.frames[0] - 1 : total;
    const k = clamp((since - followLen) / Math.max(1, end - prev.frames[1] - followLen), 0, 1);
    return { pos: lerpV(b, rest, easeInOut(k)), phase: 'recover', k, sweep: sub(b, a) };
  }
  if (next) {
    const { a, b } = pathOf(next);
    const sweep = sub(b, a);
    const dir = norm(sweep, norm(sub(a, root)));
    let chamber: V3;
    if (foot) {
      // Knee up, foot tucked toward the hip (sweeps stay low).
      chamber = a.y < 0.4 ? v(a.x * 1.1, 0.12, a.z * 0.2) : v(a.x * 0.7, Math.max(0.55, Math.min(a.y, 1.1)), Math.max(0.05, a.z * 0.3));
    } else if (Math.abs(sweep.x) > 0.4) {
      // Hooks / backfists: pull the fist out wide and back.
      chamber = add(a, v(Math.sign(a.x || 1) * 0.1, 0.02, -0.12));
    } else if (sweep.y > 0.4) {
      // Uppercuts: drop the fist low.
      chamber = add(a, v(0, -0.12, -0.12));
    } else if (sweep.y < -0.4) {
      // Overheads: raise it high behind the head.
      chamber = add(a, v(0, 0.12, -0.25));
    } else {
      // Straights: cock back toward the shoulder.
      chamber = add(lerpV(root, a, 0.3), mul(dir, -0.1));
    }
    const startFrom = prev ? prev.frames[1] + 1 : 1;
    const span = Math.max(1, next.frames[0] - startFrom);
    const k = clamp((frame - startFrom) / span, 0, 1);
    // Reach the chamber at ~70% of the wind-up, then hold the tension.
    const p = easeInOut(Math.min(1, k / 0.7));
    const from = prev ? pathOf(prev).b : rest;
    return { pos: lerpV(from, chamber, p), phase: 'windup', k, sweep };
  }
  return { pos: rest, phase: 'idle', k: 0, sweep: v(0, 0, 0) };
}

const SIDE: Record<LimbId, number> = { lHand: -1, rHand: 1, lFoot: -1, rFoot: 1, body: 0, head: 0 };

/**
 * Raw pose targets for this frame.
 * @param frac fraction of a tick elapsed since the last simulation step (0..1)
 */
export function computeTargets(
  f: FighterState,
  stats: CharacterStats,
  move: MoveDef | null,
  mem: AnimMemory,
  time: number,
  frac: number,
  /** The local first-person player: the camera already shows where they aim. */
  firstPerson = false,
): Pose {
  const b = bodyOf(stats);
  const p = guardPose(b);
  const fr = f.hitstop > 0 ? 0 : frac;
  const sf = f.stateFrame + fr;

  const yawS = Math.sin(f.yaw);
  const yawC = Math.cos(f.yaw);
  const localX = yawC * f.vel.x - yawS * f.vel.z;
  const localZ = -yawS * f.vel.x - yawC * f.vel.z;
  const speed = Math.hypot(localX, localZ);

  // Everyone else's head and chest follow where they aim.
  if (!firstPerson) {
    p.headPitch = clamp(-f.aimPitch * 0.6, -0.6, 0.6) + 0.05;
    p.lean += clamp(-f.aimPitch * 0.15, -0.2, 0.2);
  }

  switch (f.state) {
    case 'ground':
    case 'block':
    case 'dodge':
    case 'land':
    case 'jumpsquat': {
      if (f.state === 'block') {
        p.lHand = v(-0.08 * b.w, 1.58 * b.s, 0.3 * b.s);
        p.rHand = v(0.1 * b.w, 1.53 * b.s, 0.27 * b.s);
        p.hipY -= 0.06 * b.s;
        p.lean = 0.18;
        p.headPitch = 0.2;
        p.twist = -0.1;
      }
      if (speed > 0.3 && f.grounded && f.state !== 'dodge') {
        const run = f.running;
        const stride = (run ? 0.55 : 0.33) * b.s;
        const dx = localX / speed;
        const dz = localZ / speed;
        const sL = Math.sin(mem.phase);
        const sR = Math.sin(mem.phase + Math.PI);
        p.lFoot = v(-0.13 * b.w + dx * sL * stride, Math.max(0, Math.cos(mem.phase)) * 0.14 * b.s, dz * sL * stride + 0.05);
        p.rFoot = v(0.14 * b.w + dx * sR * stride, Math.max(0, Math.cos(mem.phase + Math.PI)) * 0.14 * b.s, dz * sR * stride - 0.05);
        p.hipY -= Math.abs(Math.sin(mem.phase)) * 0.035 * b.s;
        p.roll = -(localX / Math.max(speed, 4)) * 0.12; // lean into strafes
        p.lean += (localZ / Math.max(speed, 4)) * 0.08;
        if (run && f.state === 'ground') {
          p.lean = 0.32;
          p.lHand = v(-0.22 * b.w, 1.15 * b.s, -sL * 0.35 * b.s);
          p.rHand = v(0.22 * b.w, 1.15 * b.s, -sR * 0.35 * b.s);
          p.twist = sL * 0.25;
        }
      } else if (f.state === 'ground' && !f.exhausted) {
        // Fighters never stand still: bounce on the balls of the feet.
        const bounce = Math.sin(time * 6.5 + mem.seed) * 0.014 * b.s;
        const sway = Math.sin(time * 1.7 + mem.seed * 2) * 0.02;
        p.hipY += bounce;
        p.lHand = add(p.lHand, v(0, bounce * 0.8, 0));
        p.rHand = add(p.rHand, v(0, bounce * 0.8, 0));
        p.twist += sway;
        p.roll += sway * 0.5;
      }
      if (f.exhausted && (f.state === 'ground' || f.state === 'block')) {
        // Out of breath: guard sags, shoulders heave, head drops.
        const breath = Math.sin(time * 3.2 + mem.seed);
        p.lHand = add(p.lHand, v(0.02, -0.17 + breath * 0.025, -0.06));
        p.rHand = add(p.rHand, v(-0.02, -0.15 + breath * 0.025, -0.04));
        p.lean += 0.14 + breath * 0.03;
        p.headPitch += 0.3;
        p.hipY -= 0.05 * b.s;
        p.stiff.body = 8;
      }
      if (f.state === 'jumpsquat' || f.state === 'land') {
        p.hipY -= 0.2 * b.s;
        p.lean = 0.25;
        p.stiff.body = 30;
      }
      if (f.state === 'dodge') {
        const D = f.dodgeAir ? RULES.airDodge : RULES.dodge;
        const t = clamp(sf / D.frames, 0, 1);
        const dx = yawC * f.dodgeDirX - yawS * f.dodgeDirZ;
        const dz = -yawS * f.dodgeDirX - yawC * f.dodgeDirZ;
        const k = Math.sin(t * Math.PI);
        // Slip: the body ducks and swings off the line, the feet push off wide.
        p.roll = dx * 0.5 * k;
        p.lean = 0.12 + dz * 0.35 * k;
        p.hipY -= 0.24 * b.s * k;
        p.hipX = dx * 0.16 * k;
        p.headPitch += 0.15 * k;
        p.lFoot = add(p.lFoot, v(dx * 0.12 * k - 0.04 * k, 0, dz * 0.1 * k));
        p.rFoot = add(p.rFoot, v(dx * 0.12 * k + 0.04 * k, 0, dz * 0.1 * k));
        p.lHand = add(p.lHand, v(dx * 0.05 * k, -0.04 * k, -0.03 * k));
        p.rHand = add(p.rHand, v(dx * 0.05 * k, -0.04 * k, -0.03 * k));
        p.stiff.body = 26;
      }
      break;
    }
    case 'air': {
      p.lFoot = v(-0.14 * b.w, 0.38 * b.s, 0.14 * b.s);
      p.rFoot = v(0.15 * b.w, 0.52 * b.s, -0.04 * b.s);
      p.hipY += 0.04 * b.s;
      break;
    }
    case 'attack': {
      if (!move) break;
      attackPose(p, f, stats, b, move, fr, firstPerson, time);
      break;
    }
    case 'blockstun':
      p.lHand = v(-0.08 * b.w, 1.58 * b.s, 0.26 * b.s);
      p.rHand = v(0.1 * b.w, 1.53 * b.s, 0.23 * b.s);
      p.lean = 0.05;
      p.hipY -= 0.08 * b.s;
      p.headPitch = 0.3;
      break;
    case 'hitstun': {
      const k = clamp(f.stun / 20, 0, 1);
      p.lean = -0.15 * k;
      p.lHand = v(-0.28 * b.w, 1.3 * b.s, 0.12);
      p.rHand = v(0.3 * b.w, 1.32 * b.s, 0.08);
      p.hipY -= 0.03 * b.s;
      break;
    }
    case 'stagger': {
      const w = Math.sin(sf * 0.22 + mem.seed) * 0.3;
      p.lean = -0.12 + Math.sin(sf * 0.13) * 0.1;
      p.roll = w * 0.4;
      p.headPitch = 0.35 + Math.sin(sf * 0.3) * 0.15;
      p.headRoll = w * 0.6;
      p.lHand = v(-0.3 * b.w, 1.0 * b.s, 0.08);
      p.rHand = v(0.3 * b.w, 0.98 * b.s, 0.05);
      p.hipY -= 0.1 * b.s;
      p.stiff.body = 8;
      break;
    }
    case 'juggle':
    case 'wallsplat':
    case 'grabbed': {
      p.lHand = v(-0.48 * b.w, 1.5 * b.s, -0.05);
      p.rHand = v(0.48 * b.w, 1.58 * b.s, -0.12);
      p.lFoot = v(-0.2 * b.w, 0.15 * b.s, 0.22);
      p.rFoot = v(0.22 * b.w, 0.3 * b.s, -0.1);
      p.headPitch = -0.4;
      if (f.state === 'juggle') {
        p.tiltPitch = -clamp(0.4 + sf * 0.035, 0, 1.35);
        p.tiltRoll = Math.sin(mem.seed * 3) * 0.3;
        if (f.grounded) p.tiltPitch = -Math.PI / 2;
        p.stiff.body = 10;
      } else if (f.state === 'wallsplat') {
        p.tiltPitch = -0.25;
        p.lHand = v(-0.62 * b.w, 1.75 * b.s, -0.15);
        p.rHand = v(0.62 * b.w, 1.8 * b.s, -0.15);
      } else {
        p.hipY += 0.1 * b.s;
        p.lFoot = add(p.lFoot, v(0, 0.1, 0));
        p.rFoot = add(p.rFoot, v(0, 0.1, 0));
      }
      break;
    }
    case 'knockdown':
    case 'ko':
      if (f.grounded || f.state === 'knockdown') {
        p.tiltPitch = -Math.PI / 2;
        p.lHand = v(-0.5 * b.w, 1.3 * b.s, 0);
        p.rHand = v(0.5 * b.w, 1.42 * b.s, 0.1);
        p.lFoot = v(-0.22 * b.w, 0, 0.1);
        p.rFoot = v(0.22 * b.w, 0.05, 0.05);
        p.headPitch = -0.3;
        p.headYaw = Math.sin(mem.seed) * 0.5;
        p.stiff.body = 9;
      } else {
        p.tiltPitch = -clamp(0.4 + sf * 0.04, 0, Math.PI / 2);
        p.lHand = v(-0.48 * b.w, 1.5 * b.s, -0.05);
        p.rHand = v(0.48 * b.w, 1.58 * b.s, -0.12);
      }
      break;
    case 'getup': {
      const t = clamp(sf / RULES.getupFrames, 0, 1);
      p.tiltPitch = (-Math.PI / 2) * (1 - easeOut(t));
      p.hipY -= 0.25 * (1 - t);
      p.stiff.body = 20;
      break;
    }
    case 'tech': {
      const t = clamp(sf / RULES.techFrames, 0, 1);
      p.tiltPitch = (f.grounded ? -1 : 1) * Math.PI * 2 * easeInOut(t) * (f.grounded ? 0.5 : 1);
      p.hipY -= 0.35 * b.s * Math.sin(t * Math.PI);
      p.lFoot = v(-0.12, 0.4 * b.s * Math.sin(t * Math.PI), 0.1);
      p.rFoot = v(0.12, 0.4 * b.s * Math.sin(t * Math.PI), 0.1);
      p.stiff.body = 40;
      break;
    }
    case 'recoil':
      p.lean = -0.3;
      p.lHand = v(-0.28 * b.w, 1.4 * b.s, 0.08);
      p.rHand = v(0.3 * b.w, 1.36 * b.s, 0.0);
      p.headPitch = -0.2;
      break;
    case 'grabbing':
      p.lHand = v(-0.12 * b.w, 1.32 * b.s, 0.5 * b.s);
      p.rHand = v(0.12 * b.w, 1.32 * b.s, 0.5 * b.s);
      p.lean = 0.2;
      if (f.stateFrame > RULES.throwTechWindow) {
        const t = clamp((sf - RULES.throwTechWindow) / 12, 0, 1);
        p.twist = 1.3 * easeOut(t);
        p.lHand = add(p.lHand, v(0, 0, 0.2 * t));
        p.rHand = add(p.rHand, v(0, 0.3 * t, 0));
        p.stiff.body = 30;
      }
      break;
    case 'burst': {
      const t = clamp(sf / 10, 0, 1);
      p.lHand = v(-0.75 * b.w, 1.85 * b.s, 0.1);
      p.rHand = v(0.75 * b.w, 1.85 * b.s, 0.1);
      p.lFoot = v(-0.32 * b.w, 0, 0);
      p.rFoot = v(0.32 * b.w, 0, 0);
      p.lean = -0.3 * t;
      p.headPitch = -0.5 * t;
      p.glow = 1 - clamp((sf - 10) / 20, 0, 1);
      p.stiff = { lHand: 40, rHand: 40, lFoot: 30, rFoot: 30, body: 30 };
      break;
    }
  }
  if (f.meter >= 100 && f.state !== 'ko') p.glow = Math.max(p.glow, 0.12);
  return p;
}

/** Feet tucked during aerial strikes that don't use them, and during rising moves. */
function airFeet(p: Pose, f: FighterState, b: Body, move: MoveDef, feetUsed: boolean): void {
  if (move.air && !feetUsed) {
    p.lFoot = v(-0.14 * b.w, 0.38 * b.s, 0.14 * b.s);
    p.rFoot = v(0.15 * b.w, 0.52 * b.s, -0.04 * b.s);
  }
  if (move.motion?.some((mo) => (mo.up ?? 0) > 0) && !f.grounded && !feetUsed) {
    p.lFoot = v(-0.12 * b.w, 0.2 * b.s, -0.05);
    p.rFoot = v(0.12 * b.w, 0.35 * b.s, 0.05);
  }
}

/** Styles that place the feet themselves (corkscrew, recoil flight, jumps). */
const FEET_STYLES = new Set(['dragon', 'opticRecoil', 'cyclone', 'geneSplice', 'opticBank', 'opticCalc', 'megaBeam', 'flipHammer', 'airTornado', 'meteor']);

/** Strike poses: choreographed styles (strikes.ts), else limbs follow the hitboxes. */
function attackPose(p: Pose, f: FighterState, stats: CharacterStats, b: Body, move: MoveDef, fr: number, firstPerson: boolean, time: number): void {
  const frame = f.charging || f.beaming ? f.moveFrame : f.moveFrame + fr;
  if (strikePose(p, f, stats, b, move, frame, strikeLine(move), firstPerson, time)) {
    const feetUsed = move.hitboxes.some((h) => h.limb === 'lFoot' || h.limb === 'rFoot');
    // These styles place the feet themselves (corkscrew, recoil flight).
    if (!FEET_STYLES.has(move.anim ?? '')) airFeet(p, f, b, move, feetUsed);
    if (move.kind === 'super') p.glow = Math.max(p.glow, 0.8);
    return;
  }
  const pivot = chestHeight(stats);
  const pitch = move.pitchAim === false ? 0 : clamp(f.aimPitch, -RULES.maxPitch, RULES.maxPitch);
  const byLimb = new Map<LimbId, HitboxDef[]>();
  for (const h of move.hitboxes) {
    const limb = h.limb ?? 'rHand';
    if (!byLimb.has(limb)) byLimb.set(limb, []);
    byLimb.get(limb)!.push(h);
  }
  // The leading limb (strongest phase) decides how the body moves.
  let lead: { limb: LimbId; a: LimbAnim } | null = null;
  const rank: Record<Phase, number> = { strike: 4, follow: 3, windup: 2, recover: 1, idle: 0 };
  for (const [limb, boxes] of byLimb) {
    if (limb === 'lHand' || limb === 'rHand') {
      const sh = v(SIDE[limb] * b.shoulderX, b.shoulderY, 0);
      const rest = limb === 'lHand' ? p.lHand : p.rHand;
      const a = limbAnim(boxes, move, frame, rest, sh, pitch, pivot, false);
      p[limb] = a.pos;
      p.stiff[limb] = a.phase === 'idle' ? IDLE : STIFF[a.phase];
      if (a.phase === 'strike' || (a.phase === 'follow' && a.k < 0.5)) p.striking.push(limb);
      if (!lead || rank[a.phase] > rank[lead.a.phase]) lead = { limb, a };
    } else if (limb === 'lFoot' || limb === 'rFoot') {
      const hip = v(SIDE[limb] * 0.1 * b.w, b.hipY, 0);
      const rest = limb === 'lFoot' ? p.lFoot : p.rFoot;
      const a = limbAnim(boxes, move, frame, rest, hip, pitch, pivot, true);
      p[limb] = a.pos;
      p.stiff[limb] = a.phase === 'idle' ? IDLE : STIFF[a.phase] * 0.85;
      if (a.phase === 'strike' || (a.phase === 'follow' && a.k < 0.5)) p.striking.push(limb);
      // Plant the standing foot under the body.
      const other = limb === 'lFoot' ? 'rFoot' : 'lFoot';
      p[other] = v(SIDE[other] * 0.12 * b.w, 0, 0.02);
      if (!lead || rank[a.phase] > rank[lead.a.phase]) lead = { limb, a };
    } else if (limb === 'body') {
      const first = boxes[0];
      const t = clamp((frame - 1) / Math.max(1, first.frames[0]), 0, 1);
      p.lean = 0.15 + 0.4 * easeOut(t);
      p.lHand = v(-0.16 * b.w, 1.36 * b.s, 0.32 * b.s);
      p.rHand = v(0.04 * b.w, 1.24 * b.s, 0.16 * b.s);
      p.twist = -0.5;
      p.hipZ = 0.1 * t;
      if (frame >= first.frames[0] && frame <= first.frames[1]) p.striking.push('body');
    }
  }

  if (lead) {
    const { limb, a } = lead;
    const side = SIDE[limb];
    const isFoot = limb === 'lFoot' || limb === 'rFoot';
    const sw = a.sweep;
    // Body shape of the strike itself (full intensity at impact).
    const strikeTwist = clamp(side * (isFoot ? 0.7 : 0.62) - sw.x * 0.55, -1.15, 1.15);
    const strikeLean = isFoot ? -0.22 - Math.max(0, sw.y) * 0.08 : 0.22 + Math.max(0, sw.z) * 0.12 - Math.max(0, sw.y) * 0.12;
    const strikeRoll = clamp(sw.x * 0.22 + (isFoot ? -side * 0.18 : 0), -0.4, 0.4); // roll with the swing
    const strikeHipZ = isFoot ? -0.05 : 0.13;
    const strikeHipY = sw.y > 0.4 ? 0.04 : sw.y < -0.4 ? -0.08 : 0;
    // Coiled wind-up: the opposite of the strike, smaller.
    const coilTwist = -side * (isFoot ? 0.5 : 0.4);
    const coilHipY = sw.y > 0.4 ? -0.09 : isFoot ? -0.04 : -0.03;
    let w = 0;
    let c = 0;
    if (a.phase === 'windup') c = easeInOut(Math.min(1, a.k / 0.7));
    else if (a.phase === 'strike' || a.phase === 'follow') w = 1;
    else if (a.phase === 'recover') w = 1 - easeInOut(a.k);
    p.twist = p.twist * (1 - Math.max(w, c)) + strikeTwist * w + coilTwist * c;
    p.lean = p.lean * (1 - w) + strikeLean * w + (isFoot ? -0.12 : -0.04) * c;
    p.roll = strikeRoll * w + side * 0.06 * c;
    p.hipZ = strikeHipZ * w - 0.05 * c;
    p.hipY += strikeHipY * w + coilHipY * c;
    p.headPitch = p.headPitch * (1 - w) + (isFoot ? -0.1 : 0.12) * w;
    p.stiff.body = a.phase === 'strike' ? 40 : a.phase === 'windup' ? 22 : 16;
    if (!isFoot && limb !== 'body' && move.kind !== 'throw') {
      // Footwork: step into the punch with the lead foot, rear heel comes up, hips sit down.
      p.lFoot = add(p.lFoot, v(0, 0, 0.13 * w * b.s - 0.04 * c));
      p.rFoot = add(p.rFoot, v(0, 0.05 * w, 0.05 * w));
      p.hipY -= 0.035 * w;
    }
    const recoverStart = move.startup + move.active;
    if (f.extraRecovery > 0 && frame > recoverStart) {
      // Missed: overextended, off balance, slow to come back.
      const k = clamp((frame - recoverStart) / (move.recovery + f.extraRecovery), 0, 1);
      const off = 1 - easeInOut(k);
      p.lean += 0.28 * off;
      p.hipZ += 0.1 * off;
      p.roll += side * 0.08 * off;
      p.headPitch += 0.15 * off;
      p.stiff.body = 9;
      p.stiff[limb === 'body' || limb === 'head' ? 'body' : limb] = 11;
    }
    if (!isFoot && move.kind !== 'throw') {
      // The off hand stays home to guard the chin.
      const off = limb === 'lHand' ? 'rHand' : 'lHand';
      if (!byLimb.has(off)) p[off] = v(SIDE[off] * 0.1 * b.w, 1.5 * b.s, 0.24 * b.s);
    }
  }

  if (f.charging || (move.charge && frame <= move.charge.frame + 1 && f.chargeFrames > 0)) {
    const c = move.charge ? Math.min(1, f.chargeFrames / move.charge.fullAt) : 0;
    p.rHand = v(0.34 * b.w, 1.44 * b.s, -0.34 * b.s);
    p.twist = -0.75;
    p.lean = -0.08;
    p.glow = 0.3 + 0.7 * c;
    p.hipY -= 0.08 * b.s;
    p.roll = Math.sin(f.chargeFrames * 0.9) * 0.02 * c; // trembling with power
  }
  if (move.kind === 'super') p.glow = Math.max(p.glow, 0.8);
  airFeet(p, f, b, move, byLimb.has('lFoot') || byLimb.has('rFoot'));
  if (move.kind === 'throw') {
    const k = Math.sin(clamp(frame / (move.startup + move.active), 0, 1) * Math.PI);
    p.lHand = v(-0.15 * b.w, 1.3 * b.s, 0.4 + 0.15 * k);
    p.rHand = v(0.15 * b.w, 1.3 * b.s, 0.4 + 0.15 * k);
    p.lean = 0.25 * k;
  }
}

// ===========================================================================
// Spring integration and impulses

/** Advances all springs toward the targets; returns the animated pose (with hit reactions). */
export function animate(mem: AnimMemory, target: Pose, dt: number): Pose {
  if (!mem.limbs) {
    mem.limbs = {
      lHand: new Spring3(target.lHand),
      rHand: new Spring3(target.rHand),
      lFoot: new Spring3(target.lFoot),
      rFoot: new Spring3(target.rFoot),
    };
    for (const k of BODY_KEYS) mem.body[k].x = target[k];
  }
  const out: Pose = { ...target };
  for (const k of ['lHand', 'rHand', 'lFoot', 'rFoot'] as const) {
    // Lightly underdamped: strikes overshoot a touch and settle (follow-through).
    out[k] = mem.limbs[k].step(target[k], dt, target.stiff[k], 0.62);
  }
  for (const k of BODY_KEYS) {
    const tilt = k === 'tiltPitch' || k === 'tiltRoll';
    out[k] = mem.body[k].step(target[k], dt, tilt ? Math.min(target.stiff.body, 16) : target.stiff.body, 0.75);
  }
  // Impulse-driven reactions settle back to zero with a wobble.
  const r = mem.react;
  out.headPitch += r.headPitch.step(0, dt, 11, 0.38);
  out.headYaw += r.headYaw.step(0, dt, 11, 0.38);
  out.headRoll += r.headRoll.step(0, dt, 11, 0.38);
  out.lean += r.lean.step(0, dt, 9, 0.42);
  out.twist += r.twist.step(0, dt, 9, 0.42);
  out.roll += r.roll.step(0, dt, 9, 0.42);
  out.hipZ += r.hipZ.step(0, dt, 10, 0.5);
  const guard = r.guard.step(0, dt, 14, 0.45);
  out.lHand = add(out.lHand, v(0, guard * 0.3, -guard));
  out.rHand = add(out.rHand, v(0, guard * 0.3, -guard));
  return out;
}

/**
 * Physical hit reaction. `dir` is the knockback direction in the victim's
 * local frame (x right, y up, z forward), `high` = hit above the chest.
 */
export function hitReaction(mem: AnimMemory, dir: V3, high: boolean, strength: number): void {
  const r = mem.react;
  const s = clamp(strength, 0.25, 1.6);
  if (high) {
    r.headPitch.v += (dir.z * 9 - Math.max(0, dir.y) * 16) * s; // snapped back / up
    r.headRoll.v += dir.x * 10 * s; // hooks whip the head sideways
    r.headYaw.v += -dir.x * 9 * s;
  } else {
    r.lean.v += 7 * s; // folds around a body shot
    r.headPitch.v += 6 * s;
  }
  r.lean.v += dir.z * 4 * s - Math.max(0, dir.y) * 3 * s;
  r.twist.v += -dir.x * 6 * s;
  r.roll.v += dir.x * 5 * s;
  r.hipZ.v += dir.z * 1.2 * s;
}

/** Arms pushed back into the guard by a blocked hit. */
export function blockReaction(mem: AnimMemory, strength: number): void {
  mem.react.guard.v += 2.2 * clamp(strength, 0.3, 1.5);
  mem.react.lean.v -= 2 * clamp(strength, 0.3, 1.5);
  mem.react.headPitch.v -= 2.5 * clamp(strength, 0.3, 1.5);
}

/** The attacker's body jolts on impact (the "weight" of connecting). */
export function impactRecoil(mem: AnimMemory, strength: number): void {
  mem.react.lean.v -= 1.6 * clamp(strength, 0.3, 1.5);
  mem.react.hipZ.v -= 0.3 * clamp(strength, 0.3, 1.5);
}

// ===========================================================================
// Skeleton

export interface Joints {
  hip: V3;
  chest: V3;
  neck: V3;
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
  /** Unit vectors of the chest frame (for the torso mesh). */
  chestUp: V3;
  chestRight: V3;
  /** Head orientation relative to the body: pitch + nods down, yaw + left, roll + right. */
  headRot: { pitch: number; yaw: number; roll: number };
  /** Foot pivots (yaw, spin included) and heel lifts for the foot meshes. */
  feet: { lToe: number; rToe: number; lHeel: number; rHeel: number };
}

export type JointPoint = Exclude<keyof Joints, 'chestUp' | 'chestRight' | 'headRot' | 'feet'>;

const POINT_KEYS: readonly JointPoint[] = [
  'hip', 'chest', 'neck', 'head', 'lShoulder', 'rShoulder', 'lElbow', 'rElbow', 'lHand', 'rHand',
  'lHipJ', 'rHipJ', 'lKnee', 'rKnee', 'lFoot', 'rFoot',
];

function ik(root: V3, target: V3, l1: number, l2: number, pole: V3): { mid: V3; end: V3 } {
  const dn = norm(sub(target, root));
  let dist = len(sub(target, root));
  dist = clamp(dist, Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.999);
  const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
  const a = Math.acos(cosA);
  const pn = norm(sub(pole, mul(dn, dot(pole, dn))), v(0, -1, 0));
  const mid = add(root, add(mul(dn, l1 * Math.cos(a)), mul(pn, l1 * Math.sin(a))));
  return { mid, end: add(root, mul(dn, dist)) };
}

function rotateAround(pt: V3, pivot: V3, pitch: number, roll: number): V3 {
  let x = pt.x - pivot.x;
  let y = pt.y - pivot.y;
  let z = pt.z - pivot.z;
  if (pitch !== 0) {
    const c = Math.cos(pitch);
    const s = Math.sin(pitch);
    const ny = y * c - z * s;
    z = y * s + z * c;
    y = ny;
  }
  if (roll !== 0) {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    const nx = x * c + y * s;
    y = -x * s + y * c;
    x = nx;
  }
  return v(x + pivot.x, y + pivot.y, z + pivot.z);
}

/** Where an elbow points (IK pole) for a given elbow placement (see Pose.lElbow). */
function elbowPole(sd: number, e: number, right: V3, fwd: V3): V3 {
  const at = (r: number, u: number, f: number): V3 => add(add(mul(right, sd * r), v(0, u, 0)), mul(fwd, f));
  const down = at(0.7, -1, -0.3);
  if (e < 0) return lerpV(down, at(0.15, -1, 0.8), Math.min(1, -e));
  if (e <= 1) return lerpV(down, at(1, 0.35, -0.2), e);
  return lerpV(at(1, 0.35, -0.2), at(0.45, 0.9, -0.7), Math.min(1, e - 1));
}

/** Where a knee points (IK pole) for a given knee placement (see Pose.lKnee). */
function kneePole(sd: number, k: number, hipRight: V3, hipFwd: V3): V3 {
  const at = (r: number, u: number, f: number): V3 => add(add(mul(hipRight, sd * r), v(0, u, 0)), mul(hipFwd, f));
  const fwdPole = at(0.25, 0, 1);
  if (k >= 0) return lerpV(fwdPole, at(1, 0.25, 0.35), Math.min(1, k));
  return lerpV(fwdPole, at(-0.9, 0.55, 0.3), Math.min(1, -k));
}

/** Builds the full skeleton from an animated pose. */
export function solveSkeleton(stats: CharacterStats, p: Pose): Joints {
  const b = bodyOf(stats);
  const lying = Math.abs(p.tiltPitch) > 1.2 && Math.abs(p.tiltPitch) < 2;
  const hipY = lying ? 0.22 * b.s : p.hipY;
  const hip = v(p.hipX, hipY, p.hipZ);
  const torsoLen = b.shoulderY - b.hipY;
  const up = norm(v(Math.sin(p.roll), Math.cos(p.lean) * Math.cos(p.roll), Math.sin(p.lean)));
  const chest = add(hip, mul(up, torsoLen));
  // Shoulder line rotated by the twist (+ = right shoulder forward), kept perpendicular to the spine.
  let right = v(Math.cos(p.twist), 0, Math.sin(p.twist));
  right = norm(sub(right, mul(up, dot(right, up))), v(1, 0, 0));
  const lShoulder = sub(chest, mul(right, b.shoulderX));
  const rShoulder = add(chest, mul(right, b.shoulderX));
  const fwd = cross(right, up);
  const neck = add(chest, mul(up, 0.07 * b.s));
  // Head tilts on top of the neck.
  const headDir = norm(add(up, add(mul(fwd, Math.sin(p.headPitch) * 0.8), mul(right, Math.sin(p.headRoll) * 0.8))));
  const head = add(neck, mul(headDir, 0.14 * b.s));

  const lArm = ik(lShoulder, p.lHand, b.upperArm, b.foreArm, elbowPole(-1, p.lElbow, right, fwd));
  const rArm = ik(rShoulder, p.rHand, b.upperArm, b.foreArm, elbowPole(1, p.rElbow, right, fwd));
  // Hips turn half as much as the shoulders, plus their own turn (kicks).
  const ht = p.twist * 0.45 + p.hipTurn;
  const hipRight = v(Math.cos(ht), 0, Math.sin(ht));
  const hipFwd = v(-Math.sin(ht), 0, Math.cos(ht));
  const lHipJ = add(hip, add(mul(hipRight, -0.1 * b.w), v(0, -0.04, 0)));
  const rHipJ = add(hip, add(mul(hipRight, 0.1 * b.w), v(0, -0.04, 0)));
  const lLeg = ik(lHipJ, p.lFoot, b.thigh, b.shin, kneePole(-1, p.lKnee, hipRight, hipFwd));
  const rLeg = ik(rHipJ, p.rFoot, b.thigh, b.shin, kneePole(1, p.rKnee, hipRight, hipFwd));

  const j: Joints = {
    hip,
    chest,
    neck,
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
    chestUp: up,
    chestRight: right,
    headRot: {
      pitch: p.lean + p.headPitch,
      yaw: p.twist * 0.4 + p.headYaw + p.spin,
      roll: p.roll + p.headRoll,
    },
    feet: { lToe: p.lToe - p.spin, rToe: p.rToe + p.spin, lHeel: p.lHeel, rHeel: p.rHeel },
  };
  if (p.spin !== 0) {
    // Spinning strikes turn the whole body around the hips.
    const c = Math.cos(p.spin);
    const sn = Math.sin(p.spin);
    const turn = (q: V3, px: number, pz: number): V3 => {
      const x = q.x - px;
      const z = q.z - pz;
      return v(px + x * c + z * sn, q.y, pz + z * c - x * sn);
    };
    for (const k of POINT_KEYS) j[k] = turn(j[k], hip.x, hip.z);
    j.chestUp = turn(j.chestUp, 0, 0);
    j.chestRight = turn(j.chestRight, 0, 0);
  }
  const tp = p.tiltPitch + p.flip;
  if (tp !== 0 || p.tiltRoll !== 0) {
    // A somersault turns around the middle of the body, a tumble around the hips.
    const pivot = v(0, hipY + (p.flip !== 0 ? 0.15 * b.s : 0), 0);
    for (const k of POINT_KEYS) j[k] = rotateAround(j[k], pivot, tp, p.tiltRoll);
    j.chestUp = rotateAround(j.chestUp, v(0, 0, 0), tp, p.tiltRoll);
    j.chestRight = rotateAround(j.chestRight, v(0, 0, 0), tp, p.tiltRoll);
    j.headRot = { ...j.headRot, pitch: j.headRot.pitch + tp, roll: j.headRot.roll + p.tiltRoll };
  }
  return j;
}

/** Advances the stride phase from horizontal movement. */
export function advanceWalk(mem: AnimMemory, x: number, z: number, stats: CharacterStats, running: boolean): void {
  const d = Math.hypot(x - mem.lastX, z - mem.lastZ);
  if (d < 2) mem.phase += (d / ((running ? 0.9 : 0.6) * (stats.height / 1.8))) * Math.PI;
  mem.lastX = x;
  mem.lastZ = z;
}
