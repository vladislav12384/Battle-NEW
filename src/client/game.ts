/**
 * Client game: owns the simulation, the local player's input, bots, the
 * renderer and all presentation (FX, audio, HUD). Training-mode sandbox.
 */
import * as THREE from 'three';
import { CARDS, cardCharId, CHARACTERS } from '../content';
import { Bot, type BotLevel, type BotMode } from '../core/ai/bot';
import { chargeRatio } from '../core/combat';
import { type InputFrame } from '../core/input';
import { aimedPoint, chestHeight, chestPos, movePitch, moveReach, strikeLine } from '../core/moves';
import { DEG, hDistance, vec3, wrapAngle, yawFromDir, yawTo } from '../core/math/vec3';
import { DEFAULT_ARENA } from '../core/physics';
import { DT, RULES } from '../core/rules';
import { Simulation } from '../core/simulation';
import type { FighterState, GameEvent, ProjectileState } from '../core/state';
import type { MoveDef } from '../core/types';
import { Audio } from './audio';
import { Hud, type ThreatMark } from './hud';
import { Coach, moveName, nextStrikes, onBeatWindow, Tutorial } from './tutorial';
import { InputDevice } from './input';
import { FighterView, toThree } from './render/fighterView';
import { Fx } from './render/fx';
import { OpticFx } from './render/optic';
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
  drill: 'тренажёр',
};

interface ViewEntry {
  view: FighterView;
  mem: AnimMemory;
  prev: { x: number; y: number; z: number; yaw: number };
  pose: Pose | null;
  joints: Joints | null;
  /** Rendered body yaw (springy for the local player: arms trail quick flicks). */
  yaw: Spring;
  /** Wind-up glint to draw on the striking limb (enemy tells). */
  tell: { limb: string; color: number; size: number; heavy: boolean } | null;
  /** Last dash frame that left an afterimage. */
  ghostFrame: number;
  /** Squash & stretch of the whole body on impact. */
  squash: Spring;
  /** Body color (the visor glows in it unless it is Cyclops' ruby visor). */
  color: number;
  /** The recoil's floor blast of the current move has been shown. */
  opticDone: boolean;
  /** Airborne last tick (landing of a recoil). */
  wasAir: boolean;
}

interface Ghost {
  group: THREE.Group;
  mat: THREE.MeshBasicMaterial;
  t: number;
  life: number;
  opacity: number;
}

const LIMB_JOINT: Record<string, 'lHand' | 'rHand' | 'lFoot' | 'rFoot' | 'chest' | 'head'> = {
  lHand: 'lHand',
  rHand: 'rHand',
  lFoot: 'lFoot',
  rFoot: 'rFoot',
  body: 'chest',
  head: 'head',
};

const ACTIONABLE = new Set(['ground', 'air', 'block']);

export const BOT_LEVEL_LABEL: Record<BotLevel, string> = { easy: 'лёгкий', normal: 'средний', hard: 'сложный' };
const LEVELS: BotLevel[] = ['easy', 'normal', 'hard'];

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
  /** Difficulty of enemy bots. */
  level?: BotLevel;
  /** Hero card the player starts with (id from CARDS). */
  card?: string | null;
}

/** Whether a move is one of Cyclops' eye blasts (charges the visor). */
const isOptic = (m: MoveDef | null | undefined): boolean => m?.vfx === 'optic' || m?.vfx === 'opticFloor';
/** Frame on which an optic move lets the beam out. */
const opticFireFrame = (m: MoveDef): number => m.projectiles?.[0]?.frame ?? m.startup + 1;

