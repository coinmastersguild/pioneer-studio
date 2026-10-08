import { afterEach, expect, test } from "bun:test";
import { AgentApiError, setAuthErrorHandler, agentMutation, agentRequest, streamAgentMessage, validateAgentPath, writeAgentFile } from "./api";
import { agentIntentStorageKey, canReplayAgentIntent, loadAgentIntents, newAgentIntent, parseAgentCommand, saveAgentIntents, loadAgentSetup, saveAgentSetup, agentSetupStorageKey, selectVisibleAgent, pendingIntentSummary } from "./hostedAgents";

const originalFetch = globalThis.fetch;
const originalStorage = globalThis.localStorage;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; });
const id = "00000000-0000-4000-8000-000000000001";

test("new-agent GitHub requirements survive reconnect and are isolated by verified owner/network", () => {
  const memory = new Map<string, string>();
  globalThis.localStorage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } } as Storage;
  const owner = "0x" + "ab".repeat(20), other = "0x" + "cd".repeat(20);
  const sk = agentIntentStorageKey(owner, "testnet");
  saveAgentSetup(sk, [id, id]);
  expect(loadAgentSetup(sk)).toEqual([id]);
  expect(loadAgentSetup(agentIntentStorageKey(other, "testnet"))).toEqual([]);
  expect(loadAgentSetup(agentIntentStorageKey(owner, "mainnet"))).toEqual([]);
  expect(() => agentSetupStorageKey("unverified")).toThrow();
  memory.set(agentSetupStorageKey(sk), '["invalid-agent"]');
  expect(() => loadAgentSetup(sk)).toThrow("invalid");
});

test("agent selection ignores deleted agents and foreign callback IDs", () => {
  const agents = [{ id: "deleted", status: "deleted" }, { id, status: "running" }, { id: "second", status: "suspended" }];
  expect(selectVisibleAgent(agents, "deleted")).toBe("");
  expect(selectVisibleAgent(agents, "", "foreign")).toBe("");
  expect(selectVisibleAgent(agents, "missing")).toBe("");
  expect(selectVisibleAgent([{ id, status: "running" }], "missing")).toBe(id);
  expect(selectVisibleAgent(agents, "second", id)).toBe("second");
  expect(selectVisibleAgent(agents, "", "second")).toBe("second");
  expect(selectVisibleAgent([{ id, status: "deleted" }], id)).toBe("");
});

test("uncertain creation identifies the original request without implying deletion", () => {
  const intent = newAgentIntent("", "POST", { name: "testerBot", credits: 100, template: "openclaw" });
  expect(pendingIntentSummary(intent)).toBe("Agent claim: testerBot · 100 credits");
});

test("uncertain purchases survive a fresh wallet session with the same owner and exact body/key", () => {
  const memory = new Map<string, string>();
  globalThis.localStorage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } } as Storage;
  const owner = "0x" + "ab".repeat(20);
  const sk = agentIntentStorageKey(owner, "testnet");
  const intent = newAgentIntent("", "POST", { name: "Agent", credits: 10, template: "openclaw" });
  saveAgentIntents(sk, [intent]);
  expect(loadAgentIntents(agentIntentStorageKey(owner.toUpperCase().replace("0X", "0x"), "testnet"))).toEqual([intent]);
  expect(agentIntentStorageKey(owner, "mainnet")).not.toBe(sk);
  expect(canReplayAgentIntent(intent, intent.createdAt + 29 * 86400000)).toBe(false);
  expect(() => agentIntentStorageKey("unverified", "testnet")).toThrow("Verified");
  const sync = newAgentIntent(`/${"1".repeat(8)}-1111-4111-8111-${"1".repeat(12)}/sync`, "POST", null);
  saveAgentIntents(sk, [intent, sync]);
  expect(loadAgentIntents(sk)).toEqual([intent, sync]);
  expect(pendingIntentSummary(sync)).toBe(`Pull & restart: ${sync.suffix.slice(1, -5)}`);
  memory.set(sk, '[{"key":"broken"}]');
  expect(() => loadAgentIntents(sk)).toThrow("invalid");
});

