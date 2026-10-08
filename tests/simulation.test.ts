import { describe, expect, it } from 'vitest';
import { Bot, type BotLevel } from '../src/core/ai/bot';
import type { InputFrame } from '../src/core/input';
import { vec3 } from '../src/core/math/vec3';
import type { Simulation } from '../src/core/simulation';
import { B, duel, Harness, newSim, playSequence } from './helpers';

/** 2v2 bot brawl, returns the simulation and recorded inputs. */
function brawl(frames: number, seed = 1) {
  const sim = newSim({ seed, respawn: true });
  const ids = [
    sim.addFighter({ charId: 'striker', team: 0, pos: vec3(-2, 0, 2) }).id,
    sim.addFighter({ charId: 'striker', team: 0, pos: vec3(2, 0, 2) }).id,
    sim.addFighter({ charId: 'striker', team: 1, pos: vec3(-2, 0, -2), yaw: Math.PI }).id,
    sim.addFighter({ charId: 'brute', team: 1, pos: vec3(2, 0, -2), yaw: Math.PI }).id,
  ];
  const bots = ids.map((id, i) => new Bot(id, { seed: seed * 100 + i, aggression: 0.8 }));
  const record: Record<number, InputFrame>[] = [];
  const events: string[] = [];
  for (let t = 0; t < frames; t++) {
    const inputs: Record<number, InputFrame> = {};
    for (const b of bots) inputs[b.fighterId] = b.think(sim);
    record.push(inputs);
    for (const e of sim.step(inputs)) events.push(e.type);
  }
  return { sim, record, events };
}

function replay(sim: Simulation, record: Record<number, InputFrame>[], from: number): void {
  for (let t = from; t < record.length; t++) sim.step(record[t]);
}

describe('determinism', () => {
  it('the same inputs always produce the same world', () => {
    const r1 = brawl(1500, 3);
    const r2 = brawl(1500, 3);
    expect(r1.sim.hash()).toBe(r2.sim.hash());
  });

  it('snapshot + replay of recorded inputs reproduces the exact state (rollback-ready)', () => {
    const { sim, record } = brawl(1200, 5);
    const finalHash = sim.hash();

    // Re-run the first 600 frames, snapshot, then replay the rest from the snapshot.
    const s2 = newSim({ seed: 5, respawn: true });
    s2.addFighter({ charId: 'striker', team: 0, pos: vec3(-2, 0, 2) });
    s2.addFighter({ charId: 'striker', team: 0, pos: vec3(2, 0, 2) });
    s2.addFighter({ charId: 'striker', team: 1, pos: vec3(-2, 0, -2), yaw: Math.PI });
    s2.addFighter({ charId: 'brute', team: 1, pos: vec3(2, 0, -2), yaw: Math.PI });
    for (let t = 0; t < 600; t++) s2.step(record[t]);
    const snap = s2.snapshot();
    replay(s2, record, 600);
    expect(s2.hash()).toBe(finalHash);

    s2.restore(snap);
    replay(s2, record, 600);
    expect(s2.hash()).toBe(finalHash);
  });
});

describe('bots', () => {
  it('a long 2v2 brawl stays sane (no NaN, valid resources, lots of action)', () => {
    const { sim, events } = brawl(3600, 11);
    for (const f of sim.state.fighters) {
      for (const v of [f.pos.x, f.pos.y, f.pos.z, f.vel.x, f.vel.y, f.vel.z, f.yaw]) expect(Number.isFinite(v)).toBe(true);
      expect(f.health).toBeGreaterThanOrEqual(0);
      expect(f.health).toBeLessThanOrEqual(sim.statsOf(f).maxHealth);
      expect(f.meter).toBeGreaterThanOrEqual(0);
      expect(f.meter).toBeLessThanOrEqual(300);
      expect(f.pos.y).toBeGreaterThanOrEqual(0);
      expect(Math.abs(f.pos.x)).toBeLessThanOrEqual(sim.arena.halfX);
    }
    const count = (t: string) => events.filter((e) => e === t).length;
    expect(count('hit')).toBeGreaterThan(30);
    expect(count('block')).toBeGreaterThan(2);
    expect(count('comboEnd')).toBeGreaterThan(8);
  });

  it('a parry bot deflects a jab string', () => {
    const { a, b, h } = duel(1.2);
    const bot = new Bot(b.id, { mode: 'parry', parryChance: 1 });
    playSequence(h, a.id, [{ button: B.LIGHT }, { button: B.LIGHT }], { [b.id]: () => padOf(bot.think(h.sim)) });
    expect(h.of('parry').length).toBeGreaterThanOrEqual(1);
    expect(h.of('hit').length).toBe(0);
  });
});

