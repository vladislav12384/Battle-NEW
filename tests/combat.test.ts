import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/rules';
import { vec3 } from '../src/core/math/vec3';
import { B, duel, escaper, playSequence } from './helpers';

describe('frame data', () => {
  it('a jab (startup 5) connects on its 6th frame', () => {
    const { a, h } = duel(1.2);
    h.step({ [a.id]: { buttons: B.LIGHT } }); // move frame 1
    let frames = 1;
    while (h.of('hit').length === 0 && frames < 30) {
      h.step();
      frames++;
    }
    expect(frames).toBe(6);
  });

  it('measured advantage on hit matches hitstun - (active + recovery - 1)', () => {
    const { a, b, h, sim } = duel(1.2);
    h.step({ [a.id]: { buttons: B.LIGHT } });
    h.until(() => h.of('hit').length > 0);
    let tA = -1;
    let tV = -1;
    for (let t = 0; t < 60 && (tA < 0 || tV < 0); t++) {
      h.step();
      if (tA < 0 && h.fighter(a.id).state === 'ground') tA = t;
      if (tV < 0 && h.fighter(b.id).state === 'ground') tV = t;
    }
    const jab = sim.chars.striker.moves.jab;
    const expected = jab.hitboxes[0].hit.hitstun - (jab.active + jab.recovery - 1);
    expect(tV - tA).toBe(expected);
    expect(expected).toBeGreaterThan(0); // jab is plus on hit
  });
});

describe('combos', () => {
  it('L,L,L,L is a true combo: a victim mashing dodge/block cannot escape', () => {
    const { a, b, h } = duel(1.2);
    playSequence(h, a.id, [{ button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }], {
      [b.id]: escaper(b.id),
    });
    const end = h.of('comboEnd')[0];
    expect(end?.hits).toBe(4);
    expect(end?.trueCombo).toBe(true);
    expect(h.of('dodge').length + h.of('block').length).toBe(0);
  });

  it('pressing the 2nd jab after the first one ends leaves a gap the victim escapes through', () => {
    const { a, b, h } = duel(1.2);
    h.step({ [a.id]: { buttons: B.LIGHT } });
    h.until(() => h.fighter(a.id).state === 'ground', { [b.id]: escaper(b.id) });
    h.run(2, { [b.id]: escaper(b.id) });
    h.step({ [a.id]: { buttons: B.LIGHT }, [b.id]: escaper(b.id) });
    h.run(30, { [b.id]: escaper(b.id) });
    expect(h.of('hit').length).toBe(1);
  });

  it('launcher -> jump cancel -> air string -> spike -> ground bounce', () => {
    const { a, b, h } = duel(1.2);
    let maxHeight = 0;
    const watch = () => {
      maxHeight = Math.max(maxHeight, h.fighter(b.id).pos.y);
      return {};
    };
    playSequence(
      h,
      a.id,
      [
        { button: B.LIGHT },
        { button: B.LIGHT },
        { button: B.HEAVY },
        { button: B.JUMP },
        { button: B.LIGHT },
        { button: B.LIGHT },
        { button: B.HEAVY },
      ],
      { [b.id]: watch },
    );
    const hits = h.of('hit').filter((e) => e.attacker === a.id);
    expect(hits.length).toBe(6);
    expect(maxHeight).toBeGreaterThan(2);
    expect(h.of('groundBounce').length).toBe(1);
    expect(h.of('comboEnd')[0]?.hits).toBeGreaterThanOrEqual(6);
  });

  it('damage scaling makes later hits weaker', () => {
    const { a, h } = duel(1.2);
    playSequence(h, a.id, [{ button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }]);
    const hits = h.of('hit');
    // 3rd hit (hook, 38 base) is scaled to 90%, 4th (roundhouse, 65) to 80%.
    expect(hits[2].damage).toBe(Math.round(38 * 0.9));
    expect(hits[3].damage).toBe(Math.round(65 * 0.8));
  });

  it('juggle points: an airborne victim over the limit can no longer be hit', () => {
    const { a, b, h } = duel(1.2);
    h.step({ [a.id]: { buttons: B.HEAVY, moveY: -1 } }); // launcher
    h.until(() => h.of('hit').length > 0, { [a.id]: { moveY: -1 } });
    h.fighter(b.id).combo.juggle = RULES.juggleLimit;
    h.run(25);
    // A second launcher on the falling victim whiffs.
    const before = h.of('hit').length;
    h.until(() => h.fighter(a.id).state === 'ground');
    h.step({ [a.id]: { buttons: B.HEAVY, moveY: -1 } });
    h.run(20, { [a.id]: { moveY: -1 } });
    expect(h.of('hit').length).toBe(before);
  });

  it('counter hit: hitting an attack in startup deals bonus damage', () => {
    const { a, b, h } = duel(1.3);
    h.step({ [b.id]: { buttons: B.HEAVY } }); // haymaker startup 14
    h.run(3, { [b.id]: { buttons: 0 } });
    h.step({ [a.id]: { buttons: B.LIGHT } });
    h.until(() => h.of('hit').length > 0);
    const hit = h.of('hit')[0];
    expect(hit.attacker).toBe(a.id);
    expect(hit.counter).toBe(true);
    expect(hit.damage).toBe(Math.round(28 * RULES.counterDamage));
  });
});

