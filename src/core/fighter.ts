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
import { enterState, releaseGrab, spendStamina } from './fighterUtil';
import {
  Button,
  buffered,
  consume,
  feedInput,
  type InputFrame,
  isHeld,
  pressSwipe,
  stickDir,
} from './input';
import {
  approach,
  approachAngle,
  clamp,
  DEG,
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
import { armorOf, chestHeight, chestPos, inFrames, lastActiveFrame, moveReach, totalFrames } from './moves';
import { accelerateTo, applyFriction, type WallContact } from './physics';
import { flightRange, planShot, type ProjectileHost, spawnProjectile } from './projectiles';
import type { RicochetPlan } from './ricochet';
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

const STRIKE_BUTTONS = Button.LIGHT | Button.HEAVY | Button.KICK;

export function updateFighter(sim: FighterHost, f: FighterState, input: InputFrame): void {
  const frozen = f.hitstop > 0;
  const fresh = input.buttons & ~f.input.prevButtons & STRIKE_BUTTONS;
  // Both attack buttons together is a throw, not mashing.
  const chord = (input.buttons & ~f.input.prevButtons & Button.GRAB) !== 0;
  feedInputFrame(f, input, frozen);
  if (fresh && !chord && f.state === 'attack') judgePress(sim, f, fresh);
  if (f.shake > 0) f.shake--;
  if (frozen) {
    f.hitstop--;
    return;
  }
  // Exposed by a perfect dodge: the overextended attacker acts at half speed.
  if (f.exposed > 0 && f.exposed-- % 2 === 1) return;
  tickTimers(f);
  // Exhausted fighters strike slowly: every Nth frame of an attack is lost.
  if (f.exhausted && f.state === 'attack' && ++f.slowAccum % RULES.stamina.exhaustedSlowEvery === 0) return;
  f.stateFrame++;
  updateLock(sim, f);
  runState(sim, f, input);
}

/**
 * Rhythm, not mashing: a strike press during another strike's wind-up (the
 * blow hasn't even come out) locks that strike's chain. A press on impact or
 * right after it is "on beat" and builds rhythm.
 */
function judgePress(sim: FighterHost, f: FighterState, buttons: number): void {
  const m = sim.moveOf(f);
  if (!m || !flows(m) || f.charging) return;
  const contact = f.moveHit || f.moveBlocked;
  if (!contact && f.moveFrame <= m.startup) {
    for (const b of [Button.LIGHT, Button.HEAVY, Button.KICK]) if (buttons & b) consume(f.input, b);
    if (!f.mashed) {
      f.mashed = true;
      sim.emit({ type: 'mash', fighter: f.id });
    }
    return;
  }
  if (contact && f.moveFrame <= lastActiveFrame(m) + RULES.beatWindow) f.onBeat = true;
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
  if (f.lastHand !== '' && ++f.handTimer > RULES.handResetFrames) f.lastHand = '';
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
  /** Enemies closer than this count even outside the cone (lock-on convenience). */
  closeRange = 1.2,
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
    if (ang > cone && dh > closeRange) continue;
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

const clampPitch = (p: number): number => clamp(p, -1.4, 1.4);

/** Where the player is looking (camera), or the lock-on target if locked. */
function lookTarget(sim: FighterHost, f: FighterState, input: InputFrame): { yaw: number; pitch: number } {
  const t = lockedTarget(sim, f);
  if (t) return { yaw: yawTo(f.pos, t.pos), pitch: pitchTo(sim, f, t) };
  return { yaw: wrapAngle(input.yaw), pitch: clampPitch(input.pitch) };
}

/** Facing in neutral states: follow the camera exactly (or turn toward the lock-on target). */
function faceFree(sim: FighterHost, f: FighterState, input: InputFrame): void {
  if (lockedTarget(sim, f)) {
    turnToward(sim, f, input, RULES.lockTurnRate);
    return;
  }
  f.yaw = wrapAngle(input.yaw);
  f.aimPitch = clampPitch(input.pitch);
}

/** Turns the body toward where the player looks, at most `rate` radians per frame. */
function turnToward(sim: FighterHost, f: FighterState, input: InputFrame, rate: number): void {
  const look = lookTarget(sim, f, input);
  f.yaw = approachAngle(f.yaw, look.yaw, rate);
  f.aimPitch = approach(f.aimPitch, look.pitch, rate);
}

/** Camera-relative stick as a world-space direction (length <= 1). */
function wishDir(f: FighterState, input: InputFrame): Vec3 {
  const m = Math.hypot(input.moveX, input.moveY);
  if (m < 0.1) return vec3();
  const k = Math.min(1, m) / m;
  // Movement is relative to the camera, which may differ from the body during attacks.
  const yaw = f.lockTarget >= 0 ? f.yaw : input.yaw;
  return localDirToWorld(yaw, input.moveX * k, input.moveY * k);
}

// ==========================================================================
// Neutral states

function findCommand(
  sim: FighterHost,
  f: FighterState,
  input: InputFrame,
  filter?: (m: MoveDef) => boolean,
  /** Position the next strike would take in the current string (1 = opener). */
  seq = 1,
): CommandDef | null {
  const dir = stickDir(input);
  const air = !f.grounded;
  for (const cmd of sim.charCommands(f)) {
    if (!buffered(f.input, cmd.button)) continue;
    // Moves on the dash button replace dashes: out of reach while exhausted, like a dash.
    if (cmd.button === Button.DODGE && f.exhausted) continue;
    if (cmd.air !== undefined && cmd.air !== air) continue;
    if (cmd.seq && (seq < cmd.seq[0] || seq > cmd.seq[1])) continue;
    if (cmd.dir && cmd.dir !== dir) continue;
    if (cmd.swipe && cmd.swipe !== pressSwipe(f.input, cmd.button)) continue;
    if (cmd.afterHand && cmd.afterHand !== f.lastHand) continue;
    if (cmd.running && !f.running) continue;
    if (cmd.context === 'targetDown' && !enemyDownInFront(sim, f)) continue;
    const m = sim.moveById(f.charId, cmd.move);
    if (!m || (m.meterCost ?? 0) > f.meter) continue;
    if (m.usesAirDash && air && f.airDodged) continue;
    if (filter && !filter(m)) continue;
    // Auto-aimed shots only come out when they can actually reach someone:
    // no path, no shot (and no meter spent), the next command gets its turn.
    if (m.autoAim && !autoAimPlan(sim, f, m)) continue;
    return cmd;
  }
  return null;
}

/** An opponent lying on the ground right in front of the fighter (for stomps). */
function enemyDownInFront(sim: FighterHost, f: FighterState): boolean {
  for (const e of sim.state.fighters) {
    if (e.team === f.team || e.state !== 'knockdown') continue;
    const dx = e.pos.x - f.pos.x;
    const dz = e.pos.z - f.pos.z;
    if (Math.hypot(dx, dz) > 2.3) continue;
    if (Math.abs(wrapAngle(yawFromDir(dx, dz) - f.yaw)) < 60 * (Math.PI / 180)) return true;
  }
  return false;
}

function tryCommand(
  sim: FighterHost,
  f: FighterState,
  input: InputFrame,
  filter?: (m: MoveDef) => boolean,
  seq = 1,
): boolean {
  const cmd = findCommand(sim, f, input, filter, seq);
  if (!cmd) return false;
  consume(f.input, cmd.button);
  // A throw is both attack buttons: neither should also come out as a strike.
  if (cmd.button === Button.GRAB) {
    consume(f.input, Button.LIGHT);
    consume(f.input, Button.HEAVY);
  }
  startMove(sim, f, cmd.move, seq);
  return true;
}

function tryGroundActions(sim: FighterHost, f: FighterState, input: InputFrame, allowBlock: boolean): boolean {
  if (tryCommand(sim, f, input)) return true;
  if (buffered(f.input, Button.DODGE) && !f.exhausted) {
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
  if (buffered(f.input, Button.DODGE) && !f.airDodged && !f.exhausted) {
    consume(f.input, Button.DODGE);
    startDodge(sim, f, input);
    return true;
  }
  if (buffered(f.input, Button.JUMP) && f.airJumpsLeft > 0) {
    consume(f.input, Button.JUMP);
    const stats = sim.statsOf(f);
    const w = wishDir(f, input);
    f.airJumpsLeft--;
    spendStamina(sim, f, RULES.stamina.jump);
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
  if (f.running && !(moving && isHeld(f.input, Button.DODGE) && !f.exhausted)) f.running = false;
  if (f.running) spendStamina(sim, f, RULES.stamina.sprint);
  const speed = (f.running ? stats.runSpeed : stats.walkSpeed) * (f.exhausted ? RULES.stamina.exhaustedMove : 1);
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
  if (!high) spendStamina(sim, f, RULES.stamina.jump);
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
  // A raised guard turns slowly: flanking a blocking opponent works.
  turnToward(sim, f, input, RULES.blockTurnRate);
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
  turnToward(sim, f, input, RULES.blockTurnRate);
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

/**
 * Combo breaker: BURST, or simply BLOCK ("defend!") while stunned with a full
 * burst gauge. DODGE stays free for techs and rolls.
 */
function tryBurst(sim: FighterHost, f: FighterState, viaBlock = true): boolean {
  if (f.burst < RULES.burstMax) return false;
  if (buffered(f.input, Button.BURST)) consume(f.input, Button.BURST);
  else if (viaBlock && buffered(f.input, Button.BLOCK)) consume(f.input, Button.BLOCK);
  else return false;
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
  turnToward(sim, f, input, RULES.stunTurnRate);
  applyFriction(f, RULES.stunFriction);
  if (f.stun > 0) {
    f.stun--;
    return;
  }
  f.gap = true;
  toNeutral(sim, f, input);
}

function stateJuggle(sim: FighterHost, f: FighterState, input: InputFrame): void {
  if (tryBurst(sim, f, f.stun > 0)) return;
  if (f.stun > 0) {
    f.stun--;
    return;
  }
  if (f.impact.hardKnockdown) return;
  // Hitstun is over: the victim may recover in the air at any moment now.
  f.gap = true;
  const w = RULES.airTechBuffer;
  for (const b of [Button.JUMP, Button.DODGE]) {
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
  turnToward(sim, f, input, RULES.stunTurnRate);
  applyFriction(f, RULES.stunFriction);
  if (f.stun > 0) {
    f.stun--;
    return;
  }
  if (f.guardBroken) {
    f.stamina = Math.max(f.stamina, sim.statsOf(f).maxStamina * RULES.stamina.afterGuardBreak);
    f.guardBroken = false;
    f.exhausted = false;
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
  turnToward(sim, f, input, RULES.stunTurnRate);
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
  f.stamina = stats.maxStamina;
  f.exhausted = false;
  f.guardBroken = false;
  f.burst = RULES.burstMax;
  f.koTimer = 0;
  f.hitstop = 0;
  f.lockTarget = -1;
  f.burn = 0;
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
  spendStamina(sim, f, air ? RULES.stamina.airDodge : RULES.stamina.dodge);
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
  // A side dash next to an enemy circles around it: you slip past the strike
  // and stay in range to answer, instead of drifting out of the fight.
  f.dodgeOrbit = -1;
  const side = stickDir(input);
  f.dodgeSpeed = !air && (side === 'back' || side === 'neutral') ? RULES.dodge.backSpeed : 1;
  if (!air && (side === 'left' || side === 'right')) {
    const t = lockedTarget(sim, f) ?? bestTarget(sim, f, f.yaw, RULES.dodge.orbitRange, 75 * DEG, 0);
    if (t && hDistance(t.pos, f.pos) <= RULES.dodge.orbitRange) {
      f.dodgeOrbit = t.id;
      f.dodgeRadius = clamp(hDistance(t.pos, f.pos), 1.1, RULES.dodge.orbitRange);
    }
  }
  enterState(f, 'dodge');
  dodgeVelocity(sim, f);
  sim.emit({ type: 'dodge', fighter: f.id });
}

function dodgeVelocity(sim: FighterHost, f: FighterState): void {
  const D = f.dodgeAir ? RULES.airDodge : RULES.dodge;
  const fr = f.stateFrame;
  const fast = f.dodgeInvulnEnd + 2;
  let speed: number;
  if (fr <= fast) speed = D.speed * (1 - (0.45 * Math.max(0, fr - 1)) / fast);
  else speed = D.speed * 0.55 * Math.max(0, 1 - (fr - fast) / Math.max(1, D.frames - fast));
  speed *= f.dodgeSpeed;
  const t = f.dodgeOrbit >= 0 ? sim.fighter(f.dodgeOrbit) : undefined;
  if (t && t.state !== 'ko') {
    // Tangent around the enemy (same turning sense as the dash so far),
    // plus a pull that keeps the circling radius.
    const rx = f.pos.x - t.pos.x;
    const rz = f.pos.z - t.pos.z;
    const d = Math.hypot(rx, rz) || 1;
    let tx = -rz / d;
    let tz = rx / d;
    if (tx * f.dodgeDirX + tz * f.dodgeDirZ < 0) {
      tx = -tx;
      tz = -tz;
    }
    f.dodgeDirX = tx;
    f.dodgeDirZ = tz;
    const pull = (f.dodgeRadius - d) * 8;
    f.vel.x = tx * speed + (rx / d) * pull;
    f.vel.z = tz * speed + (rz / d) * pull;
    return;
  }
  f.vel.x = f.dodgeDirX * speed;
  f.vel.z = f.dodgeDirZ * speed;
  if (f.dodgeAir && fr <= f.dodgeInvulnEnd) f.vel.y = 0;
}

function stateDodge(sim: FighterHost, f: FighterState, input: InputFrame): void {
  const D = f.dodgeAir ? RULES.airDodge : RULES.dodge;
  faceFree(sim, f, input);
  // Perfect dodge reward: counter-attack straight out of the dodge.
  if (f.dodgeCounter && tryCommand(sim, f, input)) return;
  dodgeVelocity(sim, f);
  if (f.stateFrame >= D.frames) {
    const sprint = !f.dodgeAir && isHeld(f.input, Button.DODGE) && Math.hypot(input.moveX, input.moveY) > 0.3;
    toNeutral(sim, f, input);
    if (sprint && f.state === 'ground') f.running = true;
  }
}

// ==========================================================================
// Attacks

export function startMove(sim: FighterHost, f: FighterState, id: string, seq = 1): void {
  const m = sim.moveById(f.charId, id);
  if (!m) return;
  enterState(f, 'attack');
  f.stringPos = seq;
  f.move = id;
  f.moveFrame = 1;
  f.moveHit = false;
  f.moveBlocked = false;
  f.registry = [];
  f.chargeFrames = 0;
  f.charging = false;
  f.armorLeft = armorOf(m)?.hits ?? 0;
  f.extraRecovery = 0;
  f.slowAccum = 0;
  f.moveAbsorbed = false;
  f.mashed = false;
  f.onBeat = false;
  f.rhythm = 0;
  f.meter -= m.meterCost ?? 0;
  if (m.usesAirDash && !f.grounded) f.airDodged = true;
  f.autoAim = false;
  spendStamina(sim, f, m.stamina ?? RULES.staminaCost[m.kind]);
  if (m.hand) {
    f.lastHand = m.hand;
    f.handTimer = 0;
  }
  // Step-in budget: holding forward commits further, holding back keeps your
  // distance (unless the move sets its own lunge, e.g. back+kick sweep).
  const dir = stickDir(f.lastInput);
  const lunge = m.lunge ?? RULES.defaultLunge[m.kind];
  if (dir === 'back' && m.lunge === undefined) f.lungeLeft = 0;
  else f.lungeLeft = lunge + (dir === 'forward' && lunge > 0 ? RULES.lungeForwardBonus : 0);
  // A bank shot is aimed by hand at a wall: no body aim assist pulling it toward an enemy.
  const banked = !!m.projectiles?.some((p) => p.bounces !== undefined);
  f.moveTarget = banked ? -1 : (pickAssistTarget(sim, f, m)?.id ?? -1);
  const auto = m.autoAim ? autoAimPlan(sim, f, m) : null;
  if (auto) {
    // The visor has computed the shot: turn to where the beam has to leave.
    f.autoAim = true;
    f.moveTarget = auto.target.id;
    f.autoYaw = yawFromDir(auto.plan.dir.x, auto.plan.dir.z);
    f.autoPitch = Math.asin(clamp(auto.plan.dir.y, -1, 1));
    f.lungeLeft = 0;
  }
  sim.emit({ type: 'attack', fighter: f.id, move: id });
  if (auto) sim.emit({ type: 'ricochetPlan', fighter: f.id, target: auto.target.id, points: auto.plan.points.map(clone) });
  if (m.kind === 'super') sim.emit({ type: 'super', fighter: f.id, move: id });
  applyMoveFrame(sim, f, m, f.lastInput);
}

interface AutoAim {
  target: FighterState;
  plan: RicochetPlan;
}

/**
 * Plans of this tick, per simulation state (a press can be looked at several
 * times per tick; a restored snapshot is a new state object, so it never sees
 * a plan made for another timeline).
 */
const autoAimMemo = new WeakMap<object, { frame: number; plans: Map<string, AutoAim | null> }>();

/**
 * Auto-aim of a ricochet: the lock-on target first, then every enemy by how
 * close it is to the crosshair (anywhere around, even behind), until one of
 * them can be reached by a bounce path from the eyes.
 */
export function autoAimPlan(sim: FighterHost, f: FighterState, m: MoveDef): AutoAim | null {
  const def = m.projectiles?.[0];
  if (!m.autoAim || !def) return null;
  let memo = autoAimMemo.get(sim.state);
  if (!memo || memo.frame !== sim.state.frame) {
    memo = { frame: sim.state.frame, plans: new Map() };
    autoAimMemo.set(sim.state, memo);
  }
  const key = `${f.id}:${m.id}:${f.pos.x},${f.pos.y},${f.pos.z}`;
  const known = memo.plans.get(key);
  if (known !== undefined) return known;
  const look = wrapAngle(f.lastInput.yaw);
  const lock = lockedTarget(sim, f);
  const enemies = sim.state.fighters
    .filter((e) => e.team !== f.team && e.state !== 'ko')
    .map((e) => ({ e, s: e === lock ? -1 : Math.abs(wrapAngle(yawTo(f.pos, e.pos) - look)) * 4 + hDistance(f.pos, e.pos) }))
    .sort((a, b) => a.s - b.s || a.e.id - b.e.id);
  const from = vec3(f.pos.x, f.pos.y + def.offset[1], f.pos.z);
  let out: AutoAim | null = null;
  for (const { e } of enemies.slice(0, 3)) {
    const plan = planShot(sim, from, e, m.autoAim.maxBounces, flightRange(def));
    if (plan) {
      out = { target: e, plan };
      break;
    }
  }
  memo.plans.set(key, out);
  return out;
}

/**
 * Aim assist target: the lock-on target, or an enemy close to the crosshair
 * and within reach. It only nudges the body and steps in; the camera is never moved.
 */
function pickAssistTarget(sim: FighterHost, f: FighterState, m: MoveDef): FighterState | null {
  const range = moveReach(m) + f.lungeLeft + RULES.assistExtraRange;
  const lock = lockedTarget(sim, f);
  if (lock && distance(lock.pos, f.pos) <= Math.max(range, 8)) return lock;
  return bestTarget(sim, f, wrapAngle(f.lastInput.yaw), range, RULES.assistCone, 0);
}

/** First move frame on which `button` can chain out of `m` (for bots, tests and tooling). */
export function chainWindowStart(m: MoveDef, button: number, contact: boolean): number {
  const explicit = m.cancels?.find((c) => c.button === button);
  if (explicit) return explicit.frames[0];
  if (button === Button.JUMP && m.jumpCancel) return m.jumpCancel.frames[0];
  if (flows(m) && contact) return lastActiveFrame(m) + 1;
  return totalFrames(m) + 1;
}

const flows = (m: MoveDef): boolean => m.flow ?? (m.kind === 'light' || m.kind === 'heavy');
const isStrike = (m: MoveDef): boolean => m.kind === 'light' || m.kind === 'heavy';

function stateAttack(sim: FighterHost, f: FighterState, input: InputFrame): void {
  const m = sim.moveOf(f);
  if (!m) {
    toNeutral(sim, f, input);
    return;
  }
  // Feint: BLOCK during early startup of a heavy cancels it (bait parries, mix up timing).
  const canFeint = m.feint ?? m.kind === 'heavy';
  if (canFeint && f.moveFrame <= m.startup - RULES.feintLock && buffered(f.input, Button.BLOCK, 2)) {
    consume(f.input, Button.BLOCK);
    sim.emit({ type: 'feint', fighter: f.id });
    if (isHeld(f.input, Button.BLOCK)) enterState(f, 'block');
    else toNeutral(sim, f, input);
    return;
  }
  // The second attack button a moment after the first: it was a throw.
  if (f.stringPos === 1 && f.moveFrame <= 4 && m.kind !== 'throw' && buffered(f.input, Button.GRAB, 4)) {
    if (tryCommand(sim, f, input, (n) => n.kind === 'throw')) return;
  }
  if (f.charging) {
    const c = m.charge!;
    if (isHeld(f.input, c.button) && f.chargeFrames < c.maxFrames) {
      f.chargeFrames++;
      steer(sim, f, m, input);
      moveDuringAttack(sim, f, m, input, null, null);
      return;
    }
    f.charging = false;
  }
  const next = f.moveFrame + 1;
  if (tryCancels(sim, f, m, next, input)) return;
  if (next > totalFrames(m) + f.extraRecovery) {
    finishMove(sim, f, m, input);
    return;
  }
  f.moveFrame = next;
  if (next === lastActiveFrame(m) + 1) checkWhiff(sim, f, m);
  applyMoveFrame(sim, f, m, input);
}

/**
 * A strike whose active frames ended without touching anyone was a miss:
 * extra recovery, and the body lurches forward (overextended). Misses cost
 * time, stamina and position.
 */
function checkWhiff(sim: FighterHost, f: FighterState, m: MoveDef): void {
  if (m.hitboxes.length === 0 || f.moveHit || f.moveBlocked || f.moveAbsorbed) return;
  f.extraRecovery = m.whiffPenalty ?? RULES.whiffPenalty[m.kind];
  if (f.extraRecovery <= 0) return;
  if (f.grounded) {
    const fw = forwardFromYaw(f.yaw);
    f.vel.x += fw.x * RULES.whiffStumble;
    f.vel.z += fw.z * RULES.whiffStumble;
  }
  sim.emit({ type: 'whiff', fighter: f.id, move: m.id });
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
 *   1. explicit routes (special strings)
 *   2. jump cancel (launchers)
 *   3. FLOW: light/heavy strikes chain freely into any strike right after
 *      their active frames, on contact only, and not if the player mashed
 *      during the wind-up. Which strike comes next is entirely the player's
 *      choice: button + look flick + stick. On-beat chains build rhythm.
 *   4. system cancels: normal -> special/super on contact, special -> super on hit
 *   5. ki cancel: spend meter to cancel anything into a dodge
 */
function tryCancels(sim: FighterHost, f: FighterState, m: MoveDef, frame: number, input: InputFrame): boolean {
  const contact = f.moveHit || f.moveBlocked;
  const ok = (on: 'always' | 'contact' | 'hit'): boolean =>
    on === 'always' || (on === 'contact' && contact) || (on === 'hit' && f.moveHit);

  const dir = stickDir(input);
  for (const c of m.cancels ?? []) {
    if (!inFrames(c.frames, frame) || !ok(c.on) || !buffered(f.input, c.button)) continue;
    if (c.dir && c.dir !== dir) continue;
    if (c.swipe && c.swipe !== pressSwipe(f.input, c.button)) continue;
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

  if (flows(m) && contact && !f.mashed && frame > lastActiveFrame(m) && frame <= totalFrames(m)) {
    const rhythm = f.onBeat ? Math.min(RULES.rhythm.max, f.rhythm + 1) : 0;
    if (tryCommand(sim, f, input, isStrike, f.stringPos + 1)) {
      f.rhythm = rhythm;
      return true;
    }
  }

  if (frame > m.startup) {
    if (isStrike(m) && contact) {
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

/**
 * The body follows the camera during an attack (fast in startup, slower once
 * the strike is out), plus a small aim-assist offset toward the assist target.
 * The camera itself is never touched.
 */
function steer(sim: FighterHost, f: FighterState, m: MoveDef, input: InputFrame): void {
  if (m.fixedFacing) return;
  if (f.autoAim) {
    // Auto-aimed: the body turns to the computed launch direction, the camera stays free.
    f.yaw = approachAngle(f.yaw, f.autoYaw, RULES.turnRate.super);
    f.aimPitch = approach(f.aimPitch, f.autoPitch, RULES.turnRate.super);
    return;
  }
  const fr = f.moveFrame;
  const rate =
    fr <= m.startup || f.charging
      ? (m.turnRate ?? RULES.turnRate[m.kind])
      : fr <= lastActiveFrame(m)
        ? RULES.activeTurnRate
        : RULES.recoveryTurnRate;
  const look = lookTarget(sim, f, input);
  let yaw = look.yaw;
  let pitch = look.pitch;
  const t = f.moveTarget >= 0 ? sim.fighter(f.moveTarget) : undefined;
  if (t && t.state !== 'ko' && f.lockTarget !== t.id) {
    yaw += clamp(wrapAngle(yawTo(f.pos, t.pos) - look.yaw), -RULES.assistMaxYaw, RULES.assistMaxYaw);
    pitch += clamp(pitchTo(sim, f, t) - look.pitch, -RULES.assistMaxPitch, RULES.assistMaxPitch);
  }
  f.yaw = approachAngle(f.yaw, yaw, rate);
  f.aimPitch = approach(f.aimPitch, clampPitch(pitch), rate);
}

/**
 * Locomotion during an attack: the player keeps (reduced) control of their
 * feet, on top of the move's root motion and step-in.
 */
function moveDuringAttack(
  sim: FighterHost,
  f: FighterState,
  m: MoveDef,
  input: InputFrame,
  rootX: number | null,
  rootZ: number | null,
): void {
  const stats = sim.statsOf(f);
  const w = wishDir(f, input);
  if (!f.grounded) {
    if (rootX !== null && rootZ !== null) {
      f.vel.x = rootX + w.x * stats.airSpeed * 0.4;
      f.vel.z = rootZ + w.z * stats.airSpeed * 0.4;
    } else if (w.x !== 0 || w.z !== 0) {
      accelerateTo(f, w.x * stats.airSpeed, w.z * stats.airSpeed, stats.airAccel * 0.6);
    }
    return;
  }
  const active = f.moveFrame > m.startup && f.moveFrame <= lastActiveFrame(m);
  const mob = (m.mobility ?? RULES.defaultMobility[m.kind]) * (active ? RULES.activeMobilityScale : 1);
  const tx = w.x * stats.walkSpeed * mob + (rootX ?? 0);
  const tz = w.z * stats.walkSpeed * mob + (rootZ ?? 0);
  if (rootX !== null) {
    f.vel.x = tx;
    f.vel.z = tz;
  } else {
    accelerateTo(f, tx, tz, stats.groundAccel);
  }
}

/** Per-frame effects of a move: steering, root motion, step-in, locomotion, projectiles. */
function applyMoveFrame(sim: FighterHost, f: FighterState, m: MoveDef, input: InputFrame): void {
  const fr = f.moveFrame;
  steer(sim, f, m, input);

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
  moveDuringAttack(sim, f, m, input, vx, vz);

  m.projectiles?.forEach((p, i) => {
    if (p.frame === fr) spawnProjectile(sim, f, m, i);
  });

  if (m.charge && fr === m.charge.frame && isHeld(f.input, m.charge.button)) f.charging = true;
}

/**
 * Step-in: during startup, close a small gap to the assisted target so a
 * strike thrown at someone just out of reach still lands. Small budget,
 * and only for targets already near the crosshair.
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
  // Throw tech: any attack button (or both) in time breaks free.
  if (f.stateFrame <= RULES.throwTechWindow) {
    for (const b of [Button.GRAB, Button.LIGHT, Button.HEAVY]) {
      if (!buffered(f.input, b)) continue;
      consume(f.input, b);
      throwTech(sim, a, f);
      break;
    }
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
