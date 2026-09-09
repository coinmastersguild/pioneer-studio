// Chat-mode copilot: one sentence in → a concrete job plan out.
// The LLM never sees raw URLs; it picks refs by media key and the client
// injects the public R2 URLs into params by content type.

import { captionImage, chatCompletion, type ChatMessage, type JobModel, type MediaObject, type Storyboard } from "./api";
import { extOf, type Pipeline } from "./pipeline";
import { boardReadiness } from "./readiness";
import { DEFAULT_AXES, type Contract } from "./workLoop";
import { mediaKind, pathParamKind } from "./jobCatalog";

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
      `Storyboard "${board.title || "untitled"}": ${shots.length} beats × 10s = ${shots.length * 10}s, readiness ${score}% (${band}).`,
    );
    const cast = pipe.characters.map((c) => `${c.name}${c.approved ? "" : " (unapproved)"}${c.image ? "" : " (no image)"}`);
    lines.push(`Cast: ${cast.length ? cast.join(", ") : "none"}.`);
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
    .map((m) => `- ${m.model}.${m.endpoint} (${m.credits} cr) result=${m.result || "unknown"}${m.result_ext || ""} params=${JSON.stringify(m.params || {})} — ${m.note || ""}`)
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
   If the previous turn was your own question and this turn is the answer to it,
   you MUST act — emit "job" or "flow". Do not ask again, and never reply with a
   bare question in "say"; a question belongs in "ask" with options or nowhere.
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

User's media (only these keys may appear in path parameters or refs):
${mediaLines}

The params schema beside the exact selected pair is authoritative. Send only declared fields and honor required, enum, min, and max. Put exact Media keys—not URLs or local paths—into path-or-url fields. Use refs only for legacy plans where the schema has one unambiguous compatible path field. Keep control_image distinct from identity/reference images, control_video distinct from ordinary video, and restoration distinct from video generation. Write generation prompts yourself: concrete, cinematic, specific.`;
}

/** Walk a model reply and pull out the first balanced top-level object.
 *  `JSON.parse` on `text[start..end]` dies on replies where the model wrote
 *  unescaped double quotes inside a string value (the "naked breasts" bug:
 *  Expected ',' or '}' after property value), and `lastIndexOf("}")` grabs a
 *  trailing `}` from a code fence. A depth-counting walk stops at the first
 *  depth-0 `}` that truly closes the object. */
function jsonSlice(text: string): string {
  let start = text.indexOf("{");
  if (start === -1) return "";
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
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return "";
}

/** True if the reply carries a top-level JSON object the planner needs. */
export function hasJsonObject(text: string): boolean {
  return jsonSlice(text) !== "";
}

export function parsePlan(content: string): JobPlan {
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const slice = jsonSlice(text);
  let obj: JobPlan;
  if (!slice) {
    // The model ignored the "JSON only" instruction and answered in prose.
    // Salvage it as a say-only plan instead of failing the whole turn.
    obj = { say: text };
  } else {
    try {
      obj = JSON.parse(slice) as JobPlan;
    } catch {
      // The model broke JSON rules (unescaped quote inside a string value).
      // Salvage `say` as the answer instead of failing the whole turn.
      const m = /"say"\s*:\s*"/.exec(slice);
      let say = "";
      if (m) {
        const start = m.index + m[0].length;
        // The value ends at the first `",` — the quote that closes it before
        // the next key. A value that still carries escapes decodes via a
        // single-string JSON parse; one that carries raw quotes falls back
        // to the raw text.
        const end = slice.indexOf('",', start);
        const raw = slice.slice(start, end === -1 ? slice.lastIndexOf('"') : end);
        try {
          say = JSON.parse(`"${raw}"`);
        } catch {
          say = raw;
        }
      }
      obj = { say };
    }
  }
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
  const base: ChatMessage[] = [
    { role: "system", content: systemPrompt(models, media, brief) },
    ...history,
    { role: "user", content: userText },
  ];
  const first = await chatCompletion(apiKey, base);
  if (hasJsonObject(first)) return parsePlan(first);
  // The reply was prose-only — nudge once with the JSON-only rule made
  // explicit, then parse the retry (which may still be prose; parsePlan
  // salvages it as a say-only plan rather than throwing).
  const retry = await chatCompletion(apiKey, [
    ...base,
    { role: "assistant", content: first },
    { role: "user", content: "Reply with ONLY the JSON object — no prose, no code fences." },
  ]);
  return parsePlan(retry);
}

/** PLANNER role. Turns a goal into a contract — what "done" looks like — before
 *  a single credit is spent. Deliberately a separate call from the evaluator:
 *  a model that grades its own rubric grades itself generous. */
export async function proposeContract(
  apiKey: string,
  models: JobModel[],
  goal: string,
): Promise<{ contract: Contract; job: { model: string; endpoint: string; params: Record<string, unknown> } | null }> {
  const modelLines = models.map((m) => `- ${m.model}.${m.endpoint} (${m.credits} cr) params=${JSON.stringify(m.params || {})} — ${m.note || ""}`).join("\n");
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

// Inject legacy `refs` into the path fields declared by the selected live
// schema. New actions should put exact Media keys in those fields directly;
// this compatibility path keeps older chat plans working without endpoint
// name switches.
export function injectRefs(
  entry: JobModel,
  params: Record<string, unknown>,
  refs: MediaObject[],
): Record<string, unknown> {
  const p = { ...params };
  const pathFields = Object.entries(entry.params || {}).filter(([, schema]) =>
    schema.type === "path-or-url" || schema.type === "list-of-path-or-url",
  );
  for (const kind of ["image", "video", "audio"] as const) {
    const compatible = refs.filter((ref) => mediaKind(ref) === kind);
    if (!compatible.length) continue;
    const fields = pathFields.filter(([name]) => pathParamKind(name) === kind && p[name] === undefined);
    if (fields.length > 1) {
      throw new Error(`map ${kind} Media explicitly: ${fields.map(([name]) => name).join(" or ")}`);
    }
    const [field] = fields;
    if (!field) continue;
    const [name, schema] = field;
    p[name] = schema.type === "list-of-path-or-url" ? compatible.map((ref) => ref.key) : compatible[0].key;
  }
  return p;
}
