/**
 * Training / enemy AI. A bot is just another input device: it reads the
 * simulation and produces an InputFrame, exactly like a human player, so
 * bots obey every rule (buffers, cancel windows, meter, tech timing).
 *
 * Modes:
 *   idle    - stands still (still techs/bursts if configured)
 *   block   - holds guard forever
 *   parry   - deflects every attack with perfect timing (chance-based)
 *   dodge   - sidesteps attacks at the last moment
 *   fighter - full AI: footsies, strings, launch combos, defense, escapes
 */
import { Button, type Dir, type InputFrame, neutralInput } from '../input';
import { chance, nextRandom, type RngState } from '../math/rng';
import { hDistance, wrapAngle, yawFromDir, yawTo } from '../math/vec3';
import { chestHeight, moveReach, totalFrames } from '../moves';
import { RULES } from '../rules';
import type { Simulation } from '../simulation';
import type { FighterState } from '../state';
import type { MoveDef } from '../types';

export type BotMode = 'idle' | 'block' | 'parry' | 'dodge' | 'fighter';

export interface BotConfig {
  mode: BotMode;
  /** Frames into an enemy attack before the bot notices it (human ~12-20). */
  reaction: number;
  /** 0..1, how often it starts offense. */
  aggression: number;
  blockChance: number;
  parryChance: number;
  dodgeChance: number;
  techChance: number;
  burstChance: number;
  /** Bursts once a combo reaches this many hits. */
  burstAtHits: number;
  seed: number;
}

export const DEFAULT_BOT: BotConfig = {
  mode: 'fighter',
  reaction: 14,
  aggression: 0.5,
  blockChance: 0.55,
  parryChance: 0.15,
  dodgeChance: 0.15,
  techChance: 0.6,
  burstChance: 0.5,
  burstAtHits: 7,
  seed: 1234,
};

interface Step {
  button: number;
  dir?: Dir;
  /** Only continue if the current move hit. */
  onHit?: boolean;
}

const { LIGHT: L, HEAVY: H, SPECIAL: E, JUMP: J, GRAB: G, SUPER: R, BLOCK, DODGE, BURST } = Button;

const PLANS: Record<string, Step[]> = {
  string: [{ button: L }, { button: L }, { button: L }, { button: L }],
  launch: [
    { button: L },
    { button: L },
    { button: H, onHit: true },
    { button: J, onHit: true },
    { button: L },
    { button: L },
    { button: H },
  ],
  hammer: [{ button: L }, { button: L }, { button: L }, { button: H, onHit: true }, { button: H, onHit: true }],
  haymaker: [{ button: H }, { button: H, onHit: true }],
  pokeBlast: [{ button: L }, { button: E, onHit: true }],
  grab: [{ button: G }],
  dash: [{ button: H, dir: 'forward' }],
  super: [{ button: R }],
};

interface Threat {
  key: string;
  framesToHit: number;
  perceived: boolean;
}

export class Bot {
  config: BotConfig;
  private rng: RngState;
  private prevButtons = 0;
  private pendingTaps = 0;
  private plan: Step[] = [];
  private stepDir: Dir = 'neutral';
  private stepDirTimer = 0;
  private lastMove: string | null = null;
  private lastMoveFrame = 0;
  private cooldown = 30;
  private strafe = 1;
  private strafeTimer = 0;
  private threatKey = '';
  private defense: 'none' | 'block' | 'parry' | 'dodge' = 'none';
  private defenseDone = false;
  private blockHold = 0;
  /** Speculative guard: humans can't react to 5-frame jabs, they guard in advance. */
  private guardTimer = 0;
  private escapeKey = '';
  private escapeAt = -1;
  private burstDecidedFor = -1;

  constructor(
    readonly fighterId: number,
    config: Partial<BotConfig> = {},
  ) {
    this.config = { ...DEFAULT_BOT, ...config };
    this.rng = { seed: this.config.seed };
  }

  setMode(mode: BotMode): void {
    this.config.mode = mode;
    this.plan = [];
    this.defense = 'none';
  }

