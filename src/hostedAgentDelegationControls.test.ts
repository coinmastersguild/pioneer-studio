import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import ChatView from "./ChatView";
import AgentChatView from "./AgentChatView";
import { callAction, clearActions } from "./control";
import { beginStudioAgentTurn, executeStudioAction } from "./studioAgent";
import type { JobModel } from "./api";
import type { Mode, PS } from "./shared";

const agentId = "00000000-0000-4000-8000-000000000101";
const otherId = "00000000-0000-4000-8000-000000000102";
const owner = "0x1111111111111111111111111111111111111111";
const text = "tell the agent to make me a cat video";
const catalog = { network: "testnet", tokens_per_credit: 10000, purchasing_enabled: false, setup_required: true, templates: ["openhuman"], features: {}, limits: { agents: 5, cpus: 32, mem_gb: 64, disk_gb: 500, per_agent: { cpus: 8, mem_gb: 16, disk_gb: 200 }, file_bytes: 10485760 } };

async function mounted(options: { interrupted?: boolean; agents?: boolean; models?: JobModel[]; tool?: boolean; multiple?: boolean; agentActive?: boolean; plan?: Record<string, unknown>; deferred?: boolean; suspendedAdmission?: boolean } = {}) {
  const browser = new Window({ url: "http://localhost:5173" });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const originalFetch = globalThis.fetch;
  const requests: { url: URL; method: string; body: any; authorization: string | null }[] = [];
  const handlers: Partial<Record<Mode, (text: string) => void>> = {};
  const modes: Mode[] = [];
  let outputPrefix = ""; let generationWorking = false; let detailReads = 0; let finishReply: (() => void) | undefined;
  const agent = { id: agentId, name: "Synthetic owner agent", template: "openhuman", status: "running", network: "testnet", token_budget: 10000, credits_paid: 1, cpus: 4, mem_gb: 8, disk_gb: 50, observed_at: Date.now(), setup_required: true, setup_state: "ready", unlocked: false, live: { budget_tokens: 10000, used_tokens: 0, remaining_tokens: 10000, state: "running", status: "active", container: "running" } };
  globalThis.fetch = (async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, body, method: init.method || "GET", authorization: new Headers(init.headers).get("Authorization") });
    const path = url.pathname;
    if (path === "/api/v1/account") return Response.json({ address: owner, credits: 100 });
    if (path === "/api/v1/agents") return Response.json({ agents: options.agents === false ? [] : options.multiple ? [agent, { ...agent, id: otherId, name: "Second owner agent" }] : [agent], live_available: true });
    if (path === "/api/v1/agents/catalog") return Response.json(catalog);
    if (path === "/api/v1/agents/connections/capabilities") return Response.json({ github_read: true, github_write: false, assets: false, configured: true, enabled: true });
    if ([`/api/v1/agents/${agentId}`, `/api/v1/agents/${otherId}`].includes(path)) return Response.json({ agent: options.suspendedAdmission && ++detailReads > 1 ? { ...agent, status: "suspended" } : { ...agent, id: path.endsWith(otherId) ? otherId : agentId }, pending_operation_id: null });
    if (path.endsWith("/connections")) return Response.json({ agent_id: path.includes(otherId) ? otherId : agentId, revision: 1, generation: 1, state: "active", repositories: [{ id: 101, full_name: "fixture/own-agent" }], permissions: ["contents:read", "metadata:read"], sync_pending: false, last_verified_at: Date.now(), credential_expires_at: Date.now()+3600000, legacy: { state: "resolved", evidence: "fixture only" }, provider_revocation_pending: false });
    if (path.endsWith("/usage")) return Response.json({ rows: [] });
    if (path.endsWith("/files")) {
      if (url.searchParams.get("download") === "true") {
        const bytes = new Uint8Array(32); new DataView(bytes.buffer).setUint32(0,24); bytes.set(new TextEncoder().encode("ftypisom"),4); new DataView(bytes.buffer).setUint32(24,8); bytes.set(new TextEncoder().encode("mdat"),28);
        return new Response(bytes, { headers: { "Content-Type": "video/mp4" } });
      }
      return Response.json({ entries: outputPrefix ? [{ name: `${outputPrefix}.mp4`, dir: false, size: 32 }, { name: `${outputPrefix}.blend`, dir: false, size: 1024 }] : [{ name: "cat.mp4", dir: false, size: 1024 }] });
    }
    if (path.endsWith("/messages")) { outputPrefix = body.content.match(/studio-[0-9a-f-]{36}/)?.[0] || ""; if (options.deferred) return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(": heartbeat\n\n")); finishReply = () => { stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Synthetic finished video reply."}}]}\n\ndata: [DONE]\n\n')); stream.close(); }; } }), { headers: { "Content-Type": "text/event-stream" } }); return new Response(options.interrupted ? ": heartbeat\n\n" : ': heartbeat\n\ndata: {"choices":[{"delta":{"content":"Synthetic reply: saved cat.mp4 and cat.blend."}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } }); }
    if (path === "/api/v1/chat/completions") {
      const content = options.plan ? JSON.stringify(options.plan) : options.models?.length
        ? JSON.stringify({ say: "Rendering now!", job: { model: options.models[0].model, endpoint: options.models[0].endpoint, params: { prompt: "Synthetic cat still" }, refs: [] } })
        : JSON.stringify({ say: "Rendering now!", job: { model: "ltx-video", endpoint: "generate", params: { prompt: "cat video" }, refs: [] } });
      const message = options.tool ? { content: null, tool_calls: [{ id: "fixture-delegate", type: "function", function: { name: "agents_delegate", arguments: JSON.stringify({ task: text, agent_id: agentId }) } }] } : { content };
      return Response.json({ choices: [{ message }] });
    }
    if (path === "/api/v1/jobs") return Response.json({ job_id: "fixture-job", credits_charged: 3, credits_remaining: 97 });
    throw new Error(`Unexpected fixture API path ${path}`);
  }) as typeof fetch;
  for (const [name, value] of Object.entries({ window: browser, document: browser.document, localStorage: browser.localStorage, requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true })) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  clearActions();
  const ps: PS = { apiKey: "synthetic-owner-key", models: options.models || [], catalogRevision: "fixture", catalogAvailable: !!options.models?.length, catalogLimits: {}, media: null, board: null, mode: "chat", refreshModels: async () => {}, refreshMedia() {}, setBoard() {}, refreshBoard() {}, setMode(m) { modes.push(m); }, charge() {}, refreshCredits() {}, toast() {}, addMsg() {}, streamMsg: async () => {}, setAiState(_label, working) { generationWorking = working; }, registerSuggestions() {}, setInputHandler(m, handler) { handlers[m] = handler; }, isBusy: () => false, setBusy() {}, waitForJob: async () => ({ url: "https://example.invalid/synthetic.png", contentType: "image/png" }) };
  const container = browser.document.createElement("div"); browser.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => root.render(createElement("div", {}, createElement(ChatView, { ps }), createElement(AgentChatView, { ps, active: options.agentActive || false }))));
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
  await settle();
  const click = async (label: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
    if (!button) throw new Error(`Missing button ${label}`);
    await act(async () => button.click()); await settle();
    if (label === "Confirm generation") await act(async () => { const until = Date.now() + 5000; while (generationWorking && Date.now() < until) await new Promise((r) => setTimeout(r, 20)); });
  };
  const cleanup = async () => {
    await act(async () => root.unmount()); browser.happyDOM.abort(); globalThis.fetch = originalFetch; clearActions();
    for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  };
  return { container, requests, handlers, modes, click, settle, cleanup, async switchOwner() { ps.apiKey="synthetic-other-owner-key"; await act(async () => root.render(createElement("div", {}, createElement(ChatView, { ps }), createElement(AgentChatView, { ps, active: options.agentActive || false })))); }, finishReply() { try { finishReply?.(); } catch { /* A cancelled fixture stream is closed. */ } }, setStatus(status: string) { agent.status = status; } };
}

