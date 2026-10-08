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
  /** Body spring stiffness the style asks for (overrides the phase default). */
  stiff?: number;
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

/** Two fingers to the visor (seen from inside the hand goes up past the edge of the view). */
const visorHand = (c: Ctx): V3 =>
  c.fp ? v(0.45 * c.b.w, 1.75 * c.b.s, -0.05 * c.b.s) : v(0.13 * c.b.w, 1.66 * c.b.s, 0.1 * c.b.s);

/**
 * Optic blast: two fingers to the visor, square up and focus (chin down, the
 * eyes charge), then the beam leaves and the blast throws the head and the
 * shoulders back. The first-person view only takes a small kick.
 */
function optic(c: Ctx): void {
  const { p, g, b, fp } = c;
  const at = 1.98;
  const kick = 2.12;
  const temple = visorHand(c);
  const brace = fp ? v(-0.15 * b.w, 1.36 * b.s, 0.44 * b.s) : v(-0.17 * b.w, 1.3 * b.s, 0.34 * b.s);
  const back = v(0, 0.025, -0.07);
  p.rHand = path([[0, g.rHand], [0.62, temple], [at, temple, lin], [kick, add(temple, back), easeOut], [2.5, temple], [3, g.rHand]], c.tau);
  p.lHand = path([[0, g.lHand], [0.7, brace], [at, brace, lin], [kick, add(brace, mul(back, 1.4)), easeOut], [2.5, brace], [3, g.lHand]], c.tau);
  set(c, 'rElbow', tr([[0, 0], [0.62, 1], [2.6, 1], [3, 0]], c.tau));
  set(c, 'lElbow', tr([[0, 0], [0.7, -0.3], [2.6, -0.3], [3, 0]], c.tau));
  set(c, 'twist', tr([[0, g.twist], [0.62, 0.02], [2.6, 0.06], [3, g.twist]], c.tau));
  set(c, 'lean', tr([[0, g.lean], [0.62, fp ? 0.1 : 0.15], [at, fp ? 0.11 : 0.17, lin], [kick, fp ? -0.04 : -0.15, easeOut], [2.5, 0], [3, g.lean]], c.tau));
  set(c, 'headPitch', tr([[0, g.headPitch], [0.62, g.headPitch + (fp ? 0.02 : 0.1)], [at, g.headPitch + (fp ? 0.03 : 0.12), lin], [kick, g.headPitch - (fp ? 0.1 : 0.24), easeOut], [2.55, g.headPitch - 0.04], [3, g.headPitch]], c.tau));
  set(c, 'headRoll', tr([[0, 0], [0.62, 0.05], [2.4, 0.05], [3, 0]], c.tau));
  set(c, 'hipZ', tr([[0, 0], [0.62, 0.02], [at, 0.02, lin], [kick, -0.08, easeOut], [2.5, -0.03], [3, 0]], c.tau));
  set(c, 'hipY', tr([[0, g.hipY], [0.62, g.hipY - 0.05], [2.6, g.hipY - 0.04], [3, g.hipY]], c.tau));
  if (!c.f.grounded) {
    // Fired in the air: knees up, hanging on the shot.
    p.lFoot = v(-0.14 * b.w, 0.38 * b.s, 0.16 * b.s);
    p.rFoot = v(0.15 * b.w, 0.5 * b.s, -0.06 * b.s);
  } else {
    step(c, 'rFoot', v(0, 0, -0.03), v(0.03, 0, -0.08), HEAVY);
    set(c, 'rHeel', tr([[0, g.rHeel], [0.62, 0.2], [2.6, 0.08], [3, g.rHeel]], c.tau));
  }
  c.stiff = c.tau < 2 ? 24 : c.tau < 2.3 ? 60 : 18;
}

/**
 * Optic recoil: look down at the floor with two fingers on the visor, blast
 * it, get thrown back with the knees tucked and the arms out for balance,
 * then land low with a hand on the floor and come back up into the guard.
 */
