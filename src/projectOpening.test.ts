import { expect, test } from "bun:test";
import { projectOpeningMode, type Shot } from "./api";

test("a project authored only in Studio opens its saved timeline", () => {
  const savedCampaign = { shots: [], studioTimeline: { version: 2, clips: [{ id: "footage" }, { id: "narration" }] } };
  expect(projectOpeningMode(savedCampaign)).toBe("studio");
  expect(projectOpeningMode(JSON.parse(JSON.stringify(savedCampaign)))).toBe("studio");
});

test("storyboard and empty projects keep the storyboard landing", () => {
  expect(projectOpeningMode({ shots: [{ id: "beat" } as Shot], studioTimeline: { clips: [{ id: "footage" }] } })).toBe("board");
  for (const studioTimeline of [undefined, null, {}, { clips: [] }, { clips: "invalid" }]) {
    expect(projectOpeningMode({ shots: [], studioTimeline })).toBe("board");
  }
});
