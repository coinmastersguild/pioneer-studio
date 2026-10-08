import { expect, test } from "bun:test";
import { AgentConversations, desktopRuntimeChanged, desktopRuntimeUnavailable } from "./agentConversation";

test("returning to an agent keeps its conversation while other agents and sign-ins stay separate", () => {
  const conversations = new AgentConversations();
  const first = conversations.forAgent("agent-a");
  expect(conversations.forAgent("agent-b")).not.toBe(first);
  expect(conversations.forAgent("agent-a")).toBe(first);
  conversations.clear();
  expect(conversations.forAgent("agent-a")).not.toBe(first);
});

test("a viewed desktop is invalidated by a known generation change, not a transient missing observation", () => {
  const opened = { agentId: "agent-a", generation: 4 };
  expect(desktopRuntimeChanged(opened, "agent-a", 4)).toBe(false);
  expect(desktopRuntimeChanged(opened, "agent-a", undefined)).toBe(false);
  expect(desktopRuntimeChanged(opened, "agent-a", 5)).toBe(true);
  expect(desktopRuntimeChanged(opened, "agent-b", 4)).toBe(true);
});

test("an uncertain or active conversation cannot dispatch another non-idempotent turn until explicit reconciliation", () => {
  const conversations = new AgentConversations();
  conversations.begin("agent-a");
  expect(() => conversations.begin("agent-a")).toThrow();
  conversations.finish("agent-a", false);
  expect(conversations.needsReview("agent-a")).toBe(true);
  expect(() => conversations.begin("agent-a")).toThrow();
  conversations.begin("agent-b");
  conversations.finish("agent-b", true);
  expect(conversations.needsReview("agent-b")).toBe(false);
  conversations.reviewed("agent-a");
  expect(conversations.needsReview("agent-a")).toBe(false);
  conversations.begin("agent-a");
  conversations.finish("agent-a", true);
  expect(conversations.needsReview("agent-a")).toBe(false);
});


test("an active desktop survives absent list-summary detail but closes on explicit observed stop or removal", () => {
  const agent = { template: "openhuman", status: "running", live: { budget_tokens: 100, used_tokens: 0, remaining_tokens: 100, container: "running", state: "running", status: "active" } };
  expect(desktopRuntimeUnavailable({ ...agent, live: null })).toBe(false);
  expect(desktopRuntimeUnavailable({ ...agent, live: { ...agent.live, container: undefined } })).toBe(false);
  expect(desktopRuntimeUnavailable({ ...agent, status: "paused_budget" })).toBe(false);
  expect(desktopRuntimeUnavailable(agent)).toBe(false);
  for (const status of ["suspended", "deleted", "failed"]) expect(desktopRuntimeUnavailable({ ...agent, status })).toBe(true);
  for (const container of ["exited", "missing"]) expect(desktopRuntimeUnavailable({ ...agent, live: { ...agent.live, container } })).toBe(true);
  expect(desktopRuntimeUnavailable({ ...agent, live: { ...agent.live, status: "suspended" } })).toBe(true);
});

test("a new conversation changes only its session and requires a settled prior turn", () => {
  const conversations = new AgentConversations();
  const first = conversations.forAgent("agent-a"), other = conversations.forAgent("agent-b");
  conversations.begin("agent-a");
  expect(() => conversations.startNew("agent-a")).toThrow();
  conversations.finish("agent-a", false);
  expect(() => conversations.startNew("agent-a")).toThrow();
  conversations.reviewed("agent-a");
  expect(conversations.startNew("agent-a")).not.toBe(first);
  expect(conversations.forAgent("agent-b")).toBe(other);
});
