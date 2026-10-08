/** Projectiles (ki blasts, webs, arrows, ricochets...): spawn, flight, bounces, clashes and hits. */
import { type HitResult, resolveHit } from './combat';
import type { SimContext } from './fighterUtil';
import { type Capsule, capsuleOverlap } from './math/geometry';
import { clone, DEG, type Vec3, vec3, yawFromDir } from './math/vec3';
import { aimDirection, aimedPoint, hurtCapsule, movePitch } from './moves';
import type { ArenaDef } from './physics';
import { aimPoint, angleBetween, castSurface, lineOfSight, planRicochet, type RicochetPlan, reflect, turnToward } from './ricochet';
import { DT } from './rules';
import type { FighterState, ProjectileState, SimState } from './state';
import type { HitDef, MoveDef, ProjectileDef } from './types';

export interface ProjectileHost extends SimContext {
  readonly state: SimState;
  readonly arena: ArenaDef;
  allocId(): number;
}

export function projectileDef(sim: SimContext, p: ProjectileState): ProjectileDef | null {
  return sim.moveById(p.charId, p.moveId)?.projectiles?.[p.index] ?? null;
}

export function spawnProjectile(sim: ProjectileHost, f: FighterState, m: MoveDef, index: number): void {
  const def = m.projectiles![index];
  const stats = sim.statsOf(f);
  const pitch = movePitch(f, m) + (def.pitchOffset ?? 0) * DEG;
  const pos = aimedPoint(f, stats, def.offset, movePitch(f, m));
  let dir = aimDirection(f.yaw, pitch);
  let target = -1;
  let planLeft = 0;
  if (def.guided) {
    // Fired along a path computed right now from the eyes to the move's target.
    const t = f.moveTarget >= 0 ? sim.fighter(f.moveTarget) : undefined;
    if (t && t.state !== 'ko') {
      target = t.id;
      // Stay on the path the visor computed at the press (the one shown), if it still works.
      const near = f.autoAim ? aimDirection(f.autoYaw, f.autoPitch) : undefined;
      const plan = planShot(sim, pos, t, def.bounces ?? 0, flightRange(def), { near });
      if (plan) {
        dir = plan.dir;
        planLeft = plan.bounces;
      } else if (f.autoAim) dir = aimDirection(f.autoYaw, f.autoPitch);
    }
  }
  const p: ProjectileState = {
    id: sim.allocId(),
    owner: f.id,
    team: f.team,
    charId: f.charId,
    moveId: m.id,
    index,
    pos,
    prevPos: clone(pos),
    vel: vec3(dir.x * def.speed, dir.y * def.speed, dir.z * def.speed),
    life: def.lifetime,
    radius: def.radius,
    hitsLeft: def.maxHits ?? 1,
    registry: [],
    reflected: false,
    bounces: 0,
    path: [],
    target,
    planLeft,
  };
  sim.state.projectiles.push(p);
  sim.emit({ type: 'projectile', id: p.id, owner: f.id });
}

