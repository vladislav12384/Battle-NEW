import { describe, expect, it } from 'vitest';
import { CHARACTERS } from '../src/content';
import { validateCharacter } from '../src/content/dsl';
import { damageScaling, hitstunDecay } from '../src/core/combat';
import { Button, buffered, consume, createInputBuffer, feedInput, neutralInput, stickDir } from '../src/core/input';
import { capsuleOverlap, closestSegmentSegment } from '../src/core/math/geometry';
import { approachAngle, forwardFromYaw, localToWorld, rightFromYaw, vec3, wrapAngle, yawTo } from '../src/core/math/vec3';
import { RULES } from '../src/core/rules';

describe('vector conventions', () => {
  it('yaw 0 faces -Z with +X on the right', () => {
    const f = forwardFromYaw(0);
    const r = rightFromYaw(0);
    expect(f.z).toBeCloseTo(-1);
    expect(r.x).toBeCloseTo(1);
    const p = localToWorld(vec3(), 0, 1, 2, 3);
    expect(p.x).toBeCloseTo(1);
    expect(p.y).toBeCloseTo(2);
    expect(p.z).toBeCloseTo(-3);
  });

  it('yawTo points forward at the target', () => {
    const yaw = yawTo(vec3(0, 0, 0), vec3(5, 0, 0));
    const f = forwardFromYaw(yaw);
    expect(f.x).toBeCloseTo(1);
    expect(f.z).toBeCloseTo(0);
  });

  it('wraps and approaches angles along the short arc', () => {
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(-Math.PI);
    expect(approachAngle(3, -3, 0.5)).toBeCloseTo(-3);
    expect(approachAngle(3, -2.5, 0.2)).toBeCloseTo(wrapAngle(3.2));
  });
});

describe('geometry', () => {
  it('finds closest points between crossing segments', () => {
    const r = closestSegmentSegment(vec3(-1, 0, 0), vec3(1, 0, 0), vec3(0, 1, -1), vec3(0, 1, 1));
    expect(Math.sqrt(r.distSq)).toBeCloseTo(1);
    expect(r.c1.x).toBeCloseTo(0);
    expect(r.c2.z).toBeCloseTo(0);
  });

  it('detects capsule overlap and separation', () => {
    const body = { a: vec3(0, 0.35, 0), b: vec3(0, 1.45, 0), r: 0.35 };
    expect(capsuleOverlap(body, { a: vec3(0, 1.4, -0.6), b: vec3(0, 1.4, -0.6), r: 0.3 })).not.toBeNull();
    expect(capsuleOverlap(body, { a: vec3(0, 1.4, -0.7), b: vec3(0, 1.4, -0.7), r: 0.3 })).toBeNull();
  });
});

describe('input buffer', () => {
  it('buffers a press for RULES.inputBuffer frames', () => {
    const buf = createInputBuffer();
    feedInput(buf, { ...neutralInput(), buttons: Button.LIGHT }, false);
    expect(buffered(buf, Button.LIGHT)).toBe(true);
    for (let i = 0; i < RULES.inputBuffer; i++) feedInput(buf, neutralInput(), false);
    expect(buffered(buf, Button.LIGHT)).toBe(true);
    feedInput(buf, neutralInput(), false);
    expect(buffered(buf, Button.LIGHT)).toBe(false);
  });

  it('holding a button is not a new press, and presses are consumed once', () => {
    const buf = createInputBuffer();
    const held = { ...neutralInput(), buttons: Button.HEAVY };
    feedInput(buf, held, false);
    consume(buf, Button.HEAVY);
    feedInput(buf, held, false);
    expect(buffered(buf, Button.HEAVY)).toBe(false);
  });

  it('does not age presses during hit stop', () => {
    const buf = createInputBuffer();
    feedInput(buf, { ...neutralInput(), buttons: Button.LIGHT }, true);
    for (let i = 0; i < 30; i++) feedInput(buf, neutralInput(), true);
    expect(buffered(buf, Button.LIGHT, 0)).toBe(true);
  });

  it('reads stick directions relative to the camera', () => {
    expect(stickDir({ ...neutralInput(), moveY: 1 })).toBe('forward');
    expect(stickDir({ ...neutralInput(), moveY: -1 })).toBe('back');
    expect(stickDir({ ...neutralInput(), moveX: 1 })).toBe('right');
    expect(stickDir({ ...neutralInput(), moveX: 0.1 })).toBe('neutral');
  });
});

describe('combo limits', () => {
  it('scales damage from the 3rd hit down to a floor', () => {
    expect(damageScaling(1, 0.3)).toBe(1);
    expect(damageScaling(2, 0.3)).toBe(1);
    expect(damageScaling(3, 0.3)).toBeCloseTo(0.9);
    expect(damageScaling(6, 0.3)).toBeCloseTo(0.6);
    expect(damageScaling(40, 0.3)).toBe(0.3);
    expect(damageScaling(40, 0.5)).toBe(0.5);
  });

  it('decays hitstun in long combos', () => {
    expect(hitstunDecay(0)).toBe(1);
    expect(hitstunDecay(RULES.hitstunDecayStart)).toBe(1);
    expect(hitstunDecay(RULES.hitstunDecayStart + 60)).toBeCloseTo(1 - RULES.hitstunDecayPerSecond);
    expect(hitstunDecay(100000)).toBe(RULES.hitstunDecayMin);
  });
});

describe('content', () => {
  it('all characters pass validation', () => {
    for (const c of Object.values(CHARACTERS)) expect(validateCharacter(c), c.id).toEqual([]);
  });
});
