/**
 * Learning aids, kept free of rendering code so they can be tested:
 *
 *   - Tutorial: a short course of lessons, each with a goal detected from
 *     simulation events and a setup for the training partner.
 *   - Coach: contextual tips during normal play ("enemy is down: finish him",
 *     "full burst gauge: F", "heavy blow incoming: dash"...).
 *   - nextStrikes: what each attack button gives next in the current string.
 */
import { Button } from '../core/input';
import type { BotMode } from '../core/ai/bot';
import type { Simulation } from '../core/simulation';
import type { FighterState, GameEvent } from '../core/state';
import { lastActiveFrame, totalFrames } from '../core/moves';
import { wrapAngle, yawFromDir } from '../core/math/vec3';
import { RULES } from '../core/rules';

/** Display names of the Striker's moves. */
export const MOVE_NAMES: Record<string, string> = {
  jab: 'Джеб',
  cross: 'Кросс',
  hook_l: 'Левый хук',
  hook_r: 'Правый хук',
  uppercut: 'Апперкот',
  body_blow: 'По корпусу',
  haymaker: 'Хеймейкер',
  spin_backfist: 'Бэкфист с разворота',
  rising_uppercut: 'Подброс',
  hammer: 'Молот',
  dash_straight: 'Удар с разбега',
  teep: 'Толчок ногой',
  roundhouse_r: 'Круговой',
  roundhouse_l: 'Круговой',
  high_kick: 'Высокий мах',
  heel_axe: 'Топор пяткой',
  sweep: 'Подсечка',
  stomp: 'Добивание',
  flying_knee: 'Летящее колено',
  air_jab: 'Удар в воздухе',
  air_cross: 'Кросс в воздухе',
  air_upper: 'Апперкот в воздухе',
  air_hammer: 'Молот вниз',
  axe_kick: 'Топор вниз',
  air_spin: 'Вертушка',
  dive_kick: 'Удар в пике',
  ki_blast: 'Волна ки',
  air_ki_blast: 'Волна ки',
  shoulder_rush: 'Таран плечом',
  rising_dragon: 'Восходящий дракон',
  barrage: 'Сто кулаков',
  grab: 'Бросок',
  optic_blast: 'Оптический выстрел',
  optic_recoil: 'Отлёт',
  optic_recoil_air: 'Отлёт в воздухе',
  ricochet: 'Рикошет',
  ricochet_super: 'Рикошет визора',
  cyclone_kick: 'Циклон',
  point_blank: 'Выстрел в упор',
  gene_splice: 'Генный сплайс',
  mega_beam: 'Мега-луч',
  grab_cyclops: 'Бросок',
  cyclops_showcase: 'Небесный луч',
};

export const moveName = (id: string | null | undefined, fallback = ''): string =>
  (id && MOVE_NAMES[id]) || fallback || id || '';

// ===========================================================================
// Next strike of the string

export interface NextStrikes {
  light: string | null;
  heavy: string | null;
  /** A launcher landed: jump after the opponent. */
  jump: boolean;
}

/**
 * While a string is going (the current strike made contact and can chain),
 * the strike each attack button would give next. Null when no string.
 */
export function nextStrikes(sim: Simulation, f: FighterState): NextStrikes | null {
  const m = sim.moveOf(f);
  if (f.state !== 'attack' || !m || (m.kind !== 'light' && m.kind !== 'heavy')) return null;
  if (!(f.moveHit || f.moveBlocked) || f.mashed || f.moveFrame > totalFrames(m)) return null;
  const seq = f.stringPos + 1;
  const air = !f.grounded;
  // Same matching as the game (stick in neutral): situations first, then the string.
  const down = sim.state.fighters.some((e) => {
    if (e.team === f.team || e.state !== 'knockdown') return false;
    const dx = e.pos.x - f.pos.x;
    const dz = e.pos.z - f.pos.z;
    return Math.hypot(dx, dz) <= 2.3 && Math.abs(wrapAngle(yawFromDir(dx, dz) - f.yaw)) < Math.PI / 3;
  });
  const find = (button: number): string | null =>
    sim
      .charCommands(f)
      .find(
        (c) =>
          c.button === button &&
          !c.dir &&
          !c.running &&
          (!c.context || (c.context === 'targetDown' && down)) &&
          (c.air === undefined || c.air === air) &&
          (!c.seq || (seq >= c.seq[0] && seq <= c.seq[1])),
      )?.move ?? null;
  return {
    light: find(Button.LIGHT),
    heavy: find(Button.HEAVY),
    jump: !!m.jumpCancel && f.moveHit && f.moveFrame >= m.jumpCancel.frames[0] - 4,
  };
}

