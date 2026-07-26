import { useState } from "react";
import { captionImage, type Shot } from "./api";
import { kindOf, type PS } from "./shared";
import {
  BEAT_SECONDS,
  bakeTracerPng,
  buildFinalPrompt,
  extOf,
  genImage,
  genMusic,
  mixAudio,
  newId,
  pickModel,
  proposeRoster,
  proposeTracers,
  sceneArtOf,
  ttsLine,
  type Pipeline,
} from "./pipeline";

// Assets panel: character roster (propose → approve
// → driving images), batch scene/tracer drafting, sound, and final renders.
export default function AssetsPanel({
  ps,
  pipe,
  mut,
  shots,
}: {
  ps: PS;
  pipe: Pipeline;
  mut(fn: (p: Pipeline) => void): void;
  shots: Shot[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [charPrompt, setCharPrompt] = useState("");
  const [locPrompt, setLocPrompt] = useState("");
  const phase = pipe.phase;
  const beats = shots.map((s) => ({ id: s.id, prompt: s.prompt }));
  const approved = pipe.characters.filter((c) => c.approved);
  const videoModel = pickModel(ps.models, "video");
  const musicModel = pickModel(ps.models, "music");
  const placedBeats = shots.filter((s) => sceneArtOf(pipe, extOf(pipe, s.id))).length;
  const tracersDone = shots.filter((s) => extOf(pipe, s.id).tracers.length).length;
  const finalsDone = shots.filter((s) => extOf(pipe, s.id).finalClip).length;
  // what "Render all" would actually produce: a beat needs some scene reference,
  // and its own still counts. Counting it here means the button can say so
  // before it is pressed rather than skipping in silence.
  const renderable = shots.filter((s) => {
    const x = extOf(pipe, s.id);
    return !x.finalClip && (sceneArtOf(pipe, x) || s.result);
  }).length;
  const allSpeech = shots.flatMap((s) =>
    extOf(pipe, s.id)
      .tracers.filter((t) => t.kind === "speech")
      .map((t) => ({ beatId: s.id, tracer: t })),
  );
  const voicesDone = allSpeech.filter(({ beatId, tracer }) => extOf(pipe, beatId).voices[tracer.id]).length;

  const run = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    try {
      await fn();
    } catch (e: any) {
      ps.toast(String(e.message || e));
    } finally {
      setBusy(null);
    }
  };

  const drivingPrompt = (c: { name: string; description: string; prompt: string }) =>
    `Character sheet of ${c.name}: ${c.description}. ${c.prompt} Full body, single character, neutral studio background, high detail, consistent design.`;
  const locationPrompt = (l: { name: string; description: string; prompt: string }) =>
    `Establishing background plate of ${l.name}: ${l.description}. ${l.prompt} Empty location, no people, no characters, no animals. Wide cinematic shot, consistent lighting.`;

  // propose a cast/location roster from a free prompt (preferred) or the beats
  const propose = (kind: "character" | "location", src: string, reset: () => void) =>
    run("propose-" + kind, async () => {
      const found = await proposeRoster(ps.apiKey, kind, src.trim() || beats);
      let added = 0;
      mut((p) => {
        added = 0; // updater may re-run (StrictMode) — recount
        const list = kind === "character" ? p.characters : p.locations;
        for (const f of found) {
          if (list.some((x) => x.name.toLowerCase() === f.name.toLowerCase())) continue;
          added++;
          if (kind === "character")
            p.characters.push({ id: newId(), name: f.name, description: f.description, approved: false, prompt: "", image: null });
          else p.locations.push({ id: newId(), name: f.name, description: f.description, prompt: "", image: null });
        }
      });
      reset();
      ps.toast(added ? `${added} ${kind === "character" ? "characters" : "locations"} proposed` : "0 new (all duplicates)", "gold");
    });

  /** The exercise is verbalising the place: a plate is one frame, but the words
   *  are what every later render is conditioned on. Reading the description back
   *  out of the image is also how you notice the image is of the wrong place. */
  const verbalize = (l: { id: string; name: string; image: { url: string } | null }) =>
    run("verbalize" + l.id, async () => {
      if (!l.image) throw new Error("give this location an image first");
      const said = await captionImage(
        ps.apiKey,
        l.image.url,
        `Describe this place as a location entry for film continuity: architecture and materials, scale, terrain, time of day, weather, and the light. Two or three sentences. Describe only the place — ignore any people, creatures or vehicles in frame. No preamble.`,
      );
      mut((p) => void (p.locations.find((x) => x.id === l.id)!.description = said));
      ps.toast(`${l.name} described from its plate`, "gold");
    });

  /** One press instead of three screens: propose the locations the beats imply,
   *  render a plate for each, and assign every beat the one its text matches.
   *  Existing locations, plates and assignments are left alone. */
  const draftLocations = () =>
    run("locations", async () => {
      // mut lands on the parent's state, so this cannot read `pipe` back
      // mid-run — it tracks the roster it is building itself.
      let roster = [...pipe.locations];
      if (!roster.length) {
        setBusy("locations — proposing");
        const found = await proposeRoster(ps.apiKey, "location", beats);
        const fresh = found
          .filter((f, i) => found.findIndex((g) => g.name.toLowerCase() === f.name.toLowerCase()) === i)
          .map((f) => ({ id: newId(), name: f.name, description: f.description, prompt: "", image: null }));
        if (!fresh.length) throw new Error("no locations came back — describe them yourself and try again");
        mut((p) => {
          for (const l of fresh) if (!p.locations.some((x) => x.id === l.id)) p.locations.push({ ...l });
        });
        roster = fresh;
      }

      for (const [i, l] of roster.entries()) {
        if (l.image) continue;
        setBusy(`locations — plate ${i + 1}/${roster.length}`);
        const art = await genImage(ps, locationPrompt(l));
        mut((p) => {
          const hit = p.locations.find((x) => x.id === l.id);
          if (hit) hit.image = art;
        });
      }

      // assign by name mention, else everything unassigned lands on the first
      // plate — a wrong location beats no location, and a beat can be re-pointed
      setBusy("locations — assigning");
      mut((p) => {
        for (const s of shots) {
          const x = extOf(p, s.id);
          if (x.locationId) continue;
          const text = s.prompt.toLowerCase();
          const hit = roster.find((l) => l.name && text.includes(l.name.toLowerCase()));
          x.locationId = (hit || roster[0]).id;
          p.beats[s.id] = x;
        }
      });
      ps.toast(`${roster.length} location${roster.length === 1 ? "" : "s"} ready and assigned to every beat`, "gold");
    });

  return (
    <div className="assets-panel">
      {/* ── Characters ── */}
      <div className="ap-sec">
        <div className="ap-head">
          <b>Characters</b>
          <span className="bd-desc">describe your cast → approve → high-res driving images</span>
          <div className="grow" />
          <input
            className="ap-music"
            style={{ maxWidth: 240 }}
            placeholder="describe a character or the whole cast…"
            value={charPrompt}
            onChange={(e) => setCharPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (charPrompt.trim() || beats.length) && propose("character", charPrompt, () => setCharPrompt(""))}
          />
          <button
            type="button"
            className="beat-btn"
            disabled={busy != null || (!charPrompt.trim() && !beats.length)}
            onClick={() => propose("character", charPrompt, () => setCharPrompt(""))}
          >
            {busy === "propose-character" ? "proposing…" : charPrompt.trim() ? "Propose" : "Propose from beats"}
          </button>
          <button
            type="button"
            className="beat-btn"
            onClick={() =>
              mut((p) => p.characters.push({ id: newId(), name: "New character", description: "", approved: false, prompt: "", image: null }))
            }
          >
            + Add
          </button>
        </div>
        {pipe.characters.length > 0 && (
          <div className="ap-chars">
            {pipe.characters.map((c) => (
              <div key={c.id} className={`ap-char${c.approved ? " ok" : ""}`}>
                <div
                  className="ap-img"
                  style={c.image ? { backgroundImage: `url(${c.image.url})`, backgroundSize: "cover", backgroundPosition: "center" } : {}}
                />
                <input
                  className="ap-name"
                  value={c.name}
                  onChange={(e) => mut((p) => void (p.characters.find((x) => x.id === c.id)!.name = e.target.value))}
                />
                <textarea
                  className="ap-desc"
                  value={c.description}
                  placeholder="visual description — drives the character sheet"
                  onChange={(e) => mut((p) => void (p.characters.find((x) => x.id === c.id)!.description = e.target.value))}
                />
                <input
                  className="ap-name"
                  value={c.prompt}
                  placeholder="style tweak (optional) — added to the generate prompt"
                  onChange={(e) => mut((p) => void (p.characters.find((x) => x.id === c.id)!.prompt = e.target.value))}
                />
                <div className="ap-row">
                  <label className="ap-approve">
                    <input
                      type="checkbox"
                      checked={c.approved}
                      onChange={(e) => mut((p) => void (p.characters.find((x) => x.id === c.id)!.approved = e.target.checked))}
                    />
                    approved
                  </label>
                  <button
                    type="button"
                    className="beat-btn accent"
                    disabled={!c.approved || busy != null}
                    title={c.approved ? "" : "approve first"}
                    onClick={() =>
                      run("char" + c.id, async () => {
                        const art = await genImage(ps, drivingPrompt(c));
                        mut((p) => void (p.characters.find((x) => x.id === c.id)!.image = art));
                      })
                    }
                  >
                    {busy === "char" + c.id ? "…" : c.image ? "⟳" : "Generate"}
                  </button>
                  <button
                    type="button"
                    className="beat-btn"
                    onClick={() => mut((p) => void (p.characters = p.characters.filter((x) => x.id !== c.id)))}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Locations (shared library, driving images) ── */}
      <div className="ap-sec">
        <div className="ap-head">
          <b>Locations</b>
          <span className="bd-desc">define places → driving images · beats pick one for a consistent background</span>
          <div className="grow" />
          <input
            className="ap-music"
            style={{ maxWidth: 240 }}
            placeholder="describe a location or the whole world…"
            value={locPrompt}
            onChange={(e) => setLocPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (locPrompt.trim() || beats.length) && propose("location", locPrompt, () => setLocPrompt(""))}
          />
          <button
            type="button"
            className="beat-btn"
            disabled={busy != null || (!locPrompt.trim() && !beats.length)}
            onClick={() => propose("location", locPrompt, () => setLocPrompt(""))}
          >
            {busy === "propose-location" ? "proposing…" : locPrompt.trim() ? "Propose" : "Propose from beats"}
          </button>
          <button
            type="button"
            className="beat-btn gold-btn"
            disabled={busy != null || !shots.length}
            title="Propose locations from the beats, render a plate for each, and assign every beat one"
            onClick={draftLocations}
          >
            {busy?.startsWith("locations") ? busy.replace("locations — ", "") + "…" : "AI draft locations"}
          </button>
          <button
            type="button"
            className="beat-btn"
            onClick={() => mut((p) => p.locations.push({ id: newId(), name: "New location", description: "", prompt: "", image: null }))}
          >
            + Add
          </button>
        </div>
        {pipe.locations.length > 0 && (
          <div className="ap-chars">
            {pipe.locations.map((l) => (
              <div key={l.id} className={`ap-char${l.image ? " ok" : ""}`}>
                <div
                  className="ap-img"
                  style={l.image ? { backgroundImage: `url(${l.image.url})`, backgroundSize: "cover", backgroundPosition: "center" } : {}}
                />
                <input
                  className="ap-name"
                  value={l.name}
                  onChange={(e) => mut((p) => void (p.locations.find((x) => x.id === l.id)!.name = e.target.value))}
                />
                <textarea
                  className="ap-desc"
                  value={l.description}
                  placeholder="visual description — drives the background plate"
                  onChange={(e) => mut((p) => void (p.locations.find((x) => x.id === l.id)!.description = e.target.value))}
                />
                <input
                  className="ap-name"
                  value={l.prompt}
                  placeholder="style tweak (optional) — added to the generate prompt"
                  onChange={(e) => mut((p) => void (p.locations.find((x) => x.id === l.id)!.prompt = e.target.value))}
                />
                <div className="ap-row">
                  <button
                    type="button"
                    className="beat-btn accent"
                    disabled={busy != null || !l.description.trim()}
                    title={l.description.trim() ? "" : "add a description first"}
                    onClick={() =>
                      run("loc" + l.id, async () => {
                        const art = await genImage(ps, locationPrompt(l));
                        mut((p) => void (p.locations.find((x) => x.id === l.id)!.image = art));
                      })
                    }
                  >
                    {busy === "loc" + l.id ? "…" : l.image ? "⟳" : "Generate"}
                  </button>
                  <button
                    type="button"
                    className="beat-btn"
                    disabled={busy != null || !l.image}
                    title={l.image ? "Write the description from this plate" : "needs an image first"}
                    onClick={() => verbalize(l)}
                  >
                    {busy === "verbalize" + l.id ? "reading…" : "Verbalize"}
                  </button>
                  <button
                    type="button"
                    className="beat-btn"
                    onClick={() => mut((p) => void (p.locations = p.locations.filter((x) => x.id !== l.id)))}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Tracers (batch AI draft) — unlocks once beats are locked ── */}
      {phase >= 2 && (
        <div className="ap-sec">
          <div className="ap-head">
            <b>Tracers</b>
            <span className="bd-desc">
              {tracersDone}/{shots.length} beats have motion staged · {placedBeats}/{shots.length} have a location · open a beat to fine-tune
            </span>
            <div className="grow" />
            <button
              type="button"
              className="beat-btn"
              disabled={busy != null || !approved.length}
              onClick={() =>
                run("tracers", async () => {
                  for (const [i, s] of shots.entries()) {
                    if (extOf(pipe, s.id).tracers.length) continue;
                    setBusy(`tracers ${i + 1}/${shots.length}`);
                    const ts = await proposeTracers(ps.apiKey, s.prompt, approved);
                    mut((p) => {
                      const x = extOf(p, s.id);
                      x.tracers = ts;
                      p.beats[s.id] = x;
                    });
                  }
                })
              }
            >
              {busy?.startsWith("tracers") ? busy : "AI draft all tracers"}
            </button>
          </div>
        </div>
      )}

      {/* ── Sound ── */}
      {phase >= 2 && (
      <div className="ap-sec">
        <div className="ap-head">
          <b>Sound</b>
          <span className="bd-desc">
            {voicesDone}/{allSpeech.length} voices{musicModel ? "" : " · no music model live"}
          </span>
          <div className="grow" />
          <button
            type="button"
            className="beat-btn"
            disabled={busy != null || !allSpeech.length}
            onClick={() =>
              run("voices", async () => {
                for (const [i, { beatId, tracer }] of allSpeech.entries()) {
                  if (extOf(pipe, beatId).voices[tracer.id]) continue;
                  setBusy(`voices ${i + 1}/${allSpeech.length}`);
                  const art = await ttsLine(ps, tracer.text || "");
                  mut((p) => {
                    const x = extOf(p, beatId);
                    x.voices[tracer.id] = art;
                    p.beats[beatId] = x;
                  });
                }
              })
            }
          >
            {busy?.startsWith("voices") ? busy : "Generate all voices"}
          </button>
        </div>
        <div className="ap-sound">
          <input
            className="ap-music"
            placeholder="music prompt — score for the whole runtime"
            value={pipe.musicPrompt}
            onChange={(e) => mut((p) => void (p.musicPrompt = e.target.value))}
          />
          <button
            type="button"
            className="beat-btn"
            disabled={busy != null || !musicModel || !pipe.musicPrompt.trim()}
            onClick={() =>
              run("music", async () => {
                const art = await genMusic(ps, pipe.musicPrompt);
                mut((p) => void (p.music = art));
              })
            }
          >
            {busy === "music" ? "…" : pipe.music ? "Music ⟳" : "Generate music"}
          </button>
          <button
            type="button"
            className="beat-btn accent"
            disabled={busy != null || (!pipe.music && !voicesDone)}
            onClick={() =>
              run("mix", async () => {
                // voice cues land at each beat's REAL start — beats can be
                // trimmed off the 10s grid in Studio, so offsets are cumulative
                const parts: { url: string; at: number; gain?: number }[] = [];
                let at = 0;
                shots.forEach((s) => {
                  const x = extOf(pipe, s.id);
                  for (const t of x.tracers)
                    if (t.kind === "speech" && x.voices[t.id])
                      parts.push({ url: x.voices[t.id].url, at: at + (t.path[0]?.t ?? 0) });
                  at += s.sourceDuration ?? BEAT_SECONDS;
                });
                if (pipe.music) parts.push({ url: pipe.music.url, at: 0, gain: 0.35 });
                if (!parts.length) throw new Error("nothing to mix — generate voices or music first");
                const art = await mixAudio(ps, parts, at);
                mut((p) => {
                  p.mix = art;
                  p.mixStale = false;
                });
                ps.toast("Soundtrack mixed", "gold");
              })
            }
          >
            {busy === "mix" ? "mixing…" : pipe.mix ? "Remix soundtrack ⟳" : "Mix soundtrack"}
          </button>
          {pipe.mix && pipe.mixStale && (
            <span className="bd-badge" title="beats were edited, trimmed or deleted after this mix — remix to fix voice timing">
              ⚠ stale
            </span>
          )}
          {pipe.music && <audio controls src={pipe.music.url} />}
          {pipe.mix && <audio controls src={pipe.mix.url} />}
        </div>
      </div>
      )}

      {/* ── Phase 3: finals ── */}
      {phase >= 2 && (
      <div className="ap-sec">
        <div className="ap-head">
          <b>Phase 3 — Final renders</b>
          <span className="bd-desc">
            {finalsDone}/{shots.length} clips{videoModel ? "" : " · no video model available right now"}
            {videoModel && renderable > 0 ? ` · ${renderable} ready to render` : ""}
            {videoModel && shots.length - finalsDone - renderable > 0
              ? ` · ${shots.length - finalsDone - renderable} need a location or a still first`
              : ""}
          </span>
          <div className="grow" />
          <button
            type="button"
            className="beat-btn gold-btn"
            disabled={busy != null || !videoModel}
            onClick={() =>
              run("finals", async () => {
                let skipped = 0;
                for (const [i, s] of shots.entries()) {
                  const x = extOf(pipe, s.id);
                  // A beat with no location still has its own approved still —
                  // that is a better scene reference than refusing to render.
                  const scene = sceneArtOf(pipe, x) || (s.result ? { url: s.result.url, content_type: s.result.content_type } : null);
                  if (x.finalClip) continue;
                  if (!scene) {
                    skipped++;
                    continue;
                  }
                  setBusy(`finals ${i + 1}/${shots.length}`);
                  let overlay = x.tracerImage;
                  if (!overlay && x.tracers.length) overlay = await bakeTracerPng(ps, x.tracers, pipe.characters);
                  const prompt = x.finalPrompt.trim() || buildFinalPrompt(s.prompt, x, pipe.characters);
                  const refs = [
                    ...approved.filter((c) => x.characterIds.includes(c.id)).map((c) => c.image?.url || ""),
                    scene.url,
                    overlay?.url || "",
                  ].filter(Boolean);
                  const art = await genImage(ps, prompt, { refs, video: true });
                  mut((p) => {
                    p.phase = 3; // a final actually landed → phase 3
                    const y = extOf(p, s.id);
                    y.tracerImage = overlay;
                    y.finalPrompt = prompt;
                    y.finalClip = art;
                    p.beats[s.id] = y;
                  });
                }
                if (skipped) ps.toast(`${skipped} beat${skipped === 1 ? "" : "s"} skipped — they have neither a location nor a still`);
              })
            }
          >
            {busy?.startsWith("finals") ? busy : "Render all final clips"}
          </button>
        </div>
        {finalsDone > 0 && (
          <div className="ap-finals">
            {shots.map((s, i) => {
              const x = extOf(pipe, s.id);
              const f = x.finalClip;
              if (!f)
                return (
                  <div key={s.id} className="ap-final empty">
                    {String(i + 1).padStart(2, "0")}
                  </div>
                );
              return (
                <div key={s.id} style={{ position: "relative" }}>
                  {kindOf(f.content_type, f.url) === "video" ? (
                    <video className="ap-final" controls src={f.url} />
                  ) : (
                    <div className="ap-final" style={{ backgroundImage: `url(${f.url})`, backgroundSize: "cover" }} />
                  )}
                  {x.staleFinal && (
                    <span
                      className="bd-badge"
                      style={{ position: "absolute", top: 6, right: 6, background: "var(--bg-elevated)" }}
                      title="beat edited after this final rendered — re-render"
                    >
                      ⚠ stale
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
