import { CHARACTERS } from '../src/content';
import { chainWindowStart } from '../src/core/fighter';
import { Button, type InputFrame, type Swipe, swipeCode } from '../src/core/input';
import { vec3, yawTo } from '../src/core/math/vec3';
import { type SimOptions, Simulation } from '../src/core/simulation';
import type { FighterState, GameEvent, GameEventType } from '../src/core/state';

export const B = Button;

export function newSim(opts: SimOptions = {}): Simulation {
  return new Simulation(CHARACTERS, { seed: 7, ...opts });
}

/** Two fighters facing each other along Z. `a` is at the origin facing -Z. */
export function duel(dist = 1.5, aChar = 'striker', bChar = 'striker', opts: SimOptions = {}) {
  const sim = newSim(opts);
  const a = sim.addFighter({ charId: aChar, team: 0, pos: vec3(0, 0, 0), yaw: 0, name: 'A' });
  const b = sim.addFighter({ charId: bChar, team: 1, pos: vec3(0, 0, -dist), yaw: Math.PI, name: 'B' });
  return { sim, a, b, h: new Harness(sim) };
}

export interface Pad {
  buttons?: number;
  moveX?: number;
  moveY?: number;
  pitch?: number;
  yaw?: number;
  swipe?: Swipe;
}

export type PadSource = Pad | ((h: Harness) => Pad);

/** An input that looks at the nearest enemy, like a player aiming the camera at them. */
export function aimInput(sim: Simulation, f: FighterState, pad: Pad = {}): InputFrame {
  let enemy: FighterState | undefined;
  let best = Infinity;
  for (const e of sim.state.fighters) {
    if (e.team === f.team || e.state === 'ko') continue;
    const d = Math.hypot(e.pos.x - f.pos.x, e.pos.z - f.pos.z);
    if (d < best) {
      best = d;
      enemy = e;
    }
  }
  return {
    moveX: pad.moveX ?? 0,
    moveY: pad.moveY ?? 0,
    yaw: pad.yaw ?? (enemy ? yawTo(f.pos, enemy.pos) : f.yaw),
    pitch: pad.pitch ?? 0,
    buttons: pad.buttons ?? 0,
    swipe: swipeCode(pad.swipe ?? 'none'),
  };
}

export class Harness {
  events: GameEvent[] = [];
  constructor(readonly sim: Simulation) {}

  step(pads: Record<number, PadSource> = {}): GameEvent[] {
    const inputs: Record<number, InputFrame> = {};
    for (const f of this.sim.state.fighters) {
      const src = pads[f.id];
      const pad = typeof src === 'function' ? src(this) : (src ?? {});
      inputs[f.id] = aimInput(this.sim, f, pad);
    }
    const ev = this.sim.step(inputs);
    this.events.push(...ev);
    return ev;
  }

  run(n: number, pads: Record<number, PadSource> = {}): void {
    for (let i = 0; i < n; i++) this.step(pads);
  }

  /** Steps until `pred` is true (or throws after `max` ticks). Returns ticks taken. */
  until(pred: () => boolean, pads: Record<number, PadSource> = {}, max = 600): number {
    for (let i = 0; i < max; i++) {
      if (pred()) return i;
      this.step(pads);
    }
    throw new Error('condition not reached');
  }

  of<T extends GameEventType>(type: T): Extract<GameEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<GameEvent, { type: T }>[];
  }

  fighter(id: number): FighterState {
    const f = this.sim.fighter(id);
    if (!f) throw new Error(`no fighter ${id}`);
    return f;
  }
}

export interface Step {
  button: number;
  dir?: 'forward' | 'back';
  swipe?: Swipe;
}

/**
 * Performs a button sequence like a skilled player: each press lands a few
 * frames before the relevant cancel window opens and only after the previous
 * press was consumed.
 */
export function playSequence(
  h: Harness,
  attackerId: number,
  steps: Step[],
  others: Record<number, PadSource> = {},
  tail = 120,
): void {
  let i = 0;
  let prev = 0;
  let awaitingKey: string | null = null;
  let after = 0;
  // Counts actions started by the attacker: a press is "consumed" once this changes.
  const keyOf = (f: FighterState): string =>
    String(h.events.filter((e) => (e.type === 'attack' || e.type === 'jump' || e.type === 'dodge') && e.fighter === f.id).length);
  for (let t = 0; t < 600; t++) {
    const f = h.fighter(attackerId);
    let buttons = 0;
    let moveY = 0;
    let swipe: Swipe = 'none';
    if (awaitingKey !== null && keyOf(f) !== awaitingKey) awaitingKey = null;
    const step = steps[i];
    if (step) {
      moveY = step.dir === 'forward' ? 1 : step.dir === 'back' ? -1 : 0;
      let ready = false;
      const m = h.sim.moveOf(f);
      if (awaitingKey === null) {
        if (f.state === 'attack' && m) {
          ready = f.moveFrame >= chainWindowStart(m, step.button, f.moveHit || f.moveBlocked) - 3;
        } else {
          ready = f.state === 'ground' || f.state === 'air';
        }
      }
      if (ready && !(prev & step.button)) {
        buttons = step.button;
        swipe = step.swipe ?? 'none';
        awaitingKey = keyOf(f);
        i++;
      }
    } else if (after++ > tail) {
      return;
    }
    prev = buttons;
    h.step({ ...others, [attackerId]: { buttons, moveY, swipe } });
  }
}

/** A victim that raises its guard the moment it can (block is the instant escape; no combo breaker). */
export const blocker =
  (id: number) =>
  (h: Harness): Pad => {
    const f = h.fighter(id);
    f.burst = 0; // BLOCK while being comboed would be a burst
    if (f.combo.hits === 0 && f.state !== 'hitstun' && f.state !== 'block' && f.state !== 'blockstun') return {};
    return { buttons: Button.BLOCK };
  };

/** A victim that mashes every escape option once it has been hit (set its burst to 0 to test true combos). */
export const escaper =
  (id: number) =>
  (h: Harness): Pad => {
    const f = h.fighter(id);
    const t = h.sim.state.frame;
    if (f.combo.hits === 0 && f.state !== 'hitstun') return {};
    return { buttons: t % 4 === 0 ? Button.DODGE : t % 4 === 2 ? Button.BLOCK : 0 };
  };
