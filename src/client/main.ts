import './style.css';
import { CARDS } from '../content';
import type { BotLevel, BotMode } from '../core/ai/bot';
import { cardHtml } from './cardView';
import { Game } from './game';

const LEVEL_KEY = 'battle.level';
const isLevel = (v: string | null): v is BotLevel => v === 'easy' || v === 'normal' || v === 'hard';
function savedLevel(): BotLevel | null {
  try {
    const v = localStorage.getItem(LEVEL_KEY);
    return isLevel(v) ? v : null;
  } catch {
    return null;
  }
}
function saveLevel(level: BotLevel): void {
  try {
    localStorage.setItem(LEVEL_KEY, level);
  } catch {
    // storage unavailable: the choice just isn't remembered
  }
}

const CARDS_KEY = 'battle.cards';
/** The remembered cards: ids separated by commas, 'none', or null when never chosen. */
function savedCards(): string | null {
  try {
    return localStorage.getItem(CARDS_KEY);
  } catch {
    return null;
  }
}
function saveCards(cards: string[]): void {
  try {
    localStorage.setItem(CARDS_KEY, cards.length ? cards.join(',') : 'none');
  } catch {
    // storage unavailable: the choice just isn't remembered
  }
}
/** ?card=<id>,<id> / ?card=none, else the remembered choice; every card is on by default. */
function initialCards(param: string | null): string[] {
  const pick = param ?? savedCards();
  if (pick === 'none') return [];
  const ids = (pick ?? '').split(',').filter((c) => CARDS[c]);
  return ids.length ? ids : Object.keys(CARDS);
}

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
const start = document.getElementById('start') as HTMLElement;

const demo = params.has('demo');
const game = new Game(canvas, ui, {
  demo,
  thirdPerson: params.has('third'),
  hitboxes: params.has('hitboxes'),
  enemies: params.has('enemies') ? Number(params.get('enemies')) : undefined,
  allies: params.has('allies') ? Number(params.get('allies')) : undefined,
  dummyMode: (params.get('dummy') as BotMode | null) ?? undefined,
  demoMode: (params.get('demo') as BotMode | null) || undefined,
  level: (isLevel(params.get('level')) ? (params.get('level') as BotLevel) : null) ?? savedLevel() ?? 'normal',
  cards: initialCards(params.get('card')),
});
(window as unknown as { game: Game }).game = game;

// Difficulty buttons on the start screen.
const levelButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-level]'));
function showLevel(level: BotLevel): void {
  for (const b of levelButtons) b.classList.toggle('on', b.dataset.level === level);
}
for (const b of levelButtons) {
  b.addEventListener('click', () => {
    const level = b.dataset.level as BotLevel;
    game.setLevel(level);
    saveLevel(level);
    showLevel(level);
  });
}
showLevel(game.settings.level);
game.onLevelChange = (level) => {
  saveLevel(level);
  showLevel(level);
};

// Hero cards on the start screen: click a card to take it / put it back, the button takes or drops them all.
const allCards = Object.keys(CARDS);
const startCard = document.getElementById('startcard') as HTMLElement;
const cardToggle = document.getElementById('cardtoggle') as HTMLButtonElement;
const cardSlot = document.getElementById('cardslot') as HTMLElement;
cardSlot.innerHTML = Object.values(CARDS)
  .map((c) => cardHtml(c))
  .join('');
function showStartCards(cards: string[]): void {
  startCard.classList.toggle('off', cards.length === 0);
  for (const el of Array.from(cardSlot.querySelectorAll<HTMLElement>('.tcard'))) el.classList.toggle('off', !cards.includes(el.dataset.card ?? ''));
  cardToggle.textContent =
    cards.length === allCards.length ? '✓ Все карты в бою — убрать' : cards.length ? `✓ В бою: ${cards.length} из ${allCards.length} — взять все` : 'Взять карты в бой';
}
cardToggle.addEventListener('click', () => game.equipCards(game.settings.cards.length === allCards.length ? [] : allCards, false));
for (const el of Array.from(cardSlot.querySelectorAll<HTMLElement>('.tcard'))) {
  el.addEventListener('click', () => game.toggleCard(el.dataset.card ?? '', false));
}
showStartCards(game.settings.cards);
game.onCardChange = (cards) => {
  saveCards(cards);
  showStartCards(cards);
};

function begin(): void {
  game.audio.unlock();
  void canvas.requestPointerLock();
}

document.getElementById('play')!.addEventListener('click', begin);
document.getElementById('learn')!.addEventListener('click', () => {
  game.startTutorial();
  begin();
});
canvas.addEventListener('click', () => {
  if (!game.input.locked && !demo) begin();
});
document.addEventListener('pointerlockchange', () => {
  const locked = game.input.locked;
  game.paused = !locked && !demo && !params.has('manual');
  start.classList.toggle('hidden', locked || demo || params.has('manual'));
});
const manual = params.has('manual'); // tooling: frames are stepped from outside (game.frame(dt))
if (demo || manual) {
  game.paused = false;
  start.classList.add('hidden');
}

let last = performance.now();
function loop(now: number): void {
  game.frame((now - last) / 1000);
  last = now;
  requestAnimationFrame(loop);
}
if (!manual) requestAnimationFrame(loop);
