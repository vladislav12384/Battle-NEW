/**
 * Strike choreography: hand-authored, full-body animation for every kind of
 * strike, driven by the simulation's frame data.
 *
 * Each move is mapped to a timeline `tau`:
 *   0..1  wind-up   (anticipation, coil, chamber, held tension)
 *   1..2  snap      (the last few startup frames: the limb whips along the
 *                    move's hitbox path and lands ON the target exactly on the
 *                    first active frame, when the hit and its freeze happen)
 *   2..3  follow-through and recovery back to guard
 * and a style (straight, hook, uppercut, haymaker, roundhouse...) places
 * hands, feet, hips, shoulders, elbows, knees and head along it. Hooks travel
 * on arcs around the body, uppercuts come up from a dip, kicks pivot on the
 * standing foot and the torso leans away... The fist or foot still passes
 * through the hitbox during the active frames, so what you see is what hits.
 */
import { chestHeight } from '../../core/moves';
import { clamp } from '../../core/math/vec3';
import { RULES } from '../../core/rules';
import type { FighterState } from '../../core/state';
import type { CharacterStats, HitboxDef, LimbId, MoveDef } from '../../core/types';
import { add, type Body, easeIn, easeInOut, easeOut, lerpV, mul, norm, type Pose, sub, v, type V3 } from './anim';

type Ease = (t: number) => number;
const lin: Ease = (t) => t;
type Interp = (a: V3, b: V3, k: number) => V3;
type NKey = readonly [number, number, Ease?];
type PKey = readonly [number, V3, Ease?, Interp?];

/** Piecewise track of numbers; each key's ease shapes the segment that ends on it. */
function tr(keys: readonly NKey[], t: number): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, e] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      return v0 + (v1 - v0) * (e ?? easeInOut)(clamp((t - t0) / Math.max(1e-6, t1 - t0), 0, 1));
    }
  }
  return keys[keys.length - 1][1];
}

/** Piecewise path of points; a key may also say how to travel (straight line or arc). */
function path(keys: readonly PKey[], t: number): V3 {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, p1, e, f] = keys[i];
    if (t <= t1) {
      const [t0, p0] = keys[i - 1];
      return (f ?? lerpV)(p0, p1, (e ?? easeInOut)(clamp((t - t0) / Math.max(1e-6, t1 - t0), 0, 1)));
    }
  }
  return keys[keys.length - 1][1];
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Arc around a vertical axis through `pivot` (hooks, roundhouses, sweeps). */
const arcH =
  (pivot: V3): Interp =>
  (a, b, k) => {
    const ax = a.x - pivot.x;
    const az = a.z - pivot.z;
    const bx = b.x - pivot.x;
    const bz = b.z - pivot.z;
    const a0 = Math.atan2(ax, az);
    const a1 = a0 + wrap(Math.atan2(bx, bz) - a0) * k;
    const r = Math.hypot(ax, az) + (Math.hypot(bx, bz) - Math.hypot(ax, az)) * k;
    return v(pivot.x + Math.sin(a1) * r, a.y + (b.y - a.y) * k, pivot.z + Math.cos(a1) * r);
  };

/** Arc in the body's front-back plane around `pivot` (overhands, rising and chopping kicks). */
const arcV =
  (pivot: V3): Interp =>
  (a, b, k) => {
    const ay = a.y - pivot.y;
    const az = a.z - pivot.z;
    const by = b.y - pivot.y;
    const bz = b.z - pivot.z;
    const a0 = Math.atan2(ay, az);
    const a1 = a0 + wrap(Math.atan2(by, bz) - a0) * k;
    const r = Math.hypot(ay, az) + (Math.hypot(by, bz) - Math.hypot(ay, az)) * k;
    return v(a.x + (b.x - a.x) * k, pivot.y + Math.sin(a1) * r, pivot.z + Math.cos(a1) * r);
  };

const polar = (p: V3, pivot: V3): { a: number; r: number } => ({
  a: Math.atan2(p.x - pivot.x, p.z - pivot.z),
  r: Math.hypot(p.x - pivot.x, p.z - pivot.z),
});
const fromPolar = (a: number, r: number, y: number, pivot: V3): V3 => v(pivot.x + Math.sin(a) * r, y, pivot.z + Math.cos(a) * r);

type Hand = 'lHand' | 'rHand';
type Foot = 'lFoot' | 'rFoot';
type Channel =
  | 'hipX' | 'hipY' | 'hipZ' | 'lean' | 'twist' | 'roll' | 'headPitch' | 'headYaw' | 'headRoll' | 'glow'
  | 'hipTurn' | 'lElbow' | 'rElbow' | 'lKnee' | 'rKnee' | 'lToe' | 'rToe' | 'lHeel' | 'rHeel';

interface Ctx {
  p: Pose;
  /** The guard pose the strike starts from and returns to. */
  g: Pose;
  b: Body;
  m: MoveDef;
  f: FighterState;
  /** +1 = right limb, -1 = left limb. */
  side: number;
  /** Hitbox path of the strike (local, aimed). */
  A: V3;
  B: V3;
  tau: number;
  /** tau at which the limb passes the start of the hitbox path. */
  tauA: number;
  missed: boolean;
  /** Charge ratio 0..1 (held heavies). */
  charge: number;
  /** Seen from inside (local first-person player): no spins, nothing in the eyes. */
  fp: boolean;
  time: number;
}

/** Beat timing of a style (tau of each pose). */
interface Beats {
  coil: number;
  release: number;
  impact: number;
  follow: number;
  home: number;
}
const QUICK: Beats = { coil: 0.7, release: 1, impact: 2, follow: 2.15, home: 2.75 };
const POWER: Beats = { coil: 0.7, release: 1, impact: 2, follow: 2.3, home: 3 };
const HEAVY: Beats = { coil: 0.62, release: 0.98, impact: 2, follow: 2.4, home: 3 };

/** A channel going guard -> coil (held) -> snap -> follow-through -> guard. */
function beat(c: Ctx, rest: number, coil: number, hit: number, over = hit, t: Beats = POWER): number {
  return tr(
    [
      [0, rest],
      [t.coil, coil, easeInOut],
      [t.release, coil, lin],
      [t.impact, hit, easeOut],
      [t.follow, over, easeOut],
      [t.home, rest, easeInOut],
    ],
    c.tau,
  );
}

function set(c: Ctx, ch: Channel, value: number): void {
  c.p[ch] = value;
}

const handOf = (side: number): Hand => (side > 0 ? 'rHand' : 'lHand');
const footOf = (side: number): Foot => (side > 0 ? 'rFoot' : 'lFoot');
const elbowOf = (side: number): 'lElbow' | 'rElbow' => (side > 0 ? 'rElbow' : 'lElbow');
const kneeOf = (side: number): 'lKnee' | 'rKnee' => (side > 0 ? 'rKnee' : 'lKnee');
const toeOf = (side: number): 'lToe' | 'rToe' => (side > 0 ? 'rToe' : 'lToe');
const heelOf = (side: number): 'lHeel' | 'rHeel' => (side > 0 ? 'rHeel' : 'lHeel');

/** The free hand covers the chin. */
const chin = (c: Ctx, side: number): V3 => v(side * 0.05 * c.b.w, 1.48 * c.b.s, 0.3 * c.b.s);

