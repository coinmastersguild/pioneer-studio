// Chat-mode copilot: one sentence in → a concrete job plan out.
// The LLM never sees raw URLs; it picks refs by media key and the client
// injects the public R2 URLs into params by content type.

import { captionImage, chatCompletion, type ChatMessage, type JobModel, type MediaObject, type Storyboard } from "./api";
import { extOf, type Pipeline } from "./pipeline";
import { boardReadiness } from "./readiness";
import { DEFAULT_AXES, type Contract } from "./workLoop";

/** The board as the copilot needs to see it: what exists, what is missing, and
 *  where the work actually stands. Without this it answers questions about the
 *  storyboard by describing the media list, which is not the same thing. */
export function boardBrief(board: Storyboard | null, pipe: Pipeline | null): string {
  if (!board || !board.shots?.length) return "Storyboard: empty — no beats yet.";
  const shots = board.shots;
  const lines: string[] = [];
  if (pipe) {
    const { score, band } = boardReadiness(shots, pipe);
    lines.push(
      `Storyboard "${board.title || "untitled"}": ${shots.length} beats × 10s = ${shots.length * 10}s, phase ${pipe.phase}, readiness ${score}% (${band}).`,
    );
    const cast = pipe.characters.map((c) => `${c.name}${c.approved ? "" : " (unapproved)"}${c.image ? "" : " (no image)"}`);
    lines.push(`Cast: ${cast.length ? cast.join(", ") : "none"}. Locations: ${pipe.locations.map((l) => l.name).join(", ") || "none"}.`);
    lines.push(`Music: ${pipe.music ? "rendered" : pipe.musicPrompt ? `prompt only — "${pipe.musicPrompt}"` : "none"}.`);
  } else {
    lines.push(`Storyboard "${board.title || "untitled"}": ${shots.length} beats.`);
  }
  lines.push("Beats:");
  for (const [i, s] of shots.entries()) {
    const ext = pipe ? extOf(pipe, s.id) : null;
    const bits = [
      s.status === "ready" && s.result ? "still ✓" : s.status === "empty" ? "no still" : s.status,
      ext?.finalClip ? "final clip ✓" : null,
      ext?.tracers.length ? `${ext.tracers.length} tracers` : null,
      ext?.characterIds.length ? `cast ${ext.characterIds.length}` : null,
    ].filter(Boolean);
    lines.push(`  ${i + 1}. ${s.prompt ? `"${s.prompt.slice(0, 70)}"` : "(no text)"} — ${bits.join(", ")}`);
  }
  return lines.join("\n");
}

export type JobPlan = {
  say: string;
  /** the copilot needs one more thing before it can act */
  ask?: { question: string; options: string[] };
  /** open a control-flow card instead of firing a one-shot job */
  flow?: string;
  job?: {
    model: string;
    endpoint: string;
    params: Record<string, unknown>;
    refs: string[]; // media keys
  };
};

