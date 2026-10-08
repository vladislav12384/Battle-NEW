/** HTML of a hero card (start screen, in-game reveal, HUD badge). Styles: style.css, "cards". */
import type { CardDef, CardRarity } from '../content';

const RARITY: Record<CardRarity, string> = { common: 'обычная', rare: 'редкая', legendary: 'легендарная' };

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
const rgba = (c: number, a: number): string => `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;

/** Card art by card id (CSS-drawn); unknown cards get the hero's initial. */
const ART: Record<string, string> = {
  optic_blast: `
    <div class="tc-rays"></div>
    <div class="tc-cyclops">
      <div class="tc-skull"></div>
      <div class="tc-jaw"></div>
      <div class="tc-visor"><i></i></div>
    </div>
    <div class="tc-beam"></div>`,
  ricochet: `
    <div class="tc-wall top"></div>
    <div class="tc-wall bottom"></div>
    <div class="tc-visor2"><i></i></div>
    <div class="tc-target"></div>
    <div class="tc-flame"></div>
    <div class="tc-leg l1"></div>
    <div class="tc-leg l2"></div>
    <div class="tc-leg l3"></div>
    <div class="tc-spark s1"></div>
    <div class="tc-spark s2"></div>`,
  mega_beam: `
    <div class="tc-floor"></div>
    <div class="tc-glowfloor"></div>
    <div class="tc-flyer">
      <div class="tc-fhead"><i></i></div>
      <div class="tc-fbody"></div>
    </div>
    <div class="tc-mega"></div>
    <div class="tc-thrust t1"></div>
    <div class="tc-thrust t2"></div>
    <div class="tc-thrust t3"></div>`,
};
/** Extra class of the art frame by card id (its own background). */
const ART_CLASS: Record<string, string> = { ricochet: 'rico', mega_beam: 'mega' };

/** Inline style carrying the card's colors. */
export const cardStyle = (card: CardDef): string =>
  `--c:${hex(card.color)};--glow:${rgba(card.color, 0.55)};--soft:${rgba(card.color, 0.16)}`;

/** The full card: face with art, name and what it gives, plus a back for flipping. */
export function cardHtml(card: CardDef): string {
  const art = ART[card.id] ?? `<div class="tc-initial">${card.hero.slice(0, 1)}</div>`;
  return `
    <div class="tcard ${card.rarity}" data-card="${card.id}" style="${cardStyle(card)}">
      <div class="tc-in">
        <div class="tc-face">
          <div class="tc-top"><span class="tc-hero">${card.hero}</span><span class="tc-rar">${RARITY[card.rarity]}</span></div>
          <div class="tc-art ${ART_CLASS[card.id] ?? ''}">${art}</div>
          <div class="tc-name">${card.name}</div>
          <ul class="tc-lines">${card.lines.map((l) => `<li>${l}</li>`).join('')}</ul>
          ${card.flavor ? `<div class="tc-flavor">${card.flavor}</div>` : ''}
          <div class="tc-shine"></div>
        </div>
        <div class="tc-back"><div class="tc-emblem">${card.hero.slice(0, 1)}</div></div>
      </div>
    </div>`;
}

/** Compact strip for the HUD: which card is on and its keys. */
export function cardBadgeHtml(card: CardDef): string {
  return `
    <div class="tc-mini ${card.id}" style="${cardStyle(card)}"><i></i></div>
    <div class="tc-badge-text">
      <b>${card.name}</b><span>${card.hero} · <kbd>C</kbd> снять карты</span>
      <span class="keys">${card.hint}</span>
    </div>`;
}
