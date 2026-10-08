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

const CARD_KEY = 'battle.card';
/** The remembered card: an id, 'none', or null when never chosen. */
function savedCard(): string | null {
  try {
    return localStorage.getItem(CARD_KEY);
  } catch {
    return null;
  }
}
function saveCard(card: string | null): void {
  try {
    localStorage.setItem(CARD_KEY, card ?? 'none');
  } catch {
    // storage unavailable: the choice just isn't remembered
  }
}
/** ?card=<id> / ?card=none, else the remembered choice; the first card is on by default. */
function initialCard(param: string | null): string | null {
  const pick = param ?? savedCard();
  if (pick === 'none') return null;
  if (pick && CARDS[pick]) return pick;
  return Object.keys(CARDS)[0] ?? null;
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
  card: initialCard(params.get('card')),
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

// The hero card on the start screen: click the card or the button to take it / put it back.
const firstCard = Object.values(CARDS)[0];
const startCard = document.getElementById('startcard') as HTMLElement;
const cardToggle = document.getElementById('cardtoggle') as HTMLButtonElement;
(document.getElementById('cardslot') as HTMLElement).innerHTML = firstCard ? cardHtml(firstCard) : '';
function showStartCard(card: string | null): void {
  startCard.classList.toggle('off', !card);
  cardToggle.textContent = card ? '✓ Карта в бою — убрать' : 'Взять карту в бой';
}
function toggleCard(): void {
  game.equipCard(game.settings.card ? null : (firstCard?.id ?? null), false);
}
cardToggle.addEventListener('click', toggleCard);
startCard.querySelector('.tcard')?.addEventListener('click', toggleCard);
showStartCard(game.settings.card);
game.onCardChange = (card) => {
  saveCard(card);
  showStartCard(card);
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