  think(sim: Simulation): InputFrame {
    const f = sim.fighter(this.fighterId);
    if (!f) return neutralInput();
    const target = this.nearestEnemy(sim, f);
    const out = neutralInput(f.yaw, f.aimPitch);
    let held = 0;
    let taps = this.pendingTaps;
    this.pendingTaps = 0;

    if (target) {
      out.yaw = yawTo(f.pos, target.pos);
      const ts = sim.statsOf(target);
      const fs = sim.statsOf(f);
      out.pitch = Math.atan2(
        target.pos.y + chestHeight(ts) - (f.pos.y + chestHeight(fs)),
        Math.max(0.5, hDistance(f.pos, target.pos)),
      );
    }

    taps |= this.escapes(sim, f);

    const mode = this.config.mode;
    const threat = target ? this.findThreat(sim, f) : null;
    if (mode === 'block') {
      held |= BLOCK;
    } else if (mode === 'parry') {
      if (threat && threat.framesToHit <= 2 && threat.key !== this.threatKey) {
        this.threatKey = threat.key;
        if (chance(this.rng, this.config.parryChance)) taps |= BLOCK;
      }
    } else if (mode === 'dodge') {
      if (threat && threat.framesToHit <= 3 && threat.key !== this.threatKey) {
        this.threatKey = threat.key;
        taps |= DODGE;
        out.moveX = this.strafe;
        this.strafe = -this.strafe;
      }
    } else if (mode === 'fighter' && target) {
      const d = this.fight(sim, f, target, threat, out);
      held |= d.held;
      taps |= d.taps;
    }

    // A tapped button must be released first if it is currently down.
    let buttons = held;
    for (let b = 1; b <= Button.LOCK; b <<= 1) {
      if (!(taps & b)) continue;
      if (this.prevButtons & b && !(held & b)) this.pendingTaps |= b;
      else buttons |= b;
    }
    if (this.stepDirTimer > 0) {
      this.stepDirTimer--;
      if (this.stepDir === 'forward') out.moveY = 1;
      else if (this.stepDir === 'back') out.moveY = -1;
      else if (this.stepDir === 'neutral') {
        out.moveX = 0;
        out.moveY = 0;
      }
    }
    out.buttons = buttons;
    this.prevButtons = buttons;
    return out;
  }

  // -------------------------------------------------------------- helpers

