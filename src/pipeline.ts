// Client-side pipeline state (cast, tracers, sound, finals) plus every
// generation helper. State persists in localStorage per storyboard id.
// Uses localStorage for local-only projects. The isolated load/save boundary can
// be replaced with server-backed persistence without changing these data shapes.
import { activeProjectPipeline, API_BASE, authHeaders, blobToDataUrl, captionImage, chatCompletion, saveActiveProjectPipeline, submitJob, uploadMedia, type JobModel, type JobStatus, type ChatMessage, type Shot } from "./api";
import { kindOf, type PS } from "./shared";
import { classifyJobModel, preferredEntry, type JobCapability } from "./jobCatalog";
import type { StudioExportPlan } from "./studioTimeline";

export type Artifact = { url: string; content_type: string; key?: string };
export type Character = {
  id: string;
  name: string;
  description: string;
  approved: boolean;
  prompt: string; // extra styling for the driving image, optional
  voice?: string; // natural-language voice design — how the voice is authored
  // Minted from `voice`, and the thing that actually holds identity across
  // lines. The clip is kept so an evicted id can be re-minted to the same id
  // (the server content-addresses it), which is what makes a saved cast
  // survive a server restart.
  voiceId?: string;
  voiceClip?: string; // base64 reference audio, as /voice returned it
  image: Artifact | null;
};
export type LocationKind = "zone" | "transition";
export type ScreenDirection = "left-to-right" | "right-to-left" | "toward-camera" | "away-camera" | "hold";
export type BeatMovement = "hold" | "enter" | "cross" | "exit" | "arrive";
export type WorldLayout = {
  name: string;
  description: string;
  approved: boolean;
  map: Artifact | null;
  rules: string[];
  forbiddenElements: string[];
};
export type Location = {
  id: string;
  name: string;
  description: string;
  approved: boolean;
  prompt: string;
  image: Artifact | null;
  sourceBeatId?: string;
  kind?: LocationKind;
  mapX?: number;
  mapY?: number;
  adjacentTo?: string[];
  allowedElements?: string[];
  forbiddenElements?: string[];
};
export type BeatGeography = {
  movement: BeatMovement;
  screenDirection: ScreenDirection;
  entryFromId?: string;
  exitToId?: string;
  anchor?: string;
};
export type TracerPoint = { t: number; x: number; y: number }; // t in [0,10]s, x/y normalized 0–1
export type Tracer = {
  id: string;
  characterId: string | null; // null = camera/object
  kind: "move" | "speech";
  path: TracerPoint[];
  text?: string;
};
export type AudioCue = {
  at: number; // seconds from the start of this beat
  speaker: string;
  text: string;
};
// Reference intent — what the final render should preserve from the beat's
// reference material. An intent label + prompt templating switch, NOT a compute
// branch (a pattern adapted from the Apache-2.0 Motion Previs Studio project).
export type RefIntent = "camera-only" | "actor-motion" | "object-motion" | "full-scene";
export const REF_INTENTS: { id: RefIntent; label: string; hint: string; instruction: string }[] = [
  { id: "camera-only", label: "Camera only", hint: "Keep just the camera move and timing; replace the subject and world.", instruction: "Preserve only the camera movement and shot timing; freely reinterpret the subject and environment." },
  { id: "actor-motion", label: "Actor motion", hint: "Preserve body motion plus the camera move.", instruction: "Preserve the characters' body motion and blocking along with the camera move; keep identities from the reference images." },
  { id: "object-motion", label: "Object motion", hint: "Preserve an object or vehicle path plus the camera move.", instruction: "Preserve the object/vehicle path and the camera move; the subject may be restyled but its trajectory must match." },
  { id: "full-scene", label: "Full scene", hint: "Preserve camera, blocking, motion, and depth rhythm.", instruction: "Preserve the camera move, blocking, subject motion, and overall depth rhythm of the scene." },
];
export const refIntentOf = (ext: BeatExt): (typeof REF_INTENTS)[number] =>
  REF_INTENTS.find((r) => r.id === ext.refIntent) || REF_INTENTS[3];

export type BeatExt = {
  characterIds: string[];
  locationId?: string;
  geography?: BeatGeography;
  audioCues?: AudioCue[]; // authored master-mix narration; never becomes lip sync
  castIntentionalEmpty?: boolean;
  tracers: Tracer[];
  voices: Record<string, Artifact>; // tracerId → generated voice line
  finalPrompt: string;
  finalClip: Artifact | null;
  refIntent?: RefIntent; // optional — old docs default to "full-scene"
  cameraMove?: string; // solved camera-move description from a reference clip
  staleFinal?: boolean; // upstream edited after the final rendered
};
export type Pipeline = {
  characters: Character[];
  locations?: Location[];
  world?: WorldLayout;
  beats: Record<string, BeatExt>;
  musicPrompt: string;
  music: Artifact | null;
  mix: Artifact | null;
  mixStale?: boolean; // a beat was edited/deleted after the mix rendered
  release?: { url: string; duration: number; createdAt: string } | null; // last server master
};