// ===========================================================================
// Tutorial

export interface LessonSetup {
  /** Behaviour of the training partner. */
  bot: BotMode;
  /** Drill: the attack plan it repeats and the pause between repetitions (frames). */
  drill?: string;
  drillEvery?: number;
  /** Keep the player's burst gauge full (burst lesson). */
  fullBurst?: boolean;
  /** The partner fights for real (final lesson): no health floor. */
  real?: boolean;
}

export interface LessonCtx {
  sim: Simulation;
  me: number;
}

export interface Lesson {
  id: string;
  title: string;
  /** Instruction (HTML, keys as <kbd>). */
  text: string;
  goal: number;
  setup: LessonSetup;
  /** How much one event advances the lesson. */
  count(e: GameEvent, ctx: LessonCtx): number;
}

const FINISHERS = new Set(['roundhouse_r', 'spin_backfist', 'rising_uppercut', 'heel_axe', 'cyclone_kick', 'point_blank', 'gene_splice']);

export const LESSONS: Lesson[] = [
  {
    id: 'string',
    title: 'Серия в ритм',
    text: 'Нажимай <kbd>ЛКМ</kbd> каждый раз, <b>когда предыдущий удар попал</b> — у прицела вспыхивает кольцо. Каждое нажатие даёт новый удар: джеб → кросс → хук → апперкот. Сделай серию из 4 ударов. Не закликивай: нажатие во время замаха ломает серию.',
    goal: 1,
    setup: { bot: 'idle' },
    count: (e, c) => (e.type === 'hit' && e.attacker === c.me && e.comboHits === 4 ? 1 : 0),
  },
  {
    id: 'finisher',
    title: 'Добивание',
    text: 'Закончи серию <kbd>ПКМ</kbd>. Чем длиннее серия, тем мощнее добивание: <kbd>ЛКМ</kbd> <kbd>ПКМ</kbd> — круговой, <kbd>ЛКМ</kbd> <kbd>ЛКМ</kbd> <kbd>ПКМ</kbd> — бэкфист с разворота. Подсказка под прицелом показывает, что даст каждая кнопка. Сделай 2 добивания.',
    goal: 2,
    setup: { bot: 'idle' },
    count: (e, c) => (e.type === 'hit' && e.attacker === c.me && !!e.move && FINISHERS.has(e.move) ? 1 : 0),
  },
  {
    id: 'launch',
    title: 'Подброс и воздух',
    text: '<kbd>ЛКМ</kbd> ×3, затем <kbd>ПКМ</kbd> — подброс, противник взлетает. Сразу жми <kbd>Space</kbd>: прыгнешь следом. В воздухе бей <kbd>ЛКМ</kbd>, а <kbd>ПКМ</kbd> вобьёт его в землю.',
    goal: 1,
    setup: { bot: 'idle' },
    count: (e, c) => (e.type === 'hit' && e.attacker === c.me && !!e.move && e.move.startsWith('air_') ? 1 : 0),
  },
  {
    id: 'charge',
    title: 'Заряженный удар',
    text: 'Зажми <kbd>ПКМ</kbd> и держи — кулак отведён и светится. Отпусти, когда заряд наберётся. Полностью заряженный хеймейкер не блокируется.',
    goal: 1,
    setup: { bot: 'idle' },
    count: (e, c) => (e.type === 'hit' && e.attacker === c.me && e.move === 'haymaker' && e.damage >= 105 ? 1 : 0),
  },
  {
    id: 'block',
    title: 'Блок',
    text: 'Партнёр атакует сериями. Держи <kbd>F</kbd> — блок спереди. Заблокируй 3 удара. Блок тратит выносливость (жёлтая шкала).',
    goal: 3,
    setup: { bot: 'drill', drill: 'boxing', drillEvery: 100 },
    count: (e, c) => (e.type === 'block' && e.victim === c.me ? 1 : 0),
  },
  {
    id: 'dodge',
    title: 'Уклон',
    text: 'Тяжёлый удар видно заранее: у прицела появляется оранжевая дуга. Уйди рывком <kbd>Shift</kbd> + <kbd>A</kbd> или <kbd>D</kbd>. Удар летит слева — рви вправо. Уклонись 3 раза.',
    goal: 3,
    setup: { bot: 'drill', drill: 'haymaker', drillEvery: 110 },
    count: (e, c) => ((e.type === 'evade' || e.type === 'perfectDodge') && e.fighter === c.me ? 1 : 0),
  },
  {
    id: 'perfect',
    title: 'Идеальный уклон',
    text: 'Жди до последнего: когда дуга у прицела <b>вспыхнет белым</b>, жми <kbd>Shift</kbd> + <kbd>A</kbd>/<kbd>D</kbd>. Противник замедлится — бей в ответ.',
    goal: 1,
    setup: { bot: 'drill', drill: 'haymaker', drillEvery: 110 },
    count: (e, c) => (e.type === 'perfectDodge' && e.fighter === c.me ? 1 : 0),
  },
  {
    id: 'parry',
    title: 'Парирование',
    text: 'Нажми <kbd>F</kbd> <b>прямо перед ударом</b> (не держи заранее). Парированный противник оглушён — время для серии.',
    goal: 1,
    setup: { bot: 'drill', drill: 'haymaker', drillEvery: 110 },
    count: (e, c) => (e.type === 'parry' && e.victim === c.me ? 1 : 0),
  },
  {
    id: 'throw',
    title: 'Бросок',
    text: 'Противник закрылся блоком — удары не проходят. Нажми <kbd>ЛКМ</kbd> и <kbd>ПКМ</kbd> <b>вместе</b> — бросок пробивает блок.',
    goal: 1,
    setup: { bot: 'block' },
    count: (e, c) => (e.type === 'throw' && e.attacker === c.me ? 1 : 0),
  },
  {
    id: 'burst',
    title: 'Взрыв',
    text: 'Не блокируй и дай себя ударить. Когда тебя бьют серией, а розовая шкала взрыва полна, нажми <kbd>F</kbd> — взрыв отбросит противника.',
    goal: 1,
    setup: { bot: 'drill', drill: 'boxing', drillEvery: 90, fullBurst: true },
    count: (e, c) => (e.type === 'burst' && e.fighter === c.me ? 1 : 0),
  },
  {
    id: 'fight',
    title: 'Бой',
    text: 'Финал: отправь противника в нокаут. Серии в ритм, добивания, уклоны по индикатору, блок и броски — всё пригодится.',
    goal: 1,
    setup: { bot: 'fighter', real: true },
    count: (e, c) => (e.type === 'ko' && e.fighter !== c.me ? 1 : 0),
  },
];

