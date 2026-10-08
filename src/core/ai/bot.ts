/**
 * Training / enemy AI. A bot is just another input device: it reads the
 * simulation and produces an InputFrame, exactly like a human player, so
 * bots obey every rule (buffers, cancel windows, meter, tech timing).
 *
 * Difficulty (BOT_LEVELS): reaction time and its spread, aim tracking and
 * error, timing mistakes and abandoned strings, defense habits, how long the
 * strings it knows are. The bot reads the simulation, so the levels make it
 * deliberately imperfect, like a person.
 *
 * Modes:
 *   idle    - stands still (still techs/bursts if configured)
 *   block   - holds guard forever
 *   parry   - deflects every attack with perfect timing (chance-based)
 *   dodge   - sidesteps attacks at the last moment
 *   fighter - full AI: footsies, strings, launch combos, defense, escapes
 *   drill   - training partner: walks up and repeats one attack (setDrill)
 */
import { chainWindowStart } from '../fighter';
import { Button, type Dir, type InputFrame, neutralInput, type Swipe, swipeCode } from '../input';
import { chance, nextRandom, type RngState } from '../math/rng';
import { approachAngle, hDistance, wrapAngle, yawFromDir, yawTo } from '../math/vec3';
import { chestHeight, moveReach, strikeLine, totalFrames } from '../moves';
import { RULES } from '../rules';
import type { Simulation } from '../simulation';
import type { FighterState } from '../state';
import type { MoveDef, StrikeLine } from '../types';

export type BotMode = 'idle' | 'block' | 'parry' | 'dodge' | 'fighter' | 'drill';
export type BotLevel = 'easy' | 'normal' | 'hard';

