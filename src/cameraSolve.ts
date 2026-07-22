// In-browser camera-move solve from a reference clip: gray pyramid → Shi-Tomasi
// corners → pyramidal Lucas-Kanade tracking → seeded-RANSAC similarity fit,
// accumulated into pan/tilt/zoom/roll. Deterministic (seeded LCG), no native deps.
// Algorithm pattern from Motion Previs Studio (Apache-2.0, Sam Wasserman /
// Wasserman Productions). This is a compact re-implementation; see
// THIRD_PARTY_NOTICES.md for attribution.
//
// The pure solver works on GrayFrame objects so it unit-tests without a DOM;
// extractGrayFrames handles the <video>/<canvas> side.

export type GrayFrame = { data: Float32Array; width: number; height: number };
export type CamFrame = { t: number; dx: number; dy: number; scale: number; rot: number; confidence: number };
export type CamSolve = {
  frames: CamFrame[];
  // cumulative over the clip; pan/tilt as fraction of frame size, roll degrees
  summary: { panX: number; panY: number; zoom: number; rollDeg: number; confidence: number; seconds: number };
};

const ANALYSIS_W = 192; // long-edge analysis resolution
const MAX_CORNERS = 120;
const LK_WIN = 7; // half-window (15px full)
const LK_ITERS = 8;
const RANSAC_ITERS = 150;
const RANSAC_THRESH = 2.0; // px

/* ── deterministic rng ── */
const makeLcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

/* ── image ops on GrayFrame ── */
export function toGray(img: { data: Uint8ClampedArray; width: number; height: number }): GrayFrame {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
  }
  return { data: out, width: img.width, height: img.height };
}

function downsampleHalf(f: GrayFrame): GrayFrame {
  const w = f.width >> 1;
  const h = f.height >> 1;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = 2 * y * f.width + 2 * x;
      out[y * w + x] = (f.data[o] + f.data[o + 1] + f.data[o + f.width] + f.data[o + f.width + 1]) / 4;
    }
  return { data: out, width: w, height: h };
}

const sample = (f: GrayFrame, x: number, y: number): number => {
  // bilinear, clamped
  x = Math.max(0, Math.min(f.width - 1.001, x));
  y = Math.max(0, Math.min(f.height - 1.001, y));
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * f.width + x0;
  return (
    f.data[i] * (1 - fx) * (1 - fy) +
    f.data[i + 1] * fx * (1 - fy) +
    f.data[i + f.width] * (1 - fx) * fy +
    f.data[i + f.width + 1] * fx * fy
  );
};

/* ── Shi-Tomasi corners with grid non-max suppression ── */
function detectCorners(f: GrayFrame): { x: number; y: number }[] {
  const { width: w, height: h } = f;
  const cells = 12;
  const cw = Math.ceil(w / cells);
  const chh = Math.ceil(h / Math.max(4, Math.round((cells * h) / w)));
  const best = new Map<number, { x: number; y: number; s: number }>();
  for (let y = 2; y < h - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      // 3×3 structure tensor from central differences
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const i = (y + dy) * w + (x + dx);
          const ix = (f.data[i + 1] - f.data[i - 1]) / 2;
          const iy = (f.data[i + w] - f.data[i - w]) / 2;
          sxx += ix * ix;
          syy += iy * iy;
          sxy += ix * iy;
        }
      const s = (sxx + syy - Math.sqrt((sxx - syy) ** 2 + 4 * sxy * sxy)) / 2; // min eigenvalue
      if (s < 40) continue;
      const cell = Math.floor(y / chh) * 64 + Math.floor(x / cw);
      const cur = best.get(cell);
      if (!cur || s > cur.s) best.set(cell, { x, y, s });
    }
  return [...best.values()].sort((a, b) => b.s - a.s).slice(0, MAX_CORNERS).map(({ x, y }) => ({ x, y }));
}

