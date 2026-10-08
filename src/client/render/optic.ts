/**
 * Cyclops' optic effects: the eye beam, the floor blast of the recoil, the
 * ricochets and the scorch marks they leave on floors, walls and pillars.
 *
 * A beam is three layered additive tubes (white-hot core, red glow, wide haze)
 * between a tail and a tip, tapered toward the eyes. Colors go above 1 so the
 * bloom pass makes them burn. A ricochet bends at every bounce: the beam is
 * then a chain of tubes along the path, its tail following the bolt around
 * the corners. When the bolt ends, the tail runs into the tip and the beam
 * goes out.
 *
 * The visor's computed shot (the ricochet super) is drawn before it fires:
 * thin lines trace the path segment by segment, bounce points light up and a
 * reticle closes on the target.
 */
import * as THREE from 'three';
import type { ArenaDef } from '../../core/physics';
import type { Fx } from './fx';

const UP = new THREE.Vector3(0, 1, 0);
/** A beam longer than this detaches from the eyes and flies as a bolt. */
const MAX_LEN = 9;
const FADE = 0.16;
const MAX_SCORCH = 64;

const hdr = (r: number, g: number, b: number): THREE.Color => new THREE.Color().setRGB(r, g, b);
interface Layer {
  color: THREE.Color;
  r: number;
  opacity: number;
}
const LAYERS: Layer[] = [
  { color: hdr(2.4, 1.45, 1.3), r: 0.028, opacity: 1 },
  { color: hdr(1.8, 0.09, 0.04), r: 0.075, opacity: 0.8 },
  { color: hdr(0.55, 0.02, 0.01), r: 0.2, opacity: 0.35 },
];
/** The visor at full power (ricochet super): a white-gold core in a burning sheath. */
const SUPER_LAYERS: Layer[] = [
  { color: hdr(3, 2.4, 1.5), r: 0.036, opacity: 1 },
  { color: hdr(2.4, 0.55, 0.06), r: 0.095, opacity: 0.85 },
  { color: hdr(1, 0.16, 0.02), r: 0.27, opacity: 0.4 },
];
/** The held mega beam: a thick white-hot core in a wide ruby sheath. */
const MEGA_LAYERS: Layer[] = [
  { color: hdr(2.6, 1.6, 1.45), r: 0.05, opacity: 1 },
  { color: hdr(1.9, 0.1, 0.04), r: 0.12, opacity: 0.75 },
  { color: hdr(0.6, 0.02, 0.01), r: 0.28, opacity: 0.22 },
];
export type BeamStyle = 'optic' | 'super' | 'mega';
const STYLE: Record<BeamStyle, Layer[]> = { optic: LAYERS, super: SUPER_LAYERS, mega: MEGA_LAYERS };

/** Open tube, thin at the tail (y = -0.5), full width at the tip. */
const tubeGeo = new THREE.CylinderGeometry(1, 0.3, 1, 18, 1, true);
/** The same without the taper, for the middle of a bent beam. */
const pipeGeo = new THREE.CylinderGeometry(1, 1, 1, 18, 1, true);
/** Thin line of the computed path. */
const lineGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
const decalGeo = new THREE.PlaneGeometry(1, 1);
const FIRE = [0xffe08a, 0xffa040, 0xff6a20, 0xff3a10];

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Targeting reticle: a ring with four ticks. */
const reticleTexture = (): THREE.Texture =>
  canvasTexture(128, (g, s) => {
    const c = s / 2;
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineWidth = 5;
    g.beginPath();
    g.arc(c, c, s * 0.34, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 7;
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * s * 0.26, c + Math.sin(a) * s * 0.26);
      g.lineTo(c + Math.cos(a) * s * 0.47, c + Math.sin(a) * s * 0.47);
      g.stroke();
    }
  });

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
  /** Tube layers of each visible segment, tail first. */
  segs: THREE.Mesh[][];
  mats: THREE.MeshBasicMaterial[];
  layers: Layer[];
  style: BeamStyle;
  head: THREE.Sprite;
  tail: THREE.Vector3;
  tip: THREE.Vector3;
  /** Bounce points between the eyes and the tip (ricochets). */
  bends: THREE.Vector3[];
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
  /** A held stream: lit over its whole length, not just a bolt. */
  stream: boolean;
}

interface Scorch {
  dark: THREE.Mesh;
  hot: THREE.Mesh;
  t: number;
}

