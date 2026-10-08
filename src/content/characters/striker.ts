/**
 * "Striker" — the reference martial artist used to build and tune the combat
 * system. Every system mechanic is exercised by at least one of these moves,
 * so future characters (anime heroes, superheroes...) can copy patterns here.
 *
 * Controls are directional and free-form: the strike you get depends on the
 * button (punch / power / kick), the look flick at the press (none / left /
 * right / up / down) and the stick. Any light or heavy strike chains into any
 * other right after its active frames ("flow"), so combos are composed by the
 * player, not pre-scripted. Variety matters: repeating the same family in a
 * combo goes stale (less hitstun and damage).
 *
 * True-combo math (see docs/COMBAT_DESIGN.md): chaining out of a strike with
 * `active` frames into one with startup `s` at the earliest flow frame is a
 * true combo when  active + s <= hitstun.  All lights here have hitstun >= 16
 * so every chain from a clean hit is guaranteed when timed early.
 */
import { Button } from '../../core/input';
import { DEG } from '../../core/math/vec3';
import type { CharacterDef, HitDef, MoveDef } from '../../core/types';
import { box, mirror, moveList, sweep, type TempoScale, tempoMoves } from '../dsl';

const { LIGHT: L, HEAVY: H, SPECIAL: E, SUPER: R, GRAB: G, KICK: K } = Button;

/**
 * Global pacing of the character. Moves below are authored at "arcade" speed
 * and re-timed here: slower wind-ups and recoveries make every strike a
 * readable commitment, longer stun keeps chains intact, longer hit stop gives
 * impacts weight.
 */
export const STRIKER_TEMPO: TempoScale = {
  startup: 1.6,
  active: 1.3,
  recovery: 1.45,
  hitstun: 1.5,
  blockstun: 1.4,
  hitstop: 1.35,
  landingLag: 1.3,
};

/** Keeps an airborne victim floating during air strings. */
const FLOAT = { fwd: 1, up: 5.2 };

const barrageHit = (hand: 'lHand' | 'rHand', group: number, f0: number) =>
  box(
    [f0, f0 + 1],
    [hand === 'lHand' ? -0.1 : 0.1, 1.45, 0.85],
    0.32,
    {
      damage: 30,
      hitstun: 22,
      blockstun: 12,
      hitstop: 4,
      knockback: { fwd: 0.6, up: 0 },
      airKnockback: { fwd: 0.4, up: 3.2 },
      parryable: false,
      juggleCost: 0,
      effect: 'medium',
      minScaling: 0.5,
    },
    { group, limb: hand },
  );

const throwHit: HitDef = {
  damage: 110,
  hitstun: 40,
  blockstun: 0,
  hitstop: 10,
  knockback: { fwd: 7, up: 6.5 },
  launch: true,
  hardKnockdown: true,
  wallSplat: true,
  effect: 'throw',
};

// ---------------------------------------------------------------- punches (LMB)

const jab: MoveDef = {
  id: 'jab',
  name: 'Jab',
  kind: 'light',
  stamina: 7,
  hand: 'left',
  family: 'straight',
  startup: 5,
  active: 2,
  recovery: 10,
  hitboxes: [
    sweep([6, 7], [-0.12, 1.45, 0.3], [-0.08, 1.45, 0.82], 0.18, {
      damage: 26,
      hitstun: 16,
      blockstun: 11,
      hitstop: 6,
      knockback: { fwd: 3, up: 0 },
      airKnockback: FLOAT,
      effect: 'light',
    }, { limb: 'lHand' }),
  ],
};

const cross: MoveDef = {
  id: 'cross',
  name: 'Cross',
  kind: 'light',
  stamina: 8,
  hand: 'right',
  family: 'straight',
  startup: 6,
  active: 2,
  recovery: 11,
  hitboxes: [
    sweep([7, 8], [0.12, 1.45, 0.28], [0.05, 1.45, 0.88], 0.19, {
      damage: 30,
      hitstun: 17,
      blockstun: 12,
      hitstop: 7,
      knockback: { fwd: 3.5, up: 0 },
      airKnockback: { fwd: 1.2, up: 4.6 },
      effect: 'light',
    }, { limb: 'rHand' }),
  ],
};

