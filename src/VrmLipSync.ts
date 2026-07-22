import type { VrmMoodExpression, VrmVisemeExpression } from "./VrmFaceController";

/**
 * Audio-driven lip sync for VRM faces.
 *
 * The driver maps frequency bands onto one dominant VRM viseme
 * (`aa/ih/ou/ee/oh`) and a weight per sample. It uses no ML model or phoneme
 * alignment and has no runtime dependency beyond Web Audio.
 *
 * This driver is analysis-only and NEVER owns playback: it does not create,
 * route, or replace any audio output, so it cannot override the game's current
 * sound system. Callers keep their audio graph and merely tee a source into
 * `input` (an AnalyserNode tap that produces no sound).
 */
export interface VrmLipSyncSample {
  viseme: VrmVisemeExpression | null;
  weight: number;
}

export class VrmLipSync {
  private readonly analyser: AnalyserNode;
  private readonly bins: Uint8Array<ArrayBuffer>;
  private viseme: VrmVisemeExpression | null = null;
  private weight = 0;

  /** `smoothing` lerps the emitted weight per sample (0 = raw, 1 = frozen). */
  private readonly smoothing: number;

  constructor(context: BaseAudioContext, smoothing = 0.65) {
    this.smoothing = smoothing;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.8;
    this.bins = new Uint8Array(this.analyser.frequencyBinCount);
  }

  /** Tap point: `yourSource.connect(lipSync.input)`. Playback path untouched. */
  get input(): AudioNode {
    return this.analyser;
  }

  /** Call once per frame while audio plays; feed into VrmFaceController.setViseme. */
  sample(): VrmLipSyncSample {
    this.analyser.getByteFrequencyData(this.bins);
    const low = this.band(0, 300); // open vowels
    const mid = this.band(300, 2000); // mid vowels / bilabials
    const high = this.band(2000, 8000); // sibilants
    let volume = 0;
    for (let i = 0; i < this.bins.length; i++) volume += this.bins[i] / 255;
    volume /= this.bins.length;

    // Band → viseme thresholds carried over from the vendor heuristic, remapped
    // to the five VRM presets. Bilabials (M/B/P: mid-heavy, low-light) map to
    // the null viseme — a VRM face at rest already has closed lips.
    // These heuristic thresholds can later be replaced by TTS phoneme timestamps.
    let target: VrmVisemeExpression | null = null;
    let targetWeight = 0;
    if (volume < 0.08) {
      target = null;
    } else if (high > 0.6) {
      target = "ih";
      targetWeight = 0.35;
    } else if (low > 0.6) {
      target = "aa";
      targetWeight = Math.min(1, 0.4 + volume);
    } else if (mid > 0.5 && volume > 0.35 && low < 0.3) {
      target = null;
    } else if (mid > 0.4 && high > 0.3) {
      target = "ee";
      targetWeight = 0.6;
    } else if (low > 0.4 && mid > 0.3) {
      target = high < 0.2 ? "ou" : "oh";
      targetWeight = high < 0.2 ? 0.7 : 0.55;
    } else {
      target = "aa";
      targetWeight = volume * 0.5;
    }

    if (target !== this.viseme) this.viseme = target;
    this.weight += (targetWeight - this.weight) * (1 - this.smoothing);
    return { viseme: this.viseme, weight: this.viseme ? this.weight : 0 };
  }

  dispose(): void {
    this.analyser.disconnect();
  }

  private band(minHz: number, maxHz: number): number {
    const nyquist = this.analyser.context.sampleRate / 2;
    const width = nyquist / this.bins.length;
    const from = Math.floor(minHz / width);
    const to = Math.min(this.bins.length, Math.floor(maxHz / width));
    let sum = 0;
    for (let i = from; i < to; i++) sum += this.bins[i] / 255;
    return to > from ? sum / (to - from) : 0;
  }
}

/**
 * Prosody/emotion label → shipped VRM mood preset, for state- or
 * sentiment-driven expressions (`VrmFaceController.setMood`). Distilled from
 * the vendor's ARKit emotion tables onto our mood contract.
 */
export const EMOTION_TO_VRM_MOOD: Record<string, VrmMoodExpression> = {
  joy: "happy",
  amusement: "happy",
  excitement: "happy",
  interest: "relaxed",
  calm: "relaxed",
  sadness: "sad",
  distress: "sad",
  anger: "angry",
  fear: "fear_M",
  surprise: "surprised",
  disgust: "disgust_M",
  contempt: "contempt_M",
};
