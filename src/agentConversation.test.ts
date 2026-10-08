import { expect, test } from "bun:test";
import { AgentConversations, desktopRuntimeChanged } from "./agentConversation";

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