const messages = (calls: Awaited<ReturnType<typeof mounted>>["requests"]) => calls.filter((r) => r.url.pathname.endsWith("/messages"));

test("mounted Chat delegates the complete cat-video request directly to the selected owner agent with inline output", async () => {
  const view = await mounted();
  try {
    await act(async () => { await view.handlers.chat!(text); }); await view.settle();
    expect(view.modes).not.toContain("agents");
    expect(view.container.querySelector(".agent-confirm")).toBeNull();
    expect(view.container.textContent).toContain(text);
    expect(messages(view.requests)).toHaveLength(1);
    expect(view.requests.some((r) => r.url.pathname === "/api/v1/chat/completions" || r.url.pathname === "/api/v1/jobs")).toBe(false);
    const dispatched = messages(view.requests);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].url.pathname).toBe(`/api/v1/agents/${agentId}/messages`);
    expect(dispatched[0].authorization).toBe("Bearer synthetic-owner-key");
    expect(dispatched[0].body.content).toContain(text);
    expect(dispatched[0].body.content).toContain("MP4");
    expect(dispatched[0].body.content).toContain(".blend");
    expect(dispatched[0].body.session).toMatch(/^[0-9a-f-]{36}$/);
    expect(dispatched[0].body.stream).toBe(true);
    const prefix = dispatched[0].body.content.match(/studio-[0-9a-f-]{36}/)?.[0];
    expect(prefix).toHaveLength(43);
    expect(view.container.querySelector(`button[aria-label="Download ${prefix}.blend"]`)).not.toBeNull();
    expect(view.container.querySelector('video[aria-label="Agent video deliverable"]')).not.toBeNull();
    expect(view.requests.some((r) => r.url.searchParams.get("download") === "true" && (r.url.searchParams.get("area") || "workspace") === "workspace" && r.url.searchParams.get("path") === `desktop-test/${prefix}.mp4`)).toBe(true);
    expect(view.container.textContent).not.toContain("Playable video");
    expect(view.container.textContent).not.toContain("Rendering now!");
  } finally { await view.cleanup(); }
});

