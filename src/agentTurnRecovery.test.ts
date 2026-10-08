import { afterEach, expect, test } from "bun:test";
import { inspectAgentTurnRecovery, confirmAgentTurnRecovery } from "./agentTurnRecovery";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const id = "00000000-0000-4000-8000-000000000101", turn = "00000000-0000-4000-8000-000000000202";

test("a running server turn cannot offer recovery or dispatch a reconcile request", async () => {
  const methods: string[] = [];
  globalThis.fetch = (async (_url, init) => { methods.push(init?.method || "GET"); return Response.json({ state: "running", turn_id: turn }); }) as typeof fetch;
  await expect(inspectAgentTurnRecovery("fixture-owner", id, "session")).rejects.toThrow("still running");
  expect(methods).toEqual(["GET"]);
});

test("an uncertain turn reconciles only the observed bound ID after an explicit stopped-task confirmation", async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ path: new URL(String(input)).pathname, method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json(init?.method === "POST" ? { state: "idle" } : { state: "uncertain", turn_id: turn });
  }) as typeof fetch;
  const plan = await inspectAgentTurnRecovery("fixture-owner", id, "session");
  expect(requests.map((r) => r.method)).toEqual(["GET"]);
  await confirmAgentTurnRecovery("fixture-owner", id, "session", plan);
  expect(requests.map((r) => r.method)).toEqual(["GET", "GET", "POST"]);
  expect(requests[2].body).toEqual({ session: "session", turn_id: turn, confirmed_stopped: true });
  expect(requests[2].path.endsWith("/messages/reconcile")).toBe(true);
  expect(requests.some((r) => r.path.endsWith("/messages"))).toBe(false);
});

test("a turn changing after the initial review cannot be silently confirmed or cleared", async () => {
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "POST") throw new Error("must not post");
    calls++;
    return Response.json({ state: "uncertain", turn_id: calls === 1 ? turn : "00000000-0000-4000-8000-000000000303" });
  }) as typeof fetch;
  const plan = await inspectAgentTurnRecovery("fixture-owner", id, "session");
  await expect(confirmAgentTurnRecovery("fixture-owner", id, "session", plan)).rejects.toThrow("changed");
  expect(calls).toBe(2);
});
