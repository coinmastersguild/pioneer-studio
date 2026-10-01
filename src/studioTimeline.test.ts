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
  createMediaClipSet,
  createStudioClip,
  duplicateClip,
  emptyStudioTimeline,
  fadeGainAt,
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
  repairTrackOverlaps,
  rippleMoveClip,
  rippleRemoveClip,
  rippleTrimClip,
  saveStudioTimeline,
  sharedInsertionStart,
  splitClip,
  studioTimelineEnd,
  studioTimelineForPersistence,
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
  fadeIn: 0,
  fadeOut: 0,
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

test("output format follows each saved project through persistence and export", () => {
  const portrait = { ...addClip(emptyStudioTimeline(), video("campaign", 0)), output: "portrait" as const };
  const square = { ...emptyStudioTimeline(), output: "square" as const };
  saveStudioTimeline("portrait-campaign", portrait);
  saveStudioTimeline("square-campaign", square);
  expect(loadStudioTimeline("square-campaign").output).toBe("square");
  expect(loadStudioTimeline("portrait-campaign").output).toBe("portrait");

  // Read the serialized document under a new key to bypass the in-memory cache.
  const stored = localStorage.getItem("ps_studio_timeline_portrait-campaign")!;
  localStorage.setItem("ps_studio_timeline_reopened-campaign", stored);
  const reopened = loadStudioTimeline("reopened-campaign");
  const serverDoc = studioTimelineForPersistence(reopened);
  expect(serverDoc.output).toBe("portrait");
  const plan = buildStudioExportPlan(reconcileStudioTimeline(normalizeStudioTimeline(serverDoc), []));
  expect(plan.ok && plan.plan.output).toBe("portrait");
});

test("legacy and invalid output formats default to landscape", () => {
  expect(emptyStudioTimeline().output).toBe("landscape");
  for (const output of [undefined, null, "", "unknown", "__proto__", 9]) {
    expect(normalizeStudioTimeline({ version: 2, output }).output).toBe("landscape");
  }
});

