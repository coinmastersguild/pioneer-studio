// poseExtract — real footage in, ARDY-style skeleton control video out.
//
// The Pioneer API has no pose estimator (`/api/v1/motion/extract` and friends
// 404, and no jobs model does it), so this runs in the browser on MediaPipe's
// pose landmarker and draws the result in the same visual language as a recorded
// ARDY take: cskel27 topology, one hue, left limbs bright and right limbs dimmed
// so the pass can tell the sides apart.
//
// Known limit: this is a 2D screen-space skeleton, not a retarget onto the 3D
// rig. It keeps the source framing and needs no IK. The upgrade path — solving
// cskel27 rotations so the motion replays in the 3D stage under OUR camera — is
// real work and belongs on the server (see BACKEND_ASKS.md ask #1).
import { ACTOR_COLORS } from "./ardySkeleton";

// float16 "lite" weights — the heavy model is not worth 3× the latency here.
// Fetched at runtime because 5MB of weights do not belong in the repo; the WASM
// itself is vendored to public/mediapipe/wasm by `bun run setup`.
export const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const WASM_PATH = "/mediapipe/wasm";

export const CONTROL_W = 768;
export const CONTROL_H = 448;
const FPS = 24;

/** MediaPipe pose landmark indices we actually consume. Its left/right are the
 *  subject's own, which is the same convention cskel27 uses. */
const LM = {
  nose: 0, leftEar: 7, rightEar: 8,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftToe: 31, rightToe: 32,
} as const;

export type Landmark = { x: number; y: number; visibility?: number };
export type Point = { x: number; y: number; v: number };

/** cskel27 chains, as drawn. Spine2 is dropped exactly as the VRM retarget map
 *  drops it — four spine joints into three is not worth the extra segment. */
export const CSKEL_BONES: [string, string][] = [
  ["Hips", "Spine"], ["Spine", "Spine1"], ["Spine1", "Spine3"], ["Spine3", "Neck"], ["Neck", "Head"],
  ["Spine3", "LeftShoulder"], ["LeftShoulder", "LeftArm"], ["LeftArm", "LeftForeArm"], ["LeftForeArm", "LeftHand"],
  ["Spine3", "RightShoulder"], ["RightShoulder", "RightArm"], ["RightArm", "RightForeArm"], ["RightForeArm", "RightHand"],
  ["Hips", "LeftUpLeg"], ["LeftUpLeg", "LeftLeg"], ["LeftLeg", "LeftFoot"], ["LeftFoot", "LeftToeBase"],
  ["Hips", "RightUpLeg"], ["RightUpLeg", "RightLeg"], ["RightLeg", "RightFoot"], ["RightFoot", "RightToeBase"],
];

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: Math.min(a.v, b.v) });
const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  v: Math.min(a.v, b.v),
});

/** 33 MediaPipe landmarks → the cskel27 joints we draw. Normalized image space,
 *  so the pose keeps the source framing instead of being re-staged. */
export function mapLandmarks(lms: Landmark[]): Record<string, Point> {
  const at = (i: number): Point => {
    const l = lms[i];
    return l ? { x: l.x, y: l.y, v: l.visibility ?? 1 } : { x: 0, y: 0, v: 0 };
  };
  const hips = mid(at(LM.leftHip), at(LM.rightHip));
  const neck = mid(at(LM.leftShoulder), at(LM.rightShoulder));
  const head = mid(at(LM.leftEar), at(LM.rightEar));
  const j: Record<string, Point> = {
    Hips: hips,
    Spine: lerp(hips, neck, 0.25),
    Spine1: lerp(hips, neck, 0.5),
    Spine3: lerp(hips, neck, 0.82),
    Neck: neck,
    Head: head.v > 0.2 ? head : at(LM.nose),
  };
  for (const side of ["Left", "Right"] as const) {
    const s = side.toLowerCase() as "left" | "right";
    const shoulder = at(LM[`${s}Shoulder`]);
    j[`${side}Shoulder`] = lerp(neck, shoulder, 0.5);
    j[`${side}Arm`] = shoulder;
    j[`${side}ForeArm`] = at(LM[`${s}Elbow`]);
    j[`${side}Hand`] = at(LM[`${s}Wrist`]);
    j[`${side}UpLeg`] = at(LM[`${s}Hip`]);
    j[`${side}Leg`] = at(LM[`${s}Knee`]);
    j[`${side}Foot`] = at(LM[`${s}Ankle`]);
    j[`${side}ToeBase`] = at(LM[`${s}Toe`]);
  }
  return j;
}

/** Same tint rule the 3D rig uses: one hue, left bright, right dimmed. */
export function boneColor(joint: string, hex = ACTOR_COLORS[0].hex): string {
  const scale = joint.startsWith("Left") ? 1 : joint.startsWith("Right") ? 0.55 : 0.8;
  const r = Math.round(((hex >> 16) & 255) * scale);
  const g = Math.round(((hex >> 8) & 255) * scale);
  const b = Math.round((hex & 255) * scale);
  return `rgb(${r},${g},${b})`;
}

/** Letterbox the source aspect into the control frame so limb proportions
 *  survive — a stretched skeleton is a stretched output. */
