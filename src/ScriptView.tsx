// Script ↔ stage. The screenplay on the left, what it plays on the right, one
// cursor driving both. The spoken track lives where it already lived — speech
// tracers on beats, with voices[tracer.id] holding the generated line — so an
// edit here is the same edit the beat dialog makes, and readiness keeps scoring
// it. Editing a line drops its voice, which is what lights the Generate button:
// the button exists to tell you what is out of date, not to be pressed blindly.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Shot } from "./api";
import {
  BEAT_SECONDS,
  buildPreviewCut,
  extOf,
  loadPipeline,
  newId,
  savePipeline,
  speakAs,
  type Pipeline,
  type Tracer,
} from "./pipeline";
import type { PS } from "./shared";

type Line = { shotId: string; beat: number; tracer: Tracer };

// Every speech tracer on the board, in beat order then in-beat time order —
// the screenplay reading order.
function scriptLines(shots: Shot[], pipe: Pipeline): Line[] {
  return shots.flatMap((s, i) =>
    extOf(pipe, s.id)
      .tracers.filter((t) => t.kind === "speech")
      .sort((a, b) => (a.path[0]?.t ?? 0) - (b.path[0]?.t ?? 0))
      .map((tracer) => ({ shotId: s.id, beat: i + 1, tracer })),
  );
}

const isStale = (pipe: Pipeline, l: Line) => !!l.tracer.text?.trim() && !extOf(pipe, l.shotId).voices[l.tracer.id];

