import type { CharacterDef } from '../core/types';
import { brute } from './characters/brute';
import { striker } from './characters/striker';

/** All playable / spawnable characters. Add new heroes here. */
export const CHARACTERS: Readonly<Record<string, CharacterDef>> = {
  [striker.id]: striker,
  [brute.id]: brute,
};

export { brute, striker };
