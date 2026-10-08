import { describe, expect, it } from 'vitest';
import { cardCharId } from '../src/content';
import { RULES } from '../src/core/rules';
import { B, duel, playSequence } from './helpers';

const RICO = cardCharId('striker', ['ricochet']);
const L = B.LIGHT;
const H = B.HEAVY;
const E = B.SPECIAL;

describe('RMB + E: the strong special (not forward + E)', () => {
  it('walking forward and pressing E is the ki blast, not the shoulder rush', () => {
    const { a, h } = duel(4);
    h.run(5, { [a.id]: { moveY: 1 } });
    h.step({ [a.id]: { buttons: E, moveY: 1 } });
    h.run(RULES.chordGrace + 1, { [a.id]: { moveY: 1 } });
    expect(h.of('attack').map((e) => e.move)).toEqual(['ki_blast']);
  });

  it('RMB and E in the same frame: the shoulder rush', () => {
    const { a, h } = duel(4);
    h.step({ [a.id]: { buttons: H | E } });
    expect(a.move).toBe('shoulder_rush');
    h.run(60);
    expect(h.of('attack').map((e) => e.move)).toEqual(['shoulder_rush']);
  });

  it('E a moment before RMB: still the chord (E waits a couple of frames)', () => {
    const { a, h } = duel(4);
    h.step({ [a.id]: { buttons: E } });
    h.step({ [a.id]: { buttons: E } });
    h.step({ [a.id]: { buttons: H | E } });
    h.run(60);
    expect(h.of('attack').map((e) => e.move)).toEqual(['shoulder_rush']);
  });

  it('RMB a moment before E: the haymaker that just started turns into the chord, its stamina given back', () => {
    const { a, h } = duel(4);
    h.step({ [a.id]: { buttons: H } });
    expect(a.move).toBe('haymaker');
    h.step({ [a.id]: { buttons: H } });
    h.step({ [a.id]: { buttons: H | E } });
    expect(a.move).toBe('shoulder_rush');
    const rush = h.sim.moveById(a.charId, 'shoulder_rush')!;
    expect(a.stamina).toBeCloseTo(h.sim.statsOf(a).maxStamina - (rush.stamina ?? 0), 0);
    expect(h.of('mash')).toHaveLength(0);
  });

  it('RMB alone is the haymaker, right away', () => {
    const { a, h } = duel(4);
    h.step({ [a.id]: { buttons: H } });
    expect(a.move).toBe('haymaker');
    h.run(80);
    expect(h.of('attack').map((e) => e.move)).toEqual(['haymaker']);
  });

  it('after a jab lands, RMB + E cancels into the chord special instead of the next strike', () => {
    const { a, h } = duel(1.2);
    playSequence(h, a.id, [{ button: L }, { button: H | E }], {}, 60);
    expect(h.of('attack').map((e) => e.move)).toEqual(['jab', 'shoulder_rush']);
  });

  it('with the Ricochet card RMB + E is the ricochet, E alone the blast', () => {
    const { a, h } = duel(5, RICO);
    h.step({ [a.id]: { buttons: H | E } });
    expect(a.move).toBe('ricochet');
    const b = duel(5, RICO);
    b.h.step({ [b.a.id]: { buttons: E, moveY: 1 } });
    b.h.run(RULES.chordGrace, { [b.a.id]: { moveY: 1 } });
    expect(b.a.move).toBe('ki_blast');
  });
});
