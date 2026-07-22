import { useState } from "react";
import type { MediaObject } from "./api";
import { kindOf, type PS } from "./shared";
import "./vrm-picker.css";

function vrmMedia(objects: MediaObject[]): MediaObject[] {
  return objects.filter((object) => kindOf(object.content_type, object.url) === "model");
}

export default function VrmPicker({
  ps,
  onPick,
  label = "Choose VRM…",
  className = "btn",
  disabled = false,
}: {
  ps: PS;
  onPick: (object: MediaObject) => void | Promise<void>;
  label?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const models = vrmMedia(ps.media?.objects || []);

  async function choose(object: MediaObject) {
    setPicking(object.key);
    try {
      await onPick(object);
      setOpen(false);
    } catch (error: any) {
      ps.toast(`VRM load failed: ${String(error?.message || error)}`);
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
          <section className="vrm-picker" role="dialog" aria-modal="true" aria-label="Choose a VRM from Media" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <b>Character library</b>
                <span>VRMs already stored in Project Media</span>
              </div>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="vrm-picker-list">
              {models.map((object) => (
                <button key={object.key} type="button" className="vrm-picker-item" disabled={!!picking} onClick={() => void choose(object)}>
                  <span className="vrm-picker-cube">3D</span>
                  <span className="vrm-picker-meta">
                    <b>{object.name}</b>
                    <small>{(object.bytes / 1024 / 1024).toFixed(1)} MB · {object.key}</small>
                  </span>
                  <span>{picking === object.key ? "Loading…" : "Use →"}</span>
                </button>
              ))}
              {!models.length && (
                <div className="vrm-picker-empty">
                  No VRMs in Media yet. Generate one in Create, or load a local <code>.vrm</code> directly in Head or Animation.
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
