import { afterEach, expect, test } from "bun:test";
import { streamAgentMessage } from "./api";
import { agentReplyPlaceholder, observeAgentReply, type AgentReplyState } from "./agentReply";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
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