function opticRecoil(c: Ctx): void {
  const { p, g, b, f, fp, tau } = c;
  const air = !!c.m.air;
  const temple = visorHand(c);
  // 1. Aim at the floor in front.
  const down = fp ? 0.3 : air ? 0.7 : 0.55;
  const bend = fp ? 0.17 : 0.24;
  set(c, 'headPitch', tr([[0, g.headPitch], [0.9, g.headPitch + down], [1.98, g.headPitch + down, lin], [2.14, g.headPitch - (fp ? 0.12 : 0.3), easeOut]], tau));
  set(c, 'lean', tr([[0, g.lean], [0.9, bend], [1.98, bend, lin], [2.14, fp ? -0.14 : -0.42, easeOut]], tau));
  set(c, 'hipY', tr([[0, g.hipY], [0.9, g.hipY - 0.08], [2, g.hipY - 0.08], [2.15, g.hipY + 0.02]], tau));
  set(c, 'hipZ', tr([[0, 0], [1.98, 0.03], [2.14, -0.1, easeOut]], tau));
  set(c, 'rElbow', tr([[0, 0], [0.8, 1], [2, 1], [2.2, 0]], tau));
  p.rHand = path([[0, g.rHand], [0.8, temple], [2, temple, lin]], tau);
  p.lHand = path([[0, g.lHand], [0.9, v(-0.15 * b.w, 1.22 * b.s, 0.3 * b.s)], [2, v(-0.15 * b.w, 1.22 * b.s, 0.3 * b.s), lin]], tau);
  if (!f.grounded) {
    p.lFoot = v(-0.14 * b.w, 0.36 * b.s, 0.14 * b.s);
    p.rFoot = v(0.15 * b.w, 0.48 * b.s, -0.04 * b.s);
  }
  c.stiff = 30;
  if (tau < 2) return;

  if (!f.grounded) {
    // 2. Thrown back: knees tucked, arms flung forward for balance, body tipped back.
    const wob = Math.sin(c.time * 9) * 0.04;
    p.lHand = fp ? v(-0.3 * b.w, 1.3 * b.s, 0.46 * b.s) : v(-0.38 * b.w, 1.34 * b.s, 0.4 * b.s);
    p.rHand = fp ? v(0.3 * b.w, 1.26 * b.s, 0.44 * b.s) : v(0.38 * b.w, 1.28 * b.s, 0.36 * b.s);
    p.lFoot = v(-0.15 * b.w, 0.46 * b.s, 0.24 * b.s);
    p.rFoot = v(0.16 * b.w, 0.32 * b.s, 0.06 * b.s);
    if (tau > 2.15) {
      set(c, 'lean', fp ? -0.08 : -0.32);
      set(c, 'headPitch', g.headPitch + (fp ? 0.03 : 0.12));
    }
    set(c, 'roll', wob);
    set(c, 'lElbow', 0.6);
    set(c, 'rElbow', 0.6);
    c.stiff = 26;
    return;
  }
  // 3. Landed: low "superhero" landing, a hand down on the floor, then back up into the guard.
  const up = clamp((tau - 2.72) / 0.28, 0, 1);
  const crouch = 1 - easeInOut(up);
  const hand = fp ? v(-0.3 * b.w, 0.95 * b.s, 0.5 * b.s) : v(-0.28 * b.w, 0.62 * b.s, 0.34 * b.s);
  p.lHand = lerpV(g.lHand, hand, crouch);
  p.rHand = lerpV(g.rHand, fp ? v(0.24 * b.w, 1.2 * b.s, 0.34 * b.s) : v(0.26 * b.w, 1.12 * b.s, 0.1 * b.s), crouch);
  p.lFoot = lerpV(g.lFoot, v(-0.25 * b.w, 0, 0.24 * b.s), crouch);
  p.rFoot = lerpV(g.rFoot, v(0.22 * b.w, 0, -0.3 * b.s), crouch);
  set(c, 'hipY', g.hipY - (fp ? 0.16 : 0.26) * crouch);
  set(c, 'lean', g.lean + (fp ? 0.04 : 0.34) * crouch);
  // Eyes stay on the opponent.
  set(c, 'headPitch', g.headPitch - (fp ? 0 : 0.22) * crouch);
  set(c, 'hipZ', -0.04 * crouch);
  set(c, 'rHeel', 0.6 * crouch);
  c.stiff = 30;
}

/**
 * Ricochet (bank shot): the free arm points down the line, the head tilts as
 * if measuring the angle, two fingers on the visor; then the shot snaps the
 * head back. Seen from inside, the pointing hand sits low in the view.
 */
function opticBank(c: Ctx): void {
  const { p, g, b, fp } = c;
  const at = 1.98;
  const kick = 2.12;
  const temple = visorHand(c);
  const point = fp ? v(-0.12 * b.w, 1.36 * b.s, 0.58 * b.s) : v(-0.06 * b.w, 1.5 * b.s, 0.64 * b.s);
  const back = v(0, 0.025, -0.08);
  p.rHand = path([[0, g.rHand], [0.6, temple], [at, temple, lin], [kick, add(temple, back), easeOut], [2.55, temple], [3, g.rHand]], c.tau);
  p.lHand = path([[0, g.lHand], [0.6, point], [at, point, lin], [kick, add(point, mul(back, 1.3)), easeOut], [2.6, v(-0.15 * b.w, 1.4 * b.s, 0.36 * b.s)], [3, g.lHand]], c.tau);
  set(c, 'lElbow', tr([[0, 0], [0.6, -0.15], [2.4, -0.15], [3, 0]], c.tau));
  set(c, 'rElbow', tr([[0, 0], [0.6, 1], [2.6, 1], [3, 0]], c.tau));
  set(c, 'twist', tr([[0, g.twist], [0.6, -0.42], [at, -0.32, lin], [kick, -0.16, easeOut], [3, g.twist]], c.tau));
  // Measuring the angle: the head tilts and scans along the line, then locks.
  set(c, 'headRoll', tr([[0, 0], [0.6, fp ? 0.07 : 0.18], [1.5, fp ? 0.05 : 0.12], [at, 0.06], [2.4, 0], [3, 0]], c.tau));
  set(c, 'headYaw', tr([[0, 0], [0.6, fp ? 0 : 0.16], [1.1, fp ? 0 : -0.1], [1.6, fp ? 0 : 0.05], [at, 0], [3, 0]], c.tau));
  set(c, 'lean', tr([[0, g.lean], [0.6, fp ? 0.1 : 0.14], [at, fp ? 0.11 : 0.16, lin], [kick, fp ? -0.05 : -0.18, easeOut], [2.55, 0], [3, g.lean]], c.tau));
  set(c, 'headPitch', tr([[0, g.headPitch], [0.6, g.headPitch + (fp ? 0.02 : 0.08)], [at, g.headPitch + (fp ? 0.03 : 0.1), lin], [kick, g.headPitch - (fp ? 0.1 : 0.26), easeOut], [2.55, g.headPitch - 0.04], [3, g.headPitch]], c.tau));
  set(c, 'hipZ', tr([[0, 0], [0.6, 0.02], [at, 0.02, lin], [kick, -0.09, easeOut], [2.5, -0.03], [3, 0]], c.tau));
  if (!c.f.grounded) {
    p.lFoot = v(-0.14 * b.w, 0.38 * b.s, 0.16 * b.s);
    p.rFoot = v(0.15 * b.w, 0.5 * b.s, -0.06 * b.s);
  } else {
    step(c, 'lFoot', v(0, 0, 0.06), v(0, 0, 0.08), HEAVY);
    step(c, 'rFoot', v(0, 0, -0.03), v(0.03, 0, -0.1), HEAVY);
    set(c, 'rHeel', tr([[0, g.rHeel], [0.6, 0.25], [2.6, 0.1], [3, g.rHeel]], c.tau));
  }
  c.stiff = c.tau < 2 ? 24 : c.tau < 2.3 ? 60 : 18;
}