describe('defense', () => {
  it('blocking takes chip damage and guard damage but no hitstun', () => {
    const { a, b, h } = duel(1.2);
    h.run(15, { [b.id]: { buttons: B.BLOCK } }); // let the parry window expire
    h.step({ [a.id]: { buttons: B.LIGHT }, [b.id]: { buttons: B.BLOCK } });
    h.run(12, { [b.id]: { buttons: B.BLOCK } });
    const blk = h.of('block')[0];
    expect(blk).toBeDefined();
    expect(blk.chip).toBe(3);
    expect(h.fighter(b.id).health).toBe(997);
    expect(h.fighter(b.id).guard).toBeLessThan(100);
    expect(h.of('hit').length).toBe(0);
    expect(h.of('parry').length).toBe(0);
  });

  it('pressing block right as the hit comes parries instead of blocking', () => {
    const { a, b, h } = duel(1.2);
    h.step({ [a.id]: { buttons: B.LIGHT }, [b.id]: { buttons: B.BLOCK } });
    h.run(12, { [b.id]: { buttons: B.BLOCK } });
    expect(h.of('parry').length).toBe(1);
  });

  it('attacks from behind ignore the guard', () => {
    const { a, b, h } = duel(1.2);
    h.fighter(b.id).yaw = 0; // b turns its back on a
    h.step({ [a.id]: { buttons: B.LIGHT }, [b.id]: { buttons: B.BLOCK, yaw: 0 } });
    h.run(10, { [b.id]: { buttons: B.BLOCK, yaw: 0 } });
    expect(h.of('hit').length).toBe(1);
  });

  it('guard breaks when the guard gauge runs out', () => {
    const { a, b, h } = duel(1.2);
    h.fighter(b.id).guard = 10;
    h.step({ [a.id]: { buttons: B.HEAVY }, [b.id]: { buttons: B.BLOCK } });
    h.run(25, { [b.id]: { buttons: B.BLOCK } });
    expect(h.of('guardBreak').length).toBe(1);
    expect(h.fighter(b.id).state).toBe('stagger');
  });

  it('a fully charged haymaker is unblockable', () => {
    const { a, b, h } = duel(1.2);
    h.run(60, { [a.id]: { buttons: B.HEAVY }, [b.id]: { buttons: B.BLOCK } });
    h.run(20, { [b.id]: { buttons: B.BLOCK } });
    expect(h.of('hit').length).toBe(1);
    expect(h.of('block').length).toBe(0);
  });

  it('parry: pressing block just before impact staggers the attacker', () => {
    const { a, b, h } = duel(1.2);
    h.step({ [a.id]: { buttons: B.LIGHT } }); // jab active on frame 6
    h.step();
    h.step({ [b.id]: { buttons: B.BLOCK } }); // tick 3
    h.run(5, { [b.id]: { buttons: B.BLOCK } });
    expect(h.of('parry').length).toBe(1);
    expect(h.fighter(b.id).health).toBe(1000);
    expect(h.fighter(a.id).state).toBe('stagger');
  });

  it('parry punish: the parried attacker eats a launcher', () => {
    const { a, b, h } = duel(1.2);
    h.step({ [a.id]: { buttons: B.HEAVY } });
    h.run(10);
    h.step({ [b.id]: { buttons: B.BLOCK } });
    h.until(() => h.of('parry').length > 0, { [b.id]: { buttons: B.BLOCK } });
    h.until(() => h.fighter(b.id).hitstop === 0);
    playSequence(h, b.id, [{ button: B.HEAVY, dir: 'back' }]);
    expect(h.of('hit').some((e) => e.attacker === b.id && e.launch)).toBe(true);
  });

  it('mashing block is punished: a whiffed parry window has a cooldown', () => {
    const { a, b, h } = duel(1.2);
    h.step({ [b.id]: { buttons: B.BLOCK } }); // early press -> window expires
    h.run(8);
    h.step({ [a.id]: { buttons: B.LIGHT } });
    h.step();
    h.step({ [b.id]: { buttons: B.BLOCK } }); // re-press during the cooldown
    h.run(6, { [b.id]: { buttons: B.BLOCK } });
    expect(h.of('parry').length).toBe(0);
    expect(h.of('block').length).toBe(1);
  });

  it('dodge i-frames avoid a hit and a just-in-time dodge is "perfect"', () => {
    const { a, b, h } = duel(1.2);
    h.step({ [a.id]: { buttons: B.LIGHT } });
    h.run(2);
    h.step({ [b.id]: { buttons: B.DODGE, moveX: 1 } }); // dodge starts 3 frames before impact
    h.run(15);
    expect(h.of('hit').length).toBe(0);
    expect(h.of('perfectDodge').length).toBe(1);
  });

  it('dodge recovery is punishable', () => {
    const { a, b, h } = duel(1.2);
    h.step({ [b.id]: { buttons: B.DODGE, moveX: 1 } }); // early sidestep
    h.run(8);
    h.step({ [a.id]: { buttons: B.LIGHT } });
    h.run(12);
    const hit = h.of('hit')[0];
    expect(hit).toBeDefined();
    expect(hit.punish).toBe(true);
  });

  it('consecutive dodges lose invulnerability', () => {
    const { b, h } = duel(4);
    h.step({ [b.id]: { buttons: B.DODGE } });
    const first = h.fighter(b.id).dodgeInvulnEnd;
    h.until(() => h.fighter(b.id).state === 'ground');
    h.step({ [b.id]: { buttons: B.DODGE } });
    expect(h.fighter(b.id).dodgeInvulnEnd).toBe(first - RULES.dodge.chainPenalty);
  });
});

