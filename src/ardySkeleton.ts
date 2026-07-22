// ARDY Core skeleton (cskel27) — the 27-joint hierarchy and T-pose rest positions
// used by ARDY's `core` checkpoint. Derived from nv-tlabs/ardy at commit
// 693f74d13b3d04a0a22ce127ee79c929dd89756b (Apache-2.0); see
// THIRD_PARTY_NOTICES.md. Do not hand-edit these generated values.
//
// Positions are metres, hips-relative, Y-up, **+Z forward** (note: the toe sits at
// +Z). A VRM after rotateVRM0 faces -Z, hence the per-actor forward yaw in StageView.
// Using ARDY's own joint set lets motion apply directly to these actors with
// no retargeting — that is the whole point of the placeholder.
import * as THREE from "three";

export type Joint = { name: string; parent: string | null; rest: [number, number, number] };

/** Hips height that puts the toe joint on the ground plane. */
export const HIP_HEIGHT = 0.9544;

export const JOINTS: Joint[] = [
  { name: "Hips", parent: null, rest: [0.0000, 0.0000, 0.0000] },
  { name: "Spine", parent: "Hips", rest: [0.0000, 0.0710, -0.0473] },
  { name: "Spine1", parent: "Spine", rest: [0.0000, 0.1642, -0.0638] },
  { name: "Spine2", parent: "Spine1", rest: [0.0000, 0.2585, -0.0720] },
  { name: "Spine3", parent: "Spine2", rest: [0.0000, 0.3531, -0.0720] },
  { name: "Neck", parent: "Spine3", rest: [0.0000, 0.6016, -0.0365] },
  { name: "Head", parent: "Neck", rest: [0.0000, 0.7298, -0.0139] },
  { name: "RightShoulder", parent: "Spine3", rest: [-0.0320, 0.5259, -0.0187] },
  { name: "RightArm", parent: "RightShoulder", rest: [-0.1909, 0.5259, -0.0187] },
  { name: "RightForeArm", parent: "RightArm", rest: [-0.4863, 0.5259, -0.0187] },
  { name: "RightHand", parent: "RightForeArm", rest: [-0.7190, 0.5259, -0.0187] },
  { name: "RightHandEnd", parent: "RightHand", rest: [-0.7886, 0.5259, -0.0187] },
  { name: "RightHandThumb1", parent: "RightHand", rest: [-0.7468, 0.5074, 0.0277] },
  { name: "LeftShoulder", parent: "Spine3", rest: [0.0320, 0.5259, -0.0187] },
  { name: "LeftArm", parent: "LeftShoulder", rest: [0.1909, 0.5259, -0.0187] },
  { name: "LeftForeArm", parent: "LeftArm", rest: [0.4863, 0.5259, -0.0187] },
  { name: "LeftHand", parent: "LeftForeArm", rest: [0.7190, 0.5259, -0.0187] },
  { name: "LeftHandEnd", parent: "LeftHand", rest: [0.7886, 0.5259, -0.0187] },
  { name: "LeftHandThumb1", parent: "LeftHand", rest: [0.7468, 0.5074, 0.0277] },
  { name: "RightUpLeg", parent: "Hips", rest: [-0.0949, -0.0277, 0.0000] },
  { name: "RightLeg", parent: "RightUpLeg", rest: [-0.0949, -0.4398, 0.0000] },
  { name: "RightFoot", parent: "RightLeg", rest: [-0.0949, -0.8959, 0.0000] },
  { name: "RightToeBase", parent: "RightFoot", rest: [-0.0949, -0.9544, 0.1607] },
  { name: "LeftUpLeg", parent: "Hips", rest: [0.0949, -0.0277, 0.0000] },
  { name: "LeftLeg", parent: "LeftUpLeg", rest: [0.0949, -0.4398, 0.0000] },
  { name: "LeftFoot", parent: "LeftLeg", rest: [0.0949, -0.8959, 0.0000] },
  { name: "LeftToeBase", parent: "LeftFoot", rest: [0.0949, -0.9544, 0.1607] },
];

/** Distinct hues for actors — a video model has to tell them apart in the raw
 *  take, so keep them far apart in hue and readable against the dark stage. */
export const ACTOR_COLORS = [
  { name: "Green", hex: 0x4ade80 },
  { name: "Amber", hex: 0xfbbf24 },
  { name: "Cyan", hex: 0x22d3ee },
  { name: "Rose", hex: 0xfb7185 },
  { name: "Violet", hex: 0xa78bfa },
  { name: "Lime", hex: 0xa3e635 },
];

const LIMB_TINT: Record<string, number> = {
  // Within one actor's hue, limbs are tinted so the pose stays legible (and so a
  // pose estimator has left/right signal) — same trick OpenPose control videos use.
  Left: 1.0,
  Right: 0.55,
};
const tintFor = (name: string) => (name.startsWith("Left") ? LIMB_TINT.Left : name.startsWith("Right") ? LIMB_TINT.Right : 0.8);

export type Rig = {
  root: THREE.Group;
  bones: Map<string, THREE.Object3D>;
  dispose(): void;
};

/** Build a color-coded stick figure on the ARDY Core rig. Joints are spheres,
 *  bones are cylinders parented to the joint above, so posing a bone moves its
 *  whole chain — the same rotation calls that drive a VRM humanoid. */
export function buildRig(hex: number): Rig {
  const root = new THREE.Group();
  const bones = new Map<string, THREE.Object3D>();
  const byName = new Map(JOINTS.map((j) => [j.name, j]));
  const disposables: { dispose(): void }[] = [];

  const base = new THREE.Color(hex);
  const mat = (t: number, emissive: number) => {
    const m = new THREE.MeshStandardMaterial({
      color: base.clone().multiplyScalar(t),
      emissive: base.clone().multiplyScalar(emissive),
      roughness: 0.45,
      metalness: 0.1,
    });
    disposables.push(m);
    return m;
  };

  for (const j of JOINTS) {
    const o = new THREE.Object3D();
    const p = j.parent ? byName.get(j.parent)! : null;
    // local offset = rest(child) - rest(parent); ARDY rest is absolute, hips-relative
    o.position.set(
      j.rest[0] - (p?.rest[0] ?? 0),
      j.rest[1] - (p?.rest[1] ?? 0),
      j.rest[2] - (p?.rest[2] ?? 0),
    );
    bones.set(j.name, o);
    (j.parent ? bones.get(j.parent)! : root).add(o);

    // joint marker — head gets a big one so facing is readable in the raw take
    const r = j.name === "Head" ? 0.085 : j.name === "Hips" ? 0.055 : 0.035;
    const g = new THREE.SphereGeometry(r, 12, 10);
    disposables.push(g);
    o.add(new THREE.Mesh(g, mat(tintFor(j.name), 0.35)));

    // Bone parent→child, drawn in the PARENT's space: the segment is rigid with
    // the parent, so rotating this joint must not swing the bone off its parent.
    if (j.parent) {
      const len = o.position.length();
      if (len > 1e-4) {
        const bg = new THREE.CylinderGeometry(0.022, 0.022, len, 8);
        bg.translate(0, len / 2, 0); // pivot at the parent, growing toward the child
        disposables.push(bg);
        const bm = new THREE.Mesh(bg, mat(tintFor(j.name) * 0.75, 0.12));
        bm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), o.position.clone().normalize());
        bones.get(j.parent)!.add(bm);
      }
    }
  }
  root.position.y = HIP_HEIGHT;
  return { root, bones, dispose: () => disposables.forEach((d) => d.dispose()) };
}
