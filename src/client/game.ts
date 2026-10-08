/**
 * Client game: owns the simulation, the local player's input, bots, the
 * renderer and all presentation (FX, audio, HUD). Training-mode sandbox.
 */
import * as THREE from 'three';
import { CHARACTERS } from '../content';
import { Bot, type BotMode } from '../core/ai/bot';
import { type InputFrame } from '../core/input';
import { chestHeight, chestPos } from '../core/moves';
import { vec3, wrapAngle } from '../core/math/vec3';
import { DEFAULT_ARENA } from '../core/physics';
import { DT, RULES } from '../core/rules';
import { Simulation } from '../core/simulation';
import type { FighterState, GameEvent } from '../core/state';
import { Audio } from './audio';
import { Hud } from './hud';
import { InputDevice } from './input';
import { FighterView, toThree } from './render/fighterView';
import { Fx } from './render/fx';
import {
  advanceWalk,
  animate,
  type AnimMemory,
  blockReaction,
  computeTargets,
  hitReaction,
  impactRecoil,
  type Joints,
  newAnimMemory,
  type Pose,
  REST_HEAD,
  solveSkeleton,
  Spring,
} from './render/anim';
import { World } from './render/world';

const DUMMY_MODES: BotMode[] = ['fighter', 'idle', 'block', 'parry', 'dodge'];
const DUMMY_LABEL: Record<BotMode, string> = {
  fighter: 'ИИ-боец',
  idle: 'стоит',
  block: 'всегда блок',
  parry: 'парирует всё',
  dodge: 'уклоняется',
};

interface ViewEntry {
  view: FighterView;
  mem: AnimMemory;
  prev: { x: number; y: number; z: number; yaw: number };
  pose: Pose | null;
  joints: Joints | null;
  /** Rendered body yaw (springy for the local player: arms trail quick flicks). */
  yaw: Spring;
}

const ACTIONABLE = new Set(['ground', 'air', 'block']);

export interface GameOptions {
  /** The local player is driven by a bot (attract mode / screenshots). */
  demo?: boolean;
  thirdPerson?: boolean;
  hitboxes?: boolean;
  enemies?: number;
  allies?: number;
  /** Initial behaviour of enemy bots. */
  dummyMode?: BotMode;
  /** Behaviour of the demo bot driving the local player. */
  demoMode?: BotMode;
}

export class Game {
  sim!: Simulation;
  readonly world: World;
  readonly fx: Fx;
  readonly hud: Hud;
  readonly audio = new Audio();
  readonly input: InputDevice;
  playerId = -1;
  readonly bots = new Map<number, Bot>();
  private readonly views = new Map<number, ViewEntry>();
  settings = {
    hitboxes: false,
    slowmo: false,
    infiniteMeter: false,
    thirdPerson: false,
    dummyMode: 'fighter' as BotMode,
    allies: 0,
    enemies: 1,
  };
  paused = true;
  private time = 0;
  private acc = 0;
  private frac = 0;
  private lastTarget = -1;
  private adv: { victim: number; kind: string; t: number; a: number; v: number } | null = null;
  private advResult: { value: number; kind: string } | null = null;
  private kick = { pitch: 0, roll: 0, fov: 0 };
  private demoBot: Bot | null = null;
  /** Debug/tooling hook: drives the local player with a script instead of the devices. */
  scriptedInput: ((tick: number, game: Game) => Partial<InputFrame>) | null = null;
  /** Debug/tooling hook: overrides the camera after it has been placed. */
  cameraOverride: ((camera: THREE.PerspectiveCamera, game: Game) => void) | null = null;
  private scriptTick = 0;