/**
 * Computed ricochet (super): squared up, fingers of both hands on the visor,
 * the head scans fast in little jerks while the visor computes the path, then
 * locks; the shot throws the whole body back.
 */
function opticCalc(c: Ctx): void {
  const { p, g, b, fp, tau } = c;
  const at = 1.98;
  const kick = 2.14;
  const tR = fp ? v(0.45 * b.w, 1.75 * b.s, -0.05 * b.s) : v(0.13 * b.w, 1.66 * b.s, 0.1 * b.s);
  const tL = fp ? v(-0.45 * b.w, 1.75 * b.s, -0.05 * b.s) : v(-0.12 * b.w, 1.67 * b.s, 0.1 * b.s);
  const flungR = fp ? v(0.42 * b.w, 1.25 * b.s, 0.3 * b.s) : v(0.42 * b.w, 1.5 * b.s, 0.02 * b.s);
  const flungL = fp ? v(-0.42 * b.w, 1.25 * b.s, 0.3 * b.s) : v(-0.42 * b.w, 1.52 * b.s, 0.02 * b.s);
  p.rHand = path([[0, g.rHand], [0.45, tR], [at, tR, lin], [kick, flungR, easeOut], [2.6, flungR], [3, g.rHand]], tau);
  p.lHand = path([[0, g.lHand], [0.45, tL], [at, tL, lin], [kick, flungL, easeOut], [2.6, flungL], [3, g.lHand]], tau);
  set(c, 'rElbow', tr([[0, 0], [0.45, 1], [at, 1], [kick, 0.4], [3, 0]], tau));
  set(c, 'lElbow', tr([[0, 0], [0.45, 1], [at, 1], [kick, 0.4], [3, 0]], tau));
  set(c, 'twist', tr([[0, g.twist], [0.45, 0], [2.6, 0], [3, g.twist]], tau));
  // The visor scans: quick jerks left and right, smaller and smaller, then locked.
  const scan = fp ? 0 : 1;
  set(c, 'headYaw', tr([[0, 0], [0.25, 0.3 * scan, lin], [0.4, -0.26 * scan, lin], [0.55, 0.2 * scan, lin], [0.7, -0.14 * scan, lin], [0.85, 0.07 * scan, lin], [1, 0, lin]], tau));
  set(c, 'headPitch', tr([[0, g.headPitch], [0.3, g.headPitch - 0.08 * scan], [0.6, g.headPitch + 0.1 * scan], [1, g.headPitch + 0.04], [at, g.headPitch + 0.06, lin], [kick, g.headPitch - (fp ? 0.14 : 0.42), easeOut], [2.6, g.headPitch - 0.06], [3, g.headPitch]], tau));
  set(c, 'lean', tr([[0, g.lean], [0.45, 0.12], [at, 0.15, lin], [kick, fp ? -0.08 : -0.38, easeOut], [2.6, -0.05], [3, g.lean]], tau));
  set(c, 'hipZ', tr([[0, 0], [at, 0.02], [kick, -0.16, easeOut], [2.6, -0.06], [3, 0]], tau));
  set(c, 'hipY', tr([[0, g.hipY], [0.45, g.hipY - 0.1], [at, g.hipY - 0.1], [kick, g.hipY - 0.15], [2.6, g.hipY - 0.08], [3, g.hipY]], tau));
  set(c, 'roll', tr([[0, 0], [0.5, 0.03], [1, -0.02], [3, 0]], tau));
  if (!c.f.grounded) {
    p.lFoot = v(-0.16 * b.w, 0.36 * b.s, 0.16 * b.s);
    p.rFoot = v(0.17 * b.w, 0.46 * b.s, -0.04 * b.s);
  } else {
    // A wide, squared stance braced for the blast.
    const lF = v(-0.25 * b.w, 0, 0.12 * b.s);
    const rF = v(0.25 * b.w, 0, -0.1 * b.s);
    p.lFoot = path([[0, g.lFoot], [0.45, lF], [at, lF], [kick, add(lF, v(0, 0, -0.06))], [3, g.lFoot]], tau);
    p.rFoot = path([[0, g.rFoot], [0.45, rF], [at, rF], [kick, add(rF, v(0, 0, -0.1))], [3, g.rFoot]], tau);
    set(c, 'lToe', tr([[0, g.lToe], [0.45, 0.1], [2.6, 0.1], [3, g.lToe]], tau));
    set(c, 'rToe', tr([[0, g.rToe], [0.45, 0.15], [2.6, 0.15], [3, g.rToe]], tau));
  }
  set(c, 'glow', tr([[0, 0.2], [1, 0.6], [at, 1], [2.3, 0.7], [3, 0.3]], tau));
  c.stiff = tau < 1 ? 40 : tau < 2 ? 26 : tau < 2.3 ? 70 : 16;
}

