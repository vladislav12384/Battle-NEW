/** Placeholder articulated fighter built from primitives, driven by the procedural skeleton. */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { CharacterStats } from '../../core/types';
import { bodyOf, type JointPoint, type Joints, type Pose, type V3 } from './anim';

const UP = new THREE.Vector3(0, 1, 0);
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 14, 1);
/** Tapered limb: thick at the segment start (bottom, y = -0.5), thinner at the end. */
const taperGeo = new THREE.CylinderGeometry(0.78, 1, 1, 14, 1);
const sphereGeo = new THREE.SphereGeometry(1, 20, 14);
const roundBox = new RoundedBoxGeometry(1, 1, 1, 3, 0.28);

/** core local (x right, y up, z forward) -> three.js local (x right, y up, -z forward). */
export const toThree = (p: V3, out = new THREE.Vector3()): THREE.Vector3 => out.set(p.x, p.y, -p.z);

interface Segment {
  mesh: THREE.Mesh;
  a: JointPoint;
  b: JointPoint;
  radius: number;
  /** Hidden in first person. */
  body: boolean;
}

export class FighterView {
  readonly root = new THREE.Group();
  private readonly segments: Segment[] = [];
  private readonly jointBalls: { mesh: THREE.Mesh; j: JointPoint; body: boolean }[] = [];
  private readonly torso: THREE.Mesh;
  private readonly pelvis: THREE.Mesh;
  private readonly belt: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly hair: THREE.Mesh;
  private readonly visor: THREE.Mesh;
  private readonly fists: THREE.Mesh[] = [];
  private readonly wraps: THREE.Mesh[] = [];
  private readonly feet: THREE.Mesh[] = [];
  private readonly mats: THREE.MeshStandardMaterial[] = [];
  private readonly skin: THREE.MeshStandardMaterial;
  private readonly aura: THREE.Mesh;
  private readonly b: ReturnType<typeof bodyOf>;
  private flashT = 0;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();

