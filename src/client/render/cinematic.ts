/**
 * Cinematic throws: a scripted scene for two bodies and a directed camera.
 *
 * Once a cinematic throw starts the simulation only pins the victim and
 * counts frames; this module turns the frame count into the film: where each
 * body is (relative to where the thrower stood, facing where it faced), the
 * pose of each body, the beam, and the camera shot. Both participants see the
 * same film. The thrower ends exactly where it stands in the simulation; the
 * victim comes down where it is pinned, so handing back to the simulation is
 * seamless.
 *
 * Scene space: x right, y up, z forward of the thrower at the start; the
 * victim stands at z = d (pinned in front).
 */
import { SHOWCASE } from '../../content/cards/cyclops';
import type { LimbId } from '../../core/types';
import { add, type Body, easeIn, easeInOut, easeOut, lerpV, type Pose, v, type V3 } from './anim';
import { path, tr } from './strikes';

export interface SceneActor {
  /** Root position in scene space. */
  off: V3;
  /** Facing relative to the scene (0 = the thrower's facing). */
  yaw: number;
  pose(p: Pose, b: Body, time: number): void;
  /** Limbs that strike right now (motion trails). */
  striking: LimbId[];
}

export interface SceneShot {
  /** Camera position and target in scene space; `pov` puts the camera in that actor's eyes. */
  pos: V3;
  look: V3;
  fov: number;
  pov?: 'attacker' | 'victim';
  /** Seen through Cyclops' ruby visor. */
  visor?: boolean;
  /** Width of the film's beam in this shot (it runs close to the lens in some). */
  beamWidth: number;
}

export interface SceneFrame {
  attacker: SceneActor;
  /** Null once the scene hands the victim back to the simulation. */
  victim: SceneActor | null;
  shot: SceneShot;
  /** The beam is on (from the thrower's eyes to the victim's chest). */
  beam: boolean;
  /** Letterbox / title visible. */
  title: string | null;
  /** Glow of the thrower's eyes behind the visor (0..1). */
  eyes: number;
}

/** Last frame of the film (thrower's recovery included). */
export const SHOWCASE_LENGTH = SHOWCASE.end + 36;
const TAU = Math.PI * 2;
const S = SHOWCASE;

// ===========================================================================
// Thrower

function attackerOff(t: number): V3 {
  const y = tr(
    [
      [0, 0],
      [S.rocket + 2, 0],
      [S.rocket + 10, 2.5, easeOut],
      [S.smash - 6, 3.4, easeOut],
      [S.smash + 12, 0.9, easeIn],
      [S.end - 2, 0, easeIn],
    ],
    t,
  );
  const z = tr([[0, 0], [S.rocket + 2, 0], [S.rocket + 10, 0.2], [S.smash - 6, 0.45], [S.smash + 12, 0.3], [S.end - 2, 0]], t);
  return v(0, y, z);
}