/** The visor's computed path, drawn before the shot. */
interface Calc {
  group: THREE.Group;
  points: THREE.Vector3[];
  lines: THREE.Mesh[];
  marks: THREE.Sprite[];
  reticle: THREE.Sprite;
  dot: THREE.Sprite;
  mat: THREE.MeshBasicMaterial;
  t: number;
  /** Seconds until the beam fires along it. */
  dur: number;
  /** Fading out (seconds left), null while it is drawn. */
  fade: number | null;
  length: number;
}

/** Visible part of a polyline: its last `len` meters, ending at the last point. */
function tailOf(points: readonly THREE.Vector3[], len: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [points[points.length - 1].clone()];
  let left = len;
  for (let i = points.length - 1; i > 0 && left > 1e-4; i--) {
    const a = points[i - 1];
    const b = points[i];
    const d = a.distanceTo(b);
    if (d <= left) {
      out.unshift(a.clone());
      left -= d;
    } else {
      out.unshift(b.clone().lerp(a, left / Math.max(d, 1e-6)));
      left = 0;
    }
  }
  return out;
}

const polyLength = (pts: readonly THREE.Vector3[]): number => {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += pts[i - 1].distanceTo(pts[i]);
  return l;
};

/** Point at distance `d` along a polyline. */
function along(pts: readonly THREE.Vector3[], d: number): THREE.Vector3 {
  let left = d;
  for (let i = 1; i < pts.length; i++) {
    const seg = pts[i - 1].distanceTo(pts[i]);
    if (left <= seg) return pts[i - 1].clone().lerp(pts[i], seg > 1e-6 ? left / seg : 0);
    left -= seg;
  }
  return pts[pts.length - 1].clone();
}