/**
 * Cyclone kick: crouch and coil, jump into a whirl with the kicking knee
 * chambered and the arms pulled in, the leg opens right at the end of the
 * first turn and scythes through the target, then the spin runs out in the
 * air and the landing sinks into the knees. From inside: no spin (the camera
 * is yours), the leg whips across under the view.
 */
function cyclone(c: Ctx, air = false): void {
  const { p, g, b, side, A, B, tau } = c;
  const F = footOf(side);
  const S = footOf(-side);
  // Hop (visual only: the simulation keeps the feet on the floor). In the air: no hop, legs folded.
  const hop = air ? 0 : 1;
  set(c, 'hipY', tr([[0, g.hipY], [0.45, g.hipY - 0.14 * hop], [0.65, g.hipY - 0.12 * hop], [1, g.hipY + 0.22 * hop, easeOut], [c.tauA, g.hipY + 0.3 * hop], [2, g.hipY + 0.32 * hop], [2.3, g.hipY + 0.12 * hop], [2.55, g.hipY - 0.12 * hop, easeIn], [3, g.hipY]], tau));
  const tuck = v(-side * 0.1 * b.w, 0.42 * b.s, 0.08 * b.s);
  const rest = (foot: Foot): V3 => (air ? v(foot === 'lFoot' ? -0.14 * b.w : 0.15 * b.w, foot === 'lFoot' ? 0.38 * b.s : 0.5 * b.s, foot === 'lFoot' ? 0.14 * b.s : -0.04 * b.s) : g[foot]);
  p[S] = path([[0, rest(S)], [0.6, add(rest(S), v(0, 0, 0.02))], [1, v(-side * 0.12 * b.w, (air ? 0.4 : 0.22) * b.s, 0.06 * b.s)], [c.tauA, tuck], [2.2, tuck], [2.55, air ? tuck : v(-side * 0.17 * b.w, 0, 0.14 * b.s), easeIn], [3, rest(S)]], tau);
  if (c.fp) {
    roundhouse(c);
    if (!air) set(c, 'hipY', tr([[0, g.hipY], [0.6, g.hipY - 0.1], [1, g.hipY + 0.12], [2, g.hipY + 0.16], [2.55, g.hipY - 0.08], [3, g.hipY]], tau));
    return;
  }
  // The extended leg sits out to its own side; the spin carries it through the hitbox.
  const out = v(side * 0.95 * b.w, ((A.y + B.y) / 2) * b.s, 0.17 * b.s);
  const aOut = Math.atan2(out.x, out.z);
  const pa = Math.atan2(A.x, A.z);
  const pb = Math.atan2(B.x, B.z);
  const dir = Math.sign(wrap(pb - pa)) || -side;
  const toward = (target: number, min: number): number => {
    let sp = wrap(target - aOut);
    while (dir * sp < min) sp += dir * Math.PI * 2;
    return sp;
  };
  // A whole turn before the leg opens, the sweep through the target, the second turn runs out.
  const sA = toward(pa, Math.PI * 1.6);
  const sB = toward(pb, Math.abs(sA) + 0.3);
  const end = dir * Math.PI * 4;
  // Coil the other way, then the whirl starts with the take-off and gathers speed.
  p.spin = tr([[0, 0], [0.45, -dir * 0.4], [0.65, -dir * 0.3, lin], [1, sA * 0.45, easeIn], [c.tauA, sA, lin], [2, sB, lin], [2.6, end, easeOut], [3, end]], tau);
  const chamber = v(side * 0.3 * b.w, 0.95 * b.s, -0.06 * b.s);
  p[F] = path([[0, rest(F)], [0.6, add(rest(F), v(0, 0.02, 0.04))], [1, chamber], [c.tauA - 0.12, chamber], [c.tauA, out, easeOut], [2, out], [2.3, v(side * 0.28 * b.w, 0.75 * b.s, 0)], [2.55, air ? v(side * 0.15 * b.w, 0.5 * b.s, -0.04 * b.s) : v(side * 0.18 * b.w, 0, -0.15 * b.s), easeIn], [3, rest(F)]], tau);
  set(c, kneeOf(side), tr([[0, 0], [1, 0.9], [c.tauA - 0.12, 0.9], [c.tauA, 0.15], [2, -0.85], [2.4, -0.4], [3, 0]], tau));
  set(c, kneeOf(-side), tr([[0, 0], [1, 0.3], [2.3, 0.3], [3, 0]], tau));
  set(c, 'hipTurn', tr([[0, 0], [1, -side * 0.1], [c.tauA, side * 0.6], [2, side * 1.05], [2.4, side * 0.4], [3, 0]], tau));
  set(c, 'lean', tr([[0, g.lean], [0.6, 0.22], [1, 0.02], [c.tauA, -0.18], [2, -0.36], [2.4, -0.1], [2.55, 0.22], [3, g.lean]], tau));
  set(c, 'roll', tr([[0, 0], [1, side * 0.05], [c.tauA, -side * 0.2], [2, -side * 0.38], [2.4, -side * 0.1], [3, 0]], tau));
  set(c, 'headRoll', tr([[0, 0], [c.tauA, side * 0.18], [2, side * 0.3], [2.5, 0.05], [3, 0]], tau));
  // Spotting: the head leads the turn and finds the target first.
  set(c, 'headYaw', tr([[0, 0], [0.6, 0], [1.1, dir * 0.5], [c.tauA, dir * 0.25], [2, 0], [3, 0]], tau));
  set(c, 'headPitch', tr([[0, g.headPitch], [0.6, g.headPitch + 0.12], [2, g.headPitch + 0.1], [2.55, g.headPitch + 0.2], [3, g.headPitch]], tau));
  // Arms pulled in to whirl, flung out for balance as the leg opens.
  const H = handOf(side);
  const O = handOf(-side);
  p[H] = path([[0, g[H]], [0.6, v(side * 0.3 * b.w, 1.0 * b.s, -0.1 * b.s)], [1, v(side * 0.12 * b.w, 1.32 * b.s, 0.12 * b.s)], [c.tauA, v(side * 0.12 * b.w, 1.32 * b.s, 0.12 * b.s)], [2, v(side * 0.35 * b.w, 1.18 * b.s, -0.28 * b.s), easeOut], [2.5, v(side * 0.3 * b.w, 1.2 * b.s, -0.1 * b.s)], [3, g[H]]], tau);
  p[O] = path([[0, g[O]], [0.6, v(-side * 0.32 * b.w, 1.05 * b.s, 0.05 * b.s)], [1, v(-side * 0.1 * b.w, 1.38 * b.s, 0.16 * b.s)], [c.tauA, v(-side * 0.1 * b.w, 1.38 * b.s, 0.16 * b.s)], [2, v(-side * 0.48 * b.w, 1.48 * b.s, 0.12 * b.s), easeOut], [2.5, v(-side * 0.3 * b.w, 1.42 * b.s, 0.2 * b.s)], [3, g[O]]], tau);
  set(c, elbowOf(side), tr([[0, 0], [1, -0.4], [2, 0.6], [3, 0]], tau));
  set(c, elbowOf(-side), tr([[0, 0], [1, -0.4], [2, 0.8], [3, 0]], tau));
  if (!air) set(c, heelOf(-side), tr([[0, g[heelOf(-side)]], [0.6, 0.6], [1, 1], [2.5, 0], [3, g[heelOf(-side)]]], tau));
  c.stiff = tau < 0.6 ? 30 : tau < 2.55 ? 70 : 20;
}