export function fitBox(srcW: number, srcH: number, dstW = CONTROL_W, dstH = CONTROL_H) {
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h };
}

const MIN_VIS = 0.35; // below this the landmark is a guess; drawing it invents motion

export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  joints: Record<string, Point>,
  box: { x: number; y: number; w: number; h: number },
) {
  ctx.fillStyle = "#0a1410";
  ctx.fillRect(0, 0, CONTROL_W, CONTROL_H);
  const px = (p: Point) => ({ x: box.x + p.x * box.w, y: box.y + p.y * box.h });
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(3, box.h * 0.014);
  for (const [a, b] of CSKEL_BONES) {
    const pa = joints[a];
    const pb = joints[b];
    if (!pa || !pb || pa.v < MIN_VIS || pb.v < MIN_VIS) continue;
    const A = px(pa);
    const B = px(pb);
    ctx.strokeStyle = boneColor(b);
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(B.x, B.y);
    ctx.stroke();
  }
  for (const [name, p] of Object.entries(joints)) {
    if (p.v < MIN_VIS) continue;
    const P = px(p);
    ctx.fillStyle = boneColor(name);
    ctx.beginPath();
    ctx.arc(P.x, P.y, ctx.lineWidth * 0.85, 0, Math.PI * 2);
    ctx.fill();
  }
}

export type ExtractResult = { blob: Blob; url: string; seconds: number; posedFrames: number; totalFrames: number };
export type ExtractOpts = { startSeconds?: number; fullLength?: boolean; onProgress?: (fraction: number, note: string) => void };

let landmarkerPromise: Promise<any> | null = null;
async function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import("@mediapipe/tasks-vision");
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_PATH);
      return vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numPoses: 1,
      });
    })().catch((e) => {
      landmarkerPromise = null; // a failed load must not poison every later attempt
      throw e;
    });
  }
  return landmarkerPromise;
}

/**
 * Play `file` and record the detected pose as a control video the enhance
 * endpoint accepts: 768×448, 24fps, 121 or 241 frames.
 *
 * Real time, not frame-stepped: MediaRecorder timestamps by wall clock, so a
 * frame-stepped pass slower than 1× would silently produce a slow-motion take.
 * Playing at 1× keeps the output duration honest — dropped detections cost
 * smoothness, never timing. Same contract the 3D stage recorder runs on.
 */
export async function extractControlVideo(file: File | string, opts: ExtractOpts = {}): Promise<ExtractResult> {
  const seconds = (opts.fullLength ? 241 : 121) / FPS;
  const report = opts.onProgress || (() => {});
  report(0, "loading the pose model…");
  const landmarker = await getLandmarker();

  const video = document.createElement("video");
  video.src = typeof file === "string" ? file : URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = "anonymous";
  try {
    await new Promise<void>((ok, fail) => {
      video.onloadedmetadata = () => ok();
      video.onerror = () => fail(new Error("could not decode that video"));
    });
    const start = Math.max(0, Math.min(opts.startSeconds || 0, Math.max(0, video.duration - 0.2)));
    if (start) {
      video.currentTime = start;
      await new Promise<void>((ok) => {
        video.onseeked = () => ok();
      });
    }

    const canvas = document.createElement("canvas");
    canvas.width = CONTROL_W;
    canvas.height = CONTROL_H;
    const ctx = canvas.getContext("2d")!;
    const box = fitBox(video.videoWidth || 16, video.videoHeight || 9);
    drawSkeleton(ctx, {}, box); // an empty first frame beats a transparent one

    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((m) =>
      MediaRecorder.isTypeSupported(m),
    );
    const stream = canvas.captureStream(FPS);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<Blob>((ok) => {
      rec.onstop = () => ok(new Blob(chunks, { type: mime || "video/webm" }));
    });

    let posedFrames = 0;
    let totalFrames = 0;
    let raf = 0;
    const startedAt = performance.now();
    await video.play();
    rec.start();

    await new Promise<void>((finish) => {
      const step = () => {
        const elapsed = (performance.now() - startedAt) / 1000;
        if (elapsed >= seconds || video.ended) return finish();
        raf = requestAnimationFrame(step);
        totalFrames++;
        let joints: Record<string, Point> = {};
        try {
          const res = landmarker.detectForVideo(video, performance.now());
          const lms = res?.landmarks?.[0];
          if (lms?.length) {
            joints = mapLandmarks(lms);
            posedFrames++;
          }
        } catch {
          /* a dropped detection is a dropped frame, not a failed take */
        }
        drawSkeleton(ctx, joints, box);
        report(Math.min(1, elapsed / seconds), `tracking · ${elapsed.toFixed(1)}s of ${seconds.toFixed(1)}s`);
      };
      raf = requestAnimationFrame(step);
    });
    cancelAnimationFrame(raf);
    video.pause();
    rec.stop();
    for (const t of stream.getTracks()) t.stop();
    const blob = await done;
    report(1, `tracked ${posedFrames} of ${totalFrames} frames`);
    if (!posedFrames) throw new Error("no person was detected in that video");
    return { blob, url: URL.createObjectURL(blob), seconds, posedFrames, totalFrames };
  } finally {
    if (typeof file !== "string") URL.revokeObjectURL(video.src);
  }
}