export default function ScriptView({ ps, active }: { ps: PS; active: boolean }) {
  const [pipe, setPipe] = useState<Pipeline>(() => loadPipeline(ps.board?.id || "default"));
  const [cursor, setCursor] = useState(0); // index into the preview cut === beat index
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const psRef = useRef(ps);
  psRef.current = ps;

  // Studio and the board write the same pipeline doc; re-read on activation so
  // a line edited in the beat dialog is not overwritten by a stale clone here.
  useEffect(() => {
    if (active) setPipe(loadPipeline(ps.board?.id || "default"));
  }, [active, ps.board?.id, ps.board?.rev]);

  const mut = (fn: (p: Pipeline) => void) => {
    const id = psRef.current.board?.id || "default";
    const next = loadPipeline(id);
    fn(next);
    savePipeline(id, next);
    setPipe(next);
  };

  const shots = useMemo(() => ps.board?.shots || [], [ps.board]);
  const lines = useMemo(() => scriptLines(shots, pipe), [shots, pipe]);
  const cut = useMemo(() => buildPreviewCut(shots, pipe), [shots, pipe]);
  const stale = lines.filter((l) => isStale(pipe, l));
  const cur = cut.items[cursor];
  const curShot = shots[cursor];

  /* ── the cursor ── */
  // Stills advance on a timer; a clip advances when it ends. Same contract the
  // board's animatic player uses, so the two cannot disagree about the cut.
  useEffect(() => {
    if (!playing || cur?.kind !== "still") return;
    const t = setTimeout(() => advance(), (cur?.seconds || BEAT_SECONDS) * 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, cursor, cur]);

  function advance() {
    if (cursor + 1 < cut.items.length) setCursor(cursor + 1);
    else stop();
  }
  function stop() {
    setPlaying(false);
    audioRef.current?.pause();
  }
  function playFrom(i: number) {
    setCursor(i);
    setPlaying(true);
    const a = audioRef.current;
    if (a) {
      a.currentTime = cut.items.slice(0, i).reduce((s, it) => s + it.seconds, 0);
      a.play().catch(() => {});
    }
  }

  /* ── editing ── */
  function editLine(l: Line, text: string) {
    mut((p) => {
      const x = extOf(p, l.shotId);
      const t = x.tracers.find((t) => t.id === l.tracer.id);
      if (!t || t.text === text) return;
      t.text = text;
      // the recorded line no longer matches the written one — drop it so the
      // Generate button can see exactly what is out of date
      delete x.voices[t.id];
      p.beats[l.shotId] = x;
    });
  }

  function addLine(shotId: string) {
    mut((p) => {
      const x = extOf(p, shotId);
      const at = 0.5 + x.tracers.filter((t) => t.kind === "speech").length * 2.5;
      x.tracers.push({ id: newId(), characterId: null, kind: "speech", path: [{ t: at, x: 0.5, y: 0.55 }], text: "" });
      p.beats[shotId] = x;
    });
  }

  function removeLine(l: Line) {
    mut((p) => {
      const x = extOf(p, l.shotId);
      x.tracers = x.tracers.filter((t) => t.id !== l.tracer.id);
      delete x.voices[l.tracer.id];
      p.beats[l.shotId] = x;
    });
  }

  function setSpeaker(l: Line, characterId: string | null) {
    mut((p) => {
      const x = extOf(p, l.shotId);
      const t = x.tracers.find((t) => t.id === l.tracer.id);
      if (t) t.characterId = characterId;
      p.beats[l.shotId] = x;
    });
  }

  async function generateStale() {
    for (const [i, l] of stale.entries()) {
      setBusy(`voice ${i + 1}/${stale.length}`);
      try {
        const art = await speakAs(psRef.current, pipe, l.tracer.characterId, l.tracer.text || "", mut);
        mut((p) => {
          const x = extOf(p, l.shotId);
          x.voices[l.tracer.id] = art;
          p.beats[l.shotId] = x;
        });
      } catch (e: any) {
        psRef.current.toast(`Beat ${l.beat} voice failed: ${String(e.message || e)}`);
        break;
      }
    }
    setBusy(null);
  }

  if (!shots.length) return <div className="sc-empty">Open a project with beats to see its script.</div>;

  return (
    <div className="sc-wrap">
      <div className="sc-bar">
        <button type="button" className="beat-btn" onClick={() => (playing ? stop() : playFrom(cursor))}>
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <span className="sc-pos">
          Beat {cursor + 1} / {shots.length}
          {cur?.kind === "video" ? " · clip" : " · still"}
        </span>
        <span className="sc-spacer" />
        <span className="sc-count">
          {lines.length} line{lines.length === 1 ? "" : "s"}
          {stale.length ? ` · ${stale.length} need voicing` : " · all voiced"}
        </span>
        <button
          type="button"
          className={`beat-btn${stale.length ? " gold-btn" : ""}`}
          disabled={!stale.length || !!busy}
          onClick={generateStale}
          title={stale.length ? "Generate the lines whose text changed" : "Every line has a current recording"}
        >
          {busy || (stale.length ? `Generate ${stale.length} line${stale.length === 1 ? "" : "s"}` : "Up to date")}
        </button>
      </div>

      <div className="sc-cols">
        <div className="sc-script">
          {shots.map((s, i) => {
            const beatLines = lines.filter((l) => l.shotId === s.id);
            const ext = extOf(pipe, s.id);
            return (
              <section key={s.id} className={`sc-beat${i === cursor ? " current" : ""}`}>
                <header onClick={() => playFrom(i)}>
                  <b>
                    {String(i + 1).padStart(2, "0")}
                    {ext.locationId ? ` · ${ext.locationId.toUpperCase().replace(/-/g, " ")}` : ""}
                  </b>
                  <span className="sc-add" onClick={(e) => (e.stopPropagation(), addLine(s.id))} title="Add a line">
                    + line
                  </span>
                </header>
                {/* action: the render prompt, read-only here — it is edited where
                    it is rendered, and the geography gate reads the same text */}
                <p className="sc-action">{s.prompt || <i>no action written</i>}</p>
                {beatLines.map((l) => (
                  <div key={l.tracer.id} className={`sc-line${isStale(pipe, l) ? " stale" : ""}`}>
                    <select value={l.tracer.characterId || ""} onChange={(e) => setSpeaker(l, e.target.value || null)}>
                      <option value="">(narration)</option>
                      {pipe.characters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <textarea
                      value={l.tracer.text || ""}
                      rows={1}
                      placeholder="spoken line…"
                      onFocus={() => setCursor(i)}
                      onChange={(e) => editLine(l, e.target.value)}
                    />
                    {ext.voices[l.tracer.id] && <audio controls src={ext.voices[l.tracer.id].url} />}
                    <span className="sc-del" onClick={() => removeLine(l)} title="Delete this line">
                      ×
                    </span>
                  </div>
                ))}
              </section>
            );
          })}
        </div>

        <div className="sc-stage">
          {cur?.kind === "video" ? (
            <video key={cursor} src={cur.url} autoPlay={playing} muted={!!cut.audio} controls onEnded={advance} onError={advance} />
          ) : cur?.url ? (
            <img key={cursor} src={cur.url} alt={cur.label} />
          ) : (
            <div className="sc-black" />
          )}
          <div className="sc-stage-meta">
            {curShot ? `Beat ${cursor + 1} · ${cur?.label || ""}` : ""}
            {cut.skipped ? ` · ${cut.skipped} beat${cut.skipped === 1 ? "" : "s"} not yet rendered` : ""}
          </div>
          {cut.audio && <audio ref={audioRef} src={cut.audio} />}
        </div>
      </div>
    </div>
  );
}
