// CreateView — the character-creation flow.
//
//   text → concept cluster → portrait → voice → talking-head → VRM
//
// Every stage uses a public Pioneer API capability. The portrait is the shared
// concept image for the talking head and the VRM, keeping the 3D model and video
// visually aligned.
//
// Every artifact is a URL (R2 or data:), so a whole character serialises to JSON
// and persists in localStorage — you can leave any stage half-done and come back
// to finish it. Multiple characters live side by side as a roster.
import { useEffect, useRef, useState } from "react";
import {
  blobToDataUrl,
  fetchModels,
  fetchVrmStatus,
  generateVrm,
  pickFlowModels,
  pollVrm,
  submitJob,
  uploadMedia,
  type FlowModels,
  type JobModel,
} from "./api";
import type { PS } from "./shared";
import { IcSpark } from "./shared";
import { sendCharacter, type CharacterHandoff } from "./characterHandoff";
import VrmPicker from "./VrmPicker";
import "./create.css";

type Art = { url: string; contentType: string; ephemeral?: boolean };
type StageState = "idle" | "running" | "done" | "error";

/** Everything a character accumulates. All artifacts are URLs, so this is pure
 *  JSON and persists as-is. */
type Character = {
  id: string;
  name: string;
  desc: string;
  cluster: (Art | "failed" | null)[];
  concept: Art | null;
  portrait: Art | null;
  voiceLine: string;
  voiceDesc: string;
  voice: Art | null;
  talkingHead: Art | null;
  vrm: Art | null;
  updatedAt: number;
};

const CONCEPT_COUNT = 4;
const STORE_KEY = "pioneer_studio_characters";
const ACTIVE_KEY = "pioneer_studio_active_character";
const DEFAULT_LINE = "Welcome, traveler. I have been expecting you.";

// Variation suffixes so the cluster shows distinct interpretations, not 4 seeds
// of one. Front concept is what feeds portrait/VRM, so keep it clean + framed.
const VARIATIONS = [
  "front-facing character concept portrait, neutral studio background, full head and shoulders, clean lighting",
  "3/4 turnaround view, character concept, neutral background",
  "full-body character concept, T-pose, neutral background, game-ready silhouette",
  "expressive close-up portrait, character concept, soft key light",
];