/**
 * Point-blank optic: the lead hand shoots out, palm to the opponent's face
 * (measuring), the other hand to the visor; the palm sweeps aside to open
 * the line, the head leans in and the visor discharges right in their face.
 * The blast throws the head and shoulders back and skids the feet.
 */
function pointBlank(c: Ctx): void {
  const { p, g, b, fp, tau } = c;
  const temple = visorHand(c);
  const reach = fp ? v(-0.04 * b.w, 1.45 * b.s, 0.62 * b.s) : v(-0.05 * b.w, 1.53 * b.s, 0.66 * b.s);
  const aside = fp ? v(-0.5 * b.w, 1.32 * b.s, 0.45 * b.s) : v(-0.44 * b.w, 1.42 * b.s, 0.32 * b.s);
  const flung = fp ? v(-0.48 * b.w, 1.2 * b.s, 0.3 * b.s) : v(-0.46 * b.w, 1.36 * b.s, 0.04 * b.s);
  p.lHand = path([[0, g.lHand], [0.55, reach, easeOut], [1, reach], [1.65, aside, easeInOut], [2, aside], [2.14, flung, easeOut], [2.6, flung], [3, g.lHand]], tau);
  p.rHand = path([[0, g.rHand], [0.55, temple], [2, temple, lin], [2.14, add(temple, v(0.04, 0.03, -0.1)), easeOut], [2.6, v(0.26 * b.w, 1.36 * b.s, 0.14 * b.s)], [3, g.rHand]], tau);
  set(c, 'lElbow', tr([[0, 0], [0.55, -0.2], [1.65, 0.6], [2.6, 0.6], [3, 0]], tau));
  set(c, 'rElbow', tr([[0, 0], [0.55, 1], [2.3, 1], [3, 0]], tau));
  set(c, 'twist', tr([[0, g.twist], [0.55, -0.42], [1.65, -0.08], [2, 0], [2.14, 0.12], [3, g.twist]], tau));
  set(c, 'lean', tr([[0, g.lean], [0.55, fp ? 0.12 : 0.22], [1, fp ? 0.14 : 0.25], [1.95, fp ? 0.16 : 0.34], [2.14, fp ? -0.1 : -0.36, easeOut], [2.6, fp ? -0.02 : -0.1], [3, g.lean]], tau));
  set(c, 'hipZ', tr([[0, 0], [0.55, 0.06], [1.95, 0.13], [2.14, -0.15, easeOut], [2.6, -0.06], [3, 0]], tau));
  set(c, 'headPitch', tr([[0, g.headPitch], [0.55, g.headPitch + 0.08], [1.95, g.headPitch + (fp ? 0.05 : 0.16)], [2.14, g.headPitch - (fp ? 0.16 : 0.42), easeOut], [2.6, g.headPitch - 0.08], [3, g.headPitch]], tau));
  set(c, 'hipY', tr([[0, g.hipY], [0.55, g.hipY - 0.07], [2, g.hipY - 0.1], [2.14, g.hipY - 0.05], [3, g.hipY]], tau));
  set(c, 'roll', tr([[0, 0], [0.55, 0.04], [2, 0], [2.14, -0.05], [3, 0]], tau));
  // Step in with the lead foot; the blast skids the rear foot back.
  step(c, 'lFoot', v(-0.02, 0, 0.18), v(-0.02, 0, 0.2), HEAVY);
  p.rFoot = path([[0, g.rFoot], [0.55, add(g.rFoot, v(0, 0, 0.05))], [2, add(g.rFoot, v(0, 0, 0.05))], [2.3, add(g.rFoot, v(0.03, 0, -0.14)), easeOut], [3, g.rFoot]], tau);
  set(c, 'rHeel', tr([[0, g.rHeel], [0.55, 0.3], [2, 0.5], [2.3, 0.8], [3, g.rHeel]], tau));
  set(c, 'glow', tr([[0, 0], [1.5, 0], [1.95, 0.55], [2.05, 1], [2.45, 0.2], [3, 0]], tau));
  c.stiff = tau < 1 ? 28 : tau < 2 ? 50 : tau < 2.3 ? 95 : 18;
}

