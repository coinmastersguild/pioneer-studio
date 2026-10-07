import { expect, test } from "bun:test";
import { desktopClipboardText, sendDesktopClipboard } from "./desktopClipboard";

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
