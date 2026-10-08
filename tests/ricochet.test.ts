import { describe, expect, it } from 'vitest';
import { CARDS, CHARACTERS, cardCharId, striker, withCards } from '../src/content';
import { validateCharacter } from '../src/content/dsl';
import { DEG, vec3, yawFromDir } from '../src/core/math/vec3';
import { aimDirection, hurtCapsule } from '../src/core/moves';
import { type ArenaDef, DEFAULT_ARENA } from '../src/core/physics';
import { castSurface, planRicochet, reflect, traceRay } from '../src/core/ricochet';
import { RULES } from '../src/core/rules';
import { B, duel, escaper, Harness, newSim, playSequence } from './helpers';

const RICO = cardCharId('striker', ['ricochet']);
const BOTH = cardCharId('striker', ['optic_blast', 'ricochet']);
/** Forward + E. */
const RICOCHET = { buttons: B.SPECIAL, moveY: 1 };

/** Shooter at (-9, 0, 0); its enemy right in front of it (1.6 m), guard up toward it. */
function wallShot(charId = RICO) {
  const sim = newSim();
  const a = sim.addFighter({ charId, team: 0, pos: vec3(-9, 0, 0), yaw: 0, name: 'A' });
  const b = sim.addFighter({ charId: 'striker', team: 1, pos: vec3(-9, 0, -1.6), yaw: 0, name: 'B' });
  return { sim, a, b, h: new Harness(sim) };
}
/** Yaw that banks a shot from (-9, 0) off the left wall (x = -16) into (-9, -1.6). */
const BANK = yawFromDir(-7, -0.8);

describe('ricochet geometry', () => {
  it('angle in = angle out, exactly where the beam meets the wall', () => {
    const s = castSurface(DEFAULT_ARENA, vec3(-10, 1, 0), vec3(-20, 1, -10));
    expect(s?.point.x).toBeCloseTo(-16);
    expect(s?.point.z).toBeCloseTo(-6);
    expect(s?.normal).toEqual(vec3(1, 0, 0));
    const r = reflect(vec3(-1, 0, -1), s!.normal);
    expect(r.x).toBeCloseTo(1);
    expect(r.z).toBeCloseTo(-1);
  });

  it('bounces off the floor and off pillars; above the walls a shot just leaves', () => {
    const floor = castSurface(DEFAULT_ARENA, vec3(0, 1.6, 0), vec3(0, -1.6, -3.2));
    expect(floor?.normal).toEqual(vec3(0, 1, 0));
    expect(floor?.point.z).toBeCloseTo(-1.6);
    const pillar = castSurface(DEFAULT_ARENA, vec3(-7, 1, -2), vec3(-7, 1, -12));
    expect(pillar?.point.z).toBeCloseTo(-7 + 1.2);
    expect(pillar?.normal.z).toBeCloseTo(1);
    expect(castSurface(DEFAULT_ARENA, vec3(0, 8, 0), vec3(-30, 8, 0))).toBeNull();
  });

  it('the planner finds a bank shot to a target with no line of sight', () => {
    // A pillar stands right between the two.
    const target = { capsule: { a: vec3(-7, 0.35, -10.5), b: vec3(-7, 1.45, -10.5), r: 0.35 }, yaw: 0 };
    const from = vec3(-7, 1.6, -2);
    expect(castSurface(DEFAULT_ARENA, from, vec3(-7, 1.2, -10.5))).not.toBeNull();
    const plan = planRicochet(DEFAULT_ARENA, from, target, { maxBounces: 8, maxLength: 60 });
    expect(plan).not.toBeNull();
    expect(plan!.bounces).toBeGreaterThanOrEqual(1);
    // The plan is the path a beam really takes.
    const t = traceRay(DEFAULT_ARENA, from, plan!.dir, { maxLength: 60, maxBounces: 8, target: target.capsule, reach: 0.3 });
    expect(t.hit).not.toBeNull();
  });
});

