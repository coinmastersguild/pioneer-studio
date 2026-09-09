import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { addShot, deleteShot, fetchStoryboard, moveShot, patchShot, type Shot } from "./api";
import { renderShot, trackShotJob } from "./shots";
import { aiPress, aiRelease } from "./ghost";
import { fmtTime, kindOf, PH, type PS } from "./shared";
import BeatDialog from "./BeatDialog";
import AssetsPanel from "./AssetsPanel";
import {
  assignBeatCast,
  BEAT_SECONDS,
  assignBeatGeography,
  assignBeatLocation,
  beatRefs,
  buildPreviewCut,
  extOf,
  loadPipeline,
  markBeatEdited,
  newId,
  savePipeline,
  setWorldLayout,
  upsertCharacter,
  upsertLocation,
  worldLayoutOf,
  type Pipeline,
  type PreviewItem,
  type BeatMovement,
  type ScreenDirection,
} from "./pipeline";
import { boardReadiness } from "./readiness";
import { promptPackMarkdown, shotBible, downloadText } from "./promptPack";
import { registerActions } from "./control";

// Server pipeline is single-stage (generate → still/clip); the design's
// draft→lowres→hires ladder maps onto it honestly:
//   empty → Draft · queued/starting/running → Rendering · ready(image) → Still
//   ready(video) → Clip · failed → Failed
function stageOf(s: Shot): { cls: string; label: string } {
  if (s.status === "ready" && s.result) {
    return kindOf(s.result.content_type, s.result.url) === "video"
      ? { cls: "clip", label: "Clip" }
      : { cls: "hires", label: "Still" };
  }
  if (s.status === "queued" || s.status === "starting" || s.status === "running")
    return { cls: "lowres", label: "Rendering" };
  if (s.status === "failed") return { cls: "draft", label: "Failed" };
  return { cls: "draft", label: "Draft" };
}

const durOf = (s: Shot) => s.sourceDuration ?? 10;
const SEG_COLORS = ["var(--pioneer-400)", "var(--accent-2)", "var(--compass-400)", "var(--pioneer-500)", "#38bdf8", "#a3e635"];

