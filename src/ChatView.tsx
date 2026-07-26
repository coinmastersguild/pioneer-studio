import { useEffect, useRef, useState } from "react";
import { submitJob, uploadMedia, type MediaObject } from "./api";
import { injectRefs, requestJobPlan } from "./copilot";
import FlowCard from "./FlowCard";
import SkeletonCard from "./SkeletonCard";
import { FLOWS, flowById, flowIsLive, matchFlow, wantsSkeleton, type Flow } from "./flows";
import { IcCopy, IcImage, IcMusic, IcPlay, IcSend, IcSpark, kindOf, sleep, type PS } from "./shared";

type PlanInfo = {
  model: string;
  endpoint: string;
  params: [string, string][];
  refs: string[];
  cost: number | string;
};
type JobInfo = {
  status: "queued" | "running" | "done" | "failed";
  model: string;
  endpoint: string;
  url?: string;
  kind?: "image" | "audio" | "video" | "model";
  error?: string;
};
type Part =
  | { id: number; type: "text"; text: string }
  | { id: number; type: "plan"; plan: PlanInfo }
  | { id: number; type: "job"; job: JobInfo }
  | { id: number; type: "flow"; flowId: string }
  | { id: number; type: "skeleton" };
type Turn = { id: number; who: "user" | "ai"; parts: Part[] };

// mirrors copilot injectRefs — only these refs actually reach the job params
function injectedRefs(endpoint: string, refs: MediaObject[]): MediaObject[] {
  const imgs = refs.filter((r) => r.content_type.startsWith("image/"));
  const auds = refs.filter((r) => r.content_type.startsWith("audio/"));
  const vids = refs.filter((r) => r.content_type.startsWith("video/"));
  if (endpoint === "edit") return imgs.slice(0, 1);
  if (endpoint === "multi_reference") return imgs.slice(0, 4);
  if (endpoint === "lipsync") return [...imgs.slice(0, 1), ...auds.slice(0, 1)];
  if (endpoint === "enhance") return [...vids.slice(0, 1), ...imgs.slice(0, 1)];
  return [];
}

const STARTERS: { key: string; title: string; desc: string; icon: () => React.ReactNode; prompt: string }[] = [
  {
    key: "keyframe",
    title: "A cinematic keyframe",
    desc: '"Ranger at forest edge at dawn, golden fog, match my character sheet."',
    icon: IcImage,
    prompt: "Make a dawn keyframe of my ranger at the forest edge — golden fog, brass compass, match my character sheet.",
  },
  {
    key: "music",
    title: "A music bed",
    desc: '"45-second ambient forest score, low brass drone, no percussion."',
    icon: IcMusic,
    prompt: "Score it — a 45-second ambient forest bed, low brass drone, no percussion.",
  },
  {
    key: "clip",
    title: "A short video clip",
    desc: '"Push in on the compass as the fog clears — 8 seconds, 24fps."',
    icon: IcPlay,
    prompt: "Turn the compass macro into an 8-second push-in as the fog clears, 24fps.",
  },
  {
    key: "sheet",
    title: "A character sheet",
    desc: '"Turnaround of my ranger — front, profile, 3/4, expressions."',
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
      </svg>
    ),
    prompt: "Build a character sheet for my ranger — front, profile, 3/4, and an expression row.",
  },
];

function Wave({ on }: { on: boolean }) {
  return (
    <div className="wave">
      {Array.from({ length: 48 }, (_, i) => (
        <i
          key={i}
          style={{ height: 6 + Math.abs(Math.cos(i * 0.5)) * 26, opacity: on ? 1 : 0, transition: "opacity .5s" }}
        />
      ))}
    </div>
  );
}