function attackerPose(t: number, p: Pose, b: Body, time: number): void {
  const W = b.w;
  const H = b.s;
  const h0 = b.hipY - 0.04 * H;
  const g = { lHand: v(-0.13 * W, 1.47 * H, 0.36 * H), rHand: v(0.16 * W, 1.4 * H, 0.25 * H), lFoot: v(-0.16 * W, 0, 0.2 * H), rFoot: v(0.18 * W, 0, -0.18 * H) };
  const temple = v(0.13 * W, 1.66 * H, 0.1 * H);
  const beamOn = t >= S.toss + 26 && t < S.rocket - 2;
  const quake = beamOn ? Math.sin(time * 47) * 0.01 : 0;
  p.lHand = path(
    [
      [0, g.lHand],
      [6, v(-0.04 * W, 1.45 * H, 0.62 * H)],
      [16, v(-0.04 * W, 1.42 * H, 0.55 * H)],
      [S.toss, v(-0.12 * W, 1.3 * H, 0.5 * H)],
      [S.toss + 6, v(-0.14 * W, 0.95 * H, 0.55 * H)],
      [S.toss + 12, v(-0.16 * W, 2.05 * H, 0.38 * H), easeOut],
      [S.toss + 22, v(-0.14 * W, 1.35 * H, 0.3 * H)],
      [S.toss + 28, v(-0.12 * W, 1.3 * H, 0.32 * H)],
      [S.rocket - 2, v(-0.12 * W, 1.3 * H, 0.32 * H)],
      [S.rocket + 2, v(-0.3 * W, 0.42 * H, 0.32 * H)],
      [S.rocket + 6, v(-0.46 * W, 1.1 * H, -0.3 * H), easeOut],
      [S.smash - 10, v(-0.46 * W, 1.2 * H, -0.3 * H)],
      [S.smash - 6, v(-0.08 * W, 2.1 * H, 0.1 * H)],
      [S.smash, v(-0.06 * W, 0.85 * H, 0.62 * H), easeIn],
      [S.smash + 8, v(-0.1 * W, 0.9 * H, 0.5 * H)],
      [S.end - 2, v(-0.4 * W, 1.3 * H, 0.1 * H)],
      [S.end + 2, v(-0.56 * W, 1.25 * H, 0.0)],
      [S.end + 22, v(-0.56 * W, 1.25 * H, 0.0)],
      [S.end + 34, g.lHand],
    ],
    t,
  );
  p.rHand = add(
    path(
      [
        [0, g.rHand],
        [6, v(0.25 * W, 1.1 * H, -0.12 * H)],
        [16, v(0.2 * W, 1.25 * H, 0.15 * H)],
        [S.toss, v(0.12 * W, 1.3 * H, 0.5 * H)],
        [S.toss + 6, v(0.14 * W, 0.95 * H, 0.55 * H)],
        [S.toss + 12, v(0.16 * W, 2.05 * H, 0.38 * H), easeOut],
        [S.toss + 22, v(0.14 * W, 1.4 * H, 0.3 * H)],
        [S.toss + 28, temple],
        [S.rocket - 2, temple],
        [S.rocket + 2, v(0.3 * W, 0.42 * H, 0.32 * H)],
        [S.rocket + 6, v(0.46 * W, 1.1 * H, -0.3 * H), easeOut],
        [S.smash - 10, v(0.46 * W, 1.2 * H, -0.3 * H)],
        [S.smash - 6, v(0.08 * W, 2.1 * H, 0.1 * H)],
        [S.smash, v(0.06 * W, 0.85 * H, 0.62 * H), easeIn],
        [S.smash + 8, v(0.1 * W, 0.9 * H, 0.5 * H)],
        [S.end - 2, v(0.3 * W, 0.6 * H, 0.3 * H)],
        [S.end + 2, v(0.32 * W, 0.08 * H, 0.3 * H)],
        [S.end + 22, v(0.32 * W, 0.08 * H, 0.3 * H)],
        [S.end + 34, g.rHand],
      ],
      t,
    ),
    v(quake, quake * 0.6, 0),
  );
  p.lFoot = path(
    [
      [0, g.lFoot],
      [8, v(-0.16 * W, 0, 0.25 * H)],
      [S.toss + 6, v(-0.24 * W, 0, 0.3 * H)],
      [S.rocket + 2, v(-0.26 * W, 0, 0.2 * H)],
      [S.rocket + 6, v(-0.12 * W, 0.5 * H, 0.2 * H), easeOut],
      [S.smash - 4, v(-0.12 * W, 0.55 * H, 0.25 * H)],
      [S.smash + 2, v(-0.12 * W, 0.25 * H, 0.05 * H)],
      [S.end - 6, v(-0.14 * W, 0.15 * H, 0.1 * H)],
      [S.end - 2, v(-0.18 * W, 0.05 * H, 0.25 * H)],
      [S.end + 2, v(-0.22 * W, 0, 0.38 * H)],
      [S.end + 22, v(-0.22 * W, 0, 0.38 * H)],
      [S.end + 34, g.lFoot],
    ],
    t,
  );
  p.rFoot = path(
    [
      [0, g.rFoot],
      [7, v(0.16 * W, 0, -0.15 * H)],
      [S.knee - 3, v(0.08 * W, 0.52 * H, 0.28 * H), easeOut],
      [S.knee + 3, v(0.16 * W, 0.04 * H, -0.1 * H)],
      [S.toss + 6, v(0.24 * W, 0, -0.25 * H)],
      [S.rocket + 2, v(0.26 * W, 0, -0.2 * H)],
      [S.rocket + 6, v(0.12 * W, 0.55 * H, 0, ), easeOut],
      [S.smash - 4, v(0.12 * W, 0.6 * H, 0.1 * H)],
      [S.smash + 2, v(0.12 * W, 0.3 * H, -0.1 * H)],
      [S.end - 6, v(0.14 * W, 0.15 * H, -0.05 * H)],
      [S.end - 2, v(0.18 * W, 0.05 * H, -0.2 * H)],
      [S.end + 2, v(0.2 * W, 0.02 * H, -0.48 * H)],
      [S.end + 22, v(0.2 * W, 0.02 * H, -0.48 * H)],
      [S.end + 34, g.rFoot],
    ],
    t,
  );
  p.hipY = tr(
    [
      [0, h0],
      [8, h0 - 0.03],
      [S.knee - 3, h0 + 0.05],
      [S.knee + 3, h0],
      [S.toss + 6, h0 - 0.28],
      [S.toss + 12, h0 + 0.06, easeOut],
      [S.toss + 22, h0],
      [S.rocket - 2, h0 - 0.06],
      [S.rocket + 2, h0 - 0.36],
      [S.rocket + 6, h0 - 0.05],
      [S.end - 2, h0],
      [S.end + 2, h0 - 0.48, easeOut],
      [S.end + 22, h0 - 0.45],
      [S.end + 34, h0],
    ],
    t,
  );
  p.lean = tr(
    [
      [0, 0.12],
      [8, 0.15],
      [S.knee - 3, -0.08],
      [S.knee + 3, 0.1],
      [S.toss + 6, 0.45],
      [S.toss + 12, -0.25],
      [S.toss + 22, -0.15],
      [S.toss + 28, -0.3],
      [S.rocket - 2, -0.3],
      [S.rocket + 2, 0.5],
      [S.rocket + 6, 0.1],
      [S.smash - 8, 0.2],
      [S.smash, 0.55, easeIn],
      [S.smash + 8, 0.35],
      [S.end - 2, 0.2],
      [S.end + 2, 0.5],
      [S.end + 22, 0.45],
      [S.end + 34, 0.08],
    ],
    t,
  );
  p.headPitch = tr(
    [
      [0, 0.15],
      [S.toss + 6, 0.3],
      [S.toss + 12, -0.6],
      [S.toss + 22, -0.8],
      [S.toss + 28, -1.0],
      [S.rocket - 2, -1.0],
      [S.rocket + 2, 0.5],
      [S.rocket + 6, -0.5],
      [S.smash - 8, -0.2],
      [S.smash, 0.5],
      [S.smash + 12, 0.6],
      [S.end + 2, -0.25],
      [S.end + 22, -0.3],
      [S.end + 34, 0.05],
    ],
    t,
  );
  p.twist = tr([[0, -0.3], [8, -0.45], [S.knee - 3, 0.1], [S.knee + 3, -0.1], [S.toss + 6, 0], [S.toss + 12, 0.2], [S.toss + 22, 0], [S.end + 34, -0.25]], t);
  p.roll = beamOn ? Math.sin(time * 23) * 0.02 : 0;
  p.headYaw = 0;
  p.headRoll = tr([[0, 0], [S.end + 22, 0], [S.end + 26, 0.12], [S.end + 30, -0.08], [S.end + 34, 0]], t);
  p.hipTurn = 0;
  p.tiltPitch = 0;
  p.tiltRoll = 0;
  p.spin = 0;
  // A front flip in the air before the smash.
  p.flip = tr([[0, 0], [S.smash - 10, 0], [S.smash - 1, TAU, easeInOut], [SHOWCASE_LENGTH, TAU]], t);
  p.rElbow = beamOn ? 1 : tr([[0, 0], [6, 0.8], [16, 0], [S.toss + 26, 0], [S.toss + 28, 1]], t);
  p.lElbow = beamOn ? -0.3 : 0;
  p.rKnee = tr([[0, 0], [S.knee - 3, -0.1], [S.knee + 3, 0], [S.end + 2, 0.3], [S.end + 22, 0.3], [S.end + 34, 0]], t);
  p.lKnee = 0;
  p.rHeel = tr([[0, 0.15], [S.toss + 6, 0.2], [S.toss + 12, 0.8], [S.toss + 22, 0.2], [S.end + 2, 0.9], [S.end + 22, 0.9], [S.end + 34, 0.15]], t);
  p.lHeel = tr([[0, 0], [S.toss + 6, 0.1], [S.toss + 12, 0.7], [S.toss + 22, 0]], t);
  p.glow = tr([[0, 0.1], [S.toss + 24, 0.35], [S.toss + 28, 0.6], [S.rocket, 0.5], [S.rocket + 4, 0.6], [S.rocket + 12, 0.3], [S.smash, 0.55], [S.smash + 8, 0.25], [S.end + 4, 0.5], [S.end + 22, 0.2], [SHOWCASE_LENGTH, 0]], t);
  const k = t < S.toss ? 45 : 60;
  p.stiff = { lHand: k, rHand: k, lFoot: k, rFoot: k, body: 40 };
}