/** Left hook: flick the view RIGHT and the fist sweeps across from the left. */
const hookL: MoveDef = {
  id: 'hook_l',
  name: 'Left Hook',
  kind: 'light',
  stamina: 10,
  hand: 'left',
  family: 'hook',
  startup: 7,
  active: 3,
  recovery: 13,
  hitboxes: [
    sweep([8, 10], [-0.62, 1.47, 0.28], [0.28, 1.45, 0.72], 0.21, {
      damage: 34,
      hitstun: 19,
      blockstun: 13,
      hitstop: 8,
      knockback: { fwd: 1.5, up: 0, side: 2.5 },
      airKnockback: { fwd: 1, up: 4.6, side: 2 },
      effect: 'medium',
    }, { limb: 'lHand' }),
  ],
};

const uppercut: MoveDef = {
  id: 'uppercut',
  name: 'Uppercut',
  kind: 'light',
  stamina: 10,
  hand: 'right',
  family: 'uppercut',
  startup: 7,
  active: 3,
  recovery: 14,
  hitboxes: [
    sweep([8, 10], [0.12, 1.0, 0.48], [0.06, 1.8, 0.55], 0.22, {
      damage: 32,
      hitstun: 24,
      blockstun: 13,
      hitstop: 8,
      knockback: { fwd: 0.8, up: 6 },
      airKnockback: { fwd: 0.6, up: 7 },
      effect: 'launch',
    }, { limb: 'rHand' }),
  ],
};

const bodyBlow: MoveDef = {
  id: 'body_blow',
  name: 'Body Blow',
  kind: 'light',
  stamina: 10,
  hand: 'left',
  family: 'body',
  startup: 7,
  active: 3,
  recovery: 13,
  pitchAim: false,
  hitboxes: [
    sweep([8, 10], [-0.15, 1.0, 0.3], [-0.05, 1.0, 0.74], 0.23, {
      damage: 30,
      hitstun: 19,
      blockstun: 14,
      hitstop: 8,
      guardDamage: 24,
      knockback: { fwd: 2, up: 0 },
      airKnockback: FLOAT,
      counter: { crumple: 45, hitstop: 14 },
      effect: 'medium',
    }, { limb: 'lHand' }),
  ],
};

// ---------------------------------------------------------------- power (RMB)

const haymaker: MoveDef = {
  id: 'haymaker',
  name: 'Haymaker (hold to charge)',
  kind: 'heavy',
  stamina: 20,
  hand: 'right',
  family: 'power',
  startup: 14,
  active: 3,
  recovery: 22,
  hitboxes: [
    sweep([15, 17], [0.15, 1.5, 0.2], [0.05, 1.45, 1.0], 0.26, {
      damage: 85,
      hitstun: 24,
      blockstun: 18,
      hitstop: 11,
      guardDamage: 30,
      knockback: { fwd: 6, up: 0 },
      airKnockback: { fwd: 5, up: 4 },
      counter: { crumple: 55, hitstop: 16 },
      effect: 'heavy',
    }, { limb: 'rHand' }),
  ],
  charge: {
    frame: 7,
    button: H,
    maxFrames: 45,
    fullAt: 35,
    damageBonus: 0.6,
    fullHit: { unblockable: true, knockback: { fwd: 14, up: 3 }, wallSplat: true, hitstop: 18 },
  },
};

const backfist: MoveDef = {
  id: 'spin_backfist',
  name: 'Spinning Backfist',
  kind: 'heavy',
  stamina: 18,
  hand: 'left',
  family: 'backfist',
  startup: 12,
  active: 3,
  recovery: 24,
  hitboxes: [
    sweep([13, 15], [0.55, 1.5, -0.1], [-0.45, 1.5, 0.75], 0.26, {
      damage: 70,
      hitstun: 30,
      blockstun: 16,
      hitstop: 12,
      knockback: { fwd: 8, up: 4.5 },
      wallBounce: true,
      effect: 'heavy',
    }, { limb: 'lHand' }),
  ],
};