// Upstream edits flag downstream artifacts as stale (kept, not
// deleted — the user decides whether to re-run). Call inside a mut().
export function markBeatEdited(p: Pipeline, beatId: string): void {
  const ext = p.beats[beatId];
  if (ext?.finalClip) ext.staleFinal = true;
  if (p.mix) p.mixStale = true;
}

export const BEAT_SECONDS = 10;
export const newId = () => Math.random().toString(36).slice(2, 9);

export const emptyExt = (): BeatExt => ({
  characterIds: [],
  tracers: [],
  voices: {},
  finalPrompt: "",
  finalClip: null,
});

const KEY = (id: string) => `ps_pipeline_${id}`;

// In-memory copy of each pipeline doc (like api.ts's sbMem): localStorage's
// quota guard strips large data: artifacts (a 30s WAV mix blows the ~5MB cap),
// so within a session every view must read the same full doc, not the slim one.
const pipeMem = new Map<string, Pipeline>();

export function loadPipeline(id: string): Pipeline {
  const projectPipeline = activeProjectPipeline(id) as Pipeline | undefined;
  if (projectPipeline) {
    pipeMem.set(id, structuredClone(projectPipeline));
    return structuredClone(projectPipeline);
  }
  const m = pipeMem.get(id);
  if (m) return structuredClone(m);
  try {
    const raw = localStorage.getItem(KEY(id));
    if (raw) {
      const p = JSON.parse(raw) as Pipeline;
      pipeMem.set(id, structuredClone(p));
      return p;
    }
  } catch {
    /* corrupt → fresh */
  }
  return {
    characters: [],
    locations: [],
    beats: {},
    musicPrompt: "",
    music: null,
    mix: null,
  };
}

export function savePipeline(id: string, p: Pipeline): void {
  pipeMem.set(id, structuredClone(p)); // full doc for this session, always
  saveActiveProjectPipeline(id, p);
  try {
    localStorage.setItem(KEY(id), JSON.stringify(p));
    return;
  } catch {
    /* quota — inline data: artifacts are big; persist without them */
  }
  try {
    const strip = (a: Artifact | null) => (a && a.url.startsWith("data:") ? null : a);
    const slim: Pipeline = structuredClone(p);
    slim.characters.forEach((c) => (c.image = strip(c.image)));
    if (slim.world) slim.world.map = strip(slim.world.map);
    (slim.locations || []).forEach((location) => (location.image = strip(location.image)));
    for (const b of Object.values(slim.beats)) {
      b.finalClip = strip(b.finalClip);
      b.voices = Object.fromEntries(Object.entries(b.voices).filter(([, v]) => !v.url.startsWith("data:")));
    }
    slim.music = strip(slim.music);
    slim.mix = strip(slim.mix);
    localStorage.setItem(KEY(id), JSON.stringify(slim));
  } catch {
    /* still too big — this session keeps the in-memory copy */
  }
}

export function extOf(p: Pipeline, beatId: string): BeatExt {
  return p.beats[beatId] || emptyExt();
}

