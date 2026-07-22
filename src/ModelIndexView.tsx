import { pickModel } from "./pipeline";
import type { JobModel } from "./api";
import type { PS } from "./shared";

// Capability grouping mirrors pickModel's regexes (pipeline.ts) so the index
// shows exactly what the copilot/router sees. A new model in an existing
// category lights up here with zero code change.
type Cap = { label: string; want: Parameters<typeof pickModel>[1]; blurb: string };
const CAPS: Cap[] = [
  { label: "Image", want: "image", blurb: "text → image" },
  { label: "Image · references", want: "image_refs", blurb: "1–4 reference images → one image" },
  { label: "Video", want: "video", blurb: "text or references → mp4 clip" },
  { label: "Motion video", want: "motion_video", blurb: "ARDY control take + optional identity reference → mp4 clip" },
  { label: "Music", want: "music", blurb: "prompt → scored audio" },
  { label: "Speech", want: "tts", blurb: "text → spoken line" },
];

function capOf(m: JobModel): Cap["label"] {
  const s = `${m.model} ${m.endpoint} ${m.note || ""}`;
  if (m.endpoint === "enhance" && /ltx|pose|motion|control/i.test(s)) return "Motion video";
  if (/video|ltx|wan|kling|veo/i.test(s)) return "Video";
  if (/music|acestep/i.test(s)) return "Music";
  if (/tts|speech|voice|kokoro/i.test(s)) return "Speech";
  if (m.endpoint === "multi_reference" || m.endpoint === "edit") return "Image · references";
  return "Image";
}

export default function ModelIndexView({ ps }: { ps: PS }) {
  const models = ps.models;
  // the model pickModel would choose for each capability = the "default" the copilot lands on
  const picked = new Map<string, string>(); // cap.label -> `${model}.${endpoint}`
  for (const cap of CAPS) {
    const m = pickModel(models, cap.want);
    if (m) picked.set(cap.label, `${m.model}.${m.endpoint}`);
  }

  return (
    <div className="media-wrap">
      <div className="media-head">
        <div>
          <h2>Models</h2>
          <div className="sub">
            Everything the server exposes via <code>GET /api/v1/jobs/models</code>, grouped by capability. The copilot
            and storyboard pipeline route to these automatically — a live model here is one they can pick right now.
          </div>
        </div>
      </div>

      {models.length === 0 ? (
        <div style={{ border: "1px dashed var(--border-strong)", borderRadius: "var(--radius-lg)", padding: 28, textAlign: "center", color: "var(--fg4)", fontSize: 12.5 }}>
          no models loaded — add your key in Settings to fetch the live list
        </div>
      ) : (
        CAPS.map((cap) => {
          const rows = models.filter((m) => capOf(m) === cap.label);
          const live = rows.length > 0;
          return (
            <div key={cap.label} style={{ marginBottom: 22 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
                <h3 style={{ margin: 0, fontSize: 14 }}>{cap.label}</h3>
                <span style={{ fontSize: 11.5, color: "var(--fg3)" }}>{cap.blurb}</span>
                <span className={`mf${live ? " on" : ""}`} style={{ marginLeft: "auto", pointerEvents: "none", fontSize: 11 }}>
                  {live ? "live" : "not available"}
                </span>
              </div>
              {live ? (
                <table className="files">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Endpoint</th>
                      <th>Credits</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => {
                      const isDefault = picked.get(cap.label) === `${m.model}.${m.endpoint}`;
                      return (
                        <tr key={`${m.model}.${m.endpoint}`}>
                          <td>
                            <b>{m.model}</b>
                            {isDefault && <span className="mf on" style={{ marginLeft: 8, pointerEvents: "none", fontSize: 10 }}>default</span>}
                          </td>
                          <td style={{ color: "var(--fg3)" }}>{m.endpoint}</td>
                          <td>{typeof m.credits === "number" ? m.credits.toLocaleString() : m.credits}</td>
                          <td style={{ color: "var(--fg3)", fontSize: 11.5, maxWidth: 460 }}>{m.note}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div style={{ color: "var(--fg4)", fontSize: 12, paddingLeft: 2 }}>
                  no model registered — features that need {cap.label.toLowerCase()} stay gated until one is added
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
