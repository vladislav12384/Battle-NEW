import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/rules';
import type { Swipe } from '../src/core/input';
import { DEG, vec3, wrapAngle, yawTo } from '../src/core/math/vec3';
import { B, blocker, duel, escaper, playSequence, type Step } from './helpers';

describe('frame data', () => {
  it('a jab connects on the first frame after its startup', () => {
    const { a, h, sim } = duel(1.2);
    const jab = sim.chars.striker.moves.jab;
    h.step({ [a.id]: { buttons: B.LIGHT } }); // move frame 1
    let frames = 1;
    while (h.of('hit').length === 0 && frames < 40) {
      h.step();
      frames++;
    }
    expect(frames).toBe(jab.startup + 1);
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

const sw = (button: number, swipe?: Swipe, dir?: 'forward' | 'back'): Step => ({ button, swipe, dir });

describe('directional strikes', () => {
  const table: [string, number, Swipe, string][] = [
    ['punch', B.LIGHT, 'none', 'jab'],
    ['punch + flick left', B.LIGHT, 'left', 'hook_r'],
    ['punch + flick right', B.LIGHT, 'right', 'hook_l'],
    ['punch + flick up', B.LIGHT, 'up', 'uppercut'],
    ['punch + flick down', B.LIGHT, 'down', 'body_blow'],
    ['power', B.HEAVY, 'none', 'haymaker'],
    ['power + flick up', B.HEAVY, 'up', 'rising_uppercut'],
    ['power + flick down', B.HEAVY, 'down', 'hammer'],
    ['power + flick left', B.HEAVY, 'left', 'spin_backfist'],
    ['kick', B.KICK, 'none', 'teep'],
    ['kick + flick left', B.KICK, 'left', 'roundhouse_r'],
    ['kick + flick right', B.KICK, 'right', 'roundhouse_l'],
    ['kick + flick up', B.KICK, 'up', 'high_kick'],
    ['kick + flick down', B.KICK, 'down', 'heel_axe'],
  ];
  for (const [label, button, swipe, move] of table) {
    it(`${label} -> ${move}`, () => {
      const { a, h } = duel(1.2);
      h.step({ [a.id]: { buttons: button, swipe } });
      expect(h.fighter(a.id).move).toBe(move);
    });
  }

  it('straight punches alternate hands: jab, cross, jab', () => {
    const { a, h } = duel(1.2);
    playSequence(h, a.id, [sw(B.LIGHT), sw(B.LIGHT), sw(B.LIGHT)]);
    expect(h.of('attack').map((e) => e.move)).toEqual(['jab', 'cross', 'jab']);
  });

  it('back + kick is a sweep that knocks down', () => {
    const { a, h } = duel(1.2);
    playSequence(h, a.id, [sw(B.KICK, 'none', 'back')]);
    expect(h.of('attack')[0].move).toBe('sweep');
    expect(h.of('knockdown').length).toBe(1);
  });

  it('kicking an opponent who lies in front of you is a stomp', () => {
    const { a, b, h } = duel(1.2);
    h.step({ [a.id]: { buttons: B.KICK, moveY: -1 } }); // sweep
    h.until(() => h.fighter(b.id).state === 'knockdown');
    h.until(() => h.fighter(a.id).state === 'ground');
    h.step({ [a.id]: { buttons: B.KICK } });
    expect(h.fighter(a.id).move).toBe('stomp');
    h.run(15);
    expect(h.of('hit').filter((e) => e.attacker === a.id).length).toBe(2);
  });
});

describe('free-form combos', () => {
  it('a player-composed string is a true combo: jab, cross, right hook, uppercut', () => {
    const { a, b, h } = duel(1.2);
    playSequence(h, a.id, [sw(B.LIGHT), sw(B.LIGHT), sw(B.LIGHT, 'left'), sw(B.LIGHT, 'up')], {
      [b.id]: escaper(b.id),
    });
    const end = h.of('comboEnd')[0];
    expect(end?.hits).toBe(4);
    expect(end?.trueCombo).toBe(true);
    expect(h.of('dodge').length + h.of('block').length).toBe(0);
  });

  it('an uppercut pops them up long enough to follow with a roundhouse kick', () => {
    const { a, b, h } = duel(1.2);
    playSequence(h, a.id, [sw(B.LIGHT), sw(B.LIGHT, 'up'), sw(B.KICK, 'left')], { [b.id]: blocker(b.id) }, 200);
    const end = h.of('comboEnd')[0];
    expect(end?.hits).toBe(3);
    expect(end?.trueCombo).toBe(true);
  });

  it('punches flow into kicks: jab, left hook, roundhouse', () => {
    const { a, b, h } = duel(1.2);
    playSequence(h, a.id, [sw(B.LIGHT), sw(B.LIGHT, 'right'), sw(B.KICK, 'left')], { [b.id]: escaper(b.id) });
    const end = h.of('comboEnd')[0];
    expect(end?.hits).toBe(3);
    expect(end?.trueCombo).toBe(true);
  });

  it('spamming one strike goes stale and the victim escapes; mixing keeps it true', () => {
    const spam = duel(1.2);
    playSequence(spam.h, spam.a.id, Array.from({ length: 7 }, () => sw(B.LIGHT)), {
      [spam.b.id]: blocker(spam.b.id),
    });
    const spamHits = spam.h.of('hit').filter((e) => e.attacker === spam.a.id).length;
    expect(spamHits).toBeLessThan(7);
    expect(spam.h.of('block').length).toBeGreaterThan(0);

    const mix = duel(1.2);
    playSequence(
      mix.h,
      mix.a.id,
      [sw(B.LIGHT), sw(B.LIGHT), sw(B.LIGHT, 'down'), sw(B.LIGHT, 'left'), sw(B.LIGHT, 'right')],
      { [mix.b.id]: blocker(mix.b.id) },
    );
    expect(mix.h.of('comboEnd')[0]?.hits).toBe(5);
    expect(mix.h.of('comboEnd')[0]?.trueCombo).toBe(true);
  });

  it('a whiffed heavy cannot chain: it has to recover', () => {
    const { a, h, sim } = duel(5);
    const hay = sim.chars.striker.moves.haymaker;
    h.step({ [a.id]: { buttons: B.HEAVY } });
    h.run(hay.startup + hay.active + 1); // whiffed, now recovering
    h.step({ [a.id]: { buttons: B.LIGHT } });
    h.run(3);
    expect(h.fighter(a.id).move).toBe('haymaker');
    h.until(() => h.fighter(a.id).state !== 'attack');
    expect(h.of('attack').length).toBe(1);
  });

  it('a missed punch cannot chain: it plays out its recovery plus a whiff penalty', () => {
    const { a, h, sim } = duel(5);
    const jab = sim.chars.striker.moves.jab;
    h.step({ [a.id]: { buttons: B.LIGHT } });
    let t = 1;
    while (h.fighter(a.id).state === 'attack' && t < 100) {
      // Mash punches: none of them may come out before the jab is over.
      h.step({ [a.id]: { buttons: t % 2 ? B.LIGHT : 0 } });
      t++;
      if (h.fighter(a.id).move === 'cross') break;
    }
    expect(h.of('whiff').length).toBe(1);
    expect(t).toBeGreaterThanOrEqual(jab.startup + jab.active + jab.recovery + RULES.whiffPenalty.light);
  });

  it('missing costs stamina, landing refunds part of it', () => {
    const miss = duel(5);
    miss.h.step({ [miss.a.id]: { buttons: B.HEAVY } });
    miss.h.run(10);
    const afterMiss = miss.h.fighter(miss.a.id).stamina;
    const hit = duel(1.2);
    hit.h.step({ [hit.a.id]: { buttons: B.HEAVY } });
    hit.h.until(() => hit.h.of('hit').length > 0);
    hit.h.step();
    expect(hit.h.fighter(hit.a.id).stamina).toBeGreaterThan(afterMiss);
  });

  it('pressing the next punch after the first one ends leaves a gap the victim escapes through', () => {
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
      [sw(B.LIGHT), sw(B.LIGHT, 'down'), sw(B.HEAVY, 'up'), sw(B.JUMP), sw(B.LIGHT), sw(B.LIGHT), sw(B.HEAVY)],
      { [b.id]: watch },
      240,
    );
    const hits = h.of('hit').filter((e) => e.attacker === a.id);
    expect(hits.length).toBe(6);
    expect(maxHeight).toBeGreaterThan(2);
    expect(h.of('groundBounce').length).toBe(1);
    expect(h.of('comboEnd')[0]?.hits).toBeGreaterThanOrEqual(6);
  });

  it('damage scaling makes later hits weaker', () => {
    const { a, h } = duel(1.2);
    playSequence(h, a.id, [sw(B.LIGHT), sw(B.LIGHT), sw(B.LIGHT, 'left'), sw(B.LIGHT, 'up')]);
    const hits = h.of('hit');
    // 3rd hit (right hook, 34 base) is scaled to 90%, 4th (uppercut, 32) to 80%.
    expect(hits[2].damage).toBe(Math.round(34 * 0.9));
    expect(hits[3].damage).toBe(Math.round(32 * 0.8));
  });

  it('juggle points: an airborne victim over the limit can no longer be hit', () => {
    const { a, b, h } = duel(1.2);
    h.step({ [a.id]: { buttons: B.HEAVY, swipe: 'up' } }); // launcher
    h.until(() => h.of('hit').length > 0);
    h.fighter(b.id).combo.juggle = RULES.juggleLimit;
    h.run(25);
    const before = h.of('hit').length;
    h.until(() => h.fighter(a.id).state === 'ground');
    h.step({ [a.id]: { buttons: B.HEAVY, swipe: 'up' } });
    h.run(20);
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
    expect(hit.damage).toBe(Math.round(26 * RULES.counterDamage));
  });
});

describe('player control', () => {
  it('attacks go where you look: a jab thrown well away from the enemy whiffs', () => {
    const { a, b, h } = duel(1.2);
    const away = yawTo(h.fighter(a.id).pos, h.fighter(b.id).pos) + 40 * DEG;
    h.step({ [a.id]: { buttons: B.LIGHT, yaw: away } });
    h.run(12, { [a.id]: { yaw: away } });
    expect(h.of('hit').length).toBe(0);
    expect(Math.abs(wrapAngle(h.fighter(a.id).yaw - away))).toBeLessThan(1e-6);
  });

  it('aim assist nudges the body (never the camera) toward an enemy near the crosshair', () => {
    const { a, b, h } = duel(1.2);
    const off = yawTo(h.fighter(a.id).pos, h.fighter(b.id).pos) + 10 * DEG;
    h.step({ [a.id]: { buttons: B.LIGHT, yaw: off } });
    h.run(8, { [a.id]: { yaw: off } });
    expect(h.of('hit').length).toBe(1);
    const diff = Math.abs(wrapAngle(h.fighter(a.id).yaw - off));
    expect(diff).toBeGreaterThan(0);
    expect(diff).toBeLessThanOrEqual(RULES.assistMaxYaw + 1e-6);
  });

  it('you keep moving while you strike', () => {
    const { a, h } = duel(3);
    const x0 = h.fighter(a.id).pos.x;
    h.step({ [a.id]: { buttons: B.LIGHT, moveX: 1 } });
    h.run(12, { [a.id]: { moveX: 1 } });
    expect(h.fighter(a.id).pos.x - x0).toBeGreaterThan(0.15);
  });

  it('feint: block during a heavy startup cancels it', () => {
    const { a, h } = duel(3);
    h.step({ [a.id]: { buttons: B.HEAVY } });
    h.run(3);
    h.step({ [a.id]: { buttons: B.BLOCK } });
    expect(h.of('feint').length).toBe(1);
    expect(h.fighter(a.id).state).toBe('block');
  });

  it('a raised guard turns slowly: a strike from the flank gets through', () => {
    const { a, b, h } = duel(1.2);
    const toA = yawTo(h.fighter(b.id).pos, h.fighter(a.id).pos);
    h.fighter(b.id).yaw = toA + 120 * DEG; // b looks away, guard up
    h.run(15, { [b.id]: { buttons: B.BLOCK, yaw: toA + 120 * DEG } });
    // b snaps the camera toward a as the jab comes, but the guard lags behind.
    h.step({ [a.id]: { buttons: B.LIGHT }, [b.id]: { buttons: B.BLOCK, yaw: toA } });
    h.run(10, { [b.id]: { buttons: B.BLOCK, yaw: toA } });
    expect(h.of('hit').length).toBe(1);
    expect(h.of('block').length).toBe(0);
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
    expect(h.fighter(b.id).stamina).toBeLessThan(100);
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

  it('blocking with no stamina left breaks the guard', () => {
    const { a, b, h } = duel(1.2);
    h.fighter(b.id).stamina = 10;
    h.step({ [a.id]: { buttons: B.HEAVY }, [b.id]: { buttons: B.BLOCK } });
    h.run(25, { [b.id]: { buttons: B.BLOCK } });
    expect(h.of('guardBreak').length).toBe(1);
    expect(h.fighter(b.id).state).toBe('stagger');
  });

  it('a fully charged haymaker is unblockable', () => {
    const { a, b, h } = duel(1.2);
    const hay = h.sim.chars.striker.moves.haymaker;
    h.run(hay.charge!.frame + hay.charge!.fullAt + 5, { [a.id]: { buttons: B.HEAVY }, [b.id]: { buttons: B.BLOCK } });
    h.run(30, { [b.id]: { buttons: B.BLOCK } });
    expect(h.of('hit').length).toBe(1);
    expect(h.of('block').length).toBe(0);
  });

  it('parry: pressing block just before impact staggers the attacker', () => {
    const { a, b, h } = duel(1.2);
    const jab = h.sim.chars.striker.moves.jab;
    h.step({ [a.id]: { buttons: B.LIGHT } });
    h.run(jab.startup - 3);
    h.step({ [b.id]: { buttons: B.BLOCK } }); // 3 frames before impact
    h.run(8, { [b.id]: { buttons: B.BLOCK } });
    expect(h.of('parry').length).toBe(1);
    expect(h.fighter(b.id).health).toBe(1000);
    expect(h.fighter(a.id).state).toBe('stagger');
  });

  it('parry punish: the parried attacker eats a launcher', () => {
    const { a, b, h } = duel(1.2);
    const hay = h.sim.chars.striker.moves.haymaker;
    h.step({ [a.id]: { buttons: B.HEAVY } });
    h.run(hay.startup - 4);
    h.step({ [b.id]: { buttons: B.BLOCK } });
    h.until(() => h.of('parry').length > 0, { [b.id]: { buttons: B.BLOCK } });
    h.until(() => h.fighter(b.id).hitstop === 0);
    playSequence(h, b.id, [sw(B.HEAVY, 'up')]);
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
    // The attacker chases: holding forward adds step-in.
    h.step({ [a.id]: { buttons: B.LIGHT, moveY: 1 } });
    h.run(12, { [a.id]: { moveY: 1 } });
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
    h.step({ [a.id]: { buttons: B.HEAVY, swipe: 'up' } });
    h.until(() => h.fighter(b.id).state === 'juggle');
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
    playSequence(h, a.id, [sw(B.LIGHT), sw(B.KICK, 'left')], { [b.id]: victim });
    expect(pressed).toBe(true);
    expect(h.of('knockdown').length).toBe(0);
    expect(h.of('tech').some((e) => e.kind === 'ground')).toBe(true);
  });

  it('without a tech the same combo ends in a knockdown', () => {
    const { a, h } = duel(1.2);
    playSequence(h, a.id, [sw(B.LIGHT), sw(B.KICK, 'left')]);
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
  it('a roundhouse kick into a wall causes a wall splat', () => {
    const { a, b, h, sim } = duel(1.2);
    // Put the victim 1.6m in front of the -Z wall.
    const wallZ = -sim.arena.halfZ;
    h.fighter(a.id).pos = vec3(0, 0, wallZ + 2.8);
    h.fighter(b.id).pos = vec3(0, 0, wallZ + 1.6);
    playSequence(h, a.id, [sw(B.LIGHT), sw(B.KICK, 'left')]);
    expect(h.of('wallSplat').length).toBe(1);
  });

  it('hammer fist bounces a standing victim off the ground once per combo', () => {
    const { a, h } = duel(1.2);
    playSequence(h, a.id, [sw(B.LIGHT), sw(B.LIGHT), sw(B.HEAVY, 'down')]);
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

describe('stamina', () => {
  it('running dry exhausts you: no dodging, and the next blocked hit breaks your guard', () => {
    const { a, b, h } = duel(1.2);
    h.fighter(b.id).stamina = 5;
    h.step({ [b.id]: { buttons: B.DODGE } });
    expect(h.of('exhausted').length).toBe(1);
    h.until(() => h.fighter(b.id).state === 'ground');
    h.step({ [b.id]: { buttons: B.DODGE } });
    expect(h.fighter(b.id).state).not.toBe('dodge');
    h.fighter(b.id).pos = vec3(0, 0, -1.2); // the first dodge carried b out of reach
    h.run(12, { [b.id]: { buttons: B.BLOCK } });
    h.step({ [a.id]: { buttons: B.LIGHT }, [b.id]: { buttons: B.BLOCK } });
    h.run(20, { [b.id]: { buttons: B.BLOCK } });
    expect(h.of('guardBreak').length).toBe(1);
  });

  it('exhausted strikes come out slower', () => {
    const hitFrame = (exhausted: boolean): number => {
      const { a, h } = duel(1.2);
      if (exhausted) {
        h.fighter(a.id).stamina = 0;
        h.fighter(a.id).exhausted = true;
      }
      h.step({ [a.id]: { buttons: B.LIGHT } });
      return h.until(() => h.of('hit').length > 0);
    };
    expect(hitFrame(true)).toBeGreaterThan(hitFrame(false) + 2);
  });

  it('stamina comes back once you stop spending', () => {
    const { a, h } = duel(4);
    h.step({ [a.id]: { buttons: B.HEAVY } });
    h.run(5);
    const low = h.fighter(a.id).stamina;
    h.run(160);
    expect(h.fighter(a.id).stamina).toBeGreaterThan(low + 10);
  });
});
