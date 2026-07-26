// Unit checks for the pure feature modules: readiness score, prompt pack,
// final-prompt templating, preview cut, and the camera solve on synthetic frames.
// Run: bun test src/features.test.ts
import { expect, test } from "bun:test";

// localStorage shim (pipeline/api import it at module scope)
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { beatReadiness, boardReadiness, bandOf } = await import("./readiness");
const { buildFinalPrompt, emptyExt, pickModel } = await import("./pipeline");
const { promptPackMarkdown, shotBible } = await import("./promptPack");
const { solveCameraMotion, describeCameraMove, normalizeReferenceVideoUrl } = await import("./cameraSolve");
const { kindOf } = await import("./shared");
const { consumeCharacter, loadHeadCharacter, rememberHeadCharacter, sendCharacter } = await import("./characterHandoff");
const { consumeStudioAssets, queueStudioAsset } = await import("./studioHandoff");
const { injectRefs } = await import("./copilot");
type Shot = import("./api").Shot;
type Pipeline = import("./pipeline").Pipeline;
type GrayFrame = import("./cameraSolve").GrayFrame;

test("reference video URLs reject executable and non-video schemes", () => {
  expect(normalizeReferenceVideoUrl("https://media.example/take.webm")).toBe("https://media.example/take.webm");
  expect(normalizeReferenceVideoUrl("data:video/webm;base64,AAAA")).toStartWith("data:video/webm");
  expect(() => normalizeReferenceVideoUrl("javascript:alert(1)")).toThrow("unsupported reference clip URL");
  expect(() => normalizeReferenceVideoUrl("data:text/html,<script>alert(1)</script>")).toThrow("reference clip is not a video");
});

test("VRMs are models and character handoffs carry identity, persona, and voice", () => {
  expect(kindOf("model/vrm", "ranger.vrm")).toBe("model");
  expect(kindOf("application/octet-stream", "https://media.example/ranger.vrm?x=1")).toBe("model");
  const ranger = {
    id: "char:ranger",
    name: "Ranger",
    vrmUrl: "https://media.example/ranger.vrm",
    portraitUrl: "https://media.example/ranger.png",
    persona: "A dry frontier scout",
    voice: "Low and gravelly",
  };
  sendCharacter("head", ranger);
  expect(consumeCharacter("head")).toEqual(ranger);
  expect(consumeCharacter("head")).toBeNull();
  rememberHeadCharacter(ranger);
  expect(loadHeadCharacter()).toEqual(ranger);
});

test("Animation takes queue once for the matching Studio project", () => {
  const take = {
    projectId: "project-a",
    sourceId: "take:one",
    name: "raw-take.webm",
    url: "https://media.example/raw-take.webm",
    contentType: "video/webm",
    kind: "video" as const,
    duration: 10,
  };
  queueStudioAsset(take);
  expect(consumeStudioAssets("project-b")).toEqual([]);
  expect(consumeStudioAssets("project-a")).toEqual([take]);
  expect(consumeStudioAssets("project-a")).toEqual([]);
});

test("pose-controlled LTX is routed separately from ordinary video", () => {
  const models = [
    { model: "ltx-2.3", endpoint: "multi_reference", credits: 750, note: "keyframe video" },
    { model: "ltx-enhance", endpoint: "enhance", credits: 1000, note: "Union-Control pose video" },
  ];
  expect(pickModel(models, "video")?.model).toBe("ltx-2.3");
  expect(pickModel(models, "motion_video")?.model).toBe("ltx-enhance");
});

test("MediaPipe landmarks map onto the cskel27 joints the control take draws", async () => {
  const { mapLandmarks, CSKEL_BONES, boneColor, fitBox } = await import("./poseExtract");
  // a crude standing figure: shoulders at y .3, hips at y .5, feet at y .9
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  lm[7] = { x: 0.48, y: 0.2, visibility: 1 }; // left ear
  lm[8] = { x: 0.52, y: 0.2, visibility: 1 }; // right ear
  lm[11] = { x: 0.4, y: 0.3, visibility: 1 }; // left shoulder
  lm[12] = { x: 0.6, y: 0.3, visibility: 1 }; // right shoulder
  lm[23] = { x: 0.45, y: 0.5, visibility: 1 }; // left hip
  lm[24] = { x: 0.55, y: 0.5, visibility: 1 }; // right hip
  const j = mapLandmarks(lm);
  expect(j.Hips).toEqual({ x: 0.5, y: 0.5, v: 1 });
  expect(j.Neck).toEqual({ x: 0.5, y: 0.3, v: 1 });
  expect(j.Head.y).toBeCloseTo(0.2, 5);
  // the spine climbs from hips to neck without overshooting either end
  expect(j.Spine.y).toBeGreaterThan(j.Spine1.y);
  expect(j.Spine1.y).toBeGreaterThan(j.Spine3.y);
  expect(j.Spine3.y).toBeGreaterThan(j.Neck.y);
  // every bone the renderer draws must resolve to two mapped joints
  for (const [a, b] of CSKEL_BONES) {
    expect(j[a]).toBeDefined();
    expect(j[b]).toBeDefined();
  }
  // left/right stay tinted apart — that is the pass's only side signal
  expect(boneColor("LeftHand")).not.toBe(boneColor("RightHand"));
  // a portrait source letterboxes instead of stretching
  const box = fitBox(1080, 1920);
  expect(box.w).toBeLessThan(768);
  expect(Math.round(box.h)).toBe(448);
});

