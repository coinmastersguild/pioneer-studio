// Flows — the control graphs the chat can run as cards. A flow is one job with
// named slots you fill by dropping files on it; the card uploads whatever you
// drop and hands back the R2 URL, so a slot value is always a public URL (or
// plain text for a text slot).
//
// Deliberately one job per flow, not a DAG: every useful chain we have today is
// a single call whose inputs are files. Multi-step graphs can wait for a real
// two-job chain — the slot/fill/run machinery below already carries one.
import type { JobModel } from "./api";

export type SlotKind = "video" | "image" | "audio" | "text";
export type FlowSlot = {
  id: string;
  kind: SlotKind;
  label: string;
  hint: string;
  required: boolean;
  /** text slots only — prefilled, editable */
  preset?: string;
};
export type FlowChoice = { id: string; label: string; options: { value: string; label: string }[]; preset: string };
/** The before/after that sells the flow. Shown on the card until the user has
 *  filled it in, so an untouched card still demonstrates what it does.
 *  `in` is what you bring, `out` is what the flow returns. */
export type FlowSample = {
  in: { url: string; kind: "image" | "video"; caption: string }[];
  out: { url: string; kind: "image" | "video"; caption: string };
};
export type Flow = {
  id: string;
  title: string;
  blurb: string;
  /** what the copilot says when it walks you into this flow — also shown on the
   *  card as numbered steps, so a card opened from the rail explains itself */
  walkthrough: string[];
  /** absent until we have shot one; the card degrades to steps-only */
  sample?: FlowSample;
  model: string;
  endpoint: string;
  slots: FlowSlot[];
  choices?: FlowChoice[];
  build(v: Record<string, string>): Record<string, unknown>;
};

// The control take is 768×448. 2× keeps that exact aspect, so the pose lines up
// with the frame instead of being letterboxed or stretched into it.
const SIZES = [
  { value: "1536x896", label: "1536×896 — sharp (2× the control take)" },
  { value: "768x448", label: "768×448 — matches the control take exactly" },
];
const dims = (v: string) => {
  const [width, height] = v.split("x").map(Number);
  return { width, height };
};

// Shot with the flows themselves, on the account's own storage.
const R2 = "https://pub-8b9f695d1cd040a485bb217292272f65.r2.dev/media/0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E";