describe('Cyclops: ricochet (forward + E)', () => {
  it('takes the place of the shoulder rush', () => {
    const c = withCards(striker, [CARDS.ricochet]);
    expect(validateCharacter(c)).toEqual([]);
    expect(c.commands.some((cmd) => cmd.move === 'shoulder_rush')).toBe(false);
    const { a, h } = duel(4, RICO);
    h.step({ [a.id]: RICOCHET });
    expect(a.move).toBe('ricochet');
  });

  it('banked off a wall it comes in from the side, past a raised guard, and hits harder', () => {
    const { a, b, h } = wallShot();
    h.step({ [a.id]: { ...RICOCHET, yaw: BANK }, [b.id]: { buttons: B.BLOCK, yaw: Math.PI } });
    h.run(50, { [a.id]: { yaw: BANK }, [b.id]: { buttons: B.BLOCK, yaw: Math.PI } });
    expect(h.of('bounce')).toHaveLength(1);
    expect(h.of('block')).toHaveLength(0);
    const hit = h.of('hit')[0];
    expect(hit?.victim).toBe(b.id);
    // 40 damage, +30% for the bounce.
    expect(hit?.damage).toBe(52);
  });

  it('the same shot straight at a raised guard is blocked', () => {
    const { a, b, h } = wallShot();
    h.step({ [a.id]: RICOCHET, [b.id]: { buttons: B.BLOCK, yaw: Math.PI } });
    h.run(40, { [b.id]: { buttons: B.BLOCK, yaw: Math.PI } });
    expect(h.of('block')).toHaveLength(1);
    expect(h.of('hit')).toHaveLength(0);
  });

  it('at a bounce it bends a little toward an enemy near its path, not a lot', () => {
    const shoot = (offset: number): { hits: number; plain: boolean } => {
      const { sim, a, b, h } = wallShot();
      const yaw = BANK + offset * DEG;
      const from = vec3(-9, 1.6, 0);
      // Where a plain reflection would go.
      const plain = traceRay(sim.arena, from, aimDirection(yaw, 0), {
        maxLength: 30,
        maxBounces: 1,
        target: hurtCapsule(b, sim.statsOf(b)),
        reach: 0.35 + 0.2,
      });
      h.step({ [a.id]: { ...RICOCHET, yaw } });
      h.run(50, { [a.id]: { yaw } });
      return { hits: h.of('hit').length, plain: !!plain.hit };
    };
    // A few degrees off: a plain reflection misses, the assist brings it in.
    const near = shoot(-3);
    expect(near.plain).toBe(false);
    expect(near.hits).toBe(1);
    // Way off: no help.
    expect(shoot(-14).hits).toBe(0);
  });

  it('bounces 3 times at most, then goes out on the next surface', () => {
    const { a, h } = duel(3, RICO);
    // Into a corner, slightly down: walls and floor.
    const yaw = yawFromDir(1, -1.2);
    h.step({ [a.id]: { ...RICOCHET, yaw, pitch: -0.15 } });
    h.run(70, { [a.id]: { yaw, pitch: -0.15 } });
    expect(h.of('bounce').map((e) => e.count)).toEqual([1, 2, 3]);
    expect(h.of('projectileEnd')).toHaveLength(1);
  });

  it('also in the air', () => {
    const { a, h } = duel(4, RICO);
    h.step({ [a.id]: { buttons: B.JUMP } });
    h.run(8);
    expect(a.grounded).toBe(false);
    h.step({ [a.id]: RICOCHET });
    expect(a.move).toBe('ricochet');
  });
});

