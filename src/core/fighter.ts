/**
 * The fighter state machine: turns buffered input into actions and runs
 * every timed state (attacks, stun, knockdowns, techs, dodges, grabs...).
 *
 * Timing contract (used by the frame-advantage math in the docs/tests):
 *   - A move started on tick T is on move frame 1 during tick T.
 *   - A stun of N frames keeps the fighter stunned for N ticks after the
 *     hit stop ends; it acts on tick N+1.
 *   - Hit stop freezes logic and physics but inputs keep buffering.
 */
import { pinVictim, resolveHit, throwTech } from './combat';
import { enterState, releaseGrab } from './fighterUtil';
import {
  Button,
  buffered,
  consume,
  feedInput,
  type InputFrame,
  isHeld,
  stickDir,
} from './input';
import {
  approach,
  approachAngle,
  clamp,
  distance,
  hDistance,
  localDirToWorld,
  type Vec3,
  vec3,
  wrapAngle,
  yawFromDir,
  yawTo,
  forwardFromYaw,
  rightFromYaw,
  clone,
} from './math/vec3';
import { chestHeight, chestPos, inFrames, moveReach, totalFrames } from './moves';
import { accelerateTo, applyFriction, type WallContact } from './physics';
import { type ProjectileHost, spawnProjectile } from './projectiles';
import { DT, RULES } from './rules';
import type { FighterState } from './state';
import type { CommandDef, HitDef, MoveDef } from './types';

/** What the state machine needs from the simulation. */
export interface FighterHost extends ProjectileHost {
  readonly respawn: boolean;
  charCommands(f: FighterState): CommandDef[];
}

// ==========================================================================
// Entry points

export function updateFighter(sim: FighterHost, f: FighterState, input: InputFrame): void {
  const frozen = f.hitstop > 0;
  feedInputFrame(f, input, frozen);
  if (f.shake > 0) f.shake--;
  if (frozen) {
    f.hitstop--;
    return;
  }
  tickTimers(f);
  f.stateFrame++;
  updateLock(sim, f);
  runState(sim, f, input);
}

function feedInputFrame(f: FighterState, input: InputFrame, frozen: boolean): void {
  feedInput(f.input, input, frozen);
  f.lastInput = input;
}

function tickTimers(f: FighterState): void {
  if (f.parryWindow > 0) {
    f.parryWindow--;
    if (f.parryWindow === 0) f.parryCooldown = RULES.parryWhiffCooldown;
  } else if (f.parryCooldown > 0) {
    f.parryCooldown--;
  }
  if (f.dodgeChainTimer > 0) f.dodgeChainTimer--;
}

function runState(sim: FighterHost, f: FighterState, input: InputFrame): void {
  switch (f.state) {
    case 'ground':
      return stateGround(sim, f, input);
    case 'jumpsquat':
      return stateJumpsquat(sim, f, input);
    case 'air':
      return stateAir(sim, f, input);
    case 'land':
      return stateLand(sim, f, input);
    case 'attack':
      return stateAttack(sim, f, input);
    case 'block':
      return stateBlock(sim, f, input);
    case 'blockstun':
      return stateBlockstun(sim, f, input);
    case 'hitstun':
      return stateHitstun(sim, f, input);
    case 'juggle':
      return stateJuggle(sim, f, input);
    case 'knockdown':
      return stateKnockdown(sim, f, input);
    case 'getup':
      return stateGetup(sim, f, input);
    case 'tech':
      return stateTech(sim, f, input);
    case 'stagger':
      return stateStagger(sim, f, input);
    case 'wallsplat':
      return stateWallsplat(sim, f);
    case 'dodge':
      return stateDodge(sim, f, input);
    case 'recoil':
      return stateRecoil(sim, f, input);
    case 'grabbing':
      return stateGrabbing(sim, f, input);
    case 'grabbed':
      return stateGrabbed(sim, f, input);
    case 'burst':
      return stateBurst(sim, f, input);
    case 'ko':
      return stateKo(sim, f);
  }
}

/** Returns to ground/air neutral and lets the fighter act on this same tick. */
function toNeutral(sim: FighterHost, f: FighterState, input: InputFrame): void {
  if (f.grounded) {
    enterState(f, 'ground');
    stateGround(sim, f, input);
  } else {
    enterState(f, 'air');
    stateAir(sim, f, input);
  }
}

// ==========================================================================
// Aiming: lock-on, free look, auto-target

function lockedTarget(sim: FighterHost, f: FighterState): FighterState | null {
  if (f.lockTarget < 0) return null;
  const t = sim.fighter(f.lockTarget);
  return t && t.state !== 'ko' ? t : null;
}