export function upsertCharacter(p: Pipeline, character: Character): Character {
  const id = character.id.trim();
  const name = character.name.trim();
  if (!id) throw new Error("character id is required");
  if (!name) throw new Error("character name is required");
  if (character.image?.url) {
    const imageUrl = character.image.url;
    if (!/^https?:\/\//i.test(imageUrl) && !/^data:image\//i.test(imageUrl))
      throw new Error("character image must be an http(s) URL or data:image URL");
  }
  const next: Character = {
    id,
    name,
    description: character.description.trim(),
    approved: character.approved,
    prompt: character.prompt.trim(),
    voice: (character.voice || "").trim(),
    ...(character.voiceId ? { voiceId: character.voiceId } : {}),
    ...(character.voiceClip ? { voiceClip: character.voiceClip } : {}),
    image: character.image ? { ...character.image } : null,
  };
  const at = p.characters.findIndex((c) => c.id === id);
  if (at === -1) p.characters.push(next);
  else p.characters[at] = next;
  return structuredClone(next);
}

/** What to send TTS so a line sounds like a particular character.
 *
 *  A `voice_description` is re-synthesized per call, so the same description
 *  gives a different speaker on every line (measured: 0.62-0.74 similarity
 *  across texts, against 0.50 for a genuinely different person). A `voice_id`
 *  is conditioned on stored reference audio and holds at 0.85. So a character
 *  with a minted id gets the id; anything else gets the model default, which
 *  is at least audibly wrong rather than subtly wrong. */
export type VoiceRef = { voice_id: string } | { voice_description: string } | undefined;

export function voiceFor(p: Pipeline, characterId: string | null): VoiceRef {
  const c = characterId ? p.characters.find((x) => x.id === characterId) : undefined;
  return c?.voiceId ? { voice_id: c.voiceId } : undefined;
}

export function upsertLocation(p: Pipeline, location: Location): Location {
  const id = location.id.trim();
  const name = location.name.trim();
  if (!id) throw new Error("location id is required");
  if (!name) throw new Error("location name is required");
  if (location.image?.url) {
    const imageUrl = location.image.url;
    if (!/^https?:\/\//i.test(imageUrl) && !/^data:image\//i.test(imageUrl))
      throw new Error("location image must be an http(s) URL or data:image URL");
  }
  const next: Location = {
    id,
    name,
    description: location.description.trim(),
    approved: location.approved,
    prompt: location.prompt.trim(),
    image: location.image ? { ...location.image } : null,
    sourceBeatId: location.sourceBeatId?.trim() || undefined,
    kind: location.kind === "transition" ? "transition" : "zone",
    mapX: Math.max(0, Math.min(100, Number.isFinite(location.mapX) ? Number(location.mapX) : 50)),
    mapY: Math.max(0, Math.min(100, Number.isFinite(location.mapY) ? Number(location.mapY) : 50)),
    adjacentTo: [...new Set((location.adjacentTo || []).map((item) => item.trim()).filter((item) => item && item !== id))],
    allowedElements: [...new Set((location.allowedElements || []).map((item) => item.trim()).filter(Boolean))],
    forbiddenElements: [...new Set((location.forbiddenElements || []).map((item) => item.trim()).filter(Boolean))],
  };
  const locations = (p.locations ??= []);
  const at = locations.findIndex((item) => item.id === id);
  if (at === -1) locations.push(next);
  else locations[at] = next;
  return structuredClone(next);
}

const artifactUrlOkay = (artifact: Artifact | null) =>
  !artifact?.url || /^https?:\/\//i.test(artifact.url) || /^data:image\//i.test(artifact.url);

export function worldLayoutOf(p: Pipeline): WorldLayout {
  return p.world || { name: "", description: "", approved: false, map: null, rules: [], forbiddenElements: [] };
}

export function setWorldLayout(p: Pipeline, world: WorldLayout): WorldLayout {
  if (!world.name.trim()) throw new Error("world layout name is required");
  if (!artifactUrlOkay(world.map)) throw new Error("world map must be an http(s) URL or data:image URL");
  const next: WorldLayout = {
    name: world.name.trim(),
    description: world.description.trim(),
    approved: !!world.approved,
    map: world.map ? { ...world.map } : null,
    rules: [...new Set(world.rules.map((item) => item.trim()).filter(Boolean))],
    forbiddenElements: [...new Set(world.forbiddenElements.map((item) => item.trim()).filter(Boolean))],
  };
  p.world = next;
  for (const beatId of Object.keys(p.beats)) markBeatEdited(p, beatId);
  return structuredClone(next);
}

export function locationsAdjacent(p: Pipeline, fromId: string, toId: string): boolean {
  if (fromId === toId) return true;
  const from = (p.locations || []).find((location) => location.id === fromId);
  const to = (p.locations || []).find((location) => location.id === toId);
  return !!from && !!to && (!!from.adjacentTo?.includes(toId) || !!to.adjacentTo?.includes(fromId));
}

export function assignBeatCast(p: Pipeline, beatId: string, characterIds: string[], intentionalEmpty = false): BeatExt {
  const ids = [...new Set(characterIds.map((id) => id.trim()).filter(Boolean))];
  const known = new Set(p.characters.map((c) => c.id));
  const unknown = ids.find((id) => !known.has(id));
  if (unknown) throw new Error(`unknown character "${unknown}"`);
  if (intentionalEmpty && ids.length) throw new Error("intentional-empty cast cannot include character ids");
  const ext = { ...extOf(p, beatId), characterIds: ids, castIntentionalEmpty: intentionalEmpty };
  p.beats[beatId] = ext;
  markBeatEdited(p, beatId);
  return structuredClone(ext);
}

export function assignBeatLocation(p: Pipeline, beatId: string, locationId: string): BeatExt {
  const id = locationId.trim();
  if (!(p.locations || []).some((location) => location.id === id)) throw new Error(`unknown location "${id}"`);
  const current = extOf(p, beatId);
  const ext = { ...current, locationId: id, geography: current.locationId === id ? current.geography : undefined };
  p.beats[beatId] = ext;
  markBeatEdited(p, beatId);
  return structuredClone(ext);
}

export function assignBeatGeography(
  p: Pipeline,
  beatId: string,
  plan: BeatGeography & { locationId: string },
): BeatExt {
  const locationId = plan.locationId.trim();
  if (!(p.locations || []).some((location) => location.id === locationId)) throw new Error(`unknown location "${locationId}"`);
  for (const linkedId of [plan.entryFromId, plan.exitToId].filter((id): id is string => !!id)) {
    if (!(p.locations || []).some((location) => location.id === linkedId)) throw new Error(`unknown location "${linkedId}"`);
    if (!locationsAdjacent(p, linkedId, locationId)) throw new Error(`location "${linkedId}" is not adjacent to "${locationId}"`);
  }
  const movement: BeatMovement = ["hold", "enter", "cross", "exit", "arrive"].includes(plan.movement) ? plan.movement : "hold";
  const screenDirection: ScreenDirection = ["left-to-right", "right-to-left", "toward-camera", "away-camera", "hold"].includes(plan.screenDirection)
    ? plan.screenDirection
    : "hold";
  const ext = {
    ...extOf(p, beatId),
    locationId,
    geography: {
      movement,
      screenDirection,
      entryFromId: plan.entryFromId?.trim() || undefined,
      exitToId: plan.exitToId?.trim() || undefined,
      anchor: plan.anchor?.trim() || undefined,
    },
  };
  p.beats[beatId] = ext;
  markBeatEdited(p, beatId);
  return structuredClone(ext);
}

const uniqueStrings = (items: Array<string | undefined>) => [...new Set(items.map((item) => item?.trim()).filter((item): item is string => !!item))];

export function geographyPrompt(p: Pipeline, ext: BeatExt): string {
  const location = (p.locations || []).find((item) => item.id === ext.locationId);
  if (!location) return "";
  const byId = (id?: string) => (p.locations || []).find((item) => item.id === id)?.name;
  const route = uniqueStrings([byId(ext.geography?.entryFromId), location.name, byId(ext.geography?.exitToId)]).join(" → ");
  const world = worldLayoutOf(p);
  const bans = uniqueStrings([...world.forbiddenElements, ...(location.forbiddenElements || [])]);
  return [
    `World geography is locked to ${world.name || "the approved world map"}`,
    `Current location: ${location.name}. ${location.description}`,
    route && `Route: ${route}`,
    ext.geography && `Blocking: ${ext.geography.movement}, screen direction ${ext.geography.screenDirection}${ext.geography.anchor ? `, anchor ${ext.geography.anchor}` : ""}`,
    location.allowedElements?.length && `Only established location elements: ${location.allowedElements.join(", ")}`,
    world.rules.length && `Continuity rules: ${world.rules.join("; ")}`,
    bans.length && `Never introduce: ${bans.join(", ")}`,
    "Do not invent a new location, landmark, structure, prop, or route",
  ].filter(Boolean).join(". ") + ".";
}

export function geographyIssues(shot: Pick<Shot, "prompt">, p: Pipeline, ext: BeatExt = emptyExt()): string[] {
  const issues: string[] = [];
  const world = worldLayoutOf(p);
  const location = (p.locations || []).find((item) => item.id === ext.locationId);
  if (!world.approved) issues.push("approve the world geography");
  if (!world.map?.url) issues.push("generate or attach the master bird's-eye map");
  if (!location) issues.push("assign a canonical location");
  else {
    if (!location.approved) issues.push("approve the assigned location");
    if (!location.image?.url) issues.push("generate or attach the eye-level location plate");
    if (!location.sourceBeatId) issues.push("choose the correct source beat for this location");
  }
  if (!ext.geography) issues.push("plan beat movement and screen direction");
  else if (location) {
    for (const linkedId of [ext.geography.entryFromId, ext.geography.exitToId].filter((id): id is string => !!id)) {
      if (!locationsAdjacent(p, linkedId, location.id)) issues.push(`route ${linkedId} → ${location.id} is not adjacent on the world map`);
    }
  }
  const bans = uniqueStrings([...world.forbiddenElements, ...(location?.forbiddenElements || [])]);
  const prompt = shot.prompt.toLowerCase();
  for (const banned of bans) {
    const escaped = banned.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const hit of prompt.matchAll(new RegExp(`\\b${escaped}\\b`, "gi"))) {
      // A prompt carrying its own negative canon ("…; no desert, fortress, bells")
      // bans the thing — it does not introduce it. Flagging those trains everyone
      // to ignore the gate, and then real violations hide in the noise.
      const clause = prompt.slice(0, hit.index ?? 0).split(/[.;!?]/).pop() || "";
      if (/\b(?:no|never|not|without|avoid|exclude|free of)\b/.test(clause)) continue;
      issues.push(`prompt introduces forbidden geography "${banned}"`);
      break;
    }
  }
  return issues;
}

// The animatic cut: one item per beat, playing whatever it already has — the
// final video clip if rendered, else its still held for the beat length, else a
// black frame for an un-rendered beat. Upgrades to real clips (and a
// server-muxed master when allVideo) with zero UI change as they land.
export type PreviewItem = { kind: "video" | "still"; url?: string; seconds: number; label: string };
export type PreviewCut = { items: PreviewItem[]; audio: string | null; allVideo: boolean; skipped: number };

export function buildPreviewCut(shots: Shot[], pipe: Pipeline): PreviewCut {
  let skipped = 0;
  const items: PreviewItem[] = shots.map((s, i) => {
    const label = `Beat ${i + 1}`;
    const seconds = s.sourceDuration ?? BEAT_SECONDS;
    const fin = extOf(pipe, s.id).finalClip;
    if (fin) return { kind: "video", url: fin.url, seconds, label };
    if (s.result) {
      const isVideo = kindOf(s.result.content_type, s.result.url) === "video";
      return { kind: isVideo ? "video" : "still", url: s.result.url, seconds, label };
    }
    skipped++;
    return { kind: "still", seconds, label }; // no url → black frame
  });
  const allVideo = items.length > 0 && items.every((it) => it.kind === "video");
  return { items, audio: pipe.mix?.url || null, allVideo, skipped };
}

/** The prompt that drives the video is not the beat's description. The still is
 *  handed to the model as the frame it animates, so re-describing what is
 *  already visible spends the prompt fighting the picture. A driving prompt
 *  says what CHANGES: the action as it progresses, the camera, the pacing. */
export async function writeDrivingPrompt(
  apiKey: string,
  stillUrl: string,
  beatText: string,
  motion: string,
): Promise<string> {
  const intent = [beatText.trim() && `What the beat is: ${beatText.trim()}`, motion && `Staged motion: ${motion}`]
    .filter(Boolean)
    .join("\n");
  return captionImage(
    apiKey,
    stillUrl,
    `This image is the opening frame of a 10-second shot and is already given to the video model as its reference, so do NOT describe appearance, wardrobe, setting, or style — it can see all of that.
Write only what CHANGES across the ten seconds: the subject's action and how it progresses, the camera move, and the pacing.
Two or three sentences, present tense, concrete physical motion. No preamble, no quotes, no shot-list headings.
${intent}`,
  );
}

// The default final-render prompt: beat text + tracer motion + solved camera
// move + reference-intent instruction (reuses the existing motionSummary).
export function buildFinalPrompt(beatText: string, ext: BeatExt, pipe: Pipeline): string {
  const nameOf = (id: string | null) => pipe.characters.find((c) => c.id === id)?.name || (id ? "subject" : "camera");
  return (
    [beatText.trim(), geographyPrompt(pipe, ext), motionSummary(ext.tracers, nameOf), ext.cameraMove, refIntentOf(ext).instruction, "10 second cinematic shot"]
      .filter(Boolean)
      .join(". ") + "."
  );
}

// The driving images for a beat — optional, and everything works without them.
// Capped at 4 (multi_reference limit) by genImage.
export const beatRefs = (p: Pipeline, ext: BeatExt): string[] => {
  const location = (p.locations || []).find((item) => item.id === ext.locationId)?.image?.url;
  const characters = p.characters
    .filter((c) => ext.characterIds.includes(c.id))
    .map((c) => c.image?.url)
    .filter((u): u is string => !!u);
  return [location, ...characters].filter((url): url is string => !!url).slice(0, 4);
};

/* ── model picking — the server's models list decides what's live ── */

export function pickModel(
  models: JobModel[],
  want: JobCapability | "image_edit" | "video_text" | "tts",
): JobModel | undefined {
  const inLane = (lane: JobCapability) => models.filter((model) => classifyJobModel(model) === lane);
  switch (want) {
    case "video":
      return preferredEntry(inLane("video_refs")) || preferredEntry(inLane("video"));
    case "video_text":
      return preferredEntry(inLane("video").filter((model) => model.endpoint === "generate"));
    case "motion_video":
      return preferredEntry(inLane("motion_video"));
    case "tts":
      return preferredEntry(inLane("speech"));
    case "music":
      return preferredEntry(inLane("music"));
    case "image_edit":
      return preferredEntry(models.filter((model) => model.endpoint === "edit" && ["image", "image_refs"].includes(classifyJobModel(model))));
    case "image_refs":
      return preferredEntry(inLane("image_refs"));
    case "image":
      return preferredEntry(inLane("image").filter((model) => model.endpoint === "generate"));
    default:
      return preferredEntry(inLane(want));
  }
}

/* ── jobs ── */
// every status the server reports on a job, submit included
export type JobWatcher = (s: JobStatus) => void;

async function runJob(ps: PS, m: JobModel, params: Record<string, unknown>, onPoll?: JobWatcher): Promise<Artifact> {
  const sub = await submitJob(ps.apiKey, m.model, m.endpoint, params);
  ps.charge(sub.credits_remaining ?? null);
  onPoll?.({ job_id: sub.job_id, status: sub.status || "queued", stage: null, error: null });
  const { url, contentType } = await ps.waitForJob(sub.job_id, onPoll);
  return { url, content_type: contentType };
}

// image (or video when video:true) generation with optional image refs
export async function genImage(
  ps: PS,
  prompt: string,
  opts?: { refs?: string[]; video?: boolean },
): Promise<Artifact> {
  const refs = (opts?.refs || []).filter(Boolean).slice(0, 4);
  const m = opts?.video
    ? pickModel(ps.models, refs.length ? "video" : "video_text")
    : refs.length
      ? pickModel(ps.models, "image_refs") || pickModel(ps.models, "image")
      : pickModel(ps.models, "image");
  if (!m) throw new Error(opts?.video ? "no video model available right now" : "no image model available");
  const params: Record<string, unknown> = { prompt };
  if (refs.length && m.endpoint === "multi_reference") params.images = refs;
  else if (refs.length && m.endpoint === "edit") {
    // The live schema decides whether this edit accepts an ordered reference
    // list or a single source image.
    if (m.params?.images?.type === "list-of-path-or-url") params.images = refs;
    else params.image = refs[0];
  }
  // The v6 identity-drift bug, made unreachable. A ref-less video render is
  // text→video: the model re-invents every character from prose, so the same
  // character came back a grey ogre in one shot and a golden lion in the next.
  // And when refs ARE supplied but the picked endpoint has no slot for them,
  // the block above silently drops them — same failure, no error. Both throw.
  if (opts?.video && !refs.length) throw new Error("a final clip must animate a still — render the beat's still first");
  if (refs.length && !("images" in params) && !("image" in params))
    throw new Error(`${m.model}.${m.endpoint} takes no reference images — cast identity would be re-invented`);
  return runJob(ps, m, params);
}

export async function genMusic(ps: PS, prompt: string): Promise<Artifact> {
  const m = pickModel(ps.models, "music");
  if (!m) throw new Error("no music model live on this account");
  return runJob(ps, m, { prompt });
}

/** The reference sheet bleeds into the opening frames as a semi-transparent
 *  dissolve rather than conditioning identity, so every enhance job argues
 *  against that by default. Callers can override. */
export const ENHANCE_NEGATIVE =
  "double exposure, ghosting, transparent overlay, superimposed still image, cross-fade, watermark, text, low resolution, blurry";

/** Finish an authored ARDY skeleton take through LTX pose control. This is a
 * distinct capability from ordinary text/keyframe video: the control video is
 * the motion contract, while the optional reference sheet supplies identity. */
export async function enhanceMotionVideo(
  ps: PS,
  prompt: string,
  controlVideo: string,
  opts?: { referenceSheet?: string; fullLength?: boolean; guideStrength?: number; seed?: number; negativePrompt?: string; onPoll?: JobWatcher },
): Promise<Artifact> {
  const m = pickModel(ps.models, "motion_video");
  if (!m) throw new Error("pose-controlled LTX is not available right now");
  return runJob(
    ps,
    m,
    {
      prompt,
      negative_prompt: opts?.negativePrompt ?? ENHANCE_NEGATIVE,
      control_video: controlVideo,
      ...(opts?.referenceSheet ? { reference_sheet: opts.referenceSheet } : {}),
      width: 768,
      height: 448,
      num_frames: opts?.fullLength ? 241 : 121,
      frame_rate: 24,
      guide_strength: opts?.guideStrength ?? 1,
      ...(opts?.seed == null ? {} : { seed: opts.seed }),
    },
    opts?.onPoll,
  );
}

// TTS: use a listed jobs model or fall back to the direct /api/v1/tts route.
// Both accept `text`, not `prompt`. `voice` is the model's optional natural-
// language `voice_description`, passed through on both paths.
export async function ttsLine(ps: PS, text: string, voice?: VoiceRef): Promise<Artifact> {
  const m = pickModel(ps.models, "tts");
  if (m) return runJob(ps, m, { text, ...(voice ?? {}) });
  return ttsDirect(ps.apiKey, text, voice);
}

/** Mint a voice. Pass a description to design one, or the base64 clip from an
 *  earlier mint to get the SAME id back — the server content-addresses the
 *  reference audio, so re-minting after a cache eviction is not a new voice. */
export async function mintVoice(apiKey: string, from: { voice_description: string } | { reference_audio: string }): Promise<{ voice_id: string; reference_audio: string }> {
  const res = await fetch(`${API_BASE}/api/v1/voice`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "content-type": "application/json" },
    body: JSON.stringify(from),
  });
  if (!res.ok) throw new Error(`voice: ${res.status}`);
  const body = await res.json();
  if (!body.voice_id) throw new Error("voice: no voice_id in reply");
  return { voice_id: body.voice_id, reference_audio: body.reference_audio || "" };
}

