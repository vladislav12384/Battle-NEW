/**
 * Cyclops' optic effects: the eye beam, the floor blast of the recoil and the
 * scorch marks they leave on floors, walls and pillars.
 *
 * A beam is three layered additive tubes (white-hot core, red glow, wide haze)
 * between a tail and a tip, tapered toward the eyes. Colors go above 1 so the
 * bloom pass makes them burn. When the bolt ends, the tail runs into the tip
 * and the beam goes out.
 */
import * as THREE from 'three';
import type { ArenaDef } from '../../core/physics';
import type { Fx } from './fx';

const UP = new THREE.Vector3(0, 1, 0);
/** A beam longer than this detaches from the eyes and flies as a bolt. */
const MAX_LEN = 9;
const FADE = 0.16;
const MAX_SCORCH = 32;

const hdr = (r: number, g: number, b: number): THREE.Color => new THREE.Color().setRGB(r, g, b);
const LAYERS = [
  { color: hdr(2.4, 1.45, 1.3), r: 0.028, opacity: 1 },
  { color: hdr(1.8, 0.09, 0.04), r: 0.075, opacity: 0.8 },
  { color: hdr(0.55, 0.02, 0.01), r: 0.2, opacity: 0.35 },
];

/** Open tube, thin at the tail (y = -0.5), full width at the tip. */
const tubeGeo = new THREE.CylinderGeometry(1, 0.3, 1, 18, 1, true);
const decalGeo = new THREE.PlaneGeometry(1, 1);

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const glowTexture = (): THREE.Texture =>
  canvasTexture(128, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.2, 'rgba(255,255,255,0.75)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  });

/** Burnt mark: a dark ragged blot. */
const scorchTexture = (): THREE.Texture =>
  canvasTexture(256, (g, s) => {
    const c = s / 2;
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      const d = (0.12 + ((i * 37) % 11) / 40) * s;
      const x = c + Math.cos(a) * d * 0.6;
      const y = c + Math.sin(a) * d * 0.6;
      const r = (0.12 + ((i * 53) % 7) / 50) * s;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(14,8,6,0.55)');
      grd.addColorStop(1, 'rgba(14,8,6,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, s, s);
    }
    const core = g.createRadialGradient(c, c, 0, c, c, s * 0.3);
    core.addColorStop(0, 'rgba(6,3,2,0.95)');
    core.addColorStop(1, 'rgba(6,3,2,0)');
    g.fillStyle = core;
    g.fillRect(0, 0, s, s);
  });

/** Red-hot rim of a fresh scorch, cooling from the outside in. */
const emberTexture = (): THREE.Texture =>
  canvasTexture(256, (g, s) => {
    const c = s / 2;
    const grd = g.createRadialGradient(c, c, 0, c, c, c);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,220,180,0.9)');
    grd.addColorStop(0.55, 'rgba(255,120,60,0.45)');
    grd.addColorStop(1, 'rgba(255,60,20,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  });

interface Beam {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  mats: THREE.MeshBasicMaterial[];
  head: THREE.Sprite;
  tail: THREE.Vector3;
  tip: THREE.Vector3;
  /** Where the beam leaves the eyes (moves with the shooter while it fires). */
  origin: THREE.Vector3;
  width: number;
  /** Seconds left of the fade once the bolt is gone (null = alive). */
  fade: number | null;
  fadeMax: number;
  /** Static beams (floor blast) keep their tail at the origin and just burn out. */
  fixed: boolean;
  /** Fighter whose eyes fired it (-1 = none). */
  owner: number;
}

interface Scorch {
  dark: THREE.Mesh;
  hot: THREE.Mesh;
  t: number;
}

export class OpticFx {
  private readonly beams = new Map<number | string, Beam>();
  private readonly scorches: Scorch[] = [];
  private readonly glowTex = glowTexture();
  private readonly scorchTex = scorchTexture();
  private readonly emberTex = emberTexture();
  private nextStatic = 0;
  private time = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly fx: Fx,
    private readonly arena: ArenaDef,
  ) {}

  private makeBeam(origin: THREE.Vector3, tip: THREE.Vector3, width: number, fixed: boolean): Beam {
    const group = new THREE.Group();
    const meshes: THREE.Mesh[] = [];
    const mats: THREE.MeshBasicMaterial[] = [];
    for (const l of LAYERS) {
      const mat = new THREE.MeshBasicMaterial({
        color: l.color,
        transparent: true,
        opacity: l.opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(tubeGeo, mat);
      mesh.frustumCulled = false;
      group.add(mesh);
      meshes.push(mesh);
      mats.push(mat);
    }
    const head = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.glowTex, color: hdr(2.2, 0.4, 0.25), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    group.add(head);
    this.scene.add(group);
    return { group, meshes, mats, head, tail: origin.clone(), tip: tip.clone(), origin: origin.clone(), width, fade: null, fadeMax: FADE, fixed, owner: -1 };
  }

  /** A bolt leaves `owner`'s eyes (keyed by projectile id). */
  fire(id: number, owner: number, origin: THREE.Vector3, tip: THREE.Vector3, width = 1): void {
    this.beams.get(id)?.group.removeFromParent();
    const b = this.makeBeam(origin, tip, width, false);
    b.owner = owner;
    this.beams.set(id, b);
  }

  has(id: number): boolean {
    return this.beams.has(id);
  }

  ownerOf(id: number): number {
    return this.beams.get(id)?.owner ?? -1;
  }

  /** Moves a live bolt's tip; `origin` re-anchors the tail to the eyes while the shooter still fires. */
  track(id: number, tip: THREE.Vector3, origin: THREE.Vector3 | null): void {
    const b = this.beams.get(id);
    if (!b || b.fade !== null) return;
    b.tip.copy(tip);
    if (origin) b.origin.copy(origin);
  }

  /** The bolt is gone (hit, wall, out of range): the beam burns out at `at`. */
  end(id: number, at?: THREE.Vector3): void {
    const b = this.beams.get(id);
    if (!b || b.fade !== null) return;
    if (at) b.tip.copy(at);
    b.fade = FADE;
  }

  /** Direction a beam travels (eyes to tip). */
  direction(id: number): THREE.Vector3 {
    const b = this.beams.get(id);
    const d = b ? b.tip.clone().sub(b.origin) : new THREE.Vector3(0, 0, -1);
    return d.lengthSq() > 1e-8 ? d.normalize() : new THREE.Vector3(0, 0, -1);
  }

  /** Ends live bolts whose projectile no longer exists. */
  prune(alive: ReadonlySet<number>): void {
    for (const [id, b] of this.beams) if (typeof id === 'number' && !alive.has(id) && b.fade === null) b.fade = FADE;
  }

  /** A short static beam from the eyes to a point (the recoil's shot into the floor). */
  flashBeam(origin: THREE.Vector3, to: THREE.Vector3, width: number, life: number): void {
    const b = this.makeBeam(origin, to, width, true);
    b.fade = life;
    b.fadeMax = life;
    this.beams.set(`s${this.nextStatic++}`, b);
  }

  /**
   * The recoil: the eyes blast the floor at `at`; `back` is where the body
   * gets thrown. `k` scales the glare (smaller right under our own eyes).
   */
  floorBlast(eyes: THREE.Vector3, at: THREE.Vector3, back: THREE.Vector3, k = 1): void {
    const fx = this.fx;
    this.flashBeam(eyes, at, 1.5 * k, 0.14);
    const p = at.clone().setY(0.06);
    this.scorch(p, UP, 1.5);
    fx.flash(p.clone().setY(0.25), 0xff5a3a, 2.6 * k, 0.2);
    fx.star(p.clone().setY(0.15), 0xffc0a0, 1.7 * k, 0.16);
    fx.shock(p, UP, 0xff6a3a, 3.4, 0.42, 0.9);
    fx.shock(p.clone().setY(0.08), UP, 0xffffff, 2.0, 0.24, 0.7);
    // Molten sparks thrown forward and up, away from the body.
    const fwd = back.clone().negate().setY(0).normalize();
    fx.spark(p, { color: 0xff7040, count: 44, speed: 9, size: 0.09, gravity: 9, life: 0.6, dir: fwd.clone().add(new THREE.Vector3(0, 1.1, 0)).normalize(), spread: 0.75 });
    fx.spark(p, { color: 0xffe2c4, count: 18, speed: 13, size: 0.06, gravity: 6, life: 0.25 });
    // A ring of dust.
    fx.spark(p, { color: 0x9a8f86, count: 28, speed: 3.6, size: 0.24, gravity: 1.2, life: 0.95, dir: new THREE.Vector3(0, 0.45, 0), spread: 1.2 });
  }

  /** The bolt hit a surface: sparks off it and a scorch mark. */
  impact(at: THREE.Vector3, normal: THREE.Vector3 | null, along: THREE.Vector3): void {
    const fx = this.fx;
    fx.flash(at, 0xff4a2a, 1.6, 0.16);
    fx.star(at, 0xffb090, 1.0, 0.12);
    if (!normal) {
      fx.spark(at, { color: 0xff6a40, count: 16, speed: 5, size: 0.07, gravity: 4, life: 0.35 });
      return;
    }
    // Sparks skid off along the reflected direction.
    const refl = along.clone().reflect(normal).normalize();
    fx.spark(at, { color: 0xff7a48, count: 34, speed: 8, size: 0.08, gravity: 8, life: 0.5, dir: refl.add(normal).normalize(), spread: 0.6 });
    fx.spark(at, { color: 0xfff0e0, count: 10, speed: 10, size: 0.05, gravity: 4, life: 0.2 });
    fx.shock(at.clone().addScaledVector(normal, 0.03), normal, 0xff5a30, 1.8, 0.32, 0.85);
    this.scorch(at, normal, 1.3);
  }

  /** Which surface a point lies on (floor, wall or pillar): its normal and the point on it, or null in mid-air. */
  surfaceAt(p: THREE.Vector3): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const a = this.arena;
    if (p.y <= 0.08) return { point: new THREE.Vector3(p.x, 0.012, p.z), normal: UP.clone() };
    if (p.x >= a.halfX - 0.3) return { point: new THREE.Vector3(a.halfX - 0.01, p.y, p.z), normal: new THREE.Vector3(-1, 0, 0) };
    if (p.x <= -a.halfX + 0.3) return { point: new THREE.Vector3(-a.halfX + 0.01, p.y, p.z), normal: new THREE.Vector3(1, 0, 0) };
    if (p.z >= a.halfZ - 0.3) return { point: new THREE.Vector3(p.x, p.y, a.halfZ - 0.01), normal: new THREE.Vector3(0, 0, -1) };
    if (p.z <= -a.halfZ + 0.3) return { point: new THREE.Vector3(p.x, p.y, -a.halfZ + 0.01), normal: new THREE.Vector3(0, 0, 1) };
    for (const pl of a.pillars) {
      const dx = p.x - pl.x;
      const dz = p.z - pl.z;
      const d = Math.hypot(dx, dz);
      if (d > pl.r + 0.6 || d < 1e-6) continue;
      const n = new THREE.Vector3(dx / d, 0, dz / d);
      return { point: new THREE.Vector3(pl.x + n.x * (pl.r + 0.01), p.y, pl.z + n.z * (pl.r + 0.01)), normal: n };
    }
    return null;
  }

  /** A burn mark on a surface: red-hot at first, cooling to a dark blot that fades. */
  scorch(at: THREE.Vector3, normal: THREE.Vector3, size: number): void {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.random() * Math.PI * 2));
    const layer = (map: THREE.Texture, hot: boolean): THREE.Mesh => {
      const mat = new THREE.MeshBasicMaterial({
        map,
        color: hot ? hdr(4, 1.1, 0.4) : 0xffffff,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: hot ? -3 : -2,
        polygonOffsetUnits: hot ? -3 : -2,
        blending: hot ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      const m = new THREE.Mesh(decalGeo, mat);
      m.quaternion.copy(q);
      m.position.copy(at).addScaledVector(normal, hot ? 0.006 : 0.004);
      m.scale.setScalar(hot ? size * 0.85 : size);
      this.scene.add(m);
      return m;
    };
    this.scorches.push({ dark: layer(this.scorchTex, false), hot: layer(this.emberTex, true), t: 0 });
    while (this.scorches.length > MAX_SCORCH) this.dropScorch(0);
  }

  private dropScorch(i: number): void {
    const s = this.scorches[i];
    for (const m of [s.dark, s.hot]) {
      m.removeFromParent();
      (m.material as THREE.Material).dispose();
    }
    this.scorches.splice(i, 1);
  }

  /** `eye`: the camera; glows right in front of it are faded so they never fill the view. */
  update(dt: number, eye: THREE.Vector3): void {
    this.time += dt;
    for (const [id, b] of this.beams) {
      let k = 1;
      if (b.fade !== null) {
        b.fade -= dt;
        if (b.fade <= 0) {
          b.group.removeFromParent();
          for (const m of b.mats) m.dispose();
          (b.head.material as THREE.SpriteMaterial).dispose();
          this.beams.delete(id);
          continue;
        }
        k = b.fade / b.fadeMax;
      }
      // Tail: at the eyes while the beam is short, then it trails the bolt.
      const dir = b.tip.clone().sub(b.origin);
      const full = dir.length();
      if (full < 1e-4) continue;
      dir.divideScalar(full);
      let len = Math.min(full, MAX_LEN);
      // Burning out: the tail runs into the tip (static beams just thin out).
      if (b.fade !== null && !b.fixed) len *= k * k;
      b.tail.copy(b.tip).addScaledVector(dir, -len);
      const flicker = 0.85 + 0.15 * Math.sin(this.time * 90 + full) + 0.08 * Math.sin(this.time * 37);
      const w = b.width * flicker * (b.fade !== null ? 0.4 + 0.6 * k : 1);
      const mid = b.tail.clone().add(b.tip).multiplyScalar(0.5);
      b.meshes.forEach((m, i) => {
        m.position.copy(mid);
        m.quaternion.setFromUnitVectors(UP, dir);
        m.scale.set(LAYERS[i].r * w, Math.max(len, 1e-3), LAYERS[i].r * w);
        b.mats[i].opacity = LAYERS[i].opacity * k;
      });
      b.head.position.copy(b.tip);
      b.head.scale.setScalar(0.5 * w * (b.fade !== null ? 1 + (1 - k) * 0.8 : 1));
      const near = Math.min(1, Math.max(0, (b.tip.distanceTo(eye) - 1.2) / 2.5));
      (b.head.material as THREE.SpriteMaterial).opacity = k * near;
      // Embers peel off the beam.
      if (b.fade === null || b.fixed) {
        const at = b.tail.clone().lerp(b.tip, Math.random());
        this.fx.spark(at, { color: 0xff5a30, count: 1, speed: 1.2, size: 0.07, gravity: -1.5, life: 0.35 });
      }
    }
    for (let i = this.scorches.length - 1; i >= 0; i--) {
      const s = this.scorches[i];
      s.t += dt;
      const hot = Math.max(0, 1 - s.t / 2.4);
      (s.hot.material as THREE.MeshBasicMaterial).opacity = hot ** 1.5;
      s.hot.visible = hot > 0;
      (s.dark.material as THREE.MeshBasicMaterial).opacity = Math.min(1, s.t * 6) * Math.max(0, Math.min(1, (9 - s.t) / 2));
      if (s.t > 9) this.dropScorch(i);
    }
  }
}