describe('escaping combos', () => {
  it('burst breaks a combo and blasts the attacker away', () => {
    const { a, b, h } = duel(1.2);
    let burst = false;
    const victim = () => {
      const f = h.fighter(b.id);
      if (!burst && f.combo.hits >= 3 && f.hitstop === 0) {
        burst = true;
        return { buttons: B.BURST };
      }
      return {};
    };
    playSequence(h, a.id, [{ button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }], {
      [b.id]: victim,
    });
    expect(h.of('burst').length).toBe(1);
    const end = h.of('comboEnd')[0];
    expect(end.hits).toBe(3);
    expect(h.events.some((e) => e.type === 'hit' && e.victim === a.id && e.effect === 'burst')).toBe(true);
    expect(h.fighter(b.id).burst).toBeLessThan(RULES.burstMax);
  });

  it('air tech: a juggled victim recovers once hitstun ends', () => {
    const { a, b, h } = duel(1.2);
    h.step({ [a.id]: { buttons: B.HEAVY, moveY: -1 } });
    h.until(() => h.fighter(b.id).state === 'juggle', { [a.id]: { moveY: -1 } });
    h.until(() => h.fighter(b.id).stun === 0 && h.fighter(b.id).hitstop === 0);
    h.step({ [b.id]: { buttons: B.JUMP } });
    h.step();
    expect(h.of('tech').some((e) => e.kind === 'air')).toBe(true);
  });

  it('ground tech: pressing dodge right before landing avoids the knockdown', () => {
    const { a, b, h } = duel(1.2);
    let pressed = false;
    const victim = () => {
      const f = h.fighter(b.id);
      if (!pressed && f.state === 'juggle' && f.vel.y < 0 && f.pos.y < 0.4) {
        pressed = true;
        return { buttons: B.DODGE };
      }
      return {};
    };
    playSequence(h, a.id, [{ button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }], {
      [b.id]: victim,
    });
    expect(pressed).toBe(true);
    expect(h.of('knockdown').length).toBe(0);
    expect(h.of('tech').some((e) => e.kind === 'ground')).toBe(true);
  });

  it('without a tech the same combo ends in a knockdown', () => {
    const { a, h } = duel(1.2);
    playSequence(h, a.id, [{ button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }]);
    expect(h.of('knockdown').length).toBe(1);
  });

  it('hard knockdown cannot be teched', () => {
    const { a, b, h } = duel(1.2);
    h.step({ [a.id]: { buttons: B.GRAB } });
    h.until(() => h.of('throw').length > 0);
    h.run(80, { [b.id]: (hh) => ({ buttons: hh.sim.state.frame % 2 ? B.DODGE : B.JUMP }) });
    expect(h.of('tech').length).toBe(0);
    expect(h.of('knockdown').length).toBe(1);
  });
});

