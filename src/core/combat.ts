/**
 * Hit resolution: what happens when a hitbox touches a hurtbox.
 *
 * Priority of outcomes for a strike that reaches a victim:
 *   invulnerable (dodge / tech / reversal)  -> whiff (maybe "perfect dodge")
 *   juggle limit / OTG limit reached        -> whiff (combo can't continue)
 *   guarding + parry window                 -> PARRY (attacker staggered)
 *   guarding + facing + blockable           -> BLOCK (chip, guard damage, maybe GUARD BREAK)
 *   victim has armor on this frame          -> ARMOR (damage, no stun)
 *   otherwise                               -> HIT (scaling, stun, knockback, combo)
 */
import {
  enterState,
  spendStamina,
  type Invuln,
  invulnerability,
  isAirborneVictim,
  isFacing,
  isGuarding,
  isThrowable,
  releaseGrab,
  type SimContext,
  dodgeInvulnStart,
} from './fighterUtil';
import { capsuleOverlap } from './math/geometry';
import {
  forwardFromYaw,
  rightFromYaw,
  type Vec3,
  vec3,
  yawFromDir,
} from './math/vec3';
import {
  chestPos,
  hitboxCapsule,
  hurtCapsule,
  inFrames,
  lastActiveFrame,
  movePitch,
} from './moves';
import { RULES, TICK_RATE } from './rules';
import type { FighterState, ProjectileState } from './state';
import type { HitDef, HitboxDef, MoveDef } from './types';

export type HitSource = 'strike' | 'projectile' | 'burst' | 'throw';
export type HitResult = 'hit' | 'block' | 'parry' | 'armor' | 'guardBreak' | 'whiff';

export interface HitContext {
  attacker: FighterState;
  victim: FighterState;
  hit: HitDef;
  move: MoveDef | null;
  point: Vec3;
  /** Yaw of the frame the knockback is expressed in. */
  kbYaw: number;
  /** World position the attack comes from (guard-arc check). */
  from: Vec3;
  source: HitSource;
  projectile?: ProjectileState;
  /** Extra damage multiplier from charging (0 = none). */
  chargeBonus?: number;
}

export const defaultHitstop = (hit: HitDef): number =>
  hit.hitstop ?? Math.min(16, Math.max(4, Math.round(4 + hit.damage / 12)));

export function resolveHit(sim: SimContext, ctx: HitContext): HitResult {
  const { attacker: a, victim: v, hit } = ctx;
  if (v.state === 'ko' || v.team === a.team) return 'whiff';

  const inv: Invuln = invulnerability(sim, v);
  if (inv === 'all' || (inv === 'strike' && ctx.source !== 'throw')) {
    checkPerfectDodge(sim, v, a, ctx);
    return 'whiff';
  }
  if (v.combo.hits > 0 && isAirborneVictim(v) && v.combo.juggle >= RULES.juggleLimit) return 'whiff';
  if (v.state === 'knockdown' && v.combo.otgHits >= RULES.maxOtgHits) return 'whiff';

  if (ctx.source === 'throw') return applyHit(sim, ctx);

  const facing = isFacing(v, ctx.from);
  if (facing && isGuarding(v)) {
    if (v.parryWindow > 0 && hit.parryable !== false && ctx.source !== 'burst') return applyParry(sim, ctx);
    if (!hit.unblockable) {
      if (hit.guardBreak) return applyGuardBreak(sim, ctx);
      return applyBlock(sim, ctx);
    }
  }

  if (v.state === 'attack' && v.armorLeft > 0 && ctx.source !== 'burst') {
    const m = sim.moveOf(v);
    if (m?.armor && inFrames(m.armor.frames, v.moveFrame)) return applyArmor(sim, ctx, m);
  }
  return applyHit(sim, ctx);
}

function checkPerfectDodge(sim: SimContext, v: FighterState, a: FighterState, ctx: HitContext): void {
  if (v.state !== 'dodge' || v.perfectDodged || ctx.source === 'burst') return;
  const start = dodgeInvulnStart(v);
  if (v.stateFrame > start + RULES.dodge.perfectWindow - 1) return;
  v.perfectDodged = true;
  v.dodgeCounter = true;
  v.meter = Math.min(RULES.meterMax, v.meter + RULES.perfectDodgeMeter);
  sim.emit({ type: 'perfectDodge', fighter: v.id, attacker: a.id });
}