/* ── pyramidal Lucas-Kanade ── */
function lkTrackLevel(a: GrayFrame, b: GrayFrame, x: number, y: number, dx: number, dy: number): { dx: number; dy: number; ok: boolean } {
  let gxx = 0;
  let gyy = 0;
  let gxy = 0;
  const ix: number[] = [];
  const iy: number[] = [];
  const av: number[] = [];
  for (let wy = -LK_WIN; wy <= LK_WIN; wy++)
    for (let wx = -LK_WIN; wx <= LK_WIN; wx++) {
      const gx = (sample(a, x + wx + 1, y + wy) - sample(a, x + wx - 1, y + wy)) / 2;
      const gy = (sample(a, x + wx, y + wy + 1) - sample(a, x + wx, y + wy - 1)) / 2;
      ix.push(gx);
      iy.push(gy);
      av.push(sample(a, x + wx, y + wy));
      gxx += gx * gx;
      gyy += gy * gy;
      gxy += gx * gy;
    }
  const det = gxx * gyy - gxy * gxy;
  if (det < 1e-4) return { dx, dy, ok: false };
  for (let it = 0; it < LK_ITERS; it++) {
    let bx = 0;
    let by = 0;
    let k = 0;
    for (let wy = -LK_WIN; wy <= LK_WIN; wy++)
      for (let wx = -LK_WIN; wx <= LK_WIN; wx++, k++) {
        const dt = sample(b, x + wx + dx, y + wy + dy) - av[k];
        bx += dt * ix[k];
        by += dt * iy[k];
      }
    const ux = (gyy * -bx - -gxy * -by) / det;
    const uy = (gxx * -by - -gxy * -bx) / det;
    dx += ux;
    dy += uy;
    if (ux * ux + uy * uy < 1e-4) break;
  }
  return { dx, dy, ok: true };
}

function trackCorners(a: GrayFrame, b: GrayFrame, corners: { x: number; y: number }[]) {
  const aHalf = downsampleHalf(a);
  const bHalf = downsampleHalf(b);
  const pairs: { ax: number; ay: number; bx: number; by: number }[] = [];
  for (const c of corners) {
    const coarse = lkTrackLevel(aHalf, bHalf, c.x / 2, c.y / 2, 0, 0);
    const fine = lkTrackLevel(a, b, c.x, c.y, coarse.dx * 2, coarse.dy * 2);
    if (!fine.ok) continue;
    const bx = c.x + fine.dx;
    const by = c.y + fine.dy;
    if (bx < 0 || by < 0 || bx >= a.width || by >= a.height) continue;
    pairs.push({ ax: c.x, ay: c.y, bx, by });
  }
  return pairs;
}

/* ── similarity fit (2-point hypotheses + RANSAC + least-squares refit) ── */
type Sim = { s: number; rot: number; tx: number; ty: number };
const applySim = (m: Sim, x: number, y: number) => {
  const c = m.s * Math.cos(m.rot);
  const s = m.s * Math.sin(m.rot);
  return { x: c * x - s * y + m.tx, y: s * x + c * y + m.ty };
};

function simFromTwo(p: { ax: number; ay: number; bx: number; by: number }[], i: number, j: number): Sim | null {
  const dxp = p[j].ax - p[i].ax;
  const dyp = p[j].ay - p[i].ay;
  const dxq = p[j].bx - p[i].bx;
  const dyq = p[j].by - p[i].by;
  const d2 = dxp * dxp + dyp * dyp;
  if (d2 < 4) return null;
  // complex division (q2-q1)/(p2-p1) = scale·e^{iθ}
  const re = (dxq * dxp + dyq * dyp) / d2;
  const im = (dyq * dxp - dxq * dyp) / d2;
  const s = Math.hypot(re, im);
  if (s < 0.5 || s > 2) return null;
  const rot = Math.atan2(im, re);
  const m: Sim = { s, rot, tx: 0, ty: 0 };
  const t = applySim(m, p[i].ax, p[i].ay);
  return { ...m, tx: p[i].bx - t.x, ty: p[i].by - t.y };
}

