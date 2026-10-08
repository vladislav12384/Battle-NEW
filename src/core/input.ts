import { RULES } from './rules';

/** Buttons as a bitmask. Device mapping (keyboard/gamepad) lives in the client. */
export const Button = {
  LIGHT: 1 << 0,
  HEAVY: 1 << 1,
  SPECIAL: 1 << 2,
  JUMP: 1 << 3,
  DODGE: 1 << 4,
  BLOCK: 1 << 5,
  GRAB: 1 << 6,
  BURST: 1 << 7,
  SUPER: 1 << 8,
  LOCK: 1 << 9,
  KICK: 1 << 10,
} as const;

export type ButtonName = keyof typeof Button;
export const BUTTON_COUNT = 11;

/**
 * Direction of the look "flick" at the moment an attack button is pressed
 * (mouse swipe or right-stick flick). Lets the player pick hooks, uppercuts,
 * overheads... by how they move the camera, Mordhau / For Honor style.
 */
export type Swipe = 'none' | 'left' | 'right' | 'up' | 'down';
export const SWIPES: readonly Swipe[] = ['none', 'left', 'right', 'up', 'down'];
export const swipeCode = (s: Swipe): number => SWIPES.indexOf(s);

/**
 * One tick of player intent. This is the only thing that needs to be sent
 * over the network: the simulation is a pure function of inputs.
 */
export interface InputFrame {
  /** Strafe axis relative to the camera, -1 (left) .. 1 (right). */
  moveX: number;
  /** Forward axis relative to the camera, -1 (back) .. 1 (forward). */
  moveY: number;
  /** Camera yaw (radians). */
  yaw: number;
  /** Camera pitch (radians), positive = looking up. */
  pitch: number;
  buttons: number;
  /** Swipe direction this tick (index into SWIPES; 0/undefined = none). */
  swipe?: number;
}

export const neutralInput = (yaw = 0, pitch = 0): InputFrame => ({
  moveX: 0,
  moveY: 0,
  yaw,
  pitch,
  buttons: 0,
});

const NEVER = 9999;

/**
 * Per-fighter input history. Tracks how long ago each button was pressed so
 * that presses can be buffered (pressed slightly early still counts) and
 * consumed exactly once.
 */
export interface InputBuffer {
  prevButtons: number;
  /** Frames since the last fresh press of each button (NEVER = consumed / none). */
  pressAge: number[];
  /** Frames each button has been held continuously (0 = released). */
  held: number[];
  /** Swipe recorded at each button's last fresh press. */
  pressSwipe: number[];
}

export function createInputBuffer(): InputBuffer {
  return {
    prevButtons: 0,
    pressAge: new Array<number>(BUTTON_COUNT).fill(NEVER),
    held: new Array<number>(BUTTON_COUNT).fill(0),
    pressSwipe: new Array<number>(BUTTON_COUNT).fill(0),
  };
}

const bitIndex = (button: number): number => 31 - Math.clz32(button);

/**
 * Feeds a new input frame. While `frozen` (hitstop) presses still register
 * but don't age, so inputs made during hit freeze are never lost.
 */
export function feedInput(buf: InputBuffer, input: InputFrame, frozen: boolean): void {
  for (let i = 0; i < BUTTON_COUNT; i++) {
    const bit = 1 << i;
    const down = (input.buttons & bit) !== 0;
    const wasDown = (buf.prevButtons & bit) !== 0;
    if (down && !wasDown) {
      buf.pressAge[i] = 0;
      buf.pressSwipe[i] = input.swipe ?? 0;
    } else if (!frozen && buf.pressAge[i] < NEVER) buf.pressAge[i]++;
    if (!down) buf.held[i] = 0;
    else if (!frozen || buf.held[i] === 0) buf.held[i]++;
  }
  buf.prevButtons = input.buttons;
}

/** True if `button` was freshly pressed within the last `window` frames and not yet consumed. */
export function buffered(buf: InputBuffer, button: number, window: number = RULES.inputBuffer): boolean {
  return buf.pressAge[bitIndex(button)] <= window;
}

export function consume(buf: InputBuffer, button: number): void {
  buf.pressAge[bitIndex(button)] = NEVER;
}

export function isHeld(buf: InputBuffer, button: number): boolean {
  return buf.held[bitIndex(button)] > 0;
}

export function heldFrames(buf: InputBuffer, button: number): number {
  return buf.held[bitIndex(button)];
}

/** The swipe direction that accompanied the last press of `button`. */
export function pressSwipe(buf: InputBuffer, button: number): Swipe {
  return SWIPES[buf.pressSwipe[bitIndex(button)]] ?? 'none';
}

/** Stick direction relative to the camera, used for directional commands. */
export type Dir = 'neutral' | 'forward' | 'back' | 'left' | 'right';

export function stickDir(input: InputFrame): Dir {
  const x = input.moveX;
  const y = input.moveY;
  if (Math.hypot(x, y) < 0.35) return 'neutral';
  if (Math.abs(y) >= Math.abs(x)) return y > 0 ? 'forward' : 'back';
  return x > 0 ? 'right' : 'left';
}
