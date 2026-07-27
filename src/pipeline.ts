// Client-side pipeline state (cast, tracers, sound, finals) plus every
// generation helper. State persists in localStorage per storyboard id.
// Uses localStorage for local-only projects. The isolated load/save boundary can
// be replaced with server-backed persistence without changing these data shapes.
import { API_BASE, authHeaders, blobToDataUrl, chatCompletion, submitJob, uploadMedia, type JobModel, type JobStatus, type Shot } from "./api";
import { kindOf, type PS } from "./shared";
import type { StudioExportPlan } from "./studioTimeline";

export type Artifact = { url: string; content_type: string; key?: string };
export type Character = {
  id: string;
  name: string;
  description: string;
  approved: boolean;
  prompt: string; // extra styling for the driving image, optional
  image: Artifact | null;
};
export type TracerPoint = { t: number; x: number; y: number }; // t in [0,10]s, x/y normalized 0–1
export type Tracer = {
  id: string;
  characterId: string | null; // null = camera/object
  kind: "move" | "speech";
  path: TracerPoint[];
  text?: string;
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
  tracers: Tracer[];
  tracerImage: Artifact | null;
  voices: Record<string, Artifact>; // tracerId → generated voice line
  finalPrompt: string;
  finalClip: Artifact | null;
  refIntent?: RefIntent; // optional — old docs default to "full-scene"
  cameraMove?: string; // solved camera-move description from a reference clip
  staleFinal?: boolean; // upstream edited after the final rendered
};
export type Pipeline = {
  characters: Character[];
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
  tracerImage: null,
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
    beats: {},
    musicPrompt: "",
    music: null,
    mix: null,
  };
}

