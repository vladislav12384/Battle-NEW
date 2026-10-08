/**
 * Cyclops' cards. They form a set: each can be played alone or together.
 *
 * Optic Blast (the starter):
 *
 *   E               a beam from the visor: near-instant, goes exactly where you
 *                   look (also in the air). Parry sends it back.
 *   back + DODGE    instead of the backstep: a blast into the floor throws you
 *                   5-6 m back. Hurts nobody, it opens distance.
 *   E in that flight  fire straight out of the recoil (momentum carries on).
 *   back + DODGE in the air  one more recoil per jump (uses the air dash).
 *
 * Ricochet:
 *   RMB + E         instead of the shoulder rush: a beam that bounces off walls,
 *                   pillars and the floor (3 times), harder with every bounce.
 *                   You aim it yourself; at each bounce it bends a little
 *                   toward an enemy close to its path.
 *   RMB + E with a super point (100 ki)  the visor computes the shot: a
 *                   path to the enemy wherever it stands, however many bounces
 *                   it takes. The hit sets it on fire. No path: the point is
 *                   kept and the plain ricochet comes out instead.
 *   RMB string      Cyclone (2nd), Point-Blank Optic (3rd), Gene Splice (4th).
 *
 * Mega Beam:
 *   E with a super point  instead of the Hundred Fists: a beam that keeps
 *                   firing while E is held (up to 2.5 s), swept with the view,
 *                   hitting everyone along it in pulses. It pushes back: on the
 *                   floor the feet slide, in the air it carries you (aim down at
 *                   someone and you rise: controlled flight, the stick steers).
 *   New animations  air spin kick (aerial tornado), air hammer (front-flip
 *                   smash), dive kick (meteor): same moves, new choreography.
 *   Grab, then LMB  the showcase throw: a cinematic scene (same film for both,
 *                   the camera directs itself): knee, toss, beam up through
 *                   the opponent, a rocket jump on the recoil, a flip smash
 *                   into the floor. RMB (or nothing): the usual quick throw.
 */
import { Button } from '../../core/input';
import { DEG } from '../../core/math/vec3';
import type { HitDef, MoveDef } from '../../core/types';
import { striker, STRIKER_TEMPO } from '../characters/striker';
import { sweep, tempo } from '../dsl';
import type { CardDef } from '.';

const { SPECIAL: E, DODGE, EX } = Button;

const opticHit: HitDef = {
  damage: 55,
  hitstun: 26,
  blockstun: 18,
  hitstop: 9,
  guardDamage: 24,
  knockback: { fwd: 5.5, up: 0 },
  airKnockback: { fwd: 4, up: 5 },
  effect: 'energy',
};

/** The beam: a very fast bolt fired from the eyes along the aim. */
const opticBlastMove: MoveDef = {
  id: 'optic_blast',
  name: 'Optic Blast',
  kind: 'special',
  anim: 'optic',
  vfx: 'optic',
  startup: 15,
  active: 4,
  recovery: 22,
  stamina: 14,
  lunge: 0,
  mobility: 0.15,
  turnRate: 7 * DEG,
  // Fired in the air (or out of a recoil) the body hangs and drifts.
  gravityScale: 0.3,
  hitboxes: [],
  projectiles: [{ frame: 16, offset: [0, 1.6, 0.3], speed: 60, radius: 0.22, lifetime: 22, hit: opticHit }],
};

/** Back + DODGE: a blast into the floor in front throws the body back in a low arc. */
const opticRecoil: MoveDef = {
  id: 'optic_recoil',
  name: 'Optic Recoil',
  kind: 'special',
  anim: 'opticRecoil',
  vfx: 'opticFloor',
  startup: 5,
  active: 3,
  recovery: 30,
  stamina: 20,
  lunge: 0,
  mobility: 0,
  fixedFacing: true,
  hitboxes: [],
  motion: [
    { frames: [6, 7], fwd: -10, up: 6 },
    { frames: [8, 35], fwd: -10 },
  ],
  cancels: [{ button: E, into: 'optic_blast', frames: [10, 36], on: 'always' }],
};

