import './style.css';
import type { BotMode } from '../core/ai/bot';
import { Game } from './game';

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
});
(window as unknown as { game: Game }).game = game;

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
  game.paused = !locked && !demo;
  start.classList.toggle('hidden', locked || demo);
});
if (demo) {
  game.paused = false;
  start.classList.add('hidden');
}

let last = performance.now();
function loop(now: number): void {
  game.frame((now - last) / 1000);
  last = now;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
