/** Small shared helpers for fighter state, used by both the state machine and hit resolution. */
import { createInputBuffer, neutralInput } from './input';
import { inFrames } from './moves';
import { clone, hDistance, wrapAngle, yawFromDir, type Vec3, vec3 } from './math/vec3';
import { RULES } from './rules';
import type { ComboState, FighterState, StateId } from './state';
import type { CharacterStats, MoveDef } from './types';

/** The subset of the Simulation API that combat code needs (avoids import cycles). */
export interface SimContext {
  readonly state: { frame: number; fighters: FighterState[] };
  fighter(id: number): FighterState | undefined;
  statsOf(f: FighterState): CharacterStats;
  moveOf(f: FighterState): MoveDef | null;
  /** Looks up a move of a character (projectiles keep their original character after a reflect). */
  moveById(charId: string, id: string): MoveDef | null;
  emit(e: import('./state').GameEvent): void;
}

export function freshCombo(): ComboState {
  return {
    hits: 0,
    damage: 0,
    juggle: 0,
    startFrame: 0,
    attackers: [],
    groundBounceUsed: false,
    wallBounceUsed: false,
    wallSplatUsed: false,
    otgHits: 0,
    trueCombo: true,
  };
}

export function createFighterState(
  id: number,
  team: number,
  charId: string,
  name: string,
  stats: CharacterStats,
  pos: Vec3,
  yaw: number,
): FighterState {
  return {
    id,
    team,
    charId,
    name,
    spawn: clone(pos),
    spawnYaw: yaw,
    pos: clone(pos),
    vel: vec3(),
    yaw,
    aimPitch: 0,
    grounded: pos.y <= 0,
    state: pos.y <= 0 ? 'ground' : 'air',
    stateFrame: 0,
    stun: 0,
    move: null,
    moveFrame: 0,
    moveHit: false,
    moveBlocked: false,
    moveTarget: -1,
    registry: [],
    charging: false,
    chargeFrames: 0,
    armorLeft: 0,
    lungeLeft: 0,
    hitstop: 0,
    shake: 0,
    health: stats.maxHealth,
    guard: stats.maxGuard,
    meter: 0,
    burst: RULES.burstMax,
    guardRegenDelay: 0,
    guardBroken: false,
    parryWindow: 0,
    parryCooldown: 0,
    dodgeAir: false,
    dodgeDirX: 0,
    dodgeDirZ: 0,
    dodgeInvulnEnd: 0,
    dodgeChain: 0,
    dodgeChainTimer: 0,
    perfectDodged: false,
    dodgeCounter: false,
    airJumpsLeft: stats.airJumps,
    airDodged: false,
    helpless: false,
    pendingLandLag: 0,
    running: false,
    lockTarget: -1,
    combo: freshCombo(),
    impact: { groundBounce: false, wallSplat: false, wallBounce: false, hardKnockdown: false },
    gap: false,
    wallNX: 0,
    wallNZ: 0,
    grabPartner: -1,
    grabMove: null,
    koTimer: 0,
    input: createInputBuffer(),
    lastInput: neutralInput(yaw),
  };
}

/** Switches state and resets per-state bookkeeping. */
export function enterState(f: FighterState, s: StateId, stun = 0): void {
  f.state = s;
  f.stateFrame = 0;
  f.stun = stun;
  if (s !== 'attack') {
    f.move = null;
    f.moveFrame = 0;
    f.charging = false;
    f.chargeFrames = 0;
    f.armorLeft = 0;
  }
  if (s !== 'ground') f.running = false;
}

export const isAirborneVictim = (f: FighterState): boolean =>
  !f.grounded || f.state === 'juggle' || f.state === 'wallsplat';

export const isGuarding = (f: FighterState): boolean => f.state === 'block' || f.state === 'blockstun';

/** Whether `f` faces the world point `from` within the guard arc. */
export function isFacing(f: FighterState, from: Vec3): boolean {
  if (hDistance(f.pos, from) < 1e-3) return true;
  const yawToSrc = yawFromDir(from.x - f.pos.x, from.z - f.pos.z);
  return Math.abs(wrapAngle(yawToSrc - f.yaw)) <= RULES.guardArc;
}

export type Invuln = 'none' | 'strike' | 'throw' | 'all';

export function dodgeInvulnStart(f: FighterState): number {
  return f.dodgeAir ? RULES.airDodge.invulnStart : RULES.dodge.invulnStart;
}

/** What the fighter is currently immune to. */
export function invulnerability(sim: SimContext, f: FighterState): Invuln {
  switch (f.state) {
    case 'dodge':
      return f.stateFrame >= dodgeInvulnStart(f) && f.stateFrame <= f.dodgeInvulnEnd ? 'all' : 'none';
    case 'tech':
    case 'getup':
    case 'ko':
      return 'all';
    case 'burst':
      return f.stateFrame <= RULES.burst.invulnEnd ? 'all' : 'none';
    case 'attack': {
      const m = sim.moveOf(f);
      for (const inv of m?.invuln ?? []) if (inFrames(inv.frames, f.moveFrame)) return inv.kind;
      return 'none';
    }
    default:
      return 'none';
  }
}

const THROW_IMMUNE: ReadonlySet<StateId> = new Set<StateId>([
  'hitstun',
  'blockstun',
  'juggle',
  'knockdown',
  'getup',
  'tech',
  'wallsplat',
  'grabbed',
  'grabbing',
  'ko',
  'burst',
  'recoil',
]);

export function isThrowable(sim: SimContext, f: FighterState): boolean {
  if (!f.grounded || THROW_IMMUNE.has(f.state)) return false;
  const inv = invulnerability(sim, f);
  return inv !== 'all' && inv !== 'throw';
}

/** Breaks a grab if `f` is part of one (e.g. a co-op partner hits the thrower). */
export function releaseGrab(sim: SimContext, f: FighterState): void {
  if (f.state !== 'grabbing' && f.state !== 'grabbed') return;
  const partner = sim.fighter(f.grabPartner);
  f.grabPartner = -1;
  if (!partner || partner.grabPartner !== f.id) return;
  partner.grabPartner = -1;
  if (partner.state === 'grabbing') enterState(partner, 'recoil');
  else if (partner.state === 'grabbed') enterState(partner, 'ground');
}
