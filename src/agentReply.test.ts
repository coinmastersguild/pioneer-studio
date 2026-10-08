import { afterEach, expect, test } from "bun:test";
import { AgentApiError, agentRequest, streamAgentMessage } from "./api";
import { agentReplyPlaceholder, observeAgentReply, type AgentReplyState } from "./agentReply";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; });
const id = "00000000-0000-4000-8000-000000000001";
function response(value: string) {
  return new Response(value, { headers: { "Content-Type": "text/event-stream" } });
}

test("a successful empty SSE reply ends progress without claiming task success", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return response("data: [DONE]\n\n"); }) as typeof fetch;
  const states: AgentReplyState[] = [];
  let text = "";
  await observeAgentReply(() => streamAgentMessage("fixture-owner", id, "Author a scene", "session", (chunk) => { text += chunk; }), (state) => states.push(state));
  expect(states).toEqual(["streaming", "complete"]);
  expect(text).toBe("");
  expect(agentReplyPlaceholder(states.at(-1))).toContain("ended without text");
  expect(agentReplyPlaceholder(states.at(-1))).toContain("files and runtime logs");
  expect(agentReplyPlaceholder(states.at(-1))).not.toContain("Working");
  expect(calls).toBe(1);
});

test("an interrupted reply keeps partial text and never resends the paid task", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return response('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'); }) as typeof fetch;
  const states: AgentReplyState[] = [];
  let text = "";
  await expect(observeAgentReply(() => streamAgentMessage("fixture-owner", id, "Author a scene", "session", (chunk) => { text += chunk; }), (state) => states.push(state))).rejects.toThrow("task may still be running");
  expect(states).toEqual(["streaming", "interrupted"]);
  expect(text).toBe("Partial");
  expect(agentReplyPlaceholder(states.at(-1))).toContain("may still be running");
  expect(calls).toBe(1);
});

test("only an active reply uses the working placeholder", () => {
  expect(agentReplyPlaceholder("streaming")).toBe("Working…");
  expect(agentReplyPlaceholder(undefined)).toBe("");
});

test("heartbeat comments keep a task waiting until its completed-content delta and DONE", async () => {
  let calls = 0;
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  globalThis.fetch = (async () => { calls++; return new Response(new ReadableStream({ start(c) { source = c; } }), { headers: { "Content-Type": "text/event-stream" } }); }) as typeof fetch;
  const states: AgentReplyState[] = [];
  const replies: string[] = [];
  const running = observeAgentReply(() => streamAgentMessage("fixture-owner", id, "Inspect local output", "stable-conversation", (text) => replies.push(text)), (state) => states.push(state));
  await Promise.resolve();
  source.enqueue(encoder.encode(": heartbeat\r\n\r\n: heartbeat\r\n\r\n"));
  await Promise.resolve();
  expect(states).toEqual(["streaming"]);
  expect(replies).toEqual([]);
  // Split inside a multibyte character and across CRLF event boundaries.
  const final = encoder.encode('data: {"choices":[{"delta":{"content":"Finished ✓"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n');
  const cut = final.indexOf(0xe2) + 1;
  source.enqueue(final.slice(0, cut)); source.enqueue(final.slice(cut)); source.close();
  await running;
  expect(replies).toEqual(["Finished ✓"]);
  expect(states).toEqual(["streaming", "complete"]);
  expect(calls).toBe(1);
});

test("a complete message frame replaces compatibility deltas without duplicating its final reply", async () => {
  let calls = 0;
  const updates: [string, string | undefined][] = [];
  globalThis.fetch = (async () => { calls++; return response('data: {"choices":[{"delta":{"content":"Draft"}}]}\n\ndata: {"choices":[{"message":{"content":"Final answer"}}]}\n\ndata: [DONE]\n\n'); }) as typeof fetch;
  await streamAgentMessage("fixture-owner", id, "Inspect output", "stable-conversation", (text, mode) => updates.push([text, mode]));
  expect(updates).toEqual([["Draft", "append"], ["Final answer", "replace"]]);
  expect(calls).toBe(1);
});

