// Unit checks for the pure feature modules: readiness score, prompt pack,
// final-prompt templating, preview cut, and the camera solve on synthetic frames.
// Run: bun test src/features.test.ts
import { expect, mock, test } from "bun:test";

// localStorage shim (pipeline/api import it at module scope)
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { beatReadiness, boardReadiness, bandOf } = await import("./readiness");
const {
  assignBeatCast,
  assignBeatGeography,
  assignBeatLocation,
  beatRefs,
  buildFinalPrompt,
  emptyExt,
  genImage,
  geographyIssues,
  geographyPrompt,
  pickModel,
  setWorldLayout,
  upsertCharacter,
  voiceFor,
  upsertLocation,
} = await import("./pipeline");
const { promptPackMarkdown, shotBible } = await import("./promptPack");
const { solveCameraMotion, describeCameraMove, normalizeReferenceVideoUrl } = await import("./cameraSolve");
const { kindOf } = await import("./shared");
const { consumeCharacter, loadHeadCharacter, rememberHeadCharacter, sendCharacter } = await import("./characterHandoff");
const { consumeStudioAssets, queueStudioAsset } = await import("./studioHandoff");
const { consumeStageProp, sendPropToStage } = await import("./stageHandoff");
const { injectRefs } = await import("./copilot");
const { imageEditPlan } = await import("./shots");
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
  expect(kindOf("model/gltf-binary", "https://media.example/prop.glb")).toBe("model");
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

test("Media GLBs hand off to Stage once with their persisted URL", () => {
  sendPropToStage({ name: "throne.glb", url: "https://media.example/throne.glb" });
  expect(consumeStageProp()).toEqual({ name: "throne.glb", url: "https://media.example/throne.glb" });
  expect(consumeStageProp()).toBeNull();
});

test("pose-controlled LTX is routed separately from ordinary video", () => {
  const models = [
    { model: "ltx-2.3", endpoint: "multi_reference", credits: 750, note: "keyframe video", result_ext: ".mp4", params: { images: { type: "list-of-path-or-url" as const } } },
    { model: "ltx-enhance", endpoint: "enhance", credits: 1000, note: "Union-Control pose video", result_ext: ".mp4", params: { control_video: { type: "path-or-url" as const } } },
  ];
  expect(pickModel(models, "video")?.model).toBe("ltx-2.3");
  expect(pickModel(models, "motion_video")?.model).toBe("ltx-enhance");
});

test("a still to animate picks the reference endpoint and text uses the catalog default", () => {
  const models = [
    { model: "ltx-2.3", endpoint: "generate", default: true, credits: 500, note: "LTX-Video text→video mp4", result_ext: ".mp4", params: { prompt: { type: "str" as const } } },
    { model: "ltx-2.3", endpoint: "multi_reference", credits: 750, note: "1-4 reference images → video mp4", result_ext: ".mp4", params: { images: { type: "list-of-path-or-url" as const } } },
  ];
  expect(pickModel(models, "video")).toMatchObject({ model: "ltx-2.3", endpoint: "multi_reference" });
  expect(pickModel(models, "video_text")).toMatchObject({ model: "ltx-2.3", endpoint: "generate" });
});

test("closed historical model ids are not client-side fallbacks", () => {
  const models = [{ model: "ltx-2.3", endpoint: "generate", credits: 500, note: "LTX-Video text→video mp4" }];
  expect(pickModel(models, "video_text")).toMatchObject({ model: "ltx-2.3", endpoint: "generate" });
  expect(models.some((model) => model.model === "minimax-h3" || model.model === "flux2-dev")).toBe(false);
});

test("a prompt's own negative canon is not read as introducing the thing it bans", () => {
  const pipe = addCanonicalWorld(basePipe());
  const banned = (prompt: string) =>
    geographyIssues(shot("b", { prompt }), pipe).filter((i) => i.startsWith("prompt introduces"));
  // every v7 prompt ends with its own ban list — that must stay clean
  expect(banned("Dawn over the green valley; no desert, fortress, or invented landmarks.")).toEqual([]);
  expect(banned("Warm communal life, never parent coding; no desert, fortress, bells, banners.")).toEqual([]);
  // an actual violation still trips it
  expect(banned("A looming fortress above the trail.")).toEqual(['prompt introduces forbidden geography "fortress"']);
});