/** The free hand stays home during the wind-up and covers the chin from the snap on, elbow tucked. */
function guardHand(c: Ctx, side: number, t: Beats = POWER): void {
  const h = handOf(side);
  c.p[h] = path([[0, c.g[h]], [t.release, c.g[h]], [t.impact, chin(c, side)], [t.follow + 0.2, chin(c, side)], [t.home, c.g[h]]], c.tau);
  c.p[elbowOf(side)] = beat(c, 0, 0, -0.6, -0.6, t);
}

/** Moves a foot by an offset that peaks at the impact (footwork). */
function step(c: Ctx, foot: Foot, coil: V3, hit: V3, t: Beats = POWER): void {
  const g = c.g[foot];
  c.p[foot] = path([[0, g], [t.coil, add(g, coil)], [t.release, add(g, coil)], [t.impact, add(g, hit), easeOut], [t.follow + 0.15, add(g, hit)], [t.home, g]], c.tau);
}

// ===========================================================================
// Punches

/** Jab / cross / air straights: a whip along the line, the rear one with a full hip turn. */
function straight(c: Ctx): void {
  const { p, g, b, side, A, B } = c;
  const H = handOf(side);
  const rear = side > 0;
  const t = rear ? POWER : QUICK;
  const home = g[H];
  const dir = norm(sub(B, A));
  const load = add(home, v(side * 0.02 * b.w, -0.035 * b.s, -0.08 * b.s));
  p[H] = path(
    [
      [0, home],
      [t.coil, load],
      [1, load, lin],
      [c.tauA, A, easeIn],
      [2, B, easeOut],
      [t.follow, add(B, mul(dir, rear ? 0.08 : 0.05)), easeOut],
      [t.home, home, easeInOut],
    ],
    c.tau,
  );
  guardHand(c, -side, t);
  set(c, 'twist', beat(c, g.twist, rear ? -0.5 : -0.15, rear ? 0.62 : -0.62, rear ? 0.7 : -0.66, t));
  set(c, 'hipTurn', beat(c, 0, rear ? -0.14 : 0.05, rear ? 0.4 : -0.12, rear ? 0.45 : -0.12, t));
  set(c, 'lean', beat(c, g.lean, 0.05, rear ? 0.27 : 0.17, rear ? 0.31 : 0.18, t));
  set(c, 'hipZ', beat(c, 0, -0.03, rear ? 0.13 : 0.08, rear ? 0.15 : 0.08, t));
  set(c, 'hipX', beat(c, 0, rear ? 0.025 : 0, rear ? -0.045 : -0.01, rear ? -0.05 : -0.01, t));
  set(c, 'hipY', beat(c, g.hipY, g.hipY - 0.04, g.hipY - 0.025, g.hipY - 0.03, t));
  set(c, 'roll', beat(c, 0, rear ? 0.05 : 0.02, rear ? -0.08 : 0.05, rear ? -0.1 : 0.05, t));
  set(c, 'headPitch', beat(c, g.headPitch, g.headPitch + 0.05, g.headPitch + 0.12, g.headPitch + 0.12, t));
  set(c, 'headRoll', beat(c, 0, 0, rear ? -0.12 : 0.06, rear ? -0.12 : 0.06, t));
  set(c, elbowOf(side), beat(c, 0, -0.25, -0.4, -0.35, t));
  if (!c.m.air) {
    step(c, 'lFoot', v(0, 0, -0.02), v(0, 0, rear ? 0.08 : 0.13), t);
    set(c, 'rToe', beat(c, g.rToe, g.rToe, rear ? 0 : 0.35, rear ? -0.05 : 0.35, t));
    set(c, 'rHeel', beat(c, g.rHeel, 0.05, rear ? 0.95 : 0.4, rear ? 1 : 0.4, t));
  }
}

/** Hooks: elbow up, the fist travels an arc around the body as the hips and shoulders turn over. */
function hook(c: Ctx, low = false): void {
  const { p, g, b, side, A, B } = c;
  const H = handOf(side);
  const home = g[H];
  const pivot = v(0, (A.y + B.y) / 2, -0.06 * b.s);
  const pa = polar(A, pivot);
  const pb = polar(B, pivot);
  const travel = Math.sign(wrap(pb.a - pa.a)) || -side;
  const chamber = fromPolar(pa.a - travel * 0.5, Math.max(0.4 * b.s, pa.r * 0.72), A.y - 0.03 * b.s, pivot);
  const over = fromPolar(pb.a + travel * 0.55, pb.r * 0.82, B.y - 0.05 * b.s, pivot);
  const arc = arcH(pivot);
  p[H] = path(
    [
      [0, home],
      [0.72, chamber],
      [1, chamber, lin],
      [c.tauA, A, easeIn, arc],
      [2, B, easeOut, arc],
      [2.3, over, easeOut, arc],
      [3, home, easeInOut],
    ],
    c.tau,
  );
  guardHand(c, -side);
  set(c, 'twist', beat(c, g.twist, g.twist - side * 0.32, side * 0.82, side * 0.98));
  set(c, 'hipTurn', beat(c, 0, -side * 0.12, side * 0.38, side * 0.45));
  set(c, 'roll', beat(c, 0, side * (low ? 0.24 : 0.09), side * (low ? 0.14 : -0.06), side * (low ? 0.12 : -0.08)));
  set(c, 'lean', beat(c, g.lean, low ? 0.28 : 0.12, low ? 0.33 : 0.22, low ? 0.34 : 0.24));
  set(c, 'hipY', beat(c, g.hipY, g.hipY - (low ? 0.15 : 0.055), g.hipY - (low ? 0.13 : 0.04), g.hipY - (low ? 0.13 : 0.045)));
  set(c, 'hipX', beat(c, 0, side * 0.035, side * (low ? 0.05 : -0.03), side * (low ? 0.05 : -0.035)));
  set(c, 'hipZ', beat(c, 0, -0.02, 0.12, 0.13));
  set(c, 'headPitch', beat(c, g.headPitch, g.headPitch + 0.06, g.headPitch + 0.1, g.headPitch + 0.1));
  set(c, 'headRoll', beat(c, 0, side * 0.04, side * (low ? 0.14 : 0.06), side * (low ? 0.14 : 0.06)));
  set(c, elbowOf(side), beat(c, 0, 0.55, low ? 0.2 : 1, low ? 0.15 : 0.9));
  if (!c.m.air) {
    // The foot under the punch pivots on its ball, heel turning out.
    set(c, toeOf(side), beat(c, g[toeOf(side)], g[toeOf(side)], -0.55, -0.6));
    set(c, heelOf(side), beat(c, g[heelOf(side)], 0.1, 0.75, 0.8));
    if (low) step(c, 'lFoot', v(-0.04, 0, 0.03), v(-0.06, 0, 0.08));
  }
}