export class OpticFx {
  private readonly beams = new Map<number | string, Beam>();
  private readonly scorches: Scorch[] = [];
  private readonly calcs: Calc[] = [];
  private preview: { group: THREE.Group; lines: THREE.Mesh[]; marks: THREE.Sprite[]; mat: THREE.MeshBasicMaterial } | null = null;
  private readonly glowTex = glowTexture();
  private readonly ringTex = reticleTexture();
  private readonly scorchTex = scorchTexture();
  private readonly emberTex = emberTexture();
  private nextStatic = 0;
  private time = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly fx: Fx,
    private readonly arena: ArenaDef,
  ) {}

  private makeBeam(origin: THREE.Vector3, tip: THREE.Vector3, width: number, fixed: boolean, style: BeamStyle = 'optic'): Beam {
    const group = new THREE.Group();
    const layers = STYLE[style];
    const mats = layers.map(
      (l) =>
        new THREE.MeshBasicMaterial({
          color: l.color,
          transparent: true,
          opacity: l.opacity,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
    );
    const head = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTex,
        color: style === 'super' ? hdr(2.6, 1.2, 0.3) : hdr(2.2, 0.4, 0.25),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    group.add(head);
    this.scene.add(group);
    return {
      group,
      segs: [],
      mats,
      layers,
      style,
      head,
      tail: origin.clone(),
      tip: tip.clone(),
      bends: [],
      origin: origin.clone(),
      width,
      fade: null,
      fadeMax: FADE,
      fixed,
      owner: -1,
      stream: false,
    };
  }

  /** Tube layers for segment `i` of a beam (created on demand). */
  private segment(b: Beam, i: number): THREE.Mesh[] {
    while (b.segs.length <= i) {
      const geo = b.segs.length === 0 ? tubeGeo : pipeGeo;
      const meshes = b.mats.map((m) => {
        const mesh = new THREE.Mesh(geo, m);
        mesh.frustumCulled = false;
        b.group.add(mesh);
        return mesh;
      });
      b.segs.push(meshes);
    }
    return b.segs[i];
  }

  /** A bolt leaves `owner`'s eyes (keyed by projectile id). */
  fire(id: number, owner: number, origin: THREE.Vector3, tip: THREE.Vector3, width = 1, style: BeamStyle = 'optic'): void {
    const old = this.beams.get(id);
    if (old) this.dispose(old);
    const b = this.makeBeam(origin, tip, width, false, style);
    b.owner = owner;
    this.beams.set(id, b);
  }

  /**
   * A held beam from `origin` to `tip` this frame (keyed by its shooter).
   * Call it every frame while it fires; `endStream` lets it burn out.
   */
  stream(key: string, owner: number, origin: THREE.Vector3, tip: THREE.Vector3, width: number): void {
    let b = this.beams.get(key);
    if (!b || b.fade !== null) {
      if (b) this.dispose(b);
      b = this.makeBeam(origin, tip, width, false, 'mega');
      b.stream = true;
      b.owner = owner;
      this.beams.set(key, b);
    }
    b.origin.copy(origin);
    b.tip.copy(tip);
    b.width = width;
  }

  endStream(key: string): void {
    const b = this.beams.get(key);
    if (!b || b.fade !== null) return;
    b.fixed = true;
    b.fade = 0.22;
    b.fadeMax = 0.22;
  }

  /** Held beams not in `live` burn out (their shooter stopped or is gone). */
  pruneStreams(live: ReadonlySet<string>): void {
    for (const [key, b] of this.beams) if (b.stream && b.fade === null && typeof key === 'string' && !live.has(key)) this.endStream(key);
  }

  hasStream(key: string): boolean {
    const b = this.beams.get(key);
    return !!b && b.fade === null;
  }

  /** A ricochet bounced at `at`: the beam bends there. */
  bend(id: number, at: THREE.Vector3): void {
    const b = this.beams.get(id);
    if (b && b.fade === null) b.bends.push(at.clone());
  }

  private dispose(b: Beam): void {
    b.group.removeFromParent();
    for (const m of b.mats) m.dispose();
    (b.head.material as THREE.SpriteMaterial).dispose();
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

  /** Direction a beam travels (its last leg: eyes or last bounce to tip). */
  direction(id: number): THREE.Vector3 {
    const b = this.beams.get(id);
    const from = b ? (b.bends[b.bends.length - 1] ?? b.origin) : null;
    const d = b && from ? b.tip.clone().sub(from) : new THREE.Vector3(0, 0, -1);
    return d.lengthSq() > 1e-8 ? d.normalize() : new THREE.Vector3(0, 0, -1);
  }

  /** Style of a live beam (null when there is none). */
  styleOf(id: number): BeamStyle | null {
    return this.beams.get(id)?.style ?? null;
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

  /** A ricochet glances off a surface: a hot spark burst along the new path, a ring, a scorch. */
  ricochet(at: THREE.Vector3, normal: THREE.Vector3, out: THREE.Vector3, style: BeamStyle): void {
    const fx = this.fx;
    const hot = style === 'super';
    fx.flash(at, hot ? 0xffa040 : 0xff4a2a, hot ? 2.6 : 1.9, 0.14);
    fx.star(at, hot ? 0xffe0a0 : 0xffb090, hot ? 1.7 : 1.15, 0.13);
    fx.shock(at.clone().addScaledVector(normal, 0.03), normal, hot ? 0xffb050 : 0xff5a30, hot ? 2.4 : 1.7, 0.3, 0.9);
    // Sparks leave with the beam, molten drops fall off the wall.
    fx.spark(at, { color: hot ? 0xffd080 : 0xff8050, count: hot ? 34 : 24, speed: 11, size: 0.07, gravity: 5, life: 0.38, dir: out.clone().add(normal.clone().multiplyScalar(0.4)).normalize(), spread: 0.45 });
    fx.spark(at, { color: 0xff6a30, count: 14, speed: 4, size: 0.09, gravity: 12, life: 0.6, dir: normal, spread: 0.9 });
    if (hot) fx.spark(at, { color: FIRE[Math.floor(Math.random() * FIRE.length)], count: 12, speed: 2.2, size: 0.22, gravity: -4, life: 0.5, dir: normal, spread: 0.8 });
    this.scorch(at, normal, hot ? 1.5 : 1.15);
  }

  // ------------------------------------------------------------------ computed path

  /**
   * The visor computes the shot: thin lines run along the path segment by
   * segment, the bounce points light up, a reticle closes on the target.
   * `dur`: seconds until the beam fires.
   */
  calc(points: THREE.Vector3[], dur: number): void {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: hdr(2.2, 0.7, 0.15), transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
    const lines = points.slice(1).map(() => {
      const m = new THREE.Mesh(lineGeo, mat);
      m.frustumCulled = false;
      m.visible = false;
      group.add(m);
      return m;
    });
    const sprite = (color: THREE.Color, size: number): THREE.Sprite => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      sp.scale.setScalar(size);
      sp.visible = false;
      group.add(sp);
      return sp;
    };
    const marks = points.slice(1, -1).map((p) => {
      const sp = sprite(hdr(2.6, 1.1, 0.3), 0.45);
      sp.position.copy(p);
      return sp;
    });
    const reticle = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.ringTex, color: hdr(2.6, 0.5, 0.15), transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }),
    );
    reticle.position.copy(points[points.length - 1]);
    reticle.visible = false;
    reticle.renderOrder = 9;
    group.add(reticle);
    const dot = sprite(hdr(3, 2, 1.2), 0.22);
    this.scene.add(group);
    this.calcs.push({ group, points, lines, marks, reticle, dot, mat, t: 0, dur, fade: null, length: polyLength(points) });
  }

  /** The beam left: the computed lines go out. */
  endCalc(): void {
    for (const c of this.calcs) if (c.fade === null) c.fade = 0.25;
  }

  /**
   * Laser sight of a plain ricochet while it winds up (local player): where a
   * bank shot fired right now would go. Null hides it.
   */
  aimPreview(points: THREE.Vector3[] | null): void {
    if (!points || points.length < 2) {
      if (this.preview) this.preview.group.visible = false;
      return;
    }
    if (!this.preview) {
      const group = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: hdr(1.6, 0.12, 0.06), transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending });
      this.preview = { group, lines: [], marks: [], mat };
      this.scene.add(group);
    }
    const pv = this.preview;
    pv.group.visible = true;
    while (pv.lines.length < points.length - 1) {
      const m = new THREE.Mesh(lineGeo, pv.mat);
      m.frustumCulled = false;
      pv.group.add(m);
      pv.lines.push(m);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: hdr(2.2, 0.4, 0.2), transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
      sp.scale.setScalar(0.22);
      pv.group.add(sp);
      pv.marks.push(sp);
    }
    pv.mat.opacity = 0.32 + 0.1 * Math.sin(this.time * 30);
    pv.lines.forEach((m, i) => {
      const ok = i < points.length - 1;
      m.visible = ok;
      pv.marks[i].visible = ok && i < points.length - 2;
      if (!ok) return;
      this.placeLine(m, points[i], points[i + 1], 0.014);
      pv.marks[i].position.copy(points[i + 1]);
    });
  }

  private placeLine(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, r: number): void {
    const d = b.clone().sub(a);
    const l = d.length();
    if (l < 1e-5) {
      m.visible = false;
      return;
    }
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(UP, d.divideScalar(l));
    m.scale.set(r, l, r);
  }

  private updateCalcs(dt: number): void {
    for (let i = this.calcs.length - 1; i >= 0; i--) {
      const c = this.calcs[i];
      c.t += dt;
      if (c.fade !== null) c.fade -= dt;
      if ((c.fade !== null && c.fade <= 0) || c.t > c.dur + 1.5) {
        c.group.removeFromParent();
        c.mat.dispose();
        for (const sp of [...c.marks, c.reticle, c.dot]) (sp.material as THREE.SpriteMaterial).dispose();
        this.calcs.splice(i, 1);
        continue;
      }
      const k = c.fade !== null ? Math.max(0, c.fade / 0.25) : 1;
      // The path is traced over the first half of the wind-up, then it holds and flickers.
      const drawn = Math.min(1, c.t / Math.max(0.05, c.dur * 0.5)) * c.length;
      let acc = 0;
      c.lines.forEach((m, j) => {
        const a = c.points[j];
        const b = c.points[j + 1];
        const seg = a.distanceTo(b);
        const shown = Math.max(0, Math.min(seg, drawn - acc));
        m.visible = shown > 1e-3;
        if (m.visible) this.placeLine(m, a, a.clone().lerp(b, shown / Math.max(seg, 1e-6)), 0.026 + 0.008 * Math.sin(this.time * 40 + j));
        if (j < c.marks.length) {
          const lit = drawn >= acc + seg;
          c.marks[j].visible = lit;
          c.marks[j].scale.setScalar(0.42 + 0.14 * Math.sin(this.time * 18 + j));
          (c.marks[j].material as THREE.SpriteMaterial).opacity = k;
        }
        acc += seg;
      });
      c.mat.opacity = (0.55 + 0.35 * Math.sin(this.time * 33)) * k;
      // The reticle closes on the target once the whole path is drawn.
      const done = drawn >= c.length - 1e-3;
      c.reticle.visible = done;
      const close = Math.min(1, Math.max(0, (c.t - c.dur * 0.5) / (c.dur * 0.4)));
      c.reticle.scale.setScalar(1.6 - close * 0.9);
      (c.reticle.material as THREE.SpriteMaterial).opacity = k * (0.6 + 0.4 * Math.sin(this.time * 25));
      (c.reticle.material as THREE.SpriteMaterial).rotation = this.time * 2;
      // A bright dot runs the path, again and again.
      c.dot.visible = drawn > 0.1;
      c.dot.position.copy(along(c.points, ((c.t * 70) % c.length) * (drawn / c.length)));
      (c.dot.material as THREE.SpriteMaterial).opacity = k;
    }
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
    this.updateCalcs(dt);
    for (const [id, b] of this.beams) {
      let k = 1;
      if (b.fade !== null) {
        b.fade -= dt;
        if (b.fade <= 0) {
          this.dispose(b);
          this.beams.delete(id);
          continue;
        }
        k = b.fade / b.fadeMax;
      }
      // The path so far: eyes, every bounce, tip. Only its last stretch is lit:
      // the tail stays at the eyes while the beam is short, then trails the bolt.
      const path = [b.origin, ...b.bends, b.tip];
      const full = polyLength(path);
      if (full < 1e-4) continue;
      let len = b.stream ? full : Math.min(full, MAX_LEN * (b.style === 'super' ? 1.4 : 1));
      // Burning out: the tail runs into the tip (static beams just thin out).
      if (b.fade !== null && !b.fixed) len *= k * k;
      const vis = tailOf(path, len);
      b.tail.copy(vis[0]);
      const flicker = 0.85 + 0.15 * Math.sin(this.time * 90 + full) + 0.08 * Math.sin(this.time * 37);
      const w = b.width * flicker * (b.fade !== null ? 0.4 + 0.6 * k : 1);
      for (let j = 0; j < Math.max(b.segs.length, vis.length - 1); j++) {
        const meshes = j < vis.length - 1 ? this.segment(b, j) : b.segs[j];
        if (j >= vis.length - 1) {
          for (const m of meshes) m.visible = false;
          continue;
        }
        const a = vis[j];
        const c = vis[j + 1];
        const dir = c.clone().sub(a);
        const l = dir.length();
        const mid = a.clone().add(c).multiplyScalar(0.5);
        meshes.forEach((m, i) => {
          m.visible = l > 1e-4;
          if (!m.visible) return;
          m.position.copy(mid);
          m.quaternion.setFromUnitVectors(UP, dir.clone().divideScalar(l));
          m.scale.set(b.layers[i].r * w, Math.max(l, 1e-3), b.layers[i].r * w);
        });
      }
      b.mats.forEach((m, i) => (m.opacity = b.layers[i].opacity * k));
      b.head.position.copy(b.tip);
      b.head.scale.setScalar((b.style === 'super' ? 0.7 : 0.5) * w * (b.fade !== null ? 1 + (1 - k) * 0.8 : 1));
      const near = Math.min(1, Math.max(0, (b.tip.distanceTo(eye) - 1.2) / 2.5));
      (b.head.material as THREE.SpriteMaterial).opacity = k * near;
      // Embers peel off the beam; the super one trails fire.
      if (b.fade === null || b.fixed) {
        const at = along(vis, Math.random() * len);
        this.fx.spark(at, { color: 0xff5a30, count: 1, speed: 1.2, size: 0.07, gravity: -1.5, life: 0.35 });
        if (b.stream && Math.random() < 0.5 && len > 3) {
          // Energy rippling down the held beam (not right at the eyes: it would fill a first-person view).
          const d = b.tip.clone().sub(b.origin).normalize();
          this.fx.shock(along(vis, 2.5 + Math.random() * (len - 2.5)), d, Math.random() < 0.5 ? 0xff5030 : 0xffc0b0, 0.4 + Math.random() * 0.35, 0.16, 0.45);
        }
        if (b.style === 'super') {
          for (let n = 0; n < 2; n++) {
            const p = along(vis, Math.random() * len);
            this.fx.spark(p, { color: FIRE[Math.floor(Math.random() * FIRE.length)], count: 1, speed: 1.4, size: 0.2, gravity: -5, life: 0.4 });
          }
        }
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