test("control and stream failures normalize error and detail envelopes without replay", async () => {
  const examples = [
    { body: { detail: { code: "agent_unavailable", message: "Runtime task failed" } }, code: "agent_unavailable", message: "Runtime task failed" },
    { body: { error: { code: "budget_exhausted", message: "Token budget exhausted" } }, code: "budget_exhausted", message: "Token budget exhausted" },
    { body: { detail: "Task validation failed" }, code: "request_failed", message: "Task validation failed" },
  ];
  for (const example of examples) {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json(example.body, { status: 503, headers: { "Retry-After": "2" } }); }) as typeof fetch;
    try { await agentRequest("fixture-owner", "/fixture"); throw new Error("request unexpectedly passed"); }
    catch (error) {
      expect(error).toBeInstanceOf(AgentApiError);
      expect((error as AgentApiError).code).toBe(example.code);
      expect((error as AgentApiError).message).toBe(example.message);
      expect((error as AgentApiError).retryAfter).toBe(2);
    }
    expect(calls).toBe(1);
  }
  let calls = 0;
  let text = "";
  globalThis.fetch = (async () => { calls++; return response(': heartbeat\n\ndata: {"choices":[{"delta":{"content":"Partial"}}]}\n\nevent: error\ndata: {"detail":{"code":"agent_unavailable","message":"Runtime task failed"},"status":503}\n\n'); }) as typeof fetch;
  try { await streamAgentMessage("fixture-owner", id, "Author output", "stable-conversation", (chunk) => { text += chunk; }); throw new Error("stream unexpectedly passed"); }
  catch (error) {
    expect(error).toBeInstanceOf(AgentApiError);
    expect((error as AgentApiError).code).toBe("agent_unavailable");
    expect((error as AgentApiError).status).toBe(503);
    expect((error as AgentApiError).message).toBe("Runtime task failed");
  }
  expect(text).toBe("Partial"); expect(calls).toBe(1);
});

test("a hung paid task has a 900-second service allowance plus grace and never retries on timeout", async () => {
  let expire!: () => void;
  let delay = 0, calls = 0, cancelled = false;
  let requestSignal!: AbortSignal;
  globalThis.setTimeout = ((callback: () => void, milliseconds: number) => { expire = callback; delay = milliseconds; return 1; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => { cancelled = true; }) as typeof clearTimeout;
  globalThis.fetch = (async (_input, init) => {
    calls++; requestSignal = init!.signal!;
    return await new Promise<Response>((_resolve, reject) => requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true }));
  }) as typeof fetch;
  const running = streamAgentMessage("fixture-owner", id, "Author output", "stable-conversation", () => {});
  const result = running.catch((error) => error);
  expect(delay).toBe(930_000);
  expire();
  expect((await result).message).toContain("may still be running");
  expect(requestSignal.aborted).toBe(true);
  expect(cancelled).toBe(true);
  expect(calls).toBe(1);
});

test("explicit caller cancellation aborts its sole task request without being called a timeout", async () => {
  let calls = 0;
  const owner = new AbortController();
  globalThis.fetch = (async (_input, init) => {
    calls++;
    const signal = init!.signal!;
    return await new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }) as typeof fetch;
  const running = streamAgentMessage("fixture-owner", id, "Author output", "stable-conversation", () => {}, owner.signal);
  owner.abort(new Error("Owner changed accounts"));
  await expect(running).rejects.toThrow("Owner changed accounts");
  expect(calls).toBe(1);
});

test("malformed stream data and a stop frame without DONE cannot silently complete work", async () => {
  for (const data of ['data: invalid-json\n\n', 'data: {"choices":[{"delta":{"content":"Partial"},"finish_reason":"stop"}]}\n\n']) {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return response(data); }) as typeof fetch;
    await expect(streamAgentMessage("fixture-owner", id, "Inspect output", "stable-conversation", () => {})).rejects.toThrow();
    expect(calls).toBe(1);
  }
});
