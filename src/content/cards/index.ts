/**
 * Ability cards. A card is a piece of a hero (Cyclops' optic blast, Wolverine's
 * claws...) that plugs into a character: new moves, base moves it takes over,
 * extra commands. Cards of one hero form a set.
 *
 * A character with cards is an ordinary CharacterDef (see withCards), so the
 * simulation needs no notion of cards at all.
 */
import type { CharacterDef, CommandDef, MoveDef } from '../../core/types';
import { megaBeam, opticBlast, ricochet } from './cyclops';

export type CardRarity = 'common' | 'rare' | 'legendary';

export interface CardDef {
  id: string;
  /** Display name. */
  name: string;
  /** Hero the card comes from (cards of one hero form a set). */
  hero: string;
  rarity: CardRarity;
  /** Accent color of the card frame and of its effects. */
  color: number;
  /** What the card gives, one line each (HTML, keys as <kbd>). */
  lines: string[];
  /** One-line key reminder for the HUD (HTML). */
  hint: string;
  flavor?: string;
  moves: MoveDef[];
  /** Base moves the card takes over: every command that gave `from` now gives `to`. */
  swap?: Record<string, string>;
  /** Extra commands, checked before the character's own (first match wins). */
  commands?: CommandDef[];
  /**
   * Base moves the card only re-animates: same move, same frame data and
   * hitboxes, a new choreography (`anim`) and effects (`vfx`).
   */
  restyle?: Record<string, Pick<MoveDef, 'anim' | 'vfx'>>;
}

/** Every card, in a fixed order (character ids list cards in this order). */
export const CARDS: Readonly<Record<string, CardDef>> = {
  [opticBlast.id]: opticBlast,
  [ricochet.id]: ricochet,
  [megaBeam.id]: megaBeam,
};

/** Card ids in the canonical order of CARDS. */
export const sortCards = (ids: readonly string[]): string[] => Object.keys(CARDS).filter((id) => ids.includes(id));

/** Id of a character carrying cards: "striker+optic_blast" (cards in the order of CARDS). */
export const cardCharId = (base: string, cards: readonly string[]): string => [base, ...sortCards(cards)].join('+');

/** `base` with the cards plugged in. */
export function withCards(base: CharacterDef, cards: readonly CardDef[]): CharacterDef {
  if (cards.length === 0) return base;
  const moves: Record<string, MoveDef> = { ...base.moves };
  const swap: Record<string, string> = {};
  const extra: CommandDef[] = [];
  for (const card of cards) {
    for (const m of card.moves) {
      if (moves[m.id]) throw new Error(`Card ${card.id}: move id ${m.id} already exists`);
      moves[m.id] = m;
    }
    for (const [id, style] of Object.entries(card.restyle ?? {})) {
      if (!moves[id]) throw new Error(`Card ${card.id}: restyle of missing move ${id}`);
      moves[id] = { ...moves[id], ...style };
    }
    Object.assign(swap, card.swap);
    extra.push(...(card.commands ?? []));
  }
  return {
    ...base,
    id: cardCharId(base.id, cards.map((c) => c.id)),
    moves,
    commands: [...extra, ...base.commands.map((c) => (swap[c.move] ? { ...c, move: swap[c.move] } : c))],
  };
}

/** Every version of `base` with any combination of cards, keyed by character id (to register with a Simulation). */
export function cardCharacters(base: CharacterDef): Record<string, CharacterDef> {
  const out: Record<string, CharacterDef> = {};
  const all = Object.values(CARDS);
  for (let mask = 1; mask < 1 << all.length; mask++) {
    const c = withCards(base, all.filter((_, i) => mask & (1 << i)));
    out[c.id] = c;
  }
  return out;
}

export { megaBeam, opticBlast, ricochet };