function systemPrompt(models: JobModel[], media: MediaObject[], brief: string): string {
  const modelLines = models
    .map((m) => `- ${m.model} · ${m.endpoint} (${m.credits} cr) — ${m.note || ""}`)
    .join("\n");
  const mediaLines = media.length
    ? media.map((o) => `- key: ${o.key} — ${o.name} (${o.type}, ${o.content_type})`).join("\n")
    : "(none)";
  return `You are the Pioneer Studio copilot. The user describes what they want in plain language; you pick the model, endpoint, and parameters, and wire up their references.
Respond with ONLY a JSON object, no prose, no code fences:
{"say":"<one or two sentences — terse, technical, specific>", ...one of "ask" | "flow" | "job", or none}

You drive this studio. Every reply does exactly one of four things:

1. ASK — a detail is missing that would change the output. Emit
   {"say":"...","ask":{"question":"<one question>","options":["<2-4 concrete answers>"]}}
   Ask ONE question at a time, and only when the answer changes what you would produce.
   Never ask about something the user already told you or that the state below answers.
   Two questions is usually plenty; when you have enough, act.
2. FLOW — the request needs files the user must supply (a control video, a portrait,
   an audio bed) or is a multi-input pipeline. Emit {"say":"...","flow":"<flow id>"} and
   the card collects the inputs. Prefer this over inventing refs the user did not mention.
3. JOB — you have everything. Emit the "job" object below.
4. Neither — a question about state or a plain answer: just "say".

{"job":{"model":"<model>","endpoint":"<endpoint>","params":{...},"refs":["<media key>", ...]}}

Control flows you can open by id:
- video-control — a video drives the motion, a character sheet holds identity, LTX renders it
- sheet-to-video — 1-4 stills become keyframes of a video
- talking-head — a portrait plus audio becomes a lip-synced performance
- skeleton — pull a cskel27 pose control take out of real footage, locally and free

When asked about the state of the project — status, what is left, what is missing, is it ready —
answer from the STORYBOARD STATE below, naming actual beats and what each one lacks. Never
answer a question about the storyboard by describing the media library; they are different things.

STORYBOARD STATE
${brief}

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
  if (obj.ask && typeof obj.ask.question !== "string") delete obj.ask;
  if (obj.ask) obj.ask.options = Array.isArray(obj.ask.options) ? obj.ask.options.filter((o: unknown) => typeof o === "string").slice(0, 4) : [];
  if (obj.flow && typeof obj.flow !== "string") delete obj.flow;
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
  brief = "Storyboard: not loaded.",
  history: ChatMessage[] = [],
): Promise<JobPlan> {
  const content = await chatCompletion(apiKey, [
    { role: "system", content: systemPrompt(models, media, brief) },
    ...history,
    { role: "user", content: userText },
  ]);
  return parsePlan(content);
}

/** PLANNER role. Turns a goal into a contract — what "done" looks like — before
 *  a single credit is spent. Deliberately a separate call from the evaluator:
 *  a model that grades its own rubric grades itself generous. */
export async function proposeContract(
  apiKey: string,
  models: JobModel[],
  goal: string,
): Promise<{ contract: Contract; job: { model: string; endpoint: string; params: Record<string, unknown> } | null }> {
  const modelLines = models.map((m) => `- ${m.model} · ${m.endpoint} (${m.credits} cr) — ${m.note || ""}`).join("\n");
  const raw = await chatCompletion(apiKey, [
    {
      role: "system",
      content: `You plan work for an AI production studio. Given a goal, write the contract that decides whether the finished artifact is acceptable, and the job that produces the first attempt.

Reply with ONLY JSON, no fences:
{"contract":{"goal":"<restated in one line>","assertions":["<6-12 concrete, checkable claims about the finished artifact>"],"target":<0.7-0.9>,"maxAttempts":<2-4>},
 "job":{"model":"<model>","endpoint":"<endpoint>","params":{"prompt":"<the full generation prompt you would send>"}}}

Assertions are things an evaluator can look at the result and check — "the character wears a yellow hi-vis vest", "the horizon is level", "there is no visible text". Not vibes: not "looks cinematic", not "high quality".
Pick the cheapest model that can satisfy the goal. Write the prompt yourself, concrete and specific.

Available models:
${modelLines}`,
    },
    { role: "user", content: goal },
  ]);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const o = JSON.parse(raw.slice(start, end + 1));
  const c = o.contract || {};
  const assertions = Array.isArray(c.assertions) ? c.assertions.filter((a: unknown) => typeof a === "string") : [];
  return {
    contract: {
      goal: typeof c.goal === "string" && c.goal ? c.goal : goal,
      assertions,
      axes: DEFAULT_AXES,
      target: Math.min(0.95, Math.max(0.5, Number(c.target) || 0.8)),
      maxAttempts: Math.min(5, Math.max(1, Number(c.maxAttempts) || 3)),
      creditCeiling: 0, // the user sets this — never the model
    },
    job:
      o.job && typeof o.job.model === "string" && typeof o.job.endpoint === "string"
        ? { model: o.job.model, endpoint: o.job.endpoint, params: o.job.params || {} }
        : null,
  };
}

/** EVALUATOR role. Told from the first token that the artifact is suspect and
 *  its job is to find where it misses the contract — grading against the
 *  assertions only, never against its own taste. */
export async function scoreAgainstContract(
  apiKey: string,
  contract: Contract,
  imageUrl: string,
): Promise<{ perAxis: Record<string, number>; notes: string; fix: string }> {
  const raw = await captionImage(
    apiKey,
    imageUrl,
    `You are grading a render against a contract that was agreed before it was made. Assume it falls short somewhere and find where.

GOAL: ${contract.goal}
IT MUST BE TRUE THAT:
${contract.assertions.map((a, i) => `${i + 1}. ${a}`).join("\n")}

Score each axis 0..1 against those assertions only, not against your own taste:
${contract.axes.map((a) => `- ${a.name} (weight ${a.weight})`).join("\n")}

Reply with ONLY JSON, no fences:
{"perAxis":{${contract.axes.map((a) => `"${a.name}":<0..1>`).join(",")}},"notes":"<one sentence naming the assertions that failed, by number>","fix":"<an edit instruction that repairs the biggest miss, or empty string if every assertion holds>"}`,
  );
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const o = JSON.parse(raw.slice(start, end + 1));
    const perAxis: Record<string, number> = {};
    for (const a of contract.axes) perAxis[a.name] = Number(o.perAxis?.[a.name]) || 0;
    return { perAxis, notes: String(o.notes || "").trim(), fix: String(o.fix || "").trim() };
  } catch {
    return { perAxis: {}, notes: raw.slice(0, 200), fix: "" };
  }
}

export type Critique = { ok: boolean; notes: string; fix: string };

/** Look at what came back and say whether it is what was asked for.
 *
 *  `fix` is written as an edit instruction, not a fresh prompt: the result is
 *  already most of the way there, so the repair belongs on the edit endpoint
 *  with the render itself as input. */
export async function critiqueResult(apiKey: string, intent: string, imageUrl: string): Promise<Critique> {
  const raw = await captionImage(
    apiKey,
    imageUrl,
    `The user asked for: "${intent}".
Judge the image against that request only. Reply with ONLY JSON, no fences:
{"ok": true|false, "notes":"<one sentence — what landed, and what missed>", "fix":"<an edit instruction that would repair the miss, or empty string if nothing needs fixing>"}
Be specific and concrete. Do not invent problems: if it matches the request, say ok true with an empty fix.`,
  );
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const o = JSON.parse(raw.slice(start, end + 1));
    return { ok: o.ok !== false, notes: String(o.notes || "").trim(), fix: String(o.fix || "").trim() };
  } catch {
    // a vision model that ignored the format still said something useful
    return { ok: true, notes: raw.slice(0, 200), fix: "" };
  }
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
