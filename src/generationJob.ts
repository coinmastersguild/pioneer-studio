import { ApiError, JobTerminalError, submitJob, type JobModel, type JobParamSchema, type MediaList, type MediaObject, type SubmitResponse } from "./api";
import { injectRefs } from "./copilot";
import type { ControlAction } from "./control";
import { clearPendingJob, savePendingJob } from "./pendingJobs";
import { compatibleMedia, entryParamsJsonSchema } from "./jobCatalog";

export type GenerationJobRequest = {
  model: string;
  endpoint: string;
  params: Record<string, unknown>;
  refs?: string[];
};

export type GenerationJobContext = {
  apiKey: string;
  models: JobModel[];
  media: MediaList | null;
  charge(remaining: number | null): void;
  waitForJob(jobId: string): Promise<{ url: string; contentType: string }>;
  submit?: typeof submitJob;
  catalogAvailable?: boolean;
  refreshCatalog?(): void | Promise<void>;
};

export type PreparedGenerationJob = GenerationJobRequest & {
  entry: JobModel;
  resolvedRefs: MediaObject[];
};

export type GenerationJobResult = {
  submission: SubmitResponse;
  url: string;
  contentType: string;
  prepared: PreparedGenerationJob;
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function scalar(name: string, schema: JobParamSchema, value: unknown): unknown {
  if (schema.type === "str") {
    if (typeof value !== "string") throw new Error(`${name} must be text`);
    return value;
  }
  if (schema.type === "bool") {
    if (typeof value !== "boolean") throw new Error(`${name} must be true or false`);
    return value;
  }
  if (schema.type === "int" || schema.type === "float") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "int" && !Number.isInteger(value))) {
      throw new Error(`${name} must be ${schema.type === "int" ? "an integer" : "a number"}`);
    }
    if (schema.min !== undefined && value < schema.min) throw new Error(`${name} must be at least ${schema.min}`);
    if (schema.max !== undefined && value > schema.max) throw new Error(`${name} must be at most ${schema.max}`);
    return value;
  }
  if (schema.type === "list") {
    if (!Array.isArray(value)) throw new Error(`${name} must be a list`);
    if (schema.min !== undefined && value.length < schema.min) throw new Error(`${name} needs at least ${schema.min} items`);
    if (schema.max !== undefined && value.length > schema.max) throw new Error(`${name} allows at most ${schema.max} items`);
    return value;
  }
  return value;
}

function enumValue(name: string, schema: JobParamSchema, value: unknown): unknown {
  const allowed = schema.enum && (Array.isArray(value)
    ? value.every((item) => schema.enum?.some((candidate) => Object.is(candidate, item)))
    : schema.enum.some((candidate) => Object.is(candidate, value)));
  if (schema.enum && !allowed) {
    throw new Error(`${name} must be one of ${schema.enum.join(", ")}`);
  }
  return value;
}

function resolveMedia(
  name: string,
  schema: JobParamSchema,
  value: unknown,
  objects: MediaObject[],
): unknown {
  const one = (ref: unknown): string => {
    if (typeof ref !== "string") throw new Error(`${name} must contain exact Media keys`);
    const media = objects.find((object) => object.key === ref || object.name === ref);
    if (!media) throw new Error(`Media reference "${ref}" was not found`);
    if (!compatibleMedia(name, media)) throw new Error(`${media.name} is not compatible with ${name}`);
    return media.url;
  };
  if (schema.type === "list-of-path-or-url") {
    if (!Array.isArray(value)) throw new Error(`${name} must be an ordered Media list`);
    if (schema.min !== undefined && value.length < schema.min) throw new Error(`${name} needs at least ${schema.min} items`);
    if (schema.max !== undefined && value.length > schema.max) throw new Error(`${name} allows at most ${schema.max} items`);
    return value.map(one);
  }
  return one(value);
}

export function buildJobParams(
  entry: JobModel,
  raw: Record<string, unknown>,
  media: MediaList | null,
): Record<string, unknown> {
  const schemas = entry.params || {};
  const unknown = Object.keys(raw).filter((name) => !Object.hasOwn(schemas, name));
  if (unknown.length) throw new Error(`unknown ${entry.model}.${entry.endpoint} parameter: ${unknown.join(", ")}`);
  const built: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    const value = raw[name];
    const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (schema.required && schema.default === undefined) throw new Error(`${name} is required`);
      continue;
    }
    built[name] = schema.type === "path-or-url" || schema.type === "list-of-path-or-url"
      ? resolveMedia(name, schema, value, media?.objects || [])
      : enumValue(name, schema, scalar(name, schema, value));
  }
  return built;
}

