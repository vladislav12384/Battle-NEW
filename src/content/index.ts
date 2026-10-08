import type { CharacterDef } from '../core/types';
import { cardCharacters } from './cards';
import { brute } from './characters/brute';
import { striker } from './characters/striker';

/** All playable / spawnable characters (and Striker with every combination of cards). Add new heroes here. */
export const CHARACTERS: Readonly<Record<string, CharacterDef>> = {
  [striker.id]: striker,
  [brute.id]: brute,
  ...cardCharacters(striker),
};

export { brute, striker };
export { CARDS, cardCharId, type CardDef, type CardRarity, sortCards, withCards } from './cards';
