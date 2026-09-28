import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import PreviewBoundary from "./PreviewBoundary";

test("a failed 3D mount preserves sibling authoring controls and can be retried", async () => {
  const browser = new Window();
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: browser,
    document: browser.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const caught: unknown[] = [];
  const root = createRoot(container as unknown as HTMLElement, { onCaughtError: (error) => caught.push(error) });
  let webglAvailable = false;
  let mounts = 0;
  function Preview() {
    useEffect(() => {
      mounts++;
      if (!webglAvailable) throw new Error("Error creating WebGL context.");
    }, []);
    return createElement("canvas", { "aria-label": "3D scene" });
  }
  function Projects() {
    const [open, setOpen] = useState(false);
    return createElement("button", { id: "projects", onClick: () => setOpen(true) }, open ? "Project open" : "Open project");
  }
  try {
    await act(async () => {
      root.render(createElement("main", null,
        createElement(Projects),
        createElement(PreviewBoundary, { label: "Animation preview" }, createElement(Preview)),
      ));
    });
    expect(caught).toHaveLength(1);
    expect(container.textContent).toContain("Animation preview unavailable");
    expect(container.querySelector("canvas")).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>("#projects")!.click());
    expect(container.textContent).toContain("Project open");

    // Retrying while graphics are still unavailable remains contained.
    await act(async () => container.querySelector<HTMLButtonElement>(".preview-unavailable button")!.click());
    expect(caught).toHaveLength(2);
    expect(container.textContent).toContain("Project open");

    webglAvailable = true;
    await act(async () => container.querySelector<HTMLButtonElement>(".preview-unavailable button")!.click());
    expect(mounts).toBe(3);
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(container.querySelector(".preview-unavailable")).toBeNull();
    expect(container.textContent).toContain("Project open");
  } finally {
    await act(async () => root.unmount());
    await browser.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
