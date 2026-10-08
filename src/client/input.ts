/**
 * Keyboard + mouse + gamepad -> InputFrame.
 *
 * The control scheme is deliberately small: two attack buttons (the strike
 * depends on where you are in the combo), jump, dash, block, special.
 * Both attack buttons together = throw.
 *
 * - Presses are latched until the next simulation tick so a tap shorter than
 *   one frame (16 ms) is never lost.
 * - The look flick at a press is still measured and sent (characters may use
 *   it), but no Striker move needs it.
 */
import { Button, type InputFrame, type Swipe, swipeCode } from '../core/input';

export const KEY_BINDINGS: Record<string, number> = {
  KeyF: Button.BLOCK,
  ShiftLeft: Button.DODGE,
  ShiftRight: Button.DODGE,
  Space: Button.JUMP,
  KeyE: Button.SPECIAL,
  Tab: Button.LOCK,
};

export const MOUSE_BINDINGS: Record<number, number> = {
  0: Button.LIGHT,
  1: Button.LOCK,
  2: Button.HEAVY,
};

/** Standard gamepad layout (Xbox naming). */
const PAD_BINDINGS: [number, number][] = [
  [0, Button.JUMP], // A
  [1, Button.DODGE], // B
  [2, Button.LIGHT], // X
  [3, Button.HEAVY], // Y
  [4, Button.DODGE], // LB
  [5, Button.BLOCK], // RB
  [7, Button.SPECIAL], // RT
  [11, Button.LOCK], // R3
];

const ATTACKS = Button.LIGHT | Button.HEAVY;
const SWIPE_WINDOW_MS = 160;
/** Minimum look rotation inside the window to count as a flick (radians). */
const SWIPE_THRESHOLD = 0.05;

export class InputDevice {
  yaw = 0;
  pitch = 0;
  sensitivity = 0.0022;
  private held = 0;
  private latched = 0;
  private keys = new Set<string>();
  private padYawSpeed = 3.2;
  /** Recent look motion (radians) for swipe detection. */
  private motion: { t: number; dYaw: number; dPitch: number }[] = [];
  /** Swipe captured at the moment an attack button went down (sent on the next tick). */
  private pressSwipe: Swipe = 'none';
  /** Last detected swipe + time, for the HUD. */
  lastSwipe: { swipe: Swipe; t: number } = { swipe: 'none', t: 0 };

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    target.addEventListener('mousedown', (e) => this.onMouse(e, true));
    window.addEventListener('mouseup', (e) => this.onMouse(e, false));
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const dYaw = -e.movementX * this.sensitivity;
      const dPitch = -e.movementY * this.sensitivity;
      this.yaw += dYaw;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dPitch));
      this.motion.push({ t: performance.now(), dYaw, dPitch });
    });
    window.addEventListener('blur', () => {
      this.held = 0;
      this.keys.clear();
    });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.target;
  }

  /** Classifies recent look motion into a flick direction. */
  currentSwipe(now = performance.now()): Swipe {
    const since = now - SWIPE_WINDOW_MS;
    while (this.motion.length && this.motion[0].t < since) this.motion.shift();
    let yaw = 0;
    let pitch = 0;
    for (const m of this.motion) {
      yaw += m.dYaw;
      pitch += m.dPitch;
    }
    if (Math.max(Math.abs(yaw), Math.abs(pitch)) < SWIPE_THRESHOLD) return 'none';
    if (Math.abs(yaw) >= Math.abs(pitch) * 0.9) return yaw > 0 ? 'left' : 'right';
    return pitch > 0 ? 'up' : 'down';
  }

  private press(b: number): void {
    this.held |= b;
    this.latched |= b;
    if (b & ATTACKS) {
      this.pressSwipe = this.currentSwipe();
      this.lastSwipe = { swipe: this.pressSwipe, t: performance.now() };
    }
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (!this.locked) return;
    const b = KEY_BINDINGS[e.code];
    if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
    if (b === undefined || e.repeat) return;
    if (down) this.press(b);
    else this.held &= ~b;
  }

  private onMouse(e: MouseEvent, down: boolean): void {
    if (!this.locked) return;
    const b = MOUSE_BINDINGS[e.button];
    if (b === undefined) return;
    e.preventDefault();
    if (down) this.press(b);
    else this.held &= ~b;
  }

  /** Builds the input for one simulation tick. */
  sample(dt: number): InputFrame {
    let moveX = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    let moveY = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    let buttons = this.held | this.latched;
    const fresh = this.latched;
    this.latched = 0;

    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < 0.18 ? 0 : v);
      moveX += dz(pad.axes[0] ?? 0);
      moveY -= dz(pad.axes[1] ?? 0);
      const dYaw = -dz(pad.axes[2] ?? 0) * this.padYawSpeed * dt;
      const dPitch = -dz(pad.axes[3] ?? 0) * 2.2 * dt;
      this.yaw += dYaw;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dPitch));
      if (dYaw || dPitch) this.motion.push({ t: performance.now(), dYaw: dYaw * 1.6, dPitch: dPitch * 1.6 });
      for (const [i, b] of PAD_BINDINGS) {
        if (!pad.buttons[i]?.pressed) continue;
        if (b & ATTACKS && !(buttons & b)) {
          this.pressSwipe = this.currentSwipe();
          this.lastSwipe = { swipe: this.pressSwipe, t: performance.now() };
        }
        buttons |= b;
      }
    }
    // Both attack buttons together: throw.
    if ((buttons & Button.LIGHT) !== 0 && (buttons & Button.HEAVY) !== 0) buttons |= Button.GRAB;
    const m = Math.hypot(moveX, moveY);
    if (m > 1) {
      moveX /= m;
      moveY /= m;
    }
    const swipe = fresh & ATTACKS || buttons & ATTACKS ? swipeCode(this.pressSwipe) : 0;
    if (!(buttons & ATTACKS)) this.pressSwipe = 'none';
    return { moveX, moveY, yaw: this.yaw, pitch: this.pitch, buttons, swipe };
  }

  isKey(code: string): boolean {
    return this.keys.has(code);
  }
}