function leastSquaresSim(pairs: { ax: number; ay: number; bx: number; by: number }[]): Sim {
  let pax = 0;
  let pay = 0;
  let pbx = 0;
  let pby = 0;
  for (const p of pairs) {
    pax += p.ax;
    pay += p.ay;
    pbx += p.bx;
    pby += p.by;
  }
  const n = pairs.length;
  pax /= n;
  pay /= n;
  pbx /= n;
  pby /= n;
  let re = 0;
  let im = 0;
  let den = 0;
  for (const p of pairs) {
    const px = p.ax - pax;
    const py = p.ay - pay;
    const qx = p.bx - pbx;
    const qy = p.by - pby;
    re += qx * px + qy * py;
    im += qy * px - qx * py;
    den += px * px + py * py;
  }
  const s = Math.hypot(re, im) / (den || 1);
  const rot = Math.atan2(im, re);
  const m: Sim = { s: s || 1, rot, tx: 0, ty: 0 };
  const t = applySim(m, pax, pay);
  return { ...m, tx: pbx - t.x, ty: pby - t.y };
}

function estimateSim(pairs: { ax: number; ay: number; bx: number; by: number }[], rng: () => number): { sim: Sim; inlierRatio: number } {
  if (pairs.length < 2) return { sim: { s: 1, rot: 0, tx: 0, ty: 0 }, inlierRatio: 0 };
  let bestInliers: typeof pairs = [];
  for (let it = 0; it < RANSAC_ITERS; it++) {
    const i = (rng() * pairs.length) | 0;
    let j = (rng() * pairs.length) | 0;
    if (j === i) j = (j + 1) % pairs.length;
    const m = simFromTwo(pairs, i, j);
    if (!m) continue;
    const inl = pairs.filter((p) => {
      const q = applySim(m, p.ax, p.ay);
      return Math.hypot(q.x - p.bx, q.y - p.by) < RANSAC_THRESH;
    });
    if (inl.length > bestInliers.length) bestInliers = inl;
  }
  if (bestInliers.length < 4) {
    // starved — fall back to median translation
    const med = (arr: number[]) => arr.sort((a, b) => a - b)[arr.length >> 1] || 0;
    return {
      sim: { s: 1, rot: 0, tx: med(pairs.map((p) => p.bx - p.ax)), ty: med(pairs.map((p) => p.by - p.ay)) },
      inlierRatio: pairs.length ? 0.2 : 0,
    };
  }
  return { sim: leastSquaresSim(bestInliers), inlierRatio: bestInliers.length / pairs.length };
}

/* ── the pure solver ── */
export function solveCameraMotion(frames: GrayFrame[], fps: number): CamSolve {
  const out: CamFrame[] = [];
  let panX = 0;
  let panY = 0;
  let zoom = 1;
  let roll = 0;
  let confSum = 0;
  const rng = makeLcg(90412);
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const { sim, inlierRatio } = estimateSim(trackCorners(a, b, detectCorners(a)), rng);
    panX += sim.tx / a.width;
    panY += sim.ty / a.height;
    zoom *= sim.s;
    roll += sim.rot;
    confSum += inlierRatio;
    out.push({ t: i / fps, dx: sim.tx, dy: sim.ty, scale: sim.s, rot: sim.rot, confidence: inlierRatio });
  }
  return {
    frames: out,
    summary: {
      panX,
      panY,
      zoom,
      rollDeg: (roll * 180) / Math.PI,
      confidence: out.length ? confSum / out.length : 0,
      seconds: frames.length / fps,
    },
  };
}