// The v6 regression: three consecutive clips rendered through `ltx-2.3.generate`
// with zero references, so "Oban" came back a grey ogre, then a golden lion.
// genImage is the single chokepoint every render goes through — no UI path,
// script, or future caller can reach a paid job around these two throws.
test("a video render without references is refused", async () => {
  const models = [{ model: "ltx-2.3", endpoint: "generate", credits: 500, note: "LTX-Video text→video mp4" }];
  const ps = { models, apiKey: "k", charge: () => {} } as any;
  expect(genImage(ps, "a colossal grey brute on a battlefield", { refs: [], video: true })).rejects.toThrow(
    /must animate a still/,
  );
});

test("references handed to an endpoint that cannot take them are refused, not dropped", async () => {
  // only `generate` on the account: pickModel's fallback returns it even for
  // "video", and the params block below has no slot for refs — silent drop.
  const models = [{ model: "ltx-2.3", endpoint: "generate", credits: 500, note: "LTX-Video text→video mp4" }];
  const ps = { models, apiKey: "k", charge: () => {} } as any;
  expect(genImage(ps, "Oban holds the line", { refs: ["https://r2/still.png"], video: true })).rejects.toThrow(
    /takes no reference images/,
  );
});

test("catalog defaults choose generation and edit without model-name routing", () => {
  const models = [
    { model: "first-image", endpoint: "generate", credits: 50, note: "text image", result_ext: ".png" },
    { model: "preferred-image", endpoint: "generate", default: true, credits: 15, note: "text image", result_ext: ".png" },
    { model: "preferred-edit", endpoint: "edit", default: true, credits: 25, note: "single image edit", result_ext: ".png", params: { image: { type: "path-or-url" as const } } },
  ];
  expect(pickModel(models, "image")?.model).toBe("preferred-image");
  expect(pickModel(models, "image_edit")?.model).toBe("preferred-edit");
});

test("single-image edit and reference-image lanes come from parameter signatures", () => {
  const models = [
    { model: "single-edit", endpoint: "edit", default: true, credits: 25, note: "single edit", result_ext: ".png", params: { image: { type: "path-or-url" as const } } },
    { model: "reference-edit", endpoint: "edit", credits: 50, note: "identity references", result_ext: ".png", params: { images: { type: "list-of-path-or-url" as const } } },
  ];
  expect(pickModel(models, "image_edit")?.model).toBe("single-edit");
  expect(pickModel(models, "image_refs")?.model).toBe("reference-edit");
});

test("re-rendering an existing still keeps its assigned location and identity references", () => {
  const models = [
    { model: "single-edit", endpoint: "edit", default: true, credits: 25, note: "single-image edit", result_ext: ".png", params: { image: { type: "path-or-url" as const } } },
    { model: "reference-edit", endpoint: "edit", credits: 50, note: "multi-reference identity lock", result_ext: ".png", params: { images: { type: "list-of-path-or-url" as const } } },
  ];
  expect(imageEditPlan(models, "https://media/beat.png", ["https://media/location.png", "https://media/oban.png"])).toEqual({
    model: models[1],
    params: {
      images: ["https://media/beat.png", "https://media/location.png", "https://media/oban.png"],
    },
  });
  expect(imageEditPlan(models, "https://media/beat.png", [], "  repair the lighting  ")).toEqual({
    model: models[0],
    params: { image: "https://media/beat.png", prompt: "repair the lighting" },
  });
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
    negative_prompt:
      "double exposure, ghosting, transparent overlay, superimposed still image, cross-fade, watermark, text, low resolution, blurry",
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
  expect(injectRefs({ model: "motion", endpoint: "enhance", credits: 1, note: "", result_ext: ".mp4", params: { control_video: { type: "path-or-url" }, reference_sheet: { type: "path-or-url" } } }, { prompt: "cinematic hero" }, refs)).toEqual({
    prompt: "cinematic hero",
    control_video: "take",
    reference_sheet: "sheet",
  });
});

const shot = (id: string, over: Partial<Shot> = {}): Shot =>
  ({ id, prompt: "a cat crosses the street", status: "ready", result: { url: "s.png", key: "", content_type: "image/png", bytes: 1 }, sourceDuration: 10, ...over }) as unknown as Shot;

const basePipe = (): Pipeline => ({
  characters: [{ id: "c1", name: "Cat", description: "orange tabby", approved: true, prompt: "", image: { url: "cat.png", content_type: "image/png" } }],
  beats: {},
  musicPrompt: "lofi",
  music: null,
  mix: null,
});

