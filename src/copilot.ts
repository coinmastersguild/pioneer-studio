// Chat-mode copilot: one sentence in → a concrete job plan out.
// The LLM never sees raw URLs; it picks refs by media key and the client
// injects the public R2 URLs into params by content type.

import { chatCompletion, type JobModel, type MediaObject } from "./api";

export type JobPlan = {
  say: string;
  job?: {
    model: string;
    endpoint: string;
    params: Record<string, unknown>;
    refs: string[]; // media keys
  };
};

function systemPrompt(models: JobModel[], media: MediaObject[]): string {
  const modelLines = models
    .map((m) => `- ${m.model} · ${m.endpoint} (${m.credits} cr) — ${m.note || ""}`)
    .join("\n");
  const mediaLines = media.length
    ? media.map((o) => `- key: ${o.key} — ${o.name} (${o.type}, ${o.content_type})`).join("\n")
    : "(none)";
  return `You are the Pioneer Studio copilot. The user describes what they want in plain language; you pick the model, endpoint, and parameters, and wire up their references.
Respond with ONLY a JSON object, no prose, no code fences:
{"say":"<one short sentence explaining your pick — terse, technical>","job":{"model":"<model>","endpoint":"<endpoint>","params":{...},"refs":["<media key>", ...]}}
If the request needs no generation job, omit "job" and answer in "say".

Available models/endpoints:
${modelLines}

User's media (only these keys may appear in refs):
${mediaLines}

Param rules by endpoint:
- generate: {"prompt": "..."} (acestep-music also accepts "lyrics")
- batch: {"prompts": ["...", ...]} (max 10)
- edit: {"prompt": "..."} + exactly 1 image ref
- multi_reference: {"prompt": "..."} + up to 4 image refs
- lipsync: {} + 1 image ref and 1 audio ref (optionally "size": "256*256"|"480*832"|"1024*704")
- enhance: {"prompt": "...", optional "num_frames": 121|241, optional "guide_strength": 0..1, optional "width"/"height"} + exactly 1 control video ref and optionally 1 image reference sheet. The control video carries the motion — write the prompt about look, not movement.
Default width/height to 1536x896 on enhance and 1536x896 on ltx-2.3 video unless the user asks for something else; the model's own default is small and reads soft.
Never put URLs in params — the client injects ref URLs. Write the generation prompt yourself: concrete, cinematic, specific.`;
}

function parsePlan(content: string): JobPlan {
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("copilot: no JSON plan in reply");
  const obj = JSON.parse(text.slice(start, end + 1));
  if (typeof obj.say !== "string") obj.say = "";
  if (obj.job && (typeof obj.job.model !== "string" || typeof obj.job.endpoint !== "string")) delete obj.job;
  if (obj.job) {
    obj.job.params = obj.job.params && typeof obj.job.params === "object" ? obj.job.params : {};
    obj.job.refs = Array.isArray(obj.job.refs) ? obj.job.refs.filter((r: unknown) => typeof r === "string") : [];
  }
  return obj;
}

export async function requestJobPlan(
  apiKey: string,
  models: JobModel[],
  media: MediaObject[],
  userText: string,
): Promise<JobPlan> {
  const content = await chatCompletion(apiKey, [
    { role: "system", content: systemPrompt(models, media) },
    { role: "user", content: userText },
  ]);
  return parsePlan(content);
}

// Inject ref URLs into params the way each endpoint expects.
export function injectRefs(
  endpoint: string,
  params: Record<string, unknown>,
  refs: MediaObject[],
): Record<string, unknown> {
  const imgs = refs.filter((r) => r.content_type.startsWith("image/")).map((r) => r.url);
  const auds = refs.filter((r) => r.content_type.startsWith("audio/")).map((r) => r.url);
  const vids = refs.filter((r) => r.content_type.startsWith("video/")).map((r) => r.url);
  const p = { ...params };
  if (endpoint === "edit" && imgs[0]) p.image = imgs[0];
  if (endpoint === "multi_reference" && imgs.length) p.images = imgs.slice(0, 4);
  if (endpoint === "lipsync") {
    if (imgs[0]) p.image = imgs[0];
    if (auds[0]) p.audio = auds[0];
  }
  if (endpoint === "enhance") {
    if (vids[0]) p.control_video = vids[0];
    if (imgs[0]) p.reference_sheet = imgs[0];
  }
  return p;
}
