import { expect, test } from "bun:test";
import { dispatchWorkspaceInput } from "./workspaceInput";

test("the Agents composer reaches the selected hosted agent handler", () => {
  const calls: string[] = [];
  expect(dispatchWorkspaceInput("agents", "Build a scene", {
    agents: (text) => { calls.push(`agent:${text}`); },
    chat: (text) => { calls.push(`chat:${text}`); },
  })).toBe("handled");
  expect(calls).toEqual(["agent:Build a scene"]);
});

test("an unavailable hosted-agent handler cannot fall through to the media copilot", () => {
  expect(dispatchWorkspaceInput("agents", "Build a scene", {})).toBe("unavailable");
});

test("Chat keeps its planner while editing modes use the shared copilot", () => {
  const calls: string[] = [];
  expect(dispatchWorkspaceInput("chat", "Plan it", { chat: (text) => { calls.push(text); } })).toBe("handled");
  expect(calls).toEqual(["Plan it"]);
  expect(dispatchWorkspaceInput("studio", "Move the camera", {})).toBe("copilot");
});