const launcher: MoveDef = {
  id: 'rising_uppercut',
  name: 'Rising Uppercut (launcher)',
  kind: 'heavy',
  stamina: 16,
  hand: 'right',
  family: 'launcher',
  startup: 9,
  active: 3,
  recovery: 22,
  hitboxes: [
    sweep([10, 12], [0.1, 0.9, 0.55], [0.05, 1.95, 0.5], 0.24, {
      damage: 55,
      hitstun: 36,
      blockstun: 15,
      hitstop: 10,
      knockback: { fwd: 1, up: 12.5 },
      launch: true,
      juggleCost: 2,
      effect: 'launch',
    }, { limb: 'rHand' }),
  ],
  jumpCancel: { frames: [13, 30], on: 'hit', high: true },
};

const hammer: MoveDef = {
  id: 'hammer',
  name: 'Hammer Fist',
  kind: 'heavy',
  stamina: 18,
  hand: 'right',
  family: 'hammer',
  startup: 12,
  active: 3,
  recovery: 22,
  hitboxes: [
    sweep([13, 15], [0.1, 2.0, 0.55], [0.05, 0.8, 0.8], 0.26, {
      damage: 70,
      hitstun: 40,
      blockstun: 18,
      hitstop: 12,
      guardDamage: 30,
      knockback: { fwd: 1, up: -8 },
      groundBounce: true,
      juggleCost: 2,
      effect: 'spike',
    }, { limb: 'rHand' }),
  ],
};

const dashStraight: MoveDef = {
  id: 'dash_straight',
  name: 'Dash Straight',
  kind: 'heavy',
  stamina: 20,
  hand: 'right',
  family: 'dash',
  startup: 14,
  active: 4,
  recovery: 24,
  lunge: 0,
  mobility: 0,
  turnRate: 6 * DEG,
  motion: [{ frames: [3, 18], fwd: 10 }],
  hitboxes: [
    sweep([15, 18], [0.1, 1.45, 0.3], [0.05, 1.45, 1.05], 0.3, {
      damage: 90,
      hitstun: 28,
      blockstun: 17,
      hitstop: 13,
      guardDamage: 40,
      knockback: { fwd: 12, up: 2.5 },
      wallSplat: true,
      effect: 'heavy',
    }, { limb: 'rHand' }),
  ],
};

// ---------------------------------------------------------------- kicks (Q)

const teep: MoveDef = {
  id: 'teep',
  name: 'Push Kick',
  kind: 'light',
  stamina: 12,
  family: 'teep',
  priority: 2,
  startup: 9,
  active: 3,
  recovery: 16,
  mobility: 0.2,
  hitboxes: [
    sweep([10, 12], [0.08, 0.95, 0.25], [0.05, 1.1, 1.05], 0.25, {
      damage: 40,
      hitstun: 20,
      blockstun: 15,
      hitstop: 9,
      guardDamage: 26,
      knockback: { fwd: 8, up: 0 },
      airKnockback: { fwd: 6, up: 3 },
      blockPush: 6,
      effect: 'medium',
    }, { limb: 'rFoot' }),
  ],
};

/** Right roundhouse: flick the view LEFT and the leg sweeps right-to-left. */
const roundhouseR: MoveDef = {
  id: 'roundhouse_r',
  name: 'Roundhouse (right leg)',
  kind: 'heavy',
  stamina: 18,
  family: 'roundhouse',
  startup: 11,
  active: 3,
  recovery: 20,
  hitboxes: [
    sweep([12, 14], [0.75, 1.2, 0.05], [-0.35, 1.35, 0.95], 0.26, {
      damage: 58,
      hitstun: 26,
      blockstun: 15,
      hitstop: 11,
      guardDamage: 28,
      knockback: { fwd: 8, up: 3, side: -2 },
      wallSplat: true,
      effect: 'heavy',
    }, { limb: 'rFoot' }),
  ],
};

