// Per-beat render-readiness score — the "is this beat ready for the expensive
// final render?" gate SPEC-008 was missing. Pattern borrowed from Motion Previs
// Studio's quality model (weighted linear components → Ready/Review/Blocked
// bands). See THIRD_PARTY_NOTICES.md for attribution.
// Pure + deterministic so it unit-tests and can move server-side verbatim.
import type { Shot } from "./api";
import { extOf, type Pipeline } from "./pipeline";

export type Band = "ready" | "review" | "blocked";
export type BeatReadiness = {
  score: number; // 0–100
  band: Band;
  components: { key: string; label: string; value: number; weight: number; hint: string }[];
};

// weights sum to 100 — still & location dominate because the final render
// literally consumes them as reference images.
const WEIGHTS = {
  still: 25,
  location: 20,
  cast: 20,
  tracers: 15,
  voice: 10,
  prompt: 10,
} as const;

export const READY_AT = 80;
export const REVIEW_AT = 55;

export const bandOf = (score: number): Band => (score >= READY_AT ? "ready" : score >= REVIEW_AT ? "review" : "blocked");

export function beatReadiness(shot: Shot, pipe: Pipeline): BeatReadiness {
  const ext = extOf(pipe, shot.id);

  const still = shot.status === "ready" && shot.result ? 1 : 0;

  const loc = pipe.locations.find((l) => l.id === ext.locationId);
  const location = loc?.image || ext.scene ? 1 : loc ? 0.4 : 0;

  // no cast assigned may be intentional (empty landscape beat) → half credit
  const castChars = ext.characterIds.map((id) => pipe.characters.find((c) => c.id === id)).filter(Boolean);
  const cast = ext.characterIds.length === 0 ? 0.5 : castChars.length && castChars.every((c) => c!.image) ? 1 : 0.4;

  const tracers = ext.tracers.length > 0 ? 1 : 0;

  const speech = ext.tracers.filter((t) => t.kind === "speech");
  const voice = speech.length === 0 ? 1 : speech.every((t) => ext.voices[t.id]) ? 1 : speech.some((t) => ext.voices[t.id]) ? 0.5 : 0;

  const prompt = (ext.finalPrompt || shot.prompt).trim() ? 1 : 0;

  const components = [
    { key: "still", label: "Still", value: still, weight: WEIGHTS.still, hint: still ? "placeholder rendered" : "render the beat's still" },
    { key: "location", label: "Location", value: location, weight: WEIGHTS.location, hint: location === 1 ? "location art ready" : location ? "location set — generate its image" : "assign a location" },
    { key: "cast", label: "Cast", value: cast, weight: WEIGHTS.cast, hint: cast === 1 ? "driving images ready" : cast === 0.5 ? "no cast assigned (ok if intentional)" : "generate driving images for the cast" },
    { key: "tracers", label: "Tracers", value: tracers, weight: WEIGHTS.tracers, hint: tracers ? "motion drawn" : "draw motion tracers" },
    { key: "voice", label: "Voice", value: voice, weight: WEIGHTS.voice, hint: voice === 1 ? "voice lines covered" : "generate voices for speech tracers" },
    { key: "prompt", label: "Prompt", value: prompt, weight: WEIGHTS.prompt, hint: prompt ? "prompt written" : "describe the beat" },
  ];
  const score = Math.round(components.reduce((s, c) => s + c.value * c.weight, 0));
  return { score, band: bandOf(score), components };
}

export function boardReadiness(shots: Shot[], pipe: Pipeline): { score: number; band: Band; perBeat: BeatReadiness[] } {
  const perBeat = shots.map((s) => beatReadiness(s, pipe));
  const score = perBeat.length ? Math.round(perBeat.reduce((s, b) => s + b.score, 0) / perBeat.length) : 0;
  return { score, band: bandOf(score), perBeat };
}