export default function BoardView({ ps }: { ps: PS }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [dialog, setDialog] = useState<string | null>(null);
  // drag-to-reorder: `at` is the insert slot the pointer is currently over
  const [drag, setDrag] = useState<{ id: string; from: number; at: number } | null>(null);
  const [release, setRelease] = useState<{ url?: string; items?: PreviewItem[]; audio?: string | null } | null>(null);
  // Pipeline state: phase, characters, scenes, tracers, sound, and finals.
  const [pipe, setPipe] = useState<Pipeline>(() => loadPipeline(ps.board?.id || "default"));
  const pipeRef = useRef(pipe);
  pipeRef.current = pipe;
  // reload whenever this view becomes active too — Studio writes to the same
  // store (trim → mixStale) without bumping board rev
  useEffect(() => {
    if (ps.mode === "board" || ps.board?.id) setPipe(loadPipeline(ps.board?.id || "default"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ps.mode, ps.board?.id]);
  const psRef = useRef(ps);
  psRef.current = ps;
  const applyPipelineMutation = (fn: (p: Pipeline) => void): Pipeline => {
    // clone the STORED doc, not this view's state — a stale clone here would
    // silently clobber pipeline writes made from other views (lost update)
    const id = psRef.current.board?.id || "default";
    const next = loadPipeline(id);
    fn(next);
    savePipeline(id, next);
    pipeRef.current = next;
    setPipe(next);
    return next;
  };
  const mut = (fn: (p: Pipeline) => void) => void applyPipelineMutation(fn);

  const shots = ps.board?.shots || [];

  /* resume polling for shots left queued/running (e.g. after a reload) */
  useEffect(() => {
    for (const s of shots) {
      if (s.jobId && (s.status === "queued" || s.status === "starting" || s.status === "running")) {
        void trackShotJob(psRef.current, s.id, s.jobId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ps.board?.rev]);

  async function onAddBeat() {
    const p = psRef.current;
    if (!p.apiKey) return p.toast("Paste your sk-pioneer key first");
    try {
      const sb = await addShot(p.apiKey, p.board?.rev, { prompt: "" });
      p.setBoard(sb);
      const created = sb.shots[sb.shots.length - 1];
      setSelected(created.id);
      setDialog(created.id); // A new beat opens directly in its prompt editor.
    } catch (e: any) {
      p.toast(`Add beat failed: ${String(e.message || e)}`);
    }
  }

  async function saveEdit(shotId: string) {
    const p = psRef.current;
    setEditing(null);
    const sb = await patchShot(p.apiKey, undefined, shotId, { prompt: editText });
    p.setBoard(sb);
    mut((pl) => markBeatEdited(pl, shotId)); // Downstream artifacts become stale.
    // Writing text down never spends credits — the beat card's own render
    // button is how a picture gets made.
  }

  async function onDelete(shotId: string) {
    const p = psRef.current;
    const sb = await deleteShot(p.apiKey, p.board?.rev, shotId);
    p.setBoard(sb);
    // drop the beat's pipeline state and flag the mix — voice offsets shift by 10s
    mut((pl) => {
      delete pl.beats[shotId];
      if (pl.mix) pl.mixStale = true;
    });
  }

  async function onDrop() {
    const d = drag;
    setDrag(null);
    if (!d || d.at === d.from || d.at === d.from + 1) return; // no-op slots
    const p = psRef.current;
    const sb = await moveShot(p.apiKey, p.board?.rev, d.id, d.at);
    p.setBoard(sb);
    mut((pl) => {
      if (pl.mix) pl.mixStale = true; // voice offsets follow beat order
    });
  }

  const dragProps = (i: number) => ({
    onDragOver: (e: DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      const at = e.clientX < r.left + r.width / 2 ? i : i + 1;
      if (at !== drag.at) setDrag({ ...drag, at });
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      void onDrop();
    },
  });

  /* ── copilot: render every draft beat, visibly ── */
  async function renderAll() {
    const p = psRef.current;
    if (p.isBusy()) return;
    if (!p.apiKey) return p.toast("Paste your sk-pioneer key first");
    const board = await fetchStoryboard(p.apiKey);
    const drafts = (board?.shots || []).filter((s) => s.status === "empty" || s.status === "failed");
    if (!drafts.length) {
      p.toast("Every beat already has a render — re-render one from its card");
      return;
    }
    p.setBusy(true);
    p.toast(`Rendering ${drafts.length} draft beat${drafts.length > 1 ? "s" : ""}…`);
    const scroller = document.querySelector<HTMLElement>("#view-board .board-scroll");
    try {
      for (const s of drafts) {
        const card = document.querySelector<HTMLElement>(`#view-board .beat[data-id="${s.id}"]`);
        if (card) await aiPress(card, { scroller });
        if (!s.prompt) {
          const sb = await patchShot(p.apiKey, undefined, s.id, {
            prompt: "Cinematic forest keyframe, dawn fog, volumetric light through pines, 35mm",
          });
          p.setBoard(sb);
        }
        await renderShot(p, { ...s, prompt: s.prompt || "x" }, { refs: beatRefs(pipeRef.current, extOf(pipeRef.current, s.id)) });
      }
      p.toast("All renders running — beats flip to Still as each job lands", "ok");
    } catch (e: any) {
      p.toast(String(e.message || e));
    } finally {
      // a failed batch must never leave the global busy latch stuck
      aiRelease();
      p.setBusy(false);
    }
  }

  // The board owns the seed cut; Studio owns the authored cut and export.
  // Previewing here is intentionally non-destructive and never creates a
  // second release that ignores timeline edits.
  function previewBoard() {
    const p = psRef.current;
    const cut = buildPreviewCut(p.board?.shots || [], pipeRef.current);
    if (!cut.items.length) return p.toast("Add and render at least one beat first");
    setRelease({ items: cut.items, audio: cut.audio });
    if (cut.skipped)
      p.toast(`${cut.skipped} beat${cut.skipped > 1 ? "s" : ""} not yet rendered — held as black frames; render them for the full cut`);
  }

  // Save & next beat → chained from the dialog until "done"
  async function nextBeat() {
    const p = psRef.current;
    try {
      const sb = await addShot(p.apiKey, p.board?.rev, { prompt: "" });
      p.setBoard(sb);
      const created = sb.shots[sb.shots.length - 1];
      setSelected(created.id);
      setDialog(created.id);
    } catch (e: any) {
      p.toast(`Add beat failed: ${String(e.message || e)}`);
    }
  }

  // Prompt-pack export: the whole board as portable markdown + JSON.
  function exportPack() {
    const p = psRef.current;
    if (!p.board?.shots.length) return p.toast("Add at least one beat first");
    const stem = (p.board.title || "storyboard").toLowerCase().replace(/\W+/g, "-");
    downloadText(`${stem}-prompt-pack.md`, promptPackMarkdown(p.board, pipeRef.current), "text/markdown");
    downloadText(`${stem}-shot-bible.json`, JSON.stringify(shotBible(p.board, pipeRef.current), null, 2), "application/json");
    p.toast("Prompt pack + shot bible downloaded", "ok");
  }

  const fnsRef = useRef({ renderAll, previewBoard, onAddBeat, exportPack });
  fnsRef.current = { renderAll, previewBoard, onAddBeat, exportPack };

  useEffect(() => {
    ps.registerSuggestions("board", [
      { label: "Add the next beat", run: () => fnsRef.current.onAddBeat() },
      { label: "Render every draft beat", run: () => fnsRef.current.renderAll() },
      { label: "Preview the storyboard cut", run: () => fnsRef.current.previewBoard() },
      { label: "Export the prompt pack", run: () => fnsRef.current.exportPack() },
    ]);
    // the same handlers the buttons call, exposed for the copilot + agents (window.__studio)
    registerActions([
      {
        name: "board.get_state",
        description: "Storyboard snapshot: beats (id, text, status), readiness per beat",
        run: () => {
          const p = psRef.current;
          const pl = pipeRef.current;
          const list = p.board?.shots || [];
          return {
            readiness: boardReadiness(list, pl),
            world: worldLayoutOf(pl),
            cast: pl.characters.map((c) => ({ id: c.id, name: c.name, approved: c.approved, hasImage: !!c.image, imageUrl: c.image?.url || null })),
            locations: (pl.locations || []).map((location) => ({
              id: location.id,
              name: location.name,
              kind: location.kind || "zone",
              approved: location.approved,
              sourceBeatId: location.sourceBeatId || null,
              mapX: location.mapX ?? 50,
              mapY: location.mapY ?? 50,
              adjacentTo: location.adjacentTo || [],
              allowedElements: location.allowedElements || [],
              forbiddenElements: location.forbiddenElements || [],
              hasImage: !!location.image,
              imageUrl: location.image?.url || null,
            })),
            beats: list.map((s, i) => ({
              index: i + 1,
              id: s.id,
              text: s.prompt,
              status: s.status,
              characterIds: extOf(pl, s.id).characterIds,
              castIntentionalEmpty: !!extOf(pl, s.id).castIntentionalEmpty,
              locationId: extOf(pl, s.id).locationId || null,
              location: (pl.locations || []).find((location) => location.id === extOf(pl, s.id).locationId)?.name || null,
              geography: extOf(pl, s.id).geography || null,
              audioCues: extOf(pl, s.id).audioCues || [],
              cast: extOf(pl, s.id).characterIds.map((id) => pl.characters.find((c) => c.id === id)?.name || id),
              hasFinal: !!extOf(pl, s.id).finalClip,
            })),
          };
        },
      },
      {
        name: "board.set_world_layout",
        description: "Set the canonical world map, continuity rules, and forbidden inventions; saves without rendering",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            approved: { type: "boolean" },
            map_url: { type: "string", description: "Public bird's-eye master-map URL" },
            map_content_type: { type: "string" },
            rules: { type: "array", items: { type: "string" } },
            forbidden_elements: { type: "array", items: { type: "string" } },
          },
          required: ["name", "description", "rules", "forbidden_elements"],
          additionalProperties: false,
        },
        run: (params) => {
          let saved = null;
          applyPipelineMutation((pl) => {
            saved = setWorldLayout(pl, {
              name: String(params?.name || ""),
              description: String(params?.description || ""),
              approved: params?.approved === true,
              map: params?.map_url ? { url: String(params.map_url), content_type: String(params?.map_content_type || "image/png") } : null,
              rules: Array.isArray(params?.rules) ? params.rules.map(String) : [],
              forbiddenElements: Array.isArray(params?.forbidden_elements) ? params.forbidden_elements.map(String) : [],
            });
          });
          return { ok: true, world: saved };
        },
      },
      {
        name: "board.upsert_location",
        description: "Create or replace one location-registry plate by stable id; saves without rendering",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable location id; retries with the same id replace instead of duplicate" },
            name: { type: "string" },
            description: { type: "string" },
            approved: { type: "boolean" },
            prompt: { type: "string", description: "Optional production-design instruction for reference-driven renders" },
            image_url: { type: "string", description: "Public beat-derived location plate URL" },
            image_content_type: { type: "string" },
            source_beat_id: { type: "string", description: "Explicit correct/on-theme beat used to derive the plate" },
            kind: { type: "string", enum: ["zone", "transition"] },
            map_x: { type: "number", minimum: 0, maximum: 100 },
            map_y: { type: "number", minimum: 0, maximum: 100 },
            adjacent_to: { type: "array", items: { type: "string" } },
            allowed_elements: { type: "array", items: { type: "string" } },
            forbidden_elements: { type: "array", items: { type: "string" } },
          },
          required: ["id", "name"],
          additionalProperties: false,
        },
        run: (params) => {
          let saved = null;
          const next = applyPipelineMutation((pl) => {
            saved = upsertLocation(pl, {
              id: String(params?.id || ""),
              name: String(params?.name || ""),
              description: String(params?.description || ""),
              approved: params?.approved !== false,
              prompt: String(params?.prompt || ""),
              image: params?.image_url ? {
                url: String(params.image_url),
                content_type: String(params?.image_content_type || "image/png"),
              } : null,
              sourceBeatId: String(params?.source_beat_id || "") || undefined,
              kind: params?.kind === "transition" ? "transition" : "zone",
              mapX: Number(params?.map_x ?? 50),
              mapY: Number(params?.map_y ?? 50),
              adjacentTo: Array.isArray(params?.adjacent_to) ? params.adjacent_to.map(String) : [],
              allowedElements: Array.isArray(params?.allowed_elements) ? params.allowed_elements.map(String) : [],
              forbiddenElements: Array.isArray(params?.forbidden_elements) ? params.forbidden_elements.map(String) : [],
            });
          });
          return { ok: true, location: saved, locationCount: (next.locations || []).length };
        },
      },
      {
        name: "board.assign_location",
        description: "Assign one location to an existing beat; route planning is a separate required step",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Beat id from board.get_state" },
            location_id: { type: "string", description: "Stable id from the location registry" },
          },
          required: ["id", "location_id"],
          additionalProperties: false,
        },
        run: (params) => {
          const p = psRef.current;
          const id = String(params?.id || "");
          if (!(p.board?.shots || []).some((shot) => shot.id === id)) throw new Error(`no beat ${id}`);
          const next = applyPipelineMutation((pl) => assignBeatLocation(pl, id, String(params?.location_id || "")));
          return { ok: true, id, locationId: extOf(next, id).locationId };
        },
      },
      {
        name: "board.plan_beat_geography",
        description: "Lock a beat to one canonical location, adjacent entry/exit, movement type, screen direction, and landmark anchor",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Beat id from board.get_state" },
            location_id: { type: "string" },
            movement: { type: "string", enum: ["hold", "enter", "cross", "exit", "arrive"] },
            screen_direction: { type: "string", enum: ["left-to-right", "right-to-left", "toward-camera", "away-camera", "hold"] },
            entry_from_id: { type: "string" },
            exit_to_id: { type: "string" },
            anchor: { type: "string" },
          },
          required: ["id", "location_id", "movement", "screen_direction"],
          additionalProperties: false,
        },
        run: (params) => {
          const p = psRef.current;
          const id = String(params?.id || "");
          if (!(p.board?.shots || []).some((shot) => shot.id === id)) throw new Error(`no beat ${id}`);
          const next = applyPipelineMutation((pl) => assignBeatGeography(pl, id, {
            locationId: String(params?.location_id || ""),
            movement: params?.movement as BeatMovement,
            screenDirection: params?.screen_direction as ScreenDirection,
            entryFromId: String(params?.entry_from_id || "") || undefined,
            exitToId: String(params?.exit_to_id || "") || undefined,
            anchor: String(params?.anchor || "") || undefined,
          }));
          return { ok: true, id, locationId: extOf(next, id).locationId, geography: extOf(next, id).geography };
        },
      },
      {
        name: "board.upsert_character",
        description: "Create or replace one cast-registry character by stable id; saves without rendering",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable character id; retries with the same id replace instead of duplicate" },
            name: { type: "string" },
            description: { type: "string" },
            approved: { type: "boolean" },
            prompt: { type: "string", description: "Optional identity/style instruction for reference-driven renders" },
            image_url: { type: "string", description: "Public driving-image URL" },
            image_content_type: { type: "string" },
          },
          required: ["id", "name", "image_url"],
          additionalProperties: false,
        },
        run: (params) => {
          let saved = null;
          const next = applyPipelineMutation((pl) => {
            saved = upsertCharacter(pl, {
              id: String(params?.id || ""),
              name: String(params?.name || ""),
              description: String(params?.description || ""),
              approved: params?.approved !== false,
              prompt: String(params?.prompt || ""),
              image: {
                url: String(params?.image_url || ""),
                content_type: String(params?.image_content_type || "image/png"),
              },
            });
          });
          return { ok: true, character: saved, castSize: next.characters.length };
        },
      },
      {
        name: "board.assign_cast",
        description: "Replace the cast assignment for one existing beat; saves without rendering",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Beat id from board.get_state" },
            character_ids: { type: "array", items: { type: "string" }, description: "Stable ids from the cast registry" },
            intentional_empty: { type: "boolean", description: "Resolve a shot with deliberately no visible cast and no identity references" },
          },
          required: ["id", "character_ids"],
          additionalProperties: false,
        },
        run: (params) => {
          const p = psRef.current;
          const id = String(params?.id || "");
          if (!(p.board?.shots || []).some((shot) => shot.id === id)) throw new Error(`no beat ${id}`);
          const ids = Array.isArray(params?.character_ids) ? params.character_ids.map(String) : [];
          const next = applyPipelineMutation((pl) => assignBeatCast(pl, id, ids, params?.intentional_empty === true));
          return {
            ok: true,
            id,
            characterIds: extOf(next, id).characterIds,
            readiness: boardReadiness(p.board?.shots || [], next),
          };
        },
      },
      { name: "board.add_beat", description: "Add a new beat (opens its dialog)", run: () => fnsRef.current.onAddBeat() },
      {
        // Motion direction was the single biggest gap in the v6 pass: no tracers
        // on any beat, so the video model was told what a shot looked like but
        // never what moved, and answered with frozen tableaus. Drawing them by
        // hand is 20 beats of mouse work; this is the same write the editor makes.
        name: "board.set_beat_tracers",
        description:
          "Replace a beat's motion tracers — the blocking that tells the video model what moves. " +
          "Params: { id, tracers: [{ characterId?, points: [{t,x,y}] }] }. t is 0-10s, x/y are 0-1 " +
          "screen fractions. Speech tracers on the beat are preserved.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Beat id from board.get_state" },
            tracers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  characterId: { type: "string", description: "Character id, or omit for a camera/object path" },
                  points: {
                    type: "array",
                    minItems: 2,
                    items: {
                      type: "object",
                      properties: { t: { type: "number" }, x: { type: "number" }, y: { type: "number" } },
                      required: ["t", "x", "y"],
                    },
                  },
                },
                required: ["points"],
              },
            },
          },
          required: ["id", "tracers"],
          additionalProperties: false,
        },
        run: (params) => {
          const id = String(params?.id || "");
          const incoming = Array.isArray(params?.tracers) ? (params.tracers as Record<string, unknown>[]) : [];
          if (!incoming.length) throw new Error("pass at least one tracer with 2+ points");
          const next = applyPipelineMutation((pl) => {
            const ext = extOf(pl, id);
            const speech = ext.tracers.filter((t) => t.kind === "speech");
            ext.tracers = [
              ...speech,
              ...incoming.map((t) => {
                const points = (t.points as { t: number; x: number; y: number }[]) || [];
                if (points.length < 2) throw new Error("a motion tracer needs at least 2 points");
                return {
                  id: newId(),
                  characterId: t.characterId ? String(t.characterId) : null,
                  kind: "move" as const,
                  path: points.map((p) => ({
                    t: Math.max(0, Math.min(BEAT_SECONDS, Number(p.t) || 0)),
                    x: Math.max(0, Math.min(1, Number(p.x) || 0)),
                    y: Math.max(0, Math.min(1, Number(p.y) || 0)),
                  })),
                };
              }),
            ];
            markBeatEdited(pl, id);
            pl.beats[id] = ext;
          });
          return { ok: true, id, tracers: extOf(next, id).tracers.length, readiness: boardReadiness(psRef.current.board?.shots || [], next) };
        },
      },
      {
        name: "board.set_beat_text",
        description: "Set a beat's text. Saves only — call board.render_beat to make a picture. Params: { id, text }",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "Beat id from board.get_state" }, text: { type: "string" } },
          required: ["id", "text"],
          additionalProperties: false,
        },
        run: async (params) => {
          const p = psRef.current;
          const id = String(params?.id || "");
          const sb = await patchShot(p.apiKey, undefined, id, { prompt: String(params?.text || "") });
          p.setBoard(sb);
          mut((pl) => markBeatEdited(pl, id)); // same staleness contract as the UI paths
          return { ok: true };
        },
      },
      {
        name: "board.render_beat",
        description: "Render one beat's still — edits its existing image when it has one. Params: { id }",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "Beat id from board.get_state" } },
          required: ["id"],
          additionalProperties: false,
        },
        confirmation: "Starts a paid image generation job",
        run: async (params) => {
          const p = psRef.current;
          const id = String(params?.id || "");
          const shot = (p.board?.shots || []).find((s) => s.id === id);
          if (!shot) throw new Error(`no beat ${id}`);
          await renderShot(
            p,
            shot,
            shot.result
              ? { editFrom: shot.result.url, refs: beatRefs(pipeRef.current, extOf(pipeRef.current, id)) }
              : { refs: beatRefs(pipeRef.current, extOf(pipeRef.current, id)) },
          );
          return { ok: true };
        },
      },
      { name: "board.render_all", description: "Render every draft beat", confirmation: "Starts paid image generation jobs", run: () => fnsRef.current.renderAll() },
      { name: "board.preview", description: "Play the storyboard seed cut without exporting; Studio owns release export", run: () => fnsRef.current.previewBoard() },
      { name: "board.export_prompt_pack", description: "Download the prompt pack (.md) + shot bible (.json)", run: () => fnsRef.current.exportPack() },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = shots.reduce((s, b) => s + durOf(b), 0);
  const ready = shots.filter((s) => s.status === "ready").length;
  const readiness = boardReadiness(shots, pipe);

  return (
    <div className="board-wrap">
      <div className="board-head">
        <div className="title">
          <h2>{ps.board?.title || "Untitled Storyboard"}</h2>
          <div className="sub">Story sequence · {shots.length} beats · each beat drives one ≤10s clip</div>
        </div>
        <div className="grow" />
        <div className="pipeline-legend">
          <span className="st"><span className="d draft" />draft</span>
          <span className="arr">→</span>
          <span className="st"><span className="d lowres" />rendering</span>
          <span className="arr">→</span>
          <span className="st"><span className="d hires" />still</span>
          <span className="arr">→</span>
          <span className="st"><span className="d clip" />clip</span>
        </div>
      </div>
      <div className="board-sub">
        <span>
          runtime <b>{fmtTime(total)}</b>
        </span>
        <span>
          rendered <b>{ready} / {shots.length}</b>
        </span>
        <div className="seg-bar">
          {shots.map((s, i) => (
            <i
              key={s.id}
              style={{
                flex: durOf(s),
                background: s.status === "ready" ? SEG_COLORS[i % SEG_COLORS.length] : "var(--border-strong)",
                opacity: s.status === "ready" ? 1 : 0.5,
              }}
            />
          ))}
        </div>
        <span>
          target <b>≤ 10s / beat</b>
        </span>
      </div>
      <div className="board-scroll">
        <AssetsPanel ps={ps} pipe={pipe} mut={mut} shots={shots} />
        <div className="beats" id="beats">
          {shots.map((s, i) => {
            const stg = stageOf(s);
            const busy = s.status === "queued" || s.status === "starting" || s.status === "running";
            return (
              <div
                key={s.id}
                className={`beat${selected === s.id ? " sel" : ""}${drag?.id === s.id ? " dragging" : ""}${
                  drag && drag.at === i && drag.at !== drag.from && drag.at !== drag.from + 1 ? " dz-l" : ""
                }`}
                data-id={s.id}
                draggable={editing !== s.id}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  setDrag({ id: s.id, from: i, at: i });
                }}
                onDragEnd={() => setDrag(null)}
                {...dragProps(i)}
                onClick={() => {
                  setSelected(s.id);
                  setDialog(s.id); // Pressing a beat opens its pipeline dialog.
                }}
              >
                <div className={`frame ${stg.cls === "draft" || stg.cls === "lowres" ? "lowres" : ""}${stg.cls === "clip" ? " hasclip" : ""}`}>
                  {s.result && kindOf(s.result.content_type, s.result.url) === "video" ? (
                    <video
                      className="fill"
                      src={s.result.url}
                      muted
                      loop
                      playsInline
                      preload="metadata"
                      onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                      onMouseLeave={(e) => {
                        e.currentTarget.pause();
                        e.currentTarget.currentTime = 0;
                      }}
                    />
                  ) : (
                    <div
                      className="fill"
                      style={
                        s.result
                          ? { backgroundImage: `url(${s.result.url})`, backgroundSize: "cover", backgroundPosition: "center" }
                          : { background: PH[i % PH.length] }
                      }
                    />
                  )}
                  <div className="ph-grain" />
                  <div className="num">{String(i + 1).padStart(2, "0")}</div>
                  <div className="dur">{durOf(s)}s</div>
                  <div
                    className={`rdy ${readiness.perBeat[i].band}`}
                    title={
                      readiness.perBeat[i].components.filter((c) => c.value < 1).map((c) => c.hint).join(" · ") ||
                      "ready for the final render"
                    }
                  >
                    {readiness.perBeat[i].score}
                  </div>
                  <div className={`stg ${stg.cls}`}>{stg.label}</div>
                  {stg.cls === "clip" && (
                    <div className="clip-badge">
                      <svg className="ic" viewBox="0 0 24 24" style={{ width: 13, height: 13 }}>
                        <polygon points="6 3 20 12 6 21 6 3" />
                      </svg>
                    </div>
                  )}
                  {busy && <div className="prog" style={{ width: s.status === "running" ? "60%" : "15%" }} />}
                </div>
                <div className="info">
                  <div className="bt">{s.prompt ? s.prompt.split(/[,—.]/)[0].slice(0, 40) : "New beat"}</div>
                  {editing === s.id ? (
                    <textarea
                      className="prompt-box"
                      autoFocus
                      style={{ width: "100%", minHeight: 56, fontSize: 11.5, background: "var(--bg-elevated)", color: "var(--fg1)", border: "1px solid var(--input)", borderRadius: 6, padding: 6 }}
                      value={editText}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditText(e.target.value)}
                      onBlur={() => saveEdit(s.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          saveEdit(s.id);
                        }
                      }}
                    />
                  ) : (
                    <div className="bd">{s.prompt || "Describe this shot — copilot drafts it."}</div>
                  )}
                  <div className="actions">
                    {busy ? (
                      <button type="button" className="beat-btn" disabled>
                        <span className="spin" style={{ width: 10, height: 10, borderRadius: "50%", border: "1.5px solid var(--compass-400)", borderTopColor: "transparent", display: "inline-block" }} />
                        {s.status}…
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="beat-btn accent"
                        onClick={(e) => {
                          e.stopPropagation();
                          renderShot(psRef.current, s, { refs: beatRefs(pipe, extOf(pipe, s.id)) }).catch((err) =>
                            psRef.current.toast(String(err.message || err)),
                          );
                        }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                          {s.status === "ready" ? <path d="M4 4v6h6M20 9A8 8 0 0 0 6 6" /> : <path d="M5 3l14 9-14 9V3z" />}
                        </svg>
                        {s.status === "ready" ? "Re-render" : "Render"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="beat-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(s.id);
                        setEditText(s.prompt);
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                        <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="beat-btn"
                      title="Delete beat"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(s.id);
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          <div
            className={`beat add${drag && drag.at === shots.length && drag.from !== shots.length - 1 ? " dz-l" : ""}`}
            onClick={onAddBeat}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              if (drag.at !== shots.length) setDrag({ ...drag, at: shots.length });
            }}
            onDrop={(e) => {
              e.preventDefault();
              void onDrop();
            }}
          >
            <div className="inner">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <path d="M12 5v14M5 12h14" />
              </svg>
              <div className="lbl">Add beat</div>
            </div>
          </div>
        </div>
      </div>
      <div className="release-bar">
        <div className="rinfo">
          <div className="rt">
            <svg className="ic" viewBox="0 0 24 24" style={{ color: "var(--compass-400)" }}>
              <path d="M12 3l2.2 5.5L20 10l-5.8 1.5L12 17l-2.2-5.5L4 10l5.8-1.5z" />
            </svg>
            Storyboard preview
          </div>
          <div className="rs">The board seeds Studio's timeline. Preview it here; edit and export the canonical cut in Studio.</div>
          {pipe.release && (
            <div className="rs">
              <a href={pipe.release.url} target="_blank" rel="noreferrer" style={{ color: "var(--compass-400)" }}>
                Last release · {fmtTime(pipe.release.duration)} · open ↗
              </a>
            </div>
          )}
        </div>
        <div className="grow" />
        <div
          className="readiness"
          title="Release readiness — weighted per-beat score across stills, locations, cast, tracers, voice, and prompts"
        >
          <span>
            {ready} / {shots.length} rendered · <b className={`rdy-lbl ${readiness.band}`}>{readiness.score} {readiness.band}</b>
          </span>
          <div className="rmeter">
            <i className={readiness.band} style={{ width: `${readiness.score}%` }} />
          </div>
        </div>
        <button type="button" className="btn" onClick={exportPack} title="Download the board as a prompt pack (.md) + shot bible (.json) for any tool">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M9 13h6M9 17h6" />
          </svg>
          Prompt pack
        </button>
        <button type="button" className="btn gold" onClick={previewBoard}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M12 3v12M8 11l4 4 4-4M5 21h14" />
          </svg>
          Preview board cut
        </button>
      </div>
      {(() => {
        const i = shots.findIndex((s) => s.id === dialog);
        return i >= 0 ? (
          <BeatDialog
            key={shots[i].id} // fresh dialog state per beat — "Save & next" must not carry text over
            ps={ps}
            shot={shots[i]}
            index={i}
            pipe={pipe}
            mut={mut}
            onClose={() => setDialog(null)}
            onNext={nextBeat}
          />
        ) : null;
      })()}
      {release && <ReleasePlayer release={release} onClose={() => setRelease(null)} />}
    </div>
  );
}

// Final output viewer: real R2 master when server assembly is live, else an
// in-order preview of the final clips with the mixed soundtrack underneath.
function ReleasePlayer({
  release,
  onClose,
}: {
  release: { url?: string; items?: PreviewItem[]; audio?: string | null };
  onClose(): void;
}) {
  const [idx, setIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const items = release.items || [];
  const cur = items[idx];
  const FILL = { width: "100%", height: "100%", objectFit: "cover" as const };
  // cumulative end time of each item — the soundtrack clock advances stills
  const bounds = useMemo(() => {
    let t = 0;
    return items.map((it) => (t += it.seconds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [release]);

  const advance = () => {
    if (idx + 1 < items.length) setIdx(idx + 1);
    else audioRef.current?.pause();
  };

  // (re)start from the top whenever a new release object arrives — including
  // the async server-master path replacing an open animatic in place
  useEffect(() => {
    setIdx(0);
    if (!release.url && release.audio) {
      const a = audioRef.current;
      if (a) {
        a.currentTime = 0;
        a.play().catch(() => {});
      }
    }
  }, [release]);

  // Stills always advance on a guaranteed timer; when a soundtrack is playing
  // healthily its clock may advance them EARLY to stay locked to voice cues.
  // A blocked/stalled/short mix can therefore never freeze or strobe the cut.
  // Video clips advance on their own onEnded/onError.
  // Preview does not reseek each clip; server assembly is the frame-accurate path.
  useEffect(() => {
    if (release.url || cur?.kind !== "still") return;
    const t = setTimeout(advance, cur.seconds * 1000);
    const a = release.audio ? audioRef.current : null;
    const h = a
      ? setInterval(() => {
          if (!a.paused && !a.ended && a.currentTime >= bounds[idx] - 0.05) advance();
        }, 200)
      : null;
    return () => {
      clearTimeout(t);
      if (h) clearInterval(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, release]);

  return (
    <div className="bd-overlay" onClick={onClose}>
      <div className="release-card" onClick={(e) => e.stopPropagation()}>
        <div className="rc-media" style={{ display: "block" }}>
          {release.url ? (
            <video key={release.url} controls autoPlay src={release.url} style={FILL} />
          ) : cur?.kind === "video" ? (
            // muted when a soundtrack plays underneath (also keeps autoplay legal);
            // a broken clip URL must not stall the cut — advance on error too
            <video key={idx} controls autoPlay muted={!!release.audio} src={cur.url} style={FILL} onEnded={advance} onError={advance} />
          ) : cur?.url ? (
            <img key={idx} src={cur.url} alt={cur.label} style={FILL} />
          ) : (
            <div style={{ width: "100%", height: "100%", background: "#050a05" }} />
          )}
          {!release.url && release.audio && <audio ref={audioRef} src={release.audio} />}
        </div>
        <div className="rc-body">
          <h3>{release.url ? "Master on R2" : `Animatic — ${cur?.label ?? ""} (${idx + 1}/${items.length})`}</h3>
          <p>
            {release.url
              ? "Single file, public URL — shareable and readable by anyone."
              : "Stills are held for their beat duration and final clips replace them as they render. This seed cut flows into Studio; the Studio timeline produces the shareable master."}
          </p>
          {release.url && (
            <div className="r2-url">
              <div className="u">{release.url}</div>
              <button
                type="button"
                className={`cbtn${copied ? " copied" : ""}`}
                onClick={() => {
                  navigator.clipboard?.writeText(release.url!).then(
                    () => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1400);
                    },
                    () => {},
                  );
                }}
              >
                {copied ? "Copied ✓" : "Copy"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
