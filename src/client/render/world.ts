/** Scene setup: renderer, arena geometry, lights, projectiles and the hitbox debug overlay. */
import * as THREE from 'three';
import { invulnerability } from '../../core/fighterUtil';
import { hitboxCapsule, hurtCapsule, inFrames, movePitch } from '../../core/moves';
import type { ArenaDef } from '../../core/physics';
import type { Simulation } from '../../core/simulation';

function gridTexture(base: string, line: string, accent: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = line;
  g.lineWidth = 2;
  for (let i = 0; i <= 256; i += 64) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 256);
    g.moveTo(0, i);
    g.lineTo(256, i);
    g.stroke();
  }
  g.strokeStyle = accent;
  g.lineWidth = 4;
  g.strokeRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const capsuleCache = new Map<string, THREE.BufferGeometry>();
function capsuleGeo(r: number, len: number): THREE.BufferGeometry {
  const key = `${r.toFixed(2)}:${len.toFixed(2)}`;
  let g = capsuleCache.get(key);
  if (!g) {
    g = new THREE.CapsuleGeometry(r, Math.max(0.001, len), 4, 10);
    capsuleCache.set(key, g);
  }
  return g;
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly projectiles = new Map<number, THREE.Object3D>();
  private readonly debug = new THREE.Group();
  private readonly debugPool: THREE.Mesh[] = [];
  private readonly debugMats = {
    hurt: new THREE.MeshBasicMaterial({ color: 0x33ff88, wireframe: true, transparent: true, opacity: 0.5 }),
    invuln: new THREE.MeshBasicMaterial({ color: 0x55aaff, wireframe: true, transparent: true, opacity: 0.6 }),
    armor: new THREE.MeshBasicMaterial({ color: 0xffaa22, wireframe: true, transparent: true, opacity: 0.8 }),
    hit: new THREE.MeshBasicMaterial({ color: 0xff2244, wireframe: true }),
    grab: new THREE.MeshBasicMaterial({ color: 0xff44ff, wireframe: true }),
    upcoming: new THREE.MeshBasicMaterial({ color: 0xffee55, wireframe: true, transparent: true, opacity: 0.25 }),
  };

  constructor(canvas: HTMLCanvasElement, arena: ArenaDef) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    this.camera = new THREE.PerspectiveCamera(80, 1, 0.04, 300);
    this.camera.rotation.order = 'YXZ';

    this.scene.background = new THREE.Color(0x1a2233);
    this.scene.fog = new THREE.Fog(0x1a2233, 30, 90);
    this.scene.add(new THREE.HemisphereLight(0xd6e6ff, 0x3a3228, 1.5));
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    sun.position.set(8, 18, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -arena.halfX - 2;
    sc.right = arena.halfX + 2;
    sc.top = arena.halfZ + 2;
    sc.bottom = -arena.halfZ - 2;
    sc.near = 1;
    sc.far = 50;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);

    this.buildArena(arena);
    this.scene.add(this.debug);
    this.resize();
  }

  private buildArena(arena: ArenaDef): void {
    const floorTex = gridTexture('#353d50', '#465068', '#64729a');
    floorTex.repeat.set(arena.halfX / 2, arena.halfZ / 2);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(arena.halfX * 2, arena.halfZ * 2),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.85 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Center ring marking.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.9, 4.0, 64),
      new THREE.MeshBasicMaterial({ color: 0x6f7fa8, transparent: true, opacity: 0.5 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.005;
    this.scene.add(ring);

    const wallTex = gridTexture('#323a4f', '#46506a', '#5d6a8c');
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9, transparent: true, opacity: 0.92 });
    const h = arena.wallHeight;
    const walls: [number, number, number, number][] = [
      [0, -arena.halfZ - 0.25, arena.halfX * 2 + 1, 0.5],
      [0, arena.halfZ + 0.25, arena.halfX * 2 + 1, 0.5],
      [-arena.halfX - 0.25, 0, 0.5, arena.halfZ * 2],
      [arena.halfX + 0.25, 0, 0.5, arena.halfZ * 2],
    ];
    for (const [x, z, w, d] of walls) {
      const tex = wallTex.clone();
      tex.repeat.set(Math.max(w, d) / 2, h / 2);
      tex.needsUpdate = true;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat.clone());
      (m.material as THREE.MeshStandardMaterial).map = tex;
      m.position.set(x, h / 2, z);
      m.receiveShadow = true;
      this.scene.add(m);
    }
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x59617a, roughness: 0.6, metalness: 0.2 });
    for (const p of arena.pillars) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r * 1.08, h, 24), pillarMat);
      m.position.set(p.x, h / 2, p.z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
    }
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  syncProjectiles(sim: Simulation, frac: number): void {
    const alive = new Set<number>();
    for (const p of sim.state.projectiles) {
      alive.add(p.id);
      let o = this.projectiles.get(p.id);
      if (!o) {
        const owner = sim.fighter(p.owner);
        const color = owner ? sim.charOf(owner).color : 0xffffff;
        o = new THREE.Group();
        const core = new THREE.Mesh(
          new THREE.SphereGeometry(p.radius * 0.7, 16, 12),
          new THREE.MeshBasicMaterial({ color: 0xffffff }),
        );
        const halo = new THREE.Mesh(
          new THREE.SphereGeometry(p.radius * 1.4, 16, 12),
          new THREE.MeshBasicMaterial({
            color: new THREE.Color(color).lerp(new THREE.Color(0x88ddff), 0.5),
            transparent: true,
            opacity: 0.45,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        );
        o.add(core, halo);
        this.scene.add(o);
        this.projectiles.set(p.id, o);
      }
      o.position.set(
        p.prevPos.x + (p.pos.x - p.prevPos.x) * frac,
        p.prevPos.y + (p.pos.y - p.prevPos.y) * frac,
        p.prevPos.z + (p.pos.z - p.prevPos.z) * frac,
      );
      o.rotation.y += 0.3;
    }
    for (const [id, o] of this.projectiles) {
      if (!alive.has(id)) {
        o.removeFromParent();
        this.projectiles.delete(id);
      }
    }
  }

  /**
   * Draws hurtboxes (green / blue = invulnerable / orange = armor) and
   * hitboxes (red, magenta = grab, faint yellow = about to become active).
   */
  drawDebug(sim: Simulation, show: boolean, hideId: number): void {
    this.debug.visible = show;
    if (!show) return;
    let n = 0;
    const put = (a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material): void => {
      let m = this.debugPool[n];
      if (!m) {
        m = new THREE.Mesh(capsuleGeo(r, 0.1), mat);
        this.debugPool.push(m);
        this.debug.add(m);
      }
      n++;
      const dir = b.clone().sub(a);
      const len = dir.length();
      m.geometry = capsuleGeo(r, len);
      m.material = mat;
      m.position.copy(a).add(b).multiplyScalar(0.5);
      if (len > 1e-4) m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      m.visible = true;
    };
    const V = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);
    for (const f of sim.state.fighters) {
      const stats = sim.statsOf(f);
      const inv = invulnerability(sim, f);
      const m = sim.moveOf(f);
      const armored = f.state === 'attack' && f.armorLeft > 0 && !!m?.armor && inFrames(m.armor.frames, f.moveFrame);
      // In first person the local player's own hurtbox would wrap the camera.
      if (f.id !== hideId) {
        const hc = hurtCapsule(f, stats);
        put(V(hc.a), V(hc.b), hc.r, inv !== 'none' ? this.debugMats.invuln : armored ? this.debugMats.armor : this.debugMats.hurt);
      }
      if (f.state === 'attack' && m) {
        const pitch = movePitch(f, m);
        for (const hb of m.hitboxes) {
          const active = inFrames(hb.frames, f.moveFrame);
          const soon = !active && hb.frames[0] > f.moveFrame && hb.frames[0] - f.moveFrame <= 4;
          if (!active && !soon) continue;
          const c = hitboxCapsule(f, stats, hb, pitch);
          put(V(c.a), V(c.b), c.r, active ? (hb.throw ? this.debugMats.grab : this.debugMats.hit) : this.debugMats.upcoming);
        }
      }
    }
    for (const p of sim.state.projectiles) put(V(p.prevPos), V(p.pos), p.radius, this.debugMats.hit);
    for (let i = n; i < this.debugPool.length; i++) this.debugPool[i].visible = false;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
