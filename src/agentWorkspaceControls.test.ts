import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import AgentWorkspace from "./AgentWorkspace";

test("projects and workspace are separate authenticated areas and binary artifacts only download on explicit clicks", async () => {
  const browser = new Window();
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const originalFetch = globalThis.fetch;
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const paths: URL[] = [], blobs: Blob[] = [], edited: string[] = [], downloaded: string[] = [];
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input)); paths.push(url);
    if (url.searchParams.get("download") === "true") return new Response(bytes);
    return Response.json({ entries: [{ name: "scene.blend", dir: false, size: 6 }, { name: "render.png", dir: false, size: 6 }, { name: "downloads", dir: true }] });
  }) as typeof fetch;
  URL.createObjectURL = (blob) => { blobs.push(blob as Blob); return "blob:fixture-only"; };
  URL.revokeObjectURL = () => {};
  browser.HTMLAnchorElement.prototype.click = function () { downloaded.push(this.download); };
  for (const [name, value] of Object.entries({ window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const container = browser.document.createElement("div"); browser.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) || [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label)!;
  try {
    await act(async () => root.render(createElement(AgentWorkspace, { apiKey: "fixture-owner", agentId: "fixture-agent", onClose() {}, onEdit: (path: string) => { edited.push(path); } })));
    expect(paths[0].searchParams.get("area")).toBe("projects");
    expect(blobs).toEqual([]); expect(downloaded).toEqual([]); expect(edited).toEqual([]);
    expect(container.querySelector('button[aria-label="Edit scene.blend"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Edit render.png"]')).toBeNull();
    await act(async () => button("Download render.png").click());
    expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(bytes);
    expect(downloaded).toEqual(["render.png"]); expect(edited).toEqual([]);
    expect(paths[1].searchParams.get("download")).toBe("true");
    expect(paths[1].searchParams.get("area")).toBe("projects");
    await act(async () => button("Workspace").click());
    expect(paths.at(-1)!.searchParams.get("area")).toBe("workspace");
    expect(paths.at(-1)!.searchParams.get("path")).toBe("");
    await act(async () => button("Open folder downloads").click());
    expect(paths.at(-1)!.searchParams.get("path")).toBe("downloads");
    expect(container.textContent).toContain("saved file");
    expect(container.textContent).not.toContain("fixture-owner");
  } finally {
    await act(async () => root.unmount()); browser.happyDOM.abort(); globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
