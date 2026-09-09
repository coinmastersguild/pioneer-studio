import { expect, test } from "bun:test";
import { ApiError, type JobModel, type MediaList, type SubmitResponse } from "./api";
import { buildJobParams, createGenerationAction, prepareGenerationJob, runGenerationJob, type GenerationJobContext } from "./generationJob";
import { clearPendingJob, loadPendingJobs } from "./pendingJobs";

const models: JobModel[] = [
  {
    model: "trellis2", endpoint: "generate", default: true, credits: 14, note: "image to textured GLB",
    params: {
      image: { type: "path-or-url", required: true },
      resolution: { type: "int", default: 1024, enum: [512, 1024] },
      draco: { type: "bool", default: true },
    },
    result: "binary", result_ext: ".glb",
  },
  {
    model: "ltx-2.3", endpoint: "multi_reference", credits: 750, note: "reference-driven video",
    params: { prompt: { type: "str", required: true }, images: { type: "list-of-path-or-url", required: true } },
    result: "binary", result_ext: ".mp4",
  },
];

const media: MediaList = {
  objects: [{ key: "reference/hero.png", name: "hero.png", url: "https://media.example/hero.png", bytes: 10, content_type: "image/png", type: "reference", added: 1 }],
  total_bytes: 10, monthly_cr: 0, daily_cr: 0,
};

test("global generation action exposes schema-derived params and requires confirmation", () => {
  const action = createGenerationAction({ apiKey: "key", models, media, charge: () => {}, waitForJob: async () => ({ url: "https://media.example/out.glb", contentType: "model/gltf-binary" }) });
  expect(action.description).toContain("trellis2.generate (14 cr)");
  expect(action.confirmation).toContain("paid generation job");
  expect(action.confirmationFor?.({ model: "trellis2", endpoint: "generate", params: {} })).toBe("Spend 14 credits on trellis2.generate.");
  const parameters = action.parameters as any;
  const trellis = parameters.oneOf.find((variant: any) => variant.properties.model.const === "trellis2");
  expect(trellis.properties.params.properties.image.description).toContain("Media key");
  expect(trellis.properties.params.additionalProperties).toBe(false);
});

test("shared generation path submits an exact live pair, injects Media refs, and polls", async () => {
  const events: string[] = [];
  let forwarded: unknown;
  let remaining: number | null = null;
  const submission: SubmitResponse = { job_id: "j-test1234", status: "queued", model: "ltx-2.3", endpoint: "multi_reference", credits_charged: 750, credits_remaining: 9250 };
  const context: GenerationJobContext = {
    apiKey: "key", models, media,
    charge: (value) => { events.push("charge"); remaining = value; },
    submit: async (_key, model, endpoint, params) => { events.push(`submit:${model}.${endpoint}`); forwarded = params; return submission; },
    waitForJob: async (id) => { events.push(`poll:${id}`); return { url: "https://media.example/out.mp4", contentType: "video/mp4" }; },
  };
  const result = await runGenerationJob(context, { model: "ltx-2.3", endpoint: "multi_reference", params: { prompt: "hero turns toward camera" }, refs: ["reference/hero.png"] }, "animate the hero");
  expect(forwarded).toEqual({ prompt: "hero turns toward camera", images: ["https://media.example/hero.png"] });
  expect(events).toEqual(["submit:ltx-2.3.multi_reference", "charge", "poll:j-test1234"]);
  expect(remaining).toBe(9250);
  expect(result.contentType).toBe("video/mp4");
});

test("schema validation maps Media keys, rejects unknown fields, and preserves server defaults", () => {
  expect(buildJobParams(models[0], { image: "reference/hero.png" }, media)).toEqual({ image: "https://media.example/hero.png" });
  expect(() => buildJobParams(models[0], { image: "reference/hero.png", gpu: "private" }, media)).toThrow("unknown trellis2.generate parameter: gpu");
  expect(() => buildJobParams(models[0], { image: "/etc/hostname" }, media)).toThrow('Media reference "/etc/hostname" was not found');
  expect(() => buildJobParams(models[0], { image: "reference/hero.png", resolution: 2048 }, media)).toThrow("resolution must be one of");
});

test("generation path refuses models and references outside live Studio state", () => {
  expect(() => prepareGenerationJob(models, media, { model: "made-up-model", endpoint: "generate", params: { prompt: "x" } })).toThrow("not in the live catalog");
  expect(() => prepareGenerationJob(models, media, { model: "ltx-2.3", endpoint: "multi_reference", params: { prompt: "x" }, refs: ["missing.png"] })).toThrow('Media reference "missing.png" was not found');
});

test("catalog outages gate new work and a disappeared pair refreshes discovery", async () => {
  let refreshed = false;
  const base: GenerationJobContext = { apiKey: "key", models, media, charge: () => {}, waitForJob: async () => ({ url: "", contentType: "" }) };
  expect(runGenerationJob({ ...base, catalogAvailable: false }, { model: "trellis2", endpoint: "generate", params: { image: "reference/hero.png" } }, "3d")).rejects.toThrow("temporarily unavailable");
  expect(runGenerationJob({ ...base, submit: async () => { throw new ApiError("closed", 404); }, refreshCatalog: () => { refreshed = true; } }, { model: "trellis2", endpoint: "generate", params: { image: "reference/hero.png" } }, "3d")).rejects.toThrow("closed");
  expect(refreshed).toBe(true);
});

test("connectivity loss keeps a submitted job available for reload recovery", async () => {
  const submission: SubmitResponse = { job_id: "j-resume", status: "queued", model: "trellis2", endpoint: "generate", credits_charged: 14, credits_remaining: 10 };
  await expect(runGenerationJob({ apiKey: "key", models, media, charge: () => {}, submit: async () => submission, waitForJob: async () => { throw new Error("offline"); } }, { model: "trellis2", endpoint: "generate", params: { image: "reference/hero.png" } }, "make prop")).rejects.toThrow("offline");
  expect(loadPendingJobs().some((job) => job.id === "j-resume")).toBe(true);
  clearPendingJob("j-resume");
});