/** Best enemy inside a cone around `yaw` (closest and most centered wins). */
export function bestTarget(
  sim: FighterHost,
  f: FighterState,
  yaw: number,
  range: number,
  cone: number,
): FighterState | null {
  let best: FighterState | null = null;
  let bestScore = Infinity;
  for (const e of sim.state.fighters) {
    if (e.team === f.team || e.state === 'ko') continue;
    const dx = e.pos.x - f.pos.x;
    const dz = e.pos.z - f.pos.z;
    const dh = Math.hypot(dx, dz);
    const d = Math.hypot(dh, e.pos.y - f.pos.y);
    if (d > range) continue;
    const ang = Math.abs(wrapAngle(yawFromDir(dx, dz) - yaw));
    if (ang > cone && dh > 1.2) continue;
    const score = d + ang * 4;
    if (score < bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

function updateLock(sim: FighterHost, f: FighterState): void {
  if (buffered(f.input, Button.LOCK, 2)) {
    consume(f.input, Button.LOCK);
    if (f.lockTarget >= 0) f.lockTarget = -1;
    else f.lockTarget = bestTarget(sim, f, f.yaw, RULES.lockOnRange, RULES.lockOnCone)?.id ?? -1;
  }
  if (f.lockTarget >= 0) {
    const t = sim.fighter(f.lockTarget);
    if (!t || t.state === 'ko' || hDistance(t.pos, f.pos) > RULES.lockOnRange * 1.5) f.lockTarget = -1;
  }
}

function pitchTo(sim: FighterHost, f: FighterState, t: FighterState): number {
  const a = chestPos(f, sim.statsOf(f));
  const b = chestPos(t, sim.statsOf(t));
  return Math.atan2(b.y - a.y, hDistance(a, b));
}

/** Facing in neutral states: follow the camera, or the lock-on target. */
function faceFree(sim: FighterHost, f: FighterState, input: InputFrame): void {
  const t = lockedTarget(sim, f);
  if (t) {
    f.yaw = approachAngle(f.yaw, yawTo(f.pos, t.pos), RULES.lockTurnRate);
    f.aimPitch = approach(f.aimPitch, pitchTo(sim, f, t), RULES.lockTurnRate);
  } else {
    f.yaw = wrapAngle(input.yaw);
    f.aimPitch = clamp(input.pitch, -1.4, 1.4);
  }
}

/** Camera-relative stick as a world-space direction (length <= 1). */
function wishDir(f: FighterState, input: InputFrame): Vec3 {
  const m = Math.hypot(input.moveX, input.moveY);
  if (m < 0.1) return vec3();
  const k = Math.min(1, m) / m;
  const d = localDirToWorld(f.yaw, input.moveX * k, input.moveY * k);
  return d;
}

// ==========================================================================
// Neutral states

function findCommand(
  sim: FighterHost,
  f: FighterState,
  input: InputFrame,
  filter?: (m: MoveDef) => boolean,
): CommandDef | null {
  const dir = stickDir(input);
  const air = !f.grounded;
  for (const cmd of sim.charCommands(f)) {
    if (!buffered(f.input, cmd.button)) continue;
    if (cmd.air !== undefined && cmd.air !== air) continue;
    if (cmd.dir && cmd.dir !== dir) continue;
    if (cmd.running && !f.running) continue;
    const m = sim.moveById(f.charId, cmd.move);
    if (!m || (m.meterCost ?? 0) > f.meter) continue;
    if (filter && !filter(m)) continue;
    return cmd;
  }
  return null;
}

function tryCommand(sim: FighterHost, f: FighterState, input: InputFrame, filter?: (m: MoveDef) => boolean): boolean {
  const cmd = findCommand(sim, f, input, filter);
  if (!cmd) return false;
  consume(f.input, cmd.button);
  startMove(sim, f, cmd.move);
  return true;
}

function tryGroundActions(sim: FighterHost, f: FighterState, input: InputFrame, allowBlock: boolean): boolean {
  if (tryCommand(sim, f, input)) return true;
  if (buffered(f.input, Button.DODGE)) {
    consume(f.input, Button.DODGE);
    startDodge(sim, f, input);
    return true;
  }
  if (buffered(f.input, Button.JUMP)) {
    consume(f.input, Button.JUMP);
    enterState(f, 'jumpsquat');
    return true;
  }
  if (allowBlock && isHeld(f.input, Button.BLOCK)) {
    enterBlock(f);
    return true;
  }
  return false;
}

function tryAirActions(sim: FighterHost, f: FighterState, input: InputFrame): boolean {
  if (tryCommand(sim, f, input)) return true;
  if (buffered(f.input, Button.DODGE) && !f.airDodged) {
    consume(f.input, Button.DODGE);
    startDodge(sim, f, input);
    return true;
  }
  if (buffered(f.input, Button.JUMP) && f.airJumpsLeft > 0) {
    consume(f.input, Button.JUMP);
    const stats = sim.statsOf(f);
    const w = wishDir(f, input);
    f.airJumpsLeft--;
    f.vel.y = stats.jumpVelocity * 0.9;
    f.vel.x = w.x * stats.airSpeed;
    f.vel.z = w.z * stats.airSpeed;
    sim.emit({ type: 'jump', fighter: f.id, high: false });
    return false; // still in the air state; keep steering this tick
  }
  return false;
}

function stateGround(sim: FighterHost, f: FighterState, input: InputFrame): void {
  faceFree(sim, f, input);
  if (tryGroundActions(sim, f, input, true)) return;
  const stats = sim.statsOf(f);
  const moving = Math.hypot(input.moveX, input.moveY) > 0.3;
  if (f.running && !(moving && isHeld(f.input, Button.DODGE))) f.running = false;
  const speed = f.running ? stats.runSpeed : stats.walkSpeed;
  const w = wishDir(f, input);
  accelerateTo(f, w.x * speed, w.z * speed, stats.groundAccel);
}

function stateJumpsquat(sim: FighterHost, f: FighterState, input: InputFrame): void {
  faceFree(sim, f, input);
  applyFriction(f, sim.statsOf(f).groundAccel * 0.3);
  if (f.stateFrame >= RULES.jumpSquat) doJump(sim, f, input, false);
}

function doJump(sim: FighterHost, f: FighterState, input: InputFrame, high: boolean): void {
  const stats = sim.statsOf(f);
  if (high) {
    const fw = forwardFromYaw(f.yaw);
    f.vel = vec3(fw.x * 1.2, RULES.highJumpVelocity, fw.z * 1.2);
  } else {
    const w = wishDir(f, input);
    const speed = f.running ? stats.runSpeed : stats.walkSpeed;
    f.vel = vec3(w.x * speed, stats.jumpVelocity, w.z * speed);
  }
  f.grounded = false;
  f.airJumpsLeft = stats.airJumps;
  f.airDodged = false;
  f.helpless = false;
  enterState(f, 'air');
  sim.emit({ type: 'jump', fighter: f.id, high });
}

function stateAir(sim: FighterHost, f: FighterState, input: InputFrame): void {
  faceFree(sim, f, input);
  if (!f.helpless && tryAirActions(sim, f, input)) return;
  const stats = sim.statsOf(f);
  const w = wishDir(f, input);
  if (w.x !== 0 || w.z !== 0) accelerateTo(f, w.x * stats.airSpeed, w.z * stats.airSpeed, stats.airAccel);
  else applyFriction(f, 2);
}

function stateLand(sim: FighterHost, f: FighterState, input: InputFrame): void {
  applyFriction(f, sim.statsOf(f).groundAccel);
  if (f.stateFrame >= f.stun) toNeutral(sim, f, input);
}

// ==========================================================================
// Guard

function enterBlock(f: FighterState): void {
  enterState(f, 'block');
  tryOpenParry(f);
}

/** A fresh BLOCK press opens a short parry window (unless on whiff cooldown). */
function tryOpenParry(f: FighterState): void {
  if (buffered(f.input, Button.BLOCK) && f.parryCooldown === 0 && f.parryWindow === 0) {
    consume(f.input, Button.BLOCK);
    f.parryWindow = RULES.parryWindow;
  }
}

function stateBlock(sim: FighterHost, f: FighterState, input: InputFrame): void {
  faceFree(sim, f, input);
  // A tapped block stays up until its parry window closes, so tapping to parry works.
  if (!isHeld(f.input, Button.BLOCK) && f.parryWindow === 0) {
    enterState(f, 'ground');
    stateGround(sim, f, input);
    return;
  }
  tryOpenParry(f);
  // Attacking, dodging or jumping straight out of guard is allowed.
  if (tryGroundActions(sim, f, input, false)) return;
  const stats = sim.statsOf(f);
  const w = wishDir(f, input);
  accelerateTo(f, w.x * stats.blockWalkSpeed, w.z * stats.blockWalkSpeed, stats.groundAccel);
}

function stateBlockstun(sim: FighterHost, f: FighterState, input: InputFrame): void {
  tryOpenParry(f);
  applyFriction(f, RULES.stunFriction);
  if (f.stun > 0) {
    f.stun--;
    return;
  }
  if (isHeld(f.input, Button.BLOCK)) {
    enterState(f, 'block');
    stateBlock(sim, f, input);
  } else {
    toNeutral(sim, f, input);
  }
}

// ==========================================================================
// Getting hit and getting out

function tryBurst(sim: FighterHost, f: FighterState): boolean {
  if (!buffered(f.input, Button.BURST) || f.burst < RULES.burstMax) return false;
  consume(f.input, Button.BURST);
  releaseGrab(sim, f);
  f.burst = 0;
  enterState(f, 'burst');
  f.vel = vec3(0, f.grounded ? 0 : 1, 0);
  f.impact = { groundBounce: false, wallSplat: false, wallBounce: false, hardKnockdown: false };
  sim.emit({ type: 'burst', fighter: f.id, point: chestPos(f, sim.statsOf(f)) });
  return true;
}

function stateHitstun(sim: FighterHost, f: FighterState, input: InputFrame): void {
  if (tryBurst(sim, f)) return;
  applyFriction(f, RULES.stunFriction);
  if (f.stun > 0) {
    f.stun--;
    return;
  }
  f.gap = true;
  toNeutral(sim, f, input);
}

function stateJuggle(sim: FighterHost, f: FighterState, input: InputFrame): void {
  if (tryBurst(sim, f)) return;
  if (f.stun > 0) {
    f.stun--;
    return;
  }
  if (f.impact.hardKnockdown) return;
  // Hitstun is over: the victim may recover in the air at any moment now.
  f.gap = true;
  const w = RULES.airTechBuffer;
  for (const b of [Button.JUMP, Button.DODGE, Button.BLOCK]) {
    if (buffered(f.input, b, w)) {
      consume(f.input, b);
      startTech(sim, f, input, 'air');
      return;
    }
  }
}

function stateKnockdown(sim: FighterHost, f: FighterState, input: InputFrame): void {
  applyFriction(f, RULES.knockdownFriction);
  if (!f.impact.hardKnockdown && f.stateFrame >= RULES.knockdownTechFrom && buffered(f.input, Button.DODGE)) {
    consume(f.input, Button.DODGE);
    startTech(sim, f, input, 'roll');
    return;
  }
  if (f.stateFrame >= RULES.knockdownFrames) enterState(f, 'getup');
}

function stateGetup(sim: FighterHost, f: FighterState, input: InputFrame): void {
  applyFriction(f, RULES.knockdownFriction);
  if (f.stateFrame >= RULES.getupFrames) toNeutral(sim, f, input);
}

function startTech(sim: FighterHost, f: FighterState, input: InputFrame, kind: 'air' | 'ground' | 'roll'): void {
  let w = wishDir(f, input);
  if (w.x === 0 && w.z === 0) {
    const fw = forwardFromYaw(f.yaw);
    w = vec3(-fw.x, 0, -fw.z);
  }
  enterState(f, 'tech');
  if (kind === 'air') {
    f.vel = vec3(w.x * 3, 5, w.z * 3);
    f.grounded = false;
  } else {
    f.vel = vec3(w.x * RULES.techRollSpeed, 0, w.z * RULES.techRollSpeed);
  }
  f.impact = { groundBounce: false, wallSplat: false, wallBounce: false, hardKnockdown: false };
  sim.emit({ type: 'tech', fighter: f.id, kind });
}

function stateTech(sim: FighterHost, f: FighterState, input: InputFrame): void {
  if (f.grounded) applyFriction(f, 12);
  if (f.stateFrame >= RULES.techFrames) toNeutral(sim, f, input);
}

function stateStagger(sim: FighterHost, f: FighterState, input: InputFrame): void {
  if (tryBurst(sim, f)) return;
  applyFriction(f, RULES.stunFriction);
  if (f.stun > 0) {
    f.stun--;
    return;
  }
  if (f.guardBroken) {
    f.guard = sim.statsOf(f).maxGuard;
    f.guardBroken = false;
  }
  f.gap = true;
  toNeutral(sim, f, input);
}

function stateWallsplat(sim: FighterHost, f: FighterState): void {
  if (tryBurst(sim, f)) return;
  f.vel = vec3();
  if (f.stun > 0) {
    f.stun--;
    return;
  }
  // Slide off the wall into a hard knockdown.
  enterState(f, 'juggle', 0);
  f.impact = { groundBounce: false, wallSplat: false, wallBounce: false, hardKnockdown: true };
  f.vel = vec3(f.wallNX * 1.5, 0, f.wallNZ * 1.5);
  f.grounded = false;
}

function stateRecoil(sim: FighterHost, f: FighterState, input: InputFrame): void {
  if (f.grounded) applyFriction(f, RULES.stunFriction);
  if (f.stateFrame >= RULES.recoilCancelFrom) {
    const acted = f.grounded ? tryGroundActions(sim, f, input, true) : tryAirActions(sim, f, input);
    if (acted || f.state !== 'recoil') return;
  }
  if (f.stateFrame >= RULES.recoilFrames) toNeutral(sim, f, input);
}

function stateKo(sim: FighterHost, f: FighterState): void {
  if (f.grounded) applyFriction(f, RULES.knockdownFriction);
  f.koTimer++;
  if (sim.respawn && f.koTimer >= RULES.koRespawnFrames) respawnFighter(sim, f);
}

export function respawnFighter(sim: FighterHost, f: FighterState): void {
  const stats = sim.statsOf(f);
  f.pos = clone(f.spawn);
  f.vel = vec3();
  f.yaw = f.spawnYaw;
  f.grounded = f.pos.y <= 0;
  f.health = stats.maxHealth;
  f.guard = stats.maxGuard;
  f.guardBroken = false;
  f.burst = RULES.burstMax;
  f.koTimer = 0;
  f.hitstop = 0;
  f.lockTarget = -1;
  enterState(f, f.grounded ? 'ground' : 'air');
  sim.emit({ type: 'respawn', fighter: f.id });
}

// ==========================================================================
// Dodge

function startDodge(sim: FighterHost, f: FighterState, input: InputFrame): void {
  const air = !f.grounded;
  let w = wishDir(f, input);
  const l = Math.hypot(w.x, w.z);
  if (l < 0.1) {
    const fw = forwardFromYaw(f.yaw);
    w = vec3(-fw.x, 0, -fw.z); // neutral dodge = backstep
  } else {
    w = vec3(w.x / l, 0, w.z / l);
  }
  if (air) {
    f.dodgeInvulnEnd = RULES.airDodge.invulnEnd;
    f.airDodged = true;
  } else {
    const D = RULES.dodge;
    f.dodgeChain = f.dodgeChainTimer > 0 ? f.dodgeChain + 1 : 0;
    f.dodgeChainTimer = D.chainReset;
    f.dodgeInvulnEnd = Math.max(D.invulnStart + D.minInvuln - 1, D.invulnEnd - f.dodgeChain * D.chainPenalty);
  }
  f.dodgeAir = air;
  f.dodgeDirX = w.x;
  f.dodgeDirZ = w.z;
  f.perfectDodged = false;
  f.dodgeCounter = false;
  enterState(f, 'dodge');
  dodgeVelocity(f);
  sim.emit({ type: 'dodge', fighter: f.id });
}

function dodgeVelocity(f: FighterState): void {
  const D = f.dodgeAir ? RULES.airDodge : RULES.dodge;
  const fr = f.stateFrame;
  const fast = f.dodgeInvulnEnd + 2;
  let speed: number;
  if (fr <= fast) speed = D.speed * (1 - (0.45 * Math.max(0, fr - 1)) / fast);
  else speed = D.speed * 0.55 * Math.max(0, 1 - (fr - fast) / Math.max(1, D.frames - fast));
  f.vel.x = f.dodgeDirX * speed;
  f.vel.z = f.dodgeDirZ * speed;
  if (f.dodgeAir && fr <= f.dodgeInvulnEnd) f.vel.y = 0;
}

function stateDodge(sim: FighterHost, f: FighterState, input: InputFrame): void {
  const D = f.dodgeAir ? RULES.airDodge : RULES.dodge;
  faceFree(sim, f, input);
  // Perfect dodge reward: counter-attack straight out of the dodge.
  if (f.dodgeCounter && tryCommand(sim, f, input)) return;
  dodgeVelocity(f);
  if (f.stateFrame >= D.frames) {
    const sprint = !f.dodgeAir && isHeld(f.input, Button.DODGE) && Math.hypot(input.moveX, input.moveY) > 0.3;
    toNeutral(sim, f, input);
    if (sprint && f.state === 'ground') f.running = true;
  }
}

// ==========================================================================
// Attacks

export function startMove(sim: FighterHost, f: FighterState, id: string): void {
  const m = sim.moveById(f.charId, id);
  if (!m) return;
  enterState(f, 'attack');
  f.move = id;
  f.moveFrame = 1;
  f.moveHit = false;
  f.moveBlocked = false;
  f.registry = [];
  f.chargeFrames = 0;
  f.charging = false;
  f.armorLeft = m.armor?.hits ?? 0;
  f.meter -= m.meterCost ?? 0;
  f.lungeLeft = m.lunge ?? RULES.defaultLunge[m.kind];
  f.moveTarget = pickMoveTarget(sim, f, m)?.id ?? -1;
  sim.emit({ type: 'attack', fighter: f.id, move: id });
  if (m.kind === 'super') sim.emit({ type: 'super', fighter: f.id, move: id });
  applyMoveFrame(sim, f, m, f.lastInput);
}

function pickMoveTarget(sim: FighterHost, f: FighterState, m: MoveDef): FighterState | null {
  const range = moveReach(m) + (m.lunge ?? RULES.defaultLunge[m.kind]) + RULES.autoTargetExtraRange;
  const lock = lockedTarget(sim, f);
  if (lock && distance(lock.pos, f.pos) <= Math.max(range, 8)) return lock;
  return bestTarget(sim, f, f.yaw, range, RULES.autoTargetCone);
}

function stateAttack(sim: FighterHost, f: FighterState, input: InputFrame): void {
  const m = sim.moveOf(f);
  if (!m) {
    toNeutral(sim, f, input);
    return;
  }
  if (f.charging) {
    const c = m.charge!;
    if (isHeld(f.input, c.button) && f.chargeFrames < c.maxFrames) {
      f.chargeFrames++;
      steer(sim, f, m, input, true);
      if (f.grounded) applyFriction(f, sim.statsOf(f).groundAccel);
      return;
    }
    f.charging = false;
  }
  const next = f.moveFrame + 1;
  if (tryCancels(sim, f, m, next, input)) return;
  if (next > totalFrames(m)) {
    finishMove(sim, f, m, input);
    return;
  }
  f.moveFrame = next;
  applyMoveFrame(sim, f, m, input);
}

function finishMove(sim: FighterHost, f: FighterState, m: MoveDef, input: InputFrame): void {
  if (f.grounded) {
    enterState(f, 'ground');
    stateGround(sim, f, input);
    return;
  }
  enterState(f, 'air');
  f.helpless = !!m.endHelpless;
  f.pendingLandLag = m.landingLag ?? RULES.landingLag;
  stateAir(sim, f, input);
}

/**
 * Cancel routes, checked on the frame the move would advance to:
 *   1. explicit chain routes (target combos / strings)
 *   2. jump cancel (launchers)
 *   3. system cancels: normal -> special/super on contact, special -> super on hit
 *   4. ki cancel: spend meter to cancel anything into a dodge
 */
function tryCancels(sim: FighterHost, f: FighterState, m: MoveDef, frame: number, input: InputFrame): boolean {
  const contact = f.moveHit || f.moveBlocked;
  const ok = (on: 'always' | 'contact' | 'hit'): boolean =>
    on === 'always' || (on === 'contact' && contact) || (on === 'hit' && f.moveHit);

  const dir = stickDir(input);
  for (const c of m.cancels ?? []) {
    if (!inFrames(c.frames, frame) || !ok(c.on) || !buffered(f.input, c.button)) continue;
    if (c.dir && c.dir !== dir) continue;
    const into = sim.moveById(f.charId, c.into);
    if (!into || (into.meterCost ?? 0) > f.meter) continue;
    consume(f.input, c.button);
    startMove(sim, f, c.into);
    return true;
  }

  const jc = m.jumpCancel;
  if (jc && inFrames(jc.frames, frame) && ok(jc.on) && buffered(f.input, Button.JUMP)) {
    consume(f.input, Button.JUMP);
    doJump(sim, f, input, !!jc.high);
    return true;
  }

  if (frame > m.startup) {
    if ((m.kind === 'light' || m.kind === 'heavy') && contact) {
      if (tryCommand(sim, f, input, (n) => n.kind === 'special' || n.kind === 'super')) return true;
    } else if (m.kind === 'special' && f.moveHit) {
      if (tryCommand(sim, f, input, (n) => n.kind === 'super')) return true;
    }
  }

  if (m.kind !== 'super' && f.meter >= RULES.kiCancelCost && buffered(f.input, Button.DODGE, 2)) {
    consume(f.input, Button.DODGE);
    f.meter -= RULES.kiCancelCost;
    sim.emit({ type: 'kiCancel', fighter: f.id });
    startDodge(sim, f, input);
    return true;
  }
  return false;
}

/** Rotates toward the target (strong during startup, slight afterwards). */
function steer(sim: FighterHost, f: FighterState, m: MoveDef, input: InputFrame, startup: boolean): void {
  const t = f.moveTarget >= 0 ? sim.fighter(f.moveTarget) : undefined;
  const target = t && t.state !== 'ko' ? t : null;
  const rate = startup ? (m.tracking ?? RULES.defaultTracking[m.kind]) : RULES.attackTurnRate;
  if (target) {
    f.yaw = approachAngle(f.yaw, yawTo(f.pos, target.pos), rate);
    f.aimPitch = approach(f.aimPitch, pitchTo(sim, f, target), rate);
  } else {
    const free = startup ? RULES.attackTurnRate * 2 : RULES.attackTurnRate;
    f.yaw = approachAngle(f.yaw, input.yaw, free);
    f.aimPitch = approach(f.aimPitch, clamp(input.pitch, -1.4, 1.4), free);
  }
}

/** Per-frame effects of a move: steering, lunge, root motion, projectiles. */
function applyMoveFrame(sim: FighterHost, f: FighterState, m: MoveDef, input: InputFrame): void {
  const fr = f.moveFrame;
  const startup = fr <= m.startup + 1;
  steer(sim, f, m, input, startup);

  let vx: number | null = null;
  let vz: number | null = null;
  const fw = forwardFromYaw(f.yaw);
  const rt = rightFromYaw(f.yaw);
  for (const mo of m.motion ?? []) {
    if (!inFrames(mo.frames, fr)) continue;
    const fwd = mo.fwd ?? 0;
    const side = mo.side ?? 0;
    vx = fw.x * fwd + rt.x * side;
    vz = fw.z * fwd + rt.z * side;
    if (mo.up !== undefined) {
      f.vel.y = mo.up;
      if (mo.up > 0) f.grounded = false;
    }
  }

  const lunge = lungeVelocity(sim, f, m);
  if (lunge) {
    vx = (vx ?? 0) + lunge.x;
    vz = (vz ?? 0) + lunge.z;
    if (m.air) f.vel.y = lunge.y;
  }

  if (vx !== null && vz !== null) {
    f.vel.x = vx;
    f.vel.z = vz;
  } else if (f.grounded) {
    applyFriction(f, sim.statsOf(f).groundAccel);
  }

  m.projectiles?.forEach((p, i) => {
    if (p.frame === fr) spawnProjectile(sim, f, m, i);
  });

  if (m.charge && fr === m.charge.frame && isHeld(f.input, m.charge.button)) f.charging = true;
}

/**
 * Magnetism: during startup, close the gap to the target so the move's
 * hitbox lands. Budgeted per move (RULES.defaultLunge / MoveDef.lunge).
 */
function lungeVelocity(sim: FighterHost, f: FighterState, m: MoveDef): Vec3 | null {
  if (f.moveTarget < 0 || f.moveFrame > m.startup || f.lungeLeft <= 0) return null;
  const t = sim.fighter(f.moveTarget);
  if (!t || t.state === 'ko') return null;
  const ts = sim.statsOf(t);
  const gap = hDistance(f.pos, t.pos) - ts.radius;
  const want = gap - moveReach(m) * RULES.lungeReachFraction;
  const framesLeft = m.startup - f.moveFrame + 1;
  let vy = 0;
  if (m.air) {
    const dy = t.pos.y + chestHeight(ts) - (f.pos.y + chestHeight(sim.statsOf(f)));
    vy = clamp(dy / framesLeft, -0.12, 0.12) / DT;
  }
  if (want <= 0) return m.air ? vec3(0, vy, 0) : null;
  const step = Math.min(want, f.lungeLeft) / framesLeft;
  f.lungeLeft -= step;
  const dx = t.pos.x - f.pos.x;
  const dz = t.pos.z - f.pos.z;
  const d = Math.hypot(dx, dz) || 1;
  return vec3((dx / d) * (step / DT), vy, (dz / d) * (step / DT));
}

// ==========================================================================
// Grabs and burst

function stateGrabbing(sim: FighterHost, f: FighterState, input: InputFrame): void {
  const v = sim.fighter(f.grabPartner);
  const m = f.grabMove ? sim.moveById(f.charId, f.grabMove) : null;
  const holding = v && v.state === 'grabbed' && v.grabPartner === f.id;
  const execFrame = RULES.throwTechWindow + 1;
  if (!m?.throw || (!holding && f.stateFrame <= execFrame)) {
    f.grabPartner = -1;
    toNeutral(sim, f, input);
    return;
  }
  if (holding && v) {
    pinVictim(sim, f, v);
    if (f.stateFrame === execFrame) {
      // The tech window is over: throw.
      v.grabPartner = -1;
      f.grabPartner = -1;
      enterState(v, 'hitstun');
      const stats = sim.statsOf(v);
      resolveHit(sim, {
        attacker: f,
        victim: v,
        hit: m.throw.hit,
        move: m,
        point: vec3(v.pos.x, v.pos.y + stats.height * 0.6, v.pos.z),
        kbYaw: f.yaw,
        from: f.pos,
        source: 'throw',
      });
      sim.emit({ type: 'throw', attacker: f.id, victim: v.id });
    }
  }
  if (f.stateFrame >= execFrame + m.throw.recovery) toNeutral(sim, f, input);
}

function stateGrabbed(sim: FighterHost, f: FighterState, input: InputFrame): void {
  const a = sim.fighter(f.grabPartner);
  if (!a || a.state !== 'grabbing' || a.grabPartner !== f.id) {
    f.grabPartner = -1;
    toNeutral(sim, f, input);
    return;
  }
  if (f.stateFrame <= RULES.throwTechWindow && buffered(f.input, Button.GRAB)) {
    consume(f.input, Button.GRAB);
    throwTech(sim, a, f);
  }
}

const BURST_HIT: HitDef = {
  damage: 0,
  hitstun: RULES.burst.hitstun,
  blockstun: 20,
  hitstop: 12,
  knockback: { fwd: RULES.burst.knockback, up: RULES.burst.up },
  blockPush: 9,
  launch: true,
  parryable: false,
  juggleCost: 0,
  effect: 'burst',
};

function stateBurst(sim: FighterHost, f: FighterState, input: InputFrame): void {
  const B = RULES.burst;
  f.vel.x *= 0.8;
  f.vel.z *= 0.8;
  if (!f.grounded) f.vel.y = Math.max(f.vel.y, -1);
  if (f.stateFrame === B.activeFrame) {
    const c = chestPos(f, sim.statsOf(f));
    for (const e of sim.state.fighters) {
      if (e.team === f.team || e.state === 'ko') continue;
      const ec = chestPos(e, sim.statsOf(e));
      if (distance(c, ec) > B.radius) continue;
      resolveHit(sim, {
        attacker: f,
        victim: e,
        hit: BURST_HIT,
        move: null,
        point: ec,
        kbYaw: yawTo(f.pos, e.pos),
        from: f.pos,
        source: 'burst',
      });
    }
  }
  if (f.stateFrame >= B.frames) toNeutral(sim, f, input);
}

// ==========================================================================
// Physics reactions (called by the simulation after integration)

export function gravityScale(sim: FighterHost, f: FighterState): number {
  switch (f.state) {
    case 'wallsplat':
    case 'grabbed':
      return 0;
    case 'juggle':
      return Math.min(RULES.comboGravityMax, 1 + f.combo.hits * RULES.comboGravityPerHit);
    case 'attack':
      return sim.moveOf(f)?.gravityScale ?? 1;
    case 'dodge':
      return f.dodgeAir && f.stateFrame <= f.dodgeInvulnEnd ? 0 : 1;
    case 'burst':
      return 0.25;
    default:
      return 1;
  }
}

export function onLand(sim: FighterHost, f: FighterState): void {
  switch (f.state) {
    case 'air': {
      const lag = f.helpless ? f.pendingLandLag : RULES.landingLag;
      f.helpless = false;
      enterState(f, 'land', lag);
      sim.emit({ type: 'land', fighter: f.id });
      break;
    }
    case 'attack': {
      const m = sim.moveOf(f);
      if (m?.air) {
        enterState(f, 'land', m.landingLag ?? RULES.airAttackLandingLag);
        sim.emit({ type: 'land', fighter: f.id });
      }
      break;
    }
    case 'dodge':
      if (f.dodgeAir) enterState(f, 'land', RULES.landingLag);
      break;
    case 'juggle': {
      if (f.impact.groundBounce && !f.combo.groundBounceUsed) {
        f.combo.groundBounceUsed = true;
        f.impact.groundBounce = false;
        f.vel.y = RULES.groundBounceVelocity / Math.sqrt(sim.statsOf(f).weight);
        f.vel.x *= 0.5;
        f.vel.z *= 0.5;
        f.grounded = false;
        f.stun = Math.max(f.stun, 20);
        sim.emit({ type: 'groundBounce', fighter: f.id, point: clone(f.pos) });
        break;
      }
      if (!f.impact.hardKnockdown && buffered(f.input, Button.DODGE, RULES.groundTechBuffer)) {
        consume(f.input, Button.DODGE);
        startTech(sim, f, f.lastInput, 'ground');
        break;
      }
      enterState(f, 'knockdown');
      sim.emit({ type: 'knockdown', fighter: f.id });
      break;
    }
    default:
      break;
  }
}

export function onWall(sim: FighterHost, f: FighterState, c: WallContact): void {
  const into = c.speed;
  if (into <= 0) return;
  if ((f.state === 'juggle' || f.state === 'hitstun') && into >= RULES.wallImpactSpeed) {
    if (f.impact.wallSplat && !f.combo.wallSplatUsed) {
      f.combo.wallSplatUsed = true;
      f.impact.wallSplat = false;
      enterState(f, 'wallsplat', RULES.wallSplatFrames);
      f.vel = vec3();
      f.wallNX = c.nx;
      f.wallNZ = c.nz;
      sim.emit({ type: 'wallSplat', fighter: f.id, point: clone(f.pos) });
      return;
    }
    if (f.impact.wallBounce && !f.combo.wallBounceUsed) {
      f.combo.wallBounceUsed = true;
      f.impact.wallBounce = false;
      const e = 1 + RULES.wallBounceRestitution;
      f.vel.x += c.nx * into * e;
      f.vel.z += c.nz * into * e;
      f.vel.y = Math.max(f.vel.y, 5);
      if (f.state === 'hitstun') enterState(f, 'juggle', Math.max(f.stun, 20));
      f.grounded = false;
      sim.emit({ type: 'wallBounce', fighter: f.id, point: clone(f.pos) });
      return;
    }
  }
  // Otherwise just slide along the wall.
  f.vel.x += c.nx * into;
  f.vel.z += c.nz * into;
}
