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

async function mounted(options: { interrupted?: boolean; agents?: boolean; models?: JobModel[]; tool?: boolean } = {}) {
  const browser = new Window({ url: "http://localhost:5173" });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const originalFetch = globalThis.fetch;
  const requests: { url: URL; method: string; body: any; authorization: string | null }[] = [];
  const handlers: Partial<Record<Mode, (text: string) => void>> = {};
  const modes: Mode[] = [];
  const agent = { id: agentId, name: "Synthetic owner agent", template: "openhuman", status: "running", network: "testnet", token_budget: 10000, credits_paid: 1, cpus: 4, mem_gb: 8, disk_gb: 50, observed_at: Date.now(), setup_required: true, setup_state: "ready", unlocked: false, live: { budget_tokens: 10000, used_tokens: 0, remaining_tokens: 10000, state: "running", status: "active", container: "running" } };
  globalThis.fetch = (async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, body, method: init.method || "GET", authorization: new Headers(init.headers).get("Authorization") });
    const path = url.pathname;
    if (path === "/api/v1/account") return Response.json({ address: owner, credits: 100 });
    if (path === "/api/v1/agents") return Response.json({ agents: options.agents === false ? [] : [agent], live_available: true });
    if (path === "/api/v1/agents/catalog") return Response.json(catalog);
    if (path === "/api/v1/agents/connections/capabilities") return Response.json({ github_read: true, github_write: false, assets: false, configured: true, enabled: true });
    if (path === `/api/v1/agents/${agentId}`) return Response.json({ agent, pending_operation_id: null });
    if (path.endsWith("/connections")) return Response.json({ agent_id: agentId, revision: 1, generation: 1, state: "active", repositories: [{ id: 101, full_name: "fixture/own-agent" }], permissions: ["contents:read", "metadata:read"], sync_pending: false, last_verified_at: Date.now(), credential_expires_at: Date.now()+3600000, legacy: { state: "resolved", evidence: "fixture only" }, provider_revocation_pending: false });
    if (path.endsWith("/usage")) return Response.json({ rows: [] });
    if (path.endsWith("/files")) return Response.json({ entries: [{ name: "cat.mp4", dir: false, size: 1024 }, { name: "cat.blend", dir: false, size: 1024 }] });
    if (path.endsWith("/messages")) return new Response(options.interrupted ? ": heartbeat\n\n" : ': heartbeat\n\ndata: {"choices":[{"delta":{"content":"Synthetic reply: saved cat.mp4 and cat.blend."}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    if (path === "/api/v1/chat/completions") {
      const content = options.models?.length
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
  const ps: PS = { apiKey: "synthetic-owner-key", models: options.models || [], catalogRevision: "fixture", catalogAvailable: !!options.models?.length, catalogLimits: {}, media: null, board: null, mode: "chat", refreshModels: async () => {}, refreshMedia() {}, setBoard() {}, refreshBoard() {}, setMode(m) { modes.push(m); }, charge() {}, refreshCredits() {}, toast() {}, addMsg() {}, streamMsg: async () => {}, setAiState() {}, registerSuggestions() {}, setInputHandler(m, handler) { handlers[m] = handler; }, isBusy: () => false, setBusy() {}, waitForJob: async () => ({ url: "https://example.invalid/synthetic.png", contentType: "image/png" }) };
  const container = browser.document.createElement("div"); browser.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => root.render(createElement("div", {}, createElement(ChatView, { ps }), createElement(AgentChatView, { ps, active: false }))));
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
  await settle();
  const click = async (label: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
    if (!button) throw new Error(`Missing button ${label}`);
    await act(async () => button.click()); await settle();
  };
  const cleanup = async () => {
    await act(async () => root.unmount()); browser.happyDOM.abort(); globalThis.fetch = originalFetch; clearActions();
    for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  };
  return { container, requests, handlers, modes, click, settle, cleanup };
}

const messages = (calls: Awaited<ReturnType<typeof mounted>>["requests"]) => calls.filter((r) => r.url.pathname.endsWith("/messages"));

test("mounted Chat delegates the complete cat-video request through the selected owner's existing task confirmation", async () => {
  const view = await mounted();
  try {
    await act(async () => { await view.handlers.chat!(text); }); await view.settle();
    expect(view.modes).toContain("agents");
    expect(view.container.textContent).toContain("Send task to Synthetic owner agent");
    expect(view.container.textContent).toContain(text);
    expect(messages(view.requests)).toHaveLength(0);
    expect(view.requests.some((r) => r.url.pathname === "/api/v1/chat/completions" || r.url.pathname === "/api/v1/jobs")).toBe(false);
    await view.click("Confirm");
    const dispatched = messages(view.requests);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].url.pathname).toBe(`/api/v1/agents/${agentId}/messages`);
    expect(dispatched[0].authorization).toBe("Bearer synthetic-owner-key");
    expect(dispatched[0].body.content).toContain(text);
    expect(dispatched[0].body.content).toContain("MP4");
    expect(dispatched[0].body.content).toContain(".blend");
    expect(dispatched[0].body.session).toMatch(/^[0-9a-f-]{36}$/);
    expect(dispatched[0].body.stream).toBe(true);
    expect(view.container.querySelector('button[aria-label="Download cat.mp4"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain("Rendering now!");
  } finally { await view.cleanup(); }
});

test("global Copilot tools prepare the same review, reject a caller-selected foreign agent and do not submit a task automatically", async () => {
  const view = await mounted({ tool: true });
  try {
    const turn = await beginStudioAgentTurn("synthetic-owner-key", text, { mode: "studio", board: null });
    expect(turn.actions[0]?.actionName).toBe("agents.delegate");
    const result = await executeStudioAction(turn.actions[0]);
    expect(JSON.parse(result.message.content)).toMatchObject({ prepared: true, confirmation_required: true });
    expect(messages(view.requests)).toHaveLength(0);
    expect(view.container.textContent).toContain("Send task to Synthetic owner agent");
    await expect(callAction("agents.delegate", { task: text, agent_id: otherId })).rejects.toThrow();
    expect(messages(view.requests)).toHaveLength(0);
  } finally { await view.cleanup(); }
});

test("an interrupted delegated request is fenced and never automatically resent", async () => {
  const view = await mounted({ interrupted: true });
  try {
    await act(async () => { await view.handlers.chat!(text); }); await view.settle(); await view.click("Confirm");
    expect(messages(view.requests)).toHaveLength(1);
    expect(view.container.textContent).toContain("Review the interrupted task");
    await act(async () => { await view.handlers.chat!(text); }); await view.settle();
    expect(messages(view.requests)).toHaveLength(1);
    expect(view.requests.some((r) => r.url.pathname === "/api/v1/jobs")).toBe(false);
  } finally { await view.cleanup(); }
});

test("plain video requests with no available video catalog offer an explicit hosted-agent review without inventing a model", async () => {
  const view = await mounted();
  try {
    await act(async () => { await view.handlers.chat!("make me a cat video"); }); await view.settle();
    expect(view.requests.some((r) => r.url.pathname === "/api/v1/chat/completions" || r.url.pathname === "/api/v1/jobs")).toBe(false);
    expect(view.container.textContent).toContain("Blender");
    await view.click("Use hosted agent");
    expect(view.container.textContent).toContain("Send task to Synthetic owner agent");
    expect(messages(view.requests)).toHaveLength(0);
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
