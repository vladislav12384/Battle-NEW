import { describe, expect, it } from 'vitest';
import { Bot } from '../src/core/ai/bot';
import { RULES } from '../src/core/rules';
import { Coach, LESSONS, nextStrikes, Tutorial } from '../src/client/tutorial';
import { B, duel, playSequence } from './helpers';

/** Runs a lesson against a partner set up like the game does, feeding all events to the tutorial. */
function lesson(id: string, act: (h: ReturnType<typeof duel>['h'], a: number, b: number) => void) {
  const { a, b, h, sim } = duel(1.2);
  const t = new Tutorial(LESSONS.filter((l) => l.id === id));
  act(h, a.id, b.id);
  t.feed(h.events, { sim, me: a.id });
  return t;
}

describe('tutorial', () => {
  it('the string lesson is passed with four punches in rhythm', () => {
    const t = lesson('string', (h, a) => playSequence(h, a, [{ button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }]));
    expect(t.doneFor).toBe(0);
  });

  it('the finisher lesson counts string enders', () => {
    const t = new Tutorial(LESSONS.filter((l) => l.id === 'finisher'));
    for (const seq of [[B.LIGHT, B.HEAVY], [B.LIGHT, B.LIGHT, B.HEAVY]]) {
      const { a, h, sim } = duel(1.2);
      playSequence(h, a.id, seq.map((button) => ({ button })), {}, 150);
      t.feed(h.events, { sim, me: a.id });
    }
    expect(t.progress).toBe(2);
    expect(t.doneFor).toBe(0);
  });

  it('the launch lesson needs a hit in the air after the jump', () => {
    const t = lesson('launch', (h, a) =>
      playSequence(h, a, [{ button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }, { button: B.HEAVY }, { button: B.JUMP }, { button: B.LIGHT }], {}, 200),
    );
    expect(t.doneFor).toBe(0);
  });

  it('the throw lesson is passed by throwing a blocking partner', () => {
    const t = lesson('throw', (h, a, b) => {
      h.run(5, { [b]: { buttons: B.BLOCK } });
      h.step({ [a]: { buttons: B.LIGHT | B.HEAVY | B.GRAB }, [b]: { buttons: B.BLOCK } });
      h.run(60, { [b]: { buttons: B.BLOCK } });
    });
    expect(t.doneFor).toBe(0);
  });

  it('a lesson that is not done does not complete', () => {
    const t = lesson('parry', (h) => h.run(60));
    expect(t.progress).toBe(0);
    expect(t.doneFor).toBe(-1);
  });

  it('lessons follow one another to the end of the course', () => {
    const t = new Tutorial();
    let n = 1;
    while (t.next()) n++;
    expect(n).toBe(LESSONS.length);
    expect(t.finished).toBe(true);
  });
});

describe('learning aids', () => {
  it('during a string the hint shows what each button gives next', () => {
    const { a, h, sim } = duel(1.2);
    h.step({ [a.id]: { buttons: B.LIGHT } });
    expect(nextStrikes(sim, h.fighter(a.id))).toBeNull(); // no contact yet
    h.until(() => h.of('hit').length > 0);
    const next = nextStrikes(sim, h.fighter(a.id));
    expect(next?.light).toBe('cross');
    expect(next?.heavy).toBe('roundhouse_r');
  });

  it('with the opponent down, the hint shows the finishing stomp', () => {
    const { a, b, h, sim } = duel(1.2);
    h.step({ [a.id]: { buttons: B.HEAVY, moveY: -1 } }); // sweep
    h.until(() => h.fighter(b.id).state === 'knockdown');
    const f = h.fighter(a.id);
    expect(f.state).toBe('attack'); // still recovering from the sweep, string open
    expect(nextStrikes(sim, f)?.light).toBe('stomp');
  });

  it('the coach points out a downed opponent and a full burst gauge', () => {
    const { a, b, h, sim } = duel(1.2);
    const coach = new Coach();
    h.step({ [a.id]: { buttons: B.HEAVY, moveY: -1 } }); // sweep
    h.until(() => h.fighter(b.id).state === 'knockdown');
    h.until(() => h.fighter(a.id).state === 'ground');
    expect(coach.update(sim, h.fighter(a.id), [], false)?.id).toBe('down');

    // b strings a; a is comboed with a full gauge.
    const tips = new Set<string>();
    const coach2 = new Coach();
    const d = duel(1.2);
    d.h.fighter(d.a.id).burst = RULES.burstMax;
    playSequence(d.h, d.b.id, [{ button: B.LIGHT }, { button: B.LIGHT }, { button: B.LIGHT }], {
      [d.a.id]: (hh) => {
        const tip = coach2.update(d.sim, hh.fighter(d.a.id), [], false);
        if (tip) tips.add(tip.id);
        return {};
      },
    });
    expect(tips.has('burst')).toBe(true);
  });

  it('the drill partner walks up and repeats its attack', () => {
    const { a, b, h, sim } = duel(3);
    const bot = new Bot(b.id, { seed: 3 });
    bot.setDrill('haymaker', 90);
    h.run(500, { [b.id]: () => ({}) });
    let attacks = 0;
    for (let t = 0; t < 600; t++) {
      for (const e of sim.step({ [b.id]: bot.think(sim) })) if (e.type === 'attack' && e.fighter === b.id) attacks++;
    }
    expect(attacks).toBeGreaterThanOrEqual(4);
    expect(h.fighter(a.id)).toBeDefined();
  });
});