const highKick: MoveDef = {
  id: 'high_kick',
  name: 'Rising High Kick (launcher)',
  kind: 'heavy',
  stamina: 18,
  family: 'highkick',
  startup: 10,
  active: 3,
  recovery: 22,
  hitboxes: [
    sweep([11, 13], [0.1, 0.6, 0.45], [0.05, 2.05, 0.6], 0.26, {
      damage: 48,
      hitstun: 32,
      blockstun: 14,
      hitstop: 10,
      knockback: { fwd: 1.5, up: 11 },
      launch: true,
      juggleCost: 2,
      effect: 'launch',
    }, { limb: 'rFoot' }),
  ],
  jumpCancel: { frames: [14, 30], on: 'hit', high: true },
};

const heelAxe: MoveDef = {
  id: 'heel_axe',
  name: 'Axe Kick (overhead)',
  kind: 'heavy',
  stamina: 20,
  family: 'axe',
  startup: 13,
  active: 4,
  recovery: 22,
  hitboxes: [
    sweep([14, 17], [0.1, 2.15, 0.55], [0.05, 0.55, 0.8], 0.28, {
      damage: 62,
      hitstun: 34,
      blockstun: 18,
      hitstop: 12,
      guardDamage: 40,
      knockback: { fwd: 1, up: -10 },
      groundBounce: true,
      juggleCost: 2,
      effect: 'spike',
    }, { limb: 'rFoot' }),
  ],
};

const legSweep: MoveDef = {
  id: 'sweep',
  name: 'Leg Sweep',
  kind: 'light',
  stamina: 12,
  family: 'sweep',
  startup: 8,
  active: 4,
  recovery: 22,
  pitchAim: false,
  lunge: 0.7,
  mobility: 0,
  hitboxes: [
    sweep([9, 12], [0.7, 0.15, 0.3], [-0.3, 0.15, 1.0], 0.28, {
      damage: 38,
      hitstun: 30,
      blockstun: 14,
      hitstop: 9,
      knockback: { fwd: 2, up: 3 },
      knockdown: true,
      effect: 'medium',
    }, { limb: 'rFoot' }),
  ],
};

const stomp: MoveDef = {
  id: 'stomp',
  name: 'Stomp (on a downed opponent)',
  kind: 'light',
  stamina: 8,
  family: 'stomp',
  startup: 8,
  active: 3,
  recovery: 18,
  pitchAim: false,
  hitboxes: [
    sweep([9, 11], [0.05, 0.9, 0.55], [0.05, 0.12, 0.6], 0.3, {
      damage: 45,
      hitstun: 26,
      blockstun: 10,
      hitstop: 10,
      knockback: { fwd: 1, up: 2.5 },
      effect: 'spike',
    }, { limb: 'rFoot' }),
  ],
};

const flyingKnee: MoveDef = {
  id: 'flying_knee',
  name: 'Flying Knee',
  kind: 'heavy',
  stamina: 20,
  family: 'knee',
  startup: 10,
  active: 6,
  recovery: 22,
  lunge: 0,
  mobility: 0,
  motion: [
    { frames: [1, 2], fwd: 9 },
    { frames: [3, 3], fwd: 9, up: 4 },
    { frames: [4, 16], fwd: 9 },
  ],
  hitboxes: [
    box([11, 16], [0.1, 1.2, 0.6], 0.3, {
      damage: 75,
      hitstun: 26,
      blockstun: 16,
      hitstop: 12,
      knockback: { fwd: 9, up: 5 },
      wallSplat: true,
      effect: 'heavy',
    }, { limb: 'rFoot' }),
  ],
};

// ---------------------------------------------------------------- aerials

const airJab: MoveDef = {
  id: 'air_jab',
  name: 'Air Jab',
  kind: 'light',
  stamina: 6,
  hand: 'left',
  family: 'airstraight',
  air: true,
  startup: 5,
  active: 3,
  recovery: 12,
  gravityScale: 0.15,
  landingLag: 6,
  hitboxes: [
    sweep([6, 8], [-0.1, 1.4, 0.35], [-0.05, 1.35, 0.85], 0.22, {
      damage: 26,
      hitstun: 22,
      blockstun: 12,
      hitstop: 6,
      knockback: { fwd: 1.5, up: 0 },
      airKnockback: { fwd: 0.8, up: 4.8 },
      attackerStall: 2.5,
      effect: 'light',
    }, { limb: 'lHand' }),
  ],
};

