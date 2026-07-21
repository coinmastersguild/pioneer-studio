// One face contract, two rigs.
//
// VrmLipSync emits a single VRM viseme (`aa/ih/ou/ee/oh`) + weight per frame.
// A VRM consumes that directly through its expressionManager. The GNM head does
// not have VRM expressions — it has 46 oral morphs, a strictly richer rig — so
// the adapter here spends the viseme across them (vowel + jaw + lip rounding).
//
// Everything the Head tab does is written against `FaceRig`, so adding a rig
// (another authored base, a future GNM identity export) is one more adapter and
// no change to the view. See EPIC-010 §S2.
import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { VrmFaceController, type VrmVisemeExpression } from "./VrmFaceController";
import { GNM_VISEME, MOUTH as GNM_MOUTH } from "./headMorphs";

export interface FaceRig {
  readonly root: THREE.Object3D;
  /** The short, named set worth a slider by default. */
  readonly designNames: string[];
  /** Everything else the asset exports, behind a "show all" toggle. */
  readonly extraNames: string[];
  /** False when the asset has no mouth shapes at all — 35 of 36 VRMs audited. */
  readonly canSpeak: boolean;
  /** What the asset is, for the UI. */
  readonly label: string;
  setViseme(name: VrmVisemeExpression | null, weight: number): void;
  setExpression(name: string, weight: number): void;
  setGaze(x: number, y: number): void;
  /** World-space point to frame the camera on (the eye line). */
  focus(): THREE.Vector3;
  update(dt: number): void;
}

/* ── GNM head ─────────────────────────────────────────────────────────────── */

export class GnmFaceRig implements FaceRig {
  readonly canSpeak = true;
  readonly label = "GNM head";
  readonly extraNames: string[] = []; // curated list already; nothing hidden
  private setMorph: (n: string, v: number) => void;
  private eyes: THREE.Object3D | null = null;
  private blinkAt = 2;
  private clock = 0;
  private gaze = { x: 0, y: 0 };

  readonly root: THREE.Object3D;
  readonly designNames: string[];

  constructor(root: THREE.Object3D, designNames: string[]) {
    this.root = root;
    this.designNames = designNames;
    const slots = new Map<string, { infl: number[]; i: number }[]>();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      const mat = m.material as THREE.Material & { name?: string };
      if ((mat as { name?: string })?.name === "sclera") this.eyes = o;
      if (!m.morphTargetDictionary || !m.morphTargetInfluences) return;
      for (const [name, i] of Object.entries(m.morphTargetDictionary)) {
        if (!slots.has(name)) slots.set(name, []);
        slots.get(name)!.push({ infl: m.morphTargetInfluences, i });
      }
    });
    this.setMorph = (name, v) => {
      const hits = slots.get(name);
      if (hits) for (const h of hits) h.infl[h.i] = v;
    };
  }

  setViseme(name: VrmVisemeExpression | null, weight: number) {
    for (const m of GNM_MOUTH) this.setMorph(m, 0);
    if (!name) return;
    for (const [morph, amount] of Object.entries(GNM_VISEME[name])) this.setMorph(morph, amount * weight);
  }
  setExpression(name: string, weight: number) {
    this.setMorph(name, weight);
  }
  setGaze(x: number, y: number) {
    this.gaze = { x, y };
    this.setMorph("gazeLeft", Math.max(0, -x));
    this.setMorph("gazeRight", Math.max(0, x));
    this.setMorph("gazeUp", Math.max(0, y));
    this.setMorph("gazeDown", Math.max(0, -y));
  }
  focus() {
    return new THREE.Box3().setFromObject(this.eyes ?? this.root).getCenter(new THREE.Vector3());
  }
  update(dt: number) {
    this.clock += dt;
    // nonperiodic blink — VrmFaceController does its own; GNM needs one here
    if (this.clock > this.blinkAt) {
      const p = Math.max(0, 1 - Math.abs(this.clock - this.blinkAt - 0.08) / 0.08);
      this.setMorph("blinkLeft", p);
      this.setMorph("blinkRight", p);
      if (this.clock > this.blinkAt + 0.16) this.blinkAt = this.clock + 2 + Math.random() * 4;
    }
    this.root.rotation.y = Math.sin(this.clock * 0.4) * 0.06 + this.gaze.x * 0.18;
    this.root.rotation.x = Math.sin(this.clock * 0.27) * 0.03 - this.gaze.y * 0.12;
  }
}