/** Uppercuts: dip and drop the shoulder, then drive up through the legs, elbow tucked. */
function uppercut(c: Ctx, power = false): void {
  const { p, g, b, side, A, B } = c;
  const H = handOf(side);
  const home = g[H];
  const low = v(side * 0.13 * b.w, (power ? 0.9 : 1.02) * b.s, (power ? 0.2 : 0.14) * b.s);
  const over = add(B, v(0, (power ? 0.1 : 0.04) * b.s, -0.04 * b.s));
  const t = power ? HEAVY : POWER;
  p[H] = path([[0, home], [t.coil, low], [1, low, lin], [c.tauA, A, easeIn], [2, B, easeOut], [t.follow, over, easeOut], [t.home, home]], c.tau);
  const off = handOf(-side);
  p[off] = path(
    [[0, g[off]], [1, g[off]], [2, power ? v(-side * 0.18 * b.w, 1.2 * b.s, 0.15 * b.s) : chin(c, -side)], [t.follow + 0.2, power ? v(-side * 0.2 * b.w, 1.15 * b.s, 0.12 * b.s) : chin(c, -side)], [t.home, g[off]]],
    c.tau,
  );
  const dip = power ? 0.2 : 0.11;
  set(c, 'hipY', beat(c, g.hipY, g.hipY - dip, g.hipY + (power ? 0.07 : 0.02), g.hipY + (power ? 0.09 : 0.03), t));
  set(c, 'roll', beat(c, 0, side * (power ? 0.2 : 0.15), -side * 0.05, -side * 0.07, t));
  set(c, 'twist', beat(c, g.twist, g.twist - side * 0.2, side * 0.45, side * 0.5, t));
  set(c, 'hipTurn', beat(c, 0, -side * 0.1, side * 0.3, side * 0.35, t));
  set(c, 'lean', beat(c, g.lean, power ? 0.34 : 0.22, power ? -0.16 : 0.02, power ? -0.22 : -0.02, t));
  set(c, 'hipZ', beat(c, 0, -0.02, power ? 0.06 : 0.09, power ? 0.06 : 0.1, t));
  set(c, 'headPitch', beat(c, g.headPitch, g.headPitch + 0.14, g.headPitch - (power ? 0.32 : 0.12), g.headPitch - (power ? 0.36 : 0.14), t));
  set(c, elbowOf(side), beat(c, 0, -0.85, -1, -1, t));
  if (!c.m.air) {
    const heel = power ? 1 : 0.6;
    set(c, 'lHeel', beat(c, g.lHeel, 0, heel, heel, t));
    set(c, 'rHeel', beat(c, g.rHeel, 0, heel, heel, t));
    set(c, toeOf(side), beat(c, g[toeOf(side)], g[toeOf(side)], 0, 0, t));
  }
  if (power) set(c, 'glow', tr([[0, 0], [1.2, 0], [1.8, 0.45], [2.6, 0.2], [3, 0]], c.tau));
}

/** Haymaker: big coil (fist cocked behind the head, lead hand measuring), overhand arc, crash-through follow. */
function haymaker(c: Ctx): void {
  const { p, g, b, side, A, B } = c;
  const H = handOf(side);
  const O = handOf(-side);
  const home = g[H];
  const shoulder = v(side * 0.19 * b.w, 1.45 * b.s, 0);
  const cock = v(side * 0.42 * b.w, 1.56 * b.s, -0.36 * b.s);
  const through = v(-side * 0.22 * b.w, 1.02 * b.s, 0.55 * b.s);
  const t = HEAVY;
  // Held charge: tension builds, the fist trembles.
  const shake = c.charge > 0 ? Math.sin(c.time * 55) * 0.012 * c.charge : 0;
  p[H] = path(
    [
      [0, home],
      [t.coil, cock],
      [t.release, add(cock, v(0.02 * side, 0.01, -0.03))],
      [c.tauA, A, easeIn, arcV(shoulder)],
      [2, B, easeOut],
      [t.follow, through, easeOut, arcV(v(0, 1.4 * b.s, 0.3 * b.s))],
      [t.home, home, easeInOut],
    ],
    c.tau,
  );
  p[H] = add(p[H], v(shake, shake * 0.6, 0));
  p[O] = path(
    [
      [0, g[O]],
      [t.coil, v(-side * 0.1 * b.w, 1.46 * b.s, 0.56 * b.s)], // lead hand reaches out, measuring
      [t.release, v(-side * 0.1 * b.w, 1.46 * b.s, 0.56 * b.s)],
      [2, v(-side * 0.15 * b.w, 1.32 * b.s, 0.12 * b.s), easeOut], // yanked back to drive the turn
      [t.follow + 0.2, v(-side * 0.15 * b.w, 1.35 * b.s, 0.14 * b.s)],
      [t.home, g[O]],
    ],
    c.tau,
  );
  set(c, 'twist', beat(c, g.twist, -side * 0.98, side * 0.88, side * 1.08, t));
  set(c, 'hipTurn', beat(c, 0, -side * 0.32, side * 0.48, side * 0.55, t));
  set(c, 'lean', beat(c, g.lean, -0.13, 0.38, 0.52, t));
  set(c, 'roll', beat(c, 0, side * 0.13, -side * 0.15, -side * 0.22, t));
  set(c, 'hipZ', beat(c, 0, -0.1, 0.18, 0.24, t));
  set(c, 'hipX', beat(c, 0, side * 0.05, -side * 0.06, -side * 0.07, t));
  set(c, 'hipY', beat(c, g.hipY, g.hipY - 0.07, g.hipY - 0.05, g.hipY - 0.1, t));
  set(c, 'headPitch', beat(c, g.headPitch, g.headPitch + 0.12, g.headPitch + 0.15, g.headPitch + 0.2, t));
  set(c, elbowOf(side), tr([[0, 0], [t.coil, 2], [t.release, 2], [1.5, 1], [2, 0.3], [3, 0]], c.tau));
  set(c, 'glow', Math.max(c.p.glow, c.charge * 0.9));
  if (!c.m.air) {
    step(c, 'lFoot', v(0, 0, 0.04), v(0, 0, 0.24), t);
    set(c, 'rToe', beat(c, g.rToe, g.rToe + 0.2, -0.1, -0.15, t));
    set(c, 'rHeel', beat(c, g.rHeel, 0, 1, 1, t));
  }
}