export function savePipeline(id: string, p: Pipeline): void {
  pipeMem.set(id, structuredClone(p)); // full doc for this session, always
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
    for (const b of Object.values(slim.beats)) {
      b.tracerImage = strip(b.tracerImage);
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

// The default final-render prompt: beat text + tracer motion + solved camera
// move + reference-intent instruction (reuses the existing motionSummary).
export function buildFinalPrompt(beatText: string, ext: BeatExt, chars: Character[]): string {
  const nameOf = (id: string | null) => chars.find((c) => c.id === id)?.name || (id ? "subject" : "camera");
  return (
    [beatText.trim(), motionSummary(ext.tracers, nameOf), ext.cameraMove, refIntentOf(ext).instruction, "10 second cinematic shot"]
      .filter(Boolean)
      .join(". ") + "."
  );
}

// The driving images for a beat — optional, and everything works without them.
// Capped at 4 (multi_reference limit) by genImage.
export const beatRefs = (p: Pipeline, ext: BeatExt): string[] =>
  p.characters
    .filter((c) => ext.characterIds.includes(c.id))
    .map((c) => c.image?.url)
    .filter((u): u is string => !!u);

/* ── model picking — the server's models list decides what's live ── */

// Edit endpoints whose reference param is a list (`images`). flux2-dev's `edit`
// takes exactly one (`image`), so it can only ever carry the first reference.
const LIST_EDIT = /qwen|\bmage/i;
export function pickModel(
  models: JobModel[],
  want: "image" | "image_refs" | "image_edit" | "video" | "motion_video" | "tts" | "music",
): JobModel | undefined {
  const has = (m: JobModel, re: RegExp) => re.test(`${m.model} ${m.endpoint} ${m.note || ""}`);
  // Naming a specific checkpoint must read the model id only. Notes are prose
  // and mention other models ("use qwen-image.edit for…"), so matching them
  // picks whatever the note talks about instead of what the entry is.
  const named = (m: JobModel, re: RegExp) => re.test(m.model);
  // s2v/lipsync models are speech-driven and the pose-enhance model is control-video
  // driven — neither takes our text+refs final-render params, so they must not open
  // the final-render lane (paid jobs would just fail). `ltx-enhance` matches /ltx/.
  const isVid = (m: JobModel) => has(m, /video|ltx|wan|kling|veo/i) && !has(m, /s2v|lipsync|enhance|pose/i);
  const isAud = (m: JobModel) => has(m, /music|acestep|tts|speech|voice|kokoro|audio/i);
  switch (want) {
    case "video":
      return models.find((m) => isVid(m) && m.endpoint === "multi_reference") || models.find(isVid);
    case "motion_video":
      return models.find((m) => m.endpoint === "enhance" && has(m, /ltx|pose|motion|control/i));
    case "tts":
      return models.find((m) => has(m, /tts|speech|voice|kokoro/i));
    case "music":
      return models.find((m) => has(m, /music|acestep/i));
    case "image_edit":
      // Editing an existing still, never regenerating it from scratch. Mage-Flow's
      // edit checkpoint wins when the account exposes it; flux2-dev edit until then.
      // \bmage, because "mage" is also the tail of "i-mage" and "qwen-i-mage".
      return (
        models.find((m) => m.endpoint === "edit" && named(m, /\bmage/i)) || models.find((m) => m.endpoint === "edit")
      );
    case "image_refs":
      // The reference-driven render. Qwen's edit checkpoint is the
      // identity-lock path and is Apache-2.0, so it leads; flux2-dev's
      // multi_reference is the fallback. Mage-Flow-Edit is deliberately NOT
      // preferred here — it returns the content gate's blank placeholder for
      // 2+ references plus a descriptive prompt (verified on the box), and it
      // only reaches this lane if nothing else on the account can take refs.
      return (
        models.find((m) => m.endpoint === "edit" && named(m, /qwen/i)) ||
        models.find((m) => !isVid(m) && m.endpoint === "multi_reference") ||
        models.find((m) => !isVid(m) && m.endpoint === "edit")
      );
    default:
      // Mage-Flow-Turbo is the plain-generation default (fast, MIT-licensed);
      // flux2-dev stays the fallback where the account doesn't expose it.
      return (
        models.find((m) => m.endpoint === "generate" && named(m, /\bmage/i)) ||
        models.find((m) => m.model === "flux2-dev" && m.endpoint === "generate") ||
        models.find((m) => m.endpoint === "generate" && !isVid(m) && !isAud(m)) ||
        models[0]
      );
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
    ? pickModel(ps.models, "video")
    : refs.length
      ? pickModel(ps.models, "image_refs") || pickModel(ps.models, "image")
      : pickModel(ps.models, "image");
  if (!m) throw new Error(opts?.video ? "no video model available right now" : "no image model available");
  const params: Record<string, unknown> = { prompt };
  if (refs.length && m.endpoint === "multi_reference") params.images = refs;
  else if (refs.length && m.endpoint === "edit") {
    // Qwen documents 1-3 references as its optimal range, so don't hand it a
    // fourth. flux2-dev's edit keeps only the first — that lane loses the rest.
    if (LIST_EDIT.test(m.model)) params.images = refs.slice(0, 3);
    else params.image = refs[0];
  }
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
export async function ttsLine(ps: PS, text: string, voice?: string): Promise<Artifact> {
  const m = pickModel(ps.models, "tts");
  if (m) return runJob(ps, m, { text, ...(voice?.trim() ? { voice_description: voice.trim() } : {}) });
  return ttsDirect(ps.apiKey, text, voice);
}

async function ttsFetch(apiKey: string, text: string, voice?: string, path = "/api/v1/tts", signal?: AbortSignal): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "content-type": "application/json" },
    body: JSON.stringify({ text, ...(voice?.trim() ? { voice_description: voice.trim() } : {}) }),
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
export function ttsStream(apiKey: string, text: string, voice?: string, signal?: AbortSignal): Promise<Response> {
  return ttsFetch(apiKey, text, voice, "/api/v1/tts/stream", signal);
}

/** Raw wav bytes, straight to decodeAudioData.
 *
 *  Playback does not need an Artifact URL, so this path avoids a base64 encode
 *  and decode round trip for inline audio. */
export async function ttsBytes(apiKey: string, text: string, voice?: string): Promise<ArrayBuffer> {
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
export async function ttsDirect(apiKey: string, text: string, voice?: string): Promise<Artifact> {
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
async function chatJSON<T>(apiKey: string, system: string, user: string): Promise<T> {
  const content = await chatCompletion(apiKey, [
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = Math.min(...["{", "["].map((c) => text.indexOf(c)).filter((i) => i !== -1));
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (!isFinite(start) || end <= start) throw new Error("copilot: no JSON in reply");
  return JSON.parse(text.slice(start, end + 1));
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

export async function bakeTracerPng(ps: PS, tracers: Tracer[], chars: Character[]): Promise<Artifact> {
  const W = 1280;
  const H = 720;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d")!;
  ctx.lineWidth = 6;
  ctx.font = "600 22px monospace";
  ctx.lineJoin = "round";
  for (const t of tracers) {
    const col = colorFor(chars, t.characterId);
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    if (t.path.length > 1) {
      ctx.beginPath();
      t.path.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)));
      ctx.stroke();
      // arrowhead on the last segment
      const a = t.path[t.path.length - 2];
      const b = t.path[t.path.length - 1];
      const ang = Math.atan2(b.y * H - a.y * H, b.x * W - a.x * W);
      ctx.beginPath();
      ctx.moveTo(b.x * W, b.y * H);
      ctx.lineTo(b.x * W - 18 * Math.cos(ang - 0.5), b.y * H - 18 * Math.sin(ang - 0.5));
      ctx.lineTo(b.x * W - 18 * Math.cos(ang + 0.5), b.y * H - 18 * Math.sin(ang + 0.5));
      ctx.fill();
    }
    for (const p of t.path) {
      ctx.beginPath();
      ctx.arc(p.x * W, p.y * H, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(`${p.t.toFixed(1)}s`, p.x * W + 12, p.y * H - 12);
    }
    if (t.kind === "speech" && t.text && t.path[0])
      ctx.fillText(`“${t.text}”`, t.path[0].x * W + 12, t.path[0].y * H + 30);
  }
  const blob = await new Promise<Blob>((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error("bake failed"))), "image/png"));
  return storeArtifact(ps, blob, `tracer-${Date.now()}.png`);
}

/* ── sound mix — OfflineAudioContext → WAV → media ── */
// Browser mix; a server assembly job is preferable for long runtimes.
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
