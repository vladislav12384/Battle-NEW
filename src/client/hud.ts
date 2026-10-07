/** DOM overlay: resource bars, combo counter, callouts, training panel, move list. */
import { RULES } from '../core/rules';
import type { Simulation } from '../core/simulation';
import type { FighterState } from '../core/state';
import type { CharacterDef } from '../core/types';
import { Button } from '../core/input';

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
  private guard: HTMLDivElement;
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
    const gBar = el('div', 'bar guard', this.root);
    this.guard = el('div', 'fill', gBar);
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
    this.guard.style.width = `${(f.guard / stats.maxGuard) * 100}%`;
    this.guard.parentElement!.classList.toggle('broken', f.guardBroken);
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

export interface TrainingInfo {
  dummyMode: string;
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
  private readonly vignette: HTMLDivElement;
  private readonly flashEl: HTMLDivElement;
  readonly moveList: HTMLDivElement;
  private comboTimer = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud', parent);
    this.vignette = el('div', 'vignette', this.root);
    this.flashEl = el('div', 'screenflash', this.root);
    this.player = new FighterPanel(this.root, 'left');
    this.target = new FighterPanel(this.root, 'right');
    el('div', 'crosshair', this.root);
    this.lockMarker = el('div', 'lock', this.root);
    this.combo = el('div', 'combo', this.root);
    this.comboHits = el('div', 'hits', this.combo);
    this.comboInfo = el('div', 'info', this.combo);
    this.callouts = el('div', 'callouts', this.root);
    this.training = el('div', 'training', this.root);
    this.moveList = el('div', 'movelist hidden', this.root);
  }

  callout(text: string, cls = ''): void {
    const c = el('div', `callout ${cls}`, this.callouts);
    c.textContent = text;
    setTimeout(() => c.remove(), 1100);
    while (this.callouts.children.length > 4) this.callouts.firstElementChild?.remove();
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
    this.combo.style.opacity = this.comboTimer > 0 ? String(Math.min(1, this.comboTimer * 2)) : '0';
    const adv =
      info.advantage === null
        ? '—'
        : `<b class="${info.advantage >= 0 ? 'plus' : 'minus'}">${info.advantage >= 0 ? '+' : ''}${info.advantage}</b> ${info.advantageKind === 'hit' ? 'при попадании' : 'в блоке'}`;
    this.training.innerHTML = `
      <div class="title">ПОЛИГОН</div>
      <div>Преимущество по кадрам: ${adv}</div>
      <div><kbd>1</kbd> хитбоксы: <b>${info.hitboxes ? 'вкл' : 'выкл'}</b></div>
      <div><kbd>2</kbd> манекен: <b>${info.dummyMode}</b></div>
      <div><kbd>3</kbd> замедление: <b>${info.slowmo ? '25%' : 'выкл'}</b></div>
      <div><kbd>4</kbd> сброс позиций</div>
      <div><kbd>5</kbd>/<kbd>6</kbd> + союзник / враг (${info.allies}/${info.enemies})</div>
      <div><kbd>7</kbd> бесконечный метр: <b>${info.infiniteMeter ? 'вкл' : 'выкл'}</b></div>
      <div><kbd>V</kbd> камера: <b>${info.thirdPerson ? '3-е лицо' : '1-е лицо'}</b> · <kbd>H</kbd> приёмы</div>`;
  }

  buildMoveList(c: CharacterDef): void {
    const btn: Record<number, string> = {
      [Button.LIGHT]: 'LMB',
      [Button.HEAVY]: 'RMB',
      [Button.SPECIAL]: 'E',
      [Button.GRAB]: 'Q',
      [Button.SUPER]: 'R',
    };
    const dir: Record<string, string> = { forward: 'W+', back: 'S+', left: 'A+', right: 'D+' };
    const btnRu: Record<string, string> = { LMB: 'ЛКМ', RMB: 'ПКМ' };
    const rows: string[] = [];
    for (const cmd of c.commands) {
      const m = c.moves[cmd.move];
      const key = btn[cmd.button] ?? '?';
      const input = `${cmd.running ? 'Бег+' : ''}${cmd.dir ? dir[cmd.dir] : ''}${btnRu[key] ?? key}`;
      const where = cmd.air === true ? 'в воздухе' : cmd.air === false ? 'на земле' : '';
      const frames = `${m.startup}/${m.active}/${m.recovery}`;
      rows.push(`<tr><td><kbd>${input}</kbd></td><td>${m.name}</td><td>${where}</td><td>${frames}</td><td>${m.meterCost ? `${m.meterCost} метра` : ''}</td></tr>`);
    }
    this.moveList.innerHTML = `
      <h2>${c.name} — список приёмов</h2>
      <table><tr><th>Ввод</th><th>Приём</th><th></th><th>Кадры: старт/актив/восст.</th><th></th></tr>${rows.join('')}</table>
      <h3>Строки и комбо</h3>
      <ul>
        <li><kbd>ЛКМ ЛКМ ЛКМ ЛКМ</kbd> — джеб, кросс, хук, круговой (впечатывает в стену)</li>
        <li><kbd>ЛКМ ЛКМ ПКМ</kbd> — лаунчер → <kbd>Space</kbd> при попадании = прыжок за противником → в воздухе <kbd>ЛКМ ЛКМ ПКМ</kbd> (добивание вниз, отскок от земли)</li>
        <li><kbd>ЛКМ ЛКМ ЛКМ ПКМ</kbd> — удар-молот (отскок от земли) → <kbd>ПКМ</kbd> при попадании = снова подброс</li>
        <li><kbd>ПКМ</kbd> держать — заряд; полный заряд не блокируется. <kbd>ПКМ ПКМ</kbd> — бэкфист (отскок от стены)</li>
        <li>Любой обычный удар при попадании/блоке → <kbd>E</kbd> спецприём / <kbd>R</kbd> супер (отмена)</li>
        <li><kbd>Shift</kbd> во время атаки за 50 метра = Ki Cancel (выход из атаки или продление комбо)</li>
      </ul>
      <h3>Защита и выход из комбо</h3>
      <ul>
        <li><kbd>F</kbd> держать = блок спереди (урон «по касательной» + урон по стойке). Нажать <kbd>F</kbd> прямо перед ударом = <b>парирование</b> (спам блокируется)</li>
        <li><kbd>Shift</kbd> = уклонение с неуязвимостью (впритык = идеальное уклонение → контратака). Держать — бег</li>
        <li><kbd>X</kbd> в комбо при полной шкале = <b>Burst</b>, разрыв комбо</li>
        <li>В воздухе: <kbd>Space</kbd>/<kbd>Shift</kbd> после хитстана = воздушный тех; <kbd>Shift</kbd> перед приземлением = тех на земле; <kbd>Shift</kbd> лёжа = перекат</li>
        <li>Схватили: быстро <kbd>Q</kbd> = разрыв броска</li>
      </ul>
      <p class="hint">Нажми <kbd>H</kbd>, чтобы закрыть</p>`;
  }

  toggleMoveList(): void {
    this.moveList.classList.toggle('hidden');
  }
}
