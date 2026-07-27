import { useRef, useState } from "react";
import { captionImage, patchShot, uploadMedia, type MediaObject, type Shot } from "./api";
import { isShotRunning, renderShot } from "./shots";
import { fmtTime, kindOf, PH, type PS } from "./shared";
import {
  bakeTracerPng,
  beatRefs,
  buildFinalPrompt,
  extOf,
  genImage,
  markBeatEdited,
  pickModel,
  proposeTracers,
  REF_INTENTS,
  refIntentOf,
  ttsLine,
  type Pipeline,
  type Tracer,
} from "./pipeline";
import { solveCameraFromClip } from "./cameraSolve";
import TracerEditor from "./TracerEditor";

// Every pipeline step for one beat,
// each artifact regenerable with its own prompt.
export default function BeatDialog({
  ps,
  shot,
  index,
  pipe,
  mut,
  onClose,
  onNext,
}: {
  ps: PS;
  shot: Shot;
  index: number;
  pipe: Pipeline;
  mut(fn: (p: Pipeline) => void): void;
  onClose(): void;
  onNext(): void;
}) {
  const [text, setText] = useState(shot.prompt);
  const [busy, setBusy] = useState<string | null>(null); // which row is working
  const [dragOver, setDragOver] = useState(false);
  const [picking, setPicking] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const ext = extOf(pipe, shot.id);
  const [finalPrompt, setFinalPrompt] = useState(ext.finalPrompt);
  const rendering = isShotRunning(shot);
  const t0 = index * 10; // fixed 10s grid (BEAT_SECONDS)
  const approved = pipe.characters.filter((c) => c.approved);
  const nameOf = (id: string | null) => pipe.characters.find((c) => c.id === id)?.name || "camera";
  const videoModel = pickModel(ps.models, "video");
  const speech = ext.tracers.filter((t) => t.kind === "speech");
  // Everything is optional — a beat with only a still renders. Say what would
  // sharpen the result, never block on it.
  const missingRefs = [
    !shot.result && "no still",
    !ext.tracers.length && "no tracers",
    !approved.some((c) => ext.characterIds.includes(c.id)) && "no cast",
  ].filter(Boolean);

  const run = async (row: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(row);
    try {
      await fn();
    } catch (e: any) {
      ps.toast(String(e.message || e));
    } finally {
      setBusy(null);
    }
  };

  async function saveText(): Promise<Shot | null> {
    if (!ps.apiKey) {
      ps.toast("Paste your sk-pioneer key first");
      return null;
    }
    const sb = await patchShot(ps.apiKey, undefined, shot.id, { prompt: text });
    ps.setBoard(sb);
    mut((p) => markBeatEdited(p, shot.id)); // flag downstream artifacts ⚠ stale
    return sb.shots.find((s) => s.id === shot.id) || null;
  }

  // Saving is only ever saving. Generating spends credits and replaces the
  // picture, so it happens when the user presses generate — never as a side
  // effect of writing text down.
  const save = () =>
    run("text", async () => {
      if (await saveText()) ps.toast("Beat text saved", "ok");
    });

  // A beat that already has a still gets *edited* from it — the picture the user
  // put there is the subject, and the text is the instruction. Only an empty
  // beat generates from nothing. Saves first: the text IS the instruction.
  const generate = () =>
    run("text", async () => {
      const fresh = await saveText();
      if (!fresh || !text.trim()) return;
      if (fresh.result) await renderShot(ps, fresh, { editFrom: fresh.result.url });
      else await renderShot(ps, fresh, { refs: beatRefs(pipe, ext) });
    });

  const defaultFinal = () => buildFinalPrompt(shot.prompt, ext, pipe.characters);

  /** Attach an existing image as this beat's still, and let it describe itself.
   *  A picture dropped on an empty beat writes the beat text; a beat that
   *  already has text keeps it — re-describing is an explicit button. */
  async function attachImage(url: string, key: string, contentType: string, bytes = 0) {
    const sb = await patchShot(ps.apiKey, undefined, shot.id, {
      result: { url, key, content_type: contentType, bytes },
      status: "ready",
    });
    ps.setBoard(sb);
    if (text.trim()) return;
    await describeFrom(url);
  }

  async function describeFrom(url: string) {
    const caption = await captionImage(ps.apiKey, url);
    setText(caption);
    const sb = await patchShot(ps.apiKey, undefined, shot.id, { prompt: caption });
    ps.setBoard(sb);
    mut((p) => markBeatEdited(p, shot.id));
    ps.toast("Described from the image", "gold");
  }

  const attachFile = (file: File) =>
    run("image", async () => {
      if (!ps.apiKey) return ps.toast("Paste your sk-pioneer key first");
      if (!file.type.startsWith("image/")) return ps.toast("Beats take an image here");
      const up = await uploadMedia(ps.apiKey, file);
      ps.charge(up.credits_remaining ?? null);
      ps.refreshMedia();
      ps.toast(`${file.name} → saved to Media`, "ok");
      await attachImage(up.url, up.key, up.content_type, file.size);
    });

  const mediaImages = (ps.media?.objects || []).filter((o: MediaObject) => o.content_type.startsWith("image/"));

  const img = (a: { url: string } | null, fallback?: boolean) =>
    a
      ? { backgroundImage: `url(${a.url})`, backgroundSize: "cover" as const, backgroundPosition: "center" as const }
      : fallback
        ? { background: PH[index % PH.length] }
        : { background: "var(--bg-elevated)" };

  return (
    <div className="bd-overlay" onClick={onClose}>
      <div className="release-card beat-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="bd-head">
          <b>Beat {String(index + 1).padStart(2, "0")}</b>
          <span className="bd-time">
            {fmtTime(t0)}–{fmtTime(t0 + 10)} · 10s
          </span>
          <div className="grow" />
          <button type="button" className="beat-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* ── Beat text + still ── */}
        <div className="bd-row">
          <div className="k">Beat text</div>
          <div className="v">
            <textarea
              className="bd-text"
              autoFocus={!shot.prompt}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="a cat walks across the street"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void save();
                }
              }}
            />
            <div className="bd-actions">
              <button type="button" className="beat-btn accent" disabled={busy === "text" || !text.trim()} onClick={save}>
                {busy === "text" ? "saving…" : "Save"}
              </button>
              <button type="button" className="beat-btn" disabled={rendering || !!busy || !text.trim()} onClick={generate}>
                {rendering ? `${shot.status}…` : shot.result ? "Edit this image ⟳" : "Generate still"}
              </button>
              <button
                type="button"
                className="beat-btn"
                disabled={!text.trim() || busy === "text"}
                onClick={() =>
                  run("text", async () => {
                    await saveText();
                    onNext();
                  })
                }
              >
                Save &amp; next beat →
              </button>
            </div>
          </div>
        </div>

        <div className="bd-row">
          <div className="k">Placeholder</div>
          <div className="v">
            <div
              className={`bd-img${rendering ? " busy" : ""}${dragOver ? " drop" : ""}`}
              style={img(shot.result, true)}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes("Files")) return;
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOver(false);
                const f = e.dataTransfer.files[0];
                if (f) void attachFile(f);
              }}
            />
            <div className="bd-desc">
              {busy === "image"
                ? "reading the image…"
                : rendering
                  ? `rendering — ${shot.status}`
                  : shot.result
                    ? "fast draft still — the final look comes from the render below"
                    : "drop an image here, pick one below, or save the beat text to render a placeholder"}
            </div>
            <div className="bd-actions">
              <button type="button" className="beat-btn" disabled={!!busy} onClick={() => picker.current?.click()}>
                Upload image
              </button>
              {!!mediaImages.length && (
                <button type="button" className="beat-btn" disabled={!!busy} onClick={() => setPicking((v) => !v)}>
                  {picking ? "Hide media" : `Use from media (${mediaImages.length})`}
                </button>
              )}
              {shot.result && (
                <button
                  type="button"
                  className="beat-btn"
                  disabled={!!busy}
                  onClick={() => void run("image", () => describeFrom(shot.result!.url))}
                >
                  Describe from image
                </button>
              )}
            </div>
            {picking && (
              // thumbnails, not a dropdown of filenames — you cannot pick a
              // still by its content-addressed name
              <div className="bd-mediagrid">
                {mediaImages.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    className={`bd-mthumb${shot.result?.url === o.url ? " on" : ""}`}
                    title={o.name}
                    disabled={!!busy}
                    style={{ backgroundImage: `url(${o.url})` }}
                    onClick={() => {
                      setPicking(false);
                      void run("image", () => attachImage(o.url, o.key, o.content_type, o.bytes));
                    }}
                  >
                    <span>{o.name}</span>
                  </button>
                ))}
              </div>
            )}
            <input
              ref={picker}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void attachFile(f);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        <>
            {/* ── Characters in this beat ── */}
            <div className="bd-row">
              <div className="k">Characters</div>
              <div className="v">
                {approved.length ? (
                  <div className="bd-chips">
                    {approved.map((c) => (
                      <label key={c.id} className="bd-chip">
                        <input
                          type="checkbox"
                          checked={ext.characterIds.includes(c.id)}
                          onChange={(e) =>
                            mut((p) => {
                              const x = extOf(p, shot.id);
                              x.characterIds = e.target.checked
                                ? [...x.characterIds, c.id]
                                : x.characterIds.filter((i) => i !== c.id);
                              p.beats[shot.id] = x;
                            })
                          }
                        />
                        {c.name}
                        {c.image && <i className="bd-thumb" style={img(c.image)} />}
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="bd-desc">no approved characters yet — propose &amp; approve the roster in the Assets panel</div>
                )}
              </div>
            </div>

            {/* ── Motion tracers ── */}
            <div className="bd-row">
              <div className="k">Tracers</div>
              <div className="v">
                <TracerEditor
                  bg={shot.result?.url || null}
                  tracers={ext.tracers}
                  chars={pipe.characters}
                  onChange={(next: Tracer[]) =>
                    mut((p) => {
                      const x = extOf(p, shot.id);
                      x.tracers = next;
                      x.tracerImage = null; // overlay changed → needs a re-bake
                      p.beats[shot.id] = x;
                    })
                  }
                />
                <div className="bd-actions">
                  <button
                    type="button"
                    className="beat-btn"
                    disabled={busy === "tracers"}
                    onClick={() =>
                      run("tracers", async () => {
                        const chars = approved.filter((c) => ext.characterIds.includes(c.id));
                        const ts = await proposeTracers(ps.apiKey, shot.prompt, chars.length ? chars : approved);
                        mut((p) => {
                          const x = extOf(p, shot.id);
                          x.tracers = ts;
                          x.tracerImage = null;
                          p.beats[shot.id] = x;
                        });
                      })
                    }
                  >
                    AI draft
                  </button>
                  <button
                    type="button"
                    className="beat-btn accent"
                    disabled={busy === "tracers" || !ext.tracers.length}
                    onClick={() =>
                      run("tracers", async () => {
                        const art = await bakeTracerPng(ps, ext.tracers, pipe.characters);
                        mut((p) => {
                          const x = extOf(p, shot.id);
                          x.tracerImage = art;
                          p.beats[shot.id] = x;
                        });
                      })
                    }
                  >
                    {ext.tracerImage ? "Overlay saved ✓ — re-bake" : "Save overlay PNG"}
                  </button>
                </div>
              </div>
            </div>

            {/* ── Audio: voice lines from speech tracers ── */}
            <div className="bd-row">
              <div className="k">Audio</div>
              <div className="v">
                {speech.length ? (
                  speech.map((t) => (
                    <div key={t.id} className="bd-voice">
                      <span className="bd-desc">
                        {nameOf(t.characterId)} @ {(t.path[0]?.t ?? 0).toFixed(1)}s — “{t.text}”
                      </span>
                      <button
                        type="button"
                        className="beat-btn"
                        disabled={busy === "voice" + t.id}
                        onClick={() =>
                          run("voice" + t.id, async () => {
                            const art = await ttsLine(ps, t.text || "");
                            mut((p) => {
                              const x = extOf(p, shot.id);
                              x.voices[t.id] = art;
                              p.beats[shot.id] = x;
                            });
                          })
                        }
                      >
                        {busy === "voice" + t.id ? "…" : ext.voices[t.id] ? "⟳" : "Voice"}
                      </button>
                      {ext.voices[t.id] && <audio controls src={ext.voices[t.id].url} />}
                    </div>
                  ))
                ) : (
                  <div className="bd-desc">add speech tracers above — each line becomes a timestamped voice clip. Music &amp; the full mix live in the Assets panel.</div>
                )}
              </div>
            </div>

            {/* ── Reference intent + camera move from a reference clip ── */}
            <div className="bd-row">
              <div className="k">Reference</div>
              <div className="v">
                <div className="bd-chips" role="radiogroup" aria-label="Reference intent">
                  {REF_INTENTS.map((r) => (
                    <label key={r.id} className="bd-chip" title={r.hint}>
                      <input
                        type="radio"
                        name={`refintent-${shot.id}`}
                        checked={refIntentOf(ext).id === r.id}
                        onChange={() =>
                          mut((p) => {
                            const x = extOf(p, shot.id);
                            x.refIntent = r.id;
                            p.beats[shot.id] = x;
                          })
                        }
                      />
                      {r.label}
                    </label>
                  ))}
                </div>
                <div className="bd-desc">{refIntentOf(ext).hint}</div>
                <div className="bd-actions">
                  <label className="beat-btn" style={{ cursor: busy === "camera" ? "wait" : "pointer" }}>
                    <input
                      type="file"
                      accept="video/*"
                      style={{ display: "none" }}
                      disabled={busy === "camera"}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (!f) return;
                        void run("camera", async () => {
                          const { solve, description } = await solveCameraFromClip(f);
                          mut((p) => {
                            const x = extOf(p, shot.id);
                            x.cameraMove = description;
                            p.beats[shot.id] = x;
                          });
                          ps.toast(`Camera solved · ${Math.round(solve.summary.confidence * 100)}% confidence`, "ok");
                        });
                      }}
                    />
                    {busy === "camera" ? "solving…" : ext.cameraMove ? "Re-solve camera from clip ⟳" : "Solve camera from reference clip"}
                  </label>
                  {ext.cameraMove && (
                    <button
                      type="button"
                      className="beat-btn"
                      title="Clear the solved camera move"
                      onClick={() =>
                        mut((p) => {
                          const x = extOf(p, shot.id);
                          x.cameraMove = undefined;
                          p.beats[shot.id] = x;
                        })
                      }
                    >
                      ✕
                    </button>
                  )}
                </div>
                {ext.cameraMove && <div className="bd-desc">{ext.cameraMove}</div>}
              </div>
            </div>

            {/* ── Final render ── */}
            <div className="bd-row">
              <div className="k">Final</div>
              <div className="v">
                <textarea
                  className="bd-text"
                  value={finalPrompt}
                  onChange={(e) => setFinalPrompt(e.target.value)}
                  placeholder={defaultFinal()}
                />
                <div className="bd-desc">
                  {ext.staleFinal && (
                    <>
                      <span className="bd-badge" title="beat edited after this final rendered — re-render">
                        ⚠ stale
                      </span>{" "}
                    </>
                  )}
                  refs: {shot.result ? "still ✓" : "still ✗"} · {ext.characterIds.length} character
                  {ext.characterIds.length === 1 ? "" : "s"} · {ext.tracers.length ? "tracers ✓" : "tracers ✗"}
                  {!videoModel && " — no video model available right now"}
                </div>
                {missingRefs.length > 0 && (
                  <div className="bd-desc">
                    {missingRefs.join(" · ")} — renders anyway, with less to keep it consistent
                  </div>
                )}
                <div className="bd-actions">
                  <button
                    type="button"
                    className="beat-btn accent"
                    disabled={!videoModel || busy === "final"}
                    onClick={() =>
                      run("final", async () => {
                        let overlay = ext.tracerImage;
                        if (!overlay && ext.tracers.length) {
                          overlay = await bakeTracerPng(ps, ext.tracers, pipe.characters);
                          mut((p) => {
                            const x = extOf(p, shot.id);
                            x.tracerImage = overlay;
                            p.beats[shot.id] = x;
                          });
                        }
                        const prompt = finalPrompt.trim() || defaultFinal();
                        // The still is the frame being animated, so it leads the
                        // reference list; cast and tracer overlay refine it.
                        const refs = [
                          shot.result?.url || "",
                          ...approved.filter((c) => ext.characterIds.includes(c.id)).map((c) => c.image?.url || ""),
                          overlay?.url || "",
                        ].filter(Boolean);
                        const art = await genImage(ps, prompt, { refs, video: true });
                        mut((p) => {
                          const x = extOf(p, shot.id);
                          x.finalPrompt = prompt;
                          x.finalClip = art;
                          x.staleFinal = false; // fresh render — no longer stale
                          p.beats[shot.id] = x;
                        });
                      })
                    }
                  >
                    {busy === "final" ? "rendering… (slow)" : ext.finalClip ? "Re-render final ⟳" : "Render final 10s clip"}
                  </button>
                </div>
                {ext.finalClip &&
                  (kindOf(ext.finalClip.content_type, ext.finalClip.url) === "video" ? (
                    <video className="bd-video" controls src={ext.finalClip.url} />
                  ) : (
                    <div className="bd-img" style={img(ext.finalClip)} />
                  ))}
              </div>
            </div>
        </>
      </div>
    </div>
  );
}