function horizontalAway(from: Vec3, to: Vec3): { x: number; z: number } {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  return d > 1e-6 ? { x: dx / d, z: dz / d } : { x: 1, z: 0 };
}

function applyParry(sim: SimContext, ctx: HitContext): HitResult {
  const { attacker: a, victim: v } = ctx;
  const vs = sim.statsOf(v);
  v.parryWindow = 0;
  v.parryCooldown = 0;
  v.meter = Math.min(RULES.meterMax, v.meter + RULES.parryMeter);
  v.stamina = Math.min(vs.maxStamina, v.stamina + RULES.stamina.parryRestore);
  v.hitstop = Math.max(v.hitstop, RULES.parryHitstop);
  v.vel.x = 0;
  v.vel.z = 0;
  if (ctx.source === 'strike') {
    const away = horizontalAway(v.pos, a.pos);
    if (a.grounded) {
      enterState(a, 'stagger', RULES.parryStagger);
      a.vel.x = away.x * 3;
      a.vel.z = away.z * 3;
    } else {
      // Parried in the air: knocked out of the sky.
      enterState(a, 'juggle', RULES.parryStagger);
      a.impact = { groundBounce: false, wallSplat: false, wallBounce: false, hardKnockdown: false };
      a.vel = vec3(away.x * 3, 2, away.z * 3);
    }
    a.hitstop = RULES.parryHitstop;
  } else if (ctx.projectile) {
    reflectProjectile(sim, ctx.projectile, v);
  }
  sim.emit({ type: 'parry', attacker: a.id, victim: v.id, point: ctx.point });
  return 'parry';
}

function applyBlock(sim: SimContext, ctx: HitContext): HitResult {
  const { attacker: a, victim: v, hit } = ctx;
  const vs = sim.statsOf(v);
  const chip = Math.round(hit.chip ?? hit.damage * RULES.chipRatio);
  // Chip damage never kills.
  v.health = Math.max(Math.min(v.health, 1), v.health - chip);
  // Blocking costs stamina; running dry (or blocking while exhausted) breaks the guard.
  const drain = hit.guardDamage ?? hit.damage * RULES.guardDamageRatio;
  if (v.stamina - drain <= 0) return applyGuardBreak(sim, ctx);
  spendStamina(sim, v, drain);

  enterState(v, 'blockstun', hit.blockstun);
  const push = (hit.blockPush ?? Math.abs(hit.knockback.fwd) * RULES.blockPushScale + 1) / vs.weight;
  const dir = ctx.source === 'strike' ? forwardFromYaw(ctx.kbYaw) : horizontalAway(ctx.from, v.pos);
  v.vel.x = dir.x * push;
  v.vel.z = dir.z * push;
  const stop = Math.round(defaultHitstop(hit) * RULES.blockHitstopScale);
  v.hitstop = Math.max(v.hitstop, stop);
  if (ctx.source === 'strike') {
    a.hitstop = Math.max(a.hitstop, stop);
    a.moveBlocked = true;
  }
  a.meter = Math.min(RULES.meterMax, a.meter + hit.damage * RULES.meterOnBlock);
  sim.emit({ type: 'block', attacker: a.id, victim: v.id, chip, stamina: v.stamina, point: ctx.point });
  return 'block';
}

function applyGuardBreak(sim: SimContext, ctx: HitContext): HitResult {
  const { attacker: a, victim: v } = ctx;
  v.stamina = 0;
  v.staminaDelay = RULES.guardBreakStagger;
  v.guardBroken = true;
  enterState(v, 'stagger', RULES.guardBreakStagger);
  const dir = horizontalAway(ctx.from, v.pos);
  v.vel.x = dir.x * 2;
  v.vel.z = dir.z * 2;
  v.hitstop = Math.max(v.hitstop, 16);
  v.shake = 16;
  if (ctx.source === 'strike') {
    a.hitstop = Math.max(a.hitstop, 16);
    a.moveHit = true;
  }
  sim.emit({ type: 'guardBreak', attacker: a.id, victim: v.id, point: ctx.point });
  return 'guardBreak';
}