const airUpper: MoveDef = {
  id: 'air_upper',
  name: 'Air Uppercut',
  kind: 'light',
  stamina: 9,
  hand: 'right',
  family: 'airupper',
  air: true,
  startup: 6,
  active: 3,
  recovery: 14,
  gravityScale: 0.15,
  landingLag: 6,
  hitboxes: [
    sweep([7, 9], [0.1, 1.1, 0.45], [0.05, 1.85, 0.5], 0.23, {
      damage: 30,
      hitstun: 24,
      blockstun: 12,
      hitstop: 7,
      knockback: { fwd: 1, up: 3 },
      airKnockback: { fwd: 0.5, up: 7.5 },
      attackerStall: 4.5,
      effect: 'launch',
    }, { limb: 'rHand' }),
  ],
};

const airHammer: MoveDef = {
  id: 'air_hammer',
  name: 'Air Hammer (spike)',
  kind: 'light',
  stamina: 10,
  hand: 'right',
  family: 'airhammer',
  air: true,
  startup: 9,
  active: 3,
  recovery: 14,
  gravityScale: 0.2,
  landingLag: 8,
  hitboxes: [
    sweep([10, 12], [0.1, 1.9, 0.5], [0.05, 0.9, 0.7], 0.25, {
      damage: 40,
      hitstun: 30,
      blockstun: 14,
      hitstop: 10,
      knockback: { fwd: 1, up: -9 },
      airKnockback: { fwd: 1, up: -12 },
      groundBounce: true,
      juggleCost: 2,
      effect: 'spike',
    }, { limb: 'rHand' }),
  ],
};

const axeKick: MoveDef = {
  id: 'axe_kick',
  name: 'Air Axe Kick (spike)',
  kind: 'heavy',
  stamina: 16,
  family: 'axe',
  air: true,
  startup: 11,
  active: 5,
  recovery: 18,
  gravityScale: 0.3,
  landingLag: 10,
  hitboxes: [
    sweep([12, 16], [0.1, 2.1, 0.5], [0.05, 0.5, 0.75], 0.28, {
      damage: 70,
      hitstun: 34,
      blockstun: 18,
      hitstop: 12,
      knockback: { fwd: 1, up: -14 },
      airKnockback: { fwd: 1.5, up: -16 },
      groundBounce: true,
      juggleCost: 2,
      effect: 'spike',
    }, { limb: 'rFoot' }),
  ],
};

const airSpin: MoveDef = {
  id: 'air_spin',
  name: 'Air Spin Kick',
  kind: 'light',
  stamina: 12,
  family: 'airspin',
  priority: 2,
  air: true,
  startup: 8,
  active: 4,
  recovery: 16,
  gravityScale: 0.2,
  landingLag: 8,
  hitboxes: [
    sweep([9, 12], [0.6, 1.1, 0.0], [-0.5, 1.2, 0.7], 0.26, {
      damage: 40,
      hitstun: 26,
      blockstun: 14,
      hitstop: 10,
      knockback: { fwd: 8, up: 3 },
      airKnockback: { fwd: 8, up: 3.5 },
      attackerStall: 1,
      wallSplat: true,
      effect: 'heavy',
    }, { limb: 'rFoot' }),
  ],
};

const diveKick: MoveDef = {
  id: 'dive_kick',
  name: 'Dive Kick',
  kind: 'light',
  stamina: 12,
  family: 'dive',
  air: true,
  startup: 6,
  active: 12,
  recovery: 14,
  lunge: 0,
  landingLag: 8,
  motion: [{ frames: [6, 17], fwd: 9, up: -10 }],
  hitboxes: [
    box([7, 18], [0.05, 0.4, 0.55], 0.3, {
      damage: 45,
      hitstun: 24,
      blockstun: 14,
      hitstop: 10,
      knockback: { fwd: 6, up: 2 },
      attackerStall: 5,
      effect: 'heavy',
    }, { limb: 'rFoot' }),
  ],
};

