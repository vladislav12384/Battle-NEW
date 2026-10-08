import './style.css';
import type { BotLevel, BotMode } from '../core/ai/bot';
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

function begin(): void {
  game.audio.unlock();
  void canvas.requestPointerLock();
}

document.getElementById('play')!.addEventListener('click', begin);
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
