import { useEffect, useRef, useState } from "react";
import { type Shot } from "./api";
import { kindOf, type PS } from "./shared";
import {
  BEAT_SECONDS,
  buildFinalPrompt,
  extOf,
  genImage,
  genMusic,
  markBeatEdited,
  mixAudio,
  newId,
  pickModel,
  proposeRoster,
  proposeTracers,
  speakAs,
  worldLayoutOf,
  type Pipeline,
} from "./pipeline";
import { beatReadiness, boardReadiness } from "./readiness";
import { registerActions } from "./control";
import { openJobForm } from "./jobHandoff";
import { sendPropToStage } from "./stageHandoff";

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
  const beats = shots.map((s) => ({ id: s.id, prompt: s.prompt }));
  const approved = pipe.characters.filter((c) => c.approved);
  const locations = pipe.locations || [];
  const world = worldLayoutOf(pipe);
  const videoModel = pickModel(ps.models, "video");
  const musicModel = pickModel(ps.models, "music");
  const mediaModels = (ps.media?.objects || []).filter((item) => kindOf(item.content_type, item.url) === "model");
  const mediaImages = (ps.media?.objects || []).filter((item) => kindOf(item.content_type, item.url) === "image");
  const tracersDone = shots.filter((s) => extOf(pipe, s.id).tracers.length).length;
  const finalsDone = shots.filter((s) => extOf(pipe, s.id).finalClip).length;
  // What "Render all" would actually produce: only beats that pass every
  // readiness gate, including approved geography and a beat-derived plate.
  const renderable = shots.filter((s) => !extOf(pipe, s.id).finalClip && beatReadiness(s, pipe).band === "ready").length;
  // A greyed-out button with no reason is indistinguishable from a broken one.
  // Name the blocker holding back the most beats, in the order it must be fixed.
  const topBlocker = (() => {
    if (renderable || !shots.length) return null;
    const counts = new Map<string, number>();
    for (const s of shots) for (const c of beatReadiness(s, pipe).components) if (c.value < 1) counts.set(c.hint, (counts.get(c.hint) || 0) + 1);
    const worst = [...counts].sort((a, b) => b[1] - a[1])[0];
    return worst ? `${worst[0]} — ${worst[1]} beat${worst[1] === 1 ? "" : "s"}` : null;
  })();
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

  /* The three bulk passes. Named so the buttons and the MCP actions below run
     the SAME function — the studio's standing invariant is that an agent action
     is never a second implementation of what the click does. */
  const draftAllTracers = () =>
    run("tracers", async () => {
      for (const [i, s] of shots.entries()) {
        // "already blocked" means it has MOTION. A beat carrying only an
        // authored speech line still needs its blocking drafted.
        if (extOf(pipe, s.id).tracers.some((t) => t.kind === "move")) continue;
        setBusy(`tracers ${i + 1}/${shots.length}`);
        const location = locations.find((item) => item.id === extOf(pipe, s.id).locationId);
        const ts = await proposeTracers(
          ps.apiKey,
          [s.prompt, location && `Location: ${location.name}. ${location.description}`].filter(Boolean).join("\n"),
          approved,
        );
        mut((p) => {
          const x = extOf(p, s.id);
          // keep the authored script — the proposer re-invents speech from the
          // beat prose and would overwrite written lines
          const written = x.tracers.filter((t) => t.kind === "speech");
          x.tracers = [...written, ...ts.filter((t) => t.kind === "move" || !written.length)];
          p.beats[s.id] = x;
        });
      }
    });

  const generateAllVoices = () =>
    run("voices", async () => {
      for (const [i, { beatId, tracer }] of allSpeech.entries()) {
        if (extOf(pipe, beatId).voices[tracer.id]) continue;
        setBusy(`voices ${i + 1}/${allSpeech.length}`);
        const art = await speakAs(ps, pipe, tracer.characterId, tracer.text || "", mut);
        mut((p) => {
          const x = extOf(p, beatId);
          x.voices[tracer.id] = art;
          p.beats[beatId] = x;
        });
      }
    });

  const renderAllFinals = () =>
    run("finals", async () => {
      for (const [i, s] of shots.entries()) {
        const x = extOf(pipe, s.id);
        if (x.finalClip || beatReadiness(s, pipe).band !== "ready") continue;
        setBusy(`finals ${i + 1}/${shots.length}`);
        const prompt = x.finalPrompt.trim() || buildFinalPrompt(s.prompt, x, pipe);
        // text + the one frame being animated, nothing else
        const refs = s.result ? [s.result.url] : [];
        const art = await genImage(ps, prompt, { refs, video: true });
        mut((p) => {
          const y = extOf(p, s.id);
          y.finalPrompt = prompt;
          y.finalClip = art;
          p.beats[s.id] = y;
        });
      }
    });

  // The bulk passes, driveable from MCP. Registered through a ref so the actions
  // always see current state — a `[]` effect would freeze the first render's
  // closure and every call would write against a stale pipeline.
  const bulkRef = useRef({ draftAllTracers, generateAllVoices, renderAllFinals, pipe, shots });
  bulkRef.current = { draftAllTracers, generateAllVoices, renderAllFinals, pipe, shots };
  useEffect(() => {
    registerActions([
      {
        name: "board.draft_tracers",
        description:
          "AI-draft motion tracers for every beat that has no blocking yet. Authored speech lines are " +
          "preserved. This is the motion direction whose absence produced the frozen-tableau renders.",
        confirmation: "Runs a chat completion per unblocked beat",
        run: async () => {
          await bulkRef.current.draftAllTracers();
          const { pipe: p, shots: sh } = bulkRef.current;
          return { ok: true, blocked: sh.filter((s) => extOf(p, s.id).tracers.some((t) => t.kind === "move")).length, of: sh.length };
        },
      },
      {
        name: "board.generate_voices",
        description: "Generate the missing TTS for every speech line on the board. Lines already voiced are skipped.",
        confirmation: "Starts paid text-to-speech jobs",
        run: async () => {
          await bulkRef.current.generateAllVoices();
          return { ok: true };
        },
      },
      {
        name: "board.render_finals",
        description:
          "Render the final video clip for every beat passing the readiness gate. Beats that do not pass " +
          "are skipped — call board.get_state to see what blocks them.",
        confirmation: "Starts paid video generation jobs",
        run: async () => {
          const { pipe: p, shots: sh } = bulkRef.current;
          const ready = sh.filter((s) => !extOf(p, s.id).finalClip && beatReadiness(s, p).band === "ready");
          if (!ready.length)
            return { ok: false, rendered: 0, reason: "no beat passes the readiness gate", readiness: boardReadiness(sh, p) };
          await bulkRef.current.renderAllFinals();
          return { ok: true, attempted: ready.length };
        },
      },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drivingPrompt = (c: { name: string; description: string; prompt: string }) =>
    `Character sheet of ${c.name}: ${c.description}. ${c.prompt} Full body, single character, neutral studio background, high detail, consistent design.`;
  const locationPrompt = (location: (typeof locations)[number]) =>
    [
      `Eye-level environment plate for the canonical ${location.name}: ${location.description}`,
      location.prompt,
      location.allowedElements?.length && `Use only established elements: ${location.allowedElements.join(", ")}`,
      `This location belongs to ${world.name}: ${world.description}`,
      `Continuity rules: ${world.rules.join("; ")}`,
      [...world.forbiddenElements, ...(location.forbiddenElements || [])].length &&
        `Never introduce: ${[...new Set([...world.forbiddenElements, ...(location.forbiddenElements || [])])].join(", ")}`,
      "Derive composition, palette, terrain, and production design from the supplied correct beat still",
      "Empty location, no characters, no text, no new landmarks, cinematic wide establishing frame",
    ].filter(Boolean).join(". ");
  const listOf = (value: string) => value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  const sourceFor = (location: (typeof locations)[number]) => shots.find((shot) => shot.id === location.sourceBeatId && shot.result?.url);
  const mapSources = locations.map(sourceFor).filter((shot): shot is Shot => !!shot?.result?.url).slice(0, 4);
  const worldPrompt = () => {
    const topology = locations.map((location) => {
      const next = (location.adjacentTo || []).map((id) => locations.find((item) => item.id === id)?.name || id);
      return `${location.name} (${location.kind || "zone"})${next.length ? ` connects only to ${next.join(", ")}` : ""}`;
    }).join("; ");
    return [
      `Bird's-eye production continuity map for ${world.name}: ${world.description}`,
      `Exact topology: ${topology}`,
      `Continuity rules: ${world.rules.join("; ")}`,
      "Show one coherent connected landscape with readable routes and stable landmarks, no characters, no labels, no text",
      world.forbiddenElements.length && `Never include: ${world.forbiddenElements.join(", ")}`,
      "Do not invent any location, structure, landmark, prop, or route not named above",
    ].filter(Boolean).join(". ");
  };
  const mutateWorld = (patch: Partial<typeof world>) =>
    mut((p) => {
      p.world = { ...worldLayoutOf(p), ...patch };
      for (const beatId of Object.keys(p.beats)) markBeatEdited(p, beatId);
    });

  // propose a cast from a free prompt (preferred) or the beats
  const propose = (src: string, reset: () => void) =>
    run("propose-character", async () => {
      const found = await proposeRoster(ps.apiKey, src.trim() || beats);
      let added = 0;
      mut((p) => {
        added = 0; // updater may re-run (StrictMode) — recount
        for (const f of found) {
          if (p.characters.some((x) => x.name.toLowerCase() === f.name.toLowerCase())) continue;
          added++;
          p.characters.push({ id: newId(), name: f.name, description: f.description, approved: false, prompt: "", image: null });
        }
      });
      reset();
      ps.toast(added ? `${added} characters proposed` : "0 new (all duplicates)", "gold");
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
            onKeyDown={(e) => e.key === "Enter" && (charPrompt.trim() || beats.length) && propose(charPrompt, () => setCharPrompt(""))}
          />
          <button
            type="button"
            className="beat-btn"
            disabled={busy != null || (!charPrompt.trim() && !beats.length)}
            onClick={() => propose(charPrompt, () => setCharPrompt(""))}
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
                  value={c.voice ?? ""}
                  placeholder="voice (optional) — e.g. older man, gravelly, unhurried"
                  onChange={(e) =>
                    mut((p) => {
                      // Rewriting the design means a different voice, so the
                      // minted id no longer describes it — drop it and let the
                      // next line mint again.
                      const x = p.characters.find((y) => y.id === c.id)!;
                      x.voice = e.target.value;
                      delete x.voiceId;
                      delete x.voiceClip;
                    })
                  }
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

      {/* ── World geography ── */}
      <div className="ap-sec world-sec">
        <div className="ap-head">
          <b>World geography</b>
          <span className="bd-desc">one approved bird's-eye map → fixed topology → no invented places</span>
          <div className="grow" />
          <label className="ap-approve">
            <input type="checkbox" checked={world.approved} onChange={(event) => mutateWorld({ approved: event.target.checked })} />
            approved
          </label>
          <button
            type="button"
            className="beat-btn accent"
            disabled={!world.name.trim() || !locations.length || !mapSources.length || busy != null}
            title={mapSources.length ? "Generate from the locations' explicitly chosen source beats" : "Choose a correct source beat on at least one location first"}
            onClick={() =>
              run("world-map", async () => {
                const art = await genImage(ps, worldPrompt(), { refs: mapSources.map((shot) => shot.result!.url) });
                mutateWorld({ map: art, approved: false });
              })
            }
          >
            {busy === "world-map" ? "…" : world.map ? "Regenerate map" : "Generate bird's-eye"}
          </button>
        </div>
        <div className="world-grid">
          <div
            className="world-map"
            style={world.map ? { backgroundImage: `url(${world.map.url})` } : undefined}
          >
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="World location topology">
              {locations.flatMap((location) =>
                (location.adjacentTo || [])
                  .filter((id) => location.id < id)
                  .map((id) => {
                    const target = locations.find((item) => item.id === id);
                    return target ? (
                      <line
                        key={`${location.id}-${id}`}
                        x1={location.mapX ?? 50}
                        y1={location.mapY ?? 50}
                        x2={target.mapX ?? 50}
                        y2={target.mapY ?? 50}
                      />
                    ) : null;
                  }),
              )}
              {locations.map((location) => (
                <g key={location.id} transform={`translate(${location.mapX ?? 50} ${location.mapY ?? 50})`}>
                  <circle r="2.4" className={location.kind === "transition" ? "transition" : "zone"} />
                  <text y="-4">{location.name}</text>
                </g>
              ))}
            </svg>
            {!world.map && <span>Attach or generate a master bird's-eye map after the topology is set.</span>}
          </div>
          <div className="world-fields">
            <input className="ap-name" value={world.name} placeholder="World / route name" onChange={(event) => mutateWorld({ name: event.target.value })} />
            <textarea className="ap-desc" value={world.description} placeholder="The complete geography in one sentence" onChange={(event) => mutateWorld({ description: event.target.value })} />
            <textarea className="ap-desc" value={world.rules.join("\n")} placeholder="Continuity rules — one per line" onChange={(event) => mutateWorld({ rules: listOf(event.target.value) })} />
            <textarea className="ap-desc danger-field" value={world.forbiddenElements.join("\n")} placeholder="Forbidden inventions — fortress, bells, desert…" onChange={(event) => mutateWorld({ forbiddenElements: listOf(event.target.value) })} />
          </div>
        </div>
      </div>

      {/* ── Locations ── */}
      <div className="ap-sec">
        <div className="ap-head">
          <b>Locations</b>
          <span className="bd-desc">environment plates → assign per beat → stage tracers on the location</span>
          <div className="grow" />
          <button
            type="button"
            className="beat-btn"
            onClick={() =>
              mut((p) => {
                const list = (p.locations ??= []);
                list.push({
                  id: newId(),
                  name: "New location",
                  description: "",
                  approved: false,
                  prompt: "",
                  image: null,
                  kind: "zone",
                  mapX: 50,
                  mapY: 50,
                  adjacentTo: [],
                  allowedElements: [],
                  forbiddenElements: [],
                });
              })
            }
          >
            + Add
          </button>
        </div>
        {locations.length > 0 && (
          <div className="ap-chars ap-locations">
            {locations.map((location) => {
              const assigned = shots.filter((shot) => extOf(pipe, shot.id).locationId === location.id).length;
              const sourceShot = sourceFor(location);
              return (
                <div key={location.id} className={`ap-char${location.approved ? " ok" : ""}`}>
                  <div
                    className="ap-img"
                    style={location.image ? { backgroundImage: `url(${location.image.url})`, backgroundSize: "cover", backgroundPosition: "center" } : {}}
                  />
                  <input
                    className="ap-name"
                    value={location.name}
                    onChange={(event) => mut((p) => void ((p.locations || []).find((item) => item.id === location.id)!.name = event.target.value))}
                  />
                  <div className="ap-row location-kind-row">
                    <select
                      className="ap-name"
                      value={location.kind || "zone"}
                      onChange={(event) => mut((p) => void ((p.locations || []).find((item) => item.id === location.id)!.kind = event.target.value === "transition" ? "transition" : "zone"))}
                    >
                      <option value="zone">Zone</option>
                      <option value="transition">Transition / route</option>
                    </select>
                    <label>X <input type="number" min="0" max="100" value={location.mapX ?? 50} onChange={(event) => mut((p) => void ((p.locations || []).find((item) => item.id === location.id)!.mapX = Number(event.target.value)))} /></label>
                    <label>Y <input type="number" min="0" max="100" value={location.mapY ?? 50} onChange={(event) => mut((p) => void ((p.locations || []).find((item) => item.id === location.id)!.mapY = Number(event.target.value)))} /></label>
                  </div>
                  <select
                    className="ap-name"
                    value={location.sourceBeatId || ""}
                    onChange={(event) => mut((p) => void ((p.locations || []).find((item) => item.id === location.id)!.sourceBeatId = event.target.value || undefined))}
                  >
                    <option value="">Choose the correct source beat…</option>
                    {shots.filter((shot) => shot.result?.url).map((shot, index) => (
                      <option key={shot.id} value={shot.id}>Beat {String(index + 1).padStart(2, "0")} · {shot.prompt.slice(0, 58)}</option>
                    ))}
                  </select>
                  <input
                    className="ap-name"
                    value={(location.adjacentTo || []).join(", ")}
                    placeholder="Adjacent location ids, comma separated"
                    onChange={(event) => mut((p) => void ((p.locations || []).find((item) => item.id === location.id)!.adjacentTo = listOf(event.target.value)))}
                  />
                  <textarea
                    className="ap-desc"
                    value={(location.allowedElements || []).join("\n")}
                    placeholder="Allowed landmarks and structures — one per line"
                    onChange={(event) => mut((p) => void ((p.locations || []).find((item) => item.id === location.id)!.allowedElements = listOf(event.target.value)))}
                  />
                  <textarea
                    className="ap-desc danger-field"
                    value={(location.forbiddenElements || []).join("\n")}
                    placeholder="Forbidden inventions at this location"
                    onChange={(event) => mut((p) => void ((p.locations || []).find((item) => item.id === location.id)!.forbiddenElements = listOf(event.target.value)))}
                  />
                  <textarea
                    className="ap-desc"
                    value={location.description}
                    placeholder="visual geography, architecture, light, and weather"
                    onChange={(event) => mut((p) => void ((p.locations || []).find((item) => item.id === location.id)!.description = event.target.value))}
                  />
                  <input
                    className="ap-name"
                    value={location.prompt}
                    placeholder="production-design instruction (optional)"
                    onChange={(event) => mut((p) => void ((p.locations || []).find((item) => item.id === location.id)!.prompt = event.target.value))}
                  />
                  <div className="ap-row">
                    <label className="ap-approve">
                      <input
                        type="checkbox"
                        checked={location.approved}
                        onChange={(event) => mut((p) => void ((p.locations || []).find((item) => item.id === location.id)!.approved = event.target.checked))}
                      />
                      approved · {assigned} beat{assigned === 1 ? "" : "s"}
                    </label>
                    <button
                      type="button"
                      className="beat-btn accent"
                      disabled={!location.approved || !sourceShot || busy != null}
                      title={!location.approved ? "approve first" : sourceShot ? "Derive an empty plate image-to-image from the explicitly chosen correct beat still" : "choose the correct rendered source beat first"}
                      onClick={() =>
                        run("location" + location.id, async () => {
                          const art = await genImage(ps, locationPrompt(location), { refs: [sourceShot!.result!.url] });
                          mut((p) => {
                            (p.locations || []).find((item) => item.id === location.id)!.image = art;
                            for (const beatId of Object.keys(p.beats)) {
                              if (p.beats[beatId].locationId === location.id) markBeatEdited(p, beatId);
                            }
                          });
                        })
                      }
                    >
                      {busy === "location" + location.id ? "…" : location.image ? "⟳" : "Generate"}
                    </button>
                    <button
                      type="button"
                      className="beat-btn"
                      onClick={() =>
                        mut((p) => {
                          p.locations = (p.locations || []).filter((item) => item.id !== location.id);
                          for (const [beatId, beat] of Object.entries(p.beats)) {
                            if (beat.locationId !== location.id) continue;
                            delete beat.locationId;
                            markBeatEdited(p, beatId);
                          }
                        })
                      }
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Tracers (batch AI draft) — unlocks once beats are locked ── */}
        <div className="ap-sec">
          <div className="ap-head">
            <b>Tracers</b>
            <span className="bd-desc">
              {tracersDone}/{shots.length} beats have motion staged · open a beat to fine-tune
            </span>
            <div className="grow" />
            <button
              type="button"
              className="beat-btn"
              disabled={busy != null || !approved.length}
              onClick={draftAllTracers}
            >
              {busy?.startsWith("tracers") ? busy : "AI draft all tracers"}
            </button>
          </div>
        </div>

      {/* ── Sound ── */}
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
            onClick={generateAllVoices}
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

      {/* ── 3D props ── */}
      <div className="ap-sec">
        <div className="ap-head">
          <b>3D props</b>
          <span className="bd-desc">{mediaModels.length} Media model{mediaModels.length === 1 ? "" : "s"} · TRELLIS results stay props, not VRM actors</span>
          <div className="grow" />
          <button type="button" className="beat-btn" disabled={!mediaImages.length} onClick={() => {
            openJobForm({ capability: "3d", mediaKey: mediaImages[0]?.key });
            ps.setMode("models");
          }}>Create 3D from Media</button>
        </div>
        {mediaModels.length > 0 && <div className="ap-sound">{mediaModels.map((item) => <span key={item.key} className="bd-badge">{item.name} <button type="button" className="mini-btn" onClick={() => {
          if (!/^https?:\/\//i.test(item.url)) return ps.toast("Stage needs a persisted Media URL");
          sendPropToStage({ name: item.name, url: item.url });
          ps.setMode("animate");
        }}>Add to Stage</button></span>)}</div>}
      </div>

      {/* ── Final renders ── */}
      <div className="ap-sec">
        <div className="ap-head">
          <b>Final renders</b>
          <span className="bd-desc">
            {finalsDone}/{shots.length} clips{videoModel ? "" : " · no video model available right now"}
            {videoModel && renderable > 0 ? ` · ${renderable} ready to render` : ""}
            {videoModel && topBlocker ? <span className="ap-blocker"> · blocked: {topBlocker}</span> : ""}
          </span>
          <div className="grow" />
          <button
            type="button"
            className="beat-btn gold-btn"
            disabled={busy != null || !videoModel || renderable === 0}
            title={topBlocker ? `No beat passes the render gate yet. Biggest blocker: ${topBlocker}` : undefined}
            onClick={renderAllFinals}
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
    </div>
  );
}
