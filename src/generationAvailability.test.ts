import { expect, test } from "bun:test";
import { actionTools, callAction, clearActions, registerActions } from "./control";
import { createGenerationAction } from "./generationJob";

test("an unavailable or empty generation catalog cannot advertise or invoke a paid Copilot tool", async () => {
  let submits = 0;
  const context = { apiKey: "fixture-only", models: [], media: null, charge() {}, waitForJob: async () => ({ url: "", contentType: "" }), submit: async () => { submits++; throw new Error("Must not submit"); } };
  try {
    for (const catalogAvailable of [false, true]) {
      clearActions(); registerActions([createGenerationAction({ ...context, catalogAvailable })]);
      expect(actionTools().some((tool) => tool.function.name === "jobs_submit")).toBe(false);
      await expect(callAction("jobs.submit", { model: "ltx-video", endpoint: "generate", params: { prompt: "cat" } })).rejects.toThrow();
    }
    expect(submits).toBe(0);
  } finally { clearActions(); }
});
