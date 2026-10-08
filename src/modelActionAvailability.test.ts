import { expect, test } from "bun:test";
import type { JobModel } from "./api";
import { actionTools, callAction, clearActions, registerActions } from "./control";
import { modelActionAvailable } from "./modelActionAvailability";

const image: JobModel = { model: "new-image", endpoint: "generate", credits: 1, note: "", result: "binary", result_ext: ".png", params: { prompt: { type: "str" } } };
const motionVideo: JobModel = { model: "new-pose-renderer", endpoint: "finish", credits: 3, note: "", result: "binary", result_ext: ".mp4", params: { control_video: { type: "path-or-url" }, prompt: { type: "str" } } };

test("model-dependent view actions cannot spend when their catalog lane is unavailable", async () => {
  let renders = 0; let recordings = 0;
  try {
    for (const state of [{ models: [], catalogAvailable: true }, { models: [motionVideo], catalogAvailable: false }, { models: [image], catalogAvailable: true }]) {
      registerActions([
        { name: "animate.enhance_take", available: modelActionAvailable(state, "motion_video"), description: "Paid pose video", run: () => { renders++; } },
        { name: "animate.record_take", description: "Free canvas recording", run: () => { recordings++; } },
      ]);
      expect(actionTools().some((tool) => tool.function.name === "animate_enhance_take")).toBe(false);
      await expect(callAction("animate.enhance_take")).rejects.toThrow("unavailable");
      await callAction("animate.record_take");
    }
    expect(renders).toBe(0); expect(recordings).toBe(3);
    registerActions([{ name: "animate.enhance_take", available: modelActionAvailable({ models: [motionVideo], catalogAvailable: true }, "motion_video"), description: "Paid pose video", run: () => { renders++; } }]);
    expect(actionTools().some((tool) => tool.function.name === "animate_enhance_take")).toBe(true);
    await callAction("animate.enhance_take"); expect(renders).toBe(1);
    registerActions([{ name: "animate.enhance_take", available: modelActionAvailable({ models: [motionVideo], catalogAvailable: false }, "motion_video"), description: "Catalog outage", run: () => { renders++; } }]);
    await expect(callAction("animate.enhance_take")).rejects.toThrow("unavailable");
    expect(renders).toBe(1);
  } finally { clearActions(); }
});

test("image and final-video actions follow schema-derived capabilities rather than provider names", () => {
  expect(modelActionAvailable({ models: [image], catalogAvailable: true }, "image")).toBe(true);
  expect(modelActionAvailable({ models: [motionVideo], catalogAvailable: true }, "image")).toBe(false);
  expect(modelActionAvailable({ models: [image], catalogAvailable: true }, "video")).toBe(false);
  expect(modelActionAvailable({ models: [motionVideo], catalogAvailable: true }, "video")).toBe(false);
  const video: JobModel = { model: "another-provider", endpoint: "generate", credits: 2, note: "", result: "binary", result_ext: ".mp4", params: { prompt: { type: "str" } } };
  expect(modelActionAvailable({ models: [video], catalogAvailable: true }, "video")).toBe(true);
});