test("plain language routes to the local skeleton flow, not the paid one", async () => {
  const { wantsSkeleton, matchFlow } = await import("./flows");
  expect(wantsSkeleton("extract the pose from this clip")).toBe(true);
  expect(wantsSkeleton("get a skeleton from my video")).toBe(true);
  expect(wantsSkeleton("dwpose this")).toBe(true);
  // asking to USE a control video is a paid render, not an extraction
  expect(wantsSkeleton("use this video as the control for my character")).toBe(false);
  expect(matchFlow("use this video as the control for my character")?.id).toBe("video-control");
});

test("a control flow is gated on its required slots and builds the job it promises", async () => {
  const { flowById, missingSlots, matchFlow } = await import("./flows");
  const flow = flowById("video-control")!;
  expect(missingSlots(flow, {}).map((s) => s.id)).toEqual(["control", "prompt"]);
  expect(missingSlots(flow, { control: "https://r2/take.webm", prompt: "golden hour" })).toEqual([]);
  // the optional identity sheet must not appear as a param when it was never filled
  const params = flow.build({ control: "https://r2/take.webm", prompt: "golden hour", size: "1536x896", frames: "241", guide: "0.85" });
  expect(params).toEqual({
    prompt: "golden hour",
    control_video: "https://r2/take.webm",
    width: 1536,
    height: 896,
    num_frames: 241,
    frame_rate: 24,
    guide_strength: 0.85,
  });
  expect(matchFlow("drive this video with a pose control")?.id).toBe("video-control");
  expect(matchFlow("make me a lofi track")).toBeUndefined();
});

test("pose-controlled LTX receives one control video and one identity sheet", () => {
  const refs = [
    { key: "take", name: "ardy.webm", url: "https://media.example/ardy.webm", content_type: "video/webm", type: "reference", bytes: 1, added: 1 },
    { key: "sheet", name: "hero.png", url: "https://media.example/hero.png", content_type: "image/png", type: "reference", bytes: 1, added: 1 },
  ] as import("./api").MediaObject[];
  expect(injectRefs("enhance", { prompt: "cinematic hero" }, refs)).toEqual({
    prompt: "cinematic hero",
    control_video: "https://media.example/ardy.webm",
    reference_sheet: "https://media.example/hero.png",
  });
});

const shot = (id: string, over: Partial<Shot> = {}): Shot =>
  ({ id, prompt: "a cat crosses the street", status: "ready", result: { url: "s.png", key: "", content_type: "image/png", bytes: 1 }, sourceDuration: 10, ...over }) as unknown as Shot;

const basePipe = (): Pipeline => ({
  phase: 2,
  characters: [{ id: "c1", name: "Cat", description: "orange tabby", approved: true, prompt: "", image: { url: "cat.png", content_type: "image/png" } }],
  locations: [{ id: "l1", name: "Street", description: "rainy street", prompt: "", image: { url: "street.png", content_type: "image/png" } }],
  beats: {},
  musicPrompt: "lofi",
  music: null,
  mix: null,
});

test("readiness: complete beat is ready, empty beat is blocked", () => {
  const pipe = basePipe();
  pipe.beats["a"] = {
    ...emptyExt(),
    characterIds: ["c1"],
    locationId: "l1",
    tracers: [{ id: "t1", characterId: "c1", kind: "move", path: [{ t: 0, x: 0.1, y: 0.5 }, { t: 8, x: 0.9, y: 0.5 }] }],
  };
  const full = beatReadiness(shot("a"), pipe);
  expect(full.score).toBe(100);
  expect(full.band).toBe("ready");

  const empty = beatReadiness(shot("b", { status: "empty", result: null, prompt: "" }), pipe);
  expect(empty.band).toBe("blocked");
  expect(empty.score).toBeLessThan(55);

  const board = boardReadiness([shot("a"), shot("b", { status: "empty", result: null, prompt: "" })], pipe);
  expect(board.perBeat.length).toBe(2);
  expect(board.score).toBe(Math.round((full.score + empty.score) / 2));
  expect(bandOf(80)).toBe("ready");
  expect(bandOf(55)).toBe("review");
  expect(bandOf(54)).toBe("blocked");
});

