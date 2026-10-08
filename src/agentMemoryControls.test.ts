import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import AgentMemoryPanel from "./AgentMemoryPanel";

test("memory pause requires explicit confirmation and displays metadata without facts or provider setup", async () => {
  const browser = new Window();
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const originalFetch = globalThis.fetch;
  const requests: { method: string; body: unknown }[] = [];
  let enabled = true, configured = true;
  globalThis.fetch = (async (_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method: init?.method || "GET", body });
    if (body) enabled = body.enabled;
    return Response.json({ configured, enabled, storage: "host-managed", operations: ["retain", "recall"],
      recent_operations: [{ operation: "retain", ts: 1_791_376_000, status: "ok", content: "never-display-fact-fixture" }] });
  }) as typeof fetch;
  for (const [name, value] of Object.entries({ window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label)!;
  try {
    await act(async () => root.render(createElement(AgentMemoryPanel, { apiKey: "fixture-owner", agentId: "fixture-a", onClose() {} })));
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
    expect(container.textContent).toContain("Available");
    expect(container.textContent).toContain("does not delete");
    expect(container.textContent).toContain("not included");
    expect(container.textContent).not.toContain("never-display-fact-fixture");
    await act(async () => button("Pause memory").click());
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
    await act(async () => button("Confirm pause").click());
    expect(requests.filter((r) => r.method === "PATCH")).toEqual([{ method: "PATCH", body: { enabled: false } }]);
    expect(container.textContent).toContain("Paused");
    expect(button("Resume memory").disabled).toBe(false);
    configured = false;
    await act(async () => root.render(createElement(AgentMemoryPanel, { apiKey: "fixture-owner", agentId: "fixture-b", onClose() {} })));
    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).not.toContain("API key");
    expect(container.textContent).not.toContain("provider");
    expect(container.querySelector('[data-memory-toggle]')).toBeNull();
  } finally {
    await act(async () => root.unmount()); browser.happyDOM.abort(); globalThis.fetch = originalFetch;
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