const rid = () => `char_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
function blankChar(): Character {
  return {
    id: rid(),
    name: "",
    desc: "",
    cluster: [],
    concept: null,
    portrait: null,
    voiceLine: DEFAULT_LINE,
    voiceDesc: "",
    voice: null,
    talkingHead: null,
    vrm: null,
    updatedAt: Date.now(),
  };
}
function loadChars(): Character[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    if (Array.isArray(raw) && raw.length)
      return raw.map((character) =>
        character?.vrm?.url?.startsWith("blob:") ? { ...character, vrm: null } : character,
      );
  } catch {
    /* corrupt store → start fresh */
  }
  return [blankChar()];
}

export default function CreateView({ ps }: { ps: PS }) {
  const [flow, setFlow] = useState<FlowModels | null>(null);
  const [chars, setChars] = useState<Character[]>(loadChars);
  const [activeId, setActiveId] = useState<string>(() => localStorage.getItem(ACTIVE_KEY) || "");

  // per-stage transient status (never persisted — a reload shows the saved
  // artifacts, not "running")
  const [st, setSt] = useState<Record<string, StageState>>({});
  const [err, setErr] = useState<Record<string, string>>({});
  const [vrmStage, setVrmStage] = useState("");
  const psRef = useRef(ps);
  psRef.current = ps;

  const active = chars.find((c) => c.id === activeId) || chars[0];

  // keep a valid active id
  useEffect(() => {
    if (!chars.find((c) => c.id === activeId)) setActiveId(chars[0]?.id || "");
  }, [chars, activeId]);

  // persist every change
  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(chars));
  }, [chars]);
  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
  }, [activeId]);

  // detect the flow's models once
  useEffect(() => {
    let cancelled = false;
    async function detect() {
      try {
        const { jobs } = await fetchModels(psRef.current.apiKey).catch(() => ({ jobs: [] as JobModel[] }));
        const picked = pickFlowModels(jobs);
        const vrmOk = psRef.current.apiKey ? await fetchVrmStatus(psRef.current.apiKey) : false;
        if (!cancelled) setFlow({ ...picked, vrm: vrmOk });
      } catch {
        if (!cancelled) setFlow({ image: null, imageHi: null, imageEdit: null, tts: null, lipsync: null, vrm: false });
      }
    }
    detect();
    return () => {
      cancelled = true;
    };
  }, [ps.apiKey]);

  /** Patch a character by id (stable across awaits — never trust a captured
   *  object, only its id). */
  const patch = (id: string, f: Partial<Character>) =>
    setChars((cs) => cs.map((c) => (c.id === id ? { ...c, ...f, updatedAt: Date.now() } : c)));

  function newCharacter() {
    const c = blankChar();
    setChars((cs) => [c, ...cs]);
    setActiveId(c.id);
    setSt({});
    setErr({});
  }
  function switchTo(id: string) {
    setActiveId(id);
    setSt({});
    setErr({});
  }
  function deleteChar(id: string) {
    setChars((cs) => {
      const next = cs.filter((c) => c.id !== id);
      return next.length ? next : [blankChar()];
    });
  }

  const setStage = (k: string, s: StageState, e = "") => {
    setSt((m) => ({ ...m, [k]: s }));
    setErr((m) => ({ ...m, [k]: e }));
  };

  async function run(model: string, endpoint: string, params: unknown): Promise<Art> {
    const { job_id } = await submitJob(ps.apiKey, model, endpoint, params);
    const { url, contentType } = await ps.waitForJob(job_id);
    return { url, contentType };
  }

  const needKey = () => {
    if (!ps.apiKey) {
      ps.toast("Add your key in Settings to generate");
      return true;
    }
    return false;
  };
  const isPublic = (u?: string) => !!u && /^https?:\/\//.test(u);

  /* ── Stage 1: concept cluster ── */
  async function genConcepts() {
    if (needKey()) return;
    const c = active;
    if (!c.desc.trim()) return ps.toast("Describe the character first");
    if (!flow?.image) return ps.toast("No image model available");
    const id = c.id;
    setStage("concept", "running");
    patch(id, { cluster: Array(CONCEPT_COUNT).fill(null) });
    const model = flow.image.model;
    const MAX_ACTIVE = 2; // the account's max_active_jobs cap
    const results: (Art | "failed")[] = Array(CONCEPT_COUNT).fill("failed");
    const queue = VARIATIONS.slice(0, CONCEPT_COUNT).map((v, i) => ({ v, i }));
    async function worker() {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        try {
          const art = await run(model, "generate", { prompt: `${c.desc.trim()}, ${item.v}` });
          results[item.i] = art;
        } catch {
          results[item.i] = "failed";
        }
        patch(id, { cluster: results.slice() });
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_ACTIVE, queue.length) }, worker));
    const anyOk = results.some((x) => x !== "failed");
    setStage("concept", anyOk ? "done" : "error", anyOk ? "" : "all concepts failed");
  }

  function pickConcept(a: Art) {
    // picking a new concept invalidates everything derived from the old one
    patch(active.id, { concept: a, portrait: null, talkingHead: null, vrm: null });
  }

  /** An imported image is the user's chosen canonical art: it becomes concept
   *  AND portrait at once, unlocking voice/talking-head/VRM without generating. */
  function adoptImage(a: Art) {
    patch(active.id, { concept: a, portrait: a, talkingHead: null, vrm: null });
  }

  async function importImageFile(f: File | undefined) {
    if (!f || !f.type.startsWith("image/")) return;
    try {
      if (!ps.apiKey) throw new Error("no key");
      const up = await uploadMedia(ps.apiKey, f);
      adoptImage({ url: up.url, contentType: up.content_type });
      ps.refreshMedia();
    } catch {
      // no key / no R2 → inline. Fine for concept/portrait; talking head and
      // VRM still need a hosted image and say so when tried.
      adoptImage({ url: await blobToDataUrl(f), contentType: f.type });
    }
  }

  /* ── Stage 2: portrait ── */
  async function genPortrait() {
    if (needKey() || !active.concept) return;
    const id = active.id;
    const concept = active.concept;
    if (!flow?.imageEdit || !isPublic(concept.url)) {
      patch(id, { portrait: concept });
      setStage("portrait", "done");
      return;
    }
    setStage("portrait", "running");
    try {
      const art = await run(flow.imageEdit.model, "edit", {
        image: concept.url,
        prompt: "clean front-facing character portrait, neutral background, even lighting, sharp focus, full face visible, consistent character identity",
      });
      patch(id, { portrait: art });
      setStage("portrait", "done");
    } catch (e: any) {
      setStage("portrait", "error", String(e.message || e));
    }
  }
  function useConceptAsPortrait() {
    if (!active.concept) return;
    patch(active.id, { portrait: active.concept });
    setStage("portrait", "done");
  }

  /* ── Stage 3: voice ── */
  async function genVoice() {
    if (needKey()) return;
    const id = active.id;
    if (!active.voiceLine.trim()) return ps.toast("Write a line for the character to say");
    if (!flow?.tts) return ps.toast("No TTS model available");
    setStage("voice", "running");
    try {
      const art = await run(flow.tts.model, "tts", {
        text: active.voiceLine.trim(),
        ...(active.voiceDesc.trim() ? { voice_description: active.voiceDesc.trim() } : {}),
      });
      patch(id, { voice: art });
      setStage("voice", "done");
    } catch (e: any) {
      setStage("voice", "error", String(e.message || e));
    }
  }

  /* ── Stage 4: talking head ── */
  async function genTalkingHead() {
    if (needKey() || !active.portrait || !active.voice) return;
    const id = active.id;
    if (!flow?.lipsync) return ps.toast("No lip-sync model available");
    if (!isPublic(active.portrait.url) || !isPublic(active.voice.url)) {
      return ps.toast("Talking head needs R2-hosted portrait + voice (this account has no R2 for one of them)");
    }
    setStage("talkinghead", "running");
    try {
      const art = await run(flow.lipsync.model, "lipsync", {
        image: active.portrait.url,
        audio: active.voice.url,
        size: "256*256",
      });
      patch(id, { talkingHead: art });
      setStage("talkinghead", "done");
    } catch (e: any) {
      setStage("talkinghead", "error", String(e.message || e));
    }
  }

  /* ── Stage 5: VRM ── */
  async function genVrm() {
    if (needKey() || !active.portrait) return;
    const id = active.id;
    if (!flow?.vrm) return ps.toast("VRM generation is not currently available through the Pioneer API");
    if (!isPublic(active.portrait.url)) return ps.toast("VRM needs an R2-hosted portrait (no R2 on this account)");
    setStage("vrm", "running");
    setVrmStage("submitting");
    try {
      const { job_id } = await generateVrm(ps.apiKey, { image: active.portrait.url, name: active.name.trim() || "character" });
      for (;;) {
        await new Promise((r) => setTimeout(r, 5000));
        const s = await pollVrm(ps.apiKey, job_id);
        setVrmStage(s.stage || s.status);
        if (s.status === "done" && s.url) {
          patch(id, { vrm: { url: s.url, contentType: "model/vrm" } });
          setStage("vrm", "done");
          ps.refreshMedia();
          ps.refreshCredits();
          return;
        }
        if (s.status === "error") throw new Error(s.error || "vrm generation failed");
      }
    } catch (e: any) {
      setStage("vrm", "error", String(e.message || e));
    }
  }

  async function uploadVrmFile(f: File | undefined) {
    if (!f || !/\.vrm$/i.test(f.name)) return;
    if (needKey()) return;
    const id = active.id;
    setStage("vrm", "running");
    try {
      const up = await uploadMedia(ps.apiKey, f);
      patch(id, { vrm: { url: up.url, contentType: "model/vrm" } });
      setStage("vrm", "done");
      ps.refreshMedia();
    } catch {
      // The current Media intake only sniffs image/audio/video. Keep a local
      // object URL alive for this session so an authored VRM can still travel
      // Create → Head/Animation; generated VRMs remain the persistent path.
      const url = URL.createObjectURL(f);
      patch(id, { vrm: { url, contentType: "model/vrm", ephemeral: true } });
      setStage("vrm", "done");
      ps.toast(`${f.name} loaded for this browser session (Media does not accept VRM uploads yet)`);
    }
  }

  function activeHandoff(): CharacterHandoff | null {
    if (!active.vrm) return null;
    return {
      id: active.id,
      name: active.name.trim() || "Character",
      vrmUrl: active.vrm.url,
      portraitUrl: active.portrait?.url,
      persona: active.desc.trim() || undefined,
      voice: active.voiceDesc.trim() || undefined,
      ephemeral: active.vrm.ephemeral,
    };
  }

  /* ── stage readiness ── */
  function ready(k: string): boolean {
    if (k === "concept") return !!active.desc.trim();
    if (k === "portrait") return !!active.concept;
    if (k === "voice") return !!active.voiceLine.trim();
    if (k === "talkinghead") return !!active.portrait && !!active.voice;
    if (k === "vrm") return !!active.portrait;
    return false;
  }
  const done = (k: string): boolean => {
    if (k === "portrait") return !!active.portrait;
    if (k === "voice") return !!active.voice;
    if (k === "talkinghead") return !!active.talkingHead;
    if (k === "vrm") return !!active.vrm;
    if (k === "concept") return !!active.concept || active.cluster.some((x) => x && x !== "failed");
    return false;
  };
  const dot = (k: string) => `st-dot ${st[k] || (done(k) ? "done" : ready(k) ? "ready" : "locked")}`;

  // a character has "progress" worth showing in the roster if any artifact exists
  const progressCount = (c: Character) =>
    [c.concept, c.portrait, c.voice, c.talkingHead, c.vrm].filter(Boolean).length;
  const thumb = (c: Character) => c.portrait?.url || c.concept?.url || null;

  return (
    <div className="create-root">
      {/* ── roster: saved characters ── */}
      <div className="roster">
        <button className="roster-new" onClick={newCharacter} title="Start a new character">
          + New
        </button>
        <div className="roster-list">
          {chars.map((c) => (
            <div
              key={c.id}
              className={`roster-card${c.id === active.id ? " on" : ""}`}
              onClick={() => switchTo(c.id)}
              title={c.name || "Untitled"}
            >
              {thumb(c) ? <img src={thumb(c)!} alt="" /> : <div className="roster-blank">{(c.name || "?").slice(0, 1).toUpperCase()}</div>}
              <div className="roster-meta">
                <span className="rc-name">{c.name || "Untitled"}</span>
                <span className="rc-prog">{progressCount(c) ? `${progressCount(c)}/5` : "empty"}</span>
              </div>
              {chars.length > 1 && (
                <button
                  className="rc-x"
                  title="Delete character"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteChar(c.id);
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="create-head">
        <h2>Create a character</h2>
        <p className="sub">
          text → concept → portrait → voice → talking head → VRM. Every artifact is saved as you go — leave any stage half-done and
          come back to finish it.
        </p>
        <div className="create-name">
          <input placeholder="Character name" value={active.name} onChange={(e) => patch(active.id, { name: e.target.value })} />
        </div>
      </div>

      {/* Stage 1 — concept cluster */}
      <section className="stage-card">
        <div className="sc-head">
          <span className={dot("concept")} />
          <b>1 · Concept cluster</b>
          <span className="sc-model">{flow?.image ? flow.image.model : "—"}</span>
        </div>
        <textarea
          className="sc-input"
          rows={3}
          placeholder="Describe the character — e.g. 'a stern elven ranger with silver hair, green travel cloak, leather bracers'"
          value={active.desc}
          onChange={(e) => patch(active.id, { desc: e.target.value })}
        />
        <div className="sc-actions">
          <button className="btn primary" disabled={st.concept === "running"} onClick={genConcepts}>
            {st.concept === "running" ? "Generating…" : `Generate ${CONCEPT_COUNT} concepts`}
          </button>
          <label className="btn">
            Import image
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                void importImageFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <VrmPicker
            ps={ps}
            kind="image"
            label="From Media…"
            onPick={(object) => adoptImage({ url: object.url, contentType: object.content_type })}
          />
          {err.concept && <span className="sc-err">{err.concept}</span>}
        </div>
        {active.cluster.length > 0 && (
          <div className="sc-grid">
            {active.cluster.map((a, i) => {
              const art = a && a !== "failed" ? a : null;
              return (
                <div
                  key={i}
                  className={`sc-tile${active.concept && art && active.concept.url === art.url ? " picked" : ""}${!a ? " loading" : ""}${a === "failed" ? " failed" : ""}`}
                  onClick={() => art && pickConcept(art)}
                >
                  {art ? <img src={art.url} alt="" /> : a === "failed" ? <span className="tile-x">✕</span> : <div className="spin" />}
                  {active.concept && art && active.concept.url === art.url && <span className="pick-badge">✓ concept</span>}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Stage 2 — portrait */}
      <StageShell n={2} title="Portrait" model={flow?.imageEdit ? `${flow.imageEdit.model} · edit` : "—"} dotClass={dot("portrait")} locked={!ready("portrait")} lockedMsg="Pick a concept above first">
        <p className="sc-note">The canonical front-facing image. Refine the concept into a clean portrait, or use the concept as-is.</p>
        <div className="sc-actions">
          <button className="btn primary" disabled={!ready("portrait") || st.portrait === "running"} onClick={genPortrait}>
            {st.portrait === "running" ? "Refining…" : "Refine to portrait"}
          </button>
          <button className="btn" disabled={!ready("portrait")} onClick={useConceptAsPortrait}>
            Use concept as-is
          </button>
          {err.portrait && <span className="sc-err">{err.portrait}</span>}
        </div>
        {active.portrait && (
          <div className="sc-preview">
            <img src={active.portrait.url} alt="portrait" />
          </div>
        )}
      </StageShell>

      {/* Stage 3 — voice */}
      <section className="stage-card">
        <div className="sc-head">
          <span className={dot("voice")} />
          <b>3 · Voice</b>
          <span className="sc-model">{flow?.tts ? flow.tts.model : "—"}</span>
        </div>
        <textarea
          className="sc-input"
          rows={2}
          placeholder="A line for the character to say"
          value={active.voiceLine}
          onChange={(e) => patch(active.id, { voiceLine: e.target.value })}
        />
        <input
          className="sc-input one"
          placeholder="Voice design (optional) — e.g. 'old gravelly sage, unhurried'"
          value={active.voiceDesc}
          onChange={(e) => patch(active.id, { voiceDesc: e.target.value })}
        />
        <div className="sc-actions">
          <button className="btn primary" disabled={st.voice === "running"} onClick={genVoice}>
            {st.voice === "running" ? "Voicing…" : "Generate voice"}
          </button>
          {err.voice && <span className="sc-err">{err.voice}</span>}
        </div>
        {active.voice && (
          <div className="sc-preview">
            <audio src={active.voice.url} controls />
          </div>
        )}
      </section>

      {/* Stage 4 — talking head */}
      <StageShell n={4} title="Talking head" model={flow?.lipsync ? `${flow.lipsync.model} · lipsync` : "—"} dotClass={dot("talkinghead")} locked={!ready("talkinghead")} lockedMsg="Needs a portrait (step 2) and a voice (step 3)">
        <p className="sc-note">Lip-syncs the portrait to the voice line → an mp4.</p>
        <div className="sc-actions">
          <button className="btn primary" disabled={!ready("talkinghead") || st.talkinghead === "running"} onClick={genTalkingHead}>
            {st.talkinghead === "running" ? "Syncing… (~7 min)" : "Generate talking head (250 cr)"}
          </button>
          {err.talkinghead && <span className="sc-err">{err.talkinghead}</span>}
        </div>
        {active.talkingHead && (
          <div className="sc-preview">
            <video src={active.talkingHead.url} controls loop />
          </div>
        )}
      </StageShell>

      {/* Stage 5 — VRM */}
      <StageShell n={5} title="VRM (3D model)" model={flow?.vrm ? "meshy → rig → meshy2vrm" : "service off"} dotClass={dot("vrm")} locked={!ready("vrm")} lockedMsg="Needs a portrait (step 2)">
        <p className="sc-note">
          A rigged, game-ready avatar from the portrait — drops straight into the Animation stage's <b>Skin VRM</b>.
        </p>
        <div className="sc-actions">
          <button className="btn primary" disabled={!ready("vrm") || !flow?.vrm || st.vrm === "running"} onClick={genVrm}>
            {st.vrm === "running" ? `Building… ${vrmStage}` : "Generate VRM"}
          </button>
          <label className="btn">
            Upload .vrm
            <input type="file" accept=".vrm" hidden onChange={(e) => uploadVrmFile(e.target.files?.[0])} />
          </label>
          <VrmPicker
            ps={ps}
            label="Choose from Media…"
            onPick={(object) => {
              patch(active.id, { vrm: { url: object.url, contentType: object.content_type } });
              ps.toast(`${object.name} linked to ${active.name || "character"}`, "ok");
            }}
          />
          {err.vrm && <span className="sc-err">{err.vrm}</span>}
        </div>
        {flow && !flow.vrm && (
          <p className="sc-warn">
            VRM generation isn't currently available through the Pioneer API. You can still upload a .vrm.
          </p>
        )}
        {active.vrm && (
          <div className="sc-preview vrm-ready">
            <IcSpark />
            <span>VRM ready</span>
            <a className="btn" href={active.vrm.url} download={`${active.name || "character"}.vrm`}>
              Download
            </a>
            <button
              className="btn"
              onClick={() => {
                const character = activeHandoff();
                if (!character) return;
                sendCharacter("head", character);
                ps.setMode("head");
              }}
            >
              Send to Head →
            </button>
            <button
              className="btn"
              onClick={() => {
                const character = activeHandoff();
                if (!character) return;
                sendCharacter("animate", character);
                ps.setMode("animate");
              }}
            >
              Send to Animation →
            </button>
          </div>
        )}
      </StageShell>
    </div>
  );
}

/** A gated stage: dims + shows why it's locked, instead of looking dead. */
function StageShell({
  n,
  title,
  model,
  dotClass,
  locked,
  lockedMsg,
  children,
}: {
  n: number;
  title: string;
  model: string;
  dotClass: string;
  locked: boolean;
  lockedMsg: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`stage-card${locked ? " locked" : ""}`}>
      <div className="sc-head">
        <span className={dotClass} />
        <b>
          {n} · {title}
        </b>
        <span className="sc-model">{model}</span>
      </div>
      {locked && <div className="sc-lock">🔒 {lockedMsg}</div>}
      {children}
    </section>
  );
}