/** The same in the air: the beam goes down and ahead, the body is thrown back and up. */
const opticRecoilAir: MoveDef = {
  ...opticRecoil,
  id: 'optic_recoil_air',
  name: 'Optic Recoil (air)',
  air: true,
  usesAirDash: true,
  startup: 4,
  active: 3,
  recovery: 22,
  stamina: 16,
  landingLag: 6,
  motion: [
    { frames: [5, 6], fwd: -8.5, up: 6 },
    { frames: [7, 26], fwd: -8.5 },
  ],
  cancels: [{ button: E, into: 'optic_blast', frames: [8, 26], on: 'always' }],
};

export const opticBlast: CardDef = {
  id: 'optic_blast',
  name: 'Оптический выстрел',
  hero: 'Циклоп',
  rarity: 'common',
  color: 0xff3b30,
  lines: [
    '<kbd>E</kbd> — луч из визора: почти мгновенно и точно в прицел, в том числе в воздухе',
    '<kbd>S</kbd> + <kbd>Shift</kbd> — выстрел в пол: отлёт на 6 м назад. Без урона, рвёт дистанцию',
    'В полёте <kbd>E</kbd> — выстрел прямо из отлёта',
    'В прыжке — ещё один отлёт',
  ],
  hint: '<kbd>E</kbd> луч · <kbd>S</kbd>+<kbd>Shift</kbd> отлёт · в полёте <kbd>E</kbd>',
  flavor: 'Визор сдерживает силу взгляда. Сними его — и стены не устоят.',
  moves: [opticBlastMove, opticRecoil, opticRecoilAir],
  swap: { ki_blast: 'optic_blast', air_ki_blast: 'optic_blast' },
  commands: [
    { move: 'optic_recoil', button: DODGE, dir: 'back', air: false },
    { move: 'optic_recoil_air', button: DODGE, dir: 'back', air: true },
  ],
};

// ===========================================================================
// Ricochet

/** RMB + E: a bank shot. Aim it yourself, the bounce helps a little. */
const ricochetMove: MoveDef = {
  id: 'ricochet',
  name: 'Ricochet',
  kind: 'special',
  anim: 'opticBank',
  vfx: 'ricochet',
  startup: 17,
  active: 4,
  recovery: 24,
  stamina: 16,
  lunge: 0,
  mobility: 0.15,
  turnRate: 7 * DEG,
  gravityScale: 0.3,
  hitboxes: [],
  projectiles: [
    {
      frame: 18,
      offset: [0, 1.6, 0.3],
      speed: 46,
      radius: 0.2,
      lifetime: 50,
      bounces: 3,
      bounceAssist: { cone: 30, turn: 14 },
      bounceDamage: 0.3,
      hit: {
        damage: 40,
        hitstun: 26,
        blockstun: 16,
        hitstop: 9,
        guardDamage: 20,
        knockback: { fwd: 5, up: 0 },
        airKnockback: { fwd: 3.5, up: 5 },
        effect: 'energy',
      },
    },
  ],
};

/** RMB + E with a super point: the visor computes the bank shot and the beam sets the target on fire. */
const ricochetSuper: MoveDef = {
  id: 'ricochet_super',
  name: 'Calculated Ricochet (super)',
  kind: 'super',
  meterCost: 100,
  anim: 'opticCalc',
  vfx: 'ricochetSuper',
  autoAim: { maxBounces: 8 },
  // Leaves from the eyes exactly where the visor computed the shot from.
  pitchAim: false,
  startup: 22,
  active: 4,
  recovery: 26,
  lunge: 0,
  mobility: 0,
  gravityScale: 0.2,
  hitboxes: [],
  projectiles: [
    {
      frame: 23,
      offset: [0, 1.6, 0],
      speed: 52,
      radius: 0.24,
      lifetime: 80,
      bounces: 8,
      guided: true,
      hit: {
        damage: 95,
        hitstun: 40,
        blockstun: 20,
        hitstop: 16,
        guardDamage: 40,
        knockback: { fwd: 7, up: 6 },
        launch: true,
        wallSplat: true,
        parryable: false,
        effect: 'energy',
        minScaling: 0.5,
        burn: 180,
      },
    },
  ],
};

