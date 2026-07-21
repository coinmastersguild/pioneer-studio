// Ported verbatim from DegenQuest-v41 projects/game/src/demo/player/VrmFaceController.ts
// (2026-07-20). The ONLY change is `three/webgpu` -> `three`: the game
// builds against the WebGPU entry point, the studio does not. Keep the two
// copies in sync by hand until EPIC-010 S2 decides who owns this code.
import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";

export const VRM_MOOD_EXPRESSIONS = ["happy", "angry", "sad", "relaxed", "surprised", "fear_M", "disgust_M", "contempt_M"] as const;
export const VRM_VISEME_EXPRESSIONS = ["aa", "ih", "ou", "ee", "oh"] as const;
export type VrmMoodExpression = typeof VRM_MOOD_EXPRESSIONS[number];
export type VrmVisemeExpression = typeof VRM_VISEME_EXPRESSIONS[number];

type ExpressionManager = NonNullable<VRM["expressionManager"]>;
type LookAt = NonNullable<VRM["lookAt"]>;

export interface VrmFaceSnapshot {
  available: boolean;
  expressions: number;
  presets: string[];
  custom: number;
  mood: string | null;
  viseme: string | null;
  autoBlink: boolean;
  blinkWeight: number;
  lookAt: boolean;
}

/**
 * Small stateful runtime around the VRM expression/look-at systems.
 *
 * The body mixer must run first. This controller then applies eye gaze and
 * expressions, followed by pose correctives and spring bones. It deliberately
 * calls only the face components instead of `vrm.update()`, which would also
 * step springs at the wrong point in the frame.
 */
export class VrmFaceController {
  private readonly manager?: ExpressionManager;
  private readonly lookAt?: LookAt;
  private readonly gazeTarget = new THREE.Object3D();
  private mood: string | null = null;
  private viseme: string | null = null;
  private autoBlinkValue = true;
  private blinkElapsed = -1;
  private blinkWeightValue = 0;
  private untilBlink: number;
  private randomState: number;

  constructor(vrm: Pick<VRM, "expressionManager" | "lookAt">, seed = 0x51f15e) {
    this.manager = vrm.expressionManager;
    this.lookAt = vrm.lookAt;
    this.randomState = seed >>> 0;
    this.untilBlink = 1.8 + this.random() * 2.2;
  }

  get expressionNames(): string[] {
    return this.manager ? Object.keys(this.manager.expressionMap).sort() : [];
  }

  get presetExpressionNames(): string[] {
    return this.manager ? Object.keys(this.manager.presetExpressionMap).sort() : [];
  }

  hasExpression(name: string): boolean {
    return !!this.manager?.getExpression(name);
  }

  setAutoBlink(enabled: boolean): void {
    this.autoBlinkValue = enabled;
    if (!enabled) {
      this.blinkElapsed = -1;
      this.setManagedValue("blink", 0);
      this.blinkWeightValue = 0;
    }
  }

  setMood(name: string | null, weight = 1): boolean {
    if (name !== null && !this.hasExpression(name)) return false;
    if (this.mood && this.mood !== name) this.setManagedValue(this.mood, 0);
    this.mood = name;
    if (name) this.setManagedValue(name, THREE.MathUtils.clamp(weight, 0, 1));
    return true;
  }

  setViseme(name: string | null, weight = 1): boolean {
    if (name !== null && !this.hasExpression(name)) return false;
    if (this.viseme && this.viseme !== name) this.setManagedValue(this.viseme, 0);
    this.viseme = name;
    if (name) this.setManagedValue(name, THREE.MathUtils.clamp(weight, 0, 1));
    return true;
  }

  /** Set any exported preset/custom shape for authoring and debug surfaces. */
  setExpression(name: string, weight: number): boolean {
    if (!this.hasExpression(name)) return false;
    this.setManagedValue(name, THREE.MathUtils.clamp(weight, 0, 1));
    return true;
  }

  setLookAtTarget(target: THREE.Object3D | null): boolean {
    if (!this.lookAt) return false;
    this.lookAt.target = target;
    return true;
  }

  setLookAtPosition(position: THREE.Vector3 | null): boolean {
    if (!this.lookAt) return false;
    if (!position) {
      this.lookAt.target = null;
      this.lookAt.reset();
      return true;
    }
    this.gazeTarget.position.copy(position);
    this.gazeTarget.updateMatrixWorld(true);
    this.lookAt.target = this.gazeTarget;
    return true;
  }

  update(delta: number): void {
    const dt = Math.min(0.1, Math.max(0, delta));
    if (this.autoBlinkValue && this.hasExpression("blink")) this.updateBlink(dt);
    this.lookAt?.update(dt);
    this.manager?.update();
  }

  reset(): void {
    this.manager?.resetValues();
    this.manager?.update();
    this.lookAt?.reset();
    this.mood = null;
    this.viseme = null;
    this.blinkElapsed = -1;
    this.blinkWeightValue = 0;
  }

  snapshot(): VrmFaceSnapshot {
    return {
      available: !!this.manager,
      expressions: this.expressionNames.length,
      presets: this.presetExpressionNames,
      custom: this.manager ? Object.keys(this.manager.customExpressionMap).length : 0,
      mood: this.mood,
      viseme: this.viseme,
      autoBlink: this.autoBlinkValue,
      blinkWeight: Math.round(this.blinkWeightValue * 1_000) / 1_000,
      lookAt: !!this.lookAt,
    };
  }

  private updateBlink(dt: number): void {
    if (this.blinkElapsed < 0) {
      this.untilBlink -= dt;
      if (this.untilBlink > 0) return;
      this.blinkElapsed = 0;
    } else {
      this.blinkElapsed += dt;
    }
    const duration = 0.145;
    const phase = this.blinkElapsed / duration;
    if (phase >= 1) {
      this.blinkElapsed = -1;
      this.untilBlink = 2.3 + this.random() * 4.2;
      this.blinkWeightValue = 0;
    } else {
      const raw = phase < 0.42 ? phase / 0.42 : 1 - (phase - 0.42) / 0.58;
      this.blinkWeightValue = THREE.MathUtils.smoothstep(raw, 0, 1);
    }
    this.setManagedValue("blink", this.blinkWeightValue);
  }

  private setManagedValue(name: string, value: number): void {
    this.manager?.setValue(name, value);
  }

  private random(): number {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
    return this.randomState / 0x1_0000_0000;
  }
}
