import { useEffect, useMemo, useRef, useState } from "react";
import type { JobModel } from "./api";
import JobForm from "./JobForm";
import { classifyJobModel, type JobCapability } from "./jobCatalog";
import { consumeJobForm } from "./jobHandoff";
import type { PS } from "./shared";

const LANES: { id: JobCapability; label: string; blurb: string }[] = [
  { id: "3d", label: "3D assets", blurb: "image → textured GLB prop" },
  { id: "video_restore", label: "Video restoration", blurb: "restore or upscale an existing video" },
  { id: "image_control", label: "Controlled image", blurb: "structure guidance → image" },
  { id: "lipsync", label: "Lipsync", blurb: "portrait + audio → video" },
  { id: "motion_video", label: "Motion video", blurb: "control take + optional identity → video" },
  { id: "voice_clone", label: "Voice clone", blurb: "reference voice + text → speech" },
  { id: "image_refs", label: "Reference image", blurb: "ordered image references → image" },
  { id: "video_refs", label: "Reference video", blurb: "ordered image references → video" },
  { id: "image", label: "Image", blurb: "text → image" },
  { id: "video", label: "Video", blurb: "text → video" },
  { id: "sfx", label: "Sound effects", blurb: "prompt → sound effect" },
  { id: "music", label: "Music", blurb: "prompt → music or song" },
  { id: "speech", label: "Speech", blurb: "text → spoken audio" },
  { id: "audio", label: "Audio", blurb: "audio generation" },
  { id: "unknown", label: "Other", blurb: "live entry with an unrecognized signature" },
];

export default function ModelIndexView({ ps }: { ps: PS }) {
  const psRef = useRef(ps);
  psRef.current = ps;
  const [selected, setSelected] = useState<JobModel | null>(null);
  const [mediaKey, setMediaKey] = useState<string | undefined>();
  const grouped = useMemo(
    () => new Map(LANES.map((lane) => [lane.id, ps.models.filter((entry) => classifyJobModel(entry) === lane.id)])),
    [ps.models],
  );

  useEffect(() => {
    const current = psRef.current;
    if (current.mode !== "models") return;
    const pending = consumeJobForm();
    if (!pending) return;
    const entry = current.models.find((candidate) => classifyJobModel(candidate) === pending.capability);
    if (entry) {
      setMediaKey(pending.mediaKey);
      setSelected(entry);
    } else {
      current.toast(`No live ${pending.capability.replaceAll("_", " ")} endpoint is available`);
    }
  }, [ps.mode, ps.models]);

  return <div className="media-wrap">
    <div className="media-head"><div><h2>Models</h2><div className="sub">Every live model/endpoint pair, classified from result and parameter signatures. Catalog {ps.catalogRevision || "revision unavailable"}{ps.catalogLimits.max_active_jobs ? ` · ${ps.catalogLimits.max_active_jobs} concurrent jobs` : ""}.</div></div><button type="button" className="mini-btn" onClick={() => void ps.refreshModels(true)}>Refresh catalog</button></div>
    {!ps.catalogAvailable && ps.apiKey && <div className="catalog-warning">GPU catalog temporarily unavailable. Existing jobs continue polling; new submissions are paused.</div>}
    {!ps.models.length ? <div className="ml-none">no models loaded — add your key in Settings to fetch the live catalog</div> : LANES.map((lane) => {
      const rows = grouped.get(lane.id) || [];
      if (!rows.length) return null;
      return <section key={lane.id} className="model-lane"><div className="model-lane-head"><h3>{lane.label}</h3><span>{lane.blurb}</span><span className="mf on">{rows.length} live</span></div><table className="files"><thead><tr><th>Model</th><th>Endpoint</th><th>Result</th><th>Credits</th><th>Notes</th><th /></tr></thead><tbody>{rows.map((entry) => <tr key={`${entry.model}.${entry.endpoint}`}><td><b>{entry.model}</b>{entry.default && <span className="mf on model-default">default</span>}</td><td>{entry.endpoint}</td><td>{entry.result_ext || entry.result || "—"}</td><td>{entry.credits.toLocaleString()}</td><td className="model-note">{entry.note}</td><td><button type="button" className="mini-btn" disabled={!entry.params} onClick={() => { setMediaKey(undefined); setSelected(entry); }}>Configure</button></td></tr>)}</tbody></table></section>;
    })}
    {selected && <JobForm entry={selected} ps={ps} mediaKey={mediaKey} onClose={() => { setSelected(null); setMediaKey(undefined); }} />}
  </div>;
}
