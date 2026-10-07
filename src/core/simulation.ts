/**
 * The authoritative, deterministic combat simulation.
 *
 *   sim.step(inputs) -> events
 *
 * Given the same starting snapshot and the same per-tick inputs the result is
 * bit-identical, which is what online co-op needs (server-authoritative or
 * rollback). Rendering, audio and UI only *read* the state and the events.
 */
import { processStrikes, resolveClashes } from './combat';
import { gravityScale, onLand, onWall, type FighterHost, updateFighter } from './fighter';
import { createFighterState, freshCombo } from './fighterUtil';
import { type InputFrame, neutralInput } from './input';
import { type Vec3 } from './math/vec3';
import { type ArenaDef, DEFAULT_ARENA, integrateBody, separateFighters } from './physics';
import { processProjectileHits, updateProjectiles } from './projectiles';
import { RULES } from './rules';
import { COMBO_STATES, type FighterState, type GameEvent, type SimState } from './state';
import type { CharacterDef, CharacterStats, CommandDef, MoveDef } from './types';

export interface SimOptions {
  arena?: ArenaDef;
  seed?: number;
  /** Revive KO'd fighters after a delay (training mode). */
  respawn?: boolean;
}

export interface AddFighterOptions {
  charId: string;
  team: number;
  pos: Vec3;
  yaw?: number;
  name?: string;
}

export type InputMap = ReadonlyMap<number, InputFrame> | Readonly<Record<number, InputFrame>>;

export class Simulation implements FighterHost {
  state: SimState;
  readonly arena: ArenaDef;
  readonly chars: Readonly<Record<string, CharacterDef>>;
  readonly respawn: boolean;
  private events: GameEvent[] = [];

  constructor(chars: Readonly<Record<string, CharacterDef>>, opts: SimOptions = {}) {
    this.chars = chars;
    this.arena = opts.arena ?? DEFAULT_ARENA;
    this.respawn = opts.respawn ?? false;
    this.state = { frame: 0, nextId: 1, rng: { seed: opts.seed ?? 1 }, fighters: [], projectiles: [] };
  }

  // ------------------------------------------------------------------ setup

  addFighter(o: AddFighterOptions): FighterState {
    const char = this.chars[o.charId];
    if (!char) throw new Error(`Unknown character "${o.charId}"`);
    const f = createFighterState(this.allocId(), o.team, o.charId, o.name ?? char.name, char.stats, o.pos, o.yaw ?? 0);
    this.state.fighters.push(f);
    return f;
  }

  removeFighter(id: number): void {
    this.state.fighters = this.state.fighters.filter((f) => f.id !== id);
    for (const f of this.state.fighters) {
      if (f.lockTarget === id) f.lockTarget = -1;
      if (f.moveTarget === id) f.moveTarget = -1;
    }
  }

  allocId(): number {
    return this.state.nextId++;
  }

  // ------------------------------------------------------------------ lookups

  fighter(id: number): FighterState | undefined {
    return this.state.fighters.find((f) => f.id === id);
  }

  charOf(f: FighterState): CharacterDef {
    return this.chars[f.charId];
  }

  statsOf(f: FighterState): CharacterStats {
    return this.chars[f.charId].stats;
  }

  moveOf(f: FighterState): MoveDef | null {
    return f.move ? (this.chars[f.charId].moves[f.move] ?? null) : null;
  }

  moveById(charId: string, id: string): MoveDef | null {
    return this.chars[charId]?.moves[id] ?? null;
  }

  charCommands(f: FighterState): CommandDef[] {
    return this.chars[f.charId].commands;
  }

  emit(e: GameEvent): void {
    this.events.push(e);
  }

  // ------------------------------------------------------------------ tick

  step(inputs: InputMap = {}): GameEvent[] {
    this.events = [];
    const st = this.state;
    st.frame++;
    const get = (id: number): InputFrame | undefined =>
      inputs instanceof Map ? inputs.get(id) : (inputs as Record<number, InputFrame>)[id];

    // Fighters frozen in hit stop at the start of the tick neither move nor hit.
    const frozen = new Set<number>();
    for (const f of st.fighters) if (f.hitstop > 0) frozen.add(f.id);

    // 1. Logic (input -> actions, timed states)
    for (const f of st.fighters) {
      updateFighter(this, f, get(f.id) ?? holdInput(f));
    }

    // 2. Physics
    for (const f of st.fighters) {
      if (frozen.has(f.id) || f.hitstop > 0) continue;
      const res = integrateBody(f, this.statsOf(f), gravityScale(this, f), this.arena);
      if (res.landed) onLand(this, f);
      if (res.wall) onWall(this, f, res.wall);
    }
    separateFighters(st.fighters, (f) => this.statsOf(f), this.arena);
    updateProjectiles(this);

    // 3. Combat
    resolveClashes(this, frozen);
    processStrikes(this, frozen);
    processProjectileHits(this);

    // 4. Bookkeeping
    for (const f of st.fighters) this.postUpdate(f);
    return this.events;
  }

  private postUpdate(f: FighterState): void {
    const stats = this.statsOf(f);
    if (f.state !== 'block' && f.state !== 'blockstun' && !f.guardBroken) {
      if (f.guardRegenDelay > 0) f.guardRegenDelay--;
      else f.guard = Math.min(stats.maxGuard, f.guard + RULES.guardRegen);
    }
    if (f.state !== 'burst' && f.state !== 'ko') f.burst = Math.min(RULES.burstMax, f.burst + RULES.burstRegen);
    if (f.combo.hits > 0 && !COMBO_STATES.has(f.state) && f.hitstop === 0) {
      const c = f.combo;
      this.emit({
        type: 'comboEnd',
        victim: f.id,
        hits: c.hits,
        damage: c.damage,
        attackers: [...c.attackers],
        trueCombo: c.trueCombo,
      });
      f.combo = freshCombo();
      f.gap = false;
    }
  }

  // ------------------------------------------------------------------ save states

  snapshot(): string {
    return JSON.stringify(this.state);
  }

  restore(snapshot: string): void {
    this.state = JSON.parse(snapshot) as SimState;
  }

  /** FNV-1a hash of the full state (desync detection). */
  hash(): number {
    const s = this.snapshot();
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
}

/** When no input arrives for a fighter, repeat its last one (minus fresh presses). */
function holdInput(f: FighterState): InputFrame {
  const last = f.lastInput ?? neutralInput(f.yaw);
  return { ...last };
}
