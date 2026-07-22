import { useRef, useState } from "react";
import { colorFor, newId, type Character, type Tracer } from "./pipeline";

// Draw motion dots, paths, and speech markers over the scene.
// Click to drop points (times auto-spread over the 10s beat), drag to adjust.
export default function TracerEditor({
  bg,
  tracers,
  chars,
  onChange,
}: {
  bg: string | null;
  tracers: Tracer[];
  chars: Character[];
  onChange(next: Tracer[]): void;
}) {
  const [tool, setTool] = useState<{ kind: "move" | "speech"; characterId: string | null } | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null); // move path being drawn
  const [speechText, setSpeechText] = useState("");
  const [sel, setSel] = useState<{ tid: string; pi: number } | null>(null); // selected point (time editing)
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ tid: string; pi: number } | null>(null);

  const roster: { id: string | null; name: string }[] = [
    ...chars.filter((c) => c.approved).map((c) => ({ id: c.id as string | null, name: c.name })),
    { id: null, name: "camera" },
  ];

  const pos = (e: React.PointerEvent): { x: number; y: number } => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  // spread a path's timestamps evenly across the beat
  const respread = (t: Tracer): Tracer => ({
    ...t,
    path: t.path.map((p, i, a) => ({ ...p, t: a.length > 1 ? +((i * 10) / (a.length - 1)).toFixed(1) : p.t })),
  });

  const selPt = sel ? tracers.find((t) => t.id === sel.tid)?.path[sel.pi] : undefined;

  function setSelTime(v: number) {
    if (!sel || !Number.isFinite(v)) return;
    const tv = Math.min(10, Math.max(0, v));
    onChange(tracers.map((t) => (t.id === sel.tid ? { ...t, path: t.path.map((pt, i) => (i === sel.pi ? { ...pt, t: tv } : pt)) } : t)));
  }

  function onCanvas(e: React.PointerEvent) {
    if (drag.current || !tool) return;
    const p = pos(e);
    if (tool.kind === "speech") {
      const text = speechText.trim();
      if (!text) return;
      onChange([...tracers, { id: newId(), characterId: tool.characterId, kind: "speech", path: [{ t: 5, x: p.x, y: p.y }], text }]);
      setSpeechText("");
      setTool(null);
      return;
    }
    if (draftId) {
      onChange(tracers.map((t) => (t.id === draftId ? respread({ ...t, path: [...t.path, { t: 0, ...p }] }) : t)));
    } else {
      const t: Tracer = { id: newId(), characterId: tool.characterId, kind: "move", path: [{ t: 0, ...p }] };
      setDraftId(t.id);
      onChange([...tracers, t]);
    }
  }

  function onMove(e: React.PointerEvent) {
    if (!drag.current) return;
    const p = pos(e);
    const { tid, pi } = drag.current;
    onChange(tracers.map((t) => (t.id === tid ? { ...t, path: t.path.map((pt, i) => (i === pi ? { ...pt, ...p } : pt)) } : t)));
  }

  return (
    <div className="tracer-ed">
      <div
        className="tracer-canvas"
        style={bg ? { backgroundImage: `url(${bg})`, backgroundSize: "cover", backgroundPosition: "center" } : {}}
      >
        <svg
          ref={svgRef}
          viewBox="0 0 160 90"
          preserveAspectRatio="none"
          onPointerDown={onCanvas}
          onPointerMove={onMove}
          onPointerUp={() => (drag.current = null)}
          style={{ cursor: tool ? "crosshair" : "default" }}
        >
          {tracers.map((t) => {
            const col = colorFor(chars, t.characterId);
            return (
              <g key={t.id}>
                {t.path.length > 1 && (
                  <polyline
                    points={t.path.map((p) => `${p.x * 160},${p.y * 90}`).join(" ")}
                    fill="none"
                    stroke={col}
                    strokeWidth={1.2}
                    strokeDasharray={t.id === draftId ? "2 1.4" : undefined}
                  />
                )}
                {t.path.map((p, pi) => (
                  <g key={pi}>
                    <circle
                      cx={p.x * 160}
                      cy={p.y * 90}
                      r={2.2}
                      fill={col}
                      stroke={sel?.tid === t.id && sel.pi === pi ? "#fff" : "none"}
                      strokeWidth={0.6}
                      style={{ cursor: "grab" }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        // capture on the svg so move/up keep firing outside the canvas
                        svgRef.current?.setPointerCapture(e.pointerId);
                        drag.current = { tid: t.id, pi };
                        setSel({ tid: t.id, pi });
                      }}
                    />
                    <text x={p.x * 160 + 3} y={p.y * 90 - 2.5} fontSize={4} fill={col} style={{ pointerEvents: "none" }}>
                      {p.t.toFixed(1)}s{t.kind === "speech" && t.text ? ` “${t.text}”` : ""}
                    </text>
                  </g>
                ))}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="tracer-tools">
        {roster.map((r) => (
          <button
            key={r.id ?? "cam"}
            type="button"
            className={`beat-btn${tool?.kind === "move" && tool.characterId === r.id ? " accent" : ""}`}
            onClick={() => {
              setDraftId(null);
              setTool({ kind: "move", characterId: r.id });
            }}
          >
            + {r.name} path
          </button>
        ))}
        <button
          type="button"
          className={`beat-btn${tool?.kind === "speech" ? " accent" : ""}`}
          onClick={() => {
            setDraftId(null);
            setTool({ kind: "speech", characterId: roster[0]?.id ?? null });
          }}
        >
          + speech
        </button>
        {tool?.kind === "speech" && (
          <>
            <select
              className="tracer-sel"
              value={tool.characterId ?? ""}
              onChange={(e) => setTool({ kind: "speech", characterId: e.target.value || null })}
            >
              {roster.map((r) => (
                <option key={r.id ?? "cam"} value={r.id ?? ""}>
                  {r.name}
                </option>
              ))}
            </select>
            <input
              className="tracer-line"
              placeholder="the spoken line — then click where"
              value={speechText}
              onChange={(e) => setSpeechText(e.target.value)}
            />
          </>
        )}
        {selPt && (
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
            t
            <input
              className="tracer-sel"
              type="number"
              min={0}
              max={10}
              step={0.1}
              style={{ width: 56 }}
              value={selPt.t}
              onChange={(e) => setSelTime(e.target.valueAsNumber)}
            />
            s
          </label>
        )}
        {(tool || draftId) && (
          <button
            type="button"
            className="beat-btn"
            onClick={() => {
              setTool(null);
              setDraftId(null);
            }}
          >
            end path
          </button>
        )}
      </div>
      {tracers.length > 0 && (
        <div className="tracer-list">
          {tracers.map((t) => (
            <span key={t.id} className="tracer-chip" style={{ borderColor: colorFor(chars, t.characterId) }}>
              {chars.find((c) => c.id === t.characterId)?.name || "camera"} ·{" "}
              {t.kind === "speech" ? `“${t.text}”` : `${t.path.length} pts`}
              <b onClick={() => onChange(tracers.filter((x) => x.id !== t.id))}>✕</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