  constructor(
    canvas: HTMLCanvasElement,
    hudRoot: HTMLElement,
    private readonly opts: GameOptions = {},
  ) {
    this.world = new World(canvas, DEFAULT_ARENA);
    this.fx = new Fx(this.world.scene);
    this.hud = new Hud(hudRoot);
    this.input = new InputDevice(canvas);
    this.settings.thirdPerson = !!opts.thirdPerson;
    this.settings.hitboxes = !!opts.hitboxes;
    this.settings.enemies = opts.enemies ?? 1;
    this.settings.allies = opts.allies ?? 0;
    if (opts.dummyMode) this.settings.dummyMode = opts.dummyMode;
    this.hud.buildMoveList(CHARACTERS.striker);
    this.resetScenario();
    window.addEventListener('resize', () => this.world.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  // ------------------------------------------------------------------ setup

  resetScenario(): void {
    for (const v of this.views.values()) v.view.dispose();
    this.views.clear();
    this.bots.clear();
    this.sim = new Simulation(CHARACTERS, { respawn: true, seed: 1234, arena: DEFAULT_ARENA });
    const p = this.sim.addFighter({ charId: 'striker', team: 0, pos: vec3(0, 0, 5), yaw: 0, name: 'You' });
    this.playerId = p.id;
    this.input.yaw = 0;
    this.input.pitch = 0;
    this.demoBot = this.opts.demo ? new Bot(p.id, { seed: 99, aggression: 0.9, mode: this.opts.demoMode ?? 'fighter' }) : null;
    for (let i = 0; i < this.settings.allies; i++) this.spawnBot(0, i);
    for (let i = 0; i < this.settings.enemies; i++) this.spawnBot(1, i);
    this.adv = null;
    this.advResult = null;
  }

  private spawnBot(team: number, index: number): void {
    const enemy = team === 1;
    const charId = enemy && index % 2 === 1 ? 'brute' : 'striker';
    const angle = (index - 0.5) * 0.8;
    const pos = enemy ? vec3(Math.sin(angle) * 3, 0, -Math.cos(angle) * 3 + 1) : vec3(-2 - index * 1.5, 0, 6);
    const f = this.sim.addFighter({
      charId,
      team,
      pos,
      yaw: enemy ? Math.PI : 0,
      name: enemy ? `${CHARACTERS[charId].name} ${index + 1}` : `Ally ${index + 1}`,
    });
    const bot = new Bot(f.id, { seed: 1000 + f.id * 17, aggression: enemy ? 0.55 : 0.7 });
    if (enemy) bot.setMode(this.settings.dummyMode);
    this.bots.set(f.id, bot);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.input.locked && !this.opts.demo) return;
    switch (e.code) {
      case 'Digit1':
        this.settings.hitboxes = !this.settings.hitboxes;
        break;
      case 'Digit2': {
        const i = DUMMY_MODES.indexOf(this.settings.dummyMode);
        this.settings.dummyMode = DUMMY_MODES[(i + 1) % DUMMY_MODES.length];
        for (const [id, b] of this.bots) if (this.sim.fighter(id)?.team === 1) b.setMode(this.settings.dummyMode);
        this.hud.callout(DUMMY_LABEL[this.settings.dummyMode], 'info');
        break;
      }
      case 'Digit3':
        this.settings.slowmo = !this.settings.slowmo;
        break;
      case 'Digit4':
        this.resetScenario();
        break;
      case 'Digit5':
        if (this.settings.allies < 3) {
          this.spawnBot(0, this.settings.allies);
          this.settings.allies++;
        }
        break;
      case 'Digit6':
        if (this.settings.enemies < 4) {
          this.spawnBot(1, this.settings.enemies);
          this.settings.enemies++;
        }
        break;
      case 'Digit7':
        this.settings.infiniteMeter = !this.settings.infiniteMeter;
        break;
      case 'KeyV':
        this.settings.thirdPerson = !this.settings.thirdPerson;
        break;
      case 'KeyH':
        this.hud.toggleMoveList();
        break;
    }
  }

  get player(): FighterState | undefined {
    return this.sim.fighter(this.playerId);
  }

  // ------------------------------------------------------------------ loop

  /** Advances real time; runs as many fixed ticks as needed. */
  frame(dtSeconds: number): void {
    const dt = Math.min(dtSeconds, 0.1);
    this.time += dt;
    if (!this.paused) {
      this.acc += dt * (this.settings.slowmo ? 0.25 : 1);
      let steps = 0;
      while (this.acc >= DT && steps < 6) {
        this.tick();
        this.acc -= DT;
        steps++;
      }
      this.frac = this.acc / DT;
    }
    this.render(dt);
  }

  private tick(): void {
    const sim = this.sim;
    for (const f of sim.state.fighters) {
      let e = this.views.get(f.id);
      if (!e) {
        const c = sim.charOf(f);
        // Enemies are tinted red so teams read at a glance in first person.
        const color = f.team === 0 ? c.color : new THREE.Color(c.color).lerp(new THREE.Color(0xd8402a), 0.85).getHex();
        const view = new FighterView(color, sim.statsOf(f));
        this.world.scene.add(view.root);
        e = {
          view,
          mem: newAnimMemory(f.id * 1.7),
          prev: { x: f.pos.x, y: f.pos.y, z: f.pos.z, yaw: f.yaw },
          pose: null,
          joints: null,
          yaw: new Spring(f.yaw),
        };
        e.mem.lastX = f.pos.x;
        e.mem.lastZ = f.pos.z;
        this.views.set(f.id, e);
      }
      e.prev = { x: f.pos.x, y: f.pos.y, z: f.pos.z, yaw: f.yaw };
    }

    const inputs: Record<number, InputFrame> = {};
    const p = this.player;
    if (p && this.scriptedInput) {
      const s = this.scriptedInput(this.scriptTick++, this);
      this.input.yaw = s.yaw ?? this.input.yaw;
      this.input.pitch = s.pitch ?? this.input.pitch;
      inputs[p.id] = { moveX: 0, moveY: 0, buttons: 0, swipe: 0, ...s, yaw: this.input.yaw, pitch: this.input.pitch };
    } else if (p) inputs[p.id] = this.demoBot ? this.demoBot.think(sim) : this.input.sample(DT);
    for (const [id, bot] of this.bots) inputs[id] = bot.think(sim);
    const events = sim.step(inputs);

    if (p) {
      // The camera belongs to the player. Only an explicit lock-on steers it.
      if (p.lockTarget >= 0) {
        this.input.yaw = p.yaw;
        this.input.pitch = p.aimPitch;
      }
      if (this.settings.infiniteMeter) {
        p.meter = RULES.meterMax;
        p.burst = RULES.burstMax;
      }
    }
    this.trackAdvantage(events);
    for (const e of events) this.present(e);
  }

  private trackAdvantage(events: GameEvent[]): void {
    for (const e of events) {
      if ((e.type === 'hit' || e.type === 'block') && e.attacker === this.playerId) {
        this.adv = { victim: e.victim, kind: e.type, t: 0, a: -1, v: -1 };
      }
    }
    const a = this.adv;
    if (!a) return;
    a.t++;
    const p = this.player;
    const v = this.sim.fighter(a.victim);
    if (!p || !v || a.t > 240) {
      this.adv = null;
      return;
    }
    if (a.a < 0 && ACTIONABLE.has(p.state)) a.a = a.t;
    if (a.v < 0 && ACTIONABLE.has(v.state)) a.v = a.t;
    if (a.a >= 0 && a.v >= 0) {
      this.advResult = { value: a.v - a.a, kind: a.kind };
      this.adv = null;
    }
  }

  // ------------------------------------------------------------------ presentation

  private worldPoint(p: { x: number; y: number; z: number }): THREE.Vector3 {
    return new THREE.Vector3(p.x, p.y, p.z);
  }

  private nearCamera(p: { x: number; z: number }): number {
    const c = this.world.camera.position;
    return Math.max(0.15, 1 - Math.hypot(p.x - c.x, p.z - c.z) / 25);
  }

  /** Physical reaction of the victim's body (and a jolt for the attacker). */
  private reactToHit(victimId: number, attackerId: number, dir: { x: number; y: number; z: number }, point: { y: number }, strength: number): void {
    const v = this.sim.fighter(victimId);
    const ve = this.views.get(victimId);
    if (v && ve) {
      const c = Math.cos(v.yaw);
      const s = Math.sin(v.yaw);
      const local = { x: dir.x * c - dir.z * s, y: dir.y, z: -dir.x * s - dir.z * c };
      const high = point.y - v.pos.y > chestHeight(this.sim.statsOf(v)) - 0.05;
      hitReaction(ve.mem, local, high, strength);
    }
    const ae = this.views.get(attackerId);
    if (ae) impactRecoil(ae.mem, strength * 0.6);
  }

  private present(e: GameEvent): void {
    const me = this.playerId;
    const fx = this.fx;
    const hud = this.hud;
    const sfx = this.audio;
    switch (e.type) {
      case 'hit': {
        const at = this.worldPoint(e.point);
        const heavy = e.effect === 'heavy' || e.effect === 'launch' || e.effect === 'spike' || e.effect === 'throw' || e.damage >= 60;
        const color = e.effect === 'energy' ? 0x66ccff : e.effect === 'burst' ? 0xffffff : e.counter ? 0xff4444 : 0xffc04d;
        const attacker = this.sim.fighter(e.attacker);
        const dir = attacker ? new THREE.Vector3(at.x - attacker.pos.x, 0.3, at.z - attacker.pos.z).normalize() : undefined;
        fx.spark(at, { color, count: heavy ? 40 : 18, speed: heavy ? 9 : 6, size: heavy ? 0.14 : 0.1, dir, spread: 0.9 });
        fx.spark(at, { color: 0xffffff, count: 8, speed: 3, size: 0.08, life: 0.15 });
        fx.flash(at, color, heavy ? 1.6 : 0.9);
        if (heavy) fx.ring(at, color, 2.2, 0.25);
        sfx.play(heavy ? 'hitHeavy' : 'hitLight', this.nearCamera(at) * (heavy ? 1.2 : 1));
        this.views.get(e.victim)?.view.hitFlash();
        this.reactToHit(e.victim, e.attacker, e.dir, e.point, Math.min(1.6, e.force / 7 + e.damage / 90 + (e.counter ? 0.3 : 0)));
        if (e.victim === me) {
          hud.hurt(e.damage);
          fx.shake(heavy ? 0.6 : 0.3);
          this.kick.pitch += heavy ? 0.12 : 0.05;
          this.kick.roll += (Math.random() - 0.5) * (heavy ? 0.12 : 0.06);
        } else if (e.attacker === me) {
          fx.shake(heavy ? 0.28 : 0.1);
          if (heavy) this.kick.fov -= 6;
          this.lastTarget = e.victim;
        }
        if (e.attacker === me || e.victim === me) {
          if (e.counter) {
            hud.callout('COUNTER', 'red');
            sfx.play('counter');
          } else if (e.punish) hud.callout('PUNISH', 'orange');
        }
        const att = this.sim.fighter(e.attacker);
        if (att?.team === 0) hud.showCombo(e.comboHits, e.comboDamage, e.trueCombo);
        break;
      }
      case 'block': {
        const at = this.worldPoint(e.point);
        fx.spark(at, { color: 0x66aaff, count: 12, speed: 5, size: 0.08 });
        fx.flash(at, 0x4488ff, 0.8, 0.1);
        sfx.play('block', this.nearCamera(at));
        const vb = this.views.get(e.victim);
        if (vb) blockReaction(vb.mem, 0.8);
        const ab = this.views.get(e.attacker);
        if (ab) impactRecoil(ab.mem, 0.6);
        if (e.victim === me) fx.shake(0.12);
        if (e.attacker === me) this.lastTarget = e.victim;
        break;
      }
      case 'parry': {
        const at = this.worldPoint(e.point);
        fx.spark(at, { color: 0x99ffff, count: 40, speed: 10, size: 0.1, life: 0.4 });
        fx.flash(at, 0xccffff, 2.2, 0.18);
        fx.ring(at, 0x88ffff, 3, 0.35);
        sfx.play('parry');
        const ap = this.views.get(e.attacker);
        if (ap) impactRecoil(ap.mem, 1.6);
        const vp = this.views.get(e.victim);
        if (vp) blockReaction(vp.mem, 0.5);
        if (e.victim === me || e.attacker === me) {
          hud.callout('PARRY!', 'cyan');
          hud.flash('rgba(200,255,255,1)', 0.25);
        }
        break;
      }
      case 'guardBreak': {
        const at = this.worldPoint(e.point);
        fx.spark(at, { color: 0xff8833, count: 50, speed: 11, size: 0.12 });
        fx.ring(at, 0xff8833, 3.5, 0.4);
        sfx.play('guardBreak');
        if (e.victim === me || e.attacker === me) hud.callout('GUARD BREAK', 'orange');
        break;
      }
      case 'armor': {
        const at = this.worldPoint(e.point);
        fx.spark(at, { color: 0xffaa33, count: 20, speed: 6 });
        fx.flash(at, 0xffaa33, 1.2);
        sfx.play('block', 1.2);
        if (e.victim === me || e.attacker === me) hud.callout('ARMOR', 'orange');
        break;
      }
      case 'clash': {
        const at = this.worldPoint(e.point);
        fx.spark(at, { color: 0xffffff, count: 50, speed: 12, size: 0.1, life: 0.4 });
        fx.flash(at, 0xffffff, 2.4, 0.2);
        fx.ring(at, 0xffffff, 3.2, 0.3);
        sfx.play('clash');
        if (e.a === me || e.b === me) {
          hud.callout('CLASH!', 'white');
          fx.shake(0.3);
        }
        break;
      }
      case 'perfectDodge':
        if (e.fighter === me) {
          hud.callout('PERFECT DODGE', 'cyan');
          hud.flash('rgba(120,160,255,1)', 0.2);
        }
        break;
      case 'attack': {
        const f = this.sim.fighter(e.fighter);
        if (f) sfx.play('whoosh', this.nearCamera(f.pos) * 0.8);
        if (e.fighter === me && f) {
          const m = this.sim.moveById(f.charId, e.move);
          if (m) hud.strike(m.name, this.input.lastSwipe.swipe);
        }
        break;
      }
      case 'feint':
        if (e.fighter === me) hud.callout('FEINT', 'white');
        break;
      case 'super': {
        const f = this.sim.fighter(e.fighter);
        if (f) {
          const at = this.worldPoint(chestPos(f, this.sim.statsOf(f)));
          fx.ring(at, 0xffdd55, 4, 0.5);
          fx.spark(at, { color: 0xffdd55, count: 60, speed: 8, life: 0.5 });
        }
        hud.callout(e.fighter === me ? 'SUPER!' : 'ENEMY SUPER!', 'gold');
        hud.flash('rgba(255,230,120,1)', 0.2);
        break;
      }
      case 'kiCancel': {
        const f = this.sim.fighter(e.fighter);
        if (f) fx.ring(this.worldPoint(chestPos(f, this.sim.statsOf(f))), 0x66ddff, 2.5, 0.3);
        if (e.fighter === me) hud.callout('KI CANCEL', 'cyan');
        break;
      }
      case 'dodge': {
        const f = this.sim.fighter(e.fighter);
        if (f) sfx.play('dodge', this.nearCamera(f.pos));
        break;
      }
      case 'tech': {
        const f = this.sim.fighter(e.fighter);
        if (f) fx.ring(this.worldPoint(chestPos(f, this.sim.statsOf(f))), 0xaaffaa, 2, 0.3);
        if (e.fighter === me || this.sim.fighter(e.fighter)?.team === 1) hud.callout(e.kind === 'throw' ? 'THROW TECH' : 'TECH', 'green');
        break;
      }
      case 'burst': {
        const at = this.worldPoint(e.point);
        fx.ring(at, 0xffffff, 8, 0.45);
        fx.ring(at, 0xffee88, 6, 0.6);
        fx.spark(at, { color: 0xffffee, count: 90, speed: 14, life: 0.5 });
        sfx.play('burst');
        hud.callout(e.fighter === me ? 'BURST!' : 'ENEMY BURST!', 'gold');
        hud.flash('rgba(255,255,255,1)', 0.35);
        fx.shake(0.5);
        break;
      }
      case 'wallSplat':
      case 'wallBounce':
      case 'groundBounce': {
        const at = this.worldPoint(e.point).add(new THREE.Vector3(0, 1, 0));
        fx.spark(at, { color: 0xbbaa99, count: 30, speed: 6, size: 0.15, gravity: 9 });
        fx.ring(at, 0xffffff, 2.5, 0.3);
        sfx.play('hitHeavy', 0.7);
        fx.shake(0.25);
        const label = e.type === 'wallSplat' ? 'WALL SPLAT' : e.type === 'wallBounce' ? 'WALL BOUNCE' : 'GROUND BOUNCE';
        if (this.lastTarget === e.fighter || e.fighter === me) hud.callout(label, 'white');
        break;
      }
      case 'knockdown': {
        const f = this.sim.fighter(e.fighter);
        if (f) fx.spark(this.worldPoint(f.pos).add(new THREE.Vector3(0, 0.2, 0)), { color: 0x999080, count: 20, speed: 4, gravity: 8 });
        sfx.play('land', 1);
        if (e.fighter === me) fx.shake(0.3);
        break;
      }
      case 'land':
        if (e.fighter === me) sfx.play('land', 0.4);
        break;
      case 'throw':
        sfx.play('hitHeavy', 1.2);
        if (e.attacker === me || e.victim === me) hud.callout('THROW', 'orange');
        break;
      case 'comboEnd':
        if (e.hits >= 2 && this.sim.fighter(e.attackers[0])?.team === 0) hud.showCombo(e.hits, e.damage, e.trueCombo);
        break;
      case 'ko':
        sfx.play('ko');
        hud.callout(e.fighter === me ? 'YOU WERE K.O.' : 'K.O.', 'red big');
        fx.shake(0.6);
        break;
      case 'projectile':
        sfx.play('blast', 0.8);
        break;
      case 'projectileEnd':
        fx.spark(this.worldPoint(e.point), { color: 0x88ddff, count: 12, speed: 4, size: 0.1 });
        break;
      case 'reflect':
        hud.callout('REFLECT!', 'cyan');
        break;
      case 'respawn':
      case 'jump':
      case 'grab':
        break;
    }
  }

  // ------------------------------------------------------------------ render

  private render(dt: number): void {
    const sim = this.sim;
    const frac = this.paused ? 1 : this.frac;
    const me = this.player;
    const firstPerson = !this.settings.thirdPerson;
    let headWorld: THREE.Vector3 | null = null;
    let meJoints: Joints | null = null;

    for (const f of sim.state.fighters) {
      const e = this.views.get(f.id);
      if (!e) continue;
      const stats = sim.statsOf(f);
      const teleported = Math.hypot(f.pos.x - e.prev.x, f.pos.z - e.prev.z) > 3;
      const k = teleported ? 1 : frac;
      const x = e.prev.x + (f.pos.x - e.prev.x) * k;
      const y = e.prev.y + (f.pos.y - e.prev.y) * k;
      const z = e.prev.z + (f.pos.z - e.prev.z) * k;
      const isMe = f.id === this.playerId;
      const fp = isMe && firstPerson;
      let yaw = e.prev.yaw + wrapAngle(f.yaw - e.prev.yaw) * k;
      if (fp) {
        // Arms trail a fast flick a little and catch up: weight, not a rigid gun model.
        yaw = e.yaw.step(e.yaw.x + wrapAngle(yaw - e.yaw.x), dt, 38, 0.8);
      } else {
        e.yaw.x = yaw;
        e.yaw.v = 0;
      }
      const jitter = f.shake > 0 ? 0.035 : 0;
      e.view.root.position.set(x + (Math.random() - 0.5) * jitter, y, z + (Math.random() - 0.5) * jitter);
      e.view.root.rotation.y = yaw;
      advanceWalk(e.mem, x, z, stats, f.running);
      const target = computeTargets(f, stats, sim.moveOf(f), e.mem, this.time, frac, fp);
      const pose = animate(e.mem, target, dt);
      if (fp) {
        // First-person viewmodel space: keep our own fists out of our face so a
        // wind-up never fills the screen (visual only; hitboxes are unaffected).
        const headZ = pose.hipZ + Math.sin(pose.lean) * 0.55;
        for (const hand of ['lHand', 'rHand'] as const) {
          const h = pose[hand];
          pose[hand] = { x: h.x, y: Math.min(h.y, stats.eyeHeight - 0.15), z: Math.max(h.z, headZ + 0.36) };
        }
      }
      e.pose = pose;
      const joints = solveSkeleton(stats, pose);
      e.joints = joints;
      e.view.update(joints, pose, fp, dt);
      e.view.root.updateMatrixWorld();

      if (pose.striking.length) {
        const color = f.team === 0 ? 0x9fd0ff : 0xffb080;
        for (const limb of pose.striking) {
          const pair =
            limb === 'lHand' ? (['lElbow', 'lHand'] as const)
            : limb === 'rHand' ? (['rElbow', 'rHand'] as const)
            : limb === 'lFoot' ? (['lKnee', 'lFoot'] as const)
            : limb === 'rFoot' ? (['rKnee', 'rFoot'] as const)
            : (['hip', 'chest'] as const);
          const base = e.view.root.localToWorld(toThree(joints[pair[0]]));
          const tip = e.view.root.localToWorld(toThree(joints[pair[1]]));
          this.fx.trailSample(`${f.id}:${limb}`, base, tip, color);
        }
      }
      if (isMe) {
        headWorld = e.view.root.localToWorld(toThree(joints.head));
        meJoints = joints;
      }
    }
    for (const [id, e] of this.views) {
      if (!sim.fighter(id)) {
        e.view.dispose();
        this.views.delete(id);
      }
    }

    this.world.syncProjectiles(sim, frac);
    this.world.drawDebug(sim, this.settings.hitboxes, firstPerson ? this.playerId : -1);
    const shake = this.fx.update(dt);
    this.updateCamera(me, headWorld, meJoints, shake, dt);
    this.cameraOverride?.(this.world.camera, this);

    // Lock-on marker and HUD target.
    const lock = me && me.lockTarget >= 0 ? sim.fighter(me.lockTarget) : undefined;
    if (lock) {
      const c = chestPos(lock, sim.statsOf(lock));
      const v = new THREE.Vector3(c.x, c.y, c.z).project(this.world.camera);
      if (v.z < 1) this.hud.setLockMarker(((v.x + 1) / 2) * window.innerWidth, ((1 - v.y) / 2) * window.innerHeight);
      else this.hud.setLockMarker(null);
    } else this.hud.setLockMarker(null);
    const target = lock ?? sim.fighter(this.lastTarget) ?? sim.state.fighters.find((f) => f.team !== 0);
    this.hud.update(sim, me, target, {
      dummyMode: DUMMY_LABEL[this.settings.dummyMode],
      hitboxes: this.settings.hitboxes,
      slowmo: this.settings.slowmo,
      infiniteMeter: this.settings.infiniteMeter,
      thirdPerson: this.settings.thirdPerson,
      allies: this.settings.allies,
      enemies: this.settings.enemies,
      advantage: this.advResult?.value ?? null,
      advantageKind: this.advResult?.kind ?? '',
    }, dt);
    this.world.render();
  }

  private updateCamera(
    me: FighterState | undefined,
    head: THREE.Vector3 | null,
    joints: Joints | null,
    shake: { x: number; y: number; roll: number },
    dt: number,
  ): void {
    const cam = this.world.camera;
    const decay = Math.exp(-dt * 8);
    this.kick.pitch *= decay;
    this.kick.roll *= decay;
    this.kick.fov *= Math.exp(-dt * 6);
    cam.fov = 90 + this.kick.fov;
    cam.updateProjectionMatrix();
    if (!me) return;
    // The view is always where the player looks (or the lock-on target).
    const yaw = this.input.yaw;
    const pitch = this.input.pitch;
    if (this.settings.thirdPerson || !head || !joints) {
      const f = this.views.get(me.id)?.view.root.position ?? new THREE.Vector3(me.pos.x, me.pos.y, me.pos.z);
      const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const dist = 3.2;
      cam.position.set(
        f.x - fwd.x * dist * Math.cos(pitch * 0.6),
        f.y + 1.9 - Math.sin(pitch * 0.6) * dist * 0.8,
        f.z - fwd.z * dist * Math.cos(pitch * 0.6),
      );
      cam.rotation.set(pitch * 0.6 - 0.18 + shake.y, yaw + shake.x, shake.roll);
      return;
    }
    // First person: the eyes ride the animated head, and the head's motion
    // relative to the guard stance (lean into a cross, twist of a hook, a hit
    // snapping the head back, tumbling through the air...) moves the view.
    const hr = joints.headRot;
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    cam.position.copy(head).addScaledVector(fwd, -0.1);
    cam.position.y += 0.06;
    cam.rotation.set(
      pitch + this.kick.pitch + shake.y - (hr.pitch - REST_HEAD.pitch) * 0.55,
      yaw + shake.x + (hr.yaw - REST_HEAD.yaw) * 0.18,
      this.kick.roll + shake.roll - (hr.roll - REST_HEAD.roll) * 0.45,
    );
  }
}
