// Speech plumbing for the Head tab: streaming PCM playback in, RMS speech
// segmentation out, plus the clause splitter.
//
// ── Splitting a reply into speakable chunks ─────────────────────────────────
// NOTE: unused by `speak()` since /tts/stream landed — a streaming route has a
// flat time-to-first-byte, so cutting the opener short buys nothing. Kept
// (and tested) because it comes straight back the day /lore streaming is worth
// pipelining: then the job is feeding clause 1 to TTS while the model is still
// writing clause 2.
//
// Time-to-first-sound is set by the first chunk. Later chunks are generated
// under cover of playback, so only the opener needs an aggressive length cap.

/** Longest opener we'll wait for before making a cut. */
const OPENER = 52;
/** Below this a fragment is too short to stand alone and gets merged forward.
 *  Kept low deliberately: a real sentence boundary is the best possible opener,
 *  so "I am Finn, a scout." (19 chars) should stand rather than be glued to the
 *  next sentence and then cut mid-phrase by the opener rule below. */
const MIN = 14;

/** Prefer a real clause boundary; fall back to a word boundary. Returns the
 *  index to cut AFTER, or -1 when there's no acceptable cut. */
function cutPoint(s: string): number {
  const window = s.slice(0, OPENER);
  for (const re of [/[,;:—–][^,;:—–]*$/, /\s\S*$/]) {
    const m = window.match(re);
    if (!m || m.index === undefined) continue;
    // +1 keeps the punctuation with the first half; a space is dropped by trim
    const at = m.index + (re.source[1] === "," ? 1 : 0);
    if (at >= MIN) return at;
  }
  return -1;
}

export function splitClauses(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.match(/[^.!?…]+[.!?…]*\s*/g) ?? [text]) {
    const t = sentence.trim();
    if (!t) continue;
    // merge tiny fragments ("Yes." / "No.") so we don't stutter between chunks
    if (out.length && (t.length < MIN || out[out.length - 1].length < MIN)) out[out.length - 1] += " " + t;
    else out.push(t);
  }
  if (out[0] && out[0].length > OPENER) {
    const at = cutPoint(out[0]);
    if (at > 0) out.splice(0, 1, out[0].slice(0, at).trim(), out[0].slice(at).trim());
  }
  return out.filter(Boolean);
}

/* ── Streaming PCM playback ───────────────────────────────────────────────── */

/** Small lead so a chunk is always scheduled slightly in the future. */
const JITTER = 0.05;

/** Frames a byte stream into PCM16LE samples.
 *
 *  Two things bite here and neither is visible until audio is already glitching:
 *  a chunk boundary can land mid-sample (odd byte count), and a Uint8Array's
 *  byteOffset is not guaranteed 2-byte aligned, so viewing it as an Int16Array
 *  throws. Carrying the odd byte and copying into a fresh buffer fixes both.
 *  Pure, so it is testable without WebAudio — see head.test.ts. */
export function pcmChunker(): (bytes: Uint8Array) => Float32Array<ArrayBuffer> {
  let carry = new Uint8Array(0);
  return (bytes) => {
    let merged = bytes;
    if (carry.length) {
      merged = new Uint8Array(carry.length + bytes.length);
      merged.set(carry, 0);
      merged.set(bytes, carry.length);
    }
    const usable = merged.length - (merged.length % 2);
    carry = merged.slice(usable); // 0 or 1 byte
    const pcm = new Int16Array(merged.slice(0, usable).buffer);
    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
    return f32;
  };
}

/** Play a /tts/stream response, scheduling each chunk as it arrives.
 *
 *  `wire` connects a source to the destination AND to the lipsync tap, so the
 *  mouth is driven by exactly the samples being heard. Aborting the signal cuts
 *  playback instantly — that is barge-in. */
export async function playPcmStream(
  ctx: AudioContext,
  res: Response,
  wire: (src: AudioBufferSourceNode) => void,
  signal: AbortSignal,
  onFirstSound?: () => void,
): Promise<void> {
  const rate = Number(res.headers.get("x-sample-rate")) || 48000;
  if (!res.body) throw new Error("tts: no stream body");
  const reader = res.body.getReader();
  const frame = pcmChunker();
  const live: AudioBufferSourceNode[] = [];
  let playhead = 0;
  let last: AudioBufferSourceNode | null = null;

  const cut = () => {
    for (const s of live) {
      try {
        s.stop();
      } catch {
        /* already ended */
      }
    }
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cut, { once: true });

  // The wire does NOT hand back tidy 160ms frames. Measured against alpha: 114
  // chunks for 4.0s of audio, averaging 35ms and dipping to 2ms (40 samples) —
  // TCP segmentation, not model steps. Scheduling a node per chunk means ~114
  // AudioBufferSourceNodes a line, each with its own rounding against the
  // playhead. Batch to a floor first; the first chunk already clears it, so
  // this costs nothing at the front where latency is actually felt.
  const MIN_SCHEDULE = 0.1; // seconds of audio per scheduled node
  let pending: Float32Array[] = [];
  let pendingLen = 0;

  const flush = () => {
    if (!pendingLen) return;
    const merged = new Float32Array(pendingLen);
    let at = 0;
    for (const p of pending) {
      merged.set(p, at);
      at += p.length;
    }
    pending = [];
    pendingLen = 0;
    const buf = ctx.createBuffer(1, merged.length, rate);
    buf.copyToChannel(merged, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    wire(src);
    // First node, or the network underran and the playhead is already in the
    // past — re-seat it rather than start() in the past, which plays the chunk
    // immediately and overlaps whatever is still sounding.
    if (playhead < ctx.currentTime) {
      playhead = ctx.currentTime + JITTER;
      onFirstSound?.();
      onFirstSound = undefined;
    }
    src.start(playhead);
    playhead += buf.duration;
    live.push(src);
    last = src;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) break;
      const f32 = frame(value);
      if (f32.length) {
        pending.push(f32);
        pendingLen += f32.length;
      }
      if (pendingLen / rate >= MIN_SCHEDULE) flush();
    }
    if (!signal.aborted) flush(); // the tail is whatever is left, however short
    // the stream is done downloading long before it is done sounding
    if (last && !signal.aborted) await new Promise<void>((done) => (last!.onended = () => done()));
  } finally {
    signal.removeEventListener("abort", cut);
  }
}

