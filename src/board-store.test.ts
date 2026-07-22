// Smoke test for the local-first storyboard store.
// Run: bun test src/board-store.test.ts
import { expect, test } from "bun:test";

// minimal localStorage shim before importing the store
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { addShot, attachShotResult, deleteShot, fetchStoryboard, patchShot } = await import("./api");
const { buildPreviewCut } = await import("./pipeline");
type Shot = import("./api").Shot;
type Pipeline = import("./pipeline").Pipeline;

test("buildPreviewCut: clips, stills, and un-rendered beats", () => {
  const shot = (id: string, result: Shot["result"]): Shot => ({ id, sourceDuration: 10, result }) as unknown as Shot;
  const shots: Shot[] = [
    shot("a", null), // un-rendered → black still, counted as skipped
    shot("b", { url: "s.png", key: "", content_type: "image/png", bytes: 1 }), // still
    shot("c", { url: "r.mp4", key: "", content_type: "video/mp4", bytes: 1 }), // result already a video
    shot("d", null), // no result, but has a finalClip on the pipeline
  ];
  const pipe = {
    beats: { d: { finalClip: { url: "final.mp4", content_type: "video/mp4" } } },
    mix: { url: "mix.wav", content_type: "audio/wav" },
  } as unknown as Pipeline;

  const cut = buildPreviewCut(shots, pipe);
  expect(cut.items.map((i) => i.kind)).toEqual(["still", "still", "video", "video"]);
  expect(cut.items[0].url).toBeUndefined();
  expect(cut.items[1].url).toBe("s.png");
  expect(cut.items[3].url).toBe("final.mp4"); // finalClip wins over the (empty) result
  expect(cut.items[1].seconds).toBe(10);
  expect(cut.skipped).toBe(1);
  expect(cut.allVideo).toBe(false);
  expect(cut.audio).toBe("mix.wav");
});

test("local storyboard: add → patch → attach → delete", async () => {
  let sb = await fetchStoryboard("k");
  expect(sb.shots.length).toBe(0);

  sb = await addShot("k", sb.rev, { prompt: "" });
  expect(sb.shots.length).toBe(1);
  const id = sb.shots[0].id;
  expect(sb.shots[0].sourceDuration).toBe(10);

  sb = await patchShot("k", undefined, id, { prompt: "a cat walks across the street", status: "queued" });
  expect(sb.shots[0].prompt).toBe("a cat walks across the street");
  expect(sb.shots[0].status).toBe("queued");

  sb = await attachShotResult("k", undefined, id, { url: "data:image/png;base64,AAA", key: "inline", content_type: "image/png", bytes: 3 });
  expect(sb.shots[0].status).toBe("ready");
  expect(sb.shots[0].result?.url.startsWith("data:")).toBe(true);

  // persisted copy strips data: results (quota guard) but keeps the shot
  const slim = JSON.parse(mem.get("ps_storyboard")!);
  expect(slim.shots[0].result).toBe(null);
  expect(slim.shots[0].status).toBe("empty");
  // in-memory doc still serves the full result
  expect((await fetchStoryboard("k")).shots[0].result?.url.startsWith("data:")).toBe(true);

  sb = await deleteShot("k", sb.rev, id);
  expect(sb.shots.length).toBe(0);
});