// ===========================================================================
// Victim (its own frame: it faces the thrower)

function victimOff(t: number, d: number): V3 {
  const y = tr(
    [
      [0, 0],
      [S.knee, 0],
      [S.knee + 2, 0.08],
      [S.toss, 0],
      [S.toss + 8, 0.5, easeOut],
      [S.toss + 24, 2.6, easeOut],
      [S.rocket, 3.2, easeOut],
      [S.smash, 3.0],
      [S.smash + 12, 0.25, easeIn],
      [S.smash + 13, 0.05],
    ],
    t,
  );
  const z = tr([[0, d], [S.toss, d], [S.toss + 8, d - 0.1], [S.toss + 24, d + 0.5], [S.smash, d + 0.5], [S.smash + 12, d]], t);
  return v(0, y, z);
}

function victimPose(t: number, p: Pose, b: Body, time: number): void {
  const W = b.w;
  const H = b.s;
  const h0 = b.hipY - 0.04 * H;
  const flail = t > S.toss + 6 && t < S.smash + 12 ? 1 : 0;
  const wob = (k: number): number => Math.sin(time * 9 + k) * 0.12 * flail;
  const hands = (sd: number): V3 =>
    path(
      [
        [0, v(sd * 0.22 * W, 1.5 * H, 0.1 * H)],
        [S.knee, v(sd * 0.22 * W, 1.5 * H, 0.1 * H)],
        [S.knee + 2, v(sd * 0.1 * W, 1.05 * H, 0.25 * H), easeOut],
        [S.toss, v(sd * 0.1 * W, 1.05 * H, 0.25 * H)],
        [S.toss + 8, v(sd * 0.45 * W, 1.75 * H, 0.0)],
        [S.smash, v(sd * 0.5 * W, 1.6 * H, -0.1 * H)],
        [S.smash + 12, v(sd * 0.5 * W, 1.4 * H, 0.0)],
      ],
      t,
    );
  const feet = (sd: number): V3 =>
    path(
      [
        [0, v(sd * 0.15 * W, 0, 0.05 * H)],
        [S.knee, v(sd * 0.15 * W, 0, 0.05 * H)],
        [S.knee + 2, v(sd * 0.14 * W, 0.05 * H, -0.12 * H)],
        [S.toss + 8, v(sd * 0.15 * W, 0.25 * H, 0.1 * H)],
        [S.smash, v(sd * 0.16 * W, 0.6 * H, 0.35 * H)],
        [S.smash + 12, v(sd * 0.2 * W, 0.05 * H, 0.1 * H)],
      ],
      t,
    );
  p.lHand = add(hands(-1), v(0, wob(0), wob(1)));
  p.rHand = add(hands(1), v(0, wob(2), wob(3)));
  p.lFoot = add(feet(-1), v(0, wob(4) * 0.5, wob(5)));
  p.rFoot = add(feet(1), v(0, wob(6) * 0.5, wob(7)));
  p.hipY = tr([[0, h0], [S.knee, h0], [S.knee + 2, h0 - 0.12], [S.toss, h0 - 0.1], [S.toss + 8, h0]], t);
  p.lean = tr([[0, 0.05], [S.knee, 0.05], [S.knee + 2, 0.7, easeOut], [S.toss, 0.6], [S.toss + 8, -0.2], [S.toss + 24, -0.35], [S.smash, -0.35], [S.smash + 6, 0.1], [S.smash + 12, -0.1]], t);
  p.headPitch = tr([[0, 0.1], [S.knee, 0.1], [S.knee + 2, 0.6], [S.toss, 0.5], [S.toss + 8, -0.4], [S.toss + 24, -0.6], [S.smash, -0.6], [S.smash + 6, 0.3], [S.smash + 12, -0.3]], t);
  p.twist = 0;
  p.roll = 0;
  p.headYaw = 0;
  p.headRoll = Math.sin(time * 5) * 0.2 * flail;
  p.hipTurn = 0;
  p.tiltPitch = 0;
  p.tiltRoll = 0;
  // Thrown over backwards, then held lying flat in the beam, rolling like a log; slammed down flat.
  p.flip = tr([[0, 0], [S.toss + 6, 0], [S.toss + 24, -1.5, easeOut], [S.smash, -1.5], [S.smash + 6, -1.3], [S.smash + 12, -Math.PI / 2]], t);
  p.spin = tr([[0, 0], [S.toss + 24, 0], [S.rocket, Math.PI * 1.25, easeInOut], [S.smash + 12, TAU, easeOut]], t);
  p.lKnee = 0.3 * flail;
  p.rKnee = 0.3 * flail;
  p.glow = 0;
  p.stiff = { lHand: 40, rHand: 40, lFoot: 40, rFoot: 40, body: 36 };
}

