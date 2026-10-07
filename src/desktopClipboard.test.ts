import { expect, test } from "bun:test";
import { copyDesktopClipboard, desktopClipboardText, sendDesktopClipboard } from "./desktopClipboard";

test("desktop clipboard preserves literal bounded UTF-8 text without a browser clipboard read", () => {
  const text = "Pioneer clipboard fixture 🌿\n${NAME} is literal";
  const sent: string[] = [];
  let focused = 0;
  sendDesktopClipboard({ clipboardPasteFrom: (value) => sent.push(value), focus: () => focused++ }, true, text);
  expect(sent).toEqual([text]);
  expect(focused).toBe(1);
  expect(desktopClipboardText("a".repeat(16384))).toHaveLength(16384);
  expect(desktopClipboardText("🌿".repeat(4096))).toHaveLength(8192);
});

test("invalid, oversized or disconnected clipboard sends never reach the desktop", () => {
  let sent = 0;
  const target = { clipboardPasteFrom: () => { sent++; }, focus() {} };
  for (const text of ["", "a".repeat(16385), "🌿".repeat(4097), "bad\u0000text"])
    expect(() => sendDesktopClipboard(target, true, text)).toThrow();
  expect(() => sendDesktopClipboard(null, true, "fixture")).toThrow();
  expect(() => sendDesktopClipboard(target, false, "fixture")).toThrow();
  for (const text of [null, undefined, { text: "fixture" }, 12]) expect(() => desktopClipboardText(text)).toThrow();
  expect(sent).toBe(0);
});

test("a pending browser clipboard write ends within a bounded time without claiming success", async () => {
  const copied: string[] = [];
  const started = performance.now();
  const confirmed = await copyDesktopClipboard((text) => { copied.push(text); return new Promise<void>(() => {}); }, "harmless fixture", 5);
  expect(confirmed).toBe(false);
  expect(copied).toEqual(["harmless fixture"]);
  expect(performance.now() - started).toBeLessThan(250);
});

test("browser clipboard copy confirms only a resolved explicit write and keeps errors private", async () => {
  expect(await copyDesktopClipboard(async () => {}, "fixture", 5)).toBe(true);
  expect(await copyDesktopClipboard(undefined, "fixture", 5)).toBe(false);
  expect(await copyDesktopClipboard(async () => { throw new Error("fixture-never-expose-this"); }, "fixture", 5)).toBe(false);
  expect(await copyDesktopClipboard(() => { throw new Error("fixture-never-expose-this"); }, "fixture", 5)).toBe(false);
  let calls = 0;
  expect(await copyDesktopClipboard(async () => { calls++; }, "x".repeat(16385), 5)).toBe(false);
  expect(calls).toBe(0);
});
