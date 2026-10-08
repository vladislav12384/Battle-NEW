import { describe, expect, it } from 'vitest';
import { CARDS, CHARACTERS, cardCharId, striker, withCards } from '../src/content';
import { validateCharacter } from '../src/content/dsl';
import { vec3 } from '../src/core/math/vec3';
import { RULES } from '../src/core/rules';
import { B, duel, Harness, newSim } from './helpers';

const MEGA = cardCharId('striker', ['mega_beam']);
const ALL = cardCharId('striker', ['optic_blast', 'ricochet', 'mega_beam']);

/** Frames a beam fires when E is held for `hold` ticks (0 = a tap). */
function beamLength(hold: number): number {
  const { a, h } = duel(6, MEGA);
  a.meter = 100;
  let frames = 0;
  for (let t = 0; t < 260; t++) {
    h.step({ [a.id]: { buttons: t === 0 || t < hold ? B.SPECIAL : 0 } });
    if (a.beaming) frames++;
  }
  return frames;
}

describe('Cyclops: mega beam card', () => {
  it('plugs in: the super is the beam, three air moves are only re-animated', () => {
    const c = withCards(striker, [CARDS.mega_beam]);
    expect(validateCharacter(c)).toEqual([]);
    expect(c.commands.some((cmd) => cmd.move === 'barrage')).toBe(false);
    for (const id of ['air_spin', 'air_hammer', 'dive_kick']) {
      const { anim, vfx, ...rest } = c.moves[id];
      const { anim: a0, vfx: v0, ...base } = striker.moves[id];
      expect(rest, id).toEqual(base);
      expect(anim).not.toBe(a0);
      expect(vfx).toBeDefined();
      void v0;
    }
    expect(validateCharacter(CHARACTERS[ALL])).toEqual([]);
  });

  it('E with a super point fires it and spends the point; without one it is the plain blast', () => {
    const { a, h } = duel(6, MEGA);
    a.meter = 100;
    h.step({ [a.id]: { buttons: B.SPECIAL } });
    h.run(RULES.chordGrace, { [a.id]: { buttons: B.SPECIAL } });
    expect(a.move).toBe('mega_beam');
    expect(a.meter).toBe(0);
    const plain = duel(6, MEGA);
    plain.h.step({ [plain.a.id]: { buttons: B.SPECIAL } });
    plain.h.run(RULES.chordGrace);
    expect(plain.a.move).toBe('ki_blast');
  });

  it('keeps firing while E is held, up to 2.5 s; a tap still fires half a second', () => {
    const tap = beamLength(0);
    const mid = beamLength(70);
    const long = beamLength(400);
    expect(tap).toBe(31);
    expect(mid).toBeGreaterThan(tap);
    expect(mid).toBeLessThan(long);
    expect(long).toBe(151);
  });

  it('hits in pulses and holds the opponent in the beam', () => {
    const { a, b, h } = duel(5, MEGA);
    a.meter = 100;
    for (let t = 0; t < 120; t++) h.step({ [a.id]: { buttons: B.SPECIAL } });
    const hits = h.of('hit').filter((e) => e.move === 'mega_beam');
    expect(hits.length).toBeGreaterThanOrEqual(10);
    expect(b.health).toBeLessThan(1000 - 100);
  });

  it('goes through bodies: two enemies in a line are both hit', () => {
    const sim = newSim();
    const a = sim.addFighter({ charId: MEGA, team: 0, pos: vec3(0, 0, 0), yaw: 0 });
    const b = sim.addFighter({ charId: 'striker', team: 1, pos: vec3(0, 0, -4), yaw: Math.PI });
    const c = sim.addFighter({ charId: 'striker', team: 1, pos: vec3(0, 0, -7), yaw: Math.PI });
    a.meter = 100;
    const h = new Harness(sim);
    for (let t = 0; t < 40; t++) h.step({ [a.id]: { buttons: B.SPECIAL, yaw: 0 } });
    const victims = new Set(h.of('hit').map((e) => e.victim));
    expect(victims.has(b.id) && victims.has(c.id)).toBe(true);
  });

  it('a pillar stops it: hide behind one', () => {
    const sim = newSim();
    const a = sim.addFighter({ charId: MEGA, team: 0, pos: vec3(-7, 0, -2), yaw: 0 });
    const b = sim.addFighter({ charId: 'striker', team: 1, pos: vec3(-7, 0, -11), yaw: 0 });
    a.meter = 100;
    const h = new Harness(sim);
    for (let t = 0; t < 80; t++) h.step({ [a.id]: { buttons: B.SPECIAL, yaw: 0 } });
    expect(a.beaming || h.of('attack').length === 1).toBe(true);
    expect(h.of('hit')).toHaveLength(0);
    expect(b.health).toBe(1000);
  });

  it('on the floor it pushes you back a little, feet braced', () => {
    const { a, h } = duel(5, MEGA);
    a.meter = 100;
    for (let t = 0; t < 100; t++) h.step({ [a.id]: { buttons: B.SPECIAL } });
    expect(a.pos.z).toBeGreaterThan(0.4);
    expect(a.grounded).toBe(true);
  });

  it('in the air, fired down at someone it lifts you: controlled flight', () => {
    /** Jump, then hold the beam; `pitch` null = keep the opponent's chest in the crosshair. */
    const fly = (pitch: number | null, moveY = 0) => {
      const { a, b, h } = duel(4, MEGA);
      a.meter = 100;
      const aim = (): number =>
        pitch ?? Math.atan2(b.pos.y + 1.35 - (a.pos.y + 1.6), Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z));
      h.step({ [a.id]: { buttons: B.JUMP } });
      h.run(10);
      let peak = 0;
      let airborne = 0;
      for (let t = 0; t < 150; t++) {
        h.step({ [a.id]: () => ({ buttons: B.SPECIAL, pitch: aim(), moveY }) });
        peak = Math.max(peak, a.pos.y);
        if (!a.grounded) airborne++;
      }
      return { a, h, peak, airborne };
    };
    const plainJump = (() => {
      const { a, h } = duel(4, MEGA);
      h.step({ [a.id]: { buttons: B.JUMP } });
      let airborne = 0;
      for (let t = 0; t < 160; t++) {
        h.step();
        if (!a.grounded) airborne++;
      }
      return airborne;
    })();
    // Straight down: it climbs, up to the ceiling.
    const down = fly(-1.2);
    expect(down.h.of('attack').map((e) => e.move)).toEqual(['mega_beam']);
    expect(down.airborne).toBeGreaterThan(plainJump * 2);
    expect(down.peak).toBeGreaterThan(3);
    expect(down.peak).toBeLessThan(7.5);
    // Kept on the opponent below: it hits all along while you hang in the air.
    const onTarget = fly(null);
    expect(onTarget.airborne).toBeGreaterThan(plainJump * 1.8);
    expect(onTarget.h.of('hit').filter((e) => e.move === 'mega_beam').length).toBeGreaterThan(5);
    // The stick steers the flight.
    const steered = fly(-1.2, 1);
    expect(steered.a.pos.z).toBeLessThan(down.a.pos.z - 2);
    // Fired level in the air, it throws you back.
    const level = fly(0);
    expect(level.a.pos.z).toBeGreaterThan(3);
  });

  it('a raised guard holds for a while, then breaks', () => {
    const { a, b, h } = duel(5, MEGA);
    a.meter = 100;
    for (let t = 0; t < 160; t++) h.step({ [a.id]: { buttons: B.SPECIAL }, [b.id]: { buttons: B.BLOCK } });
    expect(h.of('block').length).toBeGreaterThan(3);
    expect(h.of('guardBreak')).toHaveLength(1);
  });

  it('is deterministic, also across a snapshot restored mid-beam', () => {
    const run = (cut: number | null): number => {
      const sim = newSim();
      const a = sim.addFighter({ charId: ALL, team: 0, pos: vec3(0, 0, 0), yaw: 0 });
      sim.addFighter({ charId: 'striker', team: 1, pos: vec3(0, 0, -4), yaw: Math.PI });
      a.meter = 300;
      const h = new Harness(sim);
      const pad = (t: number) => ({ [a.id]: { buttons: t === 0 ? B.JUMP : t >= 10 && t < 90 ? B.SPECIAL : 0, pitch: -0.9, moveY: t > 40 ? 1 : 0 } });
      let snap = '';
      for (let t = 0; t < 160; t++) {
        if (t === cut) snap = sim.snapshot();
        h.step(pad(t));
      }
      if (cut === null) return sim.hash();
      sim.restore(snap);
      for (let t = cut; t < 160; t++) h.step(pad(t));
      return sim.hash();
    };
    const ref = run(null);
    expect(run(null)).toBe(ref);
    expect(run(50)).toBe(ref);
  });
});