const addCanonicalWorld = (pipe: Pipeline) => {
  setWorldLayout(pipe, {
    name: "Forest road to Spawn Village",
    description: "One connected landscape: forest to trail to clearing to village.",
    approved: true,
    map: { url: "https://media.example/world-map.png", content_type: "image/png" },
    rules: ["The trail is continuous", "The clearing is the only open staging ground"],
    forbiddenElements: ["fortress", "battlefield", "bell", "desert", "castle"],
  });
  const image = (id: string) => ({ url: `https://media.example/${id}.png`, content_type: "image/png" });
  upsertLocation(pipe, {
    id: "forest",
    name: "Old-growth forest",
    description: "Dense temperate woods",
    approved: true,
    prompt: "same forest",
    image: image("forest"),
    sourceBeatId: "beat-01",
    kind: "zone",
    mapX: 15,
    mapY: 50,
    adjacentTo: ["forest-trail"],
    allowedElements: ["old trees", "ferns"],
    forbiddenElements: ["buildings"],
  });
  upsertLocation(pipe, {
    id: "forest-trail",
    name: "Forest trail",
    description: "Narrow path and stream crossing",
    approved: true,
    prompt: "same trail",
    image: image("trail"),
    sourceBeatId: "beat-02",
    kind: "transition",
    mapX: 38,
    mapY: 55,
    adjacentTo: ["forest", "clearing"],
    allowedElements: ["footpath", "stream", "boulders"],
    forbiddenElements: ["monuments"],
  });
  upsertLocation(pipe, {
    id: "clearing",
    name: "Forest clearing",
    description: "Natural grass clearing",
    approved: true,
    prompt: "same clearing",
    image: image("clearing"),
    sourceBeatId: "beat-03",
    kind: "transition",
    mapX: 62,
    mapY: 50,
    adjacentTo: ["forest-trail", "village"],
    allowedElements: ["grass", "wildflowers"],
    forbiddenElements: ["fortifications"],
  });
  upsertLocation(pipe, {
    id: "village",
    name: "Spawn Village",
    description: "Small timber-and-stone settlement",
    approved: true,
    prompt: "same village",
    image: image("village"),
    sourceBeatId: "beat-04",
    kind: "zone",
    mapX: 86,
    mapY: 45,
    adjacentTo: ["clearing"],
    allowedElements: ["timber homes", "workshop", "village lane"],
    forbiddenElements: ["walls", "bell tower"],
  });
  return pipe;
};

test("cast registry upserts by stable id and beat assignment rejects unknown cast", () => {
  const pipe = basePipe();
  const ryo = upsertCharacter(pipe, {
    id: "ryo",
    name: "Ryo",
    description: "small golden Shiba spawn",
    approved: true,
    prompt: "preserve face, markings, age, and proportions",
    image: { url: "https://media.example/ryo.png", content_type: "image/png" },
  });
  expect(ryo.id).toBe("ryo");
  expect(pipe.characters.map((c) => c.id)).toEqual(["c1", "ryo"]);

  upsertCharacter(pipe, { ...ryo, description: "the exact same small golden Shiba spawn" });
  expect(pipe.characters.filter((c) => c.id === "ryo")).toHaveLength(1);
  expect(pipe.characters.find((c) => c.id === "ryo")?.description).toContain("exact same");

  assignBeatCast(pipe, "beat-01", ["ryo", "c1", "ryo"]);
  expect(pipe.beats["beat-01"].characterIds).toEqual(["ryo", "c1"]);
  expect(() => assignBeatCast(pipe, "beat-01", ["missing"])).toThrow("unknown character");
});

test("location registry uses an explicit beat-derived plate as the first render reference", () => {
  const pipe = addCanonicalWorld(basePipe());
  const plate = upsertLocation(pipe, {
    id: "forest-trail",
    name: "Forest Trail",
    description: "the path connecting forest, clearing, and village",
    approved: true,
    prompt: "preserve the same path, stream crossing, tree line, and light",
    image: { url: "https://media.example/trail.png", content_type: "image/png" },
    sourceBeatId: "beat-02",
    kind: "transition",
    mapX: 38,
    mapY: 55,
    adjacentTo: ["forest", "clearing"],
    allowedElements: ["footpath", "stream", "boulders"],
    forbiddenElements: ["fortress", "bell"],
  });
  expect(plate.sourceBeatId).toBe("beat-02");
  assignBeatLocation(pipe, "beat-09", "forest-trail");
  const ext = pipe.beats["beat-09"];
  expect(ext.locationId).toBe("forest-trail");
  expect(beatRefs(pipe, ext)).toEqual(["https://media.example/trail.png"]);

  ext.characterIds = ["c1"];
  expect(beatRefs(pipe, ext)).toEqual(["https://media.example/trail.png", "cat.png"]);
  expect(() => assignBeatLocation(pipe, "beat-09", "missing")).toThrow("unknown location");
});

