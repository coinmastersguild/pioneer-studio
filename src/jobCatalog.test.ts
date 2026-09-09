import { expect, test } from "bun:test";
import type { JobModel } from "./api";
import { classifyJobModel, entryParamsJsonSchema } from "./jobCatalog";

const entry = (endpoint: string, result_ext: string, params: JobModel["params"], note = ""): JobModel => ({
  model: `dynamic-${endpoint}`,
  endpoint,
  credits: 1,
  note,
  params,
  result: "binary",
  result_ext,
});

test("live signatures classify 3D, restoration, control, lipsync, clone, SFX, image, music, and video lanes", () => {
  const cases: [JobModel, ReturnType<typeof classifyJobModel>][] = [
    [entry("generate", ".glb", { image: { type: "path-or-url" } }), "3d"],
    [entry("upscale", ".mp4", { video: { type: "path-or-url" } }), "video_restore"],
    [entry("controlnet", ".png", { control_image: { type: "path-or-url" } }), "image_control"],
    [entry("lipsync", ".mp4", { image: { type: "path-or-url" }, audio: { type: "path-or-url" } }), "lipsync"],
    [entry("enhance", ".mp4", { control_video: { type: "path-or-url" } }), "motion_video"],
    [entry("clone", ".wav", { reference_audio: { type: "path-or-url" } }), "voice_clone"],
    [entry("edit", ".png", { images: { type: "list-of-path-or-url" } }), "image_refs"],
    [entry("multi_reference", ".mp4", { images: { type: "list-of-path-or-url" } }), "video_refs"],
    [entry("generate", ".png", { prompt: { type: "str" } }), "image"],
    [entry("generate", ".wav", { prompt: { type: "str" } }, "sound effect generator"), "sfx"],
    [entry("generate", ".wav", { prompt: { type: "str" } }, "music and song generator"), "music"],
    [entry("generate", ".mp4", { prompt: { type: "str" } }), "video"],
  ];
  for (const [model, expected] of cases) expect(classifyJobModel(model)).toBe(expected);
});

test("copilot parameter schemas reject extras and retain live constraints", () => {
  const schema = entryParamsJsonSchema(entry("generate", ".png", {
    prompt: { type: "str", required: true },
    resolution: { type: "int", default: 1024, min: 512, max: 2048, enum: [512, 1024, 2048] },
  })) as any;
  expect(schema.additionalProperties).toBe(false);
  expect(schema.required).toEqual(["prompt"]);
  expect(schema.properties.resolution).toMatchObject({ type: "integer", default: 1024, minimum: 512, maximum: 2048 });
});