test("global Copilot delegates the same authoring task directly and rejects a foreign target", async () => {
  const view = await mounted({ tool: true });
  try {
    const turn = await beginStudioAgentTurn("synthetic-owner-key", text, { mode: "studio", board: null });
    expect(turn.actions[0]?.actionName).toBe("agents.delegate");
    let result!: Awaited<ReturnType<typeof executeStudioAction>>;
    await act(async () => { result = await executeStudioAction(turn.actions[0]); }); await view.settle();
    expect(JSON.parse(result.message.content)).toMatchObject({ state: "complete", agent_id: agentId });
    expect(messages(view.requests)).toHaveLength(1);
    expect(view.modes).not.toContain("agents");
    await expect(callAction("agents.delegate", { task: text, agent_id: otherId })).rejects.toThrow();
    expect(messages(view.requests)).toHaveLength(1);
  } finally { await view.cleanup(); }
});

test("an interrupted delegated request is fenced and never automatically resent", async () => {
  const view = await mounted({ interrupted: true });
  try {
    await act(async () => { await view.handlers.chat!(text); }); await view.settle();
    expect(messages(view.requests)).toHaveLength(1);
    expect(view.container.textContent).toContain("Review the interrupted task");
    await act(async () => { await view.handlers.chat!(text); }); await view.settle();
    expect(messages(view.requests)).toHaveLength(1);
    expect(view.requests.some((r) => r.url.pathname === "/api/v1/jobs")).toBe(false);
  } finally { await view.cleanup(); }
});

test("plain video requests with no video catalog run the selected agent without an extra choice", async () => {
  const view = await mounted();
  try {
    await act(async () => { await view.handlers.chat!("make me a cat video"); }); await view.settle();
    expect(view.requests.some((r) => r.url.pathname === "/api/v1/chat/completions" || r.url.pathname === "/api/v1/jobs")).toBe(false);
    expect(messages(view.requests)).toHaveLength(1);
    expect(view.modes).not.toContain("agents");
    expect(view.container.textContent).not.toContain("Use hosted agent");
  } finally { await view.cleanup(); }
});

test("a valid media job waits for an explicit confirmation and cannot say it is rendering before dispatch", async () => {
  const models: JobModel[] = [{ model: "synthetic-image", endpoint: "generate", credits: 3, note: "Fixture only", result: "binary", result_ext: ".png", params: { prompt: { type: "str", required: true } } }];
  const view = await mounted({ models });
  try {
    await act(async () => { await view.handlers.chat!("make a cat still"); }); await view.settle();
    expect(view.requests.filter((r) => r.url.pathname === "/api/v1/jobs")).toHaveLength(0);
    expect(view.container.textContent).not.toContain("Rendering now!");
    await view.click("Confirm generation");
    expect(view.requests.filter((r) => r.url.pathname === "/api/v1/jobs")).toHaveLength(1);
  } finally { await view.cleanup(); }
});


