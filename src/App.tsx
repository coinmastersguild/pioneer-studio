import { useEffect, useRef, useState } from "react";
import "./shell.css";
import "./chat.css";
import "./board.css";
import "./studio.css";
import "./media.css";
import {
  closeProject,
  connectWallet,
  fetchAccount,
  fetchMedia,
  fetchModels,
  fetchResultUrl,
  fetchStoryboard,
  openProject,
  primeMetaMaskSession,
  pollJob,
  restoreActiveProject,
  setSyncErrorHandler,
  type JobModel,
  type ChatMessage,
  type MediaList,
  type Storyboard,
} from "./api";
import {
  GB,
  IcAnimate,
  IcBoard,
  IcCreate,
  IcChat,
  IcFolder,
  IcHead,
  IcImage,
  IcModels,
  IcSend,
  IcSettings,
  IcSpark,
  IcStudio,
  IcUsers,
  sleep,
  type Mode,
  type PS,
  type Suggestion,
} from "./shared";
import ChatView from "./ChatView";
import BoardView from "./BoardView";
import StudioView from "./StudioView";
import StageView from "./StageView";
import CreateView from "./CreateView";
import MediaView from "./MediaView";
import HeadView from "./HeadView";
import ModelIndexView from "./ModelIndexView";
import ProjectsView from "./ProjectsView";
import CompaniesView from "./CompaniesView";
import SettingsView from "./SettingsView";
import {
  beginStudioAgentTurn,
  continueStudioAgentTurn,
  executeStudioAction,
  type PreparedStudioAction,
  type StudioActionResult,
  type StudioAgentTurn,
} from "./studioAgent";
// Last import wins the cascade — the narrow-viewport layer has to override
// every view sheet above, including the ones the view modules pull in.
import "./mobile.css";

type ThreadItem = { id: number; kind: "user" | "ai"; text: string };
type Toast = { id: number; msg: string; kind?: "ok" | "gold"; out?: boolean };
type PendingAgentTurn = { turn: StudioAgentTurn; completed: StudioActionResult[]; actions: PreparedStudioAction[] };

const MODE_LABEL: Record<Mode, string> = { chat: "chat", board: "storyboard", create: "create", animate: "animation", head: "talking head", studio: "studio", media: "media", models: "models", projects: "projects", companies: "companies", settings: "settings" };

// Mirrors the breakpoint in mobile.css. Below it the copilot is an overlay
// sheet instead of a third column, so it is reachable from every mode — but it
// starts closed, since open it covers the work area it is meant to act on.
const NARROW = "(max-width: 860px)";
function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

