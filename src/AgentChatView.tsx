import { useEffect, useRef, useState } from "react";
import { AgentApiError, agentMutation, agentRequest, fetchAccount, openAgentDesktop, downloadAgentFile, streamAgentMessage, unlockAgent, validateAgentPath, writeAgentFile,
  type AgentConnection, type AgentConnectionCapabilities, type AgentCatalog, type AgentOperationResult, type AgentUsage, type HostedAgent } from "./api";
import { agentIntentStorageKey, canReplayAgentIntent, loadAgentIntents, loadAgentSetup, saveAgentSetup, selectVisibleAgent, pendingIntentSummary, newAgentIntent, parseAgentCommand, saveAgentIntents, type AgentIntent } from "./hostedAgents";
import type { PS } from "./shared";
import AgentConnections from "./AgentConnections";
import { agentDesktopReady, desktopSocket, unlockKey, type DesktopSocket } from "./agentRuntime";
import AgentDesktop from "./AgentDesktop";
import AgentWorkspace from "./AgentWorkspace";
import AgentMemoryPanel from "./AgentMemoryPanel";
import { inspectAgentTurnRecovery, confirmAgentTurnRecovery } from "./agentTurnRecovery";
import { AgentConversations, desktopRuntimeChanged, desktopRuntimeUnavailable, type DesktopRuntimeBinding } from "./agentConversation";
import { canEditWorkspaceFile, workspaceText, type AgentFileArea } from "./agentWorkspaceFiles";
import { connectionReturn, connectionAvailabilityError, verifyAgentGithubSetup, connectionCapabilitiesMessage, agentRequiresGithub, agentGithubReady } from "./agentConnectionState";
import { agentReplyPlaceholder, observeAgentReply, type AgentReplyState } from "./agentReply";
import "./agentChat.css";

type Entry = { id: string; role: "user" | "agent" | "studio"; text: string; replyState?: AgentReplyState };
const EMPTY_ENTRIES: Entry[] = [];
type Editor = { path: string; content: string; agentId: string; area: AgentFileArea };
type Confirmation = { title: string; detail: string; restoreText?: string; confirmLabel?: string; run: () => Promise<void> };

