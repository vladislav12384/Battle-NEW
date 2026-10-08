/**
 * Mutable simulation state. Everything here is plain JSON-serializable data
 * so the whole world can be snapshotted/restored (rollback netcode, replays,
 * save states in training mode).
 */
import type { InputBuffer, InputFrame } from './input';
import type { RngState } from './math/rng';
import type { Vec3 } from './math/vec3';
import type { HitEffect } from './types';

export type StateId =
  | 'ground' // idle / walking / sprinting
  | 'jumpsquat'
  | 'air'
  | 'land' // landing lag
  | 'attack'
  | 'block'
  | 'blockstun'
  | 'hitstun' // grounded hitstun
  | 'juggle' // airborne hitstun
  | 'knockdown'
  | 'getup'
  | 'tech' // ground roll / air recovery / knockdown roll
  | 'stagger' // crumple, guard break, parried
  | 'wallsplat'
  | 'dodge'
  | 'recoil' // clash or throw tech
  | 'grabbing'
  | 'grabbed'
  | 'burst' // combo breaker
  | 'ko';

/** States in which a fighter is "being comboed". Leaving them ends the combo. */
export const COMBO_STATES: ReadonlySet<StateId> = new Set<StateId>([
  'hitstun',
  'juggle',
  'knockdown',
  'wallsplat',
  'stagger',
  'grabbed',
]);

/** Combo bookkeeping lives on the VICTIM, so co-op attackers share one combo (and its limits). */
export interface ComboState {
  hits: number;
  damage: number;
  /** Juggle points spent so far. */
  juggle: number;
  startFrame: number;
  attackers: number[];
  groundBounceUsed: boolean;
  wallBounceUsed: boolean;
  wallSplatUsed: boolean;
  otgHits: number;
  /** False once the victim had a chance to act (tech/escape) and got hit anyway. */
  trueCombo: boolean;
  /** Families of the most recent hits (stale-move tracking). */
  recent: string[];
}

/** Properties of the last hit that matter when the victim hits the ground or a wall. */
export interface ImpactFlags {
  groundBounce: boolean;
  wallSplat: boolean;
  wallBounce: boolean;
  hardKnockdown: boolean;
}

export interface FighterState {
  id: number;
  team: number;
  charId: string;
  name: string;
  spawn: Vec3;
  spawnYaw: number;

  pos: Vec3;
  vel: Vec3;
  yaw: number;
  aimPitch: number;
  grounded: boolean;

  state: StateId;
  /** Frames spent in the current state (1 on the first processed frame). */
  stateFrame: number;
  /** Remaining stun / lag frames for timed states. */
  stun: number;

  // Current move
  move: string | null;
  moveFrame: number;
  moveHit: boolean;
  moveBlocked: boolean;
  moveTarget: number;
  /** "victimId:group" keys already hit by the current move. */
  registry: string[];
  charging: boolean;
  chargeFrames: number;
  /** Extra recovery added to the current move (whiff penalty). */
  extraRecovery: number;
  armorLeft: number;
  /** The current strike bounced off an armored / poised opponent (no chain, no whiff). */
  moveAbsorbed: boolean;
  /** A strike button was mashed during this strike's wind-up: it can't chain. */
  mashed: boolean;
  /** The chain press for the next strike came right on impact. */
  onBeat: boolean;
  /** Consecutive on-beat chains (0..RULES.rhythm.max): extra damage and weight. */
  rhythm: number;
  /** Position of the current strike in its string (1 = opener, 0 = not attacking). */
  stringPos: number;
  /** Left exposed by a perfect dodge: acts at half speed while > 0. */
  exposed: number;
  lungeLeft: number;
  /** Auto-aimed move (ricochet super): the body turns to this launch direction. */
  autoAim: boolean;
  autoYaw: number;
  autoPitch: number;

  /** Freeze frames remaining (hit stop). */
  hitstop: number;
  /** Visual shake frames for the renderer (victim of a hit). */
  shake: number;

  health: number;
  stamina: number;
  meter: number;
  burst: number;
  /** Frames until stamina starts regenerating again. */
  staminaDelay: number;
  /** Out of stamina: slower attacks and movement, no dodging, any blocked hit breaks the guard. */
  exhausted: boolean;
  /** Ticks counter used to slow down actions while exhausted. */
  slowAccum: number;
  /** Guard was broken: stamina is partly restored when the stagger ends. */
  guardBroken: boolean;
  /** On fire: frames left (damage over time) and who lit it. */
  burn: number;
  burnBy: number;

  parryWindow: number;
  parryCooldown: number;

  dodgeAir: boolean;
  dodgeDirX: number;
  dodgeDirZ: number;
  dodgeInvulnEnd: number;
  dodgeChain: number;
  dodgeChainTimer: number;
  perfectDodged: boolean;
  /** Perfect-dodge reward: dodge recovery can be cancelled into attacks. */
  dodgeCounter: boolean;
  /** Side dash circling around this enemy (-1 = straight dash). */
  dodgeOrbit: number;
  dodgeRadius: number;
  /** Speed multiplier of the current dash (backsteps are shorter). */
  dodgeSpeed: number;

