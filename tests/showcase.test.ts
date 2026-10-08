import { describe, expect, it } from 'vitest';
import { cardCharId } from '../src/content';
import { SHOWCASE } from '../src/content/cards/cyclops';
import { vec3 } from '../src/core/math/vec3';
import { RULES } from '../src/core/rules';
import { B, duel, Harness, newSim } from './helpers';

const MEGA = cardCharId('striker', ['mega_beam']);
const GRAB = B.LIGHT | B.HEAVY | B.GRAB;

/** Grabs the opponent standing right in front; returns once the hold has started. */
function grab(charId = MEGA) {
  const d = duel(1.0, charId);
  d.h.step({ [d.a.id]: { buttons: GRAB } });
  d.h.until(() => d.a.state === 'grabbing');
  return d;
}

describe('grab follow-ups', () => {
  it('LMB during the hold: the showcase scene, then the throw lands', () => {
    const { a, b, h } = grab();
    h.step();
    h.step({ [a.id]: { buttons: B.LIGHT } });
    h.until(() => h.of('cinematic').length > 0);
    expect(h.of('cinematic')[0]).toMatchObject({ attacker: a.id, victim: b.id, move: 'cyclops_showcase' });
    expect(a.cine && b.cine).toBe(true);
    h.run(SHOWCASE.end + 2);
    expect(h.of('cineBeat').map((e) => e.damage)).toEqual([16, 12, 12, 12]);
    const hit = h.of('hit').at(-1)!;
    expect(hit.move).toBe('cyclops_showcase');
    expect(hit.damage).toBe(70);
    expect(b.health).toBe(1000 - 52 - 70);
    expect(b.cine).toBe(false);
    h.until(() => b.state === 'knockdown');
    h.until(() => a.state === 'ground');
    expect(a.cine).toBe(false);
  });

  it('RMB during the hold, or no press: the usual quick throw', () => {
    for (const press of [B.HEAVY, 0]) {
      const { a, b, h } = grab();
      h.step();
      h.step({ [a.id]: { buttons: press } });
      h.run(RULES.throwTechWindow + 4);
      expect(h.of('cinematic')).toHaveLength(0);
      expect(h.of('throw')).toHaveLength(1);
      expect(b.health).toBe(1000 - 110);
    }
  });

  it('the victim can still break the grab in the usual window, LMB or not', () => {
    const { a, b, h } = grab();
    h.step({ [a.id]: { buttons: B.LIGHT } });
    h.step({ [b.id]: { buttons: B.LIGHT } });
    h.run(30);
    expect(h.of('tech').map((e) => e.kind)).toEqual(['throw']);
    expect(h.of('cinematic')).toHaveLength(0);
  });

  it('once the scene runs nobody breaks out or cuts in', () => {
    const sim = newSim();
    const a = sim.addFighter({ charId: MEGA, team: 0, pos: vec3(0, 0, 0), yaw: 0 });
    const b = sim.addFighter({ charId: 'striker', team: 1, pos: vec3(0, 0, -1), yaw: Math.PI });
    // The victim's partner stands behind the thrower, jabbing.
    const c = sim.addFighter({ charId: 'striker', team: 1, pos: vec3(0.2, 0, 1.0), yaw: 0 });
    const h = new Harness(sim);
    h.step({ [a.id]: { buttons: GRAB, yaw: Math.PI } });
    h.until(() => a.state === 'grabbing', { [a.id]: { yaw: Math.PI } });
    h.step({ [a.id]: { buttons: B.LIGHT, yaw: Math.PI } });
    h.until(() => h.of('cinematic').length > 0);
    for (let t = 0; t < SHOWCASE.end - 2; t++) {
      h.step({ [b.id]: { buttons: t % 2 ? B.LIGHT | B.HEAVY | B.GRAB : B.DODGE }, [c.id]: { buttons: t % 12 === 0 ? B.LIGHT : 0 } });
    }
    expect(h.of('tech')).toHaveLength(0);
    expect(h.of('hit').filter((e) => e.victim === a.id)).toHaveLength(0);
    expect(a.state).toBe('grabbing');
    h.run(6);
    expect(h.of('throw')).toHaveLength(1);
  });

  it('without the card LMB during the hold is just the throw', () => {
    const { a, b, h } = grab('striker');
    h.step();
    h.step({ [a.id]: { buttons: B.LIGHT } });
    h.run(RULES.throwTechWindow + 4);
    expect(h.of('cinematic')).toHaveLength(0);
    expect(b.health).toBe(1000 - 110);
  });

  it('is deterministic, also across a snapshot restored mid-scene', () => {
    const run = (cut: number | null): number => {
      const { sim, a, h } = duel(1.0, MEGA);
      const pad = (t: number) => ({ [a.id]: { buttons: t === 0 ? GRAB : t === 20 ? B.LIGHT : 0 } });
      let snap = '';
      for (let t = 0; t < 220; t++) {
        if (t === cut) snap = sim.snapshot();
        h.step(pad(t));
      }
      if (cut === null) return sim.hash();
      sim.restore(snap);
      for (let t = cut; t < 220; t++) h.step(pad(t));
      return sim.hash();
    };
    const ref = run(null);
    expect(run(null)).toBe(ref);
    expect(run(90)).toBe(ref);
  });
});