function outOfArena(arena: ArenaDef, p: ProjectileState): boolean {
  if (p.pos.y < 0 || p.pos.y > arena.wallHeight + 4) return true;
  if (Math.abs(p.pos.x) > arena.halfX || Math.abs(p.pos.z) > arena.halfZ) return true;
  for (const pl of arena.pillars) {
    if (Math.hypot(p.pos.x - pl.x, p.pos.z - pl.z) < pl.r + p.radius) return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// Ricochets

/** Distance a projectile covers in its lifetime (m). */
export const flightRange = (def: ProjectileDef): number => def.speed * (def.lifetime / 60);

/** Path from `from` to fighter `t` bouncing at most `maxBounces` times (see core/ricochet). */
export function planShot(
  sim: ProjectileHost,
  from: Vec3,
  t: FighterState,
  maxBounces: number,
  maxLength: number,
  extra: { normal?: Vec3; near?: Vec3 } = {},
): RicochetPlan | null {
  return planRicochet(sim.arena, from, { capsule: hurtCapsule(t, sim.statsOf(t)), yaw: t.yaw }, { maxBounces, maxLength, ...extra });
}

/** Turn per tick of a guided ricochet homing on its last leg. */
const HOMING = 6 * DEG;
/** Bounce points of a projectile kept per tick (safety cap). */
const MAX_BOUNCES_PER_TICK = 6;

/** Enemy of the projectile's team nearest (in angle) to `dir` within `cone`, in plain sight of `at`. */
function assistTarget(sim: ProjectileHost, p: ProjectileState, at: Vec3, dir: Vec3, cone: number): Vec3 | null {
  let best: Vec3 | null = null;
  let bestAng = cone;
  for (const v of sim.state.fighters) {
    if (v.team === p.team || v.state === 'ko') continue;
    const c = aimPoint(hurtCapsule(v, sim.statsOf(v)));
    const to = vec3(c.x - at.x, c.y - at.y, c.z - at.z);
    const l = Math.hypot(to.x, to.y, to.z);
    if (l < 1e-3) continue;
    const u = vec3(to.x / l, to.y / l, to.z / l);
    const ang = angleBetween(dir, u);
    if (ang > bestAng || !lineOfSight(sim.arena, at, c)) continue;
    bestAng = ang;
    best = u;
  }
  return best;
}

/** New direction right after a bounce: plain reflection, nudged (assist) or re-planned (guided). */
function afterBounce(sim: ProjectileHost, p: ProjectileState, def: ProjectileDef, at: Vec3, n: Vec3, d: Vec3): Vec3 {
  if (def.guided) {
    const t = p.target >= 0 ? sim.fighter(p.target) : undefined;
    if (t && t.state !== 'ko') {
      const from = vec3(at.x + n.x * 1e-3, at.y + n.y * 1e-3, at.z + n.z * 1e-3);
      const left = (def.bounces ?? 0) - p.bounces;
      const range = flightRange(def) * (p.life / def.lifetime) + 2;
      const plan = planShot(sim, from, t, left, range, { normal: n, near: d });
      if (plan) {
        p.planLeft = plan.bounces;
        return plan.dir;
      }
      p.planLeft = 0;
      const to = assistTarget(sim, p, at, d, 80 * DEG);
      return to ? turnToward(d, to, 35 * DEG) : d;
    }
  }
  const a = def.bounceAssist;
  if (!a) return d;
  const to = assistTarget(sim, p, at, d, a.cone * DEG);
  return to ? turnToward(d, to, a.turn * DEG) : d;
}

/**
 * Flight of a bouncing projectile over one tick: it reflects off every
 * surface it meets (exactly where it meets it), and stops on the surface
 * once its bounces are used up. Returns true when it is spent.
 */
function flyBouncing(sim: ProjectileHost, p: ProjectileState, def: ProjectileDef): boolean {
  const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
  if (speed < 1e-6) return true;
  let d = vec3(p.vel.x / speed, p.vel.y / speed, p.vel.z / speed);
  // Guided, last leg: home in on the target while it is in plain sight.
  if (def.guided && p.planLeft === 0 && p.target >= 0) {
    const t = sim.fighter(p.target);
    if (t && t.state !== 'ko') {
      const c = aimPoint(hurtCapsule(t, sim.statsOf(t)));
      const to = vec3(c.x - p.pos.x, c.y - p.pos.y, c.z - p.pos.z);
      const l = Math.hypot(to.x, to.y, to.z);
      if (l > 0.3) {
        const u = vec3(to.x / l, to.y / l, to.z / l);
        if (angleBetween(d, u) < 75 * DEG && lineOfSight(sim.arena, p.pos, c)) d = turnToward(d, u, HOMING);
      }
    }
  }
  let pos = p.pos;
  let left = speed * DT;
  let spent = false;
  for (let k = 0; k <= MAX_BOUNCES_PER_TICK && left > 1e-6; k++) {
    const end = vec3(pos.x + d.x * left, pos.y + d.y * left, pos.z + d.z * left);
    const s = castSurface(sim.arena, pos, end);
    if (!s) {
      pos = end;
      break;
    }
    left -= left * s.t;
    if (p.bounces >= (def.bounces ?? 0) || k === MAX_BOUNCES_PER_TICK) {
      pos = s.point;
      spent = true;
      break;
    }
    p.bounces++;
    if (p.planLeft > 0) p.planLeft--;
    d = afterBounce(sim, p, def, s.point, s.normal, reflect(d, s.normal));
    p.path.push(clone(s.point));
    sim.emit({ type: 'bounce', id: p.id, point: clone(s.point), normal: s.normal, count: p.bounces });
    pos = vec3(s.point.x + s.normal.x * 1e-3, s.point.y + s.normal.y * 1e-3, s.point.z + s.normal.z * 1e-3);
  }
  p.pos = pos;
  p.vel = vec3(d.x * speed, d.y * speed, d.z * speed);
  return spent;
}

/** Moves projectiles, removes expired ones and resolves projectile-vs-projectile clashes. */
export function updateProjectiles(sim: ProjectileHost): void {
  const list = sim.state.projectiles;
  /** Ricochets that ended on a surface this tick: they still hit whoever they passed on the way. */
  const spent = new Set<number>();
  for (const p of list) {
    const def = projectileDef(sim, p);
    p.prevPos = clone(p.pos);
    p.path = [];
    if (def?.gravity) p.vel.y -= def.gravity * DT;
    if (def?.bounces !== undefined) {
      if (flyBouncing(sim, p, def)) spent.add(p.id);
    } else {
      p.pos.x += p.vel.x * DT;
      p.pos.y += p.vel.y * DT;
      p.pos.z += p.vel.z * DT;
    }
    p.life--;
  }
  const dead = new Set<number>();
  for (const p of list) {
    if (spent.has(p.id)) {
      p.life = Math.min(p.life, 0);
      continue;
    }
    if (p.life <= 0 || outOfArena(sim.arena, p) || !sim.fighter(p.owner)) dead.add(p.id);
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (a.team === b.team || dead.has(a.id) || dead.has(b.id)) continue;
      const hit = capsuleOverlap({ a: a.prevPos, b: a.pos, r: a.radius }, { a: b.prevPos, b: b.pos, r: b.radius });
      if (hit) {
        dead.add(a.id);
        dead.add(b.id);
        sim.emit({ type: 'clash', a: a.owner, b: b.owner, point: hit });
      }
    }
  }
  removeProjectiles(sim, dead);
}

function removeProjectiles(sim: ProjectileHost, dead: Set<number>): void {
  if (dead.size === 0) return;
  for (const p of sim.state.projectiles) {
    if (dead.has(p.id)) sim.emit({ type: 'projectileEnd', id: p.id, point: clone(p.pos) });
  }
  sim.state.projectiles = sim.state.projectiles.filter((p) => !dead.has(p.id));
}

/**
 * Where a projectile touched a body this tick: along its flight segment
 * (several after bounces), with the direction it was travelling there and
 * how many bounces it had made by then.
 */
function projectileContact(p: ProjectileState, body: Capsule): { point: Vec3; dir: Vec3 | null; bounces: number } | null {
  if (p.path.length === 0) {
    const point = capsuleOverlap({ a: p.prevPos, b: p.pos, r: p.radius }, body);
    return point ? { point, dir: null, bounces: p.bounces } : null;
  }
  const pts = [p.prevPos, ...p.path, p.pos];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const point = capsuleOverlap({ a, b, r: p.radius }, body);
    if (!point) continue;
    const l = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1;
    return { point, dir: vec3((b.x - a.x) / l, (b.y - a.y) / l, (b.z - a.z) / l), bounces: p.bounces - (p.path.length - i) };
  }
  return null;
}

