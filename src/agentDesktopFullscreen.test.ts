import { expect, test } from "bun:test";
import { requestDesktopFullscreen } from "./agentDesktopFullscreen";

test("a rejected full-screen request resolves to fixed window-viewing guidance", async () => {
  let calls = 0;
  const message = await requestDesktopFullscreen({ requestFullscreen: async () => {
    calls++; throw new Error("fixture-never-expose-browser-error");
  } });
  expect(calls).toBe(1);
  expect(message).toBe("Browser full screen is unavailable. The full desktop remains viewable in this window.");
  expect(message).not.toContain("fixture-never-expose-browser-error");
});

test("missing or synchronously rejected full-screen APIs do not escape the viewer", async () => {
  const guidance = "Browser full screen is unavailable. The full desktop remains viewable in this window.";
  expect(await requestDesktopFullscreen(null)).toBe(guidance);
  expect(await requestDesktopFullscreen({})).toBe(guidance);
  expect(await requestDesktopFullscreen({ requestFullscreen() { throw new Error("unavailable"); } })).toBe(guidance);
});

test("a successful full-screen request uses the target receiver and clears previous guidance", async () => {
  const target = { calls: 0, async requestFullscreen() { this.calls++; } };
  expect(await requestDesktopFullscreen(target)).toBeNull();
  expect(target.calls).toBe(1);
});