/* ── VRM ──────────────────────────────────────────────────────────────────── */

const VISEMES = ["aa", "ih", "ou", "ee", "oh"];

/** Ceiling on viseme weight for authored VRMs.
 *
 *  Measured on jane-v8 (2026-07-20) by holding each viseme at fixed weights and
 *  comparing against the same face at rest. At rest the mouth is clean. Driven,
 *  the lower lip separates into a floating crescent and the mouth corners shed
 *  polygons — badly by 0.5, visibly at 0.45, gone by ~0.28 apart from a faint
 *  doubled lip edge that never fully clears.
 *
 *  This is the asset, not the driver, and the character studio already knows:
 *  JANE-V8-F1-FACE-TOPOLOGY-AND-ORAL-AUDIT is "conditional-failed", records that
 *  no target has an approved `safeWeight`, and calls the inherited shapes
 *  "evidence, not production controls". This constant is that missing number,
 *  measured from the outside. Raise it when the base ships repaired shapes.
 *
 *  Cost: articulation range. There is no jaw bone either, so the mouth cannot
 *  open regardless — speech reads as lip movement, not as a working jaw. */
const VRM_VISEME_CEILING = 0.28;

export class VrmFaceRig implements FaceRig {
  readonly root: THREE.Object3D;
  readonly designNames: string[];
  readonly extraNames: string[];
  readonly canSpeak: boolean;
  private face: VrmFaceController;
  private gazePoint = new THREE.Vector3();

  readonly label: string;
  private vrm: VRM;

  constructor(vrm: VRM, label: string) {
    this.vrm = vrm;
    this.label = label;
    this.root = vrm.scene;
    this.face = new VrmFaceController(vrm);
    // VRM presets are the named, meaningful ones (happy/angry/sad/…); the rest
    // are raw authored shapes like `brow_innerRaiser_L` — real, but not a
    // control surface anyone wants 90 of on first open.
    const presets = new Set(this.face.presetExpressionNames);
    const usable = (n: string) => !VISEMES.includes(n) && !n.startsWith("blink");
    this.designNames = this.face.presetExpressionNames.filter(usable);
    this.extraNames = this.face.expressionNames.filter((n) => usable(n) && !presets.has(n));
    // The audit that matters: an asset can declare every preset name and bind
    // none of them (13 of the 32 game VRMs do exactly that, so a name check
    // alone reports them as able to speak). three-vrm only registers an
    // expression that actually exists, so presence here is the real signal.
    this.canSpeak = VISEMES.every((v) => this.face.hasExpression(v));
  }

  setViseme(name: VrmVisemeExpression | null, weight: number) {
    this.face.setViseme(name, Math.min(weight, VRM_VISEME_CEILING));
  }
  setExpression(name: string, weight: number) {
    this.face.setExpression(name, weight);
  }
  setGaze(x: number, y: number) {
    // VRM gaze is a look-at target, not morphs: place a point in front of the
    // face and let three-vrm solve the eye bones.
    const head = this.vrm.humanoid?.getNormalizedBoneNode("head");
    const at = head ? head.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
    this.gazePoint.set(at.x + x * 0.6, at.y + y * 0.4, at.z + 1.2);
    this.face.setLookAtPosition(this.gazePoint);
  }
  focus() {
    const head = this.vrm.humanoid?.getNormalizedBoneNode("head");
    if (head) {
      const p = head.getWorldPosition(new THREE.Vector3());
      p.y += 0.08; // bone sits at the skull base; the eye line is above it
      return p;
    }
    return new THREE.Box3().setFromObject(this.root).getCenter(new THREE.Vector3());
  }
  update(dt: number) {
    this.face.update(dt);
    this.vrm.springBoneManager?.update(dt);
  }
}