  /** Hand of the last hand strike, for alternating jab/cross ('' = reset). */
  lastHand: '' | 'left' | 'right';
  handTimer: number;

  airJumpsLeft: number;
  airDodged: boolean;
  helpless: boolean;
  /** Landing lag to apply when a helpless fall ends. */
  pendingLandLag: number;
  running: boolean;

  lockTarget: number;

  combo: ComboState;
  impact: ImpactFlags;
  /** Victim could have acted since the last hit (used for "true combo" tracking). */
  gap: boolean;
  wallNX: number;
  wallNZ: number;

  grabPartner: number;
  grabMove: string | null;

  koTimer: number;

  input: InputBuffer;
  lastInput: InputFrame;
}

export interface ProjectileState {
  id: number;
  owner: number;
  team: number;
  charId: string;
  moveId: string;
  index: number;
  pos: Vec3;
  prevPos: Vec3;
  vel: Vec3;
  life: number;
  radius: number;
  hitsLeft: number;
  registry: number[];
  reflected: boolean;
  /** Ricochets: bounces made so far, and the bounce points of this tick's flight (prevPos -> path... -> pos). */
  bounces: number;
  path: Vec3[];
  /** Guided ricochets: the fighter it hunts (-1 = none) and the bounces left in its plan. */
  target: number;
  planLeft: number;
}

export interface SimState {
  frame: number;
  nextId: number;
  rng: RngState;
  fighters: FighterState[];
  projectiles: ProjectileState[];
}

// ------------------------------------------------------------------- events
// Events are the bridge to presentation (VFX, sound, HUD). The simulation
// never depends on them.

export type GameEvent =
  | {
      type: 'hit';
      attacker: number;
      victim: number;
      damage: number;
      counter: boolean;
      punish: boolean;
      comboHits: number;
      comboDamage: number;
      trueCombo: boolean;
      effect: HitEffect;
      launch: boolean;
      point: Vec3;
      hitstop: number;
      /** Unit direction the victim was knocked (world space). */
      dir: Vec3;
      /** Knockback speed (m/s), a good proxy for how hard the hit was. */
      force: number;
      /** Move that landed the hit (null for throws/burst without a move). */
      move: string | null;
      /** Attacker's rhythm level when the hit landed (on-beat chains). */
      rhythm: number;
    }
  | { type: 'block'; attacker: number; victim: number; chip: number; stamina: number; point: Vec3 }
  | { type: 'parry'; attacker: number; victim: number; point: Vec3 }
  | { type: 'guardBreak'; attacker: number; victim: number; point: Vec3 }
  | { type: 'armor'; attacker: number; victim: number; damage: number; point: Vec3; poise: boolean }
  | { type: 'clash'; a: number; b: number; point: Vec3 }
  | { type: 'perfectDodge'; fighter: number; attacker: number }
  | { type: 'evade'; fighter: number; attacker: number; point: Vec3 }
  | { type: 'mash'; fighter: number }
  | { type: 'attack'; fighter: number; move: string }
  | { type: 'super'; fighter: number; move: string }
  | { type: 'kiCancel'; fighter: number }
  | { type: 'feint'; fighter: number }
  | { type: 'whiff'; fighter: number; move: string }
  | { type: 'exhausted'; fighter: number }
  | { type: 'jump'; fighter: number; high: boolean }
  | { type: 'land'; fighter: number }
  | { type: 'dodge'; fighter: number }
  | { type: 'tech'; fighter: number; kind: 'air' | 'ground' | 'roll' | 'throw' }
  | { type: 'burst'; fighter: number; point: Vec3 }
  | { type: 'wallSplat'; fighter: number; point: Vec3 }
  | { type: 'wallBounce'; fighter: number; point: Vec3 }
  | { type: 'groundBounce'; fighter: number; point: Vec3 }
  | { type: 'knockdown'; fighter: number }
  | { type: 'grab'; attacker: number; victim: number }
  | { type: 'throw'; attacker: number; victim: number }
  | { type: 'comboEnd'; victim: number; hits: number; damage: number; attackers: number[]; trueCombo: boolean }
  | { type: 'ko'; fighter: number; attacker: number }
  | { type: 'respawn'; fighter: number }
  | { type: 'projectile'; id: number; owner: number }
  | { type: 'projectileEnd'; id: number; point: Vec3 }
  | { type: 'reflect'; id: number; fighter: number }
  | { type: 'bounce'; id: number; point: Vec3; normal: Vec3; count: number }
  /** An auto-aimed shot was computed: the path the beam will take (eyes, bounces..., target). */
  | { type: 'ricochetPlan'; fighter: number; target: number; points: Vec3[] }
  | { type: 'ignite'; fighter: number; by: number }
  | { type: 'burn'; fighter: number; damage: number; by: number }

export type GameEventType = GameEvent['type'];