/** Speak a line as a character, in that character's own voice, every time.
 *
 *  Mints the voice on first use and stores {voiceId, voiceClip} on the
 *  character, so every later line — this session or next year — conditions on
 *  the same reference audio. If the server has evicted the id, the stored clip
 *  re-mints to the same id and the line is retried once; that is the whole
 *  restart story.
 *
 *  A character with no `voice` written gets the model default, deliberately:
 *  a wrong-but-consistent default is easier to notice than a voice that drifts. */
export async function speakAs(
  ps: PS,
  p: Pipeline,
  characterId: string | null,
  text: string,
  mut: (fn: (p: Pipeline) => void) => void,
): Promise<Artifact> {
  const character = characterId ? p.characters.find((c) => c.id === characterId) : undefined;
  const design = character?.voice?.trim();
  if (!character || !design) return ttsLine(ps, text, undefined);

  const save = (voiceId: string, voiceClip: string) =>
    mut((draft) => {
      const c = draft.characters.find((x) => x.id === character.id);
      if (c) Object.assign(c, { voiceId, voiceClip });
    });

  let ref = character.voiceId;
  if (!ref) {
    const minted = await mintVoice(ps.apiKey, { voice_description: design });
    save((ref = minted.voice_id), minted.reference_audio);
    character.voiceId = minted.voice_id;
    character.voiceClip = minted.reference_audio;
  }
  try {
    return await ttsLine(ps, text, { voice_id: ref });
  } catch (err) {
    if (!isVoiceGone(err) || !character.voiceClip) throw err;
    const again = await mintVoice(ps.apiKey, { reference_audio: character.voiceClip });
    save(again.voice_id, character.voiceClip);
    return ttsLine(ps, text, { voice_id: again.voice_id });
  }
}

