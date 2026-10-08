import { useState } from "react";
import { copyDesktopClipboard, desktopClipboardText } from "./desktopClipboard";

export default function AgentDesktopClipboard({ connected, onSend, receivedText }: {
  connected: boolean; onSend(text: string): void; receivedText: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");
  const [copying, setCopying] = useState(false);
  function send() {
    try {
      onSend(desktopClipboardText(draft));
      setMessage("Text sent to the desktop clipboard. Press Ctrl+V inside the desktop to paste.");
    } catch {
      setMessage("Clipboard text was not sent. Reconnect if needed and use at most 16 KiB of text without null characters.");
    } finally { setDraft(""); }
  }
  async function copy() {
    if (copying) return;
    setCopying(true); setMessage("Copying to your browser clipboard…");
    let write: ((text: string) => Promise<void>) | undefined;
    try { const clipboard = navigator.clipboard; if (clipboard?.writeText) write = (text) => clipboard.writeText(text); } catch { /* Use manual copying when browser access is blocked. */ }
    const confirmed = await copyDesktopClipboard(write, receivedText);
    setCopying(false);
    setMessage(confirmed ? "Desktop text copied to your clipboard."
      : "Browser copying was not confirmed. Select the text in Copied on desktop and copy it manually.");
  }
  return <section className="agent-desktop-clipboard" aria-label="Desktop clipboard">
    <div><label>Paste into desktop<textarea aria-label="Text to send to desktop" value={draft} maxLength={16384}
      onInput={(event) => setDraft(event.currentTarget.value)} rows={3} /></label>
      <button className="btn" disabled={!connected || !draft.length} onClick={send}>Send to desktop</button></div>
    <div><label>Copied on desktop<textarea aria-label="Text copied on desktop" readOnly value={receivedText || ""} rows={3} /></label>
      <button className="btn" disabled={!receivedText || copying} onClick={() => void copy()}>Copy from desktop</button></div>
    <p>Text only, up to 16 KiB. Clipboard access is explicit; text is kept only in this open viewer.</p>
    {message && <p role="status">{message}</p>}
  </section>;
}