function applyArmor(sim: SimContext, ctx: HitContext, m: MoveDef): HitResult {
  const { attacker: a, victim: v, hit } = ctx;
  const dmg = Math.round(hit.damage * (m.armor?.damageTaken ?? 0.5));
  if (v.health - dmg <= 0) return applyHit(sim, ctx); // armor never saves you from a KO
  v.health -= dmg;
  v.armorLeft--;
  const stop = Math.round(defaultHitstop(hit) * 0.6);
  v.hitstop = Math.max(v.hitstop, stop);
  v.shake = stop;
  if (ctx.source === 'strike') {
    a.hitstop = Math.max(a.hitstop, stop);
    a.moveBlocked = true;
  }
  sim.emit({ type: 'armor', attacker: a.id, victim: v.id, damage: dmg, point: ctx.point });
  return 'armor';
}

/** Combo damage multiplier for the n-th hit (1-based). */
export function damageScaling(hitNumber: number, minScale: number): number {
  if (hitNumber < RULES.damageScaleStart) return 1;
  return Math.max(minScale, 1 - RULES.damageScaleStep * (hitNumber - RULES.damageScaleStart + 1));
}

/** How many times a move family appears among a combo's recent hits. */
export function staleCount(recent: readonly string[], family: string): number {
  let n = 0;
  for (const r of recent) if (r === family) n++;
  return n;
}

/** Hitstun multiplier after `comboFrames` frames of continuous combo. */
export function hitstunDecay(comboFrames: number): number {
  if (comboFrames <= RULES.hitstunDecayStart) return 1;
  const secs = (comboFrames - RULES.hitstunDecayStart) / TICK_RATE;
  return Math.max(RULES.hitstunDecayMin, 1 - secs * RULES.hitstunDecayPerSecond);
}

