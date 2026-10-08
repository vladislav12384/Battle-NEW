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
  inputBuffer: 10,

  // ---------------------------------------------------------------- movement
  jumpSquat: 4,
  /** Landing lag after a normal jump. */
  landingLag: 5,
  /** Default landing lag when an aerial attack is interrupted by the ground. */
  airAttackLandingLag: 10,
  /** Vertical velocity of a "launcher jump" (jump-cancel after a launcher hits). */
  highJumpVelocity: 12.5,

  // ---------------------------------------------------------------- aiming & control
  // The camera always belongs to the player. Attacks go where you look; aim
  // assist only nudges the BODY (never the camera) by a few degrees toward an
  // enemy that is already near your crosshair.
  lockOnRange: 25,
  lockOnCone: 60 * DEG,
  /** Max turn speed toward a lock-on target (rad/frame). */
  lockTurnRate: 10 * DEG,
  /** Enemies within this cone around the crosshair can receive aim assist. */
  assistCone: 25 * DEG,
  /** Max body correction toward the assisted target (yaw / pitch). */
  assistMaxYaw: 12 * DEG,
  assistMaxPitch: 15 * DEG,
  /** Extra range on top of a move's reach + lunge for picking the assist target. */
  assistExtraRange: 1.2,
  /** How fast the body follows the camera during an attack's startup, by kind (rad/frame). */
  turnRate: { light: 20 * DEG, heavy: 9 * DEG, special: 8 * DEG, super: 14 * DEG, throw: 14 * DEG },
  /** ...during active frames (you can drag a strike a little)... */
  activeTurnRate: 3.5 * DEG,
  /** ...and during recovery. */
  recoveryTurnRate: 8 * DEG,
  /** Turn speed while blocking or in blockstun: guards can be flanked. */
  blockTurnRate: 4 * DEG,
  /** Turn speed while staggered / in hitstun / recoiling. */
  stunTurnRate: 6 * DEG,
  /** Step-in budget toward the assisted target during startup, by kind (meters). */
  defaultLunge: { light: 0.7, heavy: 1.0, special: 0.8, super: 3.5, throw: 0.8 },
  /** Holding forward while attacking adds this much step-in. */
  lungeForwardBonus: 0.5,
  /** Lunge stops when the gap shrinks to this fraction of the move's reach. */
  lungeReachFraction: 0.7,
  maxPitch: 50 * DEG,
  /** Movement allowed during attacks, as a fraction of walk speed, by kind. */
  defaultMobility: { light: 0.5, heavy: 0.25, special: 0.2, super: 0, throw: 0.3 },
  /** Mobility multiplier on active frames. */
  activeMobilityScale: 0.5,

  // ---------------------------------------------------------------- free-form combos
  /**
   * Light/heavy strikes chain into any strike right after their active frames,
   * but only on contact (hit or block). A strike that hits nothing must play
   * out its recovery plus a whiff penalty: misses cost time and stamina.
   */
  whiffPenalty: { light: 5, heavy: 10, special: 6, super: 0, throw: 0 },
  /** Overextended after a miss: the body lurches forward (m/s). */
  whiffStumble: 1.6,
  /** Extra freeze on a heavy blow that lands as the 3rd+ hit of a combo (finisher weight). */
  finisherHitstop: 5,
  /** Hits remembered for stale-move tracking. */
  staleWindow: 4,
  /** Hitstun lost per repeat of the same family within the window... */
  staleHitstunStep: 0.25,
  staleHitstunMin: 0.4,
  /** ...and damage lost. */
  staleDamageStep: 0.1,
  staleDamageMin: 0.6,
  /**
   * Rhythm instead of mashing. Strikes chain only on contact, and the next
   * press must come AFTER the blow lands: pressing a strike button during
   * another strike's wind-up is mashing and locks that strike's chain.
   * A chain press during the impact freeze or within `beatWindow` frames
   * after the active frames is "on beat"...
   */
  beatWindow: 6,
  /** ...and every consecutive on-beat chain hits harder. */
  rhythm: { max: 3, damage: 0.07, hitstop: 1 },
  /**
   * Poise of heavy blows: from this fraction of the startup until the end of
   * the active frames a light strike doesn't interrupt them (half damage).
   * Jabbing into a heavy you saw coming loses; dodge it instead.
   */
  poise: { from: 0.45, damageTaken: 0.5 },
  /** Heavies can be feinted with BLOCK until this many frames before their first active frame. */
  feintLock: 3,
  /** Straights stop alternating hands after this long without a hand strike. */
  handResetFrames: 45,

  // ---------------------------------------------------------------- guard
  /** Half-angle of the guard arc in front of a fighter. Hits from outside it ignore blocks. */
  guardArc: 80 * DEG,
  /** Frames after pressing BLOCK during which an incoming hit is parried. */
  parryWindow: 9,
  /** Lockout after a whiffed parry window (anti-mash). Holding block still blocks. */
  parryWhiffCooldown: 30,
  parryHitstop: 16,
  /** How long a parried attacker is staggered. */
  parryStagger: 46,
  parryMeter: 30,
  chipRatio: 0.1,
  /** Stamina drained per blocked hit, as a fraction of its damage (if the hit doesn't say). */
  guardDamageRatio: 0.35,
  guardBreakStagger: 70,
  blockHitstopScale: 0.8,
  blockPushScale: 0.55,

  // ---------------------------------------------------------------- evasion
  /**
   * Dash (DODGE + direction). Whether a dash gets you out of a strike depends
   * on the strike: the evasion window (frames, counted from invulnStart) is
   * long against slow heavy blows and short against quick jabs, and depends
   * on which way you dash (see StrikeLine). EVERY strike can be dodged; fast
   * ones need a read, slow ones can be dodged on reaction.
   */
  dodge: {
    frames: 28,
    invulnStart: 2,
    /** Generic invulnerability (throws, bursts) ends here. */
    invulnEnd: 14,
    speed: 8.5,
    /** Evasion window by the kind of strike being dodged. */
    window: { light: 12, heavy: 18, special: 14, super: 12, throw: 12 },
    /** Dashing away from the side a swing comes from (past where it ends)... */
    goodSide: 4,
    /** ...or into it. */
    badSide: -4,
    /** Sidestepping a vertical blow is easy. */
    overheadSide: 2,
    /** Backsteps rely on distance; dashing forward into a strike is risky. */
    back: -3,
    forward: -6,
    /** Backsteps are shorter than side dashes: retreating is a reset, not a free escape. */
    backSpeed: 0.8,
    minWindow: 3,
    /** Dodging within this many frames of invulnStart is a "perfect dodge". */
    perfectWindow: 5,
    /** Each consecutive dodge loses this many evasion frames. */
    chainPenalty: 4,
    chainReset: 50,
    minInvuln: 3,
    /** Side dashes curve around an enemy in front within this range (circling). */
    orbitRange: 3.5,
    /** A perfect dodge leaves the attacker exposed: it acts at half speed for this long. */
    exposeFrames: 40,
    /** Stamina given back by a perfect dodge. */
    perfectStamina: 10,
  },
  airDodge: { frames: 24, invulnStart: 1, invulnEnd: 12, speed: 7.5 },
  /** Meter cost to cancel any attack into a dodge (escape/extension tool). */
  kiCancelCost: 50,
  perfectDodgeMeter: 25,

  // ---------------------------------------------------------------- recovery
  knockdownFrames: 55,
  /** From this frame of a knockdown you may quick-roll out of it. */
  knockdownTechFrom: 10,
  getupFrames: 26,
  techFrames: 24,
  techRollSpeed: 5.5,
  /** Pressing DODGE up to N frames before landing from a juggle = ground tech. */
  groundTechBuffer: 12,
  airTechBuffer: 10,
  throwTechWindow: 18,
  recoilFrames: 20,
  recoilCancelFrom: 8,
  wallSplatFrames: 60,
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
  hitstunDecayStart: 210,
  /** ...by this fraction per second... */
  hitstunDecayPerSecond: 0.12,
  /** ...down to this multiplier. */
  hitstunDecayMin: 0.4,
  counterDamage: 1.2,
  counterHitstun: 10,

  // ---------------------------------------------------------------- resources
  meterMax: 300,
  meterOnHit: 0.12,
  meterOnBlock: 0.05,
  meterOnDamaged: 0.08,
  burstMax: 100,
  burstRegen: 0.04,
  burstOnDamaged: 0.025,
  burst: { frames: 40, invulnEnd: 32, activeFrame: 7, radius: 3.8, knockback: 9, up: 6, hitstun: 40 },

  // ---------------------------------------------------------------- stamina
  /** Stamina cost to start a move, by kind (MoveDef.stamina overrides). */
  staminaCost: { light: 9, heavy: 18, special: 14, super: 0, throw: 10 },
  stamina: {
    /** Regeneration per frame once the delay is over (~26/s). */
    regen: 0.43,
    /** Frames after spending before regeneration starts. */
    regenDelay: 36,
    /** Regeneration multiplier while holding block. */
    blockRegenScale: 0.4,
    /** Fraction of a move's cost refunded when it lands: accuracy pays. */
    hitRefund: 0.4,
    dodge: 16,
    airDodge: 14,
    jump: 6,
    /** Sprinting drain per frame. */
    sprint: 0.16,
    /** Restored by a successful parry. */
    parryRestore: 15,
    /** Exhaustion ends once stamina is back to this. */
    recoverAt: 35,
    /** While exhausted every Nth frame of an action is skipped (slower strikes). */
    exhaustedSlowEvery: 3,
    /** Movement speed multiplier while exhausted. */
    exhaustedMove: 0.6,
    /** Stamina restored after a guard-break stagger ends (fraction of max). */
    afterGuardBreak: 0.5,
  },

  // ---------------------------------------------------------------- physics
  /** Horizontal deceleration while sliding in hitstun/blockstun (m/s^2). */
  stunFriction: 30,
  knockdownFriction: 24,
  koRespawnFrames: 180,
} as const;

export type MoveKindKey = keyof typeof RULES.turnRate;