/** A ricochet hits harder for every bounce it made on the way. */
function bouncedHit(def: ProjectileDef, bounces: number): HitDef {
  if (!def.bounceDamage || bounces <= 0) return def.hit;
  return { ...def.hit, damage: Math.round(def.hit.damage * (1 + def.bounceDamage * bounces)) };
}

export function processProjectileHits(sim: ProjectileHost): void {
  const dead = new Set<number>();
  for (const p of sim.state.projectiles) {
    const owner = sim.fighter(p.owner);
    const def = projectileDef(sim, p);
    if (!owner || !def) {
      dead.add(p.id);
      continue;
    }
    const m = sim.moveById(p.charId, p.moveId);
    for (const v of sim.state.fighters) {
      if (dead.has(p.id)) break;
      if (v.team === p.team || v.state === 'ko' || p.registry.includes(v.id)) continue;
      const contact = projectileContact(p, hurtCapsule(v, sim.statsOf(v)));
      if (!contact) continue;
      const { point, dir } = contact;
      const res: HitResult = resolveHit(sim, {
        attacker: owner,
        victim: v,
        hit: bouncedHit(def, contact.bounces),
        move: m,
        point,
        kbYaw: dir ? yawFromDir(dir.x, dir.z) : yawFromDir(p.vel.x, p.vel.z),
        // The guard faces where the shot comes from: a ricochet off a wall comes from the side.
        from: dir
          ? vec3(point.x - dir.x * 3, point.y, point.z - dir.z * 3)
          : vec3(p.pos.x - p.vel.x * 0.2, p.pos.y, p.pos.z - p.vel.z * 0.2),
        source: 'projectile',
        projectile: p,
      });
      if (res === 'whiff' || res === 'parry') continue; // passed through, or reflected back
      p.registry.push(v.id);
      if (res === 'evade') continue; // dashed out of it: it flies on
      p.hitsLeft--;
      if (p.hitsLeft <= 0) dead.add(p.id);
    }
    // A ricochet that ended on a surface this tick goes out there.
    if (p.life <= 0) dead.add(p.id);
  }
  removeProjectiles(sim, dead);
}
