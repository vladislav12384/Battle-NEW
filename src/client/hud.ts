/** DOM overlay: resource bars, combo counter, callouts, training panel, move list. */
import { RULES } from '../core/rules';
import type { Simulation } from '../core/simulation';
import type { FighterState } from '../core/state';
import type { CharacterDef } from '../core/types';
import type { CardDef } from '../content';
import { cardBadgeHtml, cardHtml } from './cardView';
import { MOVE_NAMES } from './tutorial';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', parent?: HTMLElement): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
};

class FighterPanel {
  readonly root: HTMLDivElement;
  private name: HTMLDivElement;
  private hp: HTMLDivElement;
  private hpLag: HTMLDivElement;
  private stamina: HTMLDivElement;
  private meter: HTMLDivElement[] = [];
  private burst: HTMLDivElement;
  private state: HTMLDivElement;
  private lag = 1;

  constructor(parent: HTMLElement, cls: string) {
    this.root = el('div', `panel ${cls}`, parent);
    this.name = el('div', 'name', this.root);
    const hpBar = el('div', 'bar hp', this.root);
    this.hpLag = el('div', 'fill lag', hpBar);
    this.hp = el('div', 'fill', hpBar);
    const sBar = el('div', 'bar stamina', this.root);
    this.stamina = el('div', 'fill', sBar);
    const row = el('div', 'row', this.root);
    const meters = el('div', 'meters', row);
    for (let i = 0; i < 3; i++) {
      const m = el('div', 'bar meter', meters);
      this.meter.push(el('div', 'fill', m));
    }
    const bBar = el('div', 'bar burst', row);
    this.burst = el('div', 'fill', bBar);
    this.state = el('div', 'state', this.root);
  }

  update(f: FighterState | undefined, sim: Simulation, dt: number): void {
    this.root.style.visibility = f ? 'visible' : 'hidden';
    if (!f) return;
    const stats = sim.statsOf(f);
    const hp = f.health / stats.maxHealth;
    this.lag = Math.max(hp, this.lag - dt * 0.5);
    if (this.lag < hp) this.lag = hp;
    this.name.textContent = `${f.name}${f.team === 0 ? '' : ' ▸ enemy'}`;
    this.hp.style.width = `${hp * 100}%`;
    this.hpLag.style.width = `${this.lag * 100}%`;
    this.stamina.style.width = `${(f.stamina / stats.maxStamina) * 100}%`;
    this.stamina.parentElement!.classList.toggle('exhausted', f.exhausted || f.guardBroken);
    this.stamina.parentElement!.classList.toggle('low', f.stamina < stats.maxStamina * 0.3);
    for (let i = 0; i < 3; i++) {
      const v = Math.max(0, Math.min(1, (f.meter - i * 100) / 100));
      this.meter[i].style.width = `${v * 100}%`;
      this.meter[i].parentElement!.classList.toggle('full', v >= 1);
    }
    this.burst.style.width = `${(f.burst / RULES.burstMax) * 100}%`;
    this.burst.parentElement!.classList.toggle('ready', f.burst >= RULES.burstMax);
    const m = f.move ? ` · ${sim.moveOf(f)?.name ?? f.move} f${f.moveFrame}` : '';
    this.state.textContent = `${f.state}${m}${f.stun > 0 ? ` · stun ${f.stun}` : ''}`;
  }
}

/** An incoming strike aimed at the player, drawn around the crosshair. */
export interface ThreatMark {
  /** Side of the screen the blow comes from (center = straight at you). */
  from: 'left' | 'right' | 'top' | 'bottom' | 'center';
  kind: 'light' | 'heavy' | 'unblockable';
  /** 0 at the start of the wind-up, 1 at impact. */
  progress: number;
  /** Inside the perfect-dodge moment right now. */
  now: boolean;
  /** Direction (screen radians) to an attacker outside the view, else null. */
  edge: number | null;
}

