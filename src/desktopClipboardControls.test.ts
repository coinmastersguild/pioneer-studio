import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import AgentDesktopClipboard from "./AgentDesktopClipboard";

test("desktop clipboard sends and copies only on explicit clicks, clearing the input after every attempt", async () => {
  const browser = new Window();
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const copied: string[] = [], sent: string[] = [];
  let reads = 0;
  Object.defineProperty(browser.navigator, "clipboard", { value: {
    readText: async () => { reads++; return "never automatically read"; },
    writeText: async (text: string) => { copied.push(text); },
  } });
  for (const [name, value] of Object.entries({ window: browser, document: browser.document,
    navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label)!;
  try {
    await act(async () => root.render(createElement(AgentDesktopClipboard, {
      connected: true, receivedText: "harmless desktop fixture", onSend: (text: string) => sent.push(text),
    })));
    expect(reads).toBe(0); expect(sent).toEqual([]); expect(copied).toEqual([]);
    const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text to send to desktop"]')!;
    await act(async () => { input.value = "harmless user fixture"; input.dispatchEvent(new browser.Event("input", { bubbles: true })); });
    expect(sent).toEqual([]);
    await act(async () => button("Send to desktop").click());
    expect(sent).toEqual(["harmless user fixture"]); expect(input.value).toBe("");
    expect(container.textContent).toContain("Ctrl+V");
    await act(async () => button("Copy from desktop").click());
    expect(copied).toEqual(["harmless desktop fixture"]); expect(reads).toBe(0);
    await act(async () => root.render(createElement(AgentDesktopClipboard, {
      connected: true, receivedText: null, onSend: () => { throw new Error("fixture-never-expose-this"); },
    })));
    await act(async () => { input.value = "failed fixture"; input.dispatchEvent(new browser.Event("input", { bubbles: true })); });
    await act(async () => button("Send to desktop").click());
    expect(input.value).toBe(""); expect(container.textContent).not.toContain("fixture-never-expose-this");
    await act(async () => root.render(createElement(AgentDesktopClipboard, { connected: false, receivedText: null, onSend() {} })));
    expect(button("Send to desktop").disabled).toBe(true);
    expect(reads).toBe(0);
    browser.navigator.clipboard.writeText = () => new Promise<void>(() => {});
    await act(async () => root.render(createElement(AgentDesktopClipboard, { connected: true, receivedText: "manual fixture", onSend() {} })));
    await act(async () => button("Copy from desktop").click());
    expect(container.textContent).toContain("Copying to your browser clipboard");
    expect(button("Copy from desktop").disabled).toBe(true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3050)); });
    expect(container.textContent).toContain("Select the text in Copied on desktop and copy it manually");
    expect(container.textContent).not.toContain("Desktop text copied to your clipboard");
    expect(button("Copy from desktop").disabled).toBe(false);
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text copied on desktop"]')!.value).toBe("manual fixture");
    expect(reads).toBe(0);
  } finally {
    await act(async () => root.unmount());
    browser.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
