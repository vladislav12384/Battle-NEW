/**
 * "Smart" combat: dashing out of strikes (every strike can be dodged, slow
 * blows are easier, the right side matters), perfect dodges, poise of heavy
 * blows, and rhythm instead of mashing.
 */
import { describe, expect, it } from 'vitest';
import { startMove } from '../src/core/fighter';
import { dodgeWindow } from '../src/core/fighterUtil';
import { hDistance, wrapAngle, yawTo } from '../src/core/math/vec3';
import { strikeLine } from '../src/core/moves';
import { RULES } from '../src/core/rules';
import type { MoveDef } from '../src/core/types';
import { B, duel, playSequence } from './helpers';

type DashSide = 'left' | 'right' | 'back';

const firstActive = (m: MoveDef): number => Math.min(...m.hitboxes.filter((x) => !x.throw).map((x) => x.frames[0]));

/**
 * `a` throws `moveId` at `b`; `b` dashes `side` so that the strike's first
 * active frame meets b on dash frame `lead`. Returns whether b got hit.
 */
function dashAgainst(moveId: string, side: DashSide, lead: number) {
  const { a, b, h, sim } = duel(1.2);
  const m = sim.chars.striker.moves[moveId];
  // The move starts between ticks 0 and 1 (move frame k on tick k - 1), so
  // its first active frame is tick F - 1; b's dash is on frame `lead` then.
  const pressAt = firstActive(m) - 1 - lead;
  const pad = { buttons: B.DODGE, moveX: side === 'left' ? -1 : side === 'right' ? 1 : 0, moveY: side === 'back' ? -1 : 0 };
  for (let t = Math.min(pressAt, 1); t < 140; t++) {
    if (t === 1) startMove(sim, h.fighter(a.id), moveId);
    h.step(t === pressAt ? { [b.id]: pad } : {});
  }
  return {
    hit: h.of('hit').some((e) => e.victim === b.id),
    perfect: h.of('perfectDodge').length > 0,
    evaded: h.of('evade').length > 0 || h.of('perfectDodge').length > 0,
    a: h.fighter(a.id),
    b: h.fighter(b.id),
  };
}

/** Leads (dash frames at impact) for which dashing `side` gets b out of the strike. */
function safeLeads(moveId: string, side: DashSide): number[] {
  const out: number[] = [];
  for (let lead = 0; lead <= 34; lead++) if (!dashAgainst(moveId, side, lead).hit) out.push(lead);
  return out;
}

describe('dashing out of strikes', () => {
  it('EVERY grounded strike of the Striker can be dodged by a dash', () => {
    const { sim } = duel();
    const moves = Object.values(sim.chars.striker.moves).filter(
      (m) => !m.air && m.kind !== 'throw' && m.hitboxes.some((x) => !x.throw),
    );
    expect(moves.length).toBeGreaterThan(15);
    for (const m of moves) {
      const dodgeable = (['left', 'right', 'back'] as DashSide[]).some((side) => safeLeads(m.id, side).length > 0);
      expect(dodgeable, `${m.id} can't be dodged`).toBe(true);
    }
  });

  it('slow heavy blows are much easier to dodge than quick jabs', () => {
    const jab = safeLeads('jab', 'right').length;
    const haymaker = safeLeads('haymaker', 'right').length;
    expect(jab).toBeGreaterThan(0);
    expect(haymaker).toBeGreaterThan(jab + 4);
  });

  it('a swing is dodged by dashing away from the side it comes from', () => {
    // The right roundhouse comes at the target's LEFT: dash right.
    const { sim } = duel();
    expect(strikeLine(sim.chars.striker.moves.roundhouse_r)).toBe('fromLeft');
    const good = safeLeads('roundhouse_r', 'right').length;
    const bad = safeLeads('roundhouse_r', 'left').length;
    expect(good).toBeGreaterThan(bad);
    expect(bad).toBeGreaterThan(0); // the wrong way is harder, not impossible
  });

  it('the evasion window follows the rules table', () => {
    const { a, b, sim } = duel(1.2);
    const moves = sim.chars.striker.moves;
    b.dodgeDirX = 1; // b faces +Z toward a: +X is b's left
    b.dodgeDirZ = 0;
    const D = RULES.dodge;
    expect(dodgeWindow(b, moves.jab, a.pos)).toBe(D.window.light);
    expect(dodgeWindow(b, moves.haymaker, a.pos)).toBe(D.window.heavy);
    expect(dodgeWindow(b, moves.hook_l, a.pos)).toBe(D.window.light + D.goodSide); // comes from b's right
    expect(dodgeWindow(b, moves.hook_r, a.pos)).toBe(D.window.light + D.badSide);
  });

  it('a dash too early gets caught by the strike', () => {
    const r = dashAgainst('jab', 'right', 26);
    expect(r.hit).toBe(true);
  });

  it('a last-moment dash is a perfect dodge: stamina back, attacker exposed', () => {
    const { a, b, h, sim } = duel(1.2);
    const m = sim.chars.striker.moves.haymaker;
    const pressAt = firstActive(m) - 1 - 3;
    let at: { stamina: number; exposed: number } | null = null;
    for (let t = 1; t < 120 && !at; t++) {
      if (t === 1) startMove(sim, h.fighter(a.id), 'haymaker');
      h.step(t === pressAt ? { [b.id]: { buttons: B.DODGE, moveX: 1 } } : {});
      if (h.of('perfectDodge').length) at = { stamina: h.fighter(b.id).stamina, exposed: h.fighter(a.id).exposed };
    }
    expect(at).not.toBeNull();
    expect(at!.stamina).toBeCloseTo(100 - RULES.stamina.dodge + RULES.dodge.perfectStamina);
    expect(at!.exposed).toBeGreaterThan(RULES.dodge.exposeFrames - 4);
    expect(h.of('hit').length).toBe(0);
  });

  it('a perfect dodge opens a free counter on the slowed attacker', () => {
    const { a, b, h, sim } = duel(1.2);
    const m = sim.chars.striker.moves.haymaker;
    startMove(sim, h.fighter(a.id), 'haymaker');
    const pressAt = firstActive(m) - 1 - 3;
    let countered = false;
    for (let t = 1; t < 120; t++) {
      const fb = h.fighter(b.id);
      let pad = {};
      if (t === pressAt) pad = { buttons: B.DODGE, moveX: 1 };
      else if (fb.dodgeCounter && !countered && t > pressAt + 4) {
        pad = { buttons: B.HEAVY, swipe: 'right' as const }; // spinning backfist
        countered = true;
      }
      h.step({ [b.id]: pad });
      if (t === pressAt + 6) expect(h.fighter(a.id).exposed).toBeGreaterThan(0);
    }
    const hit = h.of('hit').find((e) => e.attacker === b.id);
    expect(hit).toBeDefined();
    expect(h.of('hit').some((e) => e.victim === b.id)).toBe(false);
  });

  it('a side dash next to an enemy circles around it', () => {
    const { a, b, h } = duel(1.4);
    const before = yawTo(h.fighter(a.id).pos, h.fighter(b.id).pos);
    h.step({ [b.id]: { buttons: B.DODGE, moveX: 1 } });
    h.run(RULES.dodge.frames);
    const after = yawTo(h.fighter(a.id).pos, h.fighter(b.id).pos);
    expect(Math.abs(wrapAngle(after - before))).toBeGreaterThan(40 * (Math.PI / 180));
    expect(Math.abs(hDistance(h.fighter(a.id).pos, h.fighter(b.id).pos) - 1.4)).toBeLessThan(0.35);
  });
});