test("studio timeline picks the topmost active visual and computes the edit end", () => {
  const tracks = addTrack(emptyStudioTimeline(), "video");
  const doc = reconcileStudioTimeline(tracks, [
    { ...beat("a", 0), trackId: "video-2" },
    { ...beat("b", 5), trackId: "video-1" },
  ]);
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

test("same-track edits ripple instead of overlapping and can insert between beats", () => {
  let doc = addClip(emptyStudioTimeline(), video("a", 0, 10));
  doc = addClip(doc, video("c", 10, 10));
  doc = addClip(doc, video("b", 10, 4));
  expect(doc.clips.map(({ id, start }) => ({ id, start })).sort((a, b) => a.start - b.start)).toEqual([
    { id: "a", start: 0 },
    { id: "b", start: 10 },
    { id: "c", start: 14 },
  ]);

  doc = rippleMoveClip(doc, "c", 10);
  expect(doc.clips.map(({ id, start }) => ({ id, start })).sort((a, b) => a.start - b.start)).toEqual([
    { id: "a", start: 0 },
    { id: "c", start: 10 },
    { id: "b", start: 20 },
  ]);

  const audio = (id: string, start: number, duration: number) => ({
    ...video(id, start, duration),
    kind: "audio" as const,
    contentType: "audio/wav",
    trackId: "audio-1",
  });
  let sounds = addClip(emptyStudioTimeline(), audio("voice", 0, 10));
  sounds = addClip(sounds, audio("music", 5, 3));
  expect(sounds.clips.map(({ id, start }) => ({ id, start }))).toEqual([
    { id: "voice", start: 0 },
    { id: "music", start: 10 },
  ]);
});

test("legacy overlaps are repaired per track without disturbing stacked tracks", () => {
  let doc = addTrack(emptyStudioTimeline(), "video");
  doc = normalizeStudioTimeline({
    ...doc,
    clips: [
      video("primary", 0, 10),
      video("overlap", 5, 4),
      { ...video("overlay", 5, 4), trackId: "video-2" },
    ],
  });
  const repaired = repairTrackOverlaps(doc);
  expect(repaired.clips.find((clip) => clip.id === "overlap")?.start).toBe(10);
  expect(repaired.clips.find((clip) => clip.id === "overlay")?.start).toBe(5);
});

test("linked media finds one clear insertion point across its video and audio tracks", () => {
  let doc = addClip(emptyStudioTimeline(), video("v1", 0, 10));
  doc = addClip(doc, video("v2", 10, 10));
  doc = addClip(doc, {
    ...video("voice", 5, 10),
    kind: "audio",
    contentType: "audio/wav",
    trackId: "audio-1",
  });
  expect(sharedInsertionStart(doc, ["video-1", "audio-1"], 5)).toBe(20);
});

test("an MP4 asset creates independently editable linked video and audio clips", () => {
  let doc = addTrack(emptyStudioTimeline(), "video");
  doc = addTrack(doc, "audio");
  const pair = createMediaClipSet(
    {
      origin: "library",
      sourceId: "media:take",
      name: "take.mp4",
      url: "https://media.example/take.mp4",
      contentType: "video/mp4",
      kind: "video",
    },
    12,
    8,
    "video-2",
    "audio-2",
  );
  expect(pair).toHaveLength(2);
  expect(pair[0]).toMatchObject({ kind: "video", trackId: "video-2", start: 12, muted: true });
  expect(pair[1]).toMatchObject({ kind: "audio", trackId: "audio-2", start: 12, muted: false });
  expect(pair[0].linkGroupId).toBe(pair[1].linkGroupId);

  doc = addClip(addClip(doc, pair[0]), pair[1]);
  const withoutVideo = removeClip(doc, pair[0].id);
  expect(withoutVideo.clips).toHaveLength(1);
  expect(withoutVideo.clips[0].kind).toBe("audio");
});

test("clip fades shape preview gain and survive export with track level", () => {
  let doc = addClip(emptyStudioTimeline(), { ...video("still", 0, 10), kind: "image", contentType: "image/png" });
  doc = addClip(doc, {
    ...video("voice", 0, 10),
    kind: "audio",
    contentType: "audio/wav",
    trackId: "audio-1",
    volume: 0.8,
    fadeIn: 2,
    fadeOut: 2,
  });
  doc = patchTrack(doc, "audio-1", { volume: 0.5 });
  doc = { ...doc, masterVolume: 0.5 };
  const clip = doc.clips.find((item) => item.id === "voice")!;
  expect(fadeGainAt(clip, 0)).toBe(0);
  expect(fadeGainAt(clip, 1)).toBeCloseTo(0.5);
  expect(fadeGainAt(clip, 5)).toBe(1);
  expect(fadeGainAt(clip, 9)).toBeCloseTo(0.5);
  const result = buildStudioExportPlan(doc);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.plan.clips.find((item) => item.kind === "audio")).toMatchObject({ volume: 0.2, fadeIn: 2, fadeOut: 2 });
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
  expect(doc.clips.at(-1)?.start).toBe(4);
  doc = rippleRemoveClip(doc, "a");
  expect(doc.clips.find((clip) => clip.id === "a:copy")?.start).toBe(0);
  expect(doc.clips.find((clip) => clip.id === "b")?.start).toBe(4);
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
  const portrait = buildStudioExportPlan({ ...doc, output: "portrait" });
  expect(portrait.ok && portrait.plan.output).toBe("portrait");
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

test("ripple trim shortens a beat and pulls every later clip on every track left by the same amount", () => {
  const doc = normalizeStudioTimeline({
    version: 2, output: "landscape", masterVolume: 1, suppressedSourceIds: [],
    tracks: [
      { id: "video-1", kind: "video", name: "Picture", muted: false, locked: false, volume: 1 },
      { id: "audio-1", kind: "audio", name: "Voice", muted: false, locked: false, volume: 1 },
      { id: "audio-2", kind: "audio", name: "Music", muted: false, locked: false, volume: 1 },
    ],
    clips: [
      { id: "a", origin: "upload", sourceId: "a", name: "a", kind: "video", contentType: "video/mp4", trackId: "video-1", start: 0, duration: 12, trimIn: 0, sourceDuration: 12, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 },
      { id: "b", origin: "upload", sourceId: "b", name: "b", kind: "video", contentType: "video/mp4", trackId: "video-1", start: 12, duration: 8, trimIn: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 },
      { id: "va", origin: "upload", sourceId: "va", name: "line a", kind: "audio", contentType: "audio/mpeg", trackId: "audio-1", start: 0.3, duration: 5.8, trimIn: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 },
      { id: "fx", origin: "upload", sourceId: "fx", name: "fx a", kind: "audio", contentType: "audio/mpeg", trackId: "audio-1", start: 6.5, duration: 5.5, trimIn: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 },
      { id: "vb", origin: "upload", sourceId: "vb", name: "line b", kind: "audio", contentType: "audio/mpeg", trackId: "audio-1", start: 12.3, duration: 3, trimIn: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 },
      { id: "bed", origin: "upload", sourceId: "bed", name: "music", kind: "audio", contentType: "audio/mpeg", trackId: "audio-2", start: 0, duration: 20, trimIn: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 },
    ],
  });
  const out = rippleTrimClip(doc, "a", 6.8);
  const at = (id: string) => out.clips.find((c) => c.id === id)!;
  expect(at("a").duration).toBeCloseTo(6.8);
  expect(at("b").start).toBeCloseTo(6.8); // next beat follows straight on
  expect(at("vb").start).toBeCloseTo(7.1); // its voice moves with it
  expect(at("va").start).toBeCloseTo(0.3); // the trimmed beat's own line is untouched
  expect(at("fx").duration).toBeCloseTo(0.3); // an effect inside the beat is cut to its new end
  expect(at("bed").duration).toBeCloseTo(14.8); // the music bed shrinks by the same 5.2 s
  // and it is reversible: trimming back restores the original layout
  const back = rippleTrimClip(out, "a", 12);
  expect(back.clips.find((c) => c.id === "b")!.start).toBeCloseTo(12);
  expect(back.clips.find((c) => c.id === "bed")!.duration).toBeCloseTo(20);
});

test("ripple trim never lengthens past the source or touches locked tracks", () => {
  const doc = normalizeStudioTimeline({
    version: 2, output: "landscape", masterVolume: 1, suppressedSourceIds: [],
    tracks: [
      { id: "video-1", kind: "video", name: "Picture", muted: false, locked: false, volume: 1 },
      { id: "audio-1", kind: "audio", name: "Ref", muted: false, locked: true, volume: 1 },
    ],
    clips: [
      { id: "a", origin: "upload", sourceId: "a", name: "a", kind: "video", contentType: "video/mp4", trackId: "video-1", start: 0, duration: 4, trimIn: 0, sourceDuration: 5, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 },
      { id: "r", origin: "upload", sourceId: "r", name: "ref", kind: "audio", contentType: "audio/mpeg", trackId: "audio-1", start: 4, duration: 3, trimIn: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 },
    ],
  });
  const out = rippleTrimClip(doc, "a", 9);
  expect(out.clips.find((c) => c.id === "a")!.duration).toBeCloseTo(5);
  expect(out.clips.find((c) => c.id === "r")!.start).toBeCloseTo(4);
});