  private nearestEnemy(sim: Simulation, f: FighterState): FighterState | null {
    let best: FighterState | null = null;
    let bd = Infinity;
    for (const e of sim.state.fighters) {
      if (e.team === f.team || e.state === 'ko') continue;
      const d = hDistance(e.pos, f.pos);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  /** The most urgent incoming attack aimed at us, if any. */
  private findThreat(sim: Simulation, f: FighterState): Threat | null {
    let best: Threat | null = null;
    for (const e of sim.state.fighters) {
      if (e.team === f.team || e.state !== 'attack') continue;
      const m = sim.moveOf(e);
      if (!m || m.kind === 'throw') continue;
      const firstHit = m.hitboxes.length ? Math.min(...m.hitboxes.map((h) => h.frames[0])) : m.startup + 1;
      const lastHit = m.hitboxes.length ? Math.max(...m.hitboxes.map((h) => h.frames[1])) : m.startup + m.active;
      if (e.moveFrame > lastHit) continue;
      const reach = moveReach(m) + (m.lunge ?? RULES.defaultLunge[m.kind]) + 0.8;
      if (m.hitboxes.length && hDistance(e.pos, f.pos) > reach) continue;
      const ang = Math.abs(wrapAngle(yawFromDir(f.pos.x - e.pos.x, f.pos.z - e.pos.z) - e.yaw));
      if (ang > 0.9 && e.moveTarget !== f.id) continue;
      const t: Threat = {
        key: `${e.id}:${e.move}:${sim.state.frame - e.moveFrame}`,
        framesToHit: Math.max(0, firstHit - e.moveFrame - 1),
        perceived: e.moveFrame >= this.config.reaction,
      };
      if (!best || t.framesToHit < best.framesToHit) best = t;
    }
    for (const p of sim.state.projectiles) {
      if (p.team === f.team) continue;
      const dx = f.pos.x - p.pos.x;
      const dz = f.pos.z - p.pos.z;
      const closing = (dx * p.vel.x + dz * p.vel.z) / Math.max(0.01, Math.hypot(dx, dz));
      if (closing <= 0) continue;
      const frames = Math.floor((Math.hypot(dx, dz) / closing) * 60);
      if (frames > 30) continue;
      const t: Threat = { key: `p${p.id}`, framesToHit: Math.max(0, frames - 2), perceived: true };
      if (!best || t.framesToHit < best.framesToHit) best = t;
    }
    return best;
  }

  /** Tech, throw-tech and burst decisions. Returns buttons to tap. */
  private escapes(sim: Simulation, f: FighterState): number {
    const c = this.config;
    let taps = 0;
    const key = `${f.state}:${sim.state.frame - f.stateFrame}`;
    if (key !== this.escapeKey) {
      this.escapeKey = key;
      this.escapeAt = -1;
      if (f.state === 'juggle' || f.state === 'knockdown' || f.state === 'grabbed') {
        if (chance(this.rng, c.techChance)) this.escapeAt = Math.floor(nextRandom(this.rng) * 6);
      }
    }
    if (this.escapeAt >= 0) {
      if (f.state === 'juggle' && f.stun === 0 && !f.impact.hardKnockdown && this.escapeAt-- <= 0) taps |= J;
      if (f.state === 'knockdown' && f.stateFrame >= RULES.knockdownTechFrom + this.escapeAt) taps |= DODGE;
      if (f.state === 'grabbed' && f.stateFrame >= Math.min(c.reaction, RULES.throwTechWindow - 2)) taps |= G;
    }
    const comboed = f.state === 'hitstun' || f.state === 'juggle' || f.state === 'wallsplat' || f.state === 'stagger';
    if (comboed && f.burst >= RULES.burstMax && f.combo.hits >= c.burstAtHits && this.burstDecidedFor !== f.combo.startFrame) {
      this.burstDecidedFor = f.combo.startFrame;
      if (chance(this.rng, c.burstChance)) taps |= BURST;
    }
    return taps;
  }

  private fight(
    sim: Simulation,
    f: FighterState,
    target: FighterState,
    threat: Threat | null,
    out: InputFrame,
  ): { held: number; taps: number } {
    let held = 0;
    let taps = 0;
    const cfg = this.config;
    const actionable = f.state === 'ground' || f.state === 'block' || f.state === 'blockstun';

    // ------------------------------------------------ defense
    if (threat && threat.key !== this.threatKey && threat.perceived && actionable && this.plan.length === 0) {
      this.threatKey = threat.key;
      this.defenseDone = false;
      const r = nextRandom(this.rng);
      if (r < cfg.parryChance) this.defense = 'parry';
      else if (r < cfg.parryChance + cfg.dodgeChance) this.defense = 'dodge';
      else if (r < cfg.parryChance + cfg.dodgeChance + cfg.blockChance) this.defense = 'block';
      else this.defense = 'none';
    }
    if (this.defense !== 'none' && threat && threat.key === this.threatKey) {
      if (this.defense === 'parry' && !this.defenseDone && threat.framesToHit <= 2) {
        taps |= BLOCK;
        this.defenseDone = true;
      } else if (this.defense === 'dodge' && !this.defenseDone && threat.framesToHit <= 3) {
        taps |= DODGE;
        out.moveX = this.strafe;
        this.strafe = -this.strafe;
        this.defenseDone = true;
      }
      if (this.defense === 'block' || (this.defense === 'parry' && this.defenseDone)) {
        held |= BLOCK;
        this.blockHold = 10;
      }
      return { held, taps };
    }
    if (f.state === 'blockstun' || this.blockHold > 0) {
      this.blockHold--;
      held |= BLOCK;
      return { held, taps };
    }
    this.defense = 'none';

    // ------------------------------------------------ plan execution
    if (this.plan.length > 0) {
      taps |= this.runPlan(sim, f);
      return { held, taps };
    }

    // ------------------------------------------------ neutral
    if (!actionable && f.state !== 'air') return { held, taps };
    if (this.cooldown > 0) this.cooldown--;
    const dist = hDistance(f.pos, target.pos);
    const tm = sim.moveOf(target);
    const punishable =
      target.state === 'stagger' ||
      target.state === 'land' ||
      (tm !== null && target.moveFrame > tm.startup + tm.active && totalFrames(tm) - target.moveFrame > 10);

    if (punishable && dist < 3.2 && f.state === 'ground') {
      this.startPlan(target.state === 'stagger' ? 'launch' : 'string');
      taps |= this.runPlan(sim, f);
      return { held, taps };
    }

    if (dist > 3.0) {
      out.moveY = 1;
      if (dist > 7 && chance(this.rng, 0.01 * cfg.aggression)) this.startPlan('pokeBlast');
      else if (dist < 4.6 && dist > 3.4 && chance(this.rng, 0.02 * cfg.aggression)) this.startPlan('dash');
    } else {
      const targetBusy = target.state !== 'ground' && target.state !== 'air' && target.state !== 'attack';
      if (this.guardTimer > 0) {
        this.guardTimer--;
        if (!targetBusy) {
          held |= BLOCK;
          out.moveX = this.strafe * 0.4;
          return { held, taps };
        }
      } else if (!targetBusy && chance(this.rng, 0.03 * cfg.blockChance)) {
        this.guardTimer = 20 + Math.floor(nextRandom(this.rng) * 40);
      }
      if (--this.strafeTimer <= 0) {
        this.strafeTimer = 30 + Math.floor(nextRandom(this.rng) * 60);
        this.strafe = chance(this.rng, 0.5) ? 1 : -1;
      }
      out.moveX = this.strafe * 0.7;
      out.moveY = dist > 2.3 ? 0.6 : dist < 1.4 ? -0.6 : 0;
      if (this.cooldown <= 0 && f.state === 'ground' && chance(this.rng, 0.06 * cfg.aggression)) {
        this.startPlan(this.pickPlan(sim, f, target));
      }
    }
    if (this.plan.length > 0) taps |= this.runPlan(sim, f);
    return { held, taps };
  }

  private pickPlan(sim: Simulation, f: FighterState, target: FighterState): string {
    if (f.meter >= 100 && chance(this.rng, 0.15)) return 'super';
    if (target.state === 'block' && chance(this.rng, 0.45)) return 'grab';
    const r = nextRandom(this.rng);
    if (r < 0.3) return 'string';
    if (r < 0.55) return 'launch';
    if (r < 0.7) return 'hammer';
    if (r < 0.82) return 'haymaker';
    if (r < 0.9) return 'grab';
    void sim;
    return 'pokeBlast';
  }

  private startPlan(name: string): void {
    this.plan = PLANS[name].map((s) => ({ ...s }));
    this.lastMove = null;
    this.lastMoveFrame = 0;
  }

  /** Feeds the next step of the current plan at the right moment. */
  private runPlan(sim: Simulation, f: FighterState): number {
    const step = this.plan[0];
    if (!step) return 0;
    const m: MoveDef | null = sim.moveOf(f);
    const started = sim.state.frame - f.moveFrame;
    const inNewMove = f.state === 'attack' && (f.move !== this.lastMove || started !== this.lastMoveFrame);

    if (f.state === 'attack' && m) {
      if (inNewMove) {
        this.lastMove = f.move;
        this.lastMoveFrame = started;
      }
      if (step.onHit && f.moveFrame > m.startup + m.active && !f.moveHit) {
        return this.endPlan();
      }
      const window =
        m.cancels?.find((c) => c.button === step.button)?.frames[0] ??
        (step.button === J ? m.jumpCancel?.frames[0] : undefined) ??
        totalFrames(m) - 1;
      if (f.moveFrame >= window - 2 && (!step.onHit || f.moveHit)) return this.tapStep(step);
      return 0;
    }
    if (f.state === 'ground' || f.state === 'air' || f.state === 'block') {
      if (this.lastMove !== null && step.button !== J && f.state === 'ground') {
        // A string was interrupted (whiff, clash...).
        return this.endPlan();
      }
      return this.tapStep(step);
    }
    if (f.state === 'hitstun' || f.state === 'juggle' || f.state === 'blockstun' || f.state === 'stagger') {
      return this.endPlan();
    }
    return 0;
  }

  private tapStep(step: Step): number {
    this.plan.shift();
    this.stepDir = step.dir ?? 'neutral';
    this.stepDirTimer = 10;
    if (this.plan.length === 0) this.cooldown = 25 + Math.floor(nextRandom(this.rng) * 40);
    return step.button;
  }

  private endPlan(): number {
    this.plan = [];
    this.cooldown = 20 + Math.floor(nextRandom(this.rng) * 30);
    return 0;
  }
}