describe('Cyclops: computed ricochet (forward + E with a super point)', () => {
  it('finds the enemy behind a pillar, spends the point and sets it on fire', () => {
    const sim = newSim();
    const a = sim.addFighter({ charId: RICO, team: 0, pos: vec3(-7, 0, -2), yaw: Math.PI });
    const b = sim.addFighter({ charId: 'striker', team: 1, pos: vec3(-7, 0, -10.5), yaw: 0 });
    a.meter = 100;
    const h = new Harness(sim);
    h.step({ [a.id]: { ...RICOCHET, yaw: 0 } });
    expect(a.move).toBe('ricochet_super');
    expect(a.meter).toBe(0);
    const plan = h.of('ricochetPlan')[0];
    expect(plan.target).toBe(b.id);
    expect(plan.points.length).toBeGreaterThanOrEqual(3);
    h.run(90, { [a.id]: { yaw: 0 } });
    expect(h.of('bounce').length).toBeGreaterThanOrEqual(1);
    expect(h.of('hit').map((e) => e.move)).toEqual(['ricochet_super']);
    expect(h.of('ignite')).toEqual([{ type: 'ignite', fighter: b.id, by: a.id }]);
    expect(b.burn).toBeGreaterThan(0);
  });

  it('wherever the enemy is: even right behind you', () => {
    const { a, b, h } = duel(5, RICO);
    a.meter = 100;
    // Looking the other way.
    h.step({ [a.id]: { ...RICOCHET, yaw: Math.PI } });
    expect(a.move).toBe('ricochet_super');
    h.run(90, { [a.id]: { yaw: Math.PI } });
    expect(h.of('hit')[0]?.victim).toBe(b.id);
  });

  it('it goes around a raised guard', () => {
    const { a, b, h } = duel(5, RICO);
    a.meter = 100;
    h.step({ [a.id]: RICOCHET, [b.id]: { buttons: B.BLOCK } });
    h.run(90, { [b.id]: { buttons: B.BLOCK } });
    expect(h.of('block')).toHaveLength(0);
    expect(h.of('hit')[0]?.move).toBe('ricochet_super');
  });

  it('no path, no shot: the point is kept and the plain ricochet comes out', () => {
    // The enemy stands inside a closed ring of pillars.
    const ring = Array.from({ length: 12 }, (_, i) => ({
      x: 8 + Math.cos((i / 12) * Math.PI * 2) * 1.6,
      z: 8 + Math.sin((i / 12) * Math.PI * 2) * 1.6,
      r: 0.55,
    }));
    const arena: ArenaDef = { ...DEFAULT_ARENA, pillars: ring };
    const sim = newSim({ arena });
    const a = sim.addFighter({ charId: RICO, team: 0, pos: vec3(0, 0, 0), yaw: 0 });
    sim.addFighter({ charId: 'striker', team: 1, pos: vec3(8, 0, 8), yaw: 0 });
    a.meter = 100;
    const h = new Harness(sim);
    h.step({ [a.id]: RICOCHET });
    expect(a.move).toBe('ricochet');
    expect(a.meter).toBe(100);
    expect(h.of('super')).toHaveLength(0);
    expect(h.of('ricochetPlan')).toHaveLength(0);
  });

  it('without a full point it is the plain ricochet', () => {
    const { a, h } = duel(5, RICO);
    a.meter = 99;
    h.step({ [a.id]: RICOCHET });
    expect(a.move).toBe('ricochet');
  });
});

describe('ricochets are deterministic', () => {
  it('same inputs, same result; a snapshot restored mid-flight replays exactly', () => {
    const run = (cut: number | null): number => {
      const sim = newSim();
      const a = sim.addFighter({ charId: BOTH, team: 0, pos: vec3(-7, 0, -2), yaw: Math.PI });
      sim.addFighter({ charId: 'striker', team: 1, pos: vec3(-7, 0, -10.5), yaw: 0 });
      a.meter = 300;
      const h = new Harness(sim);
      const pad = (t: number) => ({ [a.id]: { ...(t === 0 || t === 60 ? RICOCHET : {}), yaw: 0.3 } });
      let snap = '';
      for (let t = 0; t < 140; t++) {
        if (t === cut) snap = sim.snapshot();
        h.step(pad(t));
      }
      if (cut === null) return sim.hash();
      sim.restore(snap);
      for (let t = cut; t < 140; t++) h.step(pad(t));
      return sim.hash();
    };
    const ref = run(null);
    expect(run(null)).toBe(ref);
    expect(run(40)).toBe(ref);
  });
});

describe('burning', () => {
  it('fire damage ticks for 3 seconds and stops', () => {
    const { b, h } = duel(5, RICO);
    b.burn = 180;
    b.burnBy = 1;
    h.run(200);
    const ticks = h.of('burn');
    expect(ticks).toHaveLength(11);
    expect(ticks.every((e) => e.damage === RULES.burn.damage)).toBe(true);
    expect(b.health).toBe(1000 - 11 * RULES.burn.damage);
    expect(b.burn).toBe(0);
  });

  it('is never lethal', () => {
    const { b, h } = duel(5, RICO);
    b.health = 6;
    b.burn = 180;
    h.run(200);
    expect(b.health).toBe(1);
    expect(b.state).not.toBe('ko');
  });
});

