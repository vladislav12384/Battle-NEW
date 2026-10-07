/** Placeholder articulated mannequin built from primitives, driven by the procedural skeleton. */
import * as THREE from 'three';
import type { CharacterStats } from '../../core/types';
import { bodyOf, type Joints, type PoseTargets, type V3 } from './skeleton';

const UP = new THREE.Vector3(0, 1, 0);
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1);
const sphereGeo = new THREE.SphereGeometry(1, 16, 12);
const boxGeo = new THREE.BoxGeometry(1, 1, 1);

/** core local (x right, y up, z forward) -> three.js local (x right, y up, -z forward). */
export const toThree = (p: V3, out = new THREE.Vector3()): THREE.Vector3 => out.set(p.x, p.y, -p.z);

interface Bone {
  mesh: THREE.Mesh;
  a: keyof Joints;
  b: keyof Joints;
  radius: number;
  body: boolean;
}

export class FighterView {
  readonly root = new THREE.Group();
  private readonly bones: Bone[] = [];
  private readonly head: THREE.Mesh;
  private readonly visor: THREE.Mesh;
  private readonly fists: THREE.Mesh[] = [];
  private readonly feet: THREE.Mesh[] = [];
  private readonly jointsMesh: { mesh: THREE.Mesh; j: keyof Joints; body: boolean }[] = [];
  private readonly mat: THREE.MeshStandardMaterial;
  private readonly skinMat: THREE.MeshStandardMaterial;
  private readonly aura: THREE.Mesh;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly flash: { t: number } = { t: 0 };
  private readonly fistSize: number;

  constructor(color: number, stats: CharacterStats) {
    const b = bodyOf(stats);
    this.fistSize = 0.075 * b.s;
    this.mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1 });
    const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.45), roughness: 0.7 });
    this.skinMat = new THREE.MeshStandardMaterial({ color: 0xe8c4a0, roughness: 0.6, emissive: 0x000000 });

    const bone = (a: keyof Joints, bb: keyof Joints, radius: number, mat: THREE.Material, body = false): void => {
      const mesh = new THREE.Mesh(cylGeo, mat);
      mesh.castShadow = true;
      this.root.add(mesh);
      this.bones.push({ mesh, a, b: bb, radius, body });
    };
    const joint = (j: keyof Joints, r: number, mat: THREE.Material, body = false): void => {
      const mesh = new THREE.Mesh(sphereGeo, mat);
      mesh.scale.setScalar(r);
      mesh.castShadow = true;
      this.root.add(mesh);
      this.jointsMesh.push({ mesh, j, body });
    };

    bone('hip', 'chest', 0.17 * b.w, this.mat, true);
    bone('lShoulder', 'rShoulder', 0.07 * b.w, this.mat, true);
    joint('hip', 0.16 * b.w, dark, true);
    joint('chest', 0.17 * b.w, this.mat, true);
    bone('lShoulder', 'lElbow', 0.055 * b.s, this.mat);
    bone('rShoulder', 'rElbow', 0.055 * b.s, this.mat);
    bone('lElbow', 'lHand', 0.048 * b.s, this.skinMat);
    bone('rElbow', 'rHand', 0.048 * b.s, this.skinMat);
    joint('lElbow', 0.052 * b.s, this.mat);
    joint('rElbow', 0.052 * b.s, this.mat);
    bone('lHipJ', 'lKnee', 0.075 * b.s, dark);
    bone('rHipJ', 'rKnee', 0.075 * b.s, dark);
    bone('lKnee', 'lFoot', 0.06 * b.s, dark);
    bone('rKnee', 'rFoot', 0.06 * b.s, dark);
    joint('lKnee', 0.065 * b.s, dark);
    joint('rKnee', 0.065 * b.s, dark);

    for (let i = 0; i < 2; i++) {
      const fist = new THREE.Mesh(sphereGeo, this.skinMat);
      fist.scale.setScalar(0.075 * b.s);
      fist.castShadow = true;
      this.fists.push(fist);
      this.root.add(fist);
      const foot = new THREE.Mesh(boxGeo, dark);
      foot.scale.set(0.11 * b.w, 0.08, 0.24 * b.s);
      foot.castShadow = true;
      this.feet.push(foot);
      this.root.add(foot);
    }

    this.head = new THREE.Mesh(sphereGeo, this.skinMat);
    this.head.scale.set(0.12 * b.s, 0.14 * b.s, 0.13 * b.s);
    this.head.castShadow = true;
    this.root.add(this.head);
    this.visor = new THREE.Mesh(boxGeo, new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: 0.6 }));
    this.visor.scale.set(0.2 * b.s, 0.045 * b.s, 0.06);
    this.root.add(this.visor);

    this.aura = new THREE.Mesh(
      sphereGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.aura.scale.set(0.6 * b.w, 1.05 * b.s, 0.6 * b.w);
    this.root.add(this.aura);
  }

  /** Brief white flash when hit. */
  hitFlash(): void {
    this.flash.t = 1;
  }

  update(j: Joints, pose: PoseTargets, firstPerson: boolean, dt: number): void {
    for (const bn of this.bones) {
      const a = toThree(j[bn.a], this.tmpA);
      const b = toThree(j[bn.b], this.tmpB);
      const dir = b.clone().sub(a);
      const len = dir.length();
      bn.mesh.position.copy(a).add(b).multiplyScalar(0.5);
      bn.mesh.scale.set(bn.radius, Math.max(len, 1e-3), bn.radius);
      if (len > 1e-5) bn.mesh.quaternion.setFromUnitVectors(UP, dir.divideScalar(len));
      bn.mesh.visible = !(firstPerson && bn.body);
    }
    for (const jm of this.jointsMesh) {
      toThree(j[jm.j], jm.mesh.position);
      jm.mesh.visible = !(firstPerson && jm.body);
    }
    toThree(j.lHand, this.fists[0].position);
    toThree(j.rHand, this.fists[1].position);
    for (const fist of this.fists) fist.scale.setScalar(this.fistSize * (firstPerson ? 0.75 : 1));
    (['lFoot', 'rFoot'] as const).forEach((foot, i) => {
      const fm = this.feet[i];
      toThree(j[foot], fm.position);
      fm.position.y += 0.04;
      fm.position.z -= 0.06; // toes point forward (-Z in three.js local space)
    });
    toThree(j.head, this.head.position);
    const headDir = this.tmpB.set(j.head.x - j.chest.x, j.head.y - j.chest.y, -(j.head.z - j.chest.z)).normalize();
    this.head.quaternion.setFromUnitVectors(UP, headDir);
    this.visor.position.copy(this.head.position).add(new THREE.Vector3(0, 0.02, -0.11).applyQuaternion(this.head.quaternion));
    this.visor.quaternion.copy(this.head.quaternion);
    this.head.visible = !firstPerson;
    this.visor.visible = !firstPerson;

    this.flash.t = Math.max(0, this.flash.t - dt * 8);
    const glow = pose.glow;
    this.skinMat.emissive.setRGB(glow * 0.6 + this.flash.t, glow * 0.45 + this.flash.t, glow * 0.15 + this.flash.t);
    this.mat.emissive.setRGB(this.flash.t * 0.8, this.flash.t * 0.8, this.flash.t * 0.8);
    const aMat = this.aura.material as THREE.MeshBasicMaterial;
    aMat.opacity = firstPerson ? 0 : glow * 0.18;
    toThree(j.chest, this.aura.position).add(toThree(j.hip, this.tmpA)).multiplyScalar(0.5);
    this.aura.visible = aMat.opacity > 0.01;
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}
