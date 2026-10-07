/**
 * Keyboard + mouse + gamepad -> InputFrame.
 * Presses are latched until the next simulation tick so a tap shorter than
 * one frame (16 ms) is never lost.
 */
import { Button, type InputFrame } from '../core/input';

export const KEY_BINDINGS: Record<string, number> = {
  KeyF: Button.BLOCK,
  ShiftLeft: Button.DODGE,
  ShiftRight: Button.DODGE,
  Space: Button.JUMP,
  KeyE: Button.SPECIAL,
  KeyQ: Button.GRAB,
  KeyR: Button.SUPER,
  KeyX: Button.BURST,
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
  [4, Button.GRAB], // LB
  [5, Button.BLOCK], // RB
  [6, Button.SUPER], // LT
  [7, Button.SPECIAL], // RT
  [10, Button.BURST], // L3
  [11, Button.LOCK], // R3
];

export class InputDevice {
  yaw = 0;
  pitch = 0;
  sensitivity = 0.0022;
  private held = 0;
  private latched = 0;
  private keys = new Set<string>();
  private padYawSpeed = 3.2;

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    target.addEventListener('mousedown', (e) => this.onMouse(e, true));
    window.addEventListener('mouseup', (e) => this.onMouse(e, false));
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * this.sensitivity));
    });
    window.addEventListener('blur', () => {
      this.held = 0;
      this.keys.clear();
    });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.target;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (!this.locked) return;
    const b = KEY_BINDINGS[e.code];
    if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
    if (b === undefined || e.repeat) return;
    if (down) {
      this.held |= b;
      this.latched |= b;
    } else {
      this.held &= ~b;
    }
  }

  private onMouse(e: MouseEvent, down: boolean): void {
    if (!this.locked) return;
    const b = MOUSE_BINDINGS[e.button];
    if (b === undefined) return;
    e.preventDefault();
    if (down) {
      this.held |= b;
      this.latched |= b;
    } else {
      this.held &= ~b;
    }
  }

  /** Builds the input for one simulation tick. */
  sample(dt: number): InputFrame {
    let moveX = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    let moveY = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    let buttons = this.held | this.latched;
    this.latched = 0;

    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < 0.18 ? 0 : v);
      moveX += dz(pad.axes[0] ?? 0);
      moveY -= dz(pad.axes[1] ?? 0);
      this.yaw -= dz(pad.axes[2] ?? 0) * this.padYawSpeed * dt;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - dz(pad.axes[3] ?? 0) * 2.2 * dt));
      for (const [i, b] of PAD_BINDINGS) if (pad.buttons[i]?.pressed) buttons |= b;
    }
    const m = Math.hypot(moveX, moveY);
    if (m > 1) {
      moveX /= m;
      moveY /= m;
    }
    return { moveX, moveY, yaw: this.yaw, pitch: this.pitch, buttons };
  }

  isKey(code: string): boolean {
    return this.keys.has(code);
  }
}