  constructor(color: number, stats: CharacterStats) {
    const b = (this.b = bodyOf(stats));
    const mat = (c: number | THREE.Color, rough = 0.6, metal = 0.05): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal });
      this.mats.push(m);
      return m;
    };
    const base = new THREE.Color(color);
    const shirt = mat(base, 0.55);
    const pants = mat(base.clone().multiplyScalar(0.32), 0.75);
    this.skin = mat(0xe2b48f, 0.55);
    const wrap = mat(0xf2efe6, 0.8);
    const shoe = mat(0x1c1c22, 0.6);
    const beltMat = mat(base.clone().lerp(new THREE.Color(0xffd27a), 0.6), 0.4, 0.3);

    const seg = (a: JointPoint, bb: JointPoint, radius: number, m: THREE.Material, body = false, taper = false): void => {
      const mesh = new THREE.Mesh(taper ? taperGeo : cylGeo, m);
      mesh.castShadow = true;
      this.root.add(mesh);
      this.segments.push({ mesh, a, b: bb, radius, body });
    };
    const ball = (j: JointPoint, r: number, m: THREE.Material, body = false): void => {
      const mesh = new THREE.Mesh(sphereGeo, m);
      mesh.scale.setScalar(r);
      mesh.castShadow = true;
      this.root.add(mesh);
      this.jointBalls.push({ mesh, j, body });
    };

    this.torso = new THREE.Mesh(roundBox, shirt);
    this.torso.castShadow = true;
    this.pelvis = new THREE.Mesh(roundBox, pants);
    this.pelvis.castShadow = true;
    this.belt = new THREE.Mesh(roundBox, beltMat);
    this.root.add(this.torso, this.pelvis, this.belt);

    seg('neck', 'head', 0.055 * b.s, this.skin, true);
    // Arms: sleeve on the upper arm (hidden in first person), skin forearm, wrap, fist.
    seg('lShoulder', 'lElbow', 0.062 * b.s, shirt, true);
    seg('rShoulder', 'rElbow', 0.062 * b.s, shirt, true);
    ball('lShoulder', 0.075 * b.s, shirt, true);
    ball('rShoulder', 0.075 * b.s, shirt, true);
    ball('lElbow', 0.046 * b.s, this.skin);
    ball('rElbow', 0.046 * b.s, this.skin);
    seg('lElbow', 'lHand', 0.043 * b.s, this.skin, false, true);
    seg('rElbow', 'rHand', 0.043 * b.s, this.skin, false, true);
    // Legs.
    seg('lHipJ', 'lKnee', 0.085 * b.s, pants, false, true);
    seg('rHipJ', 'rKnee', 0.085 * b.s, pants, false, true);
    ball('lKnee', 0.07 * b.s, pants);
    ball('rKnee', 0.07 * b.s, pants);
    seg('lKnee', 'lFoot', 0.068 * b.s, pants, false, true);
    seg('rKnee', 'rFoot', 0.068 * b.s, pants, false, true);

    for (let i = 0; i < 2; i++) {
      const fist = new THREE.Mesh(roundBox, this.skin);
      fist.castShadow = true;
      fist.scale.set(0.11 * b.s, 0.095 * b.s, 0.12 * b.s);
      this.fists.push(fist);
      const w = new THREE.Mesh(cylGeo, wrap);
      w.scale.set(0.05 * b.s, 0.075 * b.s, 0.05 * b.s);
      this.wraps.push(w);
      const foot = new THREE.Mesh(roundBox, shoe);
      foot.castShadow = true;
      foot.scale.set(0.11 * b.w, 0.09 * b.s, 0.26 * b.s);
      this.feet.push(foot);
      this.root.add(fist, w, foot);
    }

    this.head = new THREE.Mesh(sphereGeo, this.skin);
    this.head.scale.set(0.115 * b.s, 0.135 * b.s, 0.125 * b.s);
    this.head.castShadow = true;
    this.hair = new THREE.Mesh(sphereGeo, mat(0x23180f, 0.9));
    this.hair.scale.set(0.12 * b.s, 0.1 * b.s, 0.128 * b.s);
    this.visor = new THREE.Mesh(
      roundBox,
      new THREE.MeshStandardMaterial({ color: 0x0c0c10, emissive: color, emissiveIntensity: 0.7, roughness: 0.3 }),
    );
    this.visor.scale.set(0.2 * b.s, 0.045 * b.s, 0.06 * b.s);
    this.root.add(this.head, this.hair, this.visor);

    this.aura = new THREE.Mesh(
      sphereGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.aura.scale.set(0.6 * b.w, 1.05 * b.s, 0.6 * b.w);
    this.root.add(this.aura);
  }

  /** Brief white flash when hit. */
  hitFlash(): void {
    this.flashT = 1;
  }

  private placeSegment(mesh: THREE.Mesh, a: V3, b: V3, radius: number): void {
    const pa = toThree(a, this.tmpA);
    const pb = toThree(b, this.tmpB);
    const dir = this.tmpC.copy(pb).sub(pa);
    const length = dir.length();
    mesh.position.copy(pa).add(pb).multiplyScalar(0.5);
    mesh.scale.set(radius, Math.max(length, 1e-3), radius);
    if (length > 1e-5) mesh.quaternion.setFromUnitVectors(UP, dir.divideScalar(length));
  }

  /** Orients a box with the chest frame (right/up from the skeleton). */
  private placeBox(mesh: THREE.Mesh, center: V3, right: V3, up: V3, size: [number, number, number]): void {
    const r = toThree(right, new THREE.Vector3()).normalize();
    const u = toThree(up, new THREE.Vector3()).normalize();
    const f = new THREE.Vector3().crossVectors(r, u).normalize();
    this.basis.makeBasis(r, u, f);
    mesh.quaternion.setFromRotationMatrix(this.basis);
    toThree(center, mesh.position);
    mesh.scale.set(...size);
  }

  update(j: Joints, pose: Pose, firstPerson: boolean, dt: number): void {
    const b = this.b;
    for (const s of this.segments) {
      this.placeSegment(s.mesh, j[s.a], j[s.b], s.radius);
      s.mesh.visible = !(firstPerson && s.body);
    }
    for (const jb of this.jointBalls) {
      toThree(j[jb.j], jb.mesh.position);
      jb.mesh.visible = !(firstPerson && jb.body);
    }

    // Torso: chest box over the spine, pelvis, belt.
    const mid = { x: (j.hip.x + j.chest.x) / 2, y: (j.hip.y + j.chest.y) / 2, z: (j.hip.z + j.chest.z) / 2 };
    const torsoLen = Math.hypot(j.chest.x - j.hip.x, j.chest.y - j.hip.y, j.chest.z - j.hip.z);
    const chestC = { x: mid.x + j.chestUp.x * 0.06, y: mid.y + j.chestUp.y * 0.06, z: mid.z + j.chestUp.z * 0.06 };
    this.placeBox(this.torso, chestC, j.chestRight, j.chestUp, [0.44 * b.w, torsoLen * 1.05, 0.25 * b.w]);
    const hipRight = { x: (j.rHipJ.x - j.lHipJ.x) * 5, y: (j.rHipJ.y - j.lHipJ.y) * 5, z: (j.rHipJ.z - j.lHipJ.z) * 5 };
    this.placeBox(this.pelvis, j.hip, hipRight, j.chestUp, [0.36 * b.w, 0.2 * b.s, 0.24 * b.w]);
    const beltC = { x: j.hip.x + j.chestUp.x * 0.1, y: j.hip.y + j.chestUp.y * 0.1, z: j.hip.z + j.chestUp.z * 0.1 };
    this.placeBox(this.belt, beltC, hipRight, j.chestUp, [0.38 * b.w, 0.05 * b.s, 0.26 * b.w]);
    for (const m of [this.torso, this.pelvis, this.belt]) m.visible = !firstPerson;

    // Fists and wraps follow the forearm direction (knuckles forward).
    (['lHand', 'rHand'] as const).forEach((hand, i) => {
      const elbow = hand === 'lHand' ? j.lElbow : j.rElbow;
      const pe = toThree(elbow, this.tmpA);
      const ph = toThree(j[hand], this.tmpB);
      const dir = this.tmpC.copy(ph).sub(pe).normalize();
      const fist = this.fists[i];
      fist.position.copy(ph).addScaledVector(dir, 0.045 * b.s);
      fist.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
      const s = firstPerson ? 0.92 : 1;
      fist.scale.set(0.11 * b.s * s, 0.095 * b.s * s, 0.12 * b.s * s);
      const w = this.wraps[i];
      w.position.copy(ph).addScaledVector(dir, -0.03 * b.s);
      w.quaternion.setFromUnitVectors(UP, dir);
    });

    // Feet: flat and forward when planted, pointed along the shin when kicking.
    (['lFoot', 'rFoot'] as const).forEach((foot, i) => {
      const knee = foot === 'lFoot' ? j.lKnee : j.rKnee;
      const fm = this.feet[i];
      const pf = toThree(j[foot], this.tmpA);
      const shin = this.tmpB.copy(pf).sub(toThree(knee, this.tmpC)).normalize();
      const raised = Math.min(1, Math.max(0, (j[foot].y - 0.25) / 0.4));
      const flat = new THREE.Vector3(0, 0, -1);
      const pointDir = flat.clone().lerp(shin, raised).normalize();
      fm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), pointDir);
      fm.position.copy(pf).addScaledVector(pointDir, 0.07 * b.s);
      fm.position.y += 0.045 * (1 - raised);
    });

    // Head: orientation from the skeleton's head rotation.
    toThree(j.head, this.head.position);
    this.head.rotation.set(-j.headRot.pitch, j.headRot.yaw, -j.headRot.roll, 'YXZ');
    this.hair.position.copy(this.head.position).add(new THREE.Vector3(0, 0.035 * b.s, 0.012).applyEuler(this.head.rotation));
    this.hair.rotation.copy(this.head.rotation);
    this.visor.position.copy(this.head.position).add(new THREE.Vector3(0, 0.015, -0.105 * b.s).applyEuler(this.head.rotation));
    this.visor.rotation.copy(this.head.rotation);
    for (const m of [this.head, this.hair, this.visor]) m.visible = !firstPerson;

    // Hit flash and energy glow.
    this.flashT = Math.max(0, this.flashT - dt * 12);
    const g = pose.glow;
    const fl = this.flashT * 0.28;
    for (const m of this.mats) m.emissive.setRGB(fl, fl * 0.85, fl * 0.7);
    this.skin.emissive.setRGB(g * 0.6 + fl, g * 0.45 + fl * 0.85, g * 0.15 + fl * 0.7);
    const aMat = this.aura.material as THREE.MeshBasicMaterial;
    aMat.opacity = firstPerson ? 0 : g * 0.18;
    toThree(j.chest, this.aura.position).add(toThree(j.hip, this.tmpA)).multiplyScalar(0.5);
    this.aura.visible = aMat.opacity > 0.01;
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}
