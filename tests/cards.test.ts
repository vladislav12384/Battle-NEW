import { describe, expect, it } from 'vitest';
import { CARDS, CHARACTERS, cardCharId, striker, withCards } from '../src/content';
import { validateCharacter } from '../src/content/dsl';
import { B, duel, type Harness } from './helpers';

const CYCLOPS = cardCharId('striker', ['optic_blast']);
const BACK_DASH = { buttons: B.DODGE, moveY: -1 };

/** Presses a button for one tick, then holds the stick for `ticks` more. */
function press(h: Harness, id: number, pad: { buttons: number; moveY?: number }, ticks: number): void {
  h.step({ [id]: pad });
  h.run(ticks, { [id]: { moveY: pad.moveY ?? 0 } });
}

describe('cards', () => {
  it('a card plugs into a character as plain data', () => {
    const c = withCards(striker, [CARDS.optic_blast]);
    expect(c.id).toBe(CYCLOPS);
    expect(CHARACTERS[CYCLOPS]).toBeDefined();
    expect(validateCharacter(c)).toEqual([]);
    // E now fires the beam everywhere the ki blast used to come out.
    expect(c.commands.some((cmd) => cmd.move === 'ki_blast' || cmd.move === 'air_ki_blast')).toBe(false);
    expect(c.commands.filter((cmd) => cmd.move === 'optic_blast')).toHaveLength(2);
    // The back dash is taken over, everything else stays.
    expect(c.commands[0]).toMatchObject({ move: 'optic_recoil', button: B.DODGE, dir: 'back' });
    expect(c.commands.find((cmd) => cmd.move === 'shoulder_rush')).toBeDefined();
    // The base character is untouched.
    expect(striker.moves.optic_blast).toBeUndefined();
    expect(striker.commands.some((cmd) => cmd.move === 'ki_blast')).toBe(true);
  });
});

describe('Cyclops: optic blast', () => {
  it('E fires a beam that lands long before a ki blast would', () => {
    const frameOfHit = (charId: string): number => {
      const { a, h } = duel(8, charId);
      h.step({ [a.id]: { buttons: B.SPECIAL } });
      for (let t = 1; t < 90; t++) {
        h.step();
        if (h.of('hit').length) return t;
      }
      return Infinity;
    };
    const beam = frameOfHit(CYCLOPS);
    const ki = frameOfHit('striker');
    expect(beam).toBeLessThan(26);
    expect(ki - beam).toBeGreaterThanOrEqual(12);
  });

  it('goes exactly where you look', () => {
    const shoot = (pitch: number): number => {
      const { a, b, h } = duel(7, CYCLOPS);
      h.step({ [a.id]: { buttons: B.SPECIAL, pitch } });
      h.run(45, { [a.id]: { pitch } });
      expect(h.of('projectile')).toHaveLength(1);
      return b.health;
    };
    expect(shoot(0)).toBeLessThan(1000);
    // Looking over the opponent's head: the beam flies over it.
    expect(shoot(0.45)).toBe(1000);
  });

  it('a parry sends it back', () => {
    const { a, b, h } = duel(3, CYCLOPS);
    h.step({ [a.id]: { buttons: B.SPECIAL } });
    h.run(12);
    h.step({ [b.id]: { buttons: B.BLOCK } });
    h.run(20, { [b.id]: { buttons: B.BLOCK } });
    expect(h.of('parry')).toHaveLength(1);
    expect(h.of('reflect')).toHaveLength(1);
    expect(a.health).toBeLessThan(1000);
  });
});

describe('Cyclops: optic recoil (back + dash)', () => {
  it('throws the body 5+ m back in an arc and hurts nobody', () => {
    const { a, b, h } = duel(1.2, CYCLOPS);
    let peak = 0;
    h.step({ [a.id]: BACK_DASH });
    for (let t = 0; t < 40; t++) {
      h.step({ [a.id]: { moveY: -1 } });
      peak = Math.max(peak, a.pos.y);
    }
    expect(h.of('attack').map((e) => e.move)).toEqual(['optic_recoil']);
    expect(h.of('dodge')).toHaveLength(0);
    expect(a.pos.z).toBeGreaterThan(5);
    expect(Math.abs(a.pos.x)).toBeLessThan(0.05);
    expect(peak).toBeGreaterThan(0.5);
    expect(h.of('hit')).toHaveLength(0);
    expect(b.health).toBe(1000);
  });

  it('keeps its direction when the player looks around mid-flight', () => {
    const { a, h } = duel(3, CYCLOPS);
    h.step({ [a.id]: { ...BACK_DASH, yaw: 0 } });
    h.run(36, { [a.id]: { yaw: Math.PI / 2 } });
    expect(a.pos.z).toBeGreaterThan(4.5);
    expect(Math.abs(a.pos.x)).toBeLessThan(0.05);
  });

  it('only the back dash is replaced: a neutral or side dash is still a dash', () => {
    const { a, h } = duel(3, CYCLOPS);
    press(h, a.id, { buttons: B.DODGE }, 40);
    expect(h.of('dodge')).toHaveLength(1);
    h.step({ [a.id]: { buttons: B.DODGE, moveX: 1 } });
    expect(h.of('dodge')).toHaveLength(2);
    expect(h.of('attack')).toHaveLength(0);
  });

  it('without the card back + dash is the usual backstep', () => {
    const { a, h } = duel(3, 'striker');
    press(h, a.id, BACK_DASH, 30);
    expect(h.of('dodge')).toHaveLength(1);
    expect(h.of('attack')).toHaveLength(0);
  });

  it('is out of reach while exhausted, like a dash', () => {
    const { a, h } = duel(3, CYCLOPS);
    a.stamina = 0;
    a.exhausted = true;
    press(h, a.id, BACK_DASH, 20);
    expect(h.of('attack')).toHaveLength(0);
    expect(h.of('dodge')).toHaveLength(0);
  });

  it('E in the flight fires straight out of the recoil and the momentum carries on', () => {
    const { a, h } = duel(4, CYCLOPS);
    press(h, a.id, BACK_DASH, 12);
    expect(a.grounded).toBe(false);
    h.step({ [a.id]: { buttons: B.SPECIAL } });
    expect(a.move).toBe('optic_blast');
    const z = a.pos.z;
    h.run(10);
    expect(a.pos.z - z).toBeGreaterThan(1);
    h.run(20);
    expect(h.of('projectile')).toHaveLength(1);
  });

  it('in the air: one recoil per jump, and it uses up the air dash', () => {
    const { a, h } = duel(4, CYCLOPS);
    press(h, a.id, { buttons: B.JUMP }, 10);
    expect(a.grounded).toBe(false);
    press(h, a.id, BACK_DASH, 30);
    expect(h.of('attack').map((e) => e.move)).toEqual(['optic_recoil_air']);
    expect(a.grounded).toBe(false);
    press(h, a.id, BACK_DASH, 4);
    expect(h.of('attack')).toHaveLength(1);
    expect(h.of('dodge')).toHaveLength(0);
  });
});
