import { expect, test } from "bun:test";

const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
};

const {
  activeVisualClip,
  addClip,
  addTrack,
  buildStudioExportPlan,
  createStudioClip,
  duplicateClip,
  emptyStudioTimeline,
  loadStudioTimeline,
  moveClip,
  moveClipToTrack,
  nudgeClip,
  normalizeStudioTimeline,
  patchTrack,
  removeTrack,
  removeClip,
  reorderTrack,
  reconcileStudioTimeline,
  rippleRemoveClip,
  saveStudioTimeline,
  splitClip,
  studioTimelineEnd,
  trimClip,
} = await import("./studioTimeline");

const beat = (id: string, start: number) => ({
  canonicalId: `beat:${id}`,
  origin: "storyboard" as const,
  sourceId: `beat:${id}`,
  name: `Beat ${id}`,
  url: `${id}.png`,
  contentType: "image/png",
  kind: "image" as const,
  start,
  duration: 10,
});

const video = (id: string, start: number, duration = 10) => ({
  id,
  origin: "library" as const,
  sourceId: `media:${id}`,
  name: id,
  url: `https://media.example/${id}.mp4`,
  contentType: "video/mp4",
  kind: "video" as const,
  trackId: "video-1",
  start,
  duration,
  trimIn: 0,
  sourceDuration: duration,
  volume: 1,
  muted: false,
});

test("studio timeline seeds canonical beats and preserves user edits", () => {
  const seeded = reconcileStudioTimeline(emptyStudioTimeline(), [beat("a", 0), beat("b", 10)]);
  expect(seeded.clips.map((clip) => clip.id)).toEqual(["beat:a", "beat:b"]);

  seeded.clips[0].start = 3;
  seeded.clips[0].duration = 4;
  seeded.clips[0].edited = true;
  const updated = reconcileStudioTimeline(seeded, [{ ...beat("a", 0), url: "new.png" }, beat("b", 12)]);
  expect(updated.clips[0].start).toBe(3);
  expect(updated.clips[0].duration).toBe(4);
  expect(updated.clips[0].url).toBe("new.png");
  expect(updated.clips[1].start).toBe(12);
});

test("studio timeline respects suppressed linked clips", () => {
  const doc = emptyStudioTimeline();
  doc.suppressedSourceIds.push("beat:a");
  expect(reconcileStudioTimeline(doc, [beat("a", 0)]).clips).toHaveLength(0);
});

test("studio timeline picks the topmost active visual and computes the edit end", () => {
  const doc = reconcileStudioTimeline(emptyStudioTimeline(), [beat("a", 0), beat("b", 5)]);
  expect(activeVisualClip(doc.clips, 7)?.id).toBe("beat:b");
  expect(studioTimelineEnd(doc)).toBe(15);
});

test("studio timeline normalizes unsafe persisted values", () => {
  const doc = normalizeStudioTimeline({
    clips: [{ ...beat("a", -2), id: "beat:a", volume: 3, muted: 0, trimIn: -4, duration: 0 }],
    masterVolume: -1,
  });
  expect(doc.masterVolume).toBe(0);
  expect(doc.clips[0].start).toBe(0);
  expect(doc.clips[0].duration).toBe(0.25);
  expect(doc.clips[0].volume).toBe(1);
  expect(doc.version).toBe(2);
  expect(doc.clips[0].trackId).toBe("video-1");
  expect(doc.tracks.map((track) => track.id)).toEqual(["video-1", "audio-1"]);
});

test("version one timelines migrate clips onto compatible explicit tracks", () => {
  const doc = normalizeStudioTimeline({
    version: 1,
    clips: [video("legacy", 0), { ...video("sound", 0), kind: "audio", contentType: "audio/wav" }],
  });
  expect(doc.version).toBe(2);
  expect(doc.clips.map((clip) => clip.trackId)).toEqual(["video-1", "audio-1"]);
});

test("studio timeline keeps inline media in session memory but out of localStorage", () => {
  const doc = reconcileStudioTimeline(emptyStudioTimeline(), [{ ...beat("inline", 0), url: "data:image/png;base64,large" }]);
  saveStudioTimeline("inline-project", doc);
  expect(loadStudioTimeline("inline-project").clips[0].url).toStartWith("data:image/png");
  expect(mem.get("ps_studio_timeline_inline-project")).not.toContain("base64,large");
});

test("timeline mutations move, trim, add, and remove without mutating the input", () => {
  const original = addClip(emptyStudioTimeline(), video("a", 0));
  const moved = moveClip(original, "a", 3);
  expect(original.clips[0].start).toBe(0);
  expect(moved.clips[0].start).toBe(3);
  expect(moved.clips[0].edited).toBe(true);

  const trimmedIn = trimClip(moved, "a", "in", 5);
  expect(trimmedIn.clips[0]).toMatchObject({ start: 5, duration: 8, trimIn: 2 });
  const trimmedOut = trimClip(trimmedIn, "a", "out", 20);
  expect(trimmedOut.clips[0].duration).toBe(8);

  const removed = removeClip(trimmedOut, "a");
  expect(removed.clips).toHaveLength(0);
  expect(original.clips).toHaveLength(1);
});

