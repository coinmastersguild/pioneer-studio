// SkeletonCard — the one flow that runs locally. Drop real footage, get an
// ARDY-style control take back, uploaded to the media store so the
// "Video → controlled video" card can pick it up from its media dropdown.
import { useRef, useState } from "react";
import { uploadMedia } from "./api";
import { extractControlVideo, type ExtractResult } from "./poseExtract";
import { type PS } from "./shared";

export default function SkeletonCard({ ps }: { ps: PS }) {
  const [source, setSource] = useState<File | null>(null);
  const [startSeconds, setStartSeconds] = useState("0");
  const [fullLength, setFullLength] = useState(false);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [uploaded, setUploaded] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const psRef = useRef(ps);
  psRef.current = ps;

  function take(files: File[]) {
    const video = files.find((f) => f.type.startsWith("video/"));
    if (!video) return psRef.current.toast("Drop a video file — this reads motion out of footage");
    setSource(video);
    setResult(null);
    setUploaded("");
    setNote("");
  }

  async function run() {
    if (!source) return;
    setBusy(true);
    setResult(null);
    setUploaded("");
    try {
      const out = await extractControlVideo(source, {
        startSeconds: Number(startSeconds) || 0,
        fullLength,
        onProgress: (_f, n) => setNote(n),
      });
      setResult(out);
      // straight into the media store: a control take you have to re-upload by
      // hand is a control take you will not use
      if (psRef.current.apiKey) {
        setNote("uploading the control take…");
        const up = await uploadMedia(
          psRef.current.apiKey,
          new File([out.blob], `skeleton-${Date.now()}.webm`, { type: out.blob.type }),
        );
        setUploaded(up.url);
        psRef.current.refreshMedia();
        setNote(`tracked ${out.posedFrames}/${out.totalFrames} frames · in your media store`);
      } else {
        setNote(`tracked ${out.posedFrames}/${out.totalFrames} frames · add a key to store it`);
      }
    } catch (e: any) {
      setNote(`failed: ${String(e.message || e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flow-card">
      <div className="fc-head">
        <b>Video → skeleton</b>
        <span className="fc-model">local · mediapipe · 0 cr</span>
      </div>
      <p className="fc-blurb">
        Reads the pose out of real footage and redraws it as a cskel27 control take — 768×448, 24fps, the shape the
        enhance endpoint wants. Runs in your browser, costs nothing.
      </p>

      <div
        className={`fc-slot drop${over ? " over" : ""}${source ? " full" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          take(Array.from(e.dataTransfer.files));
        }}
        onClick={() => picker.current?.click()}
      >
        <span className="fc-label">
          Source footage <i>anything with one person in frame</i>
        </span>
        <span className="fc-value">{source ? source.name : "drop a video, or click to browse"}</span>
        <input
          ref={picker}
          type="file"
          accept="video/*"
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files?.length) take(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
      </div>

      <label className="fc-choice">
        <span className="fc-label">Start at</span>
        <input
          type="number"
          min={0}
          step={0.5}
          value={startSeconds}
          onChange={(e) => setStartSeconds(e.target.value)}
        />
      </label>
      <label className="fc-choice">
        <span className="fc-label">Length</span>
        <select value={fullLength ? "241" : "121"} onChange={(e) => setFullLength(e.target.value === "241")}>
          <option value="121">121 frames · ~5s</option>
          <option value="241">241 frames · ~10s</option>
        </select>
      </label>

      <div className="fc-foot">
        <span className="fc-need">{source ? "ready" : "needs footage"}</span>
        <button type="button" className="fc-run" disabled={!source || busy} onClick={run}>
          {busy ? "tracking…" : "Extract skeleton"}
        </button>
      </div>

      {note && <div className={`fc-note${note.startsWith("failed") ? " warn" : ""}`}>{note}</div>}

      {result && (
        <div className="fc-result">
          <video src={result.url} controls autoPlay loop muted />
          {uploaded && <span className="fc-need">In media — pick it as the control video in “Video → controlled video”.</span>}
          <a className="mini-btn" href={result.url} download="skeleton-control.webm">
            Download
          </a>
        </div>
      )}
    </div>
  );
}
