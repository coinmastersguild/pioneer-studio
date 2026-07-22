// Which of the GNM head's 67 morph targets HeadView drives, split by who owns
// them. Kept out of HeadView.tsx so head.test.ts can check the shipped GLB
// actually has every one — a re-export of the asset that dropped or renamed a
// target would otherwise fail silently (morphSetter no-ops on unknown names).

/** Expression morphs the design sliders own. */
export const SLIDERS: { name: string; label: string }[] = [
  { name: "smile", label: "Smile" },
  { name: "smileMouth", label: "Grin" },
  { name: "mouthCornersUp", label: "Corners up" },
  { name: "mouthCornersDown", label: "Corners down" },
  { name: "browLift", label: "Brow lift" },
  { name: "browFurrow", label: "Brow furrow" },
  { name: "browConcern", label: "Concern" },
  { name: "eyeWiden", label: "Eyes wide" },
  { name: "eyeSquint", label: "Squint" },
  { name: "cheekRaise", label: "Cheeks" },
  { name: "curiosityMouth", label: "Curiosity" },
  { name: "surpriseMouth", label: "Surprise" },
];

/** VRM viseme -> GNM oral morphs.
 *
 *  VrmLipSync speaks in the five VRM presets; the GNM head has no VRM
 *  expressions but a strictly richer oral rig, so each preset is spent across a
 *  vowel plus the jaw and lip rounding a VRM folds into its shapes.
 *
 *  Lives here rather than next to the adapter so head.test.ts can assert the
 *  shipped GLB actually has every morph named — an unknown name is a silent
 *  no-op, so a renamed target would just quietly stop moving the mouth. */
export const GNM_VISEME: Record<string, Record<string, number>> = {
  aa: { vowel_AA: 1.0, jawOpen: 0.75 },
  ih: { vowel_IH: 1.0, jawOpen: 0.2 },
  ou: { vowel_OO: 1.0, mouthPucker: 0.5, jawOpen: 0.15 },
  ee: { vowel_EE: 1.0, jawOpen: 0.15 },
  oh: { vowel_OH: 1.0, mouthFunnel: 0.4, jawOpen: 0.45 },
};

/** Every mouth morph the lipsync touches — zeroed each frame before it writes,
 *  so a design slider can never leave the jaw hanging open between lines. */
export const MOUTH = [...new Set(Object.values(GNM_VISEME).flatMap((m) => Object.keys(m)))];

/** Idle life + look direction. */
export const AMBIENT = ["blinkLeft", "blinkRight", "gazeLeft", "gazeRight", "gazeUp", "gazeDown"];

export const DRIVEN = [...SLIDERS.map((s) => s.name), ...MOUTH, ...AMBIENT];