export function prepareGenerationJob(
  models: JobModel[],
  media: MediaList | null,
  request: GenerationJobRequest,
): PreparedGenerationJob {
  const model = String(request.model || "").trim();
  const endpoint = String(request.endpoint || "").trim();
  const entry = models.find((candidate) => candidate.model === model && candidate.endpoint === endpoint);
  if (!entry) throw new Error(`model/endpoint "${model}.${endpoint}" is not in the live catalog`);
  if (!record(request.params)) throw new Error("job params must be an object");

  const requestedRefs = request.refs ?? [];
  if (!Array.isArray(requestedRefs) || requestedRefs.some((ref) => typeof ref !== "string")) {
    throw new Error("job refs must be an array of Media keys or names");
  }
  const objects = media?.objects ?? [];
  const resolvedRefs = requestedRefs.map((ref) => {
    const found = objects.find((object) => object.key === ref || object.name === ref);
    if (!found) throw new Error(`Media reference "${ref}" was not found`);
    return found;
  });

  const schemaParams = buildJobParams(entry, injectRefs(entry, request.params, resolvedRefs), media);

  return {
    model,
    endpoint,
    params: schemaParams,
    refs: [...requestedRefs],
    entry,
    resolvedRefs,
  };
}

/** Shared paid-job path for both Chat and the global Copilot rail. */
export async function runGenerationJob(
  context: GenerationJobContext,
  request: GenerationJobRequest,
  intent: string,
  onSubmitted?: (submission: SubmitResponse, prepared: PreparedGenerationJob) => void,
): Promise<GenerationJobResult> {
  if (!context.apiKey) throw new Error("Studio credential is missing");
  if (context.catalogAvailable === false) throw new Error("GPU catalog temporarily unavailable");
  const prepared = prepareGenerationJob(context.models, context.media, request);
  let submission: SubmitResponse;
  try {
    submission = await (context.submit ?? submitJob)(context.apiKey, prepared.model, prepared.endpoint, prepared.params);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) await context.refreshCatalog?.();
    throw error;
  }
  context.charge(submission.credits_remaining ?? null);
  savePendingJob({
    id: submission.job_id,
    intent,
    model: prepared.model,
    endpoint: prepared.endpoint,
    at: Date.now(),
  });
  try {
    onSubmitted?.(submission, prepared);
    const result = await context.waitForJob(submission.job_id);
    clearPendingJob(submission.job_id);
    return { submission, ...result, prepared };
  } catch (error) {
    // Network loss is resumable. Only a terminal server state proves the job
    // can be removed from reload recovery.
    if (error instanceof JobTerminalError) clearPendingJob(submission.job_id);
    throw error;
  }
}

export function createGenerationAction(context: GenerationJobContext): ControlAction {
  const catalog = context.models
    .map((entry) => `${entry.model}.${entry.endpoint} (${entry.credits} cr)`)
    .join(", ");
  const variants = context.models.map((entry) => ({
    type: "object",
    properties: {
      model: { const: entry.model },
      endpoint: { const: entry.endpoint },
      params: entryParamsJsonSchema(entry),
      refs: { type: "array", items: { type: "string" }, description: "Legacy exact Media keys; prefer schema path fields" },
    },
    required: ["model", "endpoint", "params"],
    additionalProperties: false,
  }));
  return {
    name: "jobs.submit",
    description:
      "Submit and wait for one paid generation job using the selected live endpoint schema. " +
      `Only use an exact live pair: ${catalog || "no models are currently loaded"}. ` +
      "Put provider parameters such as prompt and num_frames inside params; refs contains optional Media keys or names.",
    confirmation: "Starts one paid generation job at the live catalog price; review its model, endpoint, and parameters before confirming",
    confirmationFor: (raw) => {
      const model = String(raw.model || "");
      const endpoint = String(raw.endpoint || "");
      const entry = context.models.find((candidate) => candidate.model === model && candidate.endpoint === endpoint);
      const prompt = record(raw.params) && typeof raw.params.prompt === "string" ? raw.params.prompt.trim() : "";
      const summary = prompt ? ` Prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? "…" : ""}` : "";
      return `Spend ${entry?.credits ?? "the catalog price"} credits on ${model}.${endpoint}.${summary}`;
    },
    parameters: variants.length ? { oneOf: variants } : { type: "object", properties: {}, additionalProperties: false },
    run: async (raw) => {
      if (!record(raw)) throw new Error("job request must be an object");
      const result = await runGenerationJob(
        context,
        {
          model: String(raw.model || ""),
          endpoint: String(raw.endpoint || ""),
          params: raw.params as Record<string, unknown>,
          refs: raw.refs as string[] | undefined,
        },
        `${String(raw.model || "generation")}.${String(raw.endpoint || "job")}`,
      );
      return {
        ok: true,
        job_id: result.submission.job_id,
        model: result.prepared.model,
        endpoint: result.prepared.endpoint,
        credits_charged: result.submission.credits_charged,
        credits_remaining: result.submission.credits_remaining,
        content_type: result.contentType,
        saved_to_media: true,
      };
    },
  };
}