test("readiness: speech tracer without voice docks the voice component", () => {
  const pipe = basePipe();
  pipe.beats["a"] = {
    ...emptyExt(),
    characterIds: ["c1"],
    locationId: "l1",
    tracers: [{ id: "t1", characterId: "c1", kind: "speech", text: "meow", path: [{ t: 2.5, x: 0.5, y: 0.5 }] }],
  };
  const r = beatReadiness(shot("a"), pipe);
  expect(r.components.find((c) => c.key === "voice")!.value).toBe(0);
  pipe.beats["a"].voices = { t1: { url: "v.wav", content_type: "audio/wav" } };
  expect(beatReadiness(shot("a"), pipe).components.find((c) => c.key === "voice")!.value).toBe(1);
});

test("final prompt: motion + camera + intent instruction fold in", () => {
  const pipe = basePipe();
  const ext = {
    ...emptyExt(),
    characterIds: ["c1"],
    tracers: [
      { id: "t1", characterId: "c1", kind: "move" as const, path: [{ t: 0, x: 0.1, y: 0.5 }, { t: 8, x: 0.9, y: 0.5 }] },
      { id: "t2", characterId: "c1", kind: "speech" as const, text: "meow", path: [{ t: 2.5, x: 0.5, y: 0.5 }] },
    ],
    refIntent: "camera-only" as const,
    cameraMove: "Camera: slow push-in over 4.0s",
  };
  const p = buildFinalPrompt("a cat crosses the street", ext, pipe.characters);
  expect(p).toContain("a cat crosses the street");
  expect(p).toContain("Cat moves from frame left to frame right");
  expect(p).toContain('Cat says "meow" at 2.5s');
  expect(p).toContain("slow push-in");
  expect(p).toContain("Preserve only the camera movement");
  expect(p).toContain("10 second cinematic shot");
});

test("prompt pack: markdown + bible carry beats, cast, speech", () => {
  const pipe = basePipe();
  pipe.beats["a"] = {
    ...emptyExt(),
    characterIds: ["c1"],
    locationId: "l1",
    tracers: [{ id: "t2", characterId: "c1", kind: "speech", text: "meow", path: [{ t: 2.5, x: 0.5, y: 0.5 }] }],
  };
  const sb = { id: "x", title: "My Film", shots: [shot("a")], rev: 1 } as any;
  const bible = shotBible(sb, pipe);
  expect(bible.beats[0].cast).toEqual(["Cat"]);
  expect(bible.beats[0].speech[0].line).toBe("meow");
  expect(bible.runtimeSeconds).toBe(10);
  const md = promptPackMarkdown(sb, pipe);
  expect(md).toContain("# My Film — prompt pack");
  expect(md).toContain("**Cat**");
  expect(md).toContain("a cat crosses the street");
  expect(md).toContain('🔊 "meow" @ 2.5s');
});

/* ── camera solve on synthetic frames ── */
const synth = (w: number, h: number, fn: (x: number, y: number) => number): GrayFrame => {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fn(x, y);
  return { data, width: w, height: h };
};
const tex = (x: number, y: number) =>
  128 + 60 * Math.sin(x * 0.35) * Math.cos(y * 0.41) + 50 * Math.sin(x * 0.13 + y * 0.27) + 40 * Math.cos(x * 0.53 - y * 0.11);

test("camera solve: recovers a known translation", () => {
  const W = 192;
  const H = 108;
  const a = synth(W, H, tex);
  const b = synth(W, H, (x, y) => tex(x - 3, y - 2)); // content shifts right/down 3,2
  const solve = solveCameraMotion([a, b], 6);
  expect(solve.frames.length).toBe(1);
  expect(solve.frames[0].dx).toBeCloseTo(3, 0);
  expect(solve.frames[0].dy).toBeCloseTo(2, 0);
  expect(solve.frames[0].confidence).toBeGreaterThan(0.5);
});

test("camera solve: recovers a known zoom", () => {
  const W = 192;
  const H = 108;
  const cx = W / 2;
  const cy = H / 2;
  const a = synth(W, H, tex);
  const b = synth(W, H, (x, y) => tex(cx + (x - cx) / 1.12, cy + (y - cy) / 1.12)); // content scales up 12%
  const solve = solveCameraMotion([a, b], 6);
  expect(solve.frames[0].scale).toBeCloseTo(1.12, 1);
});

test("describeCameraMove: words match the numbers", () => {
  expect(describeCameraMove({ panX: 0, panY: 0, zoom: 1.3, rollDeg: 0, confidence: 1, seconds: 4 })).toContain("push-in");
  expect(describeCameraMove({ panX: -0.3, panY: 0, zoom: 1, rollDeg: 0, confidence: 1, seconds: 4 })).toContain("pan right");
  expect(describeCameraMove({ panX: 0.1, panY: 0, zoom: 1, rollDeg: 0, confidence: 1, seconds: 4 })).toContain("slight pan left");
  expect(describeCameraMove({ panX: 0, panY: 0, zoom: 1, rollDeg: 0, confidence: 1, seconds: 4 })).toContain("static camera");
});