export const striker: CharacterDef = {
  id: 'striker',
  name: 'Striker',
  color: 0x3d7bfd,
  stats: {
    maxHealth: 1000,
    maxStamina: 100,
    weight: 1,
    radius: 0.35,
    height: 1.8,
    eyeHeight: 1.65,
    walkSpeed: 3.4,
    runSpeed: 6.6,
    blockWalkSpeed: 1.3,
    jumpVelocity: 9,
    airJumps: 1,
    gravity: 24,
    maxFallSpeed: 26,
    airSpeed: 4,
    groundAccel: 38,
    airAccel: 13,
  },

  // First match wins: most specific first.
  commands: [
    { move: 'barrage', button: R, air: false },
    { move: 'grab', button: G, air: false },

    { move: 'shoulder_rush', button: E, dir: 'forward', air: false },
    { move: 'rising_dragon', button: E, dir: 'back', air: false },
    { move: 'ki_blast', button: E, air: false },
    { move: 'air_ki_blast', button: E, air: true },

    { move: 'dash_straight', button: H, running: true, air: false },
    { move: 'rising_uppercut', button: H, swipe: 'up', air: false },
    { move: 'hammer', button: H, swipe: 'down', air: false },
    { move: 'spin_backfist', button: H, swipe: 'left', air: false },
    { move: 'spin_backfist', button: H, swipe: 'right', air: false },
    { move: 'haymaker', button: H, air: false },
    { move: 'axe_kick', button: H, air: true },

    { move: 'stomp', button: K, context: 'targetDown', air: false },
    { move: 'flying_knee', button: K, running: true, air: false },
    { move: 'sweep', button: K, dir: 'back', air: false },
    { move: 'high_kick', button: K, swipe: 'up', air: false },
    { move: 'heel_axe', button: K, swipe: 'down', air: false },
    { move: 'roundhouse_r', button: K, swipe: 'left', air: false },
    { move: 'roundhouse_l', button: K, swipe: 'right', air: false },
    { move: 'teep', button: K, air: false },
    { move: 'dive_kick', button: K, swipe: 'down', air: true },
    { move: 'dive_kick', button: K, dir: 'back', air: true },
    { move: 'air_spin', button: K, air: true },

    { move: 'uppercut', button: L, swipe: 'up', air: false },
    { move: 'body_blow', button: L, swipe: 'down', air: false },
    { move: 'hook_r', button: L, swipe: 'left', air: false },
    { move: 'hook_l', button: L, swipe: 'right', air: false },
    { move: 'cross', button: L, afterHand: 'left', air: false },
    { move: 'jab', button: L, air: false },
    { move: 'air_upper', button: L, swipe: 'up', air: true },
    { move: 'air_hammer', button: L, swipe: 'down', air: true },
    { move: 'air_cross', button: L, afterHand: 'left', air: true },
    { move: 'air_jab', button: L, air: true },
  ],

  moves: tempoMoves(moveList([
    jab,
    cross,
    hookL,
    mirror(hookL, 'hook_r', 'Right Hook'),
    uppercut,
    bodyBlow,
    haymaker,
    backfist,
    launcher,
    hammer,
    dashStraight,
    teep,
    roundhouseR,
    mirror(roundhouseR, 'roundhouse_l', 'Roundhouse (left leg)'),
    highKick,
    heelAxe,
    legSweep,
    stomp,
    flyingKnee,
    airJab,
    mirror(airJab, 'air_cross', 'Air Cross'),
    airUpper,
    airHammer,
    axeKick,
    airSpin,
    diveKick,

    // ------------------------------------------------------------ specials
    {
      id: 'ki_blast',
      name: 'Ki Blast',
      kind: 'special',
      startup: 13,
      active: 2,
      recovery: 20,
      lunge: 0,
      hitboxes: [],
      projectiles: [
        {
          frame: 14,
          offset: [0.1, 1.4, 0.6],
          speed: 20,
          radius: 0.28,
          lifetime: 60,
          hit: {
            damage: 45,
            hitstun: 20,
            blockstun: 15,
            hitstop: 6,
            knockback: { fwd: 2.5, up: 0 },
            airKnockback: { fwd: 2, up: 4 },
            effect: 'energy',
          },
        },
      ],
    },
    {
      id: 'air_ki_blast',
      name: 'Air Ki Blast',
      kind: 'special',
      air: true,
      startup: 12,
      active: 2,
      recovery: 18,
      lunge: 0,
      gravityScale: 0.1,
      landingLag: 8,
      hitboxes: [],
      projectiles: [
        {
          frame: 13,
          offset: [0.1, 1.3, 0.6],
          pitchOffset: -25,
          speed: 20,
          radius: 0.28,
          lifetime: 50,
          hit: {
            damage: 40,
            hitstun: 20,
            blockstun: 14,
            hitstop: 6,
            knockback: { fwd: 2, up: 0 },
            airKnockback: { fwd: 1.5, up: 3 },
            effect: 'energy',
          },
        },
      ],
    },
    {
      id: 'shoulder_rush',
      name: 'Shoulder Rush (armored)',
      kind: 'special',
      stamina: 18,
      priority: 3,
      startup: 12,
      active: 10,
      recovery: 20,
      lunge: 0,
      mobility: 0,
      armor: { frames: [3, 22], hits: 1 },
      motion: [{ frames: [8, 22], fwd: 12 }],
      hitboxes: [
        box([13, 22], [0, 1.2, 0.55], 0.45, {
          damage: 80,
          hitstun: 26,
          blockstun: 18,
          hitstop: 12,
          guardDamage: 45,
          knockback: { fwd: 11, up: 3 },
          wallSplat: true,
          effect: 'heavy',
        }, { limb: 'body' }),
      ],
    },
    {
      id: 'rising_dragon',
      name: 'Rising Dragon (invincible reversal)',
      kind: 'special',
      stamina: 20,
      startup: 4,
      active: 9,
      recovery: 28,
      lunge: 0.8,
      mobility: 0,
      invuln: [{ frames: [1, 9], kind: 'strike' }],
      motion: [{ frames: [5, 12], fwd: 2, up: 10 }],
      endHelpless: true,
      landingLag: 16,
      hitboxes: [
        sweep([5, 7], [0.1, 1.0, 0.5], [0.1, 1.9, 0.5], 0.3, {
          damage: 45,
          hitstun: 30,
          blockstun: 14,
          hitstop: 8,
          knockback: { fwd: 1, up: 11 },
          launch: true,
          effect: 'launch',
        }, { group: 0, limb: 'rHand' }),
        box([9, 13], [0.1, 2.1, 0.45], 0.32, {
          damage: 55,
          hitstun: 30,
          blockstun: 14,
          hitstop: 12,
          knockback: { fwd: 3, up: 9 },
          launch: true,
          hardKnockdown: true,
          effect: 'heavy',
        }, { group: 1, limb: 'rHand' }),
      ],
    },

    // ------------------------------------------------------------ super
    {
      id: 'barrage',
      name: 'Hundred Fists (super)',
      kind: 'super',
      meterCost: 100,
      startup: 8,
      active: 32,
      recovery: 24,
      lunge: 4,
      minScaling: 0.5,
      invuln: [{ frames: [1, 12], kind: 'strike' }],
      motion: [{ frames: [9, 34], fwd: 1.5 }],
      hitboxes: [
        barrageHit('lHand', 0, 9),
        barrageHit('rHand', 1, 13),
        barrageHit('lHand', 2, 17),
        barrageHit('rHand', 3, 21),
        barrageHit('lHand', 4, 25),
        barrageHit('rHand', 5, 29),
        sweep([36, 40], [0.1, 1.3, 0.3], [0.1, 1.6, 1.1], 0.35, {
          damage: 160,
          hitstun: 40,
          blockstun: 20,
          hitstop: 18,
          knockback: { fwd: 14, up: 6 },
          wallSplat: true,
          hardKnockdown: true,
          parryable: false,
          effect: 'heavy',
          minScaling: 0.5,
        }, { group: 6, limb: 'rHand' }),
      ],
    },

    // ------------------------------------------------------------ throw
    {
      id: 'grab',
      name: 'Grab',
      kind: 'throw',
      startup: 6,
      active: 3,
      recovery: 26,
      hitboxes: [box([7, 9], [0, 1.2, 0.55], 0.35, throwHit, { throw: true, limb: 'rHand' })],
      throw: { hit: throwHit, recovery: 20 },
    },
  ]), STRIKER_TEMPO),
};