/** Spinning backfist: step through, turn the back, the arm whips all the way around. */
function spinBackfist(c: Ctx): void {
  const { p, g, b, side, A, B } = c;
  const H = handOf(side);
  const home = g[H];
  if (c.fp) {
    // From the inside: a cross-body backhand (no spin, the camera stays yours).
    const pivot = v(0, 1.45 * b.s, -0.05 * b.s);
    const cocked = v(-side * 0.25 * b.w, 1.45 * b.s, 0.14 * b.s);
    const out = v(side * 0.78 * b.w, 1.45 * b.s, 0.32 * b.s);
    p[H] = path([[0, home], [0.75, cocked], [1, cocked, lin], [2, B, easeOut, arcH(pivot)], [2.3, out, easeOut, arcH(pivot)], [3, home]], c.tau);
    guardHand(c, -side);
    set(c, 'twist', beat(c, g.twist, -side * 0.6, side * 0.55, side * 0.7));
    set(c, elbowOf(side), beat(c, 0, 1, 0.6, 0.4));
    return;
  }
  const out = v(side * 0.7 * b.w, 1.5 * b.s, 0.18 * b.s);
  const aOut = Math.atan2(out.x, out.z);
  const pa = Math.atan2(A.x, A.z);
  const pb = Math.atan2(B.x, B.z);
  const dir = Math.sign(wrap(pb - pa)) || -side;
  // Spin angles that put the extended hand on the hitbox at the first and last active frames.
  const toward = (target: number, min: number): number => {
    let s = wrap(target - aOut);
    while (dir * s < min) s += dir * Math.PI * 2;
    return s;
  };
  const sA = toward(pa, 2.2);
  const sB = toward(pb, Math.abs(sA) + 0.3);
  const full = dir * Math.PI * 2;
  p.spin = tr([[0, 0], [0.25, -dir * 0.12], [1, sA * 0.88, easeIn], [c.tauA, sA, lin], [2, sB, lin], [2.4, full, easeOut], [3, full]], c.tau);
  p[H] = path([[0, home], [0.6, v(side * 0.12 * b.w, 1.42 * b.s, 0.16 * b.s)], [c.tauA, out, easeOut], [2, out], [2.4, add(out, v(-side * 0.08, -0.04, -0.06))], [2.85, home], [3, home]], c.tau);
  guardHand(c, -side);
  set(c, elbowOf(side), beat(c, 0, 0.3, 0.9, 0.7));
  set(c, 'roll', beat(c, 0, 0, side * 0.12, side * 0.12));
  set(c, 'lean', beat(c, g.lean, 0.14, 0.06, 0.08));
  set(c, 'hipY', beat(c, g.hipY, g.hipY - 0.06, g.hipY - 0.02, g.hipY - 0.04));
  set(c, 'headYaw', tr([[0, 0], [0.5, 0], [0.95, dir * 0.7], [c.tauA, dir * 0.3], [2, 0], [3, 0]], c.tau));
}

/** Two-handed hammer: rise up with the hands clasped high, then crash down through the knees. */
function hammer(c: Ctx): void {
  const { p, g, b, side, A, B } = c;
  const H = handOf(side);
  const O = handOf(-side);
  const t = HEAVY;
  const up = v(side * 0.06 * b.w, 1.88 * b.s, -0.24 * b.s);
  const down = v(0, 0.62 * b.s, 0.58 * b.s);
  const shoulder = v(0, 1.45 * b.s, 0.05 * b.s);
  p[H] = path([[0, g[H]], [t.coil, up], [t.release, add(up, v(0, 0.02, -0.03))], [c.tauA, A, easeIn, arcV(shoulder)], [2, B, easeOut, arcV(shoulder)], [t.follow, down, easeOut], [t.home, g[H]]], c.tau);
  // The other hand is clasped over the striking fist.
  const clasp = add(p[H], v(-side * 0.11 * b.w, 0.02 * b.s, -0.02 * b.s));
  const k = tr([[0, 0], [0.4, 1], [2.5, 1], [3, 0]], c.tau);
  p[O] = lerpV(g[O], clasp, k);
  set(c, 'lean', beat(c, g.lean, -0.2, 0.5, 0.58, t));
  set(c, 'hipY', beat(c, g.hipY, g.hipY + 0.04, g.hipY - 0.14, g.hipY - 0.17, t));
  set(c, 'hipZ', beat(c, 0, -0.04, 0.1, 0.12, t));
  set(c, 'headPitch', beat(c, g.headPitch, g.headPitch - 0.2, g.headPitch + 0.32, g.headPitch + 0.35, t));
  set(c, 'twist', beat(c, g.twist, g.twist * 0.4, 0, 0, t));
  set(c, 'lElbow', beat(c, 0, 1.6, 0.4, 0.2, t));
  set(c, 'rElbow', beat(c, 0, 1.6, 0.4, 0.2, t));
  if (!c.m.air) {
    set(c, 'lHeel', beat(c, g.lHeel, 0.8, 0, 0, t));
    set(c, 'rHeel', beat(c, g.rHeel, 0.8, 0, 0, t));
    step(c, 'lFoot', v(0, 0, -0.02), v(-0.04, 0, 0.12), t);
  }
}

/** Running straight: sprinting lean, fist cocked at the hip, a full-length superman extension. */
function dashStraight(c: Ctx): void {
  const { p, g, b, side, A, B } = c;
  const H = handOf(side);
  const O = handOf(-side);
  const hip = v(side * 0.22 * b.w, 1.22 * b.s, -0.15 * b.s);
  const t = HEAVY;
  p[H] = path([[0, g[H]], [t.coil, hip], [1, hip, lin], [c.tauA, A, easeIn], [2, B, easeOut], [t.follow, add(B, v(0, -0.02, 0.06))], [t.home, g[H]]], c.tau);
  p[O] = path([[0, g[O]], [t.coil, v(-side * 0.12 * b.w, 1.45 * b.s, 0.4 * b.s)], [2, v(-side * 0.18 * b.w, 1.3 * b.s, 0.05)], [t.follow + 0.2, v(-side * 0.18 * b.w, 1.3 * b.s, 0.05)], [t.home, g[O]]], c.tau);
  set(c, 'lean', beat(c, g.lean, 0.38, 0.42, 0.46, t));
  set(c, 'twist', beat(c, g.twist, -side * 0.7, side * 0.9, side * 0.95, t));
  set(c, 'hipTurn', beat(c, 0, -side * 0.2, side * 0.4, side * 0.4, t));
  set(c, 'hipY', beat(c, g.hipY, g.hipY - 0.05, g.hipY - 0.1, g.hipY - 0.1, t));
  set(c, 'hipZ', beat(c, 0, 0.05, 0.16, 0.18, t));
  set(c, 'headPitch', beat(c, g.headPitch, g.headPitch + 0.1, g.headPitch + 0.08, g.headPitch + 0.08, t));
  set(c, elbowOf(side), beat(c, 0, 0.6, -0.3, -0.3, t));
  if (!c.m.air) {
    // Running stride during the dash, then lead foot planted and rear leg stretched behind.
    const stride = Math.sin(c.time * 16) * 0.22 * b.s * tr([[0, 0], [0.3, 1], [0.95, 1], [1.2, 0]], c.tau);
    const plant = tr([[0, 0], [1, 0], [2, 1], [2.6, 1], [3, 0]], c.tau);
    p.lFoot = add(lerpV(g.lFoot, v(-0.15 * b.w, 0, 0.36 * b.s), plant), v(0, Math.max(0, stride) * 0.4, stride));
    p.rFoot = add(lerpV(g.rFoot, v(0.15 * b.w, 0.18 * b.s, -0.55 * b.s), plant), v(0, Math.max(0, -stride) * 0.4, -stride));
    set(c, 'rHeel', 1 * plant);
  }
}

// ===========================================================================
// Kicks