/* ── camera-move description for the video prompt ── */
// Convention: image content moving right (+panX) = camera panning LEFT.
export function describeCameraMove(s: CamSolve["summary"]): string {
  const parts: string[] = [];
  const mag = (v: number, lo: number, hi: number) => (Math.abs(v) < lo ? "" : Math.abs(v) < hi ? "slight " : "strong ");
  const rate = s.seconds > 0 ? Math.abs(Math.log(s.zoom)) / s.seconds : 0;
  if (s.zoom > 1.06) parts.push(`${rate > 0.08 ? "fast" : "slow"} push-in`);
  else if (s.zoom < 0.94) parts.push(`${rate > 0.08 ? "fast" : "slow"} pull-back`);
  const pm = mag(s.panX, 0.05, 0.25);
  if (pm) parts.push(`${pm}pan ${s.panX > 0 ? "left" : "right"}`);
  const tm = mag(s.panY, 0.05, 0.25);
  if (tm) parts.push(`${tm}tilt ${s.panY > 0 ? "up" : "down"}`);
  if (Math.abs(s.rollDeg) > 3) parts.push(`camera roll ${s.rollDeg > 0 ? "clockwise" : "counter-clockwise"}`);
  if (!parts.length) return "static camera, subtle handheld drift";
  return `Camera: ${parts.join(" with ")} over ${s.seconds.toFixed(1)}s`;
}

/* ── DOM side: sample a video file/url into gray frames ── */
export function normalizeReferenceVideoUrl(src: string, base = "https://studio.pioneers.dev/"): string {
  const source = new URL(src, base);
  if (!["https:", "http:", "blob:", "data:"].includes(source.protocol)) {
    throw new Error("unsupported reference clip URL");
  }
  if (source.protocol === "data:" && !source.href.toLowerCase().startsWith("data:video/")) {
    throw new Error("reference clip is not a video");
  }
  return source.href;
}

async function fetchVideoBlob(src: string): Promise<Blob> {
  const source = normalizeReferenceVideoUrl(src, location.href);
  const response = await fetch(source);
  if (!response.ok) throw new Error(`could not fetch reference clip (${response.status})`);
  const blob = await response.blob();
  if (blob.type && !blob.type.startsWith("video/") && blob.type !== "application/octet-stream") {
    throw new Error("reference clip is not a video");
  }
  return blob;
}

export async function extractGrayFrames(src: File | string, opts?: { fps?: number; maxSeconds?: number }): Promise<{ frames: GrayFrame[]; fps: number }> {
  const fps = opts?.fps ?? 6;
  const maxSeconds = opts?.maxSeconds ?? 8;
  const sourceBlob = typeof src === "string" ? await fetchVideoBlob(src) : src;
  const url = URL.createObjectURL(sourceBlob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  try {
    video.src = url;
    await new Promise<void>((res, rej) => {
      video.onloadedmetadata = () => res();
      video.onerror = () => rej(new Error("could not load reference clip"));
    });
    const dur = Math.min(video.duration || maxSeconds, maxSeconds);
    const scale = ANALYSIS_W / Math.max(video.videoWidth, 1);
    const w = Math.max(16, Math.round(video.videoWidth * scale));
    const h = Math.max(16, Math.round(video.videoHeight * scale));
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    const frames: GrayFrame[] = [];
    for (let t = 0; t <= dur; t += 1 / fps) {
      await new Promise<void>((res, rej) => {
        video.onseeked = () => res();
        video.onerror = () => rej(new Error("seek failed"));
        video.currentTime = Math.min(t, Math.max(0, dur - 0.05));
      });
      ctx.drawImage(video, 0, 0, w, h);
      frames.push(toGray(ctx.getImageData(0, 0, w, h)));
    }
    return { frames, fps };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

// One-call helper for the Beat Dialog: reference clip → prompt-ready camera line.
export async function solveCameraFromClip(src: File | string): Promise<{ solve: CamSolve; description: string }> {
  const { frames, fps } = await extractGrayFrames(src);
  if (frames.length < 2) throw new Error("clip too short to solve");
  const solve = solveCameraMotion(frames, fps);
  return { solve, description: describeCameraMove(solve.summary) };
}