test("no agent or multiple unselected agents fail closed without media fallback", async () => {
  for (const options of [{ agents: false }, { multiple: true }]) {
    const view = await mounted(options);
    try {
      await act(async () => { await view.handlers.chat!(text); }); await view.settle();
      expect(messages(view.requests)).toHaveLength(0);
      expect(view.requests.some((r) => r.url.pathname === "/api/v1/chat/completions" || r.url.pathname === "/api/v1/jobs")).toBe(false);
      expect(view.container.textContent).not.toContain("Send task to Synthetic owner agent");
      expect(view.container.textContent).toContain("Select your own intended agent");
    } finally { await view.cleanup(); }
  }
});
test("direct task rechecks runtime admission and refuses a newly suspended agent", async () => {
  const view = await mounted({ suspendedAdmission: true });
  try {
    await act(async () => { await view.handlers.chat!(text); }); await view.settle();
    expect(messages(view.requests)).toHaveLength(0); expect(view.container.textContent).toContain("must still be running");
  } finally { await view.cleanup(); }
});


test("an unavailable flow cannot display a premature rendering claim or submit a job", async () => {
  const view = await mounted({ plan: { say: "Rendering now!", flow: "removed-flow" } });
  try {
    await act(async () => { await view.handlers.chat!("create a cat still"); }); await view.settle();
    expect(view.container.textContent).not.toContain("Rendering now!");
    expect(view.container.textContent).toContain("unavailable in the live catalog");
    expect(view.requests.filter((r) => r.url.pathname === "/api/v1/jobs")).toHaveLength(0);
  } finally { await view.cleanup(); }
});


test("the direct Agents composer sends the same unique MP4 task once", async () => {
  const view = await mounted({ agentActive: true });
  try {
    await act(async () => { await view.handlers.agents!("make me a cat video"); }); await view.settle();
    expect(view.container.querySelector(".agent-confirm")).toBeNull(); expect(messages(view.requests)).toHaveLength(1); expect(messages(view.requests)[0].body.content).toMatch(/studio-[0-9a-f-]{36}\.mp4/);
  } finally { await view.cleanup(); }
});