test("tracks can be added, renamed, reordered, locked, and removed without losing clips", () => {
  let doc = addTrack(emptyStudioTimeline(), "video");
  const second = doc.tracks.find((track) => track.id === "video-2")!;
  doc = patchTrack(doc, second.id, { name: "B-roll", muted: true });
  expect(doc.tracks.find((track) => track.id === second.id)).toMatchObject({ name: "B-roll", muted: true });
  doc = reorderTrack(doc, second.id, -1);
  expect(doc.tracks[0].id).toBe(second.id);

  doc = addClip(doc, { ...video("b", 0), trackId: second.id });
  doc = patchTrack(doc, second.id, { locked: true });
  expect(moveClip(doc, "b", 4)).toBe(doc);
  doc = patchTrack(doc, second.id, { locked: false });
  doc = removeTrack(doc, second.id);
  expect(doc.tracks.some((track) => track.id === second.id)).toBe(false);
  expect(doc.clips[0].trackId).toBe("video-1");
});

test("clips move only between compatible unlocked tracks", () => {
  let doc = addTrack(emptyStudioTimeline(), "video");
  doc = addClip(doc, video("a", 0));
  expect(moveClipToTrack(doc, "a", "video-2").clips[0].trackId).toBe("video-2");
  expect(moveClipToTrack(doc, "a", "audio-1")).toBe(doc);
  const locked = patchTrack(doc, "video-2", { locked: true });
  expect(moveClipToTrack(locked, "a", "video-2")).toBe(locked);
});

test("duplicate, nudge, and ripple delete preserve source alignment", () => {
  let doc = addClip(emptyStudioTimeline(), video("a", 0, 4));
  doc = addClip(doc, video("b", 4, 3));
  doc = duplicateClip(doc, "a");
  expect(doc.clips.at(-1)).toMatchObject({ id: "a:copy", start: 4, duration: 4 });
  doc = nudgeClip(doc, "a:copy", 0.1);
  expect(doc.clips.at(-1)?.start).toBeCloseTo(4.1);
  doc = rippleRemoveClip(doc, "a");
  expect(doc.clips.find((clip) => clip.id === "b")?.start).toBe(0);
});

test("removing linked media suppresses reseeding", () => {
  const seeded = reconcileStudioTimeline(emptyStudioTimeline(), [beat("a", 0)]);
  const removed = removeClip(seeded, "beat:a");
  expect(removed.suppressedSourceIds).toEqual(["beat:a"]);
  expect(reconcileStudioTimeline(removed, [beat("a", 0)]).clips).toHaveLength(0);
});

test("split creates source-aligned halves and reconciliation preserves linked splits", () => {
  const source = { ...beat("a", 0), kind: "video" as const, contentType: "video/mp4", sourceDuration: 10 };
  const seeded = reconcileStudioTimeline(emptyStudioTimeline(), [source]);
  const split = splitClip(seeded, "beat:a", 4);
  expect(split.clips.map(({ id, start, duration, trimIn }) => ({ id, start, duration, trimIn }))).toEqual([
    { id: "beat:a", start: 0, duration: 4, trimIn: 0 },
    { id: "beat:a:split", start: 4, duration: 6, trimIn: 4 },
  ]);
  const reconciled = reconcileStudioTimeline(split, [{ ...source, url: "new.mp4" }]);
  expect(reconciled.clips).toHaveLength(2);
  expect(reconciled.clips.every((clip) => clip.url === "new.mp4")).toBe(true);
});

test("deleting one half of a linked split keeps the surviving half canonical", () => {
  const source = { ...beat("a", 0), kind: "video" as const, contentType: "video/mp4", sourceDuration: 10 };
  const split = splitClip(reconcileStudioTimeline(emptyStudioTimeline(), [source]), "beat:a", 4);
  const removedLeft = removeClip(split, "beat:a");
  expect(removedLeft.suppressedSourceIds).toEqual([]);
  expect(removedLeft.clips[0]).toMatchObject({ id: "beat:a", start: 4, duration: 6, trimIn: 4 });
  expect(reconcileStudioTimeline(removedLeft, [source]).clips).toHaveLength(1);
});

test("export plan carries every visual and audio edit into the v2 contract", () => {
  let doc = addClip(emptyStudioTimeline(), { ...video("b", 10), muted: true });
  doc = addClip(doc, { ...video("a", 0), muted: true });
  doc = addClip(doc, {
    ...createStudioClip(
      {
        origin: "soundtrack",
        sourceId: "soundtrack:main",
        name: "Mix",
        url: "https://media.example/mix.wav",
        contentType: "audio/wav",
        kind: "audio",
      },
      0,
      20,
    ),
    id: "soundtrack:main",
  });
  const result = buildStudioExportPlan(doc);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.plan.version).toBe(2);
    expect(result.plan.clips.map((clip) => clip.url)).toEqual([
      "https://media.example/b.mp4",
      "https://media.example/a.mp4",
      "https://media.example/mix.wav",
    ]);
    expect(result.plan.clips.at(-1)).toMatchObject({ kind: "audio", start: 0, duration: 20, volume: 1 });
    expect(result.plan.duration).toBe(20);
  }
  const unmuted = buildStudioExportPlan({
    ...doc,
    clips: doc.clips.map((clip) => (clip.kind === "video" ? { ...clip, muted: false } : clip)),
  });
  expect(unmuted.ok).toBe(true);
});

test("export plan preserves gaps, overlaps, stills, trims, and master gain", () => {
  const doc = normalizeStudioTimeline({
    ...emptyStudioTimeline(),
    masterVolume: 0.5,
    clips: [
      { ...video("a", 1), trimIn: 2, duration: 8 },
      { ...video("still", 4), kind: "image", contentType: "image/png", sourceDuration: undefined },
    ],
  });
  const result = buildStudioExportPlan(doc);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.plan.duration).toBe(14);
    expect(result.plan.clips[0]).toMatchObject({ kind: "video", start: 1, duration: 8, trimIn: 2, volume: 0.5 });
    expect(result.plan.clips[1]).toMatchObject({ kind: "image", start: 4, duration: 10, muted: true });
  }
});