/** A voice_id the server has evicted. Recoverable — we hold the clip. */
export const isVoiceGone = (err: unknown) => /^tts: 404$/.test(String((err as Error)?.message));

async function ttsFetch(apiKey: string, text: string, voice?: VoiceRef, path = "/api/v1/tts", signal?: AbortSignal): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "content-type": "application/json" },
    body: JSON.stringify({ text, ...(voice ?? {}) }),
    signal,
  });
  if (!res.ok) throw new Error(`tts: ${res.status}`);
  return res;
}

/** Chunked PCM16LE as the model decodes, instead of waiting on the whole wav.
 *
 *  The streaming path starts promptly for longer input, so callers do not need
 *  to split responses into clauses before playback.
 *
 *  Body is raw samples with no wav container, so the format lives only in
 *  X-Sample-Rate/-Channels/-Sample-Format. Hand the Response to playPcmStream. */
export function ttsStream(apiKey: string, text: string, voice?: VoiceRef, signal?: AbortSignal): Promise<Response> {
  return ttsFetch(apiKey, text, voice, "/api/v1/tts/stream", signal);
}

/** Raw wav bytes, straight to decodeAudioData.
 *
 *  Playback does not need an Artifact URL, so this path avoids a base64 encode
 *  and decode round trip for inline audio. */