// ---------------------------------------------------------------- the power string (RMB)
// Authored at the Striker's base speed and re-timed with the same tempo, so
// they slot into the strings exactly where the moves they replace were.

/** 2nd in the string, instead of the roundhouse: a jumping, spinning hook kick. */
const cycloneKick: MoveDef = {
  id: 'cyclone_kick',
  anim: 'cyclone',
  vfx: 'cyclone',
  name: 'Cyclone Kick',
  kind: 'heavy',
  stamina: 18,
  family: 'cyclone',
  startup: 11,
  active: 3,
  recovery: 21,
  hitboxes: [
    sweep([12, 14], [0.85, 1.45, 0.0], [-0.45, 1.5, 1.0], 0.3, {
      damage: 64,
      hitstun: 27,
      blockstun: 15,
      hitstop: 12,
      guardDamage: 30,
      knockback: { fwd: 8.5, up: 3.5, side: -2 },
      wallSplat: true,
      effect: 'heavy',
    }, { limb: 'rFoot' }),
  ],
};

/** 3rd in the string, instead of the backfist: step in, palm to the visor, a blast in the face. */
const pointBlank: MoveDef = {
  id: 'point_blank',
  anim: 'pointBlank',
  vfx: 'opticPoint',
  name: 'Point-Blank Optic',
  kind: 'heavy',
  stamina: 20,
  family: 'optic',
  startup: 12,
  active: 3,
  recovery: 25,
  motion: [{ frames: [16, 22], fwd: -3 }],
  hitboxes: [
    sweep([13, 15], [0, 1.62, 0.25], [0, 1.55, 1.5], 0.38, {
      damage: 74,
      hitstun: 30,
      blockstun: 16,
      hitstop: 13,
      guardDamage: 34,
      knockback: { fwd: 9, up: 4.5 },
      wallBounce: true,
      effect: 'energy',
    }, { limb: 'head' }),
  ],
};

/** 4th in the string, instead of the rising uppercut: a jumping uppercut wrapped in ruby energy. */
const geneSplice: MoveDef = {
  id: 'gene_splice',
  anim: 'geneSplice',
  vfx: 'geneSplice',
  name: 'Gene Splice (launcher)',
  kind: 'heavy',
  stamina: 16,
  hand: 'right',
  family: 'launcher',
  startup: 9,
  active: 3,
  recovery: 22,
  hitboxes: [
    sweep([10, 12], [0.1, 0.8, 0.55], [0.05, 2.1, 0.5], 0.27, {
      damage: 60,
      hitstun: 36,
      blockstun: 15,
      hitstop: 11,
      knockback: { fwd: 1, up: 13 },
      launch: true,
      juggleCost: 2,
      effect: 'launch',
    }, { limb: 'rHand' }),
  ],
  jumpCancel: { frames: [13, 30], on: 'hit', high: true },
};

export const ricochet: CardDef = {
  id: 'ricochet',
  name: 'Рикошет',
  hero: 'Циклоп',
  rarity: 'rare',
  color: 0xffb21e,
  lines: [
    '<kbd>ПКМ</kbd>+<kbd>E</kbd> — рикошет вместо тарана: до 3 отскоков, каждый +30% урона. Целишься сам, на отскоке луч чуть доворачивает к врагу',
    'С очком супера визор сам ведёт луч к врагу, где бы он ни был, и <b>поджигает</b>. Нет пути — очко не тратится',
    '<kbd>ПКМ</kbd> в серии: «Циклон», «Выстрел в упор», «Генный сплайс»',
  ],
  hint: '<kbd>ПКМ</kbd>+<kbd>E</kbd> рикошет · с очком супера — сам наводится',
  flavor: 'Угол падения равен углу отражения.',
  moves: [ricochetMove, ricochetSuper, ...[cycloneKick, pointBlank, geneSplice].map((m) => tempo(m, STRIKER_TEMPO))],
  swap: {
    shoulder_rush: 'ricochet',
    roundhouse_r: 'cyclone_kick',
    spin_backfist: 'point_blank',
    rising_uppercut: 'gene_splice',
  },
  commands: [
    { move: 'ricochet_super', button: EX },
    { move: 'ricochet', button: EX },
  ],
};

// ===========================================================================
// Mega Beam

