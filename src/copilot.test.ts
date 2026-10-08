import { expect, test } from "bun:test";
import { requestJobPlan } from "./copilot";
import type { JobModel } from "./api";

test("job planner advertises only live flows and never forces a job after an unavailable clarification", async () => {
  const original = globalThis.fetch;
  let prompt = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    prompt = JSON.parse(String(init?.body)).messages[0].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"say":"No live generation endpoint is available."}' } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    await requestJobPlan("test-key", [], [], "A cat in a garden", undefined, [{ role: "assistant", content: "I asked: Which scene?" }]);
    expect(prompt).toContain("Do not invent");
    expect(prompt).toContain("unavailable");
    expect(prompt).not.toContain("you MUST act");
    expect(prompt).not.toContain("LTX");
    expect(prompt).not.toContain("- video-control");
    expect(prompt).not.toContain("- talking-head");
    const live: JobModel = { model: "ltx-enhance", endpoint: "enhance", credits: 12, note: "", result: "binary", result_ext: ".mp4" };
    await requestJobPlan("test-key", [live], [], "Make a controlled video");
    expect(prompt).toContain("- video-control");
    expect(prompt).toContain("ltx-enhance.enhance (12 cr)");
    expect(prompt).not.toContain("- talking-head");
  } finally { globalThis.fetch = original; }
});
