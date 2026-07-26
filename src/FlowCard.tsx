// FlowCard — one runnable flow, live in the chat thread. Drop a file on a slot
// and it uploads to the media store and fills itself; when every required slot
// is full the card runs its own job and reports the server's own status text.
import { useRef, useState } from "react";
import { submitJob, uploadMedia, type MediaObject } from "./api";
import { flowIsLive, missingSlots, type Flow, type FlowSlot } from "./flows";
import { IcCopy, kindOf, type PS } from "./shared";

const ACCEPT: Record<FlowSlot["kind"], string> = { video: "video/*", image: "image/*", audio: "audio/*", text: "" };
const matchesKind = (ct: string, kind: FlowSlot["kind"]) => ct.startsWith(`${kind}/`);

export default function FlowCard({ flow, ps }: { flow: Flow; ps: PS }) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const s of flow.slots) if (s.preset) v[s.id] = s.preset;
    for (const c of flow.choices || []) v[c.id] = c.preset;
    return v;
  });
  const [names, setNames] = useState<Record<string, string>>({});
  const [busySlot, setBusySlot] = useState("");
  const [over, setOver] = useState("");
  const [note, setNote] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ url: string; kind: string } | null>(null);
  const pickers = useRef<Record<string, HTMLInputElement | null>>({});
  const psRef = useRef(ps);
  psRef.current = ps;

  const live = flowIsLive(flow, ps.models);
  const missing = missingSlots(flow, values);
  // the pitch gives way to the work the moment a file slot is filled
  const touched = flow.slots.some((s) => s.kind !== "text" && values[s.id]);
  const multi = (s: FlowSlot) => s.id === "images";

  function setSlot(slot: FlowSlot, url: string, name: string) {
    setValues((v) => ({ ...v, [slot.id]: multi(slot) && v[slot.id] ? `${v[slot.id]}\n${url}` : url }));
    setNames((n) => ({ ...n, [slot.id]: multi(slot) && n[slot.id] ? `${n[slot.id]}, ${name}` : name }));
  }

  async function take(slot: FlowSlot, files: File[]) {
    const p = psRef.current;
    if (!p.apiKey) return p.toast("Add your key in Settings before uploading");
    const usable = files.filter((f) => matchesKind(f.type, slot.kind));
    if (!usable.length) return p.toast(`${flow.title}: ${slot.label} takes ${slot.kind} files`);
    setBusySlot(slot.id);
    try {
      for (const f of multi(slot) ? usable.slice(0, 4) : usable.slice(0, 1)) {
        const up = await uploadMedia(p.apiKey, f);
        setSlot(slot, up.url, f.name);
      }
      p.refreshMedia();
    } catch (e: any) {
      p.toast(`Upload failed: ${String(e.message || e).slice(0, 120)}`);
    } finally {
      setBusySlot("");
    }
  }

  async function run() {
    const p = psRef.current;
    if (!p.apiKey) return p.toast("Add your key in Settings to run a flow");
    if (missing.length) return p.toast(`Still needed: ${missing.map((s) => s.label).join(", ")}`);
    setRunning(true);
    setResult(null);
    setNote("submitting…");
    const startedAt = Date.now();
    try {
      const res = await submitJob(p.apiKey, flow.model, flow.endpoint, flow.build(values));
      p.charge(res.credits_remaining);
      const { url, contentType } = await p.waitForJob(res.job_id, (s) => {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        setNote([s.status, s.stage, s.log_tail?.at(-1)].filter(Boolean).join(" · ") + ` · ${secs}s · job ${s.job_id}`);
      });
      setResult({ url, kind: kindOf(contentType, url) });
      setNote(`done in ${Math.round((Date.now() - startedAt) / 1000)}s · ${res.credits_charged} cr`);
      p.refreshMedia();
      p.refreshCredits();
    } catch (e: any) {
      // stays on the card: a paid job's failure reason must outlive a toast
      setNote(`failed after ${Math.round((Date.now() - startedAt) / 1000)}s: ${String(e.message || e)}`);
    } finally {
      setRunning(false);
    }
  }

  const pool = (ps.media?.objects || []) as MediaObject[];

  return (
    <div className="flow-card">
      <div className="fc-head">
        <b>{flow.title}</b>
        <span className="fc-model">
          {flow.model} · {flow.endpoint}
        </span>
      </div>
      <p className="fc-blurb">{flow.blurb}</p>

      {/* the pitch: what it does, shown until you start filling it in */}
      {!touched && (
        <div className="fc-explain">
          {flow.sample && (
            <div className="fc-sample">
              {flow.sample.in.map((s) => (
                <figure key={s.url}>
                  {s.kind === "video" ? <video src={s.url} autoPlay loop muted playsInline /> : <img src={s.url} alt="" />}
                  <figcaption>{s.caption}</figcaption>
                </figure>
              ))}
              <span className="fc-arrow" aria-hidden="true">
                →
              </span>
              <figure className="out">
                {flow.sample.out.kind === "video" ? (
                  <video src={flow.sample.out.url} autoPlay loop muted playsInline />
                ) : (
                  <img src={flow.sample.out.url} alt="" />
                )}
                <figcaption>{flow.sample.out.caption}</figcaption>
              </figure>
            </div>
          )}
          <ol className="fc-steps">
            {flow.walkthrough.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </div>
      )}

      {flow.slots.map((slot) =>
        slot.kind === "text" ? (
          <label key={slot.id} className="fc-slot text">
            <span className="fc-label">
              {slot.label} <i>{slot.hint}</i>
            </span>
            <textarea
              rows={2}
              value={values[slot.id] || ""}
              placeholder={slot.hint}
              onChange={(e) => setValues((v) => ({ ...v, [slot.id]: e.target.value }))}
            />
          </label>
        ) : (
          <div
            key={slot.id}
            className={`fc-slot drop${over === slot.id ? " over" : ""}${values[slot.id] ? " full" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(slot.id);
            }}
            onDragLeave={() => setOver("")}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOver("");
              take(slot, Array.from(e.dataTransfer.files));
            }}
            onClick={() => pickers.current[slot.id]?.click()}
          >
            <span className="fc-label">
              {slot.label} <i>{slot.hint}</i>
              {!slot.required && <em> · optional</em>}
            </span>
            <span className="fc-value">
              {busySlot === slot.id ? "uploading…" : names[slot.id] || (values[slot.id] ? "ready" : "drop a file, or click to browse")}
            </span>
            {pool.some((o) => matchesKind(o.content_type, slot.kind)) && (
              <select
                className="fc-pick"
                value=""
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const hit = pool.find((o) => o.url === e.target.value);
                  if (hit) setSlot(slot, hit.url, hit.name);
                }}
              >
                <option value="">…or pick from media</option>
                {pool
                  .filter((o) => matchesKind(o.content_type, slot.kind))
                  .map((o) => (
                    <option key={o.key} value={o.url}>
                      {o.name}
                    </option>
                  ))}
              </select>
            )}
            <input
              ref={(el) => {
                pickers.current[slot.id] = el;
              }}
              type="file"
              accept={ACCEPT[slot.kind]}
              multiple={multi(slot)}
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files?.length) take(slot, Array.from(e.target.files));
                e.target.value = "";
              }}
            />
          </div>
        ),
      )}

      {(flow.choices || []).map((c) => (
        <label key={c.id} className="fc-choice">
          <span className="fc-label">{c.label}</span>
          <select value={values[c.id]} onChange={(e) => setValues((v) => ({ ...v, [c.id]: e.target.value }))}>
            {c.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ))}

      <div className="fc-foot">
        <span className="fc-need">
          {!live
            ? "this model is not on your account"
            : missing.length
              ? `needs ${missing.map((s) => s.label.toLowerCase()).join(" + ")}`
              : "ready"}
        </span>
        <button type="button" className="fc-run" disabled={!live || running || missing.length > 0} onClick={run}>
          {running ? "running…" : "Run flow"}
        </button>
      </div>

      {note && <div className={`fc-note${note.startsWith("failed") ? " warn" : ""}`}>{note}</div>}

      {result && (
        <div className="fc-result">
          {result.kind === "video" && <video src={result.url} controls autoPlay loop muted />}
          {result.kind === "image" && <img src={result.url} alt="" />}
          {result.kind === "audio" && <audio src={result.url} controls />}
          <button
            type="button"
            className="mini-btn copy-url"
            onClick={() => {
              navigator.clipboard.writeText(result.url);
              psRef.current.toast("R2 URL copied", "ok");
            }}
          >
            <IcCopy /> URL
          </button>
        </div>
      )}
    </div>
  );
}