const megaBeamMove: MoveDef = {
  id: 'mega_beam',
  name: 'Mega Optic Beam (super)',
  kind: 'super',
  meterCost: 100,
  anim: 'megaBeam',
  vfx: 'megaBeam',
  startup: 16,
  active: 2,
  recovery: 26,
  lunge: 0,
  mobility: 0,
  turnRate: 9 * DEG,
  landingLag: 10,
  invuln: [{ frames: [1, 10], kind: 'strike' }],
  hitboxes: [],
  beam: {
    frame: 17,
    button: E,
    minFrames: 30,
    maxFrames: 150,
    offset: [0, 1.6, 0.25],
    length: 28,
    radius: 0.32,
    every: 8,
    hit: {
      damage: 20,
      chip: 2,
      guardDamage: 9,
      hitstun: 14,
      blockstun: 12,
      hitstop: 3,
      knockback: { fwd: 2.6, up: 0 },
      airKnockback: { fwd: 2, up: 3.4 },
      parryable: false,
      effect: 'energy',
      minScaling: 0.5,
    },
    thrust: 30,
    groundThrust: 0.4,
    airRecoil: 0.45,
    lift: 0.7,
    maxSpeed: 9,
    ceiling: 6.5,
    turnRate: 3.2 * DEG,
  },
};

/** Cyclops' showcase throw: knee, toss, beam, rocket jump, flip smash. Timings shared with the client's scene. */
export const SHOWCASE = {
  knee: 14,
  toss: 22,
  beam: [52, 62, 72],
  rocket: 82,
  smash: 104,
  end: 124,
} as const;

const showcaseFinal: HitDef = {
  damage: 70,
  hitstun: 40,
  blockstun: 0,
  hitstop: 14,
  knockback: { fwd: 2.2, up: 1.4 },
  launch: true,
  knockdown: true,
  hardKnockdown: true,
  effect: 'throw',
};

const showcaseThrow: MoveDef = {
  id: 'cyclops_showcase',
  name: 'Optic Showcase (throw)',
  kind: 'throw',
  vfx: 'showcase',
  startup: 1,
  active: 1,
  recovery: 1,
  hitboxes: [],
  throw: {
    hit: showcaseFinal,
    recovery: 36,
    cinematic: {
      frames: SHOWCASE.end,
      beats: [
        { frame: SHOWCASE.knee, damage: 16 },
        ...SHOWCASE.beam.map((frame) => ({ frame, damage: 12 })),
      ],
    },
  },
};

/** The grab, with LMB during the hold leading to the showcase throw. */
const cyclopsGrab: MoveDef = {
  ...striker.moves.grab,
  id: 'grab_cyclops',
  throw: { ...striker.moves.grab.throw!, alt: 'cyclops_showcase' },
};

export const megaBeam: CardDef = {
  id: 'mega_beam',
  name: 'Мега-луч',
  hero: 'Циклоп',
  rarity: 'rare',
  color: 0x3b82f6,
  lines: [
    'Очко супера — держи <kbd>E</kbd>: вместо «Ста кулаков» сплошной луч до 2.5 с, ведёшь его взглядом, бьёт всех на линии',
    'Луч толкает назад. В прыжке стреляй вниз по врагу — и лети: управляемый полёт, <kbd>WASD</kbd> рулит',
    'Новые анимации в воздухе: вертушка, молот вниз, удар в пике',
    'Захват, затем <kbd>ЛКМ</kbd> — показательный бросок с кинокамерой; <kbd>ПКМ</kbd> — быстрый',
  ],
  hint: 'держи <kbd>E</kbd> с очком супера — луч и полёт',
  flavor: 'Отдача — тоже оружие.',
  moves: [megaBeamMove, cyclopsGrab, showcaseThrow],
  swap: { barrage: 'mega_beam', grab: 'grab_cyclops' },
  commands: [{ move: 'mega_beam', button: E, air: true }],
  restyle: {
    air_spin: { anim: 'airTornado', vfx: 'airTornado' },
    air_hammer: { anim: 'flipHammer', vfx: 'flipHammer' },
    dive_kick: { anim: 'meteor', vfx: 'meteor' },
  },
};
