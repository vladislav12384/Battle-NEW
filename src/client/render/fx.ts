/** Hit sparks, flashes, shockwave rings, limb trails and camera shake. */
import * as THREE from 'three';

const MAX_PARTICLES = 2000;

function radialTexture(ring: boolean): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  if (ring) {
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.72, 'rgba(255,255,255,0)');
    grd.addColorStop(0.85, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
  } else {
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.8)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
  }
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface SpriteFx {
  sprite: THREE.Sprite;
  life: number;
  max: number;
  from: number;
  to: number;
}

interface Trail {
  samples: { base: THREE.Vector3; tip: THREE.Vector3; age: number }[];
  color: THREE.Color;
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  active: boolean;
}

const TRAIL_SAMPLES = 20;
const TRAIL_LIFE = 0.13;

export interface SparkOptions {
  color: number;
  count: number;
  speed: number;
  size?: number;
  life?: number;
  gravity?: number;
  /** Bias direction (unit) for the burst. */
  dir?: THREE.Vector3;
  spread?: number;
}

export class Fx {
  private readonly pos = new Float32Array(MAX_PARTICLES * 3);
  private readonly col = new Float32Array(MAX_PARTICLES * 4);
  private readonly size = new Float32Array(MAX_PARTICLES);
  private readonly vel = new Float32Array(MAX_PARTICLES * 3);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly maxLife = new Float32Array(MAX_PARTICLES);
  private readonly baseSize = new Float32Array(MAX_PARTICLES);
  private readonly grav = new Float32Array(MAX_PARTICLES);
  private next = 0;
  private readonly geo = new THREE.BufferGeometry();
  private readonly glowTex = radialTexture(false);
  private readonly ringTex = radialTexture(true);
  private readonly sprites: SpriteFx[] = [];
  private readonly trails = new Map<string, Trail>();
  private trauma = 0;
  private time = 0;