export class Tutorial {
  index = 0;
  progress = 0;
  /** Ticks since the current lesson was completed (-1 = in progress). */
  doneFor = -1;

  constructor(readonly lessons: Lesson[] = LESSONS) {}

  get lesson(): Lesson {
    return this.lessons[this.index];
  }

  get finished(): boolean {
    return this.index >= this.lessons.length;
  }

  /** Counts this tick's events; returns what happened to the lesson. */
  feed(events: readonly GameEvent[], ctx: LessonCtx): 'progress' | 'complete' | null {
    if (this.finished || this.doneFor >= 0) {
      if (this.doneFor >= 0) this.doneFor++;
      return null;
    }
    const before = this.progress;
    for (const e of events) this.progress += this.lesson.count(e, ctx);
    if (this.progress >= this.lesson.goal) {
      this.progress = this.lesson.goal;
      this.doneFor = 0;
      return 'complete';
    }
    return this.progress > before ? 'progress' : null;
  }

  /** Moves to the next lesson; false when the course is over. */
  next(): boolean {
    this.index++;
    this.progress = 0;
    this.doneFor = -1;
    return !this.finished;
  }
}

// ===========================================================================
// Coach: contextual tips during normal play

export interface Tip {
  id: string;
  /** HTML, keys as <kbd>. */
  text: string;
}

interface TipRule {
  id: string;
  text: string;
  /** Frames before the same tip may show again. */
  cooldown: number;
  /** Stop showing after this many times (learned). */
  max: number;
}