/** Push kick: knee chambers to the chest, the hips thrust the sole out, torso leans back. */
function teep(c: Ctx): void {
  const { p, g, b, side, A, B } = c;
  const F = footOf(side);
  const S = footOf(-side);
  const chamber = v(side * 0.1 * b.w, 0.62 * b.s, 0.2 * b.s);
  p[F] = path([[0, g[F]], [0.75, chamber], [1, chamber, lin], [c.tauA, A, easeIn], [2, B, easeOut], [2.25, add(B, v(0, 0, 0.03))], [2.55, add(chamber, v(0, -0.05, 0.05))], [3, g[F]]], c.tau);
  p[S] = path([[0, g[S]], [0.6, v(-side * 0.1 * b.w, 0, 0.02)], [2.6, v(-side * 0.1 * b.w, 0, 0.02)], [3, g[S]]], c.tau);
  set(c, kneeOf(side), beat(c, 0, -0.1, 0, 0));
  set(c, 'lean', beat(c, g.lean, -0.1, -0.3, -0.32));
  set(c, 'hipZ', beat(c, 0, 0, 0.12, 0.14));
  set(c, 'hipY', beat(c, g.hipY, g.hipY + 0.02, g.hipY + 0.02, g.hipY + 0.02));
  set(c, 'hipTurn', beat(c, 0, side * 0.05, side * 0.18, side * 0.2));
  set(c, 'headPitch', beat(c, g.headPitch, g.headPitch + 0.05, g.headPitch + 0.2, g.headPitch + 0.2));
  set(c, heelOf(-side), beat(c, 0, 0, 0.35, 0.35));
  p.lHand = path([[0, g.lHand], [1, add(g.lHand, v(0, 0.03, -0.04))], [2, v(-0.16 * b.w, 1.5 * b.s, 0.24 * b.s)], [2.5, v(-0.16 * b.w, 1.5 * b.s, 0.24 * b.s)], [3, g.lHand]], c.tau);
  p.rHand = path([[0, g.rHand], [1, add(g.rHand, v(0, 0.03, -0.02))], [2, v(0.18 * b.w, 1.48 * b.s, 0.18 * b.s)], [2.5, v(0.18 * b.w, 1.48 * b.s, 0.18 * b.s)], [3, g.rHand]], c.tau);
}

/**
 * Roundhouse: step out and pivot on the standing foot (heel to the target),
 * chamber the knee to the side, turn the hip over and whip the shin around;
 * the torso leans away and the arm on the kicking side swings back.
 */
function roundhouse(c: Ctx): void {
  const { p, g, b, side, A, B } = c;
  const F = footOf(side);
  const S = footOf(-side);
  const hip = v(side * 0.1 * b.w, (A.y + B.y) / 2, 0);
  const chamber = v(side * 0.46 * b.w, 0.82 * b.s, -0.06 * b.s);
  const pa = polar(A, hip);
  const pb = polar(B, hip);
  const travel = Math.sign(wrap(pb.a - pa.a)) || -side;
  const over = fromPolar(pb.a + travel * 0.6, pb.r * 0.9, B.y - 0.1 * b.s, hip);
  const arc = arcH(hip);
  p[F] = path(
    [
      [0, g[F]],
      [0.35, add(g[F], v(0, 0.15 * b.s, 0.05 * b.s))],
      [0.85, chamber],
      [1, chamber, lin],
      [c.tauA, A, easeIn, arc],
      [2, B, easeOut, arc],
      [2.3, over, easeOut, arc],
      [2.65, v(side * 0.12 * b.w, 0.45 * b.s, 0.18 * b.s), easeInOut],
      [3, g[F]],
    ],
    c.tau,
  );
  // Standing foot: steps out at 45 degrees and pivots so the heel faces the target.
  const plant = v(-side * 0.14 * b.w, 0, 0.16 * b.s);
  p[S] = path([[0, g[S]], [0.4, plant], [2.7, plant], [3, g[S]]], c.tau);
  set(c, toeOf(-side), tr([[0, g[toeOf(-side)]], [0.45, 0.6], [1.6, 1.5], [2.5, 1.6], [3, g[toeOf(-side)]]], c.tau));
  set(c, heelOf(-side), beat(c, g[heelOf(-side)], 0.2, 0.7, 0.7));
  set(c, kneeOf(side), tr([[0, 0], [0.85, 0.9], [c.tauA, 0.4], [2, -0.9], [2.4, -0.9], [3, 0]], c.tau));
  set(c, 'hipTurn', beat(c, 0, -side * 0.2, side * 1.05, side * 1.3));
  set(c, 'twist', beat(c, g.twist, g.twist - side * 0.15, side * 0.35, side * 0.5));
  set(c, 'lean', beat(c, g.lean, -0.12, -0.36, -0.4));
  set(c, 'roll', beat(c, 0, -side * 0.12, -side * 0.42, -side * 0.45));
  set(c, 'hipY', beat(c, g.hipY, g.hipY - 0.03, g.hipY + 0.03, g.hipY + 0.02));
  set(c, 'hipX', beat(c, 0, -side * 0.06, -side * 0.08, -side * 0.08));
  set(c, 'headRoll', beat(c, 0, side * 0.1, side * 0.3, side * 0.32));
  set(c, 'headPitch', beat(c, g.headPitch, g.headPitch + 0.05, g.headPitch + 0.15, g.headPitch + 0.15));
  // Arms: the kicking side swings down and back (counterweight), the other covers the face.
  const H = handOf(side);
  const O = handOf(-side);
  p[H] = path([[0, g[H]], [0.85, add(g[H], v(side * 0.05, -0.05, -0.05))], [2, v(side * 0.46 * b.w, 0.98 * b.s, -0.3 * b.s), easeOut], [2.4, v(side * 0.48 * b.w, 1.0 * b.s, -0.32 * b.s)], [3, g[H]]], c.tau);
  p[O] = path([[0, g[O]], [1, g[O]], [2, v(-side * 0.02 * b.w, 1.56 * b.s, 0.24 * b.s)], [2.5, v(-side * 0.02 * b.w, 1.56 * b.s, 0.24 * b.s)], [3, g[O]]], c.tau);
}

/** Rising kick: the straight leg swings up like a pendulum, torso leaning back, arms swinging down. */
function riseKick(c: Ctx): void {
  const { p, g, b, side, A, B } = c;
  const F = footOf(side);
  const S = footOf(-side);
  const hip = v(side * 0.1 * b.w, b.hipY, 0);
  const load = v(side * 0.15 * b.w, 0.06 * b.s, -0.22 * b.s);
  const top = add(B, v(0, 0.12 * b.s, -0.22 * b.s));
  const arc = arcV(hip);
  p[F] = path([[0, g[F]], [0.75, load], [1, load, lin], [c.tauA, A, easeIn, arc], [2, B, easeOut, arc], [2.3, top, easeOut, arc], [2.75, v(side * 0.15 * b.w, 0.3 * b.s, 0.25 * b.s), easeInOut, arc], [3, g[F]]], c.tau);
  p[S] = path([[0, g[S]], [0.5, v(-side * 0.1 * b.w, 0, 0.05)], [2.7, v(-side * 0.1 * b.w, 0, 0.05)], [3, g[S]]], c.tau);
  set(c, heelOf(-side), beat(c, 0, 0, 0.85, 0.9));
  set(c, 'lean', beat(c, g.lean, 0.12, -0.42, -0.48));
  set(c, 'hipY', beat(c, g.hipY, g.hipY - 0.05, g.hipY + 0.05, g.hipY + 0.06));
  set(c, 'headPitch', beat(c, g.headPitch, g.headPitch + 0.1, g.headPitch - 0.25, g.headPitch - 0.3));
  set(c, 'hipTurn', beat(c, 0, 0, side * 0.15, side * 0.15));
  p.lHand = path([[0, g.lHand], [0.75, add(g.lHand, v(0, 0.05, 0.05))], [2, v(-0.32 * b.w, 1.05 * b.s, -0.05 * b.s)], [2.4, v(-0.34 * b.w, 1.0 * b.s, -0.1 * b.s)], [3, g.lHand]], c.tau);
  p.rHand = path([[0, g.rHand], [0.75, add(g.rHand, v(0, 0.05, 0.05))], [2, v(0.32 * b.w, 1.05 * b.s, -0.05 * b.s)], [2.4, v(0.34 * b.w, 1.0 * b.s, -0.1 * b.s)], [3, g.rHand]], c.tau);
}