  constructor(private readonly scene: THREE.Scene) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color4', new THREE.BufferAttribute(this.col, 4));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float size;
        attribute vec4 color4;
        varying vec4 vColor;
        void main() {
          vColor = color4;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (300.0 / max(0.1, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(vColor.rgb, vColor.a * smoothstep(0.5, 0.0, d));
        }`,
    });
    const points = new THREE.Points(this.geo, mat);
    points.frustumCulled = false;
    scene.add(points);
  }

  spark(at: THREE.Vector3, o: SparkOptions): void {
    const c = new THREE.Color(o.color);
    const spread = o.spread ?? 1;
    for (let n = 0; n < o.count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX_PARTICLES;
      let dx = Math.random() * 2 - 1;
      let dy = Math.random() * 2 - 1;
      let dz = Math.random() * 2 - 1;
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l;
      dy /= l;
      dz /= l;
      if (o.dir) {
        dx = o.dir.x + dx * spread;
        dy = o.dir.y + dy * spread;
        dz = o.dir.z + dz * spread;
      }
      const sp = o.speed * (0.4 + Math.random() * 0.8);
      this.pos.set([at.x, at.y, at.z], i * 3);
      this.vel.set([dx * sp, dy * sp, dz * sp], i * 3);
      const life = (o.life ?? 0.35) * (0.6 + Math.random() * 0.6);
      this.life[i] = life;
      this.maxLife[i] = life;
      this.baseSize[i] = (o.size ?? 0.12) * (0.6 + Math.random() * 0.8);
      this.grav[i] = o.gravity ?? 6;
      this.col.set([c.r, c.g, c.b, 1], i * 4);
    }
  }

  private sprite(at: THREE.Vector3, color: number, from: number, to: number, life: number, ring: boolean): void {
    const mat = new THREE.SpriteMaterial({
      map: ring ? this.ringTex : this.glowTex,
      color,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const s = new THREE.Sprite(mat);
    s.position.copy(at);
    s.scale.setScalar(from);
    this.scene.add(s);
    this.sprites.push({ sprite: s, life, max: life, from, to });
  }

  flash(at: THREE.Vector3, color: number, size: number, life = 0.12): void {
    this.sprite(at, color, size * 0.5, size, life, false);
  }

  ring(at: THREE.Vector3, color: number, size: number, life = 0.3): void {
    this.sprite(at, color, size * 0.2, size, life, true);
  }

  /** Adds camera trauma (0..1); shake grows with trauma squared. */
  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Records a motion-trail sample for a striking limb (base/tip span the swoosh). */
  trailSample(key: string, base: THREE.Vector3, tip: THREE.Vector3, color: number): void {
    let t = this.trails.get(key);
    if (!t) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_SAMPLES * 2 * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_SAMPLES * 2 * 4), 4));
      const idx: number[] = [];
      for (let i = 0; i < TRAIL_SAMPLES - 1; i++) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      geo.setIndex(idx);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        }),
      );
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      t = { samples: [], color: new THREE.Color(color), mesh, geo, active: true };
      this.trails.set(key, t);
    }
    t.color.set(color);
    t.samples.unshift({ base: base.clone(), tip: tip.clone(), age: 0 });
    if (t.samples.length > TRAIL_SAMPLES) t.samples.length = TRAIL_SAMPLES;
  }

  /** Returns the camera shake offset for this frame. */
  update(dt: number): { x: number; y: number; roll: number } {
    this.time += dt;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) {
        this.col[i * 4 + 3] = 0;
        this.size[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      const drag = Math.exp(-dt * 4);
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.col[i * 4 + 3] = k;
      this.size[i] = this.baseSize[i] * (0.3 + 0.7 * k);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color4.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;

    for (let i = this.sprites.length - 1; i >= 0; i--) {
      const s = this.sprites[i];
      s.life -= dt;
      const t = 1 - Math.max(0, s.life / s.max);
      s.sprite.scale.setScalar(s.from + (s.to - s.from) * (1 - (1 - t) * (1 - t)));
      (s.sprite.material as THREE.SpriteMaterial).opacity = 1 - t;
      if (s.life <= 0) {
        s.sprite.removeFromParent();
        (s.sprite.material as THREE.SpriteMaterial).dispose();
        this.sprites.splice(i, 1);
      }
    }

    for (const [key, t] of this.trails) {
      for (const s of t.samples) s.age += dt;
      t.samples = t.samples.filter((s) => s.age < TRAIL_LIFE);
      const pos = t.geo.attributes.position as THREE.BufferAttribute;
      const col = t.geo.attributes.color as THREE.BufferAttribute;
      const n = t.samples.length;
      for (let i = 0; i < TRAIL_SAMPLES; i++) {
        const s = t.samples[Math.min(i, n - 1)];
        if (!s) {
          pos.setXYZ(i * 2, 0, -100, 0);
          pos.setXYZ(i * 2 + 1, 0, -100, 0);
          continue;
        }
        const a = i < n ? 0.75 * (1 - s.age / TRAIL_LIFE) * (1 - i / TRAIL_SAMPLES) : 0;
        pos.setXYZ(i * 2, s.base.x, s.base.y, s.base.z);
        pos.setXYZ(i * 2 + 1, s.tip.x, s.tip.y, s.tip.z);
        col.setXYZW(i * 2, t.color.r, t.color.g, t.color.b, a * 0.2);
        col.setXYZW(i * 2 + 1, t.color.r, t.color.g, t.color.b, a);
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
      t.mesh.visible = n > 1;
      if (n === 0 && !t.active) {
        t.mesh.removeFromParent();
        t.geo.dispose();
        this.trails.delete(key);
      }
    }

    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const s = this.trauma * this.trauma;
    const tt = this.time * 40;
    return {
      x: s * 0.06 * (Math.sin(tt * 1.1) + Math.sin(tt * 2.3) * 0.5),
      y: s * 0.06 * (Math.sin(tt * 1.7 + 1) + Math.sin(tt * 2.9) * 0.5),
      roll: s * 0.05 * Math.sin(tt * 1.3 + 2),
    };
  }
}
