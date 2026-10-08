/** Projectiles (ki blasts, webs, arrows...): spawn, flight, clashes and hits. */
import { type HitResult, resolveHit } from './combat';
import type { SimContext } from './fighterUtil';
import { capsuleOverlap } from './math/geometry';
import { clone, DEG, vec3, yawFromDir } from './math/vec3';
import { aimDirection, aimedPoint, hurtCapsule, movePitch } from './moves';
import type { ArenaDef } from './physics';
import { DT } from './rules';
import type { FighterState, ProjectileState, SimState } from './state';
import type { MoveDef, ProjectileDef } from './types';

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
  const dir = aimDirection(f.yaw, pitch);
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

/** Moves projectiles, removes expired ones and resolves projectile-vs-projectile clashes. */
export function updateProjectiles(sim: ProjectileHost): void {
  const list = sim.state.projectiles;
  for (const p of list) {
    const def = projectileDef(sim, p);
    p.prevPos = clone(p.pos);
    if (def?.gravity) p.vel.y -= def.gravity * DT;
    p.pos.x += p.vel.x * DT;
    p.pos.y += p.vel.y * DT;
    p.pos.z += p.vel.z * DT;
    p.life--;
  }
  const dead = new Set<number>();
  for (const p of list) {
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
      const point = capsuleOverlap({ a: p.prevPos, b: p.pos, r: p.radius }, hurtCapsule(v, sim.statsOf(v)));
      if (!point) continue;
      const res: HitResult = resolveHit(sim, {
        attacker: owner,
        victim: v,
        hit: def.hit,
        move: m,
        point,
        kbYaw: yawFromDir(p.vel.x, p.vel.z),
        from: vec3(p.pos.x - p.vel.x * 0.2, p.pos.y, p.pos.z - p.vel.z * 0.2),
        source: 'projectile',
        projectile: p,
      });
      if (res === 'whiff' || res === 'parry') continue; // passed through, or reflected back
      p.registry.push(v.id);
      if (res === 'evade') continue; // dashed out of it: it flies on
      p.hitsLeft--;
      if (p.hitsLeft <= 0) dead.add(p.id);
    }
  }
  removeProjectiles(sim, dead);
}
