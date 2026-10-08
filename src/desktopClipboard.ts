type ClipboardTarget = { clipboardPasteFrom(text: string): void; focus(): void };
export const DESKTOP_CLIPBOARD_BYTES = 16 * 1024;

/** Text is supplied by the user or the desktop protocol, never read from the browser clipboard. */
export function desktopClipboardText(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.includes("\0") ||
      new TextEncoder().encode(value).byteLength > DESKTOP_CLIPBOARD_BYTES)
    throw new Error("Clipboard text must be nonempty, contain no null characters and fit within 16 KiB.");
  return value;
}

export function sendDesktopClipboard(target: ClipboardTarget | null, connected: boolean, text: string): void {
  if (!target || !connected) throw new Error("Reconnect the desktop before sending clipboard text.");
  target.clipboardPasteFrom(desktopClipboardText(text));
  try { target.focus(); } catch { /* Clipboard delivery does not depend on browser focus. */ }
}

/** A permission prompt or browser integration may leave its promise pending. */
export async function copyDesktopClipboard(write: ((text: string) => Promise<void>) | undefined, value: unknown, timeoutMs = 3000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = desktopClipboardText(value);
    if (!write) return false;
    // Start synchronously from the click so browser user activation is retained.
    const pending = write(text);
    return await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } catch { return false; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
