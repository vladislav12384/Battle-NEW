/**
 * Data definitions for characters and moves.
 *
 * Everything a character can do is described by data: frame data, hitboxes,
 * knockback, cancel routes. The combat system interprets it. New characters
 * (anime heroes, superheroes...) should mostly be new data, not new code.
 *
 * Frame conventions (60 fps):
 *   A move occupies exactly `startup + active + recovery` frames.
 *   Frame 1 is the frame the move starts. Hitboxes listed with frames [a, b]
 *   are live on frames a..b (inclusive). "startup 5" means frames 1-5 are
 *   wind-up and the first hitbox can connect on frame 6.
 */
import type { Dir, Swipe } from './input';
import type { Vec3Tuple } from './math/vec3';

export type LimbId = 'lHand' | 'rHand' | 'lFoot' | 'rFoot' | 'body' | 'head';
export type MoveKind = 'light' | 'heavy' | 'special' | 'super' | 'throw';
export type HitEffect = 'light' | 'medium' | 'heavy' | 'launch' | 'spike' | 'energy' | 'throw' | 'burst';

/**
 * How a strike travels, seen by the one it is aimed at. Decides which way it
 * is easiest to dash out of it: a swing that comes from your left is dodged
 * by dashing right (away from where it comes from, past where it ends).
 *   straight  - jab, cross, teep, knee: either side works
 *   fromLeft / fromRight - hooks, roundhouses, backfists
 *   overhead  - hammer fists, axe kicks: easy to sidestep
 *   rising    - uppercuts, launchers
 *   low       - sweeps
 */
export type StrikeLine = 'straight' | 'fromLeft' | 'fromRight' | 'overhead' | 'rising' | 'low';

/** Super armor / poise: hits during these frames hurt but don't interrupt the move. */
export interface ArmorDef {
  frames: [number, number];
  hits: number;
  /** Fraction of the damage still taken (default 0.5). */
  damageTaken?: number;
  /** 'light' = only shrugs off light strikes (poise of heavy blows). Default 'all'. */
  vs?: 'light' | 'all';
}

/** Velocity (m/s) given to the victim, in the attacker's frame. */
export interface KnockbackDef {
  fwd: number;
  up: number;
  side?: number;
}

export interface HitDef {
  damage: number;
  /** Damage dealt through a block (defaults to damage * RULES.chipRatio). Never lethal. */
  chip?: number;
  /** Stamina drained from a blocking victim (defaults to damage * RULES.guardDamageRatio). */
  guardDamage?: number;
  hitstun: number;
  blockstun: number;
  /** Freeze frames for attacker and victim on impact (the "weight" of a hit). */
  hitstop?: number;
  knockback: KnockbackDef;
  /** Knockback used instead when the victim is already airborne. */
  airKnockback?: KnockbackDef;
  /** Horizontal pushback when blocked (m/s); defaults to a fraction of knockback.fwd. */
  blockPush?: number;
  /** Forces the victim airborne (juggle state). */
  launch?: boolean;
  /** Juggle points spent when hitting an airborne victim (default 1). */
  juggleCost?: number;
  unblockable?: boolean;
  /** Breaks the guard instantly when blocked. */
  guardBreak?: boolean;
  /** Default true. Supers and unblockables are typically not parryable. */
  parryable?: boolean;
  /** Grounded victim is popped up and will hit the ground into a knockdown. */
  knockdown?: boolean;
  /** Victim can't air-tech or ground-tech out of this hit. */
  hardKnockdown?: boolean;
  /** Victim sticks to a wall if knocked into one (once per combo). */
  wallSplat?: boolean;
  /** Victim bounces off a wall if knocked into one (once per combo). */
  wallBounce?: boolean;
  /** Victim bounces off the ground instead of landing (once per combo). */
  groundBounce?: boolean;
  /** Puts a grounded victim into a stagger (crumple) for this many frames. */
  crumple?: number;
  /** Overrides applied when the hit is a counter hit. */
  counter?: Partial<Omit<HitDef, 'counter'>>;
  /** Upward velocity given to an airborne attacker on hit (keeps air combos afloat). */
  attackerStall?: number;
  effect?: HitEffect;
  /** Lower bound for combo damage scaling on this hit (supers keep more damage). */
  minScaling?: number;
}

export interface HitboxDef {
  /** Inclusive frame range during which this hitbox is live. */
  frames: [number, number];
  /** Local position (x right, y up, z forward), relative to the feet. */
  a: Vec3Tuple;
  /** If present the hitbox is a capsule a-b (a sweep), otherwise a sphere. */
  b?: Vec3Tuple;
  radius: number;
  /** A victim can be hit once per group per move. Default 0: one hit per move. */
  group?: number;
  /** Which limb visually delivers this hitbox (animation hint for the client). */
  limb?: LimbId;
  /** This hitbox grabs instead of striking. */
  throw?: boolean;
  hit: HitDef;
}

/** Root motion: velocity (m/s) applied on a range of frames, in the attacker's frame. */
export interface MotionDef {
  frames: [number, number];
  fwd?: number;
  side?: number;
  /** If set, vertical velocity is set to this value on these frames. */
  up?: number;
}

export interface ProjectileDef {
  /** Move frame on which the projectile spawns. */
  frame: number;
  /** Local spawn offset (x right, y up, z forward). */
  offset: Vec3Tuple;
  speed: number;
  radius: number;
  lifetime: number;
  gravity?: number;
  /** Additional pitch (degrees) on top of the aim pitch. */
  pitchOffset?: number;
  /** How many victims it can hit before disappearing (default 1). */
  maxHits?: number;
  hit: HitDef;
}