export async function ttsBytes(apiKey: string, text: string, voice?: VoiceRef): Promise<ArrayBuffer> {
  const res = await ttsFetch(apiKey, text, voice);
  if ((res.headers.get("content-type") || "").includes("json")) {
    const body = await res.json();
    if (!body.url) throw new Error("tts: no audio in reply");
    return (await fetch(body.url)).arrayBuffer();
  }
  return res.arrayBuffer();
}

/** Direct TTS path: no submit/poll cycle or storage round trip. Conversation
 *  uses this; storyboard audio uses the jobs path because it needs a persisted
 *  media asset. */
export async function ttsDirect(apiKey: string, text: string, voice?: VoiceRef): Promise<Artifact> {
  const res = await ttsFetch(apiKey, text, voice);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) {
    const body = await res.json();
    if (body.url) return { url: body.url, content_type: body.content_type || "audio/mpeg" };
    throw new Error("tts: no audio in reply");
  }
  // raw audio bytes → inline (media API is 404 on accounts without R2)
  return { url: await blobToDataUrl(await res.blob()), content_type: ct || "audio/wav" };
}

/* ── copilot proposers — strict-JSON chat calls ── */
/** Walk a model reply and pull out the first balanced top-level JSON value (object
 *  or array). `JSON.parse` on a naive `lastIndexOf` slice dies when the model wrote
 *  unescaped quotes, and trailing prose after the value throws the parser; a
 *  depth-counting walk stops at the depth-0 closing token that truly closes the
 *  value. Prose that mentions braces (e.g. `like {x: 1}`) is skipped because only
 *  the balanced top-level slice is returned. */