/**
 * Gene splice: sink low with the fist cocked at the hip (it burns ruby),
 * explode upward into a jumping uppercut: the fist drives up through the
 * target, the other arm yanks down, one knee comes up, the eyes follow the
 * opponent into the air; hang at the top, then drop into a soft landing.
 */
function geneSplice(c: Ctx): void {
  const { p, g, b, side, A, B, tau } = c;
  const H = handOf(side);
  const O = handOf(-side);
  const F = footOf(side);
  const S = footOf(-side);
  const cocked = v(side * 0.2 * b.w, 0.86 * b.s, -0.04 * b.s);
  const top = v(side * 0.04 * b.w, 2.18 * b.s, 0.42 * b.s);
  p[H] = path([[0, g[H]], [0.7, cocked], [1, cocked, lin], [c.tauA, A, easeIn], [2, B, easeOut], [2.4, top, easeOut], [2.65, top], [3, g[H]]], tau);
  p[O] = path([[0, g[O]], [0.7, v(-side * 0.16 * b.w, 1.32 * b.s, 0.42 * b.s)], [1, v(-side * 0.16 * b.w, 1.32 * b.s, 0.42 * b.s)], [2, v(-side * 0.24 * b.w, 0.98 * b.s, -0.02 * b.s), easeOut], [2.6, v(-side * 0.24 * b.w, 1.0 * b.s, 0)], [3, g[O]]], tau);
  set(c, elbowOf(side), tr([[0, 0], [0.7, -0.6], [2, -1], [2.6, -0.8], [3, 0]], tau));
  set(c, elbowOf(-side), tr([[0, 0], [1, -0.2], [2, 0.6], [3, 0]], tau));
  // Hop (visual only).
  const jump = c.fp ? 0.16 : 0.34;
  set(c, 'hipY', tr([[0, g.hipY], [0.7, g.hipY - 0.3], [1, g.hipY - 0.3, lin], [c.tauA, g.hipY - 0.05, easeIn], [2, g.hipY + jump, easeOut], [2.4, g.hipY + jump * 1.05], [2.62, g.hipY - 0.16, easeIn], [3, g.hipY]], tau));
  if (c.fp) {
    step(c, 'lFoot', v(0, 0, 0.04), v(0, 0, 0.06), HEAVY);
  } else {
    // Take-off: the lead knee drives up, the other leg hangs straight down.
    const knee = v(-side * 0.14 * b.w, 0.62 * b.s, 0.3 * b.s);
    const hang = v(side * 0.12 * b.w, 0.3 * b.s, -0.14 * b.s);
    const wideS = add(g[S], v(-side * 0.06, 0, 0.06));
    const wideF = add(g[F], v(side * 0.06, 0, -0.04));
    p[S] = path([[0, g[S]], [0.7, wideS], [1, wideS], [c.tauA, add(wideS, v(0, 0.08, 0))], [2, knee, easeOut], [2.4, knee], [2.62, v(-side * 0.18 * b.w, 0, 0.16 * b.s), easeIn], [3, g[S]]], tau);
    p[F] = path([[0, g[F]], [0.7, wideF], [1, wideF], [c.tauA, add(wideF, v(0, 0.05, 0))], [2, hang, easeOut], [2.4, hang], [2.62, v(side * 0.2 * b.w, 0, -0.18 * b.s), easeIn], [3, g[F]]], tau);
    set(c, kneeOf(-side), tr([[0, 0], [0.7, 0.4], [2, 0.1], [3, 0]], tau));
    set(c, kneeOf(side), tr([[0, 0], [0.7, 0.4], [2, 0], [3, 0]], tau));
  }
  set(c, 'lean', tr([[0, g.lean], [0.7, 0.42], [1, 0.42, lin], [2, -0.22, easeOut], [2.4, -0.28], [2.62, 0.25], [3, g.lean]], tau));
  set(c, 'twist', tr([[0, g.twist], [0.7, -side * 0.35], [1, -side * 0.35], [2, side * 0.55, easeOut], [2.5, side * 0.4], [3, g.twist]], tau));
  set(c, 'hipTurn', tr([[0, 0], [0.7, -side * 0.12], [2, side * 0.3], [3, 0]], tau));
  set(c, 'roll', tr([[0, 0], [0.7, side * 0.16], [2, -side * 0.12], [2.5, -side * 0.06], [3, 0]], tau));
  // Eyes on the target, then up after it as it flies.
  set(c, 'headPitch', tr([[0, g.headPitch], [0.7, g.headPitch - 0.05], [2, g.headPitch - (c.fp ? 0.2 : 0.42), easeOut], [2.45, g.headPitch - (c.fp ? 0.24 : 0.55)], [2.65, g.headPitch], [3, g.headPitch]], tau));
  set(c, 'glow', tr([[0, 0], [0.7, 0.35], [1, 0.55], [2, 1], [2.4, 0.4], [3, 0]], tau));
  c.stiff = tau < 1 ? 30 : tau < 2.05 ? 90 : tau < 2.55 ? 34 : 22;
}