const TIPS: Record<string, TipRule> = {
  jump: { id: 'jump', text: '<kbd>Space</kbd> — прыгни за ним и продолжай в воздухе', cooldown: 0, max: 6 },
  down: { id: 'down', text: 'Противник лежит — атакуй: <b>добивание</b>', cooldown: 600, max: 3 },
  burst: { id: 'burst', text: 'Тебя бьют серией, шкала взрыва полна — <kbd>F</kbd>: <b>взрыв</b>', cooldown: 900, max: 4 },
  heavy: { id: 'heavy', text: 'Тяжёлый удар! Уйди рывком: <kbd>Shift</kbd> + <kbd>A</kbd>/<kbd>D</kbd>', cooldown: 600, max: 4 },
  tired: { id: 'tired', text: 'Выносливость на исходе — отойди и отдышись', cooldown: 1200, max: 3 },
  blocked: { id: 'blocked', text: 'Противник в блоке — бросок: <kbd>ЛКМ</kbd> + <kbd>ПКМ</kbd> вместе', cooldown: 900, max: 3 },
  mash: { id: 'mash', text: 'Не закликивай: жми следующий удар, <b>когда предыдущий попал</b> (кольцо у прицела)', cooldown: 900, max: 3 },
  counter: { id: 'counter', text: 'Противник замедлен — бей сейчас!', cooldown: 300, max: 5 },
};

export class Coach {
  private shown = new Map<string, number>();
  private last = new Map<string, number>();
  private blocks = 0;
  private current: { tip: Tip; until: number } | null = null;

  /** Feeds a tick; returns the tip to show (or null). */
  update(sim: Simulation, me: FighterState | undefined, events: readonly GameEvent[], threatHeavy: boolean): Tip | null {
    const now = sim.state.frame;
    if (!me) return null;
    for (const e of events) {
      if (e.type === 'block' && e.attacker === me.id) this.blocks++;
      if (e.type === 'hit' && e.attacker === me.id) this.blocks = 0;
      if (e.type === 'mash' && e.fighter === me.id) this.offer('mash', now, 150);
      if (e.type === 'perfectDodge' && e.fighter === me.id) this.offer('counter', now, 60);
    }
    const m = sim.moveOf(me);
    if (me.state === 'attack' && m?.jumpCancel && me.moveHit && me.moveFrame <= m.jumpCancel.frames[1]) this.offer('jump', now, 30);
    if (this.blocks >= 3) {
      this.blocks = 0;
      this.offer('blocked', now, 180);
    }
    const comboed = me.combo.hits >= 2 && (me.state === 'hitstun' || me.state === 'juggle' || me.state === 'stagger');
    if (comboed && me.burst >= RULES.burstMax) this.offer('burst', now, 90);
    if (threatHeavy && me.state !== 'dodge') this.offer('heavy', now, 70);
    if (me.stamina < sim.statsOf(me).maxStamina * 0.2 && me.state !== 'attack') this.offer('tired', now, 150);
    if (me.state === 'ground' || me.state === 'attack') {
      for (const e of sim.state.fighters) {
        if (e.team === me.team || e.state !== 'knockdown') continue;
        if (Math.hypot(e.pos.x - me.pos.x, e.pos.z - me.pos.z) < 2.3) this.offer('down', now, 60);
      }
    }
    if (this.current && now > this.current.until) this.current = null;
    return this.current?.tip ?? null;
  }

  private offer(id: string, now: number, duration: number): void {
    const rule = TIPS[id];
    const times = this.shown.get(id) ?? 0;
    if (this.current?.tip.id === id) {
      this.current.until = now + duration;
      return;
    }
    if (times >= rule.max || now - (this.last.get(id) ?? -1e9) < rule.cooldown) return;
    this.shown.set(id, times + 1);
    this.last.set(id, now);
    this.current = { tip: { id, text: rule.text }, until: now + duration };
  }
}

/** True while `f` is in the part of a strike where a chain press is on beat. */
export function onBeatWindow(sim: Simulation, f: FighterState): boolean {
  const m = sim.moveOf(f);
  if (f.state !== 'attack' || !m || !(f.moveHit || f.moveBlocked)) return false;
  return f.moveFrame <= lastActiveFrame(m) + RULES.beatWindow;
}
