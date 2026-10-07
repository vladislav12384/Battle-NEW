/**
 * "Brute" — a heavyweight variant of the Striker built purely from data:
 * more health, more weight (flies less, falls faster), slower, and an
 * armored haymaker. Shows how enemy archetypes can be derived cheaply.
 */
import { variant } from '../dsl';
import { striker } from './striker';

export const brute = variant(striker, {
  id: 'brute',
  name: 'Brute',
  color: 0xc0392b,
  stats: {
    maxHealth: 1400,
    maxGuard: 130,
    weight: 1.4,
    radius: 0.45,
    height: 2.0,
    eyeHeight: 1.85,
    walkSpeed: 3.6,
    runSpeed: 6.5,
    jumpVelocity: 8.2,
    gravity: 30,
    airJumps: 0,
  },
  moves: {
    haymaker: { armor: { frames: [1, 16], hits: 1 }, name: 'Armored Haymaker' },
  },
});