/**
 * Mega beam. Wind-up: fingers of both hands on the visor, head down, the
 * power gathers. Firing (the move holds while the button is held): on the
 * floor a wide braced stance, leaning into the beam, the rear foot sliding;
 * in the air the legs trail and the body tips with the push, the torso bends
 * to look where the beam goes. The whole body shudders with the power. Then
 * the hands come off the visor and the head shakes it off.
 */
function megaBeam(c: Ctx): void {
  const { p, g, b, f, fp, tau } = c;
  const firing = f.beaming;
  const air = !f.grounded;
  const t = c.time;
  const tR = fp ? v(0.45 * b.w, 1.75 * b.s, -0.05 * b.s) : v(0.13 * b.w, 1.66 * b.s, 0.1 * b.s);
  const tL = fp ? v(-0.45 * b.w, 1.75 * b.s, -0.05 * b.s) : v(-0.12 * b.w, 1.67 * b.s, 0.1 * b.s);
  // Hands: to the visor during the wind-up, held there while it fires, down after.
  const hold = tr([[0, 0], [0.5, 1], [2.25, 1], [2.75, 0]], tau);
  const quake = firing ? Math.sin(t * 47) * 0.012 : 0;
  p.rHand = add(lerpV(g.rHand, tR, hold), v(quake, quake * 0.6, 0));
  p.lHand = add(lerpV(g.lHand, tL, hold), v(-quake, quake * 0.6, 0));
  set(c, 'rElbow', 1.1 * hold);
  set(c, 'lElbow', 1.1 * hold);
  set(c, 'twist', g.twist * (1 - hold));
  // Wind-up: head down, gathering; firing: head along the beam.
  const aimLean = fp ? 0 : clamp(-f.aimPitch * 0.45, -0.3, 0.65);
  const gather = tr([[0, 0], [0.6, 1], [1.7, 1], [2, 0]], tau);
  // Local velocity: the push tips the body (pushed back = legs swing forward, chest back).
  const sn = Math.sin(f.yaw);
  const cs = Math.cos(f.yaw);
  const vz = -sn * f.vel.x - cs * f.vel.z;
  const vx = cs * f.vel.x - sn * f.vel.z;
  const tipBack = firing && air ? clamp(-vz / 9, -1, 1) : 0;
  const tipSide = firing && air ? clamp(vx / 9, -1, 1) : 0;
  const lean = firing ? (air ? 0.05 + aimLean - tipBack * 0.25 : 0.24 + aimLean * 0.6) : tr([[0, g.lean], [0.6, 0.2], [1.8, 0.22], [2.2, -0.05], [2.75, 0.05], [3, g.lean]], tau);
  set(c, 'lean', lean + (firing ? Math.sin(t * 31) * 0.015 : 0));
  set(c, 'roll', firing ? -tipSide * 0.25 + Math.sin(t * 23) * 0.02 : 0);
  set(c, 'headPitch', g.headPitch + 0.25 * gather * (fp ? 0.2 : 1) + (firing && !fp ? Math.sin(t * 53) * 0.02 : 0));
  // After: a shake of the head, as if the light still burned.
  set(c, 'headRoll', firing ? 0 : tr([[0, 0], [2.3, 0], [2.45, 0.14], [2.6, -0.12], [2.75, 0.06], [3, 0]], tau));
  set(c, 'hipZ', firing && !air ? -0.05 : 0);
  if (air) {
    // Legs trail the push, knees bent, swinging with it.
    const sw = tipBack * 0.25;
    p.lFoot = v(-0.15 * b.w, (0.36 - sw * 0.2) * b.s, (-0.18 + sw) * b.s);
    p.rFoot = v(0.16 * b.w, (0.48 - sw * 0.2) * b.s, (-0.32 + sw) * b.s);
    set(c, 'lKnee', 0.2);
    set(c, 'rKnee', -0.1);
    set(c, 'hipY', g.hipY + 0.05);
  } else {
    // A wide braced stance: lead foot planted, rear foot driven back, heel up.
    const brace = tr([[0, 0], [0.6, 0.5], [1.9, 0.6], [2, 1], [2.3, 1], [2.8, 0]], firing ? 2.1 : tau);
    p.lFoot = lerpV(g.lFoot, v(-0.24 * b.w, 0, 0.32 * b.s), brace);
    p.rFoot = lerpV(g.rFoot, v(0.26 * b.w, 0, -0.42 * b.s), brace);
    set(c, 'rHeel', 0.7 * brace);
    set(c, 'hipY', g.hipY - 0.12 * brace - 0.05 * gather);
  }
  set(c, 'glow', firing ? 0.5 + Math.sin(t * 29) * 0.1 : tr([[0, 0.2], [1.9, 0.6], [2.3, 0.35], [3, 0]], tau));
  c.stiff = firing ? 40 : tau < 2 ? 30 : 18;
}