test("delegation tools cannot turn a slash lifecycle command or oversized task into a management operation", async () => {
  for (const task of ["/delete purge", "x".repeat(16 * 1024)]) {
    const view = await mounted();
    try {
      await act(async () => { await expect(callAction("agents.delegate", { task })).rejects.toThrow(); }); await view.settle();
      expect(view.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
      expect(view.container.querySelector(".agent-confirm") === null).toBe(true);
    } finally { await view.cleanup(); }
  }
});


test("a running direct task stays inline and repeated requests join progress without a second dispatch", async () => {
  const view = await mounted({ deferred: true });
  try {
    await act(async () => { void view.handlers.chat!("tell the agent to make a neon cat video with the whole cat visible"); }); await view.settle();
    expect(messages(view.requests)).toHaveLength(1);
    expect(view.container.textContent).toContain("Agent is working");
    expect(view.container.querySelector(".agent-confirm")).toBeNull();
    await act(async () => { void view.handlers.chat!("tell the agent to make that video again"); }); await view.settle();
    expect(messages(view.requests)).toHaveLength(1);
    expect(view.container.textContent).toContain("already working");
    await act(async () => { view.finishReply(); }); await view.settle();
    const chat = view.container.querySelector(".chat-view");
    expect(chat?.textContent || view.container.textContent).toContain("Synthetic finished video reply.");
    expect(view.container.querySelectorAll('video[aria-label="Agent video deliverable"]').length).toBeGreaterThan(0);
    expect(view.modes).not.toContain("agents");
    expect(view.requests.some((r) => r.url.pathname === "/api/v1/jobs" || r.url.pathname === "/api/v1/chat/completions")).toBe(false);
  } finally { await view.cleanup(); }
});

test("global delegation emits waiting and terminal progress without navigating or replaying", async () => {
  const view = await mounted({ deferred: true }); const progress: { state: string }[] = [];
  try {
    let result: any;
    await act(async () => { void callAction("agents.delegate", { task: text }, { onHostedTask: (value) => progress.push(value) }).then(value => { result=value; }); }); await view.settle();
    expect(messages(view.requests)).toHaveLength(1); expect(progress.some(p=>p.state==="running")).toBe(true);
    await act(async () => { view.finishReply(); }); await view.settle();
    expect(result.state).toBe("complete"); expect(progress.at(-1)?.state).toBe("complete"); expect(messages(view.requests)).toHaveLength(1);
  } finally { await view.cleanup(); }
});


test("inline agent selection immediately dispatches only the explicitly chosen owned agent", async () => {
  const view = await mounted({ multiple: true });
  try {
    await act(async () => { await view.handlers.chat!(text); }); await view.settle();
    expect(messages(view.requests)).toHaveLength(0);
    const select = view.container.querySelector<HTMLSelectElement>('select[aria-label="Choose task agent"]')!;
    expect(select !== null).toBe(true);
    await act(async () => { select.value=otherId; select.dispatchEvent(new window.Event("change", { bubbles:true })); });
    await view.click("Use this agent");
    expect(messages(view.requests)).toHaveLength(1); expect(messages(view.requests)[0].url.pathname).toBe(`/api/v1/agents/${otherId}/messages`);
    expect(view.modes).not.toContain("agents");
  } finally { await view.cleanup(); }
});

test("a consequential runtime request stays inline until its explicit confirmation while camera motion is direct", async () => {
  const view = await mounted();
  try {
    await act(async () => { await view.handlers.chat!("tell the agent to publish a tweet announcing the video"); }); await view.settle();
    expect(messages(view.requests)).toHaveLength(0); expect(view.container.textContent).toContain("Review account or destructive actions");
    await view.click("Confirm agent task"); expect(messages(view.requests)).toHaveLength(1); expect(view.modes).not.toContain("agents");
    await act(async () => { await view.handlers.chat!("tell the agent to make a cat video with a camera push in"); }); await view.settle();
    expect(messages(view.requests)).toHaveLength(2); expect(view.container.querySelector(".agent-confirm")).toBeNull();
  } finally { await view.cleanup(); }
});


test("account changes discard pending delegated progress and never expose old output with the new key", async () => {
  const view = await mounted({ deferred: true });
  try {
    await act(async () => { void view.handlers.chat!(text); }); await view.settle();
    expect(messages(view.requests)).toHaveLength(1);
    await view.switchOwner(); await view.settle();
    await act(async () => { view.finishReply(); }); await view.settle();
    expect(view.container.textContent).not.toContain("Synthetic finished video reply.");
    expect(view.container.querySelector('video[aria-label="Agent video deliverable"]')).toBeNull();
    expect(messages(view.requests)).toHaveLength(1);
    expect(view.requests.some(r=>r.authorization==="Bearer synthetic-other-owner-key" && r.url.searchParams.get("download")==="true")).toBe(false);
  } finally { await view.cleanup(); }
});


test("free video-to-skeleton and video information keep their own routes rather than dispatching authoring", async () => {
  const view=await mounted({ plan: { say: "Videos can be saved as MP4." } });
  try {
    await act(async()=>{await view.handlers.chat!("Make a skeleton from this video");});await view.settle();
    expect(view.container.textContent).toContain("Video → skeleton"); expect(messages(view.requests)).toHaveLength(0);
    await act(async()=>{await view.handlers.chat!("How do you create videos?");});await view.settle();
    expect(messages(view.requests)).toHaveLength(0);expect(view.requests.filter(r=>r.url.pathname==="/api/v1/jobs")).toHaveLength(0);
  } finally {await view.cleanup();}
});


test("an inline consequential review is bound to the originally reviewed owned agent", async () => {
  const view=await mounted({multiple:true});
  try {
    await act(async()=>{await callAction("agents.select",{agent_id:agentId});});
    await act(async()=>{await view.handlers.chat!("tell the agent to publish a tweet");});await view.settle();
    expect(view.container.textContent).toContain("Synthetic owner agent");expect(messages(view.requests)).toHaveLength(0);
    await act(async()=>{await callAction("agents.select",{agent_id:otherId});});
    await view.click("Confirm agent task");
    expect(messages(view.requests)).toHaveLength(0);expect(view.container.textContent).toContain("No task was sent");
  } finally {await view.cleanup();}
});


test("a completed inline selection intent cannot dispatch its old goal again", async () => {
  const view=await mounted({multiple:true});
  try {
    await act(async()=>{await view.handlers.chat!(text);});await view.settle();
    const select=view.container.querySelector<HTMLSelectElement>('select[aria-label="Choose task agent"]')!;
    const button=[...view.container.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="Use this agent")!;
    await act(async()=>{select.value=agentId;select.dispatchEvent(new window.Event("change",{bubbles:true}));});
    await view.click("Use this agent");expect(messages(view.requests)).toHaveLength(1);
    expect([...view.container.querySelectorAll("button")].some(b=>b.textContent==="Use this agent")).toBe(false);
    await act(async()=>button.click());await view.settle();expect(messages(view.requests)).toHaveLength(1);
  } finally {await view.cleanup();}
});