describe('Cyclops: the power string with the Ricochet card', () => {
  const L = B.LIGHT;
  const H = B.HEAVY;
  const table: [string, number[], string[]][] = [
    ['LMB RMB', [L, H], ['jab', 'cyclone_kick']],
    ['LMB x2 RMB', [L, L, H], ['jab', 'cross', 'point_blank']],
    ['LMB x3 RMB', [L, L, L, H], ['jab', 'cross', 'hook_l', 'gene_splice']],
  ];
  for (const [label, buttons, moves] of table) {
    it(`${label} -> ${moves.join(', ')}`, () => {
      const { a, h } = duel(1.2, RICO);
      playSequence(h, a.id, buttons.map((button) => ({ button })), {}, 200);
      expect(h.of('attack').map((e) => e.move)).toEqual(moves);
      expect(h.of('hit').length).toBe(moves.length);
    });
  }

  it('every string is still a true combo, even against a victim mashing every escape', () => {
    for (const seq of ['LH', 'LLH', 'LLLH', 'LLLLH']) {
      const { a, b, h } = duel(1.2, RICO);
      h.fighter(b.id).burst = 0;
      playSequence(h, a.id, [...seq].map((c) => ({ button: c === 'L' ? L : H })), { [b.id]: escaper(b.id) }, 200);
      const end = h.of('comboEnd')[0];
      expect(end?.hits, seq).toBe(seq.length);
      expect(end?.trueCombo, seq).toBe(true);
    }
  });

  it('gene splice launches: jump after them for an air string', () => {
    const { a, b, h } = duel(1.2, RICO);
    playSequence(h, a.id, [{ button: L }, { button: L }, { button: L }, { button: H }, { button: B.JUMP }, { button: L }], {}, 120);
    expect(h.of('jump').some((e) => e.fighter === a.id && e.high)).toBe(true);
    expect(h.of('hit').some((e) => e.victim === b.id && e.move === 'air_jab')).toBe(true);
  });

  it('point-blank optic throws them off and bounces them off a wall', () => {
    const sim = newSim();
    const a = sim.addFighter({ charId: RICO, team: 0, pos: vec3(0, 0, -12.8), yaw: 0 });
    const b = sim.addFighter({ charId: 'striker', team: 1, pos: vec3(0, 0, -14), yaw: Math.PI });
    const h = new Harness(sim);
    playSequence(h, a.id, [{ button: L }, { button: L }, { button: H }], {}, 90);
    expect(h.of('hit').at(-1)?.move).toBe('point_blank');
    expect(h.of('wallBounce').map((e) => e.fighter)).toEqual([b.id]);
  });
});

describe('both Cyclops cards', () => {
  it('play together: beam on E, recoil on back + dash, ricochet on forward + E', () => {
    expect(CHARACTERS[BOTH]).toBeDefined();
    expect(validateCharacter(CHARACTERS[BOTH])).toEqual([]);
    expect(cardCharId('striker', ['ricochet', 'optic_blast'])).toBe(BOTH);
    const { a, h } = duel(5, BOTH);
    h.step({ [a.id]: { buttons: B.SPECIAL } });
    expect(a.move).toBe('optic_blast');
    h.run(80);
    h.step({ [a.id]: RICOCHET });
    expect(a.move).toBe('ricochet');
    h.run(80);
    h.step({ [a.id]: { buttons: B.DODGE, moveY: -1 } });
    expect(a.move).toBe('optic_recoil');
  });
});

describe('a bank shot is aimed by hand', () => {
  it('no body aim assist pulls it toward an enemy near the crosshair', () => {
    const { a, h } = duel(6, RICO);
    // Looking 15 degrees off the enemy (inside the assist cone).
    const yaw = 15 * DEG;
    h.step({ [a.id]: { ...RICOCHET, yaw } });
    expect(a.moveTarget).toBe(-1);
    h.run(16, { [a.id]: { yaw } });
    expect(a.yaw).toBeCloseTo(yaw, 5);
  });
});
