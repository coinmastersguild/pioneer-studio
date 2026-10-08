import { afterEach, expect, test } from "bun:test";
import { getAgentMemory, setAgentMemoryEnabled, parseAgentMemory, memoryAvailability } from "./agentMemory";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const memory = { configured: true, enabled: true, storage: "host-managed", operations: ["retain", "recall"],
  recent_operations: [{ operation: "retain", ts: 1_791_376_000, status: "ok" }] };

test("memory metadata never carries fact content, bank identity or undeclared fields into the UI", () => {
  const parsed = parseAgentMemory({ ...memory, facts: "private-fact-fixture", bank: "private-bank-fixture",
    recent_operations: [{ ...memory.recent_operations[0], content: "private-fact-fixture", token: "private-token-fixture" }] });
  expect(parsed).toEqual(memory);
  expect(JSON.stringify(parsed)).not.toContain("private-");
  for (const invalid of [{ ...memory, enabled: "true" }, { ...memory, storage: "external-url" },
    { ...memory, recent_operations: [{ operation: "delete", ts: 1, status: "ok" }] }]) expect(() => parseAgentMemory(invalid)).toThrow();
});

test("memory is available only when both configured and enabled, and pausing does not claim erasure", () => {
  expect(memoryAvailability(memory)).toBe("Available");
  expect(memoryAvailability({ ...memory, configured: false })).toBe("Unavailable");
  expect(memoryAvailability({ ...memory, enabled: false })).toBe("Paused");
});

test("owner memory controls issue only the exact enabled boolean with no idempotency or deletion request", async () => {
  const requests: { url: string; method: string; body: unknown; headers: Headers }[] = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) });
    return Response.json({ ...memory, enabled: init?.body ? JSON.parse(String(init.body)).enabled : true });
  }) as typeof fetch;
  const id = "10000000-0000-4000-8000-000000000001";
  expect((await getAgentMemory("fixture-owner", id)).enabled).toBe(true);
  expect((await setAgentMemoryEnabled("fixture-owner", id, false)).enabled).toBe(false);
  expect(requests.map((r) => [r.method, r.body])).toEqual([["GET", null], ["PATCH", { enabled: false }]]);
  expect(requests.every((r) => r.url.endsWith(`/${id}/memory`))).toBe(true);
  expect(requests[1].headers.has("Idempotency-Key")).toBe(false);
  expect(requests[1].headers.get("Authorization")).toBe("Bearer fixture-owner");
});