function applyHit(sim: SimContext, ctx: HitContext): HitResult {
  const { attacker: a, victim: v } = ctx;
  const vs = sim.statsOf(v);
  const vm = v.state === 'attack' ? sim.moveOf(v) : null;
  const counter = ctx.source !== 'throw' && vm !== null && (v.charging || v.moveFrame <= lastActiveFrame(vm));
  const punish =
    !counter &&
    (vm !== null || (v.state === 'dodge' && v.stateFrame > v.dodgeInvulnEnd) || v.state === 'land');
  let hit = ctx.hit;
  if (counter && hit.counter) hit = { ...hit, ...hit.counter };

  const wasAirborne = isAirborneVictim(v);
  const wasDown = v.state === 'knockdown';
  const wasStaggered = v.state === 'stagger';
  releaseGrab(sim, v);

  // ---- combo bookkeeping (lives on the victim, shared by all attackers)
  const c = v.combo;
  if (c.hits === 0) {
    c.startFrame = sim.state.frame;
    c.trueCombo = true;
  } else if (v.gap) {
    c.trueCombo = false;
  }
  v.gap = false;
  c.hits++;
  if (!c.attackers.includes(a.id)) c.attackers.push(a.id);
  if (wasDown) c.otgHits++;

  // ---- stale moves: repeating the same kind of strike in one combo weakens it
  const family = ctx.move ? (ctx.move.family ?? ctx.move.id) : null;
  const stale = family ? staleCount(c.recent, family) : 0;
  const staleStun = Math.max(RULES.staleHitstunMin, 1 - RULES.staleHitstunStep * stale);
  const staleDmg = Math.max(RULES.staleDamageMin, 1 - RULES.staleDamageStep * stale);
  if (family) {
    c.recent.push(family);
    if (c.recent.length > RULES.staleWindow) c.recent.shift();
  }

  // ---- damage
  const minScale = hit.minScaling ?? ctx.move?.minScaling ?? RULES.damageScaleMin;
  const raw =
    hit.damage *
    damageScaling(c.hits, minScale) *
    staleDmg *
    (counter ? RULES.counterDamage : 1) *
    (1 + (ctx.chargeBonus ?? 0));
  const dmg = hit.damage > 0 ? Math.max(1, Math.round(raw)) : 0;
  v.health -= dmg;
  c.damage += dmg;

  // ---- stun (decays in long combos so nothing is infinite)
  const decay = hitstunDecay(sim.state.frame - c.startFrame);
  const stun = Math.max(1, Math.round(hit.hitstun * decay * staleStun) + (counter ? RULES.counterHitstun : 0));

  // ---- knockback in the attacker's frame, scaled by the victim's weight
  const kb = wasAirborne && hit.airKnockback ? hit.airKnockback : hit.knockback;
  const fw = forwardFromYaw(ctx.kbYaw);
  const rt = rightFromYaw(ctx.kbYaw);
  const side = kb.side ?? 0;
  const vx = (fw.x * kb.fwd + rt.x * side) / vs.weight;
  const vz = (fw.z * kb.fwd + rt.z * side) / vs.weight;
  let vy = kb.up / Math.sqrt(vs.weight);

  const launches =
    !!hit.launch || wasAirborne || wasDown || kb.up > 0.5 || !!hit.knockdown || (!!hit.groundBounce && kb.up < 0);
  if (launches) c.juggle += hit.juggleCost ?? 1;
  if (wasDown) vy = Math.max(vy, 3);

  v.impact = {
    groundBounce: !!hit.groundBounce,
    wallSplat: !!hit.wallSplat,
    wallBounce: !!hit.wallBounce,
    hardKnockdown: !!hit.hardKnockdown,
  };

  // Heavy blows that land deep in a combo get extra weight (finisher freeze).
  const finisher = c.hits >= 3 && (ctx.move?.kind === 'heavy' || launches) && ctx.source === 'strike';
  const stop = defaultHitstop(hit) + (counter ? 3 : 0) + (finisher ? RULES.finisherHitstop : 0);
  let ko = false;
  if (v.health <= 0) {
    v.health = 0;
    ko = true;
    enterState(v, 'ko');
    v.vel = vec3(vx * 1.3, Math.max(vy, 4), vz * 1.3);
    v.grounded = false;
    v.lockTarget = -1;
  } else if (launches) {
    enterState(v, 'juggle', stun);
    v.vel = vec3(vx, vy, vz);
    if (hit.knockdown && !wasAirborne && v.vel.y < 3) v.vel.y = 3;
    v.grounded = false;
  } else if (hit.crumple && !wasStaggered) {
    enterState(v, 'stagger', Math.round(hit.crumple * decay));
    v.vel = vec3(vx, 0, vz);
  } else {
    enterState(v, 'hitstun', stun);
    v.vel = vec3(vx, 0, vz);
  }
  v.hitstop = Math.max(v.hitstop, stop);
  v.shake = stop;

  // Accuracy pays: a strike that lands refunds part of its stamina cost (once per move).
  if (ctx.move && !a.moveHit && (ctx.source === 'strike' || ctx.source === 'projectile')) {
    const cost = ctx.move.stamina ?? RULES.staminaCost[ctx.move.kind];
    a.stamina = Math.min(sim.statsOf(a).maxStamina, a.stamina + cost * RULES.stamina.hitRefund);
  }
  if (ctx.source === 'strike') {
    a.hitstop = Math.max(a.hitstop, stop);
    a.moveHit = true;
    if (!a.grounded && hit.attackerStall) a.vel.y = Math.max(a.vel.y, hit.attackerStall);
  } else if (ctx.source === 'projectile' && ctx.projectile && a.move === ctx.projectile.moveId) {
    a.moveHit = true;
  }

  a.meter = Math.min(RULES.meterMax, a.meter + dmg * RULES.meterOnHit);
  v.meter = Math.min(RULES.meterMax, v.meter + dmg * RULES.meterOnDamaged);
  v.burst = Math.min(RULES.burstMax, v.burst + dmg * RULES.burstOnDamaged);

  sim.emit({
    type: 'hit',
    attacker: a.id,
    victim: v.id,
    damage: dmg,
    counter,
    punish,
    comboHits: c.hits,
    comboDamage: c.damage,
    trueCombo: c.trueCombo,
    effect: hit.effect ?? (launches ? 'launch' : 'medium'),
    launch: launches,
    point: ctx.point,
    hitstop: stop,
    ...knockDir(vx, vy, vz, ctx),
    move: ctx.move?.id ?? null,
  });
  if (ko) sim.emit({ type: 'ko', fighter: v.id, attacker: a.id });
  return 'hit';
}

function knockDir(vx: number, vy: number, vz: number, ctx: HitContext): { dir: Vec3; force: number } {
  const force = Math.hypot(vx, vy, vz);
  if (force > 1e-3) return { dir: vec3(vx / force, vy / force, vz / force), force };
  const away = horizontalAway(ctx.from, ctx.victim.pos);
  return { dir: vec3(away.x, 0, away.z), force: 0 };
}