/**
 * Flip hammer (air hammer): tuck into a forward somersault, open up out of it
 * with both fists high and chop down through the target. From inside: no
 * flip (the camera is yours), just the chop.
 */
function flipHammer(c: Ctx): void {
  hammer(c);
  if (c.fp) return;
  const { p, b, tau } = c;
  p.flip = tr([[0, 0], [0.1, 0], [1.2, Math.PI * 2, easeInOut], [3, Math.PI * 2]], tau);
  const k = tr([[0, 0], [0.25, 1], [0.95, 1], [1.35, 0]], tau);
  p.lFoot = lerpV(v(-0.12 * b.w, 0.3 * b.s, 0.12 * b.s), v(-0.12 * b.w, 0.78 * b.s, 0.32 * b.s), k);
  p.rFoot = lerpV(v(0.12 * b.w, 0.42 * b.s, -0.08 * b.s), v(0.12 * b.w, 0.8 * b.s, 0.3 * b.s), k);
  p.lHand = lerpV(p.lHand, v(-0.14 * b.w, 0.98 * b.s, 0.4 * b.s), k);
  p.rHand = lerpV(p.rHand, v(0.14 * b.w, 0.98 * b.s, 0.4 * b.s), k);
  p.lean += 0.55 * k;
  p.headPitch += 0.5 * k;
  p.hipY -= 0.08 * k * b.s;
  set(c, 'lKnee', 0.3 * k);
  set(c, 'rKnee', 0.3 * k);
  c.stiff = tau < 1.35 ? 60 : (c.stiff ?? 40);
}

/** Aerial tornado (air spin kick): the cyclone, in the air, legs folded. */
function airTornado(c: Ctx): void {
  cyclone(c, true);
}

/**
 * Meteor (dive kick): hang for a heartbeat, knees up, arms raised, eyes on
 * the target; then the body becomes a spear: the kicking leg straight at the
 * target, the other knee tucked, arms swept back like wings.
 */
function meteor(c: Ctx): void {
  const { p, b, side, A, tau } = c;
  const F = footOf(side);
  const S = footOf(-side);
  const spear = v(side * 0.04 * b.w, A.y - 0.08, A.z + 0.08);
  const hangF = v(side * 0.12 * b.w, 0.72 * b.s, 0.24 * b.s);
  const hangS = v(-side * 0.12 * b.w, 0.7 * b.s, 0.2 * b.s);
  p[F] = path([[0, hangF], [0.9, hangF], [1.3, spear, easeOut], [2.6, spear], [3, hangF]], tau);
  p[S] = path([[0, hangS], [0.9, hangS], [1.3, v(-side * 0.1 * b.w, 0.78 * b.s, 0.06 * b.s), easeOut], [3, v(-side * 0.1 * b.w, 0.7 * b.s, 0.06 * b.s)]], tau);
  set(c, kneeOf(-side), 0.35);
  const up = (sd: number): V3 => v(sd * 0.3 * b.w, 1.95 * b.s, 0.05 * b.s);
  const wing = (sd: number): V3 => v(sd * 0.42 * b.w, 1.62 * b.s, -0.38 * b.s);
  p.lHand = path([[0, up(-1)], [0.9, up(-1)], [1.3, wing(-1), easeOut], [2.6, wing(-1)], [3, up(-1)]], tau);
  p.rHand = path([[0, up(1)], [0.9, up(1)], [1.3, wing(1), easeOut], [2.6, wing(1)], [3, up(1)]], tau);
  set(c, 'lElbow', tr([[0, 0.8], [1.3, 0.2], [3, 0.2]], tau));
  set(c, 'rElbow', tr([[0, 0.8], [1.3, 0.2], [3, 0.2]], tau));
  set(c, 'lean', tr([[0, 0.15], [0.9, 0.2], [1.3, -0.42, easeOut], [2.6, -0.42], [3, -0.2]], tau));
  set(c, 'headPitch', tr([[0, 0.35], [0.9, 0.4], [1.3, 0.55], [3, 0.5]], tau));
  set(c, 'hipTurn', tr([[0, 0], [1.3, side * 0.15], [3, side * 0.15]], tau));
  set(c, 'glow', tr([[0, 0.1], [0.9, 0.6], [1.3, 0.9], [2.4, 0.7], [3, 0.2]], tau));
  c.stiff = tau < 0.9 ? 30 : tau < 1.4 ? 70 : 40;
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
  optic,
  opticRecoil,
  opticBank,
  opticCalc,
  cyclone,
  pointBlank,
  geneSplice,
  megaBeam,
  flipHammer,
  airTornado,
  meteor,
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
  p.stiff.body = c.stiff ?? (phase === 'snap' ? 55 : phase === 'windup' ? 26 : phase === 'follow' ? 30 : heavy ? 14 : 18);
  if (limbKey && tau >= 1.2 && tau <= 2.25) p.striking.push(limbKey);
  if (limb === 'body' && tau >= 1.5 && tau <= 2.3) p.striking.push('body');
  // Impact shudder: the limb buzzes during the hit freeze.
  if (f.hitstop > 0 && (f.moveHit || f.moveBlocked) && limbKey) {
    const s = Math.sin(time * 95) * 0.012 * b.s;
    p[limbKey] = add(p[limbKey], v(s, s * 0.7, 0));
  }
  return true;
}