describe('throws', () => {
  it('a throw beats a blocking opponent', () => {
    const { a, b, h } = duel(1.0);
    h.step({ [a.id]: { buttons: B.GRAB }, [b.id]: { buttons: B.BLOCK } });
    h.run(40, { [b.id]: { buttons: B.BLOCK } });
    expect(h.of('grab').length).toBe(1);
    expect(h.of('throw').length).toBe(1);
    expect(h.fighter(b.id).health).toBe(1000 - 110);
  });

  it('throw tech: pressing grab in time escapes', () => {
    const { a, b, h } = duel(1.0);
    h.step({ [a.id]: { buttons: B.GRAB } });
    h.until(() => h.of('grab').length > 0);
    h.run(5);
    h.step({ [b.id]: { buttons: B.GRAB } });
    h.run(30);
    expect(h.of('tech').some((e) => e.kind === 'throw')).toBe(true);
    expect(h.of('throw').length).toBe(0);
    expect(h.fighter(b.id).health).toBe(1000);
  });
});

describe('environment', () => {
  it('roundhouse into a wall causes a wall splat', () => {
    const { a, b, h, sim } = duel(1.2);
    // Put the victim 2.5m in front of the -Z wall.
    const wallZ = -sim.arena.halfZ;
    h.fighter(a.id).pos = vec3(0, 0, wallZ + 3.7);
    h.fighter(b.id).pos = vec3(0, 0, wallZ + 2.5);
    playSequence(h, a.id, [{ button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }]);
    expect(h.of('wallSplat').length).toBe(1);
  });

  it('hammer fist bounces a standing victim off the ground once per combo', () => {
    const { a, h } = duel(1.2);
    playSequence(h, a.id, [{ button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }, { button: B.HEAVY }]);
    expect(h.of('groundBounce').length).toBe(1);
  });
});

describe('interactions', () => {
  it('equal-priority strikes that meet clash and both recoil', () => {
    const { a, b, h } = duel(2.3);
    h.step({ [a.id]: { buttons: B.HEAVY }, [b.id]: { buttons: B.HEAVY } });
    h.run(25);
    expect(h.of('clash').length).toBe(1);
    expect(h.of('hit').length).toBe(0);
  });

  it('armor absorbs a hit and the armored attack still lands', () => {
    const { a, b, h } = duel(1.4, 'striker', 'brute');
    h.step({ [b.id]: { buttons: B.HEAVY } }); // armored haymaker
    h.run(4);
    h.step({ [a.id]: { buttons: B.LIGHT } });
    h.run(25);
    expect(h.of('armor').length).toBe(1);
    expect(h.of('hit').some((e) => e.attacker === b.id)).toBe(true);
  });

  it('ki cancel spends meter to cancel an attack into a dodge', () => {
    const { a, h } = duel(3);
    h.fighter(a.id).meter = 100;
    h.step({ [a.id]: { buttons: B.HEAVY } });
    h.run(4);
    h.step({ [a.id]: { buttons: B.DODGE } });
    expect(h.of('kiCancel').length).toBe(1);
    expect(h.fighter(a.id).state).toBe('dodge');
    expect(h.fighter(a.id).meter).toBe(100 - RULES.kiCancelCost);
  });

  it('projectiles can be parried back at the shooter', () => {
    const { a, b, h } = duel(6);
    h.step({ [a.id]: { buttons: B.SPECIAL } });
    h.until(() => {
      const p = h.sim.state.projectiles[0];
      return !!p && Math.abs(p.pos.z - h.fighter(b.id).pos.z) < 1.6;
    });
    h.step({ [b.id]: { buttons: B.BLOCK } });
    h.run(40, { [b.id]: { buttons: B.BLOCK } });
    expect(h.of('parry').length).toBe(1);
    expect(h.of('reflect').length).toBe(1);
    expect(h.of('hit').some((e) => e.victim === a.id)).toBe(true);
  });

  it('super costs meter and is invulnerable on startup', () => {
    const { a, b, h } = duel(1.6);
    h.fighter(a.id).meter = 120;
    h.step({ [a.id]: { buttons: B.SUPER }, [b.id]: { buttons: B.LIGHT } });
    h.run(70);
    expect(h.fighter(a.id).meter).toBeLessThan(120 - 100 + 60);
    expect(h.of('super').length).toBe(1);
    const hitsOnA = h.of('hit').filter((e) => e.victim === a.id);
    expect(hitsOnA.length).toBe(0);
    expect(h.of('hit').filter((e) => e.attacker === a.id).length).toBeGreaterThanOrEqual(6);
  });
});