function jsonSlice(text: string): string {
  const sliceFrom = (start: number): string => {
    const opens = text[start] === "{" ? "{" : "[";
    const closes = opens === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === opens) depth++;
      else if (c === closes) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return "";
  };
  const o = text.indexOf("{");
  const a = text.indexOf("[");
  if (o === -1 && a === -1) return "";
  // Prefer the longest balanced slice: when the reply is `[ {...}, {...} ]` the
  // array starts before the first object, so the array slice is the full value;
  // longest-wins keeps prose braces from being mistaken for the value.
  const obj = o !== -1 ? sliceFrom(o) : "";
  const arr = a !== -1 ? sliceFrom(a) : "";
  if (obj && arr) return obj.length >= arr.length ? obj : arr;
  return obj || arr;
}

async function chatJSON<T>(apiKey: string, system: string, user: string): Promise<T> {
  const base: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const parse = (raw: string): T => {
    let text = raw.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();
    const slice = jsonSlice(text);
    if (!slice) throw new Error("copilot: no JSON in reply");
    try {
      return JSON.parse(slice) as T;
    } catch {
      throw new Error("copilot: malformed JSON in reply");
    }
  };
  const first = await chatCompletion(apiKey, base);
  try {
    return parse(first);
  } catch (e) {
    // The reply had no JSON (or broken JSON) — nudge once with the JSON-only rule
    // made explicit, then parse the retry. Mirrors requestJobPlan's recovery.
    const retry = await chatCompletion(apiKey, [
      ...base,
      { role: "assistant", content: first },
      { role: "user", content: "Reply with ONLY the JSON — no prose, no code fences." },
    ]);
    return parse(retry);
  }
}

const beatLines = (beats: { id: string; prompt: string }[]) =>
  beats.map((b, i) => `beat ${i + 1} (id=${b.id}): ${b.prompt || "(empty)"}`).join("\n");

// Propose a cast from either the beat list or a free prompt the user typed
// ("a grumpy detective and his robot dog in noir LA").
export async function proposeRoster(
  apiKey: string,
  source: string | { id: string; prompt: string }[],
): Promise<{ name: string; description: string }[]> {
  const text = typeof source === "string" ? source : beatLines(source);
  const arr = await chatJSON<{ name: string; description: string }[]>(
    apiKey,
    `You are a film pre-production assistant. From the input, list the distinct characters (people, animals, creatures).
Respond ONLY with a JSON array: [{"name":"...","description":"<visual description for a character sheet: species/build/clothing/colors, 1-2 sentences>"}]. No prose.`,
    text,
  );
  return Array.isArray(arr) ? arr : [];
}