// --------------------------------------------------------------------------
// Grabs

export function tryGrab(sim: SimContext, a: FighterState, v: FighterState, move: MoveDef): boolean {
  if (!isThrowable(sim, v)) return false;
  enterState(a, 'grabbing');
  a.grabPartner = v.id;
  a.grabMove = move.id;
  a.vel = vec3();
  enterState(v, 'grabbed');
  v.grabPartner = a.id;
  v.vel = vec3();
  pinVictim(sim, a, v);
  sim.emit({ type: 'grab', attacker: a.id, victim: v.id });
  return true;
}

export function pinVictim(sim: SimContext, a: FighterState, v: FighterState): void {
  const fw = forwardFromYaw(a.yaw);
  const d = sim.statsOf(a).radius + sim.statsOf(v).radius + 0.1;
  v.pos.x = a.pos.x + fw.x * d;
  v.pos.z = a.pos.z + fw.z * d;
  v.pos.y = a.pos.y;
  v.vel = vec3();
  v.yaw = yawFromDir(-fw.x, -fw.z);
}

/** Both fighters break apart (throw tech or simultaneous throws). */
export function throwTech(sim: SimContext, a: FighterState, v: FighterState): void {
  const away = horizontalAway(a.pos, v.pos);
  for (const [f, s] of [
    [a, -1],
    [v, 1],
  ] as const) {
    f.grabPartner = -1;
    enterState(f, 'recoil');
    f.vel = vec3(away.x * 5 * s, 0, away.z * 5 * s);
    f.hitstop = 8;
  }
  sim.emit({ type: 'tech', fighter: v.id, kind: 'throw' });
}

// --------------------------------------------------------------------------
// Strikes: clash detection, hit collection and application

const priorityOf = (m: MoveDef): number =>
  m.priority ?? { light: 1, heavy: 2, special: 2, super: 4, throw: 0 }[m.kind];

function strikeBoxes(m: MoveDef, frame: number): HitboxDef[] {
  return m.hitboxes.filter((h) => !h.throw && inFrames(h.frames, frame));
}

/** Two strikes colliding mid-air ("clash"): sparks fly and both (or the weaker) recoil. */
export function resolveClashes(sim: SimContext, frozen: ReadonlySet<number>): void {
  const fs = sim.state.fighters;
  for (let i = 0; i < fs.length; i++) {
    const a = fs[i];
    if (a.state !== 'attack' || frozen.has(a.id)) continue;
    const ma = sim.moveOf(a);
    if (!ma || priorityOf(ma) === 0) continue;
    for (let j = i + 1; j < fs.length; j++) {
      const b = fs[j];
      if (b.team === a.team || b.state !== 'attack' || frozen.has(b.id) || a.state !== 'attack') continue;
      const mb = sim.moveOf(b);
      if (!mb || priorityOf(mb) === 0) continue;
      if (a.registry.some((k) => k.startsWith(`${b.id}:`)) || b.registry.some((k) => k.startsWith(`${a.id}:`))) continue;
      const boxesA = strikeBoxes(ma, a.moveFrame);
      const boxesB = strikeBoxes(mb, b.moveFrame);
      if (boxesA.length === 0 || boxesB.length === 0) continue;
      const sa = sim.statsOf(a);
      const sb = sim.statsOf(b);
      let point: Vec3 | null = null;
      for (const ha of boxesA) {
        const ca = hitboxCapsule(a, sa, ha, movePitch(a, ma));
        for (const hb of boxesB) {
          point = capsuleOverlap(ca, hitboxCapsule(b, sb, hb, movePitch(b, mb)));
          if (point) break;
        }
        if (point) break;
      }
      if (!point) continue;
      const pa = priorityOf(ma);
      const pb = priorityOf(mb);
      if (pa <= pb) recoil(a, b);
      if (pb <= pa) recoil(b, a);
      if (pa > pb) a.hitstop = Math.max(a.hitstop, 6);
      if (pb > pa) b.hitstop = Math.max(b.hitstop, 6);
      sim.emit({ type: 'clash', a: a.id, b: b.id, point });
    }
  }
}

