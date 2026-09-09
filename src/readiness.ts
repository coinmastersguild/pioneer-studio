// Per-beat render-readiness score — the "is this beat ready for the expensive
// final render?" gate. Pattern borrowed from Motion Previs
// Studio's quality model (weighted linear components → Ready/Review/Blocked
// bands). See THIRD_PARTY_NOTICES.md for attribution.
// Pure + deterministic so it unit-tests and can move server-side verbatim.
import type { Shot } from "./api";
import { extOf, geographyIssues, type Pipeline } from "./pipeline";

export type Band = "ready" | "review" | "blocked";
export type BeatReadiness = {
  score: number; // 0–100
  band: Band;
  components: { key: string; label: string; value: number; weight: number; hint: string }[];
};

// Weights sum to 100. Still and geography are equal hard concerns: the final
// render needs both a frame to animate and a spatial contract it cannot invent.
const WEIGHTS = {
  still: 25,
  geography: 25,
  cast: 20,
  tracers: 15,
  voice: 5,
  prompt: 10,
} as const;

export const READY_AT = 80;
export const REVIEW_AT = 55;

export const bandOf = (score: number): Band => (score >= READY_AT ? "ready" : score >= REVIEW_AT ? "review" : "blocked");

export function beatReadiness(shot: Shot, pipe: Pipeline): BeatReadiness {
  const ext = extOf(pipe, shot.id);

  const still = shot.status === "ready" && shot.result ? 1 : 0;
  const geographyProblems = geographyIssues(shot, pipe, ext);
  const geography = geographyProblems.length ? 0 : 1;

  // Unresolved empty cast gets half credit. A deliberately cast-free insert is
  // complete without injecting a character reference that would contaminate it.
  const castChars = ext.characterIds.map((id) => pipe.characters.find((c) => c.id === id)).filter(Boolean);
  const cast = ext.characterIds.length === 0 ? (ext.castIntentionalEmpty ? 1 : 0.5) : castChars.length && castChars.every((c) => c!.image) ? 1 : 0.4;

  // Motion direction specifically — a speech tracer carries a line, not blocking,
  // and crediting it here would let a beat look "ready" while still handing the
  // video model no idea what moves. That is the frozen-tableau failure.
  const tracers = ext.tracers.some((t) => t.kind === "move") ? 1 : 0;

  const speech = ext.tracers.filter((t) => t.kind === "speech");
  const voice = speech.length === 0 ? 1 : speech.every((t) => ext.voices[t.id]) ? 1 : speech.some((t) => ext.voices[t.id]) ? 0.5 : 0;

  const prompt = (ext.finalPrompt || shot.prompt).trim() ? 1 : 0;

  const components = [
    { key: "still", label: "Still", value: still, weight: WEIGHTS.still, hint: still ? "placeholder rendered" : "render the beat's still" },
    { key: "geography", label: "Geography", value: geography, weight: WEIGHTS.geography, hint: geography ? "world, route, and location locked" : geographyProblems[0] },
    { key: "cast", label: "Cast", value: cast, weight: WEIGHTS.cast, hint: ext.castIntentionalEmpty ? "intentionally no visible cast" : cast === 1 ? "driving images ready" : cast === 0.5 ? "no cast assigned (ok if intentional)" : "generate driving images for the cast" },
    { key: "tracers", label: "Tracers", value: tracers, weight: WEIGHTS.tracers, hint: tracers ? "motion drawn" : ext.tracers.length ? "speech only — draw motion tracers" : "draw motion tracers" },
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
