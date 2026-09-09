import type { JobModel, JobParamSchema, MediaObject } from "./api";

export type JobCapability =
  | "3d"
  | "video_restore"
  | "image_control"
  | "lipsync"
  | "motion_video"
  | "voice_clone"
  | "image_refs"
  | "video_refs"
  | "image"
  | "video"
  | "sfx"
  | "music"
  | "speech"
  | "audio"
  | "unknown";

const IMAGE_EXT = /\.(?:png|jpe?g|webp|gif)$/i;
const VIDEO_EXT = /\.(?:mp4|webm|mov|mkv)$/i;
const AUDIO_EXT = /\.(?:mp3|wav|m4a|ogg|flac)$/i;

export function pathParamKind(name: string): "image" | "video" | "audio" | null {
  const n = name.toLowerCase();
  if (/(?:^|_)(?:image|images|control_image|reference_sheet)(?:$|_)/.test(n)) return "image";
  if (/(?:^|_)(?:video|videos|control_video)(?:$|_)/.test(n)) return "video";
  if (/(?:^|_)(?:audio|audios|reference_audio)(?:$|_)/.test(n)) return "audio";
  return null;
}

export function mediaKind(media: Pick<MediaObject, "content_type" | "url">): "image" | "video" | "audio" | "model" | null {
  const value = `${media.content_type} ${media.url}`;
  if (/model\/|\.(?:glb|gltf|vrm)(?:$|[?#])/i.test(value)) return "model";
  if (/image\//i.test(value) || IMAGE_EXT.test(media.url.split(/[?#]/)[0])) return "image";
  if (/video\//i.test(value) || VIDEO_EXT.test(media.url.split(/[?#]/)[0])) return "video";
  if (/audio\//i.test(value) || AUDIO_EXT.test(media.url.split(/[?#]/)[0])) return "audio";
  return null;
}

function resultKind(entry: JobModel): "image" | "video" | "audio" | "model" | "json" | "unknown" {
  const ext = (entry.result_ext || "").toLowerCase();
  if (ext === ".glb" || ext === ".gltf") return "model";
  if (IMAGE_EXT.test(ext)) return "image";
  if (VIDEO_EXT.test(ext)) return "video";
  if (AUDIO_EXT.test(ext)) return "audio";
  if (entry.result === "json") return "json";

  // Older catalogs did not expose result_ext. Keep them usable by consulting
  // endpoint and descriptive result words, never an exact model allowlist.
  const description = `${entry.endpoint} ${entry.note || ""}`;
  if (/\b(?:glb|gltf|3d model)\b/i.test(description)) return "model";
  if (/\b(?:mp4|video)\b/i.test(description)) return "video";
  if (/\b(?:wav|mp3|audio|music|speech|voice|sound effect|sfx)\b/i.test(description)) return "audio";
  if (/\b(?:png|jpe?g|webp|image)\b/i.test(description)) return "image";
  return "unknown";
}

export function classifyJobModel(entry: JobModel): JobCapability {
  const params = entry.params || {};
  const pathFields = Object.entries(params).filter(([, schema]) =>
    schema.type === "path-or-url" || schema.type === "list-of-path-or-url",
  );
  const has = (name: string) => Object.hasOwn(params, name);
  const hasKind = (kind: "image" | "video" | "audio") => pathFields.some(([name]) => pathParamKind(name) === kind);
  const listKind = (kind: "image" | "video" | "audio") =>
    pathFields.some(([name, schema]) => pathParamKind(name) === kind && schema.type === "list-of-path-or-url");
  const result = resultKind(entry);

  if (result === "model") return "3d";
  if (entry.endpoint === "upscale" && hasKind("video") && result === "video") return "video_restore";
  if (has("control_image") && result === "image") return "image_control";
  if (hasKind("image") && hasKind("audio") && result === "video") return "lipsync";
  if (has("control_video") && result === "video") return "motion_video";
  if ((has("reference_audio") || (entry.endpoint === "clone" && hasKind("audio"))) && result === "audio") return "voice_clone";
  if (listKind("image") && result === "image") return "image_refs";
  if (listKind("image") && result === "video") return "video_refs";
  if (!entry.params && entry.endpoint === "multi_reference" && result === "image") return "image_refs";
  if (!entry.params && entry.endpoint === "multi_reference" && result === "video") return "video_refs";
  if (!entry.params && entry.endpoint === "edit" && result === "image") return "image_refs";
  if (result === "image") return "image";
  if (result === "video") return "video";
  if (result === "audio") {
    if (entry.endpoint === "tts") return "speech";
    if (/\b(?:sound effect|sfx)\b/i.test(entry.note || "")) return "sfx";
    if (/\b(?:music|song)\b/i.test(entry.note || "")) return "music";
    return "audio";
  }
  return "unknown";
}

export function compatibleMedia(schemaName: string, media: MediaObject): boolean {
  const expected = pathParamKind(schemaName);
  return expected !== null && mediaKind(media) === expected;
}

export function schemaToJsonSchema(schema: JobParamSchema): Record<string, unknown> {
  const common = {
    ...(schema.enum ? { enum: schema.enum } : {}),
    ...(schema.default !== undefined ? { default: schema.default } : {}),
    ...(schema.min !== undefined ? { minimum: schema.min } : {}),
    ...(schema.max !== undefined ? { maximum: schema.max } : {}),
  };
  if (schema.type === "int") return { type: "integer", ...common };
  if (schema.type === "float") return { type: "number", ...common };
  if (schema.type === "bool") return { type: "boolean", ...common };
  if (schema.type === "list") return { type: "array", items: {}, ...common };
  if (schema.type === "list-of-path-or-url") {
    return { type: "array", items: { type: "string", description: "Exact Media key" }, ...common };
  }
  return {
    type: "string",
    ...(schema.type === "path-or-url" ? { description: "Exact compatible Media key" } : {}),
    ...common,
  };
}

export function entryParamsJsonSchema(entry: JobModel): Record<string, unknown> {
  const properties = Object.fromEntries(
    Object.entries(entry.params || {}).map(([name, schema]) => [name, schemaToJsonSchema(schema)]),
  );
  const required = Object.entries(entry.params || {})
    .filter(([, schema]) => schema.required && schema.default === undefined)
    .map(([name]) => name);
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

export function preferredEntry(entries: JobModel[]): JobModel | undefined {
  return entries.find((entry) => entry.default) || entries[0];
}
