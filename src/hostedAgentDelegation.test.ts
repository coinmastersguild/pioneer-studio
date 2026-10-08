import { expect, test } from "bun:test";
import type { ChatMessage, JobModel } from "./api";
import { hostedAgentRequest, prepareHostedAgentTask, unavailableVideoRequest } from "./hostedAgentDelegation";

test("explicit hosted-agent requests preserve the complete goal before generation routing", () => {
  for (const goal of [
    "tell the agent to make me a cat video",
    "Please ask my agent to animate a cat walking.",
    "Have the hosted agent build a scene in Blender.",
    "Delegate this to the agent: author and render a short movie.",
    "I want the agent to make a spinning cube.",
    "Can you use the agent to render this scene?",
  ]) expect(hostedAgentRequest(goal)).toBe(goal);
  expect(hostedAgentRequest("Generate a cat video using the live model catalog")).toBeNull();
  expect(hostedAgentRequest("What does an agent do?")).toBeNull();
});

test("a legacy clarification retains delegation only until the asked question is answered", () => {
  const original = "tell the agent to make me a cat video";
  const history: ChatMessage[] = [
    { role: "user", content: original },
    { role: "assistant", content: "I asked: What scene should it show?" },
  ];
  expect(hostedAgentRequest("A cat walking through a garden", history)).toBe(`${original}\n\nClarification: A cat walking through a garden`);
  expect(hostedAgentRequest("Make a bird image", [...history, { role: "assistant", content: "The task was prepared for confirmation." }])).toBeNull();
  expect(hostedAgentRequest("A garden", [{ role: "user", content: "make a video" }, history[1]])).toBeNull();
});

test("video generation availability uses live catalog output formats, never provider-name guesses", () => {
  const image: JobModel = { model: "ltx-video", endpoint: "generate", credits: 1, note: "not video", result: "binary", result_ext: ".png" };
  const video: JobModel = { model: "new-model", endpoint: "clip", credits: 1, note: "", result: "binary", result_ext: ".mp4" };
  expect(unavailableVideoRequest("make me a cat video", [image], true)).toBe(true);
  expect(unavailableVideoRequest("animate a cat", [video], false)).toBe(true);
  expect(unavailableVideoRequest("make a cat video", [video], true)).toBe(false);
  expect(unavailableVideoRequest("make a cat image", [], false)).toBe(false);
});

test("prepared authoring instructions preserve intent and require genuine saved video evidence", () => {
  const task = prepareHostedAgentTask("make me a cat video with a blue sky");
  expect(task).toContain("make me a cat video with a blue sky");
  expect(task).toContain("tools actually available");
  expect(task).toContain(".mp4");
  expect(task).toContain(".blend");
  expect(task).toContain("distinct frames");
  expect(task).toContain("PNG");
  expect(task).toContain("Do not invent");
});

test("task preparation refuses lifecycle commands and enforces the complete UTF-8 payload bound", () => {
  for (const goal of ["", "   ", "/delete", "/topup 100", "/unlock key", "🚀".repeat(4097)]) {
    expect(() => prepareHostedAgentTask(goal)).toThrow();
  }
  const task = prepareHostedAgentTask("Write notes about /api/v1/files, with Unicode ✓.");
  expect(new TextEncoder().encode(task).length).toBeLessThanOrEqual(16 * 1024);
  expect(task).toContain("/api/v1/files");
  expect(() => prepareHostedAgentTask("x".repeat(16 * 1024))).toThrow("16 KiB");
});

test("a trusted per-task output name binds acceptance to newly authored video files", () => {
  const prefix = "studio-6e02fb36-d1c8-4cef-a6a8-5ca6f1fc1532";
  const task = prepareHostedAgentTask("make a cat video", prefix);
  expect(task).toContain(`desktop-test/${prefix}.mp4`);
  expect(task).toContain(`desktop-test/${prefix}.blend`);
  expect(task).toContain("MP4");
  expect(task).toContain("exact tool schema");
  for (const invalid of ["../escape", "existing-video", "studio-" + "-".repeat(36), prefix.toUpperCase(), `${prefix}/file`]) {
    expect(() => prepareHostedAgentTask("make a cat video", invalid)).toThrow("output name");
  }
});


test("video task preparation requires actual visual framing and lighting review, not just a saved filename", () => {
  const task=prepareHostedAgentTask("tell the agent to make a neon cat animation");
  expect(task).toContain("visually inspect"); expect(task).toContain("complete subject framing"); expect(task).toContain("requested lighting");
});
