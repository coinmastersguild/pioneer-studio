import { useState } from "react";
import type { MediaObject } from "./api";
import { kindOf, type PS } from "./shared";
import "./vrm-picker.css";

export default function VrmPicker({
  ps,
  onPick,
  label = "Choose VRM…",
  className = "btn",
  disabled = false,
  kind = "model",
}: {
  ps: PS;
  onPick: (object: MediaObject) => void | Promise<void>;
  label?: string;
  className?: string;
  disabled?: boolean;
  kind?: "model" | "image";
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const models = (ps.media?.objects || []).filter((object) => kindOf(object.content_type, object.url) === kind);

  async function choose(object: MediaObject) {
    setPicking(object.key);
    try {
      await onPick(object);
      setOpen(false);
    } catch (error: any) {
      ps.toast(`${kind === "image" ? "Image" : "VRM"} load failed: ${String(error?.message || error)}`);
    } finally {
      setPicking(null);
    }
  }

  return (
    <>
      <button type="button" className={className} disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && (
        <div className="vrm-picker-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <section className="vrm-picker" role="dialog" aria-modal="true" aria-label={kind === "image" ? "Choose an image from Media" : "Choose a VRM from Media"} onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <b>{kind === "image" ? "Image library" : "Character library"}</b>
                <span>{kind === "image" ? "Images" : "VRMs"} already stored in Project Media</span>
              </div>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="vrm-picker-list">
              {models.map((object) => (
                <button key={object.key} type="button" className="vrm-picker-item" disabled={!!picking} onClick={() => void choose(object)}>
                  {kind === "image" ? <img className="vrm-picker-thumb" src={object.url} alt="" /> : <span className="vrm-picker-cube">3D</span>}
                  <span className="vrm-picker-meta">
                    <b>{object.name}</b>
                    <small>{(object.bytes / 1024 / 1024).toFixed(1)} MB · {object.key}</small>
                  </span>
                  <span>{picking === object.key ? "Loading…" : "Use →"}</span>
                </button>
              ))}
              {!models.length && (
                <div className="vrm-picker-empty">
                  {kind === "image"
                    ? "No images in Media yet. Generate or upload one first."
                    : <>No VRMs in Media yet. Generate one in Create, or load a local <code>.vrm</code> directly in Head or Animation.</>}
                </div>
              )}
            </div>
            <footer>
              <button type="button" className="btn" onClick={() => { setOpen(false); ps.setMode("media"); }}>Open Media</button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
