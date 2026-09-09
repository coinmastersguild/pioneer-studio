import { expect, test } from "bun:test";
import { ChatRunTracker } from "./chatActivity";

test("chat generations remain active until each independent run finishes", () => {
  const runs = new ChatRunTracker();

  expect(runs.start("first")).toEqual({ count: 1, label: "thinking", working: true });
  expect(runs.setStage("first", "running")).toEqual({ count: 1, label: "running", working: true });
  expect(runs.start("second")).toEqual({ count: 2, label: "2 generations running", working: true });

  // Completing one request must not unlock/reset the status of the other.
  expect(runs.finish("first")).toEqual({ count: 1, label: "thinking", working: true });
  expect(runs.setStage("second", "reviewing the result")).toEqual({
    count: 1,
    label: "reviewing the result",
    working: true,
  });
  expect(runs.finish("second")).toEqual({ count: 0, label: "idle", working: false });
});