test("world topology locks a beat to an adjacent route and bans invented geography", () => {
  const pipe = addCanonicalWorld(basePipe());
  const ext = assignBeatGeography(pipe, "beat-02", {
    locationId: "forest-trail",
    movement: "cross",
    screenDirection: "left-to-right",
    entryFromId: "forest",
    exitToId: "clearing",
    anchor: "stream bridge",
  });
  expect(ext.locationId).toBe("forest-trail");
  expect(ext.geography?.exitToId).toBe("clearing");
  expect(geographyPrompt(pipe, ext)).toContain("Old-growth forest → Forest trail → Forest clearing");
  expect(geographyPrompt(pipe, ext)).toContain("Never introduce: fortress, battlefield, bell, desert, castle");
  expect(geographyIssues(shot("beat-02", { prompt: "A bell rings over the fortress battlefield" }), pipe)).toContain(
    'prompt introduces forbidden geography "fortress"',
  );
  expect(() =>
    assignBeatGeography(pipe, "bad-route", {
      locationId: "forest",
      movement: "exit",
      screenDirection: "left-to-right",
      exitToId: "village",
      anchor: "trailhead",
    }),
  ).toThrow("not adjacent");
});

test("a saved project mirrors pipeline cast state into the canonical document", async () => {
  const { activeProjectPipeline, closeProject, flushActiveProjectPipeline, openProject, saveActiveProjectPipeline } = await import("./api");
  const writes: any[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method) {
      return Response.json({
        id: "project-cast",
        owner: "0xowner",
        title: "Cast film",
        rev: 7,
        createdAt: 1,
        updatedAt: 1,
        doc: { id: "project-cast", address: "0xowner", title: "Cast film", rev: 7, shots: [], tracks: [], playhead: 0, createdAt: 1, updatedAt: 1 },
      });
    }
    writes.push(JSON.parse(String(init.body)));
    return Response.json({ ok: true });
  }) as typeof fetch;

  await openProject("secret", "project-cast");
  const pipeline = basePipe();
  expect(saveActiveProjectPipeline("project-cast", pipeline)).toBe(true);
  pipeline.characters.push({ id: "c2", name: "Dog", description: "", approved: true, prompt: "", image: null });
  expect(saveActiveProjectPipeline("project-cast", pipeline)).toBe(true);
  expect(activeProjectPipeline("project-cast")).toEqual(pipeline);
  await flushActiveProjectPipeline();
  expect(writes).toHaveLength(2);
  expect(writes[0].doc.pipeline.characters[0].name).toBe("Cat");
  expect(writes[1].doc.pipeline.characters.map((character: any) => character.name)).toEqual(["Cat", "Dog"]);
  closeProject();
});

test("readiness: complete beat is ready, empty beat is blocked", () => {
  const pipe = addCanonicalWorld(basePipe());
  pipe.beats["a"] = {
    ...emptyExt(),
    characterIds: ["c1"],
    tracers: [{ id: "t1", characterId: "c1", kind: "move", path: [{ t: 0, x: 0.1, y: 0.5 }, { t: 8, x: 0.9, y: 0.5 }] }],
  };
  assignBeatGeography(pipe, "a", {
    locationId: "forest-trail",
    movement: "cross",
    screenDirection: "left-to-right",
    entryFromId: "forest",
    exitToId: "clearing",
    anchor: "stream bridge",
  });
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
    tracers: [{ id: "t1", characterId: "c1", kind: "speech", text: "meow", path: [{ t: 2.5, x: 0.5, y: 0.5 }] }],
  };
  const r = beatReadiness(shot("a"), pipe);
  expect(r.components.find((c) => c.key === "voice")!.value).toBe(0);
  pipe.beats["a"].voices = { t1: { url: "v.wav", content_type: "audio/wav" } };
  expect(beatReadiness(shot("a"), pipe).components.find((c) => c.key === "voice")!.value).toBe(1);
  // …and a spoken line is not blocking: it must never satisfy motion direction,
  // or seeding a VO script would silently mark frozen-tableau beats as ready.
  expect(beatReadiness(shot("a"), pipe).components.find((c) => c.key === "tracers")!.value).toBe(0);
  pipe.beats["a"].tracers.push({ id: "t2", characterId: "c1", kind: "move", path: [{ t: 0, x: 0.1, y: 0.5 }] });
  expect(beatReadiness(shot("a"), pipe).components.find((c) => c.key === "tracers")!.value).toBe(1);
});