export const FLOWS: Flow[] = [
  {
    id: "video-control",
    title: "Video → controlled video",
    blurb: "Any video drives the motion. A character sheet holds the identity. Nothing is authored by hand.",
    walkthrough: [
      "Drop a source video on the control slot — an ARDY take from the Animation stage, or real footage.",
      "Drop a character sheet on the identity slot so every frame keeps the same face and wardrobe.",
      "Describe only the look: lighting, lens, grade. The video owns the motion, so don't re-describe it.",
    ],
    sample: {
      in: [
        { url: `${R2}/24c01edfdaa24aee4cc22ca5c82388b4ecddf022bc3c89b64aa1ca561a2ac8c6.mp4`, kind: "video", caption: "cskel27 control take" },
      ],
      out: { url: `${R2}/af3ea603524ebba08c1a37392804a9f37e350139d2211cedd53d52db0b72948d.mp4`, kind: "video", caption: "1536×896 · 1000 cr" },
    },
    model: "ltx-enhance",
    endpoint: "enhance",
    slots: [
      { id: "control", kind: "video", label: "Control video", hint: "ARDY take or real footage — this is the motion", required: true },
      { id: "sheet", kind: "image", label: "Identity sheet", hint: "character sheet or portrait", required: false },
      { id: "prompt", kind: "text", label: "Look", hint: "lighting, lens, grade — not motion", required: true,
        preset: "cinematic live-action finish, consistent character identity, detailed environment, shallow depth of field" },
    ],
    choices: [
      { id: "size", label: "Output size", options: SIZES, preset: "1536x896" },
      {
        id: "frames",
        label: "Length",
        options: [
          { value: "121", label: "121 frames · ~5s · 1000 cr" },
          { value: "241", label: "241 frames · ~10s · 2000 cr" },
        ],
        preset: "121",
      },
      {
        id: "guide",
        label: "Pose hold",
        options: [
          { value: "1", label: "1.00 — the control video is law" },
          { value: "0.85", label: "0.85 — mostly held, some interpretation" },
          { value: "0.7", label: "0.70 — loose, the model gets room" },
        ],
        preset: "1",
      },
    ],
    build: (v) => ({
      prompt: v.prompt,
      // argues against the dissolve the reference sheet bleeds into frame one
      negative_prompt: "double exposure, ghosting, transparent overlay, superimposed still image, cross-fade, watermark, text, low resolution, blurry",
      control_video: v.control,
      ...(v.sheet ? { reference_sheet: v.sheet } : {}),
      ...dims(v.size || "1536x896"),
      num_frames: Number(v.frames || 121),
      frame_rate: 24,
      guide_strength: Number(v.guide || 1),
    }),
  },
  {
    id: "sheet-to-video",
    title: "Character sheet → video",
    blurb: "Up to four stills become keyframes spread across the timeline. No control video needed.",
    walkthrough: [
      "Drop one to four images — each becomes a keyframe, in order, across the clip.",
      "Describe the motion here: with no control video, the prompt is the only thing driving it.",
    ],
    sample: {
      in: [
        { url: `${R2}/c3b32e65ce501fe56d2f638fc1057068d3e359006a1154faf357f8fcc7817514.png`, kind: "image", caption: "one character render" },
      ],
      out: { url: `${R2}/ab13ef3e79c00fa5c14761b0ac79d5e2497ef2230720affa6a55b66b88368f3f.mp4`, kind: "video", caption: "10s game capture · identity held · 750 cr" },
    },
    model: "ltx-2.3",
    endpoint: "multi_reference",
    slots: [
      { id: "images", kind: "image", label: "Keyframes", hint: "1–4 stills, in timeline order", required: true },
      { id: "prompt", kind: "text", label: "Motion + look", hint: "what moves, and how it is shot", required: true },
    ],
    choices: [{ id: "size", label: "Output size", options: SIZES, preset: "1536x896" }],
    build: (v) => ({
      prompt: v.prompt,
      images: v.images.split("\n").filter(Boolean).slice(0, 4),
      ...dims(v.size || "1536x896"),
      num_frames: 240,
      frame_rate: 24,
    }),
  },
  {
    id: "talking-head",
    title: "Portrait + voice → talking head",
    blurb: "One portrait and one audio file become a lip-synced performance.",
    walkthrough: [
      "Drop a portrait and an audio file. Generate the audio first in chat if you don't have one.",
      "Pick a size — the credit cost is set by the size, not the length.",
    ],
    model: "wan-s2v",
    endpoint: "lipsync",
    slots: [
      { id: "image", kind: "image", label: "Portrait", hint: "front-facing, one subject", required: true },
      { id: "audio", kind: "audio", label: "Voice", hint: "wav or mp3 — drives the mouth", required: true },
    ],
    choices: [
      {
        id: "size",
        label: "Size",
        options: [
          { value: "1024*704", label: "1024×704 · 1000 cr" },
          { value: "480*832", label: "480×832 · 500 cr" },
          { value: "256*256", label: "256×256 · 250 cr" },
        ],
        preset: "480*832",
      },
    ],
    build: (v) => ({ image: v.image, audio: v.audio, size: v.size || "480*832" }),
  },
];

export const flowById = (id: string): Flow | undefined => FLOWS.find((f) => f.id === id);

/** A flow is live only when the account actually exposes its model+endpoint. */
export const flowIsLive = (f: Flow, models: JobModel[]): boolean =>
  models.some((m) => m.model === f.model && m.endpoint === f.endpoint);

/** Which required slots are still empty — the card's Run gate, and the copilot's
 *  "what do you still owe me" line. */
export function missingSlots(f: Flow, v: Record<string, string>): FlowSlot[] {
  return f.slots.filter((s) => s.required && !(v[s.id] || "").trim());
}

/** "Pull the pose out of this video" — the one flow that runs locally, so it is
 *  matched ahead of the job flows (which also mention skeletons and control). */
export function wantsSkeleton(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(extract|estimate|track|read|get|pull)\b[^.]*\b(pose|skeleton|motion|rig)\b/.test(t) ||
    /\b(pose|skeleton|motion)\b[^.]*\bfrom\b[^.]*\b(video|footage|clip)\b/.test(t) ||
    /\bvideo\s*(→|->|to)\s*skeleton\b/.test(t) ||
    /\b(dwpose|rotoscope|mocap)\b/.test(t)
  );
}

/** Plain-language pick from a typed sentence. Keyword match, not an LLM call:
 *  the flows are few and named, and a wrong pick costs a click to dismiss. */
export function matchFlow(text: string): Flow | undefined {
  const t = text.toLowerCase();
  if (/\b(lip.?sync|talking head|make (him|her|them) talk|say this)\b/.test(t)) return flowById("talking-head");
  if (/\b(control|pose|skeleton|ardy|drive|motion transfer|dance)\b/.test(t) && /\bvideo\b/.test(t)) return flowById("video-control");
  if (/\b(character sheet|keyframe|still|sheet)\b/.test(t) && /\b(video|animate|clip)\b/.test(t)) return flowById("sheet-to-video");
  return undefined;
}