export interface BotConfig {
  mode: BotMode;
  /** Frames into an enemy attack before the bot notices it (human ~15-20). */
  reaction: number;
  /** Random extra reaction frames per attack (people aren't metronomes). */
  reactionJitter: number;
  /** How fast the bot's view turns toward its target (rad/frame)... */
  aimTurn: number;
  /** ...and how far its aim wanders (rad). */
  aimError: number;
  /** Up to this many frames late on each chained press (late = broken string). */
  timingError: number;
  /** Chance to stop a string halfway. */
  dropChance: number;
  /** Chance that a dodge is timed at the last moment (perfect dodge). */
  perfectDodge: number;
  /** Frames between its attacks [min, max]. */
  cooldown: [number, number];
  /** 0 = short strings only, 1 = medium, 2 = launchers and full strings. */
  comboLevel: number;
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

/** Difficulty presets (everything except mode and seed). */
export const BOT_LEVELS: Record<BotLevel, Omit<BotConfig, 'mode' | 'seed'>> = {
  // Beginner: slow and late, aims sloppily, short strings, rarely defends well.
  easy: {
    reaction: 26,
    reactionJitter: 10,
    aimTurn: 0.06,
    aimError: 0.16,
    timingError: 7,
    dropChance: 0.35,
    perfectDodge: 0.05,
    cooldown: [80, 150],
    comboLevel: 0,
    aggression: 0.3,
    blockChance: 0.3,
    parryChance: 0,
    dodgeChance: 0.04,
    techChance: 0.15,
    burstChance: 0.1,
    burstAtHits: 9,
  },
  // Fighter: human-like reactions and the occasional mistake.
  normal: {
    reaction: 20,
    reactionJitter: 6,
    aimTurn: 0.12,
    aimError: 0.07,
    timingError: 3,
    dropChance: 0.15,
    perfectDodge: 0.2,
    cooldown: [50, 100],
    comboLevel: 1,
    aggression: 0.45,
    blockChance: 0.45,
    parryChance: 0.05,
    dodgeChance: 0.12,
    techChance: 0.45,
    burstChance: 0.35,
    burstAtHits: 7,
  },
  // Master: sharp reactions, clean strings, parries and perfect dodges.
  hard: {
    reaction: 14,
    reactionJitter: 2,
    aimTurn: 0.3,
    aimError: 0.02,
    timingError: 0,
    dropChance: 0,
    perfectDodge: 0.35,
    cooldown: [30, 70],
    comboLevel: 2,
    aggression: 0.6,
    blockChance: 0.55,
    parryChance: 0.15,
    dodgeChance: 0.18,
    techChance: 0.7,
    burstChance: 0.55,
    burstAtHits: 6,
  },
};

export const DEFAULT_BOT: BotConfig = { mode: 'fighter', ...BOT_LEVELS.hard, seed: 1234 };

interface Step {
  button: number;
  dir?: Dir;
  /** Look flick sent with the press (picks hooks, uppercuts, overheads...). */
  swipe?: Swipe;
  /** Only continue if the current move hit. */
  onHit?: boolean;
}

const { LIGHT: L, HEAVY: H, SPECIAL: E, JUMP: J, GRAB: G, BLOCK, DODGE, BURST } = Button;

/**
 * Strings the AI likes. The strike that comes out depends on the position in
 * the string (same rules as for players): L L L L = jab, cross, hook,
 * uppercut; a power press finishes with whatever fits that position.
 */
const PLANS: Record<string, Step[]> = {
  jab2: [{ button: L }, { button: L, onHit: true }],
  boxing: [{ button: L }, { button: L }, { button: L }, { button: L, onHit: true }],
  kick: [{ button: L }, { button: H, onHit: true }], // jab -> roundhouse
  backfist: [{ button: L }, { button: L }, { button: H, onHit: true }], // jab, cross -> spinning backfist
  launch: [
    { button: L },
    { button: L },
    { button: L },
    { button: H, onHit: true }, // rising uppercut
    { button: J, onHit: true },
    { button: L },
    { button: L },
    { button: H },
  ],
  axe: [{ button: L }, { button: L }, { button: L }, { button: L, onHit: true }, { button: H, onHit: true }],
  haymaker: [{ button: H }],
  pokeBlast: [{ button: L }, { button: E, onHit: true }],
  teep: [{ button: L, dir: 'back' }],
  sweep: [{ button: H, dir: 'back' }],
  grab: [{ button: G }],
  super: [{ button: E }],
};

interface Threat {
  key: string;
  framesToHit: number;
  perceived: boolean;
  kind: MoveDef['kind'];
  line: StrikeLine;
}

/** Stick X (bot faces the attacker) for the dash that slips a strike best. */
function dashSide(line: StrikeLine, fallback: number): number {
  if (line === 'fromLeft') return 1; // comes from our left: dash right
  if (line === 'fromRight') return -1;
  return fallback;
}

export class Bot {
  config: BotConfig;
  private rng: RngState;
  private prevButtons = 0;
  private pendingTaps = 0;
  private plan: Step[] = [];
  private stepDir: Dir = 'neutral';
  private stepDirTimer = 0;
  private stepSwipe: Swipe = 'none';
  private lastMove: string | null = null;
  private lastMoveFrame = 0;
  /** A step was pressed; wait for its move to start before pressing the next. */
  private waiting = false;
  private cooldown = 30;
  private strafe = 1;
  private strafeTimer = 0;
  private threatKey = '';
  private defense: 'none' | 'block' | 'parry' | 'dodge' = 'none';
  private defenseDone = false;
  private dodgeLead = 3;
  private blockHold = 0;
  /** Speculative guard: humans can't react to 5-frame jabs, they guard in advance. */
  private guardTimer = 0;
  private escapeKey = '';
  private escapeAt = -1;
  private burstDecidedFor = -1;
  /** Where the bot is looking (it turns like a player with a mouse, not instantly). */
  private aimYaw: number | null = null;
  private aimDrift = 0;
  /** Reaction rolled for the current threat. */
  private reactKey = '';
  private reactFrames = 0;
  /** Extra frames to wait before the next chained press (timing mistake). */
  private late = 0;
  /** Drill mode: the plan repeated and the pause between repetitions (frames). */
  private drillPlan = 'haymaker';
  private drillEvery = 120;

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
      // Imperfect aim: the view turns at a limited speed and wanders a little.
      const cfg = this.config;
      this.aimDrift += (nextRandom(this.rng) - 0.5) * 0.08;
      this.aimDrift *= 0.97;
      const want = yawTo(f.pos, target.pos) + Math.max(-1, Math.min(1, this.aimDrift * 6)) * cfg.aimError;
      this.aimYaw = this.aimYaw === null ? want : approachAngle(this.aimYaw, want, cfg.aimTurn);
      out.yaw = this.aimYaw;
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
      // Training dummy: a last-moment dash the right way (a perfect dodge).
      if (threat && threat.framesToHit <= 3 && threat.key !== this.threatKey) {
        this.threatKey = threat.key;
        taps |= DODGE;
        out.moveX = dashSide(threat.line, this.strafe);
        this.strafe = -this.strafe;
      }
    } else if (mode === 'drill' && target) {
      taps |= this.drill(sim, f, target, out);
    } else if (mode === 'fighter' && target) {
      const d = this.fight(sim, f, target, threat, out);
      held |= d.held;
      taps |= d.taps;
    }

