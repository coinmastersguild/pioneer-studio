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