test("readiness: an intentionally cast-free insert is complete without adding identity refs", () => {
  const pipe = basePipe();
  pipe.beats["a"] = { ...emptyExt(), castIntentionalEmpty: true };
  const cast = beatReadiness(shot("a"), pipe).components.find((component) => component.key === "cast")!;
  expect(cast.value).toBe(1);
  expect(cast.hint).toContain("intentionally");
  expect(pipe.beats["a"].characterIds).toEqual([]);
});

test("final prompt: geography + motion + camera + intent instruction fold in", () => {
  const pipe = addCanonicalWorld(basePipe());
  const ext = {
    ...emptyExt(),
    characterIds: ["c1"],
    tracers: [
      { id: "t1", characterId: "c1", kind: "move" as const, path: [{ t: 0, x: 0.1, y: 0.5 }, { t: 8, x: 0.9, y: 0.5 }] },
      { id: "t2", characterId: "c1", kind: "speech" as const, text: "meow", path: [{ t: 2.5, x: 0.5, y: 0.5 }] },
    ],
    refIntent: "camera-only" as const,
    cameraMove: "Camera: slow push-in over 4.0s",
    locationId: "forest-trail",
    geography: {
      movement: "cross" as const,
      screenDirection: "left-to-right" as const,
      entryFromId: "forest",
      exitToId: "clearing",
      anchor: "stream bridge",
    },
  };
  const p = buildFinalPrompt("a cat crosses the street", ext, pipe);
  expect(p).toContain("a cat crosses the street");
  expect(p).toContain("Cat moves from frame left to frame right");
  expect(p).toContain('Cat says "meow" at 2.5s');
  expect(p).toContain("slow push-in");
  expect(p).toContain("Preserve only the camera movement");
  expect(p).toContain("World geography is locked");
  expect(p).toContain("Old-growth forest → Forest trail → Forest clearing");
  expect(p).toContain("Never introduce: fortress, battlefield, bell, desert, castle");
  expect(p).toContain("10 second cinematic shot");
});