test("management commands never mistake a task about deletion for an actual deletion", () => {
  expect(parseAgentCommand("/topup 12")).toEqual({ name: "topup", argument: "12" });
  expect(parseAgentCommand("/edit .openclaw/openclaw.json")).toEqual({ name: "edit", argument: ".openclaw/openclaw.json" });
  expect(parseAgentCommand("Create my agent")).toEqual({ name: "new", argument: "" });
  expect(parseAgentCommand("Review the delete handler on GitHub")).toBeNull();
});

test("financial retries preserve their idempotency key and body; deletion sends no body", async () => {
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_url, init) => { calls.push(init!); return Response.json({ agent: { id }, operation: { state: "pending" } }, { status: 202 }); }) as typeof fetch;
  const intent = newAgentIntent(`/${id}`, "PATCH", { credits: 15 });
  await agentMutation("runtime-credential", intent.suffix, intent.method, intent.body, intent.key);
  await agentMutation("runtime-credential", intent.suffix, intent.method, intent.body, intent.key);
  expect(calls[0].body).toBe(calls[1].body);
  expect(calls[0].headers).toEqual(calls[1].headers);
  expect((calls[0].headers as Record<string, string>)["Idempotency-Key"]).toBe(intent.key);
  await agentMutation("runtime-credential", `/${id}?purge=false`, "DELETE", null, "delete-intent-1");
  expect(calls[2].body).toBeUndefined();
});

test("structured API failures retain code and Retry-After", async () => {
  globalThis.fetch = (async () => Response.json({ error: { code: "inference_busy", message: "Busy" } }, { status: 429, headers: { "Retry-After": "17" } })) as typeof fetch;
  try { await agentRequest("runtime-credential", `/${id}`); throw new Error("Expected failure"); }
  catch (error) { expect(error).toBeInstanceOf(AgentApiError); expect((error as AgentApiError).code).toBe("inference_busy"); expect((error as AgentApiError).retryAfter).toBe(17); }
});

test("workspace paths reject traversal, backslashes and encoded paths before network access", async () => {
  for (const path of ["../secret", "/root", "a/../b", "a//b", "a\\b", "%2e%2e/file", "a\u0000b"]) expect(() => validateAgentPath(path)).toThrow();
  expect(validateAgentPath(".openclaw/openclaw.json")).toBe(".openclaw/openclaw.json");
  expect(validateAgentPath("", true)).toBe("");
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ written: true }); }) as typeof fetch;
  await expect(writeAgentFile("runtime-credential", id, "../file", "contents")).rejects.toThrow();
  expect(calls).toBe(0);
});

function sseResponse(text: string) {
  const bytes = new TextEncoder().encode(text);
  // One-byte chunks exercise split delimiters and split multibyte UTF-8.
  return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
}
test("streaming handles fragmented UTF-8, CRLF, keepalives and DONE", async () => {
  globalThis.fetch = (async () => sseResponse(': ping\r\n\r\ndata: {"choices":[{"delta":{"content":"Hello 🌍"}}]}\r\n\r\ndata: [DONE]\r\n\r\n')) as typeof fetch;
  let text = "";
  await streamAgentMessage("runtime-credential", id, "Task", "test-session", (chunk) => { text += chunk; });
  expect(text).toBe("Hello 🌍");
});
test("incomplete and error streams fail without silently replaying the task", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return sseResponse('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'); }) as typeof fetch;
  let text = "";
  await expect(streamAgentMessage("runtime-credential", id, "Task", "test-session", (chunk) => { text += chunk; })).rejects.toThrow("task may still be running");
  expect(text).toBe("Partial"); expect(calls).toBe(1);
  globalThis.fetch = (async () => sseResponse('event: error\ndata: {"error":{"code":"budget_exhausted","message":"Budget exhausted"}}\n\n')) as typeof fetch;
  await expect(streamAgentMessage("runtime-credential", id, "Task", "test-session", () => {})).rejects.toThrow("Budget exhausted");
});

test("agent requests report rejected credentials to the shell session guard", async () => {
  const rejected: string[] = [];
  globalThis.fetch = (async () => Response.json({ error: { code: "unauthorized", message: "Session expired" } }, { status: 401 })) as typeof fetch;
  setAuthErrorHandler((key) => rejected.push(key));
  try {
    await expect(agentRequest("expired-credential", `/${id}`)).rejects.toThrow("Session expired");
    expect(rejected).toEqual(["expired-credential"]);
  } finally { setAuthErrorHandler(); }
});