function App() {
  const [apiKey, setApiKey] = useState("");
  const [wallet, setWallet] = useState(() => localStorage.getItem("pioneer_studio_wallet") || "");
  const [mode, setMode] = useState<Mode>("chat");
  const [models, setModels] = useState<JobModel[]>([]);
  const [media, setMedia] = useState<MediaList | null>(null);
  const [board, setBoard] = useState<Storyboard | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [creditFlash, setCreditFlash] = useState(false);
  const narrow = useNarrow();
  const [copilotOpen, setCopilotOpen] = useState(() => !window.matchMedia(NARROW).matches);
  const [thread, setThread] = useState<ThreadItem[]>([
    {
      id: 0,
      kind: "ai",
      text: "I run the studio for you across every mode. In Chat I pick the model and fire jobs from a sentence. In Storyboard I build the sequence and render every beat. In Studio I drive the editor while you watch — you can take the wheel any time.",
    },
  ]);
  const [aiState, setAiStateRaw] = useState({ label: "idle", working: false });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [suggestions, setSuggestions] = useState<Record<Mode, Suggestion[]>>({
    chat: [],
    board: [],
    create: [],
    animate: [],
    head: [],
    studio: [],
    media: [],
    models: [],
    projects: [],
    companies: [],
    settings: [],
  });
  const [chatText, setChatText] = useState("");
  const [pendingAgent, setPendingAgent] = useState<PendingAgentTurn | null>(null);

  const busyRef = useRef(false);
  const nextId = useRef(1);
  const flashHandle = useRef(0);
  const threadEl = useRef<HTMLDivElement>(null);
  const inputHandlers = useRef<Partial<Record<Mode, (text: string) => void>>>({});
  const apiKeyRef = useRef(apiKey);
  const agentHistoryRef = useRef<ChatMessage[]>([]);
  apiKeyRef.current = apiKey;
  // Deep link: /?project=<id> opens that specific project and lands on the
  // storyboard. Wins over the localStorage restore below; kept in a ref so it
  // only fires until it succeeds (Settings writes apiKey on every keystroke).
  const deepLinkedProject = useRef(new URLSearchParams(location.search).get("project"));

  // Purge credentials persisted by older builds. Credentials now stay only in
  // React memory and disappear on reload or sign-out. The wallet address is
  // public and may remain remembered.
  useEffect(() => {
    localStorage.removeItem("pioneer_studio_api_key");
    sessionStorage.removeItem("pioneer_studio_api_key");
  }, []);

  // Invite link (/?join=<companyAddress>) opens the Companies page, which
  // handles the actual join request once a credential is present.
  useEffect(() => {
    if (new URLSearchParams(location.search).get("join")) setMode("companies");
  }, []);

  // No-op unless this is a mobile browser without an injected provider; there
  // it opens the MetaMask session up front so Connect is ready on first tap.
  useEffect(() => {
    primeMetaMaskSession();
  }, []);

  useEffect(() => {
    refreshBoard();
    if (!apiKey) return;
    // debounced — the Settings key input writes here on every keystroke
    const t = setTimeout(() => {
      fetchModels(apiKey).then((r) => setModels(r.jobs)).catch(() => {});
      refreshCredits();
      refreshMedia();
      // ?project=<id> deep link wins; else re-open the project that was active
      // before the reload — otherwise edits silently fork into the local doc
      const pid = deepLinkedProject.current;
      if (pid) {
        openProject(apiKey, pid)
          .then(() => {
            deepLinkedProject.current = null;
            refreshBoard();
            setMode("board");
          })
          .catch(() => restoreActiveProject(apiKey).then((r) => r && refreshBoard()));
      } else {
        restoreActiveProject(apiKey).then((restored) => {
          if (restored) refreshBoard();
        });
      }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // project-mirror save failures surface as toasts instead of vanishing
  useEffect(() => {
    setSyncErrorHandler((msg) => toast(msg));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = threadEl.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread]);

  function refreshCredits() {
    if (!apiKeyRef.current) return;
    fetchAccount(apiKeyRef.current)
      .then((acc) => {
        const c = acc.credits ?? acc.balance ?? acc.credits_remaining;
        if (typeof c === "number") setCredits(c);
      })
      .catch(() => {});
  }
  function refreshMedia() {
    if (!apiKeyRef.current) return;
    fetchMedia(apiKeyRef.current).then(setMedia).catch(() => {});
  }
  function refreshBoard() {
    // storyboard doc is local-first — no key needed to read it
    fetchStoryboard(apiKeyRef.current).then(setBoard).catch(() => {});
  }

  function charge(remaining: number | null) {
    if (typeof remaining === "number") setCredits(remaining);
    else refreshCredits();
    setCreditFlash(true);
    clearTimeout(flashHandle.current);
    flashHandle.current = window.setTimeout(() => setCreditFlash(false), 900);
  }

  function toast(msg: string, kind?: "ok" | "gold") {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.map((x) => (x.id === id ? { ...x, out: true } : x))), 2400);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2750);
  }

  async function onConnectWallet() {
    try {
      const { token, address } = await connectWallet();
      setApiKey(token);
      setWallet(address);
      localStorage.setItem("pioneer_studio_wallet", address);
      toast(`Wallet connected · ${address.slice(0, 6)}…${address.slice(-4)}`, "gold");
    } catch (e: any) {
      toast(String(e.message || e));
    }
  }

  function signOut() {
    setApiKey("");
    setWallet("");
    localStorage.removeItem("pioneer_studio_wallet");
    // an open cloud project holds the old key — keep syncing and the next
    // person's edits would land in the signed-out account's project
    closeProject();
    refreshBoard();
  }

  /* ── copilot rail thread ── */
  function addMsg(who: "You" | "Copilot", text: string) {
    setThread((t) => [...t, { id: nextId.current++, kind: who === "You" ? "user" : "ai", text }]);
  }
  async function streamMsg(text: string) {
    const id = nextId.current++;
    setThread((t) => [...t, { id, kind: "ai", text: "" }]);
    let acc = "";
    for (const w of text.split(" ")) {
      acc += (acc ? " " : "") + w;
      const part = acc;
      setThread((t) => t.map((m) => (m.id === id ? { ...m, text: part } : m)));
      await sleep(24);
    }
  }
  async function waitForJob(jobId: string): Promise<{ url: string; contentType: string }> {
    const key = apiKeyRef.current;
    // Backoff, not a flat 3s. The old loop slept 3000ms *before* its first poll,
    // so even a job that finished in 1.9s (a short TTS line) could not be
    // observed done until t+3s — pure dead air on every fast job in the app.
    // Start tight and ramp: fast jobs return immediately, slow renders settle
    // back to the same 3s cadence and poll no harder than before.
    let wait = 400;
    for (;;) {
      await sleep(wait);
      wait = Math.min(3000, wait * 1.6);
      const s = await pollJob(key, jobId);
      if (s.status === "done") {
        const r = await fetchResultUrl(key, jobId);
        refreshMedia(); // format=url stored the result to R2
        refreshCredits();
        return r;
      }
      if (s.status === "error" || s.status === "failed") throw new Error(s.error || s.status);
    }
  }

  const ps: PS = {
    apiKey,
    models,
    media,
    refreshMedia,
    board,
    setBoard,
    refreshBoard,
    mode,
    setMode,
    charge,
    refreshCredits,
    toast,
    addMsg,
    streamMsg,
    setAiState: (label, working) => setAiStateRaw({ label, working }),
    registerSuggestions: (m, arr) => setSuggestions((s) => ({ ...s, [m]: arr })),
    setInputHandler: (m, fn) => {
      inputHandlers.current[m] = fn;
    },
    isBusy: () => busyRef.current,
    setBusy: (b) => {
      busyRef.current = b;
    },
    waitForJob,
  };

  function rememberAgentTurn(turn: StudioAgentTurn) {
    agentHistoryRef.current = [...turn.messages.filter((message) => message.role !== "system"), turn.assistant].slice(-30);
  }

  async function runAgentLoop(initial: StudioAgentTurn) {
    let turn = initial;
    for (let round = 0; round < 8; round++) {
      if (!turn.actions.length) {
        rememberAgentTurn(turn);
        await streamMsg(turn.assistant.content || "Done.");
        return;
      }
      setAiStateRaw({ label: `running ${turn.actions.length} action${turn.actions.length === 1 ? "" : "s"}`, working: true });
      const safe = turn.actions.filter((action) => !action.confirmation);
      const guarded = turn.actions.filter((action) => !!action.confirmation);
      const completed: StudioActionResult[] = [];
      for (const action of safe) completed.push(await executeStudioAction(action));
      if (guarded.length) {
        setPendingAgent({ turn, completed, actions: guarded });
        addMsg(
          "Copilot",
          `Ready to ${guarded.map((action) => action.actionName).join(", ")}. ${guarded.map((action) => action.confirmation).join("; ")}. Confirm below to continue.`,
        );
        return;
      }
      const ordered = turn.actions
        .map((action) => completed.find((result) => result.action.call.id === action.call.id))
        .filter((result): result is StudioActionResult => !!result);
      turn = await continueStudioAgentTurn(apiKeyRef.current, turn, ordered);
    }
    rememberAgentTurn(turn);
    await streamMsg("I stopped after eight action rounds so the Studio stays under your control. You can ask me to continue.");
  }

  async function sendCopilot() {
    const v = chatText.trim();
    if (!v || busyRef.current || pendingAgent) return;
    setChatText("");
    // ChatView is still the generation planner. Everywhere else the rail is a
    // real tool-calling copilot over the shared action registry.
    if (mode === "chat") return inputHandlers.current.chat?.(v);
    addMsg("You", v);
    busyRef.current = true;
    setAiStateRaw({ label: "planning", working: true });
    try {
      const turn = await beginStudioAgentTurn(apiKeyRef.current, v, {
        mode,
        board,
        media,
        history: agentHistoryRef.current,
      });
      await runAgentLoop(turn);
    } catch (error: any) {
      addMsg("Copilot", `I couldn't run that: ${String(error?.message || error)}`);
    } finally {
      busyRef.current = false;
      setAiStateRaw({ label: "idle", working: false });
    }
  }

  async function confirmAgentActions() {
    const pending = pendingAgent;
    if (!pending || busyRef.current) return;
    setPendingAgent(null);
    busyRef.current = true;
    setAiStateRaw({ label: "running actions", working: true });
    try {
      const results = [...pending.completed];
      for (const action of pending.actions) results.push(await executeStudioAction(action));
      const ordered = pending.turn.actions
        .map((action) => results.find((result) => result.action.call.id === action.call.id))
        .filter((result): result is StudioActionResult => !!result);
      const next = await continueStudioAgentTurn(apiKeyRef.current, pending.turn, ordered);
      await runAgentLoop(next);
    } catch (error: any) {
      addMsg("Copilot", `The confirmed action failed: ${String(error?.message || error)}`);
    } finally {
      busyRef.current = false;
      setAiStateRaw({ label: "idle", working: false });
    }
  }

  const usedGb = (media?.total_bytes || 0) / GB;
  const mediaCount = media?.objects.length || 0;

  const modeBtns: { m: Mode; label: string; icon: () => React.ReactNode }[] = [
    { m: "chat", label: "Chat", icon: IcChat },
    { m: "board", label: "Storyboard", icon: IcBoard },
    { m: "create", label: "Create", icon: IcCreate },
    // Head sits before Animation: you design and cast a character (Create),
    // give it a voice and face (Head), then stage and move it (Animation).
    // Left-to-right is the order of the work.
    { m: "head", label: "Head", icon: IcHead },
    { m: "animate", label: "Animation", icon: IcAnimate },
    { m: "studio", label: "Studio", icon: IcStudio },
  ];

  // Nothing in the studio works without a key: every view calls the API, and
  // without one they each failed separately and late — a mic opened, a job was
  // composed, and only then did "Add your Pioneer key in Settings first" appear.
  // Gate once, up front, instead of apologising per-feature.
  if (!apiKey) {
    return (
      <div className="gate">
        <a className="fork-corner" href="https://github.com/coinmastersguild/pioneer-studio/fork" target="_blank" rel="noreferrer" aria-label="Fork Pioneer Studio on GitHub">
          Fork me
        </a>
        <div className="gate-card">
          <div className="brand">
            <img src="/compass-icon.svg" alt="" /> Pioneer <span className="sub">Studio</span>
          </div>
          <p className="gate-lede">Storyboards, 3D cutscenes and talking characters, rendered on Pioneer's GPUs.</p>
          <button type="button" className="gate-connect" onClick={onConnectWallet}>
            Connect wallet
          </button>
          <p className="gate-note">Signs a challenge in your wallet — no password, nothing uploaded.</p>
          <div className="gate-or">or paste a key</div>
          <input
            type="password"
            className="gate-key"
            placeholder="sk-pioneer-…"
            autoComplete="off"
            onChange={(e) => setApiKey(e.target.value.trim())}
          />
          <p className="gate-note">
            No key? Mint one at <b>alpha.pioneers.dev/keys</b>.
          </p>
        </div>
        <div className="toaster">
          {toasts.map((t) => (
            <div key={t.id} className={`toast${t.kind ? " " + t.kind : ""}${t.out ? " out" : ""}`}>
              {t.msg}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`shell${(mode === "studio" || narrow) && copilotOpen ? "" : " copilot-collapsed"}`} id="shell">
      <a className="fork-corner" href="https://github.com/coinmastersguild/pioneer-studio/fork" target="_blank" rel="noreferrer" aria-label="Fork Pioneer Studio on GitHub">
        Fork me
      </a>
      {/* TOPBAR */}
      <div className="topbar">
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <div className="brand">
            <img src="/compass-icon.svg" alt="" /> Pioneer <span className="sub">Studio</span>
          </div>
          <div className="modes" id="modes">
            {modeBtns.map(({ m, label, icon: Icon }) => (
              <button key={m} type="button" className={`mode${mode === m ? " active" : ""}`} onClick={() => setMode(m)}>
                <Icon />
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="topbar-right">
          <div className="pill">
            <span className="lbl">Credits</span> <b className={creditFlash ? "spent" : ""}>{credits === null ? "—" : credits.toLocaleString()}</b>
          </div>
          <div className="pill">
            <span className="lbl">R2</span> <span>{usedGb.toFixed(2)}</span> GB
          </div>
          <button type="button" className={`pill${wallet ? " on" : ""}`} onClick={onConnectWallet} title="Sign in with your wallet (challenge → sign → JWT)">
            <span className="lbl">Wallet</span>
            <b>{wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "Connect"}</b>
          </button>
          {!apiKey && (
            <button type="button" className="pill" onClick={() => setMode("settings")} title="Add your sk-pioneer key in Settings">
              <span className="lbl">Key</span>
              <b>Add key →</b>
            </button>
          )}
          {(mode === "studio" || narrow) && (
            <button
              type="button"
              className={`icon-btn${copilotOpen ? " on" : ""}`}
              title="Toggle copilot"
              onClick={() => setCopilotOpen((o) => !o)}
            >
              <svg className="ic" viewBox="0 0 24 24"><path d="M12 3l2.2 5.5L20 10l-5.8 1.5L12 17l-2.2-5.5L4 10l5.8-1.5z" /></svg>
            </button>
          )}
        </div>
      </div>

      {/* LEFT RAIL */}
      <div className="rail" id="rail">
        {modeBtns.map(({ m, label, icon: Icon }) => (
          <div key={m} className={`rail-btn${mode === m ? " active" : ""}`} data-mode={m} onClick={() => setMode(m)}>
            <Icon />
            <span className="rb-label">{label}</span>
          </div>
        ))}
        <div className="rail-sep" />
        <div className={`rail-btn${mode === "media" ? " active" : ""}`} data-mode="media" onClick={() => setMode("media")}>
          <IcImage />
          <span className="rb-label">Media{mediaCount ? ` · ${mediaCount}` : ""}</span>
        </div>
        <div className={`rail-btn${mode === "models" ? " active" : ""}`} data-mode="models" onClick={() => setMode("models")}>
          <IcModels />
          <span className="rb-label">Models{models.length ? ` · ${models.length}` : ""}</span>
        </div>
        <div className={`rail-btn${mode === "projects" ? " active" : ""}`} data-mode="projects" onClick={() => setMode("projects")}>
          <IcFolder />
          <span className="rb-label">Projects</span>
        </div>
        <div className={`rail-btn${mode === "companies" ? " active" : ""}`} data-mode="companies" onClick={() => setMode("companies")}>
          <IcUsers />
          <span className="rb-label">Companies</span>
        </div>
        <div className="grow" />
        <div className={`rail-btn${mode === "settings" ? " active" : ""}`} data-mode="settings" onClick={() => setMode("settings")}>
          <IcSettings />
          <span className="rb-label">Settings</span>
        </div>
      </div>

      {/* WORK AREA — all views stay mounted so jobs keep polling across modes */}
      <div className="work">
        <div className={`view${mode === "chat" ? " active" : ""}`} id="view-chat">
          <ChatView ps={ps} />
        </div>
        <div className={`view${mode === "board" ? " active" : ""}`} id="view-board">
          <BoardView ps={ps} />
        </div>
        <div className={`view${mode === "create" ? " active" : ""}`} id="view-create">
          <CreateView ps={ps} />
        </div>
        <div className={`view${mode === "animate" ? " active" : ""}`} id="view-animate">
          <StageView ps={ps} active={mode === "animate"} />
        </div>
        <div className={`view${mode === "head" ? " active" : ""}`} id="view-head">
          <HeadView ps={ps} active={mode === "head"} />
        </div>
        <div className={`view${mode === "studio" ? " active" : ""}`} id="view-studio">
          <StudioView ps={ps} />
        </div>
        <div className={`view${mode === "media" ? " active" : ""}`} id="view-media">
          <MediaView ps={ps} />
        </div>
        <div className={`view${mode === "models" ? " active" : ""}`} id="view-models">
          <ModelIndexView ps={ps} />
        </div>
        <div className={`view${mode === "projects" ? " active" : ""}`} id="view-projects">
          <ProjectsView ps={ps} />
        </div>
        <div className={`view${mode === "companies" ? " active" : ""}`} id="view-companies">
          <CompaniesView ps={ps} />
        </div>
        <div className={`view${mode === "settings" ? " active" : ""}`} id="view-settings">
          <SettingsView ps={ps} auth={{ apiKey, setApiKey, wallet, onConnectWallet, signOut, credits, usedGb, mediaCount }} />
        </div>
      </div>

      {/* COPILOT RAIL */}
      <div className="copilot" id="copilot">
        <div className="copilot-head">
          <div className={`status-dot${aiState.working ? " working" : ""}`} id="aiDot" />
          <h3>Copilot</h3>
          <span className="ctx" id="aiCtx">{MODE_LABEL[mode]}</span>
          <span className="cap" id="aiState">{aiState.label}</span>
        </div>
        <div className="thread" id="thread" ref={threadEl}>
          {thread.map((m) => (
            <div key={m.id} className={`msg ${m.kind === "user" ? "user" : "ai"}`}>
              <div className="who">{m.kind === "user" ? "You" : "Copilot"}</div>
              <div className="bubble">{m.text}</div>
            </div>
          ))}
        </div>
        <div className="copilot-foot">
          <div className="suggestions" id="suggestions">
            {suggestions[mode].map((s, i) => (
              <button key={i} type="button" className="sugg" onClick={() => s.run()}>
                <span className="arr">→</span>
                {s.label}
              </button>
            ))}
          </div>
          {pendingAgent && (
            <div className="copilot-confirm">
              <b>Confirmation required</b>
              <span>{pendingAgent.actions.map((action) => action.confirmation).join(" · ")}</span>
              <div>
                <button type="button" onClick={() => { setPendingAgent(null); addMsg("Copilot", "Cancelled the guarded action — no credits were spent and nothing was removed."); }}>Cancel</button>
                <button type="button" className="confirm" onClick={() => void confirmAgentActions()}>Confirm action</button>
              </div>
            </div>
          )}
          <div className="chat-input">
            <input
              id="copilotInput"
              type="text"
              placeholder="Tell the copilot what to do…"
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void sendCopilot();
              }}
            />
            <button type="button" className="send-btn" onClick={() => void sendCopilot()}>
              <span style={{ display: "grid", placeItems: "center", width: 13, height: 13 }}>
                <IcSend />
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* TOASTER */}
      <div className="toaster" id="toaster">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.kind === "gold" ? " gold" : ""}${t.out ? " out" : ""}`}>
            {t.kind === "ok" ? (
              <svg className="ic" viewBox="0 0 24 24" style={{ strokeWidth: 2 }}><path d="M20 6L9 17l-5-5" /></svg>
            ) : (
              <IcSpark />
            )}
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