describe('poise: heavy blows shrug off jabs in their late wind-up', () => {
  it('a jab into a heavy you saw coming bounces off and you eat the heavy', () => {
    const { a, b, h } = duel(1.3);
    h.step({ [b.id]: { buttons: B.HEAVY } }); // haymaker
    h.run(10, { [b.id]: { buttons: 0 } }); // a reacts late...
    h.step({ [a.id]: { buttons: B.LIGHT } }); // ...with a jab
    h.run(40);
    expect(h.of('armor').some((e) => e.poise && e.victim === b.id)).toBe(true);
    expect(h.of('hit').some((e) => e.victim === a.id && e.move === 'haymaker')).toBe(true);
  });

  it('a jab thrown first still interrupts a heavy in its early wind-up', () => {
    const { a, b, h } = duel(1.3);
    h.step({ [a.id]: { buttons: B.LIGHT }, [b.id]: { buttons: B.HEAVY } });
    h.run(30, { [b.id]: { buttons: 0 } });
    const first = h.of('hit')[0];
    expect(first.attacker).toBe(a.id);
    expect(first.counter).toBe(true);
    expect(h.of('armor').length).toBe(0);
  });

  it('a heavy into a heavy is not absorbed', () => {
    const { a, b, h } = duel(1.3);
    h.step({ [b.id]: { buttons: B.HEAVY, swipe: 'up' } }); // launcher (startup 14)
    h.run(2, { [b.id]: { buttons: 0 } });
    h.step({ [a.id]: { buttons: B.HEAVY, swipe: 'up' } });
    h.run(40);
    expect(h.of('armor').length).toBe(0);
  });
});

describe('rhythm, not mashing', () => {
  it('mashing during the wind-up locks the chain', () => {
    const { a, h } = duel(1.2);
    h.step({ [a.id]: { buttons: B.LIGHT } });
    h.step({ [a.id]: { buttons: 0 } });
    h.step({ [a.id]: { buttons: B.LIGHT } }); // still winding up: mash
    expect(h.of('mash').length).toBe(1);
    // Pressing again on impact no longer chains.
    h.until(() => h.of('hit').length > 0);
    h.step({ [a.id]: { buttons: 0 } });
    h.step({ [a.id]: { buttons: B.LIGHT } });
    h.run(12);
    expect(h.of('attack').filter((e) => e.fighter === a.id).length).toBe(1);
  });

  it('pressing on impact chains, and on-beat chains build rhythm and hit harder', () => {
    const { a, h } = duel(1.2);
    playSequence(h, a.id, [{ button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }, { button: B.HEAVY }]);
    const hits = h.of('hit');
    expect(hits.length).toBe(4);
    expect(hits.map((e) => e.rhythm)).toEqual([0, 1, 2, 3]);
    expect(h.of('mash').length).toBe(0);
  });

  it('a late chain press still chains but resets the rhythm', () => {
    const { a, h, sim } = duel(1.2);
    const jab = sim.chars.striker.moves.jab;
    h.step({ [a.id]: { buttons: B.LIGHT } });
    h.until(() => h.fighter(a.id).moveFrame >= jab.startup + jab.active + RULES.beatWindow + 2);
    h.step({ [a.id]: { buttons: B.LIGHT } });
    h.run(20);
    const hits = h.of('hit');
    expect(hits.length).toBe(2);
    expect(hits[1].rhythm).toBe(0);
  });
});