export class Game {
  sim!: Simulation;
  readonly world: World;
  readonly fx: Fx;
  readonly optic: OpticFx;
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
    level: 'normal' as BotLevel,
    /** Next-strike hints and coach tips. */
    hints: true,
    allies: 0,
    enemies: 1,
    /** Equipped hero card (null = none). */
    card: null as string | null,
  };
  paused = true;
  private time = 0;
  private acc = 0;
  private frac = 0;
  private lastTarget = -1;
  private adv: { victim: number; kind: string; t: number; a: number; v: number } | null = null;
  private advResult: { value: number; kind: string } | null = null;
  private kick = { pitch: 0, roll: 0, yaw: 0, fov: 0, push: 0 };
  private demoBot: Bot | null = null;
  private ghosts: Ghost[] = [];
  /** Remaining seconds of an anime "impact frame" (inverted picture). */
  private impactFrame = 0;
  /** Tutorial course (null = free training). */
  tutorial: Tutorial | null = null;
  private readonly coach = new Coach();
  private tipText: string | null = null;
  /** A heavy blow is winding up at the player (from the threat indicator). */
  private threatHeavy = false;
  /** Radial impact blur: screen center (0..1) and strength, decays every frame. */
  private blur = { x: 0.5, y: 0.5, k: 0 };
  /** Brief world slow-down (perfect dodge, K.O.): seconds left and speed. */
  private dilation = { t: 0, scale: 1 };
  /** Debug/tooling hook: drives the local player with a script instead of the devices. */
  scriptedInput: ((tick: number, game: Game) => Partial<InputFrame>) | null = null;
  /** Called when the difficulty is changed in game (to remember it). */
  onLevelChange: ((level: BotLevel) => void) | null = null;
  /** Called when a card is equipped or taken off in game. */
  onCardChange: ((card: string | null) => void) | null = null;
  /** Visor charge of the local player's eyes (0..1) and the flash of a shot, for the HUD. */
  private visorCharge = 0;
  private visorFlash = 0;
  private readonly opticChars = new Map<string, boolean>();
  /** Debug/tooling hook: overrides the camera after it has been placed. */
  cameraOverride: ((camera: THREE.PerspectiveCamera, game: Game) => void) | null = null;
  private scriptTick = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    hudRoot: HTMLElement,
    private readonly opts: GameOptions = {},
  ) {
    this.world = new World(canvas, DEFAULT_ARENA);
    this.fx = new Fx(this.world.scene);
    this.optic = new OpticFx(this.world.scene, this.fx, DEFAULT_ARENA);
    this.hud = new Hud(hudRoot);
    this.input = new InputDevice(canvas);
    this.settings.thirdPerson = !!opts.thirdPerson;
    this.settings.hitboxes = !!opts.hitboxes;
    this.settings.enemies = opts.enemies ?? 1;
    this.settings.allies = opts.allies ?? 0;
    if (opts.dummyMode) this.settings.dummyMode = opts.dummyMode;
    if (opts.level) this.settings.level = opts.level;
    if (opts.card && CARDS[opts.card]) this.settings.card = opts.card;
    this.resetScenario();
    this.showCard();
    window.addEventListener('resize', () => this.world.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  // ------------------------------------------------------------------ setup

  resetScenario(): void {
    for (const v of this.views.values()) v.view.dispose();
    this.views.clear();
    this.bots.clear();
    this.sim = new Simulation(CHARACTERS, { respawn: true, seed: 1234, arena: DEFAULT_ARENA });
    const p = this.sim.addFighter({ charId: this.playerChar(), team: 0, pos: vec3(0, 0, 5), yaw: 0, name: 'You' });
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
    const bot = new Bot(f.id, { seed: 1000 + f.id * 17 });
    // Enemies use the chosen difficulty; allies are solid partners.
    bot.setLevel(enemy ? this.settings.level : 'normal');
    if (enemy) bot.setMode(this.settings.dummyMode);
    this.bots.set(f.id, bot);
  }

  /** The character the player fights as: Striker, with the equipped card plugged in. */
  private playerChar(): string {
    const c = this.settings.card;
    return c && CARDS[c] ? cardCharId('striker', [c]) : 'striker';
  }

  /**
   * Equips a hero card (null takes it off). The fight goes on: only the
   * moveset changes. `reveal` plays the card reveal.
   */
  equipCard(id: string | null, reveal = true): void {
    this.settings.card = id && CARDS[id] ? id : null;
    const me = this.player;
    if (me) me.charId = this.playerChar();
    this.showCard();
    const card = this.settings.card ? CARDS[this.settings.card] : null;
    if (card && reveal) {
      this.hud.cardReveal(card);
      this.audio.play('card');
    } else if (!card) this.hud.callout('Карта убрана', 'info');
    this.onCardChange?.(this.settings.card);
  }

  private showCard(): void {
    const card = this.settings.card ? CARDS[this.settings.card] : null;
    this.hud.buildMoveList(CHARACTERS[this.playerChar()], card);
    this.hud.cardBadge(card);
  }

  /** Starts the tutorial course from the first lesson. */
  startTutorial(): void {
    this.tutorial = new Tutorial();
    this.applyLesson();
  }

  stopTutorial(): void {
    this.tutorial = null;
    this.hud.lesson(null);
    this.resetScenario();
  }

  /** Sets up the arena and the training partner for the current lesson. */
  private applyLesson(): void {
    const t = this.tutorial;
    if (!t || t.finished) return;
    const setup = t.lesson.setup;
    this.settings.enemies = 1;
    this.settings.allies = 0;
    this.resetScenario();
    // The partner waits right in front of the player.
    const me = this.player;
    for (const f of this.sim.state.fighters) {
      if (!me || f.team !== 1) continue;
      f.pos = vec3(me.pos.x, 0, me.pos.z - 2.6);
      f.yaw = Math.PI;
    }
    if (me) me.yaw = 0;
    this.input.yaw = 0;
    this.input.pitch = 0;
    for (const [id, bot] of this.bots) {
      if (this.sim.fighter(id)?.team !== 1) continue;
      bot.setLevel(setup.real ? this.settings.level : 'normal');
      if (setup.bot === 'drill') bot.setDrill(setup.drill ?? 'haymaker', setup.drillEvery ?? 120);
      else bot.setMode(setup.bot);
    }
    this.hud.callout(t.lesson.title, 'info');
  }

  /** Lesson bookkeeping each tick. */
  private tutorialTick(events: GameEvent[]): void {
    const t = this.tutorial;
    if (!t) return;
    const me = this.player;
    const res = t.feed(events, { sim: this.sim, me: this.playerId });
    if (res === 'progress') this.audio.play('beat', 1.3);
    if (res === 'complete') {
      this.hud.callout('ОТЛИЧНО!', 'green big');
      this.audio.play('perfect');
    }
    if (t.doneFor > 100) {
      if (t.next()) this.applyLesson();
      else {
        this.hud.callout('ОБУЧЕНИЕ ПРОЙДЕНО!', 'gold big');
        this.tutorial = null;
        this.hud.lesson(null);
        return;
      }
    }
    const lesson = t.lesson;
    if (!lesson.setup.real) {
      // Practice never ends in a knockout.
      for (const f of this.sim.state.fighters) f.health = Math.max(f.health, this.sim.statsOf(f).maxHealth * 0.3);
    }
    if (lesson.setup.fullBurst && me && me.combo.hits === 0) me.burst = RULES.burstMax;
    this.hud.lesson({
      index: t.index,
      count: t.lessons.length,
      title: lesson.title,
      text: lesson.text,
      progress: t.progress,
      goal: lesson.goal,
      done: t.doneFor >= 0,
    });
  }

  /** Difficulty of enemy bots (applies to the ones already fighting too). */
  setLevel(level: BotLevel): void {
    this.settings.level = level;
    for (const [id, b] of this.bots) if (this.sim.fighter(id)?.team === 1) b.setLevel(level);
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
      case 'KeyT':
        if (this.tutorial) this.stopTutorial();
        else this.startTutorial();
        break;
      case 'Enter':
        if (this.tutorial && this.tutorial.doneFor < 0) {
          if (this.tutorial.next()) this.applyLesson();
          else this.stopTutorial();
        }
        break;
      case 'Digit9':
        this.settings.hints = !this.settings.hints;
        this.hud.callout(`Подсказки: ${this.settings.hints ? 'вкл' : 'выкл'}`, 'info');
        break;
      case 'Digit8': {
        const next = LEVELS[(LEVELS.indexOf(this.settings.level) + 1) % LEVELS.length];
        this.setLevel(next);
        this.onLevelChange?.(next);
        this.hud.callout(`Сложность: ${BOT_LEVEL_LABEL[next]}`, 'info');
        break;
      }
      case 'KeyH':
        this.hud.toggleMoveList();
        break;
      case 'KeyC':
        this.equipCard(this.settings.card ? null : Object.keys(CARDS)[0]);
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
    if (this.dilation.t > 0) this.dilation.t -= dt;
    if (!this.paused) {
      this.acc += dt * (this.settings.slowmo ? 0.25 : 1) * (this.dilation.t > 0 ? this.dilation.scale : 1);
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
          tell: null,
          ghostFrame: -1,
          squash: new Spring(0),
          color,
          opticDone: false,
          wasAir: !f.grounded,
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
      } else if (p.state === 'dodge' && p.dodgeOrbit >= 0) {
        // Circling dash: the view turns with the circle, the enemy stays in front.
        const t = sim.fighter(p.dodgeOrbit);
        const pe = this.views.get(p.id);
        const te = t ? this.views.get(t.id) : undefined;
        if (t && pe && te) this.input.yaw += wrapAngle(yawTo(p.pos, t.pos) - yawTo(pe.prev, te.prev));
      }
      if (this.settings.infiniteMeter) {
        p.meter = RULES.meterMax;
        p.burst = RULES.burstMax;
      }
    }
    this.trackAdvantage(events);
    for (const e of events) this.present(e);
    this.opticTick();
    this.tutorialTick(events);
    const tip = this.settings.hints && !this.tutorial ? this.coach.update(sim, this.player, events, this.threatHeavy) : null;
    this.tipText = tip?.text ?? null;
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
  /** World point -> screen pixels (null when behind the camera). */
  private project(p: { x: number; y: number; z: number }): { x: number; y: number } | null {
    const v = new THREE.Vector3(p.x, p.y, p.z).project(this.world.camera);
    if (v.z > 1 || v.z < -1) return null;
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
  }

  /** Where a fighter's eyes are (for the local first-person player: just under the camera). */
  private eyesOf(f: FighterState): THREE.Vector3 {
    if (f.id === this.playerId && !this.settings.thirdPerson) {
      const cam = this.world.camera;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const down = new THREE.Vector3(0, -1, 0).applyQuaternion(cam.quaternion);
      // From the bottom of the view the beam reads as a ray converging on the crosshair.
      return cam.position.clone().addScaledVector(fwd, 0.5).addScaledVector(down, 0.3);
    }
    const e = this.views.get(f.id);
    if (e?.joints) {
      const head = e.view.root.localToWorld(toThree(e.joints.head));
      return head.add(new THREE.Vector3(-Math.sin(f.yaw), 0.01, -Math.cos(f.yaw)).multiplyScalar(0.14));
    }
    return new THREE.Vector3(f.pos.x, f.pos.y + this.sim.statsOf(f).eyeHeight, f.pos.z);
  }

  /** Whether a character has Cyclops' visor (any eye-beam move). */
  private hasVisor(charId: string): boolean {
    let v = this.opticChars.get(charId);
    if (v === undefined) {
      v = Object.values(CHARACTERS[charId]?.moves ?? {}).some((m) => m.vfx === 'optic');
      this.opticChars.set(charId, v);
    }
    return v;
  }

  /** A fighter's eyes let an optic bolt out. */
  private fireBeam(p: ProjectileState, ownerId: number): void {
    const owner = this.sim.fighter(ownerId);
    const eyes = owner ? this.eyesOf(owner) : this.worldPoint(p.prevPos);
    const mine = ownerId === this.playerId;
    // Seen from our own eyes the beam is thinner: it leaves from just under the view.
    this.optic.fire(p.id, ownerId, eyes, this.worldPoint(p.pos), mine && !this.settings.thirdPerson ? 0.5 : 1);
    this.audio.play('optic', owner ? this.nearCamera(owner.pos) * 1.1 : 1);
    if (mine) {
      // The blast pushes the head back: the view kicks up, the screen flashes red.
      this.visorFlash = 0.6;
      this.hud.flash('rgba(255,70,40,1)', 0.07);
      this.kick.pitch += 0.022;
      this.kick.fov -= 4;
      this.fx.shake(0.12);
    }
    if (!mine || this.settings.thirdPerson) {
      this.fx.flash(eyes, 0xff3a24, 0.7, 0.12);
      this.fx.ring(eyes, 0xff6a50, 0.7, 0.16);
    }
  }

  /** The recoil's shot into the floor (its first active frame). */
  private floorBlast(f: FighterState, m: MoveDef): void {
    const eyes = this.eyesOf(f);
    const pitch = (m.air ? -62 : -52) * DEG;
    const dir = new THREE.Vector3(-Math.sin(f.yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(f.yaw) * Math.cos(pitch));
    const at = eyes.clone().addScaledVector(dir, Math.min(10, eyes.y / -dir.y)).setY(0);
    const back = new THREE.Vector3(Math.sin(f.yaw), 0, Math.cos(f.yaw));
    const fp = f.id === this.playerId && !this.settings.thirdPerson;
    this.optic.floorBlast(eyes, at, back, fp ? 0.45 : 1);
    this.audio.play('opticFloor', this.nearCamera(f.pos) * 1.2);
    if (f.id === this.playerId) {
      this.visorFlash = 0.6;
      this.kick.fov += 9;
      this.kick.pitch += 0.045;
      this.fx.shake(0.35);
      this.hud.flash('rgba(255,90,60,1)', 0.12);
      if (fp) this.hud.impact(window.innerWidth / 2, window.innerHeight * 0.7, 0.55, 'rgba(255,150,120,0.6)');
    } else if (hDistance(f.pos, this.world.camera.position) < 8) this.fx.shake(0.12);
  }

  /** Per-tick presentation of Cyclops' moves: floor blasts, recoil flight, landing skid. */
  private opticTick(): void {
    for (const f of this.sim.state.fighters) {
      const e = this.views.get(f.id);
      if (!e) continue;
      const m = f.state === 'attack' ? this.sim.moveOf(f) : null;
      const recoil = m?.vfx === 'opticFloor' ? m : null;
      if (recoil) {
        const fire = opticFireFrame(recoil);
        if (f.moveFrame < fire) e.opticDone = false;
        else if (!e.opticDone) {
          e.opticDone = true;
          this.floorBlast(f, recoil);
        }
        const me = f.id === this.playerId;
        const fp = me && !this.settings.thirdPerson;
        if (f.moveFrame > fire && !f.grounded) {
          // Thrown back: afterimages trail the body, our own view widens with the speed.
          if (!fp && f.moveFrame % 4 === 0) this.spawnGhost(e, 0xff5a3a, 0.3, 0.28);
          if (me) this.kick.fov = Math.max(this.kick.fov, 7);
        }
        const speed = Math.hypot(f.vel.x, f.vel.z);
        if (f.grounded && e.wasAir && f.moveFrame > fire) {
          // Touchdown: boots bite into the floor.
          const feet = new THREE.Vector3(f.pos.x, 0.06, f.pos.z);
          this.fx.spark(feet, { color: 0xa09484, count: 22, speed: 3, size: 0.2, gravity: 3, life: 0.7, dir: new THREE.Vector3(0, 0.5, 0), spread: 1 });
          this.fx.shock(feet, new THREE.Vector3(0, 1, 0), 0xc8beb0, 1.8, 0.3, 0.45);
          this.audio.play('land', this.nearCamera(f.pos) * 1.3);
          if (me) this.fx.shake(0.2);
        } else if (f.grounded && speed > 2.5 && f.moveFrame > fire) {
          const feet = new THREE.Vector3(f.pos.x, 0.05, f.pos.z);
          this.fx.spark(feet, { color: 0x9a8f86, count: 2, speed: 1.5, size: 0.18, gravity: 2, life: 0.5, dir: new THREE.Vector3(-f.vel.x / speed, 0.6, -f.vel.z / speed), spread: 0.6 });
        }
      } else e.opticDone = false;
      e.wasAir = !f.grounded;
    }
  }

  private reactToHit(victimId: number, attackerId: number, dir: { x: number; y: number; z: number }, point: { y: number }, strength: number): void {
    const v = this.sim.fighter(victimId);
    const ve = this.views.get(victimId);
    if (v && ve) {
      const c = Math.cos(v.yaw);
      const s = Math.sin(v.yaw);
      const local = { x: dir.x * c - dir.z * s, y: dir.y, z: -dir.x * s - dir.z * c };
      const high = point.y - v.pos.y > chestHeight(this.sim.statsOf(v)) - 0.05;
      hitReaction(ve.mem, local, high, strength);
      ve.squash.v += 5 * Math.min(1.6, strength);
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
        const attacker = this.sim.fighter(e.attacker);
        const optic = !!attacker && !!e.move && this.sim.moveById(attacker.charId, e.move)?.vfx === 'optic';
        const color = optic ? 0xff4a2a : e.effect === 'energy' ? 0x66ccff : e.effect === 'burst' ? 0xffffff : e.counter ? 0xff4444 : 0xffc04d;
        const dir = attacker ? new THREE.Vector3(at.x - attacker.pos.x, 0.3, at.z - attacker.pos.z).normalize() : undefined;
        const victim = this.sim.fighter(e.victim);
        const head = !!victim && e.point.y - victim.pos.y > chestHeight(this.sim.statsOf(victim)) + 0.05;
        fx.spark(at, { color, count: heavy ? 46 : 20, speed: heavy ? 10 : 6.5, size: heavy ? 0.15 : 0.1, dir, spread: 0.9 });
        fx.spark(at, { color: 0xffffff, count: 10, speed: 3.5, size: 0.08, life: 0.15 });
        // Anime hit star at the point of contact, a second one behind it on heavy blows.
        // Right in front of the camera (first person) they are scaled down so the target stays visible.
        const near = Math.min(1, Math.max(0.42, this.world.camera.position.distanceTo(at) / 2.4));
        fx.star(at, e.counter ? 0xff5050 : heavy ? 0xffe0a0 : 0xfff4d6, (heavy ? 1.5 : 0.75) * near, heavy ? 0.2 : 0.12);
        if (heavy) fx.star(at, color, 2.4 * near, 0.26);
        fx.flash(at, color, (heavy ? 1.8 : 1.0) * near);
        // Pressure wave pushed out of the hit along the knockback.
        const kdir = new THREE.Vector3(e.dir.x, e.dir.y, e.dir.z);
        if (kdir.lengthSq() < 1e-4) kdir.set(0, 0, 1);
        if (heavy || e.counter) {
          fx.shock(at, kdir, e.counter ? 0xff7070 : 0xffffff, heavy ? 2.6 : 1.8, 0.3);
          fx.shock(at.clone().addScaledVector(kdir, 0.35), kdir, color, heavy ? 1.7 : 1.2, 0.22, 0.6);
        }
        if (optic) {
          // Burnt: molten sparks thrown along the beam, a sizzle.
          fx.spark(at, { color: 0xff8a50, count: 26, speed: 7, size: 0.08, gravity: 7, dir: kdir, spread: 0.7, life: 0.55 });
          fx.shock(at, kdir, 0xff5a30, 1.9, 0.26, 0.8);
          sfx.play('sizzle', this.nearCamera(at));
        }
        if (head && (heavy || e.counter)) {
          // Spit / sweat spray flying with the blow.
          fx.spark(at, { color: 0xdcecff, count: 14, speed: 4.5, size: 0.05, gravity: 9, dir: kdir, spread: 0.5, life: 0.5 });
        }
        if (victim && victim.grounded && e.force >= 5) {
          // Feet dragged across the floor.
          const feet = new THREE.Vector3(victim.pos.x, 0.08, victim.pos.z);
          fx.spark(feet, { color: 0xa09484, count: 16, speed: 2.5, size: 0.16, gravity: 4, dir: new THREE.Vector3(-kdir.x, 0.4, -kdir.z), spread: 0.8, life: 0.55 });
          if (e.force >= 9) fx.shock(feet, new THREE.Vector3(0, 1, 0), 0xc8beb0, 1.6, 0.35, 0.5);
        }
        sfx.play(heavy ? 'hitHeavy' : 'hitLight', this.nearCamera(at) * (heavy ? 1.2 : 1));
        sfx.play(head ? 'slap' : 'thump', this.nearCamera(at) * (heavy ? 1.2 : 0.8));
        if (heavy || e.counter || e.hitstop >= 14) sfx.play('boom', this.nearCamera(at) * Math.min(1.4, e.force / 8 + 0.4));
        this.views.get(e.victim)?.view.hitFlash(heavy || optic ? 1.7 : 1, e.counter ? 0xff4a4a : optic ? 0xff6040 : 0xffd9b3);
        // Weight of the hit for presentation: knockback force, freeze length, counter.
        const power = Math.min(1.6, e.force / 10 + e.hitstop / 20 + (e.counter ? 0.5 : 0));
        const mine = e.attacker === me || e.victim === me;
        const ally = this.sim.fighter(e.attacker)?.team === 0;
        if (e.damage > 0) hud.damageNumber(e.point, e.damage, e.victim === me ? 'taken' : e.counter ? 'counter' : ally ? 'dealt' : 'taken');
        if (mine && (heavy || e.counter || e.hitstop >= 14)) {
          const sp = this.project(e.point);
          if (sp) {
            hud.impact(sp.x, sp.y, power, e.counter ? 'rgba(255,120,120,0.95)' : 'rgba(255,255,255,0.9)');
            // Radial zoom blur + chromatic split centered on the hit.
            this.blur = { x: sp.x / window.innerWidth, y: 1 - sp.y / window.innerHeight, k: Math.min(1, 0.45 + power * 0.35) };
          }
          if (e.hitstop >= 16) hud.flash('rgba(255,255,255,1)', 0.1 + power * 0.06);
        }
        if (e.attacker === me) {
          // The view pushes into a landed blow.
          this.kick.push += 0.05 * power;
          this.kick.fov -= Math.min(9, 2 + e.force * 0.5);
          this.kick.pitch -= 0.012 * power;
          // Rhythm: the crosshair pulses "now", on-beat chains tick higher and higher.
          hud.beatCue();
          if (e.rhythm > 0) {
            hud.rhythm(e.rhythm);
            sfx.play('beat', 1 + e.rhythm * 0.15);
          }
        }
        // Anime impact frame on the blows that matter.
        if ((mine && (e.counter || e.hitstop >= 18)) || (e.attacker === me && e.rhythm >= RULES.rhythm.max && heavy)) {
          this.impactFrame = 0.05;
          sfx.play('impact', power);
        }
        this.reactToHit(e.victim, e.attacker, e.dir, e.point, Math.min(1.6, e.force / 7 + e.damage / 90 + (e.counter ? 0.3 : 0)));
        if (e.victim === me) {
          hud.hurt(e.damage);
          fx.shake(heavy ? 0.6 : 0.3);
          // The head snaps the way the blow pushes it.
          const yaw = this.input.yaw;
          const side = e.dir.x * Math.cos(yaw) - e.dir.z * Math.sin(yaw);
          const back = e.dir.x * Math.sin(yaw) + e.dir.z * Math.cos(yaw);
          const k = heavy ? 1 : 0.45;
          this.kick.pitch += (0.05 + Math.max(0, back) * 0.1) * k + Math.max(0, e.dir.y) * 0.08;
          this.kick.roll -= side * 0.14 * k;
          this.kick.yaw -= side * 0.1 * k;
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
        if (e.attacker === me) hud.beatCue();
        fx.spark(at, { color: 0x66aaff, count: 14, speed: 5, size: 0.08 });
        fx.flash(at, 0x4488ff, 0.8, 0.1);
        fx.star(at, 0x8fc4ff, 0.7, 0.1);
        sfx.play('block', this.nearCamera(at));
        if (e.chip > 0 && this.sim.fighter(e.attacker)?.team === 0) hud.damageNumber(e.point, e.chip, 'chip');
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
        fx.star(at, 0xbffcff, 2.2, 0.22);
        const ap0 = this.sim.fighter(e.attacker);
        if (ap0) fx.shock(at, new THREE.Vector3(ap0.pos.x - at.x, 0, ap0.pos.z - at.z).normalize(), 0x9ffcff, 2.4, 0.32);
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
        fx.star(at, 0xffb066, 2.6, 0.25);
        sfx.play('guardBreak');
        if (e.victim === me || e.attacker === me) hud.callout('GUARD BREAK', 'orange');
        break;
      }
      case 'armor': {
        const at = this.worldPoint(e.point);
        fx.spark(at, { color: 0xffaa33, count: 20, speed: 6 });
        fx.flash(at, 0xffaa33, 1.2);
        sfx.play(e.poise ? 'poise' : 'block', 1.2);
        if (e.poise) {
          // A light strike bounced off a heavy blow's wind-up.
          if (e.attacker === me) hud.note('НЕ СБИТЬ: тяжёлый удар не прервать лёгким — уходи рывком', 'poise');
          else if (e.victim === me) hud.note('СТОЙКОСТЬ', 'poise');
          const av = this.views.get(e.attacker);
          if (av) impactRecoil(av.mem, 1.2);
        } else if (e.victim === me || e.attacker === me) hud.callout('ARMOR', 'orange');
        break;
      }
      case 'clash': {
        const at = this.worldPoint(e.point);
        fx.spark(at, { color: 0xffffff, count: 50, speed: 12, size: 0.1, life: 0.4 });
        fx.flash(at, 0xffffff, 2.4, 0.2);
        fx.ring(at, 0xffffff, 3.2, 0.3);
        fx.star(at, 0xffffff, 2.2, 0.2);
        sfx.play('clash');
        if (e.a === me || e.b === me) {
          hud.callout('CLASH!', 'white');
          fx.shake(0.3);
        }
        break;
      }
      case 'perfectDodge': {
        const v = this.views.get(e.fighter);
        if (v && (e.fighter !== me || this.settings.thirdPerson)) this.spawnGhost(v, 0x66e0ff, 0.7, 0.6);
        if (e.fighter === me) {
          hud.callout('ИДЕАЛЬНЫЙ УКЛОН', 'cyan');
          hud.note('контратакуй — враг замедлен', 'perfect');
          hud.flash('rgba(120,160,255,1)', 0.25);
          sfx.play('perfect');
          this.dilation = { t: 0.3, scale: 0.35 };
        } else if (e.attacker === me) {
          hud.callout('ТЕБЯ ОБОШЛИ', 'red');
          sfx.play('perfect', 0.6);
        }
        break;
      }
      case 'evade': {
        const f = this.sim.fighter(e.fighter);
        if (f) sfx.play('dodge', this.nearCamera(f.pos) * 1.2);
        if (e.fighter === me) hud.note('уклон', 'good');
        break;
      }
      case 'mash':
        if (e.fighter === me) {
          hud.mash();
          sfx.play('mash');
        }
        break;
      case 'attack': {
        const f = this.sim.fighter(e.fighter);
        const m = f ? this.sim.moveById(f.charId, e.move) : null;
        if (f && isOptic(m)) sfx.play('opticCharge', this.nearCamera(f.pos));
        else if (f) sfx.play(m && m.kind !== 'light' ? 'whooshHeavy' : 'whoosh', this.nearCamera(f.pos) * 0.8);
        if (e.fighter === me && m) {
          hud.strike(moveName(m.id, m.name), f?.stringPos ?? 1);
          if (f && f.rhythm === 0) hud.rhythm(0);
        }
        // Enemy tell: a glint on the striking limb as the wind-up starts.
        const pl = this.player;
        const box = m?.hitboxes.find((x) => !x.throw);
        if (f && m && box && pl && f.team !== pl.team) {
          const unblockable = !!box.hit.unblockable || !!box.hit.guardBreak;
          const heavy = m.kind !== 'light';
          const v = this.views.get(f.id);
          if (v) {
            v.tell = {
              limb: box.limb ?? 'rHand',
              color: unblockable ? 0xff3b3b : heavy ? 0xff9a3c : 0xdff3ff,
              size: heavy ? 1.1 : 0.45,
              heavy,
            };
          }
          if (heavy && hDistance(f.pos, pl.pos) < 7) sfx.play(unblockable ? 'tellHeavy' : 'tell', this.nearCamera(f.pos));
        }
        break;
      }
      case 'whiff': {
        const f = this.sim.fighter(e.fighter);
        if (f) sfx.play('miss', this.nearCamera(f.pos));
        if (e.fighter === me) hud.strikeMiss();
        break;
      }
      case 'exhausted':
        if (e.fighter === me) {
          hud.callout('EXHAUSTED', 'orange');
          sfx.play('exhausted');
        } else if (e.fighter === this.lastTarget) hud.callout('ENEMY EXHAUSTED', 'gold');
        break;
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
        this.impactFrame = 0.06;
        this.dilation = { t: 0.6, scale: 0.3 };
        hud.callout(e.fighter === me ? 'YOU WERE K.O.' : 'K.O.', 'red big');
        fx.shake(0.6);
        break;
      case 'projectile': {
        const p = this.sim.state.projectiles.find((x) => x.id === e.id);
        if (p && this.sim.moveById(p.charId, p.moveId)?.vfx === 'optic') this.fireBeam(p, e.owner);
        else sfx.play('blast', 0.8);
        break;
      }
      case 'projectileEnd': {
        const at = this.worldPoint(e.point);
        if (!this.optic.has(e.id)) {
          fx.spark(at, { color: 0x88ddff, count: 12, speed: 4, size: 0.1 });
          break;
        }
        // A beam that hit a fighter just burns out; one that hit a surface scorches it.
        const along = this.optic.direction(e.id);
        const surface = this.nearFighter(at, this.optic.ownerOf(e.id)) ? null : this.optic.surfaceAt(at);
        this.optic.end(e.id, surface?.point ?? at);
        this.optic.impact(surface?.point ?? at, surface?.normal ?? null, along);
        if (surface) sfx.play('sizzle', this.nearCamera(at) * 1.2);
        break;
      }
      case 'reflect': {
        hud.callout('REFLECT!', 'cyan');
        // A parried beam: it now leaves from the parry.
        const p = this.sim.state.projectiles.find((x) => x.id === e.id);
        if (p && this.optic.has(e.id)) this.optic.fire(p.id, e.fighter, this.worldPoint(p.pos), this.worldPoint(p.pos));
        break;
      }
      case 'respawn':
      case 'jump':
      case 'grab':
        break;
    }
  }

  /** Whether a point is on (or right next to) a fighter's body, other than `except`. */
  private nearFighter(p: { x: number; y: number; z: number }, except: number): boolean {
    return this.sim.state.fighters.some((f) => {
      if (f.id === except) return false;
      const s = this.sim.statsOf(f);
      return Math.hypot(p.x - f.pos.x, p.z - f.pos.z) < s.radius + 0.6 && p.y > f.pos.y - 0.3 && p.y < f.pos.y + s.height + 0.4;
    });
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
      // Squash on impact, stretch on the rebound (not for our own first-person body).
      const sq = fp ? 0 : Math.max(-0.12, Math.min(0.12, e.squash.step(0, dt, 22, 0.3)));
      e.view.root.scale.set(1 + sq * 0.6, 1 - sq, 1 + sq * 0.6);
      e.view.root.rotation.y = yaw;
      advanceWalk(e.mem, x, z, stats, f.running);
      const target = computeTargets(f, stats, sim.moveOf(f), e.mem, this.time, frac, fp);
      const pose = animate(e.mem, target, dt);
      if (fp) {
        // First-person viewmodel space: our own fists never fill the screen. A hand
        // close to (or behind) the eyes is pushed out of the line of sight, so a
        // wind-up cocked behind the head leaves the view and the strike sweeps back
        // in (visual only; hitboxes are unaffected).
        const eye = { x: pose.hipX, y: stats.eyeHeight + (pose.hipY - (0.95 * stats.height) / 1.8), z: pose.hipZ + Math.sin(pose.lean) * 0.55 };
        for (const hand of ['lHand', 'rHand'] as const) {
          const h = pose[hand];
          const ahead = h.z - eye.z;
          if (ahead >= 0.42) continue;
          const clear = 0.16 + (0.42 - ahead) * 0.95;
          const dx = h.x - eye.x;
          const dy = h.y - eye.y;
          const r = Math.hypot(dx, dy);
          if (r >= clear) continue;
          const k = r > 1e-3 ? clear / r : 0;
          pose[hand] = r > 1e-3 ? { x: eye.x + dx * k, y: eye.y + dy * k, z: h.z } : { x: h.x + (hand === 'lHand' ? -clear : clear), y: h.y, z: h.z };
        }
      }
      e.pose = pose;
      // Cyclops' ruby visor burns brighter as the eyes charge, flares on the shot.
      const cm = f.state === 'attack' ? sim.moveOf(f) : null;
      let charge = 0;
      if (cm && isOptic(cm)) {
        const fire = opticFireFrame(cm);
        const fr = f.moveFrame + (f.hitstop > 0 ? 0 : frac);
        charge = fr < fire ? (fr / fire) ** 1.6 : Math.max(0, 1 - (fr - fire) / 12);
      }
      if (this.hasVisor(f.charId)) e.view.setVisor(0xff2814, 1.6 + charge * 9, charge);
      else e.view.setVisor(e.color, 0.7);
      if (isMe) this.visorCharge = charge;
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
          this.fx.trailSample(`${f.id}:${limb}`, base, tip, color, !fp && sim.moveOf(f)?.kind !== 'light');
        }
      }
      if (e.tell) {
        // Wind-up glint on the limb that is about to strike.
        const at = e.view.root.localToWorld(toThree(joints[LIMB_JOINT[e.tell.limb] ?? 'rHand']));
        this.fx.flash(at, e.tell.color, e.tell.size, e.tell.heavy ? 0.28 : 0.14);
        if (e.tell.heavy) this.fx.ring(at, e.tell.color, 0.9, 0.3);
        e.tell = null;
      }
      // Dash afterimages (not for our own first-person body).
      if (f.state === 'dodge' && !fp && (f.stateFrame === 1 || f.stateFrame === 5 || f.stateFrame === 9) && e.ghostFrame !== f.stateFrame) {
        e.ghostFrame = f.stateFrame;
        this.spawnGhost(e, f.team === 0 ? 0x7fb8ff : 0xff9966, 0.32, 0.3);
      } else if (f.state !== 'dodge') e.ghostFrame = -1;
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

    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const g = this.ghosts[i];
      g.t -= dt;
      g.mat.opacity = Math.max(0, g.opacity * (g.t / g.life));
      if (g.t <= 0) {
        g.group.removeFromParent();
        g.mat.dispose();
        this.ghosts.splice(i, 1);
      }
    }

    this.world.syncProjectiles(sim, frac);
    this.world.drawDebug(sim, this.settings.hitboxes, firstPerson ? this.playerId : -1);
    const shake = this.fx.update(dt);
    this.updateCamera(me, headWorld, meJoints, shake, dt);
    this.cameraOverride?.(this.world.camera, this);
    this.trackBeams(frac);
    this.optic.update(dt, this.world.camera.position);
    // Seen from inside the visor: a red glow at the edges while the eyes charge and fire.
    this.visorFlash = Math.max(0, this.visorFlash - dt * 4);
    this.hud.visor(firstPerson && me ? Math.max(this.visorCharge * 0.6, this.visorFlash) : 0);
    const threats = me && me.state !== 'ko' ? this.computeThreats(me) : [];
    this.threatHeavy = threats.some((t) => t.kind !== 'light');
    this.hud.threats(threats);
    // Learning aids: what the next press gives, and the coach's tip.
    const next = me && (this.settings.hints || this.tutorial) ? nextStrikes(sim, me) : null;
    this.hud.nextHint(
      next?.light ? moveName(next.light) : null,
      next?.heavy ? moveName(next.heavy) : null,
      !!next?.jump,
      !!me && onBeatWindow(sim, me),
    );
    this.hud.tip(this.tipText);
    this.hud.updateEffects(dt, (p) => this.project(p), !!me?.exhausted);
    // Slowed-time tint while an enemy we perfect-dodged is exposed.
    let exposed = 0;
    for (const f of sim.state.fighters) if (me && f.team !== me.team) exposed = Math.max(exposed, f.exposed);
    this.hud.witch(Math.min(1, exposed / RULES.dodge.exposeFrames) * 0.85);
    // Anime impact frame: an inverted, high-contrast flash of the picture.
    this.impactFrame = Math.max(0, this.impactFrame - dt);
    this.blur.k = Math.max(0, this.blur.k - dt * 5.5);
    this.world.setImpact(this.blur.x, this.blur.y, this.blur.k);
    this.canvas.style.filter = this.impactFrame > 0 ? 'invert(1) grayscale(1) contrast(1.8)' : '';

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
      level: BOT_LEVEL_LABEL[this.settings.level],
      hints: this.settings.hints,
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

  /** Live beams follow their bolts; while the shooter still fires the tail stays on its eyes. */
  private trackBeams(frac: number): void {
    const sim = this.sim;
    const alive = new Set<number>();
    for (const p of sim.state.projectiles) {
      if (!this.optic.has(p.id)) continue;
      alive.add(p.id);
      const tip = new THREE.Vector3(
        p.prevPos.x + (p.pos.x - p.prevPos.x) * frac,
        p.prevPos.y + (p.pos.y - p.prevPos.y) * frac,
        p.prevPos.z + (p.pos.z - p.prevPos.z) * frac,
      );
      const owner = p.reflected ? undefined : sim.fighter(p.owner);
      const om = owner?.state === 'attack' ? sim.moveOf(owner) : null;
      const firing = !!owner && om?.vfx === 'optic' && owner.moveFrame <= opticFireFrame(om) + om.active + 1;
      this.optic.track(p.id, tip, firing && owner ? this.eyesOf(owner) : null);
    }
    this.optic.prune(alive);
  }

  private spawnGhost(e: ViewEntry, color: number, opacity: number, life: number): void {
    const g = e.view.ghost(color, opacity);
    this.world.scene.add(g.group);
    this.ghosts.push({ ...g, t: life, life, opacity });
  }

  /**
   * Incoming strikes aimed at the player: which side they come from, how
   * heavy, how close to impact, and where the attacker is if off-screen.
   */
  private computeThreats(me: FighterState): ThreatMark[] {
    const sim = this.sim;
    const cam = this.world.camera;
    const inv = cam.matrixWorldInverse;
    const out: ThreatMark[] = [];
    for (const e of sim.state.fighters) {
      if (e.team === me.team || e.state !== 'attack') continue;
      const m = sim.moveOf(e);
      const boxes = m ? m.hitboxes.filter((x) => !x.throw) : [];
      if (!m || boxes.length === 0) continue;
      const first = Math.min(...boxes.map((x) => x.frames[0]));
      if (e.moveFrame >= first) continue;
      const rush = m.motion?.some((x) => (x.fwd ?? 0) > 4) ? 3 : 0;
      if (hDistance(e.pos, me.pos) > moveReach(m) + (m.lunge ?? RULES.defaultLunge[m.kind]) + 1 + rush) continue;
      const toMe = Math.abs(wrapAngle(yawFromDir(me.pos.x - e.pos.x, me.pos.z - e.pos.z) - e.yaw));
      if (toMe > 0.7 && e.moveTarget !== me.id) continue;
      const box = boxes[0];
      const full = !!m.charge?.fullHit?.unblockable && chargeRatio(e, m) >= 1;
      const kind: ThreatMark['kind'] =
        box.hit.unblockable || box.hit.guardBreak || full ? 'unblockable' : m.kind === 'light' ? 'light' : 'heavy';
      const line = strikeLine(m);
      let from: ThreatMark['from'] = 'center';
      if (line === 'fromLeft' || line === 'fromRight') {
        // Which side of OUR view the swing starts on.
        const stats = sim.statsOf(e);
        const pitch = movePitch(e, m);
        const a = aimedPoint(e, stats, box.a, pitch);
        const b = aimedPoint(e, stats, box.b ?? box.a, pitch);
        const ca = new THREE.Vector3(a.x, a.y, a.z).applyMatrix4(inv);
        const cb = new THREE.Vector3(b.x, b.y, b.z).applyMatrix4(inv);
        from = ca.x < cb.x ? 'left' : 'right';
      } else if (line === 'overhead') from = 'top';
      else if (line === 'low' || line === 'rising') from = 'bottom';
      const c = chestPos(e, sim.statsOf(e));
      const cv = new THREE.Vector3(c.x, c.y, c.z).applyMatrix4(inv);
      const ndc = new THREE.Vector3(c.x, c.y, c.z).project(cam);
      let edge: number | null = null;
      if (cv.z > 0) edge = Math.abs(cv.x) < 0.3 ? Math.PI / 2 : cv.x > 0 ? 0.3 : Math.PI - 0.3;
      else if (Math.abs(ndc.x) > 0.95 || Math.abs(ndc.y) > 0.95) edge = Math.atan2(-ndc.y, ndc.x);
      const framesToHit = first - e.moveFrame;
      out.push({
        from,
        kind,
        progress: Math.min(1, e.moveFrame / Math.max(1, first - 1)),
        now: framesToHit >= 2 && framesToHit <= RULES.dodge.invulnStart + RULES.dodge.perfectWindow,
        edge,
      });
    }
    return out;
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
    this.kick.yaw *= decay;
    this.kick.fov *= Math.exp(-dt * 6);
    this.kick.push *= Math.exp(-dt * 10);
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
    cam.position.copy(head).addScaledVector(fwd, -0.1 + this.kick.push);
    cam.position.y += 0.06;
    cam.rotation.set(
      pitch + this.kick.pitch + shake.y - (hr.pitch - REST_HEAD.pitch) * 0.55,
      yaw + shake.x + this.kick.yaw + (hr.yaw - REST_HEAD.yaw) * 0.18,
      this.kick.roll + shake.roll - (hr.roll - REST_HEAD.roll) * 0.45,
    );
  }
}
