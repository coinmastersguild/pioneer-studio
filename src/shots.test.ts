import { expect, test } from "bun:test";
import { addShot, closeProject, deleteShot, type JobModel } from "./api";
import type { PS } from "./shared";
import { renderShot } from "./shots";

const image: JobModel = { model: "actual-image", endpoint: "generate", credits: 1, note: "", result: "binary", result_ext: ".png", params: { prompt: { type: "str", required: true } } };
const audio: JobModel = { model: "unrelated-audio", endpoint: "generate", credits: 1, note: "", result: "binary", result_ext: ".wav", params: { prompt: { type: "str" } } };

async function fixture(run: (ps: PS, shot: Awaited<ReturnType<typeof addShot>>["shots"][number], requests: any[]) => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalFetch = globalThis.fetch; const memory = new Map<string, string>(); const requests: any[] = [];
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => memory.set(k, v), removeItem: (k: string) => memory.delete(k) } });
  closeProject();
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ job_id: "synthetic-shot", status: "queued", credits_charged: 1, credits_remaining: 99 });
  }) as typeof fetch;
  const board = await addShot("fixture-only", undefined, { prompt: "A cat in a garden" }); const shot = board.shots[0];
  const ps = { apiKey: "fixture-only", models: [], catalogAvailable: true, setBoard() {}, toast() {}, charge() {}, refreshBoard() {}, waitForJob: async () => { throw new Error("Synthetic polling stops here"); } } as unknown as PS;
  try { await run(ps, shot, requests); }
  finally { await deleteShot("fixture-only", undefined, shot.id); closeProject(); globalThis.fetch = originalFetch; if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else Reflect.deleteProperty(globalThis, "localStorage"); }
}

test("a still render cannot substitute the first unrelated model, an unknown explicit pair or a stale stored pair", async () => {
  await fixture(async (ps, shot, requests) => {
    ps.models = [audio];
    await expect(renderShot(ps, shot)).rejects.toThrow("image");
    ps.models = [audio, image];
    await expect(renderShot(ps, shot, { model: audio.model, endpoint: audio.endpoint })).rejects.toThrow("image");
    await expect(renderShot(ps, shot, { model: "missing-model", endpoint: "generate" })).rejects.toThrow("image");
    await expect(renderShot(ps, { ...shot, model: "removed-model", endpoint: "generate" })).rejects.toThrow("image");
    expect(requests).toHaveLength(0);
  });
});

test("a still render uses a compatible live schema and refuses stale catalogs or silently dropped references", async () => {
  await fixture(async (ps, shot, requests) => {
    ps.models = [audio, image]; ps.catalogAvailable = false;
    await expect(renderShot(ps, shot)).rejects.toThrow("catalog");
    ps.catalogAvailable = true;
    await expect(renderShot(ps, shot, { refs: ["https://example.invalid/identity.png"] })).rejects.toThrow("reference");
    expect(requests).toHaveLength(0);
    await renderShot(ps, shot);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: image.model, endpoint: image.endpoint, params: { prompt: shot.prompt } });
  });
});