// ===========================================================================
// Camera: the shots

interface ShotDef {
  to: number;
  pos?: (t: number) => V3;
  look?: (t: number) => V3;
  fov: number;
  pov?: 'attacker' | 'victim';
  visor?: boolean;
  beamWidth?: number;
}

/** Eased path through keyed points. */
function keys(list: readonly (readonly [number, V3])[]): (t: number) => V3 {
  if (list.length === 1) return () => list[0][1];
  return (t) => path(list.map(([k, p]) => [k, p, easeInOut] as const), t);
}

const smooth = (t: number, a: number, b: number): number => easeInOut(Math.min(1, Math.max(0, (t - a) / (b - a))));

function shots(d: number): ShotDef[] {
  // Where the bodies are (chest height; the victim lies flat once thrown).
  const aChest = (t: number): V3 => add(attackerOff(t), v(0, 1.35, 0.05));
  const vChest = (t: number): V3 => add(victimOff(t, d), v(0, 1.3 - 0.35 * smooth(t, S.toss + 4, S.toss + 20), -0.2));
  const mid = (t: number, k = 0.5): V3 => lerpV(aChest(t), vChest(t), k);
  return [
    // 1. The grab and the knee: low side close-up, pushing in.
    { to: S.toss, pos: keys([[0, v(2.1, 1.05, 0.15)], [S.toss, v(1.75, 1.12, 0.35)]]), look: keys([[0, v(0, 1.1, 0.42)], [S.toss, v(0, 1.15, 0.45)]]), fov: 47 },
    // 2. The toss: the camera cranes up after the body.
    { to: S.toss + 16, pos: keys([[S.toss, v(2.9, 0.6, -0.9)], [S.toss + 16, v(3.2, 1.5, -1.3)]]), look: (t) => mid(t, 0.45 + 0.4 * smooth(t, S.toss, S.toss + 16)), fov: 58 },
    // 3. Through the visor: the eyes charge on the body tumbling overhead.
    { to: S.toss + 26, fov: 70, pov: 'attacker', visor: true },
    // 4. Wide and low from the side: the column of the beam.
    { to: S.toss + 42, pos: keys([[S.toss + 26, v(-4.2, 0.5, 0.2)], [S.toss + 42, v(-3.8, 0.65, 1.3)]]), look: (t) => add(mid(t), v(0, 0.1, 0)), fov: 62 },
    // 5. Up close in the air: the body rolling over in the beam that comes up from below.
    {
      to: S.rocket,
      pos: (t) => {
        const a = (0.42 + 0.16 * smooth(t, S.toss + 42, S.rocket)) * Math.PI;
        return add(vChest(t), v(Math.sin(a) * 2.6, 0.35, Math.cos(a) * 2.6 - 0.2));
      },
      look: (t) => add(vChest(t), v(0, 0.1, 0)),
      fov: 56,
      beamWidth: 0.9,
    },
    // 6. At the floor: Cyclops rockets up past the lens.
    { to: S.rocket + 10, pos: keys([[S.rocket, v(1.2, 0.18, -1.1)]]), look: (t) => lerpV(v(0, 1.1, 0.1), aChest(t), smooth(t, S.rocket, S.rocket + 8)), fov: 76 },
    // 7. In the air: around both, the flip.
    {
      to: S.smash - 3,
      pos: (t) => {
        // From the side round to the front: Cyclops comes down toward the lens.
        const a = (0.55 - 0.35 * smooth(t, S.rocket + 10, S.smash - 3)) * Math.PI;
        return add(mid(t), v(Math.sin(a) * 3.4, 0.4, Math.cos(a) * 3.4));
      },
      look: (t) => mid(t),
      fov: 58,
    },
    // 8. Through the victim's eyes: the fists coming down.
    { to: S.smash + 1, fov: 82, pov: 'victim' },
    // 9. From above: both fall away from the lens into the crater.
    { to: S.end + 8, pos: keys([[S.smash + 1, v(1.0, 5.6, d + 0.4)], [S.end + 8, v(1.2, 4.9, d + 0.8)]]), look: keys([[S.smash + 1, v(0, 0.2, d * 0.75)]]), fov: 60 },
    // 10. The hero shot: the landing, low from the side, easing back.
    { to: SHOWCASE_LENGTH + 4, pos: keys([[S.end + 8, v(-2.0, 0.32, 0.55)], [SHOWCASE_LENGTH, v(-2.6, 0.55, 0.95)]]), look: keys([[S.end + 8, v(0, 0.75, 0.3)], [SHOWCASE_LENGTH, v(0, 0.9, 0.45)]]), fov: 46 },
  ];
}