export default function AgentChatView({ ps, active = true }: { ps: PS; active?: boolean }) {
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null);
  const [agents, setAgents] = useState<HostedAgent[]>([]);
  const [selected, setSelected] = useState("");
  const [transcripts, setTranscripts] = useState<Record<string, Entry[]>>({});
  const entries = transcripts[selected] || EMPTY_ENTRIES;
  function setEntries(update: Entry[] | ((previous: Entry[]) => Entry[])) {
    setTranscripts((previous) => ({ ...previous, [selected]: typeof update === "function" ? update(previous[selected] || []) : update }));
  }
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [create, setCreate] = useState(false);
  const [name, setName] = useState("My agent");
  const [credits, setCredits] = useState(10);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [intents, setIntents] = useState<AgentIntent[]>([]);
  const [storageKey, setStorageKey] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesPath, setFilesPath] = useState("");
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [liveAvailable, setLiveAvailable] = useState(true);
  const [retryUntil, setRetryUntil] = useState(0);
  const [usage, setUsage] = useState<AgentUsage[] | null>(null);
  const [followingLogs, setFollowingLogs] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [monitorError, setMonitorError] = useState("");
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockDraft, setUnlockDraft] = useState("");
  const [desktop, setDesktop] = useState<DesktopSocket | null>(null);
  const desktopBinding = useRef<DesktopRuntimeBinding | null>(null);
  const desktopOpen = desktop !== null;
  const [desktopBusy, setDesktopBusy] = useState(false);
  const desktopController = useRef<AbortController | null>(null);
  const [connectionFocus, setConnectionFocus] = useState(0);
  const connectionPanel = useRef<HTMLDivElement>(null);
  const [requiredSetup, setRequiredSetup] = useState<string[]>([]);
  const requiredSetupRef = useRef(requiredSetup); requiredSetupRef.current = requiredSetup;
  const [setupConnection, setSetupConnection] = useState<AgentConnection | null>(null);
  const [githubAvailable, setGithubAvailable] = useState(false);
  const [githubAvailability, setGithubAvailability] = useState("Checking GitHub setup availability…");
  const [listObservedAt, setListObservedAt] = useState<number | null>(null);
  const [listError, setListError] = useState("");
  const [ownerAddress, setOwnerAddress] = useState("");
  const callback = useRef(connectionReturn(window.location.href));
  const authSession = useRef({ credential: ps.apiKey, id: crypto.randomUUID() });
  if (authSession.current.credential !== ps.apiKey) authSession.current = { credential: ps.apiKey, id: crypto.randomUUID() };
  const [, tick] = useState(0);
  const conversations = useRef(new AgentConversations());
  const activeKey = useRef(ps.apiKey);
  const controller = useRef<AbortController | null>(null);
  const working = useRef(false);
  const intentsRef = useRef(intents);
  intentsRef.current = intents;
  const scroll = useRef<HTMLDivElement>(null);
  const agent = agents.find((a) => a.id === selected);
  const pending = intents.length > 0 || !!agent?.pending_operation_id;
  const setupRequired = !!agent && agentRequiresGithub(agent, requiredSetup);
  const setupReady = !!agent && agentGithubReady(agent, setupConnection);
  const claimsReady = githubAvailable && catalog?.setup_required === true && !!catalog.templates?.includes("openhuman");
  const features = catalog?.features || {};
  const runtimeReady = !!agent && agent.status === "running" && !pending && (!setupRequired || setupReady);
  const desktopReady = agentDesktopReady(agent, pending, !setupRequired || setupReady);

  function say(text: string, role: Entry["role"] = "studio") {
    setEntries((prev) => [...prev, { id: crypto.randomUUID(), role, text }]);
  }
  function openConnections() {
    setConnectionsOpen(true); setConnectionFocus((value) => value + 1);
  }
  function report(e: unknown) {
    if (e instanceof AgentApiError && e.code === "github_setup_required") setConnectionsOpen(true);
    const message = e instanceof Error ? e.message : "Agent request failed";
    const guidance = e instanceof AgentApiError ? ({
      budget_exhausted: " Add budget with /topup, then resume if suspended.",
      not_running: " Use /resume when suspended; check /status while starting.",
      operation_pending: " Reconcile the pending operation before starting new work.",
      agent_unavailable: " Runtime, tool or inference work may have failed. Check status, files and logs before sending another task.",
      capability_unavailable: " This capability is unavailable. Use the agent's available local browser, Blender or file tools; do not configure a hosted provider key.",
      insufficient_credits: " Add account credits on alpha before purchasing.",
      idempotency_expired: " Operator reconciliation is required. Do not repurchase this intent.",
      github_setup_required: " Complete or repair GitHub setup, then explicitly resend the task.",
      github_setup_unavailable: " Alpha GitHub setup is unavailable; no new claim should be started.",
    }[e.code] || "") : "";
    setError(message + guidance);
    if (e instanceof AgentApiError && e.retryAfter !== null) setRetryUntil(Date.now() + e.retryAfter * 1000);
  }
  async function guarded(run: (key: string, signal: AbortSignal) => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    const key = ps.apiKey;
    const abort = new AbortController(); controller.current = abort;
    try { await run(key, abort.signal); }
    catch (e) { if (activeKey.current === key && !abort.signal.aborted) report(e); }
    finally {
      if (activeKey.current === key) { working.current = false; setBusy(false); }
    }
  }
  function keepIntents(next: AgentIntent[]) {
    if (!storageKey) throw new Error("Durable operation storage is unavailable; purchases are disabled.");
    saveAgentIntents(storageKey, next); intentsRef.current = next; setIntents(next);
  }
  async function refresh(key: string, signal?: AbortSignal) {
    let list: { agents: HostedAgent[]; live_available: boolean };
    try { list = await agentRequest(key, "", { signal }); }
    catch (e) {
      if (activeKey.current === key && !signal?.aborted) setListError("Agent list refresh failed; retaining the last list. Check your signed-in account and retry.");
      throw e;
    }
    if (activeKey.current !== key || signal?.aborted) return;
    setAgents(list.agents); setLiveAvailable(list.live_available); setListObservedAt(Date.now()); setListError("");
    setSelected((id) => selectVisibleAgent(list.agents, id, callback.current?.agentId));
  }
  async function settle(result: AgentOperationResult, intent: AgentIntent, key: string) {
    if (activeKey.current !== key) return;
    // Preserve the confirmed agent even if the following list request is offline.
    setAgents((old) => old.some((a) => a.id === result.agent.id)
      ? old.map((a) => a.id === result.agent.id ? result.agent : a) : [...old, result.agent]);
    const claimed = intent.method === "POST" && intent.suffix === "" && result.operation.state !== "failed";
    if (claimed) {
      const required = [...new Set([...requiredSetupRef.current, result.agent.id])];
      if (result.agent.setup_required === undefined) {
        saveAgentSetup(storageKey, required); requiredSetupRef.current = required; setRequiredSetup(required);
      }
      if (result.operation.state !== "pending") setConnectionsOpen(true);
    }
    if (result.operation.state === "pending") {
      keepIntents(intentsRef.current.map((i) => i.key === intent.key ? { ...i, operationId: result.operation.id } : i).concat(
        intentsRef.current.some((i) => i.key === intent.key) ? [] : [{ ...intent, operationId: result.operation.id }]));
      say(result.operation.reconciliation_required ? "Operation pending; operator reconciliation is required. Credits remain reserved." : "Operation pending; monitoring progress. Credits remain reserved.");
    } else {
      keepIntents(intentsRef.current.filter((i) => i.key !== intent.key));
      say(result.operation.state === "failed" ? `Operation failed (${result.operation.error_code || "unknown"}).${result.operation.refunded === undefined ? "" : ` Refunded: ${result.operation.refunded} credits.`}` : `${result.operation.kind} completed.`);
    }
    setSelected(result.agent.status === "deleted" ? "" : result.agent.id);
    // Purchase settlement is authoritative even if the separate list refresh fails.
    await refresh(key).catch(() => {}); ps.refreshCredits();
  }
  async function execute(intent: AgentIntent, key: string) {
    if (!canReplayAgentIntent(intent)) throw new Error("This intent exceeded its replay window. Operator reconciliation is required.");
    // Write the exact body/key before dispatch, including on the first attempt.
    keepIntents(intentsRef.current.some((i) => i.key === intent.key) ? intentsRef.current : [...intentsRef.current, intent]);
    const result = await agentMutation(key, intent.suffix, intent.method, intent.body, intent.key);
    await settle(result, intent, key);
  }
  useEffect(() => {
    activeKey.current = ps.apiKey;
    controller.current?.abort(); working.current = false;
    setBusy(false); setTranscripts({}); setEditor(null); setConfirmation(null); setIntents([]); setStorageKey("");
    setCatalog(null); setAgents([]); setSelected(""); setFilesOpen(false); setMemoryOpen(false); setError(""); setCreate(false); setInput("");
    setUsage(null); setLogs([]); setFollowingLogs(false); setMonitorError(""); setRetryUntil(0);
    setConnectionsOpen(!!callback.current); setRequiredSetup([]); requiredSetupRef.current = [];
    setSetupConnection(null); setGithubAvailable(false); setGithubAvailability("Checking GitHub setup availability…");
    setListObservedAt(null); setListError(""); setOwnerAddress("");
    setUnlockOpen(false); setUnlockDraft(""); setDesktop(null);
    conversations.current = new AgentConversations();
    const key = ps.apiKey; const abort = new AbortController();
    void (async () => {
      try {
        // Discovery must not depend on pricing, funding or local recovery storage.
        const [discovery, catalogResult, accountResult] = await Promise.allSettled([
          refresh(key, abort.signal), agentRequest<AgentCatalog>(key, "/catalog", { signal: abort.signal }), fetchAccount(key),
        ]);
        if (abort.signal.aborted) return;
        if (discovery.status === "rejected") report(discovery.reason);
        if (catalogResult.status === "rejected") throw catalogResult.reason;
        if (accountResult.status === "rejected") throw accountResult.reason;
        const cat = catalogResult.value; setCatalog(cat);
        setOwnerAddress(String(accountResult.value.address || ""));
        const sk = agentIntentStorageKey(String(accountResult.value.address || ""), cat.network);
        const saved = loadAgentIntents(sk), setup = loadAgentSetup(sk);
        saveAgentIntents(sk, saved); saveAgentSetup(sk, setup);
        setStorageKey(sk); setIntents(saved); setRequiredSetup(setup); requiredSetupRef.current = setup;
      } catch (e) { if (!abort.signal.aborted) report(e); }
    })();
    return () => { abort.abort(); controller.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ps.apiKey]);
  useEffect(() => {
    const key = ps.apiKey; const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>; setSetupConnection(null);
    async function pollSetup() {
      let delay = 10000;
      let capabilityAvailable = false;
      try {
        const caps = await agentRequest<AgentConnectionCapabilities>(key, "/connections/capabilities", { signal: abort.signal });
        if (abort.signal.aborted) return;
        capabilityAvailable = caps.github_read;
        setGithubAvailable(caps.github_read);
        setGithubAvailability(connectionCapabilitiesMessage(caps));
        if (caps.github_read) {
          const latestCatalog = await agentRequest<AgentCatalog>(key, "/catalog", { signal: abort.signal });
          if (!abort.signal.aborted) setCatalog(latestCatalog);
        }
        if ((setupRequired || desktopOpen) && selected && caps.github_read) {
          const state = await agentRequest<AgentConnection>(key, `/${selected}/connections`, { signal: abort.signal });
          if (!abort.signal.aborted) setSetupConnection(state);
        } else setSetupConnection(null);
      } catch (e) {
        if (abort.signal.aborted) return;
        setGithubAvailable(capabilityAvailable); setSetupConnection(null);
        setGithubAvailability(capabilityAvailable ? "This agent's GitHub verification is unavailable. Refresh connection state." : connectionAvailabilityError(e instanceof AgentApiError ? e.code : "unavailable"));
        delay = e instanceof AgentApiError && e.retryAfter !== null ? Math.max(10000, e.retryAfter * 1000) : 30000;
      }
      if (!abort.signal.aborted) timer = setTimeout(pollSetup, delay);
    }
    void pollSetup();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [ps.apiKey, selected, setupRequired, desktopOpen]);

  async function verifyRequiredSetup(key: string, id: string, signal: AbortSignal) {
    const detail = await agentRequest<{ agent: HostedAgent }>(key, `/${encodeURIComponent(id)}`, { signal });
    if (!agentRequiresGithub(detail.agent, requiredSetupRef.current)) return;
    if (detail.agent.setup_state !== undefined && detail.agent.setup_state !== "ready")
      throw new Error("Complete required GitHub setup before sending this agent a task.");
    await verifyAgentGithubSetup(key, id, signal);
  }
  useEffect(() => {
    if (!callback.current) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("agent_id"); url.searchParams.delete("connection_id");
    window.history.replaceState(null, "", url.href);
  }, []);
  useEffect(() => {
    if (setupRequired && agent?.setup_state !== "ready") setConnectionsOpen(true);
  }, [selected, setupRequired, agent?.setup_state]);
  useEffect(() => {
    if (!connectionsOpen) return;
    const frame = requestAnimationFrame(() => {
      connectionPanel.current?.scrollIntoView({ block: "start", behavior: "smooth" });
      connectionPanel.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [connectionsOpen, connectionFocus]);
  useEffect(() => { scroll.current?.scrollTo(0, scroll.current.scrollHeight); }, [entries, confirmation, editor]);
  useEffect(() => {
    if (!retryUntil) return;
    const timer = setInterval(() => tick((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [retryUntil]);
  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController(); const key = ps.apiKey;
    let delay = 5000; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const observation = await agentRequest<{ agent: HostedAgent; pending_operation_id: string | null }>(key, `/${selected}`, { signal: abort.signal });
        if (abort.signal.aborted) return;
        setAgents((prev) => prev.map((a) => a.id === selected ? { ...observation.agent, pending_operation_id: observation.pending_operation_id } : a));
        if (observation.agent.status === "deleted") setSelected((current) => current === selected ? "" : current);
        delay = observation.pending_operation_id ? Math.min(delay * 1.5, 30000) : 15000;
      } catch { delay = Math.min(delay * 2, 60000); }
      if (!abort.signal.aborted) timer = setTimeout(poll, delay);
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [selected, ps.apiKey]);
  useEffect(() => {
    setUsage(null); setLogs([]); setMonitorError("");
    setUnlockOpen(false); setUnlockDraft(""); setDesktop(null); desktopBinding.current = null;
    setFilesOpen(false); setFilesPath(""); setMemoryOpen(false); setEditor(null);
    desktopController.current?.abort(); desktopController.current = null; setDesktopBusy(false);
    return () => { desktopController.current?.abort(); };
  }, [selected, ps.apiKey]);
  useEffect(() => {
    if (!desktop || !desktopBinding.current) return;
    if (desktopRuntimeChanged(desktopBinding.current, selected, setupConnection?.generation) ||
        (agent && desktopRuntimeUnavailable(agent)) || ["revoked", "suspended"].includes(setupConnection?.state || "")) {
      desktopController.current?.abort(); desktopController.current = null;
      desktopBinding.current = null; setDesktopBusy(false); setDesktop(null);
      setError("The runtime changed or became unavailable. Refresh its status, then open a new desktop session.");
    }
  }, [desktop, agent, selected, setupConnection?.generation, setupConnection?.state]);
  useEffect(() => {
    if (!selected) return;
    const key = ps.apiKey; const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>; let delay = 15000;
    async function poll() {
      const results = await Promise.allSettled([
        agentRequest<{ rows: AgentUsage[] }>(key, `/${selected}/usage?days=30`, { signal: abort.signal }),
        ...(followingLogs ? [agentRequest<{ lines: string[] }>(key, `/${selected}/logs?tail=100`, { signal: abort.signal })] : []),
      ]);
      if (abort.signal.aborted) return;
      const record = results[0];
      if (record.status === "fulfilled" && "rows" in record.value) setUsage(record.value.rows);
      const log = results[1];
      if (log?.status === "fulfilled" && "lines" in log.value) setLogs(log.value.lines);
      const failed = results.some((r) => r.status === "rejected");
      setMonitorError(failed ? "Progress refresh unavailable; retaining the last observation." : "");
      delay = failed ? Math.min(delay * 2, 60000) : 15000;
      timer = setTimeout(poll, delay);
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [selected, ps.apiKey, followingLogs, busy]);
  useEffect(() => {
    const pendingIntent = intents.find((i) => i.operationId);
    if (!pendingIntent || busy) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>; let delay = 5000;
    async function poll() {
      try {
        const result = await agentRequest<AgentOperationResult>(ps.apiKey, `/operations/${pendingIntent!.operationId}`, { signal: abort.signal });
        if (abort.signal.aborted) return;
        if (result.operation.state !== "pending") { await settle(result, pendingIntent!, ps.apiKey); return; }
        delay = Math.min(delay * 1.5, 60000);
      } catch { delay = Math.min(delay * 2, 60000); }
      if (!abort.signal.aborted) timer = setTimeout(poll, delay);
    }
    timer = setTimeout(poll, delay);
    return () => { abort.abort(); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intents, busy, ps.apiKey]);

  async function command(name: string, argument: string, key: string, signal: AbortSignal) {
    if (name === "help") { say("/claim · /agents · /status · /github · /files [directory] · /edit path · /memory · /logs · /usage · /egress · /topup credits · /suspend · /resume · /delete [purge]. Other messages become tasks after you confirm."); return; }
    if (name === "new" || name === "claim") { setCreate(true); return; }
    if (name === "agents" || name === "status") { await refresh(key, signal); say("Agent list refreshed from Alpha. Select an agent above. An uncertain purchase response does not mean an agent was deleted; use the saved request to reconcile its outcome."); return; }
    if (!agent) throw new Error("Create or select an agent first.");
    if (name === "pair" || name === "github" || name === "credentials") {
      openConnections(); return;
    }
    if (name === "files") {
      validateAgentPath(argument, true);
      setFilesPath(argument); setFilesOpen(true); return;
    }
    if (name === "memory") { setMemoryOpen(true); return; }
    if (name === "edit") { await openEditor(argument || "SOUL.md", "workspace", key, signal); return; }
    if (["logs", "usage", "egress"].includes(name)) {
      const suffix = name === "logs" ? "logs?tail=100" : name === "usage" ? "usage?days=30" : "egress?hours=24&limit=100";
      const result = await agentRequest<{ lines?: string[]; rows?: AgentUsage[] }>(key, `/${agent.id}/${suffix}`, { signal });
      if (!signal.aborted) say(name === "logs" ? (result.lines || []).join("\n") || "No log lines yet." : JSON.stringify(result.rows || [], null, 2));
      return;
    }
    if (pending) throw new Error("Reconcile pending operations before changing this agent.");
    const amount = Number(argument);
    if (name === "topup" && (!Number.isSafeInteger(amount) || amount < 1)) throw new Error("Use /topup followed by a positive whole credit amount.");
    if (name === "topup" && !catalog?.purchasing_enabled) throw new Error("Purchasing is disabled for this network.");
    if (name === "delete" && argument && argument !== "purge") throw new Error("Use /delete or /delete purge.");
    const intent = newAgentIntent(name === "delete" ? `/${agent.id}?purge=${argument === "purge"}` : `/${agent.id}${name === "topup" ? "" : `/${name}`}`,
      name === "delete" ? "DELETE" : name === "topup" ? "PATCH" : "POST", name === "delete" ? null : name === "topup" ? { credits: amount } : {});
    setConfirmation({ title: `${name} ${agent.name}`, detail: name === "delete" ? `No unused-budget refund. ${argument === "purge" ? "Purge permanently removes the workspace." : "The workspace is retained."} Host-managed memory has a separate lifecycle; this does not erase remembered facts.` : name === "topup" ? `Spend ${amount} credits for ${catalog?.tokens_per_credit ? (amount * catalog.tokens_per_credit).toLocaleString() : "additional"} tokens. Usage is retained; this does not resume the agent.` : `Confirm ${name} for this agent.`, run: () => guarded((currentKey) => execute(intent, currentKey)) });
  }
  async function openEditor(path: string, area: AgentFileArea, key: string, signal: AbortSignal) {
    if (!agent) return;
    validateAgentPath(path);
    if (!canEditWorkspaceFile({ name: path, dir: false })) throw new Error("This file is download-only. Open Agent files to download it.");
    let content = "";
    try {
      const blob = await downloadAgentFile(key, agent.id, path, signal, area);
      content = workspaceText(new Uint8Array(await blob.arrayBuffer()));
    } catch (e) { if (!(e instanceof AgentApiError) || e.status !== 404) throw e; }
    if (!signal.aborted) setEditor({ agentId: agent.id, path, content, area });
  }
  async function reviewPreviousTurn() {
    if (!agent) return;
    const id = agent.id;
    const conversation = conversations.current;
    const session = conversation.forAgent(id);
    await guarded(async (key, signal) => {
      const observed = await inspectAgentTurnRecovery(key, id, session, signal);
      if (signal.aborted) return;
      const stopped = observed.state === "uncertain";
      setConfirmation({ title: stopped ? "Confirm the previous task has stopped" : "Continue this conversation?",
        detail: stopped ? "The server could not confirm that the previous task finished. Check its desktop, files and logs. Confirm only after you know it has stopped; this does not cancel or resend the task."
          : "The server reports no active turn. Confirm that you reviewed the interrupted task and its outputs; this does not resend it.",
        confirmLabel: stopped ? "I confirmed the previous task has stopped" : "I reviewed the outputs",
        run: () => guarded(async (currentKey, currentSignal) => {
          await confirmAgentTurnRecovery(currentKey, id, session, observed, currentSignal);
          if (!currentSignal.aborted && conversations.current === conversation) { conversation.reviewed(id); tick((value) => value + 1); setError(""); }
        }),
      });
    });
  }
  function confirmSync() {
    if (!agent) return;
    // A durable intent like purchases: stored per owner/network before dispatch and retried
    // with the same key, so an unanswered request never restarts the agent twice.
    const intent = newAgentIntent(`/${agent.id}/sync`, "POST", null);
    setConfirmation({ title: `Pull & restart ${agent.name}`,
      detail: "Pull the latest commit from the agent's repository and restart it. A task in progress stops. The unlock key stays in memory.",
      run: () => guarded(async (key) => { setDesktop(null); desktopBinding.current = null; await execute(intent, key); }) });
  }
  async function openDesktop() {
    if (!agent || !desktopReady || desktopController.current) return;
    const key = ps.apiKey; const id = agent.id;
    const abort = new AbortController(); desktopController.current = abort;
    setDesktopBusy(true);
    try {
      const connection = await agentRequest<AgentConnection>(key, `/${encodeURIComponent(id)}/connections`, { signal: abort.signal });
      if (abort.signal.aborted || activeKey.current !== key) return;
      setSetupConnection(connection);
      const opened = await openAgentDesktop(key, id, abort.signal);
      if (!abort.signal.aborted && activeKey.current === key) {
        desktopBinding.current = { agentId: id, generation: connection.generation };
        setDesktop(desktopSocket(opened, id));
      }
    } catch (e) { if (!abort.signal.aborted && activeKey.current === key) report(e); }
    finally {
      if (desktopController.current === abort) { desktopController.current = null; setDesktopBusy(false); }
    }
  }
  async function submit(value = input) {
    const text = value.trim(); if (!text || busy || connectionsOpen || confirmation || retryUntil > Date.now()) return;
    const parsed = parseAgentCommand(text);
    if (parsed) { setInput(""); say(text, "user"); await guarded((key, signal) => command(parsed.name, parsed.argument, key, signal)); return; }
    if (text.startsWith("/")) { say("Unknown command. Use /help for Studio commands."); return; }
    if (!agent) { setCreate(true); say("Create an agent, then send it a task."); return; }
    if (pending || agent.status !== "running") { setError("The agent must be running with no pending operations before sending a task."); return; }
    const id = agent.id; const agentName = agent.name;
    if (conversations.current.needsReview(id)) { setError("The previous reply was not completed. Review this agent's status, files and logs before continuing this conversation."); return; }
    if (setupRequired) {
      let ready = false;
      await guarded(async (key, signal) => { await verifyRequiredSetup(key, id, signal); ready = !signal.aborted; });
      if (!ready) { setConnectionsOpen(true); return; }
    }
    setInput("");
    setConfirmation({ title: `Send task to ${agentName}`, restoreText: text, detail: `This spends prepaid tokens and may cause the agent to act on its workspace and connected accounts.\n\n${text}`,
      run: () => guarded(async (key, signal) => {
        await verifyRequiredSetup(key, id, signal);
        const conversation = conversations.current;
        conversation.begin(id);
        const session = conversation.forAgent(id);
        let completed = false;
        say(text, "user"); const replyId = crypto.randomUUID();
        setEntries((prev) => [...prev, { id: replyId, role: "agent", text: "", replyState: "streaming" }]);
        try {
          await observeAgentReply(() => streamAgentMessage(key, id, text, session, (chunk, mode) => {
            if (!signal.aborted && activeKey.current === key) setEntries((prev) => prev.map((e) => e.id === replyId ? { ...e, text: mode === "replace" ? chunk : e.text + chunk } : e));
          }, signal), (replyState) => {
            if (!signal.aborted && activeKey.current === key) setEntries((prev) => prev.map((e) => e.id === replyId ? { ...e, replyState } : e));
          });
          completed = true;
        } finally {
          conversation.finish(id, completed);
          if (!signal.aborted && activeKey.current === key) await refresh(key, signal).catch(() => { setMonitorError("Budget refresh unavailable; retaining the last observation."); });
        }
      }) });
  }
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    if (!active) return;
    ps.setInputHandler("agents", (text) => { void submitRef.current(text); });
    ps.registerSuggestions("agents", ["/claim", "/github", "/status", "/edit SOUL.md", "/files", "/usage"].map((text) => ({ label: text, run: () => { void submitRef.current(text); } })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  return <div className="agent-chat">
    <div className="agent-header">
      <div><span className="eyebrow">Pioneer · Agent Studio</span><h2>Your agents</h2><p>Author locally, run on Pioneer, and watch the full live desktop.</p></div>
      <button className="btn" disabled={busy || pending || connectionsOpen} onClick={() => setCreate(true)}>+ Claim agent</button>
    </div>
    <div className="agent-toolbar">
      <label>Agent <select value={selected} disabled={busy || !!confirmation || !!editor || connectionsOpen} onChange={(e) => { setSelected(e.target.value); }}>
        <option value="">Select an agent</option>{agents.filter((a) => a.status !== "deleted").map((a) => <option key={a.id} value={a.id}>{a.name} · {a.status}</option>)}
      </select></label>
      {agent && <><span>{agent.status}</span><span>{agent.cpus} CPU · {agent.mem_gb} GB RAM · {agent.disk_gb} GB disk</span>
        <button className="btn" aria-expanded={connectionsOpen} aria-controls="agent-github-setup" disabled={busy || !!confirmation || !!editor} onClick={openConnections}>GitHub</button>
        <button className="btn" disabled={busy || !!confirmation || !!editor || connectionsOpen} onClick={() => void guarded((key, signal) => command("files", "", key, signal))}>Agent files</button>
        <button className="btn" disabled={busy || !!confirmation || !!editor || connectionsOpen} onClick={() => setMemoryOpen(true)}>Memory</button>
        <button className="btn" disabled={busy || pending || !!confirmation || !!editor || connectionsOpen || conversations.current.needsReview(agent.id)} onClick={() => setConfirmation({
          title: "Start a new conversation?", detail: "Clear this tab's displayed conversation and start a fresh thread. The agent's saved files and persistent memory remain.",
          run: async () => { conversations.current.startNew(agent.id); setEntries([]); setInput(""); },
        })}>New conversation</button>
        <button className="btn" title={features.unlock ? "Give the agent the key that decrypts its .env" : "Waiting for Alpha to enable unlock"} disabled={!features.unlock || !runtimeReady || busy} onClick={() => setUnlockOpen(true)}>{agent.unlocked ? "Unlocked" : "Unlock"}</button>
        <button className="btn" title={features.sync ? "Pull the latest commit and restart the agent" : "Waiting for Alpha to enable Pull & restart"} disabled={!features.sync || !runtimeReady || busy || !!confirmation} onClick={confirmSync}>Pull &amp; restart</button>
        <button className="btn" title={features.desktop ? "Open the agent's desktop" : "Waiting for Alpha to enable the desktop"} disabled={!features.desktop || !desktopReady || desktopBusy} onClick={() => void openDesktop()}>Desktop</button></>}
      <button className="btn" disabled={busy || !!confirmation} onClick={() => void guarded((key, signal) => refresh(key, signal))}>Refresh agents</button>
    </div>
    <div className="agent-list-status" role="status">
      {ownerAddress && <span>Signed-in owner {ownerAddress.slice(0, 6)}…{ownerAddress.slice(-4)} · </span>}
      {agent?.source && <span>Running {agent.source.full_name}{agent.source.commit ? ` @ ${agent.source.commit.slice(0, 7)}` : ""} · </span>}
      {listObservedAt ? `${agents.filter((a) => a.status !== "deleted").length} agents returned by Alpha · List refreshed ${new Date(listObservedAt).toLocaleTimeString()}` : "Loading agents from your signed-in account…"}
      {listError && <p>{listError}</p>}
      {listObservedAt && !agents.some((a) => a.status !== "deleted") && <p>No agents were returned for this account. If a claim is unresolved, check its saved operation or retry the same request below.</p>}
    </div>
    {setupRequired && agent && <div className="agent-card agent-setup" role="status"><h3>{setupReady ? "GitHub setup verified" : "Required setup: connect GitHub"}</h3>
      <p>{setupReady ? "This agent has verified read access to its selected repository." : `Your agent exists. Complete GitHub authorization, repository selection and verified access before sending tasks. ${githubAvailability}`}</p>
      {!setupReady && <button className="btn" disabled={busy || !!confirmation || !!editor} onClick={openConnections}>Continue GitHub setup</button>}
    </div>}
    {agent?.template === "openhuman" && agent.unlocked === false && <p role="status">Encrypted configuration is locked. Local browser, files and Blender do not require unlock. Host memory also works while locked when configured and enabled. Unlock only for tasks needing your encrypted configuration.</p>}
    {agent && <div className="agent-budget">
      {agent.live ? <><progress max={Math.max(1, agent.live.budget_tokens)} value={Math.max(0, agent.live.budget_tokens - agent.live.remaining_tokens)} />
        <span>{Math.max(0, agent.live.remaining_tokens).toLocaleString()} tokens remaining · {agent.live.used_tokens.toLocaleString()} used</span></> : <span>Live budget unavailable · cumulative purchased budget {agent.token_budget.toLocaleString()} tokens</span>}
      <small>{agent.observed_at ? `Observed ${new Date(agent.observed_at).toLocaleTimeString()}` : "Awaiting observation"}{!liveAvailable ? " · live refresh unavailable; showing cached data" : ""}</small>
      <small>{usage ? `Last 30 days: ${usage.reduce((sum, row) => sum + Number(row.prompt_tokens) + Number(row.completion_tokens), 0).toLocaleString()} tokens · ${usage.reduce((sum, row) => sum + Number(row.requests), 0).toLocaleString()} requests` : "Usage awaiting observation"}</small>
      <small>Inference token usage excludes host-memory model computation.</small>
      <button className="btn" aria-pressed={followingLogs} onClick={() => setFollowingLogs((v) => !v)}>{followingLogs ? "Stop following logs" : "Follow progress"}</button>
    </div>}
    <div className="agent-transcript" ref={scroll} aria-live="polite">
      {!entries.length && <div className="agent-welcome"><h3>Your persistent agent</h3><p>Claim or select an agent, connect its personal repository, then confirm a task. Watch its live desktop, inspect workspace files, and follow runtime logs while it works.</p>
        <p>One agent turn can use several thousand prompt tokens. Pricing and purchase availability come from the live catalog.</p>
        <div className="agent-shortcuts">{["claim", "status", "github", "files", "memory", "logs", "usage", "help"].map((c) => <button className="btn" key={c} disabled={busy || !!confirmation || !!editor || connectionsOpen} onClick={() => { void guarded((key, signal) => command(c, "", key, signal)); }}>{`/${c}`}</button>)}</div>
      </div>}
      {entries.map((entry) => <div className={`agent-entry ${entry.role}`} key={entry.id}><small>{entry.role === "user" ? "You" : entry.role === "agent" ? "Agent" : "Studio"}</small><pre>{entry.text || agentReplyPlaceholder(entry.replyState)}</pre>
        {entry.replyState === "streaming" && <p role="status">Tool work may take up to 15 minutes. Replies arrive as completed content, rather than a live tool or token feed. Watch the desktop or runtime logs for progress.</p>}</div>)}
      {followingLogs && <div className="agent-card"><h3>Live runtime logs</h3><pre>{logs.join("\n") || "Awaiting runtime logs…"}</pre></div>}
      {monitorError && <p role="status">{monitorError}</p>}
      {intents.map((intent) => <div className="agent-card" key={intent.key}><strong>{pendingIntentSummary(intent)}</strong><p>{intent.operationId ? `Operation ${intent.operationId} is being reconciled.` : "Alpha has not confirmed this saved request's outcome. An agent may already exist; refresh the agent list. Retry uses the original purchase key and body. Do not claim again with a new request."}</p>
        <button className="btn" disabled={busy} onClick={() => void guarded(async (key) => {
          if (intent.operationId) await settle(await agentRequest<AgentOperationResult>(key, `/operations/${intent.operationId}`), intent, key);
          else await execute(intent, key);
        })}>{intent.operationId ? "Check operation" : "Retry same intent"}</button></div>)}
      {create && <form className="agent-card" onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !Number.isSafeInteger(credits) || credits < 1 || pending || !claimsReady) return;
        const intent = newAgentIntent("", "POST", { name: name.trim(), credits, template: "openhuman" });
        setConfirmation({ title: `Claim ${name.trim()}`, detail: `Spend ${credits} ${catalog?.network} credits for ${catalog?.tokens_per_credit ? (credits * catalog.tokens_per_credit).toLocaleString() : "prepaid"} tokens. Default resources: 4 CPU / 8 GB RAM / 50 GB disk. GitHub setup is required after provisioning; tasks remain locked until repository read access is verified.`, run: () => guarded(async (key, signal) => {
          const caps = await agentRequest<AgentConnectionCapabilities>(key, "/connections/capabilities", { signal });
          if (!caps.github_read) throw new Error("GitHub setup is unavailable. No new claim was sent.");
          const currentCatalog = await agentRequest<AgentCatalog>(key, "/catalog", { signal });
          if (!currentCatalog.setup_required || !currentCatalog.purchasing_enabled) throw new Error("Alpha's required GitHub setup policy is not enabled for new claims. No new claim was sent.");
          setCreate(false); await execute(intent, key);
        }) });
      }}><h3>Claim an agent</h3><label>Name<input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Prepaid credits<input type="number" min={1} step={1} required value={credits} onChange={(e) => setCredits(Number(e.target.value))} /></label>
        <p>{catalog ? `${catalog.network} · ${catalog.tokens_per_credit?.toLocaleString() || "Unavailable"} tokens / credit · owner limit ${catalog.limits.agents} agents` : "Loading catalog…"}</p>
        <p>GitHub setup is required for new agents. {githubAvailability} {!githubAvailable && "New claims are paused until GitHub setup is available."} {catalog && !catalog.setup_required && "Alpha's mandatory setup policy for new claims is not enabled yet."} {catalog && !catalog.templates?.includes("openhuman") && "Alpha doesn't offer the OpenHuman runtime yet."}</p>
        <button className="btn" disabled={!catalog?.purchasing_enabled || !claimsReady || !storageKey || pending || busy || !!confirmation || connectionsOpen}>Review purchase</button> <button className="btn" type="button" onClick={() => setCreate(false)}>Cancel</button>
      </form>}
      {connectionsOpen && agent && <div id="agent-github-setup" ref={connectionPanel} tabIndex={-1} aria-label="GitHub setup"><AgentConnections key={`${authSession.current.id}:${agent.id}`} apiKey={ps.apiKey} agentId={agent.id}
        required={setupRequired}
        provisioning={agent.status === "provisioning" || !!agent.pending_operation_id}
        callbackId={callback.current?.agentId === agent.id ? callback.current.connectionId : undefined}
        onClose={() => { setConnectionsOpen(false); void guarded((key, signal) => refresh(key, signal)); }} /></div>}
      {unlockOpen && agent && <form className="agent-card" onSubmit={(e) => {
        e.preventDefault();
        const draft = unlockDraft; setUnlockDraft(""); // never keep the key past one attempt, successful or not
        let key: string;
        try { key = unlockKey(draft); } catch (err) { report(err); return; }
        const id = agent.id;
        void guarded(async (apiKey, signal) => {
          await unlockAgent(apiKey, id, key, signal);
          if (signal.aborted) return;
          setUnlockOpen(false); say("Unlocked. The agent can use its decrypted configuration until its machine restarts.");
          await refresh(apiKey, signal).catch(() => {});
        });
      }}><h3>Unlock {agent.name}</h3>
        <p>Paste the key from <code>make key</code> in your agent repository. It goes to the agent's memory only: Studio and Alpha don't store it, and the agent forgets it when its machine restarts.</p>
        <label>Unlock key<input type="password" autoComplete="off" spellCheck={false} value={unlockDraft} onChange={(e) => setUnlockDraft(e.target.value)} /></label>
        <button className="btn" disabled={busy || !unlockDraft.trim()}>Unlock</button> <button type="button" className="btn" onClick={() => { setUnlockDraft(""); setUnlockOpen(false); }}>Cancel</button>
      </form>}
      {filesOpen && agent && <AgentWorkspace key={`${authSession.current.id}:${agent.id}:${filesPath}`} apiKey={ps.apiKey} agentId={agent.id} initialPath={filesPath}
        onClose={() => setFilesOpen(false)} onEdit={(path, area) => { void guarded((key, signal) => openEditor(path, area, key, signal)); }} />}
      {memoryOpen && agent && <AgentMemoryPanel key={`${authSession.current.id}:${agent.id}`} apiKey={ps.apiKey} agentId={agent.id} onClose={() => setMemoryOpen(false)} />}
      {agent && conversations.current.needsReview(agent.id) && <div className="agent-card agent-confirm" role="status"><h3>Review the interrupted task</h3>
        <p>The previous request ended without confirmation. It may still be running and may have performed work. Check status, saved files and runtime logs before sending another task. Studio will not replay it.</p>
        <button className="btn" disabled={busy || !!confirmation} onClick={() => void reviewPreviousTurn()}>Review previous task</button></div>}
      {editor && <form className="agent-card" onSubmit={(e) => {
        e.preventDefault(); const draft = { ...editor };
        try { validateAgentPath(draft.path); } catch (e) { report(e); return; }
        setConfirmation({ title: `Write ${draft.path}`, detail: "Replace this file in the running agent. Pull & restart overwrites files your repository ships.",
          run: () => guarded(async (key, signal) => { await writeAgentFile(key, draft.agentId, draft.path, draft.content, signal, draft.area); if (!signal.aborted) { setEditor(null); say(`Saved ${draft.path}.`); } }) });
      }}><h3>{editor.area === "projects" ? "Project" : "Workspace"} text editor</h3><label>Relative file path<input required value={editor.path} onChange={(e) => setEditor({ ...editor, path: e.target.value })} /></label>
        <p>Edits here change the running agent only. Make lasting changes in your repository, then Pull &amp; restart.</p>
        <label>File contents<textarea rows={12} spellCheck={false} value={editor.content} onChange={(e) => setEditor({ ...editor, content: e.target.value })} /></label>
        <button className="btn" disabled={busy || !!confirmation}>Review save</button> <button type="button" className="btn" onClick={() => { setConfirmation(null); setEditor(null); }}>Discard</button></form>}
      {confirmation && <div className="agent-card agent-confirm"><h3>{confirmation.title}</h3><pre>{confirmation.detail}</pre><button className="btn" disabled={busy} onClick={() => { const action = confirmation; setConfirmation(null); void action.run(); }}>{confirmation.confirmLabel || "Confirm"}</button> <button className="btn" disabled={busy} onClick={() => { if (confirmation.restoreText) setInput(confirmation.restoreText); setConfirmation(null); }}>Cancel</button></div>}
      {error && <p role="alert" className="agent-error">{error}</p>}
    </div>
    <form className="agent-composer" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <textarea aria-label="Message your agent" placeholder="Give your agent a task, or use /new, /edit SOUL.md, /status…" rows={2} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } }} />
      <div><small>{setupRequired && !setupReady ? "Complete required GitHub setup before sending tasks" : busy ? "Working…" : retryUntil > Date.now() ? `Retry in ${Math.ceil((retryUntil - Date.now()) / 1000)}s` : "Tasks use prepaid tokens · review before sending"}</small><button className="btn" disabled={busy || connectionsOpen || !!confirmation || !input.trim() || retryUntil > Date.now() || (setupRequired && !setupReady && !parseAgentCommand(input))}>Send</button></div>
    </form>
    {desktop && agent && <AgentDesktop socket={desktop} busy={desktopBusy} onReconnect={() => void openDesktop()} onClose={() => { desktopController.current?.abort(); desktopController.current = null; setDesktopBusy(false); setDesktop(null); desktopBinding.current = null; }}
      title={`${agent.name} · ${agent.status}${agent.source?.commit ? ` · ${agent.source.commit.slice(0, 7)}` : ""}${agent.unlocked === false ? " · locked" : ""}`} />}
  </div>;
}