export async function proposeTracers(
  apiKey: string,
  beatText: string,
  chars: { id: string; name: string }[],
): Promise<Tracer[]> {
  const raw = await chatJSON<Omit<Tracer, "id">[]>(
    apiKey,
    `You block a 10-second shot. Given the beat and its characters, propose motion paths and speech.
Coordinates are normalized (x,y in 0..1, y=0 top), time t in seconds 0..10.
Respond ONLY with a JSON array of:
{"characterId":"<id or null for camera/object>","kind":"move","path":[{"t":0,"x":0.1,"y":0.6},...]} (2-5 points)
or {"characterId":"<id>","kind":"speech","path":[{"t":2.5,"x":0.4,"y":0.5}],"text":"<the spoken line>"}. No prose.`,
    `beat: ${beatText}\ncharacters:\n${chars.map((c) => `- id=${c.id} ${c.name}`).join("\n")}`,
  );
  return (Array.isArray(raw) ? raw : []).map((t) => ({
    ...t,
    id: newId(),
    path: (t.path || []).map((p) => ({ t: +p.t || 0, x: +p.x || 0, y: +p.y || 0 })),
  }));
}

// plain-english motion summary — feeds the final video prompt
export function motionSummary(tracers: Tracer[], nameOf: (id: string | null) => string): string {
  const side = (x: number) => (x < 0.33 ? "frame left" : x > 0.66 ? "frame right" : "center frame");
  return tracers
    .map((t) => {
      const a = t.path[0];
      if (!a) return "";
      if (t.kind === "speech") return `${nameOf(t.characterId)} says "${t.text || ""}" at ${a.t.toFixed(1)}s`;
      const b = t.path[t.path.length - 1];
      return `${nameOf(t.characterId)} moves from ${side(a.x)} to ${side(b.x)} between ${a.t.toFixed(0)}s and ${b.t.toFixed(0)}s`;
    })
    .filter(Boolean)
    .join("; ");
}

/* ── tracer overlay → transparent PNG in R2 ── */
export const TRACER_COLORS = ["#4ade80", "#facc15", "#38bdf8", "#f472b6", "#a3e635", "#fb923c"];
export const colorFor = (chars: Character[], id: string | null) =>
  id === null ? "#e2e8f0" : TRACER_COLORS[Math.max(0, chars.findIndex((c) => c.id === id)) % TRACER_COLORS.length];

// Upload an artifact blob to media/R2 when the account has it; inline data: URL
// otherwise (media POST 404s on R2-less accounts). Real URLs survive the
// localStorage quota strip and keep assemble payloads small.
async function storeArtifact(ps: PS, blob: Blob, name: string): Promise<Artifact> {
  if (ps.apiKey) {
    try {
      const up = await uploadMedia(ps.apiKey, new File([blob], name, { type: blob.type }));
      ps.refreshMedia();
      return { url: up.url, content_type: up.content_type, key: up.key };
    } catch {
      /* no media API on this account → inline */
    }
  }
  return { url: await blobToDataUrl(blob), content_type: blob.type };
}

export async function mixAudio(
  ps: PS,
  parts: { url: string; at: number; gain?: number }[],
  durationSec: number,
): Promise<Artifact> {
  const sr = 44100;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(durationSec * sr)), sr);
  for (const part of parts) {
    const bytes = await (await fetch(part.url)).arrayBuffer();
    const buf = await ctx.decodeAudioData(bytes);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = part.gain ?? 1;
    src.connect(g).connect(ctx.destination);
    src.start(Math.max(0, part.at));
  }
  const rendered = await ctx.startRendering();
  return storeArtifact(ps, encodeWav(rendered), `mix-${Date.now()}.wav`);
}

function encodeWav(buf: AudioBuffer): Blob {
  const n = buf.length;
  const ch = buf.numberOfChannels;
  const bytes = 44 + n * ch * 2;
  const ab = new ArrayBuffer(bytes);
  const v = new DataView(ab);
  const wr = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  wr(0, "RIFF");
  v.setUint32(4, bytes - 8, true);
  wr(8, "WAVE");
  wr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, buf.sampleRate, true);
  v.setUint32(28, buf.sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  wr(36, "data");
  v.setUint32(40, n * ch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, buf.getChannelData(c)[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  return new Blob([ab], { type: "audio/wav" });
}

/* ── assemble — server endpoint when it lands, null → caller previews in-app ── */
export async function assembleRelease(
  apiKey: string,
  timeline: StudioExportPlan,
): Promise<{ url?: string; job_id?: string; credits_remaining?: number | null } | null> {
  const res = await fetch(`${API_BASE}/api/v1/storyboard/assemble`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "content-type": "application/json" },
    body: JSON.stringify({ timeline }),
  });
  if (res.status === 404 || res.status === 405 || res.status === 501) return null; // not live yet
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `assemble: ${res.status}`);
  return body;
}