test("prompt pack: markdown + bible carry beats, cast, speech, and master narration cues", () => {
  const pipe = basePipe();
  pipe.beats["a"] = {
    ...emptyExt(),
    characterIds: ["c1"],
    audioCues: [{ at: 0.35, speaker: "RYO", text: "My name is Ryo." }],
    tracers: [{ id: "t2", characterId: "c1", kind: "speech", text: "meow", path: [{ t: 2.5, x: 0.5, y: 0.5 }] }],
  };
  const sb = { id: "x", title: "My Film", shots: [shot("a")], rev: 1 } as any;
  const bible = shotBible(sb, pipe);
  expect(bible.beats[0].cast).toEqual(["Cat"]);
  expect(bible.beats[0].narration[0]).toEqual({ at: 0.35, speaker: "RYO", text: "My name is Ryo." });
  expect(bible.beats[0].speech[0].line).toBe("meow");
  expect(bible.runtimeSeconds).toBe(10);
  const md = promptPackMarkdown(sb, pipe);
  expect(md).toContain("# My Film — prompt pack");
  expect(md).toContain("**Cat**");
  expect(md).toContain("a cat crosses the street");
  expect(md).toContain('🔊 "meow" @ 2.5s');
  expect(md).toContain('🎙 RYO @ 0.3s — "My name is Ryo."');
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

test("the copilot's board brief reports real beat state, not the media list", async () => {
  const { boardBrief } = await import("./copilot");
  const p = basePipe();
  p.beats = { s1: { ...emptyExt(), characterIds: ["c1"] } };
  const board = {
    id: "b1",
    title: "Night Market",
    shots: [shot("s1"), { ...shot("s2"), prompt: "", status: "empty", result: null }],
  } as unknown as import("./api").Storyboard;
  const brief = boardBrief(board, p);
  expect(brief).toContain("Night Market");
  expect(brief).toContain("2 beats");
  expect(brief).toContain("still ✓"); // beat 1 has a result
  expect(brief).toContain("no still"); // beat 2 does not
  expect(brief).toContain("(no text)");
  expect(brief).toContain("Cat"); // the cast is named
  expect(boardBrief(null, null)).toContain("empty");
});

test("the work loop scores, converges, restarts, and always has a way out", async () => {
  const { scoreOf, decide, DEFAULT_AXES } = await import("./workLoop");
  type Attempt = import("./workLoop").Attempt;
  type RunLog = import("./workLoop").RunLog;

  // weighted, and normalised by the weights actually present
  expect(scoreOf({ subject: 1, composition: 1, look: 1, craft: 1 }, DEFAULT_AXES)).toBe(1);
  expect(scoreOf({ subject: 0, composition: 1, look: 1, craft: 1 }, DEFAULT_AXES)).toBeCloseTo(0.6, 3);
  // a missing axis must not drag the score down as if it scored zero
  expect(scoreOf({ subject: 1 }, DEFAULT_AXES)).toBe(1);

  const contract = { goal: "g", assertions: ["a"], axes: DEFAULT_AXES, target: 0.8, maxAttempts: 3, creditCeiling: 200 };
  const at = (n: number, score: number, fix = "make it bluer", creditsSpent = 50): Attempt =>
    ({ n, url: `u${n}`, score, perAxis: {}, notes: "", fix, creditsSpent, at: 0 });
  const run = (attempts: Attempt[]): RunLog => ({ id: "r", contract, attempts, done: false, stopped: "" });

  expect(decide(run([]), 50).action).toBe("stop"); // nothing rendered
  expect(decide(run([at(1, 0.85)]), 50)).toEqual({ action: "stop", why: "hit the bar — 0.85 ≥ 0.8" });
  expect(decide(run([at(1, 0.4)]), 50)).toEqual({ action: "fix", instruction: "make it bluer" });
  // two passes that did not move the number restart instead of patching further
  expect(decide(run([at(1, 0.4), at(2, 0.41)]), 50).action).toBe("restart");
  expect(decide(run([at(1, 0.4), at(2, 0.6)]), 50).action).toBe("fix");
  // out of attempts, and the credit ceiling, both terminate
  expect(decide(run([at(1, 0.3), at(2, 0.5), at(3, 0.6)]), 50).action).toBe("stop");
  expect(decide(run([at(1, 0.3, "f", 180)]), 50).why).toContain("ceiling");
  // an evaluator with no repair to offer must not loop forever
  expect(decide(run([at(1, 0.4, "")]), 50)).toEqual({ action: "stop", why: "the evaluator had no repair to suggest" });
});

test("parsePlan survives a broken reply (the 'That didn't work' bug)", async () => {
  const { parsePlan } = await import("./copilot");

  // valid JSON still parses into a full plan
  const plan = parsePlan('{"say":"Make a dawn keyframe","job":{"model":"flux-schnell","endpoint":"generate","params":{"prompt":"dawn keyframe"},"refs":["media:ranger.png"]}}');
  expect(plan.say).toBe("Make a dawn keyframe");
  expect(plan.job).toEqual({ model: "flux-schnell", endpoint: "generate", params: { prompt: "dawn keyframe" }, refs: ["media:ranger.png"] });

  // the model wrote an unescaped quote inside `say` — "naked breasts" case:
  // the reply's JSON is invalid, but the answer text is still salvageable.
  const broken = parsePlan('{"say":"Render "naked breasts" as asked.","job":{"model":"flux-schnell","endpoint":"generate","params":{"prompt":"naked breasts"}}}');
  expect(broken.say).toContain("Render");
  expect(broken.say).toContain("as asked");
  expect(broken.job).toBeUndefined();

  // the model answered in plain prose (no JSON object at all) — no throw;
  // the prose is kept as a say-only plan
  const prose = parsePlan("Photorealistic it is: I will render that with LTX-2.3, 1536x896, 240 frames.");
  expect(prose.say).toContain("Photorealistic it is");
  expect(prose.job).toBeUndefined();
  expect(prose.ask).toBeUndefined();
});

test("requestJobPlan retries once when the reply lacks a JSON object", async () => {
  const calls: import("./api").ChatMessage[][] = [];
  const replies = [
    "I will render that with LTX-2.3 at 1536x896, 240 frames at 24fps. That is a 10-second clip.",
    '{"say":"Rendering a 10s photorealistic bouncing-breasts clip.","job":{"model":"ltx-2.3","endpoint":"generate","params":{"prompt":"photorealistic breasts bouncing, 1536x896"},"refs":[]}}',
  ];
  mock.module("./api", () => ({
    chatCompletion: async (_k: string, msgs: import("./api").ChatMessage[]) => {
      calls.push(msgs);
      return replies[calls.length - 1];
    },
  } as any));
  const { requestJobPlan, hasJsonObject } = await import("./copilot");
  const models: import("./api").JobModel[] = [
    { model: "ltx-2.3", endpoint: "generate", credits: 80, note: "text-to-video" },
  ];
  const plan = await requestJobPlan("sk-test", models, [], "bouncing naked breasts video", "Storyboard: empty — no beats yet.");
  expect(calls.length).toBe(2); // retried once after the prose reply
  const last = calls[1];
  expect(last[last.length - 1].role).toBe("user");
  expect(String(last[last.length - 1].content)).toContain("ONLY the JSON object");
  expect(hasJsonObject("I will render that with LTX-2.3 at 1536x896.")).toBe(false);
  expect(hasJsonObject('{"say":"x"}')).toBe(true);
  expect(plan.job?.model).toBe("ltx-2.3");
  expect(plan.say).toContain("photorealistic");
});

test("a character keeps one voice across lines, and survives an evicted id", async () => {
  const { speakAs, voiceFor, isVoiceGone } = await import("./pipeline");
  const pipe = basePipe();
  const scout = upsertCharacter(pipe, {
    id: "scout",
    name: "Scout",
    description: "weathered",
    approved: true,
    prompt: "",
    voice: "  older man, gravelly and unhurried  ",
    image: null,
  });
  expect(scout.voice).toBe("older man, gravelly and unhurried");
  // nothing minted yet, so nothing to speak with
  expect(voiceFor(pipe, "scout")).toBeUndefined();
  expect(voiceFor(pipe, null)).toBeUndefined();

  const sent: any[] = [];
  let mints = 0;
  let evicted = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/api/v1/voice")) {
      mints++;
      // the server content-addresses the clip: the same clip mints the same id
      return new Response(JSON.stringify({ voice_id: "v_scout", reference_audio: "CLIP" }), {
        headers: { "content-type": "application/json" },
      });
    }
    sent.push(body);
    if (evicted) return new Response("gone", { status: 404 });
    return new Response(JSON.stringify({ url: "https://cdn/line.wav" }), {
      headers: { "content-type": "application/json" },
    });
  }) as any;

  try {
    const ps: any = { apiKey: "k", models: [] };
    const mut = (fn: any) => fn(pipe);

    await speakAs(ps, pipe, "scout", "Ridge is steeper than it looks.", mut);
    // minting stores BOTH halves: the id to speak with, the clip to recover with
    expect(pipe.characters.find((c) => c.id === "scout")!.voiceId).toBe("v_scout");
    expect(pipe.characters.find((c) => c.id === "scout")!.voiceClip).toBe("CLIP");
    expect(sent[0]).toEqual({ text: "Ridge is steeper than it looks.", voice_id: "v_scout" });

    // a second line is the whole point: same id, and no second mint
    await speakAs(ps, pipe, "scout", "Camp is an hour out.", mut);
    expect(sent[1]).toEqual({ text: "Camp is an hour out.", voice_id: "v_scout" });
    expect(mints).toBe(1);

    // server restarted and dropped the id: re-mint from the clip, same voice
    evicted = true;
    sent.length = 0;
    await expect(speakAs(ps, pipe, "scout", "Still here.", mut)).rejects.toThrow();
    expect(isVoiceGone(new Error("tts: 404"))).toBe(true);
    expect(mints).toBe(2); // it did try to recover before giving up
    expect(sent.every((b) => b.voice_id === "v_scout")).toBe(true);

    // no design written = the model default, never a drifting description
    evicted = false;
    sent.length = 0;
    upsertCharacter(pipe, { ...scout, voice: "" });
    await speakAs(ps, pipe, "scout", "Anyone.", mut);
    expect(sent[0]).toEqual({ text: "Anyone." });
  } finally {
    globalThis.fetch = realFetch;
  }
});