const THREAT_COLOR: Record<ThreatMark['kind'], [number, number, number]> = {
  light: [226, 243, 255],
  heavy: [255, 154, 60],
  unblockable: [255, 59, 59],
};

export interface TrainingInfo {
  dummyMode: string;
  level: string;
  hints: boolean;
  hitboxes: boolean;
  slowmo: boolean;
  infiniteMeter: boolean;
  thirdPerson: boolean;
  allies: number;
  enemies: number;
  advantage: number | null;
  advantageKind: string;
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly player: FighterPanel;
  private readonly target: FighterPanel;
  private readonly combo: HTMLDivElement;
  private readonly comboHits: HTMLDivElement;
  private readonly comboInfo: HTMLDivElement;
  private readonly callouts: HTMLDivElement;
  private readonly training: HTMLDivElement;
  private readonly lockMarker: HTMLDivElement;
  private readonly strikeEl: HTMLDivElement;
  private strikeTimer = 0;
  private readonly vignette: HTMLDivElement;
  private readonly flashEl: HTMLDivElement;
  private readonly tiredEl: HTMLDivElement;
  private readonly witchEl: HTMLDivElement;
  private readonly visorEl: HTMLDivElement;
  private readonly badgeEl: HTMLDivElement;
  private readonly revealEl: HTMLDivElement;
  private revealTimer = 0;
  private readonly lines: HTMLCanvasElement;
  private readonly numbers: HTMLDivElement;
  private impacts: { x: number; y: number; t: number; max: number; power: number; color: string; seed: number }[] = [];
  private threatMarks: ThreatMark[] = [];
  private beat = 0;
  private readonly rhythmEl: HTMLDivElement;
  private readonly hintEl: HTMLDivElement;
  private hintKey = '';
  private readonly tipEl: HTMLDivElement;
  private tipKey = '';
  private readonly lessonEl: HTMLDivElement;
  private lessonKey = '';
  private floaters: { el: HTMLDivElement; t: number; world: { x: number; y: number; z: number } }[] = [];
  readonly moveList: HTMLDivElement;
  private comboTimer = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud', parent);
    this.lines = el('canvas', 'impactlines', this.root);
    this.vignette = el('div', 'vignette', this.root);
    this.tiredEl = el('div', 'tired', this.root);
    this.witchEl = el('div', 'witch', this.root);
    this.visorEl = el('div', 'visor', this.root);
    this.flashEl = el('div', 'screenflash', this.root);
    this.numbers = el('div', 'numbers', this.root);
    this.player = new FighterPanel(this.root, 'left');
    this.target = new FighterPanel(this.root, 'right');
    el('div', 'crosshair', this.root);
    this.lockMarker = el('div', 'lock', this.root);
    this.strikeEl = el('div', 'strike', this.root);
    this.rhythmEl = el('div', 'rhythm', this.root);
    this.hintEl = el('div', 'nexthint', this.root);
    this.tipEl = el('div', 'tip', this.root);
    this.lessonEl = el('div', 'lesson hidden', this.root);
    this.combo = el('div', 'combo', this.root);
    this.comboHits = el('div', 'hits', this.combo);
    this.comboInfo = el('div', 'info', this.combo);
    this.callouts = el('div', 'callouts', this.root);
    this.training = el('div', 'training', this.root);
    this.badgeEl = el('div', 'cardbadge', this.root);
    this.revealEl = el('div', 'cardreveal', this.root);
    this.moveList = el('div', 'movelist hidden', this.root);
  }

  /** Red glow of Cyclops' visor at the edges of the view (0 = off). */
  visor(level: number): void {
    this.visorEl.style.opacity = level > 0.01 ? String(Math.min(1, level)) : '0';
  }

  /** The equipped card in the corner (null hides it). */
  cardBadge(card: CardDef | null): void {
    this.badgeEl.classList.toggle('on', !!card);
    this.badgeEl.innerHTML = card ? cardBadgeHtml(card) : '';
  }

  /** The card flips open in the middle of the screen, then flies into its corner. */
  cardReveal(card: CardDef): void {
    clearTimeout(this.revealTimer);
    this.revealEl.innerHTML = `<div class="burst"></div>${cardHtml(card)}`;
    this.revealEl.classList.remove('on');
    void this.revealEl.offsetWidth;
    this.revealEl.classList.add('on');
    this.revealTimer = window.setTimeout(() => {
      this.revealEl.classList.remove('on');
      this.revealEl.innerHTML = '';
    }, 3400);
  }

  callout(text: string, cls = ''): void {
    const c = el('div', `callout ${cls}`, this.callouts);
    c.textContent = text;
    setTimeout(() => c.remove(), 1100);
    while (this.callouts.children.length > 4) this.callouts.firstElementChild?.remove();
  }

  /**
   * Anime-style impact lines radiating from a screen point (heavy hits,
   * counters, finishers): the hit is "framed" for a split second.
   */
  impact(x: number, y: number, power: number, color = 'rgba(255,255,255,0.9)'): void {
    const max = 0.12 + power * 0.1;
    this.impacts.push({ x, y, t: max, max, power, color, seed: Math.random() * 1000 });
  }

  /** Floating damage number anchored to a world point (projected every frame by the game). */
  damageNumber(world: { x: number; y: number; z: number }, amount: number, kind: 'dealt' | 'taken' | 'counter' | 'chip'): void {
    const d = el('div', `dmg ${kind}`, this.numbers);
    d.textContent = String(amount);
    this.floaters.push({ el: d, t: 0, world: { ...world } });
    if (this.floaters.length > 24) this.floaters.shift()?.el.remove();
  }

  /** Blue "slowed time" tint while the enemy you perfect-dodged is exposed (0..1). */
  witch(level: number): void {
    this.witchEl.style.opacity = String(level);
  }

  /** What each attack button gives next in the current string (null hides it). */
  nextHint(light: string | null, heavy: string | null, jump: boolean, onBeat: boolean): void {
    const key = light || heavy || jump ? `${light}|${heavy}|${jump}|${onBeat}` : '';
    if (key === this.hintKey) return;
    this.hintKey = key;
    if (!key) {
      this.hintEl.classList.remove('on');
      return;
    }
    const parts: string[] = [];
    if (jump) parts.push('<span class="jump"><kbd>Space</kbd> прыжок следом</span>');
    if (light) parts.push(`<span><kbd>ЛКМ</kbd> ${light}</span>`);
    if (heavy) parts.push(`<span><kbd>ПКМ</kbd> ${heavy}</span>`);
    this.hintEl.innerHTML = parts.join('');
    this.hintEl.classList.add('on');
    this.hintEl.classList.toggle('beat', onBeat);
  }

  /** Contextual coach tip at the bottom of the screen (null hides it). */
  tip(text: string | null): void {
    const key = text ?? '';
    if (key === this.tipKey) return;
    this.tipKey = key;
    if (!text) {
      this.tipEl.classList.remove('on');
      return;
    }
    this.tipEl.innerHTML = text;
    this.tipEl.classList.remove('on');
    void this.tipEl.offsetWidth;
    this.tipEl.classList.add('on');
  }

  /** Tutorial lesson card (null hides it). */
  lesson(info: { index: number; count: number; title: string; text: string; progress: number; goal: number; done: boolean } | null): void {
    this.root.classList.toggle('tutorial', !!info);
    if (!info) {
      this.lessonKey = '';
      this.lessonEl.classList.add('hidden');
      return;
    }
    const key = `${info.index}|${info.progress}|${info.done}`;
    if (key === this.lessonKey) return;
    this.lessonKey = key;
    const dots = Array.from({ length: info.goal }, (_, i) => `<i class="${i < info.progress ? 'got' : ''}"></i>`).join('');
    this.lessonEl.className = `lesson${info.done ? ' done' : ''}`;
    this.lessonEl.innerHTML = `
      <div class="head"><span>ОБУЧЕНИЕ ${info.index + 1}/${info.count}</span><b>${info.title}</b><span class="dots">${dots}</span></div>
      <div class="body">${info.done ? '<b class="ok">Отлично!</b> Дальше…' : info.text}</div>
      <div class="foot"><kbd>Enter</kbd> пропустить урок · <kbd>T</kbd> выйти из обучения</div>`;
  }

  /** Incoming strikes to draw this frame. */
  threats(list: ThreatMark[]): void {
    this.threatMarks = list;
  }

  /** "Now!": your blow landed, the next press chains on beat. */
  beatCue(): void {
    this.beat = 1;
  }

  /** Rhythm level of the last chained strike (0 hides it). */
  rhythm(level: number): void {
    if (level <= 0) {
      this.rhythmEl.classList.remove('on');
      return;
    }
    this.rhythmEl.innerHTML = `РИТМ ${'●'.repeat(level)}${'○'.repeat(Math.max(0, RULES.rhythm.max - level))}`;
    this.rhythmEl.classList.remove('on');
    void this.rhythmEl.offsetWidth;
    this.rhythmEl.classList.add('on');
  }

  /** Pressed during the wind-up: the chain is locked. */
  mash(): void {
    this.strikeEl.classList.remove('pop');
    this.strikeEl.classList.add('miss');
    this.strikeEl.innerHTML = '✕ РАНО — жми, когда удар попал';
    this.strikeTimer = 0.9;
    this.rhythm(0);
  }

  /** A short line under the crosshair (dodge results, poise...). */
  note(text: string, cls = ''): void {
    this.strikeEl.className = `strike ${cls}`;
    this.strikeEl.innerHTML = text;
    this.strikeTimer = 0.8;
    void this.strikeEl.offsetWidth;
    this.strikeEl.classList.add('pop');
  }

  private drawThreats(g: CanvasRenderingContext2D, w: number, h: number, dt: number): void {
    const cx = w / 2;
    const cy = h / 2;
    // Beat cue: a ring bursting out of the crosshair when your blow lands.
    if (this.beat > 0) {
      this.beat = Math.max(0, this.beat - dt * 4);
      g.strokeStyle = `rgba(255,255,255,${this.beat * 0.9})`;
      g.lineWidth = 2 + this.beat * 2;
      g.beginPath();
      g.arc(cx, cy, 14 + (1 - this.beat) * 26, 0, Math.PI * 2);
      g.stroke();
    }
    const angle = { right: 0, bottom: Math.PI / 2, left: Math.PI, top: -Math.PI / 2 };
    for (const t of this.threatMarks) {
      const [r, gr, b] = t.now ? [255, 255, 255] : THREAT_COLOR[t.kind];
      const alpha = 0.35 + t.progress * 0.65;
      const color = `rgba(${r},${gr},${b},${alpha})`;
      g.save();
      g.shadowColor = `rgba(${THREAT_COLOR[t.kind].join(',')},0.9)`;
      g.shadowBlur = t.now ? 18 : 6;
      g.strokeStyle = color;
      g.fillStyle = color;
      if (t.edge !== null) {
        // Off-screen attacker: a chevron on the screen edge pointing at it.
        const ex = cx + Math.cos(t.edge) * Math.min(w, h) * 0.42;
        const ey = cy + Math.sin(t.edge) * Math.min(w, h) * 0.42;
        const s = 14 + t.progress * 10;
        g.beginPath();
        g.moveTo(ex + Math.cos(t.edge) * s, ey + Math.sin(t.edge) * s);
        g.lineTo(ex + Math.cos(t.edge + 2.4) * s, ey + Math.sin(t.edge + 2.4) * s);
        g.lineTo(ex + Math.cos(t.edge - 2.4) * s, ey + Math.sin(t.edge - 2.4) * s);
        g.closePath();
        g.fill();
      }
      const radius = 50 + (1 - t.progress) * 46;
      g.lineWidth = (t.kind === 'light' ? 2.5 : 4) + t.progress * (t.kind === 'light' ? 3 : 6);
      g.beginPath();
      if (t.from === 'center') g.arc(cx, cy, 16 + (1 - t.progress) * 70, 0, Math.PI * 2);
      else g.arc(cx, cy, radius, angle[t.from] - 0.5, angle[t.from] + 0.5);
      g.stroke();
      if (t.from === 'left' || t.from === 'right') {
        // Dash hint: away from the side the swing comes from.
        const a = angle[t.from === 'left' ? 'right' : 'left'];
        const hx = cx + Math.cos(a) * (radius + 6);
        const hy = cy;
        const d = Math.cos(a);
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(hx, hy - 9);
        g.lineTo(hx + d * 10, hy);
        g.lineTo(hx, hy + 9);
        g.stroke();
      }
      g.restore();
    }
  }

  /** The strike label turns into a "miss" marker. */
  strikeMiss(): void {
    this.strikeEl.classList.add('miss');
    this.strikeTimer = 0.7;
  }

  /** Positions floating numbers and draws impact lines; `project` maps world -> screen (or null if behind). */
  updateEffects(dt: number, project: (p: { x: number; y: number; z: number }) => { x: number; y: number } | null, exhausted: boolean): void {
    this.tiredEl.style.opacity = exhausted ? String(0.55 + Math.sin(performance.now() / 260) * 0.15) : '0';
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.t += dt;
      const p = project({ x: f.world.x, y: f.world.y + f.t * 0.9, z: f.world.z });
      if (!p || f.t > 0.9) {
        if (f.t > 0.9) {
          f.el.remove();
          this.floaters.splice(i, 1);
        } else f.el.style.opacity = '0';
        continue;
      }
      f.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%) scale(${1 + Math.max(0, 0.15 - f.t) * 4})`;
      f.el.style.opacity = String(Math.min(1, (0.9 - f.t) * 3));
    }
    const c = this.lines;
    if (c.width !== window.innerWidth || c.height !== window.innerHeight) {
      c.width = window.innerWidth;
      c.height = window.innerHeight;
    }
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    this.drawThreats(g, c.width, c.height, dt);
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const im = this.impacts[i];
      im.t -= dt;
      if (im.t <= 0) {
        this.impacts.splice(i, 1);
        continue;
      }
      const k = im.t / im.max;
      const n = 26 + Math.round(im.power * 18);
      const inner = 40 + (1 - k) * 60;
      const outer = Math.max(c.width, c.height) * 0.75;
      g.strokeStyle = im.color;
      g.globalAlpha = k * 0.85;
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2 + Math.sin(im.seed + j * 12.9898) * 0.08;
        const r0 = inner + Math.abs(Math.sin(im.seed * 3 + j * 78.233)) * 80;
        g.lineWidth = 1 + Math.abs(Math.sin(im.seed + j)) * 3 * im.power;
        g.beginPath();
        g.moveTo(im.x + Math.cos(a) * r0, im.y + Math.sin(a) * r0);
        g.lineTo(im.x + Math.cos(a) * outer, im.y + Math.sin(a) * outer);
        g.stroke();
      }
      g.globalAlpha = 1;
    }
  }

  hurt(amount: number): void {
    this.vignette.style.opacity = String(Math.min(0.9, 0.3 + amount / 120));
    this.vignette.style.transition = 'none';
    requestAnimationFrame(() => {
      this.vignette.style.transition = 'opacity 0.5s ease-out';
      this.vignette.style.opacity = '0';
    });
  }

  flash(color: string, strength = 0.35): void {
    this.flashEl.style.background = color;
    this.flashEl.style.transition = 'none';
    this.flashEl.style.opacity = String(strength);
    requestAnimationFrame(() => {
      this.flashEl.style.transition = 'opacity 0.25s ease-out';
      this.flashEl.style.opacity = '0';
    });
  }

  showCombo(hits: number, damage: number, trueCombo: boolean): void {
    if (hits < 2) return;
    this.comboTimer = 1.6;
    this.comboHits.textContent = `${hits} HITS`;
    this.comboInfo.textContent = `${damage} dmg · ${trueCombo ? 'TRUE COMBO' : 'ESCAPABLE!'}`;
    this.comboInfo.className = `info ${trueCombo ? 'true' : 'gap'}`;
    this.combo.classList.remove('pop');
    void this.combo.offsetWidth;
    this.combo.classList.add('pop');
  }

  /** Shows which strike came out and its place in the string (teaches the strings). */
  strike(name: string, position: number): void {
    this.strikeEl.className = 'strike';
    const pips = position > 1 ? `<span class="arrow">${'●'.repeat(Math.min(position, 6))}</span>` : '';
    this.strikeEl.innerHTML = `${pips}${name}`;
    this.strikeTimer = 0.9;
    this.strikeEl.classList.remove('pop');
    void this.strikeEl.offsetWidth;
    this.strikeEl.classList.add('pop');
  }

  setLockMarker(x: number | null, y = 0): void {
    if (x === null) {
      this.lockMarker.style.display = 'none';
      return;
    }
    this.lockMarker.style.display = 'block';
    this.lockMarker.style.left = `${x}px`;
    this.lockMarker.style.top = `${y}px`;
  }

  update(sim: Simulation, player: FighterState | undefined, target: FighterState | undefined, info: TrainingInfo, dt: number): void {
    this.player.update(player, sim, dt);
    this.target.update(target, sim, dt);
    this.comboTimer -= dt;
    this.strikeTimer -= dt;
    this.strikeEl.style.opacity = this.strikeTimer > 0 ? String(Math.min(1, this.strikeTimer * 3)) : '0';
    this.combo.style.opacity = this.comboTimer > 0 ? String(Math.min(1, this.comboTimer * 2)) : '0';
    const adv =
      info.advantage === null
        ? '—'
        : `<b class="${info.advantage >= 0 ? 'plus' : 'minus'}">${info.advantage >= 0 ? '+' : ''}${info.advantage}</b> ${info.advantageKind === 'hit' ? 'при попадании' : 'в блоке'}`;
    this.training.innerHTML = `
      <div class="title">ПОЛИГОН</div>
      <div>Преимущество по кадрам: ${adv}</div>
      <div><kbd>1</kbd> хитбоксы: <b>${info.hitboxes ? 'вкл' : 'выкл'}</b></div>
      <div><kbd>T</kbd> обучение · <kbd>9</kbd> подсказки: <b>${info.hints ? 'вкл' : 'выкл'}</b></div>
      <div><kbd>8</kbd> сложность: <b>${info.level}</b></div>
      <div><kbd>2</kbd> манекен: <b>${info.dummyMode}</b></div>
      <div><kbd>3</kbd> замедление: <b>${info.slowmo ? '25%' : 'выкл'}</b></div>
      <div><kbd>4</kbd> сброс позиций</div>
      <div><kbd>5</kbd>/<kbd>6</kbd> + союзник / враг (${info.allies}/${info.enemies})</div>
      <div><kbd>7</kbd> бесконечный метр: <b>${info.infiniteMeter ? 'вкл' : 'выкл'}</b></div>
      <div><kbd>V</kbd> камера: <b>${info.thirdPerson ? '3-е лицо' : '1-е лицо'}</b> · <kbd>H</kbd> приёмы</div>`;
  }

  buildMoveList(c: CharacterDef, card: CardDef | null = null): void {
    const name = (id: string): string => MOVE_NAMES[id] ?? c.moves[id]?.name ?? id;
    const cardPart = card
      ? `<div class="mlcard" style="--c:#${card.color.toString(16).padStart(6, '0')}">
          <h3>Карта: ${card.name} <small>${card.hero}</small></h3>
          <ul>${card.lines.map((l) => `<li>${l}</li>`).join('')}</ul>
          <p class="hint"><kbd>C</kbd> — снять карту</p>
        </div>`
      : '<p class="hint"><kbd>C</kbd> — взять карту героя (Циклоп: оптический выстрел)</p>';
    const special = card
      ? `<kbd>E</kbd> — ${name('optic_blast').toLowerCase()} (карта), <kbd>W</kbd>+<kbd>E</kbd> — таран плечом, <kbd>S</kbd>+<kbd>E</kbd> — восходящий дракон`
      : '<kbd>E</kbd> — волна ки, <kbd>W</kbd>+<kbd>E</kbd> — таран плечом, <kbd>S</kbd>+<kbd>E</kbd> — восходящий дракон (неуязвимый выход из-под атаки)';
    this.moveList.innerHTML = `
      <h2>${c.name} — как драться</h2>
      ${cardPart}
      <p>Две кнопки атаки. Какой удар выйдет, зависит от того, <b>сколько ударов уже попало подряд</b>.
      Жми следующий удар в момент попадания (кольцо у прицела) — это ритм. Закликивание ломает связку.</p>
      <h3>ЛКМ — руки, серия в ритм</h3>
      <p class="chain"><kbd>1</kbd> ${name('jab')} → <kbd>2</kbd> ${name('cross')} → <kbd>3</kbd> ${name('hook_l')} →
      <kbd>4</kbd> ${name('uppercut')} (подбрасывает) → <kbd>5</kbd> ${name('hook_r')} → дальше по корпусу</p>
      <h3>ПКМ — мощный удар-добивание</h3>
      <table>
        <tr><th>Когда</th><th>Удар</th></tr>
        <tr><td>сразу</td><td>${name('haymaker')} — держи ПКМ, чтобы зарядить (полный заряд не блокируется)</td></tr>
        <tr><td>после 1 удара</td><td>${name('roundhouse_r')}</td></tr>
        <tr><td>после 2 ударов</td><td>${name('spin_backfist')} — отбрасывает в стену</td></tr>
        <tr><td>после 3 ударов</td><td>${name('rising_uppercut')} — <kbd>Space</kbd> сразу после него = прыжок за врагом и серия в воздухе</td></tr>
        <tr><td>после 4 ударов</td><td>${name('heel_axe')} — вбивает в землю</td></tr>
      </table>
      <h3>Ситуации</h3>
      <ul>
        <li><kbd>S</kbd> + <kbd>ЛКМ</kbd> — толчок ногой (отодвинуть врага), <kbd>S</kbd> + <kbd>ПКМ</kbd> — подсечка</li>
        <li>Бег (держи <kbd>Shift</kbd>) + <kbd>ЛКМ</kbd> — летящее колено, + <kbd>ПКМ</kbd> — удар с разбега</li>
        <li>Враг лежит перед тобой — любая атака добивает</li>
        <li><kbd>ЛКМ</kbd> + <kbd>ПКМ</kbd> вместе — бросок (пробивает блок)</li>
        <li>${special}. Полная шкала ки — <kbd>E</kbd> выпускает супер</li>
        <li>В воздухе: <kbd>ЛКМ</kbd> — серия, <kbd>ПКМ</kbd> — удар вниз, <kbd>S</kbd>+<kbd>ПКМ</kbd> — удар ногой в пике</li>
      </ul>
      <h3>Защита</h3>
      <ul>
        <li><kbd>F</kbd> держать — блок; нажать в момент удара — <b>парирование</b></li>
        <li><kbd>Shift</kbd> + <kbd>A</kbd>/<kbd>D</kbd> — рывок вбок. Удар летит слева → рви вправо. Впритык — идеальный уклон и контратака</li>
        <li>Тебя бьют серией и шкала взрыва полна — <kbd>F</kbd>: <b>взрыв</b> отбрасывает врага</li>
        <li>Падаешь — <kbd>Shift</kbd> перед землёй: встаёшь перекатом. Схватили — жми любую атаку</li>
      </ul>
      <p class="hint">Нажми <kbd>H</kbd>, чтобы закрыть</p>`;
  }

  toggleMoveList(): void {
    this.moveList.classList.toggle('hidden');
  }
}