/** Axe kick: chamber, lift the straight leg over the head on an outside circle, chop the heel down. */
function axeKick(c: Ctx): void {
  const { p, g, b, side, A, B } = c;
  const F = footOf(side);
  const S = footOf(-side);
  const hip = v(side * 0.1 * b.w, b.hipY, 0);
  const knee = v(side * 0.15 * b.w, 0.75 * b.s, 0.15 * b.s);
  const outside = v(side * 0.5 * b.w, 1.55 * b.s, 0.32 * b.s);
  const landed = v(side * 0.06 * b.w, 0.02, 0.62 * b.s);
  const arc = arcV(hip);
  p[F] = path([[0, g[F]], [0.4, knee], [0.75, outside], [1, A, easeOut], [c.tauA, A, lin], [2, B, easeIn, arc], [2.3, landed, easeOut], [2.75, landed], [3, g[F]]], c.tau);
  p[S] = path([[0, g[S]], [0.4, v(-side * 0.1 * b.w, 0, 0.02)], [2.3, v(-side * 0.1 * b.w, 0, 0.02)], [3, g[S]]], c.tau);
  set(c, kneeOf(side), tr([[0, 0], [0.4, 0], [0.75, 0.7], [1, 0.2], [3, 0]], c.tau));
  set(c, heelOf(-side), tr([[0, 0], [0.75, 0.9], [1.3, 0.9], [2, 0], [3, 0]], c.tau));
  set(c, 'lean', tr([[0, g.lean], [0.75, -0.2], [1, -0.4], [c.tauA, -0.4], [2, 0.32, easeIn], [2.4, 0.38], [3, g.lean]], c.tau));
  set(c, 'hipY', tr([[0, g.hipY], [1, g.hipY + 0.05], [c.tauA, g.hipY + 0.05], [2, g.hipY - 0.08, easeIn], [2.4, g.hipY - 0.1], [3, g.hipY]], c.tau));
  set(c, 'headPitch', tr([[0, g.headPitch], [1, g.headPitch - 0.2], [2, g.headPitch + 0.3], [3, g.headPitch]], c.tau));
  const armsUp = (sd: number): V3 => v(sd * 0.36 * b.w, 1.72 * b.s, 0.1 * b.s);
  const armsDown = (sd: number): V3 => v(sd * 0.25 * b.w, 1.12 * b.s, 0.22 * b.s);
  p.lHand = path([[0, g.lHand], [1, armsUp(-1)], [c.tauA, armsUp(-1)], [2, armsDown(-1), easeIn], [2.5, armsDown(-1)], [3, g.lHand]], c.tau);
  p.rHand = path([[0, g.rHand], [1, armsUp(1)], [c.tauA, armsUp(1)], [2, armsDown(1), easeIn], [2.5, armsDown(1)], [3, g.rHand]], c.tau);
}

/** Low sweep: drop onto the standing leg with a hand on the floor, the extended leg scythes around. */
function sweep(c: Ctx): void {
  const { p, g, b, side, A, B } = c;
  const F = footOf(side);
  const S = footOf(-side);
  const hip = v(0, 0.12, 0.05);
  const pa = polar(A, hip);
  const pb = polar(B, hip);
  const travel = Math.sign(wrap(pb.a - pa.a)) || -side;
  const wide = fromPolar(pa.a - travel * 0.35, pa.r * 1.05, 0.1, hip);
  const over = fromPolar(pb.a + travel * 0.7, pb.r, 0.12, hip);
  const arc = arcH(hip);
  p[F] = path([[0, g[F]], [0.85, wide], [1, wide, lin], [c.tauA, A, easeIn, arc], [2, B, easeOut, arc], [2.3, over, easeOut, arc], [2.75, v(side * 0.2 * b.w, 0, 0.1 * b.s)], [3, g[F]]], c.tau);
  p[S] = path([[0, g[S]], [0.6, v(-side * 0.15 * b.w, 0, 0.12 * b.s)], [2.7, v(-side * 0.15 * b.w, 0, 0.12 * b.s)], [3, g[S]]], c.tau);
  set(c, 'hipY', beat(c, g.hipY, g.hipY - 0.42, g.hipY - 0.44, g.hipY - 0.42));
  set(c, 'lean', beat(c, g.lean, 0.42, 0.36, 0.34));
  set(c, 'twist', beat(c, g.twist, -side * 0.35, side * 0.55, side * 0.7));
  set(c, 'hipTurn', beat(c, 0, -side * 0.3, side * 0.85, side * 1.1));
  set(c, 'roll', beat(c, 0, -side * 0.12, -side * 0.08, -side * 0.06));
  set(c, kneeOf(-side), beat(c, 0, 0.6, 0.6, 0.6));
  set(c, 'headPitch', beat(c, g.headPitch, g.headPitch - 0.15, g.headPitch - 0.15, g.headPitch - 0.15));
  const floor = v(-side * 0.22 * b.w, 0.5 * b.s, 0.38 * b.s);
  p[handOf(-side)] = path([[0, g[handOf(-side)]], [0.85, floor], [2.6, floor], [3, g[handOf(-side)]]], c.tau);
  p[handOf(side)] = path([[0, g[handOf(side)]], [0.85, v(side * 0.25 * b.w, 0.85 * b.s, 0.25 * b.s)], [2.6, v(side * 0.1 * b.w, 0.95 * b.s, 0.3 * b.s)], [3, g[handOf(side)]]], c.tau);
}

/** Stomp: knee up high, arms out for balance, stamp straight down. */
function stomp(c: Ctx): void {
  const { p, g, b, side, A, B } = c;
  const F = footOf(side);
  p[F] = path([[0, g[F]], [0.85, A], [1, A, lin], [2, B, easeIn], [2.6, B], [3, g[F]]], c.tau);
  set(c, kneeOf(side), beat(c, 0, 0.1, 0, 0));
  set(c, 'hipY', beat(c, g.hipY, g.hipY + 0.03, g.hipY - 0.1, g.hipY - 0.12));
  set(c, 'lean', beat(c, g.lean, -0.12, 0.3, 0.32));
  set(c, 'headPitch', beat(c, g.headPitch, g.headPitch + 0.15, g.headPitch + 0.4, g.headPitch + 0.4));
  p.lHand = path([[0, g.lHand], [0.85, v(-0.36 * b.w, 1.38 * b.s, 0.12 * b.s)], [2, v(-0.22 * b.w, 1.25 * b.s, 0.25 * b.s)], [3, g.lHand]], c.tau);
  p.rHand = path([[0, g.rHand], [0.85, v(0.36 * b.w, 1.38 * b.s, 0.12 * b.s)], [2, v(0.22 * b.w, 1.25 * b.s, 0.25 * b.s)], [3, g.rHand]], c.tau);
}

