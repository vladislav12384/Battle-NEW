/**
 * Ability cards. A card is a piece of a hero (Cyclops' optic blast, Wolverine's
 * claws...) that plugs into a character: new moves, base moves it takes over,
 * extra commands. Cards of one hero form a set.
 *
 * A character with cards is an ordinary CharacterDef (see withCards), so the
 * simulation needs no notion of cards at all.
 */
import type { CharacterDef, CommandDef, MoveDef } from '../../core/types';
import { opticBlast } from './cyclops';

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
}

export const CARDS: Readonly<Record<string, CardDef>> = {
  [opticBlast.id]: opticBlast,
};

/** Id of a character carrying cards: "striker+optic_blast". */
export const cardCharId = (base: string, cards: readonly string[]): string => [base, ...cards].join('+');

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

/** Every single-card version of `base`, keyed by character id (to register with a Simulation). */
export function cardCharacters(base: CharacterDef): Record<string, CharacterDef> {
  const out: Record<string, CharacterDef> = {};
  for (const card of Object.values(CARDS)) {
    const c = withCards(base, [card]);
    out[c.id] = c;
  }
  return out;
}

export { opticBlast };
