import { DEG } from './math/vec3';

/** Simulation tick rate. All frame data in the game is expressed in these ticks. */
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

/**
 * Global combat rules shared by every character.
 * Character-specific numbers live in CharacterStats / MoveDef.
 * Everything here is a design knob — tweak freely, the tests document intent.
 */
export const RULES = {
  /** How long (frames) a button press stays buffered waiting to be used. */
  inputBuffer: 8,

  // ---------------------------------------------------------------- movement
  jumpSquat: 3,
  /** Landing lag after a normal jump. */
  landingLag: 3,
  /** Default landing lag when an aerial attack is interrupted by the ground. */
  airAttackLandingLag: 8,
  /** Vertical velocity of a "launcher jump" (jump-cancel after a launcher hits). */
  highJumpVelocity: 13,

  // ---------------------------------------------------------------- aiming
  lockOnRange: 25,
  lockOnCone: 60 * DEG,
  /** Max turn speed toward a lock-on target in neutral states (rad/frame). */
  lockTurnRate: 14 * DEG,
  /** Auto-target (aim assist) cone and extra range on top of a move's reach + lunge. */
  autoTargetCone: 45 * DEG,
  autoTargetExtraRange: 1.5,
  /** How fast you can steer during an attack without a target (rad/frame). */
  attackTurnRate: 3 * DEG,
  /** Default tracking during startup by move kind (rad/frame). */
  defaultTracking: { light: 12 * DEG, heavy: 7 * DEG, special: 8 * DEG, super: 16 * DEG, throw: 10 * DEG },
  /** Default lunge budget during startup by move kind (meters). */
  defaultLunge: { light: 1.6, heavy: 2.4, special: 2.0, super: 4.0, throw: 1.2 },
  /** Lunge stops when the gap shrinks to this fraction of the move's reach. */
  lungeReachFraction: 0.7,
  maxPitch: 50 * DEG,

  // ---------------------------------------------------------------- guard
  /** Half-angle of the guard arc in front of a fighter. Hits from outside it ignore blocks. */
  guardArc: 80 * DEG,
  /** Frames after pressing BLOCK during which an incoming hit is parried. */
  parryWindow: 7,
  /** Lockout after a whiffed parry window (anti-mash). Holding block still blocks. */
  parryWhiffCooldown: 20,
  parryHitstop: 14,
  /** How long a parried attacker is staggered. */
  parryStagger: 32,
  parryMeter: 30,
  parryGuardRestore: 10,
  chipRatio: 0.1,
  guardDamageRatio: 0.35,
  guardRegenDelay: 50,
  guardRegen: 0.5,
  guardBreakStagger: 60,
  blockHitstopScale: 0.8,
  blockPushScale: 0.55,

  // ---------------------------------------------------------------- evasion
  dodge: {
    frames: 22,
    invulnStart: 2,
    invulnEnd: 12,
    speed: 11,
    /** Dodging a hit within this many frames of invulnStart is a "perfect dodge". */
    perfectWindow: 5,
    /** Each consecutive dodge loses this many invulnerable frames. */
    chainPenalty: 3,
    chainReset: 40,
    minInvuln: 3,
  },
  airDodge: { frames: 20, invulnStart: 1, invulnEnd: 10, speed: 9 },
  /** Meter cost to cancel any attack into a dodge (escape/extension tool). */
  kiCancelCost: 50,
  perfectDodgeMeter: 25,

  // ---------------------------------------------------------------- recovery
  knockdownFrames: 45,
  /** From this frame of a knockdown you may quick-roll out of it. */
  knockdownTechFrom: 8,
  getupFrames: 22,
  techFrames: 20,
  techRollSpeed: 7,
  /** Pressing DODGE up to N frames before landing from a juggle = ground tech. */
  groundTechBuffer: 10,
  airTechBuffer: 8,
  throwTechWindow: 14,
  recoilFrames: 16,
  recoilCancelFrom: 6,
  wallSplatFrames: 48,
  /** Minimum speed into a wall for splats/bounces. */
  wallImpactSpeed: 4.5,
  groundBounceVelocity: 7.5,
  wallBounceRestitution: 0.6,
  maxOtgHits: 1,

  // ---------------------------------------------------------------- combo limits
  /** Juggle points available before an airborne victim falls out of the combo. */
  juggleLimit: 12,
  /** Hit number (1-based) from which damage scaling starts. */
  damageScaleStart: 3,
  damageScaleStep: 0.1,
  damageScaleMin: 0.3,
  /** Juggle gravity grows by this much per hit in a combo... */
  comboGravityPerHit: 0.04,
  /** ...up to this multiplier. */
  comboGravityMax: 1.8,
  /** After this many frames of continuous combo, hitstun starts decaying... */
  hitstunDecayStart: 150,
  /** ...by this fraction per second... */
  hitstunDecayPerSecond: 0.12,
  /** ...down to this multiplier. */
  hitstunDecayMin: 0.4,
  counterDamage: 1.2,
  counterHitstun: 8,

  // ---------------------------------------------------------------- resources
  meterMax: 300,
  meterOnHit: 0.12,
  meterOnBlock: 0.05,
  meterOnDamaged: 0.08,
  burstMax: 100,
  burstRegen: 0.04,
  burstOnDamaged: 0.025,
  burst: { frames: 32, invulnEnd: 26, activeFrame: 5, radius: 3.8, knockback: 10, up: 6, hitstun: 30 },

  // ---------------------------------------------------------------- physics
  /** Horizontal deceleration while sliding in hitstun/blockstun (m/s^2). */
  stunFriction: 40,
  knockdownFriction: 30,
  koRespawnFrames: 180,
} as const;

export type MoveKindKey = keyof typeof RULES.defaultTracking;