    // A tapped button must be released first if it is currently down.
    let buttons = held;
    for (let b = 1; b <= Button.KICK; b <<= 1) {
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
    out.swipe = swipeCode(this.stepSwipe);
    this.stepSwipe = 'none';
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
      const key = `${e.id}:${e.move}:${sim.state.frame - e.moveFrame}`;
      const t: Threat = {
        key,
        framesToHit: Math.max(0, firstHit - e.moveFrame - 1),
        perceived: e.moveFrame >= this.reactionFor(key),
        kind: m.kind,
        line: strikeLine(m),
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
      const t: Threat = { key: `p${p.id}`, framesToHit: Math.max(0, frames - 2), perceived: true, kind: 'special', line: 'straight' };
      if (!best || t.framesToHit < best.framesToHit) best = t;
    }
    return best;
  }

  /** Reaction time for an attack (rolled once per attack). */
  private reactionFor(key: string): number {
    if (key !== this.reactKey) {
      this.reactKey = key;
      this.reactFrames = this.config.reaction + Math.floor(nextRandom(this.rng) * (this.config.reactionJitter + 1));
    }
    return this.reactFrames;
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
      // Slow blows seen coming are dashed through; quick ones are guarded.
      const dodge = Math.min(0.85, cfg.dodgeChance * (threat.kind === 'light' ? 0.5 : 2.2));
      const r = nextRandom(this.rng);
      if (r < cfg.parryChance) this.defense = 'parry';
      else if (r < cfg.parryChance + dodge && !f.exhausted) this.defense = 'dodge';
      else if (r < cfg.parryChance + dodge + cfg.blockChance) this.defense = 'block';
      else this.defense = 'none';
      // Dash timing: sometimes right at the last moment (perfect), usually a bit early.
      this.dodgeLead = chance(this.rng, cfg.perfectDodge)
        ? 3 + Math.floor(nextRandom(this.rng) * 3)
        : 6 + Math.floor(nextRandom(this.rng) * 6);
    }
    if (this.defense !== 'none' && threat && threat.key === this.threatKey) {
      if (this.defense === 'parry' && !this.defenseDone && threat.framesToHit <= 2) {
        taps |= BLOCK;
        this.defenseDone = true;
      } else if (this.defense === 'dodge' && !this.defenseDone && threat.framesToHit <= this.dodgeLead) {
        taps |= DODGE;
        out.moveX = dashSide(threat.line, this.strafe);
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

    // ------------------------------------------------ counter out of a perfect dodge
    if (f.state === 'dodge' && f.dodgeCounter && this.plan.length === 0) {
      this.startPlan(chance(this.rng, 0.5) ? 'haymaker' : 'launch');
    }

    // ------------------------------------------------ plan execution
    if (this.plan.length > 0) {
      taps |= this.runPlan(sim, f);
      return { held, taps };
    }

    // ------------------------------------------------ neutral
    if (!actionable && f.state !== 'air') return { held, taps };
    if (this.cooldown > 0) this.cooldown--;
    const dist = hDistance(f.pos, target.pos);
    const tired = f.exhausted || f.stamina < sim.statsOf(f).maxStamina * 0.25;
    if (tired && f.state === 'ground' && dist < 3.5) {
      // Out of breath: back off behind the guard and let stamina recover.
      out.moveY = -0.8;
      out.moveX = this.strafe * 0.5;
      if (dist < 2.2) held |= BLOCK;
      return { held, taps };
    }
    const tm = sim.moveOf(target);
    const punishable =
      target.state === 'stagger' ||
      target.state === 'land' ||
      target.exposed > 0 ||
      (tm !== null && target.moveFrame > tm.startup + tm.active && totalFrames(tm) - target.moveFrame > 10);

    if (punishable && dist < 3.2 && f.state === 'ground') {
      this.startPlan(target.state === 'stagger' ? 'launch' : 'boxing');
      taps |= this.runPlan(sim, f);
      return { held, taps };
    }

    if (dist > 3.0) {
      out.moveY = 1;
      if (dist > 7 && chance(this.rng, 0.01 * cfg.aggression)) this.startPlan('pokeBlast');
      else if (dist < 3.6 && dist > 3.0 && chance(this.rng, 0.03 * cfg.aggression)) this.startPlan('haymaker');
    } else {
      const targetBusy = target.state !== 'ground' && target.state !== 'air' && target.state !== 'attack';
      if (this.guardTimer > 0) {
        this.guardTimer--;
        if (!targetBusy) {
          held |= BLOCK;
          out.moveX = this.strafe * 0.4;
          return { held, taps };
        }
      } else if (!targetBusy && chance(this.rng, 0.015 * cfg.blockChance)) {
        this.guardTimer = 15 + Math.floor(nextRandom(this.rng) * 25);
      }
      if (--this.strafeTimer <= 0) {
        this.strafeTimer = 30 + Math.floor(nextRandom(this.rng) * 60);
        this.strafe = chance(this.rng, 0.5) ? 1 : -1;
      }
      out.moveX = this.strafe * 0.5;
      out.moveY = dist > 2.3 ? 0.6 : dist < 1.4 ? -0.6 : 0;
      if (this.cooldown <= 0 && f.state === 'ground' && chance(this.rng, 0.045 * cfg.aggression)) {
        this.startPlan(this.pickPlan(f, target));
      }
    }
    if (this.plan.length > 0) taps |= this.runPlan(sim, f);
    return { held, taps };
  }

  private pickPlan(f: FighterState, target: FighterState): string {
    const lvl = this.config.comboLevel;
    if (lvl >= 2 && f.meter >= 100 && chance(this.rng, 0.15)) return 'super';
    if (target.state === 'block' && chance(this.rng, 0.15 + 0.15 * lvl)) return chance(this.rng, 0.5) ? 'grab' : 'sweep';
    if (lvl === 0) {
      const r = nextRandom(this.rng);
      if (r < 0.3) return 'jab2';
      if (r < 0.5) return 'kick';
      if (r < 0.7) return 'haymaker';
      if (r < 0.82) return 'teep';
      if (r < 0.92) return 'sweep';
      return 'grab';
    }
    if (lvl === 1) {
      const r = nextRandom(this.rng);
      if (r < 0.25) return 'boxing';
      if (r < 0.42) return 'kick';
      if (r < 0.56) return 'backfist';
      if (r < 0.7) return 'haymaker';
      if (r < 0.8) return 'grab';
      if (r < 0.88) return 'sweep';
      if (r < 0.94) return 'teep';
      return 'pokeBlast';
    }
    const r = nextRandom(this.rng);
    if (r < 0.18) return 'boxing';
    if (r < 0.32) return 'kick';
    if (r < 0.44) return 'backfist';
    if (r < 0.58) return 'launch';
    if (r < 0.66) return 'axe';
    if (r < 0.76) return 'haymaker';
    if (r < 0.84) return 'grab';
    if (r < 0.9) return 'sweep';
    if (r < 0.95) return 'teep';
    return 'pokeBlast';
  }

  private startPlan(name: string): void {
    this.plan = PLANS[name].map((s) => ({ ...s }));
    this.lastMove = null;
    this.lastMoveFrame = 0;
    this.waiting = false;
  }

  /** Feeds the next step of the current plan at the right moment. */
  private runPlan(sim: Simulation, f: FighterState): number {
    // Detect a newly started move (move frames only go backwards when a new move starts;
    // during hit stop they don't move at all).
    if (f.state === 'attack') {
      if (f.move !== this.lastMove || f.moveFrame < this.lastMoveFrame) this.waiting = false;
      this.lastMove = f.move;
      this.lastMoveFrame = f.moveFrame;
    } else if (f.state !== 'ground') {
      this.waiting = false;
    }
    const step = this.plan[0];
    if (!step) return 0;
    const m: MoveDef | null = sim.moveOf(f);
    if (f.state === 'attack' && m) {
      if (this.waiting) return 0;
      if (step.onHit && f.moveFrame > m.startup + m.active && !f.moveHit) return this.endPlan();
      const window = Math.min(chainWindowStart(m, step.button, f.moveHit || f.moveBlocked), totalFrames(m) - 1);
      if (f.moveFrame >= window - 2 + this.late && (!step.onHit || f.moveHit)) {
        // Weaker bots lose the thread of a string now and then.
        if (chance(this.rng, this.config.dropChance)) return this.endPlan();
        return this.tapStep(step);
      }
      return 0;
    }
    if (f.state === 'ground' || f.state === 'air' || f.state === 'block' || (f.state === 'dodge' && f.dodgeCounter)) {
      if (this.waiting && f.state !== 'dodge') {
        // The press didn't come out (string interrupted): give up on this plan.
        this.waiting = false;
        return this.endPlan();
      }
      if (this.lastMove !== null && step.button !== J && f.state === 'ground') return this.endPlan();
      return this.tapStep(step);
    }
    if (f.state === 'hitstun' || f.state === 'juggle' || f.state === 'blockstun' || f.state === 'stagger') {
      return this.endPlan();
    }
    return 0;
  }

  private tapStep(step: Step): number {
    this.plan.shift();
    this.waiting = true;
    this.stepDir = step.dir ?? 'neutral';
    this.stepDirTimer = 10;
    this.stepSwipe = step.swipe ?? 'none';
    this.late = Math.floor(nextRandom(this.rng) * (this.config.timingError + 1));
    if (this.plan.length === 0) this.cooldown = this.rollCooldown();
    return step.button;
  }

  private rollCooldown(): number {
    if (this.config.mode === 'drill') return this.drillEvery;
    const [lo, hi] = this.config.cooldown;
    return lo + Math.floor(nextRandom(this.rng) * (hi - lo + 1));
  }

  /** Drill mode: repeat `plan` (see PLANS) every `every` frames. */
  setDrill(plan: string, every: number): void {
    this.config.mode = 'drill';
    this.drillPlan = PLANS[plan] ? plan : 'haymaker';
    this.drillEvery = every;
    this.plan = [];
    this.cooldown = 60;
  }

  /** Walk into range and repeat the drill attack; no defense. Returns buttons to tap. */
  private drill(sim: Simulation, f: FighterState, target: FighterState, out: InputFrame): number {
    if (this.plan.length > 0) return this.runPlan(sim, f);
    const dist = hDistance(f.pos, target.pos);
    if (f.state !== 'ground') return 0;
    out.moveY = dist > 1.7 ? 0.8 : dist < 1.1 ? -0.5 : 0;
    if (--this.cooldown > 0 || dist > 2.2) return 0;
    this.startPlan(this.drillPlan);
    return this.runPlan(sim, f);
  }

  /** Switches difficulty, keeping the mode. */
  setLevel(level: BotLevel): void {
    this.config = { ...this.config, ...BOT_LEVELS[level] };
  }

  private endPlan(): number {
    this.plan = [];
    this.waiting = false;
    this.cooldown = Math.round(this.rollCooldown() * 0.5);
    return 0;
  }
}