/** A chain/target-combo route from this move into another. */
export interface CancelDef {
  button: number;
  into: string;
  dir?: Dir;
  swipe?: Swipe;
  frames: [number, number];
  /** always: works on whiff. contact: on hit or block. hit: only on hit. */
  on: 'always' | 'contact' | 'hit';
}

export interface ChargeDef {
  /** Move frame on which holding the button pauses the move. */
  frame: number;
  button: number;
  maxFrames: number;
  /** Charge frames needed for a full charge. */
  fullAt: number;
  /** Extra damage at full charge (0.6 = +60%), scales linearly before that. */
  damageBonus: number;
  /** Hit overrides at full charge (e.g. unblockable). */
  fullHit?: Partial<HitDef>;
}

export interface ThrowDef {
  hit: HitDef;
  /** Frames the thrower stays busy after the throw lands. */
  recovery: number;
}

export interface InvulnDef {
  frames: [number, number];
  kind: 'strike' | 'throw' | 'all';
}

export interface MoveDef {
  id: string;
  name: string;
  kind: MoveKind;
  startup: number;
  active: number;
  recovery: number;
  /** Aerial move (only from the air; landing interrupts it with landing lag). */
  air?: boolean;
  hitboxes: HitboxDef[];
  projectiles?: ProjectileDef[];
  motion?: MotionDef[];
  /** Gravity multiplier while performing the move (air moves hover). */
  gravityScale?: number;
  /**
   * How fast the body follows the camera during startup (radians/frame).
   * Lower = heavier, more committed. Defaults by kind (RULES.turnRate).
   */
  turnRate?: number;
  /** Max step-in toward an aim-assisted target during startup (meters). */
  lunge?: number;
  /**
   * Fraction of walk speed the fighter can still move with during the move
   * (halved on active frames). Defaults by kind (RULES.defaultMobility).
   */
  mobility?: number;
  /** Hand that throws the strike; straights alternate hands automatically. */
  hand?: 'left' | 'right';
  /**
   * Moves of the same family repeated within a combo lose hitstun and damage
   * ("stale"), so varied combos go further than spamming one strike.
   */
  family?: string;
  /** Can chain freely into other strikes after its active frames (default true for light/heavy). */
  flow?: boolean;
  /** Can be feinted (cancelled with BLOCK during early startup). Default true for heavies. */
  feint?: boolean;
  /** Whether hitboxes follow the vertical aim (default true). */
  pitchAim?: boolean;
  invuln?: InvulnDef[];
  armor?: ArmorDef;
  /**
   * Heavy blows have poise by default: during the late wind-up a light strike
   * can't interrupt them (RULES.poise). false turns it off.
   */
  poise?: boolean;
  /** Strike trajectory; derived from the first hitbox when omitted (see strikeLine). */
  line?: StrikeLine;
  /**
   * Animation style hint for the client ('hook', 'haymaker', 'roundhouse',
   * 'spinBackfist'...). Derived from the limb and the trajectory when omitted.
   */
  anim?: string;
  /** Effects hint for the client ('optic' = eye beam...). The simulation ignores it. */
  vfx?: string;
  /**
   * Takes the place of the air dash: in the air it can be used once per jump
   * and it uses up the air dash (movement specials like a recoil blast).
   */
  usesAirDash?: boolean;
  /**
   * The body keeps the facing the move started with (recoils, lunges): root
   * motion goes where the move was aimed while the camera stays free.
   */
  fixedFacing?: boolean;
  cancels?: CancelDef[];
  jumpCancel?: { frames: [number, number]; on: 'hit' | 'contact'; high?: boolean };
  meterCost?: number;
  /** Stamina spent to start the move (defaults by kind, RULES.staminaCost). Partly refunded on hit. */
  stamina?: number;
  /** Extra recovery frames when the move hits nothing (defaults by kind, RULES.whiffPenalty). */
  whiffPenalty?: number;
  /** Clash priority: equal priorities both recoil, otherwise the stronger wins. */
  priority?: number;
  landingLag?: number;
  /** If the move ends airborne the fighter can't act until landing. */
  endHelpless?: boolean;
  charge?: ChargeDef;
  throw?: ThrowDef;
  minScaling?: number;
}

export interface CommandDef {
  move: string;
  button: number;
  /** Required stick direction; omitted = any direction. */
  dir?: Dir;
  /** Required look-flick direction at the press; omitted = any. */
  swipe?: Swipe;
  /** Only if the previous hand strike used this hand (alternating straights). */
  afterHand?: 'left' | 'right';
  /** Only in this situation (e.g. an opponent lying in front of you). */
  context?: 'targetDown';
  /**
   * Position of the strike in a string of strikes chained on contact
   * (1 = opener), inclusive range. Lets two buttons cover a whole moveset:
   * the same button gives the next strike of the string.
   */
  seq?: readonly [number, number];
  /** true = only in the air, false = only on the ground, omitted = both. */
  air?: boolean;
  /** Only while sprinting. */
  running?: boolean;
}

export interface CharacterStats {
  maxHealth: number;
  /** Stamina: spent by attacks, dodges, jumps, sprinting and blocked hits. */
  maxStamina: number;
  /** Knockback is divided by weight (heavier = harder to launch and juggle). */
  weight: number;
  radius: number;
  height: number;
  eyeHeight: number;
  walkSpeed: number;
  runSpeed: number;
  blockWalkSpeed: number;
  jumpVelocity: number;
  airJumps: number;
  gravity: number;
  maxFallSpeed: number;
  airSpeed: number;
  groundAccel: number;
  airAccel: number;
}

export interface CharacterDef {
  id: string;
  name: string;
  /** Primary color for the placeholder renderer. */
  color: number;
  stats: CharacterStats;
  moves: Record<string, MoveDef>;
  /** Ordered by priority: the first matching command wins. */
  commands: CommandDef[];
}
