/**
 * Cyclops' cards. The starter card: Optic Blast.
 *
 *   E               a beam from the visor: near-instant, goes exactly where you
 *                   look (also in the air). Parry sends it back.
 *   back + DODGE    instead of the backstep: a blast into the floor throws you
 *                   5-6 m back. Hurts nobody, it opens distance.
 *   E in that flight  fire straight out of the recoil (momentum carries on).
 *   back + DODGE in the air  one more recoil per jump (uses the air dash).
 */
import { Button } from '../../core/input';
import { DEG } from '../../core/math/vec3';
import type { HitDef, MoveDef } from '../../core/types';
import type { CardDef } from '.';

const { SPECIAL: E, DODGE } = Button;

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