/** Flying knee: reach to clinch, drive the knee up through the target while yanking the head down. */
function knee(c: Ctx): void {
  const { p, g, b, side } = c;
  const F = footOf(side);
  const S = footOf(-side);
  const tuck = v(side * 0.1 * b.w, 0.74 * b.s, 0.2 * b.s);
  p[F] = path([[0, g[F]], [0.6, add(g[F], v(0, 0.05, -0.15))], [1, add(tuck, v(0, -0.15, -0.1))], [2, tuck, easeOut], [2.4, tuck], [3, g[F]]], c.tau);
  p[S] = path([[0, g[S]], [1, v(-side * 0.1 * b.w, 0.1 * b.s, -0.1 * b.s)], [2, v(-side * 0.12 * b.w, 0.12 * b.s, -0.3 * b.s)], [2.5, v(-side * 0.12 * b.w, 0.05, -0.2 * b.s)], [3, g[S]]], c.tau);
  set(c, kneeOf(side), beat(c, 0, 0, -0.2, -0.2));
  set(c, 'hipY', beat(c, g.hipY, g.hipY - 0.06, g.hipY + 0.1, g.hipY + 0.1));
  set(c, 'lean', beat(c, g.lean, 0.28, -0.16, -0.18));
  set(c, 'headPitch', beat(c, g.headPitch, g.headPitch + 0.1, g.headPitch + 0.15, g.headPitch + 0.15));
  const reach = (sd: number): V3 => v(sd * 0.15 * b.w, 1.5 * b.s, 0.48 * b.s);
  const pull = (sd: number): V3 => v(sd * 0.12 * b.w, 1.22 * b.s, 0.34 * b.s);
  p.lHand = path([[0, g.lHand], [1, reach(-1)], [2, pull(-1), easeOut], [2.5, pull(-1)], [3, g.lHand]], c.tau);
  p.rHand = path([[0, g.rHand], [1, reach(1)], [2, pull(1), easeOut], [2.5, pull(1)], [3, g.rHand]], c.tau);
}

/** Dive kick: lean back, one leg spearing down-forward, the other tucked. */
function diveKick(c: Ctx): void {
  const { p, g, b, side, A } = c;
  const F = footOf(side);
  const S = footOf(-side);
  const spear = v(side * 0.05 * b.w, A.y - 0.05, A.z + 0.05);
  p[F] = path([[0, g[F]], [1, v(side * 0.1 * b.w, 0.6 * b.s, 0.1 * b.s)], [1.3, spear, easeOut], [2.5, spear], [3, g[F]]], c.tau);
  p[S] = path([[0, g[S]], [1, v(-side * 0.1 * b.w, 0.75 * b.s, 0.05)], [3, v(-side * 0.1 * b.w, 0.7 * b.s, 0.05)]], c.tau);
  set(c, 'lean', beat(c, g.lean, -0.1, -0.38, -0.38));
  set(c, kneeOf(-side), 0.3);
  p.lHand = path([[0, g.lHand], [1.3, v(-0.3 * b.w, 1.65 * b.s, -0.05)], [3, g.lHand]], c.tau);
  p.rHand = path([[0, g.rHand], [1.3, v(0.3 * b.w, 1.65 * b.s, -0.05)], [3, g.rHand]], c.tau);
}

// ===========================================================================
// Specials

/** Ki blast: cup both hands at the hip and gather energy, then thrust both palms out. */
function blast(c: Ctx): void {
  const { p, g, b } = c;
  const t = HEAVY;
  const cupR = v(0.24 * b.w, 1.1 * b.s, -0.06 * b.s);
  const cupL = v(0.15 * b.w, 1.13 * b.s, -0.02 * b.s);
  const outR = v(0.05 * b.w, 1.4 * b.s, 0.62 * b.s);
  const outL = v(-0.06 * b.w, 1.43 * b.s, 0.6 * b.s);
  p.rHand = path([[0, g.rHand], [t.coil, cupR], [1, add(cupR, v(0.01, 0, -0.02)), lin], [2, outR, easeOut], [2.45, outR], [3, g.rHand]], c.tau);
  p.lHand = path([[0, g.lHand], [t.coil, cupL], [1, add(cupL, v(0.01, 0, -0.02)), lin], [2, outL, easeOut], [2.45, outL], [3, g.lHand]], c.tau);
  set(c, 'twist', beat(c, g.twist, -0.7, 0.12, 0.12, t));
  set(c, 'lean', beat(c, g.lean, -0.06, 0.2, 0.2, t));
  set(c, 'hipY', beat(c, g.hipY, g.hipY - 0.08, g.hipY - 0.06, g.hipY - 0.06, t));
  set(c, 'hipZ', beat(c, 0, -0.04, 0.08, 0.08, t));
  set(c, 'rElbow', beat(c, 0, 0.3, -0.2, -0.2, t));
  set(c, 'lElbow', beat(c, 0, -0.5, -0.2, -0.2, t));
  set(c, 'glow', tr([[0, 0], [0.9, 0.85], [1.4, 1], [2.2, 0.3], [3, 0]], c.tau));
  if (!c.m.air) {
    step(c, 'lFoot', v(0, 0, -0.02), v(-0.03, 0, 0.12), t);
    set(c, 'rHeel', beat(c, c.g.rHeel, 0.1, 0.8, 0.8, t));
  }
}

/** Shoulder rush: crouched charge, lead shoulder first, chin tucked. */
function shoulder(c: Ctx): void {
  const { p, g, b } = c;
  const t = POWER;
  p.lHand = path([[0, g.lHand], [0.7, v(-0.08 * b.w, 1.32 * b.s, 0.22 * b.s)], [3, v(-0.08 * b.w, 1.32 * b.s, 0.22 * b.s)]], c.tau);
  p.rHand = path([[0, g.rHand], [0.7, v(0.12 * b.w, 1.45 * b.s, 0.12 * b.s)], [3, v(0.12 * b.w, 1.45 * b.s, 0.12 * b.s)]], c.tau);
  set(c, 'lean', beat(c, g.lean, 0.3, 0.48, 0.48, t));
  set(c, 'twist', beat(c, g.twist, -0.65, -0.95, -0.95, t));
  set(c, 'hipY', beat(c, g.hipY, g.hipY - 0.12, g.hipY - 0.1, g.hipY - 0.1, t));
  set(c, 'headPitch', beat(c, g.headPitch, g.headPitch + 0.2, g.headPitch + 0.28, g.headPitch + 0.28, t));
  if (!c.m.air) {
    const stride = Math.sin(c.time * 18) * 0.2 * b.s * tr([[0, 0], [1, 0.3], [1.2, 1], [2.4, 1], [2.8, 0]], c.tau);
    p.lFoot = add(c.g.lFoot, v(0, Math.max(0, stride) * 0.45, stride));
    p.rFoot = add(c.g.rFoot, v(0, Math.max(0, -stride) * 0.45, -stride));
  }
  set(c, 'glow', tr([[0, 0], [1, 0.3], [2, 0.3], [3, 0]], c.tau));
}