export default function ChatView({ ps }: { ps: PS }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [dropping, setDropping] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const psRef = useRef(ps);
  psRef.current = ps;

  useEffect(() => {
    const el = scroll.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  function addTurn(who: "user" | "ai", parts: Part[] = []): number {
    const id = nextId.current++;
    setTurns((t) => [...t, { id, who, parts }]);
    return id;
  }
  function addPart(turnId: number, part: Omit<Part, "id">): number {
    const id = nextId.current++;
    setTurns((t) => t.map((x) => (x.id === turnId ? { ...x, parts: [...x.parts, { ...part, id } as Part] } : x)));
    return id;
  }
  function patchPart(turnId: number, partId: number, patch: Partial<Part>) {
    setTurns((t) =>
      t.map((x) =>
        x.id === turnId
          ? { ...x, parts: x.parts.map((p) => (p.id === partId ? ({ ...p, ...patch } as Part) : p)) }
          : x,
      ),
    );
  }
  async function streamText(turnId: number, full: string) {
    const partId = addPart(turnId, { type: "text", text: "" } as Omit<Part, "id">);
    let acc = "";
    for (const w of full.split(" ")) {
      acc += (acc ? " " : "") + w;
      patchPart(turnId, partId, { text: acc } as Partial<Part>);
      await sleep(20);
    }
  }

  // Walk the user into a flow instead of guessing a one-shot job: the card
  // states what it needs, so an unfilled slot is a visible gap, not a failed job.
  async function openFlow(flow: Flow, intro?: string) {
    const aiTurn = addTurn("ai");
    await streamText(aiTurn, intro || `${flow.title}. ${flow.blurb}`);
    for (const line of flow.walkthrough) await streamText(aiTurn, line);
    addPart(aiTurn, { type: "flow", flowId: flow.id } as Omit<Part, "id">);
  }
  const openFlowRef = useRef(openFlow);
  openFlowRef.current = openFlow;

  async function openSkeleton() {
    const aiTurn = addTurn("ai");
    await streamText(aiTurn, "Video → skeleton. The pose comes out of real footage instead of being authored.");
    await streamText(aiTurn, "Drop a clip with one person in frame and pick the five seconds worth keeping.");
    await streamText(aiTurn, "It runs in your browser, so it costs nothing, and the take lands in your media store ready to drive a render.");
    addPart(aiTurn, { type: "skeleton" } as Omit<Part, "id">);
  }
  const openSkeletonRef = useRef(openSkeleton);
  openSkeletonRef.current = openSkeleton;

  async function fire(input: string) {
    const p = psRef.current;
    const t = (input || "").trim();
    if (!t || p.isBusy()) return;
    setText("");
    if (box.current) box.current.style.height = "auto";
    addTurn("user", [{ id: nextId.current++, type: "text", text: t }]);
    if (wantsSkeleton(t)) {
      await openSkeleton();
      return;
    }
    const wanted = matchFlow(t);
    if (wanted && flowIsLive(wanted, p.models)) {
      await openFlow(wanted, `That's a control flow, not a one-shot job — here's the card. ${wanted.blurb}`);
      return;
    }
    if (!p.apiKey) {
      const aiT = addTurn("ai");
      await streamText(aiT, "Add your sk-pioneer key in Settings first — I can't run jobs without it.");
      return;
    }
    p.setBusy(true);
    p.setAiState("thinking", true);
    const aiTurn = addTurn("ai");
    const started = Date.now();
    let jobPart = 0;
    let jobModel = "";
    let jobEndpoint = "";
    let runTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const mediaObjects = p.media?.objects || [];
      const plan = await requestJobPlan(p.apiKey, p.models, mediaObjects, t);
      if (plan.say) await streamText(aiTurn, plan.say);
      if (!plan.job) return;

      const { model, endpoint } = plan.job;
      jobModel = model;
      jobEndpoint = endpoint;
      const refs: MediaObject[] = plan.job.refs
        .map((k) => mediaObjects.find((o) => o.key === k || o.name === k))
        .filter((o): o is MediaObject => !!o);
      const params = injectRefs(endpoint, plan.job.params, refs);
      const cost = p.models.find((m) => m.model === model && m.endpoint === endpoint)?.credits ?? "?";
      const paramPairs = Object.entries(params)
        .filter(([k]) => k !== "prompt" && k !== "prompts" && k !== "lyrics")
        .map(([k, v]) => [k, Array.isArray(v) ? `${v.length}×` : String(v).slice(0, 34)] as [string, string]);
      if (typeof params.prompt === "string") paramPairs.unshift(["prompt", `${params.prompt.slice(0, 42)}…`]);
      addPart(aiTurn, {
        type: "plan",
        plan: { model, endpoint, params: paramPairs, refs: injectedRefs(endpoint, refs).map((r) => r.name), cost },
      } as Omit<Part, "id">);
      await sleep(500);

      const res = await submitJob(p.apiKey, model, endpoint, params);
      p.charge(res.credits_remaining);
      jobPart = addPart(aiTurn, {
        type: "job",
        job: { status: "queued", model, endpoint },
      } as Omit<Part, "id">);
      p.setAiState("running", true);
      runTimer = setTimeout(() => patchPart(aiTurn, jobPart, { job: { status: "running", model, endpoint } } as Partial<Part>), 3200);

      const { url, contentType } = await p.waitForJob(res.job_id);
      clearTimeout(runTimer);
      const kind = kindOf(contentType, url);
      patchPart(aiTurn, jobPart, { job: { status: "done", model, endpoint, url, kind } } as Partial<Part>);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      await streamText(
        aiTurn,
        `Done — ${res.credits_charged} cr, ${secs}s. Saved to Media with a public R2 URL — share it or feed it into the next job.`,
      );
    } catch (e: any) {
      clearTimeout(runTimer);
      const error = String(e.message || e);
      if (jobPart)
        patchPart(aiTurn, jobPart, {
          job: { status: "failed", model: jobModel, endpoint: jobEndpoint, error },
        } as Partial<Part>);
      await streamText(aiTurn, "That didn't work: " + error);
    } finally {
      p.setAiState("idle", false);
      p.setBusy(false);
    }
  }

  const fireRef = useRef(fire);
  fireRef.current = fire;

  useEffect(() => {
    ps.registerSuggestions("chat", [
      { label: "Video → skeleton", run: () => openSkeletonRef.current() },
      ...FLOWS.map((f) => ({ label: f.title, run: () => openFlowRef.current(f) })),
      { label: "Dawn keyframe of my ranger", run: () => fireRef.current(STARTERS[0].prompt) },
      { label: "Score it — 45s forest bed", run: () => fireRef.current(STARTERS[1].prompt) },
    ]);
    ps.setInputHandler("chat", (t) => fireRef.current(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onAttach(files: FileList) {
    const p = psRef.current;
    for (const f of Array.from(files)) {
      try {
        await uploadMedia(p.apiKey, f);
        p.toast(`${f.name} → R2 (content-addressed, deduped)`, "ok");
      } catch (e: any) {
        p.toast(String(e.message || e));
      }
    }
    p.refreshMedia();
    p.refreshCredits();
  }

  return (
    <div
      className={`chat-wrap${dropping ? " dropping" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false);
      }}
      onDrop={(e) => {
        // a card that handled the drop stopped propagation; anything reaching
        // here is meant for the media store
        e.preventDefault();
        setDropping(false);
        if (e.dataTransfer.files.length) onAttach(e.dataTransfer.files);
      }}
    >
      <div className="chat-scroll" id="chatScroll" ref={scroll}>
        <div className="chat-inner" id="chatInner">
          {turns.length === 0 && (
            <div className="chat-hero" id="chatHero">
              <img className="mark" src="/compass-icon.svg" alt="" />
              <h1>What are we making?</h1>
              <p>
                Describe it in plain language. I'll pick the model, set the parameters, wire up your references, and
                run the job — you just watch the result land.
              </p>
              <div className="starter-grid" id="starterGrid">
                {STARTERS.map((s) => (
                  <button key={s.key} type="button" className="starter" onClick={() => fire(s.prompt)}>
                    <div className="st-ic">
                      <s.icon />
                    </div>
                    <h4>{s.title}</h4>
                    <p>{s.desc}</p>
                  </button>
                ))}
              </div>
              <div className="flow-row">
                <span className="fr-label">…or run a control flow — drop files straight onto the card</span>
                <button type="button" className="fr-btn" onClick={() => openSkeleton()}>
                  Video → skeleton
                </button>
                {FLOWS.map((f) => (
                  <button key={f.id} type="button" className="fr-btn" disabled={!flowIsLive(f, ps.models)} onClick={() => openFlow(f)}>
                    {f.title}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((turn) => (
            <div key={turn.id} className={`turn ${turn.who}`}>
              <div className="avatar">{turn.who === "user" ? "YOU" : <IcSpark />}</div>
              <div className="body">
                <div className="name">{turn.who === "user" ? "You" : "Copilot"}</div>
                {turn.parts.map((part) => {
                  if (part.type === "text") return <p key={part.id}>{part.text}</p>;
                  if (part.type === "skeleton") return <SkeletonCard key={part.id} ps={ps} />;
                  if (part.type === "flow") {
                    const f = flowById(part.flowId);
                    return f ? <FlowCard key={part.id} flow={f} ps={ps} /> : null;
                  }
                  if (part.type === "plan") {
                    const pl = part.plan;
                    return (
                      <div key={part.id} className="plan-card">
                        <div className="plan-head">
                          <span className="p-ic">
                            <IcSpark />
                          </span>
                          <b>Job plan</b>
                          <span className="p-cost">est. {pl.cost} cr</span>
                        </div>
                        <div className="plan-rows">
                          <div className="plan-row">
                            <span className="k">Model</span>
                            <span className="v">
                              <span className="tag">{pl.model}</span>
                            </span>
                          </div>
                          <div className="plan-row">
                            <span className="k">Endpoint</span>
                            <span className="v mono">{pl.endpoint}</span>
                          </div>
                          <div className="plan-row">
                            <span className="k">Params</span>
                            <span className="v">
                              {pl.params.map(([k, v]) => (
                                <span key={k} className="tag">
                                  {k} {v}
                                </span>
                              ))}
                            </span>
                          </div>
                          <div className="plan-row">
                            <span className="k">References</span>
                            <span className="v">
                              {pl.refs.length ? (
                                pl.refs.map((r) => (
                                  <span key={r} className="ref">
                                    <IcImage /> {r}
                                  </span>
                                ))
                              ) : (
                                <span style={{ color: "var(--fg4)" }}>none</span>
                              )}
                            </span>
                          </div>
                        </div>
                        <div className="plan-foot">
                          <span style={{ fontSize: 11.5, color: "var(--fg3)" }}>Auto-selected from your prompt</span>
                          <span className="queued">
                            <span className="d" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--compass-400)" }} />
                            queued
                          </span>
                        </div>
                      </div>
                    );
                  }
                  const j = part.job;
                  return (
                    <div key={part.id} className={`chat-job${j.kind === "audio" ? " audio" : ""}`}>
                      <div className="cj-media">
                        {j.status === "done" && j.kind === "image" && <img className="cj-fill" src={j.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                        {j.status === "done" && j.kind === "video" && <video className="cj-fill" controls src={j.url} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                        {j.status === "done" && j.kind === "model" && <div className="cj-fill" style={{ display: "grid", placeItems: "center", color: "var(--accent)", font: "700 14px var(--mono)" }}>VRM · 3D character</div>}
                        {j.status === "done" && j.kind === "audio" && (
                          <>
                            <Wave on />
                            <audio controls src={j.url} style={{ position: "absolute", left: 8, right: 8, bottom: 8, width: "calc(100% - 16px)", height: 28 }} />
                          </>
                        )}
                        {(j.status === "queued" || j.status === "running") && (
                          <>
                            <div className="shimmer" />
                            <div className="cj-prog" style={{ width: j.status === "queued" ? "10%" : "60%" }} />
                          </>
                        )}
                      </div>
                      <div className="cj-bar">
                        <span className="cj-model">
                          {j.model} · {j.endpoint}
                        </span>
                        <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          {j.url && (
                            <button
                              type="button"
                              className="mini-btn copy-url"
                              onClick={() => {
                                navigator.clipboard.writeText(j.url!);
                                psRef.current.toast("R2 URL copied", "ok");
                              }}
                            >
                              <IcCopy /> URL
                            </button>
                          )}
                          <span className={`cj-status ${j.status === "failed" ? "queued" : j.status}`}>{j.status}</span>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="chat-composer">
        <div className="composer-box">
          <textarea
            id="chatBox"
            ref={box}
            rows={1}
            placeholder="Describe what you want to generate…"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 180) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                fire(text);
              }
            }}
          />
          <div className="composer-bar">
            <button type="button" className="attach-btn" onClick={() => fileInput.current?.click()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.49-8.49" />
              </svg>
              Reference
            </button>
            <span className="auto-note">
              <svg className="ic" viewBox="0 0 24 24" style={{ width: 13, height: 13, color: "var(--accent)" }}>
                <path d="M12 3l2.2 5.5L20 10l-5.8 1.5L12 17l-2.2-5.5L4 10l5.8-1.5z" />
              </svg>
              Copilot picks the model &amp; settings
            </span>
            <span className="grow" />
            <button type="button" className="send" id="chatSend" disabled={!text.trim()} onClick={() => fire(text)}>
              <IcSend />
            </button>
          </div>
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,audio/*,video/mp4,video/webm"
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files?.length) onAttach(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