/** Glow of the eyes behind the visor over the film. */
const eyesAt = (t: number): number =>
  tr([[0, 0.15], [S.toss + 12, 0.2], [S.toss + 26, 1, easeIn], [S.rocket - 2, 1], [S.rocket + 4, 0.5], [S.smash, 0.7], [S.end, 0.3], [S.end + 6, 1, easeOut], [S.end + 22, 0.35], [SHOWCASE_LENGTH, 0.15]], t);

// ===========================================================================

/** The film of Cyclops' showcase throw at scene frame `t` (fractional); `d` = victim distance. */
export function showcaseScene(t: number, d: number): SceneFrame {
  const list = shots(d);
  const k = list.find((s) => t < s.to) ?? list[list.length - 1];
  const shot: SceneShot = {
    pos: k.pos ? k.pos(t) : v(2, 1.5, 0),
    look: k.look ? k.look(t) : v(0, 1.2, d),
    fov: k.fov,
    pov: k.pov,
    visor: k.visor,
    beamWidth: k.beamWidth ?? 1.5,
  };
  const fists = t >= S.smash - 5 && t < S.smash + 1;
  return {
    attacker: {
      off: attackerOff(t),
      yaw: 0,
      pose: (p, b, time) => attackerPose(t, p, b, time),
      striking: fists ? ['lHand', 'rHand'] : [],
    },
    victim: t < S.end ? { off: victimOff(t, d), yaw: Math.PI, pose: (p, b, time) => victimPose(t, p, b, time), striking: [] } : null,
    shot,
    beam: t >= S.toss + 26 && t < S.rocket - 2,
    title: t < 110 ? 'ЦИКЛОП · НЕБЕСНЫЙ ЛУЧ' : null,
    eyes: eyesAt(t),
  };
}

/** Smooth 0..1 blend in and out of the film for the camera. */
export function sceneBlend(t: number): number {
  const a = Math.min(1, Math.max(0, t / 10));
  const b = Math.min(1, Math.max(0, (SHOWCASE_LENGTH + 4 - t) / 12));
  return easeInOut(Math.min(a, b));
}

/** Lerp of two scene points (re-exported for the game). */
export const mix = lerpV;