/** Rising dragon: explosive corkscrew uppercut straight up into the sky. */
function dragon(c: Ctx): void {
  uppercut(c, true);
  const { p, b, side } = c;
  // Fist stays up through the second hit while the body corkscrews.
  if (c.tau > 2 && c.tau < 2.7) p[handOf(side)] = v(side * 0.08 * b.w, 2.12 * b.s, 0.4 * b.s);
  if (!c.fp) p.spin = tr([[0, 0], [1, 0], [2.6, side * Math.PI * 2, easeOut], [3, side * Math.PI * 2]], c.tau);
  if (c.f.grounded === false) {
    p.lFoot = v(-0.12 * b.w, 0.35 * b.s, 0.1 * b.s);
    p.rFoot = v(0.12 * b.w, 0.2 * b.s, -0.05 * b.s);
  }
  set(c, 'glow', tr([[0, 0], [1, 0.4], [1.5, 1], [2.6, 0.6], [3, 0]], c.tau));
}

// ===========================================================================
// Dispatch

type Style = (c: Ctx) => void;

const STYLES: Record<string, Style> = {
  straight,
  hook: (c) => hook(c),
  bodyHook: (c) => hook(c, true),
  uppercut: (c) => uppercut(c),
  launcher: (c) => uppercut(c, true),
  haymaker,
  spinBackfist,
  hammer,
  dashStraight,
  teep,
  roundhouse,
  riseKick,
  axeKick,
  sweep,
  stomp,
  knee,
  diveKick,
  blast,
  shoulder,
  dragon,
};

/** Style of a move: its own `anim` hint, or one derived from the limb and the strike's trajectory. */
export function styleOf(m: MoveDef, limb: LimbId | null, line: string): string | null {
  if (m.anim) return m.anim;
  if (m.kind === 'throw' || m.kind === 'super') return null;
  if (!limb) return m.projectiles?.length ? 'blast' : null;
  if (limb === 'body') return 'shoulder';
  const foot = limb === 'lFoot' || limb === 'rFoot';
  switch (line) {
    case 'fromLeft':
    case 'fromRight':
      return foot ? 'roundhouse' : 'hook';
    case 'rising':
      return foot ? 'riseKick' : 'uppercut';
    case 'overhead':
      return foot ? 'axeKick' : 'hammer';
    case 'low':
      return foot ? 'sweep' : 'hook';
    default:
      return foot ? 'teep' : 'straight';
  }
}

/** Aimed local copy of a hitbox point (mirrors core/moves.aimedPoint). */
function aimed(p: readonly [number, number, number], pitch: number, pivot: number): V3 {
  if (pitch === 0) return v(p[0], p[1], p[2]);
  const ry = p[1] - pivot;
  const cs = Math.cos(pitch);
  const sn = Math.sin(pitch);
  return v(p[0], ry * cs + p[2] * sn + pivot, p[2] * cs - ry * sn);
}

const STIFF = { windup: 34, snap: 150, follow: 60, recover: 20 };

/**
 * Applies the choreographed pose of `move` to `p` (which holds the guard).
 * Returns false when the move has no style (the generic hitbox follower is used).
 */
export function strikePose(
  p: Pose,
  f: FighterState,
  stats: CharacterStats,
  b: Body,
  move: MoveDef,
  frame: number,
  line: string,
  firstPerson: boolean,
  time: number,
): boolean {
  const strikes = move.hitboxes.filter((h) => !h.throw).sort((a, z) => a.frames[0] - z.frames[0]);
  const first: HitboxDef | null = strikes[0] ?? null;
  // Several limbs (barrages) keep the generic follower.
  if (first && strikes.some((h) => (h.limb ?? 'rHand') !== (first.limb ?? 'rHand'))) return false;
  const limb = first ? (first.limb ?? 'rHand') : null;
  const name = styleOf(move, limb, line);
  const style = name ? STYLES[name] : undefined;
  if (!style) return false;

  // Timeline.
  let f0: number;
  let f1: number;
  if (first) [f0, f1] = first.frames;
  else if (move.projectiles?.length) {
    f0 = move.projectiles[0].frame;
    f1 = f0 + Math.max(2, move.active) - 1;
  } else {
    f0 = move.startup + 1;
    f1 = move.startup + move.active;
  }
  // The hit (and its freeze) lands on the first active frame, so the snap
  // happens over the last startup frames and arrives on target right then.
  const travel = clamp(Math.round((f0 - 1) * 0.3), 2, 6);
  const release = f0 - travel;
  const total = move.startup + move.active + move.recovery + f.extraRecovery;
  let tau: number;
  if (frame <= release) tau = clamp((frame - 1) / Math.max(1, release - 1), 0, 1);
  else if (frame <= f0) tau = 1 + (frame - release) / travel;
  else tau = 2 + clamp((frame - f0) / Math.max(1, total - f0), 0, 1);
  void f1;

  const pivot = chestHeight(stats);
  const pitch = move.pitchAim === false ? 0 : clamp(f.aimPitch, -RULES.maxPitch, RULES.maxPitch);
  const A = first ? aimed(first.a, pitch, pivot) : v(0.05 * b.w, 1.4 * b.s, 0.6 * b.s);
  const B = first ? aimed(first.b ?? first.a, pitch, pivot) : A;
  const side = limb === 'lHand' || limb === 'lFoot' ? -1 : 1;
  const charge = move.charge ? Math.min(1, f.chargeFrames / move.charge.fullAt) : 0;
  const missed = f.extraRecovery > 0 && tau > 2;
  const c: Ctx = { p, g: { ...p }, b, m: move, f, side, A, B, tau, tauA: 1.45, missed, charge, fp: firstPerson, time };
  style(c);

  // Missed: overextended, off balance, slow to come back.
  if (missed) {
    const k = Math.sin(clamp((tau - 2) / 0.8, 0, 1) * Math.PI);
    p.lean += 0.22 * k;
    p.hipZ += 0.08 * k;
    p.headPitch += 0.12 * k;
  }
  // Spring stiffness by phase: soft anticipation, a whip-crack snap, heavy recovery.
  const limbKey = limb === 'body' || limb === 'head' || !limb ? null : limb;
  const phase = tau < 1 ? 'windup' : tau <= 2.08 ? 'snap' : tau <= 2.3 ? 'follow' : 'recover';
  const heavy = move.kind !== 'light';
  for (const k of ['lHand', 'rHand', 'lFoot', 'rFoot'] as const) {
    const own = k === limbKey;
    p.stiff[k] = own ? STIFF[phase] * (phase === 'recover' && heavy ? 0.8 : 1) : phase === 'snap' ? 60 : 30;
  }
  p.stiff.body = phase === 'snap' ? 55 : phase === 'windup' ? 26 : phase === 'follow' ? 30 : heavy ? 14 : 18;
  if (limbKey && tau >= 1.2 && tau <= 2.25) p.striking.push(limbKey);
  if (limb === 'body' && tau >= 1.5 && tau <= 2.3) p.striking.push('body');
  // Impact shudder: the limb buzzes during the hit freeze.
  if (f.hitstop > 0 && (f.moveHit || f.moveBlocked) && limbKey) {
    const s = Math.sin(time * 95) * 0.012 * b.s;
    p[limbKey] = add(p[limbKey], v(s, s * 0.7, 0));
  }
  return true;
}