function padOf(i: InputFrame) {
  return { buttons: i.buttons, moveX: i.moveX, moveY: i.moveY, yaw: i.yaw, pitch: i.pitch };
}

describe('co-op', () => {
  it('two allies share one combo on the same victim', () => {
    const sim = newSim();
    const p1 = sim.addFighter({ charId: 'striker', team: 0, pos: vec3(0, 0, 0) });
    const p2 = sim.addFighter({ charId: 'striker', team: 0, pos: vec3(0, 0, -2.4), yaw: Math.PI });
    const enemy = sim.addFighter({ charId: 'striker', team: 1, pos: vec3(0, 0, -1.2) });
    const h = new Harness(sim);
    h.step({ [p1.id]: { buttons: B.LIGHT } });
    h.run(3);
    h.step({ [p2.id]: { buttons: B.LIGHT } });
    h.run(40);
    const hits = h.of('hit');
    expect(hits.length).toBe(2);
    expect(hits[1].comboHits).toBe(2);
    expect(h.of('comboEnd')[0].attackers.sort()).toEqual([p1.id, p2.id].sort());
    expect(h.fighter(p1.id).health).toBe(1000);
    expect(h.fighter(p2.id).health).toBe(1000);
    void enemy;
  });

  it('allies never hit each other (no friendly fire)', () => {
    const sim = newSim();
    const p1 = sim.addFighter({ charId: 'striker', team: 0, pos: vec3(0, 0, 0) });
    const p2 = sim.addFighter({ charId: 'striker', team: 0, pos: vec3(0, 0, -1.2), yaw: Math.PI });
    sim.addFighter({ charId: 'striker', team: 1, pos: vec3(10, 0, 10) });
    for (let t = 0; t < 40; t++) {
      sim.step({ [p1.id]: { moveX: 0, moveY: 0, yaw: 0, pitch: 0, buttons: t === 0 ? B.HEAVY : 0 } });
    }
    expect(sim.fighter(p2.id)!.health).toBe(1000);
  });
});

describe('bot difficulty', () => {
  /** Damage dealt by each side in a minute-long 1v1 between two levels, over a few seeds. */
  function duelLevels(x: BotLevel, y: BotLevel): [number, number] {
    let dx = 0;
    let dy = 0;
    for (const seed of [1, 2, 3]) {
      const sim = newSim({ seed, respawn: true });
      const a = sim.addFighter({ charId: 'striker', team: 0, pos: vec3(0, 0, 2) });
      const b = sim.addFighter({ charId: 'striker', team: 1, pos: vec3(0, 0, -2), yaw: Math.PI });
      const ba = new Bot(a.id, { seed: seed * 7 });
      const bb = new Bot(b.id, { seed: seed * 13 });
      ba.setLevel(x);
      bb.setLevel(y);
      for (let t = 0; t < 3600; t++) {
        for (const e of sim.step({ [a.id]: ba.think(sim), [b.id]: bb.think(sim) })) {
          if (e.type !== 'hit') continue;
          if (e.attacker === a.id) dx += e.damage;
          else dy += e.damage;
        }
      }
    }
    return [dx, dy];
  }

  it('harder levels clearly beat easier ones', () => {
    const [hard, easy] = duelLevels('hard', 'easy');
    expect(hard).toBeGreaterThan(easy * 2);
    const [normal, easy2] = duelLevels('normal', 'easy');
    expect(normal).toBeGreaterThan(easy2 * 1.4);
  });

  it('switching level keeps the bot mode', () => {
    const bot = new Bot(1, { mode: 'block' });
    bot.setLevel('easy');
    expect(bot.config.mode).toBe('block');
    expect(bot.config.reaction).toBeGreaterThan(20);
  });
});