function recoil(f: FighterState, other: FighterState): void {
  const away = horizontalAway(other.pos, f.pos);
  enterState(f, 'recoil');
  f.vel = vec3(away.x * 4, f.grounded ? 0 : 2, away.z * 4);
  f.hitstop = 10;
}

interface PendingStrike {
  a: FighterState;
  v: FighterState;
  move: MoveDef;
  box: HitboxDef;
  key: string;
  point: Vec3;
}

/**
 * Collects every hitbox/hurtbox overlap for this tick first, then applies
 * them. Collecting first makes simultaneous hits trade fairly instead of the
 * lower fighter id always winning.
 */
export function processStrikes(sim: SimContext, frozen: ReadonlySet<number>): void {
  const fs = sim.state.fighters;
  const strikes: PendingStrike[] = [];
  const throws: PendingStrike[] = [];
  for (const a of fs) {
    if (a.state !== 'attack' || frozen.has(a.id)) continue;
    const m = sim.moveOf(a);
    if (!m) continue;
    const sa = sim.statsOf(a);
    const pitch = movePitch(a, m);
    for (const box of m.hitboxes) {
      if (!inFrames(box.frames, a.moveFrame)) continue;
      const cap = hitboxCapsule(a, sa, box, pitch);
      for (const v of fs) {
        if (v === a || v.team === a.team || v.state === 'ko') continue;
        const key = `${v.id}:${box.group ?? 0}`;
        if (a.registry.includes(key)) continue;
        const list = box.throw ? throws : strikes;
        if (list.some((p) => p.a === a && p.key === key)) continue;
        const point = capsuleOverlap(cap, hurtCapsule(v, sim.statsOf(v)));
        if (!point) continue;
        list.push({ a, v, move: m, box, key, point });
      }
    }
  }

  for (const p of strikes) {
    const res = resolveHit(sim, {
      attacker: p.a,
      victim: p.v,
      hit: chargedHit(p.a, p.move, p.box.hit),
      move: p.move,
      point: p.point,
      kbYaw: p.a.yaw,
      from: p.a.pos,
      source: 'strike',
      chargeBonus: chargeBonus(p.a, p.move),
    });
    if (res !== 'whiff') p.a.registry.push(p.key);
  }

  for (const p of throws) {
    // A strike this tick beats a throw: the thrower must still be throwing.
    if (p.a.state !== 'attack' || p.a.move !== p.move.id) continue;
    const mutual = throws.find((q) => q.a === p.v && q.v === p.a);
    if (mutual && p.v.state === 'attack' && p.v.move === mutual.move.id) {
      throwTech(sim, p.a, p.v);
      continue;
    }
    p.a.registry.push(p.key);
    tryGrab(sim, p.a, p.v, p.move);
  }
}

export function chargeRatio(f: FighterState, m: MoveDef): number {
  if (!m.charge) return 0;
  return Math.min(1, f.chargeFrames / m.charge.fullAt);
}

function chargeBonus(f: FighterState, m: MoveDef): number {
  return m.charge ? chargeRatio(f, m) * m.charge.damageBonus : 0;
}

function chargedHit(f: FighterState, m: MoveDef, hit: HitDef): HitDef {
  if (m.charge?.fullHit && chargeRatio(f, m) >= 1) return { ...hit, ...m.charge.fullHit };
  return hit;
}

// --------------------------------------------------------------------------
// Projectiles

export function reflectProjectile(sim: SimContext, p: ProjectileState, by: FighterState): void {
  const owner = sim.fighter(p.owner);
  const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z) * 1.25;
  let dir: Vec3;
  if (owner && owner.state !== 'ko') {
    const c = chestPos(owner, sim.statsOf(owner));
    const d = vec3(c.x - p.pos.x, c.y - p.pos.y, c.z - p.pos.z);
    const l = Math.hypot(d.x, d.y, d.z) || 1;
    dir = vec3(d.x / l, d.y / l, d.z / l);
  } else {
    const l = speed / 1.25 || 1;
    dir = vec3(-p.vel.x / l, -p.vel.y / l, -p.vel.z / l);
  }
  p.vel = vec3(dir.x * speed, dir.y * speed, dir.z * speed);
  p.owner = by.id;
  p.team = by.team;
  p.registry = [];
  p.reflected = true;
  p.life = Math.max(p.life, 60);
  sim.emit({ type: 'reflect', id: p.id, fighter: by.id });
}