/* ── Speech segmentation (VAD) ────────────────────────────────────────────── */

// The browser analyser emits floats in [-1,1], so the VAD threshold is expressed
// on that scale (350/32768).
const VAD_RMS = 350 / 32768; // above this = speech
const VAD_HANG_MS = 600; // silence after speech that ends an utterance
const VAD_MAX_MS = 12000; // force-flush a very long utterance
// A breath or keyboard tap can be roughly 100ms of signal, and asking STT to
// transcribe that noise can produce plausible filler words. A segment must last
// this long to be treated as an utterance.
const VAD_MIN_MS = 350;
const FRAME_MS = 50;

// While the head is speaking, its own voice leaks back through the mic and trips
// the VAD at this threshold — it hears itself, barges in on itself, and cuts off
// after the first chunk. (That is exactly the bug this pass fixed: "always speaks
// the first word".) Browser echo cancellation reduces the leak but does not
// remove it, so barge-in during playback needs a real margin: louder AND
// sustained, not one 50ms frame over a hair-trigger threshold.
const BARGE_MULT = 4; // × the threshold while we are the ones talking
const BARGE_MIN_MS = 250; // and it has to keep up for this long

export type VadEvent = "start" | "speech" | "keep" | "drop";

/** The segmentation decision, one FRAME_MS frame at a time — pure apart from
 *  its own counters, so it is testable without WebAudio. Feed it RMS and
 *  whether we are currently making noise ourselves; it returns the events for
 *  that frame. Extracted because two separate bugs lived in here: a dropped
 *  minimum-duration rule, and cancelling turns on the wrong event. */
export function vadMachine(): (rms: number, hot: boolean) => VadEvent[] {
  let inSpeech = false;
  let speechMs = 0;
  let silenceMs = 0;
  let armMs = 0; // consecutive ms over threshold, before we call it speech
  let real = false; // this segment has cleared VAD_MIN_MS
  return (rms, hot) => {
    const out: VadEvent[] = [];
    const floor = hot ? VAD_RMS * BARGE_MULT : VAD_RMS;
    const arm = hot ? BARGE_MIN_MS : 0;
    if (rms > floor) {
      armMs += FRAME_MS;
      if (!inSpeech && armMs > arm) {
        inSpeech = true;
        speechMs = 0;
        real = false;
        out.push("start");
      }
      silenceMs = 0;
      // VOICED ms, not segment ms. The game counts every frame once a segment
      // opens, including the 600ms of trailing silence that closes it — which
      // makes its own 350ms minimum unreachable-by-failing: any blip clears
      // 350 on hang alone. Counting only frames actually over the threshold is
      // what makes the minimum mean what it says.
      if (inSpeech) speechMs += FRAME_MS;
    } else {
      armMs = 0;
      if (inSpeech) silenceMs += FRAME_MS;
    }
    if (!inSpeech) return out;
    // Crossing the minimum is the moment this stops being noise and starts
    // being a turn — and the only moment we are allowed to interrupt anything.
    if (!real && speechMs >= VAD_MIN_MS) {
      real = true;
      out.push("speech");
    }
    if (silenceMs >= VAD_HANG_MS || speechMs >= VAD_MAX_MS) {
      inSpeech = false;
      speechMs = 0;
      silenceMs = 0;
      out.push(real ? "keep" : "drop");
    }
    return out;
  };
}

/** Segments mic input into utterances. Returns a teardown function.
 *
 *  Three callbacks, because "sound started" and "someone is actually talking"
 *  are different events and conflating them was a bug:
 *    start  — level came up; begin capturing, commit to nothing
 *    speech — it has lasted VAD_MIN_MS, so it is real: barge in now
 *    end    — segment over. `kept` is false for a blip that never reached
 *             VAD_MIN_MS, and the caller must throw that audio away
 *
 *  Only `speech` may cancel anything. Cancelling on `start` meant every cough
 *  killed the answer the user was waiting for.
 *
 *  Uses setInterval rather than an AudioWorklet. A backgrounded tab throttles
 *  timers to ~1s, so segmentation stalls while the tab is hidden — fine for a
 *  conversation the user is looking at. Move to a worklet if this ever needs to
 *  listen in the background. */
export function segmentSpeech(
  ctx: AudioContext,
  stream: MediaStream,
  on: { start: () => void; speech: () => void; end: (kept: boolean) => void; hot?: () => boolean },
): () => void {
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const step = vadMachine();
  const timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    for (const ev of step(rms, on.hot?.() ?? false)) {
      if (ev === "start") on.start();
      else if (ev === "speech") on.speech();
      else on.end(ev === "keep");
    }
  }, FRAME_MS);
  return () => {
    clearInterval(timer);
    src.disconnect();
    an.disconnect();
  };
}
